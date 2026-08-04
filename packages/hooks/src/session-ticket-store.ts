import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import {
  AgentSessionSchema,
  SessionTicketBindingSchema,
  type AgentSession,
  type SessionTicketBinding,
  type AdapterClientType,
  type AdapterSessionClient,
  type SessionTicketActivationMode,
  type TerminalSessionTicketState,
} from "@crossagent/protocol";
import { withDurableFileLock } from "./durable-file-lock.js";

export type HookTicketSessionIdentity = {
  projectId: string;
  adapterClient: AdapterClientType;
  agentId: AdapterClientType;
  sessionClient: Extract<AdapterSessionClient, "codex-cli-hooks" | "claude-hooks">;
  externalSessionId: string;
  externalThreadId: string;
};

export type HookTicketSecret = {
  rawToken: string;
  tokenSha256: string;
  offerId: string | null;
};

export type HookPendingTicketBundle = {
  generation: number;
  bundleId: string;
  runId: string;
  activationMode: Extract<
    SessionTicketActivationMode,
    "FIRST_LINEAGE" | "CURRENT_HEAD_REPLACEMENT"
  >;
  expectedLineageId: string | null;
  expectedHeadSessionId: string | null;
  control: HookTicketSecret;
  capture: HookTicketSecret;
  registerIdempotencyKey: string;
};

export type HookActiveTicketBundle = HookPendingTicketBundle & {
  control: HookTicketSecret & { offerId: string };
  capture: HookTicketSecret & { offerId: string };
  session: AgentSession;
  binding: SessionTicketBinding;
  serverNow: string;
  observedAt: string;
};

export type HookSessionTicketRecord = {
  schemaVersion: 1;
  revision: number;
  identity: HookTicketSessionIdentity;
  state: "ENROLLING" | "ACTIVE" | "REPLACING" | "DRAINING" | "CLOSING";
  active: HookActiveTicketBundle | null;
  pending: HookPendingTicketBundle | null;
  closeIdempotencyKey: string;
  createdAt: string;
  updatedAt: string;
};

export type HookTicketTerminalReceipt = {
  bundleId: string;
  hubSessionId: string;
  state: TerminalSessionTicketState;
  terminalAt: string;
};

type StoredEnvelope = {
  version: 1;
  payload: HookSessionTicketRecord;
  payloadSha256: string;
};

export type HookSessionTicketTransaction = {
  readonly current: HookSessionTicketRecord | null;
  save(record: HookSessionTicketRecord): void;
  remove(receipt: HookTicketTerminalReceipt): void;
};

const MAX_RECORD_BYTES = 64 * 1024;
const IDENTITY_KEYS = [
  "adapterClient",
  "agentId",
  "externalSessionId",
  "externalThreadId",
  "projectId",
  "sessionClient",
] as const;
const RECORD_KEYS = [
  "active",
  "closeIdempotencyKey",
  "createdAt",
  "identity",
  "pending",
  "revision",
  "schemaVersion",
  "state",
  "updatedAt",
] as const;
const ENVELOPE_KEYS = ["payload", "payloadSha256", "version"] as const;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sortedKeys(value: Record<string, unknown>): string {
  return Object.keys(value).sort().join("\u0000");
}

