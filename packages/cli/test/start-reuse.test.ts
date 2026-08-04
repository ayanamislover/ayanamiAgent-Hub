import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeBuildIdentity } from "../src/build-identity.js";
import { workspaceFile } from "../src/paths.js";

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(() => {
    throw new Error("SPAWN_REACHED");
  }),
}));

vi.mock("node:child_process", () => ({ spawn: spawnMock }));

const localBuild: RuntimeBuildIdentity = Object.freeze({
  buildSessionId: "11111111-1111-4111-8111-111111111111",
  buildId: "1".repeat(64),
  migrationId: "4".repeat(64),
  protocolId: "2".repeat(64),
  manifestSha256: "3".repeat(64),
});

let workspaceVerifies = true;

vi.mock("../src/build-identity.js", async (loadOriginal) => {
  const original = await loadOriginal<typeof import("../src/build-identity.js")>();
  return {
    ...original,
    verifyWorkspaceBuildIdentity: () => localBuild,
    withRuntimeBuildLock: async <T>(
      operation: (identity: RuntimeBuildIdentity) => T | Promise<T>,
    ) => operation(localBuild),
    // Most of these tests are about a workspace that verifies cleanly, so the recoverable lock
    // hands over the same identity. Leaving it unmocked would send stop and status through the
    // real workspace and compare a real build against this fixture's. One test flips
    // `workspaceVerifies` to cover the case the recoverable lock exists for.
    withRecoverableRuntimeBuildLock: async <T>(
      operation: (identity: RuntimeBuildIdentity | null, failure: Error | null) => T | Promise<T>,
    ) =>
      workspaceVerifies
        ? operation(localBuild, null)
        : operation(null, new Error("Build migration set mismatch")),
  };
});

