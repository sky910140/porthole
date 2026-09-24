'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { projectIdForPath, projectForRoot, projectChoice, projectPolicyChange } = require('../lib/projects');

test('choosing a different directory never reuses an old project authorization', () => {
  const first = path.resolve('one-project');
  const second = path.resolve('another-project');
  const oldProject = { id: projectIdForPath(first), root: first, mode: 'propose', apply_local_enabled: true };
  assert.equal(projectForRoot([oldProject], first), oldProject);
  assert.equal(projectForRoot([oldProject], second), null);
  assert.notEqual(projectIdForPath(first), projectIdForPath(second));
  const choice = projectChoice(second, [oldProject]);
  assert.equal(choice.existing, false);
  assert.equal(choice.id, projectIdForPath(second));
  assert.equal(choice.mode, 'read_only');
});

test('selecting an already authorized directory uses its actual project ID', () => {
  const root = path.resolve('my-project');
  const project = { id: 'custom-id', root, mode: 'read_only' };
  assert.deepEqual(projectChoice(root, [project]), {
    id: 'custom-id', root, existing: true, mode: 'read_only',
  });
});

test('allowing proposals does not grant local writes and returning to read-only revokes writes', () => {
  const readonly = { mode: 'read_only', apply_local_enabled: false };
  assert.deepEqual(projectPolicyChange(readonly, 'toggle-proposals'), { mode: 'propose' });
  assert.throws(() => projectPolicyChange(readonly, 'toggle-local-apply'), /先允许提出修改/);
  const writable = { mode: 'propose', apply_local_enabled: true };
  assert.deepEqual(projectPolicyChange(writable, 'toggle-proposals'), {
    mode: 'read_only', apply_local_enabled: false,
  });
  assert.deepEqual(projectPolicyChange(writable, 'toggle-local-apply'), { apply_local_enabled: false });
});
