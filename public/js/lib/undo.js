// Undoable deletes: the item disappears at once and a toast offers Undo for
// ten seconds. Only when that passes does the delete reach the panel, so Undo
// is a real undo with nothing to put back on the server side.
//
// Leaving the page during the window still deletes (sent with keepalive, so
// the browser finishes the request after the page is gone).
//
//   undoableDelete({
//     message: 'Schedule deleted.',
//     hide: () => row.classList.add('hidden'),
//     restore: () => row.classList.remove('hidden'),
//     commit: (opts) => fetch(url, { method: 'DELETE', ...opts }),   // opts.keepalive on page exit
//     failed: 'delete that schedule',
//   });

import { toast } from './toast.js';
import { friendlyError } from './errors.js';

/** @type {Set<() => void>} commits still waiting for their undo window */
const pending = new Set();
window.addEventListener('pagehide', () => {
  for (const flush of [...pending]) flush();
});

export function undoableDelete({ message, hide, restore, commit, failed = 'delete that', seconds = 10, onCommitted }) {
  hide();
  let settled = false;
  const run = async (opts = {}) => {
    if (settled) return;
    settled = true;
    pending.delete(flushNow);
    try {
      const res = await commit(opts);
      if (res && res.ok === false) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || friendlyError(res, { action: failed }));
      }
      onCommitted?.();
    } catch (err) {
      if (opts.keepalive) return; // the page is gone; nothing left to show
      restore();
      toast(err.message || friendlyError(null, { action: failed }), { kind: 'error' });
    }
  };
  const flushNow = () => run({ keepalive: true });
  pending.add(flushNow);
  toast(message, {
    timeout: seconds * 1000,
    action: {
      label: 'Undo',
      onClick: () => {
        settled = true;
        pending.delete(flushNow);
        restore();
      },
    },
    onDismiss: (reason) => {
      if (reason !== 'action') run();
    },
  });
}
