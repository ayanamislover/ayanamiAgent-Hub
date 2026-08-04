import { createHash, randomBytes } from "node:crypto";

export const MANAGED_BRIDGE_IPC_PROTOCOL = "crossagent.managed-bridge.ipc.v1" as const;
export const MANAGED_BRIDGE_IPC_MAX_FRAME_BYTES = 64 * 1024;

const MAX_IDENTIFIER_CHARS = 512;
const MAX_CAS_ATTEMPTS = 64;
const SHA256 = /^[a-f0-9]{64}$/;
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
const AUTHORITY_FIELD_PARTS = [
  "authority",
  "verification",
  "verified",
  "userdirective",
  "attestation",
  "signature",
] as const;

export type ManagedBridgeIpcErrorCode =
  | "FRAME_TOO_LARGE"
  | "TRUNCATED_FRAME"
  | "MULTIPLE_FRAMES"
  | "INVALID_FRAME_LENGTH"
  | "INVALID_JSON"
  | "DUPLICATE_JSON_KEY"
  | "INVALID_ENVELOPE"
  | "FORBIDDEN_SECRET_FIELD"
  | "FORGED_AUTHORITY"
  | "REQUEST_HASH_MISMATCH"
  | "ENDPOINT_MISMATCH"
  | "FUSE_GENERATION_MISMATCH"
  | "COMMAND_CONFLICT"
  | "COMMAND_IN_PROGRESS"
  | "COMMAND_JOURNAL_CONFLICT"
  | "ACTIVE_SUBJECT_CONFLICT"
  | "ACTIVE_SUBJECT_MISMATCH"
  | "LEASE_INVALID";

export class ManagedBridgeIpcError extends Error {
  constructor(
    readonly code: ManagedBridgeIpcErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ManagedBridgeIpcError";
  }
}

export type ManagedBridgeBuildIdentity = {
  buildId: string;
  buildSessionId: string;
  protocolId: string;
  manifestSha256: string;
  migrationId: string;
};

export type ManagedBridgeIpcSubject = {
  schemaVersion: 1;
  projectId: string;
  originalThreadId: string;
  agentId: "codex";
  runId: string;
  sessionId: string;
  lineageId: string;
  incarnation: number;
  bundleId: string;
  build: ManagedBridgeBuildIdentity;
  vaultSha256: string;
  checkpointSha256: string;
  checkpointEventSequence: number;
  fuseGeneration: number;
};

export type ManagedBridgeControlIpcRequest = {
  protocol: typeof MANAGED_BRIDGE_IPC_PROTOCOL;
  channel: "CONTROL";
  kind: "ENSURE_RUNNING" | "STOP" | "STATUS";
  commandId: string;
  requestHash: string;
  subject: ManagedBridgeIpcSubject;
};

export type ManagedBridgeWorkerProbeIpcRequest = {
  protocol: typeof MANAGED_BRIDGE_IPC_PROTOCOL;
  channel: "WORKER";
  kind: "PROBE_APP_SERVER";
  commandId: string;
  requestHash: string;
  subject: ManagedBridgeIpcSubject;
  targetFuseGeneration: number;
};

export type ManagedBridgeWorkerHealthIpcRequest = {
  protocol: typeof MANAGED_BRIDGE_IPC_PROTOCOL;
  channel: "WORKER";
  kind: "REPORT_HEALTH";
  commandId: string;
  requestHash: string;
  subject: ManagedBridgeIpcSubject;
};

export type ManagedBridgeWorkerIpcRequest =
  ManagedBridgeWorkerProbeIpcRequest | ManagedBridgeWorkerHealthIpcRequest;

export type ManagedBridgeIpcRequest =
  ManagedBridgeControlIpcRequest | ManagedBridgeWorkerIpcRequest;

export type ManagedBridgeIpcRequestInput =
  | Omit<ManagedBridgeControlIpcRequest, "requestHash">
  | Omit<ManagedBridgeWorkerProbeIpcRequest, "requestHash">
  | Omit<ManagedBridgeWorkerHealthIpcRequest, "requestHash">;

export type ManagedBridgeIpcEndpoint =
  { channel: "CONTROL" } | { channel: "WORKER"; subject: ManagedBridgeIpcSubject };

export type ManagedBridgeIpcEffectReceipt = {
  status: "RUNNING" | "STOPPED" | "HEALTHY";
  subjectKey: string;
  recordRevision: number;
  eventSequence: number;
};

