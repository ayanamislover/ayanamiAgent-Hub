import { createHash } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  PUBLIC_TRUST_MANIFEST_SNAPSHOT_POLICY,
  ReleaseSnapshotCoordinator,
  ReleaseSnapshotError,
  type ReleaseSnapshotPolicy,
  type ReleaseQuiescenceAdapter,
  type ReleaseQuiescenceReceipt,
  type SqliteBackupAdapter,
  type SqliteBackupReceipt,
  type SqliteRestoreReceipt,
} from "../src/release-snapshot.js";

const identity = {
  buildId: "1".repeat(64),
  buildSessionId: "11111111-1111-4111-8111-111111111111",
  protocolId: "2".repeat(64),
  migrationId: "3".repeat(64),
  manifestSha256: "4".repeat(64),
};

const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`)
    .join(",")}}`;
}

class FakeSqliteBackup implements SqliteBackupAdapter {
  backupReceipt: SqliteBackupReceipt = {
    method: "SQLITE_BACKUP_API",
    sourceJournalMode: "WAL",
    sourceQuickCheck: "ok",
    backupQuickCheck: "ok",
  };
  restoreReceipt: SqliteRestoreReceipt = {
    method: "SQLITE_BACKUP_API",
    restoredQuickCheck: "ok",
  };
  backupCalls = 0;
  restoreCalls = 0;

  async backupOnline(sourcePath: string, destinationPath: string): Promise<SqliteBackupReceipt> {
    this.backupCalls += 1;
    await copyFile(sourcePath, destinationPath);
    return structuredClone(this.backupReceipt);
  }

  async restoreQuiesced(
    sourceBackupPath: string,
    destinationPath: string,
  ): Promise<SqliteRestoreReceipt> {
    this.restoreCalls += 1;
    await copyFile(sourceBackupPath, destinationPath);
    return structuredClone(this.restoreReceipt);
  }
}

class FakeQuiescence implements ReleaseQuiescenceAdapter {
  state: "CONFIRMED" | "REJECTED" | "AMBIGUOUS" = "CONFIRMED";
  calls = 0;

  async verifyFinalSnapshotReady(
    input: Parameters<ReleaseQuiescenceAdapter["verifyFinalSnapshotReady"]>[0],
  ): Promise<ReleaseQuiescenceReceipt> {
    this.calls += 1;
    if (this.state !== "CONFIRMED") return { state: this.state, code: "RUNTIME_NOT_STOPPED" };
    return {
      state: "CONFIRMED",
      runtimeState: "STOPPED",
      sourceIdentity: structuredClone(input.sourceIdentity),
      fenceId: input.quiescenceProof.fenceId,
      stopReceiptId: input.quiescenceProof.stopReceiptId,
      observedAt: input.quiescenceProof.observedAt,
    };
  }
}

type Fixture = {
  root: string;
  dataRoot: string;
  snapshotRoot: string;
  databasePath: string;
  pointerPath: string;
  descriptorPath: string;
  configPath: string;
  sqlite: FakeSqliteBackup;
  quiescence: FakeQuiescence;
  policy: ReleaseSnapshotPolicy;
  coordinator: ReleaseSnapshotCoordinator;
};

