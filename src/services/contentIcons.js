'use strict';

// Backfill display metadata (local icon, name, version, MC-version/loader lists)
// for mod/plugin/datapack/resourcepack library rows that never got it - a
// transient fetch failure at install, or a row predating icon caching. Pairs
// with library.ensureContentMeta(), which does the per-row work and is also
// called lazily from the Mods tab render.

const fs = require('node:fs');
const path = require('node:path');
const db = require('../db');
const { dataPath } = require('../storage/pathGuard');
const { recordEvent } = require('../events');
const library = require('./library');
const logger = require('../logger')(path.basename(__filename));

const CONCURRENCY = 3;

function looksLikeFilename(name, filename) {
  if (!name) return true;
  if (!filename) return false;
  const n = String(name).trim().toLowerCase();
  const f = String(filename).toLowerCase();
  return n === f || n === f.replace(/\.(jar|zip)$/, '');
}

function needsRepair(r) {
  const registry = (r.platform === 'modrinth' || r.platform === 'curseforge') && r.project_id;
  // Nothing to repair from if there's neither a remote icon URL nor a registry
  // project to look one up against.
  if (!r.icon_url && !registry) return false;
  const iconMissing = !r.icon_rel_path || !fs.existsSync(dataPath(r.icon_rel_path));
  const metaMissing =
    registry && (!r.version || looksLikeFilename(r.name, r.filename) || (r.mc_versions_json || '[]') === '[]');
  return iconMissing || metaMissing;
}

/** @returns {Promise<{scanned:number, repaired:number}>} */
async function backfillContentMeta({ limit = 500 } = {}) {
  const rows = db
    .all(
      `SELECT * FROM library_files
       WHERE category IN ('mod','plugin','datapack','resourcepack')`
    )
    .filter(needsRepair)
    .slice(0, limit);

  if (!rows.length) return { scanned: 0, repaired: 0 };

  let repaired = 0;
  let cursor = 0;
  async function worker() {
    while (cursor < rows.length) {
      const row = rows[cursor++];
      const before = `${row.icon_rel_path || ''}|${row.name || ''}|${row.version || ''}`;
      try {
        await library.ensureContentMeta(row);
        const after = db.get('SELECT icon_rel_path, name, version FROM library_files WHERE id = ?', row.id);
        if (after && `${after.icon_rel_path || ''}|${after.name || ''}|${after.version || ''}` !== before) {
          repaired += 1;
        }
      } catch (err) {
        logger.debug('A content-metadata backfill row failed.', { id: row.id, err: String(err && err.message) });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rows.length) }, worker));

  const result = { scanned: rows.length, repaired };
  if (repaired) {
    recordEvent({
      actor: 'system',
      type: 'content-meta-backfilled',
      summary: `Repaired metadata for ${repaired} content file${repaired === 1 ? '' : 's'} (of ${rows.length} checked)`,
    });
  }
  logger.info('Content-metadata backfill finished.', result);
  return result;
}

module.exports = { backfillContentMeta };
