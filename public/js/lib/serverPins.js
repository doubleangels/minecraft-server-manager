// Pinned servers: a star on each server card keeps that server first on the
// dashboard, the server list and the sidebar. Kept per browser (like the grid
// or list view choice), since what one admin watches is their own business.

const KEY = 'msm-pinned-servers';

export function pinned() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

function save(ids) {
  try {
    localStorage.setItem(KEY, JSON.stringify(ids));
  } catch {
    /* private mode: pins last for this page only */
  }
}

/** Move pinned children to the front of `container`, keeping each group's order. */
function float(container, selector, idOf) {
  if (!container) return;
  const ids = pinned();
  const items = [...container.querySelectorAll(selector)];
  if (!items.length) return;
  // Pinned first (in the order they were pinned), then the rest as rendered.
  const pins = items.filter((el) => ids.includes(idOf(el)));
  pins.sort((a, b) => ids.indexOf(idOf(a)) - ids.indexOf(idOf(b)));
  const rest = items.filter((el) => !ids.includes(idOf(el)));
  const after = items[items.length - 1].nextSibling; // e.g. the Create a Server tile
  const frag = document.createDocumentFragment();
  frag.append(...pins, ...rest);
  container.insertBefore(frag, after);
}

export function applyPins() {
  const ids = pinned();
  for (const btn of document.querySelectorAll('[data-pin-server]')) {
    const on = ids.includes(btn.dataset.pinServer);
    btn.setAttribute('aria-pressed', String(on));
    btn.dataset.tip = on ? 'Unpin from the top of the list.' : 'Pin to the top of the list.';
    btn.querySelector('svg')?.setAttribute('fill', on ? 'currentColor' : 'none');
  }
  for (const a of document.querySelectorAll('[data-sidebar-server]')) {
    const mark = a.querySelector('[data-pin-mark]');
    mark?.classList.toggle('hidden', !ids.includes(a.dataset.sidebarServer));
    mark?.querySelector('svg')?.setAttribute('fill', 'currentColor');
  }
  float(document.getElementById('server-grid'), ':scope > [data-server-card]', (el) => el.dataset.serverCard);
  const sideFirst = document.querySelector('[data-sidebar-server]');
  if (sideFirst) float(sideFirst.parentNode, ':scope > [data-sidebar-server]', (el) => el.dataset.sidebarServer);
}

// Buttons inside a card or sidebar link (pin, copy): act, never also navigate.
document.addEventListener(
  'click',
  (e) => {
    const inner = e.target.closest('a [data-pin-server], a [data-copy]');
    if (inner) e.preventDefault();
    const pin = e.target.closest('[data-pin-server]');
    if (!pin) return;
    e.stopPropagation();
    const id = pin.dataset.pinServer;
    const ids = pinned();
    save(ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]);
    applyPins();
  },
  true
);

applyPins();
