'use strict';

// Cached sizes for map tile folders (BlueMap, Dynmap). A rendered map is often
// millions of tiny files; re-walking them on every storage scan pegged the
// panel's CPU and disk. The indexer walks each tile folder fully at most once
// a day and reuses the cached total in between (see storage/indexer.js).

function up(db) {
  db.exec(`
    CREATE TABLE storage_deep_cache (
      rel_path   TEXT    PRIMARY KEY,
      size_bytes INTEGER NOT NULL,
      file_count INTEGER NOT NULL,
      scanned_at INTEGER NOT NULL
    );
  `);
}

module.exports = { up };
