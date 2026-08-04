import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  CodexSessionTicketRuntime,
  type CodexSessionTicketVaultSnapshot,
  type StoredCodexSessionTicketBundle,
} from "@crossagent/codex-bridge";
import {
  awaitCodexBridgeRunOwnership,
  clearCodexBridgeRunIfOwned,
  codexBridgeTerminalCleanupEvidence,
  codexBridgeLaunchLockPath,
  codexBridgeRunFiles,
  clearStaleCodexBridgePid,
  codexBridgeFiles,
  consumeCodexBridgeRunStopRequest,
  consumeCodexBridgeStopRequest,
  createCodexBridgeProcessTerminalController,
  isCodexBridgeHealthDegraded,
  isCodexBridgeHealthStale,
  listCodexBridgeFailedRuns,
  markCodexBridgeRunFailedIfOwned,
  managedCodexBridgeEnvironment,
  listCodexBridgePids,
  promoteCodexBridgeRunThread,
  probeCodexBridgeRunWorkerProof,
  publicCodexBridgeRecord,
  readCodexBridgeManagedBuildIdentity,
  readCodexBridgeManagedLaunchContext,
  readCodexBridgeHealth,
  readCodexBridgePid,
  resolveCodexBridgeControlProjectId,
  selectCodexBridgePids,
  startCodexBridgeProcess,
  startCodexBridgeRunStopWatcher,
  stopCodexBridgeProcess,
  writeCodexBridgeHealth,
  writeCodexBridgeRunOwnerLease,
} from "../src/bridge-process-manager.js";
import {
  startBridgeWorkerProofLifecycle,
  type BridgeWorkerProofLifecycle,
} from "../src/bridge-worker-proof.js";
import {
  hardenWindowsOwnerPrivateAcl,
  verifyWindowsOwnerPrivateAcl,
} from "../src/windows-owner-private-acl.js";
import {
  FileCodexSessionOperationalCheckpointStore,
  FileCodexSessionTicketVault,
  assertCodexSessionTicketRecoveryReservation,
  bindCodexSessionTicketRecoveryRun,
  markCodexSessionTicketRecoveryDraining,
} from "../src/session-ticket-store.js";
import * as buildIdentityModule from "../src/build-identity.js";

const testBuildIdentity = Object.freeze({
  buildSessionId: "00000000-0000-4000-8000-000000000000",
  buildId: "0".repeat(64),
  migrationId: "3".repeat(64),
  protocolId: "1".repeat(64),
  manifestSha256: "2".repeat(64),
});

function issuedReservation(runId: string, threadId: string) {
  return {
    id: `rsr_${runId}`,
    projectId: "prj_test",
    lineageId: `lin_${threadId}`,
    agentId: "codex",
    client: "codex-app-server" as const,
    deliveryMode: "app_server_push" as const,
    identityKind: "external_thread" as const,
    identityValue: threadId,
    runId,
    generation: 1,
    expectedHeadSessionId: null,
    state: "ISSUED" as const,
    consumedSessionId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function activeTicketSnapshot(
  projectId: string,
  runId: string,
  threadId: string,
  cwd: string,
): CodexSessionTicketVaultSnapshot {
  const at = "2026-08-01T04:00:00.000Z";
  const expiresAt = "2026-08-02T04:00:00.000Z";
  const offerIds = {
    CONTROL: "stk_control",
    MODEL_MCP: "stk_model",
    INJECTOR: "stk_injector",
  } as const;
  const binding = {
    bundleId: "stb_managed_reentry",
    state: "ACTIVE" as const,
    projectId,
    agentId: "codex" as const,
    adapterClient: "codex" as const,
    hubSessionId: "ses_managed_reentry",
    lineageId: "lin_managed_reentry",
    incarnation: 1,
    runId,
    activatedAt: at,
    expiresAt,
    purposes: (["CONTROL", "MODEL_MCP", "INJECTOR"] as const).map((purpose) => ({
      id: offerIds[purpose],
      purpose,
      state: "ACTIVE" as const,
    })),
  };
  const session = {
    id: "ses_managed_reentry",
    projectId,
    agentId: "codex" as const,
    role: "primary" as const,
    client: "codex-app-server" as const,
    transport: "websocket" as const,
    deliveryMode: "app_server_push" as const,
    externalSessionId: threadId,
    externalThreadId: threadId,
    externalTurnId: null,
    host: "localhost",
    pid: 59_000,
    cwd,
    gitBranch: null,
    gitHead: null,
    capabilities: [],
    connectedAt: at,
    transportLastSeenAt: at,
    activityLastSeenAt: null,
    currentTaskId: null,
    currentReviewId: null,
    activeFiles: [],
    workState: "IDLE" as const,
    connectionState: "ONLINE" as const,
    queueDepth: 0,
    lineageId: "lin_managed_reentry",
    incarnation: 1,
    predecessorSessionId: null,
    supersededBySessionId: null,
    launcherRunId: runId,
    launchGeneration: 1,
    version: 1,
  };
  const context = {
    projectId,
    runId,
    activationMode: "MANAGED_RESERVATION" as const,
    externalSessionId: threadId,
    externalThreadId: threadId,
    expectedLineageId: "lin_managed_reentry",
    expectedHeadSessionId: null,
    launchReservationId: `rsr_${runId}`,
    launchGeneration: 1,
  };
  return {
    schemaVersion: 1,
    current: {
      bundleId: binding.bundleId,
      phase: "ACTIVE",
      launchContext: context,
      context,
      raw: { CONTROL: "A".repeat(43), MODEL_MCP: "B".repeat(43), INJECTOR: "C".repeat(43) },
      offerIds,
      activationAttempted: true,
      binding,
      rotationReceipt: null,
      sessionReceipt: session,
      launchSessionId: session.id,
      serverNow: at,
      observedAt: at,
      registrationInput: {
        agentId: "codex",
        role: "primary",
        client: "codex-app-server",
        transport: "websocket",
        deliveryMode: "app_server_push",
        externalSessionId: threadId,
        externalThreadId: threadId,
        expectedHeadSessionId: null,
        launcherRunId: runId,
        launchGeneration: 1,
        host: "localhost",
        pid: 59_000,
        cwd,
        capabilities: [],
        idempotencyKey: `codex-session:${runId}`,
      },
    },
    successor: null,
    cutover: null,
  };
}

function currentHeadCutoverSnapshot(
  projectId: string,
  runId: string,
  threadId: string,
  cwd: string,
  phase: "HUB_ACTIVATING" | "HUB_ACTIVATED" | "CONTROL_READY" | "MODEL_READY" | "EVENTS_READY",
): CodexSessionTicketVaultSnapshot {
  const snapshot = activeTicketSnapshot(projectId, runId, threadId, cwd);
  const current = snapshot.current!;
  const predecessorSession = current.sessionReceipt!;
  const successorSessionId = `ses_cutover_${phase.toLowerCase()}`;
  const successor = structuredClone(current);
  successor.bundleId = `stb_cutover_${phase.toLowerCase()}`;
  successor.phase = phase === "HUB_ACTIVATING" ? "ACTIVATING" : "ACTIVE";
  successor.context = {
    projectId,
    runId,
    activationMode: "CURRENT_HEAD_REPLACEMENT",
    externalSessionId: threadId,
    externalThreadId: threadId,
    expectedLineageId: "lin_managed_reentry",
    expectedHeadSessionId: predecessorSession.id,
  };
  successor.raw = {
    CONTROL: "D".repeat(43),
    MODEL_MCP: "E".repeat(43),
    INJECTOR: "F".repeat(43),
  };
  successor.offerIds = {
    CONTROL: `stk_cutover_control_${phase.toLowerCase()}`,
    MODEL_MCP: `stk_cutover_model_${phase.toLowerCase()}`,
    INJECTOR: `stk_cutover_injector_${phase.toLowerCase()}`,
  };
  successor.registrationInput = {
    ...successor.registrationInput!,
    expectedHeadSessionId: predecessorSession.id,
    launcherRunId: undefined,
    launchGeneration: undefined,
    idempotencyKey: `codex-current-head:${runId}:${predecessorSession.id}`,
  };
  successor.launchSessionId = predecessorSession.id;
  successor.rotationReceipt = null;
  if (phase === "HUB_ACTIVATING") {
    successor.binding = null;
    successor.sessionReceipt = null;
    successor.serverNow = null;
    successor.observedAt = null;
  } else {
    successor.binding = {
      ...current.binding!,
      bundleId: successor.bundleId,
      hubSessionId: successorSessionId,
      incarnation: 2,
      purposes: (["CONTROL", "MODEL_MCP", "INJECTOR"] as const).map((purpose) => ({
        id: successor.offerIds[purpose]!,
        purpose,
        state: "ACTIVE" as const,
      })),
    };
    successor.sessionReceipt = {
      ...predecessorSession,
      id: successorSessionId,
      incarnation: 2,
      predecessorSessionId: predecessorSession.id,
      launcherRunId: null,
      launchGeneration: null,
    };
  }
  snapshot.successor = successor;
  snapshot.cutover = {
    kind: "CURRENT_HEAD_REPLACEMENT",
    predecessorBundleId: current.bundleId,
    successorBundleId: successor.bundleId,
    predecessorSessionId: predecessorSession.id,
    successorSessionId: phase === "HUB_ACTIVATING" ? null : successorSessionId,
    operationId: `codex-current-head:${runId}:${predecessorSession.id}`,
    phase,
    updatedAt: "2026-08-01T04:00:00.000Z",
  };
  return snapshot;
}

function auxiliaryCutoverSnapshot(
  projectId: string,
  runId: string,
  threadId: string,
  cwd: string,
  phase: "HUB_ACTIVATING" | "HUB_ACTIVATED" | "CONTROL_READY" | "MODEL_READY" | "EVENTS_READY",
): CodexSessionTicketVaultSnapshot {
  const snapshot = currentHeadCutoverSnapshot(projectId, runId, threadId, cwd, phase);
  const current = snapshot.current!;
  const successor = snapshot.successor!;
  const session = current.sessionReceipt!;
  successor.context.activationMode = "SESSION_AUXILIARY";
  successor.registrationInput = structuredClone(current.registrationInput);
  snapshot.cutover = {
    ...snapshot.cutover!,
    kind: "SESSION_AUXILIARY",
    successorSessionId: phase === "HUB_ACTIVATING" ? null : session.id,
    operationId: `session-ticket-renewal:${current.bundleId}`,
  };
  if (phase !== "HUB_ACTIVATING") {
    successor.binding = {
      ...current.binding!,
      bundleId: successor.bundleId,
      activatedAt: "2026-08-01T04:00:01.000Z",
      expiresAt: "2026-08-02T04:00:01.000Z",
      purposes: (["CONTROL", "MODEL_MCP", "INJECTOR"] as const).map((purpose) => ({
        id: successor.offerIds[purpose]!,
        purpose,
        state: "ACTIVE" as const,
      })),
    };
    successor.sessionReceipt = structuredClone(session);
    const terminalAt = "2026-08-01T04:00:01.000Z";
    const terminalReason = "session_ticket_rotated";
    successor.rotationReceipt = {
      session: structuredClone(session),
      ticketBinding: structuredClone(successor.binding),
      supersededTicketBinding: {
        ...current.binding!,
        state: "SUPERSEDED",
        terminalAt,
        terminalReason,
        purposes: current.binding!.purposes.map((purpose) => ({
          ...purpose,
          state: "SUPERSEDED" as const,
          terminalAt,
          terminalReason,
        })),
      },
      serverNow: successor.serverNow!,
    };
  }
  return snapshot;
}

function activatedCloseReplaySuccessor(
  snapshot: CodexSessionTicketVaultSnapshot,
): StoredCodexSessionTicketBundle {
  const current = snapshot.current!;
  const successor = structuredClone(snapshot.successor!);
  if (successor.phase === "ACTIVE") return successor;
  const auxiliary = successor.context.activationMode === "SESSION_AUXILIARY";
  const session = auxiliary
    ? structuredClone(current.sessionReceipt!)
    : {
        ...structuredClone(current.sessionReceipt!),
        id: `ses_replayed_${successor.bundleId.slice(4)}`,
        incarnation: current.sessionReceipt!.incarnation! + 1,
        predecessorSessionId: current.sessionReceipt!.id,
        launcherRunId: null,
        launchGeneration: null,
      };
  successor.phase = "ACTIVE";
  successor.binding = {
    ...structuredClone(current.binding!),
    bundleId: successor.bundleId,
    hubSessionId: session.id,
    incarnation: session.incarnation!,
    activatedAt: "2026-08-01T04:00:01.000Z",
    expiresAt: "2026-08-02T04:00:01.000Z",
    purposes: (["CONTROL", "MODEL_MCP", "INJECTOR"] as const).map((purpose) => ({
      id: successor.offerIds[purpose]!,
      purpose,
      state: "ACTIVE" as const,
    })),
  };
  successor.sessionReceipt = session;
  successor.serverNow = "2026-08-01T04:00:01.000Z";
  successor.observedAt = successor.serverNow;
  if (auxiliary) {
    const terminalAt = successor.serverNow;
    const terminalReason = "session_ticket_rotated";
    successor.rotationReceipt = {
      session: structuredClone(session),
      ticketBinding: structuredClone(successor.binding),
      supersededTicketBinding: {
        ...structuredClone(current.binding!),
        state: "SUPERSEDED",
        terminalAt,
        terminalReason,
        purposes: current.binding!.purposes.map((entry) => ({
          ...entry,
          state: "SUPERSEDED" as const,
          terminalAt,
          terminalReason,
        })),
      },
      serverNow: successor.serverNow,
    };
  }
  return successor;
}

function closeReplayFetch(snapshot: CodexSessionTicketVaultSnapshot): {
  fetch: typeof fetch;
  closedSessionIds: string[];
} {
  const successor = activatedCloseReplaySuccessor(snapshot);
  const current = snapshot.current!;
  const closedSessionIds: string[] = [];
  return {
    closedSessionIds,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith(`/api/projects/${current.context.projectId}/sessions`)) {
        return Response.json({
          session: successor.sessionReceipt,
          ticketBinding: successor.binding,
          serverNow: successor.serverNow,
        });
      }
      if (url.includes("/session-ticket-bundles/") && url.endsWith("/activate")) {
        return Response.json(successor.rotationReceipt);
      }
      if (url.endsWith(`/api/sessions/${successor.sessionReceipt!.id}/close`)) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(body).toEqual({
          reason: "codex_bridge_closed",
          idempotencyKey: `codex-session-close:${successor.sessionReceipt!.id}:${current.launchContext.runId}`,
        });
        closedSessionIds.push(successor.sessionReceipt!.id);
        const terminalAt = "2026-08-01T04:00:02.000Z";
        const terminalReason = "codex_bridge_closed";
        return Response.json({
          session: {
            ...structuredClone(successor.sessionReceipt!),
            connectionState: "CLOSED",
            version: successor.sessionReceipt!.version + 1,
          },
          ticketBinding: {
            ...structuredClone(successor.binding!),
            state: "REVOKED",
            terminalAt,
            terminalReason,
            purposes: successor.binding!.purposes.map((entry) => ({
              ...entry,
              state: "REVOKED",
              terminalAt,
              terminalReason,
            })),
          },
        });
      }
      throw new Error(`Unexpected close replay request: ${url}`);
    }) as typeof fetch,
  };
}

