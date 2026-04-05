// ╔══════════════════════════════════════════════════════════╗
// ║  WATCH/READ TOGETHER  —  room.js                         ║
// ║  Video Sync · PDF Sync · Voice WebRTC · Chat · Controls  ║
// ╚══════════════════════════════════════════════════════════╝

pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// ═══════════════════════════════════════════
//  GLOBALS
// ═══════════════════════════════════════════

const token    = location.pathname.replace(/^\//, '').split('/')[0];
const socket   = io();

let me         = null;   // current user info from server
let isCreator  = false;
let roomUsers  = {};     // { socketId: userInfo }
let currentMode = 'video';
let toastTimer  = null;
let rpCurrentTab = 'chat';
let usersPopupOpen = false;

// Video
const video = document.getElementById('main-video');
let videoReady   = false;
let syncIgnore   = false;   // prevent echo-back
let lastSyncTime = 0;
let ctrlHideTimer = null;

// PDF
let pdfDocs      = [];       // array of loaded pdfjsLib objects
let pdfList      = [];       // [{ url, name }]
let pdfIndex     = 0;
let pdfPage      = 1;
let pdfTotalPages = 0;
let pdfOrientation = 'horizontal';
let pdfScrollIgnore = false;
let pdfRendering = false;

// Voice
let localStream      = null;
let voicePeers       = {};   // { socketId: { pc, stream } }
let inVoice          = false;
let micMuted         = false;
let locallyMuted     = {};   // socketId -> bool
let voiceUsers       = {};   // { socketId: userInfo }

// TURN/STUN config (free STUN + optional TURN)
const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

// ═══════════════════════════════════════════
//  INIT
// ═══════════════════════════════════════════

async function init() {
  try {
    const r = await fetch('/api/auth/me');
    if (!r.ok) { window.location.href = '/auth'; return; }
    me = await r.json();
  } catch(e) {
    me = { displayName: 'Guest', username: 'guest', avatar: null };
  }
  socket.emit('join-room', { token });
}

// ═══════════════════════════════════════════
//  SOCKET — ROOM EVENTS
// ═══════════════════════════════════════════

socket.on('room-joined', data => {
  isCreator = data.isCreator;
  document.getElementById('topbar-room-name').textContent = data.roomName;
  document.title = data.roomName + ' — W/R Together';

  if (isCreator) {
    document.getElementById('creator-badge').style.display = '';
    document.getElementById('creator-hint').style.display  = '';
    document.getElementById('pdf-creator-add').style.display = '';
    document.getElementById('sub-toggle-btn').style.display  = '';
    document.getElementById('subtitle-section').style.display = '';
  }

  // Build initial user map
  roomUsers = {};
  (data.users || []).forEach(u => { roomUsers[u.socketId] = u; });
  renderUsers();

  // Restore media state
  if (data.videoState?.url) applyVideoState(data.videoState);
  else showVideoSetup();

  if (data.pdfState?.list?.length) applyPdfState(data.pdfState);

  updateVideoUI();
});

socket.on('room-error', msg => {
  alert('Room Error: ' + msg);
  window.location.href = '/mainpage';
});

socket.on('user-joined', info => {
  roomUsers[info.socketId] = info;
  renderUsers();
  showToast(`${info.displayName} joined the room`);
  addSystemMsg(`${info.displayName} joined`);
});

socket.on('user-left', ({ socketId, displayName }) => {
  delete roomUsers[socketId];
  renderUsers();
  addSystemMsg(`${displayName || 'Someone'} left`);
  // Clean up voice peer
  if (voicePeers[socketId]) { voicePeers[socketId].pc.close(); delete voicePeers[socketId]; }
  delete voiceUsers[socketId];
  renderVoiceUsers();
});

socket.on('users-update', users => {
  roomUsers = {};
  users.forEach(u => { roomUsers[u.socketId] = u; });
  renderUsers();
  renderVoiceUsers();
});

socket.on('kicked', ({ message }) => {
  document.getElementById('kicked-msg').textContent = message;
  document.getElementById('kicked-overlay').classList.add('show');
  socket.disconnect();
  if (localStream) localStream.getTracks().forEach(t => t.stop());
});

// ═══════════════════════════════════════════
//  JOIN TOAST
// ═══════════════════════════════════════════

function showToast(msg) {
  const el = document.getElementById('join-toast');
  el.innerHTML = msg.replace(/^(\S+)/, '<span class="highlight">$1</span>');
  el.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 4000);
  el.onclick = () => { el.classList.remove('show'); clearTimeout(toastTimer); };
  // Swipe left to dismiss
  let sx = 0;
  el.addEventListener('touchstart', e => { sx = e.touches[0].clientX; }, { passive:true });
  el.addEventListener('touchend', e => {
    if (Math.abs(e.changedTouches[0].clientX - sx) > 50) el.classList.remove('show');
  }, { passive:true });
}

