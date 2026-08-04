import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migration-runner.js";
import { initializeCredentialRegistry } from "../src/security/local-auth.js";

const roots: string[] = [];
let activeMigrationRoot: string | null = null;

function migrationDirectory(files: Record<string, string>): string {
  const root = mkdtempSync(resolve(tmpdir(), "crossagent-migration-integrity-"));
  roots.push(root);
  for (const [name, sql] of Object.entries(files)) {
    writeFileSync(resolve(root, name), sql, "utf8");
  }
  activeMigrationRoot = root;
  return root;
}

/** Integrity tests exercise the runner directly; production path discovery stays fail-closed. */
async function migrate(sqlite: Database.Database): Promise<void> {
  if (!activeMigrationRoot) throw new Error("Migration test directory was not initialized");
  await runMigrations(sqlite, activeMigrationRoot, ":memory:", false);
}

function migrationRows(sqlite: Database.Database): Array<Record<string, unknown>> {
  return sqlite.prepare("SELECT * FROM schema_migrations ORDER BY version").all() as Array<
    Record<string, unknown>
  >;
}

function repositoryMigrationsThrough(maxVersion: number): {
  directory: string;
  files: Record<string, string>;
} {
  const directory = fileURLToPath(new URL("../../../migrations", import.meta.url));
  const files: Record<string, string> = {};
  for (let version = 1; version <= maxVersion; version += 1) {
    const prefix = version.toString().padStart(4, "0");
    const name = readdirSync(directory).find(
      (entry) => entry.startsWith(`${prefix}_`) && entry.endsWith(".sql"),
    );
    expect(name).toBeDefined();
    files[name!] = readFileSync(resolve(directory, name!), "utf8");
  }
  return { directory, files };
}

