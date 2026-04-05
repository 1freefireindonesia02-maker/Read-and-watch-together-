// ╔══════════════════════════════════════════════════════╗
// ║      WATCH/READ TOGETHER  —  server.js  v2           ║
// ╚══════════════════════════════════════════════════════╝
require('dotenv').config();

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const mongoose   = require('mongoose');
const session    = require('express-session');
const MongoStore = require('connect-mongo');
const passport   = require('passport');
const LocalStrategy  = require('passport-local').Strategy;
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const bcrypt     = require('bcryptjs');
const multer     = require('multer');
const { v4: uuidv4 } = require('uuid');
const QRCode     = require('qrcode');
const path       = require('path');
const fs         = require('fs');
const cors       = require('cors');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*', methods: ['GET','POST'] } });

const uploadDir = path.join(__dirname, 'uploads', 'pdf');
fs.mkdirSync(uploadDir, { recursive: true });

// ════════════════════════════════════════════════════════
//  MODELS
// ════════════════════════════════════════════════════════

const userSchema = new mongoose.Schema({
  username:    { type: String, unique: true, sparse: true, lowercase: true, trim: true },
  password:    String,
  googleId:    { type: String, unique: true, sparse: true },
  email:       String,
  displayName: String,
  avatar:      String,
  hasPassword: { type: Boolean, default: false },
  createdAt:   { type: Date, default: Date.now }
});

const roomSchema = new mongoose.Schema({
  name:       { type: String, required: true, trim: true },
  token:      { type: String, unique: true, required: true },
  creator:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  password:   String,
  maxUsers:   { type: Number, default: 10, min: 1, max: 50 },
  expiresAt:  Date,
  isActive:   { type: Boolean, default: true },
  bannedUsers:{ type: [String], default: [] },  // array of userIds
  createdAt:  { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);
const Room = mongoose.model('Room', roomSchema);

// ════════════════════════════════════════════════════════
//  MIDDLEWARE
// ════════════════════════════════════════════════════════

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || 'wrt-secret',
  resave: false, saveUninitialized: false,
  store: MongoStore.create({ mongoUrl: process.env.MONGODB_URI }),
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }
});

app.use(sessionMiddleware);
app.use(passport.initialize());
app.use(passport.session());
io.use((socket, next) => sessionMiddleware(socket.request, {}, next));

// ════════════════════════════════════════════════════════
//  PASSPORT
// ════════════════════════════════════════════════════════

passport.serializeUser((user, done) => done(null, user._id.toString()));
passport.deserializeUser(async (id, done) => {
  try { done(null, await User.findById(id)); } catch(e) { done(e); }
});

passport.use(new LocalStrategy(async (username, password, done) => {
  try {
    const user = await User.findOne({ username: username.toLowerCase().trim() });
    if (!user)          return done(null, false, { message: 'Username not found' });
    if (!user.password) return done(null, false, { message: 'Please use Google login for this account' });
    const ok = await bcrypt.compare(password, user.password);
    if (!ok)            return done(null, false, { message: 'Incorrect password' });
    return done(null, user);
  } catch(e) { return done(e); }
}));

if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  passport.use(new GoogleStrategy({
    clientID:     process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL:  (process.env.BASE_URL || 'http://localhost:3000') + '/auth/google/callback'
  }, async (accessToken, refreshToken, profile, done) => {
    try {
      let user = await User.findOne({ googleId: profile.id });
      if (!user) {
        const email = profile.emails?.[0]?.value;
        user = email ? await User.findOne({ email }) : null;
        if (user) {
          user.googleId = profile.id;
          if (!user.avatar) user.avatar = profile.photos?.[0]?.value;
          await user.save();
        } else {
          let base = (profile.displayName || 'user').replace(/\s+/g,'').toLowerCase().replace(/[^a-z0-9_]/g,'') || 'user';
          let uname = base; let n = 1;
          while (await User.exists({ username: uname })) uname = base + (n++);
          user = await User.create({
            googleId: profile.id, email,
            displayName: profile.displayName,
            username: uname,
            avatar: profile.photos?.[0]?.value,
            hasPassword: false
          });
        }
      }
      return done(null, user);
    } catch(e) { return done(e); }
  }));
}

// ════════════════════════════════════════════════════════
//  FILE UPLOAD
// ════════════════════════════════════════════════════════

