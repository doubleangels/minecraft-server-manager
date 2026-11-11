'use strict';

// Push notifications: which history events reach whose devices. Every
// notable action already flows through recordEvent(), which hands it here;
// background tasks report their own finish. Each device (push subscription)
// picks categories:
//   problems  a server crashed, crash-looped, ran out of memory, gave up
//             restarting, stalled or went unhealthy at startup, hit its strict
//             quota, or would not stop
//   failures  a damaged backup, a failed scheduled task, a failed or rolled
//             back update
//   tasks     a background task the device's user started has finished
// A user only hears about servers they can see, never event types hidden from
// them, and panel-wide events only if they are an admin.

const path = require('node:path');
const { nanoid } = require('nanoid');
const db = require('../db');
const webPush = require('./webPush');
const logger = require('../logger')(path.basename(__filename));

const CATEGORIES = ['problems', 'failures', 'tasks'];

/** Event type -> [category, short headline]. */
const EVENT_ALERTS = {
  crashed: ['problems', 'crashed'],
  'crash-loop': ['problems', 'keeps crashing'],
  oom: ['problems', 'ran out of memory'],
  'auto-restart-gave-up': ['problems', 'stopped restarting itself'],
  'startup-stalled': ['problems', 'is stuck starting'],
  unhealthy: ['problems', 'stopped answering'],
  'offline-after-restart': ['problems', 'did not come back after a restart'],
  'quota-exceeded': ['problems', 'was stopped for its disk quota'],
  'stop-failed': ['problems', 'would not stop'],
  'port-change-failed': ['problems', 'could not move to its new port'],
  'backup-verify-failed': ['failures', 'has a damaged backup'],
  'schedule-failed': ['failures', 'had a scheduled task fail'],
  'update-failed': ['failures', 'failed to update'],
  'auto-update-failed': ['failures', 'failed to update automatically'],
  'update-rolled-back': ['failures', 'was rolled back after an update'],
};

// The same alert for the same server on the same device at most this often
// (a crash loop records event after event).
const REPEAT_MS = 2 * 60_000;
const lastSent = new Map(); // `${subId}:${type}:${serverId}` -> ms
// Tasks shorter than this finish while you watch; no need to buzz a phone.
const TASK_MIN_MS = 15_000;

function parseCategories(json) {
  try {
    const list = JSON.parse(json);
    return Array.isArray(list) ? list.filter((c) => CATEGORIES.includes(c)) : CATEGORIES.slice();
  } catch {
    return CATEGORIES.slice();
  }
}

// ---- Subscriptions ----

/**
 * Save (or move to this user) a browser's push subscription.
 * @param {string} userId
 * @param {{endpoint: string, keys: {p256dh: string, auth: string}}} sub
 * @param {{label?: string}} [opts]
 */
function subscribe(userId, sub, { label = '' } = {}) {
  const existing = db.get('SELECT id FROM push_subscriptions WHERE endpoint = ?', sub.endpoint);
  if (existing) {
    db.run(
      'UPDATE push_subscriptions SET user_id = ?, p256dh = ?, auth = ?, device_label = ? WHERE id = ?',
      userId,
      sub.keys.p256dh,
      sub.keys.auth,
      label,
      existing.id
    );
    return getForUser(existing.id, userId);
  }
  const id = `push_${nanoid(10)}`;
  db.run(
    'INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, device_label) VALUES (?, ?, ?, ?, ?, ?)',
    id,
    userId,
    sub.endpoint,
    sub.keys.p256dh,
    sub.keys.auth,
    label
  );
  logger.info('A device subscribed to push notifications.', { userId, subscriptionId: id });
  return getForUser(id, userId);
}

function shape(row) {
  return (
    row && {
      id: row.id,
      label: row.device_label,
      categories: parseCategories(row.categories_json),
      createdAt: row.created_at,
    }
  );
}

function getForUser(id, userId) {
  return shape(db.get('SELECT * FROM push_subscriptions WHERE id = ? AND user_id = ?', id, userId));
}

function findByEndpoint(endpoint, userId) {
  return shape(db.get('SELECT * FROM push_subscriptions WHERE endpoint = ? AND user_id = ?', endpoint, userId));
}

function setCategories(id, userId, categories) {
  const clean = [...new Set(categories)].filter((c) => CATEGORIES.includes(c));
  db.run(
    'UPDATE push_subscriptions SET categories_json = ? WHERE id = ? AND user_id = ?',
    JSON.stringify(clean),
    id,
    userId
  );
  return getForUser(id, userId);
}

function unsubscribe(id, userId) {
  const { changes } = db.run('DELETE FROM push_subscriptions WHERE id = ? AND user_id = ?', id, userId);
  if (changes) logger.info('A device turned push notifications off.', { userId, subscriptionId: id });
  return changes > 0;
}

// ---- Sending ----

/**
 * @param {{id: string, endpoint: string, p256dh: string, auth: string}} row
 * @param {object} message
 * @param {{urgency?: 'very-low'|'low'|'normal'|'high', topic?: string}} [opts]
 */