function expectedKeys(values: readonly string[]): string {
  return [...values].sort().join("\u0000");
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function assertIdentity(value: unknown): asserts value is HookTicketSessionIdentity {
  if (!value || typeof value !== "object") throw new Error("ticket_store_identity_invalid");
  const candidate = value as Record<string, unknown>;
  if (sortedKeys(candidate) !== expectedKeys(IDENTITY_KEYS)) {
    throw new Error("ticket_store_identity_unknown_fields");
  }
  if (
    typeof candidate.projectId !== "string" ||
    !["codex", "claude"].includes(String(candidate.adapterClient)) ||
    candidate.agentId !== candidate.adapterClient ||
    !["codex-cli-hooks", "claude-hooks"].includes(String(candidate.sessionClient)) ||
    (String(candidate.sessionClient).startsWith("codex-") ? "codex" : "claude") !==
      candidate.adapterClient ||
    typeof candidate.externalSessionId !== "string" ||
    candidate.externalSessionId.length === 0 ||
    typeof candidate.externalThreadId !== "string" ||
    candidate.externalThreadId.length === 0
  ) {
    throw new Error("ticket_store_identity_invalid");
  }
}

function assertSecret(value: unknown): asserts value is HookTicketSecret {
  if (!value || typeof value !== "object") throw new Error("ticket_store_secret_invalid");
  const candidate = value as Record<string, unknown>;
  if (sortedKeys(candidate) !== expectedKeys(["offerId", "rawToken", "tokenSha256"])) {
    throw new Error("ticket_store_secret_unknown_fields");
  }
  if (
    typeof candidate.rawToken !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/u.test(candidate.rawToken) ||
    typeof candidate.tokenSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(candidate.tokenSha256) ||
    sha256(candidate.rawToken) !== candidate.tokenSha256 ||
    (candidate.offerId !== null && typeof candidate.offerId !== "string")
  ) {
    throw new Error("ticket_store_secret_invalid");
  }
}

function assertBundle(value: unknown, active: boolean): void {
  if (!value || typeof value !== "object") throw new Error("ticket_store_bundle_invalid");
  const candidate = value as Record<string, unknown>;
  const keys = [
    "activationMode",
    "bundleId",
    "capture",
    "control",
    "expectedHeadSessionId",
    "expectedLineageId",
    "generation",
    "registerIdempotencyKey",
    "runId",
    ...(active ? ["binding", "observedAt", "serverNow", "session"] : []),
  ];
  if (sortedKeys(candidate) !== expectedKeys(keys)) {
    throw new Error("ticket_store_bundle_unknown_fields");
  }
  assertSecret(candidate.control);
  assertSecret(candidate.capture);
  if (
    !Number.isInteger(candidate.generation) ||
    Number(candidate.generation) < 1 ||
    typeof candidate.bundleId !== "string" ||
    typeof candidate.runId !== "string" ||
    !["FIRST_LINEAGE", "CURRENT_HEAD_REPLACEMENT"].includes(String(candidate.activationMode)) ||
    (candidate.expectedLineageId !== null && typeof candidate.expectedLineageId !== "string") ||
    (candidate.expectedHeadSessionId !== null &&
      typeof candidate.expectedHeadSessionId !== "string") ||
    typeof candidate.registerIdempotencyKey !== "string"
  ) {
    throw new Error("ticket_store_bundle_invalid");
  }
  if (active) {
    if (
      (candidate.control as HookTicketSecret).offerId === null ||
      (candidate.capture as HookTicketSecret).offerId === null ||
      !candidate.binding ||
      typeof candidate.binding !== "object" ||
      !candidate.session ||
      typeof candidate.session !== "object" ||
      !isIsoDate(candidate.serverNow) ||
      !isIsoDate(candidate.observedAt)
    ) {
      throw new Error("ticket_store_active_bundle_invalid");
    }
    const binding = SessionTicketBindingSchema.parse(candidate.binding);
    const session = AgentSessionSchema.strict().parse(candidate.session);
    if (
      binding.bundleId !== candidate.bundleId ||
      binding.runId !== candidate.runId ||
      binding.purposes.length !== 2 ||
      binding.purposes.find((purpose) => purpose.purpose === "CONTROL")?.id !==
        (candidate.control as HookTicketSecret).offerId ||
      binding.purposes.find((purpose) => purpose.purpose === "CAPTURE")?.id !==
        (candidate.capture as HookTicketSecret).offerId ||
      session.id !== binding.hubSessionId ||
      session.projectId !== binding.projectId ||
      session.agentId !== binding.agentId ||
      Date.parse(binding.expiresAt) <= Date.parse(String(candidate.serverNow))
    ) {
      throw new Error("ticket_store_active_binding_mismatch");
    }
  }
}

function parseRecord(serialized: string): HookSessionTicketRecord {
  if (Buffer.byteLength(serialized, "utf8") > MAX_RECORD_BYTES) {
    throw new Error("ticket_store_integrity_record_too_large");
  }
  let envelope: Record<string, unknown>;
  try {
    envelope = JSON.parse(serialized) as Record<string, unknown>;
  } catch {
    throw new Error("ticket_store_integrity_invalid_json");
  }
  if (sortedKeys(envelope) !== expectedKeys(ENVELOPE_KEYS) || envelope.version !== 1) {
    throw new Error("ticket_store_integrity_invalid_envelope");
  }
  const payloadSerialized = JSON.stringify(envelope.payload);
  if (
    typeof envelope.payloadSha256 !== "string" ||
    sha256(payloadSerialized) !== envelope.payloadSha256
  ) {
    throw new Error("ticket_store_integrity_sha256_mismatch");
  }
  if (!envelope.payload || typeof envelope.payload !== "object") {
    throw new Error("ticket_store_integrity_payload_invalid");
  }
  const record = envelope.payload as Record<string, unknown>;
  if (sortedKeys(record) !== expectedKeys(RECORD_KEYS)) {
    throw new Error("ticket_store_integrity_payload_unknown_fields");
  }
  assertIdentity(record.identity);
  if (
    record.schemaVersion !== 1 ||
    !Number.isInteger(record.revision) ||
    Number(record.revision) < 1 ||
    !["ENROLLING", "ACTIVE", "REPLACING", "DRAINING", "CLOSING"].includes(String(record.state)) ||
    typeof record.closeIdempotencyKey !== "string" ||
    !isIsoDate(record.createdAt) ||
    !isIsoDate(record.updatedAt)
  ) {
    throw new Error("ticket_store_integrity_payload_invalid");
  }
  if (record.active !== null) assertBundle(record.active, true);
  if (record.pending !== null) assertBundle(record.pending, false);
  if (record.active === null && record.pending === null) {
    throw new Error("ticket_store_integrity_empty_record");
  }
  const stateShapeValid =
    (record.state === "ENROLLING" && record.active === null && record.pending !== null) ||
    (record.state === "ACTIVE" && record.active !== null && record.pending === null) ||
    (record.state === "REPLACING" && record.active !== null && record.pending !== null) ||
    (record.state === "DRAINING" && record.active !== null && record.pending === null) ||
    (record.state === "CLOSING" && record.active !== null && record.pending === null);
  if (!stateShapeValid) throw new Error("ticket_store_integrity_state_shape_mismatch");
  const parsedRecord = record as unknown as HookSessionTicketRecord;
  if (parsedRecord.active) {
    const binding = SessionTicketBindingSchema.parse(parsedRecord.active.binding);
    if (
      binding.projectId !== record.identity.projectId ||
      binding.agentId !== record.identity.agentId ||
      binding.adapterClient !== record.identity.adapterClient ||
      parsedRecord.active.session.client !== record.identity.sessionClient ||
      parsedRecord.active.session.externalSessionId !== record.identity.externalSessionId ||
      parsedRecord.active.session.externalThreadId !== record.identity.externalThreadId
    ) {
      throw new Error("ticket_store_active_identity_mismatch");
    }
  }
  return parsedRecord;
}

function identityCanonical(identity: HookTicketSessionIdentity): string {
  return JSON.stringify({
    adapterClient: identity.adapterClient,
    agentId: identity.agentId,
    externalSessionId: identity.externalSessionId,
    externalThreadId: identity.externalThreadId,
    projectId: identity.projectId,
    sessionClient: identity.sessionClient,
  });
}

function sameIdentity(left: HookTicketSessionIdentity, right: HookTicketSessionIdentity): boolean {
  return identityCanonical(left) === identityCanonical(right);
}

function fsyncDirectory(path: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, "r");
    fsyncSync(descriptor);
  } catch (error) {
    if (
      process.platform !== "win32" ||
      !(
        error instanceof Error &&
        "code" in error &&
        ["EINVAL", "EISDIR", "EPERM"].includes(String(error.code))
      )
    ) {
      throw error;
    }
    // Node cannot portably FlushFileBuffers on a Windows directory handle. The file itself was
    // flushed and the same-directory rename remains atomic, but power-loss durability is weaker.
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function unlinkIfExists(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}

function privateAtomicWrite(path: string, serialized: string): void {
  const temporary = `${path}.tmp`;
  let descriptor: number | undefined;
  try {
    // The identity lock proves no live writer owns this fixed temp. A remnant therefore predates
    // this transaction and must be removed before any network side effect can reference its secret.
    unlinkIfExists(temporary);
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, serialized, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    try {
      chmodSync(temporary, 0o600);
    } catch {
      // Windows privacy is supplied by the store root DACL, not POSIX mode emulation.
    }
    renameSync(temporary, path);
    fsyncDirectory(dirname(path));
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkIfExists(temporary);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "ticket_store_private_write_and_cleanup_failed",
      );
    }
    throw error;
  }
}

