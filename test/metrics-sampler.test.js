'use strict';

require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');
const { migrate } = require('../src/db/migrate');
migrate();
const db = require('../src/db');
const { sampleNow, rate } = require('../src/metrics/sampler');

const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);
const MIN = 60_000;

function liveEntry({ rx = 0, tx = 0, at = T0, cpu = 5, mem = 104_857_600, limit = 209_715_200, online = null } = {}) {
  return {
    stats: { cpuPct: cpu, memUsedBytes: mem, memLimitBytes: limit, netRx: rx, netTx: tx, at },
    players: online == null ? null : { online, max: 20 },
  };
}

test('rate computes bytes per second from a cumulative delta', () => {
  assert.equal(rate(undefined, 5000, 2000), 0); // no baseline
  assert.equal(rate(1000, 100_000, 60_000), 1650);
  assert.equal(rate(1000, 500, 60_000), 0); // counter reset -> no negative
});

test('a sampling pass writes one row per live entry and skips entries without stats', () => {
  const map = {
    srv_a: liveEntry({ rx: 1000, tx: 2000, cpu: 12, mem: 104_857_600, online: 2 }),
    srv_b: {}, // attached but no stats yet
  };
  const res = sampleNow(() => map, new Date(T0));
  assert.equal(res.servers, 2); // seen (including the stat-less one)
  assert.equal(res.rows, 1);

  const rows = db.all('SELECT * FROM metrics_samples ORDER BY server_id');
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.server_id, 'srv_a');
  assert.equal(row.ts, new Date(T0).toISOString());
  assert.equal(row.cpu_pct, 12);
  assert.equal(row.mem_used_bytes, 104_857_600);
  assert.equal(row.mem_limit_bytes, 209_715_200);
  assert.equal(row.net_rx_bps, 0); // first sight, no baseline yet
  assert.equal(row.net_tx_bps, 0);
  assert.equal(row.players_online, 2);
  assert.equal(row.players_max, 20);
  assert.equal(row.tps, null);
  assert.equal(row.mspt, null);
});

test('a second pass derives network rates from the cumulative deltas', () => {
  const map = {
    srv_rate: liveEntry({ rx: 1000, tx: 2000, at: T0 }),
  };
  sampleNow(() => map, new Date(T0));
  const grown = { srv_rate: liveEntry({ rx: 100_000, tx: 50_000, at: T0 + MIN }) };
  sampleNow(() => grown, new Date(T0 + MIN));

  const rows = db.all('SELECT * FROM metrics_samples WHERE server_id = ? ORDER BY ts', 'srv_rate');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].net_rx_bps, 0);
  assert.equal(rows[1].net_rx_bps, (100_000 - 1000) / 60);
  assert.equal(rows[1].net_tx_bps, (50_000 - 2000) / 60);
});

test('leaving the live cache drops the net baseline for that server', () => {
  const map = { srv_leave: liveEntry({ rx: 1000, tx: 2000, at: T0 }) };
  sampleNow(() => map, new Date(T0));
  // Server stops -> gone from the live cache for one pass.
  sampleNow(() => ({}), new Date(T0 + MIN));
  // It comes back on a fresh container: counters reset, no stale delta.
  const back = { srv_leave: liveEntry({ rx: 50, tx: 60, at: T0 + 2 * MIN }) };
  sampleNow(() => back, new Date(T0 + 2 * MIN));

  const rows = db.all('SELECT * FROM metrics_samples WHERE server_id = ? ORDER BY ts', 'srv_leave');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].net_rx_bps, 0);
  assert.equal(rows[1].net_rx_bps, 0); // baseline dropped, so no delta from the old totals
});
