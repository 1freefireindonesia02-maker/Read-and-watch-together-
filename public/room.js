// ╔══════════════════════════════════════════════════════════╗
// ║  WATCH/READ TOGETHER — room.js v2                        ║
// ╚══════════════════════════════════════════════════════════╝

pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

const token  = location.pathname.replace(/^\//, '').split('/')[0];
const socket = io();

// ── STATE ─────────────────────────────────────────────────
let me         = null;
let isCreator  = false;
let roomUsers  = {};       // { socketId: userInfo }
let currentMode = 'video';
let chatOpen    = false;
let voiceOpen   = false;
let usersOpen   = false;
let unreadChats = 0;
let memberRefreshTimer = null;

// Video
const video = document.getElementById('main-video');
let videoLoaded   = false;
let ctrlTimer     = null;
let bufferingPeers = new Set();

// PDF
let pdfDocs    = [];
let pdfList    = [];
let pdfIndex   = 0;
let pdfPage    = 1;
let pdfTotal   = 0;
let pdfOrient  = 'horizontal';
let pdfBusy    = false;

// Voice
let localStream = null;
let voicePeers  = {};   // { socketId: { pc } }
let voiceUsers  = {};   // { socketId: userInfo }
let inVoice     = false;
let micMuted    = false;
let localMuted  = {};   // { socketId: bool } — muted only for me

// Users
let activeMenuTarget = null;

const ICE = { iceServers: [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' }
]};

// ═══════════════════════════════════════════════════════════
//  INIT
// ═══════════════════════════════════════════════════════════
async function init() {
  try {
    const r = await fetch('/api/auth/me');
    if (!r.ok) { location.href = '/auth'; return; }
    me = await r.json();
  } catch(e) {
    me = { displayName: 'Guest', username: 'guest', avatar: null };
  }
  socket.emit('join-room', { token });

  // Refresh member count every 30s
  memberRefreshTimer = setInterval(refreshMembers, 30000);

  // Close popup on outside click
  document.addEventListener('click', onDocClick);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeChatPanel(); closeVoicePanel(); closeUsersPopup(); } });
}

async function refreshMembers() {
  try {
    const r = await fetch(`/api/rooms/${token}/members`);
    const d = await r.json();
    document.getElementById('up-hd').textContent = `Members (${d.count})`;
  } catch(e) {}
}

// ═══════════════════════════════════════════════════════════
//  TOAST SYSTEM
// ═══════════════════════════════════════════════════════════
function showToast(text, type='info', dur=2500, onClick=null) {
  const cont = document.getElementById('toast-container');
  const el   = document.createElement('div');
  el.className = `toast-item toast-${type}`;
  el.textContent = text;
  if (onClick) el.style.cursor = 'pointer';
  cont.appendChild(el);
  requestAnimationFrame(() => { requestAnimationFrame(() => el.classList.add('show')); });
  if (onClick) el.addEventListener('click', () => { onClick(); el.remove(); });
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 400);
  }, dur);
}

// ═══════════════════════════════════════════════════════════
//  SOCKET — ROOM
// ═══════════════════════════════════════════════════════════
socket.on('room-joined', data => {
  isCreator = data.isCreator;
  document.getElementById('room-name-chip').textContent = data.roomName;
  document.title = data.roomName + ' — W/R Together';

  if (isCreator) {
    document.getElementById('crown-chip').classList.remove('hidden');
    document.getElementById('creator-tag').classList.remove('hidden');
    document.getElementById('pdf-add-btn').classList.remove('hidden');
  }

  // Build user map
  roomUsers = {};
  (data.users || []).forEach(u => { roomUsers[u.socketId] = u; });
  renderUsers();

  // Restore state
  if (data.videoState?.url) applyVideoState(data.videoState);
  else showVideoIdle();

  if (data.pdfState?.list?.length) applyPdfState(data.pdfState);
});

socket.on('room-error', msg => { alert(msg); location.href = '/mainpage'; });

socket.on('user-joined', info => {
  roomUsers[info.socketId] = info;
  renderUsers();
  showToast(`${info.displayName} joined the room`, 'join', 2500);
});

socket.on('user-left', ({ socketId, displayName }) => {
  delete roomUsers[socketId];
  renderUsers();
  showToast(`${displayName || 'Someone'} left the room`, 'leave', 2000);
  if (voicePeers[socketId]) { voicePeers[socketId].pc?.close(); delete voicePeers[socketId]; }
  delete voiceUsers[socketId];
  renderVoiceUsers();
  const audioEl = document.getElementById('audio-' + socketId);
  if (audioEl) audioEl.remove();
});

socket.on('users-update', users => {
  roomUsers = {};
  users.forEach(u => { roomUsers[u.socketId] = u; });
  renderUsers();
  renderVoiceUsers();
  document.getElementById('up-hd').textContent = `Members (${users.length})`;
});

socket.on('kicked', ({ message }) => {
  document.getElementById('eo-ico').textContent   = '🚪';
  document.getElementById('eo-title').textContent  = 'Removed';
  document.getElementById('eo-sub').textContent    = message;
  document.getElementById('end-overlay').classList.add('show');
  cleanup();
});

socket.on('banned', ({ message }) => {
  document.getElementById('eo-ico').textContent   = '🔨';
  document.getElementById('eo-title').textContent  = 'Banned';
  document.getElementById('eo-sub').textContent    = message;
  document.getElementById('end-overlay').classList.add('show');
  cleanup();
});

