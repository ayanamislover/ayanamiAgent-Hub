import { createHash } from "node:crypto";

const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_RENEWAL_LEAD_MS = 6 * HOUR_MS;
const DEFAULT_RENEWAL_JITTER_MS = 30 * 60 * 1000;
const DEFAULT_RETRY_INITIAL_MS = 30_000;
const DEFAULT_RETRY_MAX_MS = 15 * 60 * 1000;
const DEFAULT_SAFETY_MARGIN_MS = HOUR_MS;

export type ClaudeSessionTicketLease = {
  bundleId: string;
  projectId: string;
  agentId: "claude";
  sessionId: string;
  lineageId: string;
  incarnation: number;
  runId: string;
  installationId: string;
  activatedAt: string;
  expiresAt: string;
  serverNow: string;
  observedAt: string;
};

export type ClaudeSessionTicketRenewalAttempt = {
  current: ClaudeSessionTicketLease;
  operationId: string;
};

type TimerHandle = ReturnType<typeof setTimeout>;

export type ClaudeSessionTicketRenewalClock = {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
};

export type ClaudeSessionTicketRenewalOptions = {
  initialLease: ClaudeSessionTicketLease;
  renew(attempt: ClaudeSessionTicketRenewalAttempt): Promise<ClaudeSessionTicketLease>;
  onActivated?(next: ClaudeSessionTicketLease, previous: ClaudeSessionTicketLease): void;
  onError?(error: Error, attempt: ClaudeSessionTicketRenewalAttempt): void;
  onCritical?(error: Error, attempt: ClaudeSessionTicketRenewalAttempt): void;
  clock?: ClaudeSessionTicketRenewalClock;
  renewalLeadMs?: number;
  renewalJitterMs?: number;
  retryInitialMs?: number;
  retryMaxMs?: number;
  safetyMarginMs?: number;
};

export type ClaudeSessionTicketRenewalState = "IDLE" | "RUNNING" | "CRITICAL" | "STOPPED";

class RenewalInvariantError extends Error {}

const systemClock: ClaudeSessionTicketRenewalClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle),
};

function finite(value: number | undefined, fallback: number, name: string, allowZero = false) {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || (allowZero ? resolved < 0 : resolved <= 0)) {
    throw new RangeError(`${name} must be finite and ${allowZero ? "nonnegative" : "positive"}`);
  }
  return resolved;
}

function instant(value: string, name: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new TypeError(`${name} must be a valid instant`);
  return parsed;
}

function stableUnit(seed: string): number {
  return createHash("sha256").update(seed, "utf8").digest().readUInt32BE(0) / 0xffff_ffff;
}

/** Owns no-message scheduling and exactly one retry owner for a CONTROL rotation. */
export class ClaudeSessionTicketRenewal {
  private readonly clock: ClaudeSessionTicketRenewalClock;
  private readonly renewalLeadMs: number;
  private readonly renewalJitterMs: number;
  private readonly retryInitialMs: number;
  private readonly retryMaxMs: number;
  private readonly safetyMarginMs: number;
  private lease: ClaudeSessionTicketLease;
  private timer: TimerHandle | null = null;
  private inFlight: Promise<void> | null = null;
  private failureCount = 0;
  private started = false;
  private stopped = false;
  private critical = false;

  constructor(private readonly options: ClaudeSessionTicketRenewalOptions) {
    this.clock = options.clock ?? systemClock;
    this.renewalLeadMs = finite(options.renewalLeadMs, DEFAULT_RENEWAL_LEAD_MS, "renewalLeadMs");
    this.renewalJitterMs = finite(
      options.renewalJitterMs,
      DEFAULT_RENEWAL_JITTER_MS,
      "renewalJitterMs",
      true,
    );
    this.retryInitialMs = finite(
      options.retryInitialMs,
      DEFAULT_RETRY_INITIAL_MS,
      "retryInitialMs",
    );
    this.retryMaxMs = Math.max(
      this.retryInitialMs,
      finite(options.retryMaxMs, DEFAULT_RETRY_MAX_MS, "retryMaxMs"),
    );
    this.safetyMarginMs = finite(
      options.safetyMarginMs,
      DEFAULT_SAFETY_MARGIN_MS,
      "safetyMarginMs",
    );
    if (this.renewalLeadMs <= this.renewalJitterMs + this.safetyMarginMs) {
      throw new RangeError("renewal lead must exceed jitter plus safety margin");
    }
    this.assertLease(options.initialLease);
    this.lease = Object.freeze({ ...options.initialLease });
    if (this.localExpiry(this.lease) <= this.clock.now()) {
      throw new RenewalInvariantError("Initial Claude CONTROL ticket is already expired");
    }
  }

  start(): void {
    if (this.stopped) throw new Error("A stopped ticket renewal owner cannot restart");
    if (this.started) return;
    this.started = true;
    this.scheduleAt(Date.parse(this.nextRenewalAt()));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.started = false;
    this.clearTimer();
    await this.inFlight;
  }

  state(): ClaudeSessionTicketRenewalState {
    if (this.stopped) return "STOPPED";
    if (this.critical) return "CRITICAL";
    return this.started ? "RUNNING" : "IDLE";
  }

  currentLease(): ClaudeSessionTicketLease {
    return { ...this.lease };
  }

