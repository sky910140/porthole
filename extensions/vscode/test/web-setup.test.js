'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { prepareWebSetup, executeWebSetup, resolveGithubOwner } = require('../lib/web-setup');

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
