import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";

import type { ReleaseIdentity } from "./atomic-release-manager.js";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SNAPSHOT_ID_PATTERN = /^snap_[A-Za-z0-9_-]{1,120}$/;
const FENCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const LOGICAL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,239}$/;
const MAX_STATE_FILE_BYTES = 8 * 1024 * 1024;
const MANIFEST_NAME = "manifest.json";
const DATABASE_LOGICAL_NAME = "database/crossagent.db";
const RELEASE_POINTER_LOGICAL_NAME = "release/pointer.json";
const ARTIFACT_DESCRIPTOR_LOGICAL_NAME = "release/artifact-descriptor.json";
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
const AUTHORITY_PRIVATE_KEY_PATH = ["authority", "ed25519-private-key.pem"] as const;
const AUTHORITY_PUBLIC_TRUST_MANIFEST_PATH = ["authority", "trusted-signing-keys.json"] as const;

/**
 * The manifest is public, but rolling it back can resurrect a retired signing key. It is security
 * state rather than ordinary config and is never captured or restored by a release snapshot.
 */
export const PUBLIC_TRUST_MANIFEST_SNAPSHOT_POLICY = "NEVER_CAPTURE_OR_RESTORE" as const;
const DEFAULT_SECRET_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}={0,2}\b/i,
  /\b(?:hub-token|bridge-token|xoxb|sk)-[A-Za-z0-9_-]{8,}\b/i,
  /\bCROSSAGENT_[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD)\s*=\s*\S+/,
];

export type SqliteBackupReceipt = {
  method: "SQLITE_BACKUP_API";
  sourceJournalMode: "WAL" | string;
  sourceQuickCheck: "ok" | string;
  backupQuickCheck: "ok" | string;
};

export type SqliteRestoreReceipt = {
  method: "SQLITE_BACKUP_API";
  restoredQuickCheck: "ok" | string;
};

/**
 * The production adapter must call SQLite's Backup API. File copying a live WAL
 * database is not a conforming implementation of this seam.
 */
export interface SqliteBackupAdapter {
  backupOnline(sourcePath: string, destinationPath: string): Promise<SqliteBackupReceipt>;
  restoreQuiesced(sourceBackupPath: string, destinationPath: string): Promise<SqliteRestoreReceipt>;
}

export type ReleaseSnapshotFileRole = "RELEASE_POINTER" | "ARTIFACT_DESCRIPTOR";

export type ReleaseSnapshotPolicy = {
  dataRoot: string;
  snapshotRoot: string;
  databasePath: string;
  releaseFiles: Array<{
    role: ReleaseSnapshotFileRole;
    logicalName: string;
    targetPath: string;
  }>;
  candidateOwnedConfig: Array<{
    logicalName: string;
    targetPath: string;
  }>;
};

export type SnapshotArtifact = {
  logicalName: string;
  relativePath: string;
  size: number;
  sha256: string;
};

export type ReleaseSnapshotArtifact = SnapshotArtifact & {
  role: ReleaseSnapshotFileRole;
};

export type CandidateConfigSnapshotArtifact = SnapshotArtifact & {
  role: "CANDIDATE_OWNED_CONFIG";
  expectedCandidateSha256: string;
};

export type QuiescenceProof = {
  state: "QUIESCED";
  fenceId: string;
  stopReceiptId: string;
  observedAt: string;
};

export type ReleaseQuiescenceReceipt =
  | {
      state: "CONFIRMED";
      runtimeState: "STOPPED";
      sourceIdentity: ReleaseIdentity;
      fenceId: string;
      stopReceiptId: string;
      observedAt: string;
    }
  | { state: "REJECTED"; code: string }
  | { state: "AMBIGUOUS"; code: string };

/** The adapter must observe the quiescence fence and stopped runtime, not trust caller text. */
export interface ReleaseQuiescenceAdapter {
  verifyFinalSnapshotReady(input: {
    sourceIdentity: ReleaseIdentity;
    quiescenceProof: QuiescenceProof;
  }): Promise<ReleaseQuiescenceReceipt>;
}

type ReleaseSnapshotManifestCommon = {
  schemaVersion: 1;
  snapshotId: string;
  sourceIdentity: ReleaseIdentity;
  createdAt: string;
  database: {
    strategy: "SQLITE_BACKUP_API";
    sourceJournalMode: "WAL";
    sourceQuickCheck: "ok";
    backupQuickCheck: "ok";
    artifact: SnapshotArtifact & { role: "DATABASE" };
  };
  releaseFiles: ReleaseSnapshotArtifact[];
  excludedFromRestore: [...typeof EXCLUDED_RESTORE_CATEGORIES];
};

export type OnlinePreflightSnapshotManifest = ReleaseSnapshotManifestCommon & {
  snapshotKind: "ONLINE_PREFLIGHT";
  restoreEligible: false;
  quiescenceProof: null;
  configFiles: [];
  manifestSha256: string;
};

export type FinalRollbackSnapshotManifest = ReleaseSnapshotManifestCommon & {
  snapshotKind: "FINAL_ROLLBACK";
  restoreEligible: true;
  quiescenceProof: QuiescenceProof;
  configFiles: CandidateConfigSnapshotArtifact[];
  manifestSha256: string;
};

export type ReleaseSnapshotManifest =
  OnlinePreflightSnapshotManifest | FinalRollbackSnapshotManifest;

export type StoredReleaseSnapshot<TManifest extends ReleaseSnapshotManifest> = {
  snapshotDirectory: string;
  manifest: TManifest;
};

export type OnlinePreflightSnapshotRequest = {
  snapshotId: string;
  sourceIdentity: ReleaseIdentity;
  createdAt: string;
  secretCanaries?: string[];
};

export type FinalRollbackSnapshotRequest = OnlinePreflightSnapshotRequest & {
  quiescenceProof: QuiescenceProof;
  expectedCandidateConfigSha256: Record<string, string>;
};

export type RestoreFinalRollbackSnapshotRequest = {
  snapshotDirectory: string;
  expectedSnapshotId: string;
  expectedSourceIdentity: ReleaseIdentity;
  secretCanaries?: string[];
};

export type RestoreFinalRollbackSnapshotResult = {
  database: "RESTORED";
  releaseFiles: string[];
  configFiles: Array<{
    logicalName: string;
    state: "RESTORED" | "SKIPPED_CAS_MISMATCH";
  }>;
};

