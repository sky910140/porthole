'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  RestartPolicy,
  ReconnectBackoff,
  ServiceManager,
  installVerifiedArtifact,
  installBundledRuntime,
  renameWithRetry,
  validateManifest,
} = require('../lib/service-manager');

function writeBundle(root, { version = '0.2.0', files = { 'porthole.exe': 'new runtime', '_internal/library.dll': 'library' } } = {}) {
  const payload = path.join(root, 'payload');
  fs.mkdirSync(payload, { recursive: true });
  const entries = Object.entries(files).map(([name, content]) => {
    const destination = path.join(payload, name);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, content);
    const bytes = Buffer.from(content);
    return { path: name.replaceAll('\\', '/'), size: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  });
  fs.writeFileSync(path.join(root, 'bundle.json'), JSON.stringify({
    version, platform: 'win32', architecture: 'x64',
    protocol_range: '>=1.0.0 <2.0.0', files: entries,
  }));
  return payload;
}

test('bundled runtime installs verified files and reuses a healthy install', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'porthole-bundle-'));
  const bundle = path.join(root, 'bundle');
  const current = path.join(root, 'current');
  writeBundle(bundle);
  assert.equal(installBundledRuntime(bundle, current, '0.2.0'), path.join(current, 'porthole.exe'));
  assert.equal(fs.readFileSync(path.join(current, '_internal/library.dll'), 'utf8'), 'library');
  fs.writeFileSync(path.join(current, 'keep.txt'), 'existing');
  installBundledRuntime(bundle, current, '0.2.0');
  assert.equal(fs.readFileSync(path.join(current, 'keep.txt'), 'utf8'), 'existing');
});

test('runtime installation retries a transient Windows rename failure', () => {
  const calls = [];
  const waits = [];
  renameWithRetry('staging', 'current', {
    rename: (source, destination) => {
      calls.push([source, destination]);
      if (calls.length === 1) throw Object.assign(new Error('scanner holds executable'), { code: 'EPERM' });
    },
    sleep: (milliseconds) => waits.push(milliseconds),
  });
  assert.deepEqual(calls, [['staging', 'current'], ['staging', 'current']]);
  assert.deepEqual(waits, [50]);
  assert.throws(() => renameWithRetry('staging', 'current', {
    rename: () => { throw Object.assign(new Error('disk failure'), { code: 'EIO' }); },
    sleep: () => assert.fail('non-transient error must not retry'),
  }), /disk failure/);
});

test('damaged bundle and invalid manifest cannot replace an existing runtime', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'porthole-bundle-'));
  const bundle = path.join(root, 'bundle');
  const current = path.join(root, 'current');
  writeBundle(bundle);
  fs.mkdirSync(current);
  fs.writeFileSync(path.join(current, 'porthole.exe'), 'old runtime');
  fs.writeFileSync(path.join(bundle, 'payload/porthole.exe'), 'tampered');
  assert.throws(() => installBundledRuntime(bundle, current, '0.2.0'), /校验失败/);
  assert.equal(fs.readFileSync(path.join(current, 'porthole.exe'), 'utf8'), 'old runtime');
  writeBundle(bundle);
  const manifestPath = path.join(bundle, 'bundle.json');
  const manifestValue = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  for (const modified of [
    { ...manifestValue, platform: 'linux' },
    { ...manifestValue, protocol_range: '>=2.0.0 <3.0.0' },
    { ...manifestValue, files: [{ ...manifestValue.files[0], path: '../escape.exe' }] },
  ]) {
    fs.writeFileSync(manifestPath, JSON.stringify(modified));
    assert.throws(() => installBundledRuntime(bundle, current, '0.2.0'));
    assert.equal(fs.readFileSync(path.join(current, 'porthole.exe'), 'utf8'), 'old runtime');
  }
  for (const suspiciousPath of ['CON', '_internal/odd?.dll']) {
    fs.writeFileSync(manifestPath, JSON.stringify({
      ...manifestValue, files: [{ ...manifestValue.files[0], path: suspiciousPath }],
    }));
    assert.throws(() => installBundledRuntime(bundle, current, '0.2.0'), /无效文件路径/);
    assert.equal(fs.readFileSync(path.join(current, 'porthole.exe'), 'utf8'), 'old runtime');
  }
  fs.writeFileSync(manifestPath, JSON.stringify(manifestValue));
  installBundledRuntime(bundle, current, '0.2.0');
  assert.equal(fs.readFileSync(path.join(current, 'porthole.exe'), 'utf8'), 'new runtime');
  assert.equal(fs.readFileSync(path.join(root, 'current.previous/porthole.exe'), 'utf8'), 'old runtime');
});

