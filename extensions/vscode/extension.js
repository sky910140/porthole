'use strict';

const crypto = require('node:crypto');
const vscode = require('vscode');
const {
  ContextClient,
  buildContextPayload,
  normalizeServiceUrl,
  relativeWorkspacePath,
  validateProjectBinding,
} = require('./lib/core');

const TOKEN_PREFIX = 'aiZhagan.token:';
const DEFAULT_URL = 'http://127.0.0.1:8766';
const timers = new Map();
const publishedConnections = new Map();
const sessions = new Map();
const bindingGenerations = new Map();
const pendingAttempts = new Map();
const clearingKeys = new Set();
let statusBar;
let extensionContext;
let globalClosing = false;

function tokenKey(folder) {
  return `${TOKEN_PREFIX}${folder.uri.toString()}`;
}

function sessionFor(folder) {
  const key = folder.uri.toString();
  if (!sessions.has(key)) sessions.set(key, crypto.randomUUID());
  return sessions.get(key);
}

function generationFor(key) {
  return bindingGenerations.get(key) || 0;
}

function trackAttempt(key, attempt) {
  if (!pendingAttempts.has(key)) pendingAttempts.set(key, new Set());
  pendingAttempts.get(key).add(attempt);
}

function untrackAttempt(key, attempt) {
  const attempts = pendingAttempts.get(key);
  if (!attempts) return;
  attempts.delete(attempt);
  if (!attempts.size) pendingAttempts.delete(key);
}

function folderConfiguration(folder) {
  return vscode.workspace.getConfiguration('aiZhagan', folder.uri);
}

function activeBinding(showMessage = true) {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== 'file') {
    if (showMessage) vscode.window.showWarningMessage('请先打开工作区内的文件。');
    return null;
  }
  const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
  if (!folder) {
    if (showMessage) vscode.window.showWarningMessage('当前文件不属于已打开的工作区文件夹。');
    return null;
  }
  return { editor, folder, config: folderConfiguration(folder) };
}

function severityName(value) {
  return ['error', 'warning', 'information', 'hint'][value] || 'unknown';
}

async function connectionFor(folder, config) {
  const token = await extensionContext.secrets.get(tokenKey(folder));
  if (!token) throw new Error('缺少访问令牌，请运行“AI Zhagan: 配置连接”。');
  const serviceUrl = normalizeServiceUrl(config.get('serviceUrl', DEFAULT_URL));
  return { client: new ContextClient(serviceUrl, token), serviceUrl, token };
}

function setStatus(text, tooltip, command = 'aiZhagan.publishContext') {
  statusBar.text = `$(broadcast) AI Zhagan: ${text}`;
  statusBar.tooltip = tooltip;
  statusBar.command = command;
  statusBar.show();
}

async function publishActiveContext(options = {}) {
  const binding = activeBinding(!options.silent);
  if (!binding) return;
  const { editor, folder, config } = binding;
  const projectId = config.get('projectId', '').trim();
  if (!projectId) {
    setStatus('未配置', '点击配置工作区连接', 'aiZhagan.configure');
    if (!options.silent) vscode.window.showWarningMessage('当前工作区文件夹未绑定项目，请先配置连接。', '配置').then((choice) => choice === '配置' && vscode.commands.executeCommand('aiZhagan.configure'));
    return;
  }
  try {
    const bindingKey = folder.uri.toString();
    if (globalClosing || clearingKeys.has(bindingKey)) return;
    const generation = generationFor(bindingKey);
    const relativePath = relativeWorkspacePath(folder.uri.fsPath, editor.document.uri.fsPath);
    const diagnostics = vscode.languages.getDiagnostics(editor.document.uri).map((diagnostic) => ({
      line: diagnostic.range.start.line,
      severity: severityName(diagnostic.severity),
      message: diagnostic.message,
    }));
    const selection = editor.selection.isEmpty ? null : {
      startLine: editor.selection.start.line,
      endLine: editor.selection.end.line,
      text: editor.document.getText(editor.selection),
    };
    const payload = buildContextPayload({
      projectId,
      sessionId: sessionFor(folder),
      relativePath,
      version: editor.document.version,
      text: editor.document.getText(),
      selection,
      diagnostics,
    });
    const connection = await connectionFor(folder, config);
    if (globalClosing || clearingKeys.has(bindingKey) || generation !== generationFor(bindingKey)) return;
    const attempt = { ...connection, sessionId: sessionFor(folder), promise: null };
    trackAttempt(bindingKey, attempt);
    attempt.promise = (async () => {
      validateProjectBinding(await connection.client.getStatus(), projectId, folder.uri.fsPath);
      if (globalClosing || clearingKeys.has(bindingKey) || generation !== generationFor(bindingKey)) return false;
      await connection.client.putContext(payload);
      return true;
    })();
    let uploaded;
    try { uploaded = await attempt.promise; } finally { untrackAttempt(bindingKey, attempt); }
    if (!uploaded || generation !== generationFor(bindingKey)) return;
    publishedConnections.set(bindingKey, attempt);
    setStatus('已同步', `${relativePath} · 版本 ${editor.document.version}`);
    if (!options.silent) vscode.window.showInformationMessage(`AI Zhagan 已同步 ${relativePath}`);
  } catch (error) {
    setStatus('同步失败', error.message, 'aiZhagan.configure');
    if (!options.silent) vscode.window.showErrorMessage(`AI Zhagan：${error.message}`, '重新配置').then((choice) => choice === '重新配置' && vscode.commands.executeCommand('aiZhagan.configure'));
  }
}

