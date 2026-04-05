// ╔══════════════════════════════════════════════════════╗
// ║          WATCH/READ TOGETHER  —  server.js           ║
// ║   Node.js · Express · Socket.io · MongoDB · Passport ║
// ╚══════════════════════════════════════════════════════╝
require('dotenv').config();

const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const session  = require('express-session');
const MongoStore = require('connect-mongo');
const passport = require('passport');
const LocalStrategy  = require('passport-local').Strategy;
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const bcrypt   = require('bcryptjs');
const multer   = require('multer');
const { v4: uuidv4 } = require('uuid');
const QRCode   = require('qrcode');
const path     = require('path');
const fs       = require('fs');
const cors     = require('cors');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET','POST'] }
});

// ── Ensure upload dir exists ────────────────────────────
const uploadDir = path.join(__dirname, 'uploads', 'pdf');
fs.mkdirSync(uploadDir, { recursive: true });

// ════════════════════════════════════════════════════════
//  MONGOOSE MODELS
// ════════════════════════════════════════════════════════

const userSchema = new mongoose.Schema({
  username:    { type: String, unique: true, sparse: true, lowercase: true, trim: true },
  password:    String,
  googleId:    { type: String, unique: true, sparse: true },
  email:       String,
  displayName: String,
  avatar:      String,
  createdAt:   { type: Date, default: Date.now }
});

const roomSchema = new mongoose.Schema({
  name:      { type: String, required: true, trim: true },
  token:     { type: String, unique: true, required: true },
  creator:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  password:  String,
  maxUsers:  { type: Number, default: 10, min: 1, max: 50 },
  expiresAt: Date,
  isActive:  { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
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
  secret: process.env.SESSION_SECRET || 'wrt-change-this',
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({
    mongoUrl: process.env.MONGODB_URI || 'mongodb://localhost:27017/watchreadtogether'
  }),
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }  // 7 days
});

app.use(sessionMiddleware);
app.use(passport.initialize());
app.use(passport.session());

// Share session with Socket.io
io.use((socket, next) => sessionMiddleware(socket.request, {}, next));

// ════════════════════════════════════════════════════════
//  PASSPORT CONFIG
// ════════════════════════════════════════════════════════

passport.serializeUser((user, done) => done(null, user._id.toString()));
passport.deserializeUser(async (id, done) => {
  try { done(null, await User.findById(id)); }
  catch (e) { done(e); }
});

// Local Strategy
passport.use(new LocalStrategy(async (username, password, done) => {
  try {
    const user = await User.findOne({ username: username.toLowerCase().trim() });
    if (!user)          return done(null, false, { message: 'Username not found' });
    if (!user.password) return done(null, false, { message: 'Use Google login for this account' });
    const ok = await bcrypt.compare(password, user.password);
    if (!ok)            return done(null, false, { message: 'Incorrect password' });
    return done(null, user);
  } catch (e) { return done(e); }
}));

// Google OAuth Strategy (only if credentials provided)
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
          let base = (profile.displayName || 'user').replace(/\s+/g,'').toLowerCase().replace(/[^a-z0-9_]/g,'');
          let uname = base || 'user';
          let n = 1;
          while (await User.exists({ username: uname })) uname = base + (n++);
          user = await User.create({
            googleId: profile.id, email,
            displayName: profile.displayName,
            username: uname,
            avatar: profile.photos?.[0]?.value
          });
        }
      }
      return done(null, user);
    } catch (e) { return done(e); }
  }));
}

// ════════════════════════════════════════════════════════
//  PDF UPLOAD
// ════════════════════════════════════════════════════════

const pdfUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename:    (req, file, cb) => cb(null, uuidv4() + '.pdf')
  }),
  limits: { fileSize: 150 * 1024 * 1024 },
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
  displayName: u.displayName, avatar: u.avatar, email: u.email
});

const toSlug = name => name.trim().toLowerCase().replace(/\s+/g,'-').replace(/[^a-z0-9-]/g,'') || 'room';

