import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  servingHubPid,
  withRecoverableRuntimeBuildLock,
  withRuntimeBuildLock,
  type RuntimeBuildIdentity,
} from "../src/build-identity.js";

/**
 * The deadlock this guards against, which shipped once: adding a migration without rebuilding
 * leaves the release manifest stale, so verifying the workspace fails. Every runtime command was
 * gated on that verification, including stop -- and the build refuses to run in-place while a Hub
 * is serving. The Hub could not be stopped, so the build could not be fixed, so the Hub could not
 * be stopped. Recovery has to survive the thing it recovers from.
 */
describe("runtime build lock on an unverifiable workspace", () => {
  let root = "";

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = "";
  });

  const unverifiableWorkspace = (): string => {
    // A workspace the lifecycle lock accepts as this project's root, but with no
    // .crossagent-build/release-manifest.json -- so the lock is takeable and verification is not.
    // That is exactly the shape a checkout has after a migration lands without a rebuild.
    root = mkdtempSync(resolve(tmpdir(), "crossagent-unverifiable-"));
    writeFileSync(resolve(root, "package.json"), JSON.stringify({ name: "ayanami-agent-hub" }));
    writeFileSync(resolve(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
    return root;
  };

  it("refuses the strict lock, because starting an unverified release is what it prevents", async () => {
    const workspace = unverifiableWorkspace();
    let ran = false;

    await expect(
      withRuntimeBuildLock(
        () => {
          ran = true;
        },
        { root: workspace },
      ),
    ).rejects.toThrow();
    expect(ran).toBe(false);
  });

  it("runs the recoverable lock with a null identity and the reason it failed", async () => {
    const workspace = unverifiableWorkspace();
    let seen: { identity: RuntimeBuildIdentity | null; failure: Error | null } | null = null;

    const result = await withRecoverableRuntimeBuildLock(
      (identity, failure) => {
        seen = { identity, failure };
        return "stopped";
      },
      { root: workspace },
    );

    expect(result).toBe("stopped");
    expect(seen!.identity).toBeNull();
    expect(seen!.failure).toBeInstanceOf(Error);
    expect(seen!.failure!.message).toBeTruthy();
  });

  it("still lets the operation's own failure through instead of retrying it unverified", async () => {
    const workspace = unverifiableWorkspace();
    let calls = 0;

    await expect(
      withRecoverableRuntimeBuildLock(
        () => {
          calls += 1;
          throw new Error("cooperative shutdown was rejected");
        },
        { root: workspace },
      ),
    ).rejects.toThrow("cooperative shutdown was rejected");
    expect(calls).toBe(1);
  });

  // A second Hub fails on this lease even with its own port and data directory, and it dies before
  // logging exists -- so the start failure used to point at a log file that was never created.
  // Naming the holder is the difference between a dead end and an instruction.
  describe("naming the Hub that already holds the workspace", () => {
    const writeLease = (workspace: string, pid: number) => {
      mkdirSync(resolve(workspace, ".crossagent-build"), { recursive: true });
      writeFileSync(
        resolve(workspace, ".crossagent-build/hub-runtime.lock"),
        JSON.stringify({
          kind: "HUB_RUNTIME",
          pid,
          nonce: randomUUID(),
          createdAt: new Date().toISOString(),
        }),
      );
    };

    it("reports the live pid holding the lease", () => {
      const workspace = unverifiableWorkspace();
      writeLease(workspace, process.pid);

      expect(servingHubPid({ root: workspace })).toBe(process.pid);
    });

    it("reports nothing for a lease whose process is gone, so a crash does not read as busy", () => {
      const workspace = unverifiableWorkspace();
      // Max pid + 1 on every platform this runs on: never a live process.
      writeLease(workspace, 0x7fffffff);

      expect(servingHubPid({ root: workspace })).toBeNull();
    });

    it("reports nothing when there is no lease at all", () => {
      expect(servingHubPid({ root: unverifiableWorkspace() })).toBeNull();
    });
  });
});
