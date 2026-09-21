'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  DEMO_PROJECT,
  buildQuestionPrompt,
  buildResultPrompt,
  runOnboarding,
  userStep,
  validateSelfHostedStatus,
} = require('../lib/onboarding');

function memoryStore(initial = null) {
  let value = initial;
  return {
    load: async () => value,
    save: async (next) => { value = structuredClone(next); },
    value: () => value,
  };
}

test('maps internal checkpoints to only three user steps', () => {
  for (const checkpoint of ['prerequisites', 'runtime', 'project']) {
    assert.equal(userStep(checkpoint), 'project');
  }
  assert.equal(userStep('connection'), 'connection');
  assert.equal(userStep('verification'), 'try_question');
  assert.equal(userStep('complete'), 'try_question');
});

test('keeps the checkpoint when a multi-root selection is cancelled and resumes it', async () => {
  const store = memoryStore();
  const calls = [];
  const deps = {
    ...store,
    showPrerequisites: async () => true,
    ensureRuntime: async () => calls.push('runtime'),
    listFolders: async () => [{ id: 'a' }, { id: 'b' }],
    chooseFolder: async () => null,
  };
  const cancelled = await runOnboarding(deps);
  assert.deepEqual(cancelled, { status: 'cancelled', step: 'project' });
  assert.equal(store.value().checkpoint, 'project');
  assert.deepEqual(calls, ['runtime']);

  deps.chooseFolder = async () => ({ id: 'b' });
  deps.connect = async (folder) => ({ projectId: `project-${folder.id}` });
  deps.isVerified = async () => false;
  deps.presentTryQuestion = async (value) => calls.push(value.projectId);
  const resumed = await runOnboarding(deps);
  assert.deepEqual(resumed, { status: 'waiting', step: 'try_question' });
  assert.deepEqual(calls, ['runtime', 'project-b']);
  assert.equal(store.value().folderId, 'b');
  assert.equal(store.value().checkpoint, 'verification');
});

test('does not persist secrets returned while connecting', async () => {
  const store = memoryStore({ checkpoint: 'connection', folderId: 'only' });
  await runOnboarding({
    ...store,
    listFolders: async () => [{ id: 'only' }],
    connect: async () => ({ projectId: 'demo', token: 'must-not-be-saved' }),
    isVerified: async () => true,
  });
  assert.equal(JSON.stringify(store.value()).includes('must-not-be-saved'), false);
  assert.deepEqual(store.value(), {
    checkpoint: 'complete', folderId: 'only', projectId: 'demo',
  });
});

test('validates self-hosted account prerequisites without accepting local mode', () => {
  assert.deepEqual(validateSelfHostedStatus({
    auth_mode: 'github', public_url: 'https://mcp.example.test', account_allowlist_configured: true,
  }), { ready: true, problems: [] });
  assert.deepEqual(validateSelfHostedStatus({ auth_mode: 'local', public_url: null }), {
    ready: false,
    problems: ['需要 HTTPS 公网地址', '需要 GitHub OAuth', '需要配置允许登录的账号'],
  });
});

test('builds explicit templates and a fixed non-connected demo', () => {
  const question = buildQuestionPrompt('demo', 'src/main.py');
  assert.match(question, /demo/);
  assert.match(question, /src\/main\.py/);
  assert.match(buildResultPrompt('change-123'), /change-123/);
  assert.equal(DEMO_PROJECT.connected, false);
  assert.equal(DEMO_PROJECT.label, '演示数据，尚未连接 ChatGPT');
});
