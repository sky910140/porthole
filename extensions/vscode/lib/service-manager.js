'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

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
    fs.rmSync(backup, { recursive: true, force: true });
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
  installVerifiedArtifact, validateManifest,
};