socket.on('system-msg', ({ text, type }) => {
  appendSysMsg(text, type);
});

// ═══════════════════════════════════════════════════════════
//  VIDEO — IDLE / SETUP
// ═══════════════════════════════════════════════════════════
function showVideoIdle() {
  if (isCreator) {
    document.getElementById('vs-creator').style.display = 'flex';
    document.getElementById('vs-waiting').style.display = 'none';
    document.getElementById('video-container').style.display = 'none';
  } else {
    document.getElementById('vs-creator').style.display = 'none';
    document.getElementById('vs-waiting').style.display = 'flex';
    document.getElementById('video-container').style.display = 'none';
  }
}

function activateVideoPlayer(url) {
  document.getElementById('vs-creator').style.display  = 'none';
  document.getElementById('vs-waiting').style.display  = 'none';
  document.getElementById('video-container').style.display = 'block';
  if (url) {
    video.src = url;
    video.load();
  }
  videoLoaded = true;
  updatePlayIcon(true);
}

function loadVideoUrl() {
  const url = document.getElementById('video-url-inp').value.trim();
  if (!url) return;
  socket.emit('video-load', { token, url });
  activateVideoPlayer(url);
}

function modalLoadVideo() {
  const url = document.getElementById('vm-url').value.trim();
  if (!url) { showMAlert('vm-alert', 'Enter a URL'); return; }
  socket.emit('video-load', { token, url });
  activateVideoPlayer(url);
  closeModal('video-modal');
}

socket.on('video-load', ({ url }) => {
  if (!isCreator) activateVideoPlayer(url);
});

function applyVideoState(state) {
  activateVideoPlayer(state.url);
  video.currentTime = state.currentTime || 0;
  if (state.subtitleUrl) doApplySub(state.subtitleUrl);
  if (state.isPlaying) video.play().catch(()=>{});
}

// ═══════════════════════════════════════════════════════════
//  VIDEO — CONTROLS
// ═══════════════════════════════════════════════════════════
function togglePlay() {
  if (!isCreator || !videoLoaded) return;
  if (video.paused) {
    video.play();
    socket.emit('video-play', { token, currentTime: video.currentTime });
  } else {
    video.pause();
    socket.emit('video-pause', { token, currentTime: video.currentTime });
  }
}

function skip(secs) {
  if (!isCreator || !videoLoaded) return;
  video.currentTime = Math.max(0, video.currentTime + secs);
  socket.emit('video-seek', { token, currentTime: video.currentTime });
  flashSkip(secs > 0 ? 'right' : 'left');
}

function onSeek(e) {
  if (!isCreator || !videoLoaded || !video.duration) return;
  const ratio = e.offsetX / e.currentTarget.clientWidth;
  video.currentTime = ratio * video.duration;
  socket.emit('video-seek', { token, currentTime: video.currentTime });
}

function flashSkip(side) {
  const el = document.getElementById('skip-' + side);
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 700);
}

// Double-tap / double-click seek
document.getElementById('video-container').addEventListener('dblclick', e => {
  if (!videoLoaded) return;
  const mid = e.currentTarget.clientWidth / 2;
  skip(e.offsetX < mid ? -10 : 10);
});

// Hide/show controls on mouse move
document.getElementById('video-container').addEventListener('mousemove', () => {
  document.getElementById('video-container').classList.add('show-ctrl');
  clearTimeout(ctrlTimer);
  ctrlTimer = setTimeout(() => document.getElementById('video-container').classList.remove('show-ctrl'), 3000);
});

// Video events
video.addEventListener('play', () => {
  updatePlayIcon(false);
  if (!isCreator) return;
  socket.emit('video-play', { token, currentTime: video.currentTime });
});
video.addEventListener('pause', () => {
  updatePlayIcon(true);
  if (!isCreator) return;
  socket.emit('video-pause', { token, currentTime: video.currentTime });
});
video.addEventListener('timeupdate', updateProgress);
video.addEventListener('waiting', () => {
  showBuffer(true);
  socket.emit('video-buffering', { token });
});
video.addEventListener('canplay', () => {
  showBuffer(false);
  socket.emit('video-ready', { token });
  bufferingPeers.delete(socket.id);
  updateBufOverlay();
});
video.addEventListener('loadstart', () => { showBuffer(true, 'Loading...'); });
video.addEventListener('loadeddata', () => { showBuffer(false); });
video.addEventListener('error',  e => { showBuffer(false); console.error('Video error', e); });

function showBuffer(show, txt='Buffering...') {
  const el = document.getElementById('buffer-overlay');
  document.getElementById('buf-text').textContent = txt;
  el.classList.toggle('show', show);
}

socket.on('video-peer-buffering', ({ socketId }) => {
  bufferingPeers.add(socketId);
  updateBufOverlay();
  if (isCreator) { video.pause(); socket.emit('video-pause', { token, currentTime: video.currentTime }); }
});
socket.on('video-peer-ready', ({ socketId }) => {
  bufferingPeers.delete(socketId);
  updateBufOverlay();
});
function updateBufOverlay() {
  if (bufferingPeers.size > 0) showBuffer(true, 'Waiting for others...');
  else showBuffer(false);
}

