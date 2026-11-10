'use strict';

// Size indexer: walks ./data in the background, caches per-directory sizes in
// SQLite so every size shown in the UI is an instant lookup, and records
// growth snapshots. Never blocks a request on a disk walk.

const fs = require('node:fs/promises');
const path = require('node:path');
const config = require('../config');
const db = require('../db');
const logger = require('../logger')(path.basename(__filename));
const { serializeError } = require('../utils/logSanitize');
const { makeFailureThrottle } = require('../logger');
const { STAT_BATCH } = require('../utils/statSizes');
const { MAP_TILE_PREFIXES } = require('../services/backupFilter');

// Map tile folders (BlueMap, Dynmap) are often millions of tiny files. Walking
// them on every scan pegged CPU and disk for minutes at a time, so each one is
// walked fully at most once per DEEP_TTL_MS and its cached total reused in
// between (table storage_deep_cache). Sizes on the Storage page and quota checks
// still include them, at most a day stale for that one folder.
const DEEP_TTL_MS = 24 * 3600 * 1000;
const TILE_SUFFIXES = MAP_TILE_PREFIXES.map((p) => p.replace(/\/$/, ''));
/** True for data/servers/<id>/<map tile prefix>. */
function isTileDir(rel) {
  const m = /^servers\/[^/]+\/(.+)$/.exec(rel);
  return Boolean(m && TILE_SUFFIXES.includes(m[1]));
}

/** stat() every path in bounded parallel batches; null for one that vanished. */
async function statBatch(paths) {
  const out = [];
  for (let i = 0; i < paths.length; i += STAT_BATCH) {
    out.push(...(await Promise.all(paths.slice(i, i + STAT_BATCH).map((p) => fs.stat(p).catch(() => null)))));
  }
  return out;
}

// Directory depth the storage_index table caches (servers/<id>/<sub> = 3).
const MAX_CACHED_DEPTH = 3;

let scanning = false;
let timer = null;
// When the last scan STARTED; the interval skip uses it to avoid re-walking the
// whole tree minutes after a mutation-driven scheduleScan() already did.
let lastScanAt = 0;
const scanThrottle = makeFailureThrottle();
const onScanFailed = (err) =>
  scanThrottle.fail(logger.warn, 'A storage index scan failed.', { err: serializeError(err, { includeStack: false }) });

/** Directories whose sizes we track individually (top-level categories + per-server/per-library-kind). */
async function scan() {
  if (scanning) return { skipped: true };
  scanning = true;
  lastScanAt = Date.now();
  const started = Date.now();
  try {
    const root = config.dataDir;
    const results = new Map(); // relPath -> {size, files}
    const deepCache = new Map(
      db.all('SELECT rel_path, size_bytes, file_count, scanned_at FROM storage_deep_cache').map((r) => [r.rel_path, r])
    );
    const seenTileDirs = new Set();
    let deepWalks = 0;

    async function walk(abs, rel) {
      if (isTileDir(rel)) {
        seenTileDirs.add(rel);
        const cached = deepCache.get(rel);
        if (cached && Date.now() - cached.scanned_at < DEEP_TTL_MS) {
          return { size: cached.size_bytes, files: cached.file_count };
        }
        const fresh = await walkTree(abs, rel);
        deepWalks += 1;
        db.run(
          `INSERT INTO storage_deep_cache (rel_path, size_bytes, file_count, scanned_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(rel_path) DO UPDATE SET size_bytes = excluded.size_bytes, file_count = excluded.file_count, scanned_at = excluded.scanned_at`,
          rel,
          fresh.size,
          fresh.files,
          Date.now()
        );
        return fresh;
      }
      return walkTree(abs, rel);
    }

    async function walkTree(abs, rel) {
      let size = 0;
      let files = 0;
      let entries;
      try {
        entries = await fs.readdir(abs, { withFileTypes: true });
      } catch {
        return { size: 0, files: 0 }; // intentional: directory not present or unreadable
      }
      const fileAbs = [];
      for (const entry of entries) {
        const childAbs = path.join(abs, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          const sub = await walk(childAbs, rel ? `${rel}/${entry.name}` : entry.name);
          size += sub.size;
          files += sub.files;
        } else if (entry.isFile()) {
          fileAbs.push(childAbs);
        }
      }
      // Stat this directory's files in bounded parallel batches. A file that
      // vanished between readdir and stat is skipped (not counted).
      const stats = await statBatch(fileAbs);
      for (const st of stats) {
        if (!st) continue;
        size += st.size;
        files += 1;
      }
      // Only the depths the table caches are kept: a modpack or world tree has
      // tens of thousands of deeper dirs whose entries were held in memory for
      // the whole scan and then thrown away.
      if (rel && rel.split('/').length <= MAX_CACHED_DEPTH) results.set(rel, { size, files });
      return { size, files };
    }

    const total = await walk(root, '');
    results.set('', total);
    // Forget tile folders that no longer exist (map removed, server deleted).
    for (const rel of deepCache.keys()) {
      if (!seenTileDirs.has(rel)) db.run('DELETE FROM storage_deep_cache WHERE rel_path = ?', rel);
    }
    logger.debug('Finished a storage index scan.', {
      ms: Date.now() - started,
      dirs: results.size,
      tileDirsCached: seenTileDirs.size - deepWalks,
      tileDirsWalked: deepWalks,
    });

    // Skip the DB rewrite when the walk produced exactly what the table already
    // holds. In-place file rewrites that leave sizes unchanged (a rewritten
    // config, an overwritten log) otherwise churn the whole DELETE+reinsert AND
    // a storage_snapshot row every 15 minutes for zero information.
    if (cachedEqual(results)) {
      // Still stamp the scan time (the Storage page shows "last scanned") and
      // keep the usage-history series continuous - one cheap row, not a rewrite.
      db.run("UPDATE storage_index SET scanned_at = datetime('now')");
      recordSnapshot(results, total);
      scanThrottle.ok(logger.info, 'The storage index scan recovered.');
      return { totalBytes: total.size, dirs: results.size, ms: Date.now() - started, unchanged: true };
    }

    db.transaction(() => {
      db.run('DELETE FROM storage_index');
      const insert = db
        .open()
        .prepare(
          "INSERT INTO storage_index (rel_path, size_bytes, file_count, scanned_at) VALUES (?, ?, ?, datetime('now'))"
        );
      for (const [rel, v] of results) {
        // The walk only kept depth ≤ MAX_CACHED_DEPTH; deeper paths are summed live.
        insert.run(rel, v.size, v.files);
      }
    });

    recordSnapshot(results, total);

    scanThrottle.ok(logger.info, 'The storage index scan recovered.');
    return { totalBytes: total.size, dirs: results.size, ms: Date.now() - started };
  } finally {
    scanning = false;
  }
}