describe("Codex Bridge process manager", () => {
  it("maps only structurally consistent Bridge stop outcomes to cleanup authority", () => {
    expect(
      codexBridgeTerminalCleanupEvidence({
        sessionExisted: false,
        close: { state: "NOT_ATTEMPTED", sessionId: null, bundleId: null },
      }),
    ).toEqual({ terminalCleanup: "NOT_ATTEMPTED" });
    expect(
      codexBridgeTerminalCleanupEvidence({
        sessionExisted: true,
        close: {
          state: "CONFIRMED",
          sessionId: "ses_confirmed",
          bundleId: "stb_confirmed",
        },
      }),
    ).toEqual({
      terminalCleanup: "CONFIRMED",
      sessionId: "ses_confirmed",
      bundleId: "stb_confirmed",
    });
    expect(
      codexBridgeTerminalCleanupEvidence({
        sessionExisted: true,
        close: {
          state: "AMBIGUOUS",
          sessionId: "ses_ambiguous",
          bundleId: "stb_ambiguous",
        },
      }),
    ).toEqual({
      terminalCleanup: "AMBIGUOUS",
      sessionId: "ses_ambiguous",
      bundleId: "stb_ambiguous",
    });
    expect(() => codexBridgeTerminalCleanupEvidence(null)).toThrow(/did not publish/i);
    expect(() =>
      codexBridgeTerminalCleanupEvidence({
        sessionExisted: false,
        close: { state: "CONFIRMED", sessionId: null, bundleId: null },
      }),
    ).toThrow(/without an exact session/i);
  });

  it("lets a fatal Bridge outcome upgrade a caller stop before final process exit", async () => {
    let releaseShutdown!: () => void;
    const shutdownGate = new Promise<void>((resolvePromise) => {
      releaseShutdown = resolvePromise;
    });
    const finalized: Array<{ reason: string; fatal: boolean; error?: Error }> = [];
    let runState = "RUNNING";
    let exitCode: number | null = null;
    const controller = createCodexBridgeProcessTerminalController({
      shutdown: () => shutdownGate,
      finalize: (outcome) => {
        finalized.push(outcome);
        runState = outcome.fatal ? "FAILED" : "CLEARED";
        exitCode = outcome.fatal ? 1 : 0;
      },
    });
    const normal = controller.request({ reason: "caller stop", fatal: false });
    const fatal = new Error("replacement crashed");
    const upgraded = shutdownGate.then(() =>
      controller.request({ reason: "app-server exited", fatal: true, error: fatal }),
    );

    releaseShutdown();
    await Promise.all([normal, upgraded]);

    expect(finalized).toEqual([{ reason: "app-server exited", fatal: true, error: fatal }]);
    expect(runState).toBe("FAILED");
    expect(exitCode).toBe(1);
  });

  it("consumes a child stop request while Hub initialization is still unresolved", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "crossagent-bridge-preflight-stop-"));
    const entry = resolve(root, "cli.js");
    writeFileSync(entry, "", "utf8");
    const started = await startCodexBridgeProcess({
      entry,
      projectId: "prj_test",
      agentId: "codex",
      rootDir: root,
      startupProbeDelayMs: 0,
      adapters: {
        processExists: (pid) => pid === 40_500,
        spawnDetached: () => ({ pid: 40_500, unref: () => undefined }),
      },
    });
    const owner = {
      projectId: started.record.projectId,
      agentId: started.record.agentId,
      runId: started.record.runId!,
      ownerNonce: started.record.ownerNonce!,
      pid: started.record.pid,
    };
    let hubInitializationSettled = false;
    void new Promise<void>(() => undefined).then(() => {
      hubInitializationSettled = true;
    });
    let stopObserved!: () => void;
    const observed = new Promise<void>((resolvePromise) => {
      stopObserved = resolvePromise;
    });
    const watcher = startCodexBridgeRunStopWatcher(owner, stopObserved, root, 1);

    await stopCodexBridgeProcess(
      "prj_test",
      "codex",
      root,
      {},
      {
        processExists: (pid) => pid === 40_500,
        maxWaitAttempts: 0,
      },
    );
    await Promise.race([
      observed,
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error("stop watcher did not fire")), 100),
      ),
    ]);
    clearInterval(watcher);

    expect(hubInitializationSettled).toBe(false);
    expect(consumeCodexBridgeRunStopRequest(owner, root)).toBe(false);
  });

  it("keeps explicit-project status and stop local without reading credentials or consulting the Hub", async () => {
    const resolveFromHub = vi.fn(async () => {
      throw new Error("credential reader must not run");
    });

    await expect(resolveCodexBridgeControlProjectId("prj_explicit", resolveFromHub)).resolves.toBe(
      "prj_explicit",
    );
    expect(resolveFromHub).not.toHaveBeenCalled();
  });

  it("uses a default-deny environment for managed children", () => {
    const environment = managedCodexBridgeEnvironment({
      Path: "C:\\Windows\\System32",
      SYSTEMROOT: "C:\\Windows",
      CROSSAGENT_URL: "http://127.0.0.1:4387",
      CROSSAGENT_DATA_DIR: "R:\\private-data",
      cRoSsAgEnT_TOKEN: "raw-agent-secret",
      CrossAgent_Agent_Codex_Token: "raw-codex-secret",
      crossagent_agent_codex_token_file: "R:\\private-agent-token",
      CrossAgent_Inject_Codex_Token_File: "R:\\private-injector-token",
      crossagent_session_ticket: "raw-session-ticket",
      CrossAgent_Session_Ticket_Digest: "digest-canary",
      crossagent_session_ticket_vault: "R:\\private-ticket-vault",
      NODE_OPTIONS: "--require R:\\untrusted-bootstrap.cjs",
      NODE_PATH: "R:\\untrusted-modules",
    });

    expect(environment).toEqual({
      Path: "C:\\Windows\\System32",
      SYSTEMROOT: "C:\\Windows",
      CROSSAGENT_URL: "http://127.0.0.1:4387",
      CROSSAGENT_DATA_DIR: "R:\\private-data",
    });
    const serialized = JSON.stringify(environment);
    for (const canary of [
      "raw-agent-secret",
      "raw-codex-secret",
      "private-agent-token",
      "private-injector-token",
      "raw-session-ticket",
      "digest-canary",
      "private-ticket-vault",
      "untrusted-bootstrap",
      "untrusted-modules",
    ]) {
      expect(serialized).not.toContain(canary);
    }
  });

  it("keeps parent credential canaries out of managed spawn, control, and long-lived logs", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "crossagent-bridge-secret-canary-"));
    const entry = resolve(root, "cli.js");
    writeFileSync(entry, "", "utf8");
    const secrets = {
      CROSSAGENT_TOKEN: "raw-parent-token-canary",
      CROSSAGENT_SESSION_TICKET_DIGEST: "digest-parent-canary",
      CROSSAGENT_BOOTSTRAP_SECRET: "bootstrap-parent-canary",
      ARBITRARY_RAW_CREDENTIAL: "arbitrary-raw-canary",
      NODE_OPTIONS: "--require secret-bootstrap-canary.cjs",
    } as const;
    const previous = new Map<string, string | undefined>();
    let childArgs: string[] = [];
    let childEnvironment: NodeJS.ProcessEnv = {};
    let childLogPath = "";
    try {
      for (const [name, value] of Object.entries(secrets)) {
        previous.set(name, process.env[name]);
        process.env[name] = value;
      }
      const result = await startCodexBridgeProcess({
        entry,
        projectId: "prj_test",
        agentId: "codex",
        hookCaptureBindingMode: "disabled",
        historicalDeliveryProofMode: "disabled",
        rootDir: root,
        startupProbeDelayMs: 0,
        adapters: {
          processExists: (pid) => pid === 40_700,
          spawnDetached: (_command, args, logPath, environment) => {
            childArgs = args;
            childEnvironment = environment;
            childLogPath = logPath;
            writeFileSync(logPath, "managed Bridge child started\n", "utf8");
            return { pid: 40_700, unref: () => undefined };
          },
        },
      });
      const controlPath = codexBridgeRunFiles(
        "prj_test",
        "codex",
        result.record.runId!,
        root,
      ).pidPath;
      const surfaces = [
        JSON.stringify(childArgs),
        JSON.stringify(childEnvironment),
        readFileSync(controlPath, "utf8"),
        readFileSync(childLogPath, "utf8"),
        JSON.stringify(publicCodexBridgeRecord(result.record)),
      ];
      for (const canary of Object.values(secrets).flatMap((value) =>
        value.startsWith("--require ") ? [value, "secret-bootstrap-canary"] : [value],
      )) {
        expect(surfaces.every((surface) => !surface.includes(canary))).toBe(true);
      }
      const pathEntry = Object.entries(childEnvironment).find(
        ([name]) => name.toUpperCase() === "PATH",
      );
      expect(pathEntry?.[1]).toBe(process.env.PATH);
      expect(childArgs).toContain("--hook-capture-binding");
      expect(childArgs[childArgs.indexOf("--hook-capture-binding") + 1]).toBe("disabled");
      expect(childArgs).toContain("--historical-delivery-proof");
      expect(childArgs[childArgs.indexOf("--historical-delivery-proof") + 1]).toBe("disabled");
      expect(childArgs).not.toContain("--bridge-worker-proof");
      expect(
        existsSync(
          codexBridgeRunFiles("prj_test", "codex", result.record.runId!, root).workerProofPath,
        ),
      ).toBe(false);
    } finally {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("passes explicit worker-proof activation only through public child arguments after private-path verification", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "crossagent-bridge-worker-proof-"));
    const entry = resolve(root, "cli.js");
    writeFileSync(entry, "", "utf8");
    const verifiedPaths: string[] = [];
    const hardenedPaths: string[] = [];
    let childArgs: string[] = [];

    const result = await startCodexBridgeProcess({
      entry,
      projectId: "prj_test",
      agentId: "codex",
      workerProofMode: "required",
      rootDir: root,
      startupProbeDelayMs: 0,
      adapters: {
        processExists: (pid) => pid === 40_710,
        verifyOwnerPrivateAcl: async (path) => {
          verifiedPaths.push(path);
          return true;
        },
        hardenOwnerPrivateAcl: async (path) => {
          hardenedPaths.push(path);
          return true;
        },
        spawnDetached: (_command, args) => {
          childArgs = args;
          return { pid: 40_710, unref: () => undefined };
        },
        afterSpawn: async (owner) => {
          await awaitCodexBridgeRunOwnership(owner, root);
        },
      },
    });

    const files = codexBridgeRunFiles("prj_test", "codex", result.record.runId!, root);
    expect(childArgs).toContain("--bridge-worker-proof");
    expect(childArgs[childArgs.indexOf("--bridge-worker-proof") + 1]).toBe("required");
    expect(childArgs[childArgs.indexOf("--bridge-worker-proof-sidecar-path") + 1]).toBe(
      files.workerProofPath,
    );
    expect(verifiedPaths).toContain(dirname(files.pidPath));
    expect(verifiedPaths).toContain(files.pidPath);
    expect(hardenedPaths).toContain(dirname(files.pidPath));
    expect(hardenedPaths).toContain(files.pidPath);
    expect(result.record.workerProofMode).toBe("required");
    expect(await probeCodexBridgeRunWorkerProof(result.record, root)).toBe("INVALID");
    expect(readFileSync(files.pidPath, "utf8")).not.toMatch(
      /pkcs8|private.?key|privateKey|canary/i,
    );
    expect(existsSync(files.workerProofPath)).toBe(false);
  });

  it.runIf(process.platform === "win32")(
    "fails closed before reservation or spawn when Windows proof activation lacks its ACL seam",
    async () => {
      const root = mkdtempSync(resolve(tmpdir(), "crossagent-bridge-worker-proof-acl-"));
      const entry = resolve(root, "cli.js");
      writeFileSync(entry, "", "utf8");
      let reserved = 0;
      let spawned = 0;

      await expect(
        startCodexBridgeProcess({
          entry,
          projectId: "prj_test",
          agentId: "codex",
          threadId: "thr_worker_proof_acl",
          workerProofMode: "required",
          rootDir: root,
          reserveLaunch: async ({ runId, threadId }) => {
            reserved += 1;
            return issuedReservation(runId, threadId);
          },
          adapters: {
            processExists: () => false,
            spawnDetached: () => {
              spawned += 1;
              return { pid: 40_711, unref: () => undefined };
            },
          },
        }),
      ).rejects.toThrow(/ACL hardener and verifier/i);

      expect(reserved).toBe(0);
      expect(spawned).toBe(0);
    },
  );

  it.runIf(process.platform === "win32")(
    "probes the exact live child through the real owner-private sidecar Adapter",
    async () => {
      const root = mkdtempSync(resolve(tmpdir(), "crossagent-bridge-worker-proof-live-"));
      const entry = resolve(root, "cli.js");
      writeFileSync(entry, "", "utf8");
      const lifecycle: { current?: BridgeWorkerProofLifecycle } = {};

      const result = await startCodexBridgeProcess({
        entry,
        projectId: "prj_test",
        agentId: "codex",
        workerProofMode: "required",
        rootDir: root,
        startupProbeDelayMs: 0,
        buildIdentity: testBuildIdentity,
        adapters: {
          processExists: (pid) => pid === 40_712,
          hardenOwnerPrivateAcl: hardenWindowsOwnerPrivateAcl,
          verifyOwnerPrivateAcl: verifyWindowsOwnerPrivateAcl,
          spawnDetached: () => ({ pid: 40_712, unref: () => undefined }),
          afterSpawn: async (owner) => {
            await awaitCodexBridgeRunOwnership(owner, root);
            const files = codexBridgeRunFiles(owner.projectId, owner.agentId, owner.runId, root);
            lifecycle.current = await startBridgeWorkerProofLifecycle({
              controlPath: files.pidPath,
              sidecarPath: files.workerProofPath,
              pid: owner.pid,
              subject: {
                schemaVersion: 1,
                projectId: owner.projectId,
                agentId: "codex",
                runId: owner.runId,
                threadId: null,
                build: testBuildIdentity,
              },
              windowsOwnerPrivateAclHardener: hardenWindowsOwnerPrivateAcl,
              windowsOwnerPrivateAclVerifier: verifyWindowsOwnerPrivateAcl,
            });
          },
        },
      });

      try {
        expect(await probeCodexBridgeRunWorkerProof(result.record, root)).toBe("VERIFIED");
        const files = codexBridgeRunFiles("prj_test", "codex", result.record.runId!, root);
        unlinkSync(files.workerProofPath);
        expect(await probeCodexBridgeRunWorkerProof(result.record, root)).toBe("INVALID");
      } finally {
        await lifecycle.current?.close("STOPPED");
      }
    },
    15_000,
  );

  it("redacts private launch authority from user-visible status JSON", () => {
    const record = {
      pid: 40_600,
      projectId: "prj_test",
      agentId: "codex",
      runId: "run_public",
      ownerNonce: "owner-proof-canary",
      threadId: "thr_public",
      launchReservation: issuedReservation("run_public", "thr_public"),
      startedAt: new Date().toISOString(),
      entry: "cli.js",
      logPath: "bridge.log",
    };

    const serialized = JSON.stringify(publicCodexBridgeRecord(record));

    expect(serialized).not.toContain("ownerNonce");
    expect(serialized).not.toContain("owner-proof-canary");
    expect(serialized).not.toContain("launchReservation");
    expect(serialized).not.toContain("rsr_run_public");
    expect(serialized).toContain("run_public");
    expect(serialized).toContain("thr_public");
  });

  it("does not report stale state when no managed Bridge has been recorded", () => {
    const root = mkdtempSync(resolve(tmpdir(), "crossagent-bridge-empty-"));

    expect(clearStaleCodexBridgePid("prj_test", "codex", root)).toBe(false);
  });

  it("uses stable, filesystem-safe paths without exposing raw agent text", () => {
    const root = resolve(tmpdir(), "crossagent-path-test");
    const first = codexBridgeFiles("prj_1234", "codex/../../unsafe agent", root);
    const second = codexBridgeFiles("prj_1234", "codex/../../unsafe agent", root);

    expect(first).toEqual(second);
    expect(first.pidPath.startsWith(resolve(root, "bridges"))).toBe(true);
    expect(first.pidPath).not.toContain("..");
    expect(first.pidPath).not.toContain(" ");
  });

  it("removes a stale PID record without platform-specific process APIs", () => {
    const root = mkdtempSync(resolve(tmpdir(), "crossagent-bridge-manager-"));
    const projectId = "prj_test";
    const agentId = "codex";
    const files = codexBridgeFiles(projectId, agentId, root);
    mkdirSync(dirname(files.pidPath), { recursive: true });
    writeFileSync(
      files.pidPath,
      `${JSON.stringify({
        pid: 2_147_483_647,
        projectId,
        agentId,
        startedAt: new Date().toISOString(),
        entry: "missing.js",
        logPath: files.logPath,
      })}\n`,
      "utf8",
    );
    writeFileSync(files.stopPath, "stop\n", "utf8");
    writeFileSync(files.healthPath, '{"status":"degraded"}\n', "utf8");

    expect(readCodexBridgePid(projectId, agentId, root)?.pid).toBe(2_147_483_647);
    expect(clearStaleCodexBridgePid(projectId, agentId, root)).toBe(true);
    expect(existsSync(files.pidPath)).toBe(false);
    expect(existsSync(files.stopPath)).toBe(false);
    expect(existsSync(files.healthPath)).toBe(false);
  });

  it("cleans orphaned and malformed legacy control artifacts", async () => {
    for (const fixture of ["stop-only", "malformed-pid"] as const) {
      const root = mkdtempSync(resolve(tmpdir(), `crossagent-bridge-${fixture}-`));
      const files = codexBridgeFiles("prj_test", "codex", root);
      mkdirSync(dirname(files.stopPath), { recursive: true });
      writeFileSync(files.stopPath, "stop\n", "utf8");
      if (fixture === "malformed-pid") {
        writeFileSync(files.pidPath, "{not-json\n", "utf8");
      }

      await expect(
        stopCodexBridgeProcess(
          "prj_test",
          "codex",
          root,
          {},
          {
            processExists: () => true,
            maxWaitAttempts: 0,
          },
        ),
      ).resolves.toEqual({ stopped: false, stale: true });
      expect(existsSync(files.pidPath)).toBe(false);
      expect(existsSync(files.stopPath)).toBe(false);
      expect(existsSync(files.healthPath)).toBe(false);
    }
  });

  it("reports only health published by the currently recorded Bridge process", () => {
    const root = mkdtempSync(resolve(tmpdir(), "crossagent-bridge-health-"));
    const projectId = "prj_test";
    const agentId = "codex";
    const files = codexBridgeFiles(projectId, agentId, root);
    mkdirSync(dirname(files.pidPath), { recursive: true });
    writeFileSync(
      files.pidPath,
      `${JSON.stringify({
        pid: process.pid,
        projectId,
        agentId,
        startedAt: new Date().toISOString(),
        entry: "cli.js",
        logPath: files.logPath,
      })}\n`,
      "utf8",
    );
    writeCodexBridgeHealth(
      projectId,
      agentId,
      {
        status: "degraded",
        pid: process.pid,
        projectId,
        sessionId: "ses_test",
        threadId: "thr_test",
        hubSocketOpen: true,
        hubSocketAlive: true,
        appServerRpcAlive: true,
        notificationStreamAlive: false,
        hookCaptureBindingMode: "required",
        lastHubEventAt: "2026-07-30T01:00:00.000Z",
        lastAppServerRpcAt: "2026-07-30T01:00:01.000Z",
        lastNotificationAt: null,
        lastConfirmedPushAt: null,
        lastUnconfirmedPushAt: "2026-07-30T01:00:01.000Z",
        pendingMessageId: "msg_test",
        modelTransportState: "MODEL_READY",
        appServerRecoveryFuseGeneration: 0,
        degradedReason: "Codex never surfaced msg_test",
        updatedAt: "2026-07-30T01:00:02.000Z",
      },
      root,
    );

    expect(readCodexBridgeHealth(projectId, agentId, root)).toMatchObject({
      status: "degraded",
      pid: process.pid,
      pendingMessageId: "msg_test",
      degradedReason: expect.stringContaining("msg_test"),
    });

    writeCodexBridgeHealth(
      projectId,
      agentId,
      {
        status: "healthy",
        pid: process.pid + 1,
        projectId,
        sessionId: "ses_stale",
        threadId: "thr_test",
        hubSocketOpen: true,
        hubSocketAlive: true,
        appServerRpcAlive: true,
        notificationStreamAlive: true,
        hookCaptureBindingMode: "required",
        lastHubEventAt: null,
        lastAppServerRpcAt: "2026-07-30T01:00:02.000Z",
        lastNotificationAt: null,
        lastConfirmedPushAt: null,
        lastUnconfirmedPushAt: null,
        pendingMessageId: null,
        modelTransportState: "MODEL_READY",
        appServerRecoveryFuseGeneration: 0,
        degradedReason: null,
        updatedAt: "2026-07-30T01:00:03.000Z",
      },
      root,
    );
    expect(readCodexBridgeHealth(projectId, agentId, root)).toBeNull();
  });

  it("treats a PID-matched but stale health heartbeat as degraded", () => {
    expect(
      isCodexBridgeHealthStale(
        { updatedAt: "2026-07-30T01:00:00.000Z" },
        Date.parse("2026-07-30T01:00:10.000Z"),
      ),
    ).toBe(false);
    expect(
      isCodexBridgeHealthStale(
        { updatedAt: "2026-07-30T01:00:00.000Z" },
        Date.parse("2026-07-30T01:00:20.001Z"),
      ),
    ).toBe(true);
    expect(
      isCodexBridgeHealthStale({ updatedAt: "not-a-date" }, Date.parse("2026-07-30T01:00:10.000Z")),
    ).toBe(true);
  });

  it("treats a known-bad delivery link or non-healthy state as degraded", () => {
    const healthy = {
      status: "healthy" as const,
      hubSocketAlive: true,
      appServerRpcAlive: true,
      notificationStreamAlive: null,
    };
    expect(isCodexBridgeHealthDegraded(healthy)).toBe(false);
    expect(isCodexBridgeHealthDegraded({ ...healthy, hubSocketAlive: false })).toBe(true);
    expect(isCodexBridgeHealthDegraded({ ...healthy, appServerRpcAlive: false })).toBe(true);
    expect(isCodexBridgeHealthDegraded({ ...healthy, notificationStreamAlive: false })).toBe(true);
    expect(isCodexBridgeHealthDegraded({ ...healthy, status: "stopped" })).toBe(true);
  });

  it("consumes a managed stop request exactly once", () => {
    const root = mkdtempSync(resolve(tmpdir(), "crossagent-bridge-stop-"));
    const files = codexBridgeFiles("prj_test", "codex", root);
    mkdirSync(dirname(files.stopPath), { recursive: true });
    writeFileSync(files.stopPath, "stop\n", "utf8");

    expect(consumeCodexBridgeStopRequest("prj_test", "codex", root)).toBe(true);
    expect(consumeCodexBridgeStopRequest("prj_test", "codex", root)).toBe(false);
  });

  it("does not reserve or spawn when the same thread already has a live managed owner", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "crossagent-bridge-existing-"));
    const entry = resolve(root, "cli.js");
    writeFileSync(entry, "", "utf8");
    const live = new Set<number>();
    let nextPid = 41_000;
    let reserveCalls = 0;
    let spawnCalls = 0;
    const start = () =>
      startCodexBridgeProcess({
        entry,
        projectId: "prj_test",
        agentId: "codex",
        threadId: "thr_same",
        rootDir: root,
        startupProbeDelayMs: 0,
        reserveLaunch: async ({ runId, threadId }) => {
          reserveCalls += 1;
          return issuedReservation(runId, threadId);
        },
        adapters: {
          processExists: (pid) => live.has(pid),
          spawnDetached: () => {
            spawnCalls += 1;
            const pid = nextPid++;
            live.add(pid);
            return { pid, unref: () => undefined };
          },
          afterSpawn: async (owner) => {
            await awaitCodexBridgeRunOwnership(owner, root);
            expect(writeCodexBridgeRunOwnerLease(owner, root)).toBe(true);
          },
        },
      });

    const first = await start();
    const second = await start();

    expect(first.alreadyRunning).toBe(false);
    expect(second).toEqual({ record: first.record, alreadyRunning: true });
    expect(reserveCalls).toBe(1);
    expect(spawnCalls).toBe(1);
  });

  it("refuses a successor when a live managed owner has matching but briefly stale proof", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "crossagent-bridge-stalled-owner-"));
    const entry = resolve(root, "cli.js");
    writeFileSync(entry, "", "utf8");
    const live = new Set<number>();
    let reserveCalls = 0;
    let spawnCalls = 0;
    const start = () =>
      startCodexBridgeProcess({
        entry,
        projectId: "prj_test",
        agentId: "codex",
        threadId: "thr_stalled_owner",
        rootDir: root,
        startupProbeDelayMs: 0,
        reserveLaunch: async ({ runId, threadId }) => {
          reserveCalls += 1;
          return issuedReservation(runId, threadId);
        },
        adapters: {
          processExists: (pid) => live.has(pid),
          spawnDetached: () => {
            spawnCalls += 1;
            live.add(41_500);
            return { pid: 41_500, unref: () => undefined };
          },
          afterSpawn: async (owner) => {
            await awaitCodexBridgeRunOwnership(owner, root);
            expect(writeCodexBridgeRunOwnerLease(owner, root)).toBe(true);
          },
        },
      });

    const first = await start();
    const files = codexBridgeRunFiles(
      first.record.projectId,
      first.record.agentId,
      first.record.runId!,
      root,
    );
    const proof = JSON.parse(readFileSync(files.ownerPath, "utf8")) as Record<string, unknown>;
    writeFileSync(
      files.ownerPath,
      `${JSON.stringify({ ...proof, updatedAt: "2000-01-01T00:00:00.000Z" })}\n`,
      "utf8",
    );

    await expect(start()).rejects.toThrow(/live managed Codex Bridge.*stale owner proof/iu);
    expect(reserveCalls).toBe(1);
    expect(spawnCalls).toBe(1);
  });

  it("serializes concurrent starts before reservation so one thread gets one run owner", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "crossagent-bridge-concurrent-"));
    const entry = resolve(root, "cli.js");
    writeFileSync(entry, "", "utf8");
    const live = new Set<number>();
    let reserveCalls = 0;
    let spawnCalls = 0;
    const start = () =>
      startCodexBridgeProcess({
        entry,
        projectId: "prj_test",
        agentId: "codex",
        threadId: "thr_race",
        rootDir: root,
        startupProbeDelayMs: 0,
        reserveLaunch: async ({ runId, threadId }) => {
          reserveCalls += 1;
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 40));
          return issuedReservation(runId, threadId);
        },
        adapters: {
          processExists: (pid) => live.has(pid),
          spawnDetached: () => {
            spawnCalls += 1;
            live.add(42_000);
            return { pid: 42_000, unref: () => undefined };
          },
          afterSpawn: async (owner) => {
            await awaitCodexBridgeRunOwnership(owner, root);
            expect(writeCodexBridgeRunOwnerLease(owner, root)).toBe(true);
          },
        },
      });

    const [first, second] = await Promise.all([start(), start()]);

    expect(new Set([first.record.runId, second.record.runId]).size).toBe(1);
    expect([first.alreadyRunning, second.alreadyRunning].sort()).toEqual([false, true]);
    expect(reserveCalls).toBe(1);
    expect(spawnCalls).toBe(1);
  });

  it("keeps a launch lock whose nonce-bound lease is still fresh", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "crossagent-bridge-live-lock-"));
    const entry = resolve(root, "cli.js");
    writeFileSync(entry, "", "utf8");
    const lockPath = codexBridgeLaunchLockPath("prj_test", "codex", "thr_locked", root);
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(
      lockPath,
      `${JSON.stringify({
        nonce: "lck_live",
        ownerPid: 99_001,
        createdAt: "2026-07-30T00:00:00.000Z",
      })}\n`,
      "utf8",
    );
    writeFileSync(`${lockPath}.lck_live.lease`, `${new Date().toISOString()}\n`, "utf8");
    let reserveCalls = 0;
    let spawnCalls = 0;

    await expect(
      startCodexBridgeProcess({
        entry,
        projectId: "prj_test",
        agentId: "codex",
        threadId: "thr_locked",
        rootDir: root,
        launchLockWaitMs: 60,
        reserveLaunch: async ({ runId, threadId }) => {
          reserveCalls += 1;
          return issuedReservation(runId, threadId);
        },
        adapters: {
          processExists: (pid) => pid === 99_001,
          spawnDetached: () => {
            spawnCalls += 1;
            return { pid: 99_002, unref: () => undefined };
          },
        },
      }),
    ).rejects.toThrow(/launch lock/i);

    expect(reserveCalls).toBe(0);
    expect(spawnCalls).toBe(0);
    expect(existsSync(lockPath)).toBe(true);
  });

  it("does not steal a stale launch lease while its recorded PID is still live", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "crossagent-bridge-reused-lock-pid-"));
    const entry = resolve(root, "cli.js");
    writeFileSync(entry, "", "utf8");
    const lockPath = codexBridgeLaunchLockPath("prj_test", "codex", "thr_reused_lock", root);
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(
      lockPath,
      `${JSON.stringify({
        nonce: "lck_reused",
        ownerPid: 99_051,
        createdAt: "2026-07-30T00:00:00.000Z",
      })}\n`,
      "utf8",
    );
    let reserveCalls = 0;
    let spawnCalls = 0;

    await expect(
      startCodexBridgeProcess({
        entry,
        projectId: "prj_test",
        agentId: "codex",
        threadId: "thr_reused_lock",
        rootDir: root,
        launchLockWaitMs: 60,
        startupProbeDelayMs: 0,
        reserveLaunch: async ({ runId, threadId }) => {
          reserveCalls += 1;
          return issuedReservation(runId, threadId);
        },
        adapters: {
          processExists: (pid) => pid === 99_051,
          spawnDetached: () => {
            spawnCalls += 1;
            return { pid: 99_052, unref: () => undefined };
          },
        },
      }),
    ).rejects.toThrow(/launch lock/i);

    expect(reserveCalls).toBe(0);
    expect(spawnCalls).toBe(0);
    expect(existsSync(lockPath)).toBe(true);
  });

  it("recovers an expired launch lock only after its owner is dead", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "crossagent-bridge-dead-lock-"));
    const entry = resolve(root, "cli.js");
    writeFileSync(entry, "", "utf8");
    const lockPath = codexBridgeLaunchLockPath("prj_test", "codex", "thr_recover", root);
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(
      lockPath,
      `${JSON.stringify({
        nonce: "lck_dead",
        ownerPid: 99_101,
        createdAt: "2026-07-30T00:00:00.000Z",
      })}\n`,
      "utf8",
    );
    const live = new Set<number>();

    const result = await startCodexBridgeProcess({
      entry,
      projectId: "prj_test",
      agentId: "codex",
      threadId: "thr_recover",
      rootDir: root,
      startupProbeDelayMs: 0,
      reserveLaunch: async ({ runId, threadId }) => issuedReservation(runId, threadId),
      adapters: {
        processExists: (pid) => live.has(pid),
        spawnDetached: () => {
          live.add(99_102);
          return { pid: 99_102, unref: () => undefined };
        },
      },
    });

    expect(result.alreadyRunning).toBe(false);
    expect(result.record.threadId).toBe("thr_recover");
    expect(existsSync(lockPath)).toBe(false);
  });

  it("restores a successor lock that appears in the stale-owner verify-to-rename window", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "crossagent-bridge-launch-lock-aba-"));
    const entry = resolve(root, "cli.js");
    writeFileSync(entry, "", "utf8");
    const lockPath = codexBridgeLaunchLockPath("prj_test", "codex", "thr_lock_aba", root);
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(
      lockPath,
      `${JSON.stringify({
        nonce: "lck_stale_before_aba",
        ownerPid: 99_151,
        createdAt: "2026-01-01T00:00:00.000Z",
      })}\n`,
      "utf8",
    );
    let replaced = false;
    let reserveCalls = 0;

    await expect(
      startCodexBridgeProcess({
        entry,
        projectId: "prj_test",
        agentId: "codex",
        threadId: "thr_lock_aba",
        rootDir: root,
        launchLockWaitMs: 60,
        reserveLaunch: async ({ runId, threadId }) => {
          reserveCalls += 1;
          return issuedReservation(runId, threadId);
        },
        adapters: {
          processExists: (pid) => pid === 99_152,
          afterLaunchLockOwnerVerified: (currentPath, expectedNonce) => {
            if (replaced || expectedNonce !== "lck_stale_before_aba") return;
            replaced = true;
            unlinkSync(currentPath);
            writeFileSync(
              currentPath,
              `${JSON.stringify({
                nonce: "lck_live_successor",
                ownerPid: 99_152,
                createdAt: new Date().toISOString(),
              })}\n`,
              "utf8",
            );
          },
          spawnDetached: () => ({ pid: 99_153, unref: () => undefined }),
        },
      }),
    ).rejects.toThrow(/launch lock/i);

    expect(replaced).toBe(true);
    expect(reserveCalls).toBe(0);
    expect(JSON.parse(readFileSync(lockPath, "utf8"))).toMatchObject({
      nonce: "lck_live_successor",
      ownerPid: 99_152,
    });
  });

  it("keeps different Codex threads in independent managed run records", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "crossagent-bridge-threads-"));
    const entry = resolve(root, "cli.js");
    writeFileSync(entry, "", "utf8");
    const live = new Set<number>();
    let nextPid = 50_000;
    const start = (threadId: string) =>
      startCodexBridgeProcess({
        entry,
        projectId: "prj_test",
        agentId: "codex",
        threadId,
        rootDir: root,
        startupProbeDelayMs: 0,
        reserveLaunch: async ({ runId, threadId: reservedThreadId }) =>
          issuedReservation(runId, reservedThreadId),
        adapters: {
          processExists: (pid) => live.has(pid),
          spawnDetached: () => {
            const pid = nextPid++;
            live.add(pid);
            return { pid, unref: () => undefined };
          },
        },
      });

    const first = await start("thr_one");
    const second = await start("thr_two");

    expect(first.record.runId).not.toBe(second.record.runId);
    expect(listCodexBridgePids("prj_test", "codex", root)).toHaveLength(2);
    expect(selectCodexBridgePids("prj_test", "codex", { threadId: "thr_one" }, root)).toEqual([
      first.record,
    ]);
    expect(selectCodexBridgePids("prj_test", "codex", { threadId: "thr_two" }, root)).toEqual([
      second.record,
    ]);
  });

  it("promotes a managed new-thread run into the real thread identity", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "crossagent-bridge-promote-"));
    const entry = resolve(root, "cli.js");
    writeFileSync(entry, "", "utf8");
    const result = await startCodexBridgeProcess({
      entry,
      projectId: "prj_test",
      agentId: "codex",
      rootDir: root,
      startupProbeDelayMs: 0,
      adapters: {
        processExists: (pid) => pid === 51_000,
        spawnDetached: () => ({ pid: 51_000, unref: () => undefined }),
      },
    });
    const owner = {
      projectId: "prj_test",
      agentId: "codex",
      runId: result.record.runId!,
      ownerNonce: result.record.ownerNonce!,
      pid: result.record.pid,
    };

    expect(result.record.threadId).toBeNull();
    const promoted = promoteCodexBridgeRunThread(owner, "thr_created", root);

    expect(promoted.threadId).toBe("thr_created");
    expect(selectCodexBridgePids("prj_test", "codex", { threadId: "thr_created" }, root)).toEqual([
      promoted,
    ]);
  });

  it("binds stop and cleanup control to the exact run, pid, and owner nonce", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "crossagent-bridge-control-"));
    const entry = resolve(root, "cli.js");
    writeFileSync(entry, "", "utf8");
    const live = new Set<number>();
    let nextPid = 52_000;
    const start = (threadId: string) =>
      startCodexBridgeProcess({
        entry,
        projectId: "prj_test",
        agentId: "codex",
        threadId,
        rootDir: root,
        startupProbeDelayMs: 0,
        reserveLaunch: async ({ runId, threadId: reservedThreadId }) =>
          issuedReservation(runId, reservedThreadId),
        adapters: {
          processExists: (pid) => live.has(pid),
          spawnDetached: () => {
            const pid = nextPid++;
            live.add(pid);
            return { pid, unref: () => undefined };
          },
        },
      });
    const first = (await start("thr_control_one")).record;
    const second = (await start("thr_control_two")).record;
    const firstOwner = {
      projectId: first.projectId,
      agentId: first.agentId,
      runId: first.runId!,
      ownerNonce: first.ownerNonce!,
      pid: first.pid,
    };
    const secondOwner = {
      projectId: second.projectId,
      agentId: second.agentId,
      runId: second.runId!,
      ownerNonce: second.ownerNonce!,
      pid: second.pid,
    };
    const secondFiles = codexBridgeRunFiles(second.projectId, second.agentId, second.runId!, root);
    writeFileSync(
      secondFiles.stopPath,
      `${JSON.stringify({ ...secondOwner, requestedAt: new Date().toISOString() })}\n`,
      "utf8",
    );

    expect(consumeCodexBridgeRunStopRequest(firstOwner, root)).toBe(false);
    expect(existsSync(secondFiles.stopPath)).toBe(true);
    expect(consumeCodexBridgeRunStopRequest(secondOwner, root)).toBe(true);
    expect(
      clearCodexBridgeRunIfOwned(
        { ...firstOwner, ownerNonce: secondOwner.ownerNonce },
        { terminalCleanup: "NOT_ATTEMPTED" },
        root,
      ),
    ).toBe(false);
    expect(listCodexBridgePids("prj_test", "codex", root)).toHaveLength(2);
    expect(clearCodexBridgeRunIfOwned(firstOwner, { terminalCleanup: "NOT_ATTEMPTED" }, root)).toBe(
      true,
    );
    expect(listCodexBridgePids("prj_test", "codex", root)).toEqual([second]);
  });

  it("lets a child self-promote its STARTING record after the launcher crashes post-spawn", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "crossagent-bridge-post-spawn-"));
    const entry = resolve(root, "cli.js");
    writeFileSync(entry, "", "utf8");

    await expect(
      startCodexBridgeProcess({
        entry,
        projectId: "prj_test",
        agentId: "codex",
        threadId: "thr_crash",
        rootDir: root,
        startupProbeDelayMs: 0,
        reserveLaunch: async ({ runId, threadId }) => issuedReservation(runId, threadId),
        adapters: {
          processExists: (pid) => pid === 53_000,
          spawnDetached: () => ({ pid: 53_000, unref: () => undefined }),
          afterSpawn: async (owner) => {
            await awaitCodexBridgeRunOwnership(owner, root);
            throw new Error("launcher crashed after spawn");
          },
        },
      }),
    ).rejects.toThrow(/crashed after spawn/i);

    const [survivor] = listCodexBridgePids("prj_test", "codex", root);
    expect(survivor).toMatchObject({
      pid: 53_000,
      threadId: "thr_crash",
      runId: expect.any(String),
      ownerNonce: expect.any(String),
    });
  });

  it("lets the exact child read its private handoff after the launcher promoted it to RUNNING", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "crossagent-bridge-parent-first-"));
    const entry = resolve(root, "cli.js");
    writeFileSync(entry, "", "utf8");
    let controlPath = "";
    let childContext: ReturnType<typeof readCodexBridgeManagedLaunchContext> | null = null;

    const result = await startCodexBridgeProcess({
      entry,
      projectId: "prj_test",
      agentId: "codex",
      threadId: "thr_parent_first",
      rootDir: root,
      startupProbeDelayMs: 0,
      reserveLaunch: async ({ runId, threadId }) => issuedReservation(runId, threadId),
      adapters: {
        processExists: (pid) => pid === 53_050,
        spawnDetached: (_command, args) => {
          controlPath = args[args.indexOf("--bridge-control-path") + 1]!;
          return { pid: 53_050, unref: () => undefined };
        },
        afterSpawn: async (owner) => {
          await awaitCodexBridgeRunOwnership(owner, root);
          childContext = readCodexBridgeManagedLaunchContext({
            controlPath,
            projectId: owner.projectId,
            agentId: owner.agentId,
            runId: owner.runId,
            pid: owner.pid,
            rootDir: root,
          });
        },
      },
    });

    expect(childContext).toEqual({
      buildIdentity: testBuildIdentity,
      owner: {
        projectId: "prj_test",
        agentId: "codex",
        runId: result.record.runId,
        ownerNonce: result.record.ownerNonce,
        pid: 53_050,
      },
      launchReservation: result.record.launchReservation,
      projectAttachment: { projectId: "prj_test", root },
    });
    expect(
      readCodexBridgeManagedBuildIdentity({
        controlPath,
        projectId: "prj_test",
        agentId: "codex",
        runId: result.record.runId!,
        pid: 53_050,
        rootDir: root,
      }),
    ).toEqual(testBuildIdentity);
    expect(() =>
      readCodexBridgeManagedBuildIdentity({
        controlPath,
        projectId: "prj_test",
        agentId: "codex",
        runId: result.record.runId!,
        pid: 53_051,
        rootDir: root,
      }),
    ).toThrow(/not claimable/i);
    expect(() =>
      readCodexBridgeManagedLaunchContext({
        controlPath,
        projectId: "prj_test",
        agentId: "codex",
        runId: result.record.runId!,
        pid: 53_051,
        rootDir: root,
      }),
    ).toThrow(/not claimable/i);
    const privateHandoff = JSON.parse(readFileSync(controlPath, "utf8")) as Record<string, unknown>;
    const legacyBuildIdentity = Object.fromEntries(
      Object.entries(testBuildIdentity).filter(([key]) => key !== "migrationId"),
    );
    writeFileSync(
      controlPath,
      `${JSON.stringify({ ...privateHandoff, buildIdentity: legacyBuildIdentity })}\n`,
      "utf8",
    );
    expect(() =>
      readCodexBridgeManagedBuildIdentity({
        controlPath,
        projectId: "prj_test",
        agentId: "codex",
        runId: result.record.runId!,
        pid: 53_050,
        rootDir: root,
      }),
    ).toThrow(/not claimable/i);
    writeFileSync(
      controlPath,
      `${JSON.stringify({
        ...privateHandoff,
        buildIdentity: { ...testBuildIdentity, buildId: "not-a-build-hash" },
      })}\n`,
      "utf8",
    );
    expect(() =>
      readCodexBridgeManagedBuildIdentity({
        controlPath,
        projectId: "prj_test",
        agentId: "codex",
        runId: result.record.runId!,
        pid: 53_050,
        rootDir: root,
      }),
    ).toThrow(/not claimable/i);
    expect(() =>
      readCodexBridgeManagedLaunchContext({
        controlPath,
        projectId: "prj_test",
        agentId: "codex",
        runId: result.record.runId!,
        pid: 53_050,
        rootDir: root,
      }),
    ).toThrow(/not claimable/i);
  });

  it("rejects an undeclared launcher wrapper before reservation or spawn", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "crossagent-bridge-wrapper-"));
    const wrapper = resolve(root, "wrapper.js");
    const verifiedEntry = resolve(root, "verified", "bin.js");
    writeFileSync(wrapper, "import './verified/bin.js';\n", "utf8");
    const verify = vi
      .spyOn(buildIdentityModule, "verifiedCliReleaseEntrypoint")
      .mockReturnValue(verifiedEntry);
    vi.stubEnv("NODE_ENV", "production");
    const reserveLaunch = vi.fn(async ({ runId, threadId }) => issuedReservation(runId, threadId));
    const spawnDetached = vi.fn(() => ({ pid: 53_060, unref: () => undefined }));
    try {
      await expect(
        startCodexBridgeProcess({
          entry: wrapper,
          projectId: "prj_test",
          agentId: "codex",
          threadId: "thr_wrapper",
          rootDir: root,
          buildIdentity: testBuildIdentity,
          reserveLaunch,
          adapters: { processExists: () => false, spawnDetached },
        }),
      ).rejects.toThrow(/not the verified CLI release entrypoint/i);
      expect(reserveLaunch).not.toHaveBeenCalled();
      expect(spawnDetached).not.toHaveBeenCalled();
    } finally {
      verify.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("never resurrects a FAILED startup tombstone after the child reported failure", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "crossagent-bridge-failed-race-"));
    const entry = resolve(root, "cli.js");
    writeFileSync(entry, "", "utf8");

    await expect(
      startCodexBridgeProcess({
        entry,
        projectId: "prj_test",
        agentId: "codex",
        threadId: "thr_failed_race",
        rootDir: root,
        startupProbeDelayMs: 0,
        reserveLaunch: async ({ runId, threadId }) => issuedReservation(runId, threadId),
        adapters: {
          processExists: (pid) => pid === 53_100,
          spawnDetached: () => ({ pid: 53_100, unref: () => undefined }),
          afterSpawn: async (owner) => {
            await awaitCodexBridgeRunOwnership(owner, root);
            expect(
              markCodexBridgeRunFailedIfOwned(
                owner,
                "Hub registration retry budget exhausted",
                { terminalCleanup: "NOT_ATTEMPTED" },
                root,
              ),
            ).toBe(true);
          },
        },
      }),
    ).rejects.toThrow(/registration retry budget exhausted/i);

    expect(listCodexBridgePids("prj_test", "codex", root)).toEqual([]);
    expect(listCodexBridgeFailedRuns("prj_test", "codex", root)).toEqual([
      expect.objectContaining({
        pid: 53_100,
        threadId: "thr_failed_race",
        failure: "Hub registration retry budget exhausted",
      }),
    ]);
  });

  it("removes STARTING authority when spawn itself fails", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "crossagent-bridge-spawn-fail-"));
    const entry = resolve(root, "cli.js");
    writeFileSync(entry, "", "utf8");

    await expect(
      startCodexBridgeProcess({
        entry,
        projectId: "prj_test",
        agentId: "codex",
        threadId: "thr_spawn_fail",
        rootDir: root,
        reserveLaunch: async ({ runId, threadId }) => issuedReservation(runId, threadId),
        adapters: {
          processExists: () => false,
          spawnDetached: () => {
            throw new Error("spawn failed");
          },
        },
      }),
    ).rejects.toThrow(/spawn failed/i);

    expect(listCodexBridgePids("prj_test", "codex", root)).toEqual([]);
  });

  it("retries a lost reservation response with the same run and idempotency key", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "crossagent-bridge-reserve-retry-"));
    const entry = resolve(root, "cli.js");
    writeFileSync(entry, "", "utf8");
    const requests: Array<{ runId: string; idempotencyKey: string }> = [];
    let childArgs: string[] = [];
    let childEnvironment: NodeJS.ProcessEnv = {};
    let launchContext: ReturnType<typeof readCodexBridgeManagedLaunchContext> | null = null;

    const result = await startCodexBridgeProcess({
      entry,
      projectId: "prj_test",
      agentId: "codex",
      threadId: "thr_retry",
      rootDir: root,
      startupProbeDelayMs: 0,
      reserveLaunch: async (request) => {
        requests.push({
          runId: request.runId,
          idempotencyKey: request.idempotencyKey,
        });
        if (requests.length === 1) throw new TypeError("fetch failed");
        return issuedReservation(request.runId, request.threadId);
      },
      adapters: {
        processExists: (pid) => pid === 54_000,
        spawnDetached: (_command, args, _logPath, environment) => {
          childArgs = args;
          childEnvironment = environment;
          const controlIndex = args.indexOf("--bridge-control-path");
          launchContext = readCodexBridgeManagedLaunchContext({
            controlPath: args[controlIndex + 1]!,
            projectId: "prj_test",
            agentId: "codex",
            runId: args[args.indexOf("--bridge-run-id") + 1]!,
            pid: 54_000,
            rootDir: root,
          });
          return { pid: 54_000, unref: () => undefined };
        },
      },
    });

    expect(requests).toHaveLength(2);
    expect(requests[0]).toEqual(requests[1]);
    expect(requests[0]?.runId).toBe(result.record.runId);
    expect(childArgs).not.toContain("--launch-reservation");
    expect(childArgs).not.toContain("--bridge-owner-nonce");
    expect(childArgs).not.toContain(result.record.ownerNonce);
    expect(childArgs[childArgs.indexOf("--bridge-run-id") + 1]).toBe(result.record.runId);
    const controlPath = childArgs[childArgs.indexOf("--bridge-control-path") + 1]!;
    expect(controlPath).toBe(
      codexBridgeRunFiles("prj_test", "codex", result.record.runId!, root).pidPath,
    );
    expect(launchContext).toEqual({
      buildIdentity: testBuildIdentity,
      owner: {
        projectId: "prj_test",
        agentId: "codex",
        runId: result.record.runId,
        ownerNonce: result.record.ownerNonce,
        pid: 54_000,
      },
      launchReservation: result.record.launchReservation,
      projectAttachment: { projectId: "prj_test", root },
    });
    expect(childEnvironment).toEqual(
      managedCodexBridgeEnvironment({
        ...process.env,
        CROSSAGENT_DATA_DIR: root,
      }),
    );
    if (process.platform !== "win32") {
      expect(statSync(controlPath).mode & 0o077).toBe(0);
    }
  });

  it("fails closed before reservation or spawn when exact recovery has no matching run authority", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "crossagent-bridge-exact-run-"));
    const entry = resolve(root, "cli.js");
    writeFileSync(entry, "", "utf8");
    let reservations = 0;
    let spawns = 0;

    await expect(
      startCodexBridgeProcess({
        entry,
        projectId: "prj_test",
        agentId: "codex",
        threadId: "thr_exact",
        expectedRunId: "run_expected",
        rootDir: root,
        startupProbeDelayMs: 0,
        reserveLaunch: async (request) => {
          reservations += 1;
          return issuedReservation(request.runId, request.threadId);
        },
        adapters: {
          processExists: () => false,
          spawnDetached: () => {
            spawns += 1;
            return { pid: 54_001, unref: () => undefined };
          },
        },
      }),
    ).rejects.toThrow("no recovery authority for the expected run");

    expect(reservations).toBe(0);
    expect(spawns).toBe(0);
    expect(existsSync(codexBridgeRunFiles("prj_test", "codex", "run_expected", root).pidPath)).toBe(
      false,
    );
  });

  it("keeps a v2 reservation status/stop-only and never restores it as launch authority", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "crossagent-bridge-v2-control-"));
    const entry = resolve(root, "cli.js");
    writeFileSync(entry, "", "utf8");
    const files = codexBridgeRunFiles("prj_test", "codex", "run_v2", root);
    mkdirSync(dirname(files.pidPath), { recursive: true });
    writeFileSync(
      files.pidPath,
      `${JSON.stringify({
        version: 2,
        state: "RESERVING",
        pid: null,
        projectId: "prj_test",
        agentId: "codex",
        runId: "run_v2",
        ownerNonce: "legacy-owner-proof",
        threadId: "thr_v2",
        launchReservation: null,
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        entry,
        logPath: files.logPath,
      })}\n`,
      "utf8",
    );
    let reserveCalls = 0;
    let spawnCalls = 0;

    await expect(
      startCodexBridgeProcess({
        entry,
        projectId: "prj_test",
        agentId: "codex",
        threadId: "thr_v2",
        rootDir: root,
        reserveLaunch: async ({ runId, threadId }) => {
          reserveCalls += 1;
          return issuedReservation(runId, threadId);
        },
        adapters: {
          processExists: () => false,
          spawnDetached: () => {
            spawnCalls += 1;
            return { pid: 54_050, unref: () => undefined };
          },
        },
      }),
    ).rejects.toThrow(/v2 reservation.*status\/stop-only.*cannot be resumed/i);
    expect(reserveCalls).toBe(0);
    expect(spawnCalls).toBe(0);

    await expect(
      stopCodexBridgeProcess(
        "prj_test",
        "codex",
        root,
        { runId: "run_v2" },
        { processExists: () => false, maxWaitAttempts: 0 },
      ),
    ).resolves.toMatchObject({ stopped: true, cancelled: true, runId: "run_v2" });
  });

  it("reuses the exact run and whole ACTIVE vault after a hard managed-process crash", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "crossagent-bridge-ticket-reentry-"));
    const entry = resolve(root, "cli.js");
    writeFileSync(entry, "", "utf8");
    const live = new Set<number>();
    const reservations: string[] = [];
    let nextPid = 59_000;
    let durable: CodexSessionTicketVaultSnapshot | null = null;
    const start = () =>
      startCodexBridgeProcess({
        entry,
        projectId: "prj_test",
        agentId: "codex",
        threadId: "thr_reentry",
        rootDir: root,
        startupProbeDelayMs: 0,
        reserveLaunch: async ({ runId, threadId }) => {
          reservations.push(runId);
          const reservation = {
            ...issuedReservation(runId, threadId),
            lineageId: "lin_managed_reentry",
          };
          return reservations.length === 1
            ? reservation
            : {
                ...reservation,
                state: "CONSUMED" as const,
                consumedSessionId: "ses_managed_reentry",
              };
        },
        adapters: {
          processExists: (pid) => live.has(pid),
          spawnDetached: (_command, args) => {
            const pid = nextPid++;
            live.add(pid);
            if (durable !== null) {
              expect(
                readCodexBridgeManagedLaunchContext({
                  controlPath: args[args.indexOf("--bridge-control-path") + 1]!,
                  projectId: "prj_test",
                  agentId: "codex",
                  runId: args[args.indexOf("--bridge-run-id") + 1]!,
                  pid,
                  rootDir: root,
                }).launchReservation?.state,
              ).toBe("CONSUMED");
            }
            return { pid, unref: () => undefined };
          },
          afterSpawn: async (owner) => {
            const vault = new FileCodexSessionTicketVault({
              projectId: owner.projectId,
              runId: owner.runId,
              rootDir: root,
            });
            if (durable === null) {
              durable = activeTicketSnapshot(owner.projectId, owner.runId, "thr_reentry", root);
              await vault.save(durable);
            } else {
              await expect(vault.load()).resolves.toEqual(durable);
            }
          },
        },
      });

    const first = await start();
    live.delete(first.record.pid); // OS-level crash: no Bridge stop/close outcome exists.
    expect(
      clearCodexBridgeRunIfOwned(
        {
          projectId: first.record.projectId,
          agentId: first.record.agentId,
          runId: first.record.runId!,
          ownerNonce: first.record.ownerNonce!,
          pid: first.record.pid,
        },
        { terminalCleanup: "NOT_ATTEMPTED" },
        root,
      ),
    ).toBe(true);
    const second = await start();

    expect(first.record.runId).toBe(second.record.runId);
    expect(first.record.ownerNonce).not.toBe(second.record.ownerNonce);
    expect(second.record.pid).not.toBe(first.record.pid);
    expect(reservations).toEqual([first.record.runId, first.record.runId]);
    await expect(
      new FileCodexSessionTicketVault({
        projectId: "prj_test",
        runId: second.record.runId!,
        rootDir: root,
      }).load(),
    ).resolves.toEqual(durable);
  });

  it("keeps startup-probe death ACTIVE and reuses its consumed reservation on the next launch", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "crossagent-bridge-startup-probe-reentry-"));
    const entry = resolve(root, "cli.js");
    writeFileSync(entry, "", "utf8");
    const live = new Set<number>();
    const reservations: string[] = [];
    let nextPid = 59_050;
    let firstSpawn = true;
    let durable: CodexSessionTicketVaultSnapshot | null = null;
    const start = () =>
      startCodexBridgeProcess({
        entry,
        projectId: "prj_test",
        agentId: "codex",
        threadId: "thr_startup_probe_reentry",
        rootDir: root,
        startupProbeDelayMs: 0,
        reserveLaunch: async ({ runId, threadId }) => {
          reservations.push(runId);
          const reservation = {
            ...issuedReservation(runId, threadId),
            lineageId: "lin_managed_reentry",
          };
          return reservations.length === 1
            ? reservation
            : {
                ...reservation,
                state: "CONSUMED" as const,
                consumedSessionId: "ses_managed_reentry",
              };
        },
        adapters: {
          processExists: (pid) => live.has(pid),
          spawnDetached: () => {
            const pid = nextPid++;
            if (!firstSpawn) live.add(pid);
            return { pid, unref: () => undefined };
          },
          afterSpawn: async (owner) => {
            const vault = new FileCodexSessionTicketVault({
              projectId: owner.projectId,
              runId: owner.runId,
              rootDir: root,
            });
            if (firstSpawn) {
              firstSpawn = false;
              durable = activeTicketSnapshot(
                owner.projectId,
                owner.runId,
                "thr_startup_probe_reentry",
                root,
              );
              await vault.save(durable);
            } else {
              await expect(vault.load()).resolves.toEqual(durable);
            }
          },
        },
      });

    await expect(start()).rejects.toThrow(/exited during startup/i);
    const failed = listCodexBridgeFailedRuns("prj_test", "codex", root);
    expect(failed).toHaveLength(1);
    const replacement = await start();

    expect(reservations).toEqual([failed[0]!.runId, failed[0]!.runId]);
    expect(replacement.record.runId).toBe(failed[0]!.runId);
    expect(replacement.record.launchReservation?.state).toBe("CONSUMED");
  });

  it("proves a consumed launch from immutable ancestry after CURRENT_HEAD changed the live session", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "crossagent-bridge-consumed-ancestry-"));
    const entry = resolve(root, "cli.js");
    writeFileSync(entry, "", "utf8");
    const runId = "run_consumed_ancestry";
    const initialSessionId = "ses_managed_reentry";
    const currentSessionId = "ses_after_current_head";
    const durable = activeTicketSnapshot("prj_test", runId, "thr_consumed_ancestry", root);
    const current = durable.current!;
    const previousSessionId = current.sessionReceipt!.id;
    current.bundleId = "stb_after_current_head";
    current.context = {
      projectId: "prj_test",
      runId,
      activationMode: "CURRENT_HEAD_REPLACEMENT",
      externalSessionId: "thr_consumed_ancestry",
      externalThreadId: "thr_consumed_ancestry",
      expectedLineageId: "lin_managed_reentry",
      expectedHeadSessionId: previousSessionId,
    };
    current.offerIds = {
      CONTROL: "stk_replacement_control",
      MODEL_MCP: "stk_replacement_model",
      INJECTOR: "stk_replacement_injector",
    };
    current.binding = {
      ...current.binding!,
      bundleId: current.bundleId,
      hubSessionId: currentSessionId,
      incarnation: 2,
      purposes: (["CONTROL", "MODEL_MCP", "INJECTOR"] as const).map((purpose) => ({
        id: current.offerIds[purpose]!,
        purpose,
        state: "ACTIVE" as const,
      })),
    };
    current.sessionReceipt = {
      ...current.sessionReceipt!,
      id: currentSessionId,
      incarnation: 2,
      predecessorSessionId: previousSessionId,
      launcherRunId: null,
      launchGeneration: null,
    };
    current.launchSessionId = initialSessionId;
    current.registrationInput = {
      ...current.registrationInput!,
      expectedHeadSessionId: previousSessionId,
      launcherRunId: undefined,
      launchGeneration: undefined,
      idempotencyKey: `codex-current-head:${runId}:${previousSessionId}`,
    };
    const vault = new FileCodexSessionTicketVault({
      projectId: "prj_test",
      runId,
      rootDir: root,
    });
    await vault.save(durable);
    bindCodexSessionTicketRecoveryRun({
      projectId: "prj_test",
      threadId: "thr_consumed_ancestry",
      runId,
      rootDir: root,
    });
    let spawnCalls = 0;

    const replacement = await startCodexBridgeProcess({
      entry,
      projectId: "prj_test",
      agentId: "codex",
      threadId: "thr_consumed_ancestry",
      rootDir: root,
      startupProbeDelayMs: 0,
      reserveLaunch: async ({ runId: reservedRunId, threadId }) => ({
        ...issuedReservation(reservedRunId, threadId),
        lineageId: "lin_managed_reentry",
        state: "CONSUMED" as const,
        consumedSessionId: initialSessionId,
      }),
      adapters: {
        processExists: (pid) => pid === 59_075,
        spawnDetached: (_command, args) => {
          spawnCalls += 1;
          expect(
            readCodexBridgeManagedLaunchContext({
              controlPath: args[args.indexOf("--bridge-control-path") + 1]!,
              projectId: "prj_test",
              agentId: "codex",
              runId,
              pid: 59_075,
              rootDir: root,
            }).launchReservation?.state,
          ).toBe("CONSUMED");
          return { pid: 59_075, unref: () => undefined };
        },
      },
    });

    expect(replacement.record.runId).toBe(runId);
    expect(spawnCalls).toBe(1);
    await expect(vault.load()).resolves.toEqual(durable);
  });

  it("re-enters the exact ACTIVATING initial registration after its consumed response was lost", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "crossagent-bridge-activating-replay-"));
    const entry = resolve(root, "cli.js");
    writeFileSync(entry, "", "utf8");
    const runId = "run_activating_replay";
    const threadId = "thr_activating_replay";
    const durable = activeTicketSnapshot("prj_test", runId, threadId, root);
    const current = durable.current!;
    current.phase = "ACTIVATING";
    current.binding = null;
    current.sessionReceipt = null;
    current.launchSessionId = null;
    current.serverNow = null;
    current.observedAt = null;
    const vault = new FileCodexSessionTicketVault({
      projectId: "prj_test",
      runId,
      rootDir: root,
    });
    await vault.save(durable);
    bindCodexSessionTicketRecoveryRun({
      projectId: "prj_test",
      threadId,
      runId,
      rootDir: root,
    });
    let spawnCalls = 0;

    const result = await startCodexBridgeProcess({
      entry,
      projectId: "prj_test",
      agentId: "codex",
      threadId,
      rootDir: root,
      startupProbeDelayMs: 0,
      reserveLaunch: async ({ runId: reservedRunId, threadId: reservedThreadId }) => ({
        ...issuedReservation(reservedRunId, reservedThreadId),
        lineageId: "lin_managed_reentry",
        state: "CONSUMED" as const,
        consumedSessionId: "ses_registration_response_lost",
      }),
      adapters: {
        processExists: (pid) => pid === 59_085,
        spawnDetached: (_command, args) => {
          spawnCalls += 1;
          expect(
            readCodexBridgeManagedLaunchContext({
              controlPath: args[args.indexOf("--bridge-control-path") + 1]!,
              projectId: "prj_test",
              agentId: "codex",
              runId,
              pid: 59_085,
              rootDir: root,
            }).launchReservation?.consumedSessionId,
          ).toBe("ses_registration_response_lost");
          return { pid: 59_085, unref: () => undefined };
        },
      },
    });

    expect(result.record.runId).toBe(runId);
    expect(spawnCalls).toBe(1);
    await expect(vault.load()).resolves.toEqual(durable);
  });

  it("rejects malformed, unattempted, or wrong-reservation ACTIVATING recovery proofs", async () => {
    const cases = ["body", "unattempted", "reservation"] as const;
    for (const kind of cases) {
      const root = mkdtempSync(resolve(tmpdir(), `crossagent-bridge-activating-${kind}-`));
      const runId = `run_activating_${kind}`;
      const threadId = `thr_activating_${kind}`;
      const durable = activeTicketSnapshot("prj_test", runId, threadId, root);
      const current = durable.current!;
      current.phase = "ACTIVATING";
      current.binding = null;
      current.sessionReceipt = null;
      current.launchSessionId = null;
      current.serverNow = null;
      current.observedAt = null;
      if (kind === "body") {
        current.registrationInput = {
          ...current.registrationInput!,
          idempotencyKey: `wrong-body:${runId}`,
        };
      } else if (kind === "unattempted") {
        current.activationAttempted = false;
      }
      const vault = new FileCodexSessionTicketVault({
        projectId: "prj_test",
        runId,
        rootDir: root,
      });
      await vault.save(durable);
      bindCodexSessionTicketRecoveryRun({ projectId: "prj_test", threadId, runId, rootDir: root });
      const reservation = {
        ...issuedReservation(runId, threadId),
        lineageId: "lin_managed_reentry",
        generation: kind === "reservation" ? 2 : 1,
        state: "CONSUMED" as const,
        consumedSessionId: "ses_registration_response_lost",
      };

      expect(() =>
        assertCodexSessionTicketRecoveryReservation({
          projectId: "prj_test",
          threadId,
          runId,
          reservation,
          rootDir: root,
        }),
      ).toThrow(/recovery proof|registration replay proof/i);
    }
  });

  it("re-enters every durable CURRENT_HEAD cutover phase under the original consumed launch", async () => {
    const phases = [
      "HUB_ACTIVATING",
      "HUB_ACTIVATED",
      "CONTROL_READY",
      "MODEL_READY",
      "EVENTS_READY",
    ] as const;
    for (const [index, phase] of phases.entries()) {
      const root = mkdtempSync(resolve(tmpdir(), `crossagent-bridge-cutover-${phase}-`));
      const entry = resolve(root, "cli.js");
      writeFileSync(entry, "", "utf8");
      const runId = `run_cutover_${phase.toLowerCase()}`;
      const threadId = `thr_cutover_${phase.toLowerCase()}`;
      const durable = currentHeadCutoverSnapshot("prj_test", runId, threadId, root, phase);
      const vault = new FileCodexSessionTicketVault({
        projectId: "prj_test",
        runId,
        rootDir: root,
      });
      await vault.save(durable);
      bindCodexSessionTicketRecoveryRun({ projectId: "prj_test", threadId, runId, rootDir: root });
      let reserveCalls = 0;
      let spawnCalls = 0;

      const result = await startCodexBridgeProcess({
        entry,
        projectId: "prj_test",
        agentId: "codex",
        threadId,
        rootDir: root,
        startupProbeDelayMs: 0,
        reserveLaunch: async ({ runId: reservedRunId, threadId: reservedThreadId }) => {
          reserveCalls += 1;
          return {
            ...issuedReservation(reservedRunId, reservedThreadId),
            lineageId: "lin_managed_reentry",
            state: "CONSUMED" as const,
            consumedSessionId: "ses_managed_reentry",
          };
        },
        adapters: {
          processExists: (pid) => pid === 59_200 + index,
          spawnDetached: () => {
            spawnCalls += 1;
            return { pid: 59_200 + index, unref: () => undefined };
          },
        },
      });

      expect(result.record.runId).toBe(runId);
      expect(reserveCalls).toBe(1);
      expect(spawnCalls).toBe(1);
      await expect(vault.load()).resolves.toEqual(durable);
    }
  });

  it("re-enters every durable AUX cutover phase under the original consumed launch", async () => {
    const phases = [
      "HUB_ACTIVATING",
      "HUB_ACTIVATED",
      "CONTROL_READY",
      "MODEL_READY",
      "EVENTS_READY",
    ] as const;
    for (const [index, phase] of phases.entries()) {
      const root = mkdtempSync(resolve(tmpdir(), `crossagent-bridge-aux-${phase}-`));
      const entry = resolve(root, "cli.js");
      writeFileSync(entry, "", "utf8");
      const runId = `run_aux_${phase.toLowerCase()}`;
      const threadId = `thr_aux_${phase.toLowerCase()}`;
      const durable = auxiliaryCutoverSnapshot("prj_test", runId, threadId, root, phase);
      const vault = new FileCodexSessionTicketVault({
        projectId: "prj_test",
        runId,
        rootDir: root,
      });
      await vault.save(durable);
      bindCodexSessionTicketRecoveryRun({ projectId: "prj_test", threadId, runId, rootDir: root });
      let reserveCalls = 0;
      let spawnCalls = 0;

      const result = await startCodexBridgeProcess({
        entry,
        projectId: "prj_test",
        agentId: "codex",
        threadId,
        rootDir: root,
        startupProbeDelayMs: 0,
        reserveLaunch: async ({ runId: reservedRunId, threadId: reservedThreadId }) => {
          reserveCalls += 1;
          return {
            ...issuedReservation(reservedRunId, reservedThreadId),
            lineageId: "lin_managed_reentry",
            state: "CONSUMED" as const,
            consumedSessionId: "ses_managed_reentry",
          };
        },
        adapters: {
          processExists: (pid) => pid === 59_300 + index,
          spawnDetached: () => {
            spawnCalls += 1;
            return { pid: 59_300 + index, unref: () => undefined };
          },
        },
      });

      expect(result.record.runId).toBe(runId);
      expect(reserveCalls).toBe(1);
      expect(spawnCalls).toBe(1);
      await expect(vault.load()).resolves.toEqual(durable);
    }
  });

  it("rejects a consumed recovery successor with a missing or drifted cutover proof", async () => {
    const variants = ["missing", "operation", "mode"] as const;
    for (const variant of variants) {
      const root = mkdtempSync(resolve(tmpdir(), `crossagent-bridge-cutover-${variant}-`));
      const runId = `run_cutover_${variant}`;
      const threadId = `thr_cutover_${variant}`;
      const durable = currentHeadCutoverSnapshot(
        "prj_test",
        runId,
        threadId,
        root,
        "HUB_ACTIVATING",
      );
      if (variant === "missing") durable.cutover = null;
      if (variant === "operation") durable.cutover!.operationId = "wrong-cutover-operation";
      if (variant === "mode") durable.successor!.context.activationMode = "SESSION_AUXILIARY";
      const vault = new FileCodexSessionTicketVault({
        projectId: "prj_test",
        runId,
        rootDir: root,
      });
      if (variant === "mode") {
        await expect(vault.save(durable)).rejects.toThrow(/Invalid Codex session ticket vault/i);
        continue;
      }
      await vault.save(durable);
      bindCodexSessionTicketRecoveryRun({ projectId: "prj_test", threadId, runId, rootDir: root });
      expect(() =>
        assertCodexSessionTicketRecoveryReservation({
          projectId: "prj_test",
          threadId,
          runId,
          reservation: {
            ...issuedReservation(runId, threadId),
            lineageId: "lin_managed_reentry",
            state: "CONSUMED",
            consumedSessionId: "ses_managed_reentry",
          },
          rootDir: root,
        }),
      ).toThrow(/cutover|successor/i);
      expect(
        markCodexSessionTicketRecoveryDraining({
          projectId: "prj_test",
          threadId,
          runId,
          sessionId: durable.current!.sessionReceipt!.id,
          bundleId: durable.current!.bundleId,
          rootDir: root,
        }),
      ).toBe(false);
    }
  });

  it("refuses DRAINING when an ACTIVE successor receipt or binding drifts", async () => {
    const variants = [
      "receipt-binding",
      "receipt-session",
      "superseded",
      "binding",
      "stale-expiry",
    ] as const;
    for (const variant of variants) {
      const root = mkdtempSync(resolve(tmpdir(), `crossagent-bridge-close-receipt-${variant}-`));
      const runId = `run_close_receipt_${variant}`;
      const threadId = `thr_close_receipt_${variant}`;
      const durable = auxiliaryCutoverSnapshot("prj_test", runId, threadId, root, "EVENTS_READY");
      if (variant === "receipt-binding") {
        durable.successor!.rotationReceipt!.ticketBinding.expiresAt = "2026-08-02T04:00:02.000Z";
      } else if (variant === "receipt-session") {
        durable.successor!.rotationReceipt!.session.version += 1;
      } else if (variant === "superseded") {
        durable.successor!.rotationReceipt!.supersededTicketBinding.bundleId =
          "stb_wrong_predecessor";
      } else if (variant === "binding") {
        durable.successor!.binding!.hubSessionId = "ses_wrong_successor_binding";
      } else {
        const staleExpiry = durable.current!.binding!.expiresAt;
        durable.successor!.binding!.expiresAt = staleExpiry;
        durable.successor!.rotationReceipt!.ticketBinding.expiresAt = staleExpiry;
      }
      const vault = new FileCodexSessionTicketVault({
        projectId: "prj_test",
        runId,
        rootDir: root,
      });
      if (["receipt-binding", "receipt-session", "binding"].includes(variant)) {
        await expect(vault.save(durable)).rejects.toThrow(/Invalid Codex session ticket vault/i);
        continue;
      }
      await vault.save(durable);
      bindCodexSessionTicketRecoveryRun({ projectId: "prj_test", threadId, runId, rootDir: root });

      expect(
        markCodexSessionTicketRecoveryDraining({
          projectId: "prj_test",
          threadId,
          runId,
          sessionId: durable.current!.sessionReceipt!.id,
          bundleId: durable.current!.bundleId,
          rootDir: root,
        }),
      ).toBe(false);
    }
  });

  it("accepts CONFIRMED cleanup only after the exact recovery index was durably removed", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "crossagent-bridge-ticket-confirmed-"));
    const entry = resolve(root, "cli.js");
    writeFileSync(entry, "", "utf8");
    const result = await startCodexBridgeProcess({
      entry,
      projectId: "prj_test",
      agentId: "codex",
      threadId: "thr_confirmed_cleanup",
      rootDir: root,
      startupProbeDelayMs: 0,
      reserveLaunch: async ({ runId, threadId }) => issuedReservation(runId, threadId),
      adapters: {
        processExists: (pid) => pid === 59_090,
        spawnDetached: () => ({ pid: 59_090, unref: () => undefined }),
        afterSpawn: async (owner) => {
          await new FileCodexSessionTicketVault({
            projectId: owner.projectId,
            runId: owner.runId,
            rootDir: root,
          }).save(
            activeTicketSnapshot(owner.projectId, owner.runId, "thr_confirmed_cleanup", root),
          );
        },
      },
    });
    const owner = {
      projectId: result.record.projectId,
      agentId: result.record.agentId,
      runId: result.record.runId!,
      ownerNonce: result.record.ownerNonce!,
      pid: result.record.pid,
    };
    const confirmed = {
      terminalCleanup: "CONFIRMED" as const,
      sessionId: "ses_managed_reentry",
      bundleId: "stb_managed_reentry",
    };

    expect(() => clearCodexBridgeRunIfOwned(owner, confirmed, root)).toThrow(
      /confirmed.*retained a recovery index/i,
    );
    expect(listCodexBridgePids("prj_test", "codex", root)).toHaveLength(1);

    await new FileCodexSessionTicketVault({
      projectId: owner.projectId,
      runId: owner.runId,
      rootDir: root,
    }).save({ schemaVersion: 1, current: null, successor: null, cutover: null });
    expect(clearCodexBridgeRunIfOwned(owner, confirmed, root)).toBe(true);
    expect(listCodexBridgePids("prj_test", "codex", root)).toEqual([]);
  });

  it("admits exact current and active-successor close targets across every durable cutover phase", async () => {
    const phases = [
      "HUB_ACTIVATING",
      "HUB_ACTIVATED",
      "CONTROL_READY",
      "MODEL_READY",
      "EVENTS_READY",
    ] as const;
    const modes = ["CURRENT_HEAD", "AUXILIARY"] as const;
    let pid = 59_400;
    for (const mode of modes) {
      for (const phase of phases) {
        const targets = phase === "HUB_ACTIVATING" ? ["current"] : ["current", "successor"];
        for (const target of targets) {
          const root = mkdtempSync(
            resolve(
              tmpdir(),
              `crossagent-bridge-draining-${mode.toLowerCase()}-${phase.toLowerCase()}-${target}-`,
            ),
          );
          const entry = resolve(root, "cli.js");
          writeFileSync(entry, "", "utf8");
          const threadId = `thr_draining_${mode.toLowerCase()}_${phase.toLowerCase()}_${target}`;
          let durable: CodexSessionTicketVaultSnapshot | null = null;
          const currentPid = pid++;
          const result = await startCodexBridgeProcess({
            entry,
            projectId: "prj_test",
            agentId: "codex",
            threadId,
            rootDir: root,
            startupProbeDelayMs: 0,
            reserveLaunch: async ({ runId, threadId: reservedThreadId }) =>
              issuedReservation(runId, reservedThreadId),
            adapters: {
              processExists: (candidate) => candidate === currentPid,
              spawnDetached: () => ({ pid: currentPid, unref: () => undefined }),
              afterSpawn: async (owner) => {
                durable =
                  mode === "CURRENT_HEAD"
                    ? currentHeadCutoverSnapshot(
                        owner.projectId,
                        owner.runId,
                        threadId,
                        root,
                        phase,
                      )
                    : auxiliaryCutoverSnapshot(owner.projectId, owner.runId, threadId, root, phase);
                await new FileCodexSessionTicketVault({
                  projectId: owner.projectId,
                  runId: owner.runId,
                  rootDir: root,
                }).save(durable);
              },
            },
          });
          const selected = target === "current" ? durable!.current! : durable!.successor!;
          expect(
            clearCodexBridgeRunIfOwned(
              {
                projectId: result.record.projectId,
                agentId: result.record.agentId,
                runId: result.record.runId!,
                ownerNonce: result.record.ownerNonce!,
                pid: result.record.pid,
              },
              {
                terminalCleanup: "AMBIGUOUS",
                sessionId: selected.sessionReceipt!.id,
                bundleId: selected.bundleId,
              },
              root,
            ),
          ).toBe(true);
          await expect(
            startCodexBridgeProcess({
              entry,
              projectId: "prj_test",
              agentId: "codex",
              threadId,
              rootDir: root,
              startupProbeDelayMs: 0,
              adapters: { processExists: () => false },
            }),
          ).rejects.toThrow(/DRAINING.*terminal close replay is unavailable/i);
        }
      }
    }
  });

  it("replays every DRAINING cutover through FileVault and the ticket runtime before relaunch", async () => {
    const phases = [
      "HUB_ACTIVATING",
      "HUB_ACTIVATED",
      "CONTROL_READY",
      "MODEL_READY",
      "EVENTS_READY",
    ] as const;
    const modes = ["CURRENT_HEAD", "AUXILIARY"] as const;
    let nextPid = 60_000;
    for (const mode of modes) {
      for (const phase of phases) {
        const root = mkdtempSync(
          resolve(
            tmpdir(),
            `crossagent-bridge-runtime-drain-${mode.toLowerCase()}-${phase.toLowerCase()}-`,
          ),
        );
        const entry = resolve(root, "cli.js");
        writeFileSync(entry, "", "utf8");
        const threadId = `thr_runtime_drain_${mode.toLowerCase()}_${phase.toLowerCase()}`;
        const live = new Set<number>();
        let durable: CodexSessionTicketVaultSnapshot | null = null;
        const firstPid = nextPid++;
        const first = await startCodexBridgeProcess({
          entry,
          projectId: "prj_test",
          agentId: "codex",
          threadId,
          rootDir: root,
          startupProbeDelayMs: 0,
          reserveLaunch: async ({ runId, threadId: reservedThreadId }) =>
            issuedReservation(runId, reservedThreadId),
          adapters: {
            processExists: (candidate) => live.has(candidate),
            spawnDetached: () => {
              live.add(firstPid);
              return { pid: firstPid, unref: () => undefined };
            },
            afterSpawn: async (owner) => {
              durable =
                mode === "CURRENT_HEAD"
                  ? currentHeadCutoverSnapshot(owner.projectId, owner.runId, threadId, root, phase)
                  : auxiliaryCutoverSnapshot(owner.projectId, owner.runId, threadId, root, phase);
              await new FileCodexSessionTicketVault({
                projectId: owner.projectId,
                runId: owner.runId,
                rootDir: root,
              }).save(durable);
              await new FileCodexSessionOperationalCheckpointStore(root).save({
                schemaVersion: 1,
                projectId: owner.projectId,
                threadId,
                ownerRunId: owner.runId,
                eventSequence: 0,
                pendingMessageIds: [],
                session: {
                  hubSessionId: durable.current!.sessionReceipt!.id,
                  lineageId: durable.current!.sessionReceipt!.lineageId!,
                  incarnation: durable.current!.sessionReceipt!.incarnation!,
                  bundleId: durable.current!.bundleId,
                  nextHeartbeatSequence: 1,
                },
                updatedAt: "2026-08-01T04:00:00.000Z",
              });
            },
          },
        });
        const firstOwner = {
          projectId: first.record.projectId,
          agentId: first.record.agentId,
          runId: first.record.runId!,
          ownerNonce: first.record.ownerNonce!,
          pid: first.record.pid,
        };
        live.delete(first.record.pid);
        expect(
          clearCodexBridgeRunIfOwned(
            firstOwner,
            {
              terminalCleanup: "AMBIGUOUS",
              sessionId: durable!.current!.sessionReceipt!.id,
              bundleId: durable!.current!.bundleId,
            },
            root,
          ),
        ).toBe(true);

        const replay = closeReplayFetch(durable!);
        const replacementPid = nextPid++;
        const replacement = await startCodexBridgeProcess({
          entry,
          projectId: "prj_test",
          agentId: "codex",
          threadId,
          rootDir: root,
          startupProbeDelayMs: 0,
          drainRecovery: async (input) => {
            expect(input.runId).toBe(firstOwner.runId);
            try {
              await new CodexSessionTicketRuntime({
                baseUrl: "http://hub.test",
                bootstrapAgentToken: "agent-bootstrap",
                bootstrapInjectorToken: "injector-bootstrap",
                vault: new FileCodexSessionTicketVault({
                  projectId: input.projectId,
                  runId: input.runId,
                  rootDir: root,
                }),
                checkpointStore: new FileCodexSessionOperationalCheckpointStore(root),
                fetch: replay.fetch,
              }).replayConfirmedClose();
            } catch (error) {
              throw new Error(
                `${mode}/${phase} replay failed: ${error instanceof Error ? error.message : String(error)}`,
                { cause: error },
              );
            }
          },
          reserveLaunch: async ({ runId, threadId: reservedThreadId }) =>
            issuedReservation(runId, reservedThreadId),
          adapters: {
            processExists: (candidate) => live.has(candidate),
            spawnDetached: () => {
              live.add(replacementPid);
              return { pid: replacementPid, unref: () => undefined };
            },
          },
        });

        expect(replay.closedSessionIds).toEqual([
          activatedCloseReplaySuccessor(durable!).sessionReceipt!.id,
        ]);
        expect(replacement.record.runId).not.toBe(firstOwner.runId);
        await expect(
          new FileCodexSessionTicketVault({
            projectId: "prj_test",
            runId: firstOwner.runId,
            rootDir: root,
          }).load(),
        ).resolves.toBeNull();
      }
    }
  });

  it("blocks DRAINING restart until confirmed close deletes the retained vault", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "crossagent-bridge-ticket-draining-"));
    const entry = resolve(root, "cli.js");
    writeFileSync(entry, "", "utf8");
    const live = new Set<number>();
    let nextPid = 59_100;
    let firstLaunch = true;
    let reserveCalls = 0;
    let spawnCalls = 0;
    const start = (
      drainRecovery?: Parameters<typeof startCodexBridgeProcess>[0]["drainRecovery"],
    ) =>
      startCodexBridgeProcess({
        entry,
        projectId: "prj_test",
        agentId: "codex",
        threadId: "thr_draining_reentry",
        rootDir: root,
        startupProbeDelayMs: 0,
        reserveLaunch: async ({ runId, threadId }) => {
          reserveCalls += 1;
          return issuedReservation(runId, threadId);
        },
        drainRecovery,
        adapters: {
          processExists: (pid) => live.has(pid),
          spawnDetached: () => {
            spawnCalls += 1;
            const pid = nextPid++;
            live.add(pid);
            return { pid, unref: () => undefined };
          },
          afterSpawn: async (owner) => {
            if (!firstLaunch) return;
            firstLaunch = false;
            await new FileCodexSessionTicketVault({
              projectId: owner.projectId,
              runId: owner.runId,
              rootDir: root,
            }).save(
              activeTicketSnapshot(owner.projectId, owner.runId, "thr_draining_reentry", root),
            );
          },
        },
      });

    const first = await start();
    const firstOwner = {
      projectId: first.record.projectId,
      agentId: first.record.agentId,
      runId: first.record.runId!,
      ownerNonce: first.record.ownerNonce!,
      pid: first.record.pid,
    };
    live.delete(first.record.pid);
    expect(() =>
      clearCodexBridgeRunIfOwned(
        firstOwner,
        {
          terminalCleanup: "AMBIGUOUS",
          sessionId: "ses_wrong_cleanup_target",
          bundleId: "stb_managed_reentry",
        },
        root,
      ),
    ).toThrow(/ambiguous.*does not match retained replay authority/i);
    expect(() =>
      markCodexBridgeRunFailedIfOwned(
        firstOwner,
        "terminal close outcome did not match the retained ticket",
        {
          terminalCleanup: "AMBIGUOUS",
          sessionId: "ses_wrong_cleanup_target",
          bundleId: "stb_managed_reentry",
        },
        root,
      ),
    ).toThrow(/ambiguous.*does not match retained replay authority/i);
    expect(
      JSON.parse(
        readFileSync(
          codexBridgeRunFiles("prj_test", "codex", firstOwner.runId, root).pidPath,
          "utf8",
        ),
      ),
    ).toMatchObject({ runId: firstOwner.runId, state: "RUNNING" });
    expect(listCodexBridgeFailedRuns("prj_test", "codex", root)).toEqual([]);
    expect(
      clearCodexBridgeRunIfOwned(
        firstOwner,
        {
          terminalCleanup: "AMBIGUOUS",
          sessionId: "ses_managed_reentry",
          bundleId: "stb_managed_reentry",
        },
        root,
      ),
    ).toBe(true);

    await expect(start()).rejects.toThrow(/DRAINING.*terminal close.*unavailable/i);
    expect(reserveCalls).toBe(1);
    expect(spawnCalls).toBe(1);

    const replacement = await start(async (input) => {
      expect(input).toEqual({
        projectId: "prj_test",
        agentId: "codex",
        threadId: "thr_draining_reentry",
        runId: first.record.runId,
      });
      expect(reserveCalls).toBe(1);
      expect(spawnCalls).toBe(1);
      await new FileCodexSessionTicketVault({
        projectId: input.projectId,
        runId: input.runId,
        rootDir: root,
      }).save({ schemaVersion: 1, current: null, successor: null });
    });
    expect(replacement.record.runId).not.toBe(first.record.runId);
    expect(reserveCalls).toBe(2);
    expect(spawnCalls).toBe(2);
  });

  it("aborts a reservation black hole, releases the lock, and resumes the same run", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "crossagent-bridge-reserve-timeout-"));
    const entry = resolve(root, "cli.js");
    writeFileSync(entry, "", "utf8");
    const lockPath = codexBridgeLaunchLockPath("prj_test", "codex", "thr_timeout", root);
    const requests: Array<{
      runId: string;
      idempotencyKey: string;
      signal: AbortSignal | undefined;
    }> = [];
    let spawnCalls = 0;

    await expect(
      startCodexBridgeProcess({
        entry,
        projectId: "prj_test",
        agentId: "codex",
        threadId: "thr_timeout",
        rootDir: root,
        reservationAttemptTimeoutMs: 10,
        reserveLaunch: async (request) => {
          requests.push(request);
          if (!request.signal) {
            await new Promise((resolvePromise) => setTimeout(resolvePromise, 80));
            return issuedReservation(request.runId, request.threadId);
          }
          return new Promise((_resolve, reject) => {
            request.signal.addEventListener("abort", () => reject(request.signal.reason), {
              once: true,
            });
          });
        },
        adapters: {
          processExists: () => false,
          spawnDetached: () => {
            spawnCalls += 1;
            return { pid: 54_100, unref: () => undefined };
          },
        },
      }),
    ).rejects.toMatchObject({ name: "TimeoutError" });

    expect(requests).toHaveLength(3);
    expect(new Set(requests.map((request) => request.runId)).size).toBe(1);
    expect(new Set(requests.map((request) => request.idempotencyKey)).size).toBe(1);
    expect(requests.every((request) => request.signal?.aborted)).toBe(true);
    expect(spawnCalls).toBe(0);
    expect(existsSync(lockPath)).toBe(false);

    const timedOutRunId = requests[0]!.runId;
    const resumed = await startCodexBridgeProcess({
      entry,
      projectId: "prj_test",
      agentId: "codex",
      threadId: "thr_timeout",
      rootDir: root,
      startupProbeDelayMs: 0,
      reservationAttemptTimeoutMs: 50,
      reserveLaunch: async (request) => {
        requests.push(request);
        return issuedReservation(request.runId, request.threadId);
      },
      adapters: {
        processExists: (pid) => pid === 54_101,
        spawnDetached: () => {
          spawnCalls += 1;
          return { pid: 54_101, unref: () => undefined };
        },
      },
    });

    expect(resumed.record.runId).toBe(timedOutRunId);
    expect(requests.at(-1)).toMatchObject({
      runId: timedOutRunId,
      idempotencyKey: `codex-launch:${timedOutRunId}`,
    });
    expect(spawnCalls).toBe(1);
  });

  it("cancels a RESERVING run before a late reservation can spawn it", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "crossagent-bridge-cancel-reserving-"));
    const entry = resolve(root, "cli.js");
    writeFileSync(entry, "", "utf8");
    let releaseReservation!: () => void;
    let reservationEntered!: () => void;
    const entered = new Promise<void>((resolvePromise) => {
      reservationEntered = resolvePromise;
    });
    const release = new Promise<void>((resolvePromise) => {
      releaseReservation = resolvePromise;
    });
    let spawnCalls = 0;

    const starting = startCodexBridgeProcess({
      entry,
      projectId: "prj_test",
      agentId: "codex",
      threadId: "thr_cancel_reserving",
      rootDir: root,
      startupProbeDelayMs: 0,
      reserveLaunch: async ({ runId, threadId }) => {
        reservationEntered();
        await release;
        return issuedReservation(runId, threadId);
      },
      adapters: {
        processExists: () => false,
        spawnDetached: () => {
          spawnCalls += 1;
          return { pid: 54_200, unref: () => undefined };
        },
      },
    });
    await entered;

    const stopped = await stopCodexBridgeProcess(
      "prj_test",
      "codex",
      root,
      { threadId: "thr_cancel_reserving" },
      { processExists: () => false, maxWaitAttempts: 0 },
    );
    releaseReservation();

    await expect(starting).rejects.toThrow(
      "Managed Codex Bridge launch was cancelled before spawn",
    );
    expect(stopped).toMatchObject({ stopped: true, cancelled: true });
    expect(spawnCalls).toBe(0);
  });

  it("cancels a STARTING run after spawn before the child can claim ownership", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "crossagent-bridge-stop-starting-"));
    const entry = resolve(root, "cli.js");
    writeFileSync(entry, "", "utf8");
    let releaseChild!: () => void;
    let childEntered!: () => void;
    const entered = new Promise<void>((resolvePromise) => {
      childEntered = resolvePromise;
    });
    const release = new Promise<void>((resolvePromise) => {
      releaseChild = resolvePromise;
    });

    const starting = startCodexBridgeProcess({
      entry,
      projectId: "prj_test",
      agentId: "codex",
      rootDir: root,
      startupProbeDelayMs: 0,
      adapters: {
        processExists: (pid) => pid === 54_250,
        spawnDetached: () => ({ pid: 54_250, unref: () => undefined }),
        afterSpawn: async () => {
          childEntered();
          await release;
        },
      },
    });
    await entered;

    const stopped = await stopCodexBridgeProcess(
      "prj_test",
      "codex",
      root,
      {},
      {
        processExists: (pid) => pid === 54_250,
        maxWaitAttempts: 0,
      },
    );
    releaseChild();

    await expect(starting).rejects.toThrow("Managed Codex Bridge launch was cancelled");
    expect(stopped).toMatchObject({ stopped: true, cancelled: true });
  });

  it("keeps a stop request valid when STARTING becomes RUNNING during cancellation", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "crossagent-bridge-start-stop-race-"));
    const entry = resolve(root, "cli.js");
    writeFileSync(entry, "", "utf8");
    let releaseChild!: () => void;
    let childEntered!: () => void;
    let spawnedOwner!: Parameters<typeof awaitCodexBridgeRunOwnership>[0];
    const entered = new Promise<void>((resolvePromise) => {
      childEntered = resolvePromise;
    });
    const release = new Promise<void>((resolvePromise) => {
      releaseChild = resolvePromise;
    });
    const starting = startCodexBridgeProcess({
      entry,
      projectId: "prj_test",
      agentId: "codex",
      rootDir: root,
      startupProbeDelayMs: 0,
      adapters: {
        processExists: (pid) => pid === 54_275,
        spawnDetached: () => ({ pid: 54_275, unref: () => undefined }),
        afterSpawn: async (owner) => {
          spawnedOwner = owner;
          childEntered();
          await release;
        },
      },
    });
    await entered;

    const stopped = await stopCodexBridgeProcess(
      "prj_test",
      "codex",
      root,
      {},
      {
        processExists: (pid) => pid === 54_275,
        maxWaitAttempts: 0,
        afterStopRequest: async () => {
          await awaitCodexBridgeRunOwnership(spawnedOwner, root);
        },
      },
    );
    releaseChild();
    const started = await starting;

    expect(stopped).toMatchObject({ timedOut: true, runId: started.record.runId });
    expect(consumeCodexBridgeRunStopRequest(spawnedOwner, root)).toBe(true);
  });

  it("does not trust a fresh control timestamp when the PID has no child-owned proof", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "crossagent-bridge-fresh-reused-pid-"));
    const entry = resolve(root, "cli.js");
    writeFileSync(entry, "", "utf8");
    let spawnCalls = 0;
    const start = () =>
      startCodexBridgeProcess({
        entry,
        projectId: "prj_test",
        agentId: "codex",
        threadId: "thr_fresh_reused",
        rootDir: root,
        startupProbeDelayMs: 0,
        reserveLaunch: async ({ runId, threadId }) => issuedReservation(runId, threadId),
        adapters: {
          // The first child died and this PID was immediately reused by an unrelated process.
          processExists: (pid) => pid === 54_300,
          spawnDetached: () => {
            spawnCalls += 1;
            return { pid: 54_300, unref: () => undefined };
          },
        },
      });

    const first = await start();
    await expect(start()).rejects.toThrow(/live managed Codex Bridge.*owner proof/i);
    expect(spawnCalls).toBe(1);

    const currentOwner = {
      projectId: first.record.projectId,
      agentId: first.record.agentId,
      runId: first.record.runId!,
      ownerNonce: first.record.ownerNonce!,
      pid: first.record.pid,
    };
    expect(writeCodexBridgeRunOwnerLease(currentOwner, root)).toBe(true);
    await expect(
      stopCodexBridgeProcess(
        "prj_test",
        "codex",
        root,
        {},
        {
          processExists: (pid) => pid === 54_300,
          maxWaitAttempts: 0,
        },
      ),
    ).resolves.toMatchObject({ timedOut: true, runId: first.record.runId });
  });

  it("does not trust fresh diagnostic health when a reused PID has no child-owned lease", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "crossagent-bridge-fresh-health-reuse-"));
    const entry = resolve(root, "cli.js");
    writeFileSync(entry, "", "utf8");
    let spawnCalls = 0;
    const start = () =>
      startCodexBridgeProcess({
        entry,
        projectId: "prj_test",
        agentId: "codex",
        threadId: "thr_fresh_health_reuse",
        rootDir: root,
        startupProbeDelayMs: 0,
        reserveLaunch: async ({ runId, threadId }) => issuedReservation(runId, threadId),
        adapters: {
          processExists: (pid) => pid === 54_350,
          spawnDetached: () => {
            spawnCalls += 1;
            return { pid: 54_350, unref: () => undefined };
          },
        },
      });

    const first = await start();
    const firstFiles = codexBridgeRunFiles(
      first.record.projectId,
      first.record.agentId,
      first.record.runId!,
      root,
    );
    writeFileSync(
      firstFiles.healthPath,
      `${JSON.stringify({
        status: "healthy",
        pid: first.record.pid,
        updatedAt: new Date().toISOString(),
        launcherRunId: first.record.runId,
      })}\n`,
      "utf8",
    );

    await expect(start()).rejects.toThrow(/live managed Codex Bridge.*owner proof/i);
    expect(spawnCalls).toBe(1);
  });

  it("does not let diagnostic stopped health override a live PID without owner proof", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "crossagent-bridge-stopped-health-"));
    const entry = resolve(root, "cli.js");
    writeFileSync(entry, "", "utf8");
    const live = new Set<number>();
    let nextPid = 54_200;
    let reserveCalls = 0;
    let spawnCalls = 0;
    const start = () =>
      startCodexBridgeProcess({
        entry,
        projectId: "prj_test",
        agentId: "codex",
        threadId: "thr_stopped",
        rootDir: root,
        startupProbeDelayMs: 0,
        reserveLaunch: async ({ runId, threadId }) => {
          reserveCalls += 1;
          return issuedReservation(runId, threadId);
        },
        adapters: {
          processExists: (pid) => live.has(pid),
          spawnDetached: () => {
            spawnCalls += 1;
            const pid = nextPid++;
            live.add(pid);
            return { pid, unref: () => undefined };
          },
        },
      });

    const first = await start();
    const firstFiles = codexBridgeRunFiles(
      first.record.projectId,
      first.record.agentId,
      first.record.runId!,
      root,
    );
    writeFileSync(
      firstFiles.healthPath,
      `${JSON.stringify({
        status: "stopped",
        pid: first.record.pid,
        updatedAt: new Date().toISOString(),
        launcherRunId: first.record.runId,
      })}\n`,
      "utf8",
    );

    await expect(start()).rejects.toThrow(/live managed Codex Bridge.*owner proof/i);
    expect(reserveCalls).toBe(1);
    expect(spawnCalls).toBe(1);
  });

  it("does not SIGKILL a live PID that lacks nonce-confirmed graceful shutdown", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "crossagent-bridge-reused-pid-"));
    const files = codexBridgeFiles("prj_test", "codex", root);
    mkdirSync(dirname(files.pidPath), { recursive: true });
    writeFileSync(
      files.pidPath,
      `${JSON.stringify({
        pid: 55_000,
        projectId: "prj_test",
        agentId: "codex",
        startedAt: "2026-07-30T00:00:00.000Z",
        entry: "old-cli.js",
        logPath: files.logPath,
      })}\n`,
      "utf8",
    );
    const kill = vi.spyOn(process, "kill");

    const result = await stopCodexBridgeProcess(
      "prj_test",
      "codex",
      root,
      {},
      {
        processExists: (pid) => pid === 55_000,
        maxWaitAttempts: 1,
        waitMs: 0,
      },
    );

    expect(result).toEqual({
      stopped: false,
      stale: false,
      timedOut: true,
      runId: null,
    });
    expect(kill).not.toHaveBeenCalled();
    expect(existsSync(files.pidPath)).toBe(true);
    expect(existsSync(files.stopPath)).toBe(true);
    kill.mockRestore();
  });

  it("selects a legacy Bridge by trusted health thread or explicit PID beside a new run", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "crossagent-bridge-legacy-select-"));
    const legacyFiles = codexBridgeFiles("prj_test", "codex", root);
    mkdirSync(dirname(legacyFiles.pidPath), { recursive: true });
    writeFileSync(
      legacyFiles.pidPath,
      `${JSON.stringify({
        pid: 56_000,
        projectId: "prj_test",
        agentId: "codex",
        startedAt: "2026-07-30T00:00:00.000Z",
        entry: "old-cli.js",
        logPath: legacyFiles.logPath,
      })}\n`,
      "utf8",
    );
    writeFileSync(
      legacyFiles.healthPath,
      `${JSON.stringify({
        pid: 56_000,
        threadId: "thr_legacy",
        updatedAt: new Date().toISOString(),
      })}\n`,
      "utf8",
    );
    const entry = resolve(root, "new-cli.js");
    writeFileSync(entry, "", "utf8");
    await startCodexBridgeProcess({
      entry,
      projectId: "prj_test",
      agentId: "codex",
      rootDir: root,
      startupProbeDelayMs: 0,
      adapters: {
        processExists: (pid) => pid === 56_000 || pid === 56_001,
        spawnDetached: () => ({ pid: 56_001, unref: () => undefined }),
      },
    });

    expect(listCodexBridgePids("prj_test", "codex", root)).toHaveLength(2);
    expect(
      selectCodexBridgePids("prj_test", "codex", { threadId: "thr_legacy" }, root).map(
        (record) => record.pid,
      ),
    ).toEqual([56_000]);
    expect(
      selectCodexBridgePids("prj_test", "codex", { pid: 56_000 }, root).map((record) => record.pid),
    ).toEqual([56_000]);
  });

  it("refuses a successor when a live matching control has missing owner proof", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "crossagent-bridge-reused-start-"));
    const entry = resolve(root, "cli.js");
    writeFileSync(entry, "", "utf8");
    const live = new Set<number>();
    let nextPid = 57_000;
    let reserveCalls = 0;
    const start = () =>
      startCodexBridgeProcess({
        entry,
        projectId: "prj_test",
        agentId: "codex",
        threadId: "thr_reused",
        rootDir: root,
        startupProbeDelayMs: 0,
        reserveLaunch: async ({ runId, threadId }) => {
          reserveCalls += 1;
          return issuedReservation(runId, threadId);
        },
        adapters: {
          processExists: (pid) => live.has(pid),
          spawnDetached: () => {
            const pid = nextPid++;
            live.add(pid);
            return { pid, unref: () => undefined };
          },
        },
      });
    const first = await start();
    const firstFiles = codexBridgeRunFiles(
      first.record.projectId,
      first.record.agentId,
      first.record.runId!,
      root,
    );
    const stale = JSON.parse(readFileSync(firstFiles.pidPath, "utf8")) as Record<string, unknown>;
    stale.startedAt = "2026-07-30T00:00:00.000Z";
    stale.updatedAt = "2026-07-30T00:00:00.000Z";
    writeFileSync(firstFiles.pidPath, `${JSON.stringify(stale)}\n`, "utf8");

    await expect(start()).rejects.toThrow(/live managed Codex Bridge.*owner proof/i);

    expect(reserveCalls).toBe(1);
    expect(existsSync(firstFiles.pidPath)).toBe(true);
  });

  it("keeps stale live control evidence when successor reservation fails", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "crossagent-bridge-outage-control-"));
    const entry = resolve(root, "cli.js");
    writeFileSync(entry, "", "utf8");
    const first = await startCodexBridgeProcess({
      entry,
      projectId: "prj_test",
      agentId: "codex",
      threadId: "thr_outage",
      rootDir: root,
      startupProbeDelayMs: 0,
      reserveLaunch: async ({ runId, threadId }) => issuedReservation(runId, threadId),
      adapters: {
        processExists: (pid) => pid === 57_100,
        spawnDetached: () => ({ pid: 57_100, unref: () => undefined }),
      },
    });
    const firstFiles = codexBridgeRunFiles(
      first.record.projectId,
      first.record.agentId,
      first.record.runId!,
      root,
    );
    const stale = JSON.parse(readFileSync(firstFiles.pidPath, "utf8")) as Record<string, unknown>;
    stale.startedAt = "2026-07-30T00:00:00.000Z";
    stale.updatedAt = "2026-07-30T00:00:00.000Z";
    writeFileSync(firstFiles.pidPath, `${JSON.stringify(stale)}\n`, "utf8");

    let reserveCalls = 0;
    await expect(
      startCodexBridgeProcess({
        entry,
        projectId: "prj_test",
        agentId: "codex",
        threadId: "thr_outage",
        rootDir: root,
        reserveLaunch: async () => {
          reserveCalls += 1;
          throw new Error("Hub unavailable");
        },
        adapters: {
          processExists: (pid) => pid === 57_100,
          spawnDetached: () => ({ pid: 57_101, unref: () => undefined }),
        },
      }),
    ).rejects.toThrow(/live managed Codex Bridge.*owner proof/i);

    expect(reserveCalls).toBe(0);
    expect(existsSync(firstFiles.pidPath)).toBe(true);
    expect(listCodexBridgePids("prj_test", "codex", root)).toEqual([
      expect.objectContaining({ runId: first.record.runId, pid: 57_100 }),
    ]);
  });

  it("retains the resolved thread in a failed-run tombstone when startup later exits", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "crossagent-bridge-resolved-failure-"));
    const entry = resolve(root, "cli.js");
    writeFileSync(entry, "", "utf8");

    await expect(
      startCodexBridgeProcess({
        entry,
        projectId: "prj_test",
        agentId: "codex",
        rootDir: root,
        startupProbeDelayMs: 0,
        adapters: {
          processExists: () => false,
          spawnDetached: () => ({ pid: 57_200, unref: () => undefined }),
          afterSpawn: async (owner) => {
            await awaitCodexBridgeRunOwnership(owner, root);
            promoteCodexBridgeRunThread(owner, "thr_resolved_before_failure", root);
          },
        },
      }),
    ).rejects.toThrow(/exited during startup/i);

    expect(listCodexBridgePids("prj_test", "codex", root)).toEqual([]);
    expect(listCodexBridgeFailedRuns("prj_test", "codex", root)).toEqual([
      expect.objectContaining({
        pid: 57_200,
        threadId: "thr_resolved_before_failure",
        failure: expect.stringContaining("exited during startup"),
      }),
    ]);
  });

  it("lets the managed child preserve a late startup failure after the launcher returned", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "crossagent-bridge-late-failure-"));
    const entry = resolve(root, "cli.js");
    writeFileSync(entry, "", "utf8");
    const result = await startCodexBridgeProcess({
      entry,
      projectId: "prj_test",
      agentId: "codex",
      rootDir: root,
      startupProbeDelayMs: 0,
      adapters: {
        processExists: (pid) => pid === 57_300,
        spawnDetached: () => ({ pid: 57_300, unref: () => undefined }),
      },
    });
    const owner = {
      projectId: result.record.projectId,
      agentId: result.record.agentId,
      runId: result.record.runId!,
      ownerNonce: result.record.ownerNonce!,
      pid: result.record.pid,
    };
    promoteCodexBridgeRunThread(owner, "thr_late_failure", root);

    expect(
      markCodexBridgeRunFailedIfOwned(
        owner,
        "Hub registration retry budget exhausted",
        { terminalCleanup: "NOT_ATTEMPTED" },
        root,
      ),
    ).toBe(true);
    expect(clearStaleCodexBridgePid("prj_test", "codex", root)).toBe(false);
    expect(listCodexBridgeFailedRuns("prj_test", "codex", root)).toEqual([
      expect.objectContaining({
        threadId: "thr_late_failure",
        failure: "Hub registration retry budget exhausted",
      }),
    ]);
  });

  it("refuses to guess whether an unverified legacy PID owns an explicit thread", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "crossagent-bridge-legacy-unknown-"));
    const entry = resolve(root, "cli.js");
    writeFileSync(entry, "", "utf8");
    const files = codexBridgeFiles("prj_test", "codex", root);
    mkdirSync(dirname(files.pidPath), { recursive: true });
    writeFileSync(
      files.pidPath,
      `${JSON.stringify({
        pid: 58_000,
        projectId: "prj_test",
        agentId: "codex",
        startedAt: "2026-07-30T00:00:00.000Z",
        entry: "old-cli.js",
        logPath: files.logPath,
      })}\n`,
      "utf8",
    );
    let reserveCalls = 0;

    await expect(
      startCodexBridgeProcess({
        entry,
        projectId: "prj_test",
        agentId: "codex",
        threadId: "thr_unknown",
        rootDir: root,
        launchLockWaitMs: 60,
        reserveLaunch: async ({ runId, threadId }) => {
          reserveCalls += 1;
          return issuedReservation(runId, threadId);
        },
        adapters: {
          processExists: (pid) => pid === 58_000,
          spawnDetached: () => ({ pid: 58_001, unref: () => undefined }),
        },
      }),
    ).rejects.toThrow(/unverified legacy/i);

    expect(reserveCalls).toBe(0);
    expect(existsSync(files.pidPath)).toBe(true);
  });
});
