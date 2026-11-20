/* Card + face kiosk (for people without a smartphone).
   Card: printed QR (camera) or NFC tap card (Web NFC, Android Chrome).
   Face: face-api (on-device recognition) + liveness test (blink or head turn). */
'use strict';

const FACE_LIB = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1/dist/face-api.js';
const FACE_MODELS = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1/model/';
const JSQR_LIB = 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const _scripts = {};
function loadScript(src) {
  if (!_scripts[src]) {
    _scripts[src] = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src; s.async = true; s.crossOrigin = 'anonymous';
      s.onload = res;
      s.onerror = () => { delete _scripts[src]; rej(new Error('Could not load ' + src.split('/').pop() + ' — internet is needed the first time')); };
      document.head.appendChild(s);
    });
  }
  return _scripts[src];
}

/* ------------------------------------------------------------- camera */

const cam = { stream: null, facing: LS.get('sa_cam_facing', 'user'), stop: false, run: 0 };
/** Each kiosk window gets a new run number; loops from an older window stop by themselves. */
function newRun() { cam.stop = false; return ++cam.run; }
const alive = (run) => !cam.stop && run === cam.run;

async function camStart(video) {
  camStop();
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('Camera not available in this browser');
  cam.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: cam.facing, width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
  video.srcObject = cam.stream;
  video.setAttribute('playsinline', ''); video.muted = true;
  video.classList.toggle('mirror', cam.facing === 'user');
  await video.play();
}
function camStop() { if (cam.stream) cam.stream.getTracks().forEach((t) => t.stop()); cam.stream = null; }

function snapPhoto(video, w = 320) {
  if (!video.videoWidth) return '';
  const c = document.createElement('canvas');
  c.width = w; c.height = Math.round(video.videoHeight * w / video.videoWidth);
  c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.7);
}

/* ------------------------------------------------------------- QR scan */

let _detector; // undefined = not tried, null = use jsQR
async function qrDetector() {
  if (_detector !== undefined) return _detector;
  let det = null;
  if ('BarcodeDetector' in window) {
    try { if ((await BarcodeDetector.getSupportedFormats()).includes('qr_code')) det = new BarcodeDetector({ formats: ['qr_code'] }); } catch (e) {}
  }
  if (!det) await loadScript(JSQR_LIB); // throws if offline the first time; we try again next time
  _detector = det;
  return det;
}

const _qrCanvas = document.createElement('canvas');
async function detectQrOnce(video, det) {
  if (video.readyState < 2 || !video.videoWidth) return null;
  try {
    if (det) { const r = await det.detect(video); return r.length ? r[0].rawValue : null; }
    const c = _qrCanvas, ctx = c.getContext('2d', { willReadFrequently: true });
    c.width = video.videoWidth; c.height = video.videoHeight;
    ctx.drawImage(video, 0, 0);
    const img = ctx.getImageData(0, 0, c.width, c.height);
    const r = window.jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
    return r && r.data ? r.data : null;
  } catch (e) { return null; }
}

/* ------------------------------------------------------------- NFC */

const nfc = { on: false, inbox: [], last: {} };
const nfcSupported = () => 'NDEFReader' in window;
const normUid = (s) => String(s || '').replace(/[^0-9a-f]/gi, '').toUpperCase();

/** Start listening for NFC cards. Must be called from a tap (button click). Android Chrome only. */
async function nfcStart() {
  if (nfc.on) return true;
  if (!nfcSupported()) return false;
  try {
    const reader = new NDEFReader();
    reader.onreading = (e) => {
      const uid = normUid(e.serialNumber);
      const now = Date.now();
      if (!uid || (nfc.last[uid] && now - nfc.last[uid] < 3000)) return; // ignore a card held on the phone
      nfc.last[uid] = now;
      nfc.inbox.push(uid);
      try { navigator.vibrate && navigator.vibrate(60); } catch (x) {}
    };
    reader.onreadingerror = () => toast('Card could not be read — use NTAG213/215 cards, hold it still', 'err');
    await reader.scan();
    nfc.on = true;
    return true;
  } catch (e) {
    toast('NFC: ' + (e.name === 'NotAllowedError' ? 'permission refused' : e.message), 'err');
    return false;
  }
}

