'use strict';

// Process lifecycle: HTTP server timeouts, the post-boot fault policy, and a
// graceful shutdown on SIGTERM / SIGINT. Kept apart from server.js so each
// piece can be tested without booting the whole panel.

const path = require('node:path');
const logger = require('./logger')(path.basename(__filename));
const { captureError, closeSentry } = require('./instrument');
const { serializeError } = require('./utils/logSanitize');

const truthy = (v) => /^(1|true|yes)$/i.test(String(v || '').trim());

function bailOut(code = 1) {
  closeSentry().finally(() => process.exit(code));
}

/**
 * Node's default 300 s cap on a whole request would cut off any upload slower
 * than that (4 GB at 20 Mbps takes half an hour). Uploads are bounded by size
 * and disk quota instead; the slow-header guard stays.
 * @param {import('node:http').Server} server
 */
function configureHttpServer(server) {
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  return server;
}

/**
 * What a post-boot fault does. An uncaught exception leaves the process in an
 * unknown state (a half-finished transaction, a held lock, a leaked stream),
 * so it exits by default and the supervisor (Docker restart:, systemd) brings
 * the panel back clean; MSM_KEEP_ALIVE_ON_FATAL=1 keeps it running instead.
 * An unhandled rejection is logged and the panel stays up, unless
 * MSM_EXIT_ON_FATAL=1 asks for an exit on those too.
 * @param {NodeJS.ProcessEnv} [env]
 */
function faultPolicy(env = process.env) {
  return {
    exitOnException: !truthy(env.MSM_KEEP_ALIVE_ON_FATAL),
    exitOnRejection: truthy(env.MSM_EXIT_ON_FATAL),
  };
}

/**
 * Installed only after a successful boot, so startup errors stay fatal and
 * visible instead of being caught here.
 * @param {{ env?: NodeJS.ProcessEnv, exit?: (code: number) => void }} [opts]
 */
function installRuntimeGuards({ env = process.env, exit = bailOut } = {}) {
  const policy = faultPolicy(env);
  const report = (kind, err, exiting) => {
    const info = serializeError(err);
    if (exiting)
      logger.fatal('Caught an uncaught fault, so the panel is exiting to restart clean.', { kind, err: info });
    else logger.error('Caught a runtime fault and kept the panel running.', { kind, err: info });
    captureError(err, { scope: 'runtime-guard', kind });
    // A panel event, so it surfaces in Activity (and Discord alerts, if wired)
    // rather than only in stdout.
    try {
      require('./events').recordEvent({
        type: 'panel-error',
        actor: 'system',
        summary: `Uncaught ${kind}: ${info.errorMessage}.`.slice(0, 300),
        details: info,
      });
    } catch {
      /* the DB may be exactly what broke - never let reporting throw */
    }
    if (exiting) exit(1);
  };
  process.on('uncaughtException', (err) => report('exception', err, policy.exitOnException));
  process.on('unhandledRejection', (reason) => report('rejection', reason, policy.exitOnRejection));
  return policy;
}

/**
 * Stop cleanly on SIGTERM / SIGINT (docker stop, Ctrl+C): stop taking
 * requests, close WebSocket clients so the server can finish closing, let
 * in-flight requests end, then checkpoint the SQLite WAL into panel.db and
 * close it. Past `graceMs` the remaining connections are cut and the process
 * exits 1. A second signal exits at once.
 * @param {{ httpServer: import('node:http').Server, getWss?: () => any, graceMs?: number, exit?: (code: number) => void }} opts
 */
function installShutdown({ httpServer, getWss = () => null, graceMs = 8000, exit = bailOut }) {
  let stopping = false;
  const closeDb = () => {
    try {
      const db = require('./db');
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      db.close();
    } catch (err) {
      logger.warn('Closing the database during shutdown failed.', { err: serializeError(err) });
    }
  };
  const shutdown = (signal) => {
    if (stopping) {
      logger.warn('Got a second stop signal, so the panel is exiting now.', { signal });
      exit(1);
      return;
    }
    stopping = true;
    logger.info('Shutting the panel down.', { signal, graceMs });
    const timer = setTimeout(() => {
      logger.warn('Requests were still open when the shutdown grace period ended, so they were cut.', { graceMs });
      httpServer.closeAllConnections();
      closeDb();
      exit(1);
    }, graceMs);
    timer.unref();
    const wss = getWss();
    if (wss) {
      for (const client of wss.clients) {
        try {
          client.close(1001, 'Panel restarting');
        } catch {
          client.terminate();
        }
      }
      // A client that does not finish the close handshake is cut shortly after.
      setTimeout(() => {
        for (const client of wss.clients) client.terminate();
      }, 1000).unref();
    }
    httpServer.close(() => {
      clearTimeout(timer);
      closeDb();
      logger.info('The panel stopped cleanly.', { signal });
      exit(0);
    });
    httpServer.closeIdleConnections();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  return shutdown;
}

module.exports = { bailOut, configureHttpServer, faultPolicy, installRuntimeGuards, installShutdown };
