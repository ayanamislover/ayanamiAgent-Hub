import { createHash, createPublicKey, randomBytes } from "node:crypto";
import type {
  ManagedBridgeReleaseEffectReceipt,
  ManagedBridgeSubjectProof,
  PausedManagedBridgeSubject,
  ReleaseTransitionAuthorization,
} from "./atomic-release-manager.js";
import {
  managedBridgeActiveSubjectKey,
  type ManagedBridgeBuildIdentity,
  type ManagedBridgeIpcSubject,
} from "./managed-bridge-ipc.js";
import { verifyBridgeWorkerProofSignature, type BridgeWorkerProof } from "./bridge-worker-proof.js";

const MAX_IDENTIFIER_CHARS = 512;
const MAX_DESIRED_RECORDS = 1_024;
const MAX_SIDECARS_PER_SUBJECT = 16;
const MAX_CLAIMED_COMMANDS = 1_024;
const MAX_COMMAND_ATTEMPT_FENCES = 64;
const MAX_PAYLOAD_SCAN_DEPTH = 64;
const MAX_PAYLOAD_SCAN_NODES = 4_096;
const SHA256 = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RELEASE_OPERATION_ID = /^rel_[A-Za-z0-9_-]{1,120}$/;
const SECRET_FIELD_PARTS = [
  "token",
  "secret",
  "credential",
  "password",
  "cookie",
  "authorization",
  "bearer",
  "apikey",
  "privatekey",
  "accesskey",
  "sessionticket",
  "mcpticket",
] as const;
const NON_SECRET_AUTHORIZATION_FIELDS = new Set([
  "releaseauthorization",
  "transitionauthorization",
  "authorizationid",
  "authorizationsha256",
]);

export type ManagedBridgeRuntimeErrorCode =
  | "INVALID_DESIRED_RECORD"
  | "INVALID_SIDECAR"
  | "MULTIPLE_DESIRED_RUNNING"
  | "JOURNAL_CLAIM_CONFLICT"
  | "JOURNAL_COMMAND_CONFLICT"
  | "JOURNAL_COMPLETE_CONFLICT"
  | "EFFECT_PRECONDITION_CHANGED"
  | "EFFECT_RESPONSE_UNKNOWN"
  | "INVALID_EFFECT_RECEIPT"
  | "RELEASE_SUBJECT_MISMATCH"
  | "FORBIDDEN_SECRET_FIELD"
  | "PAYLOAD_BOUNDS_EXCEEDED";

export class ManagedBridgeRuntimeError extends Error {
  constructor(
    readonly code: ManagedBridgeRuntimeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ManagedBridgeRuntimeError";
  }
}

export interface ManagedBridgeRuntimeLease {
  readonly leaseId: string;
  readonly generation: number;
  readonly active: boolean;
  assertActive(): void;
}

/** Non-secret monotonic fencing identity that the effect receiver must verify before apply. */
export type ManagedBridgeRuntimeLeaseFence = {
  schemaVersion: 1;
  controlLeaseId: string;
  controlLeaseGeneration: number;
  journalLeaseId: string;
  journalLeaseGeneration: number;
};

export type ManagedBridgeRuntimeStopReceipt = {
  kind: "DESIRED_STOP_PERSISTED";
  receiptId: string;
  desiredRevision: number;
  subjectKey: string;
};

export type ManagedBridgeRuntimeDesiredRecord = {
  schemaVersion: 1;
  revision: number;
  desiredState: "RUNNING" | "STOPPED";
  subject: ManagedBridgeIpcSubject;
  stopReceipt: ManagedBridgeRuntimeStopReceipt | null;
};

/**
 * Non-secret durable worker provenance. It intentionally contains digests rather than recovery
 * payloads. EXITED/STOPPED records are the evidence required for an exact relaunch; absence is not
 * interpreted as death.
 */
export type ManagedBridgeRuntimeSidecar = {
  schemaVersion: 1;
  kind: "BRIDGE_WORKER_PROOF_SIDECAR";
  sidecarId: string;
  revision: number;
  state: "STARTING" | "RUNNING" | "EXITED" | "STOPPED";
  subject: ManagedBridgeIpcSubject;
  pid: number | null;
  workerPipePath: string;
  workerPublicKeySpkiDerBase64: string;
  workerPublicKeySha256: string;
  stateUpdatedAt: string;
};

export type ManagedBridgeRuntimeWorkerProof = Omit<BridgeWorkerProof, "subject"> & {
  subject: ManagedBridgeIpcSubject;
};

/**
 * Independently read from the durable Atomic + Supervisor seam; never synthesized by the caller.
 * The authorization exists before the process effect. The paused subject and ordinal are sealed by
 * the exact Supervisor observation that will perform the identity CAS.
 */
export type ManagedBridgeRuntimeReleaseAuthorization = {
  subjectIndex: number;
  transitionAuthorization: ReleaseTransitionAuthorization;
  pausedSubject: PausedManagedBridgeSubject;
};
export type ManagedBridgeRuntimeReleaseReceipt = ManagedBridgeReleaseEffectReceipt;
export type ManagedBridgeRuntimeReleaseSubjectProof = ManagedBridgeSubjectProof;

type RuntimeCommandCore = {
  schemaVersion: 1;
  commandId: string;
  requestHash: string;
  subject: ManagedBridgeIpcSubject;
  desiredRevision: number;
  leaseFence: ManagedBridgeRuntimeLeaseFence;
};

export type ManagedBridgeRuntimeCommand =
  | (RuntimeCommandCore & {
      kind: "START_EXACT";
      recoverySidecar: ManagedBridgeRuntimeSidecar;
    })
  | (RuntimeCommandCore & {
      kind: "STOP_EXACT";
      persistedStopReceipt: ManagedBridgeRuntimeStopReceipt;
      workerSidecar: ManagedBridgeRuntimeSidecar | null;
    })
  | (RuntimeCommandCore & {
      kind: "RELEASE_REBIND_EXACT";
      operationId: string;
      previousSubject: ManagedBridgeIpcSubject;
      releaseAuthorization: ManagedBridgeRuntimeReleaseAuthorization;
    })
  | (RuntimeCommandCore & {
      kind: "RELEASE_ROLLBACK_EXACT";
      operationId: string;
      previousSubject: ManagedBridgeIpcSubject;
      releaseAuthorization: ManagedBridgeRuntimeReleaseAuthorization;
    });

type RuntimeReceiptCore = {
  schemaVersion: 1;
  commandId: string;
  requestHash: string;
  subject: ManagedBridgeIpcSubject;
  subjectKey: string;
  recordRevision: number;
  eventSequence: number;
  leaseFence: ManagedBridgeRuntimeLeaseFence;
};

export type ManagedBridgeRuntimeEffectReceipt =
  | (RuntimeReceiptCore & { kind: "STARTED" })
  | (RuntimeReceiptCore & {
      kind: "STOPPED";
      effect: "STOPPED" | "ALREADY_STOPPED";
    })
  | (RuntimeReceiptCore & {
      kind: "REBOUND" | "ROLLED_BACK" | "ALREADY_STOPPED";
      previousSubject: ManagedBridgeIpcSubject;
      releaseEffect: ManagedBridgeReleaseEffectReceipt;
    });

export type ManagedBridgeRuntimeCommandJournal = {
  schemaVersion: 1;
  revision: number;
  commandId: string;
  requestHash: string;
  state: "CLAIMED" | "COMPLETED";
  command: ManagedBridgeRuntimeCommand;
  attemptFences: ManagedBridgeRuntimeLeaseFence[];
  receipt: ManagedBridgeRuntimeEffectReceipt | null;
};

export interface ManagedBridgeRuntimeCommandStore {
  load(commandId: string): Promise<ManagedBridgeRuntimeCommandJournal | null>;
  /** Bounded durable index used to finish commands whose receiver response was lost. */
  listClaimed(): Promise<ManagedBridgeRuntimeCommandJournal[]>;
  /** The Adapter must assert the journal lease in the same serializable mutation. */
  compareAndSwap(
    commandId: string,
    expectedRevision: number | null,
    next: ManagedBridgeRuntimeCommandJournal,
    lease: ManagedBridgeRuntimeLease,
  ): Promise<boolean>;
}

export interface ManagedBridgeRuntimeAdapter {
  /** Enumerates durable desired state, not process observations. */
  enumerateDesired(): Promise<unknown[]>;
  /** Enumerates only non-secret sidecars for one project/original-thread subject key. */
  enumerateSidecars(subjectKey: string): Promise<unknown[]>;
  /** Must use the exact per-run worker pipe represented by the supplied sidecar. */
  challengeWorker(input: {
    challengeId: string;
    sidecar: ManagedBridgeRuntimeSidecar;
  }): Promise<unknown>;
  /** Reads the Atomic authorization plus the exact paused Supervisor subject in one observation. */
  readReleaseAuthorization(input: { operationId: string; subjectKey: string }): Promise<unknown>;
  /**
   * Receiver first replays an already-persisted receipt for the exact commandId. Otherwise it
   * atomically revalidates leaseFence plus the command's desired, sidecar, or durable release
   * proof before applying any process effect, and binds the accepted fence into its receipt.
   */
  dispatch(command: ManagedBridgeRuntimeCommand): Promise<unknown>;
}

