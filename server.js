const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const db = require('./database');

const PORT = process.env.PORT || 3000;
const ALLOWED_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.pdf', '.docx', '.xlsx', '.pptx', '.txt'];
const connectedClients = new Map(); // id -> { socket, clientData }
let serverStartTime = Date.now();

function getUploadsDir() {
  const base = process.env.UPLOADS_DIR || path.join(__dirname, 'uploads');
  if (!fs.existsSync(base)) {
    fs.mkdirSync(base, { recursive: true });
  }
  return base;
}

function broadcastClientStatus(clientId, online) {
  const client = db.getClient(clientId);
  if (!client) return;

  connectedClients.forEach((val, key) => {
    if (key !== clientId && val.clientData.status === 'approved') {
      val.socket.emit('client-status', {
        id: clientId,
        name: client.name,
        workstation: client.workstation,
        online,
      });
    }
  });
}

function setupApprovedSocketHandlers(socket, clientId) {
  // Direct Messaging
  socket.on('send-message', (data, callback) => {
    try {
      const { recipientId, content, type = 'text', attachment = null, replyToId = null } = data;
      const client = db.getClient(clientId);

      if (!recipientId || (!content && !attachment)) {
        if (callback) callback({ success: false, error: 'Recipient and content required' });
        return;
      }

      let attachmentId = null;
      if (attachment) {
        attachmentId = db.createAttachment(
          attachment.filename,
          attachment.originalName,
          attachment.mimeType,
          attachment.size
        );
      }

      const conv = db.getOrCreateConversation(clientId, recipientId);
      const msgId = db.createMessage(conv.id, clientId, recipientId, content || '', type, attachmentId, replyToId);
      const fullMsg = db.getMessageById(msgId);

      const msgPayload = {
        ...fullMsg,
        conversationId: conv.id,
        senderName: client?.name || 'Workstation',
        senderWorkstation: client?.workstation || '',
        attachment: fullMsg.attachment,
      };

      // Deliver to recipient if connected
      const recipientConn = connectedClients.get(recipientId);
      if (recipientConn && recipientConn.clientData.status === 'approved') {
        recipientConn.socket.emit('new-message', msgPayload);
      }

      if (callback) callback({ success: true, message: msgPayload });
    } catch (err) {
      if (callback) callback({ success: false, error: err.message });
    }
  });

  // Typing indicator
  socket.on('typing', ({ recipientId, isTyping }) => {
    const recipientConn = connectedClients.get(recipientId);
    if (recipientConn) {
      recipientConn.socket.emit('typing', { senderId: clientId, isTyping });
    }
  });

  // Read status
  socket.on('mark-read', ({ conversationId }) => {
    db.markMessagesAsRead(conversationId, clientId);
    const conv = db.getConversationById(conversationId);
    if (conv) {
      const otherId = conv.client1_id === clientId ? conv.client2_id : conv.client1_id;
      const otherConn = connectedClients.get(otherId);
      if (otherConn) {
        otherConn.socket.emit('messages-read', { conversationId, readBy: clientId });
      }
    }
  });

  // Fetch conversations
  socket.on('get-conversations', (data, callback) => {
    try {
      const convs = db.getClientConversations(clientId);
      const enriched = convs.map(c => {
        const otherId = c.client1_id === clientId ? c.client2_id : c.client1_id;
        const otherClient = db.getClient(otherId);
        const unread = db.getUnreadCount(c.id, clientId);
        return {
          ...c,
          otherClient: otherClient ? {
            id: otherClient.id,
            name: otherClient.name,
            workstation: otherClient.workstation,
            online: connectedClients.has(otherId),
          } : null,
          unreadCount: unread,
        };
      });
      if (callback) callback({ success: true, data: enriched });
    } catch (err) {
      if (callback) callback({ success: false, error: err.message });
    }
  });

  // Fetch messages
  socket.on('get-messages', ({ conversationId, limit }, callback) => {
    try {
      const msgs = db.getConversationMessages(conversationId, limit || 50);
      if (callback) callback({ success: true, data: msgs });
    } catch (err) {
      if (callback) callback({ success: false, error: err.message });
    }
  });

  // Fetch contacts
  socket.on('get-contacts', (data, callback) => {
    try {
      const allClients = db.getAllClients();
      const contacts = allClients
        .filter(c => c.id !== clientId && c.status === 'approved' && c.enabled)
        .map(c => ({
          id: c.id,
          name: c.name,
          workstation: c.workstation,
          online: connectedClients.has(c.id),
        }));
      if (callback) callback({ success: true, data: contacts });
    } catch (err) {
      if (callback) callback({ success: false, error: err.message });
    }
  });

  // Fetch announcements
  socket.on('get-announcements', (data, callback) => {
    try {
      const anns = db.getClientAnnouncements(clientId);
      if (callback) callback({ success: true, data: anns });
    } catch (err) {
      if (callback) callback({ success: false, error: err.message });
    }
  });
}