// Receive sync
socket.on('video-play',  ({ currentTime }) => {
  if (!videoLoaded || isCreator) return;
  if (Math.abs(video.currentTime - currentTime) > 1) video.currentTime = currentTime;
  video.play().catch(()=>{});
});
socket.on('video-pause', ({ currentTime }) => {
  if (!videoLoaded || isCreator) return;
  video.currentTime = currentTime;
  video.pause();
});
socket.on('video-seek',  ({ currentTime }) => {
  if (!videoLoaded || isCreator) return;
  video.currentTime = currentTime;
});

function updatePlayIcon(paused) {
  document.getElementById('v-play-ico').innerHTML = paused
    ? '<polygon points="5,3 19,12 5,21"/>'
    : '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>';
}
function updateProgress() {
  if (!video.duration) return;
  const pct = (video.currentTime / video.duration) * 100;
  document.getElementById('v-prog-fill').style.width = pct + '%';
  document.getElementById('v-time').textContent = fmt(video.currentTime) + ' / ' + fmt(video.duration);
}
function fmt(s) {
  s = Math.floor(s || 0);
  const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), sec = s%60;
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}
function pad(n) { return String(n).padStart(2,'0'); }
function setVol(v) { video.volume = parseFloat(v); updateVolIco(); }
function toggleVolMute() { video.muted = !video.muted; updateVolIco(); }
function updateVolIco() {
  const m = video.muted || video.volume === 0;
  document.getElementById('vol-ico').innerHTML = m
    ? '<polygon points="11,5 6,9 2,9 2,15 6,15 11,19"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>'
    : '<polygon points="11,5 6,9 2,9 2,15 6,15 11,19"/><path d="M19.07,4.93a10,10,0,0,1,0,14.14M15.54,8.46a5,5,0,0,1,0,7.07"/>';
}
function toggleFS() {
  const el = document.getElementById('video-container');
  if (!document.fullscreenElement) el.requestFullscreen?.();
  else document.exitFullscreen?.();
}

// Non-creator: hide play button functionality
function updateCreatorControls() {
  if (!isCreator) {
    document.getElementById('v-play-btn').style.pointerEvents = 'none';
    document.getElementById('v-play-btn').style.opacity = '0.35';
    document.getElementById('v-prog').style.cursor = 'default';
    document.getElementById('v-prog').onclick = null;
  }
}

// ═══════════════════════════════════════════════════════════
//  SUBTITLES
// ═══════════════════════════════════════════════════════════
function applySubtitle() {
  const url = document.getElementById('sub-url-inp').value.trim();
  if (!url || !isCreator) return;
  socket.emit('subtitle-load', { token, subtitleUrl: url });
  doApplySub(url);
}

function loadSubFile(input) {
  const file = input.files[0];
  if (!file || !isCreator) return;
  const reader = new FileReader();
  reader.onload = e => {
    let content = e.target.result;
    if (file.name.endsWith('.srt')) content = srtToVtt(content);
    const url = URL.createObjectURL(new Blob([content], { type: 'text/vtt' }));
    socket.emit('subtitle-load', { token, subtitleUrl: url });
    doApplySub(url);
  };
  reader.readAsText(file);
}

function srtToVtt(srt) {
  return 'WEBVTT\n\n' + srt.replace(/\r\n/g,'\n').replace(/(\d+:\d+:\d+),(\d+)/g,'$1.$2');
}

function doApplySub(url) {
  const track = document.getElementById('sub-track');
  track.src = url;
  document.getElementById('cc-badge').classList.remove('hidden');
  const t = video.textTracks[0];
  if (t) t.mode = 'showing';
}

socket.on('subtitle-load', ({ subtitleUrl }) => doApplySub(subtitleUrl));

// ═══════════════════════════════════════════════════════════
//  PDF
// ═══════════════════════════════════════════════════════════
async function addPdfUrl() {
  const url  = document.getElementById('pm-url').value.trim();
  if (!url) { showMAlert('pm-alert', 'Enter a PDF URL'); return; }
  const btn = document.getElementById('pm-url-btn');
  btn.disabled = true; btn.innerHTML = '<span class="spin-sm"></span>Loading...';
  const name = url.split('/').pop().split('?')[0] || 'Document';
  try {
    pdfList.push({ url, name });
    socket.emit('pdf-add', { token, url, name });
    await loadPdfDoc(url, name);
    renderPdfSidebar();
    switchMode('pdf');
    closeModal('pdf-modal');
  } catch(e) { showMAlert('pm-alert', 'Failed to load PDF: ' + e.message); }
  btn.disabled = false; btn.textContent = 'Add PDF Link';
  document.getElementById('pm-url').value = '';
}

async function uploadPdfFile(input) {
  const file = input.files[0];
  if (!file) return;
  if (file.size > 150 * 1024 * 1024) { showMAlert('pm-alert', 'Max file size is 150MB'); return; }
  const prog = document.getElementById('pdf-prog-bar');
  const fill = document.getElementById('pdf-prog-fill');
  prog.style.display = 'block';

  const formData = new FormData();
  formData.append('pdf', file);
  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/upload/pdf');
  xhr.upload.onprogress = e => {
    if (e.lengthComputable) fill.style.width = (e.loaded / e.total * 100) + '%';
  };
  xhr.onload = async () => {
    prog.style.display = 'none'; fill.style.width = '0%';
    if (xhr.status === 200) {
      const d = JSON.parse(xhr.responseText);
      pdfList.push({ url: d.url, name: file.name });
      socket.emit('pdf-add', { token, url: d.url, name: file.name });
      await loadPdfDoc(d.url, file.name);
      renderPdfSidebar();
      switchMode('pdf');
      closeModal('pdf-modal');
    } else {
      showMAlert('pm-alert', 'Upload failed. Please try again.');
    }
  };
  xhr.onerror = () => { prog.style.display = 'none'; showMAlert('pm-alert', 'Upload error'); };
  xhr.send(formData);
}

