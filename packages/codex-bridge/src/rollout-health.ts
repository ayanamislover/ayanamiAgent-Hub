import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Codex stores each thread as an append-only rollout that only ever grows, and a large enough one
 * stops answering `thread/read` altogether (see docs/known-limitations.md). This project cannot fix
 * that file — Codex owns the format and reads it — so the only honest response is to notice the
 * decline while the thread still works and retire it deliberately, rather than discovering it when
 * a confirmation read times out and every delivery turns ambiguous at once.
 *
 * The signals are deliberately different in kind. Size is the leading one: it is monotonic, it can
 * be read without asking Codex anything, and it crosses the danger line before any call is visibly
 * slow. Read latency is the confirming one: it is what actually breaks, but by the time it does the
 * thread is already unusable. Watching only the second would mean acting only after the failure.
 */

export type RolloutHealthState = "OK" | "WARNING" | "RETIRE";

export type RolloutHealthThresholds = {
  readLatencyWarnMs: number;
  readLatencyRetireMs: number;
  sizeWarnBytes: number;
  sizeRetireBytes: number;
  /** Consecutive degraded score at which the thread is called unrecoverable. */
  degradedScoreRetire: number;
};

const MiB = 1024 * 1024;

/**
 * Every number here is a measurement, not a guess. On codex-cli 0.145.0 a 445 MiB rollout answers
 * `thread/read(includeTurns: true)` in 13.28s on an idle app-server and exceeds a 30s request
 * timeout on a busy one, and a 605 MB one times out outright. So the warning lands well before the
 * first symptom and retirement lands before the thread stops answering, not after.
 */
export const DEFAULT_ROLLOUT_HEALTH_THRESHOLDS: Readonly<RolloutHealthThresholds> = Object.freeze({
  readLatencyWarnMs: 10_000,
  readLatencyRetireMs: 30_000,
  sizeWarnBytes: 256 * MiB,
  sizeRetireBytes: 512 * MiB,
  degradedScoreRetire: 3,
});

export type RolloutHealthSnapshot = {
  state: RolloutHealthState;
  /** Why the state is what it is, or null while nothing is wrong. Never carries a path. */
  reason: string | null;
  rolloutBytes: number | null;
  lastReadMs: number | null;
  slowestReadMs: number | null;
  readTimeouts: number;
  /** Slow reads score one and timed-out reads score two; a healthy read clears the run. */
  consecutiveDegradedScore: number;
  observedAt: string | null;
};

export type RolloutHealthMonitorOptions = {
  thresholds?: Partial<RolloutHealthThresholds>;
  now?: () => Date;
};

export class RolloutHealthMonitor {
  private readonly thresholds: RolloutHealthThresholds;
  private readonly now: () => Date;
  /** RETIRE latches: the rollout that caused it cannot shrink, so the verdict cannot be withdrawn. */
  private retired = false;
  private retiredReason: string | null = null;
  private bytes: number | null = null;
  private lastReadMs: number | null = null;
  private slowestReadMs: number | null = null;
  private timeouts = 0;
  private score = 0;
  private observedAt: string | null = null;

  constructor(options: RolloutHealthMonitorOptions = {}) {
    this.thresholds = { ...DEFAULT_ROLLOUT_HEALTH_THRESHOLDS, ...options.thresholds };
    this.now = options.now ?? (() => new Date());
  }

  observeRead(read: { durationMs: number; timedOut: boolean }): void {
    this.observedAt = this.now().toISOString();
    this.lastReadMs = read.durationMs;
    this.slowestReadMs = Math.max(this.slowestReadMs ?? 0, read.durationMs);
    if (read.timedOut) {
      this.timeouts += 1;
      this.score += 2;
    } else if (read.durationMs >= this.thresholds.readLatencyRetireMs) {
      this.score += 2;
    } else if (read.durationMs >= this.thresholds.readLatencyWarnMs) {
      this.score += 1;
    } else {
      // A read that came back promptly is evidence the thread is still answering, so the run of
      // bad ones ends here. Only an uninterrupted run counts, because a single slow read on a busy
      // app-server says nothing about the rollout.
      this.score = 0;
    }
    this.latch();
  }

  observeSize(bytes: number | null): void {
    if (bytes === null) return;
    this.observedAt = this.now().toISOString();
    this.bytes = bytes;
    this.latch();
  }

