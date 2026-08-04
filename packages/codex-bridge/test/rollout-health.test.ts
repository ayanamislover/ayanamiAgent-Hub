import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RolloutHealthMonitor, RolloutSizeReader, findRolloutPath } from "../src/rollout-health.js";

const MiB = 1024 * 1024;

describe("RolloutHealthMonitor", () => {
  it("reports nothing wrong until something is", () => {
    const monitor = new RolloutHealthMonitor();
    expect(monitor.snapshot()).toMatchObject({ state: "OK", reason: null, rolloutBytes: null });

    monitor.observeRead({ durationMs: 120, timedOut: false });
    monitor.observeSize(12 * MiB);

    expect(monitor.snapshot()).toMatchObject({
      state: "OK",
      reason: null,
      rolloutBytes: 12 * MiB,
      lastReadMs: 120,
      consecutiveDegradedScore: 0,
    });
  });

  it("warns on a rollout that is merely large, and retires it before reads break", () => {
    const monitor = new RolloutHealthMonitor();

    monitor.observeSize(300 * MiB);
    expect(monitor.snapshot()).toMatchObject({ state: "WARNING" });
    expect(monitor.snapshot().reason).toMatch(/300 MB/u);

    monitor.observeSize(600 * MiB);
    expect(monitor.snapshot()).toMatchObject({ state: "RETIRE" });
  });

  it("ends the run of bad reads on one prompt answer, because a busy app-server is not a big rollout", () => {
    const monitor = new RolloutHealthMonitor();

    monitor.observeRead({ durationMs: 11_000, timedOut: false });
    monitor.observeRead({ durationMs: 12_000, timedOut: false });
    expect(monitor.snapshot()).toMatchObject({ state: "WARNING", consecutiveDegradedScore: 2 });

    monitor.observeRead({ durationMs: 90, timedOut: false });
    expect(monitor.snapshot()).toMatchObject({ state: "OK", consecutiveDegradedScore: 0 });

    monitor.observeRead({ durationMs: 11_000, timedOut: false });
    monitor.observeRead({ durationMs: 11_000, timedOut: false });
    monitor.observeRead({ durationMs: 11_000, timedOut: false });
    expect(monitor.snapshot()).toMatchObject({ state: "RETIRE", consecutiveDegradedScore: 3 });
  });

  it("counts a timed-out read as worse than a slow one", () => {
    const monitor = new RolloutHealthMonitor();

    monitor.observeRead({ durationMs: 60_000, timedOut: true });
    expect(monitor.snapshot()).toMatchObject({
      state: "WARNING",
      readTimeouts: 1,
      consecutiveDegradedScore: 2,
    });

    monitor.observeRead({ durationMs: 11_000, timedOut: false });
    expect(monitor.snapshot()).toMatchObject({ state: "RETIRE" });
    expect(monitor.snapshot().reason).toMatch(/timeout/u);
  });

  it("does not withdraw a retirement, because the rollout that caused it cannot shrink", () => {
    const monitor = new RolloutHealthMonitor();

    monitor.observeRead({ durationMs: 60_000, timedOut: true });
    monitor.observeRead({ durationMs: 60_000, timedOut: true });
    expect(monitor.snapshot().state).toBe("RETIRE");
    const reason = monitor.snapshot().reason;

    monitor.observeRead({ durationMs: 40, timedOut: false });
    monitor.observeSize(1 * MiB);

    expect(monitor.snapshot()).toMatchObject({ state: "RETIRE", reason });
  });

  it("honours overridden thresholds and timestamps every observation", () => {
    const monitor = new RolloutHealthMonitor({
      thresholds: { sizeWarnBytes: 10, sizeRetireBytes: 20 },
      now: () => new Date("2026-08-04T09:00:00.000Z"),
    });

    monitor.observeSize(11);
    expect(monitor.snapshot()).toMatchObject({
      state: "WARNING",
      observedAt: "2026-08-04T09:00:00.000Z",
    });

    monitor.observeSize(21);
    expect(monitor.snapshot().state).toBe("RETIRE");
  });
});

describe("RolloutSizeReader", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function codexHomeWithRollout(threadId: string, bytes: number): string {
    const root = mkdtempSync(join(tmpdir(), "crossagent-rollout-"));
    roots.push(root);
    const day = join(root, "sessions", "2026", "08", "04");
    mkdirSync(day, { recursive: true });
    writeFileSync(join(day, `rollout-2026-08-04T09-00-00-${threadId}.jsonl`), "x".repeat(bytes));
    return root;
  }

  it("finds the rollout Codex nested under its date directories and reports its size", () => {
    const home = codexHomeWithRollout("01900000-0000-7000-8000-000000000001", 4096);

    expect(findRolloutPath("01900000-0000-7000-8000-000000000001", home)).not.toBeNull();
    expect(new RolloutSizeReader(home).sizeBytes("01900000-0000-7000-8000-000000000001")).toBe(
      4096,
    );
  });

  it("reports an unknown size rather than failing when there is no rollout to read", () => {
    const home = codexHomeWithRollout("01900000-0000-7000-8000-000000000002", 16);

    expect(
      new RolloutSizeReader(home).sizeBytes("01900000-0000-7000-8000-000000000003"),
    ).toBeNull();
    expect(new RolloutSizeReader(join(home, "absent")).sizeBytes("any")).toBeNull();
  });
});
