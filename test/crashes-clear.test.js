'use strict';

const app = require('./helpers/app');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const db = require('../src/db');
const { dataPath } = require('../src/storage/pathGuard');

const SID = 'srv_crashclear';
let cookie;

function seedCrash(id, filename) {
  const dir = dataPath('servers', SID, 'crash-reports');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(`${dir}/${filename}`, '---- Minecraft Crash Report ----');
  db.run(
    `INSERT INTO crash_reports (id, server_id, filename, file_mtime, size_bytes, summary)
     VALUES (?, ?, ?, ?, 32, 'Ticking entity.')`,
    id,
    SID,
    filename,
    new Date().toISOString()
  );
}

test.before(async () => {
  await app.start();
  cookie = await app.adminCookie();
  app.seedServer(SID);
});
test.after(() => app.stop());

test('one crash report clears on its own: file and row both go', async () => {
  seedCrash('cr_one', 'crash-one.txt');
  seedCrash('cr_two', 'crash-two.txt');
  const res = await app.req('DELETE', `/api/servers/${SID}/crashes/cr_one`, { cookie });
  assert.equal(res.status, 200);
  assert.equal(db.get('SELECT id FROM crash_reports WHERE id = ?', 'cr_one'), undefined);
  assert.ok(!fs.existsSync(dataPath('servers', SID, 'crash-reports', 'crash-one.txt')));
  assert.ok(db.get('SELECT id FROM crash_reports WHERE id = ?', 'cr_two'), 'the other report is untouched');
});

test('Clear All removes every report for the server and records one history line', async () => {
  seedCrash('cr_three', 'crash-three.txt');
  const res = await app.req('DELETE', `/api/servers/${SID}/crashes?all=1`, { cookie });
  assert.equal(res.status, 200);
  assert.equal(res.json.deleted, 2);
  assert.equal(res.json.failed, 0);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM crash_reports WHERE server_id = ?', SID).n, 0);
  const events = db.all("SELECT summary FROM events WHERE server_id = ? AND type = 'crash-report-deleted'", SID);
  assert.ok(events.some((e) => e.summary === 'Cleared 2 crash reports.'));
});

test('an unknown crash id answers 404', async () => {
  const res = await app.req('DELETE', `/api/servers/${SID}/crashes/cr_missing`, { cookie });
  assert.equal(res.status, 404);
});
