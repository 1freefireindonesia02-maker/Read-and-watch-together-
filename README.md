# 🎬📖 Watch/Read Together

Real-time co-watch and co-read platform with video sync, PDF viewer, voice chat, and live chat.

---

## ⚡ Quick Start (Local)

### Step 1 — Prerequisites
Make sure you have installed:
- **Node.js** v18+ → https://nodejs.org
- **MongoDB** (local) → https://www.mongodb.com/try/download/community
  OR use **MongoDB Atlas** (free cloud) → https://cloud.mongodb.com

### Step 2 — Setup
```bash
# Go into project folder
cd watch-read-together

# Install dependencies
npm install

# Create .env file from template
cp .env.example .env
```

### Step 3 — Edit .env
Open `.env` and set:
```
MONGODB_URI=mongodb://localhost:27017/watchreadtogether
SESSION_SECRET=any-long-random-string-here-make-it-long
BASE_URL=http://localhost:3000
PORT=3000
```

### Step 4 — Run
```bash
node server.js
```
Open: **http://localhost:3000**

---

## 🌐 Deploy to Production (Railway.app — Free)

1. Push project to GitHub
2. Go to **railway.app** → New Project → Deploy from GitHub
3. Add environment variables in Railway dashboard:
   - `MONGODB_URI` → your MongoDB Atlas connection string
   - `SESSION_SECRET` → a long random string
   - `BASE_URL` → your Railway domain (e.g. `https://yourapp.up.railway.app`)
4. Railway auto-deploys on every push ✅

---

## 🔐 Google OAuth Setup (Optional)

1. Go to: https://console.cloud.google.com
2. Create a new project
3. Go to **APIs & Services → Credentials**
4. Click **Create Credentials → OAuth 2.0 Client ID**
5. Application type: **Web application**
6. Add Authorized redirect URI:
   - Local: `http://localhost:3000/auth/google/callback`
   - Production: `https://yourdomain.com/auth/google/callback`
7. Copy **Client ID** and **Client Secret** into `.env`:
   ```
   GOOGLE_CLIENT_ID=your_client_id_here
   GOOGLE_CLIENT_SECRET=your_client_secret_here
   ```
8. Restart server

---

## 📁 File Structure

```
watch-read-together/
├── server.js          ← Backend (Express + Socket.io + MongoDB)
├── package.json
├── .env               ← Your config (create from .env.example)
├── .env.example       ← Template
├── uploads/
│   └── pdf/           ← Temporary PDF uploads (auto-deleted 24h)
└── public/
    ├── index.html     ← Landing page (/)
    ├── auth.html      ← Login / Register (/auth)
    ├── mainpage.html  ← Dashboard (/mainpage)
    ├── join.html      ← Join page (/:token)
    ├── room.html      ← Room page (/:token/:roomname)
    └── room.js        ← All room logic (video, PDF, voice, chat)
```

---

## 🎮 How to Use

### Create a Room
1. Login → Click "Create Room"
2. Set name, max members, optional password and expiry
3. Share the link or QR code with friends
4. Enter the room → you are the creator (👑)

### As Creator
- **Video tab**: Paste a direct `.mp4`/`.webm`/`.m3u8` streaming link
- **PDF tab**: Add PDF links or upload files (max 150MB each)
- **Controls**: Play/pause/seek syncs for everyone
- **Kick/Mute**: Click 😹 emoji → manage members

### As Member
- Join via link, token, or QR scan
- Everything is synced automatically
- You can chat and join voice chat

---

## 📡 Getting Streaming Links

### Video
| Source | How |
|--------|-----|
| Google Drive | Upload → Share → "Anyone with link" → Use GDrive direct link generator |
| Mega.nz | Upload → Right-click → "Get Link" → paste directly |
| Streamtape/Doodstream | Upload → Share → copy `.mp4` direct URL |
| Any direct URL | `.mp4`, `.webm`, `.m3u8` links work directly |

### PDF
| Source | How |
|--------|-----|
| Google Drive | Upload → Share → change `/view` to `/preview` in URL |
| Direct URL | Any `.pdf` link works |
| Device | Upload directly in room (max 150MB) |

---

## 🛠️ Tech Stack

| Layer | Tech |
|-------|------|
| Backend | Node.js, Express, Socket.io |
| Database | MongoDB + Mongoose |
| Auth | Passport.js (Local + Google OAuth) |
| Real-time | Socket.io (video/PDF sync, chat, signaling) |
| Voice | WebRTC peer-to-peer |
| PDF Viewer | PDF.js |
| Sessions | express-session + connect-mongo |
| QR Code | qrcode npm package |
| File Upload | Multer |
