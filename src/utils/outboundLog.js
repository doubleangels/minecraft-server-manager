'use strict';

// Logs every outbound HTTP call the panel makes (Modrinth, CurseForge, Mojang,
// GitHub, Discord webhooks, the chatbot's model server…) by wrapping the global
// fetch once at boot. Lines carry method, host, path, status and duration. The
// query string and URL credentials are dropped, and webhook paths (which hold
// the secret) are masked. Request and response headers and bodies are never
// logged, so API keys sent in headers stay out of the log.
//
// Levels: a GET that got an answer is debug (update checks and icon lookups run
// in the background all the time); a write (POST, PUT…) is info; a call that
// failed or got a 5xx is info too. The caller owns any warn/error line about
// what the failure meant.

const logger = require('../logger')('outbound');
const { stripUrlQuery } = require('./logSanitize');

let installed = false;

function describe(input, init) {
  const method = String(
    (init && init.method) || (input && typeof input === 'object' && input.method) || 'GET'
  ).toUpperCase();
  const raw =
    typeof input === 'string'
      ? input
      : input && typeof input === 'object' && 'url' in input
        ? input.url
        : String(input);
  let host;
  let urlPath;
  try {
    const u = new URL(stripUrlQuery(raw));
    host = u.host;
    urlPath = u.pathname;
  } catch {
    urlPath = stripUrlQuery(String(raw)).slice(0, 200);
  }
  return { method, host, path: urlPath };
}

function installOutboundLog() {
  if (installed || typeof globalThis.fetch !== 'function') return;
  installed = true;
  const nativeFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async function loggedFetch(input, init) {
    const what = describe(input, init);
    const t0 = Date.now();
    try {
      const res = await nativeFetch(input, init);
      const meta = { ...what, status: res.status, durationMs: Date.now() - t0 };
      if (res.status >= 500) logger.info('An outbound request got a server error.', meta);
      else if (what.method === 'GET' || what.method === 'HEAD') logger.debug('Made an outbound request.', meta);
      else logger.info('Made an outbound request.', meta);
      return res;
    } catch (err) {
      logger.info('An outbound request failed.', {
        ...what,
        durationMs: Date.now() - t0,
        err: err && err.name === 'AbortError' ? 'aborted or timed out' : err && err.message,
      });
      throw err;
    }
  };
}

module.exports = { installOutboundLog };
