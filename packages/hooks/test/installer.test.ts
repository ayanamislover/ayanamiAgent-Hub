import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { installHooks } from "../src/installer.js";

describe("installHooks", () => {
  it("merges idempotently without discarding existing Claude settings", () => {
    const root = mkdtempSync(resolve(tmpdir(), "crossagent-hooks-"));
    const first = installHooks({
      client: "claude",
      projectDir: root,
      hookEntryPath: resolve(root, "hook.js"),
      nodePath: process.execPath,
    });
    const second = installHooks({
      client: "claude",
      projectDir: root,
      hookEntryPath: resolve(root, "hook.js"),
      nodePath: process.execPath,
    });
    const settings = JSON.parse(readFileSync(first.path, "utf8"));
    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(settings.hooks.SessionStart).toHaveLength(1);
    expect(settings.hooks.SessionEnd[0].hooks[0].timeout).toBe(3);
    expect(settings.hooks.UserPromptSubmit[0].hooks[0]).not.toHaveProperty(
      "additionalContextLimit",
    );
  });

  it("replaces stale CrossAgent handlers once while preserving unrelated hooks", () => {
    const root = mkdtempSync(resolve(tmpdir(), "crossagent-hooks-codex-"));
    mkdirSync(resolve(root, ".codex"));
    const path = resolve(root, ".codex", "hooks.json");
    writeFileSync(
      path,
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            {
              hooks: [
                {
                  type: "command",
                  command:
                    '"node" "C:\\old\\packages\\hooks\\dist\\hook.js" --client codex --token-file "C:\\old\\shared-token"',
                  timeout: 15,
                },
                { type: "command", command: "user-owned-hook", timeout: 20 },
              ],
            },
          ],
        },
      }),
    );
    const result = installHooks({
      client: "codex",
      projectDir: root,
      hookEntryPath: resolve(root, "packages", "hooks", "dist", "hook.js"),
      nodePath: process.execPath,
    });
    const settings = JSON.parse(readFileSync(result.path, "utf8"));
    const handlers = settings.hooks.UserPromptSubmit.flatMap((group: any) => group.hooks);
    expect(
      handlers.filter((handler: any) => handler.command.includes("--client codex")),
    ).toHaveLength(1);
    expect(handlers.some((handler: any) => handler.command === "user-owned-hook")).toBe(true);
    expect(JSON.stringify(handlers)).not.toContain("--token-file");
    expect(
      handlers.find((handler: any) => handler.command.includes("--client codex")),
    ).toMatchObject({
      additionalContextLimit: 2000,
    });
  });

  it("preserves non-command Claude handlers without assuming they have a command field", () => {
    const root = mkdtempSync(resolve(tmpdir(), "crossagent-hooks-claude-http-"));
    mkdirSync(resolve(root, ".claude"));
    const path = resolve(root, ".claude", "settings.json");
    const existing = {
      type: "http",
      url: "http://127.0.0.1:9999/user-prompt",
      headers: { "x-owned-by": "user" },
    };
    writeFileSync(path, JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [existing] }] } }));

    const result = installHooks({
      client: "claude",
      projectDir: root,
      hookEntryPath: resolve(root, "packages", "hooks", "dist", "hook.js"),
      nodePath: process.execPath,
    });
    const settings = JSON.parse(readFileSync(result.path, "utf8"));
    const handlers = settings.hooks.UserPromptSubmit.flatMap((group: any) => group.hooks);

    expect(handlers).toContainEqual(existing);
    expect(handlers.filter((handler: any) => handler.type === "command")).toHaveLength(1);
  });

  it("persists bootstrap-only credential paths and the session-ticket store without a legacy data-plane bearer", () => {
    const root = mkdtempSync(resolve(tmpdir(), "crossagent-hooks-persisted-config-"));
    const agentTokenPath = resolve(root, "custom data", "agent-codex-token");
    const captureTokenPath = resolve(root, "custom data", "capture-codex-token");
    const authorityTrustFilePath = resolve(
      root,
      "custom data",
      "authority",
      "trusted-signing-keys.json",
    );
    const ticketStoreDir = resolve(root, "custom data", "tickets", "hooks");
    const spoolDir = resolve(root, "custom data", "spool", "user-turns");
    const baseUrl = "http://127.0.0.1:49387";

    const result = installHooks({
      client: "codex",
      projectDir: root,
      hookEntryPath: resolve(root, "packages", "hooks", "dist", "hook.js"),
      nodePath: process.execPath,
      agentTokenPath,
      captureTokenPath,
      authorityTrustFilePath,
      ticketStoreDir,
      spoolDir,
      baseUrl,
    });
    const settings = JSON.parse(readFileSync(result.path, "utf8"));
    const command = settings.hooks.UserPromptSubmit[0].hooks[0].command as string;

    expect(command).toContain(`--agent-token-file "${agentTokenPath}"`);
    expect(command).toContain(`--capture-token-file "${captureTokenPath}"`);
    expect(command).toContain(`--authority-trust-file "${authorityTrustFilePath}"`);
    expect(command).toContain(`--ticket-store-dir "${ticketStoreDir}"`);
    expect(command).toContain(`--spool-dir "${spoolDir}"`);
    expect(command).toContain(`--base-url "${baseUrl}"`);
    expect(command).not.toMatch(/(?:^|\s)--token(?:-file)?(?:\s|$)/u);
    expect(command).not.toContain("CROSSAGENT_TOKEN");
    expect(settings.description).toBe("CrossAgent Hub session-ticket lifecycle hooks.");
  });
});