export type ReleaseSnapshotErrorCode =
  | "RESTORE_POLICY_INVALID"
  | "SNAPSHOT_REQUEST_INVALID"
  | "SNAPSHOT_ALREADY_EXISTS"
  | "SNAPSHOT_ROOT_INVALID"
  | "SOURCE_NOT_REGULAR"
  | "TARGET_NOT_REGULAR"
  | "STATE_FILE_TOO_LARGE"
  | "SENSITIVE_SECURITY_STATE_PATH"
  | "SECRET_CANARY_DETECTED"
  | "QUIESCENCE_NOT_CONFIRMED"
  | "SQLITE_BACKUP_FAILED"
  | "SQLITE_BACKUP_NOT_WAL_SAFE"
  | "SQLITE_QUICK_CHECK_FAILED"
  | "SNAPSHOT_PUBLISH_FAILED"
  | "SNAPSHOT_DIRECTORY_INVALID"
  | "SNAPSHOT_MANIFEST_INVALID"
  | "SNAPSHOT_MANIFEST_HASH_MISMATCH"
  | "SNAPSHOT_ARTIFACT_HASH_MISMATCH"
  | "SNAPSHOT_KIND_NOT_RESTORABLE"
  | "SNAPSHOT_IDENTITY_MISMATCH"
  | "SQLITE_RESTORE_FAILED"
  | "SQLITE_RESTORE_QUICK_CHECK_FAILED"
  | "RESTORE_WRITE_FAILED";

export class ReleaseSnapshotError extends Error {
  constructor(
    readonly code: ReleaseSnapshotErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ReleaseSnapshotError";
  }
}

export type ReleaseSnapshotCoordinatorOptions = {
  policy: ReleaseSnapshotPolicy;
  sqlite: SqliteBackupAdapter;
  quiescence: ReleaseQuiescenceAdapter;
};

type ManifestUnsigned = Omit<ReleaseSnapshotManifest, "manifestSha256">;

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`)
    .join(",")}}`;
}

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function digestManifest(value: ManifestUnsigned): string {
  return digest(canonicalize(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  code: ReleaseSnapshotErrorCode = "SNAPSHOT_MANIFEST_INVALID",
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new ReleaseSnapshotError(code, "Snapshot object contains unexpected fields");
  }
}

function assertIsoTimestamp(
  value: unknown,
  code: ReleaseSnapshotErrorCode,
): asserts value is string {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new ReleaseSnapshotError(code, "Timestamp must be a canonical ISO-8601 value");
  }
}

function assertReleaseIdentity(
  value: unknown,
  code: ReleaseSnapshotErrorCode,
): asserts value is ReleaseIdentity {
  if (!isRecord(value)) throw new ReleaseSnapshotError(code, "Release identity is invalid");
  exactKeys(
    value,
    ["buildId", "buildSessionId", "manifestSha256", "migrationId", "protocolId"],
    code,
  );
  if (
    typeof value.buildId !== "string" ||
    !SHA256_PATTERN.test(value.buildId) ||
    typeof value.buildSessionId !== "string" ||
    !UUID_PATTERN.test(value.buildSessionId) ||
    typeof value.protocolId !== "string" ||
    !SHA256_PATTERN.test(value.protocolId) ||
    typeof value.manifestSha256 !== "string" ||
    !SHA256_PATTERN.test(value.manifestSha256) ||
    typeof value.migrationId !== "string" ||
    !SHA256_PATTERN.test(value.migrationId)
  ) {
    throw new ReleaseSnapshotError(code, "Release identity is invalid");
  }
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

function assertLogicalName(value: string, expectedPrefix?: "config/"): void {
  if (
    !LOGICAL_NAME_PATTERN.test(value) ||
    path.posix.isAbsolute(value) ||
    value.includes("\\") ||
    value.split("/").some((segment) => segment === "" || segment === "." || segment === "..") ||
    (expectedPrefix !== undefined && !value.startsWith(expectedPrefix))
  ) {
    throw new ReleaseSnapshotError("RESTORE_POLICY_INVALID", "Logical path is invalid");
  }
  const firstSegment = value.split("/")[0]!.toLowerCase();
  if (FORBIDDEN_LOGICAL_SEGMENTS.has(firstSegment)) {
    throw new ReleaseSnapshotError(
      "RESTORE_POLICY_INVALID",
      "Logical path belongs to a never-restore category",
    );
  }
  assertSegmentsNotSensitive(value.split("/"));
}

function normalizePathSegment(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}

function compactPathSegment(value: string): string {
  return normalizePathSegment(value).replace(/[^a-z0-9]/g, "");
}

function samePathSegments(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((segment, index) => normalizePathSegment(segment) === right[index])
  );
}

function sensitiveSecurityCategory(segmentsInput: readonly string[]): string | null {
  const segments = segmentsInput.filter(Boolean).map(normalizePathSegment);
  const basename = segments.at(-1);
  if (!basename) return null;
  if (CREDENTIAL_BASENAMES.has(basename)) return "STATIC_CREDENTIAL";
  if (samePathSegments(segments, AUTHORITY_PRIVATE_KEY_PATH)) return "AUTHORITY_PRIVATE_KEY";
  if (samePathSegments(segments, AUTHORITY_PUBLIC_TRUST_MANIFEST_PATH)) {
    return "AUTHORITY_PUBLIC_TRUST_MANIFEST";
  }
  const compactBasename = compactPathSegment(basename);
  if (
    compactBasename.startsWith("credentialrotationjournal") ||
    compactBasename.startsWith("securityrotationjournal") ||
    (compactBasename.startsWith("rotationjournal") && segments.includes("security"))
  ) {
    return "SECURITY_ROTATION_JOURNAL";
  }
  if (
    compactBasename.startsWith("securityepoch") ||
    compactBasename.startsWith("credentialepoch") ||
    segments.some(
      (segment, index) =>
        segment === "security" &&
        (segments[index + 1] === "epoch" || segments[index + 1] === "epochs"),
    ) ||
    ((compactBasename.startsWith("epoch") || compactBasename.startsWith("epochs")) &&
      segments.includes("security"))
  ) {
    return "SECURITY_EPOCH";
  }
  return null;
}

function assertSegmentsNotSensitive(segments: readonly string[]): void {
  const category = sensitiveSecurityCategory(segments);
  if (category) {
    throw new ReleaseSnapshotError(
      "SENSITIVE_SECURITY_STATE_PATH",
      `Release snapshots never capture or restore ${category}`,
    );
  }
}

function relativePathSegments(root: string, targetPath: string): string[] {
  return path
    .relative(root, targetPath)
    .split(/[\\/]+/u)
    .filter(Boolean);
}

function assertResolvedPathNotSensitive(root: string, targetPath: string): void {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(targetPath);
  const segments = pathWithin(resolvedRoot, resolvedTarget)
    ? relativePathSegments(resolvedRoot, resolvedTarget)
    : resolvedTarget.split(/[\\/]+/u).filter(Boolean);
  assertSegmentsNotSensitive(segments);
}

function pathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative !== "" &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== ".." &&
    !path.isAbsolute(relative)
  );
}

function clonePolicy(policy: ReleaseSnapshotPolicy): ReleaseSnapshotPolicy {
  return {
    dataRoot: path.resolve(policy.dataRoot),
    snapshotRoot: path.resolve(policy.snapshotRoot),
    databasePath: path.resolve(policy.databasePath),
    releaseFiles: policy.releaseFiles.map((entry) => ({
      ...entry,
      targetPath: path.resolve(entry.targetPath),
    })),
    candidateOwnedConfig: policy.candidateOwnedConfig.map((entry) => ({
      ...entry,
      targetPath: path.resolve(entry.targetPath),
    })),
  };
}

