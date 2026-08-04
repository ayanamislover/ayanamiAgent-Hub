import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { migrate } from "../src/db/database.js";
import { initializeCredentialRegistry } from "../src/security/local-auth.js";

const roots: string[] = [];
const repositoryMigrations = fileURLToPath(new URL("../../../migrations", import.meta.url));
const legacyMigrationNames = [
  "0001_initial.sql",
  "0002_authorization_grants.sql",
  "0003_model_presets.sql",
  "0004_model_preset_effort_args.sql",
  "0005_session_surface_fences.sql",
  "0006_live_session_fences.sql",
  "0007_authority_principals_user_turns.sql",
  "0008_authority_directives_attestations.sql",
  "0009_session_bound_tickets.sql",
] as const;

type CredentialFixture = {
  credentialId: string;
  principalId: string;
  principalKind: string;
  clientType: "codex" | "claude" | null;
  legacyScopes: string;
  currentScopes: string;
};

const credentialFixtures: CredentialFixture[] = [
  {
    credentialId: "crd_local_agent",
    principalId: "prn_local_agent",
    principalKind: "AGENT",
    clientType: null,
    legacyScopes: '["hub:agent"]',
    currentScopes: '["project:select"]',
  },
  {
    credentialId: "crd_agent_codex",
    principalId: "prn_agent_codex",
    principalKind: "AGENT",
    clientType: "codex",
    legacyScopes: '["directive:relay","hub:agent"]',
    currentScopes:
      '["project:join","project:select","session-ticket:offer","session:enroll:first"]',
  },
  {
    credentialId: "crd_agent_claude",
    principalId: "prn_agent_claude",
    principalKind: "AGENT",
    clientType: "claude",
    legacyScopes: '["directive:relay","hub:agent"]',
    currentScopes:
      '["project:join","project:select","session-ticket:offer","session:enroll:first"]',
  },
  {
    credentialId: "crd_capture_codex",
    principalId: "prn_capture_codex",
    principalKind: "BRIDGE_CAPTURE",
    clientType: "codex",
    legacyScopes: '["user_turn:capture"]',
    currentScopes: '["session-ticket:offer:capture"]',
  },
  {
    credentialId: "crd_capture_claude",
    principalId: "prn_capture_claude",
    principalKind: "BRIDGE_CAPTURE",
    clientType: "claude",
    legacyScopes: '["user_turn:capture"]',
    currentScopes: '["session-ticket:offer:capture"]',
  },
  {
    credentialId: "crd_inject_codex",
    principalId: "prn_inject_codex",
    principalKind: "BRIDGE_INJECTOR",
    clientType: "codex",
    legacyScopes: '["synthetic_prompt:reserve"]',
    currentScopes: '["session-ticket:offer:injector"]',
  },
  {
    credentialId: "crd_inject_claude",
    principalId: "prn_inject_claude",
    principalKind: "BRIDGE_INJECTOR",
    clientType: "claude",
    legacyScopes: '["synthetic_prompt:reserve"]',
    currentScopes: '["session-ticket:offer:injector"]',
  },
];

const restrictedCredentialTriggerSql = `
  CREATE TRIGGER auth_credentials_restricted_update
  BEFORE UPDATE ON auth_credentials
  WHEN NOT (
    OLD.principal_id = NEW.principal_id AND OLD.token_sha256 = NEW.token_sha256
    AND OLD.scopes_json = NEW.scopes_json AND OLD.expires_at IS NEW.expires_at
    AND OLD.created_at = NEW.created_at AND OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL
  )
  BEGIN
    SELECT RAISE(ABORT, 'auth credentials are immutable except for revocation');
  END;
`;