/** Wait for a QR card in front of the camera OR an NFC card tapped on the phone. */
async function waitForCard(video, opts = {}) {
  const run = cam.run;
  nfc.inbox.length = 0;
  let det = null, qrOk = opts.qr !== false;
  if (qrOk) {
    try { det = await qrDetector(); } catch (e) { qrOk = false; if (!nfc.on) throw e; }
  }
  while (alive(run)) {
    if (nfc.inbox.length) return { nfc: nfc.inbox.shift() };
    if (qrOk) { const q = await detectQrOnce(video, det); if (q) return { qr: q }; }
    await sleep(150);
  }
  throw new Error('cancelled');
}

/* ------------------------------------------------------------- face */

let _face = null;
function loadFace() {
  if (!_face) {
    _face = (async () => {
      await loadScript(FACE_LIB);
      const f = window.faceapi;
      if (!f) throw new Error('Face library did not load');
      if (f.tf && f.tf.ready) await f.tf.ready();
      await f.nets.tinyFaceDetector.loadFromUri(FACE_MODELS);
      await f.nets.faceLandmark68Net.loadFromUri(FACE_MODELS);
      await f.nets.faceRecognitionNet.loadFromUri(FACE_MODELS);
      return f;
    })().catch((e) => { _face = null; throw e; });
  }
  return _face;
}

/** Returns a 128-number face template from the live camera. */
async function readFace(video, seconds = 8) {
  const f = await loadFace();
  const opt = new f.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 });
  const until = Date.now() + seconds * 1000, run = cam.run;
  while (alive(run) && Date.now() < until) {
    const r = await f.detectSingleFace(video, opt).withFaceLandmarks().withFaceDescriptor();
    if (r && r.detection.score > 0.6 && r.detection.box.width > video.videoWidth * 0.18) {
      return Array.from(r.descriptor).map((v) => Math.round(v * 1e5) / 1e5);
    }
    await sleep(150);
  }
  throw new Error(cam.stop ? 'cancelled' : 'No clear face — look straight at the camera in good light');
}

/* ------------------------------------------------------------- liveness (blink / head turn) */

const LIVENESS_ON = !(window.APP_CONFIG && window.APP_CONFIG.LIVENESS === false);

// Eye aspect ratio: ~0.3 open, < 0.2 closed. 68-point landmarks: eyes are 36–41 and 42–47.
function eyeRatio(p, i) {
  const d = (a, b) => Math.hypot(p[a].x - p[b].x, p[a].y - p[b].y);
  return (d(i + 1, i + 5) + d(i + 2, i + 4)) / (2 * d(i, i + 3));
}

/** One cheap frame: eye openness and head yaw (0.5 = looking straight). */
async function faceFrame(video) {
  const f = await loadFace();
  const r = await f.detectSingleFace(video, new f.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.4 })).withFaceLandmarks();
  if (!r) return null;
  const p = r.landmarks.positions;
  return { ear: (eyeRatio(p, 36) + eyeRatio(p, 42)) / 2, yaw: (p[30].x - p[36].x) / ((p[45].x - p[36].x) || 1) };
}

/** Runs one challenge. kind: 'blink' | 'turn'. Resolves true when the live action is seen. */
async function livenessCheck(video, kind, seconds = 7) {
  const until = Date.now() + seconds * 1000, run = cam.run;
  const open = [];
  let phase = 0, base = 0;
  while (alive(run) && Date.now() < until) {
    const fr = await faceFrame(video);
    if (fr) {
      if (kind === 'blink') {
        if (phase === 0) { open.push(fr.ear); if (open.length >= 3) { base = open.slice(-3).sort()[1]; phase = 1; } }
        else if (phase === 1) { if (fr.ear < base * 0.7) phase = 2; else base = Math.max(base * 0.9, Math.min(fr.ear, base * 1.1)); }
        else if (phase === 2 && fr.ear > base * 0.85) return true;
      } else {
        const off = Math.abs(fr.yaw - 0.5);
        if (phase === 0 && off < 0.1) phase = 1;
        else if (phase === 1 && off > 0.17) phase = 2;
        else if (phase === 2 && off < 0.1) return true;
      }
    }
    await sleep(30);
  }
  return false;
}

