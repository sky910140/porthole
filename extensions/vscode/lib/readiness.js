'use strict';

const { relativeWorkspacePath } = require('./core');

function documentFields(document) {
  if (document && document.uri) {
    return {
      scheme: document.uri.scheme,
      fsPath: document.uri.fsPath,
      version: document.version,
      isDirty: document.isDirty,
    };
  }
  return document;
}

function buildReadinessPayload(input) {
  const documents = [];
  for (const candidate of input.documents || []) {
    const value = documentFields(candidate);
    if (!value || value.scheme !== 'file') continue;
    try {
      documents.push({
        path: relativeWorkspacePath(input.rootPath, value.fsPath),
        version: value.version,
        dirty: Boolean(value.isDirty),
      });
    } catch { /* Other workspaces and virtual documents are not part of this session. */ }
  }
  return {
    project_id: input.projectId,
    documents,
    active_review: input.review || null,
  };
}

module.exports = { buildReadinessPayload };