export type ManagedBridgeRuntimeOutcome = {
  status:
    | "HEALTHY"
    | "STARTING_TRANSIENT"
    | "STARTED"
    | "STOPPED"
    | "ALREADY_STOPPED"
    | "REBOUND"
    | "ROLLED_BACK"
    | "BLOCKED";
  subject: ManagedBridgeIpcSubject;
  subjectKey: string;
  disposition?: "APPLIED" | "RECOVERED" | "REPLAYED";
  reason?:
    | "MISSING_RECOVERY_SIDECAR"
    | "MULTIPLE_RUNNING_SIDECARS"
    | "AMBIGUOUS_SIDECARS"
    | "SIDECAR_SUBJECT_MISMATCH"
    | "WORKER_CHALLENGE_UNAVAILABLE"
    | "WORKER_PROOF_MISMATCH"
    | "WORKER_HEALTH_STALE"
    | "STALE_STARTING_SIDECAR"
    | "SIDECAR_CHANGED_DURING_PROBE";
  releaseReceipt?: ManagedBridgeRuntimeReleaseReceipt;
};

export type ManagedBridgeReleaseTransition = {
  operationId: string;
  kind: "REBIND" | "ROLLBACK";
  desiredRevision: number;
  previousSubject: ManagedBridgeIpcSubject;
  nextSubject: ManagedBridgeIpcSubject;
};

type CommandExecution = {
  receipt: ManagedBridgeRuntimeEffectReceipt;
  disposition: "APPLIED" | "RECOVERED" | "REPLAYED";
};

export class ManagedBridgeRuntimeCoordinator {
  readonly #adapter: ManagedBridgeRuntimeAdapter;
  readonly #store: ManagedBridgeRuntimeCommandStore;
  readonly #controlLease: ManagedBridgeRuntimeLease;
  readonly #journalLease: ManagedBridgeRuntimeLease;
  readonly #now: () => number;
  readonly #healthFreshnessMs: number;
  readonly #startingGraceMs: number;
  readonly #createChallengeId: () => string;

  constructor(options: {
    adapter: ManagedBridgeRuntimeAdapter;
    store: ManagedBridgeRuntimeCommandStore;
    controlLease: ManagedBridgeRuntimeLease;
    journalLease: ManagedBridgeRuntimeLease;
    now?: () => number;
    healthFreshnessMs?: number;
    startingGraceMs?: number;
    createChallengeId?: () => string;
  }) {
    this.#adapter = options.adapter;
    this.#store = options.store;
    this.#controlLease = options.controlLease;
    this.#journalLease = options.journalLease;
    this.#now = options.now ?? Date.now;
    this.#healthFreshnessMs = options.healthFreshnessMs ?? 15_000;
    this.#startingGraceMs = options.startingGraceMs ?? 30_000;
    this.#createChallengeId = options.createChallengeId ?? (() => randomBytes(32).toString("hex"));
    if (!Number.isFinite(this.#healthFreshnessMs) || this.#healthFreshnessMs <= 0) {
      throw new RangeError("healthFreshnessMs must be a finite positive number");
    }
    if (!Number.isFinite(this.#startingGraceMs) || this.#startingGraceMs <= 0) {
      throw new RangeError("startingGraceMs must be a finite positive number");
    }
  }

  async reconcileAll(): Promise<ManagedBridgeRuntimeOutcome[]> {
    this.#assertLeases();
    const raw = await this.#adapter.enumerateDesired();
    this.#assertLeases();
    if (!Array.isArray(raw) || raw.length > MAX_DESIRED_RECORDS) {
      invalid("INVALID_DESIRED_RECORD", "Desired record enumeration is invalid or unbounded");
    }
    const desiredRecords = raw.map((value) => validateDesiredRecord(value));
    const byKey = new Map<string, ManagedBridgeRuntimeDesiredRecord[]>();
    for (const record of desiredRecords) {
      const key = managedBridgeActiveSubjectKey(record.subject);
      const group = byKey.get(key) ?? [];
      group.push(record);
      byKey.set(key, group);
    }
    for (const group of byKey.values()) {
      if (group.length > 1) {
        invalid(
          "MULTIPLE_DESIRED_RUNNING",
          "Multiple desired records claim one project and original thread",
        );
      }
    }

    const rawClaimed = await this.#store.listClaimed();
    this.#assertLeases();
    if (!Array.isArray(rawClaimed) || rawClaimed.length > MAX_CLAIMED_COMMANDS) {
      invalid("JOURNAL_COMMAND_CONFLICT", "Claimed command enumeration is invalid or unbounded");
    }
    const claimedByKey = new Map<string, ManagedBridgeRuntimeCommandJournal>();
    for (const claimed of rawClaimed) {
      validateJournal(claimed);
      if (claimed.state !== "CLAIMED") {
        invalid("JOURNAL_COMMAND_CONFLICT", "Claimed command index returned a terminal record");
      }
      const key = managedBridgeActiveSubjectKey(claimed.command.subject);
      if (claimedByKey.has(key)) {
        invalid(
          "JOURNAL_COMMAND_CONFLICT",
          "Multiple claimed runtime commands exist for one project and original thread",
        );
      }
      claimedByKey.set(key, claimed);
    }

    const ordered = [...desiredRecords].sort((left, right) =>
      managedBridgeActiveSubjectKey(left.subject).localeCompare(
        managedBridgeActiveSubjectKey(right.subject),
      ),
    );
    const outcomes: ManagedBridgeRuntimeOutcome[] = [];
    for (const [key, claimed] of [...claimedByKey].sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      if (managedBridgeActiveSubjectKey(claimed.command.subject) !== key) {
        invalid("JOURNAL_COMMAND_CONFLICT", "Claimed command index changed during validation");
      }
      outcomes.push(outcomeFromReceipt(await this.#execute(claimed.command), claimed.command));
    }
    for (const desiredRecord of ordered) {
      if (claimedByKey.has(managedBridgeActiveSubjectKey(desiredRecord.subject))) continue;
      outcomes.push(await this.#reconcileOne(desiredRecord));
    }
    return outcomes;
  }

  async transitionRelease(
    transition: ManagedBridgeReleaseTransition,
  ): Promise<ManagedBridgeRuntimeOutcome> {
    this.#assertLeases();
    if (!RELEASE_OPERATION_ID.test(transition.operationId)) {
      invalid("RELEASE_SUBJECT_MISMATCH", "Invalid release operation id");
    }
    assertNonNegativeInteger(
      transition.desiredRevision,
      "desiredRevision",
      "RELEASE_SUBJECT_MISMATCH",
    );
    validateSubject(transition.previousSubject, "RELEASE_SUBJECT_MISMATCH");
    validateSubject(transition.nextSubject, "RELEASE_SUBJECT_MISMATCH");
    if (!sameReleaseRun(transition.previousSubject, transition.nextSubject)) {
      invalid(
        "RELEASE_SUBJECT_MISMATCH",
        "Release transition must preserve the exact project, run, thread, and recovery bundle",
      );
    }
    const rawReleaseAuthorization = await this.#adapter.readReleaseAuthorization({
      operationId: transition.operationId,
      subjectKey: managedBridgeActiveSubjectKey(transition.previousSubject),
    });
    this.#assertLeases();
    const releaseAuthorization = validateReleaseAuthorizationForTransition(
      rawReleaseAuthorization,
      transition,
    );
    const kind = transition.kind === "REBIND" ? "RELEASE_REBIND_EXACT" : "RELEASE_ROLLBACK_EXACT";
    const command = createCommand({
      schemaVersion: 1,
      kind,
      operationId: transition.operationId,
      subject: transition.nextSubject,
      previousSubject: transition.previousSubject,
      releaseAuthorization,
      desiredRevision: transition.desiredRevision,
      leaseFence: this.#leaseFence(),
    });
    const executed = await this.#execute(command);
    if (command.kind !== "RELEASE_REBIND_EXACT" && command.kind !== "RELEASE_ROLLBACK_EXACT") {
      invalid("RELEASE_SUBJECT_MISMATCH", "Release command kind was not preserved");
    }
    return releaseOutcome(executed);
  }

  async #reconcileOne(
    desiredRecord: ManagedBridgeRuntimeDesiredRecord,
  ): Promise<ManagedBridgeRuntimeOutcome> {
    this.#assertLeases();
    const subjectKey = managedBridgeActiveSubjectKey(desiredRecord.subject);
    const rawSidecars = await this.#adapter.enumerateSidecars(subjectKey);
    this.#assertLeases();
    if (!Array.isArray(rawSidecars) || rawSidecars.length > MAX_SIDECARS_PER_SUBJECT) {
      invalid("INVALID_SIDECAR", "Sidecar enumeration is invalid or unbounded");
    }
    const sidecars = rawSidecars.map((value) => validateSidecar(value));
    const running = sidecars.filter((candidate) => candidate.state === "RUNNING");
    const starting = sidecars.filter((candidate) => candidate.state === "STARTING");
    if (running.length > 1) {
      return blocked(desiredRecord.subject, "MULTIPLE_RUNNING_SIDECARS");
    }
    if (starting.length > 1 || (running.length === 1 && starting.length === 1)) {
      return blocked(desiredRecord.subject, "AMBIGUOUS_SIDECARS");
    }
    const active = running[0] ?? starting[0] ?? null;

    if (desiredRecord.desiredState === "STOPPED") {
      if (active && !sameSubject(active.subject, desiredRecord.subject)) {
        return blocked(desiredRecord.subject, "SIDECAR_SUBJECT_MISMATCH");
      }
      if (active?.state === "STARTING") {
        return this.#startingOutcome(desiredRecord.subject, active);
      }
      const terminal = sidecars.filter(
        (candidate) => candidate.state === "EXITED" || candidate.state === "STOPPED",
      );
      if (terminal.length > 1) return blocked(desiredRecord.subject, "AMBIGUOUS_SIDECARS");
      if (terminal[0] && !sameSubject(terminal[0].subject, desiredRecord.subject)) {
        return blocked(desiredRecord.subject, "SIDECAR_SUBJECT_MISMATCH");
      }
      const command = createCommand({
        schemaVersion: 1,
        kind: "STOP_EXACT",
        subject: desiredRecord.subject,
        desiredRevision: desiredRecord.revision,
        persistedStopReceipt: desiredRecord.stopReceipt!,
        workerSidecar: active ?? terminal[0] ?? null,
        leaseFence: this.#leaseFence(),
      });
      const executed = await this.#execute(command);
      return outcome(
        executed.receipt.kind === "STOPPED" && executed.receipt.effect === "ALREADY_STOPPED"
          ? "ALREADY_STOPPED"
          : "STOPPED",
        executed.receipt.subject,
        executed.disposition,
      );
    }

    if (active?.state === "STARTING") {
      return sameSubject(active.subject, desiredRecord.subject)
        ? this.#startingOutcome(desiredRecord.subject, active)
        : blocked(desiredRecord.subject, "SIDECAR_SUBJECT_MISMATCH");
    }
    if (active?.state === "RUNNING") {
      if (!sameSubject(active.subject, desiredRecord.subject)) {
        return blocked(desiredRecord.subject, "SIDECAR_SUBJECT_MISMATCH");
      }
      return this.#proveWorker(desiredRecord, active);
    }

    const terminal = sidecars.filter(
      (candidate) => candidate.state === "EXITED" || candidate.state === "STOPPED",
    );
    if (terminal.length === 0) {
      return blocked(desiredRecord.subject, "MISSING_RECOVERY_SIDECAR");
    }
    if (terminal.length !== 1) {
      return blocked(desiredRecord.subject, "AMBIGUOUS_SIDECARS");
    }
    if (!sameSubject(terminal[0]!.subject, desiredRecord.subject)) {
      return blocked(desiredRecord.subject, "SIDECAR_SUBJECT_MISMATCH");
    }
    const command = createCommand({
      schemaVersion: 1,
      kind: "START_EXACT",
      subject: desiredRecord.subject,
      desiredRevision: desiredRecord.revision,
      recoverySidecar: terminal[0]!,
      leaseFence: this.#leaseFence(),
    });
    const executed = await this.#execute(command);
    return outcome("STARTED", executed.receipt.subject, executed.disposition);
  }

  async #proveWorker(
    desiredRecord: ManagedBridgeRuntimeDesiredRecord,
    sidecar: ManagedBridgeRuntimeSidecar,
  ): Promise<ManagedBridgeRuntimeOutcome> {
    if (sidecar.pid === null) return blocked(desiredRecord.subject, "WORKER_PROOF_MISMATCH");
    const challengeId = this.#createChallengeId();
    assertSha256(challengeId, "challengeId", "INVALID_SIDECAR");
    let rawProof: unknown;
    try {
      rawProof = await this.#adapter.challengeWorker({
        challengeId,
        sidecar: structuredClone(sidecar),
      });
    } catch {
      this.#assertLeases();
      return blocked(desiredRecord.subject, "WORKER_CHALLENGE_UNAVAILABLE");
    }
    // A lost coordinator lease is not a worker-health observation. Keep it outside the adapter
    // catch so a replaced coordinator cannot continue reconciling under a benign BLOCKED result.
    this.#assertLeases();
    let proof: ManagedBridgeRuntimeWorkerProof;
    try {
      proof = validateWorkerProof(rawProof);
    } catch {
      return blocked(desiredRecord.subject, "WORKER_CHALLENGE_UNAVAILABLE");
    }
    if (
      proof.challengeId !== challengeId ||
      proof.sidecarId !== sidecar.sidecarId ||
      proof.sidecarRevision !== sidecar.revision ||
      proof.pid !== sidecar.pid ||
      !sameSubject(proof.subject, desiredRecord.subject)
    ) {
      return blocked(desiredRecord.subject, "WORKER_PROOF_MISMATCH");
    }
    if (!verifyWorkerProof(proof, sidecar)) {
      return blocked(desiredRecord.subject, "WORKER_PROOF_MISMATCH");
    }
    const healthAt = Date.parse(proof.healthUpdatedAt);
    const age = this.#now() - healthAt;
    if (!Number.isFinite(healthAt) || age < 0 || age > this.#healthFreshnessMs) {
      return blocked(desiredRecord.subject, "WORKER_HEALTH_STALE");
    }

