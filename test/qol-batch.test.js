'use strict';

const app = require('./helpers/app');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const db = require('../src/db');
const { dataPath } = require('../src/storage/pathGuard');
const containers = require('../src/docker/containers');
const { warnBeforeShutdown, marksFor, spell } = require('../src/services/shutdownWarning');

const SID = 'srv_qolbatch';
let cookie;

test.before(async () => {
  await app.start();
  cookie = await app.adminCookie();
  app.seedServer(SID);
});
test.after(() => app.stop());

test('a countdown announces at sensible marks and reads naturally', () => {
  assert.deepEqual(marksFor(300), [300, 120, 60, 30, 10, 5, 4, 3, 2, 1]);
  assert.deepEqual(marksFor(60), [60, 30, 10, 5, 4, 3, 2, 1]);
  assert.equal(spell(300), '5 minutes');
  assert.equal(spell(60), '1 minute');
  assert.equal(spell(30), '30 seconds');
});

test('warning players: skipped when the server is stopped, sent in chat when it runs', async () => {
  const said = [];
  const orig = containers.execCapture;
  containers.execCapture = async (_id, argv) => {
    said.push(argv.slice(3).join(' '));
    return '';
  };
  try {
    db.run("UPDATE servers SET status = 'stopped' WHERE id = ?", SID);
    assert.equal(
      (await warnBeforeShutdown(SID, { action: 'restart', seconds: 60, sleepFn: async () => {} })).warned,
      false
    );
    assert.equal(said.length, 0);

    db.run("UPDATE servers SET status = 'running' WHERE id = ?", SID);
    const r = await warnBeforeShutdown(SID, { action: 'restart', seconds: 60, sleepFn: async () => {} });
    assert.equal(r.warned, true);
    assert.equal(said[0], 'Restarting the server in 1 minute. Find a safe spot. You can rejoin shortly.');
    assert.equal(said.at(-1), 'Restarting in 1…');
  } finally {
    containers.execCapture = orig;
    db.run("UPDATE servers SET status = 'stopped' WHERE id = ?", SID);
  }
});

test('a stop during the countdown cancels the action', async () => {
  const orig = containers.execCapture;
  containers.execCapture = async () => '';
  try {
    db.run("UPDATE servers SET status = 'running' WHERE id = ?", SID);
    let ticks = 0;
    const r = await warnBeforeShutdown(SID, {
      action: 'restart',
      seconds: 30,
      sleepFn: async () => {
        if (++ticks === 2) db.run("UPDATE servers SET status = 'stopped' WHERE id = ?", SID);
      },
    });
    assert.equal(r.cancelled, true);
  } finally {
    containers.execCapture = orig;
  }
});

test('Restart with a warning answers at once with a task instead of holding the request', async () => {
  const r = await app.req('POST', `/api/servers/${SID}/restart`, { cookie, body: { warnSeconds: 60 } });
  assert.equal(r.status, 202);
  assert.match(r.json.taskId, /^task_/);
});

test('custom console quick buttons are validated, saved per server, and cleaned up', async () => {
  const bad = await app.req('PUT', `/api/servers/${SID}/console-quick`, {
    cookie,
    body: { commands: [{ label: '', command: 'list' }] },
  });
  assert.equal(bad.status, 400);
  const ok = await app.req('PUT', `/api/servers/${SID}/console-quick`, {
    cookie,
    body: { commands: [{ label: 'Night Vision', command: '/effect give @a night_vision 600' }] },
  });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json.commands, [{ label: 'Night Vision', command: 'effect give @a night_vision 600' }]);
  const page = await app.req('GET', `/servers/${SID}/console`, { cookie, headers: { Accept: 'text/html' } });
  assert.match(page.text, /data-quick-custom data-quick="\[\{&quot;label&quot;:&quot;Night Vision&quot;/);
});

test('last seen comes from logged play sessions, with an approximate fallback from the name cache', () => {
  fs.mkdirSync(dataPath('servers', SID), { recursive: true });
  fs.writeFileSync(
    dataPath('servers', SID, 'usercache.json'),
    JSON.stringify([
      { name: 'Alex', uuid: 'ec561538-f3fd-461d-aff5-086b22154bce', expiresOn: '2026-12-20 10:00:00 +0000' },
      { name: 'Steve', uuid: '8667ba71-b85a-4004-af54-457a9734eed7', expiresOn: '2026-12-01 10:00:00 +0000' },
    ])
  );
  db.run(
    "INSERT INTO player_sessions (server_id, player, started_at, ended_at) VALUES (?, 'Alex', '2026-11-01T10:00:00.000Z', '2026-11-01T12:00:00.000Z')",
    SID
  );
  const list = require('../src/services/players').listPlayers(SID, []);
  const alex = list.find((p) => p.name === 'Alex');
  const steve = list.find((p) => p.name === 'Steve');
  assert.equal(alex.lastSeen, '2026-11-01T12:00:00.000Z');
  assert.equal(alex.lastSeenApprox, false);
  assert.equal(steve.lastSeen, '2026-11-01T10:00:00.000Z'); // one month before the cache expiry
  assert.equal(steve.lastSeenApprox, true);
});
