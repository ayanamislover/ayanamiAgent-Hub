import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession, SessionTicketBinding } from "@crossagent/protocol";
import {
  ClaudeSessionTicketRuntime,
  FileClaudeSessionTicketVault,
} from "../src/session-ticket-runtime.js";

const roots: string[] = [];
const now = "2026-08-01T00:00:00.000Z";
const installationId = `cci_${"a".repeat(32)}`;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function vault() {
  const root = await mkdtemp(join(tmpdir(), "crossagent-claude-ticket-"));
  roots.push(root);
  const path = join(root, "tickets.json");
  return { path, vault: new FileClaudeSessionTicketVault(path) };
}

function session(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: "ses_current",
    projectId: "prj_ticket",
    agentId: "claude",
    role: "primary",
    client: "claude-channel",
    transport: "websocket",
    deliveryMode: "native_channel",
    externalSessionId: `claude-channel:${installationId}`,
    externalThreadId: null,
    externalTurnId: null,
    host: "test",
    pid: 1,
    cwd: "R:\\fixture",
    gitBranch: null,
    gitHead: null,
    capabilities: [],
    connectedAt: now,
    transportLastSeenAt: now,
    activityLastSeenAt: now,
    workState: "IDLE",
    connectionState: "ONLINE",
    currentTaskId: null,
    currentReviewId: null,
    activeFiles: [],
    queueDepth: 0,
    predecessorSessionId: null,
    supersededBySessionId: null,
    lineageId: "lin_current",
    incarnation: 1,
    launcherRunId: "run_current",
    launchGeneration: null,
    version: 1,
    ...overrides,
  };
}

function binding(bundleId: string): SessionTicketBinding {
  return {
    bundleId,
    state: "ACTIVE",
    projectId: "prj_ticket",
    agentId: "claude",
    adapterClient: "claude",
    hubSessionId: "ses_current",
    lineageId: "lin_current",
    incarnation: 1,
    runId: "run_current",
    activatedAt: now,
    expiresAt: "2026-08-02T00:00:00.000Z",
    purposes: [{ id: `stk_${bundleId}`, purpose: "CONTROL", state: "ACTIVE" }],
  };
}

function fakeHubs(serverNow: () => string = () => now) {
  const controlClients = new Map<string, Record<string, ReturnType<typeof vi.fn>>>();
  let activeBundleId = "";
  const bootstrap = {
    createSessionTicketOffer: vi.fn(async (_projectId: string, input: Record<string, unknown>) => ({
      id: `stk_${String(input.bundle_id)}`,
      ...input,
      state: "PENDING",
      project_id: "prj_ticket",
      offer_expires_at: "2026-08-01T00:10:00.000Z",
    })),
    withToken: vi.fn((raw: string) => {
      const existing = controlClients.get(raw);
      if (existing) return existing;
      const hub = {
        registerAdapterSession: vi.fn(
          async (_projectId: string, input: Record<string, unknown>) => {
            activeBundleId = String(input.ticket_bundle_id);
            return {
              session: session(),
              ticketBinding: binding(activeBundleId),
              serverNow: serverNow(),
            };
          },
        ),
        createSessionTicketOffer: vi.fn(
          async (_projectId: string, input: Record<string, unknown>) => ({
            id: `stk_${String(input.bundle_id)}`,
            ...input,
            state: "PENDING",
            project_id: "prj_ticket",
            offer_expires_at: "2026-08-01T00:10:00.000Z",
          }),
        ),
        rotateAdapterSessionTickets: vi.fn(
          async (_sessionId: string, successorBundleId: string) => ({
            session: session(),
            ticketBinding: binding(successorBundleId),
            supersededTicketBinding: {
              ...binding(activeBundleId),
              state: "SUPERSEDED",
              terminalAt: now,
              terminalReason: `superseded by ${successorBundleId}`,
              purposes: [
                {
                  id: `stk_${activeBundleId}`,
                  purpose: "CONTROL",
                  state: "SUPERSEDED",
                  terminalAt: now,
                  terminalReason: `superseded by ${successorBundleId}`,
                },
              ],
            },
            serverNow: serverNow(),
          }),
        ),
      };
      controlClients.set(raw, hub);
      return hub;
    }),
  };
  return { bootstrap, controlClients };
}

