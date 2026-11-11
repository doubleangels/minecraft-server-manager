'use strict';

// Short-lived capability tokens for the live map. The map is served from a
// sandboxed iframe with an opaque origin, so it carries no session cookie:
// the Map tab mints a token for (server, user) after its own `view` check, and
// the proxy accepts that token alone. The proxy re-checks that the user still
// exists and can still view the server on every request, so revoking access
// takes effect at once; the expiry only bounds how long a leaked URL works.

const crypto = require('node:crypto');
const config = require('../config');

const TTL_MS = 12 * 3600 * 1000;

let key = null;
function signingKey() {
  if (!key) key = crypto.createHmac('sha256', config.sessionSecret).update('msm-map-token-v1').digest();
  return key;
}

function sign(serverId, userId, exp) {
  return crypto.createHmac('sha256', signingKey()).update(`${serverId}\n${userId}\n${exp}`).digest('base64url');
}

/**
 * @param {string} serverId
 * @param {string} userId
 * @param {number} [now]
 * @returns {string}
 */
function mint(serverId, userId, now = Date.now()) {
  const exp = Math.floor((now + TTL_MS) / 1000);
  return `${Buffer.from(String(userId)).toString('base64url')}.${exp}.${sign(serverId, userId, exp)}`;
}

/**
 * The user id a token was minted for, or null when it is malformed, expired,
 * or minted for another server.
 * @param {string} token
 * @param {string} serverId
 * @param {number} [now]
 * @returns {string|null}
 */
function verify(token, serverId, now = Date.now()) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const [u, expText, sig] = parts;
  const exp = Number(expText);
  if (!Number.isInteger(exp) || exp * 1000 < now) return null;
  const userId = Buffer.from(u, 'base64url').toString();
  if (!userId) return null;
  const want = Buffer.from(sign(serverId, userId, exp));
  const got = Buffer.from(sig);
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  return userId;
}

module.exports = { mint, verify, TTL_MS };
