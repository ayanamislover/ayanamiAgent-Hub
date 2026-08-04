[CmdletBinding()]
param(
  [ValidateRange(1, 65535)]
  [int]$Port = 4387,
  [switch]$NoOpen,
  [string]$DataDir
)

# Launcher for the portable win-x64 package. Unlike scripts/start-windows.ps1 there is no pnpm, no
# install and no build here: everything this needs is already unpacked next to it.

$ErrorActionPreference = "Stop"
$hubRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $hubRoot

function Write-Step([string]$Message) {
  Write-Host "[CrossAgent] $Message" -ForegroundColor Cyan
}

try {
  $releaseFile = Join-Path $hubRoot "release.json"
  if (-not (Test-Path -LiteralPath $releaseFile)) {
    throw "release.json is missing. Unpack the whole zip and run this file from inside it."
  }
  $release = Get-Content -LiteralPath $releaseFile -Raw | ConvertFrom-Json

  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) {
    throw "Node.js $($release.node.major) is required. Install it, then double-click this file again."
  }
  # better-sqlite3 and node-pty are compiled addons. They load into one Node ABI and nothing else,
  # so check the ABI rather than let `require` fail several screens into startup with a message
  # about a module built against a different version.
  $abi = & $node.Source -p "process.versions.modules"
  if ($LASTEXITCODE -ne 0) {
    throw "Could not read a Node.js ABI version. Got: $abi"
  }
  if ("$abi".Trim() -ne "$($release.node.abi)") {
    $current = & $node.Source -p "process.versions.node"
    throw "This package carries native modules built for Node.js $($release.node.major) (ABI $($release.node.abi)); the Node.js on PATH is $current (ABI $abi). Install Node.js $($release.node.major).x, or build from source instead."
  }
  Write-Step "Node $(& $node.Source --version), CrossAgent Hub $($release.version) ($($release.platform))."

  $cli = Join-Path $hubRoot "packages\cli\dist\bin.js"
  if (-not (Test-Path -LiteralPath $cli)) {
    throw "The CrossAgent CLI is missing from this package. Unpack the zip again."
  }

  if ($DataDir) {
    $env:CROSSAGENT_DATA_DIR = [System.IO.Path]::GetFullPath($DataDir)
  }
  $env:CROSSAGENT_PORT = [string]$Port
  $env:CROSSAGENT_URL = "http://127.0.0.1:$Port"

  $startArgs = @($cli, "start", "--port", [string]$Port)
  if (-not $NoOpen) {
    $startArgs += "--open"
  }
  Write-Step "Starting local Hub on http://127.0.0.1:$Port ..."
  & $node.Source @startArgs
  if ($LASTEXITCODE -ne 0) {
    throw "CrossAgent Hub failed to start."
  }

  Write-Host ""
  Write-Host "Hub is ready: http://127.0.0.1:$Port" -ForegroundColor Green
  Write-Host "Claude: double-click Connect-Claude.cmd"
  Write-Host "Codex:  double-click Connect-Codex.cmd"
  Write-Host "Stop:   double-click Stop-CrossAgent-Hub.cmd"
} catch {
  Write-Host ""
  Write-Host "[CrossAgent ERROR] $($_.Exception.Message)" -ForegroundColor Red
  Write-Host "If the Hub log exists, inspect: $([Environment]::GetFolderPath('UserProfile'))\.crossagent\hub.log"
  exit 1
}