// ═══════════════════════════════════════════
//  USERS PANEL (watermark emoji)
// ═══════════════════════════════════════════

function toggleUsersPopup() {
  usersPopupOpen = !usersPopupOpen;
  const popup = document.getElementById('users-popup');
  const emoji = document.getElementById('watermark-emoji');
  popup.style.display = usersPopupOpen ? 'block' : 'none';
  emoji.style.opacity = usersPopupOpen ? '0.85' : '0.18';
  if (usersPopupOpen) renderUsers();
}

function renderUsers() {
  const users = Object.values(roomUsers);
  document.getElementById('up-header').textContent = `Members (${users.length})`;
  const list = document.getElementById('up-list');
  if (!users.length) { list.innerHTML = '<div style="padding:12px;color:var(--muted);font-size:0.8rem;text-align:center">No members</div>'; return; }

  list.innerHTML = users.map(u => {
    const isSelf    = u.socketId === socket.id;
    const isHost    = u.isCreator;
    const avatarEl  = u.avatar
      ? `<img src="${u.avatar}" alt="">`
      : (u.displayName || '?').charAt(0).toUpperCase();

    let actions = '';
    if (isCreator && !isSelf) {
      actions = `
        <div class="up-actions">
          <div class="up-action mute" onclick="creatorMute('${u.socketId}',true)" title="Mute for all">🔇</div>
          <div class="up-action kick" onclick="kickUser('${u.socketId}')" title="Kick">🚫</div>
        </div>`;
    } else if (!isSelf) {
      actions = `<div class="up-actions">
        <div class="up-action" onclick="localMuteUser('${u.socketId}')" title="Mute locally">${locallyMuted[u.socketId] ? '🔈' : '🔇'}</div>
      </div>`;
    }

    return `<div class="up-user">
      <div class="up-avatar">${avatarEl}</div>
      <div class="up-name">${esc(u.displayName || u.username || 'Guest')}</div>
      ${isHost ? '<span class="up-crown">👑</span>' : ''}
      ${isSelf ? '<span style="font-size:0.68rem;color:var(--muted)">(you)</span>' : ''}
      ${actions}
    </div>`;
  }).join('');
}

// Close popup on outside click
document.addEventListener('click', e => {
  if (usersPopupOpen && !document.getElementById('users-popup').contains(e.target) && e.target.id !== 'watermark-emoji')
    toggleUsersPopup();
});

// ═══════════════════════════════════════════
//  KICK & MUTE (Creator)
// ═══════════════════════════════════════════

function kickUser(targetId) {
  if (!isCreator || !confirm('Remove this user from the room?')) return;
  socket.emit('kick-user', { token, targetId });
}

function creatorMute(targetId, globally) {
  socket.emit('mute-user', { token, targetId, globally: true });
}

function localMuteUser(targetId) {
  locallyMuted[targetId] = !locallyMuted[targetId];
  const peer = voicePeers[targetId];
  if (peer?.stream) peer.stream.getAudioTracks().forEach(t => { t.enabled = !locallyMuted[targetId]; });
  renderUsers();
}

socket.on('user-muted-global', ({ targetId }) => {
  if (targetId === socket.id) {
    // we got globally muted
    micMuted = true;
    if (localStream) localStream.getAudioTracks().forEach(t => { t.enabled = false; });
    updateMuteBtn();
    addSystemMsg('You were muted by the creator');
  }
});
socket.on('user-unmuted-global', ({ targetId }) => {
  if (targetId === socket.id) {
    micMuted = false;
    if (localStream) localStream.getAudioTracks().forEach(t => { t.enabled = true; });
    updateMuteBtn();
  }
});

// ═══════════════════════════════════════════
//  MODE TABS
// ═══════════════════════════════════════════

function switchMode(mode) {
  currentMode = mode;
  document.getElementById('tab-video').classList.toggle('active', mode === 'video');
  document.getElementById('tab-pdf').classList.toggle('active',   mode === 'pdf');
  document.getElementById('video-panel').style.display = mode === 'video' ? 'flex' : 'none';
  document.getElementById('pdf-panel').style.display   = mode === 'pdf'   ? 'flex' : 'none';
}

