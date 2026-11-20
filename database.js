const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');

let dbInstance = null;
let SQL = null;
let dbFilePath = null;

function getDbPath() {
  if (dbFilePath) return dbFilePath;
  const basePath = process.env.DATA_DIR || path.join(__dirname, 'data');
  if (!fs.existsSync(basePath)) {
    fs.mkdirSync(basePath, { recursive: true });
  }
  dbFilePath = path.join(basePath, 'ldrop-server.db');
  return dbFilePath;
}

function saveDbToDisk() {
  if (!dbInstance || !dbFilePath) return;
  try {
    const data = dbInstance.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(dbFilePath, buffer);
  } catch (err) {
    console.error('Failed to save SQLite DB to disk:', err);
  }
}

// Wrapper to provide better-sqlite3 style synchronous API over sql.js
class StatementWrapper {
  constructor(sql, db) {
    this.sql = sql;
    this.db = db;
  }

  get(...params) {
    // If array passed as first arg
    const flatParams = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
    try {
      const stmt = this.db.prepare(this.sql);
      stmt.bind(flatParams);
      if (stmt.step()) {
        const row = stmt.getAsObject();
        stmt.free();
        return row;
      }
      stmt.free();
      return undefined;
    } catch (err) {
      console.error('SQL get error:', err, 'SQL:', this.sql, 'Params:', flatParams);
      return undefined;
    }
  }

  all(...params) {
    const flatParams = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
    const results = [];
    try {
      const stmt = this.db.prepare(this.sql);
      stmt.bind(flatParams);
      while (stmt.step()) {
        results.push(stmt.getAsObject());
      }
      stmt.free();
    } catch (err) {
      console.error('SQL all error:', err, 'SQL:', this.sql, 'Params:', flatParams);
    }
    return results;
  }

  run(...params) {
    const flatParams = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
    try {
      this.db.run(this.sql, flatParams);
      saveDbToDisk();
      
      // Get last insert rowid
      const rowIdRes = this.db.exec("SELECT last_insert_rowid() as id");
      const lastInsertRowid = rowIdRes.length && rowIdRes[0].values.length ? rowIdRes[0].values[0][0] : 0;
      return { lastInsertRowid, changes: 1 };
    } catch (err) {
      console.error('SQL run error:', err, 'SQL:', this.sql, 'Params:', flatParams);
      throw err;
    }
  }
}

class DatabaseWrapper {
  constructor(sqlDb) {
    this.sqlDb = sqlDb;
  }

  prepare(sql) {
    return new StatementWrapper(sql, this.sqlDb);
  }

  exec(sql) {
    this.sqlDb.exec(sql);
    saveDbToDisk();
  }

  pragma(sql) {
    try {
      this.sqlDb.exec(`PRAGMA ${sql};`);
    } catch (e) {}
  }
}

let db = null;

