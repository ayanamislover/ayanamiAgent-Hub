import { createHash } from "node:crypto";

const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_RENEWAL_LEAD_MS = 6 * HOUR_MS;
const DEFAULT_RENEWAL_JITTER_MS = 30 * 60 * 1000;
const DEFAULT_RETRY_INITIAL_MS = 30_000;
const DEFAULT_RETRY_MAX_MS = 15 * 60 * 1000;
const DEFAULT_SAFETY_MARGIN_MS = HOUR_MS;

export type SessionTicketLease = {
  bundleId: string;
  projectId: string;
  agentId: "codex";
  sessionId: string;
  threadId: string;
  lineageId: string;
  incarnation: number;
  launcherRunId: string;
  activatedAt: string;
  expiresAt: string;
  /** Hub wall clock carried by the activation receipt. */
  serverNow: string;
  /** Local wall clock captured when that receipt was persisted; clock skew cancels in the delta. */
  observedAt: string;
};

export type SessionTicketRenewalAttempt = {
  current: SessionTicketLease;
  /** Stable across every retry, including a process-level lost-response recovery. */
  operationId: string;
};

export type SessionTicketCriticalReason = "PERMANENT_FAILURE" | "SAFETY_DEADLINE_EXCEEDED";

type TimerHandle = ReturnType<typeof setTimeout>;

export type SessionTicketRenewalClock = {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
};

export type SessionTicketRenewalOptions = {
  initialLease: SessionTicketLease;
  /**
   * Owns the complete credential cutover. Resolving means CONTROL/heartbeat/WS and MODEL_MCP have
   * all moved to the returned lease; throwing means the same operationId is safe to retry.
   */
  renew(attempt: SessionTicketRenewalAttempt): Promise<SessionTicketLease>;
  onActivated?(next: SessionTicketLease, previous: SessionTicketLease): void;
  onError?(error: Error, attempt: SessionTicketRenewalAttempt): void;
  onCritical?(
    error: Error,
    attempt: SessionTicketRenewalAttempt,
    reason: SessionTicketCriticalReason,
  ): void;
  clock?: SessionTicketRenewalClock;
  renewalLeadMs?: number;
  renewalJitterMs?: number;
  retryInitialMs?: number;
  retryMaxMs?: number;
  safetyMarginMs?: number;
};

export type SessionTicketRenewalState = "IDLE" | "RUNNING" | "CRITICAL" | "STOPPED";

class SessionTicketRenewalInvariantError extends Error {}

const systemClock: SessionTicketRenewalClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle),
};

function positiveFinite(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved <= 0) {
    throw new RangeError(`${name} must be a finite positive number`);
  }
  return resolved;
}

function nonnegativeFinite(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved < 0) {
    throw new RangeError(`${name} must be a finite nonnegative number`);
  }
  return resolved;
}

function instant(value: string, name: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new TypeError(`${name} must be a valid instant`);
  return parsed;
}

function stableUnitInterval(seed: string): number {
  return createHash("sha256").update(seed, "utf8").digest().readUInt32BE(0) / 0xffff_ffff;
}

function renewalOperationId(bundleId: string): string {
  return `session-ticket-renewal:${bundleId}`;
}

/**
 * Owns the no-message scheduling, single-flight retry, stable jitter, and same-session invariants
 * for one Adapter ticket lease. Hub I/O and secret persistence remain behind the `renew` Adapter,
 * keeping those details out of the Bridge lifecycle while making the real clock seam testable.
 */
export class SessionTicketRenewal {
  private readonly clock: SessionTicketRenewalClock;
  private readonly renewalLeadMs: number;
  private readonly renewalJitterMs: number;
  private readonly retryInitialMs: number;
  private readonly retryMaxMs: number;
  private readonly safetyMarginMs: number;
  private lease: SessionTicketLease;
  private timer: TimerHandle | null = null;
  private inFlight: Promise<void> | null = null;
  private failureCount = 0;
  private started = false;
  private stopped = false;
  private critical = false;