// ═══════════════════════════════════════════
//  VIDEO — SETUP
// ═══════════════════════════════════════════

function showVideoSetup() {
  if (isCreator) {
    document.getElementById('video-setup').style.display   = '';
    document.getElementById('video-waiting').style.display = 'none';
    document.getElementById('video-container').style.display = 'none';
  } else {
    document.getElementById('video-setup').style.display   = 'none';
    document.getElementById('video-waiting').style.display = '';
    document.getElementById('video-container').style.display = 'none';
  }
}

function loadVideoUrl() {
  const url = document.getElementById('video-url-input').value.trim();
  if (!url) return;
  socket.emit('video-load', { token, url });
  applyVideoLoad(url);
  closeModal('video-modal');
}

function modalLoadVideo() {
  const url = document.getElementById('vm-url').value.trim();
  if (!url) { showMAlert('vm-alert', 'Please enter a URL'); return; }
  socket.emit('video-load', { token, url });
  applyVideoLoad(url);
  closeModal('video-modal');
}

function applyVideoLoad(url) {
  document.getElementById('video-setup').style.display   = 'none';
  document.getElementById('video-waiting').style.display = 'none';
  document.getElementById('video-container').style.display = '';
  video.src = url;
  video.load();
  videoReady = true;
}

socket.on('video-load', ({ url }) => { applyVideoLoad(url); });

function applyVideoState(state) {
  if (!state.url) return;
  applyVideoLoad(state.url);
  video.currentTime = state.currentTime || 0;
  if (state.subtitleUrl) applySubtitle(state.subtitleUrl);
}

// ═══════════════════════════════════════════
//  VIDEO — CONTROLS
// ═══════════════════════════════════════════

function updateVideoUI() {
  // Only creator can control video (non-creators have controls hidden)
  const controls = document.getElementById('v-controls');
  if (!isCreator) {
    // Hide play/skip for non-creators
    document.getElementById('v-play-btn').style.pointerEvents = 'none';
    document.getElementById('v-play-btn').style.opacity = '0.4';
  }
}

function togglePlay() {
  if (!isCreator || !videoReady) return;
  if (video.paused) {
    video.play();
    socket.emit('video-play', { token, currentTime: video.currentTime });
  } else {
    video.pause();
    socket.emit('video-pause', { token, currentTime: video.currentTime });
  }
}

function skip(secs) {
  if (!isCreator || !videoReady) return;
  video.currentTime = Math.max(0, video.currentTime + secs);
  socket.emit('video-seek', { token, currentTime: video.currentTime });
  flashSkip(secs > 0 ? 'right' : 'left');
}

function seekVideo(e) {
  if (!isCreator || !videoReady) return;
  const bar = document.getElementById('v-progress');
  const ratio = e.offsetX / bar.clientWidth;
  video.currentTime = ratio * (video.duration || 0);
  socket.emit('video-seek', { token, currentTime: video.currentTime });
}

function flashSkip(side) {
  const el = document.getElementById('skip-' + side);
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 700);
}

// Double-click: skip left side = -10s, right side = +10s
document.getElementById('video-container').addEventListener('dblclick', e => {
  if (!videoReady) return;
  const mid = e.currentTarget.clientWidth / 2;
  skip(e.offsetX < mid ? -10 : 10);
});

// Video events → sync
video.addEventListener('play',  () => {
  updatePlayIcon(false);
  if (!isCreator) return;
  if (Date.now() - lastSyncTime > 300) socket.emit('video-play', { token, currentTime: video.currentTime });
  lastSyncTime = Date.now();
});
video.addEventListener('pause', () => {
  updatePlayIcon(true);
  if (!isCreator) return;
  socket.emit('video-pause', { token, currentTime: video.currentTime });
});
video.addEventListener('timeupdate', () => {
  updateProgress();
});

function updatePlayIcon(paused) {
  document.getElementById('play-icon').innerHTML = paused
    ? '<polygon points="5,3 19,12 5,21"/>'
    : '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>';
}
function updateProgress() {
  if (!video.duration) return;
  const pct = (video.currentTime / video.duration) * 100;
  document.getElementById('v-progress-fill').style.width = pct + '%';
  document.getElementById('v-time').textContent = fmtTime(video.currentTime) + ' / ' + fmtTime(video.duration);
}
function fmtTime(s) {
  s = Math.floor(s || 0);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}
