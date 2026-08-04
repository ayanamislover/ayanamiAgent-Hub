export type AppServerRecoveryFuseState = "CLOSED" | "RECOVERING" | "FUSE_OPEN" | "HALF_OPEN";

export type AppServerModelTransportState =
  "MODEL_READY" | "MODEL_RECOVERING" | "MODEL_CONFIGURED_OFFLINE" | "MODEL_HALF_OPEN";

/** Non-secret binding carried across the process supervisor Seam. */
export type AppServerRecoveryIdentity = {
  projectId: string;
  hubSessionId: string;
  threadId: string;
  lineageId: string;
  incarnation: number;
  launcherRunId: string;
  bundleId: string;
};

export type AppServerRecoveryRequired = {
  schemaVersion: 1;
  kind: "CODEX_APP_SERVER_RECOVERY_REQUIRED";
  fuseGeneration: number;
  failedAttempts: number;
  crashedGeneration: number | null;
  issuedAt: string;
  identity: AppServerRecoveryIdentity;
};

export type AppServerRecoveryProbeCommand = {
  schemaVersion: 1;
  kind: "CODEX_APP_SERVER_RECOVERY_PROBE";
  commandId: string;
  commandGeneration: number;
  fuseGeneration: number;
  identity: AppServerRecoveryIdentity;
};

export type AppServerRecoveryProbeResult = {
  schemaVersion: 1;
  kind: "RECOVERED" | "FUSE_OPEN";
  commandId: string;
  commandGeneration: number;
  fuseGeneration: number;
  completedAt: string;
  identity: AppServerRecoveryIdentity;
};

export type AppServerRecoveryFuseStatus = {
  state: AppServerRecoveryFuseState;
  modelTransportState: AppServerModelTransportState;
  fuseGeneration: number;
  failedAttempts: number;
  crashedGeneration: number | null;
  identity: AppServerRecoveryIdentity | null;
  recoveryRequired: AppServerRecoveryRequired | null;
};

export type AppServerRecoveryFuseErrorCode =
  | "APP_SERVER_RECOVERY_FUSE_STATE_INVALID"
  | "APP_SERVER_RECOVERY_PROBE_STALE"
  | "APP_SERVER_RECOVERY_PROBE_IN_PROGRESS"
  | "APP_SERVER_RECOVERY_COMMAND_REPLAY_MISMATCH";

export class AppServerRecoveryFuseError extends Error {
  readonly name = "AppServerRecoveryFuseError";

