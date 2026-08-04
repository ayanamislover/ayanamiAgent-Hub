import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import type { ManagedBridgeBuildIdentity, ManagedBridgeIpcLease } from "./managed-bridge-ipc.js";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const COMMAND_LEASE_MS = 30_000;
const CAS_ATTEMPTS = 32;
const BACKOFF_BASE_MS = [5_000, 30_000, 120_000, 600_000, 1_800_000] as const;
const BACKOFF_CAP_MS = 1_800_000;

export type ManagedBridgeIdentity = {
  projectId: string;
  agentId: "codex";
  runId: string;
  originalThreadId: string;
  projectRoot: string;
  entry: string;
  build: ManagedBridgeBuildIdentity;
  recovery: {
    sessionId: string;
    lineageId: string;
    incarnation: number;
    bundleId: string;
    vaultPath: string;
    vaultSha256: string;
    checkpointPath: string;
    checkpointSha256: string;
    checkpointEventSequence: number;
  };
};

export type ManagedBridgeRecoveryCommand = {
  kind: "PROBE_APP_SERVER";
  commandId: string;
  commandGeneration: number;
  fuseGeneration: number;
  identity: ManagedBridgeIdentity;
};

export type ManagedBridgeProbeObservation =
  | { kind: "HEALTHY"; identity: ManagedBridgeIdentity; fuseGeneration: number }
  | { kind: "FUSE_OPEN"; identity: ManagedBridgeIdentity; fuseGeneration: number }
  | {
      kind: "UNKNOWN" | "STARTING" | "RECOVERING";
      identity: ManagedBridgeIdentity;
      fuseGeneration: number;
    }
  | {
      kind: "BLOCKED";
      identity: ManagedBridgeIdentity;
      fuseGeneration: number | null;
      reason: string;
    };

export type ManagedBridgeProbeResult =
  | {
      kind: "RECOVERED";
      commandId: string;
      commandGeneration: number;
      fuseGeneration: number;
      identity: ManagedBridgeIdentity;
      stability: "STABLE";
    }
  | {
      kind: "STILL_OPEN";
      commandId: string;
      commandGeneration: number;
      fuseGeneration: number;
      identity: ManagedBridgeIdentity;
      reason: string;
    }
  | {
      kind: "BLOCKED";
      commandId: string;
      commandGeneration: number;
      fuseGeneration: number;
      identity: ManagedBridgeIdentity;
      reason: string;
    };

export interface ManagedBridgeProbeAdapter {
  /** Local-only worker inspection. This Adapter must never contact Hub or accept a credential. */
  inspect(identity: ManagedBridgeIdentity): Promise<ManagedBridgeProbeObservation>;
  /** Idempotent local command transport. The receiver deduplicates by commandId. */
  issue(command: ManagedBridgeRecoveryCommand): Promise<ManagedBridgeProbeResult>;
}

/**
 * Cross-run uniqueness Adapter. A production Adapter is expected to delegate to the managed IPC
 * active-subject registry, whose key is projectId + originalThreadId and whose mutations are
 * listener-lease fenced. Methods must be idempotent for exact replay.
 */
export interface ManagedBridgeActiveSubjectAdapter {
  ensureRunning(identity: ManagedBridgeIdentity): Promise<void>;
  advanceRunning(expected: ManagedBridgeIdentity, next: ManagedBridgeIdentity): Promise<void>;
  stop(identity: ManagedBridgeIdentity): Promise<void>;
}

export type ManagedBridgeSupervisorJournal = {
  schemaVersion: 2;
  key: string;
  revision: number;
  identity: ManagedBridgeIdentity;
  desiredState: "RUNNING" | "STOPPED";
  circuit: "CLOSED" | "OPEN" | "HALF_OPEN" | "BLOCKED";
  failureCount: number;
  commandGeneration: number;
  fuseGeneration: number | null;
  lastObservedFuseGeneration: number | null;
  activeCommand: {
    commandId: string;
    commandGeneration: number;
    fuseGeneration: number;
    identity: ManagedBridgeIdentity;
    claimedBy: string | null;
    claimLeaseUntil: string | null;
    dispatchCount: number;
    createdAt: string;
  } | null;
  nextAttemptAt: string | null;
  blockedReason: string | null;
  lastHealthyAt: string | null;
  updatedAt: string;
};

export interface ManagedBridgeSupervisorStore {
  load(key: string): Promise<ManagedBridgeSupervisorJournal | null>;
  compareAndSwap(
    key: string,
    expectedRevision: number | null,
    next: ManagedBridgeSupervisorJournal,
  ): Promise<boolean>;
}

export type ManagedBridgeBackoff = {
  baseMs: number;
  jitterMs: number;
  delayMs: number;
};

function canonicalIdentity(identity: ManagedBridgeIdentity): string {
  return JSON.stringify({
    projectId: identity.projectId,
    agentId: identity.agentId,
    runId: identity.runId,
    originalThreadId: identity.originalThreadId,
    projectRoot: identity.projectRoot,
    entry: identity.entry,
    build: {
      buildId: identity.build.buildId,
      buildSessionId: identity.build.buildSessionId,
      protocolId: identity.build.protocolId,
      manifestSha256: identity.build.manifestSha256,
      migrationId: identity.build.migrationId,
    },
    recovery: {
      sessionId: identity.recovery.sessionId,
      lineageId: identity.recovery.lineageId,
      incarnation: identity.recovery.incarnation,
      bundleId: identity.recovery.bundleId,
      vaultPath: identity.recovery.vaultPath,
      vaultSha256: identity.recovery.vaultSha256,
      checkpointPath: identity.recovery.checkpointPath,
      checkpointSha256: identity.recovery.checkpointSha256,
      checkpointEventSequence: identity.recovery.checkpointEventSequence,
    },
  });
}

function sameIdentity(left: ManagedBridgeIdentity, right: ManagedBridgeIdentity): boolean {
  return canonicalIdentity(left) === canonicalIdentity(right);
}

function sameManagedBridgeRun(left: ManagedBridgeIdentity, right: ManagedBridgeIdentity): boolean {
  return (
    left.projectId === right.projectId &&
    left.agentId === right.agentId &&
    left.runId === right.runId &&
    left.originalThreadId === right.originalThreadId &&
    left.projectRoot === right.projectRoot &&
    left.entry === right.entry &&
    sameBuildIdentity(left.build, right.build)
  );
}

