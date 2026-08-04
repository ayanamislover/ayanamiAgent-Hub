export type CredentialAdmissionKind =
  "DIRECT_USER_INPUT" | "MESSAGE_SURFACE" | "QUEUE_DRAIN" | "HEARTBEAT";

export class CredentialAdmissionClosedError extends Error {
  readonly code = "CREDENTIAL_ADMISSION_CLOSED";

  constructor(message = "Codex credential admission is permanently closed") {
    super(message);
    this.name = "CredentialAdmissionClosedError";
  }
}

export class CredentialDrainConflictError extends Error {
  readonly code = "CREDENTIAL_DRAIN_CONFLICT";

  constructor(activeReason: string, requestedReason: string) {
    super(
      `Credential drain is owned by ${activeReason}; ${requestedReason} cannot share its barrier`,
    );
    this.name = "CredentialDrainConflictError";
  }
}

export type CredentialAdmission = {
  readonly epoch: number;
  readonly kind: CredentialAdmissionKind;
  release(): void;
};

export type CredentialDrainBarrier = {
  readonly epoch: number;
  readonly reason: string;
  readonly drained: Promise<void>;
};

type PendingAdmission = {
  resolve: () => void;
  reject: (error: Error) => void;
};

/**
 * Linearization barrier between model-visible work and credential ownership changes.
 *
 * `beginDrain` closes admission synchronously. Work that already owns an admission keeps the old
 * credential epoch until it releases; later callers wait without joining the epoch being drained.
 * The caller may then switch CONTROL/MODEL credentials and `reopen` exactly that barrier. A
 * terminal shutdown uses `close`, which rejects deferred callers and can never reopen.
 */
export class CredentialCutoverDrain {
  private state: "OPEN" | "DRAINING" | "CLOSED" = "OPEN";
  private epoch = 1;
  private nextAdmissionId = 1;
  private readonly active = new Map<number, Map<number, CredentialAdmissionKind>>();
  private readonly pendingAdmissions = new Set<PendingAdmission>();
  private barrier: CredentialDrainBarrier | null = null;
  private resolveDrain: (() => void) | null = null;
  private closedReason = "Codex credential admission is permanently closed";

  get phase(): "OPEN" | "DRAINING" | "CLOSED" {
    return this.state;
  }

  get activeAdmissionCount(): number {
    let count = 0;
    for (const admissions of this.active.values()) count += admissions.size;
    return count;
  }

  get hasActiveNonHeartbeatAdmission(): boolean {
    for (const admissions of this.active.values()) {
      for (const kind of admissions.values()) {
        if (kind !== "HEARTBEAT") return true;
      }
    }
    return false;
  }

  async admit(kind: CredentialAdmissionKind): Promise<CredentialAdmission> {
    while (this.state === "DRAINING") {
      await new Promise<void>((resolve, reject) => {
        const pending: PendingAdmission = {
          resolve: () => {
            this.pendingAdmissions.delete(pending);
            resolve();
          },
          reject: (error) => {
            this.pendingAdmissions.delete(pending);
            reject(error);
          },
        };
        this.pendingAdmissions.add(pending);
      });
    }
    if (this.state === "CLOSED") {
      throw new CredentialAdmissionClosedError(this.closedReason);
    }
    const admittedEpoch = this.epoch;
    const admissionId = this.nextAdmissionId++;
    const epochAdmissions = this.active.get(admittedEpoch) ?? new Map();
    epochAdmissions.set(admissionId, kind);
    this.active.set(admittedEpoch, epochAdmissions);
    let released = false;
    return {
      epoch: admittedEpoch,
      kind,
      release: () => {
        if (released) return;
        released = true;
        const owned = this.active.get(admittedEpoch);
        owned?.delete(admissionId);
        if (owned?.size === 0) this.active.delete(admittedEpoch);
        this.resolveBarrierIfDrained();
      },
    };
  }

  beginDrain(reason: string): CredentialDrainBarrier {
    if (this.state === "CLOSED") {
      throw new CredentialAdmissionClosedError(this.closedReason);
    }
    if (this.barrier) {
      if (this.barrier.reason === reason) return this.barrier;
      throw new CredentialDrainConflictError(this.barrier.reason, reason);
    }
    this.state = "DRAINING";
    const drainedEpoch = this.epoch;
    this.epoch += 1;
    let resolveDrain!: () => void;
    const drained = new Promise<void>((resolve) => {
      resolveDrain = resolve;
    });
    this.resolveDrain = resolveDrain;
    this.barrier = { epoch: drainedEpoch, reason, drained };
    this.resolveBarrierIfDrained();
    return this.barrier;
  }

  reopen(barrier: CredentialDrainBarrier): void {
    this.assertCurrentBarrier(barrier);
    if (this.state !== "DRAINING") {
      throw new Error("Only a draining credential barrier may reopen admission");
    }
    if (this.active.get(barrier.epoch)?.size) {
      throw new Error("Cannot reopen credential admission before the old epoch drains");
    }
    this.barrier = null;
    this.resolveDrain = null;
    this.state = "OPEN";
    for (const pending of [...this.pendingAdmissions]) pending.resolve();
  }

  close(reason: string): CredentialDrainBarrier {
    if (this.state === "CLOSED") {
      if (!this.barrier) throw new Error("Closed credential drain lost its terminal barrier");
      return this.barrier;
    }
    const barrier = this.barrier ?? this.beginDrain(reason);
    this.state = "CLOSED";
    this.closedReason = reason;
    for (const pending of [...this.pendingAdmissions]) {
      pending.reject(new CredentialAdmissionClosedError(reason));
    }
    return barrier;
  }

  private assertCurrentBarrier(barrier: CredentialDrainBarrier): void {
    if (this.barrier !== barrier) {
      throw new Error("Credential drain barrier is stale or belongs to another owner");
    }
  }

  private resolveBarrierIfDrained(): void {
    if (!this.barrier || this.active.get(this.barrier.epoch)?.size) return;
    this.resolveDrain?.();
    this.resolveDrain = null;
  }
}
