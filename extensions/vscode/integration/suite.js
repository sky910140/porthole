'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const vscode = require('vscode');
const { runInitialReset } = require('./reset');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitForRequest(gate, publishing, label, describe) {
  let seen = false;
  let timer;
  try {
    await Promise.race([
      gate.seen.promise.then(() => { seen = true; }),
      publishing.then(() => { if (!seen) throw new Error('publish finished without the expected request'); }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('request timed out')), 10000); }),
    ]);
  } catch (error) {
    throw new Error(`${label}: ${error.message}; ${JSON.stringify(describe())}`, { cause: error });
  } finally { clearTimeout(timer); }
}

async function activateDocument(document) {
  await vscode.window.showTextDocument(document);
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (vscode.window.activeTextEditor?.document.uri.toString() === document.uri.toString()) return;
    await wait(50);
  }
  assert.equal(vscode.window.activeTextEditor?.document.uri.toString(), document.uri.toString(),
    'expected text editor must be active before publishing');
}

async function run() {
  const folders = vscode.workspace.workspaceFolders;
  assert.equal(folders.length, 2);
  const [folderA, folderB] = folders;
  const projects = [
    { id: 'project-a', name: 'Project A', root: folderA.uri.fsPath, share_editor_buffers: true },
    { id: 'project-b', name: 'Project B', root: folderB.uri.fsPath, share_editor_buffers: true },
  ];
  const requests = [];
  const describePublish = () => ({
    activeDocument: vscode.window.activeTextEditor?.document.uri.toString(),
    folders: folders.map((folder) => ({ name: folder.name,
      projectId: vscode.workspace.getConfiguration('porthole', folder.uri).get('projectId'),
      serviceUrl: vscode.workspace.getConfiguration('porthole', folder.uri).get('serviceUrl') })),
    requests: requests.slice(-8).map(({ method, url }) => ({ method, url })),
  });
  const serverSessions = new Map();
  const readinessSessions = new Map();
  const change = {
    change_id: 'change-1', project_id: 'project-a', summary: 'Update A',
    state: 'pending_review', revision: 1, manifest_sha256: 'a'.repeat(64),
    files: [{
      path: 'inside-a.txt', operation: 'modify', base_sha256: 'b'.repeat(64),
      content_sha256: 'c'.repeat(64), content_utf8: 'proposed from web\n',
    }],
  };
  let delayedStatus = null;
  let delayedPut = null;
  let delayedScope = null;
  let failScope = false;
  const activeGates = new Set();
  const server = http.createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', async () => {
      requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization, body });
      response.setHeader('content-type', 'application/json');
      if (request.url === '/api/status') {
        if (delayedStatus) {
          const gate = delayedStatus;
          delayedStatus = null;
          gate.seen.resolve();
          await gate.release.promise;
        }
        return response.end(JSON.stringify({
          protocol_version: '1.0.0', service_version: '0.2.0', capabilities: [],
          projects, sessions: [...serverSessions.keys()],
        }));
      }
      if (request.method === 'GET' && request.url === '/api/projects/project-a/scope') {
        if (delayedScope) {
          const gate = delayedScope;
          delayedScope = null;
          gate.seen.resolve();
          await gate.release.promise;
        }
        if (failScope) {
          response.statusCode = 503;
          return response.end(JSON.stringify({ error: 'preview service unavailable' }));
        }
        return response.end(JSON.stringify({ project_id: 'project-a', accessible_files: 1,
          scan_complete: true, excluded_by_reason: { sensitive_path: 2 }, files_truncated: false,
          files: [{ path: 'inside-a.txt', size: 11, read_as: 'text_candidate' }] }));
      }
      if (request.method === 'PUT' && request.url === '/api/context') {
        if (delayedPut) {
          const gate = delayedPut;
          delayedPut = null;
          gate.seen.resolve();
          await gate.release.promise;
        }
        const payload = JSON.parse(body);
        const validLines = (!payload.selection || (payload.selection.start_line >= 1 && payload.selection.end_line >= 1)) && payload.diagnostics.every((item) => item.line >= 1);
        if (!validLines) { response.statusCode = 422; return response.end(JSON.stringify({ error: 'lines must be >= 1' })); }
        const existing = serverSessions.get(payload.session_id);
        if (existing && existing !== payload.project_id) { response.statusCode = 409; return response.end(JSON.stringify({ error: 'session cannot be rebound' })); }
        serverSessions.set(payload.session_id, payload.project_id);
        response.statusCode = 204; return response.end();
      }
      if (request.method === 'GET' && request.url === '/api/changes/change-1') {
        return response.end(JSON.stringify(change));
      }
      if (request.method === 'PUT' && request.url.startsWith('/api/editor-readiness/')) {
        const sessionId = decodeURIComponent(request.url.slice('/api/editor-readiness/'.length));
        readinessSessions.set(sessionId, JSON.parse(body));
        return response.end(JSON.stringify({ session_id: sessionId, revision: 1 }));
      }
      if (request.method === 'POST' && request.url === '/api/changes/change-1/readiness') {
        const latest = [...readinessSessions.values()].at(-1);
        const dirty = latest && latest.documents.some((document) => document.path === 'inside-a.txt' && document.dirty);
        if (dirty) {
          response.statusCode = 409;
          return response.end(JSON.stringify({ error: 'dirty', error_code: 'EDITOR_DIRTY' }));
        }
        return response.end(JSON.stringify({ lease_id: 'lease-1', expires_in_ms: 5000 }));
      }
      if (request.method === 'POST' && request.url === '/api/changes/change-1/apply') {
        change.state = 'applied'; change.revision = 2;
        return response.end(JSON.stringify({ change_id: 'change-1', state: 'applied', revision: 2 }));
      }
      if (request.method === 'DELETE') {
        if (request.url.startsWith('/api/context/')) {
          serverSessions.delete(decodeURIComponent(request.url.slice('/api/context/'.length)));
        }
        if (request.url.startsWith('/api/editor-readiness/')) {
          readinessSessions.delete(decodeURIComponent(request.url.slice('/api/editor-readiness/'.length)));
        }
        response.statusCode = 204; return response.end();
      }
      response.statusCode = 404; response.end(JSON.stringify({ error: 'not found' }));
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const serviceUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const extension = vscode.extensions.getExtension('sky910140.porthole');
    assert.ok(extension);
    const api = await extension.activate();
    const initialHome = (await api.currentHomeState()).view;
    assert.equal(initialHome.error, null, 'opening home without an authorized project must not show a verification error');
    assert.equal(initialHome.project, null);
    assert.equal(initialHome.challengeExpiresAt, null);
    assert.ok((await vscode.commands.getCommands(true)).includes('workbench.action.browser.open'));
    assert.ok((await vscode.commands.getCommands(true)).includes('porthole.pairManaged'));
    assert.ok((await vscode.commands.getCommands(true)).includes('porthole.onboarding'));
    assert.ok((await vscode.commands.getCommands(true)).includes('porthole.home'));
    assert.ok((await vscode.commands.getCommands(true)).includes('porthole.selectProject'));
    await api.configureConnection(folderA, serviceUrl, 'project-a', 'extension-secret-a');
    await api.configureConnection(folderB, serviceUrl, 'project-b', 'extension-secret-b');
    assert.equal(await api.getStoredToken(folderA), 'extension-secret-a');
    assert.equal(await api.getStoredToken(folderB), 'extension-secret-b');
    const homeState = await api.currentHomeState();
    assert.equal(homeState.view.projects.length, 2);
    assert.equal(homeState.view.error, null);
    assert.equal(JSON.stringify(homeState.view).includes('extension-secret-a'), false);
    await api.openHome();
    const scopeGate = { seen: deferred(), release: deferred() };
    delayedScope = scopeGate;
    const previewing = api.handleHomeAction('preview-scope');
    try {
      await waitForRequest(scopeGate, previewing, 'scope preview progress', describePublish);
      assert.equal((await api.currentHomeState()).view.scopePreview.loading, true);
    } finally { scopeGate.release.resolve(); }
    await previewing;
    assert.deepEqual((await api.currentHomeState()).view.scopePreview.files,
      [{ path: 'inside-a.txt', size: 11, read_as: 'text_candidate' }]);
    failScope = true;
    await api.handleHomeAction('preview-scope');
    assert.match((await api.currentHomeState()).view.scopePreview.error, /preview service unavailable/);
    failScope = false;
    await api.handleHomeAction('preview-scope');
    assert.equal((await api.currentHomeState()).view.scopePreview.error, undefined);
    await api.setupPrivateTunnel();
    const wizardState = await api.wizardSnapshot();
    assert.equal(wizardState.projectId, homeState.view.project.id);
    assert.equal(wizardState.hasKey, false);
    assert.equal(JSON.stringify(wizardState).includes('extension-secret-a'), false);

    const documentA = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(folderA.uri, 'inside-a.txt'));
    const editorA = await vscode.window.showTextDocument(documentA);
    await editorA.edit((edit) => edit.insert(new vscode.Position(0, 0), 'unsaved '));
    editorA.selection = new vscode.Selection(0, 0, 0, 7);
    await api.publishActiveContext({ silent: true });
    const documentB = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(folderB.uri, 'inside-b.txt'));
    await vscode.window.showTextDocument(documentB);
    await api.publishActiveContext({ silent: true });
    const uploads = requests.filter((item) => item.method === 'PUT').map((item) => JSON.parse(item.body));
    assert.equal(uploads.length, 2);
    assert.notEqual(uploads[0].session_id, uploads[1].session_id);
    assert.equal(uploads[0].selection.start_line, 1);
    assert.equal(uploads[0].path, 'inside-a.txt');
    assert.match(uploads[0].text, /^unsaved /);
    assert.equal(uploads[0].selection.text, 'unsaved');
    assert.equal(uploads[1].path, 'inside-b.txt');

    await documentA.save();
    await api.showChange('change-1');
    const reviewEditorA = await vscode.window.showTextDocument(documentA);
    await reviewEditorA.edit((edit) => edit.insert(new vscode.Position(0, 0), 'edit after review '));
    await api.publishReviewReadiness('change-1');
    const readiness = [...readinessSessions.values()].at(-1);
    assert.equal(readiness.active_review.change_id, 'change-1');
    assert.equal(readiness.documents.find((item) => item.path === 'inside-a.txt').dirty, true);
    await assert.rejects(api.applyReviewedChange('change-1'), /HTTP 409.*dirty/);
    await documentA.save();
    await api.publishReviewReadiness('change-1');
    assert.equal((await api.applyReviewedChange('change-1')).state, 'applied');

    await vscode.workspace.getConfiguration('porthole', folderA.uri).update('autoSync', true, vscode.ConfigurationTarget.WorkspaceFolder);
    await vscode.workspace.getConfiguration('porthole', folderA.uri).update('debounceMs', 250, vscode.ConfigurationTarget.WorkspaceFolder);
    const reopenedEditorA = await vscode.window.showTextDocument(documentA);
    await reopenedEditorA.edit((edit) => edit.insert(new vscode.Position(0, 0), 'changed '));
    await vscode.window.showTextDocument(documentB);
    const uploadsBeforeWait = requests.filter((item) => item.method === 'PUT').length;
    await wait(500);
    assert.equal(requests.filter((item) => item.method === 'PUT').length, uploadsBeforeWait);

    const outsidePath = path.join(os.tmpdir(), `porthole-outside-${process.pid}.txt`);
    fs.writeFileSync(outsidePath, 'outside');
    try {
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(outsidePath));
      const requestCount = requests.length;
      await api.publishActiveContext({ silent: true });
      assert.equal(requests.length, requestCount);
    } finally { fs.rmSync(outsidePath, { force: true }); }

    await vscode.workspace.getConfiguration('porthole', folderA.uri).update('autoSync', false, vscode.ConfigurationTarget.WorkspaceFolder);
    await activateDocument(documentA);
    const statusGate = { seen: deferred(), release: deferred() };
    activeGates.add(statusGate);
    delayedStatus = statusGate;
    const putsBeforeDelayedGet = requests.filter((item) => item.method === 'PUT').length;
    const publishWaitingOnStatus = api.publishActiveContext({ silent: true });
    await waitForRequest(statusGate, publishWaitingOnStatus, 'delayed status', describePublish);
    const disconnectDuringStatus = api.disconnect();
    statusGate.release.resolve();
    await Promise.all([publishWaitingOnStatus, disconnectDuringStatus]);
    assert.equal(requests.filter((item) => item.method === 'PUT').length, putsBeforeDelayedGet, 'disconnect during status must prevent PUT');
    assert.equal(serverSessions.has(api.getSessionId(folderA)), false);
    assert.equal(serverSessions.has(api.getSessionId(folderB)), true);

    await api.configureConnection(folderA, serviceUrl, 'project-a', 'extension-secret-a2');
    await activateDocument(documentA);
    const putGate = { seen: deferred(), release: deferred() };
    activeGates.add(putGate);
    delayedPut = putGate;
    const publishWaitingOnPut = api.publishActiveContext({ silent: true });
    await waitForRequest(putGate, publishWaitingOnPut, 'delayed context PUT', describePublish);
    assert.equal(vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri).uri.toString(), folderA.uri.toString());
    const disconnectDuringPut = api.disconnect();
    await wait(25);
    const putsWhileDisconnecting = requests.filter((item) => item.method === 'PUT').length;
    await api.publishActiveContext({ silent: true });
    await vscode.workspace.getConfiguration('porthole', folderA.uri).update('autoSync', true, vscode.ConfigurationTarget.WorkspaceFolder);
    const editorDuringDisconnect = vscode.window.activeTextEditor;
    await editorDuringDisconnect.edit((edit) => edit.insert(new vscode.Position(0, 0), 'blocked '));
    await wait(300);
    assert.equal(requests.filter((item) => item.method === 'PUT').length, putsWhileDisconnecting, 'disconnect lock must block manual and automatic publishes');
    putGate.release.resolve();
    await Promise.all([publishWaitingOnPut, disconnectDuringPut]);
    assert.equal(serverSessions.has(api.getSessionId(folderA)), false, 'completed in-flight PUT must be deleted');
    assert.equal(serverSessions.has(api.getSessionId(folderB)), true, 'A cleanup must not affect B');

    await vscode.window.showTextDocument(documentB);
    assert.equal(vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri).uri.toString(), folderB.uri.toString());
    await api.disconnect();
    assert.equal(serverSessions.size, 0);
    assert.equal(await api.getStoredToken(folderA), undefined);
    assert.equal(await api.getStoredToken(folderB), undefined);
    const additional = fs.mkdtempSync(path.join(os.tmpdir(), 'porthole-selected-folder-'));
    try {
      const selectedFolder = await api.workspaceFolderForPath(additional);
      assert.equal(path.resolve(selectedFolder.uri.fsPath).toLowerCase(), path.resolve(additional).toLowerCase());
      assert.equal(vscode.workspace.workspaceFolders.length, 3);
      vscode.workspace.updateWorkspaceFolders(selectedFolder.index, 1);
    } finally { fs.rmSync(additional, { recursive: true, force: true }); }
    console.log('Extension Host context and review checks passed; starting isolated reset checks');
    if (process.env.PORTHOLE_TEST_RESET_RUNTIME === '1') await runInitialReset(api, folderA, folderB);
    else console.log('Frozen runtime reset: deferred to packaged VSIX acceptance (no source runtime bundle)');
  } catch (error) {
    console.error(error);
    throw error;
  } finally {
    for (const gate of activeGates) gate.release.resolve();
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
  }
}
module.exports = { run };
