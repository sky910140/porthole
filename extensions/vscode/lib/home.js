'use strict';

function localProjectLabel(project) {
  if (project.name && project.name !== project.id) return project.name;
  return String(project.root || '').split(/[\\/]/).filter(Boolean).at(-1) || project.id;
}

function deriveHomeView({ runtimeInstalled, managedConfigExists = false, status = null, selectedProjectId = null,
  scopePreview = null, error = null, serviceRunning = false, loginStartup = false,
  installedVersion = null, bundledVersion = null, upgradeResult = null, diagnosis = null,
  lastSnapshotId = null, challengeExpiresAt = null, tunnel = null, previousWebAvailable = false,
  reset = null }) {
  const projects = Array.isArray(status && status.projects)
    ? status.projects.map((item) => ({ ...item, name: localProjectLabel(item) })) : [];
  const project = projects.find((item) => item.id === selectedProjectId) || projects[0] || null;
  const health = status && status.health ? status.health : {};
  const verifiedAt = project && status?.verification_history?.[project.id] || null;
  const activityAt = project && status?.recent_tool_activity?.[project.id] || null;
  const webConfigured = status?.auth_mode === 'github' && Boolean(status.public_url);
  const privateConfigured = status?.auth_mode === 'local' && Boolean(tunnel?.configured);
  const webVerified = (webConfigured || privateConfigured) && status.current_verified_project_id === project?.id
    && status.health?.tool_call?.state === 'ok'
    && (privateConfigured ? tunnel.ready
      : status.health?.transport?.state === 'ok' && status.health?.oauth?.state === 'ok');
  const progress = [Boolean(runtimeInstalled || status), Boolean(project),
    privateConfigured ? Boolean(tunnel.ready)
      : webConfigured && status.health?.transport?.state !== 'failed', webVerified];
  const currentStep = progress.indexOf(false);
  const steps = ['安装本机服务', '选择项目', '连接 ChatGPT', '验证真实工具调用', '开始提问']
    .map((label, index) => ({ label, state: index < (currentStep < 0 ? 4 : currentStep)
      ? 'done' : index === (currentStep < 0 ? 4 : currentStep) ? 'current' : 'pending' }));
  const layers = (privateConfigured
    ? [['local_service', '本机服务'], ['transport', '私有隧道'], ['tool_call', '真实工具调用']]
    : [['local_service', '本机服务'], ['transport', '公网通道'],
      ['oauth', '账号授权'], ['tool_call', '真实工具调用']])
    .map(([key, label]) => ({ key, label, state: key === 'transport' && privateConfigured
      ? tunnel.ready ? 'ok' : 'failed'
      : key === 'tool_call' && status?.tool_call_project_id !== project?.id
        ? 'unknown' : health[key] && health[key].state || 'unknown' }));
  scopePreview = project && !project.paused && scopePreview?.project_id === project.id ? scopePreview : null;
  const excluded = scopePreview && scopePreview.excluded_by_reason
    ? Object.values(scopePreview.excluded_by_reason).reduce((sum, count) => sum + count, 0) : 0;
  const scopeText = project?.paused ? '项目访问已暂停。恢复访问后重新预览。'
    : scopePreview?.loading ? '正在扫描可访问文件，请稍候。'
    : scopePreview?.error ? '预览失败，请重新预览。' : scopePreview
    ? `可访问文件 ${scopePreview.accessible_files} 个，已排除 ${excluded} 项；${scopePreview.scan_complete ? '扫描完整' : '未扫描完整，请缩小目录'}`
    : '尚未预览。仅共享所选目录中符合规则的已保存文件。';
  const base = { project, projects, layers, steps, managedConfigExists, serviceRunning, loginStartup,
    installedVersion, bundledVersion, upgradeResult, diagnosis, lastSnapshotId,
    publicUrl: status && status.public_url || null,
    authMode: status && status.auth_mode || 'local', scopeText, scopePreview, error, verifiedAt, activityAt,
    tunnel: tunnel || { configured: false, ready: false }, previousWebAvailable, reset,
    challengeExpiresAt: layers.find((layer) => layer.key === 'tool_call')?.state === 'checking'
      ? challengeExpiresAt : null };
  if (reset && ['running', 'failed'].includes(reset.phase)) return { ...base,
    title: reset.phase === 'running' ? '正在恢复初始状态' : '恢复尚未完成',
    message: reset.issue?.message || reset.label || '正在清除本机授权和连接设置，项目文件会保留。',
    primaryAction: 'reset-initial', primaryLabel: '继续恢复初始状态' };
  if (reset?.phase === 'complete' && !project) return { ...base, title: '已恢复初始状态',
    message: '本机授权和连接设置已清除。选择文件夹重新开始；外部账号连接请按下方提示单独处理。',
    primaryAction: 'pick-folder', primaryLabel: '选择文件夹' };
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
  if (webVerified) {
    return { ...base, title: '网页连接已验证', message: '真实工具调用已验证，可以按项目标识提问。',
      primaryAction: 'copy-question', primaryLabel: '复制提问模板' };
  }
  if (privateConfigured && !tunnel.ready) {
    return { ...base, title: '私有连接未就绪',
      message: tunnel.error || '本机服务已就绪；启动私有隧道后，再在 ChatGPT 添加连接。',
      primaryAction: tunnel.issue?.repair || (tunnel.running ? 'setup-tunnel' : 'start-tunnel'),
      primaryLabel: tunnel.issue?.repair === 'setup-tunnel' ? '修改连接信息'
        : tunnel.running ? '查看连接进度' : '启动私有隧道' };
  }
  if (privateConfigured && state.tool_call === 'expired') {
    return { ...base, title: '当前网页状态待确认',
      message: '私有隧道在线，但真实工具调用状态已过期。请重新验证。',
      primaryAction: 'verify', primaryLabel: '复制验证提示词' };
  }
  if (privateConfigured) {
    return { ...base, title: '等待 ChatGPT 验证',
      message: '私有隧道在线。请在 ChatGPT 添加 Tunnel 连接，再发起一次真实工具调用。',
      primaryAction: 'setup-tunnel', primaryLabel: '继续连接向导' };
  }
  if (status.auth_mode === 'github' && state.transport === 'failed') {
    return { ...base, title: '公网通道未就绪', message: 'HTTPS 公网地址不可用，请先检查连接并修复转发。',
      primaryAction: 'diagnose', primaryLabel: '检查连接' };
  }
  if (status.auth_mode === 'github' && state.oauth === 'failed') {
    return { ...base, title: '账号授权未就绪', message: '请检查 GitHub OAuth 配置，并在 ChatGPT 重新授权。',
      primaryAction: 'diagnose', primaryLabel: '检查连接' };
  }
  if (state.tool_call === 'expired') return { ...base, title: '当前网页状态待确认',
    message: verifiedAt
      ? '上次验证成功；当前状态已过期，请重新验证。历史成功不代表此刻仍可连接。'
      : '验证状态已过期，请重新验证当前连接。',
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
    message: '本机已授权此项目。推荐使用私有隧道连接 ChatGPT，无需域名和 GitHub OAuth App。',
    primaryAction: 'setup-tunnel', primaryLabel: '连接 ChatGPT（推荐）' };
}