function pad(n) { return String(n).padStart(2,'0'); }

function setVolume(v) {
  video.volume = parseFloat(v);
  updateVolIcon();
}
function toggleMuteVol() {
  video.muted = !video.muted;
  updateVolIcon();
}
function updateVolIcon() {
  const muted = video.muted || video.volume === 0;
  document.getElementById('vol-icon').innerHTML = muted
    ? '<polygon points="11,5 6,9 2,9 2,15 6,15 11,19"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>'
    : '<polygon points="11,5 6,9 2,9 2,15 6,15 11,19"/><path d="M19.07,4.93a10,10,0,0,1,0,14.14M15.54,8.46a5,5,0,0,1,0,7.07"/>';
}

function toggleFullscreen() {
  const el = document.getElementById('video-container');
  if (!document.fullscreenElement) el.requestFullscreen?.();
  else document.exitFullscreen?.();
}

// Show/hide controls on mouse move
document.getElementById('video-container').addEventListener('mousemove', () => {
  const el = document.getElementById('video-container');
  el.classList.add('ctrl-show');
  clearTimeout(ctrlHideTimer);
  ctrlHideTimer = setTimeout(() => el.classList.remove('ctrl-show'), 3000);
});

// Receive sync events (non-creator)
socket.on('video-play', ({ currentTime }) => {
  if (!videoReady) return;
  if (Math.abs(video.currentTime - currentTime) > 0.5) video.currentTime = currentTime;
  video.play();
});
socket.on('video-pause', ({ currentTime }) => {
  if (!videoReady) return;
  video.currentTime = currentTime;
  video.pause();
});
socket.on('video-seek', ({ currentTime }) => {
  if (!videoReady) return;
  video.currentTime = currentTime;
});

// ═══════════════════════════════════════════
//  SUBTITLES
// ═══════════════════════════════════════════

function openCreatorSubtitle() {
  document.getElementById('subtitle-section').style.display = '';
  document.getElementById('subtitle-section').scrollIntoView({ behavior: 'smooth' });
}

function loadSubtitle() {
  const url = document.getElementById('sub-url-input').value.trim();
  if (!url || !isCreator) return;
  socket.emit('subtitle-load', { token, subtitleUrl: url });
  applySubtitle(url);
}

function loadSubFile(input) {
  const file = input.files[0];
  if (!file || !isCreator) return;
  const reader = new FileReader();
  reader.onload = e => {
    let content = e.target.result;
    // Convert SRT to VTT if needed
    if (file.name.endsWith('.srt')) content = srtToVtt(content);
    const url = URL.createObjectURL(new Blob([content], { type: 'text/vtt' }));
    socket.emit('subtitle-load', { token, subtitleUrl: url });
    applySubtitle(url);
  };
  reader.readAsText(file);
}

function srtToVtt(srt) {
  return 'WEBVTT\n\n' + srt.replace(/\r\n/g,'\n').replace(/(\d+:\d+:\d+),(\d+)/g,'$1.$2');
}

function applySubtitle(url) {
  const track = document.getElementById('sub-track');
  track.src = url;
  document.getElementById('sub-badge').style.display = '';
  // Force subtitle refresh
  const textTrack = video.textTracks[0];
  if (textTrack) textTrack.mode = 'showing';
}

socket.on('subtitle-load', ({ subtitleUrl }) => applySubtitle(subtitleUrl));

// ═══════════════════════════════════════════
//  PDF — LOAD & RENDER
// ═══════════════════════════════════════════

async function loadPdfUrl(url, name) {
  if (!url) return;
  try {
    document.getElementById('pdf-loading').style.display = '';
    document.getElementById('pdf-viewer-empty').style.display = 'none';
    const doc = await pdfjsLib.getDocument({ url, withCredentials: false }).promise;
    pdfDocs.push(doc);
    pdfTotalPages += doc.numPages;
    await renderAllPdfs();
    document.getElementById('pdf-loading').style.display = 'none';
  } catch(e) {
    document.getElementById('pdf-loading').style.display = 'none';
    console.error('PDF load error:', e);
  }
}

