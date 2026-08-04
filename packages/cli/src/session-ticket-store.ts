import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import {
  parseCodexSessionOperationalCheckpoint,
  parseCodexSessionTicketVaultSnapshot,
  type CodexSessionOperationalCheckpoint,
  type CodexSessionTicketVault,
  type CodexSessionTicketVaultSnapshot,
  type StoredCodexSessionTicketBundle,
} from "@crossagent/codex-bridge";
import {
  SessionLaunchReservationSchema,
  type SessionLaunchReservation,
} from "@crossagent/protocol";
import { dataDir } from "./paths.js";
import { processExists } from "./process-manager.js";

const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;
const ID_PATTERN = /^(?:prj|run)_[A-Za-z0-9_-]+$/;
const RECOVERY_LOCK_ATTEMPTS = 200;
const RECOVERY_LOCK_WAIT_MS = 10;
const RECOVERY_LOCK_STALE_AFTER_MS = 30_000;
const WINDOWS_RENAME_RETRY_DELAYS_MS = [10, 20, 40, 80, 160, 320, 640] as const;

export type CodexSessionTicketVaultFileAdapters = {
  rename?: typeof renameSync;
  unlink?: typeof unlinkSync;
  platform?: NodeJS.Platform;
  wait?: (milliseconds: number) => void;
};

export type CodexSessionTicketRecoveryLockAdapters = {
  processExists?: (pid: number) => boolean;
  now?: () => number;
  attempts?: number;
  waitMs?: number;
  afterStaleOwnerRead?: (lockPath: string) => void;
  afterStaleLockTombstoned?: (lockPath: string) => void;
};

type CodexSessionTicketRecoveryRecord = {
  version: 1;
  projectId: string;
  threadId: string;
  threadSha256: string;
  runId: string;
  state: "ACTIVE" | "DRAINING";
  updatedAt: string;
};

type CodexSessionTicketCloseJournal = {
  version: 1;
  projectId: string;
  runId: string;
  state: "PREPARED" | "COMMITTED";
  vault: CodexSessionTicketVaultSnapshot;
  indexes: Array<{ name: string; record: CodexSessionTicketRecoveryRecord }>;
  checkpoint: { threadId: string; ownerRunId: string; bundleId: string } | null;
  updatedAt: string;
};

export interface CodexSessionOperationalCheckpointStore {
  load(projectId: string, threadId: string): Promise<CodexSessionOperationalCheckpoint | null>;
  save(checkpoint: CodexSessionOperationalCheckpoint): Promise<void>;
}

function assertLocalId(kind: "project" | "run", value: string): void {
  if (!ID_PATTERN.test(value) || !value.startsWith(kind === "project" ? "prj_" : "run_")) {
    throw new Error(`Invalid ${kind} id for the Codex session ticket vault`);
  }
}

export function codexSessionTicketVaultPath(
  projectId: string,
  runId: string,
  rootDir = dataDir,
): string {
  assertLocalId("project", projectId);
  assertLocalId("run", runId);
  return resolve(rootDir, "session-tickets", projectId, `${runId}.json`);
}

function projectTicketDirectory(projectId: string, rootDir: string): string {
  assertLocalId("project", projectId);
  return resolve(rootDir, "session-tickets", projectId);
}

function threadDigest(threadId: string): string {
  if (!threadId) throw new Error("Invalid thread id for Codex ticket recovery");
  return createHash("sha256").update(threadId, "utf8").digest("hex");
}

export function codexSessionTicketRecoveryIndexPath(
  projectId: string,
  threadId: string,
  rootDir = dataDir,
): string {
  return resolve(
    projectTicketDirectory(projectId, rootDir),
    "thread-index",
    `${threadDigest(threadId)}.json`,
  );
}

export function codexSessionTicketRecoveryLockPath(projectId: string, rootDir = dataDir): string {
  return resolve(projectTicketDirectory(projectId, rootDir), ".recovery-index.lock");
}

export function codexSessionOperationalCheckpointPath(
  projectId: string,
  threadId: string,
  rootDir = dataDir,
): string {
  return resolve(
    projectTicketDirectory(projectId, rootDir),
    "operational-checkpoints",
    `${threadDigest(threadId)}.json`,
  );
}

function codexSessionTicketCloseJournalDirectory(projectId: string, rootDir: string): string {
  return resolve(projectTicketDirectory(projectId, rootDir), "close-journal");
}

function codexSessionTicketCloseJournalPath(
  projectId: string,
  runId: string,
  rootDir: string,
): string {
  assertLocalId("run", runId);
  return resolve(codexSessionTicketCloseJournalDirectory(projectId, rootDir), `${runId}.json`);
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  chmodSync(path, PRIVATE_DIRECTORY_MODE);
}

