'use strict';

// Every app icon, badge and launch screen the code points at exists on disk.
// Icons are served `immutable` and renamed instead of overwritten, so a rename
// that misses one reference would silently ship a broken image (it happened to
// the notification icon and the offline page once).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SCAN = ['views', 'public/js', 'public/sw.js', 'public/offline.html', 'public/manifest.json', 'src'];
// Per-item and per-server art is looked up by name at run time, not by literal path.
const DYNAMIC = /^\/icons\/(?:mc-items|servers|avatars)\//;

function files(rel) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) return [];
  if (fs.statSync(abs).isFile()) return [abs];
  return fs
    .readdirSync(abs, { withFileTypes: true })
    .filter((d) => d.name !== 'dist')
    .flatMap((d) => files(path.join(rel, d.name)));
}

test('every /icons/… path in the code is a file that exists', () => {
  const missing = [];
  let seen = 0;
  for (const file of SCAN.flatMap(files)) {
    if (!/\.(?:js|hbs|html|json)$/.test(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    for (const [ref] of text.matchAll(/\/icons\/[\w./-]+\.(?:png|svg)/g)) {
      if (DYNAMIC.test(ref)) continue;
      seen += 1;
      if (!fs.existsSync(path.join(ROOT, 'public', ref))) missing.push(`${path.relative(ROOT, file)}: ${ref}`);
    }
  }
  assert.ok(seen > 20, 'the scan found the app icon references');
  assert.deepEqual(missing, []);
});

test('the iOS launch screens match the device sizes they are declared for', () => {
  const head = fs.readFileSync(path.join(ROOT, 'views/partials/app-head.hbs'), 'utf8');
  const links = [
    ...head.matchAll(
      /device-width: (\d+)px\) and \(device-height: (\d+)px\) and \(-webkit-device-pixel-ratio: (\d)\)[^"]*" href="([^"]+)"/g
    ),
  ];
  assert.ok(links.length >= 10, 'launch screens for current iPhones and iPads');
  for (const [, w, h, r, href] of links) {
    const png = fs.readFileSync(path.join(ROOT, 'public', href));
    // PNG IHDR: width and height are big-endian at bytes 16 and 20.
    assert.equal(png.readUInt32BE(16), w * r, `${href} width`);
    assert.equal(png.readUInt32BE(20), h * r, `${href} height`);
  }
});

test('both layouts share the install head, so the sign-in page installs the same way', () => {
  for (const layout of ['main', 'bare']) {
    const src = fs.readFileSync(path.join(ROOT, `views/layouts/${layout}.hbs`), 'utf8');
    assert.match(src, /\{\{> app-head\}\}/, `${layout}.hbs includes app-head`);
  }
});