const maxPdf = parseInt(process.env.MAX_PDF_SIZE_MB || '150') * 1024 * 1024;
const pdfUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename:    (req, file, cb) => cb(null, uuidv4() + '.pdf')
  }),
  limits: { fileSize: maxPdf },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') cb(null, true);
    else cb(new Error('Only PDF files allowed'));
  }
});

// ════════════════════════════════════════════════════════
//  HELPERS
// ════════════════════════════════════════════════════════

const requireAuth = (req, res, next) => {
  if (req.isAuthenticated()) return next();
  res.status(401).json({ error: 'Not authenticated' });
};

const sanitizeUser = u => ({
  id: u._id, username: u.username,
  displayName: u.displayName, avatar: u.avatar,
  email: u.email, hasPassword: !!u.hasPassword,
  hasGoogle: !!u.googleId
});

const toSlug = name => (name||'room').trim().toLowerCase().replace(/\s+/g,'-').replace(/[^a-z0-9-]/g,'') || 'room';

// ════════════════════════════════════════════════════════
//  AUTH ROUTES
// ════════════════════════════════════════════════════════

app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, password, displayName } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    const clean = username.toLowerCase().trim();
    if (clean.length < 3 || clean.length > 20) return res.status(400).json({ error: 'Username must be 3-20 chars' });
    if (!/^[a-z0-9_]+$/.test(clean)) return res.status(400).json({ error: 'Username: only letters, numbers, _ allowed' });
    if (password.length < 6) return res.status(400).json({ error: 'Password min 6 characters' });
    if (await User.exists({ username: clean })) return res.status(400).json({ error: 'Username already taken' });

    const user = await User.create({
      username: clean,
      password: await bcrypt.hash(password, 12),
      displayName: (displayName?.trim() || username).substring(0, 30),
      hasPassword: true
    });
    req.login(user, err => {
      if (err) return res.status(500).json({ error: 'Session error' });
      res.json({ success: true, user: sanitizeUser(user) });
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/login', (req, res, next) => {
  passport.authenticate('local', (err, user, info) => {
    if (err)   return res.status(500).json({ error: err.message });
    if (!user) return res.status(401).json({ error: info?.message || 'Login failed' });
    req.login(user, err => {
      if (err) return res.status(500).json({ error: 'Session error' });
      res.json({ success: true, user: sanitizeUser(user) });
    });
  })(req, res, next);
});

// Connect Google to existing account
app.get('/auth/google', passport.authenticate('google', { scope: ['profile','email'] }));
app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/auth?error=google' }),
  (req, res) => res.redirect('/mainpage')
);

app.post('/api/auth/logout', (req, res) => req.logout(() => res.json({ success: true })));
app.get('/api/auth/me', (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not authenticated' });
  res.json(sanitizeUser(req.user));
});

// ════════════════════════════════════════════════════════
//  ROOM ROUTES
// ════════════════════════════════════════════════════════

