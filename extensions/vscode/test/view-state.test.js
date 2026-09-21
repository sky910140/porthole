'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { deriveViewState } = require('../lib/view-state');

test('maps technical state to one clear next action', () => {
  assert.deepEqual(deriveViewState({ health: { local_service: { state: 'failed' } } }), {
    label: '本机服务未运行', primaryAction: 'start_service', detail: '启动本机服务后继续。',
  });
  assert.equal(deriveViewState({
    health: { local_service: { state: 'ok' }, tool_call: { state: 'ok' } },
  }).primaryAction, 'ask_question');
});

test('distinguishes received, applied and untested changes', () => {
  assert.equal(deriveViewState({ changeState: 'pending_review' }).label, '已收到建议');
  assert.equal(deriveViewState({ changeState: 'applied', testsPassed: false }).label, '已应用，未运行测试');
  assert.equal(deriveViewState({ changeState: 'applied', testsPassed: true }).label, '已应用并已测试');
});