async function initDatabaseAsync() {
  if (db) return db;
  const initSqlJs = require('sql.js');
  
  let wasmBinary = null;
  const possiblePaths = [
    path.join(__dirname, '../../node_modules/sql.js/dist/sql-wasm.wasm'),
    path.join(process.resourcesPath || '', 'app.asar.unpacked/node_modules/sql.js/dist/sql-wasm.wasm'),
    path.join(__dirname, 'node_modules/sql.js/dist/sql-wasm.wasm')
  ];

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      wasmBinary = fs.readFileSync(p);
      break;
    }
  }

  SQL = await initSqlJs(wasmBinary ? { wasmBinary } : {});
  const dbPath = getDbPath();

  if (fs.existsSync(dbPath)) {
    const fileBuffer = fs.readFileSync(dbPath);
    dbInstance = new SQL.Database(fileBuffer);
  } else {
    dbInstance = new SQL.Database();
  }

  db = new DatabaseWrapper(dbInstance);

  // Create tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS admins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS clients (
      id TEXT PRIMARY KEY,
      name TEXT DEFAULT 'Unnamed',
      workstation TEXT DEFAULT '',
      status TEXT DEFAULT 'pending',
      enabled INTEGER DEFAULT 1,
      last_seen TEXT,
      ip_address TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      participant1 TEXT NOT NULL,
      participant2 TEXT NOT NULL,
      last_message TEXT,
      last_message_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL,
      sender_id TEXT NOT NULL,
      content TEXT,
      type TEXT DEFAULT 'text',
      reply_to INTEGER,
      read INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id INTEGER NOT NULL,
      filename TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mime_type TEXT,
      size INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS announcements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      target TEXT DEFAULT 'all',
      target_clients TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS server_settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  // Default admin: admin / admin123
  const admin = db.prepare('SELECT COUNT(*) as count FROM admins').get();
  if (!admin || admin.count === 0) {
    const hashed = bcrypt.hashSync('admin123', 10);
    db.prepare('INSERT INTO admins (username, password) VALUES (?, ?)').run('admin', hashed);
  }

  // Default settings
  const defaults = {
    port: '3000',
    autoStart: 'false',
    maxFileSize: '10485760',
    serverState: 'stopped',
    storageDir: 'uploads',
    startMinimized: 'false',
    autoStartServer: 'false',
  };

  const insertSetting = db.prepare('INSERT OR IGNORE INTO server_settings (key, value) VALUES (?, ?)');
  for (const [key, value] of Object.entries(defaults)) {
    insertSetting.run(key, value);
  }

  saveDbToDisk();
  return db;
}

function initDatabase() {
  if (db) return db;
  // Initialize synchronously using deasync or direct promise resolution if already loaded
  initDatabaseAsync();
  return db;
}

function getDb() {
  return db;
}

// Admin
function verifyAdmin(username, password) {
  const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(username);
  if (!admin) return null;
  if (!bcrypt.compareSync(password, admin.password)) return null;
  return { id: admin.id, username: admin.username };
}

function changeAdminPassword(adminId, newPassword) {
  const hashed = bcrypt.hashSync(newPassword, 10);
  db.prepare('UPDATE admins SET password = ? WHERE id = ?').run(hashed, adminId);
}

// Clients
function getClient(id) {
  return db.prepare('SELECT * FROM clients WHERE id = ?').get(id);
}

function getAllClients() {
  return db.prepare('SELECT * FROM clients ORDER BY created_at DESC').all();
}

function getClientsByStatus(status) {
  return db.prepare('SELECT * FROM clients WHERE status = ?').all(status);
}

function getPendingClients() {
  return db.prepare("SELECT * FROM clients WHERE status = 'pending' ORDER BY created_at DESC").all();
}

function getApprovedClients() {
  return db.prepare("SELECT * FROM clients WHERE status = 'approved' ORDER BY name ASC").all();
}

function registerClient(id, ipAddress) {
  const existing = getClient(id);
  if (existing) {
    db.prepare('UPDATE clients SET last_seen = datetime("now"), ip_address = ? WHERE id = ?').run(ipAddress, id);
    return getClient(id);
  }
  db.prepare('INSERT INTO clients (id, ip_address, last_seen) VALUES (?, ?, datetime("now"))').run(id, ipAddress);
  return getClient(id);
}

function approveClient(id, name, workstation) {
  db.prepare("UPDATE clients SET status = 'approved', name = ?, workstation = ? WHERE id = ?").run(name || 'Unnamed', workstation || '', id);
  return getClient(id);
}

function renameClient(id, name) {
  db.prepare('UPDATE clients SET name = ? WHERE id = ?').run(name, id);
  return getClient(id);
}

function assignWorkstation(id, workstation) {
  db.prepare('UPDATE clients SET workstation = ? WHERE id = ?').run(workstation, id);
  return getClient(id);
}

