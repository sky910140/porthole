'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function renameWithRetry(source, destination, {
  rename = fs.renameSync,
  sleep = (milliseconds) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds),
} = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try { return rename(source, destination); }
    catch (error) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 6) throw error;
      sleep(50 * (attempt + 1));
    }
  }
}

function bundleEntryPath(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0')
      || value.startsWith('/') || value.split('/').some((part) => !part || part === '.' || part === '..'
        || /[\x00-\x1f<>:"\\|?*]/.test(part) || /[. ]$/.test(part)
        || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new Error('运行包清单包含无效文件路径。');
  }
  return value;
}

function validateBundle(bundleRoot, expectedVersion) {
  const manifestBytes = fs.readFileSync(path.join(bundleRoot, 'bundle.json'));
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (manifest.version !== expectedVersion) throw new Error('运行包版本与扩展版本不匹配。');
  if (manifest.platform !== process.platform || manifest.architecture !== process.arch) {
    throw new Error('运行包与当前系统架构不匹配。');
  }
  const range = String(manifest.protocol_range || '');
  if (!range.includes('>=1.') || !range.includes('<2.')) {
    throw new Error('VERSION_INCOMPATIBLE：运行包协议主版本不兼容。');
  }
  if (!Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 10000) {
    throw new Error('运行包清单缺少有效文件列表。');
  }
  const names = new Set();
  let totalBytes = 0;
  for (const entry of manifest.files) {
    const relative = bundleEntryPath(entry.path);
    const comparable = relative.toLowerCase();
    if (names.has(comparable)) throw new Error('运行包清单包含重复文件路径。');
    names.add(comparable);
    if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > 256 * 1024 * 1024
        || !/^[a-f0-9]{64}$/i.test(entry.sha256)) {
      throw new Error('运行包清单缺少有效大小或 SHA-256。');
    }
    totalBytes += entry.size;
    if (totalBytes > 512 * 1024 * 1024) throw new Error('运行包超出大小限制。');
  }
  if (!names.has('ai-zhagan.exe')) throw new Error('运行包缺少主程序。');
  return { manifest, manifestHash: sha256(manifestBytes) };
}

function checkedBundleFile(root, relative, entry) {
  let current = root;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error('运行包不允许符号链接。');
  }
  const stat = fs.statSync(current);
  if (!stat.isFile() || stat.size !== entry.size || sha256(fs.readFileSync(current)) !== entry.sha256.toLowerCase()) {
    throw new Error(`运行包文件校验失败：${relative}`);
  }
  return current;
}

function installedBundleHealthy(installRoot, entries, manifestHash) {
  try {
    if (fs.lstatSync(installRoot).isSymbolicLink()) return false;
    const receipt = JSON.parse(fs.readFileSync(path.join(installRoot, 'installed.json'), 'utf8'));
    if (receipt.manifest_sha256 !== manifestHash) return false;
    for (const entry of entries) checkedBundleFile(installRoot, entry.path, entry);
    return true;
  } catch { return false; }
}

