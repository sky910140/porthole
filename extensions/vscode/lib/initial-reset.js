'use strict';
const fs = require('node:fs');
const path = require('node:path');

const STEP_LABELS = {
  preflight: '检查是否可以重置', suspend: '暂停后台连接任务',
  disableStartup: '关闭开机启动', stopTunnel: '停止私有隧道',
  resetCore: '清除本机授权和凭据', clearExtension: '清除 VS Code 连接设置',
  verify: '检查恢复结果',
};
const MESSAGES = {
  RESET_BUSY: '正在配置连接、应用修改、恢复文件或升级。请完成或取消这些操作后再恢复初始状态。',
  RESET_INCOMPATIBLE: '当前服务不支持安全重置。请先点击“检查并安装附带版本”，然后重试。',
  RESET_UNSAFE_PATH: '本机状态路径包含链接。请检查安装位置后重试。',
  RESET_PENDING: '上次恢复被中断，请点击“继续恢复初始状态”。',
  RESET_PORT_IN_USE: '服务端口被未确认的进程占用。请先停止旧服务，再重试。',
  RESET_STOP_FAILED: '本机服务尚未完全停止。请稍后点击“继续恢复初始状态”。',
  RESET_CONFIG_UNAVAILABLE: '本机配置无法读取。请检查配置后重试。',
  RESET_STATE_UNAVAILABLE: '本机恢复状态无法读取。请检查诊断说明后重试。',
  RESET_VAULT_UNAVAILABLE: '系统凭据尚未清除。请解除凭据访问限制后继续恢复。',
  RESET_FAILED: '此步骤未完成，已保留恢复进度。点击“继续恢复初始状态”重试。',
};
const PRESERVED_KEYS = new Set(['porthole.resetPending', 'porthole.resetResult',
  'porthole.resetSeenId', 'porthole.resetCleanup', 'porthole.manualServiceStop', 'porthole.manualTunnelStop']);
const ACCOUNT_KEYS = ['porthole.managedAdminToken', 'porthole.githubClientId',
  'porthole.githubClientSecret', 'porthole.privateTunnelApiKey'];

function safeResetIssue(error) {
  const code = Object.hasOwn(MESSAGES, error?.code) ? error.code : 'RESET_FAILED';
  return { code, message: MESSAGES[code] };
}

function visibleResetState(state, activelyRunning = false) {
  if (state?.phase !== 'running' || activelyRunning) return state;
  return { ...state, phase: 'failed', issue: safeResetIssue({ code: 'RESET_PENDING' }) };
}

function collectResetKeys({ globalKeys = [], knownSecretKeys = [], folderUris = [] }) {
  return {
    globalKeys: globalKeys.filter((key) => key.startsWith('porthole.') && !PRESERVED_KEYS.has(key)),
    secretKeys: [...new Set([...ACCOUNT_KEYS,
      ...knownSecretKeys.filter((key) => key.startsWith('porthole.')),
      ...folderUris.map((uri) => `porthole.token:${uri}`)])],
  };
}

function mergeResetKeys(saved, current) {
  return collectResetKeys({ globalKeys: [...new Set([...(saved?.globalKeys || []), ...current.globalKeys])],
    knownSecretKeys: [...new Set([...(saved?.secretKeys || []), ...current.secretKeys])] });
}

async function observeResetReceipt(receipt, { observedId, clear, ack, failed }) {
  if (!receipt || receipt.reset_id === observedId) return false;
  try { await clear(); await ack(receipt.reset_id); return true; }
  catch { await failed(receipt.reset_id); return false; }
}

function readResetFiles(configPath) {
  const parent = path.dirname(configPath);
  const marker = path.join(parent, '.reset-in-progress.json');
  const receiptPath = path.join(parent, '.reset-receipt.json');
  let pending = fs.existsSync(marker);
  let receipt = null;
  try {
    if (fs.existsSync(receiptPath)) {
      if (fs.lstatSync(receiptPath).isSymbolicLink()) return { pending: true, receipt: null };
      const value = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
      if (!/^[a-f0-9]{32}$/.test(value.reset_id)) return { pending: true, receipt: null };
      receipt = { reset_id: value.reset_id, completed_at: String(value.completed_at || '') };
    }
  } catch { pending = true; }
  return { pending, receipt };
}

class InitialReset {
  constructor(options) {
    this.options = options;
    const saved = visibleResetState(options.load()) || {};
    const phase = ['running', 'failed', 'complete'].includes(saved.phase) ? saved.phase : 'idle';
    this.state = { phase, step: Object.hasOwn(STEP_LABELS, saved.step) ? saved.step : 'preflight',
      resetId: /^[a-f0-9]{32}$/.test(saved.resetId) ? saved.resetId : null,
      external: { chatgpt: Boolean(saved.external?.chatgpt), github: Boolean(saved.external?.github),
        openai: Boolean(saved.external?.openai) }, issue: null };
    this.running = null;
  }

  publish() { this.options.notify({ ...this.state, label: STEP_LABELS[this.state.step] }); }

  run() {
    if (this.running) return this.running;
    if (this.state.phase === 'complete') return Promise.resolve(this.state);
    this.running = this.execute().finally(() => { this.running = null; });
    return this.running;
  }

  async execute() {
    const continuing = ['running', 'failed'].includes(this.state.phase);
    if (!continuing && !await this.options.confirm()) return this.state;
    this.state.step = 'preflight'; this.state.issue = null;
    try {
      const checked = await this.options.preflight();
      if (checked?.external) this.state.external = {
        chatgpt: Boolean(checked.external.chatgpt), github: Boolean(checked.external.github),
        openai: Boolean(checked.external.openai),
      };
    } catch (error) {
      this.state.phase = continuing ? 'failed' : 'blocked';
      this.state.issue = safeResetIssue(error);
      if (continuing) await this.options.save(this.state);
      this.publish(); return this.state;
    }
    this.state.phase = 'running';
    try {
      for (const step of ['suspend', 'disableStartup', 'stopTunnel', 'resetCore', 'clearExtension', 'verify']) {
        this.state.step = step;
        await this.options.save(this.state);
        this.publish();
        const result = await this.options[step]();
        if (step === 'resetCore') {
          if (result?.local_reset !== true || !/^[a-f0-9]{32}$/.test(result.reset_id)) {
            throw new Error('Invalid local reset receipt');
          }
          this.state.resetId = result.reset_id;
        }
      }
      this.state.phase = 'complete';
      await this.options.save(this.state);
    } catch (error) {
      this.state.phase = 'failed';
      this.state.issue = safeResetIssue(error);
      // A storage failure must not turn into an apparent successful reset.
      try { await this.options.save(this.state); } catch { /* Core journal remains authoritative. */ }
    }
    this.publish(); return this.state;
  }
}

module.exports = { InitialReset, collectResetKeys, mergeResetKeys, observeResetReceipt,
  readResetFiles, safeResetIssue, visibleResetState };
