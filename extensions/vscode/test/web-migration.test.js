'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { prepareMigration, executeMigration, managedStatus } = require('../lib/web-migration');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'porthole-migrate-'));
  const oldState = path.join(root, 'old-state');
  const newState = path.join(root, 'new-state');
  const oldConfig = path.join(root, 'old.json');
  const newConfig = path.join(root, 'new.json');
  fs.mkdirSync(path.join(oldState, 'oauth'), { recursive: true });
  fs.mkdirSync(newState, { recursive: true });
  fs.writeFileSync(oldConfig, JSON.stringify({ auth_mode: 'github', public_url: 'https://example.test',
    github_user_ids: ['123'], state_dir: oldState }));
  fs.writeFileSync(newConfig, JSON.stringify({ auth_mode: 'local', public_url: null,
    github_user_ids: [], state_dir: newState, mcp_port: 8765, projects: [{ id: 'current', root }] }));
  fs.writeFileSync(path.join(newState, 'tokens.json'), '{"admin_token":"new-token"}');
  const secret = 'test-github-secret';
  const key = crypto.hkdfSync('sha256', Buffer.from(secret), Buffer.from('project-mcp-storage'), Buffer.from('Fernet'), 32);
  const token = Buffer.concat([Buffer.from([0x80]), Buffer.alloc(8), crypto.randomBytes(16), Buffer.from('cipher')]);
  const signed = Buffer.concat([token, crypto.createHmac('sha256', Buffer.from(key).subarray(0, 16)).update(token).digest()]);
  const wrapped = Buffer.from(signed.toString('base64url')).toString('base64');
  fs.mkdirSync(path.join(oldState, 'oauth', 'mcp-oauth-proxy-clients'));
  fs.writeFileSync(path.join(oldState, 'oauth', 'mcp-oauth-proxy-clients-info.json'), JSON.stringify({
    version: 1, collection: 'mcp-oauth-proxy-clients',
    directory: path.join(oldState, 'oauth', 'mcp-oauth-proxy-clients'), created_at: new Date().toISOString(),
  }));
  fs.writeFileSync(path.join(oldState, 'oauth', 'mcp-oauth-proxy-clients', 'client.json'), JSON.stringify({
    value: { __encrypted_data__: wrapped, __encryption_version__: 1 },
  }));
  return { root, oldState, newState, oldConfig, newConfig, secret };
}

