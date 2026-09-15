'use strict';

require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');
const app = require('./helpers/app');

let cookie;

test.before(async () => {
  await app.start();
  cookie = await app.adminCookie();
});
test.after(async () => {
  await app.stop();
});

function insertSample({ serverId, at, cpu, mem, players }) {
  db.run(
    `INSERT INTO metrics_samples (server_id, ts, cpu_pct, mem_used_bytes, players_online)
     VALUES (?, ?, ?, ?, ?)`,
    serverId,
    new Date(at).toISOString(),
    cpu ?? null,
    mem ?? null,
    players ?? null
  );
}

test('fleet metrics with no history returns 120 empty points', async () => {
  const r = await app.req('GET', '/api/fleet/metrics?range=24h', { cookie });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.range, '24h');
  assert.ok(Array.isArray(r.json.points));
  assert.equal(r.json.points.length, 120);
  assert.ok(r.json.points.every((p) => p.running === 0 && p.cpuPct === null));
});

test('fleet metrics sums per-server samples across the fleet', async () => {
  const a = app.seedServer('metric_fleet_a');
  const b = app.seedServer('metric_fleet_b');
  insertSample({ serverId: a, at: Date.now(), cpu: 10, mem: 104_857_600, players: 2 });
  insertSample({ serverId: b, at: Date.now(), cpu: 20, mem: 104_857_600, players: 3 });

  const r = await app.req('GET', '/api/fleet/metrics?range=24h', { cookie });
  assert.equal(r.status, 200);
  assert.equal(r.json.points.length, 120);
  const last = r.json.points[119];
  assert.equal(last.running, 2);
  assert.equal(last.cpuPct, 30);
  assert.equal(last.memUsedMb, 200);
  assert.equal(last.playersOnline, 5);
  assert.ok(Array.isArray(r.json.points));
});

test('per-server metrics returns its own series and a 404 for unknown servers', async () => {
  const id = app.seedServer('metric_server');
  insertSample({ serverId: id, at: Date.now(), cpu: 12, mem: 52_428_800, players: 1 });

  const r = await app.req('GET', `/api/servers/${id}/metrics?range=1h`, { cookie });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.range, '1h');
  assert.equal(r.json.points.length, 120);
  const last = r.json.points[119];
  assert.equal(last.cpuPct, 12);
  assert.equal(last.memUsedMb, 50);
  assert.equal(last.playersOnline, 1);
  assert.equal(last.tps, null);
  assert.equal(last.mspt, null);

  const missing = await app.req('GET', '/api/servers/nope/metrics?range=1h', { cookie });
  assert.equal(missing.status, 404);
  assert.equal(missing.json.ok, false);
});

test('range validation rejects unknown values', async () => {
  const r = await app.req('GET', '/api/fleet/metrics?range=48h', { cookie });
  assert.equal(r.status, 400);
});

test('history outside the window is excluded', async () => {
  const id = app.seedServer('metric_old');
  insertSample({ serverId: id, at: Date.now() - 10 * 24 * 60 * 60 * 1000, cpu: 99, players: 9 });

  const r = await app.req('GET', `/api/servers/${id}/metrics?range=1h`, { cookie });
  assert.equal(r.status, 200);
  assert.ok(r.json.points.every((p) => p.cpuPct === null && p.playersOnline === null));
});
