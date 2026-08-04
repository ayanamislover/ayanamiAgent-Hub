import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  AtomicReleaseManager,
  type AtomicReleaseAdapters,
  type AtomicReleaseActiveLeaseClaim,
  type AtomicReleaseActiveLeaseRequest,
  type AtomicReleaseJournal,
  type AtomicReleaseJournalPhase,
  type AtomicReleaseJournalStore,
  type AtomicReleaseRequest,
  type AtomicReleaseTerminalLeaseProof,
  type BridgeResumeReceipt,
  type DeploymentObservation,
  type ManagedBridgeReleaseEffectReceipt,
  type ManagedBridgeSubjectProof,
  type PausedManagedBridgeSubject,
  type ReleaseIdentity,
} from "../src/atomic-release-manager.js";
import type {
  FinalRollbackSnapshotManifest,
  OnlinePreflightSnapshotManifest,
  QuiescenceProof,
} from "../src/release-snapshot.js";

const previousIdentity: ReleaseIdentity = {
  buildId: "1".repeat(64),
  buildSessionId: "11111111-1111-4111-8111-111111111111",
  protocolId: "2".repeat(64),
  manifestSha256: "c".repeat(64),
  migrationId: "3".repeat(64),
};

const candidateIdentity: ReleaseIdentity = {
  buildId: "4".repeat(64),
  buildSessionId: "22222222-2222-4222-8222-222222222222",
  protocolId: "5".repeat(64),
  manifestSha256: "d".repeat(64),
  migrationId: "6".repeat(64),
};

const request: AtomicReleaseRequest = {
  operationId: "rel_atomic_test",
  candidateId: "cand_atomic_test",
  expectedCurrent: previousIdentity,
  expectedCandidate: candidateIdentity,
};

const secretCanary = "hub-token-THIS-MUST-NEVER-ENTER-THE-JOURNAL";
const excludedFromRestore = [
  "VAULT",
  "CHECKPOINT",
  "SPOOL",
  "LOG",
  "ARTIFACT_PAYLOAD",
  "PID",
] as const;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`)
    .join(",")}}`;
}

function sealManifest<T extends object>(unsigned: T): T & { manifestSha256: string } {
  return {
    ...clone(unsigned),
    manifestSha256: createHash("sha256").update(canonicalize(unsigned)).digest("hex"),
  };
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalize(value)).digest("hex");
}

function sealReceipt<T extends object, K extends string>(
  unsigned: T,
  checksumField: K,
): T & Record<K, string> {
  return { ...clone(unsigned), [checksumField]: sha256(unsigned) } as T & Record<K, string>;
}

function managedSubjectProof(bridgeId: string, index: number): ManagedBridgeSubjectProof {
  return {
    schemaVersion: 1,
    subjectRevision: index + 1,
    projectId: "prj_atomic_test",
    originalThreadId: `thread_${bridgeId}`,
    agentId: "codex",
    runId: `run_${bridgeId}`,
    sessionId: `session_${bridgeId}`,
    lineageId: `lineage_${bridgeId}`,
    incarnation: index + 1,
    bundleId: `bundle_${bridgeId}`,
    build: clone(previousIdentity),
    vaultSha256: String((index + 7) % 10).repeat(64),
    checkpointSha256: String((index + 8) % 10).repeat(64),
    checkpointEventSequence: index,
    fuseGeneration: index + 1,
  };
}

function pausedSubject(
  bridgeId: string,
  index: number,
  previousDesiredState: "RUNNING" | "STOPPED",
): PausedManagedBridgeSubject {
  const subjectProof = managedSubjectProof(bridgeId, index);
  return {
    previousDesiredState,
    subjectProof,
    subjectProofSha256: sha256({ previousDesiredState, subjectProof }),
  };
}

function preflightManifest(
  sourceIdentity: ReleaseIdentity = previousIdentity,
  dataVersion = 1,
): OnlinePreflightSnapshotManifest {
  return sealManifest({
    schemaVersion: 1 as const,
    snapshotId: "snap_online_preflight",
    sourceIdentity: clone(sourceIdentity),
    createdAt: "2026-08-01T00:00:00.000Z",
    snapshotKind: "ONLINE_PREFLIGHT" as const,
    restoreEligible: false as const,
    quiescenceProof: null,
    database: {
      strategy: "SQLITE_BACKUP_API" as const,
      sourceJournalMode: "WAL" as const,
      sourceQuickCheck: "ok" as const,
      backupQuickCheck: "ok" as const,
      artifact: {
        role: "DATABASE" as const,
        logicalName: "database/crossagent.db",
        relativePath: "database/crossagent.db",
        size: 8192,
        sha256: String(dataVersion).repeat(64).slice(0, 64),
      },
    },
    releaseFiles: [
      {
        role: "RELEASE_POINTER" as const,
        logicalName: "release/pointer.json",
        relativePath: "release/pointer.json",
        size: 128,
        sha256: "8".repeat(64),
      },
      {
        role: "ARTIFACT_DESCRIPTOR" as const,
        logicalName: "release/artifact-descriptor.json",
        relativePath: "release/artifact-descriptor.json",
        size: 256,
        sha256: "9".repeat(64),
      },
    ],
    excludedFromRestore: [...excludedFromRestore],
    configFiles: [] as [],
  });
}

const quiescenceProof: QuiescenceProof = {
  state: "QUIESCED",
  fenceId: "fence_atomic_test",
  stopReceiptId: "stop_atomic_test",
  observedAt: "2026-08-01T00:00:05.000Z",
};

function finalManifest(
  sourceIdentity: ReleaseIdentity = previousIdentity,
  proof: QuiescenceProof = quiescenceProof,
  dataVersion = 2,
): FinalRollbackSnapshotManifest {
  return sealManifest({
    schemaVersion: 1 as const,
    snapshotId: "snap_final_rollback",
    sourceIdentity: clone(sourceIdentity),
    createdAt: "2026-08-01T00:00:06.000Z",
    snapshotKind: "FINAL_ROLLBACK" as const,
    restoreEligible: true as const,
    quiescenceProof: clone(proof),
    database: {
      strategy: "SQLITE_BACKUP_API" as const,
      sourceJournalMode: "WAL" as const,
      sourceQuickCheck: "ok" as const,
      backupQuickCheck: "ok" as const,
      artifact: {
        role: "DATABASE" as const,
        logicalName: "database/crossagent.db",
        relativePath: "database/crossagent.db",
        size: 8192,
        sha256: String(dataVersion).repeat(64).slice(0, 64),
      },
    },
    releaseFiles: [
      {
        role: "RELEASE_POINTER" as const,
        logicalName: "release/pointer.json",
        relativePath: "release/pointer.json",
        size: 128,
        sha256: "8".repeat(64),
      },
      {
        role: "ARTIFACT_DESCRIPTOR" as const,
        logicalName: "release/artifact-descriptor.json",
        relativePath: "release/artifact-descriptor.json",
        size: 256,
        sha256: "9".repeat(64),
      },
    ],
    excludedFromRestore: [...excludedFromRestore],
    configFiles: [
      {
        role: "CANDIDATE_OWNED_CONFIG" as const,
        logicalName: "config/runtime.json",
        relativePath: "config/runtime.json",
        size: 64,
        sha256: "a".repeat(64),
        expectedCandidateSha256: "b".repeat(64),
      },
    ],
  });
}

function snapshotDatabaseReceipt(backupSha256: string, capturedAt: string) {
  return {
    schemaVersion: 1 as const,
    adapterKind: "SQLITE_BACKUP_API" as const,
    sourceDatabaseIdentitySha256: "e".repeat(64),
    sourcePageCount: 2,
    sourceWalCommitSequence: 1,
    backupSha256,
    sourceQuickCheck: "ok" as const,
    backupQuickCheck: "ok" as const,
    capturedAt,
  };
}

function securityStateReceipt(observedAt: string) {
  return {
    schemaVersion: 1 as const,
    securityEpoch: 7,
    securityEventSequence: 11,
    securityStateSha256: "7".repeat(64),
    externalJournalSha256: "f".repeat(64),
    observedAt,
  };
}

class SimulatedProcessKill extends Error {}

