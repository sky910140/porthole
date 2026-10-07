'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { deriveHomeView, homeHtml } = require('../lib/home');

test('home gives one actionable step for installation, authorization and web verification', () => {
  assert.equal(deriveHomeView({ runtimeInstalled: false }).primaryAction, 'install');
  assert.equal(deriveHomeView({ runtimeInstalled: true }).primaryAction, 'pick-folder');
  const project = { id: 'demo', name: 'Demo', root: 'D:\\demo', mode: 'read_only' };
  const local = deriveHomeView({ runtimeInstalled: true, status: {
    projects: [project], auth_mode: 'local',
    health: { local_service: { state: 'ok' }, transport: { state: 'unknown' },
      oauth: { state: 'unknown' }, tool_call: { state: 'unknown' } },
  }, selectedProjectId: 'demo' });
  assert.equal(local.primaryAction, 'setup-tunnel');
  assert.equal(local.project.id, 'demo');
  assert.match(local.message, /ChatGPT/);
  const verified = deriveHomeView({ runtimeInstalled: true, status: {
    projects: [project], auth_mode: 'github', public_url: 'https://example.test',
    current_verified_project_id: 'demo',
    tool_call_project_id: 'demo',
    health: { local_service: { state: 'ok' }, transport: { state: 'ok' },
      oauth: { state: 'ok' }, tool_call: { state: 'ok' } },
  }, selectedProjectId: 'demo' });
  assert.equal(verified.primaryAction, 'copy-question');
  assert.match(verified.message, /已验证/);
});

test('private tunnel is the beginner path and requires a real project tool call', () => {
  const status = { projects: [{ id: 'p', root: 'D:\\work\\p' }], auth_mode: 'local',
    health: { local_service: { state: 'ok' }, tool_call: { state: 'unknown' } } };
  const pending = deriveHomeView({ runtimeInstalled: true, managedConfigExists: true,
    status, tunnel: { configured: true, ready: true, id: `tunnel_${'a'.repeat(32)}` } });
  assert.equal(pending.primaryAction, 'setup-tunnel');
  assert.equal(pending.layers[1].label, '私有隧道');
  assert.match(pending.message, /真实工具调用/);
  const stopped = deriveHomeView({ runtimeInstalled: true, managedConfigExists: true,
    status, tunnel: { configured: true, ready: false } });
  assert.equal(stopped.primaryAction, 'start-tunnel');
  const verified = deriveHomeView({ runtimeInstalled: true, managedConfigExists: true,
    status: { ...status, current_verified_project_id: 'p', tool_call_project_id: 'p',
      health: { tool_call: { state: 'ok' } } },
    tunnel: { configured: true, ready: true } });
  assert.equal(verified.primaryAction, 'copy-question');
  assert.match(homeHtml('nonce'), /data-action="setup-tunnel"/);
});

test('expired tool call is not shown as a current web connection', () => {
  const view = deriveHomeView({ runtimeInstalled: true, status: {
    projects: [{ id: 'p', name: 'P', root: 'D:\\p', mode: 'read_only' }],
    auth_mode: 'github', public_url: 'https://example.test',
    tool_call_project_id: 'p',
    health: { local_service: { state: 'ok' }, transport: { state: 'ok' },
      oauth: { state: 'ok' }, tool_call: { state: 'expired' } },
  }, selectedProjectId: 'p' });
  assert.equal(view.primaryAction, 'verify');
  assert.match(view.message, /过期/);
});

test('expired live verification retains historical success without claiming current health', () => {
  const view = deriveHomeView({ runtimeInstalled: true, status: {
    projects: [{ id: 'p', name: 'P', root: 'D:\\p', mode: 'read_only' }],
    auth_mode: 'github', public_url: 'https://example.test',
    tool_call_project_id: 'p',
    verification_history: { p: '2026-09-26T10:00:00+00:00' },
    recent_tool_activity: { p: '2026-09-26T10:05:00+00:00' },
    health: { transport: { state: 'ok' }, oauth: { state: 'ok' },
      tool_call: { state: 'expired' } },
  }, selectedProjectId: 'p' });
  assert.equal(view.primaryAction, 'verify');
  assert.match(view.message, /上次验证成功/);
  assert.match(view.message, /当前状态/);
  assert.doesNotMatch(view.title, /连接已断开/);
  assert.ok(view.verifiedAt);
  assert.ok(view.activityAt);
});

test('scope preview reports accessible files without claiming a truncated scan is complete', () => {
  const status = { projects: [{ id: 'p', name: 'P', root: 'D:\\p', mode: 'read_only' }],
    auth_mode: 'local' };
  const view = deriveHomeView({ runtimeInstalled: true, status, selectedProjectId: 'p',
    scopePreview: { project_id: 'p', accessible_files: 42, excluded_by_reason: { secret: 2 },
      scan_complete: false } });
  assert.match(view.scopeText, /42/);
  assert.match(view.scopeText, /未扫描完整/);
});

