// Live console: WebSocket log stream + RCON command bar with history.
import { toast } from '../lib/toast.js';
import { friendlyError } from '../lib/errors.js';
import { setBusy, withBusy } from '../lib/loading.js';
import { fmtBytes, escapeHtml } from '../lib/format.js';
import { openModal } from '../lib/modal.js';
import { undoableDelete } from '../lib/undo.js';

const log = document.getElementById('console-log');
const input = document.getElementById('console-input');
const root = document.querySelector('[data-console-server]');
if (root && log) init(root.dataset.consoleServer);

function init(serverId) {
  const history = [];
  let historyIdx = -1;
  let autoScroll = true;
  let ws = null;
  let reconnectDelay = 1000;
  // Reconnect cadence after a clean stream end (server stopped) - see the close
  // handler for why this can't share the exponential backoff above.
  const STOPPED_RETRY_MS = 5000;
  // Server-rendered initial lines show instantly; the WS resends the same tail
  // on connect, so the first 'log' batch replaces them instead of duplicating.
  let clearedInitial = false;
  const MAX_LINES = 3000;
  log.scrollTop = log.scrollHeight;

  // ---- "Announce as" label: attribute panel console commands in game chat ----
  document.getElementById('console-label-save')?.addEventListener('click', (e) =>
    withBusy(e.currentTarget, 'Saving…', async () => {
      const label = document.getElementById('console-label').value.trim();
      try {
        const res = await fetch(`/api/servers/${serverId}/console-label`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ label }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) {
          toast(data.error || friendlyError(res, { action: 'save that label' }), { kind: 'error' });
          return;
        }
        toast(
          data.label
            ? `Console commands now announce as "[${data.label}]" in chat.`
            : 'Console announcements turned off.'
        );
      } catch {
        toast(friendlyError(null, { action: 'save that label' }), { kind: 'error' });
      }
    })
  );

  // ---- Rotated game-log files (logs/*.log.gz next to latest.log) ----
  (async () => {
    const box = document.querySelector('[data-console-logfiles]');
    if (!box) return;
    try {
      const res = await fetch(`/api/servers/${serverId}/logs/game`);
      const data = await res.json().catch(() => ({}));
      // latest.log is already a menu item; list only the rotated history here.
      const rotated = (data.files || []).filter((f) => f.file !== 'latest.log');
      if (!res.ok || !rotated.length) return;
      box.querySelector('[data-console-logfiles-count]').textContent = `(${rotated.length})`;
      box.querySelector('[data-console-logfiles-list]').innerHTML = rotated
        .map(
          (f) => `
        <a class="flex items-center justify-between gap-3 px-3 py-1.5 hover:bg-inset" download
           href="/api/servers/${serverId}/logs/game/${encodeURIComponent(f.file)}">
          <span class="min-w-0 truncate font-mono">${escapeHtml(f.file)}</span>
          <span class="shrink-0 text-ink-faint">${fmtBytes(f.size)}</span>
        </a>`
        )
        .join('');
      box.hidden = false;
    } catch {
      /* offline / no logs dir yet - leave the section hidden */
    }
  })();

  const filters = { INFO: true, WARN: true, ERROR: true };
  const filterInput = document.getElementById('console-filter');

  // The panel opens a short-lived RCON connection every poll cycle, so the
  // server logs this pair of lines every ~20s. They classify as INFO, so the
  // level checkboxes can't isolate them - hence a dedicated toggle. Kept tight
  // so panel-issued "[rcon]: …" command output is never matched. The last entry
  // catches the plugin echo ("[Essentials] Rcon issued server command: /…", and
  // the plain "[Server] …" core variant) for the read-only polls the panel runs
  // on a timer: `list` for player counts, and `time query …` / bare `gamerule
  // <name>` reads while the World Controls page is open. Scoped to those forms
  // so a state-changing command you type (time set, gamerule x true, …) shows.
  // Every pattern is anchored to the log-line body right after the
  // "[thread/LEVEL]: " prefix (optionally a "[Plugin] " tag), so a player
  // saying "Thread RCON Client started" in chat ("<Steve> ...") never matches.
  const RCON_NOISE = [
    /\]:\s*Thread RCON Client\b.*\b(started|shutting down)\b/i,
    /\]:\s*Thread RCON Listener started\b/i,
    /\]:\s*RCON running on \b/i,
    /\]:\s*(?:\[[^\]]+\]\s*)?Rcon issued server command:\s*\/?(list|time query \w+|gamerule \S+)\s*$/i,
  ];
  let hideRconNoise = true;
  try {
    hideRconNoise = localStorage.getItem('msm-console-hide-rcon') !== '0';
  } catch {
    /* private mode / storage disabled - keep the default */
  }

  function classify(text) {
    if (/\/(ERROR|FATAL)\]/.test(text)) return 'ERROR';
    if (/\/WARN\]/.test(text)) return 'WARN';
    return 'INFO';
  }

  // ANSI SGR → colored spans (mc-image-helper and rcon-cli colorize output).
  // Where the brand ramps cover an ANSI hue (red/green/yellow/grays/white)
  // the values come from them; blue/magenta/cyan keep neutral defaults - ANSI
  // semantics beat palette purity for log readability, and the brand has no
  // blue or purple ramp to borrow from.
  const ANSI_COLORS = {
    30: '#555e68', // stone-600
    31: '#f87171', // redstone-400
    32: '#59c53e', // grass-400
    33: '#f3ca56', // gold-300
    34: '#60a5fa',
    35: '#c084fc',
    36: '#3cc5c7', // diamond-400
    37: '#d3d7db', // stone-200
    90: '#6a747f', // stone-500
    91: '#fca5a5', // redstone-300
    92: '#7fd965', // grass-300
    93: '#f7e090', // gold-200
    94: '#93c5fd',
    95: '#d8b4fe',
    96: '#6ce0dd', // diamond-300
    97: '#f4f5f6', // stone-50
  };
  function renderAnsi(target, text) {
    // Tolerate both real escapes (\x1b[…m) and bare "[0;39m" fragments that
    // survive log demuxing with the ESC byte lost.
    const parts = text.split(/(?:\x1b|)?\[([0-9;]{1,12})m/);
    if (parts.length === 1) {
      target.textContent = text;
      return;
    }
    let color = null;
    let bold = false;
    for (let i = 0; i < parts.length; i++) {
      if (i % 2 === 1) {
        for (const code of parts[i].split(';').map(Number)) {
          if (code === 0 || code === 39) {
            color = null;
            bold = false;
          } else if (code === 1) bold = true;
          else if (ANSI_COLORS[code]) color = ANSI_COLORS[code];
        }
      } else if (parts[i]) {
        const span = document.createElement('span');
        span.textContent = parts[i];
        if (color) span.style.color = color;
        if (bold) span.style.fontWeight = '700';
        target.appendChild(span);
      }
    }
  }

  // Build one log row. Visibility is applied by the caller so a whole batch
  // shares one compiled filter.
  function buildLine(text) {
    const level = classify(text);
    const div = document.createElement('div');
    div.dataset.level = level;
    // Raw palette steps on purpose: the console is always dark, and the
    // semantic warn/danger tokens flip to 700-steps in light mode (invisible
    // here). See the .console note in input.css.
    if (level === 'WARN') div.className = 'text-gold-300';
    if (level === 'ERROR') div.className = 'text-redstone-400';
    renderAnsi(div, text);
    return div;
  }

  // Append a batch of lines with one DOM insert, one trim, one scroll, and one
  // no-match check - a boot backlog is thousands of lines in a single message.
  function appendLines(texts) {
    if (!texts.length) return;
    // A command reply can arrive before any WS log batch (stopped server) -
    // the full-height placeholder would otherwise push it out of view.
    log.querySelector('[data-console-empty]')?.remove();
    const matches = makeMatcher();
    const frag = document.createDocumentFragment();
    for (const text of texts) {
      const div = buildLine(text);
      applyVisibility(div, matches);
      frag.appendChild(div);
    }
    log.appendChild(frag);
    let excess = log.childElementCount - MAX_LINES;
    while (excess-- > 0) log.firstElementChild.remove();
    if (autoScroll) log.scrollTop = log.scrollHeight;
    else noteUnseen(texts.length);
    syncNoMatch();
  }

  // ---- "Jump to Latest" pill: counts lines that arrived while scrolled up ----
  const latestBtn = document.querySelector('[data-console-latest]');
  const latestLabel = document.querySelector('[data-console-latest-label]');
  let unseen = 0;
  function noteUnseen(n) {
    if (!latestBtn) return;
    unseen += n;
    latestLabel.textContent = `${unseen > 999 ? '999+' : unseen} New ${unseen === 1 ? 'Line' : 'Lines'}`;
    latestBtn.hidden = false;
  }
  function clearUnseen() {
    unseen = 0;
    if (latestBtn) latestBtn.hidden = true;
  }
  latestBtn?.addEventListener('click', () => {
    log.scrollTop = log.scrollHeight;
    autoScroll = true;
    clearUnseen();
  });

  function appendLine(text) {
    appendLines([text]);
  }

  // The filter box compiled once per batch (not once per line): a /regex/ form
  // is parsed a single time, a plain query is lowercased a single time.
  function makeMatcher() {
    const q = filterInput ? filterInput.value.trim() : '';
    if (!q) return () => true;
    if (q.startsWith('/') && q.endsWith('/') && q.length > 2) {
      let re = null;
      try {
        re = new RegExp(q.slice(1, -1), 'i');
      } catch {
        return () => true;
      }
      return (el) => re.test(el.textContent);
    }
    const needle = q.toLowerCase();
    return (el) => el.textContent.toLowerCase().includes(needle);
  }

  function applyVisibility(el, matches = makeMatcher()) {
    const noisy = hideRconNoise && RCON_NOISE.some((re) => re.test(el.textContent));
    el.classList.toggle('hidden', !filters[el.dataset.level] || !matches(el) || noisy);
  }

  function refilter() {
    const matches = makeMatcher();
    log.querySelectorAll('[data-level]').forEach((el) => applyVisibility(el, matches));
    syncNoMatch();
  }

  // Filters hiding every line left a silent black box, indistinguishable from
  // "no output" - say so instead. Two early-exit selector lookups, not a scan
  // of every row.
  function syncNoMatch() {
    const hasLines = log.querySelector('[data-level]') !== null;
    const anyVisible = log.querySelector('[data-level]:not(.hidden)') !== null;
    let note = log.querySelector('[data-console-nomatch]');
    if (hasLines && !anyVisible) {
      if (!note) {
        note = document.createElement('div');
        note.dataset.consoleNomatch = '';
        note.className = 'py-2 text-center text-stone-500';
        note.textContent = 'No lines match the current filters.';
        log.appendChild(note);
      }
    } else if (note) {
      note.remove();
    }
  }

  // One visible marker while the stream is down - the log just stopping is
  // indistinguishable from a quiet server.
  let disconnectNote = null;
  // Set when the last close was a clean 'log-end' (server not running) rather
  // than a dropped socket - drives the slow reconnect cadence below.
  let streamEnded = false;
  function connect() {
    // Reconnecting after a clean stream end re-tails the container: the broker
    // replays the last lines, which are already on screen. Replace the log with
    // that batch instead of appending it again (and again, every poll) - and
    // keep the "server is stopped" note until real output arrives.
    const retailing = streamEnded;
    if (retailing) clearedInitial = false;
    streamEnded = false;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws/console/${serverId}`);
    ws.addEventListener('open', () => {
      reconnectDelay = 1000;
      if (disconnectNote && !retailing) {
        disconnectNote.remove();
        disconnectNote = null;
      }
    });
    ws.addEventListener('message', (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg.kind === 'log') {
        if (!clearedInitial) {
          clearedInitial = true;
          log.innerHTML = '';
          disconnectNote = null; // wiped with the rest of the log
        }
        appendLines(msg.text.split(/\r?\n/).filter((line) => line.trim()));
      } else if (msg.kind === 'cmd-result') {
        ackPending();
        if (msg.error) appendLine(`[panel/ERROR]: ${msg.error}`);
        else if (msg.output) appendLines(msg.output.split(/\r?\n/).map((line) => `[rcon]: ${line}`));
        else appendLine(`[rcon]: (no output) /${msg.command}`);
      } else if (msg.kind === 'error') {
        ackPending();
        appendLine(`[panel/WARN]: ${msg.message}`);
      } else if (msg.kind === 'log-end') {
        // The upstream docker log stream ended (server stopped / restarted).
        // The server keeps this socket open, so drive the reconnect ourselves -
        // on the slow "stopped" cadence, since retrying at once just re-tails a
        // container that produces no output until it starts again.
        streamEnded = true;
        ws.close();
      }
    });
    ws.addEventListener('close', () => {
      ackAllPending(); // no ack is coming - release busy send controls
      if (!disconnectNote) {
        disconnectNote = document.createElement('div');
        disconnectNote.className = 'text-gold-300';
        disconnectNote.textContent = streamEnded
          ? '[panel/WARN]: Server is stopped. Watching for it to start again…'
          : '[panel/WARN]: Log stream disconnected. Reconnecting…';
        log.appendChild(disconnectNote);
        if (autoScroll) log.scrollTop = log.scrollHeight;
      }
      // A clean stream end means the server is not running, but our WS server
      // still accepts the upgrade - so 'open' fires on every reconnect and
      // resets the backoff, leaving a ~1s loop that re-tails a stopped
      // container forever. Poll on a slow fixed cadence instead; keep the
      // exponential backoff for genuine drops (network blips, panel restart).
      if (streamEnded) {
        setTimeout(connect, STOPPED_RETRY_MS);
      } else {
        setTimeout(connect, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, 15000);
      }
    });
  }
  connect();

  // Pause auto-scroll when the user scrolls up; resume at bottom.
  log.addEventListener(
    'scroll',
    () => {
      autoScroll = log.scrollTop + log.clientHeight >= log.scrollHeight - 24;
      if (autoScroll && unseen) clearUnseen();
    },
    { passive: true }
  );

  // Phones: when the on-screen keyboard opens it shrinks the visual viewport
  // and can cover the command box. Keep the box in view while it has focus.
  if (input && window.visualViewport) {
    const keepInView = () => {
      if (document.activeElement === input) input.scrollIntoView({ block: 'nearest' });
    };
    input.addEventListener('focus', () => setTimeout(keepInView, 300));
    window.visualViewport.addEventListener('resize', keepInView);
  }

  initWakeLock();

  // Phone: the Options button shows or hides the folded toolbar.
  const toolsBtn = document.querySelector('[data-console-tools-toggle]');
  const tools = document.querySelector('[data-console-tools]');
  toolsBtn?.addEventListener('click', () => {
    const open = tools.classList.contains('hidden');
    tools.classList.toggle('hidden', !open);
    tools.classList.toggle('flex', open);
    toolsBtn.setAttribute('aria-expanded', String(open));
  });

  if (filterInput) filterInput.addEventListener('input', refilter);
  document.querySelectorAll('[data-level-filter]').forEach((cb) => {
    cb.addEventListener('change', () => {
      filters[cb.dataset.levelFilter] = cb.checked;
      refilter();
    });
  });

  const noiseToggle = document.getElementById('console-hide-rcon');
  if (noiseToggle) {
    noiseToggle.checked = hideRconNoise;
    noiseToggle.addEventListener('change', () => {
      hideRconNoise = noiseToggle.checked;
      try {
        localStorage.setItem('msm-console-hide-rcon', hideRconNoise ? '1' : '0');
      } catch {
        /* storage disabled - the toggle still works for this session */
      }
      refilter();
    });
  }
  // The server-rendered initial tail is visible until something filters it -
  // run one pass now so a stored "hide" preference applies before any WS line.
  refilter();

  // The send control stays busy until the RCON response (cmd-result/error) or
  // ws ack arrives. Entries self-remove; a failsafe timeout catches lost acks.
  const pendingAcks = [];
  function ackPending() {
    if (pendingAcks.length) pendingAcks[0]();
  }
  function ackAllPending() {
    while (pendingAcks.length) pendingAcks[0]();
  }

  const sendBtn = document.getElementById('console-send');

  function send(command, trigger) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      toast('Console not connected yet.', { kind: 'error' });
      return;
    }
    if (trigger) {
      const restore = setBusy(trigger);
      const entry = () => {
        clearTimeout(timer);
        restore();
        const i = pendingAcks.indexOf(entry);
        if (i !== -1) pendingAcks.splice(i, 1);
      };
      const timer = setTimeout(entry, 15000);
      pendingAcks.push(entry);
    }
    // The UI advertises slash-less input (the decorative "/" prefix box) -
    // honor a habitual "/list" instead of sending it verbatim.
    command = command.replace(/^\//, '');
    ws.send(JSON.stringify({ kind: 'cmd', command }));
    if (history[history.length - 1] !== command) history.push(command); // no dupes back-to-back
    historyIdx = history.length;
  }

  if (input) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && input.value.trim()) {
        send(input.value.trim(), sendBtn);
        input.value = '';
      } else if (e.key === 'ArrowUp') {
        if (historyIdx > 0) input.value = history[--historyIdx] || '';
        e.preventDefault();
      } else if (e.key === 'ArrowDown') {
        if (historyIdx < history.length) input.value = history[++historyIdx] || '';
        e.preventDefault();
      }
    });
  }
  if (sendBtn)
    sendBtn.addEventListener('click', () => {
      if (input.value.trim()) {
        send(input.value.trim(), sendBtn);
        input.value = '';
      }
    });
  // Built-in and custom chips alike: one delegated handler (custom ones are
  // re-rendered after every edit).
  document.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-quick-cmd]');
    if (chip && !e.target.closest('[data-quick-remove]')) send(chip.dataset.quickCmd, chip);
  });
  initCustomQuick();
  initLineCopy();
}

// ---- Custom quick buttons (per server, shared by every admin) ----
function initCustomQuick() {
  const host = document.querySelector('[data-quick-custom]');
  const addBtn = document.querySelector('[data-quick-add]');
  if (!host || !addBtn) return;
  const serverId = host.dataset.serverId;
  let list = [];
  try {
    list = JSON.parse(host.dataset.quick || '[]') || [];
  } catch {
    list = [];
  }

  const render = () => {
    host.replaceChildren(
      ...list.map((c, i) => {
        const chip = document.createElement('span');
        chip.className = 'chip cursor-pointer gap-1 pr-1';
        chip.dataset.quickCmd = c.command;
        chip.setAttribute('role', 'button');
        chip.tabIndex = 0;
        chip.dataset.tip = `Runs: ${c.command}`;
        const label = document.createElement('span');
        label.textContent = c.label;
        const x = document.createElement('button');
        x.type = 'button';
        x.className = 'grid size-5 place-items-center rounded-sm text-ink-faint hover:text-danger';
        x.dataset.quickRemove = String(i);
        x.setAttribute('aria-label', `Remove ${c.label}`);
        x.textContent = '×';
        chip.append(label, x);
        chip.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            chip.click();
          }
        });
        return chip;
      })
    );
  };
  const save = (next, opts = {}) =>
    fetch(`/api/servers/${encodeURIComponent(serverId)}/console-quick`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commands: next }),
      ...opts,
    });

  host.addEventListener('click', (e) => {
    const x = e.target.closest('[data-quick-remove]');
    if (!x) return;
    e.stopPropagation();
    const i = Number(x.dataset.quickRemove);
    const before = list.slice();
    const removed = list[i];
    undoableDelete({
      message: `Removed the ${removed.label} button.`,
      hide: () => {
        list = before.filter((_, j) => j !== i);
        render();
      },
      restore: () => {
        list = before;
        render();
      },
      commit: (opts) => save(list, opts),
      failed: 'remove that button',
    });
  });

  addBtn.addEventListener('click', () => {
    const content = document.createElement('div');
    content.className = 'space-y-3';
    content.innerHTML = `
      <div><label class="label" for="qb-label">Button name</label>
        <input class="input" id="qb-label" maxlength="32" placeholder="Night vision for everyone" autocomplete="off"></div>
      <div><label class="label" for="qb-cmd">Command</label>
        <input class="input font-mono" id="qb-cmd" maxlength="256" placeholder="effect give @a night_vision 600" autocomplete="off" spellcheck="false">
        <p class="help">Runs on the server console, exactly as if typed above. No leading slash needed.</p></div>`;
    openModal({
      title: 'Add a Quick Button',
      content,
      actions: [
        { label: 'Cancel', kind: 'ghost' },
        {
          label: 'Add Button',
          kind: 'primary',
          busyLabel: 'Adding…',
          onClick: async () => {
            const label = content.querySelector('#qb-label').value.trim();
            const command = content.querySelector('#qb-cmd').value.trim();
            if (!label || !command) {
              toast('Give the button a name and a command.', { kind: 'error' });
              return false;
            }
            const next = [...list, { label, command }];
            const res = await save(next).catch(() => null);
            const data = res ? await res.json().catch(() => ({})) : {};
            if (!res || !res.ok || data.ok === false) {
              toast(data.error || friendlyError(res, { action: 'add that button' }), { kind: 'error' });
              return false;
            }
            list = data.commands;
            render();
            toast(`Added the ${label} button.`);
          },
        },
      ],
    });
    setTimeout(() => content.querySelector('#qb-label')?.focus(), 50);
  });

  render();
}

// ---- Click a console line to copy it ----
// A plain click copies that one line. Selecting text (to copy several lines)
// works as before: a click that ends a selection copies nothing.
function initLineCopy() {
  if (!log) return;
  log.title = 'Click a line to copy it. Select text to copy several lines.';
  log.addEventListener('click', async (e) => {
    const sel = window.getSelection();
    if (sel && sel.toString().trim()) return;
    const line = e.target.closest('#console-log > [data-level], #console-log > div:not([data-console-empty])');
    if (!line || line.parentElement !== log || line.matches('[data-console-empty]')) return;
    const text = line.textContent.trim();
    if (!text) return;
    if (await window.CD.copyText(text)) {
      line.classList.add('bg-white/10');
      setTimeout(() => line.classList.remove('bg-white/10'), 600);
      toast('Line copied.');
    }
  });
}

// "Keep Screen On": holds a screen wake lock while the console is open. The
// browser drops the lock whenever the tab is hidden, so it is taken again on
// return. The choice is remembered per device.
function initWakeLock() {
  const btn = document.querySelector('[data-wake-lock]');
  if (!btn || !('wakeLock' in navigator)) return;
  btn.hidden = false;
  const KEY = 'msm-console-wake';
  let want = false;
  let lock = null;
  try {
    want = localStorage.getItem(KEY) === '1';
  } catch {
    /* storage blocked */
  }
  const paint = () => {
    btn.setAttribute('aria-pressed', String(want));
    btn.classList.toggle('btn-primary', want);
  };
  const acquire = async () => {
    if (!want || lock || document.visibilityState !== 'visible') return;
    try {
      lock = await navigator.wakeLock.request('screen');
      lock.addEventListener('release', () => {
        lock = null;
      });
    } catch {
      // Refused (battery saver, no user gesture yet): leave the toggle as is.
      lock = null;
    }
  };
  btn.addEventListener('click', async () => {
    want = !want;
    try {
      localStorage.setItem(KEY, want ? '1' : '0');
    } catch {
      /* storage blocked */
    }
    paint();
    if (want) {
      await acquire();
      if (!lock) toast('Your browser would not keep the screen on right now.', { kind: 'warn' });
    } else if (lock) {
      await lock.release().catch(() => {});
      lock = null;
    }
  });
  document.addEventListener('visibilitychange', acquire);
  paint();
  acquire();
}
