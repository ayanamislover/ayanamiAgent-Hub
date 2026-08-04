export type RuntimeBuildIdentity = Readonly<{
  buildSessionId: string;
  buildId: string;
  migrationId: string;
  protocolId: string;
  manifestSha256: string;
}>;

export type ReleaseLifecycleLock = Readonly<{
  root: string;
  path: string;
  record: Readonly<{
    kind: "BUILD" | "RUNTIME" | "HUB_RUNTIME";
    pid: number;
    nonce: string;
    createdAt: string;
  }>;
}>;

export const BUILD_MANIFEST_RELATIVE_PATH: string;
export const BUILD_LOCK_RELATIVE_PATH: string;
export const HUB_RUNTIME_LOCK_RELATIVE_PATH: string;
export const HUB_SHUTDOWN_RECEIPT_NAME: string;
export const BUILD_SIDECAR_NAME: string;
export const BUILD_MANIFEST_SCHEMA_VERSION: 2;
export const RELEASE_COMPONENTS: readonly Readonly<{
  name: string;
  root: string;
  sidecar: string;
  entrypoints: readonly string[];
}>[];

export function findWorkspaceRoot(moduleUrl?: string): string;
export function verifyReleaseBuild(options?: {
  root?: string;
  moduleUrl?: string;
  expectedBuildId?: string;
  allowBuildLockNonce?: string;
}): RuntimeBuildIdentity;
export function assertExactBuildIdentity(
  expected: RuntimeBuildIdentity,
  actual: RuntimeBuildIdentity | null | undefined,
  label?: string,
): void;
export function serializeRuntimeBuildIdentity(identity: RuntimeBuildIdentity): string;
export function parseSerializedRuntimeBuildIdentity(serialized: string): RuntimeBuildIdentity;
export function formatReleaseBuildResult(identity: RuntimeBuildIdentity): string;
export function acquireReleaseLifecycleLock(
  root: string,
  kind: "BUILD" | "RUNTIME",
  options?: { onStaleLockObserved?: (record: ReleaseLifecycleLock["record"]) => void },
): ReleaseLifecycleLock;
export function releaseReleaseLifecycleLock(lock: ReleaseLifecycleLock): void;
export function withReleaseLifecycleLock<T>(
  root: string,
  kind: "BUILD" | "RUNTIME",
  operation: (lock: ReleaseLifecycleLock) => T | Promise<T>,
): Promise<T>;
export function createReleaseManifest(
  root: string,
  buildSessionId: string,
  createdAt?: string,
): Record<string, unknown>;
export function writeReleaseIdentity(root: string, manifest: Record<string, unknown>): void;
export function acquireHubRuntimeLease(
  root: string,
  options?: { onStaleLockObserved?: (record: ReleaseLifecycleLock["record"]) => void },
): ReleaseLifecycleLock;
export function releaseHubRuntimeLease(lock: ReleaseLifecycleLock): void;
export function assertNoActiveHubRuntime(root: string): void;
export function activeHubRuntimePid(root: string): number | null;
export function assertAuthorizedComponentBuild(
  root: string,
  environment?: NodeJS.ProcessEnv,
): ReleaseLifecycleLock["record"];
export function assertNoLegacyManagedHub(environment?: NodeJS.ProcessEnv): void;
export function verifiedReleaseEntrypoint(
  root: string,
  relativePath: string,
  expectedIdentity?: RuntimeBuildIdentity,
): string;
export type CanonicalMigration = Readonly<{
  version: number;
  name: string;
  sql: string;
  contentSha256: string;
}>;
export function loadCanonicalMigrationPlan(migrationDir: string): CanonicalMigration[];
export type HubShutdownReceipt = Readonly<{
  schemaVersion: 1;
  pid: number;
  instanceId: string;
  buildIdentity: RuntimeBuildIdentity;
  idempotencyKey: string;
  startedAt: string;
  stoppedAt: string;
}>;
export function writeHubShutdownReceipt(
  dataDir: string,
  receipt: Omit<HubShutdownReceipt, "schemaVersion">,
): HubShutdownReceipt;
export function readHubShutdownReceipt(dataDir: string): HubShutdownReceipt | null;
