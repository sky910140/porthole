'use strict';
let token = '';
const el = id => document.getElementById(id);
function message(text, error = false) {
  el('message').textContent = text;
  el('message').className = error ? 'error' : 'success';
}
async function api(path, method = 'GET', data) {
  const response = await fetch(path, {method, headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'}, body: data ? JSON.stringify(data) : undefined, signal: AbortSignal.timeout(10000)});
  if (!response.ok) throw new Error(response.status === 401 ? '令牌无效，请重新连接。' : response.status === 403 ? '访问被拒绝，请检查项目范围。' : response.status === 429 ? '请求过于频繁，请稍后重试。' : '操作失败，请检查项目标识、绝对路径和服务日志。');
  return response.json();
}
function item(text, action, label) {
  const li = document.createElement('li');
  const span = document.createElement('span'); span.textContent = text; li.append(span);
  if (action) { const button = document.createElement('button'); button.className = 'secondary'; button.textContent = label; button.onclick = () => run(button, action); li.append(button); }
  return li;
}
function actionButton(label, operation, danger = false) {
  const button = document.createElement('button');
  button.className = danger ? 'secondary danger' : 'secondary';
  button.textContent = label;
  button.onclick = () => run(button, operation);
  return button;
}
function projectItem(project) {
  const li = document.createElement('li'); li.className = 'project-item';
  const summary = document.createElement('div'); summary.className = 'project-summary';
  const title = document.createElement('strong'); title.textContent = `${project.name} · ${project.id}`;
  const facts = document.createElement('div'); facts.className = 'project-facts';
  const mode = document.createElement('span'); mode.className = 'badge';
  mode.textContent = project.paused ? '已暂停' : project.mode === 'propose' ? '允许提出修改' : '仅查看代码';
  const buffers = document.createElement('span');
  buffers.textContent = `未保存内容：${project.share_editor_buffers ? '共享' : '不共享'}`;
  const apply = document.createElement('span');
  apply.textContent = `本机应用：${project.apply_local_enabled ? '已授权' : '未授权'}`;
  facts.append(mode, buffers, apply); summary.append(title, facts);
  const actions = document.createElement('div'); actions.className = 'project-actions';
  actions.append(
    actionButton(project.mode === 'propose' ? '改为仅查看代码' : '允许提出修改', async () => {
      await api(`/api/projects/${encodeURIComponent(project.id)}`, 'PATCH', {mode: project.mode === 'propose' ? 'read_only' : 'propose'});
      await refresh(); message('项目模式已更新。');
    }),
    actionButton(project.share_editor_buffers ? '停止共享未保存内容' : '共享未保存内容', async () => {
      await api(`/api/projects/${encodeURIComponent(project.id)}`, 'PATCH', {share_editor_buffers: !project.share_editor_buffers});
      await refresh(); message(project.share_editor_buffers ? '已停止共享未保存内容。' : '已允许插件共享未保存内容、选区和诊断。');
    }),
    actionButton(project.paused ? '继续访问' : '暂停访问', async () => {
      await api(`/api/projects/${encodeURIComponent(project.id)}`, 'PATCH', {paused: !project.paused});
      await refresh(); message(project.paused ? '项目访问已恢复。' : '项目访问已暂停。');
    }),
    actionButton('移除授权', async () => {
      if (!confirm(`移除 ${project.id} 的 AI 访问授权？项目文件不会删除。`)) return;
      await api(`/api/projects/${encodeURIComponent(project.id)}`, 'DELETE');
      await refresh(); message('已移除项目授权。');
    }, true),
  );
  li.append(summary, actions); return li;
}
const healthLabels = {
  local_service: '本机服务', transport: '公网通道', oauth: '账号授权', tool_call: '真实工具调用',
};
const stateLabels = {
  unknown: '尚未验证', checking: '验证中', ok: '正常', failed: '失败', expired: '结果已过期',
};
function showPage(target) {
  document.querySelectorAll('[data-page]').forEach(page => { page.hidden = page.id !== target; });
  document.querySelectorAll('#main-nav button').forEach(button => {
    if (button.dataset.target === target) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  document.getElementById(target).querySelector('h2').focus({preventScroll: true});
}
async function refresh() {
  const state = await api('/api/status');
  el('workspace').hidden = false; el('connection').textContent = '本机已连接';
  el('projects').replaceChildren(...state.projects.map(projectItem));
  if (!state.projects.length) el('projects').append(item('尚未登记项目。'));
  el('sessions').replaceChildren(...state.sessions.map(s => item(`${s.project_id} / ${s.path} · ${s.session_id}`, async () => {
    await api(`/api/context/${encodeURIComponent(s.session_id)}`, 'DELETE'); await refresh(); message('已清除编辑器快照。');
  }, '清除')));
  if (!state.sessions.length) el('sessions').append(item('暂无上下文。请在编辑器插件中发布当前文件。'));
  el('mode').textContent = state.auth_mode === 'local' ? '本地模式 · 网页账号连接尚未配置' : 'OAuth 模式 · 请在官方网页完成连接验收';
  el('endpoint').textContent = `MCP 地址：${state.public_url || `http://127.0.0.1:${state.mcp_port}`}/mcp`;
  el('health').replaceChildren(...Object.entries(state.health || {}).map(([layer, check]) =>
    item(`${healthLabels[layer] || layer}：${stateLabels[check.state] || check.state}${check.error_code ? ` · ${check.error_code}` : ''}`)));
}
async function run(button, operation) {
  button.disabled = true;
  try { await operation(); } catch (error) { message(error.message, true); }
  finally { button.disabled = false; }
}
el('connect-form').onsubmit = event => {
  event.preventDefault(); token = el('token').value.trim(); el('token').value = '';
  run(event.submitter, async () => { await refresh(); message('已连接。'); });
};
el('disconnect').onclick = () => { token = ''; el('workspace').hidden = true; el('projects').replaceChildren(); el('sessions').replaceChildren(); el('connection').textContent = '未连接'; message('已清除页面中的令牌。'); };
document.querySelectorAll('#main-nav button').forEach(button => { button.onclick = () => showPage(button.dataset.target); });
el('show-demo').onclick = () => {
  const demo = el('demo'); demo.hidden = !demo.hidden;
  el('show-demo').textContent = demo.hidden ? '查看离线演示' : '收起离线演示';
};
el('refresh').onclick = event => run(event.target, async () => { await refresh(); message('状态已更新。'); });
el('project-form').onsubmit = event => {
  event.preventDefault(); const data = Object.fromEntries(new FormData(event.target));
  run(event.submitter, async () => { await api('/api/projects', 'PUT', data); event.target.reset(); await refresh(); message('项目已授权。'); });
};
