'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { loopbackOrigin, readTunnelHealth, issueError } = require('./tunnel-checks');

const execFileAsync = promisify(execFile);
const CLIENT_VERSION = 'v0.0.15';
const ARCHIVE_NAME = `tunnel-client-${CLIENT_VERSION}-windows-amd64.zip`;
const ARCHIVE_SHA256 = '3b53133a1e24d43f63088d843860cb1701a4c3ed6390de2e19f69089e43bddc1';
const ARCHIVE_URL = `https://github.com/openai/tunnel-client/releases/download/${CLIENT_VERSION}/${ARCHIVE_NAME}`;

function digest(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }

function validateTunnelId(value) {
  const id = String(value || '').trim();
  if (!/^tunnel_[0-9a-f]{32}$/.test(id)) throw new Error('Tunnel ID 应为 tunnel_ 后接 32 位小写十六进制字符。');
  return id;
}

function preparePrivateTunnelConfig(current) {
  if (!current || !Array.isArray(current.projects)) throw new Error('本机配置无效。');
  return { ...current, auth_mode: 'local', public_url: null, github_user_ids: [] };
}

function tunnelLaunchSpec({ tunnelId, apiKey, mcpToken, mcpPort, healthFile }) {
  const id = validateTunnelId(tunnelId);
  if (typeof apiKey !== 'string' || apiKey.length < 12 || /\s/.test(apiKey)) {
    throw new Error('OpenAI Platform 运行密钥无效，请粘贴完整 API Key。');
  }
  if (typeof mcpToken !== 'string' || mcpToken.length < 32) throw new Error('本机 MCP 令牌无效。');
  if (!Number.isInteger(mcpPort) || mcpPort < 1024 || mcpPort > 65535) throw new Error('本机 MCP 端口无效。');
  if (typeof healthFile !== 'string' || !path.isAbsolute(healthFile)) throw new Error('隧道状态文件路径无效。');
  return {
    args: ['run', '--health.listen-addr', '127.0.0.1:0', '--health.url-file', healthFile],
    env: {
      CONTROL_PLANE_TUNNEL_ID: id,
      CONTROL_PLANE_API_KEY: apiKey,
      CONTROL_PLANE_BASE_URL: 'https://api.openai.com',
      CONTROL_PLANE_INITIAL_POLL_TIMEOUT: '3s',
      LOG_HTTP_RAW_UNSAFE: 'false',
      ALLOW_REMOTE_UI: 'false',
      MCP_SERVER_URL: `http://127.0.0.1:${mcpPort}/mcp`,
      MCP_EXTRA_HEADERS: 'Authorization: env:PORTHOLE_MCP_AUTH',
      MCP_DISCOVERY_EXTRA_HEADERS: 'Authorization: env:PORTHOLE_MCP_AUTH',
      PORTHOLE_MCP_AUTH: `Bearer ${mcpToken}`,
    },
  };
}

function tunnelProcessEnv(connectionEnv, inherited = process.env) {
  const allowed = /^(PATH|SYSTEMROOT|WINDIR|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|SYSTEMDRIVE|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY)$/i;
  return { ...Object.fromEntries(Object.entries(inherited).filter(([name]) => allowed.test(name))), ...connectionEnv };
}

function findExecutable(root, depth = 0) {
  if (depth > 3) return [];
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error('隧道运行包不允许符号链接。');
    if (entry.isDirectory()) files.push(...findExecutable(full, depth + 1));
    else if (entry.isFile() && entry.name === 'tunnel-client.exe') files.push(full);
  }
  return files;
}

async function extractArchive(directory, archivePath) {
  await execFileAsync('tar.exe', ['-xf', archivePath, '-C', directory], { windowsHide: true });
}

