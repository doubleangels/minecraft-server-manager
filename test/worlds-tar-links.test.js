'use strict';

require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tar = require('tar');
const { extractArchive } = require('../src/services/worlds');

test('tar extraction drops symlink and hardlink entries, keeps files and folders', async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'msm-tarlinks-'));
  try {
    const src = path.join(work, 'src');
    fs.mkdirSync(path.join(src, 'world', 'region'), { recursive: true });
    fs.writeFileSync(path.join(src, 'world', 'level.dat'), 'level');
    fs.writeFileSync(path.join(src, 'world', 'region', 'r.0.0.mca'), 'region');
    fs.symlinkSync('/etc/passwd', path.join(src, 'world', 'evil-symlink'));
    fs.linkSync(path.join(src, 'world', 'level.dat'), path.join(src, 'world', 'evil-hardlink'));
    const archive = path.join(work, 'w.tar.gz');
    await tar.c({ gzip: true, file: archive, cwd: src }, ['world']);
    // The archive really holds both link kinds.
    const types = [];
    await tar.t({ file: archive, onReadEntry: (e) => types.push(e.type) });
    assert.ok(types.includes('SymbolicLink'));
    assert.ok(types.includes('Link'));

    const dest = path.join(work, 'out');
    fs.mkdirSync(dest);
    await extractArchive(archive, dest, 'w.tar.gz');
    assert.equal(fs.readFileSync(path.join(dest, 'world', 'region', 'r.0.0.mca'), 'utf8'), 'region');
    // One of level.dat / evil-hardlink is stored as the file, the other as a link entry.
    const kept = ['level.dat', 'evil-hardlink'].filter((n) => fs.existsSync(path.join(dest, 'world', n)));
    assert.equal(kept.length, 1, 'only the real file entry is written');
    assert.equal(fs.lstatSync(path.join(dest, 'world', kept[0])).nlink, 1);
    assert.throws(() => fs.lstatSync(path.join(dest, 'world', 'evil-symlink')), /ENOENT/);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});
