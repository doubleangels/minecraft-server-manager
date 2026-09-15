'use strict';

// Metrics sampler: snapshots the in-memory live cache once a minute into SQLite
// so the dashboard can chart history instead of only a point-in-time read. The
// live cache gives the current load (covers stopped servers and Docker outages
// as gaps); this module gives the past. Runs only while Docker is reachable
// (see src/server.js), mirroring liveCache and the analytics ingesters. Net
// RX/TX are cumulative counters from Docker, so the stored "per second" rates
// are derived from the delta between two samples.

const db = require('../db');
const logger = require('../logger')('metrics-sampler');
const { makeFailureThrottle } = require('../logger');
const { serializeError } = require('../utils/logSanitize');

const syncThrottle = makeFailureThrottle();

// serverId -> { rx, tx, at } cumulative NIC counters at last sample.
const lastCumulative = new Map();

/**
 * Bytes-per-second rate between two cumulative counter readings.
 * @param {number | undefined} prev
 * @param {number | undefined} cur
 * @param {number} elapsedMs
 * @returns {number}
 */
function rate(prev, cur, elapsedMs) {
  if (prev == null || cur == null) return 0;
  const dt = Math.max(1, elapsedMs) / 1000;
  return Math.max(0, (cur - prev) / dt);
}

/**
 * Build one insertable row for a live-cache entry, or null when the entry has
 * no stats yet (server still attaching its stats stream).
 * @param {string} serverId
 * @param {Record<string, any>} entry
 * @param {Date} now
 * @returns {Record<string, any> | null}
 */
function buildRow(serverId, entry, now) {
  const stats = entry.stats;
  if (!stats) return null;
  const statsAt = typeof stats.at === 'number' ? stats.at : now.getTime();
  const prev = lastCumulative.get(serverId);
  lastCumulative.set(serverId, { rx: stats.netRx, tx: stats.netTx, at: statsAt });

  const perf = entry.perf;
  const players = entry.players;
  const num = (v) => (Number.isFinite(v) ? v : null);
  const int = (v) => (Number.isInteger(v) ? v : null);

  return {
    serverId,
    ts: now.toISOString(),
    cpu_pct: num(stats.cpuPct),
    mem_used_bytes: int(stats.memUsedBytes),
    mem_limit_bytes: int(stats.memLimitBytes),
    net_rx_bps: rate(prev?.rx, stats.netRx, statsAt - (prev?.at ?? statsAt)),
    net_tx_bps: rate(prev?.tx, stats.netTx, statsAt - (prev?.at ?? statsAt)),
    tps: num(perf?.tps1),
    mspt: num(perf?.mspt),
    players_online: int(players?.online),
    players_max: int(players?.max),
  };
}

/**
 * Run one sampling pass. `snapshot` returns the live-cache map (serverId ->
 * entry); injectable for tests. Returns how many rows were written (row count,
 * not server count: a server can only contribute one row per pass).
 * @param {() => Record<string, any>} [snapshot]
 * @param {Date} [now]
 * @returns {{ servers: number, rows: number }}
 */
function sampleNow(snapshot, now = new Date()) {
  const src = snapshot || (() => require('../services/liveCache').getAll());
  const all = src();
  const rows = [];
  const seen = new Set();
  for (const [id, entry] of Object.entries(all)) {
    seen.add(id);
    const row = buildRow(id, entry, now);
    if (row) rows.push(row);
  }
  // Drop cumulative counters for servers that left the live cache (stopped or
  // removed) so a later restart doesn't diff against a stale container's totals.
  for (const id of [...lastCumulative.keys()]) {
    if (!seen.has(id)) lastCumulative.delete(id);
  }

  if (rows.length) {
    db.transaction(() => {
      for (const r of rows) {
        db.run(
          `INSERT INTO metrics_samples
             (server_id, ts, cpu_pct, mem_used_bytes, mem_limit_bytes, net_rx_bps, net_tx_bps, tps, mspt, players_online, players_max)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          r.serverId,
          r.ts,
          r.cpu_pct,
          r.mem_used_bytes,
          r.mem_limit_bytes,
          r.net_rx_bps,
          r.net_tx_bps,
          r.tps,
          r.mspt,
          r.players_online,
          r.players_max
        );
      }
    });
  }
  return { servers: seen.size, rows: rows.length };
}

let timer = null;
let running = false;

/**
 * Start the minute sampler. Mirrors the live-cache loop: a guarded, throttled
 * tick that never throws into the event loop. Returns a stop function.
 * @param {{ intervalMs?: number, snapshot?: () => Record<string, any> }} [opts]
 * @returns {() => void}
 */
function startMetricsSampler({ intervalMs = 60_000, snapshot } = {}) {
  // Live cache is only populated by the running panel; tests call sampleNow()
  // directly with a fake snapshot. The require is deferred to avoid a load-time
  // cycle with liveCache's docker imports.
  const src = snapshot || (() => require('../services/liveCache').getAll());
  const tick = () => {
    if (running) return;
    running = true;
    try {
      const { servers, rows } = sampleNow(src);
      if (rows) {
        // Steady-state rate is one row per server per minute; only log when the
        // shape of the run surprises us (everything suddenly empty is expected
        // when all servers stop - no log, no noise).
        logger.debug('Sampled live metrics.', { servers, rows });
      }
      syncThrottle.ok(logger.info, 'The metrics sampler recovered.');
    } catch (err) {
      syncThrottle.fail(logger.warn, 'A metrics sampling pass failed.', {
        err: serializeError(err, { includeStack: false }),
      });
    } finally {
      running = false;
    }
  };
  tick();
  timer = setInterval(tick, intervalMs);
  timer.unref();
  return () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

module.exports = { startMetricsSampler, sampleNow, buildRow, rate };
