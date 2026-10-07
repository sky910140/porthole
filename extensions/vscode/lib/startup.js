'use strict';

const path = require('node:path');

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const VALUE = 'Porthole';

function loginCommand(executable, config) {
  for (const value of [executable, config]) {
    if (!path.win32.isAbsolute(value) || /["\r\n]/.test(value)) throw new Error('开机启动路径无效。');
  }
  return `"${executable}" start --config "${config}"`;
}

async function readLoginStartup(execute, platform) {
  if (platform !== 'win32') return null;
  try {
    const result = await execute('reg.exe', ['query', RUN_KEY, '/v', VALUE], { windowsHide: true });
    return result.stdout.includes(VALUE) && result.stdout.includes('REG_SZ') ? result.stdout : null;
  } catch { return null; }
}

async function hasLoginStartup(executable, config, execute, platform = process.platform) {
  const entry = await readLoginStartup(execute, platform);
  return Boolean(entry && entry.includes(loginCommand(executable, config)));
}

async function setLoginStartup(enabled, executable, config, execute, platform = process.platform) {
  if (platform !== 'win32') throw new Error('当前仅支持 Windows 开机启动。');
  const command = loginCommand(executable, config);
  const entry = await readLoginStartup(execute, platform);
  if (enabled) {
    if (entry && !entry.includes(command)) throw new Error('存在属于其他安装的 Porthole 开机启动项，请先检查 Windows 启动应用。');
    if (entry) return;
    await execute('reg.exe', ['add', RUN_KEY, '/v', VALUE, '/t', 'REG_SZ', '/d', command, '/f'], { windowsHide: true });
  } else if (entry && entry.includes(command)) {
    await execute('reg.exe', ['delete', RUN_KEY, '/v', VALUE, '/f'], { windowsHide: true });
  }
}

module.exports = { loginCommand, hasLoginStartup, setLoginStartup };