async function renderAllPdfs() {
  if (pdfRendering) return;
  pdfRendering = true;
  const container = document.getElementById('pdf-canvas-container');
  container.innerHTML = '';
  container.className = pdfOrientation === 'horizontal' ? 'h-mode' : '';

  let globalPage = 0;
  for (let di = 0; di < pdfDocs.length; di++) {
    const doc = pdfDocs[di];
    for (let p = 1; p <= doc.numPages; p++) {
      globalPage++;
      const page = await doc.getPage(p);
      const viewport = page.getViewport({ scale: window.devicePixelRatio > 1 ? 1.8 : 1.5 });
      const canvas = document.createElement('canvas');
      canvas.dataset.pageNum = globalPage;
      canvas.style.display = 'block';
      canvas.style.width = '100%';
      canvas.style.height = 'auto';
      canvas.style.flexShrink = '0';
      if (pdfOrientation === 'horizontal') canvas.style.marginBottom = '0';

      const ctx = canvas.getContext('2d');
      canvas.width  = viewport.width;
      canvas.height = viewport.height;
      container.appendChild(canvas);
      await page.render({ canvasContext: ctx, viewport }).promise;
    }
  }

  updatePdfPageInfo();
  pdfRendering = false;
}

function applyPdfState(state) {
  pdfList      = state.list || [];
  pdfIndex     = state.currentIndex || 0;
  pdfPage      = state.currentPage || 1;
  pdfOrientation = state.orientation || 'horizontal';
  updateOrientUI();
  renderPdfSidebar();
  pdfDocs = []; pdfTotalPages = 0;
  pdfList.forEach((item, i) => loadPdfUrl(item.url, item.name));
  switchMode('pdf');
}

function renderPdfSidebar() {
  const list = document.getElementById('pdf-list');
  const empty = document.getElementById('pdf-empty');
  document.getElementById('pdf-count').textContent = pdfList.length;

  if (!pdfList.length) {
    empty.style.display = '';
    list.innerHTML = '';
    list.appendChild(empty);
    return;
  }
  empty.style.display = 'none';
  list.innerHTML = pdfList.map((item, i) => `
    <div class="pdf-item ${i === pdfIndex ? 'active' : ''}" onclick="jumpToPdf(${i})">
      <span>📄</span>
      <span class="pdf-item-name" title="${esc(item.name)}">${esc(item.name)}</span>
      ${isCreator ? `<span class="pdf-item-del" onclick="removePdf(event,${i})">✕</span>` : ''}
    </div>`).join('');
}

function jumpToPdf(index) {
  if (!isCreator) return;
  pdfIndex = index;
  pdfPage  = 1;
  socket.emit('pdf-navigate', { token, index, page: 1 });
  scrollToPdfPage(1);
  renderPdfSidebar();
}

function removePdf(e, index) {
  e.stopPropagation();
  if (!isCreator) return;
  socket.emit('pdf-remove', { token, index });
  pdfList.splice(index, 1);
  pdfDocs.splice(index, 1);
  renderPdfSidebar();
  renderAllPdfs();
}

function setPdfOrientation(o) {
  if (!isCreator) return;
  pdfOrientation = o;
  socket.emit('pdf-orientation', { token, orientation: o });
  updateOrientUI();
  renderAllPdfs();
}

function updateOrientUI() {
  document.getElementById('orient-h').classList.toggle('active', pdfOrientation === 'horizontal');
  document.getElementById('orient-v').classList.toggle('active', pdfOrientation === 'vertical');
}

function updatePdfPageInfo() {
  document.getElementById('pdf-page-info').textContent =
    pdfTotalPages ? `Page ${pdfPage} of ${pdfTotalPages}` : '—';
}