function validatePolicy(input: ReleaseSnapshotPolicy): ReleaseSnapshotPolicy {
  if (
    !path.isAbsolute(input.dataRoot) ||
    !path.isAbsolute(input.snapshotRoot) ||
    !path.isAbsolute(input.databasePath) ||
    input.releaseFiles.some((entry) => !path.isAbsolute(entry.targetPath)) ||
    input.candidateOwnedConfig.some((entry) => !path.isAbsolute(entry.targetPath))
  ) {
    throw new ReleaseSnapshotError("RESTORE_POLICY_INVALID", "Policy paths must be absolute");
  }
  const policy = clonePolicy(input);
  assertResolvedPathNotSensitive(policy.dataRoot, policy.databasePath);
  if (!pathWithin(policy.dataRoot, policy.databasePath)) {
    throw new ReleaseSnapshotError("RESTORE_POLICY_INVALID", "Database is outside the data root");
  }
  if (policy.releaseFiles.length !== 2) {
    throw new ReleaseSnapshotError(
      "RESTORE_POLICY_INVALID",
      "Exactly one release pointer and artifact descriptor are required",
    );
  }
  const requiredReleaseNames = new Map<ReleaseSnapshotFileRole, string>([
    ["RELEASE_POINTER", RELEASE_POINTER_LOGICAL_NAME],
    ["ARTIFACT_DESCRIPTOR", ARTIFACT_DESCRIPTOR_LOGICAL_NAME],
  ]);
  const seenRoles = new Set<ReleaseSnapshotFileRole>();
  const seenNames = new Set<string>([DATABASE_LOGICAL_NAME]);
  const seenTargets = new Set<string>([policy.databasePath.toLowerCase()]);
  for (const entry of policy.releaseFiles) {
    assertLogicalName(entry.logicalName);
    if (entry.logicalName !== requiredReleaseNames.get(entry.role) || seenRoles.has(entry.role)) {
      throw new ReleaseSnapshotError(
        "RESTORE_POLICY_INVALID",
        "Release metadata allowlist is invalid",
      );
    }
    if (!pathWithin(policy.dataRoot, entry.targetPath)) {
      throw new ReleaseSnapshotError(
        "RESTORE_POLICY_INVALID",
        "Release target is outside data root",
      );
    }
    assertResolvedPathNotSensitive(policy.dataRoot, entry.targetPath);
    if (seenNames.has(entry.logicalName) || seenTargets.has(entry.targetPath.toLowerCase())) {
      throw new ReleaseSnapshotError("RESTORE_POLICY_INVALID", "Restore target is duplicated");
    }
    seenRoles.add(entry.role);
    seenNames.add(entry.logicalName);
    seenTargets.add(entry.targetPath.toLowerCase());
  }
  for (const entry of policy.candidateOwnedConfig) {
    assertLogicalName(entry.logicalName, "config/");
    if (!pathWithin(policy.dataRoot, entry.targetPath)) {
      throw new ReleaseSnapshotError(
        "RESTORE_POLICY_INVALID",
        "Config target is outside data root",
      );
    }
    assertResolvedPathNotSensitive(policy.dataRoot, entry.targetPath);
    if (seenNames.has(entry.logicalName) || seenTargets.has(entry.targetPath.toLowerCase())) {
      throw new ReleaseSnapshotError("RESTORE_POLICY_INVALID", "Restore target is duplicated");
    }
    seenNames.add(entry.logicalName);
    seenTargets.add(entry.targetPath.toLowerCase());
  }
  return policy;
}

async function assertDirectoryNoSymlink(
  directoryPath: string,
  code: ReleaseSnapshotErrorCode,
): Promise<void> {
  let stats;
  try {
    stats = await lstat(directoryPath);
  } catch {
    throw new ReleaseSnapshotError(code, "Required directory does not exist");
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new ReleaseSnapshotError(code, "Required directory is not a regular directory");
  }
}

async function assertNoSymlinkComponents(
  root: string,
  targetPath: string,
  allowMissingLeaf: boolean,
  code: ReleaseSnapshotErrorCode,
): Promise<void> {
  if (path.resolve(root) === path.resolve(targetPath)) {
    await assertDirectoryNoSymlink(root, code);
    return;
  }
  if (!pathWithin(root, targetPath)) {
    throw new ReleaseSnapshotError(code, "Path escaped its configured root");
  }
  const relative = path.relative(root, targetPath);
  const segments = relative.split(path.sep);
  let cursor = root;
  for (let index = 0; index < segments.length; index += 1) {
    cursor = path.join(cursor, segments[index]!);
    try {
      const stats = await lstat(cursor);
      if (stats.isSymbolicLink()) {
        throw new ReleaseSnapshotError(code, "Symbolic links are not accepted");
      }
    } catch (error) {
      if (
        allowMissingLeaf &&
        index === segments.length - 1 &&
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return;
      }
      if (error instanceof ReleaseSnapshotError) throw error;
      throw new ReleaseSnapshotError(code, "Path component does not exist");
    }
  }
}

async function readRegularFile(
  root: string,
  filePath: string,
  maximumBytes = MAX_STATE_FILE_BYTES,
): Promise<Buffer> {
  await assertNoSymlinkComponents(root, filePath, false, "SOURCE_NOT_REGULAR");
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat();
    if (!before.isFile())
      throw new ReleaseSnapshotError("SOURCE_NOT_REGULAR", "Source is not regular");
    if (before.size > maximumBytes) {
      throw new ReleaseSnapshotError("STATE_FILE_TOO_LARGE", "State file exceeds size limit");
    }
    const value = await handle.readFile();
    const after = await handle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size) {
      throw new ReleaseSnapshotError("SOURCE_NOT_REGULAR", "Source changed while it was read");
    }
    return value;
  } catch (error) {
    if (error instanceof ReleaseSnapshotError) throw error;
    throw new ReleaseSnapshotError("SOURCE_NOT_REGULAR", "Source could not be read safely");
  } finally {
    await handle?.close();
  }
}

async function hashRegularFile(
  root: string,
  filePath: string,
): Promise<{ size: number; sha256: string }> {
  await assertNoSymlinkComponents(root, filePath, false, "SOURCE_NOT_REGULAR");
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat();
    if (!before.isFile())
      throw new ReleaseSnapshotError("SOURCE_NOT_REGULAR", "Source is not regular");
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    while (offset < before.size) {
      const length = Math.min(buffer.length, before.size - offset);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (
      offset !== before.size ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size
    ) {
      throw new ReleaseSnapshotError("SOURCE_NOT_REGULAR", "Source changed while it was hashed");
    }
    return { size: before.size, sha256: hash.digest("hex") };
  } catch (error) {
    if (error instanceof ReleaseSnapshotError) throw error;
    throw new ReleaseSnapshotError("SOURCE_NOT_REGULAR", "Source could not be hashed safely");
  } finally {
    await handle?.close();
  }
}

