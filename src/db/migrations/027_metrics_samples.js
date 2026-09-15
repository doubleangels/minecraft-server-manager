'use strict';

// Metrics history: one downsampled row per running server per minute, written
// by src/metrics/sampler.js from the in-memory live cache and read back by the
// dashboard trend chart and per-server history. Kept for METRICS_RETENTION_DAYS
// (see src/server.js runMaintenance). Follows the analytics table conventions:
// TEXT server_id, ISO-8601 UTC timestamps, no FK (server deletion is handled
// the same way as player_events).

function up(db) {
  db.exec(`
    CREATE TABLE metrics_samples (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      server_id       TEXT NOT NULL,
      ts              TEXT NOT NULL,
      cpu_pct         REAL,
      mem_used_bytes  INTEGER,
      mem_limit_bytes INTEGER,
      net_rx_bps      REAL,
      net_tx_bps      REAL,
      tps             REAL,
      mspt            REAL,
      players_online  INTEGER,
      players_max     INTEGER
    );
    CREATE INDEX idx_metrics_server_ts ON metrics_samples(server_id, ts);
    CREATE INDEX idx_metrics_ts ON metrics_samples(ts);
  `);
}

module.exports = { up };
