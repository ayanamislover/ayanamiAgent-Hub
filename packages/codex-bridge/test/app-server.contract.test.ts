import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CodexAppServer } from "../src/app-server.js";
import { sanitizeModelEnvironment } from "../src/model-environment.js";

describe("Codex app-server contract", () => {
  it("does not let execa merge parent authority credentials back into the model child", async () => {
    const key = "CROSSAGENT_CODEX_INJECTOR_TOKEN";
    const previous = process.env[key];
    process.env[key] = "parent-only-authority-secret";
    const appServer = new CodexAppServer({
      command: process.execPath,
      argsPrefix: [resolve(import.meta.dirname, "fixtures", "fake-app-server.mjs")],
      cwd: process.cwd(),
      environment: sanitizeModelEnvironment(process.env, "ordinary-agent-token"),
    });
    try {
      const initialized = await appServer.start();
      expect(initialized).toMatchObject({ authorityCredentialKeys: [] });
    } finally {
      await appServer.stop();
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  });

  it("handshakes and preserves turn/steer/inject wire shapes", async () => {
    const appServer = new CodexAppServer({
      command: process.execPath,
      argsPrefix: [resolve(import.meta.dirname, "fixtures", "fake-app-server.mjs")],
      cwd: process.cwd(),
    });
    const notifications: string[] = [];
    const exits: unknown[] = [];
    appServer.on("notification", (message) => notifications.push(message.method));
    appServer.on("exit", (result) => exits.push(result));
    expect(appServer.activeGeneration).toBeNull();
    const initialized = await appServer.start();
    expect(appServer.activeGeneration).toBe(1);
    expect(initialized).toMatchObject({ platformFamily: "windows" });
    const capabilities = await appServer.probeCapabilities();
    expect(capabilities.models).toHaveLength(1);
    const thread = await appServer.request<any>("thread/start", { cwd: process.cwd() });
    expect(thread.thread.id).toBe("thr_fake");
    const turn = await appServer.request<any>("turn/start", {
      threadId: thread.thread.id,
      input: [{ type: "text", text: "work" }],
    });
    await expect(
      appServer.request("turn/steer", {
        threadId: thread.thread.id,
        expectedTurnId: turn.turn.id,
        input: [{ type: "text", text: "focus tests" }],
      }),
    ).resolves.toEqual({ turnId: "turn_fake" });
    await expect(
      appServer.request("turn/steer", {
        threadId: thread.thread.id,
        expectedTurnId: "stale",
        input: [{ type: "text", text: "wrong turn" }],
      }),
    ).rejects.toMatchObject({ code: -32602 });
    await expect(
      appServer.request("thread/inject_items", {
        threadId: thread.thread.id,
        items: [{ type: "message", role: "user", content: [] }],
      }),
    ).resolves.toEqual({});
    expect(notifications).toContain("thread/started");
    expect(notifications).toContain("turn/started");
    await appServer.stop();
    await vi.waitFor(() =>
      expect(exits).toContainEqual(
        expect.objectContaining({
          generation: 1,
        }),
      ),
    );
  });

  it("rolls a spawned process back when initialization fails", async () => {
    const appServer = new CodexAppServer({
      command: process.execPath,
      argsPrefix: [resolve(import.meta.dirname, "fixtures", "fake-app-server-reject-init.mjs")],
      cwd: process.cwd(),
    });

    await expect(appServer.start()).rejects.toThrow("fixture rejected initialization");
    expect(appServer.activeGeneration).toBeNull();

    // A stale connection would report "already running" here. Reaching the same initialization
    // rejection proves the first failed start left the Module reusable.
    await expect(appServer.start()).rejects.toThrow("fixture rejected initialization");
    expect(appServer.activeGeneration).toBeNull();
  });

  it("escalates to SIGKILL when SIGTERM was sent but the child did not exit", async () => {
    vi.useFakeTimers();
    try {
      const appServer = new CodexAppServer({
        command: process.execPath,
        cwd: process.cwd(),
      });
      let settleExit: () => void = () => undefined;
      const exit = new Promise<Record<string, unknown>>((resolveExit) => {
        settleExit = () => resolveExit({ exitCode: 0 });
      });
      const child = Object.assign(exit, {
        killed: false,
        kill: vi.fn((signal: NodeJS.Signals) => {
          child.killed = true;
          if (signal === "SIGKILL") settleExit();
          return true;
        }),
      });
      (
        appServer as unknown as {
          process: typeof child;
        }
      ).process = child;

      const stopping = appServer.stop();
      await vi.advanceTimersByTimeAsync(3_000);
      await stopping;

      expect(child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
      expect(child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
    } finally {
      vi.useRealTimers();
    }
  });
});