async function fsyncDirectory(directoryPath: string): Promise<void> {
  let handle;
  try {
    handle = await open(directoryPath, constants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : null;
    if (process.platform !== "win32" || !["EINVAL", "ENOTSUP", "EPERM"].includes(String(code))) {
      throw error;
    }
  } finally {
    await handle?.close();
  }
}

async function ensurePrivateDirectory(root: string, directoryPath: string): Promise<void> {
  if (directoryPath !== root && !pathWithin(root, directoryPath)) {
    throw new ReleaseSnapshotError("SNAPSHOT_PUBLISH_FAILED", "Snapshot path escaped staging root");
  }
  await mkdir(directoryPath, { recursive: true, mode: 0o700 });
  await chmod(directoryPath, 0o700);
  await assertDirectoryNoSymlink(directoryPath, "SNAPSHOT_PUBLISH_FAILED");
}

async function atomicWritePrivateFile(
  root: string,
  targetPath: string,
  content: Buffer,
): Promise<void> {
  if (!pathWithin(root, targetPath)) {
    throw new ReleaseSnapshotError("RESTORE_WRITE_FAILED", "Target escaped its configured root");
  }
  const parent = path.dirname(targetPath);
  await assertNoSymlinkComponents(root, parent, false, "TARGET_NOT_REGULAR");
  try {
    const current = await lstat(targetPath);
    if (current.isSymbolicLink() || !current.isFile()) {
      throw new ReleaseSnapshotError("TARGET_NOT_REGULAR", "Target is not a regular file");
    }
  } catch (error) {
    if (
      !(error instanceof Error && "code" in error && error.code === "ENOENT") ||
      error instanceof ReleaseSnapshotError
    ) {
      throw error;
    }
  }
  const temporaryPath = path.join(parent, `.${path.basename(targetPath)}.tmp-${randomUUID()}`);
  let handle;
  try {
    handle = await open(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(content);
    await handle.sync();
    await handle.chmod(0o600);
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, targetPath);
    await chmod(targetPath, 0o600);
    await fsyncDirectory(parent);
  } catch (error) {
    await handle?.close();
    await rm(temporaryPath, { force: true });
    if (error instanceof ReleaseSnapshotError) throw error;
    throw new ReleaseSnapshotError("RESTORE_WRITE_FAILED", "Atomic state-file write failed");
  }
}

function assertNoSecrets(value: Buffer | string, canaries: readonly string[]): void {
  const text = Buffer.isBuffer(value) ? value.toString("utf8") : value;
  if (
    canaries.some((canary) => canary.length > 0 && text.includes(canary)) ||
    DEFAULT_SECRET_PATTERNS.some((pattern) => pattern.test(text))
  ) {
    throw new ReleaseSnapshotError(
      "SECRET_CANARY_DETECTED",
      "Secret-shaped material is not permitted in release metadata snapshots",
    );
  }
}

function validateCreateRequest(request: OnlinePreflightSnapshotRequest): void {
  if (!SNAPSHOT_ID_PATTERN.test(request.snapshotId)) {
    throw new ReleaseSnapshotError("SNAPSHOT_REQUEST_INVALID", "Snapshot id is invalid");
  }
  assertReleaseIdentity(request.sourceIdentity, "SNAPSHOT_REQUEST_INVALID");
  assertIsoTimestamp(request.createdAt, "SNAPSHOT_REQUEST_INVALID");
  for (const canary of request.secretCanaries ?? []) {
    if (typeof canary !== "string" || canary.length < 8 || canary.length > 1024) {
      throw new ReleaseSnapshotError("SNAPSHOT_REQUEST_INVALID", "Secret canary is invalid");
    }
  }
}

function artifactFromUnknown(value: unknown, role?: ReleaseSnapshotFileRole): SnapshotArtifact {
  if (!isRecord(value)) {
    throw new ReleaseSnapshotError("SNAPSHOT_MANIFEST_INVALID", "Artifact is invalid");
  }
  const expectedKeys =
    role === undefined
      ? ["logicalName", "relativePath", "role", "sha256", "size"]
      : ["logicalName", "relativePath", "role", "sha256", "size"];
  exactKeys(value, expectedKeys);
  if (
    typeof value.logicalName !== "string" ||
    typeof value.relativePath !== "string" ||
    value.logicalName !== value.relativePath ||
    typeof value.size !== "number" ||
    !Number.isSafeInteger(value.size) ||
    value.size < 0 ||
    typeof value.sha256 !== "string" ||
    !SHA256_PATTERN.test(value.sha256)
  ) {
    throw new ReleaseSnapshotError("SNAPSHOT_MANIFEST_INVALID", "Artifact fields are invalid");
  }
  assertLogicalNameForManifest(value.logicalName);
  return {
    logicalName: value.logicalName,
    relativePath: value.relativePath,
    size: value.size,
    sha256: value.sha256,
  };
}

function assertLogicalNameForManifest(value: string): void {
  try {
    assertLogicalName(value);
  } catch (error) {
    if (error instanceof ReleaseSnapshotError && error.code === "SENSITIVE_SECURITY_STATE_PATH") {
      throw error;
    }
    throw new ReleaseSnapshotError("SNAPSHOT_MANIFEST_INVALID", "Manifest path is invalid");
  }
}

function parseManifest(raw: Buffer): ReleaseSnapshotManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new ReleaseSnapshotError("SNAPSHOT_MANIFEST_INVALID", "Manifest is not valid JSON");
  }
  if (!isRecord(parsed)) {
    throw new ReleaseSnapshotError("SNAPSHOT_MANIFEST_INVALID", "Manifest is invalid");
  }
  exactKeys(parsed, [
    "configFiles",
    "createdAt",
    "database",
    "excludedFromRestore",
    "manifestSha256",
    "quiescenceProof",
    "releaseFiles",
    "restoreEligible",
    "schemaVersion",
    "snapshotId",
    "snapshotKind",
    "sourceIdentity",
  ]);
  if (
    parsed.schemaVersion !== 1 ||
    typeof parsed.snapshotId !== "string" ||
    !SNAPSHOT_ID_PATTERN.test(parsed.snapshotId) ||
    (parsed.snapshotKind !== "ONLINE_PREFLIGHT" && parsed.snapshotKind !== "FINAL_ROLLBACK") ||
    typeof parsed.manifestSha256 !== "string" ||
    !SHA256_PATTERN.test(parsed.manifestSha256)
  ) {
    throw new ReleaseSnapshotError("SNAPSHOT_MANIFEST_INVALID", "Manifest header is invalid");
  }
  assertReleaseIdentity(parsed.sourceIdentity, "SNAPSHOT_MANIFEST_INVALID");
  assertIsoTimestamp(parsed.createdAt, "SNAPSHOT_MANIFEST_INVALID");
  if (!isRecord(parsed.database)) {
    throw new ReleaseSnapshotError("SNAPSHOT_MANIFEST_INVALID", "Database manifest is invalid");
  }
  exactKeys(parsed.database, [
    "artifact",
    "backupQuickCheck",
    "sourceJournalMode",
    "sourceQuickCheck",
    "strategy",
  ]);
  if (
    parsed.database.strategy !== "SQLITE_BACKUP_API" ||
    parsed.database.sourceJournalMode !== "WAL" ||
    parsed.database.sourceQuickCheck !== "ok" ||
    parsed.database.backupQuickCheck !== "ok" ||
    !isRecord(parsed.database.artifact) ||
    parsed.database.artifact.role !== "DATABASE"
  ) {
    throw new ReleaseSnapshotError("SNAPSHOT_MANIFEST_INVALID", "Database proof is invalid");
  }
  const databaseArtifact = artifactFromUnknown(parsed.database.artifact);
  if (databaseArtifact.logicalName !== DATABASE_LOGICAL_NAME) {
    throw new ReleaseSnapshotError("SNAPSHOT_MANIFEST_INVALID", "Database path is invalid");
  }
  if (!Array.isArray(parsed.releaseFiles) || !Array.isArray(parsed.configFiles)) {
    throw new ReleaseSnapshotError("SNAPSHOT_MANIFEST_INVALID", "Artifact lists are invalid");
  }
  const releaseFiles = parsed.releaseFiles.map((item) => {
    if (
      !isRecord(item) ||
      (item.role !== "RELEASE_POINTER" && item.role !== "ARTIFACT_DESCRIPTOR")
    ) {
      throw new ReleaseSnapshotError("SNAPSHOT_MANIFEST_INVALID", "Release role is invalid");
    }
    return {
      ...artifactFromUnknown(item, item.role),
      role: item.role as ReleaseSnapshotFileRole,
    };
  });
  const configFiles = parsed.configFiles.map((item) => {
    if (!isRecord(item)) {
      throw new ReleaseSnapshotError("SNAPSHOT_MANIFEST_INVALID", "Config artifact is invalid");
    }
    exactKeys(item, [
      "expectedCandidateSha256",
      "logicalName",
      "relativePath",
      "role",
      "sha256",
      "size",
    ]);
    if (
      item.role !== "CANDIDATE_OWNED_CONFIG" ||
      typeof item.expectedCandidateSha256 !== "string" ||
      !SHA256_PATTERN.test(item.expectedCandidateSha256)
    ) {
      throw new ReleaseSnapshotError("SNAPSHOT_MANIFEST_INVALID", "Config CAS proof is invalid");
    }
    const base = artifactFromUnknown({
      logicalName: item.logicalName,
      relativePath: item.relativePath,
      role: item.role,
      sha256: item.sha256,
      size: item.size,
    });
    if (!base.logicalName.startsWith("config/")) {
      throw new ReleaseSnapshotError("SNAPSHOT_MANIFEST_INVALID", "Config path is invalid");
    }
    return {
      ...base,
      role: "CANDIDATE_OWNED_CONFIG" as const,
      expectedCandidateSha256: item.expectedCandidateSha256,
    };
  });
  if (
    !Array.isArray(parsed.excludedFromRestore) ||
    canonicalize(parsed.excludedFromRestore) !== canonicalize(EXCLUDED_RESTORE_CATEGORIES)
  ) {
    throw new ReleaseSnapshotError("SNAPSHOT_MANIFEST_INVALID", "Restore exclusions are invalid");
  }
  let quiescenceProof: QuiescenceProof | null = null;
  if (parsed.snapshotKind === "ONLINE_PREFLIGHT") {
    if (
      parsed.restoreEligible !== false ||
      parsed.quiescenceProof !== null ||
      configFiles.length !== 0
    ) {
      throw new ReleaseSnapshotError(
        "SNAPSHOT_MANIFEST_INVALID",
        "Preflight snapshot is restorable",
      );
    }
  } else {
    if (parsed.restoreEligible !== true || !isRecord(parsed.quiescenceProof)) {
      throw new ReleaseSnapshotError(
        "SNAPSHOT_MANIFEST_INVALID",
        "Final snapshot proof is invalid",
      );
    }
    exactKeys(parsed.quiescenceProof, ["fenceId", "observedAt", "state", "stopReceiptId"]);
    if (
      parsed.quiescenceProof.state !== "QUIESCED" ||
      typeof parsed.quiescenceProof.fenceId !== "string" ||
      !FENCE_ID_PATTERN.test(parsed.quiescenceProof.fenceId) ||
      typeof parsed.quiescenceProof.stopReceiptId !== "string" ||
      !FENCE_ID_PATTERN.test(parsed.quiescenceProof.stopReceiptId)
    ) {
      throw new ReleaseSnapshotError(
        "SNAPSHOT_MANIFEST_INVALID",
        "Final snapshot proof is invalid",
      );
    }
    assertIsoTimestamp(parsed.quiescenceProof.observedAt, "SNAPSHOT_MANIFEST_INVALID");
    quiescenceProof = {
      state: "QUIESCED",
      fenceId: parsed.quiescenceProof.fenceId,
      stopReceiptId: parsed.quiescenceProof.stopReceiptId,
      observedAt: parsed.quiescenceProof.observedAt,
    };
  }
  const common = {
    schemaVersion: 1 as const,
    snapshotId: parsed.snapshotId,
    sourceIdentity: parsed.sourceIdentity,
    createdAt: parsed.createdAt,
    database: {
      strategy: "SQLITE_BACKUP_API" as const,
      sourceJournalMode: "WAL" as const,
      sourceQuickCheck: "ok" as const,
      backupQuickCheck: "ok" as const,
      artifact: { ...databaseArtifact, role: "DATABASE" as const },
    },
    releaseFiles,
    excludedFromRestore: [...EXCLUDED_RESTORE_CATEGORIES] as [
      ...typeof EXCLUDED_RESTORE_CATEGORIES,
    ],
    manifestSha256: parsed.manifestSha256,
  };
  const manifest: ReleaseSnapshotManifest =
    parsed.snapshotKind === "ONLINE_PREFLIGHT"
      ? {
          ...common,
          snapshotKind: "ONLINE_PREFLIGHT",
          restoreEligible: false,
          quiescenceProof: null,
          configFiles: [],
        }
      : {
          ...common,
          snapshotKind: "FINAL_ROLLBACK",
          restoreEligible: true,
          quiescenceProof: quiescenceProof!,
          configFiles,
        };
  const { manifestSha256, ...unsigned } = manifest;
  if (digestManifest(unsigned) !== manifestSha256) {
    throw new ReleaseSnapshotError(
      "SNAPSHOT_MANIFEST_HASH_MISMATCH",
      "Snapshot manifest digest does not match",
    );
  }
  return manifest;
}

