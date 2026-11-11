'use strict';

// Parse a JSON column read back from the database without letting one bad
// value take down every page that lists it (the sidebar lists every server on
// every page). A bad value yields the fallback and one warn line per value.

const path = require('node:path');
const logger = require('../logger')(path.basename(__filename));

const warned = new Set();
const WARNED_MAX = 500;

/**
 * Typed as `any`, like the JSON.parse it replaces.
 * @param {string|null|undefined} text
 * @param {any} fallback returned for empty, invalid, or wrongly shaped input
 * @param {{ where?: string, id?: string, expect?: 'array'|'object', issues?: string[], field?: string }} [opts]
 *   expect: the value must be an array / a plain object. issues: the field
 *   name is pushed here when the value was unusable.
 * @returns {any}
 */
function safeJsonParse(text, fallback, opts = {}) {
  if (text == null || text === '') return fallback;
  let value;
  let problem = null;
  try {
    value = JSON.parse(text);
  } catch {
    problem = 'invalid JSON';
  }
  if (!problem && opts.expect === 'array' && !Array.isArray(value)) problem = 'not a list';
  if (!problem && opts.expect === 'object' && (value === null || typeof value !== 'object' || Array.isArray(value))) {
    problem = 'not an object';
  }
  if (!problem) return value;
  if (opts.issues && opts.field) opts.issues.push(opts.field);
  const key = `${opts.where || '?'}:${opts.id || '?'}:${opts.field || ''}`;
  if (!warned.has(key)) {
    if (warned.size >= WARNED_MAX) warned.clear();
    warned.add(key);
    logger.warn('A stored value could not be read, so a default is used instead.', {
      where: opts.where,
      id: opts.id,
      field: opts.field,
      problem,
      length: String(text).length,
    });
  }
  return fallback;
}

module.exports = { safeJsonParse };
