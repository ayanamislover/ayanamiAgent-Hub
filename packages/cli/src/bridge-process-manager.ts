import { createHash } from "node:crypto";
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
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import type { CodexBridgeHealth } from "@crossagent/codex-bridge";
import {
  createId,
  SessionLaunchReservationSchema,
  type SessionLaunchReservation,
} from "@crossagent/protocol";
import { dataDir } from "./paths.js";
import { processExists } from "./process-manager.js";
import {
  assertExactBuildIdentity,
  parseRuntimeBuildIdentity,
  verifiedCliReleaseEntrypoint,
  type RuntimeBuildIdentity,
} from "./build-identity.js";
import {
  bridgeWorkerProofSubjectThreadId,
  challengeBridgeWorker,
  createBridgeWorkerChallengeId,
  readBridgeWorkerProofSidecar,
  verifyBridgeWorkerProof,
  type BridgeWorkerProofMode,
  type WindowsOwnerPrivateAclHardener,
  type WindowsOwnerPrivateAclVerifier,
} from "./bridge-worker-proof.js";
import { verifyWindowsOwnerPrivateAcl } from "./windows-owner-private-acl.js";
import {
  assertCodexSessionTicketRecoveryReservation,
  bindCodexSessionTicketRecoveryRun,
  findRecoverableCodexSessionTicketRun,
  markCodexSessionTicketRecoveryDraining,
  readCodexSessionTicketRecoveryState,
} from "./session-ticket-store.js";

export type CodexBridgePidRecord = {
  pid: number;
  projectId: string;
  agentId: string;
  runId: string | null;
  ownerNonce: string | null;
  threadId: string | null;
  launchReservation: SessionLaunchReservation | null;
  startedAt: string;
  entry: string;
  logPath: string;
  workerProofMode?: BridgeWorkerProofMode;
};

export type CodexBridgeFailedRunRecord = Omit<CodexBridgePidRecord, "pid"> & {
  pid: number | null;
  failure: string;
  updatedAt: string;
};

export type PublicCodexBridgeRecord<T extends CodexBridgePidRecord | CodexBridgeFailedRunRecord> =
  Omit<T, "ownerNonce" | "launchReservation">;

type CodexBridgeControlRecord = Omit<CodexBridgePidRecord, "pid"> & {
  version: 2 | 3 | 4;
  state: "RESERVING" | "STARTING" | "RUNNING" | "FAILED" | "CANCELLED";
  pid: number | null;
  projectRoot: string | null;
  buildIdentity: RuntimeBuildIdentity | null;
  workerProofMode: BridgeWorkerProofMode;
  failure?: string;
  updatedAt: string;
};

export type BridgeRunOwner = {
  projectId: string;
  agentId: string;
  runId: string;
  ownerNonce: string;
  pid: number;
};

type BridgeSelector = {
  runId?: string;
  threadId?: string;
  pid?: number;
};

type LaunchLockRecord = {
  nonce: string;
  ownerPid: number;
  createdAt: string;
};

type LaunchLockLease = {
  record: LaunchLockRecord;
  heartbeatPath: string;
  renewal: ReturnType<typeof setInterval>;
  afterOwnerVerified?: (path: string, expectedNonce: string) => void;
};

type SpawnedChild = {
  pid?: number;
  unref(): void;
};

type StartAdapters = {
  processExists?: (pid: number) => boolean;
  spawnDetached?: (
    command: string,
    args: string[],
    logPath: string,
    environment: NodeJS.ProcessEnv,
  ) => SpawnedChild;
  afterSpawn?: (owner: BridgeRunOwner) => void | Promise<void>;
  afterLaunchLockOwnerVerified?: (path: string, expectedNonce: string) => void;
  /**
   * Required only for explicit worker-proof activation on Windows. There is no chmod substitute
   * for a DACL check; callers without a real verifier are denied before reservation or spawn.
   */
  verifyOwnerPrivateAcl?: WindowsOwnerPrivateAclVerifier;
  hardenOwnerPrivateAcl?: WindowsOwnerPrivateAclHardener;
};

export type ReserveCodexBridgeLaunch = (request: {
  projectId: string;
  agentId: string;
  threadId: string;
  runId: string;
  idempotencyKey: string;
  signal: AbortSignal;
}) => Promise<SessionLaunchReservation>;

export type DrainCodexBridgeTicketRecovery = (input: {
  projectId: string;
  agentId: string;
  threadId: string;
  runId: string;
}) => Promise<void>;

export type CodexBridgeTerminalCleanupEvidence =
  | { terminalCleanup: "NOT_ATTEMPTED" }
  | {
      terminalCleanup: "CONFIRMED" | "AMBIGUOUS";
      sessionId: string | null;
      bundleId: string | null;
    };

export function codexBridgeTerminalCleanupEvidence(
  outcome: {
    sessionExisted: boolean;
    close: {
      state: "NOT_ATTEMPTED" | "CONFIRMED" | "AMBIGUOUS";
      sessionId: string | null;
      bundleId: string | null;
    };
  } | null,
): CodexBridgeTerminalCleanupEvidence {
  if (!outcome) {
    throw new Error("Codex Bridge did not publish terminal cleanup evidence");
  }
  if (outcome.close.state === "NOT_ATTEMPTED") {
    if (
      outcome.sessionExisted ||
      outcome.close.sessionId !== null ||
      outcome.close.bundleId !== null
    ) {
      throw new Error("Codex Bridge published inconsistent NOT_ATTEMPTED cleanup evidence");
    }
    return { terminalCleanup: "NOT_ATTEMPTED" };
  }
  if (!outcome.sessionExisted || outcome.close.sessionId === null) {
    throw new Error("Codex Bridge published cleanup evidence without an exact session");
  }
  return {
    terminalCleanup: outcome.close.state,
    sessionId: outcome.close.sessionId,
    bundleId: outcome.close.bundleId,
  };
}

export type CodexBridgeProcessTerminalOutcome =
  { reason: string; fatal: false } | { reason: string; fatal: true; error: Error };

/**
 * One terminal owner for caller stop, Bridge retirement, and fatal transport failure.
 *
 * Every caller joins the same shutdown. A fatal outcome upgrades an earlier normal stop, and the
 * microtask seam after shutdown lets a Bridge callback that was waiting on the same stop Promise
 * publish that upgrade before the local run record and process exit are finalized.
 */
export function createCodexBridgeProcessTerminalController(options: {
  shutdown: () => Promise<void>;
  finalize: (outcome: CodexBridgeProcessTerminalOutcome) => void | Promise<void>;
}): { request: (outcome: CodexBridgeProcessTerminalOutcome) => Promise<void> } {
  let selected: CodexBridgeProcessTerminalOutcome | null = null;
  let operation: Promise<void> | null = null;
  const request = (outcome: CodexBridgeProcessTerminalOutcome): Promise<void> => {
    if (selected === null || (!selected.fatal && outcome.fatal)) selected = outcome;
    if (operation) return operation;
    operation = (async () => {
      try {
        await options.shutdown();
      } catch (error) {
        const cleanupError = error instanceof Error ? error : new Error(String(error));
        if (!selected?.fatal) {
          selected = { reason: "Bridge shutdown failed", fatal: true, error: cleanupError };
        }
      }
      await Promise.resolve();
      await options.finalize(selected!);
    })();
    return operation;
  };
  return { request };
}

const HEALTH_STALE_AFTER_MS = 20_000;
const OWNER_LEASE_STALE_AFTER_MS = 5_000;
const STARTING_STALE_AFTER_MS = 30_000;
const LAUNCH_LOCK_STALE_AFTER_MS = 30_000;
const LAUNCH_LOCK_HEARTBEAT_MS = 5_000;
const LAUNCH_LOCK_WAIT_MS = 10_000;
const LAUNCH_LOCK_POLL_MS = 25;
const RESERVATION_ATTEMPT_TIMEOUT_MS = 5_000;
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;

const TEST_BUILD_IDENTITY: RuntimeBuildIdentity = Object.freeze({
  buildSessionId: "00000000-0000-4000-8000-000000000000",
  buildId: "0".repeat(64),
  migrationId: "3".repeat(64),
  protocolId: "1".repeat(64),
  manifestSha256: "2".repeat(64),
});

const MANAGED_BRIDGE_ENVIRONMENT_ALLOWLIST = new Set([
  "APPDATA",
  "COLORTERM",
  "COMMONPROGRAMFILES",
  "COMMONPROGRAMFILES(X86)",
  "COMSPEC",
  "CROSSAGENT_DATA_DIR",
  "CROSSAGENT_PORT",
  "CROSSAGENT_URL",
  "FORCE_COLOR",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "LANG",
  "LC_ALL",
  "LOCALAPPDATA",
  "NO_COLOR",
  "NUMBER_OF_PROCESSORS",
  "OS",
  "PATH",
  "PATHEXT",
  "PROCESSOR_ARCHITECTURE",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "SYSTEMROOT",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "USERPROFILE",
  "WINDIR",
]);

export async function resolveCodexBridgeControlProjectId(
  explicitProjectId: string | undefined,
  resolveFromHub: () => Promise<string>,
): Promise<string> {
  return explicitProjectId ?? resolveFromHub();
}

export function isCodexBridgeHealthDegraded(
  health: Pick<
    CodexBridgeHealth,
    "status" | "hubSocketAlive" | "appServerRpcAlive" | "notificationStreamAlive"
  >,
): boolean {
  return (
    health.status !== "healthy" ||
    !health.hubSocketAlive ||
    !health.appServerRpcAlive ||
    health.notificationStreamAlive === false
  );
}

