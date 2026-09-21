'use strict';

const path = require('node:path');

const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_DIAGNOSTICS = 100;
const MAX_DIAGNOSTIC_SEVERITY_LENGTH = 20;
const MAX_DIAGNOSTIC_MESSAGE_LENGTH = 4096;
const MAX_SELECTION_TEXT_LENGTH = 262144;
const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost']);

function normalizeServiceUrl(value, options = {}) {
  let url;
  try {
    url = new URL(String(value).trim());
  } catch {
    throw new Error('请输入有效的本机服务地址。');
  }
  const port = Number(url.port);
  const validPort = options.allowTestPort || (Number.isInteger(port) && port >= 1024 && port <= 65535);
  if (url.protocol !== 'http:' || !ALLOWED_HOSTS.has(url.hostname) || !validPort || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('本机服务地址仅允许 http://127.0.0.1:<1024-65535> 或 http://localhost:<1024-65535>。');
  }
  return url.origin;
}

function relativeWorkspacePath(rootPath, filePath) {
  const relativePath = path.relative(path.resolve(rootPath), path.resolve(filePath));
  if (!relativePath || relativePath === '.' || relativePath.startsWith(`..${path.sep}`) || relativePath === '..' || path.isAbsolute(relativePath)) {
    throw new Error('当前编辑器不是绑定的工作区内的普通文件。');
  }
  return relativePath.split(path.sep).join('/');
}

function comparableRoot(rootPath) {
  if (typeof rootPath !== 'string' || !path.isAbsolute(rootPath)) return null;
  const normalized = path.resolve(rootPath).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function validateProjectBinding(status, projectId, workspaceRoot) {
  const projects = Array.isArray(status && status.projects) ? status.projects : [];
  const project = projects.find((item) => String(item.id) === String(projectId));
  if (!project) throw new Error(`服务端不存在项目 ${projectId}。`);
  if (!project.root) throw new Error(`项目 ${projectId} 缺少 root，无法验证工作区绑定。`);
  if (comparableRoot(project.root) !== comparableRoot(workspaceRoot)) {
    throw new Error(`项目 ${projectId} 的根目录不匹配当前工作区文件夹。`);
  }
  return project;
}

function buildContextPayload(input) {
  if (!input.projectId || !input.sessionId) throw new Error('缺少项目 ID 或编辑器会话 ID。');
  if (Buffer.byteLength(input.text, 'utf8') > MAX_TEXT_BYTES) throw new Error('当前文件超过 1 MiB，未发送。');
  const selection = input.selection ? {
    start_line: input.selection.startLine + 1,
    end_line: input.selection.endLine + 1,
    text: input.selection.text.slice(0, MAX_SELECTION_TEXT_LENGTH),
  } : null;
  return {
    project_id: input.projectId,
    session_id: input.sessionId,
    path: input.relativePath,
    version: input.version,
    text: input.text,
    selection,
    diagnostics: input.diagnostics.slice(0, MAX_DIAGNOSTICS).map((item) => ({
      line: item.line + 1,
      severity: String(item.severity).slice(0, MAX_DIAGNOSTIC_SEVERITY_LENGTH),
      message: String(item.message).slice(0, MAX_DIAGNOSTIC_MESSAGE_LENGTH),
    })),
  };
}

class ContextClient {
  constructor(serviceUrl, token, options = {}) {
    this.serviceUrl = normalizeServiceUrl(serviceUrl, options);
    if (!token) throw new Error('缺少访问令牌，请先运行“AI Zhagan: 配置连接”。');
    this.token = token;
  }

  async request(method, requestPath, body) {
    let response;
    try {
      response = await fetch(`${this.serviceUrl}${requestPath}`, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      throw new Error(`无法连接本机服务 ${this.serviceUrl}：${error.message}`);
    }
    const responseText = await response.text();
    if (!response.ok) {
      let detail = responseText;
      try {
        const parsed = JSON.parse(responseText);
        detail = parsed.error || parsed.message || responseText;
      } catch { /* Keep plain response text. */ }
      throw new Error(`本机服务返回 HTTP ${response.status}${detail ? `：${detail}` : ''}`);
    }
    if (!responseText) return null;
    try { return JSON.parse(responseText); } catch { throw new Error('本机服务返回了无效 JSON。'); }
  }

  getStatus() { return this.request('GET', '/api/status'); }
  putContext(payload) { return this.request('PUT', '/api/context', payload); }
  deleteContext(sessionId) { return this.request('DELETE', `/api/context/${encodeURIComponent(sessionId)}`); }
}

module.exports = {
  ContextClient,
  MAX_DIAGNOSTICS,
  MAX_DIAGNOSTIC_MESSAGE_LENGTH,
  MAX_DIAGNOSTIC_SEVERITY_LENGTH,
  MAX_SELECTION_TEXT_LENGTH,
  MAX_TEXT_BYTES,
  buildContextPayload,
  normalizeServiceUrl,
  relativeWorkspacePath,
  validateProjectBinding,
};