function scheduleAutoSync(document) {
  const binding = activeBinding(false);
  if (!binding || binding.editor.document !== document || !binding.config.get('autoSync', false)) return;
  const key = binding.folder.uri.toString();
  if (globalClosing || clearingKeys.has(key)) return;
  clearTimeout(timers.get(key));
  const delay = binding.config.get('debounceMs', 750);
  timers.set(key, setTimeout(() => {
    timers.delete(key);
    const current = activeBinding(false);
    if (globalClosing || clearingKeys.has(key) || !current || current.editor.document !== document || current.folder.uri.toString() !== key || !current.config.get('autoSync', false)) return;
    publishActiveContext({ silent: true });
  }, delay));
}

function cancelScheduledSyncs() {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
}

function cancelScheduledSync(key) {
  clearTimeout(timers.get(key));
  timers.delete(key);
}

async function configure() {
  const binding = activeBinding(true);
  if (!binding) return;
  const { folder, config } = binding;
  const serviceInput = await vscode.window.showInputBox({
    title: `配置 ${folder.name}`,
    prompt: '本机服务地址',
    value: config.get('serviceUrl', DEFAULT_URL),
    validateInput: (value) => { try { normalizeServiceUrl(value); return null; } catch (error) { return error.message; } },
  });
  if (serviceInput === undefined) return;
  const token = await vscode.window.showInputBox({ title: `配置 ${folder.name}`, prompt: 'Bearer 访问令牌（仅保存到 VS Code SecretStorage）', password: true, ignoreFocusOut: true });
  if (!token) return;
  const serviceUrl = normalizeServiceUrl(serviceInput);
  let status;
  try {
    status = await new ContextClient(serviceUrl, token).getStatus();
  } catch (error) {
    vscode.window.showErrorMessage(`连接验证失败：${error.message}`);
    return;
  }
  const projects = (Array.isArray(status.projects) ? status.projects : []).filter((project) => {
    try { validateProjectBinding({ projects: [project] }, project.id, folder.uri.fsPath); return true; } catch { return false; }
  });
  if (!projects.length) {
    vscode.window.showErrorMessage('本机服务没有根目录与当前工作区文件夹匹配的项目。');
    return;
  }
  const selected = await vscode.window.showQuickPick(projects.map((project) => ({ label: project.name || project.id, description: project.id, projectId: project.id })), {
    title: `将工作区文件夹“${folder.name}”绑定到项目`,
    placeHolder: '选择项目',
  });
  if (!selected) return;
  await saveConnection(folder, serviceUrl, String(selected.projectId), token);
  setStatus('已连接', `${folder.name} → ${selected.label}`);
  vscode.window.showInformationMessage(`已绑定 ${folder.name}；请运行“发布当前编辑上下文”进行首次同步。`);
}

async function saveConnection(folder, serviceUrl, projectId, token) {
  return withBindingLock(folder, async (key) => {
    const normalizedUrl = normalizeServiceUrl(serviceUrl);
    const status = await new ContextClient(normalizedUrl, token).getStatus();
    validateProjectBinding(status, projectId, folder.uri.fsPath);
    await clearKeyContents(key);
    const config = folderConfiguration(folder);
    await Promise.all([
      config.update('serviceUrl', normalizedUrl, vscode.ConfigurationTarget.WorkspaceFolder),
      config.update('projectId', String(projectId), vscode.ConfigurationTarget.WorkspaceFolder),
      extensionContext.secrets.store(tokenKey(folder), token),
    ]);
    await clearKeyContents(key);
  });
}