function homeHtml(nonce) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<title>舷窗 Porthole</title><style nonce="${nonce}">
body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);margin:0;padding:24px;line-height:1.5}
main{max-width:760px;margin:auto}h1{font-size:1.55rem;margin:0 0 6px}h2{font-size:1.12rem;margin:0 0 12px}p{margin:8px 0 14px}.muted{color:var(--vscode-descriptionForeground)}
.card{border:1px solid var(--vscode-panel-border);padding:18px;margin:16px 0;border-radius:8px}.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}button,select{font:inherit;padding:7px 11px}
button{cursor:pointer;background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:0;border-radius:4px}button:hover{background:var(--vscode-button-hoverBackground)}
button.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}button.secondary:hover{background:var(--vscode-button-secondaryHoverBackground)}
button:focus-visible,select:focus-visible{outline:2px solid var(--vscode-focusBorder);outline-offset:2px}select{max-width:100%;background:var(--vscode-dropdown-background);color:var(--vscode-dropdown-foreground);border:1px solid var(--vscode-dropdown-border)}
dl{display:grid;grid-template-columns:max-content 1fr;gap:6px 14px;margin:14px 0}dt{color:var(--vscode-descriptionForeground)}dd{margin:0;overflow-wrap:anywhere}ol{padding-left:24px}li{padding:3px 0}code{overflow-wrap:anywhere}#error{color:var(--vscode-errorForeground)}
#onboarding-steps{display:flex;flex-wrap:wrap;gap:6px;list-style:none;padding:0;margin:12px 0}#onboarding-steps li{border:1px solid var(--vscode-panel-border);border-radius:20px;padding:4px 10px;font-size:.87rem}#onboarding-steps li[data-state="current"]{border-color:var(--vscode-focusBorder);font-weight:600}#onboarding-steps li[data-state="done"]{color:var(--vscode-descriptionForeground)}
#reset-external[hidden]{display:none}#reset-external{overflow-wrap:anywhere}
#scope-preview[hidden]{display:none}#scope-preview{margin-top:16px;overflow-wrap:anywhere}#scope-preview summary{cursor:pointer;font-weight:600}#scope-preview summary:focus-visible{outline:2px solid var(--vscode-focusBorder)}#scope-files{max-height:320px;overflow:auto;padding-left:24px}#scope-note{margin:12px 0}#scope-error{color:var(--vscode-errorForeground)}h3{font-size:1rem;margin:14px 0 8px}#scope-exclusions{padding-left:24px}button:disabled{cursor:default;opacity:.6}
</style></head><body><main><header><h1>舷窗 Porthole</h1><p class="muted">选择项目，确认共享范围，再连接你使用的 AI。</p></header>
<nav aria-label="新手进度"><ol id="onboarding-steps"></ol></nav>
<section class="card" aria-labelledby="headline"><h2 id="headline">正在检查</h2><p id="summary" role="status" aria-live="polite"></p><p id="verification-progress" role="status"></p><div class="row"><button id="primary" type="button">请稍候</button><button type="button" class="secondary" data-action="refresh">刷新状态</button></div><p id="error" role="alert"></p></section>
<section class="card" aria-labelledby="service-heading"><h2 id="service-heading">本机服务</h2><p id="service-state"></p><p id="version-state" class="muted"></p><div class="row"><button type="button" class="secondary" id="service-start" data-action="start-service">启动服务</button><button type="button" class="secondary" id="service-stop" data-action="stop-service">停止服务</button><button type="button" class="secondary" id="login-startup" data-action="toggle-login-startup">开机自动启动</button><button type="button" class="secondary" data-action="upgrade-runtime">检查并安装附带版本</button><button type="button" class="secondary" id="restore-upgrade" data-action="restore-upgrade">回退上一备份</button></div><p id="upgrade-result" class="muted"></p></section>
<section class="card" aria-labelledby="project-heading"><h2 id="project-heading">项目</h2><label for="projects">当前查看</label> <select id="projects"></select><dl><dt>目录</dt><dd id="root">—</dd><dt>项目标识</dt><dd><code id="project-id">—</code></dd><dt>访问模式</dt><dd id="mode">—</dd><dt>本机应用</dt><dd id="apply">—</dd><dt>共享范围</dt><dd id="scope">—</dd></dl><p class="muted">文本用 read_file；CSV、XLSX 用 read_table；PDF、图片等暂不解析内容。</p><div class="row"><button type="button" class="secondary" data-action="pick-folder">选择其他文件夹</button><button type="button" class="secondary" id="rename-project" data-action="rename-project">重命名项目</button><button type="button" class="secondary" id="preview" data-action="preview-scope">预览可访问文件</button><button type="button" class="secondary" id="proposals" data-action="toggle-proposals">允许提出修改</button><button type="button" class="secondary" id="local-apply" data-action="toggle-local-apply">允许本机应用</button><button type="button" class="secondary" id="pause" data-action="pause-project">暂停访问</button><button type="button" class="secondary" id="remove" data-action="remove-project">移除授权</button></div><details id="scope-preview" hidden><summary>可访问文件清单与排除原因</summary><p id="scope-note" role="status" aria-live="polite"></p><p id="scope-error" role="alert"></p><ul id="scope-files" aria-label="可访问文件"></ul><h3>排除原因</h3><ul id="scope-exclusions" aria-label="排除原因"></ul></details></section>
<section class="card" aria-labelledby="connection-heading"><h2 id="connection-heading">连接 ChatGPT</h2><ol id="layers"></ol><p id="endpoint" class="muted"></p><p id="connection-help" class="muted"></p><div class="row"><button type="button" id="setup-tunnel" data-action="setup-tunnel">连接 ChatGPT（推荐）</button><button type="button" class="secondary" id="start-tunnel" data-action="start-tunnel">启动私有隧道</button><button type="button" class="secondary" id="stop-tunnel" data-action="stop-tunnel">停止私有隧道</button><button type="button" class="secondary" id="copy-tunnel-id" data-action="copy-tunnel-id">复制 Tunnel ID</button><button type="button" class="secondary" data-action="open-chatgpt-plugins">打开 ChatGPT 插件页</button><button type="button" class="secondary" data-action="copy-question">复制提问模板</button><button type="button" class="secondary" id="setup-web" data-action="setup-web">高级：公网连接</button><button type="button" class="secondary" id="restore-web" data-action="restore-web">恢复原公网连接</button><button type="button" class="secondary" id="migrate-web" data-action="migrate-web">迁移旧网页连接</button><button type="button" class="secondary" data-action="web-guide">连接说明</button></div></section>
<section class="card" aria-labelledby="diagnosis-heading"><h2 id="diagnosis-heading">检查与修复</h2><p id="diagnosis-result" role="status"></p><div class="row"><button type="button" class="secondary" data-action="diagnose">检查连接</button><button type="button" class="secondary" id="repair" data-action="repair">尝试修复</button><button type="button" class="secondary" data-action="export-diagnostics">导出脱敏诊断包</button><button type="button" class="secondary" id="initial-reset" data-action="reset-initial">恢复初始状态</button></div><p class="muted">恢复初始状态会清除全部本机授权和连接设置，保留安装、项目原文件、修改历史及恢复备份。</p><p id="reset-summary" role="status" aria-live="polite"></p><div id="reset-external" hidden><p>本机清理已完成。以下外部连接尚需你手动检查；打开页面不代表已经撤销授权。</p><div class="row"><button type="button" class="secondary" data-action="reset-chatgpt">打开 ChatGPT 连接管理</button><button type="button" class="secondary" id="reset-github" data-action="reset-github">检查 GitHub 授权</button><button type="button" class="secondary" id="reset-openai" data-action="reset-openai">检查云端 Tunnel 和 API Key</button><button type="button" class="secondary" data-action="reset-guide">查看清理步骤</button></div></div><p class="muted">诊断包默认不含源码、令牌、OAuth 响应、账号身份和本机路径。</p></section>
<p class="muted">网页提出的修改必须在 VS Code 查看差异并明确应用；本页不会自动写入项目文件。</p>
</main><script nonce="${nonce}">
const vscode=acquireVsCodeApi();let current=null;let verificationExpiresAt=null;let lastVerificationPoll=0;let scopeRenderKey=null;
const el=(id)=>document.getElementById(id);
function renderScopePreview(value){
const preview=value.scopePreview;const panel=el('scope-preview');const files=el('scope-files');const excluded=el('scope-exclusions');
files.replaceChildren();excluded.replaceChildren();el('scope-error').textContent='';el('scope-note').textContent='';
panel.hidden=!preview;panel.setAttribute('aria-busy',String(Boolean(preview?.loading)));
el('preview').disabled=!value.project||Boolean(value.project.paused)||Boolean(preview?.loading);
el('preview').textContent=preview?.loading?'正在扫描…':preview?'重新预览':'预览可访问文件';
if(!preview){scopeRenderKey=null;return}
const key=JSON.stringify(preview);if(key!==scopeRenderKey)panel.open=true;scopeRenderKey=key;
if(preview.loading){el('scope-note').textContent='正在扫描可访问文件，请稍候。';return}
if(preview.error){el('scope-error').textContent=preview.error;return}
const rows=Array.isArray(preview.files)?preview.files:null;
const note=rows===null?'当前本机服务只返回数量，请点击“检查并安装附带版本”升级后查看文件清单。'
:!rows.length?'没有可访问文件，请检查所选目录和排除规则。'
:preview.files_truncated?'仅展示 '+rows.length+' 个文件；本次扫描发现可访问文件 '+preview.accessible_files+' 个。'
:'本次扫描发现 '+rows.length+' 个可访问文件，路径相对于所选目录。';
el('scope-note').textContent=note+(preview.scan_complete?'':' 未扫描完整，请检查目录权限或缩小目录后重新预览。');
const methods={table:'表格',unsupported:'暂不解析内容',text_candidate:'文本（读取时检查格式）'};
for(const file of rows||[]){const item=document.createElement('li');item.textContent=file.path+' · '+file.size+' 字节 · '+(methods[file.read_as]||'读取时检查格式');files.append(item)}
const reasons={sensitive_path:'敏感文件或内部目录',configured_exclusion:'项目排除规则',file_too_large:'文件超过大小限制',link_or_reparse:'链接或重解析点',unavailable:'无法访问'};
for(const [reason,count] of Object.entries(preview.excluded_by_reason||{})){const item=document.createElement('li');item.textContent=(reasons[reason]||'其他排除规则')+'：'+count+' 项';excluded.append(item)}
if(!excluded.children.length){const item=document.createElement('li');item.textContent='没有排除项。';excluded.append(item)}
}
window.addEventListener('message',(event)=>{if(event.data.type!=='state')return;const value=event.data.view;current=value;
for(const button of document.querySelectorAll('button'))button.disabled=false;
verificationExpiresAt=value.challengeExpiresAt?Date.parse(value.challengeExpiresAt):null;
el('headline').textContent=value.title;el('summary').textContent=value.message;el('primary').textContent=value.primaryLabel;el('primary').dataset.action=value.primaryAction;
const steps=el('onboarding-steps');steps.replaceChildren();for(const step of value.steps){const item=document.createElement('li');item.dataset.state=step.state;item.textContent=(step.state==='done'?'✓ ':step.state==='current'?'当前：':'')+step.label;steps.append(item)}
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
renderScopePreview(value);
el('rename-project').disabled=!value.project;
el('pause').disabled=!value.project;el('pause').textContent=value.project?.paused?'恢复访问':'暂停访问';el('pause').dataset.action=value.project?.paused?'resume-project':'pause-project';el('remove').disabled=!value.project;
document.querySelector('button[data-action="copy-question"]').disabled=!value.project;
el('migrate-web').hidden=!value.managedConfigExists||value.authMode==='github'||value.tunnel.configured;
el('setup-web').hidden=!value.managedConfigExists||value.authMode==='github'||value.tunnel.configured;
el('setup-tunnel').hidden=!value.managedConfigExists;
el('setup-tunnel').textContent=value.tunnel.configured?'管理连接 / 继续设置':value.authMode==='github'?'改用私有隧道':'连接 ChatGPT（推荐）';
el('start-tunnel').hidden=!value.tunnel.configured||value.tunnel.running;
el('stop-tunnel').hidden=!value.tunnel.configured||!value.tunnel.running;
el('copy-tunnel-id').hidden=!value.tunnel.configured;
el('restore-web').hidden=!value.previousWebAvailable;
el('endpoint').textContent=value.tunnel.configured?'Tunnel ID：'+value.tunnel.id:value.publicUrl?'MCP 地址：'+value.publicUrl+'/mcp':'尚未连接 ChatGPT';
el('connection-help').textContent=value.tunnel.configured?'在 ChatGPT 创建 MCP 应用时选择“Tunnel”并填写此 ID；身份验证选“无”。项目文件仍只在明确授权范围内读取。':'推荐方式仍需 OpenAI Platform 的 Tunnel ID、运行密钥，以及 ChatGPT 开发者模式权限。';
el('verification-progress').textContent=value.verifiedAt?'上次验证成功：'+new Date(value.verifiedAt).toLocaleString('zh-CN'):'';
if(value.activityAt)el('verification-progress').textContent+='；最近工具调用：'+new Date(value.activityAt).toLocaleString('zh-CN');
const list=el('layers');list.replaceChildren();const names={ok:'正常',failed:'失败',expired:'已过期',checking:'检查中',unknown:'尚未验证'};
for(const layer of value.layers){const item=document.createElement('li');item.textContent=layer.label+'：'+(names[layer.state]||'尚未验证');list.append(item)}
el('initial-reset').textContent=['running','failed'].includes(value.reset?.phase)?'继续恢复初始状态':'恢复初始状态';
el('reset-summary').textContent=value.reset?.phase==='complete'?'本机恢复完成，原文件和修改历史已保留。':value.reset?.issue?.message||value.reset?.label||'';
el('reset-external').hidden=value.reset?.phase!=='complete';
el('reset-github').hidden=!value.reset?.external?.github;el('reset-openai').hidden=!value.reset?.external?.openai;
if(['running','failed'].includes(value.reset?.phase)){
for(const button of document.querySelectorAll('button')){
const action=button.dataset.action;button.disabled=value.reset.phase==='running'||!['refresh','reset-initial','reset-guide'].includes(action)}
picker.disabled=true;verificationExpiresAt=null;
}
});
setInterval(()=>{if(!verificationExpiresAt)return;const seconds=Math.ceil((verificationExpiresAt-Date.now())/1000);
if(seconds<=0){verificationExpiresAt=null;el('verification-progress').textContent='验证提示词已过期，请重新复制。';return}
el('verification-progress').textContent='已复制验证提示词，请在 ChatGPT 发送；剩余 '+seconds+' 秒。';
if(Date.now()-lastVerificationPoll>=4000){lastVerificationPoll=Date.now();vscode.postMessage({type:'action',action:'refresh'})}},1000);
document.addEventListener('click',(event)=>{const action=event.target.closest('button[data-action]')?.dataset.action;if(action){if(action==='preview-scope'&&current?.project){renderScopePreview({...current,scopePreview:{project_id:current.project.id,loading:true}})}vscode.postMessage({type:'action',action})}});
el('projects').addEventListener('change',(event)=>vscode.postMessage({type:'select-project',projectId:event.target.value}));
vscode.postMessage({type:'ready'});
</script></body></html>`;
}

module.exports = { deriveHomeView, homeHtml };
