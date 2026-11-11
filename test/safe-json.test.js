'use strict';

const app = require('./helpers/app');
const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');
const { safeJsonParse } = require('../src/utils/safeJson');

let cookie;
test.before(async () => {
  await app.start();
  cookie = await app.adminCookie();
});
test.after(() => app.stop());

test('safeJsonParse returns the fallback for bad or wrongly shaped input', () => {
  assert.deepEqual(safeJsonParse('{"a":1}', {}), { a: 1 });
  assert.deepEqual(safeJsonParse('{oops', {}), {});
  assert.deepEqual(safeJsonParse(null, []), []);
  assert.deepEqual(safeJsonParse('{"a":1}', [], { expect: 'array' }), []);
  assert.deepEqual(safeJsonParse('[1]', {}, { expect: 'object' }), {});
  const issues = [];
  safeJsonParse('nope', {}, { field: 'Environment Variables', issues });
  assert.deepEqual(issues, ['Environment Variables']);
});

test('one server with damaged JSON does not break the dashboard, and its page says so', async () => {
  const id = app.seedServer('srv_badjson');
  db.run("UPDATE servers SET env_json = '{not json', tags_json = '\"x\"', extra_ports_json = '[' WHERE id = ?", id);
  const html = { cookie, headers: { Accept: 'text/html' } };
  const dash = await app.req('GET', '/', html);
  assert.equal(dash.status, 200);
  const page = await app.req('GET', `/servers/${id}`, html);
  assert.equal(page.status, 200);
  assert.match(page.text, /data-server-data-issues/);
  assert.match(page.text, /Tags, Environment Variables, Extra Ports/);
  assert.equal((await app.req('GET', `/servers/${id}/settings`, html)).status, 200);
  assert.equal((await app.req('GET', '/servers', html)).status, 200);
});
