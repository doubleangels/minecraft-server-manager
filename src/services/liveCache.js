'use strict';

// Live-data cache: one stats stream + periodic player-list per RUNNING server,
// held in memory so page renders and the public status page never block on
// Docker (a one-shot `docker stats` costs ~2s; `docker exec rcon-cli list`
// ~0.5s). Everything reads from here; nothing user-facing calls Docker inline.

const path = require('node:path');
const db = require('../db');
const { statsStream, statsOnce } = require('../docker/stats');
const { execCaptureChecked, inspectStatus } = require('../docker/containers');
const { rconCommand, closeRcon } = require('./rconClient');

/**
 * Run a polling RCON command: over the kept-open direct connection when it
 * works, else `docker exec rcon-cli` as before. Same { stdout, exitCode }
 * shape either way; a direct reply counts as a clean exit.
 * @param {string} serverId
 * @param {string[]} cmd an rcon-cli command line, e.g. ['rcon-cli', 'list']
 */
async function rconPoll(serverId, cmd) {
  try {
    return { stdout: await rconCommand(serverId, cmd.slice(1)), exitCode: 0 };
  } catch {
    return execCaptureChecked(serverId, cmd);
  }
}
const { fetchLogs } = require('../docker/logs');
const { parsePlayerList } = require('../utils/rconList');
const { parseTps } = require('../utils/rconTps');
const { cleanText } = require('../utils/ansi');
const logger = require('../logger')(path.basename(__filename));
const { serializeError } = require('../utils/logSanitize');
const { makeFailureThrottle } = require('../logger');

const syncThrottle = makeFailureThrottle();

// Boot-phase detection: a modded first boot passes through many meaningful
// states - surface them instead of a flat "starting/unhealthy". Ordered by
// precedence (later pipeline stages win when several match the tail).
const PHASES = [
  {
    key: 'pack-download',
    re: /Downloading modpack|Downloading.*server pack|install-(curseforge|modrinth)/i,
    label: 'Downloading modpack',
  },
  { key: 'mods-download', re: /Downloaded mod file|Downloading mods|Downloaded \d+ files/i, label: 'Downloading mods' },
  {
    key: 'loader-install',
    re: /Running (the )?.*(NeoForge|Forge|Fabric|Quilt).*installer|installer for Minecraft/i,
    label: 'Installing mod loader',
  },
  {
    key: 'server-download',
    re: /Downloading (Paper|Purpur|server jar)|Downloading.*minecraft_server/i,
    label: 'Downloading server',
  },
  {
    key: 'mod-loading',
    re: /Loading \d+ mods|mixin|ModLauncher|Bootstrap|Fabric Loader|FML.*load/i,
    label: 'Loading mods',
  },
  {
    key: 'world-gen',
    re: /Preparing level|Preparing start region|Preparing spawn|Generating keypair/i,
    label: 'Generating world',
  },
  { key: 'done', re: /Done \([\d.]+s\)/, label: 'Finishing startup' },
];

function classifyPhase(logTail) {
  let found = null;
  for (const phase of PHASES) {
    if (phase.re.test(logTail)) found = phase; // last (deepest) match wins
  }
  if (!found) return null;
  if (found.key === 'mods-download') {
    const count = (logTail.match(/Downloaded mod file/g) || []).length;
    return { key: found.key, label: count > 1 ? `Downloading mods (${count} in the last minute)` : found.label };
  }
  return { key: found.key, label: found.label };
}

const entries = new Map(); // serverId -> {stats, players, uptimeStartedAt, stopStats, timers}
let syncTimer = null;
let syncing = false;

const EMPTY = {
  stats: null,
  players: null,
  startedAt: null,
  phase: null,
  upConfirmed: false,
  perf: null,
  perfSupported: true,
};

// Tick-performance probes, tried in order until one answers. Whichever works is
// remembered per server so later polls are a single RCON call.
const PERF_PROBES = [
  ['rcon-cli', 'spark', 'tps'],
  ['rcon-cli', 'tps'],
  ['rcon-cli', 'forge', 'tps'],
  ['rcon-cli', 'neoforge', 'tps'],
];

function snapshot(e) {
  return {
    stats: e.stats || null,
    players: e.players || null,
    startedAt: e.startedAt || null,
    phase: e.phase || null,
    upConfirmed: e.upConfirmed || false,
    // Tick performance (TPS / MSPT), or null on server types that don't report
    // it. `perfSupported` is false once every probe command has been tried and
    // none worked - the UI uses it to say "not reported" instead of "loading".
    perf: e.perf || null,
    perfSupported: e.perfSupported !== false,
  };
}

function get(serverId) {
  const e = entries.get(serverId);
  if (!e) return EMPTY;
  return snapshot(e);
}

function getAll() {
  const out = {};
  for (const [id, e] of entries) out[id] = snapshot(e);
  return out;
}