const LIVE_TEXT = {
  blink: 'Close your eyes for a moment, then open them 😌',
  turn: 'Turn your head to one side, then look back ↔',
};

/** Face + liveness: template → random challenge → template again (must be the same face). */
async function verifyLiveFace(video, sayMsg) {
  const d1 = await readFace(video);
  if (!LIVENESS_ON) return { descriptor: d1, liveness: '' };
  const order = Math.random() < 0.5 ? ['blink', 'turn'] : ['turn', 'blink'];
  for (const kind of order) {
    sayMsg(LIVE_TEXT[kind]);
    if (await livenessCheck(video, kind)) {
      sayMsg('Good — hold still');
      const d2 = await readFace(video, 4);
      const dist = Math.sqrt(d1.reduce((s, v, i) => s + (v - d2[i]) ** 2, 0));
      if (dist > 0.45) throw new Error('Face changed during the check');
      return { descriptor: d2, liveness: kind };
    }
    if (cam.stop) throw new Error('cancelled');
  }
  throw new Error('Blink / head-turn not seen');
}

/* ------------------------------------------------------------- modal UI */

function camModal(title, extraButtons = '') {
  newRun();
  openModal(`<h2 id="ckTitle">${esc(title)}</h2>
    <p class="muted" id="ckMsg"></p>
    <div class="cam"><video id="ckVideo"></video><div class="cam-frame" id="ckFrame"></div><div class="cam-result hidden" id="ckResult"></div></div>
    <div id="ckExtra"></div>
    <div class="form row">${extraButtons}<button class="btn" id="ckFlip">Switch camera</button><button class="btn danger" id="ckClose">Close</button></div>`);
  const video = $('#ckVideo');
  $('#ckClose').onclick = () => { cam.stop = true; camStop(); closeModal(); };
  $('#ckFlip').onclick = async () => {
    cam.facing = cam.facing === 'user' ? 'environment' : 'user'; LS.set('sa_cam_facing', cam.facing);
    try { await camStart(video); } catch (e) { toast(e.message, 'err'); }
  };
  return video;
}
// All screen updates are null-safe: the loop may still be finishing after the window was closed.
const ckSay = (title, msg, frame) => {
  if (cam.stop && !$('#ckTitle')) return;
  if (title != null && $('#ckTitle')) $('#ckTitle').textContent = title;
  if (msg != null && $('#ckMsg')) $('#ckMsg').textContent = msg;
  if (frame && $('#ckFrame')) $('#ckFrame').className = 'cam-frame ' + frame;
};
function ckResult(ok, text) {
  const r = $('#ckResult');
  if (!r) return;
  r.className = 'cam-result ' + (ok ? 'ok' : 'bad');
  r.innerHTML = `<div class="big-ico">${ok ? '✓' : '✕'}</div><div>${esc(text)}</div>`;
  try { navigator.vibrate && navigator.vibrate(ok ? [80, 60, 200] : [400]); } catch (e) {}
}
const ckClearResult = () => { const r = $('#ckResult'); if (r) r.classList.add('hidden'); };

/** Wait for a PIN typed on the kiosk (fallback when face can't be used). */
function askPin(name) {
  return new Promise((resolve, reject) => {
    $('#ckExtra').innerHTML = `<form id="ckPinForm" class="form row"><input name="pin" type="password" inputmode="numeric" placeholder="PIN for ${esc(name)}" required autofocus>
      <button class="btn primary">OK</button><button type="button" class="btn" id="ckPinSkip">Skip</button></form>`;
    $('#ckPinForm').onsubmit = (e) => { e.preventDefault(); const v = e.target.pin.value; $('#ckExtra').innerHTML = ''; resolve(v); };
    $('#ckPinSkip').onclick = () => { $('#ckExtra').innerHTML = ''; reject(new Error('skipped')); };
  });
}