  snapshot(): RolloutHealthSnapshot {
    const [state, reason] = this.evaluate();
    return {
      state,
      reason,
      rolloutBytes: this.bytes,
      lastReadMs: this.lastReadMs,
      slowestReadMs: this.slowestReadMs,
      readTimeouts: this.timeouts,
      consecutiveDegradedScore: this.score,
      observedAt: this.observedAt,
    };
  }

  private latch(): void {
    if (this.retired) return;
    const [state, reason] = this.evaluate();
    if (state !== "RETIRE") return;
    this.retired = true;
    this.retiredReason = reason;
  }

  private evaluate(): [RolloutHealthState, string | null] {
    if (this.retired) return ["RETIRE", this.retiredReason];
    if (this.bytes !== null && this.bytes >= this.thresholds.sizeRetireBytes) {
      return [
        "RETIRE",
        `the Codex rollout for this thread has reached ${megabytes(this.bytes)} MB, past the point where thread/read stops answering`,
      ];
    }
    if (this.score >= this.thresholds.degradedScoreRetire) {
      return [
        "RETIRE",
        `thread/read has been slow or timed out ${this.timeouts > 0 ? `(${this.timeouts} timeout(s)) ` : ""}on consecutive attempts, slowest ${Math.round((this.slowestReadMs ?? 0) / 1_000)}s`,
      ];
    }
    if (this.bytes !== null && this.bytes >= this.thresholds.sizeWarnBytes) {
      return [
        "WARNING",
        `the Codex rollout for this thread has grown to ${megabytes(this.bytes)} MB and will eventually stop answering thread/read`,
      ];
    }
    if (this.score > 0) {
      return ["WARNING", `thread/read took ${Math.round((this.lastReadMs ?? 0) / 1_000)}s`];
    }
    return ["OK", null];
  }
}

function megabytes(bytes: number): string {
  return (bytes / MiB).toFixed(0);
}

/**
 * Non-secret local binding for the successor request, mirroring the app-server recovery Seam. It
 * carries ids the supervisor already holds and nothing else — no path, no credential.
 */
export type ThreadRetirementRequired = {
  schemaVersion: 1;
  kind: "CODEX_THREAD_RETIREMENT_REQUIRED";
  issuedAt: string;
  projectId: string | null;
  threadId: string;
  reason: string;
  rolloutBytes: number | null;
  slowestReadMs: number | null;
};

const ROLLOUT_FILE_SUFFIX = ".jsonl";
const ROLLOUT_FILE_PREFIX = "rollout-";
/** `<codexHome>/sessions/<year>/<month>/<day>/rollout-<timestamp>-<threadId>.jsonl`. */
const ROLLOUT_SEARCH_DEPTH = 3;

export function codexHome(environment: NodeJS.ProcessEnv = process.env): string {
  return environment.CODEX_HOME ?? join(homedir(), ".codex");
}

/**
 * Finds the rollout Codex wrote for one thread, or null when it has not written one yet, when the
 * layout has moved, or when the sessions directory is not readable. Every one of those is an
 * unknown size rather than a failure: the latency signal still works without it.
 */
export function findRolloutPath(threadId: string, home = codexHome()): string | null {
  const wanted = `-${threadId}${ROLLOUT_FILE_SUFFIX}`;
  const search = (directory: string, depth: number): string | null => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (depth === 0) continue;
        const found = search(join(directory, entry.name), depth - 1);
        if (found) return found;
      } else if (entry.name.startsWith(ROLLOUT_FILE_PREFIX) && entry.name.endsWith(wanted)) {
        return join(directory, entry.name);
      }
    }
    return null;
  };
  return search(join(home, "sessions"), ROLLOUT_SEARCH_DEPTH);
}

/**
 * Caches the resolved path, because the directory walk is the expensive half and a rollout never
 * moves once Codex has written it. The size is re-read every time, because that is the half that
 * changes.
 */
export class RolloutSizeReader {
  private readonly paths = new Map<string, string | null>();

  constructor(private readonly home = codexHome()) {}

  sizeBytes(threadId: string): number | null {
    if (!this.paths.has(threadId)) {
      this.paths.set(threadId, findRolloutPath(threadId, this.home));
    }
    const path = this.paths.get(threadId) ?? null;
    if (!path) return null;
    try {
      return statSync(path).size;
    } catch {
      // The file was moved or removed under us; forget it so a later call can find it again.
      this.paths.delete(threadId);
      return null;
    }
  }
}