function sameBuildIdentity(
  left: ManagedBridgeBuildIdentity,
  right: ManagedBridgeBuildIdentity,
): boolean {
  return (
    left.buildId === right.buildId &&
    left.buildSessionId === right.buildSessionId &&
    left.protocolId === right.protocolId &&
    left.manifestSha256 === right.manifestSha256 &&
    left.migrationId === right.migrationId
  );
}

function sameSubjectOutsideRelease(
  left: ManagedBridgeIdentity,
  right: ManagedBridgeIdentity,
): boolean {
  return (
    left.projectId === right.projectId &&
    left.agentId === right.agentId &&
    left.runId === right.runId &&
    left.originalThreadId === right.originalThreadId &&
    left.projectRoot === right.projectRoot &&
    JSON.stringify(left.recovery) === JSON.stringify(right.recovery)
  );
}

function recoveryProofProgresses(
  previous: ManagedBridgeIdentity,
  next: ManagedBridgeIdentity,
): boolean {
  if (sameIdentity(previous, next)) return true;
  const before = previous.recovery;
  const after = next.recovery;
  return (
    before.lineageId === after.lineageId &&
    before.vaultPath === after.vaultPath &&
    before.checkpointPath === after.checkpointPath &&
    after.checkpointEventSequence >= before.checkpointEventSequence &&
    after.incarnation >= before.incarnation &&
    (after.incarnation > before.incarnation || after.sessionId === before.sessionId)
  );
}

export function managedBridgeSupervisorKey(identity: ManagedBridgeIdentity): string {
  validateIdentity(identity);
  return createHash("sha256")
    .update(
      [identity.projectId, identity.agentId, identity.runId, identity.originalThreadId].join("\0"),
    )
    .digest("hex");
}

export function managedBridgeBackoff(
  identity: ManagedBridgeIdentity,
  fuseGeneration: number,
  failureCount: number,
): ManagedBridgeBackoff {
  validateIdentity(identity);
  assertPositiveInteger(fuseGeneration, "fuseGeneration");
  assertPositiveInteger(failureCount, "failureCount");
  const baseMs = BACKOFF_BASE_MS[Math.min(failureCount, BACKOFF_BASE_MS.length) - 1]!;
  const digest = createHash("sha256")
    .update(`${canonicalIdentity(identity)}\0${fuseGeneration}\0${failureCount}`)
    .digest();
  const unit = digest.readUInt32BE(0) / 0xffff_ffff;
  const jitterMs = Math.round(baseMs * ((unit * 2 - 1) * 0.2));
  return {
    baseMs,
    jitterMs,
    delayMs: Math.min(BACKOFF_CAP_MS, Math.max(1, baseMs + jitterMs)),
  };
}

function commandFor(journal: ManagedBridgeSupervisorJournal): ManagedBridgeRecoveryCommand {
  const commandGeneration = journal.commandGeneration + 1;
  const fuseGeneration = journal.fuseGeneration;
  if (fuseGeneration === null)
    throw new Error("Cannot generate a command without a fuse generation");
  const commandId = createHash("sha256")
    .update(`${canonicalIdentity(journal.identity)}\0${fuseGeneration}\0${commandGeneration}`)
    .digest("hex");
  return {
    kind: "PROBE_APP_SERVER",
    commandId,
    commandGeneration,
    fuseGeneration,
    identity: structuredClone(journal.identity),
  };
}

function iso(value: number): string {
  if (!Number.isFinite(value)) throw new Error("Supervisor clock returned a non-finite value");
  return new Date(value).toISOString();
}

function due(timestamp: string | null, now: number): boolean {
  return timestamp !== null && Date.parse(timestamp) <= now;
}

function freshJournal(
  identity: ManagedBridgeIdentity,
  now: number,
): ManagedBridgeSupervisorJournal {
  return {
    schemaVersion: 2,
    key: managedBridgeSupervisorKey(identity),
    revision: 0,
    identity: structuredClone(identity),
    desiredState: "RUNNING",
    circuit: "CLOSED",
    failureCount: 0,
    commandGeneration: 0,
    fuseGeneration: null,
    lastObservedFuseGeneration: null,
    activeCommand: null,
    nextAttemptAt: null,
    blockedReason: null,
    lastHealthyAt: null,
    updatedAt: iso(now),
  };
}

export class ManagedBridgeSupervisor {
  readonly #store: ManagedBridgeSupervisorStore;
  readonly #probe: ManagedBridgeProbeAdapter;
  readonly #activeSubjects: ManagedBridgeActiveSubjectAdapter;
  readonly #instanceId: string;
  readonly #now: () => number;
  readonly #commandLeaseMs: number;
  readonly #inFlight = new Map<string, Promise<ManagedBridgeSupervisorJournal>>();

