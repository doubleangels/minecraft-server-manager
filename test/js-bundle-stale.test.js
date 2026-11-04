'use strict';

require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { jsBundleIsStale } = require('../src/web/app');

function layout() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'msm-bundle-'));
  const src = path.join(root, 'js');
  const dist = path.join(root, 'dist', 'js');
  fs.mkdirSync(path.join(src, 'lib'), { recursive: true });
  fs.mkdirSync(path.join(dist, 'pages'), { recursive: true });
  fs.writeFileSync(path.join(src, 'lib', 'jumpNav.js'), 'export {}');
  fs.writeFileSync(path.join(dist, 'pages', 'settings.js'), '/*built*/');
  return { root, src, dist };
}
const age = (file, secondsAgo) => {
  const t = new Date(Date.now() - secondsAgo * 1000);
  fs.utimesSync(file, t, t);
};

test('a bundle built after its source is used', () => {
  const { root, src, dist } = layout();
  age(path.join(src, 'lib', 'jumpNav.js'), 60);
  assert.equal(jsBundleIsStale(src, dist), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('source changed after the last build (an update without a rebuild) makes the bundle stale', () => {
  const { root, src, dist } = layout();
  age(path.join(dist, 'pages', 'settings.js'), 60);
  assert.equal(jsBundleIsStale(src, dist), true);
  fs.rmSync(root, { recursive: true, force: true });
});