const roots: string[] = [];

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), "crossagent-release-snapshot-"));
  roots.push(root);
  const dataRoot = path.join(root, "data");
  const snapshotRoot = path.join(root, "snapshots");
  const databasePath = path.join(dataRoot, "db", "crossagent.db");
  const pointerPath = path.join(dataRoot, "release", "pointer.json");
  const descriptorPath = path.join(dataRoot, "release", "artifact-descriptor.json");
  const configPath = path.join(dataRoot, "config", "runtime.json");
  await mkdir(path.dirname(databasePath), { recursive: true });
  await mkdir(path.dirname(pointerPath), { recursive: true });
  await mkdir(path.dirname(configPath), { recursive: true });
  await mkdir(snapshotRoot, { recursive: true });
  await writeFile(databasePath, "database-before");
  await writeFile(pointerPath, "pointer-before");
  await writeFile(descriptorPath, "descriptor-before");
  await writeFile(configPath, "config-before");

  const sqlite = new FakeSqliteBackup();
  const quiescence = new FakeQuiescence();
  const policy: ReleaseSnapshotPolicy = {
    dataRoot,
    snapshotRoot,
    databasePath,
    releaseFiles: [
      {
        role: "RELEASE_POINTER",
        logicalName: "release/pointer.json",
        targetPath: pointerPath,
      },
      {
        role: "ARTIFACT_DESCRIPTOR",
        logicalName: "release/artifact-descriptor.json",
        targetPath: descriptorPath,
      },
    ],
    candidateOwnedConfig: [
      {
        logicalName: "config/runtime.json",
        targetPath: configPath,
      },
    ],
  };
  const coordinator = new ReleaseSnapshotCoordinator({ policy, sqlite, quiescence });
  return {
    root,
    dataRoot,
    snapshotRoot,
    databasePath,
    pointerPath,
    descriptorPath,
    configPath,
    sqlite,
    quiescence,
    policy,
    coordinator,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ReleaseSnapshotCoordinator", () => {
  it("classifies the public trust manifest as never-restorable security state", () => {
    expect(PUBLIC_TRUST_MANIFEST_SNAPSHOT_POLICY).toBe("NEVER_CAPTURE_OR_RESTORE");
  });

  it("keeps ONLINE_PREFLIGHT and FINAL_ROLLBACK snapshots non-interchangeable", async () => {
    const fixture = await createFixture();
    const preflight = await fixture.coordinator.createOnlinePreflightSnapshot({
      snapshotId: "snap_preflight",
      sourceIdentity: identity,
      createdAt: "2026-08-01T10:00:00.000Z",
    });

    expect(preflight.manifest.snapshotKind).toBe("ONLINE_PREFLIGHT");
    expect(preflight.manifest.restoreEligible).toBe(false);
    await expect(
      fixture.coordinator.restoreFinalRollbackSnapshot({
        snapshotDirectory: preflight.snapshotDirectory,
        expectedSnapshotId: "snap_preflight",
        expectedSourceIdentity: identity,
      }),
    ).rejects.toMatchObject({ code: "SNAPSHOT_KIND_NOT_RESTORABLE" });

    const final = await fixture.coordinator.createFinalRollbackSnapshot({
      snapshotId: "snap_final",
      sourceIdentity: identity,
      createdAt: "2026-08-01T10:01:00.000Z",
      quiescenceProof: {
        state: "QUIESCED",
        fenceId: "fence_release_1",
        stopReceiptId: "stop_release_1",
        observedAt: "2026-08-01T10:00:59.000Z",
      },
      expectedCandidateConfigSha256: {
        "config/runtime.json": sha256("config-candidate-after"),
      },
    });
    expect(final.manifest.snapshotKind).toBe("FINAL_ROLLBACK");
    expect(final.manifest.restoreEligible).toBe(true);
    expect(final.manifest.quiescenceProof.fenceId).toBe("fence_release_1");
    expect(fixture.sqlite.backupCalls).toBe(2);
  });

  it("restores only DB, release metadata, and candidate-owned config with per-file CAS", async () => {
    const fixture = await createFixture();
    const neverRestore = {
      vault: path.join(fixture.dataRoot, "vault", "ticket.json"),
      checkpoint: path.join(fixture.dataRoot, "checkpoint", "cursor.json"),
      spool: path.join(fixture.dataRoot, "spool", "pending.json"),
      log: path.join(fixture.dataRoot, "logs", "hub.log"),
      artifact: path.join(fixture.dataRoot, "artifacts", "hub.js"),
      pid: path.join(fixture.dataRoot, "hub.pid"),
    };
    for (const [name, targetPath] of Object.entries(neverRestore)) {
      await mkdir(path.dirname(targetPath), { recursive: true });
      await writeFile(targetPath, `${name}-before`);
    }

    const final = await fixture.coordinator.createFinalRollbackSnapshot({
      snapshotId: "snap_restore",
      sourceIdentity: identity,
      createdAt: "2026-08-01T11:00:00.000Z",
      quiescenceProof: {
        state: "QUIESCED",
        fenceId: "fence_release_2",
        stopReceiptId: "stop_release_2",
        observedAt: "2026-08-01T10:59:59.000Z",
      },
      expectedCandidateConfigSha256: {
        "config/runtime.json": sha256("config-candidate-after"),
      },
    });

    await writeFile(fixture.databasePath, "database-after");
    await writeFile(fixture.pointerPath, "pointer-after");
    await writeFile(fixture.descriptorPath, "descriptor-after");
    await writeFile(fixture.configPath, "config-candidate-after");
    for (const [name, targetPath] of Object.entries(neverRestore)) {
      await writeFile(targetPath, `${name}-after`);
    }

    const restored = await fixture.coordinator.restoreFinalRollbackSnapshot({
      snapshotDirectory: final.snapshotDirectory,
      expectedSnapshotId: "snap_restore",
      expectedSourceIdentity: identity,
    });

    expect(restored).toEqual({
      database: "RESTORED",
      releaseFiles: ["release/artifact-descriptor.json", "release/pointer.json"],
      configFiles: [{ logicalName: "config/runtime.json", state: "RESTORED" }],
    });
    expect(await readFile(fixture.databasePath, "utf8")).toBe("database-before");
    expect(await readFile(fixture.pointerPath, "utf8")).toBe("pointer-before");
    expect(await readFile(fixture.descriptorPath, "utf8")).toBe("descriptor-before");
    expect(await readFile(fixture.configPath, "utf8")).toBe("config-before");
    expect(fixture.sqlite.restoreCalls).toBe(1);
    for (const [name, targetPath] of Object.entries(neverRestore)) {
      expect(await readFile(targetPath, "utf8")).toBe(`${name}-after`);
    }

    await writeFile(fixture.configPath, "user-edited-after-candidate");
    const second = await fixture.coordinator.restoreFinalRollbackSnapshot({
      snapshotDirectory: final.snapshotDirectory,
      expectedSnapshotId: "snap_restore",
      expectedSourceIdentity: identity,
    });
    expect(second.configFiles).toEqual([
      { logicalName: "config/runtime.json", state: "SKIPPED_CAS_MISMATCH" },
    ]);
    expect(await readFile(fixture.configPath, "utf8")).toBe("user-edited-after-candidate");
  });

  it("requires a WAL-safe SQLite Backup API receipt and quick_check on both copies", async () => {
    const fixture = await createFixture();
    fixture.sqlite.backupReceipt.sourceJournalMode = "DELETE";
    await expect(
      fixture.coordinator.createOnlinePreflightSnapshot({
        snapshotId: "snap_bad_journal",
        sourceIdentity: identity,
        createdAt: "2026-08-01T12:00:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "SQLITE_BACKUP_NOT_WAL_SAFE" });

    fixture.sqlite.backupReceipt.sourceJournalMode = "WAL";
    fixture.sqlite.backupReceipt.backupQuickCheck = "database disk image is malformed";
    await expect(
      fixture.coordinator.createOnlinePreflightSnapshot({
        snapshotId: "snap_bad_check",
        sourceIdentity: identity,
        createdAt: "2026-08-01T12:01:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "SQLITE_QUICK_CHECK_FAILED" });
  });

  it("validates every content hash before restore and rejects a tampered manifest", async () => {
    const fixture = await createFixture();
    const final = await fixture.coordinator.createFinalRollbackSnapshot({
      snapshotId: "snap_tamper",
      sourceIdentity: identity,
      createdAt: "2026-08-01T13:00:00.000Z",
      quiescenceProof: {
        state: "QUIESCED",
        fenceId: "fence_release_3",
        stopReceiptId: "stop_release_3",
        observedAt: "2026-08-01T12:59:59.000Z",
      },
      expectedCandidateConfigSha256: {
        "config/runtime.json": sha256("config-candidate-after"),
      },
    });
    await writeFile(path.join(final.snapshotDirectory, "release", "pointer.json"), "tampered");
    await expect(
      fixture.coordinator.restoreFinalRollbackSnapshot({
        snapshotDirectory: final.snapshotDirectory,
        expectedSnapshotId: "snap_tamper",
        expectedSourceIdentity: identity,
      }),
    ).rejects.toMatchObject({ code: "SNAPSHOT_ARTIFACT_HASH_MISMATCH" });

    const manifestPath = path.join(final.snapshotDirectory, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.createdAt = "2099-01-01T00:00:00.000Z";
    await writeFile(manifestPath, JSON.stringify(manifest));
    await expect(
      fixture.coordinator.restoreFinalRollbackSnapshot({
        snapshotDirectory: final.snapshotDirectory,
        expectedSnapshotId: "snap_tamper",
        expectedSourceIdentity: identity,
      }),
    ).rejects.toMatchObject({ code: "SNAPSHOT_MANIFEST_HASH_MISMATCH" });
  });

  it("rejects path traversal, symlinks, non-regular sources, and secret canaries", async () => {
    const fixture = await createFixture();
    expect(
      () =>
        new ReleaseSnapshotCoordinator({
          sqlite: fixture.sqlite,
          quiescence: fixture.quiescence,
          policy: {
            ...fixture.policy,
            releaseFiles: [
              {
                role: "RELEASE_POINTER",
                logicalName: "../pointer.json",
                targetPath: fixture.pointerPath,
              },
              fixture.policy.releaseFiles[1]!,
            ],
          },
        }),
    ).toThrowError(expect.objectContaining({ code: "RESTORE_POLICY_INVALID" }));

    const symlinkTarget = path.join(fixture.dataRoot, "release", "real-pointer.json");
    await writeFile(symlinkTarget, "real-pointer");
    await rm(fixture.pointerPath);
    await symlink(symlinkTarget, fixture.pointerPath, "file");
    await expect(
      fixture.coordinator.createOnlinePreflightSnapshot({
        snapshotId: "snap_symlink",
        sourceIdentity: identity,
        createdAt: "2026-08-01T14:00:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "SOURCE_NOT_REGULAR" });

    await rm(fixture.pointerPath);
    await mkdir(fixture.pointerPath);
    await expect(
      fixture.coordinator.createOnlinePreflightSnapshot({
        snapshotId: "snap_directory",
        sourceIdentity: identity,
        createdAt: "2026-08-01T14:01:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "SOURCE_NOT_REGULAR" });

    await rm(fixture.pointerPath, { recursive: true });
    await writeFile(fixture.pointerPath, "token-canary-do-not-persist");
    await expect(
      fixture.coordinator.createOnlinePreflightSnapshot({
        snapshotId: "snap_secret",
        sourceIdentity: identity,
        createdAt: "2026-08-01T14:02:00.000Z",
        secretCanaries: ["token-canary-do-not-persist"],
      }),
    ).rejects.toMatchObject({ code: "SECRET_CANARY_DETECTED" });
  });

  it("publishes an owner-private, fully materialized manifest with no staging residue", async () => {
    const fixture = await createFixture();
    const final = await fixture.coordinator.createFinalRollbackSnapshot({
      snapshotId: "snap_private",
      sourceIdentity: identity,
      createdAt: "2026-08-01T15:00:00.000Z",
      quiescenceProof: {
        state: "QUIESCED",
        fenceId: "fence_release_4",
        stopReceiptId: "stop_release_4",
        observedAt: "2026-08-01T14:59:59.000Z",
      },
      expectedCandidateConfigSha256: {
        "config/runtime.json": sha256("config-candidate-after"),
      },
    });
    const manifestPath = path.join(final.snapshotDirectory, "manifest.json");
    expect((await lstat(manifestPath)).isFile()).toBe(true);
    expect((await stat(final.snapshotDirectory)).isDirectory()).toBe(true);
    expect(await readFile(manifestPath, "utf8")).not.toContain("token-canary");
    expect(await readFile(fixture.snapshotRoot, "utf8").catch(() => "directory")).toBe("directory");
    expect((await lstat(final.snapshotDirectory)).isSymbolicLink()).toBe(false);
    if (process.platform !== "win32") {
      expect((await stat(final.snapshotDirectory)).mode & 0o077).toBe(0);
      expect((await stat(manifestPath)).mode & 0o077).toBe(0);
    }
    const children = await import("node:fs/promises").then(({ readdir }) =>
      readdir(fixture.snapshotRoot),
    );
    expect(children).toEqual(["snap_private"]);
  });

  it("fails closed when a final restore quick_check fails", async () => {
    const fixture = await createFixture();
    const final = await fixture.coordinator.createFinalRollbackSnapshot({
      snapshotId: "snap_restore_check",
      sourceIdentity: identity,
      createdAt: "2026-08-01T16:00:00.000Z",
      quiescenceProof: {
        state: "QUIESCED",
        fenceId: "fence_release_5",
        stopReceiptId: "stop_release_5",
        observedAt: "2026-08-01T15:59:59.000Z",
      },
      expectedCandidateConfigSha256: {
        "config/runtime.json": sha256("config-candidate-after"),
      },
    });
    fixture.sqlite.restoreReceipt.restoredQuickCheck = "malformed";
    await expect(
      fixture.coordinator.restoreFinalRollbackSnapshot({
        snapshotDirectory: final.snapshotDirectory,
        expectedSnapshotId: "snap_restore_check",
        expectedSourceIdentity: identity,
      }),
    ).rejects.toBeInstanceOf(ReleaseSnapshotError);
    await expect(
      fixture.coordinator.restoreFinalRollbackSnapshot({
        snapshotDirectory: final.snapshotDirectory,
        expectedSnapshotId: "snap_restore_check",
        expectedSourceIdentity: identity,
      }),
    ).rejects.toMatchObject({ code: "SQLITE_RESTORE_QUICK_CHECK_FAILED" });
  });

  it("does not start a final Backup API snapshot until quiescence and stop are confirmed", async () => {
    const fixture = await createFixture();
    fixture.quiescence.state = "AMBIGUOUS";
    await expect(
      fixture.coordinator.createFinalRollbackSnapshot({
        snapshotId: "snap_not_stopped",
        sourceIdentity: identity,
        createdAt: "2026-08-01T17:00:00.000Z",
        quiescenceProof: {
          state: "QUIESCED",
          fenceId: "fence_release_6",
          stopReceiptId: "stop_release_6",
          observedAt: "2026-08-01T16:59:59.000Z",
        },
        expectedCandidateConfigSha256: {
          "config/runtime.json": sha256("config-candidate-after"),
        },
      }),
    ).rejects.toMatchObject({ code: "QUIESCENCE_NOT_CONFIRMED" });
    expect(fixture.quiescence.calls).toBe(1);
    expect(fixture.sqlite.backupCalls).toBe(0);
  });

  it.each([
    ["token", ["config", "..", "ToKeN"]],
    ["dashboard token", ["security", "DASHBOARD-TOKEN"]],
    ["Codex agent token", ["nested", "agent-codex-token"]],
    ["Claude agent token", ["nested", "AGENT-CLAUDE-TOKEN"]],
    ["Codex capture token", ["nested", "capture-codex-token"]],
    ["Claude capture token", ["nested", "capture-claude-token"]],
    ["Codex injector token", ["nested", "inject-codex-token"]],
    ["Claude injector token", ["nested", "INJECT-CLAUDE-TOKEN"]],
    ["Authority private key", ["AUTHORITY", "ED25519-PRIVATE-KEY.PEM"]],
    ["credential rotation journal", ["security", "credential-rotation-journal.jsonl"]],
    ["security rotation journal", ["runtime", "security_rotation_journal.json"]],
    ["security epoch", ["config", "security-epoch-42.json"]],
    ["security epoch directory", ["security", "epochs", "42.json"]],
    ["public Authority trust manifest", ["authority", "trusted-signing-keys.json"]],
  ])(
    "hard-denies %s by canonical target path even with opaque random content",
    async (_, parts) => {
      const fixture = await createFixture();
      const targetPath = path.resolve(fixture.dataRoot, ...parts);
      await mkdir(path.dirname(targetPath), { recursive: true });
      await writeFile(targetPath, "g7R9wV3qL8mN2xK5pT6bD4cF1hJ0sZ8y");

      expect(
        () =>
          new ReleaseSnapshotCoordinator({
            sqlite: fixture.sqlite,
            quiescence: fixture.quiescence,
            policy: {
              ...fixture.policy,
              candidateOwnedConfig: [
                {
                  logicalName: "config/benign-looking.json",
                  targetPath,
                },
              ],
            },
          }),
      ).toThrowError(expect.objectContaining({ code: "SENSITIVE_SECURITY_STATE_PATH" }));
    },
  );

  it("resolves a symlink alias before capture and hard-denies the credential target", async () => {
    const fixture = await createFixture();
    const credentialPath = path.join(fixture.dataRoot, "token");
    const aliasPath = path.join(fixture.dataRoot, "config", "benign-looking.json");
    await writeFile(credentialPath, "m4Q7yP8rS2nV6cK9xD3bF5hJ1wZ0tL8g");
    await rm(aliasPath, { force: true });
    await symlink(credentialPath, aliasPath, "file");
    const coordinator = new ReleaseSnapshotCoordinator({
      sqlite: fixture.sqlite,
      quiescence: fixture.quiescence,
      policy: {
        ...fixture.policy,
        candidateOwnedConfig: [
          {
            logicalName: "config/benign-looking.json",
            targetPath: aliasPath,
          },
        ],
      },
    });

    await expect(
      coordinator.createFinalRollbackSnapshot({
        snapshotId: "snap_credential_alias",
        sourceIdentity: identity,
        createdAt: "2026-08-01T18:00:00.000Z",
        quiescenceProof: {
          state: "QUIESCED",
          fenceId: "fence_release_7",
          stopReceiptId: "stop_release_7",
          observedAt: "2026-08-01T17:59:59.000Z",
        },
        expectedCandidateConfigSha256: {
          "config/benign-looking.json": sha256("candidate-after-value"),
        },
      }),
    ).rejects.toMatchObject({ code: "SENSITIVE_SECURITY_STATE_PATH" });
    expect(fixture.sqlite.backupCalls).toBe(0);
  });

  it("hard-denies a rehashed security-epoch artifact during restore before DB mutation", async () => {
    const fixture = await createFixture();
    const final = await fixture.coordinator.createFinalRollbackSnapshot({
      snapshotId: "snap_restore_security_epoch",
      sourceIdentity: identity,
      createdAt: "2026-08-01T19:00:00.000Z",
      quiescenceProof: {
        state: "QUIESCED",
        fenceId: "fence_release_8",
        stopReceiptId: "stop_release_8",
        observedAt: "2026-08-01T18:59:59.000Z",
      },
      expectedCandidateConfigSha256: {
        "config/runtime.json": sha256("config-candidate-after"),
      },
    });
    const oldArtifactPath = path.join(final.snapshotDirectory, "config", "runtime.json");
    const sensitiveArtifactPath = path.join(
      final.snapshotDirectory,
      "config",
      "security-epoch-9.json",
    );
    await rename(oldArtifactPath, sensitiveArtifactPath);
    const manifestPath = path.join(final.snapshotDirectory, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    const configFiles = manifest.configFiles as Array<Record<string, unknown>>;
    configFiles[0]!.logicalName = "config/security-epoch-9.json";
    configFiles[0]!.relativePath = "config/security-epoch-9.json";
    delete manifest.manifestSha256;
    manifest.manifestSha256 = sha256(canonicalize(manifest));
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    await expect(
      fixture.coordinator.restoreFinalRollbackSnapshot({
        snapshotDirectory: final.snapshotDirectory,
        expectedSnapshotId: "snap_restore_security_epoch",
        expectedSourceIdentity: identity,
      }),
    ).rejects.toMatchObject({ code: "SENSITIVE_SECURITY_STATE_PATH" });
    expect(fixture.sqlite.restoreCalls).toBe(0);
    expect(await readFile(fixture.databasePath, "utf8")).toBe("database-before");
  });

  it("re-resolves restore targets and rejects a post-capture credential symlink swap", async () => {
    const fixture = await createFixture();
    const final = await fixture.coordinator.createFinalRollbackSnapshot({
      snapshotId: "snap_restore_alias_swap",
      sourceIdentity: identity,
      createdAt: "2026-08-01T20:00:00.000Z",
      quiescenceProof: {
        state: "QUIESCED",
        fenceId: "fence_release_9",
        stopReceiptId: "stop_release_9",
        observedAt: "2026-08-01T19:59:59.000Z",
      },
      expectedCandidateConfigSha256: {
        "config/runtime.json": sha256("config-candidate-after"),
      },
    });
    const credentialPath = path.join(fixture.dataRoot, "token");
    await writeFile(credentialPath, "n7L4bZ9cD2fH6jK1mP8qR3sT5vW0xY6a");
    await rm(fixture.configPath);
    await symlink(credentialPath, fixture.configPath, "file");

    await expect(
      fixture.coordinator.restoreFinalRollbackSnapshot({
        snapshotDirectory: final.snapshotDirectory,
        expectedSnapshotId: "snap_restore_alias_swap",
        expectedSourceIdentity: identity,
      }),
    ).rejects.toMatchObject({ code: "SENSITIVE_SECURITY_STATE_PATH" });
    expect(fixture.sqlite.restoreCalls).toBe(0);
    expect(await readFile(fixture.databasePath, "utf8")).toBe("database-before");
  });
});
