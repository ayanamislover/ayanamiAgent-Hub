import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { createHubServer } from "../src/server.js";
import {
  createTestBuildIdentity,
  createTestVerifiedHubRelease,
  verifyHubBuildIdentity,
  verifyHubRuntimeRelease,
} from "../src/runtime/build-identity.js";
import { createHubServer as createTestHubServer } from "./test-server.js";
import {
  RELEASE_COMPONENTS,
  BUILD_MANIFEST_SCHEMA_VERSION,
  acquireReleaseLifecycleLock,
  findWorkspaceRoot,
  releaseReleaseLifecycleLock,
} from "../../../scripts/build-identity.mjs";

const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

function releaseFixture(): string {
  const root = mkdtempSync(resolve(tmpdir(), "crossagent-hub-build-"));
  mkdirSync(resolve(root, ".crossagent-build"), { recursive: true });
  mkdirSync(resolve(root, "migrations"), { recursive: true });
  writeFileSync(resolve(root, "package.json"), '{"name":"ayanami-agent-hub"}\n');
  writeFileSync(resolve(root, "pnpm-workspace.yaml"), "packages: []\n");
  const migration = "select 1;\n";
  writeFileSync(resolve(root, "migrations/0001_initial.sql"), migration);
  const artifactContents = new Map<string, string>();
  for (const component of RELEASE_COMPONENTS) {
    mkdirSync(resolve(root, component.root, "dist"), { recursive: true });
    for (const entrypoint of component.entrypoints) {
      const contents = `export const component = ${JSON.stringify(component.name)};\n`;
      artifactContents.set(entrypoint, contents);
      writeFileSync(resolve(root, entrypoint), contents);
    }
  }
  const artifacts = [...artifactContents]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, contents]) => ({
      path,
      size: Buffer.byteLength(contents),
      sha256: sha256(contents),
    }));
  const migrations = [
    {
      path: "migrations/0001_initial.sql",
      size: Buffer.byteLength(migration),
      sha256: sha256(migration),
    },
  ];
  const components = RELEASE_COMPONENTS.map((component) => ({
    name: component.name,
    root: component.root,
    sidecar: component.sidecar,
    entrypoints: [...component.entrypoints],
  }));
  const migrationId = sha256(
    canonicalJson([
      {
        version: 1,
        name: "0001_initial.sql",
        contentSha256: sha256(migration),
      },
    ]),
  );
  const unsigned = {
    schemaVersion: BUILD_MANIFEST_SCHEMA_VERSION,
    buildSessionId: "11111111-1111-4111-8111-111111111111",
    migrationId,
    protocolId: sha256(
      canonicalJson(artifacts.filter(({ path }) => path.startsWith("packages/protocol/dist/"))),
    ),
    components,
    artifacts,
    migrations: {
      files: migrations,
      orderedSha256: migrationId,
    },
  };
  const buildId = sha256(canonicalJson(unsigned));
  for (const component of components) {
    writeFileSync(
      resolve(root, component.sidecar),
      `${JSON.stringify({ schemaVersion: BUILD_MANIFEST_SCHEMA_VERSION, component: component.name, buildSessionId: unsigned.buildSessionId, buildId, migrationId: unsigned.migrationId, protocolId: unsigned.protocolId })}\n`,
    );
  }
  writeFileSync(
    resolve(root, ".crossagent-build/release-manifest.json"),
    `${JSON.stringify({ ...unsigned, buildId, createdAt: "2026-08-01T00:00:00.000Z" }, null, 2)}\n`,
  );
  return root;
}

