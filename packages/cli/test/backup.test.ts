import Database from "better-sqlite3";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const previousDataDir = process.env.CROSSAGENT_DATA_DIR;

afterEach(() => {
  if (previousDataDir === undefined) delete process.env.CROSSAGENT_DATA_DIR;
  else process.env.CROSSAGENT_DATA_DIR = previousDataDir;
  vi.resetModules();
});

describe("backup lifecycle", () => {
  it("creates a consistent database backup and restores artifacts", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "crossagent-backup-"));
    process.env.CROSSAGENT_DATA_DIR = root;
    const databasePath = resolve(root, "crossagent.db");
    const database = new Database(databasePath);
    database.exec("CREATE TABLE marker(value TEXT NOT NULL); INSERT INTO marker VALUES ('before')");
    database.close();
    const artifactPath = resolve(root, "artifacts", "artifact.txt");
    await import("node:fs").then(({ mkdirSync }) =>
      mkdirSync(resolve(root, "artifacts"), { recursive: true }),
    );
    writeFileSync(artifactPath, "before", "utf8");

    const { createBackup, restoreBackup } = await import("../src/backup.js");
    const backupPath = resolve(root, "export");
    const created = await createBackup(backupPath);
    expect(created.databaseBytes).toBeGreaterThan(0);
    expect(existsSync(resolve(backupPath, "manifest.json"))).toBe(true);

    const changed = new Database(databasePath);
    changed.exec("UPDATE marker SET value = 'after'");
    changed.close();
    writeFileSync(artifactPath, "after", "utf8");
    restoreBackup(backupPath);

    const restored = new Database(databasePath, { readonly: true });
    expect((restored.prepare("SELECT value FROM marker").get() as { value: string }).value).toBe(
      "before",
    );
    restored.close();
    expect(readFileSync(artifactPath, "utf8")).toBe("before");
  });
});
