'use strict';
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { homeHtml, deriveHomeView } = require('../../extensions/vscode/lib/home');
const { InitialReset } = require('../../extensions/vscode/lib/initial-reset');

(async () => {
  const browser = await chromium.launch();
  const pageErrors = [];
  let page;
  let saved = null;
  let approve = false;
  let fail = true;
  let confirmations = 0;
  let coreCalls = 0;
  let reset;
  const publish = async (state) => {
    if (!page || page.isClosed()) return;
    const view = deriveHomeView({ runtimeInstalled: true, managedConfigExists: true,
      reset: state, installedVersion: '0.8.0', bundledVersion: '0.8.0' });
    await page.evaluate((view) => window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'state', view },
    })), view);
  };
  function coordinator() {
    return new InitialReset({ load: () => saved, save: async (value) => { saved = JSON.parse(JSON.stringify(value)); },
      confirm: async () => { confirmations += 1; return approve; },
      preflight: async () => ({ external: { chatgpt: true, github: true, openai: true } }),
      suspend: async () => {}, disableStartup: async () => {}, stopTunnel: async () => {},
      resetCore: async () => { coreCalls += 1; return { local_reset: true, reset_id: 'a'.repeat(32) }; },
      clearExtension: async () => { if (fail) throw new Error('sk-must-not-render'); },
      verify: async () => {}, notify: (state) => { void publish(state); },
    });
  }
  async function open(width) {
    page = await browser.newPage({ viewport: { width, height: 900 } });
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.exposeFunction('toHost', async (message) => {
      if (message.type === 'ready') await publish(reset.state);
      if (message.type === 'action' && message.action === 'reset-initial') await publish(await reset.run());
    });
    await page.evaluate(() => { window.acquireVsCodeApi = () => ({ postMessage: (message) => window.toHost(message) }); });
    await page.setContent(homeHtml('reset-browser'));
    await page.locator('#initial-reset').waitFor();
  }
  try {
    reset = coordinator();
    await open(1440);
    await page.getByRole('button', { name: '恢复初始状态', exact: true }).click();
    await page.waitForTimeout(100);
    assert.equal(coreCalls, 0);
    assert.equal(saved, null);
    approve = true;
    await page.getByRole('button', { name: '恢复初始状态', exact: true }).click();
    await page.getByRole('heading', { name: '恢复尚未完成' }).waitFor();
    assert.equal(await page.getByRole('button', { name: '启动服务', exact: true }).isDisabled(), true);
    assert.doesNotMatch(await page.locator('body').innerText(), /sk-must-not-render/);
    assert.equal(coreCalls, 1);
    assert.equal(confirmations, 2);
    await page.close();
    reset = coordinator();
    fail = false;
    await open(768);
    await page.getByRole('button', { name: '继续恢复初始状态', exact: true }).last().click();
    await page.getByRole('heading', { name: '已恢复初始状态' }).waitFor();
    assert.equal(confirmations, 2);
    assert.equal(await page.getByRole('button', { name: '选择文件夹', exact: true }).isEnabled(), true);
    assert.match(await page.locator('#reset-external').innerText(), /尚需你手动检查/);
    await page.close();
    for (const width of [320, 768, 1440]) {
      await open(width);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.getByRole('button', { name: '恢复初始状态', exact: true }).focus();
      assert.equal(await page.evaluate(() => document.activeElement.dataset.action), 'reset-initial');
      await page.close();
    }
    assert.deepEqual(pageErrors, []);
    console.log('Reset Webview: cancel, progress, failure/resume, external checklist, 320/768/1440 layout and keyboard access passed');
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
