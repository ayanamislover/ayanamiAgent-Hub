[CmdletBinding()]
param(
  [ValidateRange(1, 65535)]
  [int]$Port = 4387,
  [switch]$NoOpen,
  [switch]$Rebuild,
  [switch]$SkipInstall,
  [string]$DataDir
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot

function Write-Step([string]$Message) {
  Write-Host "[CrossAgent] $Message" -ForegroundColor Cyan
}

function Invoke-Pnpm([string[]]$PnpmArgs) {
  switch ($script:PnpmMode) {
    "native" { & $script:PnpmPath @PnpmArgs }
    "corepack" { & $script:PnpmPath pnpm @PnpmArgs }
    "npx" { & $script:PnpmPath --yes "pnpm@11.9.0" @PnpmArgs }
    default { throw "No pnpm runner was selected." }
  }
  if ($LASTEXITCODE -ne 0) {
    throw "pnpm command failed: pnpm $($PnpmArgs -join ' ')"
  }
}

try {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) {
    throw "Node.js 22.13 or newer is required. Install Node.js, then double-click this file again."
  }
  # package.json declares ">=22.13.0", which is the floor pnpm 11.9.0 itself imposes -- it refuses
  # to run on anything older. A major-only check would let 22.0 through 22.12 in, where the failure
  # surfaces much later and looks like a repository problem rather than a Node one.
  $nodeText = & $node.Source -p "process.versions.node"
  if ($LASTEXITCODE -ne 0 -or $nodeText -notmatch "^\d+\.\d+\.\d+") {
    throw "Could not read a Node.js version. Got: $nodeText"
  }
  if ([version]$Matches[0] -lt [version]"22.13.0") {
    throw "Node.js 22.13.0 or newer is required. Current version: $($Matches[0])"
  }

  if ($DataDir) {
    $env:CROSSAGENT_DATA_DIR = [System.IO.Path]::GetFullPath($DataDir)
  }
  $env:CROSSAGENT_PORT = [string]$Port
  $env:CROSSAGENT_URL = "http://127.0.0.1:$Port"

  $nativePnpm = Get-Command pnpm -ErrorAction SilentlyContinue
  $corepack = Get-Command corepack -ErrorAction SilentlyContinue
  $npx = Get-Command npx -ErrorAction SilentlyContinue
  if ($nativePnpm) {
    $script:PnpmMode = "native"
    $script:PnpmPath = $nativePnpm.Source
  } elseif ($corepack) {
    $script:PnpmMode = "corepack"
    $script:PnpmPath = $corepack.Source
  } elseif ($npx) {
    $script:PnpmMode = "npx"
    $script:PnpmPath = $npx.Source
  } else {
    throw "Node.js is present, but pnpm, Corepack, and npx are all unavailable."
  }

  $pnpmVersion = switch ($script:PnpmMode) {
    "native" { & $script:PnpmPath --version }
    "corepack" { & $script:PnpmPath pnpm --version }
    "npx" { & $script:PnpmPath --yes "pnpm@11.9.0" --version }
  }
  if ($LASTEXITCODE -ne 0) {
    throw "Unable to start pnpm through $($script:PnpmMode)."
  }
  # `packageManager` pins pnpm@11.9.0, but only Corepack honours that. A pnpm already on PATH is
  # whatever the machine happens to carry, so check it rather than discover the mismatch as a
  # lockfile error several minutes into a first run.
  $pnpmText = $pnpmVersion | Select-Object -Last 1
  if ($pnpmText -notmatch "^(\d+)\.") {
    throw "Could not read a pnpm version. Got: $pnpmText"
  }
  if ([int]$Matches[1] -lt 11) {
    throw "pnpm 11 or newer is required; package.json pins pnpm@11.9.0. Current version: $pnpmText"
  }
  Write-Step "Node $(& $node.Source --version), pnpm $pnpmText (via $($script:PnpmMode))."

  if (-not $SkipInstall) {
    Write-Step "Checking/installing workspace dependencies..."
    Invoke-Pnpm -PnpmArgs @("install", "--frozen-lockfile", "--prefer-offline")
  }

  $buildMarkers = @(
    (Join-Path $projectRoot "packages\cli\dist\bin.js"),
    (Join-Path $projectRoot "packages\claude-channel\dist\bin.js"),
    (Join-Path $projectRoot "apps\hub\dist\main.js"),
    (Join-Path $projectRoot "apps\dashboard\dist\index.html")
  )
  $missingBuild = @($buildMarkers | Where-Object { -not (Test-Path -LiteralPath $_) })
  if ($Rebuild -or $missingBuild.Count -gt 0) {
    Write-Step "Building Hub and adapters (first run may take a few minutes)..."
    # Must be the root release build: it takes the workspace BUILD lock and hands each component
    # the PID and nonce that scripts/build-component.mjs verifies. `pnpm -r build` reaches the
    # components directly and every one refuses with "Component builds must be invoked by the root
    # release builder", so a clean clone never gets past its first launch.
    Invoke-Pnpm -PnpmArgs @("build")
  } else {
    Write-Step "Existing production build found; skipping rebuild."
  }

  $cli = Join-Path $projectRoot "packages\cli\dist\bin.js"
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
