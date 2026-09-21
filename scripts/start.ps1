param([string]$Config = '')
$ErrorActionPreference = 'Stop'
$assistantRoot = Split-Path -Parent $PSScriptRoot
if (-not $Config) { $Config = Join-Path $assistantRoot 'config\local.json' }
& (Join-Path $assistantRoot '.venv\Scripts\python.exe') -m project_mcp.cli start --config $Config
exit $LASTEXITCODE