  constructor(
    readonly code: AppServerRecoveryFuseErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export class ModelTransportFuseOpenError extends Error {
  readonly name = "ModelTransportFuseOpenError";
  readonly code = "MODEL_TRANSPORT_FUSE_OPEN" as const;

  constructor() {
    super("Codex model transport recovery fuse is open");
  }
}

type CompletedProbe = {
  fingerprint: string;
  result: AppServerRecoveryProbeResult;
};

type InFlightProbe = {
  fingerprint: string;
  promise: Promise<AppServerRecoveryProbeResult>;
};

export type AppServerRecoveryFuseOptions = {
  maxAutomaticAttempts?: number;
  now?: () => Date;
};

const identityKeys = [
  "projectId",
  "hubSessionId",
  "threadId",
  "lineageId",
  "incarnation",
  "launcherRunId",
  "bundleId",
] as const;

function copyIdentity(identity: AppServerRecoveryIdentity): AppServerRecoveryIdentity {
  return {
    projectId: identity.projectId,
    hubSessionId: identity.hubSessionId,
    threadId: identity.threadId,
    lineageId: identity.lineageId,
    incarnation: identity.incarnation,
    launcherRunId: identity.launcherRunId,
    bundleId: identity.bundleId,
  };
}

function assertIdentity(identity: AppServerRecoveryIdentity): void {
  if (
    !identity ||
    typeof identity !== "object" ||
    !identity.projectId.startsWith("prj_") ||
    !identity.hubSessionId.startsWith("ses_") ||
    identity.threadId.length === 0 ||
    !identity.lineageId.startsWith("lin_") ||
    !Number.isSafeInteger(identity.incarnation) ||
    identity.incarnation <= 0 ||
    !identity.launcherRunId.startsWith("run_") ||
    !identity.bundleId.startsWith("stb_") ||
    Object.keys(identity).some(
      (key) => !identityKeys.includes(key as (typeof identityKeys)[number]),
    )
  ) {
    throw new AppServerRecoveryFuseError(
      "APP_SERVER_RECOVERY_PROBE_STALE",
      "App-server recovery identity is invalid",
    );
  }
}

function sameIdentity(
  left: AppServerRecoveryIdentity | null,
  right: AppServerRecoveryIdentity,
): boolean {
  return Boolean(
    left &&
    left.projectId === right.projectId &&
    left.hubSessionId === right.hubSessionId &&
    left.threadId === right.threadId &&
    left.lineageId === right.lineageId &&
    left.incarnation === right.incarnation &&
    left.launcherRunId === right.launcherRunId &&
    left.bundleId === right.bundleId,
  );
}

function fingerprint(command: AppServerRecoveryProbeCommand): string {
  return JSON.stringify({
    schemaVersion: command.schemaVersion,
    kind: command.kind,
    commandId: command.commandId,
    commandGeneration: command.commandGeneration,
    fuseGeneration: command.fuseGeneration,
    identity: copyIdentity(command.identity),
  });
}

/**
 * Deep Module for app-server recovery ownership.
 *
 * It contains no transport/process implementation. The caller supplies the one half-open Adapter;
 * every other caller only sees the small state/command Interface and cannot accidentally start a
 * second model process or smuggle credentials into the supervisor request.
 */
export class AppServerRecoveryFuse {
  private readonly maxAutomaticAttempts: number;
  private readonly now: () => Date;
  private stateValue: AppServerRecoveryFuseState = "CLOSED";
  private fuseGenerationValue = 0;
  private failedAttemptsValue = 0;
  private crashedGenerationValue: number | null = null;
  private identityValue: AppServerRecoveryIdentity | null = null;
  private recoveryRequiredValue: AppServerRecoveryRequired | null = null;
  private lastCommandGeneration = 0;
  private readonly completedProbes = new Map<string, CompletedProbe>();
  private inFlightProbe: (InFlightProbe & { commandId: string }) | null = null;

  constructor(options: AppServerRecoveryFuseOptions = {}) {
    this.maxAutomaticAttempts = options.maxAutomaticAttempts ?? 3;
    this.now = options.now ?? (() => new Date());
    if (!Number.isSafeInteger(this.maxAutomaticAttempts) || this.maxAutomaticAttempts <= 0) {
      throw new TypeError("maxAutomaticAttempts must be a positive integer");
    }
  }

  get status(): AppServerRecoveryFuseStatus {
    const modelTransportState: AppServerModelTransportState =
      this.stateValue === "CLOSED"
        ? "MODEL_READY"
        : this.stateValue === "RECOVERING"
          ? "MODEL_RECOVERING"
          : this.stateValue === "HALF_OPEN"
            ? "MODEL_HALF_OPEN"
            : "MODEL_CONFIGURED_OFFLINE";
    return {
      state: this.stateValue,
      modelTransportState,
      fuseGeneration: this.fuseGenerationValue,
      failedAttempts: this.failedAttemptsValue,
      crashedGeneration: this.crashedGenerationValue,
      identity: this.identityValue ? copyIdentity(this.identityValue) : null,
      recoveryRequired: this.recoveryRequiredValue
        ? structuredClone(this.recoveryRequiredValue)
        : null,
    };
  }

  get blocksModelAdmission(): boolean {
    return this.stateValue === "FUSE_OPEN" || this.stateValue === "HALF_OPEN";
  }

  beginAutomaticRecovery(
    crashedGeneration: number | null,
    identity: AppServerRecoveryIdentity,
  ): { accepted: boolean; duplicate: boolean } {
    assertIdentity(identity);
    if (
      this.stateValue !== "CLOSED" &&
      this.crashedGenerationValue === crashedGeneration &&
      sameIdentity(this.identityValue, identity)
    ) {
      return { accepted: false, duplicate: true };
    }
    if (this.stateValue !== "CLOSED") {
      throw new AppServerRecoveryFuseError(
        "APP_SERVER_RECOVERY_FUSE_STATE_INVALID",
        "A different app-server recovery already owns the model Seam",
      );
    }
    this.stateValue = "RECOVERING";
    this.identityValue = copyIdentity(identity);
    this.crashedGenerationValue = crashedGeneration;
    this.failedAttemptsValue = 0;
    this.recoveryRequiredValue = null;
    return { accepted: true, duplicate: false };
  }

  recordAutomaticFailure(): AppServerRecoveryRequired | null {
    if (this.stateValue !== "RECOVERING" || !this.identityValue) {
      throw new AppServerRecoveryFuseError(
        "APP_SERVER_RECOVERY_FUSE_STATE_INVALID",
        "No automatic app-server recovery owns the model Seam",
      );
    }
    this.failedAttemptsValue += 1;
    if (this.failedAttemptsValue < this.maxAutomaticAttempts) return null;
    this.stateValue = "FUSE_OPEN";
    this.fuseGenerationValue += 1;
    this.lastCommandGeneration = 0;
    this.recoveryRequiredValue = this.createRecoveryRequired();
    return structuredClone(this.recoveryRequiredValue);
  }

  recordAutomaticSuccess(): void {
    if (this.stateValue !== "RECOVERING") {
      throw new AppServerRecoveryFuseError(
        "APP_SERVER_RECOVERY_FUSE_STATE_INVALID",
        "No automatic app-server recovery can be completed",
      );
    }
    this.closeFuse();
  }

  /** Restores a durable MODEL_CONFIGURED_OFFLINE bundle after process restart. */
  restoreConfiguredOffline(
    identity: AppServerRecoveryIdentity,
    fuseGeneration = 1,
  ): AppServerRecoveryRequired {
    assertIdentity(identity);
    if (!Number.isSafeInteger(fuseGeneration) || fuseGeneration <= 0) {
      throw new AppServerRecoveryFuseError(
        "APP_SERVER_RECOVERY_FUSE_STATE_INVALID",
        "Durable app-server fuse generation is invalid",
      );
    }
    if (this.stateValue !== "CLOSED") {
      throw new AppServerRecoveryFuseError(
        "APP_SERVER_RECOVERY_FUSE_STATE_INVALID",
        "App-server recovery state is already configured",
      );
    }
    this.identityValue = copyIdentity(identity);
    this.crashedGenerationValue = null;
    this.failedAttemptsValue = this.maxAutomaticAttempts;
    this.stateValue = "FUSE_OPEN";
    this.fuseGenerationValue = fuseGeneration;
    this.lastCommandGeneration = 0;
    this.recoveryRequiredValue = this.createRecoveryRequired();
    return structuredClone(this.recoveryRequiredValue);
  }

  /** Restores the monotonic counter of a durable ready bundle without opening model admission. */
  restoreReadyIdentity(identity: AppServerRecoveryIdentity, fuseGeneration: number): void {
    assertIdentity(identity);
    if (
      this.stateValue !== "CLOSED" ||
      !Number.isSafeInteger(fuseGeneration) ||
      fuseGeneration < this.fuseGenerationValue
    ) {
      throw new AppServerRecoveryFuseError(
        "APP_SERVER_RECOVERY_FUSE_STATE_INVALID",
        "Durable app-server fuse generation regressed",
      );
    }
    this.identityValue = copyIdentity(identity);
    this.fuseGenerationValue = fuseGeneration;
  }

  /** Binds an AUX/CURRENT_HEAD successor without pretending that its model transport is ready. */
  rebindOfflineIdentity(identity: AppServerRecoveryIdentity): AppServerRecoveryRequired {
    assertIdentity(identity);
    if (this.stateValue !== "FUSE_OPEN") {
      throw new AppServerRecoveryFuseError(
        "APP_SERVER_RECOVERY_FUSE_STATE_INVALID",
        "Only an open recovery fuse can bind an offline successor",
      );
    }
    this.identityValue = copyIdentity(identity);
    this.lastCommandGeneration = 0;
    this.recoveryRequiredValue = this.createRecoveryRequired();
    return structuredClone(this.recoveryRequiredValue);
  }

  async probe(
    command: AppServerRecoveryProbeCommand,
    adapter: () => Promise<void>,
  ): Promise<AppServerRecoveryProbeResult> {
    this.assertProbeCommand(command);
    const commandFingerprint = fingerprint(command);
    const completed = this.completedProbes.get(command.commandId);
    if (completed) {
      if (completed.fingerprint !== commandFingerprint) {
        return Promise.reject(
          new AppServerRecoveryFuseError(
            "APP_SERVER_RECOVERY_COMMAND_REPLAY_MISMATCH",
            "Recovery command id was replayed with a different binding",
          ),
        );
      }
      return Promise.resolve(structuredClone(completed.result));
    }
    if (this.inFlightProbe) {
      if (
        this.inFlightProbe.commandId === command.commandId &&
        this.inFlightProbe.fingerprint === commandFingerprint
      ) {
        return this.inFlightProbe.promise;
      }
      return Promise.reject(
        new AppServerRecoveryFuseError(
          "APP_SERVER_RECOVERY_PROBE_IN_PROGRESS",
          "A different half-open recovery command owns the model Seam",
        ),
      );
    }
    if (this.stateValue !== "FUSE_OPEN") {
      return Promise.reject(
        new AppServerRecoveryFuseError(
          "APP_SERVER_RECOVERY_FUSE_STATE_INVALID",
          "The app-server recovery fuse is not open",
        ),
      );
    }
    if (command.commandGeneration <= this.lastCommandGeneration) {
      return Promise.reject(
        new AppServerRecoveryFuseError(
          "APP_SERVER_RECOVERY_PROBE_STALE",
          "Recovery command generation is stale",
        ),
      );
    }
    this.lastCommandGeneration = command.commandGeneration;
    this.stateValue = "HALF_OPEN";
    const operation = this.runProbe(command, commandFingerprint, adapter);
    this.inFlightProbe = {
      commandId: command.commandId,
      fingerprint: commandFingerprint,
      promise: operation,
    };
    return operation;
  }

  private async runProbe(
    command: AppServerRecoveryProbeCommand,
    commandFingerprint: string,
    adapter: () => Promise<void>,
  ): Promise<AppServerRecoveryProbeResult> {
    let kind: AppServerRecoveryProbeResult["kind"] = "RECOVERED";
    try {
      await adapter();
      this.closeFuse();
    } catch {
      kind = "FUSE_OPEN";
      this.stateValue = "FUSE_OPEN";
    }
    const result: AppServerRecoveryProbeResult = {
      schemaVersion: 1,
      kind,
      commandId: command.commandId,
      commandGeneration: command.commandGeneration,
      fuseGeneration: command.fuseGeneration,
      completedAt: this.now().toISOString(),
      identity: copyIdentity(command.identity),
    };
    this.completedProbes.set(command.commandId, {
      fingerprint: commandFingerprint,
      result: structuredClone(result),
    });
    if (this.inFlightProbe?.commandId === command.commandId) this.inFlightProbe = null;
    return result;
  }

  private assertProbeCommand(command: AppServerRecoveryProbeCommand): void {
    assertIdentity(command.identity);
    if (
      command.schemaVersion !== 1 ||
      command.kind !== "CODEX_APP_SERVER_RECOVERY_PROBE" ||
      typeof command.commandId !== "string" ||
      command.commandId.length === 0 ||
      command.commandId.length > 200 ||
      !Number.isSafeInteger(command.commandGeneration) ||
      command.commandGeneration <= 0 ||
      !Number.isSafeInteger(command.fuseGeneration) ||
      command.fuseGeneration <= 0 ||
      command.fuseGeneration !== this.fuseGenerationValue ||
      !sameIdentity(this.identityValue, command.identity)
    ) {
      throw new AppServerRecoveryFuseError(
        "APP_SERVER_RECOVERY_PROBE_STALE",
        "Recovery command does not bind the current fuse generation and identity",
      );
    }
  }

  private createRecoveryRequired(): AppServerRecoveryRequired {
    if (!this.identityValue) {
      throw new AppServerRecoveryFuseError(
        "APP_SERVER_RECOVERY_FUSE_STATE_INVALID",
        "Recovery identity is unavailable",
      );
    }
    return {
      schemaVersion: 1,
      kind: "CODEX_APP_SERVER_RECOVERY_REQUIRED",
      fuseGeneration: this.fuseGenerationValue,
      failedAttempts: this.failedAttemptsValue,
      crashedGeneration: this.crashedGenerationValue,
      issuedAt: this.now().toISOString(),
      identity: copyIdentity(this.identityValue),
    };
  }

  private closeFuse(): void {
    this.stateValue = "CLOSED";
    this.failedAttemptsValue = 0;
    this.crashedGenerationValue = null;
    this.recoveryRequiredValue = null;
  }
}
