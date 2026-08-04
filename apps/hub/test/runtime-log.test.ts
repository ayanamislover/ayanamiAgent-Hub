import { describe, expect, it } from "vitest";
import {
  RUNTIME_LOG_MAX_ARCHIVES,
  RUNTIME_LOG_MAX_BYTES,
  RuntimeLog,
  RuntimeLogFailure,
  shouldRotateRuntimeLog,
  type RuntimeLogFileEntry,
  type RuntimeLogStorageAdapter,
} from "../src/logging/runtime-log.js";

class FakeStorage implements RuntimeLogStorageAdapter {
  readonly files = new Map<string, { contents: string; size: number; mtimeMs: number }>();
  readonly calls: string[] = [];
  nowMs = Date.parse("2026-08-01T12:00:00.000Z");
  pauseRename: Promise<void> | undefined;
  failAppendCode: string | undefined;
  failRenameCode: string | undefined;

  seed(path: string, bytes: number, mtimeMs = this.nowMs): void {
    this.files.set(path, {
      contents: bytes <= 1_024 ? "x".repeat(bytes) : "<seeded>",
      size: bytes,
      mtimeMs,
    });
  }

  async stat(path: string): Promise<RuntimeLogFileEntry | undefined> {
    const file = this.files.get(path);
    return file === undefined ? undefined : { path, size: file.size, mtimeMs: file.mtimeMs };
  }

  async list(directory: string): Promise<RuntimeLogFileEntry[]> {
    const prefix = `${directory}/`;
    return [...this.files]
      .filter(([path]) => path.startsWith(prefix))
      .map(([path, file]) => ({ path, size: file.size, mtimeMs: file.mtimeMs }));
  }

  async append(path: string, completeLine: string): Promise<void> {
    this.calls.push(`append:${path}`);
    if (this.failAppendCode)
      throw Object.assign(new Error("append failed"), { code: this.failAppendCode });
    const previous = this.files.get(path)?.contents ?? "";
    const previousSize = this.files.get(path)?.size ?? 0;
    this.files.set(path, {
      contents: previous + completeLine,
      size: previousSize + Buffer.byteLength(completeLine),
      mtimeMs: this.nowMs,
    });
  }

  async closeOwner(path: string): Promise<void> {
    this.calls.push(`close:${path}`);
  }

  async renameAtomicSameDirectory(source: string, destination: string): Promise<void> {
    this.calls.push(`rename:${source}->${destination}`);
    if (this.pauseRename) await this.pauseRename;
    if (this.failRenameCode) {
      throw Object.assign(new Error("rename failed"), { code: this.failRenameCode });
    }
    const file = this.files.get(source);
    if (file === undefined) throw Object.assign(new Error("missing source"), { code: "ENOENT" });
    this.files.set(destination, file);
    this.files.delete(source);
  }

  async reopenOwner(path: string): Promise<void> {
    this.calls.push(`reopen:${path}`);
    if (!this.files.has(path)) this.files.set(path, { contents: "", size: 0, mtimeMs: this.nowMs });
  }

  async remove(path: string): Promise<void> {
    this.calls.push(`remove:${path}`);
    this.files.delete(path);
  }

  now(): number {
    return this.nowMs;
  }
}

const currentPath = "C:/isolated/runtime.log";

