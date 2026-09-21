'use strict';

const CHECKPOINTS = new Set([
  'prerequisites', 'runtime', 'project', 'connection', 'verification', 'complete',
]);

const DEMO_PROJECT = Object.freeze({
  connected: false,
  label: '演示数据，尚未连接 ChatGPT',
  project: Object.freeze({ id: 'demo-notes', name: '示例笔记工具' }),
  files: Object.freeze([
    Object.freeze({ path: 'README.md', size: 183 }),
    Object.freeze({ path: 'src/main.py', size: 426 }),
    Object.freeze({ path: 'tests/test_main.py', size: 318 }),
  ]),
});

function userStep(checkpoint) {
  if (['prerequisites', 'runtime', 'project'].includes(checkpoint)) return 'project';
  if (checkpoint === 'connection') return 'connection';
  return 'try_question';
}

function validateSelfHostedStatus(status) {
  const problems = [];
  if (!status || typeof status.public_url !== 'string' || !status.public_url.startsWith('https://')) {
    problems.push('需要 HTTPS 公网地址');
  }
  if (!status || status.auth_mode !== 'github') problems.push('需要 GitHub OAuth');
  if (!status || status.account_allowlist_configured !== true) {
    problems.push('需要配置允许登录的账号');
  }
  return { ready: problems.length === 0, problems };
}

function safeIdentifier(value, label) {
  const rendered = String(value || '').trim();
  if (!rendered || rendered.length > 256 || /[\r\n\0]/.test(rendered)) {
    throw new Error(`${label}无效。`);
  }
  return rendered;
}

function buildQuestionPrompt(projectId, filePath = '.') {
  const project = safeIdentifier(projectId, '项目标识');
  const target = safeIdentifier(filePath, '文件路径');
  return `请使用 AI Zhagan 读取项目 ${project} 中的 ${target}，先说明它的用途，再列出依据的文件路径。`;
}

function buildResultPrompt(changeId) {
  const change = safeIdentifier(changeId, '修改编号');
  return `请使用 AI Zhagan 查询修改单 ${change} 的当前状态，并说明是否已应用以及是否已运行测试。`;
}

async function runOnboarding(deps) {
  let state = await deps.load();
  if (!state || !CHECKPOINTS.has(state.checkpoint)) state = { checkpoint: 'prerequisites' };

  while (true) {
    if (state.checkpoint === 'prerequisites') {
      if (!await deps.showPrerequisites()) {
        await deps.save(state);
        return { status: 'cancelled', step: 'project' };
      }
      state = { checkpoint: 'runtime' };
      await deps.save(state);
    } else if (state.checkpoint === 'runtime') {
      await deps.ensureRuntime();
      state = { checkpoint: 'project' };
      await deps.save(state);
    } else if (state.checkpoint === 'project') {
      const folders = await deps.listFolders();
      if (!Array.isArray(folders) || folders.length === 0) {
        throw new Error('请先在 VS Code 中打开一个本地文件夹。');
      }
      const selected = folders.length === 1 ? folders[0] : await deps.chooseFolder(folders);
      if (!selected) {
        await deps.save(state);
        return { status: 'cancelled', step: 'project' };
      }
      state = { checkpoint: 'connection', folderId: selected.id };
      await deps.save(state);
    } else if (state.checkpoint === 'connection') {
      const folders = await deps.listFolders();
      const folder = folders.find((item) => item.id === state.folderId);
      if (!folder) {
        state = { checkpoint: 'project' };
        await deps.save(state);
        continue;
      }
      const connected = await deps.connect(folder);
      state = {
        checkpoint: 'verification',
        folderId: folder.id,
        projectId: String(connected.projectId),
      };
      await deps.save(state);
    } else if (state.checkpoint === 'verification') {
      if (await deps.isVerified(state)) {
        state = { ...state, checkpoint: 'complete' };
        await deps.save(state);
        continue;
      }
      await deps.presentTryQuestion(state);
      return { status: 'waiting', step: 'try_question' };
    } else {
      return { status: 'completed', step: 'try_question' };
    }
  }
}

module.exports = {
  CHECKPOINTS,
  DEMO_PROJECT,
  buildQuestionPrompt,
  buildResultPrompt,
  runOnboarding,
  userStep,
  validateSelfHostedStatus,
};