function fsyncDirectoryBestEffort(path: string): void {
  let fd: number | null = null;
  try {
    fd = openSync(path, constants.O_RDONLY);
    fsyncSync(fd);
  } catch (error) {
    // Windows does not permit fsync on directory handles. File fsync plus same-directory rename is
    // the strongest portable durability primitive Node exposes there; other failures remain fatal.
    if (process.platform !== "win32") throw error;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function renamePrivateFileWithBoundedRetry(
  temporaryPath: string,
  path: string,
  adapters: CodexSessionTicketVaultFileAdapters,
): void {
  const rename = adapters.rename ?? renameSync;
  const platform = adapters.platform ?? process.platform;
  for (let attempt = 0; ; attempt += 1) {
    try {
      rename(temporaryPath, path);
      return;
    } catch (error: unknown) {
      const code = errorCode(error);
      const delay = WINDOWS_RENAME_RETRY_DELAYS_MS[attempt];
      if (
        platform !== "win32" ||
        !code ||
        !["EACCES", "EBUSY", "EPERM"].includes(code) ||
        delay === undefined
      ) {
        throw error;
      }
      (adapters.wait ?? waitSynchronously)(delay);
    }
  }
}

function atomicWritePrivateJson(
  path: string,
  value: unknown,
  adapters: CodexSessionTicketVaultFileAdapters = {},
): void {
  const directory = dirname(path);
  ensurePrivateDirectory(directory);
  const temporaryPath = `${path}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`;
  let fd: number | null = null;
  try {
    fd = openSync(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      PRIVATE_FILE_MODE,
    );
    writeFileSync(fd, `${JSON.stringify(value)}\n`, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    chmodSync(temporaryPath, PRIVATE_FILE_MODE);
    renamePrivateFileWithBoundedRetry(temporaryPath, path, adapters);
    chmodSync(path, PRIVATE_FILE_MODE);
    fsyncDirectoryBestEffort(directory);
  } catch (error) {
    if (fd !== null) closeSync(fd);
    if (existsSync(temporaryPath)) (adapters.unlink ?? unlinkSync)(temporaryPath);
    throw error;
  }
}

function parseCloseJournal(
  value: unknown,
  projectId: string,
  runId: string,
): CodexSessionTicketCloseJournal {
  const candidate = value as Partial<CodexSessionTicketCloseJournal> | null;
  if (
    !candidate ||
    candidate.version !== 1 ||
    candidate.projectId !== projectId ||
    candidate.runId !== runId ||
    (candidate.state !== "PREPARED" && candidate.state !== "COMMITTED") ||
    !Array.isArray(candidate.indexes) ||
    !("checkpoint" in candidate) ||
    typeof candidate.updatedAt !== "string" ||
    new Date(candidate.updatedAt).toISOString() !== candidate.updatedAt
  ) {
    throw new Error("Invalid Codex session ticket close journal");
  }
  const vault = parseCodexSessionTicketVaultSnapshot(candidate.vault);
  const bundles = [vault.current, vault.successor].filter(
    (bundle): bundle is StoredCodexSessionTicketBundle => bundle !== null,
  );
  if (
    bundles.length === 0 ||
    bundles.some(
      (bundle) =>
        bundle.launchContext.projectId !== projectId || bundle.launchContext.runId !== runId,
    )
  ) {
    throw new Error("Invalid Codex session ticket close journal");
  }
  const indexes = candidate.indexes.map((entry) => {
    if (!entry || typeof entry.name !== "string" || !entry.record) {
      throw new Error("Invalid Codex session ticket close journal");
    }
    const threadId = (entry.record as Partial<CodexSessionTicketRecoveryRecord>).threadId;
    if (typeof threadId !== "string") {
      throw new Error("Invalid Codex session ticket close journal");
    }
    const record = parseRecoveryRecord(entry.record, projectId, threadId);
    if (record.runId !== runId || entry.name !== `${threadDigest(threadId)}.json`) {
      throw new Error("Invalid Codex session ticket close journal");
    }
    return { name: entry.name, record };
  });
  if (new Set(indexes.map((entry) => entry.name)).size !== indexes.length) {
    throw new Error("Invalid Codex session ticket close journal");
  }
  const checkpoint = candidate.checkpoint;
  if (
    checkpoint !== null &&
    (!checkpoint ||
      typeof checkpoint.threadId !== "string" ||
      checkpoint.threadId.length === 0 ||
      typeof checkpoint.ownerRunId !== "string" ||
      checkpoint.ownerRunId !== runId ||
      typeof checkpoint.bundleId !== "string" ||
      !checkpoint.bundleId.startsWith("stb_"))
  ) {
    throw new Error("Invalid Codex session ticket close journal");
  }
  if (
    checkpoint &&
    (!vault.current ||
      vault.successor !== null ||
      vault.current.phase !== "ACTIVE" ||
      !vault.current.binding ||
      !vault.current.sessionReceipt ||
      vault.current.bundleId !== checkpoint.bundleId ||
      vault.current.launchContext.externalThreadId !== checkpoint.threadId)
  ) {
    throw new Error("Invalid Codex session ticket close journal");
  }
  return {
    version: 1,
    projectId,
    runId,
    state: candidate.state,
    vault,
    indexes,
    checkpoint,
    updatedAt: candidate.updatedAt,
  };
}

function restoreCloseJournal(journal: CodexSessionTicketCloseJournal, rootDir: string): void {
  const vaultPath = codexSessionTicketVaultPath(journal.projectId, journal.runId, rootDir);
  if (existsSync(vaultPath)) {
    const existing = parseCodexSessionTicketVaultSnapshot(
      JSON.parse(readFileSync(vaultPath, "utf8")) as unknown,
    );
    if (JSON.stringify(existing) !== JSON.stringify(journal.vault)) {
      throw new Error(
        "Prepared Codex session ticket close journal conflicts with live vault state",
      );
    }
  } else {
    atomicWritePrivateJson(vaultPath, journal.vault);
  }
  const indexDirectory = resolve(
    projectTicketDirectory(journal.projectId, rootDir),
    "thread-index",
  );
  for (const index of journal.indexes) {
    const path = resolve(indexDirectory, index.name);
    if (existsSync(path)) {
      const existing = parseRecoveryRecord(
        JSON.parse(readFileSync(path, "utf8")),
        journal.projectId,
        index.record.threadId,
      );
      if (JSON.stringify(existing) !== JSON.stringify(index.record)) {
        throw new Error(
          "Prepared Codex session ticket close journal conflicts with live recovery index",
        );
      }
    } else {
      atomicWritePrivateJson(path, index.record);
    }
  }
  fsyncDirectoryBestEffort(dirname(vaultPath));
  if (journal.indexes.length > 0) fsyncDirectoryBestEffort(indexDirectory);
}

function rollbackCloseJournal(
  journal: CodexSessionTicketCloseJournal,
  journalPath: string,
  rootDir: string,
  cause: unknown,
): never {
  try {
    const prepared = {
      ...journal,
      state: "PREPARED" as const,
      updatedAt: new Date().toISOString(),
    };
    atomicWritePrivateJson(journalPath, prepared);
    restoreCloseJournal(prepared, rootDir);
    unlinkSync(journalPath);
    fsyncDirectoryBestEffort(dirname(journalPath));
  } catch (rollbackError) {
    throw new AggregateError(
      [cause, rollbackError],
      "Codex session ticket close transaction failed and requires journal recovery",
    );
  }
  throw cause;
}

function checkpointMatchesPreparedClose(
  checkpoint: CodexSessionOperationalCheckpoint,
  expected: NonNullable<CodexSessionTicketCloseJournal["checkpoint"]>,
): boolean {
  return (
    checkpoint.threadId === expected.threadId &&
    checkpoint.ownerRunId === expected.ownerRunId &&
    checkpoint.session?.bundleId === expected.bundleId &&
    checkpoint.confirmedClose?.state === "PREPARED" &&
    checkpoint.confirmedClose.bundleId === expected.bundleId
  );
}

function checkpointMatchesCompletedClose(
  checkpoint: CodexSessionOperationalCheckpoint,
  expected: NonNullable<CodexSessionTicketCloseJournal["checkpoint"]>,
): boolean {
  return (
    checkpoint.threadId === expected.threadId &&
    checkpoint.ownerRunId === expected.ownerRunId &&
    checkpoint.session === null &&
    checkpoint.confirmedClose === undefined
  );
}

function checkpointMatchesJournalActiveSession(
  checkpoint: CodexSessionOperationalCheckpoint,
  journal: CodexSessionTicketCloseJournal,
): boolean {
  const current = journal.vault.current;
  return Boolean(
    current?.binding &&
    current.sessionReceipt &&
    checkpoint.session &&
    checkpoint.session.hubSessionId === current.binding.hubSessionId &&
    checkpoint.session.lineageId === current.binding.lineageId &&
    checkpoint.session.incarnation === current.binding.incarnation &&
    current.sessionReceipt.id === current.binding.hubSessionId,
  );
}

function assertCommittedCloseHasNoLiveRecoveryState(
  journal: CodexSessionTicketCloseJournal,
  rootDir: string,
): void {
  const vaultPath = codexSessionTicketVaultPath(journal.projectId, journal.runId, rootDir);
  const indexDirectory = resolve(
    projectTicketDirectory(journal.projectId, rootDir),
    "thread-index",
  );
  if (
    existsSync(vaultPath) ||
    journal.indexes.some((index) => existsSync(resolve(indexDirectory, index.name)))
  ) {
    throw new Error(
      "Committed Codex session ticket close journal conflicts with live recovery state",
    );
  }
}

function readJournalCheckpoint(
  journal: CodexSessionTicketCloseJournal,
  rootDir: string,
): CodexSessionOperationalCheckpoint {
  const expected = journal.checkpoint;
  if (!expected) throw new Error("Codex close journal has no operational checkpoint binding");
  const checkpointPath = codexSessionOperationalCheckpointPath(
    journal.projectId,
    expected.threadId,
    rootDir,
  );
  if (!existsSync(checkpointPath)) {
    throw new Error("Committed Codex close journal is missing its operational checkpoint");
  }
  return parseOperationalCheckpoint(
    JSON.parse(readFileSync(checkpointPath, "utf8")),
    journal.projectId,
    expected.threadId,
  );
}

function recoverPendingCloseTransactions(
  projectId: string,
  rootDir: string,
  deferCommittedRunId?: string,
): void {
  const directory = codexSessionTicketCloseJournalDirectory(projectId, rootDir);
  if (!existsSync(directory)) return;
  for (const name of readdirSync(directory)) {
    if (!name.endsWith(".json")) continue;
    const runId = name.slice(0, -".json".length);
    assertLocalId("run", runId);
    const path = resolve(directory, name);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error("Invalid Codex session ticket close journal");
    }
    if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
      throw new Error("Codex session ticket close journal is not owner-private");
    }
    const journal = parseCloseJournal(JSON.parse(readFileSync(path, "utf8")), projectId, runId);
    if (journal.state === "PREPARED") {
      restoreCloseJournal(journal, rootDir);
    } else if (runId === deferCommittedRunId && journal.checkpoint) {
      continue;
    } else if (!journal.checkpoint) {
      assertCommittedCloseHasNoLiveRecoveryState(journal, rootDir);
    } else {
      const checkpoint = readJournalCheckpoint(journal, rootDir);
      if (
        checkpointMatchesPreparedClose(checkpoint, journal.checkpoint) &&
        checkpointMatchesJournalActiveSession(checkpoint, journal)
      ) {
        restoreCloseJournal(journal, rootDir);
      } else if (checkpointMatchesCompletedClose(checkpoint, journal.checkpoint)) {
        assertCommittedCloseHasNoLiveRecoveryState(journal, rootDir);
      } else {
        throw new Error(
          "Committed Codex close journal does not match its exact owner and bundle checkpoint",
        );
      }
    }
    unlinkSync(path);
  }
  fsyncDirectoryBestEffort(directory);
}

function waitSynchronously(milliseconds: number): void {
  const signal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  Atomics.wait(signal, 0, 0, milliseconds);
}

function removeLockDirectory(path: string): void {
  const ownerPath = resolve(path, "owner.json");
  const reaperPath = resolve(path, ".reap");
  if (existsSync(ownerPath)) unlinkSync(ownerPath);
  if (existsSync(reaperPath)) unlinkSync(reaperPath);
  rmdirSync(path);
}

function recoverStaleLock(
  lockPath: string,
  adapters: CodexSessionTicketRecoveryLockAdapters,
): boolean {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(lockPath);
  } catch {
    return true;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Invalid Codex session ticket recovery lock");
  }
  const ownerPath = resolve(lockPath, "owner.json");
  type RecoveryLockOwnerCandidate = { pid?: unknown; nonce?: unknown; createdAt?: unknown };
  let owner: RecoveryLockOwnerCandidate | null = null;
  try {
    owner = JSON.parse(readFileSync(ownerPath, "utf8")) as RecoveryLockOwnerCandidate;
  } catch {
    // A process may die between mkdir and owner write. The directory mtime is the only safe clock.
  }
  const createdAt =
    typeof owner?.createdAt === "string" ? Date.parse(owner.createdAt) : stat.mtimeMs;
  const now = adapters.now?.() ?? Date.now();
  if (Number.isFinite(createdAt) && now - createdAt <= RECOVERY_LOCK_STALE_AFTER_MS) return false;
  const pid =
    Number.isSafeInteger(owner?.pid) && Number(owner?.pid) > 0 ? Number(owner?.pid) : null;
  if (pid !== null && (adapters.processExists ?? processExists)(pid)) return false;
  const nonce = typeof owner?.nonce === "string" ? owner.nonce : "unowned";
  const reaperPath = resolve(lockPath, ".reap");
  const reaperNonce = randomBytes(24).toString("base64url");
  adapters.afterStaleOwnerRead?.(lockPath);
  let reaperFd: number | null = null;
  try {
    reaperFd = openSync(
      reaperPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      PRIVATE_FILE_MODE,
    );
    writeFileSync(reaperFd, `${JSON.stringify({ ownerNonce: nonce, reaperNonce })}\n`, "utf8");
    fsyncSync(reaperFd);
    closeSync(reaperFd);
    reaperFd = null;
  } catch (error) {
    if (reaperFd !== null) closeSync(reaperFd);
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
  let currentOwnerNonce: string | null = null;
  try {
    const currentOwner = JSON.parse(readFileSync(ownerPath, "utf8")) as { nonce?: unknown };
    currentOwnerNonce = typeof currentOwner.nonce === "string" ? currentOwner.nonce : null;
  } catch {
    currentOwnerNonce = null;
  }
  if (currentOwnerNonce !== (owner?.nonce ?? null)) {
    try {
      const claim = JSON.parse(readFileSync(reaperPath, "utf8")) as { reaperNonce?: unknown };
      if (claim.reaperNonce === reaperNonce) unlinkSync(reaperPath);
    } catch {
      // Never remove another reaper's claim.
    }
    return false;
  }
  const tombstone = `${lockPath}.stale.${createHash("sha256")
    .update(nonce, "utf8")
    .digest("hex")}.${randomBytes(8).toString("hex")}`;
  try {
    // Renaming the old owner directory is the ABA boundary. A successor may create lockPath after
    // this point, but cleanup touches only the uniquely named tombstone.
    renameSync(lockPath, tombstone);
  } catch (error) {
    try {
      const claim = JSON.parse(readFileSync(reaperPath, "utf8")) as { reaperNonce?: unknown };
      if (claim.reaperNonce === reaperNonce) unlinkSync(reaperPath);
    } catch {
      // The old directory may already have been moved or released.
    }
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
  adapters.afterStaleLockTombstoned?.(lockPath);
  try {
    removeLockDirectory(tombstone);
  } catch {
    // A malformed stale tombstone is safer left for diagnostics than recursively deleted.
  }
  return true;
}

function withRecoveryLock<T>(
  projectId: string,
  rootDir: string,
  action: () => T,
  adapters: CodexSessionTicketRecoveryLockAdapters = {},
  deferCommittedRunId?: string,
): T {
  const directory = projectTicketDirectory(projectId, rootDir);
  ensurePrivateDirectory(directory);
  const lockPath = codexSessionTicketRecoveryLockPath(projectId, rootDir);
  const nonce = randomBytes(24).toString("base64url");
  const owner = {
    pid: process.pid,
    nonce,
    createdAt: new Date(adapters.now?.() ?? Date.now()).toISOString(),
  };
  let acquired = false;
  for (let attempt = 0; attempt < (adapters.attempts ?? RECOVERY_LOCK_ATTEMPTS); attempt += 1) {
    let createdDirectory = false;
    try {
      mkdirSync(lockPath, { mode: PRIVATE_DIRECTORY_MODE });
      createdDirectory = true;
      chmodSync(lockPath, PRIVATE_DIRECTORY_MODE);
      atomicWritePrivateJson(resolve(lockPath, "owner.json"), owner);
      acquired = true;
      break;
    } catch (error) {
      if (createdDirectory) {
        try {
          removeLockDirectory(lockPath);
        } catch {
          // Preserve the original acquisition error.
        }
      }
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (recoverStaleLock(lockPath, adapters)) continue;
      waitSynchronously(adapters.waitMs ?? RECOVERY_LOCK_WAIT_MS);
    }
  }
  if (!acquired) {
    throw new Error("Codex session ticket recovery index is busy; refusing an unsafe update");
  }
  try {
    recoverPendingCloseTransactions(projectId, rootDir, deferCommittedRunId);
    return action();
  } finally {
    try {
      const current = JSON.parse(readFileSync(resolve(lockPath, "owner.json"), "utf8")) as {
        nonce?: unknown;
      };
      if (current.nonce === nonce) {
        const tombstone = `${lockPath}.release.${createHash("sha256")
          .update(nonce, "utf8")
          .digest("hex")}`;
        renameSync(lockPath, tombstone);
        removeLockDirectory(tombstone);
        fsyncDirectoryBestEffort(directory);
      }
    } catch {
      // Never unlink a lock that no longer contains our exact nonce.
    }
  }
}

function parseRecoveryRecord(
  value: unknown,
  projectId: string,
  threadId: string,
): CodexSessionTicketRecoveryRecord {
  const record = value as Partial<CodexSessionTicketRecoveryRecord> | null;
  if (
    !record ||
    record.version !== 1 ||
    record.projectId !== projectId ||
    record.threadId !== threadId ||
    record.threadSha256 !== threadDigest(threadId) ||
    typeof record.runId !== "string" ||
    !ID_PATTERN.test(record.runId) ||
    !record.runId.startsWith("run_") ||
    (record.state !== "ACTIVE" && record.state !== "DRAINING") ||
    typeof record.updatedAt !== "string" ||
    new Date(record.updatedAt).toISOString() !== record.updatedAt
  ) {
    throw new Error("Invalid Codex session ticket recovery index");
  }
  return record as CodexSessionTicketRecoveryRecord;
}

function readRecoveryRecord(
  projectId: string,
  threadId: string,
  rootDir: string,
): CodexSessionTicketRecoveryRecord | null {
  const path = codexSessionTicketRecoveryIndexPath(projectId, threadId, rootDir);
  if (!existsSync(path)) return null;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("Invalid Codex session ticket recovery index");
  }
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new Error("Codex session ticket recovery index is not owner-private");
  }
  return parseRecoveryRecord(JSON.parse(readFileSync(path, "utf8")), projectId, threadId);
}