test('home delivers file details only for the selected project', () => {
  const status = { projects: [{ id: 'one', root: 'D:\\one' }, { id: 'two', root: 'D:\\two' }] };
  const preview = { project_id: 'one', accessible_files: 1, scan_complete: true,
    excluded_by_reason: { sensitive_path: 2 }, files_truncated: false,
    files: [{ path: 'src/说明.txt', size: 5, read_as: 'text_candidate' }] };
  const matching = deriveHomeView({ runtimeInstalled: true, status, scopePreview: preview });
  assert.deepEqual(matching.scopePreview.files,
    [{ path: 'src/说明.txt', size: 5, read_as: 'text_candidate' }]);
  const switched = deriveHomeView({ runtimeInstalled: true, status,
    selectedProjectId: 'two', scopePreview: preview });
  assert.equal(switched.scopePreview, null);
});

test('pending and failed scope scans do not show undefined file counts', () => {
  const status = { projects: [{ id: 'p', root: 'D:\\p' }] };
  const pending = deriveHomeView({ runtimeInstalled: true, status,
    scopePreview: { project_id: 'p', loading: true } });
  assert.match(pending.scopeText, /正在扫描/);
  assert.doesNotMatch(pending.scopeText, /undefined/);
  const failed = deriveHomeView({ runtimeInstalled: true, status,
    scopePreview: { project_id: 'p', error: '读取失败' } });
  assert.match(failed.scopeText, /失败/);
  assert.equal(failed.scopePreview.error, '读取失败');
});

test('paused project does not display a previously cached scope list', () => {
  const view = deriveHomeView({ runtimeInstalled: true,
    status: { projects: [{ id: 'p', root: 'D:\\p', paused: true }] },
    scopePreview: { project_id: 'p', accessible_files: 1, scan_complete: true,
      files: [{ path: 'private-name.txt', size: 5 }] } });
  assert.equal(view.scopePreview, null);
  assert.match(view.scopeText, /暂停/);
});

test('an explicitly connected manual service remains usable without managed runtime', () => {
  const view = deriveHomeView({ runtimeInstalled: false, status: {
    projects: [{ id: 'manual', name: 'Manual', root: 'D:\\manual', mode: 'read_only' }],
    auth_mode: 'local', health: { local_service: { state: 'ok' } },
  }, selectedProjectId: 'manual' });
  assert.equal(view.project.id, 'manual');
  assert.notEqual(view.primaryAction, 'install');
});

test('an installed service can be restarted and the migration action stays available', () => {
  const view = deriveHomeView({ runtimeInstalled: true, managedConfigExists: true,
    error: 'connection refused' });
  assert.equal(view.primaryAction, 'start-service');
  assert.equal(view.managedConfigExists, true);
  assert.match(homeHtml('test-nonce'), /data-action="migrate-web"/);
});

test('configured OAuth still requires a real ChatGPT tool call before claiming success', () => {
  const view = deriveHomeView({ runtimeInstalled: true, managedConfigExists: true,
    status: { projects: [{ id: 'p', root: 'D:\\p' }], auth_mode: 'github',
      public_url: 'https://example.test', health: {} } });
  assert.equal(view.title, '网页连接待验证');
  assert.equal(view.primaryAction, 'verify');
});

test('home directs failed HTTPS transport to diagnosis before tool verification', () => {
  const view = deriveHomeView({ runtimeInstalled: true, managedConfigExists: true,
    status: { projects: [{ id: 'p', root: 'D:\\p' }], auth_mode: 'github',
      public_url: 'https://example.test', health: { transport: { state: 'failed' } } } });
  assert.equal(view.primaryAction, 'diagnose');
  assert.match(view.message, /公网/);
  assert.equal(view.steps[2].state, 'current');
});

test('home surfaces managed service and login-startup controls', () => {
  const html = homeHtml('test-nonce');
  assert.match(html, /data-action="stop-service"/);
  assert.match(html, /data-action="toggle-login-startup"/);
  const view = deriveHomeView({ runtimeInstalled: true, managedConfigExists: true,
    serviceRunning: false, loginStartup: true });
  assert.equal(view.serviceRunning, false);
  assert.equal(view.loginStartup, true);
});

test('pending verification shows a countdown and requests bounded status polling', () => {
  const view = deriveHomeView({ runtimeInstalled: true, status: {
    projects: [{ id: 'p', root: 'D:\\p' }], auth_mode: 'github',
    public_url: 'https://example.test',
    tool_call_project_id: 'p',
    health: { tool_call: { state: 'checking' } },
  }, selectedProjectId: 'p', challengeExpiresAt: '2026-09-26T10:02:00Z' });
  assert.equal(view.challengeExpiresAt, '2026-09-26T10:02:00Z');
  const html = homeHtml('test-nonce');
  assert.match(html, /id="verification-progress"/);
  assert.match(html, /setInterval/);
});

