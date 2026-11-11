'use strict';

// Web Push: the message encryption (checked against RFC 8291's worked
// example), the VAPID signature, the subscription routes, and who gets which
// alert.

const app = require('./helpers/app');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const db = require('../src/db');
const webPush = require('../src/services/webPush');
const push = require('../src/services/pushNotify');

const b64u = (s) => Buffer.from(s, 'base64url');

test('encryption reproduces RFC 8291 Appendix A byte for byte', () => {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(b64u('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'));
  const out = webPush.encrypt(
    Buffer.from('When I grow up, I want to be a watermelon'),
    {
      p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
      auth: 'BTBZMqHH6r4Tts7J_aSIgg',
    },
    { ecdh, salt: b64u('DGv6ra1nlYgDCS1FRnbzlw') }
  );
  assert.equal(
    out.toString('base64url'),
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN'
  );
});

let cookie;
let userId;
let sent = [];
let replyStatus = 201;
const realValidate = webPush.transport.validate;
const realPost = webPush.transport.post;

test.before(async () => {
  await app.start();
  cookie = await app.adminCookie();
  userId = db.get("SELECT id FROM users WHERE role = 'admin'").id;
  app.seedServer('srv_push');
  // No network here: stand in for the push service, keeping the real host
  // rules but skipping DNS for the test host.
  webPush.transport.validate = async (endpoint) => {
    if (!String(endpoint).startsWith('https://push.example')) return realValidate(endpoint);
  };
  webPush.transport.post = async (url, init) => {
    sent.push({ url: String(url), headers: init.headers, body: init.body });
    return new Response(null, { status: replyStatus });
  };
});
test.after(async () => {
  webPush.transport.validate = realValidate;
  webPush.transport.post = realPost;
  await app.stop();
});

/** A browser-side subscription with real keys, so payloads are decryptable. */
function fakeSubscription(endpoint) {
  const ua = crypto.createECDH('prime256v1');
  ua.generateKeys();
  const auth = crypto.randomBytes(16);
  return {
    ua,
    auth,
    json: { endpoint, keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } },
  };
}

/** Decrypt an aes128gcm push body as the browser would. */
function decrypt(body, ua, auth) {
  const salt = body.subarray(0, 16);
  const idlen = body.readUInt8(20);
  const asPublic = body.subarray(21, 21 + idlen);
  const data = body.subarray(21 + idlen);
  const hkdf = (s, ikm, info, len) => {
    const prk = crypto.createHmac('sha256', s).update(ikm).digest();
    return crypto
      .createHmac('sha256', prk)
      .update(Buffer.concat([info, Buffer.from([1])]))
      .digest()
      .subarray(0, len);
  };
  const ikm = hkdf(
    auth,
    ua.computeSecret(asPublic),
    Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic]),
    32
  );
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(data.subarray(data.length - 16));
  const plain = Buffer.concat([d.update(data.subarray(0, data.length - 16)), d.final()]);
  return JSON.parse(plain.subarray(0, plain.lastIndexOf(2)).toString('utf8'));
}

test('the VAPID header is a valid ES256 token for the push service origin', () => {
  const header = webPush.vapidHeader('https://push.example/abc', 'mailto:ops@example.com');
  const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header);
  assert.ok(m, header);
  const claims = JSON.parse(b64u(m[2]).toString());
  assert.equal(claims.aud, 'https://push.example');
  assert.equal(claims.sub, 'mailto:ops@example.com');
  assert.ok(claims.exp > Date.now() / 1000);
  const pub = b64u(m[4]);
  const key = crypto.createPublicKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: pub.subarray(1, 33).toString('base64url'),
      y: pub.subarray(33).toString('base64url'),
    },
    format: 'jwk',
  });
  const ok = crypto.verify('sha256', Buffer.from(`${m[1]}.${m[2]}`), { key, dsaEncoding: 'ieee-p1363' }, b64u(m[3]));
  assert.equal(ok, true);
});

test('a device subscribes, picks alerts, gets a decryptable test, and turns off', async () => {
  const dev = fakeSubscription('https://push.example/dev1');
  const info = await app.req('GET', '/api/account/push', { cookie });
  assert.equal(info.status, 200);
  assert.equal(b64u(info.json.publicKey).length, 65);
  const sub = await app.req('POST', '/api/account/push/subscriptions', {
    cookie,
    body: { subscription: dev.json, label: 'Phone' },
  });
  assert.equal(sub.status, 201);
  assert.deepEqual(sub.json.device.categories, ['problems', 'failures', 'tasks']);
  const id = sub.json.device.id;

  const found = await app.req('GET', `/api/account/push?endpoint=${encodeURIComponent(dev.json.endpoint)}`, { cookie });
  assert.equal(found.json.device.id, id);

  const patched = await app.req('PATCH', `/api/account/push/subscriptions/${id}`, {
    cookie,
    body: { categories: ['problems', 'bogus'] },
  });
  assert.deepEqual(patched.json.device.categories, ['problems']);

  sent = [];
  const t = await app.req('POST', `/api/account/push/subscriptions/${id}/test`, { cookie });
  assert.equal(t.status, 200);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].headers['Content-Encoding'], 'aes128gcm');
  assert.match(sent[0].headers.Authorization, /^vapid t=/);
  assert.equal(decrypt(sent[0].body, dev.ua, dev.auth).title, 'Notifications are working.');

  const off = await app.req('DELETE', `/api/account/push/subscriptions/${id}`, { cookie });
  assert.equal(off.status, 200);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM push_subscriptions WHERE id = ?', id).n, 0);
});

