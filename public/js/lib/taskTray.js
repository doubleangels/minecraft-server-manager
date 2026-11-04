// Global task tray: running tasks (pack installs, backups, upgrades…) stay
// visible from ANY page with live progress - surviving navigation, unlike the
// per-action modal. Polls /api/tasks; hidden when idle.
import { toast } from './toast.js';

const mount = document.getElementById('task-tray');
if (mount) init();

function init() {
  const btn = mount.querySelector('button');
  const badge = mount.querySelector('[data-task-count]');
  const ring = mount.querySelector('[data-task-ring]');
  const panel = mount.querySelector('[data-task-panel]');
  const list = mount.querySelector('[data-task-list]');
  const known = new Map(); // id -> last seen state (for completion toasts)
  let open = false;

  const setOpen = (v) => {
    open = v;
    panel.classList.toggle('hidden', !open);
    btn.setAttribute('aria-expanded', String(open));
  };
  btn.setAttribute('aria-expanded', 'false');
  btn.setAttribute('aria-haspopup', 'true');
  btn.addEventListener('click', () => setOpen(!open));
  document.addEventListener('click', (e) => {
    if (open && !mount.contains(e.target)) setOpen(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && open) {
      setOpen(false);
      btn.focus();
    }
  });

  async function poll() {
    dueAt = 0;
    let data;
    try {
      const res = await fetch('/api/tasks');
      data = await res.json();
    } catch {
      schedule(8000);
      return;
    }
    const tasks = data.tasks || [];
    const running = tasks.filter((t) => t.state === 'running');

    // Completion notifications for tasks we watched go by.
    for (const t of tasks) {
      const prev = known.get(t.id);
      if (prev === 'running' && t.state !== 'running') {
        // Titles end in an ellipsis while running ("Backing up Alpha…").
        const name = t.title.replace(/…$/, '');
        toast(t.state === 'done' ? `${name} finished.` : `${name} failed.${t.error ? ` ${t.error}` : ''}`, {
          kind: t.state === 'done' ? 'success' : 'error',
          timeout: 7000,
        });
      }
      known.set(t.id, t.state);
    }

    mount.classList.toggle('hidden', tasks.length === 0);
    badge.textContent = String(running.length || tasks.length);
    // Swap the background explicitly - stacking bg-ok onto the baked-in
    // bg-inset leaves the winner to stylesheet order, not intent.
    badge.classList.toggle('bg-ok', running.length > 0);
    badge.classList.toggle('text-canvas', running.length > 0);
    badge.classList.toggle('bg-inset', running.length === 0);
    ring.classList.toggle('hidden', running.length === 0);

    // Rebuilding every poll resets the open panel's scroll mid-read - keep it.
    const scrollTop = list.scrollTop;
    list.innerHTML = '';
    for (const t of tasks) {
      // A server's task links to that server, so the tray doubles as a way back.
      const row = document.createElement(t.serverId ? 'a' : 'div');
      if (t.serverId) row.href = `/servers/${encodeURIComponent(t.serverId)}`;
      row.className = 'block space-y-1 border-b border-line p-3 text-sm last:border-0 hover:bg-raised';
      const pct = t.percent != null ? t.percent : t.state === 'running' ? null : 100;
      row.innerHTML = `
        <div class="flex items-center gap-2">
          <span class="min-w-0 flex-1 truncate font-medium"></span>
          <span class="shrink-0 text-[11px] ${t.state === 'failed' ? 'text-danger' : t.state === 'done' ? 'text-ok' : 'text-ink-faint'}">
            ${t.state === 'running' ? `${Math.round(t.elapsedMs / 1000)}s` : t.state}
          </span>
        </div>
        <div class="truncate text-xs text-ink-faint" data-step></div>
        <div class="meter h-1.5 ${pct === null ? 'meter-indeterminate' : ''}"><div class="${t.state === 'failed' ? 'bg-danger' : 'bg-ok'}" style="width:${pct === null ? 25 : Math.max(4, pct)}%"></div></div>`;
      row.querySelector('.font-medium').textContent = t.title;
      row.querySelector('[data-step]').textContent = t.step || '';
      list.appendChild(row);
    }
    list.scrollTop = scrollTop;
    if (!tasks.length && open) setOpen(false);
    // A hidden tab only needs to notice completions eventually.
    const hidden = document.visibilityState === 'hidden';
    const next = running.length ? (hidden ? 8000 : 2000) : hidden ? 30000 : 10000;
    schedule(kick != null ? Math.min(kick, next) : next);
    kick = null;
  }

  let timer;
  let dueAt = 0;
  let kick = null; // a pollSoon() that arrived while a poll was in flight
  function schedule(ms) {
    clearTimeout(timer);
    dueAt = Date.now() + ms;
    timer = setTimeout(poll, ms);
  }
  /** Poll within `ms`, unless a poll is already due sooner. */
  function pollSoon(ms) {
    const left = dueAt - Date.now();
    if (left <= 0) kick = kick == null ? ms : Math.min(kick, ms);
    else if (left > ms) schedule(ms);
  }

  // Any write to the API may have started a tracked task (Start, a backup, a
  // mod update…). Look shortly after it is sent, so the tray shows the task
  // while it runs instead of up to 10 seconds later, and again once it answers.
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const method = String((init && init.method) || (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
    const path = url.startsWith('http') ? new URL(url).pathname : url;
    if (method !== 'GET' && path.startsWith('/api/') && !path.startsWith('/api/tasks')) {
      pollSoon(600);
      const p = nativeFetch(input, init);
      p.finally(() => pollSoon(300)).catch(() => {});
      return p;
    }
    return nativeFetch(input, init);
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') pollSoon(100);
  });
  poll();
}