  constructor(private readonly options: SessionTicketRenewalOptions) {
    this.clock = options.clock ?? systemClock;
    this.renewalLeadMs = positiveFinite(
      options.renewalLeadMs,
      DEFAULT_RENEWAL_LEAD_MS,
      "renewalLeadMs",
    );
    this.renewalJitterMs = nonnegativeFinite(
      options.renewalJitterMs,
      DEFAULT_RENEWAL_JITTER_MS,
      "renewalJitterMs",
    );
    this.retryInitialMs = positiveFinite(
      options.retryInitialMs,
      DEFAULT_RETRY_INITIAL_MS,
      "retryInitialMs",
    );
    this.retryMaxMs = Math.max(
      this.retryInitialMs,
      positiveFinite(options.retryMaxMs, DEFAULT_RETRY_MAX_MS, "retryMaxMs"),
    );
    this.safetyMarginMs = positiveFinite(
      options.safetyMarginMs,
      DEFAULT_SAFETY_MARGIN_MS,
      "safetyMarginMs",
    );
    if (this.renewalLeadMs <= this.renewalJitterMs + this.safetyMarginMs) {
      throw new RangeError("renewal lead must exceed jitter plus the safety margin");
    }
    this.assertLease(options.initialLease);
    this.lease = Object.freeze({ ...options.initialLease });
    if (this.localExpiryAt(this.lease) <= this.clock.now()) {
      throw new SessionTicketRenewalInvariantError(
        "Initial session ticket lease is already expired",
      );
    }
  }

  start(): void {
    if (this.stopped) throw new Error("A stopped session ticket renewal owner cannot restart");
    if (this.started) return;
    this.started = true;
    this.scheduleAt(Date.parse(this.nextRenewalAt()));
  }

  async stop(): Promise<void> {
    if (this.stopped) {
      await this.inFlight;
      return;
    }
    this.stopped = true;
    this.started = false;
    this.clearTimer();
    await this.inFlight;
  }

  currentLease(): SessionTicketLease {
    return { ...this.lease };
  }

  state(): SessionTicketRenewalState {
    if (this.stopped) return "STOPPED";
    if (this.critical) return "CRITICAL";
    return this.started ? "RUNNING" : "IDLE";
  }

  nextRenewalAt(): string {
    const jitter =
      (stableUnitInterval(`renewal:${this.lease.bundleId}`) * 2 - 1) * this.renewalJitterMs;
    return new Date(this.localExpiryAt(this.lease) - this.renewalLeadMs + jitter).toISOString();
  }

  renewNow(): Promise<void> {
    if (this.stopped || this.critical) return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    this.clearTimer();
    const current = this.lease;
    const attempt: SessionTicketRenewalAttempt = {
      current: { ...current },
      operationId: renewalOperationId(current.bundleId),
    };
    const operation = this.performRenewal(attempt);
    const owned = operation.finally(() => {
      if (this.inFlight === owned) this.inFlight = null;
    });
    this.inFlight = owned;
    return owned;
  }

