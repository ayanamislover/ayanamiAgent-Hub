import { lstat, mkdir, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadOrCreateClaudeChannelIdentity,
  type ClaudeChannelInstallationIdentity,
} from "../src/installation-identity.js";

const roots: string[] = [];

async function fixturePath(name: string): Promise<string> {
  const root = join(tmpdir(), `crossagent-claude-identity-${name}-${crypto.randomUUID()}`);
  roots.push(root);
  return join(root, "installation.json");
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("durable Claude Channel installation identity", () => {
  it("atomically creates one stable non-PID identity and reuses it across restarts", async () => {
    const path = await fixturePath("stable");
    const [first, second] = await Promise.all([
      loadOrCreateClaudeChannelIdentity(path),
      loadOrCreateClaudeChannelIdentity(path),
    ]);
    const restarted = await loadOrCreateClaudeChannelIdentity(path);

    expect(first).toEqual(second);
    expect(restarted).toEqual(first);
    expect(first.installationId).toMatch(/^cci_[A-Za-z0-9_-]{24,}$/u);
    expect(first.installationId).not.toContain(String(process.pid));
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(first);
    if (process.platform !== "win32") expect((await lstat(path)).mode & 0o777).toBe(0o600);
  });

  it("fails loud for malformed, symlinked, or identity-swapped files", async () => {
    const path = await fixturePath("invalid");
    await mkdir(join(path, ".."), { recursive: true });
    const { writeFile, unlink } = await import("node:fs/promises");
    await writeFile(path, '{"schemaVersion":1,"installationId":"pid-123"}', { mode: 0o600 });
    await expect(loadOrCreateClaudeChannelIdentity(path)).rejects.toThrow(
      /installation identity/iu,
    );

    await unlink(path);
    const target = join(path, "..", "target.json");
    const valid: ClaudeChannelInstallationIdentity = {
      schemaVersion: 1,
      installationId: `cci_${"a".repeat(32)}`,
      createdAt: "2026-08-01T00:00:00.000Z",
    };
    await writeFile(target, JSON.stringify(valid), { mode: 0o600 });
    await symlink(target, path);
    await expect(loadOrCreateClaudeChannelIdentity(path)).rejects.toThrow(
      /regular file|symbolic/iu,
    );
  });
});
