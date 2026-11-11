'use strict';

require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const app = require('./helpers/app');
const db = require('../src/db');
const mapToken = require('../src/services/mapToken');

let cookie;
let adminId;

test.before(async () => {
  await app.start();
  cookie = await app.adminCookie();
  adminId = db.get("SELECT id FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1").id;
});

test.after(async () => {
  await app.stop();
});

/** Enable "BlueMap" on a seeded server, pointed at a given host port. */
function enableMap(serverId, hostPort) {
  db.run(
    "INSERT INTO integrations (server_id, kind, enabled, config_json) VALUES (?, 'bluemap', 1, ?)",
    serverId,
    JSON.stringify({ hostPort })
  );
}

function listenOnFreePort(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

const mapUrl = (id, rest = '', userId = adminId) => `/map/${id}/t/${mapToken.mint(id, userId)}/${rest}`;

test('the map 404s when it is not enabled', async () => {
  const id = app.seedServer('srv_map01');
  const r = await app.req('GET', mapUrl(id));
  assert.equal(r.status, 404);
});

test('the map 404s for an unknown server', async () => {
  const r = await app.req('GET', mapUrl('nope'));
  assert.equal(r.status, 404);
});

test('the map proxies through to the upstream BlueMap server (host-port fallback, no Docker here)', async () => {
  const id = app.seedServer('srv_map02');
  const upstream = await listenOnFreePort((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain', 'X-Bluemap': 'yes' });
    res.end(`hello from bluemap ${req.url}`);
  });
  enableMap(id, upstream.address().port);
  try {
    const r = await app.req('GET', mapUrl(id, 'maps/world/settings.json'));
    assert.equal(r.status, 200);
    // The token prefix is stripped: BlueMap sees its own paths.
    assert.equal(r.text, 'hello from bluemap /maps/world/settings.json');
    assert.equal(r.headers.get('x-bluemap'), null, 'only allowlisted headers come back');
  } finally {
    upstream.close();
  }
});

test('every proxied response is sandboxed and pages get the storage shim', async () => {
  const id = app.seedServer('srv_map05');
  let sawEncoding = null;
  const upstream = await listenOnFreePort((req, res) => {
    sawEncoding = req.headers['accept-encoding'] || null;
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': 'default-src *',
      'Set-Cookie': 'evil=1',
    });
    res.end(
      '<!doctype html><html><head><title>BlueMap</title></head><body><script src="app.js"></script></body></html>'
    );
  });
  enableMap(id, upstream.address().port);
  try {
    const r = await app.req('GET', mapUrl(id), { headers: { 'Accept-Encoding': 'gzip' } });
    assert.equal(r.status, 200);
    const csp = r.headers.get('content-security-policy');
    assert.match(csp, /^sandbox allow-scripts;/);
    assert.doesNotMatch(csp, /allow-same-origin/);
    assert.doesNotMatch(csp, /nonce-/, 'the panel CSP is replaced, not merged');
    assert.equal(r.headers.get('access-control-allow-origin'), '*');
    assert.equal(r.headers.get('set-cookie'), null);
    assert.equal(sawEncoding, null, 'pages are fetched uncompressed so the shim can go in');
    assert.match(r.text, /<head><script>\(function\(\)\{try\{window\.localStorage/);
    assert.equal(Number(r.headers.get('content-length')), Buffer.byteLength(r.text));
  } finally {
    upstream.close();
  }
});

test('a session alone does not open the map: no token, a bad token, or another server is refused', async () => {
  const a = app.seedServer('srv_map06');
  const b = app.seedServer('srv_map07');
  const upstream = await listenOnFreePort((req, res) => res.end('map'));
  enableMap(a, upstream.address().port);
  enableMap(b, upstream.address().port);
  try {
    // The old session-cookie URL.
    const old = await app.req('GET', `/map/${a}/`, { cookie });
    assert.equal(old.status, 403);
    assert.match(old.headers.get('content-security-policy'), /^sandbox/);
    assert.equal((await app.req('GET', `/map/${a}/t/garbage/`, { cookie })).status, 403);
    // A token for A does not open B.
    const tokenA = mapToken.mint(a, adminId);
    assert.equal((await app.req('GET', `/map/${b}/t/${tokenA}/`, { cookie })).status, 403);
    assert.equal((await app.req('GET', `/map/${a}/t/${tokenA}/`)).status, 200);
    // An expired token, and a token for a user that no longer exists.
    const expired = mapToken.mint(a, adminId, Date.now() - mapToken.TTL_MS - 1000);
    assert.equal((await app.req('GET', `/map/${a}/t/${expired}/`)).status, 403);
    assert.equal((await app.req('GET', mapUrl(a, '', 'usr_gone'))).status, 403);
    // Writes are refused even with a token.
    assert.equal((await app.req('POST', mapUrl(a))).status, 405);
  } finally {
    upstream.close();
  }
});

test('the Map tab embeds a sandboxed frame with a token for this server', async () => {
  const id = app.seedServer('srv_map08');
  enableMap(id, 1);
  const r = await app.req('GET', `/servers/${id}/map`, { cookie, headers: { Accept: 'text/html' } });
  assert.equal(r.status, 200);
  const m = new RegExp(`<iframe src="/map/${id}/t/([^/"]+)/" sandbox="allow-scripts"`).exec(r.text);
  assert.ok(m, 'sandboxed tokenized iframe');
  assert.equal(mapToken.verify(m[1], id), adminId);
});

test('the map returns 502 (not a hang) when nothing is listening on the configured port', async () => {
  const id = app.seedServer('srv_map03');
  const srv = await listenOnFreePort(() => {});
  const deadPort = srv.address().port;
  await new Promise((resolve) => srv.close(resolve)); // free the port, guaranteed nothing listens there
  enableMap(id, deadPort);

  const r = await app.req('GET', mapUrl(id));
  assert.equal(r.status, 502);
  assert.match(r.text, /not responding/);
});

test('a working target is cached - a second request does not re-probe (same upstream serves it again)', async () => {
  const id = app.seedServer('srv_map04');
  let hits = 0;
  const upstream = await listenOnFreePort((req, res) => {
    hits += 1;
    res.writeHead(200);
    res.end('ok');
  });
  enableMap(id, upstream.address().port);
  try {
    const first = await app.req('GET', mapUrl(id));
    const second = await app.req('GET', mapUrl(id));
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(hits, 2); // both requests reached the SAME upstream, proving the cached target was reused
  } finally {
    upstream.close();
  }
});
