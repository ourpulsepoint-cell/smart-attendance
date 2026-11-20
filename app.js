/* Smart Attendance — client (PWA). No build step needed. */
'use strict';

const API_URL = (window.APP_CONFIG || {}).API_URL || '';
const API_READY = /^https:\/\/script\.google(usercontent)?\.com\//.test(API_URL);
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DEFAULT_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu'];

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  del(k) { try { localStorage.removeItem(k); } catch (e) {} },
};

const state = {
  token: LS.get('sa_token', null),
  user: LS.get('sa_user', null),
  cfg: LS.get('sa_cfg', null),
  queue: LS.get('sa_queue', []),
  pos: null, posErr: null, watchId: null,
  marked: {}, armed: null, busy: false,
  motionOn: false, motionSeen: false,
  maps: {}, tab: 'tToday', syncing: false,
};

/* ------------------------------------------------------------------ utils */

function deviceId() {
  let d = LS.get('sa_device');
  if (!d) {
    d = (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
    LS.set('sa_device', d);
  }
  return d;
}

function toast(msg, kind = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast ' + kind;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), kind === 'err' ? 6000 : 3500);
}

function tzNow(tz, d = new Date()) {
  const p = {};
  new Intl.DateTimeFormat('en-GB', {
    timeZone: tz || undefined, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23',
  }).formatToParts(d).forEach((x) => { p[x.type] = x.value; });
  return { date: `${p.year}-${p.month}-${p.day}`, dow: p.weekday, min: (+p.hour % 24) * 60 + (+p.minute), hhmm: `${p.hour}:${p.minute}` };
}
const toMin = (s) => { const [h, m] = String(s || '0:0').split(':'); return (parseInt(h, 10) || 0) * 60 + (parseInt(m, 10) || 0); };
const minStr = (m) => `${String(Math.floor(Math.max(0, m) / 60)).padStart(2, '0')}:${String(Math.max(0, m) % 60).padStart(2, '0')}`;
function dayMatch(days, dow) {
  days = String(days || '').trim();
  if (!days || /^(daily|all|\*)$/i.test(days)) return true;
  return days.split(/[,\s]+/).some((d) => d.slice(0, 3).toLowerCase() === String(dow).slice(0, 3).toLowerCase());
}
function groupMatch(g, ug) {
  g = String(g || '').trim();
  if (!g || /^(all|\*)$/i.test(g) || /^(all|\*)$/i.test(String(ug || '').trim())) return true;
  return g.split(',').some((x) => x.trim().toLowerCase() === String(ug || '').trim().toLowerCase());
}
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
const isManager = () => state.user && ['teacher', 'admin'].includes(state.user.role);

/* -------------------------------------------------------------------- API */

async function api(action, data = {}) {
  if (!API_READY) throw new Error('API_URL is not set in config.js');
  let res;
  try {
    // text/plain body = "simple" request, so no CORS preflight against Apps Script
    res = await fetch(API_URL, { method: 'POST', body: JSON.stringify(Object.assign({ action, token: state.token }, data)) });
  } catch (e) {
    const err = new Error('No internet connection'); err.network = true; throw err;
  }
  let j;
  try { j = await res.json(); } catch (e) {
    const err = new Error('Server did not answer properly (' + res.status + ')'); err.network = res.status >= 500 || res.status === 0; throw err;
  }
  if (!j.ok) {
    const err = new Error(j.error || 'Request failed');
    if (/log in again/i.test(err.message)) { logout(true); }
    throw err;
  }
  return j;
}

/* ------------------------------------------------------------- auth/boot */

async function login(id, pin) {
  const j = await api('login', { id: id.trim(), pin: pin.trim() });
  state.token = j.token; state.user = j.user;
  LS.set('sa_token', j.token); LS.set('sa_user', j.user);
  await refreshConfig();
  showApp();
}

function logout(expired) {
  ['sa_token', 'sa_user', 'sa_cfg'].forEach(LS.del);
  state.token = null; state.user = null; state.cfg = null; state.marked = {};
  if (expired) toast('Please sign in again', 'err');
  showLogin();
}

async function refreshConfig() {
  try {
    const j = await api('config');
    state.cfg = j; state.user = j.user;
    LS.set('sa_cfg', j); LS.set('sa_user', j.user);
    const fromServer = {};
    (j.today || []).forEach((a) => { fromServer[a.sessionId] = { status: a.status, time: a.time }; });
    // keep pending (queued) marks, replace the rest with the server truth for today
    Object.keys(state.marked).forEach((k) => { if (state.marked[k].pending) fromServer[k] = fromServer[k] || state.marked[k]; });
    state.marked = fromServer;
    LS.set('sa_marked', { date: tzNow(j.tz).date, marked: state.marked });
  } catch (e) {
    if (!e.network) toast(e.message, 'err');
  }
  renderAll();
}

function loadLocalMarks() {
  const m = LS.get('sa_marked', null);
  const today = tzNow(state.cfg && state.cfg.tz).date;
  state.marked = (m && m.date === today) ? m.marked : {};
  if (state.cfg && state.cfg.today) state.cfg.today.forEach((a) => { if (!state.marked[a.sessionId]) state.marked[a.sessionId] = a; });
}

function saveLocalMarks() {
  LS.set('sa_marked', { date: tzNow(state.cfg && state.cfg.tz).date, marked: state.marked });
}

function showLogin() {
  $('#vLogin').classList.remove('hidden');
  $('#vApp').classList.add('hidden');
  $('#tabs').classList.add('hidden');
  $('#cfgWarn').classList.toggle('hidden', API_READY);
}

function showApp() {
  $('#vLogin').classList.add('hidden');
  $('#vApp').classList.remove('hidden');
  $('#tabs').classList.remove('hidden');
  $$('.mgr').forEach((b) => b.classList.toggle('hidden', !isManager()));
  $$('.adm-only').forEach((b) => b.classList.toggle('hidden', !(state.user && state.user.role === 'admin')));
  loadLocalMarks();
  startGeo();
  autoSensors();
  renderAll();
  switchTab(state.tab);
}

/* ------------------------------------------------------------- location */

function startGeo() {
  if (!('geolocation' in navigator)) { state.posErr = 'This phone has no GPS support'; return; }
  if (state.watchId != null) return;
  state.watchId = navigator.geolocation.watchPosition(
    (p) => { state.pos = p; state.posErr = null; evaluate(); updateMapMe(); },
    (e) => { state.posErr = e.code === 1 ? 'Location permission denied — allow it in browser settings' : 'Waiting for GPS…'; evaluate(); },
    { enableHighAccuracy: true, maximumAge: 10000, timeout: 30000 },
  );
}

function siteOf(s) { return state.cfg && state.cfg.sites.find((x) => x.siteId === s.siteId); }

function geoCheck(s) {
  const site = siteOf(s);
  if (!site || !state.pos) return { inside: false, dist: null, site };
  const c = state.pos.coords;
  const r = state.cfg.rules;
  const dist = haversine(c.latitude, c.longitude, site.lat, site.lng);
  const weak = c.accuracy > r.maxAccuracy;
  return { inside: !weak && dist <= site.radius + Math.min(c.accuracy, r.tolerance), dist, acc: c.accuracy, weak, site };
}

/* ---------------------------------------------------------- session state */

function todaysSessions() {
  if (!state.cfg || !state.user) return [];
  const t = tzNow(state.cfg.tz);
  return state.cfg.sessions
    .filter((s) => s.active && groupMatch(s.group, state.user.group) && dayMatch(s.days, t.dow))
    .sort((a, b) => toMin(a.start) - toMin(b.start));
}

function windowState(s) {
  const t = tzNow(state.cfg.tz);
  const st = toMin(s.start), en = toMin(s.end), ob = state.cfg.rules.openBeforeMin;
  if (t.min < st - ob) return { k: 'upcoming', opens: minStr(st - ob) };
  if (t.min > en) return { k: 'closed' };
  return { k: 'open', late: t.min > st + (s.graceMin || 0) };
}

function evaluate() {
  if (!state.cfg || !state.user) return;
  const list = todaysSessions();
  let armed = null;
  list.forEach((s) => {
    const w = windowState(s);
    const g = geoCheck(s);
    if (w.k === 'open' && g.inside && !state.marked[s.sessionId] && !armed) armed = s;
  });
  if (armed && (!state.armed || state.armed.sessionId !== armed.sessionId)) maybeNotify(armed);
  state.armed = armed;
  renderToday();
}

function maybeNotify(s) {
  const date = tzNow(state.cfg.tz).date;
  const n = LS.get('sa_notified', {});
  const key = date + '|' + s.sessionId;
  if (n[key]) return;
  n[key] = 1;
  Object.keys(n).forEach((k) => { if (!k.startsWith(date)) delete n[k]; });
  LS.set('sa_notified', n);
  notify('You are at ' + (siteOf(s) || {}).name, 'Shake your phone to mark attendance for ' + s.title, 'att-' + s.sessionId);
}

async function notify(title, body, tag) {
  try { if (navigator.vibrate) navigator.vibrate([250, 120, 250]); } catch (e) {}
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const reg = navigator.serviceWorker && await navigator.serviceWorker.getRegistration();
    if (reg) { await reg.showNotification(title, { body, tag, icon: 'icon-192.png', badge: 'icon-192.png', renotify: true, requireInteraction: true, vibrate: [250, 120, 250] }); return; }
    new Notification(title, { body, tag }); // desktop fallback
  } catch (e) {}
}