describe("startHub only adopts a build-verified Hub", () => {
  const loadWithDataDir = async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "crossagent-start-"));
    vi.stubEnv("CROSSAGENT_DATA_DIR", dir);
    vi.resetModules();
    const { inspectHubRuntimeStatus, requireExactRuntimeBuild, startHub, stopHub } =
      await import("../src/process-manager.js");
    return { dir, inspectHubRuntimeStatus, requireExactRuntimeBuild, startHub, stopHub };
  };

  const writePidRecord = (
    dir: string,
    overrides: Partial<{
      pid: number;
      instanceId: string;
      buildIdentity: RuntimeBuildIdentity;
    }> = {},
  ) =>
    writeFileSync(
      resolve(dir, "hub.pid.json"),
      `${JSON.stringify({
        pid: overrides.pid ?? process.pid,
        startedAt: "2026-08-01T00:00:00.000Z",
        port: 4387,
        entry: workspaceFile("apps", "hub", "dist", "main.js"),
        instanceId: overrides.instanceId ?? "a".repeat(32),
        buildIdentity: overrides.buildIdentity ?? localBuild,
      })}\n`,
      "utf8",
    );

  const healthResponse = (
    overrides: Partial<{
      pid: number;
      instanceId: string;
      build: RuntimeBuildIdentity;
    }> = {},
  ) =>
    new Response(
      JSON.stringify({
        ok: true,
        pid: overrides.pid ?? process.pid,
        instanceId: overrides.instanceId ?? "a".repeat(32),
        startedAt: "2026-08-01T00:00:00.000Z",
        port: 4387,
        build: overrides.build ?? localBuild,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );

  const writeShutdownReceipt = (
    dir: string,
    idempotencyKey: string,
    overrides: Partial<{ pid: number; instanceId: string; startedAt: string }> = {},
  ) =>
    writeFileSync(
      resolve(dir, "hub.shutdown.receipt.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        pid: overrides.pid ?? process.pid,
        instanceId: overrides.instanceId ?? "a".repeat(32),
        buildIdentity: localBuild,
        idempotencyKey,
        startedAt: overrides.startedAt ?? "2026-08-01T00:00:00.000Z",
        stoppedAt: "2026-08-01T00:00:02.000Z",
      })}\n`,
    );

  const writeShutdownIntent = (
    dir: string,
    idempotencyKey: string,
    overrides: Partial<{ instanceId: string; buildIdentity: RuntimeBuildIdentity }> = {},
  ) =>
    writeFileSync(
      resolve(dir, "hub.shutdown.intent.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        instanceId: overrides.instanceId ?? "a".repeat(32),
        buildIdentity: overrides.buildIdentity ?? localBuild,
        idempotencyKey,
        requestedAt: "2026-08-01T00:00:01.000Z",
      })}\n`,
    );

  afterEach(() => {
    workspaceVerifies = true;
    spawnMock.mockClear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("wedges a replacement start when a dead Hub has an unreceipted shutdown intent", async () => {
    const { dir, startHub } = await loadWithDataDir();
    const deadPid = 2_147_483_647;
    const key = "33333333-3333-4333-8333-333333333333";
    writePidRecord(dir, { pid: deadPid });
    writeShutdownIntent(dir, key);

    await expect(startHub()).rejects.toThrow(/shutdown.*requires reconciliation/i);
    expect(existsSync(resolve(dir, "hub.pid.json"))).toBe(true);
    expect(existsSync(resolve(dir, "hub.shutdown.intent.json"))).toBe(true);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("clears a dead Hub only after its exact durable shutdown receipt", async () => {
    const { dir, startHub } = await loadWithDataDir();
    const deadPid = 2_147_483_647;
    const key = "33333333-3333-4333-8333-333333333333";
    writePidRecord(dir, { pid: deadPid });
    writeShutdownIntent(dir, key);
    writeShutdownReceipt(dir, key, { pid: deadPid });

    await expect(startHub()).rejects.toThrow("SPAWN_REACHED");
    expect(existsSync(resolve(dir, "hub.pid.json"))).toBe(false);
    expect(existsSync(resolve(dir, "hub.shutdown.intent.json"))).toBe(false);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("adopts only when PID record, process, instance, and full build identity agree", async () => {
    const { dir, startHub } = await loadWithDataDir();
    writePidRecord(dir);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => healthResponse()),
    );

    const result = await startHub();

    expect(result).toMatchObject({
      pid: process.pid,
      instanceId: "a".repeat(32),
      buildIdentity: localBuild,
      reused: true,
      servingStaleBuild: false,
    });
  });

  it("rejects an old PID record before adopting or spawning", async () => {
    const { dir, startHub } = await loadWithDataDir();
    writeFileSync(
      resolve(dir, "hub.pid.json"),
      `${JSON.stringify({
        pid: process.pid,
        startedAt: "2026-08-01T00:00:00.000Z",
        port: 4387,
        entry: resolve(dir, "main.js"),
      })}\n`,
    );
    const fetchMock = vi.fn(async () => healthResponse());
    vi.stubGlobal("fetch", fetchMock);

    await expect(startHub()).rejects.toThrow(/LEGACY_BUILD_UNVERIFIED/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a mixed live build before adoption", async () => {
    const { dir, startHub } = await loadWithDataDir();
    writePidRecord(dir);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => healthResponse({ build: { ...localBuild, buildId: "f".repeat(64) } })),
    );

    await expect(startHub()).rejects.toThrow(/Live Hub build identity mismatch/);
  });

  it("rejects a mixed migration identity before adoption", async () => {
    const { dir, startHub } = await loadWithDataDir();
    writePidRecord(dir);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => healthResponse({ build: { ...localBuild, migrationId: "f".repeat(64) } })),
    );

    await expect(startHub()).rejects.toThrow(/Live Hub build identity mismatch/);
  });

  it("rejects fake-online health served by a different PID", async () => {
    const { dir, startHub } = await loadWithDataDir();
    writePidRecord(dir);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => healthResponse({ pid: process.pid + 1 })),
    );

    await expect(startHub()).rejects.toThrow(/PID ownership/);
  });

  it("rejects a managed-child handoff mismatch before contacting the Hub", async () => {
    const { requireExactRuntimeBuild } = await loadWithDataDir();
    const fetchMock = vi.fn(async () => healthResponse());
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      requireExactRuntimeBuild({ ...localBuild, migrationId: "f".repeat(64) }),
    ).rejects.toThrow(/Managed child local release build identity mismatch/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not signal a live PID when health reports a different build", async () => {
    const { dir, stopHub } = await loadWithDataDir();
    writePidRecord(dir);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => healthResponse({ build: { ...localBuild, buildId: "f".repeat(64) } })),
    );
    const kill = vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
      if (signal === 0) return true;
      throw new Error(`unexpected process signal: ${String(signal)}`);
    });

    await expect(stopHub()).rejects.toThrow(/Live Hub build identity mismatch/);
    expect(kill.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
  });

  it("reports PID reuse as unverified instead of fake-online", async () => {
    const { dir, inspectHubRuntimeStatus } = await loadWithDataDir();
    writePidRecord(dir);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => healthResponse({ instanceId: "b".repeat(32) })),
    );

    await expect(inspectHubRuntimeStatus()).resolves.toMatchObject({
      running: false,
      verified: false,
      pid: { pid: process.pid },
      health: null,
      reason: expect.stringMatching(/PID ownership/i),
    });
  });

  it("uses an authenticated exact ACK and never signals the numeric PID", async () => {
    const { dir, stopHub } = await loadWithDataDir();
    writePidRecord(dir);
    writeFileSync(resolve(dir, "dashboard-token"), `${"d".repeat(48)}\n`);
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/api/health")) {
        return fetchMock.mock.calls.length < 3
          ? healthResponse()
          : new Response("", { status: 503 });
      }
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(init?.headers).toMatchObject({ authorization: `Bearer ${"d".repeat(48)}` });
      writeShutdownReceipt(dir, String(request.idempotencyKey));
      return new Response(
        JSON.stringify({
          accepted: true,
          idempotencyKey: request.idempotencyKey,
          instanceId: "a".repeat(32),
          buildId: localBuild.buildId,
          scheduledAt: "2026-08-01T00:00:01.000Z",
        }),
        { status: 202 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const kill = vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
      if (signal === 0) return true;
      throw new Error(`unexpected process signal: ${String(signal)}`);
    });

    await expect(stopHub()).resolves.toEqual({
      stopped: true,
      stale: false,
      buildVerified: true,
    });
    expect(kill.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
  });

  // The deadlock this prevents: a migration lands without a rebuild, so the workspace release no
  // longer verifies. Every runtime command was gated on that verification, and an in-place build
  // refuses while a Hub is serving -- so the Hub could not be stopped and therefore the build
  // could not be fixed. Stopping has to work without a verifiable workspace, and say that it did.
  it("stops a Hub whose workspace release no longer verifies, and reports it unverified", async () => {
    const { dir, stopHub } = await loadWithDataDir();
    writePidRecord(dir);
    writeFileSync(resolve(dir, "dashboard-token"), `${"d".repeat(48)}\n`);
    workspaceVerifies = false;
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      if (String(input).endsWith("/api/health")) return healthResponse();
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      // The identity still has to be exact -- it just comes from the live Hub, which the PID
      // record corroborates, rather than from a working tree that cannot be read.
      expect(request.build).toEqual(localBuild);
      writeShutdownReceipt(dir, String(request.idempotencyKey));
      return new Response(
        JSON.stringify({
          accepted: true,
          idempotencyKey: request.idempotencyKey,
          instanceId: "a".repeat(32),
          buildId: localBuild.buildId,
          scheduledAt: "2026-08-01T00:00:01.000Z",
        }),
        { status: 202 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const kill = vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
      if (signal === 0) return true;
      throw new Error(`unexpected process signal: ${String(signal)}`);
    });

    await expect(stopHub()).resolves.toEqual({
      stopped: true,
      stale: false,
      buildVerified: false,
      reason: "Build migration set mismatch",
    });
    expect(kill.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
  });

  it("replays a lost shutdown ACK with one stable idempotency key", async () => {
    const { dir, stopHub } = await loadWithDataDir();
    writePidRecord(dir);
    writeFileSync(resolve(dir, "dashboard-token"), `${"d".repeat(48)}\n`);
    const bodies: Array<Record<string, unknown>> = [];
    let healthCalls = 0;
    let shutdownCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith("/api/health")) {
          healthCalls += 1;
          return healthCalls === 1 ? healthResponse() : new Response("", { status: 503 });
        }
        shutdownCalls += 1;
        const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
        bodies.push(request);
        if (shutdownCalls === 1) throw new Error("ACK lost after acceptance");
        writeShutdownReceipt(dir, String(request.idempotencyKey));
        return new Response(
          JSON.stringify({
            accepted: true,
            idempotencyKey: request.idempotencyKey,
            instanceId: "a".repeat(32),
            buildId: localBuild.buildId,
            scheduledAt: "2026-08-01T00:00:01.000Z",
          }),
          { status: 202 },
        );
      }),
    );
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);

    await expect(stopHub()).resolves.toEqual({
      stopped: true,
      stale: false,
      buildVerified: true,
    });
    expect(bodies).toHaveLength(2);
    expect(bodies[0]?.idempotencyKey).toBe(bodies[1]?.idempotencyKey);
    expect(kill.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
  });

  it("does not signal a replacement PID after the shutdown ACK", async () => {
    const { dir, stopHub } = await loadWithDataDir();
    writePidRecord(dir);
    writeFileSync(resolve(dir, "dashboard-token"), `${"d".repeat(48)}\n`);
    let healthCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith("/api/health")) {
          healthCalls += 1;
          return healthCalls === 1
            ? healthResponse()
            : healthResponse({ pid: process.pid + 1, instanceId: "b".repeat(32) });
        }
        const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
        writeShutdownReceipt(dir, String(request.idempotencyKey));
        return new Response(
          JSON.stringify({
            accepted: true,
            idempotencyKey: request.idempotencyKey,
            instanceId: "a".repeat(32),
            buildId: localBuild.buildId,
            scheduledAt: "2026-08-01T00:00:01.000Z",
          }),
          { status: 202 },
        );
      }),
    );
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);

    await expect(stopHub()).resolves.toEqual({
      stopped: true,
      stale: false,
      buildVerified: true,
    });
    expect(kill.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
  });

  it("keeps PID and intent when health disappears without a terminal receipt", async () => {
    vi.useFakeTimers();
    const { dir, stopHub } = await loadWithDataDir();
    writePidRecord(dir);
    writeFileSync(resolve(dir, "dashboard-token"), `${"d".repeat(48)}\n`);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith("/api/health")) return healthResponse();
        const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            accepted: true,
            idempotencyKey: request.idempotencyKey,
            instanceId: "a".repeat(32),
            buildId: localBuild.buildId,
            scheduledAt: "2026-08-01T00:00:01.000Z",
          }),
          { status: 202 },
        );
      }),
    );
    try {
      const stopping = expect(stopHub()).rejects.toThrow(/timed out.*no process signal/i);
      await vi.runAllTimersAsync();
      await stopping;
      expect(existsSync(resolve(dir, "hub.pid.json"))).toBe(true);
      expect(existsSync(resolve(dir, "hub.shutdown.intent.json"))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reuses a write-ahead shutdown key across separate stop calls", async () => {
    const { dir, stopHub } = await loadWithDataDir();
    writePidRecord(dir);
    writeFileSync(resolve(dir, "dashboard-token"), `${"d".repeat(48)}\n`);
    const keys: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith("/api/health")) return healthResponse();
        const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
        keys.push(String(request.idempotencyKey));
        return new Response("rejected before response finish", { status: 500 });
      }),
    );
    await expect(stopHub()).rejects.toThrow(/rejected \(500\)/i);

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith("/api/health")) return healthResponse();
        const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
        keys.push(String(request.idempotencyKey));
        writeShutdownReceipt(dir, String(request.idempotencyKey));
        return new Response(
          JSON.stringify({
            accepted: true,
            idempotencyKey: request.idempotencyKey,
            instanceId: "a".repeat(32),
            buildId: localBuild.buildId,
            scheduledAt: "2026-08-01T00:00:01.000Z",
          }),
          { status: 202 },
        );
      }),
    );
    await expect(stopHub()).resolves.toEqual({
      stopped: true,
      stale: false,
      buildVerified: true,
    });
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it("accepts an old terminal receipt when lost-ACK replay reaches a replacement", async () => {
    const { dir, stopHub } = await loadWithDataDir();
    writePidRecord(dir);
    writeFileSync(resolve(dir, "dashboard-token"), `${"d".repeat(48)}\n`);
    let shutdownCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith("/api/health")) return healthResponse();
        shutdownCalls += 1;
        const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
        if (shutdownCalls === 1) {
          writeShutdownReceipt(dir, String(request.idempotencyKey));
          throw new Error("old Hub committed, ACK lost, replacement took the port");
        }
        return new Response("replacement does not own the target", { status: 409 });
      }),
    );

    await expect(stopHub()).resolves.toEqual({
      stopped: true,
      stale: false,
      buildVerified: true,
    });
    expect(shutdownCalls).toBe(2);
  });
});
