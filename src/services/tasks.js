'use strict';

// Long-operation tracking: every slow job (pack install/upgrade, image pull,
// downloads, backups, world ops, blueprint import) runs as a registered task
// the UI polls for real progress - no more fake pulse bars.

const path = require('node:path');
const { nanoid } = require('nanoid');
const logger = require('../logger')(path.basename(__filename));
const { serializeError, summarizeBody } = require('../utils/logSanitize');

const tasks = new Map(); // id -> task
const TTL_MS = 10 * 60 * 1000; // finished tasks linger for late polls

/**
 * createTask('Installing pack …', {serverId}) → task handle:
 *   t.step('Downloading mods')          - set the current step label
 *   t.progress(received, total)         - numeric progress for the active step
 *   t.log('…')                          - append a detail line (kept last 50)
 *   t.done(result) / t.fail(error)      - finish
 * run(title, opts, fn) wraps a promise-returning fn with automatic done/fail.
 * track(title, opts, fn) does the same but returns fn's result to an awaiting caller.
 */
/** A long task its user started has ended: their devices may want to know. */
function notifyFinished(task, ok, error = null) {
  setImmediate(() => {
    require('./pushNotify')
      .onTaskFinished({
        title: task.title,
        actor: task.actor,
        serverId: task.serverId,
        ok,
        error: error && error.message ? error.message : error ? String(error) : null,
        durationMs: Date.now() - task.startedAt,
      })
      .catch((err) => logger.warn('Pushing a task result to devices failed.', { taskId: task.id, err: err.message }));
  });
}

function createTask(title, { serverId = null, actor = 'system' } = {}) {
  const id = `task_${nanoid(10)}`;
  const task = {
    id,
    title,
    serverId,
    actor,
    state: 'running', // running | done | failed
    stepLabel: 'Starting…',
    current: 0,
    total: 0,
    logs: [],
    result: null,
    error: null,
    startedAt: Date.now(),
    finishedAt: null,
  };
  tasks.set(id, task);
  // Every task's life is in the container log: start, each step, each detail
  // line (debug), and how it ended. This is the one place that logs it, so
  // run(), track() and direct createTask() callers all get the same lines.
  logger.info('Started a background task.', { taskId: id, title, serverId: serverId || undefined, actor });
  const durationMs = () => Date.now() - task.startedAt;

  const handle = {
    id,
    step(label) {
      if (label !== task.stepLabel) {
        logger.info('A background task moved to its next step.', {
          taskId: id,
          title,
          step: label,
          atMs: durationMs(),
        });
      }
      task.stepLabel = label;
      task.current = 0;
      task.total = 0;
    },
    progress(current, total = 0) {
      task.current = current;
      task.total = total;
    },
    log(line) {
      logger.debug('A background task reported a detail.', { taskId: id, line: String(line).slice(0, 300) });
      task.logs.push(String(line).slice(0, 300));
      if (task.logs.length > 50) task.logs.shift();
    },
    done(result = null) {
      if (task.state !== 'running') return;
      logger.info('A background task finished.', {
        taskId: id,
        title,
        serverId: serverId || undefined,
        durationMs: durationMs(),
        result: summarizeBody(result),
      });
      task.state = 'done';
      notifyFinished(task, true);
      task.result = result;
      task.finishedAt = Date.now();
      scheduleCleanup(id);
    },
    fail(error) {
      if (task.state !== 'running') return;
      logger.warn('A background task failed.', {
        taskId: id,
        title,
        serverId: serverId || undefined,
        step: task.stepLabel,
        durationMs: durationMs(),
        err: serializeError(error),
      });
      task.state = 'failed';
      notifyFinished(task, false, error);
      task.error = error && error.message ? error.message : String(error);
      const extra = {};
      if (error && error.requiresForce) extra.requiresForce = true;
      if (error && error.requiresVersionConfirm) {
        extra.requiresVersionConfirm = true;
        if (error.fromVersion) extra.fromVersion = error.fromVersion;
        if (error.toVersion) extra.toVersion = error.toVersion;
      }
      task.extra = Object.keys(extra).length ? extra : undefined;
      task.finishedAt = Date.now();
      scheduleCleanup(id);
    },
  };
  return handle;
}

/** Fire-and-track: returns the task id immediately; fn runs in background. */
function run(title, opts, fn) {
  const t = createTask(title, opts);
  // createTask/done/fail own the log lines (fail keeps the stack).
  Promise.resolve()
    .then(() => fn(t))
    .then((result) => t.done(result))
    .catch((err) => t.fail(err));
  return t.id;
}

/**
 * Track work the caller awaits itself (a route that answers when it is done,
 * a scheduled job): the task shows in the top-bar tray while fn runs, then is
 * marked done or failed. Resolves/rejects exactly as fn does.
 */
async function track(title, opts, fn) {
  const t = createTask(title, opts);
  try {
    const result = await fn(t);
    t.done();
    return result;
  } catch (err) {
    t.fail(err);
    throw err;
  }
}

function getTask(id) {
  const t = tasks.get(id);
  if (!t) return null;
  return {
    id: t.id,
    title: t.title,
    serverId: t.serverId,
    state: t.state,
    step: t.stepLabel,
    current: t.current,
    total: t.total,
    percent: t.total ? Math.min(100, Math.round((t.current / t.total) * 100)) : null,
    logs: t.logs.slice(-10),
    result: t.result,
    error: t.error,
    ...(t.extra || {}),
    elapsedMs: (t.finishedAt || Date.now()) - t.startedAt,
  };
}

function scheduleCleanup(id) {
  setTimeout(() => tasks.delete(id), TTL_MS).unref();
}

/** Active (running) tasks + very recent finishers, for the global task tray. */
function listTasks() {
  const out = [];
  for (const t of tasks.values()) {
    if (t.state === 'running' || Date.now() - (t.finishedAt || 0) < 15000) {
      out.push(getTask(t.id));
    }
  }
  return out.sort((a, b) => (a.state === 'running' ? -1 : 1) - (b.state === 'running' ? -1 : 1));
}

module.exports = { createTask, run, track, getTask, listTasks };
