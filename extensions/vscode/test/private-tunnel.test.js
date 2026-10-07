'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const {
  validateTunnelId, tunnelLaunchSpec, installVerifiedArchive, probeTunnelHealth,
  startTunnelClient, stopTunnelClient, preparePrivateTunnelConfig, ensureTunnelClient, ARCHIVE_NAME, tunnelProcessEnv,
} = require('../lib/private-tunnel');

test('tunnel ID and launch inputs are strict, while secrets stay out of arguments', () => {
  const id = `tunnel_${'a'.repeat(32)}`;
  assert.equal(validateTunnelId(id), id);
  assert.throws(() => validateTunnelId('tunnel_../bad'), /Tunnel ID/);
  const spec = tunnelLaunchSpec({ tunnelId: id, apiKey: 'sk-test-secret-value',
    mcpToken: 'x'.repeat(40), mcpPort: 8765, healthFile: 'C:\\Temp\\health.url' });
  assert.equal(spec.env.CONTROL_PLANE_TUNNEL_ID, id);
  assert.equal(spec.env.CONTROL_PLANE_API_KEY, 'sk-test-secret-value');
  assert.equal(spec.env.PORTHOLE_MCP_AUTH, `Bearer ${'x'.repeat(40)}`);
  assert.equal(spec.env.MCP_SERVER_URL, 'http://127.0.0.1:8765/mcp');
  assert.match(spec.env.MCP_EXTRA_HEADERS, /Authorization: env:PORTHOLE_MCP_AUTH/);
  assert.match(spec.env.MCP_DISCOVERY_EXTRA_HEADERS, /Authorization: env:PORTHOLE_MCP_AUTH/);
  assert.doesNotMatch(spec.args.join(' '), /sk-test-secret-value|x{40}/);
  assert.throws(() => tunnelLaunchSpec({ tunnelId: id, apiKey: 'sk-test-secret-value',
    mcpToken: 'x'.repeat(40), mcpPort: 80, healthFile: 'health.url' }), /端口/);
});

test('unrelated inherited settings cannot redirect keys or enable raw HTTP logs', () => {
  const env = tunnelProcessEnv({ CONTROL_PLANE_BASE_URL: 'https://api.openai.com', LOG_HTTP_RAW_UNSAFE: 'false' },
    { PATH: 'system', HTTPS_PROXY: 'http://proxy.local:1080', TUNNEL_CLIENT_CONFIG: 'foreign.yaml',
      CONTROL_PLANE_BASE_URL: 'https://foreign.example', LOG_HTTP_RAW_UNSAFE: 'true', OTHER_SECRET: 'unrelated' });
  assert.equal(env.CONTROL_PLANE_BASE_URL, 'https://api.openai.com');
  assert.equal(env.LOG_HTTP_RAW_UNSAFE, 'false');
  assert.equal(env.HTTPS_PROXY, 'http://proxy.local:1080');
  assert.equal(env.OTHER_SECRET, undefined);
  assert.equal(env.TUNNEL_CLIENT_CONFIG, undefined);
});

test('switching from public OAuth keeps project grants but removes public exposure', () => {
  const current = { config_version: '1.0', projects: [{ id: 'p', root: 'D:\\work' }],
    auth_mode: 'github', public_url: 'https://mcp.example.com', github_user_ids: ['123'],
    mcp_port: 8765, admin_port: 8766 };
  const next = preparePrivateTunnelConfig(current);
  assert.equal(next.auth_mode, 'local');
  assert.equal(next.public_url, null);
  assert.deepEqual(next.github_user_ids, []);
  assert.deepEqual(next.projects, current.projects);
  assert.equal(next.mcp_port, 8765);
  assert.equal(current.auth_mode, 'github');
});

test('archive hash is checked before extraction and a failed update keeps the old client', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'porthole-tunnel-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const install = path.join(root, 'install');
  fs.mkdirSync(install);
  fs.writeFileSync(path.join(install, 'tunnel-client.exe'), 'old');
  let extracted = false;
  await assert.rejects(installVerifiedArchive(Buffer.from('archive'), install, {
    sha256: '0'.repeat(64), extract: async () => { extracted = true; },
  }), /SHA-256/);
  assert.equal(extracted, false);
  assert.equal(fs.readFileSync(path.join(install, 'tunnel-client.exe'), 'utf8'), 'old');
  const bytes = Buffer.from('archive');
  const binary = await installVerifiedArchive(bytes, install, {
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    extract: async (directory) => fs.writeFileSync(path.join(directory, 'tunnel-client.exe'), 'new'),
  });
  assert.equal(fs.readFileSync(binary, 'utf8'), 'new');
});