test('preflight validates old OAuth secret and preserves new project and tokens', () => {
  const f = fixture();
  try {
    assert.throws(() => prepareMigration(f.oldConfig, f.newConfig, 'wrong'),
      /原.*Client Secret.*新连接/);
    const plan = prepareMigration(f.oldConfig, f.newConfig, f.secret);
    assert.equal(plan.recordCount, 1);
    assert.deepEqual(plan.nextConfig.projects, [{ id: 'current', root: f.root }]);
    assert.equal(plan.nextConfig.public_url, 'https://example.test');
    assert.equal(fs.readFileSync(path.join(f.newState, 'tokens.json'), 'utf8'), '{"admin_token":"new-token"}');
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('migration imports OAuth state and rolls back when restart fails', async () => {
  const f = fixture();
  try {
    const plan = prepareMigration(f.oldConfig, f.newConfig, f.secret);
    let stops = 0;
    const rollbackOrder = [];
    await assert.rejects(executeMigration(plan, {
      stop: async () => { stops += 1; },
      start: async () => { throw new Error('port busy'); },
      quiesce: async () => { rollbackOrder.push(JSON.parse(fs.readFileSync(f.newConfig)).auth_mode); },
      restore: async () => { rollbackOrder.push(JSON.parse(fs.readFileSync(f.newConfig)).auth_mode); },
    }), /port busy/);
    assert.equal(stops, 1);
    assert.deepEqual(rollbackOrder, ['github', 'local']);
    assert.equal(JSON.parse(fs.readFileSync(f.newConfig)).auth_mode, 'local');
    assert.equal(fs.existsSync(path.join(f.newState, 'oauth')), false);
    assert.equal(fs.existsSync(path.join(f.oldState, 'oauth', 'mcp-oauth-proxy-clients', 'client.json')), true);
    await executeMigration(plan, { stop: async () => {}, start: async () => {}, restore: async () => {} });
    assert.equal(JSON.parse(fs.readFileSync(f.newConfig)).auth_mode, 'github');
    assert.equal(fs.existsSync(path.join(f.newState, 'oauth', 'mcp-oauth-proxy-clients', 'client.json')), true);
    const metadata = JSON.parse(fs.readFileSync(path.join(f.newState, 'oauth', 'mcp-oauth-proxy-clients-info.json')));
    assert.equal(metadata.directory, path.join(f.newState, 'oauth', 'mcp-oauth-proxy-clients'));
    assert.equal(fs.readFileSync(path.join(f.newState, 'tokens.json'), 'utf8'), '{"admin_token":"new-token"}');
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('preflight rejects symlinked OAuth state', () => {
  const f = fixture();
  try {
    const oauth = path.join(f.oldState, 'oauth');
    fs.renameSync(oauth, `${oauth}-real`);
    fs.symlinkSync(`${oauth}-real`, oauth, 'junction');
    assert.throws(() => prepareMigration(f.oldConfig, f.newConfig, f.secret), /链接/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('preflight refuses to overwrite OAuth state already held by the new service', () => {
  const f = fixture();
  try {
    const target = path.join(f.newState, 'oauth');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'existing.json'), '{}');
    assert.throws(() => prepareMigration(f.oldConfig, f.newConfig, f.secret), /不会覆盖/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('managed status rejects another config on the same port', async () => {
  const f = fixture();
  try {
    const expected = crypto.createHash('sha256').update(fs.realpathSync.native(f.newConfig)).digest('hex');
    const fetcher = async (_url, options) => {
      assert.equal(options.headers.Authorization, 'Bearer new-token');
      return { ok: true, json: async () => ({ config_id: 'another', protocol_version: '1.0.0',
        mcp_port: 8765, auth_mode: 'local', public_url: null }) };
    };
    assert.equal(await managedStatus(f.newConfig, fetcher), null);
    assert.equal(await managedStatus(f.newConfig, async () => ({ ok: true,
      json: async () => ({ config_id: expected, mcp_port: 8765, auth_mode: 'local' }) })), null);
    assert.equal((await managedStatus(f.newConfig, async () => ({ ok: true,
      json: async () => ({ config_id: expected, protocol_version: '1.0.0',
        mcp_port: 8765, auth_mode: 'local', public_url: null }) }))).config_id, expected);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('managed status resolves directory aliases before checking the service identity', async () => {
  const f = fixture();
  const directory = path.join(f.root, 'profile-directory');
  const alias = path.join(f.root, 'profile-alias');
  fs.mkdirSync(directory);
  const configFile = path.join(directory, 'config.json');
  fs.renameSync(f.newConfig, configFile);
  fs.symlinkSync(directory, alias, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    const expected = crypto.createHash('sha256').update(fs.realpathSync.native(configFile)).digest('hex');
    const status = await managedStatus(path.join(alias, 'config.json'), async () => ({ ok: true,
      json: async () => ({ config_id: expected, protocol_version: '1.0.0',
        mcp_port: 8765, auth_mode: 'local', public_url: null }) }));
    assert.ok(status, 'the extension must identify the same canonical config path as the backend');
    assert.equal(status.config_id, expected);
  } finally {
    fs.unlinkSync(alias);
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('migration rollback cannot restore grants after another window resets', async () => {
  const f = fixture();
  try {
    const plan = prepareMigration(f.oldConfig, f.newConfig, f.secret);
    const clean = JSON.stringify({ projects: [], auth_mode: 'local' });
    let restored = false;
    await assert.rejects(executeMigration(plan, {
      stop: async () => {},
      start: async () => {
        fs.writeFileSync(f.newConfig, clean);
        fs.rmSync(plan.targetOAuth, { recursive: true, force: true });
        fs.writeFileSync(path.join(path.dirname(f.newConfig), '.reset-receipt.json'),
          JSON.stringify({ reset_id: 'b'.repeat(32) }));
        throw new Error('interrupted');
      }, quiesce: async () => {}, restore: async () => { restored = true; },
    }), /重置|恢复初始状态/);
    assert.equal(fs.readFileSync(f.newConfig, 'utf8'), clean);
    assert.equal(fs.existsSync(plan.targetOAuth), false);
    assert.equal(restored, false);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
