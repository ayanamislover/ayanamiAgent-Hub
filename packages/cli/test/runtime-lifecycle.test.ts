import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { sealManagedBridgeRuntimeSubjectFromFiles } from "../src/runtime-lifecycle.js";

const AT = "2026-08-02T12:00:00.000Z";
const PROJECT_ID = "prj_runtime_seal";
const RUN_ID = "run_runtime_seal";
const THREAD_ID = "019fa8ef-3525-7a31-9e9b-2da6e38253f8";
const SESSION_ID = "ses_runtime_seal";
const LINEAGE_ID = "lin_runtime_seal";
const BUNDLE_ID = "stb_runtime_seal";
const raw = (letter: string) => letter.repeat(43);
const build = {
  buildId: "a".repeat(64),
  buildSessionId: "123e4567-e89b-42d3-a456-426614174000",
  protocolId: "b".repeat(64),
  manifestSha256: "c".repeat(64),
  migrationId: "d".repeat(64),
};

function activeVault() {
  const offerIds = {
    CONTROL: "stk_runtime_control",
    MODEL_MCP: "stk_runtime_model",
    INJECTOR: "stk_runtime_injector",
  };
  const context = {
    projectId: PROJECT_ID,
    runId: RUN_ID,
    activationMode: "FIRST_LINEAGE" as const,
    externalSessionId: THREAD_ID,
    externalThreadId: THREAD_ID,
  };
  const sessionReceipt = {
    id: SESSION_ID,
    projectId: PROJECT_ID,
    agentId: "codex" as const,
    role: "primary" as const,
    client: "codex-app-server" as const,
    transport: "websocket" as const,
    deliveryMode: "app_server_push" as const,
    externalSessionId: THREAD_ID,
    externalThreadId: THREAD_ID,
    externalTurnId: null,
    host: "localhost",
    pid: 42_001,
    cwd: "R:\\Project_All\\ayanamiAgent Hub",
    gitBranch: null,
    gitHead: null,
    capabilities: [],
    connectedAt: AT,
    transportLastSeenAt: AT,
    activityLastSeenAt: null,
    currentTaskId: null,
    currentReviewId: null,
    activeFiles: [],
    workState: "IDLE" as const,
    connectionState: "ONLINE" as const,
    queueDepth: 0,
    lineageId: LINEAGE_ID,
    incarnation: 3,
    predecessorSessionId: null,
    supersededBySessionId: null,
    launcherRunId: null,
    launchGeneration: null,
    version: 1,
  };
  return {
    schemaVersion: 1 as const,
    current: {
      bundleId: BUNDLE_ID,
      phase: "ACTIVE" as const,
      launchContext: context,
      context,
      raw: { CONTROL: raw("A"), MODEL_MCP: raw("B"), INJECTOR: raw("C") },
      offerIds,
      activationAttempted: true,
      binding: {
        bundleId: BUNDLE_ID,
        state: "ACTIVE" as const,
        projectId: PROJECT_ID,
        agentId: "codex" as const,
        adapterClient: "codex" as const,
        hubSessionId: SESSION_ID,
        lineageId: LINEAGE_ID,
        incarnation: 3,
        runId: RUN_ID,
        activatedAt: AT,
        expiresAt: "2026-08-03T12:00:00.000Z",
        purposes: (Object.keys(offerIds) as Array<keyof typeof offerIds>).map((purpose) => ({
          id: offerIds[purpose],
          purpose,
          state: "ACTIVE" as const,
        })),
      },
      rotationReceipt: null,
      sessionReceipt,
      launchSessionId: SESSION_ID,
      serverNow: AT,
      observedAt: AT,
      registrationInput: {
        agentId: "codex" as const,
        role: "primary" as const,
        client: "codex-app-server" as const,
        transport: "websocket" as const,
        deliveryMode: "app_server_push" as const,
        externalSessionId: THREAD_ID,
        externalThreadId: THREAD_ID,
        host: "localhost",
        pid: 42_001,
        cwd: "R:\\Project_All\\ayanamiAgent Hub",
        capabilities: [],
        idempotencyKey: `register:${RUN_ID}`,
      },
    },
    successor: null,
    cutover: null,
  };
}

function activeCheckpoint(sessionId = SESSION_ID) {
  return {
    schemaVersion: 1 as const,
    projectId: PROJECT_ID,
    threadId: THREAD_ID,
    ownerRunId: RUN_ID,
    eventSequence: 27,
    pendingMessageIds: [],
    session: {
      hubSessionId: sessionId,
      lineageId: LINEAGE_ID,
      incarnation: 3,
      bundleId: BUNDLE_ID,
      nextHeartbeatSequence: 9,
    },
    updatedAt: AT,
  };
}

function writePrivateJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
  if (process.platform !== "win32") {
    chmodSync(dirname(path), 0o700);
    chmodSync(path, 0o600);
  }
}

describe("runtime lifecycle subject seal", () => {
  it("binds the exact active vault, checkpoint, build, session, and fuse into a non-secret subject", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "crossagent-runtime-seal-"));
    const vaultPath = resolve(root, "vault.json");
    const checkpointPath = resolve(root, "checkpoint.json");
    writePrivateJson(vaultPath, activeVault());
    writePrivateJson(checkpointPath, activeCheckpoint());

    const subject = await sealManagedBridgeRuntimeSubjectFromFiles({
      projectId: PROJECT_ID,
      originalThreadId: THREAD_ID,
      runId: RUN_ID,
      sessionId: SESSION_ID,
      build,
      fuseGeneration: 4,
      vaultPath,
      checkpointPath,
      windowsOwnerPrivateAclVerifier: () => true,
    });

    expect(subject).toMatchObject({
      projectId: PROJECT_ID,
      originalThreadId: THREAD_ID,
      runId: RUN_ID,
      sessionId: SESSION_ID,
      lineageId: LINEAGE_ID,
      incarnation: 3,
      bundleId: BUNDLE_ID,
      checkpointEventSequence: 27,
      fuseGeneration: 4,
      vaultSha256: createHash("sha256").update(readFileSync(vaultPath)).digest("hex"),
      checkpointSha256: createHash("sha256").update(readFileSync(checkpointPath)).digest("hex"),
    });
    expect(JSON.stringify(subject)).not.toContain(raw("A"));

    writePrivateJson(checkpointPath, activeCheckpoint("ses_runtime_drift"));
    await expect(
      sealManagedBridgeRuntimeSubjectFromFiles({
        projectId: PROJECT_ID,
        originalThreadId: THREAD_ID,
        runId: RUN_ID,
        sessionId: SESSION_ID,
        build,
        fuseGeneration: 4,
        vaultPath,
        checkpointPath,
        windowsOwnerPrivateAclVerifier: () => true,
      }),
    ).rejects.toThrow(/checkpoint does not match/i);
  });
});