export type ManagedBridgeIpcCommandResult = {
  protocol: typeof MANAGED_BRIDGE_IPC_PROTOCOL;
  channel: ManagedBridgeIpcRequest["channel"];
  kind: "COMMAND_RESULT";
  commandId: string;
  requestHash: string;
  disposition: "APPLIED" | "REPLAYED";
  receipt: ManagedBridgeIpcEffectReceipt;
};

export type ManagedBridgeIpcCommandJournal = {
  schemaVersion: 1;
  revision: number;
  commandId: string;
  requestHash: string;
  subjectKey: string;
  state: "CLAIMED" | "COMPLETED";
  receipt: ManagedBridgeIpcEffectReceipt | null;
};

export type ManagedBridgeActiveSubjectRecord = {
  schemaVersion: 1;
  key: string;
  revision: number;
  state: "RUNNING" | "STOPPED";
  subject: ManagedBridgeIpcSubject;
};

export interface ManagedBridgeIpcLease {
  readonly leaseId: string;
  readonly generation: number;
  readonly active: boolean;
  assertActive(): void;
}

export interface ManagedBridgeIpcListenerLifecycle {
  readonly listening: boolean;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "close", listener: () => void): unknown;
}

export interface ManagedBridgeIpcCommandStore {
  load(commandId: string): Promise<ManagedBridgeIpcCommandJournal | null>;
  /**
   * The Adapter must call lease.assertActive() in the same serializable critical
   * section immediately before its mutation. This makes listener ownership the
   * write fence rather than a best-effort preflight check.
   */
  compareAndSwap(
    commandId: string,
    expectedRevision: number | null,
    next: ManagedBridgeIpcCommandJournal,
    lease: ManagedBridgeIpcLease,
  ): Promise<boolean>;
}

export interface ManagedBridgeActiveSubjectStore {
  load(key: string): Promise<ManagedBridgeActiveSubjectRecord | null>;
  /** Same atomic lease-fence requirement as ManagedBridgeIpcCommandStore. */
  compareAndSwap(
    key: string,
    expectedRevision: number | null,
    next: ManagedBridgeActiveSubjectRecord,
    lease: ManagedBridgeIpcLease,
  ): Promise<boolean>;
}

type MutableLeaseState = {
  leaseId: string;
  generation: number;
  active: boolean;
};

class BoundManagedBridgeIpcLease implements ManagedBridgeIpcLease {
  constructor(private readonly state: MutableLeaseState) {}

  get leaseId(): string {
    return this.state.leaseId;
  }

  get generation(): number {
    return this.state.generation;
  }

  get active(): boolean {
    return this.state.active;
  }

  assertActive(): void {
    if (!this.state.active) {
      throw new ManagedBridgeIpcError(
        "LEASE_INVALID",
        "The IPC listener lease is no longer active",
      );
    }
  }
}

export class ManagedBridgeIpcLeaseController {
  private generation = 0;
  private current: MutableLeaseState | null = null;

  bindAfterListen(listener: ManagedBridgeIpcListenerLifecycle): ManagedBridgeIpcLease {
    if (!listener.listening) {
      throw new ManagedBridgeIpcError(
        "LEASE_INVALID",
        "Cannot bind a lease before a listener is active",
      );
    }

    if (this.current) this.current.active = false;
    const state: MutableLeaseState = {
      leaseId: randomBytes(16).toString("hex"),
      generation: ++this.generation,
      active: true,
    };
    this.current = state;
    const invalidate = (): void => {
      state.active = false;
      if (this.current === state) this.current = null;
    };
    listener.on("error", invalidate);
    listener.on("close", invalidate);

    // A listener may close between the initial observation and handler binding.
    if (!listener.listening) {
      invalidate();
      throw new ManagedBridgeIpcError(
        "LEASE_INVALID",
        "The IPC listener closed while binding its lease",
      );
    }
    return new BoundManagedBridgeIpcLease(state);
  }
}

export class ManagedBridgeIpcFrameReader {
  private buffer = Buffer.alloc(0);
  private expectedBytes: number | null = null;
  private complete = false;

  constructor(private readonly endpoint: ManagedBridgeIpcEndpoint = { channel: "CONTROL" }) {}