/* --------------------------------------------- kiosk: card → face → mark */

async function startCardKiosk() {
  const sessionId = $('#cSession').value;
  if (!sessionId) return toast('Choose a session first', 'err');
  const sess = state.cfg.sessions.find((s) => s.sessionId === sessionId) || {};
  const nfcOn = await nfcStart(); // needs this button tap; silently skipped on phones without NFC
  const cardHint = nfcOn ? 'Tap your NFC card on the back of this phone, or show your QR card' : 'Hold your QR card inside the box';
  const video = camModal('Show or tap your card');
  const run = cam.run;
  try { await camStart(video); } catch (e) { ckSay('Camera blocked', e.message); return; }
  loadFace().catch(() => {}); // warm up in the background

  while (alive(run)) {
    ckClearResult();
    ckSay(nfcOn ? 'Tap or show your card' : 'Show your QR card', `${sess.title || ''} · ${cardHint}`, 'qr');
    let card;
    try { card = await waitForCard(video); } catch (e) { if (e.message !== 'cancelled') ckSay('Scanner problem', e.message); break; }
    if (card.qr && !card.qr.startsWith('SA1.')) { ckResult(false, 'Not an attendance card'); await sleep(1800); continue; }

    // who is it? (online) — tells us whether a face is enrolled
    let who = { name: card.qr ? card.qr.split('.')[1] : 'NFC card', hasFace: true }, online = navigator.onLine;
    if (online) {
      try { who = await api('resolveCard', card); }
      catch (e) { if (!e.network) { ckResult(false, e.message); await sleep(2500); continue; } online = false; }
    }

    const rec = Object.assign({ sessionId, clientTime: new Date().toISOString() }, card);
    if (state.pos) Object.assign(rec, { lat: state.pos.coords.latitude, lng: state.pos.coords.longitude, accuracy: state.pos.coords.accuracy });

    if (who.hasFace) {
      ckSay('Hello ' + who.name, 'Look at the camera', 'face');
      try { Object.assign(rec, await verifyLiveFace(video, (m) => ckSay(null, m))); }
      catch (e) {
        if (!alive(run)) break;
        ckSay(null, e.message + ' — type PIN instead');
      }
    } else {
      ckSay('Hello ' + who.name, 'No face enrolled yet — type your PIN', 'face');
    }
    rec.photo = snapPhoto(video);
    if (!rec.descriptor) {
      try { rec.pin = await askPin(who.name); } catch (e) { continue; }
    }

    try {
      if (!online) throw Object.assign(new Error('offline'), { network: true });
      const r = await api('kioskCardMark', rec);
      ckResult(true, `${r.name || who.name}: ${r.already ? 'already marked' : r.status} ${r.time || ''}`);
      kioskLog(`${r.name || who.name} — ${r.already ? 'already marked' : r.status} ${r.time || ''} (${card.nfc ? 'NFC' : 'QR'} + ${rec.descriptor ? 'face/' + rec.liveness : 'PIN'})`, true);
    } catch (e) {
      if (e.network) {
        queueRecord('kioskCardMark', rec);
        ckResult(true, `${who.name}: saved offline — will sync`);
        kioskLog(`${who.name} — saved offline`, true);
      } else {
        ckResult(false, e.message);
        kioskLog(`${who.name} — ${e.message}`, false);
      }
    }
    await sleep(2200);
  }
  if (run === cam.run) camStop();
}

function kioskLog(text, ok) {
  $('#kioskLog').insertAdjacentHTML('afterbegin', `<div class="item"><span>${esc(text)}</span><span class="pill ${ok ? 'ok' : 'bad'}">${ok ? '✓' : '✕'}</span></div>`);
}

