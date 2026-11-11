'use strict';

// An applied update leaves the Updates page and the badge right away, not
// only after the next update check: a rebuilt container records the image it
// now runs, and a loader-build row stops counting once the build moved on.

require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');
const { migrate } = require('../src/db/migrate');
migrate();
const db = require('../src/db');
const checker = require('../src/updates/checker');

function seed(id, env = {}) {
  db.run(
    `INSERT INTO servers (id, display_name, type, mc_version, port_game, port_rcon, rcon_password_cipher, heap_mb,
       container_memory_mb, status, update_policy, env_json, container_id)
     VALUES (?, ?, 'PAPER', '1.21.4', ?, ?, 'x', 1024, 1536, 'stopped', 'notify', ?, 'c-' || ?)`,
    id,
    id,
    27000 + Math.floor(Math.random() * 900),
    28000 + Math.floor(Math.random() * 900),
    JSON.stringify(env),
    id
  );
}
const offer = (type, id, current, latest) =>
  db.run(
    `INSERT INTO update_checks (subject_type, subject_id, current_version, latest_version, latest_name, checked_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))`,
    type,
    id,
    current,
    latest,
    latest
  );
const imageRow = (id) => checker.listOutdated().find((r) => r.serverId === id && r.subjectType === 'image');

test('rebuilding onto the offered image clears the image update at once', () => {
  seed('srv_img1');
  offer('image', 'srv_img1', 'sha256:old', 'sha256:new');
  assert.ok(imageRow('srv_img1'), 'offered before the rebuild');
  const before = checker.countOutdatedByKind().server;
  checker.noteContainerImage('srv_img1', 'sha256:new');
  assert.equal(imageRow('srv_img1'), undefined, 'gone from the Updates page');
  assert.equal(checker.countOutdatedByKind().server, before - 1, 'and from the badge');
});

test('a rebuild that is still behind a newer image keeps the offer', () => {
  seed('srv_img2');
  offer('image', 'srv_img2', 'sha256:old', 'sha256:newest');
  checker.noteContainerImage('srv_img2', 'sha256:middle');
  const row = imageRow('srv_img2');
  assert.ok(row, 'still offered');
  assert.equal(
    db.get("SELECT current_version FROM update_checks WHERE subject_id = 'srv_img2'").current_version,
    'sha256:middle'
  );
});

test('a loader-build offer stops counting once the server moved to another build', () => {
  seed('srv_ldr', { PAPER_BUILD: '100' });
  offer('loader_build', 'srv_ldr', '100', '120');
  const counted = () => checker.countOutdatedByKind({ serverIds: ['srv_ldr'] }).server;
  assert.equal(counted(), 1);
  // Applying the update writes the new build through updateServer, which
  // also resets the memoized count.
  require('../src/services/servers').updateServer('srv_ldr', { env: { PAPER_BUILD: '120' } });
  assert.equal(counted(), 0);
});
