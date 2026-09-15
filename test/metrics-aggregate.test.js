'use strict';

require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');
const { migrate } = require('../src/db/migrate');
migrate();
const agg = require('../src/metrics/aggregate');

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0); // 2026-01-01T12:00:00Z
const HOUR = 60 * 60 * 1000;

function sample({ at, serverId = 'a', cpu = null, mem = null, rx = null, tx = null, players = null }) {
  return agg.normalize({
    server_id: serverId,
    ts: new Date(at).toISOString(),
    cpu_pct: cpu,
    mem_used_bytes: mem,
    net_rx_bps: rx,
    net_tx_bps: tx,
    tps: null,
    mspt: null,
    players_online: players,
  });
}

test('RANGES exposes the three documented ranges', () => {
  assert.deepEqual(Object.keys(agg.RANGES), ['1h', '24h', '7d']);
  assert.equal(agg.RANGES['1h'], HOUR);
  assert.equal(agg.RANGES['24h'], 24 * HOUR);
  assert.equal(agg.RANGES['7d'], 7 * 24 * HOUR);
});

test('bucketIndex clamps out-of-window samples into the first and last buckets', () => {
  const step = 900_000; // 15 min with buckets = 4 over 1h
  assert.equal(agg.bucketIndex(NOW - 2 * HOUR, NOW - HOUR, step, 4), 0); // older than window
  assert.equal(agg.bucketIndex(NOW - HOUR - 1, NOW - HOUR, step, 4), 0); // just before window
  assert.equal(agg.bucketIndex(NOW - HOUR, NOW - HOUR, step, 4), 0); // at the window start
  assert.equal(agg.bucketIndex(NOW - HOUR + 400_000, NOW - HOUR, step, 4), 0);
  assert.equal(agg.bucketIndex(NOW - HOUR + 900_000, NOW - HOUR, step, 4), 1);
  assert.equal(agg.bucketIndex(NOW - 900_001, NOW - HOUR, step, 4), 2);
  assert.equal(agg.bucketIndex(NOW - 1, NOW - HOUR, step, 4), 3);
  assert.equal(agg.bucketIndex(NOW + HOUR, NOW - HOUR, step, 4), 3); // later than now
});

test('aggregateOne averages samples per bucket and rounds cpu', () => {
  const samples = [
    sample({ at: NOW - HOUR, cpu: 10 }), // at the window start -> bucket 0
    sample({ at: NOW - HOUR + 400_000, cpu: 20 }), // bucket 0
    sample({ at: NOW - HOUR + 1_400_000, cpu: 40 }), // bucket 1
    sample({ at: NOW - 1_000, cpu: 80 }), // bucket 3
    sample({ at: NOW + 1_000, cpu: 90 }), // later than now -> clamped to bucket 3
  ];
  const points = agg.aggregateOne(samples, { rangeMs: HOUR, buckets: 4, nowMs: NOW });
  assert.equal(points.length, 4);
  assert.equal(points[0].cpuPct, 15); // (10 + 20) / 2
  assert.equal(points[1].cpuPct, 40);
  assert.equal(points[2].cpuPct, null); // no samples
  assert.equal(points[3].cpuPct, 85); // (80 + 90) / 2
});

test('aggregateOne reports nulls for empty buckets and converts mem bytes to whole MB', () => {
  const points = agg.aggregateOne([sample({ at: NOW - 1_000, mem: 104_857_600, players: 3 })], {
    rangeMs: HOUR,
    buckets: 2,
    nowMs: NOW,
  });
  assert.equal(points[0].memUsedMb, null);
  assert.equal(points[0].playersOnline, null);
  assert.equal(points[1].memUsedMb, 100);
  assert.equal(points[1].playersOnline, 3);
});

test('aggregateFleet sums per-server averages and counts running servers', () => {
  const samples = [
    sample({ at: NOW - 1_000, serverId: 'a', cpu: 10, mem: 104_857_600, players: 2 }),
    sample({ at: NOW - 500, serverId: 'b', cpu: 20, mem: 209_715_200, players: 3 }),
    // Second reading for the same bucket averages before summing.
    sample({ at: NOW - 600, serverId: 'b', cpu: 30, mem: 209_715_200, players: 5 }),
  ];
  const points = agg.aggregateFleet(samples, { rangeMs: HOUR, buckets: 4, nowMs: NOW });
  const last = points[3];
  assert.equal(last.running, 2);
  assert.equal(last.cpuPct, 35); // a: 10 + b: (20 + 30) / 2 = 25
  assert.equal(last.playersOnline, 6); // a: 2 + b: (3 + 5) / 2 = 4
  assert.equal(last.memUsedMb, 300); // a: 100 + b: 200 = 300
  // Empty buckets gap out instead of drawing a flat zero line.
  assert.deepEqual(points[0], {
    at: points[0].at,
    cpuPct: null,
    memUsedMb: null,
    netRxKbs: null,
    netTxKbs: null,
    playersOnline: null,
    running: 0,
  });
});

test('aggregateFleet treats a server with a missing metric as present for running count', () => {
  const samples = [
    sample({ at: NOW - 1_000, serverId: 'a', cpu: 10 }), // no players/mem
    sample({ at: NOW - 500, serverId: 'b', cpu: 20, players: 1 }),
  ];
  const points = agg.aggregateFleet(samples, { rangeMs: HOUR, buckets: 2, nowMs: NOW });
  assert.equal(points[1].running, 2);
  assert.equal(points[1].cpuPct, 30);
  assert.equal(points[1].memUsedMb, 0); // a contributed 0 (avg null), b none
  assert.equal(points[1].playersOnline, 1);
});

test('pruneOlderThan deletes only samples past the retention cutoff', () => {
  const db = require('../src/db');
  const DAY = 24 * HOUR;
  const REAL_NOW = Date.now(); // pruneOlderThan compares against the real clock
  const insert = (ts) =>
    db.run(
      'INSERT INTO metrics_samples (server_id, ts, cpu_pct) VALUES (?, ?, ?)',
      `prune_${ts % 1000}`,
      new Date(ts).toISOString(),
      50
    );
  insert(REAL_NOW - 40 * DAY); // 40 days old - must go
  insert(REAL_NOW - 6 * DAY); // inside 30-day window - stays
  insert(REAL_NOW - 3_600_000); // one hour old - stays
  insert(REAL_NOW + 1_000); // future (sampler clock skew) - stays
  const { removed } = agg.pruneOlderThan(30);
  assert.equal(removed, 1);
  const left = db.get('SELECT COUNT(*) AS n FROM metrics_samples').n;
  assert.equal(left, 3);
  const rows = db.all('SELECT ts FROM metrics_samples ORDER BY ts');
  assert.deepEqual(
    rows.map((r) => r.ts),
    [
      new Date(REAL_NOW - 6 * DAY).toISOString(),
      new Date(REAL_NOW - 3_600_000).toISOString(),
      new Date(REAL_NOW + 1_000).toISOString(),
    ]
  );
});
