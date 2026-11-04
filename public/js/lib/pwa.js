// Installable app support: registers the service worker, offers "Install App"
// in the account menu, opt-in notifications for finished background tasks, and
// the home-screen icon badge for unread health alerts.
//
// Everything here needs a secure context (HTTPS, or localhost): on plain HTTP
// the browser offers none of it, so the menu items simply stay hidden.

import { openModal } from './modal.js';
import { toast } from './toast.js';

const secure = window.isSecureContext;
const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
const isIos =
  /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

// The account menu is cloned from a <template> each time it opens, so the
// items are revealed on the template itself (and on any open copy).
function reveal(selector, show = true) {
  const tpl = document.getElementById('user-menu');
  const nodes = [...(tpl ? tpl.content.querySelectorAll(selector) : []), ...document.querySelectorAll(selector)];
  for (const el of nodes) el.classList.toggle('hidden', !show);
}

// ---- Service worker ----
if (secure && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* installing still works where the browser does not require a worker */
    });
  });
}

// ---- Install App ----
let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault(); // keep the browser's mini-infobar quiet; the menu item asks instead
  deferredPrompt = e;
  reveal('[data-install-app]');
});
window.addEventListener('appinstalled', () => {
  deferredPrompt = null;
  reveal('[data-install-app]', false);
  toast('Installed. Open Minecraft Server Manager from your home screen or app list.');
});
// iPhone and iPad never fire beforeinstallprompt: offer the manual steps instead.
if (secure && isIos && !standalone) reveal('[data-install-app]');

document.addEventListener('click', async (e) => {
  if (e.target.closest('[data-install-app]')) {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      await deferredPrompt.userChoice.catch(() => null);
      deferredPrompt = null;
      reveal('[data-install-app]', false);
      return;
    }
    const content = document.createElement('ol');
    content.className = 'list-decimal space-y-2 pl-5 text-sm';
    content.innerHTML =
      "<li>Tap the <b>Share</b> button in Safari's toolbar.</li>" +
      '<li>Scroll down and tap <b>Add to Home Screen</b>.</li>' +
      '<li>Tap <b>Add</b>. The panel opens full screen from its new icon.</li>';
    openModal({ title: 'Install on This Device', content, actions: [{ label: 'Done', kind: 'primary' }] });
    return;
  }
  if (e.target.closest('[data-enable-notifications]')) {
    const result = await Notification.requestPermission().catch(() => 'denied');
    if (result === 'granted') {
      reveal('[data-enable-notifications]', false);
      toast(
        'Notifications on. You will hear when a backup, restore or update finishes while the panel is in the background.'
      );
    } else {
      toast('Notifications are blocked for this site. Allow them in the browser settings to turn them on.', {
        kind: 'warn',
      });
    }
  }
});

// ---- Notifications ----
if (secure && 'Notification' in window && Notification.permission === 'default') reveal('[data-enable-notifications]');

/**
 * Show a system notification, only while the panel is not in front (a visible
 * page already shows its own toast). Goes through the service worker when
 * there is one: Android cannot construct `new Notification()` in a page.
 */
export function notify(title, { body = '', url = '/' } = {}) {
  if (!secure || !('Notification' in window) || Notification.permission !== 'granted') return;
  if (document.visibilityState === 'visible') return;
  const opts = { body, icon: '/icons/icon-192.png', badge: '/icons/icon-maskable-192.png', data: { url }, tag: title };
  const viaWorker =
    'serviceWorker' in navigator && navigator.serviceWorker.controller
      ? navigator.serviceWorker.ready.then((r) => r.showNotification(title, opts))
      : Promise.reject(new Error('no worker'));
  viaWorker.catch(() => {
    try {
      new Notification(title, opts);
    } catch {
      /* this browser only notifies from a worker */
    }
  });
}

// ---- Home-screen badge: unread health alerts ----
const healthCount = Number(document.body?.dataset.healthCount) || 0;
if ('setAppBadge' in navigator) {
  (healthCount ? navigator.setAppBadge(healthCount) : navigator.clearAppBadge()).catch(() => {});
}