/** Append one usage-history point (total + per-server sizes), keeping the last 500. */
function recordSnapshot(results, total) {
  const perServer = {};
  for (const [rel, v] of results) {
    const m = /^servers\/([^/]+)$/.exec(rel);
    if (m) perServer[m[1]] = v.size;
  }
  db.run(
    'INSERT INTO storage_snapshots (total_bytes, per_server_json) VALUES (?, ?)',
    total.size,
    JSON.stringify(perServer)
  );
  db.run('DELETE FROM storage_snapshots WHERE id NOT IN (SELECT id FROM storage_snapshots ORDER BY id DESC LIMIT 500)');
}

/** True when the scanned depth ≤ 3 rows exactly match the cache table's. */
function cachedEqual(results) {
  const rows = db.all('SELECT rel_path, size_bytes, file_count FROM storage_index');
  if (rows.length === 0) return false;
  if (rows.length !== results.size) return false;
  for (const r of rows) {
    const v = results.get(r.rel_path);
    if (!v || v.size !== r.size_bytes || v.files !== r.file_count) return false;
  }
  return true;
}

// Hourly backstop: every upload, delete, copy, backup and restore already
// schedules its own scan (scheduleScan below), so the interval only catches
// changes made outside the panel (the game writing its world, a map render).
function startIndexer({ intervalMs = 60 * 60 * 1000 } = {}) {
  scan().catch(onScanFailed);
  // Mutation-driven scheduleScan() calls frequently land near an interval tick;
  // re-walking the whole tree again minutes after one finished is pure waste,
  // so skip a tick that follows a scan by less than half the interval.
  timer = setInterval(() => {
    if (Date.now() - lastScanAt < intervalMs / 2) return;
    scan().catch(onScanFailed);
  }, intervalMs);
  timer.unref();
}

// Coalesce the "rescan after a filesystem mutation" calls that fire from every
// upload / delete / copy / backup / restore. A burst of ops (e.g. deleting a
// dozen files, or a restore that also writes a safety backup) used to kick off a
// full recursive stat-walk of data/ per op; this collapses them into one walk a
// short while after the LAST mutation. Trailing debounce: every call pushes the
// timer out, so a walk never runs mid-restore. The 15-minute interval scan is
// the backstop if mutations never stop long enough for the timer to fire.
let debounceTimer = null;
let debounceDue = 0;
let debounceSoon = false;
// A request that lands while a walk is running would otherwise be dropped (scan()
// returns { skipped }) and the deletion it was for would wait for the next tick.
let rerunAfterScan = false;
function scheduleScan({ delayMs = 45_000 } = {}) {
  const due = Date.now() + delayMs;
  // A quick rescan (a removal) is never pushed later, by another removal or by a
  // growth call; the walk it runs covers both. Growth calls alone keep the long
  // trailing debounce, so a walk never lands mid-restore.
  if (debounceTimer && debounceSoon && debounceDue <= due) return;
  debounceSoon = delayMs < 45_000;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceDue = due;
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    runQueuedScan();
  }, delayMs);
  debounceTimer.unref();
}

