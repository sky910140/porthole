'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const vscode = require('vscode');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function run() {
  const folders = vscode.workspace.workspaceFolders;
  assert.equal(folders.length, 2);
  const [folderA, folderB] = folders;
  const projects = [
    { id: 'project-a', name: 'Project A', root: folderA.uri.fsPath },
    { id: 'project-b', name: 'Project B', root: folderB.uri.fsPath },
  ];
  const requests = [];
  const serverSessions = new Map();
  let delayedStatus = null;
  let delayedPut = null;
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
        return response.end(JSON.stringify({ projects, sessions: [...serverSessions.keys()] }));
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
      if (request.method === 'DELETE') {
        serverSessions.delete(decodeURIComponent(request.url.slice('/api/context/'.length)));
        response.statusCode = 204; return response.end();
      }
      response.statusCode = 404; response.end(JSON.stringify({ error: 'not found' }));
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(18766, '127.0.0.1', resolve); });
  try {
    const extension = vscode.extensions.getExtension('local-ai-zhagan.ai-zhagan-context');
    assert.ok(extension);
    const api = await extension.activate();
    assert.ok((await vscode.commands.getCommands(true)).includes('workbench.action.browser.open'));
    await api.configureConnection(folderA, 'http://127.0.0.1:18766', 'project-a', 'extension-secret-a');
    await api.configureConnection(folderB, 'http://127.0.0.1:18766', 'project-b', 'extension-secret-b');
    assert.equal(await api.getStoredToken(folderA), 'extension-secret-a');
    assert.equal(await api.getStoredToken(folderB), 'extension-secret-b');

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

    await vscode.workspace.getConfiguration('aiZhagan', folderA.uri).update('autoSync', true, vscode.ConfigurationTarget.WorkspaceFolder);
    await vscode.workspace.getConfiguration('aiZhagan', folderA.uri).update('debounceMs', 250, vscode.ConfigurationTarget.WorkspaceFolder);
    const reopenedEditorA = await vscode.window.showTextDocument(documentA);
    await reopenedEditorA.edit((edit) => edit.insert(new vscode.Position(0, 0), 'changed '));
    await vscode.window.showTextDocument(documentB);
    const uploadsBeforeWait = requests.filter((item) => item.method === 'PUT').length;
    await wait(500);
    assert.equal(requests.filter((item) => item.method === 'PUT').length, uploadsBeforeWait);

    const outsidePath = path.join(os.tmpdir(), `ai-zhagan-outside-${process.pid}.txt`);
    fs.writeFileSync(outsidePath, 'outside');
    try {
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(outsidePath));
      const requestCount = requests.length;
      await api.publishActiveContext({ silent: true });
      assert.equal(requests.length, requestCount);
    } finally { fs.rmSync(outsidePath, { force: true }); }

    await vscode.workspace.getConfiguration('aiZhagan', folderA.uri).update('autoSync', false, vscode.ConfigurationTarget.WorkspaceFolder);
    await vscode.window.showTextDocument(documentA);
    const statusGate = { seen: deferred(), release: deferred() };
    delayedStatus = statusGate;
    const putsBeforeDelayedGet = requests.filter((item) => item.method === 'PUT').length;
    const publishWaitingOnStatus = api.publishActiveContext({ silent: true });
    await statusGate.seen.promise;
    const disconnectDuringStatus = api.disconnect();
    statusGate.release.resolve();
    await Promise.all([publishWaitingOnStatus, disconnectDuringStatus]);
    assert.equal(requests.filter((item) => item.method === 'PUT').length, putsBeforeDelayedGet, 'disconnect during status must prevent PUT');
    assert.equal(serverSessions.has(api.getSessionId(folderA)), false);
    assert.equal(serverSessions.has(api.getSessionId(folderB)), true);

    await api.configureConnection(folderA, 'http://127.0.0.1:18766', 'project-a', 'extension-secret-a2');
    await vscode.window.showTextDocument(documentA);
    const putGate = { seen: deferred(), release: deferred() };
    delayedPut = putGate;
    const publishWaitingOnPut = api.publishActiveContext({ silent: true });
    await putGate.seen.promise;
    assert.equal(vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri).uri.toString(), folderA.uri.toString());
    const disconnectDuringPut = api.disconnect();
    await wait(25);
    const putsWhileDisconnecting = requests.filter((item) => item.method === 'PUT').length;
    await api.publishActiveContext({ silent: true });
    await vscode.workspace.getConfiguration('aiZhagan', folderA.uri).update('autoSync', true, vscode.ConfigurationTarget.WorkspaceFolder);
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
  } finally { await new Promise((resolve) => server.close(resolve)); }
}
module.exports = { run };
