import type { ClaudeChannel } from "./channel.js";
import { HubHttpError } from "@crossagent/client";

/**
 * Doubling backoff, capped at 30s.
 *
 * The two cases to serve are a Hub that is seconds from being ready (so the first retries are quick)
 * and a Hub nobody started at all (so the process must settle into an idle poll rather than spin for
 * as long as the client stays open).
 */
export function defaultRetryDelayMs(attempt: number): number {
  return Math.min(30_000, 1_000 * 2 ** (attempt - 1));
}

export type AttachOptions = {
  /**
   * Resolved per attempt, not once: with `--project-id` the working directory comes from the Hub
   * itself, so it is not knowable until the Hub answers.
   */
  resolveCwd: () => Promise<string>;
  delayMs?: (attempt: number) => number;
  onRetry?: (error: unknown, attempt: number, waitMs: number) => void;
  /** Defaults to retrying for as long as the process lives. */
  maxAttempts?: number;
};

/**
 * A refused or dropped connection reaches us as a TypeError from fetch, but always wrapped around
 * the underlying cause. That wrapper is what separates "the Hub is not up yet" from a fault in this
 * code that happens to share an error type.
 */
function wrapsATransportFailure(error: unknown): boolean {
  const cause = (error as { cause?: unknown } | null)?.cause;
  return cause !== undefined && cause !== null;
}

export function isRetryableAttachError(error: unknown): boolean {
  if (error instanceof HubHttpError) {
    return (
      error.status === 401 ||
      error.status === 403 ||
      error.status === 408 ||
      error.status === 409 ||
      error.status === 429 ||
      error.status >= 500
    );
  }
  // A programming fault cannot be fixed by waiting, and retrying one forever is indistinguishable
  // from a hung channel: the tools stay listed, nothing ever connects, and no failure is ever
  // reported. That is the shape of an outage this project has already paid for once. Everything
  // else still retries -- an unrecognised error is assumed transient, because giving up on a
  // recoverable one costs the agent its channel for the whole session.
  if (
    (error instanceof TypeError ||
      error instanceof ReferenceError ||
      error instanceof SyntaxError ||
      error instanceof RangeError) &&
    !wrapsATransportFailure(error)
  ) {
    return false;
  }
  return true;
}

/**
 * Attaches an already-serving channel to the Hub, retrying until it answers.
 *
 * Deliberately separate from serving MCP. The client spawns this process and asks for tools at once,
 * while the Hub is a different process that may still be starting -- the normal case after a reboot,
 * where nothing brings the Hub up before the agent's app. Attaching first meant a refused connection
 * killed the process before any transport existed, costing the agent its channel tools for the whole
 * session with no retry.
 */
export async function attachToHub(
  channel: Pick<ClaudeChannel, "startHubSession">,
  options: AttachOptions,
): Promise<void> {
  const {
    resolveCwd,
    delayMs = defaultRetryDelayMs,
    onRetry = () => {},
    maxAttempts = Number.POSITIVE_INFINITY,
  } = options;
  for (let attempt = 1; ; attempt += 1) {
    try {
      await channel.startHubSession(await resolveCwd());
      return;
    } catch (error: unknown) {
      if (!isRetryableAttachError(error)) throw error;
      // The final failure is reported by rejecting rather than by sleeping on it.
      if (attempt >= maxAttempts) throw error;
      const waitMs = delayMs(attempt);
      onRetry(error, attempt, waitMs);
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, waitMs);
        // An outstanding retry must not be the reason the process stays alive.
        timer.unref();
      });
    }
  }
}