app.post('/api/rooms', requireAuth, async (req, res) => {
  try {
    const { name, password, maxUsers, expiresAt } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Room name required' });

    const token = uuidv4().replace(/-/g,'').substring(0, 16);
    const room  = await Room.create({
      name: name.trim(), token,
      creator:   req.user._id,
      password:  password ? await bcrypt.hash(password, 10) : null,
      maxUsers:  Math.min(Math.max(parseInt(maxUsers) || 10, 1), 50),
      expiresAt: expiresAt ? new Date(expiresAt) : null
    });

    const base     = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
    const shareUrl = `${base}/${token}`;
    const qrCode   = await QRCode.toDataURL(shareUrl, {
      color: { dark: '#818cf8', light: '#0d0d1a' }, width: 280, margin: 2
    });

    res.json({ success: true, room: {
      id: room._id, name: room.name, token, slug: toSlug(room.name),
      shareUrl, qrCode, maxUsers: room.maxUsers,
      expiresAt: room.expiresAt, hasPassword: !!password
    }});
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/rooms', requireAuth, async (req, res) => {
  try {
    const rooms = await Room.find({ creator: req.user._id, isActive: true })
      .sort({ createdAt: -1 }).limit(20);

    const base = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
    const result = await Promise.all(rooms.map(async room => {
      const shareUrl = `${base}/${room.token}`;
      const qrCode   = await QRCode.toDataURL(shareUrl, {
        color: { dark: '#818cf8', light: '#0d0d1a' }, width: 200, margin: 2
      });
      return {
        id: room._id, name: room.name, token: room.token,
        slug: toSlug(room.name), shareUrl, qrCode,
        maxUsers: room.maxUsers, expiresAt: room.expiresAt,
        hasPassword: !!room.password, createdAt: room.createdAt
      };
    }));
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/rooms/:token', async (req, res) => {
  try {
    const room = await Room.findOne({ token: req.params.token })
      .populate('creator', 'username displayName avatar');
    if (!room)          return res.status(404).json({ error: 'Room not found' });
    if (!room.isActive) return res.status(410).json({ error: 'Room has been closed' });
    if (room.expiresAt && new Date() > room.expiresAt)
      return res.status(410).json({ error: 'Room link has expired' });

    res.json({
      id: room._id, name: room.name, token: room.token,
      slug: toSlug(room.name), creator: room.creator,
      maxUsers: room.maxUsers, expiresAt: room.expiresAt,
      hasPassword: !!room.password, createdAt: room.createdAt
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/rooms/:token/verify', async (req, res) => {
  try {
    const room = await Room.findOne({ token: req.params.token });
    if (!room) return res.status(404).json({ error: 'Room not found' });
    if (!room.password) return res.json({ success: true });
    const ok = await bcrypt.compare(req.body.password || '', room.password);
    if (!ok) return res.status(401).json({ error: 'Wrong password' });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Edit room settings (creator only)
app.patch('/api/rooms/:token', requireAuth, async (req, res) => {
  try {
    const room = await Room.findOne({ token: req.params.token });
    if (!room) return res.status(404).json({ error: 'Room not found' });
    if (room.creator.toString() !== req.user._id.toString())
      return res.status(403).json({ error: 'Only creator can edit' });

    const { password, maxUsers, expiresAt, clearPassword } = req.body;
    if (clearPassword) room.password = null;
    else if (password) room.password = await bcrypt.hash(password, 10);
    if (maxUsers) room.maxUsers = Math.min(Math.max(parseInt(maxUsers), 1), 50);
    if (expiresAt !== undefined) room.expiresAt = expiresAt ? new Date(expiresAt) : null;
    await room.save();
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Member count
app.get('/api/rooms/:token/members', (req, res) => {
  const room = activeRooms[req.params.token];
  if (!room) return res.json({ count: 0, users: [] });
  res.json({ count: Object.keys(room.users).length, users: Object.values(room.users).map(u => ({ displayName: u.displayName, username: u.username, avatar: u.avatar, isCreator: u.isCreator })) });
});

// ════════════════════════════════════════════════════════
//  PDF UPLOAD
// ════════════════════════════════════════════════════════

app.post('/api/upload/pdf', requireAuth, pdfUpload.single('pdf'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const base = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
  const url  = `${base}/uploads/pdf/${req.file.filename}`;
  const delHours = parseInt(process.env.PDF_DELETE_HOURS || '24');
  setTimeout(() => fs.unlink(req.file.path, ()=>{}), delHours * 60 * 60 * 1000);
  res.json({ success: true, url, originalName: req.file.originalname, size: req.file.size });
});

app.use('/uploads', express.static(path.join(__dirname, 'uploads'), {
  setHeaders: res => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Cross-Origin-Resource-Policy', 'cross-origin');
  }
}));

// ════════════════════════════════════════════════════════
//  PAGE ROUTES
// ════════════════════════════════════════════════════════

const page = f => (req, res) => res.sendFile(path.join(__dirname, 'public', f));
app.get('/',         page('index.html'));
app.get('/auth',     page('auth.html'));
app.get('/mainpage', page('mainpage.html'));
app.get('/:token', (req, res, next) => {
  if (req.params.token.includes('.')) return next();
  page('join.html')(req, res);
});
app.get('/:token/:roomname', (req, res, next) => {
  if (req.params.token.includes('.')) return next();
  page('room.html')(req, res);
});

// ════════════════════════════════════════════════════════
//  SOCKET.IO
// ════════════════════════════════════════════════════════

// activeRooms[token] = { users, videoState, pdfState, creatorUserId, creatorSocketId, banList, mutedUsers }
const activeRooms = {};

function getRoom(token) {
  if (!activeRooms[token]) activeRooms[token] = {
    users: {},
    videoState:  { url: null, currentTime: 0, isPlaying: false, subtitleUrl: null },
    pdfState:    { list: [], currentIndex: 0, currentPage: 1, orientation: 'horizontal' },
    creatorUserId:   null,
    creatorSocketId: null,
    banList:     {},   // { userId: { bannedAt, bannedBy, displayName } }
    mutedAll:    {}    // { socketId: true } — globally muted by creator
  };
  return activeRooms[token];
}

io.on('connection', socket => {

  // ── JOIN ─────────────────────────────────────────────
  socket.on('join-room', async ({ token }) => {
    try {
      const room = await Room.findOne({ token }).populate('creator', '_id username displayName');
      if (!room)          return socket.emit('room-error', 'Room not found');
      if (!room.isActive) return socket.emit('room-error', 'Room is closed');
      if (room.expiresAt && new Date() > room.expiresAt)
        return socket.emit('room-error', 'Room link has expired');

      const state = getRoom(token);

      // Check ban
      const sessionUserId = socket.request.session?.passport?.user;
      if (sessionUserId && state.banList[sessionUserId])
        return socket.emit('room-error', 'You have been banned from this room');
      if (sessionUserId && room.bannedUsers?.includes(sessionUserId))
        return socket.emit('room-error', 'You have been banned from this room');

      if (!state.creatorUserId) state.creatorUserId = room.creator._id.toString();

      // Build user info
      let info = {
        socketId: socket.id,
        userId: sessionUserId || ('guest_' + socket.id.substr(0,8)),
        displayName: 'Guest', username: 'guest', avatar: null,
        isMuted: false, isGlobalMuted: false, joinedAt: Date.now()
      };

      if (sessionUserId) {
        const u = await User.findById(sessionUserId).select('username displayName avatar');
        if (u) {
          info.userId      = u._id.toString();
          info.username    = u.username || u.displayName;
          info.displayName = u.displayName || u.username;
          info.avatar      = u.avatar;
        }
      }

      // Check if user already in room (reconnect)
      const existing = Object.values(state.users).find(u => u.userId === info.userId && info.userId !== socket.id);
      if (existing) {
        // Remove old socket entry
        delete state.users[existing.socketId];
      }

      const isCreator = info.userId === state.creatorUserId;
      if (isCreator) state.creatorSocketId = socket.id;

      // Check capacity
      if (!isCreator && Object.keys(state.users).length >= room.maxUsers)
        return socket.emit('room-error', 'Room is full');

      socket.join(token);
      socket.roomToken = token;
      socket.userInfo  = info;
      socket.isCreator = isCreator;
      state.users[socket.id] = { ...info, isCreator };

      socket.emit('room-joined', {
        yourSocketId: socket.id, isCreator, roomName: room.name,
        users: Object.values(state.users),
        videoState: state.videoState, pdfState: state.pdfState,
        creatorSocketId: state.creatorSocketId
      });

      socket.to(token).emit('user-joined', { ...info, isCreator });
      io.to(token).emit('users-update', Object.values(state.users));
    } catch(e) { socket.emit('room-error', e.message); }
  });

  // ── VIDEO SYNC ───────────────────────────────────────
  socket.on('video-load',  ({ token, url }) => {
    if (!socket.isCreator || !activeRooms[token]) return;
    activeRooms[token].videoState = { url, currentTime: 0, isPlaying: false, subtitleUrl: null };
    io.to(token).emit('video-load', { url });
  });
  socket.on('video-play',  ({ token, currentTime }) => {
    if (!socket.isCreator || !activeRooms[token]) return;
    Object.assign(activeRooms[token].videoState, { isPlaying: true, currentTime });
    socket.to(token).emit('video-play', { currentTime });
  });
  socket.on('video-pause', ({ token, currentTime }) => {
    if (!socket.isCreator || !activeRooms[token]) return;
    Object.assign(activeRooms[token].videoState, { isPlaying: false, currentTime });
    socket.to(token).emit('video-pause', { currentTime });
  });
  socket.on('video-seek',  ({ token, currentTime }) => {
    if (!socket.isCreator || !activeRooms[token]) return;
    activeRooms[token].videoState.currentTime = currentTime;
    socket.to(token).emit('video-seek', { currentTime });
  });
  socket.on('video-buffering', ({ token }) => {
    if (!activeRooms[token]) return;
    socket.to(token).emit('video-peer-buffering', { socketId: socket.id });
  });
  socket.on('video-ready', ({ token }) => {
    if (!activeRooms[token]) return;
    socket.to(token).emit('video-peer-ready', { socketId: socket.id });
  });
  socket.on('subtitle-load', ({ token, subtitleUrl }) => {
    if (!socket.isCreator || !activeRooms[token]) return;
    activeRooms[token].videoState.subtitleUrl = subtitleUrl;
    io.to(token).emit('subtitle-load', { subtitleUrl });
  });

  // ── PDF SYNC ─────────────────────────────────────────
  socket.on('pdf-add',         ({ token, url, name }) => {
    if (!socket.isCreator || !activeRooms[token]) return;
    activeRooms[token].pdfState.list.push({ url, name: name || 'Document' });
    io.to(token).emit('pdf-list-update', activeRooms[token].pdfState);
  });
  socket.on('pdf-remove',      ({ token, index }) => {
    if (!socket.isCreator || !activeRooms[token]) return;
    activeRooms[token].pdfState.list.splice(index, 1);
    io.to(token).emit('pdf-list-update', activeRooms[token].pdfState);
  });
  socket.on('pdf-navigate',    ({ token, index, page }) => {
    if (!socket.isCreator || !activeRooms[token]) return;
    activeRooms[token].pdfState.currentIndex = index;
    activeRooms[token].pdfState.currentPage  = page;
    io.to(token).emit('pdf-navigate', { index, page });
  });
  socket.on('pdf-orientation', ({ token, orientation }) => {
    if (!socket.isCreator || !activeRooms[token]) return;
    activeRooms[token].pdfState.orientation = orientation;
    io.to(token).emit('pdf-orientation', { orientation });
  });
  socket.on('pdf-scroll',      ({ token, ratio }) => {
    if (!socket.isCreator || !activeRooms[token]) return;
    socket.to(token).emit('pdf-scroll', { ratio });
  });

  // ── CHAT ─────────────────────────────────────────────
  socket.on('chat-msg', async ({ token, text }) => {
    if (!activeRooms[token] || !socket.userInfo) return;
    const state = activeRooms[token];

    // Handle commands (creator only for most)
    if (text.startsWith('/') && socket.isCreator) {
      const parts = text.trim().split(/\s+/);
      const cmd   = parts[0].toLowerCase();
      const targetUsername = parts[1]?.toLowerCase();

      if (cmd === '/ban' && targetUsername) {
        const targetEntry = Object.values(state.users).find(u => u.username?.toLowerCase() === targetUsername);
        if (targetEntry) {
          state.banList[targetEntry.userId] = { bannedAt: Date.now(), bannedBy: socket.userInfo.displayName, displayName: targetEntry.displayName };
          // Persist ban to DB
          await Room.updateOne({ token }, { $addToSet: { bannedUsers: targetEntry.userId } });
          const targetSocket = io.sockets.sockets.get(targetEntry.socketId);
          if (targetSocket) { targetSocket.emit('banned', { message: 'You have been banned from this room' }); targetSocket.leave(token); }
          delete state.users[targetEntry.socketId];
          io.to(token).emit('users-update', Object.values(state.users));
          io.to(token).emit('system-msg', { text: `${targetEntry.displayName} has been banned`, type: 'error' });
        }
        return;
      }
      if (cmd === '/unban' && targetUsername) {
        const banned = Object.values(state.banList).find(b => b.displayName?.toLowerCase() === targetUsername);
        if (banned) {
          const uid = Object.keys(state.banList).find(k => state.banList[k] === banned);
          delete state.banList[uid];
          await Room.updateOne({ token }, { $pull: { bannedUsers: uid } });
          io.to(token).emit('system-msg', { text: `${targetUsername} has been unbanned`, type: 'success' });
        }
        return;
      }
      if (cmd === '/mute' && targetUsername) {
        const t = Object.values(state.users).find(u => u.username?.toLowerCase() === targetUsername);
        if (t) {
          state.mutedAll[t.socketId] = true;
          io.to(token).emit('user-muted-global', { targetId: t.socketId });
          io.to(token).emit('system-msg', { text: `${t.displayName} has been muted for everyone`, type: 'warn' });
        }
        return;
      }
      if (cmd === '/unmute' && targetUsername) {
        const t = Object.values(state.users).find(u => u.username?.toLowerCase() === targetUsername);
        if (t) {
          delete state.mutedAll[t.socketId];
          io.to(token).emit('user-unmuted-global', { targetId: t.socketId });
          io.to(token).emit('system-msg', { text: `${t.displayName} has been unmuted`, type: 'success' });
        }
        return;
      }
    }

    if (!text?.trim() || text.length > 1000) return;
    // Don't send if globally muted
    if (state.mutedAll[socket.id]) {
      socket.emit('system-msg', { text: 'You are muted by the room creator', type: 'error', private: true });
      return;
    }

    io.to(token).emit('chat-msg', {
      id: uuidv4(), socketId: socket.id,
      displayName: socket.userInfo.displayName,
      username:    socket.userInfo.username,
      avatar:      socket.userInfo.avatar,
      text: text.trim(), ts: Date.now()
    });
  });

  // ── VOICE SIGNALING ──────────────────────────────────
  socket.on('voice-offer',   ({ to, offer })     => io.to(to).emit('voice-offer',   { from: socket.id, offer }));
  socket.on('voice-answer',  ({ to, answer })    => io.to(to).emit('voice-answer',  { from: socket.id, answer }));
  socket.on('voice-ice',     ({ to, candidate }) => io.to(to).emit('voice-ice',     { from: socket.id, candidate }));
  socket.on('voice-joined',  ({ token })         => socket.to(token).emit('voice-peer-joined', { socketId: socket.id }));
  socket.on('voice-left',    ({ token })         => socket.to(token).emit('voice-peer-left',   { socketId: socket.id }));

  // ── KICK/MUTE ────────────────────────────────────────
  socket.on('kick-user', ({ token, targetId }) => {
    if (!socket.isCreator || !activeRooms[token]) return;
    const t = io.sockets.sockets.get(targetId);
    if (t) { t.emit('kicked', { message: 'You were removed by the room creator' }); t.leave(token); }
    delete activeRooms[token].users[targetId];
    io.to(token).emit('users-update', Object.values(activeRooms[token].users));
  });

  socket.on('ban-user', async ({ token, targetId }) => {
    if (!socket.isCreator || !activeRooms[token]) return;
    const state = activeRooms[token];
    const target = state.users[targetId];
    if (!target) return;
    state.banList[target.userId] = { bannedAt: Date.now(), bannedBy: socket.userInfo.displayName, displayName: target.displayName };
    await Room.updateOne({ token }, { $addToSet: { bannedUsers: target.userId } });
    const t = io.sockets.sockets.get(targetId);
    if (t) { t.emit('banned', { message: 'You have been banned from this room' }); t.leave(token); }
    delete state.users[targetId];
    io.to(token).emit('users-update', Object.values(state.users));
    io.to(token).emit('system-msg', { text: `${target.displayName} has been banned`, type: 'error' });
  });

  socket.on('mute-user', ({ token, targetId, globally }) => {
    if (!activeRooms[token]) return;
    if (globally && !socket.isCreator) return;
    if (globally) {
      activeRooms[token].mutedAll[targetId] = true;
      if (activeRooms[token].users[targetId]) activeRooms[token].users[targetId].isGlobalMuted = true;
      io.to(token).emit('user-muted-global', { targetId });
      const target = activeRooms[token].users[targetId];
      if (target) io.to(token).emit('system-msg', { text: `${target.displayName} muted for everyone`, type: 'warn' });
    } else {
      socket.emit('user-muted-local', { targetId });
    }
  });

  socket.on('unmute-user', ({ token, targetId, globally }) => {
    if (!activeRooms[token]) return;
    if (globally && !socket.isCreator) return;
    if (globally) {
      delete activeRooms[token].mutedAll[targetId];
      if (activeRooms[token].users[targetId]) activeRooms[token].users[targetId].isGlobalMuted = false;
      io.to(token).emit('user-unmuted-global', { targetId });
    } else {
      socket.emit('user-unmuted-local', { targetId });
    }
  });

  // ── DISCONNECT ───────────────────────────────────────
  socket.on('disconnect', () => {
    const token = socket.roomToken;
    if (!token || !activeRooms[token]) return;
    const info = activeRooms[token].users[socket.id];
    delete activeRooms[token].users[socket.id];
    if (Object.keys(activeRooms[token].users).length === 0) {
      delete activeRooms[token];
    } else {
      if (info) io.to(token).emit('user-left', { socketId: socket.id, displayName: info.displayName });
      io.to(token).emit('users-update', Object.values(activeRooms[token].users));
      io.to(token).emit('voice-peer-left', { socketId: socket.id });
    }
  });
});

// ════════════════════════════════════════════════════════
//  START
// ════════════════════════════════════════════════════════

const MONGO = process.env.MONGODB_URI || 'mongodb://localhost:27017/watchreadtogether';
const PORT  = process.env.PORT || 3000;

mongoose.connect(MONGO)
  .then(() => {
    console.log('✅ MongoDB connected');
    server.listen(PORT, () => console.log(`🚀 http://localhost:${PORT}`));
  })
  .catch(err => { console.error('❌ MongoDB:', err); process.exit(1); });
