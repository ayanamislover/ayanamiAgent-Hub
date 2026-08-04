[CmdletBinding()]
param(
  [ValidateRange(1, 65535)]
  [int]$Port = 4392,
  [Parameter(Mandatory = $true)]
  [string]$DataDir,
  # Defaults to the checkout this script sits in. The release gate points it at an unpacked
  # portable package instead, so the same acceptance runs against what a person downloads.
  [string]$HubRoot
)

# What a person actually does after installing: start it, look at it, stop it, start it again. None
# of it goes through pnpm, so this runs the same way whether the install was done by pnpm, Corepack
# or npx -- which is the whole point of running it twice.

$ErrorActionPreference = "Stop"
$hubRoot = if ($HubRoot) { [System.IO.Path]::GetFullPath($HubRoot) } else { Split-Path -Parent $PSScriptRoot }
$cli = Join-Path $hubRoot "packages\cli\dist\bin.js"

function Write-Step([string]$Message) {
  Write-Host "[install-smoke] $Message" -ForegroundColor Cyan
}

function Invoke-Cli([string[]]$CliArgs) {
  $output = & node $cli @CliArgs 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0) {
    throw "crossagent $($CliArgs -join ' ') failed with exit code ${LASTEXITCODE}: $output"
  }
  return $output
}

if (-not (Test-Path -LiteralPath $cli)) {
  throw "The CrossAgent CLI is not built. Run the install first."
}

$env:CROSSAGENT_DATA_DIR = [System.IO.Path]::GetFullPath($DataDir)
$env:CROSSAGENT_PORT = [string]$Port
$env:CROSSAGENT_URL = "http://127.0.0.1:$Port"
New-Item -ItemType Directory -Force -Path $env:CROSSAGENT_DATA_DIR | Out-Null
Write-Step "data directory $($env:CROSSAGENT_DATA_DIR), port $Port"

try {
  Write-Step "start"
  Invoke-Cli @("start", "--port", [string]$Port) | Out-Null

  Write-Step "status"
  $status = Invoke-Cli @("status") | ConvertFrom-Json
  if (-not $status.running) { throw "status reports the Hub is not running" }
  if (-not $status.verified) { throw "status reports an unverified build" }

  Write-Step "doctor"
  $doctor = Invoke-Cli @("doctor") | ConvertFrom-Json
  if (-not $doctor.hub.health.ok) { throw "doctor reports the Hub is unhealthy" }

  Write-Step "health endpoint"
  $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 15
  if (-not $health.ok) { throw "/api/health did not report ok" }
  if ($health.build.buildId -ne $status.pid.buildIdentity.buildId) {
    throw "the serving Hub reports a different build than the pid record"
  }
  Write-Step "serving build $($health.build.buildId.Substring(0, 12)), migrations applied"

  # A restart is where a stale lease, an unreleased port or a half-written pid record shows up, and
  # none of those appear on a first start.
  Write-Step "stop"
  Invoke-Cli @("stop") | Out-Null
  Write-Step "start again"
  Invoke-Cli @("start", "--port", [string]$Port) | Out-Null
  $restarted = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 15
  if (-not $restarted.ok) { throw "the Hub did not come back after a restart" }
  if ($restarted.instanceId -eq $health.instanceId) {
    throw "the restart reused the previous instance; it did not actually stop"
  }

  Write-Step "stop"
  Invoke-Cli @("stop") | Out-Null
  Write-Host "[install-smoke] clean install acceptance passed" -ForegroundColor Green
} catch {
  Write-Host "[install-smoke ERROR] $($_.Exception.Message)" -ForegroundColor Red
  $log = Join-Path $env:CROSSAGENT_DATA_DIR "hub.log"
  if (Test-Path -LiteralPath $log) {
    Write-Host "--- last 40 lines of hub.log ---"
    Get-Content -LiteralPath $log -Tail 40
  }
  try { & node $cli stop | Out-Null } catch { }
  exit 1
}
