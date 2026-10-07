'use strict';
// The release package must contain a verified official client; source runs may download it once.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ARCHIVE_NAME, ARCHIVE_SHA256, ARCHIVE_URL, CLIENT_VERSION } = require('../extensions/vscode/lib/private-tunnel');
const root = path.resolve(__dirname, '..');
const checksum = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

async function main() {
  const cache = process.argv[2] ? path.resolve(process.argv[2])
    : path.join(root, 'artifacts', 'tunnel-cache', ARCHIVE_NAME);
  let bytes;
  if (fs.existsSync(cache)) bytes = fs.readFileSync(cache);
  else {
    const response = await fetch(ARCHIVE_URL, { signal: AbortSignal.timeout(600000) });
    if (!response.ok) throw new Error(`Official tunnel download failed: HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
    if (checksum(bytes) !== ARCHIVE_SHA256) throw new Error('Official tunnel archive SHA-256 mismatch');
    fs.mkdirSync(path.dirname(cache), { recursive: true }); fs.writeFileSync(cache, bytes);
  }
  if (checksum(bytes) !== ARCHIVE_SHA256) throw new Error('Cached tunnel archive SHA-256 mismatch');
  const bundle = path.join(root, 'extensions', 'vscode', 'tunnel-bundle');
  fs.mkdirSync(bundle, { recursive: true });
  fs.writeFileSync(path.join(bundle, ARCHIVE_NAME), bytes);
  const notices = ['LICENSE', 'NOTICE', 'oss-license-report-client.txt'];
  for (const name of notices) fs.copyFileSync(path.join(root, 'third-party', 'tunnel-client', name), path.join(bundle, name));
  fs.writeFileSync(path.join(bundle, 'bundle.json'), JSON.stringify({
    version: CLIENT_VERSION, platform: 'win32', architecture: 'x64', archive: ARCHIVE_NAME,
    sha256: ARCHIVE_SHA256, size: bytes.length, source: ARCHIVE_URL, license: 'Apache-2.0', notices,
  }, null, 2));
  process.stdout.write(`Bundled official tunnel ${CLIENT_VERSION}: ${bytes.length} bytes; SHA-256 verified\n`);
}
main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
