import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionTicketRenewal, type SessionTicketLease } from "../src/session-ticket-renewal.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const START = Date.parse("2026-08-01T00:00:00.000Z");

function lease(bundleId: string, activatedAt: number): SessionTicketLease {
  return {
    bundleId,
    projectId: "prj_keepalive",
    agentId: "codex",
    sessionId: "ses_keepalive",
    threadId: "thr_keepalive",
    lineageId: "lin_keepalive",
    incarnation: 1,
    launcherRunId: "run_keepalive",
    activatedAt: new Date(activatedAt).toISOString(),
    expiresAt: new Date(activatedAt + DAY).toISOString(),
    serverNow: new Date(activatedAt).toISOString(),
    observedAt: new Date(activatedAt).toISOString(),
  };
}

describe("SessionTicketRenewal", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renews an idle session for days without any user-message trigger", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    const rotations: Array<{ current: string; operationId: string; at: number }> = [];
    let generation = 0;
    const renewal = new SessionTicketRenewal({
      initialLease: lease("stb_0", START),
      renew: async ({ current, operationId }) => {
        rotations.push({ current: current.bundleId, operationId, at: Date.now() });
        generation += 1;
        return lease(`stb_${generation}`, Date.now());
      },
    });

    renewal.start();
    await vi.advanceTimersByTimeAsync(4 * DAY);

    expect(rotations.length).toBeGreaterThanOrEqual(4);
    expect(new Set(rotations.map((entry) => entry.operationId)).size).toBe(rotations.length);
    expect(renewal.currentLease()).toMatchObject({
      bundleId: `stb_${rotations.length}`,
      sessionId: "ses_keepalive",
      threadId: "thr_keepalive",
    });
    await renewal.stop();
  });

  it("uses stable bounded renewal jitter for one bundle across restarts", () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    const first = new SessionTicketRenewal({
      initialLease: lease("stb_stable", START),
      renew: async () => lease("stb_next", Date.now()),
    });
    const second = new SessionTicketRenewal({
      initialLease: lease("stb_stable", START),
      renew: async () => lease("stb_next", Date.now()),
    });
    const other = new SessionTicketRenewal({
      initialLease: lease("stb_other", START),
      renew: async () => lease("stb_next", Date.now()),
    });

    expect(first.nextRenewalAt()).toBe(second.nextRenewalAt());
    expect(first.nextRenewalAt()).not.toBe(other.nextRenewalAt());
    expect(Date.parse(first.nextRenewalAt())).toBeGreaterThanOrEqual(START + 17.5 * HOUR);
    expect(Date.parse(first.nextRenewalAt())).toBeLessThanOrEqual(START + 18.5 * HOUR);
  });

  it("retries one ambiguous operation with backoff and never overlaps owners", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    const operations: string[] = [];
    let active = 0;
    let maxActive = 0;
    let attempts = 0;
    const renewal = new SessionTicketRenewal({
      initialLease: lease("stb_retry", START),
      renew: async ({ operationId }) => {
        operations.push(operationId);
        active += 1;
        maxActive = Math.max(maxActive, active);
        attempts += 1;
        active -= 1;
        if (attempts < 4) throw new TypeError("fetch failed");
        return lease("stb_recovered", Date.now());
      },
    });

    renewal.start();
    await vi.advanceTimersByTimeAsync(20 * HOUR);

    expect(attempts).toBe(4);
    expect(new Set(operations)).toEqual(new Set(["session-ticket-renewal:stb_retry"]));
    expect(maxActive).toBe(1);
    expect(renewal.currentLease().bundleId).toBe("stb_recovered");
    renewal.stop();
  });

  it("rejects a successor that changes the Hub session or Codex thread", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    const errors: Error[] = [];
    const renewal = new SessionTicketRenewal({
      initialLease: lease("stb_current", START),
      renew: async () => ({
        ...lease("stb_wrong", Date.now()),
        sessionId: "ses_other",
      }),
      onError: (error) => errors.push(error),
    });

    await renewal.renewNow();

    expect(renewal.currentLease().bundleId).toBe("stb_current");
    expect(errors[0]?.message).toMatch(/full session lineage binding/u);
  });

  it("cancels its timer but settles an ambiguous commit before stop returns", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    let resolveRenewal!: (value: SessionTicketLease) => void;
    const pending = new Promise<SessionTicketLease>((resolve) => {
      resolveRenewal = resolve;
    });
    const renewal = new SessionTicketRenewal({
      initialLease: lease("stb_stop", START),
      renew: () => pending,
    });

    const inFlight = renewal.renewNow();
    const stopped = renewal.stop();
    resolveRenewal(lease("stb_late", Date.now() + HOUR));
    await Promise.all([inFlight, stopped]);
    await vi.advanceTimersByTimeAsync(4 * DAY);

    expect(renewal.currentLease().bundleId).toBe("stb_late");
  });

  it("fails loud once for a permanent authorization error and does not retry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    let attempts = 0;
    const critical: Error[] = [];
    const renewal = new SessionTicketRenewal({
      initialLease: lease("stb_forbidden", START),
      renew: async () => {
        attempts += 1;
        throw Object.assign(new Error("current head changed"), { status: 409 });
      },
      onCritical: (error) => critical.push(error),
    });

    renewal.start();
    await vi.advanceTimersByTimeAsync(4 * DAY);

    expect(attempts).toBe(1);
    expect(critical).toHaveLength(1);
    expect(renewal.state()).toBe("CRITICAL");
  });

  it("rejects incomplete identity preservation and unsafe schedule options", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    const errors: Error[] = [];
    const renewal = new SessionTicketRenewal({
      initialLease: lease("stb_identity", START),
      renew: async () => ({ ...lease("stb_identity_next", Date.now()), incarnation: 2 }),
      onCritical: (error) => errors.push(error),
    });

    await renewal.renewNow();
    expect(renewal.state()).toBe("CRITICAL");
    expect(errors[0]?.message).toMatch(/full session lineage binding/u);
    expect(
      () =>
        new SessionTicketRenewal({
          initialLease: lease("stb_unsafe", START),
          renew: async () => lease("stb_unsafe_next", Date.now()),
          renewalLeadMs: HOUR,
          renewalJitterMs: HOUR,
        }),
    ).toThrow(/lead.*jitter.*safety/iu);
  });

  it("derives the timer from Hub time so a six-hour local clock skew does not delay renewal", () => {
    vi.useFakeTimers();
    vi.setSystemTime(START + 6 * HOUR);
    const skewed = {
      ...lease("stb_skew", START),
      observedAt: new Date(START + 6 * HOUR).toISOString(),
    };
    const renewal = new SessionTicketRenewal({
      initialLease: skewed,
      renew: async () => lease("stb_skew_next", Date.now()),
    });

    expect(Date.parse(renewal.nextRenewalAt()) - Date.now()).toBeGreaterThanOrEqual(17.5 * HOUR);
    expect(Date.parse(renewal.nextRenewalAt()) - Date.now()).toBeLessThanOrEqual(18.5 * HOUR);
  });
});