/* ------------------------------------------------------------------ shake */

const shake = { last: null, hits: [], cooldown: 0 };

function onMotion(e) {
  const a = e.accelerationIncludingGravity || e.acceleration;
  if (!a || a.x == null) return;
  if (!state.motionSeen) { state.motionSeen = true; renderSensorUi(); }
  const now = Date.now();
  if (shake.last) {
    const d = Math.abs(a.x - shake.last.x) + Math.abs(a.y - shake.last.y) + Math.abs(a.z - shake.last.z);
    if (d > 22) {
      shake.hits = shake.hits.filter((t) => now - t < 1300);
      if (!shake.hits.length || now - shake.hits[shake.hits.length - 1] > 110) shake.hits.push(now);
      if (shake.hits.length >= 3 && now > shake.cooldown) {
        shake.hits = []; shake.cooldown = now + 3000;
        onShake();
      }
    }
  }
  shake.last = { x: a.x, y: a.y, z: a.z };
}

function onShake() {
  const pill = $('#shakeTest');
  if (pill) { pill.textContent = 'shake detected ✓'; pill.classList.add('ok'); setTimeout(() => { pill.textContent = 'waiting'; pill.classList.remove('ok'); }, 2500); }
  if (state.armed && !state.busy) doMark(state.armed);
  else if (state.tab === 'tToday') toast(state.armed ? 'Working…' : 'Nothing to mark right now');
}

