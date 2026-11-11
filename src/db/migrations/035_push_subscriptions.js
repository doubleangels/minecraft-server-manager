'use strict';

// Devices that asked for push notifications (Web Push). One row per browser
// or installed app, owned by a user; `categories_json` is that device's own
// choice of what to hear about. Rows go with the user, and the push service
// telling us a subscription is gone (404/410) deletes it.

function up(db) {
  db.exec(`
    CREATE TABLE push_subscriptions (
      id              TEXT    PRIMARY KEY,
      user_id         TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      endpoint        TEXT    NOT NULL UNIQUE,
      p256dh          TEXT    NOT NULL,
      auth            TEXT    NOT NULL,
      categories_json TEXT    NOT NULL DEFAULT '["problems","failures","tasks"]',
      device_label    TEXT    NOT NULL DEFAULT '',
      created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
      last_sent_at    TEXT
    );
    CREATE INDEX idx_push_subscriptions_user ON push_subscriptions(user_id);
  `);
}

module.exports = { up };
