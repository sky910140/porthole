'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { AsyncLocalStorage } = require('node:async_hooks');
const vscode = require('vscode');
const {
  ContextClient,
  buildContextPayload,
  normalizeServiceUrl,
  relativeWorkspacePath,
  requireEditorBufferSharing,
  validateProjectBinding,
} = require('./lib/core');
const { ChangeActionRunner, createChangeClient, reviewChoices } = require('./lib/changes');
const { buildReadinessPayload } = require('./lib/readiness');
const { ReconnectBackoff, RestartPolicy, ServiceManager, installBundledRuntime, installedBundleHealthy, validateBundle } = require('./lib/service-manager');
const { prepareMigration, executeMigration, managedStatus } = require('./lib/web-migration');
const { prepareWebSetup, probePublicEndpoint, preflightWebConnection, resolveGithubOwner,
  executeWebSetup } = require('./lib/web-setup');
const { validateTunnelId, preparePrivateTunnelConfig, ensureTunnelClient,
  startTunnelClient, stopTunnelClient } = require('./lib/private-tunnel');
const { readTunnelHealth, probeLocalMcp, recoveryAction, tunnelIssue } = require('./lib/tunnel-checks');
const { ConnectionWizard, safeSetupIssue } = require('./lib/connection-wizard');
const { connectionWizardHtml } = require('./lib/connection-wizard-ui');
const { hasLoginStartup, setLoginStartup } = require('./lib/startup');
const { classifyConnection } = require('./lib/diagnostics');
const { upgradeManagedBundle } = require('./lib/upgrade-flow');
const { projectIdForPath, projectChoice, projectPolicyChange, normalizedRoot } = require('./lib/projects');
const { deriveHomeView, homeHtml } = require('./lib/home');
const { InitialReset, collectResetKeys, mergeResetKeys, observeResetReceipt,
  readResetFiles, safeResetIssue, visibleResetState } = require('./lib/initial-reset');
const { withProfileLease, profileGenerationGuard } = require('./lib/profile-edit');
const {
  buildQuestionPrompt,
  runOnboarding,
  validateSelfHostedStatus,
} = require('./lib/onboarding');

const execFileAsync = promisify(execFile);

const TOKEN_PREFIX = 'porthole.token:';
const MANAGED_TOKEN_KEY = 'porthole.managedAdminToken';
const GITHUB_CLIENT_ID_KEY = 'porthole.githubClientId';
const GITHUB_CLIENT_SECRET_KEY = 'porthole.githubClientSecret';
const PRIVATE_TUNNEL_KEY = 'porthole.privateTunnelApiKey';
const PRIVATE_TUNNEL_ID = 'porthole.privateTunnelId';
const PREVIOUS_WEB_CONFIG = 'porthole.previousWebConfig';
const DEFAULT_URL = 'http://127.0.0.1:8766';
const timers = new Map();
const publishedConnections = new Map();
const sessions = new Map();
const bindingGenerations = new Map();
const pendingAttempts = new Map();
const clearingKeys = new Set();
const changeReviews = new Map();
const virtualChangeContents = new Map();
let statusBar;
let extensionContext;
let globalClosing = false;
let homePanel;
let homeChallenge;
let homeSelectedProjectId;
let managedInstallPromise;
let managedRecoveryPromise;
let tunnelHandle;
let tunnelStartPromise;
let tunnelLastError;
let tunnelLastIssue;
let wizardPanel;
let connectionWizard;
let tunnelRecoveryPromise;
const managedRestartPolicy = new RestartPolicy();
const tunnelRestartPolicy = new RestartPolicy();
const homeScopePreviews = new Map();
let homeDiagnosis;
let initialReset;
let homeResetState;
let resetLocallyPaused = false;
let resetObservedId = null;
let resetObservationPromise;
let secretRegistryPromise = Promise.resolve();
const bindingWritePromises = new Set();
let homeMutationCount = 0;
const profileEdits = new AsyncLocalStorage();

async function withManagedProfileEdit(action) {
  const existing = profileEdits.getStore();
  requireNoReset();
  const paths = managedRuntimePaths();
  if (existing && (existing.hasLease || !fs.existsSync(paths.config))) { existing(); return action(existing); }
  if (!fs.existsSync(paths.config)) {
    const guard = profileGenerationGuard(paths.config);
    return profileEdits.run(guard, () => action(guard));
  }
  const bundle = path.join(extensionContext.extensionPath, 'runtime-bundle');
  validateBundle(bundle, require('./package.json').version);
  return withProfileLease({ executable: path.join(bundle, 'payload', 'porthole.exe'), config: paths.config },
    (guard) => { guard.hasLease = true; return profileEdits.run(guard, () => action(guard)); });
}

function guardProfileEdit() {
  requireNoReset();
  profileEdits.getStore()?.();
}

function resetIsBlocked() {
  const files = readResetFiles(managedRuntimePaths().config);
  return resetLocallyPaused || files.pending || Boolean(extensionContext?.globalState.get('porthole.resetPending'))
    || Boolean(files.receipt && files.receipt.reset_id !== resetObservedId);
}

function requireNoReset() {
  if (resetIsBlocked()) throw Object.assign(new Error('恢复初始状态尚未完成，请在首页继续恢复。'), { code: 'RESET_BUSY' });
}

function pauseResetWindow() {
  resetLocallyPaused = true;
  managedRestartPolicy.pause(); tunnelRestartPolicy.pause();
  cancelScheduledSyncs();
  const keys = new Set([...bindingGenerations.keys(), ...pendingAttempts.keys(), ...publishedConnections.keys()]);
  for (const key of keys) bindingGenerations.set(key, generationFor(key) + 1);
  homeChallenge = undefined; homeSelectedProjectId = undefined; homeDiagnosis = undefined;
  homeScopePreviews.clear(); changeReviews.clear(); virtualChangeContents.clear(); sessions.clear();
  wizardPanel?.dispose(); wizardPanel = undefined; connectionWizard = undefined;
}

async function clearResetWindow() {
  pauseResetWindow();
  if (tunnelStartPromise) { try { await tunnelStartPromise; } catch { /* The start is gated. */ } }
  if (tunnelHandle) { await stopTunnelClient(tunnelHandle); tunnelHandle = undefined; }
  const attempts = [...pendingAttempts.values()].flatMap((values) => [...values].map((attempt) => attempt.promise));
  await Promise.allSettled(attempts.filter(Boolean));
  pendingAttempts.clear(); publishedConnections.clear(); clearingKeys.clear();
  for (const folder of vscode.workspace.workspaceFolders || []) {
    await extensionContext.secrets.delete(tokenKey(folder));
    const config = folderConfiguration(folder);
    for (const name of ['projectId', 'serviceUrl', 'autoSync']) {
      const inspected = config.inspect(name);
      for (const [property, target] of [['workspaceFolderValue', vscode.ConfigurationTarget.WorkspaceFolder],
        ['workspaceValue', vscode.ConfigurationTarget.Workspace], ['globalValue', vscode.ConfigurationTarget.Global]]) {
        if (inspected?.[property] !== undefined) await config.update(name, undefined, target);
      }
    }
  }
}

async function observeResetState() {
  if (resetObservationPromise) return resetObservationPromise;
  resetObservationPromise = (async () => {
    const files = readResetFiles(managedRuntimePaths().config);
    if (files.pending && !initialReset?.running) {
      pauseResetWindow();
      if (tunnelHandle) { await stopTunnelClient(tunnelHandle); tunnelHandle = undefined; }
    }
    if (!initialReset?.running) await observeResetReceipt(files.receipt, {
      observedId: resetObservedId, clear: clearResetWindow,
      ack: async (id) => {
        await extensionContext.globalState.update('porthole.manualServiceStop', true);
        await extensionContext.globalState.update('porthole.manualTunnelStop', true);
        await extensionContext.globalState.update('porthole.resetSeenId', id);
        resetObservedId = id;
        resetLocallyPaused = files.pending || Boolean(extensionContext.globalState.get('porthole.resetPending'));
      },
      failed: async (id) => {
        pauseResetWindow();
        initialReset = undefined;
        homeResetState = { phase: 'failed', step: 'clearExtension', resetId: id,
          external: { chatgpt: true }, issue: safeResetIssue({ code: 'RESET_FAILED' }) };
        await extensionContext.globalState.update('porthole.resetPending', homeResetState);
      },
    });
    const current = readResetFiles(managedRuntimePaths().config);
    if (!initialReset?.running && current.receipt?.reset_id === resetObservedId
      && !current.pending && !extensionContext.globalState.get('porthole.resetPending')) {
      resetLocallyPaused = false;
    }
    return current;
  })().finally(() => { resetObservationPromise = undefined; });
  return resetObservationPromise;
}

async function rememberSecretKey(key) {
  secretRegistryPromise = secretRegistryPromise.catch(() => {}).then(async () => {
    const keys = extensionContext.globalState.get('porthole.secretKeys') || [];
    await extensionContext.globalState.update('porthole.secretKeys', [...new Set([...keys, key])]);
  });
  await secretRegistryPromise;
}

async function resetCommand(command) {
  const paths = managedRuntimePaths();
  // Use the verified bundled command without changing the installed runtime version.
  const bundleRoot = path.join(extensionContext.extensionPath, 'runtime-bundle');
  validateBundle(bundleRoot, require('./package.json').version);
  const executable = path.join(bundleRoot, 'payload', 'porthole.exe');
  try {
    const result = await execFileAsync(executable, [command, '--config', paths.config], {
      windowsHide: true, timeout: 60000, maxBuffer: 1024 * 1024,
    });
    return JSON.parse(result.stdout);
  } catch (error) {
    const code = String(error.stderr || '').match(/RESET_[A-Z_]+/)?.[0] || 'RESET_FAILED';
    throw Object.assign(new Error(safeResetIssue({ code }).message), { code });
  }
}

