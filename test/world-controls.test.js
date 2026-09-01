'use strict';

require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');
const { looksLikeError, QUICK_ACTIONS } = require('../src/services/worldControls');

test('looksLikeError catches an unknown gamerule reply (so it is not a silent success)', () => {
  assert.equal(looksLikeError('No game rule called keep_inventory is available'), true);
  assert.equal(looksLikeError('No gamerule called doFireTick is available'), true);
  assert.equal(looksLikeError('No such gamerule: foo'), true);
});

test('looksLikeError still catches the classic syntax rejections', () => {
  assert.equal(looksLikeError('Incorrect argument for command'), true);
  assert.equal(looksLikeError('Unknown command or insufficient permissions'), true);
  assert.equal(looksLikeError('gamerule doFireTick <--[HERE]'), true);
});

test('looksLikeError passes a normal success line through', () => {
  assert.equal(looksLikeError('Gamerule doFireTick is currently set to: true'), false);
  assert.equal(looksLikeError('Set the time to 1000'), false);
});

test('every curated World Controls chip maps to a real quick action', () => {
  // Slugs the trimmed world-controls.hbs always shows.
  const curatedToggles = ['keepinv', 'daycycle', 'mobspawn', 'mobgrief', 'phantoms', 'firetick', 'deathmsg', 'pvp'];
  for (const slug of curatedToggles) {
    assert.ok(QUICK_ACTIONS[`${slug}-on`], `${slug}-on missing`);
    assert.ok(QUICK_ACTIONS[`${slug}-off`], `${slug}-off missing`);
  }
  for (const key of ['time-day', 'time-night', 'weather-clear', 'weather-rain', 'save-all', 'difficulty-normal']) {
    assert.ok(QUICK_ACTIONS[key], `${key} missing`);
  }
});
