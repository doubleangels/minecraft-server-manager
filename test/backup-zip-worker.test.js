'use strict';

require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { zipDirectory, extractZip } = require('../src/services/backups');

test('zipDirectory (worker thread) archives a tree, reports progress, and round-trips through extractZip', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msm-bkzip-'));
  const src = path.join(dir, 'world');
  fs.mkdirSync(path.join(src, 'region'), { recursive: true });
  fs.writeFileSync(path.join(src, 'level.dat'), 'X'.repeat(50_000));
  fs.writeFileSync(path.join(src, 'region', 'r.0.0.mca'), 'Y'.repeat(120_000));

  const out = path.join(dir, 'backup.zip');
  let progressSeen = 0;
  await zipDirectory(src, out, { onProgress: (bytes) => (progressSeen = bytes) });

  assert.ok(fs.statSync(out).size > 0, 'archive was written');
  assert.ok(progressSeen > 0, 'progress callback fired');

  const back = path.join(dir, 'restored');
  fs.mkdirSync(back, { recursive: true });
  await extractZip(out, back);
  assert.equal(fs.readFileSync(path.join(back, 'level.dat'), 'utf8').length, 50_000);
  assert.equal(fs.readFileSync(path.join(back, 'region', 'r.0.0.mca'), 'utf8').length, 120_000);

  await fsp.rm(dir, { recursive: true, force: true });
});

test('zipDirectory produces a valid, empty archive for an empty source (the "server never started" case)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msm-bkzip-'));
  const src = path.join(dir, 'empty');
  fs.mkdirSync(src, { recursive: true });
  const out = path.join(dir, 'backup.zip');

  await zipDirectory(src, out);
  assert.ok(fs.existsSync(out), 'archive still written');

  const back = path.join(dir, 'restored');
  fs.mkdirSync(back, { recursive: true });
  await extractZip(out, back); // must not throw on a zero-entry archive
  assert.deepEqual(fs.readdirSync(back), []);

  await fsp.rm(dir, { recursive: true, force: true });
});

test('zipDirectory leaves out logs, map renders and lock files, and stores already-compressed files', async () => {
  const yauzl = require('yauzl');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msm-bkzip-'));
  const src = path.join(dir, 'server');
  const put = (rel, body) => {
    fs.mkdirSync(path.dirname(path.join(src, rel)), { recursive: true });
    fs.writeFileSync(path.join(src, rel), body);
  };
  put('world/region/r.0.0.mca', 'R'.repeat(20_000));
  put('world/session.lock', 'lock');
  put('world/level.dat.tmp', 'tmp');
  put('logs/latest.log', 'log');
  put('bluemap/web/maps/world/tiles/0.png', 'tile');
  put('plugins/BlueMap/web/maps/world/tiles/0.png', 'tile');
  put('crash-reports/crash-1.txt', 'kept');
  put('mods/a.jar', 'J'.repeat(5_000));

  const out = path.join(dir, 'backup.zip');
  await zipDirectory(src, out);

  const entries = await new Promise((resolve, reject) => {
    yauzl.open(out, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err);
      const list = new Map();
      zip.on('entry', (e) => {
        list.set(e.fileName, e.compressionMethod);
        zip.readEntry();
      });
      zip.on('end', () => resolve(list));
      zip.readEntry();
    });
  });
  const files = [...entries.keys()].filter((n) => !n.endsWith('/'));
  assert.deepEqual(files.sort(), ['crash-reports/crash-1.txt', 'mods/a.jar', 'world/region/r.0.0.mca']);
  assert.equal(entries.get('mods/a.jar'), 0, 'a jar is stored, not deflated again');
  assert.equal(entries.get('world/region/r.0.0.mca'), 8, 'region files are deflated');

  await fsp.rm(dir, { recursive: true, force: true });
});