async function restoreInitialState(confirmForTest) {
  if (!initialReset || initialReset.state.phase === 'blocked') {
    const paths = managedRuntimePaths();
    let resetKeys;
    initialReset = new InitialReset({
      load: () => extensionContext.globalState.get('porthole.resetPending'),
      save: async (state) => {
        if (state.phase === 'complete') {
          await extensionContext.globalState.update('porthole.resetResult', state);
          await extensionContext.globalState.update('porthole.resetSeenId', state.resetId);
          await extensionContext.globalState.update('porthole.resetPending', undefined);
          await extensionContext.globalState.update('porthole.resetCleanup', undefined);
          resetLocallyPaused = false;
        } else await extensionContext.globalState.update('porthole.resetPending', state);
      },
      confirm: async () => process.env.PORTHOLE_EXTENSION_TEST === '1' && typeof confirmForTest === 'function'
        ? confirmForTest() : await vscode.window.showWarningMessage(
        '恢复初始状态？将移除全部本机项目授权和连接设置，清除本机保存的 OAuth/Tunnel 凭据，停止服务并关闭开机启动。安装、源码、业务文件、修改历史和恢复备份会保留。ChatGPT、GitHub 和 OpenAI 的外部连接仍需单独处理。',
        { modal: true }, '恢复初始状态',
      ) === '恢复初始状态',
      preflight: async () => {
        if (managedInstallPromise || tunnelStartPromise || connectionWizard?.state.busy
          || bindingWritePromises.size || homeMutationCount) {
          throw Object.assign(new Error('Operation in progress'), { code: 'RESET_BUSY' });
        }
        let config = {};
        try { config = JSON.parse(fs.readFileSync(paths.config, 'utf8')); } catch { /* Core reports malformed config. */ }
        const folderUris = [...(vscode.workspace.workspaceFolders || []).map((folder) => folder.uri.toString()),
          ...(config.projects || []).map((project) => vscode.Uri.file(project.root).toString())];
        resetKeys = mergeResetKeys(extensionContext.globalState.get('porthole.resetCleanup'),
          collectResetKeys({ globalKeys: extensionContext.globalState.keys(),
            knownSecretKeys: extensionContext.globalState.get('porthole.secretKeys') || [], folderUris }));
        const external = extensionContext.globalState.get('porthole.resetPending')?.external || {
          chatgpt: true,
          github: config.auth_mode === 'github' || Boolean(extensionContext.globalState.get(PREVIOUS_WEB_CONFIG)),
          openai: Boolean(extensionContext.globalState.get(PRIVATE_TUNNEL_ID)),
        };
        const result = await resetCommand('reset-check');
        if (result.ready !== true) throw new Error('Preflight rejected');
        return { external };
      },
      suspend: async () => {
        await extensionContext.globalState.update('porthole.resetCleanup', resetKeys);
        pauseResetWindow();
        await extensionContext.globalState.update('porthole.manualServiceStop', true);
        await extensionContext.globalState.update('porthole.manualTunnelStop', true);
        await Promise.allSettled([managedRecoveryPromise, tunnelRecoveryPromise].filter(Boolean));
      },
      disableStartup: async () => setLoginStartup(false, paths.executable, paths.config, execFileAsync),
      stopTunnel: async () => {
        if (tunnelHandle) { await stopTunnelClient(tunnelHandle); tunnelHandle = undefined; }
      },
      resetCore: () => resetCommand('reset-local'),
      clearExtension: async () => {
        await clearResetWindow();
        await secretRegistryPromise;
        for (const key of resetKeys.secretKeys) await extensionContext.secrets.delete(key);
        for (const key of resetKeys.globalKeys) await extensionContext.globalState.update(key, undefined);
        // A no-folder window can still have a global default connection.
        const config = vscode.workspace.getConfiguration('porthole');
        for (const name of ['projectId', 'serviceUrl', 'autoSync']) {
          const inspected = config.inspect(name);
          if (inspected?.globalValue !== undefined) await config.update(name, undefined, vscode.ConfigurationTarget.Global);
          if (inspected?.workspaceValue !== undefined) await config.update(name, undefined, vscode.ConfigurationTarget.Workspace);
        }
        tunnelLastError = undefined; tunnelLastIssue = undefined;
      },
      verify: async () => {
        const files = readResetFiles(paths.config);
        const config = JSON.parse(fs.readFileSync(paths.config, 'utf8'));
        if (files.pending || !files.receipt || config.projects?.length || config.auth_mode !== 'local'
          || config.public_url || config.github_user_ids?.length || tunnelHandle?.running
          || await managedStatus(paths.config) || await hasLoginStartup(paths.executable, paths.config, execFileAsync)) {
          throw new Error('Reset verification failed');
        }
        for (const key of resetKeys.secretKeys) {
          if (await extensionContext.secrets.get(key)) throw new Error('Credential purge incomplete');
        }
        resetObservedId = files.receipt.reset_id;
      },
      notify: (state) => { homeResetState = state; void refreshHome(); },
    });
  }
  const result = await initialReset.run();
  if (result.phase === 'complete') setStatus('选择项目', '本机授权和连接设置已清除；点击重新选择项目');
  await refreshHome();
  return result;
}

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
  return vscode.workspace.getConfiguration('porthole', folder.uri);
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
  requireNoReset();
  const token = await extensionContext.secrets.get(tokenKey(folder));
  if (!token) throw new Error('缺少访问令牌，请运行“舷窗: 配置连接”。');
  const serviceUrl = normalizeServiceUrl(config.get('serviceUrl', DEFAULT_URL));
  return { client: new ContextClient(serviceUrl, token), serviceUrl, token };
}

function setStatus(text, tooltip, command = 'porthole.home') {
  statusBar.text = `$(broadcast) 舷窗: ${text}`;
  statusBar.tooltip = tooltip;
  statusBar.command = command;
  statusBar.show();
}

function reviewForChange(changeId) {
  return [...changeReviews.values()].find(
    (review) => !changeId || review.change.change_id === changeId,
  );
}

function changeIdFromArgument(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value.change_id === 'string') return value.change_id;
  return '';
}

async function publishReviewReadiness(review) {
  const current = changeReviews.get(review.key);
  if (current !== review || globalClosing || clearingKeys.has(review.key)) return false;
  const payload = buildReadinessPayload({
    projectId: review.change.project_id,
    sessionId: review.sessionId,
    rootPath: review.folder.uri.fsPath,
    documents: vscode.workspace.textDocuments,
    review: {
      change_id: review.change.change_id,
      manifest_sha256: review.change.manifest_sha256,
    },
  });
  await review.client.updateReadiness(review.sessionId, payload);
  return true;
}

async function clearReview(key) {
  const review = changeReviews.get(key);
  if (!review) return;
  changeReviews.delete(key);
  clearTimeout(review.heartbeat);
  review.reconnect.pause();
  for (const uri of review.virtualUris) virtualChangeContents.delete(uri.toString());
  try { await review.client.deleteReadiness(review.sessionId); } catch { /* Best effort during disconnect. */ }
}

function scheduleReviewHeartbeat(review, delay = 2000) {
  clearTimeout(review.heartbeat);
  review.heartbeat = setTimeout(async () => {
    if (changeReviews.get(review.key) !== review) return;
    try {
      await publishReviewReadiness(review);
      review.reconnect.resetAfterWake();
      scheduleReviewHeartbeat(review);
    } catch (error) {
      if (error && (error.status === 401 || error.status === 403)) {
        review.reconnect.authenticationFailed();
        return;
      }
      review.reconnect.schedule(() => scheduleReviewHeartbeat(review, 0));
    }
  }, delay);
}

function virtualChangeUri(scheme, change, file) {
  const uri = vscode.Uri.from({
    scheme,
    path: `/${change.change_id}/${file.path}`,
    query: `manifest=${change.manifest_sha256}`,
  });
  return uri;
}

async function configuredChange(changeId) {
  const folders = vscode.workspace.workspaceFolders || [];
  const active = activeBinding(false);
  const ordered = active
    ? [active.folder, ...folders.filter((folder) => folder !== active.folder)]
    : folders;
  let lastError;
  for (const folder of ordered) {
    const config = folderConfiguration(folder);
    if (!config.get('projectId', '').trim()) continue;
    try {
      const connection = await connectionFor(folder, config);
      const client = createChangeClient(connection.client);
      const change = await client.get(changeId);
      if (change.project_id !== config.get('projectId', '').trim()) continue;
      return { folder, client, change };
    } catch (error) { lastError = error; }
  }
  throw lastError || new Error('没有已连接工作区可读取该修改建议。');
}

async function showChange(argument) {
  let changeId = changeIdFromArgument(argument);
  if (!changeId) {
    const groups = [];
    for (const folder of vscode.workspace.workspaceFolders || []) {
      const config = folderConfiguration(folder);
      const projectId = config.get('projectId', '').trim();
      if (!projectId) continue;
      try {
        const connection = await connectionFor(folder, config);
        const history = await createChangeClient(connection.client).list(projectId);
        groups.push({
          projectId, folderName: folder.name,
          changes: Array.isArray(history.changes) ? history.changes : [],
        });
      } catch { /* A disconnected folder cannot offer local history. */ }
    }
    const choices = reviewChoices(groups);
    if (choices.length) {
      const selected = await vscode.window.showQuickPick([
        ...choices,
        { label: '输入网页返回的修改编号…', description: '列表中没有时使用', changeId: null },
      ], { title: '查看修改建议', placeHolder: '选择待审阅修改' });
      if (!selected) return;
      changeId = selected.changeId;
    }
    if (!changeId) {
      changeId = await vscode.window.showInputBox({
        title: '查看修改建议', prompt: '输入网页返回的修改编号',
        validateInput: (value) => value.trim() ? null : '请输入修改编号。',
      });
    }
  }
  if (!changeId) return;
  const { folder, client, change } = await configuredChange(changeId.trim());
  const key = folder.uri.toString();
  await clearReview(key);
  const review = {
    key, folder, client, change, sessionId: sessionFor(folder), virtualUris: [],
    actions: null, heartbeat: null, reconnect: new ReconnectBackoff(),
  };
  review.actions = new ChangeActionRunner(client);
  changeReviews.set(key, review);
  await publishReviewReadiness(review);
  for (const file of change.files) {
    let original;
    if (file.operation === 'create') {
      original = virtualChangeUri('porthole-original', change, file);
      virtualChangeContents.set(original.toString(), '');
      review.virtualUris.push(original);
    } else {
      original = vscode.Uri.joinPath(folder.uri, ...file.path.split('/'));
    }
    const proposed = virtualChangeUri('porthole-proposed', change, file);
    virtualChangeContents.set(proposed.toString(), file.content_utf8);
    review.virtualUris.push(proposed);
    await vscode.commands.executeCommand(
      'vscode.diff', original, proposed,
      `${change.project_id} · ${file.path} · 修改建议`, { preview: false },
    );
  }
  scheduleReviewHeartbeat(review);
  setStatus('待审阅', `${change.project_id} · ${change.change_id}`, 'porthole.applyReviewedChange');
  vscode.window.showInformationMessage(
    `已打开 ${change.files.length} 个文件的修改差异。本地文件尚未改变。`,
    '应用已审阅修改', '拒绝建议',
  ).then((choice) => {
    if (choice === '应用已审阅修改') {
      vscode.commands.executeCommand('porthole.applyReviewedChange', change.change_id);
    }
    if (choice === '拒绝建议') {
      vscode.commands.executeCommand('porthole.rejectChange', change.change_id);
    }
  });
  return change;
}

async function applyReviewedChange(argument, manifestSha256) {
  const changeId = changeIdFromArgument(argument);
  const review = reviewForChange(changeId);
  if (!review) throw new Error('请先运行“查看修改建议”并检查差异。');
  if (manifestSha256 && manifestSha256 !== review.change.manifest_sha256) {
    throw new Error('审阅内容已变化，请重新打开修改建议。');
  }
  await publishReviewReadiness(review);
  const result = await review.actions.apply(review.change, review.sessionId);
  review.change = { ...review.change, ...result };
  if (result.state === 'applied') {
    review.change = await review.client.get(review.change.change_id);
    setStatus('已应用，未测试', `${review.change.project_id} · ${review.change.change_id}`);
    const undo = review.change.undo_available && review.change.undo_expires_at
      ? `可撤销至 ${new Date(review.change.undo_expires_at).toLocaleString()}。` : '当前没有可用撤销备份。';
    vscode.window.showInformationMessage(`修改已应用，尚未运行项目测试。${undo}`);
  }
  return result;
}

async function rejectReviewedChange(argument) {
  const review = reviewForChange(changeIdFromArgument(argument));
  if (!review) throw new Error('请先打开要拒绝的修改建议。');
  const result = await review.actions.reject(review.change);
  review.change = { ...review.change, ...result };
  setStatus('已拒绝', review.change.change_id);
  return result;
}

async function revertReviewedChange(argument) {
  const review = reviewForChange(changeIdFromArgument(argument));
  if (!review) throw new Error('请先打开要撤销的修改记录。');
  await publishReviewReadiness(review);
  const result = await review.actions.revert(review.change, review.sessionId);
  review.change = { ...review.change, ...result };
  setStatus('已撤销', review.change.change_id);
  return result;
}

async function viewRecovery(argument) {
  const review = reviewForChange(changeIdFromArgument(argument));
  if (!review) throw new Error('请先打开需要恢复的修改记录。');
  const current = await review.client.get(review.change.change_id);
  review.change = current;
  await vscode.window.showInformationMessage(
    current.state === 'recovery_required'
      ? `修改 ${current.change_id} 需要恢复：${current.blocked_reason || '请先核对项目文件。'}`
      : `修改 ${current.change_id} 当前状态：${current.state}`,
    { modal: true },
  );
  return current;
}

