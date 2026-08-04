import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const dataDir = mkdtempSync(resolve(tmpdir(), "crossagent-cli-smoke-"));
const expectedPrefix = resolve(tmpdir(), "crossagent-cli-smoke-");
if (!dataDir.startsWith(expectedPrefix)) {
  throw new Error(`Refusing to use unexpected smoke directory: ${dataDir}`);
}
const entry = resolve(root, "packages", "cli", "dist", "bin.js");
const port = 4391;
const environment = {
  ...process.env,
  CROSSAGENT_DATA_DIR: dataDir,
  CROSSAGENT_PORT: String(port),
};

function cli(args: string[]): Record<string, unknown> {
  const result = spawnSync(process.execPath, [entry, ...args], {
    cwd: root,
    env: environment,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`crossagent ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

try {
  const started = cli(["start", "--port", String(port)]);
  const statusBefore = cli(["status"]);
  const response = await fetch(`http://127.0.0.1:${port}/api/health`);
  const health = (await response.json()) as Record<string, unknown>;
  const stopped = cli(["stop"]);
  const statusAfter = cli(["status"]);
  if (
    started.url !== `http://127.0.0.1:${port}` ||
    statusBefore.running !== true ||
    health.ok !== true ||
    stopped.stopped !== true ||
    statusAfter.running !== false
  ) {
    throw new Error("CLI lifecycle smoke returned an inconsistent process state");
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        started,
        statusBefore: {
          running: statusBefore.running,
          port: (statusBefore.pid as Record<string, unknown> | null)?.port,
          healthy: Boolean(statusBefore.health),
        },
        health: {
          ok: health.ok,
          journalMode: (health.database as Record<string, unknown>)?.journalMode,
          websocket: health.websocket,
          mcp: health.mcp,
        },
        stopped,
        statusAfter: { running: statusAfter.running },
      },
      null,
      2,
    )}\n`,
  );
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
