'use strict';

// Metrics aggregation: raw metrics_samples rows in, fixed-width time-bucket
// series out. The dashboard fleet trend and the per-server history both read
// through here. Bucketing is pure and injectable; the two db-backed wrappers at
// the bottom are the only things that touch SQLite.

const db = require('../db');

const RANGES = Object.freeze({
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
});
const DEFAULT_BUCKETS = 120;

const MB = 1024 * 1024;
const KB = 1024;

/**
 * Normalize a raw DB row into a numeric sample.
 * @param {Record<string, any>} row
 * @returns {{ at: number, serverId: string, cpu: number|null, mem: number|null, rx: number|null, tx: number|null, tps: number|null, mspt: number|null, players: number|null }}
 */
function normalize(row) {
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    at: Date.parse(row.ts),
    serverId: row.server_id,
    cpu: num(row.cpu_pct),
    mem: num(row.mem_used_bytes),
    rx: num(row.net_rx_bps),
    tx: num(row.net_tx_bps),
    tps: num(row.tps),
    mspt: num(row.mspt),
    players: num(row.players_online),
  };
}

/**
 * Bucket index for a sample time, clamped into [0, buckets - 1]. Samples older
 * than the window land in the first bucket (the chart starts at now - rangeMs
 * regardless), samples at/after "now" in the last.
 * @param {number} at
 * @param {number} windowStartMs
 * @param {number} stepMs
 * @param {number} buckets
 * @returns {number}
 */
function bucketIndex(at, windowStartMs, stepMs, buckets) {
  const i = Math.floor((at - windowStartMs) / stepMs);
  return Math.max(0, Math.min(buckets - 1, i));
}