async function loadPdfDoc(url, name) {
  document.getElementById('pdf-loader').classList.add('show');
  document.getElementById('pdf-empty-view').style.display = 'none';
  try {
    const doc = await pdfjsLib.getDocument({ url, withCredentials: false }).promise;
    pdfDocs.push({ doc, name, pages: doc.numPages });
    pdfTotal += doc.numPages;
    await renderPdf();
    document.getElementById('pdf-loader').classList.remove('show');
  } catch(e) {
    document.getElementById('pdf-loader').classList.remove('show');
    throw e;
  }
}

async function renderPdf() {
  if (pdfBusy) return;
  pdfBusy = true;
  const wrap = document.getElementById('pdf-canvas-wrap');
  wrap.innerHTML = '';
  const isH = pdfOrient === 'horizontal';
  wrap.style.flexDirection = 'column';

  let gPage = 0;
  for (const { doc } of pdfDocs) {
    for (let p = 1; p <= doc.numPages; p++) {
      gPage++;
      const page     = await doc.getPage(p);
      const scale    = isH ? (document.getElementById('pdf-scroll').clientWidth / page.getViewport({ scale: 1 }).width) : 1.5;
      const viewport = page.getViewport({ scale: Math.max(scale, 0.5) });
      const canvas   = document.createElement('canvas');
      canvas.dataset.pageNum = gPage;
      canvas.width  = viewport.width;
      canvas.height = viewport.height;
      canvas.style.cssText = `display:block;width:100%;height:auto;flex-shrink:0;${isH ? '' : 'max-width:100%;margin:0 auto;'}`;
      wrap.appendChild(canvas);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    }
  }
  pdfTotal = gPage;
  updatePdfPageInfo();
  pdfBusy = false;
}

function renderPdfSidebar() {
  document.getElementById('pdf-cnt').textContent = pdfList.length;
  const list = document.getElementById('pdf-list');
  if (!pdfList.length) {
    list.innerHTML = '<div class="pdf-empty-state" style="height:60px;font-size:.75rem">No PDFs loaded</div>';
    return;
  }
  list.innerHTML = pdfList.map((item, i) => `
    <div class="pdf-item ${i === pdfIndex ? 'active' : ''}" onclick="jumpToPdf(${i})">
      <span>📄</span>
      <span class="pdf-item-name" title="${esc(item.name)}">${esc(item.name)}</span>
      ${isCreator ? `<span class="pdf-del" onclick="removePdf(event,${i})">✕</span>` : ''}
    </div>`).join('');
}

function jumpToPdf(i) {
  if (!isCreator) return;
  pdfIndex = i; pdfPage = 1;
  socket.emit('pdf-navigate', { token, index: i, page: 1 });
  scrollToPage(1);
  renderPdfSidebar();
}

function removePdf(e, i) {
  e.stopPropagation();
  pdfList.splice(i, 1);
  pdfDocs.splice(i, 1);
  socket.emit('pdf-remove', { token, index: i });
  renderPdfSidebar();
  renderPdf();
}

function setPdfOrient(o) {
  if (!isCreator) return;
  pdfOrient = o;
  socket.emit('pdf-orientation', { token, orientation: o });
  updateOrientUI();
  renderPdf();
}

function updateOrientUI() {
  document.getElementById('o-h').classList.toggle('active', pdfOrient === 'horizontal');
  document.getElementById('o-v').classList.toggle('active', pdfOrient === 'vertical');
}

function updatePdfPageInfo() {
  document.getElementById('pdf-page-info').textContent = pdfTotal ? `Page ${pdfPage} / ${pdfTotal}` : '—';
}

