'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const vscode = require('vscode');
const {
  ContextClient,
  buildContextPayload,
  normalizeServiceUrl,
  relativeWorkspacePath,
  requireEditorBufferSharing,
  validateProjectBinding,
} = require('./lib/core');
const { ServiceManager } = require('./lib/service-manager');
const {
  buildQuestionPrompt,
  runOnboarding,
  validateSelfHostedStatus,
} = require('./lib/onboarding');

const execFileAsync = promisify(execFile);

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
      const project = validateProjectBinding(
        await connection.client.getStatus(), projectId, folder.uri.fsPath,
      );
      requireEditorBufferSharing(project);
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

function managedRuntimePaths() {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const home = path.join(localAppData, 'AI Zhagan');
  return {
    executable: path.join(home, 'runtime', 'current', 'ai-zhagan.exe'),
    config: path.join(home, 'config.json'),
    log: path.join(home, '.local', 'server.log'),
  };
}

function projectIdFor(folder) {
  return `workspace-${crypto.createHash('sha256').update(folder.uri.fsPath).digest('hex').slice(0, 12)}`;
}

async function pairManagedRuntime(selectedFolder = null) {
  const binding = selectedFolder
    ? { folder: selectedFolder, config: folderConfiguration(selectedFolder) }
    : activeBinding(true);
  if (!binding) return;
  const paths = managedRuntimePaths();
  if (!fs.existsSync(paths.executable)) {
    throw new Error(`未安装受管理运行包：${paths.executable}`);
  }
  const projectId = projectIdFor(binding.folder);
  if (!fs.existsSync(paths.config)) {
    await execFileAsync(paths.executable, [
      'init', '--config', paths.config, '--project', binding.folder.uri.fsPath, '--id', projectId,
    ], { windowsHide: true });
  }
  const config = JSON.parse(fs.readFileSync(paths.config, 'utf8'));
  const serviceUrl = normalizeServiceUrl(`http://127.0.0.1:${config.admin_port}`);
  const manager = new ServiceManager({
    status: async () => {
      try {
        const response = await fetch(`${serviceUrl}/health`, { signal: AbortSignal.timeout(1500) });
        if (!response.ok) return null;
        const value = await response.json();
        if (value.service !== 'ai-zhagan') return null;
        return { serviceUrl, apiVersion: value.protocol_version, capabilities: value.capabilities || [] };
      } catch { return null; }
    },
    launch: async () => {
      try { await execFileAsync(paths.executable, ['start', '--config', paths.config], { windowsHide: true }); }
      catch (error) { throw new Error(`本机服务启动失败，请检查 ${paths.log}：${error.message}`); }
    },
  });
  await manager.ensureService();
  const paired = await execFileAsync(paths.executable, ['pair', '--config', paths.config], { windowsHide: true });
  const issued = JSON.parse(paired.stdout);
  const response = await fetch(`${serviceUrl}/api/pair`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pairing_code: issued.pairing_code }), signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error('本机配对码无效或已过期，请重试。');
  const credentials = await response.json();
  const client = new ContextClient(serviceUrl, credentials.admin_token);
  let status = await client.getStatus();
  let project = status.projects.find((item) => {
    try {
      validateProjectBinding({ projects: [item] }, item.id, binding.folder.uri.fsPath);
      return true;
    } catch { return false; }
  });
  if (!project) {
    await client.request('PUT', '/api/projects', {
      id: projectId, name: binding.folder.name, root: binding.folder.uri.fsPath,
    });
    status = await client.getStatus();
    project = status.projects.find((item) => item.id === projectId);
  }
  if (!project) throw new Error('本机服务未能登记当前工作区。');
  await saveConnection(binding.folder, serviceUrl, project.id, credentials.admin_token);
  setStatus('已连接', `${binding.folder.name} → ${project.name || project.id}`);
  vscode.window.showInformationMessage('AI Zhagan 本机服务已启动并完成安全配对。');
  return { serviceUrl, projectId: project.id, status, token: credentials.admin_token };
}

function onboardingFolder(value) {
  return (vscode.workspace.workspaceFolders || []).find(
    (folder) => folder.uri.toString() === value,
  );
}

