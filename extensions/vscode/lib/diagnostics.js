'use strict';

function classifyConnection({ runtimeInstalled = false, configExists = false, owned = false,
  portsOccupied = false, authMode = 'local', publicUrl = null, publicReachable = null, health = {} }) {
  if (!runtimeInstalled) return { code: 'RUNTIME_MISSING', message: '本机运行包未安装。', repair: 'install' };
  if (!configExists) return { code: 'PROJECT_MISSING', message: '尚未选择并授权项目。', repair: 'pick-folder' };
  if (!owned) return portsOccupied
    ? { code: 'PORT_OCCUPIED', message: '本机端口被其他进程占用；不会停止该进程。', repair: null }
    : { code: 'SERVICE_STOPPED', message: '本机服务已停止，可安全启动。', repair: 'start-service' };
  if (authMode !== 'github' || !publicUrl) {
    return { code: 'WEB_NOT_CONFIGURED', message: '本机服务正常；还需设置 HTTPS 和 GitHub OAuth。', repair: 'setup-web' };
  }
  if (publicReachable === false) return { code: 'HTTPS_UNREACHABLE', message: 'HTTPS 公网发现地址无法访问，请检查转发与域名。', repair: null };
  if (publicReachable !== true) return { code: 'HTTPS_UNVERIFIED', message: '公网连接尚未验证。', repair: null };
  if (health.oauth?.state !== 'ok') {
    return { code: 'ACCOUNT_UNVERIFIED', message: '公网地址可访问；请在 ChatGPT 用允许的账号完成 OAuth 授权。', repair: null };
  }
  if (health.tool_call?.state !== 'ok') {
    return { code: 'TOOL_UNVERIFIED', message: '账号授权可用；还需从 ChatGPT 发起真实工具调用。', repair: 'verify' };
  }
  return { code: 'READY', message: '本机、公网、账号及真实工具调用均已验证。', repair: null };
}

module.exports = { classifyConnection };