function broadcastAnnouncement(announcement) {
  const targetIds = announcement.target_client_ids
    ? JSON.parse(announcement.target_client_ids)
    : null;

  connectedClients.forEach((val, key) => {
    if (val.clientData.status === 'approved') {
      if (!targetIds || targetIds.includes(key)) {
        val.socket.emit('announcement', announcement);
      }
    }
  });
}

function notifyClientApproval(clientId, clientData) {
  const conn = connectedClients.get(clientId);
  if (conn) {
    conn.clientData = clientData;
    setupApprovedSocketHandlers(conn.socket, clientId);
    conn.socket.emit('auth-result', {
      success: true,
      status: 'approved',
      client: {
        id: clientData.id,
        name: clientData.name,
        workstation: clientData.workstation,
      },
    });
    broadcastClientStatus(clientId, true);
  }
}

function notifyClientDisabled(clientId) {
  const conn = connectedClients.get(clientId);
  if (conn) {
    conn.socket.emit('auth-result', {
      success: false,
      status: 'disabled',
      message: 'Your client has been disabled by the administrator',
    });
    conn.socket.disconnect(true);
    connectedClients.delete(clientId);
  }
}

function notifyClientRenamed(clientId, newName, workstation) {
  const conn = connectedClients.get(clientId);
  if (conn) {
    conn.socket.emit('client-updated', { name: newName, workstation });
    conn.clientData.name = newName;
    if (workstation !== undefined) conn.clientData.workstation = workstation;
  }
}