    const subjectKey = managedBridgeActiveSubjectKey(desiredRecord.subject);
    const secondRaw = await this.#adapter.enumerateSidecars(subjectKey);
    this.#assertLeases();
    if (!Array.isArray(secondRaw) || secondRaw.length > MAX_SIDECARS_PER_SUBJECT) {
      return blocked(desiredRecord.subject, "SIDECAR_CHANGED_DURING_PROBE");
    }
    let second: ManagedBridgeRuntimeSidecar[];
    try {
      second = secondRaw.map((value) => validateSidecar(value));
    } catch {
      return blocked(desiredRecord.subject, "SIDECAR_CHANGED_DURING_PROBE");
    }
    const current = second.filter((candidate) => candidate.state === "RUNNING");
    if (
      current.length !== 1 ||
      second.some((candidate) => candidate.state === "STARTING") ||
      !sameSidecar(current[0]!, sidecar)
    ) {
      return blocked(desiredRecord.subject, "SIDECAR_CHANGED_DURING_PROBE");
    }
    return outcome("HEALTHY", desiredRecord.subject);
  }

  #startingOutcome(
    subject: ManagedBridgeIpcSubject,
    sidecar: ManagedBridgeRuntimeSidecar,
  ): ManagedBridgeRuntimeOutcome {
    const updatedAt = Date.parse(sidecar.stateUpdatedAt);
    const age = this.#now() - updatedAt;
    return !Number.isFinite(updatedAt) || age < 0 || age > this.#startingGraceMs
      ? blocked(subject, "STALE_STARTING_SIDECAR")
      : outcome("STARTING_TRANSIENT", subject);
  }

  async #execute(command: ManagedBridgeRuntimeCommand): Promise<CommandExecution> {
    this.#assertLeases();
    validateCommand(command);
    let current = await this.#store.load(command.commandId);
    this.#assertLeases();
    let recovered = false;
    let dispatchCommand = structuredClone(command);
    if (current) {
      validateJournal(current);
      if (
        current.requestHash !== command.requestHash ||
        !sameLogicalCommand(current.command, command)
      ) {
        invalid(
          "JOURNAL_COMMAND_CONFLICT",
          "The runtime command id is bound to a different request",
        );
      }
      if (current.state === "COMPLETED") {
        validateReceiptForCommand(current.receipt, command, current.attemptFences);
        return { receipt: structuredClone(current.receipt!), disposition: "REPLAYED" };
      }
      recovered = true;
    } else {
      const claimed: ManagedBridgeRuntimeCommandJournal = {
        schemaVersion: 1,
        revision: 0,
        commandId: command.commandId,
        requestHash: command.requestHash,
        state: "CLAIMED",
        command: structuredClone(command),
        attemptFences: [structuredClone(command.leaseFence)],
        receipt: null,
      };
      this.#assertLeases();
      if (
        !(await this.#store.compareAndSwap(command.commandId, null, claimed, this.#journalLease))
      ) {
        invalid(
          "JOURNAL_CLAIM_CONFLICT",
          "The runtime command could not persist its claim before the process effect",
        );
      }
      current = claimed;
    }

    if (recovered) {
      const freshFence = this.#leaseFence();
      dispatchCommand = { ...structuredClone(current!.command), leaseFence: freshFence };
      validateCommand(dispatchCommand);
      if (!sameLeaseFence(current!.command.leaseFence, freshFence)) {
        if (current!.attemptFences.length >= MAX_COMMAND_ATTEMPT_FENCES) {
          invalid("JOURNAL_COMMAND_CONFLICT", "Runtime command exhausted its fence history");
        }
        const resealed: ManagedBridgeRuntimeCommandJournal = {
          ...current!,
          revision: current!.revision + 1,
          command: structuredClone(dispatchCommand),
          attemptFences: [...current!.attemptFences, structuredClone(freshFence)],
        };
        if (
          !(await this.#store.compareAndSwap(
            command.commandId,
            current!.revision,
            resealed,
            this.#journalLease,
          ))
        ) {
          invalid("JOURNAL_CLAIM_CONFLICT", "Runtime command fence reseal lost its journal CAS");
        }
        this.#assertLeases();
        current = resealed;
      }
    }

    // A durable CLAIMED row means the receiver may already have applied the effect and only its
    // response was lost. Mutable desired/sidecar state is therefore checked only before the first
    // dispatch; recovery must replay the same commandId so the receiver can return its stored
    // receipt instead of deadlocking on the effect's own state transition.
    if (!recovered) await this.#assertCommandPrecondition(dispatchCommand);
    this.#assertLeases();
    let rawReceipt: unknown;
    try {
      rawReceipt = await this.#adapter.dispatch(structuredClone(dispatchCommand));
    } catch {
      this.#assertLeases();
      invalid(
        "EFFECT_RESPONSE_UNKNOWN",
        "The exact process effect response is unknown; replay the same command id",
      );
    }
    this.#assertLeases();
    const receipt = validateReceiptForCommand(rawReceipt, dispatchCommand, current!.attemptFences);
    const completed: ManagedBridgeRuntimeCommandJournal = {
      ...current!,
      revision: current!.revision + 1,
      state: "COMPLETED",
      receipt: structuredClone(receipt),
    };
    const completedPersisted = await this.#store.compareAndSwap(
      command.commandId,
      current!.revision,
      completed,
      this.#journalLease,
    );
    this.#assertLeases();
    if (!completedPersisted) {
      const winner = await this.#store.load(command.commandId);
      this.#assertLeases();
      if (winner) {
        validateJournal(winner);
        this.#assertLeases();
      }
      if (
        winner?.state === "COMPLETED" &&
        winner.requestHash === command.requestHash &&
        sameLogicalCommand(winner.command, command)
      ) {
        const exact = validateReceiptForCommand(
          winner.receipt,
          dispatchCommand,
          winner.attemptFences,
        );
        return { receipt: structuredClone(exact), disposition: "REPLAYED" };
      }
      invalid(
        "JOURNAL_COMPLETE_CONFLICT",
        "The applied runtime command could not persist its exact receipt",
      );
    }
    return {
      receipt,
      disposition: recovered ? "RECOVERED" : "APPLIED",
    };
  }

  #assertLeases(): void {
    this.#controlLease.assertActive();
    this.#journalLease.assertActive();
  }

  #leaseFence(): ManagedBridgeRuntimeLeaseFence {
    this.#assertLeases();
    const fence: ManagedBridgeRuntimeLeaseFence = {
      schemaVersion: 1,
      controlLeaseId: this.#controlLease.leaseId,
      controlLeaseGeneration: this.#controlLease.generation,
      journalLeaseId: this.#journalLease.leaseId,
      journalLeaseGeneration: this.#journalLease.generation,
    };
    validateLeaseFence(fence, "JOURNAL_COMMAND_CONFLICT");
    return fence;
  }

  async #assertCommandPrecondition(command: ManagedBridgeRuntimeCommand): Promise<void> {
    this.#assertLeases();
    if (command.kind === "RELEASE_REBIND_EXACT" || command.kind === "RELEASE_ROLLBACK_EXACT") {
      const current = validateReleaseAuthorization(
        await this.#adapter.readReleaseAuthorization({
          operationId: command.operationId,
          subjectKey: managedBridgeActiveSubjectKey(command.previousSubject),
        }),
        "EFFECT_PRECONDITION_CHANGED",
      );
      this.#assertLeases();
      if (canonicalJson(current) !== canonicalJson(command.releaseAuthorization)) {
        invalid(
          "EFFECT_PRECONDITION_CHANGED",
          "Durable release authorization changed before the process effect",
        );
      }
      return;
    }

    const rawDesired = await this.#adapter.enumerateDesired();
    this.#assertLeases();
    if (!Array.isArray(rawDesired) || rawDesired.length > MAX_DESIRED_RECORDS) {
      invalid("EFFECT_PRECONDITION_CHANGED", "Desired state became unavailable before effect");
    }
    let desiredRecords: ManagedBridgeRuntimeDesiredRecord[];
    try {
      desiredRecords = rawDesired.map((value) => validateDesiredRecord(value));
    } catch {
      invalid("EFFECT_PRECONDITION_CHANGED", "Desired state became invalid before effect");
    }
    const subjectKey = managedBridgeActiveSubjectKey(command.subject);
    const matching = desiredRecords.filter(
      (record) => managedBridgeActiveSubjectKey(record.subject) === subjectKey,
    );
    const expectedDesired: ManagedBridgeRuntimeDesiredRecord =
      command.kind === "START_EXACT"
        ? {
            schemaVersion: 1,
            revision: command.desiredRevision,
            desiredState: "RUNNING",
            subject: command.subject,
            stopReceipt: null,
          }
        : {
            schemaVersion: 1,
            revision: command.desiredRevision,
            desiredState: "STOPPED",
            subject: command.subject,
            stopReceipt: command.persistedStopReceipt,
          };
    if (matching.length !== 1 || canonicalJson(matching[0]) !== canonicalJson(expectedDesired)) {
      invalid("EFFECT_PRECONDITION_CHANGED", "Desired state changed before the process effect");
    }

    const rawSidecars = await this.#adapter.enumerateSidecars(subjectKey);
    this.#assertLeases();
    if (!Array.isArray(rawSidecars) || rawSidecars.length > MAX_SIDECARS_PER_SUBJECT) {
      invalid("EFFECT_PRECONDITION_CHANGED", "Worker sidecar became unavailable before effect");
    }
    let sidecars: ManagedBridgeRuntimeSidecar[];
    try {
      sidecars = rawSidecars.map((value) => validateSidecar(value));
    } catch {
      invalid("EFFECT_PRECONDITION_CHANGED", "Worker sidecar became invalid before effect");
    }
    const expectedSidecar =
      command.kind === "START_EXACT" ? command.recoverySidecar : command.workerSidecar;
    const candidates = sidecars.filter((candidate) => {
      if (command.kind === "START_EXACT") {
        return candidate.state === "EXITED" || candidate.state === "STOPPED";
      }
      return expectedSidecar?.state === "RUNNING"
        ? candidate.state === "RUNNING"
        : candidate.state === "EXITED" || candidate.state === "STOPPED";
    });
    if (
      candidates.length !== (expectedSidecar === null ? 0 : 1) ||
      sidecars.some((candidate) =>
        command.kind === "START_EXACT"
          ? candidate.state === "RUNNING" || candidate.state === "STARTING"
          : candidate.state === "STARTING",
      ) ||
      (expectedSidecar !== null && !sameSidecar(candidates[0]!, expectedSidecar))
    ) {
      invalid("EFFECT_PRECONDITION_CHANGED", "Worker sidecar changed before the process effect");
    }
  }
}

