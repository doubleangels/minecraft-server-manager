'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isExcluded, shouldStore } = require('../src/services/backupFilter');

test('isExcluded drops rebuildable folders and lock files but keeps the world', () => {
  assert.equal(isExcluded('logs/latest.log'), true);
  assert.equal(isExcluded('logs', true), true);
  assert.equal(isExcluded('bluemap/web/maps/world/tiles/0.png'), true);
  assert.equal(isExcluded('world/session.lock'), true);
  assert.equal(isExcluded('world/region/r.0.0.mca.tmp'), true);
  assert.equal(isExcluded('world/region/r.0.0.mca'), false);
  assert.equal(isExcluded('crash-reports/crash.txt'), false);
  assert.equal(isExcluded('bluemap/web/index.html'), false);
  assert.equal(isExcluded('mylogs/a.txt'), false);
});

test('shouldStore only skips deflate for already-compressed formats', () => {
  assert.equal(shouldStore('mods/a.jar'), true);
  assert.equal(shouldStore('logs/2026-01-01.log.gz'), true);
  assert.equal(shouldStore('server-icon.PNG'), true);
  assert.equal(shouldStore('world/level.dat'), false);
  assert.equal(shouldStore('config.d/file'), false);
});
