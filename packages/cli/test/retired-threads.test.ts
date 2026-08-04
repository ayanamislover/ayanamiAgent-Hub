import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ThreadRetirementRequired } from "@crossagent/codex-bridge";
import {
  readRetiredThread,
  readRetiredThreads,
  recordRetiredThread,
  retiredThreadsPath,
} from "../src/retired-threads.js";

const roots: string[] = [];

function dataRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "crossagent-retired-"));
  roots.push(root);
  return root;
}

function request(threadId: string, bytes = 700 * 1024 * 1024): ThreadRetirementRequired {
  return {
    schemaVersion: 1,
    kind: "CODEX_THREAD_RETIREMENT_REQUIRED",
    issuedAt: "2026-08-04T09:00:00.000Z",
    projectId: "prj_test",
    threadId,
    reason: "the Codex rollout for this thread has reached 700 MB",
    rolloutBytes: bytes,
    slowestReadMs: 41_000,
  };
}

describe("retired Codex threads", () => {
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("knows nothing until a thread has actually been retired", () => {
    const root = dataRoot();

    expect(readRetiredThreads(root)).toEqual([]);
    expect(readRetiredThread("thr_absent", root)).toBeNull();
  });

  it("records the verdict with the evidence behind it and answers for that thread only", () => {
    const root = dataRoot();

    recordRetiredThread(request("thr_old"), root);

    expect(readRetiredThread("thr_old", root)).toMatchObject({
      threadId: "thr_old",
      projectId: "prj_test",
      rolloutBytes: 700 * 1024 * 1024,
      retiredAt: "2026-08-04T09:00:00.000Z",
    });
    expect(readRetiredThread("thr_successor", root)).toBeNull();
  });

  it("keeps every retirement across restarts and does not duplicate one thread", () => {
    const root = dataRoot();

    recordRetiredThread(request("thr_first"), root);
    recordRetiredThread(request("thr_second"), root);
    recordRetiredThread({ ...request("thr_first"), reason: "re-reported after a restart" }, root);

    expect(readRetiredThreads(root).map((entry) => entry.threadId)).toEqual([
      "thr_first",
      "thr_second",
    ]);
    expect(readRetiredThread("thr_first", root)?.reason).toBe("re-reported after a restart");
  });

  it("bounds the file rather than growing it forever", () => {
    const root = dataRoot();

    for (let index = 0; index < 60; index += 1) {
      recordRetiredThread(request(`thr_${index}`), root);
    }

    const stored = readRetiredThreads(root);
    expect(stored).toHaveLength(50);
    expect(stored[0]?.threadId).toBe("thr_59");
  });

  it("treats an unreadable record as nothing retired, so a bad file cannot stop a Bridge starting", () => {
    const root = dataRoot();
    const path = retiredThreadsPath(root);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{ this is not json");

    expect(readRetiredThreads(root)).toEqual([]);

    recordRetiredThread(request("thr_after_corruption"), root);
    expect(readRetiredThread("thr_after_corruption", root)).not.toBeNull();
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ schemaVersion: 1 });
  });
});
