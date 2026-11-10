'use strict';

// Discord notifications read like the rest of the panel: Title Case titles,
// full-sentence descriptions, Title Case field names, and an accent color that
// says what kind of event it is.
require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');
const { EVENT_MAP, _eventEmbed: eventEmbed, _buildEmbed: buildEmbed } = require('../src/integrations/discord');

const SERVER = { id: 'srv_x', display_name: 'Survival', type: 'PAPER', mc_version: '1.21.4', port_game: 25565 };
const MINOR = new Set(['a', 'an', 'and', 'as', 'at', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to']);
const isTitleCase = (s) =>
  s.split(/\s+/).every((w, i) => (i > 0 && MINOR.has(w)) || /^[A-Z0-9(]/.test(w.replace(/^[(]/, '')));

const RED = 0xe5484d;
const GREEN = 0x3fa62b;
const GOLD = 0xe99417;
const BLUE = 0x21a7ab;

test('every forwarded event type has a Title Case title and a palette color', () => {
  for (const type of Object.keys(EVENT_MAP)) {
    const e = eventEmbed({ type, summary: 'Something happened.', server_id: 'srv_x' }, SERVER);
    assert.ok(isTitleCase(e.title), `${type}: "${e.title}" is Title Case`);
    assert.ok([RED, GREEN, GOLD, BLUE, 0x87919b].includes(e.color), `${type}: a palette color`);
    for (const f of e.fields) assert.ok(isTitleCase(f.name), `${type}: field "${f.name}" is Title Case`);
  }
});

test('the description is a full sentence and the time is the event time', () => {
  const evt = {
    type: 'crashed',
    server_id: 'srv_x',
    summary: 'Server crashed: the world failed to load',
    created_at: '2026-11-05 10:20:30',
    details_json: JSON.stringify({ exitCode: 1, armedRestart: true }),
  };
  const body = buildEmbed('crash', eventEmbed(evt, SERVER));
  const embed = body.embeds[0];
  assert.equal(embed.title, 'Server Crashed');
  assert.equal(embed.description, 'Server crashed: the world failed to load.');
  assert.equal(embed.color, RED);
  assert.equal(embed.timestamp, '2026-11-05T10:20:30.000Z');
  const byName = Object.fromEntries(embed.fields.map((f) => [f.name, f.value]));
  assert.equal(byName.Server, 'Survival');
  assert.equal(byName.Version, 'Paper 1.21.4');
  assert.equal(byName['Triggered By'], 'Panel (Automatic)');
  assert.equal(byName['Exit Code'], '1');
  assert.equal(byName['Auto-Restart'], 'Scheduled');
});

test('events carry the details they have, and tone follows meaning', () => {
  const backup = eventEmbed(
    {
      type: 'backup-created',
      server_id: 'srv_x',
      actor: 'alex',
      summary: 'Backup created (scheduled, 1.20 GB).',
      details_json: JSON.stringify({ reason: 'pre-update', filename: 'b.zip', entryCount: 1234 }),
    },
    SERVER
  );
  const b = Object.fromEntries(backup.fields.map((f) => [f.name, f.value]));
  assert.equal(backup.color, BLUE);
  assert.equal(b['Triggered By'], 'alex');
  assert.equal(b.Reason, 'Pre-Update');
  assert.equal(b.Files, '1,234');
  assert.equal(b.Archive, '`b.zip`');

  const warned = eventEmbed(
    { type: 'backup-created', server_id: 'srv_x', summary: 'x.', details_json: '{"empty":true}' },
    SERVER
  );
  assert.equal(warned.color, GOLD, 'a backup with warnings is gold');

  const ban = eventEmbed(
    {
      type: 'player-ban',
      server_id: 'srv_x',
      summary: 'Steve banned: griefing.',
      details_json: JSON.stringify({ name: 'Steve', reason: 'griefing' }),
    },
    SERVER
  );
  const n = Object.fromEntries(ban.fields.map((f) => [f.name, f.value]));
  assert.equal(n.Player, 'Steve');
  assert.equal(n.Until, 'Permanent');
  assert.equal(n.Reason, 'griefing.');

  const started = eventEmbed({ type: 'started', server_id: 'srv_x', summary: 'Server start requested.' }, SERVER, {
    publicHost: 'mc.example.com',
  });
  assert.equal(started.color, GREEN);
  assert.ok(started.fields.some((f) => f.name === 'Address' && f.value === 'mc.example.com:25565'));
});

test('a malformed details blob or an unknown type still sends a clean embed', () => {
  const e = eventEmbed({ type: 'some-new-event', server_id: 'srv_gone', summary: 'Done', details_json: '{oops' }, null);
  assert.equal(e.title, 'Some New Event');
  assert.equal(buildEmbed('stop', e).embeds[0].description, 'Done.');
  assert.deepEqual(
    e.fields.map((f) => f.name),
    ['Server', 'Triggered By']
  );
});