function scrollToPage(page) {
  const el = document.querySelector(`[data-page-num="${page}"]`);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function pdfPrev() {
  if (!isCreator || pdfPage <= 1) return;
  pdfPage--;
  socket.emit('pdf-navigate', { token, index: pdfIndex, page: pdfPage });
  scrollToPage(pdfPage); updatePdfPageInfo();
}
function pdfNext() {
  if (!isCreator || pdfPage >= pdfTotal) return;
  pdfPage++;
  socket.emit('pdf-navigate', { token, index: pdfIndex, page: pdfPage });
  scrollToPage(pdfPage); updatePdfPageInfo();
}

function onPdfScroll() {
  if (!isCreator) return;
  const sc = document.getElementById('pdf-scroll');
  const ratio = sc.scrollTop / Math.max(1, sc.scrollHeight - sc.clientHeight);
  socket.emit('pdf-scroll', { token, ratio });
  // Detect page
  const canvases = document.querySelectorAll('[data-page-num]');
  for (const c of canvases) {
    const r = c.getBoundingClientRect();
    if (r.bottom >= 0) {
      const pg = parseInt(c.dataset.pageNum);
      if (pg && pg !== pdfPage) { pdfPage = pg; updatePdfPageInfo(); }
      break;
    }
  }
}

function applyPdfState(state) {
  pdfList   = state.list || [];
  pdfIndex  = state.currentIndex || 0;
  pdfPage   = state.currentPage  || 1;
  pdfOrient = state.orientation  || 'horizontal';
  updateOrientUI();
  renderPdfSidebar();
  pdfDocs = []; pdfTotal = 0;
  pdfList.forEach(item => loadPdfDoc(item.url, item.name));
  switchMode('pdf');
}

socket.on('pdf-list-update',  state  => applyPdfState(state));
socket.on('pdf-navigate',     ({ index, page }) => { pdfIndex = index; pdfPage = page; scrollToPage(page); updatePdfPageInfo(); renderPdfSidebar(); });
socket.on('pdf-orientation',  ({ orientation }) => { pdfOrient = orientation; updateOrientUI(); renderPdf(); });
socket.on('pdf-scroll',       ({ ratio }) => {
  const sc = document.getElementById('pdf-scroll');
  sc.scrollTop = ratio * (sc.scrollHeight - sc.clientHeight);
});

// ═══════════════════════════════════════════════════════════
//  MODE SWITCH
// ═══════════════════════════════════════════════════════════
function switchMode(mode) {
  currentMode = mode;
  document.getElementById('mt-video').classList.toggle('active', mode === 'video');
  document.getElementById('mt-pdf').classList.toggle('active',   mode === 'pdf');
  document.getElementById('video-panel').style.display = mode === 'video' ? 'flex' : 'none';
  document.getElementById('pdf-panel').style.display   = mode === 'pdf'   ? 'block' : 'none';
}

// ═══════════════════════════════════════════════════════════
//  CHAT — FLOATING PANEL
// ═══════════════════════════════════════════════════════════
function toggleChatPanel() {
  chatOpen = !chatOpen;
  document.getElementById('chat-float').classList.toggle('open', chatOpen);
  document.getElementById('tb-chat').classList.toggle('tb-active', chatOpen);
  if (chatOpen) {
    if (voiceOpen) closeVoicePanel();
    unreadChats = 0;
    document.getElementById('chat-notif').style.display = 'none';
    document.getElementById('chat-msgs').scrollTop = 99999;
    setTimeout(() => document.getElementById('chat-inp').focus(), 100);
  }
}
function closeChatPanel() {
  chatOpen = false;
  document.getElementById('chat-float').classList.remove('open');
  document.getElementById('tb-chat').classList.remove('tb-active');
}

function appendSysMsg(text, type='info') {
  const cont = document.getElementById('chat-msgs');
  const el = document.querySelector('.chat-empty-state');
  if (el) el.remove();
  const d = document.createElement('div');
  d.className = `sys-msg ${type}`;
  d.textContent = text;
  cont.appendChild(d);
  cont.scrollTop = 99999;
}

function renderChatMsg(data) {
  const cont  = document.getElementById('chat-msgs');
  const empty = cont.querySelector('.chat-empty-state');
  if (empty) empty.remove();
  const isMine = data.socketId === socket.id;
  const initial = (data.displayName || '?').charAt(0).toUpperCase();
  const avEl = data.avatar ? `<img src="${data.avatar}" alt="">` : initial;

  // Highlight mentions
  const textHtml = esc(data.text).replace(/@(\w+)/g, '<span class="mention">@$1</span>');

  const d = document.createElement('div');
  d.className = 'chat-msg' + (isMine ? ' chat-mine' : '');
  d.innerHTML = `
    <div class="chat-av">${avEl}</div>
    <div class="chat-bub">
      ${!isMine ? `<div class="chat-name">${esc(data.displayName || 'Guest')}</div>` : ''}
      <div class="chat-text">${textHtml}</div>
    </div>`;
  cont.appendChild(d);
  cont.scrollTop = 99999;
}

function sendChat() {
  const inp  = document.getElementById('chat-inp');
  const text = inp.value.trim();
  if (!text) return;
  socket.emit('chat-msg', { token, text });
  inp.value = '';
  inp.style.height = '';
  document.getElementById('mention-drop').style.display = 'none';
}

function chatKey(e) {
  // Mention dropdown navigation
  const drop = document.getElementById('mention-drop');
  if (drop.style.display !== 'none') {
    const items = drop.querySelectorAll('.mention-item');
    const current = drop.querySelector('.mention-item:focus');
    if (e.key === 'ArrowDown') { e.preventDefault(); (current ? current.nextElementSibling : items[0])?.focus(); return; }
    if (e.key === 'ArrowUp')   { e.preventDefault(); (current ? current.previousElementSibling : items[items.length-1])?.focus(); return; }
    if (e.key === 'Enter' && current) { e.preventDefault(); current.click(); return; }
    if (e.key === 'Escape') { drop.style.display = 'none'; return; }
  }
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
}

function onChatInput(el) {
  // Auto resize
  el.style.height = '';
  el.style.height = Math.min(el.scrollHeight, 70) + 'px';

  // Mention detection
  const text  = el.value;
  const caret = el.selectionStart;
  const before = text.substring(0, caret);
  const match  = before.match(/@(\w*)$/);
  const drop   = document.getElementById('mention-drop');

  if (match) {
    const query   = match[1].toLowerCase();
    const matches = Object.values(roomUsers).filter(u =>
      u.socketId !== socket.id && (u.username?.toLowerCase().includes(query) || u.displayName?.toLowerCase().includes(query))
    ).slice(0, 6);

    if (matches.length) {
      drop.style.display = 'block';
      drop.innerHTML = matches.map(u => {
        const av = u.avatar ? `<img src="${u.avatar}" style="width:22px;height:22px;border-radius:50%;object-fit:cover">` : `<div class="mention-av">${(u.displayName||'?').charAt(0)}</div>`;
        return `<div class="mention-item" tabindex="0" onclick="insertMention('${esc(u.username || u.displayName)}')">
          ${av}<span>@${esc(u.displayName || u.username)}</span>
        </div>`;
      }).join('');
    } else drop.style.display = 'none';
  } else {
    drop.style.display = 'none';
  }
}

function insertMention(username) {
  const inp  = document.getElementById('chat-inp');
  const text = inp.value;
  const caret = inp.selectionStart;
  const before = text.substring(0, caret);
  const after  = text.substring(caret);
  const newBefore = before.replace(/@\w*$/, '@' + username + ' ');
  inp.value = newBefore + after;
  inp.focus();
  document.getElementById('mention-drop').style.display = 'none';
}

socket.on('chat-msg', data => {
  renderChatMsg(data);
  // Toast if chat is closed
  if (!chatOpen) {
    unreadChats++;
    document.getElementById('chat-notif').style.display = 'block';
    if (data.socketId !== socket.id) {
      showToast(`${data.displayName}: ${data.text.substring(0, 40)}${data.text.length > 40 ? '…' : ''}`, 'chat', 2000, () => {
        if (!chatOpen) toggleChatPanel();
      });
    }
  }
});

// ═══════════════════════════════════════════════════════════
//  VOICE — FLOATING PANEL
// ═══════════════════════════════════════════════════════════
function toggleVoicePanel() {
  voiceOpen = !voiceOpen;
  document.getElementById('voice-float').classList.toggle('open', voiceOpen);
  document.getElementById('tb-voice').classList.toggle('tb-active', voiceOpen);
  if (voiceOpen && chatOpen) closeChatPanel();
}
function closeVoicePanel() {
  voiceOpen = false;
  document.getElementById('voice-float').classList.remove('open');
  document.getElementById('tb-voice').classList.remove('tb-active');
}

async function joinVoice() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    inVoice = true; micMuted = false;
    document.getElementById('vc-join').classList.add('hidden');
    document.getElementById('vc-mute').classList.remove('hidden');
    document.getElementById('vc-leave').classList.remove('hidden');
    voiceUsers[socket.id] = { ...me, socketId: socket.id, micMuted: false };
    renderVoiceUsers();
    socket.emit('voice-joined', { token });
    Object.keys(roomUsers).forEach(sid => { if (sid !== socket.id) initPeer(sid, true); });
  } catch(e) { showToast('Mic access denied: ' + e.message, 'leave'); }
}

