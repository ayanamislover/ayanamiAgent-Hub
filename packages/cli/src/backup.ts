import Database from "better-sqlite3";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { dataDir, pidPath } from "./paths.js";
import { processExists, readPidRecord } from "./process-manager.js";

type BackupManifest = {
  schemaVersion: 1;
  createdAt: string;
  database: string;
  artifacts: string | null;
};

function stamp(): string {
  return new Date()
    .toISOString()
    .replaceAll(":", "-")
    .replace(/\.\d{3}Z$/, "Z");
}

function defaultBackupPath(): string {
  return resolve(dataDir, "backups", "manual", `crossagent-${stamp()}`);
}

function assertFreshDirectory(path: string): void {
  if (existsSync(path)) throw new Error(`Backup destination already exists: ${path}`);
  mkdirSync(path, { recursive: true });
}

export async function createBackup(destination = defaultBackupPath()): Promise<{
  path: string;
  databaseBytes: number;
  artifactsIncluded: boolean;
}> {
  const target = resolve(destination);
  const sourceDatabase = resolve(dataDir, "crossagent.db");
  if (!existsSync(sourceDatabase)) {
    throw new Error(`CrossAgent database not found: ${sourceDatabase}`);
  }
  assertFreshDirectory(target);
  const databaseDir = resolve(target, "database");
  mkdirSync(databaseDir, { recursive: true });
  const databaseTarget = resolve(databaseDir, "crossagent.db");
  const source = new Database(sourceDatabase, { readonly: true, fileMustExist: true });
  try {
    await source.backup(databaseTarget);
  } finally {
    source.close();
  }

  const sourceArtifacts = resolve(dataDir, "artifacts");
  const artifactsTarget = resolve(target, "artifacts");
  const artifactsIncluded = existsSync(sourceArtifacts);
  if (artifactsIncluded) cpSync(sourceArtifacts, artifactsTarget, { recursive: true });
  const manifest: BackupManifest = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    database: "database/crossagent.db",
    artifacts: artifactsIncluded ? "artifacts" : null,
  };
  writeFileSync(resolve(target, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return {
    path: target,
    databaseBytes: statSync(databaseTarget).size,
    artifactsIncluded,
  };
}

function readManifest(source: string): BackupManifest {
  const manifestPath = resolve(source, "manifest.json");
  if (!existsSync(manifestPath)) throw new Error(`Backup manifest not found: ${manifestPath}`);
  const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as BackupManifest;
  if (
    parsed.schemaVersion !== 1 ||
    parsed.database !== "database/crossagent.db" ||
    (parsed.artifacts !== null && parsed.artifacts !== "artifacts")
  ) {
    throw new Error("Unsupported or unsafe CrossAgent backup manifest");
  }
  return parsed;
}

export function restoreBackup(sourcePath: string): {
  source: string;
  database: string;
  recoveryCopy: string | null;
} {
  const record = readPidRecord();
  if (record && processExists(record.pid)) {
    throw new Error(`Stop CrossAgent Hub before restore (running PID ${record.pid})`);
  }
  const source = resolve(sourcePath);
  const manifest = readManifest(source);
  const databaseSource = resolve(source, manifest.database);
  if (!existsSync(databaseSource)) throw new Error(`Backup database not found: ${databaseSource}`);
  const databaseTarget = resolve(dataDir, "crossagent.db");
  mkdirSync(dirname(databaseTarget), { recursive: true });
  let recoveryCopy: string | null = null;
  if (existsSync(databaseTarget)) {
    const recoveryDir = resolve(dataDir, "backups", "pre-restore");
    mkdirSync(recoveryDir, { recursive: true });
    recoveryCopy = resolve(recoveryDir, `${basename(databaseTarget)}.${stamp()}.bak`);
    copyFileSync(databaseTarget, recoveryCopy);
  }
  for (const suffix of ["-wal", "-shm"]) {
    const sidecar = `${databaseTarget}${suffix}`;
    if (existsSync(sidecar)) rmSync(sidecar);
  }
  copyFileSync(databaseSource, databaseTarget);

  const artifactsTarget = resolve(dataDir, "artifacts");
  if (manifest.artifacts) {
    const artifactsSource = resolve(source, manifest.artifacts);
    if (!existsSync(artifactsSource)) {
      throw new Error(`Backup artifacts directory not found: ${artifactsSource}`);
    }
    if (existsSync(artifactsTarget)) {
      const recoveryArtifacts = resolve(dataDir, "backups", "pre-restore", `artifacts-${stamp()}`);
      mkdirSync(dirname(recoveryArtifacts), { recursive: true });
      cpSync(artifactsTarget, recoveryArtifacts, { recursive: true });
      rmSync(artifactsTarget, { recursive: true });
    }
    cpSync(artifactsSource, artifactsTarget, { recursive: true });
  }
  if (existsSync(pidPath)) rmSync(pidPath);
  return { source, database: databaseTarget, recoveryCopy };
}