async function showRecentActivity() {
  const binding = activeBinding(true);
  if (!binding) return;
  const connection = await connectionFor(binding.folder, binding.config);
  const result = await createChangeClient(connection.client).activity();
  const events = (result.events || []).slice(-50).reverse();
  if (!events.length) {
    await vscode.window.showInformationMessage('当前没有修改活动记录。');
    return [];
  }
  await vscode.window.showQuickPick(events.map((event) => ({
    label: event.event_type,
    description: event.change_id || event.request_id || '无编号',
    detail: `${event.error_code || '完成'} · ${event.duration_ms} ms · ${event.recorded_at}`,
  })), { title: 'Porthole 最近活动', placeHolder: '活动记录不包含源码正文或令牌' });
  return events;
}

function reportChangeError(error) {
  const code = error && error.data && error.data.error_code;
  if (code === 'EDITOR_DIRTY') return '相关文件有未保存内容。请打开并保存或放弃这些编辑，再重试检查。';
  if (code === 'EDITOR_UNAVAILABLE') return '相关 VS Code 窗口已失联。请重新打开审阅，或清除失效会话。';
  if (code === 'LEASE_EXPIRED') return '编辑器状态已变化或检查已过期，请重试应用。';
  if (code === 'FILE_CHANGED') return '文件在建议生成后已变化，请根据当前内容重新生成修改建议。';
  return error.message;
}

function publishAllReviewReadiness() {
  for (const review of changeReviews.values()) {
    publishReviewReadiness(review).catch(() => {});
  }
}

function runChangeCommand(action) {
  return (...args) => Promise.resolve().then(() => { requireNoReset(); return action(...args); }).catch((error) => {
    const code = error && error.data && error.data.error_code;
    const actions = code === 'EDITOR_DIRTY'
      ? ['打开未保存文件', '重试检查']
      : code === 'EDITOR_UNAVAILABLE'
        ? ['重新打开审阅']
        : code === 'LEASE_EXPIRED'
          ? ['重试检查'] : [];
    vscode.window.showErrorMessage(`Porthole：${reportChangeError(error)}`, ...actions)
      .then(async (choice) => {
        const review = reviewForChange(changeIdFromArgument(args[0]));
        if (choice === '打开未保存文件' && review) {
          const dirty = vscode.workspace.textDocuments.find((document) => (
            document.uri.scheme === 'file' && document.isDirty
            && vscode.workspace.getWorkspaceFolder(document.uri) === review.folder
          ));
          if (dirty) await vscode.window.showTextDocument(dirty);
        }
        if (choice === '重新打开审阅' && review) await showChange(review.change.change_id);
        if (choice === '重试检查') await action(...args);
      });
  });
}

async function publishActiveContext(options = {}) {
  if (resetIsBlocked()) return;
  const binding = activeBinding(!options.silent);
  if (!binding) return;
  const { editor, folder, config } = binding;
  const projectId = config.get('projectId', '').trim();
  if (!projectId) {
    setStatus('未配置', '点击配置工作区连接', 'porthole.configure');
    if (!options.silent) vscode.window.showWarningMessage('当前工作区文件夹未绑定项目，请先配置连接。', '配置').then((choice) => choice === '配置' && vscode.commands.executeCommand('porthole.configure'));
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
    if (!options.silent) vscode.window.showInformationMessage(`Porthole 已同步 ${relativePath}`);
  } catch (error) {
    setStatus('同步失败', error.message, 'porthole.configure');
    if (!options.silent) vscode.window.showErrorMessage(`Porthole：${error.message}`, '重新配置').then((choice) => choice === '重新配置' && vscode.commands.executeCommand('porthole.configure'));
  }
}

function scheduleAutoSync(document) {
  if (resetIsBlocked()) return;
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
  requireNoReset();
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
  const home = path.join(localAppData, 'Porthole');
  return {
    executable: path.join(home, 'runtime', 'current', 'porthole.exe'),
    config: path.join(home, 'config.json'),
    log: path.join(home, '.local', 'server.log'),
    tunnelClientRoot: path.join(home, 'tunnel-client', 'current'),
  };
}

async function runCredentialCommand(paths, command, payload = null) {
  await new Promise((resolve, reject) => {
    const child = spawn(paths.executable, [command, '--config', paths.config], {
      windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'],
    });
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error('系统凭据库操作失败；请检查本机运行包和 Windows 凭据管理器。')));
    child.stdin.on('error', () => {});
    child.stdin.end(payload === null ? '' : JSON.stringify(payload));
  });
}

async function syncLoginCredentials(paths, clientId, clientSecret) {
  if (!await hasLoginStartup(paths.executable, paths.config, execFileAsync)) return;
  try {
    await runCredentialCommand(paths, 'credential-store', { client_id: clientId, client_secret: clientSecret });
  } catch {
    try {
      await setLoginStartup(false, paths.executable, paths.config, execFileAsync);
      vscode.window.showWarningMessage('系统凭据库不可用，已关闭开机自动启动；当前 VS Code 会话仍可使用网页连接。');
    } catch {
      vscode.window.showWarningMessage('系统凭据库不可用且无法关闭开机启动；请在首页关闭开机启动。当前 VS Code 会话仍可使用网页连接。');
    }
  }
}

async function githubLaunchEnv(config, credentials = null) {
  if (config.auth_mode !== 'github') return process.env;
  const clientId = credentials && credentials.clientId || await extensionContext.secrets.get(GITHUB_CLIENT_ID_KEY);
  const clientSecret = credentials && credentials.clientSecret || await extensionContext.secrets.get(GITHUB_CLIENT_SECRET_KEY);
  if (!clientId && !clientSecret) return process.env; // Backend may use the OS credential vault.
  if (!clientId || !clientSecret) throw new Error('GitHub OAuth 凭据不完整，请在首页重新设置网页连接。');
  return { ...process.env, PROJECT_MCP_GITHUB_CLIENT_ID: clientId,
    PROJECT_MCP_GITHUB_CLIENT_SECRET: clientSecret };
}

async function startManaged(paths, credentials = null) {
  requireNoReset();
  const config = JSON.parse(fs.readFileSync(paths.config, 'utf8'));
  const env = await githubLaunchEnv(config, credentials);
  try { await execFileAsync(paths.executable, ['start', '--config', paths.config], { windowsHide: true, env }); }
  catch (error) { throw new Error(`本机服务启动失败，请检查 ${paths.log}：${error.message}`); }
  if (!await managedStatus(paths.config)) throw new Error('服务启动后身份未通过验证；请检查端口占用。');
}

async function installManagedRuntime(force = false) {
  requireNoReset();
  const paths = managedRuntimePaths();
  if (!force && extensionContext.globalState.get('porthole.rollbackHold') && fs.existsSync(paths.executable)) return paths;
  const bundleRoot = path.join(extensionContext.extensionPath, 'runtime-bundle');
  if (fs.existsSync(path.join(bundleRoot, 'bundle.json'))) {
    const installRoot = path.dirname(paths.executable);
    const { manifest, manifestHash } = validateBundle(bundleRoot, require('./package.json').version);
    if (!installedBundleHealthy(installRoot, manifest.files, manifestHash)) {
      const existing = fs.existsSync(paths.executable) && fs.existsSync(paths.config);
      const running = existing ? await checkManagedPorts(paths) : null;
      let upgraded = false;
      try {
        if (!existing) {
          installBundledRuntime(bundleRoot, installRoot, require('./package.json').version);
          await extensionContext.globalState.update('porthole.upgradeResult', `已安装 ${require('./package.json').version}`);
        } else {
          const config = JSON.parse(fs.readFileSync(paths.config, 'utf8'));
          const stateDir = path.resolve(path.dirname(paths.config), config.state_dir || '.local');
          const args = ['--config', paths.config, '--runtime-dir', installRoot, '--state-dir', stateDir];
          const targetVersion = config.config_version === '1.0' ? '1.0' : '0.3';
          const snapshotId = await upgradeManagedBundle({
            stop: async () => {
              if (running) await execFileAsync(paths.executable, ['stop', '--config', paths.config], { windowsHide: true });
            },
            prepare: async () => {
              const result = await execFileAsync(paths.executable, ['upgrade-prepare', ...args,
                '--target-version', targetVersion], { windowsHide: true });
              const id = result.stdout.trim();
              if (!/^[0-9a-f]{32}$/.test(id)) throw new Error('升级快照标识无效。');
              return id;
            },
            install: async () => installBundledRuntime(bundleRoot, installRoot, require('./package.json').version),
            complete: async (id) => execFileAsync(paths.executable, ['upgrade-complete', ...args,
              '--snapshot-id', id], { windowsHide: true }),
            start: async () => startManaged(paths),
            finalize: async (id) => execFileAsync(paths.executable, ['upgrade-finalize', ...args,
              '--snapshot-id', id], { windowsHide: true }),
            quiesce: async () => {
              if (await managedStatus(paths.config)) await execFileAsync(paths.executable,
                ['stop', '--config', paths.config], { windowsHide: true });
            },
            restore: async (id) => {
              const original = path.join(stateDir, 'upgrade-snapshots', id, 'runtime', 'porthole.exe');
              await execFileAsync(original, ['upgrade-restore', ...args, '--snapshot-id', id], { windowsHide: true });
            },
            restartOriginal: async () => { if (running) await startManaged(paths); },
          });
          upgraded = true;
          await extensionContext.globalState.update('porthole.upgradeResult',
            `已升级至 ${require('./package.json').version}；备份 ${snapshotId.slice(0, 8)} 已保留`);
          await extensionContext.globalState.update('porthole.lastSnapshotId', snapshotId);
          if (!running) await execFileAsync(paths.executable, ['stop', '--config', paths.config], { windowsHide: true });
        }
      } catch (error) {
        await extensionContext.globalState.update('porthole.upgradeResult',
          `${upgraded ? '升级已完成，但后续操作失败' : '升级未完成'}：${error.message}`);
        throw error;
      }
    }
  } else if (!fs.existsSync(paths.executable)) {
    throw new Error('当前扩展不含本机运行包，请安装完整的 Windows x64 VSIX。');
  }
  return paths;
}

async function ensureManagedRuntime(force = false) {
  if (force && managedInstallPromise) await managedInstallPromise;
  if (!managedInstallPromise) {
    managedInstallPromise = installManagedRuntime(force).finally(() => { managedInstallPromise = undefined; });
  }
  return managedInstallPromise;
}

async function portOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.setTimeout(500);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
    socket.once('error', () => { socket.destroy(); resolve(false); });
  });
}

async function checkManagedPorts(paths) {
  const config = JSON.parse(fs.readFileSync(paths.config, 'utf8'));
  const owned = await managedStatus(paths.config);
  if (!owned && (await portOpen(config.admin_port) || await portOpen(config.mcp_port))) {
    throw new Error(`端口 ${config.mcp_port}/${config.admin_port} 已被其他服务占用。请先停止旧服务，再重试；Porthole 不会操作其他进程。`);
  }
  return owned;
}

function managedMcpToken(paths, config) {
  const state = path.resolve(path.dirname(paths.config), config.state_dir || '.local');
  const tokenFile = path.join(state, 'tokens.json');
  if (fs.lstatSync(tokenFile).isSymbolicLink()) throw new Error('本机令牌文件不能是链接。');
  const token = JSON.parse(fs.readFileSync(tokenFile, 'utf8')).mcp_token;
  if (typeof token !== 'string' || token.length < 32) throw new Error('本机 MCP 令牌无效，请修复本机服务。');
  return token;
}