const motionNeedsTap = () => typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function';

function attachMotion() {
  if (state.motionOn) return;
  window.addEventListener('devicemotion', onMotion);
  state.motionOn = true;
  setTimeout(() => { if (!state.motionSeen) renderToday(); }, 3000);
}

function autoSensors() {
  // Android/Chrome usually sends motion data straight away; iPhone needs a tap first (banner).
  if (typeof DeviceMotionEvent !== 'undefined') attachMotion();
  renderSensorUi();
}

async function enableSensors() {
  try {
    if (motionNeedsTap()) {
      const r = await DeviceMotionEvent.requestPermission();
      if (r !== 'granted') throw new Error('Motion permission was refused');
    }
    attachMotion();
    if ('Notification' in window && Notification.permission === 'default') await Notification.requestPermission();
    startGeo();
    LS.set('sa_sensors', true);
    toast('Alerts and shake are on', 'ok');
  } catch (e) { toast(e.message, 'err'); }
  renderSensorUi();
}

function renderSensorUi() {
  const notif = !('Notification' in window) ? 'not supported' : Notification.permission;
  const needs = (motionNeedsTap() && !state.motionSeen) || notif === 'default';
  $('#sensorBanner').classList.toggle('hidden', !needs);
  const ss = $('#sensorState');
  if (ss) ss.textContent = `Motion: ${state.motionOn ? 'on' : 'off'} · Notifications: ${notif} · GPS: ${state.pos ? 'on' : (state.posErr || 'starting')}`;
}

/* ------------------------------------------------------------- biometric */

const b64u = {
  enc(buf) { return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); },
  dec(s) { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return Uint8Array.from(atob(s), (c) => c.charCodeAt(0)); },
};
const credKey = () => 'sa_cred_' + (state.user && state.user.id);

async function bioSupported() {
  try { return !!(window.PublicKeyCredential && await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()); }
  catch (e) { return false; }
}

async function bioRegister() {
  if (!(await bioSupported())) throw new Error('This phone has no fingerprint/face unlock usable by the browser');
  const u = state.user;
  const cred = await navigator.credentials.create({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp: { name: 'Smart Attendance' },
      user: { id: new TextEncoder().encode(u.id), name: u.id, displayName: u.name },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'discouraged' },
      attestation: 'none', timeout: 60000,
    },
  });
  const id = b64u.enc(cred.rawId);
  await api('bindCredential', { credentialId: id, deviceId: deviceId() });
  LS.set(credKey(), id);
  state.user.hasBiometric = true;
}

async function bioVerify() {
  const id = LS.get(credKey());
  if (!id) return { biometric: false };
  await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      allowCredentials: [{ type: 'public-key', id: b64u.dec(id), transports: ['internal'] }],
      userVerification: 'required', timeout: 60000,
    },
  });
  return { biometric: true, credentialId: id };
}

/* ------------------------------------------------------------------ marking */

