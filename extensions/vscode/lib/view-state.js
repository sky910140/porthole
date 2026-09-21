'use strict';

function deriveViewState(input = {}) {
  const state = input.changeState;
  if (state) {
    const states = {
      pending_review: { label: '已收到建议', primaryAction: 'review_change', detail: '本地文件尚未改变；请在 VS Code 中查看差异。' },
      rejected: { label: '已拒绝', primaryAction: 'view_result', detail: '该建议没有写入项目文件。' },
      expired: { label: '建议已过期', primaryAction: 'regenerate_change', detail: '请根据当前文件重新生成修改建议。' },
      conflict: { label: '文件已变化', primaryAction: 'regenerate_change', detail: '建议生成后文件发生变化，请重新生成。' },
      applying: { label: '正在应用', primaryAction: 'wait', detail: '请等待本机事务完成，不要重复操作。' },
      applied: input.testsPassed
        ? { label: '已应用并已测试', primaryAction: 'view_result', detail: '修改已写入，测试记录为通过。' }
        : { label: '已应用，未运行测试', primaryAction: 'run_tests', detail: '修改已写入；请运行项目测试。' },
      rolled_back: { label: '应用失败，已恢复', primaryAction: 'review_failure', detail: '文件已恢复到应用前状态。' },
      recovery_required: { label: '需要恢复', primaryAction: 'view_recovery', detail: '项目写入已暂停，请先核对恢复方案。' },
      reverting: { label: '正在撤销', primaryAction: 'wait', detail: '请等待撤销事务完成。' },
      reverted: { label: '已撤销', primaryAction: 'view_result', detail: '文件已恢复到应用前内容。' },
    };
    if (states[state]) return states[state];
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