async function startConfiguredTunnel(id, apiKey) {
  requireNoReset();
  if (globalClosing) throw new Error('窗口正在关闭。');
  if (tunnelStartPromise) {
    try { await tunnelStartPromise; }
    catch { /* The requested connection may still be valid. */ }
    return startConfiguredTunnel(id, apiKey);
  }
  tunnelStartPromise = (async () => {
    const paths = await ensureManagedRuntime();
    if (!fs.existsSync(paths.config)) throw new Error('请先选择并授权一个项目。');
    const config = JSON.parse(fs.readFileSync(paths.config, 'utf8'));
    if (config.auth_mode !== 'local') throw new Error('私有隧道仅能连接本地令牌模式。');
    if (!config.projects?.length) throw new Error('请先选择并授权一个项目。');
    if (!await checkManagedPorts(paths)) await startManaged(paths);
    const mcpToken = managedMcpToken(paths, config);
    await probeLocalMcp({ mcpPort: config.mcp_port, mcpToken,
      projectId: config.projects.find((project) => project.id === homeSelectedProjectId)?.id
        || config.projects[0].id });
    const credentialDigest = crypto.createHash('sha256').update(`${id}\0${apiKey}\0${mcpToken}`).digest('hex');
    if (tunnelHandle?.running && tunnelHandle.id === id
        && tunnelHandle.credentialDigest === credentialDigest) return tunnelHandle;
    if (tunnelHandle) await stopTunnelClient(tunnelHandle);
    tunnelHandle = undefined;
    const executable = await ensureTunnelClient(paths.tunnelClientRoot, {
      bundleRoot: path.join(extensionContext.extensionPath, 'tunnel-bundle'),
    });
    requireNoReset();
    if (globalClosing) throw new Error('窗口正在关闭。');
    const handle = await startTunnelClient({ executable, tunnelId: id, apiKey,
      mcpToken, mcpPort: config.mcp_port });
    handle.id = id;
    handle.credentialDigest = credentialDigest;
    tunnelHandle = handle;
    tunnelLastError = undefined;
    tunnelLastIssue = undefined;
    return handle;
  })().catch((error) => {
    tunnelLastIssue = safeSetupIssue(error); tunnelLastError = tunnelLastIssue.message; throw error;
  })
    .finally(() => { tunnelStartPromise = undefined; });
  return tunnelStartPromise;
}

async function currentTunnelState() {
  const id = extensionContext.globalState.get(PRIVATE_TUNNEL_ID);
  let localMode = false;
  const paths = managedRuntimePaths();
  try { localMode = JSON.parse(fs.readFileSync(paths.config, 'utf8')).auth_mode === 'local'; }
  catch { /* No managed project yet. */ }
  const configured = localMode && typeof id === 'string'
    && Boolean(await extensionContext.secrets.get(PRIVATE_TUNNEL_KEY));
  let ready = false;
  let issue = tunnelLastIssue || null;
  if (configured && tunnelHandle?.running && tunnelHandle.id === id && tunnelHandle.healthUrl) {
    const state = await readTunnelHealth(tunnelHandle.healthUrl);
    ready = state.ready; issue = state.issue;
    if (ready) { tunnelLastIssue = undefined; tunnelLastError = undefined; }
    else if (issue && !issue.retryable) {
      tunnelLastIssue = issue; tunnelLastError = issue.message; tunnelRestartPolicy.pause();
      await stopTunnelClient(tunnelHandle);
    }
  }
  if (!ready && !issue && configured) issue = tunnelIssue(tunnelHandle ? 'TUNNEL_PROCESS' : 'TUNNEL_STOPPED');
  return { configured, ready, running: Boolean(tunnelHandle?.running), id: configured ? id : null,
    issue, error: ready ? null : issue?.message || tunnelLastError || null };
}

async function recoverPrivateTunnel() {
  await observeResetState();
  if (resetIsBlocked()) return;
  if (globalClosing || tunnelStartPromise || tunnelRecoveryPromise
      || extensionContext.globalState.get('porthole.manualTunnelStop')
      || extensionContext.globalState.get('porthole.manualServiceStop')) return;
  tunnelRecoveryPromise = recoverPrivateTunnelOnce().finally(() => { tunnelRecoveryPromise = undefined; });
  return tunnelRecoveryPromise;
}

async function recoverPrivateTunnelOnce() {
  const id = extensionContext.globalState.get(PRIVATE_TUNNEL_ID);
  const key = id && await extensionContext.secrets.get(PRIVATE_TUNNEL_KEY);
  if (!id || !key) return;
  const state = await currentTunnelState();
  const action = recoveryAction(state);
  if (action !== 'restart' || !tunnelRestartPolicy.canRestart()) return;
  if (tunnelHandle && !tunnelHandle.crashRecorded) {
    tunnelHandle.crashRecorded = true;
    if (!tunnelRestartPolicy.recordCrash()) {
      tunnelLastIssue = tunnelIssue('TUNNEL_CRASH_LIMIT'); return refreshHome();
    }
  }
  const paths = managedRuntimePaths();
  if (!fs.existsSync(paths.config)) return;
  const config = JSON.parse(fs.readFileSync(paths.config, 'utf8'));
  if (config.auth_mode !== 'local') return;
  try { await startConfiguredTunnel(id, key); await refreshHome(); }
  catch {
    if (tunnelLastIssue && !tunnelLastIssue.retryable) tunnelRestartPolicy.pause();
    else if (!tunnelRestartPolicy.recordCrash()) tunnelLastIssue = tunnelIssue('TUNNEL_CRASH_LIMIT');
    await refreshHome();
  }
}

async function pairManagedRuntime(selectedFolder = null) {
  requireNoReset();
  const paths = await ensureManagedRuntime();
  if (!fs.existsSync(paths.config)) {
    const binding = selectedFolder ? { folder: selectedFolder } : activeBinding(true);
    if (!binding) return;
    await execFileAsync(paths.executable, ['init', '--config', paths.config,
      '--project', binding.folder.uri.fsPath, '--id', projectIdForPath(binding.folder.uri.fsPath)], { windowsHide: true });
  }
  return withManagedProfileEdit(() => pairManagedRuntimeImpl(selectedFolder));
}

async function pairManagedRuntimeImpl(selectedFolder = null) {
  requireNoReset();
  const binding = selectedFolder
    ? { folder: selectedFolder, config: folderConfiguration(selectedFolder) }
    : activeBinding(true);
  if (!binding) return;
  const paths = await ensureManagedRuntime();
  const projectId = projectIdForPath(binding.folder.uri.fsPath);
  const config = JSON.parse(fs.readFileSync(paths.config, 'utf8'));
  const serviceUrl = normalizeServiceUrl(`http://127.0.0.1:${config.admin_port}`);
  await checkManagedPorts(paths);
  const manager = new ServiceManager({
    status: async () => {
      const value = await managedStatus(paths.config);
      return value ? { serviceUrl, apiVersion: value.protocol_version,
        capabilities: value.capabilities || [] } : null;
    },
    launch: async () => startManaged(paths),
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
  guardProfileEdit();
  await saveConnection(binding.folder, serviceUrl, project.id, credentials.admin_token);
  guardProfileEdit();
  await extensionContext.secrets.store(MANAGED_TOKEN_KEY, credentials.admin_token);
  managedRestartPolicy.resume();
  await extensionContext.globalState.update('porthole.manualServiceStop', false);
  setStatus('已连接', `${binding.folder.name} → ${project.name || project.id}`);
  homeSelectedProjectId = project.id;
  await refreshHome();
  vscode.window.showInformationMessage('Porthole 本机服务已启动并完成安全配对。');
  return { serviceUrl, projectId: project.id, status, token: credentials.admin_token };
}

async function homeConnection() {
  const paths = managedRuntimePaths();
  const token = await extensionContext.secrets.get(MANAGED_TOKEN_KEY);
  if (token && fs.existsSync(paths.config)) {
    if (!await managedStatus(paths.config)) throw new Error('当前端口没有运行属于此配置的本机服务。');
    const config = JSON.parse(fs.readFileSync(paths.config, 'utf8'));
    const url = normalizeServiceUrl(`http://127.0.0.1:${config.admin_port}`);
    return new ContextClient(url, token);
  }
  for (const folder of vscode.workspace.workspaceFolders || []) {
    const saved = await extensionContext.secrets.get(tokenKey(folder));
    if (saved) {
      const url = folderConfiguration(folder).get('serviceUrl', DEFAULT_URL);
      return new ContextClient(url, saved);
    }
  }
  return null;
}

async function currentHomeState() {
  const resetFiles = await observeResetState();
  const paths = managedRuntimePaths();
  const tunnel = await currentTunnelState();
  const runtimeInstalled = fs.existsSync(paths.executable);
  const managedConfigExists = fs.existsSync(paths.config);
  const serviceRunning = managedConfigExists && Boolean(await managedStatus(paths.config));
  const loginStartup = runtimeInstalled && managedConfigExists
    && await hasLoginStartup(paths.executable, paths.config, execFileAsync);
  let installedVersion = null;
  try { installedVersion = JSON.parse(fs.readFileSync(path.join(path.dirname(paths.executable), 'installed.json'), 'utf8')).version; }
  catch { /* Unknown installation. */ }
  const shared = { runtimeInstalled, managedConfigExists, serviceRunning, loginStartup,
    installedVersion, bundledVersion: require('./package.json').version,
    upgradeResult: extensionContext.globalState.get('porthole.upgradeResult') || null,
    lastSnapshotId: extensionContext.globalState.get('porthole.lastSnapshotId') || null,
    diagnosis: homeDiagnosis || null, tunnel,
    previousWebAvailable: Boolean(extensionContext.globalState.get(PREVIOUS_WEB_CONFIG)) && tunnel.configured,
    reset: visibleResetState(homeResetState || extensionContext.globalState.get('porthole.resetPending')
      || (resetFiles.pending ? { phase: 'failed', issue: { message: '上次恢复被中断，请继续恢复初始状态。' } } : null)
      || extensionContext.globalState.get('porthole.resetResult') || null, Boolean(initialReset?.running)) };
  try {
    const client = await homeConnection();
    const status = client ? await client.getStatus() : null;
    const selected = status && (status.projects.find((item) => item.id === homeSelectedProjectId)
      || status.projects[0]);
    return { view: deriveHomeView({ ...shared, status, selectedProjectId: homeSelectedProjectId,
      scopePreview: selected && homeScopePreviews.get(selected.id),
      challengeExpiresAt: selected && homeChallenge && selected.id === homeChallenge.projectId
        ? homeChallenge.expiresAt : null }), client };
  } catch (error) {
    return { view: deriveHomeView({ ...shared, error: error.message }), client: null };
  }
}

async function refreshHome() {
  if (!homePanel) return;
  const { view } = await currentHomeState();
  await homePanel.webview.postMessage({ type: 'state', view });
}

async function workspaceFolderForPath(folderPath) {
  const target = normalizedRoot(folderPath);
  const find = () => (vscode.workspace.workspaceFolders || []).find(
    (folder) => normalizedRoot(folder.uri.fsPath) === target,
  );
  if (find()) return find();
  const folders = vscode.workspace.workspaceFolders || [];
  const changed = vscode.workspace.updateWorkspaceFolders(folders.length, 0, {
    uri: vscode.Uri.file(folderPath),
  });
  if (!changed) throw new Error('VS Code 未能把所选目录加入当前工作区。');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      disposable.dispose();
      reject(new Error('工作区更新超时。请在 VS Code 打开该文件夹后重试。'));
    }, 10000);
    const disposable = vscode.workspace.onDidChangeWorkspaceFolders(() => {
      const folder = find();
      if (folder) {
        clearTimeout(timer); disposable.dispose(); resolve(folder);
      }
    });
    const immediate = find();
    if (immediate) { clearTimeout(timer); disposable.dispose(); resolve(immediate); }
  });
}

async function chooseOrAuthorizeFolder() {
  requireNoReset();
  const selection = await vscode.window.showOpenDialog({
    canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
    openLabel: '选择项目文件夹',
  });
  if (!selection || !selection.length) return;
  if (selection[0].scheme !== 'file') throw new Error('只能授权本机文件夹。');
  const root = fs.realpathSync.native(selection[0].fsPath);
  if (!fs.statSync(root).isDirectory()) throw new Error('请选择实际存在的文件夹。');
  const { view } = await currentHomeState();
  const choice = projectChoice(root, view.projects);
  if (!choice.existing) {
    const approved = await vscode.window.showInformationMessage(
      `授权 Porthole 读取以下目录中符合排除规则的已保存文件？\n${root}\n新项目默认仅查看代码；若目录尚未打开，也会加入当前 VS Code 工作区。`,
      { modal: true }, '授权此目录',
    );
    if (approved !== '授权此目录') return;
  }
  await ensureManagedRuntime();
  const folder = await workspaceFolderForPath(root);
  const result = await pairManagedRuntime(folder);
  homeSelectedProjectId = result.projectId;
  await extensionContext.globalState.update('porthole.homeProjectId', result.projectId);
  await refreshHome();
}