export function isCodexBridgeHealthStale(
  health: Pick<CodexBridgeHealth, "updatedAt">,
  now = Date.now(),
): boolean {
  const updatedAt = Date.parse(health.updatedAt);
  if (Number.isNaN(updatedAt)) return true;
  return now - updatedAt > HEALTH_STALE_AFTER_MS;
}

function bridgeKey(projectId: string, agentId: string, discriminator?: string): string {
  const parts = discriminator ? [projectId, agentId, discriminator] : [projectId, agentId];
  const readable = parts
    .join("-")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
  const digest = createHash("sha256").update(parts.join("\0")).digest("hex");
  return `${readable || "bridge"}-${digest.slice(0, 12)}`;
}

function bridgeDirectory(rootDir: string): string {
  return resolve(rootDir, "bridges");
}

/** Legacy project+agent paths remain readable so a running pre-v2 Bridge can be stopped safely. */
export function codexBridgeFiles(
  projectId: string,
  agentId: string,
  rootDir = dataDir,
): { pidPath: string; logPath: string; stopPath: string; healthPath: string } {
  const key = bridgeKey(projectId, agentId);
  const directory = bridgeDirectory(rootDir);
  return {
    pidPath: resolve(directory, `${key}.pid.json`),
    logPath: resolve(directory, `${key}.log`),
    stopPath: resolve(directory, `${key}.stop`),
    healthPath: resolve(directory, `${key}.health.json`),
  };
}

export function codexBridgeRunFiles(
  projectId: string,
  agentId: string,
  runId: string,
  rootDir = dataDir,
): {
  pidPath: string;
  logPath: string;
  stopPath: string;
  healthPath: string;
  ownerPath: string;
  workerProofPath: string;
} {
  const key = bridgeKey(projectId, agentId, `run-${runId}`);
  const directory = bridgeDirectory(rootDir);
  return {
    pidPath: resolve(directory, `${key}.pid.json`),
    logPath: resolve(directory, `${key}.log`),
    stopPath: resolve(directory, `${key}.stop.json`),
    healthPath: resolve(directory, `${key}.health.json`),
    ownerPath: resolve(directory, `${key}.owner.json`),
    workerProofPath: resolve(directory, `${key}.worker-proof.json`),
  };
}

export function codexBridgeLaunchLockPath(
  projectId: string,
  agentId: string,
  threadId: string,
  rootDir: string,
): string {
  const key = bridgeKey(projectId, agentId, `thread-${threadId}`);
  return resolve(bridgeDirectory(rootDir), `${key}.launch.lock`);
}

function atomicWriteJson(path: string, value: unknown): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  chmodSync(directory, PRIVATE_DIRECTORY_MODE);
  const temporary = `${path}.${process.pid}.${createId("tmp")}.tmp`;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      PRIVATE_FILE_MODE,
    );
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    chmodSync(temporary, PRIVATE_FILE_MODE);
    renameSync(temporary, path);
    chmodSync(path, PRIVATE_FILE_MODE);
  } catch (error) {
    if (descriptor !== null) closeSync(descriptor);
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseControlRecord(
  value: unknown,
  projectId?: string,
  agentId?: string,
): CodexBridgeControlRecord | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.projectId !== "string" ||
    typeof record.agentId !== "string" ||
    (projectId !== undefined && record.projectId !== projectId) ||
    (agentId !== undefined && record.agentId !== agentId) ||
    typeof record.startedAt !== "string" ||
    typeof record.entry !== "string" ||
    typeof record.logPath !== "string"
  ) {
    return null;
  }
  const pid = Number.isInteger(record.pid) && Number(record.pid) > 0 ? Number(record.pid) : null;
  const runId = optionalString(record.runId);
  const ownerNonce = optionalString(record.ownerNonce);
  const threadId = optionalString(record.threadId);
  const projectRoot = optionalString(record.projectRoot);
  const version = record.version === 4 ? 4 : record.version === 3 ? 3 : 2;
  const buildIdentity = parseRuntimeBuildIdentity(record.buildIdentity);
  if (version === 4 && buildIdentity === null) return null;
  if (version !== 4 && record.buildIdentity !== undefined && record.buildIdentity !== null) {
    return null;
  }
  const workerProofMode =
    record.workerProofMode === "required"
      ? "required"
      : record.workerProofMode === "disabled" || record.workerProofMode === undefined
        ? "disabled"
        : null;
  if (workerProofMode === null || (version !== 4 && record.workerProofMode !== undefined)) {
    return null;
  }
  let launchReservation: SessionLaunchReservation | null = null;
  if (record.launchReservation !== undefined && record.launchReservation !== null) {
    const parsed = SessionLaunchReservationSchema.safeParse(record.launchReservation);
    if (!parsed.success) return null;
    launchReservation = parsed.data;
  }
  const state =
    record.state === "RESERVING" ||
    record.state === "STARTING" ||
    record.state === "RUNNING" ||
    record.state === "FAILED" ||
    record.state === "CANCELLED"
      ? record.state
      : pid
        ? "RUNNING"
        : "FAILED";
  if (state === "RUNNING" && pid === null) return null;
  if ((runId === null) !== (ownerNonce === null)) return null;
  return {
    version,
    state,
    pid,
    projectRoot,
    buildIdentity,
    workerProofMode,
    projectId: record.projectId,
    agentId: record.agentId,
    runId,
    ownerNonce,
    threadId,
    launchReservation,
    startedAt: record.startedAt,
    entry: record.entry,
    logPath: record.logPath,
    failure: optionalString(record.failure) ?? undefined,
    updatedAt: optionalString(record.updatedAt) ?? record.startedAt,
  };
}

function readControlPath(
  path: string,
  projectId?: string,
  agentId?: string,
): CodexBridgeControlRecord | null {
  if (!existsSync(path)) return null;
  try {
    return parseControlRecord(readJson(path), projectId, agentId);
  } catch {
    return null;
  }
}

type ManagedLaunchIdentityInput = {
  controlPath: string;
  projectId: string;
  agentId: string;
  runId: string;
  pid: number;
  rootDir?: string;
};

function privateManagedControlPath(input: ManagedLaunchIdentityInput): string {
  const rootDir = input.rootDir ?? dataDir;
  const expectedPath = codexBridgeRunFiles(
    input.projectId,
    input.agentId,
    input.runId,
    rootDir,
  ).pidPath;
  if (resolve(input.controlPath) !== expectedPath) {
    throw new Error("Managed Codex Bridge control path does not match its run identity");
  }
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(expectedPath);
  } catch {
    throw new Error("Managed Codex Bridge v4 control handoff is unavailable");
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("Managed Codex Bridge v4 control handoff is not a private regular file");
  }
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new Error("Managed Codex Bridge v4 control handoff is not owner-private");
  }
  return expectedPath;
}

/**
 * Read only the non-secret release provenance from the private handoff. The child calls this and
 * verifies local + Hub identity before the full parser examines a launch reservation or recovery
 * evidence.
 */
export function readCodexBridgeManagedBuildIdentity(
  input: ManagedLaunchIdentityInput,
): RuntimeBuildIdentity {
  const path = privateManagedControlPath(input);
  let raw: unknown;
  try {
    raw = readJson(path);
  } catch {
    throw new Error("Managed Codex Bridge v4 control handoff is not claimable");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Managed Codex Bridge v4 control handoff is not claimable");
  }
  const record = raw as Record<string, unknown>;
  const identity = parseRuntimeBuildIdentity(record.buildIdentity);
  const starting = record.state === "STARTING" && record.pid === null;
  const running = record.state === "RUNNING" && record.pid === input.pid;
  if (
    record.version !== 4 ||
    record.projectId !== input.projectId ||
    record.agentId !== input.agentId ||
    record.runId !== input.runId ||
    (!starting && !running) ||
    typeof record.ownerNonce !== "string" ||
    record.ownerNonce.length === 0 ||
    !identity
  ) {
    throw new Error("Managed Codex Bridge v4 control handoff is not claimable");
  }
  return identity;
}

export function readCodexBridgeManagedLaunchContext(input: ManagedLaunchIdentityInput): {
  owner: BridgeRunOwner;
  launchReservation: SessionLaunchReservation | null;
  projectAttachment: { projectId: string; root: string };
  buildIdentity: RuntimeBuildIdentity;
} {
  const rootDir = input.rootDir ?? dataDir;
  const expectedPath = privateManagedControlPath(input);
  const control = readControlPath(expectedPath, input.projectId, input.agentId);
  const isOwnedStarting = control?.state === "STARTING" && control.pid === null;
  const isOwnedRunning = control?.state === "RUNNING" && control.pid === input.pid;
  if (
    control?.version !== 4 ||
    (!isOwnedStarting && !isOwnedRunning) ||
    control.runId !== input.runId ||
    control.ownerNonce === null ||
    control.projectRoot === null ||
    resolve(control.projectRoot) !== control.projectRoot
  ) {
    throw new Error("Managed Codex Bridge v4 control handoff is not claimable");
  }
  if ((control.threadId === null) !== (control.launchReservation === null)) {
    throw new Error("Managed Codex Bridge v4 control handoff has inconsistent launch context");
  }
  const launchReservation = control.launchReservation
    ? (() => {
        const consumedRecovery = control.launchReservation.state === "CONSUMED";
        if (consumedRecovery) {
          assertCodexSessionTicketRecoveryReservation({
            projectId: control.projectId,
            threadId: control.threadId!,
            runId: control.runId,
            reservation: control.launchReservation,
            rootDir,
          });
        }
        return reservationForLaunch(
          control.launchReservation,
          {
            projectId: control.projectId,
            agentId: control.agentId,
            threadId: control.threadId!,
            runId: control.runId,
          },
          consumedRecovery,
        );
      })()
    : null;
  return {
    owner: {
      projectId: control.projectId,
      agentId: control.agentId,
      runId: control.runId,
      ownerNonce: control.ownerNonce,
      pid: input.pid,
    },
    launchReservation,
    projectAttachment: { projectId: control.projectId, root: control.projectRoot },
    buildIdentity: control.buildIdentity!,
  };
}

