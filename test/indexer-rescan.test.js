'use strict';

// Removals refresh the storage sizes within seconds, not after the 45 s growth
// debounce, and rescanNow() reflects a removal before it resolves.
require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { migrate } = require('../src/db/migrate');
migrate();
const { dataPath } = require('../src/storage/pathGuard');
const indexer = require('../src/storage/indexer');

function put(rel, bytes) {
  const abs = dataPath(rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, 'x'.repeat(bytes));
  return abs;
}

test('rescanNow reflects a removal before it resolves', async () => {
  const abs = put('servers/rescan-now/world/big.bin', 4096);
  await indexer.rescanNow();
  assert.equal(indexer.sizeOf('servers/rescan-now'), 4096);
  fs.rmSync(abs);
  await indexer.rescanNow();
  assert.equal(indexer.sizeOf('servers/rescan-now'), 0);
});

test('rescanSoon refreshes within seconds, and a growth call does not push it back', async () => {
  const abs = put('servers/rescan-soon/world/big.bin', 2048);
  await indexer.rescanNow();
  assert.equal(indexer.sizeOf('servers/rescan-soon'), 2048);
  fs.rmSync(abs);
  indexer.rescanSoon();
  indexer.scheduleScan(); // an unrelated upload landing right after the delete
  const deadline = Date.now() + 5000;
  while (indexer.sizeOf('servers/rescan-soon') !== 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(indexer.sizeOf('servers/rescan-soon'), 0, 'the removal shows within the quick-rescan window');
});
