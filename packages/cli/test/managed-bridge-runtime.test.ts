import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ManagedBridgeReleaseEffectReceipt } from "../src/atomic-release-manager.js";
import {
  managedBridgeActiveSubjectKey,
  type ManagedBridgeIpcSubject,
} from "../src/managed-bridge-ipc.js";
import {
  ManagedBridgeRuntimeCoordinator,
  ManagedBridgeRuntimeError,
  type ManagedBridgeRuntimeAdapter,
  type ManagedBridgeRuntimeCommand,
  type ManagedBridgeRuntimeCommandJournal,
  type ManagedBridgeRuntimeCommandStore,
  type ManagedBridgeRuntimeDesiredRecord,
  type ManagedBridgeRuntimeEffectReceipt,
  type ManagedBridgeRuntimeLease,
  type ManagedBridgeRuntimeSidecar,
  type ManagedBridgeRuntimeWorkerProof,
} from "../src/managed-bridge-runtime.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const SHA_D = "d".repeat(64);
const SHA_E = "e".repeat(64);
const WORKER_KEYS = generateKeyPairSync("ed25519");
const IMPOSTOR_KEYS = generateKeyPairSync("ed25519");
const WORKER_PUBLIC_DER = WORKER_KEYS.publicKey.export({ format: "der", type: "spki" });
const WORKER_PUBLIC_BASE64 = WORKER_PUBLIC_DER.toString("base64");
const WORKER_PUBLIC_SHA256 = createHash("sha256").update(WORKER_PUBLIC_DER).digest("hex");

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
    .join(",")}}`;
}

function testDigest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function releaseAuthorization(input: {
  operationId: string;
  authorizedOutcome: "DEPLOYED" | "ROLLED_BACK";
  source: ManagedBridgeIpcSubject;
  candidate: ManagedBridgeIpcSubject;
  installed: ManagedBridgeIpcSubject;
  paused: ManagedBridgeIpcSubject;
  previousDesiredState: "RUNNING" | "STOPPED";
  subjectRevision: number;
  supervisorJournalRevision: number;
  subjectIndex?: number;
}) {
  const subjectProof = { ...input.paused, subjectRevision: input.subjectRevision };
  const pausedSubject = {
    previousDesiredState: input.previousDesiredState,
    subjectProof,
    subjectProofSha256: testDigest({
      previousDesiredState: input.previousDesiredState,
      subjectProof,
    }),
  };
  const unsigned = {
    schemaVersion: 1 as const,
    authorizationId: `authorization:${input.operationId}`,
    operationId: input.operationId,
    requestFingerprint: SHA_A,
    authorizedOutcome: input.authorizedOutcome,
    atomicJournalRevision: 31,
    pointerRevision: 9,
    supervisorJournalRevision: input.supervisorJournalRevision,
    pauseReceiptId: `pause_${input.operationId}`,
    sourceIdentity: input.source.build,
    candidateIdentity: input.candidate.build,
    installedIdentity: input.installed.build,
    pauseReceiptSha256: SHA_B,
    issuedAt: "2026-08-01T12:00:00.000Z",
  };
  return {
    subjectIndex: input.subjectIndex ?? 0,
    transitionAuthorization: {
      ...unsigned,
      authorizationSha256: testDigest(unsigned),
    },
    pausedSubject,
  };
}

function subject(overrides: Partial<ManagedBridgeIpcSubject> = {}): ManagedBridgeIpcSubject {
  return {
    schemaVersion: 1,
    projectId: "prj_runtime",
    originalThreadId: "019fa8ef-3525-7a31-9e9b-2da6e38253f8",
    agentId: "codex",
    runId: "run_original",
    sessionId: "ses_original",
    lineageId: "lin_original",
    incarnation: 1,
    bundleId: "bnd_original",
    build: {
      buildId: SHA_A,
      buildSessionId: "123e4567-e89b-42d3-a456-426614174000",
      protocolId: SHA_B,
      manifestSha256: SHA_A,
      migrationId: SHA_C,
    },
    vaultSha256: SHA_B,
    checkpointSha256: SHA_C,
    checkpointEventSequence: 41,
    fuseGeneration: 7,
    ...overrides,
  };
}

function desired(
  active = subject(),
  overrides: Partial<ManagedBridgeRuntimeDesiredRecord> = {},
): ManagedBridgeRuntimeDesiredRecord {
  return {
    schemaVersion: 1,
    revision: 12,
    desiredState: "RUNNING",
    subject: active,
    stopReceipt: null,
    ...overrides,
  };
}

function sidecar(
  active = subject(),
  overrides: Partial<ManagedBridgeRuntimeSidecar> = {},
): ManagedBridgeRuntimeSidecar {
  return {
    schemaVersion: 1,
    kind: "BRIDGE_WORKER_PROOF_SIDECAR",
    sidecarId: "worker_original",
    revision: 8,
    state: "RUNNING",
    subject: active,
    pid: 44_210,
    workerPipePath: "\\\\.\\pipe\\crossagent-worker-proof-test",
    workerPublicKeySpkiDerBase64: WORKER_PUBLIC_BASE64,
    workerPublicKeySha256: WORKER_PUBLIC_SHA256,
    stateUpdatedAt: "2026-08-01T12:00:00.000Z",
    ...overrides,
  };
}

function signedWorkerProof(
  input: { challengeId: string; sidecar: ManagedBridgeRuntimeSidecar },
  options: {
    privateKey?: typeof WORKER_KEYS.privateKey;
    signedOverrides?: Partial<Omit<ManagedBridgeRuntimeWorkerProof, "signatureBase64">>;
    afterSignOverrides?: Partial<ManagedBridgeRuntimeWorkerProof>;
    healthUpdatedAt?: string;
  } = {},
): ManagedBridgeRuntimeWorkerProof {
  const signed = {
    schemaVersion: 1 as const,
    kind: "BRIDGE_WORKER_CHALLENGE_OK" as const,
    challengeId: input.challengeId,
    sidecarId: input.sidecar.sidecarId,
    sidecarRevision: input.sidecar.revision,
    subject: input.sidecar.subject,
    pid: input.sidecar.pid!,
    healthUpdatedAt: options.healthUpdatedAt ?? "2026-08-01T12:00:00.000Z",
    ...options.signedOverrides,
  };
  const signatureBase64 = sign(
    null,
    Buffer.from(canonical(signed), "utf8"),
    options.privateKey ?? WORKER_KEYS.privateKey,
  ).toString("base64");
  return { ...signed, signatureBase64, ...options.afterSignOverrides };
}

class Lease implements ManagedBridgeRuntimeLease {
  active = true;
  readonly leaseId: string;
  readonly generation: number;

  constructor(name: string, generation = 1) {
    this.leaseId = `lease_${name}`;
    this.generation = generation;
  }

  assertActive(): void {
    if (!this.active) throw new Error("lease inactive");
  }
}

class MemoryStore implements ManagedBridgeRuntimeCommandStore {
  readonly rows = new Map<string, ManagedBridgeRuntimeCommandJournal>();
  failNextCas = false;
  failNextCompletionCas = false;
  afterClaim: (() => void) | null = null;
  afterLoad: ((loadCount: number) => void) | null = null;
  loadCount = 0;

  async load(commandId: string): Promise<ManagedBridgeRuntimeCommandJournal | null> {
    this.loadCount += 1;
    const result = structuredClone(this.rows.get(commandId) ?? null);
    this.afterLoad?.(this.loadCount);
    return result;
  }

  async listClaimed(): Promise<ManagedBridgeRuntimeCommandJournal[]> {
    return [...this.rows.values()]
      .filter((row) => row.state === "CLAIMED")
      .map((row) => structuredClone(row));
  }

  async compareAndSwap(
    commandId: string,
    expectedRevision: number | null,
    next: ManagedBridgeRuntimeCommandJournal,
    lease: ManagedBridgeRuntimeLease,
  ): Promise<boolean> {
    lease.assertActive();
    if (this.failNextCas) {
      this.failNextCas = false;
      return false;
    }
    if (next.state === "COMPLETED" && this.failNextCompletionCas) {
      this.failNextCompletionCas = false;
      return false;
    }
    const current = this.rows.get(commandId);
    if ((current?.revision ?? null) !== expectedRevision) return false;
    this.rows.set(commandId, structuredClone(next));
    if (expectedRevision === null) this.afterClaim?.();
    return true;
  }
}

class FakeAdapter implements ManagedBridgeRuntimeAdapter {
  desired: unknown[] = [];
  sidecars = new Map<string, unknown[]>();
  readonly commands: ManagedBridgeRuntimeCommand[] = [];
  readonly effectReceipts = new Map<string, ManagedBridgeRuntimeEffectReceipt>();
  challengeCalls = 0;
  effectCalls = 0;
  appliedEffects = 0;
  failResponseOnce = false;
  transitionSidecarOnApply = false;
  afterChallenge: (() => void) | null = null;
  releaseAuthorization: unknown = null;
  releaseEffectTamper: Partial<ManagedBridgeReleaseEffectReceipt> | null = null;
  readonly challengeIds: string[] = [];
  workerHealthUpdatedAt = "2026-08-01T12:00:00.000Z";

  async enumerateDesired(): Promise<unknown[]> {
    return structuredClone(this.desired);
  }

  async enumerateSidecars(subjectKey: string): Promise<unknown[]> {
    return structuredClone(this.sidecars.get(subjectKey) ?? []);
  }

  async challengeWorker(input: {
    challengeId: string;
    sidecar: ManagedBridgeRuntimeSidecar;
  }): Promise<unknown> {
    this.challengeCalls += 1;
    this.challengeIds.push(input.challengeId);
    const proof = signedWorkerProof(input, { healthUpdatedAt: this.workerHealthUpdatedAt });
    this.afterChallenge?.();
    return proof;
  }

  async readReleaseAuthorization(_input: {
    operationId: string;
    subjectKey: string;
  }): Promise<unknown> {
    return structuredClone(this.releaseAuthorization);
  }

  async dispatch(command: ManagedBridgeRuntimeCommand): Promise<unknown> {
    this.effectCalls += 1;
    this.commands.push(structuredClone(command));
    const firstApplication = !this.commands
      .slice(0, -1)
      .some((candidate) => candidate.commandId === command.commandId);
    const existingReceipt = this.effectReceipts.get(command.commandId);
    if (existingReceipt) return structuredClone(existingReceipt);
    if (firstApplication) this.appliedEffects += 1;
    if (firstApplication && this.transitionSidecarOnApply) {
      const key = managedBridgeActiveSubjectKey(command.subject);
      if (command.kind === "START_EXACT") {
        this.sidecars.set(key, [
          sidecar(command.subject, {
            sidecarId: command.recoverySidecar.sidecarId,
            revision: command.recoverySidecar.revision + 1,
            state: "RUNNING",
          }),
        ]);
      } else if (command.kind === "STOP_EXACT") {
        this.sidecars.set(
          key,
          command.workerSidecar
            ? [
                sidecar(command.subject, {
                  sidecarId: command.workerSidecar.sidecarId,
                  revision: command.workerSidecar.revision + 1,
                  state: "STOPPED",
                }),
              ]
            : [],
        );
      }
    }
    const common = {
      schemaVersion: 1 as const,
      commandId: command.commandId,
      requestHash: command.requestHash,
      subject: command.subject,
      subjectKey: managedBridgeActiveSubjectKey(command.subject),
      recordRevision: command.desiredRevision + 1,
      eventSequence: command.subject.checkpointEventSequence,
      leaseFence: command.leaseFence,
    };
    let receipt: ManagedBridgeRuntimeEffectReceipt;
    if (command.kind === "START_EXACT") {
      receipt = { ...common, kind: "STARTED" };
    } else if (command.kind === "STOP_EXACT") {
      receipt = {
        ...common,
        kind: "STOPPED",
        effect: command.workerSidecar?.state === "RUNNING" ? "STOPPED" : "ALREADY_STOPPED",
      };
    } else {
      const release = command.releaseAuthorization;
      const effect: ManagedBridgeReleaseEffectReceipt["effect"] =
        release.pausedSubject.previousDesiredState === "STOPPED"
          ? "ALREADY_STOPPED"
          : command.kind === "RELEASE_REBIND_EXACT"
            ? "REBOUND"
            : "ROLLED_BACK";
      const unsignedEffect = {
        schemaVersion: 1 as const,
        effectReceiptId: `effect:${command.commandId.slice(0, 48)}`,
        authorizationId: release.transitionAuthorization.authorizationId,
        authorizationSha256: release.transitionAuthorization.authorizationSha256,
        operationId: command.operationId,
        effect,
        supervisorJournalRevision:
          release.transitionAuthorization.supervisorJournalRevision + release.subjectIndex + 1,
        previousDesiredState: release.pausedSubject.previousDesiredState,
        subjectProof: release.pausedSubject.subjectProof,
        sealedSubjectProofSha256: release.pausedSubject.subjectProofSha256,
        installedIdentity: release.transitionAuthorization.installedIdentity,
        effectedAt: "2026-08-01T12:00:02.000Z",
      };
      const releaseEffect: ManagedBridgeReleaseEffectReceipt = {
        ...unsignedEffect,
        effectReceiptSha256: testDigest(unsignedEffect),
      };
      const returnedEffect = this.releaseEffectTamper
        ? ({ ...releaseEffect, ...this.releaseEffectTamper } as ManagedBridgeReleaseEffectReceipt)
        : releaseEffect;
      receipt = {
        ...common,
        kind: effect,
        previousSubject: command.previousSubject,
        releaseEffect: returnedEffect,
      };
    }
    this.effectReceipts.set(command.commandId, structuredClone(receipt));
    if (this.failResponseOnce) {
      this.failResponseOnce = false;
      throw new Error("response lost after receiver applied command");
    }
    return receipt;
  }
}

function coordinator(input: {
  adapter: FakeAdapter;
  store?: MemoryStore;
  controlLease?: Lease;
  journalLease?: Lease;
  now?: () => number;
  startingGraceMs?: number;
  createChallengeId?: () => string;
}): ManagedBridgeRuntimeCoordinator {
  return new ManagedBridgeRuntimeCoordinator({
    adapter: input.adapter,
    store: input.store ?? new MemoryStore(),
    controlLease: input.controlLease ?? new Lease("control"),
    journalLease: input.journalLease ?? new Lease("journal"),
    now: input.now ?? (() => Date.parse("2026-08-01T12:00:01.000Z")),
    healthFreshnessMs: 15_000,
    startingGraceMs: input.startingGraceMs,
    createChallengeId: input.createChallengeId,
  });
}

describe("ManagedBridgeRuntimeCoordinator", () => {
  it("starts only the exact desired project/run/original thread and recovery bundle", async () => {
    const adapter = new FakeAdapter();
    const active = subject();
    const key = managedBridgeActiveSubjectKey(active);
    adapter.desired = [desired(active)];
    adapter.sidecars.set(key, [sidecar(active, { state: "EXITED" })]);

    const [outcome] = await coordinator({ adapter }).reconcileAll();

    expect(outcome).toMatchObject({ status: "STARTED", subject: active });
    expect(adapter.commands).toHaveLength(1);
    expect(adapter.commands[0]).toMatchObject({ kind: "START_EXACT", subject: active });
  });

  it("replays one stable command after a lost response without applying twice", async () => {
    const adapter = new FakeAdapter();
    const store = new MemoryStore();
    const active = subject();
    adapter.desired = [desired(active)];
    adapter.sidecars.set(managedBridgeActiveSubjectKey(active), [
      sidecar(active, { state: "EXITED" }),
    ]);
    adapter.failResponseOnce = true;
    adapter.transitionSidecarOnApply = true;
    const runtime = coordinator({ adapter, store });

    await expect(runtime.reconcileAll()).rejects.toMatchObject({
      code: "EFFECT_RESPONSE_UNKNOWN",
    });
    adapter.desired = [];
    const [recovered] = await runtime.reconcileAll();

    expect(recovered).toMatchObject({ status: "STARTED", disposition: "RECOVERED" });
    expect(adapter.effectCalls).toBe(2);
    expect(adapter.appliedEffects).toBe(1);
    expect(new Set(adapter.commands.map((command) => command.commandId)).size).toBe(1);
  });

  it("reseals a CLAIMED logical command under successor leases before a first effect", async () => {
    const adapter = new FakeAdapter();
    const store = new MemoryStore();
    const active = subject();
    const oldControl = new Lease("control-old", 1);
    const oldJournal = new Lease("journal-old", 1);
    adapter.desired = [desired(active)];
    adapter.sidecars.set(managedBridgeActiveSubjectKey(active), [
      sidecar(active, { state: "EXITED" }),
    ]);
    store.afterClaim = () => {
      store.afterClaim = null;
      oldControl.active = false;
    };

    await expect(
      coordinator({
        adapter,
        store,
        controlLease: oldControl,
        journalLease: oldJournal,
      }).reconcileAll(),
    ).rejects.toThrow("lease inactive");
    expect(adapter.effectCalls).toBe(0);

    const newControl = new Lease("control-new", 2);
    const newJournal = new Lease("journal-new", 2);
    const [recovered] = await coordinator({
      adapter,
      store,
      controlLease: newControl,
      journalLease: newJournal,
    }).reconcileAll();

    expect(recovered).toMatchObject({ status: "STARTED", disposition: "RECOVERED" });
    expect(adapter.effectCalls).toBe(1);
    expect(adapter.commands[0]?.leaseFence).toMatchObject({
      controlLeaseGeneration: 2,
      journalLeaseGeneration: 2,
    });
    const completed = [...store.rows.values()][0]!;
    expect(completed.attemptFences).toHaveLength(2);
    expect(new Set(completed.attemptFences.map((fence) => fence.controlLeaseGeneration))).toEqual(
      new Set([1, 2]),
    );
  });

  it("accepts a lost-response receipt bound to an older accepted fence after reseal", async () => {
    const adapter = new FakeAdapter();
    const store = new MemoryStore();
    const active = subject();
    const oldControl = new Lease("control-old", 1);
    const oldJournal = new Lease("journal-old", 1);
    adapter.desired = [desired(active)];
    adapter.sidecars.set(managedBridgeActiveSubjectKey(active), [
      sidecar(active, { state: "EXITED" }),
    ]);
    adapter.failResponseOnce = true;

    await expect(
      coordinator({
        adapter,
        store,
        controlLease: oldControl,
        journalLease: oldJournal,
      }).reconcileAll(),
    ).rejects.toMatchObject({ code: "EFFECT_RESPONSE_UNKNOWN" });
    oldControl.active = false;
    oldJournal.active = false;

    const [recovered] = await coordinator({
      adapter,
      store,
      controlLease: new Lease("control-new", 2),
      journalLease: new Lease("journal-new", 2),
    }).reconcileAll();

    expect(recovered).toMatchObject({ status: "STARTED", disposition: "RECOVERED" });
    expect(adapter.effectCalls).toBe(2);
    expect(adapter.appliedEffects).toBe(1);
    expect(adapter.effectReceipts.values().next().value?.leaseFence).toMatchObject({
      controlLeaseGeneration: 1,
      journalLeaseGeneration: 1,
    });
  });

  it("does not invent recovery identity when the non-secret sidecar is missing", async () => {
    const adapter = new FakeAdapter();
    adapter.desired = [desired()];

    const [outcome] = await coordinator({ adapter }).reconcileAll();

    expect(outcome).toMatchObject({
      status: "BLOCKED",
      reason: "MISSING_RECOVERY_SIDECAR",
    });
    expect(adapter.effectCalls).toBe(0);
  });

  it("rejects a self-hashed corrupt CLAIMED STOP before recovery dispatch", async () => {
    const adapter = new FakeAdapter();
    const store = new MemoryStore();
    const active = subject();
    const input = {
      schemaVersion: 1 as const,
      kind: "STOP_EXACT" as const,
      subject: active,
      desiredRevision: 18,
      persistedStopReceipt: {
        kind: "DESIRED_STOP_PERSISTED" as const,
        receiptId: "stop_corrupt_claim",
        desiredRevision: 999,
        subjectKey: managedBridgeActiveSubjectKey(active),
      },
      workerSidecar: sidecar(active),
      leaseFence: {
        schemaVersion: 1 as const,
        controlLeaseId: "lease_control",
        controlLeaseGeneration: 1,
        journalLeaseId: "lease_journal",
        journalLeaseGeneration: 1,
      },
    };
    const { leaseFence: _leaseFence, ...logicalInput } = input;
    const commandId = testDigest({
      namespace: "managed-bridge-runtime-command-v1",
      input: logicalInput,
    });
    const requestHash = testDigest({ commandId, input: logicalInput });
    store.rows.set(commandId, {
      schemaVersion: 1,
      revision: 0,
      commandId,
      requestHash,
      state: "CLAIMED",
      command: { ...input, commandId, requestHash },
      attemptFences: [input.leaseFence],
      receipt: null,
    } as ManagedBridgeRuntimeCommandJournal);

    await expect(coordinator({ adapter, store }).reconcileAll()).rejects.toBeInstanceOf(
      ManagedBridgeRuntimeError,
    );
    expect(adapter.effectCalls).toBe(0);
  });

  it("treats an exact STARTING sidecar as transient and does not spawn", async () => {
    const adapter = new FakeAdapter();
    const active = subject();
    const key = managedBridgeActiveSubjectKey(active);
    adapter.desired = [desired(active)];
    adapter.sidecars.set(key, [sidecar(active, { state: "STARTING", pid: null })]);

    const [outcome] = await coordinator({ adapter }).reconcileAll();

    expect(outcome).toMatchObject({ status: "STARTING_TRANSIENT" });
    expect(adapter.effectCalls).toBe(0);
    expect(adapter.challengeCalls).toBe(0);
  });

  it("does not treat a PID as alive when an impostor signs the worker challenge", async () => {
    const adapter = new FakeAdapter();
    const active = subject();
    const key = managedBridgeActiveSubjectKey(active);
    adapter.desired = [desired(active)];
    adapter.sidecars.set(key, [sidecar(active)]);
    adapter.challengeWorker = async (input) =>
      signedWorkerProof(input, { privateKey: IMPOSTOR_KEYS.privateKey });

    const [outcome] = await coordinator({ adapter }).reconcileAll();

    expect(outcome).toMatchObject({ status: "BLOCKED", reason: "WORKER_PROOF_MISMATCH" });
    expect(adapter.effectCalls).toBe(0);
  });

  it("rejects a replayed signed proof under the next random challenge", async () => {
    const adapter = new FakeAdapter();
    const active = subject();
    const key = managedBridgeActiveSubjectKey(active);
    adapter.desired = [desired(active)];
    adapter.sidecars.set(key, [sidecar(active)]);
    let replay: ManagedBridgeRuntimeWorkerProof | null = null;
    adapter.challengeWorker = async (input) => {
      replay ??= signedWorkerProof(input);
      return structuredClone(replay);
    };

    const first = await coordinator({ adapter, createChallengeId: () => SHA_D }).reconcileAll();
    const second = await coordinator({ adapter, createChallengeId: () => SHA_E }).reconcileAll();

    expect(first[0]).toMatchObject({ status: "HEALTHY" });
    expect(second[0]).toMatchObject({ status: "BLOCKED", reason: "WORKER_PROOF_MISMATCH" });
    expect(adapter.effectCalls).toBe(0);
  });

  it("rejects a signature bit flip", async () => {
    const adapter = new FakeAdapter();
    const active = subject();
    const key = managedBridgeActiveSubjectKey(active);
    adapter.desired = [desired(active)];
    adapter.sidecars.set(key, [sidecar(active)]);
    adapter.challengeWorker = async (input) => {
      const proof = signedWorkerProof(input);
      const signature = Buffer.from(proof.signatureBase64, "base64");
      signature[0] = signature[0]! ^ 1;
      return { ...proof, signatureBase64: signature.toString("base64") };
    };

    const [result] = await coordinator({ adapter }).reconcileAll();

    expect(result).toMatchObject({ status: "BLOCKED", reason: "WORKER_PROOF_MISMATCH" });
    expect(adapter.effectCalls).toBe(0);
  });

  it("rejects signed worker fields changed after signing", async () => {
    const adapter = new FakeAdapter();
    const active = subject();
    const key = managedBridgeActiveSubjectKey(active);
    adapter.desired = [desired(active)];
    adapter.sidecars.set(key, [sidecar(active)]);
    adapter.challengeWorker = async (input) =>
      signedWorkerProof(input, {
        afterSignOverrides: { healthUpdatedAt: "2026-08-01T12:00:00.500Z" },
      });

    const [result] = await coordinator({ adapter }).reconcileAll();

    expect(result).toMatchObject({ status: "BLOCKED", reason: "WORKER_PROOF_MISMATCH" });
    expect(adapter.effectCalls).toBe(0);
  });

  it("re-reads the sidecar revision after challenge and blocks an ABA replacement", async () => {
    const adapter = new FakeAdapter();
    const active = subject();
    const key = managedBridgeActiveSubjectKey(active);
    adapter.desired = [desired(active)];
    adapter.sidecars.set(key, [sidecar(active)]);
    adapter.afterChallenge = () => {
      adapter.sidecars.set(key, [sidecar(active, { revision: 10 })]);
    };

    const [outcome] = await coordinator({ adapter }).reconcileAll();

    expect(outcome).toMatchObject({ status: "BLOCKED", reason: "SIDECAR_CHANGED_DURING_PROBE" });
    expect(adapter.effectCalls).toBe(0);
  });

  it("accepts only a fresh exact build and worker-pipe challenge", async () => {
    const adapter = new FakeAdapter();
    const active = subject();
    const key = managedBridgeActiveSubjectKey(active);
    adapter.desired = [desired(active)];
    adapter.sidecars.set(key, [sidecar(active)]);

    const [outcome] = await coordinator({ adapter }).reconcileAll();

    expect(outcome).toMatchObject({ status: "HEALTHY", subject: active });
    expect(adapter.challengeCalls).toBe(1);
    expect(adapter.effectCalls).toBe(0);
  });

  it("uses a fresh anti-replay challenge for repeated probes of the same sidecar", async () => {
    const adapter = new FakeAdapter();
    const active = subject();
    const key = managedBridgeActiveSubjectKey(active);
    adapter.desired = [desired(active)];
    adapter.sidecars.set(key, [sidecar(active)]);
    let now = Date.parse("2026-08-01T12:00:01.000Z");
    const ids = [SHA_D, SHA_E];
    const runtime = coordinator({
      adapter,
      now: () => now,
      createChallengeId: () => ids.shift()!,
    });

    await expect(runtime.reconcileAll()).resolves.toEqual([
      expect.objectContaining({ status: "HEALTHY" }),
    ]);
    now += 20_000;
    adapter.workerHealthUpdatedAt = new Date(now).toISOString();
    await expect(runtime.reconcileAll()).resolves.toEqual([
      expect.objectContaining({ status: "HEALTHY" }),
    ]);

    expect(adapter.challengeIds).toEqual([SHA_D, SHA_E]);
  });

  it("fails closed with zero spawn when two RUNNING sidecars claim one subject", async () => {
    const adapter = new FakeAdapter();
    const active = subject();
    const key = managedBridgeActiveSubjectKey(active);
    adapter.desired = [desired(active)];
    adapter.sidecars.set(key, [sidecar(active), sidecar(active, { sidecarId: "worker_second" })]);

    const [outcome] = await coordinator({ adapter }).reconcileAll();

    expect(outcome).toMatchObject({ status: "BLOCKED", reason: "MULTIPLE_RUNNING_SIDECARS" });
    expect(adapter.challengeCalls).toBe(0);
    expect(adapter.effectCalls).toBe(0);
  });

  it("fails closed with zero spawn when two desired RUNNING records share a project/thread", async () => {
    const adapter = new FakeAdapter();
    adapter.desired = [desired(), desired(subject({ runId: "run_conflict" }), { revision: 13 })];

    await expect(coordinator({ adapter }).reconcileAll()).rejects.toMatchObject({
      code: "MULTIPLE_DESIRED_RUNNING",
    });
    expect(adapter.effectCalls).toBe(0);
  });

  it("requires a persisted exact STOP receipt and journal claim before cooperative stop", async () => {
    const adapter = new FakeAdapter();
    const store = new MemoryStore();
    const active = subject();
    const key = managedBridgeActiveSubjectKey(active);
    adapter.desired = [
      desired(active, {
        revision: 14,
        desiredState: "STOPPED",
        stopReceipt: {
          kind: "DESIRED_STOP_PERSISTED",
          receiptId: "stop_receipt_14",
          desiredRevision: 14,
          subjectKey: key,
        },
      }),
    ];
    adapter.sidecars.set(key, [sidecar(active)]);
    store.failNextCas = true;

    await expect(coordinator({ adapter, store }).reconcileAll()).rejects.toMatchObject({
      code: "JOURNAL_CLAIM_CONFLICT",
    });
    expect(adapter.effectCalls).toBe(0);

    const [outcome] = await coordinator({ adapter, store }).reconcileAll();
    expect(outcome).toMatchObject({ status: "STOPPED" });
    expect(adapter.commands[0]).toMatchObject({
      kind: "STOP_EXACT",
      persistedStopReceipt: { receiptId: "stop_receipt_14" },
    });
  });

  it("executes one authorized exact STOP CAS when the worker is already terminal", async () => {
    const adapter = new FakeAdapter();
    const active = subject();
    const key = managedBridgeActiveSubjectKey(active);
    adapter.desired = [
      desired(active, {
        revision: 15,
        desiredState: "STOPPED",
        stopReceipt: {
          kind: "DESIRED_STOP_PERSISTED",
          receiptId: "stop_receipt_terminal",
          desiredRevision: 15,
          subjectKey: key,
        },
      }),
    ];
    adapter.sidecars.set(key, [sidecar(active, { state: "STOPPED", pid: null })]);

    const store = new MemoryStore();
    const [outcome] = await coordinator({ adapter, store }).reconcileAll();
    const [replayed] = await coordinator({ adapter, store }).reconcileAll();

    expect(outcome).toMatchObject({ status: "ALREADY_STOPPED", disposition: "APPLIED" });
    expect(replayed).toMatchObject({ status: "ALREADY_STOPPED", disposition: "REPLAYED" });
    expect(adapter.effectCalls).toBe(1);
    expect(adapter.appliedEffects).toBe(1);
    expect(adapter.effectReceipts.values().next().value).toMatchObject({
      kind: "STOPPED",
      effect: "ALREADY_STOPPED",
    });
  });

  it("does not stop a STARTING worker until it can accept the cooperative command", async () => {
    const adapter = new FakeAdapter();
    const active = subject();
    const key = managedBridgeActiveSubjectKey(active);
    adapter.desired = [
      desired(active, {
        desiredState: "STOPPED",
        stopReceipt: {
          kind: "DESIRED_STOP_PERSISTED",
          receiptId: "stop_receipt_starting",
          desiredRevision: 12,
          subjectKey: key,
        },
      }),
    ];
    adapter.sidecars.set(key, [sidecar(active, { state: "STARTING", pid: null })]);

    const [outcome] = await coordinator({ adapter }).reconcileAll();

    expect(outcome!.status).toBe("STARTING_TRANSIENT");
    expect(adapter.effectCalls).toBe(0);
  });

  it("turns an abandoned STARTING record into a typed block after the grace window", async () => {
    const adapter = new FakeAdapter();
    const active = subject();
    const key = managedBridgeActiveSubjectKey(active);
    adapter.desired = [desired(active)];
    adapter.sidecars.set(key, [sidecar(active, { state: "STARTING", pid: null })]);

    const [outcome] = await coordinator({
      adapter,
      now: () => Date.parse("2026-08-01T12:01:00.000Z"),
      startingGraceMs: 30_000,
    }).reconcileAll();

    expect(outcome).toMatchObject({ status: "BLOCKED", reason: "STALE_STARTING_SIDECAR" });
    expect(adapter.effectCalls).toBe(0);
  });

  it("does not stop when desired state changes after claim but before the worker effect", async () => {
    const adapter = new FakeAdapter();
    const store = new MemoryStore();
    const active = subject();
    const key = managedBridgeActiveSubjectKey(active);
    const stopped = desired(active, {
      revision: 18,
      desiredState: "STOPPED",
      stopReceipt: {
        kind: "DESIRED_STOP_PERSISTED",
        receiptId: "stop_receipt_race",
        desiredRevision: 18,
        subjectKey: key,
      },
    });
    adapter.desired = [stopped];
    adapter.sidecars.set(key, [sidecar(active)]);
    store.afterClaim = () => {
      adapter.desired = [desired(active, { revision: 19 })];
    };

    await expect(coordinator({ adapter, store }).reconcileAll()).rejects.toMatchObject({
      code: "EFFECT_PRECONDITION_CHANGED",
    });
    expect(adapter.effectCalls).toBe(0);
  });

  it("rejects a different recovery bundle instead of relaunching a replacement run", async () => {
    const adapter = new FakeAdapter();
    const active = subject();
    const key = managedBridgeActiveSubjectKey(active);
    adapter.desired = [desired(active)];
    adapter.sidecars.set(key, [sidecar(subject({ bundleId: "bnd_other" }))]);

    const [outcome] = await coordinator({ adapter }).reconcileAll();

    expect(outcome).toMatchObject({ status: "BLOCKED", reason: "SIDECAR_SUBJECT_MISMATCH" });
    expect(adapter.effectCalls).toBe(0);
  });

  it("requires an exact typed receipt for release rebind and rollback", async () => {
    const adapter = new FakeAdapter();
    const runtime = coordinator({ adapter });
    const previous = subject();
    const rebound = subject({
      build: {
        buildId: SHA_D,
        buildSessionId: "223e4567-e89b-42d3-a456-426614174001",
        protocolId: SHA_B,
        manifestSha256: SHA_D,
        migrationId: SHA_E,
      },
    });
    adapter.releaseAuthorization = releaseAuthorization({
      operationId: "rel_release_operation_1",
      authorizedOutcome: "DEPLOYED",
      source: previous,
      candidate: rebound,
      installed: rebound,
      paused: previous,
      previousDesiredState: "RUNNING",
      subjectRevision: 15,
      supervisorJournalRevision: 22,
    });

    const rebind = await runtime.transitionRelease({
      operationId: "rel_release_operation_1",
      kind: "REBIND",
      desiredRevision: 15,
      previousSubject: previous,
      nextSubject: rebound,
    });
    adapter.releaseAuthorization = releaseAuthorization({
      operationId: "rel_release_operation_2",
      authorizedOutcome: "ROLLED_BACK",
      source: previous,
      candidate: rebound,
      installed: previous,
      paused: previous,
      previousDesiredState: "RUNNING",
      subjectRevision: 16,
      supervisorJournalRevision: 25,
    });
    const rollback = await runtime.transitionRelease({
      operationId: "rel_release_operation_2",
      kind: "ROLLBACK",
      desiredRevision: 16,
      previousSubject: rebound,
      nextSubject: previous,
    });

    expect(rebind).toMatchObject({ status: "REBOUND", subject: rebound });
    expect(rollback).toMatchObject({ status: "ROLLED_BACK", subject: previous });
    const canonicalRebindReceipt: ManagedBridgeReleaseEffectReceipt = rebind.releaseReceipt!;
    expect(canonicalRebindReceipt.operationId).toBe("rel_release_operation_1");
    expect(rebind.releaseReceipt).toMatchObject({ effect: "REBOUND" });
    expect(rollback.releaseReceipt).toMatchObject({ effect: "ROLLED_BACK" });
    expect(adapter.commands.map((command) => command.kind)).toEqual([
      "RELEASE_REBIND_EXACT",
      "RELEASE_ROLLBACK_EXACT",
    ]);
  });

  it("rejects the legacy future-terminal proof before any release effect", async () => {
    const adapter = new FakeAdapter();
    const previous = subject();
    const rebound = subject({
      build: {
        buildId: SHA_D,
        buildSessionId: "223e4567-e89b-42d3-a456-426614174001",
        protocolId: SHA_B,
        manifestSha256: SHA_D,
        migrationId: SHA_E,
      },
    });
    adapter.releaseAuthorization = {
      schemaVersion: 1,
      operationId: "rel_legacy_terminal",
      terminalPhase: "COMPLETED",
    };

    await expect(
      coordinator({ adapter }).transitionRelease({
        operationId: "rel_legacy_terminal",
        kind: "REBIND",
        desiredRevision: 15,
        previousSubject: previous,
        nextSubject: rebound,
      }),
    ).rejects.toMatchObject({ code: "RELEASE_SUBJECT_MISMATCH" });
    expect(adapter.effectCalls).toBe(0);
  });

  it("rejects a drifted durable authorization digest before any release effect", async () => {
    const adapter = new FakeAdapter();
    const previous = subject();
    const rebound = subject({
      build: {
        buildId: SHA_D,
        buildSessionId: "223e4567-e89b-42d3-a456-426614174001",
        protocolId: SHA_B,
        manifestSha256: SHA_D,
        migrationId: SHA_E,
      },
    });
    const authorization = releaseAuthorization({
      operationId: "rel_drifted_authorization",
      authorizedOutcome: "DEPLOYED",
      source: previous,
      candidate: rebound,
      installed: rebound,
      paused: previous,
      previousDesiredState: "RUNNING",
      subjectRevision: 15,
      supervisorJournalRevision: 22,
    });
    authorization.transitionAuthorization.authorizationSha256 = SHA_C;
    adapter.releaseAuthorization = authorization;

    await expect(
      coordinator({ adapter }).transitionRelease({
        operationId: "rel_drifted_authorization",
        kind: "REBIND",
        desiredRevision: 15,
        previousSubject: previous,
        nextSubject: rebound,
      }),
    ).rejects.toMatchObject({ code: "RELEASE_SUBJECT_MISMATCH" });
    expect(adapter.effectCalls).toBe(0);
  });

  it("rejects a drifted Supervisor effect receipt after exact CAS without inventing terminal proof", async () => {
    const adapter = new FakeAdapter();
    const store = new MemoryStore();
    const previous = subject();
    const rebound = subject({
      build: {
        buildId: SHA_D,
        buildSessionId: "223e4567-e89b-42d3-a456-426614174001",
        protocolId: SHA_B,
        manifestSha256: SHA_D,
        migrationId: SHA_E,
      },
    });
    adapter.releaseAuthorization = releaseAuthorization({
      operationId: "rel_drifted_effect",
      authorizedOutcome: "DEPLOYED",
      source: previous,
      candidate: rebound,
      installed: rebound,
      paused: previous,
      previousDesiredState: "RUNNING",
      subjectRevision: 15,
      supervisorJournalRevision: 22,
    });
    adapter.releaseEffectTamper = { effect: "ROLLED_BACK" };

    await expect(
      coordinator({ adapter, store }).transitionRelease({
        operationId: "rel_drifted_effect",
        kind: "REBIND",
        desiredRevision: 15,
        previousSubject: previous,
        nextSubject: rebound,
      }),
    ).rejects.toMatchObject({ code: "INVALID_EFFECT_RECEIPT" });
    expect(adapter.effectCalls).toBe(1);
    expect([...store.rows.values()]).toEqual([
      expect.objectContaining({ state: "CLAIMED", receipt: null }),
    ]);
  });

  it("rejects release transitions that change the project, run, thread, or recovery bundle", async () => {
    const adapter = new FakeAdapter();
    const runtime = coordinator({ adapter });
    const previous = subject();
    const next = subject({ runId: "run_new" });
    adapter.releaseAuthorization = releaseAuthorization({
      operationId: "rel_release_wrong_run",
      authorizedOutcome: "DEPLOYED",
      source: previous,
      candidate: next,
      installed: next,
      paused: previous,
      previousDesiredState: "RUNNING",
      subjectRevision: 15,
      supervisorJournalRevision: 22,
    });

    await expect(
      runtime.transitionRelease({
        operationId: "rel_release_wrong_run",
        kind: "REBIND",
        desiredRevision: 15,
        previousSubject: previous,
        nextSubject: next,
      }),
    ).rejects.toMatchObject({ code: "RELEASE_SUBJECT_MISMATCH" });
    expect(adapter.effectCalls).toBe(0);
  });

  it("does not accept caller release text without an independently read durable authorization", async () => {
    const adapter = new FakeAdapter();
    const previous = subject();
    const rebound = subject({
      build: {
        buildId: SHA_D,
        buildSessionId: "223e4567-e89b-42d3-a456-426614174001",
        protocolId: SHA_B,
        manifestSha256: SHA_D,
        migrationId: SHA_E,
      },
    });

    await expect(
      coordinator({ adapter }).transitionRelease({
        operationId: "rel_missing_receipt",
        kind: "REBIND",
        desiredRevision: 15,
        previousSubject: previous,
        nextSubject: rebound,
      }),
    ).rejects.toMatchObject({ code: "RELEASE_SUBJECT_MISMATCH" });
    expect(adapter.effectCalls).toBe(0);
  });

  it("keeps a user-stopped subject stopped across an otherwise valid release", async () => {
    const adapter = new FakeAdapter();
    const previous = subject();
    const rebound = subject({
      build: {
        buildId: SHA_D,
        buildSessionId: "223e4567-e89b-42d3-a456-426614174001",
        protocolId: SHA_B,
        manifestSha256: SHA_D,
        migrationId: SHA_E,
      },
    });
    adapter.releaseAuthorization = releaseAuthorization({
      operationId: "rel_user_stopped",
      authorizedOutcome: "DEPLOYED",
      source: previous,
      candidate: rebound,
      installed: rebound,
      paused: previous,
      previousDesiredState: "STOPPED",
      subjectRevision: 17,
      supervisorJournalRevision: 28,
    });

    const result = await coordinator({ adapter }).transitionRelease({
      operationId: "rel_user_stopped",
      kind: "REBIND",
      desiredRevision: 17,
      previousSubject: previous,
      nextSubject: rebound,
    });

    expect(result).toMatchObject({ status: "ALREADY_STOPPED", subject: rebound });
    expect(result.releaseReceipt).toMatchObject({ effect: "ALREADY_STOPPED" });
    expect(adapter.effectCalls).toBe(1);
    expect(adapter.commands[0]).toMatchObject({ kind: "RELEASE_REBIND_EXACT" });
  });

  it("uses both leases as hard effect fences", async () => {
    const adapter = new FakeAdapter();
    adapter.desired = [desired()];
    const controlLease = new Lease("control");
    const journalLease = new Lease("journal");
    controlLease.active = false;

    await expect(
      coordinator({ adapter, controlLease, journalLease }).reconcileAll(),
    ).rejects.toThrow("lease inactive");
    expect(adapter.effectCalls).toBe(0);
  });

  it("rejects zero-generation lease fences before journal claim or dispatch", async () => {
    const adapter = new FakeAdapter();
    const store = new MemoryStore();
    const active = subject();
    adapter.desired = [desired(active)];
    adapter.sidecars.set(managedBridgeActiveSubjectKey(active), [
      sidecar(active, { state: "EXITED" }),
    ]);

    await expect(
      coordinator({ adapter, store, controlLease: new Lease("control", 0) }).reconcileAll(),
    ).rejects.toBeInstanceOf(ManagedBridgeRuntimeError);
    expect(store.rows.size).toBe(0);
    expect(adapter.effectCalls).toBe(0);
  });

  it("does not downgrade a lease lost during a worker challenge to a health result", async () => {
    const adapter = new FakeAdapter();
    const active = subject();
    const key = managedBridgeActiveSubjectKey(active);
    const controlLease = new Lease("control");
    adapter.desired = [desired(active)];
    adapter.sidecars.set(key, [sidecar(active)]);
    adapter.afterChallenge = () => {
      controlLease.active = false;
    };

    await expect(coordinator({ adapter, controlLease }).reconcileAll()).rejects.toThrow(
      "lease inactive",
    );
    expect(adapter.effectCalls).toBe(0);
  });

  it("does not downgrade a thrown worker challenge after lease loss to BLOCKED", async () => {
    const adapter = new FakeAdapter();
    const active = subject();
    const key = managedBridgeActiveSubjectKey(active);
    const controlLease = new Lease("control");
    adapter.desired = [desired(active)];
    adapter.sidecars.set(key, [sidecar(active)]);
    adapter.challengeWorker = async () => {
      controlLease.active = false;
      throw new Error("pipe failed after replacement");
    };

    await expect(coordinator({ adapter, controlLease }).reconcileAll()).rejects.toThrow(
      "lease inactive",
    );
    expect(adapter.effectCalls).toBe(0);
  });

  it("does not downgrade a thrown dispatch after lease loss to response unknown", async () => {
    const adapter = new FakeAdapter();
    const store = new MemoryStore();
    const active = subject();
    const controlLease = new Lease("control");
    adapter.desired = [desired(active)];
    adapter.sidecars.set(managedBridgeActiveSubjectKey(active), [
      sidecar(active, { state: "EXITED" }),
    ]);
    adapter.dispatch = async () => {
      adapter.effectCalls += 1;
      controlLease.active = false;
      throw new Error("receiver unavailable after replacement");
    };

    await expect(coordinator({ adapter, store, controlLease }).reconcileAll()).rejects.toThrow(
      "lease inactive",
    );
    expect(adapter.effectCalls).toBe(1);
    expect(adapter.appliedEffects).toBe(0);
    expect([...store.rows.values()]).toEqual([
      expect.objectContaining({ state: "CLAIMED", receipt: null }),
    ]);
  });

  it("rejects a completion-CAS winner loaded after the coordinator loses its lease", async () => {
    const adapter = new FakeAdapter();
    const store = new MemoryStore();
    const active = subject();
    const controlLease = new Lease("control");
    adapter.desired = [desired(active)];
    adapter.sidecars.set(managedBridgeActiveSubjectKey(active), [
      sidecar(active, { state: "EXITED" }),
    ]);
    store.failNextCompletionCas = true;
    store.afterLoad = (loadCount) => {
      if (loadCount === 2) controlLease.active = false;
    };

    await expect(coordinator({ adapter, store, controlLease }).reconcileAll()).rejects.toThrow(
      "lease inactive",
    );
    expect(adapter.effectCalls).toBe(1);
    expect(adapter.appliedEffects).toBe(1);
    expect([...store.rows.values()]).toEqual([
      expect.objectContaining({ state: "CLAIMED", receipt: null }),
    ]);
  });

  it("rejects secret-shaped sidecar fields without persisting or echoing the canary", async () => {
    const adapter = new FakeAdapter();
    const store = new MemoryStore();
    const active = subject();
    const key = managedBridgeActiveSubjectKey(active);
    const canary = "bridge-secret-canary-never-store";
    adapter.desired = [desired(active)];
    adapter.sidecars.set(key, [{ ...sidecar(active), token: canary }]);

    let caught: unknown;
    try {
      await coordinator({ adapter, store }).reconcileAll();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ManagedBridgeRuntimeError);
    expect(String(caught)).not.toContain(canary);
    expect(store.rows.size).toBe(0);
    expect(adapter.effectCalls).toBe(0);
  });

  it("rejects deeply nested unknown payloads with a typed bound instead of stack overflow", async () => {
    const adapter = new FakeAdapter();
    let nested: Record<string, unknown> = {};
    for (let index = 0; index < 20_000; index += 1) nested = { next: nested };
    const raw = [{ ...desired(), extra: nested }];
    adapter.enumerateDesired = async () => raw;

    await expect(coordinator({ adapter }).reconcileAll()).rejects.toMatchObject({
      name: "ManagedBridgeRuntimeError",
      code: "PAYLOAD_BOUNDS_EXCEEDED",
    });
    expect(adapter.effectCalls).toBe(0);
  });

  it("rejects a mismatched public key fingerprint instead of persisting the canary", async () => {
    const adapter = new FakeAdapter();
    const store = new MemoryStore();
    const active = subject();
    const key = managedBridgeActiveSubjectKey(active);
    const canary = "public-key-fingerprint-canary-never-store";
    adapter.desired = [desired(active)];
    adapter.sidecars.set(key, [sidecar(active, { workerPublicKeySha256: canary })]);

    let caught: unknown;
    try {
      await coordinator({ adapter, store }).reconcileAll();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ManagedBridgeRuntimeError);
    expect(String(caught)).not.toContain(canary);
    expect(JSON.stringify([...store.rows.values()])).not.toContain(canary);
    expect(adapter.effectCalls).toBe(0);
  });

  it("has no production import of token readers, Hub clients, or vault plaintext", () => {
    const sourcePath = fileURLToPath(new URL("../src/managed-bridge-runtime.ts", import.meta.url));
    const source = readFileSync(sourcePath, "utf8");
    expect(source).not.toMatch(/from\s+["'][^"']*(?:local-auth|hub-client|client)[^"']*["']/i);
    expect(source).not.toMatch(/readFileSync|vaultPath|checkpointPath/);
    expect(source).not.toContain("ownerNonce");
    expect(source).not.toContain("ownerProofSha256");
  });
});
