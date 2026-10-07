'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

async function run() {
  const workspace = process.env.PORTHOLE_FEASIBILITY_WORKSPACE;
  assert.ok(workspace);
  const target = path.join(workspace, 'target.txt');
  const document = await vscode.workspace.openTextDocument(target);
  const editor = await vscode.window.showTextDocument(document);
  await editor.edit((builder) => builder.insert(new vscode.Position(0, 0), 'unsaved '));
  assert.equal(document.isDirty, true);

  fs.writeFileSync(target, 'external\r\n');

  assert.match(document.getText(), /^unsaved before/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'external\r\n');
  assert.equal(document.isDirty, true);
  console.log(JSON.stringify({
    dirtyBufferPreserved: true,
    diskChangedIndependently: true,
    conclusion: 'local apply must block while any relevant editor buffer is dirty',
  }));
}

module.exports = { run };