/**
 * The status-detail chip for a live entry, or null when there's nothing to
 * show. One definition shared by the SSR view model and the live-poll JSON
 * route, so the label a page renders on load can't drift from the one the
 * poll swaps in. While the server hasn't answered rcon yet the boot phase
 * wins; "Player count unavailable" is the latched "rcon answers but /list is
 * unparseable" state; a parsed player list means neither applies.
 */
function statusDetail(live) {
  if (live.players) return null;
  if (live.phase) return live.phase.label;
  if (live.upConfirmed) return 'Player count unavailable';
  return null;
}

// ---- Stats: a per-second Docker stats stream only while someone watches ----
// A stats stream costs the Docker daemon a cgroup read every second per
// server, all day. Any open panel tab polls /api/servers/live every few
// seconds (touch()), and the server page's live graph subscribes directly; when
// neither has happened lately the streams close and each running server gets
// one sample a minute instead (enough for the public API and alerts).
const WATCH_MS = 45_000;
const PERF_IDLE_MS = 60_000;
const IDLE_SAMPLE_MS = 60_000;
let lastWatchedAt = 0;

/** Someone is looking at live numbers: stream every running server's stats. */
function touch() {
  const wasIdle = Date.now() - lastWatchedAt >= WATCH_MS;
  lastWatchedAt = Date.now();
  if (wasIdle) for (const [id, entry] of entries) ensureStream(id, entry);
}

function wantsStream(entry) {
  return entry.subs.size > 0 || Date.now() - lastWatchedAt < WATCH_MS;
}

async function ensureStream(serverId, entry) {
  if (entry.stopStats || entry.streamOpening) return;
  entry.streamOpening = true;
  try {
    const stop = await statsStream(
      serverId,
      (sample) => {
        entry.stats = { ...sample, at: Date.now() };
        for (const sub of entry.subs) sub.onSample(sample);
      },
      {
        // Docker closed the stream (the container restarted in place, which
        // keeps its id, or went away). Drop the entry so the next sync()
        // re-attaches, instead of serving the last sample forever.
        onEnd: () => {
          entry.stopStats = null;
          if (entries.get(serverId) === entry) detach(serverId);
        },
      }
    );
    // Detached, or nobody wants it any more, while it was connecting.
    if (entries.get(serverId) !== entry) stop();
    else entry.stopStats = stop;
  } catch (err) {
    for (const sub of entry.subs) sub.onError(err);
  } finally {
    entry.streamOpening = false;
  }
}

function stopStream(entry) {
  if (!entry.stopStats) return;
  const stop = entry.stopStats;
  entry.stopStats = null;
  try {
    stop();
  } catch {
    /* closed */
  }
}

/** Unwatched: one sample a minute instead of a stream. */
async function sampleIdle(serverId, entry) {
  if (entry.stats && Date.now() - entry.stats.at < IDLE_SAMPLE_MS) return;
  try {
    const sample = await statsOnce(serverId);
    if (sample) entry.stats = { ...sample, at: Date.now() };
  } catch {
    /* container gone - sync() will detach */
  }
}

/**
 * Live stats for one running server, sample by sample, on the cache's own
 * stream (one Docker stream per server however many tabs watch).
 * @returns {Promise<() => void>} unsubscribe
 */
async function subscribeStats(serverId, onSample, onError, onEnd) {
  let entry = entries.get(serverId);
  if (!entry) {
    await sync();
    entry = entries.get(serverId);
  }
  if (!entry) {
    onError(new Error('The server is not running.'));
    return () => {};
  }
  const sub = { onSample, onError, onEnd };
  entry.subs.add(sub);
  ensureStream(serverId, entry);
  return () => {
    entry.subs.delete(sub);
    // The last graph closed and no tab is polling: close the stream now.
    if (!wantsStream(entry)) stopStream(entry);
  };
}

