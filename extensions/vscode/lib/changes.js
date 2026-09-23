'use strict';

const crypto = require('node:crypto');

function createChangeClient(client) {
  return {
    list: (projectId) => client.request(
      'GET', `/api/changes${projectId ? `?project_id=${encodeURIComponent(projectId)}` : ''}`,
    ),
    get: (changeId) => client.request('GET', `/api/changes/${encodeURIComponent(changeId)}`),
    updateReadiness: (sessionId, payload) => client.request(
      'PUT', `/api/editor-readiness/${encodeURIComponent(sessionId)}`, payload,
    ),
    deleteReadiness: (sessionId) => client.request(
      'DELETE', `/api/editor-readiness/${encodeURIComponent(sessionId)}`,
    ),
    issueReadiness: (changeId, payload) => client.request(
      'POST', `/api/changes/${encodeURIComponent(changeId)}/readiness`, payload,
    ),
    apply: (changeId, payload) => client.request(
      'POST', `/api/changes/${encodeURIComponent(changeId)}/apply`, payload,
    ),
    reject: (changeId, payload) => client.request(
      'POST', `/api/changes/${encodeURIComponent(changeId)}/reject`, payload,
    ),
    revert: (changeId, payload) => client.request(
      'POST', `/api/changes/${encodeURIComponent(changeId)}/revert`, payload,
    ),
    recover: (changeId, payload) => client.request(
      'POST', `/api/changes/${encodeURIComponent(changeId)}/recovery`, payload,
    ),
    activity: () => client.request('GET', '/api/activity'),
    diagnosticsPreview: () => client.request('GET', '/api/diagnostics/preview'),
  };
}

class ChangeActionRunner {
  constructor(client, options = {}) {
    this.client = client;
    this.randomId = options.randomId || (() => crypto.randomUUID());
    this.inFlight = new Map();
  }

  _once(key, operation) {
    if (this.inFlight.has(key)) return this.inFlight.get(key);
    const promise = Promise.resolve().then(operation);
    const tracked = promise.finally(() => {
      if (this.inFlight.get(key) === tracked) this.inFlight.delete(key);
    });
    this.inFlight.set(key, tracked);
    return tracked;
  }

  apply(change, reviewSessionId) {
    return this._once(`apply:${change.change_id}`, async () => {
      const operationId = this.randomId();
      const readiness = await this.client.issueReadiness(change.change_id, {
        review_session_id: reviewSessionId,
        manifest_sha256: change.manifest_sha256,
      });
      return this.client.apply(change.change_id, {
        operation_id: operationId,
        expected_revision: change.revision,
        review_session_id: reviewSessionId,
        manifest_sha256: change.manifest_sha256,
        lease_id: readiness.lease_id,
      });
    });
  }

  reject(change) {
    return this._once(`reject:${change.change_id}`, () => this.client.reject(change.change_id, {
      operation_id: this.randomId(), expected_revision: change.revision,
    }));
  }

  revert(change, reviewSessionId) {
    return this._once(`revert:${change.change_id}`, async () => {
      const readiness = await this.client.issueReadiness(change.change_id, {
        review_session_id: reviewSessionId,
        manifest_sha256: change.manifest_sha256,
      });
      return this.client.revert(change.change_id, {
        operation_id: this.randomId(), expected_revision: change.revision,
        review_session_id: reviewSessionId,
        manifest_sha256: change.manifest_sha256,
        lease_id: readiness.lease_id,
      });
    });
  }
}

class RevisionGate {
  constructor() { this.revisions = new Map(); }

  accept(change) {
    if (!change || !change.change_id || !Number.isInteger(change.revision)) return false;
    const previous = this.revisions.get(change.change_id) || 0;
    if (change.revision < previous) return false;
    this.revisions.set(change.change_id, change.revision);
    return true;
  }
}

module.exports = { ChangeActionRunner, RevisionGate, createChangeClient };
