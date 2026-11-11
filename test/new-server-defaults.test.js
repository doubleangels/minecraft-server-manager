'use strict';

// A new server's container doesn't sit at its memory limit from boot.

require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');
const { migrate } = require('../src/db/migrate');
migrate();
const { withDefaultInitHeap } = require('../src/services/servers');

test('a new server starts with a 512 MB heap that grows, unless told otherwise', () => {
  assert.equal(withDefaultInitHeap({}, 2048).INIT_MEMORY, '512');
  assert.equal(withDefaultInitHeap({ INIT_MEMORY: '1024' }, 2048).INIT_MEMORY, '1024', 'the creator chose one');
  assert.equal(withDefaultInitHeap({ USE_AIKAR_FLAGS: 'true' }, 4096).INIT_MEMORY, undefined, 'Aikar reserves all');
  assert.equal(withDefaultInitHeap({ USE_MEOWICE_FLAGS: true }, 4096).INIT_MEMORY, undefined, 'MeowIce too');
  assert.equal(withDefaultInitHeap({}, 1024).INIT_MEMORY, undefined, 'too small to matter');
  const input = {};
  withDefaultInitHeap(input, 2048);
  assert.deepEqual(input, {}, 'the caller’s object is not changed');
});
