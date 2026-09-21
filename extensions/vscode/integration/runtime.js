'use strict';

function resolveVsCodeExecutable(environment = process.env) {
  const configured = environment.VSCODE_EXECUTABLE_PATH;
  return configured && configured.trim() ? configured.trim() : undefined;
}

function resolveTestRuntime(environment = process.env) {
  const vscodeExecutablePath = resolveVsCodeExecutable(environment);
  if (vscodeExecutablePath) return { vscodeExecutablePath };
  return { version: environment.VSCODE_TEST_VERSION || '1.138.0' };
}

module.exports = { resolveTestRuntime, resolveVsCodeExecutable };
