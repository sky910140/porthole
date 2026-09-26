'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { classifyConnection } = require('../lib/diagnostics');

test('diagnosis distinguishes missing runtime, stopped service and occupied ports', () => {
  assert.equal(classifyConnection({ runtimeInstalled: false }).code, 'RUNTIME_MISSING');
  assert.equal(classifyConnection({ runtimeInstalled: true, configExists: true, portsOccupied: true }).code, 'PORT_OCCUPIED');
  assert.equal(classifyConnection({ runtimeInstalled: true, configExists: true }).repair, 'start-service');
});

test('diagnosis does not claim account or tool success from public discovery alone', () => {
  const base = { runtimeInstalled: true, configExists: true, owned: true,
    authMode: 'github', publicUrl: 'https://example.test', publicReachable: true };
  assert.equal(classifyConnection(base).code, 'ACCOUNT_UNVERIFIED');
  assert.equal(classifyConnection({ ...base, health: { oauth: { state: 'ok' } } }).code, 'TOOL_UNVERIFIED');
  assert.equal(classifyConnection({ ...base, health: { oauth: { state: 'ok' }, tool_call: { state: 'ok' } } }).code, 'READY');
  assert.equal(classifyConnection({ ...base, publicReachable: false }).code, 'HTTPS_UNREACHABLE');
});