function seedV10ConfirmedHandoff(
  sqlite: Database.Database,
  input: {
    current: "B" | "C";
    emittedHops: Array<"B" | "C">;
    receiptAfterHandoff?: boolean;
    forkFirstHopToX?: boolean;
  },
): void {
  const timestamp = "2026-08-01T00:00:00.000Z";
  sqlite.exec(`
    INSERT INTO projects(id, name, config_json, current_sequence, version, created_at, updated_at)
    VALUES ('prj_handoff', 'Legacy handoff', '{}', 0, 0, '${timestamp}', '${timestamp}');
    INSERT INTO agents(id, project_id, display_name, capabilities_json, created_at, updated_at)
    VALUES ('claude', 'prj_handoff', 'Claude', '[]', '${timestamp}', '${timestamp}');
    INSERT INTO session_lineages(
      id, project_id, agent_id, client, delivery_mode, identity_kind, identity_value,
      head_session_id, head_incarnation, launch_fence_required, reserved_generation,
      active_reservation_id, head_run_id, head_run_generation, version, created_at, updated_at
    ) VALUES (
      'lin_handoff', 'prj_handoff', 'claude', 'manual', 'mailbox_only',
      'external_thread', 'thread-handoff', NULL, 0, 0, 0,
      NULL, NULL, NULL, 0, '${timestamp}', '${timestamp}'
    );
  `);
  const insertSession = sqlite.prepare(`
    INSERT INTO agent_sessions(
      id, project_id, agent_id, role, client, transport, delivery_mode,
      external_session_id, external_thread_id, host, cwd, capabilities_json,
      connected_at, transport_last_seen_at, active_files_json, work_state,
      connection_state, heartbeat_sequence, queue_depth, version, closed_at,
      lineage_id, incarnation, predecessor_session_id, superseded_by_session_id
    ) VALUES (
      ?, 'prj_handoff', 'claude', 'primary', 'manual', 'hooks', 'mailbox_only',
      ?, 'thread-handoff', 'legacy-host', 'R:/legacy', '[]',
      ?, ?, '[]', 'IDLE', ?, 0, 0, 0, ?, 'lin_handoff', ?, ?, NULL
    )
  `);
  insertSession.run("ses_A", "external-A", timestamp, timestamp, "CLOSED", timestamp, 1, null);
  insertSession.run("ses_B", "external-B", timestamp, timestamp, "CLOSED", timestamp, 2, "ses_A");
  if (input.current === "C") {
    insertSession.run("ses_C", "external-C", timestamp, timestamp, "ONLINE", null, 3, "ses_B");
  } else {
    sqlite
      .prepare(
        "UPDATE agent_sessions SET connection_state = 'ONLINE', closed_at = NULL WHERE id = 'ses_B'",
      )
      .run();
  }
  if (input.forkFirstHopToX) {
    insertSession.run("ses_X", "external-X", timestamp, timestamp, "CLOSED", timestamp, 2, "ses_A");
  }
  sqlite
    .prepare("UPDATE agent_sessions SET superseded_by_session_id = 'ses_B' WHERE id = 'ses_A'")
    .run();
  if (input.current === "C") {
    sqlite
      .prepare("UPDATE agent_sessions SET superseded_by_session_id = 'ses_C' WHERE id = 'ses_B'")
      .run();
  }
  const currentSessionId = input.current === "C" ? "ses_C" : "ses_B";
  const currentIncarnation = input.current === "C" ? 3 : 2;
  sqlite
    .prepare(
      `UPDATE session_lineages
         SET head_session_id = ?, head_incarnation = ?, version = 1, updated_at = ?
       WHERE id = 'lin_handoff'`,
    )
    .run(currentSessionId, currentIncarnation, timestamp);
  sqlite.exec(`
    INSERT INTO threads(
      id, project_id, subject, status, proposal_rounds, objection_rounds,
      version, created_at, updated_at
    ) VALUES (
      'thr_handoff', 'prj_handoff', 'Legacy handoff', 'OPEN', 0, 0, 0,
      '${timestamp}', '${timestamp}'
    );
    INSERT INTO messages(
      id, project_id, sequence, thread_id, from_agent_id, type, priority,
      requires_ack, requires_response, summary, references_json, created_at
    ) VALUES (
      'msg_handoff', 'prj_handoff', 1, 'thr_handoff', 'local-user', 'INFORM', 'IMPORTANT',
      1, 0, 'Legacy confirmed delivery', '[]', '${timestamp}'
    );
  `);
  sqlite
    .prepare(
      `INSERT INTO message_recipients(
         id, message_id, recipient_agent_id, recipient_session_id, state,
         delivered_at, attempt_count, surface_fence
       ) VALUES (
         'rcp_handoff', 'msg_handoff', 'claude', ?, 'DELIVERED', ?, 1, 1
       )`,
    )
    .run(currentSessionId, timestamp);
  sqlite.exec(`
    INSERT INTO message_surface_attempts(
      id, message_id, recipient_id, session_id, session_incarnation, recipient_fence,
      state, error, created_at, updated_at, confirmed_at
    ) VALUES (
      'srf_handoff', 'msg_handoff', 'rcp_handoff', 'ses_A', 1, 1,
      'CONFIRMED', NULL, '${timestamp}', '${timestamp}', '${timestamp}'
    );
    INSERT INTO message_deliveries(
      id, recipient_id, session_id, transport, attempt, state, error, created_at, completed_at
    ) VALUES (
      'dlv_handoff', 'rcp_handoff', 'ses_A', 'hook-poll', 1, 'DELIVERED', NULL,
      '${timestamp}', '${timestamp}'
    );
  `);
  const insertEvent = sqlite.prepare(`
    INSERT INTO events(
      id, project_id, sequence, type, actor_type, actor_id, aggregate_type,
      aggregate_id, causation_id, correlation_id, payload_json, created_at
    ) VALUES (?, 'prj_handoff', ?, ?, ?, ?, 'message', 'msg_handoff', ?, 'thr_handoff', ?, ?)
  `);
  let sequence = 0;
  const insertDeliveryReceipt = () => {
    sequence += 1;
    insertEvent.run(
      "evt_delivered",
      sequence,
      "message.delivered",
      "agent",
      "claude",
      "dlv_handoff",
      JSON.stringify({
        recipientId: "rcp_handoff",
        sessionId: "ses_A",
        surfaceAttemptId: "srf_handoff",
        recipientFence: 1,
      }),
      timestamp,
    );
  };
  if (!input.receiptAfterHandoff) insertDeliveryReceipt();
  for (const successor of input.emittedHops) {
    sequence += 1;
    const predecessor = successor === "B" ? "A" : "B";
    insertEvent.run(
      `evt_handoff_${successor}`,
      sequence,
      "message.surface.confirmed_handoff",
      "system",
      "session-replacement",
      "srf_handoff",
      JSON.stringify({
        recipientId: "rcp_handoff",
        sessionId: "ses_A",
        sessionIncarnation: 1,
        recipientFence: 1,
        previousRecipientSessionId: `ses_${predecessor}`,
        reboundToSessionId: `ses_${successor}`,
        lineageId: "lin_handoff",
      }),
      timestamp,
    );
  }
  if (input.forkFirstHopToX) {
    sequence += 1;
    insertEvent.run(
      "evt_handoff_fork_X",
      sequence,
      "message.surface.confirmed_handoff",
      "system",
      "session-replacement",
      "srf_handoff",
      JSON.stringify({
        recipientId: "rcp_handoff",
        sessionId: "ses_A",
        sessionIncarnation: 1,
        recipientFence: 1,
        previousRecipientSessionId: "ses_A",
        reboundToSessionId: "ses_X",
        lineageId: "lin_handoff",
      }),
      timestamp,
    );
  }
  if (input.receiptAfterHandoff) insertDeliveryReceipt();
  sqlite
    .prepare("UPDATE projects SET current_sequence = ?, updated_at = ? WHERE id = 'prj_handoff'")
    .run(sequence, timestamp);
}

