import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { workspaceFile } from "../src/paths.js";
import { hubProcessEnvironment, processExists, rotateLogIfLarge } from "../src/process-manager.js";

describe("Hub log rotation", () => {
  let root = "";

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = "";
  });

  const logFile = (contents: string): string => {
    root = mkdtempSync(resolve(tmpdir(), "crossagent-hub-log-"));
    const path = resolve(root, "hub.log");
    writeFileSync(path, contents, "utf8");
    return path;
  };

  it("moves an oversized log aside so the next run starts a fresh file", () => {
    const path = logFile("x".repeat(64));

    expect(rotateLogIfLarge(path, 64)).toBe(true);
    expect(existsSync(path)).toBe(false);
    expect(readFileSync(`${path}.1`, "utf8")).toHaveLength(64);
  });

  it("leaves a log that is still under the threshold alone", () => {
    const path = logFile("x".repeat(63));

    expect(rotateLogIfLarge(path, 64)).toBe(false);
    expect(existsSync(`${path}.1`)).toBe(false);
    expect(readFileSync(path, "utf8")).toHaveLength(63);
  });

  it("keeps exactly one generation, so an old rotation cannot accumulate", () => {
    const path = logFile("old");
    rotateLogIfLarge(path, 1);
    writeFileSync(path, "new", "utf8");

    expect(rotateLogIfLarge(path, 1)).toBe(true);
    expect(readFileSync(`${path}.1`, "utf8")).toBe("new");
  });

  it("reports no rotation instead of throwing when there is no log yet", () => {
    root = mkdtempSync(resolve(tmpdir(), "crossagent-hub-log-"));

    // Deliberate: refusing to start a Hub because its log could not be rotated would be worse
    // than letting the log grow.
    expect(rotateLogIfLarge(resolve(root, "absent.log"), 1)).toBe(false);
  });
});

describe("process manager", () => {
  it("tracks a process from running through exit without platform-specific process APIs", async () => {
    expect(processExists(process.pid)).toBe(true);
    expect(processExists(-1)).toBe(false);

    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], {
      stdio: "ignore",
      windowsHide: true,
    });
    await once(child, "spawn");
    const childPid = child.pid;
    expect(childPid).toBeTypeOf("number");
    expect(processExists(childPid!)).toBe(true);

    child.kill();
    await once(child, "exit");
    expect(processExists(childPid!)).toBe(false);
  });

  it("treats permission-denied PID probes as live instead of reclaimable", () => {
    const error = Object.assign(new Error("access denied"), { code: "EPERM" });
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw error;
    });
    try {
      expect(processExists(1234)).toBe(true);
    } finally {
      kill.mockRestore();
    }
  });
});

describe("Hub process environment", () => {
  it("hands the child the strict full identity and removes the legacy buildId-only pin", () => {
    const identity = {
      buildSessionId: "11111111-1111-4111-8111-111111111111",
      buildId: "1".repeat(64),
      migrationId: "2".repeat(64),
      protocolId: "3".repeat(64),
      manifestSha256: "4".repeat(64),
    };
    const environment = hubProcessEnvironment(
      {},
      {
        CROSSAGENT_EXPECTED_BUILD_ID: "legacy-must-not-survive",
        CROSSAGENT_EXPECTED_BUILD_IDENTITY: "stale-must-not-survive",
      },
      identity,
    );

    expect(environment.CROSSAGENT_EXPECTED_BUILD_ID).toBeUndefined();
    expect(JSON.parse(environment.CROSSAGENT_EXPECTED_BUILD_IDENTITY!)).toEqual(identity);
  });

  it("pins migrations to the workspace when launched from another project", () => {
    const environment = hubProcessEnvironment({ port: 4399 }, { PATH: "test-path" });

    expect(environment).toMatchObject({
      PATH: "test-path",
      CROSSAGENT_PORT: "4399",
      CROSSAGENT_DASHBOARD_DIR: workspaceFile("apps", "dashboard", "dist"),
      CROSSAGENT_MIGRATIONS_DIR: workspaceFile("migrations"),
    });
  });

  it("rejects runtime asset overrides outside the verified workspace release", () => {
    expect(() =>
      hubProcessEnvironment(
        { dashboardDir: "R:\\unverified-dashboard" },
        { CROSSAGENT_MIGRATIONS_DIR: "R:\\packaged\\migrations" },
      ),
    ).toThrow(/runtime override.*verified workspace release/i);
  });
});
