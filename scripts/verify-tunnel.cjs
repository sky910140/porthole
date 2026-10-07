'use strict';
// Runs the actual official client against a loopback control-plane fixture and a real local MCP.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');
const extensionRoot = path.resolve(process.argv[3]);
const lib = require(path.join(extensionRoot, 'lib', 'private-tunnel'));
const checks = require(path.join(extensionRoot, 'lib', 'tunnel-checks'));
const executable = path.resolve(process.argv[2]);
const token = JSON.parse(fs.readFileSync(process.argv[4], 'utf8')).mcp_token;
const mcpPort = Number(process.argv[5]);
const projectId = process.argv[6];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const local = await checks.probeLocalMcp({ mcpPort, mcpToken: token, projectId });
  assert.equal(local.ok, true);
  let status = 200;
  let disconnected = false;
  const server = http.createServer((req, res) => {
    req.resume();
    if (disconnected) { req.socket.destroy(); return; }
    setTimeout(() => { if (!res.destroyed) { res.writeHead(status, { 'content-type': 'application/json' });
      res.end(status === 200 ? JSON.stringify({ commands: [] })
        : JSON.stringify({ error: { message: 'fixture rejection', type: 'invalid_request_error' } })); } }, 80);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const args = { executable, tunnelId: `tunnel_${'a'.repeat(32)}`, apiKey: 'sk-local-fixture-only',
    mcpToken: token, mcpPort,
    spawnProcess: (file, argv, options) => spawn(file, argv, { ...options,
      env: { ...options.env, CONTROL_PLANE_BASE_URL: origin } }) };
  let handle;
  async function waitFor(predicate) {
    const deadline = Date.now() + 12000;
    let state;
    while (Date.now() < deadline) {
      state = await checks.readTunnelHealth(handle.healthUrl);
      if (predicate(state)) return state;
      await sleep(200);
    }
    throw new Error(`Tunnel fixture check timed out: ${state?.issue?.code || 'unknown'}`);
  }
  try {
    handle = await lib.startTunnelClient(args);
    await waitFor((state) => state.ready);
    const pid = handle.child.pid;
    disconnected = true;
    await waitFor((state) => state.issue?.code === 'TUNNEL_NETWORK');
    assert.equal(handle.running, true); assert.equal(handle.child.pid, pid);
    disconnected = false;
    await waitFor((state) => state.ready);
    for (const [code, expected] of [[401, 'TUNNEL_CREDENTIALS'], [403, 'TUNNEL_PERMISSION'], [404, 'TUNNEL_NOT_FOUND']]) {
      status = code;
      await waitFor((state) => state.issue?.code === expected);
      status = 200;
      await waitFor((state) => state.ready);
    }
    process.stdout.write('Official tunnel client: local protocol, control-plane health, 401/403/404, network reconnect passed\n');
  } finally {
    await lib.stopTunnelClient(handle);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