async function doMark(s, bio) {
  if (state.busy) return;
  state.busy = true; renderToday();
  try {
    const g = geoCheck(s);
    if (!g.inside) throw new Error('Move inside the geofence first');
    if (bio === undefined && LS.get(credKey())) {
      try { bio = await bioVerify(); }
      catch (e) { state.busy = false; askBioTap(s); return; } // e.g. iPhone needs a tap first
    }
    const c = state.pos.coords;
    const rec = Object.assign({
      sessionId: s.sessionId, lat: c.latitude, lng: c.longitude, accuracy: c.accuracy,
      clientTime: new Date().toISOString(), deviceId: deviceId(),
    }, bio || { biometric: false });
    await submitMark(rec, s);
  } catch (e) {
    toast(e.message, 'err');
  } finally {
    state.busy = false; evaluate();
  }
}

function askBioTap(s) {
  openModal(`<h2>Confirm it's you</h2><p class="muted">Shake detected for <b>${esc(s.title)}</b>. Tap and use your fingerprint / face.</p>
    <button class="btn primary big" id="bioGo">Verify fingerprint</button><button class="btn wide" id="bioCancel">Cancel</button>`);
  $('#bioGo').onclick = async () => {
    try { const bio = await bioVerify(); closeModal(); doMark(s, bio); }
    catch (e) { toast('Fingerprint not confirmed', 'err'); }
  };
  $('#bioCancel').onclick = closeModal;
}

async function submitMark(rec, s) {
  if (!navigator.onLine) { queueAdd(rec); return; }
  try {
    const r = await api('mark', rec);
    state.marked[s.sessionId] = { status: r.status, time: r.time };
    saveLocalMarks();
    celebrate(s, r.already ? 'Already marked' : (r.status === 'late' ? 'Marked — late' : 'Marked present'), r.time);
  } catch (e) {
    if (e.network) queueAdd(rec); else throw e;
  }
}

/** Save the offline queue; if phone storage is full, drop kiosk photos first. */
function saveQueue() {
  try { localStorage.setItem('sa_queue', JSON.stringify(state.queue)); }
  catch (e) {
    state.queue.forEach((r) => { if (r.photo) r.photo = ''; });
    LS.set('sa_queue', state.queue);
  }
}

/** Queue any API call for later (used by the kiosk too). */
function queueRecord(action, rec) {
  rec.offline = true; rec._action = action;
  state.queue.push(rec); saveQueue(); renderQueue();
}

function queueAdd(rec) {
  queueRecord('mark', rec);
  const t = tzNow(state.cfg.tz).hhmm;
  state.marked[rec.sessionId] = { status: 'saved offline', time: t, pending: true };
  saveLocalMarks();
  toast('No internet — saved on this phone. It will sync automatically.', 'ok');
  try { navigator.vibrate && navigator.vibrate(200); } catch (e) {}
  renderQueue();
}

async function syncQueue(manual) {
  if (state.syncing || !state.queue.length || !navigator.onLine || !state.token) { if (manual && !state.queue.length) toast('Nothing to sync'); return; }
  state.syncing = true;
  const failed = LS.get('sa_failed', []);
  try {
    while (state.queue.length) {
      const rec = state.queue[0];
      const action = rec._action || 'mark';
      const payload = Object.assign({}, rec); delete payload._action;
      try {
        const r = await api(action, payload);
        if (action === 'mark') state.marked[rec.sessionId] = { status: r.status, time: r.time };
      } catch (e) {
        if (e.network) break;
        failed.push({ rec: { action, sessionId: rec.sessionId, who: rec.qr ? rec.qr.split('.')[1] : (rec.nfc ? 'NFC ' + String(rec.nfc).slice(-6) : '') }, error: e.message, at: new Date().toISOString() });
        if (action === 'mark') delete state.marked[rec.sessionId];
        toast('An offline record was rejected: ' + e.message, 'err');
      }
      state.queue.shift(); saveQueue();
    }
  } finally {
    LS.set('sa_failed', failed.slice(-20));
    state.syncing = false; saveLocalMarks(); renderQueue(); evaluate();
  }
  if (manual && !state.queue.length) toast('All synced', 'ok');
}

function celebrate(s, msg, time) {
  try { navigator.vibrate && navigator.vibrate([80, 60, 80, 60, 200]); } catch (e) {}
  openModal(`<div class="done">✓</div><h2 class="center">${esc(msg)}</h2>
    <p class="center muted">${esc(s.title)} · ${esc(time || '')}</p><button class="btn primary big" id="okBtn">OK</button>`);
  $('#okBtn').onclick = closeModal;
  setTimeout(closeModal, 4000);
}

/* ------------------------------------------------------------------ render */

function renderAll() {
  renderNet(); renderQueue(); renderToday(); renderMe();
  if (isManager()) { renderManage(); renderKioskSelects(); }
}

function renderNet() {
  const b = $('#netBadge');
  b.textContent = navigator.onLine ? 'online' : 'offline';
  b.className = 'badge ' + (navigator.onLine ? 'ok' : 'err');
}

