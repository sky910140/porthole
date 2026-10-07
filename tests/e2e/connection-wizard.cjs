'use strict';
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { ConnectionWizard } = require('../../extensions/vscode/lib/connection-wizard');
const { connectionWizardHtml } = require('../../extensions/vscode/lib/connection-wizard-ui');

(async () => {
  const browser = await chromium.launch({ headless: true });
  let page;
  let saved = {};
  let submits = 0;
  let fail = true;
  const id = `tunnel_${'a'.repeat(32)}`;
  const connection = { projectId: 'p', projectName: '工程资料', hasKey: false, configured: false,
    running: false, ready: false, verified: false, tunnelId: '' };
  const errors = [];
  const wizard = new ConnectionWizard({ loadDraft: () => saved,
    saveDraft: async (draft) => { saved = { ...draft }; }, snapshot: async () => ({ ...connection }),
    connect: async (value, report) => {
      submits++; assert.equal(value.apiKey, 'sk-browser-fixture'); report('正在启动隧道');
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (fail) throw Object.assign(new Error('sk-never-render'), { code: 'TUNNEL_CREDENTIALS' });
      Object.assign(connection, { hasKey: true, configured: true, running: true, ready: true, tunnelId: id });
    },
    checkLocal: async () => ({ ok: true }),
    notify: (state) => { if (page && !page.isClosed()) void page.evaluate((data) => {
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'wizard-state', state: data } }));
    }, JSON.parse(JSON.stringify(state))); },
  });
  async function openPage(width) {
    page = await browser.newPage({ viewport: { width, height: 900 } });
    page.on('pageerror', (error) => errors.push(error.message));
    await page.exposeFunction('sendToHost', async (message) => {
      if (message.type === 'draft') await wizard.updateDraft(message);
      if (message.type === 'ready' || message.type === 'refresh') await wizard.refresh();
      if (message.type === 'submit') await wizard.submit(message);
      if (message.type === 'action' && message.action === 'copy-verification') {
        connection.challengeExpiresAt = new Date(Date.now() + 120000).toISOString();
        await wizard.refresh();
      }
    });
    // The same webview document runs with a minimal VS Code host bridge.
    await page.evaluate(() => { window.acquireVsCodeApi = () => ({
      postMessage: (message) => window.sendToHost(message),
      setState: (state) => { window.persistedDraft = state; },
    }); });
    await page.setContent(connectionWizardHtml('browser-test'));
    await page.getByText('当前项目：工程资料（p）', { exact: true }).waitFor();
  }
  try {
    await openPage(1024);
    await page.getByLabel('Tunnel ID', { exact: true }).fill(id);
    await page.waitForTimeout(300);
    assert.equal(saved.tunnelId, id);
    await page.getByLabel('运行 API Key', { exact: true }).fill('sk-browser-fixture');
    await page.getByRole('button', { name: '保存并自动检查' }).click();
    await page.getByText(/运行密钥已失效/).waitFor();
    assert.equal(await page.getByLabel('运行 API Key', { exact: true }).inputValue(), '');
    assert.doesNotMatch(await page.locator('body').innerText(), /sk-never-render|sk-browser-fixture/);
    assert.deepEqual(await page.evaluate(() => window.persistedDraft), { tunnelId: id });
    assert.equal(submits, 1);
    fail = false;
    await page.getByLabel('运行 API Key', { exact: true }).fill('sk-browser-fixture');
    await page.getByRole('button', { name: '保存并自动检查' }).click();
    await page.getByRole('heading', { name: '在 ChatGPT 添加一次' }).waitFor();
    await page.getByRole('button', { name: '复制验证提示词' }).click();
    await page.getByText(/请在 ChatGPT 发送，等待结果/).waitFor();
    connection.verified = true;
    await page.getByRole('heading', { name: '连接已验证' }).waitFor({ timeout: 8000 });
    assert.equal(submits, 2);
    await page.close();
    for (const width of [320, 768, 1440]) {
      await openPage(width);
      assert.equal(await page.getByLabel('Tunnel ID', { exact: true }).inputValue(), id);
      assert.equal(await page.getByLabel('运行 API Key', { exact: true }).inputValue(), '');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.getByRole('button', { name: '返回首页' }).focus();
      assert.equal(await page.evaluate(() => document.activeElement.dataset.action), 'home');
      await page.close();
    }
    assert.deepEqual(errors, []);
    process.stdout.write('Connection wizard browser: draft resume, password privacy, failure retry, automatic verification, 320/768/1024/1440 layouts passed\n');
  } finally { await browser.close(); }
})().catch((error) => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