  push(chunk: Uint8Array): ManagedBridgeIpcRequest | null {
    if (this.complete) {
      throw new ManagedBridgeIpcError(
        "MULTIPLE_FRAMES",
        "Only one IPC request is allowed per connection",
      );
    }
    if (chunk.byteLength === 0) return null;
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    if (this.buffer.byteLength >= 4 && this.expectedBytes === null) {
      const declared = this.buffer.readUInt32BE(0);
      assertFrameLength(declared);
      this.expectedBytes = 4 + declared;
    }
    if (this.expectedBytes === null) return null;
    if (this.buffer.byteLength > this.expectedBytes) {
      throw new ManagedBridgeIpcError(
        "MULTIPLE_FRAMES",
        "The connection contained trailing frame data",
      );
    }
    if (this.buffer.byteLength < this.expectedBytes) return null;
    const request = decodeManagedBridgeIpcRequest(this.buffer, this.endpoint);
    this.complete = true;
    return request;
  }

  end(): void {
    if (!this.complete) {
      throw new ManagedBridgeIpcError("TRUNCATED_FRAME", "The IPC connection ended mid-frame");
    }
  }
}

export function createManagedBridgeIpcRequest(
  input: ManagedBridgeIpcRequestInput,
): ManagedBridgeIpcRequest {
  validateRequestInput(input);
  const request = {
    ...structuredClone(input),
    requestHash: requestHash(input),
  } as ManagedBridgeIpcRequest;
  validateManagedBridgeIpcRequest(request);
  return request;
}

export function encodeManagedBridgeIpcRequest(request: ManagedBridgeIpcRequest): Buffer {
  validateManagedBridgeIpcRequest(request);
  const payload = Buffer.from(canonicalJson(request), "utf8");
  assertFrameLength(payload.byteLength);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.byteLength, 0);
  return Buffer.concat([header, payload]);
}

export function decodeManagedBridgeIpcRequest(
  frame: Uint8Array,
  endpoint: ManagedBridgeIpcEndpoint,
): ManagedBridgeIpcRequest {
  const bytes = Buffer.from(frame);
  if (bytes.byteLength < 4) {
    throw new ManagedBridgeIpcError("TRUNCATED_FRAME", "The IPC frame header is incomplete");
  }
  const declared = bytes.readUInt32BE(0);
  assertFrameLength(declared);
  const total = 4 + declared;
  if (bytes.byteLength < total) {
    throw new ManagedBridgeIpcError("TRUNCATED_FRAME", "The IPC frame payload is incomplete");
  }
  if (bytes.byteLength > total) {
    throw new ManagedBridgeIpcError(
      "MULTIPLE_FRAMES",
      "Only one IPC request is allowed per connection",
    );
  }

  const text = bytes.subarray(4).toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new ManagedBridgeIpcError("INVALID_JSON", "The IPC payload is not valid JSON");
  }
  assertNoDuplicateJsonKeys(text);
  assertNoForgedAuthority(parsed);
  assertNoSecretFields(parsed);
  validateManagedBridgeIpcRequest(parsed);
  validateEndpoint(parsed, endpoint);
  return parsed;
}

export function managedBridgeActiveSubjectKey(subject: ManagedBridgeIpcSubject): string {
  assertManagedBridgeIpcSubject(subject);
  return createHash("sha256")
    .update(`${subject.projectId}\0${subject.originalThreadId}`)
    .digest("hex");
}

export function managedBridgeControlPipeName(namespaceRoot: string): string {
  assertIdentifier(namespaceRoot, "namespaceRoot");
  const digest = createHash("sha256")
    .update(`control\0${namespaceRoot}`)
    .digest("hex")
    .slice(0, 32);
  return `\\\\.\\pipe\\crossagent-control-${digest}`;
}

export function managedBridgeWorkerPipeName(
  namespaceRoot: string,
  subject: ManagedBridgeIpcSubject,
): string {
  assertIdentifier(namespaceRoot, "namespaceRoot");
  assertManagedBridgeIpcSubject(subject);
  const digest = createHash("sha256")
    .update(
      `worker\0${namespaceRoot}\0${subject.projectId}\0${subject.originalThreadId}\0${subject.runId}`,
    )
    .digest("hex")
    .slice(0, 32);
  return `\\\\.\\pipe\\crossagent-worker-${digest}`;
}

export class ManagedBridgeIpcCommandExecutor {
  private readonly store: ManagedBridgeIpcCommandStore;
  private readonly lease: ManagedBridgeIpcLease;
  private readonly effect: (
    request: ManagedBridgeIpcRequest,
  ) => Promise<ManagedBridgeIpcEffectReceipt>;

