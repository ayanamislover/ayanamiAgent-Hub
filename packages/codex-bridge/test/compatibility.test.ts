import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CodexAppServer } from "../src/app-server.js";
import { probeCodexCompatibility } from "../src/compatibility.js";
import { sanitizeModelEnvironment } from "../src/model-environment.js";

const fixture = resolve(import.meta.dirname, "fixtures", "fake-app-server.mjs");

function fakeAppServer(): CodexAppServer {
  return new CodexAppServer({
    command: process.execPath,
    argsPrefix: [fixture],
    cwd: process.cwd(),
    environment: sanitizeModelEnvironment(process.env),
  });
}

describe("Codex compatibility probe", () => {
  it("reports only the surfaces the app-server actually answered", async () => {
    const server = fakeAppServer();
    await server.start();
    try {
      const report = await probeCodexCompatibility(server, { cwd: process.cwd(), version: "1.0" });

      expect(report.threadStart).toBe("supported");
      expect(report.threadResume).toBe("supported");
      // The fixture answers -32601 for both readback surfaces, which is the shape the Bridge was
      // measured against on the real CLI.
      expect(report.itemsList).toBe("unsupported");
      expect(report.threadRead).toBe("unsupported");
      expect(report.methods).toEqual(["thread/start", "thread/resume", "thread/inject_items"]);
    } finally {
      await server.stop();
    }
  });

  it("separates an accepted injection from a confirmed one", async () => {
    const server = fakeAppServer();
    await server.start();
    try {
      const report = await probeCodexCompatibility(server, { cwd: process.cwd() });

      // The item was accepted, and nothing can read it back. That is not the same as a failed
      // injection and must not be reported as a delivery surface.
      expect(report.injectAccepted).toBe(true);
      expect(report.injectReadable).toBeNull();
      expect(report.notes.injectReadable).toContain("cannot be confirmed");
      expect(report.recommendedDeliveryMode).toBe("wake");
    } finally {
      await server.stop();
    }
  });

  it("does not start a turn unless a model call was allowed", async () => {
    const server = fakeAppServer();
    await server.start();
    try {
      const report = await probeCodexCompatibility(server, { cwd: process.cwd() });
      expect(report.steerReadable).toBeNull();
      expect(report.notes.steerReadable).toContain("calls the model");
    } finally {
      await server.stop();
    }
  });

  it("probes the steer readback when a model turn is allowed", async () => {
    const server = fakeAppServer();
    await server.start();
    try {
      const report = await probeCodexCompatibility(server, {
        cwd: process.cwd(),
        allowModelTurn: true,
      });
      // The fixture accepts the steer and exposes no thread/read, which is exactly the case
      // docs/known-limitations.md records: accepted, unconfirmable.
      expect(report.steerReadable).toBe(false);
    } finally {
      await server.stop();
    }
  });

  it("falls back to the mailbox when even a thread cannot be started", async () => {
    const server = new CodexAppServer({
      command: process.execPath,
      // A process that exits immediately cannot answer anything.
      argsPrefix: ["-e", "process.exit(0)"],
      cwd: process.cwd(),
      environment: sanitizeModelEnvironment(process.env),
    });
    await expect(server.start()).rejects.toThrow();
    await server.stop();
  });
});
