'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { InitialReset, collectResetKeys, readResetFiles, visibleResetState,
  mergeResetKeys, observeResetReceipt } = require('../lib/initial-reset');

function fixture(saved = null) {
  let stored = saved;
  const actions = [];
  const notices = [];
  const options = {
    load: () => stored,
    save: async (value) => { stored = JSON.parse(JSON.stringify(value)); },
    confirm: async () => { actions.push('confirm'); return true; },
    preflight: async () => { actions.push('preflight'); return { external: { chatgpt: true, github: true, openai: false } }; },
    suspend: async () => { actions.push('suspend'); },
    disableStartup: async () => { actions.push('disableStartup'); },
    stopTunnel: async () => { actions.push('stopTunnel'); },
    resetCore: async () => { actions.push('resetCore'); return { local_reset: true, reset_id: 'a'.repeat(32) }; },
    clearExtension: async () => { actions.push('clearExtension'); },
    verify: async () => { actions.push('verify'); },
    notify: (value) => notices.push(JSON.parse(JSON.stringify(value))),
  };
  return { options, actions, notices, stored: () => stored };
}

test('cancel leaves service, credentials and saved reset state untouched', async () => {
  const f = fixture();
  f.options.confirm = async () => false;
  const result = await new InitialReset(f.options).run();
  assert.equal(result.phase, 'idle');
  assert.deepEqual(f.actions, []);
  assert.equal(f.stored(), null);
});

test('duplicate clicks execute one reset and completion verifies the clear', async () => {
  const f = fixture();
  let release;
  f.options.suspend = async () => new Promise((resolve) => { release = resolve; });
  const reset = new InitialReset(f.options);
  const first = reset.run();
  const second = reset.run();
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.phase, 'complete');
  assert.equal(b.resetId, 'a'.repeat(32));
  assert.equal(f.actions.filter((item) => item === 'confirm').length, 1);
  assert.equal(f.actions.filter((item) => item === 'resetCore').length, 1);
  assert.equal(f.actions.at(-1), 'verify');
  assert.equal((await reset.run()).resetId, a.resetId);
  assert.equal(f.actions.filter((item) => item === 'resetCore').length, 1);
});

test('credential failure persists unfinished step and a new instance continues without reconfirming', async () => {
  const f = fixture();
  f.options.clearExtension = async () => { throw new Error('sk-private-fixture-secret'); };
  const failed = await new InitialReset(f.options).run();
  assert.equal(failed.phase, 'failed');
  assert.equal(failed.step, 'clearExtension');
  assert.equal(failed.resetId, 'a'.repeat(32));
  assert.doesNotMatch(JSON.stringify(f.stored()), /sk-private-fixture-secret/);
  assert.doesNotMatch(JSON.stringify(f.notices), /sk-private-fixture-secret/);
  const resumed = fixture(f.stored());
  resumed.options.confirm = async () => { throw new Error('must not ask twice'); };
  assert.equal((await new InitialReset(resumed.options).run()).phase, 'complete');
  assert.deepEqual(resumed.actions, ['preflight', 'suspend', 'disableStartup', 'stopTunnel', 'resetCore', 'clearExtension', 'verify']);
});

test('busy preflight preserves the active profile and allows recovery operations', async () => {
  const f = fixture();
  f.options.preflight = async () => { throw Object.assign(new Error('raw internal path'), { code: 'RESET_BUSY' }); };
  const result = await new InitialReset(f.options).run();
  assert.equal(result.phase, 'blocked');
  assert.equal(result.issue.code, 'RESET_BUSY');
  assert.equal(f.stored(), null);
  assert.deepEqual(f.actions, ['confirm']);
});

test('a reset interrupted by VS Code restart offers an enabled resume action', async () => {
  const saved = { phase: 'running', step: 'clearExtension', resetId: 'a'.repeat(32) };
  assert.equal(visibleResetState(saved, false).phase, 'failed');
  assert.equal(visibleResetState(saved, true).phase, 'running');
  const f = fixture(saved);
  f.options.confirm = async () => { throw new Error('already confirmed'); };
  const reset = new InitialReset(f.options);
  assert.equal(reset.state.phase, 'failed');
  assert.equal((await reset.run()).phase, 'complete');
});

test('purge discovers recorded closed folders and retains reset checkpoints and other extensions', () => {
  const keys = collectResetKeys({
    globalKeys: ['other.secret', 'porthole.tunnelDraft', 'porthole.resetPending', 'porthole.manualServiceStop'],
    knownSecretKeys: ['other.secret', 'porthole.token:file:///closed', 'porthole.privateTunnelApiKey'],
    folderUris: ['file:///open'],
  });
  assert.deepEqual(keys.globalKeys, ['porthole.tunnelDraft']);
  assert.ok(keys.secretKeys.includes('porthole.token:file:///closed'));
  assert.ok(keys.secretKeys.includes('porthole.token:file:///open'));
  assert.ok(keys.secretKeys.includes('porthole.managedAdminToken'));
  assert.ok(!keys.secretKeys.includes('other.secret'));
});

test('malformed reset marker blocks restart and receipt only exposes its generation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'porthole-reset-marker-'));
  try {
    const config = path.join(root, 'config.json');
    fs.writeFileSync(path.join(root, '.reset-in-progress.json'), '{broken');
    assert.equal(readResetFiles(config).pending, true);
    fs.unlinkSync(path.join(root, '.reset-in-progress.json'));
    fs.writeFileSync(path.join(root, '.reset-receipt.json'), JSON.stringify({ reset_id: 'b'.repeat(32), completed_at: 'today', token: 'must-not-forward' }));
    assert.deepEqual(readResetFiles(config), { pending: false, receipt: { reset_id: 'b'.repeat(32), completed_at: 'today' } });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('retry after core cleanup retains closed legacy credentials missing from the registry', () => {
  const before = collectResetKeys({ folderUris: ['file:///legacy-closed-project'],
    globalKeys: ['porthole.resetCleanup', 'porthole.tunnelDraft'] });
  const stored = JSON.parse(JSON.stringify(before));
  const after = collectResetKeys({ folderUris: [], globalKeys: ['porthole.resetCleanup'] });
  const resumed = mergeResetKeys(stored, after);
  assert.ok(resumed.secretKeys.includes('porthole.token:file:///legacy-closed-project'));
  assert.ok(!resumed.globalKeys.includes('porthole.resetCleanup'));
});

test('an observed reset is acknowledged only after cleanup succeeds and failures can retry', async () => {
  let observedId = null;
  let clears = 0;
  let failures = 0;
  const receipt = { reset_id: 'd'.repeat(32) };
  const options = () => ({ observedId,
    clear: async () => { clears += 1; if (clears === 1) throw new Error('vault denied'); },
    ack: async (id) => { observedId = id; }, failed: async () => { failures += 1; },
  });
  assert.equal(await observeResetReceipt(receipt, options()), false);
  assert.equal(observedId, null);
  assert.equal(failures, 1);
  assert.equal(await observeResetReceipt(receipt, options()), true);
  assert.equal(observedId, receipt.reset_id);
  assert.equal(clears, 2);
  assert.equal(await observeResetReceipt(receipt, options()), false);
  assert.equal(clears, 2);
});