async function migrateManagedWeb() {
  return withManagedProfileEdit(() => migrateManagedWebImpl());
}

async function migrateManagedWebImpl() {
  const paths = managedRuntimePaths();
  if (!fs.existsSync(paths.config)) throw new Error('请先在首页选择一个项目，创建本机服务。');
  const activeFolder = (vscode.workspace.workspaceFolders || [])[0];
  const suggested = activeFolder && path.join(activeFolder.uri.fsPath, 'config', 'local.json');
  const selected = await vscode.window.showOpenDialog({
    canSelectFolders: false, canSelectFiles: true, canSelectMany: false,
    filters: { 'JSON 配置': ['json'] },
    defaultUri: suggested && fs.existsSync(suggested) ? vscode.Uri.file(suggested) : undefined,
    openLabel: '选择旧服务配置',
  });
  if (!selected || !selected.length) return;
  if (selected[0].scheme !== 'file') throw new Error('只能选择本机旧配置文件。');
  const clientId = await vscode.window.showInputBox({ title: '原 GitHub OAuth App 的 Client ID',
    prompt: '请填写旧服务启动时使用的 Client ID；不会写入项目文件。', ignoreFocusOut: true,
    validateInput: (value) => value.trim() ? null : 'Client ID 不能为空。' });
  if (clientId === undefined) return;
  const clientSecret = await vscode.window.showInputBox({ title: '原 GitHub OAuth App 的 Client Secret',
    prompt: '请输入旧服务启动时使用的 Secret，用于验证原有加密连接记录。',
    password: true, ignoreFocusOut: true,
    validateInput: (value) => value ? null : 'Client Secret 不能为空。' });
  if (clientSecret === undefined) return;
  const plan = prepareMigration(selected[0].fsPath, paths.config, clientSecret);
  const approved = await vscode.window.showInformationMessage(
    `将 ${plan.recordCount} 条旧 OAuth 连接记录迁移到当前本机服务？\n公网地址：${plan.nextConfig.public_url}\n当前已授权项目和本机令牌会保留。迁移后仍须在 ChatGPT 完成一次真实工具调用验证。`,
    { modal: true }, '确认迁移',
  );
  if (approved !== '确认迁移') return;
  await ensureManagedRuntime();
  await checkManagedPorts(paths);
  const previousId = await extensionContext.secrets.get(GITHUB_CLIENT_ID_KEY);
  const previousSecret = await extensionContext.secrets.get(GITHUB_CLIENT_SECRET_KEY);
  let wasRunning = false;
  try {
    guardProfileEdit();
    await extensionContext.secrets.store(GITHUB_CLIENT_ID_KEY, clientId.trim());
    await extensionContext.secrets.store(GITHUB_CLIENT_SECRET_KEY, clientSecret);
    await executeMigration(plan, {
      guard: guardProfileEdit,
      stop: async () => {
        wasRunning = Boolean(await checkManagedPorts(paths));
        if (wasRunning) await execFileAsync(paths.executable, ['stop', '--config', paths.config], { windowsHide: true });
      },
      start: async () => {
        await startManaged(paths, { clientId: clientId.trim(), clientSecret });
        for (const suffix of ['/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource/mcp']) {
          const response = await fetch(`${plan.nextConfig.public_url}${suffix}`, { signal: AbortSignal.timeout(8000) });
          if (!response.ok) throw new Error(`公网 OAuth 发现地址返回 ${response.status}；请检查 HTTPS 转发。`);
        }
      },
      quiesce: async () => {
        if (await managedStatus(paths.config)) {
          await execFileAsync(paths.executable, ['stop', '--config', paths.config], { windowsHide: true });
        }
      },
      restore: async () => { if (wasRunning) await startManaged(paths); },
    });
  } catch (error) {
    guardProfileEdit();
    if (previousId === undefined) await extensionContext.secrets.delete(GITHUB_CLIENT_ID_KEY);
    else await extensionContext.secrets.store(GITHUB_CLIENT_ID_KEY, previousId);
    if (previousSecret === undefined) await extensionContext.secrets.delete(GITHUB_CLIENT_SECRET_KEY);
    else await extensionContext.secrets.store(GITHUB_CLIENT_SECRET_KEY, previousSecret);
    throw error;
  }
  await syncLoginCredentials(paths, clientId.trim(), clientSecret);
  await refreshHome();
  vscode.window.showInformationMessage('旧网页连接记录已迁移，公网 OAuth 地址已验证。请在原 ChatGPT 连接发起一次工具调用；若提示授权，按页面重新授权。');
}

async function setupManagedWeb() {
  return withManagedProfileEdit(() => setupManagedWebImpl());
}

async function setupManagedWebImpl() {
  const paths = managedRuntimePaths();
  if (!fs.existsSync(paths.config)) throw new Error('请先选择项目，完成本机服务配对。');
  const config = JSON.parse(fs.readFileSync(paths.config, 'utf8'));
  if (config.auth_mode === 'github') throw new Error('此服务已有网页连接。可在首页运行连接诊断。');
  const ready = await vscode.window.showInformationMessage(
    '请先确认 ChatGPT 账号页面可添加自托管 MCP 连接，并准备固定 HTTPS 公网地址（仅转发 MCP 端口）、GitHub OAuth App 和本人 GitHub 账号。扩展无法代替你检查网页账号权限。',
    { modal: true }, '已确认，开始设置',
  );
  if (ready !== '已确认，开始设置') return;
  const origin = await vscode.window.showInputBox({ title: '第 1 步：HTTPS 公网根地址',
    prompt: '填写转发到本机 MCP 端口的固定 HTTPS 根地址，例如 https://mcp.example.com；不要加 /mcp。',
    ignoreFocusOut: true, validateInput: (value) => {
      try { prepareWebSetup(config, value, '1'); return null; } catch (error) { return error.message; }
    } });
  if (origin === undefined) return;
  let startedForPreflight = false;
  let setupComplete = false;
  try {
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification,
      title: 'Porthole：检查公网 HTTPS 可达性' }, () => preflightWebConnection(
      new URL(origin).origin, {
        ensureRuntime: () => ensureManagedRuntime(),
        checkPorts: () => checkManagedPorts(paths),
        start: async () => { await startManaged(paths); startedForPreflight = true; },
        probe: probePublicEndpoint,
      }));
    const username = await vscode.window.showInputBox({ title: '第 2 步：GitHub 用户名',
      prompt: '只允许此 GitHub 账号授权访问；程序会查询并保存稳定的数字用户 ID。',
      ignoreFocusOut: true });
    if (username === undefined) return;
    const owner = await resolveGithubOwner(username);
    const clientId = await vscode.window.showInputBox({ title: '第 3 步：GitHub OAuth App Client ID',
      prompt: `OAuth App 回调地址应为 ${new URL(origin).origin}/auth/callback。Client ID 保存在 VS Code 凭据库。`,
      ignoreFocusOut: true, validateInput: (value) => value.trim() ? null : 'Client ID 不能为空。' });
    if (clientId === undefined) return;
    const clientSecret = await vscode.window.showInputBox({ title: '第 4 步：GitHub OAuth App Client Secret',
      prompt: 'Secret 仅保存在本机凭据库，不写入项目配置。', password: true,
      ignoreFocusOut: true, validateInput: (value) => value ? null : 'Client Secret 不能为空。' });
    if (clientSecret === undefined) return;
    const next = prepareWebSetup(config, origin, owner.id);
    const approved = await vscode.window.showInformationMessage(
      `将 ${next.public_url}/mcp 用作网页连接地址，仅允许 GitHub 账号 ${owner.login}（ID ${owner.id}）。当前项目授权会保留。确认 HTTPS 转发和 OAuth App 回调地址已配置？`,
      { modal: true }, '保存并验证',
    );
    if (approved !== '保存并验证') return;
    const previousId = await extensionContext.secrets.get(GITHUB_CLIENT_ID_KEY);
    const previousSecret = await extensionContext.secrets.get(GITHUB_CLIENT_SECRET_KEY);
    let wasRunning = false;
    try {
      guardProfileEdit();
      await extensionContext.secrets.store(GITHUB_CLIENT_ID_KEY, clientId.trim());
      await extensionContext.secrets.store(GITHUB_CLIENT_SECRET_KEY, clientSecret);
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification,
        title: 'Porthole：保存网页连接并验证 HTTPS' }, () => executeWebSetup(paths.config, next, {
        guard: guardProfileEdit,
        stop: async () => {
          wasRunning = Boolean(await checkManagedPorts(paths));
          if (wasRunning) await execFileAsync(paths.executable, ['stop', '--config', paths.config], { windowsHide: true });
        },
        start: async () => startManaged(paths, { clientId: clientId.trim(), clientSecret }),
        probe: async () => {
          for (const suffix of ['/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource/mcp']) {
            const response = await fetch(`${next.public_url}${suffix}`, { signal: AbortSignal.timeout(8000) });
            if (!response.ok) throw new Error(`公网 OAuth 地址 ${suffix} 返回 HTTP ${response.status}；请检查 HTTPS 转发。`);
          }
        },
        quiesce: async () => {
          if (await managedStatus(paths.config)) await execFileAsync(paths.executable, ['stop', '--config', paths.config], { windowsHide: true });
        },
        restore: async () => { if (wasRunning) await startManaged(paths, { clientId: previousId, clientSecret: previousSecret }); },
      }));
    } catch (error) {
      guardProfileEdit();
      if (previousId === undefined) await extensionContext.secrets.delete(GITHUB_CLIENT_ID_KEY);
      else await extensionContext.secrets.store(GITHUB_CLIENT_ID_KEY, previousId);
      if (previousSecret === undefined) await extensionContext.secrets.delete(GITHUB_CLIENT_SECRET_KEY);
      else await extensionContext.secrets.store(GITHUB_CLIENT_SECRET_KEY, previousSecret);
      throw error;
    }
    await syncLoginCredentials(paths, clientId.trim(), clientSecret);
    managedRestartPolicy.resume();
    await extensionContext.globalState.update('porthole.manualServiceStop', false);
    setupComplete = true;
    await refreshHome();
    await vscode.env.clipboard.writeText(`${next.public_url}/mcp`);
    vscode.window.showInformationMessage('公网 OAuth 地址已验证，MCP 地址已复制。请在 ChatGPT 添加自托管连接，完成 GitHub 授权，再在本页验证真实工具调用。');
  } finally {
    if (startedForPreflight && !setupComplete && await managedStatus(paths.config)) {
      try { await execFileAsync(paths.executable, ['stop', '--config', paths.config], { windowsHide: true }); }
      catch (error) { vscode.window.showWarningMessage(`设置未完成，本机服务仍在运行：${error.message}`); }
    }
  }
}

async function configurePrivateTunnel({ tunnelId, apiKey: submittedKey }, report = () => {}) {
  return withManagedProfileEdit(() => configurePrivateTunnelImpl({ tunnelId, apiKey: submittedKey }, report));
}