async function clearKeyContents(key) {
  const attempts = [...(pendingAttempts.get(key) || [])];
  await Promise.allSettled(attempts.map((attempt) => attempt.promise).filter(Boolean));
  const candidates = [...attempts, publishedConnections.get(key)].filter(Boolean);
  const unique = new Map(candidates.map((item) => [`${item.serviceUrl}\0${item.sessionId}`, item]));
  const results = await Promise.allSettled([...unique.values()].map(({ client, sessionId }) => client.deleteContext(sessionId)));
  publishedConnections.delete(key);
  const failure = results.find((result) => result.status === 'rejected');
  if (failure) throw failure.reason;
}

async function withBindingLock(folder, action) {
  const key = folder.uri.toString();
  if (clearingKeys.has(key)) throw new Error('该工作区连接正在更新，请稍后重试。');
  clearingKeys.add(key);
  cancelScheduledSync(key);
  bindingGenerations.set(key, generationFor(key) + 1);
  try { return await action(key); } finally { clearingKeys.delete(key); }
}

async function clearAllBindings() {
  const keys = new Set([...bindingGenerations.keys(), ...pendingAttempts.keys(), ...publishedConnections.keys()]);
  for (const key of keys) {
    clearingKeys.add(key);
    cancelScheduledSync(key);
    bindingGenerations.set(key, generationFor(key) + 1);
  }
  const results = await Promise.allSettled([...keys].map(clearKeyContents));
  const failure = results.find((result) => result.status === 'rejected');
  if (failure) throw failure.reason;
}

async function disconnect() {
  const binding = activeBinding(true);
  if (!binding) return;
  try {
    await withBindingLock(binding.folder, async (key) => {
      await clearKeyContents(key);
      await extensionContext.secrets.delete(tokenKey(binding.folder));
      await Promise.all([
        binding.config.update('projectId', undefined, vscode.ConfigurationTarget.WorkspaceFolder),
        binding.config.update('serviceUrl', undefined, vscode.ConfigurationTarget.WorkspaceFolder),
      ]);
      await clearKeyContents(key);
    });
  } catch (error) { vscode.window.showWarningMessage(`服务端上下文清理失败：${error.message}`); }
  setStatus('已断开', '点击配置工作区连接', 'aiZhagan.configure');
}

async function openAssistant() {
  const target = await vscode.window.showQuickPick([
    { label: 'ChatGPT', url: 'https://chatgpt.com/' },
    { label: 'Claude', url: 'https://claude.ai/' },
  ], { title: '在 VS Code 内置浏览器中打开' });
  if (!target) return;
  const commands = await vscode.commands.getCommands(true);
  if (!commands.includes('workbench.action.browser.open')) {
    vscode.window.showInformationMessage(`当前 VS Code 没有可用的内置浏览器命令。请在系统浏览器中访问 ${target.url}`);
    return;
  }
  await vscode.commands.executeCommand('workbench.action.browser.open', target.url);
}

function activate(context) {
  extensionContext = context;
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 20);
  setStatus('未同步', '点击发布当前编辑上下文');
  context.subscriptions.push(
    statusBar,
    vscode.commands.registerCommand('aiZhagan.configure', configure),
    vscode.commands.registerCommand('aiZhagan.publishContext', () => publishActiveContext()),
    vscode.commands.registerCommand('aiZhagan.disconnect', disconnect),
    vscode.commands.registerCommand('aiZhagan.openAssistant', openAssistant),
    vscode.workspace.onDidChangeTextDocument((event) => scheduleAutoSync(event.document)),
    vscode.window.onDidChangeTextEditorSelection((event) => scheduleAutoSync(event.textEditor.document)),
    vscode.window.onDidChangeActiveTextEditor(cancelScheduledSyncs),
    vscode.languages.onDidChangeDiagnostics((event) => {
      const editor = vscode.window.activeTextEditor;
      if (editor && event.uris.some((uri) => uri.toString() === editor.document.uri.toString())) scheduleAutoSync(editor.document);
    }),
  );
  if (process.env.AI_ZHAGAN_EXTENSION_TEST === '1') {
    return {
      configureConnection: saveConnection,
      getStoredToken: (folder) => context.secrets.get(tokenKey(folder)),
      publishActiveContext,
      disconnect,
      getSessionId: sessionFor,
    };
  }
}

async function deactivate() {
  globalClosing = true;
  cancelScheduledSyncs();
  try { await clearAllBindings(); } catch { /* VS Code is closing; cleanup is best effort. */ }
}

module.exports = { activate, deactivate };
