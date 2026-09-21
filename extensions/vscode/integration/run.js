'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { runTests } = require('@vscode/test-electron');
const { resolveTestRuntime } = require('./runtime');

async function main() {
  const extensionDevelopmentPath = path.resolve(__dirname, '..');
  const testRoot = path.join(extensionDevelopmentPath, '.integration-runtime');
  const userDataDir = path.join(testRoot, 'user-data');
  const extensionsDir = path.join(testRoot, 'extensions');
  const workspaceDir = path.join(testRoot, 'workspace');
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync(extensionsDir, { recursive: true });
  fs.rmSync(workspaceDir, { recursive: true, force: true });
  fs.cpSync(path.join(extensionDevelopmentPath, 'test-fixture'), workspaceDir, { recursive: true });
  const options = {
    ...resolveTestRuntime(),
    extensionDevelopmentPath,
    extensionTestsPath: path.join(__dirname, 'suite.js'),
    extensionTestsEnv: { AI_ZHAGAN_EXTENSION_TEST: '1' },
    launchArgs: [
      path.join(workspaceDir, 'integration.code-workspace'),
      '--disable-extensions',
      `--user-data-dir=${userDataDir}`,
      `--extensions-dir=${extensionsDir}`,
      '--skip-welcome',
      '--skip-release-notes',
    ],
  };
  await runTests(options);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
