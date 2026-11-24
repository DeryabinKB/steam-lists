// Service worker: картинки Steam храним на устройстве навсегда (второй раз — без интернета),
// сам код приложения — сначала из сети, без сети — из кэша.
const IMG = 'steam-img-v1', APP = 'app-v1';
self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (u.hostname.endsWith('steamstatic.com') || u.hostname.endsWith('akamaihd.net')) {
    e.respondWith(caches.open(IMG).then(async c => {
      const hit = await c.match(e.request, { ignoreSearch: true });
      if (hit) return hit;
      const r = await fetch(e.request);
      if (r.ok || r.type === 'opaque') c.put(e.request, r.clone());
      return r;
    }));
  } else if (u.origin === location.origin) {
    e.respondWith(fetch(e.request).then(r => { const cl = r.clone(); caches.open(APP).then(c => c.put(e.request, cl)); return r; })
      .catch(() => caches.match(e.request)));
  }
});
