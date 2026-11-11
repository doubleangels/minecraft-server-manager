'use strict';

// The fast check that follows a scheduled backup: reads only the archive's
// index, and catches a truncated or half-written archive.

require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ZipArchive } = require('archiver');
const { migrate } = require('../src/db/migrate');
migrate();
const { zipStructureCheck } = require('../src/services/backups');

async function makeZip(file) {
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(file);
    const zip = new ZipArchive({ zlib: { level: 1 } });
    out.on('close', resolve);
    zip.on('error', reject);
    zip.pipe(out);
    for (let i = 0; i < 5; i++) zip.append(Buffer.alloc(50_000, i), { name: `world/region/r.${i}.0.mca` });
    zip.finalize();
  });
}

test('a complete archive passes, a truncated one fails, a non-zip fails', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msm-zipcheck-'));
  const good = path.join(dir, 'good.zip');
  await makeZip(good);
  assert.deepEqual(await zipStructureCheck(good), { entries: 5 });

  // Cut the file short: the central directory is gone.
  const cut = path.join(dir, 'cut.zip');
  const bytes = fs.readFileSync(good);
  fs.writeFileSync(cut, bytes.subarray(0, Math.floor(bytes.length / 2)));
  await assert.rejects(zipStructureCheck(cut));

  fs.writeFileSync(path.join(dir, 'junk.zip'), 'not a zip at all');
  await assert.rejects(zipStructureCheck(path.join(dir, 'junk.zip')));
});
