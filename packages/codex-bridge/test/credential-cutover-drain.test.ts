import { describe, expect, it, vi } from "vitest";

import {
  CredentialAdmissionClosedError,
  CredentialCutoverDrain,
} from "../src/credential-cutover-drain.js";

describe("CredentialCutoverDrain", () => {
  it("closes admission synchronously and resolves only after every old-epoch owner releases", async () => {
    const drain = new CredentialCutoverDrain();
    const first = await drain.admit("MESSAGE_SURFACE");
    const second = await drain.admit("HEARTBEAT");
    const barrier = drain.beginDrain("ticket rotation");
    const drained = vi.fn();
    void barrier.drained.then(drained);

    const deferred = drain.admit("DIRECT_USER_INPUT");
    await Promise.resolve();
    expect(drain.phase).toBe("DRAINING");
    expect(drain.activeAdmissionCount).toBe(2);
    expect(drain.hasActiveNonHeartbeatAdmission).toBe(true);
    expect(drained).not.toHaveBeenCalled();

    first.release();
    first.release();
    await Promise.resolve();
    expect(drain.activeAdmissionCount).toBe(1);
    expect(drain.hasActiveNonHeartbeatAdmission).toBe(false);
    expect(drained).not.toHaveBeenCalled();

    second.release();
    await barrier.drained;
    expect(drained).toHaveBeenCalledOnce();
    drain.reopen(barrier);
    const next = await deferred;
    expect(next.epoch).not.toBe(barrier.epoch);
    next.release();
  });

  it("joins only the exact drain owner and rejects competing or stale owners", async () => {
    const drain = new CredentialCutoverDrain();
    const first = drain.beginDrain("first");
    expect(drain.beginDrain("first")).toBe(first);
    expect(() => drain.beginDrain("competing owner")).toThrow(/cannot share/u);
    await first.drained;
    drain.reopen(first);

    const second = drain.beginDrain("second");
    expect(() => drain.reopen(first)).toThrow(/stale|another owner/u);
    await second.drained;
    drain.reopen(second);
  });

  it("terminal close rejects deferred and future work while still waiting for admitted work", async () => {
    const drain = new CredentialCutoverDrain();
    const admitted = await drain.admit("QUEUE_DRAIN");
    const barrier = drain.beginDrain("rotation");
    const deferred = drain.admit("MESSAGE_SURFACE");
    const terminal = drain.close("Bridge stopped");

    expect(terminal).toBe(barrier);
    await expect(deferred).rejects.toBeInstanceOf(CredentialAdmissionClosedError);
    await expect(drain.admit("HEARTBEAT")).rejects.toThrow("Bridge stopped");

    admitted.release();
    await barrier.drained;
    expect(drain.phase).toBe("CLOSED");
    expect(() => drain.reopen(barrier)).toThrow(/Only a draining/u);
  });
});
