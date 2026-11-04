'use strict';

const app = require('./helpers/app');
const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');
const scheduler = require('../src/services/scheduler');

const SID = 'srv_qolbatch2';
let cookie;

test.before(async () => {
  await app.start();
  cookie = await app.adminCookie();
  app.seedServer(SID);
});
// Created schedules arm real cron timers: drop them, or the run never exits.
test.after(async () => {
  for (const { id } of db.all('SELECT id FROM schedules')) scheduler.deleteSchedule(id);
  await app.stop();
});

test('Run Now answers at once and records who ran it; an unknown schedule is a 404', async () => {
  const sched = scheduler.createSchedule(
    { serverId: null, taskType: 'tmp-clean', cron: '0 4 * * *' },
    { actor: 'admin' }
  );
  const r = await app.req('POST', `/api/schedules/${sched.id}/run`, { cookie });
  assert.equal(r.status, 202);
  const ev = db.get("SELECT actor, summary FROM events WHERE type = 'schedule-run-now' ORDER BY id DESC LIMIT 1");
  assert.equal(ev.actor, 'admin');
  assert.equal(ev.summary, 'Ran a scheduled task now: Clear temporary files.');
  const missing = await app.req('POST', '/api/schedules/sch_nope/run', { cookie });
  assert.equal(missing.status, 404);
});

test('a backup note can be set, shown on both backup lists, and cleared', async () => {
  db.run(
    "INSERT INTO backups (id, server_id, filename, rel_path, size_bytes, reason, note) VALUES ('bk_note1', ?, 'a.zip', 'backups/x/a.zip', 10, 'manual', '')",
    SID
  );
  const set = await app.req('PATCH', '/api/backups/bk_note1', { cookie, body: { note: 'Before the 1.21 upgrade' } });
  assert.equal(set.status, 200);
  assert.equal(set.json.backup.note, 'Before the 1.21 upgrade');
  for (const page of ['/backups', `/servers/${SID}/backups`]) {
    const html = (await app.req('GET', page, { cookie, headers: { Accept: 'text/html' } })).text;
    assert.match(html, /data-backup-note>Before the 1\.21 upgrade</, page);
  }
  const cleared = await app.req('PATCH', '/api/backups/bk_note1', { cookie, body: { note: '' } });
  assert.equal(cleared.json.backup.note, '');
  const nothing = await app.req('PATCH', '/api/backups/bk_note1', { cookie, body: {} });
  assert.equal(nothing.status, 400);
});

test('Overview shows the next backup (own or fleet-wide) and says when none is scheduled', async () => {
  let html = (await app.req('GET', `/servers/${SID}`, { cookie, headers: { Accept: 'text/html' } })).text;
  assert.match(html, /Next Backup<\/dt><dd class="font-medium"><span class="text-warn">Not scheduled<\/span>/);
  scheduler.createSchedule({ serverId: null, taskType: 'backup-all', cron: '0 3 * * *' }, { actor: 'admin' });
  html = (await app.req('GET', `/servers/${SID}`, { cookie, headers: { Accept: 'text/html' } })).text;
  assert.match(html, /Next Backup<\/dt><dd class="font-medium"><span data-ts-in="\d+">/);
});

test('a server with changes waiting shows the Apply Changes banner', async () => {
  db.run('UPDATE servers SET pending_recreate = 1 WHERE id = ?', SID);
  const html = (await app.req('GET', `/servers/${SID}`, { cookie, headers: { Accept: 'text/html' } })).text;
  assert.match(html, /Changes are waiting\./);
  db.run('UPDATE servers SET pending_recreate = 0 WHERE id = ?', SID);
});
