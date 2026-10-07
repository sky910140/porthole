'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { profileGenerationGuard } = require('./profile-edit');

function readJson(file) {
  if (fs.lstatSync(file).isSymbolicLink()) throw new Error('配置文件不能是链接。');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function stateDirectory(configFile, config) {
  const value = config.state_dir || '.local';
  return path.resolve(path.dirname(configFile), value);
}

function oauthEntries(root) {
  if (!fs.existsSync(root)) throw new Error('旧配置没有 OAuth 连接记录。');
  const entries = [];
  let totalSize = 0;
  let directories = 0;
  const walk = (directory, relative = '', depth = 0) => {
    if (fs.lstatSync(directory).isSymbolicLink()) throw new Error('OAuth 连接记录包含链接。');
    if (++directories > 100 || depth > 4) throw new Error('OAuth 连接记录目录层级超出限制。');
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const child = path.join(directory, item.name);
      const name = path.join(relative, item.name);
      const stat = fs.lstatSync(child);
      if (stat.isSymbolicLink()) throw new Error('OAuth 连接记录包含链接。');
      if (stat.isDirectory()) { walk(child, name, depth + 1); continue; }
      if (!stat.isFile() || !name.endsWith('.json')) throw new Error('OAuth 连接记录包含不支持的文件。');
      totalSize += stat.size;
      if (stat.size > 4 * 1024 * 1024 || totalSize > 64 * 1024 * 1024 || entries.length >= 5000) {
        throw new Error('OAuth 连接记录超出迁移大小限制。');
      }
      entries.push(name);
    }
  };
  walk(root);
  return entries;
}

function checkFernetRecord(record, secret) {
  const envelope = record && record.value;
  if (!envelope || envelope.__encryption_version__ !== 1 || typeof envelope.__encrypted_data__ !== 'string') {
    throw new Error('旧 OAuth 记录格式不支持自动迁移。');
  }
  const encoded = Buffer.from(envelope.__encrypted_data__, 'base64').toString('utf8');
  const signed = Buffer.from(encoded, 'base64url');
  if (signed.length < 57 || signed[0] !== 0x80) throw new Error('旧 OAuth 记录损坏。');
  const material = crypto.hkdfSync('sha256', Buffer.from(secret), Buffer.from('project-mcp-storage'), Buffer.from('Fernet'), 32);
  const signature = signed.subarray(-32);
  const digest = crypto.createHmac('sha256', Buffer.from(material).subarray(0, 16)).update(signed.subarray(0, -32)).digest();
  if (!crypto.timingSafeEqual(signature, digest)) {
    throw new Error('原 GitHub Client Secret 与旧 OAuth 记录不匹配。请使用创建旧连接时的原密钥；若原密钥已丢失，请创建新连接并在 ChatGPT 重新授权。');
  }
}

function prepareMigration(sourceConfig, targetConfig, secret) {
  const sourceFile = path.resolve(sourceConfig);
  const targetFile = path.resolve(targetConfig);
  if (sourceFile.toLowerCase() === targetFile.toLowerCase()) throw new Error('旧配置和当前配置不能相同。');
  if (!secret || typeof secret !== 'string') throw new Error('需要原 GitHub Client Secret。');
  const source = readJson(sourceFile);
  const target = readJson(targetFile);
  const publicUrl = String(source.public_url || '');
  let parsed;
  try { parsed = new URL(publicUrl); } catch { throw new Error('旧配置缺少有效的 HTTPS 网页地址。'); }
  if (source.auth_mode !== 'github' || parsed.protocol !== 'https:' || parsed.origin !== publicUrl
      || parsed.username || parsed.password || !Array.isArray(source.github_user_ids)
      || !source.github_user_ids.length || source.github_user_ids.some((id) => !/^\d+$/.test(String(id)))) {
    throw new Error('旧配置必须启用 GitHub OAuth，并包含 HTTPS 地址和数字 GitHub 用户 ID。');
  }
  if (target.auth_mode === 'github') throw new Error('当前服务已有网页 OAuth 配置，请先核对现有连接。');
  const sourceState = stateDirectory(sourceFile, source);
  const targetState = stateDirectory(targetFile, target);
  if (fs.lstatSync(sourceState).isSymbolicLink() || fs.lstatSync(targetState).isSymbolicLink()) {
    throw new Error('OAuth 状态目录不能是链接。');
  }
  const sourceOAuth = path.join(sourceState, 'oauth');
  const targetOAuth = path.join(targetState, 'oauth');
  if (sourceOAuth.toLowerCase() === targetOAuth.toLowerCase()) throw new Error('旧连接和新连接使用了同一状态目录。');
  if (fs.existsSync(targetOAuth) && oauthEntries(targetOAuth).length) {
    throw new Error('当前服务已有 OAuth 记录，自动迁移不会覆盖。');
  }
  const entries = oauthEntries(sourceOAuth);
  let recordCount = 0;
  for (const relative of entries) {
    const record = readJson(path.join(sourceOAuth, relative));
    if (relative.endsWith('-info.json') && !relative.includes(path.sep)) {
      const collection = relative.slice(0, -'-info.json'.length);
      const expected = path.join(sourceOAuth, collection);
      if (!record.directory || path.resolve(record.directory).toLowerCase() !== expected.toLowerCase()
          || !fs.existsSync(expected)) {
        throw new Error('旧 OAuth 集合索引目录无效，不能安全迁移。');
      }
      continue;
    }
    if (Object.hasOwn(record, 'value')) {
      const collection = relative.split(path.sep)[0];
      if (!entries.includes(`${collection}-info.json`)) {
        throw new Error('旧 OAuth 连接记录缺少集合索引。');
      }
      checkFernetRecord(record, secret);
      recordCount += 1;
    }
  }
  if (!recordCount) throw new Error('旧配置没有可复用的 OAuth 连接记录。');
  return { sourceFile, targetFile, sourceOAuth, targetOAuth, entries, recordCount,
    nextConfig: { ...target, auth_mode: 'github', public_url: publicUrl,
      github_user_ids: source.github_user_ids.map(String) } };
}

