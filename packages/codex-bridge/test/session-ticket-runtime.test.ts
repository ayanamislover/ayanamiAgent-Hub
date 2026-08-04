import { describe, expect, it, vi } from "vitest";
import type {
  AgentSession,
  RotateAdapterSessionTicketsResult,
  SessionTicketPurpose,
} from "@crossagent/protocol";
import {
  CodexSessionTicketRuntime,
  codexModelTransportConfiguration,
  parseCodexSessionOperationalCheckpoint,
  parseCodexSessionTicketVaultSnapshot,
  type CodexSessionOperationalCheckpoint,
  type CodexSessionOperationalCheckpointStore,
  type CodexSessionTicketVault,
  type CodexSessionTicketVaultSnapshot,
  type ActiveCodexSessionTicketBundle,
  type StoredCodexSessionTicketBundle,
} from "../src/session-ticket-runtime.js";

const AT = "2026-08-01T04:00:00.000Z";
const EXPIRES = "2026-08-02T04:00:00.000Z";
const raw = (letter: string) => letter.repeat(43);

class MemoryVault implements CodexSessionTicketVault {
  value: CodexSessionTicketVaultSnapshot | null = null;
  readonly writes: CodexSessionTicketVaultSnapshot[] = [];
  failNextSave = false;

  async load(): Promise<CodexSessionTicketVaultSnapshot | null> {
    return this.value ? structuredClone(this.value) : null;
  }

  async save(snapshot: CodexSessionTicketVaultSnapshot): Promise<void> {
    if (this.failNextSave) {
      this.failNextSave = false;
      throw new TypeError("simulated durable save failure");
    }
    this.value = structuredClone(snapshot);
    this.writes.push(structuredClone(snapshot));
  }
}

class MemoryCheckpointStore implements CodexSessionOperationalCheckpointStore {
  value: CodexSessionOperationalCheckpoint | null = null;
  readonly writes: CodexSessionOperationalCheckpoint[] = [];
  failNextSave = false;
  failNextMatchingSave: ((checkpoint: CodexSessionOperationalCheckpoint) => boolean) | null = null;

  async load(): Promise<CodexSessionOperationalCheckpoint | null> {
    return this.value ? structuredClone(this.value) : null;
  }

  async save(checkpoint: CodexSessionOperationalCheckpoint): Promise<void> {
    if (this.failNextSave || this.failNextMatchingSave?.(checkpoint)) {
      this.failNextSave = false;
      this.failNextMatchingSave = null;
      throw new TypeError("simulated checkpoint save failure");
    }
    this.value = structuredClone(checkpoint);
    this.writes.push(structuredClone(checkpoint));
  }
}

function session(): AgentSession {
  return {
    id: "ses_codex",
    projectId: "prj_codex",
    agentId: "codex",
    role: "primary",
    client: "codex-app-server",
    transport: "websocket",
    deliveryMode: "app_server_push",
    externalSessionId: "desktop-session",
    externalThreadId: "thr_codex",
    externalTurnId: null,
    host: "localhost",
    pid: 1234,
    cwd: "C:\\work\\crossagent-hub",
    gitBranch: null,
    gitHead: null,
    capabilities: [],
    connectedAt: AT,
    transportLastSeenAt: AT,
    activityLastSeenAt: null,
    currentTaskId: null,
    currentReviewId: null,
    activeFiles: [],
    workState: "IDLE",
    connectionState: "ONLINE",
    queueDepth: 0,
    lineageId: "lin_codex",
    incarnation: 1,
    predecessorSessionId: null,
    supersededBySessionId: null,
    launcherRunId: null,
    launchGeneration: null,
    version: 1,
  };
}

