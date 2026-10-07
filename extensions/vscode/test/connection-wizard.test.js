'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { ConnectionWizard } = require('../lib/connection-wizard');

function fixture(overrides = {}) {
  const saved = [];
  const frames = [];
  const input = { projectId: 'p', projectName: '项目', configured: false, ready: false,
    running: false, verified: false, hasKey: true, tunnelId: `tunnel_${'a'.repeat(32)}` };
  const wizard = new ConnectionWizard({
    loadDraft: () => ({ tunnelId: input.tunnelId, apiKey: 'never-restore' }),
    saveDraft: async (value) => saved.push(value),
    snapshot: async () => ({ ...input }),
    connect: async (_value, report) => { report('启动隧道'); input.configured = true; input.running = true; input.ready = true; },
    checkLocal: async () => ({ ok: true }),
    notify: (value) => frames.push(JSON.stringify(value)),
    ...overrides,
  });
  return { wizard, input, saved, frames };
}

test('wizard resumes the ID draft but never restores or publishes secret fields', async () => {
  const { wizard, frames, saved } = fixture();
  await wizard.refresh();
  assert.equal(wizard.state.draft.tunnelId, `tunnel_${'a'.repeat(32)}`);
  await wizard.updateDraft({ tunnelId: 'new-id', apiKey: 'sk-hidden' });
  assert.deepEqual(saved.at(-1), { tunnelId: 'new-id' });
  assert.doesNotMatch(frames.join(''), /never-restore|sk-hidden/);
});

test('one submission runs once, then checks local protocol and waits for ChatGPT', async () => {
  let release;
  let called = 0;
  const run = new Promise((resolve) => { release = resolve; });
  const { wizard, input, frames } = fixture({ connect: async () => {
    called++; await run; input.configured = true; input.running = true; input.ready = true;
  } });
  await wizard.refresh();
  const submit = wizard.submit({ tunnelId: input.tunnelId, apiKey: 'sk-test-secret' });
  await wizard.submit({ tunnelId: input.tunnelId, apiKey: 'sk-test-secret' });
  release(); await submit;
  assert.equal(called, 1);
  assert.equal(wizard.state.step, 'chatgpt');
  assert.equal(wizard.state.localCheck.ok, true);
  assert.equal(wizard.state.connection.verified, false);
  assert.doesNotMatch(frames.join(''), /sk-test-secret/);
});

test('failed setup keeps the draft, shows a safe error and permits retry', async () => {
  let called = 0;
  const { wizard, input, frames } = fixture({ connect: async () => {
    called++; if (called === 1) throw Object.assign(new Error('sk-dont-leak'), { code: 'TUNNEL_CREDENTIALS' });
    input.configured = true; input.running = true; input.ready = true;
  } });
  await wizard.refresh();
  await wizard.submit({ tunnelId: input.tunnelId, apiKey: 'sk-test-secret' });
  assert.equal(wizard.state.busy, false);
  assert.equal(wizard.state.issue.code, 'TUNNEL_CREDENTIALS');
  assert.equal(wizard.state.step, 'form');
  assert.equal(wizard.state.draft.tunnelId, input.tunnelId);
  await wizard.submit({ tunnelId: input.tunnelId, apiKey: 'sk-test-secret' });
  assert.equal(wizard.state.step, 'chatgpt');
  assert.doesNotMatch(frames.join(''), /sk-dont-leak|sk-test-secret/);
});

test('real verification arrives on refresh; local success cannot complete the wizard', async () => {
  const { wizard, input } = fixture();
  await wizard.refresh();
  await wizard.submit({ tunnelId: input.tunnelId, apiKey: '' });
  assert.equal(wizard.state.step, 'chatgpt');
  input.verified = true;
  await wizard.refresh();
  assert.equal(wizard.state.step, 'done');
  input.projectId = 'other'; input.verified = false;
  await wizard.refresh();
  assert.equal(wizard.state.step, 'chatgpt');
});

test('blank keys require a stored credential and missing projects stop setup', async () => {
  const { wizard, input } = fixture(); input.hasKey = false;
  await wizard.refresh();
  await wizard.submit({ tunnelId: input.tunnelId, apiKey: '' });
  assert.match(wizard.state.issue.message, /密钥/);
  input.hasKey = true; input.projectId = null;
  await wizard.refresh();
  await wizard.submit({ tunnelId: input.tunnelId, apiKey: '' });
  assert.equal(wizard.state.issue.code, 'LOCAL_MCP_PROJECT');
});
