param([ValidateSet('admin','mcp')][string]$Kind = 'admin')
$assistantRoot = Split-Path -Parent $PSScriptRoot
& (Join-Path $assistantRoot '.venv\Scripts\python.exe') -m project_mcp.cli token --config (Join-Path $assistantRoot 'config\local.json') --kind $Kind
exit $LASTEXITCODE
