import {
  assertExactBuildIdentity,
  findWorkspaceRoot,
  verifyReleaseBuild,
  type RuntimeBuildIdentity,
} from "../../../../scripts/build-identity.mjs";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

export type { RuntimeBuildIdentity };

export function verifyHubBuildIdentity(
  options: { root?: string; moduleUrl?: string; expectedBuildId?: string } = {},
): RuntimeBuildIdentity {
  return verifyReleaseBuild({ moduleUrl: import.meta.url, ...options });
}

export type VerifiedHubRelease = Readonly<{
  buildIdentity: RuntimeBuildIdentity;
  workspaceRoot: string;
  migrationsDir: string;
  dashboardDir: string;
}>;

const verifiedHubReleases = new WeakSet<object>();

function brandVerifiedHubRelease(release: VerifiedHubRelease): VerifiedHubRelease {
  verifiedHubReleases.add(release);
  return release;
}

export function assertVerifiedHubRelease(value: unknown): asserts value is VerifiedHubRelease {
  if (!value || typeof value !== "object" || !verifiedHubReleases.has(value)) {
    throw new Error("Hub startup requires a verified runtime release capability");
  }
}

/** Bind the actual runtime assets to the same workspace whose complete manifest was verified. */
export function verifyHubRuntimeRelease(
  options: {
    root?: string;
    moduleUrl?: string;
    expectedBuildId?: string;
    expectedBuildIdentity?: RuntimeBuildIdentity;
  } = {},
): VerifiedHubRelease {
  const workspaceRoot = realpathSync.native(
    options.root ?? findWorkspaceRoot(options.moduleUrl ?? import.meta.url),
  );
  const buildIdentity = verifyReleaseBuild({
    root: workspaceRoot,
    expectedBuildId: options.expectedBuildId,
  });
  if (options.expectedBuildIdentity) {
    assertExactBuildIdentity(options.expectedBuildIdentity, buildIdentity, "Expected runtime");
  }
  return brandVerifiedHubRelease(
    Object.freeze({
      buildIdentity,
      workspaceRoot,
      migrationsDir: realpathSync.native(resolve(workspaceRoot, "migrations")),
      dashboardDir: realpathSync.native(resolve(workspaceRoot, "apps", "dashboard", "dist")),
    }),
  );
}

/** Tests inject an explicit frozen identity; production startup never calls this helper. */
export function createTestBuildIdentity(seed = "test"): RuntimeBuildIdentity {
  const nibble = seed.length.toString(16).slice(-1);
  return Object.freeze({
    buildSessionId: "00000000-0000-4000-8000-000000000000",
    buildId: nibble.repeat(64),
    migrationId: "3".repeat(64),
    protocolId: "1".repeat(64),
    manifestSha256: "2".repeat(64),
  });
}

/** Internal test-only issuer. Never re-export this from the Hub package entrypoint. */
export function createTestVerifiedHubRelease(options: {
  buildIdentity?: RuntimeBuildIdentity;
  workspaceRoot: string;
  migrationsDir: string;
  dashboardDir: string;
}): VerifiedHubRelease {
  const buildIdentity = Object.freeze({
    ...(options.buildIdentity ?? createTestBuildIdentity()),
  });
  return brandVerifiedHubRelease(
    Object.freeze({
      buildIdentity,
      workspaceRoot: options.workspaceRoot,
      migrationsDir: options.migrationsDir,
      dashboardDir: options.dashboardDir,
    }),
  );
}