function artifactRecord(
  logicalName: string,
  details: { size: number; sha256: string },
): SnapshotArtifact {
  return {
    logicalName,
    relativePath: logicalName,
    size: details.size,
    sha256: details.sha256,
  };
}

async function assertSnapshotRoot(root: string): Promise<void> {
  await assertDirectoryNoSymlink(root, "SNAPSHOT_ROOT_INVALID");
  await chmod(root, 0o700);
}

function sealManifest<T extends ManifestUnsigned>(unsigned: T): T & { manifestSha256: string } {
  return { ...unsigned, manifestSha256: digestManifest(unsigned) };
}

export class ReleaseSnapshotCoordinator {
  private readonly policy: ReleaseSnapshotPolicy;
  private readonly sqlite: SqliteBackupAdapter;
  private readonly quiescence: ReleaseQuiescenceAdapter;

  constructor(options: ReleaseSnapshotCoordinatorOptions) {
    this.policy = validatePolicy(options.policy);
    this.sqlite = options.sqlite;
    this.quiescence = options.quiescence;
  }

  async createOnlinePreflightSnapshot(
    request: OnlinePreflightSnapshotRequest,
  ): Promise<StoredReleaseSnapshot<OnlinePreflightSnapshotManifest>> {
    await this.assertNoSensitivePolicyAliases();
    return this.createSnapshot("ONLINE_PREFLIGHT", request);
  }