function scrollToPdfPage(page) {
  const canvas = document.querySelector(`[data-page-num="${page}"]`);
  if (canvas) canvas.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function pdfPrevPage() {
  if (!isCreator || pdfPage <= 1) return;
  pdfPage--;
  socket.emit('pdf-navigate', { token, index: pdfIndex, page: pdfPage });
  scrollToPdfPage(pdfPage);
  updatePdfPageInfo();
}

function pdfNextPage() {
  if (!isCreator || pdfPage >= pdfTotalPages) return;
  pdfPage++;
  socket.emit('pdf-navigate', { token, index: pdfIndex, page: pdfPage });
  scrollToPdfPage(pdfPage);
  updatePdfPageInfo();
}

function onPdfScroll() {
  if (!isCreator) return;
  const scroller = document.getElementById('pdf-viewer-scroll');
  const ratio = scroller.scrollTop / (scroller.scrollHeight - scroller.clientHeight);
  socket.emit('pdf-scroll', { token, ratio: isNaN(ratio) ? 0 : ratio });
  // Detect current page
  const canvases = document.querySelectorAll('#pdf-canvas-container canvas');
  for (const c of canvases) {
    const rect = c.getBoundingClientRect();
    if (rect.top >= 0 || rect.bottom >= window.innerHeight / 2) {
      const pg = parseInt(c.dataset.pageNum);
      if (pg && pg !== pdfPage) { pdfPage = pg; updatePdfPageInfo(); }
      break;
    }
  }
}

// Socket PDF events
socket.on('pdf-list-update', state => { applyPdfState(state); });
socket.on('pdf-navigate', ({ index, page }) => {
  pdfIndex = index; pdfPage = page;
  scrollToPdfPage(page);
  updatePdfPageInfo();
  renderPdfSidebar();
});
socket.on('pdf-orientation', ({ orientation }) => {
  pdfOrientation = orientation;
  updateOrientUI();
  renderAllPdfs();
});
socket.on('pdf-scroll', ({ ratio }) => {
  const scroller = document.getElementById('pdf-viewer-scroll');
  scroller.scrollTop = ratio * (scroller.scrollHeight - scroller.clientHeight);
});

// ═══════════════════════════════════════════
//  PDF UPLOAD (Creator)
// ═══════════════════════════════════════════

async function addPdfUrl() {
  const url  = document.getElementById('pm-url').value.trim();
  const name = url.split('/').pop().split('?')[0] || 'Document';
  if (!url) { showMAlert('pm-alert', 'Please enter a URL'); return; }
  const btn = document.getElementById('pm-url-btn');
  btn.disabled = true; btn.innerHTML = '<span class="spin"></span>Loading...';

  pdfList.push({ url, name });
  socket.emit('pdf-add', { token, url, name });
  await loadPdfUrl(url, name);
  renderPdfSidebar();
  switchMode('pdf');
  closeModal('pdf-modal');
  btn.disabled = false; btn.textContent = 'Add Link';
  document.getElementById('pm-url').value = '';
}

async function uploadPdf(input) {
  const file = input.files[0];
  if (!file) return;
  if (file.size > 150 * 1024 * 1024) { showMAlert('pm-alert', 'File too large. Max 150MB.'); return; }

  const prog = document.getElementById('pdf-upload-progress');
  const bar  = document.getElementById('pdf-progress-bar');
  prog.style.display = '';

  const formData = new FormData();
  formData.append('pdf', file);

  try {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload/pdf');
    xhr.upload.addEventListener('progress', e => {
      if (e.lengthComputable) bar.style.width = (e.loaded / e.total * 100) + '%';
    });
    xhr.onload = async () => {
      prog.style.display = 'none'; bar.style.width = '0%';
      if (xhr.status === 200) {
        const d = JSON.parse(xhr.responseText);
        pdfList.push({ url: d.url, name: file.name });
        socket.emit('pdf-add', { token, url: d.url, name: file.name });
        await loadPdfUrl(d.url, file.name);
        renderPdfSidebar();
        switchMode('pdf');
        closeModal('pdf-modal');
      } else {
        showMAlert('pm-alert', 'Upload failed. Please try again.');
      }
    };
    xhr.onerror = () => { prog.style.display = 'none'; showMAlert('pm-alert', 'Upload error'); };
    xhr.send(formData);
  } catch(e) { prog.style.display = 'none'; showMAlert('pm-alert', e.message); }
}

// ═══════════════════════════════════════════
//  CHAT
// ═══════════════════════════════════════════

function addSystemMsg(text) {
  const container = document.getElementById('chat-msgs');
  const isEmpty = container.querySelector('.chat-empty');
  if (isEmpty) isEmpty.remove();
  const div = document.createElement('div');
  div.style.cssText = 'text-align:center;color:var(--muted);font-size:0.75rem;padding:4px 0';
  div.textContent = text;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

function renderChatMsg(data) {
  const container = document.getElementById('chat-msgs');
  const empty = container.querySelector('.chat-empty');
  if (empty) empty.remove();

  const isMine = data.socketId === socket.id;
  const initial = (data.displayName || '?').charAt(0).toUpperCase();
  const avatarEl = data.avatar
    ? `<img src="${data.avatar}" alt="">`
    : initial;

  const div = document.createElement('div');
  div.className = 'chat-msg' + (isMine ? ' chat-mine' : '');
  div.innerHTML = `
    <div class="chat-avatar">${avatarEl}</div>
    <div class="chat-bubble">
      ${!isMine ? `<div class="chat-name">${esc(data.displayName || 'Guest')}</div>` : ''}
      <div class="chat-text">${esc(data.text)}</div>
    </div>`;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

function sendChat() {
  const inp = document.getElementById('chat-input');
  const text = inp.value.trim();
  if (!text) return;
  socket.emit('chat-msg', { token, text });
  inp.value = '';
  inp.style.height = '';
}

function chatKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
}

function autoResize(el) {
  el.style.height = '';
  el.style.height = Math.min(el.scrollHeight, 80) + 'px';
}

socket.on('chat-msg', data => renderChatMsg(data));

// ═══════════════════════════════════════════
//  RIGHT PANEL TABS
// ═══════════════════════════════════════════

function switchRpTab(tab) {
  rpCurrentTab = tab;
  document.getElementById('rpt-chat').classList.toggle('active',  tab === 'chat');
  document.getElementById('rpt-voice').classList.toggle('active', tab === 'voice');
  document.getElementById('chat-panel').style.display  = tab === 'chat'  ? 'flex' : 'none';
  document.getElementById('voice-panel').style.display = tab === 'voice' ? 'flex' : 'none';
}

function toggleRightPanel(tab) {
  const rp = document.getElementById('right-panel');
  if (window.innerWidth <= 700) {
    const open = rp.classList.contains('mobile-open');
    if (open && rpCurrentTab === tab) { rp.classList.remove('mobile-open'); return; }
    rp.classList.add('mobile-open');
  }
  switchRpTab(tab);
}

// ═══════════════════════════════════════════
//  VOICE CHAT (WebRTC)
// ═══════════════════════════════════════════

async function joinVoice() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    inVoice = true;
    micMuted = false;
    document.getElementById('vc-join-btn').style.display  = 'none';
    document.getElementById('vc-mute-btn').style.display  = '';
    document.getElementById('vc-leave-btn').style.display = '';
    document.getElementById('v-status-title').textContent = '🎙️ Connected';
    document.getElementById('v-status-sub').textContent   = 'You are in the voice chat';

    // Add self to voice users
    voiceUsers[socket.id] = { ...me, socketId: socket.id, micMuted: false };
    renderVoiceUsers();

    // Notify peers, then connect to existing peers
    socket.emit('voice-joined', { token });
    Object.keys(roomUsers).forEach(sid => {
      if (sid !== socket.id) initVoicePeer(sid, true);
    });
  } catch(e) {
    alert('Microphone access denied or not available. ' + e.message);
  }
}