function leaveVoice() {
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  Object.values(voicePeers).forEach(p => p.pc?.close());
  voicePeers = {}; inVoice = false;
  delete voiceUsers[socket.id];
  renderVoiceUsers();
  socket.emit('voice-left', { token });
  document.getElementById('vc-join').classList.remove('hidden');
  document.getElementById('vc-mute').classList.add('hidden');
  document.getElementById('vc-leave').classList.add('hidden');
}

function toggleMic() {
  if (!inVoice || !localStream) return;
  micMuted = !micMuted;
  localStream.getAudioTracks().forEach(t => { t.enabled = !micMuted; });
  if (voiceUsers[socket.id]) voiceUsers[socket.id].micMuted = micMuted;
  const btn = document.getElementById('vc-mute');
  btn.className = `vc-btn vc-mute${micMuted ? ' muted' : ''}`;
  btn.textContent = micMuted ? '🔇 Unmute' : '🎙️ Mute';
  renderVoiceUsers();
}

function initPeer(targetId, initiator) {
  if (voicePeers[targetId]) return voicePeers[targetId];
  const pc = new RTCPeerConnection(ICE);
  voicePeers[targetId] = { pc };
  if (localStream) localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
  pc.onicecandidate = e => { if (e.candidate) socket.emit('voice-ice', { to: targetId, candidate: e.candidate }); };
  pc.ontrack = e => {
    const stream = e.streams[0];
    if (localMuted[targetId]) stream.getAudioTracks().forEach(t => { t.enabled = false; });
    let audio = document.getElementById('audio-' + targetId);
    if (!audio) { audio = document.createElement('audio'); audio.id = 'audio-' + targetId; audio.autoplay = true; audio.style.display = 'none'; document.body.appendChild(audio); }
    audio.srcObject = stream;
    voiceUsers[targetId] = { ...(roomUsers[targetId] || { displayName: 'Member' }), socketId: targetId, micMuted: false };
    renderVoiceUsers();
  };
  if (initiator) {
    pc.createOffer().then(o => { pc.setLocalDescription(o); socket.emit('voice-offer', { to: targetId, offer: o }); });
  }
  return voicePeers[targetId];
}

