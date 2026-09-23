const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '../..');
const python = process.env.PYTHON || path.join(root, '.venv', 'Scripts', 'python.exe');
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-zhagan-change-e2e-'));
const config = path.join(folder, 'config.json');
const helper = path.join(root, 'tests', 'e2e', 'change_client.py');

function runPython(args, timeout = 45000) {
  const result = spawnSync(python, args, {
    cwd: root, encoding: 'utf8', timeout, windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}
function cli(...args) {
  return runPython(['-m', 'project_mcp.cli', ...args, '--config', config]);
}
function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

(async () => {
  let browser;
  try {
    fs.writeFileSync(path.join(folder, 'app.txt'), 'before\n');
    cli('init', '--project', folder, '--id', 'demo');
    const value = JSON.parse(fs.readFileSync(config));
    value.mcp_port = await freePort(); value.admin_port = await freePort();
    value.projects[0].mode = 'propose'; value.projects[0].apply_local_enabled = true;
    fs.writeFileSync(config, JSON.stringify(value));
    cli('start');
    const tokens = JSON.parse(fs.readFileSync(path.join(folder, '.local', 'tokens.json')));
    const proposed = JSON.parse(runPython([helper, 'propose', '--config', config]));
    assert.equal(proposed.state, 'pending_review');
    assert.equal(proposed.local_files_changed, false);
    assert.equal(fs.readFileSync(path.join(folder, 'app.txt'), 'utf8'), 'before\n');

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${value.admin_port}`);
    await page.getByLabel('本机访问令牌', { exact: true }).fill(tokens.admin_token);
    await page.getByRole('button', { name: '连接', exact: true }).click();
    await page.getByRole('button', { name: '待处理修改' }).click();
    const changeItem = page.locator('#changes li').filter({ hasText: proposed.change_id });
    await changeItem.getByText('已收到建议，本地文件尚未改变', { exact: true }).waitFor();
    assert.equal(await changeItem.getByText('已应用，尚未运行测试', { exact: true }).count(), 0);

    const base = `http://127.0.0.1:${value.admin_port}`;
    const headers = { authorization: `Bearer ${tokens.admin_token}`, 'content-type': 'application/json' };
    const review = {
      project_id: 'demo', documents: [{ path: 'app.txt', version: 1, dirty: false }],
      active_review: { change_id: proposed.change_id, manifest_sha256: proposed.manifest_sha256 },
    };
    let response = await fetch(`${base}/api/editor-readiness/e2e-window`, {
      method: 'PUT', headers, body: JSON.stringify(review),
    });
    assert.equal(response.status, 200);
    response = await fetch(`${base}/api/changes/${proposed.change_id}/readiness`, {
      method: 'POST', headers, body: JSON.stringify({
        review_session_id: 'e2e-window', manifest_sha256: proposed.manifest_sha256,
      }),
    });
    assert.equal(response.status, 200);
    const lease = await response.json();
    const applyBody = {
      operation_id: 'e2e-apply-1', expected_revision: 1,
      review_session_id: 'e2e-window', manifest_sha256: proposed.manifest_sha256,
      lease_id: lease.lease_id,
    };
    response = await fetch(`${base}/api/changes/${proposed.change_id}/apply`, {
      method: 'POST', headers, body: JSON.stringify(applyBody),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).state, 'applied');
    assert.equal(fs.readFileSync(path.join(folder, 'app.txt'), 'utf8'), 'after\n');

    const queried = JSON.parse(runPython([
      helper, 'query', '--config', config, '--change-id', proposed.change_id,
    ]));
    assert.equal(queried.state, 'applied');
    await changeItem.getByText('已应用，尚未运行测试', { exact: true }).waitFor({ timeout: 7000 });
    console.log('PASS: real MCP proposal -> pending page -> readiness apply -> remote and page status');
  } finally {
    if (browser) await browser.close();
    try { cli('stop'); } catch { /* Report the primary failure. */ }
    try {
      runPython(['-c', [
        'import hashlib,keyring,sys',
        'from pathlib import Path',
        'identity=hashlib.sha256(str(Path(sys.argv[1]).resolve()).encode()).hexdigest()',
        'keyring.delete_password("AI Zhagan protected content", identity)',
      ].join(';'), config]);
    } catch { /* Best effort test credential cleanup. */ }
    fs.rmSync(folder, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