function leaveVoice() {
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  Object.values(voicePeers).forEach(p => p.pc.close());
  voicePeers = {};
  inVoice = false;
  delete voiceUsers[socket.id];
  renderVoiceUsers();
  socket.emit('voice-left', { token });
  document.getElementById('vc-join-btn').style.display  = '';
  document.getElementById('vc-mute-btn').style.display  = 'none';
  document.getElementById('vc-leave-btn').style.display = 'none';
  document.getElementById('v-status-title').textContent = 'Voice Chat';
  document.getElementById('v-status-sub').textContent   = 'Join to talk with everyone in the room';
}

function toggleMicMute() {
  if (!inVoice || !localStream) return;
  micMuted = !micMuted;
  localStream.getAudioTracks().forEach(t => { t.enabled = !micMuted; });
  if (voiceUsers[socket.id]) voiceUsers[socket.id].micMuted = micMuted;
  updateMuteBtn();
  renderVoiceUsers();
}

function updateMuteBtn() {
  const btn = document.getElementById('vc-mute-btn');
  btn.className = 'vc-btn vc-mute' + (micMuted ? ' muted' : '');
  btn.textContent = micMuted ? '🔇 Unmute' : '🎙️ Mute';
}

// Signaling
socket.on('voice-peer-joined', async ({ socketId }) => {
  if (!inVoice) return;
  initVoicePeer(socketId, true);
});

socket.on('voice-peer-left', ({ socketId }) => {
  if (voicePeers[socketId]) { voicePeers[socketId].pc.close(); delete voicePeers[socketId]; }
  delete voiceUsers[socketId];
  renderVoiceUsers();
});

socket.on('voice-offer', async ({ from, offer }) => {
  if (!inVoice) return;
  const peer = await initVoicePeer(from, false);
  await peer.pc.setRemoteDescription(new RTCSessionDescription(offer));
  const answer = await peer.pc.createAnswer();
  await peer.pc.setLocalDescription(answer);
  socket.emit('voice-answer', { to: from, answer });
});

socket.on('voice-answer', async ({ from, answer }) => {
  if (voicePeers[from]) await voicePeers[from].pc.setRemoteDescription(new RTCSessionDescription(answer));
});

