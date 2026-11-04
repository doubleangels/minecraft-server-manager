'use strict';

const app = require('./helpers/app');
const test = require('node:test');
const assert = require('node:assert/strict');

test.before(async () => {
  await app.start();
  await app.adminCookie();
});
test.after(() => app.stop());

test('the app manifest, service worker and offline page load without signing in', async () => {
  for (const p of ['/manifest.json', '/sw.js', '/offline.html', '/icons/icon-maskable-192.png']) {
    const r = await app.req('GET', p);
    assert.equal(r.status, 200, p);
  }
  // A worker must never be held in an HTTP cache, or a fix to it waits on the cache.
  const sw = await app.req('GET', '/sw.js');
  assert.equal(sw.headers.get('cache-control'), 'no-cache');
});

test('the manifest is installable: standalone, a stable id, and maskable icons', async () => {
  const m = (await app.req('GET', '/manifest.json')).json;
  assert.equal(m.display, 'standalone');
  assert.equal(m.id, '/');
  assert.ok(m.icons.some((i) => i.purpose === 'maskable' && i.sizes === '512x512'));
  assert.ok(m.icons.some((i) => i.purpose === 'any' && i.sizes === '192x192'));
  assert.ok(m.shortcuts.length >= 1);
});

test('the service worker never caches pages or the API', async () => {
  const src = (await app.req('GET', '/sw.js')).text;
  assert.match(
    src,
    /req\.mode === 'navigate'[\s\S]*?fetch\(req\)\.catch\(\(\) => caches\.match\('\/offline\.html'\)\)/
  );
  assert.doesNotMatch(src, /caches?\.(put|add|addAll)\([^)]*\/api/);
});