/* --------------------------------------------- enrol face (one time) */

async function startEnrol() {
  if (!navigator.onLine) return toast('Face enrolment needs internet', 'err');
  await nfcStart();
  const video = camModal('Enrol a face', '<button class="btn" id="ckTypeId">Type ID instead</button>');
  let typedId = null;
  $('#ckTypeId').onclick = () => {
    const id = prompt('ID of the person'); if (id) { typedId = id.trim(); cam.stop = true; }
  };
  try { await camStart(video); } catch (e) { ckSay('Camera blocked', e.message); return; }
  ckSay('Enrol a face', 'Loading face recognition…');
  try { await loadFace(); } catch (e) { ckSay('Face recognition unavailable', e.message); return; }

  ckSay('Scan the person\'s card', (nfc.on ? 'Show the QR card or tap the NFC card' : 'Show the QR card') + ' — or tap “Type ID instead”', 'qr');
  let card = null;
  try { card = await waitForCard(video); } catch (e) { if (!typedId) { camStop(); return; } }
  cam.stop = false;
  const target = card || { userId: typedId };
  const run = cam.run;

  let name = typedId;
  if (card) { try { name = (await api('resolveCard', card)).name; } catch (e) { ckResult(false, e.message); return; } }

  const samples = [];
  for (let i = 1; i <= 3 && alive(run); i++) {
    ckSay('Enrolling ' + name, `Look at the camera — photo ${i} of 3. Turn your head slightly between photos.`, 'face');
    try { samples.push(await readFace(video, 10)); } catch (e) { ckResult(false, e.message); return; }
    await sleep(700);
  }
  if (samples.length < 3) return;
  const avg = samples[0].map((_, k) => Math.round(((samples[0][k] + samples[1][k] + samples[2][k]) / 3) * 1e5) / 1e5);
  try {
    const r = await api('enrollFace', Object.assign({ descriptor: avg, photo: snapPhoto(video) }, target));
    ckResult(true, `Face enrolled for ${r.name}`);
    kioskLog(`Face enrolled — ${r.name}`, true);
  } catch (e) { ckResult(false, e.message); }
}

/* --------------------------------------------- link NFC cards (bulk) */

async function startLinkNfc() {
  if (!nfcSupported()) return toast('This phone/browser has no Web NFC. Use Chrome on an Android phone with NFC turned on.', 'err');
  if (!navigator.onLine) return toast('Linking cards needs internet', 'err');
  if (!(await nfcStart())) return;
  const run = newRun();
  openModal(`<h2>Link NFC cards</h2>
    <p class="muted small">Type the person's ID, then tap a blank card on the back of this phone. Repeat for the next person.</p>
    <form id="lnForm" class="form row"><input name="id" placeholder="Person ID" autocapitalize="characters" required><button class="btn primary">Next</button></form>
    <div id="lnMsg" class="alert info">Type an ID to start</div>
    <div id="lnLog" class="list"></div>
    <button class="btn danger wide" id="lnClose">Close</button>`);
  $('#lnClose').onclick = () => { cam.stop = true; closeModal(); };
  const form = $('#lnForm');
  form.id.focus();
  form.onsubmit = async (e) => {
    e.preventDefault();
    const id = form.id.value.trim(); if (!id) return;
    form.querySelector('button').disabled = true;
    $('#lnMsg').textContent = `Now tap the card for ${id} on the back of the phone…`;
    nfc.inbox.length = 0;
    const until = Date.now() + 30000;
    while (alive(run) && !nfc.inbox.length && Date.now() < until) await sleep(150);
    const uid = nfc.inbox.shift();
    form.querySelector('button').disabled = false;
    if (!uid) { $('#lnMsg').textContent = 'No card tapped — try again'; return; }
    const link = async (force) => api('enrollNfc', { userId: id, nfc: uid, force });
    try {
      let r;
      try { r = await link(false); }
      catch (err) {
        if (/already belongs/.test(err.message) && confirm(err.message + '. Move it to ' + id + '?')) r = await link(true); else throw err;
      }
      $('#lnMsg').textContent = `✓ Card linked to ${r.name}. Type the next ID.`;
      $('#lnLog').insertAdjacentHTML('afterbegin', `<div class="item"><span>${esc(r.name)} (${esc(r.id)})</span><span class="pill ok">${esc(uid.slice(-6))}</span></div>`);
      form.reset(); form.id.focus();
    } catch (err) { $('#lnMsg').textContent = '✕ ' + err.message; }
  };
}

