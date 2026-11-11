'use strict';

// Web Push, the standard way to reach an installed web app (or a browser tab)
// when it is closed: the panel encrypts a message for one device and posts it
// to that device's push service (Google, Mozilla, Apple), which delivers it.
// Built on node:crypto only:
//   - VAPID (RFC 8292): the panel signs each request with its own P-256 key,
//     so push services know who is sending; generated once and kept in the
//     data folder (.push-key.json, mode 0600), like the at-rest secret key.
//   - Message encryption (RFC 8291, aes128gcm): only the subscribed device
//     can read the payload, not the push service.
// Delivery is best-effort, as the push services make it.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { dataPath } = require('../storage/pathGuard');
const { safeFetch, assertPublicUrl } = require('../utils/urlGuard');
const httpError = require('../utils/httpError');
const logger = require('../logger')(path.basename(__filename));

const KEY_FILE = '.push-key.json';

// Browsers only ever hand out endpoints on their vendor's push service. The
// panel POSTs to whatever endpoint a signed-in user registers, so anything
// else (an internal host, say) is refused. PUSH_EXTRA_HOSTS adds hosts for an
// unusual browser: a comma-separated list, each matching itself and its
// subdomains.
const PUSH_HOST_SUFFIXES = [
  'fcm.googleapis.com', // Chrome, Edge (Android), Brave, Opera, Samsung Internet
  'push.services.mozilla.com', // Firefox
  'push.apple.com', // Safari
  'notify.windows.com', // Edge (Windows)
];

function allowedHostSuffixes() {
  const extra = (process.env.PUSH_EXTRA_HOSTS || '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return [...PUSH_HOST_SUFFIXES, ...extra];
}

/** Is this host a known push service (or a subdomain of one)? */
function isPushHost(host) {
  const h = String(host || '').toLowerCase();
  return allowedHostSuffixes().some((s) => h === s || h.endsWith(`.${s}`));
}

/**
 * Throw a 400 unless `endpoint` is an https URL on a known push service that
 * resolves to public addresses only.
 * @param {string} endpoint
 */
async function validateEndpoint(endpoint) {
  let u;
  try {
    u = new URL(endpoint);
  } catch {
    throw httpError(400, 'That push subscription has an invalid address.');
  }
  if (u.protocol !== 'https:' || !isPushHost(u.hostname)) {
    throw httpError(400, 'That push subscription is not on a known browser push service.');
  }
  try {
    await assertPublicUrl(u.toString());
  } catch {
    throw httpError(400, 'That push subscription points at an address the panel will not contact.');
  }
}

/**
 * The network side, swappable by tests. Sends through safeFetch: the address
 * is re-checked and pinned at send time, and push services never redirect.
 */
const transport = {
  validate: validateEndpoint,
  post: (url, init) => safeFetch(url, { ...init, maxRedirects: 0 }),
};
const RECORD_SIZE = 4096;

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (s) => Buffer.from(String(s), 'base64url');

let keys = null;

/** The panel's VAPID key pair, created on first use. */
function vapidKeys() {
  if (keys) return keys;
  const file = dataPath(KEY_FILE);
  let stored = null;
  try {
    stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    /* first run, or unreadable: make a new pair below */
  }
  if (!stored || !stored.privateKey || !stored.publicKey) {
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.generateKeys();
    stored = { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(ecdh.getPrivateKey()) };
    fs.writeFileSync(file, JSON.stringify(stored), { mode: 0o600 });
    logger.info('Created the push notification signing key.', { file: KEY_FILE });
  }
  const pub = fromB64u(stored.publicKey);
  const priv = fromB64u(stored.privateKey);
  // A KeyObject for signing, from the raw key: JWK wants x, y and d.
  const keyObject = crypto.createPrivateKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: b64u(pub.subarray(1, 33)),
      y: b64u(pub.subarray(33, 65)),
      d: b64u(priv),
    },
    format: 'jwk',
  });
  keys = { publicKey: stored.publicKey, keyObject };
  return keys;
}

