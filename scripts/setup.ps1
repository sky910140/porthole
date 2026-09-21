param([string]$Python = 'python', [string]$ProjectPath = '', [string]$ProjectId = 'current')
$ErrorActionPreference = 'Stop'
$assistantRoot = Split-Path -Parent $PSScriptRoot
if (-not $ProjectPath) { $ProjectPath = $assistantRoot }
Push-Location $assistantRoot
try {
    if (-not (Test-Path -LiteralPath '.venv\Scripts\python.exe')) {
        & $Python -m venv .venv
        if ($LASTEXITCODE -ne 0) { throw 'Python 3.11+ is required.' }
    }
    & '.\.venv\Scripts\python.exe' -m pip install -r requirements-windows.lock
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
    & '.\.venv\Scripts\python.exe' -m pip install -e . --no-deps
    if ($LASTEXITCODE -ne 0) { throw 'Package installation failed.' }
    if (-not (Test-Path -LiteralPath 'config\local.json')) {
        & '.\.venv\Scripts\python.exe' -m project_mcp.cli init --project $ProjectPath --id $ProjectId
        if ($LASTEXITCODE -ne 0) { throw 'Project initialization failed.' }
    }
    Write-Output 'Ready. Run scripts\start.ps1, then scripts\token.ps1 to connect the management page.'
} finally { Pop-Location }
