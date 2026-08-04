import {
  closeSync,
  constants,
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
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import {
  dataDir,
  defaultBaseUrl,
  logPath,
  pidPath,
  readDashboardToken,
  workspaceFile,
} from "./paths.js";
import {
  assertExactBuildIdentity,
  parseRuntimeBuildIdentity,
  readHubShutdownReceipt,
  serializeRuntimeBuildIdentity,
  servingHubPid,
  verifyWorkspaceBuildIdentity,
  withRecoverableRuntimeBuildLock,
  withRuntimeBuildLock,
  type RuntimeBuildIdentity,
} from "./build-identity.js";

const shutdownIntentPath = resolve(dataDir, "hub.shutdown.intent.json");

/** One generation is kept, matching the channel's own logger. */
export const MAX_HUB_LOG_BYTES = 8 * 1024 * 1024;

/**
 * Moves an oversized log aside so the next append starts a fresh file.
 *
 * Start is the only seam available. The spawned Hub inherits this log's descriptor for its whole
 * life, so nothing can rotate it while that Hub runs: the descriptor would follow the renamed file,
 * and Windows refuses to rename a file held open for append at all. Growth is therefore bounded
 * across restarts rather than within one run -- an unrotated hub.log on this machine had reached
 * 219MB, holding 29,597 copies of a credential that has to be treated as disclosed because of it.
 */
export function rotateLogIfLarge(path: string, maxBytes = MAX_HUB_LOG_BYTES): boolean {
  try {
    if (statSync(path).size < maxBytes) return false;
    renameSync(path, `${path}.1`);
    return true;
  } catch {
    // No log yet, or it is held open and cannot be moved aside. Appending is still the right
    // next step: refusing to start a Hub because its log could not be rotated would be worse.
    return false;
  }
}

export type PidRecord = {
  pid: number;
  startedAt: string;
  port: number;
  entry: string;
  instanceId: string | null;
  buildIdentity: RuntimeBuildIdentity | null;
};

export type StartResult = Omit<PidRecord, "instanceId" | "buildIdentity"> & {
  instanceId: string;
  buildIdentity: RuntimeBuildIdentity;
  /** Whether an already-running Hub was adopted instead of a new one being started. */
  reused: boolean;
  /**
   * Whether the bundle on disk is newer than the process serving it. A Hub loads its code once, at
   * startup, so a build that landed afterwards exists but is not running -- and `start` adopting
   * that process looks exactly like a successful deploy unless it says otherwise.
   */
  servingStaleBuild: boolean;
};

type HubProcessOptions = {
  port?: number;
  dashboardDir?: string;
};

/** The child receives workspace-owned runtime assets even when the CLI was invoked elsewhere. */
export function hubProcessEnvironment(
  options: HubProcessOptions = {},
  environment: NodeJS.ProcessEnv = process.env,
  expectedBuild?: RuntimeBuildIdentity,
): NodeJS.ProcessEnv {
  const port = options.port ?? Number(environment.CROSSAGENT_PORT ?? 4387);
  const dashboardDir = workspaceFile("apps", "dashboard", "dist");
  const migrationsDir = workspaceFile("migrations");
  if (options.dashboardDir && resolve(options.dashboardDir) !== dashboardDir) {
    throw new Error("Dashboard runtime override must match the verified workspace release");
  }
  if (
    environment.CROSSAGENT_MIGRATIONS_DIR &&
    resolve(environment.CROSSAGENT_MIGRATIONS_DIR) !== migrationsDir
  ) {
    throw new Error("Migration runtime override must match the verified workspace release");
  }
  const childEnvironment = { ...environment };
  delete childEnvironment.CROSSAGENT_EXPECTED_BUILD_ID;
  delete childEnvironment.CROSSAGENT_EXPECTED_BUILD_IDENTITY;
  return {
    ...childEnvironment,
    CROSSAGENT_PORT: String(port),
    CROSSAGENT_DASHBOARD_DIR: dashboardDir,
    CROSSAGENT_MIGRATIONS_DIR: migrationsDir,
    ...(expectedBuild
      ? { CROSSAGENT_EXPECTED_BUILD_IDENTITY: serializeRuntimeBuildIdentity(expectedBuild) }
      : {}),
  };
}

export type VerifiedHubHealth = Record<string, unknown> & {
  ok: true;
  pid: number;
  instanceId: string;
  startedAt: string;
  build: RuntimeBuildIdentity;
};

function parseVerifiedHubHealth(value: unknown): VerifiedHubHealth | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const build = parseRuntimeBuildIdentity(record.build);
  if (
    record.ok !== true ||
    !Number.isSafeInteger(record.pid) ||
    Number(record.pid) <= 0 ||
    typeof record.instanceId !== "string" ||
    !/^[a-f0-9]{32}$/u.test(record.instanceId) ||
    typeof record.startedAt !== "string" ||
    !Number.isFinite(Date.parse(record.startedAt)) ||
    !build
  ) {
    return null;
  }
  return {
    ...record,
    ok: true,
    pid: Number(record.pid),
    instanceId: record.instanceId,
    startedAt: record.startedAt,
    build,
  };
}

