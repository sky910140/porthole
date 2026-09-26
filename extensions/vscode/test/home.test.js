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
  assert.equal(local.primaryAction, 'setup-web');
  assert.equal(local.project.id, 'demo');
  assert.match(local.message, /网页/);
  const verified = deriveHomeView({ runtimeInstalled: true, status: {
    projects: [project], auth_mode: 'github', public_url: 'https://example.test',
    health: { local_service: { state: 'ok' }, transport: { state: 'ok' },
      oauth: { state: 'ok' }, tool_call: { state: 'ok' } },
  }, selectedProjectId: 'demo' });
  assert.equal(verified.primaryAction, 'copy-question');
  assert.match(verified.message, /已验证/);
});

test('expired tool call is not shown as a current web connection', () => {
  const view = deriveHomeView({ runtimeInstalled: true, status: {
    projects: [{ id: 'p', name: 'P', root: 'D:\\p', mode: 'read_only' }],
    auth_mode: 'github', public_url: 'https://example.test',
    health: { local_service: { state: 'ok' }, transport: { state: 'ok' },
      oauth: { state: 'ok' }, tool_call: { state: 'expired' } },
  }, selectedProjectId: 'p' });
  assert.equal(view.primaryAction, 'verify');
  assert.match(view.message, /过期/);
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

test('home exposes upgrade and guarded rollback controls', () => {
  const html = homeHtml('test-nonce');
  assert.match(html, /data-action="upgrade-runtime"/);
  assert.match(html, /data-action="restore-upgrade"/);
  const view = deriveHomeView({ runtimeInstalled: true, lastSnapshotId: 'a'.repeat(32) });
  assert.equal(view.lastSnapshotId, 'a'.repeat(32));
});