type CommandInput =
  | Omit<Extract<ManagedBridgeRuntimeCommand, { kind: "START_EXACT" }>, "commandId" | "requestHash">
  | Omit<Extract<ManagedBridgeRuntimeCommand, { kind: "STOP_EXACT" }>, "commandId" | "requestHash">
  | Omit<
      Extract<
        ManagedBridgeRuntimeCommand,
        { kind: "RELEASE_REBIND_EXACT" | "RELEASE_ROLLBACK_EXACT" }
      >,
      "commandId" | "requestHash"
    >;

function createCommand(input: CommandInput): ManagedBridgeRuntimeCommand {
  const { leaseFence: _leaseFence, ...logicalInput } = input;
  const commandId = digest({ namespace: "managed-bridge-runtime-command-v1", input: logicalInput });
  const requestHash = digest({ commandId, input: logicalInput });
  const command = {
    ...structuredClone(input),
    commandId,
    requestHash,
  } as ManagedBridgeRuntimeCommand;
  validateCommand(command);
  return command;
}

function validateCommand(value: unknown): asserts value is ManagedBridgeRuntimeCommand {
  assertNoSecretFields(value);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid("JOURNAL_COMMAND_CONFLICT", "Invalid runtime command envelope");
  }
  const raw = value as Record<string, unknown>;
  const common = [
    "schemaVersion",
    "kind",
    "commandId",
    "requestHash",
    "subject",
    "desiredRevision",
    "leaseFence",
  ];
  if (raw.kind === "START_EXACT") {
    strictRecord(raw, [...common, "recoverySidecar"], "JOURNAL_COMMAND_CONFLICT");
  } else if (raw.kind === "STOP_EXACT") {
    strictRecord(
      raw,
      [...common, "persistedStopReceipt", "workerSidecar"],
      "JOURNAL_COMMAND_CONFLICT",
    );
  } else if (raw.kind === "RELEASE_REBIND_EXACT" || raw.kind === "RELEASE_ROLLBACK_EXACT") {
    strictRecord(
      raw,
      [...common, "operationId", "previousSubject", "releaseAuthorization"],
      "JOURNAL_COMMAND_CONFLICT",
    );
  } else {
    invalid("JOURNAL_COMMAND_CONFLICT", "Invalid runtime command kind");
  }
  if (raw.schemaVersion !== 1) {
    invalid("JOURNAL_COMMAND_CONFLICT", "Invalid runtime command schema");
  }
  validateIdentifier(raw.commandId, "commandId", "JOURNAL_COMMAND_CONFLICT");
  assertSha256(raw.requestHash, "requestHash", "JOURNAL_COMMAND_CONFLICT");
  assertNonNegativeInteger(raw.desiredRevision, "desiredRevision", "JOURNAL_COMMAND_CONFLICT");
  validateSubject(raw.subject, "JOURNAL_COMMAND_CONFLICT");
  validateLeaseFence(raw.leaseFence, "JOURNAL_COMMAND_CONFLICT");
  if (raw.kind === "START_EXACT") {
    const recoverySidecar = validateSidecar(raw.recoverySidecar);
    if (
      (recoverySidecar.state !== "EXITED" && recoverySidecar.state !== "STOPPED") ||
      !sameSubject(recoverySidecar.subject, raw.subject)
    ) {
      invalid("JOURNAL_COMMAND_CONFLICT", "START command recovery sidecar is not exact");
    }
  } else if (raw.kind === "STOP_EXACT") {
    validateStopReceipt(
      raw.persistedStopReceipt,
      raw.subject,
      raw.desiredRevision,
      "JOURNAL_COMMAND_CONFLICT",
    );
    const workerSidecar = raw.workerSidecar === null ? null : validateSidecar(raw.workerSidecar);
    if (workerSidecar && !sameSubject(workerSidecar.subject, raw.subject)) {
      invalid("JOURNAL_COMMAND_CONFLICT", "STOP command worker sidecar is not exact");
    }
  } else {
    if (typeof raw.operationId !== "string" || !RELEASE_OPERATION_ID.test(raw.operationId)) {
      invalid("JOURNAL_COMMAND_CONFLICT", "Invalid release command operation id");
    }
    validateSubject(raw.previousSubject, "JOURNAL_COMMAND_CONFLICT");
    validateReleaseAuthorizationForTransition(raw.releaseAuthorization, {
      operationId: raw.operationId,
      kind: raw.kind === "RELEASE_REBIND_EXACT" ? "REBIND" : "ROLLBACK",
      desiredRevision: raw.desiredRevision,
      previousSubject: raw.previousSubject,
      nextSubject: raw.subject,
    });
  }
  const command = raw as ManagedBridgeRuntimeCommand;
  const {
    commandId: _commandId,
    requestHash: _requestHash,
    leaseFence: _leaseFence,
    ...logicalInput
  } = command;
  const expectedId = digest({
    namespace: "managed-bridge-runtime-command-v1",
    input: logicalInput,
  });
  const expectedHash = digest({ commandId: expectedId, input: logicalInput });
  if (command.commandId !== expectedId || command.requestHash !== expectedHash) {
    invalid("JOURNAL_COMMAND_CONFLICT", "Runtime command digest mismatch");
  }
}

