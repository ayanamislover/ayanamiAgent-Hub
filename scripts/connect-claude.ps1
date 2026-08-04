[CmdletBinding()]
param(
  [string]$ProjectId,
  [ValidateRange(1, 65535)]
  [int]$Port = 4387,
  [string]$DataDir,
  [switch]$ConfigureOnly
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
  if (-not $node -or -not (Test-Path -LiteralPath $cli)) {
    throw "CrossAgent CLI build is unavailable. Run Start-CrossAgent-Hub.cmd first."
  }
  $project = Select-RegisteredProject $ProjectId $node.Source
  & $node.Source $cli "claude-channel" "install" "--project-id" $project.id
  if ($LASTEXITCODE -ne 0) {
    throw "Claude Channel configuration failed."
  }

  $promptPath = Join-Path $PSScriptRoot "claude-collaboration-prompt.txt"
  $prompt = [System.IO.File]::ReadAllText($promptPath, [System.Text.Encoding]::UTF8)
  try {
    Set-Clipboard -Value $prompt
    Write-Host "The Claude collaboration prompt was copied to the clipboard." -ForegroundColor Green
  } catch {
    Write-Host "Clipboard write failed; copy the prompt shown below." -ForegroundColor Yellow
  }

  Write-Host ""
  Write-Host "Claude Channel configured for: $($project.name)" -ForegroundColor Green
  Write-Host "Project UUID: $($project.id)"
  Write-Host "Paste this prompt after Claude starts:"
  Write-Host "----------------------------------------"
  Write-Host $prompt
  Write-Host "----------------------------------------"

  $claude = Get-Command claude -ErrorAction SilentlyContinue
  if (-not $claude) {
    Write-Host ""
    Write-Host "This machine does not currently have a 'claude' command in PATH." -ForegroundColor Yellow
    Write-Host "Install/enable Claude Code, then rerun Connect-Claude.cmd."
    Write-Host "The project configuration has already been written; you do not need to rebuild the Hub."
    exit 0
  }
  if ($ConfigureOnly) {
    Write-Host "Configuration complete. Launch command:"
    Write-Host "claude --dangerously-load-development-channels server:crossagent-channel"
    exit 0
  }

  Write-Host ""
  Write-Host "Launching Claude Code with the CrossAgent Channel..." -ForegroundColor Cyan
  Push-Location -LiteralPath $project.paths[0]
  try {
    & $claude.Source "--dangerously-load-development-channels" "server:crossagent-channel"
  } finally {
    Pop-Location
  }
  exit $LASTEXITCODE
} catch {
  Write-Host "[CrossAgent ERROR] $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