function atomicWrite(file, bytes) {
  const temporary = `${file}.migration-${crypto.randomUUID()}.tmp`;
  try { fs.writeFileSync(temporary, bytes, { flag: 'wx' }); fs.renameSync(temporary, file); }
  finally { if (fs.existsSync(temporary)) fs.rmSync(temporary); }
}

async function executeMigration(plan, { stop, start, quiesce = async () => {}, restore,
  guard = profileGenerationGuard(plan.targetFile) }) {
  guard();
  const originalConfig = fs.readFileSync(plan.targetFile);
  const suffix = `.migration-${crypto.randomUUID()}`;
  const staging = `${plan.targetOAuth}${suffix}.stage`;
  const backup = `${plan.targetOAuth}${suffix}.backup`;
  let oldOAuthMoved = false;
  let newOAuthInstalled = false;
  let stopped = false;
  try {
    fs.mkdirSync(staging, { recursive: true });
    for (const relative of plan.entries) {
      const source = path.join(plan.sourceOAuth, relative);
      if (!fs.lstatSync(source).isFile()) throw new Error('旧 OAuth 记录在迁移时已变化。');
      const destination = path.join(staging, relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      if (relative.endsWith('-info.json') && !relative.includes(path.sep)) {
        const metadata = readJson(source);
        metadata.directory = path.join(plan.targetOAuth, relative.slice(0, -'-info.json'.length));
        fs.writeFileSync(destination, JSON.stringify(metadata), { flag: 'wx' });
      } else fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
    }
    stopped = true;
    await stop();
    guard();
    if (fs.existsSync(plan.targetOAuth)) {
      if (oauthEntries(plan.targetOAuth).length) throw new Error('当前 OAuth 记录在迁移时已变化。');
      fs.renameSync(plan.targetOAuth, backup);
      oldOAuthMoved = true;
    }
    fs.renameSync(staging, plan.targetOAuth);
    newOAuthInstalled = true;
    atomicWrite(plan.targetFile, Buffer.from(JSON.stringify(plan.nextConfig, null, 2)));
    await start();
    guard();
    if (oldOAuthMoved) fs.rmSync(backup, { recursive: true, force: true });
    return { recordCount: plan.recordCount, publicUrl: plan.nextConfig.public_url };
  } catch (error) {
    guard();
    try {
      if (stopped) await quiesce();
      guard();
      atomicWrite(plan.targetFile, originalConfig);
      if (newOAuthInstalled) fs.rmSync(plan.targetOAuth, { recursive: true, force: true });
      if (oldOAuthMoved) fs.renameSync(backup, plan.targetOAuth);
      if (stopped) await restore();
    } catch (rollbackError) {
      throw new Error(`迁移失败且恢复未完成：${error.message}；${rollbackError.message}`, { cause: error });
    }
    throw error;
  } finally {
    if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
  }
}

async function managedStatus(configFile, fetcher = fetch) {
  try {
    const config = readJson(configFile);
    const state = stateDirectory(configFile, config);
    const tokens = readJson(path.join(state, 'tokens.json'));
    const response = await fetcher(`http://127.0.0.1:${config.admin_port}/api/status`, {
      headers: { Authorization: `Bearer ${tokens.admin_token}` }, signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) return null;
    const status = await response.json();
    const expected = crypto.createHash('sha256').update(path.resolve(configFile)).digest('hex');
    return status.config_id === expected && /^1\./.test(status.protocol_version || '')
      && status.mcp_port === config.mcp_port && status.auth_mode === config.auth_mode
      && (status.public_url || null) === (config.public_url || null) ? status : null;
  } catch { return null; }
}

module.exports = { prepareMigration, executeMigration, managedStatus };