test('home exposes upgrade and guarded rollback controls', () => {
  const html = homeHtml('test-nonce');
  assert.match(html, /data-action="upgrade-runtime"/);
  assert.match(html, /data-action="restore-upgrade"/);
  const view = deriveHomeView({ runtimeInstalled: true, lastSnapshotId: 'a'.repeat(32) });
  assert.equal(view.lastSnapshotId, 'a'.repeat(32));
});

test('legacy opaque project ID uses a local folder label and offers explicit rename', () => {
  const view = deriveHomeView({ runtimeInstalled: true, status: {
    projects: [{ id: 'workspace-abc', name: 'workspace-abc',
      root: 'D:\\work\\工程资料', mode: 'read_only' }], auth_mode: 'local',
  } });
  assert.equal(view.project.name, '工程资料');
  assert.equal(view.project.id, 'workspace-abc');
  assert.match(homeHtml('test-nonce'), /data-action="rename-project"/);
  assert.match(homeHtml('test-nonce'), /data-action="open-chatgpt-plugins"/);
});

test('home gives beginners a five-step progress path with one current step', () => {
  const install = deriveHomeView({ runtimeInstalled: false });
  assert.deepEqual(install.steps.map((step) => step.state),
    ['current', 'pending', 'pending', 'pending', 'pending']);
  const local = deriveHomeView({ runtimeInstalled: true, managedConfigExists: true,
    status: { projects: [{ id: 'p', root: 'D:\\work\\p' }], auth_mode: 'local' } });
  assert.deepEqual(local.steps.map((step) => step.state),
    ['done', 'done', 'current', 'pending', 'pending']);
  const connected = deriveHomeView({ runtimeInstalled: true, managedConfigExists: true,
    status: { projects: [{ id: 'p', root: 'D:\\work\\p' }], auth_mode: 'github',
      public_url: 'https://example.test', current_verified_project_id: 'p',
      tool_call_project_id: 'p',
      health: { transport: { state: 'ok' },
        oauth: { state: 'ok' }, tool_call: { state: 'ok' } } } });
  assert.deepEqual(connected.steps.map((step) => step.state),
    ['done', 'done', 'done', 'done', 'current']);
  assert.match(homeHtml('test-nonce'), /id="onboarding-steps"/);
});

test('verification of one project does not mark a different project connected', () => {
  const view = deriveHomeView({ runtimeInstalled: true, status: {
    projects: [{ id: 'one', root: 'D:\\one' }, { id: 'two', root: 'D:\\two' }],
    auth_mode: 'github', public_url: 'https://example.test',
    current_verified_project_id: 'one',
    tool_call_project_id: 'one',
    health: { transport: { state: 'ok' }, oauth: { state: 'ok' },
      tool_call: { state: 'ok' } },
  }, selectedProjectId: 'two' });
  assert.equal(view.primaryAction, 'verify');
  assert.equal(view.steps[3].state, 'current');
});

test('another project does not inherit a pending or expired verification state', () => {
  for (const toolState of ['checking', 'expired']) {
    const view = deriveHomeView({ runtimeInstalled: true, status: {
      projects: [{ id: 'one', root: 'D:\\one' }, { id: 'two', root: 'D:\\two' }],
      auth_mode: 'github', public_url: 'https://example.test',
      tool_call_project_id: 'one',
      health: { tool_call: { state: toolState } },
    }, selectedProjectId: 'two' });
    assert.equal(view.layers.find((layer) => layer.key === 'tool_call').state, 'unknown');
    assert.equal(view.title, '网页连接待验证');
  }
});
test('completed reset returns to folder selection while the installed service is stopped', () => {
  const view = deriveHomeView({ runtimeInstalled: true, managedConfigExists: true,
    serviceRunning: false, reset: { phase: 'complete', resetId: 'a'.repeat(32), external: { chatgpt: true } } });
  assert.equal(view.primaryAction, 'pick-folder');
  assert.equal(view.title, '已恢复初始状态');
  assert.equal(view.reset.external.chatgpt, true);
});

test('unfinished reset offers resume without offering service restart', () => {
  const view = deriveHomeView({ runtimeInstalled: true, managedConfigExists: true,
    reset: { phase: 'failed', step: 'clearExtension', issue: { message: '继续恢复' } } });
  assert.equal(view.primaryAction, 'reset-initial');
  assert.equal(view.primaryLabel, '继续恢复初始状态');
});