async function configurePrivateTunnelImpl({ tunnelId, apiKey: submittedKey }, report = () => {}) {
  requireNoReset();
  const paths = managedRuntimePaths();
  if (!fs.existsSync(paths.config)) throw new Error('请先选择并授权一个项目。');
  const config = JSON.parse(fs.readFileSync(paths.config, 'utf8'));
  validateTunnelId(tunnelId);
  const apiKey = submittedKey || await extensionContext.secrets.get(PRIVATE_TUNNEL_KEY);
  if (!apiKey) throw Object.assign(new Error(), { code: 'TUNNEL_CREDENTIALS' });
  const previousId = extensionContext.globalState.get(PRIVATE_TUNNEL_ID);
  const previousKey = previousId && await extensionContext.secrets.get(PRIVATE_TUNNEL_KEY);
  const previousWeb = extensionContext.globalState.get(PREVIOUS_WEB_CONFIG);
  const previousManualStop = extensionContext.globalState.get('porthole.manualTunnelStop');
  report('正在校验并安装扩展附带的官方隧道客户端');
  await ensureTunnelClient(paths.tunnelClientRoot, {
    bundleRoot: path.join(extensionContext.extensionPath, 'tunnel-bundle'),
  });
  let running = false;
  try {
    guardProfileEdit();
    await extensionContext.secrets.store(PRIVATE_TUNNEL_KEY, apiKey.trim());
    await extensionContext.globalState.update(PRIVATE_TUNNEL_ID, tunnelId.trim());
    if (config.auth_mode === 'github') await extensionContext.globalState.update(PREVIOUS_WEB_CONFIG, config);
    await extensionContext.globalState.update('porthole.manualTunnelStop', false);
    report('正在检查本机服务并启动私有隧道');
    if (tunnelHandle) { await stopTunnelClient(tunnelHandle); tunnelHandle = undefined; }
    if (config.auth_mode === 'github') {
      const next = preparePrivateTunnelConfig(config);
      await executeWebSetup(paths.config, next, {
        guard: guardProfileEdit,
        stop: async () => {
          running = Boolean(await checkManagedPorts(paths));
          if (running) await execFileAsync(paths.executable, ['stop', '--config', paths.config], { windowsHide: true });
        },
        start: async () => startManaged(paths),
        probe: async () => startConfiguredTunnel(tunnelId.trim(), apiKey.trim()),
        quiesce: async () => {
          if (tunnelHandle) await stopTunnelClient(tunnelHandle);
          tunnelHandle = undefined;
          if (await managedStatus(paths.config)) await execFileAsync(paths.executable,
            ['stop', '--config', paths.config], { windowsHide: true });
        },
        restore: async () => { if (running) await startManaged(paths); },
      });
    } else {
      await startConfiguredTunnel(tunnelId.trim(), apiKey.trim());
    }
    tunnelRestartPolicy.resume();
  } catch (error) {
    guardProfileEdit();
    try {
      if (previousKey) await extensionContext.secrets.store(PRIVATE_TUNNEL_KEY, previousKey);
      else await extensionContext.secrets.delete(PRIVATE_TUNNEL_KEY);
      await extensionContext.globalState.update(PRIVATE_TUNNEL_ID, previousId);
      await extensionContext.globalState.update(PREVIOUS_WEB_CONFIG, previousWeb);
      await extensionContext.globalState.update('porthole.manualTunnelStop', previousManualStop);
    } catch { /* Keep the original setup error. */ }
    if (config.auth_mode === 'local' && previousId && previousKey) {
      try { await startConfiguredTunnel(previousId, previousKey); } catch { /* Preserve the new setup error. */ }
    }
    throw error;
  }
  await refreshHome();
}

async function wizardSnapshot() {
  const { view } = await currentHomeState();
  return { projectId: view.project?.id || null, projectName: view.project?.name || '',
    hasKey: Boolean(await extensionContext.secrets.get(PRIVATE_TUNNEL_KEY)),
    configured: view.tunnel.configured, running: view.tunnel.running, ready: view.tunnel.ready,
    tunnelId: extensionContext.globalState.get(PRIVATE_TUNNEL_ID) || '',
    publicMode: view.authMode === 'github', issue: view.tunnel.issue || null,
    verified: view.tunnel.ready && view.steps[3].state === 'done',
    challengeExpiresAt: view.challengeExpiresAt };
}

async function checkWizardLocal(projectId) {
  const paths = managedRuntimePaths();
  const config = JSON.parse(fs.readFileSync(paths.config, 'utf8'));
  if (!await managedStatus(paths.config)) throw Object.assign(new Error(), { code: 'LOCAL_MCP_NETWORK' });
  return probeLocalMcp({ mcpPort: config.mcp_port,
    mcpToken: managedMcpToken(paths, config), projectId });
}

