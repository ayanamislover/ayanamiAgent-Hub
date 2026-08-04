import { resolve } from "node:path";
import type { RuntimeConfig } from "../src/config/runtime.js";
import {
  createTestVerifiedHubRelease,
  type RuntimeBuildIdentity,
} from "../src/runtime/build-identity.js";
import {
  createHubServer as createRawHubServer,
  type HubServer,
  type HubServerDeps,
} from "../src/server.js";

export type { HubServer };

const workspaceRoot = resolve(import.meta.dirname, "../../..");

export async function createHubServer(
  overrides: Partial<RuntimeConfig> = {},
  deps: Pick<HubServerDeps, "ptySpawner"> & { buildIdentity?: RuntimeBuildIdentity } = {},
): Promise<HubServer> {
  const verifiedRelease = createTestVerifiedHubRelease({
    ...(deps.buildIdentity ? { buildIdentity: deps.buildIdentity } : {}),
    workspaceRoot,
    migrationsDir: resolve(workspaceRoot, "migrations"),
    dashboardDir: resolve(overrides.dashboardDir ?? resolve(workspaceRoot, "apps/dashboard/dist")),
  });
  return createRawHubServer(overrides, {
    ...(deps.ptySpawner ? { ptySpawner: deps.ptySpawner } : {}),
    verifiedRelease,
  });
}
