[CmdletBinding()]
param(
  [ValidateRange(1, 65535)]
  [int]$Port = 4387,
  [string]$DataDir
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$cli = Join-Path $projectRoot "packages\cli\dist\bin.js"

try {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) {
    throw "Node.js was not found."
  }
  if (-not (Test-Path -LiteralPath $cli)) {
    throw "CrossAgent has not been built yet; no running managed Hub can be stopped from this copy."
  }
  if ($DataDir) {
    $env:CROSSAGENT_DATA_DIR = [System.IO.Path]::GetFullPath($DataDir)
  }
  $env:CROSSAGENT_PORT = [string]$Port
  $env:CROSSAGENT_URL = "http://127.0.0.1:$Port"
  & $node.Source $cli stop
  if ($LASTEXITCODE -ne 0) {
    throw "The stop command failed."
  }
  Write-Host "CrossAgent Hub is stopped." -ForegroundColor Green
} catch {
  Write-Host "[CrossAgent ERROR] $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
