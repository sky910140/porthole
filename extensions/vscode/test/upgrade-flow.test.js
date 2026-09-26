'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { upgradeManagedBundle } = require('../lib/upgrade-flow');

test('upgrade takes snapshot before install and finalizes only after service verifies', async () => {
  const calls = [];
  const hooks = Object.fromEntries(['stop', 'install', 'complete', 'start', 'finalize', 'quiesce', 'restore', 'restartOriginal']
    .map((name) => [name, async () => calls.push(name)]));
  hooks.prepare = async () => { calls.push('prepare'); return 'snapshot'; };
  const id = await upgradeManagedBundle(hooks);
  assert.equal(id, 'snapshot');
  assert.deepEqual(calls, ['stop', 'prepare', 'install', 'complete', 'start', 'finalize']);
});

test('failed new service restores snapshot and restarts old owned service', async () => {
  const calls = [];
  const hooks = Object.fromEntries(['stop', 'complete', 'quiesce', 'restore', 'restartOriginal']
    .map((name) => [name, async () => calls.push(name)]));
  hooks.prepare = async () => { calls.push('prepare'); return 'snapshot'; };
  hooks.install = async () => calls.push('install');
  hooks.start = async () => { calls.push('start'); throw new Error('new start failed'); };
  await assert.rejects(upgradeManagedBundle(hooks), /new start failed/);
  assert.deepEqual(calls, ['stop', 'prepare', 'install', 'complete', 'start', 'quiesce', 'restore', 'restartOriginal']);
});

test('a stop error still attempts to recover the previous service', async () => {
  let restarted = false;
  await assert.rejects(upgradeManagedBundle({
    stop: async () => { throw new Error('stop timed out'); },
    restartOriginal: async () => { restarted = true; },
  }), /stop timed out/);
  assert.equal(restarted, true);
});