function parsePidRecord(value: unknown): PidRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(record.pid) ||
    Number(record.pid) <= 0 ||
    typeof record.startedAt !== "string" ||
    !Number.isFinite(Date.parse(record.startedAt)) ||
    !Number.isSafeInteger(record.port) ||
    Number(record.port) <= 0 ||
    Number(record.port) > 65_535 ||
    typeof record.entry !== "string" ||
    record.entry.length === 0
  ) {
    return null;
  }
  const buildIdentity = parseRuntimeBuildIdentity(record.buildIdentity);
  return {
    pid: Number(record.pid),
    startedAt: record.startedAt,
    port: Number(record.port),
    entry: record.entry,
    instanceId: typeof record.instanceId === "string" ? record.instanceId : null,
    buildIdentity,
  };
}

export function readPidRecord(): PidRecord | null {
  if (!existsSync(pidPath)) return null;
  try {
    return parsePidRecord(JSON.parse(readFileSync(pidPath, "utf8")));
  } catch {
    return null;
  }
}

export function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

export function clearStalePid(): Promise<boolean> {
  // Deleting the record of a process that no longer exists needs no build identity at all, and
  // refusing to do it on an unverifiable workspace only strands the stale file.
  return withRecoverableRuntimeBuildLock(() => {
    const record = readPidRecord();
    if (!record && existsSync(pidPath)) {
      throw new Error("LEGACY_BUILD_UNVERIFIED: Hub PID record is malformed");
    }
    if (!record || processExists(record.pid)) return false;
    unlinkPidIfOwned(record.pid, record.instanceId);
    return true;
  });
}