  constructor(input: {
    store: ManagedBridgeIpcCommandStore;
    lease: ManagedBridgeIpcLease;
    effect: (request: ManagedBridgeIpcRequest) => Promise<ManagedBridgeIpcEffectReceipt>;
  }) {
    this.store = input.store;
    this.lease = input.lease;
    this.effect = input.effect;
  }

  async execute(request: ManagedBridgeIpcRequest): Promise<ManagedBridgeIpcCommandResult> {
    validateManagedBridgeIpcRequest(request);
    this.lease.assertActive();
    const subjectKey = managedBridgeActiveSubjectKey(request.subject);

    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      this.lease.assertActive();
      const existing = await this.store.load(request.commandId);
      if (existing) {
        validateCommandJournal(existing);
        if (existing.requestHash !== request.requestHash || existing.subjectKey !== subjectKey) {
          throw new ManagedBridgeIpcError(
            "COMMAND_CONFLICT",
            "The commandId is already bound to a different request",
          );
        }
        if (existing.state === "CLAIMED") {
          throw new ManagedBridgeIpcError(
            "COMMAND_IN_PROGRESS",
            "The command has a durable claim but no replayable result",
          );
        }
        return commandResult(request, "REPLAYED", existing.receipt!);
      }

      const claimed: ManagedBridgeIpcCommandJournal = {
        schemaVersion: 1,
        revision: 0,
        commandId: request.commandId,
        requestHash: request.requestHash,
        subjectKey,
        state: "CLAIMED",
        receipt: null,
      };
      this.lease.assertActive();
      if (!(await this.store.compareAndSwap(request.commandId, null, claimed, this.lease)))
        continue;

      this.lease.assertActive();
      const receipt = await this.effect(structuredClone(request));
      validateEffectReceipt(receipt);
      if (receipt.subjectKey !== subjectKey) {
        throw new ManagedBridgeIpcError(
          "COMMAND_JOURNAL_CONFLICT",
          "The effect receipt does not belong to the request subject",
        );
      }
      if (receipt.eventSequence < request.subject.checkpointEventSequence) {
        throw new ManagedBridgeIpcError(
          "COMMAND_JOURNAL_CONFLICT",
          "The effect receipt regresses the subject event sequence",
        );
      }
      const expectedStatus =
        request.kind === "ENSURE_RUNNING"
          ? "RUNNING"
          : request.kind === "STOP"
            ? "STOPPED"
            : request.kind === "PROBE_APP_SERVER" || request.kind === "REPORT_HEALTH"
              ? "HEALTHY"
              : null;
      if (expectedStatus !== null && receipt.status !== expectedStatus) {
        throw new ManagedBridgeIpcError(
          "COMMAND_JOURNAL_CONFLICT",
          "The effect receipt status does not match the typed command",
        );
      }
      const completed: ManagedBridgeIpcCommandJournal = {
        ...claimed,
        revision: 1,
        state: "COMPLETED",
        receipt: structuredClone(receipt),
      };
      this.lease.assertActive();
      if (!(await this.store.compareAndSwap(request.commandId, 0, completed, this.lease))) {
        throw new ManagedBridgeIpcError(
          "COMMAND_JOURNAL_CONFLICT",
          "The claimed command could not persist its exact result",
        );
      }
      return commandResult(request, "APPLIED", receipt);
    }
    throw new ManagedBridgeIpcError(
      "COMMAND_JOURNAL_CONFLICT",
      "The command journal did not converge within the bounded CAS budget",
    );
  }
}

export class ManagedBridgeActiveSubjectRegistry {
  private readonly store: ManagedBridgeActiveSubjectStore;
  private readonly lease: ManagedBridgeIpcLease;

  constructor(input: { store: ManagedBridgeActiveSubjectStore; lease: ManagedBridgeIpcLease }) {
    this.store = input.store;
    this.lease = input.lease;
  }