/** @param {number[]} values @returns {number | null} */
function avg(values) {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

const round1 = (v) => Math.round(v * 10) / 10;
const round2 = (v) => Math.round(v * 100) / 100;

/**
 * One-server series: per-bucket averages across that server's samples.
 * @param {Array<ReturnType<typeof normalize>>} samples
 * @param {{ rangeMs: number, buckets?: number, nowMs?: number }} opts
 * @returns {Array<{ at: string, cpuPct: number|null, memUsedMb: number|null, netRxKbs: number|null, netTxKbs: number|null, tps: number|null, mspt: number|null, playersOnline: number|null }>}
 */
function aggregateOne(samples, { rangeMs, buckets = DEFAULT_BUCKETS, nowMs = Date.now() }) {
  const step = rangeMs / buckets;
  const windowStart = nowMs - rangeMs;
  const acc = Array.from({ length: buckets }, () => ({
    cpu: /** @type {number[]} */ ([]),
    mem: /** @type {number[]} */ ([]),
    rx: /** @type {number[]} */ ([]),
    tx: /** @type {number[]} */ ([]),
    tps: /** @type {number[]} */ ([]),
    mspt: /** @type {number[]} */ ([]),
    players: /** @type {number[]} */ ([]),
  }));
  for (const s of samples) {
    const a = acc[bucketIndex(s.at, windowStart, step, buckets)];
    if (s.cpu != null) a.cpu.push(s.cpu);
    if (s.mem != null) a.mem.push(s.mem);
    if (s.rx != null) a.rx.push(s.rx);
    if (s.tx != null) a.tx.push(s.tx);
    if (s.tps != null) a.tps.push(s.tps);
    if (s.mspt != null) a.mspt.push(s.mspt);
    if (s.players != null) a.players.push(s.players);
  }
  return acc.map((a, i) => {
    const at = new Date(windowStart + i * step + step / 2).toISOString();
    const cpu = avg(a.cpu);
    const mem = avg(a.mem);
    const rx = avg(a.rx);
    const tx = avg(a.tx);
    const tps = avg(a.tps);
    const mspt = avg(a.mspt);
    const players = avg(a.players);
    return {
      at,
      cpuPct: cpu === null ? null : round1(cpu),
      memUsedMb: mem === null ? null : Math.round(mem / MB),
      netRxKbs: rx === null ? null : Math.round(rx / KB),
      netTxKbs: tx === null ? null : Math.round(tx / KB),
      tps: tps === null ? null : round2(tps),
      mspt: mspt === null ? null : round1(mspt),
      playersOnline: players === null ? null : Math.round(players),
    };
  });
}

/**
 * Fleet series: per-bucket per-server averages summed across servers, plus how
 * many servers reported in that bucket ("running"). Buckets with no rows at all
 * emit nulls so the chart shows a gap instead of a misleading zero line.
 * @param {Array<ReturnType<typeof normalize>>} samples
 * @param {{ rangeMs: number, buckets?: number, nowMs?: number }} opts
 * @returns {Array<{ at: string, cpuPct: number|null, memUsedMb: number|null, netRxKbs: number|null, netTxKbs: number|null, playersOnline: number|null, running: number }>}
 */
function aggregateFleet(samples, { rangeMs, buckets = DEFAULT_BUCKETS, nowMs = Date.now() }) {
  const step = rangeMs / buckets;
  const windowStart = nowMs - rangeMs;
  const byBucket = Array.from(
    { length: buckets },
    () =>
      /** @type {Map<string, { cpu: number[], mem: number[], rx: number[], tx: number[], players: number[] }>} */
      new Map()
  );
  for (const s of samples) {
    const bucket = byBucket[bucketIndex(s.at, windowStart, step, buckets)];
    let perServer = bucket.get(s.serverId);
    if (!perServer) {
      perServer = { cpu: [], mem: [], rx: [], tx: [], players: [] };
      bucket.set(s.serverId, perServer);
    }
    if (s.cpu != null) perServer.cpu.push(s.cpu);
    if (s.mem != null) perServer.mem.push(s.mem);
    if (s.rx != null) perServer.rx.push(s.rx);
    if (s.tx != null) perServer.tx.push(s.tx);
    if (s.players != null) perServer.players.push(s.players);
  }
  return byBucket.map((perServer, i) => {
    const at = new Date(windowStart + i * step + step / 2).toISOString();
    let cpu = 0;
    let mem = 0;
    let rx = 0;
    let tx = 0;
    let players = 0;
    let running = 0;
    for (const acc of perServer.values()) {
      running += 1;
      cpu += avg(acc.cpu) ?? 0;
      mem += avg(acc.mem) ?? 0;
      rx += avg(acc.rx) ?? 0;
      tx += avg(acc.tx) ?? 0;
      players += avg(acc.players) ?? 0;
    }
    if (running === 0) {
      return { at, cpuPct: null, memUsedMb: null, netRxKbs: null, netTxKbs: null, playersOnline: null, running: 0 };
    }
    return {
      at,
      cpuPct: round1(cpu),
      memUsedMb: Math.round(mem / MB),
      netRxKbs: Math.round(rx / KB),
      netTxKbs: Math.round(tx / KB),
      playersOnline: Math.round(players),
      running,
    };
  });
}

/**
 * Historical series for one server. Rows are window-filtered in SQL (ts is
 * ISO-8601 UTC, so a string comparison against an ISO cutoff is order-correct
 * and uses idx_metrics_server_ts).
 * @param {string} serverId
 * @param {'1h' | '24h' | '7d'} range
 * @param {number} [buckets]
 * @param {number} [nowMs]
 * @returns {ReturnType<typeof aggregateOne>}
 */
function serverSeries(serverId, range, buckets = DEFAULT_BUCKETS, nowMs = Date.now()) {
  const rangeMs = RANGES[range];
  const cutoffFrom = new Date(nowMs - rangeMs).toISOString();
  const cutoffTo = new Date(nowMs).toISOString();
  const rows = db.all(
    `SELECT ts, cpu_pct, mem_used_bytes, net_rx_bps, net_tx_bps, tps, mspt, players_online
       FROM metrics_samples
      WHERE server_id = ? AND ts >= ? AND ts <= ?
      ORDER BY ts`,
    serverId,
    cutoffFrom,
    cutoffTo
  );
  return aggregateOne(rows.map(normalize), { rangeMs, buckets, nowMs });
}

/**
 * Fleet-wide historical series summed across servers.
 * @param {'1h' | '24h' | '7d'} range
 * @param {number} [buckets]
 * @param {number} [nowMs]
 * @returns {ReturnType<typeof aggregateFleet>}
 */
function fleetSeries(range, buckets = DEFAULT_BUCKETS, nowMs = Date.now()) {
  const rangeMs = RANGES[range];
  const cutoffFrom = new Date(nowMs - rangeMs).toISOString();
  const cutoffTo = new Date(nowMs).toISOString();
  const rows = db.all(
    `SELECT server_id, ts, cpu_pct, mem_used_bytes, net_rx_bps, net_tx_bps, players_online
       FROM metrics_samples
      WHERE ts >= ? AND ts <= ?
      ORDER BY ts`,
    cutoffFrom,
    cutoffTo
  );
  return aggregateFleet(rows.map(normalize), { rangeMs, buckets, nowMs });
}

/**
 * Delete samples older than `days`. ts is ISO-8601 UTC, so the string compare
 * against an ISO cutoff is order-correct and uses idx_metrics_ts.
 * @param {number} days
 * @returns {{ removed: number }}
 */
function pruneOlderThan(days) {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const removed = db.run('DELETE FROM metrics_samples WHERE ts < ?', cutoff).changes;
  return { removed };
}

module.exports = {
  RANGES,
  DEFAULT_BUCKETS,
  normalize,
  bucketIndex,
  aggregateOne,
  aggregateFleet,
  serverSeries,
  fleetSeries,
  pruneOlderThan,
};
