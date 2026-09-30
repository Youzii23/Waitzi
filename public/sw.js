// Waitzi service worker: caches the app shell so the page opens on a flaky connection,
// and lets the page show a system notification when the order is ready.
const CACHE = 'waitzi-v2';
const SHELL = ['/', '/app.css', '/common.js', '/customer.js', '/icon.svg', '/manifest.webmanifest'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Network first for the shell, never touch the API or event streams.
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  if (!SHELL.includes(url.pathname)) return;
  e.respondWith(
    fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match(e.request))
  );
});

// Lock-screen alert. If the page is on screen it already beeps and lights up, so stay quiet.
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) {}
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    if (list.some(c => c.visibilityState === 'visible')) return;
    return self.registration.showNotification(d.title || 'Your order is ready', {
      body: d.body || 'Come pick it up at the counter.',
      tag: 'waitzi-ready',
      renotify: true,
      requireInteraction: true,
      vibrate: [70, 90, 70, 90, 260],
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { n: d.n },
    });
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    const c = list.find(x => new URL(x.url).pathname === '/');
    const n = e.notification.data && e.notification.data.n;
    return c ? c.focus() : self.clients.openWindow(n ? '/?o=' + n : '/');
  }));
});
