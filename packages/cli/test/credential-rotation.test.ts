import { createHash } from "node:crypto";
import { chmod, link, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CREDENTIAL_ROTATION_CRASH_POINTS,
  CREDENTIAL_ROTATION_SLOTS,
  CANONICAL_CREDENTIAL_SCOPES,
  CredentialRotationCoordinator,
  CredentialRotationFiles,
  assertCredentialRotationSnapshotBoundary,
  assertNoInlineCredentialOverrides,
  digestCredentialRotationCommitReceipt,
  digestCredentialToken,
  type CredentialRotationDatabaseAdapter,
  type CredentialRotationDatabaseCommitInput,
  type CredentialRotationDatabaseCommitReceipt,
  type CredentialRotationDatabaseObservation,
  type CredentialRotationDatabasePrepareInput,
  type CredentialRotationPhase,
  type CredentialRotationRequest,
  type ExactHubStopReceipt,
} from "../src/credential-rotation.js";

const roots: string[] = [];
const timestamp = "2026-08-01T12:00:00.000Z";
const nextTimestamp = "2026-08-01T12:00:01.000Z";
const build = Object.freeze({
  buildId: "1".repeat(64),
  buildSessionId: "123e4567-e89b-42d3-a456-426614174000",
  protocolId: "2".repeat(64),
  manifestSha256: "3".repeat(64),
  migrationId: "4".repeat(64),
});

function temporaryRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "crossagent-credential-cli-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function token(label: string): string {
  return `crx_${label}_${"x".repeat(48)}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function journalPlan(
  authorizationSource: unknown = {
    kind: "USER_TURN",
    id: "utr_rotation_authorization",
    projectId: "prj_rotation",
  },
  stopReceipt: unknown = {
    operationId: "scr_fixture",
    projectId: "prj_rotation",
    receiptSha256: "7".repeat(64),
    stoppedAt: timestamp,
  },
): unknown {
  const plan = {
    authorizationFingerprint: "8".repeat(64),
    authorizationReceiptSha256: "5".repeat(64),
    authorizationSource,
    incidentStartedAt: "2026-07-28T00:00:00.000Z",
    members: CREDENTIAL_ROTATION_SLOTS.map(({ slot }) => ({
      slot,
      generation: 1,
      oldTokenSha256: digestCredentialToken(`journal-old-${slot}`),
      tokenSha256: digestCredentialToken(`journal-new-${slot}`),
      stagedFileSha256: digestCredentialToken(`journal-staged-${slot}`),
      scopes: [...CANONICAL_CREDENTIAL_SCOPES[slot]],
    })),
    operationId: "scr_fixture",
    projectId: "prj_rotation",
    requestSha256: "",
    securityEpochBefore: 1,
    securityEpochAfter: 2,
    stopReceipt,
  };
  plan.requestSha256 = sha256(
    canonicalJson({
      operationId: plan.operationId,
      projectId: plan.projectId,
      authorizationSource: plan.authorizationSource,
      authorizationReceiptSha256: plan.authorizationReceiptSha256,
      stopReceipt: plan.stopReceipt,
      incidentStartedAt: plan.incidentStartedAt,
      securityEpochBefore: plan.securityEpochBefore,
      securityEpochAfter: plan.securityEpochAfter,
      members: plan.members,
    }),
  );
  return plan;
}

function journalRecord(operation: unknown): string {
  const unsigned = {
    schemaVersion: 1,
    sequence: 1,
    operationId: "scr_fixture",
    phase: "AUTHORIZED",
    securityEpoch: 2,
    operation,
    evidenceSha256: null,
    recordedAt: nextTimestamp,
    previousHash: null,
  };
  return `${canonicalJson({
    ...unsigned,
    recordHash: sha256(canonicalJson(unsigned)),
  })}\n`;
}

function request(operationId = "scr_fixture"): CredentialRotationRequest {
  return {
    operationId,
    projectId: "prj_rotation",
    authorizationSource: {
      kind: "USER_TURN",
      id: "utr_rotation_authorization",
      projectId: "prj_rotation",
    },
    authorizationReceiptSha256: "5".repeat(64),
    incidentStartedAt: "2026-07-28T00:00:00.000Z",
    expectedHub: {
      instanceId: "a".repeat(32),
      pid: 4242,
      startedAt: "2026-07-27T00:00:00.000Z",
      buildIdentity: build,
    },
  };
}

function stopReceipt(operationId = "scr_fixture", projectId = "prj_rotation"): ExactHubStopReceipt {
  return {
    state: "CONFIRMED",
    operationId,
    projectId,
    instanceId: "a".repeat(32),
    pid: 4242,
    startedAt: "2026-07-27T00:00:00.000Z",
    buildIdentity: build,
    idempotencyKey: "123e4567-e89b-42d3-a456-426614174001",
    stoppedAt: timestamp,
  };
}

class FakeDatabase implements CredentialRotationDatabaseAdapter {
  securityEpoch = 0;
  activeSlots = CREDENTIAL_ROTATION_SLOTS.map(({ slot }) => ({
    slot,
    generation: 0,
    tokenSha256: digestCredentialToken(token(`old-${slot}`)),
    scopes: [...CANONICAL_CREDENTIAL_SCOPES[slot]],
  }));
  phase: CredentialRotationPhase | null = null;
  prepared: CredentialRotationDatabasePrepareInput | null = null;
  receipt: CredentialRotationDatabaseCommitReceipt | null = null;
  calls: string[] = [];
  failAfterCommit = false;
  failCleanup = false;

  async inspect(operationId: string): Promise<CredentialRotationDatabaseObservation> {
    this.calls.push(`inspect:${operationId}`);
    return {
      securityEpoch: this.securityEpoch,
      activeSlots: structuredClone(this.activeSlots),
      operation:
        this.prepared?.operationId === operationId
          ? {
              operationId,
              phase: this.phase!,
              requestSha256: this.prepared.requestSha256,
              securityEpochBefore: this.prepared.securityEpochBefore,
              securityEpochAfter: this.prepared.securityEpochAfter,
              members: structuredClone(this.prepared.members),
              commitReceipt: this.receipt,
            }
          : null,
    };
  }

  async prepare(input: CredentialRotationDatabasePrepareInput): Promise<void> {
    this.calls.push("prepare");
    if (this.phase === "ABORTED" && this.prepared?.operationId !== input.operationId) {
      this.prepared = null;
      this.receipt = null;
      this.phase = null;
    }
    if (this.prepared && this.prepared.requestSha256 !== input.requestSha256) {
      throw new Error("request conflict");
    }
    this.prepared ??= structuredClone(input);
    this.phase ??= "PREPARED";
  }

  async advance(
    operationId: string,
    expected: CredentialRotationPhase,
    next: CredentialRotationPhase,
  ): Promise<void> {
    this.calls.push(`advance:${expected}->${next}`);
    if (this.prepared?.operationId !== operationId) throw new Error("missing operation");
    if (this.phase !== expected && this.phase !== next) throw new Error("phase conflict");
    this.phase = next;
  }

  async abortPrepared(operationId: string, requestSha256: string): Promise<void> {
    this.calls.push("abort");
    if (
      this.prepared?.operationId !== operationId ||
      this.prepared.requestSha256 !== requestSha256
    ) {
      throw new Error("abort conflict");
    }
    this.phase = "ABORTED";
  }

  async commit(
    input: CredentialRotationDatabaseCommitInput,
  ): Promise<CredentialRotationDatabaseCommitReceipt> {
    this.calls.push("commit");
    if (this.receipt) return this.receipt;
    if (input.members.length !== 8) throw new Error("not atomic");
    this.securityEpoch = input.securityEpochAfter;
    this.activeSlots = input.members.map(({ slot, generation, tokenSha256, scopes }) => ({
      slot,
      generation,
      tokenSha256,
      scopes: [...scopes],
    }));
    this.phase = "DB_COMMITTED";
    const unsigned = {
      operationId: input.operationId,
      requestSha256: input.requestSha256,
      securityEpoch: input.securityEpochAfter,
      memberCount: 8 as const,
      oldRootRevocationCount: 8 as const,
      revokedIncidentBundleCount: 2,
      revokedIncidentTicketCount: 6,
      revokedCaptureBindingCount: 2,
      abortedPreparedSyntheticPromptCount: 1,
      supersededIssuedLaunchReservationCount: 1,
      incidentStartedAt: input.incidentStartedAt,
      cutoverAt: input.stopReceipt.stoppedAt,
      committedAt: nextTimestamp,
      terminalUnrestrictedReviewRequired: true as const,
      incidentAuditSha256: "6".repeat(64),
      atomic: true as const,
    };
    this.receipt = {
      ...unsigned,
      receiptSha256: digestCredentialRotationCommitReceipt(unsigned),
    };
    if (this.failAfterCommit) throw Object.assign(new Error("lost ack"), { code: "ECONNRESET" });
    return this.receipt;
  }

  async recoverExternal(
    input: CredentialRotationDatabaseCommitInput,
  ): Promise<CredentialRotationDatabaseCommitReceipt> {
    this.calls.push("recoverExternal");
    this.prepared ??= {
      ...structuredClone(input),
      authorizationReceiptSha256: "5".repeat(64),
    };
    this.phase ??= "FILES_INSTALLED";
    return this.commit(input);
  }
}

async function seedCanonical(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  for (const { slot, filename } of CREDENTIAL_ROTATION_SLOTS) {
    await writeFile(path.join(root, filename), `${token(`old-${slot}`)}\n`, { mode: 0o600 });
    await chmod(path.join(root, filename), 0o600);
  }
}

function coordinator(
  root: string,
  database = new FakeDatabase(),
  options: {
    fault?: (point: string) => void;
    environment?: NodeJS.ProcessEnv;
    stop?: (
      expected: CredentialRotationRequest["expectedHub"],
      operation: { operationId: string; projectId: string },
    ) => Promise<ExactHubStopReceipt>;
    verifyAcl?: (file: string) => Promise<boolean>;
  } = {},
) {
  let generation = 0;
  return {
    database,
    value: new CredentialRotationCoordinator({
      dataDir: root,
      database,
      environment: options.environment ?? {},
      stopExactHub:
        options.stop ??
        (async (_expected, operation) => stopReceipt(operation.operationId, operation.projectId)),
      generateToken: (slot) => token(`new-${slot}-${++generation}`),
      now: () => nextTimestamp,
      verifyOwnerPrivateAcl: options.verifyAcl ?? (async () => true),
      faultInjector: options.fault,
      sharingRetry: { attempts: 3, delayMs: 0, sleep: async () => undefined },
    }),
  };
}

describe("credential rotation contract", () => {
  it("fixes the exact eight canonical slots and filenames", () => {
    expect(CREDENTIAL_ROTATION_SLOTS).toEqual([
      { slot: "token", filename: "token" },
      { slot: "agent-codex", filename: "agent-codex-token" },
      { slot: "agent-claude", filename: "agent-claude-token" },
      { slot: "dashboard", filename: "dashboard-token" },
      { slot: "capture-codex", filename: "capture-codex-token" },
      { slot: "capture-claude", filename: "capture-claude-token" },
      { slot: "inject-codex", filename: "inject-codex-token" },
      { slot: "inject-claude", filename: "inject-claude-token" },
    ]);
  });

  it.each([
    "CROSSAGENT_TOKEN",
    "CROSSAGENT_DASHBOARD_TOKEN",
    "CROSSAGENT_CODEX_AGENT_TOKEN",
    "CROSSAGENT_CLAUDE_CAPTURE_TOKEN",
    "CROSSAGENT_CLAUDE_INJECTOR_TOKEN",
  ])("rejects inline secret override %s before stop or file access", (name) => {
    expect(() => assertNoInlineCredentialOverrides({ [name]: "secret-canary" })).toThrowError(
      expect.objectContaining({ code: "INLINE_CREDENTIAL_OVERRIDE" }),
    );
  });

  it("allows file-path overrides to be diagnosed by the caller without reading them", () => {
    expect(() =>
      assertNoInlineCredentialOverrides({ CROSSAGENT_CODEX_AGENT_TOKEN_FILE: "X:\\safe\\path" }),
    ).not.toThrow();
  });

  it.each([
    "authority/ed25519-private-key.pem",
    "authority/trusted-signing-keys.json",
    "security/credential-rotation-journal.jsonl",
    "security/security-epoch-2.json",
    "token",
    "capture-codex-token",
  ])("rejects sensitive state from ordinary snapshots: %s", (logicalPath) => {
    expect(() => assertCredentialRotationSnapshotBoundary([logicalPath])).toThrowError(
      expect.objectContaining({ code: "SENSITIVE_SECURITY_STATE_PATH" }),
    );
  });

  it("fails closed when nested journal authorization or stop receipt schemas are not exact", async () => {
    const invalidPlans = [
      journalPlan({
        kind: "USER_TURN",
        id: "utr_rotation_authorization",
        projectId: "prj_rotation",
        unexpected: "field",
      }),
      journalPlan(undefined, {
        operationId: "scr_fixture",
        projectId: "prj_rotation",
        receiptSha256: "7".repeat(64),
      }),
      journalPlan(undefined, {
        operationId: "scr_fixture",
        projectId: "prj_rotation",
        receiptSha256: "7".repeat(64),
        stoppedAt: "2026-08-01T12:00:00Z",
      }),
    ];
    for (const operation of invalidPlans) {
      const root = temporaryRoot();
      const files = new CredentialRotationFiles(root, async () => true);
      await files.initialize();
      await writeFile(files.journalPath, journalRecord(operation), { mode: 0o600 });
      await expect(files.readJournal()).rejects.toMatchObject({
        code: "EXTERNAL_JOURNAL_INVALID",
      });
    }
  });

  it("requires an exact instance-bound cooperative stop receipt", async () => {
    const root = temporaryRoot();
    await seedCanonical(root);
    const bad = stopReceipt();
    const { value, database } = coordinator(root, undefined, {
      stop: async () => ({ ...bad, instanceId: "b".repeat(32) }),
    });
    await expect(value.rotate(request())).rejects.toMatchObject({
      code: "HUB_STOP_RECEIPT_INVALID",
    });
    expect(database.calls).toEqual(["inspect:scr_fixture"]);
    expect(await readFile(path.join(root, "token"), "utf8")).toContain("old-token");
  });

  it("rotates all slots, commits one atomic DB receipt, and emits no raw token", async () => {
    const root = temporaryRoot();
    await seedCanonical(root);
    const { value, database } = coordinator(root);
    const result = await value.rotate(request());
    expect(result.phase).toBe("COMPLETED");
    expect(result.securityEpoch).toBe(1);
    expect(result.incidentAudit).toMatchObject({ terminalUnrestrictedReviewRequired: true });
    expect(database.calls.filter((call) => call === "commit")).toHaveLength(1);
    for (const { slot, filename } of CREDENTIAL_ROTATION_SLOTS) {
      expect(await readFile(path.join(root, filename), "utf8")).toContain(`new-${slot}`);
    }
    const journal = await readFile(
      path.join(root, "security", "credential-rotation-journal.jsonl"),
      "utf8",
    );
    expect(journal).not.toContain("crx_");
    expect(journal).not.toContain("secret-canary");
    expect(journal).toContain('"phase":"COMPLETED"');
  });

  it("replays the same operation idempotently without regenerating or recommitting", async () => {
    const root = temporaryRoot();
    await seedCanonical(root);
    const fixture = coordinator(root);
    const first = await fixture.value.rotate(request());
    const second = await fixture.value.rotate(request());
    expect(second).toEqual(first);
    expect(fixture.database.calls.filter((call) => call === "commit")).toHaveLength(1);
  });

  it("rejects the same operation id with a different authorization/request", async () => {
    const root = temporaryRoot();
    await seedCanonical(root);
    const { value } = coordinator(root);
    await value.rotate(request());
    await expect(
      value.rotate({ ...request(), authorizationReceiptSha256: "7".repeat(64) }),
    ).rejects.toMatchObject({ code: "ROTATION_CONFLICT" });
  });

  it("reconciles lost DB commit ACK from the exact durable receipt", async () => {
    const root = temporaryRoot();
    await seedCanonical(root);
    const database = new FakeDatabase();
    database.failAfterCommit = true;
    const { value } = coordinator(root, database);
    const result = await value.rotate(request());
    expect(result.phase).toBe("COMPLETED");
    expect(database.calls.filter((call) => call === "commit")).toHaveLength(1);
  });

  it("aborts a fully-old STAGED operation without touching canonical files", async () => {
    const root = temporaryRoot();
    await seedCanonical(root);
    let crash = true;
    const fixture = coordinator(root, undefined, {
      fault: (point) => {
        if (crash && point === "after-journal-STAGED") throw new Error("crash");
      },
    });
    await expect(fixture.value.rotate(request())).rejects.toThrow("crash");
    crash = false;
    const result = await fixture.value.reconcile("scr_fixture");
    expect(result.phase).toBe("ABORTED");
    expect(fixture.database.calls).toContain("abort");
    expect(await readFile(path.join(root, "token"), "utf8")).toContain("old-token");
  });

  it("only moves forward after the first canonical rename", async () => {
    const root = temporaryRoot();
    await seedCanonical(root);
    let crash = true;
    const fixture = coordinator(root, undefined, {
      fault: (point) => {
        if (crash && point === "after-install-token") throw new Error("crash");
      },
    });
    await expect(fixture.value.rotate(request())).rejects.toThrow("crash");
    crash = false;
    const result = await fixture.value.reconcile("scr_fixture");
    expect(result.phase).toBe("COMPLETED");
    expect(fixture.database.calls).not.toContain("abort");
    for (const { filename } of CREDENTIAL_ROTATION_SLOTS) {
      expect(await readFile(path.join(root, filename), "utf8")).toContain("new-");
    }
  });

  it("fails closed if a required staged file is lost after switching", async () => {
    const root = temporaryRoot();
    await seedCanonical(root);
    let crash = true;
    const fixture = coordinator(root, undefined, {
      fault: (point) => {
        if (crash && point === "after-install-token") throw new Error("crash");
      },
    });
    await expect(fixture.value.rotate(request())).rejects.toThrow("crash");
    crash = false;
    await rmSync(path.join(root, `.crossagent-rotation.scr_fixture.agent-codex-token.staged`), {
      force: true,
    });
    await expect(fixture.value.reconcile("scr_fixture")).rejects.toMatchObject({
      code: "STAGED_CREDENTIAL_MISSING",
    });
    expect(await readFile(path.join(root, "token"), "utf8")).toContain("new-token");
  });

  it("does not reactivate quarantined old roots when cleanup fails", async () => {
    const root = temporaryRoot();
    await seedCanonical(root);
    const fixture = coordinator(root);
    vi.spyOn(fixture.value.files, "removeQuarantine").mockRejectedValueOnce(
      Object.assign(new Error("sharing violation"), { code: "EBUSY" }),
    );
    const result = await fixture.value.rotate(request());
    expect(result.phase).toBe("CLEANUP_PENDING");
    expect(await readFile(path.join(root, "token"), "utf8")).toContain("new-token");
    expect(fixture.database.securityEpoch).toBe(1);
  });

  it("rejects DB epoch ahead of the external security journal", async () => {
    const root = temporaryRoot();
    await seedCanonical(root);
    const database = new FakeDatabase();
    database.securityEpoch = 1;
    const { value } = coordinator(root, database);
    await expect(value.rotate(request())).rejects.toMatchObject({ code: "SECURITY_EPOCH_FORK" });
  });

  it("recovers a newer external epoch into an older restored DB", async () => {
    const root = temporaryRoot();
    await seedCanonical(root);
    const first = coordinator(root);
    await first.value.rotate(request());
    const restored = new FakeDatabase();
    const second = coordinator(root, restored);
    const result = await second.value.reconcile("scr_fixture");
    expect(result.phase).toBe("COMPLETED");
    expect(restored.calls).toContain("recoverExternal");
    expect(restored.securityEpoch).toBe(1);
  });

  it("fails closed on a hash-chain fork before DB or canonical mutation", async () => {
    const root = temporaryRoot();
    await seedCanonical(root);
    const fixture = coordinator(root);
    await fixture.value.rotate(request());
    const journalPath = path.join(root, "security", "credential-rotation-journal.jsonl");
    const journal = await readFile(journalPath, "utf8");
    await writeFile(journalPath, journal.replace('"securityEpoch":1', '"securityEpoch":9'));
    const before = fixture.database.calls.length;
    await expect(fixture.value.reconcile("scr_fixture")).rejects.toMatchObject({
      code: "EXTERNAL_JOURNAL_INVALID",
    });
    expect(fixture.database.calls).toHaveLength(before);
  });

  it("rejects non-private staged ACL evidence", async () => {
    const root = temporaryRoot();
    await seedCanonical(root);
    const { value } = coordinator(root, undefined, { verifyAcl: async () => false });
    await expect(value.rotate(request())).rejects.toMatchObject({ code: "FILE_NOT_OWNER_PRIVATE" });
  });

  it("rejects hardlinked canonical files", async () => {
    const root = temporaryRoot();
    await seedCanonical(root);
    await link(path.join(root, "token"), path.join(root, "token-link"));
    const { value } = coordinator(root);
    await expect(value.rotate(request())).rejects.toMatchObject({ code: "FILE_NOT_REGULAR" });
  });

  it("rejects reparse/symlink canonical files", async () => {
    const root = temporaryRoot();
    await seedCanonical(root);
    await rmSync(path.join(root, "token"), { force: true });
    const target = path.join(root, "real-token");
    await writeFile(target, `${token("old-token")}\n`);
    await symlink(target, path.join(root, "token"), "file");
    const { value } = coordinator(root);
    await expect(value.rotate(request())).rejects.toMatchObject({ code: "FILE_NOT_REGULAR" });
  });

  it("never truncates the canonical file on a sharing violation", async () => {
    const root = temporaryRoot();
    await seedCanonical(root);
    const fixture = coordinator(root);
    const original = fixture.value.files.renameNoReplace.bind(fixture.value.files);
    let attempts = 0;
    vi.spyOn(fixture.value.files, "renameNoReplace").mockImplementation(async (source, target) => {
      if (target.endsWith("scr_fixture.token.old") && attempts++ < 2) {
        throw Object.assign(new Error("sharing"), { code: "EBUSY" });
      }
      return original(source, target);
    });
    await fixture.value.rotate(request());
    expect(attempts).toBe(3);
    expect(await readFile(path.join(root, "token"), "utf8")).toContain("new-token");
  });

  it("validates every declared crash point by cold replay", async () => {
    expect(CREDENTIAL_ROTATION_CRASH_POINTS.length).toBeGreaterThanOrEqual(26);
    for (const crashPoint of CREDENTIAL_ROTATION_CRASH_POINTS) {
      const root = temporaryRoot();
      await seedCanonical(root);
      const database = new FakeDatabase();
      let armed = true;
      const fault = (point: string) => {
        if (armed && point === crashPoint) throw new Error(`crash:${point}`);
      };
      let operation: Promise<unknown>;
      if (crashPoint === "after-db-ABORTED" || crashPoint === "after-journal-ABORTED") {
        const staged = coordinator(root, database, {
          fault: (point) => {
            if (point === "after-journal-STAGED") throw new Error("staged-for-abort");
          },
        });
        await expect(staged.value.rotate(request())).rejects.toThrow("staged-for-abort");
        operation = coordinator(root, database, { fault }).value.reconcile("scr_fixture");
      } else {
        const first = coordinator(root, database, { fault });
        operation = first.value.rotate(request());
      }
      let crash: unknown = null;
      try {
        await operation;
      } catch (error) {
        crash = error;
      }
      expect(crash, `fault injector was not reached: ${crashPoint}`).toMatchObject({
        message: `crash:${crashPoint}`,
      });
      armed = false;
      const recovered = coordinator(root, database);
      const result = await recovered.value.reconcile("scr_fixture");
      expect(["ABORTED", "COMPLETED", "CLEANUP_PENDING"]).toContain(result.phase);
      if (result.phase !== "ABORTED") {
        expect(database.securityEpoch).toBe(1);
        for (const { filename } of CREDENTIAL_ROTATION_SLOTS) {
          expect(await readFile(path.join(root, filename), "utf8")).toContain("new-");
        }
      }
    }
  }, 30_000);

  it("rejects unknown canonical content instead of guessing old or new", async () => {
    const root = temporaryRoot();
    await seedCanonical(root);
    let crash = true;
    const fixture = coordinator(root, undefined, {
      fault: (point) => {
        if (crash && point === "after-journal-STAGED") throw new Error("crash");
      },
    });
    await expect(fixture.value.rotate(request())).rejects.toThrow("crash");
    crash = false;
    await writeFile(path.join(root, "token"), `${token("unknown")}\n`);
    await expect(fixture.value.reconcile("scr_fixture")).rejects.toMatchObject({
      code: "CANONICAL_CREDENTIAL_UNKNOWN",
    });
  });

  it("uses strong unique generated tokens and rejects secret reuse", async () => {
    const root = temporaryRoot();
    await seedCanonical(root);
    const database = new FakeDatabase();
    const value = new CredentialRotationCoordinator({
      dataDir: root,
      database,
      environment: {},
      stopExactHub: async () => stopReceipt(),
      generateToken: () => token("same"),
      now: () => nextTimestamp,
      verifyOwnerPrivateAcl: async () => true,
    });
    await expect(value.rotate(request())).rejects.toMatchObject({
      code: "TOKEN_GENERATION_INVALID",
    });
  });

  it("keeps journal and credential paths on the configured data root only", async () => {
    const root = temporaryRoot();
    await seedCanonical(root);
    const { value } = coordinator(root);
    await value.rotate(request());
    const entries = await Promise.all(
      CREDENTIAL_ROTATION_SLOTS.map(({ filename }) => stat(path.join(root, filename))),
    );
    expect(entries.every((entry) => entry.isFile() && entry.nlink === 1)).toBe(true);
    expect(value.files.journalPath).toBe(
      path.join(root, "security", "credential-rotation-journal.jsonl"),
    );
  });
});
