param([string]$OutputRoot = '')
$ErrorActionPreference = 'Stop'
$assistantRoot = Split-Path -Parent $PSScriptRoot
if (-not $OutputRoot) { $OutputRoot = Join-Path $assistantRoot 'artifacts\runtime' }
$OutputRoot = [IO.Path]::GetFullPath($OutputRoot)
$buildRoot = Join-Path $OutputRoot 'build'
$distRoot = Join-Path $OutputRoot 'dist'
$entry = Join-Path $assistantRoot 'packaging\runtime_entry.py'
$python = Join-Path $assistantRoot '.venv\Scripts\python.exe'

& $python -m PyInstaller --noconfirm --clean --onedir --name ai-zhagan `
  --paths (Join-Path $assistantRoot 'src') `
  --distpath $distRoot --workpath $buildRoot `
  --specpath $OutputRoot `
  --add-data "$(Join-Path $assistantRoot 'src\project_mcp\static');project_mcp/static" `
  --collect-data fastmcp --collect-data authlib `
  --recursive-copy-metadata fastmcp `
  --copy-metadata aiofile --copy-metadata caio `
  --collect-submodules project_mcp $entry
if ($LASTEXITCODE -ne 0) { throw 'PyInstaller runtime build failed.' }

$runtimeDir = Join-Path $distRoot 'ai-zhagan'
$executable = Join-Path $runtimeDir 'ai-zhagan.exe'
if (-not (Test-Path -LiteralPath $executable)) { throw 'Runtime executable was not created.' }
$zip = Join-Path $OutputRoot 'ai-zhagan-windows-x64.zip'
if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
Compress-Archive -Path (Join-Path $runtimeDir '*') -DestinationPath $zip -CompressionLevel Optimal
$hash = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
$size = (Get-Item -LiteralPath $zip).Length
$manifest = [ordered]@{
  version = '0.2.0'
  protocol_range = '>=1.0.0 <2.0.0'
  platform = 'windows'
  architecture = 'x64'
  artifacts = [ordered]@{
    'win32-x64' = [ordered]@{
      file = (Split-Path -Leaf $zip)
      size = $size
      sha256 = $hash
    }
  }
}
$manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $OutputRoot 'runtime-manifest.json') -Encoding utf8
Write-Output (ConvertTo-Json ([ordered]@{ executable=$executable; archive=$zip; size=$size; sha256=$hash }) -Compress)