function renderQueue() {
  const n = state.queue.length;
  const qb = $('#queueBadge');
  qb.textContent = n + ' to sync'; qb.classList.toggle('hidden', !n);
  const qi = $('#queueInfo');
  if (qi) {
    const failed = LS.get('sa_failed', []);
    qi.innerHTML = (n ? `<b>${n}</b> record(s) waiting for internet.` : 'Nothing waiting.') +
      (failed.length ? `<br><span class="err-text">Last rejected${failed[failed.length - 1].rec.who ? ' (' + esc(failed[failed.length - 1].rec.who) + ')' : ''}: ${esc(failed[failed.length - 1].error)}</span>` : '');
  }
}

function renderToday() {
  if (!state.cfg || !state.user) return;
  renderSensorUi();
  const gl = $('#gpsLine');
  if (state.pos) {
    const a = Math.round(state.pos.coords.accuracy);
    gl.innerHTML = `<span class="pill ${a > state.cfg.rules.maxAccuracy ? 'bad' : 'ok'}">GPS ±${a} m</span>` +
      (state.motionOn ? (state.motionSeen ? ' <span class="pill ok">shake ready</span>' : ' <span class="pill">waiting for motion sensor</span>') : ' <span class="pill bad">shake off</span>');
  } else gl.innerHTML = `<span class="pill">${esc(state.posErr || 'Finding your location…')}</span>`;

  const list = todaysSessions();
  const box = $('#todayList');
  if (!list.length) box.innerHTML = '<div class="card muted center">No attendance scheduled for you today.</div>';
  else box.innerHTML = list.map((s) => {
    const w = windowState(s), g = geoCheck(s), m = state.marked[s.sessionId];
    let badge, cls;
    if (m) { badge = `✓ ${m.status} ${m.time || ''}`; cls = m.pending ? 'warn' : 'ok'; }
    else if (w.k === 'upcoming') { badge = 'opens ' + w.opens; cls = ''; }
    else if (w.k === 'closed') { badge = 'closed'; cls = 'bad'; }
    else if (g.inside) { badge = 'inside — shake now'; cls = 'go'; }
    else { badge = g.dist == null ? 'open' : `open · ${Math.round(g.dist)} m away`; cls = 'warn'; }
    return `<div class="item card-item"><div><b>${esc(s.title)}</b>
      <div class="muted small">${esc(s.start)}–${esc(s.end)} · ${esc((g.site || {}).name || '?')}</div></div>
      <span class="pill ${cls}">${esc(badge)}</span></div>`;
  }).join('');

  const ac = $('#armedCard');
  if (state.armed) {
    const s = state.armed, w = windowState(s);
    const noMotion = !state.motionOn || (state.motionOn && !state.motionSeen);
    ac.innerHTML = `<div class="armed ${state.busy ? 'busy' : ''}">
      <div class="phone">📳</div>
      <h2>${state.busy ? 'Marking…' : 'Shake your phone'}</h2>
      <p>${esc(s.title)} · you are inside ${esc((siteOf(s) || {}).name)}${w.late ? ' · <b>late</b>' : ''}</p>
      ${LS.get(credKey()) ? '<p class="small">Fingerprint will be checked</p>' : ''}
      ${noMotion ? '<button class="btn light" id="tapMark">Motion sensor not working? Tap here</button>' : ''}
    </div>`;
    const tb = $('#tapMark');
    if (tb) tb.onclick = () => doMark(s);
  } else ac.innerHTML = '';
  updateTodayMap();
}

/* ------------------------------------------------------------------ maps */

function tiles(map) {
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
}

function updateTodayMap() {
  if (!window.L || state.tab !== 'tToday') return;
  const el = $('#map');
  if (!state.maps.today) {
    state.maps.today = L.map(el, { zoomControl: true }).setView([23.8103, 90.4125], 12);
    tiles(state.maps.today);
    state.maps.todayLayer = L.layerGroup().addTo(state.maps.today);
  }
  const map = state.maps.today, layer = state.maps.todayLayer;
  layer.clearLayers();
  const bounds = [];
  const ids = new Set(todaysSessions().map((s) => s.siteId));
  state.cfg.sites.filter((x) => ids.has(x.siteId)).forEach((site) => {
    L.circle([site.lat, site.lng], { radius: site.radius, color: '#0f766e', fillOpacity: 0.15 }).bindTooltip(site.name).addTo(layer);
    bounds.push([site.lat, site.lng]);
  });
  updateMapMe();
  if (!state.maps.fitted && (bounds.length || state.pos)) {
    if (state.pos) bounds.push([state.pos.coords.latitude, state.pos.coords.longitude]);
    map.fitBounds(L.latLngBounds(bounds).pad(0.4), { maxZoom: 18 });
    state.maps.fitted = true;
  }
  setTimeout(() => map.invalidateSize(), 50);
}