/** User-visible status must never disclose the private owner proof or launch handoff. */
export function publicCodexBridgeRecord<
  T extends CodexBridgePidRecord | CodexBridgeFailedRunRecord,
>(record: T): PublicCodexBridgeRecord<T> {
  const {
    ownerNonce: _ownerNonce,
    launchReservation: _launchReservation,
    ...publicRecord
  } = record;
  return publicRecord;
}

function asPidRecord(record: CodexBridgeControlRecord): CodexBridgePidRecord | null {
  if (record.state !== "RUNNING" || record.pid === null) return null;
  return {
    pid: record.pid,
    projectId: record.projectId,
    agentId: record.agentId,
    runId: record.runId,
    ownerNonce: record.ownerNonce,
    threadId: record.threadId,
    launchReservation: record.launchReservation,
    startedAt: record.startedAt,
    entry: record.entry,
    logPath: record.logPath,
    workerProofMode: record.workerProofMode,
  };
}

function filesForRecord(
  record: Pick<CodexBridgePidRecord, "projectId" | "agentId" | "runId">,
  rootDir: string,
) {
  return record.runId
    ? codexBridgeRunFiles(record.projectId, record.agentId, record.runId, rootDir)
    : codexBridgeFiles(record.projectId, record.agentId, rootDir);
}

function runControlRecords(
  projectId: string,
  agentId: string,
  rootDir: string,
): Array<{ path: string; record: CodexBridgeControlRecord }> {
  const directory = bridgeDirectory(rootDir);
  if (!existsSync(directory)) return [];
  const found: Array<{ path: string; record: CodexBridgeControlRecord }> = [];
  for (const name of readdirSync(directory)) {
    if (!name.endsWith(".pid.json")) continue;
    const path = resolve(directory, name);
    const record = readControlPath(path, projectId, agentId);
    if (record) found.push({ path, record });
  }
  return found;
}

export function listCodexBridgePids(
  projectId: string,
  agentId: string,
  rootDir = dataDir,
): CodexBridgePidRecord[] {
  return runControlRecords(projectId, agentId, rootDir)
    .map(({ record }) => asPidRecord(record))
    .filter((record): record is CodexBridgePidRecord => record !== null)
    .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
}

export function listCodexBridgeFailedRuns(
  projectId: string,
  agentId: string,
  rootDir = dataDir,
): CodexBridgeFailedRunRecord[] {
  return runControlRecords(projectId, agentId, rootDir)
    .filter(({ record }) => record.state === "FAILED" && record.runId !== null)
    .map(({ record }) => ({
      pid: record.pid,
      projectId: record.projectId,
      agentId: record.agentId,
      runId: record.runId,
      ownerNonce: record.ownerNonce,
      threadId: record.threadId,
      launchReservation: record.launchReservation,
      startedAt: record.startedAt,
      entry: record.entry,
      logPath: record.logPath,
      failure: record.failure ?? "managed Bridge exited during startup",
      updatedAt: record.updatedAt,
    }))
    .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
}

export function readCodexBridgePid(
  projectId: string,
  agentId: string,
  rootDir = dataDir,
): CodexBridgePidRecord | null {
  const record = readControlPath(
    codexBridgeFiles(projectId, agentId, rootDir).pidPath,
    projectId,
    agentId,
  );
  return record ? asPidRecord(record) : null;
}

export function readCodexBridgeRunPid(
  projectId: string,
  agentId: string,
  runId: string,
  rootDir = dataDir,
): CodexBridgePidRecord | null {
  const record = readControlPath(
    codexBridgeRunFiles(projectId, agentId, runId, rootDir).pidPath,
    projectId,
    agentId,
  );
  if (!record || record.runId !== runId) return null;
  return asPidRecord(record);
}

/** Non-secret exact build identity for a v4 RUNNING control; used by runtime effect fencing. */
export function readCodexBridgeRunBuildIdentity(
  projectId: string,
  agentId: string,
  runId: string,
  rootDir = dataDir,
): RuntimeBuildIdentity | null {
  const control = readControlPath(
    codexBridgeRunFiles(projectId, agentId, runId, rootDir).pidPath,
    projectId,
    agentId,
  );
  if (
    control?.version !== 4 ||
    control.state !== "RUNNING" ||
    control.runId !== runId ||
    control.pid === null ||
    control.buildIdentity === null
  ) {
    return null;
  }
  return structuredClone(control.buildIdentity);
}

export type CodexBridgeWorkerProofStatus = "ABSENT" | "VERIFIED" | "INVALID";

/** Production status Adapter for the child-only proof. ABSENT preserves disabled-mode behavior. */
export async function probeCodexBridgeRunWorkerProof(
  record: CodexBridgePidRecord,
  rootDir = dataDir,
): Promise<CodexBridgeWorkerProofStatus> {
  if (!record.runId) return "ABSENT";
  const files = codexBridgeRunFiles(record.projectId, record.agentId, record.runId, rootDir);
  const expectedMode = record.workerProofMode ?? "disabled";
  if (!existsSync(files.workerProofPath)) {
    return expectedMode === "required" ? "INVALID" : "ABSENT";
  }
  if (expectedMode !== "required") return "INVALID";
  try {
    const control = readControlPath(files.pidPath, record.projectId, record.agentId);
    if (
      control?.state !== "RUNNING" ||
      control.runId !== record.runId ||
      control.pid !== record.pid ||
      control.buildIdentity === null
    ) {
      return "INVALID";
    }
    if (control.workerProofMode !== "required") return "INVALID";
    const windowsOwnerPrivateAclVerifier =
      process.platform === "win32" ? verifyWindowsOwnerPrivateAcl : undefined;
    const sidecar = await readBridgeWorkerProofSidecar({
      controlPath: files.pidPath,
      sidecarPath: files.workerProofPath,
      windowsOwnerPrivateAclVerifier,
    });
    assertExactBuildIdentity(control.buildIdentity, sidecar.subject.build, "Bridge worker proof");
    if (
      sidecar.state !== "RUNNING" ||
      sidecar.pid !== record.pid ||
      sidecar.subject.projectId !== record.projectId ||
      sidecar.subject.agentId !== record.agentId ||
      sidecar.subject.runId !== record.runId ||
      bridgeWorkerProofSubjectThreadId(sidecar.subject) !== control.threadId
    ) {
      return "INVALID";
    }
    const challengeId = createBridgeWorkerChallengeId();
    const proof = await challengeBridgeWorker({ sidecar, challengeId });
    return verifyBridgeWorkerProof({ sidecar, challengeId, proof }) ? "VERIFIED" : "INVALID";
  } catch {
    return "INVALID";
  }
}

export function writeCodexBridgeHealth(
  projectId: string,
  agentId: string,
  health: CodexBridgeHealth,
  rootDir = dataDir,
): void {
  const { healthPath } = codexBridgeFiles(projectId, agentId, rootDir);
  try {
    mkdirSync(dirname(healthPath), { recursive: true });
    writeFileSync(healthPath, `${JSON.stringify(health, null, 2)}\n`, "utf8");
  } catch {
    // Diagnostics are best-effort.
  }
}

export function writeCodexBridgeRunHealth(
  owner: BridgeRunOwner,
  health: CodexBridgeHealth,
  rootDir = dataDir,
): void {
  const record = readCodexBridgeRunPid(owner.projectId, owner.agentId, owner.runId, rootDir);
  if (
    !record ||
    record.pid !== owner.pid ||
    record.ownerNonce !== owner.ownerNonce ||
    health.pid !== owner.pid
  ) {
    return;
  }
  const { healthPath } = codexBridgeRunFiles(owner.projectId, owner.agentId, owner.runId, rootDir);
  try {
    atomicWriteJson(healthPath, { ...health, launcherRunId: owner.runId });
  } catch {
    // Diagnostics are best-effort.
  }
}

export function writeCodexBridgeRunOwnerLease(owner: BridgeRunOwner, rootDir = dataDir): boolean {
  const files = codexBridgeRunFiles(owner.projectId, owner.agentId, owner.runId, rootDir);
  const control = readControlPath(files.pidPath, owner.projectId, owner.agentId);
  if (!controlMatchesOwner(control, owner) || control?.state !== "RUNNING") return false;
  atomicWriteJson(files.ownerPath, { ...owner, updatedAt: new Date().toISOString() });
  return true;
}

export function startCodexBridgeRunStopWatcher(
  owner: BridgeRunOwner,
  onStop: () => void,
  rootDir = dataDir,
  intervalMs = 250,
): NodeJS.Timeout {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new RangeError("Bridge stop watcher interval must be a finite positive number");
  }
  return setInterval(() => {
    if (consumeCodexBridgeRunStopRequest(owner, rootDir)) onStop();
  }, intervalMs);
}

