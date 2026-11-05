// Phone and installed-app comforts that span every page: keyboard hints on
// typed fields, the Share button, the "panel stopped answering" banner, and
// pull to refresh in the installed app.
import { toast } from './toast.js';

const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
const modalOpen = () => Boolean(document.querySelector('[role="dialog"][aria-modal="true"]'));

// ---- Keyboard hints ----
// Names, commands, file names, addresses and searches are not prose: a phone
// keyboard that capitalises the first letter or "corrects" jeb_ into Jeb is a
// bug. Fields that do hold prose (a MOTD, a note, a chat message) keep the
// keyboard's help. A field that sets any of these attributes itself wins.
const PROSE = /(motd|desc|note|reason|label|chat|message|title|display|st-name|wz-name)/i;
const TEXTISH = new Set(['text', 'search', 'url', 'email', 'tel']);

function hint(el) {
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return;
  if (el.dataset.kbHint) return;
  el.dataset.kbHint = '1';
  if (el instanceof HTMLInputElement && !TEXTISH.has(el.type)) return;
  const id = `${el.id} ${el.name}`;
  const placeholder = el.getAttribute('placeholder') || '';
  const searchy =
    el.type === 'search' || /(search|filter)|(^|-)q\b/i.test(id) || /^(search|filter)\b/i.test(placeholder);
  if (!el.hasAttribute('enterkeyhint')) {
    if (searchy) el.setAttribute('enterkeyhint', 'search');
    else if (el.id === 'chat-input') el.setAttribute('enterkeyhint', 'send');
  }
  const prose = PROSE.test(id) || (el instanceof HTMLTextAreaElement && !el.classList.contains('font-mono'));
  if (prose) return;
  if (!el.hasAttribute('autocapitalize')) el.setAttribute('autocapitalize', 'off');
  if (!el.hasAttribute('autocorrect')) el.setAttribute('autocorrect', 'off');
  if (!el.hasAttribute('spellcheck')) el.spellcheck = false;
}
document.querySelectorAll('input, textarea').forEach(hint);
// Fields added later (dialogs, live lists): hint them as a finger lands or
// focus arrives, both of which come before the keyboard reads the attributes.
document.addEventListener('pointerdown', (e) => hint(e.target), true);
document.addEventListener('focusin', (e) => hint(e.target), true);

// ---- Share (phones' share sheet), with Copy as the fallback ----
if (navigator.share) {
  document.querySelectorAll('[data-share-from], [data-share-text]').forEach((el) => {
    el.hidden = false;
  });
}
document.addEventListener('click', async (e) => {
  const el = e.target.closest && e.target.closest('[data-share-from], [data-share-text]');
  if (!el) return;
  let text = el.dataset.shareText || '';
  if (el.dataset.shareFrom) {
    const src = document.querySelector(el.dataset.shareFrom);
    text = src ? (src.value ?? src.textContent) : '';
  }
  text = String(text || '').trim();
  if (!text) return;
  try {
    await navigator.share({ title: el.dataset.shareTitle || document.title, text });
  } catch (err) {
    if (err && err.name === 'AbortError') return; // closed the sheet: nothing to do
    if (window.CD && window.CD.copyText && (await window.CD.copyText(text))) toast('Copied to clipboard.');
  }
});

// ---- Connection banner ----
// taskTray.js polls the panel every few seconds; it raises msm:connection when
// that stops (or starts) working. The browser's own offline signal shows it at
// once. Hidden again, with a short toast, when the panel answers.
let banner = null;
let shownAt = 0;
function setConnection(ok) {
  if (!ok) {
    if (banner) return;
    banner = document.createElement('div');
    banner.setAttribute('role', 'status');
    // An opaque canvas under the tinted notice: it floats over page content.
    banner.className =
      'fixed left-1/2 top-[calc(env(safe-area-inset-top)+4.75rem)] z-[66] w-max max-w-[calc(100vw-2rem)] -translate-x-1/2 rounded-md bg-canvas shadow-overlay animate-[fade-in_.15s_ease-out]';
    banner.innerHTML =
      '<div class="notice notice-warn flex items-center gap-2 py-2 text-sm"><span class="size-2 shrink-0 animate-pulse rounded-full bg-warn motion-reduce:animate-none"></span><span data-text></span></div>';
    banner.querySelector('[data-text]').textContent =
      navigator.onLine === false
        ? 'You are offline. Reconnecting when your connection is back…'
        : 'The panel is not answering. Reconnecting…';
    document.body.appendChild(banner);
    shownAt = Date.now();
    return;
  }
  if (!banner) return;
  banner.remove();
  banner = null;
  // Only worth a word if the banner was up long enough to be read.
  if (Date.now() - shownAt > 1500) toast('Reconnected.');
}
document.addEventListener('msm:connection', (e) => setConnection(e.detail.ok));
window.addEventListener('offline', () => setConnection(false));

// ---- Installed app: a refresh button and pull to refresh ----
// A browser tab has its own reload button and pull gesture; the installed app
// has neither, so the panel supplies both there.
document.addEventListener('click', (e) => {
  if (e.target.closest && e.target.closest('[data-app-refresh]')) location.reload();
});
if (standalone) initPullToRefresh();

function scrollsVertically(el) {
  for (let n = el; n && n !== document.body; n = n.parentElement) {
    if (n.scrollHeight > n.clientHeight + 1) {
      const oy = getComputedStyle(n).overflowY;
      if (oy === 'auto' || oy === 'scroll') return true;
    }
  }
  return false;
}

function initPullToRefresh() {
  const TRIGGER = 80;
  let startY = null;
  let pull = 0;
  let pill = null;
  const reset = () => {
    startY = null;
    pull = 0;
    if (pill) {
      pill.remove();
      pill = null;
    }
  };
  document.addEventListener(
    'touchstart',
    (e) => {
      if (e.touches.length !== 1 || window.scrollY > 0 || modalOpen()) return;
      const t = e.target;
      if (t.closest('input, textarea, select, [contenteditable="true"], #console-log') || scrollsVertically(t)) return;
      startY = e.touches[0].clientY;
    },
    { passive: true }
  );
  document.addEventListener(
    'touchmove',
    (e) => {
      if (startY == null) return;
      pull = Math.max(0, e.touches[0].clientY - startY);
      if (window.scrollY > 0) return reset();
      if (pull < 12) return;
      if (!pill) {
        pill = document.createElement('div');
        pill.className =
          'pointer-events-none fixed left-1/2 top-[calc(env(safe-area-inset-top)+4.25rem)] z-[66] grid size-9 -translate-x-1/2 place-items-center rounded-full border border-line bg-raised text-ink-soft shadow-overlay';
        pill.innerHTML =
          '<svg class="icon size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>';
        document.body.appendChild(pill);
      }
      const p = Math.min(pull, TRIGGER * 1.5);
      pill.style.transform = `translate(-50%, ${p * 0.5}px) rotate(${p * 3}deg)`;
      pill.classList.toggle('text-ok', pull >= TRIGGER);
    },
    { passive: true }
  );
  document.addEventListener('touchend', () => {
    if (startY != null && pull >= TRIGGER) {
      location.reload();
      return;
    }
    reset();
  });
  document.addEventListener('touchcancel', reset);
}