class MemoryJournalStore implements AtomicReleaseJournalStore {
  readonly records = new Map<string, AtomicReleaseJournal>();
  readonly history = new Map<string, AtomicReleaseJournal[]>();
  crashAfterPhase: AtomicReleaseJournalPhase | null = null;
  activeLease: AtomicReleaseActiveLeaseClaim | null = null;
  leaseAcquireCalls = 0;
  leaseRenewCalls = 0;
  leaseReleaseCalls = 0;
  private generation = 0;
  private crashed = false;

  constructor(private readonly now: () => string = () => "2026-08-01T00:00:00.000Z") {}

  async acquireActiveLease(
    input: AtomicReleaseActiveLeaseRequest,
  ): Promise<{ state: "ACQUIRED"; claim: AtomicReleaseActiveLeaseClaim } | { state: "HELD" }> {
    this.leaseAcquireCalls += 1;
    const current = this.activeLease;
    if (current && Date.parse(current.expiresAt) > Date.parse(this.now())) {
      if (
        current.operationId === input.operationId &&
        current.requestFingerprint === input.requestFingerprint &&
        current.ownerId === input.ownerId
      ) {
        return { state: "ACQUIRED", claim: clone(current) };
      }
      return { state: "HELD" };
    }
    const claim: AtomicReleaseActiveLeaseClaim = {
      ...clone(input),
      generation: this.generation + 1,
    };
    this.generation = claim.generation;
    this.activeLease = claim;
    return { state: "ACQUIRED", claim: clone(claim) };
  }

  async renewActiveLease(
    claim: AtomicReleaseActiveLeaseClaim,
    nextExpiresAt: string,
  ): Promise<{ state: "RENEWED"; claim: AtomicReleaseActiveLeaseClaim } | { state: "LOST" }> {
    this.leaseRenewCalls += 1;
    if (
      !this.activeLease ||
      this.activeLease.leaseKey !== claim.leaseKey ||
      this.activeLease.operationId !== claim.operationId ||
      this.activeLease.requestFingerprint !== claim.requestFingerprint ||
      this.activeLease.ownerId !== claim.ownerId ||
      this.activeLease.generation !== claim.generation ||
      Date.parse(this.activeLease.expiresAt) <= Date.parse(this.now()) ||
      Date.parse(nextExpiresAt) <= Date.parse(this.now())
    ) {
      return { state: "LOST" };
    }
    this.activeLease = { ...clone(claim), expiresAt: nextExpiresAt };
    return { state: "RENEWED", claim: clone(this.activeLease) };
  }

  async releaseActiveLease(
    claim: AtomicReleaseActiveLeaseClaim,
    terminal: AtomicReleaseTerminalLeaseProof,
  ): Promise<boolean> {
    this.leaseReleaseCalls += 1;
    const journal = this.records.get(terminal.operationId);
    if (
      this.activeLease?.leaseKey === claim.leaseKey &&
      this.activeLease.operationId === claim.operationId &&
      this.activeLease.requestFingerprint === claim.requestFingerprint &&
      this.activeLease.ownerId === claim.ownerId &&
      this.activeLease.generation === claim.generation &&
      terminal.operationId === claim.operationId &&
      terminal.requestFingerprint === claim.requestFingerprint &&
      journal?.phase === terminal.terminalPhase &&
      journal.revision === terminal.journalRevision
    ) {
      this.activeLease = null;
      return true;
    }
    return false;
  }

  async load(operationId: string): Promise<AtomicReleaseJournal | null> {
    const value = this.records.get(operationId);
    return value ? clone(value) : null;
  }

  async compareAndSwap(
    operationId: string,
    expectedRevision: number | null,
    next: AtomicReleaseJournal,
    lease: AtomicReleaseActiveLeaseClaim,
  ): Promise<boolean> {
    if (
      !this.activeLease ||
      this.activeLease.leaseKey !== lease.leaseKey ||
      this.activeLease.operationId !== lease.operationId ||
      this.activeLease.requestFingerprint !== lease.requestFingerprint ||
      this.activeLease.ownerId !== lease.ownerId ||
      this.activeLease.generation !== lease.generation
    ) {
      return false;
    }
    const current = this.records.get(operationId);
    if ((current?.revision ?? null) !== expectedRevision) return false;
    this.records.set(operationId, clone(next));
    this.history.set(operationId, [...(this.history.get(operationId) ?? []), clone(next)]);
    if (!this.crashed && next.phase === this.crashAfterPhase) {
      this.crashed = true;
      throw new SimulatedProcessKill(`killed after ${next.phase}`);
    }
    return true;
  }
}

type HarnessOptions = {
  ambiguousOnceAt?: string;
  candidateIdentity?: ReleaseIdentity;
  candidateHealthy?: boolean;
  legalWriteAfterPreflight?: boolean;
  stopReceiptLostOnce?: boolean;
  finalSnapshotReceiptLostOnce?: boolean;
  maintenanceCommitLostOnce?: boolean;
  currentObservationUnknownOnce?: boolean;
  rejectMigration?: boolean;
  corruptFinalProof?: boolean;
  throwPreflightError?: boolean;
  previouslyRunningBridgeIds?: string[];
  previouslyStoppedBridgeIds?: string[];
  resumeStoppedSubject?: boolean;
  fuseGenerationZero?: boolean;
  rejectAt?: "PAUSE" | "STOP" | "FINAL_SNAPSHOT" | "SWAP";
};