async function start() {
  await db.initDatabase();
  console.log('Database initialized successfully.');

  const app = express();
  app.use(express.json());

  // CORS
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
  });

  // Storage & Multer
  const maxFileSize = parseInt(db.getSetting('maxFileSize') || '10485760');
  const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, getUploadsDir()),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${uuidv4()}${ext}`);
    },
  });

  const fileFilter = (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_EXTS.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('File type not allowed'), false);
    }
  };

  const upload = multer({ storage, fileFilter, limits: { fileSize: maxFileSize } });

  // Public File Upload
  app.post('/api/upload', upload.single('file'), (req, res) => {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file uploaded' });
    }
    res.json({
      success: true,
      data: {
        filename: req.file.filename,
        originalName: req.file.originalname,
        mimeType: req.file.mimetype,
        size: req.file.size,
      },
    });
  });

  // Public File Download
  app.get('/api/files/:filename', (req, res) => {
    const safeName = path.basename(req.params.filename);
    const filePath = path.join(getUploadsDir(), safeName);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ success: false, error: 'File not found' });
    }
    res.sendFile(filePath);
  });

  // Admin REST APIs
  app.post('/api/admin/login', (req, res) => {
    const { username, password } = req.body || {};
    const result = db.verifyAdmin(username, password);
    if (result.success) {
      res.json({ success: true, token: 'ldrop-admin-token-' + Date.now(), user: result.user });
    } else {
      res.status(401).json({ success: false, error: result.error || 'Invalid credentials' });
    }
  });

  app.get('/api/admin/status', (req, res) => {
    let onlineCount = 0;
    connectedClients.forEach(c => {
      if (c.clientData.status === 'approved' && c.clientData.enabled) onlineCount++;
    });
    res.json({
      success: true,
      data: {
        running: true,
        port: PORT,
        lanIp: 'Cloud Hosted',
        uptime: Math.floor((Date.now() - serverStartTime) / 1000),
        onlineClients: onlineCount,
        totalClients: db.getAllClients().length,
      },
    });
  });

  app.get('/api/admin/clients', (req, res) => {
    const status = req.query.status;
    const clients = status === 'pending' ? db.getPendingClients() : db.getAllClients();
    const connectedMap = new Map();
    connectedClients.forEach((val, key) => connectedMap.set(key, true));
    const list = clients.map(c => ({
      ...c,
      online: connectedMap.has(c.id),
    }));
    res.json({ success: true, data: list });
  });

  app.post('/api/admin/approve', (req, res) => {
    const { clientId, name, workstation } = req.body || {};
    const updated = db.approveClient(clientId, name, workstation);
    if (updated) {
      notifyClientApproval(clientId, updated);
      res.json({ success: true, data: updated });
    } else {
      res.status(404).json({ success: false, error: 'Client not found' });
    }
  });

  app.post('/api/admin/rename', (req, res) => {
    const { clientId, name, workstation } = req.body || {};
    const updated = db.updateClientInfo(clientId, name, workstation);
    if (updated) {
      notifyClientRenamed(clientId, name, workstation);
      res.json({ success: true, data: updated });
    } else {
      res.status(404).json({ success: false, error: 'Client not found' });
    }
  });

  app.post('/api/admin/toggle', (req, res) => {
    const { clientId, enabled } = req.body || {};
    const updated = db.toggleClientEnabled(clientId, enabled);
    if (updated) {
      if (!enabled) notifyClientDisabled(clientId);
      res.json({ success: true, data: updated });
    } else {
      res.status(404).json({ success: false, error: 'Client not found' });
    }
  });

  app.post('/api/admin/remove', (req, res) => {
    const { clientId } = req.body || {};
    notifyClientDisabled(clientId);
    db.removeClient(clientId);
    res.json({ success: true });
  });

  app.get('/api/admin/announcements', (req, res) => {
    const list = db.getAnnouncements(50);
    res.json({ success: true, data: list });
  });

  app.post('/api/admin/broadcast', (req, res) => {
    const { title, content, targetClientIds } = req.body || {};
    const ann = db.createAnnouncement(title, content, targetClientIds);
    broadcastAnnouncement(ann);
    res.json({ success: true, data: ann });
  });

  app.get('/api/admin/messages', (req, res) => {
    const limit = parseInt(req.query.limit) || 100;
    const msgs = db.getRecentMessages(limit);
    res.json({ success: true, data: msgs });
  });

  app.get('/api/admin/storage', (req, res) => {
    const stats = db.getStorageStats();
    const files = db.getAllAttachments(100);
    res.json({ success: true, data: { ...stats, files } });
  });

  app.delete('/api/admin/files/:filename', (req, res) => {
    const safeName = path.basename(req.params.filename);
    const filePath = path.join(getUploadsDir(), safeName);
    if (fs.existsSync(filePath)) {
      try { fs.unlinkSync(filePath); } catch (e) {}
    }
    db.deleteAttachmentByFilename(safeName);
    res.json({ success: true });
  });

  app.get('/api/admin/settings', (req, res) => {
    res.json({
      success: true,
      data: {
        port: PORT,
        maxFileSize: db.getSetting('maxFileSize') || '10485760',
        storageDir: db.getSetting('storageDir') || 'uploads',
      },
    });
  });

  app.post('/api/admin/settings', (req, res) => {
    const { maxFileSize, storageDir } = req.body || {};
    if (maxFileSize) db.setSetting('maxFileSize', maxFileSize);
    if (storageDir) db.setSetting('storageDir', storageDir);
    res.json({ success: true });
  });

  // Serve static Web Admin Dashboard
  const publicDir = path.join(__dirname, 'public');
  if (fs.existsSync(publicDir)) {
    app.use(express.static(publicDir));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api') || req.path.startsWith('/socket.io')) return next();
      res.sendFile(path.join(publicDir, 'index.html'));
    });
  }

  const httpServer = http.createServer(app);
  const io = new Server(httpServer, {
    cors: { origin: '*' },
    maxHttpBufferSize: maxFileSize,
  });

  // Socket.IO Client Connection & Authentication
  io.on('connection', (socket) => {
    const installationId = socket.handshake.auth?.installationId;
    if (!installationId) {
      socket.emit('auth-result', { success: false, error: 'No installation ID' });
      socket.disconnect(true);
      return;
    }

    const clientIp = socket.handshake.address.replace(/^.*:/, '');
    let client = db.getClient(installationId);

    if (!client) {
      client = db.registerClient(installationId, clientIp);
      socket.emit('auth-result', {
        success: false,
        status: 'pending',
        message: 'Waiting for admin approval',
      });
      socket.installationId = installationId;
      connectedClients.set(installationId, { socket, clientData: client });
      return;
    }

    if (client.status === 'pending') {
      socket.emit('auth-result', {
        success: false,
        status: 'pending',
        message: 'Waiting for admin approval',
      });
      socket.installationId = installationId;
      connectedClients.set(installationId, { socket, clientData: client });
      return;
    }

    if (!client.enabled) {
      socket.emit('auth-result', {
        success: false,
        status: 'disabled',
        message: 'Your client has been disabled by the administrator',
      });
      socket.disconnect(true);
      return;
    }

    // Approved & enabled
    socket.installationId = installationId;
    db.updateClientLastSeen(installationId);
    db.registerClient(installationId, clientIp);
    connectedClients.set(installationId, { socket, clientData: client });

    socket.emit('auth-result', {
      success: true,
      status: 'approved',
      client: {
        id: client.id,
        name: client.name,
        workstation: client.workstation,
      },
    });

    broadcastClientStatus(installationId, true);

    // Send online clients
    const onlineList = [];
    connectedClients.forEach((val, key) => {
      if (key !== installationId && val.clientData.status === 'approved' && val.clientData.enabled) {
        onlineList.push({
          id: key,
          name: val.clientData.name,
          workstation: val.clientData.workstation,
          online: true,
        });
      }
    });
    socket.emit('online-clients', onlineList);

    setupApprovedSocketHandlers(socket, installationId);

    socket.on('disconnect', () => {
      connectedClients.delete(installationId);
      db.updateClientLastSeen(installationId);
      broadcastClientStatus(installationId, false);
    });
  });

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`===============================================`);
    console.log(`  🚀 Ldrop Cloud Server is active!`);
    console.log(`  Listening on port: ${PORT}`);
    console.log(`  Admin Dashboard: http://localhost:${PORT}`);
    console.log(`===============================================`);
  });
}

start().catch(err => {
  console.error('Failed to start Ldrop cloud server:', err);
  process.exit(1);
});