function manifest(overrides = {}) {
  return {
    version: '0.2.0',
    protocol_range: '>=1.0.0 <2.0.0',
    artifacts: {
      'win32-x64': {
        url: 'https://downloads.example.test/porthole-0.2.0.zip',
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'porthole-install-'));
  const current = path.join(root, 'current');
  const download = path.join(root, 'download.zip');
  fs.mkdirSync(current); fs.writeFileSync(path.join(current, 'version.txt'), 'old');
  fs.writeFileSync(download, 'damaged');
  assert.throws(() => installVerifiedArtifact(download, current, { sha256: '0'.repeat(64), size: 7 }, () => {}), /校验失败/);
  assert.equal(fs.readFileSync(path.join(current, 'version.txt'), 'utf8'), 'old');
});

test('verified artifact installs through staging and replaces only after success', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'porthole-install-'));
  const current = path.join(root, 'current');
  const download = path.join(root, 'download.zip');
  const bytes = Buffer.from('verified-runtime');
  fs.writeFileSync(download, bytes);
  fs.mkdirSync(current); fs.writeFileSync(path.join(current, 'version.txt'), 'old');
  installVerifiedArtifact(download, current, {
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'), size: bytes.length,
  }, (source, staging) => { fs.mkdirSync(staging); fs.writeFileSync(path.join(staging, 'version.txt'), 'new'); });
  assert.equal(fs.readFileSync(path.join(current, 'version.txt'), 'utf8'), 'new');
  assert.equal(fs.readFileSync(path.join(root, 'current.previous', 'version.txt'), 'utf8'), 'old');
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'porthole-runtime-'));
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

test('reconnect backoff uses 1 2 4 8 16 30 seconds with bounded jitter', () => {
  const exact = new ReconnectBackoff({ random: () => 0 });
  assert.deepEqual(
    Array.from({ length: 7 }, () => exact.nextDelayMs()),
    [1000, 2000, 4000, 8000, 16000, 30000, 30000],
  );
  const jittered = new ReconnectBackoff({ random: () => 1 });
  assert.deepEqual(
    Array.from({ length: 6 }, () => jittered.nextDelayMs()),
    [1200, 2400, 4800, 9600, 19200, 30000],
  );
});

test('pause cancels scheduled reconnect and authentication failure stops retries', () => {
  const timers = new Map(); let nextId = 1; let calls = 0;
  const backoff = new ReconnectBackoff({
    random: () => 0,
    setTimer: (callback, delay) => { const id = nextId++; timers.set(id, { callback, delay }); return id; },
    clearTimer: (id) => timers.delete(id),
  });
  const first = backoff.schedule(() => { calls += 1; });
  assert.equal(timers.get(first).delay, 1000);
  backoff.pause();
  assert.equal(timers.size, 0);
  assert.equal(backoff.schedule(() => {}), null);
  backoff.resume();
  const second = backoff.schedule(() => { calls += 1; });
  timers.get(second).callback();
  assert.equal(calls, 1);
  backoff.authenticationFailed();
  assert.equal(backoff.schedule(() => {}), null);
  backoff.resetAfterWake();
  assert.equal(backoff.nextDelayMs(), 1000);
});
