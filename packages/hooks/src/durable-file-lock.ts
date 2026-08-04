import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

type DurableFilesystemLock = {
  version: 1;
  ownerToken: string;
  pid: number;
  acquiredAt: string;
};

const LOCK_KEYS = ["acquiredAt", "ownerToken", "pid", "version"] as const;
const MAX_LOCK_BYTES = 1_024;

export type DurableFileLockOptions = {
  waitMs?: number;
  staleMs?: number;
  errorPrefix?: string;
};

function isFsError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function parseLock(serialized: string): DurableFilesystemLock {
  if (Buffer.byteLength(serialized, "utf8") > MAX_LOCK_BYTES) {
    throw new Error("durable_file_lock_too_large");
  }
  const candidate = JSON.parse(serialized) as Record<string, unknown>;
  if (Object.keys(candidate).sort().join("\u0000") !== [...LOCK_KEYS].sort().join("\u0000")) {
    throw new Error("durable_file_lock_unknown_fields");
  }
  if (
    candidate.version !== 1 ||
    typeof candidate.ownerToken !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/u.test(candidate.ownerToken) ||
    !Number.isInteger(candidate.pid) ||
    Number(candidate.pid) <= 0 ||
    typeof candidate.acquiredAt !== "string" ||
    Number.isNaN(Date.parse(candidate.acquiredAt))
  ) {
    throw new Error("durable_file_lock_invalid");
  }
  return candidate as DurableFilesystemLock;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isFsError(error, "ESRCH");
  }
}

function writeNewLock(path: string): DurableFilesystemLock {
  const lock: DurableFilesystemLock = {
    version: 1,
    ownerToken: randomBytes(32).toString("base64url"),
    pid: process.pid,
    acquiredAt: new Date().toISOString(),
  };
  let descriptor: number | undefined;
  let created = false;
  try {
    descriptor = openSync(path, "wx", 0o600);
    created = true;
    writeFileSync(descriptor, `${JSON.stringify(lock)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    try {
      chmodSync(path, 0o600);
    } catch {
      // Node's mode bits are not a Windows DACL. The installer owns that host-level policy.
    }
    return lock;
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    if (created) {
      try {
        unlinkSync(path);
      } catch (cleanupError) {
        if (!isFsError(cleanupError, "ENOENT")) {
          throw new AggregateError(
            [error, cleanupError],
            "durable_file_lock_create_and_cleanup_failed",
          );
        }
      }
    }
    throw error;
  }
}

function releaseLock(path: string, owner: DurableFilesystemLock): void {
  let current: DurableFilesystemLock;
  try {
    current = parseLock(readFileSync(path, "utf8"));
  } catch (error) {
    if (isFsError(error, "ENOENT")) return;
    throw error;
  }
  if (current.ownerToken !== owner.ownerToken) return;
  try {
    unlinkSync(path);
  } catch (error) {
    if (!isFsError(error, "ENOENT")) throw error;
  }
}

function finishAbandonedReap(path: string): boolean {
  const reapPath = `${path}.reap`;
  let reaped: DurableFilesystemLock;
  try {
    reaped = parseLock(readFileSync(reapPath, "utf8"));
  } catch {
    return false;
  }
  if (processIsAlive(reaped.pid)) return false;
  try {
    const current = parseLock(readFileSync(path, "utf8"));
    if (current.ownerToken === reaped.ownerToken) unlinkSync(path);
  } catch (error) {
    if (!isFsError(error, "ENOENT")) return false;
  }
  try {
    unlinkSync(reapPath);
  } catch (error) {
    if (!isFsError(error, "ENOENT")) throw error;
  }
  return true;
}

function reapAbandonedLock(path: string, observed: DurableFilesystemLock): boolean {
  const reapPath = `${path}.reap`;
  try {
    // A fixed hard-link captures one exact lock inode. No contender can delete a successor lock.
    linkSync(path, reapPath);
  } catch (error) {
    if (isFsError(error, "EEXIST")) return finishAbandonedReap(path);
    if (isFsError(error, "ENOENT")) return true;
    // Unsupported hard links and remote filesystems fail closed; never degrade to mtime unlink.
    throw error;
  }
  let captured: DurableFilesystemLock;
  try {
    captured = parseLock(readFileSync(reapPath, "utf8"));
  } catch {
    return false;
  }
  if (captured.ownerToken !== observed.ownerToken || processIsAlive(captured.pid)) {
    try {
      unlinkSync(reapPath);
    } catch (error) {
      if (!isFsError(error, "ENOENT")) throw error;
    }
    return false;
  }
  return finishAbandonedReap(path);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

/**
 * Cross-process ownership with stale-owner recovery. The Interface deliberately exposes no lock
 * token: callers receive serialization while the nonce/PID/hard-link Implementation stays local.
 */
export async function withDurableFileLock<T>(
  path: string,
  action: () => Promise<T> | T,
  options: DurableFileLockOptions = {},
): Promise<T> {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const waitMs = options.waitMs ?? 5_000;
  const staleMs = options.staleMs ?? 10_000;
  const errorPrefix = options.errorPrefix ?? "durable_file";
  const deadline = Date.now() + waitMs;
  while (true) {
    if (existsSync(`${path}.reap`)) {
      if (finishAbandonedReap(path)) continue;
      if (Date.now() >= deadline) throw new Error(`${errorPrefix}_lock_timeout`);
      await sleep(10);
      continue;
    }
    let owner: DurableFilesystemLock | undefined;
    try {
      owner = writeNewLock(path);
      try {
        return await action();
      } finally {
        releaseLock(path, owner);
      }
    } catch (error) {
      if (owner) throw error;
      if (!isFsError(error, "EEXIST")) throw error;
      try {
        if (Date.now() - statSync(path).mtimeMs > staleMs) {
          let observed: DurableFilesystemLock | undefined;
          try {
            observed = parseLock(readFileSync(path, "utf8"));
          } catch {
            // Malformed locks are not guessed away because they may still have a live owner.
          }
          if (observed && !processIsAlive(observed.pid) && reapAbandonedLock(path, observed)) {
            continue;
          }
        }
      } catch (statError) {
        if (!isFsError(statError, "ENOENT")) throw statError;
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`${errorPrefix}_lock_timeout`);
      await sleep(10);
    }
  }
}
