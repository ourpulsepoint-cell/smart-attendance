/* Service worker: offline app shell + notification clicks. Bump VERSION after each deploy. */
const VERSION = 'sa-v3';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'config.js', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png', 'qr.js', 'idcheck.js'];
const CDN = ['https://unpkg.com/leaflet@1.9.4/dist/leaflet.css', 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => Promise.allSettled(SHELL.concat(CDN).map((u) => c.add(u)))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (/script\.google(usercontent)?\.com$/.test(url.hostname)) return;          // API: never cache
  if (url.hostname === 'unpkg.com' || url.hostname === 'cdn.jsdelivr.net') {   // Leaflet, face models, jsQR: cache first (kiosk works offline after first use)
    e.respondWith(caches.match(req).then((r) => r || fetch(req).then((res) => { const cp = res.clone(); caches.open(VERSION).then((c) => c.put(req, cp)); return res; })));
    return;
  }
  if (/tile\.openstreetmap\.org$/.test(url.hostname)) {                          // map tiles: network, fall back to cache
    e.respondWith(fetch(req).then((res) => { const cp = res.clone(); caches.open(VERSION + '-tiles').then((c) => c.put(req, cp)); return res; })
      .catch(() => caches.match(req)));
    return;
  }
  if (url.origin === self.location.origin) {                                     // app: network first, offline fallback
    e.respondWith(fetch(req).then((res) => { const cp = res.clone(); caches.open(VERSION).then((c) => c.put(req, cp)); return res; })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match('index.html'))));
  }
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) if ('focus' in c) return c.focus();
    return self.clients.openWindow('./');
  }));
});
