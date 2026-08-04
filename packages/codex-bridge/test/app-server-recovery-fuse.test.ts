import { describe, expect, it, vi } from "vitest";
import {
  AppServerRecoveryFuse,
  AppServerRecoveryFuseError,
  ModelTransportFuseOpenError,
  type AppServerRecoveryIdentity,
  type AppServerRecoveryProbeCommand,
} from "../src/app-server-recovery-fuse.js";

const identity = (
  overrides: Partial<AppServerRecoveryIdentity> = {},
): AppServerRecoveryIdentity => ({
  projectId: "prj_test",
  hubSessionId: "ses_test",
  threadId: "thr_original",
  lineageId: "lin_test",
  incarnation: 1,
  launcherRunId: "run_test",
  bundleId: "stb_test",
  ...overrides,
});

const command = (
  fuse: AppServerRecoveryFuse,
  overrides: Partial<AppServerRecoveryProbeCommand> = {},
): AppServerRecoveryProbeCommand => {
  const status = fuse.status;
  if (status.state !== "FUSE_OPEN") throw new Error("test requires an open fuse");
  if (!status.identity) throw new Error("test requires a bound recovery identity");
  return {
    schemaVersion: 1,
    kind: "CODEX_APP_SERVER_RECOVERY_PROBE",
    commandId: "probe_1",
    commandGeneration: 1,
    fuseGeneration: status.fuseGeneration,
    identity: status.identity,
    ...overrides,
  };
};

function openFuse(fuse = new AppServerRecoveryFuse({ maxAutomaticAttempts: 3 })) {
  expect(fuse.beginAutomaticRecovery(7, identity())).toEqual({ accepted: true, duplicate: false });
  expect(fuse.recordAutomaticFailure()).toBeNull();
  expect(fuse.recordAutomaticFailure()).toBeNull();
  const request = fuse.recordAutomaticFailure();
  expect(request).not.toBeNull();
  return { fuse, request: request! };
}