  async createFinalRollbackSnapshot(
    request: FinalRollbackSnapshotRequest,
  ): Promise<StoredReleaseSnapshot<FinalRollbackSnapshotManifest>> {
    validateCreateRequest(request);
    await this.assertNoSensitivePolicyAliases();
    if (
      request.quiescenceProof.state !== "QUIESCED" ||
      !FENCE_ID_PATTERN.test(request.quiescenceProof.fenceId) ||
      !FENCE_ID_PATTERN.test(request.quiescenceProof.stopReceiptId)
    ) {
      throw new ReleaseSnapshotError("SNAPSHOT_REQUEST_INVALID", "Quiescence proof is invalid");
    }
    assertIsoTimestamp(request.quiescenceProof.observedAt, "SNAPSHOT_REQUEST_INVALID");
    if (Date.parse(request.quiescenceProof.observedAt) > Date.parse(request.createdAt)) {
      throw new ReleaseSnapshotError(
        "SNAPSHOT_REQUEST_INVALID",
        "Quiescence proof cannot postdate the snapshot",
      );
    }
    let quiescenceReceipt: ReleaseQuiescenceReceipt;
    try {
      quiescenceReceipt = await this.quiescence.verifyFinalSnapshotReady({
        sourceIdentity: structuredClone(request.sourceIdentity),
        quiescenceProof: structuredClone(request.quiescenceProof),
      });
    } catch {
      throw new ReleaseSnapshotError(
        "QUIESCENCE_NOT_CONFIRMED",
        "Quiescence and stopped-runtime proof could not be confirmed",
      );
    }
    if (
      quiescenceReceipt.state !== "CONFIRMED" ||
      quiescenceReceipt.runtimeState !== "STOPPED" ||
      !sameIdentity(quiescenceReceipt.sourceIdentity, request.sourceIdentity) ||
      quiescenceReceipt.fenceId !== request.quiescenceProof.fenceId ||
      quiescenceReceipt.stopReceiptId !== request.quiescenceProof.stopReceiptId ||
      quiescenceReceipt.observedAt !== request.quiescenceProof.observedAt
    ) {
      throw new ReleaseSnapshotError(
        "QUIESCENCE_NOT_CONFIRMED",
        "Final snapshot requires an exact quiescence fence and stopped-runtime receipt",
      );
    }
    const expectedNames = this.policy.candidateOwnedConfig.map((entry) => entry.logicalName).sort();
    const receivedNames = Object.keys(request.expectedCandidateConfigSha256).sort();
    if (
      canonicalize(expectedNames) !== canonicalize(receivedNames) ||
      receivedNames.some(
        (name) => !SHA256_PATTERN.test(request.expectedCandidateConfigSha256[name]!),
      )
    ) {
      throw new ReleaseSnapshotError(
        "SNAPSHOT_REQUEST_INVALID",
        "Candidate config CAS set must exactly match restore policy",
      );
    }
    return this.createSnapshot("FINAL_ROLLBACK", request);
  }

