import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { TrustedAuthorityKeyManifestSchema } from "@crossagent/protocol";
import { HubHttpError } from "@crossagent/client";
import { describe, expect, it, vi } from "vitest";
import { attachToHub, defaultRetryDelayMs } from "../src/attach.js";
import { ClaudeChannel } from "../src/channel.js";

/**
 * The client spawns this process and asks it for tools straight away, but the Hub is a separate
 * process that may not be listening yet -- the normal case right after a machine reboot, where
 * nothing starts the Hub before the agent's own app.
 *
 * Reaching the Hub used to happen before any transport existed, so a refused connection killed the
 * process and the agent lost its channel tools for the whole session, with no retry. It then fell
 * back to hand-rolled HTTP against the raw API. The tools must not depend on the Hub already
 * being up.
 */
describe("channel startup does not depend on the Hub being up first", () => {
  const authorityTrustManifest = TrustedAuthorityKeyManifestSchema.parse({
    schemaVersion: 1,
    keys: [
      {
        keyId: `ed25519:${"a".repeat(43)}`,
        fingerprintSha256: "b".repeat(64),
      },
    ],
  });
  const project = {
    id: "prj_1234",
    name: "fixture",
    defaultBranch: "main",
    activeObjectiveId: null,
    config: {},
    version: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  /** A Hub that refuses connections until `up` is flipped, the way a Hub still booting does. */
  const makeFlakyHub = () => {
    const state = { up: false, joinAttempts: 0 };
    const hub = {
      joinProject: vi.fn(async () => {
        state.joinAttempts += 1;
        if (!state.up) throw new Error("connect ECONNREFUSED 127.0.0.1:4387");
        return { project, root: process.cwd(), created: false };
      }),
      registerSession: vi.fn(async () => ({
        id: "ses_1234",
        projectId: project.id,
        agentId: "claude",
        role: "primary",
        client: "claude-channel",
        transport: "websocket",
        deliveryMode: "native_channel",
        capabilities: [],
        connectionState: "ONLINE",
        workState: "IDLE",
        version: 0,
      })),
      heartbeat: vi.fn(async () => ({ id: "ses_1234", workState: "IDLE" })),
      closeSession: vi.fn(async () => ({ id: "ses_1234" })),
      closeAdapterSession: vi.fn(async () => ({ id: "ses_1234" })),
      getMessage: vi.fn(async () => ({})),
      claimMessageRecipient: vi.fn(async () => ({})),
      setMessageState: vi.fn(async () => ({})),
      listMessages: vi.fn(async () => []),
      postMessage: vi.fn(async () => ({})),
      getContextPack: vi.fn(async () => ({})),
      listEvents: vi.fn(async () => []),
      request: vi.fn(async () => ({})),
    };
    return { hub, state };
  };

  // With --project-id the constructed cwd is only a placeholder; the Hub owns the real root and
  // cannot be asked for it until it is up. Keeping the two distinct is what proves the root that
  // reaches joinProject is the Hub's, not the directory this process happened to start in.
  const PROVISIONAL_CWD = process.cwd();
  const HUB_ROOT = "R:\\root-only-the-hub-knows";

  const serve = (hub: unknown) => {
    const binding = {
      bundleId: "stb_attach",
      state: "ACTIVE" as const,
      projectId: project.id,
      agentId: "claude" as const,
      adapterClient: "claude" as const,
      hubSessionId: "ses_1234",
      lineageId: "lin_attach",
      incarnation: 1,
      runId: "run_attach",
      activatedAt: new Date().toISOString(),
      expiresAt: "2099-08-02T00:00:00.000Z",
      purposes: [{ id: "stk_attach", purpose: "CONTROL" as const, state: "ACTIVE" as const }],
    };
    const stored = {
      bundleId: binding.bundleId,
      phase: "ACTIVE" as const,
      context: {
        projectId: project.id,
        runId: binding.runId,
        activationMode: "FIRST_LINEAGE" as const,
        externalSessionId: `claude-channel:cci_${"a".repeat(32)}`,
        externalThreadId: null,
      },
      rawControl: "c".repeat(43),
      offerId: "stk_attach",
      activationAttempted: true,
      binding,
      rotationReceipt: null,
      serverNow: new Date().toISOString(),
      observedAt: new Date().toISOString(),
    };
    const ticketRuntime = {
      pendingEnrollment: vi.fn(async () => null),
      currentActive: vi.fn(async () => null),
      prepareInitial: vi.fn(async () => ({ ...stored, phase: "OFFERED" as const })),
      registerInitial: vi.fn(async (input: Record<string, unknown>) => ({
        registration: {
          session: await (
            hub as { registerSession(projectId: string, input: unknown): Promise<unknown> }
          ).registerSession(project.id, input),
          ticketBinding: binding,
          serverNow: new Date().toISOString(),
        },
        active: { stored, rawControl: stored.rawControl, controlHub: hub },
      })),
      activateSuccessor: vi.fn(async () => {
        throw new Error("unexpected renewal");
      }),
      commitSuccessor: vi.fn(async () => undefined),
      discardNonActiveEnrollment: vi.fn(async () => undefined),
      discardRejectedEnrollment: vi.fn(async () => undefined),
      discardActiveLineage: vi.fn(async () => undefined),
    };
    const channel = new ClaudeChannel(
      {
        cwd: PROVISIONAL_CWD,
        bootstrapToken: "bootstrap-test",
        installationId: `cci_${"a".repeat(32)}`,
        ticketVault: { load: async () => null, save: async () => undefined },
        authorityTrustManifest,
        agentId: "claude",
        connectWebSocket: false,
      },
      { bootstrapHub: hub as never, ticketRuntime: ticketRuntime as never },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "claude-test", version: "1.0.0" });
    return { channel, client, clientTransport, serverTransport };
  };

  it("answers tools/list while the Hub is still refusing connections, then attaches", async () => {
    const { hub, state } = makeFlakyHub();
    const { channel, client, clientTransport, serverTransport } = serve(hub);
    await Promise.all([channel.connect(serverTransport), client.connect(clientTransport)]);

    const attached = attachToHub(channel, {
      resolveCwd: async () => HUB_ROOT,
      delayMs: () => 1,
    });

    // The whole point: usable tools with no Hub behind them yet.
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toContain("check_inbox");
    expect(state.joinAttempts).toBeGreaterThan(0);
    expect(channel.state.sessionId).toBeUndefined();

    state.up = true;
    await attached;

    expect(channel.state.sessionId).toBe("ses_1234");
    // Joined by the root the Hub reported, not the directory this process started in -- otherwise a
    // --project-id channel would silently bind to whatever the client's cwd happened to be.
    expect(hub.joinProject).toHaveBeenLastCalledWith(expect.objectContaining({ cwd: HUB_ROOT }));
    expect(hub.registerSession).toHaveBeenLastCalledWith(
      project.id,
      expect.objectContaining({ cwd: HUB_ROOT }),
    );
    await channel.stop();
  });

  it("gives up and reports the failure rather than retrying forever when told to", async () => {
    const { hub } = makeFlakyHub();
    const { channel, client, clientTransport, serverTransport } = serve(hub);
    await Promise.all([channel.connect(serverTransport), client.connect(clientTransport)]);
    const retries: number[] = [];

    await expect(
      attachToHub(channel, {
        resolveCwd: async () => HUB_ROOT,
        delayMs: () => 1,
        maxAttempts: 3,
        onRetry: (_error, attempt) => retries.push(attempt),
      }),
    ).rejects.toThrow(/ECONNREFUSED/);

    // Two waits between three attempts; the last failure is reported by rejecting, not by sleeping.
    expect(retries).toEqual([1, 2]);
    await channel.stop();
  });

  it("backs off and caps, so a Hub that never comes up is not hammered", () => {
    expect(defaultRetryDelayMs(1)).toBe(1_000);
    expect(defaultRetryDelayMs(2)).toBe(2_000);
    expect(defaultRetryDelayMs(3)).toBe(4_000);
    // Capped: a Hub that is never started costs one attempt every 30s, not a busy loop for as long
    // as the client stays open.
    expect(defaultRetryDelayMs(20)).toBe(30_000);
  });

  it("backs off and retries a state-dependent rejected bootstrap or ticket credential", async () => {
    const channel = {
      startHubSession: vi.fn(async () => {
        throw new HubHttpError(403, { code: "FORBIDDEN", message: "revoked" });
      }),
    };
    const onRetry = vi.fn();

    await expect(
      attachToHub(channel as never, {
        resolveCwd: async () => HUB_ROOT,
        delayMs: () => 1,
        maxAttempts: 3,
        onRetry,
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(channel.startHubSession).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it.each([
    [400, "BAD_REQUEST"],
    [404, "NOT_FOUND"],
  ])("does not spin on a permanently invalid attach response %i", async (status, code) => {
    const channel = {
      startHubSession: vi.fn(async () => {
        throw new HubHttpError(status, { code, message: "permanent attach failure" });
      }),
    };
    const onRetry = vi.fn();

    await expect(
      attachToHub(channel as never, {
        resolveCwd: async () => HUB_ROOT,
        delayMs: () => 1,
        onRetry,
      }),
    ).rejects.toMatchObject({ status });
    expect(channel.startHubSession).toHaveBeenCalledOnce();
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("reports a fault in this code instead of retrying it for the life of the process", async () => {
    const channel = {
      startHubSession: vi.fn(async () => {
        // What a genuine bug looks like from here. Retrying it forever would leave the tools
        // listed and permanently unconnected, with nothing ever reported.
        throw new TypeError("channel.startHubSession is not a function");
      }),
    };
    const onRetry = vi.fn();

    await expect(
      attachToHub(channel as never, {
        resolveCwd: async () => HUB_ROOT,
        delayMs: () => 1,
        onRetry,
      }),
    ).rejects.toThrow("is not a function");
    expect(channel.startHubSession).toHaveBeenCalledOnce();
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("still retries a refused connection, which reaches us as a TypeError with a cause", async () => {
    const channel = {
      startHubSession: vi
        .fn()
        .mockRejectedValueOnce(
          Object.assign(new TypeError("fetch failed"), {
            cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:4387"), {
              code: "ECONNREFUSED",
            }),
          }),
        )
        .mockResolvedValueOnce(undefined),
    };
    const onRetry = vi.fn();

    await attachToHub(channel as never, {
      resolveCwd: async () => HUB_ROOT,
      delayMs: () => 1,
      onRetry,
    });
    expect(channel.startHubSession).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledOnce();
  });
});
