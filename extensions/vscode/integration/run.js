'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runTests } = require('@vscode/test-electron');
const { resolveTestRuntime, resolveExtensionDevelopmentPath } = require('./runtime');

async function main() {
  const sourceExtensionPath = path.resolve(__dirname, '..');
  const extensionDevelopmentPath = resolveExtensionDevelopmentPath(process.env, sourceExtensionPath);
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'porthole-vscode-'));
  const userDataDir = path.join(testRoot, 'user-data');
  const extensionsDir = path.join(testRoot, 'extensions');
  const workspaceDir = path.join(testRoot, 'workspace');
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync(extensionsDir, { recursive: true });
  fs.cpSync(path.join(sourceExtensionPath, 'test-fixture'), workspaceDir, { recursive: true });
  const options = {
    ...resolveTestRuntime(),
    extensionDevelopmentPath,
    extensionTestsPath: path.join(__dirname, 'suite.js'),
    extensionTestsEnv: { PORTHOLE_EXTENSION_TEST: '1',
      PORTHOLE_TEST_RESET_RUNTIME: fs.existsSync(path.join(extensionDevelopmentPath, 'runtime-bundle', 'bundle.json')) ? '1' : '0',
      LOCALAPPDATA: path.join(testRoot, 'managed-local') },
    launchArgs: [
      path.join(workspaceDir, 'integration.code-workspace'),
      '--disable-extensions',
      // Keep test credentials isolated from native storage and its asynchronous flushes.
      '--use-inmemory-secretstorage',
      `--user-data-dir=${userDataDir}`,
      `--extensions-dir=${extensionsDir}`,
      '--skip-welcome',
      '--skip-release-notes',
    ],
  };
  try {
    await runTests(options);
  } finally {
    try { fs.rmSync(testRoot, { recursive: true, force: true }); } catch { /* VS Code may release files after exit. */ }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
