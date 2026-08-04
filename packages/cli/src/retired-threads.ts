import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ThreadRetirementRequired } from "@crossagent/codex-bridge";
import { dataDir } from "./paths.js";

/**
 * Which Codex threads have been retired because their rollout degraded past use.
 *
 * The Bridge can detect the decline but cannot act on it in place: swapping the thread under a live
 * session would have to rebind the whole ticket lineage, which the ticket runtime refuses by design.
 * So the verdict is recorded here, and the next launch honours it by starting a successor thread
 * instead of resuming the one that no longer answers. That is the only point where creating a
 * successor is safe, and it is automatic — nobody has to remember which thread went bad.
 */

export type RetiredThreadRecord = {
  threadId: string;
  projectId: string | null;
  reason: string;
  rolloutBytes: number | null;
  retiredAt: string;
};

type RetiredThreadFile = {
  schemaVersion: 1;
  threads: RetiredThreadRecord[];
};

/** Enough to cover any plausible history of retirements without growing the file forever. */
const MAX_RETAINED = 50;

export function retiredThreadsPath(root = dataDir): string {
  return resolve(root, "codex", "retired-threads.json");
}

export function readRetiredThreads(root = dataDir): RetiredThreadRecord[] {
  try {
    const parsed = JSON.parse(readFileSync(retiredThreadsPath(root), "utf8")) as RetiredThreadFile;
    if (parsed?.schemaVersion !== 1 || !Array.isArray(parsed.threads)) return [];
    return parsed.threads.filter((entry) => typeof entry?.threadId === "string");
  } catch {
    // Missing is the normal case, and unreadable must not stop a Bridge from starting. Either way
    // the answer is the same: nothing is known to be retired.
    return [];
  }
}

export function readRetiredThread(threadId: string, root = dataDir): RetiredThreadRecord | null {
  return readRetiredThreads(root).find((entry) => entry.threadId === threadId) ?? null;
}

export function recordRetiredThread(
  request: ThreadRetirementRequired,
  root = dataDir,
): RetiredThreadRecord {
  const record: RetiredThreadRecord = {
    threadId: request.threadId,
    projectId: request.projectId,
    reason: request.reason,
    rolloutBytes: request.rolloutBytes,
    retiredAt: request.issuedAt,
  };
  const existing = readRetiredThreads(root).filter((entry) => entry.threadId !== record.threadId);
  const file: RetiredThreadFile = {
    schemaVersion: 1,
    threads: [record, ...existing].slice(0, MAX_RETAINED),
  };
  const path = retiredThreadsPath(root);
  mkdirSync(dirname(path), { recursive: true });
  // Written through a temporary file so a crash mid-write cannot leave the launch path reading a
  // truncated list and silently resuming a thread that was already retired.
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(file, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
  return record;
}
