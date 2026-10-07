'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { withProfileLease, profileGenerationGuard } = require('../lib/profile-edit');

test('the edit lease releases on completion and generation changes block queued work', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azh-profile-'));
  const config = path.join(dir, 'config.json');
  const executableScript = path.join(dir, 'lease.cjs');
  fs.writeFileSync(config, '{}');
  fs.writeFileSync(executableScript, "process.stdout.write('{\"ready\":true}\\n'); process.stdin.resume(); process.stdin.on('end',()=>process.exit(0));");
  try {
    let ran = false;
    await withProfileLease({ executable: process.execPath, config, prefixArgs: [executableScript] }, async (guard) => {
      guard(); ran = true;
    });
    assert.equal(ran, true);
    const guard = profileGenerationGuard(config);
    fs.writeFileSync(path.join(dir, '.reset-receipt.json'), JSON.stringify({ reset_id: 'c'.repeat(32) }));
    assert.throws(guard, /重置|恢复初始状态/);
    await assert.rejects(withProfileLease({ executable: process.execPath, config,
      prefixArgs: [executableScript], expectedResetId: null }, async () => { throw new Error('must not execute'); }), /重置|恢复初始状态/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('unexpected lease process exit does not allow stale configuration writes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azh-profile-exit-'));
  const config = path.join(dir, 'config.json');
  const script = path.join(dir, 'lease.cjs');
  fs.writeFileSync(config, '{}');
  fs.writeFileSync(script, "process.stdout.write('{\"ready\":true}\\n'); setTimeout(()=>process.exit(0),30);");
  try {
    await assert.rejects(withProfileLease({ executable: process.execPath, config, prefixArgs: [script] }, async (guard) => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      guard(); fs.writeFileSync(config, 'stale grant');
    }), /中断|重置/);
    assert.equal(fs.readFileSync(config, 'utf8'), '{}');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
