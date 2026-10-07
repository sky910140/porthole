'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { prepareWebSetup, executeWebSetup, resolveGithubOwner,
  probePublicEndpoint, preflightWebConnection } = require('../lib/web-setup');

test('wizard resolves a GitHub name to stable numeric user ID', async () => {
  const owner = await resolveGithubOwner('example-user', async (url) => {
    assert.equal(url, 'https://api.github.com/users/example-user');
    return { ok: true, json: async () => ({ id: 12345, login: 'example-user' }) };
  });
  assert.deepEqual(owner, { id: '12345', login: 'example-user' });
  await assert.rejects(resolveGithubOwner('bad/name', async () => { throw new Error('should not call'); }), /用户名/);
});

test('web setup accepts only HTTPS origin and numeric GitHub owner ID', () => {
  const current = { projects: [{ id: 'p', root: 'D:\\p' }], auth_mode: 'local' };
  assert.throws(() => prepareWebSetup(current, 'http://example.com', '12'), /HTTPS/);
  assert.throws(() => prepareWebSetup(current, 'https://example.com/mcp', '12'), /HTTPS/);
  assert.throws(() => prepareWebSetup(current, 'https://example.com', 'someone'), /数字/);
  const next = prepareWebSetup(current, 'https://example.com/', '123');
  assert.equal(next.public_url, 'https://example.com');
  assert.deepEqual(next.projects, current.projects);
  assert.deepEqual(next.github_user_ids, ['123']);
});

test('public URL preflight checks HTTPS reachability before asking for OAuth secrets', async () => {
  assert.equal(await probePublicEndpoint('https://mcp.example.test', async (url, options) => {
    assert.equal(url, 'https://mcp.example.test/mcp');
    assert.equal(options.redirect, 'manual');
    return { status: 401 };
  }), true);
  await assert.rejects(probePublicEndpoint('https://mcp.example.test',
    async () => ({ status: 404 })), /MCP 路径/);
  await assert.rejects(probePublicEndpoint('https://mcp.example.test',
    async () => ({ status: 200, headers: { get: () => 'text/html' } })), /网页/);
  await assert.rejects(probePublicEndpoint('https://mcp.example.test',
    async () => { throw new Error('network fail'); }), /公网地址.*无法访问/);
});

test('web preflight starts a stopped local service before checking public HTTPS', async () => {
  const calls = [];
  await preflightWebConnection('https://mcp.example.test', {
    ensureRuntime: async () => calls.push('runtime'),
    checkPorts: async () => { calls.push('ports'); return false; },
    start: async () => calls.push('start'),
    probe: async () => calls.push('https'),
  });
  assert.deepEqual(calls, ['runtime', 'ports', 'start', 'https']);
});

test('failed public probe restores config and previous service', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azh-web-'));
  const file = path.join(dir, 'config.json');
  const original = JSON.stringify({ projects: [{ id: 'p' }], auth_mode: 'local' });
  fs.writeFileSync(file, original);
  const calls = [];
  try {
    await assert.rejects(executeWebSetup(file, { public_url: 'https://example.com', auth_mode: 'github' }, {
      stop: async () => calls.push('stop'), start: async () => calls.push('start'),
      probe: async () => { throw new Error('probe failed'); },
      quiesce: async () => calls.push('quiesce'), restore: async () => calls.push('restore'),
    }), /probe failed/);
    assert.equal(fs.readFileSync(file, 'utf8'), original);
    assert.deepEqual(calls, ['stop', 'start', 'quiesce', 'restore']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a reset during failed setup prevents rollback of revoked grants', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azh-web-reset-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ projects: [{ id: 'old' }], auth_mode: 'local' }));
  const clean = JSON.stringify({ projects: [], auth_mode: 'local' });
  let restored = false;
  try {
    await assert.rejects(executeWebSetup(file, { projects: [{ id: 'old' }], auth_mode: 'github' }, {
      stop: async () => {}, start: async () => {},
      probe: async () => {
        fs.writeFileSync(file, clean);
        fs.writeFileSync(path.join(dir, '.reset-receipt.json'), JSON.stringify({ reset_id: 'a'.repeat(32) }));
        throw new Error('interrupted');
      }, quiesce: async () => {}, restore: async () => { restored = true; },
    }), /重置|恢复初始状态/);
    assert.equal(fs.readFileSync(file, 'utf8'), clean);
    assert.equal(restored, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
