'use strict';

function deriveViewState(input = {}) {
  if (input.changeState === 'pending_review') {
    return { label: '已收到建议', primaryAction: 'review_change', detail: '在 VS Code 中查看文件差异。' };
  }
  if (input.changeState === 'applied') {
    return input.testsPassed
      ? { label: '已应用并已测试', primaryAction: 'view_result', detail: '修改已写入，测试记录为通过。' }
      : { label: '已应用，未运行测试', primaryAction: 'run_tests', detail: '修改已写入；请运行项目测试。' };
  }
  const health = input.health || {};
  if (health.local_service && health.local_service.state === 'failed') {
    return { label: '本机服务未运行', primaryAction: 'start_service', detail: '启动本机服务后继续。' };
  }
  if (health.tool_call && health.tool_call.state === 'ok') {
    return { label: '可以提问', primaryAction: 'ask_question', detail: '真实工具调用已经验证。' };
  }
  return { label: '需要完成连接', primaryAction: 'continue_onboarding', detail: '继续连接并完成一次真实工具调用。' };
}

module.exports = { deriveViewState };