function readRecoverableSnapshot(
  projectId: string,
  threadId: string,
  runId: string,
  rootDir: string,
): CodexSessionTicketVaultSnapshot | null {
  const path = codexSessionTicketVaultPath(projectId, runId, rootDir);
  if (!existsSync(path)) return null;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("Invalid Codex session ticket vault; refusing credential recovery");
  }
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new Error("Codex session ticket vault is not owner-private");
  }
  const snapshot = parseCodexSessionTicketVaultSnapshot(
    JSON.parse(readFileSync(path, "utf8")) as unknown,
  );
  const bundles = [snapshot.current, snapshot.successor].filter((bundle) => bundle !== null);
  if (bundles.length === 0) return null;
  if (
    bundles.some(
      (bundle) =>
        bundle.launchContext.projectId !== projectId ||
        bundle.launchContext.runId !== runId ||
        bundle.launchContext.externalThreadId !== threadId,
    )
  ) {
    throw new Error("Codex session ticket vault does not match its recovery identity");
  }
  return snapshot;
}

function bindingMatchesSession(bundle: StoredCodexSessionTicketBundle): boolean {
  const binding = bundle.binding;
  const session = bundle.sessionReceipt;
  return Boolean(
    binding &&
    session &&
    binding.state === "ACTIVE" &&
    binding.bundleId === bundle.bundleId &&
    binding.projectId === bundle.context.projectId &&
    binding.agentId === "codex" &&
    binding.adapterClient === "codex" &&
    binding.hubSessionId === session.id &&
    binding.lineageId === session.lineageId &&
    binding.incarnation === session.incarnation &&
    binding.runId === bundle.context.runId &&
    session.projectId === bundle.context.projectId &&
    session.agentId === "codex" &&
    session.client === "codex-app-server",
  );
}

