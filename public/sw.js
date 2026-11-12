// Service worker: เก็บหน้าแอปไว้ในเครื่องให้เปิดได้ทันที/ตอนออฟไลน์
// ข้อมูล (/api/*) ไม่ผ่านแคช — ฝั่งแอปจัดการ outbox เอง
const CACHE = 'daily-log-v1';
const SHELL = [
  '/',
  '/app.js',
  '/styles.css',
  '/manifest.webmanifest',
  '/icon.svg',
  '/icon-192.png',
  '/fonts/plex-thai-thai-400.woff2',
  '/fonts/plex-thai-thai-500.woff2',
  '/fonts/plex-thai-thai-600.woff2',
  '/fonts/plex-thai-latin-400.woff2',
  '/fonts/plex-thai-latin-500.woff2',
  '/fonts/plex-thai-latin-600.woff2',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  // stale-while-revalidate: ใช้ของในแคชก่อน แล้วอัปเดตเบื้องหลัง
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const key = req.mode === 'navigate' ? '/' : req;
      const cached = await cache.match(key, { ignoreSearch: req.mode === 'navigate' });
      const network = fetch(req)
        .then((res) => {
          if (res.ok && !res.redirected) cache.put(key, res.clone());
          return res;
        })
        .catch(() => null);
      if (cached) {
        event.waitUntil(network);
        return cached;
      }
      return (await network) || new Response('ออฟไลน์', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    })()
  );
});