export async function health(baseUrl = defaultBaseUrl): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(`${baseUrl}/api/health`, {
      signal: AbortSignal.timeout(1500),
    });
    return response.ok ? ((await response.json()) as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export async function verifiedHealth(baseUrl = defaultBaseUrl): Promise<VerifiedHubHealth | null> {
  return parseVerifiedHubHealth(await health(baseUrl));
}

export type HubRuntimeStatus = {
  running: boolean;
  verified: boolean;
  stale: boolean;
  pid: PidRecord | null;
  health: VerifiedHubHealth | null;
  reason?: string;
};

/** Status is observational: it never deletes or signals an unverified/reused PID. */
export function inspectHubRuntimeStatus(): Promise<HubRuntimeStatus> {
  // Diagnosis must survive the thing being diagnosed: an unverifiable workspace is exactly when a
  // user runs status, so it reports the failure as a reason rather than becoming the failure.
  return withRecoverableRuntimeBuildLock(async (localBuild, localBuildFailure) => {
    const record = readPidRecord();
    if (!record && existsSync(pidPath)) {
      return {
        running: false,
        verified: false,
        stale: false,
        pid: null,
        health: null,
        reason: "LEGACY_BUILD_UNVERIFIED: Hub PID record is malformed",
      };
    }
    // `verified` tracks the workspace release, so it cannot read true when that release failed to
    // verify -- even on the paths that never needed to consult it.
    const verified = localBuild !== null;
    const failureReason = localBuildFailure ? { reason: localBuildFailure.message } : {};
    if (!record) {
      return { running: false, verified, stale: false, pid: null, health: null, ...failureReason };
    }
    if (!processExists(record.pid)) {
      return { running: false, verified, stale: true, pid: record, health: null, ...failureReason };
    }
    try {
      const live = await requireExactLiveHub(record, localBuild);
      return { running: true, verified, stale: false, pid: record, health: live, ...failureReason };
    } catch (error) {
      return {
        running: false,
        verified: false,
        stale: false,
        pid: record,
        health: null,
        reason: error instanceof Error ? error.message : "Hub runtime verification failed",
      };
    }
  });
}

/** Managed children call this before reading ticket material or starting a model process. */
export async function requireExactRuntimeBuild(
  expectedBuild: RuntimeBuildIdentity,
  baseUrl = defaultBaseUrl,
): Promise<VerifiedHubHealth> {
  const localBuild = verifyWorkspaceBuildIdentity();
  assertExactBuildIdentity(expectedBuild, localBuild, "Managed child local release");
  const live = await verifiedHealth(baseUrl);
  if (!live) {
    throw new Error("LEGACY_BUILD_UNVERIFIED: live Hub health has no valid build identity");
  }
  assertExactBuildIdentity(expectedBuild, live.build, "Managed child live Hub");
  return live;
}

/**
 * `localBuild` is null only on a recovery path, where the workspace release could not be verified
 * at all. Every check that establishes "this live process is the Hub this PID record describes"
 * still runs; what is skipped is the comparison against a working tree that cannot be read. The
 * record and the live Hub are then cross-checked against each other instead, so the caller still
 * acts on one coherent identity rather than none.
 */
async function requireExactLiveHub(
  record: PidRecord,
  localBuild: RuntimeBuildIdentity | null,
): Promise<VerifiedHubHealth> {
  if (!record.instanceId || !record.buildIdentity) {
    throw new Error("LEGACY_BUILD_UNVERIFIED: Hub PID record has no verified build identity");
  }
  if (record.entry !== workspaceFile("apps", "hub", "dist", "main.js")) {
    throw new Error("Hub PID record points outside the verified release entrypoint");
  }
  if (localBuild) assertExactBuildIdentity(localBuild, record.buildIdentity, "Hub PID record");
  const live = await verifiedHealth(`http://127.0.0.1:${record.port}`);
  if (!live) {
    throw new Error("LEGACY_BUILD_UNVERIFIED: live Hub health has no valid build identity");
  }
  if (live.pid !== record.pid || live.instanceId !== record.instanceId) {
    throw new Error("Hub PID ownership does not match the live Hub instance");
  }
  if (live.startedAt !== record.startedAt || Number(live.port) !== record.port) {
    throw new Error("Hub PID record does not match the frozen live Hub metadata");
  }
  assertExactBuildIdentity(localBuild ?? record.buildIdentity, live.build, "Live Hub");
  return live;
}

function unlinkPidIfOwned(pid: number, instanceId: string | null): void {
  const current = readPidRecord();
  if (current?.pid === pid && current.instanceId === instanceId && existsSync(pidPath)) {
    unlinkSync(pidPath);
  }
}

function writePidRecord(record: PidRecord): void {
  writeJsonAtomically(pidPath, record);
}

function writeJsonAtomically(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(temporary, path);
  } catch (error) {
    if (descriptor !== null) closeSync(descriptor);
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
}

type ShutdownIntent = {
  schemaVersion: 1;
  instanceId: string;
  buildIdentity: RuntimeBuildIdentity;
  idempotencyKey: string;
  requestedAt: string;
};

function readShutdownIntent(): ShutdownIntent | null {
  if (!existsSync(shutdownIntentPath)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(shutdownIntentPath, "utf8"));
  } catch {
    throw new Error("Hub shutdown intent is malformed");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Hub shutdown intent is malformed");
  }
  const record = raw as Record<string, unknown>;
  const keys = Object.keys(record).sort().join(",");
  const buildIdentity = parseRuntimeBuildIdentity(record.buildIdentity);
  if (
    keys !== "buildIdentity,idempotencyKey,instanceId,requestedAt,schemaVersion" ||
    record.schemaVersion !== 1 ||
    typeof record.instanceId !== "string" ||
    !/^[a-f0-9]{32}$/u.test(record.instanceId) ||
    typeof record.idempotencyKey !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      record.idempotencyKey,
    ) ||
    typeof record.requestedAt !== "string" ||
    !Number.isFinite(Date.parse(record.requestedAt)) ||
    !buildIdentity
  ) {
    throw new Error("Hub shutdown intent is malformed");
  }
  return {
    schemaVersion: 1,
    instanceId: record.instanceId,
    buildIdentity,
    idempotencyKey: record.idempotencyKey,
    requestedAt: record.requestedAt,
  };
}

function shutdownIntentFor(
  instanceId: string,
  buildIdentity: RuntimeBuildIdentity,
): ShutdownIntent {
  const existing = readShutdownIntent();
  if (existing) {
    if (existing.instanceId !== instanceId) {
      const receipt = readHubShutdownReceipt(dataDir);
      if (
        receipt?.instanceId === existing.instanceId &&
        receipt.idempotencyKey === existing.idempotencyKey
      ) {
        assertExactBuildIdentity(
          existing.buildIdentity,
          receipt.buildIdentity,
          "Previous Hub shutdown receipt",
        );
        clearShutdownIntentIfOwned(existing);
        return shutdownIntentFor(instanceId, buildIdentity);
      }
      throw new Error("A shutdown intent for another Hub instance requires reconciliation");
    }
    assertExactBuildIdentity(buildIdentity, existing.buildIdentity, "Hub shutdown intent");
    return existing;
  }
  const created: ShutdownIntent = {
    schemaVersion: 1,
    instanceId,
    buildIdentity,
    idempotencyKey: randomUUID(),
    requestedAt: new Date().toISOString(),
  };
  writeJsonAtomically(shutdownIntentPath, created);
  return created;
}

