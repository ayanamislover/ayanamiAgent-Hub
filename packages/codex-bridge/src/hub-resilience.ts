const NETWORK_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);
const NETWORK_ERROR_NAMES = new Set(["AbortError", "TimeoutError"]);

const NODE_MAX_TIMER_DELAY_MS = 2_147_483_647;
const DEFAULT_INITIAL_DELAY_MS = 250;
const DEFAULT_MAX_DELAY_MS = 5_000;
const DEFAULT_JITTER_RATIO = 0.2;
const NEUTRAL_RANDOM_VALUE = 0.5;

export type HubReconnectBackoffOptions = {
  initialDelayMs?: number;
  maxDelayMs?: number;
  jitterRatio?: number;
  random?: () => number;
};

function normalizeDelayMs(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(NODE_MAX_TIMER_DELAY_MS, Math.max(1, Math.round(value)));
}

function normalizeJitterRatio(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_JITTER_RATIO;
  return Math.min(1, Math.max(0, value));
}

function normalizeRandomValue(value: number): number {
  if (!Number.isFinite(value)) return NEUTRAL_RANDOM_VALUE;
  return Math.min(1, Math.max(0, value));
}

/**
 * Owns the retry timing policy for the Hub transport.
 *
 * The Bridge only asks for the next delay or reports a successful connection. Keeping the
 * exponential/jitter arithmetic behind this small Interface prevents every reconnect call site from
 * growing its own subtly different loop.
 */
export class HubReconnectBackoff {
  private readonly initialDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly jitterRatio: number;
  private readonly random: () => number;
  private failureCount = 0;

  constructor(options: HubReconnectBackoffOptions = {}) {
    this.initialDelayMs = normalizeDelayMs(options.initialDelayMs, DEFAULT_INITIAL_DELAY_MS);
    this.maxDelayMs = Math.max(
      this.initialDelayMs,
      normalizeDelayMs(options.maxDelayMs, DEFAULT_MAX_DELAY_MS),
    );
    this.jitterRatio = normalizeJitterRatio(options.jitterRatio);
    this.random = options.random ?? Math.random;
  }

  nextDelayMs(): number {
    const exponent = Math.min(this.failureCount, 30);
    const nominal = Math.min(this.maxDelayMs, this.initialDelayMs * 2 ** exponent);
    this.failureCount += 1;
    const randomValue = normalizeRandomValue(this.random());
    const jitter = 1 - this.jitterRatio + randomValue * this.jitterRatio * 2;
    return Math.min(this.maxDelayMs, Math.max(1, Math.round(nominal * jitter)));
  }

  reset(): void {
    this.failureCount = 0;
  }
}

/**
 * Distinguishes "the Hub answered with an error" from "there was no Hub transport to answer".
 *
 * `fetch()` wraps the socket error in a TypeError and places the useful code on `cause`, so the
 * classifier walks that bounded cause chain rather than relying on one Node/Undici message string.
 */
export function isHubNetworkError(error: unknown): boolean {
  let current: unknown = error;
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 5 && current && !seen.has(current); depth += 1) {
    seen.add(current);
    if (typeof current === "object") {
      const record = current as Record<string, unknown>;
      if (typeof record.code === "string" && NETWORK_ERROR_CODES.has(record.code)) return true;
      if (typeof record.name === "string" && NETWORK_ERROR_NAMES.has(record.name)) return true;
      current = record.cause;
      continue;
    }
    break;
  }
  return error instanceof TypeError && /fetch failed/i.test(error.message);
}
