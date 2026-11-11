'use strict';

const app = require('./helpers/app');
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { isKnownHost, hostName } = require('../src/web/middleware/hostGuard');

test.before(() => app.start());
test.after(() => app.stop());

/** fetch() will not send a custom Host header, so use node:http. */
function rawReq(method, path, host) {
  const u = new URL(app.baseUrl());
  return new Promise((resolve, reject) => {
    const r = http.request(
      { host: u.hostname, port: u.port, method, path, headers: { Host: host, 'Content-Type': 'application/json' } },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      }
    );
    r.on('error', reject);
    r.end(method === 'POST' ? JSON.stringify({ username: 'evil', password: 'evilevilevil1' }) : undefined);
  });
}

test('host names are parsed and matched', () => {
  assert.equal(hostName('Panel.Example:25564'), 'panel.example');
  assert.equal(hostName('[::1]:25564'), '::1');
  assert.ok(isKnownHost('127.0.0.1:25564', { allowed: [], publicHost: '' }));
  assert.ok(isKnownHost('192.168.1.20', { allowed: [], publicHost: '' }));
  assert.ok(isKnownHost('[::1]:25564', { allowed: [], publicHost: '' }));
  assert.ok(isKnownHost('localhost:25564', { allowed: [], publicHost: '' }));
  assert.ok(isKnownHost('mc.example.com', { allowed: [], publicHost: 'mc.example.com' }));
  assert.ok(isKnownHost('nas.lan', { allowed: ['nas.lan'], publicHost: '' }));
  assert.ok(isKnownHost('anything.example', { allowed: ['*'], publicHost: '' }));
  assert.ok(!isKnownHost('evil.example', { allowed: [], publicHost: '' }));
});

test('before setup on a loopback bind, an unknown Host gets 421 (DNS rebinding)', async () => {
  assert.equal(await rawReq('POST', '/setup', 'evil.example'), 421);
  assert.equal(await rawReq('GET', '/setup', 'evil.example:25564'), 421);
  assert.notEqual(await rawReq('GET', '/setup', 'localhost:25564'), 421);
  assert.notEqual(await rawReq('GET', '/setup', '127.0.0.1:25564'), 421);
});

test('after setup any host name works, until PANEL_ALLOWED_HOSTS makes the list strict', async () => {
  await app.adminCookie();
  assert.notEqual(await rawReq('GET', '/login', 'nas.lan:25564'), 421);
  process.env.PANEL_ALLOWED_HOSTS = 'panel.example';
  try {
    assert.equal(await rawReq('GET', '/login', 'nas.lan:25564'), 421);
    assert.notEqual(await rawReq('GET', '/login', 'panel.example'), 421);
    assert.notEqual(await rawReq('GET', '/login', '10.0.0.4:25564'), 421);
  } finally {
    delete process.env.PANEL_ALLOWED_HOSTS;
  }
});