function updateMapMe() {
  if (!window.L || !state.maps.today || !state.pos) return;
  const ll = [state.pos.coords.latitude, state.pos.coords.longitude];
  if (!state.maps.me) {
    state.maps.meAcc = L.circle(ll, { radius: state.pos.coords.accuracy, color: '#2563eb', weight: 1, fillOpacity: 0.08 }).addTo(state.maps.today);
    state.maps.me = L.circleMarker(ll, { radius: 7, color: '#fff', weight: 2, fillColor: '#2563eb', fillOpacity: 1 }).addTo(state.maps.today);
  } else {
    state.maps.me.setLatLng(ll); state.maps.meAcc.setLatLng(ll).setRadius(state.pos.coords.accuracy);
  }
}

function initSiteMap() {
  if (!window.L || state.maps.site) { if (state.maps.site) setTimeout(() => state.maps.site.invalidateSize(), 50); return; }
  const f = $('#siteForm');
  const map = L.map($('#siteMap')).setView(state.pos ? [state.pos.coords.latitude, state.pos.coords.longitude] : [23.8103, 90.4125], state.pos ? 17 : 12);
  tiles(map);
  state.maps.site = map;
  state.maps.siteLayer = L.layerGroup().addTo(map);
  const draw = () => {
    const lat = parseFloat(f.lat.value), lng = parseFloat(f.lng.value), r = parseFloat(f.radius.value) || 50;
    if (!isFinite(lat) || !isFinite(lng)) return;
    if (!state.maps.pick) state.maps.pick = L.circle([lat, lng], { radius: r, color: '#dc2626', fillOpacity: 0.2 }).addTo(map);
    else state.maps.pick.setLatLng([lat, lng]).setRadius(r);
  };
  map.on('click', (e) => { f.lat.value = e.latlng.lat.toFixed(6); f.lng.value = e.latlng.lng.toFixed(6); draw(); });
  ['lat', 'lng', 'radius'].forEach((n) => f[n].addEventListener('input', draw));
  state.maps.drawPick = draw;
  drawSites();
  setTimeout(() => map.invalidateSize(), 50);
}

function drawSites() {
  if (!state.maps.siteLayer) return;
  state.maps.siteLayer.clearLayers();
  state.cfg.sites.filter((s) => s.active).forEach((s) => {
    L.circle([s.lat, s.lng], { radius: s.radius, color: '#0f766e', fillOpacity: 0.1 }).bindTooltip(s.name).addTo(state.maps.siteLayer);
  });
}

/* ------------------------------------------------------------- manage UI */

function renderManage() {
  const cfg = state.cfg; if (!cfg) return;
  const siteName = (id) => (cfg.sites.find((s) => s.siteId === id) || {}).name || '?';
  $('#siteList').innerHTML = cfg.sites.length ? cfg.sites.map((s) => `
    <div class="item ${s.active ? '' : 'off'}"><div><b>${esc(s.name)}</b><div class="muted small">${esc(s.type)} · r ${s.radius} m · ${s.lat.toFixed(5)}, ${s.lng.toFixed(5)}</div></div>
    <button class="btn sm" data-site="${esc(s.siteId)}" data-on="${s.active ? 0 : 1}">${s.active ? 'Switch off' : 'Switch on'}</button></div>`).join('')
    : '<p class="muted small">No places yet.</p>';
  $('#sessSite').innerHTML = cfg.sites.filter((s) => s.active).map((s) => `<option value="${esc(s.siteId)}">${esc(s.name)}</option>`).join('');
  $('#groupList').innerHTML = ['ALL'].concat(cfg.groups || []).map((g) => `<option value="${esc(g)}">`).join('');
  $('#sessList').innerHTML = cfg.sessions.length ? cfg.sessions.map((s) => `
    <div class="item ${s.active ? '' : 'off'}"><div><b>${esc(s.title)}</b>
      <div class="muted small">${esc(s.start)}–${esc(s.end)} (+${s.graceMin}′) · ${esc(s.days)} · ${esc(s.group)} · ${esc(siteName(s.siteId))}</div></div>
      <div class="btns"><button class="btn sm" data-roster="${esc(s.sessionId)}">List</button>
      <button class="btn sm" data-sess="${esc(s.sessionId)}" data-on="${s.active ? 0 : 1}">${s.active ? 'Off' : 'On'}</button></div></div>`).join('')
    : '<p class="muted small">No attendance times yet.</p>';
  drawSites();
}