function validateDesiredRecord(value: unknown): ManagedBridgeRuntimeDesiredRecord {
  assertNoSecretFields(value);
  const record = strictRecord(
    value,
    ["schemaVersion", "revision", "desiredState", "subject", "stopReceipt"],
    "INVALID_DESIRED_RECORD",
  );
  if (record.schemaVersion !== 1) invalid("INVALID_DESIRED_RECORD", "Invalid desired schema");
  assertNonNegativeInteger(record.revision, "revision", "INVALID_DESIRED_RECORD");
  if (record.desiredState !== "RUNNING" && record.desiredState !== "STOPPED") {
    invalid("INVALID_DESIRED_RECORD", "Invalid desired state");
  }
  validateSubject(record.subject, "INVALID_DESIRED_RECORD");
  if (record.desiredState === "RUNNING") {
    if (record.stopReceipt !== null) {
      invalid("INVALID_DESIRED_RECORD", "RUNNING desired state cannot retain a stop receipt");
    }
  } else {
    validateStopReceipt(record.stopReceipt, record.subject, record.revision);
  }
  return structuredClone(record) as ManagedBridgeRuntimeDesiredRecord;
}

function validateStopReceipt(
  value: unknown,
  subject: ManagedBridgeIpcSubject,
  desiredRevision: number,
  code: ManagedBridgeRuntimeErrorCode = "INVALID_DESIRED_RECORD",
): asserts value is ManagedBridgeRuntimeStopReceipt {
  const receipt = strictRecord(value, ["kind", "receiptId", "desiredRevision", "subjectKey"], code);
  if (receipt.kind !== "DESIRED_STOP_PERSISTED") {
    invalid(code, "Invalid persisted stop receipt kind");
  }
  validateIdentifier(receipt.receiptId, "stopReceipt.receiptId", code);
  if (
    receipt.desiredRevision !== desiredRevision ||
    receipt.subjectKey !== managedBridgeActiveSubjectKey(subject)
  ) {
    invalid(code, "Persisted stop receipt does not bind desired state");
  }
}

function validateSidecar(value: unknown): ManagedBridgeRuntimeSidecar {
  assertNoSecretFields(value);
  const record = strictRecord(
    value,
    [
      "schemaVersion",
      "kind",
      "sidecarId",
      "revision",
      "state",
      "subject",
      "pid",
      "workerPipePath",
      "workerPublicKeySpkiDerBase64",
      "workerPublicKeySha256",
      "stateUpdatedAt",
    ],
    "INVALID_SIDECAR",
  );
  if (record.schemaVersion !== 1 || record.kind !== "BRIDGE_WORKER_PROOF_SIDECAR") {
    invalid("INVALID_SIDECAR", "Invalid sidecar schema");
  }
  validateIdentifier(record.sidecarId, "sidecarId", "INVALID_SIDECAR");
  assertNonNegativeInteger(record.revision, "revision", "INVALID_SIDECAR");
  if (
    record.state !== "STARTING" &&
    record.state !== "RUNNING" &&
    record.state !== "EXITED" &&
    record.state !== "STOPPED"
  ) {
    invalid("INVALID_SIDECAR", "Invalid sidecar state");
  }
  validateSubject(record.subject, "INVALID_SIDECAR");
  if (typeof record.workerPipePath !== "string" || record.workerPipePath.length === 0) {
    invalid("INVALID_SIDECAR", "Invalid worker pipe path");
  }
  const publicKeyDer = validateWorkerPublicKey(record.workerPublicKeySpkiDerBase64);
  assertSha256(record.workerPublicKeySha256, "workerPublicKeySha256", "INVALID_SIDECAR");
  if (createHash("sha256").update(publicKeyDer).digest("hex") !== record.workerPublicKeySha256) {
    invalid("INVALID_SIDECAR", "Worker public key fingerprint mismatch");
  }
  validateIsoTimestamp(record.stateUpdatedAt, "stateUpdatedAt", "INVALID_SIDECAR");
  if (record.state === "RUNNING") {
    assertPositiveInteger(record.pid, "pid", "INVALID_SIDECAR");
  } else if (record.pid !== null && (!Number.isInteger(record.pid) || Number(record.pid) <= 0)) {
    invalid("INVALID_SIDECAR", "Invalid sidecar pid");
  }
  return structuredClone(record) as ManagedBridgeRuntimeSidecar;
}

