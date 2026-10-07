'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const vscode = require('vscode');
const execute = promisify(execFile);

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function runInitialReset(api, folderA, folderB) {
  const paths = await api.ensureManagedRuntime();
  assert.ok(path.resolve(paths.config).startsWith(path.resolve(process.env.LOCALAPPDATA) + path.sep),
    'managed reset must be isolated from the real installation');
  const cli = async (command, ...args) => execute(paths.executable, [command, '--config', paths.config, ...args],
    { windowsHide: true, timeout: 60000, maxBuffer: 1024 * 1024 });
  await cli('init', '--project', folderA.uri.fsPath, '--id', 'reset-a');
  const config = JSON.parse(fs.readFileSync(paths.config, 'utf8'));
  config.mcp_port = await freePort(); config.admin_port = await freePort();
  fs.writeFileSync(paths.config, JSON.stringify(config));
  const before = crypto.createHash('sha256').update(fs.readFileSync(path.join(folderA.uri.fsPath, 'inside-a.txt'))).digest('hex');
  let approve = false;
  let confirmations = 0;
  // The packaged extension has its own VS Code API object; inject only the confirmation boundary.
  const confirm = async () => { confirmations += 1; return approve; };
  try {
    const paired = await api.pairManagedRuntime(folderA);
    // B must be a real distinct grant, not just another folder using A's identity.
    const admin = { Authorization: `Bearer ${paired.token}`, 'content-type': 'application/json' };
    const added = await fetch(`${paired.serviceUrl}/api/projects`, { method: 'PUT', headers: admin,
      body: JSON.stringify({ id: 'reset-b', root: folderB.uri.fsPath, name: 'B' }) });
    assert.equal(added.status, 200);
    await api.configureConnection(folderB, paired.serviceUrl, 'reset-b', paired.token);
    assert.equal((await api.restoreInitialState(confirm)).phase, 'idle');
    assert.equal(await api.getStoredToken(folderA), paired.token);
    assert.equal((await fetch(`${paired.serviceUrl}/api/status`, { headers: admin })).status, 200);
    approve = true;
    const result = await api.restoreInitialState(confirm);
    assert.equal(result.phase, 'complete', JSON.stringify(result));
    assert.equal(confirmations, 2);
    assert.equal(await api.getStoredToken(folderA), undefined);
    assert.equal(await api.getStoredToken(folderB), undefined);
    for (let refresh = 0; refresh < 3; refresh += 1) {
      const home = (await api.currentHomeState()).view;
      assert.equal(home.primaryAction, 'pick-folder');
      assert.equal(home.error, null, 'refreshing the completed reset must not show a stale verification error');
      assert.equal(home.project, null);
      assert.equal(home.challengeExpiresAt, null);
    }
    assert.equal(vscode.workspace.getConfiguration('porthole', folderA.uri).get('projectId'), '');
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(folderA.uri.fsPath, 'inside-a.txt'))).digest('hex'), before);
    assert.equal((await api.restoreInitialState(confirm)).resetId, result.resetId);
    assert.equal(confirmations, 2);
    await cli('start');
    assert.equal((await fetch(`${paired.serviceUrl}/api/status`, { headers: admin })).status, 401);
    const fresh = JSON.parse((await cli('status')).stdout);
    assert.deepEqual(fresh.projects, []);
    await cli('stop');

    // Simulate a reset performed by another window/CLI, using a fresh explicit grant.
    const again = await api.pairManagedRuntime(folderA);
    const external = JSON.parse((await cli('reset-local')).stdout);
    assert.notEqual(external.reset_id, result.resetId);
    // Another window may finish core cleanup while its extension cleanup is still pending.
    await api.setSharedResetPending({ phase: 'running', step: 'clearExtension', resetId: external.reset_id });
    await api.observeResetState();
    assert.equal(await api.getStoredToken(folderA), undefined);
    const afterExternalReset = (await api.currentHomeState()).view;
    assert.equal(afterExternalReset.project, null);
    // The shared cleanup is still pending; only the stopped-service notice may remain.
    assert.ok([null, '当前端口没有运行属于此配置的本机服务。'].includes(afterExternalReset.error),
      'an external reset must not cause an unexpected home-state exception');
    assert.equal(afterExternalReset.challengeExpiresAt, null);
    assert.equal(vscode.workspace.getConfiguration('porthole', folderA.uri).get('projectId'), '');
    assert.ok(again.token !== paired.token);
    await assert.rejects(api.pairManagedRuntime(folderA), { code: 'RESET_BUSY' });
    await api.setSharedResetPending(undefined);
    await api.observeResetState();
    const afterOtherWindow = await api.pairManagedRuntime(folderA);
    assert.ok(afterOtherWindow.token !== again.token);
    assert.equal((await api.currentHomeState()).view.error, null);
    console.log('Extension Host reset: cancel, two grants, full local cleanup, repeat, old token rejection, explicit regrant, external reset observation and secondary-window resume passed');
  } finally {
    await cli('stop').catch(() => {});
  }
}

module.exports = { runInitialReset };
