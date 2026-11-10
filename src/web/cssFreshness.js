'use strict';

// public/css/app.css is a build output (gitignored). A from-source install builds
// it once, at `pnpm install`; after a `git pull` and a restart the panel would
// otherwise serve the new templates with the old stylesheet, so any class added
// since renders unstyled (no padding, wrong sizes). Boot calls this to rebuild
// the stylesheet when it is missing or older than anything Tailwind scans.
// Docker images build it in the image, so there it is always current.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const logger = require('../logger')(path.basename(__filename));

/** Newest mtime under `dir` (files only), or 0 when it does not exist. */
function newestMtime(dir) {
  let max = 0;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const ent of entries) {
    if (ent.name === 'node_modules' || ent.name === 'dist') continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) max = Math.max(max, newestMtime(p));
    else max = Math.max(max, fs.statSync(p).mtimeMs);
  }
  return max;
}

/**
 * True when app.css is missing or older than input.css or any file Tailwind
 * scans for class names (the @source roots in input.css: src, views, public/js).
 * @param {string} root the project root
 */
function cssIsStale(root) {
  const out = path.join(root, 'public', 'css', 'app.css');
  let built;
  try {
    built = fs.statSync(out).mtimeMs;
  } catch {
    return true;
  }
  const input = fs.statSync(path.join(root, 'assets', 'css', 'input.css')).mtimeMs;
  const sources = Math.max(
    input,
    newestMtime(path.join(root, 'src')),
    newestMtime(path.join(root, 'views')),
    newestMtime(path.join(root, 'public', 'js'))
  );
  return sources > built;
}

/** Path of the Tailwind CLI entry, or null when dev dependencies are not installed. */
function tailwindCli(root) {
  try {
    const pkgPath = require.resolve('@tailwindcss/cli/package.json', { paths: [root] });
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin && (pkg.bin.tailwindcss || Object.values(pkg.bin)[0]);
    return bin ? path.join(path.dirname(pkgPath), bin) : null;
  } catch {
    return null;
  }
}

/**
 * Rebuild app.css if it is stale. Never throws: a failed rebuild leaves the old
 * stylesheet in place and logs how to fix it.
 * @param {string} root the project root
 * @returns {'fresh' | 'rebuilt' | 'stale'}
 */
function ensureFreshCss(root) {
  try {
    if (!cssIsStale(root)) return 'fresh';
  } catch (err) {
    logger.debug('Could not compare the stylesheet with its sources.', { err: String(err && err.message) });
    return 'fresh';
  }
  const cli = tailwindCli(root);
  if (!cli) {
    logger.warn('The stylesheet is older than the templates, so new styles will be missing.', {
      fix: 'pnpm run build',
    });
    return 'stale';
  }
  const started = Date.now();
  const res = spawnSync(process.execPath, [cli, '-i', 'assets/css/input.css', '-o', 'public/css/app.css', '--minify'], {
    cwd: root,
    timeout: 120_000,
    encoding: 'utf8',
  });
  if (res.status === 0) {
    // Tailwind leaves the file untouched when the output is identical, so stamp
    // it: otherwise an unchanged rebuild would read as stale on every boot.
    const now = new Date();
    fs.utimesSync(path.join(root, 'public', 'css', 'app.css'), now, now);
    logger.info('Rebuilt the stylesheet because it was older than its source.', { ms: Date.now() - started });
    return 'rebuilt';
  }
  logger.warn('Could not rebuild the stylesheet, so new styles may be missing.', {
    status: res.status,
    fix: 'pnpm run build',
  });
  return 'stale';
}

module.exports = { ensureFreshCss, cssIsStale };