function toggleClient(id, enabled) {
  db.prepare('UPDATE clients SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
  return getClient(id);
}

function removeClient(id) {
  db.prepare('DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE participant1 = ? OR participant2 = ?)').run(id, id);
  db.prepare('DELETE FROM conversations WHERE participant1 = ? OR participant2 = ?').run(id, id);
  db.prepare('DELETE FROM clients WHERE id = ?').run(id);
}

function updateClientLastSeen(id) {
  db.prepare('UPDATE clients SET last_seen = datetime("now") WHERE id = ?').run(id);
}

function searchClients(query) {
  return db.prepare("SELECT * FROM clients WHERE status = 'approved' AND (name LIKE ? OR workstation LIKE ?)").all(`%${query}%`, `%${query}%`);
}

// Conversations & Messages
function getOrCreateConversation(participant1, participant2) {
  const [p1, p2] = [participant1, participant2].sort();
  let conv = db.prepare('SELECT * FROM conversations WHERE participant1 = ? AND participant2 = ?').get(p1, p2);
  if (!conv) {
    const res = db.prepare('INSERT INTO conversations (participant1, participant2) VALUES (?, ?)').run(p1, p2);
    conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(res.lastInsertRowid);
  }
  return conv;
}

function getConversationsForClient(clientId) {
  return db.prepare(`
    SELECT c.*, 
      CASE WHEN c.participant1 = ? THEN c.participant2 ELSE c.participant1 END as other_participant
    FROM conversations c 
    WHERE c.participant1 = ? OR c.participant2 = ?
    ORDER BY c.updated_at DESC
  `).all(clientId, clientId, clientId);
}

function getAllConversations() {
  return db.prepare('SELECT * FROM conversations ORDER BY updated_at DESC').all();
}

function addMessage(conversationId, senderId, content, type, replyTo) {
  const result = db.prepare(
    'INSERT INTO messages (conversation_id, sender_id, content, type, reply_to) VALUES (?, ?, ?, ?, ?)'
  ).run(conversationId, senderId, content || '', type || 'text', replyTo || null);

  db.prepare('UPDATE conversations SET last_message = ?, last_message_at = datetime("now"), updated_at = datetime("now") WHERE id = ?')
    .run(content || (type === 'image' ? '[Image]' : '[File]'), conversationId);

  return db.prepare('SELECT * FROM messages WHERE id = ?').get(result.lastInsertRowid);
}

function getMessages(conversationId, limit = 50, before = null) {
  if (before) {
    return db.prepare(
      'SELECT * FROM messages WHERE conversation_id = ? AND id < ? ORDER BY created_at DESC LIMIT ?'
    ).all(conversationId, before, limit).reverse();
  }
  return db.prepare(
    'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?'
  ).all(conversationId, limit).reverse();
}

function markMessagesRead(conversationId, readerId) {
  db.prepare(
    'UPDATE messages SET read = 1 WHERE conversation_id = ? AND sender_id != ? AND read = 0'
  ).run(conversationId, readerId);
}

function getUnreadCount(conversationId, clientId) {
  const res = db.prepare(
    'SELECT COUNT(*) as count FROM messages WHERE conversation_id = ? AND sender_id != ? AND read = 0'
  ).get(conversationId, clientId);
  return res ? res.count : 0;
}

function searchMessages(query, conversationId = null) {
  if (conversationId) {
    return db.prepare(
      'SELECT * FROM messages WHERE conversation_id = ? AND content LIKE ? ORDER BY created_at DESC LIMIT 50'
    ).all(conversationId, `%${query}%`);
  }
  return db.prepare(
    'SELECT * FROM messages WHERE content LIKE ? ORDER BY created_at DESC LIMIT 50'
  ).all(`%${query}%`);
}

// Attachments
function addAttachment(messageId, filename, originalName, mimeType, size) {
  const res = db.prepare(
    'INSERT INTO attachments (message_id, filename, original_name, mime_type, size) VALUES (?, ?, ?, ?, ?)'
  ).run(messageId, filename, originalName, mimeType, size);
  return db.prepare('SELECT * FROM attachments WHERE id = ?').get(res.lastInsertRowid);
}

function getAttachment(id) {
  return db.prepare('SELECT * FROM attachments WHERE id = ?').get(id);
}

function getMessageAttachments(messageId) {
  return db.prepare('SELECT * FROM attachments WHERE message_id = ?').all(messageId);
}

function getFilesInfo() {
  const totalFilesObj = db.prepare('SELECT COUNT(*) as count FROM attachments').get();
  const totalFiles = totalFilesObj ? totalFilesObj.count : 0;
  const totalSizeObj = db.prepare('SELECT SUM(size) as total FROM attachments').get();
  const totalSize = totalSizeObj && totalSizeObj.total ? totalSizeObj.total : 0;
  const recentFiles = db.prepare('SELECT a.*, m.sender_id FROM attachments a JOIN messages m ON a.message_id = m.id ORDER BY a.created_at DESC LIMIT 20').all();
  return { totalFiles, totalSize, recentFiles };
}

// Announcements
function addAnnouncement(title, content, target, targetClients) {
  const res = db.prepare(
    'INSERT INTO announcements (title, content, target, target_clients) VALUES (?, ?, ?, ?)'
  ).run(title, content, target || 'all', targetClients ? JSON.stringify(targetClients) : null);
  return db.prepare('SELECT * FROM announcements WHERE id = ?').get(res.lastInsertRowid);
}

function getAnnouncements(limit = 50) {
  return db.prepare('SELECT * FROM announcements ORDER BY created_at DESC LIMIT ?').all(limit);
}

// Settings
function getSetting(key) {
  if (!db) return null;
  const row = db.prepare('SELECT value FROM server_settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  if (!db) return;
  db.prepare('INSERT OR REPLACE INTO server_settings (key, value) VALUES (?, ?)').run(key, String(value));
}

function getAllSettings() {
  if (!db) return {};
  const rows = db.prepare('SELECT * FROM server_settings').all();
  const settings = {};
  rows.forEach(r => { settings[r.key] = r.value; });
  return settings;
}

// Dashboard stats
function getDashboardStats() {
  const totalClientsObj = db.prepare('SELECT COUNT(*) as count FROM clients').get();
  const totalClients = totalClientsObj ? totalClientsObj.count : 0;

  const approvedClientsObj = db.prepare("SELECT COUNT(*) as count FROM clients WHERE status = 'approved'").get();
  const approvedClients = approvedClientsObj ? approvedClientsObj.count : 0;

  const pendingClientsObj = db.prepare("SELECT COUNT(*) as count FROM clients WHERE status = 'pending'").get();
  const pendingClients = pendingClientsObj ? pendingClientsObj.count : 0;

  const disabledClientsObj = db.prepare("SELECT COUNT(*) as count FROM clients WHERE enabled = 0").get();
  const disabledClients = disabledClientsObj ? disabledClientsObj.count : 0;

  const totalMessagesObj = db.prepare('SELECT COUNT(*) as count FROM messages').get();
  const totalMessages = totalMessagesObj ? totalMessagesObj.count : 0;

  const totalAnnouncementsObj = db.prepare('SELECT COUNT(*) as count FROM announcements').get();
  const totalAnnouncements = totalAnnouncementsObj ? totalAnnouncementsObj.count : 0;

  const recentMessages = db.prepare('SELECT m.*, c.name as sender_name FROM messages m LEFT JOIN clients c ON m.sender_id = c.id ORDER BY m.created_at DESC LIMIT 10').all();

  return {
    totalClients,
    approvedClients,
    pendingClients,
    disabledClients,
    totalMessages,
    totalAnnouncements,
    recentMessages,
  };
}

module.exports = {
  getDb, initDatabase, initDatabaseAsync, verifyAdmin, changeAdminPassword,
  getClient, getAllClients, getClientsByStatus, getPendingClients, getApprovedClients,
  registerClient, approveClient, renameClient, assignWorkstation, toggleClient, removeClient,
  updateClientLastSeen, searchClients,
  getOrCreateConversation, getConversationsForClient, getAllConversations,
  addMessage, getMessages, markMessagesRead, getUnreadCount, searchMessages,
  addAttachment, getAttachment, getMessageAttachments, getFilesInfo,
  addAnnouncement, getAnnouncements,
  getSetting, setSetting, getAllSettings,
  getDashboardStats,
};