// ════════════════════════════════════════════════════════
//  AUTH ROUTES
// ════════════════════════════════════════════════════════

// Register
app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, password, displayName } = req.body;
    if (!username || !password)
      return res.status(400).json({ error: 'Username and password are required' });
    const clean = username.toLowerCase().trim();
    if (clean.length < 3 || clean.length > 20)
      return res.status(400).json({ error: 'Username must be 3–20 characters' });
    if (!/^[a-z0-9_]+$/.test(clean))
      return res.status(400).json({ error: 'Username: only letters, numbers, underscores allowed' });
    if (password.length < 6)
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    if (await User.exists({ username: clean }))
      return res.status(400).json({ error: 'Username already taken, please choose another' });

    const user = await User.create({
      username: clean,
      password: await bcrypt.hash(password, 12),
      displayName: (displayName?.trim() || username).substring(0,30)
    });
    req.login(user, err => {
      if (err) return res.status(500).json({ error: 'Session error' });
      res.json({ success: true, user: sanitizeUser(user) });
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Login
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

// Google OAuth
app.get('/auth/google', passport.authenticate('google', { scope: ['profile','email'] }));
app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/auth?error=google' }),
  (req, res) => res.redirect('/mainpage')
);

// Logout
app.post('/api/auth/logout', (req, res) => req.logout(() => res.json({ success: true })));

// Current user
app.get('/api/auth/me', (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not authenticated' });
  res.json(sanitizeUser(req.user));
});

// ════════════════════════════════════════════════════════
//  ROOM ROUTES
// ════════════════════════════════════════════════════════

// Create room
app.post('/api/rooms', requireAuth, async (req, res) => {
  try {
    const { name, password, maxUsers, expiresAt } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Room name is required' });

    const token = uuidv4().replace(/-/g,'').substring(0, 16);
    const room  = await Room.create({
      name:      name.trim(),
      token,
      creator:   req.user._id,
      password:  password ? await bcrypt.hash(password, 10) : null,
      maxUsers:  Math.min(Math.max(parseInt(maxUsers) || 10, 1), 50),
      expiresAt: expiresAt ? new Date(expiresAt) : null
    });

    const base     = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
    const shareUrl = `${base}/${token}`;
    const qrCode   = await QRCode.toDataURL(shareUrl, {
      color: { dark: '#818cf8', light: '#0d0d1a' },
      width: 300, margin: 2, errorCorrectionLevel: 'M'
    });

    res.json({
      success: true,
      room: {
        id: room._id, name: room.name, token,
        slug: toSlug(room.name), shareUrl, qrCode,
        maxUsers: room.maxUsers, expiresAt: room.expiresAt,
        hasPassword: !!password
      }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get room info (public)
app.get('/api/rooms/:token', async (req, res) => {
  try {
    const room = await Room.findOne({ token: req.params.token })
      .populate('creator', 'username displayName avatar');
    if (!room)           return res.status(404).json({ error: 'Room not found' });
    if (!room.isActive)  return res.status(410).json({ error: 'This room has been closed' });
    if (room.expiresAt && new Date() > room.expiresAt)
      return res.status(410).json({ error: 'This room link has expired' });

    res.json({
      id: room._id, name: room.name, token: room.token,
      slug: toSlug(room.name), creator: room.creator,
      maxUsers: room.maxUsers, expiresAt: room.expiresAt,
      hasPassword: !!room.password, createdAt: room.createdAt
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Verify room password
app.post('/api/rooms/:token/verify', async (req, res) => {
  try {
    const room = await Room.findOne({ token: req.params.token });
    if (!room) return res.status(404).json({ error: 'Room not found' });
    if (!room.password) return res.json({ success: true });
    const ok = await bcrypt.compare(req.body.password || '', room.password);
    if (!ok) return res.status(401).json({ error: 'Wrong password' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// List user's created rooms
app.get('/api/rooms', requireAuth, async (req, res) => {
  try {
    const rooms = await Room.find({ creator: req.user._id, isActive: true })
      .sort({ createdAt: -1 }).limit(20)
      .select('name token createdAt maxUsers expiresAt');
    res.json(rooms);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════
//  PDF UPLOAD ROUTE
// ════════════════════════════════════════════════════════

app.post('/api/upload/pdf', requireAuth, pdfUpload.single('pdf'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const base = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
  const url  = `${base}/uploads/pdf/${req.file.filename}`;
  // Auto-delete after 24 hours
  setTimeout(() => fs.unlink(req.file.path, ()=>{}), 24 * 60 * 60 * 1000);
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
//  SOCKET.IO — REAL-TIME ENGINE
// ════════════════════════════════════════════════════════

// activeRooms: { [token]: { users, videoState, pdfState, creatorUserId, creatorSocketId } }
const activeRooms = {};

function getRoom(token) {
  if (!activeRooms[token]) activeRooms[token] = {
    users: {},
    videoState: { url: null, currentTime: 0, isPlaying: false, subtitleUrl: null },
    pdfState:   { list: [], currentIndex: 0, currentPage: 1, orientation: 'horizontal' },
    creatorUserId:   null,
    creatorSocketId: null
  };
  return activeRooms[token];
}

io.on('connection', socket => {

  // ── JOIN ROOM ────────────────────────────────────────
  socket.on('join-room', async ({ token }) => {
    try {
      const room = await Room.findOne({ token })
        .populate('creator', '_id username displayName');
      if (!room)          return socket.emit('room-error', 'Room not found');
      if (!room.isActive) return socket.emit('room-error', 'Room is closed');
      if (room.expiresAt && new Date() > room.expiresAt)
        return socket.emit('room-error', 'Room link has expired');

      const state = getRoom(token);
      if (Object.keys(state.users).length >= room.maxUsers)
        return socket.emit('room-error', 'Room is full');

      if (!state.creatorUserId) state.creatorUserId = room.creator._id.toString();

      // Build user info from session
      const sessionUserId = socket.request.session?.passport?.user;
      let info = {
        socketId: socket.id,
        userId: sessionUserId || ('guest_' + socket.id.substr(0,8)),
        displayName: 'Guest', username: 'guest', avatar: null,
        isMuted: false, isGlobalMuted: false, voiceActive: false, joinedAt: Date.now()
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

      const isCreator = info.userId === state.creatorUserId;
      if (isCreator) state.creatorSocketId = socket.id;

      socket.join(token);
      socket.roomToken = token;
      socket.userInfo  = info;
      socket.isCreator = isCreator;
      state.users[socket.id] = { ...info, isCreator };

      // Send full state to new joiner
      socket.emit('room-joined', {
        yourSocketId: socket.id, isCreator, roomName: room.name,
        users: Object.values(state.users),
        videoState: state.videoState, pdfState: state.pdfState,
        creatorSocketId: state.creatorSocketId
      });

      // Notify everyone else
      socket.to(token).emit('user-joined', {
        ...info, isCreator, message: `${info.displayName} joined the room`
      });
      io.to(token).emit('users-update', Object.values(state.users));
    } catch (e) { socket.emit('room-error', e.message); }
  });

  // ── VIDEO SYNC (creator only) ────────────────────────
  socket.on('video-load',  ({ token, url }) => {
    if (!socket.isCreator || !activeRooms[token]) return;
    activeRooms[token].videoState = { url, currentTime: 0, isPlaying: false, subtitleUrl: null };
    socket.to(token).emit('video-load', { url });
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
  socket.on('subtitle-load', ({ token, subtitleUrl }) => {
    if (!socket.isCreator || !activeRooms[token]) return;
    activeRooms[token].videoState.subtitleUrl = subtitleUrl;
    io.to(token).emit('subtitle-load', { subtitleUrl });
  });

  // ── PDF SYNC ─────────────────────────────────────────
  socket.on('pdf-add', ({ token, url, name }) => {
    if (!socket.isCreator || !activeRooms[token]) return;
    activeRooms[token].pdfState.list.push({ url, name: name || 'Document' });
    io.to(token).emit('pdf-list-update', activeRooms[token].pdfState);
  });
  socket.on('pdf-remove', ({ token, index }) => {
    if (!socket.isCreator || !activeRooms[token]) return;
    activeRooms[token].pdfState.list.splice(index, 1);
    io.to(token).emit('pdf-list-update', activeRooms[token].pdfState);
  });
  socket.on('pdf-navigate', ({ token, index, page }) => {
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
  socket.on('pdf-scroll', ({ token, ratio }) => {
    if (!socket.isCreator || !activeRooms[token]) return;
    socket.to(token).emit('pdf-scroll', { ratio });
  });

  // ── CHAT ─────────────────────────────────────────────
  socket.on('chat-msg', ({ token, text }) => {
    if (!activeRooms[token] || !socket.userInfo) return;
    if (!text?.trim() || text.length > 1000) return;
    io.to(token).emit('chat-msg', {
      id: uuidv4(), socketId: socket.id,
      displayName: socket.userInfo.displayName,
      avatar: socket.userInfo.avatar,
      text: text.trim(), ts: Date.now()
    });
  });

  // ── VOICE CHAT (WebRTC Signaling) ────────────────────
  socket.on('voice-offer',   ({ to, offer })     => io.to(to).emit('voice-offer',   { from: socket.id, offer }));
  socket.on('voice-answer',  ({ to, answer })    => io.to(to).emit('voice-answer',  { from: socket.id, answer }));
  socket.on('voice-ice',     ({ to, candidate }) => io.to(to).emit('voice-ice',     { from: socket.id, candidate }));
  socket.on('voice-joined',  ({ token })         => socket.to(token).emit('voice-peer-joined', { socketId: socket.id }));
  socket.on('voice-left',    ({ token })         => socket.to(token).emit('voice-peer-left',   { socketId: socket.id }));

  // ── MUTE CONTROLS ────────────────────────────────────
  socket.on('mute-user', ({ token, targetId, globally }) => {
    const s = activeRooms[token]; if (!s) return;
    if (globally && !socket.isCreator) return;
    if (globally) {
      if (s.users[targetId]) s.users[targetId].isGlobalMuted = true;
      io.to(token).emit('user-muted-global', { targetId });
    } else {
      socket.emit('user-muted-local', { targetId });
    }
  });
  socket.on('unmute-user', ({ token, targetId, globally }) => {
    const s = activeRooms[token]; if (!s) return;
    if (globally && !socket.isCreator) return;
    if (globally) {
      if (s.users[targetId]) s.users[targetId].isGlobalMuted = false;
      io.to(token).emit('user-unmuted-global', { targetId });
    } else {
      socket.emit('user-unmuted-local', { targetId });
    }
  });

  // ── KICK ─────────────────────────────────────────────
  socket.on('kick-user', ({ token, targetId }) => {
    if (!socket.isCreator || !activeRooms[token]) return;
    const target = io.sockets.sockets.get(targetId);
    if (target) { target.emit('kicked', { message: 'You were removed by the room creator' }); target.leave(token); }
    delete activeRooms[token].users[targetId];
    io.to(token).emit('users-update', Object.values(activeRooms[token].users));
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
      if (info) io.to(token).emit('user-left', { socketId: socket.id, displayName: info.displayName, message: `${info.displayName} left the room` });
      io.to(token).emit('users-update', Object.values(activeRooms[token].users));
      io.to(token).emit('voice-peer-left', { socketId: socket.id });
    }
  });
});

// ════════════════════════════════════════════════════════
//  START SERVER
// ════════════════════════════════════════════════════════

const MONGO = process.env.MONGODB_URI || 'mongodb://localhost:27017/watchreadtogether';
const PORT  = process.env.PORT || 3000;

mongoose.connect(MONGO)
  .then(() => {
    console.log('✅ MongoDB connected');
    server.listen(PORT, () => {
      console.log(`🚀 Server: http://localhost:${PORT}`);
      console.log(`📁 PDF uploads: ${uploadDir}`);
    });
  })
  .catch(err => { console.error('❌ MongoDB error:', err); process.exit(1); });
