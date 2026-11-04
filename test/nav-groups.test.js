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
    assert.match(overview, new RegExp(`</svg>\\s*${label}\\s`), `section ${label}`);
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
  assert.match(page, /sticky bottom-0[^"]*"[^>]*>[\s\S]*?id="st-save"/);
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
