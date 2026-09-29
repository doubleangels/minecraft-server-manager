'use strict';

// Contract sweep over the sub-routers mounted under /api and the server-rendered
// pages: with an admin session, empty input and a throwaway server, every route
// must give a handled response (2xx/3xx/4xx), never an unhandled crash.

require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('./helpers/app');

const SID = 'srv_rsweep';
const MOUNTS = [
  ['/api/blueprints', require('../src/web/routes/blueprints')],
  ['/api/worlds', require('../src/web/routes/worlds')],
  [`/api/servers/${SID}/worlds`, require('../src/web/routes/worlds').serverWorlds],
  [`/api/servers/${SID}/files`, require('../src/web/routes/files').serverFiles],
  ['/api/files', require('../src/web/routes/files').globalFiles],
  [`/api/servers/${SID}/crashes`, require('../src/web/routes/crashes')],
  [`/api/servers/${SID}/players`, require('../src/web/routes/players')],
  [`/api/servers/${SID}/chat-commands`, require('../src/web/routes/chatCommands')],
  [`/api/servers/${SID}/integrations`, require('../src/web/routes/integrations')],
  [`/api/servers/${SID}/wizard`, require('../src/web/routes/wizard')],
  [`/api/servers/${SID}/analytics`, require('../src/web/routes/analytics')],
  [`/api/servers/${SID}/inventory`, require('../src/web/routes/inventory')],
  ['/api/inventory', require('../src/web/routes/inventory').globalSearch],
  [`/api/servers/${SID}/items`, require('../src/web/routes/items')],
  ['/api/account', require('../src/web/routes/account')],
  ['/api/tasks', require('../src/web/routes/tasks')],
  ['/api/solver', require('../src/web/routes/solver')],
];

function collect(router, prefix, out) {
  for (const layer of router.stack || []) {
    if (layer.route) {
      const p = layer.route.path === '/' ? '' : layer.route.path;
      for (const m of Object.keys(layer.route.methods)) out.push([m.toUpperCase(), prefix + p]);
    }
  }
}

const fill = (p) => p.replace(/:id\b/g, SID).replace(/:[A-Za-z]+/g, 'x');
// Would end the session or remove the server the sweep is using.
const SKIP = /\/logout|\/account\/password|\/account\/2fa\/disable|\/wizard\/enable/;

test.before(async () => {
  await app.start();
});
test.after(async () => {
  await app.stop();
});

test('no sub-router route or server page crashes on empty input', async () => {
  const cookie = await app.adminCookie();
  app.seedServer(SID);

  const routes = [];
  for (const [prefix, router] of MOUNTS) {
    assert.ok(router && router.stack, `router for ${prefix} should be discoverable`);
    collect(router, prefix, routes);
  }
  assert.ok(routes.length > 80);

  const crashed = [];
  for (const [method, p] of routes) {
    const url = fill(p);
    if (SKIP.test(url)) continue;
    const r = await app.req(method, url, { cookie, body: method === 'GET' ? undefined : {} });
    if (r.status >= 500) crashed.push(`${method} ${url} -> ${r.status}`);
  }

  // Server-rendered pages.
  for (const page of [
    '/',
    '/servers',
    '/servers/new',
    `/servers/${SID}`,
    ...[
      'console',
      'players',
      'worlds',
      'files',
      'content',
      'backups',
      'settings',
      'schedules',
      'crashes',
      'history',
      'analytics',
      'inventory',
      'map',
    ].map((t) => `/servers/${SID}?tab=${t}`),
    '/health',
    '/history',
    '/library',
    '/storage',
    '/blueprints',
    '/settings',
    '/users',
    '/account',
    '/files',
    '/worlds',
    '/nope',
  ]) {
    const r = await app.req('GET', page, { cookie, headers: { Accept: 'text/html' } });
    if (r.status >= 500) crashed.push(`GET ${page} -> ${r.status}`);
  }
  assert.deepEqual(crashed, []);
});