socket.on('voice-peer-joined', ({ socketId }) => { if (inVoice) initPeer(socketId, true); });
socket.on('voice-peer-left',   ({ socketId }) => {
  if (voicePeers[socketId]) { voicePeers[socketId].pc?.close(); delete voicePeers[socketId]; }
  delete voiceUsers[socketId];
  const audio = document.getElementById('audio-' + socketId);
  if (audio) audio.remove();
  renderVoiceUsers();
});
socket.on('voice-offer',  async ({ from, offer })    => {
  if (!inVoice) return;
  const p = initPeer(from, false);
  await p.pc.setRemoteDescription(new RTCSessionDescription(offer));
  const answer = await p.pc.createAnswer();
  await p.pc.setLocalDescription(answer);
  socket.emit('voice-answer', { to: from, answer });
});
socket.on('voice-answer', async ({ from, answer })   => {
  if (voicePeers[from]) await voicePeers[from].pc.setRemoteDescription(new RTCSessionDescription(answer)).catch(()=>{});
});
socket.on('voice-ice',         ({ from, candidate }) => {
  if (voicePeers[from]) voicePeers[from].pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(()=>{});
});

socket.on('user-muted-global',   ({ targetId }) => {
  if (targetId === socket.id) {
    micMuted = true;
    if (localStream) localStream.getAudioTracks().forEach(t => { t.enabled = false; });
    document.getElementById('vc-mute').className = 'vc-btn vc-mute muted';
    document.getElementById('vc-mute').textContent = '🔇 Unmute';
    showToast('You were muted by the creator', 'action');
  }
  if (voiceUsers[targetId]) voiceUsers[targetId].micMuted = true;
  renderVoiceUsers();
});
socket.on('user-unmuted-global', ({ targetId }) => {
  if (targetId === socket.id) {
    micMuted = false;
    if (localStream) localStream.getAudioTracks().forEach(t => { t.enabled = true; });
    document.getElementById('vc-mute').className = 'vc-btn vc-mute';
    document.getElementById('vc-mute').textContent = '🎙️ Mute';
  }
  if (voiceUsers[targetId]) voiceUsers[targetId].micMuted = false;
  renderVoiceUsers();
});

function renderVoiceUsers() {
  const list  = document.getElementById('voice-users-list');
  const users = Object.values(voiceUsers);
  if (!users.length) {
    list.innerHTML = '<div style="text-align:center;color:var(--m);font-size:.78rem;padding:12px">No one in voice chat yet</div>';
    return;
  }
  list.innerHTML = users.map(u => {
    const isSelf  = u.socketId === socket.id;
    const muted   = isSelf ? micMuted : (localMuted[u.socketId] || u.micMuted);
    const av      = u.avatar ? `<img src="${u.avatar}" alt="">` : (u.displayName||'?').charAt(0).toUpperCase();
    const actions = !isSelf ? `
      <div class="vu-btns">
        <div class="vu-btn" onclick="toggleLocalMute('${u.socketId}')" title="Mute locally">${localMuted[u.socketId] ? '🔈' : '🔇'}</div>
        ${isCreator ? `<div class="vu-btn" onclick="creatorGlobalMute('${u.socketId}',!${!!u.micMuted})">${u.micMuted ? '🔊' : '⛔'}</div>` : ''}
      </div>` : '';
    return `<div class="vu-item ${u.speaking ? 'speaking' : ''}">
      <div class="vu-av">${av}</div>
      <div class="vu-info">
        <div class="vu-name">${esc(u.displayName || 'Member')}${isSelf ? ' <span style="font-size:.6rem;color:var(--m)">(you)</span>' : ''}</div>
        <div class="vu-status${muted ? ' muted' : ''}">${muted ? '🔇 Muted' : '🎙️ Active'}</div>
      </div>
      ${actions}
    </div>`;
  }).join('');
}

function toggleLocalMute(sid) {
  localMuted[sid] = !localMuted[sid];
  const peer = voicePeers[sid];
  if (peer) {
    const audio = document.getElementById('audio-' + sid);
    if (audio && audio.srcObject) audio.srcObject.getAudioTracks().forEach(t => { t.enabled = !localMuted[sid]; });
  }
  showToast(localMuted[sid] ? 'Muted locally' : 'Unmuted locally', 'action', 1500);
  renderVoiceUsers();
}

function creatorGlobalMute(sid, mute) {
  socket.emit(mute ? 'mute-user' : 'unmute-user', { token, targetId: sid, globally: true });
  showToast(mute ? 'Muted for everyone' : 'Unmuted for everyone', 'action', 1800);
}

// ═══════════════════════════════════════════════════════════
//  USERS POPUP + 3-DOT MENU
// ═══════════════════════════════════════════════════════════
function toggleUsersPopup() {
  usersOpen = !usersOpen;
  const popup = document.getElementById('users-popup');
  const wm    = document.getElementById('wm-emoji');
  popup.classList.toggle('open', usersOpen);
  wm.style.opacity = usersOpen ? '0.75' : '0.18';
  if (usersOpen) renderUsers();
}
function closeUsersPopup() {
  usersOpen = false;
  document.getElementById('users-popup').classList.remove('open');
  document.getElementById('wm-emoji').style.opacity = '0.18';
}

