param([switch]$SkipRuntimeBuild, [string]$TunnelArchive)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$extensionRoot = Join-Path $repoRoot 'extensions\vscode'
$runtimeRoot = Join-Path $repoRoot 'artifacts\runtime\dist\porthole'
$bundleRoot = Join-Path $extensionRoot 'runtime-bundle'
$payloadRoot = Join-Path $bundleRoot 'payload'
function Get-FileSha256([string]$FilePath) {
  $algorithm = [Security.Cryptography.SHA256]::Create()
  $stream = [IO.File]::OpenRead($FilePath)
  try { return -join ($algorithm.ComputeHash($stream) | ForEach-Object { $_.ToString('x2') }) }
  finally { $stream.Dispose(); $algorithm.Dispose() }
}

if (-not $SkipRuntimeBuild) {
  & (Join-Path $PSScriptRoot 'build-runtime.ps1')
  if ($LASTEXITCODE -ne 0) { throw 'Runtime build failed.' }
}
if (-not (Test-Path -LiteralPath (Join-Path $runtimeRoot 'porthole.exe'))) {
  throw 'Build the Windows runtime before packaging the extension.'
}

$tunnelScript = Join-Path $PSScriptRoot 'bundle-tunnel.cjs'
if ($TunnelArchive) { & node $tunnelScript $TunnelArchive }
else { & node $tunnelScript }
if ($LASTEXITCODE -ne 0) { throw 'Verified official tunnel bundle is required for packaging.' }

$extensionFull = [IO.Path]::GetFullPath($extensionRoot).TrimEnd('\')
$bundleFull = [IO.Path]::GetFullPath($bundleRoot).TrimEnd('\')
if (-not $bundleFull.StartsWith($extensionFull + '\', [StringComparison]::OrdinalIgnoreCase)) {
  throw 'The runtime bundle must be inside the extension directory.'
}
if (Test-Path -LiteralPath $bundleFull) {
  Remove-Item -LiteralPath $bundleFull -Recurse -Force
}
New-Item -ItemType Directory -Path $payloadRoot -Force | Out-Null
Copy-Item -Path (Join-Path $runtimeRoot '*') -Destination $payloadRoot -Recurse -Force

$package = Get-Content -LiteralPath (Join-Path $extensionRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$entries = @(Get-ChildItem -LiteralPath $payloadRoot -Recurse -File | Sort-Object FullName | ForEach-Object {
  $relative = $_.FullName.Substring($payloadRoot.Length + 1).Replace('\', '/')
  [ordered]@{
    path = $relative
    size = $_.Length
    sha256 = Get-FileSha256 $_.FullName
  }
})
$manifest = [ordered]@{
  version = $package.version
  platform = 'win32'
  architecture = 'x64'
  protocol_range = '>=1.0.0 <2.0.0'
  files = $entries
}
$json = ConvertTo-Json $manifest -Depth 5
[IO.File]::WriteAllText((Join-Path $bundleRoot 'bundle.json'), $json, [Text.UTF8Encoding]::new($false))

Push-Location $extensionRoot
try {
  & npm run package:vsix
  if ($LASTEXITCODE -ne 0) { throw 'VSIX packaging failed.' }
} finally { Pop-Location }

$vsix = Join-Path $extensionRoot ("porthole-{0}.vsix" -f $package.version)
if (-not (Test-Path -LiteralPath $vsix)) { throw 'VSIX was not created.' }
Write-Output (ConvertTo-Json ([ordered]@{
  vsix = $vsix
  version = $package.version
  runtime_files = $entries.Count
  vsix_size = (Get-Item -LiteralPath $vsix).Length
}) -Compress)