  nextRenewalAt(): string {
    const jitter =
      (stableUnit(`claude-renewal:${this.lease.bundleId}`) * 2 - 1) * this.renewalJitterMs;
    return new Date(this.localExpiry(this.lease) - this.renewalLeadMs + jitter).toISOString();
  }

  renewNow(): Promise<void> {
    if (this.stopped || this.critical) return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    this.clearTimer();
    const current = { ...this.lease };
    const attempt = {
      current,
      operationId: `claude-session-ticket-renewal:${current.bundleId}`,
    };
    const operation = this.perform(attempt);
    const owned = operation.finally(() => {
      if (this.inFlight === owned) this.inFlight = null;
    });
    this.inFlight = owned;
    return owned;
  }

  private async perform(attempt: ClaudeSessionTicketRenewalAttempt): Promise<void> {
    try {
      const next = await this.options.renew(attempt);
      this.assertSuccessor(attempt.current, next);
      if (this.lease.bundleId !== attempt.current.bundleId) return;
      this.lease = Object.freeze({ ...next });
      this.failureCount = 0;
      try {
        this.options.onActivated?.({ ...next }, { ...attempt.current });
      } catch {
        // Observability cannot roll back a Hub-committed rotation.
      }
      if (this.started && !this.stopped) this.scheduleAt(Date.parse(this.nextRenewalAt()));
    } catch (error: unknown) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      try {
        this.options.onError?.(normalized, attempt);
      } catch {
        // Reporting is never another renewal owner.
      }
      if (!this.retryable(normalized) || this.clock.now() >= this.safetyDeadline(attempt.current)) {
        this.critical = true;
        this.clearTimer();
        try {
          this.options.onCritical?.(normalized, attempt);
        } catch {
          // A callback cannot make a terminal credential live again.
        }
        return;
      }
      if (this.started && !this.stopped && this.lease.bundleId === attempt.current.bundleId) {
        const exponent = Math.min(this.failureCount, 20);
        const nominal = Math.min(this.retryMaxMs, this.retryInitialMs * 2 ** exponent);
        const jitter =
          0.8 + stableUnit(`claude-retry:${attempt.operationId}:${this.failureCount}`) * 0.4;
        this.failureCount += 1;
        this.scheduleAt(
          Math.min(
            this.clock.now() + Math.max(1, Math.round(nominal * jitter)),
            this.safetyDeadline(attempt.current),
          ),
        );
      }
    }
  }

  private assertLease(candidate: ClaudeSessionTicketLease): void {
    if (
      candidate.agentId !== "claude" ||
      !candidate.bundleId ||
      !candidate.projectId ||
      !candidate.sessionId ||
      !candidate.lineageId ||
      candidate.incarnation < 1 ||
      !Number.isInteger(candidate.incarnation) ||
      !candidate.runId ||
      !/^cci_[A-Za-z0-9_-]{24,}$/u.test(candidate.installationId)
    ) {
      throw new RenewalInvariantError("Claude ticket lease requires its exact session lineage");
    }
    if (
      instant(candidate.expiresAt, "expiresAt") <= instant(candidate.activatedAt, "activatedAt")
    ) {
      throw new RenewalInvariantError("Claude ticket lease must expire after activation");
    }
    instant(candidate.serverNow, "serverNow");
    instant(candidate.observedAt, "observedAt");
  }

  private assertSuccessor(current: ClaudeSessionTicketLease, next: ClaudeSessionTicketLease): void {
    this.assertLease(next);
    if (
      next.bundleId === current.bundleId ||
      next.projectId !== current.projectId ||
      next.sessionId !== current.sessionId ||
      next.lineageId !== current.lineageId ||
      next.incarnation !== current.incarnation ||
      next.runId !== current.runId ||
      next.installationId !== current.installationId ||
      Date.parse(next.expiresAt) <= Date.parse(current.expiresAt)
    ) {
      throw new RenewalInvariantError("CONTROL rotation changed the exact Claude session binding");
    }
  }

  private localExpiry(candidate: ClaudeSessionTicketLease): number {
    return (
      instant(candidate.observedAt, "observedAt") +
      (instant(candidate.expiresAt, "expiresAt") - instant(candidate.serverNow, "serverNow"))
    );
  }

  private safetyDeadline(candidate: ClaudeSessionTicketLease): number {
    return this.localExpiry(candidate) - this.safetyMarginMs;
  }

  private retryable(error: Error): boolean {
    if (error instanceof RenewalInvariantError) return false;
    const status = Number((error as Error & { status?: unknown }).status);
    if (Number.isFinite(status)) return status === 408 || status === 429 || status >= 500;
    return error instanceof TypeError;
  }

  private scheduleAt(at: number): void {
    if (!this.started || this.stopped) return;
    this.clearTimer();
    const delay = Math.min(0x7fff_ffff, Math.max(1, at - this.clock.now()));
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      if (this.clock.now() < at) {
        this.scheduleAt(at);
        return;
      }
      void this.renewNow();
    }, delay);
    (this.timer as TimerHandle & { unref?: () => void }).unref?.();
  }

  private clearTimer(): void {
    if (!this.timer) return;
    this.clock.clearTimeout(this.timer);
    this.timer = null;
  }
}
