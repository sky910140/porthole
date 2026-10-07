'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  ContextClient,
  MAX_DIAGNOSTICS,
  MAX_DIAGNOSTIC_MESSAGE_LENGTH,
  MAX_DIAGNOSTIC_SEVERITY_LENGTH,
  MAX_SELECTION_TEXT_LENGTH,
  MAX_TEXT_BYTES,
  buildContextPayload,
  normalizeServiceUrl,
  relativeWorkspacePath,
  requireEditorBufferSharing,
  validateProjectBinding,
} = require('../lib/core');

test('accepts only loopback service endpoints on non-privileged ports', () => {
  assert.equal(normalizeServiceUrl('http://127.0.0.1:8766/'), 'http://127.0.0.1:8766');
  assert.equal(normalizeServiceUrl('http://localhost:8766'), 'http://localhost:8766');
  assert.equal(normalizeServiceUrl('http://127.0.0.1:18766'), 'http://127.0.0.1:18766');
  for (const value of ['https://127.0.0.1:8766', 'http://127.0.0.1:80', 'http://example.com:8766', 'http://127.0.0.1:8766/?redirect=evil', 'not a url']) {
    assert.throws(() => normalizeServiceUrl(value), /本机服务地址/);
  }
});

test('returns a POSIX relative path only for files inside the bound root', () => {
  const root = path.resolve('workspace');
  assert.equal(relativeWorkspacePath(root, path.join(root, 'src', 'main.js')), 'src/main.js');
  assert.throws(() => relativeWorkspacePath(root, path.resolve(root, '..', 'secret.txt')), /绑定的工作区/);
  assert.throws(() => relativeWorkspacePath(root, root), /普通文件/);
});

test('builds bounded context from the actual selection and diagnostics', () => {
  const diagnostics = Array.from({ length: MAX_DIAGNOSTICS + 5 }, (_, index) => ({
    line: index,
    severity: 'warning',
    message: `m${index}`,
  }));
  const payload = buildContextPayload({
    projectId: 'p1', sessionId: 's1', relativePath: 'src/a.js', version: 7,
    text: 'first\nsecond',
    selection: { startLine: 0, endLine: 1, text: 'first\nsecond' },
    diagnostics,
  });
  assert.equal(payload.project_id, 'p1');
  assert.equal(payload.session_id, 's1');
  assert.equal(payload.path, 'src/a.js');
  assert.deepEqual(payload.selection, { start_line: 1, end_line: 2, text: 'first\nsecond' });
  assert.equal(payload.diagnostics.length, MAX_DIAGNOSTICS);
  assert.equal(payload.diagnostics[0].line, 1);
  const bounded = buildContextPayload({
    projectId: 'p', sessionId: 's', relativePath: 'x', version: 1, text: 'ok',
    selection: { startLine: 0, endLine: 0, text: '选'.repeat(MAX_SELECTION_TEXT_LENGTH + 1) },
    diagnostics: [{ line: 0, severity: 's'.repeat(MAX_DIAGNOSTIC_SEVERITY_LENGTH + 1), message: 'm'.repeat(MAX_DIAGNOSTIC_MESSAGE_LENGTH + 1) }],
  });
  assert.equal(bounded.selection.text.length, MAX_SELECTION_TEXT_LENGTH);
  assert.equal(bounded.diagnostics[0].severity.length, MAX_DIAGNOSTIC_SEVERITY_LENGTH);
  assert.equal(bounded.diagnostics[0].message.length, MAX_DIAGNOSTIC_MESSAGE_LENGTH);
  assert.throws(() => buildContextPayload({ projectId: 'p', sessionId: 's', relativePath: 'x', version: 1, text: 'x'.repeat(MAX_TEXT_BYTES + 1), selection: null, diagnostics: [] }), /1 MiB/);
});

test('requires the selected project root to equal the bound workspace root', () => {
  const workspaceRoot = path.resolve('workspace');
  const status = { projects: [{ id: 'p1', name: 'One', root: workspaceRoot }] };
  assert.equal(validateProjectBinding(status, 'p1', workspaceRoot).id, 'p1');
  assert.throws(() => validateProjectBinding(status, 'missing', workspaceRoot), /不存在项目/);
  assert.throws(() => validateProjectBinding(status, 'p1', path.resolve('other')), /根目录不匹配/);
  assert.throws(() => validateProjectBinding({ projects: [{ id: 'p1' }] }, 'p1', workspaceRoot), /缺少 root/);
});

test('directory aliases preserve project binding and relative file boundaries', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'porthole-path-'));
  const project = path.join(root, 'project');
  const alias = path.join(root, 'alias');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(project);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(project, 'inside.txt'), 'inside');
  fs.writeFileSync(path.join(outside, 'outside.txt'), 'outside');
  fs.symlinkSync(project, alias, process.platform === 'win32' ? 'junction' : 'dir');
  fs.symlinkSync(outside, path.join(project, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  try {
    assert.equal(validateProjectBinding({ projects: [{ id: 'p', root: project }] }, 'p', alias).id, 'p');
    assert.equal(relativeWorkspacePath(project, path.join(alias, 'inside.txt')), 'inside.txt');
    assert.equal(relativeWorkspacePath(project, path.join(alias, 'new.txt')), 'new.txt');
    assert.throws(() => validateProjectBinding({ projects: [{ id: 'p', root: project }] }, 'p', outside), /根目录不匹配/);
    assert.throws(() => relativeWorkspacePath(project, path.join(alias, 'escape', 'outside.txt')), /绑定的工作区/);
  } finally {
    fs.unlinkSync(path.join(project, 'escape'));
    fs.unlinkSync(alias);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('requires explicit project permission before sharing editor buffers', () => {
  assert.equal(requireEditorBufferSharing({ share_editor_buffers: true }).share_editor_buffers, true);
  assert.throws(
    () => requireEditorBufferSharing({ share_editor_buffers: false }),
    /管理页.*共享未保存内容/,
  );
  assert.throws(() => requireEditorBufferSharing({}), /管理页.*共享未保存内容/);
});

test('uses bearer authorization for status, context upload and deletion', async (t) => {
  const requests = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization, body });
      response.setHeader('content-type', 'application/json');
      if (request.url === '/api/status') response.end(JSON.stringify({ protocol_version: '1.0.0', service_version: '0.2.0', capabilities: [], projects: [{ id: 'p1', name: 'One' }], sessions: [] }));
      else { response.statusCode = 204; response.end(); }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const client = new ContextClient(`http://127.0.0.1:${port}`, 'secret', { allowTestPort: true });
  const status = await client.getStatus();
  await client.putContext({ project_id: 'p1' });
  await client.deleteContext('session / one');
  assert.equal(status.projects[0].id, 'p1');
  assert.deepEqual(requests.map((item) => [item.method, item.url]), [
    ['GET', '/api/status'], ['PUT', '/api/context'], ['DELETE', '/api/context/session%20%2F%20one'],
  ]);
  assert.ok(requests.every((item) => item.authorization === 'Bearer secret'));
});

test('reports HTTP errors with actionable status detail', async (t) => {
  const server = http.createServer((_request, response) => {
    response.statusCode = 401;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ error: 'bad token' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const client = new ContextClient(`http://127.0.0.1:${port}`, 'wrong', { allowTestPort: true });
  await assert.rejects(client.getStatus(), /401.*bad token/);
});