/* --------------------------------------------- printable ID cards */

async function printCards() {
  const group = prompt('Print cards for which group? (e.g. Class 8A, Office, or ALL)', 'ALL');
  if (group == null) return;
  const w = window.open('', '_blank'); // open now so pop-up blockers allow it
  if (!w) return toast('Allow pop-ups to print cards', 'err');
  w.document.write('<p style="font:16px sans-serif;padding:20px">Preparing cards…</p>');
  try {
    const { cards } = await api('cards', { group });
    const org = esc((window.APP_CONFIG && (window.APP_CONFIG.ORG_NAME || window.APP_CONFIG.APP_NAME)) || 'Smart Attendance');
    const html = cards.map((c) => `<div class="card"><div class="qr">${QR.svg(c.qr)}</div>
      <div class="info"><div class="org">${org}</div><div class="name">${esc(c.name)}</div>
      <div class="id">ID: ${esc(c.id)}</div><div class="grp">${esc(c.group || '')} · ${esc(c.role)}</div>
      <div class="note">Attendance card — keep it safe</div></div></div>`).join('');
    w.document.open();
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>ID cards — ${esc(group)}</title><style>
      @page{size:A4;margin:10mm}body{font-family:system-ui,Arial,sans-serif;margin:0}
      .bar{padding:10px;background:#0f766e;color:#fff;display:flex;gap:10px;align-items:center}.bar button{font-size:16px;padding:6px 14px}
      .grid{display:grid;grid-template-columns:repeat(2,85.6mm);gap:6mm;padding:6mm}
      .card{width:85.6mm;height:54mm;border:1px solid #999;border-radius:3mm;display:flex;gap:3mm;padding:3mm;box-sizing:border-box;break-inside:avoid;overflow:hidden}
      .qr{width:46mm;height:46mm;flex:none}.qr svg{width:100%;height:100%}
      .info{display:flex;flex-direction:column;gap:1.2mm;min-width:0}.org{font-size:8pt;font-weight:700;color:#0f766e;text-transform:uppercase}
      .name{font-size:12pt;font-weight:700;line-height:1.15}.id{font-size:10pt}.grp{font-size:8.5pt;color:#444}.note{margin-top:auto;font-size:7pt;color:#777}
      @media print{.bar{display:none}}</style></head><body>
      <div class="bar"><b>${cards.length} cards · ${esc(group)}</b><button onclick="print()">Print</button></div>
      <div class="grid">${html || '<p>No people in this group.</p>'}</div></body></html>`);
    w.document.close();
  } catch (e) { w.close(); toast(e.message, 'err'); }
}

/* --------------------------------------------- wiring */

$('#btnCardKiosk').addEventListener('click', startCardKiosk);
$('#btnEnrol').addEventListener('click', startEnrol);
$('#btnPrintCards').addEventListener('click', printCards);
$('#btnLinkNfc').addEventListener('click', startLinkNfc);
$('#revokeForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!confirm('Cancel the old card? It will stop working and a new card must be printed.')) return;
  try { await api('revokeCard', { userId: e.target.userId.value.trim() }); toast('Old card cancelled — print a new one', 'ok'); e.target.reset(); }
  catch (err) { toast(err.message, 'err'); }
});
// Stop the camera if the modal is closed by tapping outside it.
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') { cam.stop = true; camStop(); } });
