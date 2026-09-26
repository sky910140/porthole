'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');

function prepareWebSetup(current, origin, ownerId) {
  let url;
  try { url = new URL(String(origin).trim()); } catch { throw new Error('请输入有效的 HTTPS 公网地址。'); }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password
      || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('公网地址必须是 HTTPS 根地址，不含路径、账号或参数。');
  }
  const id = String(ownerId).trim();
  if (!/^\d{1,30}$/.test(id)) throw new Error('GitHub 用户 ID 必须是数字。');
  return { ...current, auth_mode: 'github', public_url: url.origin, github_user_ids: [id] };
}

async function resolveGithubOwner(name, fetcher = fetch) {
  const login = String(name).trim();
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(login)) {
    throw new Error('请输入有效的 GitHub 用户名。');
  }
  const response = await fetcher(`https://api.github.com/users/${login}`, {
    headers: { 'User-Agent': 'AI-Zhagan-setup', Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`GitHub 用户查询失败（HTTP ${response.status}），请检查用户名或稍后重试。`);
  const user = await response.json();
  if (!Number.isSafeInteger(user.id) || user.id < 1 || typeof user.login !== 'string') {
    throw new Error('GitHub 返回了无效的用户 ID。');
  }
  return { id: String(user.id), login: user.login };
}

function atomicWrite(file, content) {
  const temporary = `${file}.web-setup-${crypto.randomUUID()}.tmp`;
  try { fs.writeFileSync(temporary, content, { flag: 'wx' }); fs.renameSync(temporary, file); }
  finally { if (fs.existsSync(temporary)) fs.rmSync(temporary); }
}

async function executeWebSetup(file, next, { stop, start, probe, quiesce, restore }) {
  if (fs.lstatSync(file).isSymbolicLink()) throw new Error('本机配置不能是链接。');
  const original = fs.readFileSync(file);
  let stopped = false;
  try {
    await stop();
    stopped = true;
    if (!fs.readFileSync(file).equals(original)) throw new Error('配置在设置过程中发生变化，请重试。');
    atomicWrite(file, Buffer.from(JSON.stringify(next, null, 2)));
    await start();
    await probe();
  } catch (error) {
    if (stopped) {
      try {
        await quiesce();
        atomicWrite(file, original);
        await restore();
      } catch (rollbackError) {
        throw new Error(`网页设置失败且恢复未完成：${error.message}；${rollbackError.message}`, { cause: error });
      }
    }
    throw error;
  }
}

module.exports = { prepareWebSetup, resolveGithubOwner, executeWebSetup };
