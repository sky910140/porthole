'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { interpretTunnelHealth, readTunnelHealth, probeLocalMcp, recoveryAction } = require('../lib/tunnel-checks');

const snapshot = (details, extra = {}) => ({ schema_version: 1, component: 'control-plane',
  status: 'degraded', state: 'backoff', details, ...extra });

test('control-plane failures give specific safe actions instead of raw upstream errors', () => {
  const expected = [[401, 'TUNNEL_CREDENTIALS'], [403, 'TUNNEL_PERMISSION'],
    [404, 'TUNNEL_NOT_FOUND'], [429, 'TUNNEL_RATE_LIMIT'], [503, 'TUNNEL_NETWORK']];
  for (const [code, name] of expected) {
    const result = interpretTunnelHealth(snapshot({ http_status: code,
      failure_category: 'http_error', error: 'sk-do-not-display' }), true);
    assert.equal(result.issue.code, name);
    assert.doesNotMatch(JSON.stringify(result), /sk-do-not-display/);
    assert.equal(result.ready, false);
  }
  assert.equal(interpretTunnelHealth(snapshot({ http_status: 401 }), true).issue.retryable, false);
});

test('readiness is not control-plane authentication or a real ChatGPT call', () => {
  const starting = interpretTunnelHealth(snapshot({}, { state: 'polling', status: 'unknown' }), true);
  assert.equal(starting.ready, false);
  assert.equal(starting.issue.code, 'TUNNEL_CONNECTING');
  const healthy = snapshot({ last_success: new Date().toISOString(), consecutive_failures: 0 },
    { state: 'polling', status: 'ok' });
  assert.equal(interpretTunnelHealth(healthy, true).ready, true);
  assert.equal(interpretTunnelHealth(healthy, false).ready, false);
  const stale = snapshot({ last_success: '2000-01-01T00:00:00Z', consecutive_failures: 0 },
    { state: 'polling', status: 'ok' });
  assert.equal(interpretTunnelHealth(stale, true).ready, false);
});

test('network loss keeps a running client; only process failures restart', () => {
  assert.equal(recoveryAction({ running: true, issue: { code: 'TUNNEL_NETWORK', retryable: true } }), 'wait');
  assert.equal(recoveryAction({ running: true, issue: { code: 'TUNNEL_CREDENTIALS', retryable: false } }), 'block');
  assert.equal(recoveryAction({ running: false, issue: { code: 'TUNNEL_PERMISSION', retryable: false } }), 'block');
  assert.equal(recoveryAction({ running: false, issue: { code: 'TUNNEL_PROCESS', retryable: true } }), 'restart');
  assert.equal(recoveryAction({ running: false, manualStop: true }), 'wait');
});

test('local check performs real protocol discovery and confirms the selected project', async () => {
  const requests = [];
  const response = (body, status = 200) => ({ ok: status < 300, status,
    headers: new Headers({ 'mcp-session-id': 'test-session' }), text: async () => JSON.stringify(body) });
  const fetcher = async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:18765/mcp');
    assert.equal(options.headers.Authorization, `Bearer ${'x'.repeat(40)}`);
    if (options.method === 'DELETE') { requests.push('DELETE'); return response({}); }
    const rpc = JSON.parse(options.body); requests.push(rpc.method);
    if (rpc.method === 'notifications/initialized') return response({}, 202);
    let result;
    if (rpc.method === 'initialize') result = { protocolVersion: '2025-11-25', capabilities: { tools: {} } };
    if (rpc.method === 'tools/list') result = { tools: [{ name: 'list_projects' }, { name: 'verify_connection' }] };
    if (rpc.method === 'tools/call') result = { structuredContent: { result: [{ id: 'p' }, { id: 'paused', paused: true }] } };
    return response({ jsonrpc: '2.0', id: rpc.id, result });
  };
  const result = await probeLocalMcp({ mcpPort: 18765, mcpToken: 'x'.repeat(40), projectId: 'p' }, fetcher);
  assert.equal(result.ok, true);
  assert.deepEqual(requests, ['initialize', 'notifications/initialized', 'tools/list', 'tools/call', 'DELETE']);
  assert.doesNotMatch(JSON.stringify(result), /x{40}|test-session/);
  for (const projectId of ['missing', 'paused']) {
    await assert.rejects(probeLocalMcp({ mcpPort: 18765, mcpToken: 'x'.repeat(40), projectId }, fetcher),
      (error) => error.code === 'LOCAL_MCP_PROJECT');
    assert.equal(requests.at(-1), 'DELETE');
  }
});

test('local check rejects authentication, without marking remote verification', async () => {
  const fetcher = async () => ({ ok: false, status: 401, headers: new Headers() });
  await assert.rejects(probeLocalMcp({ mcpPort: 8765, mcpToken: 'x'.repeat(40), projectId: 'p' }, fetcher),
    (error) => error.code === 'LOCAL_MCP_AUTH' && !error.message.includes('x'.repeat(40)));
});

test('health reads reject unsafe origins and never expose raw upstream content', async () => {
  let called = false;
  await assert.rejects(readTunnelHealth('https://foreign.example', async () => { called = true; }), /本机/);
  assert.equal(called, false);
  const unknown = await readTunnelHealth('http://127.0.0.1:49001', async (url, options) => {
    assert.equal(options.redirect, 'error');
    return { ok: true, text: async () => JSON.stringify({ schema_version: 99, error: 'sk-upstream-hidden' }) };
  });
  assert.equal(unknown.issue.code, 'TUNNEL_HEALTH_UNSUPPORTED');
  assert.doesNotMatch(JSON.stringify(unknown), /sk-upstream-hidden/);
  const disconnected = await readTunnelHealth('http://127.0.0.1:49001', async () => {
    throw new Error('sk-network-hidden');
  });
  assert.equal(disconnected.issue.code, 'TUNNEL_NETWORK');
  assert.doesNotMatch(JSON.stringify(disconnected), /sk-network-hidden/);
});
