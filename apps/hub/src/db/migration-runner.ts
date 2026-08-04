import type Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  loadCanonicalMigrationPlan,
  type CanonicalMigration,
} from "../../../../scripts/build-identity.mjs";

type MigrationFile = CanonicalMigration;

type AppliedMigrationRow = {
  version: number;
  name: string;
  content_sha256?: string | null;
  hash_origin?: string | null;
};

function migrationTableColumns(sqlite: Database.Database): Set<string> {
  return new Set(
    (sqlite.prepare("PRAGMA table_info(schema_migrations)").all() as Array<{ name: string }>).map(
      (column) => column.name,
    ),
  );
}

function assertAppliedPlan(
  applied: AppliedMigrationRow[],
  plan: MigrationFile[],
  hasIntegrityColumns: boolean,
): void {
  const filesByVersion = new Map(plan.map((file) => [file.version, file]));
  const appliedVersions = new Set(applied.map((row) => Number(row.version)));
  const maximumApplied = Math.max(0, ...appliedVersions);
  for (const file of plan) {
    if (file.version < maximumApplied && !appliedVersions.has(file.version)) {
      throw new Error(
        `Migration history gap: pending version ${file.version} is older than applied version ${maximumApplied}`,
      );
    }
  }
  for (const row of applied) {
    const version = Number(row.version);
    if (!Number.isSafeInteger(version) || version <= 0) {
      throw new Error(`Invalid applied migration version ${row.version}`);
    }
    const file = filesByVersion.get(version);
    if (!file) {
      throw new Error(`Applied migration ${version} (${row.name}) has no local migration file`);
    }
    if (row.name !== file.name) {
      throw new Error(
        `Migration ${version} filename mismatch: database=${row.name}, local=${file.name}`,
      );
    }
    if (!hasIntegrityColumns) continue;
    if (!row.content_sha256 || !row.hash_origin) {
      throw new Error(`Migration ${version} is missing its recorded content hash`);
    }
    if (row.content_sha256 !== file.contentSha256) {
      throw new Error(
        `Migration ${version} content hash mismatch: database=${row.content_sha256}, local=${file.contentSha256}`,
      );
    }
    if (!new Set(["APPLIED", "LEGACY_BASELINE_UNVERIFIED"]).has(row.hash_origin)) {
      throw new Error(`Migration ${version} has invalid hash origin ${row.hash_origin}`);
    }
  }
}

async function backupBeforeMutation(
  sqlite: Database.Database,
  databasePath: string,
  hadDatabase: boolean,
): Promise<void> {
  if (!hadDatabase || databasePath === ":memory:") return;
  const backupDir = resolve(dirname(databasePath), "backups", "pre-migration");
  mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replaceAll(":", "-");
  await sqlite.backup(resolve(backupDir, `crossagent-${stamp}.db`));
}

export async function runMigrations(
  sqlite: Database.Database,
  migrationDir: string,
  databasePath = ":memory:",
  hadDatabase = false,
): Promise<void> {
  const plan = loadCanonicalMigrationPlan(migrationDir);
  const hasMigrationTable = Boolean(
    sqlite
      .prepare(
        "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
      )
      .get(),
  );
  const columns = hasMigrationTable ? migrationTableColumns(sqlite) : new Set<string>();
  const hasContentHash = columns.has("content_sha256");
  const hasHashOrigin = columns.has("hash_origin");
  if (hasContentHash !== hasHashOrigin) {
    throw new Error("schema_migrations integrity columns are only partially installed");
  }
  const hasIntegrityColumns = hasContentHash && hasHashOrigin;
  const appliedRows = hasMigrationTable
    ? (sqlite
        .prepare(
          hasIntegrityColumns
            ? "SELECT version, name, content_sha256, hash_origin FROM schema_migrations ORDER BY version"
            : "SELECT version, name FROM schema_migrations ORDER BY version",
        )
        .all() as AppliedMigrationRow[])
    : [];
  assertAppliedPlan(appliedRows, plan, hasIntegrityColumns);
  const appliedVersions = new Set(appliedRows.map((row) => Number(row.version)));
  const pending = plan.filter((file) => !appliedVersions.has(file.version));
  const needsIntegrityUpgrade = hasMigrationTable && !hasIntegrityColumns;
  if (pending.length > 0 || needsIntegrityUpgrade) {
    await backupBeforeMutation(sqlite, databasePath, hadDatabase);
  }

  const installIntegritySchema = sqlite.transaction(() => {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL,
        content_sha256 TEXT NOT NULL,
        hash_origin TEXT NOT NULL CHECK(hash_origin IN ('APPLIED', 'LEGACY_BASELINE_UNVERIFIED'))
      )
    `);
    if (!needsIntegrityUpgrade) return;
    sqlite.exec(`
      ALTER TABLE schema_migrations ADD COLUMN content_sha256 TEXT;
      ALTER TABLE schema_migrations ADD COLUMN hash_origin TEXT
        CHECK(hash_origin IS NULL OR hash_origin IN ('APPLIED', 'LEGACY_BASELINE_UNVERIFIED'));
    `);
    const baseline = sqlite.prepare(
      `UPDATE schema_migrations
       SET content_sha256 = ?, hash_origin = 'LEGACY_BASELINE_UNVERIFIED'
       WHERE version = ? AND name = ? AND content_sha256 IS NULL AND hash_origin IS NULL`,
    );
    const filesByVersion = new Map(plan.map((file) => [file.version, file]));
    for (const row of appliedRows) {
      const file = filesByVersion.get(Number(row.version))!;
      if (baseline.run(file.contentSha256, row.version, row.name).changes !== 1) {
        throw new Error(`Failed to baseline migration ${row.version} content hash`);
      }
    }
  });
  installIntegritySchema();

  const apply = sqlite.transaction((file: MigrationFile) => {
    sqlite.exec(file.sql);
    sqlite
      .prepare(
        `INSERT INTO schema_migrations(
           version, name, applied_at, content_sha256, hash_origin
         ) VALUES (?, ?, ?, ?, 'APPLIED')`,
      )
      .run(file.version, file.name, new Date().toISOString(), file.contentSha256);
  });
  for (const file of pending) apply(file);
}