function auxiliaryRotationMatches(
  current: StoredCodexSessionTicketBundle,
  successor: StoredCodexSessionTicketBundle,
): boolean {
  const currentBinding = current.binding;
  const currentSession = current.sessionReceipt;
  const receipt = successor.rotationReceipt;
  const successorBinding = successor.binding;
  const successorSession = successor.sessionReceipt;
  if (
    !currentBinding ||
    !currentSession ||
    !receipt ||
    !successorBinding ||
    !successorSession ||
    JSON.stringify(receipt.ticketBinding) !== JSON.stringify(successorBinding) ||
    JSON.stringify(receipt.session) !== JSON.stringify(successorSession) ||
    successorSession.id !== currentSession.id ||
    successorSession.lineageId !== currentSession.lineageId ||
    successorSession.incarnation !== currentSession.incarnation ||
    successorBinding.expiresAt <= currentBinding.expiresAt
  ) {
    return false;
  }
  const superseded = receipt.supersededTicketBinding;
  if (
    superseded.state !== "SUPERSEDED" ||
    superseded.bundleId !== currentBinding.bundleId ||
    superseded.projectId !== currentBinding.projectId ||
    superseded.agentId !== currentBinding.agentId ||
    superseded.adapterClient !== currentBinding.adapterClient ||
    superseded.hubSessionId !== currentBinding.hubSessionId ||
    superseded.lineageId !== currentBinding.lineageId ||
    superseded.incarnation !== currentBinding.incarnation ||
    superseded.runId !== currentBinding.runId ||
    superseded.activatedAt !== currentBinding.activatedAt ||
    superseded.expiresAt !== currentBinding.expiresAt ||
    !superseded.terminalAt ||
    !superseded.terminalReason ||
    superseded.purposes.length !== currentBinding.purposes.length
  ) {
    return false;
  }
  return currentBinding.purposes.every((purpose) => {
    const terminal = superseded.purposes.find((entry) => entry.purpose === purpose.purpose);
    return (
      terminal?.id === purpose.id &&
      terminal.state === "SUPERSEDED" &&
      terminal.terminalAt === superseded.terminalAt &&
      terminal.terminalReason === superseded.terminalReason
    );
  });
}

