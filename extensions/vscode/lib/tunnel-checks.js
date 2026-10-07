'use strict';

const issues = {
  TUNNEL_CREDENTIALS: ['运行密钥已失效或无效。请在连接向导重新填写 API Key。', 'setup-tunnel', false],
  TUNNEL_PERMISSION: ['隧道访问被拒绝。检查运行密钥的 Tunnels Read + Use 权限及所属组织。', 'setup-tunnel', false],
  TUNNEL_NOT_FOUND: ['此 Tunnel ID 不存在或当前组织不可见。请核对 ID 和所属组织。', 'setup-tunnel', false],
  TUNNEL_CONFIG: ['隧道配置被拒绝。请核对 Tunnel ID、运行密钥和所属组织。', 'setup-tunnel', false],
  TUNNEL_RATE_LIMIT: ['隧道服务暂时限流，客户端正在等待后重试。', null, true],
  TUNNEL_NETWORK: ['暂时无法访问隧道服务。检查网络或代理；客户端会自动重连。', null, true],
  TUNNEL_CONNECTING: ['正在等待隧道服务确认，页面会自动更新。', null, true],
  TUNNEL_HEALTH_UNSUPPORTED: ['隧道客户端的状态格式无法识别，请检查并安装扩展附带版本。', 'setup-tunnel', false],
  TUNNEL_MCP_UNREADY: ['隧道已启动，本机 MCP 尚未就绪。请检查本机服务。', 'diagnose', true],
  TUNNEL_PROCESS: ['隧道客户端已退出，可重新启动。连续失败后会暂停自动重启。', 'start-tunnel', true],
  TUNNEL_STOPPED: ['私有隧道已停止。', 'start-tunnel', true],
  TUNNEL_CRASH_LIMIT: ['隧道连续启动失败，已暂停自动重启。请检查连接信息后重新启动。', 'setup-tunnel', false],
  LOCAL_MCP_AUTH: ['本机 MCP 令牌无法认证，请检查并修复本机服务。', 'diagnose', false],
  LOCAL_MCP_PROJECT: ['当前项目未授权或已暂停。请在首页选择并授权项目。', 'pick-folder', false],
  LOCAL_MCP_PROTOCOL: ['本机 MCP 协议检查失败，请检查并安装扩展附带版本。', 'diagnose', false],
  LOCAL_MCP_NETWORK: ['无法访问本机 MCP，请先启动本机服务。', 'start-service', true],
};

function tunnelIssue(code) {
  const [message, repair, retryable] = issues[code] || issues.TUNNEL_PROCESS;
  return { code: issues[code] ? code : 'TUNNEL_PROCESS', message, repair, retryable };
}

function issueError(code) {
  const issue = tunnelIssue(code);
  return Object.assign(new Error(issue.message), issue);
}

function interpretTunnelHealth(snapshot, clientReady, now = Date.now()) {
  const result = (code) => ({ ready: false, clientReady, issue: tunnelIssue(code) });
  if (snapshot?.schema_version !== 1 || snapshot?.component !== 'control-plane') {
    return result('TUNNEL_HEALTH_UNSUPPORTED');
  }
  const detail = snapshot.details || {};
  const code = detail.http_status;
  if (code === 401) return result('TUNNEL_CREDENTIALS');
  if (code === 403) return result('TUNNEL_PERMISSION');
  if (code === 404) return result('TUNNEL_NOT_FOUND');
  if (code === 400 || code === 422) return result('TUNNEL_CONFIG');
  if (code === 429) return result('TUNNEL_RATE_LIMIT');
  if (code >= 500 || ['timeout', 'network_error', 'request_error'].includes(detail.failure_category)) {
    return result('TUNNEL_NETWORK');
  }
  const success = Date.parse(detail.last_success);
  const fresh = Number.isFinite(success) && now - success <= 180000 && success <= now + 5000;
  if (snapshot.status === 'ok' && fresh && detail.consecutive_failures === 0
      && ['idle', 'polling', 'backpressured'].includes(snapshot.state)) {
    return clientReady ? { ready: true, clientReady: true, issue: null } : result('TUNNEL_MCP_UNREADY');
  }
  return result(Number.isFinite(success) && !fresh ? 'TUNNEL_NETWORK' : 'TUNNEL_CONNECTING');
}

function loopbackOrigin(baseUrl) {
  const url = new URL(String(baseUrl).trim());
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port
      || url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new Error('隧道状态地址不是本机地址。');
  }
  return url.origin;
}

