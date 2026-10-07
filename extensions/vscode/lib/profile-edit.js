'use strict';
const { spawn } = require('node:child_process');
const { readResetFiles, safeResetIssue } = require('./initial-reset');

function resetConflict() {
  return Object.assign(new Error('连接已重置或恢复初始状态尚未完成，请重新开始设置。'), { code: 'RESET_PENDING' });
}

function profileGenerationGuard(config, expectedResetId = readResetFiles(config).receipt?.reset_id || null) {
  const guard = () => {
    const files = readResetFiles(config);
    if (files.pending || (files.receipt?.reset_id || null) !== expectedResetId) throw resetConflict();
  };
  guard();
  return guard;
}

async function withProfileLease({ executable, config, prefixArgs = [],
  expectedResetId = readResetFiles(config).receipt?.reset_id || null }, action) {
  const generationGuard = profileGenerationGuard(config, expectedResetId);
  const child = spawn(executable, [...prefixArgs, 'profile-lease', '--config', config,
    '--expected-reset-id', expectedResetId || 'none'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let exited = false;
  let output = '';
  let errorOutput = '';
  let readyTimer;
  let failReady;
  const closed = new Promise((resolve) => {
    child.once('error', () => { exited = true; resolve(); });
    child.once('exit', () => { exited = true; resolve(); });
  });
  child.stdin.on('error', () => {});
  child.stderr.on('data', (bytes) => { errorOutput = (errorOutput + bytes.toString('utf8')).slice(0, 4096); });
  const ready = new Promise((resolve, reject) => {
    failReady = () => {
      const code = errorOutput.match(/RESET_[A-Z_]+/)?.[0] || 'RESET_FAILED';
      reject(Object.assign(new Error(safeResetIssue({ code }).message), { code }));
    };
    child.once('error', failReady);
    child.once('exit', failReady);
    child.stdout.on('data', (bytes) => {
      output += bytes.toString('utf8');
      if (output.length > 4096) return failReady();
      const line = output.indexOf('\n');
      if (line < 0) return;
      try {
        if (JSON.parse(output.slice(0, line)).ready !== true) return failReady();
        resolve();
      } catch { failReady(); }
    });
    readyTimer = setTimeout(failReady, 15000);
  });
  const guard = () => {
    if (exited) throw new Error('连接配置锁已中断，请重新开始设置。');
    generationGuard();
  };
  try {
    await ready;
    clearTimeout(readyTimer);
    guard();
    const result = await action(guard);
    guard();
    return result;
  } finally {
    clearTimeout(readyTimer);
    child.removeListener('error', failReady); child.removeListener('exit', failReady);
    if (!exited) child.stdin.end();
    const releaseTimer = setTimeout(() => { if (!exited) child.kill(); }, 5000);
    try { await closed; } finally { clearTimeout(releaseTimer); }
  }
}

module.exports = { profileGenerationGuard, withProfileLease };