  constructor(options: {
    store: ManagedBridgeSupervisorStore;
    probe: ManagedBridgeProbeAdapter;
    activeSubjects: ManagedBridgeActiveSubjectAdapter;
    instanceId?: string;
    now?: () => number;
    commandLeaseMs?: number;
  }) {
    this.#store = options.store;
    this.#probe = options.probe;
    this.#activeSubjects = options.activeSubjects;
    if (
      !this.#activeSubjects ||
      typeof this.#activeSubjects.ensureRunning !== "function" ||
      typeof this.#activeSubjects.advanceRunning !== "function" ||
      typeof this.#activeSubjects.stop !== "function"
    ) {
      throw new Error("Managed Bridge active-subject Adapter is required");
    }
    this.#instanceId = options.instanceId ?? randomBytes(16).toString("hex");
    this.#now = options.now ?? Date.now;
    this.#commandLeaseMs = options.commandLeaseMs ?? COMMAND_LEASE_MS;
    if (!this.#instanceId || this.#instanceId.length > 256) {
      throw new Error("Supervisor instanceId must be non-empty and bounded");
    }
    assertPositiveInteger(this.#commandLeaseMs, "commandLeaseMs");
  }

  async ensureRunning(identity: ManagedBridgeIdentity): Promise<ManagedBridgeSupervisorJournal> {
    validateIdentity(identity);
    const key = managedBridgeSupervisorKey(identity);
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
      const current = await this.#store.load(key);
      if (!current) {
        await this.#activeSubjects.ensureRunning(structuredClone(identity));
        const created = freshJournal(identity, this.#now());
        if (await this.#store.compareAndSwap(key, null, created)) return created;
        continue;
      }
      if (!sameManagedBridgeRun(current.identity, identity)) {
        return this.#blockCurrent(key, current, "IDENTITY_MISMATCH");
      }
      if (current.desiredState === "RUNNING") {
        if (sameIdentity(current.identity, identity)) {
          await this.#activeSubjects.ensureRunning(structuredClone(current.identity));
        }
        return current;
      }
      await this.#activeSubjects.ensureRunning(structuredClone(identity));
      const next: ManagedBridgeSupervisorJournal = {
        ...current,
        revision: current.revision + 1,
        desiredState: "RUNNING",
        updatedAt: iso(this.#now()),
      };
      if (await this.#store.compareAndSwap(key, current.revision, next)) return next;
    }
    throw new Error("Managed Bridge supervisor CAS contention while ensuring RUNNING");
  }

  async requestStop(identity: ManagedBridgeIdentity): Promise<ManagedBridgeSupervisorJournal> {
    validateIdentity(identity);
    const key = managedBridgeSupervisorKey(identity);
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
      const current = await this.#store.load(key);
      if (!current) {
        const created = {
          ...freshJournal(identity, this.#now()),
          desiredState: "STOPPED" as const,
        };
        if (await this.#store.compareAndSwap(key, null, created)) {
          await this.#activeSubjects.stop(structuredClone(created.identity));
          return created;
        }
        continue;
      }
      if (!sameManagedBridgeRun(current.identity, identity)) {
        return this.#blockCurrent(key, current, "IDENTITY_MISMATCH");
      }
      if (current.desiredState === "STOPPED") {
        await this.#activeSubjects.stop(structuredClone(current.identity));
        return current;
      }
      const remainsBlocked = current.circuit === "BLOCKED";
      const next: ManagedBridgeSupervisorJournal = {
        ...current,
        revision: current.revision + 1,
        desiredState: "STOPPED",
        circuit: remainsBlocked ? "BLOCKED" : "CLOSED",
        failureCount: remainsBlocked ? current.failureCount : 0,
        fuseGeneration: remainsBlocked ? current.fuseGeneration : null,
        activeCommand: null,
        nextAttemptAt: null,
        blockedReason: remainsBlocked ? current.blockedReason : null,
        updatedAt: iso(this.#now()),
      };
      if (await this.#store.compareAndSwap(key, current.revision, next)) {
        await this.#activeSubjects.stop(structuredClone(next.identity));
        return next;
      }
    }
    throw new Error("Managed Bridge supervisor CAS contention while requesting STOPPED");
  }

  async status(identity: ManagedBridgeIdentity): Promise<ManagedBridgeSupervisorJournal | null> {
    validateIdentity(identity);
    return this.#store.load(managedBridgeSupervisorKey(identity));
  }

  async rebindRelease(
    expected: ManagedBridgeIdentity,
    next: ManagedBridgeIdentity,
  ): Promise<ManagedBridgeSupervisorJournal> {
    return this.#transitionStoppedRelease(expected, next, "REBIND");
  }

  async rollbackRelease(
    expected: ManagedBridgeIdentity,
    previous: ManagedBridgeIdentity,
  ): Promise<ManagedBridgeSupervisorJournal> {
    return this.#transitionStoppedRelease(expected, previous, "ROLLBACK");
  }

  async reconcile(identity: ManagedBridgeIdentity): Promise<ManagedBridgeSupervisorJournal> {
    validateIdentity(identity);
    const key = managedBridgeSupervisorKey(identity);
    let current = await this.#store.load(key);
    if (!current) current = await this.ensureRunning(identity);
    if (!sameManagedBridgeRun(current.identity, identity)) {
      return this.#blockCurrent(key, current, "IDENTITY_MISMATCH");
    }
    if (current.desiredState === "STOPPED" || current.circuit === "BLOCKED") return current;
    if (current.circuit === "HALF_OPEN") return this.#reconcileHalfOpen(key, current);

    const rawObservation = await this.#probe.inspect(structuredClone(current.identity));
    let observation: ManagedBridgeProbeObservation;
    try {
      observation = validateProbeObservation(rawObservation);
    } catch (error) {
      return this.#blockCurrent(
        key,
        current,
        `INVALID_PROBE_OBSERVATION:${boundedReason(errorMessage(error))}`,
      );
    }
    if (!sameManagedBridgeRun(observation.identity, current.identity)) {
      return this.#blockCurrent(key, current, "OBSERVATION_BINDING_MISMATCH");
    }
    if (!recoveryProofProgresses(current.identity, observation.identity)) {
      return this.#blockCurrent(key, current, "RECOVERY_PROOF_REGRESSION");
    }
    if (observation.kind === "BLOCKED") {
      return this.#blockCurrent(
        key,
        current,
        `WORKER_BLOCKED:${boundedReason(observation.reason)}`,
      );
    }
    if (
      observation.kind === "UNKNOWN" ||
      observation.kind === "STARTING" ||
      observation.kind === "RECOVERING"
    ) {
      if (!sameIdentity(current.identity, observation.identity)) {
        await this.#activeSubjects.advanceRunning(
          structuredClone(current.identity),
          structuredClone(observation.identity),
        );
      }
      const observed =
        current.fuseGeneration ??
        Math.max(current.lastObservedFuseGeneration ?? 0, observation.fuseGeneration);
      if (
        sameIdentity(current.identity, observation.identity) &&
        current.lastObservedFuseGeneration === observed
      ) {
        return current;
      }
      return this.#replace(key, current, {
        identity: structuredClone(observation.identity),
        lastObservedFuseGeneration: observed,
      });
    }
    if (observation.kind === "HEALTHY") {
      if (
        current.lastObservedFuseGeneration !== null &&
        observation.fuseGeneration < current.lastObservedFuseGeneration
      ) {
        return this.#blockCurrent(key, current, "FUSE_GENERATION_REGRESSION");
      }
      if (
        current.circuit === "CLOSED" &&
        current.failureCount === 0 &&
        current.activeCommand === null &&
        sameIdentity(current.identity, observation.identity) &&
        current.lastObservedFuseGeneration === observation.fuseGeneration
      ) {
        return current;
      }
      if (!sameIdentity(current.identity, observation.identity)) {
        await this.#activeSubjects.advanceRunning(
          structuredClone(current.identity),
          structuredClone(observation.identity),
        );
      }
      return this.#replace(key, current, {
        identity: structuredClone(observation.identity),
        circuit: "CLOSED",
        failureCount: 0,
        fuseGeneration: null,
        lastObservedFuseGeneration: observation.fuseGeneration,
        activeCommand: null,
        nextAttemptAt: null,
        blockedReason: null,
        lastHealthyAt: iso(this.#now()),
      });
    }

    assertPositiveInteger(observation.fuseGeneration, "fuseGeneration");
    if (
      current.lastObservedFuseGeneration !== null &&
      observation.fuseGeneration < current.lastObservedFuseGeneration
    ) {
      return this.#blockCurrent(key, current, "FUSE_GENERATION_REGRESSION");
    }
    if (
      current.circuit === "CLOSED" &&
      current.lastObservedFuseGeneration === observation.fuseGeneration
    ) {
      if (sameIdentity(current.identity, observation.identity)) return current;
      await this.#activeSubjects.advanceRunning(
        structuredClone(current.identity),
        structuredClone(observation.identity),
      );
      return this.#replace(key, current, { identity: structuredClone(observation.identity) });
    }
    if (
      current.circuit === "CLOSED" &&
      current.lastObservedFuseGeneration !== null &&
      observation.fuseGeneration !== current.lastObservedFuseGeneration + 1
    ) {
      return this.#blockCurrent(key, current, "FUSE_GENERATION_GAP");
    }
    if (current.circuit === "OPEN" && current.fuseGeneration !== observation.fuseGeneration) {
      return this.#blockCurrent(key, current, "FUSE_GENERATION_CHANGED_WHILE_OPEN");
    }
    if (current.circuit === "CLOSED") {
      const failureCount = 1;
      const backoff = managedBridgeBackoff(
        observation.identity,
        observation.fuseGeneration,
        failureCount,
      );
      return this.#replace(key, current, {
        identity: structuredClone(observation.identity),
        circuit: "OPEN",
        failureCount,
        fuseGeneration: observation.fuseGeneration,
        lastObservedFuseGeneration: observation.fuseGeneration,
        activeCommand: null,
        nextAttemptAt: iso(this.#now() + backoff.delayMs),
        blockedReason: null,
      });
    }
    if (!sameIdentity(current.identity, observation.identity)) {
      await this.#activeSubjects.advanceRunning(
        structuredClone(current.identity),
        structuredClone(observation.identity),
      );
      return this.#replace(key, current, {
        identity: structuredClone(observation.identity),
      });
    }
    if (!due(current.nextAttemptAt, this.#now())) return current;

    const command = commandFor(current);
    const claimed = await this.#replace(key, current, {
      circuit: "HALF_OPEN",
      commandGeneration: command.commandGeneration,
      activeCommand: {
        commandId: command.commandId,
        commandGeneration: command.commandGeneration,
        fuseGeneration: command.fuseGeneration,
        identity: command.identity,
        claimedBy: this.#instanceId,
        claimLeaseUntil: iso(this.#now() + this.#commandLeaseMs),
        dispatchCount: 1,
        createdAt: iso(this.#now()),
      },
      nextAttemptAt: null,
    });
    if (
      claimed.circuit !== "HALF_OPEN" ||
      claimed.activeCommand?.commandId !== command.commandId ||
      claimed.activeCommand.claimedBy !== this.#instanceId
    ) {
      return claimed;
    }
    return this.#dispatch(key, claimed);
  }

  async #reconcileHalfOpen(
    key: string,
    current: ManagedBridgeSupervisorJournal,
  ): Promise<ManagedBridgeSupervisorJournal> {
    const command = current.activeCommand;
    if (!command) return this.#blockCurrent(key, current, "HALF_OPEN_WITHOUT_COMMAND");
    const inFlight = this.#inFlight.get(command.commandId);
    if (inFlight) return inFlight;
    const now = this.#now();
    const leaseLive = command.claimLeaseUntil !== null && Date.parse(command.claimLeaseUntil) > now;
    if (leaseLive) return current;
    if (command.claimedBy === null && !due(current.nextAttemptAt, now)) return current;

    let observation: ManagedBridgeProbeObservation;
    try {
      observation = validateProbeObservation(
        await this.#probe.inspect(structuredClone(current.identity)),
      );
    } catch (error) {
      return this.#blockCurrent(
        key,
        current,
        `INVALID_PROBE_OBSERVATION:${boundedReason(errorMessage(error))}`,
      );
    }
    if (!sameManagedBridgeRun(observation.identity, current.identity)) {
      return this.#blockCurrent(key, current, "OBSERVATION_BINDING_MISMATCH");
    }
    if (!recoveryProofProgresses(current.identity, observation.identity)) {
      return this.#blockCurrent(key, current, "RECOVERY_PROOF_REGRESSION");
    }
    if (observation.kind === "BLOCKED") {
      return this.#blockCurrent(
        key,
        current,
        `WORKER_BLOCKED:${boundedReason(observation.reason)}`,
      );
    }
    if (observation.kind === "HEALTHY") {
      if (
        current.lastObservedFuseGeneration !== null &&
        observation.fuseGeneration < current.lastObservedFuseGeneration
      ) {
        return this.#blockCurrent(key, current, "FUSE_GENERATION_REGRESSION");
      }
      if (!sameIdentity(current.identity, observation.identity)) {
        await this.#activeSubjects.advanceRunning(
          structuredClone(current.identity),
          structuredClone(observation.identity),
        );
      }
      return this.#replace(key, current, {
        identity: structuredClone(observation.identity),
        circuit: "CLOSED",
        failureCount: 0,
        fuseGeneration: null,
        lastObservedFuseGeneration: observation.fuseGeneration,
        activeCommand: null,
        nextAttemptAt: null,
        blockedReason: null,
        lastHealthyAt: iso(now),
      });
    }
    if (
      observation.kind === "UNKNOWN" ||
      observation.kind === "STARTING" ||
      observation.kind === "RECOVERING"
    ) {
      const backoff = managedBridgeBackoff(
        current.identity,
        command.fuseGeneration,
        Math.max(1, current.failureCount),
      );
      const identityChanged = !sameIdentity(current.identity, observation.identity);
      if (identityChanged) {
        await this.#activeSubjects.advanceRunning(
          structuredClone(current.identity),
          structuredClone(observation.identity),
        );
        return this.#replace(key, current, {
          identity: structuredClone(observation.identity),
          circuit: "OPEN",
          activeCommand: null,
          nextAttemptAt: iso(now + backoff.delayMs),
          lastObservedFuseGeneration:
            current.fuseGeneration ??
            Math.max(current.lastObservedFuseGeneration ?? 0, observation.fuseGeneration),
        });
      }
      return this.#replace(key, current, {
        activeCommand: {
          ...command,
          claimedBy: null,
          claimLeaseUntil: null,
        },
        nextAttemptAt: iso(now + backoff.delayMs),
        lastObservedFuseGeneration:
          current.fuseGeneration ??
          Math.max(current.lastObservedFuseGeneration ?? 0, observation.fuseGeneration),
      });
    }
    if (
      observation.fuseGeneration !== current.fuseGeneration ||
      observation.fuseGeneration !== command.fuseGeneration
    ) {
      return this.#blockCurrent(key, current, "FUSE_GENERATION_CHANGED_WHILE_HALF_OPEN");
    }
    if (!sameIdentity(current.identity, observation.identity)) {
      await this.#activeSubjects.advanceRunning(
        structuredClone(current.identity),
        structuredClone(observation.identity),
      );
      const reopened = await this.#replace(key, current, {
        identity: structuredClone(observation.identity),
        circuit: "OPEN",
        activeCommand: null,
        nextAttemptAt: iso(now),
        lastObservedFuseGeneration: observation.fuseGeneration,
      });
      if (reopened.circuit !== "OPEN" || !sameIdentity(reopened.identity, observation.identity)) {
        return reopened;
      }
      return this.reconcile(observation.identity);
    }
    const claimed = await this.#replace(key, current, {
      activeCommand: {
        ...command,
        claimedBy: this.#instanceId,
        claimLeaseUntil: iso(now + this.#commandLeaseMs),
        dispatchCount: command.dispatchCount + 1,
      },
      nextAttemptAt: null,
    });
    if (
      claimed.circuit !== "HALF_OPEN" ||
      claimed.activeCommand?.commandId !== command.commandId ||
      claimed.activeCommand.claimedBy !== this.#instanceId
    ) {
      return claimed;
    }
    return this.#dispatch(key, claimed);
  }

  #dispatch(
    key: string,
    claimed: ManagedBridgeSupervisorJournal,
  ): Promise<ManagedBridgeSupervisorJournal> {
    const active = claimed.activeCommand;
    if (!active) return Promise.resolve(claimed);
    const existing = this.#inFlight.get(active.commandId);
    if (existing) return existing;
    const command: ManagedBridgeRecoveryCommand = {
      kind: "PROBE_APP_SERVER",
      commandId: active.commandId,
      commandGeneration: active.commandGeneration,
      fuseGeneration: active.fuseGeneration,
      identity: structuredClone(active.identity),
    };
    const operation = (async () => {
      try {
        let rawResult: ManagedBridgeProbeResult;
        try {
          rawResult = await this.#probe.issue(command);
        } catch (error) {
          return this.#recordLostResponse(key, command, error);
        }
        let result: ManagedBridgeProbeResult;
        try {
          result = validateProbeResult(rawResult);
        } catch (error) {
          return this.#blockOwnedCommand(
            key,
            command,
            `INVALID_COMMAND_RESULT:${boundedReason(errorMessage(error))}`,
          );
        }
        return this.#recordCommandResult(key, command, result);
      } finally {
        this.#inFlight.delete(active.commandId);
      }
    })();
    this.#inFlight.set(active.commandId, operation);
    return operation;
  }

  async #recordLostResponse(
    key: string,
    command: ManagedBridgeRecoveryCommand,
    _error: unknown,
  ): Promise<ManagedBridgeSupervisorJournal> {
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
      const current = await this.#store.load(key);
      if (!current) throw new Error("Supervisor journal disappeared after command dispatch");
      if (!this.#ownsCommand(current, command)) return current;
      const backoff = managedBridgeBackoff(
        current.identity,
        command.fuseGeneration,
        Math.max(1, current.failureCount),
      );
      const next: ManagedBridgeSupervisorJournal = {
        ...current,
        revision: current.revision + 1,
        activeCommand: {
          ...current.activeCommand!,
          claimedBy: null,
          claimLeaseUntil: null,
        },
        nextAttemptAt: iso(this.#now() + backoff.delayMs),
        blockedReason: null,
        updatedAt: iso(this.#now()),
      };
      if (await this.#store.compareAndSwap(key, current.revision, next)) return next;
    }
    throw new Error("Managed Bridge supervisor CAS contention after ambiguous command transport");
  }

  async #blockOwnedCommand(
    key: string,
    command: ManagedBridgeRecoveryCommand,
    reason: string,
  ): Promise<ManagedBridgeSupervisorJournal> {
    const current = await this.#store.load(key);
    if (!current) throw new Error("Supervisor journal disappeared after invalid command result");
    if (!this.#ownsCommand(current, command)) return current;
    return this.#blockCurrent(key, current, reason);
  }

  async #recordCommandResult(
    key: string,
    command: ManagedBridgeRecoveryCommand,
    result: ManagedBridgeProbeResult,
  ): Promise<ManagedBridgeSupervisorJournal> {
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
      const current = await this.#store.load(key);
      if (!current) throw new Error("Supervisor journal disappeared after command result");
      if (!this.#ownsCommand(current, command)) return current;
      if (!resultMatchesCommand(result, command)) {
        return this.#blockCurrent(key, current, "COMMAND_RESULT_BINDING_MISMATCH");
      }
      if (result.kind === "BLOCKED") {
        return this.#blockCurrent(key, current, `WORKER_BLOCKED:${boundedReason(result.reason)}`);
      }
      if (result.kind === "RECOVERED") {
        return this.#replace(key, current, {
          circuit: "CLOSED",
          failureCount: 0,
          fuseGeneration: null,
          lastObservedFuseGeneration: result.fuseGeneration,
          activeCommand: null,
          nextAttemptAt: null,
          blockedReason: null,
          lastHealthyAt: iso(this.#now()),
        });
      }
      const failureCount = current.failureCount + 1;
      const backoff = managedBridgeBackoff(current.identity, result.fuseGeneration, failureCount);
      return this.#replace(key, current, {
        circuit: "OPEN",
        failureCount,
        fuseGeneration: result.fuseGeneration,
        lastObservedFuseGeneration: result.fuseGeneration,
        activeCommand: null,
        nextAttemptAt: iso(this.#now() + backoff.delayMs),
        blockedReason: null,
      });
    }
    throw new Error("Managed Bridge supervisor CAS contention while recording command result");
  }

  #ownsCommand(
    current: ManagedBridgeSupervisorJournal,
    command: ManagedBridgeRecoveryCommand,
  ): boolean {
    return (
      current.circuit === "HALF_OPEN" &&
      current.activeCommand?.commandId === command.commandId &&
      current.activeCommand.commandGeneration === command.commandGeneration &&
      current.activeCommand.fuseGeneration === command.fuseGeneration &&
      current.activeCommand.claimedBy === this.#instanceId &&
      sameIdentity(current.activeCommand.identity, command.identity)
    );
  }

  async #transitionStoppedRelease(
    expected: ManagedBridgeIdentity,
    nextIdentity: ManagedBridgeIdentity,
    kind: "REBIND" | "ROLLBACK",
  ): Promise<ManagedBridgeSupervisorJournal> {
    validateIdentity(expected);
    validateIdentity(nextIdentity);
    if (!sameSubjectOutsideRelease(expected, nextIdentity)) {
      throw new Error(`Managed Bridge release ${kind} must preserve the exact run and recovery`);
    }
    if (
      sameBuildIdentity(expected.build, nextIdentity.build) &&
      expected.entry === nextIdentity.entry
    ) {
      throw new Error(`Managed Bridge release ${kind} must change the verified release identity`);
    }
    const key = managedBridgeSupervisorKey(expected);
    if (managedBridgeSupervisorKey(nextIdentity) !== key) {
      throw new Error(`Managed Bridge release ${kind} changed the supervisor key`);
    }
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
      const current = await this.#store.load(key);
      if (!current) throw new Error(`Managed Bridge release ${kind} journal is absent`);
      if (sameIdentity(current.identity, nextIdentity)) {
        if (current.desiredState !== "STOPPED") {
          throw new Error(`Managed Bridge release ${kind} requires desired STOPPED`);
        }
        return current;
      }
      if (!sameIdentity(current.identity, expected)) {
        throw new Error(`Managed Bridge release ${kind} expected identity mismatch`);
      }
      if (current.desiredState !== "STOPPED") {
        throw new Error(`Managed Bridge release ${kind} requires desired STOPPED`);
      }
      const transitioned = await this.#replace(key, current, {
        identity: structuredClone(nextIdentity),
        circuit: "CLOSED",
        failureCount: 0,
        fuseGeneration: null,
        activeCommand: null,
        nextAttemptAt: null,
        blockedReason: null,
      });
      if (sameIdentity(transitioned.identity, nextIdentity)) return transitioned;
    }
    throw new Error(`Managed Bridge release ${kind} CAS contention`);
  }

  async #replace(
    key: string,
    current: ManagedBridgeSupervisorJournal,
    changes: Partial<ManagedBridgeSupervisorJournal>,
  ): Promise<ManagedBridgeSupervisorJournal> {
    const next: ManagedBridgeSupervisorJournal = {
      ...current,
      ...changes,
      schemaVersion: 2,
      key,
      revision: current.revision + 1,
      updatedAt: iso(this.#now()),
    };
    validateJournal(next, key);
    if (await this.#store.compareAndSwap(key, current.revision, next)) return next;
    const latest = await this.#store.load(key);
    if (!latest) throw new Error("Supervisor journal disappeared during CAS");
    return latest;
  }

  async #blockCurrent(
    key: string,
    current: ManagedBridgeSupervisorJournal,
    reason: string,
  ): Promise<ManagedBridgeSupervisorJournal> {
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
      if (current.circuit === "BLOCKED") return current;
      const next = await this.#replace(key, current, {
        circuit: "BLOCKED",
        activeCommand: null,
        nextAttemptAt: null,
        blockedReason: boundedReason(reason),
      });
      if (next.circuit === "BLOCKED") return next;
      current = next;
    }
    throw new Error("Managed Bridge supervisor CAS contention while blocking");
  }
}