async function installVerifiedArchive(bytes, installDir, { sha256, extract = extractArchive }) {
  if (!Buffer.isBuffer(bytes) || digest(bytes) !== sha256) throw new Error('官方隧道运行包 SHA-256 校验失败。');
  const parent = path.dirname(path.resolve(installDir));
  fs.mkdirSync(parent, { recursive: true });
  const staging = fs.mkdtempSync(path.join(parent, '.tunnel-stage-'));
  const backup = `${path.resolve(installDir)}.backup-${process.pid}-${Date.now()}`;
  let movedOld = false;
  try {
    const archivePath = path.join(staging, ARCHIVE_NAME);
    fs.writeFileSync(archivePath, bytes, { flag: 'wx' });
    const unpacked = path.join(staging, 'unpacked');
    fs.mkdirSync(unpacked);
    await extract(unpacked, archivePath);
    fs.rmSync(archivePath);
    const candidates = findExecutable(unpacked);
    if (candidates.length !== 1 || fs.statSync(candidates[0]).size < 1) {
      throw new Error('官方隧道运行包缺少唯一的 tunnel-client.exe。');
    }
    const relative = path.relative(unpacked, candidates[0]);
    fs.writeFileSync(path.join(unpacked, 'installed.json'), JSON.stringify({
      version: CLIENT_VERSION, archive_sha256: sha256, executable: relative,
      executable_sha256: digest(fs.readFileSync(candidates[0])),
    }));
    if (fs.existsSync(installDir)) {
      if (fs.lstatSync(installDir).isSymbolicLink()) throw new Error('隧道安装目录不能是链接。');
      fs.renameSync(installDir, backup);
      movedOld = true;
    }
    try { fs.renameSync(unpacked, installDir); }
    catch (error) {
      if (movedOld) fs.renameSync(backup, installDir);
      movedOld = false;
      throw error;
    }
    if (movedOld) fs.rmSync(backup, { recursive: true, force: true });
    return path.join(installDir, relative);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

function installedClient(installDir) {
  try {
    if (fs.lstatSync(installDir).isSymbolicLink()) return null;
    const receipt = JSON.parse(fs.readFileSync(path.join(installDir, 'installed.json'), 'utf8'));
    if (receipt.version !== CLIENT_VERSION || receipt.archive_sha256 !== ARCHIVE_SHA256
        || typeof receipt.executable !== 'string' || path.isAbsolute(receipt.executable)
        || receipt.executable.split(/[\\/]/).includes('..')) return null;
    const executable = path.join(installDir, receipt.executable);
    if (fs.lstatSync(executable).isSymbolicLink() || !fs.statSync(executable).isFile()
        || digest(fs.readFileSync(executable)) !== receipt.executable_sha256) return null;
    return executable;
  } catch { return null; }
}

async function downloadPinnedArchive(fetcher = fetch) {
  let response;
  try { response = await fetcher(ARCHIVE_URL, { signal: AbortSignal.timeout(600000) }); }
  catch (error) { throw new Error('无法下载官方隧道客户端。请检查 GitHub 网络连接后重试。', { cause: error }); }
  if (!response.ok) throw new Error(`无法下载官方隧道客户端（HTTP ${response.status}）。`);
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > 40 * 1024 * 1024) throw new Error('官方隧道运行包超过大小限制。');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function bundledArchive(bundleRoot) {
  if (!bundleRoot) return null;
  const archive = path.join(bundleRoot, ARCHIVE_NAME);
  if (!fs.existsSync(archive)) throw new Error('扩展缺少附带隧道运行包，请重新安装完整 VSIX。');
  if (fs.lstatSync(bundleRoot).isSymbolicLink() || fs.lstatSync(archive).isSymbolicLink()) {
    throw new Error('隧道运行包不能是链接。');
  }
  return fs.readFileSync(archive);
}

async function ensureTunnelClient(installDir, { bundleRoot, download = downloadPinnedArchive,
  extract = extractArchive } = {}) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('当前隧道向导仅支持 Windows x64。');
  const ready = installedClient(installDir);
  if (ready) return ready;
  const bytes = bundleRoot ? bundledArchive(bundleRoot) : await download();
  return installVerifiedArchive(bytes, installDir, { sha256: ARCHIVE_SHA256, extract });
}

async function probeTunnelHealth(baseUrl, fetcher = fetch) {
  let origin;
  try { origin = loopbackOrigin(baseUrl); } catch { throw new Error('隧道状态地址不是本机地址。'); }
  const response = await fetcher(`${origin}/readyz`, { signal: AbortSignal.timeout(1500), redirect: 'error' });
  return response.ok;
}

async function startTunnelClient({ executable, tunnelId, apiKey, mcpToken, mcpPort,
  spawnProcess = spawn, probe = probeTunnelHealth, inspect = readTunnelHealth, timeoutMs = 20000 }) {
  const healthDir = fs.mkdtempSync(path.join(os.tmpdir(), 'porthole-tunnel-health-'));
  const healthFile = path.join(healthDir, 'url');
  let child;
  let handle;
  try {
    const { args, env } = tunnelLaunchSpec({ tunnelId, apiKey, mcpToken, mcpPort, healthFile });
    child = spawnProcess(executable, args, {
      windowsHide: true, stdio: 'ignore', env: tunnelProcessEnv(env),
    });
    handle = { child, healthDir, healthUrl: null, running: true, error: null };
    child.once('error', () => { handle.error = '官方隧道客户端无法启动。'; handle.running = false; });
    child.once('exit', (code) => {
      handle.error = code === 0 ? null : `隧道客户端已退出（代码 ${code ?? '未知'}）。`;
      handle.running = false;
    });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!handle.running) throw new Error(handle.error || '隧道客户端提前退出。');
      if (fs.existsSync(healthFile)) {
        const url = fs.readFileSync(healthFile, 'utf8').trim();
        handle.healthUrl = url;
        const state = await inspect(url);
        if (state.issue && !state.issue.retryable) throw issueError(state.issue.code);
        try { if (await probe(url)) return handle; }
        catch { /* Readiness may lag startup. */ }
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error('隧道客户端未就绪；请检查 Tunnel ID、API Key、权限和网络。');
  } catch (error) {
    if (handle) {
      try { await stopTunnelClient(handle); }
      catch (stopError) { throw new Error(`${error.message} ${stopError.message}`, { cause: error }); }
    } else fs.rmSync(healthDir, { recursive: true, force: true });
    throw error;
  }
}

async function stopTunnelClient(handle) {
  if (!handle) return;
  if (handle.child && handle.running) {
    const exited = new Promise((resolve) => handle.child.once('exit', resolve));
    handle.child.kill();
    let timer;
    await Promise.race([exited, new Promise((resolve) => { timer = setTimeout(resolve, 3000); })]);
    clearTimeout(timer);
    if (handle.running) throw new Error('隧道客户端未能停止；为避免重复连接，已取消重新启动。');
  }
  handle.running = false;
  fs.rmSync(handle.healthDir, { recursive: true, force: true });
}

module.exports = { CLIENT_VERSION, ARCHIVE_NAME, ARCHIVE_SHA256, ARCHIVE_URL, validateTunnelId, tunnelLaunchSpec,
  installVerifiedArchive, installedClient, ensureTunnelClient, probeTunnelHealth,
  startTunnelClient, stopTunnelClient, preparePrivateTunnelConfig, bundledArchive, tunnelProcessEnv };