async function attach(serverId, containerId = null) {
  if (entries.has(serverId)) return;
  const entry = {
    stats: null,
    players: null,
    startedAt: null,
    upConfirmed: false,
    stopStats: null,
    playerTimer: null,
    perf: null,
    perfCmd: null, // array once a probe works, false once all have been tried
    perfSupported: true,
    perfTimer: null,
    containerId,
    streamOpening: false,
    // Live-stats subscribers (the server page's graph over /ws/stats).
    subs: new Set(),
  };
  entries.set(serverId, entry);

  try {
    const info = await inspectStatus(serverId);
    entry.startedAt = info.startedAt || null;
  } catch {
    /* leave null */
  }

  if (wantsStream(entry)) await ensureStream(serverId, entry);
  else await sampleIdle(serverId, entry);

  // detach() may have run while the awaits above were in flight (the server
  // stopped, or a recreate swapped the container). This entry is orphaned: stop
  // its stream and do not start timers nobody will ever clear.
  if (entries.get(serverId) !== entry) {
    if (entry.stopStats) {
      try {
        entry.stopStats();
      } catch {
        /* closed */
      }
    }
    return;
  }

  let playersInFlight = false;
  let lastRestartCheckAt = 0;
  const refreshPlayers = async () => {
    if (playersInFlight) return; // don't stack calls if one is slow/hung
    playersInFlight = true;
    try {
      // A container restart the cache didn't see must reset the latched state,
      // or the old boot's player list / upConfirmed survive into the new boot
      // as convincing-but-stale live data (verified live: a panel restart shows
      // the previous list for the whole reboot and suppresses boot phases).
      // sync() only detaches when the DB status leaves running/starting, and a
      // restart's die→start usually completes inside one 10s sync interval, so
      // the entry never detaches; a missed 'start' Docker event (the events
      // stream reconnects after drops - see watcher.js's retryLater()) has the
      // same effect. Compare Docker's own StartedAt whenever ANY latched state
      // exists, throttled to once a minute to keep the extra inspect off the
      // 20s hot path.
      if ((entry.upConfirmed || entry.players) && Date.now() - lastRestartCheckAt > 60000) {
        lastRestartCheckAt = Date.now();
        try {
          const info = await inspectStatus(serverId);
          if (info.startedAt && entry.startedAt && info.startedAt !== entry.startedAt) {
            entry.startedAt = info.startedAt;
            entry.players = null; // the old boot's list is not this boot's
            entry.upConfirmed = false;
            entry.phase = null; // let refreshPhase classify the new boot
            entry.perf = null; // re-probe: a recreate may be a different flavor
            entry.perfCmd = null;
            entry.perfSupported = true;
          } else if (info.startedAt && !entry.startedAt) {
            // attach() ran before the container was Running (startedAt null) -
            // record the real boot time WITHOUT treating it as a restart.
            entry.startedAt = info.startedAt;
          }
        } catch {
          /* inspect failed - leave the latch as-is, retry next time */
        }
      }

      const { stdout, exitCode } = await rconPoll(serverId, ['rcon-cli', 'list']);
      const out = cleanText(stdout); // rcon-cli colorizes
      const parsed = parsePlayerList(out);
      if (parsed) {
        entry.players = { ...parsed, at: Date.now() };
        entry.phase = null; // rcon answering = fully up, no boot phase
      } else if (exitCode === 0 && out) {
        // rcon-cli exited successfully - RCON is genuinely answering - but the
        // "/list" phrasing didn't match any known pattern. We can't parse player
        // counts, but a clean exit means the server is fully up - stop deriving
        // the boot-phase label from logs so the UI doesn't get stuck showing
        // e.g. "Finishing startup" forever. A non-zero exit (e.g. rcon-cli's own
        // "connection refused" while RCON isn't listening yet, which docker exec
        // itself treats as a normal successful command) must NOT hit this branch,
        // or every server would latch "up" on its very first, pre-RCON poll.
        entry.upConfirmed = true;
        entry.phase = null;
      }
    } catch {
      /* rcon not up yet - keep last value */
    } finally {
      playersInFlight = false;
    }
  };

  // Boot-phase probe: while the server hasn't answered rcon yet, read a short
  // log tail and classify what the startup pipeline is doing right now.
  let phaseInFlight = false;
  const refreshPhase = async () => {
    if (entry.players || entry.upConfirmed || phaseInFlight) return; // already up, or a probe is running
    phaseInFlight = true;
    try {
      const tail = await fetchLogs(serverId, { tail: 40 });
      entry.phase = classifyPhase(tail) || entry.phase || { key: 'boot', label: 'Starting up' };
    } catch {
      /* container gone - sync() will detach */
    } finally {
      phaseInFlight = false;
    }
  };

  // Tick-performance probe: only once the server actually answers RCON, so a
  // long modded boot isn't spammed with `tps` attempts. Sticks to the first
  // command that works; gives up for the boot once every probe has failed.
  let perfInFlight = false;
  const refreshPerf = async () => {
    if (perfInFlight || entry.perfCmd === false) return;
    if (!(entry.players || entry.upConfirmed)) return;
    // Every 10 s while someone is watching; once a minute otherwise (the
    // public API still gets a fresh-enough number). The player list keeps its
    // 20 s pace: restart warnings read it to decide whether anyone is online.
    if (!wantsStream(entry) && entry.perf && Date.now() - entry.perf.at < PERF_IDLE_MS) return;
    perfInFlight = true;
    try {
      const cmds = entry.perfCmd ? [entry.perfCmd] : PERF_PROBES;
      for (const cmd of cmds) {
        let out;
        try {
          out = cleanText((await rconPoll(serverId, cmd)).stdout);
        } catch {
          continue;
        }
        const perf = parseTps(out);
        if (!perf) continue;
        entry.perf = { ...perf, at: Date.now() };
        entry.perfCmd = cmd;
        entry.perfSupported = true;
        // Paper's `tps` omits MSPT - fill it from `mspt` when we can.
        if (perf.mspt == null && perf.source === 'paper' && cmd[cmd.length - 1] === 'tps') {
          try {
            const m = parseTps(cleanText((await rconPoll(serverId, ['rcon-cli', 'mspt'])).stdout));
            if (m && m.mspt != null) entry.perf.mspt = m.mspt;
          } catch {
            /* mspt is optional */
          }
        }
        return;
      }
      if (!entry.perfCmd) {
        entry.perfCmd = false; // sentinel: probed everything, nothing reports it
        entry.perfSupported = false;
      }
    } finally {
      perfInFlight = false;
    }
  };

  refreshPlayers();
  refreshPhase();
  entry.playerTimer = setInterval(refreshPlayers, 20000);
  entry.playerTimer.unref();
  entry.phaseTimer = setInterval(refreshPhase, 8000);
  entry.phaseTimer.unref();
  entry.perfTimer = setInterval(refreshPerf, 10000);
  entry.refreshPerf = refreshPerf;
  entry.perfTimer.unref();
}

