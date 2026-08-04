import { createHash, randomUUID } from "node:crypto";

import type {
  FinalRollbackSnapshotManifest,
  OnlinePreflightSnapshotManifest,
  QuiescenceProof,
} from "./release-snapshot.js";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OPERATION_ID_PATTERN = /^rel_[A-Za-z0-9_-]{1,120}$/;
const CANDIDATE_ID_PATTERN = /^cand_[A-Za-z0-9_-]{1,120}$/;
const SNAPSHOT_ID_PATTERN = /^snap_[A-Za-z0-9_-]{1,120}$/;
const RECEIPT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const LOGICAL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,239}$/;
const SAFE_ADAPTER_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,95}$/;
const EXCLUDED_RESTORE_CATEGORIES = [
  "VAULT",
  "CHECKPOINT",
  "SPOOL",
  "LOG",
  "ARTIFACT_PAYLOAD",
  "PID",
] as const;
const FORBIDDEN_LOGICAL_SEGMENTS = new Set([
  "vault",
  "checkpoint",
  "checkpoints",
  "spool",
  "spools",
  "log",
  "logs",
  "artifact",
  "artifacts",
  "pid",
  "pids",
]);
const CREDENTIAL_BASENAMES = new Set([
  "token",
  "dashboard-token",
  "agent-codex-token",
  "agent-claude-token",
  "capture-codex-token",
  "capture-claude-token",
  "inject-codex-token",
  "inject-claude-token",
]);

export type ReleaseIdentity = {
  buildId: string;
  buildSessionId: string;
  protocolId: string;
  manifestSha256: string;
  migrationId: string;
};

export type CandidateProbeReceipt = {
  candidateId: string;
  probeId: string;
  isolation: "BACKUP_COPY";
  requestedPort: 0;
  boundAddress: "127.0.0.1" | "::1";
  boundPort: number;
  runtimeInstanceId: string;
  backupDatabaseIdentitySha256: string;
  healthy: true;
  identity: ReleaseIdentity;
  probedAt: string;
};

export type SecurityStateReceipt = {
  schemaVersion: 1;
  securityEpoch: number;
  securityEventSequence: number;
  securityStateSha256: string;
  externalJournalSha256: string;
  observedAt: string;
};

export type SnapshotDatabaseReceipt = {
  schemaVersion: 1;
  adapterKind: "SQLITE_BACKUP_API";
  sourceDatabaseIdentitySha256: string;
  sourcePageCount: number;
  sourceWalCommitSequence: number;
  backupSha256: string;
  sourceQuickCheck: "ok";
  backupQuickCheck: "ok";
  capturedAt: string;
};

export type CurrentObservationReceipt = {
  sourceIdentity: ReleaseIdentity;
  runtimeId: string;
  hubInstanceId: string;
  boundAddress: "127.0.0.1" | "::1";
  boundPort: number;
  mode: "NORMAL";
  observedAt: string;
};

export type HubMaintenanceReceipt = {
  maintenanceId: string;
  scope: "HUB_WIDE";
  mode: "MAINTENANCE";
  fenceId: string;
  sourceIdentity: ReleaseIdentity;
  sourceRuntimeId: string;
  sourceHubInstanceId: string;
  releasePointerRevision: number;
  securityState: SecurityStateReceipt;
  enteredAt: string;
};

export type ManagedBridgeSubjectProof = {
  schemaVersion: 1;
  subjectRevision: number;
  projectId: string;
  originalThreadId: string;
  agentId: "codex";
  runId: string;
  sessionId: string;
  lineageId: string;
  incarnation: number;
  bundleId: string;
  build: ReleaseIdentity;
  vaultSha256: string;
  checkpointSha256: string;
  checkpointEventSequence: number;
  fuseGeneration: number;
};

export type PausedManagedBridgeSubject = {
  previousDesiredState: "RUNNING" | "STOPPED";
  subjectProof: ManagedBridgeSubjectProof;
  subjectProofSha256: string;
};

export type SupervisorPauseReceipt = {
  schemaVersion: 1;
  operationId: string;
  maintenanceId: string;
  fenceId: string;
  pauseReceiptId: string;
  atomicJournalRevision: number;
  releasePointerRevision: number;
  supervisorJournalRevision: number;
  subjects: PausedManagedBridgeSubject[];
  pausedAt: string;
  receiptSha256: string;
};

export type CooperativeStopReceipt = {
  maintenanceId: string;
  fenceId: string;
  stopReceiptId: string;
  sourceIdentity: ReleaseIdentity;
  sourceRuntimeId: string;
  sourceHubInstanceId: string;
  runtimeState: "STOPPED";
  stoppedAt: string;
};

export type MaintenanceRuntimeReceipt = {
  maintenanceId: string;
  runtimeId: string;
  hubInstanceId: string;
  boundAddress: "127.0.0.1" | "::1";
  boundPort: number;
  identity: ReleaseIdentity;
  mode: "MAINTENANCE";
  startedAt: string;
};

export type MaintenanceHealthReceipt = {
  maintenanceId: string;
  target: "CANDIDATE" | "PREVIOUS";
  identity: ReleaseIdentity;
  runtimeId: string;
  hubInstanceId: string;
  boundAddress: "127.0.0.1" | "::1";
  boundPort: number;
  mode: "MAINTENANCE";
  checkedAt: string;
};

export type CandidateMigrationReceipt = {
  maintenanceId: string;
  identity: ReleaseIdentity;
  migrationId: string;
  migratedAt: string;
};

export type MaintenanceCommitReceipt = {
  maintenanceId: string;
  target: "CANDIDATE" | "PREVIOUS";
  identity: ReleaseIdentity;
  atomicJournalRevision: number;
  releasePointerRevision: number;
  committedAt: string;
};

export type AtomicSwapReceipt = {
  schemaVersion: 1;
  operationId: string;
  previousPointerRevision: number;
  pointerRevision: number;
  sourceIdentity: ReleaseIdentity;
  candidateIdentity: ReleaseIdentity;
  installedIdentity: ReleaseIdentity;
  replaceStrategy: "WINDOWS_REPLACE_FILE" | "GENERATION_SLOTS";
  replaceGeneration: number;
  previousArtifactSha256: string;
  candidateArtifactSha256: string;
  installedArtifactSha256: string;
  durability: "REPLACED_AND_DIRECTORY_SYNCED";
  swappedAt: string;
};

export type FinalSnapshotSecurityReceipt = SecurityStateReceipt & {
  snapshotId: string;
};

export type FinalRestoreReceipt = {
  schemaVersion: 1;
  operationId: string;
  snapshotId: string;
  adapterKind: "SQLITE_BACKUP_API";
  sourceDatabaseIdentitySha256: string;
  restoredDatabaseSha256: string;
  restoredPageCount: number;
  restoredQuickCheck: "ok";
  staleWalDisposition: "ISOLATED_AND_CLEARED";
  previousPointerRevision: number;
  pointerRevision: number;
  restoredIdentity: ReleaseIdentity;
  snapshotSecurityEpoch: number;
  observedSecurityEpochBeforeRestore: number;
  reconciledSecurityEpoch: number;
  replayedThroughSecurityEventSequence: number;
  reconciledSecurityStateSha256: string;
  externalJournalSha256: string;
  credentialState: "FORWARD_RECONCILED";
  sessionTicketState: "FORWARD_RECONCILED";
  authorityState: "FORWARD_RECONCILED";
  restoredAt: string;
};

export type ReleaseTransitionAuthorization = {
  schemaVersion: 1;
  authorizationId: string;
  operationId: string;
  requestFingerprint: string;
  authorizedOutcome: "DEPLOYED" | "ROLLED_BACK";
  atomicJournalRevision: number;
  pointerRevision: number;
  supervisorJournalRevision: number;
  pauseReceiptId: string;
  sourceIdentity: ReleaseIdentity;
  candidateIdentity: ReleaseIdentity;
  installedIdentity: ReleaseIdentity;
  pauseReceiptSha256: string;
  issuedAt: string;
  authorizationSha256: string;
};

export type ManagedBridgeReleaseEffectReceipt = {
  schemaVersion: 1;
  effectReceiptId: string;
  authorizationId: string;
  authorizationSha256: string;
  operationId: string;
  effect: "REBOUND" | "ROLLED_BACK" | "ALREADY_STOPPED";
  supervisorJournalRevision: number;
  previousDesiredState: "RUNNING" | "STOPPED";
  subjectProof: ManagedBridgeSubjectProof;
  sealedSubjectProofSha256: string;
  installedIdentity: ReleaseIdentity;
  effectedAt: string;
  effectReceiptSha256: string;
};

/** @deprecated Runtime compatibility only. AtomicReleaseManager never accepts this shape. */
export type ManagedBridgeReleaseTransitionReceipt = {
  schemaVersion: 1;
  operationId: string;
  terminalPhase: "COMPLETED" | "ROLLED_BACK";
  atomicJournalRevision: number;
  pointerRevision: number;
  supervisorJournalRevision: number;
  pauseReceiptId: string;
  previousDesiredState: "RUNNING" | "STOPPED";
  resumeState: "RESUMED" | "ALREADY_STOPPED";
  subjectProof: ManagedBridgeSubjectProof;
  subjectProofSha256: string;
  sourceIdentity: ReleaseIdentity;
  candidateIdentity: ReleaseIdentity;
  installedIdentity: ReleaseIdentity;
};

export type BridgeResumeReceipt = {
  maintenanceId: string;
  target: "CANDIDATE" | "PREVIOUS";
  authorizationId: string;
  authorizationSha256: string;
  effects: ManagedBridgeReleaseEffectReceipt[];
  resumedAt: string;
};

export type PreSwapCleanupReceipt = {
  schemaVersion: 1;
  operationId: string;
  maintenanceId: string;
  failedPhase: AtomicReleaseJournalPhase;
  sourceIdentity: ReleaseIdentity;
  runtimeId: string;
  hubInstanceId: string;
  mode: "NORMAL";
  pauseReceiptId: string | null;
  releasePointerRevision: number;
  securityEpoch: number;
  securityStateSha256: string;
  cleanedAt: string;
};

export type DeploymentObservation = {
  observedAt: string;
  installed: { state: "KNOWN"; identity: ReleaseIdentity } | { state: "UNKNOWN" };
  runtime:
    | {
        state: "RUNNING";
        identity: ReleaseIdentity;
        runtimeId: string;
        hubInstanceId: string;
        boundAddress: "127.0.0.1" | "::1";
        boundPort: number;
        mode: "NORMAL" | "MAINTENANCE";
      }
    | { state: "STOPPED" }
    | { state: "UNKNOWN" };
};

export type AtomicReleaseJournalPhase =
  | "CANDIDATE_PROBE_INTENT"
  | "CANDIDATE_VALIDATED"
  | "PREFLIGHT_SNAPSHOT_INTENT"
  | "PREFLIGHT_SNAPSHOT_READY"
  | "CURRENT_REVALIDATE_INTENT"
  | "CURRENT_REVALIDATED"
  | "ENTER_MAINTENANCE_INTENT"
  | "MAINTENANCE_ENTERED"
  | "PAUSE_SUPERVISORS_INTENT"
  | "SUPERVISORS_PAUSED"
  | "STOP_INTENT"
  | "STOP_RECEIPT_CONFIRMED"
  | "STOPPED"
  | "FINAL_SNAPSHOT_INTENT"
  | "FINAL_SNAPSHOT_READY"
  | "SWAP_INTENT"
  | "SWAPPED"
  | "START_CANDIDATE_MAINTENANCE_INTENT"
  | "CANDIDATE_MAINTENANCE_STARTED"
  | "VERIFY_CANDIDATE_MAINTENANCE_INTENT"
  | "CANDIDATE_MAINTENANCE_HEALTHY"
  | "MIGRATE_CANDIDATE_INTENT"
  | "CANDIDATE_MIGRATED"
  | "AUTHORIZE_BRIDGES_INTENT"
  | "BRIDGE_TRANSITION_AUTHORIZED"
  | "RESUME_BRIDGES_INTENT"
  | "BRIDGES_RESUMED"
  | "COMMIT_MAINTENANCE_INTENT"
  | "MAINTENANCE_COMMITTED"
  | "ROLLBACK_STOP_CANDIDATE_INTENT"
  | "ROLLBACK_RESTORE_INTENT"
  | "ROLLBACK_START_PREVIOUS_MAINTENANCE_INTENT"
  | "ROLLBACK_PREVIOUS_STARTED"
  | "ROLLBACK_VERIFY_PREVIOUS_INTENT"
  | "ROLLBACK_PREVIOUS_HEALTHY"
  | "ROLLBACK_AUTHORIZE_BRIDGES_INTENT"
  | "ROLLBACK_BRIDGE_TRANSITION_AUTHORIZED"
  | "ROLLBACK_RESUME_BRIDGES_INTENT"
  | "ROLLBACK_BRIDGES_RESUMED"
  | "ROLLBACK_COMMIT_MAINTENANCE_INTENT"
  | "ROLLBACK_MAINTENANCE_COMMITTED"
  | "PRE_SWAP_CLEANUP_INTENT"
  | "PRE_SWAP_CLEANUP_CONFIRMED"
  | "COMPLETED"
  | "ROLLED_BACK"
  | "BLOCKED"
  | "ROLLBACK_FAILED";

export type AtomicReleaseFailureCode =
  | "REQUEST_INVALID"
  | "REQUEST_CONFLICT"
  | "JOURNAL_CORRUPT"
  | "CANDIDATE_PROBE_FAILED"
  | "CANDIDATE_IDENTITY_MISMATCH"
  | "PREFLIGHT_SNAPSHOT_FAILED"
  | "PREFLIGHT_SNAPSHOT_MANIFEST_INVALID"
  | "CURRENT_OBSERVATION_FAILED"
  | "CURRENT_IDENTITY_CHANGED"
  | "MAINTENANCE_ENTER_FAILED"
  | "MAINTENANCE_ENTER_AMBIGUOUS"
  | "SUPERVISOR_PAUSE_FAILED"
  | "SUPERVISOR_PAUSE_AMBIGUOUS"
  | "STOP_FAILED"
  | "STOP_OUTCOME_AMBIGUOUS"
  | "FINAL_SNAPSHOT_FAILED"
  | "FINAL_SNAPSHOT_MANIFEST_INVALID"
  | "SWAP_FAILED"
  | "SWAP_OUTCOME_AMBIGUOUS"
  | "CANDIDATE_MAINTENANCE_START_FAILED"
  | "CANDIDATE_MAINTENANCE_START_AMBIGUOUS"
  | "CANDIDATE_HEALTH_FAILED"
  | "CANDIDATE_MIGRATION_FAILED"
  | "CANDIDATE_MIGRATION_AMBIGUOUS"
  | "MAINTENANCE_COMMIT_FAILED"
  | "MAINTENANCE_COMMIT_AMBIGUOUS"
  | "BRIDGE_RESUME_FAILED"
  | "BRIDGE_RESUME_AMBIGUOUS"
  | "ROLLBACK_CANDIDATE_STOP_FAILED"
  | "ROLLBACK_CANDIDATE_STOP_AMBIGUOUS"
  | "ROLLBACK_RESTORE_FAILED"
  | "ROLLBACK_RESTORE_AMBIGUOUS"
  | "ROLLBACK_PREVIOUS_START_FAILED"
  | "ROLLBACK_PREVIOUS_START_AMBIGUOUS"
  | "ROLLBACK_PREVIOUS_HEALTH_FAILED"
  | "ROLLBACK_PREVIOUS_HEALTH_AMBIGUOUS"
  | "ROLLBACK_MAINTENANCE_COMMIT_FAILED"
  | "ROLLBACK_MAINTENANCE_COMMIT_AMBIGUOUS"
  | "ROLLBACK_BRIDGE_RESUME_FAILED"
  | "ROLLBACK_BRIDGE_RESUME_AMBIGUOUS"
  | "PRE_SWAP_CLEANUP_FAILED"
  | "PRE_SWAP_CLEANUP_AMBIGUOUS"
  | "ADAPTER_RESULT_INVALID"
  | "ACTIVE_OPERATION_HELD"
  | "ACTIVE_OPERATION_LEASE_UNAVAILABLE"
  | "ACTIVE_OPERATION_LEASE_LOST";

export type AtomicReleaseJournal = {
  schemaVersion: 3;
  operationId: string;
  requestFingerprint: string;
  candidateId: string;
  expectedCurrent: ReleaseIdentity;
  expectedCandidate: ReleaseIdentity;
  revision: number;
  phase: AtomicReleaseJournalPhase;
  candidateProbe: CandidateProbeReceipt | null;
  preflightSnapshot: OnlinePreflightSnapshotManifest | null;
  preflightDatabaseReceipt: SnapshotDatabaseReceipt | null;
  currentObservationReceipt: CurrentObservationReceipt | null;
  maintenanceReceipt: HubMaintenanceReceipt | null;
  supervisorPauseReceipt: SupervisorPauseReceipt | null;
  stopReceipt: CooperativeStopReceipt | null;
  finalSnapshot: FinalRollbackSnapshotManifest | null;
  finalDatabaseReceipt: SnapshotDatabaseReceipt | null;
  finalSnapshotSecurityReceipt: FinalSnapshotSecurityReceipt | null;
  swapReceipt: AtomicSwapReceipt | null;
  candidateStartReceipt: MaintenanceRuntimeReceipt | null;
  candidateHealthReceipt: MaintenanceHealthReceipt | null;
  candidateMigrationReceipt: CandidateMigrationReceipt | null;
  transitionAuthorization: ReleaseTransitionAuthorization | null;
  bridgeResumeReceipt: BridgeResumeReceipt | null;
  maintenanceCommitReceipt: MaintenanceCommitReceipt | null;
  restoreReceipt: FinalRestoreReceipt | null;
  previousStartReceipt: MaintenanceRuntimeReceipt | null;
  previousHealthReceipt: MaintenanceHealthReceipt | null;
  rollbackTransitionAuthorization: ReleaseTransitionAuthorization | null;
  rollbackResumeReceipt: BridgeResumeReceipt | null;
  rollbackCommitReceipt: MaintenanceCommitReceipt | null;
  preSwapCleanupReceipt: PreSwapCleanupReceipt | null;
  cleanupCauseCode: AtomicReleaseFailureCode | null;
  cleanupFailedAtPhase: AtomicReleaseJournalPhase | null;
  rollbackCauseCode: AtomicReleaseFailureCode | null;
  terminalCode: AtomicReleaseFailureCode | null;
  failedAtPhase: AtomicReleaseJournalPhase | null;
  updatedAt: string;
};

export interface AtomicReleaseJournalStore {
  load(operationId: string): Promise<AtomicReleaseJournal | null>;
  compareAndSwap(
    operationId: string,
    expectedRevision: number | null,
    next: AtomicReleaseJournal,
    lease: AtomicReleaseActiveLeaseClaim,
  ): Promise<boolean>;
  acquireActiveLease(
    request: AtomicReleaseActiveLeaseRequest,
  ): Promise<{ state: "ACQUIRED"; claim: AtomicReleaseActiveLeaseClaim } | { state: "HELD" }>;
  renewActiveLease(
    claim: AtomicReleaseActiveLeaseClaim,
    nextExpiresAt: string,
  ): Promise<{ state: "RENEWED"; claim: AtomicReleaseActiveLeaseClaim } | { state: "LOST" }>;
  releaseActiveLease(
    claim: AtomicReleaseActiveLeaseClaim,
    terminal: AtomicReleaseTerminalLeaseProof,
  ): Promise<boolean>;
}