function renderDays() {
  $('#daysBox').innerHTML = '<span class="muted small">Days:</span> ' + DAYS.map((d) =>
    `<label class="chk"><input type="checkbox" name="day" value="${d}" ${DEFAULT_DAYS.includes(d) ? 'checked' : ''}> ${d}</label>`).join('');
}

function renderKioskSelects() {
  const opts = state.cfg.sessions.filter((s) => s.active).map((s) => `<option value="${esc(s.sessionId)}">${esc(s.title)} (${esc(s.start)})</option>`).join('');
  const keep = (sel) => { const v = sel.value; sel.innerHTML = opts; if (v) sel.value = v; };
  keep($('#kSession')); keep($('#rSession')); keep($('#cSession'));
  if (!$('#rDate').value) $('#rDate').value = tzNow(state.cfg.tz).date;
}

async function openRoster(sessionId, date) {
  const box = $('#rosterBox');
  box.innerHTML = '<p class="muted">Loading…</p>';
  try {
    const r = await api('roster', { sessionId, date });
    const present = r.members.filter((m) => m.status && m.status !== 'absent').length;
    box.innerHTML = `<p><b>${esc(r.session.title)}</b> · ${esc(r.date)} · ${present}/${r.members.length} marked</p>
      <div class="list">${r.members.map((m) => `
        <label class="item"><div>${m.status ? '' : `<input type="checkbox" value="${esc(m.id)}">`}
          <b>${esc(m.name)}</b> <span class="muted small">${esc(m.id)}</span></div>
          <span class="pill ${m.status === 'present' ? 'ok' : m.status ? 'warn' : ''}">${m.status ? esc(m.status + ' ' + m.time + ' · ' + m.method) : '—'}</span></label>`).join('')}
      </div>
      <div class="form row"><select id="rStatus"><option>present</option><option>late</option><option>absent</option><option>leave</option></select>
      <button class="btn primary" id="rSave">Mark ticked</button></div>`;
    $('#rSave').onclick = async () => {
      const ids = $$('#rosterBox input[type=checkbox]:checked').map((x) => x.value);
      if (!ids.length) return toast('Tick at least one name');
      try {
        const j = await api('manualMark', { sessionId, date: r.date, userIds: ids, status: $('#rStatus').value });
        toast(j.added + ' marked', 'ok'); openRoster(sessionId, r.date);
      } catch (e) { toast(e.message, 'err'); }
    };
  } catch (e) { box.innerHTML = `<p class="err-text">${esc(e.message)}</p>`; }
}

/* ------------------------------------------------------------------ me */

async function renderMe() {
  if (!state.user) return;
  const u = state.user;
  $('#meInfo').innerHTML = `<h2>${esc(u.name)}</h2><p class="muted">${esc(u.id)} · ${esc(u.role)} · ${esc(u.group || '')}</p>`;
  const local = LS.get(credKey());
  const sup = await bioSupported();
  $('#bioState').textContent = local ? 'Registered on this phone ✓' : (u.hasBiometric ? 'Registered on another phone — ask admin to reset' : (sup ? 'Not registered' : 'Not available on this phone/browser'));
  $('#btnBio').textContent = local ? 'Re-register' : 'Register';
  $('#btnBio').disabled = !sup;
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  $('#installHint').textContent = standalone ? '' : 'Tip: use “Add to Home screen” in the browser menu to install this as an app.';
}

function openModal(html) { $('#modalBody').innerHTML = html; $('#modal').classList.remove('hidden'); }
function closeModal() { $('#modal').classList.add('hidden'); }