function resultMatchesCommand(
  result: ManagedBridgeProbeResult,
  command: ManagedBridgeRecoveryCommand,
): boolean {
  return (
    result.commandId === command.commandId &&
    result.commandGeneration === command.commandGeneration &&
    result.fuseGeneration === command.fuseGeneration &&
    sameIdentity(result.identity, command.identity)
  );
}

function validateProbeObservation(value: unknown): ManagedBridgeProbeObservation {
  const record = value as Record<string, unknown>;
  if (record?.kind === "HEALTHY") {
    strictRecord(value, ["kind", "identity", "fuseGeneration"]);
    validateIdentity(record.identity);
    assertNonNegativeInteger(record.fuseGeneration, "observation.fuseGeneration");
    return value as ManagedBridgeProbeObservation;
  }
  if (record?.kind === "FUSE_OPEN") {
    strictRecord(value, ["kind", "identity", "fuseGeneration"]);
    validateIdentity(record.identity);
    assertPositiveInteger(record.fuseGeneration, "observation.fuseGeneration");
    return value as ManagedBridgeProbeObservation;
  }
  if (record?.kind === "UNKNOWN" || record?.kind === "STARTING" || record?.kind === "RECOVERING") {
    strictRecord(value, ["kind", "identity", "fuseGeneration"]);
    validateIdentity(record.identity);
    assertNonNegativeInteger(record.fuseGeneration, "observation.fuseGeneration");
    return value as ManagedBridgeProbeObservation;
  }
  if (record?.kind === "BLOCKED") {
    strictRecord(value, ["kind", "identity", "fuseGeneration", "reason"]);
    validateIdentity(record.identity);
    if (record.fuseGeneration !== null) {
      assertPositiveInteger(record.fuseGeneration, "observation.fuseGeneration");
    }
    assertBoundedString(record.reason, "observation.reason", 500);
    return value as ManagedBridgeProbeObservation;
  }
  throw new Error("Invalid managed Bridge probe observation");
}

