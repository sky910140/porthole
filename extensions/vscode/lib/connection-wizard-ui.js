'use strict';

function connectionWizardHtml(nonce) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<title>连接 ChatGPT</title><style nonce="${nonce}">
body{font-family:var(--vscode-font-family,system-ui);color:var(--vscode-foreground,#ddd);background:var(--vscode-editor-background,#222);margin:0;padding:24px;line-height:1.55}
main{max-width:720px;margin:auto}h1{font-size:1.5rem;margin:0 0 8px}h2,summary{font-size:1.1rem;margin:0 0 12px}p{margin:8px 0 16px}.muted{color:var(--vscode-descriptionForeground,#aaa)}
section,details{border:1px solid var(--vscode-panel-border,#555);border-radius:6px;padding:18px;margin:16px 0}summary{cursor:pointer}label{display:block;margin:12px 0 6px}input{box-sizing:border-box;width:100%;font:inherit;padding:9px;background:var(--vscode-input-background,#333);color:var(--vscode-input-foreground,#eee);border:1px solid var(--vscode-input-border,#777);border-radius:3px}
.row{display:flex;flex-wrap:wrap;gap:8px}button{font:inherit;padding:8px 12px;border:0;border-radius:4px;cursor:pointer;background:var(--vscode-button-background,#165fa4);color:var(--vscode-button-foreground,#fff)}button.secondary{background:var(--vscode-button-secondaryBackground,#444);color:var(--vscode-button-secondaryForeground,#eee)}button:disabled{opacity:.6;cursor:default}button:focus-visible,input:focus-visible,summary:focus-visible{outline:2px solid var(--vscode-focusBorder,#4799eb);outline-offset:2px}
ol{padding-left:24px}li{margin:8px 0}code{overflow-wrap:anywhere}.steps{display:flex;gap:8px;flex-wrap:wrap;list-style:none;padding:0}.steps li{border-bottom:2px solid var(--vscode-panel-border,#555);padding:4px;font-size:.9rem}.steps li[aria-current=step]{border-color:var(--vscode-focusBorder,#4799eb);font-weight:600}#issue{color:var(--vscode-errorForeground,#ff9999)}[hidden]{display:none!important}
@media(max-width:420px){body{padding:12px}section,details{padding:12px}}
</style></head><body><main>
<h1>连接 ChatGPT</h1><p class="muted">使用官方私有隧道，无需域名或 GitHub OAuth App。首次仍需创建 Tunnel 和运行密钥。</p>
<nav aria-label="连接进度"><ol class="steps"><li data-step="form">1. 连接信息</li><li data-step="checks">2. 自动检查</li><li data-step="chatgpt">3. 添加到 ChatGPT</li><li data-step="verify">4. 确认并使用</li></ol></nav>
<p id="project" class="muted"></p><p id="public-notice" class="muted" hidden>保存后将切换到私有隧道，原公网连接会暂停并保留备份，可从首页恢复。</p><p id="progress" role="status" aria-live="polite">正在读取配置</p><p id="issue" role="alert"></p>
<div class="row"><button class="secondary" type="button" data-action="home">返回首页</button><button class="secondary" type="button" data-action="pick-folder">选择项目</button></div>
<details id="credentials" open><summary>连接信息（可随时修改）</summary>
<p class="muted">只填写以下两项一次。打开外部页面后，返回此处继续。</p>
<div class="row"><button class="secondary" type="button" data-action="platform-tunnels">创建 / 查看 Tunnel</button><button class="secondary" type="button" data-action="platform-keys">创建运行密钥</button></div>
<form id="connection-form"><label for="tunnel-id">Tunnel ID</label><input id="tunnel-id" name="tunnelId" type="text" maxlength="80" placeholder="tunnel_…" autocomplete="off" spellcheck="false" required aria-describedby="id-help">
<p id="id-help" class="muted">从 Platform 的 Tunnels 页面复制；创建需要 Read + Manage，并关联要使用的 ChatGPT 工作区。</p>
<label for="api-key">运行 API Key</label><input id="api-key" name="apiKey" type="password" autocomplete="off" spellcheck="false" aria-describedby="key-help">
<p id="key-help" class="muted">需要 Tunnels Read + Use 权限。仅保存到 VS Code 凭据库，页面不回填密钥。</p>
<button id="submit" type="submit">保存并自动检查</button></form></details>
<section aria-labelledby="checks-title"><h2 id="checks-title">自动检查</h2><ol id="checks"></ol><p class="muted">本机检查不会证明 ChatGPT 已连接。网络短暂中断时会自动重连。</p></section>
<section id="chatgpt" hidden aria-labelledby="chatgpt-title"><h2 id="chatgpt-title">在 ChatGPT 添加一次</h2>
<ol><li>打开插件页，选择“添加 → 创建 MCP 应用”。若入口不可用，先获得并开启开发者模式权限。</li>
<li>名称填 <strong>Porthole</strong>；连接方式选 <strong>隧道（Tunnel）</strong>，填入下面的 ID；身份验证选 <strong>无</strong>。</li>
<li>创建并连接应用，然后新建对话，选中这个应用。</li></ol>
<p>Tunnel ID：<code id="connected-id"></code></p><div class="row"><button type="button" data-action="copy-id">复制 Tunnel ID</button><button class="secondary" type="button" data-action="chatgpt-plugins">打开 ChatGPT 插件页</button><button class="secondary" type="button" data-action="developer-guide">开发者模式与权限说明</button></div>
<p class="muted">看不到隧道时，核对 Tunnel 是否关联当前 ChatGPT 工作区，以及当前账号是否有 Tunnels Use 权限。</p></section>
<section id="verification" hidden aria-labelledby="verify-title"><h2 id="verify-title">确认真实连接</h2>
<p>点击复制后，把提示词发到刚才选中 Porthole 的 ChatGPT 对话中。此页会自动确认结果。</p><button id="copy-verify" type="button" data-action="copy-verification">复制验证提示词</button><p id="countdown" role="status" aria-live="polite"></p></section>
<section id="complete" hidden aria-labelledby="complete-title"><h2 id="complete-title">连接已验证</h2><p>已完成真实工具调用，可以开始提问。</p><div class="row"><button type="button" data-action="copy-question">复制项目提问模板</button><button class="secondary" type="button" data-action="chatgpt-chat">打开 ChatGPT</button></div></section>
</main><script nonce="${nonce}">
const vscode=acquireVsCodeApi();const el=(id)=>document.getElementById(id);let value=null;let draftLoaded=false;let draftTimer;let pending=false;
function countdown(){const expiry=value?.connection?.challengeExpiresAt;const seconds=expiry?Math.ceil((Date.parse(expiry)-Date.now())/1000):0;el('copy-verify').disabled=pending||Boolean(value?.busy)||seconds>0;
el('countdown').textContent=seconds>0?'请在 ChatGPT 发送，等待结果（剩余 '+seconds+' 秒）':expiry?'提示词已过期，可重新复制。':'';}
function render(state){const prior=value?.step;value=state;pending=Boolean(state.busy);const c=state.connection;
el('project').textContent=c.projectId?'当前项目：'+c.projectName+'（'+c.projectId+'）':'请先选择并授权项目。';
el('public-notice').hidden=!c.publicMode;
el('progress').textContent=state.progress||({form:'填入两项连接信息后开始',checks:'正在检查连接，结果会自动更新',chatgpt:'本机检查已通过，继续在 ChatGPT 添加应用',verify:'等待 ChatGPT 的真实工具调用',done:'当前项目的真实连接已验证'}[state.step]);
el('issue').textContent=state.issue?state.issue.message:'';
if(!draftLoaded){el('tunnel-id').value=state.draft.tunnelId;draftLoaded=true;}
el('api-key').placeholder=c.hasKey?'已保存；留空继续使用，填写则替换':'粘贴运行 API Key';
el('submit').disabled=state.busy||!c.projectId;el('submit').textContent=state.busy?'正在自动检查…':'保存并自动检查';
el('tunnel-id').disabled=state.busy;el('api-key').disabled=state.busy;
if(prior!==state.step)el('credentials').open=state.step==='form';
for(const item of document.querySelectorAll('[data-step]')){const current=state.step==='done'?'verify':state.step;item.setAttribute('aria-current',item.dataset.step===current?'step':'false');}
const checks=[['本机 MCP 与项目授权',state.localCheck?.ok?'通过':state.localCheck?.issue?'失败':'等待检查'],['隧道客户端',c.running?'运行中':'未启动'],['隧道服务认证与连接',c.ready?'通过':c.issue?.message||'等待确认'],['ChatGPT 真实工具调用',c.verified?'通过':'等待验证']];
el('checks').replaceChildren();for(const [name,result] of checks){const li=document.createElement('li');li.textContent=name+'：'+result;el('checks').append(li);}
const active=c.configured&&c.ready&&state.localCheck?.ok;el('chatgpt').hidden=!active||state.step==='done';el('verification').hidden=!active||state.step==='done';el('complete').hidden=state.step!=='done';el('connected-id').textContent=c.tunnelId||'';countdown();}
window.addEventListener('message',(event)=>{if(event.data.type==='wizard-state')render(event.data.state);});
el('tunnel-id').addEventListener('input',()=>{clearTimeout(draftTimer);const tunnelId=el('tunnel-id').value;vscode.setState({tunnelId});draftTimer=setTimeout(()=>vscode.postMessage({type:'draft',tunnelId}),250);});
el('connection-form').addEventListener('submit',(event)=>{event.preventDefault();if(pending)return;pending=true;clearTimeout(draftTimer);const tunnelId=el('tunnel-id').value;const apiKey=el('api-key').value;el('api-key').value='';el('submit').disabled=true;vscode.postMessage({type:'submit',tunnelId,apiKey});});
document.addEventListener('click',(event)=>{const action=event.target.closest('button[data-action]')?.dataset.action;if(action){if(action==='copy-verification')pending=true;vscode.postMessage({type:'action',action});}});
setInterval(()=>{countdown();if(document.visibilityState!=='hidden'&&!pending)vscode.postMessage({type:'refresh'});},3000);
vscode.postMessage({type:'ready'});
</script></body></html>`;
}

module.exports = { connectionWizardHtml };
