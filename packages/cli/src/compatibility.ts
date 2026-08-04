import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CodexAppServer,
  probeCodexCompatibility,
  sanitizeModelEnvironment,
  type CodexCompatibilityReport,
} from "@crossagent/codex-bridge";
import { dataDir } from "./paths.js";

/**
 * Both Adapters ride on somebody else's CLI, and either can lose a surface in a release without
 * this repository changing. The documented answer to that has been to measure rather than to infer
 * from a version string, but the measuring was done by hand, once, and written into a document.
 * This makes it a command whose output is a file, so the claim has a date on it.
 */

export type ClaudeCompatibilityReport = {
  client: "claude";
  version: string | null;
  available: boolean;
  customChannel: "supported" | "unsupported" | "unknown";
  hookFallback: "available";
  recommendedDeliveryMode: "native_channel" | "hook" | "mailbox";
  testedAt: string;
  notes: Record<string, string>;
};

export type CompatibilityReport = CodexCompatibilityReport | ClaudeCompatibilityReport;

export type UnavailableReport = {
  client: "codex" | "claude";
  available: false;
  version: null;
  recommendedDeliveryMode: "mailbox";
  testedAt: string;
  notes: Record<string, string>;
};

function reportPath(client: string): string {
  return resolve(dataDir, "compatibility", `${client}.json`);
}

function runCommand(command: string, args: string[]): { status: number; output: string } {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 20_000,
    // The probe reads a version and a help screen; neither should inherit a Hub credential.
    env: sanitizeModelEnvironment(process.env),
  });
  return {
    status: result.status ?? 1,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

function firstLine(text: string): string | null {
  const line = text.trim().split(/\r?\n/)[0];
  return line ? line.trim() : null;
}

export function readCompatibilityReport(client: "codex" | "claude"): unknown | null {
  try {
    return JSON.parse(readFileSync(reportPath(client), "utf8")) as unknown;
  } catch {
    return null;
  }
}

function store(client: "codex" | "claude", report: unknown): unknown {
  const path = reportPath(client);
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}

export async function probeCodex(options: {
  cwd: string;
  command?: string;
  allowModelTurn?: boolean;
}): Promise<unknown> {
  const command = options.command ?? "codex";
  const version = runCommand(command, ["--version"]);
  if (version.status !== 0) {
    return store("codex", {
      client: "codex",
      available: false,
      version: null,
      recommendedDeliveryMode: "mailbox",
      testedAt: new Date().toISOString(),
      notes: { codex: `\`${command} --version\` failed: ${version.output.trim() || "not found"}` },
    } satisfies UnavailableReport);
  }
  // A real app-server child, started the way the Bridge starts one, with every CrossAgent variable
  // stripped: the probe needs no Hub credential and must not hand the model one.
  const server = new CodexAppServer({
    command,
    cwd: options.cwd,
    environment: sanitizeModelEnvironment(process.env),
  });
  await server.start();
  try {
    return store(
      "codex",
      await probeCodexCompatibility(server, {
        cwd: options.cwd,
        version: firstLine(version.output),
        allowModelTurn: options.allowModelTurn,
      }),
    );
  } finally {
    await server.stop();
  }
}

export function probeClaude(options: { command?: string } = {}): unknown {
  const command = options.command ?? "claude";
  const version = runCommand(command, ["--version"]);
  if (version.status !== 0) {
    return store("claude", {
      client: "claude",
      available: false,
      version: null,
      recommendedDeliveryMode: "mailbox",
      testedAt: new Date().toISOString(),
      notes: { claude: `\`${command} --version\` failed: ${version.output.trim() || "not found"}` },
    } satisfies UnavailableReport);
  }
  // The Channel is loaded by a flag rather than announced by an API, so the help screen is the
  // only thing that can be asked. A help screen that cannot be read leaves this "unknown" rather
  // than guessing from the version, which is the whole point.
  const help = runCommand(command, ["--help"]);
  const customChannel: ClaudeCompatibilityReport["customChannel"] =
    help.status !== 0
      ? "unknown"
      : help.output.includes("--dangerously-load-development-channels")
        ? "supported"
        : "unsupported";
  const notes: Record<string, string> = {};
  if (customChannel === "unknown") notes.customChannel = `\`${command} --help\` did not run`;
  if (customChannel === "unsupported") {
    notes.customChannel =
      "this build advertises no custom Channel flag; `crossagent hooks install claude .` is the supported route";
  }
  return store("claude", {
    client: "claude",
    version: firstLine(version.output),
    available: true,
    customChannel,
    hookFallback: "available",
    recommendedDeliveryMode: customChannel === "supported" ? "native_channel" : "hook",
    testedAt: new Date().toISOString(),
    notes,
  } satisfies ClaudeCompatibilityReport);
}
