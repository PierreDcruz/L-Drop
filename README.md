# Ldrop Cloud Server Deployment Guide

Deploy Ldrop Server to the cloud for autonomous 24/7 background operation.

### Benefits:
- **No dedicated local server PC required**: Runs 24/7 in the cloud.
- **Minimal Local Resource Footprint**: Eliminates the server desktop process on classroom computers.
- **Secure HTTPS / WebSocket SSL**: Clients connect securely via standard HTTPS.
- **Web-based Admin Dashboard**: Manage workstations, approvals, and announcements from any browser.

---

## Deployment Instructions

1. **Push this folder to GitHub**:
   - Create a repository (e.g. `ldrop-server`).
   - Push the files inside `cloud-server/` to the repository.
2. **Deploy to your Cloud Host** (Render, Koyeb, Railway, VPS, etc.):
   - **Environment**: `Node.js` (v18+)
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
   - **Port**: Set by hosting provider automatically via `PORT` environment variable (default: `3000`).

---

## Connecting Clients to the Cloud Server

1. Open **Ldrop Client** on student PCs.
2. Under **Connect to Server**, select **Cloud Server**.
3. Enter your server URL (e.g. `https://your-ldrop-server.com`).
4. Click **Connect via Cloud**.
5. The administrator opens the URL in any browser, signs in (`admin` / `admin123`), and approves the workstation.

---

## Credits & Author

- **Developer**: Lutpi Sigmaboy
- **Instagram**: @luthfii_pkya
- **Discord**: @Berakalsehat
