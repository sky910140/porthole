'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const {
  ChangeActionRunner,
  RevisionGate,
  createChangeClient,
  reviewChoices,
} = require('../lib/changes');
const { buildReadinessPayload } = require('../lib/readiness');
const { deriveViewState } = require('../lib/view-state');

test('builds readiness from every open file in the bound workspace', () => {
  const root = path.resolve('workspace');
  const payload = buildReadinessPayload({
    projectId: 'demo', sessionId: 'window-a', rootPath: root,
    review: { change_id: 'change-1', manifest_sha256: 'a'.repeat(64) },
    documents: [
      { scheme: 'file', fsPath: path.join(root, 'a.txt'), version: 2, isDirty: true },
      { scheme: 'file', fsPath: path.resolve(root, '..', 'outside.txt'), version: 1, isDirty: false },
      { scheme: 'untitled', fsPath: path.join(root, 'new.txt'), version: 1, isDirty: true },
    ],
  });
  assert.deepEqual(payload, {
    project_id: 'demo',
    documents: [{ path: 'a.txt', version: 2, dirty: true }],
    active_review: { change_id: 'change-1', manifest_sha256: 'a'.repeat(64) },
  });
});

test('double apply reuses one operation id and one readiness request', async () => {
  const calls = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const client = createChangeClient({
    request: async (method, url, body) => {
      calls.push({ method, url, body });
      if (url.endsWith('/readiness')) return { lease_id: 'lease-1' };
      await gate;
      return { state: 'applied', revision: 2 };
    },
  });
  const runner = new ChangeActionRunner(client, { randomId: () => 'operation-1' });
  const change = {
    change_id: 'change-1', revision: 1, manifest_sha256: 'a'.repeat(64),
  };
  const first = runner.apply(change, 'window-a');
  const second = runner.apply(change, 'window-a');
  assert.equal(first, second);
  release();
  assert.equal((await first).state, 'applied');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].body.operation_id, 'operation-1');
});

test('revision gate rejects stale polling responses', () => {
  const gate = new RevisionGate();
  assert.equal(gate.accept({ change_id: 'one', revision: 3 }), true);
  assert.equal(gate.accept({ change_id: 'one', revision: 2 }), false);
  assert.equal(gate.accept({ change_id: 'one', revision: 4 }), true);
  assert.equal(gate.accept({ change_id: 'two', revision: 1 }), true);
});

test('every persisted change state has one understandable primary action', () => {
  const expected = {
    pending_review: 'review_change', rejected: 'view_result', expired: 'regenerate_change',
    conflict: 'regenerate_change', applying: 'wait', applied: 'run_tests',
    rolled_back: 'review_failure', recovery_required: 'view_recovery',
    reverting: 'wait', reverted: 'view_result',
  };
  for (const [state, action] of Object.entries(expected)) {
    const view = deriveViewState({ changeState: state, testsPassed: false });
    assert.equal(view.primaryAction, action, state);
    assert.ok(view.label.length > 0);
    assert.ok(view.detail.length > 0);
  }
});

test('review picker shows only pending changes in the connected project', () => {
  const choices = reviewChoices([{
    projectId: 'demo', folderName: 'My project', changes: [
      { change_id: 'one', project_id: 'demo', state: 'pending_review', summary: 'Update docs', updated_at: '2026-09-23T10:00:00Z' },
      { change_id: 'two', project_id: 'demo', state: 'applied', summary: 'Done' },
      { change_id: 'three', project_id: 'other', state: 'pending_review', summary: 'Wrong project' },
    ],
  }]);
  assert.equal(choices.length, 1);
  assert.equal(choices[0].changeId, 'one');
  assert.match(choices[0].label, /Update docs/);
  assert.match(choices[0].description, /My project/);
});