  async ensureRunning(subject: ManagedBridgeIpcSubject): Promise<ManagedBridgeActiveSubjectRecord> {
    assertManagedBridgeIpcSubject(subject);
    this.lease.assertActive();
    const key = managedBridgeActiveSubjectKey(subject);
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      this.lease.assertActive();
      const current = await this.store.load(key);
      if (current) {
        validateActiveSubjectRecord(current);
        if (current.state === "RUNNING") {
          if (!sameSubject(current.subject, subject)) {
            throw new ManagedBridgeIpcError(
              "ACTIVE_SUBJECT_CONFLICT",
              "A different run already owns this project and original thread",
            );
          }
          return current;
        }
      }
      const next: ManagedBridgeActiveSubjectRecord = {
        schemaVersion: 1,
        key,
        revision: current ? current.revision + 1 : 0,
        state: "RUNNING",
        subject: structuredClone(subject),
      };
      this.lease.assertActive();
      if (await this.store.compareAndSwap(key, current?.revision ?? null, next, this.lease)) {
        return next;
      }
    }
    throw new ManagedBridgeIpcError(
      "ACTIVE_SUBJECT_CONFLICT",
      "The active subject did not converge within the bounded CAS budget",
    );
  }

  async stop(subject: ManagedBridgeIpcSubject): Promise<ManagedBridgeActiveSubjectRecord> {
    assertManagedBridgeIpcSubject(subject);
    this.lease.assertActive();
    const key = managedBridgeActiveSubjectKey(subject);
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      this.lease.assertActive();
      const current = await this.store.load(key);
      if (!current) {
        throw new ManagedBridgeIpcError("ACTIVE_SUBJECT_MISMATCH", "The active subject is absent");
      }
      validateActiveSubjectRecord(current);
      if (!sameSubject(current.subject, subject)) {
        throw new ManagedBridgeIpcError(
          "ACTIVE_SUBJECT_MISMATCH",
          "The caller does not own the exact active subject",
        );
      }
      if (current.state === "STOPPED") return current;
      const next: ManagedBridgeActiveSubjectRecord = {
        ...current,
        revision: current.revision + 1,
        state: "STOPPED",
      };
      this.lease.assertActive();
      if (await this.store.compareAndSwap(key, current.revision, next, this.lease)) return next;
    }
    throw new ManagedBridgeIpcError(
      "ACTIVE_SUBJECT_CONFLICT",
      "The active subject did not converge within the bounded CAS budget",
    );
  }

  async advanceRunning(
    expected: ManagedBridgeIpcSubject,
    nextSubject: ManagedBridgeIpcSubject,
  ): Promise<ManagedBridgeActiveSubjectRecord> {
    assertManagedBridgeIpcSubject(expected);
    assertManagedBridgeIpcSubject(nextSubject);
    this.lease.assertActive();
    const key = managedBridgeActiveSubjectKey(expected);
    if (
      managedBridgeActiveSubjectKey(nextSubject) !== key ||
      !subjectProgresses(expected, nextSubject)
    ) {
      throw new ManagedBridgeIpcError(
        "ACTIVE_SUBJECT_MISMATCH",
        "The successor is not an exact monotonic advance of the active run",
      );
    }
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      this.lease.assertActive();
      const current = await this.store.load(key);
      if (!current) {
        throw new ManagedBridgeIpcError("ACTIVE_SUBJECT_MISMATCH", "The active subject is absent");
      }
      validateActiveSubjectRecord(current);
      if (current.state !== "RUNNING" || !sameSubject(current.subject, expected)) {
        throw new ManagedBridgeIpcError(
          "ACTIVE_SUBJECT_MISMATCH",
          "The expected active subject is stale or no longer running",
        );
      }
      const next: ManagedBridgeActiveSubjectRecord = {
        ...current,
        revision: current.revision + 1,
        subject: structuredClone(nextSubject),
      };
      this.lease.assertActive();
      if (await this.store.compareAndSwap(key, current.revision, next, this.lease)) return next;
    }
    throw new ManagedBridgeIpcError(
      "ACTIVE_SUBJECT_CONFLICT",
      "The active subject did not converge within the bounded CAS budget",
    );
  }
}

function commandResult(
  request: ManagedBridgeIpcRequest,
  disposition: ManagedBridgeIpcCommandResult["disposition"],
  receipt: ManagedBridgeIpcEffectReceipt,
): ManagedBridgeIpcCommandResult {
  return {
    protocol: MANAGED_BRIDGE_IPC_PROTOCOL,
    channel: request.channel,
    kind: "COMMAND_RESULT",
    commandId: request.commandId,
    requestHash: request.requestHash,
    disposition,
    receipt: structuredClone(receipt),
  };
}