export type AtomicReleaseActiveLeaseRequest = {
  leaseKey: "atomic-release/global";
  operationId: string;
  requestFingerprint: string;
  ownerId: string;
  expiresAt: string;
};

export type AtomicReleaseActiveLeaseClaim = AtomicReleaseActiveLeaseRequest & {
  generation: number;
};

export type AtomicReleaseTerminalLeaseProof = {
  operationId: string;
  requestFingerprint: string;
  terminalPhase: "COMPLETED" | "ROLLED_BACK" | "BLOCKED" | "ROLLBACK_FAILED";
  journalRevision: number;
};

export type AtomicReleaseRequest = {
  operationId: string;
  candidateId: string;
  expectedCurrent: ReleaseIdentity;
  expectedCandidate: ReleaseIdentity;
};

type IntentInput = {
  operationId: string;
  idempotencyKey: string;
  activeLease: AtomicReleaseActiveLeaseClaim;
};
type MutationResult<T = undefined> =
  | (T extends undefined ? { state: "CONFIRMED" } : { state: "CONFIRMED"; receipt: T })
  | { state: "AMBIGUOUS"; code: string }
  | { state: "REJECTED"; code: string };
type SnapshotResult<T, R> =
  | { state: "CONFIRMED"; manifest: T; receipt: R }
  | { state: "AMBIGUOUS"; code: string }
  | { state: "REJECTED"; code: string };
type HealthResult =
  | { state: "HEALTHY"; receipt: MaintenanceHealthReceipt }
  | { state: "UNHEALTHY"; code: string }
  | { state: "AMBIGUOUS"; code: string };

export interface AtomicReleaseAdapters {
  probeCandidate(
    input: IntentInput & {
      candidateId: string;
      expectedIdentity: ReleaseIdentity;
      isolation: "BACKUP_COPY";
      port: 0;
    },
  ): Promise<MutationResult<CandidateProbeReceipt>>;
  createOnlinePreflightSnapshot(
    input: IntentInput & { expectedCurrent: ReleaseIdentity },
  ): Promise<SnapshotResult<OnlinePreflightSnapshotManifest, SnapshotDatabaseReceipt>>;
  observe(input: {
    operationId: string;
    activeLease: AtomicReleaseActiveLeaseClaim;
  }): Promise<DeploymentObservation>;
  enterHubMaintenance(
    input: IntentInput & {
      expectedCurrent: ReleaseIdentity;
      expectedRuntimeId: string;
      expectedHubInstanceId: string;
      scope: "HUB_WIDE";
    },
  ): Promise<MutationResult<HubMaintenanceReceipt>>;
  pauseManagedBridgeSupervisors(
    input: IntentInput & {
      maintenanceId: string;
      fenceId: string;
      atomicJournalRevision: number;
    },
  ): Promise<MutationResult<SupervisorPauseReceipt>>;
  stopCurrentCooperatively(
    input: IntentInput & {
      maintenanceId: string;
      fenceId: string;
      expectedIdentity: ReleaseIdentity;
      expectedRuntimeId: string;
      expectedHubInstanceId: string;
    },
  ): Promise<MutationResult<CooperativeStopReceipt>>;
  createFinalRollbackSnapshot(
    input: IntentInput & {
      expectedCurrent: ReleaseIdentity;
      expectedCandidate: ReleaseIdentity;
      quiescenceProof: QuiescenceProof;
    },
  ): Promise<
    SnapshotResult<
      FinalRollbackSnapshotManifest,
      { database: SnapshotDatabaseReceipt; security: FinalSnapshotSecurityReceipt }
    >
  >;
  atomicSwap(
    input: IntentInput & {
      candidateId: string;
      expectedCurrent: ReleaseIdentity;
      expectedCandidate: ReleaseIdentity;
      expectedPointerRevision: number;
      finalSnapshot: FinalRollbackSnapshotManifest;
    },
  ): Promise<MutationResult<AtomicSwapReceipt>>;
  startCandidateInMaintenance(
    input: IntentInput & { maintenanceId: string; expectedIdentity: ReleaseIdentity },
  ): Promise<MutationResult<MaintenanceRuntimeReceipt>>;
  probeMaintenanceHealth(
    input: IntentInput & {
      maintenanceId: string;
      target: "CANDIDATE" | "PREVIOUS";
      expectedIdentity: ReleaseIdentity;
      expectedBoundAddress: "127.0.0.1" | "::1";
      expectedBoundPort: number;
      expectedRuntimeId: string;
      expectedHubInstanceId: string;
    },
  ): Promise<HealthResult>;
  migrateCandidateInMaintenance(
    input: IntentInput & { maintenanceId: string; expectedIdentity: ReleaseIdentity },
  ): Promise<MutationResult<CandidateMigrationReceipt>>;
  commitMaintenance(
    input: IntentInput & {
      maintenanceId: string;
      target: "CANDIDATE" | "PREVIOUS";
      expectedIdentity: ReleaseIdentity;
      atomicJournalRevision: number;
      expectedPointerRevision: number;
    },
  ): Promise<MutationResult<MaintenanceCommitReceipt>>;
  resumePreviouslyRunningBridges(
    input: IntentInput & {
      transitionAuthorizationId: string;
      expectedAuthorizationSha256: string;
    },
  ): Promise<MutationResult<BridgeResumeReceipt>>;
  stopCandidate(
    input: IntentInput & { maintenanceId: string; expectedIdentity: ReleaseIdentity },
  ): Promise<MutationResult>;
  restoreFinalRollbackSnapshot(
    input: IntentInput & {
      maintenanceId: string;
      finalSnapshot: FinalRollbackSnapshotManifest;
      expectedIdentity: ReleaseIdentity;
      expectedPointerRevision: number;
      snapshotDatabaseReceipt: SnapshotDatabaseReceipt;
      snapshotSecurityReceipt: FinalSnapshotSecurityReceipt;
    },
  ): Promise<MutationResult<FinalRestoreReceipt>>;
  startPreviousInMaintenance(
    input: IntentInput & {
      maintenanceId: string;
      finalSnapshot: FinalRollbackSnapshotManifest;
      expectedIdentity: ReleaseIdentity;
    },
  ): Promise<MutationResult<MaintenanceRuntimeReceipt>>;
  cleanupPreSwapMaintenance(
    input: IntentInput & {
      maintenanceReceipt: HubMaintenanceReceipt;
      pauseReceipt: SupervisorPauseReceipt | null;
      stopReceipt: CooperativeStopReceipt | null;
      finalSnapshot: FinalRollbackSnapshotManifest | null;
      failedPhase: AtomicReleaseJournalPhase;
      expectedCurrent: ReleaseIdentity;
      expectedPointerRevision: number;
    },
  ): Promise<MutationResult<PreSwapCleanupReceipt>>;
}

export type AtomicReleaseOutcome =
  | { state: "DEPLOYED"; operationId: string; identity: ReleaseIdentity }
  | {
      state: "ROLLED_BACK";
      operationId: string;
      identity: ReleaseIdentity;
      causeCode: AtomicReleaseFailureCode;
    }
  | {
      state: "BLOCKED";
      operationId: string;
      code: AtomicReleaseFailureCode;
      phase: AtomicReleaseJournalPhase;
    }
  | {
      state: "ROLLBACK_FAILED";
      operationId: string;
      code: AtomicReleaseFailureCode;
      causeCode: AtomicReleaseFailureCode;
      phase: AtomicReleaseJournalPhase;
    }
  | {
      state: "RECOVERY_REQUIRED";
      operationId: string;
      code: AtomicReleaseFailureCode;
      phase: AtomicReleaseJournalPhase;
    };

export type AtomicReleaseManagerOptions = {
  journalStore: AtomicReleaseJournalStore;
  adapters: AtomicReleaseAdapters;
  now?: () => string;
  ownerId?: string;
  activeLeaseDurationMs?: number;
};

type InFlightEntry = { fingerprint: string; promise: Promise<AtomicReleaseOutcome> };
type LeaseContext = { claim: AtomicReleaseActiveLeaseClaim; lost: boolean };

class ActiveLeaseLostError extends Error {
  constructor() {
    super("atomic release active lease lost");
  }
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`)
    .join(",")}}`;
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalize(value)).digest("hex");
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function safeAdapterCode(value: unknown): value is string {
  return typeof value === "string" && SAFE_ADAPTER_CODE_PATTERN.test(value);
}

function normalizePathSegment(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}

function compactPathSegment(value: string): string {
  return normalizePathSegment(value).replace(/[^a-z0-9]/g, "");
}

function isSensitiveLogicalPath(segmentsInput: readonly string[]): boolean {
  const segments = segmentsInput.map(normalizePathSegment);
  const basename = segments.at(-1);
  if (!basename) return true;
  if (CREDENTIAL_BASENAMES.has(basename)) return true;
  if (segments.length === 2 && segments[0] === "authority") {
    if (basename === "ed25519-private-key.pem" || basename === "trusted-signing-keys.json") {
      return true;
    }
  }
  const compactBasename = compactPathSegment(basename);
  return (
    compactBasename.startsWith("credentialrotationjournal") ||
    compactBasename.startsWith("securityrotationjournal") ||
    (compactBasename.startsWith("rotationjournal") && segments.includes("security")) ||
    compactBasename.startsWith("securityepoch") ||
    compactBasename.startsWith("credentialepoch") ||
    segments.some(
      (segment, index) =>
        segment === "security" &&
        (segments[index + 1] === "epoch" || segments[index + 1] === "epochs"),
    ) ||
    ((compactBasename.startsWith("epoch") || compactBasename.startsWith("epochs")) &&
      segments.includes("security"))
  );
}

function isSafeLogicalPath(value: unknown, expectedPrefix?: "config/"): value is string {
  if (typeof value !== "string" || !LOGICAL_NAME_PATTERN.test(value)) return false;
  if (value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/u.test(value)) return false;
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return false;
  }
  if (expectedPrefix && !value.startsWith(expectedPrefix)) return false;
  if (FORBIDDEN_LOGICAL_SEGMENTS.has(normalizePathSegment(segments[0]!))) return false;
  return !isSensitiveLogicalPath(segments);
}