function matchingOwnerLeaseUpdatedAt(record: CodexBridgePidRecord, rootDir: string): number | null {
  if (!record.runId || !record.ownerNonce) return null;
  const { ownerPath } = codexBridgeRunFiles(
    record.projectId,
    record.agentId,
    record.runId,
    rootDir,
  );
  if (!existsSync(ownerPath)) return null;
  try {
    const lease = readJson(ownerPath) as Partial<BridgeRunOwner> & { updatedAt?: unknown };
    const updatedAt =
      typeof lease.updatedAt === "string" ? Date.parse(lease.updatedAt) : Number.NaN;
    if (
      lease.projectId === record.projectId &&
      lease.agentId === record.agentId &&
      lease.runId === record.runId &&
      lease.ownerNonce === record.ownerNonce &&
      lease.pid === record.pid &&
      Number.isFinite(updatedAt)
    ) {
      return updatedAt;
    }
    return null;
  } catch {
    return null;
  }
}

function hasFreshOwnerLease(record: CodexBridgePidRecord, rootDir: string): boolean {
  const updatedAt = matchingOwnerLeaseUpdatedAt(record, rootDir);
  return (
    updatedAt !== null &&
    Date.now() - updatedAt >= 0 &&
    Date.now() - updatedAt <= OWNER_LEASE_STALE_AFTER_MS
  );
}

export function readCodexBridgeHealth(
  projectId: string,
  agentId: string,
  rootDir = dataDir,
): CodexBridgeHealth | null {
  const { healthPath } = codexBridgeFiles(projectId, agentId, rootDir);
  if (!existsSync(healthPath)) return null;
  const record = readCodexBridgePid(projectId, agentId, rootDir);
  if (!record) return null;
  try {
    const health = readJson(healthPath) as CodexBridgeHealth;
    return health.pid === record.pid ? health : null;
  } catch {
    return null;
  }
}

export function readCodexBridgeRunHealth(
  record: CodexBridgePidRecord,
  rootDir = dataDir,
): CodexBridgeHealth | null {
  if (!record.runId || !record.ownerNonce) {
    return readCodexBridgeHealth(record.projectId, record.agentId, rootDir);
  }
  const { healthPath } = codexBridgeRunFiles(
    record.projectId,
    record.agentId,
    record.runId,
    rootDir,
  );
  if (!existsSync(healthPath)) return null;
  try {
    const raw = readJson(healthPath) as CodexBridgeHealth & { launcherRunId?: unknown };
    return raw.pid === record.pid && raw.launcherRunId === record.runId ? raw : null;
  } catch {
    return null;
  }
}

function removeDerivedRunFiles(
  record: Pick<CodexBridgePidRecord, "projectId" | "agentId" | "runId">,
  rootDir: string,
): void {
  const files = filesForRecord(record, rootDir);
  const ownerPath = record.runId
    ? codexBridgeRunFiles(record.projectId, record.agentId, record.runId, rootDir).ownerPath
    : null;
  for (const path of [files.pidPath, files.stopPath, files.healthPath, ownerPath]) {
    if (path === null) continue;
    if (existsSync(path)) unlinkSync(path);
  }
}

function controlMatchesOwner(
  control: CodexBridgeControlRecord | null,
  owner: BridgeRunOwner,
): boolean {
  return (
    control?.projectId === owner.projectId &&
    control.agentId === owner.agentId &&
    control.runId === owner.runId &&
    control.ownerNonce === owner.ownerNonce &&
    (control.pid === null || control.pid === owner.pid)
  );
}

function clearRunIfOwned(
  owner: BridgeRunOwner,
  rootDir: string,
  evidence: CodexBridgeTerminalCleanupEvidence,
): boolean {
  const files = codexBridgeRunFiles(owner.projectId, owner.agentId, owner.runId, rootDir);
  const control = readControlPath(files.pidPath, owner.projectId, owner.agentId);
  if (!controlMatchesOwner(control, owner)) return false;
  if (control?.threadId) {
    const recovery = readCodexSessionTicketRecoveryState({
      projectId: owner.projectId,
      threadId: control.threadId,
      rootDir,
    });
    if (recovery?.runId === owner.runId && evidence.terminalCleanup === "CONFIRMED") {
      throw new Error(
        "Confirmed Codex session close retained a recovery index; refusing local run cleanup",
      );
    }
    if (recovery?.runId === owner.runId && evidence.terminalCleanup === "AMBIGUOUS") {
      const marked = markCodexSessionTicketRecoveryDraining({
        projectId: owner.projectId,
        threadId: control.threadId,
        runId: owner.runId,
        sessionId: evidence.sessionId,
        bundleId: evidence.bundleId,
        rootDir,
      });
      if (!marked) {
        throw new Error(
          "Ambiguous Codex session close does not match retained replay authority; refusing local run cleanup",
        );
      }
    }
  }
  removeDerivedRunFiles(owner, rootDir);
  return true;
}

function clearStaleCodexBridgeRecords(
  projectId: string,
  agentId: string,
  rootDir: string,
  isAlive: (pid: number) => boolean,
): boolean {
  const legacyFiles = codexBridgeFiles(projectId, agentId, rootDir);
  const records = runControlRecords(projectId, agentId, rootDir);
  let removed = false;
  if (
    (existsSync(legacyFiles.pidPath) &&
      readControlPath(legacyFiles.pidPath, projectId, agentId) === null) ||
    (!existsSync(legacyFiles.pidPath) &&
      (existsSync(legacyFiles.stopPath) || existsSync(legacyFiles.healthPath)))
  ) {
    for (const path of [legacyFiles.pidPath, legacyFiles.stopPath, legacyFiles.healthPath]) {
      if (existsSync(path)) unlinkSync(path);
    }
    removed = true;
  }
  for (const { path, record } of records) {
    if (record.state === "CANCELLED") {
      removeDerivedRunFiles(record, rootDir);
      removed = true;
      continue;
    }
    const running = asPidRecord(record);
    const startingAge = Date.now() - Date.parse(record.updatedAt);
    const staleStarting =
      record.state === "STARTING" &&
      (!Number.isFinite(startingAge) || startingAge > STARTING_STALE_AFTER_MS);
    if ((running && isAlive(running.pid)) || (!running && !staleStarting)) continue;
    const files = filesForRecord(record, rootDir);
    if (existsSync(path)) unlinkSync(path);
    if (existsSync(files.stopPath)) unlinkSync(files.stopPath);
    if (existsSync(files.healthPath)) unlinkSync(files.healthPath);
    if (record.runId) {
      const { ownerPath } = codexBridgeRunFiles(projectId, agentId, record.runId, rootDir);
      if (existsSync(ownerPath)) unlinkSync(ownerPath);
    }
    removed = true;
  }
  return removed;
}

export function clearStaleCodexBridgePid(
  projectId: string,
  agentId: string,
  rootDir = dataDir,
): boolean {
  return clearStaleCodexBridgeRecords(projectId, agentId, rootDir, processExists);
}

function reservationForLaunch(
  reservation: SessionLaunchReservation,
  request: {
    projectId: string;
    agentId: string;
    threadId: string;
    runId: string;
  },
  allowConsumedRecovery = false,
): SessionLaunchReservation {
  const parsed = SessionLaunchReservationSchema.parse(reservation);
  if (
    parsed.projectId !== request.projectId ||
    parsed.agentId !== request.agentId ||
    parsed.client !== "codex-app-server" ||
    parsed.deliveryMode !== "app_server_push" ||
    parsed.identityKind !== "external_thread" ||
    parsed.identityValue !== request.threadId ||
    parsed.runId !== request.runId ||
    (parsed.state !== "ISSUED" && !(allowConsumedRecovery && parsed.state === "CONSUMED"))
  ) {
    throw new Error("Hub launch reservation does not match the managed Codex Bridge run");
  }
  return parsed;
}

function isRetryableReservationError(error: unknown): boolean {
  return (
    error instanceof TypeError ||
    (error instanceof Error && ["AbortError", "TimeoutError", "NetworkError"].includes(error.name))
  );
}

async function reserveLaunchWithRetry(
  reserve: ReserveCodexBridgeLaunch,
  request: Omit<Parameters<ReserveCodexBridgeLaunch>[0], "signal">,
  attemptTimeoutMs: number,
): Promise<SessionLaunchReservation> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort(
        new DOMException(
          `Hub launch reservation timed out after ${attemptTimeoutMs} ms`,
          "TimeoutError",
        ),
      );
    }, attemptTimeoutMs);
    timeout.unref?.();
    try {
      return await reserve({ ...request, signal: controller.signal });
    } catch (error) {
      lastError = error;
      if (!isRetryableReservationError(error) || attempt === 2) throw error;
      await sleep(100 * (attempt + 1));
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError;
}

export function managedCodexBridgeEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && MANAGED_BRIDGE_ENVIRONMENT_ALLOWLIST.has(name.toUpperCase())) {
      environment[name] = value;
    }
  }
  return environment;
}

async function assertWorkerProofOwnerPrivatePath(
  path: string,
  requireRegularFile: boolean,
  verifyOwnerPrivateAcl: WindowsOwnerPrivateAclVerifier | undefined,
  hardenOwnerPrivateAcl: WindowsOwnerPrivateAclHardener | undefined,
): Promise<void> {
  if (process.platform === "win32") {
    if (!verifyOwnerPrivateAcl || !hardenOwnerPrivateAcl) {
      throw new Error(
        "Managed Bridge worker proof requires a real Windows owner-private ACL hardener and verifier",
      );
    }
    if (!(await hardenOwnerPrivateAcl(path, requireRegularFile ? "file" : "directory"))) {
      throw new Error("Managed Bridge worker proof path ACL could not be hardened");
    }
    if (!(await verifyOwnerPrivateAcl(path))) {
      throw new Error("Managed Bridge worker proof path is not owner-private");
    }
    return;
  }
  let metadata: ReturnType<typeof lstatSync>;
  try {
    metadata = lstatSync(path);
  } catch {
    throw new Error("Managed Bridge worker proof path is unavailable");
  }
  if (
    metadata.isSymbolicLink() ||
    (requireRegularFile ? !metadata.isFile() : !metadata.isDirectory()) ||
    (metadata.mode & 0o077) !== 0
  ) {
    throw new Error("Managed Bridge worker proof path is not owner-private");
  }
}

