'use strict';

const app = require('./helpers/app');
const test = require('node:test');
const assert = require('node:assert/strict');

const SID = 'srv_navgroups';
let cookie;

test.before(async () => {
  await app.start();
  cookie = await app.adminCookie();
  app.seedServer(SID);
});
test.after(() => app.stop());

const html = async (path) => (await app.req('GET', path, { cookie, headers: { Accept: 'text/html' } })).text;

test('server pages show the six sections, with each page under the section it belongs to', async () => {
  const overview = await html(`/servers/${SID}`);
  for (const label of ['Overview', 'Console', 'Players', 'Content', 'Data', 'Settings']) {
    assert.match(overview, new RegExp(`</svg>\\s*<span[^>]*>${label}</span>`), `section ${label}`);
  }
  // Overview owns live metrics and the activity log (with crash reports).
  assert.match(overview, new RegExp(`href="/servers/${SID}/metrics"[^>]*>\\s*Performance`));
  assert.match(overview, new RegExp(`href="/servers/${SID}/history"[^>]*>\\s*Activity`));
  // Invites sit with the people, backups with the files on disk.
  assert.match(await html(`/servers/${SID}/players`), new RegExp(`href="/servers/${SID}/invites"`));
  assert.match(await html(`/servers/${SID}/backups`), new RegExp(`href="/servers/${SID}/files"`));
  // The chatbot (admins) answers in-game chat, so it sits under Console.
  assert.match(await html(`/servers/${SID}/console`), new RegExp(`href="/servers/${SID}/chatbot"`));
});

test('configuration has a jump bar and keeps Save pinned', async () => {
  const page = await html(`/servers/${SID}/settings`);
  for (const id of ['sec-general', 'sec-startup', 'sec-resources', 'port', 'sec-maintenance']) {
    assert.match(page, new RegExp(`data-jump="${id}"`));
    assert.match(page, new RegExp(`id="${id}"`));
  }
  assert.match(page, /class="action-bar[^"]*"[^>]*>[\s\S]*?id="st-save"/);
});

test('user accounts live on Users & Permissions, and Panel Settings points there', async () => {
  const perms = await html('/settings/permissions');
  assert.match(perms, /id="users-table"/);
  assert.match(perms, /id="lockouts-body"/);
  const settings = await html('/settings');
  assert.doesNotMatch(settings, /id="users-table"/);
  assert.match(settings, /Open Users &amp; Permissions/);
});

test('schedules can be narrowed to one server', async () => {
  const page = await html(`/schedules?server=${SID}`);
  assert.match(page, new RegExp(`data-focus-server="${SID}"`));
  assert.match(page, /Show All Schedules/);
});

test('a server with unread crash reports is marked red on its page, its card and the status row', async () => {
  const db = require('../src/db');
  db.run(
    `INSERT INTO crash_reports (id, server_id, filename, file_mtime, size_bytes, summary)
     VALUES ('cr_navred', ?, 'crash-red.txt', ?, 10, 'Ticking entity.')`,
    SID,
    new Date().toISOString()
  );
  const page = await html(`/servers/${SID}`);
  assert.match(
    page,
    /card mb-6 overflow-hidden border-danger\/50" style="border-top: 3px solid var\(--color-redstone-500\)"/
  );
  assert.match(page, /badge badge-danger">1 new crash</);
  const dash = await html('/');
  assert.match(dash, /border-danger\/50 bg-danger\/5"/);
  assert.match(dash, /Servers by Status/);
  db.run("UPDATE servers SET status = 'crashed' WHERE id = ?", SID);
  assert.match(
    await html('/'),
    /font-semibold text-danger"><span class="status-dot bg-redstone-500"><\/span>1 Crashed/
  );
});
