import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { platform, release } from "node:os";
import { dirname, resolve } from "node:path";
import { strToU8, zipSync } from "fflate";
import { readCompatibilityReport } from "./compatibility.js";
import { defaultBaseUrl, pidPath, tokenPath } from "./paths.js";
import { health, readPidRecord } from "./process-manager.js";

function version(command: string, args = ["--version"]): string | null {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 5000,
  });
  return result.status === 0
    ? ((result.stdout || result.stderr).trim().split(/\r?\n/)[0] ?? null)
    : null;
}

export async function collectDiagnostics(): Promise<Record<string, unknown>> {
  return {
    generatedAt: new Date().toISOString(),
    productVersion: "0.1.0-alpha.1",
    os: { platform: platform(), release: release() },
    runtime: {
      node: process.version,
      pnpm: version("pnpm"),
      git: version("git"),
      codex: version("codex"),
      claude: version("claude"),
    },
    hub: {
      health: await health(defaultBaseUrl),
      pid: readPidRecord(),
    },
    paths: {
      tokenPresent: existsSync(tokenPath),
      pidPresent: existsSync(pidPath),
    },
    // Whatever `crossagent compatibility probe` last measured, or null. A stale entry is still
    // useful in a bug report because it carries the date it was taken.
    compatibility: {
      codex: readCompatibilityReport("codex"),
      claude: readCompatibilityReport("claude"),
    },
    environment: {
      CROSSAGENT_URL: process.env.CROSSAGENT_URL ?? null,
      CROSSAGENT_PORT: process.env.CROSSAGENT_PORT ?? null,
      CROSSAGENT_DATA_DIR: process.env.CROSSAGENT_DATA_DIR ?? null,
    },
  };
}

export async function exportDiagnostics(path: string): Promise<string> {
  const diagnostics = await collectDiagnostics();
  const readme = `CrossAgent diagnostic bundle
Generated: ${String(diagnostics.generatedAt)}
This bundle excludes bearer tokens, message bodies, and code diffs.
`;
  const archive = zipSync(
    {
      "diagnostics.json": strToU8(`${JSON.stringify(diagnostics, null, 2)}\n`),
      "README.txt": strToU8(readme),
    },
    { level: 6 },
  );
  const output = resolve(path);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, archive);
  return output;
}
