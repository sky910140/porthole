'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { loginCommand, setLoginStartup, hasLoginStartup } = require('../lib/startup');

test('login command contains only executable and config path', () => {
  const command = loginCommand('C:\\Program Files\\AI Zhagan\\ai-zhagan.exe', 'C:\\Users\\Me\\AI Zhagan\\config.json');
  assert.equal(command, '"C:\\Program Files\\AI Zhagan\\ai-zhagan.exe" start --config "C:\\Users\\Me\\AI Zhagan\\config.json"');
  assert.doesNotMatch(command, /secret|token/i);
});

test('login startup touches only named HKCU Run entry', async () => {
  const calls = [];
  let registered = false;
  const execute = async (program, args) => {
    calls.push([program, args]);
    if (args[0] === 'add') registered = true;
    if (args[0] === 'delete') registered = false;
    if (args[0] === 'query' && !registered) throw new Error('not found');
    return { stdout: args[0] === 'query' ? 'AI Zhagan    REG_SZ    ' + loginCommand('C:\\app.exe', 'C:\\config.json') : '' };
  };
  await setLoginStartup(true, 'C:\\app.exe', 'C:\\config.json', execute, 'win32');
  assert.equal(await hasLoginStartup('C:\\app.exe', 'C:\\config.json', execute, 'win32'), true);
  await setLoginStartup(false, 'C:\\app.exe', 'C:\\config.json', execute, 'win32');
  assert.equal(calls.length, 5);
  assert.ok(calls.every(([program, args]) => program === 'reg.exe' && args.includes('HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run')));
  assert.deepEqual(calls[4][1].slice(0, 2), ['delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run']);
});

test('login startup refuses to overwrite a different existing entry', async () => {
  const execute = async () => ({ stdout: 'AI Zhagan    REG_SZ    "C:\\other.exe" start' });
  await assert.rejects(setLoginStartup(true, 'C:\\app.exe', 'C:\\config.json', execute, 'win32'), /其他安装/);
});
