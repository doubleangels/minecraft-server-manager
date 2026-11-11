// Service worker: makes the panel installable as an app and gives it a proper
// offline screen. It deliberately caches nothing that carries server data:
// pages and /api always come from the network, so nothing shown is ever stale.
// Only the offline page and the static look it needs are kept, plus fonts and
// icons (content-stable, see the immutable Cache-Control in web/app.js).
// Notifications are shown through this worker: push messages from the panel
// (crashes, failed backups, finished tasks; they arrive even with the app
// closed), and the in-page fallback, because Android Chrome cannot construct
// `new Notification()` in a page.

const CACHE = 'msm-shell-v3';
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

// A push message from the panel. Always shown: browsers (Safari above all)
// withdraw push permission from a site that receives pushes without showing
// them. The tag replaces an older alert of the same kind for the same server.
self.addEventListener('push', (event) => {
  let msg = {};
  try {
    msg = event.data ? event.data.json() : {};
  } catch {
    msg = { title: event.data ? event.data.text() : '' };
  }
  event.waitUntil(
    self.registration.showNotification(msg.title || 'Minecraft Server Manager', {
      body: msg.body || '',
      icon: '/icons/pickaxe-192.png',
      badge: '/icons/pickaxe-badge-96.png',
      tag: msg.tag || undefined,
      renotify: Boolean(msg.tag),
      data: { url: msg.url || '/' },
    })
  );
});

// The browser replaced this device's subscription (it does so now and then):
// sign the new one up, so alerts keep arriving.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      const res = await fetch('/api/account/push', { credentials: 'same-origin' });
      if (!res.ok) return;
      const { publicKey } = await res.json();
      const raw = atob(publicKey.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (publicKey.length % 4)) % 4));
      const sub = await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: Uint8Array.from(raw, (c) => c.charCodeAt(0)),
      });
      await fetch('/api/account/push/subscriptions', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription: sub.toJSON(), label: 'Renewed by the browser' }),
      });
    })().catch(() => {})
  );
});

// Tapping a notification focuses an open panel tab on its page, or opens one.
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
