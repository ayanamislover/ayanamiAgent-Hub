import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CodexSessionTicketRuntime,
  isCodexPendingMessageId,
  parseCodexSessionOperationalCheckpoint,
  type CodexSessionOperationalCheckpoint,
  type CodexSessionTicketVaultSnapshot,
} from "@crossagent/codex-bridge";
import {
  FileCodexSessionOperationalCheckpointStore,
  FileCodexSessionTicketVault,
  bindCodexSessionTicketRecoveryRun,
  codexSessionOperationalCheckpointPath,
  codexSessionTicketRecoveryIndexPath,
  codexSessionTicketRecoveryLockPath,
  codexSessionTicketVaultPath,
  findRecoverableCodexSessionTicketRun,
  markCodexSessionTicketRecoveryDraining,
} from "../src/session-ticket-store.js";

const raw = (letter: string) => letter.repeat(43);

function checkpoint(
  overrides: {
    runId?: string;
    hubSessionId?: string;
    incarnation?: number;
    bundleId?: string;
    heartbeat?: number;
    eventSequence?: number;
    pendingMessageIds?: string[];
  } = {},
) {
  return {
    schemaVersion: 1 as const,
    projectId: "prj_store",
    threadId: "thr_checkpoint",
    ownerRunId: overrides.runId ?? "run_checkpoint",
    eventSequence: overrides.eventSequence ?? 42,
    pendingMessageIds: overrides.pendingMessageIds ?? ["msg_pending_one"],
    session: {
      hubSessionId: overrides.hubSessionId ?? "ses_checkpoint",
      lineageId: "lin_checkpoint",
      incarnation: overrides.incarnation ?? 1,
      bundleId: overrides.bundleId ?? "stb_checkpoint",
      nextHeartbeatSequence: overrides.heartbeat ?? 8,
    },
    updatedAt: new Date().toISOString(),
  };
}

function snapshot(
  runId = "run_store",
  threadId: string | null = null,
): CodexSessionTicketVaultSnapshot {
  return {
    schemaVersion: 1,
    current: {
      bundleId: "stb_current",
      phase: "OFFERED",
      launchContext: {
        projectId: "prj_store",
        runId,
        activationMode: "FIRST_LINEAGE",
        externalSessionId: threadId,
        externalThreadId: threadId,
      },
      context: {
        projectId: "prj_store",
        runId,
        activationMode: "FIRST_LINEAGE",
        externalSessionId: threadId,
        externalThreadId: threadId,
      },
      raw: { CONTROL: raw("A"), MODEL_MCP: raw("B"), INJECTOR: raw("C") },
      offerIds: {
        CONTROL: "stk_control",
        MODEL_MCP: "stk_model",
        INJECTOR: "stk_injector",
      },
      activationAttempted: false,
      binding: null,
      rotationReceipt: null,
      sessionReceipt: null,
      launchSessionId: null,
      serverNow: null,
      observedAt: null,
      registrationInput: null,
    },
    successor: null,
    cutover: null,
  };
}

const CROSS_STORE_AT = "2026-08-01T08:00:00.000Z";

function activeSnapshot(
  runId = "run_cross_store",
  threadId = "thr_cross_store",
  bundleId = "stb_cross_store",
): CodexSessionTicketVaultSnapshot {
  const hubSessionId = "ses_cross_store";
  const lineageId = "lin_cross_store";
  const offerIds = {
    CONTROL: "stk_cross_control",
    MODEL_MCP: "stk_cross_model",
    INJECTOR: "stk_cross_injector",
  };
  const context = {
    projectId: "prj_store",
    runId,
    activationMode: "FIRST_LINEAGE" as const,
    externalSessionId: "desktop-cross-store",
    externalThreadId: threadId,
  };
  const sessionReceipt = {
    id: hubSessionId,
    projectId: "prj_store",
    agentId: "codex" as const,
    role: "primary" as const,
    client: "codex-app-server" as const,
    transport: "websocket" as const,
    deliveryMode: "app_server_push" as const,
    externalSessionId: "desktop-cross-store",
    externalThreadId: threadId,
    externalTurnId: null,
    host: "localhost",
    pid: 1234,
    cwd: "C:\\work\\crossagent-hub",
    gitBranch: null,
    gitHead: null,
    capabilities: [],
    connectedAt: CROSS_STORE_AT,
    transportLastSeenAt: CROSS_STORE_AT,
    activityLastSeenAt: null,
    currentTaskId: null,
    currentReviewId: null,
    activeFiles: [],
    workState: "IDLE" as const,
    connectionState: "ONLINE" as const,
    queueDepth: 0,
    lineageId,
    incarnation: 1,
    predecessorSessionId: null,
    supersededBySessionId: null,
    launcherRunId: null,
    launchGeneration: null,
    version: 1,
  };
  return {
    schemaVersion: 1,
    current: {
      bundleId,
      phase: "ACTIVE",
      launchContext: context,
      context,
      raw: { CONTROL: raw("J"), MODEL_MCP: raw("K"), INJECTOR: raw("L") },
      offerIds,
      activationAttempted: true,
      binding: {
        bundleId,
        state: "ACTIVE",
        projectId: "prj_store",
        agentId: "codex",
        adapterClient: "codex",
        hubSessionId,
        lineageId,
        incarnation: 1,
        runId,
        activatedAt: CROSS_STORE_AT,
        expiresAt: "2026-08-02T08:00:00.000Z",
        purposes: (["CONTROL", "MODEL_MCP", "INJECTOR"] as const).map((purpose) => ({
          id: offerIds[purpose],
          purpose,
          state: "ACTIVE" as const,
        })),
      },
      rotationReceipt: null,
      sessionReceipt,
      launchSessionId: hubSessionId,
      serverNow: CROSS_STORE_AT,
      observedAt: CROSS_STORE_AT,
      registrationInput: {
        agentId: "codex",
        role: "primary",
        client: "codex-app-server",
        transport: "websocket",
        deliveryMode: "app_server_push",
        externalSessionId: "desktop-cross-store",
        externalThreadId: threadId,
        host: "localhost",
        pid: 1234,
        cwd: "C:\\work\\crossagent-hub",
        capabilities: [],
        idempotencyKey: `register:${runId}`,
      },
    },
    successor: null,
    cutover: null,
  };
}

