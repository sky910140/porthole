'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { canonicalPath } = require('./local-path');

function normalizedRoot(root) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw new Error('请选择本机绝对目录。');
  const resolved = canonicalPath(root).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function projectIdForPath(root) {
  return `workspace-${crypto.createHash('sha256').update(normalizedRoot(root)).digest('hex').slice(0, 12)}`;
}

function projectForRoot(projects, root) {
  const target = normalizedRoot(root);
  return (projects || []).find((project) => {
    try { return normalizedRoot(project.root) === target; } catch { return false; }
  }) || null;
}

function projectChoice(root, projects) {
  const canonical = canonicalPath(root);
  const existing = projectForRoot(projects, canonical);
  return existing
    ? { id: existing.id, root: canonical, existing: true, mode: existing.mode }
    : { id: projectIdForPath(canonical), root: canonical, existing: false, mode: 'read_only' };
}

function projectPolicyChange(project, action) {
  if (action === 'toggle-proposals') return project.mode === 'propose'
    ? { mode: 'read_only', apply_local_enabled: false } : { mode: 'propose' };
  if (action === 'toggle-local-apply') {
    if (project.mode !== 'propose') throw new Error('请先允许提出修改。');
    return { apply_local_enabled: !project.apply_local_enabled };
  }
  throw new Error('未知的项目授权操作。');
}

module.exports = { normalizedRoot, projectIdForPath, projectForRoot, projectChoice, projectPolicyChange };
