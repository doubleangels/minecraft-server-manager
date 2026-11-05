// Installable app support: registers the service worker, offers "Install App"
// in the account menu, opt-in notifications for finished background tasks, and
// the home-screen icon badge for unread health alerts.
//
// The service worker and notifications need a secure context (HTTPS, or
// localhost); on plain HTTP they stay off. Install App still shows there, to
// explain what to do (and iOS installs over HTTP anyway).

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
// Every browser installs differently, so the menu item always leads somewhere
// useful once the panel is not already running as the installed app:
// - Chrome, Edge, Samsung Internet (secure): the browser's own install prompt.
// - iPhone and iPad, any browser: Share, then Add to Home Screen. iOS makes a
//   full-screen app this way even over plain HTTP.
// - Firefox for Android and other phones with no prompt: the browser menu.
// - Plain HTTP anywhere else: browsers only install over HTTPS, so say so
//   instead of hiding the option and leaving people guessing.
const coarse = window.matchMedia('(pointer: coarse)').matches;
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
if (!standalone && (isIos || coarse || !secure)) reveal('[data-install-app]');

/** The manual steps for this browser, as list items. */
function installSteps() {
  if (isIos) {
    return [
      'Tap the <b>Share</b> button: at the bottom of Safari (or the top on an iPad), or in the address bar in Chrome.',
      'Scroll down and tap <b>Add to Home Screen</b>. If you see <b>Open as Web App</b>, leave it on.',
      'Tap <b>Add</b>. The panel opens full screen from its new icon.',
    ];
  }
  if (!secure) {
    return [
      'Installing as an app needs a secure (HTTPS) address. On this address your browser can only add a shortcut that opens in a browser tab.',
      'To install properly, open the panel through a domain with an HTTPS certificate, for example behind a reverse proxy. The README explains how.',
      'For the shortcut instead, open your browser menu and choose <b>Add to Home Screen</b>.',
    ];
  }
  return [
    'Open your browser menu (the <b>⋮</b> or <b>☰</b> button).',
    'Choose <b>Install App</b> or <b>Add to Home Screen</b>.',
    'If neither is there, the panel may already be installed. Look for it on your home screen or in your app list.',
  ];
}

document.addEventListener('click', async (e) => {
  if (e.target.closest('[data-install-app]')) {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      await deferredPrompt.userChoice.catch(() => null);
      deferredPrompt = null;
      return;
    }
    const content = document.createElement('ol');
    content.className = 'list-decimal space-y-2 pl-5 text-sm';
    content.innerHTML = installSteps()
      .map((step) => `<li>${step}</li>`)
      .join('');
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
  const opts = {
    body,
    icon: '/icons/pickaxe-192.png',
    badge: '/icons/pickaxe-badge-96.png',
    data: { url },
    tag: title,
  };
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