function validateWorkerProof(value: unknown): ManagedBridgeRuntimeWorkerProof {
  assertNoSecretFields(value);
  const record = strictRecord(
    value,
    [
      "schemaVersion",
      "kind",
      "challengeId",
      "sidecarId",
      "sidecarRevision",
      "subject",
      "pid",
      "healthUpdatedAt",
      "signatureBase64",
    ],
    "INVALID_SIDECAR",
  );
  if (record.schemaVersion !== 1 || record.kind !== "BRIDGE_WORKER_CHALLENGE_OK") {
    invalid("INVALID_SIDECAR", "Invalid worker proof envelope");
  }
  assertSha256(record.challengeId, "challengeId", "INVALID_SIDECAR");
  validateIdentifier(record.sidecarId, "sidecarId", "INVALID_SIDECAR");
  assertNonNegativeInteger(record.sidecarRevision, "sidecarRevision", "INVALID_SIDECAR");
  validateSubject(record.subject, "INVALID_SIDECAR");
  assertPositiveInteger(record.pid, "pid", "INVALID_SIDECAR");
  validateIsoTimestamp(record.healthUpdatedAt, "healthUpdatedAt", "INVALID_SIDECAR");
  validateEd25519Signature(record.signatureBase64);
  return structuredClone(record) as ManagedBridgeRuntimeWorkerProof;
}