function validateEndpoint(
  request: ManagedBridgeIpcRequest,
  endpoint: ManagedBridgeIpcEndpoint,
): void {
  if (request.channel !== endpoint.channel) {
    throw new ManagedBridgeIpcError(
      "ENDPOINT_MISMATCH",
      "The request channel does not match the pipe",
    );
  }
  if (endpoint.channel === "WORKER" && !sameSubject(request.subject, endpoint.subject)) {
    throw new ManagedBridgeIpcError(
      "ENDPOINT_MISMATCH",
      "The worker request does not match the exact per-run pipe subject",
    );
  }
}

function validateRequestInput(value: unknown): asserts value is ManagedBridgeIpcRequestInput {
  assertNoForgedAuthority(value);
  assertNoSecretFields(value);
  assertRecord(value, "request");
  assertExactKeys(value, requestEnvelopeKeys(value, false), "request");
  validateRequestCore(value);
}

function validateManagedBridgeIpcRequest(value: unknown): asserts value is ManagedBridgeIpcRequest {
  assertNoForgedAuthority(value);
  assertNoSecretFields(value);
  assertRecord(value, "request");
  assertExactKeys(value, requestEnvelopeKeys(value, true), "request");
  validateRequestCore(value);
  assertSha256(value.requestHash, "request.requestHash");
  const { requestHash: _ignored, ...input } = value;
  if (requestHash(input as ManagedBridgeIpcRequestInput) !== value.requestHash) {
    throw new ManagedBridgeIpcError(
      "REQUEST_HASH_MISMATCH",
      "The requestHash does not authenticate the exact request envelope",
    );
  }
}

function validateRequestCore(value: Record<string, unknown>): void {
  if (value.protocol !== MANAGED_BRIDGE_IPC_PROTOCOL) invalid("request.protocol");
  if (value.channel !== "CONTROL" && value.channel !== "WORKER") invalid("request.channel");
  const allowedKinds =
    value.channel === "CONTROL"
      ? (["ENSURE_RUNNING", "STOP", "STATUS"] as const)
      : (["PROBE_APP_SERVER", "REPORT_HEALTH"] as const);
  if (!allowedKinds.includes(value.kind as never)) invalid("request.kind");
  assertIdentifier(value.commandId, "request.commandId");
  assertManagedBridgeIpcSubject(value.subject);
  if (value.channel === "WORKER" && value.kind === "PROBE_APP_SERVER") {
    validateRecoveryTarget(value.targetFuseGeneration, value.subject);
  }
}

function requestEnvelopeKeys(value: Record<string, unknown>, withHash: boolean): string[] {
  const keys = ["protocol", "channel", "kind", "commandId", "subject"];
  if (withHash) keys.push("requestHash");
  if (value.channel === "WORKER" && value.kind === "PROBE_APP_SERVER") {
    keys.push("targetFuseGeneration");
  }
  return keys;
}

function validateRecoveryTarget(value: unknown, subject: ManagedBridgeIpcSubject): void {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) <= 0 ||
    !Number.isSafeInteger(subject.fuseGeneration + 1) ||
    value !== subject.fuseGeneration + 1
  ) {
    throw new ManagedBridgeIpcError(
      "FUSE_GENERATION_MISMATCH",
      "A recovery target must be the positive exact successor of the last observed fuse generation",
    );
  }
}

