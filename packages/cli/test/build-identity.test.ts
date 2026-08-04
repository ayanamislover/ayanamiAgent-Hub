import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  assertExactBuildIdentity,
  assertRunningVerifiedCliEntrypoint,
  parseRuntimeBuildIdentity,
  verifyWorkspaceBuildIdentity,
} from "../src/build-identity.js";
import {
  BUILD_LOCK_RELATIVE_PATH,
  BUILD_MANIFEST_SCHEMA_VERSION,
  RELEASE_COMPONENTS,
  acquireHubRuntimeLease,
  acquireReleaseLifecycleLock,
  assertAuthorizedComponentBuild,
  assertNoLegacyManagedHub,
  formatReleaseBuildResult,
  loadCanonicalMigrationPlan,
  parseSerializedRuntimeBuildIdentity,
  releaseHubRuntimeLease,
  releaseReleaseLifecycleLock,
  serializeRuntimeBuildIdentity,
  verifiedReleaseEntrypoint,
} from "../../../scripts/build-identity.mjs";

const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function fixture(): { root: string; identity: ReturnType<typeof verifyWorkspaceBuildIdentity> } {
  const root = mkdtempSync(resolve(tmpdir(), "crossagent-build-identity-"));
  mkdirSync(resolve(root, ".crossagent-build"), { recursive: true });
  mkdirSync(resolve(root, "migrations"), { recursive: true });
  writeFileSync(resolve(root, "package.json"), '{"name":"ayanami-agent-hub"}\n');
  writeFileSync(resolve(root, "pnpm-workspace.yaml"), 'packages:\n  - "apps/*"\n');
  const files: Record<string, string> = { "migrations/0001_initial.sql": "select 1;\n" };
  for (const component of RELEASE_COMPONENTS) {
    mkdirSync(resolve(root, component.root, "dist"), { recursive: true });
    for (const entrypoint of component.entrypoints) {
      files[entrypoint] = `export const component = ${JSON.stringify(component.name)};\n`;
    }
  }
  for (const [path, contents] of Object.entries(files)) {
    writeFileSync(resolve(root, path), contents);
  }
  const artifacts = Object.keys(files)
    .filter((path) => !path.startsWith("migrations/"))
    .sort()
    .map((path) => ({ path, size: Buffer.byteLength(files[path]!), sha256: sha256(files[path]!) }));
  const migrations = [
    {
      path: "migrations/0001_initial.sql",
      size: Buffer.byteLength(files["migrations/0001_initial.sql"]!),
      sha256: sha256(files["migrations/0001_initial.sql"]!),
    },
  ];
  const components = RELEASE_COMPONENTS.map((component) => ({
    name: component.name,
    root: component.root,
    sidecar: component.sidecar,
    entrypoints: [...component.entrypoints],
  }));
  const protocolId = sha256(
    canonicalJson(artifacts.filter(({ path }) => path.startsWith("packages/protocol/"))),
  );
  const migrationsWithHash = {
    files: migrations,
    orderedSha256: sha256(
      canonicalJson([
        {
          version: 1,
          name: "0001_initial.sql",
          contentSha256: sha256(files["migrations/0001_initial.sql"]!),
        },
      ]),
    ),
  };
  const unsigned = {
    schemaVersion: BUILD_MANIFEST_SCHEMA_VERSION,
    buildSessionId: "11111111-1111-4111-8111-111111111111",
    migrationId: migrationsWithHash.orderedSha256,
    protocolId,
    components,
    artifacts,
    migrations: migrationsWithHash,
  };
  const buildId = sha256(canonicalJson(unsigned));
  const manifest = { ...unsigned, buildId, createdAt: "2026-08-01T00:00:00.000Z" };
  for (const component of components) {
    writeFileSync(
      resolve(root, component.sidecar),
      `${JSON.stringify({ schemaVersion: BUILD_MANIFEST_SCHEMA_VERSION, component: component.name, buildSessionId: unsigned.buildSessionId, buildId, migrationId: unsigned.migrationId, protocolId }, null, 2)}\n`,
    );
  }
  writeFileSync(
    resolve(root, ".crossagent-build/release-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return { root, identity: verifyWorkspaceBuildIdentity({ root }) };
}

describe("workspace build identity", () => {
  it("prints and hands off the strict exact five-field runtime identity", () => {
    const { identity } = fixture();
    const output = JSON.parse(formatReleaseBuildResult(identity)) as Record<string, unknown>;

    expect(Object.keys(output).sort()).toEqual([
      "buildId",
      "buildSessionId",
      "manifestSha256",
      "migrationId",
      "protocolId",
    ]);
    expect(output).toEqual(identity);
    expect(parseSerializedRuntimeBuildIdentity(serializeRuntimeBuildIdentity(identity))).toEqual(
      identity,
    );
    expect(() =>
      parseSerializedRuntimeBuildIdentity(
        JSON.stringify({ ...identity, untrustedExtra: "must-not-be-accepted" }),
      ),
    ).toThrow(/runtime build identity fields/i);
  });

  it("allows component builds only for the current live root BUILD lock owner", () => {
    const { root } = fixture();
    const lock = acquireReleaseLifecycleLock(root, "BUILD");
    const authorized = {
      CROSSAGENT_ROOT_BUILD_PID: String(lock.record.pid),
      CROSSAGENT_ROOT_BUILD_NONCE: lock.record.nonce,
    };
    try {
      expect(assertAuthorizedComponentBuild(root, authorized)).toEqual(lock.record);
      expect(() => assertAuthorizedComponentBuild(root, {})).toThrow(/root release builder/i);
      expect(() =>
        assertAuthorizedComponentBuild(root, {
          ...authorized,
          CROSSAGENT_ROOT_BUILD_NONCE: "22222222-2222-4222-8222-222222222222",
        }),
      ).toThrow(/BUILD lock/i);

      unlinkSync(resolve(root, BUILD_LOCK_RELATIVE_PATH));
      writeFileSync(
        resolve(root, BUILD_LOCK_RELATIVE_PATH),
        `${JSON.stringify({
          kind: "BUILD",
          pid: process.pid,
          nonce: "33333333-3333-4333-8333-333333333333",
          createdAt: "2026-08-01T00:00:01.000Z",
        })}\n`,
      );
      expect(() => assertAuthorizedComponentBuild(root, authorized)).toThrow(/BUILD lock/i);
    } finally {
      if (existsSync(resolve(root, BUILD_LOCK_RELATIVE_PATH))) {
        unlinkSync(resolve(root, BUILD_LOCK_RELATIVE_PATH));
      }
    }
  });

  it("keeps the HUB_RUNTIME boundary even with a structurally valid BUILD authorization", () => {
    const { root } = fixture();
    const runtime = acquireHubRuntimeLease(root);
    const buildRecord = {
      kind: "BUILD",
      pid: process.pid,
      nonce: "33333333-3333-4333-8333-333333333333",
      createdAt: "2026-08-01T00:00:01.000Z",
    };
    writeFileSync(resolve(root, BUILD_LOCK_RELATIVE_PATH), `${JSON.stringify(buildRecord)}\n`);
    try {
      expect(() =>
        assertAuthorizedComponentBuild(root, {
          CROSSAGENT_ROOT_BUILD_PID: String(process.pid),
          CROSSAGENT_ROOT_BUILD_NONCE: buildRecord.nonce,
        }),
      ).toThrow(/Hub is serving/i);
    } finally {
      unlinkSync(resolve(root, BUILD_LOCK_RELATIVE_PATH));
      releaseHubRuntimeLease(runtime);
    }
  });

  it("verifies a complete release from an arbitrary module path", () => {
    const { root, identity } = fixture();
    const fromNestedModule = verifyWorkspaceBuildIdentity({
      moduleUrl: new URL(`file:///${resolve(root, "apps/hub/dist/main.js").replaceAll("\\", "/")}`)
        .href,
    });

    expect(fromNestedModule).toEqual(identity);
  });

  it("rejects a half-built or mixed artifact", () => {
    const { root } = fixture();
    writeFileSync(resolve(root, "apps/hub/dist/main.js"), "export const hub = 2;\n");

    expect(() => verifyWorkspaceBuildIdentity({ root })).toThrow(/artifact.*mismatch/i);
  });

  it("rejects a sidecar from another build session", () => {
    const { root } = fixture();
    const path = resolve(root, "apps/hub/dist/.crossagent-build.json");
    const sidecar = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    writeFileSync(
      path,
      `${JSON.stringify({ ...sidecar, buildSessionId: "22222222-2222-4222-8222-222222222222" })}\n`,
    );

    expect(() => verifyWorkspaceBuildIdentity({ root })).toThrow(/sidecar.*mismatch/i);
  });

  it("rejects legacy manifest and sidecar records without migrationId", () => {
    const manifestFixture = fixture();
    const manifestPath = resolve(manifestFixture.root, ".crossagent-build/release-manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    delete manifest.migrationId;
    writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
    expect(() => verifyWorkspaceBuildIdentity({ root: manifestFixture.root })).toThrow(
      /invalid build manifest fields/i,
    );

    const sidecarFixture = fixture();
    const sidecarPath = resolve(sidecarFixture.root, "apps/hub/dist/.crossagent-build.json");
    const sidecar = JSON.parse(readFileSync(sidecarPath, "utf8")) as Record<string, unknown>;
    delete sidecar.migrationId;
    writeFileSync(sidecarPath, `${JSON.stringify(sidecar)}\n`);
    expect(() => verifyWorkspaceBuildIdentity({ root: sidecarFixture.root })).toThrow(
      /invalid component sidecar fields/i,
    );
  });

  it("requires exact local and live identities", () => {
    const { identity } = fixture();
    const legacyFourTuple = Object.fromEntries(
      Object.entries(identity).filter(([key]) => key !== "migrationId"),
    );
    expect(parseRuntimeBuildIdentity(legacyFourTuple)).toBeNull();
    expect(() =>
      assertExactBuildIdentity(identity, { ...identity, buildId: "0".repeat(64) }, "Hub"),
    ).toThrow(/Hub build identity mismatch/);
    expect(() =>
      assertExactBuildIdentity(identity, { ...identity, migrationId: "f".repeat(64) }, "Hub"),
    ).toThrow(/Hub build identity mismatch/);
  });

  it("refuses to verify while the single-root builder owns the lifecycle lock", () => {
    const { root } = fixture();
    writeFileSync(
      resolve(root, ".crossagent-build/release.lock"),
      `${JSON.stringify({
        kind: "BUILD",
        pid: process.pid,
        nonce: "33333333-3333-4333-8333-333333333333",
        createdAt: "2026-08-01T00:00:00.000Z",
      })}\n`,
    );

    expect(() => verifyWorkspaceBuildIdentity({ root })).toThrow(/build is currently in progress/i);
  });

  it("does not ignore a nested file merely because it uses the sidecar basename", () => {
    const { root } = fixture();
    mkdirSync(resolve(root, "apps/hub/dist/nested"));
    writeFileSync(resolve(root, "apps/hub/dist/nested/.crossagent-build.json"), "unhashed\n");

    expect(() => verifyWorkspaceBuildIdentity({ root })).toThrow(/artifact set mismatch/i);
  });

  it("shares numeric migration ordering and canonical SQL hashing with the executor", () => {
    const root = mkdtempSync(resolve(tmpdir(), "crossagent-migration-plan-"));
    writeFileSync(resolve(root, "10_ten.sql"), "\uFEFFselect 10;\r\n");
    writeFileSync(resolve(root, "2_two.sql"), "select 2;\n");

    const plan = loadCanonicalMigrationPlan(root);
    expect(plan.map(({ version }) => version)).toEqual([2, 10]);
    expect(plan[1]).toMatchObject({ sql: "select 10;\n", contentSha256: sha256("select 10;\n") });

    writeFileSync(resolve(root, "02_duplicate.sql"), "select 02;\n");
    expect(() => loadCanonicalMigrationPlan(root)).toThrow(/duplicate migration version 2/i);
  });

  it("does not delete a replacement lock during stale-owner recovery", () => {
    const { root } = fixture();
    const path = resolve(root, BUILD_LOCK_RELATIVE_PATH);
    const replacement = {
      kind: "RUNTIME",
      pid: process.pid,
      nonce: "44444444-4444-4444-8444-444444444444",
      createdAt: "2026-08-01T00:00:01.000Z",
    };
    writeFileSync(
      path,
      `${JSON.stringify({
        kind: "BUILD",
        pid: 2_147_483_647,
        nonce: "33333333-3333-4333-8333-333333333333",
        createdAt: "2026-08-01T00:00:00.000Z",
      })}\n`,
    );

    expect(() =>
      acquireReleaseLifecycleLock(root, "BUILD", {
        onStaleLockObserved: () => {
          unlinkSync(path);
          writeFileSync(path, `${JSON.stringify(replacement)}\n`);
        },
      }),
    ).toThrow(/busy.*RUNTIME/i);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(replacement);
  });

  it("recovers when a dead reaper crashed before moving the stale lock", () => {
    const { root } = fixture();
    const path = resolve(root, BUILD_LOCK_RELATIVE_PATH);
    const stale = {
      kind: "BUILD",
      pid: 2_147_483_647,
      nonce: "33333333-3333-4333-8333-333333333333",
      createdAt: "2026-08-01T00:00:00.000Z",
    };
    const claim = {
      kind: "REAPER",
      pid: 2_147_483_646,
      nonce: "44444444-4444-4444-8444-444444444444",
      createdAt: "2026-08-01T00:00:01.000Z",
    };
    const claimPath = `${path}.reap.${stale.nonce}`;
    writeFileSync(path, `${JSON.stringify(stale)}\n`);
    writeFileSync(claimPath, `${JSON.stringify(claim)}\n`);

    const lock = acquireReleaseLifecycleLock(root, "RUNTIME");
    try {
      expect(existsSync(claimPath)).toBe(false);
      expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ kind: "RUNTIME" });
    } finally {
      releaseReleaseLifecycleLock(lock);
    }
  });

  it("recovers when a dead reaper crashed after moving the stale lock", () => {
    const { root } = fixture();
    const path = resolve(root, BUILD_LOCK_RELATIVE_PATH);
    const stale = {
      kind: "BUILD",
      pid: 2_147_483_647,
      nonce: "33333333-3333-4333-8333-333333333333",
      createdAt: "2026-08-01T00:00:00.000Z",
    };
    const claim = {
      kind: "REAPER",
      pid: 2_147_483_646,
      nonce: "44444444-4444-4444-8444-444444444444",
      createdAt: "2026-08-01T00:00:01.000Z",
    };
    const claimPath = `${path}.reap.${stale.nonce}`;
    const tombstone = `${claimPath}.${claim.nonce}.stale`;
    writeFileSync(claimPath, `${JSON.stringify(claim)}\n`);
    writeFileSync(tombstone, `${JSON.stringify(stale)}\n`);

    const lock = acquireReleaseLifecycleLock(root, "RUNTIME");
    try {
      expect(existsSync(claimPath)).toBe(false);
      expect(existsSync(tombstone)).toBe(false);
      expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ kind: "RUNTIME" });
    } finally {
      releaseReleaseLifecycleLock(lock);
    }
  });

  it("treats EPERM process probes as a live lock owner", () => {
    const { root } = fixture();
    const path = resolve(root, BUILD_LOCK_RELATIVE_PATH);
    const owner = {
      kind: "BUILD",
      pid: 2_147_483_647,
      nonce: "33333333-3333-4333-8333-333333333333",
      createdAt: "2026-08-01T00:00:00.000Z",
    };
    writeFileSync(path, `${JSON.stringify(owner)}\n`);
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("access denied"), { code: "EPERM" });
    });
    try {
      expect(() => acquireReleaseLifecycleLock(root, "RUNTIME")).toThrow(/busy.*BUILD/i);
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(owner);
    } finally {
      kill.mockRestore();
    }
  });

  it("rejects a component dist root redirected through a directory symlink", () => {
    const { root } = fixture();
    const dist = resolve(root, "apps/hub/dist");
    const realDist = resolve(root, "apps/hub/dist-real");
    renameSync(dist, realDist);
    symlinkSync(realDist, dist, "junction");

    expect(() => verifyWorkspaceBuildIdentity({ root })).toThrow(/output directory.*unsafe/i);
  });

  it("blocks in-place builds while a Hub owns the verified workspace release", () => {
    const { root } = fixture();
    const runtimeLease = acquireHubRuntimeLease(root);
    try {
      expect(() => acquireReleaseLifecycleLock(root, "BUILD")).toThrow(/serving.*refusing/i);
    } finally {
      releaseHubRuntimeLease(runtimeLease);
    }
  });

  it("rejects live legacy managed PIDs and undeclared launch wrappers", () => {
    const { root, identity } = fixture();
    const dataDir = mkdtempSync(resolve(tmpdir(), "crossagent-live-build-"));
    writeFileSync(resolve(dataDir, "hub.pid.json"), `${JSON.stringify({ pid: process.pid })}\n`);

    expect(() => assertNoLegacyManagedHub({ CROSSAGENT_DATA_DIR: dataDir })).toThrow(
      /managed Hub process is still running/i,
    );
    expect(verifiedReleaseEntrypoint(root, "packages/cli/dist/bin.js", identity)).toBe(
      resolve(root, "packages/cli/dist/bin.js"),
    );
    expect(() => verifiedReleaseEntrypoint(root, "wrapper.js", identity)).toThrow(
      /entrypoint is not declared/i,
    );
    expect(
      assertRunningVerifiedCliEntrypoint(resolve(root, "packages/cli/dist/bin.js"), { root }),
    ).toEqual(identity);
    expect(() => assertRunningVerifiedCliEntrypoint(resolve(root, "wrapper.js"), { root })).toThrow(
      /running CLI entry is not the verified release entrypoint/i,
    );
  });
});