function requestBody(init?: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

function bearer(init?: RequestInit): string | null {
  return new Headers(init?.headers).get("authorization");
}

function activeBinding(
  bundleId: string,
  offerIds: Record<SessionTicketPurpose, string>,
  runId = "run_codex",
) {
  return {
    bundleId,
    state: "ACTIVE" as const,
    projectId: "prj_codex",
    agentId: "codex" as const,
    adapterClient: "codex" as const,
    hubSessionId: "ses_codex",
    lineageId: "lin_codex",
    incarnation: 1,
    runId,
    activatedAt: AT,
    expiresAt: EXPIRES,
    purposes: (["CONTROL", "INJECTOR", "MODEL_MCP"] as const).map((purpose) => ({
      id: offerIds[purpose],
      purpose,
      state: "ACTIVE" as const,
    })),
  };
}

function activeStoredBundle(
  bundleId: string,
  ticketLetter: string,
  activationMode: StoredCodexSessionTicketBundle["context"]["activationMode"] = "FIRST_LINEAGE",
): StoredCodexSessionTicketBundle {
  const bindingOfferIds = {
    CONTROL: `stk_${bundleId}_control`,
    MODEL_MCP: `stk_${bundleId}_model`,
    INJECTOR: `stk_${bundleId}_injector`,
    CAPTURE: "stk_unused",
  };
  return {
    bundleId,
    phase: "ACTIVE",
    launchContext: {
      projectId: "prj_codex",
      runId: "run_codex",
      activationMode: "FIRST_LINEAGE",
      externalSessionId: "desktop-session",
      externalThreadId: "thr_codex",
    },
    context: {
      projectId: "prj_codex",
      runId: "run_codex",
      activationMode,
      externalSessionId: "desktop-session",
      externalThreadId: "thr_codex",
      ...(activationMode === "SESSION_AUXILIARY"
        ? { expectedLineageId: "lin_codex", expectedHeadSessionId: "ses_codex" }
        : {}),
    },
    raw: {
      CONTROL: raw(ticketLetter),
      MODEL_MCP: raw(ticketLetter.toLowerCase()),
      INJECTOR: raw(
        ticketLetter === "Z" ? "Y" : String.fromCharCode(ticketLetter.charCodeAt(0) + 1),
      ),
    },
    offerIds: {
      CONTROL: bindingOfferIds.CONTROL,
      MODEL_MCP: bindingOfferIds.MODEL_MCP,
      INJECTOR: bindingOfferIds.INJECTOR,
    },
    activationAttempted: true,
    binding: activeBinding(bundleId, bindingOfferIds),
    rotationReceipt: null,
    sessionReceipt: session(),
    launchSessionId: "ses_codex",
    serverNow: AT,
    observedAt: AT,
    registrationInput: {
      agentId: "codex",
      role: "primary",
      client: "codex-app-server",
      transport: "websocket",
      deliveryMode: "app_server_push",
      externalSessionId: "desktop-session",
      externalThreadId: "thr_codex",
      host: "localhost",
      pid: 1234,
      cwd: "C:\\work\\crossagent-hub",
      capabilities: [],
      idempotencyKey: `register:${bundleId}`,
    },
  };
}

describe("CodexSessionTicketRuntime", () => {
  it("commits MODEL_CONFIGURED_OFFLINE as a durable sibling of MODEL_READY", async () => {
    const vault = new MemoryVault();
    const checkpointStore = new MemoryCheckpointStore();
    const current = activeStoredBundle("stb_current", "A");
    const successor = activeStoredBundle("stb_successor", "D", "SESSION_AUXILIARY");
    vault.value = {
      schemaVersion: 1,
      current,
      successor,
      cutover: {
        kind: "SESSION_AUXILIARY",
        predecessorBundleId: current.bundleId,
        successorBundleId: successor.bundleId,
        predecessorSessionId: "ses_codex",
        successorSessionId: "ses_codex",
        operationId: "renew:offline",
        phase: "HUB_ACTIVATED",
        updatedAt: AT,
      },
    };
    checkpointStore.value = {
      schemaVersion: 1,
      projectId: "prj_codex",
      threadId: "thr_codex",
      ownerRunId: "run_codex",
      eventSequence: 3,
      pendingMessageIds: [],
      session: {
        hubSessionId: "ses_codex",
        lineageId: "lin_codex",
        incarnation: 1,
        bundleId: successor.bundleId,
        nextHeartbeatSequence: 4,
      },
      updatedAt: AT,
    };
    const runtime = new CodexSessionTicketRuntime({
      baseUrl: "http://hub.test",
      bootstrapAgentToken: "agent-bootstrap",
      bootstrapInjectorToken: "injector-bootstrap",
      vault,
      checkpointStore,
      fetch: vi.fn() as unknown as typeof fetch,
      now: () => new Date(AT),
    });

    await runtime.markCutoverPhase(successor.bundleId, "CONTROL_READY");
    await runtime.markCutoverPhase(successor.bundleId, "MODEL_CONFIGURED_OFFLINE", 7);
    await expect(runtime.markCutoverPhase(successor.bundleId, "MODEL_READY")).rejects.toThrow(
      "cannot change model branch",
    );
    await runtime.markCutoverPhase(successor.bundleId, "EVENTS_READY");
    await runtime.commitSuccessor(successor.bundleId);

    expect(vault.value).toMatchObject({
      successor: null,
      cutover: null,
      current: {
        bundleId: successor.bundleId,
        modelTransportState: "MODEL_CONFIGURED_OFFLINE",
        modelTransportFuseGeneration: 7,
      },
    });
    await runtime.markActiveModelTransportReady(successor.bundleId);
    expect(vault.value!.current!.modelTransportState).toBe("MODEL_READY");
    expect(vault.value!.current!.modelTransportFuseGeneration).toBe(7);
  });

  it("parses legacy bundles without a model state as MODEL_READY", () => {
    const legacy = activeStoredBundle("stb_legacy", "L") as StoredCodexSessionTicketBundle & {
      modelTransportState?: string;
    };
    delete legacy.modelTransportState;

    const parsed = parseCodexSessionTicketVaultSnapshot({
      schemaVersion: 1,
      current: legacy,
      successor: null,
      cutover: null,
    }).current!;
    expect(parsed).not.toHaveProperty("modelTransportState");
    expect(codexModelTransportConfiguration(parsed)).toBe("MODEL_READY");
  });

  it("keeps raw tickets local and offers INJECTOR through its independent bootstrap", async () => {
    const vault = new MemoryVault();
    const offers = new Map<SessionTicketPurpose, { auth: string | null; body: string }>();
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://hub.test/api/projects/prj_codex/session-ticket-offers");
      const bodyText = String(init?.body);
      const body = requestBody(init);
      const purpose = body.purpose as SessionTicketPurpose;
      offers.set(purpose, { auth: bearer(init), body: bodyText });
      return Response.json({
        id: `stk_${purpose.toLowerCase()}`,
        bundle_id: body.bundle_id,
        purpose,
        state: "PENDING",
        project_id: "prj_codex",
        adapter_client: "codex",
        agent_id: "codex",
        session_client: "codex-app-server",
        role: "primary",
        transport: "websocket",
        delivery_mode: "app_server_push",
        external_session_id: body.external_session_id,
        external_thread_id: body.external_thread_id,
        run_id: "run_codex",
        offer_expires_at: "2026-08-01T04:10:00.000Z",
      });
    });
    const runtime = new CodexSessionTicketRuntime({
      baseUrl: "http://hub.test",
      bootstrapAgentToken: "agent-bootstrap",
      bootstrapInjectorToken: "injector-bootstrap",
      vault,
      checkpointStore: new MemoryCheckpointStore(),
      fetch: fetchMock as typeof fetch,
    });

    const prepared = await runtime.prepareInitial({
      projectId: "prj_codex",
      runId: "run_codex",
      activationMode: "FIRST_LINEAGE",
      externalSessionId: "desktop-session",
      externalThreadId: "thr_codex",
    });

    expect(prepared.phase).toBe("OFFERED");
    expect(offers.get("CONTROL")?.auth).toBe("Bearer agent-bootstrap");
    expect(offers.get("MODEL_MCP")?.auth).toBe("Bearer agent-bootstrap");
    expect(offers.get("INJECTOR")?.auth).toBe("Bearer injector-bootstrap");
    for (const offered of offers.values()) {
      expect(offered.body).not.toContain(prepared.raw.CONTROL);
      expect(offered.body).not.toContain(prepared.raw.MODEL_MCP);
      expect(offered.body).not.toContain(prepared.raw.INJECTOR);
      expect(JSON.parse(offered.body)).not.toHaveProperty("raw_token");
    }
  });

  it("recovers offer and initial registration lost responses with exact replay keys", async () => {
    const vault = new MemoryVault();
    const offerRequests: Array<Record<string, unknown>> = [];
    const registrationRequests: Array<Record<string, unknown>> = [];
    const ids = {} as Record<SessionTicketPurpose, string>;
    let loseOfferResponse = true;
    let loseRegistrationResponse = true;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const body = requestBody(init);
      if (url.endsWith("/session-ticket-offers")) {
        offerRequests.push(structuredClone(body));
        const purpose = body.purpose as SessionTicketPurpose;
        ids[purpose] = `stk_${purpose.toLowerCase()}`;
        if (purpose === "CONTROL" && loseOfferResponse) {
          loseOfferResponse = false;
          throw new TypeError("offer response lost after commit");
        }
        return Response.json({
          id: ids[purpose],
          bundle_id: body.bundle_id,
          purpose,
          state: "PENDING",
          project_id: "prj_codex",
          adapter_client: "codex",
          agent_id: "codex",
          session_client: "codex-app-server",
          role: "primary",
          transport: "websocket",
          delivery_mode: "app_server_push",
          external_session_id: body.external_session_id,
          external_thread_id: body.external_thread_id,
          run_id: "run_codex",
          offer_expires_at: "2026-08-01T04:10:00.000Z",
        });
      }
      if (url.endsWith("/api/projects/prj_codex/sessions")) {
        registrationRequests.push(structuredClone(body));
        const response = {
          session: session(),
          ticketBinding: activeBinding(String(body.ticket_bundle_id), ids),
          serverNow: AT,
        };
        if (loseRegistrationResponse) {
          loseRegistrationResponse = false;
          throw new TypeError("registration response lost after commit");
        }
        return Response.json(response);
      }
      throw new Error(`unexpected request ${url}`);
    });
    const options = {
      baseUrl: "http://hub.test",
      bootstrapAgentToken: "agent-bootstrap",
      bootstrapInjectorToken: "injector-bootstrap",
      vault,
      checkpointStore: new MemoryCheckpointStore(),
      fetch: fetchMock as typeof fetch,
    };
    const context = {
      projectId: "prj_codex",
      runId: "run_codex",
      activationMode: "FIRST_LINEAGE" as const,
      externalSessionId: "desktop-session",
      externalThreadId: "thr_codex",
    };
    await expect(new CodexSessionTicketRuntime(options).prepareInitial(context)).rejects.toThrow(
      "offer response lost after commit",
    );
    const prepared = await new CodexSessionTicketRuntime(options).prepareInitial(context);
    expect(offerRequests[0]).toEqual(offerRequests[1]);
    expect(prepared.phase).toBe("OFFERED");

    const registerInput = {
      agentId: "codex",
      role: "primary" as const,
      client: "codex-app-server" as const,
      transport: "websocket" as const,
      deliveryMode: "app_server_push" as const,
      externalSessionId: "desktop-session",
      externalThreadId: "thr_codex",
      host: "localhost",
      pid: 1234,
      cwd: "C:\\work\\crossagent-hub",
      capabilities: [],
      idempotencyKey: "register:stable",
    };
    await expect(
      new CodexSessionTicketRuntime(options).registerInitial(registerInput),
    ).rejects.toThrow("registration response lost after commit");
    const recovered = await new CodexSessionTicketRuntime(options).registerInitial(registerInput);
    expect(registrationRequests).toHaveLength(2);
    expect(registrationRequests[0]).toEqual(registrationRequests[1]);
    expect(recovered.active.stored.bundleId).toBe(prepared.bundleId);
  });

  it("replays one ambiguous activation with the same bundle and operation receipt", async () => {
    const vault = new MemoryVault();
    const offerIds = new Map<string, Record<SessionTicketPurpose, string>>();
    const activationBodies: Record<string, unknown>[] = [];
    let committedRotation: RotateAdapterSessionTicketsResult | null = null;
    let loseFirstRotationResponse = true;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const body = requestBody(init);
      if (url.endsWith("/session-ticket-offers")) {
        const bundle = String(body.bundle_id);
        const purpose = body.purpose as SessionTicketPurpose;
        const ids = offerIds.get(bundle) ?? ({} as Record<SessionTicketPurpose, string>);
        ids[purpose] = `stk_${bundle}_${purpose.toLowerCase()}`;
        offerIds.set(bundle, ids);
        return Response.json({
          id: ids[purpose],
          bundle_id: bundle,
          purpose,
          state: "PENDING",
          project_id: "prj_codex",
          adapter_client: "codex",
          agent_id: "codex",
          session_client: "codex-app-server",
          role: "primary",
          transport: "websocket",
          delivery_mode: "app_server_push",
          external_session_id: body.external_session_id,
          external_thread_id: body.external_thread_id,
          run_id: "run_codex",
          offer_expires_at: "2026-08-01T04:10:00.000Z",
        });
      }
      if (url.endsWith("/api/projects/prj_codex/sessions")) {
        const bundle = String(body.ticket_bundle_id);
        return Response.json({
          session: session(),
          ticketBinding: activeBinding(bundle, offerIds.get(bundle)!),
          serverNow: AT,
        });
      }
      if (url.includes("/session-ticket-bundles/") && url.endsWith("/activate")) {
        activationBodies.push(body);
        const bundle = decodeURIComponent(url.split("/session-ticket-bundles/")[1]!.split("/")[0]!);
        const old = vault.value!.current!;
        const oldBinding = old.binding!;
        const terminalAt = "2026-08-01T04:30:00.000Z";
        committedRotation ??= {
          session: session(),
          ticketBinding: {
            ...activeBinding(bundle, offerIds.get(bundle)!),
            activatedAt: terminalAt,
            expiresAt: "2026-08-02T04:30:00.000Z",
          },
          supersededTicketBinding: {
            ...oldBinding,
            state: "SUPERSEDED",
            terminalAt,
            terminalReason: "SESSION_TICKET_ROTATED",
            purposes: oldBinding.purposes.map((entry) => ({
              ...entry,
              state: "SUPERSEDED",
              terminalAt,
              terminalReason: "SESSION_TICKET_ROTATED",
            })),
          },
          serverNow: terminalAt,
        };
        if (loseFirstRotationResponse) {
          loseFirstRotationResponse = false;
          throw new TypeError("connection reset after commit");
        }
        return Response.json(structuredClone(committedRotation));
      }
      throw new Error(`unexpected request ${url}`);
    });
    const options = {
      baseUrl: "http://hub.test",
      bootstrapAgentToken: "agent-bootstrap",
      bootstrapInjectorToken: "injector-bootstrap",
      vault,
      checkpointStore: new MemoryCheckpointStore(),
      fetch: fetchMock as typeof fetch,
    };
    const runtime = new CodexSessionTicketRuntime(options);
    const prepared = await runtime.prepareInitial({
      projectId: "prj_codex",
      runId: "run_codex",
      activationMode: "FIRST_LINEAGE",
      externalSessionId: "desktop-session",
      externalThreadId: "thr_codex",
    });
    const registered = await runtime.registerInitial({
      agentId: "codex",
      role: "primary",
      client: "codex-app-server",
      transport: "websocket",
      deliveryMode: "app_server_push",
      externalSessionId: "desktop-session",
      externalThreadId: "thr_codex",
      host: "localhost",
      pid: 1234,
      cwd: "C:\\work\\crossagent-hub",
      capabilities: [],
      idempotencyKey: "register:run_codex",
    });
    const oldRaw = structuredClone(prepared.raw);

    await expect(
      runtime.activateSuccessor(registered.registration.session, "renew:stable-operation"),
    ).rejects.toThrow("connection reset after commit");
    const ambiguous = structuredClone(vault.value!.successor!);
    expect(ambiguous.phase).toBe("ACTIVATING");
    expect(ambiguous.activationAttempted).toBe(true);
    const bundleCountAfterAmbiguity = offerIds.size;

    const recoveredRuntime = new CodexSessionTicketRuntime(options);
    const [recovered, concurrentReplay] = await Promise.all([
      recoveredRuntime.activateSuccessor(registered.registration.session, "renew:stable-operation"),
      recoveredRuntime.activateSuccessor(registered.registration.session, "renew:stable-operation"),
    ]);
    expect(recovered.next.stored.bundleId).toBe(ambiguous.bundleId);
    expect(recovered.rotation).toEqual(committedRotation);
    expect(concurrentReplay.rotation).toEqual(committedRotation);
    expect(offerIds.size).toBe(bundleCountAfterAmbiguity);
    expect(activationBodies).toEqual([
      { idempotencyKey: "renew:stable-operation" },
      { idempotencyKey: "renew:stable-operation" },
    ]);
    expect(vault.value!.current!.raw).toEqual(oldRaw);
    expect(vault.value!.successor!.rotationReceipt).toEqual(committedRotation);

    const postActivationRestart = new CodexSessionTicketRuntime(options);
    await expect(
      postActivationRestart.activateSuccessor(
        registered.registration.session,
        "renew:stable-operation",
      ),
    ).resolves.toMatchObject({ rotation: committedRotation });
    expect(activationBodies).toHaveLength(2);

    await postActivationRestart.markCutoverPhase(recovered.next.stored.bundleId, "CONTROL_READY");
    await postActivationRestart.markCutoverPhase(recovered.next.stored.bundleId, "MODEL_READY");
    await postActivationRestart.markCutoverPhase(recovered.next.stored.bundleId, "EVENTS_READY");

    vault.failNextSave = true;
    await expect(
      postActivationRestart.commitSuccessor(recovered.next.stored.bundleId),
    ).rejects.toThrow("simulated durable save failure");
    expect(vault.value!.current!.raw).toEqual(oldRaw);
    expect(vault.value!.successor!.bundleId).toBe(ambiguous.bundleId);
    await postActivationRestart.commitSuccessor(recovered.next.stored.bundleId);
    const persisted = JSON.stringify(vault.value);
    expect(vault.value!.successor).toBeNull();
    expect(vault.value!.current!.bundleId).toBe(ambiguous.bundleId);
    expect(persisted).not.toContain(oldRaw.CONTROL);
    expect(persisted).not.toContain(oldRaw.MODEL_MCP);
    expect(persisted).not.toContain(oldRaw.INJECTOR);
  });

  it("rejects pending message 10001 atomically without advancing or poisoning the checkpoint", async () => {
    const vault = new MemoryVault();
    const checkpointStore = new MemoryCheckpointStore();
    const binding = activeBinding("stb_current", {
      CONTROL: "stk_control",
      MODEL_MCP: "stk_model",
      INJECTOR: "stk_injector",
      CAPTURE: "stk_unused",
    });
    const stored: StoredCodexSessionTicketBundle = {
      bundleId: binding.bundleId,
      phase: "ACTIVE",
      launchContext: {
        projectId: "prj_codex",
        runId: "run_codex",
        activationMode: "FIRST_LINEAGE",
        externalSessionId: "desktop-session",
        externalThreadId: "thr_codex",
      },
      context: {
        projectId: "prj_codex",
        runId: "run_codex",
        activationMode: "FIRST_LINEAGE",
        externalSessionId: "desktop-session",
        externalThreadId: "thr_codex",
      },
      raw: { CONTROL: raw("C"), MODEL_MCP: raw("M"), INJECTOR: raw("I") },
      offerIds: {
        CONTROL: "stk_control",
        MODEL_MCP: "stk_model",
        INJECTOR: "stk_injector",
      },
      activationAttempted: true,
      binding,
      rotationReceipt: null,
      sessionReceipt: session(),
      launchSessionId: "ses_codex",
      serverNow: AT,
      observedAt: AT,
      registrationInput: {
        agentId: "codex",
        role: "primary",
        client: "codex-app-server",
        transport: "websocket",
        deliveryMode: "app_server_push",
        externalSessionId: "desktop-session",
        externalThreadId: "thr_codex",
        host: "localhost",
        pid: 1234,
        cwd: "C:\\work\\crossagent-hub",
        capabilities: [],
        idempotencyKey: "register:run_codex",
      },
    };
    vault.value = { schemaVersion: 1, current: stored, successor: null, cutover: null };
    checkpointStore.value = {
      schemaVersion: 1,
      projectId: "prj_codex",
      threadId: "thr_codex",
      ownerRunId: "run_codex",
      eventSequence: 0,
      pendingMessageIds: Array.from({ length: 10_000 }, (_, index) => `msg_${index}`),
      session: {
        hubSessionId: "ses_codex",
        lineageId: "lin_codex",
        incarnation: 1,
        bundleId: "stb_current",
        nextHeartbeatSequence: 1,
      },
      updatedAt: AT,
    };
    expect(() => parseCodexSessionTicketVaultSnapshot(vault.value)).not.toThrow();
    expect(() =>
      // The operational codec shares Protocol IdSchema's 128-character bound.
      parseCodexSessionOperationalCheckpoint({
        ...checkpointStore.value,
        pendingMessageIds: [`msg_${"x".repeat(125)}`],
      }),
    ).toThrow("Invalid Codex operational checkpoint");
    const runtime = new CodexSessionTicketRuntime({
      baseUrl: "http://hub.test",
      bootstrapAgentToken: "agent-bootstrap",
      bootstrapInjectorToken: "injector-bootstrap",
      vault,
      checkpointStore,
      fetch: vi.fn() as unknown as typeof fetch,
    });
    const active = {
      stored,
      controlHub: null,
      injectorHub: null,
      modelMcpToken: stored.raw.MODEL_MCP,
    } as unknown as ActiveCodexSessionTicketBundle;

    await expect(runtime.reservePendingMessage(active, `msg_${"x".repeat(125)}`)).rejects.toThrow(
      "pending checkpoint message id is invalid",
    );

    await expect(runtime.commitEventSequence(active, 1, ["msg_overflow"])).rejects.toThrow(
      "pending message limit exceeded",
    );
    expect(checkpointStore.value).toMatchObject({ eventSequence: 0 });
    expect(checkpointStore.value!.pendingMessageIds).toHaveLength(10_000);
    expect(checkpointStore.value!.pendingMessageIds).not.toContain("msg_overflow");

    await runtime.commitEventSequence(active, 1, ["msg_0"]);
    expect(checkpointStore.value).toMatchObject({ eventSequence: 1 });
    expect(checkpointStore.value!.pendingMessageIds).toHaveLength(10_000);

    checkpointStore.failNextSave = true;
    await expect(runtime.commitEventSequence(active, 2, ["msg_0"])).rejects.toThrow(
      "simulated checkpoint save failure",
    );
    expect(checkpointStore.value).toMatchObject({ eventSequence: 1 });
    await runtime.commitEventSequence(active, 2, ["msg_0"]);
    expect(checkpointStore.value).toMatchObject({ eventSequence: 2 });

    checkpointStore.failNextSave = true;
    await expect(runtime.settlePendingMessage(active, "msg_0")).rejects.toThrow(
      "simulated checkpoint save failure",
    );
    expect(checkpointStore.value!.pendingMessageIds).toContain("msg_0");
    await runtime.settlePendingMessage(active, "msg_0");
    expect(checkpointStore.value!.pendingMessageIds).not.toContain("msg_0");
  });

  it("keeps the checkpoint session live when raw-vault close fails and replays the prepared close exactly", async () => {
    const vault = new MemoryVault();
    const checkpointStore = new MemoryCheckpointStore();
    const binding = activeBinding("stb_close", {
      CONTROL: "stk_control",
      MODEL_MCP: "stk_model",
      INJECTOR: "stk_injector",
      CAPTURE: "stk_unused",
    });
    const stored: StoredCodexSessionTicketBundle = {
      bundleId: binding.bundleId,
      phase: "ACTIVE",
      launchContext: {
        projectId: "prj_codex",
        runId: "run_codex",
        activationMode: "FIRST_LINEAGE",
        externalSessionId: "desktop-session",
        externalThreadId: "thr_codex",
      },
      context: {
        projectId: "prj_codex",
        runId: "run_codex",
        activationMode: "FIRST_LINEAGE",
        externalSessionId: "desktop-session",
        externalThreadId: "thr_codex",
      },
      raw: { CONTROL: raw("C"), MODEL_MCP: raw("M"), INJECTOR: raw("I") },
      offerIds: {
        CONTROL: "stk_control",
        MODEL_MCP: "stk_model",
        INJECTOR: "stk_injector",
      },
      activationAttempted: true,
      binding,
      rotationReceipt: null,
      sessionReceipt: session(),
      launchSessionId: "ses_codex",
      serverNow: AT,
      observedAt: AT,
      registrationInput: {
        agentId: "codex",
        role: "primary",
        client: "codex-app-server",
        transport: "websocket",
        deliveryMode: "app_server_push",
        externalSessionId: "desktop-session",
        externalThreadId: "thr_codex",
        host: "localhost",
        pid: 1234,
        cwd: "C:\\work\\crossagent-hub",
        capabilities: [],
        idempotencyKey: "register:run_codex",
      },
    };
    vault.value = { schemaVersion: 1, current: stored, successor: null, cutover: null };
    checkpointStore.value = {
      schemaVersion: 1,
      projectId: "prj_codex",
      threadId: "thr_codex",
      ownerRunId: "run_codex",
      eventSequence: 7,
      pendingMessageIds: [],
      session: {
        hubSessionId: "ses_codex",
        lineageId: "lin_codex",
        incarnation: 1,
        bundleId: stored.bundleId,
        nextHeartbeatSequence: 9,
      },
      updatedAt: AT,
    };
    const options = {
      baseUrl: "http://hub.test",
      bootstrapAgentToken: "agent-bootstrap",
      bootstrapInjectorToken: "injector-bootstrap",
      vault,
      checkpointStore,
      fetch: vi.fn() as unknown as typeof fetch,
      now: () => new Date(AT),
    };
    const rawBefore = structuredClone(stored.raw);
    vault.failNextSave = true;

    await expect(
      new CodexSessionTicketRuntime(options).clearAfterConfirmedClose(stored.bundleId),
    ).rejects.toThrow("simulated durable save failure");

    expect(vault.value?.current?.raw).toEqual(rawBefore);
    expect(checkpointStore.value).toMatchObject({
      session: { bundleId: stored.bundleId, hubSessionId: "ses_codex" },
      confirmedClose: {
        bundleId: stored.bundleId,
        state: "PREPARED",
        confirmedAt: AT,
      },
    });

    await expect(
      new CodexSessionTicketRuntime(options).recoverActive(stored.launchContext),
    ).resolves.toBeNull();

    expect(vault.value).toEqual({
      schemaVersion: 1,
      current: null,
      successor: null,
      cutover: null,
    });
    expect(checkpointStore.value).toMatchObject({
      eventSequence: 7,
      pendingMessageIds: [],
      session: null,
    });
    expect(checkpointStore.value).not.toHaveProperty("confirmedClose");

    // Second crash window: raw-vault deletion committed, but the final checkpoint settlement did
    // not. A new run must finish the orphaned marker before creating/offering its fresh bundle.
    vault.value = {
      schemaVersion: 1,
      current: structuredClone(stored),
      successor: null,
      cutover: null,
    };
    checkpointStore.value = {
      schemaVersion: 1,
      projectId: "prj_codex",
      threadId: "thr_codex",
      ownerRunId: "run_codex",
      eventSequence: 7,
      pendingMessageIds: [],
      session: {
        hubSessionId: "ses_codex",
        lineageId: "lin_codex",
        incarnation: 1,
        bundleId: stored.bundleId,
        nextHeartbeatSequence: 9,
      },
      updatedAt: AT,
    };
    checkpointStore.failNextMatchingSave = (checkpoint) => checkpoint.session === null;
    await expect(
      new CodexSessionTicketRuntime(options).clearAfterConfirmedClose(stored.bundleId),
    ).rejects.toThrow("simulated checkpoint save failure");
    expect(vault.value?.current).toBeNull();
    expect(checkpointStore.value).toMatchObject({
      session: { bundleId: stored.bundleId },
      confirmedClose: { bundleId: stored.bundleId, state: "PREPARED" },
    });

    const offerFetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = requestBody(init);
      return Response.json({
        id: `stk_${String(body.purpose).toLowerCase()}_successor`,
        bundle_id: body.bundle_id,
        purpose: body.purpose,
        state: "PENDING",
        project_id: "prj_codex",
        adapter_client: "codex",
        agent_id: "codex",
        session_client: "codex-app-server",
        role: "primary",
        transport: "websocket",
        delivery_mode: "app_server_push",
        external_session_id: "desktop-session",
        external_thread_id: "thr_codex",
        run_id: "run_successor",
        offer_expires_at: "2026-08-01T04:10:00.000Z",
      });
    });
    const prepared = await new CodexSessionTicketRuntime({
      ...options,
      fetch: offerFetch as typeof fetch,
    }).prepareInitial({
      projectId: "prj_codex",
      runId: "run_successor",
      activationMode: "FIRST_LINEAGE",
      externalSessionId: "desktop-session",
      externalThreadId: "thr_codex",
    });
    expect(prepared.context.runId).toBe("run_successor");
    expect(offerFetch).toHaveBeenCalledTimes(3);
    expect(checkpointStore.value).toMatchObject({ session: null, eventSequence: 7 });
    expect(checkpointStore.value).not.toHaveProperty("confirmedClose");
  });

  it("rejects drifted ACTIVE disk bindings without disclosing raw material", () => {
    const secret = raw("Z");
    const binding = activeBinding("stb_current", {
      CONTROL: "stk_control",
      MODEL_MCP: "stk_model",
      INJECTOR: "stk_injector",
      CAPTURE: "stk_unused",
    });
    const base: CodexSessionTicketVaultSnapshot = {
      schemaVersion: 1,
      current: {
        bundleId: "stb_current",
        phase: "ACTIVE",
        launchContext: {
          projectId: "prj_codex",
          runId: "run_codex",
          activationMode: "FIRST_LINEAGE",
          externalSessionId: null,
          externalThreadId: null,
        },
        context: {
          projectId: "prj_codex",
          runId: "run_codex",
          activationMode: "FIRST_LINEAGE",
          externalSessionId: null,
          externalThreadId: null,
        },
        raw: { CONTROL: secret, MODEL_MCP: raw("Y"), INJECTOR: raw("X") },
        offerIds: {
          CONTROL: "stk_control",
          MODEL_MCP: "stk_model",
          INJECTOR: "stk_injector",
        },
        activationAttempted: true,
        binding,
        rotationReceipt: null,
        sessionReceipt: session(),
        launchSessionId: "ses_codex",
        serverNow: AT,
        observedAt: AT,
        registrationInput: {
          agentId: "codex",
          role: "primary",
          client: "codex-app-server",
          transport: "websocket",
          deliveryMode: "app_server_push",
          externalSessionId: "desktop-session",
          externalThreadId: "thr_codex",
          host: "localhost",
          pid: 1234,
          cwd: "C:\\work\\crossagent-hub",
          capabilities: [],
          idempotencyKey: "register:run_codex",
        },
      },
      successor: null,
    };
    const corruptions = [
      {
        ...base,
        current: {
          ...base.current!,
          context: { ...base.current!.context, projectId: "prj_other" },
        },
      },
      { ...base, current: { ...base.current!, binding: { ...binding, runId: "run_other" } } },
      {
        ...base,
        current: {
          ...base.current!,
          binding: {
            ...binding,
            purposes: binding.purposes.filter((entry) => entry.purpose !== "INJECTOR"),
          },
        },
      },
      {
        ...base,
        current: { ...base.current!, binding: { ...binding, expiresAt: binding.activatedAt } },
      },
    ];
    for (const corrupted of corruptions) {
      let message = "";
      try {
        parseCodexSessionTicketVaultSnapshot(corrupted);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toBe("Invalid Codex session ticket vault snapshot");
      expect(message).not.toContain(secret);
    }
  });
});
