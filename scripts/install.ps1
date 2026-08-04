$ErrorActionPreference = "Stop"

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  throw "Node.js 22.13.0 or newer is required."
}
# package.json declares ">=22.13.0", which is the floor pnpm 11.9.0 itself imposes -- it refuses to
# run on anything older. Checking only the major version would let 22.0 through 22.12 in, where the
# failure surfaces much later and looks like a repository problem rather than a Node one.
$nodeText = & $node.Source -p "process.versions.node"
if ($nodeText -notmatch "^\d+\.\d+\.\d+") {
  throw "Could not read a Node.js version. Got: $nodeText"
}
if ([version]$Matches[0] -lt [version]"22.13.0") {
  throw "Node.js 22.13.0 or newer is required. Current version: $($Matches[0])"
}

if (Get-Command pnpm -ErrorAction SilentlyContinue) {
  $pnpm = { pnpm @args }
} elseif (Get-Command corepack -ErrorAction SilentlyContinue) {
  $pnpm = { corepack pnpm @args }
} elseif (Get-Command npx -ErrorAction SilentlyContinue) {
  $pnpm = { npx --yes "pnpm@11.9.0" @args }
} else {
  throw "pnpm, Corepack, and npx are all unavailable."
}

# `packageManager` pins pnpm@11.9.0, but only Corepack honours that. A pnpm already on PATH is
# whatever the machine happens to carry, so check it rather than discover the mismatch as a
# lockfile error.
$pnpmText = & $pnpm --version | Select-Object -Last 1
if ($pnpmText -notmatch "^(\d+)\.") {
  throw "Could not read a pnpm version. Got: $pnpmText"
}
if ([int]$Matches[1] -lt 11) {
  throw "pnpm 11 or newer is required; package.json pins pnpm@11.9.0. Current version: $pnpmText"
}

& $pnpm install --frozen-lockfile
if ($LASTEXITCODE -ne 0) { throw "pnpm install failed." }
# This must be the root release build. It takes the workspace BUILD lock and hands each component
# the PID and nonce that scripts/build-component.mjs verifies. `pnpm -r build` reaches the
# components directly, so every one of them refuses with "Component builds must be invoked by the
# root release builder" and a clean clone never finishes installing.
& $pnpm build
if ($LASTEXITCODE -ne 0) { throw "pnpm root release build failed." }
# `--filter` puts pnpm in recursive mode, which `link` rejects outright ("Unknown option:
# 'recursive'"); `--dir` selects the package without it. The link itself is only a convenience, and
# it fails on any machine that has never run `pnpm setup`, because pnpm's global bin directory is
# not on PATH there. That is not a reason to fail an otherwise complete install.
& $pnpm --dir packages/cli link --global
if ($LASTEXITCODE -ne 0) {
  Write-Warning "Could not link the global 'crossagent' command (pnpm's global bin directory is usually not on PATH until you run 'pnpm setup')."
  Write-Host "CrossAgent is built. Run it from this directory: pnpm crossagent --help"
} else {
  Write-Host "CrossAgent installed. Run: crossagent --help"
}

# The link above is explicitly optional, but its exit code is the script's unless something says
# otherwise, so a complete install read as a failed one to every wrapper -- which is exactly how the
# clean-install workflow found this. Anything genuinely fatal above has already thrown.
exit 0
