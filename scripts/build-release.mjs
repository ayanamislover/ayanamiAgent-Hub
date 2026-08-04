import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  RELEASE_COMPONENTS,
  assertNoActiveHubRuntime,
  assertNoLegacyManagedHub,
  createReleaseManifest,
  findWorkspaceRoot,
  formatReleaseBuildResult,
  verifyReleaseBuild,
  withReleaseLifecycleLock,
  writeReleaseIdentity,
} from "./build-identity.mjs";

const workspaceRoot = findWorkspaceRoot(import.meta.url);

function buildComponent(component, lock) {
  const pnpmEntrypoint = process.env.npm_execpath;
  if (!pnpmEntrypoint || !existsSync(pnpmEntrypoint)) {
    throw new Error(
      "The release builder must be invoked through the repository `pnpm build` script",
    );
  }
  // Execute pnpm's JavaScript entrypoint through the current Node runtime. Node 24 on Windows
  // rejects direct spawnSync of .cmd shims with EINVAL, and shell:true would weaken argument
  // boundaries for paths containing spaces.
  const result = spawnSync(
    process.execPath,
    [pnpmEntrypoint, "--filter", component.name, "build"],
    {
      cwd: workspaceRoot,
      env: {
        ...process.env,
        CROSSAGENT_ROOT_BUILD_PID: String(lock.record.pid),
        CROSSAGENT_ROOT_BUILD_NONCE: lock.record.nonce,
      },
      stdio: "inherit",
      windowsHide: true,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `Build failed for ${component.name} with exit code ${result.status ?? "unknown"}`,
    );
  }
}

const identity = await withReleaseLifecycleLock(workspaceRoot, "BUILD", (lock) => {
  assertNoActiveHubRuntime(workspaceRoot);
  assertNoLegacyManagedHub();
  const buildSessionId = randomUUID();
  for (const component of RELEASE_COMPONENTS) buildComponent(component, lock);
  const manifest = createReleaseManifest(workspaceRoot, buildSessionId);
  writeReleaseIdentity(workspaceRoot, manifest);
  return verifyReleaseBuild({ root: workspaceRoot, allowBuildLockNonce: lock.record.nonce });
});

// There is deliberately no "finalize current dist" mode: a failed run can only be repaired by
// rebuilding every component under a new buildSessionId. Exact publication verification completed
// while this builder still owned the BUILD lock.
process.stdout.write(`${formatReleaseBuildResult(identity)}\n`);