export function assertManagedBridgeIpcSubject(
  value: unknown,
): asserts value is ManagedBridgeIpcSubject {
  assertRecord(value, "subject");
  assertExactKeys(
    value,
    [
      "schemaVersion",
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
    "subject",
  );
  if (value.schemaVersion !== 1) invalid("subject.schemaVersion");
  assertIdentifier(value.projectId, "subject.projectId");
  assertIdentifier(value.originalThreadId, "subject.originalThreadId");
  if (value.agentId !== "codex") invalid("subject.agentId");
  assertIdentifier(value.runId, "subject.runId");
  assertIdentifier(value.sessionId, "subject.sessionId");
  assertIdentifier(value.lineageId, "subject.lineageId");
  assertPositiveInteger(value.incarnation, "subject.incarnation");
  assertIdentifier(value.bundleId, "subject.bundleId");
  validateBuildIdentity(value.build);
  assertSha256(value.vaultSha256, "subject.vaultSha256");
  assertSha256(value.checkpointSha256, "subject.checkpointSha256");
  assertNonNegativeInteger(value.checkpointEventSequence, "subject.checkpointEventSequence");
  assertNonNegativeInteger(value.fuseGeneration, "subject.fuseGeneration");
}

function validateBuildIdentity(value: unknown): asserts value is ManagedBridgeBuildIdentity {
  assertRecord(value, "subject.build");
  assertExactKeys(
    value,
    ["buildId", "buildSessionId", "protocolId", "manifestSha256", "migrationId"],
    "subject.build",
  );
  assertIdentifier(value.buildId, "subject.build.buildId");
  assertIdentifier(value.buildSessionId, "subject.build.buildSessionId");
  assertIdentifier(value.protocolId, "subject.build.protocolId");
  assertSha256(value.manifestSha256, "subject.build.manifestSha256");
  assertIdentifier(value.migrationId, "subject.build.migrationId");
}

function validateEffectReceipt(value: unknown): asserts value is ManagedBridgeIpcEffectReceipt {
  assertRecord(value, "receipt");
  assertExactKeys(value, ["status", "subjectKey", "recordRevision", "eventSequence"], "receipt");
  if (value.status !== "RUNNING" && value.status !== "STOPPED" && value.status !== "HEALTHY") {
    invalid("receipt.status");
  }
  assertSha256(value.subjectKey, "receipt.subjectKey");
  assertNonNegativeInteger(value.recordRevision, "receipt.recordRevision");
  assertNonNegativeInteger(value.eventSequence, "receipt.eventSequence");
}

function validateCommandJournal(value: unknown): asserts value is ManagedBridgeIpcCommandJournal {
  assertRecord(value, "journal");
  assertExactKeys(
    value,
    ["schemaVersion", "revision", "commandId", "requestHash", "subjectKey", "state", "receipt"],
    "journal",
  );
  if (value.schemaVersion !== 1) invalid("journal.schemaVersion");
  assertNonNegativeInteger(value.revision, "journal.revision");
  assertIdentifier(value.commandId, "journal.commandId");
  assertSha256(value.requestHash, "journal.requestHash");
  assertSha256(value.subjectKey, "journal.subjectKey");
  if (value.state !== "CLAIMED" && value.state !== "COMPLETED") invalid("journal.state");
  if (value.state === "CLAIMED" && value.receipt !== null) invalid("journal.receipt");
  if (value.state === "COMPLETED") validateEffectReceipt(value.receipt);
}

function validateActiveSubjectRecord(
  value: unknown,
): asserts value is ManagedBridgeActiveSubjectRecord {
  assertRecord(value, "activeSubject");
  assertExactKeys(value, ["schemaVersion", "key", "revision", "state", "subject"], "activeSubject");
  if (value.schemaVersion !== 1) invalid("activeSubject.schemaVersion");
  assertSha256(value.key, "activeSubject.key");
  assertNonNegativeInteger(value.revision, "activeSubject.revision");
  if (value.state !== "RUNNING" && value.state !== "STOPPED") invalid("activeSubject.state");
  assertManagedBridgeIpcSubject(value.subject);
  if (managedBridgeActiveSubjectKey(value.subject) !== value.key) invalid("activeSubject.key");
}

function sameSubject(left: ManagedBridgeIpcSubject, right: ManagedBridgeIpcSubject): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function subjectProgresses(
  previous: ManagedBridgeIpcSubject,
  next: ManagedBridgeIpcSubject,
): boolean {
  if (
    previous.projectId !== next.projectId ||
    previous.originalThreadId !== next.originalThreadId ||
    previous.agentId !== next.agentId ||
    previous.runId !== next.runId ||
    previous.lineageId !== next.lineageId ||
    canonicalJson(previous.build) !== canonicalJson(next.build) ||
    next.incarnation < previous.incarnation ||
    next.checkpointEventSequence < previous.checkpointEventSequence ||
    next.fuseGeneration < previous.fuseGeneration
  ) {
    return false;
  }
  if (next.incarnation === previous.incarnation && next.sessionId !== previous.sessionId)
    return false;
  return true;
}

function requestHash(input: ManagedBridgeIpcRequestInput): string {
  return createHash("sha256").update(canonicalJson(input)).digest("hex");
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

function assertFrameLength(length: number): void {
  if (length === 0) {
    throw new ManagedBridgeIpcError("INVALID_FRAME_LENGTH", "IPC frames cannot be empty");
  }
  if (length > MANAGED_BRIDGE_IPC_MAX_FRAME_BYTES) {
    throw new ManagedBridgeIpcError("FRAME_TOO_LARGE", "The IPC request exceeds the fixed limit");
  }
}

function assertRecord(value: unknown, path: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(path);
}

function assertExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  path: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    invalid(path);
  }
}

