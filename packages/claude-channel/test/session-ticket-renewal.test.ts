import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ClaudeSessionTicketRenewal,
  type ClaudeSessionTicketLease,
} from "../src/session-ticket-renewal.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const START = Date.parse("2026-08-01T00:00:00.000Z");

function lease(bundleId: string, activatedAt: number): ClaudeSessionTicketLease {
  return {
    bundleId,
    projectId: "prj_keepalive",
    agentId: "claude",
    sessionId: "ses_keepalive",
    lineageId: "lin_keepalive",
    incarnation: 1,
    runId: "run_keepalive",
    installationId: `cci_${"a".repeat(32)}`,
    activatedAt: new Date(activatedAt).toISOString(),
    expiresAt: new Date(activatedAt + DAY).toISOString(),
    serverNow: new Date(activatedAt).toISOString(),
    observedAt: new Date(activatedAt).toISOString(),
  };
}

afterEach(() => vi.useRealTimers());

describe("ClaudeSessionTicketRenewal", () => {
  it("rotates CONTROL for days without a model message and keeps one stable operation per retry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    const attempts: string[] = [];
    let generation = 0;
    const renewal = new ClaudeSessionTicketRenewal({
      initialLease: lease("stb_0", START),
      renew: async ({ operationId }) => {
        attempts.push(operationId);
        generation += 1;
        return lease(`stb_${generation}`, Date.now());
      },
    });

    renewal.start();
    await vi.advanceTimersByTimeAsync(4 * DAY);

    expect(attempts.length).toBeGreaterThanOrEqual(4);
    expect(new Set(attempts).size).toBe(attempts.length);
    expect(renewal.currentLease().sessionId).toBe("ses_keepalive");
    await renewal.stop();
  });

  it("fails closed on 401/403 and never burns a revoked ticket through retries", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    let attempts = 0;
    const critical: Error[] = [];
    const renewal = new ClaudeSessionTicketRenewal({
      initialLease: lease("stb_forbidden", START),
      renew: async () => {
        attempts += 1;
        throw Object.assign(new Error("revoked"), { status: 403 });
      },
      onCritical: (error) => critical.push(error),
    });

    renewal.start();
    await vi.advanceTimersByTimeAsync(4 * DAY);

    expect(attempts).toBe(1);
    expect(critical).toHaveLength(1);
    expect(renewal.state()).toBe("CRITICAL");
  });

  it("uses fresh Hub serverNow after a 23-hour replay even when the local wall clock is skewed", async () => {
    vi.useFakeTimers();
    const localObservation = START + 100 * HOUR;
    vi.setSystemTime(localObservation);
    const delayed = {
      ...lease("stb_delayed_replay", START),
      serverNow: new Date(START + 23 * HOUR).toISOString(),
      observedAt: new Date(localObservation).toISOString(),
    };
    const renew = vi.fn(async () => lease("stb_after_replay", Date.now()));
    const renewal = new ClaudeSessionTicketRenewal({
      initialLease: delayed,
      renew,
      renewalLeadMs: 30 * 60 * 1000,
      renewalJitterMs: 0,
      safetyMarginMs: 5 * 60 * 1000,
    });

    renewal.start();
    await vi.advanceTimersByTimeAsync(29 * 60 * 1000);
    expect(renew).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60 * 1000);
    expect(renew).toHaveBeenCalledOnce();
    await renewal.stop();
  });
});