async function setupPrivateTunnel() {
  if (wizardPanel) { wizardPanel.reveal(); return connectionWizard.refresh(); }
  const panel = vscode.window.createWebviewPanel('porthole.connection', '连接 ChatGPT',
    vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
  wizardPanel = panel;
  if (!connectionWizard) connectionWizard = new ConnectionWizard({
    loadDraft: () => extensionContext.globalState.get('porthole.tunnelDraft'),
    saveDraft: (draft) => extensionContext.globalState.update('porthole.tunnelDraft', draft),
    snapshot: wizardSnapshot, connect: configurePrivateTunnel, checkLocal: checkWizardLocal,
    notify: (state) => { if (wizardPanel) void wizardPanel.webview.postMessage({ type: 'wizard-state', state }); },
  });
  panel.webview.html = connectionWizardHtml(crypto.randomBytes(16).toString('base64'));
  panel.onDidDispose(() => { if (wizardPanel === panel) wizardPanel = undefined; });
  const links = {
    'platform-tunnels': 'https://platform.openai.com/settings/organization/tunnels',
    'platform-keys': 'https://platform.openai.com/api-keys',
    'chatgpt-plugins': 'https://chatgpt.com/plugins', 'chatgpt-chat': 'https://chatgpt.com/',
    'developer-guide': 'https://developers.openai.com/api/docs/guides/secure-mcp-tunnels',
  };
  panel.webview.onDidReceiveMessage(async (message) => {
    try {
      if (!message || typeof message !== 'object') return;
      if (message.type === 'draft') return connectionWizard.updateDraft(message);
      if (message.type === 'submit') return connectionWizard.submit(message);
      if (message.type === 'ready' || message.type === 'refresh') return connectionWizard.refresh();
      if (message.type !== 'action') return;
      if (links[message.action]) await vscode.env.openExternal(vscode.Uri.parse(links[message.action]));
      else if (message.action === 'home') await openHome();
      else if (message.action === 'pick-folder') await chooseOrAuthorizeFolder();
      else if (message.action === 'copy-id') {
        const id = extensionContext.globalState.get(PRIVATE_TUNNEL_ID);
        if (id) await vscode.env.clipboard.writeText(id);
      } else if (message.action === 'copy-verification') await handleHomeAction('verify', { silent: true });
      else if (message.action === 'copy-question') await handleHomeAction('copy-question');
      await connectionWizard.refresh();
    } catch (error) {
      connectionWizard.state.issue = safeSetupIssue(error); connectionWizard.publish();
    }
  });
  panel.onDidChangeViewState((event) => {
    if (event.webviewPanel.visible) void connectionWizard.refresh();
  });
  return connectionWizard.refresh();
}

async function restorePreviousWeb() {
  return withManagedProfileEdit(() => restorePreviousWebImpl());
}

async function restorePreviousWebImpl() {
  const previous = extensionContext.globalState.get(PREVIOUS_WEB_CONFIG);
  const id = extensionContext.globalState.get(PRIVATE_TUNNEL_ID);
  const key = id && await extensionContext.secrets.get(PRIVATE_TUNNEL_KEY);
  if (!previous || previous.auth_mode !== 'github') throw new Error('没有可恢复的原公网连接。');
  const approved = await vscode.window.showWarningMessage(
    `恢复原公网连接 ${previous.public_url}/mcp？当前私有隧道将停止。`,
    { modal: true }, '恢复公网连接',
  );
  if (approved !== '恢复公网连接') return;
  const paths = managedRuntimePaths();
  const current = JSON.parse(fs.readFileSync(paths.config, 'utf8'));
  const restored = { ...current, auth_mode: 'github', public_url: previous.public_url,
    github_user_ids: previous.github_user_ids };
  let running = false;
  await executeWebSetup(paths.config, restored, {
    guard: guardProfileEdit,
    stop: async () => {
      if (tunnelHandle) await stopTunnelClient(tunnelHandle);
      tunnelHandle = undefined;
      running = Boolean(await checkManagedPorts(paths));
      if (running) await execFileAsync(paths.executable, ['stop', '--config', paths.config], { windowsHide: true });
    },
    start: async () => startManaged(paths),
    probe: async () => probePublicEndpoint(restored.public_url),
    quiesce: async () => {
      if (await managedStatus(paths.config)) await execFileAsync(paths.executable,
        ['stop', '--config', paths.config], { windowsHide: true });
    },
    restore: async () => {
      if (running) await startManaged(paths);
      if (id && key) await startConfiguredTunnel(id, key);
    },
  });
  await extensionContext.secrets.delete(PRIVATE_TUNNEL_KEY);
  await extensionContext.globalState.update(PRIVATE_TUNNEL_ID, undefined);
  await extensionContext.globalState.update(PREVIOUS_WEB_CONFIG, undefined);
  await refreshHome();
  vscode.window.showInformationMessage('已恢复原公网连接。请在 ChatGPT 发起真实工具调用确认。');
}

async function diagnoseManagedConnection() {
  const paths = managedRuntimePaths();
  const runtimeInstalled = fs.existsSync(paths.executable);
  const configExists = fs.existsSync(paths.config);
  let config = null;
  if (configExists) config = JSON.parse(fs.readFileSync(paths.config, 'utf8'));
  const owned = config && await managedStatus(paths.config);
  const portsOccupied = Boolean(config && !owned
    && (await portOpen(config.admin_port) || await portOpen(config.mcp_port)));
  let publicReachable = null;
  if (owned && config.public_url) {
    try {
      for (const suffix of ['/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource/mcp']) {
        const response = await fetch(`${config.public_url}${suffix}`, { signal: AbortSignal.timeout(8000) });
        if (!response.ok) throw new Error('public discovery failed');
      }
      publicReachable = true;
    } catch { publicReachable = false; }
  }
  homeDiagnosis = classifyConnection({ runtimeInstalled, configExists, owned: Boolean(owned),
    portsOccupied, authMode: config && config.auth_mode, publicUrl: config && config.public_url,
    publicReachable, health: owned?.health || {}, tunnel: await currentTunnelState() });
  await refreshHome();
  return homeDiagnosis;
}

async function exportManagedDiagnostics() {
  const paths = managedRuntimePaths();
  if (!fs.existsSync(paths.config) || !fs.existsSync(paths.executable)) {
    throw new Error('请先安装并初始化本机服务。');
  }
  const preview = await execFileAsync(paths.executable, ['diagnostics-preview', '--config', paths.config], { windowsHide: true });
  const summary = JSON.parse(preview.stdout);
  const accepted = await vscode.window.showInformationMessage(
    `将导出 ${summary.event_count} 条近期结构化事件和服务状态。默认排除源码、令牌、OAuth 响应、账号身份与本机路径。`,
    { modal: true }, '选择保存位置',
  );
  if (accepted !== '选择保存位置') return;
  const destination = await vscode.window.showSaveDialog({
    filters: { ZIP: ['zip'] }, saveLabel: '导出脱敏诊断包',
    defaultUri: vscode.Uri.file(path.join(os.homedir(), `porthole-diagnostics-${Date.now()}.zip`)),
  });
  if (!destination) return;
  if (destination.scheme !== 'file') throw new Error('诊断包只能保存到本机文件。');
  await execFileAsync(paths.executable, ['diagnostics-export', '--config', paths.config,
    '--output', destination.fsPath], { windowsHide: true });
  vscode.window.showInformationMessage(`脱敏诊断包已保存：${destination.fsPath}`);
}

async function handleHomeAction(action, options = {}) {
  if (['reset-initial', 'refresh', 'reset-guide', 'reset-chatgpt', 'reset-github', 'reset-openai'].includes(action)) {
    return performHomeAction(action, options);
  }
  homeMutationCount += 1;
  try { return await withManagedProfileEdit(() => performHomeAction(action, options)); }
  finally { homeMutationCount -= 1; }
}

async function performHomeAction(action, { silent = false } = {}) {
  if (action === 'reset-initial') return restoreInitialState();
  const externalPages = { 'reset-chatgpt': 'https://chatgpt.com/plugins',
    'reset-github': 'https://github.com/settings/applications',
    'reset-openai': 'https://platform.openai.com/settings/organization/tunnels' };
  if (externalPages[action]) return vscode.env.openExternal(vscode.Uri.parse(externalPages[action]));
  if (action === 'reset-guide') return vscode.commands.executeCommand('markdown.showPreview',
    vscode.Uri.file(path.join(extensionContext.extensionPath, 'RESET.md')));
  if (action !== 'refresh') requireNoReset();
  if (!['diagnose', 'refresh', 'export-diagnostics', 'repair'].includes(action)) homeDiagnosis = undefined;
  if (action === 'install') { await ensureManagedRuntime(); return refreshHome(); }
  if (action === 'start-service') {
    const paths = await ensureManagedRuntime();
    if (!await checkManagedPorts(paths)) await startManaged(paths);
    managedRestartPolicy.resume();
    await extensionContext.globalState.update('porthole.manualServiceStop', false);
    if (!JSON.parse(fs.readFileSync(paths.config, 'utf8')).projects?.length) return refreshHome();
    let paired = false;
    try {
      const client = await homeConnection();
      paired = Boolean(client && await client.getStatus());
    } catch { /* Re-pair below. */ }
    if (!paired) {
      const folder = (vscode.workspace.workspaceFolders || [])[0];
      if (folder) await pairManagedRuntime(folder);
      else return chooseOrAuthorizeFolder();
    }
    return refreshHome();
  }
  if (action === 'stop-service') {
    const paths = managedRuntimePaths();
    if (!fs.existsSync(paths.config) || !fs.existsSync(paths.executable)) return refreshHome();
    if (tunnelHandle) { await stopTunnelClient(tunnelHandle); tunnelHandle = undefined; }
    const owned = await managedStatus(paths.config);
    if (owned) await execFileAsync(paths.executable, ['stop', '--config', paths.config], { windowsHide: true });
    await extensionContext.globalState.update('porthole.manualServiceStop', true);
    managedRestartPolicy.pause();
    return refreshHome();
  }
  if (action === 'toggle-login-startup') {
    const paths = await ensureManagedRuntime();
    if (!fs.existsSync(paths.config)) throw new Error('请先选择项目并配置本机服务。');
    const enabled = await hasLoginStartup(paths.executable, paths.config, execFileAsync);
    if (!enabled) {
      const choice = await vscode.window.showInformationMessage(
        '启用后，Windows 登录时会在后台启动本机服务。私有隧道会在 VS Code 打开时恢复；如使用公网连接，GitHub 凭据将存入 Windows 凭据管理器。',
        { modal: true }, '开启开机启动',
      );
      if (choice !== '开启开机启动') return;
      const config = JSON.parse(fs.readFileSync(paths.config, 'utf8'));
      if (config.auth_mode === 'github') {
        const clientId = await extensionContext.secrets.get(GITHUB_CLIENT_ID_KEY);
        const clientSecret = await extensionContext.secrets.get(GITHUB_CLIENT_SECRET_KEY);
        if (!clientId || !clientSecret) throw new Error('缺少 GitHub OAuth 凭据，请先完成网页连接设置。');
        await runCredentialCommand(paths, 'credential-store', { client_id: clientId, client_secret: clientSecret });
      }
      await setLoginStartup(true, paths.executable, paths.config, execFileAsync);
    } else {
      await setLoginStartup(false, paths.executable, paths.config, execFileAsync);
      await runCredentialCommand(paths, 'credential-clear');
    }
    return refreshHome();
  }
  if (action === 'pick-folder') return chooseOrAuthorizeFolder();
  if (action === 'migrate-web') return migrateManagedWeb();
  if (action === 'setup-web') return setupManagedWeb();
  if (action === 'setup-tunnel') return setupPrivateTunnel();
  if (action === 'restore-web') return restorePreviousWeb();
  if (action === 'start-tunnel') {
    const id = extensionContext.globalState.get(PRIVATE_TUNNEL_ID);
    const key = id && await extensionContext.secrets.get(PRIVATE_TUNNEL_KEY);
    if (!id || !key) return setupPrivateTunnel();
    await extensionContext.globalState.update('porthole.manualTunnelStop', false);
    tunnelRestartPolicy.resume();
    tunnelLastIssue = undefined;
    await startConfiguredTunnel(id, key);
    return refreshHome();
  }
  if (action === 'stop-tunnel') {
    if (tunnelHandle) await stopTunnelClient(tunnelHandle);
    tunnelHandle = undefined;
    await extensionContext.globalState.update('porthole.manualTunnelStop', true);
    tunnelRestartPolicy.pause();
    return refreshHome();
  }
  if (action === 'copy-tunnel-id') {
    const id = extensionContext.globalState.get(PRIVATE_TUNNEL_ID);
    if (!id) throw new Error('尚未设置私有隧道。');
    await vscode.env.clipboard.writeText(id);
    return vscode.window.showInformationMessage('Tunnel ID 已复制。');
  }
  if (action === 'diagnose') return diagnoseManagedConnection();
  if (action === 'repair') {
    if (!homeDiagnosis || !['install', 'pick-folder', 'start-service', 'setup-web',
      'setup-tunnel', 'start-tunnel', 'verify'].includes(homeDiagnosis.repair)) {
      throw new Error('当前没有可自动执行的安全修复操作。');
    }
    const remedy = homeDiagnosis.repair;
    homeDiagnosis = undefined;
    return handleHomeAction(remedy);
  }
  if (action === 'export-diagnostics') return exportManagedDiagnostics();
  if (action === 'upgrade-runtime') {
    await ensureManagedRuntime(true);
    await extensionContext.globalState.update('porthole.rollbackHold', false);
    const installed = JSON.parse(fs.readFileSync(path.join(path.dirname(managedRuntimePaths().executable), 'installed.json'), 'utf8'));
    if (installed.version === require('./package.json').version) {
      await extensionContext.globalState.update('porthole.upgradeResult',
        `已安装当前扩展附带版本 ${installed.version}`);
    }
    return refreshHome();
  }
  if (action === 'restore-upgrade') {
    const id = extensionContext.globalState.get('porthole.lastSnapshotId');
    if (!id || !/^[0-9a-f]{32}$/.test(id)) throw new Error('没有可回退的已验证升级备份。');
    const approved = await vscode.window.showInformationMessage(
      `回退到备份 ${id.slice(0, 8)}？仅当升级后配置和修改记录未变化时才允许回退；项目文件不会被自动覆盖。`,
      { modal: true }, '确认回退',
    );
    if (approved !== '确认回退') return;
    const paths = managedRuntimePaths();
    const config = JSON.parse(fs.readFileSync(paths.config, 'utf8'));
    const stateDir = path.resolve(path.dirname(paths.config), config.state_dir || '.local');
    const running = await checkManagedPorts(paths);
    if (running) await execFileAsync(paths.executable, ['stop', '--config', paths.config], { windowsHide: true });
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'porthole-rollback-'));
    try {
      const runner = path.join(scratch, 'runtime');
      fs.cpSync(path.dirname(paths.executable), runner, { recursive: true });
      await execFileAsync(path.join(runner, 'porthole.exe'), ['upgrade-rollback',
        '--config', paths.config, '--runtime-dir', path.dirname(paths.executable),
        '--state-dir', stateDir, '--snapshot-id', id], { windowsHide: true });
      await extensionContext.globalState.update('porthole.rollbackHold', true);
      await extensionContext.globalState.update('porthole.lastSnapshotId', null);
      await extensionContext.globalState.update('porthole.upgradeResult', `已回退到备份 ${id.slice(0, 8)}；升级已暂停，需手动点击“检查并安装附带版本”。`);
    } catch (error) {
      if (running && !await managedStatus(paths.config)
          && !fs.existsSync(path.join(stateDir, 'upgrade-in-progress.json'))) {
        try { await startManaged(paths); } catch { /* Preserve rollback error. */ }
      }
      throw error;
    } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
    if (running) await startManaged(paths);
    return refreshHome();
  }
  if (action === 'refresh') return refreshHome();
  if (action === 'open-chatgpt-plugins') {
    return vscode.env.openExternal(vscode.Uri.parse('https://chatgpt.com/plugins'));
  }
  if (action === 'web-guide') {
    return vscode.commands.executeCommand('vscode.open', vscode.Uri.file(
      path.join(extensionContext.extensionPath, 'README.md'),
    ));
  }
  const { view, client } = await currentHomeState();
  if (!view.project || !client) throw new Error('请先选择并连接本机项目。');
  if (action === 'copy-question') {
    await vscode.env.clipboard.writeText(buildQuestionPrompt(view.project.id, 'README.md'));
    return vscode.window.showInformationMessage('已复制当前项目的提问模板。');
  }
  if (action === 'verify') {
    if (!homeChallenge || homeChallenge.projectId !== view.project.id
        || !view.challengeExpiresAt || Date.parse(homeChallenge.expiresAt) <= Date.now()) {
      const challenge = await client.request('POST', '/api/verification-challenges', { project_id: view.project.id });
      homeChallenge = { projectId: view.project.id, expiresAt: challenge.expires_at,
        challengeId: challenge.challenge_id };
      await extensionContext.globalState.update('porthole.verificationChallenge', homeChallenge);
    }
    await vscode.env.clipboard.writeText(`请使用舷窗 Porthole 调用 verify_connection，project_id=${view.project.id}，challenge_id=${homeChallenge.challengeId}。只返回工具实际结果。`);
    await refreshHome();
    if (!silent) return vscode.window.showInformationMessage('已复制验证提示词，请在已连接 Porthole 的 ChatGPT 对话中发送。');
    return;
  }
  if (action === 'rename-project') {
    const name = await vscode.window.showInputBox({ title: '项目名称',
      prompt: '此名称会显示在 ChatGPT 的项目列表中；项目标识和授权目录不会改变。',
      value: view.project.name, ignoreFocusOut: true,
      validateInput: (value) => value.trim() && value.trim().length <= 100
        ? null : '请输入 1 到 100 个字符。' });
    if (name === undefined) return;
    await client.request('PATCH', `/api/projects/${encodeURIComponent(view.project.id)}`,
      { name: name.trim() });
    return refreshHome();
  }
  if (action === 'preview-scope') {
    const projectId = view.project.id;
    homeScopePreviews.set(projectId, { project_id: projectId, loading: true });
    await refreshHome();
    try {
      const preview = await client.request('GET', `/api/projects/${encodeURIComponent(projectId)}/scope`);
      homeScopePreviews.set(projectId, preview);
    } catch (error) {
      homeScopePreviews.set(projectId, { project_id: projectId,
        error: `预览失败：${error.message}。请检查本机服务后重新预览。` });
    }
    return refreshHome();
  }
  if (action === 'toggle-proposals' || action === 'toggle-local-apply') {
    const update = projectPolicyChange(view.project, action);
    if (update.mode === 'propose') {
      const approved = await vscode.window.showInformationMessage(
        '允许 AI 为此项目创建待审阅修改建议？此操作不会直接修改本机文件。',
        { modal: true }, '允许提出修改',
      );
      if (approved !== '允许提出修改') return;
    }
    if (update.apply_local_enabled === true) {
      const approved = await vscode.window.showWarningMessage(
        '允许你在 VS Code 逐文件审阅后应用修改？网页无法自动应用。',
        { modal: true }, '允许本机应用',
      );
      if (approved !== '允许本机应用') return;
    }
    await client.request('PATCH', `/api/projects/${encodeURIComponent(view.project.id)}`, update);
    return refreshHome();
  }
  if (action === 'pause-project' || action === 'resume-project') {
    await client.request('PATCH', `/api/projects/${encodeURIComponent(view.project.id)}`, {
      paused: action === 'pause-project',
    });
    homeScopePreviews.delete(view.project.id);
    return refreshHome();
  }
  if (action === 'remove-project') {
    const confirmation = await vscode.window.showWarningMessage(
      `移除 ${view.project.name || view.project.id} 的 AI 访问授权？项目文件不会删除。`,
      { modal: true }, '移除授权',
    );
    if (confirmation !== '移除授权') return;
    await client.request('DELETE', `/api/projects/${encodeURIComponent(view.project.id)}`);
    homeScopePreviews.delete(view.project.id);
    for (const folder of vscode.workspace.workspaceFolders || []) {
      const config = folderConfiguration(folder);
      if (config.get('projectId') !== view.project.id) continue;
      await withBindingLock(folder, async (key) => {
        await clearKeyContents(key);
        await extensionContext.secrets.delete(tokenKey(folder));
        await Promise.all([
          config.update('projectId', undefined, vscode.ConfigurationTarget.WorkspaceFolder),
          config.update('serviceUrl', undefined, vscode.ConfigurationTarget.WorkspaceFolder),
        ]);
      });
    }
    homeSelectedProjectId = undefined;
    return refreshHome();
  }
  throw new Error('未知的首页操作。');
}