socket.on('voice-ice', ({ from, candidate }) => {
  if (voicePeers[from]) voicePeers[from].pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(()=>{});
});

function initVoicePeer(targetId, isInitiator) {
  if (voicePeers[targetId]) return voicePeers[targetId];
  const pc = new RTCPeerConnection(ICE_SERVERS);
  voicePeers[targetId] = { pc, stream: null };

  // Add local tracks
  if (localStream) localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

  // ICE candidates
  pc.onicecandidate = e => {
    if (e.candidate) socket.emit('voice-ice', { to: targetId, candidate: e.candidate });
  };

  // Remote stream
  pc.ontrack = e => {
    const stream = e.streams[0];
    voicePeers[targetId].stream = stream;
    if (locallyMuted[targetId]) stream.getAudioTracks().forEach(t => { t.enabled = false; });
    // Play audio
    let audio = document.getElementById('audio-' + targetId);
    if (!audio) {
      audio = document.createElement('audio');
      audio.id = 'audio-' + targetId;
      audio.autoplay = true;
      audio.style.display = 'none';
      document.body.appendChild(audio);
    }
    audio.srcObject = stream;
    // Mark as in voice
    voiceUsers[targetId] = { ...(roomUsers[targetId] || { displayName: 'Member' }), socketId: targetId, micMuted: false };
    renderVoiceUsers();
  };

  if (isInitiator) {
    pc.createOffer().then(offer => {
      pc.setLocalDescription(offer);
      socket.emit('voice-offer', { to: targetId, offer });
    });
  }

  return voicePeers[targetId];
}

function renderVoiceUsers() {
  const list = document.getElementById('voice-users-list');
  const users = Object.values(voiceUsers);
  if (!users.length) {
    list.innerHTML = '<div style="color:var(--muted);font-size:0.82rem;text-align:center;padding:16px">No one in voice chat yet</div>';
    return;
  }
  list.innerHTML = users.map(u => {
    const isSelf   = u.socketId === socket.id;
    const isMuted  = isSelf ? micMuted : (locallyMuted[u.socketId] || u.micMuted);
    const avatarEl = u.avatar ? `<img src="${u.avatar}" alt="">` : (u.displayName || '?').charAt(0).toUpperCase();
    const actions  = !isSelf ? `
      <div class="vu-actions">
        <div class="vu-btn" onclick="localMuteUser('${u.socketId}')" title="${locallyMuted[u.socketId] ? 'Unmute' : 'Mute'} locally">
          ${locallyMuted[u.socketId] ? '🔈' : '🔇'}
        </div>
        ${isCreator ? `<div class="vu-btn" onclick="creatorMute('${u.socketId}',true)" title="Mute for all">⛔</div>` : ''}
      </div>` : '';
    return `<div class="voice-user ${u.speaking ? 'speaking' : ''}">
      <div class="vu-avatar">${avatarEl}</div>
      <div>
        <div class="vu-name">${esc(u.displayName || 'Member')} ${isSelf ? '(you)' : ''}</div>
        <div class="vu-status ${isMuted ? 'vu-muted' : ''}">${isMuted ? '🔇 Muted' : '🎙️ Speaking'}</div>
      </div>
      ${actions}
    </div>`;
  }).join('');
}

// ═══════════════════════════════════════════
//  MODALS
// ═══════════════════════════════════════════

function openModal(id) {
  document.getElementById(id).classList.add('open');
}
function closeModal(id) {
  document.getElementById(id).classList.remove('open');
}
function showMAlert(id, msg, type='error') {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = msg;
  el.className = 'm-alert show ' + type;
}

// Close modals on overlay click
document.querySelectorAll('.modal-overlay').forEach(el => {
  el.addEventListener('click', e => { if (e.target === el) closeModal(el.id); });
});

// ═══════════════════════════════════════════
//  LEAVE ROOM
// ═══════════════════════════════════════════

function leaveRoom() {
  if (confirm('Leave this room?')) {
    if (localStream) localStream.getTracks().forEach(t => t.stop());
    window.location.href = '/mainpage';
  }
}

// Clean up on tab close
window.addEventListener('beforeunload', () => {
  if (localStream) localStream.getTracks().forEach(t => t.stop());
});

// ═══════════════════════════════════════════
//  UTILS
// ═══════════════════════════════════════════

function esc(str) {
  return String(str || '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ═══════════════════════════════════════════
//  BOOT
// ═══════════════════════════════════════════
init();
