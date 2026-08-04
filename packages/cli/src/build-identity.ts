import {
  activeHubRuntimePid,
  assertExactBuildIdentity as assertExactReleaseBuildIdentity,
  findWorkspaceRoot,
  readHubShutdownReceipt,
  serializeRuntimeBuildIdentity,
  verifyReleaseBuild,
  verifiedReleaseEntrypoint,
  writeHubShutdownReceipt,
  withReleaseLifecycleLock,
  type RuntimeBuildIdentity,
} from "../../../scripts/build-identity.mjs";

export type { RuntimeBuildIdentity };
export { readHubShutdownReceipt, writeHubShutdownReceipt };
export { serializeRuntimeBuildIdentity };

export function verifyWorkspaceBuildIdentity(
  options: { root?: string; moduleUrl?: string; expectedBuildId?: string } = {},
): RuntimeBuildIdentity {
  return verifyReleaseBuild({ moduleUrl: import.meta.url, ...options });
}

export function workspaceRootForBuildIdentity(moduleUrl = import.meta.url): string {
  return findWorkspaceRoot(moduleUrl);
}

/** The pid of a Hub already serving this workspace, or null. Never throws for a missing lease. */
export function servingHubPid(options: { root?: string; moduleUrl?: string } = {}): number | null {
  try {
    return activeHubRuntimePid(
      options.root ?? findWorkspaceRoot(options.moduleUrl ?? import.meta.url),
    );
  } catch {
    return null;
  }
}

export function verifiedCliReleaseEntrypoint(expectedIdentity: RuntimeBuildIdentity): string {
  const root = findWorkspaceRoot(import.meta.url);
  return verifiedReleaseEntrypoint(root, "packages/cli/dist/bin.js", expectedIdentity);
}

export function assertRunningVerifiedCliEntrypoint(
  entry: string,
  options: { root?: string; moduleUrl?: string } = {},
): RuntimeBuildIdentity {
  const root = options.root ?? findWorkspaceRoot(options.moduleUrl ?? import.meta.url);
  const identity = verifyReleaseBuild({ root });
  const expected = verifiedReleaseEntrypoint(root, "packages/cli/dist/bin.js", identity);
  if (entry !== expected) {
    throw new Error("Running CLI entry is not the verified release entrypoint");
  }
  return identity;
}

export function assertExactBuildIdentity(
  expected: RuntimeBuildIdentity,
  actual: RuntimeBuildIdentity | null | undefined,
  label = "Runtime",
): void {
  assertExactReleaseBuildIdentity(expected, actual, label);
}

export function parseRuntimeBuildIdentity(value: unknown): RuntimeBuildIdentity | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.join(",") !== "buildId,buildSessionId,manifestSha256,migrationId,protocolId" ||
    typeof record.buildSessionId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      record.buildSessionId,
    ) ||
    typeof record.buildId !== "string" ||
    typeof record.migrationId !== "string" ||
    typeof record.protocolId !== "string" ||
    typeof record.manifestSha256 !== "string" ||
    ![record.buildId, record.migrationId, record.protocolId, record.manifestSha256].every((hash) =>
      /^[a-f0-9]{64}$/u.test(hash),
    )
  ) {
    return null;
  }
  return Object.freeze({
    buildSessionId: record.buildSessionId,
    buildId: record.buildId,
    migrationId: record.migrationId,
    protocolId: record.protocolId,
    manifestSha256: record.manifestSha256,
  });
}

export function withRuntimeBuildLock<T>(
  operation: (identity: RuntimeBuildIdentity) => T | Promise<T>,
  options: { root?: string; moduleUrl?: string } = {},
): Promise<T> {
  const root = options.root ?? findWorkspaceRoot(options.moduleUrl ?? import.meta.url);
  return withReleaseLifecycleLock(root, "RUNTIME", () =>
    operation(verifyWorkspaceBuildIdentity({ root })),
  );
}

/**
 * The same lock, but it hands the operation `null` when the workspace release cannot be verified
 * rather than refusing to run at all.
 *
 * Only for operations that cannot make an unverified workspace worse: stopping a Hub, reporting
 * status, clearing a dead PID. Starting one still demands a verified build, because starting is
 * where an unverified release does damage.
 *
 * Without this, a workspace whose manifest has drifted -- adding a migration without rebuilding is
 * enough -- deadlocks: the build refuses while a Hub is serving, and stop refuses because it
 * cannot verify the build. Both recovery paths are gated on the thing that needs recovering.
 */
export function withRecoverableRuntimeBuildLock<T>(
  operation: (identity: RuntimeBuildIdentity | null, failure: Error | null) => T | Promise<T>,
  options: { root?: string; moduleUrl?: string } = {},
): Promise<T> {
  const root = options.root ?? findWorkspaceRoot(options.moduleUrl ?? import.meta.url);
  return withReleaseLifecycleLock(root, "RUNTIME", () => {
    // Verification is resolved before the operation runs and the operation runs exactly once, so
    // an error thrown by the operation itself can never be mistaken for a verification failure.
    let identity: RuntimeBuildIdentity | null = null;
    let failure: Error | null = null;
    try {
      identity = verifyWorkspaceBuildIdentity({ root });
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
    }
    return operation(identity, failure);
  });
}