  async restoreFinalRollbackSnapshot(
    request: RestoreFinalRollbackSnapshotRequest,
  ): Promise<RestoreFinalRollbackSnapshotResult> {
    if (!SNAPSHOT_ID_PATTERN.test(request.expectedSnapshotId)) {
      throw new ReleaseSnapshotError("SNAPSHOT_DIRECTORY_INVALID", "Snapshot id is invalid");
    }
    assertReleaseIdentity(request.expectedSourceIdentity, "SNAPSHOT_IDENTITY_MISMATCH");
    await this.assertNoSensitivePolicyAliases();
    await assertSnapshotRoot(this.policy.snapshotRoot);
    const expectedDirectory = path.join(this.policy.snapshotRoot, request.expectedSnapshotId);
    if (path.resolve(request.snapshotDirectory) !== expectedDirectory) {
      throw new ReleaseSnapshotError(
        "SNAPSHOT_DIRECTORY_INVALID",
        "Snapshot directory is outside the configured snapshot root",
      );
    }
    await assertNoSymlinkComponents(
      this.policy.snapshotRoot,
      expectedDirectory,
      false,
      "SNAPSHOT_DIRECTORY_INVALID",
    );
    await assertDirectoryNoSymlink(expectedDirectory, "SNAPSHOT_DIRECTORY_INVALID");
    const manifestRaw = await readRegularFile(
      expectedDirectory,
      path.join(expectedDirectory, MANIFEST_NAME),
    );
    assertNoSecrets(manifestRaw, request.secretCanaries ?? []);
    const manifest = parseManifest(manifestRaw);
    if (manifest.snapshotKind !== "FINAL_ROLLBACK" || !manifest.restoreEligible) {
      throw new ReleaseSnapshotError(
        "SNAPSHOT_KIND_NOT_RESTORABLE",
        "Online preflight snapshots can never be restored",
      );
    }
    if (
      manifest.snapshotId !== request.expectedSnapshotId ||
      !sameIdentity(manifest.sourceIdentity, request.expectedSourceIdentity)
    ) {
      throw new ReleaseSnapshotError(
        "SNAPSHOT_IDENTITY_MISMATCH",
        "Snapshot identity does not match the requested rollback",
      );
    }
    this.assertManifestMatchesPolicy(manifest);
    const allArtifacts: SnapshotArtifact[] = [
      manifest.database.artifact,
      ...manifest.releaseFiles,
      ...manifest.configFiles,
    ];
    for (const artifact of allArtifacts) {
      const artifactPath = path.join(expectedDirectory, ...artifact.relativePath.split("/"));
      const observed = await hashRegularFile(expectedDirectory, artifactPath);
      if (observed.size !== artifact.size || observed.sha256 !== artifact.sha256) {
        throw new ReleaseSnapshotError(
          "SNAPSHOT_ARTIFACT_HASH_MISMATCH",
          "Snapshot artifact digest does not match",
        );
      }
    }

    await assertDirectoryNoSymlink(this.policy.dataRoot, "TARGET_NOT_REGULAR");
    await this.assertExistingRegularTarget(this.policy.databasePath);
    for (const entry of this.policy.releaseFiles) {
      await this.assertExistingRegularTarget(entry.targetPath);
    }
    const configDecisions = await Promise.all(
      manifest.configFiles.map(async (artifact) => {
        const policy = this.policy.candidateOwnedConfig.find(
          (entry) => entry.logicalName === artifact.logicalName,
        )!;
        try {
          const observed = await hashRegularFile(this.policy.dataRoot, policy.targetPath);
          return {
            artifact,
            policy,
            restore: observed.sha256 === artifact.expectedCandidateSha256,
          };
        } catch (error) {
          if (error instanceof ReleaseSnapshotError && error.code === "SOURCE_NOT_REGULAR") {
            try {
              const targetStats = await lstat(policy.targetPath);
              if (targetStats.isSymbolicLink() || !targetStats.isFile()) {
                throw new ReleaseSnapshotError("TARGET_NOT_REGULAR", "Config target is unsafe");
              }
            } catch (targetError) {
              if (
                targetError instanceof Error &&
                "code" in targetError &&
                targetError.code === "ENOENT"
              ) {
                return { artifact, policy, restore: false };
              }
              throw targetError;
            }
          }
          throw error;
        }
      }),
    );

    const databaseBackupPath = path.join(
      expectedDirectory,
      ...manifest.database.artifact.relativePath.split("/"),
    );
    let restoreReceipt: SqliteRestoreReceipt;
    try {
      restoreReceipt = await this.sqlite.restoreQuiesced(
        databaseBackupPath,
        this.policy.databasePath,
      );
    } catch {
      throw new ReleaseSnapshotError("SQLITE_RESTORE_FAILED", "SQLite restore failed");
    }
    if (
      restoreReceipt.method !== "SQLITE_BACKUP_API" ||
      restoreReceipt.restoredQuickCheck !== "ok"
    ) {
      throw new ReleaseSnapshotError(
        "SQLITE_RESTORE_QUICK_CHECK_FAILED",
        "Restored database failed quick_check",
      );
    }
    await this.assertExistingRegularTarget(this.policy.databasePath);

    const releaseNames: string[] = [];
    for (const artifact of [...manifest.releaseFiles].sort((left, right) =>
      left.logicalName.localeCompare(right.logicalName),
    )) {
      const target = this.policy.releaseFiles.find(
        (entry) => entry.logicalName === artifact.logicalName,
      )!;
      const content = await readRegularFile(
        expectedDirectory,
        path.join(expectedDirectory, ...artifact.relativePath.split("/")),
      );
      await atomicWritePrivateFile(this.policy.dataRoot, target.targetPath, content);
      releaseNames.push(artifact.logicalName);
    }

    const configResults: RestoreFinalRollbackSnapshotResult["configFiles"] = [];
    for (const decision of configDecisions.sort((left, right) =>
      left.artifact.logicalName.localeCompare(right.artifact.logicalName),
    )) {
      if (!decision.restore) {
        configResults.push({
          logicalName: decision.artifact.logicalName,
          state: "SKIPPED_CAS_MISMATCH",
        });
        continue;
      }
      const content = await readRegularFile(
        expectedDirectory,
        path.join(expectedDirectory, ...decision.artifact.relativePath.split("/")),
      );
      await atomicWritePrivateFile(this.policy.dataRoot, decision.policy.targetPath, content);
      configResults.push({ logicalName: decision.artifact.logicalName, state: "RESTORED" });
    }
    return { database: "RESTORED", releaseFiles: releaseNames, configFiles: configResults };
  }