function exactCloseReplayBundles(snapshot: CodexSessionTicketVaultSnapshot): {
  current: StoredCodexSessionTicketBundle;
  successor: StoredCodexSessionTicketBundle | null;
} | null {
  const current = snapshot.current;
  if (
    !current ||
    current.phase !== "ACTIVE" ||
    !current.binding ||
    !current.sessionReceipt ||
    !bindingMatchesSession(current)
  ) {
    return null;
  }
  const successor = snapshot.successor;
  if (!successor) {
    return snapshot.cutover === null || snapshot.cutover === undefined
      ? { current, successor: null }
      : null;
  }
  if (
    JSON.stringify(successor.launchContext) !== JSON.stringify(current.launchContext) ||
    successor.launchSessionId !== current.launchSessionId ||
    successor.context.projectId !== current.context.projectId ||
    successor.context.runId !== current.context.runId ||
    successor.context.externalSessionId !== current.context.externalSessionId ||
    successor.context.externalThreadId !== current.context.externalThreadId ||
    successor.context.expectedLineageId !== current.binding.lineageId ||
    successor.context.expectedHeadSessionId !== current.sessionReceipt.id
  ) {
    return null;
  }
  if (successor.phase === "PREPARING" || successor.phase === "OFFERED") {
    return !successor.activationAttempted && !snapshot.cutover ? { current, successor } : null;
  }
  const cutover = snapshot.cutover;
  if (
    !cutover ||
    cutover.predecessorBundleId !== current.bundleId ||
    cutover.successorBundleId !== successor.bundleId ||
    cutover.predecessorSessionId !== current.sessionReceipt.id
  ) {
    return null;
  }
  const auxiliary = successor.context.activationMode === "SESSION_AUXILIARY";
  if (
    (cutover.kind === "SESSION_AUXILIARY") !== auxiliary ||
    (cutover.kind === "CURRENT_HEAD_REPLACEMENT") !==
      (successor.context.activationMode === "CURRENT_HEAD_REPLACEMENT")
  ) {
    return null;
  }
  const expectedOperation =
    cutover.kind === "SESSION_AUXILIARY"
      ? `session-ticket-renewal:${current.bundleId}`
      : `codex-current-head:${current.launchContext.runId}:${current.sessionReceipt.id}`;
  if (
    cutover.operationId !== expectedOperation ||
    (cutover.kind === "SESSION_AUXILIARY" &&
      JSON.stringify(successor.registrationInput) !== JSON.stringify(current.registrationInput)) ||
    (cutover.kind === "CURRENT_HEAD_REPLACEMENT" &&
      (successor.registrationInput?.idempotencyKey !== expectedOperation ||
        successor.rotationReceipt !== null))
  ) {
    return null;
  }
  if (successor.phase === "ACTIVATING") {
    return successor.activationAttempted &&
      cutover.phase === "HUB_ACTIVATING" &&
      cutover.successorSessionId === null &&
      successor.binding === null &&
      successor.sessionReceipt === null &&
      successor.rotationReceipt === null
      ? { current, successor }
      : null;
  }
  if (
    successor.phase !== "ACTIVE" ||
    !successor.binding ||
    !successor.sessionReceipt ||
    !bindingMatchesSession(successor) ||
    cutover.phase === "HUB_ACTIVATING" ||
    cutover.successorSessionId !== successor.sessionReceipt.id ||
    (cutover.kind === "SESSION_AUXILIARY" && !auxiliaryRotationMatches(current, successor)) ||
    (cutover.kind === "CURRENT_HEAD_REPLACEMENT" &&
      (successor.sessionReceipt.id === current.sessionReceipt.id ||
        successor.sessionReceipt.predecessorSessionId !== current.sessionReceipt.id ||
        successor.rotationReceipt !== null))
  ) {
    return null;
  }
  return { current, successor };
}

export function findRecoverableCodexSessionTicketRun(input: {
  projectId: string;
  threadId: string;
  rootDir?: string;
  lockAdapters?: CodexSessionTicketRecoveryLockAdapters;
}): string | null {
  const rootDir = input.rootDir ?? dataDir;
  return withRecoveryLock(
    input.projectId,
    rootDir,
    () => {
      const record = readRecoveryRecord(input.projectId, input.threadId, rootDir);
      if (!record) return null;
      if (record.state === "DRAINING") {
        throw new Error(
          "Codex session ticket recovery is DRAINING; replay the exact terminal close before relaunch",
        );
      }
      if (readRecoverableSnapshot(input.projectId, input.threadId, record.runId, rootDir)) {
        return record.runId;
      }
      const path = codexSessionTicketRecoveryIndexPath(input.projectId, input.threadId, rootDir);
      if (existsSync(path)) unlinkSync(path);
      return null;
    },
    input.lockAdapters,
  );
}

export function readCodexSessionTicketRecoveryState(input: {
  projectId: string;
  threadId: string;
  rootDir?: string;
  lockAdapters?: CodexSessionTicketRecoveryLockAdapters;
}): { runId: string; state: "ACTIVE" | "DRAINING" } | null {
  const rootDir = input.rootDir ?? dataDir;
  return withRecoveryLock(
    input.projectId,
    rootDir,
    () => {
      const record = readRecoveryRecord(input.projectId, input.threadId, rootDir);
      if (!record) return null;
      if (readRecoverableSnapshot(input.projectId, input.threadId, record.runId, rootDir)) {
        return { runId: record.runId, state: record.state };
      }
      const path = codexSessionTicketRecoveryIndexPath(input.projectId, input.threadId, rootDir);
      if (existsSync(path)) unlinkSync(path);
      return null;
    },
    input.lockAdapters,
  );
}

