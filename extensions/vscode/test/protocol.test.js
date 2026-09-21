'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { validateServiceInfo } = require('../lib/protocol');
const fixtures = JSON.parse(fs.readFileSync(
  path.resolve(__dirname, '../../../contracts/fixtures/service-info.json'),
  'utf8',
));

test('accepts the current protocol and unknown minor-version fields', () => {
  assert.equal(validateServiceInfo(fixtures.compatible).protocol_version, '1.0.0');
  assert.equal(validateServiceInfo(fixtures.compatible_with_unknown).future_field.accepted, true);
});

test('rejects missing required fields and incompatible majors', () => {
  assert.throws(() => validateServiceInfo(fixtures.missing_required), /缺少协议字段/);
  assert.throws(() => validateServiceInfo(fixtures.incompatible_major), /VERSION_INCOMPATIBLE/);
});