function renderUsers() {
  const users = Object.values(roomUsers);
  document.getElementById('up-hd').textContent = `Members (${users.length})`;
  const list = document.getElementById('up-list');

  list.innerHTML = users.map(u => {
    const isSelf  = u.socketId === socket.id;
    const av      = u.avatar ? `<img src="${u.avatar}" alt="">` : (u.displayName||'?').charAt(0).toUpperCase();
    const crown   = u.isCreator ? '<span style="font-size:.7rem">👑</span>' : '';
    const youTag  = isSelf ? '<span style="font-size:.62rem;color:var(--m)">(you)</span>' : '';
    const dots    = (isCreator && !isSelf)
      ? `<div class="up-3dot" onclick="open3Dot(event,'${u.socketId}')">⋮</div>`
      : (!isSelf ? `<div class="up-3dot" onclick="openSelfMuteMenu(event,'${u.socketId}')">⋮</div>` : '');
    return `<div class="up-user">
      <div class="up-av">${av}</div>
      <div class="up-name">${esc(u.displayName||'Guest')} ${crown}${youTag}</div>
      ${dots}
    </div>`;
  }).join('');
}

function open3Dot(e, targetId) {
  e.stopPropagation();
  const menu = document.getElementById('up-menu');
  const target = roomUsers[targetId];
  if (!target) return;
  const rect = e.currentTarget.getBoundingClientRect();

  menu.innerHTML = `
    <div class="up-menu-item warn-item" onclick="doMuteAll('${targetId}')">🔇 Mute for Everyone</div>
    <div class="up-menu-item" onclick="doUnmuteAll('${targetId}')">🔊 Unmute for Everyone</div>
    <div class="up-menu-divider"></div>
    <div class="up-menu-item danger" onclick="doKick('${targetId}')">🚪 Kick Out</div>
    <div class="up-menu-item danger" onclick="doBan('${targetId}')">🔨 Ban User</div>`;

  menu.style.right  = (window.innerWidth - rect.right + 30) + 'px';
  menu.style.top    = rect.top + 'px';
  menu.style.left   = 'auto';
  menu.classList.add('open');
  activeMenuTarget = targetId;
}

function openSelfMuteMenu(e, targetId) {
  e.stopPropagation();
  const menu = document.getElementById('up-menu');
  const rect = e.currentTarget.getBoundingClientRect();
  menu.innerHTML = `
    <div class="up-menu-item" onclick="toggleLocalMuteUser('${targetId}')">
      ${localMuted[targetId] ? '🔈 Unmute (locally)' : '🔇 Mute (locally)'}
    </div>`;
  menu.style.right = (window.innerWidth - rect.right + 30) + 'px';
  menu.style.top   = rect.top + 'px';
  menu.style.left  = 'auto';
  menu.classList.add('open');
  activeMenuTarget = targetId;
}

function toggleLocalMuteUser(sid) {
  localMuted[sid] = !localMuted[sid];
  const audio = document.getElementById('audio-' + sid);
  if (audio && audio.srcObject) audio.srcObject.getAudioTracks().forEach(t => { t.enabled = !localMuted[sid]; });
  showToast(localMuted[sid] ? 'Muted locally' : 'Unmuted locally', 'action', 1500);
  closeMenu();
  renderUsers();
}

function doMuteAll(tid) {
  socket.emit('mute-user', { token, targetId: tid, globally: true });
  showToast('Muted for everyone', 'action', 1800);
  closeMenu();
}
function doUnmuteAll(tid) {
  socket.emit('unmute-user', { token, targetId: tid, globally: true });
  showToast('Unmuted for everyone', 'action', 1800);
  closeMenu();
}
function doKick(tid) {
  if (!confirm('Kick this user?')) { closeMenu(); return; }
  socket.emit('kick-user', { token, targetId: tid });
  showToast('User kicked', 'action', 1500);
  closeMenu();
}
function doBan(tid) {
  if (!confirm('Ban this user? They cannot rejoin.')) { closeMenu(); return; }
  socket.emit('ban-user', { token, targetId: tid });
  showToast('User banned', 'action', 1500);
  closeMenu();
}

function closeMenu() {
  document.getElementById('up-menu').classList.remove('open');
  activeMenuTarget = null;
}

// ═══════════════════════════════════════════════════════════
//  LEAVE & CLEANUP
// ═══════════════════════════════════════════════════════════
function leaveRoom() {
  if (confirm('Leave this room?')) {
    cleanup();
    location.href = '/mainpage';
  }
}
function cleanup() {
  if (localStream) localStream.getTracks().forEach(t => t.stop());
  Object.values(voicePeers).forEach(p => p.pc?.close());
  if (memberRefreshTimer) clearInterval(memberRefreshTimer);
  socket.disconnect();
}
window.addEventListener('beforeunload', cleanup);

// ═══════════════════════════════════════════════════════════
//  MODALS & UTILS
// ═══════════════════════════════════════════════════════════
function openModal(id) { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }
document.querySelectorAll('.modal-bg').forEach(el =>
  el.addEventListener('click', e => { if (e.target === el) closeModal(el.id); })
);

function showMAlert(id, msg, type='err') {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = msg;
  el.className = `m-alert show ${type}`;
  setTimeout(() => { if (el) el.className = 'm-alert'; }, 4000);
}

function onDocClick(e) {
  const menu = document.getElementById('up-menu');
  if (menu.classList.contains('open') && !menu.contains(e.target)) closeMenu();
  const popup = document.getElementById('users-popup');
  if (usersOpen && !popup.contains(e.target) && e.target.id !== 'wm-emoji') closeUsersPopup();
}

function esc(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ═══════════════════════════════════════════════════════════
//  BOOT
// ═══════════════════════════════════════════════════════════
init();
