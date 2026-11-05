'use strict';

// The container log records every action with its details, and never a secret.
// Loggers are silent under test, so these swap a capture function onto the
// cached per-label logger objects the modules hold.

const app = require('./helpers/app');
const test = require('node:test');
const assert = require('node:assert/strict');
const getLogger = require('../src/logger');
const { redactCommand, summarizeBody } = require('../src/utils/logSanitize');

/** Capture every call made on one label's logger while fn runs. */
async function capture(label, fn) {
  const api = getLogger(label);
  const lines = [];
  const saved = {};
  for (const lvl of ['info', 'warn', 'debug', 'error']) {
    saved[lvl] = api[lvl];
    api[lvl] = (msg, meta) => lines.push({ lvl, msg, meta });
  }
  try {
    await fn();
  } finally {
    Object.assign(api, saved);
  }
  return lines;
}

const json = (v) => JSON.stringify(v);

let cookie;
test.before(async () => {
  await app.start();
  cookie = await app.adminCookie();
  app.seedServer('srv_logcov');
});
test.after(() => app.stop());

test('redactCommand masks credential commands and password/token/key values', () => {
  assert.equal(redactCommand('register hunter2 hunter2'), 'register [REDACTED]');
  assert.equal(redactCommand('/login hunter2'), '/login [REDACTED]');
  assert.equal(redactCommand('lp user x set password=abc'), 'lp user x set password=[REDACTED]');
  assert.equal(redactCommand('give Steve diamond 3'), 'give Steve diamond 3');
});

test('summarizeBody redacts secret keys, hides file contents, and shortens long text', () => {
  const out = summarizeBody({
    username: 'alex',
    password: 'p',
    env: { RCON_PASSWORD: 'x', CF_API_KEY: 'y', MOTD: 'Hi' },
    content: 'rcon.password=abc\nmotd=x',
    command: 'login secret1',
    note: 'n'.repeat(500),
    names: Array.from({ length: 30 }, (_, i) => `p${i}`),
  });
  assert.equal(out.password, '[REDACTED]');
  assert.equal(out.env.RCON_PASSWORD, '[REDACTED]');
  assert.equal(out.env.CF_API_KEY, '[REDACTED]');
  assert.equal(out.env.MOTD, 'Hi');
  assert.equal(out.content, '[24 chars]');
  assert.equal(out.command, 'login [REDACTED]');
  assert.match(out.note, /…\[500 chars\]$/);
  assert.equal(out.names.length, 21);
  assert.equal(summarizeBody({}), undefined);
});

test('the access log carries who, what and a sanitized body for a write', async () => {
  const lines = await capture('http', () =>
    app.req('PATCH', '/api/servers/srv_logcov', { cookie, body: { name: 'Renamed', rconPassword: 'nope' } })
  );
  const line = lines.find((l) => l.meta && l.meta.method === 'PATCH');
  assert.ok(line, 'a PATCH access line');
  assert.equal(line.meta.username, 'admin');
  assert.equal(line.meta.body.name, 'Renamed');
  assert.equal(line.meta.body.rconPassword, '[REDACTED]');
  assert.doesNotMatch(json(lines), /nope/);
});

test('sign-in and 2FA bodies never reach the access log, not even redacted', async () => {
  const lines = await capture('http', async () => {
    await app.req('POST', '/login', { body: { username: 'admin', password: 'wrong-password-123' } });
    await app.req('POST', '/api/account/totp/confirm', { cookie, body: { code: '123456', password: 'x' } });
  });
  const posts = lines.filter((l) => l.meta && l.meta.method === 'POST');
  assert.ok(posts.length >= 2);
  for (const l of posts) assert.equal(l.meta.body, undefined, l.meta.path);
  assert.doesNotMatch(json(lines), /wrong-password-123|123456/);
});

test('every history event is also a container log line with its details', async () => {
  const { recordEvent } = require('../src/events');
  const lines = await capture('events', () =>
    recordEvent({
      serverId: 'srv_logcov',
      actor: 'admin',
      type: 'config-changed',
      summary: 'Configuration changed: env.',
      details: { diff: { env: [{ RCON_PASSWORD: 'old' }, { RCON_PASSWORD: 'new', MOTD: 'Hello' }] } },
    })
  );
  assert.equal(lines.length, 1);
  const { meta } = lines[0];
  assert.equal(meta.type, 'config-changed');
  assert.equal(meta.actor, 'admin');
  assert.equal(meta.summary, 'Configuration changed: env.');
  assert.ok(Number.isInteger(meta.eventId));
  // The sanitizer runs inside the real logger's write(); check it as it would.
  const safe = require('../src/utils/logSanitize').sanitizeLogMeta(meta);
  assert.equal(safe.details.diff.env[1].RCON_PASSWORD, '[REDACTED]');
  assert.equal(safe.details.diff.env[1].MOTD, 'Hello');
});

test('a background task logs its start, steps and outcome once each', async () => {
  const tasks = require('../src/services/tasks');
  const lines = await capture('tasks.js', async () => {
    await tasks.track('Testing a task…', { serverId: 'srv_logcov', actor: 'admin' }, async (t) => {
      t.step('Doing the first thing…');
      t.step('Doing the second thing…');
    });
    await tasks
      .track('Failing a task…', { actor: 'admin' }, async () => {
        throw new Error('boom');
      })
      .catch(() => {});
  });
  const msgs = lines.map((l) => l.msg);
  assert.equal(msgs.filter((m) => m === 'Started a background task.').length, 2);
  assert.equal(msgs.filter((m) => m === 'A background task moved to its next step.').length, 2);
  assert.equal(msgs.filter((m) => m === 'A background task finished.').length, 1);
  const failed = lines.find((l) => l.msg === 'A background task failed.');
  assert.equal(failed.lvl, 'warn');
  assert.equal(failed.meta.err.errorMessage, 'boom');
});

test('panel setting changes log old and new values, and skip no-op writes', async () => {
  const settings = require('../src/services/settings');
  const lines = await capture('settings.js', () => {
    settings.set('logcov-test', { a: 1 });
    settings.set('logcov-test', { a: 1 });
    settings.set('logcov-test', { a: 2 });
  });
  assert.equal(lines.length, 2);
  assert.deepEqual(lines[1].meta, { key: 'logcov-test', from: { a: 1 }, to: { a: 2 } });
});
