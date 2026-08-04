import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SurfaceDeliveryJournal, SurfaceInvocationLeaseManager } from "../src/surface-journal.js";

function fixtureDirectory(): string {
  return mkdtempSync(resolve(tmpdir(), "crossagent-surface-journal-"));
}

const identity = {
  projectId: "prj_example",
  sessionId: "ses_example",
  messageId: "msg_example",
};

describe("SurfaceDeliveryJournal", () => {
  it("persists only a stable surface binding and crash stage, never model content or secrets", async () => {
    const directory = fixtureDirectory();
    const journal = new SurfaceDeliveryJournal({ directory });
    const created = await journal.getOrCreate(identity, "hook-surface:stable");
    expect(created).toMatchObject({
      ...identity,
      beginIdempotencyKey: "hook-surface:stable",
      surfaceAttemptId: null,
      stage: "BEGIN_ONLY",
    });
    await journal.recordSurface(identity, {
      surfaceAttemptId: "srf_exact",
      recipientFence: 4,
      sessionIncarnation: 2,
    });
    await journal.markPrepared(identity);

    const serialized = readFileSync(
      resolve(
        directory,
        readdirSync(directory).find((name) => name.endsWith(".json"))!,
      ),
      "utf8",
    );
    expect(JSON.parse(serialized)).toMatchObject({
      ...identity,
      beginIdempotencyKey: "hook-surface:stable",
      surfaceAttemptId: "srf_exact",
      recipientFence: 4,
      sessionIncarnation: 2,
      stage: "PREPARED",
    });
    for (const forbidden of [
      "summary",
      "prompt",
      "verbatim",
      "signature",
      "private",
      "token",
      "authorityBundle",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("returns the original begin key after a restart and rejects a conflicting exact fence", async () => {
    const directory = fixtureDirectory();
    const first = new SurfaceDeliveryJournal({ directory });
    await first.getOrCreate(identity, "hook-surface:first");
    await first.recordSurface(identity, {
      surfaceAttemptId: "srf_exact",
      recipientFence: 8,
      sessionIncarnation: 3,
    });

    const restarted = new SurfaceDeliveryJournal({ directory });
    await expect(
      restarted.getOrCreate(identity, "hook-surface:new-random-key"),
    ).resolves.toMatchObject({
      beginIdempotencyKey: "hook-surface:first",
      surfaceAttemptId: "srf_exact",
      recipientFence: 8,
      sessionIncarnation: 3,
      stage: "BEGIN_ONLY",
    });
    await expect(
      restarted.recordSurface(identity, {
        surfaceAttemptId: "srf_other",
        recipientFence: 9,
        sessionIncarnation: 3,
      }),
    ).rejects.toThrow("surface_journal_binding_conflict");
  });

  it("coalesces concurrent creators to one stable begin key", async () => {
    const directory = fixtureDirectory();
    const journal = new SurfaceDeliveryJournal({ directory });
    const entries = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        journal.getOrCreate(identity, `hook-surface:candidate-${index}`),
      ),
    );
    expect(new Set(entries.map((entry) => entry.beginIdempotencyKey)).size).toBe(1);
    expect(readdirSync(directory).filter((name) => name.endsWith(".json"))).toHaveLength(1);
  });

  it("serializes journal capacity across different message identities", async () => {
    const directory = fixtureDirectory();
    const journal = new SurfaceDeliveryJournal({ directory, maxFiles: 1 });
    const attempts = await Promise.allSettled([
      journal.getOrCreate({ ...identity, messageId: "msg_capacity_a" }, "hook-surface:a"),
      journal.getOrCreate({ ...identity, messageId: "msg_capacity_b" }, "hook-surface:b"),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
    expect(readdirSync(directory).filter((name) => name.endsWith(".json"))).toHaveLength(1);
    expect(
      String(
        (attempts.find((attempt) => attempt.status === "rejected") as PromiseRejectedResult).reason,
      ),
    ).toContain("surface_journal_full");
  });

  it("blocks rather than overwriting a corrupt record with a fresh delivery attempt", async () => {
    const directory = fixtureDirectory();
    const journal = new SurfaceDeliveryJournal({ directory });
    await journal.getOrCreate(identity, "hook-surface:stable");
    const path = resolve(
      directory,
      readdirSync(directory).find((name) => name.endsWith(".json"))!,
    );
    writeFileSync(path, '{"version":1,"prompt":"forged"}\n', "utf8");

    await expect(journal.getOrCreate(identity, "hook-surface:replacement")).rejects.toThrow(
      "surface_journal_corrupt",
    );
    await expect(journal.getOrCreate(identity, "hook-surface:replacement")).rejects.toThrow(
      "surface_journal_corrupt",
    );
    expect(readdirSync(directory).some((name) => name.endsWith(".corrupt"))).toBe(true);
    expect(readdirSync(directory).some((name) => name.endsWith(".json"))).toBe(false);
  });

  it("enforces capacity and never prunes an unresolved entry by age", async () => {
    const directory = fixtureDirectory();
    let now = Date.parse("2026-08-01T00:00:00.000Z");
    const journal = new SurfaceDeliveryJournal({
      directory,
      maxFiles: 1,
      now: () => now,
    });
    await journal.getOrCreate(identity, "hook-surface:first");
    await expect(
      journal.getOrCreate({ ...identity, messageId: "msg_second" }, "hook-surface:second"),
    ).rejects.toThrow("surface_journal_full");

    now += 8 * 24 * 60 * 60 * 1_000;
    await expect(
      journal.getOrCreate({ ...identity, messageId: "msg_second" }, "hook-surface:second"),
    ).rejects.toThrow("surface_journal_full");
    await expect(journal.getOrCreate(identity, "hook-surface:replacement")).resolves.toMatchObject({
      beginIdempotencyKey: "hook-surface:first",
    });
    expect(readdirSync(directory).filter((name) => name.endsWith(".json"))).toHaveLength(1);
  });

  it("rejects PREPARED without an exact permit even when a file is syntactically valid JSON", async () => {
    const directory = fixtureDirectory();
    mkdirSync(directory, { recursive: true });
    const journal = new SurfaceDeliveryJournal({ directory });
    await journal.getOrCreate(identity, "hook-surface:stable");
    const path = resolve(
      directory,
      readdirSync(directory).find((name) => name.endsWith(".json"))!,
    );
    const candidate = JSON.parse(readFileSync(path, "utf8"));
    candidate.stage = "PREPARED";
    writeFileSync(path, `${JSON.stringify(candidate)}\n`, "utf8");

    await expect(journal.getOrCreate(identity, "hook-surface:replacement")).rejects.toThrow(
      "surface_journal_corrupt",
    );
  });
});

describe("SurfaceInvocationLeaseManager", () => {
  it("admits one owner, rejects a concurrent owner, and refuses release by the wrong owner", async () => {
    const directory = fixtureDirectory();
    const manager = new SurfaceInvocationLeaseManager({ directory });
    const owner = await manager.tryAcquire(identity);
    expect(owner).not.toBeNull();
    await expect(manager.tryAcquire(identity)).resolves.toBeNull();

    const wrongOwner = { ...owner!, ownerToken: "A".repeat(43) };
    await expect(manager.release(wrongOwner)).rejects.toThrow(
      "surface_invocation_lease_owner_mismatch",
    );
    await expect(manager.assertOwner(owner!)).resolves.toBeUndefined();
    await expect(manager.release(owner!)).resolves.toBeUndefined();
    await expect(manager.tryAcquire(identity)).resolves.not.toBeNull();
  });

  it("recovers an expired crash lease with a new owner token", async () => {
    const directory = fixtureDirectory();
    const manager = new SurfaceInvocationLeaseManager({ directory });
    const crashed = await manager.tryAcquire(identity);
    const path = resolve(
      directory,
      readdirSync(directory).find((name) => name.endsWith(".lease"))!,
    );
    const stale = {
      ...JSON.parse(readFileSync(path, "utf8")),
      acquiredAt: "2026-07-31T00:00:00.000Z",
      renewedAt: "2026-07-31T00:00:01.000Z",
      expiresAt: "2026-07-31T00:01:01.000Z",
    };
    writeFileSync(path, `${JSON.stringify(stale)}\n`, "utf8");

    const recovered = await manager.tryAcquire(identity);
    expect(recovered?.ownerToken).not.toBe(crashed?.ownerToken);
    await expect(manager.release(crashed!)).rejects.toThrow(
      "surface_invocation_lease_owner_mismatch",
    );
    await expect(manager.release(recovered!)).resolves.toBeUndefined();
  });

  it("quarantines a damaged live lease without silently freeing bounded capacity", async () => {
    const directory = fixtureDirectory();
    const manager = new SurfaceInvocationLeaseManager({ directory, maxLeases: 1 });
    await manager.tryAcquire(identity);
    const path = resolve(
      directory,
      readdirSync(directory).find((name) => name.endsWith(".lease"))!,
    );
    writeFileSync(path, '{"ownerToken":"forged","prompt":"do not trust"}\n', "utf8");

    await expect(manager.tryAcquire(identity)).rejects.toThrow("surface_invocation_lease_corrupt");
    await expect(manager.tryAcquire({ ...identity, messageId: "msg_other" })).rejects.toThrow(
      "surface_invocation_lease_full",
    );
    expect(readdirSync(directory).some((name) => name.endsWith(".corrupt"))).toBe(true);
  });

  it("serializes capacity across different message identities", async () => {
    const directory = fixtureDirectory();
    const manager = new SurfaceInvocationLeaseManager({ directory, maxLeases: 1 });
    const attempts = await Promise.allSettled([
      manager.tryAcquire({ ...identity, messageId: "msg_capacity_a" }),
      manager.tryAcquire({ ...identity, messageId: "msg_capacity_b" }),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
    expect(readdirSync(directory).filter((name) => name.endsWith(".lease"))).toHaveLength(1);
    expect(
      String(
        (attempts.find((attempt) => attempt.status === "rejected") as PromiseRejectedResult).reason,
      ),
    ).toContain("surface_invocation_lease_full");
  });

  it("does not steal or unlink a stale-looking lock while its owning process is alive", async () => {
    const directory = fixtureDirectory();
    const manager = new SurfaceInvocationLeaseManager({ directory });
    const capacityLock = resolve(directory, ".surface-invocation-capacity.lock");
    mkdirSync(directory, { recursive: true });
    const liveOwner = {
      version: 1,
      ownerToken: "A".repeat(43),
      pid: process.pid,
      acquiredAt: "2026-07-01T00:00:00.000Z",
    };
    writeFileSync(capacityLock, `${JSON.stringify(liveOwner)}\n`, "utf8");
    const staleMtime = new Date(Date.now() - 60_000);
    utimesSync(capacityLock, staleMtime, staleMtime);

    await expect(manager.tryAcquire(identity)).rejects.toThrow("surface_journal_lock_timeout");
    expect(JSON.parse(readFileSync(capacityLock, "utf8"))).toEqual(liveOwner);
  });

  it("lets two contenders reap one dead lock generation without deleting the successor", async () => {
    const directory = fixtureDirectory();
    const manager = new SurfaceInvocationLeaseManager({ directory, maxLeases: 1 });
    const exited = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    expect(exited.pid).toBeTypeOf("number");
    const capacityLock = resolve(directory, ".surface-invocation-capacity.lock");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      capacityLock,
      `${JSON.stringify({
        version: 1,
        ownerToken: "B".repeat(43),
        pid: exited.pid,
        acquiredAt: "2026-07-01T00:00:00.000Z",
      })}\n`,
      "utf8",
    );
    const staleMtime = new Date(Date.now() - 60_000);
    utimesSync(capacityLock, staleMtime, staleMtime);

    const attempts = await Promise.allSettled([
      manager.tryAcquire({ ...identity, messageId: "msg_reaper_a" }),
      manager.tryAcquire({ ...identity, messageId: "msg_reaper_b" }),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
    expect(readdirSync(directory).filter((name) => name.endsWith(".lease"))).toHaveLength(1);
    expect(readdirSync(directory).filter((name) => name.endsWith(".reap"))).toEqual([]);
  });

  it("reclaims expired leases across identities without deleting active capacity", async () => {
    const directory = fixtureDirectory();
    const manager = new SurfaceInvocationLeaseManager({ directory, maxLeases: 4 });
    const activeIdentities = Array.from({ length: 4 }, (_, index) => ({
      ...identity,
      messageId: `msg_expired_${index}`,
    }));
    for (const leaseIdentity of activeIdentities) {
      await manager.tryAcquire(leaseIdentity);
    }
    await expect(
      manager.tryAcquire({ ...identity, messageId: "msg_blocked_while_active" }),
    ).rejects.toThrow("surface_invocation_lease_full");

    for (const name of readdirSync(directory).filter((entry) => entry.endsWith(".lease"))) {
      const path = resolve(directory, name);
      const expired = {
        ...JSON.parse(readFileSync(path, "utf8")),
        acquiredAt: "2026-07-01T00:00:00.000Z",
        renewedAt: "2026-07-01T00:00:01.000Z",
        expiresAt: "2026-07-01T00:01:01.000Z",
      };
      writeFileSync(path, `${JSON.stringify(expired)}\n`, "utf8");
    }

    await expect(
      manager.tryAcquire({ ...identity, messageId: "msg_after_expiry" }),
    ).resolves.toMatchObject({ messageId: "msg_after_expiry" });
    expect(readdirSync(directory).filter((name) => name.endsWith(".lease"))).toHaveLength(1);
  });
});