function runQueuedScan() {
  if (scanning) {
    rerunAfterScan = true;
    return;
  }
  scan()
    .catch(onScanFailed)
    .finally(() => {
      if (rerunAfterScan) {
        rerunAfterScan = false;
        runQueuedScan();
      }
    });
}

/**
 * Something was removed: refresh the sizes the Storage page, quota bars and
 * dashboard show within a couple of seconds, not 45. A short trailing debounce
 * still folds a multi-select delete into one walk.
 */
function rescanSoon() {
  scheduleScan({ delayMs: 1500 });
}

/**
 * Rescan now and wait for it, for a caller that reloads the page straight after
 * (Storage cleanup). Waits out a walk already running, then walks again so the
 * result includes this removal.
 */
async function rescanNow() {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  while (scanning) await new Promise((r) => setTimeout(r, 100));
  return scan().catch((err) => {
    onScanFailed(err);
    return { failed: true };
  });
}

/** Instant size lookup from cache; 0 when not yet scanned. */
function sizeOf(relPath) {
  const row = db.get('SELECT size_bytes FROM storage_index WHERE rel_path = ?', relPath);
  return row ? row.size_bytes : 0;
}

/** Batched size lookups: one SELECT instead of per-path round-trips (listing a
 *  directory with many subdirs used to issue a query per entry). Missing paths
 *  resolve to 0, matching sizeOf. */
function sizeOfMany(relPaths) {
  // The empty-string rel_path is the index's root-total row (see the scan's
  // `results.set('', total)`), so only undefined/null are dropped here.
  const unique = [...new Set(relPaths)].filter((p) => p !== undefined && p !== null);
  if (unique.length === 0) return new Map();
  const rows = db.all(
    `SELECT rel_path, size_bytes FROM storage_index WHERE rel_path IN (${unique.map(() => '?').join(',')})`,
    ...unique
  );
  return new Map(rows.map((r) => [r.rel_path, r.size_bytes]));
}

function lastScan() {
  const row = db.get('SELECT MAX(scanned_at) AS t FROM storage_index');
  return row ? row.t : null;
}

// In-flight disk-growing operations (backup, restore, world install/
// duplicate...) reserve the bytes they expect to need so diskFree() reflects
// what's ACTUALLY available once every concurrent operation's own preflight
// claim is accounted for - without this, two such operations starting close
// together (e.g. two servers' scheduled backups landing on the same cron
// tick) can each independently see enough real free space, both pass their
// own preflight check, and jointly overrun the disk. This is advisory
// bookkeeping in this process only, not a hard OS-level reservation.
let reservedBytes = 0;

/** Reserve `bytes` against diskFree() until the returned release() is called
 *  (call it in a finally so a thrown/rejected operation still releases it). */
function reserveDiskSpace(bytes) {
  reservedBytes += bytes;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    reservedBytes -= bytes;
  };
}

async function diskFree() {
  const st = await fs.statfs(config.dataDir);
  const free = st.bavail * st.bsize;
  return { free: Math.max(0, free - reservedBytes), total: st.blocks * st.bsize };
}

/** Quota check used before disk-growing operations. Throws a friendly 409. */
function assertUnderQuota(server, aboutToAddBytes = 0) {
  if (!server.disk_quota_bytes) return;
  const used = sizeOf(`servers/${server.id}`);
  if (used + aboutToAddBytes > server.disk_quota_bytes) {
    const err = new Error(
      `${server.display_name} is over its disk quota. Free some space or raise the limit in Settings → Resources.`
    );
    err.status = 409;
    throw err;
  }
}

/** Strict-mode sweep: auto-stop servers >10% over quota. Called after scans. */
async function enforceStrictQuotas() {
  const servers = db.all(
    'SELECT * FROM servers WHERE deleted_at IS NULL AND quota_strict = 1 AND disk_quota_bytes > 0'
  );
  for (const s of servers) {
    const used = sizeOf(`servers/${s.id}`);
    if (used > s.disk_quota_bytes * 1.1 && ['running', 'starting', 'unhealthy', 'stalled'].includes(s.status)) {
      const { stopServer } = require('../services/servers');
      const { recordEvent } = require('../events');
      recordEvent({
        serverId: s.id,
        type: 'quota-exceeded',
        summary: `Strict quota: usage ${(used / 1024 ** 3).toFixed(1)} GB exceeds the quota by more than 10%. Stopping the server.`,
      });
      logger.warn('Stopping a server that is more than 10 percent over its strict disk quota.', {
        serverId: s.id,
        usedBytes: used,
        quotaBytes: s.disk_quota_bytes,
      });
      await stopServer(s.id, { actor: 'system' }).catch((err) => {
        logger.error('Could not stop a server that exceeded its strict disk quota.', {
          serverId: s.id,
          err: serializeError(err),
        });
      });
    }
  }
}

module.exports = {
  scan,
  scheduleScan,
  rescanSoon,
  rescanNow,
  startIndexer,
  sizeOf,
  sizeOfMany,
  lastScan,
  diskFree,
  reserveDiskSpace,
  assertUnderQuota,
  enforceStrictQuotas,
};
