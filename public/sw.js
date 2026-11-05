// Service worker: makes the panel installable as an app and gives it a proper
// offline screen. It deliberately caches nothing that carries server data:
// pages and /api always come from the network, so nothing shown is ever stale.
// Only the offline page and the static look it needs are kept, plus fonts and
// icons (content-stable, see the immutable Cache-Control in web/app.js).
// Push notifications for finished tasks are shown through this worker too,
// because Android Chrome cannot construct `new Notification()` in a page.

const CACHE = 'msm-shell-v2';
const SHELL = ['/offline.html', '/css/app.css', '/favicon.svg', '/icons/pickaxe-192.png'];

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
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Pages: always the network; the offline screen only when it can't answer.
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).catch(() => caches.match('/offline.html')));
    return;
  }

  // Fonts and icons never change under the same name: cache-first.
  if (url.pathname.startsWith('/fonts/') || url.pathname.startsWith('/icons/')) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(CACHE).then((c) => c.put(req, copy));
            }
            return res;
          })
      )
    );
    return;
  }

  // The stylesheet: fresh when online (keeps the offline page's copy current).
  if (url.pathname === '/css/app.css') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put('/css/app.css', copy));
          }
          return res;
        })
        .catch(() => caches.match('/css/app.css'))
    );
  }
  // Everything else (scripts, /api, …) goes straight to the network untouched.
});

// Tapping a "task finished" notification focuses an open panel tab, or opens one.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if ('focus' in w) {
          w.navigate(target).catch(() => {});
          return w.focus();
        }
      }
      return self.clients.openWindow(target);
    })
  );
});