function clearShutdownIntentIfOwned(intent: ShutdownIntent): void {
  const current = readShutdownIntent();
  if (
    current?.instanceId === intent.instanceId &&
    current.idempotencyKey === intent.idempotencyKey &&
    existsSync(shutdownIntentPath)
  ) {
    unlinkSync(shutdownIntentPath);
  }
}

function reconcileDeadHubBeforeStart(record: PidRecord, localBuild: RuntimeBuildIdentity): void {
  const intent = readShutdownIntent();
  if (!intent) {
    unlinkPidIfOwned(record.pid, record.instanceId);
    return;
  }
  if (record.instanceId !== intent.instanceId) {
    throw new Error("Dead Hub shutdown requires reconciliation before a replacement can start");
  }
  assertExactBuildIdentity(localBuild, intent.buildIdentity, "Dead Hub shutdown intent");
  const receipt = readHubShutdownReceipt(dataDir);
  if (
    !receipt ||
    receipt.pid !== record.pid ||
    receipt.instanceId !== intent.instanceId ||
    receipt.startedAt !== record.startedAt ||
    receipt.idempotencyKey !== intent.idempotencyKey
  ) {
    throw new Error("Dead Hub shutdown requires reconciliation before a replacement can start");
  }
  assertExactBuildIdentity(
    intent.buildIdentity,
    receipt.buildIdentity,
    "Dead Hub shutdown receipt",
  );
  clearShutdownIntentIfOwned(intent);
  unlinkPidIfOwned(record.pid, record.instanceId);
}

export async function startHub(
  options: HubProcessOptions & {
    foreground?: boolean;
  } = {},
): Promise<StartResult> {
  return withRuntimeBuildLock(async (localBuild) => {
    const already = readPidRecord();
    if (!already && existsSync(pidPath)) {
      throw new Error("LEGACY_BUILD_UNVERIFIED: Hub PID record is malformed");
    }
    if (already && processExists(already.pid)) {
      await requireExactLiveHub(already, localBuild);
      return {
        ...already,
        instanceId: already.instanceId!,
        buildIdentity: already.buildIdentity!,
        reused: true,
        servingStaleBuild: false,
      };
    }
    if (already && existsSync(pidPath)) reconcileDeadHubBeforeStart(already, localBuild);
    const entry = workspaceFile("apps", "hub", "dist", "main.js");
    if (!existsSync(entry)) {
      throw new Error(`Hub build not found at ${entry}. Run pnpm build first.`);
    }
    mkdirSync(dirname(pidPath), { recursive: true });
    const port = options.port ?? Number(process.env.CROSSAGENT_PORT ?? 4387);
    const environment = hubProcessEnvironment(options, process.env, localBuild);
    if (!options.foreground) rotateLogIfLarge(logPath);
    const output = options.foreground ? "inherit" : openSync(logPath, "a");
    const child = spawn(process.execPath, [entry], {
      detached: !options.foreground,
      stdio: options.foreground ? "inherit" : ["ignore", output, output],
      env: environment,
      windowsHide: !options.foreground,
    });
    if (!options.foreground && typeof output === "number") closeSync(output);
    const pid = child.pid ?? 0;
    if (!pid) throw new Error("Hub process did not return a PID");
    let spawnedInstanceId: string | null = null;
    try {
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const ready = await verifiedHealth(`http://127.0.0.1:${port}`);
        if (ready) {
          if (ready.pid !== pid) throw new Error("Hub health belongs to a different process");
          assertExactBuildIdentity(localBuild, ready.build, "Started Hub");
          const record: PidRecord = {
            pid,
            startedAt: ready.startedAt,
            port,
            entry,
            instanceId: ready.instanceId,
            buildIdentity: localBuild,
          };
          spawnedInstanceId = ready.instanceId;
          writePidRecord(record);
          const started: StartResult = {
            ...record,
            instanceId: record.instanceId!,
            buildIdentity: record.buildIdentity!,
            reused: false,
            servingStaleBuild: false,
          };
          if (!options.foreground) {
            child.unref();
            return started;
          }
          await new Promise<void>((resolvePromise, reject) => {
            child.once("exit", () => resolvePromise());
            child.once("error", reject);
          });
          unlinkPidIfOwned(pid, ready.instanceId);
          return started;
        }
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
      }
      // The commonest cause is another Hub holding the workspace runtime lease, and it dies before
      // logging exists -- so the generic message sent readers to a log file that was never created.
      const serving = servingHubPid();
      throw new Error(
        serving && serving !== pid
          ? `A Hub is already serving this workspace (pid ${serving}). One Hub per built workspace: a different port and data directory do not separate them. Stop that one first.`
          : `Hub did not become healthy. Inspect ${logPath}`,
      );
    } catch (error) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      unlinkPidIfOwned(pid, spawnedInstanceId);
      throw error;
    }
  });
}