function validateProbeResult(value: unknown): ManagedBridgeProbeResult {
  const record = value as Record<string, unknown>;
  if (record?.kind === "RECOVERED") {
    strictRecord(value, [
      "kind",
      "commandId",
      "commandGeneration",
      "fuseGeneration",
      "identity",
      "stability",
    ]);
    if (record.stability !== "STABLE") throw new Error("Recovery result is not stable");
  } else if (record?.kind === "STILL_OPEN" || record?.kind === "BLOCKED") {
    strictRecord(value, [
      "kind",
      "commandId",
      "commandGeneration",
      "fuseGeneration",
      "identity",
      "reason",
    ]);
    assertBoundedString(record.reason, "result.reason", 500);
  } else {
    throw new Error("Invalid managed Bridge probe result");
  }
  assertSha256(record.commandId, "result.commandId");
  assertPositiveInteger(record.commandGeneration, "result.commandGeneration");
  assertPositiveInteger(record.fuseGeneration, "result.fuseGeneration");
  validateIdentity(record.identity);
  return value as ManagedBridgeProbeResult;
}

function boundedReason(reason: string): string {
  const normalized = reason.replace(/[\r\n\0]/g, " ").trim();
  return (normalized || "unspecified").slice(0, 500);
}

type FileAdapters = {
  rename?: typeof renameSync;
};

