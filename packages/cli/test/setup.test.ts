import { describe, expect, it } from "vitest";
import { runSetup, type SetupDependencies, type SetupReport } from "../src/setup.js";

function dependencies(overrides: Partial<SetupDependencies> = {}): SetupDependencies {
  return {
    initializeProject: () => ({ ok: true }),
    startHub: async () => ({ port: 4387, reused: false }),
    joinProject: async (root) => ({ project: { id: "prj_test" }, root }),
    probeCodex: async () => ({ client: "codex", version: "codex-cli 0.145.0" }),
    probeClaude: () => ({
      client: "claude",
      available: true,
      version: "1.2.3",
      customChannel: "supported",
    }),
    installClaudeChannel: () => ({ changed: true }),
    installClaudeHooks: () => ({ changed: true }),
    installCodexHooks: () => ({ changed: true }),
    collectDiagnostics: async () => ({ hub: { health: { ok: true } } }),
    openDashboard: async (baseUrl) => baseUrl,
    ...overrides,
  };
}

function named(report: SetupReport, name: string) {
  return report.steps.find((step) => step.name === name)!;
}

describe("crossagent setup", () => {
  it("runs the whole first-run sequence in order and reports what each step did", async () => {
    const report = await runSetup({ path: ".", open: false }, dependencies());

    expect(report.ok).toBe(true);
    expect(report.projectId).toBe("prj_test");
    expect(report.steps.map((step) => step.name)).toEqual([
      "Initialize project",
      "Start Hub",
      "Register project",
      "Detect Codex CLI",
      "Detect Claude CLI",
      "Install the Claude Adapter",
      "Install the Codex hooks",
      "Run diagnostics",
      "Open the Dashboard",
    ]);
    expect(report.steps.map((step) => step.step)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(named(report, "Install the Claude Adapter").detail).toBe("installed the custom Channel");
    expect(report.nextSteps).toEqual([
      "crossagent codex --detach",
      "Send one message from the Dashboard to confirm the round trip",
    ]);
  });

  it("installs the Hook fallback when the probe found no custom Channel", async () => {
    const installed: string[] = [];
    const report = await runSetup(
      { path: ".", open: false },
      dependencies({
        probeClaude: () => ({ available: true, version: "1.2.3", customChannel: "unsupported" }),
        installClaudeChannel: () => installed.push("channel"),
        installClaudeHooks: () => installed.push("hooks"),
      }),
    );

    expect(installed).toEqual(["hooks"]);
    expect(named(report, "Install the Claude Adapter").detail).toBe("installed the Hook fallback");
  });

  it("skips an Adapter whose CLI is not installed rather than failing the run", async () => {
    const report = await runSetup(
      { path: ".", open: false },
      dependencies({
        probeCodex: async () => ({ client: "codex", available: false, version: null }),
        probeClaude: () => ({ client: "claude", available: false, version: null }),
        installClaudeChannel: () => {
          throw new Error("should not be reached");
        },
        installCodexHooks: () => {
          throw new Error("should not be reached");
        },
      }),
    );

    expect(named(report, "Install the Claude Adapter").state).toBe("SKIPPED");
    expect(named(report, "Install the Codex hooks").state).toBe("SKIPPED");
    // Nothing failed: a machine without Codex installed is a supported starting point.
    expect(report.ok).toBe(true);
    expect(report.nextSteps).toEqual([
      "Send one message from the Dashboard to confirm the round trip",
    ]);
  });

  it("keeps going past one failed step and still reports the run as failed", async () => {
    const report = await runSetup(
      { path: ".", open: false },
      dependencies({
        probeCodex: async () => {
          throw new Error("codex app-server refused to start");
        },
      }),
    );

    expect(named(report, "Detect Codex CLI")).toMatchObject({
      state: "FAILED",
      detail: "codex app-server refused to start",
    });
    expect(named(report, "Install the Claude Adapter").state).toBe("OK");
    expect(named(report, "Run diagnostics").state).toBe("OK");
    expect(report.ok).toBe(false);
  });

  it("stops when there is no Hub, because nothing after it could be answered honestly", async () => {
    const reached: string[] = [];
    const report = await runSetup(
      { path: ".", open: false },
      dependencies({
        startHub: async () => {
          throw new Error("port 4387 is already in use by another process");
        },
        joinProject: async (root) => {
          reached.push("join");
          return { project: { id: "prj_test" }, root };
        },
      }),
    );

    expect(reached).toEqual([]);
    expect(report.ok).toBe(false);
    expect(report.steps.map((step) => step.name)).toEqual(["Initialize project", "Start Hub"]);
    expect(report.nextSteps).toEqual([
      "Fix the Hub start failure above, then run crossagent setup . again",
    ]);
  });
});