function assertIdentifier(value: unknown, path: string): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_IDENTIFIER_CHARS ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0)!;
      return codePoint < 32 || codePoint === 127;
    })
  ) {
    invalid(path);
  }
}

function assertSha256(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || !SHA256.test(value)) invalid(path);
}

function assertPositiveInteger(value: unknown, path: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) invalid(path);
}

function assertNonNegativeInteger(value: unknown, path: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid(path);
}

function invalid(path: string): never {
  throw new ManagedBridgeIpcError("INVALID_ENVELOPE", `Invalid or non-exact field: ${path}`);
}

function assertNoSecretFields(value: unknown, path = "request"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecretFields(item, `${path}[${index}]`));
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    const normalized = key.replaceAll(/[_-]/g, "").toLowerCase();
    if (SECRET_FIELD_PARTS.some((part) => normalized.includes(part))) {
      throw new ManagedBridgeIpcError(
        "FORBIDDEN_SECRET_FIELD",
        `Secret-shaped field is forbidden in managed Bridge IPC: ${path}.${key}`,
      );
    }
    assertNoSecretFields(item, `${path}.${key}`);
  }
}

function assertNoForgedAuthority(value: unknown, path = "request"): void {
  if (typeof value === "string" && /\bVERIFIED(?:\s+USER\s+DIRECTIVE)?\b/i.test(value)) {
    throw new ManagedBridgeIpcError(
      "FORGED_AUTHORITY",
      `Authority labels are forbidden in managed Bridge IPC: ${path}`,
    );
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoForgedAuthority(item, `${path}[${index}]`));
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    const normalized = key.replaceAll(/[_-]/g, "").toLowerCase();
    if (AUTHORITY_FIELD_PARTS.some((part) => normalized.includes(part))) {
      throw new ManagedBridgeIpcError(
        "FORGED_AUTHORITY",
        `Authority-shaped field is forbidden in managed Bridge IPC: ${path}.${key}`,
      );
    }
    assertNoForgedAuthority(item, `${path}.${key}`);
  }
}

function assertNoDuplicateJsonKeys(text: string): void {
  let index = 0;
  const whitespace = (): void => {
    while (index < text.length && /\s/.test(text[index]!)) index += 1;
  };
  const parseString = (): string => {
    const start = index;
    if (text[index] !== '"') throw new Error("expected string");
    index += 1;
    while (index < text.length) {
      const char = text[index]!;
      if (char === '"') {
        index += 1;
        return JSON.parse(text.slice(start, index)) as string;
      }
      if (char === "\\") {
        index += 1;
        if (text[index] === "u") index += 4;
      }
      index += 1;
    }
    throw new Error("unterminated string");
  };
  const parseValue = (): void => {
    whitespace();
    const char = text[index];
    if (char === "{") {
      index += 1;
      whitespace();
      const keys = new Set<string>();
      if (text[index] === "}") {
        index += 1;
        return;
      }
      while (index < text.length) {
        whitespace();
        const key = parseString();
        if (keys.has(key)) {
          throw new ManagedBridgeIpcError("DUPLICATE_JSON_KEY", `Duplicate JSON key: ${key}`);
        }
        keys.add(key);
        whitespace();
        if (text[index] !== ":") throw new Error("expected colon");
        index += 1;
        parseValue();
        whitespace();
        if (text[index] === "}") {
          index += 1;
          return;
        }
        if (text[index] !== ",") throw new Error("expected comma");
        index += 1;
      }
      throw new Error("unterminated object");
    }
    if (char === "[") {
      index += 1;
      whitespace();
      if (text[index] === "]") {
        index += 1;
        return;
      }
      while (index < text.length) {
        parseValue();
        whitespace();
        if (text[index] === "]") {
          index += 1;
          return;
        }
        if (text[index] !== ",") throw new Error("expected comma");
        index += 1;
      }
      throw new Error("unterminated array");
    }
    if (char === '"') {
      parseString();
      return;
    }
    const match = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(
      text.slice(index),
    );
    if (!match) throw new Error("invalid scalar");
    index += match[0].length;
  };
  try {
    parseValue();
    whitespace();
    if (index !== text.length) throw new Error("trailing JSON");
  } catch (error) {
    if (error instanceof ManagedBridgeIpcError) throw error;
    throw new ManagedBridgeIpcError("INVALID_JSON", "The IPC payload is not strict JSON");
  }
}
