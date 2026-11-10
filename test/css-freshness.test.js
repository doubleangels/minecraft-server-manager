'use strict';

// A stale stylesheet (older than the templates after a git pull) is detected,
// and a missing one counts as stale.
require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cssIsStale } = require('../src/web/cssFreshness');

function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'msm-css-'));
  for (const d of ['assets/css', 'public/css', 'public/js', 'views', 'src']) {
    fs.mkdirSync(path.join(root, d), { recursive: true });
  }
  fs.writeFileSync(path.join(root, 'assets/css/input.css'), '@import "tailwindcss";');
  fs.writeFileSync(path.join(root, 'views/page.hbs'), '<div class="p-4"></div>');
  return root;
}
const touch = (file, msAgo) => {
  const t = new Date(Date.now() - msAgo);
  fs.utimesSync(file, t, t);
};

test('a missing stylesheet is stale', () => {
  assert.equal(cssIsStale(project()), true);
});

test('a stylesheet built after every source is fresh', () => {
  const root = project();
  touch(path.join(root, 'assets/css/input.css'), 60_000);
  touch(path.join(root, 'views/page.hbs'), 60_000);
  fs.writeFileSync(path.join(root, 'public/css/app.css'), '.p-4{}');
  assert.equal(cssIsStale(root), false);
});

test('a template newer than the stylesheet (a git pull) makes it stale', () => {
  const root = project();
  const css = path.join(root, 'public/css/app.css');
  fs.writeFileSync(css, '.p-4{}');
  touch(css, 60_000);
  touch(path.join(root, 'assets/css/input.css'), 120_000);
  fs.writeFileSync(path.join(root, 'views/page.hbs'), '<div class="stat-tile"></div>');
  assert.equal(cssIsStale(root), true);
});