export async function stopHub(): Promise<{
  stopped: boolean;
  stale: boolean;
  buildVerified: boolean;
  reason?: string;
}> {
  return withRecoverableRuntimeBuildLock(async (localBuild, localBuildFailure) => {
    const unverified = localBuildFailure
      ? { buildVerified: false, reason: localBuildFailure.message }
      : { buildVerified: true };
    const record = readPidRecord();
    if (!record && existsSync(pidPath)) {
      throw new Error("LEGACY_BUILD_UNVERIFIED: Hub PID record is malformed");
    }
    if (!record) return { stopped: false, stale: false, ...unverified };
    if (!processExists(record.pid)) {
      unlinkPidIfOwned(record.pid, record.instanceId);
      return { stopped: false, stale: true, ...unverified };
    }
    const live = await requireExactLiveHub(record, localBuild);
    // Stopping is the recovery path. When the workspace release cannot be verified -- adding a
    // migration without rebuilding is enough -- the target is still fully pinned by the live Hub's
    // own attested identity, which requireExactLiveHub has just matched against the PID record.
    // Refusing here would leave the Hub unstoppable and therefore the build unfixable.
    const targetBuild = localBuild ?? live.build;
    const controllerToken = readDashboardToken();
    const intent = shutdownIntentFor(live.instanceId, targetBuild);
    const idempotencyKey = intent.idempotencyKey;
    let acknowledged = false;
    let ambiguousRequest = false;
    for (let attempt = 0; attempt < 2 && !acknowledged; attempt += 1) {
      let response: Response;
      try {
        response = await fetch(`http://127.0.0.1:${record.port}/api/runtime/shutdown`, {
          method: "POST",
          headers: {
            accept: "application/json",
            authorization: `Bearer ${controllerToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            instanceId: record.instanceId,
            build: targetBuild,
            idempotencyKey,
          }),
          signal: AbortSignal.timeout(2_000),
        });
      } catch {
        // The Hub may have accepted the exact request and closed before its ACK reached the CLI.
        // Replay once with the same key, then determine the outcome only from its durable receipt.
        ambiguousRequest = true;
        continue;
      }
      if (!response.ok) {
        if (ambiguousRequest) break;
        throw new Error(`Hub cooperative shutdown was rejected (${response.status})`);
      }
      let acknowledgement: unknown;
      try {
        acknowledgement = await response.json();
      } catch {
        throw new Error("Hub cooperative shutdown returned an invalid acknowledgement");
      }
      const ack = acknowledgement as Record<string, unknown>;
      if (
        ack.accepted !== true ||
        ack.idempotencyKey !== idempotencyKey ||
        ack.instanceId !== live.instanceId ||
        ack.buildId !== live.build.buildId ||
        typeof ack.scheduledAt !== "string" ||
        !Number.isFinite(Date.parse(ack.scheduledAt))
      ) {
        throw new Error("Hub cooperative shutdown acknowledgement does not match the target");
      }
      acknowledged = true;
    }
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const receipt = readHubShutdownReceipt(dataDir);
      if (
        receipt?.pid === live.pid &&
        receipt.instanceId === live.instanceId &&
        receipt.startedAt === live.startedAt &&
        receipt.idempotencyKey === intent.idempotencyKey
      ) {
        assertExactBuildIdentity(targetBuild, receipt.buildIdentity, "Hub shutdown receipt");
        clearShutdownIntentIfOwned(intent);
        unlinkPidIfOwned(record.pid, record.instanceId);
        return { stopped: true, stale: false, ...unverified };
      }
      // A missing endpoint or a replacement process is not terminal proof for the target. Keep the
      // durable PID + intent until the exact old Hub publishes its post-close receipt.
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
    throw new Error(
      `Hub cooperative shutdown timed out${acknowledged ? " after ACK" : " after an ambiguous request"}; no process signal was sent`,
    );
  });
}
