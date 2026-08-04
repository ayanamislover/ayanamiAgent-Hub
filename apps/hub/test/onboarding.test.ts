import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readOnboardingState } from "../src/api/onboarding.js";

const roots: string[] = [];

function temporary(): string {
  const root = mkdtempSync(join(tmpdir(), "crossagent-onboarding-"));
  roots.push(root);
  return root;
}

describe("first-run onboarding state", () => {
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("reports nothing probed and nothing installed on a fresh machine", () => {
    const state = readOnboardingState({ dataDir: temporary(), projectRoot: temporary() });

    expect(state).toMatchObject({
      schemaVersion: 1,
      compatibility: { codex: null, claude: null },
      adapters: { claudeChannel: false, claudeHooks: false, codexHooks: false },
    });
  });

  it("returns whatever the probe wrote, without interpreting it", () => {
    const dataDir = temporary();
    mkdirSync(join(dataDir, "compatibility"), { recursive: true });
    writeFileSync(
      join(dataDir, "compatibility", "codex.json"),
      JSON.stringify({ client: "codex", version: "codex-cli 0.145.0", itemsList: "unsupported" }),
    );

    const state = readOnboardingState({ dataDir, projectRoot: null });

    expect(state.compatibility.codex).toEqual({
      client: "codex",
      version: "codex-cli 0.145.0",
      itemsList: "unsupported",
    });
    expect(state.compatibility.claude).toBeNull();
  });

  it("treats a half-written report as never probed rather than failing the screen", () => {
    const dataDir = temporary();
    mkdirSync(join(dataDir, "compatibility"), { recursive: true });
    writeFileSync(join(dataDir, "compatibility", "claude.json"), '{"client": "claude"');

    expect(readOnboardingState({ dataDir, projectRoot: null }).compatibility.claude).toBeNull();
  });

  it("counts an Adapter as installed only when its own entry is there", () => {
    const projectRoot = temporary();
    mkdirSync(join(projectRoot, ".claude"), { recursive: true });
    writeFileSync(join(projectRoot, ".claude", "settings.json"), "{}");
    // Some other MCP server in the same file is not this Adapter being installed.
    writeFileSync(
      join(projectRoot, ".mcp.json"),
      JSON.stringify({ mcpServers: { "some-other-server": {} } }),
    );

    expect(readOnboardingState({ dataDir: temporary(), projectRoot }).adapters).toEqual({
      claudeChannel: false,
      claudeHooks: true,
      codexHooks: false,
    });

    writeFileSync(
      join(projectRoot, ".mcp.json"),
      JSON.stringify({ mcpServers: { "crossagent-channel": { command: "node" } } }),
    );

    expect(readOnboardingState({ dataDir: temporary(), projectRoot }).adapters.claudeChannel).toBe(
      true,
    );
  });

  it("reports no project's adapters when no project was named", () => {
    expect(readOnboardingState({ dataDir: temporary(), projectRoot: null }).adapters).toEqual({
      claudeChannel: false,
      claudeHooks: false,
      codexHooks: false,
    });
  });
});