  private async performRenewal(attempt: SessionTicketRenewalAttempt): Promise<void> {
    try {
      const next = await this.options.renew(attempt);
      this.assertSuccessor(attempt.current, next);
      if (this.lease.bundleId !== attempt.current.bundleId) return;
      this.lease = Object.freeze({ ...next });
      this.failureCount = 0;
      try {
        this.options.onActivated?.({ ...next }, { ...attempt.current });
      } catch {
        // Observability cannot roll back a Hub-committed credential cutover.
      }
      if (this.started && !this.stopped) this.scheduleAt(Date.parse(this.nextRenewalAt()));
    } catch (error: unknown) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      try {
        this.options.onError?.(normalized, attempt);
      } catch {
        // Error reporting cannot become a second renewal failure owner.
      }
      const retryable = this.isRetryable(normalized);
      const safetyDeadlineExceeded = this.clock.now() >= this.safetyDeadline(attempt.current);
      if (!retryable || safetyDeadlineExceeded) {
        this.enterCritical(
          normalized,
          attempt,
          !retryable ? "PERMANENT_FAILURE" : "SAFETY_DEADLINE_EXCEEDED",
        );
      } else if (
        this.started &&
        !this.stopped &&
        this.lease.bundleId === attempt.current.bundleId
      ) {
        this.scheduleRetry(attempt);
      }
    }
  }

  private scheduleRetry(attempt: SessionTicketRenewalAttempt): void {
    const exponent = Math.min(this.failureCount, 20);
    const nominal = Math.min(this.retryMaxMs, this.retryInitialMs * 2 ** exponent);
    const jitter =
      0.8 + stableUnitInterval(`retry:${attempt.current.bundleId}:${this.failureCount}`) * 0.4;
    this.failureCount += 1;
    const retryAt = this.clock.now() + Math.max(1, Math.round(nominal * jitter));
    this.scheduleAt(Math.min(retryAt, this.safetyDeadline(attempt.current)));
  }

  private scheduleAt(at: number): void {
    if (!this.started || this.stopped) return;
    this.clearTimer();
    const delay = Math.max(1, at - this.clock.now());
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      void this.renewNow();
    }, delay);
    (this.timer as TimerHandle & { unref?: () => void }).unref?.();
  }

  private clearTimer(): void {
    if (!this.timer) return;
    this.clock.clearTimeout(this.timer);
    this.timer = null;
  }

  private assertLease(candidate: SessionTicketLease): void {
    if (
      !candidate.bundleId ||
      !candidate.projectId ||
      candidate.agentId !== "codex" ||
      !candidate.sessionId ||
      !candidate.threadId ||
      !candidate.lineageId ||
      !Number.isInteger(candidate.incarnation) ||
      candidate.incarnation < 1 ||
      !candidate.launcherRunId
    ) {
      throw new SessionTicketRenewalInvariantError(
        "Session ticket lease requires its full session lineage binding",
      );
    }
    const activatedAt = instant(candidate.activatedAt, "activatedAt");
    const expiresAt = instant(candidate.expiresAt, "expiresAt");
    instant(candidate.serverNow, "serverNow");
    instant(candidate.observedAt, "observedAt");
    if (expiresAt <= activatedAt) {
      throw new SessionTicketRenewalInvariantError(
        "Session ticket lease must expire after activation",
      );
    }
  }

  private assertSuccessor(current: SessionTicketLease, next: SessionTicketLease): void {
    this.assertLease(next);
    if (next.bundleId === current.bundleId) {
      throw new SessionTicketRenewalInvariantError(
        "Session ticket renewal must activate a distinct successor bundle",
      );
    }
    if (
      next.projectId !== current.projectId ||
      next.agentId !== current.agentId ||
      next.sessionId !== current.sessionId ||
      next.threadId !== current.threadId ||
      next.lineageId !== current.lineageId ||
      next.incarnation !== current.incarnation ||
      next.launcherRunId !== current.launcherRunId
    ) {
      throw new SessionTicketRenewalInvariantError(
        "Session ticket renewal must preserve the full session lineage binding",
      );
    }
    if (Date.parse(next.expiresAt) <= Date.parse(current.expiresAt)) {
      throw new SessionTicketRenewalInvariantError(
        "Session ticket renewal must extend the active expiry",
      );
    }
  }

  private localExpiryAt(candidate: SessionTicketLease): number {
    return (
      instant(candidate.observedAt, "observedAt") +
      (instant(candidate.expiresAt, "expiresAt") - instant(candidate.serverNow, "serverNow"))
    );
  }

  private safetyDeadline(candidate: SessionTicketLease): number {
    return this.localExpiryAt(candidate) - this.safetyMarginMs;
  }

  private isRetryable(error: Error): boolean {
    if (error instanceof SessionTicketRenewalInvariantError) return false;
    const status = Number((error as Error & { status?: unknown }).status);
    if (Number.isFinite(status)) return status === 408 || status === 429 || status >= 500;
    return error instanceof TypeError;
  }

  private enterCritical(
    error: Error,
    attempt: SessionTicketRenewalAttempt,
    reason: SessionTicketCriticalReason,
  ): void {
    if (this.critical || this.stopped) return;
    this.critical = true;
    this.clearTimer();
    try {
      this.options.onCritical?.(error, attempt, reason);
    } catch {
      // The Bridge owns escalation; a diagnostic callback cannot restore an invalid lease.
    }
  }
}
