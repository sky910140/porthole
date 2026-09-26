'use strict';

function deriveHomeView({ runtimeInstalled, managedConfigExists = false, status = null, selectedProjectId = null,
  scopePreview = null, error = null, serviceRunning = false, loginStartup = false,
  installedVersion = null, bundledVersion = null, upgradeResult = null, diagnosis = null,
  lastSnapshotId = null }) {
  const projects = Array.isArray(status && status.projects) ? status.projects : [];
  const project = projects.find((item) => item.id === selectedProjectId) || projects[0] || null;
  const health = status && status.health ? status.health : {};
  const layers = [
    ['local_service', '本机服务'], ['transport', '公网通道'],
    ['oauth', '账号授权'], ['tool_call', '真实工具调用'],
  ].map(([key, label]) => ({ key, label, state: health[key] && health[key].state || 'unknown' }));
  const excluded = scopePreview && scopePreview.excluded_by_reason
    ? Object.values(scopePreview.excluded_by_reason).reduce((sum, count) => sum + count, 0) : 0;
  const scopeText = project && scopePreview && scopePreview.project_id === project.id
    ? `可访问文件 ${scopePreview.accessible_files} 个，已排除 ${excluded} 项；${scopePreview.scan_complete ? '扫描完整' : '未扫描完整，请缩小目录'}`
    : '尚未预览。仅共享所选目录中符合规则的已保存文件。';
  const base = { project, projects, layers, managedConfigExists, serviceRunning, loginStartup,
    installedVersion, bundledVersion, upgradeResult, diagnosis, lastSnapshotId,
    publicUrl: status && status.public_url || null,
    authMode: status && status.auth_mode || 'local', scopeText, error };
  if (!runtimeInstalled && !status) return { ...base, title: '先安装本机服务',
    message: '运行包随当前扩展提供，点击一次即可安装，无需打开终端。', primaryAction: 'install', primaryLabel: '安装本机服务' };
  if (!status && managedConfigExists) return { ...base, title: '启动本机服务',
    message: error ? `本机服务尚未连接：${error}` : '当前本机服务尚未运行。',
    primaryAction: 'start-service', primaryLabel: '启动本机服务' };
  if (!status) return { ...base, title: '选择要授权的项目',
    message: error ? `本机服务尚未连接：${error}` : '选择本机文件夹，确认后默认仅查看已保存代码。',
    primaryAction: 'pick-folder', primaryLabel: '选择文件夹' };
  if (!project) return { ...base, title: '选择要授权的项目',
    message: '当前没有已授权项目。新项目默认仅查看已保存代码。',
    primaryAction: 'pick-folder', primaryLabel: '选择文件夹' };
  if (project.paused) return { ...base, title: '项目访问已暂停',
    message: '该项目目前不会响应文件读取或修改建议。',
    primaryAction: 'resume-project', primaryLabel: '恢复此项目' };
  const state = Object.fromEntries(layers.map((layer) => [layer.key, layer.state]));
  if (status.auth_mode === 'github' && status.public_url
      && state.transport === 'ok' && state.oauth === 'ok' && state.tool_call === 'ok') {
    return { ...base, title: '网页连接已验证', message: '真实工具调用已验证，可以按项目标识提问。',
      primaryAction: 'copy-question', primaryLabel: '复制提问模板' };
  }
  if (status.auth_mode === 'github' && state.transport === 'failed') {
    return { ...base, title: '公网通道未就绪', message: 'HTTPS 公网地址不可用，请先检查连接并修复转发。',
      primaryAction: 'diagnose', primaryLabel: '检查连接' };
  }
  if (status.auth_mode === 'github' && state.oauth === 'failed') {
    return { ...base, title: '账号授权未就绪', message: '请检查 GitHub OAuth 配置，并在 ChatGPT 重新授权。',
      primaryAction: 'diagnose', primaryLabel: '检查连接' };
  }
  if (state.tool_call === 'expired') return { ...base, title: '网页验证已过期',
    message: '上一次真实工具调用结果已过期，请重新验证当前连接。',
    primaryAction: 'verify', primaryLabel: '复制验证提示词' };
  if (status.auth_mode === 'github' && status.public_url
      && state.transport === 'ok' && state.oauth === 'ok') {
    return { ...base, title: '等待网页验证',
      message: '公网通道和账号授权已就绪，还需要从 ChatGPT 发起一次真实工具调用。',
      primaryAction: 'verify', primaryLabel: '复制验证提示词' };
  }
  if (status.auth_mode === 'github' && status.public_url) {
    return { ...base, title: '网页连接待验证',
      message: '网页地址已配置。请在 ChatGPT 发起真实工具调用；若要求登录，请按网页提示重新授权。',
      primaryAction: 'verify', primaryLabel: '复制验证提示词' };
  }
  return { ...base, title: '本机项目已就绪',
    message: '本机已授权此项目；ChatGPT 网页连接还需要完成接入配置。',
    primaryAction: 'setup-web', primaryLabel: '设置网页连接' };
}

