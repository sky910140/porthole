'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { runTests } = require('../../extensions/vscode/node_modules/@vscode/test-electron');

async function main() {
  const repositoryRoot = path.resolve(__dirname, '..', '..');
  const testRoot = path.join(repositoryRoot, 'extensions', 'vscode', '.integration-runtime', 'feasibility');
  const workspace = path.join(testRoot, 'workspace');
  fs.rmSync(testRoot, { recursive: true, force: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'target.txt'), 'before\r\n');
  const executable = process.env.VSCODE_EXECUTABLE_PATH || 'D:\\Program Files\\Microsoft VS Code\\Code.exe';
  await runTests({
    vscodeExecutablePath: executable,
    extensionDevelopmentPath: path.join(repositoryRoot, 'extensions', 'vscode'),
    extensionTestsPath: path.join(__dirname, 'editor-probe-suite.js'),
    extensionTestsEnv: { AI_ZHAGAN_FEASIBILITY_WORKSPACE: workspace },
    launchArgs: [workspace, '--disable-extensions', '--skip-welcome', '--skip-release-notes'],
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
