[CmdletBinding()]
param(
  [string]$ProjectId,
  [ValidateRange(1, 65535)]
  [int]$Port = 4387,
  [string]$DataDir,
  [switch]$Foreground,
  [switch]$Stop,
  [switch]$Status
)

$ErrorActionPreference = "Stop"
$hubRoot = Split-Path -Parent $PSScriptRoot
$cli = Join-Path $hubRoot "packages\cli\dist\bin.js"

function Test-Hub {
  try {
    $null = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 2
    return $true
  } catch {
    return $false
  }
}

function Select-RegisteredProject([string]$RequestedId, [string]$NodePath) {
  $raw = (& $NodePath $cli "project" "list" | Out-String)
  if ($LASTEXITCODE -ne 0) {
    throw "Unable to read the Dashboard project registry."
  }
  $projects = @($raw | ConvertFrom-Json)
  if ($projects.Count -eq 0) {
    throw "No projects are registered. Add a directory in the Dashboard first."
  }
  Write-Host ""
  Write-Host "Registered Dashboard projects:" -ForegroundColor Cyan
  for ($index = 0; $index -lt $projects.Count; $index += 1) {
    $project = $projects[$index]
    $root = if ($project.paths.Count -gt 0) { $project.paths[0] } else { "no local path" }
    Write-Host ("  [{0}] {1}" -f ($index + 1), $project.name)
    Write-Host ("      UUID: {0}" -f $project.id)
    Write-Host ("      Path: {0}" -f $root)
  }
  if (-not $RequestedId) {
    if ($projects.Count -eq 1) {
      $RequestedId = $projects[0].id
    } else {
      $RequestedId = Read-Host "Select a project number or paste its UUID"
    }
  }
  $number = 0
  if ([int]::TryParse($RequestedId, [ref]$number) -and $number -ge 1 -and $number -le $projects.Count) {
    $RequestedId = $projects[$number - 1].id
  }
  $selected = @($projects | Where-Object { $_.id -eq $RequestedId })
  if ($selected.Count -ne 1) {
    throw "Project UUID is not registered in this Dashboard: $RequestedId"
  }
  return $selected[0]
}

try {
  if ($DataDir) {
    $env:CROSSAGENT_DATA_DIR = [System.IO.Path]::GetFullPath($DataDir)
  }
  $env:CROSSAGENT_PORT = [string]$Port
  $env:CROSSAGENT_URL = "http://127.0.0.1:$Port"

  if (-not (Test-Hub)) {
    Write-Host "Hub is not running; starting it now..." -ForegroundColor Cyan
    $startScript = Join-Path $PSScriptRoot "start-windows.ps1"
    $startParameters = @{ Port = $Port; NoOpen = $true }
    if ($DataDir) { $startParameters.DataDir = $DataDir }
    & $startScript @startParameters
    if ($LASTEXITCODE -ne 0 -or -not (Test-Hub)) {
      throw "Hub did not become healthy."
    }
  }

  $node = Get-Command node -ErrorAction SilentlyContinue
  $codex = Get-Command codex -ErrorAction SilentlyContinue
  if (-not $node -or -not $codex -or -not (Test-Path -LiteralPath $cli)) {
    throw "Node, Codex CLI, or the CrossAgent CLI build is unavailable."
  }
  $project = Select-RegisteredProject $ProjectId $node.Source

  Write-Host ""
  Write-Host "Managing the Codex Bridge for: $($project.name)" -ForegroundColor Cyan
  Write-Host "Project UUID: $($project.id)"
  Write-Host "This Bridge receives Claude messages and exposes the authenticated CrossAgent MCP tools."
  $bridgeArgs = @($cli, "codex", "--project-id", $project.id, "--agent", "codex")
  if ($Stop) {
    $bridgeArgs += "--stop"
  } elseif ($Status) {
    $bridgeArgs += "--status"
  } elseif ($Foreground) {
    $bridgeArgs += "--foreground"
  } else {
    $bridgeArgs += "--detach"
  }
  & $node.Source @bridgeArgs
  exit $LASTEXITCODE
} catch {
  Write-Host "[CrossAgent ERROR] $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
