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
async function refresh() {
  const state = await api('/api/status');
  el('workspace').hidden = false; el('connection').textContent = '本机已连接';
  el('projects').replaceChildren(...state.projects.map(p => item(`${p.name} · ${p.id}`, async () => {
    if (!confirm(`移除 ${p.id} 的 AI 访问授权？项目文件不会删除。`)) return;
    await api(`/api/projects/${encodeURIComponent(p.id)}`, 'DELETE'); await refresh(); message('已移除项目授权。');
  }, '移除授权')));
  if (!state.projects.length) el('projects').append(item('尚未登记项目。'));
  el('sessions').replaceChildren(...state.sessions.map(s => item(`${s.project_id} / ${s.path} · ${s.session_id}`, async () => {
    await api(`/api/context/${encodeURIComponent(s.session_id)}`, 'DELETE'); await refresh(); message('已清除编辑器快照。');
  }, '清除')));
  if (!state.sessions.length) el('sessions').append(item('暂无上下文。请在编辑器插件中发布当前文件。'));
  el('mode').textContent = state.auth_mode === 'local' ? '本地模式 · 网页账号连接尚未配置' : 'OAuth 模式 · 请在官方网页完成连接验收';
  el('endpoint').textContent = `MCP 地址：${state.public_url || `http://127.0.0.1:${state.mcp_port}`}/mcp`;
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
el('refresh').onclick = event => run(event.target, async () => { await refresh(); message('状态已更新。'); });
el('project-form').onsubmit = event => {
  event.preventDefault(); const data = Object.fromEntries(new FormData(event.target));
  run(event.submitter, async () => { await api('/api/projects', 'PUT', data); event.target.reset(); await refresh(); message('项目已授权。'); });
};