function validateWorkerPublicKey(value: unknown): Buffer {
  const bytes = decodeCanonicalBase64(value, "workerPublicKeySpkiDerBase64", 128);
  try {
    const key = createPublicKey({ key: bytes, format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ed25519")
      invalid("INVALID_SIDECAR", "Worker key is not Ed25519");
  } catch (error) {
    if (error instanceof ManagedBridgeRuntimeError) throw error;
    invalid("INVALID_SIDECAR", "Invalid worker Ed25519 public key");
  }
  return bytes;
}

function validateEd25519Signature(value: unknown): void {
  const bytes = decodeCanonicalBase64(value, "signatureBase64", 64);
  if (bytes.length !== 64) invalid("INVALID_SIDECAR", "Invalid Ed25519 signature length");
}

function decodeCanonicalBase64(value: unknown, path: string, maxBytes: number): Buffer {
  if (typeof value !== "string" || value.length === 0 || value.length > maxBytes * 2) {
    invalid("INVALID_SIDECAR", `Invalid ${path}`);
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.length === 0 || bytes.length > maxBytes || bytes.toString("base64") !== value) {
    invalid("INVALID_SIDECAR", `Invalid ${path}`);
  }
  return bytes;
}

function verifyWorkerProof(
  proof: ManagedBridgeRuntimeWorkerProof,
  sidecar: ManagedBridgeRuntimeSidecar,
): boolean {
  return verifyBridgeWorkerProofSignature({
    workerPublicKeySpkiDerBase64: sidecar.workerPublicKeySpkiDerBase64,
    proof,
  });
}

function validateReleaseAuthorizationForTransition(
  value: unknown,
  transition: ManagedBridgeReleaseTransition,
): ManagedBridgeRuntimeReleaseAuthorization {
  const proof = validateReleaseAuthorization(value, "RELEASE_SUBJECT_MISMATCH");
  const authorization = proof.transitionAuthorization;
  const expectedOutcome = transition.kind === "REBIND" ? "DEPLOYED" : "ROLLED_BACK";
  const expectedInstalled = transition.nextSubject.build;
  const pauseSubject =
    transition.kind === "REBIND" ? transition.previousSubject : transition.nextSubject;
  const { subjectRevision, ...provenSubject } = proof.pausedSubject.subjectProof;
  if (
    authorization.operationId !== transition.operationId ||
    authorization.authorizedOutcome !== expectedOutcome ||
    subjectRevision !== transition.desiredRevision ||
    !sameSubject(provenSubject, pauseSubject) ||
    canonicalJson(authorization.installedIdentity) !== canonicalJson(expectedInstalled) ||
    canonicalJson(authorization.sourceIdentity) !==
      canonicalJson(
        transition.kind === "REBIND"
          ? transition.previousSubject.build
          : transition.nextSubject.build,
      ) ||
    canonicalJson(authorization.candidateIdentity) !==
      canonicalJson(
        transition.kind === "REBIND"
          ? transition.nextSubject.build
          : transition.previousSubject.build,
      )
  ) {
    invalid(
      "RELEASE_SUBJECT_MISMATCH",
      "Durable release authorization does not bind the exact Supervisor transition",
    );
  }
  return proof;
}

function validateReleaseAuthorization(
  value: unknown,
  code: ManagedBridgeRuntimeErrorCode,
): ManagedBridgeRuntimeReleaseAuthorization {
  assertNoSecretFields(value);
  const envelope = strictRecord(
    value,
    ["subjectIndex", "transitionAuthorization", "pausedSubject"],
    code,
  );
  assertNonNegativeInteger(envelope.subjectIndex, "subjectIndex", code);
  const authorization = strictRecord(
    envelope.transitionAuthorization,
    [
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
    ],
    code,
  );
  if (
    authorization.schemaVersion !== 1 ||
    typeof authorization.operationId !== "string" ||
    !RELEASE_OPERATION_ID.test(authorization.operationId) ||
    (authorization.authorizedOutcome !== "DEPLOYED" &&
      authorization.authorizedOutcome !== "ROLLED_BACK")
  ) {
    invalid(code, "Invalid durable release authorization envelope");
  }
  validateIdentifier(authorization.authorizationId, "authorizationId", code);
  assertSha256(authorization.requestFingerprint, "requestFingerprint", code);
  assertPositiveInteger(authorization.atomicJournalRevision, "atomicJournalRevision", code);
  assertPositiveInteger(authorization.pointerRevision, "pointerRevision", code);
  assertPositiveInteger(authorization.supervisorJournalRevision, "supervisorJournalRevision", code);
  validateIdentifier(authorization.pauseReceiptId, "pauseReceiptId", code);
  validateReleaseBuild(authorization.sourceIdentity, code);
  validateReleaseBuild(authorization.candidateIdentity, code);
  validateReleaseBuild(authorization.installedIdentity, code);
  assertSha256(authorization.pauseReceiptSha256, "pauseReceiptSha256", code);
  validateIsoTimestamp(authorization.issuedAt, "issuedAt", code);
  assertSha256(authorization.authorizationSha256, "authorizationSha256", code);
  const { authorizationSha256: _authorizationSha256, ...unsignedAuthorization } = authorization;
  if (authorization.authorizationSha256 !== digest(unsignedAuthorization)) {
    invalid(code, "Release authorization digest mismatch");
  }
  const expectedInstalled =
    authorization.authorizedOutcome === "DEPLOYED"
      ? authorization.candidateIdentity
      : authorization.sourceIdentity;
  if (canonicalJson(authorization.installedIdentity) !== canonicalJson(expectedInstalled)) {
    invalid(code, "Release authorization installed identity is inconsistent");
  }
  const pausedSubject = strictRecord(
    envelope.pausedSubject,
    ["previousDesiredState", "subjectProof", "subjectProofSha256"],
    code,
  );
  if (
    pausedSubject.previousDesiredState !== "RUNNING" &&
    pausedSubject.previousDesiredState !== "STOPPED"
  ) {
    invalid(code, "Invalid previous desired state in paused Supervisor subject");
  }
  const subjectProof = validateReleaseSubjectProof(pausedSubject.subjectProof, code);
  assertSha256(pausedSubject.subjectProofSha256, "subjectProofSha256", code);
  if (
    pausedSubject.subjectProofSha256 !==
    digest({ previousDesiredState: pausedSubject.previousDesiredState, subjectProof })
  ) {
    invalid(code, "Paused Supervisor subject proof digest mismatch");
  }
  if (
    !Number.isSafeInteger(
      Number(authorization.supervisorJournalRevision) + Number(envelope.subjectIndex) + 1,
    )
  ) {
    invalid(code, "Release authorization Supervisor revision overflows");
  }
  return structuredClone(envelope) as ManagedBridgeRuntimeReleaseAuthorization;
}

function validateReleaseSubjectProof(
  value: unknown,
  code: ManagedBridgeRuntimeErrorCode,
): ManagedBridgeRuntimeReleaseSubjectProof {
  assertNoSecretFields(value);
  const proof = strictRecord(
    value,
    [
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
    ],
    code,
  );
  assertNonNegativeInteger(proof.subjectRevision, "subjectRevision", code);
  const { subjectRevision: _subjectRevision, ...rawSubject } = proof;
  validateSubject(rawSubject, code);
  return structuredClone(proof) as ManagedBridgeRuntimeReleaseSubjectProof;
}

function validateJournal(value: unknown): asserts value is ManagedBridgeRuntimeCommandJournal {
  assertNoSecretFields(value);
  const record = strictRecord(
    value,
    [
      "schemaVersion",
      "revision",
      "commandId",
      "requestHash",
      "state",
      "command",
      "attemptFences",
      "receipt",
    ],
    "JOURNAL_COMMAND_CONFLICT",
  );
  if (record.schemaVersion !== 1) invalid("JOURNAL_COMMAND_CONFLICT", "Invalid journal schema");
  assertNonNegativeInteger(record.revision, "revision", "JOURNAL_COMMAND_CONFLICT");
  validateIdentifier(record.commandId, "commandId", "JOURNAL_COMMAND_CONFLICT");
  assertSha256(record.requestHash, "requestHash", "JOURNAL_COMMAND_CONFLICT");
  if (record.state !== "CLAIMED" && record.state !== "COMPLETED") {
    invalid("JOURNAL_COMMAND_CONFLICT", "Invalid journal state");
  }
  validateCommand(record.command as ManagedBridgeRuntimeCommand);
  if (
    !Array.isArray(record.attemptFences) ||
    record.attemptFences.length === 0 ||
    record.attemptFences.length > MAX_COMMAND_ATTEMPT_FENCES
  ) {
    invalid("JOURNAL_COMMAND_CONFLICT", "Invalid runtime command fence history");
  }
  const attemptFences = record.attemptFences.map((fence) => {
    validateLeaseFence(fence, "JOURNAL_COMMAND_CONFLICT");
    return fence;
  });
  if (
    new Set(attemptFences.map((fence) => canonicalJson(fence))).size !== attemptFences.length ||
    !sameLeaseFence(
      attemptFences[attemptFences.length - 1] as ManagedBridgeRuntimeLeaseFence,
      (record.command as ManagedBridgeRuntimeCommand).leaseFence,
    )
  ) {
    invalid("JOURNAL_COMMAND_CONFLICT", "Runtime command fence history is not exact");
  }
  if (
    (record.command as ManagedBridgeRuntimeCommand).commandId !== record.commandId ||
    (record.command as ManagedBridgeRuntimeCommand).requestHash !== record.requestHash
  ) {
    invalid("JOURNAL_COMMAND_CONFLICT", "Journal does not bind its exact command");
  }
  if (record.state === "CLAIMED" && record.receipt !== null) {
    invalid("JOURNAL_COMMAND_CONFLICT", "Claimed journal cannot contain a receipt");
  }
  if (record.state === "COMPLETED") {
    validateReceiptForCommand(
      record.receipt,
      record.command as ManagedBridgeRuntimeCommand,
      attemptFences as ManagedBridgeRuntimeLeaseFence[],
    );
  }
}

function validateReceiptForCommand(
  value: unknown,
  command: ManagedBridgeRuntimeCommand,
  allowedFences: readonly ManagedBridgeRuntimeLeaseFence[] = [command.leaseFence],
): ManagedBridgeRuntimeEffectReceipt {
  assertNoSecretFields(value);
  const release =
    command.kind === "RELEASE_REBIND_EXACT" || command.kind === "RELEASE_ROLLBACK_EXACT";
  const stop = command.kind === "STOP_EXACT";
  const keys = [
    "schemaVersion",
    "kind",
    "commandId",
    "requestHash",
    "subject",
    "subjectKey",
    "recordRevision",
    "eventSequence",
    "leaseFence",
    ...(stop ? ["effect"] : []),
    ...(release ? ["previousSubject", "releaseEffect"] : []),
  ];
  const receipt = strictRecord(value, keys, "INVALID_EFFECT_RECEIPT");
  const expectedKind: ManagedBridgeRuntimeEffectReceipt["kind"] =
    command.kind === "START_EXACT"
      ? "STARTED"
      : command.kind === "STOP_EXACT"
        ? "STOPPED"
        : command.releaseAuthorization.pausedSubject.previousDesiredState === "STOPPED"
          ? "ALREADY_STOPPED"
          : command.kind === "RELEASE_REBIND_EXACT"
            ? "REBOUND"
            : "ROLLED_BACK";
  if (
    receipt.schemaVersion !== 1 ||
    receipt.kind !== expectedKind ||
    receipt.commandId !== command.commandId ||
    receipt.requestHash !== command.requestHash
  ) {
    invalid("INVALID_EFFECT_RECEIPT", "Effect receipt does not bind the exact command");
  }
  if (
    stop &&
    receipt.effect !== (command.workerSidecar?.state === "RUNNING" ? "STOPPED" : "ALREADY_STOPPED")
  ) {
    invalid("INVALID_EFFECT_RECEIPT", "Stop effect receipt does not match process state");
  }
  validateLeaseFence(receipt.leaseFence, "INVALID_EFFECT_RECEIPT");
  if (!allowedFences.some((fence) => canonicalJson(receipt.leaseFence) === canonicalJson(fence))) {
    invalid("INVALID_EFFECT_RECEIPT", "Effect receipt does not bind the accepted lease fence");
  }
  validateSubject(receipt.subject, "INVALID_EFFECT_RECEIPT");
  if (
    !sameSubject(receipt.subject as ManagedBridgeIpcSubject, command.subject) ||
    receipt.subjectKey !== managedBridgeActiveSubjectKey(command.subject)
  ) {
    invalid("INVALID_EFFECT_RECEIPT", "Effect receipt does not bind the exact subject");
  }
  assertNonNegativeInteger(receipt.recordRevision, "recordRevision", "INVALID_EFFECT_RECEIPT");
  assertNonNegativeInteger(receipt.eventSequence, "eventSequence", "INVALID_EFFECT_RECEIPT");
  if (Number(receipt.eventSequence) < command.subject.checkpointEventSequence) {
    invalid("INVALID_EFFECT_RECEIPT", "Effect receipt regresses the event sequence");
  }
  if (release) {
    validateSubject(receipt.previousSubject, "INVALID_EFFECT_RECEIPT");
    if (!sameSubject(receipt.previousSubject as ManagedBridgeIpcSubject, command.previousSubject)) {
      invalid("INVALID_EFFECT_RECEIPT", "Release receipt does not bind the previous subject");
    }
    validateReleaseEffectReceiptForCommand(receipt.releaseEffect, command);
  }
  return structuredClone(receipt) as ManagedBridgeRuntimeEffectReceipt;
}

function validateReleaseEffectReceiptForCommand(
  value: unknown,
  command: Extract<
    ManagedBridgeRuntimeCommand,
    { kind: "RELEASE_REBIND_EXACT" | "RELEASE_ROLLBACK_EXACT" }
  >,
): ManagedBridgeReleaseEffectReceipt {
  const code = "INVALID_EFFECT_RECEIPT" as const;
  const receipt = strictRecord(
    value,
    [
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
    ],
    code,
  );
  const release = command.releaseAuthorization;
  const authorization = release.transitionAuthorization;
  const expectedEffect =
    release.pausedSubject.previousDesiredState === "STOPPED"
      ? "ALREADY_STOPPED"
      : command.kind === "RELEASE_REBIND_EXACT"
        ? "REBOUND"
        : "ROLLED_BACK";
  if (
    receipt.schemaVersion !== 1 ||
    receipt.authorizationId !== authorization.authorizationId ||
    receipt.authorizationSha256 !== authorization.authorizationSha256 ||
    receipt.operationId !== command.operationId ||
    receipt.effect !== expectedEffect ||
    receipt.previousDesiredState !== release.pausedSubject.previousDesiredState ||
    receipt.supervisorJournalRevision !==
      authorization.supervisorJournalRevision + release.subjectIndex + 1
  ) {
    invalid(code, "Release effect receipt does not bind the exact authorization and effect");
  }
  validateIdentifier(receipt.effectReceiptId, "effectReceiptId", code);
  assertSha256(receipt.authorizationSha256, "authorizationSha256", code);
  const subjectProof = validateReleaseSubjectProof(receipt.subjectProof, code);
  if (canonicalJson(subjectProof) !== canonicalJson(release.pausedSubject.subjectProof)) {
    invalid(code, "Release effect receipt changed the sealed Supervisor subject");
  }
  assertSha256(receipt.sealedSubjectProofSha256, "sealedSubjectProofSha256", code);
  if (
    receipt.sealedSubjectProofSha256 !== release.pausedSubject.subjectProofSha256 ||
    receipt.sealedSubjectProofSha256 !==
      digest({ previousDesiredState: receipt.previousDesiredState, subjectProof })
  ) {
    invalid(code, "Release effect receipt does not preserve the sealed subject proof");
  }
  validateReleaseBuild(receipt.installedIdentity, code);
  if (canonicalJson(receipt.installedIdentity) !== canonicalJson(authorization.installedIdentity)) {
    invalid(code, "Release effect receipt changed the installed identity");
  }
  validateIsoTimestamp(receipt.effectedAt, "effectedAt", code);
  assertSha256(receipt.effectReceiptSha256, "effectReceiptSha256", code);
  const { effectReceiptSha256: _effectReceiptSha256, ...unsignedReceipt } = receipt;
  if (receipt.effectReceiptSha256 !== digest(unsignedReceipt)) {
    invalid(code, "Release effect receipt digest mismatch");
  }
  return structuredClone(receipt) as ManagedBridgeReleaseEffectReceipt;
}

function validateSubject(
  value: unknown,
  code: ManagedBridgeRuntimeErrorCode,
): asserts value is ManagedBridgeIpcSubject {
  assertNoSecretFields(value);
  try {
    managedBridgeActiveSubjectKey(value as ManagedBridgeIpcSubject);
  } catch {
    invalid(code, "Invalid managed Bridge subject");
  }
}

function validateBuild(value: unknown, code: ManagedBridgeRuntimeErrorCode): void {
  const build = strictRecord(
    value,
    ["buildId", "buildSessionId", "protocolId", "manifestSha256", "migrationId"],
    code,
  );
  validateIdentifier(build.buildId, "buildId", code);
  validateIdentifier(build.buildSessionId, "buildSessionId", code);
  validateIdentifier(build.protocolId, "protocolId", code);
  assertSha256(build.manifestSha256, "manifestSha256", code);
  validateIdentifier(build.migrationId, "migrationId", code);
}

function validateLeaseFence(
  value: unknown,
  code: ManagedBridgeRuntimeErrorCode,
): asserts value is ManagedBridgeRuntimeLeaseFence {
  const fence = strictRecord(
    value,
    [
      "schemaVersion",
      "controlLeaseId",
      "controlLeaseGeneration",
      "journalLeaseId",
      "journalLeaseGeneration",
    ],
    code,
  );
  if (fence.schemaVersion !== 1) invalid(code, "Invalid lease fence schema");
  validateIdentifier(fence.controlLeaseId, "controlLeaseId", code);
  assertPositiveInteger(fence.controlLeaseGeneration, "controlLeaseGeneration", code);
  validateIdentifier(fence.journalLeaseId, "journalLeaseId", code);
  assertPositiveInteger(fence.journalLeaseGeneration, "journalLeaseGeneration", code);
}

function validateReleaseBuild(value: unknown, code: ManagedBridgeRuntimeErrorCode): void {
  validateBuild(value, code);
  const build = value as ManagedBridgeBuildIdentity;
  if (
    !SHA256.test(build.buildId) ||
    !UUID.test(build.buildSessionId) ||
    !SHA256.test(build.protocolId) ||
    !SHA256.test(build.migrationId)
  ) {
    invalid(code, "Release receipt identity is not canonical");
  }
}

function sameReleaseRun(previous: ManagedBridgeIpcSubject, next: ManagedBridgeIpcSubject): boolean {
  const { build: _previousBuild, ...previousRun } = previous;
  const { build: _nextBuild, ...nextRun } = next;
  return canonicalJson(previousRun) === canonicalJson(nextRun);
}

function sameSubject(left: ManagedBridgeIpcSubject, right: ManagedBridgeIpcSubject): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function sameSidecar(
  left: ManagedBridgeRuntimeSidecar,
  right: ManagedBridgeRuntimeSidecar,
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function sameLogicalCommand(
  left: ManagedBridgeRuntimeCommand,
  right: ManagedBridgeRuntimeCommand,
): boolean {
  const {
    leaseFence: _leftFence,
    commandId: _leftCommandId,
    requestHash: _leftRequestHash,
    ...leftLogical
  } = left;
  const {
    leaseFence: _rightFence,
    commandId: _rightCommandId,
    requestHash: _rightRequestHash,
    ...rightLogical
  } = right;
  return (
    left.commandId === right.commandId &&
    left.requestHash === right.requestHash &&
    canonicalJson(leftLogical) === canonicalJson(rightLogical)
  );
}

function sameLeaseFence(
  left: ManagedBridgeRuntimeLeaseFence,
  right: ManagedBridgeRuntimeLeaseFence,
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function outcome(
  status: ManagedBridgeRuntimeOutcome["status"],
  subject: ManagedBridgeIpcSubject,
  disposition?: ManagedBridgeRuntimeOutcome["disposition"],
): ManagedBridgeRuntimeOutcome {
  return {
    status,
    subject: structuredClone(subject),
    subjectKey: managedBridgeActiveSubjectKey(subject),
    ...(disposition ? { disposition } : {}),
  };
}

function blocked(
  subject: ManagedBridgeIpcSubject,
  reason: NonNullable<ManagedBridgeRuntimeOutcome["reason"]>,
): ManagedBridgeRuntimeOutcome {
  return { ...outcome("BLOCKED", subject), reason };
}

function outcomeFromReceipt(
  executed: CommandExecution,
  command: ManagedBridgeRuntimeCommand,
): ManagedBridgeRuntimeOutcome {
  if (command.kind === "RELEASE_REBIND_EXACT" || command.kind === "RELEASE_ROLLBACK_EXACT") {
    return releaseOutcome(executed);
  }
  const status =
    executed.receipt.kind === "STARTED"
      ? "STARTED"
      : executed.receipt.kind === "STOPPED"
        ? executed.receipt.effect === "ALREADY_STOPPED"
          ? "ALREADY_STOPPED"
          : "STOPPED"
        : executed.receipt.kind === "REBOUND"
          ? "REBOUND"
          : "ROLLED_BACK";
  return outcome(status, executed.receipt.subject, executed.disposition);
}

function releaseOutcome(executed: CommandExecution): ManagedBridgeRuntimeOutcome {
  if (!("releaseEffect" in executed.receipt)) {
    invalid("INVALID_EFFECT_RECEIPT", "Release command returned a non-release effect receipt");
  }
  const releaseReceipt = structuredClone(
    executed.receipt.releaseEffect,
  ) as ManagedBridgeRuntimeReleaseReceipt;
  return {
    ...outcome(
      releaseReceipt.effect === "ALREADY_STOPPED"
        ? "ALREADY_STOPPED"
        : releaseReceipt.effect === "REBOUND"
          ? "REBOUND"
          : "ROLLED_BACK",
      executed.receipt.subject,
      executed.disposition,
    ),
    releaseReceipt,
  };
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map(
      (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
    )
    .join(",")}}`;
}

function strictRecord(
  value: unknown,
  keys: readonly string[],
  code: ManagedBridgeRuntimeErrorCode,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid(code, "Invalid runtime record");
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    invalid(code, "Runtime record has unknown or missing fields");
  }
  return record;
}

function validateIdentifier(
  value: unknown,
  path: string,
  code: ManagedBridgeRuntimeErrorCode,
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_IDENTIFIER_CHARS ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0)!;
      return codePoint <= 0x1f || codePoint === 0x7f;
    })
  ) {
    invalid(code, `Invalid ${path}`);
  }
}

function assertSha256(
  value: unknown,
  path: string,
  code: ManagedBridgeRuntimeErrorCode,
): asserts value is string {
  if (typeof value !== "string" || !SHA256.test(value)) invalid(code, `Invalid ${path}`);
}

function assertNonNegativeInteger(
  value: unknown,
  path: string,
  code: ManagedBridgeRuntimeErrorCode,
): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) invalid(code, `Invalid ${path}`);
}

function assertPositiveInteger(
  value: unknown,
  path: string,
  code: ManagedBridgeRuntimeErrorCode,
): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) invalid(code, `Invalid ${path}`);
}

function validateIsoTimestamp(
  value: unknown,
  path: string,
  code: ManagedBridgeRuntimeErrorCode,
): asserts value is string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    invalid(code, `Invalid ${path}`);
  }
}

function assertNoSecretFields(value: unknown): void {
  const pending: Array<{ value: unknown; depth: number; exit?: boolean }> = [{ value, depth: 0 }];
  const active = new Set<object>();
  let nodes = 0;
  while (pending.length > 0) {
    const next = pending.pop()!;
    if (next.value === null || typeof next.value !== "object") continue;
    if (next.exit) {
      active.delete(next.value);
      continue;
    }
    if (next.depth > MAX_PAYLOAD_SCAN_DEPTH || ++nodes > MAX_PAYLOAD_SCAN_NODES) {
      invalid("PAYLOAD_BOUNDS_EXCEEDED", "Runtime payload exceeds scan bounds");
    }
    if (active.has(next.value)) {
      invalid("FORBIDDEN_SECRET_FIELD", "Cyclic runtime payload rejected");
    }
    active.add(next.value);
    pending.push({ ...next, exit: true });
    if (Array.isArray(next.value)) {
      for (const item of next.value) pending.push({ value: item, depth: next.depth + 1 });
      continue;
    }
    for (const [key, child] of Object.entries(next.value as Record<string, unknown>)) {
      const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (
        SECRET_FIELD_PARTS.some((part) => normalized.includes(part)) &&
        !NON_SECRET_AUTHORIZATION_FIELDS.has(normalized)
      ) {
        invalid("FORBIDDEN_SECRET_FIELD", "Secret-shaped runtime field rejected");
      }
      pending.push({ value: child, depth: next.depth + 1 });
    }
  }
}

function invalid(code: ManagedBridgeRuntimeErrorCode, message: string): never {
  throw new ManagedBridgeRuntimeError(code, message);
}