function createHarness(options: HarnessOptions = {}) {
  const events: string[] = [];
  const calls = new Map<string, number>();
  const idempotencyKeys = new Map<string, string[]>();
  let installed: ReleaseIdentity = clone(previousIdentity);
  let runtime: DeploymentObservation["runtime"] = {
    state: "RUNNING",
    identity: clone(previousIdentity),
    runtimeId: "runtime_previous",
    hubInstanceId: "hub_previous",
    boundAddress: "127.0.0.1",
    boundPort: 4316,
    mode: "NORMAL",
  };
  let dataVersion = 1;
  let pointerRevision = 10;
  let finalCapturedDataVersion: number | null = null;
  let cachedFinalManifest: FinalRollbackSnapshotManifest | null = null;
  let stopLost = false;
  let finalLost = false;
  let commitLost = false;
  let observationUnknown = false;
  let ambiguousConsumed = false;
  const bridgeIds = [...(options.previouslyRunningBridgeIds ?? ["bridge_a", "bridge_c"])];
  const stoppedBridgeIds = [...(options.previouslyStoppedBridgeIds ?? [])];
  const pausedSubjects = [
    ...bridgeIds.map((bridgeId, index) => pausedSubject(bridgeId, index, "RUNNING")),
    ...stoppedBridgeIds.map((bridgeId, index) =>
      pausedSubject(bridgeId, bridgeIds.length + index, "STOPPED"),
    ),
  ];
  if (options.fuseGenerationZero && pausedSubjects[0]) {
    pausedSubjects[0].subjectProof.fuseGeneration = 0;
    pausedSubjects[0].subjectProofSha256 = sha256({
      previousDesiredState: pausedSubjects[0].previousDesiredState,
      subjectProof: pausedSubjects[0].subjectProof,
    });
  }
  const resumedBridgeIds: string[] = [];
  let lastSwapInput: Record<string, unknown> | null = null;
  let lastResumeInput: Record<string, unknown> | null = null;

  const count = (name: string, key?: string) => {
    calls.set(name, (calls.get(name) ?? 0) + 1);
    events.push(name);
    if (key) idempotencyKeys.set(name, [...(idempotencyKeys.get(name) ?? []), key]);
  };
  const loseResponse = (name: string) => {
    if (ambiguousConsumed || options.ambiguousOnceAt !== name) return false;
    ambiguousConsumed = true;
    return true;
  };
  const observation = (): DeploymentObservation => ({
    observedAt: "2026-08-01T00:00:02.000Z",
    installed: { state: "KNOWN", identity: clone(installed) },
    runtime: clone(runtime),
  });

  const adapters: AtomicReleaseAdapters = {
    async probeCandidate(input) {
      count("probeCandidate", input.idempotencyKey);
      if (loseResponse("probeCandidate")) {
        return { state: "AMBIGUOUS" as const, code: "PROBE_RECEIPT_LOST" };
      }
      return {
        state: "CONFIRMED" as const,
        receipt: {
          candidateId: input.candidateId,
          probeId: "probe_atomic_test",
          isolation: "BACKUP_COPY" as const,
          requestedPort: 0 as const,
          boundAddress: "127.0.0.1" as const,
          boundPort: 4317,
          runtimeInstanceId: "candidate_probe_runtime",
          backupDatabaseIdentitySha256: "e".repeat(64),
          healthy: true as const,
          identity: clone(options.candidateIdentity ?? candidateIdentity),
          probedAt: "2026-08-01T00:00:00.000Z",
        },
      };
    },
    async createOnlinePreflightSnapshot(input) {
      count("createOnlinePreflightSnapshot", input.idempotencyKey);
      if (options.throwPreflightError) throw new Error(secretCanary);
      if (loseResponse("createOnlinePreflightSnapshot")) {
        return { state: "AMBIGUOUS" as const, code: "PREFLIGHT_RECEIPT_LOST" };
      }
      const manifest = preflightManifest(previousIdentity, dataVersion);
      return {
        state: "CONFIRMED" as const,
        manifest,
        receipt: snapshotDatabaseReceipt(
          manifest.database.artifact.sha256,
          "2026-08-01T00:00:01.000Z",
        ),
      };
    },
    async observe(_input) {
      count("observe");
      if (options.currentObservationUnknownOnce && !observationUnknown) {
        observationUnknown = true;
        return {
          observedAt: "2026-08-01T00:00:02.000Z",
          installed: { state: "UNKNOWN" as const },
          runtime: { state: "UNKNOWN" as const },
        };
      }
      return observation();
    },
    async enterHubMaintenance(input) {
      count("enterHubMaintenance", input.idempotencyKey);
      if (options.legalWriteAfterPreflight) dataVersion = 2;
      if (runtime.state === "RUNNING") runtime = { ...runtime, mode: "MAINTENANCE" };
      if (loseResponse("enterHubMaintenance")) {
        return { state: "AMBIGUOUS" as const, code: "MAINTENANCE_RECEIPT_LOST" };
      }
      return {
        state: "CONFIRMED" as const,
        receipt: {
          maintenanceId: "maint_atomic_test",
          scope: "HUB_WIDE" as const,
          mode: "MAINTENANCE" as const,
          fenceId: quiescenceProof.fenceId,
          sourceIdentity: clone(previousIdentity),
          sourceRuntimeId: "runtime_previous",
          sourceHubInstanceId: "hub_previous",
          releasePointerRevision: pointerRevision,
          securityState: securityStateReceipt("2026-08-01T00:00:03.000Z"),
          enteredAt: "2026-08-01T00:00:03.000Z",
        },
      };
    },
    async pauseManagedBridgeSupervisors(input) {
      count("pauseManagedBridgeSupervisors", input.idempotencyKey);
      if (options.rejectAt === "PAUSE") {
        return { state: "REJECTED" as const, code: "PAUSE_REJECTED" };
      }
      if (loseResponse("pauseManagedBridgeSupervisors")) {
        return { state: "AMBIGUOUS" as const, code: "PAUSE_RECEIPT_LOST" };
      }
      const unsignedReceipt = {
        schemaVersion: 1 as const,
        operationId: input.operationId,
        maintenanceId: "maint_atomic_test",
        fenceId: quiescenceProof.fenceId,
        pauseReceiptId: "pause_atomic_test",
        atomicJournalRevision: input.atomicJournalRevision,
        releasePointerRevision: pointerRevision,
        supervisorJournalRevision: 20,
        subjects: clone(pausedSubjects),
        pausedAt: "2026-08-01T00:00:04.000Z",
      };
      return {
        state: "CONFIRMED" as const,
        receipt: sealReceipt(unsignedReceipt, "receiptSha256"),
      };
    },
    async stopCurrentCooperatively(input) {
      count("stopCurrentCooperatively", input.idempotencyKey);
      if (options.rejectAt === "STOP") {
        return { state: "REJECTED" as const, code: "STOP_REJECTED" };
      }
      runtime = { state: "STOPPED" };
      if (options.stopReceiptLostOnce && !stopLost) {
        stopLost = true;
        return { state: "AMBIGUOUS" as const, code: "STOP_RECEIPT_LOST" };
      }
      if (loseResponse("stopCurrentCooperatively")) {
        return { state: "AMBIGUOUS" as const, code: "STOP_RECEIPT_LOST" };
      }
      return {
        state: "CONFIRMED" as const,
        receipt: {
          maintenanceId: "maint_atomic_test",
          fenceId: quiescenceProof.fenceId,
          stopReceiptId: quiescenceProof.stopReceiptId,
          sourceIdentity: clone(previousIdentity),
          sourceRuntimeId: "runtime_previous",
          sourceHubInstanceId: "hub_previous",
          runtimeState: "STOPPED" as const,
          stoppedAt: quiescenceProof.observedAt,
        },
      };
    },
    async createFinalRollbackSnapshot(input) {
      count("createFinalRollbackSnapshot", input.idempotencyKey);
      if (options.rejectAt === "FINAL_SNAPSHOT") {
        return { state: "REJECTED" as const, code: "FINAL_SNAPSHOT_REJECTED" };
      }
      if (!cachedFinalManifest) {
        finalCapturedDataVersion = dataVersion;
        cachedFinalManifest = finalManifest(
          previousIdentity,
          options.corruptFinalProof
            ? { ...input.quiescenceProof, stopReceiptId: "stop_wrong" }
            : input.quiescenceProof,
          dataVersion,
        );
      }
      if (options.finalSnapshotReceiptLostOnce && !finalLost) {
        finalLost = true;
        return { state: "AMBIGUOUS" as const, code: "FINAL_SNAPSHOT_RECEIPT_LOST" };
      }
      if (loseResponse("createFinalRollbackSnapshot")) {
        return { state: "AMBIGUOUS" as const, code: "FINAL_SNAPSHOT_RECEIPT_LOST" };
      }
      const manifest = clone(cachedFinalManifest);
      return {
        state: "CONFIRMED" as const,
        manifest,
        receipt: {
          database: snapshotDatabaseReceipt(manifest.database.artifact.sha256, manifest.createdAt),
          security: {
            ...securityStateReceipt("2026-08-01T00:00:06.000Z"),
            snapshotId: manifest.snapshotId,
          },
        },
      };
    },
    async atomicSwap(input) {
      count("atomicSwap", input.idempotencyKey);
      lastSwapInput = clone(input as unknown as Record<string, unknown>);
      if (options.rejectAt === "SWAP") {
        return { state: "REJECTED" as const, code: "SWAP_REJECTED" };
      }
      expect(input.finalSnapshot.snapshotKind).toBe("FINAL_ROLLBACK");
      installed = clone(candidateIdentity);
      if (loseResponse("atomicSwap")) {
        return { state: "AMBIGUOUS" as const, code: "SWAP_RECEIPT_LOST" };
      }
      const previousPointerRevision = pointerRevision;
      pointerRevision += 1;
      return {
        state: "CONFIRMED" as const,
        receipt: {
          schemaVersion: 1 as const,
          operationId: request.operationId,
          previousPointerRevision,
          pointerRevision,
          sourceIdentity: clone(previousIdentity),
          candidateIdentity: clone(candidateIdentity),
          installedIdentity: clone(candidateIdentity),
          replaceStrategy: "WINDOWS_REPLACE_FILE" as const,
          replaceGeneration: 1,
          previousArtifactSha256: previousIdentity.manifestSha256,
          candidateArtifactSha256: candidateIdentity.manifestSha256,
          installedArtifactSha256: candidateIdentity.manifestSha256,
          durability: "REPLACED_AND_DIRECTORY_SYNCED" as const,
          swappedAt: "2026-08-01T00:00:06.500Z",
        },
      };
    },
    async startCandidateInMaintenance(input) {
      count("startCandidateInMaintenance", input.idempotencyKey);
      runtime = {
        state: "RUNNING",
        identity: clone(candidateIdentity),
        runtimeId: "runtime_candidate",
        hubInstanceId: "hub_candidate",
        boundAddress: "127.0.0.1",
        boundPort: 4318,
        mode: "MAINTENANCE",
      };
      if (loseResponse("startCandidateInMaintenance")) {
        return { state: "AMBIGUOUS" as const, code: "START_RECEIPT_LOST" };
      }
      return {
        state: "CONFIRMED" as const,
        receipt: {
          maintenanceId: "maint_atomic_test",
          runtimeId: "runtime_candidate",
          hubInstanceId: "hub_candidate",
          boundAddress: "127.0.0.1" as const,
          boundPort: 4318,
          identity: clone(candidateIdentity),
          mode: "MAINTENANCE" as const,
          startedAt: "2026-08-01T00:00:07.000Z",
        },
      };
    },
    async probeMaintenanceHealth(input) {
      count(`probeMaintenanceHealth:${input.target}`, input.idempotencyKey);
      if (loseResponse(`probeMaintenanceHealth:${input.target}`)) {
        return { state: "AMBIGUOUS" as const, code: "HEALTH_RECEIPT_LOST" };
      }
      if (input.target === "CANDIDATE" && options.candidateHealthy === false) {
        return { state: "UNHEALTHY" as const, code: "CANDIDATE_HEALTH_FAILED" };
      }
      const identity = input.target === "CANDIDATE" ? candidateIdentity : previousIdentity;
      const runtimeId =
        input.target === "CANDIDATE" ? "runtime_candidate" : "runtime_previous_restored";
      const hubInstanceId =
        input.target === "CANDIDATE" ? "hub_candidate" : "hub_previous_restored";
      return {
        state: "HEALTHY" as const,
        receipt: {
          maintenanceId: "maint_atomic_test",
          target: input.target,
          identity: clone(identity),
          runtimeId,
          hubInstanceId,
          boundAddress: "127.0.0.1" as const,
          boundPort: input.target === "CANDIDATE" ? 4318 : 4319,
          mode: "MAINTENANCE" as const,
          checkedAt: "2026-08-01T00:00:08.000Z",
        },
      };
    },
    async migrateCandidateInMaintenance(input) {
      count("migrateCandidateInMaintenance", input.idempotencyKey);
      if (options.rejectMigration)
        return { state: "REJECTED" as const, code: "MIGRATION_REJECTED" };
      if (loseResponse("migrateCandidateInMaintenance")) {
        return { state: "AMBIGUOUS" as const, code: "MIGRATION_RECEIPT_LOST" };
      }
      return {
        state: "CONFIRMED" as const,
        receipt: {
          maintenanceId: "maint_atomic_test",
          identity: clone(candidateIdentity),
          migrationId: candidateIdentity.migrationId,
          migratedAt: "2026-08-01T00:00:09.000Z",
        },
      };
    },
    async commitMaintenance(input) {
      count(`commitMaintenance:${input.target}`, input.idempotencyKey);
      if (loseResponse(`commitMaintenance:${input.target}`)) {
        return { state: "AMBIGUOUS" as const, code: "COMMIT_RECEIPT_LOST" };
      }
      if (options.maintenanceCommitLostOnce && !commitLost) {
        commitLost = true;
        return { state: "AMBIGUOUS" as const, code: "COMMIT_RECEIPT_LOST" };
      }
      if (runtime.state === "RUNNING") runtime = { ...runtime, mode: "NORMAL" };
      return {
        state: "CONFIRMED" as const,
        receipt: {
          maintenanceId: "maint_atomic_test",
          target: input.target,
          identity: clone(input.target === "CANDIDATE" ? candidateIdentity : previousIdentity),
          atomicJournalRevision: input.atomicJournalRevision,
          releasePointerRevision: input.expectedPointerRevision + 1,
          committedAt: "2026-08-01T00:00:10.000Z",
        },
      };
    },
    async resumePreviouslyRunningBridges(input) {
      const target = installed.buildId === candidateIdentity.buildId ? "CANDIDATE" : "PREVIOUS";
      count(`resumePreviouslyRunningBridges:${target}`, input.idempotencyKey);
      lastResumeInput = clone(input as unknown as Record<string, unknown>);
      const effects: ManagedBridgeReleaseEffectReceipt[] = pausedSubjects.map((subject, index) => {
        if (subject.previousDesiredState === "RUNNING") {
          resumedBridgeIds.push(subject.subjectProof.runId);
        }
        const effect =
          subject.previousDesiredState === "STOPPED"
            ? options.resumeStoppedSubject
              ? target === "CANDIDATE"
                ? "REBOUND"
                : "ROLLED_BACK"
              : "ALREADY_STOPPED"
            : target === "CANDIDATE"
              ? "REBOUND"
              : "ROLLED_BACK";
        return sealReceipt(
          {
            schemaVersion: 1,
            effectReceiptId: `effect_${index + 1}`,
            authorizationId: input.transitionAuthorizationId,
            authorizationSha256: input.expectedAuthorizationSha256,
            operationId: input.operationId,
            effect,
            supervisorJournalRevision: 21 + index,
            previousDesiredState: subject.previousDesiredState,
            subjectProof: clone(subject.subjectProof),
            sealedSubjectProofSha256: subject.subjectProofSha256,
            installedIdentity: clone(installed),
            effectedAt: "2026-08-01T00:00:09.500Z",
          },
          "effectReceiptSha256",
        );
      });
      if (loseResponse(`resumePreviouslyRunningBridges:${target}`)) {
        return { state: "AMBIGUOUS" as const, code: "RESUME_RECEIPT_LOST" };
      }
      return {
        state: "CONFIRMED" as const,
        receipt: {
          maintenanceId: "maint_atomic_test",
          target,
          authorizationId: input.transitionAuthorizationId,
          authorizationSha256: input.expectedAuthorizationSha256,
          effects,
          resumedAt: "2026-08-01T00:00:11.000Z",
        } satisfies BridgeResumeReceipt,
      };
    },
    async stopCandidate(input) {
      count("stopCandidate", input.idempotencyKey);
      runtime = { state: "STOPPED" };
      if (loseResponse("stopCandidate")) {
        return { state: "AMBIGUOUS" as const, code: "ROLLBACK_STOP_RECEIPT_LOST" };
      }
      return { state: "CONFIRMED" as const };
    },
    async restoreFinalRollbackSnapshot(input) {
      count("restoreFinalRollbackSnapshot", input.idempotencyKey);
      expect(input.finalSnapshot.snapshotKind).toBe("FINAL_ROLLBACK");
      expect(input.finalSnapshot.restoreEligible).toBe(true);
      installed = clone(previousIdentity);
      runtime = { state: "STOPPED" };
      dataVersion = finalCapturedDataVersion ?? -1;
      if (loseResponse("restoreFinalRollbackSnapshot")) {
        return { state: "AMBIGUOUS" as const, code: "ROLLBACK_RESTORE_RECEIPT_LOST" };
      }
      const previousPointerRevision = pointerRevision;
      pointerRevision += 1;
      return {
        state: "CONFIRMED" as const,
        receipt: {
          schemaVersion: 1 as const,
          operationId: request.operationId,
          snapshotId: input.finalSnapshot.snapshotId,
          adapterKind: "SQLITE_BACKUP_API" as const,
          sourceDatabaseIdentitySha256: "e".repeat(64),
          restoredDatabaseSha256: input.snapshotDatabaseReceipt.backupSha256,
          restoredPageCount: 2,
          restoredQuickCheck: "ok" as const,
          staleWalDisposition: "ISOLATED_AND_CLEARED" as const,
          previousPointerRevision,
          pointerRevision,
          restoredIdentity: clone(previousIdentity),
          snapshotSecurityEpoch: input.snapshotSecurityReceipt.securityEpoch,
          observedSecurityEpochBeforeRestore: 7,
          reconciledSecurityEpoch: 7,
          replayedThroughSecurityEventSequence: input.snapshotSecurityReceipt.securityEventSequence,
          reconciledSecurityStateSha256: "7".repeat(64),
          externalJournalSha256: "f".repeat(64),
          credentialState: "FORWARD_RECONCILED" as const,
          sessionTicketState: "FORWARD_RECONCILED" as const,
          authorityState: "FORWARD_RECONCILED" as const,
          restoredAt: "2026-08-01T00:00:11.500Z",
        },
      };
    },
    async startPreviousInMaintenance(input) {
      count("startPreviousInMaintenance", input.idempotencyKey);
      runtime = {
        state: "RUNNING",
        identity: clone(previousIdentity),
        runtimeId: "runtime_previous_restored",
        hubInstanceId: "hub_previous_restored",
        boundAddress: "127.0.0.1",
        boundPort: 4319,
        mode: "MAINTENANCE",
      };
      if (loseResponse("startPreviousInMaintenance")) {
        return { state: "AMBIGUOUS" as const, code: "PREVIOUS_START_RECEIPT_LOST" };
      }
      return {
        state: "CONFIRMED" as const,
        receipt: {
          maintenanceId: "maint_atomic_test",
          runtimeId: "runtime_previous_restored",
          hubInstanceId: "hub_previous_restored",
          boundAddress: "127.0.0.1" as const,
          boundPort: 4319,
          identity: clone(previousIdentity),
          mode: "MAINTENANCE" as const,
          startedAt: "2026-08-01T00:00:12.000Z",
        },
      };
    },
    async cleanupPreSwapMaintenance(input) {
      count("cleanupPreSwapMaintenance", input.idempotencyKey);
      installed = clone(previousIdentity);
      runtime = {
        state: "RUNNING",
        identity: clone(previousIdentity),
        runtimeId: "runtime_previous_cleanup",
        hubInstanceId: "hub_previous_cleanup",
        boundAddress: "127.0.0.1",
        boundPort: 4316,
        mode: "NORMAL",
      };
      return {
        state: "CONFIRMED" as const,
        receipt: {
          schemaVersion: 1 as const,
          operationId: request.operationId,
          maintenanceId: "maint_atomic_test",
          failedPhase: input.failedPhase,
          sourceIdentity: clone(previousIdentity),
          runtimeId: "runtime_previous_cleanup",
          hubInstanceId: "hub_previous_cleanup",
          mode: "NORMAL" as const,
          pauseReceiptId:
            input.failedPhase === "PAUSE_SUPERVISORS_INTENT" ? null : "pause_atomic_test",
          releasePointerRevision: pointerRevision,
          securityEpoch: 7,
          securityStateSha256: "7".repeat(64),
          cleanedAt: "2026-08-01T00:00:06.800Z",
        },
      };
    },
  };

  return {
    adapters,
    events,
    calls,
    idempotencyKeys,
    observation,
    dataVersion: () => dataVersion,
    resumedBridgeIds,
    lastSwapInput: () => lastSwapInput,
    lastResumeInput: () => lastResumeInput,
  };
}

