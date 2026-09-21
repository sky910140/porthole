'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { resolveTestRuntime, resolveVsCodeExecutable } = require('../integration/runtime');

test('uses an explicitly configured VS Code executable', () => {
  assert.equal(
    resolveVsCodeExecutable({ VSCODE_EXECUTABLE_PATH: 'C:\\VSCode\\Code.exe' }),
    'C:\\VSCode\\Code.exe',
  );
});

test('lets the test runner download its pinned VS Code when no executable is configured', () => {
  assert.equal(resolveVsCodeExecutable({}), undefined);
  assert.deepEqual(resolveTestRuntime({}), { version: '1.138.0' });
});

test('does not request a downloaded version when an executable is configured', () => {
  assert.deepEqual(
    resolveTestRuntime({ VSCODE_EXECUTABLE_PATH: 'C:\\VSCode\\Code.exe' }),
    { vscodeExecutablePath: 'C:\\VSCode\\Code.exe' },
  );
});
