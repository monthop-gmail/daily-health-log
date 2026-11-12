// Service worker
// - เก็บหน้าแอปไว้ในเครื่องให้เปิดได้ทันที/ตอนออฟไลน์ (ข้อมูล /api/* ไม่ผ่านแคช)
// - รับการแจ้งเตือน (Web Push) เตือนยาและนัดหมอ
const CACHE = 'daily-log-v2';
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

// ---------- การแจ้งเตือน ----------

self.addEventListener('push', (event) => {
  let d = {};
  try {
    d = event.data ? event.data.json() : {};
  } catch {
    d = { title: 'บันทึกประจำวัน', body: event.data ? event.data.text() : '' };
  }
  const options = {
    body: d.body || '',
    tag: d.tag || undefined,
    renotify: !!d.tag,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    lang: 'th',
    requireInteraction: d.type === 'med',
    data: d,
    actions: d.type === 'med' ? [{ action: 'take', title: '✓ ใช้ยาแล้ว' }, { action: 'open', title: 'ดูรายการ' }] : [],
  };
  event.waitUntil(self.registration.showNotification(d.title || 'บันทึกประจำวัน', options));
});

async function openApp(path) {
  const url = new URL(path || '/', self.location.origin).href;
  const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const w of wins) {
    if (new URL(w.url).origin === self.location.origin) {
      await w.focus();
      return w.navigate(url).catch(() => w);
    }
  }
  return self.clients.openWindow(url);
}

self.addEventListener('notificationclick', (event) => {
  const d = event.notification.data || {};
  event.notification.close();
  if (event.action === 'take' && d.type === 'med') {
    // บันทึกจากปุ่มบนการแจ้งเตือนได้เลย ไม่ต้องเปิดแอป
    event.waitUntil(
      fetch('/api/meds/take', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slot: d.slot, date: d.date }),
      })
        .then((res) => {
          if (!res.ok) throw new Error(String(res.status));
          return self.registration.showNotification('บันทึกแล้ว ✓', { body: d.title || '', tag: d.tag, icon: '/icon-192.png' });
        })
        .catch(() => openApp(d.url))
    );
    return;
  }
  event.waitUntil(openApp(d.url));
});