/** The public key a browser needs to subscribe (applicationServerKey). */
function publicKey() {
  return vapidKeys().publicKey;
}

/** A VAPID Authorization header for one push service origin. */
function vapidHeader(endpoint, contact) {
  const { keyObject, publicKey: pub } = vapidKeys();
  const aud = new URL(endpoint).origin;
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: contact }));
  const unsigned = `${header}.${claims}`;
  const sig = crypto.sign('sha256', Buffer.from(unsigned), { key: keyObject, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${unsigned}.${b64u(sig)}, k=${pub}`;
}

function hkdf(salt, ikm, info, length) {
  const prk = crypto.createHmac('sha256', salt).update(ikm).digest();
  return crypto
    .createHmac('sha256', prk)
    .update(Buffer.concat([info, Buffer.from([1])]))
    .digest()
    .subarray(0, length);
}

/**
 * Encrypt a payload for one subscription (RFC 8291 / RFC 8188 aes128gcm).
 * @param {Buffer} plaintext
 * @param {{p256dh: string, auth: string}} sub the browser's keys
 * @param {{salt?: Buffer, ecdh?: crypto.ECDH}} [testing] fixed values for tests
 */
function encrypt(plaintext, sub, testing = {}) {
  const uaPublic = fromB64u(sub.p256dh);
  const authSecret = fromB64u(sub.auth);
  const ecdh = testing.ecdh || crypto.createECDH('prime256v1');
  if (!testing.ecdh) ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = hkdf(authSecret, shared, keyInfo, 32);
  const salt = testing.salt || crypto.randomBytes(16);
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  // One record: the payload, then the 0x02 delimiter that marks the last one.
  const body = Buffer.concat([
    cipher.update(Buffer.concat([plaintext, Buffer.from([2])])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, body]);
}

/**
 * Send one message to one subscription.
 * @param {{endpoint: string, p256dh: string, auth: string}} sub
 * @param {object} message JSON the service worker receives
 * @param {{ttl?: number, urgency?: 'very-low'|'low'|'normal'|'high', contact?: string, topic?: string}} [opts]
 * @returns {Promise<{ok: boolean, status: number, gone: boolean}>} gone: the
 *   subscription no longer exists (404/410) and should be deleted.
 */
async function sendPush(sub, message, { ttl = 24 * 3600, urgency = 'normal', contact, topic } = {}) {
  const body = encrypt(Buffer.from(JSON.stringify(message)), sub);
  const headers = {
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    TTL: String(ttl),
    Urgency: urgency,
    Authorization: vapidHeader(sub.endpoint, contact || defaultContact()),
  };
  // A Topic collapses an undelivered message with a newer one of the same kind.
  if (topic) headers.Topic = topic.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
  // A stored endpoint is checked again: it may predate these rules, or its
  // name may resolve somewhere else now.
  await transport.validate(sub.endpoint);
  headers['Content-Length'] = String(body.length);
  const res = await transport.post(sub.endpoint, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(10_000),
  });
  // Nothing in a push service's reply is needed; free the connection.
  if (res.body && typeof res.body.cancel === 'function') res.body.cancel().catch(() => {});
  return { ok: res.ok, status: res.status, gone: res.status === 404 || res.status === 410 };
}

/** Who push services may contact about this sender: PUSH_CONTACT, else the project page. */
function defaultContact() {
  const fromEnv = (process.env.PUSH_CONTACT || '').trim();
  if (/^(mailto:|https:\/\/)/.test(fromEnv)) return fromEnv;
  return 'https://github.com/anefzaoui/minecraft-server-manager';
}

/** Tests: forget the cached key pair (after pointing DATA_DIR elsewhere). */
function _resetKeys() {
  keys = null;
}

module.exports = {
  publicKey,
  sendPush,
  encrypt,
  vapidHeader,
  vapidKeys,
  validateEndpoint,
  isPushHost,
  transport,
  _resetKeys,
};
