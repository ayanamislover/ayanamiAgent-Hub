import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

export type SurfaceJournalStage = "BEGIN_ONLY" | "PREPARED";

export type SurfaceJournalEntry = {
  version: 1;
  projectId: string;
  sessionId: string;
  messageId: string;
  beginIdempotencyKey: string;
  surfaceAttemptId: string | null;
  recipientFence: number | null;
  sessionIncarnation: number | null;
  stage: SurfaceJournalStage;
  updatedAt: string;
};

export type SurfaceJournalIdentity = Pick<
  SurfaceJournalEntry,
  "projectId" | "sessionId" | "messageId"
>;

const ENTRY_KEYS = [
  "beginIdempotencyKey",
  "messageId",
  "projectId",
  "recipientFence",
  "sessionId",
  "sessionIncarnation",
  "stage",
  "surfaceAttemptId",
  "updatedAt",
  "version",
] as const;
const DEFAULT_MAX_FILES = 256;
const MAX_ENTRY_BYTES = 4_096;
const MAX_LEASE_BYTES = 2_048;
const MAX_LOCK_BYTES = 1_024;
const LOCK_WAIT_MS = 1_000;
const LOCK_STALE_MS = 10_000;
const DEFAULT_LEASE_TTL_MS = 60_000;

type FilesystemLock = {
  version: 1;
  ownerToken: string;
  pid: number;
  acquiredAt: string;
};

const LOCK_KEYS = ["acquiredAt", "ownerToken", "pid", "version"] as const;

export type SurfaceInvocationLease = {
  version: 1;
  projectId: string;
  sessionId: string;
  messageId: string;
  ownerToken: string;
  acquiredAt: string;
  renewedAt: string;
  expiresAt: string;
};

const LEASE_KEYS = [
  "acquiredAt",
  "expiresAt",
  "messageId",
  "ownerToken",
  "projectId",
  "renewedAt",
  "sessionId",
  "version",
] as const;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function identityDigest(identity: SurfaceJournalIdentity): string {
  return sha256(`${identity.projectId}\u0000${identity.sessionId}\u0000${identity.messageId}`);
}

function isFsError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function validateId(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.length < 4 || value.length > 160) {
    throw new Error(`surface_journal_invalid_${field}`);
  }
}

function parseEntry(serialized: string): SurfaceJournalEntry {
  if (Buffer.byteLength(serialized, "utf8") > MAX_ENTRY_BYTES) {
    throw new Error("surface_journal_entry_too_large");
  }
  const candidate = JSON.parse(serialized) as Record<string, unknown>;
  const keys = Object.keys(candidate).sort();
  if (keys.join("\u0000") !== [...ENTRY_KEYS].sort().join("\u0000")) {
    throw new Error("surface_journal_unknown_fields");
  }
  if (candidate.version !== 1) throw new Error("surface_journal_invalid_version");
  validateId(candidate.projectId, "project_id");
  validateId(candidate.sessionId, "session_id");
  validateId(candidate.messageId, "message_id");
  if (
    typeof candidate.beginIdempotencyKey !== "string" ||
    candidate.beginIdempotencyKey.length < 1 ||
    candidate.beginIdempotencyKey.length > 300
  ) {
    throw new Error("surface_journal_invalid_begin_key");
  }
  const hasAttempt = candidate.surfaceAttemptId !== null;
  if (hasAttempt) validateId(candidate.surfaceAttemptId, "surface_attempt_id");
  if (
    (candidate.recipientFence !== null &&
      (!Number.isInteger(candidate.recipientFence) || Number(candidate.recipientFence) <= 0)) ||
    (candidate.sessionIncarnation !== null &&
      (!Number.isInteger(candidate.sessionIncarnation) ||
        Number(candidate.sessionIncarnation) < 0)) ||
    hasAttempt !== (candidate.recipientFence !== null) ||
    hasAttempt !== (candidate.sessionIncarnation !== null)
  ) {
    throw new Error("surface_journal_invalid_surface_binding");
  }
  if (!(["BEGIN_ONLY", "PREPARED"] as unknown[]).includes(candidate.stage)) {
    throw new Error("surface_journal_invalid_stage");
  }
  if (candidate.stage === "PREPARED" && !hasAttempt) {
    throw new Error("surface_journal_prepared_without_surface");
  }
  if (typeof candidate.updatedAt !== "string" || Number.isNaN(Date.parse(candidate.updatedAt))) {
    throw new Error("surface_journal_invalid_updated_at");
  }
  return candidate as SurfaceJournalEntry;
}