function activeCheckpoint(
  runId = "run_cross_store",
  threadId = "thr_cross_store",
  bundleId = "stb_cross_store",
): CodexSessionOperationalCheckpoint {
  return {
    schemaVersion: 1,
    projectId: "prj_store",
    threadId,
    ownerRunId: runId,
    eventSequence: 17,
    pendingMessageIds: ["msg_cross_store"],
    session: {
      hubSessionId: "ses_cross_store",
      lineageId: "lin_cross_store",
      incarnation: 1,
      bundleId,
      nextHeartbeatSequence: 9,
    },
    updatedAt: CROSS_STORE_AT,
  };
}

function fileRuntime(
  vault: FileCodexSessionTicketVault,
  checkpointStore: FileCodexSessionOperationalCheckpointStore,
): CodexSessionTicketRuntime {
  return new CodexSessionTicketRuntime({
    baseUrl: "http://hub.invalid",
    bootstrapAgentToken: "bootstrap-agent",
    bootstrapInjectorToken: "bootstrap-injector",
    vault,
    checkpointStore,
    fetch: async () => {
      throw new Error("cross-store close must not contact Hub");
    },
    now: () => new Date(CROSS_STORE_AT),
  });
}

describe("FileCodexSessionTicketVault", () => {
  it("shares the pending-message id codec with the in-memory runtime", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "crossagent-checkpoint-codec-"));
    const store = new FileCodexSessionOperationalCheckpointStore(root);
    const maximum = `msg_${"a".repeat(124)}`;
    const oversized = `msg_${"b".repeat(125)}`;
    const grosslyOversized = `msg_${"c".repeat(509)}`;
    const accepted = checkpoint({ pendingMessageIds: [maximum] });
    const rejected = checkpoint({ pendingMessageIds: [oversized] });
    const grosslyRejected = checkpoint({ pendingMessageIds: [grosslyOversized] });

    expect(isCodexPendingMessageId(maximum)).toBe(true);
    expect(isCodexPendingMessageId(oversized)).toBe(false);
    expect(isCodexPendingMessageId(grosslyOversized)).toBe(false);
    expect(parseCodexSessionOperationalCheckpoint(accepted)).toEqual(accepted);
    expect(() => parseCodexSessionOperationalCheckpoint(rejected)).toThrow(
      /Invalid Codex.*operational checkpoint/i,
    );
    await expect(store.save(accepted)).resolves.toBeUndefined();
    await expect(store.load("prj_store", "thr_checkpoint")).resolves.toEqual(accepted);
    await expect(store.save(rejected)).rejects.toThrow(
      /Invalid Codex session operational checkpoint/i,
    );
    await expect(store.save(grosslyRejected)).rejects.toThrow(
      /Invalid Codex session operational checkpoint/i,
    );
  });

  it("fsyncs an owner-private atomic file without putting secrets in its path", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "crossagent-ticket-vault-"));
    const vault = new FileCodexSessionTicketVault({
      projectId: "prj_store",
      runId: "run_store",
      rootDir: root,
    });
    await vault.save(snapshot());

    expect(vault.path).toBe(codexSessionTicketVaultPath("prj_store", "run_store", root));
    expect(vault.path).not.toMatch(/[ABC]{20}/);
    // Windows exposes a synthetic POSIX mode even after chmod; ACL isolation remains the same-user
    // host trust boundary documented by the product. POSIX hosts must prove literal owner-only mode.
    if (process.platform !== "win32") {
      expect(statSync(vault.path).mode & 0o777).toBe(0o600);
    }
    expect(readFileSync(vault.path, "utf8")).toContain(raw("A"));
    await expect(vault.load()).resolves.toEqual(snapshot());
  });

  it("fails closed on corrupt state without echoing raw ticket material", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "crossagent-ticket-corrupt-"));
    const vault = new FileCodexSessionTicketVault({
      projectId: "prj_store",
      runId: "run_store",
      rootDir: root,
    });
    await vault.save(snapshot());
    const secret = "THIS_IS_RAW_TICKET_MATERIAL_THAT_MUST_NOT_ESCAPE";
    writeFileSync(vault.path, JSON.stringify({ schemaVersion: 1, secret }), "utf8");

    await expect(vault.load()).rejects.toThrow(
      "Invalid Codex session ticket vault; refusing credential recovery",
    );
    await expect(vault.load()).rejects.not.toThrow(secret);
    expect(dirname(vault.path)).toContain("session-tickets");
  });

  it("rejects path traversal identities before touching disk", () => {
    expect(() => codexSessionTicketVaultPath("../project", "run_store", "R:\\vault")).toThrow(
      /Invalid project id/,
    );
    expect(() => codexSessionTicketVaultPath("prj_store", "../../run", "R:\\vault")).toThrow(
      /Invalid run id/,
    );
  });

  it("binds one exact thread to its whole recoverable run and refuses a competing owner", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "crossagent-ticket-recovery-"));
    const vault = new FileCodexSessionTicketVault({
      projectId: "prj_store",
      runId: "run_recover",
      rootDir: root,
    });
    const durable = snapshot("run_recover", "thr_recover");
    await vault.save(durable);
    bindCodexSessionTicketRecoveryRun({
      projectId: "prj_store",
      threadId: "thr_recover",
      runId: "run_recover",
      rootDir: root,
    });

    expect(
      findRecoverableCodexSessionTicketRun({
        projectId: "prj_store",
        threadId: "thr_recover",
        rootDir: root,
      }),
    ).toBe("run_recover");
    await expect(vault.load()).resolves.toEqual(durable);
    expect(() =>
      bindCodexSessionTicketRecoveryRun({
        projectId: "prj_store",
        threadId: "thr_recover",
        runId: "run_competing",
        rootDir: root,
      }),
    ).toThrow(/another managed Codex run owns/i);
  });

  it("never marks an OFFERED bundle DRAINING because it has no exact close authority", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "crossagent-ticket-draining-"));
    const vault = new FileCodexSessionTicketVault({
      projectId: "prj_store",
      runId: "run_draining",
      rootDir: root,
    });
    const durable = snapshot("run_draining", "thr_draining");
    await vault.save(durable);
    bindCodexSessionTicketRecoveryRun({
      projectId: "prj_store",
      threadId: "thr_draining",
      runId: "run_draining",
      rootDir: root,
    });

    expect(
      markCodexSessionTicketRecoveryDraining({
        projectId: "prj_store",
        threadId: "thr_draining",
        runId: "run_draining",
        sessionId: "ses_unavailable",
        bundleId: "stb_unavailable",
        rootDir: root,
      }),
    ).toBe(false);
    expect(
      JSON.parse(
        readFileSync(
          codexSessionTicketRecoveryIndexPath("prj_store", "thr_draining", root),
          "utf8",
        ),
      ),
    ).toMatchObject({ runId: "run_draining", state: "ACTIVE" });
    expect(
      findRecoverableCodexSessionTicketRun({
        projectId: "prj_store",
        threadId: "thr_draining",
        rootDir: root,
      }),
    ).toBe("run_draining");
    await expect(vault.load()).resolves.toEqual(durable);
  });

  it("deletes raw state and its recovery index only after a confirmed terminal snapshot", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "crossagent-ticket-terminal-"));
    const vault = new FileCodexSessionTicketVault({
      projectId: "prj_store",
      runId: "run_terminal",
      rootDir: root,
    });
    await vault.save(snapshot("run_terminal", "thr_terminal"));
    bindCodexSessionTicketRecoveryRun({
      projectId: "prj_store",
      threadId: "thr_terminal",
      runId: "run_terminal",
      rootDir: root,
    });
    const indexPath = codexSessionTicketRecoveryIndexPath("prj_store", "thr_terminal", root);
    bindCodexSessionTicketRecoveryRun({
      projectId: "prj_store",
      threadId: "thr_unrelated",
      runId: "run_unrelated",
      rootDir: root,
    });
    const unrelatedIndexPath = codexSessionTicketRecoveryIndexPath(
      "prj_store",
      "thr_unrelated",
      root,
    );
    const corruptIndexPath = resolve(dirname(indexPath), "corrupt-sibling.json");
    writeFileSync(corruptIndexPath, "{not-json", "utf8");
    expect(existsSync(vault.path)).toBe(true);
    expect(existsSync(indexPath)).toBe(true);

    await vault.save({ schemaVersion: 1, current: null, successor: null });

    expect(existsSync(vault.path)).toBe(false);
    expect(existsSync(indexPath)).toBe(false);
    expect(existsSync(unrelatedIndexPath)).toBe(true);
    expect(readFileSync(corruptIndexPath, "utf8")).toBe("{not-json");
    expect(
      findRecoverableCodexSessionTicketRun({
        projectId: "prj_store",
        threadId: "thr_terminal",
        rootDir: root,
      }),
    ).toBeNull();
  });

  it("rolls back raw state and its owned index when unlink fails before or after commit", async () => {
    for (const failureCall of [2, 3]) {
      const suffix = failureCall === 2 ? "raw" : "journal";
      const root = mkdtempSync(resolve(tmpdir(), `crossagent-ticket-close-unlink-${suffix}-`));
      const runId = `run_close_unlink_${suffix}`;
      const threadId = `thr_close_unlink_${suffix}`;
      const durable = snapshot(runId, threadId);
      const setup = new FileCodexSessionTicketVault({
        projectId: "prj_store",
        runId,
        rootDir: root,
      });
      await setup.save(durable);
      bindCodexSessionTicketRecoveryRun({
        projectId: "prj_store",
        threadId,
        runId,
        rootDir: root,
      });
      const indexPath = codexSessionTicketRecoveryIndexPath("prj_store", threadId, root);
      let unlinkCalls = 0;
      const faulted = new FileCodexSessionTicketVault({
        projectId: "prj_store",
        runId,
        rootDir: root,
        fileAdapters: {
          unlink: (path) => {
            unlinkCalls += 1;
            if (unlinkCalls === failureCall) throw new Error("injected close unlink failure");
            unlinkSync(path);
          },
        },
      });

      await expect(
        faulted.save({ schemaVersion: 1, current: null, successor: null }),
      ).rejects.toThrow("injected close unlink failure");

      await expect(setup.load()).resolves.toEqual(durable);
      expect(existsSync(indexPath)).toBe(true);
      expect(
        findRecoverableCodexSessionTicketRun({
          projectId: "prj_store",
          threadId,
          rootDir: root,
        }),
      ).toBe(runId);
    }
  });

  it("rolls back raw state and its owned index when the commit rename fails", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "crossagent-ticket-close-rename-"));
    const durable = snapshot("run_close_rename", "thr_close_rename");
    const setup = new FileCodexSessionTicketVault({
      projectId: "prj_store",
      runId: "run_close_rename",
      rootDir: root,
    });
    await setup.save(durable);
    bindCodexSessionTicketRecoveryRun({
      projectId: "prj_store",
      threadId: "thr_close_rename",
      runId: "run_close_rename",
      rootDir: root,
    });
    const indexPath = codexSessionTicketRecoveryIndexPath("prj_store", "thr_close_rename", root);
    let renameCalls = 0;
    const faulted = new FileCodexSessionTicketVault({
      projectId: "prj_store",
      runId: "run_close_rename",
      rootDir: root,
      fileAdapters: {
        rename: (oldPath, newPath) => {
          renameCalls += 1;
          if (renameCalls === 2) throw new Error("injected close commit rename failure");
          renameSync(oldPath, newPath);
        },
      },
    });

    await expect(
      faulted.save({ schemaVersion: 1, current: null, successor: null }),
    ).rejects.toThrow("injected close commit rename failure");

    await expect(setup.load()).resolves.toEqual(durable);
    expect(existsSync(indexPath)).toBe(true);
    expect(
      findRecoverableCodexSessionTicketRun({
        projectId: "prj_store",
        threadId: "thr_close_rename",
        rootDir: root,
      }),
    ).toBe("run_close_rename");
  });

  it("restores a PREPARED close journal before exposing recovery state after a crash", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "crossagent-ticket-close-crash-"));
    const durable = snapshot("run_close_crash", "thr_close_crash");
    const vault = new FileCodexSessionTicketVault({
      projectId: "prj_store",
      runId: "run_close_crash",
      rootDir: root,
    });
    await vault.save(durable);
    bindCodexSessionTicketRecoveryRun({
      projectId: "prj_store",
      threadId: "thr_close_crash",
      runId: "run_close_crash",
      rootDir: root,
    });
    const indexPath = codexSessionTicketRecoveryIndexPath("prj_store", "thr_close_crash", root);
    const journalDirectory = resolve(root, "session-tickets", "prj_store", "close-journal");
    const journalPath = resolve(journalDirectory, "run_close_crash.json");
    mkdirSync(journalDirectory, { recursive: true });
    writeFileSync(
      journalPath,
      `${JSON.stringify({
        version: 1,
        projectId: "prj_store",
        runId: "run_close_crash",
        state: "PREPARED",
        vault: durable,
        indexes: [
          {
            name: basename(indexPath),
            record: JSON.parse(readFileSync(indexPath, "utf8")),
          },
        ],
        checkpoint: null,
        updatedAt: new Date().toISOString(),
      })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    chmodSync(journalPath, 0o600);
    unlinkSync(indexPath);
    unlinkSync(vault.path);

    await expect(vault.load()).resolves.toEqual(durable);
    expect(existsSync(indexPath)).toBe(true);
    expect(existsSync(journalPath)).toBe(false);
    expect(
      findRecoverableCodexSessionTicketRun({
        projectId: "prj_store",
        threadId: "thr_close_crash",
        rootDir: root,
      }),
    ).toBe("run_close_crash");
  });

  it("never steals a stale-looking recovery lock from a live owner", () => {
    const root = mkdtempSync(resolve(tmpdir(), "crossagent-ticket-live-lock-"));
    const lockPath = codexSessionTicketRecoveryLockPath("prj_store", root);
    mkdirSync(lockPath, { recursive: true });
    writeFileSync(
      resolve(lockPath, "owner.json"),
      `${JSON.stringify({
        pid: 91_001,
        nonce: "live-owner-nonce",
        createdAt: "2026-01-01T00:00:00.000Z",
      })}\n`,
      "utf8",
    );

    expect(() =>
      findRecoverableCodexSessionTicketRun({
        projectId: "prj_store",
        threadId: "thr_locked",
        rootDir: root,
        lockAdapters: {
          now: () => Date.parse("2026-08-01T00:00:00.000Z"),
          processExists: (pid) => pid === 91_001,
          attempts: 1,
          waitMs: 0,
        },
      }),
    ).toThrow(/index is busy/i);
    expect(JSON.parse(readFileSync(resolve(lockPath, "owner.json"), "utf8"))).toMatchObject({
      nonce: "live-owner-nonce",
    });
  });

  it("recovers a crashed owner through a tombstone without deleting a concurrent successor", () => {
    const root = mkdtempSync(resolve(tmpdir(), "crossagent-ticket-stale-lock-"));
    const lockPath = codexSessionTicketRecoveryLockPath("prj_store", root);
    mkdirSync(lockPath, { recursive: true });
    writeFileSync(
      resolve(lockPath, "owner.json"),
      `${JSON.stringify({
        pid: 91_002,
        nonce: "crashed-owner-nonce",
        createdAt: "2026-01-01T00:00:00.000Z",
      })}\n`,
      "utf8",
    );

    expect(() =>
      bindCodexSessionTicketRecoveryRun({
        projectId: "prj_store",
        threadId: "thr_stale_lock",
        runId: "run_stale_lock",
        rootDir: root,
        lockAdapters: {
          now: () => Date.parse("2026-08-01T00:00:00.000Z"),
          processExists: () => false,
          attempts: 2,
          waitMs: 0,
          afterStaleLockTombstoned: (currentLockPath) => {
            mkdirSync(currentLockPath);
            writeFileSync(
              resolve(currentLockPath, "owner.json"),
              `${JSON.stringify({
                pid: 91_003,
                nonce: "successor-owner-nonce",
                createdAt: "2026-08-01T00:00:00.000Z",
              })}\n`,
              "utf8",
            );
          },
        },
      }),
    ).toThrow(/index is busy/i);
    expect(JSON.parse(readFileSync(resolve(lockPath, "owner.json"), "utf8"))).toMatchObject({
      nonce: "successor-owner-nonce",
    });

    // Once the concurrent live owner releases, the same crashed lock is recoverable normally.
    writeFileSync(
      resolve(lockPath, "owner.json"),
      `${JSON.stringify({
        pid: 91_003,
        nonce: "released-successor-nonce",
        createdAt: "2026-01-01T00:00:00.000Z",
      })}\n`,
      "utf8",
    );
    bindCodexSessionTicketRecoveryRun({
      projectId: "prj_store",
      threadId: "thr_stale_lock",
      runId: "run_stale_lock",
      rootDir: root,
      lockAdapters: {
        now: () => Date.parse("2026-08-01T00:00:00.000Z"),
        processExists: () => false,
        attempts: 2,
        waitMs: 0,
      },
    });
    expect(existsSync(lockPath)).toBe(false);
  });

  it("does not let two stale-lock readers delete the successor installed by the winning reaper", () => {
    const root = mkdtempSync(resolve(tmpdir(), "crossagent-ticket-double-reaper-"));
    const lockPath = codexSessionTicketRecoveryLockPath("prj_store", root);
    mkdirSync(lockPath, { recursive: true });
    writeFileSync(
      resolve(lockPath, "owner.json"),
      `${JSON.stringify({
        pid: 91_004,
        nonce: "shared-stale-owner",
        createdAt: "2026-01-01T00:00:00.000Z",
      })}\n`,
      "utf8",
    );
    let secondReaderRan = false;

    expect(() =>
      findRecoverableCodexSessionTicketRun({
        projectId: "prj_store",
        threadId: "thr_double_reaper",
        rootDir: root,
        lockAdapters: {
          now: () => Date.parse("2026-08-01T00:00:00.000Z"),
          processExists: (pid) => pid === 91_005,
          attempts: 1,
          waitMs: 0,
          afterStaleOwnerRead: () => {
            if (secondReaderRan) return;
            secondReaderRan = true;
            expect(() =>
              findRecoverableCodexSessionTicketRun({
                projectId: "prj_store",
                threadId: "thr_double_reaper",
                rootDir: root,
                lockAdapters: {
                  now: () => Date.parse("2026-08-01T00:00:00.000Z"),
                  processExists: (pid) => pid === 91_005,
                  attempts: 1,
                  waitMs: 0,
                  afterStaleLockTombstoned: (currentLockPath) => {
                    mkdirSync(currentLockPath);
                    writeFileSync(
                      resolve(currentLockPath, "owner.json"),
                      `${JSON.stringify({
                        pid: 91_005,
                        nonce: "successor-after-winning-reaper",
                        createdAt: "2026-08-01T00:00:00.000Z",
                      })}\n`,
                      "utf8",
                    );
                  },
                },
              }),
            ).toThrow(/index is busy/i);
          },
        },
      }),
    ).toThrow(/index is busy/i);

    expect(secondReaderRan).toBe(true);
    expect(JSON.parse(readFileSync(resolve(lockPath, "owner.json"), "utf8"))).toMatchObject({
      nonce: "successor-after-winning-reaper",
    });
  });

  it("retries transient Windows sharing violations while atomically replacing a checkpoint", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "crossagent-ticket-checkpoint-sharing-"));
    const initialStore = new FileCodexSessionOperationalCheckpointStore(root);
    const initial = checkpoint();
    await initialStore.save(initial);

    const delays: number[] = [];
    let renameAttempts = 0;
    const retryingStore = new FileCodexSessionOperationalCheckpointStore(root, {
      platform: "win32",
      wait: (milliseconds) => delays.push(milliseconds),
      rename: (oldPath, newPath) => {
        renameAttempts += 1;
        if (renameAttempts <= 2) {
          throw Object.assign(new Error("injected Windows sharing violation"), { code: "EPERM" });
        }
        renameSync(oldPath, newPath);
      },
    });
    const next = checkpoint({ heartbeat: 9, eventSequence: 43 });

    await expect(retryingStore.save(next)).resolves.toBeUndefined();
    expect(renameAttempts).toBe(3);
    expect(delays).toEqual([10, 20]);
    await expect(retryingStore.load("prj_store", "thr_checkpoint")).resolves.toEqual(next);
    expect(
      readdirSync(
        dirname(codexSessionOperationalCheckpointPath("prj_store", "thr_checkpoint", root)),
      ).filter((name) => name.endsWith(".tmp")),
    ).toEqual([]);
  });

  it("fails closed after bounded Windows sharing retries and preserves the old checkpoint", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "crossagent-ticket-checkpoint-sharing-exhausted-"));
    const initialStore = new FileCodexSessionOperationalCheckpointStore(root);
    const initial = checkpoint();
    await initialStore.save(initial);

    const delays: number[] = [];
    let renameAttempts = 0;
    const failingStore = new FileCodexSessionOperationalCheckpointStore(root, {
      platform: "win32",
      wait: (milliseconds) => delays.push(milliseconds),
      rename: () => {
        renameAttempts += 1;
        throw Object.assign(new Error("persistent Windows sharing violation"), { code: "EBUSY" });
      },
    });

    await expect(
      failingStore.save(checkpoint({ heartbeat: 9, eventSequence: 43 })),
    ).rejects.toMatchObject({ code: "EBUSY" });
    expect(renameAttempts).toBe(8);
    expect(delays).toEqual([10, 20, 40, 80, 160, 320, 640]);
    await expect(initialStore.load("prj_store", "thr_checkpoint")).resolves.toEqual(initial);
    expect(
      readdirSync(
        dirname(codexSessionOperationalCheckpointPath("prj_store", "thr_checkpoint", root)),
      ).filter((name) => name.endsWith(".tmp")),
    ).toEqual([]);
  });

  it("does not retry a non-sharing checkpoint rename failure", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "crossagent-ticket-checkpoint-rename-failed-"));
    const initialStore = new FileCodexSessionOperationalCheckpointStore(root);
    const initial = checkpoint();
    await initialStore.save(initial);

    const delays: number[] = [];
    let renameAttempts = 0;
    const failingStore = new FileCodexSessionOperationalCheckpointStore(root, {
      platform: "win32",
      wait: (milliseconds) => delays.push(milliseconds),
      rename: () => {
        renameAttempts += 1;
        throw Object.assign(new Error("injected non-sharing rename failure"), { code: "EINVAL" });
      },
    });

    await expect(
      failingStore.save(checkpoint({ heartbeat: 9, eventSequence: 43 })),
    ).rejects.toMatchObject({ code: "EINVAL" });
    expect(renameAttempts).toBe(1);
    expect(delays).toEqual([]);
    await expect(initialStore.load("prj_store", "thr_checkpoint")).resolves.toEqual(initial);
    expect(
      readdirSync(
        dirname(codexSessionOperationalCheckpointPath("prj_store", "thr_checkpoint", root)),
      ).filter((name) => name.endsWith(".tmp")),
    ).toEqual([]);
  });

  it("persists non-secret cursor, pending queue, and heartbeat progress independently of raw tickets", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "crossagent-ticket-checkpoint-"));
    const store = new FileCodexSessionOperationalCheckpointStore(root);
    const initial = checkpoint();
    await store.save(initial);
    const path = codexSessionOperationalCheckpointPath("prj_store", "thr_checkpoint", root);
    expect(path).not.toContain("thr_checkpoint");
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    await expect(store.load("prj_store", "thr_checkpoint")).resolves.toEqual(initial);

    const auxiliary = checkpoint({
      bundleId: "stb_auxiliary",
      heartbeat: 9,
      eventSequence: 43,
      pendingMessageIds: ["msg_pending_one", "msg_pending_two"],
    });
    await store.save(auxiliary);
    await expect(store.load("prj_store", "thr_checkpoint")).resolves.toEqual(auxiliary);

    const replacement = checkpoint({
      runId: "run_replacement",
      hubSessionId: "ses_replacement",
      incarnation: 2,
      bundleId: "stb_replacement",
      heartbeat: 1,
      eventSequence: 43,
      pendingMessageIds: ["msg_pending_two"],
    });
    await store.save(replacement);
    await expect(store.load("prj_store", "thr_checkpoint")).resolves.toEqual(replacement);
    await expect(
      store.save({ ...replacement, eventSequence: 41, updatedAt: new Date().toISOString() }),
    ).rejects.toThrow(/cursor cannot move backwards/i);
  });

  it("keeps operational progress after confirmed close deletes the raw vault", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "crossagent-ticket-checkpoint-close-"));
    const store = new FileCodexSessionOperationalCheckpointStore(root);
    const durable = checkpoint();
    await store.save(durable);
    const vault = new FileCodexSessionTicketVault({
      projectId: "prj_store",
      runId: "run_checkpoint",
      rootDir: root,
    });
    await vault.save(snapshot("run_checkpoint", "thr_checkpoint"));
    bindCodexSessionTicketRecoveryRun({
      projectId: "prj_store",
      threadId: "thr_checkpoint",
      runId: "run_checkpoint",
      rootDir: root,
    });

    await vault.save({ schemaVersion: 1, current: null, successor: null });

    expect(existsSync(vault.path)).toBe(false);
    await expect(store.load("prj_store", "thr_checkpoint")).resolves.toEqual(durable);
  });

  it("replays the exact owner and bundle after checkpoint PREPARED but vault deletion fails", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "crossagent-cross-store-vault-fail-"));
    const runId = "run_cross_vault_fail";
    const threadId = "thr_cross_vault_fail";
    const bundleId = "stb_cross_vault_fail";
    const durable = activeSnapshot(runId, threadId, bundleId);
    const checkpointStore = new FileCodexSessionOperationalCheckpointStore(root);
    await checkpointStore.save(activeCheckpoint(runId, threadId, bundleId));
    const setupVault = new FileCodexSessionTicketVault({
      projectId: "prj_store",
      runId,
      rootDir: root,
    });
    await setupVault.save(durable);
    bindCodexSessionTicketRecoveryRun({ projectId: "prj_store", threadId, runId, rootDir: root });
    const faultedVault = new FileCodexSessionTicketVault({
      projectId: "prj_store",
      runId,
      rootDir: root,
      fileAdapters: {
        unlink: () => {
          throw new Error("injected cross-store vault deletion failure");
        },
      },
    });

    await expect(
      fileRuntime(faultedVault, checkpointStore).clearAfterConfirmedClose(bundleId),
    ).rejects.toThrow("injected cross-store vault deletion failure");

    await expect(setupVault.load()).resolves.toEqual(durable);
    await expect(checkpointStore.load("prj_store", threadId)).resolves.toMatchObject({
      ownerRunId: runId,
      session: { bundleId },
      confirmedClose: { bundleId, state: "PREPARED" },
    });
    const coldVault = new FileCodexSessionTicketVault({
      projectId: "prj_store",
      runId,
      rootDir: root,
    });
    const coldCheckpointStore = new FileCodexSessionOperationalCheckpointStore(root);
    await expect(
      fileRuntime(coldVault, coldCheckpointStore).clearAfterConfirmedClose("stb_wrong_bundle"),
    ).rejects.toThrow(/sole durable.*bundle/i);
    expect(existsSync(coldVault.path)).toBe(true);

    await expect(
      fileRuntime(coldVault, coldCheckpointStore).clearAfterConfirmedClose(bundleId),
    ).resolves.toBeUndefined();
    expect(existsSync(coldVault.path)).toBe(false);
    expect(existsSync(codexSessionTicketRecoveryIndexPath("prj_store", threadId, root))).toBe(
      false,
    );
    await expect(coldCheckpointStore.load("prj_store", threadId)).resolves.toMatchObject({
      ownerRunId: runId,
      session: null,
    });
  });

  it("rolls back a committed vault close on cold restart when the final checkpoint save fails", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "crossagent-cross-store-checkpoint-fail-"));
    const runId = "run_cross_checkpoint_fail";
    const threadId = "thr_cross_checkpoint_fail";
    const bundleId = "stb_cross_checkpoint_fail";
    const durable = activeSnapshot(runId, threadId, bundleId);
    const initialCheckpointStore = new FileCodexSessionOperationalCheckpointStore(root);
    await initialCheckpointStore.save(activeCheckpoint(runId, threadId, bundleId));
    const vault = new FileCodexSessionTicketVault({
      projectId: "prj_store",
      runId,
      rootDir: root,
    });
    await vault.save(durable);
    bindCodexSessionTicketRecoveryRun({ projectId: "prj_store", threadId, runId, rootDir: root });
    let checkpointRenames = 0;
    const faultedCheckpointStore = new FileCodexSessionOperationalCheckpointStore(root, {
      rename: (oldPath, newPath) => {
        checkpointRenames += 1;
        if (checkpointRenames === 2) {
          throw new Error("injected final checkpoint save failure");
        }
        renameSync(oldPath, newPath);
      },
    });

    await expect(
      fileRuntime(vault, faultedCheckpointStore).clearAfterConfirmedClose(bundleId),
    ).rejects.toThrow("injected final checkpoint save failure");

    const checkpointPath = codexSessionOperationalCheckpointPath("prj_store", threadId, root);
    const journalPath = resolve(
      root,
      "session-tickets",
      "prj_store",
      "close-journal",
      `${runId}.json`,
    );
    const preparedCheckpoint = readFileSync(checkpointPath, "utf8");
    const parsedPreparedCheckpoint = parseCodexSessionOperationalCheckpoint(
      JSON.parse(preparedCheckpoint),
    );
    expect(existsSync(vault.path)).toBe(false);
    expect(existsSync(journalPath)).toBe(true);
    expect(JSON.parse(preparedCheckpoint)).toMatchObject({
      ownerRunId: runId,
      session: { bundleId },
      confirmedClose: { bundleId, state: "PREPARED" },
    });

    for (const mutation of [
      { ownerRunId: "run_wrong_owner" },
      {
        session: { ...parsedPreparedCheckpoint.session!, bundleId: "stb_wrong_bundle" },
        confirmedClose: {
          ...parsedPreparedCheckpoint.confirmedClose!,
          bundleId: "stb_wrong_bundle",
        },
      },
    ]) {
      writeFileSync(
        checkpointPath,
        `${JSON.stringify({ ...parsedPreparedCheckpoint, ...mutation })}\n`,
        "utf8",
      );
      await expect(vault.load()).rejects.toThrow(/exact owner and bundle/i);
      expect(existsSync(vault.path)).toBe(false);
      expect(existsSync(journalPath)).toBe(true);
    }
    writeFileSync(checkpointPath, preparedCheckpoint, "utf8");

    const coldVault = new FileCodexSessionTicketVault({
      projectId: "prj_store",
      runId,
      rootDir: root,
    });
    const coldCheckpointStore = new FileCodexSessionOperationalCheckpointStore(root);
    const wrongOwnerCompletion = structuredClone(parsedPreparedCheckpoint);
    wrongOwnerCompletion.ownerRunId = "run_wrong_owner";
    wrongOwnerCompletion.session = null;
    delete wrongOwnerCompletion.confirmedClose;
    await expect(coldCheckpointStore.save(wrongOwnerCompletion)).rejects.toThrow(
      /missing its committed vault transaction/i,
    );
    await expect(coldVault.load()).resolves.toEqual(durable);
    await expect(coldCheckpointStore.load("prj_store", threadId)).resolves.toMatchObject({
      ownerRunId: runId,
      session: { bundleId },
      confirmedClose: { bundleId, state: "PREPARED" },
    });
    await expect(
      fileRuntime(coldVault, coldCheckpointStore).clearAfterConfirmedClose("stb_wrong_bundle"),
    ).rejects.toThrow(/sole durable.*bundle/i);
    await expect(coldVault.load()).resolves.toEqual(durable);

    await expect(
      fileRuntime(coldVault, coldCheckpointStore).clearAfterConfirmedClose(bundleId),
    ).resolves.toBeUndefined();
    expect(existsSync(coldVault.path)).toBe(false);
    expect(existsSync(journalPath)).toBe(false);
    await expect(coldCheckpointStore.load("prj_store", threadId)).resolves.toMatchObject({
      ownerRunId: runId,
      session: null,
    });
  });

  it("refuses confirmed close while a durable successor exists without changing either store", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "crossagent-cross-store-successor-"));
    const runId = "run_cross_successor";
    const threadId = "thr_cross_successor";
    const bundleId = "stb_cross_successor";
    const durable = activeSnapshot(runId, threadId, bundleId);
    const offeredSuccessor = snapshot(runId, threadId).current!;
    offeredSuccessor.bundleId = "stb_uncommitted_successor";
    offeredSuccessor.raw = {
      CONTROL: raw("M"),
      MODEL_MCP: raw("N"),
      INJECTOR: raw("O"),
    };
    durable.successor = offeredSuccessor;
    const checkpointStore = new FileCodexSessionOperationalCheckpointStore(root);
    const initialCheckpoint = activeCheckpoint(runId, threadId, bundleId);
    await checkpointStore.save(initialCheckpoint);
    const vault = new FileCodexSessionTicketVault({
      projectId: "prj_store",
      runId,
      rootDir: root,
    });
    await vault.save(durable);

    await expect(
      fileRuntime(vault, checkpointStore).clearAfterConfirmedClose(bundleId),
    ).rejects.toThrow(/sole durable.*bundle/i);
    await expect(vault.load()).resolves.toEqual(durable);
    await expect(checkpointStore.load("prj_store", threadId)).resolves.toEqual(initialCheckpoint);
  });
});