describe("runtime log hygiene", () => {
  it.each([
    [RUNTIME_LOG_MAX_BYTES - 1, false],
    [RUNTIME_LOG_MAX_BYTES, true],
    [RUNTIME_LOG_MAX_BYTES + 1, true],
  ])("pins the 16 MiB rotation boundary at %i bytes", async (existingBytes, expectedRotation) => {
    expect(shouldRotateRuntimeLog(existingBytes)).toBe(expectedRotation);
    const storage = new FakeStorage();
    storage.seed(currentPath, existingBytes);
    const log = new RuntimeLog({ currentPath, storage });
    await log.emit({ event: "runtime.stopped", reasonCode: "BOUNDARY_TEST" });
    expect(storage.calls.some((call) => call.startsWith("rename:"))).toBe(expectedRotation);
  });

  it("writes only allowlisted structured events as one complete JSON line", async () => {
    const storage = new FakeStorage();
    const log = new RuntimeLog({ currentPath, storage });
    await log.emit({
      event: "bridge.state_changed",
      projectId: "prj_123",
      agentId: "codex",
      from: "CONNECTING",
      to: "READY",
      reasonCode: "CONTROL_READY",
    });

    const contents = storage.files.get(currentPath)?.contents ?? "";
    expect(contents.endsWith("\n")).toBe(true);
    expect(contents.slice(0, -1)).not.toContain("\n");
    expect(JSON.parse(contents)).toEqual({
      at: "2026-08-01T12:00:00.000Z",
      event: "bridge.state_changed",
      projectId: "prj_123",
      agentId: "codex",
      from: "CONNECTING",
      to: "READY",
      reasonCode: "CONTROL_READY",
    });
  });

  it("rejects secret-shaped values, raw transport material, and unknown event fields before I/O", async () => {
    const attacks: unknown[] = [
      { event: "runtime.error", operation: "start", code: "Bearer abc.def.ghi", retryable: false },
      {
        event: "runtime.error",
        operation: "start",
        code: "token=credential-canary",
        retryable: false,
      },
      {
        event: "http.failure",
        method: "GET",
        routeTemplate: "/api/health?token=canary",
        statusCode: 500,
        durationMs: 1,
      },
      {
        event: "runtime.stopped",
        reasonCode: "DONE",
        headers: { authorization: "credential-canary" },
      },
      { event: "runtime.stopped", reasonCode: "DONE", rawUrl: "/api/health" },
      { event: "runtime.stopped", reasonCode: "DONE", cookie: "session=credential-canary" },
      { event: "runtime.stopped", reasonCode: "DONE", body: "credential-canary" },
      { event: "runtime.stopped", reasonCode: "DONE", prompt: "credential-canary" },
      { event: "runtime.stopped", reasonCode: "DONE", stderr: "credential-canary" },
    ];
    for (const attack of attacks) {
      const storage = new FakeStorage();
      const log = new RuntimeLog({ currentPath, storage });
      await expect(log.emit(attack as never)).rejects.toMatchObject({ code: "UNSAFE_LOG_EVENT" });
      expect(storage.calls).toEqual([]);
    }
  });

  it("suppresses 10k healthy probes and emits exactly one line for a failed probe", async () => {
    const storage = new FakeStorage();
    const log = new RuntimeLog({ currentPath, storage });
    for (let index = 0; index < 10_000; index += 1) {
      await log.observeHttp({
        method: "GET",
        routeTemplate: "/api/health",
        statusCode: 200,
        durationMs: 1,
      });
    }
    expect(storage.calls).toEqual([]);

    await log.observeHttp({
      method: "GET",
      routeTemplate: "/api/health",
      statusCode: 503,
      durationMs: 2,
      errorCode: "HEALTH_UNAVAILABLE",
    });
    expect(storage.calls.filter((call) => call.startsWith("append:"))).toHaveLength(1);
    expect(JSON.parse(storage.files.get(currentPath)?.contents ?? "{}").event).toBe("http.failure");
  });

  it("closes, atomically renames in place, reopens, then appends the next whole line", async () => {
    const storage = new FakeStorage();
    storage.seed(currentPath, RUNTIME_LOG_MAX_BYTES);
    const log = new RuntimeLog({ currentPath, storage });
    await log.emit({ event: "runtime.stopped", reasonCode: "TEST_COMPLETE" });

    expect(storage.calls.slice(0, 4).map((call) => call.split(":", 1)[0])).toEqual([
      "close",
      "rename",
      "reopen",
      "append",
    ]);
    const current = storage.files.get(currentPath)?.contents ?? "";
    expect(current.endsWith("\n")).toBe(true);
    expect(current.slice(0, -1)).not.toContain("\n");
    expect([...storage.files.keys()].filter((path) => path.includes(".archive-"))).toHaveLength(1);
  });

  it("deduplicates concurrent rotation and keeps current plus four bounded archives", async () => {
    const storage = new FakeStorage();
    storage.seed(currentPath, 10);
    let releaseRename!: () => void;
    storage.pauseRename = new Promise<void>((resolve) => {
      releaseRename = resolve;
    });
    const log = new RuntimeLog({ currentPath, storage });
    const first = log.rotate();
    const second = log.rotate();
    releaseRename();
    await Promise.all([first, second]);
    expect(storage.calls.filter((call) => call.startsWith("rename:"))).toHaveLength(1);

    storage.pauseRename = undefined;
    for (let index = 0; index < RUNTIME_LOG_MAX_ARCHIVES + 3; index += 1) {
      storage.nowMs += 1;
      storage.seed(currentPath, 10, storage.nowMs);
      await log.rotate();
    }
    const archives = [...storage.files.keys()].filter((path) => path.includes(".archive-"));
    expect(archives).toHaveLength(RUNTIME_LOG_MAX_ARCHIVES);
  });

  it("prunes archives older than 14 days and oldest files until the 80 MiB budget is met", async () => {
    const storage = new FakeStorage();
    const day = 24 * 60 * 60 * 1_000;
    const old = `C:/isolated/runtime.log.archive-${storage.nowMs - 15 * day}-1`;
    const archiveA = `C:/isolated/runtime.log.archive-${storage.nowMs - 3 * day}-2`;
    const archiveB = `C:/isolated/runtime.log.archive-${storage.nowMs - 2 * day}-3`;
    const archiveC = `C:/isolated/runtime.log.archive-${storage.nowMs - day}-4`;
    const unrelated = "C:/isolated/runtime.log.archive-user-file";
    storage.seed(old, 1, storage.nowMs - 15 * day);
    storage.seed(archiveA, 30 * 1024 * 1024, storage.nowMs - 3 * day);
    storage.seed(archiveB, 30 * 1024 * 1024, storage.nowMs - 2 * day);
    storage.seed(archiveC, 30 * 1024 * 1024, storage.nowMs - day);
    storage.seed(unrelated, 7, storage.nowMs - 100 * day);
    storage.seed(currentPath, 1);
    const log = new RuntimeLog({ currentPath, storage });
    await log.rotate();

    expect(storage.files.has(old)).toBe(false);
    expect(storage.files.has(unrelated)).toBe(true);
    const retainedBytes = [...storage.files.values()].reduce((sum, file) => sum + file.size, 0);
    expect(retainedBytes).toBeLessThanOrEqual(80 * 1024 * 1024);
  });

  it.each(["EPERM", "EBUSY"])(
    "fails closed on Windows sharing violation %s and reopens the owner",
    async (code) => {
      const storage = new FakeStorage();
      storage.seed(currentPath, 10);
      storage.failRenameCode = code;
      const log = new RuntimeLog({ currentPath, storage });
      await expect(log.rotate()).rejects.toMatchObject({
        name: "RuntimeLogFailure",
        code: "LOG_ROTATION_SHARING_VIOLATION",
      });
      expect(storage.files.get(currentPath)?.contents).toBe("x".repeat(10));
      expect(storage.calls).toEqual([
        `close:${currentPath}`,
        expect.stringMatching(/^rename:/),
        `reopen:${currentPath}`,
      ]);
    },
  );

  it("propagates disk-full without rename, remove, or truncate behavior", async () => {
    const storage = new FakeStorage();
    storage.failAppendCode = "ENOSPC";
    const log = new RuntimeLog({ currentPath, storage });
    await expect(
      log.emit({ event: "runtime.stopped", reasonCode: "DISK_TEST" }),
    ).rejects.toMatchObject({
      name: "RuntimeLogFailure",
      code: "LOG_DISK_FULL",
    });
    expect(storage.calls).toEqual([`append:${currentPath}`]);
    expect(storage.files.has(currentPath)).toBe(false);
  });

  it("uses a typed failure without retaining the adapter's raw error message", () => {
    const failure = new RuntimeLogFailure("LOG_DISK_FULL");
    expect(failure.message).toBe("LOG_DISK_FULL");
    expect(JSON.stringify(failure)).not.toContain("credential-canary");
  });
});