  private async createSnapshot(
    kind: "ONLINE_PREFLIGHT",
    request: OnlinePreflightSnapshotRequest,
  ): Promise<StoredReleaseSnapshot<OnlinePreflightSnapshotManifest>>;
  private async createSnapshot(
    kind: "FINAL_ROLLBACK",
    request: FinalRollbackSnapshotRequest,
  ): Promise<StoredReleaseSnapshot<FinalRollbackSnapshotManifest>>;
  private async createSnapshot(
    kind: "ONLINE_PREFLIGHT" | "FINAL_ROLLBACK",
    request: OnlinePreflightSnapshotRequest | FinalRollbackSnapshotRequest,
  ): Promise<StoredReleaseSnapshot<ReleaseSnapshotManifest>> {
    validateCreateRequest(request);
    await assertSnapshotRoot(this.policy.snapshotRoot);
    await assertDirectoryNoSymlink(this.policy.dataRoot, "SOURCE_NOT_REGULAR");
    const finalDirectory = path.join(this.policy.snapshotRoot, request.snapshotId);
    try {
      await lstat(finalDirectory);
      throw new ReleaseSnapshotError("SNAPSHOT_ALREADY_EXISTS", "Snapshot already exists");
    } catch (error) {
      if (error instanceof ReleaseSnapshotError) throw error;
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    const stagingDirectory = path.join(
      this.policy.snapshotRoot,
      `.${request.snapshotId}.staging-${randomUUID()}`,
    );
    const canaries = request.secretCanaries ?? [];
    try {
      await mkdir(stagingDirectory, { mode: 0o700 });
      await chmod(stagingDirectory, 0o700);
      await ensurePrivateDirectory(stagingDirectory, path.join(stagingDirectory, "database"));
      await ensurePrivateDirectory(stagingDirectory, path.join(stagingDirectory, "release"));
      if (kind === "FINAL_ROLLBACK" && this.policy.candidateOwnedConfig.length > 0) {
        await ensurePrivateDirectory(stagingDirectory, path.join(stagingDirectory, "config"));
      }

      const databaseBackupPath = path.join(stagingDirectory, ...DATABASE_LOGICAL_NAME.split("/"));
      await this.assertExistingRegularSource(this.policy.databasePath);
      let backupReceipt: SqliteBackupReceipt;
      try {
        backupReceipt = await this.sqlite.backupOnline(
          this.policy.databasePath,
          databaseBackupPath,
        );
      } catch {
        throw new ReleaseSnapshotError("SQLITE_BACKUP_FAILED", "SQLite Backup API failed");
      }
      if (
        backupReceipt.method !== "SQLITE_BACKUP_API" ||
        backupReceipt.sourceJournalMode !== "WAL"
      ) {
        throw new ReleaseSnapshotError(
          "SQLITE_BACKUP_NOT_WAL_SAFE",
          "SQLite backup did not prove WAL-safe Backup API use",
        );
      }
      if (backupReceipt.sourceQuickCheck !== "ok" || backupReceipt.backupQuickCheck !== "ok") {
        throw new ReleaseSnapshotError(
          "SQLITE_QUICK_CHECK_FAILED",
          "Source or backup database failed quick_check",
        );
      }
      await chmod(databaseBackupPath, 0o600);
      let databaseHandle;
      try {
        databaseHandle = await open(databaseBackupPath, constants.O_RDWR | constants.O_NOFOLLOW);
        await databaseHandle.sync();
      } finally {
        await databaseHandle?.close();
      }
      const databaseDetails = await hashRegularFile(stagingDirectory, databaseBackupPath);

      const releaseFiles: ReleaseSnapshotArtifact[] = [];
      for (const entry of [...this.policy.releaseFiles].sort((left, right) =>
        left.logicalName.localeCompare(right.logicalName),
      )) {
        const content = await readRegularFile(this.policy.dataRoot, entry.targetPath);
        assertNoSecrets(content, canaries);
        const destination = path.join(stagingDirectory, ...entry.logicalName.split("/"));
        await atomicWritePrivateFile(stagingDirectory, destination, content);
        releaseFiles.push({
          ...artifactRecord(entry.logicalName, { size: content.length, sha256: digest(content) }),
          role: entry.role,
        });
      }

      const configFiles: CandidateConfigSnapshotArtifact[] = [];
      if (kind === "FINAL_ROLLBACK") {
        const finalRequest = request as FinalRollbackSnapshotRequest;
        for (const entry of [...this.policy.candidateOwnedConfig].sort((left, right) =>
          left.logicalName.localeCompare(right.logicalName),
        )) {
          const content = await readRegularFile(this.policy.dataRoot, entry.targetPath);
          const expectedHash = finalRequest.expectedCandidateConfigSha256[entry.logicalName]!;
          assertNoSecrets(content, canaries);
          const destination = path.join(stagingDirectory, ...entry.logicalName.split("/"));
          await atomicWritePrivateFile(stagingDirectory, destination, content);
          configFiles.push({
            ...artifactRecord(entry.logicalName, {
              size: content.length,
              sha256: digest(content),
            }),
            role: "CANDIDATE_OWNED_CONFIG",
            expectedCandidateSha256: expectedHash,
          });
        }
      }

      const common = {
        schemaVersion: 1 as const,
        snapshotId: request.snapshotId,
        sourceIdentity: structuredClone(request.sourceIdentity),
        createdAt: request.createdAt,
        database: {
          strategy: "SQLITE_BACKUP_API" as const,
          sourceJournalMode: "WAL" as const,
          sourceQuickCheck: "ok" as const,
          backupQuickCheck: "ok" as const,
          artifact: {
            ...artifactRecord(DATABASE_LOGICAL_NAME, databaseDetails),
            role: "DATABASE" as const,
          },
        },
        releaseFiles,
        excludedFromRestore: [...EXCLUDED_RESTORE_CATEGORIES] as [
          ...typeof EXCLUDED_RESTORE_CATEGORIES,
        ],
      };
      const manifest: ReleaseSnapshotManifest =
        kind === "ONLINE_PREFLIGHT"
          ? sealManifest({
              ...common,
              snapshotKind: "ONLINE_PREFLIGHT" as const,
              restoreEligible: false as const,
              quiescenceProof: null,
              configFiles: [] as [],
            })
          : sealManifest({
              ...common,
              snapshotKind: "FINAL_ROLLBACK" as const,
              restoreEligible: true as const,
              quiescenceProof: structuredClone(
                (request as FinalRollbackSnapshotRequest).quiescenceProof,
              ),
              configFiles,
            });
      const serializedManifest = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      assertNoSecrets(serializedManifest, canaries);
      await atomicWritePrivateFile(
        stagingDirectory,
        path.join(stagingDirectory, MANIFEST_NAME),
        serializedManifest,
      );
      await fsyncDirectory(stagingDirectory);
      await rename(stagingDirectory, finalDirectory);
      await chmod(finalDirectory, 0o700);
      await fsyncDirectory(this.policy.snapshotRoot);
      return {
        snapshotDirectory: finalDirectory,
        manifest,
      } as StoredReleaseSnapshot<ReleaseSnapshotManifest>;
    } catch (error) {
      await rm(stagingDirectory, { recursive: true, force: true });
      if (error instanceof ReleaseSnapshotError) throw error;
      throw new ReleaseSnapshotError("SNAPSHOT_PUBLISH_FAILED", "Snapshot could not be published");
    }
  }

  private assertManifestMatchesPolicy(manifest: FinalRollbackSnapshotManifest): void {
    const policyRelease = [...this.policy.releaseFiles]
      .sort((left, right) => left.logicalName.localeCompare(right.logicalName))
      .map(({ logicalName, role }) => ({ logicalName, role }));
    const manifestRelease = [...manifest.releaseFiles]
      .sort((left, right) => left.logicalName.localeCompare(right.logicalName))
      .map(({ logicalName, role }) => ({ logicalName, role }));
    const policyConfig = this.policy.candidateOwnedConfig.map((entry) => entry.logicalName).sort();
    const manifestConfig = manifest.configFiles.map((entry) => entry.logicalName).sort();
    if (
      canonicalize(policyRelease) !== canonicalize(manifestRelease) ||
      canonicalize(policyConfig) !== canonicalize(manifestConfig)
    ) {
      throw new ReleaseSnapshotError(
        "SNAPSHOT_MANIFEST_INVALID",
        "Snapshot restore allowlist does not match local policy",
      );
    }
  }

  private async assertExistingRegularTarget(targetPath: string): Promise<void> {
    await assertNoSymlinkComponents(this.policy.dataRoot, targetPath, false, "TARGET_NOT_REGULAR");
    const stats = await lstat(targetPath);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new ReleaseSnapshotError("TARGET_NOT_REGULAR", "Restore target is not regular");
    }
  }

  private async assertExistingRegularSource(sourcePath: string): Promise<void> {
    await assertNoSymlinkComponents(this.policy.dataRoot, sourcePath, false, "SOURCE_NOT_REGULAR");
    const stats = await lstat(sourcePath);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new ReleaseSnapshotError("SOURCE_NOT_REGULAR", "Snapshot source is not regular");
    }
  }

  private async assertNoSensitivePolicyAliases(): Promise<void> {
    const targetPaths = [
      this.policy.databasePath,
      ...this.policy.releaseFiles.map((entry) => entry.targetPath),
      ...this.policy.candidateOwnedConfig.map((entry) => entry.targetPath),
    ];
    for (const targetPath of targetPaths) {
      assertResolvedPathNotSensitive(this.policy.dataRoot, targetPath);
      try {
        const canonicalTarget = await realpath(targetPath);
        assertResolvedPathNotSensitive(this.policy.dataRoot, canonicalTarget);
      } catch (error) {
        if (
          error instanceof ReleaseSnapshotError &&
          error.code === "SENSITIVE_SECURITY_STATE_PATH"
        ) {
          throw error;
        }
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
          throw error;
        }
      }
    }
  }
}
