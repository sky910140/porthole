'use strict';

const fs = require('node:fs');
const path = require('node:path');

function canonicalPath(value) {
  let current = path.resolve(value);
  const remaining = [];
  for (;;) {
    try { return path.join(fs.realpathSync.native(current), ...remaining); }
    catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
      const parent = path.dirname(current);
      if (parent === current) return path.join(current, ...remaining);
      remaining.unshift(path.basename(current));
      current = parent;
    }
  }
}

module.exports = { canonicalPath };
