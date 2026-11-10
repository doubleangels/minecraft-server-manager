'use strict';

// What a server backup leaves out, and which files it stores without
// re-compressing. Shared by the backup zip worker and its tests.
//
// Left out: things the server or a mod rebuilds by itself and that a restore
// never needs. Logs and crash reports are history, not state (the panel keeps
// its own crash records). Map renders (BlueMap tiles, dynmap tiles) are often
// the largest thing in a server folder, are already compressed images, and
// re-render from the world. Fabric's remap cache is rebuilt on boot.
//
// Stored as-is: formats that are already compressed. Deflating them again
// saves well under 1% and costs most of the CPU time of a backup.

/** Map renderer tile folders (relative to the server folder): regenerable, and
 *  often millions of tiny files. Backups skip them; the storage indexer sizes
 *  them at most once a day. */
const MAP_TILE_PREFIXES = [
  'bluemap/web/maps/',
  'plugins/BlueMap/web/maps/',
  'config/bluemap/web/maps/',
  'dynmap/web/tiles/',
  'plugins/dynmap/web/tiles/',
  'config/dynmap/web/tiles/',
];

/** Path prefixes (relative to the server folder, forward slashes) never backed up. */
const EXCLUDED_PREFIXES = ['logs/', 'debug/', '.fabric/remappedJars/', '.fabric/processedMods/', ...MAP_TILE_PREFIXES];

/** File names that are left out wherever they appear. */
const EXCLUDED_NAMES = new Set(['session.lock']);

const EXCLUDED_SUFFIXES = ['.tmp', '.mca.tmp', '.dat_old.tmp'];

const STORED_EXTENSIONS = new Set([
  '.jar',
  '.zip',
  '.gz',
  '.tgz',
  '.xz',
  '.zst',
  '.bz2',
  '.7z',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.ogg',
  '.mp3',
  '.prbin',
]);

/**
 * @param {string} rel path relative to the server folder, forward slashes
 * @param {boolean} [isDir]
 */
function isExcluded(rel, isDir = false) {
  const p = isDir && !rel.endsWith('/') ? `${rel}/` : rel;
  for (const prefix of EXCLUDED_PREFIXES) if (p.startsWith(prefix)) return true;
  const base = p.slice(p.lastIndexOf('/', p.length - 2) + 1);
  if (EXCLUDED_NAMES.has(base)) return true;
  if (!isDir) for (const s of EXCLUDED_SUFFIXES) if (p.endsWith(s)) return true;
  return false;
}

/** @param {string} rel */
function shouldStore(rel) {
  const dot = rel.lastIndexOf('.');
  if (dot < 0 || dot < rel.lastIndexOf('/')) return false;
  return STORED_EXTENSIONS.has(rel.slice(dot).toLowerCase());
}

// The same rules as glob options for the zip worker. `skip` stops the walk
// from descending into an excluded folder at all, so a map with 200k tiles
// costs nothing instead of 200k stat calls.
const SKIP_DIRS = EXCLUDED_PREFIXES.map((p) => p.replace(/\/$/, ''));
const IGNORE_GLOBS = [...[...EXCLUDED_NAMES].map((n) => `**/${n}`), ...EXCLUDED_SUFFIXES.map((x) => `**/*${x}`)];
const STORED_GLOBS = [...STORED_EXTENSIONS].map((ext) => `**/*${ext}`);

module.exports = {
  isExcluded,
  shouldStore,
  MAP_TILE_PREFIXES,
  EXCLUDED_PREFIXES,
  SKIP_DIRS,
  IGNORE_GLOBS,
  STORED_GLOBS,
};