async function deliver(row, message, { urgency = 'normal', topic = undefined } = {}) {
  try {
    const res = await webPush.sendPush(row, message, { urgency, topic });
    if (res.gone) {
      db.run('DELETE FROM push_subscriptions WHERE id = ?', row.id);
      logger.info('Removed a push subscription its push service no longer knows.', {
        subscriptionId: row.id,
        status: res.status,
      });
    } else if (!res.ok) {
      logger.warn('A push service refused a notification.', { subscriptionId: row.id, status: res.status });
    } else {
      db.run("UPDATE push_subscriptions SET last_sent_at = datetime('now') WHERE id = ?", row.id);
    }
    return res;
  } catch (err) {
    logger.warn('Sending a push notification failed.', { subscriptionId: row.id, err: err.message });
    return { ok: false, status: 0, gone: false };
  }
}

/** Can this user see this event in history? Mirrors the Activity page's rules. */
function userMaySee(user, event) {
  if (user.role === 'admin') return true;
  if (!event.serverId) return false; // panel-wide alerts are for admins
  const permissions = require('./permissions');
  if (!permissions.visibleServerIds(user).has(event.serverId)) return false;
  return !permissions.hiddenEventTypes(user).includes(event.type);
}

/**
 * recordEvent() calls this for every event; only alert types do anything.
 * @param {{eventId?: number, type: string, serverId: string|null, summary: string}} event
 */
async function onEvent(event) {
  const alert = EVENT_ALERTS[event.type];
  if (!alert) return;
  const [category, headline] = alert;
  const rows = db.all(`SELECT p.*, u.role, u.username FROM push_subscriptions p JOIN users u ON u.id = p.user_id`);
  if (!rows.length) return;
  const server = event.serverId ? db.get('SELECT display_name FROM servers WHERE id = ?', event.serverId) : null;
  const name = server ? server.display_name : 'The panel';
  const message = {
    title: `${name} ${headline}.`,
    body: event.summary,
    url: event.serverId ? `/servers/${event.serverId}` : '/activity',
    tag: `${event.type}:${event.serverId || 'panel'}`,
    category,
  };
  const now = Date.now();
  const sends = [];
  for (const row of rows) {
    if (!parseCategories(row.categories_json).includes(category)) continue;
    if (!userMaySee({ id: row.user_id, role: row.role }, event)) continue;
    const key = `${row.id}:${event.type}:${event.serverId}`;
    if (now - (lastSent.get(key) || 0) < REPEAT_MS) continue;
    lastSent.set(key, now);
    /** @type {'high' | 'normal'} */
    const urgency = category === 'problems' ? 'high' : 'normal';
    sends.push(deliver(row, message, { urgency, topic: message.tag }));
  }
  if (sends.length) {
    await Promise.allSettled(sends);
    logger.debug('Sent push notifications for an event.', {
      type: event.type,
      serverId: event.serverId,
      devices: sends.length,
    });
  }
}

/**
 * A background task finished: tell the user who started it, if it ran long
 * enough that they have likely looked away.
 * @param {{title: string, actor: string, serverId: string|null, ok: boolean, error?: string|null, durationMs: number}} task
 */
async function onTaskFinished(task) {
  if (!task.actor || task.durationMs < TASK_MIN_MS) return;
  const user = db.get('SELECT id FROM users WHERE username = ?', task.actor);
  if (!user) return; // 'system', 'scheduler': failures there are 'failures' events
  const rows = db
    .all('SELECT * FROM push_subscriptions WHERE user_id = ?', user.id)
    .filter((r) => parseCategories(r.categories_json).includes('tasks'));
  if (!rows.length) return;
  const name = String(task.title || 'A task').replace(/…$/, '');
  const message = {
    title: task.ok ? `${name} finished.` : `${name} failed.`,
    body: task.ok ? '' : task.error || '',
    url: task.serverId ? `/servers/${task.serverId}` : '/',
    tag: `task:${task.title}`,
    category: 'tasks',
  };
  await Promise.allSettled(rows.map((r) => deliver(r, message)));
}

/** "Send a Test Notification" for one of the user's devices. */
async function sendTest(id, userId) {
  const row = db.get('SELECT * FROM push_subscriptions WHERE id = ? AND user_id = ?', id, userId);
  if (!row) return null;
  return deliver(row, {
    title: 'Notifications are working.',
    body: 'This device will hear about the kinds of alerts you picked.',
    url: '/',
    tag: 'test',
    category: 'test',
  });
}

/** Tests: forget the repeat throttle. */
function _resetThrottle() {
  lastSent.clear();
}

module.exports = {
  CATEGORIES,
  EVENT_ALERTS,
  subscribe,
  findByEndpoint,
  getForUser,
  setCategories,
  unsubscribe,
  onEvent,
  onTaskFinished,
  sendTest,
  userMaySee,
  _resetThrottle,
};