async function openHome() {
  if (homePanel) { homePanel.reveal(); return refreshHome(); }
  const panel = vscode.window.createWebviewPanel('porthole.home', '舷窗 Porthole', vscode.ViewColumn.Active, {
    enableScripts: true,
  });
  homePanel = panel;
  panel.webview.html = homeHtml(crypto.randomBytes(16).toString('base64'));
  panel.onDidDispose(() => { if (homePanel === panel) homePanel = undefined; });
  panel.webview.onDidReceiveMessage(async (message) => {
    try {
      if (message.type === 'ready') return refreshHome();
      if (message.type === 'select-project') {
        const { view } = await currentHomeState();
        if (!view.projects.some((item) => item.id === message.projectId)) throw new Error('项目已不存在，请刷新。');
        homeSelectedProjectId = message.projectId;
        await extensionContext.globalState.update('porthole.homeProjectId', message.projectId);
        return refreshHome();
      }
      if (message.type === 'action') return await handleHomeAction(message.action);
    } catch (error) {
      vscode.window.showErrorMessage(`Porthole：${error.message}`);
      await refreshHome();
    }
  });
  return refreshHome();
}

function onboardingFolder(value) {
  return (vscode.workspace.workspaceFolders || []).find(
    (folder) => folder.uri.toString() === value,
  );
}

async function runVsCodeOnboarding() {
  const stateKey = 'porthole.onboarding.v1';
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
      await ensureManagedRuntime();
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
      const prompt = `请使用舷窗 Porthole 调用 verify_connection，project_id=${state.projectId}，challenge_id=${challenge.challenge_id}。只返回工具实际结果。`;
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
  return withManagedProfileEdit(() => saveConnectionImpl(folder, serviceUrl, projectId, token));
}

async function saveConnectionImpl(folder, serviceUrl, projectId, token) {
  requireNoReset();
  const resetGeneration = resetObservedId;
  const write = withBindingLock(folder, async (key) => {
    const normalizedUrl = normalizeServiceUrl(serviceUrl);
    const status = await new ContextClient(normalizedUrl, token).getStatus();
    validateProjectBinding(status, projectId, folder.uri.fsPath);
    await clearKeyContents(key);
    guardProfileEdit();
    if (resetGeneration !== resetObservedId) throw new Error('连接已重置，请重新授权项目。');
    await rememberSecretKey(tokenKey(folder));
    const config = folderConfiguration(folder);
    await Promise.all([
      config.update('serviceUrl', normalizedUrl, vscode.ConfigurationTarget.WorkspaceFolder),
      config.update('projectId', String(projectId), vscode.ConfigurationTarget.WorkspaceFolder),
      extensionContext.secrets.store(tokenKey(folder), token),
    ]);
    await clearKeyContents(key);
    homeResetState = undefined; initialReset = undefined;
    await extensionContext.globalState.update('porthole.resetResult', undefined);
  });
  bindingWritePromises.add(write);
  try { return await write; } finally { bindingWritePromises.delete(write); }
}

async function clearKeyContents(key) {
  const attempts = [...(pendingAttempts.get(key) || [])];
  await Promise.allSettled(attempts.map((attempt) => attempt.promise).filter(Boolean));
  const candidates = [...attempts, publishedConnections.get(key)].filter(Boolean);
  const unique = new Map(candidates.map((item) => [`${item.serviceUrl}\0${item.sessionId}`, item]));
  const results = await Promise.allSettled([...unique.values()].map(({ client, sessionId }) => client.deleteContext(sessionId)));
  publishedConnections.delete(key);
  await clearReview(key);
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
  setStatus('已断开', '点击配置工作区连接', 'porthole.configure');
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

async function recoverManagedService() {
  await observeResetState();
  if (resetIsBlocked()) return;
  if (managedRecoveryPromise) return managedRecoveryPromise;
  managedRecoveryPromise = (async () => {
    const paths = managedRuntimePaths();
    if (globalClosing || !managedRestartPolicy.canRestart()
        || extensionContext.globalState.get('porthole.manualServiceStop')
        || !fs.existsSync(paths.config) || !await extensionContext.secrets.get(MANAGED_TOKEN_KEY)) return;
    if (await managedStatus(paths.config)) { await refreshHome(); return; }
    try {
      await ensureManagedRuntime();
      if (!await checkManagedPorts(paths)) await startManaged(paths);
      await refreshHome();
    } catch (error) {
      managedRestartPolicy.recordCrash();
      setStatus('需要检查', `本机服务恢复失败：${error.message}`);
      await refreshHome();
    }
  })().finally(() => { managedRecoveryPromise = undefined; });
  return managedRecoveryPromise;
}

async function activate(context) {
  extensionContext = context;
  resetObservedId = context.globalState.get('porthole.resetSeenId') || null;
  homeSelectedProjectId = context.globalState.get('porthole.homeProjectId');
  homeChallenge = context.globalState.get('porthole.verificationChallenge');
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 20);
  setStatus('打开首页', '查看项目与连接状态');
  const contentProvider = {
    provideTextDocumentContent: (uri) => virtualChangeContents.get(uri.toString()) ?? '',
  };
  context.subscriptions.push(
    statusBar,
    vscode.workspace.registerTextDocumentContentProvider('porthole-original', contentProvider),
    vscode.workspace.registerTextDocumentContentProvider('porthole-proposed', contentProvider),
    vscode.commands.registerCommand('porthole.home', openHome),
    vscode.commands.registerCommand('porthole.resetInitial', () => restoreInitialState()),
    vscode.commands.registerCommand('porthole.selectProject', async () => {
      await openHome();
      const { view } = await currentHomeState();
      const choices = view.projects.map((project) => ({
        label: project.name || project.id, description: project.root,
        projectId: project.id,
      }));
      choices.push({ label: '$(folder-opened) 选择其他文件夹', projectId: null });
      const picked = await vscode.window.showQuickPick(choices, { title: '选择 Porthole 项目' });
      if (!picked) return;
      if (!picked.projectId) return chooseOrAuthorizeFolder();
      homeSelectedProjectId = picked.projectId;
      await context.globalState.update('porthole.homeProjectId', picked.projectId);
      return refreshHome();
    }),
    vscode.commands.registerCommand('porthole.configure', configure),
    vscode.commands.registerCommand('porthole.onboarding', async () => {
      try {
        await openHome();
      } catch (error) {
        const choice = await vscode.window.showErrorMessage(
          'Porthole 向导暂时无法继续。', '查看错误详情',
        );
        if (choice === '查看错误详情') {
          await vscode.window.showInformationMessage(String(error.message), { modal: true });
        }
      }
    }),
    vscode.commands.registerCommand('porthole.pairManaged', () => pairManagedRuntime().catch((error) => {
      vscode.window.showErrorMessage(`Porthole：${error.message}`);
    })),
    vscode.commands.registerCommand('porthole.migrateWeb', () => migrateManagedWeb().catch((error) => {
      vscode.window.showErrorMessage(`Porthole 网页连接迁移失败：${error.message}`);
    })),
    vscode.commands.registerCommand('porthole.publishContext', () => publishActiveContext()),
    vscode.commands.registerCommand('porthole.disconnect', disconnect),
    vscode.commands.registerCommand('porthole.openAssistant', openAssistant),
    vscode.commands.registerCommand('porthole.showChange', runChangeCommand(showChange)),
    vscode.commands.registerCommand('porthole.applyReviewedChange', runChangeCommand(applyReviewedChange)),
    vscode.commands.registerCommand('porthole.rejectChange', runChangeCommand(rejectReviewedChange)),
    vscode.commands.registerCommand('porthole.revertChange', runChangeCommand(revertReviewedChange)),
    vscode.commands.registerCommand('porthole.viewRecovery', runChangeCommand(viewRecovery)),
    vscode.commands.registerCommand('porthole.showActivity', runChangeCommand(showRecentActivity)),
    vscode.workspace.onDidChangeTextDocument((event) => {
      scheduleAutoSync(event.document);
      publishAllReviewReadiness();
    }),
    vscode.workspace.onDidOpenTextDocument(publishAllReviewReadiness),
    vscode.workspace.onDidCloseTextDocument(publishAllReviewReadiness),
    vscode.workspace.onDidSaveTextDocument(publishAllReviewReadiness),
    vscode.window.onDidChangeTextEditorSelection((event) => scheduleAutoSync(event.textEditor.document)),
    vscode.window.onDidChangeActiveTextEditor(cancelScheduledSyncs),
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) void recoverManagedService().then(recoverPrivateTunnel).catch(() => {});
    }),
    vscode.languages.onDidChangeDiagnostics((event) => {
      const editor = vscode.window.activeTextEditor;
      if (editor && event.uris.some((uri) => uri.toString() === editor.document.uri.toString())) scheduleAutoSync(editor.document);
    }),
  );
  context.subscriptions.push(context.secrets.onDidChange(() => { void observeResetState().catch(() => {}); }));
  await observeResetState();
  if (process.env.PORTHOLE_EXTENSION_TEST !== '1') {
    void recoverManagedService().then(recoverPrivateTunnel).catch(() => {});
    const recoveryTimer = setInterval(() => {
      void recoverManagedService().then(recoverPrivateTunnel).catch(() => {});
    }, 60000);
    context.subscriptions.push({ dispose: () => clearInterval(recoveryTimer) });
    const tunnelTimer = setInterval(() => { void recoverPrivateTunnel().catch(() => {}); }, 15000);
    context.subscriptions.push({ dispose: () => clearInterval(tunnelTimer) });
  }
  if (process.env.PORTHOLE_EXTENSION_TEST === '1') {
    return {
      configureConnection: saveConnection,
      getStoredToken: (folder) => context.secrets.get(tokenKey(folder)),
      publishActiveContext,
      disconnect,
      managedRuntimePaths,
      ensureManagedRuntime,
      currentHomeState,
      handleHomeAction,
      restoreInitialState,
      observeResetState,
      setSharedResetPending: (state) => context.globalState.update('porthole.resetPending', state),
      openHome,
      setupPrivateTunnel,
      wizardSnapshot,
      workspaceFolderForPath,
      pairManagedRuntime,
      runVsCodeOnboarding,
      getSessionId: sessionFor,
      showChange,
      applyReviewedChange,
      rejectReviewedChange,
      revertReviewedChange,
      viewRecovery,
      showRecentActivity,
      publishReviewReadiness: (changeId) => publishReviewReadiness(reviewForChange(changeId)),
    };
  }
}

async function deactivate() {
  globalClosing = true;
  if (tunnelStartPromise) { try { await tunnelStartPromise; } catch { /* Startup was cancelled. */ } }
  if (tunnelHandle) { await stopTunnelClient(tunnelHandle); tunnelHandle = undefined; }
  cancelScheduledSyncs();
  await Promise.allSettled([...changeReviews.keys()].map(clearReview));
  try { await clearAllBindings(); } catch { /* VS Code is closing; cleanup is best effort. */ }
}

module.exports = { activate, deactivate };