function spawnDetached(
  command: string,
  args: string[],
  logPath: string,
  environment: NodeJS.ProcessEnv,
): SpawnedChild {
  const output = openSync(logPath, "a");
  try {
    return spawn(command, args, {
      detached: true,
      stdio: ["ignore", output, output],
      env: environment,
      windowsHide: true,
    });
  } finally {
    closeSync(output);
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function readLaunchLock(path: string): LaunchLockRecord | null {
  if (!existsSync(path)) return null;
  try {
    const value = readJson(path) as Partial<LaunchLockRecord>;
    if (
      typeof value.nonce !== "string" ||
      !Number.isInteger(value.ownerPid) ||
      typeof value.createdAt !== "string"
    ) {
      return null;
    }
    return value as LaunchLockRecord;
  } catch {
    return null;
  }
}

function launchLockHeartbeatPath(path: string, nonce: string): string {
  return `${path}.${nonce}.lease`;
}

function launchLockMutationPath(path: string): string {
  return `${path}.reap`;
}

function retireLaunchLock(
  path: string,
  expectedNonce: string,
  label: string,
  afterOwnerVerified?: (path: string, expectedNonce: string) => void,
): boolean {
  const mutationPath = launchLockMutationPath(path);
  const mutationNonce = createId("reap");
  let descriptor: number | null = null;
  try {
    descriptor = openSync(
      mutationPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      PRIVATE_FILE_MODE,
    );
    writeFileSync(
      descriptor,
      `${JSON.stringify({ expectedNonce, mutationNonce, pid: process.pid })}\n`,
      "utf8",
    );
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
  } catch (error) {
    if (descriptor !== null) closeSync(descriptor);
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  try {
    if (readLaunchLock(path)?.nonce !== expectedNonce) return false;
    afterOwnerVerified?.(path, expectedNonce);
    const tombstone = `${path}.${label}.${createHash("sha256")
      .update(expectedNonce, "utf8")
      .digest("hex")}.${createId("tmp")}`;
    renameSync(path, tombstone);
    if (readLaunchLock(tombstone)?.nonce !== expectedNonce) {
      if (!existsSync(path)) renameSync(tombstone, path);
      return false;
    }
    unlinkSync(tombstone);
    const heartbeatPath = launchLockHeartbeatPath(path, expectedNonce);
    if (existsSync(heartbeatPath)) unlinkSync(heartbeatPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  } finally {
    try {
      const claim = JSON.parse(readFileSync(mutationPath, "utf8")) as {
        mutationNonce?: unknown;
      };
      if (claim.mutationNonce === mutationNonce) unlinkSync(mutationPath);
    } catch {
      // Never unlink another mutation owner's claim.
    }
  }
}

function writeLaunchLockHeartbeat(path: string): void {
  writeFileSync(path, `${new Date().toISOString()}\n`, {
    encoding: "utf8",
    mode: PRIVATE_FILE_MODE,
  });
  chmodSync(path, PRIVATE_FILE_MODE);
}

function launchLockAge(path: string, record: LaunchLockRecord | null): number {
  if (record) {
    const heartbeatPath = launchLockHeartbeatPath(path, record.nonce);
    if (existsSync(heartbeatPath)) {
      try {
        return Date.now() - statSync(heartbeatPath).mtimeMs;
      } catch {
        // Fall through to the immutable acquisition timestamp.
      }
    }
    return Date.now() - Date.parse(record.createdAt);
  }
  try {
    return Date.now() - statSync(path).mtimeMs;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

async function acquireLaunchLock(
  path: string,
  waitMs: number,
  isAlive: (pid: number) => boolean,
  afterOwnerVerified?: (path: string, expectedNonce: string) => void,
): Promise<LaunchLockLease> {
  mkdirSync(dirname(path), { recursive: true });
  const lock: LaunchLockRecord = {
    nonce: createId("lck"),
    ownerPid: process.pid,
    createdAt: new Date().toISOString(),
  };
  const deadline = Date.now() + waitMs;
  while (true) {
    try {
      if (existsSync(launchLockMutationPath(path))) {
        throw Object.assign(new Error("launch lock mutation in progress"), { code: "EEXIST" });
      }
      const descriptor = openSync(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        PRIVATE_FILE_MODE,
      );
      try {
        writeFileSync(descriptor, `${JSON.stringify(lock)}\n`, "utf8");
      } finally {
        closeSync(descriptor);
      }
      const heartbeatPath = launchLockHeartbeatPath(path, lock.nonce);
      try {
        writeLaunchLockHeartbeat(heartbeatPath);
      } catch (error) {
        retireLaunchLock(path, lock.nonce, "failed", afterOwnerVerified);
        throw error;
      }
      const renewal = setInterval(() => {
        if (readLaunchLock(path)?.nonce !== lock.nonce) {
          clearInterval(renewal);
          return;
        }
        try {
          writeLaunchLockHeartbeat(heartbeatPath);
        } catch {
          // A contender will recover the lease if heartbeats remain unavailable.
        }
      }, LAUNCH_LOCK_HEARTBEAT_MS);
      renewal.unref?.();
      return { record: lock, heartbeatPath, renewal, afterOwnerVerified };
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String(error.code) : "";
      if (code !== "EEXIST") throw error;
      const existing = readLaunchLock(path);
      if (!existing) {
        if (existsSync(launchLockMutationPath(path))) {
          if (Date.now() >= deadline) {
            throw new Error("Timed out waiting for the managed Codex Bridge launch lock");
          }
          await sleep(LAUNCH_LOCK_POLL_MS);
          continue;
        }
        throw new Error("Managed Codex Bridge launch lock is corrupt; refusing unsafe recovery");
      }
      const age = launchLockAge(path, existing);
      const recoverable =
        (!Number.isFinite(age) || age > LAUNCH_LOCK_STALE_AFTER_MS) && !isAlive(existing.ownerPid);
      if (recoverable) {
        retireLaunchLock(path, existing.nonce, "stale", afterOwnerVerified);
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error("Timed out waiting for the managed Codex Bridge launch lock");
      }
      await sleep(LAUNCH_LOCK_POLL_MS);
    }
  }
}

function releaseLaunchLock(path: string, lease: LaunchLockLease): void {
  clearInterval(lease.renewal);
  const lock = lease.record;
  retireLaunchLock(path, lock.nonce, "release", lease.afterOwnerVerified);
  if (existsSync(lease.heartbeatPath)) unlinkSync(lease.heartbeatPath);
}

function legacyRecordMatchesThread(
  record: CodexBridgePidRecord,
  threadId: string,
  rootDir: string,
): boolean {
  if (record.runId !== null) return record.threadId === threadId;
  const health = readCodexBridgeHealth(record.projectId, record.agentId, rootDir);
  return health?.threadId ? health.threadId === threadId : true;
}

function hasFreshRunProof(record: CodexBridgePidRecord, rootDir: string): boolean {
  const health = readCodexBridgeRunHealth(record, rootDir);
  if (health?.status === "stopped") return false;
  if (record.runId !== null && record.ownerNonce !== null) {
    return hasFreshOwnerLease(record, rootDir);
  }
  return health !== null && !isCodexBridgeHealthStale(health);
}

function findLiveOwner(
  projectId: string,
  agentId: string,
  threadId: string,
  rootDir: string,
  isAlive: (pid: number) => boolean,
): CodexBridgePidRecord | null {
  const live: CodexBridgePidRecord[] = [];
  for (const record of listCodexBridgePids(projectId, agentId, rootDir)) {
    if (!isAlive(record.pid) || !legacyRecordMatchesThread(record, threadId, rootDir)) {
      continue;
    }
    if (hasFreshRunProof(record, rootDir)) {
      live.push(record);
      continue;
    }
    if (record.runId === null) {
      throw new Error(
        `Unverified legacy Codex Bridge PID ${record.pid} may own this project; inspect or terminate it explicitly with --pid before launching`,
      );
    }
    if (matchingOwnerLeaseUpdatedAt(record, rootDir) !== null) {
      throw new Error(
        `A live managed Codex Bridge PID ${record.pid} has matching but stale owner proof for thread ${threadId}; refusing to reserve or spawn a successor until ownership recovers or the process is explicitly stopped`,
      );
    }
    throw new Error(
      `A live managed Codex Bridge PID ${record.pid} lacks current nonce-bound owner proof for thread ${threadId}; refusing to reserve or spawn a successor until the process is explicitly stopped`,
    );
  }
  if (live.length > 1) {
    throw new Error(`Multiple live managed Codex Bridges already own thread ${threadId}`);
  }
  return live[0] ?? null;
}

function writeControlRecord(
  options: {
    state: "RESERVING" | "STARTING";
    projectId: string;
    agentId: string;
    runId: string;
    ownerNonce: string;
    threadId: string | null;
    launchReservation: SessionLaunchReservation | null;
    entry: string;
    logPath: string;
    projectRoot: string;
    buildIdentity: RuntimeBuildIdentity;
    workerProofMode: BridgeWorkerProofMode;
  },
  rootDir: string,
): CodexBridgeControlRecord {
  const now = new Date().toISOString();
  const record: CodexBridgeControlRecord = {
    version: 4,
    state: options.state,
    pid: null,
    projectRoot: resolve(options.projectRoot),
    buildIdentity: options.buildIdentity,
    workerProofMode: options.workerProofMode,
    projectId: options.projectId,
    agentId: options.agentId,
    runId: options.runId,
    ownerNonce: options.ownerNonce,
    threadId: options.threadId,
    launchReservation: options.launchReservation,
    startedAt: now,
    updatedAt: now,
    entry: options.entry,
    logPath: options.logPath,
  };
  const { pidPath } = codexBridgeRunFiles(
    options.projectId,
    options.agentId,
    options.runId,
    rootDir,
  );
  if (existsSync(pidPath)) {
    throw new Error(`Managed Codex Bridge run ${options.runId} already has a control record`);
  }
  atomicWriteJson(pidPath, record);
  return record;
}

function findReservingRecord(
  projectId: string,
  agentId: string,
  threadId: string,
  rootDir: string,
): CodexBridgeControlRecord | null {
  const candidates = runControlRecords(projectId, agentId, rootDir)
    .map(({ record }) => record)
    .filter(
      (record) =>
        record.state === "RESERVING" &&
        record.threadId === threadId &&
        record.runId !== null &&
        record.ownerNonce !== null &&
        record.launchReservation === null,
    );
  if (candidates.some((record) => record.version !== 4)) {
    throw new Error(
      `Managed Codex Bridge v2 reservation (pre-v4) for thread ${threadId} is status/stop-only and cannot be resumed`,
    );
  }
  const matches = candidates.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  if (matches.length > 1) {
    throw new Error(`Multiple reserving managed Codex Bridge runs exist for thread ${threadId}`);
  }
  return matches[0] ?? null;
}

function promoteReservingRecord(
  record: CodexBridgeControlRecord,
  launchReservation: SessionLaunchReservation,
  rootDir: string,
): CodexBridgeControlRecord {
  if (
    record.version !== 4 ||
    record.state !== "RESERVING" ||
    record.runId === null ||
    record.ownerNonce === null ||
    record.threadId === null
  ) {
    throw new Error("Managed Codex Bridge reservation record is not resumable");
  }
  const files = codexBridgeRunFiles(record.projectId, record.agentId, record.runId, rootDir);
  if (hasMatchingRunStopRequest(record, rootDir)) {
    throw new Error("Managed Codex Bridge launch was cancelled before spawn");
  }
  const current = readControlPath(files.pidPath, record.projectId, record.agentId);
  if (
    current?.state !== "RESERVING" ||
    current.runId !== record.runId ||
    current.ownerNonce !== record.ownerNonce ||
    current.threadId !== record.threadId
  ) {
    throw new Error("Managed Codex Bridge reservation authority changed before spawn");
  }
  const next: CodexBridgeControlRecord = {
    ...current,
    state: "STARTING",
    launchReservation,
    updatedAt: new Date().toISOString(),
  };
  atomicWriteJson(files.pidPath, next);
  return next;
}

function promoteStartingRecord(owner: BridgeRunOwner, rootDir: string): CodexBridgePidRecord {
  const files = codexBridgeRunFiles(owner.projectId, owner.agentId, owner.runId, rootDir);
  const current = readControlPath(files.pidPath, owner.projectId, owner.agentId);
  if (!controlMatchesOwner(current, owner) || current?.state !== "STARTING") {
    throw new Error("Managed Codex Bridge control record is not an owned STARTING run");
  }
  const next: CodexBridgeControlRecord = {
    ...current!,
    state: "RUNNING",
    pid: owner.pid,
    updatedAt: new Date().toISOString(),
  };
  atomicWriteJson(files.pidPath, next);
  return asPidRecord(next)!;
}

export function markCodexBridgeRunFailedIfOwned(
  owner: BridgeRunOwner,
  failure: string,
  evidence: CodexBridgeTerminalCleanupEvidence,
  rootDir = dataDir,
): boolean {
  const files = codexBridgeRunFiles(owner.projectId, owner.agentId, owner.runId, rootDir);
  const current = readControlPath(files.pidPath, owner.projectId, owner.agentId);
  if (!controlMatchesOwner(current, owner) || !current?.threadId) return false;
  const recovery = readCodexSessionTicketRecoveryState({
    projectId: owner.projectId,
    threadId: current.threadId,
    rootDir,
  });
  if (recovery?.runId === owner.runId && evidence.terminalCleanup === "CONFIRMED") {
    throw new Error(
      "Confirmed Codex session close retained a recovery index; refusing failed-run finalization",
    );
  }
  if (recovery?.runId === owner.runId && evidence.terminalCleanup === "AMBIGUOUS") {
    const marked = markCodexSessionTicketRecoveryDraining({
      projectId: owner.projectId,
      threadId: current.threadId,
      runId: owner.runId,
      sessionId: evidence.sessionId,
      bundleId: evidence.bundleId,
      rootDir,
    });
    if (!marked) {
      throw new Error(
        "Ambiguous Codex session close does not match retained replay authority; refusing failed-run finalization",
      );
    }
  }
  const failed: CodexBridgeControlRecord = {
    ...current,
    state: "FAILED",
    failure,
    updatedAt: new Date().toISOString(),
  };
  atomicWriteJson(files.pidPath, failed);
  if (existsSync(files.stopPath)) unlinkSync(files.stopPath);
  if (existsSync(files.healthPath)) unlinkSync(files.healthPath);
  if (existsSync(files.ownerPath)) unlinkSync(files.ownerPath);
  return true;
}

export async function awaitCodexBridgeRunOwnership(
  owner: BridgeRunOwner,
  rootDir = dataDir,
  timeoutMs = 5_000,
): Promise<CodexBridgePidRecord> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const files = codexBridgeRunFiles(owner.projectId, owner.agentId, owner.runId, rootDir);
    const current = readControlPath(files.pidPath, owner.projectId, owner.agentId);
    if (controlMatchesOwner(current, owner)) {
      if (current?.state === "RUNNING") return asPidRecord(current)!;
      if (current?.state === "FAILED") {
        throw new Error(current.failure ?? "Managed Codex Bridge startup failed");
      }
      if (current?.state === "CANCELLED") {
        throw new Error(current.failure ?? "Managed Codex Bridge launch was cancelled");
      }
      if (current?.state === "STARTING") return promoteStartingRecord(owner, rootDir);
    }
    if (Date.now() >= deadline) {
      throw new Error("Managed Codex Bridge child could not prove run ownership");
    }
    await sleep(25);
  }
}

export function promoteCodexBridgeRunThread(
  owner: BridgeRunOwner,
  threadId: string,
  rootDir = dataDir,
): CodexBridgePidRecord {
  const files = codexBridgeRunFiles(owner.projectId, owner.agentId, owner.runId, rootDir);
  const current = readControlPath(files.pidPath, owner.projectId, owner.agentId);
  if (
    !current ||
    current.state !== "RUNNING" ||
    current.pid !== owner.pid ||
    current.ownerNonce !== owner.ownerNonce ||
    current.runId !== owner.runId
  ) {
    throw new Error("Managed Codex Bridge thread promotion lost run ownership");
  }
  if (current.threadId && current.threadId !== threadId) {
    throw new Error("Managed Codex Bridge run is already bound to another thread");
  }
  const next: CodexBridgeControlRecord = {
    ...current,
    threadId,
    updatedAt: new Date().toISOString(),
  };
  atomicWriteJson(files.pidPath, next);
  bindCodexSessionTicketRecoveryRun({
    projectId: owner.projectId,
    threadId,
    runId: owner.runId,
    rootDir,
  });
  return asPidRecord(next)!;
}

export async function startCodexBridgeProcess(options: {
  entry: string;
  projectId: string;
  agentId: string;
  projectRoot?: string;
  threadId?: string;
  model?: string;
  hookCaptureBindingMode?: "required" | "disabled";
  historicalDeliveryProofMode?: "required" | "disabled";
  /** Disabled by default for compatibility; required enables child-only Ed25519 pipe proof. */
  workerProofMode?: BridgeWorkerProofMode;
  rootDir?: string;
  reserveLaunch?: ReserveCodexBridgeLaunch;
  drainRecovery?: DrainCodexBridgeTicketRecovery;
  reservationAttemptTimeoutMs?: number;
  startupProbeDelayMs?: number;
  launchLockWaitMs?: number;
  /** Verified local/live release identity supplied by the CLI runtime lock. */
  buildIdentity?: RuntimeBuildIdentity;
  /** Production recovery fence: the selected existing/recoverable run must be this exact run. */
  expectedRunId?: string;
  adapters?: StartAdapters;
}): Promise<{ record: CodexBridgePidRecord; alreadyRunning: boolean }> {
  const rootDir = options.rootDir ?? dataDir;
  if (
    options.expectedRunId !== undefined &&
    (!options.expectedRunId ||
      options.expectedRunId.trim() !== options.expectedRunId ||
      /[\r\n\0]/u.test(options.expectedRunId))
  ) {
    throw new Error("Managed Codex Bridge expected run id is invalid");
  }
  const workerProofMode = options.workerProofMode ?? "disabled";
  if (workerProofMode !== "disabled" && workerProofMode !== "required") {
    throw new Error("Managed Bridge worker proof mode must be disabled or required");
  }
  const buildIdentity =
    options.buildIdentity ??
    (process.env.NODE_ENV === "test"
      ? TEST_BUILD_IDENTITY
      : (() => {
          throw new Error("Managed Codex Bridge launch requires a verified build identity");
        })());
  if (process.env.NODE_ENV !== "test") {
    const verifiedEntry = verifiedCliReleaseEntrypoint(buildIdentity);
    if (resolve(options.entry) !== verifiedEntry) {
      throw new Error("Managed Codex Bridge entry is not the verified CLI release entrypoint");
    }
  }
  const isAlive = options.adapters?.processExists ?? processExists;
  const reservationAttemptTimeoutMs =
    options.reservationAttemptTimeoutMs ?? RESERVATION_ATTEMPT_TIMEOUT_MS;
  if (!Number.isFinite(reservationAttemptTimeoutMs) || reservationAttemptTimeoutMs <= 0) {
    throw new RangeError("reservationAttemptTimeoutMs must be a finite positive number");
  }
  const execute = async (): Promise<{
    record: CodexBridgePidRecord;
    alreadyRunning: boolean;
  }> => {
    clearStaleCodexBridgeRecords(options.projectId, options.agentId, rootDir, isAlive);
    if (options.threadId) {
      const recovery = readCodexSessionTicketRecoveryState({
        projectId: options.projectId,
        threadId: options.threadId,
        rootDir,
      });
      if (
        options.expectedRunId !== undefined &&
        recovery !== null &&
        recovery.runId !== options.expectedRunId
      ) {
        throw new Error("Managed Codex Bridge recovery state does not match the expected run");
      }
      if (recovery?.state === "DRAINING") {
        const current = findLiveOwner(
          options.projectId,
          options.agentId,
          options.threadId,
          rootDir,
          isAlive,
        );
        if (current) {
          throw new Error("Managed Codex Bridge terminal cleanup is still owned by a live process");
        }
        if (!options.drainRecovery) {
          throw new Error(
            "Codex session ticket recovery is DRAINING; exact terminal close replay is unavailable",
          );
        }
        await options.drainRecovery({
          projectId: options.projectId,
          agentId: options.agentId,
          threadId: options.threadId,
          runId: recovery.runId,
        });
        const remaining = readCodexSessionTicketRecoveryState({
          projectId: options.projectId,
          threadId: options.threadId,
          rootDir,
        });
        if (remaining !== null) {
          throw new Error("Confirmed Codex terminal close did not clear its retained ticket vault");
        }
      }
      const current = findLiveOwner(
        options.projectId,
        options.agentId,
        options.threadId,
        rootDir,
        isAlive,
      );
      if (current) {
        if (options.expectedRunId !== undefined && current.runId !== options.expectedRunId) {
          throw new Error("Managed Codex Bridge live owner does not match the expected run");
        }
        if (!current.runId) {
          throw new Error("Legacy managed Codex Bridge has no build identity");
        }
        const control = readControlPath(
          codexBridgeRunFiles(current.projectId, current.agentId, current.runId, rootDir).pidPath,
          current.projectId,
          current.agentId,
        );
        if (control?.version !== 4 || !control.buildIdentity) {
          throw new Error("Managed Codex Bridge has no verified build identity");
        }
        if (control.workerProofMode !== workerProofMode) {
          throw new Error("Managed Codex Bridge worker proof mode does not match the live owner");
        }
        assertExactBuildIdentity(buildIdentity, control.buildIdentity, "Managed Codex Bridge");
        return { record: current, alreadyRunning: true };
      }
    }
    if (!existsSync(options.entry)) {
      throw new Error(`CrossAgent CLI entry not found at ${options.entry}`);
    }
    const resumable = options.threadId
      ? findReservingRecord(options.projectId, options.agentId, options.threadId, rootDir)
      : null;
    if (
      options.expectedRunId !== undefined &&
      resumable !== null &&
      resumable.runId !== options.expectedRunId
    ) {
      throw new Error("Managed Bridge reservation does not match the expected run");
    }
    if (resumable?.buildIdentity) {
      assertExactBuildIdentity(
        buildIdentity,
        resumable.buildIdentity,
        "Managed Bridge reservation",
      );
    }
    if (resumable && resumable.workerProofMode !== workerProofMode) {
      throw new Error("Managed Bridge reservation worker proof mode changed across restart");
    }
    const recoverableRunId = options.threadId
      ? findRecoverableCodexSessionTicketRun({
          projectId: options.projectId,
          threadId: options.threadId,
          rootDir,
        })
      : null;
    if (options.expectedRunId !== undefined && recoverableRunId !== options.expectedRunId) {
      throw new Error("Managed Bridge has no recovery authority for the expected run");
    }
    const runId = resumable?.runId ?? recoverableRunId ?? createId("run");
    if (options.expectedRunId !== undefined && runId !== options.expectedRunId) {
      throw new Error("Managed Bridge launch selected a different run identity");
    }
    const ownerNonce = resumable?.ownerNonce ?? createId("own");
    if (!runId || !ownerNonce) {
      throw new Error("Managed Codex Bridge reserving run lost its identity");
    }
    const files = codexBridgeRunFiles(options.projectId, options.agentId, runId, rootDir);
    if (recoverableRunId && !resumable && existsSync(files.pidPath)) {
      const previous = readControlPath(files.pidPath, options.projectId, options.agentId);
      if (
        previous?.runId !== recoverableRunId ||
        previous.threadId !== options.threadId ||
        (previous.state !== "FAILED" && previous.state !== "CANCELLED")
      ) {
        throw new Error("Recoverable Codex ticket run still has non-terminal control authority");
      }
      removeDerivedRunFiles(previous, rootDir);
    }
    mkdirSync(dirname(files.pidPath), { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    if (workerProofMode === "required") {
      chmodSync(dirname(files.pidPath), PRIVATE_DIRECTORY_MODE);
      await assertWorkerProofOwnerPrivatePath(
        dirname(files.pidPath),
        false,
        options.adapters?.verifyOwnerPrivateAcl,
        options.adapters?.hardenOwnerPrivateAcl,
      );
    }
    let control =
      resumable ??
      writeControlRecord(
        {
          state: options.threadId ? "RESERVING" : "STARTING",
          projectId: options.projectId,
          agentId: options.agentId,
          runId,
          ownerNonce,
          threadId: options.threadId ?? null,
          launchReservation: null,
          entry: options.entry,
          logPath: files.logPath,
          projectRoot: options.projectRoot ?? dirname(options.entry),
          buildIdentity,
          workerProofMode,
        },
        rootDir,
      );
    if (workerProofMode === "required") {
      await assertWorkerProofOwnerPrivatePath(
        files.pidPath,
        true,
        options.adapters?.verifyOwnerPrivateAcl,
        options.adapters?.hardenOwnerPrivateAcl,
      );
    }
    if (options.threadId) {
      bindCodexSessionTicketRecoveryRun({
        projectId: options.projectId,
        threadId: options.threadId,
        runId,
        rootDir,
      });
    }
    let launchReservation: SessionLaunchReservation | null = control.launchReservation;
    if (options.threadId) {
      if (!options.reserveLaunch) {
        throw new Error("Managed existing-thread launch requires a Hub reservation adapter");
      }
      const reserved = await reserveLaunchWithRetry(
        options.reserveLaunch,
        {
          projectId: options.projectId,
          agentId: options.agentId,
          threadId: options.threadId,
          runId,
          idempotencyKey: `codex-launch:${runId}`,
        },
        reservationAttemptTimeoutMs,
      );
      const consumedRecovery = reserved.state === "CONSUMED";
      if (consumedRecovery) {
        if (recoverableRunId !== runId) {
          throw new Error("Consumed launch reservation cannot authorize a fresh managed run");
        }
        assertCodexSessionTicketRecoveryReservation({
          projectId: options.projectId,
          threadId: options.threadId,
          runId,
          reservation: reserved,
          rootDir,
        });
      }
      launchReservation = reservationForLaunch(
        reserved,
        {
          projectId: options.projectId,
          agentId: options.agentId,
          threadId: options.threadId,
          runId,
        },
        consumedRecovery,
      );
      control = promoteReservingRecord(control, launchReservation, rootDir);
    }
    if (workerProofMode === "required") {
      await assertWorkerProofOwnerPrivatePath(
        files.pidPath,
        true,
        options.adapters?.verifyOwnerPrivateAcl,
        options.adapters?.hardenOwnerPrivateAcl,
      );
    }
    if (hasMatchingRunStopRequest(control, rootDir)) {
      throw new Error("Managed Codex Bridge launch was cancelled before spawn");
    }
    const args = [
      options.entry,
      "codex",
      "--project-id",
      options.projectId,
      "--agent",
      options.agentId,
      "--foreground",
      "--managed",
      "--bridge-run-id",
      runId,
      "--bridge-control-path",
      files.pidPath,
    ];
    if (workerProofMode === "required") {
      args.push(
        "--bridge-worker-proof",
        "required",
        "--bridge-worker-proof-sidecar-path",
        files.workerProofPath,
      );
    }
    if (options.threadId) args.push("--thread", options.threadId);
    if (options.model) args.push("--model", options.model);
    if (options.hookCaptureBindingMode) {
      args.push("--hook-capture-binding", options.hookCaptureBindingMode);
    }
    if (options.historicalDeliveryProofMode) {
      args.push("--historical-delivery-proof", options.historicalDeliveryProofMode);
    }
    let child: SpawnedChild;
    try {
      child = (options.adapters?.spawnDetached ?? spawnDetached)(
        process.execPath,
        args,
        files.logPath,
        managedCodexBridgeEnvironment({
          ...process.env,
          CROSSAGENT_DATA_DIR: rootDir,
        }),
      );
    } catch (error) {
      removeDerivedRunFiles(
        { projectId: options.projectId, agentId: options.agentId, runId },
        rootDir,
      );
      throw error;
    }
    const pid = child.pid ?? 0;
    if (!pid) {
      removeDerivedRunFiles(
        { projectId: options.projectId, agentId: options.agentId, runId },
        rootDir,
      );
      throw new Error("Codex Bridge process did not return a PID");
    }
    const owner: BridgeRunOwner = {
      projectId: options.projectId,
      agentId: options.agentId,
      runId,
      ownerNonce,
      pid,
    };
    await options.adapters?.afterSpawn?.(owner);
    const record = await awaitCodexBridgeRunOwnership(owner, rootDir);
    child.unref();
    await sleep(options.startupProbeDelayMs ?? 500);
    if (!isAlive(record.pid)) {
      if (
        !markCodexBridgeRunFailedIfOwned(
          owner,
          `Codex Bridge exited during startup. Inspect ${files.logPath}`,
          { terminalCleanup: "NOT_ATTEMPTED" },
          rootDir,
        )
      ) {
        clearRunIfOwned(owner, rootDir, { terminalCleanup: "NOT_ATTEMPTED" });
      }
      throw new Error(`Codex Bridge exited during startup. Inspect ${files.logPath}`);
    }
    return { record, alreadyRunning: false };
  };

  if (!options.threadId) return execute();
  const lockPath = codexBridgeLaunchLockPath(
    options.projectId,
    options.agentId,
    options.threadId,
    rootDir,
  );
  const lock = await acquireLaunchLock(
    lockPath,
    options.launchLockWaitMs ?? LAUNCH_LOCK_WAIT_MS,
    isAlive,
    options.adapters?.afterLaunchLockOwnerVerified,
  );
  try {
    return await execute();
  } finally {
    releaseLaunchLock(lockPath, lock);
  }
}

function filterBridgeRecords(
  records: CodexBridgePidRecord[],
  selector: BridgeSelector,
  rootDir: string,
): CodexBridgePidRecord[] {
  return records.filter((record) => {
    const effectiveThreadId =
      record.threadId ??
      (record.runId === null
        ? (readCodexBridgeHealth(record.projectId, record.agentId, rootDir)?.threadId ?? null)
        : null);
    return (
      (!selector.runId || record.runId === selector.runId) &&
      (!selector.threadId || effectiveThreadId === selector.threadId) &&
      (!selector.pid || record.pid === selector.pid)
    );
  });
}

export function selectCodexBridgePids(
  projectId: string,
  agentId: string,
  selector: BridgeSelector = {},
  rootDir = dataDir,
): CodexBridgePidRecord[] {
  return filterBridgeRecords(listCodexBridgePids(projectId, agentId, rootDir), selector, rootDir);
}

function writeStopRequest(
  record: Pick<CodexBridgeControlRecord, "projectId" | "agentId" | "runId" | "ownerNonce" | "pid">,
  rootDir: string,
): void {
  const files = filesForRecord(record, rootDir);
  if (record.runId && record.ownerNonce) {
    atomicWriteJson(files.stopPath, {
      projectId: record.projectId,
      agentId: record.agentId,
      runId: record.runId,
      ownerNonce: record.ownerNonce,
      pid: record.pid,
      requestedAt: new Date().toISOString(),
    });
  } else {
    writeFileSync(files.stopPath, `${new Date().toISOString()}\n`, "utf8");
  }
}

function hasMatchingRunStopRequest(
  record: Pick<CodexBridgeControlRecord, "projectId" | "agentId" | "runId" | "ownerNonce" | "pid">,
  rootDir: string,
): boolean {
  if (!record.runId || !record.ownerNonce) return false;
  const { stopPath } = codexBridgeRunFiles(record.projectId, record.agentId, record.runId, rootDir);
  if (!existsSync(stopPath)) return false;
  try {
    const request = readJson(stopPath) as Partial<BridgeRunOwner>;
    return (
      request.projectId === record.projectId &&
      request.agentId === record.agentId &&
      request.runId === record.runId &&
      request.ownerNonce === record.ownerNonce &&
      (request.pid === null || request.pid === record.pid)
    );
  } catch {
    return false;
  }
}

export async function stopCodexBridgeProcess(
  projectId: string,
  agentId: string,
  rootDir = dataDir,
  selector: BridgeSelector = {},
  options: {
    processExists?: (pid: number) => boolean;
    maxWaitAttempts?: number;
    waitMs?: number;
    afterStopRequest?: () => void | Promise<void>;
  } = {},
): Promise<{
  stopped: boolean;
  stale: boolean;
  cancelled?: boolean;
  timedOut?: boolean;
  runId?: string | null;
}> {
  const isAlive = options.processExists ?? processExists;
  const staleRemoved = clearStaleCodexBridgeRecords(projectId, agentId, rootDir, isAlive);
  let records = runControlRecords(projectId, agentId, rootDir)
    .map(({ record }) => record)
    .filter(
      (record) =>
        (record.state === "RESERVING" ||
          record.state === "STARTING" ||
          record.state === "RUNNING") &&
        (!selector.runId || record.runId === selector.runId) &&
        (!selector.threadId || record.threadId === selector.threadId) &&
        (!selector.pid || record.pid === selector.pid),
    );
  if (records.length > 1) {
    const proven = records.filter((candidate) => {
      const running = asPidRecord(candidate);
      return running !== null && isAlive(running.pid) && hasFreshRunProof(running, rootDir);
    });
    const current = proven[0];
    const currentPid = current?.pid;
    if (
      proven.length === 1 &&
      typeof currentPid === "number" &&
      records.every((candidate) => candidate.state === "RUNNING" && candidate.pid === currentPid)
    ) {
      // A dead run and its successor can temporarily share a PID after immediate OS reuse. Only the
      // exact nonce-bound child lease is current authority; stale same-PID records stay on disk for
      // audit but do not make an otherwise unambiguous stop impossible.
      records = proven;
    } else {
      throw new Error(
        "Multiple managed Codex Bridges match; select one with --thread, --run-id, or --pid",
      );
    }
  }
  let record = records[0];
  if (!record) return { stopped: false, stale: staleRemoved };
  if (record.state !== "RUNNING" || record.pid === null) {
    if (!record.runId || !record.ownerNonce) {
      return { stopped: false, stale: staleRemoved };
    }
    writeStopRequest(record, rootDir);
    await options.afterStopRequest?.();
    const files = codexBridgeRunFiles(projectId, agentId, record.runId, rootDir);
    const current = readControlPath(files.pidPath, projectId, agentId);
    if (current?.runId !== record.runId || current.ownerNonce !== record.ownerNonce) {
      throw new Error("Managed Codex Bridge launch authority changed while cancelling");
    }
    if (current.state === "RUNNING" && current.pid !== null) {
      record = current;
    } else if (current.state === "RESERVING" || current.state === "STARTING") {
      atomicWriteJson(files.pidPath, {
        ...current,
        state: "CANCELLED",
        failure: "Managed Codex Bridge launch was cancelled",
        updatedAt: new Date().toISOString(),
      } satisfies CodexBridgeControlRecord);
      return { stopped: true, stale: false, cancelled: true, runId: record.runId };
    } else {
      throw new Error("Managed Codex Bridge launch became terminal while cancelling");
    }
  }
  const running = asPidRecord(record)!;
  if (!isAlive(running.pid)) {
    removeDerivedRunFiles(running, rootDir);
    return { stopped: false, stale: true, runId: running.runId };
  }
  writeStopRequest(record, rootDir);
  for (let attempt = 0; attempt < (options.maxWaitAttempts ?? 50); attempt += 1) {
    if (!isAlive(running.pid)) {
      removeDerivedRunFiles(running, rootDir);
      return { stopped: true, stale: false, runId: running.runId };
    }
    await sleep(options.waitMs ?? 100);
  }
  // A PID alone does not prove process identity after OS PID reuse. Leave the nonce-bound request
  // and record intact instead of escalating into an unrelated process.
  return {
    stopped: false,
    stale: false,
    timedOut: true,
    runId: running.runId,
  };
}

export function consumeCodexBridgeStopRequest(
  projectId: string,
  agentId: string,
  rootDir = dataDir,
): boolean {
  const { stopPath } = codexBridgeFiles(projectId, agentId, rootDir);
  if (!existsSync(stopPath)) return false;
  unlinkSync(stopPath);
  return true;
}

export function consumeCodexBridgeRunStopRequest(
  owner: BridgeRunOwner,
  rootDir = dataDir,
): boolean {
  const files = codexBridgeRunFiles(owner.projectId, owner.agentId, owner.runId, rootDir);
  if (!existsSync(files.stopPath)) return false;
  try {
    const request = readJson(files.stopPath) as Partial<BridgeRunOwner>;
    if (
      request.projectId !== owner.projectId ||
      request.agentId !== owner.agentId ||
      request.runId !== owner.runId ||
      request.ownerNonce !== owner.ownerNonce ||
      (request.pid !== null && request.pid !== owner.pid)
    ) {
      return false;
    }
    unlinkSync(files.stopPath);
    return true;
  } catch {
    return false;
  }
}

export function clearCodexBridgePidIfOwned(
  projectId: string,
  agentId: string,
  pid: number,
  rootDir = dataDir,
): void {
  const files = codexBridgeFiles(projectId, agentId, rootDir);
  const record = readCodexBridgePid(projectId, agentId, rootDir);
  if (record?.pid !== pid) return;
  if (existsSync(files.pidPath)) unlinkSync(files.pidPath);
  if (existsSync(files.stopPath)) unlinkSync(files.stopPath);
}

export function clearCodexBridgeRunIfOwned(
  owner: BridgeRunOwner,
  evidence: CodexBridgeTerminalCleanupEvidence,
  rootDir = dataDir,
): boolean {
  return clearRunIfOwned(owner, rootDir, evidence);
}