async function runVsCodeOnboarding() {
  const stateKey = 'aiZhagan.onboarding.v1';
  const result = await runOnboarding({
    load: () => extensionContext.globalState.get(stateKey),
    save: (state) => extensionContext.globalState.update(stateKey, state),
    showPrerequisites: async () => {
      const choice = await vscode.window.showInformationMessage(
        '连接 ChatGPT 需要固定 HTTPS 地址、GitHub OAuth 和允许登录的账号。可以先完成本机项目配置，公网账号登录需由你本人操作。',
        { modal: true }, '继续配置', '打开快速开始',
      );
      if (choice === '打开快速开始') {
        await vscode.commands.executeCommand(
          'vscode.open', vscode.Uri.file(path.join(extensionContext.extensionPath, 'README.md')),
        );
      }
      return choice === '继续配置';
    },
    ensureRuntime: async () => {
      const paths = managedRuntimePaths();
      if (!fs.existsSync(paths.executable)) {
        throw new Error(`尚未安装受管理运行包：${paths.executable}`);
      }
    },
    listFolders: async () => (vscode.workspace.workspaceFolders || []).map((folder) => ({
      id: folder.uri.toString(), label: folder.name, folder,
    })),
    chooseFolder: async (folders) => vscode.window.showQuickPick(folders, {
      title: '第 1 步（共 3 步）：选择项目',
      placeHolder: '明确选择要授权的工作区文件夹',
    }),
    connect: async ({ folder }) => pairManagedRuntime(folder),
    isVerified: async (state) => {
      const folder = onboardingFolder(state.folderId);
      if (!folder) return false;
      const connection = await connectionFor(folder, folderConfiguration(folder));
      const status = await connection.client.getStatus();
      return status.health && status.health.tool_call && status.health.tool_call.state === 'ok';
    },
    presentTryQuestion: async (state) => {
      const folder = onboardingFolder(state.folderId);
      if (!folder) throw new Error('先前选择的工作区文件夹已关闭，请重新运行向导。');
      const connection = await connectionFor(folder, folderConfiguration(folder));
      const status = await connection.client.getStatus();
      const challenge = await connection.client.request(
        'POST', '/api/verification-challenges', { project_id: state.projectId },
      );
      const endpoint = `${status.public_url || `http://127.0.0.1:${status.mcp_port}`}/mcp`;
      const prompt = `请使用 AI Zhagan 调用 verify_connection，project_id=${state.projectId}，challenge_id=${challenge.challenge_id}。只返回工具实际结果。`;
      const prerequisites = validateSelfHostedStatus(status);
      const actions = [
        { label: '复制 MCP 地址', value: 'endpoint' },
        { label: '打开 ChatGPT', value: 'browser' },
        { label: '复制验证提示词', value: 'prompt' },
        { label: '查看连接详情', value: 'details' },
        { label: '稍后继续', value: 'close' },
      ];
      while (true) {
        const picked = await vscode.window.showQuickPick(actions, {
          title: '第 3 步（共 3 步）：试着问一个问题',
          placeHolder: '先复制地址和验证提示词，再由你在网页中完成调用',
        });
        if (!picked || picked.value === 'close') return;
        if (picked.value === 'endpoint') await vscode.env.clipboard.writeText(endpoint);
        if (picked.value === 'prompt') await vscode.env.clipboard.writeText(prompt);
        if (picked.value === 'browser') await vscode.env.openExternal(vscode.Uri.parse('https://chatgpt.com/'));
        if (picked.value === 'details') {
          const text = prerequisites.ready
            ? `公网接入前提已配置。验证挑战在 ${challenge.expires_at} 前有效。`
            : `本机读取可继续；ChatGPT 自托管连接还缺少：${prerequisites.problems.join('、')}。`;
          await vscode.window.showInformationMessage(text, { modal: true });
        }
      }
    },
  });
  if (result.status === 'completed') {
    const state = extensionContext.globalState.get(stateKey);
    const prompt = buildQuestionPrompt(state.projectId, '.');
    const action = await vscode.window.showInformationMessage(
      '三步配置已完成，可以开始提问。', '复制提问模板',
    );
    if (action === '复制提问模板') await vscode.env.clipboard.writeText(prompt);
  }
  return result;
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
  let cleanupError;
  try {
    await withBindingLock(binding.folder, async (key) => {
      try { await clearKeyContents(key); } catch (error) { cleanupError = error; }
      await extensionContext.secrets.delete(tokenKey(binding.folder));
      await Promise.all([
        binding.config.update('projectId', undefined, vscode.ConfigurationTarget.WorkspaceFolder),
        binding.config.update('serviceUrl', undefined, vscode.ConfigurationTarget.WorkspaceFolder),
      ]);
      try { await clearKeyContents(key); } catch (error) { cleanupError ||= error; }
    });
  } catch (error) { vscode.window.showWarningMessage(`服务端上下文清理失败：${error.message}`); }
  if (cleanupError) vscode.window.showWarningMessage(`服务端上下文清理失败：${cleanupError.message}`);
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
    vscode.commands.registerCommand('aiZhagan.onboarding', async () => {
      try {
        await runVsCodeOnboarding();
      } catch (error) {
        const choice = await vscode.window.showErrorMessage(
          'AI Zhagan 向导暂时无法继续。', '查看错误详情',
        );
        if (choice === '查看错误详情') {
          await vscode.window.showInformationMessage(String(error.message), { modal: true });
        }
      }
    }),
    vscode.commands.registerCommand('aiZhagan.pairManaged', () => pairManagedRuntime().catch((error) => {
      vscode.window.showErrorMessage(`AI Zhagan：${error.message}`);
    })),
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
      managedRuntimePaths,
      pairManagedRuntime,
      runVsCodeOnboarding,
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