export function assertCodexSessionTicketRecoveryReservation(input: {
  projectId: string;
  threadId: string;
  runId: string;
  reservation: SessionLaunchReservation;
  rootDir?: string;
}): void {
  const rootDir = input.rootDir ?? dataDir;
  withRecoveryLock(input.projectId, rootDir, () => {
    const record = readRecoveryRecord(input.projectId, input.threadId, rootDir);
    if (!record || record.state !== "ACTIVE" || record.runId !== input.runId) {
      throw new Error("Consumed launch reservation lacks one ACTIVE local recovery owner");
    }
    const snapshot = readRecoverableSnapshot(input.projectId, input.threadId, input.runId, rootDir);
    const current = snapshot?.current;
    const reservation = SessionLaunchReservationSchema.parse(input.reservation);
    const mismatches = [
      ["current", !current],
      ["reservation-state", reservation.state !== "CONSUMED"],
      ["project", reservation.projectId !== input.projectId],
      ["agent", reservation.agentId !== "codex"],
      ["client", reservation.client !== "codex-app-server"],
      ["delivery", reservation.deliveryMode !== "app_server_push"],
      ["identity-kind", reservation.identityKind !== "external_thread"],
      ["identity-value", reservation.identityValue !== input.threadId],
      ["run", reservation.runId !== input.runId],
      ["launch-mode", current?.launchContext.activationMode !== "MANAGED_RESERVATION"],
      ["launch-project", current?.launchContext.projectId !== input.projectId],
      ["launch-run", current?.launchContext.runId !== input.runId],
      ["launch-session", current?.launchContext.externalSessionId !== input.threadId],
      ["launch-thread", current?.launchContext.externalThreadId !== input.threadId],
      ["launch-lineage", current?.launchContext.expectedLineageId !== reservation.lineageId],
      [
        "launch-head",
        current?.launchContext.expectedHeadSessionId !== reservation.expectedHeadSessionId,
      ],
      ["launch-reservation", reservation.id !== current?.launchContext.launchReservationId],
      ["launch-generation", reservation.generation !== current?.launchContext.launchGeneration],
      ["consumed-session", reservation.consumedSessionId === null],
    ].filter((entry) => entry[1] === true);
    if (mismatches.length > 0 || !current) {
      throw new Error(
        `Consumed launch reservation does not match the durable Codex recovery proof (${mismatches
          .map(([field]) => field)
          .join(", ")})`,
      );
    }
    const successor = snapshot?.successor ?? null;
    if (successor) {
      const cutover = snapshot?.cutover ?? null;
      const expectedOperation =
        cutover?.kind === "SESSION_AUXILIARY"
          ? `session-ticket-renewal:${current.bundleId}`
          : `codex-current-head:${input.runId}:${current.sessionReceipt?.id ?? "missing"}`;
      if (
        current.phase !== "ACTIVE" ||
        !current.binding ||
        !current.sessionReceipt ||
        !cutover ||
        JSON.stringify(successor.launchContext) !== JSON.stringify(current.launchContext) ||
        successor.launchSessionId !== current.launchSessionId ||
        successor.context.projectId !== input.projectId ||
        successor.context.runId !== input.runId ||
        successor.context.externalSessionId !== input.threadId ||
        successor.context.externalThreadId !== input.threadId ||
        successor.context.expectedLineageId !== reservation.lineageId ||
        successor.context.expectedHeadSessionId !== current.sessionReceipt.id ||
        cutover.predecessorBundleId !== current.bundleId ||
        cutover.successorBundleId !== successor.bundleId ||
        cutover.predecessorSessionId !== current.sessionReceipt.id ||
        cutover.operationId !== expectedOperation ||
        (cutover.kind === "SESSION_AUXILIARY" &&
          JSON.stringify(successor.registrationInput) !==
            JSON.stringify(current.registrationInput)) ||
        (cutover.kind === "SESSION_AUXILIARY" &&
          cutover.phase !== "HUB_ACTIVATING" &&
          !successor.rotationReceipt) ||
        (cutover.kind === "CURRENT_HEAD_REPLACEMENT" &&
          (successor.registrationInput?.idempotencyKey !== expectedOperation ||
            successor.rotationReceipt !== null))
      ) {
        throw new Error(
          "Consumed launch reservation has an invalid durable credential cutover proof",
        );
      }
    } else if (snapshot?.cutover) {
      throw new Error("Consumed launch reservation has a cutover without its durable successor");
    }
    if (current.phase === "ACTIVATING") {
      const registration = current.registrationInput;
      if (
        !current.activationAttempted ||
        current.binding !== null ||
        current.sessionReceipt !== null ||
        current.launchSessionId !== null ||
        current.context.activationMode !== "MANAGED_RESERVATION" ||
        current.context.projectId !== current.launchContext.projectId ||
        current.context.runId !== current.launchContext.runId ||
        current.context.externalSessionId !== current.launchContext.externalSessionId ||
        current.context.externalThreadId !== current.launchContext.externalThreadId ||
        current.context.expectedLineageId !== current.launchContext.expectedLineageId ||
        current.context.expectedHeadSessionId !== current.launchContext.expectedHeadSessionId ||
        current.context.launchReservationId !== current.launchContext.launchReservationId ||
        current.context.launchGeneration !== current.launchContext.launchGeneration ||
        !current.offerIds.CONTROL ||
        !current.offerIds.MODEL_MCP ||
        !current.offerIds.INJECTOR ||
        !registration ||
        registration.agentId !== "codex" ||
        registration.role !== "primary" ||
        registration.client !== "codex-app-server" ||
        registration.transport !== "websocket" ||
        registration.deliveryMode !== "app_server_push" ||
        registration.externalSessionId !== input.threadId ||
        registration.externalThreadId !== input.threadId ||
        registration.expectedHeadSessionId !== reservation.expectedHeadSessionId ||
        registration.launcherRunId !== input.runId ||
        registration.launchGeneration !== reservation.generation ||
        registration.idempotencyKey !== `codex-session:${input.runId}`
      ) {
        throw new Error(
          "Consumed launch reservation lacks an exact ACTIVATING registration replay proof",
        );
      }
      return;
    }
    if (
      current.phase !== "ACTIVE" ||
      !current.binding ||
      !current.sessionReceipt ||
      reservation.lineageId !== current.binding.lineageId ||
      reservation.consumedSessionId !== current.launchSessionId
    ) {
      throw new Error(
        "Consumed launch reservation does not match the durable ACTIVE Codex recovery proof",
      );
    }
  });
}

export function bindCodexSessionTicketRecoveryRun(input: {
  projectId: string;
  threadId: string;
  runId: string;
  rootDir?: string;
  lockAdapters?: CodexSessionTicketRecoveryLockAdapters;
}): void {
  assertLocalId("run", input.runId);
  const rootDir = input.rootDir ?? dataDir;
  withRecoveryLock(
    input.projectId,
    rootDir,
    () => {
      const current = readRecoveryRecord(input.projectId, input.threadId, rootDir);
      if (current && current.runId !== input.runId) {
        if (readRecoverableSnapshot(input.projectId, input.threadId, current.runId, rootDir)) {
          throw new Error("Another managed Codex run owns the recoverable thread ticket vault");
        }
      }
      atomicWritePrivateJson(
        codexSessionTicketRecoveryIndexPath(input.projectId, input.threadId, rootDir),
        {
          version: 1,
          projectId: input.projectId,
          threadId: input.threadId,
          threadSha256: threadDigest(input.threadId),
          runId: input.runId,
          state: "ACTIVE",
          updatedAt: new Date().toISOString(),
        } satisfies CodexSessionTicketRecoveryRecord,
      );
    },
    input.lockAdapters,
  );
}