function timestampNotBefore(value: string, floor: string): boolean {
  return Date.parse(value) >= Date.parse(floor);
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function isReleaseIdentity(value: unknown): value is ReleaseIdentity {
  if (!isRecord(value)) return false;
  return (
    exactKeys(value, [
      "buildId",
      "buildSessionId",
      "protocolId",
      "manifestSha256",
      "migrationId",
    ]) &&
    typeof value.buildId === "string" &&
    SHA256_PATTERN.test(value.buildId) &&
    typeof value.buildSessionId === "string" &&
    UUID_PATTERN.test(value.buildSessionId) &&
    typeof value.protocolId === "string" &&
    SHA256_PATTERN.test(value.protocolId) &&
    typeof value.manifestSha256 === "string" &&
    SHA256_PATTERN.test(value.manifestSha256) &&
    typeof value.migrationId === "string" &&
    SHA256_PATTERN.test(value.migrationId)
  );
}

function sameIdentity(left: ReleaseIdentity, right: ReleaseIdentity): boolean {
  return (
    left.buildId === right.buildId &&
    left.buildSessionId === right.buildSessionId &&
    left.protocolId === right.protocolId &&
    left.manifestSha256 === right.manifestSha256 &&
    left.migrationId === right.migrationId
  );
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isCandidateProbeReceipt(value: unknown): value is CandidateProbeReceipt {
  if (!isRecord(value)) return false;
  return (
    exactKeys(value, [
      "candidateId",
      "probeId",
      "isolation",
      "requestedPort",
      "boundAddress",
      "boundPort",
      "runtimeInstanceId",
      "backupDatabaseIdentitySha256",
      "healthy",
      "identity",
      "probedAt",
    ]) &&
    typeof value.candidateId === "string" &&
    CANDIDATE_ID_PATTERN.test(value.candidateId) &&
    typeof value.probeId === "string" &&
    RECEIPT_ID_PATTERN.test(value.probeId) &&
    value.isolation === "BACKUP_COPY" &&
    value.requestedPort === 0 &&
    (value.boundAddress === "127.0.0.1" || value.boundAddress === "::1") &&
    isPositiveInteger(value.boundPort) &&
    value.boundPort <= 65_535 &&
    typeof value.runtimeInstanceId === "string" &&
    RECEIPT_ID_PATTERN.test(value.runtimeInstanceId) &&
    typeof value.backupDatabaseIdentitySha256 === "string" &&
    SHA256_PATTERN.test(value.backupDatabaseIdentitySha256) &&
    value.healthy === true &&
    isReleaseIdentity(value.identity) &&
    isIsoTimestamp(value.probedAt)
  );
}

function isSecurityStateReceipt(value: unknown): value is SecurityStateReceipt {
  if (!isRecord(value)) return false;
  return (
    exactKeys(value, [
      "schemaVersion",
      "securityEpoch",
      "securityEventSequence",
      "securityStateSha256",
      "externalJournalSha256",
      "observedAt",
    ]) &&
    value.schemaVersion === 1 &&
    isNonNegativeInteger(value.securityEpoch) &&
    isNonNegativeInteger(value.securityEventSequence) &&
    typeof value.securityStateSha256 === "string" &&
    SHA256_PATTERN.test(value.securityStateSha256) &&
    typeof value.externalJournalSha256 === "string" &&
    SHA256_PATTERN.test(value.externalJournalSha256) &&
    isIsoTimestamp(value.observedAt)
  );
}

function isSnapshotDatabaseReceipt(value: unknown): value is SnapshotDatabaseReceipt {
  if (!isRecord(value)) return false;
  return (
    exactKeys(value, [
      "schemaVersion",
      "adapterKind",
      "sourceDatabaseIdentitySha256",
      "sourcePageCount",
      "sourceWalCommitSequence",
      "backupSha256",
      "sourceQuickCheck",
      "backupQuickCheck",
      "capturedAt",
    ]) &&
    value.schemaVersion === 1 &&
    value.adapterKind === "SQLITE_BACKUP_API" &&
    typeof value.sourceDatabaseIdentitySha256 === "string" &&
    SHA256_PATTERN.test(value.sourceDatabaseIdentitySha256) &&
    isPositiveInteger(value.sourcePageCount) &&
    isNonNegativeInteger(value.sourceWalCommitSequence) &&
    typeof value.backupSha256 === "string" &&
    SHA256_PATTERN.test(value.backupSha256) &&
    value.sourceQuickCheck === "ok" &&
    value.backupQuickCheck === "ok" &&
    isIsoTimestamp(value.capturedAt)
  );
}

function isCurrentObservationReceipt(value: unknown): value is CurrentObservationReceipt {
  if (!isRecord(value)) return false;
  return (
    exactKeys(value, [
      "sourceIdentity",
      "runtimeId",
      "hubInstanceId",
      "boundAddress",
      "boundPort",
      "mode",
      "observedAt",
    ]) &&
    isReleaseIdentity(value.sourceIdentity) &&
    typeof value.runtimeId === "string" &&
    RECEIPT_ID_PATTERN.test(value.runtimeId) &&
    typeof value.hubInstanceId === "string" &&
    RECEIPT_ID_PATTERN.test(value.hubInstanceId) &&
    (value.boundAddress === "127.0.0.1" || value.boundAddress === "::1") &&
    isPositiveInteger(value.boundPort) &&
    value.boundPort <= 65_535 &&
    value.mode === "NORMAL" &&
    isIsoTimestamp(value.observedAt)
  );
}

function isArtifact(
  value: unknown,
  allowedRoles: readonly string[],
  candidateConfig = false,
): boolean {
  if (!isRecord(value)) return false;
  const keys = ["role", "logicalName", "relativePath", "size", "sha256"];
  if (candidateConfig) keys.push("expectedCandidateSha256");
  return (
    exactKeys(value, keys) &&
    typeof value.role === "string" &&
    allowedRoles.includes(value.role) &&
    isSafeLogicalPath(value.logicalName, candidateConfig ? "config/" : undefined) &&
    isSafeLogicalPath(value.relativePath, candidateConfig ? "config/" : undefined) &&
    value.relativePath === value.logicalName &&
    Number.isSafeInteger(value.size) &&
    (value.size as number) >= 0 &&
    typeof value.sha256 === "string" &&
    SHA256_PATTERN.test(value.sha256) &&
    (!candidateConfig ||
      (typeof value.expectedCandidateSha256 === "string" &&
        SHA256_PATTERN.test(value.expectedCandidateSha256)))
  );
}

function unsignedManifest<T extends { manifestSha256: string }>(
  manifest: T,
): Omit<T, "manifestSha256"> {
  const { manifestSha256: _manifestSha256, ...unsigned } = manifest;
  return unsigned;
}

function isCommonSnapshotManifest(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  if (
    !exactKeys(value, [
      "schemaVersion",
      "snapshotId",
      "sourceIdentity",
      "createdAt",
      "snapshotKind",
      "restoreEligible",
      "quiescenceProof",
      "database",
      "releaseFiles",
      "excludedFromRestore",
      "configFiles",
      "manifestSha256",
    ]) ||
    value.schemaVersion !== 1 ||
    typeof value.snapshotId !== "string" ||
    !SNAPSHOT_ID_PATTERN.test(value.snapshotId) ||
    !isReleaseIdentity(value.sourceIdentity) ||
    !isIsoTimestamp(value.createdAt) ||
    typeof value.manifestSha256 !== "string" ||
    !SHA256_PATTERN.test(value.manifestSha256) ||
    !isRecord(value.database) ||
    !exactKeys(value.database, [
      "strategy",
      "sourceJournalMode",
      "sourceQuickCheck",
      "backupQuickCheck",
      "artifact",
    ]) ||
    value.database.strategy !== "SQLITE_BACKUP_API" ||
    value.database.sourceJournalMode !== "WAL" ||
    value.database.sourceQuickCheck !== "ok" ||
    value.database.backupQuickCheck !== "ok" ||
    !isArtifact(value.database.artifact, ["DATABASE"]) ||
    !Array.isArray(value.releaseFiles) ||
    !value.releaseFiles.every((item) =>
      isArtifact(item, ["RELEASE_POINTER", "ARTIFACT_DESCRIPTOR"]),
    ) ||
    !Array.isArray(value.excludedFromRestore) ||
    !sameStrings(value.excludedFromRestore as string[], EXCLUDED_RESTORE_CATEGORIES) ||
    !Array.isArray(value.configFiles)
  ) {
    return false;
  }
  const databaseArtifact = value.database.artifact as Record<string, unknown>;
  const releaseFiles = value.releaseFiles as Array<Record<string, unknown>>;
  if (
    databaseArtifact.logicalName !== "database/crossagent.db" ||
    releaseFiles.length !== 2 ||
    !releaseFiles.some(
      (item) => item.role === "RELEASE_POINTER" && item.logicalName === "release/pointer.json",
    ) ||
    !releaseFiles.some(
      (item) =>
        item.role === "ARTIFACT_DESCRIPTOR" &&
        item.logicalName === "release/artifact-descriptor.json",
    )
  ) {
    return false;
  }
  const logicalNames = [
    databaseArtifact.logicalName,
    ...releaseFiles.map((item) => item.logicalName),
    ...value.configFiles.map((item) => (item as Record<string, unknown>).logicalName),
  ];
  if (new Set(logicalNames).size !== logicalNames.length) return false;
  return digest(unsignedManifest(value as { manifestSha256: string })) === value.manifestSha256;
}

function isOnlinePreflightSnapshot(value: unknown): value is OnlinePreflightSnapshotManifest {
  return (
    isCommonSnapshotManifest(value) &&
    value.snapshotKind === "ONLINE_PREFLIGHT" &&
    value.restoreEligible === false &&
    value.quiescenceProof === null &&
    Array.isArray(value.configFiles) &&
    value.configFiles.length === 0
  );
}

function isQuiescenceProof(value: unknown): value is QuiescenceProof {
  if (!isRecord(value)) return false;
  return (
    exactKeys(value, ["state", "fenceId", "stopReceiptId", "observedAt"]) &&
    value.state === "QUIESCED" &&
    typeof value.fenceId === "string" &&
    RECEIPT_ID_PATTERN.test(value.fenceId) &&
    typeof value.stopReceiptId === "string" &&
    RECEIPT_ID_PATTERN.test(value.stopReceiptId) &&
    isIsoTimestamp(value.observedAt)
  );
}

function isFinalRollbackSnapshot(value: unknown): value is FinalRollbackSnapshotManifest {
  return (
    isCommonSnapshotManifest(value) &&
    value.snapshotKind === "FINAL_ROLLBACK" &&
    value.restoreEligible === true &&
    isQuiescenceProof(value.quiescenceProof) &&
    Array.isArray(value.configFiles) &&
    value.configFiles.every(
      (item) =>
        isArtifact(item, ["CANDIDATE_OWNED_CONFIG"], true) &&
        (item as { logicalName: string }).logicalName.startsWith("config/"),
    )
  );
}

function isHubMaintenanceReceipt(value: unknown): value is HubMaintenanceReceipt {
  if (!isRecord(value)) return false;
  return (
    exactKeys(value, [
      "maintenanceId",
      "scope",
      "mode",
      "fenceId",
      "sourceIdentity",
      "sourceRuntimeId",
      "sourceHubInstanceId",
      "releasePointerRevision",
      "securityState",
      "enteredAt",
    ]) &&
    typeof value.maintenanceId === "string" &&
    RECEIPT_ID_PATTERN.test(value.maintenanceId) &&
    value.scope === "HUB_WIDE" &&
    value.mode === "MAINTENANCE" &&
    typeof value.fenceId === "string" &&
    RECEIPT_ID_PATTERN.test(value.fenceId) &&
    isReleaseIdentity(value.sourceIdentity) &&
    typeof value.sourceRuntimeId === "string" &&
    RECEIPT_ID_PATTERN.test(value.sourceRuntimeId) &&
    typeof value.sourceHubInstanceId === "string" &&
    RECEIPT_ID_PATTERN.test(value.sourceHubInstanceId) &&
    isPositiveInteger(value.releasePointerRevision) &&
    isSecurityStateReceipt(value.securityState) &&
    isIsoTimestamp(value.enteredAt)
  );
}

function isManagedBridgeSubjectProof(value: unknown): value is ManagedBridgeSubjectProof {
  if (!isRecord(value)) return false;
  return (
    exactKeys(value, [
      "schemaVersion",
      "subjectRevision",
      "projectId",
      "originalThreadId",
      "agentId",
      "runId",
      "sessionId",
      "lineageId",
      "incarnation",
      "bundleId",
      "build",
      "vaultSha256",
      "checkpointSha256",
      "checkpointEventSequence",
      "fuseGeneration",
    ]) &&
    value.schemaVersion === 1 &&
    isNonNegativeInteger(value.subjectRevision) &&
    typeof value.projectId === "string" &&
    RECEIPT_ID_PATTERN.test(value.projectId) &&
    typeof value.originalThreadId === "string" &&
    RECEIPT_ID_PATTERN.test(value.originalThreadId) &&
    value.agentId === "codex" &&
    typeof value.runId === "string" &&
    RECEIPT_ID_PATTERN.test(value.runId) &&
    typeof value.sessionId === "string" &&
    RECEIPT_ID_PATTERN.test(value.sessionId) &&
    typeof value.lineageId === "string" &&
    RECEIPT_ID_PATTERN.test(value.lineageId) &&
    isPositiveInteger(value.incarnation) &&
    typeof value.bundleId === "string" &&
    RECEIPT_ID_PATTERN.test(value.bundleId) &&
    isReleaseIdentity(value.build) &&
    typeof value.vaultSha256 === "string" &&
    SHA256_PATTERN.test(value.vaultSha256) &&
    typeof value.checkpointSha256 === "string" &&
    SHA256_PATTERN.test(value.checkpointSha256) &&
    isNonNegativeInteger(value.checkpointEventSequence) &&
    isNonNegativeInteger(value.fuseGeneration)
  );
}

function isPausedManagedBridgeSubject(value: unknown): value is PausedManagedBridgeSubject {
  if (!isRecord(value)) return false;
  return (
    exactKeys(value, ["previousDesiredState", "subjectProof", "subjectProofSha256"]) &&
    (value.previousDesiredState === "RUNNING" || value.previousDesiredState === "STOPPED") &&
    isManagedBridgeSubjectProof(value.subjectProof) &&
    typeof value.subjectProofSha256 === "string" &&
    SHA256_PATTERN.test(value.subjectProofSha256) &&
    digest({
      previousDesiredState: value.previousDesiredState,
      subjectProof: value.subjectProof,
    }) === value.subjectProofSha256
  );
}

function isSupervisorPauseReceipt(value: unknown): value is SupervisorPauseReceipt {
  if (!isRecord(value)) return false;
  return (
    exactKeys(value, [
      "schemaVersion",
      "operationId",
      "maintenanceId",
      "fenceId",
      "pauseReceiptId",
      "atomicJournalRevision",
      "releasePointerRevision",
      "supervisorJournalRevision",
      "subjects",
      "pausedAt",
      "receiptSha256",
    ]) &&
    value.schemaVersion === 1 &&
    typeof value.operationId === "string" &&
    OPERATION_ID_PATTERN.test(value.operationId) &&
    typeof value.maintenanceId === "string" &&
    RECEIPT_ID_PATTERN.test(value.maintenanceId) &&
    typeof value.fenceId === "string" &&
    RECEIPT_ID_PATTERN.test(value.fenceId) &&
    typeof value.pauseReceiptId === "string" &&
    RECEIPT_ID_PATTERN.test(value.pauseReceiptId) &&
    isPositiveInteger(value.atomicJournalRevision) &&
    isPositiveInteger(value.releasePointerRevision) &&
    isPositiveInteger(value.supervisorJournalRevision) &&
    Array.isArray(value.subjects) &&
    value.subjects.every(isPausedManagedBridgeSubject) &&
    new Set(
      value.subjects.map(
        (item) => `${item.subjectProof.projectId}:${item.subjectProof.originalThreadId}`,
      ),
    ).size === value.subjects.length &&
    isIsoTimestamp(value.pausedAt) &&
    typeof value.receiptSha256 === "string" &&
    SHA256_PATTERN.test(value.receiptSha256) &&
    digest(Object.fromEntries(Object.entries(value).filter(([key]) => key !== "receiptSha256"))) ===
      value.receiptSha256
  );
}

function isCooperativeStopReceipt(value: unknown): value is CooperativeStopReceipt {
  if (!isRecord(value)) return false;
  return (
    exactKeys(value, [
      "maintenanceId",
      "fenceId",
      "stopReceiptId",
      "sourceIdentity",
      "sourceRuntimeId",
      "sourceHubInstanceId",
      "runtimeState",
      "stoppedAt",
    ]) &&
    typeof value.maintenanceId === "string" &&
    RECEIPT_ID_PATTERN.test(value.maintenanceId) &&
    typeof value.fenceId === "string" &&
    RECEIPT_ID_PATTERN.test(value.fenceId) &&
    typeof value.stopReceiptId === "string" &&
    RECEIPT_ID_PATTERN.test(value.stopReceiptId) &&
    isReleaseIdentity(value.sourceIdentity) &&
    typeof value.sourceRuntimeId === "string" &&
    RECEIPT_ID_PATTERN.test(value.sourceRuntimeId) &&
    typeof value.sourceHubInstanceId === "string" &&
    RECEIPT_ID_PATTERN.test(value.sourceHubInstanceId) &&
    value.runtimeState === "STOPPED" &&
    isIsoTimestamp(value.stoppedAt)
  );
}

function isMaintenanceRuntimeReceipt(value: unknown): value is MaintenanceRuntimeReceipt {
  if (!isRecord(value)) return false;
  return (
    exactKeys(value, [
      "maintenanceId",
      "runtimeId",
      "hubInstanceId",
      "boundAddress",
      "boundPort",
      "identity",
      "mode",
      "startedAt",
    ]) &&
    typeof value.maintenanceId === "string" &&
    RECEIPT_ID_PATTERN.test(value.maintenanceId) &&
    typeof value.runtimeId === "string" &&
    RECEIPT_ID_PATTERN.test(value.runtimeId) &&
    typeof value.hubInstanceId === "string" &&
    RECEIPT_ID_PATTERN.test(value.hubInstanceId) &&
    (value.boundAddress === "127.0.0.1" || value.boundAddress === "::1") &&
    isPositiveInteger(value.boundPort) &&
    value.boundPort <= 65_535 &&
    isReleaseIdentity(value.identity) &&
    value.mode === "MAINTENANCE" &&
    isIsoTimestamp(value.startedAt)
  );
}

function isMaintenanceHealthReceipt(value: unknown): value is MaintenanceHealthReceipt {
  if (!isRecord(value)) return false;
  return (
    exactKeys(value, [
      "maintenanceId",
      "target",
      "identity",
      "runtimeId",
      "hubInstanceId",
      "boundAddress",
      "boundPort",
      "mode",
      "checkedAt",
    ]) &&
    typeof value.maintenanceId === "string" &&
    RECEIPT_ID_PATTERN.test(value.maintenanceId) &&
    (value.target === "CANDIDATE" || value.target === "PREVIOUS") &&
    isReleaseIdentity(value.identity) &&
    typeof value.runtimeId === "string" &&
    RECEIPT_ID_PATTERN.test(value.runtimeId) &&
    typeof value.hubInstanceId === "string" &&
    RECEIPT_ID_PATTERN.test(value.hubInstanceId) &&
    (value.boundAddress === "127.0.0.1" || value.boundAddress === "::1") &&
    isPositiveInteger(value.boundPort) &&
    value.boundPort <= 65_535 &&
    value.mode === "MAINTENANCE" &&
    isIsoTimestamp(value.checkedAt)
  );
}

function isCandidateMigrationReceipt(value: unknown): value is CandidateMigrationReceipt {
  if (!isRecord(value)) return false;
  return (
    exactKeys(value, ["maintenanceId", "identity", "migrationId", "migratedAt"]) &&
    typeof value.maintenanceId === "string" &&
    RECEIPT_ID_PATTERN.test(value.maintenanceId) &&
    isReleaseIdentity(value.identity) &&
    typeof value.migrationId === "string" &&
    SHA256_PATTERN.test(value.migrationId) &&
    isIsoTimestamp(value.migratedAt)
  );
}

function isMaintenanceCommitReceipt(value: unknown): value is MaintenanceCommitReceipt {
  if (!isRecord(value)) return false;
  return (
    exactKeys(value, [
      "maintenanceId",
      "target",
      "identity",
      "atomicJournalRevision",
      "releasePointerRevision",
      "committedAt",
    ]) &&
    typeof value.maintenanceId === "string" &&
    RECEIPT_ID_PATTERN.test(value.maintenanceId) &&
    (value.target === "CANDIDATE" || value.target === "PREVIOUS") &&
    isReleaseIdentity(value.identity) &&
    isPositiveInteger(value.atomicJournalRevision) &&
    isPositiveInteger(value.releasePointerRevision) &&
    isIsoTimestamp(value.committedAt)
  );
}

function isAtomicSwapReceipt(value: unknown): value is AtomicSwapReceipt {
  if (!isRecord(value)) return false;
  return (
    exactKeys(value, [
      "schemaVersion",
      "operationId",
      "previousPointerRevision",
      "pointerRevision",
      "sourceIdentity",
      "candidateIdentity",
      "installedIdentity",
      "replaceStrategy",
      "replaceGeneration",
      "previousArtifactSha256",
      "candidateArtifactSha256",
      "installedArtifactSha256",
      "durability",
      "swappedAt",
    ]) &&
    value.schemaVersion === 1 &&
    typeof value.operationId === "string" &&
    OPERATION_ID_PATTERN.test(value.operationId) &&
    isPositiveInteger(value.previousPointerRevision) &&
    value.pointerRevision === value.previousPointerRevision + 1 &&
    isReleaseIdentity(value.sourceIdentity) &&
    isReleaseIdentity(value.candidateIdentity) &&
    isReleaseIdentity(value.installedIdentity) &&
    (value.replaceStrategy === "WINDOWS_REPLACE_FILE" ||
      value.replaceStrategy === "GENERATION_SLOTS") &&
    isPositiveInteger(value.replaceGeneration) &&
    typeof value.previousArtifactSha256 === "string" &&
    SHA256_PATTERN.test(value.previousArtifactSha256) &&
    typeof value.candidateArtifactSha256 === "string" &&
    SHA256_PATTERN.test(value.candidateArtifactSha256) &&
    typeof value.installedArtifactSha256 === "string" &&
    SHA256_PATTERN.test(value.installedArtifactSha256) &&
    value.durability === "REPLACED_AND_DIRECTORY_SYNCED" &&
    isIsoTimestamp(value.swappedAt)
  );
}

function isFinalSnapshotSecurityReceipt(value: unknown): value is FinalSnapshotSecurityReceipt {
  return (
    isRecord(value) &&
    exactKeys(value, [
      "schemaVersion",
      "securityEpoch",
      "securityEventSequence",
      "securityStateSha256",
      "externalJournalSha256",
      "observedAt",
      "snapshotId",
    ]) &&
    typeof value.snapshotId === "string" &&
    SNAPSHOT_ID_PATTERN.test(value.snapshotId) &&
    isSecurityStateReceipt(
      Object.fromEntries(Object.entries(value).filter(([key]) => key !== "snapshotId")),
    )
  );
}

function isFinalRestoreReceipt(value: unknown): value is FinalRestoreReceipt {
  if (!isRecord(value)) return false;
  return (
    exactKeys(value, [
      "schemaVersion",
      "operationId",
      "snapshotId",
      "adapterKind",
      "sourceDatabaseIdentitySha256",
      "restoredDatabaseSha256",
      "restoredPageCount",
      "restoredQuickCheck",
      "staleWalDisposition",
      "previousPointerRevision",
      "pointerRevision",
      "restoredIdentity",
      "snapshotSecurityEpoch",
      "observedSecurityEpochBeforeRestore",
      "reconciledSecurityEpoch",
      "replayedThroughSecurityEventSequence",
      "reconciledSecurityStateSha256",
      "externalJournalSha256",
      "credentialState",
      "sessionTicketState",
      "authorityState",
      "restoredAt",
    ]) &&
    value.schemaVersion === 1 &&
    typeof value.operationId === "string" &&
    OPERATION_ID_PATTERN.test(value.operationId) &&
    typeof value.snapshotId === "string" &&
    SNAPSHOT_ID_PATTERN.test(value.snapshotId) &&
    value.adapterKind === "SQLITE_BACKUP_API" &&
    typeof value.sourceDatabaseIdentitySha256 === "string" &&
    SHA256_PATTERN.test(value.sourceDatabaseIdentitySha256) &&
    typeof value.restoredDatabaseSha256 === "string" &&
    SHA256_PATTERN.test(value.restoredDatabaseSha256) &&
    isPositiveInteger(value.restoredPageCount) &&
    value.restoredQuickCheck === "ok" &&
    value.staleWalDisposition === "ISOLATED_AND_CLEARED" &&
    isPositiveInteger(value.previousPointerRevision) &&
    value.pointerRevision === value.previousPointerRevision + 1 &&
    isReleaseIdentity(value.restoredIdentity) &&
    isNonNegativeInteger(value.snapshotSecurityEpoch) &&
    isNonNegativeInteger(value.observedSecurityEpochBeforeRestore) &&
    isNonNegativeInteger(value.reconciledSecurityEpoch) &&
    value.reconciledSecurityEpoch >= value.observedSecurityEpochBeforeRestore &&
    value.reconciledSecurityEpoch >= value.snapshotSecurityEpoch &&
    isNonNegativeInteger(value.replayedThroughSecurityEventSequence) &&
    typeof value.reconciledSecurityStateSha256 === "string" &&
    SHA256_PATTERN.test(value.reconciledSecurityStateSha256) &&
    typeof value.externalJournalSha256 === "string" &&
    SHA256_PATTERN.test(value.externalJournalSha256) &&
    value.credentialState === "FORWARD_RECONCILED" &&
    value.sessionTicketState === "FORWARD_RECONCILED" &&
    value.authorityState === "FORWARD_RECONCILED" &&
    isIsoTimestamp(value.restoredAt)
  );
}

function isReleaseTransitionAuthorization(value: unknown): value is ReleaseTransitionAuthorization {
  if (!isRecord(value)) return false;
  return (
    exactKeys(value, [
      "schemaVersion",
      "authorizationId",
      "operationId",
      "requestFingerprint",
      "authorizedOutcome",
      "atomicJournalRevision",
      "pointerRevision",
      "supervisorJournalRevision",
      "pauseReceiptId",
      "sourceIdentity",
      "candidateIdentity",
      "installedIdentity",
      "pauseReceiptSha256",
      "issuedAt",
      "authorizationSha256",
    ]) &&
    value.schemaVersion === 1 &&
    typeof value.authorizationId === "string" &&
    RECEIPT_ID_PATTERN.test(value.authorizationId) &&
    typeof value.operationId === "string" &&
    OPERATION_ID_PATTERN.test(value.operationId) &&
    typeof value.requestFingerprint === "string" &&
    SHA256_PATTERN.test(value.requestFingerprint) &&
    (value.authorizedOutcome === "DEPLOYED" || value.authorizedOutcome === "ROLLED_BACK") &&
    isPositiveInteger(value.atomicJournalRevision) &&
    isPositiveInteger(value.pointerRevision) &&
    isPositiveInteger(value.supervisorJournalRevision) &&
    typeof value.pauseReceiptId === "string" &&
    RECEIPT_ID_PATTERN.test(value.pauseReceiptId) &&
    isReleaseIdentity(value.sourceIdentity) &&
    isReleaseIdentity(value.candidateIdentity) &&
    isReleaseIdentity(value.installedIdentity) &&
    typeof value.pauseReceiptSha256 === "string" &&
    SHA256_PATTERN.test(value.pauseReceiptSha256) &&
    isIsoTimestamp(value.issuedAt) &&
    typeof value.authorizationSha256 === "string" &&
    SHA256_PATTERN.test(value.authorizationSha256) &&
    digest(
      Object.fromEntries(Object.entries(value).filter(([key]) => key !== "authorizationSha256")),
    ) === value.authorizationSha256
  );
}

function isManagedBridgeReleaseEffectReceipt(
  value: unknown,
): value is ManagedBridgeReleaseEffectReceipt {
  if (!isRecord(value)) return false;
  return (
    exactKeys(value, [
      "schemaVersion",
      "effectReceiptId",
      "authorizationId",
      "authorizationSha256",
      "operationId",
      "effect",
      "supervisorJournalRevision",
      "previousDesiredState",
      "subjectProof",
      "sealedSubjectProofSha256",
      "installedIdentity",
      "effectedAt",
      "effectReceiptSha256",
    ]) &&
    value.schemaVersion === 1 &&
    typeof value.effectReceiptId === "string" &&
    RECEIPT_ID_PATTERN.test(value.effectReceiptId) &&
    typeof value.authorizationId === "string" &&
    RECEIPT_ID_PATTERN.test(value.authorizationId) &&
    typeof value.authorizationSha256 === "string" &&
    SHA256_PATTERN.test(value.authorizationSha256) &&
    typeof value.operationId === "string" &&
    OPERATION_ID_PATTERN.test(value.operationId) &&
    (value.effect === "REBOUND" ||
      value.effect === "ROLLED_BACK" ||
      value.effect === "ALREADY_STOPPED") &&
    isPositiveInteger(value.supervisorJournalRevision) &&
    (value.previousDesiredState === "RUNNING" || value.previousDesiredState === "STOPPED") &&
    isManagedBridgeSubjectProof(value.subjectProof) &&
    typeof value.sealedSubjectProofSha256 === "string" &&
    SHA256_PATTERN.test(value.sealedSubjectProofSha256) &&
    digest({
      previousDesiredState: value.previousDesiredState,
      subjectProof: value.subjectProof,
    }) === value.sealedSubjectProofSha256 &&
    isReleaseIdentity(value.installedIdentity) &&
    isIsoTimestamp(value.effectedAt) &&
    typeof value.effectReceiptSha256 === "string" &&
    SHA256_PATTERN.test(value.effectReceiptSha256) &&
    digest(
      Object.fromEntries(Object.entries(value).filter(([key]) => key !== "effectReceiptSha256")),
    ) === value.effectReceiptSha256
  );
}

function isBridgeResumeReceipt(value: unknown): value is BridgeResumeReceipt {
  if (!isRecord(value)) return false;
  return (
    exactKeys(value, [
      "maintenanceId",
      "target",
      "authorizationId",
      "authorizationSha256",
      "effects",
      "resumedAt",
    ]) &&
    typeof value.maintenanceId === "string" &&
    RECEIPT_ID_PATTERN.test(value.maintenanceId) &&
    (value.target === "CANDIDATE" || value.target === "PREVIOUS") &&
    typeof value.authorizationId === "string" &&
    RECEIPT_ID_PATTERN.test(value.authorizationId) &&
    typeof value.authorizationSha256 === "string" &&
    SHA256_PATTERN.test(value.authorizationSha256) &&
    Array.isArray(value.effects) &&
    value.effects.every(isManagedBridgeReleaseEffectReceipt) &&
    isIsoTimestamp(value.resumedAt)
  );
}

function isPreSwapCleanupReceipt(value: unknown): value is PreSwapCleanupReceipt {
  if (!isRecord(value)) return false;
  return (
    exactKeys(value, [
      "schemaVersion",
      "operationId",
      "maintenanceId",
      "failedPhase",
      "sourceIdentity",
      "runtimeId",
      "hubInstanceId",
      "mode",
      "pauseReceiptId",
      "releasePointerRevision",
      "securityEpoch",
      "securityStateSha256",
      "cleanedAt",
    ]) &&
    value.schemaVersion === 1 &&
    typeof value.operationId === "string" &&
    OPERATION_ID_PATTERN.test(value.operationId) &&
    typeof value.maintenanceId === "string" &&
    RECEIPT_ID_PATTERN.test(value.maintenanceId) &&
    typeof value.failedPhase === "string" &&
    JOURNAL_PHASES.has(value.failedPhase as AtomicReleaseJournalPhase) &&
    isReleaseIdentity(value.sourceIdentity) &&
    typeof value.runtimeId === "string" &&
    RECEIPT_ID_PATTERN.test(value.runtimeId) &&
    typeof value.hubInstanceId === "string" &&
    RECEIPT_ID_PATTERN.test(value.hubInstanceId) &&
    value.mode === "NORMAL" &&
    (value.pauseReceiptId === null ||
      (typeof value.pauseReceiptId === "string" &&
        RECEIPT_ID_PATTERN.test(value.pauseReceiptId))) &&
    isPositiveInteger(value.releasePointerRevision) &&
    isNonNegativeInteger(value.securityEpoch) &&
    typeof value.securityStateSha256 === "string" &&
    SHA256_PATTERN.test(value.securityStateSha256) &&
    isIsoTimestamp(value.cleanedAt)
  );
}

function requestFingerprint(request: AtomicReleaseRequest): string {
  return digest({
    candidateId: request.candidateId,
    expectedCandidate: request.expectedCandidate,
    expectedCurrent: request.expectedCurrent,
  });
}

function isRequestValid(request: AtomicReleaseRequest): boolean {
  return (
    OPERATION_ID_PATTERN.test(request.operationId) &&
    CANDIDATE_ID_PATTERN.test(request.candidateId) &&
    isReleaseIdentity(request.expectedCurrent) &&
    isReleaseIdentity(request.expectedCandidate) &&
    !sameIdentity(request.expectedCurrent, request.expectedCandidate)
  );
}

const NORMAL_PHASES = [
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
  "AUTHORIZE_BRIDGES_INTENT",
  "BRIDGE_TRANSITION_AUTHORIZED",
  "RESUME_BRIDGES_INTENT",
  "BRIDGES_RESUMED",
  "COMMIT_MAINTENANCE_INTENT",
  "MAINTENANCE_COMMITTED",
  "COMPLETED",
] as const satisfies readonly AtomicReleaseJournalPhase[];

const ROLLBACK_PHASES = [
  "ROLLBACK_STOP_CANDIDATE_INTENT",
  "ROLLBACK_RESTORE_INTENT",
  "ROLLBACK_START_PREVIOUS_MAINTENANCE_INTENT",
  "ROLLBACK_PREVIOUS_STARTED",
  "ROLLBACK_VERIFY_PREVIOUS_INTENT",
  "ROLLBACK_PREVIOUS_HEALTHY",
  "ROLLBACK_AUTHORIZE_BRIDGES_INTENT",
  "ROLLBACK_BRIDGE_TRANSITION_AUTHORIZED",
  "ROLLBACK_RESUME_BRIDGES_INTENT",
  "ROLLBACK_BRIDGES_RESUMED",
  "ROLLBACK_COMMIT_MAINTENANCE_INTENT",
  "ROLLBACK_MAINTENANCE_COMMITTED",
  "ROLLED_BACK",
] as const satisfies readonly AtomicReleaseJournalPhase[];

const JOURNAL_PHASES = new Set<AtomicReleaseJournalPhase>([
  ...NORMAL_PHASES,
  ...ROLLBACK_PHASES,
  "PRE_SWAP_CLEANUP_INTENT",
  "PRE_SWAP_CLEANUP_CONFIRMED",
  "BLOCKED",
  "ROLLBACK_FAILED",
]);

const FAILURE_CODES = new Set<AtomicReleaseFailureCode>([
  "REQUEST_INVALID",
  "REQUEST_CONFLICT",
  "JOURNAL_CORRUPT",
  "CANDIDATE_PROBE_FAILED",
  "CANDIDATE_IDENTITY_MISMATCH",
  "PREFLIGHT_SNAPSHOT_FAILED",
  "PREFLIGHT_SNAPSHOT_MANIFEST_INVALID",
  "CURRENT_OBSERVATION_FAILED",
  "CURRENT_IDENTITY_CHANGED",
  "MAINTENANCE_ENTER_FAILED",
  "MAINTENANCE_ENTER_AMBIGUOUS",
  "SUPERVISOR_PAUSE_FAILED",
  "SUPERVISOR_PAUSE_AMBIGUOUS",
  "STOP_FAILED",
  "STOP_OUTCOME_AMBIGUOUS",
  "FINAL_SNAPSHOT_FAILED",
  "FINAL_SNAPSHOT_MANIFEST_INVALID",
  "SWAP_FAILED",
  "SWAP_OUTCOME_AMBIGUOUS",
  "CANDIDATE_MAINTENANCE_START_FAILED",
  "CANDIDATE_MAINTENANCE_START_AMBIGUOUS",
  "CANDIDATE_HEALTH_FAILED",
  "CANDIDATE_MIGRATION_FAILED",
  "CANDIDATE_MIGRATION_AMBIGUOUS",
  "MAINTENANCE_COMMIT_FAILED",
  "MAINTENANCE_COMMIT_AMBIGUOUS",
  "BRIDGE_RESUME_FAILED",
  "BRIDGE_RESUME_AMBIGUOUS",
  "ROLLBACK_CANDIDATE_STOP_FAILED",
  "ROLLBACK_CANDIDATE_STOP_AMBIGUOUS",
  "ROLLBACK_RESTORE_FAILED",
  "ROLLBACK_RESTORE_AMBIGUOUS",
  "ROLLBACK_PREVIOUS_START_FAILED",
  "ROLLBACK_PREVIOUS_START_AMBIGUOUS",
  "ROLLBACK_PREVIOUS_HEALTH_FAILED",
  "ROLLBACK_PREVIOUS_HEALTH_AMBIGUOUS",
  "ROLLBACK_MAINTENANCE_COMMIT_FAILED",
  "ROLLBACK_MAINTENANCE_COMMIT_AMBIGUOUS",
  "ROLLBACK_BRIDGE_RESUME_FAILED",
  "ROLLBACK_BRIDGE_RESUME_AMBIGUOUS",
  "PRE_SWAP_CLEANUP_FAILED",
  "PRE_SWAP_CLEANUP_AMBIGUOUS",
  "ADAPTER_RESULT_INVALID",
  "ACTIVE_OPERATION_HELD",
  "ACTIVE_OPERATION_LEASE_UNAVAILABLE",
  "ACTIVE_OPERATION_LEASE_LOST",
]);

const ROLLBACK_CAUSES = new Set<AtomicReleaseFailureCode>([
  "CANDIDATE_MAINTENANCE_START_FAILED",
  "CANDIDATE_HEALTH_FAILED",
  "CANDIDATE_MIGRATION_FAILED",
  "BRIDGE_RESUME_FAILED",
  "MAINTENANCE_COMMIT_FAILED",
]);

function nullable<T>(value: unknown, guard: (input: unknown) => input is T): value is T | null {
  return value === null || guard(value);
}

function isNullableFailureCode(value: unknown): value is AtomicReleaseFailureCode | null {
  return (
    value === null ||
    (typeof value === "string" && FAILURE_CODES.has(value as AtomicReleaseFailureCode))
  );
}

function isJournal(value: unknown): value is AtomicReleaseJournal {
  if (!isRecord(value)) return false;
  return (
    exactKeys(value, [
      "schemaVersion",
      "operationId",
      "requestFingerprint",
      "candidateId",
      "expectedCurrent",
      "expectedCandidate",
      "revision",
      "phase",
      "candidateProbe",
      "preflightSnapshot",
      "preflightDatabaseReceipt",
      "currentObservationReceipt",
      "maintenanceReceipt",
      "supervisorPauseReceipt",
      "stopReceipt",
      "finalSnapshot",
      "finalDatabaseReceipt",
      "finalSnapshotSecurityReceipt",
      "swapReceipt",
      "candidateStartReceipt",
      "candidateHealthReceipt",
      "candidateMigrationReceipt",
      "transitionAuthorization",
      "bridgeResumeReceipt",
      "maintenanceCommitReceipt",
      "restoreReceipt",
      "previousStartReceipt",
      "previousHealthReceipt",
      "rollbackTransitionAuthorization",
      "rollbackResumeReceipt",
      "rollbackCommitReceipt",
      "preSwapCleanupReceipt",
      "cleanupCauseCode",
      "cleanupFailedAtPhase",
      "rollbackCauseCode",
      "terminalCode",
      "failedAtPhase",
      "updatedAt",
    ]) &&
    value.schemaVersion === 3 &&
    typeof value.operationId === "string" &&
    OPERATION_ID_PATTERN.test(value.operationId) &&
    typeof value.requestFingerprint === "string" &&
    SHA256_PATTERN.test(value.requestFingerprint) &&
    typeof value.candidateId === "string" &&
    CANDIDATE_ID_PATTERN.test(value.candidateId) &&
    isReleaseIdentity(value.expectedCurrent) &&
    isReleaseIdentity(value.expectedCandidate) &&
    Number.isSafeInteger(value.revision) &&
    (value.revision as number) >= 0 &&
    typeof value.phase === "string" &&
    JOURNAL_PHASES.has(value.phase as AtomicReleaseJournalPhase) &&
    nullable(value.candidateProbe, isCandidateProbeReceipt) &&
    nullable(value.preflightSnapshot, isOnlinePreflightSnapshot) &&
    nullable(value.preflightDatabaseReceipt, isSnapshotDatabaseReceipt) &&
    nullable(value.currentObservationReceipt, isCurrentObservationReceipt) &&
    nullable(value.maintenanceReceipt, isHubMaintenanceReceipt) &&
    nullable(value.supervisorPauseReceipt, isSupervisorPauseReceipt) &&
    nullable(value.stopReceipt, isCooperativeStopReceipt) &&
    nullable(value.finalSnapshot, isFinalRollbackSnapshot) &&
    nullable(value.finalDatabaseReceipt, isSnapshotDatabaseReceipt) &&
    nullable(value.finalSnapshotSecurityReceipt, isFinalSnapshotSecurityReceipt) &&
    nullable(value.swapReceipt, isAtomicSwapReceipt) &&
    nullable(value.candidateStartReceipt, isMaintenanceRuntimeReceipt) &&
    nullable(value.candidateHealthReceipt, isMaintenanceHealthReceipt) &&
    nullable(value.candidateMigrationReceipt, isCandidateMigrationReceipt) &&
    nullable(value.transitionAuthorization, isReleaseTransitionAuthorization) &&
    nullable(value.bridgeResumeReceipt, isBridgeResumeReceipt) &&
    nullable(value.maintenanceCommitReceipt, isMaintenanceCommitReceipt) &&
    nullable(value.restoreReceipt, isFinalRestoreReceipt) &&
    nullable(value.previousStartReceipt, isMaintenanceRuntimeReceipt) &&
    nullable(value.previousHealthReceipt, isMaintenanceHealthReceipt) &&
    nullable(value.rollbackTransitionAuthorization, isReleaseTransitionAuthorization) &&
    nullable(value.rollbackResumeReceipt, isBridgeResumeReceipt) &&
    nullable(value.rollbackCommitReceipt, isMaintenanceCommitReceipt) &&
    nullable(value.preSwapCleanupReceipt, isPreSwapCleanupReceipt) &&
    isNullableFailureCode(value.cleanupCauseCode) &&
    (value.cleanupFailedAtPhase === null ||
      (typeof value.cleanupFailedAtPhase === "string" &&
        JOURNAL_PHASES.has(value.cleanupFailedAtPhase as AtomicReleaseJournalPhase))) &&
    isNullableFailureCode(value.rollbackCauseCode) &&
    isNullableFailureCode(value.terminalCode) &&
    (value.failedAtPhase === null ||
      (typeof value.failedAtPhase === "string" &&
        JOURNAL_PHASES.has(value.failedAtPhase as AtomicReleaseJournalPhase))) &&
    isIsoTimestamp(value.updatedAt)
  );
}

function expectedPresence(value: unknown, required: boolean): boolean {
  return required ? value !== null : value === null;
}

function normalRank(phase: AtomicReleaseJournalPhase): number {
  return NORMAL_PHASES.indexOf(phase as (typeof NORMAL_PHASES)[number]);
}

function rollbackRank(phase: AtomicReleaseJournalPhase): number {
  return ROLLBACK_PHASES.indexOf(phase as (typeof ROLLBACK_PHASES)[number]);
}

function releaseEffectsMatch(
  journal: AtomicReleaseJournal,
  receipt: BridgeResumeReceipt,
  authorization: ReleaseTransitionAuthorization,
  installedIdentity: ReleaseIdentity,
): boolean {
  const pause = journal.supervisorPauseReceipt;
  if (!pause || receipt.effects.length !== pause.subjects.length) return false;
  if (
    receipt.authorizationId !== authorization.authorizationId ||
    receipt.authorizationSha256 !== authorization.authorizationSha256
  ) {
    return false;
  }
  return receipt.effects.every((effect, index) => {
    const paused = pause.subjects[index];
    if (!paused) return false;
    const expectedEffect =
      paused.previousDesiredState === "STOPPED"
        ? "ALREADY_STOPPED"
        : authorization.authorizedOutcome === "DEPLOYED"
          ? "REBOUND"
          : "ROLLED_BACK";
    return (
      effect.authorizationId === authorization.authorizationId &&
      effect.authorizationSha256 === authorization.authorizationSha256 &&
      effect.operationId === journal.operationId &&
      effect.effect === expectedEffect &&
      effect.supervisorJournalRevision === authorization.supervisorJournalRevision + index + 1 &&
      effect.previousDesiredState === paused.previousDesiredState &&
      effect.sealedSubjectProofSha256 === paused.subjectProofSha256 &&
      digest(effect.subjectProof) === digest(paused.subjectProof) &&
      sameIdentity(effect.installedIdentity, installedIdentity)
    );
  });
}

function receiptRelationsValid(journal: AtomicReleaseJournal): boolean {
  const probe = journal.candidateProbe;
  if (
    probe &&
    (probe.candidateId !== journal.candidateId ||
      !sameIdentity(probe.identity, journal.expectedCandidate))
  ) {
    return false;
  }
  if ((journal.preflightSnapshot === null) !== (journal.preflightDatabaseReceipt === null)) {
    return false;
  }
  if (
    journal.preflightSnapshot &&
    journal.preflightDatabaseReceipt &&
    (!sameIdentity(journal.preflightSnapshot.sourceIdentity, journal.expectedCurrent) ||
      journal.preflightDatabaseReceipt.backupSha256 !==
        journal.preflightSnapshot.database.artifact.sha256 ||
      (probe !== null && !timestampNotBefore(journal.preflightSnapshot.createdAt, probe.probedAt)))
  ) {
    return false;
  }
  const current = journal.currentObservationReceipt;
  if (current && !sameIdentity(current.sourceIdentity, journal.expectedCurrent)) return false;
  const maintenance = journal.maintenanceReceipt;
  if (
    maintenance &&
    (!current ||
      !sameIdentity(maintenance.sourceIdentity, journal.expectedCurrent) ||
      maintenance.sourceRuntimeId !== current.runtimeId ||
      maintenance.sourceHubInstanceId !== current.hubInstanceId ||
      !timestampNotBefore(maintenance.enteredAt, current.observedAt) ||
      !timestampNotBefore(maintenance.securityState.observedAt, current.observedAt))
  ) {
    return false;
  }
  const pause = journal.supervisorPauseReceipt;
  if (
    pause &&
    (!maintenance ||
      pause.operationId !== journal.operationId ||
      pause.maintenanceId !== maintenance.maintenanceId ||
      pause.fenceId !== maintenance.fenceId ||
      pause.releasePointerRevision !== maintenance.releasePointerRevision ||
      pause.atomicJournalRevision >= journal.revision ||
      pause.subjects.some(
        (subject) => !sameIdentity(subject.subjectProof.build, journal.expectedCurrent),
      ) ||
      !timestampNotBefore(pause.pausedAt, maintenance.enteredAt))
  ) {
    return false;
  }
  const stopReceipt = journal.stopReceipt;
  if (
    stopReceipt &&
    (!maintenance ||
      stopReceipt.maintenanceId !== maintenance.maintenanceId ||
      stopReceipt.fenceId !== maintenance.fenceId ||
      !sameIdentity(stopReceipt.sourceIdentity, journal.expectedCurrent) ||
      stopReceipt.sourceRuntimeId !== maintenance.sourceRuntimeId ||
      stopReceipt.sourceHubInstanceId !== maintenance.sourceHubInstanceId ||
      !timestampNotBefore(stopReceipt.stoppedAt, maintenance.enteredAt))
  ) {
    return false;
  }
  const finalFields = [
    journal.finalSnapshot,
    journal.finalDatabaseReceipt,
    journal.finalSnapshotSecurityReceipt,
  ];
  if (finalFields.some((item) => item === null) && finalFields.some((item) => item !== null)) {
    return false;
  }
  if (
    journal.finalSnapshot &&
    journal.finalDatabaseReceipt &&
    journal.finalSnapshotSecurityReceipt &&
    (!maintenance ||
      !stopReceipt ||
      !sameIdentity(journal.finalSnapshot.sourceIdentity, journal.expectedCurrent) ||
      journal.finalSnapshot.quiescenceProof.fenceId !== maintenance.fenceId ||
      journal.finalSnapshot.quiescenceProof.stopReceiptId !== stopReceipt.stopReceiptId ||
      journal.finalSnapshot.quiescenceProof.observedAt !== stopReceipt.stoppedAt ||
      journal.finalDatabaseReceipt.backupSha256 !==
        journal.finalSnapshot.database.artifact.sha256 ||
      journal.finalSnapshotSecurityReceipt.snapshotId !== journal.finalSnapshot.snapshotId ||
      journal.finalSnapshotSecurityReceipt.securityEpoch <
        maintenance.securityState.securityEpoch ||
      journal.finalSnapshotSecurityReceipt.securityEventSequence <
        maintenance.securityState.securityEventSequence ||
      !timestampNotBefore(journal.finalSnapshot.createdAt, stopReceipt.stoppedAt))
  ) {
    return false;
  }
  const swap = journal.swapReceipt;
  if (
    swap &&
    (!pause ||
      swap.operationId !== journal.operationId ||
      swap.previousPointerRevision !== pause.releasePointerRevision ||
      !sameIdentity(swap.sourceIdentity, journal.expectedCurrent) ||
      !sameIdentity(swap.candidateIdentity, journal.expectedCandidate) ||
      !sameIdentity(swap.installedIdentity, journal.expectedCandidate) ||
      swap.previousArtifactSha256 !== journal.expectedCurrent.manifestSha256 ||
      swap.candidateArtifactSha256 !== journal.expectedCandidate.manifestSha256 ||
      swap.installedArtifactSha256 !== journal.expectedCandidate.manifestSha256)
  ) {
    return false;
  }
  const exactMaintenanceReceipt = (
    receipt: { maintenanceId: string; identity: ReleaseIdentity },
    identity: ReleaseIdentity,
  ) =>
    Boolean(maintenance) &&
    receipt.maintenanceId === maintenance!.maintenanceId &&
    sameIdentity(receipt.identity, identity);
  if (
    journal.candidateStartReceipt &&
    !exactMaintenanceReceipt(journal.candidateStartReceipt, journal.expectedCandidate)
  ) {
    return false;
  }
  if (
    journal.candidateHealthReceipt &&
    (journal.candidateHealthReceipt.target !== "CANDIDATE" ||
      !journal.candidateStartReceipt ||
      !exactMaintenanceReceipt(journal.candidateHealthReceipt, journal.expectedCandidate) ||
      journal.candidateHealthReceipt.runtimeId !== journal.candidateStartReceipt.runtimeId ||
      journal.candidateHealthReceipt.hubInstanceId !==
        journal.candidateStartReceipt.hubInstanceId ||
      journal.candidateHealthReceipt.boundAddress !== journal.candidateStartReceipt.boundAddress ||
      journal.candidateHealthReceipt.boundPort !== journal.candidateStartReceipt.boundPort)
  ) {
    return false;
  }
  if (
    journal.candidateMigrationReceipt &&
    (!exactMaintenanceReceipt(journal.candidateMigrationReceipt, journal.expectedCandidate) ||
      journal.candidateMigrationReceipt.migrationId !== journal.expectedCandidate.migrationId)
  ) {
    return false;
  }
  const auth = journal.transitionAuthorization;
  if (
    auth &&
    (!pause ||
      !swap ||
      auth.operationId !== journal.operationId ||
      auth.requestFingerprint !== journal.requestFingerprint ||
      auth.authorizedOutcome !== "DEPLOYED" ||
      auth.atomicJournalRevision >= journal.revision ||
      auth.pointerRevision !== swap.pointerRevision ||
      auth.supervisorJournalRevision !== pause.supervisorJournalRevision ||
      auth.pauseReceiptId !== pause.pauseReceiptId ||
      auth.pauseReceiptSha256 !== pause.receiptSha256 ||
      !sameIdentity(auth.sourceIdentity, journal.expectedCurrent) ||
      !sameIdentity(auth.candidateIdentity, journal.expectedCandidate) ||
      !sameIdentity(auth.installedIdentity, journal.expectedCandidate))
  ) {
    return false;
  }
  if (
    journal.bridgeResumeReceipt &&
    (!maintenance ||
      !auth ||
      journal.bridgeResumeReceipt.maintenanceId !== maintenance.maintenanceId ||
      journal.bridgeResumeReceipt.target !== "CANDIDATE" ||
      !releaseEffectsMatch(journal, journal.bridgeResumeReceipt, auth, journal.expectedCandidate))
  ) {
    return false;
  }
  if (
    journal.maintenanceCommitReceipt &&
    (!maintenance ||
      !auth ||
      !journal.bridgeResumeReceipt ||
      journal.maintenanceCommitReceipt.target !== "CANDIDATE" ||
      !exactMaintenanceReceipt(journal.maintenanceCommitReceipt, journal.expectedCandidate) ||
      journal.maintenanceCommitReceipt.atomicJournalRevision >= journal.revision ||
      journal.maintenanceCommitReceipt.releasePointerRevision !== auth.pointerRevision + 1)
  ) {
    return false;
  }
  const restore = journal.restoreReceipt;
  if (
    restore &&
    (!swap ||
      !journal.finalSnapshot ||
      !journal.finalDatabaseReceipt ||
      !journal.finalSnapshotSecurityReceipt ||
      restore.operationId !== journal.operationId ||
      restore.snapshotId !== journal.finalSnapshot.snapshotId ||
      restore.sourceDatabaseIdentitySha256 !==
        journal.finalDatabaseReceipt.sourceDatabaseIdentitySha256 ||
      restore.previousPointerRevision !== swap.pointerRevision ||
      !sameIdentity(restore.restoredIdentity, journal.expectedCurrent) ||
      restore.snapshotSecurityEpoch !== journal.finalSnapshotSecurityReceipt.securityEpoch ||
      restore.replayedThroughSecurityEventSequence <
        journal.finalSnapshotSecurityReceipt.securityEventSequence)
  ) {
    return false;
  }
  if (
    journal.previousStartReceipt &&
    !exactMaintenanceReceipt(journal.previousStartReceipt, journal.expectedCurrent)
  ) {
    return false;
  }
  if (
    journal.previousHealthReceipt &&
    (journal.previousHealthReceipt.target !== "PREVIOUS" ||
      !journal.previousStartReceipt ||
      !exactMaintenanceReceipt(journal.previousHealthReceipt, journal.expectedCurrent) ||
      journal.previousHealthReceipt.runtimeId !== journal.previousStartReceipt.runtimeId ||
      journal.previousHealthReceipt.hubInstanceId !== journal.previousStartReceipt.hubInstanceId ||
      journal.previousHealthReceipt.boundAddress !== journal.previousStartReceipt.boundAddress ||
      journal.previousHealthReceipt.boundPort !== journal.previousStartReceipt.boundPort)
  ) {
    return false;
  }
  const rollbackAuth = journal.rollbackTransitionAuthorization;
  if (
    rollbackAuth &&
    (!pause ||
      !restore ||
      rollbackAuth.operationId !== journal.operationId ||
      rollbackAuth.requestFingerprint !== journal.requestFingerprint ||
      rollbackAuth.authorizedOutcome !== "ROLLED_BACK" ||
      rollbackAuth.atomicJournalRevision >= journal.revision ||
      rollbackAuth.pointerRevision !== restore.pointerRevision ||
      rollbackAuth.supervisorJournalRevision !== pause.supervisorJournalRevision ||
      rollbackAuth.pauseReceiptId !== pause.pauseReceiptId ||
      rollbackAuth.pauseReceiptSha256 !== pause.receiptSha256 ||
      !sameIdentity(rollbackAuth.installedIdentity, journal.expectedCurrent))
  ) {
    return false;
  }
  if (
    journal.rollbackResumeReceipt &&
    (!maintenance ||
      !rollbackAuth ||
      journal.rollbackResumeReceipt.maintenanceId !== maintenance.maintenanceId ||
      journal.rollbackResumeReceipt.target !== "PREVIOUS" ||
      !releaseEffectsMatch(
        journal,
        journal.rollbackResumeReceipt,
        rollbackAuth,
        journal.expectedCurrent,
      ))
  ) {
    return false;
  }
  if (
    journal.rollbackCommitReceipt &&
    (!maintenance ||
      !rollbackAuth ||
      !journal.rollbackResumeReceipt ||
      journal.rollbackCommitReceipt.target !== "PREVIOUS" ||
      !exactMaintenanceReceipt(journal.rollbackCommitReceipt, journal.expectedCurrent) ||
      journal.rollbackCommitReceipt.atomicJournalRevision >= journal.revision ||
      journal.rollbackCommitReceipt.releasePointerRevision !== rollbackAuth.pointerRevision + 1)
  ) {
    return false;
  }
  if (
    journal.preSwapCleanupReceipt &&
    (!maintenance ||
      !journal.cleanupFailedAtPhase ||
      journal.preSwapCleanupReceipt.operationId !== journal.operationId ||
      journal.preSwapCleanupReceipt.maintenanceId !== maintenance.maintenanceId ||
      journal.preSwapCleanupReceipt.failedPhase !== journal.cleanupFailedAtPhase ||
      !sameIdentity(journal.preSwapCleanupReceipt.sourceIdentity, journal.expectedCurrent) ||
      journal.preSwapCleanupReceipt.releasePointerRevision !== maintenance.releasePointerRevision ||
      journal.preSwapCleanupReceipt.securityEpoch < maintenance.securityState.securityEpoch)
  ) {
    return false;
  }
  return true;
}

function journalRelationsValid(journal: AtomicReleaseJournal): boolean {
  if (
    journal.requestFingerprint !==
      requestFingerprint({
        operationId: journal.operationId,
        candidateId: journal.candidateId,
        expectedCurrent: journal.expectedCurrent,
        expectedCandidate: journal.expectedCandidate,
      }) ||
    sameIdentity(journal.expectedCurrent, journal.expectedCandidate) ||
    !receiptRelationsValid(journal)
  ) {
    return false;
  }
  const isErrorTerminal = journal.phase === "BLOCKED" || journal.phase === "ROLLBACK_FAILED";
  if (isErrorTerminal !== (journal.terminalCode !== null && journal.failedAtPhase !== null)) {
    return false;
  }
  if (!isErrorTerminal && (journal.terminalCode !== null || journal.failedAtPhase !== null)) {
    return false;
  }
  const cleanupActive =
    journal.phase === "PRE_SWAP_CLEANUP_INTENT" ||
    journal.phase === "PRE_SWAP_CLEANUP_CONFIRMED" ||
    (journal.phase === "BLOCKED" && journal.cleanupCauseCode !== null);
  if (
    cleanupActive !== (journal.cleanupCauseCode !== null && journal.cleanupFailedAtPhase !== null)
  ) {
    return false;
  }
  if (!cleanupActive && (journal.preSwapCleanupReceipt !== null || journal.cleanupFailedAtPhase)) {
    return false;
  }
  if (journal.phase === "PRE_SWAP_CLEANUP_INTENT" && journal.preSwapCleanupReceipt !== null) {
    return false;
  }
  if (
    (journal.phase === "PRE_SWAP_CLEANUP_CONFIRMED" ||
      (journal.phase === "BLOCKED" && cleanupActive)) &&
    journal.preSwapCleanupReceipt === null
  ) {
    return false;
  }
  if (cleanupActive) return journal.rollbackCauseCode === null;

  const effectivePhase = isErrorTerminal ? journal.failedAtPhase! : journal.phase;
  const normal = normalRank(effectivePhase);
  if (normal >= 0) {
    if (journal.rollbackCauseCode !== null) return false;
    const fields: Array<[unknown, AtomicReleaseJournalPhase]> = [
      [journal.candidateProbe, "CANDIDATE_VALIDATED"],
      [journal.preflightSnapshot, "PREFLIGHT_SNAPSHOT_READY"],
      [journal.preflightDatabaseReceipt, "PREFLIGHT_SNAPSHOT_READY"],
      [journal.currentObservationReceipt, "CURRENT_REVALIDATED"],
      [journal.maintenanceReceipt, "MAINTENANCE_ENTERED"],
      [journal.supervisorPauseReceipt, "SUPERVISORS_PAUSED"],
      [journal.stopReceipt, "STOP_RECEIPT_CONFIRMED"],
      [journal.finalSnapshot, "FINAL_SNAPSHOT_READY"],
      [journal.finalDatabaseReceipt, "FINAL_SNAPSHOT_READY"],
      [journal.finalSnapshotSecurityReceipt, "FINAL_SNAPSHOT_READY"],
      [journal.swapReceipt, "SWAPPED"],
      [journal.candidateStartReceipt, "CANDIDATE_MAINTENANCE_STARTED"],
      [journal.candidateHealthReceipt, "CANDIDATE_MAINTENANCE_HEALTHY"],
      [journal.candidateMigrationReceipt, "CANDIDATE_MIGRATED"],
      [journal.transitionAuthorization, "BRIDGE_TRANSITION_AUTHORIZED"],
      [journal.bridgeResumeReceipt, "BRIDGES_RESUMED"],
      [journal.maintenanceCommitReceipt, "MAINTENANCE_COMMITTED"],
    ];
    if (fields.some(([value, phase]) => !expectedPresence(value, normal >= normalRank(phase)))) {
      return false;
    }
    return (
      journal.restoreReceipt === null &&
      journal.previousStartReceipt === null &&
      journal.previousHealthReceipt === null &&
      journal.rollbackTransitionAuthorization === null &&
      journal.rollbackResumeReceipt === null &&
      journal.rollbackCommitReceipt === null
    );
  }
  const rollback = rollbackRank(effectivePhase);
  if (
    rollback < 0 ||
    !journal.rollbackCauseCode ||
    !ROLLBACK_CAUSES.has(journal.rollbackCauseCode)
  ) {
    return false;
  }
  const cause = journal.rollbackCauseCode;
  const candidateStarted = cause !== "CANDIDATE_MAINTENANCE_START_FAILED";
  const candidateHealthy =
    cause !== "CANDIDATE_MAINTENANCE_START_FAILED" && cause !== "CANDIDATE_HEALTH_FAILED";
  const candidateMigrated =
    cause === "BRIDGE_RESUME_FAILED" || cause === "MAINTENANCE_COMMIT_FAILED";
  return (
    journal.candidateProbe !== null &&
    journal.preflightSnapshot !== null &&
    journal.preflightDatabaseReceipt !== null &&
    journal.currentObservationReceipt !== null &&
    journal.maintenanceReceipt !== null &&
    journal.supervisorPauseReceipt !== null &&
    journal.stopReceipt !== null &&
    journal.finalSnapshot !== null &&
    journal.finalDatabaseReceipt !== null &&
    journal.finalSnapshotSecurityReceipt !== null &&
    journal.swapReceipt !== null &&
    expectedPresence(journal.candidateStartReceipt, candidateStarted) &&
    expectedPresence(journal.candidateHealthReceipt, candidateHealthy) &&
    expectedPresence(journal.candidateMigrationReceipt, candidateMigrated) &&
    expectedPresence(
      journal.transitionAuthorization,
      cause === "BRIDGE_RESUME_FAILED" || cause === "MAINTENANCE_COMMIT_FAILED",
    ) &&
    expectedPresence(journal.bridgeResumeReceipt, cause === "MAINTENANCE_COMMIT_FAILED") &&
    journal.maintenanceCommitReceipt === null &&
    expectedPresence(journal.restoreReceipt, rollback >= 2) &&
    expectedPresence(journal.previousStartReceipt, rollback >= 3) &&
    expectedPresence(journal.previousHealthReceipt, rollback >= 5) &&
    expectedPresence(journal.rollbackTransitionAuthorization, rollback >= 7) &&
    expectedPresence(journal.rollbackResumeReceipt, rollback >= 9) &&
    expectedPresence(journal.rollbackCommitReceipt, rollback >= 11)
  );
}

function isDeploymentObservation(value: unknown): value is DeploymentObservation {
  if (!isRecord(value) || !exactKeys(value, ["observedAt", "installed", "runtime"])) {
    return false;
  }
  if (!isIsoTimestamp(value.observedAt) || !isRecord(value.installed) || !isRecord(value.runtime)) {
    return false;
  }
  const installedValid =
    (exactKeys(value.installed, ["state"]) && value.installed.state === "UNKNOWN") ||
    (exactKeys(value.installed, ["state", "identity"]) &&
      value.installed.state === "KNOWN" &&
      isReleaseIdentity(value.installed.identity));
  const runtimeValid =
    (exactKeys(value.runtime, ["state"]) &&
      (value.runtime.state === "STOPPED" || value.runtime.state === "UNKNOWN")) ||
    (exactKeys(value.runtime, [
      "state",
      "identity",
      "runtimeId",
      "hubInstanceId",
      "boundAddress",
      "boundPort",
      "mode",
    ]) &&
      value.runtime.state === "RUNNING" &&
      isReleaseIdentity(value.runtime.identity) &&
      typeof value.runtime.runtimeId === "string" &&
      RECEIPT_ID_PATTERN.test(value.runtime.runtimeId) &&
      typeof value.runtime.hubInstanceId === "string" &&
      RECEIPT_ID_PATTERN.test(value.runtime.hubInstanceId) &&
      (value.runtime.boundAddress === "127.0.0.1" || value.runtime.boundAddress === "::1") &&
      isPositiveInteger(value.runtime.boundPort) &&
      value.runtime.boundPort <= 65_535 &&
      (value.runtime.mode === "NORMAL" || value.runtime.mode === "MAINTENANCE"));
  return installedValid && runtimeValid;
}

function installedIs(observation: DeploymentObservation, identity: ReleaseIdentity): boolean {
  return (
    observation.installed.state === "KNOWN" &&
    sameIdentity(observation.installed.identity, identity)
  );
}

function runningIs(
  observation: DeploymentObservation,
  identity: ReleaseIdentity,
  mode: "NORMAL" | "MAINTENANCE",
): boolean {
  return (
    observation.runtime.state === "RUNNING" &&
    observation.runtime.mode === mode &&
    sameIdentity(observation.runtime.identity, identity)
  );
}

function stopped(observation: DeploymentObservation): boolean {
  return observation.runtime.state === "STOPPED";
}

function unknownObservation(observation: DeploymentObservation | null): boolean {
  return (
    observation === null ||
    observation.installed.state === "UNKNOWN" ||
    observation.runtime.state === "UNKNOWN"
  );
}

function idempotencyKey(journal: AtomicReleaseJournal, phase: AtomicReleaseJournalPhase): string {
  return `atomic-release:${journal.operationId}:${journal.requestFingerprint}:${phase}`;
}

export class AtomicReleaseManager {
  private readonly journalStore: AtomicReleaseJournalStore;
  private readonly adapters: AtomicReleaseAdapters;
  private readonly now: () => string;
  private readonly ownerId: string;
  private readonly activeLeaseDurationMs: number;
  private readonly inFlight = new Map<string, InFlightEntry>();
  private readonly activeLeases = new Map<string, LeaseContext>();

  constructor(options: AtomicReleaseManagerOptions) {
    this.journalStore = options.journalStore;
    this.adapters = options.adapters;
    this.now = options.now ?? (() => new Date().toISOString());
    this.ownerId = options.ownerId ?? `atomic-release-owner:${randomUUID()}`;
    this.activeLeaseDurationMs = options.activeLeaseDurationMs ?? 5 * 60 * 1000;
  }

  run(request: AtomicReleaseRequest): Promise<AtomicReleaseOutcome> {
    if (!isRequestValid(request)) {
      return Promise.resolve({
        state: "BLOCKED",
        operationId: request.operationId,
        code: "REQUEST_INVALID",
        phase: "CANDIDATE_PROBE_INTENT",
      });
    }
    const fingerprint = requestFingerprint(request);
    const active = this.inFlight.get(request.operationId);
    if (active) {
      return active.fingerprint === fingerprint
        ? active.promise
        : Promise.resolve(this.conflictOutcome(request.operationId));
    }
    const promise = this.executeWithLease(clone(request), fingerprint).finally(() => {
      const current = this.inFlight.get(request.operationId);
      if (current?.promise === promise) this.inFlight.delete(request.operationId);
    });
    this.inFlight.set(request.operationId, { fingerprint, promise });
    return promise;
  }

  private async executeWithLease(
    request: AtomicReleaseRequest,
    fingerprint: string,
  ): Promise<AtomicReleaseOutcome> {
    const now = this.now();
    const leaseRequest: AtomicReleaseActiveLeaseRequest = {
      leaseKey: "atomic-release/global",
      operationId: request.operationId,
      requestFingerprint: fingerprint,
      ownerId: this.ownerId,
      expiresAt: new Date(Date.parse(now) + this.activeLeaseDurationMs).toISOString(),
    };
    let acquired: { state: "ACQUIRED"; claim: AtomicReleaseActiveLeaseClaim } | { state: "HELD" };
    try {
      acquired = await this.journalStore.acquireActiveLease(leaseRequest);
    } catch {
      return this.recoveryOutcome(
        request.operationId,
        "ACTIVE_OPERATION_LEASE_UNAVAILABLE",
        "CANDIDATE_PROBE_INTENT",
      );
    }
    if (acquired.state === "HELD") {
      return this.recoveryOutcome(
        request.operationId,
        "ACTIVE_OPERATION_HELD",
        "CANDIDATE_PROBE_INTENT",
      );
    }
    const lease: LeaseContext = { claim: clone(acquired.claim), lost: false };
    let outcome: AtomicReleaseOutcome;
    this.activeLeases.set(request.operationId, lease);
    try {
      outcome = await this.execute(request, fingerprint, lease);
    } catch (error) {
      if (error instanceof ActiveLeaseLostError) {
        return this.recoveryOutcome(
          request.operationId,
          "ACTIVE_OPERATION_LEASE_LOST",
          "CANDIDATE_PROBE_INTENT",
        );
      }
      throw error;
    } finally {
      this.activeLeases.delete(request.operationId);
    }
    const terminal = await this.terminalLeaseProof(outcome, fingerprint, lease);
    if (terminal) {
      try {
        await this.journalStore.releaseActiveLease(clone(lease.claim), terminal);
      } catch {
        // The durable slot remains bound; a later exact terminal reconciliation can release it.
      }
    }
    return outcome;
  }

  private conflictOutcome(operationId: string): AtomicReleaseOutcome {
    return {
      state: "BLOCKED",
      operationId,
      code: "REQUEST_CONFLICT",
      phase: "CANDIDATE_PROBE_INTENT",
    };
  }

  private async execute(
    request: AtomicReleaseRequest,
    fingerprint: string,
    lease: LeaseContext,
  ): Promise<AtomicReleaseOutcome> {
    const loadedJournal = await this.loadOrCreate(request, fingerprint, lease);
    if (!loadedJournal) return this.corruptOutcome(request.operationId);
    if (loadedJournal.requestFingerprint !== fingerprint) {
      return this.conflictOutcome(request.operationId);
    }
    let journal: AtomicReleaseJournal = loadedJournal;

    for (let steps = 0; steps < 100; steps += 1) {
      if (!isJournal(journal) || !journalRelationsValid(journal)) {
        return this.corruptOutcome(request.operationId);
      }
      const intent = {
        operationId: journal.operationId,
        idempotencyKey: idempotencyKey(journal, journal.phase),
        activeLease: lease.claim,
      };

      switch (journal.phase) {
        case "CANDIDATE_PROBE_INTENT": {
          const result = await this.callAdapter(() =>
            this.adapters.probeCandidate({
              ...intent,
              candidateId: journal.candidateId,
              expectedIdentity: clone(journal.expectedCandidate),
              isolation: "BACKUP_COPY",
              port: 0,
            }),
          );
          if (!result || result.state === "AMBIGUOUS") {
            return this.recoveryRequired(journal, "CANDIDATE_PROBE_FAILED");
          }
          if (result.state === "REJECTED") return this.block(journal, "CANDIDATE_PROBE_FAILED");
          if (
            !isCandidateProbeReceipt(result.receipt) ||
            result.receipt.candidateId !== journal.candidateId ||
            !sameIdentity(result.receipt.identity, journal.expectedCandidate)
          ) {
            return this.block(journal, "CANDIDATE_IDENTITY_MISMATCH");
          }
          journal = await this.transition(journal, {
            phase: "CANDIDATE_VALIDATED",
            candidateProbe: clone(result.receipt),
          });
          break;
        }
        case "CANDIDATE_VALIDATED":
          journal = await this.transition(journal, { phase: "PREFLIGHT_SNAPSHOT_INTENT" });
          break;
        case "PREFLIGHT_SNAPSHOT_INTENT": {
          const result = await this.callAdapter(() =>
            this.adapters.createOnlinePreflightSnapshot({
              ...intent,
              expectedCurrent: clone(journal.expectedCurrent),
            }),
          );
          if (!result || result.state === "AMBIGUOUS") {
            return this.recoveryRequired(journal, "PREFLIGHT_SNAPSHOT_FAILED");
          }
          if (result.state === "REJECTED") return this.block(journal, "PREFLIGHT_SNAPSHOT_FAILED");
          if (
            !isOnlinePreflightSnapshot(result.manifest) ||
            !isSnapshotDatabaseReceipt(result.receipt) ||
            !sameIdentity(result.manifest.sourceIdentity, journal.expectedCurrent) ||
            result.receipt.backupSha256 !== result.manifest.database.artifact.sha256
          ) {
            return this.block(journal, "PREFLIGHT_SNAPSHOT_MANIFEST_INVALID");
          }
          journal = await this.transition(journal, {
            phase: "PREFLIGHT_SNAPSHOT_READY",
            preflightSnapshot: clone(result.manifest),
            preflightDatabaseReceipt: clone(result.receipt),
          });
          break;
        }
        case "PREFLIGHT_SNAPSHOT_READY":
          journal = await this.transition(journal, { phase: "CURRENT_REVALIDATE_INTENT" });
          break;
        case "CURRENT_REVALIDATE_INTENT": {
          const observation = await this.observeOrNull(journal.operationId);
          if (unknownObservation(observation)) {
            return this.recoveryRequired(journal, "CURRENT_OBSERVATION_FAILED");
          }
          if (
            !installedIs(observation!, journal.expectedCurrent) ||
            !runningIs(observation!, journal.expectedCurrent, "NORMAL") ||
            observation!.runtime.state !== "RUNNING"
          ) {
            return this.block(journal, "CURRENT_IDENTITY_CHANGED");
          }
          journal = await this.transition(journal, {
            phase: "CURRENT_REVALIDATED",
            currentObservationReceipt: {
              sourceIdentity: clone(journal.expectedCurrent),
              runtimeId: observation!.runtime.runtimeId,
              hubInstanceId: observation!.runtime.hubInstanceId,
              boundAddress: observation!.runtime.boundAddress,
              boundPort: observation!.runtime.boundPort,
              mode: "NORMAL",
              observedAt: observation!.observedAt,
            },
          });
          break;
        }
        case "CURRENT_REVALIDATED":
          journal = await this.transition(journal, { phase: "ENTER_MAINTENANCE_INTENT" });
          break;
        case "ENTER_MAINTENANCE_INTENT": {
          const current = journal.currentObservationReceipt;
          if (!current) return this.corruptOutcome(journal.operationId);
          const result = await this.callAdapter(() =>
            this.adapters.enterHubMaintenance({
              ...intent,
              expectedCurrent: clone(journal.expectedCurrent),
              expectedRuntimeId: current.runtimeId,
              expectedHubInstanceId: current.hubInstanceId,
              scope: "HUB_WIDE",
            }),
          );
          if (!result || result.state === "AMBIGUOUS") {
            return this.recoveryRequired(journal, "MAINTENANCE_ENTER_AMBIGUOUS");
          }
          if (result.state === "REJECTED") return this.block(journal, "MAINTENANCE_ENTER_FAILED");
          if (
            !isHubMaintenanceReceipt(result.receipt) ||
            !sameIdentity(result.receipt.sourceIdentity, journal.expectedCurrent) ||
            result.receipt.sourceRuntimeId !== current.runtimeId ||
            result.receipt.sourceHubInstanceId !== current.hubInstanceId
          ) {
            return this.recoveryRequired(journal, "MAINTENANCE_ENTER_AMBIGUOUS");
          }
          journal = await this.transition(journal, {
            phase: "MAINTENANCE_ENTERED",
            maintenanceReceipt: clone(result.receipt),
          });
          break;
        }
        case "MAINTENANCE_ENTERED":
          journal = await this.transition(journal, { phase: "PAUSE_SUPERVISORS_INTENT" });
          break;
        case "PAUSE_SUPERVISORS_INTENT": {
          const maintenance = this.requireMaintenance(journal);
          if (!maintenance) return this.corruptOutcome(journal.operationId);
          const result = await this.callAdapter(() =>
            this.adapters.pauseManagedBridgeSupervisors({
              ...intent,
              maintenanceId: maintenance.maintenanceId,
              fenceId: maintenance.fenceId,
              atomicJournalRevision: journal.revision,
            }),
          );
          if (!result || result.state === "AMBIGUOUS") {
            return this.recoveryRequired(journal, "SUPERVISOR_PAUSE_AMBIGUOUS");
          }
          if (result.state === "REJECTED") {
            journal = await this.beginPreSwapCleanup(journal, "SUPERVISOR_PAUSE_FAILED");
            break;
          }
          if (
            !isSupervisorPauseReceipt(result.receipt) ||
            result.receipt.operationId !== journal.operationId ||
            result.receipt.maintenanceId !== maintenance.maintenanceId ||
            result.receipt.fenceId !== maintenance.fenceId ||
            result.receipt.atomicJournalRevision !== journal.revision
          ) {
            return this.recoveryRequired(journal, "SUPERVISOR_PAUSE_AMBIGUOUS");
          }
          journal = await this.transition(journal, {
            phase: "SUPERVISORS_PAUSED",
            supervisorPauseReceipt: clone(result.receipt),
          });
          break;
        }
        case "SUPERVISORS_PAUSED":
          journal = await this.transition(journal, { phase: "STOP_INTENT" });
          break;
        case "STOP_INTENT": {
          const maintenance = this.requireMaintenance(journal);
          const current = journal.currentObservationReceipt;
          if (!maintenance || !current) return this.corruptOutcome(journal.operationId);
          const result = await this.callAdapter(() =>
            this.adapters.stopCurrentCooperatively({
              ...intent,
              maintenanceId: maintenance.maintenanceId,
              fenceId: maintenance.fenceId,
              expectedIdentity: clone(journal.expectedCurrent),
              expectedRuntimeId: current.runtimeId,
              expectedHubInstanceId: current.hubInstanceId,
            }),
          );
          if (!result || result.state === "AMBIGUOUS") {
            return this.recoveryRequired(journal, "STOP_OUTCOME_AMBIGUOUS");
          }
          if (result.state === "REJECTED") {
            journal = await this.beginPreSwapCleanup(journal, "STOP_FAILED");
            break;
          }
          if (
            !isCooperativeStopReceipt(result.receipt) ||
            result.receipt.maintenanceId !== maintenance.maintenanceId ||
            result.receipt.fenceId !== maintenance.fenceId ||
            !sameIdentity(result.receipt.sourceIdentity, journal.expectedCurrent) ||
            result.receipt.sourceRuntimeId !== current.runtimeId ||
            result.receipt.sourceHubInstanceId !== current.hubInstanceId
          ) {
            return this.recoveryRequired(journal, "STOP_OUTCOME_AMBIGUOUS");
          }
          journal = await this.transition(journal, {
            phase: "STOP_RECEIPT_CONFIRMED",
            stopReceipt: clone(result.receipt),
          });
          break;
        }
        case "STOP_RECEIPT_CONFIRMED": {
          const observation = await this.observeOrNull(journal.operationId);
          if (unknownObservation(observation)) {
            return this.recoveryRequired(journal, "STOP_OUTCOME_AMBIGUOUS");
          }
          if (!installedIs(observation!, journal.expectedCurrent) || !stopped(observation!)) {
            return this.block(journal, "STOP_FAILED");
          }
          journal = await this.transition(journal, { phase: "STOPPED" });
          break;
        }
        case "STOPPED":
          journal = await this.transition(journal, { phase: "FINAL_SNAPSHOT_INTENT" });
          break;
        case "FINAL_SNAPSHOT_INTENT": {
          const proof = this.quiescenceProof(journal);
          if (!proof) return this.corruptOutcome(journal.operationId);
          const result = await this.callAdapter(() =>
            this.adapters.createFinalRollbackSnapshot({
              ...intent,
              expectedCurrent: clone(journal.expectedCurrent),
              expectedCandidate: clone(journal.expectedCandidate),
              quiescenceProof: clone(proof),
            }),
          );
          if (!result || result.state === "AMBIGUOUS") {
            return this.recoveryRequired(journal, "FINAL_SNAPSHOT_FAILED");
          }
          if (result.state === "REJECTED") {
            journal = await this.beginPreSwapCleanup(journal, "FINAL_SNAPSHOT_FAILED");
            break;
          }
          if (
            !isFinalRollbackSnapshot(result.manifest) ||
            !isRecord(result.receipt) ||
            !exactKeys(result.receipt, ["database", "security"]) ||
            !isSnapshotDatabaseReceipt(result.receipt.database) ||
            !isFinalSnapshotSecurityReceipt(result.receipt.security) ||
            !sameIdentity(result.manifest.sourceIdentity, journal.expectedCurrent) ||
            result.receipt.database.backupSha256 !== result.manifest.database.artifact.sha256 ||
            result.receipt.security.snapshotId !== result.manifest.snapshotId ||
            result.manifest.quiescenceProof.fenceId !== proof.fenceId ||
            result.manifest.quiescenceProof.stopReceiptId !== proof.stopReceiptId ||
            result.manifest.quiescenceProof.observedAt !== proof.observedAt
          ) {
            return this.block(journal, "FINAL_SNAPSHOT_MANIFEST_INVALID");
          }
          journal = await this.transition(journal, {
            phase: "FINAL_SNAPSHOT_READY",
            finalSnapshot: clone(result.manifest),
            finalDatabaseReceipt: clone(result.receipt.database),
            finalSnapshotSecurityReceipt: clone(result.receipt.security),
          });
          break;
        }
        case "FINAL_SNAPSHOT_READY":
          journal = await this.transition(journal, { phase: "SWAP_INTENT" });
          break;
        case "SWAP_INTENT": {
          const finalSnapshot = this.requireFinalSnapshot(journal);
          const pause = journal.supervisorPauseReceipt;
          if (!finalSnapshot || !pause) return this.corruptOutcome(journal.operationId);
          const result = await this.callAdapter(() =>
            this.adapters.atomicSwap({
              ...intent,
              candidateId: journal.candidateId,
              expectedCurrent: clone(journal.expectedCurrent),
              expectedCandidate: clone(journal.expectedCandidate),
              expectedPointerRevision: pause.releasePointerRevision,
              finalSnapshot: clone(finalSnapshot),
            }),
          );
          if (!result || result.state === "AMBIGUOUS") {
            return this.recoveryRequired(journal, "SWAP_OUTCOME_AMBIGUOUS");
          }
          if (result.state === "REJECTED") {
            journal = await this.beginPreSwapCleanup(journal, "SWAP_FAILED");
            break;
          }
          if (
            !isAtomicSwapReceipt(result.receipt) ||
            result.receipt.operationId !== journal.operationId ||
            result.receipt.previousPointerRevision !== pause.releasePointerRevision ||
            !sameIdentity(result.receipt.sourceIdentity, journal.expectedCurrent) ||
            !sameIdentity(result.receipt.candidateIdentity, journal.expectedCandidate) ||
            !sameIdentity(result.receipt.installedIdentity, journal.expectedCandidate)
          ) {
            return this.recoveryRequired(journal, "SWAP_OUTCOME_AMBIGUOUS");
          }
          journal = await this.transition(journal, {
            phase: "SWAPPED",
            swapReceipt: clone(result.receipt),
          });
          break;
        }
        case "SWAPPED": {
          const observation = await this.observeOrNull(journal.operationId);
          if (
            unknownObservation(observation) ||
            !installedIs(observation!, journal.expectedCandidate) ||
            !stopped(observation!)
          ) {
            return this.recoveryRequired(journal, "SWAP_OUTCOME_AMBIGUOUS");
          }
          journal = await this.transition(journal, {
            phase: "START_CANDIDATE_MAINTENANCE_INTENT",
          });
          break;
        }
        case "START_CANDIDATE_MAINTENANCE_INTENT": {
          const maintenance = this.requireMaintenance(journal);
          if (!maintenance) return this.corruptOutcome(journal.operationId);
          const result = await this.callAdapter(() =>
            this.adapters.startCandidateInMaintenance({
              ...intent,
              maintenanceId: maintenance.maintenanceId,
              expectedIdentity: clone(journal.expectedCandidate),
            }),
          );
          if (!result || result.state === "AMBIGUOUS") {
            return this.recoveryRequired(journal, "CANDIDATE_MAINTENANCE_START_AMBIGUOUS");
          }
          if (result.state === "REJECTED") {
            journal = await this.beginRollback(journal, "CANDIDATE_MAINTENANCE_START_FAILED");
            break;
          }
          if (
            !isMaintenanceRuntimeReceipt(result.receipt) ||
            result.receipt.maintenanceId !== maintenance.maintenanceId ||
            !sameIdentity(result.receipt.identity, journal.expectedCandidate)
          ) {
            return this.recoveryRequired(journal, "CANDIDATE_MAINTENANCE_START_AMBIGUOUS");
          }
          journal = await this.transition(journal, {
            phase: "CANDIDATE_MAINTENANCE_STARTED",
            candidateStartReceipt: clone(result.receipt),
          });
          break;
        }
        case "CANDIDATE_MAINTENANCE_STARTED":
          journal = await this.transition(journal, {
            phase: "VERIFY_CANDIDATE_MAINTENANCE_INTENT",
          });
          break;
        case "VERIFY_CANDIDATE_MAINTENANCE_INTENT": {
          const maintenance = this.requireMaintenance(journal);
          const start = journal.candidateStartReceipt;
          if (!maintenance || !start) return this.corruptOutcome(journal.operationId);
          const result = await this.callAdapter(() =>
            this.adapters.probeMaintenanceHealth({
              ...intent,
              maintenanceId: maintenance.maintenanceId,
              target: "CANDIDATE",
              expectedIdentity: clone(journal.expectedCandidate),
              expectedBoundAddress: start.boundAddress,
              expectedBoundPort: start.boundPort,
              expectedRuntimeId: start.runtimeId,
              expectedHubInstanceId: start.hubInstanceId,
            }),
          );
          if (!result || result.state === "AMBIGUOUS") {
            return this.recoveryRequired(journal, "CANDIDATE_HEALTH_FAILED");
          }
          if (result.state === "UNHEALTHY") {
            journal = await this.beginRollback(journal, "CANDIDATE_HEALTH_FAILED");
            break;
          }
          if (
            !isMaintenanceHealthReceipt(result.receipt) ||
            result.receipt.maintenanceId !== maintenance.maintenanceId ||
            result.receipt.target !== "CANDIDATE" ||
            !sameIdentity(result.receipt.identity, journal.expectedCandidate) ||
            result.receipt.runtimeId !== start.runtimeId ||
            result.receipt.hubInstanceId !== start.hubInstanceId ||
            result.receipt.boundAddress !== start.boundAddress ||
            result.receipt.boundPort !== start.boundPort
          ) {
            return this.recoveryRequired(journal, "CANDIDATE_HEALTH_FAILED");
          }
          journal = await this.transition(journal, {
            phase: "CANDIDATE_MAINTENANCE_HEALTHY",
            candidateHealthReceipt: clone(result.receipt),
          });
          break;
        }
        case "CANDIDATE_MAINTENANCE_HEALTHY":
          journal = await this.transition(journal, { phase: "MIGRATE_CANDIDATE_INTENT" });
          break;
        case "MIGRATE_CANDIDATE_INTENT": {
          const maintenance = this.requireMaintenance(journal);
          if (!maintenance) return this.corruptOutcome(journal.operationId);
          const result = await this.callAdapter(() =>
            this.adapters.migrateCandidateInMaintenance({
              ...intent,
              maintenanceId: maintenance.maintenanceId,
              expectedIdentity: clone(journal.expectedCandidate),
            }),
          );
          if (!result || result.state === "AMBIGUOUS") {
            return this.recoveryRequired(journal, "CANDIDATE_MIGRATION_AMBIGUOUS");
          }
          if (result.state === "REJECTED") {
            journal = await this.beginRollback(journal, "CANDIDATE_MIGRATION_FAILED");
            break;
          }
          if (
            !isCandidateMigrationReceipt(result.receipt) ||
            result.receipt.maintenanceId !== maintenance.maintenanceId ||
            !sameIdentity(result.receipt.identity, journal.expectedCandidate) ||
            result.receipt.migrationId !== journal.expectedCandidate.migrationId
          ) {
            return this.recoveryRequired(journal, "CANDIDATE_MIGRATION_AMBIGUOUS");
          }
          journal = await this.transition(journal, {
            phase: "CANDIDATE_MIGRATED",
            candidateMigrationReceipt: clone(result.receipt),
          });
          break;
        }
        case "CANDIDATE_MIGRATED":
          journal = await this.transition(journal, { phase: "AUTHORIZE_BRIDGES_INTENT" });
          break;
        case "AUTHORIZE_BRIDGES_INTENT": {
          const authorization = this.createTransitionAuthorization(journal, "DEPLOYED");
          if (!authorization) return this.corruptOutcome(journal.operationId);
          journal = await this.transition(journal, {
            phase: "BRIDGE_TRANSITION_AUTHORIZED",
            transitionAuthorization: authorization,
          });
          break;
        }
        case "BRIDGE_TRANSITION_AUTHORIZED":
          journal = await this.transition(journal, { phase: "RESUME_BRIDGES_INTENT" });
          break;
        case "RESUME_BRIDGES_INTENT": {
          const maintenance = this.requireMaintenance(journal);
          const authorization = journal.transitionAuthorization;
          if (!maintenance || !authorization) return this.corruptOutcome(journal.operationId);
          const result = await this.callAdapter(() =>
            this.adapters.resumePreviouslyRunningBridges({
              ...intent,
              transitionAuthorizationId: authorization.authorizationId,
              expectedAuthorizationSha256: authorization.authorizationSha256,
            }),
          );
          if (!result || result.state === "AMBIGUOUS") {
            return this.recoveryRequired(journal, "BRIDGE_RESUME_AMBIGUOUS");
          }
          if (result.state === "REJECTED") {
            journal = await this.beginRollback(journal, "BRIDGE_RESUME_FAILED");
            break;
          }
          if (
            !isBridgeResumeReceipt(result.receipt) ||
            result.receipt.maintenanceId !== maintenance.maintenanceId ||
            result.receipt.target !== "CANDIDATE" ||
            !releaseEffectsMatch(journal, result.receipt, authorization, journal.expectedCandidate)
          ) {
            return this.recoveryRequired(journal, "BRIDGE_RESUME_AMBIGUOUS");
          }
          journal = await this.transition(journal, {
            phase: "BRIDGES_RESUMED",
            bridgeResumeReceipt: clone(result.receipt),
          });
          break;
        }
        case "BRIDGES_RESUMED":
          journal = await this.transition(journal, { phase: "COMMIT_MAINTENANCE_INTENT" });
          break;
        case "COMMIT_MAINTENANCE_INTENT": {
          const maintenance = this.requireMaintenance(journal);
          const authorization = journal.transitionAuthorization;
          if (!maintenance || !authorization) return this.corruptOutcome(journal.operationId);
          const result = await this.callAdapter(() =>
            this.adapters.commitMaintenance({
              ...intent,
              maintenanceId: maintenance.maintenanceId,
              target: "CANDIDATE",
              expectedIdentity: clone(journal.expectedCandidate),
              atomicJournalRevision: journal.revision,
              expectedPointerRevision: authorization.pointerRevision,
            }),
          );
          if (!result || result.state === "AMBIGUOUS") {
            return this.recoveryRequired(journal, "MAINTENANCE_COMMIT_AMBIGUOUS");
          }
          if (result.state === "REJECTED") {
            journal = await this.beginRollback(journal, "MAINTENANCE_COMMIT_FAILED");
            break;
          }
          if (
            !isMaintenanceCommitReceipt(result.receipt) ||
            result.receipt.maintenanceId !== maintenance.maintenanceId ||
            result.receipt.target !== "CANDIDATE" ||
            !sameIdentity(result.receipt.identity, journal.expectedCandidate) ||
            result.receipt.atomicJournalRevision !== journal.revision ||
            result.receipt.releasePointerRevision !== authorization.pointerRevision + 1
          ) {
            return this.recoveryRequired(journal, "MAINTENANCE_COMMIT_AMBIGUOUS");
          }
          journal = await this.transition(journal, {
            phase: "MAINTENANCE_COMMITTED",
            maintenanceCommitReceipt: clone(result.receipt),
          });
          break;
        }
        case "MAINTENANCE_COMMITTED":
          journal = await this.transition(journal, { phase: "COMPLETED" });
          break;
        case "ROLLBACK_STOP_CANDIDATE_INTENT": {
          const maintenance = this.requireMaintenance(journal);
          if (!maintenance) return this.corruptOutcome(journal.operationId);
          const result = await this.callAdapter(() =>
            this.adapters.stopCandidate({
              ...intent,
              maintenanceId: maintenance.maintenanceId,
              expectedIdentity: clone(journal.expectedCandidate),
            }),
          );
          if (!result || result.state === "AMBIGUOUS") {
            return this.recoveryRequired(journal, "ROLLBACK_CANDIDATE_STOP_AMBIGUOUS");
          }
          if (result.state === "REJECTED") {
            return this.rollbackFailed(journal, "ROLLBACK_CANDIDATE_STOP_FAILED");
          }
          journal = await this.transition(journal, { phase: "ROLLBACK_RESTORE_INTENT" });
          break;
        }
        case "ROLLBACK_RESTORE_INTENT": {
          const observation = await this.observeOrNull(journal.operationId);
          if (
            unknownObservation(observation) ||
            !stopped(observation!) ||
            (!installedIs(observation!, journal.expectedCandidate) &&
              !installedIs(observation!, journal.expectedCurrent))
          ) {
            return this.recoveryRequired(journal, "ROLLBACK_RESTORE_AMBIGUOUS");
          }
          const maintenance = this.requireMaintenance(journal);
          const finalSnapshot = this.requireFinalSnapshot(journal);
          const finalDatabaseReceipt = journal.finalDatabaseReceipt;
          const finalSecurityReceipt = journal.finalSnapshotSecurityReceipt;
          const swap = journal.swapReceipt;
          if (
            !maintenance ||
            !finalSnapshot ||
            !finalDatabaseReceipt ||
            !finalSecurityReceipt ||
            !swap
          ) {
            return this.corruptOutcome(journal.operationId);
          }
          const result = await this.callAdapter(() =>
            this.adapters.restoreFinalRollbackSnapshot({
              ...intent,
              maintenanceId: maintenance.maintenanceId,
              finalSnapshot: clone(finalSnapshot),
              expectedIdentity: clone(journal.expectedCurrent),
              expectedPointerRevision: swap.pointerRevision,
              snapshotDatabaseReceipt: clone(finalDatabaseReceipt),
              snapshotSecurityReceipt: clone(finalSecurityReceipt),
            }),
          );
          if (!result || result.state === "AMBIGUOUS") {
            return this.recoveryRequired(journal, "ROLLBACK_RESTORE_AMBIGUOUS");
          }
          if (result.state === "REJECTED") {
            return this.rollbackFailed(journal, "ROLLBACK_RESTORE_FAILED");
          }
          if (
            !isFinalRestoreReceipt(result.receipt) ||
            result.receipt.operationId !== journal.operationId ||
            result.receipt.snapshotId !== finalSnapshot.snapshotId ||
            result.receipt.previousPointerRevision !== swap.pointerRevision ||
            !sameIdentity(result.receipt.restoredIdentity, journal.expectedCurrent) ||
            result.receipt.snapshotSecurityEpoch !== finalSecurityReceipt.securityEpoch ||
            result.receipt.replayedThroughSecurityEventSequence <
              finalSecurityReceipt.securityEventSequence
          ) {
            return this.recoveryRequired(journal, "ROLLBACK_RESTORE_AMBIGUOUS");
          }
          journal = await this.transition(journal, {
            phase: "ROLLBACK_START_PREVIOUS_MAINTENANCE_INTENT",
            restoreReceipt: clone(result.receipt),
          });
          break;
        }
        case "ROLLBACK_START_PREVIOUS_MAINTENANCE_INTENT": {
          const observation = await this.observeOrNull(journal.operationId);
          if (
            unknownObservation(observation) ||
            !installedIs(observation!, journal.expectedCurrent) ||
            (!stopped(observation!) &&
              !runningIs(observation!, journal.expectedCurrent, "MAINTENANCE"))
          ) {
            return this.recoveryRequired(journal, "ROLLBACK_PREVIOUS_START_AMBIGUOUS");
          }
          const maintenance = this.requireMaintenance(journal);
          const finalSnapshot = this.requireFinalSnapshot(journal);
          if (!maintenance || !finalSnapshot) return this.corruptOutcome(journal.operationId);
          const result = await this.callAdapter(() =>
            this.adapters.startPreviousInMaintenance({
              ...intent,
              maintenanceId: maintenance.maintenanceId,
              finalSnapshot: clone(finalSnapshot),
              expectedIdentity: clone(journal.expectedCurrent),
            }),
          );
          if (!result || result.state === "AMBIGUOUS") {
            return this.recoveryRequired(journal, "ROLLBACK_PREVIOUS_START_AMBIGUOUS");
          }
          if (result.state === "REJECTED") {
            return this.rollbackFailed(journal, "ROLLBACK_PREVIOUS_START_FAILED");
          }
          if (
            !isMaintenanceRuntimeReceipt(result.receipt) ||
            result.receipt.maintenanceId !== maintenance.maintenanceId ||
            !sameIdentity(result.receipt.identity, journal.expectedCurrent)
          ) {
            return this.recoveryRequired(journal, "ROLLBACK_PREVIOUS_START_AMBIGUOUS");
          }
          journal = await this.transition(journal, {
            phase: "ROLLBACK_PREVIOUS_STARTED",
            previousStartReceipt: clone(result.receipt),
          });
          break;
        }
        case "ROLLBACK_PREVIOUS_STARTED":
          journal = await this.transition(journal, { phase: "ROLLBACK_VERIFY_PREVIOUS_INTENT" });
          break;
        case "ROLLBACK_VERIFY_PREVIOUS_INTENT": {
          const maintenance = this.requireMaintenance(journal);
          const start = journal.previousStartReceipt;
          if (!maintenance || !start) return this.corruptOutcome(journal.operationId);
          const result = await this.callAdapter(() =>
            this.adapters.probeMaintenanceHealth({
              ...intent,
              maintenanceId: maintenance.maintenanceId,
              target: "PREVIOUS",
              expectedIdentity: clone(journal.expectedCurrent),
              expectedBoundAddress: start.boundAddress,
              expectedBoundPort: start.boundPort,
              expectedRuntimeId: start.runtimeId,
              expectedHubInstanceId: start.hubInstanceId,
            }),
          );
          if (!result || result.state === "AMBIGUOUS") {
            return this.recoveryRequired(journal, "ROLLBACK_PREVIOUS_HEALTH_AMBIGUOUS");
          }
          if (result.state === "UNHEALTHY") {
            return this.rollbackFailed(journal, "ROLLBACK_PREVIOUS_HEALTH_FAILED");
          }
          if (
            !isMaintenanceHealthReceipt(result.receipt) ||
            result.receipt.maintenanceId !== maintenance.maintenanceId ||
            result.receipt.target !== "PREVIOUS" ||
            !sameIdentity(result.receipt.identity, journal.expectedCurrent) ||
            result.receipt.runtimeId !== start.runtimeId ||
            result.receipt.hubInstanceId !== start.hubInstanceId ||
            result.receipt.boundAddress !== start.boundAddress ||
            result.receipt.boundPort !== start.boundPort
          ) {
            return this.recoveryRequired(journal, "ROLLBACK_PREVIOUS_HEALTH_AMBIGUOUS");
          }
          journal = await this.transition(journal, {
            phase: "ROLLBACK_PREVIOUS_HEALTHY",
            previousHealthReceipt: clone(result.receipt),
          });
          break;
        }
        case "ROLLBACK_PREVIOUS_HEALTHY":
          journal = await this.transition(journal, {
            phase: "ROLLBACK_AUTHORIZE_BRIDGES_INTENT",
          });
          break;
        case "ROLLBACK_AUTHORIZE_BRIDGES_INTENT": {
          const authorization = this.createTransitionAuthorization(journal, "ROLLED_BACK");
          if (!authorization) return this.corruptOutcome(journal.operationId);
          journal = await this.transition(journal, {
            phase: "ROLLBACK_BRIDGE_TRANSITION_AUTHORIZED",
            rollbackTransitionAuthorization: authorization,
          });
          break;
        }
        case "ROLLBACK_BRIDGE_TRANSITION_AUTHORIZED":
          journal = await this.transition(journal, { phase: "ROLLBACK_RESUME_BRIDGES_INTENT" });
          break;
        case "ROLLBACK_RESUME_BRIDGES_INTENT": {
          const maintenance = this.requireMaintenance(journal);
          const authorization = journal.rollbackTransitionAuthorization;
          if (!maintenance || !authorization) return this.corruptOutcome(journal.operationId);
          const result = await this.callAdapter(() =>
            this.adapters.resumePreviouslyRunningBridges({
              ...intent,
              transitionAuthorizationId: authorization.authorizationId,
              expectedAuthorizationSha256: authorization.authorizationSha256,
            }),
          );
          if (!result || result.state === "AMBIGUOUS") {
            return this.recoveryRequired(journal, "ROLLBACK_BRIDGE_RESUME_AMBIGUOUS");
          }
          if (result.state === "REJECTED") {
            return this.rollbackFailed(journal, "ROLLBACK_BRIDGE_RESUME_FAILED");
          }
          if (
            !isBridgeResumeReceipt(result.receipt) ||
            result.receipt.maintenanceId !== maintenance.maintenanceId ||
            result.receipt.target !== "PREVIOUS" ||
            !releaseEffectsMatch(journal, result.receipt, authorization, journal.expectedCurrent)
          ) {
            return this.recoveryRequired(journal, "ROLLBACK_BRIDGE_RESUME_AMBIGUOUS");
          }
          journal = await this.transition(journal, {
            phase: "ROLLBACK_BRIDGES_RESUMED",
            rollbackResumeReceipt: clone(result.receipt),
          });
          break;
        }
        case "ROLLBACK_BRIDGES_RESUMED":
          journal = await this.transition(journal, {
            phase: "ROLLBACK_COMMIT_MAINTENANCE_INTENT",
          });
          break;
        case "ROLLBACK_COMMIT_MAINTENANCE_INTENT": {
          const maintenance = this.requireMaintenance(journal);
          const authorization = journal.rollbackTransitionAuthorization;
          if (!maintenance || !authorization) return this.corruptOutcome(journal.operationId);
          const result = await this.callAdapter(() =>
            this.adapters.commitMaintenance({
              ...intent,
              maintenanceId: maintenance.maintenanceId,
              target: "PREVIOUS",
              expectedIdentity: clone(journal.expectedCurrent),
              atomicJournalRevision: journal.revision,
              expectedPointerRevision: authorization.pointerRevision,
            }),
          );
          if (!result || result.state === "AMBIGUOUS") {
            return this.recoveryRequired(journal, "ROLLBACK_MAINTENANCE_COMMIT_AMBIGUOUS");
          }
          if (result.state === "REJECTED") {
            return this.rollbackFailed(journal, "ROLLBACK_MAINTENANCE_COMMIT_FAILED");
          }
          if (
            !isMaintenanceCommitReceipt(result.receipt) ||
            result.receipt.maintenanceId !== maintenance.maintenanceId ||
            result.receipt.target !== "PREVIOUS" ||
            !sameIdentity(result.receipt.identity, journal.expectedCurrent) ||
            result.receipt.atomicJournalRevision !== journal.revision ||
            result.receipt.releasePointerRevision !== authorization.pointerRevision + 1
          ) {
            return this.recoveryRequired(journal, "ROLLBACK_MAINTENANCE_COMMIT_AMBIGUOUS");
          }
          journal = await this.transition(journal, {
            phase: "ROLLBACK_MAINTENANCE_COMMITTED",
            rollbackCommitReceipt: clone(result.receipt),
          });
          break;
        }
        case "ROLLBACK_MAINTENANCE_COMMITTED":
          journal = await this.transition(journal, {
            phase: "ROLLED_BACK",
          });
          break;
        case "PRE_SWAP_CLEANUP_INTENT": {
          const maintenance = journal.maintenanceReceipt;
          const failedPhase = journal.cleanupFailedAtPhase;
          if (!maintenance || !failedPhase) return this.corruptOutcome(journal.operationId);
          const result = await this.callAdapter(() =>
            this.adapters.cleanupPreSwapMaintenance({
              ...intent,
              maintenanceReceipt: clone(maintenance),
              pauseReceipt: clone(journal.supervisorPauseReceipt),
              stopReceipt: clone(journal.stopReceipt),
              finalSnapshot: clone(journal.finalSnapshot),
              failedPhase,
              expectedCurrent: clone(journal.expectedCurrent),
              expectedPointerRevision: maintenance.releasePointerRevision,
            }),
          );
          if (!result || result.state === "AMBIGUOUS") {
            return this.recoveryRequired(journal, "PRE_SWAP_CLEANUP_AMBIGUOUS");
          }
          if (result.state === "REJECTED") {
            return this.recoveryRequired(journal, "PRE_SWAP_CLEANUP_FAILED");
          }
          const expectedPauseId = journal.supervisorPauseReceipt?.pauseReceiptId ?? null;
          if (
            !isPreSwapCleanupReceipt(result.receipt) ||
            result.receipt.operationId !== journal.operationId ||
            result.receipt.maintenanceId !== maintenance.maintenanceId ||
            result.receipt.failedPhase !== failedPhase ||
            result.receipt.pauseReceiptId !== expectedPauseId ||
            result.receipt.releasePointerRevision !== maintenance.releasePointerRevision ||
            result.receipt.securityEpoch < maintenance.securityState.securityEpoch ||
            !sameIdentity(result.receipt.sourceIdentity, journal.expectedCurrent)
          ) {
            return this.recoveryRequired(journal, "PRE_SWAP_CLEANUP_AMBIGUOUS");
          }
          journal = await this.transition(journal, {
            phase: "PRE_SWAP_CLEANUP_CONFIRMED",
            preSwapCleanupReceipt: clone(result.receipt),
          });
          break;
        }
        case "PRE_SWAP_CLEANUP_CONFIRMED": {
          if (!journal.cleanupCauseCode || !journal.cleanupFailedAtPhase) {
            return this.corruptOutcome(journal.operationId);
          }
          journal = await this.transition(journal, {
            phase: "BLOCKED",
            terminalCode: journal.cleanupCauseCode,
            failedAtPhase: journal.cleanupFailedAtPhase,
          });
          break;
        }
        case "COMPLETED":
        case "ROLLED_BACK":
        case "BLOCKED":
        case "ROLLBACK_FAILED":
          return this.outcomeFromTerminalOrCorrupt(journal);
      }
    }
    return this.recoveryRequired(journal, "JOURNAL_CORRUPT");
  }

  private async loadOrCreate(
    request: AtomicReleaseRequest,
    fingerprint: string,
    lease: LeaseContext,
  ): Promise<AtomicReleaseJournal | null> {
    const existing: unknown = await this.journalStore.load(request.operationId);
    if (existing !== null)
      return isJournal(existing) && journalRelationsValid(existing) ? existing : null;
    const initial: AtomicReleaseJournal = {
      schemaVersion: 3,
      operationId: request.operationId,
      requestFingerprint: fingerprint,
      candidateId: request.candidateId,
      expectedCurrent: clone(request.expectedCurrent),
      expectedCandidate: clone(request.expectedCandidate),
      revision: 0,
      phase: "CANDIDATE_PROBE_INTENT",
      candidateProbe: null,
      preflightSnapshot: null,
      preflightDatabaseReceipt: null,
      currentObservationReceipt: null,
      maintenanceReceipt: null,
      supervisorPauseReceipt: null,
      stopReceipt: null,
      finalSnapshot: null,
      finalDatabaseReceipt: null,
      finalSnapshotSecurityReceipt: null,
      swapReceipt: null,
      candidateStartReceipt: null,
      candidateHealthReceipt: null,
      candidateMigrationReceipt: null,
      transitionAuthorization: null,
      bridgeResumeReceipt: null,
      maintenanceCommitReceipt: null,
      restoreReceipt: null,
      previousStartReceipt: null,
      previousHealthReceipt: null,
      rollbackTransitionAuthorization: null,
      rollbackResumeReceipt: null,
      rollbackCommitReceipt: null,
      preSwapCleanupReceipt: null,
      cleanupCauseCode: null,
      cleanupFailedAtPhase: null,
      rollbackCauseCode: null,
      terminalCode: null,
      failedAtPhase: null,
      updatedAt: this.now(),
    };
    if (!journalRelationsValid(initial)) return null;
    await this.renewLease(lease);
    if (
      await this.journalStore.compareAndSwap(
        request.operationId,
        null,
        clone(initial),
        clone(lease.claim),
      )
    )
      return initial;
    const winner: unknown = await this.journalStore.load(request.operationId);
    return isJournal(winner) && journalRelationsValid(winner) ? winner : null;
  }

  private async transition(
    journal: AtomicReleaseJournal,
    patch: Partial<AtomicReleaseJournal>,
  ): Promise<AtomicReleaseJournal> {
    const lease = this.activeLeases.get(journal.operationId);
    if (!lease) throw new ActiveLeaseLostError();
    await this.renewLease(lease);
    const next: AtomicReleaseJournal = {
      ...clone(journal),
      ...clone(patch),
      schemaVersion: 3,
      operationId: journal.operationId,
      requestFingerprint: journal.requestFingerprint,
      candidateId: journal.candidateId,
      expectedCurrent: clone(journal.expectedCurrent),
      expectedCandidate: clone(journal.expectedCandidate),
      revision: journal.revision + 1,
      updatedAt: this.now(),
    };
    if (!isJournal(next) || !journalRelationsValid(next)) {
      throw new Error("atomic release transition violated journal invariants");
    }
    if (
      await this.journalStore.compareAndSwap(
        journal.operationId,
        journal.revision,
        clone(next),
        clone(lease.claim),
      )
    ) {
      return next;
    }
    const winner: unknown = await this.journalStore.load(journal.operationId);
    if (!isJournal(winner) || !journalRelationsValid(winner)) {
      throw new Error("atomic release journal CAS winner is invalid");
    }
    return winner;
  }

  private recoveryRequired(
    journal: AtomicReleaseJournal,
    code: AtomicReleaseFailureCode,
  ): AtomicReleaseOutcome {
    return this.recoveryOutcome(journal.operationId, code, journal.phase);
  }

  private recoveryOutcome(
    operationId: string,
    code: AtomicReleaseFailureCode,
    phase: AtomicReleaseJournalPhase,
  ): AtomicReleaseOutcome {
    return { state: "RECOVERY_REQUIRED", operationId, code, phase };
  }

  private async block(
    journal: AtomicReleaseJournal,
    code: AtomicReleaseFailureCode,
  ): Promise<AtomicReleaseOutcome> {
    const terminal = await this.transition(journal, {
      phase: "BLOCKED",
      terminalCode: code,
      failedAtPhase: journal.phase,
    });
    return this.outcomeFromTerminalOrCorrupt(terminal);
  }

  private async beginRollback(
    journal: AtomicReleaseJournal,
    causeCode: AtomicReleaseFailureCode,
  ): Promise<AtomicReleaseJournal> {
    return this.transition(journal, {
      phase: "ROLLBACK_STOP_CANDIDATE_INTENT",
      rollbackCauseCode: causeCode,
    });
  }

  private async beginPreSwapCleanup(
    journal: AtomicReleaseJournal,
    causeCode: AtomicReleaseFailureCode,
  ): Promise<AtomicReleaseJournal> {
    return this.transition(journal, {
      phase: "PRE_SWAP_CLEANUP_INTENT",
      cleanupCauseCode: causeCode,
      cleanupFailedAtPhase: journal.phase,
    });
  }

  private async rollbackFailed(
    journal: AtomicReleaseJournal,
    code: AtomicReleaseFailureCode,
  ): Promise<AtomicReleaseOutcome> {
    const terminal = await this.transition(journal, {
      phase: "ROLLBACK_FAILED",
      terminalCode: code,
      failedAtPhase: journal.phase,
    });
    return this.outcomeFromTerminalOrCorrupt(terminal);
  }

  private outcomeFromTerminalOrCorrupt(journal: AtomicReleaseJournal): AtomicReleaseOutcome {
    if (!isJournal(journal) || !journalRelationsValid(journal)) {
      return this.corruptOutcome(journal.operationId);
    }
    if (journal.phase === "COMPLETED") {
      return {
        state: "DEPLOYED",
        operationId: journal.operationId,
        identity: clone(journal.expectedCandidate),
      };
    }
    if (journal.phase === "ROLLED_BACK" && journal.rollbackCauseCode) {
      return {
        state: "ROLLED_BACK",
        operationId: journal.operationId,
        identity: clone(journal.expectedCurrent),
        causeCode: journal.rollbackCauseCode,
      };
    }
    if (journal.phase === "BLOCKED" && journal.terminalCode && journal.failedAtPhase) {
      return {
        state: "BLOCKED",
        operationId: journal.operationId,
        code: journal.terminalCode,
        phase: journal.failedAtPhase,
      };
    }
    if (
      journal.phase === "ROLLBACK_FAILED" &&
      journal.terminalCode &&
      journal.rollbackCauseCode &&
      journal.failedAtPhase
    ) {
      return {
        state: "ROLLBACK_FAILED",
        operationId: journal.operationId,
        code: journal.terminalCode,
        causeCode: journal.rollbackCauseCode,
        phase: journal.failedAtPhase,
      };
    }
    return this.corruptOutcome(journal.operationId);
  }

  private corruptOutcome(operationId: string): AtomicReleaseOutcome {
    return {
      state: "BLOCKED",
      operationId,
      code: "JOURNAL_CORRUPT",
      phase: "CANDIDATE_PROBE_INTENT",
    };
  }

  private async renewLease(lease: LeaseContext): Promise<void> {
    if (lease.lost) throw new ActiveLeaseLostError();
    const nextExpiresAt = new Date(
      Date.parse(this.now()) + this.activeLeaseDurationMs,
    ).toISOString();
    try {
      const result = await this.journalStore.renewActiveLease(clone(lease.claim), nextExpiresAt);
      if (
        !isRecord(result) ||
        !exactKeys(result, result.state === "LOST" ? ["state"] : ["state", "claim"])
      ) {
        lease.lost = true;
        throw new ActiveLeaseLostError();
      }
      if (result.state !== "RENEWED" || !isRecord(result.claim)) {
        lease.lost = true;
        throw new ActiveLeaseLostError();
      }
      const claim = result.claim as unknown as AtomicReleaseActiveLeaseClaim;
      if (
        claim.leaseKey !== lease.claim.leaseKey ||
        claim.operationId !== lease.claim.operationId ||
        claim.requestFingerprint !== lease.claim.requestFingerprint ||
        claim.ownerId !== lease.claim.ownerId ||
        claim.generation !== lease.claim.generation ||
        !isIsoTimestamp(claim.expiresAt) ||
        claim.expiresAt !== nextExpiresAt ||
        Date.parse(claim.expiresAt) <= Date.parse(this.now())
      ) {
        lease.lost = true;
        throw new ActiveLeaseLostError();
      }
      Object.assign(lease.claim, clone(claim));
    } catch {
      lease.lost = true;
      throw new ActiveLeaseLostError();
    }
  }

  private async observeOrNull(operationId: string): Promise<DeploymentObservation | null> {
    const lease = this.activeLeases.get(operationId);
    if (!lease) throw new ActiveLeaseLostError();
    try {
      await this.renewLease(lease);
      const value: unknown = await this.adapters.observe({
        operationId,
        activeLease: clone(lease.claim),
      });
      await this.renewLease(lease);
      return isDeploymentObservation(value) ? clone(value) : null;
    } catch {
      if (lease.lost) throw new ActiveLeaseLostError();
      return null;
    }
  }

  private async callAdapter<T>(call: () => Promise<T>): Promise<T | null> {
    const leases = [...this.activeLeases.values()];
    if (leases.length !== 1) throw new ActiveLeaseLostError();
    const lease = leases[0]!;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    let heartbeatWork: Promise<void> = Promise.resolve();
    try {
      await this.renewLease(lease);
      heartbeat = setInterval(
        () => {
          heartbeatWork = heartbeatWork.then(() => this.renewLease(lease));
        },
        Math.max(10, Math.floor(this.activeLeaseDurationMs / 3)),
      );
      const value: unknown = await call();
      if (heartbeat) clearInterval(heartbeat);
      await heartbeatWork;
      await this.renewLease(lease);
      if (!isRecord(value) || typeof value.state !== "string") return null;
      const keys = Object.keys(value);
      const closed =
        (value.state === "CONFIRMED" &&
          [1, 2, 3].includes(keys.length) &&
          (exactKeys(value, ["state"]) ||
            exactKeys(value, ["state", "receipt"]) ||
            exactKeys(value, ["state", "manifest", "receipt"]))) ||
        ((value.state === "AMBIGUOUS" ||
          value.state === "REJECTED" ||
          value.state === "UNHEALTHY") &&
          exactKeys(value, ["state", "code"]) &&
          safeAdapterCode(value.code)) ||
        (value.state === "HEALTHY" && exactKeys(value, ["state", "receipt"]));
      return closed ? (clone(value) as T) : null;
    } catch {
      if (heartbeat) clearInterval(heartbeat);
      try {
        await heartbeatWork;
      } catch {
        // handled by the lost bit below
      }
      if (lease.lost) throw new ActiveLeaseLostError();
      return null;
    }
  }

  private createTransitionAuthorization(
    journal: AtomicReleaseJournal,
    outcome: "DEPLOYED" | "ROLLED_BACK",
  ): ReleaseTransitionAuthorization | null {
    const pause = journal.supervisorPauseReceipt;
    const pointerRevision =
      outcome === "DEPLOYED"
        ? journal.swapReceipt?.pointerRevision
        : journal.restoreReceipt?.pointerRevision;
    if (!pause || !pointerRevision) return null;
    const unsigned: Omit<ReleaseTransitionAuthorization, "authorizationSha256"> = {
      schemaVersion: 1,
      authorizationId: `authorization:${digest({ operationId: journal.operationId, outcome }).slice(0, 48)}`,
      operationId: journal.operationId,
      requestFingerprint: journal.requestFingerprint,
      authorizedOutcome: outcome,
      atomicJournalRevision: journal.revision,
      pointerRevision,
      supervisorJournalRevision: pause.supervisorJournalRevision,
      pauseReceiptId: pause.pauseReceiptId,
      sourceIdentity: clone(journal.expectedCurrent),
      candidateIdentity: clone(journal.expectedCandidate),
      installedIdentity: clone(
        outcome === "DEPLOYED" ? journal.expectedCandidate : journal.expectedCurrent,
      ),
      pauseReceiptSha256: pause.receiptSha256,
      issuedAt: this.now(),
    };
    return { ...unsigned, authorizationSha256: digest(unsigned) };
  }

  private async terminalLeaseProof(
    outcome: AtomicReleaseOutcome,
    fingerprint: string,
    lease: LeaseContext,
  ): Promise<AtomicReleaseTerminalLeaseProof | null> {
    if (
      outcome.state !== "DEPLOYED" &&
      outcome.state !== "ROLLED_BACK" &&
      outcome.state !== "BLOCKED" &&
      outcome.state !== "ROLLBACK_FAILED"
    ) {
      return null;
    }
    if (lease.lost) return null;
    const loaded: unknown = await this.journalStore.load(outcome.operationId);
    if (
      !isJournal(loaded) ||
      !journalRelationsValid(loaded) ||
      loaded.requestFingerprint !== fingerprint ||
      (loaded.phase !== "COMPLETED" &&
        loaded.phase !== "ROLLED_BACK" &&
        loaded.phase !== "BLOCKED" &&
        loaded.phase !== "ROLLBACK_FAILED")
    ) {
      return null;
    }
    return {
      operationId: loaded.operationId,
      requestFingerprint: loaded.requestFingerprint,
      terminalPhase: loaded.phase,
      journalRevision: loaded.revision,
    };
  }

  private requireMaintenance(journal: AtomicReleaseJournal): HubMaintenanceReceipt | null {
    return journal.maintenanceReceipt ? clone(journal.maintenanceReceipt) : null;
  }

  private requireFinalSnapshot(
    journal: AtomicReleaseJournal,
  ): FinalRollbackSnapshotManifest | null {
    return journal.finalSnapshot ? clone(journal.finalSnapshot) : null;
  }

  private quiescenceProof(journal: AtomicReleaseJournal): QuiescenceProof | null {
    if (!journal.maintenanceReceipt || !journal.stopReceipt) return null;
    return {
      state: "QUIESCED",
      fenceId: journal.maintenanceReceipt.fenceId,
      stopReceiptId: journal.stopReceipt.stopReceiptId,
      observedAt: journal.stopReceipt.stoppedAt,
    };
  }
}