function legacyDatabase(): Database.Database {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
    CREATE TABLE auth_principals (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      display_name TEXT NOT NULL,
      project_id TEXT,
      client_type TEXT,
      session_id TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE auth_credentials (
      id TEXT PRIMARY KEY,
      principal_id TEXT NOT NULL REFERENCES auth_principals(id),
      token_sha256 TEXT NOT NULL UNIQUE,
      scopes_json TEXT NOT NULL CHECK(json_valid(scopes_json)),
      expires_at TEXT,
      revoked_at TEXT,
      created_at TEXT NOT NULL
    );
  `);
  sqlite.exec(restrictedCredentialTriggerSql);
  const insertPrincipal = sqlite.prepare(
    `INSERT INTO auth_principals(
       id, kind, display_name, project_id, client_type, session_id, status, created_at, updated_at
     ) VALUES (?, ?, ?, NULL, ?, NULL, 'ACTIVE', ?, ?)`,
  );
  const insertCredential = sqlite.prepare(
    `INSERT INTO auth_credentials(
       id, principal_id, token_sha256, scopes_json, expires_at, revoked_at, created_at
     ) VALUES (?, ?, ?, ?, NULL, NULL, ?)`,
  );
  const now = "2026-08-01T00:00:00.000Z";
  credentialFixtures.forEach((fixture, index) => {
    insertPrincipal.run(
      fixture.principalId,
      fixture.principalKind,
      fixture.principalId,
      fixture.clientType,
      now,
      now,
    );
    insertCredential.run(
      fixture.credentialId,
      fixture.principalId,
      index.toString(16).padStart(64, "0"),
      fixture.legacyScopes,
      now,
    );
  });
  return sqlite;
}

function legacyMigrationDirectory(): string {
  const root = mkdtempSync(resolve(tmpdir(), "crossagent-static-scope-recovery-"));
  roots.push(root);
  for (const name of legacyMigrationNames) {
    writeFileSync(resolve(root, name), "SELECT 1;\n", "utf8");
  }
  writeFileSync(
    resolve(root, "0010_static_credential_scope_correction.sql"),
    readFileSync(
      resolve(repositoryMigrations, "0010_static_credential_scope_correction.sql"),
      "utf8",
    ),
    "utf8",
  );
  vi.stubEnv("CROSSAGENT_MIGRATIONS_DIR", root);
  return root;
}

function markLegacyMigrationsApplied(sqlite: Database.Database): void {
  const insert = sqlite.prepare(
    "INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)",
  );
  for (const [index, name] of legacyMigrationNames.entries()) {
    const version = index + 1;
    insert.run(version, name, "2026-08-01T00:00:00.000Z");
  }
}

function mutateCredential(sqlite: Database.Database, sql: string): void {
  sqlite.exec("DROP TRIGGER auth_credentials_restricted_update");
  sqlite.exec(sql);
  sqlite.exec(restrictedCredentialTriggerSql);
}

function protectedStaticState(sqlite: Database.Database): {
  credentials: unknown[];
  principals: unknown[];
  restrictedTrigger: string;
} {
  return {
    credentials: sqlite.prepare("SELECT * FROM auth_credentials ORDER BY id").all(),
    principals: sqlite.prepare("SELECT * FROM auth_principals ORDER BY id").all(),
    restrictedTrigger: sqlite
      .prepare(
        `SELECT sql FROM sqlite_master
         WHERE type = 'trigger' AND name = 'auth_credentials_restricted_update'`,
      )
      .pluck()
      .get() as string,
  };
}

async function expectStaticGuardFailure(
  sqlite: Database.Database,
  mutate: (database: Database.Database) => void,
): Promise<void> {
  mutate(sqlite);
  const before = protectedStaticState(sqlite);

  await expect(migrate(sqlite)).rejects.toThrow(/unexpected static credential identity or scope/i);

  expect(protectedStaticState(sqlite)).toEqual(before);
  expect(
    sqlite.prepare("SELECT 1 FROM schema_migrations WHERE version = 10").pluck().get(),
  ).toBeUndefined();
  expect(
    sqlite
      .prepare(
        `SELECT COUNT(*) FROM sqlite_master
         WHERE name LIKE 'migration_0010_static_credential_guard%'`,
      )
      .pluck()
      .get(),
  ).toBe(0);
}

afterEach(() => {
  vi.unstubAllEnvs();
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("static credential scope recovery", () => {
  it("corrects known pre-ticket scopes after migration 9 was legacy-baselined", async () => {
    legacyMigrationDirectory();
    const sqlite = legacyDatabase();
    markLegacyMigrationsApplied(sqlite);
    const before = sqlite
      .prepare(
        `SELECT id, principal_id, token_sha256, expires_at, revoked_at, created_at
         FROM auth_credentials ORDER BY id`,
      )
      .all();

    await migrate(sqlite);

    const scopes = new Map(
      (
        sqlite.prepare("SELECT id, scopes_json FROM auth_credentials").all() as Array<{
          id: string;
          scopes_json: string;
        }>
      ).map((row) => [row.id, row.scopes_json]),
    );
    for (const fixture of credentialFixtures) {
      expect(scopes.get(fixture.credentialId)).toBe(fixture.currentScopes);
    }
    expect(
      sqlite
        .prepare(
          `SELECT id, principal_id, token_sha256, expires_at, revoked_at, created_at
           FROM auth_credentials ORDER BY id`,
        )
        .all(),
    ).toEqual(before);
    expect(
      sqlite.prepare("SELECT hash_origin FROM schema_migrations WHERE version = 9").pluck().get(),
    ).toBe("LEGACY_BASELINE_UNVERIFIED");
    expect(
      sqlite.prepare("SELECT hash_origin FROM schema_migrations WHERE version = 10").pluck().get(),
    ).toBe("APPLIED");
    expect(() =>
      sqlite
        .prepare("UPDATE auth_credentials SET scopes_json = '[]' WHERE id = 'crd_local_agent'")
        .run(),
    ).toThrow(/immutable except for revocation/i);
    sqlite.close();
  });

  it("rejects an unknown intermediate scope without changing any credential", async () => {
    legacyMigrationDirectory();
    const sqlite = legacyDatabase();
    markLegacyMigrationsApplied(sqlite);
    await expectStaticGuardFailure(sqlite, (database) => {
      mutateCredential(
        database,
        `UPDATE auth_credentials SET scopes_json = '["hub:agent","unexpected:scope"]'
         WHERE id = 'crd_local_agent'`,
      );
    });
    sqlite.close();
  });

  it.each<[string, (sqlite: Database.Database) => void]>([
    [
      "a revoked credential",
      (sqlite) => {
        mutateCredential(
          sqlite,
          `UPDATE auth_credentials SET revoked_at = '2026-08-01T01:00:00.000Z'
         WHERE id = 'crd_agent_codex'`,
        );
      },
    ],
    [
      "an expiring credential",
      (sqlite) => {
        mutateCredential(
          sqlite,
          `UPDATE auth_credentials SET expires_at = '2026-08-02T00:00:00.000Z'
         WHERE id = 'crd_agent_codex'`,
        );
      },
    ],
    [
      "the wrong principal kind",
      (sqlite) => {
        sqlite.exec(
          "UPDATE auth_principals SET kind = 'DASHBOARD_USER' WHERE id = 'prn_agent_codex'",
        );
      },
    ],
    [
      "the wrong principal client",
      (sqlite) => {
        sqlite.exec(
          "UPDATE auth_principals SET client_type = 'claude' WHERE id = 'prn_agent_codex'",
        );
      },
    ],
    [
      "an inactive principal",
      (sqlite) => {
        sqlite.exec("UPDATE auth_principals SET status = 'REVOKED' WHERE id = 'prn_agent_codex'");
      },
    ],
    [
      "a project-bound static principal",
      (sqlite) => {
        sqlite.exec(
          "UPDATE auth_principals SET project_id = 'prj_forged' WHERE id = 'prn_agent_codex'",
        );
      },
    ],
    [
      "a session-bound static principal",
      (sqlite) => {
        sqlite.exec(
          "UPDATE auth_principals SET session_id = 'ses_forged' WHERE id = 'prn_agent_codex'",
        );
      },
    ],
  ])("rejects %s atomically", async (_label, mutate) => {
    legacyMigrationDirectory();
    const sqlite = legacyDatabase();
    markLegacyMigrationsApplied(sqlite);

    await expectStaticGuardFailure(sqlite, mutate);

    sqlite.close();
  });

  it("allows a missing static credential so startup can create it later", async () => {
    legacyMigrationDirectory();
    const sqlite = legacyDatabase();
    markLegacyMigrationsApplied(sqlite);
    sqlite.exec(`
      DELETE FROM auth_credentials WHERE id = 'crd_inject_claude';
    `);

    await expect(migrate(sqlite)).resolves.toBeUndefined();

    expect(
      sqlite.prepare("SELECT hash_origin FROM schema_migrations WHERE version = 10").pluck().get(),
    ).toBe("APPLIED");
    expect(
      sqlite.prepare("SELECT 1 FROM auth_credentials WHERE id = 'crd_inject_claude'").get(),
    ).toBeUndefined();
    sqlite.close();
  });

  it("allows a fresh database and lets the credential registry populate static identities", async () => {
    vi.stubEnv("CROSSAGENT_MIGRATIONS_DIR", repositoryMigrations);
    const sqlite = new Database(":memory:");
    await migrate(sqlite);
    expect(sqlite.prepare("SELECT COUNT(*) FROM auth_credentials").pluck().get()).toBe(0);
    const credentialRoot = mkdtempSync(resolve(tmpdir(), "crossagent-fresh-credentials-"));
    roots.push(credentialRoot);

    const registry = initializeCredentialRegistry(sqlite, credentialRoot);

    expect(registry.credentials.agent.principal.scopes).toEqual(["project:select"]);
    expect(registry.credentials.agentByClient.codex.principal.scopes).toEqual([
      "project:join",
      "project:select",
      "session-ticket:offer",
      "session:enroll:first",
    ]);
    expect(registry.credentials.capture.claude.principal.scopes).toEqual([
      "session-ticket:offer:capture",
    ]);
    expect(registry.credentials.injector.claude.principal.scopes).toEqual([
      "session-ticket:offer:injector",
    ]);
    sqlite.close();
  });
});
