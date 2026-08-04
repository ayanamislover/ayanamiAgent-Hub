import Database from "better-sqlite3";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runMigrations } from "./migration-runner.js";

export type HubDatabase = {
  sqlite: Database.Database;
  path: string;
};

type MigrationDirectoryResolution = {
  moduleUrl?: string;
  cwd?: string;
  environment?: NodeJS.ProcessEnv;
};

function containsCrossAgentMigrations(directory: string): boolean {
  try {
    return readdirSync(directory).includes("0001_initial.sql");
  } catch {
    return false;
  }
}

/**
 * Locate migrations from the installed Hub module, never from the caller's project directory.
 *
 * tsup emits the same source once under `apps/hub/dist/chunk-*.js`, while tests load it from
 * `apps/hub/src/db/database.ts`; walking to the workspace marker makes both layouts exact without a
 * fragile hard-coded number of `..` segments. Packaged deployments can provide one explicit path,
 * but a bad override is terminal rather than silently falling through to unrelated SQL.
 */
export function resolveMigrationsDirectory(options: MigrationDirectoryResolution = {}): string {
  const environment = options.environment ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const explicit = environment.CROSSAGENT_MIGRATIONS_DIR;
  if (explicit !== undefined) {
    const directory = resolve(cwd, explicit);
    if (!containsCrossAgentMigrations(directory)) {
      throw new Error(
        `CROSSAGENT_MIGRATIONS_DIR does not contain CrossAgent migrations: ${directory}`,
      );
    }
    return directory;
  }

  const moduleUrl = options.moduleUrl ?? import.meta.url;
  let cursor = dirname(fileURLToPath(moduleUrl));
  for (;;) {
    const migrations = resolve(cursor, "migrations");
    if (
      existsSync(resolve(cursor, "pnpm-workspace.yaml")) &&
      containsCrossAgentMigrations(migrations)
    ) {
      return migrations;
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  throw new Error(
    `Unable to locate CrossAgent workspace migrations from Hub module: ${fileURLToPath(moduleUrl)}`,
  );
}

export async function openDatabase(
  path: string,
  options: { migrationsDir?: string } = {},
): Promise<HubDatabase> {
  const hadDatabase = path !== ":memory:" && existsSync(path) && statSync(path).size > 0;
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("synchronous = NORMAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  await migrate(sqlite, path, hadDatabase, options.migrationsDir);
  return { sqlite, path };
}

/** Compatibility entry point retained for migration-focused tests and downstream callers. */
export async function migrate(
  sqlite: Database.Database,
  databasePath = ":memory:",
  hadDatabase = false,
  migrationsDir = resolveMigrationsDirectory(),
): Promise<void> {
  await runMigrations(sqlite, migrationsDir, databasePath, hadDatabase);
}

export function closeDatabase(database: HubDatabase): void {
  database.sqlite.close();
}
