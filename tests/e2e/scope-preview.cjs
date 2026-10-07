'use strict';
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { homeHtml, deriveHomeView } = require('../../extensions/vscode/lib/home');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const errors = [];
  let page;
  let selected = 'p';
  let release;
  let scans = 0;
  const status = { projects: [{ id: 'p', root: 'D:\\工程资料' }, { id: 'q', root: 'D:\\其他资料' }] };
  const hostileName = 'src/<img src=x onerror=alert(1)>.txt';
  let preview = null;
  const scanned = { project_id: 'p', accessible_files: 2, scan_complete: true,
    excluded_by_reason: { sensitive_path: 2, file_too_large: 1 }, files_truncated: false,
    files: [{ path: '工程设计软件清单分析表.xlsx', size: 15811, read_as: 'table' },
      { path: hostileName, size: 10, read_as: 'text_candidate' }] };
  const publish = async () => {
    const view = deriveHomeView({ runtimeInstalled: true, managedConfigExists: true,
      installedVersion: '0.9.0', bundledVersion: '0.9.0', status,
      selectedProjectId: selected, scopePreview: preview });
    await page.evaluate((view) => window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'state', view },
    })), view);
  };
  const checkText = async (pattern) => {
    await page.waitForFunction((source) => new RegExp(source).test(
      document.getElementById('scope-preview')?.textContent || ''), pattern.source, { timeout: 3000 });
  };
  try {
    page = await browser.newPage({ viewport: { width: 1024, height: 900 } });
    page.on('pageerror', (error) => errors.push(error.message));
    await page.exposeFunction('toHost', async (message) => {
      if (message.type === 'ready') return publish();
      if (message.type === 'select-project') { selected = message.projectId; return publish(); }
      if (message.type === 'action' && message.action === 'preview-scope') {
        scans += 1;
        preview = { project_id: selected, loading: true };
        await publish();
        await new Promise((resolve) => { release = resolve; });
        return publish();
      }
    });
    await page.evaluate(() => { window.acquireVsCodeApi = () => ({ postMessage: (message) => window.toHost(message) }); });
    await page.setContent(homeHtml('scope-preview-browser'));
    await page.getByRole('button', { name: '预览可访问文件', exact: true }).click();
    await checkText(/正在扫描/);
    assert.equal(await page.locator('#preview').isDisabled(), true);
    assert.equal(scans, 1);
    preview = scanned;
    status.projects[0].paused = true;
    await publish();
    assert.equal(await page.locator('#scope-preview').isHidden(), true);
    assert.equal(await page.locator('#preview').isDisabled(), true);
    status.projects[0].paused = false;
    release();
    await checkText(/工程设计软件清单分析表.xlsx/);
    assert.match(await page.locator('#scope-preview').innerText(), /敏感文件或内部目录.*2/);
    assert.match(await page.locator('#scope-preview').innerText(), /文件超过大小限制.*1/);
    assert.equal(await page.locator('#scope-files img').count(), 0);
    assert.ok((await page.locator('#scope-files').innerText()).includes(hostileName));
    assert.equal(await page.locator('#scope-preview').evaluate((el) => el.open), true);
    await page.locator('#scope-preview').screenshot({ path: '.local/scope-preview-0.9.0.png' });
    assert.equal(await page.locator('#preview').isEnabled(), true);
    await page.locator('#projects').selectOption('q');
    assert.equal(await page.locator('#scope-preview').isHidden(), true);
    assert.equal(await page.locator('#scope-files').innerText(), '');
    await page.locator('#projects').selectOption('p');
    await checkText(/工程设计软件清单分析表.xlsx/);
    preview = { project_id: 'p', error: '本机服务暂时不可用，请重试。' };
    await publish();
    await checkText(/本机服务暂时不可用/);
    assert.equal(await page.locator('#scope-files li').count(), 0);
    await page.getByRole('button', { name: '重新预览', exact: true }).click();
    await checkText(/正在扫描/);
    preview = { project_id: 'p', accessible_files: 0, excluded_by_reason: {},
      files: [], files_truncated: false, scan_complete: true };
    release();
    await checkText(/没有可访问文件/);
    preview = { ...scanned, files_truncated: true, accessible_files: 205, scan_complete: false };
    await publish();
    await checkText(/仅展示/);
    await checkText(/未扫描完整/);
    preview = { project_id: 'p', accessible_files: 1, excluded_by_reason: {}, scan_complete: true };
    await publish();
    await checkText(/升级/);
    preview = scanned;
    for (const width of [320, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await publish();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    }
    await page.locator('#scope-preview summary').focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('#scope-preview').evaluate((el) => el.open), false);
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('#scope-preview').evaluate((el) => el.open), true);
    assert.deepEqual(errors, []);
    process.stdout.write('Scope preview browser: visible files, exclusion reasons, progress, retry, empty/limited/legacy results, project switch, safe text, keyboard and 320/768/1024/1440 layouts passed\n');
  } finally { await browser.close(); }
})().catch((error) => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
