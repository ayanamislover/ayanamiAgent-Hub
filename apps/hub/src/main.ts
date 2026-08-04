import type { HubServer } from "./server.js";
import { verifyHubRuntimeRelease } from "./runtime/build-identity.js";
import { completeHubShutdown } from "./runtime/shutdown.js";
import {
  acquireHubRuntimeLease,
  findWorkspaceRoot,
  parseSerializedRuntimeBuildIdentity,
  releaseHubRuntimeLease,
  writeHubShutdownReceipt,
} from "../../../scripts/build-identity.mjs";

const workspaceRoot = findWorkspaceRoot(import.meta.url);
const runtimeLease = acquireHubRuntimeLease(workspaceRoot);
let server: HubServer;
try {
  // Verify the complete, single-session release before opening SQLite or running a migration. The
  // expected ID is only a launcher pin: the Hub independently hashes every declared artifact.
  const expectedBuildIdentity = process.env.CROSSAGENT_EXPECTED_BUILD_IDENTITY
    ? parseSerializedRuntimeBuildIdentity(process.env.CROSSAGENT_EXPECTED_BUILD_IDENTITY)
    : undefined;
  const verifiedRelease = verifyHubRuntimeRelease({
    root: workspaceRoot,
    ...(expectedBuildIdentity ? { expectedBuildIdentity } : {}),
  });
  // Keep the mutable application graph behind the immutable release preflight. A stale workspace
  // package must not execute (or even fail to link) before build/runtime locks and the exact
  // release manifest have been verified.
  const { createHubServer } = await import("./server.js");
  server = await createHubServer({}, { verifiedRelease });
} catch (error) {
  releaseHubRuntimeLease(runtimeLease);
  throw error;
}

await server.app.listen({
  host: server.config.host,
  port: server.config.port,
});

server.app.log.info(
  {
    host: server.config.host,
    port: server.config.port,
    databasePath: server.config.databasePath,
    tokenPath: server.tokenPath,
    buildId: server.buildIdentity.buildId,
  },
  "CrossAgent Hub ready",
);

let shutdownStarted = false;
async function shutdown(
  reason: string,
  request?: { idempotencyKey: string; scheduledAt: string },
): Promise<void> {
  if (shutdownStarted) return;
  shutdownStarted = true;
  try {
    server.app.log.info({ reason }, "Stopping CrossAgent Hub");
    await completeHubShutdown({
      close: server.close,
      ...(request
        ? {
            writeReceipt: () =>
              writeHubShutdownReceipt(server.config.dataDir, {
                pid: process.pid,
                instanceId: server.instanceId,
                buildIdentity: server.buildIdentity,
                idempotencyKey: request.idempotencyKey,
                startedAt: server.startedAt,
                stoppedAt: new Date().toISOString(),
              }),
          }
        : {}),
      releaseLease: () => releaseHubRuntimeLease(runtimeLease),
    });
  } catch (error) {
    // Never release a live-runtime lease after an ambiguous close. A fatal process exit leaves a
    // dead-owner lease that the next startup can retire safely.
    server.app.log.fatal({ err: error, reason }, "CrossAgent Hub shutdown failed");
    process.exit(1);
  }
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
void server.shutdownRequested.then((request) => shutdown("AUTHENTICATED_REQUEST", request));