export type ManagedBridgeSupervisorLease = Pick<ManagedBridgeIpcLease, "assertActive">;

export class FileManagedBridgeSupervisorJournal implements ManagedBridgeSupervisorStore {
  readonly #directory: string;
  readonly #lease: ManagedBridgeSupervisorLease;
  readonly #fileAdapters: FileAdapters;

  constructor(options: {
    rootDir: string;
    lease: ManagedBridgeSupervisorLease;
    fileAdapters?: FileAdapters;
  }) {
    if (!isAbsolute(options.rootDir))
      throw new Error("Supervisor journal rootDir must be absolute");
    this.#directory = resolve(options.rootDir, "managed-bridge-supervisor");
    this.#lease = options.lease;
    this.#fileAdapters = options.fileAdapters ?? {};
  }

  pathFor(key: string): string {
    assertSha256(key, "supervisor key");
    return resolve(this.#directory, `${key}.json`);
  }

  async load(key: string): Promise<ManagedBridgeSupervisorJournal | null> {
    this.#lease.assertActive();
    const path = this.pathFor(key);
    if (!existsSync(path)) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      throw new Error(`Invalid managed Bridge supervisor journal: ${errorMessage(error)}`);
    }
    return validateJournal(parsed, key);
  }

  async compareAndSwap(
    key: string,
    expectedRevision: number | null,
    next: ManagedBridgeSupervisorJournal,
  ): Promise<boolean> {
    this.#lease.assertActive();
    const current = await this.load(key);
    if ((current?.revision ?? null) !== expectedRevision) return false;
    const requiredRevision = expectedRevision === null ? 0 : expectedRevision + 1;
    if (next.revision !== requiredRevision) {
      throw new Error(`Supervisor CAS revision must advance to ${requiredRevision}`);
    }
    validateJournal(next, key);
    mkdirSync(this.#directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    chmodSync(this.#directory, PRIVATE_DIRECTORY_MODE);
    const path = this.pathFor(key);
    const temporaryPath = resolve(
      this.#directory,
      `.${key}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
    );
    let fd: number | null = null;
    try {
      fd = openSync(
        temporaryPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        PRIVATE_FILE_MODE,
      );
      writeFileSync(fd, `${JSON.stringify(next)}\n`, "utf8");
      fsyncSync(fd);
      closeSync(fd);
      fd = null;
      chmodSync(temporaryPath, PRIVATE_FILE_MODE);
      (this.#fileAdapters.rename ?? renameSync)(temporaryPath, path);
      fsyncDirectoryBestEffort(dirname(path));
    } finally {
      if (fd !== null) closeSync(fd);
    }
    return true;
  }
}

function fsyncDirectoryBestEffort(path: string): void {
  let fd: number | null = null;
  try {
    fd = openSync(path, constants.O_RDONLY);
    fsyncSync(fd);
  } catch {
    // Windows rejects directory fsync. The journal file itself was fsynced before atomic rename.
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function validateIdentity(value: unknown): asserts value is ManagedBridgeIdentity {
  const identity = strictRecord(value, [
    "projectId",
    "agentId",
    "runId",
    "originalThreadId",
    "projectRoot",
    "entry",
    "build",
    "recovery",
  ]);
  assertIdentifier(identity.projectId, "projectId");
  if (identity.agentId !== "codex") throw new Error("Managed Bridge agentId must be codex");
  assertIdentifier(identity.runId, "runId");
  assertIdentifier(identity.originalThreadId, "originalThreadId");
  assertAbsolutePath(identity.projectRoot, "projectRoot");
  assertAbsolutePath(identity.entry, "entry");
  const build = strictRecord(identity.build, [
    "buildId",
    "buildSessionId",
    "protocolId",
    "manifestSha256",
    "migrationId",
  ]);
  assertSha256(build.buildId, "build.buildId");
  assertUuid(build.buildSessionId, "build.buildSessionId");
  assertSha256(build.protocolId, "build.protocolId");
  assertSha256(build.manifestSha256, "build.manifestSha256");
  assertSha256(build.migrationId, "build.migrationId");
  const recovery = strictRecord(identity.recovery, [
    "sessionId",
    "lineageId",
    "incarnation",
    "bundleId",
    "vaultPath",
    "vaultSha256",
    "checkpointPath",
    "checkpointSha256",
    "checkpointEventSequence",
  ]);
  assertIdentifier(recovery.sessionId, "recovery.sessionId");
  assertIdentifier(recovery.lineageId, "recovery.lineageId");
  assertPositiveInteger(recovery.incarnation, "recovery.incarnation");
  assertIdentifier(recovery.bundleId, "recovery.bundleId");
  assertAbsolutePath(recovery.vaultPath, "recovery.vaultPath");
  assertSha256(recovery.vaultSha256, "recovery.vaultSha256");
  assertAbsolutePath(recovery.checkpointPath, "recovery.checkpointPath");
  assertSha256(recovery.checkpointSha256, "recovery.checkpointSha256");
  assertNonNegativeInteger(recovery.checkpointEventSequence, "recovery.checkpointEventSequence");
}

function validateJournal(value: unknown, expectedKey: string): ManagedBridgeSupervisorJournal {
  const journal = strictRecord(value, [
    "schemaVersion",
    "key",
    "revision",
    "identity",
    "desiredState",
    "circuit",
    "failureCount",
    "commandGeneration",
    "fuseGeneration",
    "lastObservedFuseGeneration",
    "activeCommand",
    "nextAttemptAt",
    "blockedReason",
    "lastHealthyAt",
    "updatedAt",
  ]);
  if (journal.schemaVersion !== 2) throw new Error("Unsupported supervisor journal schema");
  if (journal.key !== expectedKey) throw new Error("Supervisor journal key mismatch");
  assertNonNegativeInteger(journal.revision, "revision");
  validateIdentity(journal.identity);
  if (managedBridgeSupervisorKey(journal.identity) !== expectedKey) {
    throw new Error("Supervisor journal identity does not match its key");
  }
  if (journal.desiredState !== "RUNNING" && journal.desiredState !== "STOPPED") {
    throw new Error("Invalid supervisor desiredState");
  }
  if (!["CLOSED", "OPEN", "HALF_OPEN", "BLOCKED"].includes(String(journal.circuit))) {
    throw new Error("Invalid supervisor circuit");
  }
  assertNonNegativeInteger(journal.failureCount, "failureCount");
  assertNonNegativeInteger(journal.commandGeneration, "commandGeneration");
  if (journal.fuseGeneration !== null) {
    assertPositiveInteger(journal.fuseGeneration, "fuseGeneration");
  }
  if (journal.lastObservedFuseGeneration !== null) {
    assertNonNegativeInteger(journal.lastObservedFuseGeneration, "lastObservedFuseGeneration");
  }
  if (
    journal.fuseGeneration !== null &&
    journal.lastObservedFuseGeneration !== journal.fuseGeneration
  ) {
    throw new Error("Active fuse generation must equal the last observed generation");
  }
  let activeCommandRecord: Record<string, unknown> | null = null;
  if (journal.activeCommand !== null) {
    const command = strictRecord(journal.activeCommand, [
      "commandId",
      "commandGeneration",
      "fuseGeneration",
      "identity",
      "claimedBy",
      "claimLeaseUntil",
      "dispatchCount",
      "createdAt",
    ]);
    activeCommandRecord = command;
    assertSha256(command.commandId, "activeCommand.commandId");
    assertPositiveInteger(command.commandGeneration, "activeCommand.commandGeneration");
    assertPositiveInteger(command.fuseGeneration, "activeCommand.fuseGeneration");
    validateIdentity(command.identity);
    if (!sameIdentity(command.identity, journal.identity)) {
      throw new Error("Supervisor active command identity mismatch");
    }
    if (
      command.commandGeneration !== journal.commandGeneration ||
      command.fuseGeneration !== journal.fuseGeneration
    ) {
      throw new Error("Supervisor active command generation mismatch");
    }
    if (command.claimedBy !== null) assertIdentifier(command.claimedBy, "claimedBy");
    assertNullableDate(command.claimLeaseUntil, "claimLeaseUntil");
    assertPositiveInteger(command.dispatchCount, "dispatchCount");
    assertDate(command.createdAt, "createdAt");
  }
  assertNullableDate(journal.nextAttemptAt, "nextAttemptAt");
  if (journal.blockedReason !== null)
    assertBoundedString(journal.blockedReason, "blockedReason", 500);
  assertNullableDate(journal.lastHealthyAt, "lastHealthyAt");
  assertDate(journal.updatedAt, "updatedAt");
  if (journal.circuit === "HALF_OPEN" && journal.activeCommand === null) {
    throw new Error("HALF_OPEN supervisor journal requires an active command");
  }
  if (journal.circuit !== "HALF_OPEN" && journal.activeCommand !== null) {
    throw new Error("Only HALF_OPEN supervisor journal may retain an active command");
  }
  if (journal.desiredState === "STOPPED") {
    if (journal.activeCommand !== null || journal.nextAttemptAt !== null) {
      throw new Error("STOPPED supervisor journal cannot retain runnable work");
    }
  } else if (journal.circuit === "CLOSED") {
    if (
      journal.failureCount !== 0 ||
      journal.fuseGeneration !== null ||
      journal.nextAttemptAt !== null ||
      journal.blockedReason !== null
    ) {
      throw new Error("Invalid CLOSED supervisor journal");
    }
  } else if (journal.circuit === "OPEN") {
    if (
      journal.failureCount < 1 ||
      journal.fuseGeneration === null ||
      journal.nextAttemptAt === null ||
      journal.blockedReason !== null
    ) {
      throw new Error("Invalid OPEN supervisor journal");
    }
  } else if (journal.circuit === "HALF_OPEN") {
    const command = activeCommandRecord!;
    const isClaimed = command.claimedBy !== null;
    if (
      journal.failureCount < 1 ||
      journal.fuseGeneration === null ||
      journal.blockedReason !== null ||
      (isClaimed && (command.claimLeaseUntil === null || journal.nextAttemptAt !== null)) ||
      (!isClaimed && (command.claimLeaseUntil !== null || journal.nextAttemptAt === null))
    ) {
      throw new Error("Invalid HALF_OPEN supervisor journal");
    }
  } else if (
    journal.circuit === "BLOCKED" &&
    (journal.blockedReason === null ||
      journal.activeCommand !== null ||
      journal.nextAttemptAt !== null)
  ) {
    throw new Error("Invalid BLOCKED supervisor journal");
  }
  return journal as unknown as ManagedBridgeSupervisorJournal;
}

function strictRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected a supervisor record");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(keys);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw new Error(`Unexpected supervisor field: ${key}`);
  }
  for (const key of keys) {
    if (!(key in record)) throw new Error(`Missing supervisor field: ${key}`);
  }
  return record;
}

function assertIdentifier(value: unknown, name: string): asserts value is string {
  assertBoundedString(value, name, 512);
  if (/\s/.test(value)) throw new Error(`${name} cannot contain whitespace`);
}

function assertAbsolutePath(value: unknown, name: string): asserts value is string {
  assertBoundedString(value, name, 4_096);
  if (!isAbsolute(value)) throw new Error(`${name} must be absolute`);
  if (value.includes("\0")) throw new Error(`${name} cannot contain NUL`);
}

function assertBoundedString(value: unknown, name: string, max: number): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new Error(`${name} must be a non-empty string of at most ${max} characters`);
  }
}

function assertSha256(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${name} must be a lowercase SHA-256 digest`);
  }
}

function assertUuid(value: unknown, name: string): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  ) {
    throw new Error(`${name} must be a UUID`);
  }
}

function assertPositiveInteger(value: unknown, name: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
}

function assertNonNegativeInteger(value: unknown, name: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
}

function assertDate(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${name} must be an ISO date`);
  }
}

function assertNullableDate(value: unknown, name: string): asserts value is string | null {
  if (value !== null) assertDate(value, name);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