function installBundledRuntime(bundleRoot, installRoot, expectedVersion) {
  const { manifest, manifestHash } = validateBundle(bundleRoot, expectedVersion);
  const executable = path.join(installRoot, 'ai-zhagan.exe');
  if (installedBundleHealthy(installRoot, manifest.files, manifestHash)) return executable;
  const parent = path.dirname(installRoot);
  fs.mkdirSync(parent, { recursive: true });
  const staging = fs.mkdtempSync(path.join(parent, '.ai-zhagan-stage-'));
  const backup = `${installRoot}.backup-${process.pid}-${Date.now()}`;
  const previous = `${installRoot}.previous`;
  let movedExisting = false;
  try {
    const sourceRoot = path.join(bundleRoot, 'payload');
    for (const entry of manifest.files) {
      const source = checkedBundleFile(sourceRoot, entry.path, entry);
      const destination = path.join(staging, ...entry.path.split('/'));
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(source, destination);
      checkedBundleFile(staging, entry.path, entry);
    }
    fs.writeFileSync(path.join(staging, 'installed.json'), JSON.stringify({
      version: expectedVersion, manifest_sha256: manifestHash,
      installed_at: new Date().toISOString(),
    }));
    if (fs.existsSync(installRoot)) {
      if (fs.lstatSync(installRoot).isSymbolicLink()) throw new Error('现有安装目录不能是链接。');
      if (fs.existsSync(previous)) fs.rmSync(previous, { recursive: true, force: true });
      renameWithRetry(installRoot, backup);
      movedExisting = true;
    }
    try { renameWithRetry(staging, installRoot); }
    catch (error) {
      if (movedExisting) renameWithRetry(backup, installRoot);
      throw error;
    }
    if (movedExisting) {
      try { renameWithRetry(backup, previous); }
      catch (error) {
        renameWithRetry(installRoot, staging);
        renameWithRetry(backup, installRoot);
        throw error;
      }
    }
    return executable;
  } finally {
    if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
  }
}

function validateManifest(manifest, options) {
  if (!manifest || manifest.version !== options.version) throw new Error('运行包版本与请求版本不匹配。');
  const artifact = manifest.artifacts && manifest.artifacts[`${options.platform}-${options.arch}`];
  if (!artifact) throw new Error(`运行包不支持当前架构 ${options.platform}-${options.arch}。`);
  const range = String(manifest.protocol_range || '');
  if (!range.includes(`>=${options.protocolMajor}.`) || !range.includes(`<${options.protocolMajor + 1}.`)) {
    throw new Error('VERSION_INCOMPATIBLE：运行包协议主版本不兼容。');
  }
  const url = new URL(artifact.url);
  if (!(options.trustedOrigins || []).includes(url.origin)) throw new Error('运行包不来自受信发布源。');
  if (!/^[a-f0-9]{64}$/i.test(artifact.sha256) || !Number.isSafeInteger(artifact.size) || artifact.size < 1) {
    throw new Error('运行包清单缺少有效的大小或 SHA-256。');
  }
  return artifact;
}