test('a non-HTTPS or malformed subscription is refused', async () => {
  const bad = await app.req('POST', '/api/account/push/subscriptions', {
    cookie,
    body: {
      subscription: { endpoint: 'http://push.example/x', keys: { p256dh: 'x'.repeat(87), auth: 'y'.repeat(22) } },
    },
  });
  assert.equal(bad.status, 400);
  assert.doesNotMatch(bad.json.error, /zod|invalid_type/i);
});

test('an alert reaches subscribed devices that can see it, once per burst, in the chosen categories', async () => {
  push._resetThrottle();
  db.run('DELETE FROM push_subscriptions');
  const all = fakeSubscription('https://push.example/all');
  const noProblems = fakeSubscription('https://push.example/noproblems');
  push.subscribe(userId, all.json);
  const quiet = push.subscribe(userId, noProblems.json);
  push.setCategories(quiet.id, userId, ['tasks']);

  sent = [];
  await push.onEvent({ type: 'crashed', serverId: 'srv_push', summary: 'The server crashed with exit code 1.' });
  assert.equal(sent.length, 1, 'only the device that wants problems');
  const msg = decrypt(sent[0].body, all.ua, all.auth);
  assert.equal(msg.title, 'Test Server crashed.');
  assert.equal(msg.body, 'The server crashed with exit code 1.');
  assert.equal(msg.url, '/servers/srv_push');
  assert.equal(sent[0].headers.Urgency, 'high');

  // A crash loop does not buzz the phone for every event.
  sent = [];
  await push.onEvent({ type: 'crashed', serverId: 'srv_push', summary: 'Again.' });
  assert.equal(sent.length, 0);

  // Ordinary events are not alerts.
  await push.onEvent({ type: 'started', serverId: 'srv_push', summary: 'Server started.' });
  assert.equal(sent.length, 0);
});

test('a viewer never hears about a server hidden from them, nor panel-wide alerts', () => {
  const viewer = { id: 'usr_x', role: 'viewer' };
  assert.equal(push.userMaySee({ id: 'a', role: 'admin' }, { type: 'crashed', serverId: null }), true);
  assert.equal(push.userMaySee(viewer, { type: 'schedule-failed', serverId: null }), false);
});

test('a subscription its push service has forgotten is deleted', async () => {
  push._resetThrottle();
  db.run('DELETE FROM push_subscriptions');
  const gone = fakeSubscription('https://push.example/gone');
  const row = push.subscribe(userId, gone.json);
  replyStatus = 410;
  try {
    await push.onEvent({ type: 'oom', serverId: 'srv_push', summary: 'Stopped for running out of memory.' });
  } finally {
    replyStatus = 201;
  }
  assert.equal(db.get('SELECT COUNT(*) AS n FROM push_subscriptions WHERE id = ?', row.id).n, 0);
});

test('a long task tells only the user who started it; short ones stay quiet', async () => {
  db.run('DELETE FROM push_subscriptions');
  const dev = fakeSubscription('https://push.example/tasks');
  push.subscribe(userId, dev.json);
  const admin = db.get('SELECT username FROM users WHERE id = ?', userId).username;
  sent = [];
  await push.onTaskFinished({
    title: 'Backing up Alpha…',
    actor: admin,
    serverId: 'srv_push',
    ok: true,
    durationMs: 60_000,
  });
  assert.equal(sent.length, 1);
  assert.equal(decrypt(sent[0].body, dev.ua, dev.auth).title, 'Backing up Alpha finished.');
  sent = [];
  await push.onTaskFinished({ title: 'Quick…', actor: admin, serverId: null, ok: true, durationMs: 2_000 });
  await push.onTaskFinished({ title: 'Nightly…', actor: 'scheduler', serverId: null, ok: false, durationMs: 60_000 });
  assert.equal(sent.length, 0);
});

test('endpoints off the browser push services, or on private addresses, are refused', async () => {
  for (const endpoint of [
    'https://10.0.0.5:8443/push',
    'https://127.0.0.1/push',
    'https://localhost/push',
    'https://evil.example/push',
    'https://fcm.googleapis.com.evil.example/push',
  ]) {
    const r = await app.req('POST', '/api/account/push/subscriptions', {
      cookie,
      body: { subscription: fakeSubscription(endpoint).json },
    });
    assert.equal(r.status, 400, endpoint);
  }
  assert.ok(webPush.isPushHost('fcm.googleapis.com'));
  assert.ok(webPush.isPushHost('updates.push.services.mozilla.com'));
  assert.ok(webPush.isPushHost('web.push.apple.com'));
  assert.ok(webPush.isPushHost('wns2-by3p.notify.windows.com'));
  assert.ok(!webPush.isPushHost('notfcm.googleapis.com.example'));
});

test('sendPush refuses a stored endpoint that is not a public push service', async () => {
  const { json } = fakeSubscription('https://192.168.1.10/push');
  await assert.rejects(realValidate(json.endpoint), (err) => err.status === 400);
  // The real send path runs the same check before any request goes out.
  const before = sent.length;
  const saved = webPush.transport.validate;
  webPush.transport.validate = realValidate;
  try {
    await assert.rejects(webPush.sendPush({ endpoint: json.endpoint, ...json.keys }, { title: 'x' }));
  } finally {
    webPush.transport.validate = saved;
  }
  assert.equal(sent.length, before);
});
