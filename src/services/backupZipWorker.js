'use strict';

// Runs the actual zip compression for a backup off the main thread. archiver
// streams from disk, but the zlib deflate + directory-walk framing still burn
// main-thread CPU on a large modded world; here they burn a worker's instead,
// so the panel stays responsive mid-backup.
//
// Messages back to the parent: {type:'progress', processedBytes} repeatedly,
// then exactly one of {type:'done'} / {type:'error', message}.

const fs = require('node:fs');
const { parentPort, workerData } = require('node:worker_threads');
const { ZipArchive } = require('archiver');
const { SKIP_DIRS, IGNORE_GLOBS, STORED_GLOBS } = require('./backupFilter');

const { sourceDir, outFile } = workerData;

let settled = false;
const finish = (msg) => {
  if (settled) return;
  settled = true;
  parentPort.postMessage(msg);
};

const output = fs.createWriteStream(outFile);
// Level 1. A world backup is mostly region files (.mca), whose chunks are
// already zlib-compressed inside: deflate only squeezes the sector padding,
// and how hard it tries makes no real difference. Measured on region-shaped
// data: level 1 left 84.8% of the input, level 9 left 84.7%, and level 9 took
// about 50% longer. The small text files (configs, stats) give up a little,
// but they are a sliver of an archive. Already-compressed formats skip deflate
// entirely (see backupFilter).
const archive = new ZipArchive({ zlib: { level: 1 }, statConcurrency: 8 });

const fail = (err) => {
  if (settled) return;
  // Drop the half-written archive so a repeatedly failing scheduled backup can't
  // leak fds / orphan partial files.
  try {
    output.destroy();
  } catch {
    /* already gone */
  }
  fs.rm(outFile, { force: true }, () =>
    finish({ type: 'error', message: err && err.message ? err.message : String(err) })
  );
};

output.on('close', () => finish({ type: 'done' }));
output.on('error', fail);
archive.on('error', fail);
archive.on('progress', (d) => {
  if (!settled) parentPort.postMessage({ type: 'progress', processedBytes: d.fs.processedBytes });
});

archive.pipe(output);
// Two walks: everything that deflates, then the already-compressed formats
// stored as-is. Both skip excluded folders without descending into them.
const base = { cwd: sourceDir, dot: true, skip: SKIP_DIRS };
archive.glob('**', { ...base, ignore: [...IGNORE_GLOBS, ...STORED_GLOBS] });
archive.glob(STORED_GLOBS, { ...base, nodir: true, ignore: IGNORE_GLOBS }, { store: true });
archive.finalize();