describe("Hub build identity", () => {
  it("fails closed before runtime setup when the expected build differs", () => {
    const root = releaseFixture();
    expect(() => verifyHubBuildIdentity({ root, expectedBuildId: "0".repeat(64) })).toThrow(
      /expected build identity/i,
    );
  });

  it("binds migrations and dashboard to the same verified workspace root", () => {
    const root = releaseFixture();
    const verified = verifyHubRuntimeRelease({ root });

    expect(verified.migrationsDir).toBe(resolve(root, "migrations"));
    expect(verified.dashboardDir).toBe(resolve(root, "apps/dashboard/dist"));
    expect(verified.workspaceRoot).toBe(root);
  });

  it("pins the full expected five-field identity, including manifest bytes", () => {
    const root = releaseFixture();
    const expected = verifyHubRuntimeRelease({ root }).buildIdentity;
    const manifestPath = resolve(root, ".crossagent-build/release-manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    writeFileSync(
      manifestPath,
      `${JSON.stringify({ ...manifest, createdAt: "2026-08-01T00:00:01.000Z" }, null, 2)}\n`,
    );

    expect(() => verifyHubRuntimeRelease({ root, expectedBuildIdentity: expected })).toThrow(
      /expected runtime build identity mismatch/i,
    );
    const actual = verifyHubRuntimeRelease({ root }).buildIdentity;
    expect(actual.buildId).toBe(expected.buildId);
    expect(actual.manifestSha256).not.toBe(expected.manifestSha256);
    for (const field of ["protocolId", "migrationId", "buildSessionId"] as const) {
      expect(() =>
        verifyHubRuntimeRelease({
          root,
          expectedBuildIdentity: {
            ...actual,
            [field]:
              field === "buildSessionId" ? "22222222-2222-4222-8222-222222222222" : "f".repeat(64),
          },
        }),
      ).toThrow(/expected runtime build identity mismatch/i);
    }
  });

  it("does not let NODE_ENV or structurally forged release data open SQLite", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "crossagent-unverified-server-"));
    const databasePath = resolve(root, "must-not-exist.db");
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "test";
    try {
      await expect(
        createHubServer({ databasePath, dataDir: resolve(root, "data"), port: 0 }),
      ).rejects.toThrow(/verified runtime release capability/i);
      const identity = createTestBuildIdentity("structural-forgery");
      await expect(
        createHubServer(
          { databasePath, dataDir: resolve(root, "data"), port: 0 },
          {
            verifiedRelease: {
              buildIdentity: identity,
              workspaceRoot: root,
              migrationsDir: resolve(root, "migrations"),
              dashboardDir: resolve(root, "dashboard"),
            },
          },
        ),
      ).rejects.toThrow(/verified runtime release capability/i);
      expect(existsSync(databasePath)).toBe(false);
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
    }
  });

  it("keeps raw construction and test identity helpers out of the public Hub interface", async () => {
    const publicHub = await import("../src/index.js");
    expect(publicHub).not.toHaveProperty("createHubServer");
    expect(publicHub).not.toHaveProperty("createTestBuildIdentity");
  });

  it("never writes query credentials through Fastify default request logging", () => {
    const workspaceRoot = findWorkspaceRoot(import.meta.url);
    const tsxLoader = pathToFileURL(
      resolve(workspaceRoot, "node_modules/tsx/dist/loader.mjs"),
    ).href;
    const testServerUrl = pathToFileURL(resolve(import.meta.dirname, "test-server.ts")).href;
    const canary = "QUERY_ACCESS_TOKEN_CANARY_7f09f4";
    const script = `
      import { mkdtempSync } from "node:fs";
      import { tmpdir } from "node:os";
      import { resolve } from "node:path";
      const { createHubServer } = await import(${JSON.stringify(testServerUrl)});
      const root = mkdtempSync(resolve(tmpdir(), "crossagent-log-canary-"));
      const server = await createHubServer({
        dataDir: root,
        databasePath: resolve(root, "hub.db"),
        dashboardDir: resolve(root, "missing-dashboard"),
        logLevel: "info",
        port: 0,
      });
      await server.app.inject({ method: "GET", url: "/api/health?access_token=${canary}" });
      await server.close();
    `;
    const result = spawnSync(
      process.execPath,
      ["--import", tsxLoader, "--input-type=module", "--eval", script],
      { cwd: workspaceRoot, encoding: "utf8", timeout: 20_000, windowsHide: true },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(`${result.stdout}${result.stderr}`).not.toContain(canary);
  });

  it("rejects a mixed migration identity before opening the database", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "crossagent-mixed-migration-"));
    const databasePath = resolve(root, "must-not-exist.db");
    const identity = createTestBuildIdentity("mixed-migration");
    await expect(
      createHubServer(
        { databasePath, dataDir: resolve(root, "data"), port: 0 },
        {
          verifiedRelease: {
            buildIdentity: { ...identity, migrationId: "f".repeat(64) },
            workspaceRoot: root,
            migrationsDir: resolve(root, "migrations"),
            dashboardDir: resolve(root, "dashboard"),
          },
        },
      ),
    ).rejects.toThrow(/verified runtime release capability/i);
    expect(existsSync(databasePath)).toBe(false);
  });

  it("serves only the dashboard path carried by the verified release", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "crossagent-runtime-assets-"));
    const verifiedDashboard = resolve(root, "verified-dashboard");
    const unverifiedDashboard = resolve(root, "unverified-dashboard");
    mkdirSync(verifiedDashboard);
    mkdirSync(unverifiedDashboard);
    writeFileSync(resolve(verifiedDashboard, "index.html"), "verified-release-dashboard");
    writeFileSync(resolve(unverifiedDashboard, "index.html"), "unverified-dashboard");
    const identity = createTestBuildIdentity("runtime-assets");
    const server = await createHubServer(
      {
        databasePath: resolve(root, "hub.db"),
        dataDir: resolve(root, "data"),
        dashboardDir: unverifiedDashboard,
        port: 0,
      },
      {
        verifiedRelease: createTestVerifiedHubRelease({
          buildIdentity: identity,
          workspaceRoot: resolve(dirname(fileURLToPath(import.meta.url)), "../../.."),
          migrationsDir: resolve(dirname(fileURLToPath(import.meta.url)), "../../../migrations"),
          dashboardDir: verifiedDashboard,
        }),
      },
    );
    try {
      expect(server.config.dashboardDir).toBe(verifiedDashboard);
      const response = await server.app.inject({ method: "GET", url: "/" });
      expect(response.body).toContain("verified-release-dashboard");
      expect(response.body).not.toContain("unverified-dashboard");
    } finally {
      await server.close();
    }
  });

  it("runs the real main preflight before creating DB or credential state", (context) => {
    const dataDir = mkdtempSync(resolve(tmpdir(), "crossagent-main-preflight-"));
    const databasePath = resolve(dataDir, "must-not-exist.db");
    const main = resolve(dirname(fileURLToPath(import.meta.url)), "../src/main.ts");
    const workspaceRoot = findWorkspaceRoot(import.meta.url);
    const tsxLoader = pathToFileURL(
      resolve(workspaceRoot, "node_modules/tsx/dist/loader.mjs"),
    ).href;
    let buildLock: ReturnType<typeof acquireReleaseLifecycleLock>;
    try {
      buildLock = acquireReleaseLifecycleLock(workspaceRoot, "BUILD");
    } catch (error) {
      // A live Hub is refused a BUILD lock on purpose -- that is the in-place build protection
      // working, not a failure of this assertion. With one running there is no way to observe the
      // preflight ordering this test exists to pin, so skip rather than report a green that
      // checked nothing or a red that means the developer simply has a Hub up.
      if (error instanceof Error && /Hub is serving this workspace release/u.test(error.message)) {
        context.skip("a Hub is serving this workspace; stop it to run this test");
        return;
      }
      throw error;
    }
    try {
      const result = spawnSync(process.execPath, ["--import", tsxLoader, main], {
        cwd: resolve(dataDir),
        env: {
          ...process.env,
          CROSSAGENT_DATA_DIR: dataDir,
          CROSSAGENT_DATABASE: databasePath,
          CROSSAGENT_PORT: "0",
        },
        encoding: "utf8",
        timeout: 20_000,
        windowsHide: true,
      });

      expect(result.status).not.toBe(0);
      expect(`${result.stderr}${result.stdout}`).toContain(
        "Build is currently in progress; refusing to use a partial release",
      );
      expect(existsSync(databasePath)).toBe(false);
      expect(existsSync(resolve(dataDir, "token"))).toBe(false);
      expect(existsSync(resolve(dataDir, "dashboard-token"))).toBe(false);
    } finally {
      releaseReleaseLifecycleLock(buildLock);
    }
  });

  it("exposes a frozen runtime identity in health", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "crossagent-hub-health-"));
    const identity = createTestBuildIdentity("health-frozen");
    const server = await createTestHubServer(
      { databasePath: resolve(root, "hub.db"), dataDir: resolve(root, "data"), port: 0 },
      { buildIdentity: identity },
    );
    try {
      const first = await server.app.inject({ method: "GET", url: "/api/health" });
      expect(first.json().build).toEqual(identity);
      expect(first.headers["x-crossagent-build-id"]).toBe(identity.buildId);
      expect(Object.isFrozen(server.buildIdentity)).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("authenticates an exact instance-bound shutdown and replays one ACK", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "crossagent-hub-shutdown-"));
    const identity = createTestBuildIdentity("shutdown");
    const server = await createTestHubServer(
      {
        databasePath: resolve(root, "hub.db"),
        dataDir: resolve(root, "data"),
        dashboardDir: resolve(root, "missing-dashboard"),
        port: 0,
      },
      { buildIdentity: identity },
    );
    const idempotencyKey = "33333333-3333-4333-8333-333333333333";
    const body = {
      instanceId: server.instanceId,
      build: identity,
      idempotencyKey,
    };
    const inject = async (token: string, payload: Record<string, unknown> = body) =>
      await server.app.inject({
        method: "POST",
        url: "/api/runtime/shutdown",
        headers: { authorization: `Bearer ${token}` },
        payload,
      });
    try {
      const wrongCredential = await inject(server.credentials.agent.token);
      expect(wrongCredential.statusCode).toBe(403);
      const wrongInstance = await inject(server.credentials.dashboard.token, {
        ...body,
        instanceId: "f".repeat(32),
      });
      expect(wrongInstance.statusCode).toBe(409);
      const wrongBuild = await inject(server.credentials.dashboard.token, {
        ...body,
        build: { ...identity, buildId: "f".repeat(64) },
      });
      expect(wrongBuild.statusCode).toBe(409);
      const wrongMigration = await inject(server.credentials.dashboard.token, {
        ...body,
        build: { ...identity, migrationId: "f".repeat(64) },
      });
      expect(wrongMigration.statusCode).toBe(409);

      const accepted = await inject(server.credentials.dashboard.token);
      const replay = await inject(server.credentials.dashboard.token);
      expect(accepted.statusCode).toBe(202);
      expect(replay.statusCode).toBe(202);
      expect(replay.json()).toEqual(accepted.json());
      await expect(server.shutdownRequested).resolves.toMatchObject({ idempotencyKey });

      const conflict = await inject(server.credentials.dashboard.token, {
        ...body,
        idempotencyKey: "44444444-4444-4444-8444-444444444444",
      });
      expect(conflict.statusCode).toBe(409);
      expect(JSON.stringify(accepted.json())).not.toContain(server.credentials.dashboard.token);
    } finally {
      await server.close();
    }
  });
});