test('health probe accepts only a ready loopback client', async () => {
  const fetcher = async (url) => ({ ok: url.endsWith('/readyz') });
  assert.equal(await probeTunnelHealth('http://127.0.0.1:49000', fetcher), true);
  await assert.rejects(probeTunnelHealth('https://example.com', fetcher), /本机/);
  await assert.rejects(probeTunnelHealth('http://127.0.0.1:49000/path', fetcher), /本机/);
});

test('supervisor starts the pinned client with secret-only environment and stops its own child', async () => {
  const child = new EventEmitter();
  child.exitCode = null;
  child.kill = () => { child.exitCode = 0; child.emit('exit', 0); return true; };
  let launched;
  const handle = await startTunnelClient({
    executable: 'C:\\Tunnel\\tunnel-client.exe', tunnelId: `tunnel_${'b'.repeat(32)}`,
    apiKey: 'sk-test-secret-value', mcpToken: 'x'.repeat(40), mcpPort: 8765,
    spawnProcess: (file, args, options) => {
      launched = { file, args, options };
      fs.writeFileSync(args[args.indexOf('--health.url-file') + 1], 'http://127.0.0.1:49001');
      return child;
    },
    probe: async () => true,
    inspect: async () => ({ ready: true, issue: null }),
  });
  assert.equal(handle.running, true);
  assert.equal(launched.file, 'C:\\Tunnel\\tunnel-client.exe');
  assert.equal(launched.options.env.CONTROL_PLANE_API_KEY, 'sk-test-secret-value');
  assert.doesNotMatch(launched.args.join(' '), /sk-test-secret-value|x{40}/);
  await stopTunnelClient(handle);
  assert.equal(handle.running, false);
});

test('bundled installation never downloads or silently replaces a corrupt bundle', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'porthole-offline-tunnel-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bundleRoot = path.join(root, 'bundle'); fs.mkdirSync(bundleRoot);
  fs.writeFileSync(path.join(bundleRoot, ARCHIVE_NAME), 'corrupt');
  let downloaded = false;
  const options = { bundleRoot, download: async () => { downloaded = true; return Buffer.from('other'); } };
  await assert.rejects(ensureTunnelClient(path.join(root, 'install'), options), /SHA-256/);
  assert.equal(downloaded, false);
  fs.unlinkSync(path.join(bundleRoot, ARCHIVE_NAME));
  await assert.rejects(ensureTunnelClient(path.join(root, 'install'), options), /缺少/);
  assert.equal(downloaded, false);
});

test('a client that never becomes ready is stopped and leaves no health file', async () => {
  const child = new EventEmitter();
  child.exitCode = null;
  let stopped = false;
  let healthFile;
  child.kill = () => { stopped = true; child.exitCode = 0; child.emit('exit', 0); return true; };
  await assert.rejects(startTunnelClient({
    executable: 'C:\\Tunnel\\tunnel-client.exe', tunnelId: `tunnel_${'c'.repeat(32)}`,
    apiKey: 'sk-test-secret-value', mcpToken: 'x'.repeat(40), mcpPort: 8765,
    spawnProcess: (_file, args) => {
      healthFile = args[args.indexOf('--health.url-file') + 1];
      return child;
    },
    timeoutMs: 1,
  }), /未就绪/);
  assert.equal(stopped, true);
  assert.equal(fs.existsSync(path.dirname(healthFile)), false);
});

test('a fatal credential error stops the client even when local readiness passes', async () => {
  const child = new EventEmitter();
  let stopped = false;
  let healthFile;
  child.kill = () => { stopped = true; child.emit('exit', 0); return true; };
  await assert.rejects(startTunnelClient({
    executable: 'C:\\Tunnel\\tunnel-client.exe', tunnelId: `tunnel_${'d'.repeat(32)}`,
    apiKey: 'sk-test-secret-value', mcpToken: 'x'.repeat(40), mcpPort: 8765,
    spawnProcess: (_file, args) => {
      healthFile = args[args.indexOf('--health.url-file') + 1];
      fs.writeFileSync(healthFile, 'http://127.0.0.1:49002');
      return child;
    },
    probe: async () => true,
    inspect: async () => ({ ready: false, issue: { code: 'TUNNEL_CREDENTIALS', retryable: false } }),
  }), (error) => error.code === 'TUNNEL_CREDENTIALS');
  assert.equal(stopped, true);
  assert.equal(fs.existsSync(path.dirname(healthFile)), false);
});
