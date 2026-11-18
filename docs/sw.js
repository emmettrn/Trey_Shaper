/*
 * Offline support. The app is a handful of static files, so:
 *   - on install, save a copy of all of them
 *   - on every request, use the network when there is one (so updates show up
 *     straight away) and fall back to the saved copy when there isn't
 * Bump CACHE when the list of files changes.
 */
const CACHE = 'surfboard-designer-v7';
const FILES = [
  './', 'index.html', 'style.css', 'app.js', 'geometry.js', 'trace.js', 'data.js', 'manifest.webmanifest',
  'icon-180.png', 'icon-192.png', 'icon-512.png',
  'three.module.min.js',
  'OrbitControls.js',
  'RoomEnvironment.js',
  'BufferGeometryUtils.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const res = await fetch(e.request);
      if (res && (res.ok || res.type === 'opaque')) cache.put(e.request, res.clone()).catch(() => {});
      return res;
    } catch (err) {
      const hit = await cache.match(e.request, { ignoreSearch: true });
      if (hit) return hit;
      if (e.request.mode === 'navigate') { const page = await cache.match('index.html'); if (page) return page; }
      throw err;
    }
  })());
});