async function readTunnelHealth(baseUrl, fetcher = fetch) {
  const origin = loopbackOrigin(baseUrl);
  try {
    const [ready, response] = await Promise.all([
      fetcher(`${origin}/readyz`, { signal: AbortSignal.timeout(2000), redirect: 'error' }),
      fetcher(`${origin}/health/control-plane`, { signal: AbortSignal.timeout(2000), redirect: 'error' }),
    ]);
    if (!response.ok) return { ready: false, issue: tunnelIssue('TUNNEL_HEALTH_UNSUPPORTED') };
    const body = await response.text();
    if (body.length > 65536) return { ready: false, issue: tunnelIssue('TUNNEL_HEALTH_UNSUPPORTED') };
    return interpretTunnelHealth(JSON.parse(body), ready.ok);
  } catch { return { ready: false, issue: tunnelIssue('TUNNEL_NETWORK') }; }
}

function recoveryAction({ running, issue, manualStop = false }) {
  if (manualStop) return 'wait';
  if (issue && !issue.retryable) return 'block';
  return running ? 'wait' : 'restart';
}

async function probeLocalMcp({ mcpPort, mcpToken, projectId }, fetcher = fetch) {
  if (!Number.isInteger(mcpPort) || mcpPort < 1024 || mcpPort > 65535
      || typeof mcpToken !== 'string' || mcpToken.length < 32) throw issueError('LOCAL_MCP_PROTOCOL');
  const url = `http://127.0.0.1:${mcpPort}/mcp`;
  const headers = { Authorization: `Bearer ${mcpToken}`, 'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream' };
  let sequence = 0;
  async function send(method, params, notification = false) {
    const id = ++sequence;
    const response = await fetcher(url, { method: 'POST', headers,
      body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id }), method, params }),
      signal: AbortSignal.timeout(5000), redirect: 'error' });
    if (response.status === 401 || response.status === 403) throw issueError('LOCAL_MCP_AUTH');
    if (!response.ok) throw issueError('LOCAL_MCP_PROTOCOL');
    const session = response.headers.get('mcp-session-id');
    if (session) headers['Mcp-Session-Id'] = session;
    if (notification) return null;
    const body = await response.text();
    if (body.length > 1024 * 1024) throw issueError('LOCAL_MCP_PROTOCOL');
    let rpc;
    try {
      rpc = body.trim().startsWith('{') ? JSON.parse(body)
        : body.split(/\r?\n/).filter((line) => line.startsWith('data:'))
          .map((line) => JSON.parse(line.slice(5).trim())).find((item) => item.id === id);
    } catch { throw issueError('LOCAL_MCP_PROTOCOL'); }
    if (!rpc || rpc.id !== id || rpc.error || !rpc.result) throw issueError('LOCAL_MCP_PROTOCOL');
    return rpc.result;
  }
  try {
    const init = await send('initialize', { protocolVersion: '2025-11-25', capabilities: {},
      clientInfo: { name: 'porthole-local-check', version: '1' } });
    if (!init.protocolVersion || !init.capabilities?.tools) throw issueError('LOCAL_MCP_PROTOCOL');
    headers['Mcp-Protocol-Version'] = init.protocolVersion;
    await send('notifications/initialized', undefined, true);
    const catalog = await send('tools/list', {});
    if (!catalog.tools?.some((tool) => tool.name === 'list_projects')
        || !catalog.tools.some((tool) => tool.name === 'verify_connection')) throw issueError('LOCAL_MCP_PROTOCOL');
    const called = await send('tools/call', { name: 'list_projects', arguments: {} });
    if (called.isError) throw issueError('LOCAL_MCP_PROTOCOL');
    let projects = called.structuredContent?.result;
    if (!projects) {
      try { projects = JSON.parse(called.content?.find((item) => item.type === 'text')?.text); }
      catch { throw issueError('LOCAL_MCP_PROTOCOL'); }
    }
    if (!Array.isArray(projects) || !projects.some((item) => item.id === projectId && !item.paused)) {
      throw issueError('LOCAL_MCP_PROJECT');
    }
    return { ok: true, checkedAt: new Date().toISOString() };
  } catch (error) {
    if (issues[error.code]) throw error;
    throw issueError('LOCAL_MCP_NETWORK');
  } finally {
    if (headers['Mcp-Session-Id']) {
      try { await fetcher(url, { method: 'DELETE', headers, signal: AbortSignal.timeout(1500), redirect: 'error' }); }
      catch { /* The bounded local session will expire. */ }
    }
  }
}

module.exports = { tunnelIssue, issueError, interpretTunnelHealth, readTunnelHealth,
  loopbackOrigin, probeLocalMcp, recoveryAction };