export function markCodexSessionTicketRecoveryDraining(input: {
  projectId: string;
  threadId: string;
  runId: string;
  sessionId: string | null;
  bundleId: string | null;
  rootDir?: string;
  lockAdapters?: CodexSessionTicketRecoveryLockAdapters;
}): boolean {
  const rootDir = input.rootDir ?? dataDir;
  return withRecoveryLock(
    input.projectId,
    rootDir,
    () => {
      const current = readRecoveryRecord(input.projectId, input.threadId, rootDir);
      if (!current || current.runId !== input.runId) return false;
      const snapshot = readRecoverableSnapshot(
        input.projectId,
        input.threadId,
        input.runId,
        rootDir,
      );
      if (!snapshot) {
        const path = codexSessionTicketRecoveryIndexPath(input.projectId, input.threadId, rootDir);
        if (existsSync(path)) unlinkSync(path);
        return false;
      }
      const replay = exactCloseReplayBundles(snapshot);
      // DRAINING means replayConfirmedClose() is the only safe next operation. Never create that
      // state unless the retained vault already satisfies the replay method's exact authority.
      // A bound successor is admitted only through the same cutover matrix replayConfirmedClose()
      // reconciles; pre-activation successors are discardable, while active successors are exact
      // alternative evidence targets for the same launch owner.
      if (!replay) return false;
      const currentTarget =
        replay.current.bundleId === input.bundleId &&
        replay.current.sessionReceipt?.id === input.sessionId;
      const successorTarget =
        replay.successor?.phase === "ACTIVE" &&
        replay.successor.bundleId === input.bundleId &&
        replay.successor.sessionReceipt?.id === input.sessionId;
      if (!currentTarget && !successorTarget) return false;
      atomicWritePrivateJson(
        codexSessionTicketRecoveryIndexPath(input.projectId, input.threadId, rootDir),
        { ...current, state: "DRAINING", updatedAt: new Date().toISOString() },
      );
      return true;
    },
    input.lockAdapters,
  );
}

function ownedRecoveryIndexesForRun(
  projectId: string,
  runId: string,
  vault: CodexSessionTicketVaultSnapshot,
  rootDir: string,
): Array<{ name: string; path: string; record: CodexSessionTicketRecoveryRecord }> {
  const directory = resolve(projectTicketDirectory(projectId, rootDir), "thread-index");
  if (!existsSync(directory)) return [];
  const ownedThreads = new Set(
    [vault.current, vault.successor]
      .filter((bundle): bundle is StoredCodexSessionTicketBundle => bundle !== null)
      .map((bundle) => bundle.launchContext.externalThreadId),
  );
  const owned: Array<{ name: string; path: string; record: CodexSessionTicketRecoveryRecord }> = [];
  for (const name of readdirSync(directory)) {
    if (!name.endsWith(".json")) continue;
    const path = resolve(directory, name);
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      const value = JSON.parse(
        readFileSync(path, "utf8"),
      ) as Partial<CodexSessionTicketRecoveryRecord>;
      if (typeof value.threadId !== "string" || !ownedThreads.has(value.threadId)) continue;
      const record = parseRecoveryRecord(value, projectId, value.threadId);
      if (record.runId !== runId || name !== `${threadDigest(record.threadId)}.json`) continue;
      owned.push({ name, path, record });
    } catch {
      // A corrupt or unrelated sibling is not evidence that this run owns it. Leave it untouched.
    }
  }
  return owned;
}

function preparedCheckpointBindingForClose(
  projectId: string,
  runId: string,
  vault: CodexSessionTicketVaultSnapshot,
  rootDir: string,
): CodexSessionTicketCloseJournal["checkpoint"] {
  const current = vault.current;
  const threadId = current?.launchContext.externalThreadId;
  if (!current || vault.successor || !threadId) return null;
  const checkpointPath = codexSessionOperationalCheckpointPath(projectId, threadId, rootDir);
  if (!existsSync(checkpointPath)) return null;
  const checkpoint = parseOperationalCheckpoint(
    JSON.parse(readFileSync(checkpointPath, "utf8")),
    projectId,
    threadId,
  );
  if (!checkpoint.confirmedClose) return null;
  const exactActiveBinding =
    current.phase === "ACTIVE" &&
    current.binding !== null &&
    current.sessionReceipt !== null &&
    checkpoint.ownerRunId === runId &&
    checkpoint.session?.bundleId === current.bundleId &&
    checkpoint.session.hubSessionId === current.binding.hubSessionId &&
    checkpoint.session.lineageId === current.binding.lineageId &&
    checkpoint.session.incarnation === current.binding.incarnation &&
    checkpoint.confirmedClose.bundleId === current.bundleId;
  if (!exactActiveBinding) {
    throw new Error(
      "Prepared Codex close checkpoint does not match the exact vault owner and bundle",
    );
  }
  return { threadId, ownerRunId: runId, bundleId: current.bundleId };
}

function closeSessionTicketVault(input: {
  projectId: string;
  runId: string;
  rootDir: string;
  vaultPath: string;
  adapters: CodexSessionTicketVaultFileAdapters;
}): void {
  if (!existsSync(input.vaultPath)) return;
  const vault = parseCodexSessionTicketVaultSnapshot(
    JSON.parse(readFileSync(input.vaultPath, "utf8")) as unknown,
  );
  const bundles = [vault.current, vault.successor].filter(
    (bundle): bundle is StoredCodexSessionTicketBundle => bundle !== null,
  );
  if (
    bundles.length === 0 ||
    bundles.some(
      (bundle) =>
        bundle.launchContext.projectId !== input.projectId ||
        bundle.launchContext.runId !== input.runId,
    )
  ) {
    throw new Error("Codex session ticket vault does not match its close transaction");
  }
  const indexes = ownedRecoveryIndexesForRun(input.projectId, input.runId, vault, input.rootDir);
  const checkpoint = preparedCheckpointBindingForClose(
    input.projectId,
    input.runId,
    vault,
    input.rootDir,
  );
  const journalPath = codexSessionTicketCloseJournalPath(
    input.projectId,
    input.runId,
    input.rootDir,
  );
  const prepared: CodexSessionTicketCloseJournal = {
    version: 1,
    projectId: input.projectId,
    runId: input.runId,
    state: "PREPARED",
    vault,
    indexes: indexes.map(({ name, record }) => ({ name, record })),
    checkpoint,
    updatedAt: new Date().toISOString(),
  };
  atomicWritePrivateJson(journalPath, prepared, input.adapters);
  try {
    for (const index of indexes) {
      (input.adapters.unlink ?? unlinkSync)(index.path);
    }
    (input.adapters.unlink ?? unlinkSync)(input.vaultPath);
    if (indexes.length > 0) fsyncDirectoryBestEffort(dirname(indexes[0]!.path));
    fsyncDirectoryBestEffort(dirname(input.vaultPath));
    atomicWritePrivateJson(
      journalPath,
      { ...prepared, state: "COMMITTED", updatedAt: new Date().toISOString() },
      input.adapters,
    );
  } catch (error) {
    rollbackCloseJournal(prepared, journalPath, input.rootDir, error);
  }
  if (!checkpoint) {
    try {
      (input.adapters.unlink ?? unlinkSync)(journalPath);
      fsyncDirectoryBestEffort(dirname(journalPath));
    } catch (error) {
      // A vault-only close has no later checkpoint commit to consume its journal. Restore the replay
      // set and surface failure so the exact close can be retried after the filesystem fault clears.
      rollbackCloseJournal(prepared, journalPath, input.rootDir, error);
    }
  }
}

function parseOperationalCheckpoint(
  value: unknown,
  projectId: string,
  threadId: string,
): CodexSessionOperationalCheckpoint {
  try {
    const checkpoint = parseCodexSessionOperationalCheckpoint(value);
    if (checkpoint.projectId !== projectId || checkpoint.threadId !== threadId) {
      throw new Error("mismatched checkpoint identity");
    }
    return checkpoint;
  } catch {
    throw new Error("Invalid Codex session operational checkpoint");
  }
}