function parseLease(serialized: string): SurfaceInvocationLease {
  if (Buffer.byteLength(serialized, "utf8") > MAX_LEASE_BYTES) {
    throw new Error("surface_invocation_lease_too_large");
  }
  const candidate = JSON.parse(serialized) as Record<string, unknown>;
  if (Object.keys(candidate).sort().join("\u0000") !== [...LEASE_KEYS].sort().join("\u0000")) {
    throw new Error("surface_invocation_lease_unknown_fields");
  }
  if (candidate.version !== 1) throw new Error("surface_invocation_lease_invalid_version");
  validateId(candidate.projectId, "lease_project_id");
  validateId(candidate.sessionId, "lease_session_id");
  validateId(candidate.messageId, "lease_message_id");
  if (
    typeof candidate.ownerToken !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/u.test(candidate.ownerToken)
  ) {
    throw new Error("surface_invocation_lease_invalid_owner");
  }
  for (const field of ["acquiredAt", "renewedAt", "expiresAt"] as const) {
    if (typeof candidate[field] !== "string" || Number.isNaN(Date.parse(candidate[field]))) {
      throw new Error(`surface_invocation_lease_invalid_${field}`);
    }
  }
  if (
    Date.parse(String(candidate.acquiredAt)) > Date.parse(String(candidate.renewedAt)) ||
    Date.parse(String(candidate.renewedAt)) >= Date.parse(String(candidate.expiresAt))
  ) {
    throw new Error("surface_invocation_lease_invalid_timeline");
  }
  return candidate as SurfaceInvocationLease;
}

function parseLock(serialized: string): FilesystemLock {
  if (Buffer.byteLength(serialized, "utf8") > MAX_LOCK_BYTES) {
    throw new Error("surface_filesystem_lock_too_large");
  }
  const candidate = JSON.parse(serialized) as Record<string, unknown>;
  if (Object.keys(candidate).sort().join("\u0000") !== [...LOCK_KEYS].sort().join("\u0000")) {
    throw new Error("surface_filesystem_lock_unknown_fields");
  }
  if (
    candidate.version !== 1 ||
    typeof candidate.ownerToken !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/u.test(candidate.ownerToken) ||
    !Number.isInteger(candidate.pid) ||
    Number(candidate.pid) <= 0 ||
    typeof candidate.acquiredAt !== "string" ||
    Number.isNaN(Date.parse(candidate.acquiredAt))
  ) {
    throw new Error("surface_filesystem_lock_invalid");
  }
  return candidate as FilesystemLock;
}

function atomicWrite(path: string, entry: SurfaceJournalEntry): void {
  const serialized = `${JSON.stringify(entry)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_ENTRY_BYTES) {
    throw new Error("surface_journal_entry_too_large");
  }
  const temporary = `${path}.${process.pid}-${randomBytes(4).toString("hex")}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, serialized, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    try {
      chmodSync(temporary, 0o600);
    } catch {
      // Windows inherits ACLs from the current user's local data directory.
    }
    renameSync(temporary, path);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    throw error;
  }
}

function atomicWriteLease(path: string, lease: SurfaceInvocationLease): void {
  const serialized = `${JSON.stringify(lease)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_LEASE_BYTES) {
    throw new Error("surface_invocation_lease_too_large");
  }
  const temporary = `${path}.${process.pid}-${randomBytes(4).toString("hex")}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, serialized, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    try {
      chmodSync(temporary, 0o600);
    } catch {
      // Windows inherits ACLs from the current user's local data directory.
    }
    renameSync(temporary, path);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    throw error;
  }
}