function switchTab(id) {
  if (!isManager() && (id === 'tManage' || id === 'tKiosk')) id = 'tToday';
  state.tab = id;
  $$('.tab').forEach((t) => t.classList.toggle('hidden', t.id !== id));
  $$('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === id));
  if (id === 'tToday') { state.maps.fitted = state.maps.fitted && !!state.maps.today; updateTodayMap(); }
  if (id === 'tManage') initSiteMap();
  if (id === 'tMe') { renderMe(); renderQueue(); renderSensorUi(); }
}

/* ------------------------------------------------------------------ events */

function bind() {
  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target, btn = f.querySelector('button');
    btn.disabled = true; btn.textContent = 'Signing in…';
    try { await login(f.id.value, f.pin.value); f.reset(); }
    catch (err) { toast(err.message, 'err'); }
    finally { btn.disabled = false; btn.textContent = 'Sign in'; }
  });
  $$('#tabs button').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
  $('#btnSensors').addEventListener('click', enableSensors);
  $('#btnSensors2').addEventListener('click', enableSensors);
  $('#btnBio').addEventListener('click', async () => {
    try { await bioRegister(); toast('Fingerprint registered for this phone', 'ok'); renderMe(); }
    catch (e) { toast(e.name === 'NotAllowedError' ? 'Cancelled' : e.message, 'err'); }
  });
  $('#btnSync').addEventListener('click', () => syncQueue(true));
  $('#btnLogout').addEventListener('click', () => { if (confirm('Sign out of this phone?')) logout(); });
  $('#pinForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api('changePin', { oldPin: e.target.oldPin.value, newPin: e.target.newPin.value }); e.target.reset(); toast('PIN changed', 'ok'); }
    catch (err) { toast(err.message, 'err'); }
  });

  // manage
  $('#btnHere').addEventListener('click', () => {
    if (!state.pos) return toast('Waiting for GPS…');
    const f = $('#siteForm');
    f.lat.value = state.pos.coords.latitude.toFixed(6); f.lng.value = state.pos.coords.longitude.toFixed(6);
    if (state.maps.site) { state.maps.site.setView([+f.lat.value, +f.lng.value], 18); state.maps.drawPick && state.maps.drawPick(); }
  });
  $('#siteForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await api('createSite', { name: f.name.value, type: f.type.value, radius: f.radius.value, lat: f.lat.value, lng: f.lng.value });
      toast('Place saved', 'ok'); f.name.value = ''; await refreshConfig();
    } catch (err) { toast(err.message, 'err'); }
  });
  $('#sessForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const days = $$('#daysBox input:checked').map((x) => x.value);
    if (!days.length) return toast('Pick at least one day', 'err');
    try {
      await api('createSession', { title: f.title.value, type: f.type.value, siteId: f.siteId.value, group: f.group.value,
        days: days.length === 7 ? 'Daily' : days.join(','), start: f.start.value, end: f.end.value, graceMin: f.graceMin.value });
      toast('Attendance time saved', 'ok'); f.title.value = ''; await refreshConfig();
    } catch (err) { toast(err.message, 'err'); }
  });
  document.addEventListener('click', async (e) => {
    const t = e.target.closest('button'); if (!t) return;
    try {
      if (t.dataset.site) { await api('toggleSite', { siteId: t.dataset.site, active: t.dataset.on === '1' }); await refreshConfig(); }
      if (t.dataset.sess) { await api('toggleSession', { sessionId: t.dataset.sess, active: t.dataset.on === '1' }); await refreshConfig(); }
      if (t.dataset.roster) { switchTab('tKiosk'); $('#rSession').value = t.dataset.roster; openRoster(t.dataset.roster, $('#rDate').value); }
    } catch (err) { toast(err.message, 'err'); }
  });
  $('#userForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      const j = await api('addUser', { id: f.id.value, name: f.name.value, role: f.role.value, group: f.group.value, pin: f.pin.value });
      toast(j.created ? 'Person added' : 'Person updated', 'ok'); f.reset(); refreshConfig();
    } catch (err) { toast(err.message, 'err'); }
  });
  $('#resetForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api('resetDevice', { userId: e.target.userId.value }); toast('Phone link cleared', 'ok'); e.target.reset(); }
    catch (err) { toast(err.message, 'err'); }
  });

  // kiosk
  $('#kioskForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const c = state.pos ? state.pos.coords : {};
    const payload = { sessionId: f.sessionId.value, userId: f.userId.value.trim(), pin: f.pin.value, lat: c.latitude, lng: c.longitude, accuracy: c.accuracy, clientTime: new Date().toISOString() };
    try {
      const r = await api('kioskMark', payload);
      const line = `${r.name || payload.userId}: ${r.already ? 'already marked' : r.status} ${r.time || ''}`;
      $('#kioskLog').insertAdjacentHTML('afterbegin', `<div class="item"><span>${esc(line)}</span><span class="pill ok">✓</span></div>`);
      toast(line, 'ok'); f.userId.value = ''; f.pin.value = ''; f.userId.focus();
    } catch (err) { toast(err.message, 'err'); }
  });
  $('#btnRoster').addEventListener('click', () => { const s = $('#rSession').value; if (s) openRoster(s, $('#rDate').value); });

  $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
  window.addEventListener('online', () => { renderNet(); syncQueue(); refreshConfig(); });
  window.addEventListener('offline', renderNet);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && state.token) { evaluate(); syncQueue(); } });
}

/* ------------------------------------------------------------------ start */

function start() {
  bind(); renderDays(); renderNet();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  if (state.token && state.user) {
    showApp();
    refreshConfig().then(() => syncQueue());
  } else showLogin();
  setInterval(() => { if (state.token) evaluate(); }, 20000);           // window opens/closes
  setInterval(() => { if (state.token) syncQueue(); }, 60000);          // retry offline queue
  setInterval(() => { if (state.token && navigator.onLine) refreshConfig(); }, 10 * 60000); // pick up new sessions
}

start();