function assertCheckpointTransition(
  previous: CodexSessionOperationalCheckpoint,
  next: CodexSessionOperationalCheckpoint,
): void {
  if (next.eventSequence < previous.eventSequence) {
    throw new Error("Codex operational event cursor cannot move backwards");
  }
  if (!previous.session || !next.session) return;
  if (previous.session.hubSessionId === next.session.hubSessionId) {
    if (
      previous.ownerRunId !== next.ownerRunId ||
      previous.session.lineageId !== next.session.lineageId ||
      previous.session.incarnation !== next.session.incarnation ||
      next.session.nextHeartbeatSequence < previous.session.nextHeartbeatSequence
    ) {
      throw new Error("Codex same-session operational checkpoint cannot change owner or rewind");
    }
    return;
  }
  if (next.session.nextHeartbeatSequence !== 1) {
    throw new Error("A new Codex Hub session must reset its heartbeat sequence to one");
  }
}

export class FileCodexSessionOperationalCheckpointStore implements CodexSessionOperationalCheckpointStore {
  constructor(
    private readonly rootDir = dataDir,
    private readonly fileAdapters: CodexSessionTicketVaultFileAdapters = {},
  ) {}

  async load(
    projectId: string,
    threadId: string,
  ): Promise<CodexSessionOperationalCheckpoint | null> {
    return withRecoveryLock(projectId, this.rootDir, () => {
      const path = codexSessionOperationalCheckpointPath(projectId, threadId, this.rootDir);
      if (!existsSync(path)) return null;
      try {
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("not a regular private file");
        if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
          throw new Error("not owner-private");
        }
        return parseOperationalCheckpoint(
          JSON.parse(readFileSync(path, "utf8")),
          projectId,
          threadId,
        );
      } catch {
        throw new Error("Invalid Codex session operational checkpoint; refusing recovery");
      }
    });
  }

  async save(checkpoint: CodexSessionOperationalCheckpoint): Promise<void> {
    const verified = parseOperationalCheckpoint(
      checkpoint,
      checkpoint.projectId,
      checkpoint.threadId,
    );
    withRecoveryLock(
      verified.projectId,
      this.rootDir,
      () => {
        const path = codexSessionOperationalCheckpointPath(
          verified.projectId,
          verified.threadId,
          this.rootDir,
        );
        let previous: CodexSessionOperationalCheckpoint | null = null;
        if (existsSync(path)) {
          previous = parseOperationalCheckpoint(
            JSON.parse(readFileSync(path, "utf8")),
            verified.projectId,
            verified.threadId,
          );
          assertCheckpointTransition(previous, verified);
        }
        const journalPath = codexSessionTicketCloseJournalPath(
          verified.projectId,
          verified.ownerRunId,
          this.rootDir,
        );
        const journal = existsSync(journalPath)
          ? parseCloseJournal(
              JSON.parse(readFileSync(journalPath, "utf8")),
              verified.projectId,
              verified.ownerRunId,
            )
          : null;
        if (
          !journal &&
          previous?.confirmedClose &&
          (verified.ownerRunId !== previous.ownerRunId ||
            verified.session === null ||
            verified.session?.bundleId !== previous.session?.bundleId ||
            verified.confirmedClose?.bundleId !== previous.confirmedClose.bundleId)
        ) {
          throw new Error(
            "Final Codex close checkpoint is missing its committed vault transaction",
          );
        }
        if (journal?.state === "COMMITTED" && journal.checkpoint) {
          const expected = journal.checkpoint;
          if (
            !previous ||
            !checkpointMatchesPreparedClose(previous, expected) ||
            !checkpointMatchesJournalActiveSession(previous, journal) ||
            !checkpointMatchesCompletedClose(verified, expected)
          ) {
            throw new Error(
              "Final Codex close checkpoint does not match its exact committed vault transaction",
            );
          }
          try {
            atomicWritePrivateJson(path, verified, this.fileAdapters);
            (this.fileAdapters.unlink ?? unlinkSync)(journalPath);
            fsyncDirectoryBestEffort(dirname(journalPath));
          } catch (error) {
            if (existsSync(path)) {
              try {
                const current = parseOperationalCheckpoint(
                  JSON.parse(readFileSync(path, "utf8")),
                  verified.projectId,
                  verified.threadId,
                );
                if (checkpointMatchesCompletedClose(current, expected)) {
                  atomicWritePrivateJson(path, previous);
                  restoreCloseJournal(journal, this.rootDir);
                  if (existsSync(journalPath)) unlinkSync(journalPath);
                  fsyncDirectoryBestEffort(dirname(journalPath));
                }
              } catch (rollbackError) {
                throw new AggregateError(
                  [error, rollbackError],
                  "Codex cross-store close failed and requires journal recovery",
                );
              }
            }
            throw error;
          }
          return;
        }
        if (journal?.state === "COMMITTED") {
          throw new Error("Committed Codex vault close cannot be bypassed by a checkpoint update");
        }
        atomicWritePrivateJson(path, verified, this.fileAdapters);
      },
      {},
      verified.ownerRunId,
    );
  }
}

/**
 * Raw Codex Adapter tickets live only in this owner-private, atomically replaced vault. The file
 * path contains launch identities but never a raw ticket or digest, and errors deliberately avoid
 * echoing parsed contents.
 */
export class FileCodexSessionTicketVault implements CodexSessionTicketVault {
  readonly path: string;

  constructor(input: {
    projectId: string;
    runId: string;
    rootDir?: string;
    fileAdapters?: CodexSessionTicketVaultFileAdapters;
  }) {
    this.projectId = input.projectId;
    this.runId = input.runId;
    this.rootDir = input.rootDir ?? dataDir;
    this.fileAdapters = input.fileAdapters ?? {};
    this.path = codexSessionTicketVaultPath(this.projectId, this.runId, this.rootDir);
  }

  async load(): Promise<CodexSessionTicketVaultSnapshot | null> {
    return withRecoveryLock(this.projectId, this.rootDir, () => {
      if (!existsSync(this.path)) return null;
      try {
        const stat = lstatSync(this.path);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("not a regular private file");
        return parseCodexSessionTicketVaultSnapshot(
          JSON.parse(readFileSync(this.path, "utf8")) as unknown,
        );
      } catch {
        throw new Error("Invalid Codex session ticket vault; refusing credential recovery");
      }
    });
  }

  async save(snapshot: CodexSessionTicketVaultSnapshot): Promise<void> {
    const verified = parseCodexSessionTicketVaultSnapshot(snapshot);
    withRecoveryLock(this.projectId, this.rootDir, () => {
      if (verified.current === null && verified.successor === null) {
        closeSessionTicketVault({
          projectId: this.projectId,
          runId: this.runId,
          rootDir: this.rootDir,
          vaultPath: this.path,
          adapters: this.fileAdapters,
        });
        return;
      }
      atomicWritePrivateJson(this.path, verified);
    });
  }

  private readonly projectId: string;
  private readonly runId: string;
  private readonly rootDir: string;
  private readonly fileAdapters: CodexSessionTicketVaultFileAdapters;
}