function manager(store: AtomicReleaseJournalStore, adapters: AtomicReleaseAdapters) {
  return new AtomicReleaseManager({
    journalStore: store,
    adapters,
    ownerId: "owner_atomic_test",
    now: () => "2026-08-01T00:00:00.000Z",
  });
}

async function completedJournal(): Promise<AtomicReleaseJournal> {
  const store = new MemoryJournalStore();
  const harness = createHarness();
  await manager(store, harness.adapters).run(request);
  const journal = store.records.get(request.operationId);
  if (!journal) throw new Error("completed fixture did not persist a journal");
  return clone(journal);
}

describe("AtomicReleaseManager maintenance orchestration", () => {
  it("orders preflight, hub-wide quiesce, supervisor pause, cooperative stop, final snapshot, maintenance migration, commit, and exact bridge resume", async () => {
    const store = new MemoryJournalStore();
    const harness = createHarness({ previouslyRunningBridgeIds: ["bridge_a", "bridge_c"] });

    await expect(manager(store, harness.adapters).run(request)).resolves.toEqual({
      state: "DEPLOYED",
      operationId: request.operationId,
      identity: candidateIdentity,
    });

    expect(harness.events).toEqual([
      "probeCandidate",
      "createOnlinePreflightSnapshot",
      "observe",
      "enterHubMaintenance",
      "pauseManagedBridgeSupervisors",
      "stopCurrentCooperatively",
      "observe",
      "createFinalRollbackSnapshot",
      "atomicSwap",
      "observe",
      "startCandidateInMaintenance",
      "probeMaintenanceHealth:CANDIDATE",
      "migrateCandidateInMaintenance",
      "resumePreviouslyRunningBridges:CANDIDATE",
      "commitMaintenance:CANDIDATE",
    ]);
    expect(store.records.get(request.operationId)).toMatchObject({
      phase: "COMPLETED",
      preflightSnapshot: { snapshotKind: "ONLINE_PREFLIGHT", restoreEligible: false },
      finalSnapshot: { snapshotKind: "FINAL_ROLLBACK", restoreEligible: true },
      supervisorPauseReceipt: {
        subjects: [
          { previousDesiredState: "RUNNING", subjectProof: { runId: "run_bridge_a" } },
          { previousDesiredState: "RUNNING", subjectProof: { runId: "run_bridge_c" } },
        ],
      },
    });
    expect(store.leaseRenewCalls).toBeGreaterThan(0);
    expect(store.leaseReleaseCalls).toBe(1);
    expect(store.activeLease).toBeNull();
  });

  it("binds resume to exact subject proofs and never wakes a supervisor that was already stopped", async () => {
    const store = new MemoryJournalStore();
    const harness = createHarness({
      previouslyRunningBridgeIds: ["bridge_running"],
      previouslyStoppedBridgeIds: ["bridge_user_stopped"],
    });

    await expect(manager(store, harness.adapters).run(request)).resolves.toEqual({
      state: "DEPLOYED",
      operationId: request.operationId,
      identity: candidateIdentity,
    });
    expect(harness.resumedBridgeIds).toEqual(["run_bridge_running"]);
    expect(store.records.get(request.operationId)?.bridgeResumeReceipt).toMatchObject({
      effects: [
        { previousDesiredState: "RUNNING", effect: "REBOUND" },
        { previousDesiredState: "STOPPED", effect: "ALREADY_STOPPED" },
      ],
    });
  });

  it("rejects a resume receipt that claims a user-stopped supervisor was restarted", async () => {
    const store = new MemoryJournalStore();
    const harness = createHarness({
      previouslyRunningBridgeIds: [],
      previouslyStoppedBridgeIds: ["bridge_user_stopped"],
      resumeStoppedSubject: true,
    });

    await expect(manager(store, harness.adapters).run(request)).resolves.toMatchObject({
      state: "RECOVERY_REQUIRED",
      code: "BRIDGE_RESUME_AMBIGUOUS",
      phase: "RESUME_BRIDGES_INTENT",
    });
    expect(store.records.get(request.operationId)?.bridgeResumeReceipt).toBeNull();
  });

  it("accepts fuse generation zero for a managed Bridge that has never opened its fuse", async () => {
    const store = new MemoryJournalStore();
    const harness = createHarness({ fuseGenerationZero: true });

    await expect(manager(store, harness.adapters).run(request)).resolves.toEqual({
      state: "DEPLOYED",
      operationId: request.operationId,
      identity: candidateIdentity,
    });
  });

  it("binds swap to an exact strict-successor pointer and a durable replace-existing receipt", async () => {
    const store = new MemoryJournalStore();
    const harness = createHarness();

    await expect(manager(store, harness.adapters).run(request)).resolves.toMatchObject({
      state: "DEPLOYED",
    });
    expect(harness.lastSwapInput()).toMatchObject({ expectedPointerRevision: 10 });
    expect(store.records.get(request.operationId)).toMatchObject({
      swapReceipt: {
        previousPointerRevision: 10,
        pointerRevision: 11,
        replaceStrategy: "WINDOWS_REPLACE_FILE",
        durability: "REPLACED_AND_DIRECTORY_SYNCED",
      },
    });
  });

  it("persists transition authorization before Bridge effects instead of claiming a future terminal phase", async () => {
    const store = new MemoryJournalStore();
    const harness = createHarness();

    await expect(manager(store, harness.adapters).run(request)).resolves.toMatchObject({
      state: "DEPLOYED",
    });
    expect(store.records.get(request.operationId)).toMatchObject({
      transitionAuthorization: {
        authorizedOutcome: "DEPLOYED",
        installedIdentity: candidateIdentity,
      },
    });
    const authorized = store.history
      .get(request.operationId)
      ?.find((journal) => journal.phase === "BRIDGE_TRANSITION_AUTHORIZED");
    expect(authorized?.transitionAuthorization?.atomicJournalRevision).toBeLessThan(
      authorized?.revision ?? 0,
    );
    expect(harness.lastResumeInput()).toHaveProperty("transitionAuthorizationId");
    expect(harness.lastResumeInput()).not.toHaveProperty("expectedTerminalPhase");
  });

  it.each([
    ["PAUSE", "SUPERVISOR_PAUSE_FAILED", "PAUSE_SUPERVISORS_INTENT"],
    ["STOP", "STOP_FAILED", "STOP_INTENT"],
    ["FINAL_SNAPSHOT", "FINAL_SNAPSHOT_FAILED", "FINAL_SNAPSHOT_INTENT"],
    ["SWAP", "SWAP_FAILED", "SWAP_INTENT"],
  ] as const)(
    "cleans up maintenance, runtime, and supervisors after a known %s rejection",
    async (rejectAt, code, failedPhase) => {
      const store = new MemoryJournalStore();
      const harness = createHarness({ rejectAt });

      await expect(manager(store, harness.adapters).run(request)).resolves.toMatchObject({
        state: "BLOCKED",
        code,
        phase: failedPhase,
      });
      expect(harness.events).toContain("cleanupPreSwapMaintenance");
      expect(harness.observation()).toMatchObject({
        installed: { state: "KNOWN", identity: previousIdentity },
        runtime: { state: "RUNNING", identity: previousIdentity, mode: "NORMAL" },
      });
    },
  );

  it("keeps the global active-operation slot bound after an ambiguous nonterminal outcome", async () => {
    const store = new MemoryJournalStore();
    const firstHarness = createHarness({ stopReceiptLostOnce: true });
    const firstManager = manager(store, firstHarness.adapters);

    await expect(firstManager.run(request)).resolves.toMatchObject({
      state: "RECOVERY_REQUIRED",
      phase: "STOP_INTENT",
    });

    const otherRequest: AtomicReleaseRequest = {
      ...clone(request),
      operationId: "rel_other_atomic_test",
      candidateId: "cand_other_atomic_test",
    };
    const otherHarness = createHarness();
    await expect(manager(store, otherHarness.adapters).run(otherRequest)).resolves.toMatchObject({
      state: "RECOVERY_REQUIRED",
      code: "ACTIVE_OPERATION_HELD",
    });
    expect(otherHarness.events).toEqual([]);

    await expect(firstManager.run(request)).resolves.toMatchObject({ state: "DEPLOYED" });
  });

  it("detects changing STOPPED to RUNNING because desired state is inside the sealed subject proof", async () => {
    const store = new MemoryJournalStore();
    store.crashAfterPhase = "SUPERVISORS_PAUSED";
    const harness = createHarness({
      previouslyRunningBridgeIds: [],
      previouslyStoppedBridgeIds: ["bridge_user_stopped"],
    });

    await expect(manager(store, harness.adapters).run(request)).rejects.toBeInstanceOf(
      SimulatedProcessKill,
    );
    const journal = store.records.get(request.operationId);
    if (!journal?.supervisorPauseReceipt?.subjects[0]) throw new Error("pause subject missing");
    journal.supervisorPauseReceipt.subjects[0].previousDesiredState = "RUNNING";
    store.crashAfterPhase = null;
    harness.events.length = 0;

    await expect(manager(store, harness.adapters).run(request)).resolves.toMatchObject({
      state: "BLOCKED",
      code: "JOURNAL_CORRUPT",
    });
    expect(harness.events).toEqual([]);
  });

  it("captures the final rollback snapshot only after the exact stop receipt and preserves a legal post-preflight write", async () => {
    const store = new MemoryJournalStore();
    const harness = createHarness({ legalWriteAfterPreflight: true, candidateHealthy: false });

    await expect(manager(store, harness.adapters).run(request)).resolves.toMatchObject({
      state: "ROLLED_BACK",
      identity: previousIdentity,
    });

    expect(harness.events.indexOf("createFinalRollbackSnapshot")).toBeGreaterThan(
      harness.events.indexOf("stopCurrentCooperatively"),
    );
    expect(harness.dataVersion()).toBe(2);
    expect(harness.events).toContain("restoreFinalRollbackSnapshot");
    expect(harness.events).not.toContain("restoreOnlinePreflightSnapshot");
  });

  it("requires the manifest hash as the fifth exact identity component before preflight", async () => {
    const store = new MemoryJournalStore();
    const harness = createHarness({
      candidateIdentity: { ...candidateIdentity, manifestSha256: "e".repeat(64) },
    });

    await expect(manager(store, harness.adapters).run(request)).resolves.toMatchObject({
      state: "BLOCKED",
      code: "CANDIDATE_IDENTITY_MISMATCH",
    });
    expect(harness.calls.get("createOnlinePreflightSnapshot") ?? 0).toBe(0);
  });

  it("keeps a lost cooperative-stop receipt at STOP_INTENT and cold-replays the same command", async () => {
    const store = new MemoryJournalStore();
    const harness = createHarness({ stopReceiptLostOnce: true });

    await expect(manager(store, harness.adapters).run(request)).resolves.toMatchObject({
      state: "RECOVERY_REQUIRED",
      code: "STOP_OUTCOME_AMBIGUOUS",
      phase: "STOP_INTENT",
    });
    expect(store.records.get(request.operationId)?.phase).toBe("STOP_INTENT");

    await expect(manager(store, harness.adapters).run(request)).resolves.toMatchObject({
      state: "DEPLOYED",
    });
    expect(harness.calls.get("stopCurrentCooperatively")).toBe(2);
    expect(new Set(harness.idempotencyKeys.get("stopCurrentCooperatively"))).toHaveLength(1);
  });

  it("keeps a lost final-snapshot receipt at FINAL_SNAPSHOT_INTENT and cold-replays it", async () => {
    const store = new MemoryJournalStore();
    const harness = createHarness({ finalSnapshotReceiptLostOnce: true });

    await expect(manager(store, harness.adapters).run(request)).resolves.toMatchObject({
      state: "RECOVERY_REQUIRED",
      code: "FINAL_SNAPSHOT_FAILED",
      phase: "FINAL_SNAPSHOT_INTENT",
    });
    expect(store.records.get(request.operationId)?.phase).toBe("FINAL_SNAPSHOT_INTENT");

    await expect(manager(store, harness.adapters).run(request)).resolves.toMatchObject({
      state: "DEPLOYED",
    });
    expect(harness.calls.get("createFinalRollbackSnapshot")).toBe(2);
    expect(new Set(harness.idempotencyKeys.get("createFinalRollbackSnapshot"))).toHaveLength(1);
  });

  it("does not mark maintenance committed when its receipt is lost", async () => {
    const store = new MemoryJournalStore();
    const harness = createHarness({ maintenanceCommitLostOnce: true });

    await expect(manager(store, harness.adapters).run(request)).resolves.toMatchObject({
      state: "RECOVERY_REQUIRED",
      code: "MAINTENANCE_COMMIT_AMBIGUOUS",
      phase: "COMMIT_MAINTENANCE_INTENT",
    });
    expect(store.records.get(request.operationId)?.phase).toBe("COMMIT_MAINTENANCE_INTENT");

    await expect(manager(store, harness.adapters).run(request)).resolves.toMatchObject({
      state: "DEPLOYED",
    });
    expect(harness.calls.get("commitMaintenance:CANDIDATE")).toBe(2);
  });

  it.each([
    ["probeCandidate", "CANDIDATE_PROBE_INTENT", "CANDIDATE_PROBE_FAILED"],
    ["createOnlinePreflightSnapshot", "PREFLIGHT_SNAPSHOT_INTENT", "PREFLIGHT_SNAPSHOT_FAILED"],
    ["enterHubMaintenance", "ENTER_MAINTENANCE_INTENT", "MAINTENANCE_ENTER_AMBIGUOUS"],
    ["pauseManagedBridgeSupervisors", "PAUSE_SUPERVISORS_INTENT", "SUPERVISOR_PAUSE_AMBIGUOUS"],
    ["stopCurrentCooperatively", "STOP_INTENT", "STOP_OUTCOME_AMBIGUOUS"],
    ["createFinalRollbackSnapshot", "FINAL_SNAPSHOT_INTENT", "FINAL_SNAPSHOT_FAILED"],
    ["atomicSwap", "SWAP_INTENT", "SWAP_OUTCOME_AMBIGUOUS"],
    [
      "startCandidateInMaintenance",
      "START_CANDIDATE_MAINTENANCE_INTENT",
      "CANDIDATE_MAINTENANCE_START_AMBIGUOUS",
    ],
    [
      "probeMaintenanceHealth:CANDIDATE",
      "VERIFY_CANDIDATE_MAINTENANCE_INTENT",
      "CANDIDATE_HEALTH_FAILED",
    ],
    ["migrateCandidateInMaintenance", "MIGRATE_CANDIDATE_INTENT", "CANDIDATE_MIGRATION_AMBIGUOUS"],
    ["commitMaintenance:CANDIDATE", "COMMIT_MAINTENANCE_INTENT", "MAINTENANCE_COMMIT_AMBIGUOUS"],
    [
      "resumePreviouslyRunningBridges:CANDIDATE",
      "RESUME_BRIDGES_INTENT",
      "BRIDGE_RESUME_AMBIGUOUS",
    ],
  ] as const)(
    "cold-replays a lost %s response with one stable command identity",
    async (adapterName, phase, code) => {
      const store = new MemoryJournalStore();
      const harness = createHarness({ ambiguousOnceAt: adapterName });

      await expect(manager(store, harness.adapters).run(request)).resolves.toMatchObject({
        state: "RECOVERY_REQUIRED",
        code,
        phase,
      });
      await expect(manager(store, harness.adapters).run(request)).resolves.toMatchObject({
        state: "DEPLOYED",
      });
      expect(harness.calls.get(adapterName)).toBe(2);
      expect(new Set(harness.idempotencyKeys.get(adapterName))).toHaveLength(1);
    },
  );

  it("keeps an unknown current observation recoverable before maintenance side effects", async () => {
    const store = new MemoryJournalStore();
    const harness = createHarness({ currentObservationUnknownOnce: true });

    await expect(manager(store, harness.adapters).run(request)).resolves.toMatchObject({
      state: "RECOVERY_REQUIRED",
      code: "CURRENT_OBSERVATION_FAILED",
      phase: "CURRENT_REVALIDATE_INTENT",
    });
    expect(harness.calls.get("enterHubMaintenance") ?? 0).toBe(0);
    await expect(manager(store, harness.adapters).run(request)).resolves.toMatchObject({
      state: "DEPLOYED",
    });
  });

  it("never allows a final manifest with a different stop receipt to reach swap", async () => {
    const store = new MemoryJournalStore();
    const harness = createHarness({ corruptFinalProof: true });

    await expect(manager(store, harness.adapters).run(request)).resolves.toMatchObject({
      state: "BLOCKED",
      code: "FINAL_SNAPSHOT_MANIFEST_INVALID",
    });
    expect(harness.calls.get("atomicSwap") ?? 0).toBe(0);
  });

  it("rolls back a rejected migration with the final snapshot and resumes only the prior running bridges", async () => {
    const store = new MemoryJournalStore();
    const harness = createHarness({ rejectMigration: true });

    await expect(manager(store, harness.adapters).run(request)).resolves.toMatchObject({
      state: "ROLLED_BACK",
      causeCode: "CANDIDATE_MIGRATION_FAILED",
    });
    expect(harness.events.slice(harness.events.indexOf("stopCandidate"))).toEqual([
      "stopCandidate",
      "observe",
      "restoreFinalRollbackSnapshot",
      "observe",
      "startPreviousInMaintenance",
      "probeMaintenanceHealth:PREVIOUS",
      "resumePreviouslyRunningBridges:PREVIOUS",
      "commitMaintenance:PREVIOUS",
    ]);
  });

  it.each([
    {
      name: "request fingerprint",
      mutate(journal: AtomicReleaseJournal) {
        journal.requestFingerprint = "f".repeat(64);
      },
    },
    {
      name: "candidate receipt",
      mutate(journal: AtomicReleaseJournal) {
        if (!journal.candidateProbe) throw new Error("candidate receipt missing");
        journal.candidateProbe.candidateId = "cand_wrong";
      },
    },
    {
      name: "preflight source",
      mutate(journal: AtomicReleaseJournal) {
        if (!journal.preflightSnapshot) throw new Error("preflight snapshot missing");
        const { manifestSha256: _manifestSha256, ...unsigned } = journal.preflightSnapshot;
        journal.preflightSnapshot = sealManifest({
          ...unsigned,
          sourceIdentity: candidateIdentity,
        });
      },
    },
    {
      name: "final stop proof",
      mutate(journal: AtomicReleaseJournal) {
        if (!journal.finalSnapshot) throw new Error("final snapshot missing");
        const { manifestSha256: _manifestSha256, ...unsigned } = journal.finalSnapshot;
        journal.finalSnapshot = sealManifest({
          ...unsigned,
          quiescenceProof: { ...unsigned.quiescenceProof, stopReceiptId: "stop_wrong" },
        });
      },
    },
    {
      name: "managed Bridge subject proof",
      mutate(journal: AtomicReleaseJournal) {
        if (!journal.supervisorPauseReceipt?.subjects[0]) {
          throw new Error("pause subject proof missing");
        }
        journal.supervisorPauseReceipt.subjects[0].subjectProof.runId = "run_forged";
      },
    },
    {
      name: "phase receipt set",
      mutate(journal: AtomicReleaseJournal) {
        journal.finalSnapshot = null;
      },
    },
  ])("rejects a journal with a wrong $name before any Adapter side effect", async ({ mutate }) => {
    const store = new MemoryJournalStore();
    const journal = await completedJournal();
    mutate(journal);
    store.records.set(request.operationId, journal);
    const harness = createHarness();

    await expect(manager(store, harness.adapters).run(request)).resolves.toMatchObject({
      state: "BLOCKED",
      code: "JOURNAL_CORRUPT",
    });
    expect(harness.events).toEqual([]);
  });

  it("honors the store-wide active operation lease before loading a journal or calling an Adapter", async () => {
    const leaseStore = new MemoryJournalStore();
    const firstLease = await leaseStore.acquireActiveLease({
      leaseKey: "atomic-release/global",
      operationId: "rel_lease_first",
      requestFingerprint: "a".repeat(64),
      ownerId: "owner_first",
      expiresAt: "2026-08-01T00:05:00.000Z",
    });
    if (firstLease.state !== "ACQUIRED") throw new Error("fixture lease was unexpectedly held");
    expect(firstLease.claim.generation).toBe(1);

    const renewed = await leaseStore.renewActiveLease(firstLease.claim, "2026-08-01T00:10:00.000Z");
    if (renewed.state !== "RENEWED") throw new Error("fixture lease was unexpectedly lost");
    expect(renewed).toEqual({
      state: "RENEWED",
      claim: { ...firstLease.claim, expiresAt: "2026-08-01T00:10:00.000Z" },
    });
    expect(
      await leaseStore.releaseActiveLease(firstLease.claim, {
        operationId: firstLease.claim.operationId,
        requestFingerprint: firstLease.claim.requestFingerprint,
        terminalPhase: "COMPLETED",
        journalRevision: 1,
      }),
    ).toBe(false);
    expect(leaseStore.activeLease).toEqual(renewed.claim);

    leaseStore.activeLease = { ...renewed.claim, expiresAt: "2026-07-31T23:59:59.000Z" };
    const replacement = await leaseStore.acquireActiveLease({
      leaseKey: "atomic-release/global",
      operationId: "rel_lease_replacement",
      requestFingerprint: "b".repeat(64),
      ownerId: "owner_replacement",
      expiresAt: "2026-08-01T00:05:00.000Z",
    });
    if (replacement.state !== "ACQUIRED") throw new Error("expired fixture lease was not replaced");
    expect(replacement.claim.generation).toBe(2);
    await expect(
      leaseStore.renewActiveLease(firstLease.claim, "2026-08-01T00:15:00.000Z"),
    ).resolves.toEqual({ state: "LOST" });

    const store = new MemoryJournalStore();
    store.activeLease = {
      leaseKey: "atomic-release/global",
      operationId: "rel_other_operation",
      requestFingerprint: "e".repeat(64),
      ownerId: "owner_other",
      expiresAt: "2026-08-02T00:00:00.000Z",
      generation: 1,
    };
    const harness = createHarness();

    await expect(manager(store, harness.adapters).run(request)).resolves.toMatchObject({
      state: "RECOVERY_REQUIRED",
      code: "ACTIVE_OPERATION_HELD",
    });
    expect(store.records.size).toBe(0);
    expect(harness.events).toEqual([]);
  });

  it("fails closed before any Adapter effect when renewal returns a stale expiry", async () => {
    class StaleRenewStore extends MemoryJournalStore {
      override async renewActiveLease(
        claim: AtomicReleaseActiveLeaseClaim,
        nextExpiresAt: string,
      ): Promise<{ state: "RENEWED"; claim: AtomicReleaseActiveLeaseClaim } | { state: "LOST" }> {
        const renewed = await super.renewActiveLease(claim, nextExpiresAt);
        return renewed.state === "RENEWED"
          ? {
              state: "RENEWED",
              claim: { ...renewed.claim, expiresAt: "2026-07-31T23:59:59.999Z" },
            }
          : renewed;
      }
    }
    const store = new StaleRenewStore();
    const harness = createHarness();

    await expect(manager(store, harness.adapters).run(request)).resolves.toMatchObject({
      state: "RECOVERY_REQUIRED",
      code: "ACTIVE_OPERATION_LEASE_LOST",
      phase: "CANDIDATE_PROBE_INTENT",
    });
    expect(harness.events).toEqual([]);
  });

  it("never persists an Adapter exception or credential-shaped text", async () => {
    const store = new MemoryJournalStore();
    const harness = createHarness({ throwPreflightError: true });

    await expect(manager(store, harness.adapters).run(request)).resolves.toMatchObject({
      state: "RECOVERY_REQUIRED",
      code: "PREFLIGHT_SNAPSHOT_FAILED",
      phase: "PREFLIGHT_SNAPSHOT_INTENT",
    });
    const serialized = JSON.stringify(store.records.get(request.operationId));
    expect(serialized).not.toContain(secretCanary);
    expect(serialized.toLowerCase()).not.toContain("token");
  });

  const deployPhases: AtomicReleaseJournalPhase[] = [
    "CANDIDATE_PROBE_INTENT",
    "CANDIDATE_VALIDATED",
    "PREFLIGHT_SNAPSHOT_INTENT",
    "PREFLIGHT_SNAPSHOT_READY",
    "CURRENT_REVALIDATE_INTENT",
    "CURRENT_REVALIDATED",
    "ENTER_MAINTENANCE_INTENT",
    "MAINTENANCE_ENTERED",
    "PAUSE_SUPERVISORS_INTENT",
    "SUPERVISORS_PAUSED",
    "STOP_INTENT",
    "STOP_RECEIPT_CONFIRMED",
    "STOPPED",
    "FINAL_SNAPSHOT_INTENT",
    "FINAL_SNAPSHOT_READY",
    "SWAP_INTENT",
    "SWAPPED",
    "START_CANDIDATE_MAINTENANCE_INTENT",
    "CANDIDATE_MAINTENANCE_STARTED",
    "VERIFY_CANDIDATE_MAINTENANCE_INTENT",
    "CANDIDATE_MAINTENANCE_HEALTHY",
    "MIGRATE_CANDIDATE_INTENT",
    "CANDIDATE_MIGRATED",
    "COMMIT_MAINTENANCE_INTENT",
    "MAINTENANCE_COMMITTED",
    "RESUME_BRIDGES_INTENT",
    "BRIDGES_RESUMED",
    "COMPLETED",
  ];

  it.each(deployPhases)("cold-restarts idempotently after a kill at %s", async (phase) => {
    const store = new MemoryJournalStore();
    store.crashAfterPhase = phase;
    const harness = createHarness();

    await expect(manager(store, harness.adapters).run(request)).rejects.toBeInstanceOf(
      SimulatedProcessKill,
    );
    await expect(manager(store, harness.adapters).run(request)).resolves.toMatchObject({
      state: "DEPLOYED",
      identity: candidateIdentity,
    });
  });

  const rollbackPhases: AtomicReleaseJournalPhase[] = [
    "ROLLBACK_STOP_CANDIDATE_INTENT",
    "ROLLBACK_RESTORE_INTENT",
    "ROLLBACK_START_PREVIOUS_MAINTENANCE_INTENT",
    "ROLLBACK_PREVIOUS_STARTED",
    "ROLLBACK_VERIFY_PREVIOUS_INTENT",
    "ROLLBACK_PREVIOUS_HEALTHY",
    "ROLLBACK_COMMIT_MAINTENANCE_INTENT",
    "ROLLBACK_MAINTENANCE_COMMITTED",
    "ROLLBACK_RESUME_BRIDGES_INTENT",
    "ROLLED_BACK",
  ];

  it.each(rollbackPhases)(
    "cold-restarts a final-snapshot rollback idempotently after a kill at %s",
    async (phase) => {
      const store = new MemoryJournalStore();
      store.crashAfterPhase = phase;
      const harness = createHarness({ rejectMigration: true });

      await expect(manager(store, harness.adapters).run(request)).rejects.toBeInstanceOf(
        SimulatedProcessKill,
      );
      await expect(manager(store, harness.adapters).run(request)).resolves.toMatchObject({
        state: "ROLLED_BACK",
        identity: previousIdentity,
        causeCode: "CANDIDATE_MIGRATION_FAILED",
      });
    },
  );

  it.each([
    ["stopCandidate", "ROLLBACK_STOP_CANDIDATE_INTENT", "ROLLBACK_CANDIDATE_STOP_AMBIGUOUS"],
    ["restoreFinalRollbackSnapshot", "ROLLBACK_RESTORE_INTENT", "ROLLBACK_RESTORE_AMBIGUOUS"],
    [
      "startPreviousInMaintenance",
      "ROLLBACK_START_PREVIOUS_MAINTENANCE_INTENT",
      "ROLLBACK_PREVIOUS_START_AMBIGUOUS",
    ],
    [
      "probeMaintenanceHealth:PREVIOUS",
      "ROLLBACK_VERIFY_PREVIOUS_INTENT",
      "ROLLBACK_PREVIOUS_HEALTH_AMBIGUOUS",
    ],
    [
      "commitMaintenance:PREVIOUS",
      "ROLLBACK_COMMIT_MAINTENANCE_INTENT",
      "ROLLBACK_MAINTENANCE_COMMIT_AMBIGUOUS",
    ],
    [
      "resumePreviouslyRunningBridges:PREVIOUS",
      "ROLLBACK_RESUME_BRIDGES_INTENT",
      "ROLLBACK_BRIDGE_RESUME_AMBIGUOUS",
    ],
  ] as const)(
    "cold-replays a lost rollback %s response with one stable command identity",
    async (adapterName, phase, code) => {
      const store = new MemoryJournalStore();
      const harness = createHarness({ rejectMigration: true, ambiguousOnceAt: adapterName });

      await expect(manager(store, harness.adapters).run(request)).resolves.toMatchObject({
        state: "RECOVERY_REQUIRED",
        code,
        phase,
      });
      await expect(manager(store, harness.adapters).run(request)).resolves.toMatchObject({
        state: "ROLLED_BACK",
        identity: previousIdentity,
      });
      expect(harness.calls.get(adapterName)).toBe(2);
      expect(new Set(harness.idempotencyKeys.get(adapterName))).toHaveLength(1);
    },
  );
});
