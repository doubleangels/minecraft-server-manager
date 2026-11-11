'use strict';

// Host header allowlist, against DNS rebinding. A page on evil.example can
// make its name resolve to 127.0.0.1 and then talk to the panel as "same
// origin", because the Origin and Host headers then match. Session cookies
// are safe (they belong to the real host name), so what is at risk is what
// needs no sign-in: first-run setup on a loopback bind, where no setup PIN is
// asked. So unknown host names get 421:
//   - while the admin account does not exist yet and setup is not PIN-gated
//   - always, once PANEL_ALLOWED_HOSTS is set (strict mode; `*` turns the
//     check off entirely)
// Always allowed: IP literals (rebinding needs a host name), localhost and
// *.localhost, and the public host set in Panel Settings.

const net = require('node:net');
const path = require('node:path');
const config = require('../../config');
const logger = require('../../logger')(path.basename(__filename));

/** Host name from a Host header value, lowercased, without port or brackets. */
function hostName(raw) {
  const v = String(raw || '')
    .trim()
    .toLowerCase();
  if (!v) return '';
  if (v.startsWith('[')) return v.slice(1, v.indexOf(']') > 0 ? v.indexOf(']') : undefined);
  const colon = v.lastIndexOf(':');
  // A bare IPv6 address has several colons and no port.
  if (colon > 0 && v.indexOf(':') === colon) return v.slice(0, colon);
  return v;
}

function configuredHosts() {
  const list = (process.env.PANEL_ALLOWED_HOSTS || '')
    .split(',')
    .map((h) => hostName(h))
    .filter(Boolean);
  return list;
}

/**
 * @param {string} raw Host header
 * @param {{ allowed?: string[], publicHost?: string }} [opts]
 */
function isKnownHost(raw, { allowed = configuredHosts(), publicHost } = {}) {
  const h = hostName(raw);
  if (!h) return false;
  if (allowed.includes('*')) return true;
  if (net.isIP(h)) return true;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (allowed.includes(h)) return true;
  const pub = hostName(publicHost !== undefined ? publicHost : require('../../services/settings').getPublicHost());
  return Boolean(pub) && pub === h;
}

let setupDone = false;
/** Must unknown hosts be refused right now? */
function strictNow() {
  if (configuredHosts().length) return true;
  if (setupDone) return false;
  if (!require('../../services/auth').firstRunNeeded()) {
    setupDone = true;
    return false;
  }
  // An exposed bind asks for the setup PIN, which a rebinding page cannot know.
  return !config.isExposedBind;
}

/** The Host a request claims, honouring X-Forwarded-Host only behind a trusted proxy. */
function requestHost(req) {
  if (config.trustProxy !== false) {
    const fwd = req.headers['x-forwarded-host'];
    if (typeof fwd === 'string' && fwd) return fwd.split(',')[0];
  }
  return req.headers.host || '';
}

/** Should this request (or WebSocket upgrade) be refused for its Host? */
function refuseHost(req) {
  const host = requestHost(req);
  if (isKnownHost(host)) return false;
  return strictNow();
}

const MESSAGE =
  'This panel does not answer to that address. Open it at localhost or its IP address, or add the name to PANEL_ALLOWED_HOSTS.';

function hostGuard(req, res, next) {
  if (!refuseHost(req)) return next();
  logger.warn('Refused a request for an unknown host name.', { host: hostName(requestHost(req)), path: req.path });
  res.status(421).type('text/plain').send(MESSAGE);
}

module.exports = { hostGuard, refuseHost, isKnownHost, hostName, _reset: () => (setupDone = false) };
