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
    if (pushSupported) openPushSettings();
    else if (isIos && !standalone) {
      openModal({
        title: 'Notifications',
        content:
          '<p class="text-sm">On iPhone and iPad, notifications work in the installed app. Choose <b>Install App</b> in this menu, open the panel from your home screen, then turn notifications on there.</p>',
        actions: [{ label: 'Done', kind: 'primary' }],
      });
    } else {
      // No push in this browser: notify while a tab is open in the background.
      const result = await Notification.requestPermission().catch(() => 'denied');
      if (result === 'granted') {
        reveal('[data-enable-notifications]', false);
        toast('Notifications on. You will hear when a task finishes while the panel is in the background.');
      } else {
        toast('Notifications are blocked for this site. Allow them in the browser settings to turn them on.', {
          kind: 'warn',
        });
      }
    }
  }
});

// ---- Notifications ----
// Push (Web Push) reaches the device even with the panel closed. Needs a
// secure context and a service worker; iPhone and iPad offer it only in the
// installed app.
const pushSupported = secure && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const PUSH_FLAG = 'msm-push-on';
const pushOn = () => {
  try {
    return localStorage.getItem(PUSH_FLAG) === '1';
  } catch {
    return false;
  }
};
const setPushFlag = (on) => {
  try {
    if (on) localStorage.setItem(PUSH_FLAG, '1');
    else localStorage.removeItem(PUSH_FLAG);
  } catch {
    /* storage blocked: only the in-page duplicate check is affected */
  }
};
if (pushSupported || (isIos && !standalone && secure)) reveal('[data-enable-notifications]');
else if (secure && 'Notification' in window && Notification.permission === 'default') {
  reveal('[data-enable-notifications]');
}

const PUSH_CATEGORIES = [
  ['problems', 'Server Problems', 'A crash, running out of memory, a stuck startup, or a server that will not stop.'],
  [
    'failures',
    'Backup and Update Failures',
    'A damaged backup, a scheduled task that failed, or an update that did not work.',
  ],
  ['tasks', 'My Finished Tasks', 'A backup, install or update you started has finished (tasks over 15 seconds).'],
];

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.error || 'The panel did not answer. Try again.');
  return data;
}

function keyBytes(b64u) {
  const s = atob(b64u.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64u.length % 4)) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

/** The Notifications dialog: turn push on or off for this device, pick alerts, test. */
async function openPushSettings() {
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  const info = await api('GET', `/api/account/push${sub ? `?endpoint=${encodeURIComponent(sub.endpoint)}` : ''}`).catch(
    (err) => {
      toast(err.message, { kind: 'error' });
      return null;
    }
  );
  if (!info) return;
  let device = info.device;
  setPushFlag(Boolean(sub && device));

  const body = document.createElement('div');
  body.className = 'space-y-4 text-sm';
  const render = () => {
    if (!device) {
      body.innerHTML = `
        <p>Get an alert on this device when a server crashes, a backup fails, or a task you started finishes, even with the panel closed.</p>
        <p class="help">Your browser will ask for permission. You can pick which alerts you want next.</p>`;
      return;
    }
    body.innerHTML = `
      <p class="notice notice-ok">Notifications are on for this device.</p>
      <div class="space-y-3" data-push-cats>${PUSH_CATEGORIES.map(
        ([key, label, help]) => `
        <label class="flex items-start gap-3">
          <input type="checkbox" class="msm-check mt-0.5" data-push-cat="${key}" ${device.categories.includes(key) ? 'checked' : ''}>
          <span><span class="font-medium">${label}</span><span class="help block">${help}</span></span>
        </label>`
      ).join('')}</div>
      <div class="flex flex-wrap gap-2">
        <button type="button" class="btn btn-sm" data-push-test>Send a Test Notification</button>
        <button type="button" class="btn btn-sm btn-ghost" data-push-off>Turn Off on This Device</button>
      </div>`;
    body.querySelectorAll('[data-push-cat]').forEach((box) =>
      box.addEventListener('change', async () => {
        const categories = [...body.querySelectorAll('[data-push-cat]:checked')].map((b) => b.dataset.pushCat);
        try {
          device = (await api('PATCH', `/api/account/push/subscriptions/${device.id}`, { categories })).device;
        } catch (err) {
          toast(err.message, { kind: 'error' });
        }
      })
    );
    body.querySelector('[data-push-test]').addEventListener('click', async (ev) => {
      ev.currentTarget.disabled = true;
      try {
        await api('POST', `/api/account/push/subscriptions/${device.id}/test`);
        toast('Test sent. It should arrive in a few seconds.');
      } catch (err) {
        toast(err.message, { kind: 'error', timeout: 8000 });
      } finally {
        ev.currentTarget.disabled = false;
      }
    });
    body.querySelector('[data-push-off]').addEventListener('click', async () => {
      try {
        await api('DELETE', `/api/account/push/subscriptions/${device.id}`);
        if (sub) await sub.unsubscribe().catch(() => {});
        sub = null;
        device = null;
        setPushFlag(false);
        ctx.close();
        toast('Notifications are off for this device.');
      } catch (err) {
        toast(err.message, { kind: 'error' });
      }
    });
  };
  render();

  const ctx = openModal({
    title: 'Notifications',
    content: body,
    actions: device
      ? [{ label: 'Done', kind: 'primary' }]
      : [
          { label: 'Not Now', kind: 'ghost' },
          {
            label: 'Turn On Notifications',
            kind: 'primary',
            busyLabel: 'Turning on…',
            onClick: async () => {
              const permission = await Notification.requestPermission().catch(() => 'denied');
              if (permission !== 'granted') {
                toast('Notifications are blocked for this site. Allow them in the browser settings, then try again.', {
                  kind: 'warn',
                  timeout: 8000,
                });
                return false;
              }
              try {
                sub =
                  sub ||
                  (await reg.pushManager.subscribe({
                    userVisibleOnly: true,
                    applicationServerKey: keyBytes(info.publicKey),
                  }));
              } catch {
                // The browser's own error text is not for people.
                toast(
                  'This browser could not sign up for notifications. Check that notifications are allowed for this site, then try again.',
                  { kind: 'error', timeout: 8000 }
                );
                return false;
              }
              try {
                const label = `${standalone ? 'App' : 'Browser'} on ${navigator.platform || 'this device'}`;
                device = (await api('POST', '/api/account/push/subscriptions', { subscription: sub.toJSON(), label }))
                  .device;
                setPushFlag(true);
                toast('Notifications are on for this device.');
                setTimeout(openPushSettings, 50); // reopen showing the alert choices
              } catch (err) {
                toast(err.message, { kind: 'error', timeout: 8000 }); // the panel's own friendly message
                return false;
              }
            },
          },
        ],
  });
}

/**
 * Show a system notification, only while the panel is not in front (a visible
 * page already shows its own toast). Goes through the service worker when
 * there is one: Android cannot construct `new Notification()` in a page.
 */
export function notify(title, { body = '', url = '/' } = {}) {
  if (!secure || !('Notification' in window) || Notification.permission !== 'granted') return;
  // This device gets push notifications for its tasks already: don't double up.
  if (pushOn()) return;
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