function detach(serverId) {
  closeRcon(serverId);
  const entry = entries.get(serverId);
  if (!entry) return;
  stopStream(entry);
  // Live graphs on this server: their stream is over (stopped or restarted).
  for (const sub of entry.subs) sub.onEnd();
  entry.subs.clear();
  if (entry.playerTimer) clearInterval(entry.playerTimer);
  if (entry.phaseTimer) clearInterval(entry.phaseTimer);
  if (entry.perfTimer) clearInterval(entry.perfTimer);
  entries.delete(serverId);
}

/** Reconcile taps with the set of running servers. */
async function sync() {
  if (syncing) return;
  syncing = true;
  try {
    const rows = db.all('SELECT id, status, container_id FROM servers WHERE deleted_at IS NULL');
    const byId = new Map(rows.map((r) => [r.id, r]));
    const running = new Set(
      // 'stalled' (starting far longer than expected, no 'Done (' yet) is still
      // a live container - keep its stats/players/phase taps attached so the
      // status detail chip that's meant to help diagnose the stall doesn't
      // itself go blank the moment it's flagged.
      rows.filter((r) => ['running', 'starting', 'unhealthy', 'stalled'].includes(r.status)).map((r) => r.id)
    );
    const toAttach = [];
    for (const id of running) {
      const row = byId.get(id);
      const existing = entries.get(id);
      // A recreate (settings change, upgrade, manual "Recreate") never leaves
      // the running/starting/unhealthy family, so status alone can't detect
      // it - without this check the entry never detaches/reattaches, and its
      // stats stream stays bound to the OLD (now-removed) container forever,
      // freezing the dashboard's CPU/mem/network graph at its last sample.
      if (existing && existing.containerId && row.container_id && existing.containerId !== row.container_id) {
        detach(id);
      }
      if (!entries.has(id)) toAttach.push(attach(id, row.container_id || null));
    }
    // Each attach waits on a Docker inspect and a stats-stream open. Run them
    // together, not one after another: after a panel restart with many servers
    // running, the serial loop left the last one blank for N round-trips.
    await Promise.all(toAttach);
    for (const id of [...entries.keys()]) if (!running.has(id)) detach(id);
    // Stream while watched, otherwise close the stream and sample once a minute.
    for (const [id, entry] of entries) {
      if (wantsStream(entry)) ensureStream(id, entry);
      else {
        stopStream(entry);
        sampleIdle(id, entry);
      }
    }
    syncThrottle.ok(logger.info, 'The live-cache reconcile recovered.');
  } catch (err) {
    syncThrottle.fail(logger.warn, 'A live-cache reconcile failed.', {
      err: serializeError(err, { includeStack: false }),
    });
  } finally {
    syncing = false;
  }
}

function startLiveCache({ intervalMs = 10000 } = {}) {
  logger.debug('Started the live-data cache.', { intervalMs });
  sync();
  syncTimer = setInterval(sync, intervalMs);
  syncTimer.unref();
}

/** One-shot fallback for servers not yet in the cache (e.g. just started). */
async function sampleOnce(serverId) {
  try {
    return await statsOnce(serverId);
  } catch {
    return null;
  }
}

module.exports = {
  get,
  getAll,
  classifyPhase,
  statusDetail,
  startLiveCache,
  sync,
  detach,
  sampleOnce,
  touch,
  subscribeStats,
  /** Tests: run one TPS timer tick now. */
  _perfTick: (serverId) => entries.get(serverId)?.refreshPerf?.(),
};