function homeHtml(nonce) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<title>AI Zhagan</title><style nonce="${nonce}">
body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);margin:0;padding:24px;line-height:1.5}
main{max-width:760px;margin:auto}h1{font-size:1.55rem;margin:0 0 6px}h2{font-size:1.12rem;margin:0 0 12px}p{margin:8px 0 14px}.muted{color:var(--vscode-descriptionForeground)}
.card{border:1px solid var(--vscode-panel-border);padding:18px;margin:16px 0;border-radius:8px}.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}button,select{font:inherit;padding:7px 11px}
button{cursor:pointer;background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:0;border-radius:4px}button:hover{background:var(--vscode-button-hoverBackground)}
button.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}button.secondary:hover{background:var(--vscode-button-secondaryHoverBackground)}
button:focus-visible,select:focus-visible{outline:2px solid var(--vscode-focusBorder);outline-offset:2px}select{max-width:100%;background:var(--vscode-dropdown-background);color:var(--vscode-dropdown-foreground);border:1px solid var(--vscode-dropdown-border)}
dl{display:grid;grid-template-columns:max-content 1fr;gap:6px 14px;margin:14px 0}dt{color:var(--vscode-descriptionForeground)}dd{margin:0;overflow-wrap:anywhere}ol{padding-left:24px}li{padding:3px 0}code{overflow-wrap:anywhere}#error{color:var(--vscode-errorForeground)}
</style></head><body><main><header><h1>AI Zhagan</h1><p class="muted">选择项目，确认共享范围，再连接你使用的 AI。</p></header>
<section class="card" aria-labelledby="headline"><h2 id="headline">正在检查</h2><p id="summary" role="status" aria-live="polite"></p><div class="row"><button id="primary" type="button">请稍候</button><button type="button" class="secondary" data-action="refresh">刷新状态</button></div><p id="error" role="alert"></p></section>
<section class="card" aria-labelledby="service-heading"><h2 id="service-heading">本机服务</h2><p id="service-state"></p><p id="version-state" class="muted"></p><div class="row"><button type="button" class="secondary" id="service-start" data-action="start-service">启动服务</button><button type="button" class="secondary" id="service-stop" data-action="stop-service">停止服务</button><button type="button" class="secondary" id="login-startup" data-action="toggle-login-startup">开机自动启动</button><button type="button" class="secondary" data-action="upgrade-runtime">检查并安装附带版本</button><button type="button" class="secondary" id="restore-upgrade" data-action="restore-upgrade">回退上一备份</button></div><p id="upgrade-result" class="muted"></p></section>
<section class="card" aria-labelledby="project-heading"><h2 id="project-heading">项目</h2><label for="projects">当前查看</label> <select id="projects"></select><dl><dt>目录</dt><dd id="root">—</dd><dt>项目标识</dt><dd><code id="project-id">—</code></dd><dt>访问模式</dt><dd id="mode">—</dd><dt>本机应用</dt><dd id="apply">—</dd><dt>共享范围</dt><dd id="scope">—</dd></dl><div class="row"><button type="button" class="secondary" data-action="pick-folder">选择其他文件夹</button><button type="button" class="secondary" id="preview" data-action="preview-scope">预览可访问文件</button><button type="button" class="secondary" id="proposals" data-action="toggle-proposals">允许提出修改</button><button type="button" class="secondary" id="local-apply" data-action="toggle-local-apply">允许本机应用</button><button type="button" class="secondary" id="pause" data-action="pause-project">暂停访问</button><button type="button" class="secondary" id="remove" data-action="remove-project">移除授权</button></div></section>
<section class="card" aria-labelledby="connection-heading"><h2 id="connection-heading">连接进度</h2><ol id="layers"></ol><p id="endpoint" class="muted"></p><div class="row"><button type="button" class="secondary" id="setup-web" data-action="setup-web">设置网页连接</button><button type="button" class="secondary" data-action="copy-question">复制提问模板</button><button type="button" class="secondary" id="migrate-web" data-action="migrate-web">迁移旧网页连接</button><button type="button" class="secondary" data-action="web-guide">网页连接说明</button></div></section>
<section class="card" aria-labelledby="diagnosis-heading"><h2 id="diagnosis-heading">检查与修复</h2><p id="diagnosis-result" role="status"></p><div class="row"><button type="button" class="secondary" data-action="diagnose">检查连接</button><button type="button" class="secondary" id="repair" data-action="repair">尝试修复</button><button type="button" class="secondary" data-action="export-diagnostics">导出脱敏诊断包</button></div><p class="muted">诊断包默认不含源码、令牌、OAuth 响应、账号身份和本机路径。</p></section>
<p class="muted">网页提出的修改必须在 VS Code 查看差异并明确应用；本页不会自动写入项目文件。</p>
</main><script nonce="${nonce}">
const vscode=acquireVsCodeApi();let current=null;
const el=(id)=>document.getElementById(id);
window.addEventListener('message',(event)=>{if(event.data.type!=='state')return;const value=event.data.view;current=value;
el('headline').textContent=value.title;el('summary').textContent=value.message;el('primary').textContent=value.primaryLabel;el('primary').dataset.action=value.primaryAction;
el('error').textContent=value.error||'';const picker=el('projects');picker.replaceChildren();
el('service-state').textContent=value.serviceRunning?'运行中':'已停止';
el('service-start').disabled=!value.managedConfigExists||value.serviceRunning;
el('service-stop').disabled=!value.serviceRunning;
el('login-startup').disabled=!value.managedConfigExists;
el('login-startup').textContent=value.loginStartup?'关闭开机启动':'开启开机启动';
el('version-state').textContent='已安装 '+(value.installedVersion||'未知')+'；扩展附带 '+(value.bundledVersion||'未知');
el('upgrade-result').textContent=value.upgradeResult||'';
el('restore-upgrade').disabled=!value.lastSnapshotId;
el('diagnosis-result').textContent=value.diagnosis?value.diagnosis.code+'：'+value.diagnosis.message:'尚未检查。';
el('repair').disabled=!value.diagnosis?.repair;
for(const project of value.projects){const option=document.createElement('option');option.value=project.id;option.textContent=project.name||project.id;picker.append(option)}
picker.disabled=!value.projects.length;if(value.project)picker.value=value.project.id;
el('root').textContent=value.project?.root||'—';el('project-id').textContent=value.project?.id||'—';
el('mode').textContent=value.project?.paused?'已暂停':value.project?.mode==='propose'?'允许提出修改':'仅查看代码';
el('apply').textContent=value.project?.apply_local_enabled?'已允许在 VS Code 审阅后应用':'未授权';
el('proposals').disabled=!value.project;el('proposals').textContent=value.project?.mode==='propose'?'改为仅查看代码':'允许提出修改';
el('local-apply').disabled=!value.project||value.project.mode!=='propose';el('local-apply').textContent=value.project?.apply_local_enabled?'关闭本机应用':'允许本机应用';
el('scope').textContent=value.scopeText;el('preview').disabled=!value.project;
el('pause').disabled=!value.project;el('pause').textContent=value.project?.paused?'恢复访问':'暂停访问';el('pause').dataset.action=value.project?.paused?'resume-project':'pause-project';el('remove').disabled=!value.project;
document.querySelector('button[data-action="copy-question"]').disabled=!value.project;
el('migrate-web').hidden=!value.managedConfigExists||value.authMode==='github';
el('setup-web').hidden=!value.managedConfigExists||value.authMode==='github';
el('endpoint').textContent=value.publicUrl?'MCP 地址：'+value.publicUrl+'/mcp':'网页连接：尚无 HTTPS 地址';
const list=el('layers');list.replaceChildren();const names={ok:'正常',failed:'失败',expired:'已过期',checking:'检查中',unknown:'尚未验证'};
for(const layer of value.layers){const item=document.createElement('li');item.textContent=layer.label+'：'+(names[layer.state]||'尚未验证');list.append(item)}
});
document.addEventListener('click',(event)=>{const action=event.target.closest('button[data-action]')?.dataset.action;if(action)vscode.postMessage({type:'action',action})});
el('projects').addEventListener('change',(event)=>vscode.postMessage({type:'select-project',projectId:event.target.value}));
vscode.postMessage({type:'ready'});
</script></body></html>`;
}

module.exports = { deriveHomeView, homeHtml };
