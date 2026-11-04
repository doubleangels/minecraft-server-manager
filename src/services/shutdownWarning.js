'use strict';

// Warn the players in game before a restart or stop: "Restarting in 5
// minutes…" in chat at sensible intervals, then the action itself. Used by the
// power routes (when a person asks for a warning) and by scheduled restarts
// and stops (a per-schedule setting).
//
// No one online, or the server not running: nothing to warn, so it returns at
// once. One countdown per server at a time.

const path = require('node:path');
const httpError = require('../utils/httpError');
const logger = require('../logger')(path.basename(__filename));
const { serializeError } = require('../utils/logSanitize');

/** Choices offered in the UI and accepted by the API, in seconds. */
const WARN_CHOICES = [0, 30, 60, 120, 300, 600, 900];
const MAX_WARN_SECONDS = 900;

// The remaining-time marks a message goes out at (plus the very start).
const MARKS = [600, 300, 120, 60, 30, 10, 5, 4, 3, 2, 1];
const LIVE = new Set(['running', 'unhealthy', 'starting', 'stalled']);

/** @type {Set<string>} */
const active = new Set();

/** "5 minutes", "1 minute", "30 seconds", "1 second". */
function spell(seconds) {
  if (seconds >= 60 && seconds % 60 === 0) {
    const m = seconds / 60;
    return `${m} ${m === 1 ? 'minute' : 'minutes'}`;
  }
  return `${seconds} ${seconds === 1 ? 'second' : 'seconds'}`;
}

/** The seconds-remaining points a countdown of `total` announces at. */
function marksFor(total) {
  return [total, ...MARKS.filter((m) => m < total)];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms).unref());

/**
 * @param {string} serverId
 * @param {{ action: 'restart'|'stop', seconds: number, task?: any, sleepFn?: (ms: number) => Promise<void> }} opts
 * @returns {Promise<{ warned: boolean, cancelled?: boolean, reason?: string }>}
 */
async function warnBeforeShutdown(serverId, { action, seconds, task = null, sleepFn = sleep }) {
  const total = Math.min(MAX_WARN_SECONDS, Math.max(0, Math.floor(Number(seconds) || 0)));
  if (!total) return { warned: false, reason: 'none' };
  const servers = require('./servers'); // lazy: servers.js requires the routes' services
  const server = servers.getServer(serverId);
  if (!server || !LIVE.has(server.status)) return { warned: false, reason: 'not-running' };
  const live = require('./liveCache').get(serverId);
  if (live.players && Number(live.players.online) === 0) return { warned: false, reason: 'empty' };
  if (active.has(serverId)) throw httpError(409, 'Players are already being warned about a restart or stop.');

  const { execCapture } = require('../docker/containers');
  const verb = action === 'stop' ? 'Stopping' : 'Restarting';
  const tail = action === 'stop' ? 'Please log off safely.' : 'Find a safe spot. You can rejoin shortly.';
  active.add(serverId);
  logger.info('Started a shutdown warning countdown.', { serverId, action, seconds: total });
  try {
    const marks = marksFor(total);
    for (let i = 0; i < marks.length; i++) {
      const left = marks[i];
      // A person stopped (or the server crashed) meanwhile: nothing left to warn.
      const now = servers.getServer(serverId);
      if (!now || !LIVE.has(now.status)) return { warned: true, cancelled: true, reason: 'stopped-meanwhile' };
      const text = left > 10 ? `${verb} the server in ${spell(left)}. ${tail}` : `${verb} in ${left}…`;
      await execCapture(serverId, ['rcon-cli', '--', 'say', text]).catch((err) => {
        logger.warn('A shutdown warning could not be sent to the players.', {
          serverId,
          err: serializeError(err, { includeStack: false }),
        });
      });
      if (task) task.step(`${verb} in ${spell(left)}, warning players…`);
      const next = marks[i + 1] ?? 0;
      await sleepFn((left - next) * 1000);
    }
    return { warned: true };
  } finally {
    active.delete(serverId);
  }
}

module.exports = { warnBeforeShutdown, marksFor, spell, WARN_CHOICES, MAX_WARN_SECONDS };
