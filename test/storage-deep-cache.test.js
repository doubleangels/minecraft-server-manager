'use strict';

// Map tile folders are walked fully at most once a day; scans in between reuse
// the cached total, so a rendered map no longer pegs every storage scan.

const app = require('./helpers/app');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const db = require('../src/db');
const { dataPath } = require('../src/storage/pathGuard');

const SID = 'srv_deepcache';

test.before(async () => {
  await app.start();
  app.seedServer(SID);
});
test.after(() => app.stop());

test('a map tile folder is counted once, then served from the cache until it expires', async () => {
  const indexer = require('../src/storage/indexer');
  const tiles = dataPath('servers', SID, 'bluemap', 'web', 'maps', 'world', 'tiles');
  fs.mkdirSync(tiles, { recursive: true });
  for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(tiles, `${i}.prbin`), 'x'.repeat(100));
  fs.mkdirSync(dataPath('servers', SID, 'world'), { recursive: true });
  fs.writeFileSync(dataPath('servers', SID, 'world', 'level.dat'), 'y'.repeat(50));

  await indexer.scan();
  const rel = `servers/${SID}/bluemap/web/maps`;
  const cached = db.get('SELECT size_bytes, file_count FROM storage_deep_cache WHERE rel_path = ?', rel);
  assert.deepEqual({ ...cached }, { size_bytes: 500, file_count: 5 });
  const firstTotal = indexer.sizeOf(`servers/${SID}`);
  assert.equal(firstTotal, 550, 'the server size still includes its map');

  // New tiles appear, but within the day the cached total is reused: no re-walk.
  fs.writeFileSync(path.join(tiles, 'new.prbin'), 'x'.repeat(100));
  await indexer.scan();
  assert.equal(indexer.sizeOf(`servers/${SID}`), 550);

  // Once the cache is a day old the folder is walked again and picks them up.
  db.run('UPDATE storage_deep_cache SET scanned_at = ? WHERE rel_path = ?', Date.now() - 25 * 3600 * 1000, rel);
  await indexer.scan();
  assert.equal(indexer.sizeOf(`servers/${SID}`), 650);

  // A removed map drops out of the cache.
  fs.rmSync(dataPath('servers', SID, 'bluemap'), { recursive: true, force: true });
  await indexer.scan();
  assert.equal(db.get('SELECT COUNT(*) AS n FROM storage_deep_cache WHERE rel_path = ?', rel).n, 0);
});