function seedV11PersistentInvariantGraph(sqlite: Database.Database): void {
  const timestamp = "2026-08-01T00:00:00.000Z";
  sqlite.exec(`
    INSERT INTO projects(id, name, config_json, current_sequence, version, created_at, updated_at)
    VALUES ('prj_invariant', 'Persistent invariant', '{}', 1, 0, '${timestamp}', '${timestamp}');
    INSERT INTO objectives(
      id, project_id, title, description, definition_of_done_json, status,
      weight, created_at, updated_at
    ) VALUES (
      'obj_invariant', 'prj_invariant', 'Invariant', '', '[]', 'ACTIVE', 1,
      '${timestamp}', '${timestamp}'
    );
    INSERT INTO agents(id, project_id, display_name, capabilities_json, created_at, updated_at)
    VALUES ('codex', 'prj_invariant', 'Codex', '[]', '${timestamp}', '${timestamp}');
    INSERT INTO session_lineages(
      id, project_id, agent_id, client, delivery_mode, identity_kind, identity_value,
      head_session_id, head_incarnation, launch_fence_required, reserved_generation,
      active_reservation_id, head_run_id, head_run_generation, version, created_at, updated_at
    ) VALUES (
      'lin_invariant', 'prj_invariant', 'codex', 'codex-app-server', 'app_server_push',
      'external_thread', 'thread-invariant', NULL, 0, 1, 0, NULL, NULL, NULL, 0,
      '${timestamp}', '${timestamp}'
    );
    INSERT INTO agent_sessions(
      id, project_id, agent_id, role, client, transport, delivery_mode,
      external_thread_id, host, cwd, capabilities_json, connected_at,
      transport_last_seen_at, active_files_json, work_state, connection_state,
      lineage_id, incarnation, version
    ) VALUES (
      'ses_invariant', 'prj_invariant', 'codex', 'primary', 'codex-app-server',
      'websocket', 'app_server_push', 'thread-invariant', 'host', 'R:/invariant', '[]',
      '${timestamp}', '${timestamp}', '[]', 'WORKING', 'ONLINE', 'lin_invariant', 1, 0
    );
    UPDATE session_lineages
       SET head_session_id = 'ses_invariant', head_incarnation = 1, version = 1
     WHERE id = 'lin_invariant';
    INSERT INTO session_launch_reservations(
      id, project_id, lineage_id, run_id, generation, expected_head_session_id,
      state, consumed_session_id, created_at, updated_at
    ) VALUES (
      'rsr_invariant', 'prj_invariant', 'lin_invariant', 'run_invariant', 1,
      'ses_invariant', 'ISSUED', NULL, '${timestamp}', '${timestamp}'
    );
    UPDATE session_lineages
       SET reserved_generation = 1, active_reservation_id = 'rsr_invariant', version = 2
     WHERE id = 'lin_invariant';
    INSERT INTO tasks(
      id, project_id, objective_id, title, description, status, priority,
      owner_agent_id, owner_session_id, reviewer_agent_id, capability_tags_json,
      scope_globs_json, protected_scope, review_required, computed_progress,
      weight, created_at, updated_at
    ) VALUES (
      'tsk_invariant', 'prj_invariant', 'obj_invariant', 'Invariant task', '',
      'IN_REVIEW', 'critical', 'codex', 'ses_invariant', 'codex', '[]', '[]',
      0, 1, 50, 1, '${timestamp}', '${timestamp}'
    );
    INSERT INTO artifacts(
      id, project_id, task_id, kind, name, media_type, sha256, size_bytes,
      storage_path, metadata_json, created_by_session_id, created_at
    ) VALUES (
      'art_invariant', 'prj_invariant', 'tsk_invariant', 'review_patch', 'patch',
      'text/x-diff', 'sha', 0, 'patch', '{}', 'ses_invariant', '${timestamp}'
    );
    INSERT INTO reviews(
      id, project_id, task_id, revision, author_agent_id, author_session_id,
      reviewer_agent_id, base_sha, head_sha, patch_sha256, patch_artifact_id,
      changed_files_json, acceptance_criteria_json, test_evidence_json,
      author_claims_json, known_risks_json, status, version, created_at, updated_at
    ) VALUES (
      'rev_invariant', 'prj_invariant', 'tsk_invariant', 1, 'codex', 'ses_invariant',
      'codex', 'base', 'head', 'sha', 'art_invariant', '[]', '[]', '[]', '[]', '[]',
      'IN_REVIEW', 0, '${timestamp}', '${timestamp}'
    );
    INSERT INTO threads(id, project_id, subject, status, created_at, updated_at)
    VALUES ('thr_invariant', 'prj_invariant', 'Explicit recipient', 'OPEN', '${timestamp}', '${timestamp}');
    INSERT INTO messages(
      id, project_id, sequence, thread_id, from_agent_id, from_session_id, type,
      priority, requires_ack, requires_response, summary, created_at
    ) VALUES (
      'msg_invariant', 'prj_invariant', 1, 'thr_invariant', 'codex', 'ses_invariant',
      'QUESTION', 'IMPORTANT', 1, 1, 'Explicit recipient', '${timestamp}'
    );
    INSERT INTO message_recipients(
      id, message_id, recipient_agent_id, recipient_session_id, state, attempt_count
    ) VALUES ('rcp_invariant', 'msg_invariant', 'codex', 'ses_invariant', 'PENDING', 0);
  `);
}

afterEach(() => {
  activeMigrationRoot = null;
  while (roots.length > 0) {
    rmSync(roots.pop()!, { recursive: true, force: true });
  }
});