function writeNewLease(path: string, lease: SurfaceInvocationLease): void {
  const serialized = `${JSON.stringify(lease)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_LEASE_BYTES) {
    throw new Error("surface_invocation_lease_too_large");
  }
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, "wx", 0o600);
    writeFileSync(descriptor, serialized, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    try {
      chmodSync(path, 0o600);
    } catch {
      // Windows inherits ACLs from the current user's local data directory.
    }
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    throw error;
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isFsError(error, "ESRCH");
  }
}

function createFilesystemLock(path: string): FilesystemLock {
  const lock: FilesystemLock = {
    version: 1,
    ownerToken: randomBytes(32).toString("base64url"),
    pid: process.pid,
    acquiredAt: new Date(Date.now()).toISOString(),
  };
  const serialized = `${JSON.stringify(lock)}\n`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, "wx", 0o600);
    writeFileSync(descriptor, serialized, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    try {
      chmodSync(path, 0o600);
    } catch {
      // Windows inherits ACLs from the current user's local data directory.
    }
    return lock;
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    throw error;
  }
}

function releaseFilesystemLock(path: string, owner: FilesystemLock): void {
  let current: FilesystemLock;
  try {
    current = parseLock(readFileSync(path, "utf8"));
  } catch (error) {
    if (isFsError(error, "ENOENT")) return;
    throw error;
  }
  if (current.ownerToken !== owner.ownerToken) return;
  try {
    unlinkSync(path);
  } catch (error) {
    if (!isFsError(error, "ENOENT")) throw error;
  }
}

function finishAbandonedReap(path: string): boolean {
  const reapPath = `${path}.reap`;
  let reaped: FilesystemLock;
  try {
    reaped = parseLock(readFileSync(reapPath, "utf8"));
  } catch {
    return false;
  }
  if (processIsAlive(reaped.pid)) return false;
  try {
    const current = parseLock(readFileSync(path, "utf8"));
    if (current.ownerToken === reaped.ownerToken) unlinkSync(path);
  } catch (error) {
    if (!isFsError(error, "ENOENT")) return false;
  }
  try {
    unlinkSync(reapPath);
  } catch (error) {
    if (!isFsError(error, "ENOENT")) throw error;
  }
  return true;
}

function reapAbandonedLock(path: string, observed: FilesystemLock): boolean {
  const reapPath = `${path}.reap`;
  try {
    // A fixed hard-link tombstone is the atomic stale-reaper claim. Contenders cannot replace it,
    // and acquisition remains blocked until the captured generation is checked and released.
    linkSync(path, reapPath);
  } catch (error) {
    if (isFsError(error, "EEXIST")) return finishAbandonedReap(path);
    if (isFsError(error, "ENOENT")) return true;
    throw error;
  }
  let captured: FilesystemLock;
  try {
    captured = parseLock(readFileSync(reapPath, "utf8"));
  } catch {
    return false;
  }
  if (captured.ownerToken !== observed.ownerToken || processIsAlive(captured.pid)) {
    try {
      unlinkSync(reapPath);
    } catch (error) {
      if (!isFsError(error, "ENOENT")) throw error;
    }
    return false;
  }
  return finishAbandonedReap(path);
}

async function withFilesystemLock<T>(path: string, action: () => Promise<T> | T): Promise<T> {
  mkdirSync(dirname(path), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (true) {
    if (existsSync(`${path}.reap`)) {
      if (finishAbandonedReap(path)) continue;
      if (Date.now() >= deadline) throw new Error("surface_journal_lock_timeout");
      await sleep(10);
      continue;
    }
    let owner: FilesystemLock | undefined;
    try {
      owner = createFilesystemLock(path);
      try {
        return await action();
      } finally {
        releaseFilesystemLock(path, owner);
      }
    } catch (error) {
      if (owner) throw error;
      if (!isFsError(error, "EEXIST")) throw error;
      try {
        const stale = Date.now() - statSync(path).mtimeMs > LOCK_STALE_MS;
        if (stale) {
          let observed: FilesystemLock | undefined;
          try {
            observed = parseLock(readFileSync(path, "utf8"));
          } catch {
            // A malformed lock is fail-closed; explicit operator recovery is safer than guessing.
          }
          if (observed && !processIsAlive(observed.pid) && reapAbandonedLock(path, observed)) {
            continue;
          }
        }
      } catch (statError) {
        if (!isFsError(statError, "ENOENT")) throw statError;
        continue;
      }
      if (Date.now() >= deadline) throw new Error("surface_journal_lock_timeout");
      await sleep(10);
    }
  }
}

async function withIdentityLock<T>(
  directory: string,
  identity: SurfaceJournalIdentity,
  action: () => Promise<T> | T,
): Promise<T> {
  const lockPath = resolve(directory, `${identityDigest(identity)}.lock`);
  return await withFilesystemLock(lockPath, action);
}

export class SurfaceInvocationLeaseManager {
  readonly directory: string;
  private readonly leaseTtlMs: number;
  private readonly maxLeases: number;

  constructor(options: { directory: string; leaseTtlMs?: number; maxLeases?: number }) {
    this.directory = resolve(options.directory);
    this.leaseTtlMs = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
    this.maxLeases = options.maxLeases ?? DEFAULT_MAX_FILES;
    if (!Number.isFinite(this.leaseTtlMs) || this.leaseTtlMs <= 0) {
      throw new Error("surface_invocation_lease_invalid_ttl");
    }
    if (!Number.isInteger(this.maxLeases) || this.maxLeases < 1) {
      throw new Error("surface_invocation_lease_invalid_capacity");
    }
  }

  private path(identity: SurfaceJournalIdentity): string {
    return resolve(this.directory, `${identityDigest(identity)}.lease`);
  }

  private assertIdentity(lease: SurfaceInvocationLease, identity: SurfaceJournalIdentity): void {
    if (
      lease.projectId !== identity.projectId ||
      lease.sessionId !== identity.sessionId ||
      lease.messageId !== identity.messageId
    ) {
      throw new Error("surface_invocation_lease_identity_mismatch");
    }
  }

  private quarantine(path: string): string {
    const blocked = `${path}.${Date.now()}-${randomBytes(3).toString("hex")}.corrupt`;
    try {
      renameSync(path, blocked);
    } catch (error) {
      if (!isFsError(error, "ENOENT")) throw error;
    }
    return blocked;
  }

  private read(path: string): SurfaceInvocationLease | undefined {
    if (!existsSync(path)) return undefined;
    return parseLease(readFileSync(path, "utf8"));
  }

  private capacityLockPath(): string {
    return resolve(this.directory, ".surface-invocation-capacity.lock");
  }

  private async pruneExpiredLeases(now: number): Promise<void> {
    if (!existsSync(this.directory)) return;
    const leaseNames = readdirSync(this.directory).filter((name) => name.endsWith(".lease"));
    for (const name of leaseNames) {
      const path = resolve(this.directory, name);
      let observed: SurfaceInvocationLease;
      try {
        observed = parseLease(readFileSync(path, "utf8"));
      } catch {
        // A corrupt lease consumes capacity and requires explicit recovery; never guess its owner.
        continue;
      }
      if (this.path(observed) !== path || Date.parse(observed.expiresAt) > now) {
        continue;
      }
      await withIdentityLock(this.directory, observed, () => {
        let current: SurfaceInvocationLease;
        try {
          current = parseLease(readFileSync(path, "utf8"));
        } catch (error) {
          if (isFsError(error, "ENOENT")) return;
          return;
        }
        if (
          current.ownerToken === observed.ownerToken &&
          this.path(current) === path &&
          Date.parse(current.expiresAt) <= Date.now()
        ) {
          unlinkSync(path);
        }
      });
    }
  }

  async tryAcquire(identity: SurfaceJournalIdentity): Promise<SurfaceInvocationLease | null> {
    return await withFilesystemLock(this.capacityLockPath(), async () => {
      const now = Date.now();
      await this.pruneExpiredLeases(now);
      return await withIdentityLock(this.directory, identity, () => {
        const path = this.path(identity);
        let existing: SurfaceInvocationLease | undefined;
        if (existsSync(path)) {
          try {
            existing = this.read(path);
            if (existing) this.assertIdentity(existing, identity);
          } catch {
            this.quarantine(path);
            throw new Error("surface_invocation_lease_corrupt");
          }
        }
        if (existing && Date.parse(existing.expiresAt) > Date.now()) return null;
        if (existing) unlinkSync(path);
        const blockedPrefix = `${identityDigest(identity)}.lease.`;
        if (
          readdirSync(this.directory).some(
            (name) => name.startsWith(blockedPrefix) && name.endsWith(".corrupt"),
          )
        ) {
          throw new Error("surface_invocation_lease_corrupt");
        }
        const retained = readdirSync(this.directory).filter(
          (name) =>
            name.endsWith(".lease") || (name.includes(".lease.") && name.endsWith(".corrupt")),
        );
        if (retained.length >= this.maxLeases) throw new Error("surface_invocation_lease_full");
        const ownerToken = randomBytes(32).toString("base64url");
        const acquiredAt = new Date(Date.now()).toISOString();
        const lease: SurfaceInvocationLease = {
          version: 1,
          ...identity,
          ownerToken,
          acquiredAt,
          renewedAt: acquiredAt,
          expiresAt: new Date(Date.now() + this.leaseTtlMs).toISOString(),
        };
        writeNewLease(path, lease);
        return lease;
      });
    });
  }

  async assertOwner(lease: SurfaceInvocationLease): Promise<void> {
    await withIdentityLock(this.directory, lease, () => {
      const current = this.read(this.path(lease));
      if (!current) throw new Error("surface_invocation_lease_missing");
      this.assertIdentity(current, lease);
      if (current.ownerToken !== lease.ownerToken) {
        throw new Error("surface_invocation_lease_owner_mismatch");
      }
      if (Date.parse(current.expiresAt) <= Date.now()) {
        throw new Error("surface_invocation_lease_expired");
      }
    });
  }

  async isOwner(lease: SurfaceInvocationLease): Promise<boolean> {
    try {
      await this.assertOwner(lease);
      return true;
    } catch {
      return false;
    }
  }

  async renew(lease: SurfaceInvocationLease): Promise<SurfaceInvocationLease> {
    return await withIdentityLock(this.directory, lease, () => {
      const path = this.path(lease);
      const current = this.read(path);
      if (!current) throw new Error("surface_invocation_lease_missing");
      this.assertIdentity(current, lease);
      if (current.ownerToken !== lease.ownerToken) {
        throw new Error("surface_invocation_lease_owner_mismatch");
      }
      if (Date.parse(current.expiresAt) <= Date.now()) {
        throw new Error("surface_invocation_lease_expired");
      }
      const now = Date.now();
      const updated = {
        ...current,
        renewedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + this.leaseTtlMs).toISOString(),
      };
      atomicWriteLease(path, updated);
      return updated;
    });
  }

  async release(lease: SurfaceInvocationLease): Promise<void> {
    await withIdentityLock(this.directory, lease, () => {
      const path = this.path(lease);
      const current = this.read(path);
      if (!current) throw new Error("surface_invocation_lease_missing");
      this.assertIdentity(current, lease);
      if (current.ownerToken !== lease.ownerToken) {
        throw new Error("surface_invocation_lease_owner_mismatch");
      }
      unlinkSync(path);
    });
  }
}

export class SurfaceDeliveryJournal {
  readonly directory: string;
  private readonly maxFiles: number;
  private readonly now: () => number;

  constructor(options: { directory: string; maxFiles?: number; now?: () => number }) {
    this.directory = resolve(options.directory);
    this.maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
    this.now = options.now ?? Date.now;
    if (!Number.isInteger(this.maxFiles) || this.maxFiles < 1) {
      throw new Error("surface_journal_invalid_capacity");
    }
  }

  private path(identity: SurfaceJournalIdentity): string {
    return resolve(this.directory, `${identityDigest(identity)}.json`);
  }

  private capacityLockPath(): string {
    return resolve(this.directory, ".surface-journal-capacity.lock");
  }

  private async withLock<T>(identity: SurfaceJournalIdentity, action: () => T): Promise<T> {
    return await withIdentityLock(this.directory, identity, action);
  }

  private quarantine(path: string): never {
    const blocked = `${path}.${this.now()}-${randomBytes(3).toString("hex")}.corrupt`;
    try {
      renameSync(path, blocked);
    } catch (error) {
      if (!isFsError(error, "ENOENT")) throw error;
    }
    throw new Error("surface_journal_corrupt");
  }

  private readPath(path: string): SurfaceJournalEntry | undefined {
    if (!existsSync(path)) return undefined;
    try {
      return parseEntry(readFileSync(path, "utf8"));
    } catch {
      return this.quarantine(path);
    }
  }

  private assertIdentity(
    entry: SurfaceJournalEntry,
    identity: SurfaceJournalIdentity,
    path: string,
  ): void {
    if (
      entry.projectId !== identity.projectId ||
      entry.sessionId !== identity.sessionId ||
      entry.messageId !== identity.messageId
    ) {
      this.quarantine(path);
    }
  }

  private assertArtifactCapacity(): void {
    const artifacts = readdirSync(this.directory).filter((name) => !name.endsWith(".lock"));
    if (artifacts.length >= this.maxFiles * 2 + 16) {
      throw new Error("surface_journal_artifact_limit");
    }
  }

  private prune(): void {
    if (!existsSync(this.directory)) return;
    const files = readdirSync(this.directory)
      .filter((name) => name.endsWith(".tmp"))
      .map((name) => {
        const path = resolve(this.directory, name);
        try {
          return { path, name, mtimeMs: statSync(path).mtimeMs };
        } catch (error) {
          if (isFsError(error, "ENOENT")) return null;
          throw error;
        }
      })
      .filter((entry): entry is { path: string; name: string; mtimeMs: number } => entry !== null)
      .sort((left, right) => left.mtimeMs - right.mtimeMs);
    for (const entry of files.filter((file) => file.mtimeMs < this.now() - LOCK_STALE_MS)) {
      try {
        unlinkSync(entry.path);
      } catch (error) {
        if (!isFsError(error, "ENOENT")) throw error;
      }
    }
  }

  async getOrCreate(
    identity: SurfaceJournalIdentity,
    beginIdempotencyKey: string,
  ): Promise<SurfaceJournalEntry> {
    return await withFilesystemLock(this.capacityLockPath(), async () => {
      return await this.withLock(identity, () => {
        this.prune();
        const path = this.path(identity);
        const existing = this.readPath(path);
        if (existing) {
          this.assertIdentity(existing, identity, path);
          return existing;
        }
        const blockedPrefix = `${identityDigest(identity)}.json.`;
        if (
          readdirSync(this.directory).some(
            (name) => name.startsWith(blockedPrefix) && name.endsWith(".corrupt"),
          )
        ) {
          throw new Error("surface_journal_corrupt");
        }
        const retained = readdirSync(this.directory).filter(
          (name) =>
            name.endsWith(".json") || (name.includes(".json.") && name.endsWith(".corrupt")),
        );
        if (retained.length >= this.maxFiles) throw new Error("surface_journal_full");
        this.assertArtifactCapacity();
        const entry: SurfaceJournalEntry = {
          version: 1,
          ...identity,
          beginIdempotencyKey,
          surfaceAttemptId: null,
          recipientFence: null,
          sessionIncarnation: null,
          stage: "BEGIN_ONLY",
          updatedAt: new Date(this.now()).toISOString(),
        };
        atomicWrite(path, entry);
        return entry;
      });
    });
  }

  async recordSurface(
    identity: SurfaceJournalIdentity,
    binding: {
      surfaceAttemptId: string;
      recipientFence: number;
      sessionIncarnation: number;
    },
  ): Promise<SurfaceJournalEntry> {
    return await this.withLock(identity, () => {
      const path = this.path(identity);
      const existing = this.readPath(path);
      if (!existing) throw new Error("surface_journal_missing");
      this.assertIdentity(existing, identity, path);
      if (
        existing.surfaceAttemptId !== null &&
        (existing.surfaceAttemptId !== binding.surfaceAttemptId ||
          existing.recipientFence !== binding.recipientFence ||
          existing.sessionIncarnation !== binding.sessionIncarnation)
      ) {
        throw new Error("surface_journal_binding_conflict");
      }
      const updated: SurfaceJournalEntry = {
        ...existing,
        ...binding,
        updatedAt: new Date(this.now()).toISOString(),
      };
      this.assertArtifactCapacity();
      atomicWrite(path, updated);
      return updated;
    });
  }

  async markPrepared(identity: SurfaceJournalIdentity): Promise<SurfaceJournalEntry> {
    return await this.withLock(identity, () => {
      const path = this.path(identity);
      const existing = this.readPath(path);
      if (!existing || existing.surfaceAttemptId === null) {
        throw new Error("surface_journal_missing_surface");
      }
      this.assertIdentity(existing, identity, path);
      const updated: SurfaceJournalEntry = {
        ...existing,
        stage: "PREPARED",
        updatedAt: new Date(this.now()).toISOString(),
      };
      this.assertArtifactCapacity();
      atomicWrite(path, updated);
      return updated;
    });
  }

  async remove(identity: SurfaceJournalIdentity): Promise<void> {
    await this.withLock(identity, () => {
      try {
        unlinkSync(this.path(identity));
      } catch (error) {
        if (!isFsError(error, "ENOENT")) throw error;
      }
    });
  }
}
