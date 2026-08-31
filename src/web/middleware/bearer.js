'use strict';

// Shared Bearer-token helpers. A leaf module (no app imports) so both
// apiToken.js and rateLimit.js can use it without a require cycle.

const crypto = require('node:crypto');

const BEARER_RE = /^Bearer\s+(.+)$/i;

/**
 * Extract the raw token from an `Authorization: Bearer <token>` header.
 * @param {import('express').Request} req
 * @returns {string | null}
 */
function bearerToken(req) {
  const m = BEARER_RE.exec(String(req.get('authorization') || '').trim());
  return m ? m[1].trim() : null;
}

/**
 * express-rate-limit keyGenerator: a per-credential bucket keyed on the SHA-256
 * of the presented token (the raw token never enters the limiter store), or
 * null so the limiter falls back to its IP default.
 * @param {import('express').Request} req
 * @returns {string | null}
 */
function tokenRateKey(req) {
  const raw = bearerToken(req);
  return raw ? 'tok:' + crypto.createHash('sha256').update(raw).digest('hex') : null;
}

module.exports = { BEARER_RE, bearerToken, tokenRateKey };