function nextBundleIdentity(identity: HookTicketSessionIdentity, generation: number) {
  const digest = sha256(`${identityCanonical(identity)}\u0000${generation}`);
  return {
    bundleId: `stb_${digest.slice(0, 48)}`,
    runId: `run_${digest.slice(0, 48)}`,
    registerIdempotencyKey: `hook-register:v1:${digest}`,
  };
}

export function createInitialTicketRecord(
  identity: HookTicketSessionIdentity,
  input: { controlToken: string; captureToken: string; now: string },
): HookSessionTicketRecord {
  assertIdentity(identity);
  const ids = nextBundleIdentity(identity, 1);
  const digest = sha256(identityCanonical(identity));
  return {
    schemaVersion: 1,
    revision: 1,
    identity: { ...identity },
    state: "ENROLLING",
    active: null,
    pending: {
      generation: 1,
      ...ids,
      activationMode: "FIRST_LINEAGE",
      expectedLineageId: null,
      expectedHeadSessionId: null,
      control: {
        rawToken: input.controlToken,
        tokenSha256: sha256(input.controlToken),
        offerId: null,
      },
      capture: {
        rawToken: input.captureToken,
        tokenSha256: sha256(input.captureToken),
        offerId: null,
      },
    },
    closeIdempotencyKey: `hook-close:v1:${digest}`,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

export function nextTicketRecord(
  current: HookSessionTicketRecord,
  patch: Omit<Partial<HookSessionTicketRecord>, "identity" | "revision" | "schemaVersion">,
  now = new Date().toISOString(),
): HookSessionTicketRecord {
  return {
    ...current,
    ...patch,
    schemaVersion: 1,
    revision: current.revision + 1,
    identity: current.identity,
    updatedAt: now,
  };
}

export function createReplacementPendingBundle(
  record: HookSessionTicketRecord,
  input: { controlToken: string; captureToken: string },
): HookPendingTicketBundle {
  if (!record.active) throw new Error("ticket_store_replacement_requires_active_bundle");
  const generation = record.active.generation + 1;
  const ids = nextBundleIdentity(record.identity, generation);
  return {
    generation,
    ...ids,
    activationMode: "CURRENT_HEAD_REPLACEMENT",
    expectedLineageId: record.active.binding.lineageId,
    expectedHeadSessionId: record.active.binding.hubSessionId,
    control: {
      rawToken: input.controlToken,
      tokenSha256: sha256(input.controlToken),
      offerId: null,
    },
    capture: {
      rawToken: input.captureToken,
      tokenSha256: sha256(input.captureToken),
      offerId: null,
    },
  };
}

export class HookSessionTicketStore {
  readonly directory: string;
  private readonly lockWaitMs: number;

  constructor(options: {
    directory: string;
    lockWaitMs?: number;
    /** Kept only for test-call compatibility; tombstones are always retained and secret-free. */
    retainDeleteTombstone?: boolean;
  }) {
    this.directory = resolve(options.directory);
    this.lockWaitMs = options.lockWaitMs ?? 5_000;
    if (process.platform === "win32" && this.directory.startsWith("\\\\")) {
      throw new Error("ticket_store_remote_path_unsupported");
    }
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    try {
      chmodSync(this.directory, 0o700);
    } catch {
      // The Windows-specific installer is responsible for the actual private DACL.
    }
  }

  identityDigest(identity: HookTicketSessionIdentity): string {
    assertIdentity(identity);
    return sha256(identityCanonical(identity));
  }

  bundlePath(identity: HookTicketSessionIdentity): string {
    return resolve(this.directory, `${this.identityDigest(identity)}.bundle.json`);
  }

  private tombstonePath(identity: HookTicketSessionIdentity): string {
    return resolve(this.directory, `${this.identityDigest(identity)}.deleted.json`);
  }

  private lockPath(identity: HookTicketSessionIdentity): string {
    return resolve(this.directory, `${this.identityDigest(identity)}.lock`);
  }

  async read(identity: HookTicketSessionIdentity): Promise<HookSessionTicketRecord | null> {
    return await withDurableFileLock(this.lockPath(identity), () => this.readUnlocked(identity), {
      waitMs: this.lockWaitMs,
      errorPrefix: "ticket_store",
    });
  }

  private readUnlocked(identity: HookTicketSessionIdentity): HookSessionTicketRecord | null {
    const path = this.bundlePath(identity);
    const tombstonePath = this.tombstonePath(identity);
    if (!existsSync(path)) return null;
    if (statSync(path).size > MAX_RECORD_BYTES) {
      throw new Error("ticket_store_integrity_record_too_large");
    }
    const record = parseRecord(readFileSync(path, "utf8"));
    if (!sameIdentity(record.identity, identity)) {
      throw new Error("ticket_store_integrity_identity_mismatch");
    }
    if (existsSync(tombstonePath)) {
      let tombstone: Record<string, unknown>;
      try {
        tombstone = JSON.parse(readFileSync(tombstonePath, "utf8")) as Record<string, unknown>;
      } catch {
        throw new Error("ticket_store_integrity_tombstone_invalid");
      }
      const currentBundles = [record.active, record.pending].filter(
        (bundle): bundle is HookActiveTicketBundle | HookPendingTicketBundle => bundle !== null,
      );
      const matched = currentBundles.some(
        (bundle) =>
          bundle.bundleId === tombstone.bundleId && bundle.generation === tombstone.generation,
      );
      if (matched) {
        unlinkSync(path);
        fsyncDirectory(this.directory);
        return null;
      }
      const terminalGeneration = Number(tombstone.generation);
      if (
        !Number.isInteger(terminalGeneration) ||
        currentBundles.every((bundle) => bundle.generation <= terminalGeneration)
      ) {
        throw new Error("ticket_store_integrity_tombstone_generation_conflict");
      }
      // A newer, exact generation is legitimate (same-identity replacement). The older terminal
      // receipt remains provenance but cannot delete the successor bundle.
    }
    return record;
  }

  async withRecord<T>(
    identity: HookTicketSessionIdentity,
    action: (transaction: HookSessionTicketTransaction) => Promise<T> | T,
  ): Promise<T> {
    return await withDurableFileLock(
      this.lockPath(identity),
      async () => {
        let current = this.readUnlocked(identity);
        if (!current && existsSync(this.tombstonePath(identity))) {
          // A terminal external identity cannot silently restart at generation 1. Doing so would
          // collide with the retained deletion proof and could make a later read erase a freshly
          // enrolled bundle. A new host identity or an explicit recovery flow is required.
          throw new Error("ticket_store_terminal_identity_reuse_forbidden");
        }
        const transaction: HookSessionTicketTransaction = {
          get current() {
            return current;
          },
          save: (record) => {
            if (!sameIdentity(record.identity, identity)) {
              throw new Error("ticket_store_save_identity_mismatch");
            }
            const expectedRevision = current ? current.revision + 1 : 1;
            if (record.revision !== expectedRevision) {
              throw new Error("ticket_store_revision_conflict");
            }
            const payload = JSON.stringify(record);
            const envelope: StoredEnvelope = {
              version: 1,
              payload: record,
              payloadSha256: sha256(payload),
            };
            const serialized = `${JSON.stringify(envelope)}\n`;
            if (Buffer.byteLength(serialized, "utf8") > MAX_RECORD_BYTES) {
              throw new Error("ticket_store_record_too_large");
            }
            parseRecord(serialized);
            privateAtomicWrite(this.bundlePath(identity), serialized);
            current = record;
          },
          remove: (receipt) => {
            if (!current?.active) throw new Error("ticket_store_remove_requires_active_bundle");
            if (
              receipt.bundleId !== current.active.bundleId ||
              receipt.hubSessionId !== current.active.binding.hubSessionId ||
              !["REVOKED", "EXPIRED", "SUPERSEDED"].includes(receipt.state) ||
              !isIsoDate(receipt.terminalAt)
            ) {
              throw new Error("ticket_store_terminal_receipt_mismatch");
            }
            const tombstone = {
              version: 1,
              identitySha256: this.identityDigest(identity),
              generation: current.active.generation,
              bundleId: receipt.bundleId,
              hubSessionId: receipt.hubSessionId,
              state: receipt.state,
              terminalAt: receipt.terminalAt,
            };
            privateAtomicWrite(this.tombstonePath(identity), `${JSON.stringify(tombstone)}\n`);
            try {
              unlinkSync(this.bundlePath(identity));
              fsyncDirectory(this.directory);
            } catch (error) {
              if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
                throw error;
              }
            }
            current = null;
          },
        };
        return await action(transaction);
      },
      { waitMs: this.lockWaitMs, errorPrefix: "ticket_store" },
    );
  }
}