function installVerifiedArtifact(downloadPath, installPath, artifact, extract) {
  const bytes = fs.readFileSync(downloadPath);
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  if (bytes.length !== artifact.size || digest !== artifact.sha256.toLowerCase()) {
    throw new Error('运行包大小或 SHA-256 校验失败。');
  }
  const parent = path.dirname(installPath);
  fs.mkdirSync(parent, { recursive: true });
  const staging = `${installPath}.staging-${process.pid}-${Date.now()}`;
  const backup = `${installPath}.backup-${process.pid}-${Date.now()}`;
  const previous = `${installPath}.previous`;
  fs.rmSync(staging, { recursive: true, force: true });
  try {
    extract(downloadPath, staging);
    if (!fs.statSync(staging).isDirectory()) throw new Error('解压结果不是目录。');
    if (fs.existsSync(installPath)) fs.renameSync(installPath, backup);
    try { fs.renameSync(staging, installPath); }
    catch (error) {
      if (fs.existsSync(backup)) fs.renameSync(backup, installPath);
      throw error;
    }
    if (fs.existsSync(backup)) {
      fs.rmSync(previous, { recursive: true, force: true });
      fs.renameSync(backup, previous);
    }
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  return installPath;
}

class RestartPolicy {
  constructor({ now = Date.now, windowMs = 300000, maxCrashes = 3 } = {}) {
    this.now = now; this.windowMs = windowMs; this.maxCrashes = maxCrashes;
    this.crashes = []; this.paused = false;
  }
  recordCrash() {
    const cutoff = this.now() - this.windowMs;
    this.crashes = this.crashes.filter((stamp) => stamp >= cutoff);
    this.crashes.push(this.now());
    if (this.crashes.length >= this.maxCrashes) this.paused = true;
    return !this.paused;
  }
  recordNetworkLoss() { return false; }
  canRestart() { return !this.paused; }
  pause() { this.paused = true; }
  resume() { this.paused = false; this.crashes = []; }
}

class ReconnectBackoff {
  constructor({
    random = Math.random,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = {}) {
    this.random = random;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.attempt = 0;
    this.timer = null;
    this.paused = false;
    this.authBlocked = false;
  }
  nextDelayMs() {
    const base = Math.min(30000, 1000 * (2 ** Math.min(this.attempt, 5)));
    this.attempt += 1;
    return Math.min(30000, Math.round(base * (1 + (0.2 * this.random()))));
  }
  schedule(callback) {
    if (this.paused || this.authBlocked || this.timer !== null) return null;
    const delay = this.nextDelayMs();
    const timer = this.setTimer(() => {
      if (this.timer !== timer) return;
      this.timer = null;
      if (!this.paused && !this.authBlocked) callback();
    }, delay);
    this.timer = timer;
    return timer;
  }
  cancel() {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }
  pause() { this.paused = true; this.cancel(); }
  resume() { this.paused = false; }
  authenticationFailed() { this.authBlocked = true; this.cancel(); }
  resetAfterWake() {
    this.cancel(); this.attempt = 0; this.paused = false; this.authBlocked = false;
  }
}

class ServiceManager {
  constructor({ status, launch, allowExternal = false, runtimeRoot, loadManifest, download, extract, trustedOrigins = [] }) {
    this.status = status; this.launch = launch; this.allowExternal = allowExternal;
    this.runtimeRoot = runtimeRoot; this.loadManifest = loadManifest; this.download = download;
    this.extract = extract; this.trustedOrigins = trustedOrigins;
    this.starting = null; this.closed = false;
  }
  async ensureRuntime(version) {
    if (!this.runtimeRoot) throw new Error('尚未配置受管理运行包目录。');
    const current = path.join(this.runtimeRoot, 'current');
    const receipt = path.join(current, 'installed.json');
    try {
      const installed = JSON.parse(fs.readFileSync(receipt, 'utf8'));
      if (installed.version === version && fs.existsSync(path.join(current, 'ai-zhagan.exe'))) return current;
    } catch { /* Install or repair below. */ }
    if (!this.loadManifest || !this.download || !this.extract) {
      throw new Error('离线首次启动无法安装运行包；请联网重试或明确选择已有服务。');
    }
    const manifest = await this.loadManifest(version);
    const artifact = validateManifest(manifest, {
      version, platform: process.platform, arch: process.arch,
      protocolMajor: 1, trustedOrigins: this.trustedOrigins,
    });
    const downloadPath = await this.download(artifact.url);
    installVerifiedArtifact(downloadPath, current, artifact, this.extract);
    fs.writeFileSync(path.join(current, 'installed.json'), JSON.stringify({
      version, sha256: artifact.sha256, installed_at: new Date().toISOString(),
    }));
    return current;
  }
  async ensureService() {
    if (this.closed) throw new Error('当前窗口已关闭，不能启动本机服务。');
    const running = await this.status();
    if (running) return running;
    if (!this.starting) {
      this.starting = (async () => {
        await this.launch();
        const result = await this.status();
        if (!result) throw new Error('本机服务启动失败，请打开服务日志。');
        return result;
      })().finally(() => { this.starting = null; });
    }
    return this.starting;
  }
  async useExternalService(serviceUrl) {
    if (!this.allowExternal) throw new Error('必须明确选择后才能复用外部服务。');
    return { serviceUrl, managed: false };
  }
  closeWindow() { this.closed = true; }
}

async function ensureRuntime(version, options) {
  return new ServiceManager(options).ensureRuntime(version);
}

async function ensureService(options) {
  return new ServiceManager(options).ensureService();
}

module.exports = {
  ReconnectBackoff, RestartPolicy, ServiceManager, ensureRuntime, ensureService,
  installVerifiedArtifact, installBundledRuntime, renameWithRetry, validateManifest,
};