describe("AppServerRecoveryFuse", () => {
  it("opens after the bounded automatic failures without leaking error or credential material", () => {
    const { fuse, request } = openFuse();

    expect(fuse.status).toMatchObject({
      state: "FUSE_OPEN",
      failedAttempts: 3,
      crashedGeneration: 7,
      modelTransportState: "MODEL_CONFIGURED_OFFLINE",
    });
    expect(request).toEqual({
      schemaVersion: 1,
      kind: "CODEX_APP_SERVER_RECOVERY_REQUIRED",
      fuseGeneration: 1,
      failedAttempts: 3,
      crashedGeneration: 7,
      issuedAt: expect.any(String),
      identity: identity(),
    });
    expect(JSON.stringify(request)).not.toMatch(/token|secret|credential|stderr|error/i);
  });

  it("deduplicates an exact crash generation without consuming another attempt", () => {
    const fuse = new AppServerRecoveryFuse({ maxAutomaticAttempts: 3 });
    expect(fuse.beginAutomaticRecovery(9, identity())).toEqual({
      accepted: true,
      duplicate: false,
    });
    expect(fuse.beginAutomaticRecovery(9, identity())).toEqual({
      accepted: false,
      duplicate: true,
    });
    expect(fuse.status).toMatchObject({ failedAttempts: 0, crashedGeneration: 9 });
  });

  it("runs one exact external half-open probe and replays its stable result", async () => {
    const { fuse } = openFuse();
    const probe = vi.fn(async () => undefined);
    const requested = command(fuse);

    const [left, right] = await Promise.all([
      fuse.probe(requested, probe),
      fuse.probe(structuredClone(requested), probe),
    ]);
    const replay = await fuse.probe(structuredClone(requested), probe);

    expect(probe).toHaveBeenCalledTimes(1);
    expect(left).toEqual(right);
    expect(replay).toEqual(left);
    expect(left).toMatchObject({
      kind: "RECOVERED",
      commandId: "probe_1",
      commandGeneration: 1,
      fuseGeneration: 1,
      identity: identity(),
    });
    expect(fuse.status).toMatchObject({
      state: "CLOSED",
      modelTransportState: "MODEL_READY",
    });
  });

  it("keeps the fuse open after a failed probe and requires a newer command generation", async () => {
    const { fuse } = openFuse();
    const first = command(fuse);
    const failed = await fuse.probe(first, async () => {
      throw new Error("private process failure");
    });

    expect(failed).toMatchObject({ kind: "FUSE_OPEN", commandGeneration: 1 });
    expect(JSON.stringify(failed)).not.toContain("private process failure");
    expect(fuse.status.state).toBe("FUSE_OPEN");
    await expect(
      fuse.probe({ ...first, commandId: "probe_same_generation" }, async () => undefined),
    ).rejects.toMatchObject({ code: "APP_SERVER_RECOVERY_PROBE_STALE" });

    const recovered = await fuse.probe(
      { ...first, commandId: "probe_2", commandGeneration: 2 },
      async () => undefined,
    );
    expect(recovered.kind).toBe("RECOVERED");
  });

  it("rejects stale identity and fuse generations before the Adapter runs", async () => {
    const { fuse } = openFuse();
    const adapter = vi.fn(async () => undefined);
    const current = command(fuse);

    await expect(
      fuse.probe({ ...current, identity: identity({ hubSessionId: "ses_sibling" }) }, adapter),
    ).rejects.toMatchObject({ code: "APP_SERVER_RECOVERY_PROBE_STALE" });
    await expect(
      fuse.probe({ ...current, fuseGeneration: current.fuseGeneration - 1 }, adapter),
    ).rejects.toMatchObject({ code: "APP_SERVER_RECOVERY_PROBE_STALE" });
    expect(adapter).not.toHaveBeenCalled();
  });

  it("rebinds an offline successor and invalidates the predecessor command", async () => {
    const { fuse } = openFuse();
    const predecessor = command(fuse);
    const successor = identity({
      hubSessionId: "ses_successor",
      incarnation: 2,
      bundleId: "stb_successor",
    });

    const request = fuse.rebindOfflineIdentity(successor);

    expect(request).toMatchObject({ fuseGeneration: 1, identity: successor });
    await expect(fuse.probe(predecessor, async () => undefined)).rejects.toMatchObject({
      code: "APP_SERVER_RECOVERY_PROBE_STALE",
    });
  });

  it("restores the exact durable fuse generation instead of resetting supervisor proof", () => {
    const fuse = new AppServerRecoveryFuse();

    const request = fuse.restoreConfiguredOffline(identity(), 7);

    expect(request.fuseGeneration).toBe(7);
    expect(fuse.status).toMatchObject({ state: "FUSE_OPEN", fuseGeneration: 7 });
  });

  it("increments from the last durable ready generation after a cold restart", () => {
    const fuse = new AppServerRecoveryFuse({ maxAutomaticAttempts: 3 });
    fuse.restoreReadyIdentity(identity(), 7);

    expect(fuse.beginAutomaticRecovery(11, identity())).toEqual({
      accepted: true,
      duplicate: false,
    });
    expect(fuse.recordAutomaticFailure()).toBeNull();
    expect(fuse.recordAutomaticFailure()).toBeNull();
    expect(fuse.recordAutomaticFailure()).toMatchObject({ fuseGeneration: 8 });
    expect(fuse.status).toMatchObject({ state: "FUSE_OPEN", fuseGeneration: 8 });
  });

  it("rejects a different command while an exact half-open probe owns the Seam", async () => {
    const { fuse } = openFuse();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = command(fuse);
    const inFlight = fuse.probe(first, () => gate);

    await vi.waitFor(() => expect(fuse.status.state).toBe("HALF_OPEN"));
    await expect(
      fuse.probe({ ...first, commandId: "probe_2", commandGeneration: 2 }, async () => undefined),
    ).rejects.toMatchObject({ code: "APP_SERVER_RECOVERY_PROBE_IN_PROGRESS" });
    release();
    await expect(inFlight).resolves.toMatchObject({ kind: "RECOVERED" });
  });

  it("exposes stable typed errors for blocked model admission and invalid state", () => {
    expect(new ModelTransportFuseOpenError()).toMatchObject({
      name: "ModelTransportFuseOpenError",
      code: "MODEL_TRANSPORT_FUSE_OPEN",
    });
    const invalid = new AppServerRecoveryFuseError(
      "APP_SERVER_RECOVERY_FUSE_STATE_INVALID",
      "invalid state",
    );
    expect(invalid).toMatchObject({ code: "APP_SERVER_RECOVERY_FUSE_STATE_INVALID" });
  });
});
