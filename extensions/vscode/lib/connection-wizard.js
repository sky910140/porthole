'use strict';
const { validateTunnelId } = require('./private-tunnel');
const { tunnelIssue } = require('./tunnel-checks');

function safeSetupIssue(error) {
  if (error?.code) {
    const issue = tunnelIssue(error.code);
    if (issue.code === error.code) return issue;
  }
  return { code: 'SETUP_FAILED', message: '连接设置未完成。请检查本机服务或安装包后重试。',
    repair: 'retry', retryable: true };
}

class ConnectionWizard {
  constructor({ loadDraft, saveDraft, snapshot, connect, checkLocal, notify }) {
    this.saveDraft = saveDraft; this.snapshot = snapshot; this.connect = connect;
    this.checkLocal = checkLocal; this.notify = notify;
    const draft = loadDraft() || {};
    this.state = { draft: { tunnelId: String(draft.tunnelId || '').slice(0, 80) },
      step: 'form', busy: false, progress: '', issue: null, connection: {}, localCheck: null };
    this.submissionError = null; this.refreshing = null; this.localCheckedAt = 0;
  }

  publish() { this.notify(this.state); }

  async updateDraft(value) {
    if (this.state.busy) return;
    this.state.draft = { tunnelId: String(value?.tunnelId || '').slice(0, 80) };
    await this.saveDraft(this.state.draft);
  }

  async refresh() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      const value = await this.snapshot();
      this.state.connection = value;
      if (!this.state.draft.tunnelId && value.tunnelId) this.state.draft.tunnelId = value.tunnelId;
      if (value.configured && value.projectId && !this.state.busy
          && (this.localProjectId !== value.projectId || Date.now() - this.localCheckedAt > 30000)) {
        await this.runLocalCheck(value.projectId);
      }
      if (!this.state.busy) {
        this.state.issue = this.submissionError || value.issue || this.state.localCheck?.issue || null;
        this.state.step = this.submissionError || !value.configured ? 'form'
          : !value.ready || !this.state.localCheck?.ok ? 'checks'
            : value.verified ? 'done' : value.challengeExpiresAt ? 'verify' : 'chatgpt';
      }
      this.publish();
    })().catch(() => {
      this.state.issue = safeSetupIssue(null); this.publish();
    }).finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  async runLocalCheck(projectId) {
    this.localProjectId = projectId; this.localCheckedAt = Date.now();
    try {
      const result = await this.checkLocal(projectId);
      this.state.localCheck = { ok: result.ok === true, checkedAt: new Date().toISOString() };
    } catch (error) { this.state.localCheck = { ok: false, issue: safeSetupIssue(error) }; }
  }

  async submit(value) {
    if (this.state.busy) return;
    this.state.busy = true; this.state.issue = null; this.submissionError = null;
    try {
      let tunnelId;
      try { tunnelId = validateTunnelId(value?.tunnelId); }
      catch { throw Object.assign(new Error(), { code: 'TUNNEL_CONFIG' }); }
      const apiKey = typeof value?.apiKey === 'string' ? value.apiKey.trim() : '';
      if ((!apiKey && !this.state.connection.hasKey) || (apiKey && (apiKey.length < 12 || /\s/.test(apiKey)))) {
        throw Object.assign(new Error(), { code: 'TUNNEL_CREDENTIALS' });
      }
      const projectId = this.state.connection.projectId;
      if (!projectId) throw Object.assign(new Error(), { code: 'LOCAL_MCP_PROJECT' });
      this.state.draft = { tunnelId };
      await this.saveDraft(this.state.draft);
      this.state.step = 'checks'; this.state.progress = '正在保存并检查连接'; this.publish();
      await this.connect({ tunnelId, apiKey }, (text) => {
        this.state.progress = text; this.publish();
      });
      this.state.progress = '正在检查本机 MCP 和项目授权'; this.publish();
      await this.runLocalCheck(projectId);
    } catch (error) {
      this.submissionError = safeSetupIssue(error);
      this.state.issue = this.submissionError;
      this.state.step = 'form';
    } finally {
      this.state.busy = false; this.state.progress = '';
      await this.refresh();
    }
  }
}

module.exports = { ConnectionWizard, safeSetupIssue };
