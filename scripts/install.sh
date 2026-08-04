#!/usr/bin/env sh
set -eu

command -v node >/dev/null 2>&1 || {
  echo "Node.js 22.13 or newer is required." >&2
  exit 1
}
command -v pnpm >/dev/null 2>&1 || {
  echo "pnpm is required. Install it with Corepack or from https://pnpm.io/." >&2
  exit 1
}

pnpm install --frozen-lockfile
pnpm build

# `--filter` puts pnpm in recursive mode, which `link` rejects outright ("Unknown option:
# 'recursive'"); `--dir` selects the package without it. The link itself is only a convenience, and
# it fails on any machine that has never run `pnpm setup`, because pnpm's global bin directory is
# not on PATH there. That is not a reason to fail an otherwise complete install.
if pnpm --dir packages/cli link --global; then
  echo "CrossAgent installed. Run: crossagent --help"
else
  echo "Could not link the global 'crossagent' command (pnpm's global bin directory is usually not" >&2
  echo "on PATH until you run 'pnpm setup')." >&2
  echo "CrossAgent is built. Run it from this directory: pnpm crossagent --help"
fi
