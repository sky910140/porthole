param([string]$Config = '')
$assistantRoot = Split-Path -Parent $PSScriptRoot
if (-not $Config) { $Config = Join-Path $assistantRoot 'config\local.json' }
& (Join-Path $assistantRoot '.venv\Scripts\python.exe') -m project_mcp.cli stop --config $Config
exit $LASTEXITCODE