describe("ClaudeSessionTicketRuntime", () => {
  it("offers only CONTROL, persists the ambiguous activation before I/O, and never serializes raw", async () => {
    const storage = await vault();
    const { bootstrap } = fakeHubs();
    const runtime = new ClaudeSessionTicketRuntime({
      bootstrapHub: bootstrap as never,
      vault: storage.vault,
      now: () => new Date(now),
    });
    const prepared = await runtime.prepareInitial({
      projectId: "prj_ticket",
      runId: "run_current",
      activationMode: "FIRST_LINEAGE",
      externalSessionId: `claude-channel:${installationId}`,
      externalThreadId: null,
    });

    expect(bootstrap.createSessionTicketOffer).toHaveBeenCalledOnce();
    expect(bootstrap.createSessionTicketOffer).toHaveBeenCalledWith(
      "prj_ticket",
      expect.objectContaining({ purpose: "CONTROL", session_client: "claude-channel" }),
    );
    const wire = JSON.stringify(bootstrap.createSessionTicketOffer.mock.calls);
    expect(wire).not.toContain(prepared.rawControl);
    const disk = await readFile(storage.path, "utf8");
    expect(disk).toContain(prepared.rawControl);
  });

  it("clears an exact rejected replacement together with its now-unusable ACTIVE predecessor", async () => {
    const storage = await vault();
    const { bootstrap } = fakeHubs();
    const runtime = new ClaudeSessionTicketRuntime({
      bootstrapHub: bootstrap as never,
      vault: storage.vault,
      now: () => new Date(now),
    });
    await runtime.prepareInitial({
      projectId: "prj_ticket",
      runId: "run_current",
      activationMode: "FIRST_LINEAGE",
      externalSessionId: `claude-channel:${installationId}`,
      externalThreadId: null,
    });
    await runtime.registerInitial({
      agentId: "claude",
      role: "primary",
      client: "claude-channel",
      transport: "websocket",
      deliveryMode: "native_channel",
      externalSessionId: `claude-channel:${installationId}`,
      host: "test",
      pid: 1,
      cwd: "R:\\fixture",
      capabilities: [],
      expectedHeadSessionId: null,
      idempotencyKey: "register:first",
    });
    const replacement = {
      projectId: "prj_ticket",
      runId: "run_replacement",
      activationMode: "CURRENT_HEAD_REPLACEMENT" as const,
      externalSessionId: `claude-channel:${installationId}`,
      externalThreadId: null,
      expectedLineageId: "lin_current",
      expectedHeadSessionId: "ses_current",
    };
    await runtime.prepareInitial(replacement);

    const before = await storage.vault.load();
    expect(before?.current?.phase).toBe("ACTIVE");
    expect(before?.successor?.context).toEqual(replacement);
    await expect(
      runtime.discardRejectedEnrollment({ ...replacement, runId: "run_wrong" }),
    ).rejects.toThrow(/exact rejected/iu);
    expect((await storage.vault.load())?.current?.phase).toBe("ACTIVE");
    await runtime.discardRejectedEnrollment(replacement);
    expect(await storage.vault.load()).toEqual({
      schemaVersion: 1,
      current: null,
      successor: null,
    });
  });

  it("clears only an exact ACTIVE lineage identity after a terminal close", async () => {
    const storage = await vault();
    const { bootstrap } = fakeHubs();
    const runtime = new ClaudeSessionTicketRuntime({
      bootstrapHub: bootstrap as never,
      vault: storage.vault,
      now: () => new Date(now),
    });
    const prepared = await runtime.prepareInitial({
      projectId: "prj_ticket",
      runId: "run_current",
      activationMode: "FIRST_LINEAGE",
      externalSessionId: `claude-channel:${installationId}`,
      externalThreadId: null,
    });
    await runtime.registerInitial({
      agentId: "claude",
      role: "primary",
      client: "claude-channel",
      transport: "websocket",
      deliveryMode: "native_channel",
      externalSessionId: `claude-channel:${installationId}`,
      host: "test",
      pid: 1,
      cwd: "R:\\fixture",
      capabilities: [],
      expectedHeadSessionId: null,
      idempotencyKey: "register:first",
    });

    await expect(runtime.discardActiveLineage("stb_wrong")).rejects.toThrow(/exact ACTIVE/iu);
    expect((await storage.vault.load())?.current?.bundleId).toBe(prepared.bundleId);
    await runtime.discardActiveLineage(prepared.bundleId);
    expect(await storage.vault.load()).toEqual({
      schemaVersion: 1,
      current: null,
      successor: null,
    });
  });

  it("replays a terminal predecessor exactly after a lost rotation response", async () => {
    const storage = await vault();
    const { bootstrap, controlClients } = fakeHubs();
    const runtime = new ClaudeSessionTicketRuntime({
      bootstrapHub: bootstrap as never,
      vault: storage.vault,
      now: () => new Date(now),
    });
    await runtime.prepareInitial({
      projectId: "prj_ticket",
      runId: "run_current",
      activationMode: "FIRST_LINEAGE",
      externalSessionId: `claude-channel:${installationId}`,
      externalThreadId: null,
    });
    const initial = await runtime.registerInitial({
      agentId: "claude",
      role: "primary",
      client: "claude-channel",
      transport: "websocket",
      deliveryMode: "native_channel",
      externalSessionId: `claude-channel:${installationId}`,
      host: "test",
      pid: 1,
      cwd: "R:\\fixture",
      capabilities: [],
      expectedHeadSessionId: null,
      idempotencyKey: "register:first",
    });
    const oldRaw = initial.active.rawControl;
    const oldHub = controlClients.get(oldRaw)!;
    const rotateTickets = oldHub.rotateAdapterSessionTickets;
    if (!rotateTickets) throw new Error("rotation mock expected");
    rotateTickets.mockImplementationOnce(async (...args: unknown[]) => {
      throw new TypeError(`response lost for ${String(args[1])}`);
    });

    await expect(runtime.activateSuccessor(session(), "rotate:stb_current")).rejects.toThrow(
      /response lost/iu,
    );
    const restarted = new ClaudeSessionTicketRuntime({
      bootstrapHub: bootstrap as never,
      vault: storage.vault,
      now: () => new Date(now),
    });
    const result = await restarted.activateSuccessor(session(), "rotate:stb_current");

    expect(rotateTickets).toHaveBeenCalledTimes(2);
    expect(rotateTickets.mock.calls[0]).toEqual(rotateTickets.mock.calls[1]);
    expect(result.previous.rawControl).toBe(oldRaw);
    expect(result.next.rawControl).not.toBe(oldRaw);
  });

  it("persists a fresh Hub clock after replaying a 23-hour-old lost rotation response", async () => {
    const storage = await vault();
    let responseNow = now;
    const { bootstrap, controlClients } = fakeHubs(() => responseNow);
    const runtime = new ClaudeSessionTicketRuntime({
      bootstrapHub: bootstrap as never,
      vault: storage.vault,
      now: () => new Date(responseNow),
    });
    await runtime.prepareInitial({
      projectId: "prj_ticket",
      runId: "run_current",
      activationMode: "FIRST_LINEAGE",
      externalSessionId: `claude-channel:${installationId}`,
      externalThreadId: null,
    });
    const initial = await runtime.registerInitial({
      agentId: "claude",
      role: "primary",
      client: "claude-channel",
      transport: "websocket",
      deliveryMode: "native_channel",
      externalSessionId: `claude-channel:${installationId}`,
      host: "test",
      pid: 1,
      cwd: "R:\\fixture",
      capabilities: [],
      expectedHeadSessionId: null,
      idempotencyKey: "register:first",
    });
    const rotateTickets = controlClients.get(
      initial.active.rawControl,
    )!.rotateAdapterSessionTickets;
    if (!rotateTickets) throw new Error("rotation mock expected");
    rotateTickets.mockImplementationOnce(async () => {
      throw new TypeError("response lost after Hub commit");
    });

    await expect(runtime.activateSuccessor(session(), "rotate:delayed")).rejects.toThrow(
      /response lost/iu,
    );
    responseNow = "2026-08-01T23:00:00.000Z";
    const restarted = new ClaudeSessionTicketRuntime({
      bootstrapHub: bootstrap as never,
      vault: storage.vault,
      now: () => new Date(responseNow),
    });
    const replayed = await restarted.activateSuccessor(session(), "rotate:delayed");

    expect(replayed.next.stored.serverNow).toBe(responseNow);
    expect(replayed.next.stored.observedAt).toBe(responseNow);
    expect(replayed.next.stored.binding.expiresAt).toBe("2026-08-02T00:00:00.000Z");
  });

  it("uses current CONTROL for CURRENT_HEAD but bootstrap for exact MANAGED enrollment", async () => {
    const currentStorage = await vault();
    const { bootstrap, controlClients } = fakeHubs();
    const runtime = new ClaudeSessionTicketRuntime({
      bootstrapHub: bootstrap as never,
      vault: currentStorage.vault,
      now: () => new Date(now),
    });
    await runtime.prepareInitial({
      projectId: "prj_ticket",
      runId: "run_current",
      activationMode: "FIRST_LINEAGE",
      externalSessionId: `claude-channel:${installationId}`,
      externalThreadId: null,
    });
    const registered = await runtime.registerInitial({
      agentId: "claude",
      role: "primary",
      client: "claude-channel",
      transport: "websocket",
      deliveryMode: "native_channel",
      externalSessionId: `claude-channel:${installationId}`,
      host: "test",
      pid: 1,
      cwd: "R:\\fixture",
      capabilities: [],
      expectedHeadSessionId: null,
      idempotencyKey: "register:first",
    });
    const currentHub = controlClients.get(registered.active.rawControl)!;
    bootstrap.createSessionTicketOffer.mockClear();
    await runtime.prepareInitial({
      projectId: "prj_ticket",
      runId: "run_replacement",
      activationMode: "CURRENT_HEAD_REPLACEMENT",
      externalSessionId: `claude-channel:${installationId}`,
      externalThreadId: null,
      expectedLineageId: "lin_current",
      expectedHeadSessionId: "ses_current",
    });

    expect(currentHub.createSessionTicketOffer).toHaveBeenCalledWith(
      "prj_ticket",
      expect.objectContaining({
        purpose: "CONTROL",
        activation_mode: "CURRENT_HEAD_REPLACEMENT",
        expected_lineage_id: "lin_current",
        expected_head_session_id: "ses_current",
      }),
    );
    expect(bootstrap.createSessionTicketOffer).not.toHaveBeenCalled();

    const managedStorage = await vault();
    const managedHubs = fakeHubs();
    const managed = new ClaudeSessionTicketRuntime({
      bootstrapHub: managedHubs.bootstrap as never,
      vault: managedStorage.vault,
      now: () => new Date(now),
    });
    await managed.prepareInitial({
      projectId: "prj_ticket",
      runId: "run_managed",
      activationMode: "MANAGED_RESERVATION",
      externalSessionId: `claude-channel:${installationId}`,
      externalThreadId: null,
      expectedLineageId: "lin_current",
      expectedHeadSessionId: "ses_current",
      launchReservationId: "slr_current",
      launchGeneration: 2,
    });
    expect(managedHubs.bootstrap.createSessionTicketOffer).toHaveBeenCalledWith(
      "prj_ticket",
      expect.objectContaining({
        purpose: "CONTROL",
        activation_mode: "MANAGED_RESERVATION",
        launch_reservation_id: "slr_current",
      }),
    );
  });
});
