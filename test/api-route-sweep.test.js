'use strict';

// Contract sweep over every /api route: an admin calling any route with empty
// input and a throwaway server must get a handled response (2xx/4xx), never an
// unhandled crash. Only routes that need a live Docker daemon may answer 5xx.

require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('./helpers/app');
const router = require('../src/web/routes/api');

const NEEDS_DOCKER = new Set([
  'POST /api/servers/srv_sweep/start',
  'POST /api/servers/srv_sweep/kill',
  'POST /api/servers/srv_sweep/recreate',
  'GET /api/docker/networks',
  'GET /api/servers/srv_sweep/logs',
  'GET /api/servers/srv_sweep/stats',
  'POST /api/servers/srv_sweep/stop',
  'POST /api/servers/srv_sweep/restart',
]);
// Would remove the server the sweep is running against.
const SKIP = new Set(['DELETE /api/servers/srv_sweep']);

test.before(async () => {
  await app.start();
});
test.after(async () => {
  await app.stop();
});

test('no /api route crashes on empty input', async () => {
  const cookie = await app.adminCookie();
  app.seedServer('srv_sweep');
  const routes = [];
  for (const layer of router.stack) {
    if (!layer.route) continue;
    for (const method of Object.keys(layer.route.methods)) routes.push([method.toUpperCase(), layer.route.path]);
  }
  assert.ok(routes.length > 100, 'expected to discover the router');

  const crashed = [];
  for (const [method, p] of routes) {
    const url = '/api' + p.replace(/:id\b/g, 'srv_sweep').replace(/:[A-Za-z]+/g, 'x');
    const key = `${method} ${url}`;
    if (SKIP.has(key)) continue;
    const r = await app.req(method, url, { cookie, body: method === 'GET' ? undefined : {} });
    if (r.status >= 500 && !NEEDS_DOCKER.has(key)) crashed.push(`${key} -> ${r.status}`);
  }
  assert.deepEqual(crashed, []);
});
