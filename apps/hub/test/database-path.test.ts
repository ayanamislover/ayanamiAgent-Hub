import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { resolveMigrationsDirectory } from "../src/db/database.js";

const temporaryDirectories: string[] = [];
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const repositoryMigrations = resolve(repositoryRoot, "migrations");

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(resolve(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

describe("migration directory discovery", () => {
  it.each([
    resolve(repositoryRoot, "apps", "hub", "src", "db", "database.ts"),
    resolve(repositoryRoot, "apps", "hub", "dist", "chunk-runtime.js"),
  ])("anchors %s to the workspace instead of the caller cwd", (modulePath) => {
    const caller = temporaryDirectory("crossagent-arbitrary-cwd-");
    const decoy = resolve(caller, "migrations");
    mkdirSync(decoy);
    writeFileSync(resolve(decoy, "9999_decoy.sql"), "SELECT 1;\n", "utf8");

    expect(
      resolveMigrationsDirectory({
        moduleUrl: pathToFileURL(modulePath).href,
        cwd: caller,
        environment: {},
      }),
    ).toBe(repositoryMigrations);
  });

  it("rejects a decoy-only explicit override instead of treating arbitrary SQL as CrossAgent", () => {
    const caller = temporaryDirectory("crossagent-invalid-migrations-");
    writeFileSync(resolve(caller, "9999_decoy.sql"), "SELECT 1;\n", "utf8");

    expect(() =>
      resolveMigrationsDirectory({
        moduleUrl: pathToFileURL(resolve(repositoryRoot, "apps", "hub", "dist", "chunk-runtime.js"))
          .href,
        cwd: caller,
        environment: { CROSSAGENT_MIGRATIONS_DIR: caller },
      }),
    ).toThrow(/CROSSAGENT_MIGRATIONS_DIR.*does not contain CrossAgent migrations/i);
  });
});
