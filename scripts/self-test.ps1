$assistantRoot = Split-Path -Parent $PSScriptRoot
Push-Location $assistantRoot
try {
    & '.\.venv\Scripts\python.exe' -m pytest --cov=project_mcp --cov-report=term-missing --cov-fail-under=80
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    & '.\.venv\Scripts\python.exe' -m ruff check src tests
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    Push-Location 'extensions\vscode'
    try { npm run check; exit $LASTEXITCODE } finally { Pop-Location }
} finally { Pop-Location }
