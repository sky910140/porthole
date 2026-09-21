param([string]$Config = '')
$ErrorActionPreference = 'Stop'
$assistantRoot = Split-Path -Parent $PSScriptRoot
if (-not $Config) { $Config = Join-Path $assistantRoot 'config\local.json' }
$assistantPython = Join-Path $assistantRoot '.venv\Scripts\python.exe'
$previousClientId = $env:PROJECT_MCP_GITHUB_CLIENT_ID
$previousClientSecret = $env:PROJECT_MCP_GITHUB_CLIENT_SECRET
try {
    $clientId = (Read-Host 'Paste GitHub Client ID').Trim()
    $secureSecret = Read-Host 'Paste GitHub Client Secret (hidden)' -AsSecureString
    if (-not $clientId -or $secureSecret.Length -eq 0) {
        throw 'Client ID and Client Secret are required. Nothing was started.'
    }
    $env:PROJECT_MCP_GITHUB_CLIENT_ID = $clientId
    $env:PROJECT_MCP_GITHUB_CLIENT_SECRET = (New-Object System.Net.NetworkCredential('', $secureSecret)).Password
    & $assistantPython -m project_mcp.cli doctor --config $Config
    if ($LASTEXITCODE -ne 0) { throw 'Configuration check failed.' }
    & $assistantPython -m project_mcp.cli stop --config $Config
    if ($LASTEXITCODE -ne 0) { throw 'Could not stop the previous service.' }
    & $assistantPython -m project_mcp.cli start --config $Config
    if ($LASTEXITCODE -ne 0) { throw 'Service startup failed.' }
    & $assistantPython -m project_mcp.cli status --config $Config
    if ($LASTEXITCODE -ne 0) { throw 'Service status check failed.' }
    Write-Host 'Service started. This does not verify GitHub credentials or cloud account access.'
} finally {
    $env:PROJECT_MCP_GITHUB_CLIENT_ID = $previousClientId
    $env:PROJECT_MCP_GITHUB_CLIENT_SECRET = $previousClientSecret
    if ($secureSecret) { $secureSecret.Dispose() }
}
