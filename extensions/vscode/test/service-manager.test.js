'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  RestartPolicy,
  ServiceManager,
  installVerifiedArtifact,
  validateManifest,
} = require('../lib/service-manager');

function manifest(overrides = {}) {
  return {
    version: '0.2.0',
    protocol_range: '>=1.0.0 <2.0.0',
    artifacts: {
      'win32-x64': {
        url: 'https://downloads.example.test/ai-zhagan-0.2.0.zip',
        sha256: 'a'.repeat(64),
        size: 12,
      },
    },
    ...overrides,
  };
}

test('manifest requires matching version, architecture, protocol and trusted origin', () => {
  const options = { version: '0.2.0', platform: 'win32', arch: 'x64', protocolMajor: 1, trustedOrigins: ['https://downloads.example.test'] };
  assert.equal(validateManifest(manifest(), options).size, 12);
  assert.throws(() => validateManifest(manifest(), { ...options, arch: 'arm64' }), /架构/);
  assert.throws(() => validateManifest(manifest({ version: '0.3.0' }), options), /版本/);
  assert.throws(() => validateManifest(manifest({ protocol_range: '>=2.0.0 <3.0.0' }), options), /VERSION_INCOMPATIBLE/);
  const untrusted = manifest();
  untrusted.artifacts['win32-x64'].url = 'https://evil.test/runtime.zip';
  assert.throws(() => validateManifest(untrusted, options), /受信发布源/);
});

test('corrupt artifact leaves the existing runtime untouched', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-zhagan-install-'));
  const current = path.join(root, 'current');
  const download = path.join(root, 'download.zip');
  fs.mkdirSync(current); fs.writeFileSync(path.join(current, 'version.txt'), 'old');
  fs.writeFileSync(download, 'damaged');
  assert.throws(() => installVerifiedArtifact(download, current, { sha256: '0'.repeat(64), size: 7 }, () => {}), /校验失败/);
  assert.equal(fs.readFileSync(path.join(current, 'version.txt'), 'utf8'), 'old');
});

test('verified artifact installs through staging and replaces only after success', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-zhagan-install-'));
  const current = path.join(root, 'current');
  const download = path.join(root, 'download.zip');
  const bytes = Buffer.from('verified-runtime');
  fs.writeFileSync(download, bytes);
  fs.mkdirSync(current); fs.writeFileSync(path.join(current, 'version.txt'), 'old');
  installVerifiedArtifact(download, current, {
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'), size: bytes.length,
  }, (source, staging) => { fs.mkdirSync(staging); fs.writeFileSync(path.join(staging, 'version.txt'), 'new'); });
  assert.equal(fs.readFileSync(path.join(current, 'version.txt'), 'utf8'), 'new');
});

test('two windows share one managed launch and external services require opt-in', async () => {
  let launches = 0;
  let healthy = false;
  const manager = new ServiceManager({
    status: async () => healthy ? { serviceUrl: 'http://127.0.0.1:8766', apiVersion: '1.0.0', capabilities: [] } : null,
    launch: async () => { launches += 1; healthy = true; },
  });
  const [first, second] = await Promise.all([manager.ensureService(), manager.ensureService()]);
  assert.equal(launches, 1);
  assert.equal(first.serviceUrl, second.serviceUrl);
  await assert.rejects(() => manager.useExternalService('http://127.0.0.1:9999'), /明确选择/);
  manager.allowExternal = true;
  assert.equal((await manager.useExternalService('http://127.0.0.1:9999')).managed, false);
});

test('offline first start fails clearly and keeps an existing installation', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-zhagan-runtime-'));
  const current = path.join(root, 'current');
  fs.mkdirSync(current); fs.writeFileSync(path.join(current, 'version.txt'), 'old');
  const manager = new ServiceManager({
    runtimeRoot: root,
    status: async () => null,
    launch: async () => {},
  });
  await assert.rejects(() => manager.ensureRuntime('0.2.0'), /离线首次启动/);
  assert.equal(fs.readFileSync(path.join(current, 'version.txt'), 'utf8'), 'old');
});

test('restart policy pauses after three crashes and network loss never requests restart', () => {
  let now = 0;
  const policy = new RestartPolicy({ now: () => now, windowMs: 300000, maxCrashes: 3 });
  assert.equal(policy.recordCrash(), true);
  now += 1000; assert.equal(policy.recordCrash(), true);
  now += 1000; assert.equal(policy.recordCrash(), false);
  assert.equal(policy.canRestart(), false);
  assert.equal(policy.recordNetworkLoss(), false);
  policy.resume();
  assert.equal(policy.canRestart(), true);
  policy.pause();
  assert.equal(policy.canRestart(), false);
});