describe("migration content integrity", () => {
  it("backfills only complete ordered v10 handoff chains and rolls invalid histories back", async () => {
    const repository = repositoryMigrationsThrough(10);
    const migrationRoot = migrationDirectory(repository.files);
    const valid = new Database(":memory:");
    const missing = new Database(":memory:");
    const incomplete = new Database(":memory:");
    const lateReceipt = new Database(":memory:");
    const forked = new Database(":memory:");
    const missingCurrent = new Database(":memory:");
    for (const sqlite of [valid, missing, incomplete, lateReceipt, forked, missingCurrent]) {
      await migrate(sqlite);
    }
    seedV10ConfirmedHandoff(valid, { current: "C", emittedHops: ["B", "C"] });
    seedV10ConfirmedHandoff(missing, { current: "B", emittedHops: [] });
    seedV10ConfirmedHandoff(incomplete, { current: "C", emittedHops: ["B"] });
    seedV10ConfirmedHandoff(lateReceipt, {
      current: "B",
      emittedHops: ["B"],
      receiptAfterHandoff: true,
    });
    seedV10ConfirmedHandoff(forked, {
      current: "C",
      emittedHops: ["B", "C"],
      forkFirstHopToX: true,
    });
    seedV10ConfirmedHandoff(missingCurrent, { current: "B", emittedHops: [] });
    missingCurrent
      .prepare("UPDATE message_recipients SET recipient_session_id = NULL WHERE id = 'rcp_handoff'")
      .run();
    const invalidDatabases = [missing, incomplete, lateReceipt, forked, missingCurrent];
    const invalidSnapshots = invalidDatabases.map((sqlite) => ({
      migrationVersions: migrationRows(sqlite).map((row) => row.version),
      authorityGuard: sqlite
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'authority_events_guard'",
        )
        .pluck()
        .get(),
      projectSequence: sqlite
        .prepare("SELECT current_sequence FROM projects WHERE id = 'prj_handoff'")
        .pluck()
        .get(),
    }));
    const migration11 = readdirSync(repository.directory).find(
      (entry) => entry.startsWith("0011_") && entry.endsWith(".sql"),
    );
    expect(migration11).toBeDefined();
    writeFileSync(
      resolve(migrationRoot, migration11!),
      readFileSync(resolve(repository.directory, migration11!), "utf8"),
      "utf8",
    );

    await expect(migrate(valid)).resolves.toBeUndefined();
    expect(
      valid
        .prepare(
          `SELECT source_surface_session_id, predecessor_session_id, successor_session_id,
                  source_surface_incarnation, predecessor_incarnation, successor_incarnation,
                  recipient_fence, event_id, created_at
             FROM message_surface_handoffs
            ORDER BY server_sequence`,
        )
        .all(),
    ).toEqual([
      {
        source_surface_session_id: "ses_A",
        predecessor_session_id: "ses_A",
        successor_session_id: "ses_B",
        source_surface_incarnation: 1,
        predecessor_incarnation: 1,
        successor_incarnation: 2,
        recipient_fence: 1,
        event_id: "evt_handoff_B",
        created_at: "2026-08-01T00:00:00.000Z",
      },
      {
        source_surface_session_id: "ses_A",
        predecessor_session_id: "ses_B",
        successor_session_id: "ses_C",
        source_surface_incarnation: 1,
        predecessor_incarnation: 2,
        successor_incarnation: 3,
        recipient_fence: 1,
        event_id: "evt_handoff_C",
        created_at: "2026-08-01T00:00:00.000Z",
      },
    ]);
    valid.exec(`
      INSERT INTO agent_sessions(
        id, project_id, agent_id, role, client, transport, delivery_mode,
        external_session_id, external_thread_id, host, cwd, capabilities_json,
        connected_at, transport_last_seen_at, active_files_json, work_state,
        connection_state, heartbeat_sequence, queue_depth, version, closed_at,
        lineage_id, incarnation, predecessor_session_id, superseded_by_session_id
      ) VALUES (
        'ses_D', 'prj_handoff', 'claude', 'primary', 'manual', 'hooks', 'mailbox_only',
        'external-D', 'thread-handoff', 'legacy-host', 'R:/legacy', '[]',
        '2026-08-01T00:00:01.000Z', '2026-08-01T00:00:01.000Z', '[]', 'IDLE',
        'CLOSED', 0, 0, 0, '2026-08-01T00:00:01.000Z',
        'lin_handoff', 4, 'ses_C', NULL
      );
    `);
    const nextHandoffPayload = JSON.stringify({
      recipientId: "rcp_handoff",
      sessionId: "ses_A",
      sessionIncarnation: 1,
      recipientFence: 1,
      previousRecipientSessionId: "ses_C",
      reboundToSessionId: "ses_D",
      lineageId: "lin_handoff",
    });
    valid
      .prepare(
        `INSERT INTO events(
           id, project_id, sequence, type, actor_type, actor_id, aggregate_type,
           aggregate_id, causation_id, correlation_id, payload_json, created_at
         ) VALUES (
           'evt_handoff_D', 'prj_handoff', 4, 'message.surface.confirmed_handoff',
           'system', 'session-replacement', 'message', 'msg_handoff', 'srf_handoff',
           'thr_handoff', ?, '2026-08-01T00:00:01.000Z'
         )`,
      )
      .run(nextHandoffPayload);
    valid
      .prepare(
        "UPDATE projects SET current_sequence = 4, updated_at = '2026-08-01T00:00:01.000Z' WHERE id = 'prj_handoff'",
      )
      .run();
    const insertNextHandoff = valid.prepare(`
      INSERT INTO message_surface_handoffs(
        id, project_id, message_id, recipient_id, surface_attempt_id, lineage_id,
        source_surface_session_id, predecessor_session_id, successor_session_id,
        source_surface_incarnation, predecessor_incarnation, successor_incarnation,
        recipient_fence, server_sequence, event_id, created_at
      ) VALUES (
        ?, 'prj_handoff', 'msg_handoff', 'rcp_handoff', 'srf_handoff', 'lin_handoff',
        'ses_A', 'ses_C', 'ses_D', 1, 3, 4, 1, 4, 'evt_handoff_D', ?
      )
    `);
    expect(() => insertNextHandoff.run("msh_next_forged", "forged-created-at")).toThrow(
      /handoff provenance is invalid/i,
    );
    expect(insertNextHandoff.run("msh_next_exact", "2026-08-01T00:00:01.000Z").changes).toBe(1);
    expect(
      valid
        .prepare(
          `SELECT predecessor_session_id, successor_session_id, server_sequence, created_at
             FROM message_surface_handoffs WHERE id = 'msh_next_exact'`,
        )
        .get(),
    ).toEqual({
      predecessor_session_id: "ses_C",
      successor_session_id: "ses_D",
      server_sequence: 4,
      created_at: "2026-08-01T00:00:01.000Z",
    });
    expect(migrationRows(valid).at(-1)).toMatchObject({ version: 11, hash_origin: "APPLIED" });

    for (const [index, sqlite] of invalidDatabases.entries()) {
      await expect(migrate(sqlite)).rejects.toThrow(
        /message_surface_handoff_migration_safe|UNIQUE constraint failed: message_surface_handoffs/i,
      );
      expect(migrationRows(sqlite).map((row) => row.version)).toEqual(
        invalidSnapshots[index]!.migrationVersions,
      );
      expect(
        sqlite
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'message_surface_handoffs'",
          )
          .get(),
      ).toBeUndefined();
      expect(
        sqlite
          .prepare(
            "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'authority_events_guard'",
          )
          .pluck()
          .get(),
      ).toBe(invalidSnapshots[index]!.authorityGuard);
      expect(
        sqlite
          .prepare("SELECT current_sequence FROM projects WHERE id = 'prj_handoff'")
          .pluck()
          .get(),
      ).toBe(invalidSnapshots[index]!.projectSequence);
    }
    for (const sqlite of [valid, ...invalidDatabases]) sqlite.close();
  });

  it("installs v12 persistent fences and rolls every pre-existing invalid graph back", async () => {
    const repository = repositoryMigrationsThrough(11);
    const migrationRoot = migrationDirectory(repository.files);
    const valid = new Database(":memory:");
    const duplicateReview = new Database(":memory:");
    const invalidRecipient = new Database(":memory:");
    const invalidReservation = new Database(":memory:");
    const databases = [valid, duplicateReview, invalidRecipient, invalidReservation];
    for (const sqlite of databases) {
      sqlite.pragma("foreign_keys = ON");
      await migrate(sqlite);
      seedV11PersistentInvariantGraph(sqlite);
    }
    duplicateReview.exec(`
      INSERT INTO reviews(
        id, project_id, task_id, revision, author_agent_id, author_session_id,
        reviewer_agent_id, base_sha, head_sha, patch_sha256, patch_artifact_id,
        changed_files_json, acceptance_criteria_json, test_evidence_json,
        author_claims_json, known_risks_json, status, supersedes_review_id,
        version, created_at, updated_at
      )
      SELECT 'rev_invariant_duplicate', project_id, task_id, 2, author_agent_id,
             author_session_id, reviewer_agent_id, base_sha, head_sha, patch_sha256,
             patch_artifact_id, changed_files_json, acceptance_criteria_json,
             test_evidence_json, author_claims_json, known_risks_json, 'PENDING', id,
             0, created_at, updated_at
        FROM reviews WHERE id = 'rev_invariant';
    `);
    invalidRecipient
      .prepare("UPDATE agent_sessions SET agent_id = 'claude' WHERE id = 'ses_invariant'")
      .run();
    invalidReservation
      .prepare(
        "UPDATE session_launch_reservations SET state = 'SUPERSEDED' WHERE id = 'rsr_invariant'",
      )
      .run();
    const invalidDatabases = [duplicateReview, invalidRecipient, invalidReservation];
    const invalidSnapshots = invalidDatabases.map((sqlite) => ({
      rows: {
        reviews: sqlite.prepare("SELECT id, status FROM reviews ORDER BY id").all(),
        session: sqlite
          .prepare("SELECT project_id, agent_id FROM agent_sessions WHERE id = 'ses_invariant'")
          .get(),
        reservation: sqlite
          .prepare("SELECT state FROM session_launch_reservations WHERE id = 'rsr_invariant'")
          .get(),
      },
      versions: migrationRows(sqlite).map((row) => row.version),
    }));
    const migration12 = readdirSync(repository.directory).find(
      (entry) => entry.startsWith("0012_") && entry.endsWith(".sql"),
    );
    expect(migration12).toBeDefined();
    writeFileSync(
      resolve(migrationRoot, migration12!),
      readFileSync(resolve(repository.directory, migration12!), "utf8"),
      "utf8",
    );

    await expect(migrate(valid)).resolves.toBeUndefined();
    expect(migrationRows(valid).at(-1)).toMatchObject({ version: 12, hash_origin: "APPLIED" });
    expect(() =>
      valid.exec(`
        INSERT INTO reviews(
          id, project_id, task_id, revision, author_agent_id, author_session_id,
          reviewer_agent_id, base_sha, head_sha, patch_sha256, patch_artifact_id,
          changed_files_json, acceptance_criteria_json, test_evidence_json,
          author_claims_json, known_risks_json, status, supersedes_review_id,
          version, created_at, updated_at
        )
        SELECT 'rev_v12_duplicate', project_id, task_id, 2, author_agent_id,
               author_session_id, reviewer_agent_id, base_sha, head_sha, patch_sha256,
               patch_artifact_id, changed_files_json, acceptance_criteria_json,
               test_evidence_json, author_claims_json, known_risks_json, 'PENDING', id,
               0, created_at, updated_at
          FROM reviews WHERE id = 'rev_invariant';
      `),
    ).toThrow(/UNIQUE constraint failed: reviews\.task_id/i);
    expect(() =>
      valid
        .prepare("UPDATE agent_sessions SET agent_id = 'claude' WHERE id = 'ses_invariant'")
        .run(),
    ).toThrow(/explicit message recipient binding/i);
    expect(() =>
      valid
        .prepare(
          "UPDATE session_launch_reservations SET state = 'SUPERSEDED' WHERE id = 'rsr_invariant'",
        )
        .run(),
    ).toThrow(/active reservation/i);
    expect(() =>
      valid.prepare("DELETE FROM session_launch_reservations WHERE id = 'rsr_invariant'").run(),
    ).toThrow(/active reservation/i);

    for (const [index, sqlite] of invalidDatabases.entries()) {
      await expect(migrate(sqlite)).rejects.toThrow(/hub_persistent_invariant_migration_safe/i);
      expect(migrationRows(sqlite).map((row) => row.version)).toEqual(
        invalidSnapshots[index]!.versions,
      );
      expect(sqlite.prepare("SELECT id, status FROM reviews ORDER BY id").all()).toEqual(
        invalidSnapshots[index]!.rows.reviews,
      );
      expect(
        sqlite
          .prepare("SELECT project_id, agent_id FROM agent_sessions WHERE id = 'ses_invariant'")
          .get(),
      ).toEqual(invalidSnapshots[index]!.rows.session);
      expect(
        sqlite
          .prepare("SELECT state FROM session_launch_reservations WHERE id = 'rsr_invariant'")
          .get(),
      ).toEqual(invalidSnapshots[index]!.rows.reservation);
      expect(
        sqlite
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'ux_reviews_one_active_per_task'",
          )
          .get(),
      ).toBeUndefined();
      expect(
        sqlite
          .prepare(
            "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name IN ('explicit_message_recipient_session_identity_guard', 'active_launch_reservation_update_guard', 'active_launch_reservation_delete_guard')",
          )
          .get(),
      ).toEqual({ count: 0 });
    }
    for (const sqlite of databases) sqlite.close();
  });

  it("migrates v8 to session tickets without adopting legacy sessions or storing plaintext", async () => {
    const repositoryMigrations = fileURLToPath(new URL("../../../migrations", import.meta.url));
    const files: Record<string, string> = {};
    for (let version = 1; version <= 8; version += 1) {
      const prefix = version.toString().padStart(4, "0");
      const name = readdirSync(repositoryMigrations).find(
        (entry) => entry.startsWith(`${prefix}_`) && entry.endsWith(".sql"),
      );
      expect(name).toBeDefined();
      files[name!] = readFileSync(resolve(repositoryMigrations, name!), "utf8");
    }
    const migrationRoot = migrationDirectory(files);
    const sqlite = new Database(":memory:");
    await migrate(sqlite);
    sqlite.exec(`
      INSERT INTO projects(id, name, config_json, current_sequence, version, created_at, updated_at)
      VALUES ('prj_legacy', 'Legacy', '{}', 0, 0, '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z');
      INSERT INTO agents(id, project_id, display_name, capabilities_json, created_at, updated_at)
      VALUES ('codex', 'prj_legacy', 'Codex', '[]', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z');
      INSERT INTO session_lineages(
        id, project_id, agent_id, client, delivery_mode, identity_kind, identity_value,
        head_session_id, head_incarnation, launch_fence_required, reserved_generation,
        version, created_at, updated_at
      ) VALUES (
        'lin_legacy', 'prj_legacy', 'codex', 'codex-app-server', 'push',
        'external_thread', 'legacy-thread', NULL, 0, 0, 0, 0,
        '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'
      );
    `);
    const credentialRoot = mkdtempSync(resolve(tmpdir(), "crossagent-v8-credentials-"));
    roots.push(credentialRoot);
    const legacyCodexToken = "legacy-codex-token-material-0000000000000001";
    writeFileSync(resolve(credentialRoot, "agent-codex-token"), `${legacyCodexToken}\n`, "utf8");
    sqlite.exec(`
      INSERT INTO auth_principals(
        id, kind, display_name, project_id, client_type, session_id, status, created_at, updated_at
      ) VALUES (
        'prn_agent_codex', 'AGENT', 'Codex Agent', NULL, 'codex', NULL, 'ACTIVE',
        '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'
      );
    `);
    sqlite
      .prepare(
        `INSERT INTO auth_credentials(
           id, principal_id, token_sha256, scopes_json, expires_at, revoked_at, created_at
         ) VALUES (
           'crd_agent_codex', 'prn_agent_codex', ?, '["directive:relay","hub:agent"]',
           NULL, NULL, '2026-08-01T00:00:00.000Z'
         )`,
      )
      .run(createHash("sha256").update(legacyCodexToken, "utf8").digest("hex"));

    const migration9 = readdirSync(repositoryMigrations).find(
      (entry) => entry.startsWith("0009_") && entry.endsWith(".sql"),
    );
    expect(migration9).toBeDefined();
    writeFileSync(
      resolve(migrationRoot, migration9!),
      readFileSync(resolve(repositoryMigrations, migration9!), "utf8"),
      "utf8",
    );
    await migrate(sqlite);

    const registry = initializeCredentialRegistry(sqlite, credentialRoot);
    expect(registry.credentials.agentByClient.codex.principal.scopes).toEqual([
      "project:join",
      "project:select",
      "session-ticket:offer",
      "session:enroll:first",
    ]);
    expect(registry.credentials.agentByClient.claude.principal.scopes).toEqual([
      "project:join",
      "project:select",
      "session-ticket:offer",
      "session:enroll:first",
    ]);
    expect(registry.credentials.agent.principal.scopes).toEqual(["project:select"]);
    expect(registry.credentials.capture.codex.principal.scopes).toEqual([
      "session-ticket:offer:capture",
    ]);
    expect(registry.credentials.capture.claude.principal.scopes).toEqual([
      "session-ticket:offer:capture",
    ]);
    expect(registry.credentials.injector.codex.principal.scopes).toEqual([
      "session-ticket:offer:injector",
    ]);
    expect(registry.credentials.injector.claude.principal.scopes).toEqual([
      "session-ticket:offer:injector",
    ]);
    expect(registry.credentials.dashboard.principal.scopes).toEqual(["hub:dashboard"]);

    expect(sqlite.prepare("SELECT COUNT(*) FROM adapter_session_tickets").pluck().get()).toBe(0);
    const tableSql = sqlite
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'adapter_session_tickets'",
      )
      .pluck()
      .get() as string;
    expect(tableSql.toLowerCase()).not.toMatch(/raw[_ ]?token|plaintext|secret/);
    expect(sqlite.pragma("foreign_key_check")).toEqual([]);
    sqlite.close();
  });

  it("expires events outside the v15 retention window and never inside it", async () => {
    const repository = repositoryMigrationsThrough(15);
    migrationDirectory(repository.files);
    const sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    await migrate(sqlite);
    const daysAgo = (days: number): string =>
      new Date(Date.now() - days * 86_400_000).toISOString();
    sqlite.exec(`
      INSERT INTO projects(id, name, config_json, current_sequence, version, created_at, updated_at)
      VALUES ('prj_retention', 'Retention', '{}', 0, 0, '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z');
    `);
    const insertEvent = sqlite.prepare(`
      INSERT INTO events(
        id, project_id, sequence, type, actor_type, actor_id, aggregate_type,
        aggregate_id, payload_json, created_at
      ) VALUES (?, 'prj_retention', ?, 'adapter.item.completed', 'agent', 'codex', 'session', 'ses_x', '{}', ?)
    `);
    const deleteEvent = (id: string) => sqlite.prepare("DELETE FROM events WHERE id = ?").run(id);

    expect(sqlite.prepare("SELECT days FROM event_retention_policy").pluck().get()).toBe(30);
    insertEvent.run("evt_today", 1, daysAgo(0));
    insertEvent.run("evt_ancient", 2, daysAgo(100));
    expect(() => deleteEvent("evt_today")).toThrow(/append-only inside the retention window/i);
    expect(deleteEvent("evt_ancient").changes).toBe(1);

    // The stored window, not the caller, decides what "recent" means.
    insertEvent.run("evt_hundred_days", 3, daysAgo(100));
    sqlite.prepare("UPDATE event_retention_policy SET days = 365 WHERE id = 1").run();
    expect(() => deleteEvent("evt_hundred_days")).toThrow(
      /append-only inside the retention window/i,
    );
    sqlite.prepare("UPDATE event_retention_policy SET days = 7 WHERE id = 1").run();
    expect(deleteEvent("evt_hundred_days").changes).toBe(1);
    expect(() =>
      sqlite.prepare("UPDATE event_retention_policy SET days = 45 WHERE id = 1").run(),
    ).toThrow(/CHECK constraint/i);

    // Losing the policy row locks the log rather than opening it.
    insertEvent.run("evt_unpoliced", 4, daysAgo(100));
    sqlite.prepare("DELETE FROM event_retention_policy WHERE id = 1").run();
    expect(() => deleteEvent("evt_unpoliced")).toThrow(/append-only inside the retention window/i);

    // The narrowed trigger leans on these foreign keys to keep load-bearing events unreachable, so
    // a later table referencing events with CASCADE or SET NULL would silently reopen the hole.
    const tables = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .pluck()
      .all() as string[];
    const eventReferences = tables.flatMap((table) =>
      (sqlite.pragma(`foreign_key_list("${table}")`) as Array<{ table: string; on_delete: string }>)
        .filter((key) => key.table === "events")
        .map((key) => ({ from: table, onDelete: key.on_delete })),
    );
    expect(eventReferences.length).toBeGreaterThan(0);
    expect(eventReferences.filter((reference) => reference.onDelete !== "RESTRICT")).toEqual([]);
    expect(
      sqlite
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = ?")
        .get("authority_events_immutable_update"),
    ).toBeTruthy();
    expect(sqlite.pragma("foreign_key_check")).toEqual([]);
    sqlite.close();
  });

  it("records an applied content hash for every fresh migration", async () => {
    migrationDirectory({
      "0001_first.sql": "CREATE TABLE first_value(id TEXT PRIMARY KEY);\n",
      "0002_second.sql": "CREATE TABLE second_value(id TEXT PRIMARY KEY);\n",
    });
    const sqlite = new Database(":memory:");

    await migrate(sqlite);

    expect(migrationRows(sqlite)).toEqual([
      expect.objectContaining({
        version: 1,
        name: "0001_first.sql",
        content_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        hash_origin: "APPLIED",
      }),
      expect.objectContaining({
        version: 2,
        name: "0002_second.sql",
        content_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        hash_origin: "APPLIED",
      }),
    ]);
    sqlite.close();
  });

  it("fails loud when an applied migration file changes", async () => {
    const root = migrationDirectory({
      "0001_first.sql": "CREATE TABLE first_value(id TEXT PRIMARY KEY);\n",
    });
    const sqlite = new Database(":memory:");
    await migrate(sqlite);

    writeFileSync(
      resolve(root, "0001_first.sql"),
      "CREATE TABLE first_value(id TEXT PRIMARY KEY, changed TEXT);\n",
      "utf8",
    );

    await expect(migrate(sqlite)).rejects.toThrow(/migration 1 content hash mismatch/i);
    sqlite.close();
  });

  it("marks pre-hash rows as an explicit unverified legacy baseline", async () => {
    migrationDirectory({
      "0001_first.sql": "CREATE TABLE first_value(id TEXT PRIMARY KEY);\n",
    });
    const sqlite = new Database(":memory:");
    sqlite.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE first_value(id TEXT PRIMARY KEY);
      INSERT INTO schema_migrations(version, name, applied_at)
      VALUES (1, '0001_first.sql', '2026-07-31T00:00:00.000Z');
    `);

    await migrate(sqlite);

    expect(migrationRows(sqlite)).toEqual([
      expect.objectContaining({
        version: 1,
        name: "0001_first.sql",
        content_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        hash_origin: "LEGACY_BASELINE_UNVERIFIED",
      }),
    ]);
    sqlite.close();
  });

  it("rejects a legacy row whose recorded filename no longer matches", async () => {
    migrationDirectory({
      "0001_first.sql": "CREATE TABLE first_value(id TEXT PRIMARY KEY);\n",
    });
    const sqlite = new Database(":memory:");
    sqlite.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
      INSERT INTO schema_migrations(version, name, applied_at)
      VALUES (1, '0001_renamed.sql', '2026-07-31T00:00:00.000Z');
    `);

    await expect(migrate(sqlite)).rejects.toThrow(/migration 1 filename mismatch/i);
    expect(
      sqlite
        .prepare("PRAGMA table_info(schema_migrations)")
        .all()
        .map((row: any) => row.name),
    ).not.toContain("content_sha256");
    sqlite.close();
  });

  it("rejects duplicate numeric versions before executing either file", async () => {
    migrationDirectory({
      "0001_first.sql": "CREATE TABLE first_value(id TEXT PRIMARY KEY);\n",
      "0001_shadow.sql": "CREATE TABLE shadow_value(id TEXT PRIMARY KEY);\n",
    });
    const sqlite = new Database(":memory:");

    await expect(migrate(sqlite)).rejects.toThrow(/duplicate migration version 1/i);
    expect(
      sqlite
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'first_value'")
        .get(),
    ).toBeUndefined();
    expect(
      sqlite
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'shadow_value'")
        .get(),
    ).toBeUndefined();
    sqlite.close();
  });

  it("uses a canonical LF hash so checkout line endings do not create false drift", async () => {
    const root = migrationDirectory({
      "0001_first.sql":
        "CREATE TABLE first_value(value TEXT);\r\nINSERT INTO first_value(value) VALUES ('line one\r\nline two');\r\n",
    });
    const sqlite = new Database(":memory:");
    await migrate(sqlite);
    const firstHash = migrationRows(sqlite)[0]?.content_sha256;
    expect(firstHash).toEqual(expect.stringMatching(/^[a-f0-9]{64}$/));
    expect(sqlite.prepare("SELECT value FROM first_value").pluck().get()).toBe(
      "line one\nline two",
    );
    const crlf = readFileSync(resolve(root, "0001_first.sql"), "utf8");
    writeFileSync(resolve(root, "0001_first.sql"), crlf.replaceAll("\r\n", "\n"), "utf8");

    await expect(migrate(sqlite)).resolves.toBeUndefined();
    expect(migrationRows(sqlite)[0]?.content_sha256).toBe(firstHash);
    sqlite.close();
  });

  it("rejects a historical hole instead of applying an older migration after a newer one", async () => {
    migrationDirectory({
      "0001_first.sql": "CREATE TABLE first_value(id TEXT PRIMARY KEY);\n",
      "0002_second.sql": "CREATE TABLE second_value(id TEXT PRIMARY KEY);\n",
    });
    const sqlite = new Database(":memory:");
    sqlite.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE second_value(id TEXT PRIMARY KEY);
      INSERT INTO schema_migrations(version, name, applied_at)
      VALUES (2, '0002_second.sql', '2026-07-31T00:00:00.000Z');
    `);

    await expect(migrate(sqlite)).rejects.toThrow(/migration history gap.*version 1/i);
    expect(
      sqlite
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'first_value'")
        .get(),
    ).toBeUndefined();
    expect(
      sqlite
        .prepare("PRAGMA table_info(schema_migrations)")
        .all()
        .map((row: any) => row.name),
    ).not.toContain("content_sha256");
    sqlite.close();
  });

  it("rejects zero and unsafe migration versions before executing SQL", async () => {
    migrationDirectory({
      "0000_zero.sql": "CREATE TABLE zero_value(id TEXT PRIMARY KEY);\n",
    });
    const sqlite = new Database(":memory:");

    await expect(migrate(sqlite)).rejects.toThrow(/invalid migration version/i);
    expect(
      sqlite
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'zero_value'")
        .get(),
    ).toBeUndefined();
    sqlite.close();
  });

  it("blocks all pending side effects when an applied migration drifts", async () => {
    const root = migrationDirectory({
      "0001_first.sql": "CREATE TABLE first_value(id TEXT PRIMARY KEY);\n",
    });
    const sqlite = new Database(":memory:");
    await migrate(sqlite);
    writeFileSync(
      resolve(root, "0001_first.sql"),
      "CREATE TABLE first_value(id TEXT PRIMARY KEY, drifted TEXT);\n",
      "utf8",
    );
    writeFileSync(
      resolve(root, "0002_pending.sql"),
      "CREATE TABLE pending_value(id TEXT PRIMARY KEY);\n",
      "utf8",
    );

    await expect(migrate(sqlite)).rejects.toThrow(/migration 1 content hash mismatch/i);
    expect(
      sqlite
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'pending_value'")
        .get(),
    ).toBeUndefined();
    expect(migrationRows(sqlite)).toHaveLength(1);
    sqlite.close();
  });

  it("rolls back a failed migration's SQL and hash row while retaining prior versions", async () => {
    migrationDirectory({
      "0001_first.sql": "CREATE TABLE first_value(id TEXT PRIMARY KEY);\n",
      "0002_broken.sql":
        "CREATE TABLE broken_value(id TEXT PRIMARY KEY);\nINSERT INTO missing_table(id) VALUES ('nope');\n",
    });
    const sqlite = new Database(":memory:");

    await expect(migrate(sqlite)).rejects.toThrow();
    expect(
      sqlite
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'first_value'")
        .get(),
    ).toBeTruthy();
    expect(
      sqlite
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'broken_value'")
        .get(),
    ).toBeUndefined();
    expect(migrationRows(sqlite).map((row) => row.version)).toEqual([1]);
    sqlite.close();
  });

  it("rejects invalid UTF-8 instead of hashing replacement characters", async () => {
    const root = migrationDirectory({});
    writeFileSync(resolve(root, "0001_invalid.sql"), Buffer.from([0xff, 0xfe, 0xfd]));
    const sqlite = new Database(":memory:");

    await expect(migrate(sqlite)).rejects.toThrow(/valid UTF-8/i);
    expect(
      sqlite
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
        .get(),
    ).toBeUndefined();
    sqlite.close();
  });
});
