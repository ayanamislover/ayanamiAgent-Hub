import Database from "better-sqlite3";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HubServer } from "../src/server.js";
import { migrate } from "../src/db/database.js";
import { createHubServer } from "./test-server.js";

const migrationsDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../../../migrations");

function openVersionFiveLiveDraft(databasePath: string): Database.Database {
  const sqlite = new Database(databasePath);
  sqlite.pragma("foreign_keys = ON");
  const migrationNames = readdirSync(migrationsDirectory)
    .filter((name) => /^\d+_.*\.sql$/.test(name) && Number(name.split("_", 1)[0]) <= 4)
    .sort();
  for (const name of migrationNames) {
    const version = Number(name.split("_", 1)[0]);
    sqlite.exec(readFileSync(resolve(migrationsDirectory, name), "utf8"));
    sqlite
      .prepare("INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)")
      .run(version, name, "2026-07-31T00:00:00.000Z");
  }

  const migrationFiveName = "0005_session_surface_fences.sql";
  // Normalised, because the patterns below span line breaks and Git hands this file to a Windows
  // checkout with CRLF (core.autocrlf). Reading it raw made every multi-line replacement a silent
  // no-op there, so the "draft" kept the very CHECK constraints these tests exist to add.
  const currentMigrationFive = readFileSync(
    resolve(migrationsDirectory, migrationFiveName),
    "utf8",
  ).replaceAll("\r\n", "\n");

  /** A replacement that matched nothing means the draft is not a draft; fail rather than proceed. */
  const dropCheck = (sql: string, constrained: string, plain: string): string => {
    const next = sql.replace(constrained, plain);
    expect(next, `version 5 draft rewrite matched nothing: ${plain}`).not.toBe(sql);
    return next;
  };

  let liveDraftMigrationFive = dropCheck(
    currentMigrationFive,
    "head_incarnation INTEGER NOT NULL DEFAULT 0\n    CHECK(typeof(head_incarnation) = 'integer' AND head_incarnation >= 0)",
    "head_incarnation INTEGER NOT NULL DEFAULT 0",
  );
  liveDraftMigrationFive = dropCheck(
    liveDraftMigrationFive,
    "reserved_generation INTEGER NOT NULL DEFAULT 0\n    CHECK(typeof(reserved_generation) = 'integer' AND reserved_generation >= 0)",
    "reserved_generation INTEGER NOT NULL DEFAULT 0",
  );
  liveDraftMigrationFive = dropCheck(
    liveDraftMigrationFive,
    "head_run_generation INTEGER\n    CHECK(head_run_generation IS NULL OR (typeof(head_run_generation) = 'integer' AND head_run_generation > 0))",
    "head_run_generation INTEGER",
  );
  liveDraftMigrationFive = dropCheck(
    liveDraftMigrationFive,
    "generation INTEGER NOT NULL CHECK(typeof(generation) = 'integer' AND generation > 0)",
    "generation INTEGER NOT NULL",
  );
  sqlite.exec(liveDraftMigrationFive);
  sqlite
    .prepare("INSERT INTO schema_migrations(version, name, applied_at) VALUES (5, ?, ?)")
    .run(migrationFiveName, "2026-07-31T00:00:00.000Z");
  return sqlite;
}

function seedVersionFiveFenceRows(sqlite: Database.Database) {
  const now = "2026-07-31T00:00:00.000Z";
  const insertProject = sqlite.prepare(
    `INSERT INTO projects(id, name, current_sequence, created_at, updated_at)
     VALUES (?, ?, 0, ?, ?)`,
  );
  insertProject.run("prj_fence_a", "fence A", now, now);
  insertProject.run("prj_fence_b", "fence B", now, now);
  const insertLineage = sqlite.prepare(
    `INSERT INTO session_lineages(
       id, project_id, agent_id, client, delivery_mode, identity_kind, identity_value,
       head_session_id, head_incarnation, launch_fence_required, reserved_generation,
       active_reservation_id, head_run_id, head_run_generation,
       version, created_at, updated_at
     ) VALUES (?, ?, 'codex', 'codex-app-server', 'app_server_push',
       'external_thread', ?, NULL, 0, 1, 1, NULL, NULL, NULL, 0, ?, ?)`,
  );
  insertLineage.run("lin_fence_a", "prj_fence_a", "thread-a", now, now);
  insertLineage.run("lin_fence_b", "prj_fence_b", "thread-b", now, now);
  sqlite
    .prepare(
      `INSERT INTO session_lineages(
         id, project_id, agent_id, client, delivery_mode, identity_kind, identity_value,
         head_session_id, head_incarnation, launch_fence_required, reserved_generation,
         active_reservation_id, head_run_id, head_run_generation,
         version, created_at, updated_at
       ) VALUES (
         'lin_fence_a_peer', 'prj_fence_a', 'codex', 'fake-client', 'mailbox_only',
         'external_thread', 'thread-a-peer', NULL, 0, 0, 0, NULL, NULL, NULL, 0, ?, ?
       )`,
    )
    .run(now, now);
  const insertSession = sqlite.prepare(
    `INSERT INTO agent_sessions(
       id, project_id, agent_id, role, client, transport, delivery_mode,
       external_thread_id, host, cwd, capabilities_json, connected_at,
       transport_last_seen_at, active_files_json, work_state, connection_state,
       lineage_id, incarnation, launcher_run_id, launch_generation
     ) VALUES (?, ?, 'codex', 'primary', 'codex-app-server', 'websocket',
       'app_server_push', ?, 'test', ?, '[]', ?, ?, '[]', 'IDLE', 'ONLINE',
       ?, 1, ?, 1)`,
  );
  insertSession.run(
    "ses_fence_a",
    "prj_fence_a",
    "thread-a",
    "R:/fence-a",
    now,
    now,
    "lin_fence_a",
    "run_fence_a_1",
  );
  insertSession.run(
    "ses_fence_b",
    "prj_fence_b",
    "thread-b",
    "R:/fence-b",
    now,
    now,
    "lin_fence_b",
    "run_fence_b_1",
  );
  sqlite
    .prepare(
      `INSERT INTO agent_sessions(
         id, project_id, agent_id, role, client, transport, delivery_mode,
         external_thread_id, host, cwd, capabilities_json, connected_at,
         transport_last_seen_at, active_files_json, work_state, connection_state,
         lineage_id, incarnation, launcher_run_id, launch_generation
       ) VALUES (
         'ses_fence_a_peer', 'prj_fence_a', 'codex', 'primary', 'fake-client',
         'hooks', 'mailbox_only', 'thread-a-peer', 'test', 'R:/fence-a-peer',
         '[]', ?, ?, '[]', 'IDLE', 'ONLINE', 'lin_fence_a_peer', 1, NULL, NULL
       )`,
    )
    .run(now, now);
  const insertConsumedReservation = sqlite.prepare(
    `INSERT INTO session_launch_reservations(
       id, project_id, lineage_id, run_id, generation, expected_head_session_id,
       state, consumed_session_id, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 1, NULL, 'CONSUMED', ?, ?, ?)`,
  );
  insertConsumedReservation.run(
    "rsr_fence_a_1",
    "prj_fence_a",
    "lin_fence_a",
    "run_fence_a_1",
    "ses_fence_a",
    now,
    now,
  );
  insertConsumedReservation.run(
    "rsr_fence_b_1",
    "prj_fence_b",
    "lin_fence_b",
    "run_fence_b_1",
    "ses_fence_b",
    now,
    now,
  );
  sqlite
    .prepare(
      `UPDATE session_lineages
          SET head_session_id = ?, head_incarnation = 1,
              head_run_id = ?, head_run_generation = 1
        WHERE id = ?`,
    )
    .run("ses_fence_a", "run_fence_a_1", "lin_fence_a");
  sqlite
    .prepare(
      `UPDATE session_lineages
          SET head_session_id = ?, head_incarnation = 1,
              head_run_id = ?, head_run_generation = 1
        WHERE id = ?`,
    )
    .run("ses_fence_b", "run_fence_b_1", "lin_fence_b");
  sqlite
    .prepare(
      `UPDATE session_lineages
          SET head_session_id = 'ses_fence_a_peer', head_incarnation = 1
        WHERE id = 'lin_fence_a_peer'`,
    )
    .run();
  const insertIssuedReservation = sqlite.prepare(
    `INSERT INTO session_launch_reservations(
       id, project_id, lineage_id, run_id, generation, expected_head_session_id,
       state, consumed_session_id, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 2, ?, 'ISSUED', NULL, ?, ?)`,
  );
  insertIssuedReservation.run(
    "rsr_fence_a_2",
    "prj_fence_a",
    "lin_fence_a",
    "run_fence_a_2",
    "ses_fence_a",
    now,
    now,
  );
  sqlite
    .prepare(
      `INSERT INTO session_launch_reservations(
         id, project_id, lineage_id, run_id, generation, expected_head_session_id,
         state, consumed_session_id, created_at, updated_at
       ) VALUES (
         'rsr_fence_a_peer_1', 'prj_fence_a', 'lin_fence_a_peer', 'run_fence_a_peer_1',
         1, 'ses_fence_a_peer', 'ISSUED', NULL, ?, ?
       )`,
    )
    .run(now, now);
  insertIssuedReservation.run(
    "rsr_fence_b_2",
    "prj_fence_b",
    "lin_fence_b",
    "run_fence_b_2",
    "ses_fence_b",
    now,
    now,
  );
  sqlite
    .prepare(
      `UPDATE session_lineages
          SET reserved_generation = 2, active_reservation_id = ?
        WHERE id = ?`,
    )
    .run("rsr_fence_a_2", "lin_fence_a");
  sqlite
    .prepare(
      `UPDATE session_lineages
          SET reserved_generation = 2, active_reservation_id = ?
        WHERE id = ?`,
    )
    .run("rsr_fence_b_2", "lin_fence_b");
  sqlite
    .prepare(
      `UPDATE session_lineages
          SET reserved_generation = 1, active_reservation_id = 'rsr_fence_a_peer_1'
        WHERE id = 'lin_fence_a_peer'`,
    )
    .run();
}

/**
 * Two independent workers sharing one agent id must not evict each other.
 *
 * This is the source-level failure in the shape that can actually trigger the SQL: two Claude
 * workers join the same Dashboard project as agent "claude" through claude-channel, which passes no
 * externalThreadId. Registration used to close every other primary session for that project/agent,
 * so each start silently killed the other's session and rebound the loser's pinned mail.
 *
 * The replacement Interface now requires the same client + delivery mode + explicit external
 * identity. These tests cover a generic adapter with no identity; thread-scoped ownership is covered
 * separately in multi-session.integration.test.ts.
 *
 * Note on provenance: this is verified green against the fix. It is deliberately not verified red
 * against the previous code, because doing so would mean reverting Codex's in-flight uncommitted
 * edit to the same file -- the precise interference this whole change exists to stop. The old
 * behaviour is instead established from the previous SQL, which closed on
 * `agent_id = ? AND role = 'primary'` with no adapter or thread predicate at all.
 */
describe("two workers sharing an agent id", () => {
  let server: HubServer;
  let projectId: string;
  // registerSession resolves cwd through realpath, so each worker needs a directory that exists.
  let workerA: string;
  let workerB: string;

  const register = (
    overrides: Partial<Parameters<typeof server.store.registerSession>[0]> = {},
  ) => {
    const base = {
      projectId,
      agentId: "claude",
      role: "primary",
      client: "claude-channel",
      transport: "websocket",
      deliveryMode: "native_channel",
      capabilities: [],
      cwd: workerA,
      idempotencyKey: `reg-${Math.random()}`,
      ...overrides,
    } as Parameters<typeof server.store.registerSession>[0];
    if (base.client !== "codex-app-server") return server.store.registerSession(base);
    const runId = `run_${base.idempotencyKey.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
    const reservation = server.store.reserveSessionLaunch(projectId, {
      agentId: base.agentId,
      client: base.client,
      deliveryMode: base.deliveryMode,
      externalThreadId: base.externalThreadId,
      externalSessionId: base.externalSessionId,
      runId,
      idempotencyKey: `reserve_${base.idempotencyKey}`,
    });
    return server.store.registerSession({
      ...base,
      expectedHeadSessionId: reservation.expectedHeadSessionId,
      launcherRunId: reservation.runId,
      launchGeneration: reservation.generation,
    });
  };

  beforeEach(async () => {
    const root = mkdtempSync(resolve(tmpdir(), "hub-two-workers-"));
    workerA = mkdtempSync(resolve(tmpdir(), "hub-worker-a-"));
    workerB = mkdtempSync(resolve(tmpdir(), "hub-worker-b-"));
    server = await createHubServer({
      databasePath: resolve(root, "hub.db"),
      dataDir: resolve(root, "data"),
      dashboardDir: resolve(root, "missing-dashboard"),
      host: "127.0.0.1",
      port: 0,
      logLevel: "silent",
    });
    projectId = server.store.joinProject(server.credentials.dashboard.principal, {
      cwd: mkdtempSync(resolve(tmpdir(), "hub-two-workers-project-")),
      name: "two-workers",
      allowCreate: true,
    }).project.id;
  });

  afterEach(async () => {
    await server.app.close();
  });

  it("leaves both sessions live when neither declares an external thread", () => {
    const first = register({ cwd: workerA, host: "host-a" });
    const second = register({ cwd: workerB, host: "host-b" });

    const live = server.store.listSessions(projectId);
    const ids = live.map((session) => session.id);

    expect(ids).toContain(first.id);
    expect(ids).toContain(second.id);
    // getSession reads the row directly, so a CLOSED predecessor would still be visible here.
    expect(server.store.getSession(first.id).connectionState).not.toBe("CLOSED");
    expect(server.store.getSession(second.id).connectionState).not.toBe("CLOSED");
  });

  it("does not hand one worker's session-pinned mail to the other", () => {
    const first = register({ cwd: workerA, host: "host-a" });

    // Addressed to this worker specifically, which is what makes the rebinding dangerous: the
    // sender chose a session, not just an agent.
    const message = server.store.postMessage(server.credentials.dashboard.principal, projectId, {
      fromAgentId: "local-user",
      recipients: [{ agentId: "claude", sessionId: first.id }],
      type: "QUESTION",
      priority: "IMPORTANT",
      requiresAck: true,
      requiresResponse: true,
      summary: "for worker A only",
      idempotencyKey: "pin-to-a",
    });
    expect(message.recipients.map((r) => r.recipientSessionId)).toEqual([first.id]);

    const second = register({ cwd: workerB, host: "host-b" });

    const after = server.store.getMessage(message.id);
    expect(after.recipients).toHaveLength(1);
    const [recipient] = after.recipients;
    expect(recipient?.recipientSessionId).toBe(first.id);
    expect(recipient?.recipientSessionId).not.toBe(second.id);
  });

  it("still replaces a session when the same adapter and thread reconnects", () => {
    const first = register({
      externalThreadId: "thread-1",
      client: "codex-app-server",
      expectedHeadSessionId: null,
    });
    const second = register({
      externalThreadId: "thread-1",
      client: "codex-app-server",
      expectedHeadSessionId: first.id,
    });

    // The legitimate case must keep working: this is how a restarted adapter retires its predecessor.
    expect(server.store.getSession(first.id).connectionState).toBe("CLOSED");
    expect(server.store.getSession(second.id).connectionState).toBe("ONLINE");
    expect(
      server.store
        .listEvents(projectId)
        .filter((event) => event.type === "session.superseded")
        .map((event) => ({
          aggregateId: event.aggregateId,
          causationId: event.causationId,
          payload: event.payload,
        })),
    ).toEqual([
      expect.objectContaining({
        aggregateId: first.id,
        causationId: second.id,
        payload: expect.objectContaining({
          supersededBySessionId: second.id,
          externalThreadId: "thread-1",
        }),
      }),
    ]);
  });

  it("uses an explicit external session as the fallback logical identity", () => {
    const first = register({ externalSessionId: "worker-a", cwd: workerA });
    const unrelated = register({ externalSessionId: "worker-b", cwd: workerB });
    const replacement = register({ externalSessionId: "worker-a", cwd: workerA });

    expect(server.store.getSession(first.id).connectionState).toBe("CLOSED");
    expect(server.store.getSession(unrelated.id).connectionState).toBe("ONLINE");
    expect(server.store.getSession(replacement.id).connectionState).toBe("ONLINE");
  });

  it("does not let an equal heartbeat sequence overwrite state or duplicate its sample", () => {
    const session = register({ cwd: workerA });

    server.store.heartbeat({
      sessionId: session.id,
      sequence: 12,
      workState: "WORKING",
      activeFiles: ["first.ts"],
      queueDepth: 7,
    });
    server.store.heartbeat({
      sessionId: session.id,
      sequence: 12,
      workState: "IDLE",
      activeFiles: ["stale-replay.ts"],
      queueDepth: 0,
    });

    expect(server.store.getSession(session.id)).toMatchObject({
      workState: "WORKING",
      activeFiles: ["first.ts"],
      queueDepth: 7,
    });
    expect(
      server.store.sqlite
        .prepare("SELECT heartbeat_sequence FROM agent_sessions WHERE id = ?")
        .get(session.id),
    ).toEqual({ heartbeat_sequence: 12 });
    expect(
      server.store.sqlite
        .prepare(
          "SELECT COUNT(*) AS count FROM session_heartbeats WHERE session_id = ? AND sequence = 12",
        )
        .get(session.id),
    ).toEqual({ count: 1 });
    expect(
      server.store
        .listEvents(projectId)
        .filter(
          (event) => event.type === "session.state.changed" && event.aggregateId === session.id,
        ),
    ).toHaveLength(1);
  });

  it("keeps offline heads from distinct logical lineages in the roster", () => {
    const first = register({
      agentId: "codex",
      client: "fake-client",
      deliveryMode: "mailbox_only",
      externalThreadId: "offline-thread-a",
      cwd: workerA,
    });
    const second = register({
      agentId: "codex",
      client: "fake-client",
      deliveryMode: "mailbox_only",
      externalThreadId: "offline-thread-b",
      cwd: workerB,
    });
    server.store.sqlite
      .prepare(
        "UPDATE agent_sessions SET connection_state = 'OFFLINE', connected_at = ? WHERE id = ?",
      )
      .run("2026-01-01T00:00:00.000Z", first.id);
    server.store.sqlite
      .prepare(
        "UPDATE agent_sessions SET connection_state = 'OFFLINE', connected_at = ? WHERE id = ?",
      )
      .run("2026-01-02T00:00:00.000Z", second.id);

    expect(
      server.store
        .listSessions(projectId)
        .filter((session) => session.agentId === "codex" && session.client === "fake-client")
        .map((session) => session.id),
    ).toEqual([second.id, first.id]);
  });

  it("enforces recipient, surface, and reservation invariants at the SQLite boundary", () => {
    const sender = register({ agentId: "manual:claude", client: "fake-client", cwd: workerA });
    const codexA = register({
      agentId: "codex",
      client: "fake-client",
      deliveryMode: "native_channel",
      externalThreadId: "db-codex-a",
      cwd: workerA,
    });
    const codexB = register({
      agentId: "codex",
      client: "fake-client",
      deliveryMode: "native_channel",
      externalThreadId: "db-codex-b",
      cwd: workerB,
    });
    const unbound = server.store.postMessage(server.credentials.agent.principal, projectId, {
      fromAgentId: "manual:claude",
      fromSessionId: sender.id,
      recipients: [{ agentId: "codex" }],
      type: "QUESTION",
      priority: "IMPORTANT",
      requiresAck: true,
      requiresResponse: true,
      summary: "unbound recipient",
      idempotencyKey: "db-unbound-recipient",
    });
    expect(() =>
      server.store.sqlite
        .prepare(
          `INSERT INTO message_recipients(
             id, message_id, recipient_agent_id, recipient_session_id, state, attempt_count
           ) VALUES ('rcp_direct_mixed', ?, 'codex', ?, 'PENDING', 0)`,
        )
        .run(unbound.id, codexA.id),
    ).toThrow(/message recipient cannot mix/i);

    const explicit = server.store.postMessage(server.credentials.agent.principal, projectId, {
      fromAgentId: "manual:claude",
      fromSessionId: sender.id,
      recipients: [
        { agentId: "codex", sessionId: codexA.id },
        { agentId: "codex", sessionId: codexB.id },
      ],
      type: "QUESTION",
      priority: "IMPORTANT",
      requiresAck: true,
      requiresResponse: true,
      summary: "explicit recipients",
      idempotencyKey: "db-explicit-recipients",
    });
    const [firstExplicit] = explicit.recipients;
    expect(firstExplicit).toBeDefined();
    expect(() =>
      server.store.sqlite
        .prepare("UPDATE message_recipients SET recipient_session_id = NULL WHERE id = ?")
        .run(firstExplicit!.id),
    ).toThrow(/message recipient cannot mix/i);

    const invalidTarget = server.store.postMessage(server.credentials.agent.principal, projectId, {
      fromAgentId: "manual:claude",
      fromSessionId: sender.id,
      recipients: [{ agentId: "codex", sessionId: codexA.id }],
      type: "QUESTION",
      priority: "IMPORTANT",
      requiresAck: true,
      requiresResponse: true,
      summary: "valid before direct corruption",
      idempotencyKey: "db-invalid-target",
    });
    const invalidRecipientId = invalidTarget.recipients[0]!.id;
    expect(() =>
      server.store.sqlite
        .prepare("UPDATE message_recipients SET recipient_session_id = 'ses_missing' WHERE id = ?")
        .run(invalidRecipientId),
    ).toThrow(/recipient session must match/i);
    expect(() =>
      server.store.sqlite
        .prepare("UPDATE message_recipients SET recipient_session_id = ? WHERE id = ?")
        .run(sender.id, invalidRecipientId),
    ).toThrow(/recipient session must match/i);

    const now = "2026-07-31T00:00:00.000Z";
    server.store.sqlite
      .prepare(
        `INSERT INTO message_surface_attempts(
           id, message_id, recipient_id, session_id, session_incarnation,
           recipient_fence, state, created_at, updated_at
         ) VALUES ('sfa_direct_a', ?, ?, ?, 1, 1, 'ACTIVE', ?, ?)`,
      )
      .run(invalidTarget.id, invalidRecipientId, codexA.id, now, now);
    expect(() =>
      server.store.sqlite
        .prepare(
          `INSERT INTO message_surface_attempts(
             id, message_id, recipient_id, session_id, session_incarnation,
             recipient_fence, state, created_at, updated_at
           ) VALUES ('sfa_direct_b', ?, ?, ?, 1, 2, 'AMBIGUOUS', ?, ?)`,
        )
        .run(invalidTarget.id, invalidRecipientId, codexA.id, now, now),
    ).toThrow(/UNIQUE constraint failed/i);

    const reservation = server.store.reserveSessionLaunch(projectId, {
      agentId: "codex",
      client: "codex-app-server",
      deliveryMode: "app_server_push",
      externalThreadId: "db-reservation-thread",
      runId: "run_db_reservation",
      idempotencyKey: "db-reservation",
    });
    expect(() =>
      server.store.sqlite
        .prepare("UPDATE session_launch_reservations SET generation = 1.5 WHERE id = ?")
        .run(reservation.id),
    ).toThrow(/CHECK constraint failed|live session fence/i);
    expect(() =>
      server.store.sqlite
        .prepare("UPDATE session_launch_reservations SET consumed_session_id = ? WHERE id = ?")
        .run(codexA.id, reservation.id),
    ).toThrow(/CHECK constraint failed|live session fence/i);
    expect(() =>
      server.store.sqlite
        .prepare("UPDATE session_launch_reservations SET state = 'CONSUMED' WHERE id = ?")
        .run(reservation.id),
    ).toThrow(/CHECK constraint failed|live session fence/i);
    expect(() =>
      server.store.sqlite
        .prepare(
          `INSERT INTO session_launch_reservations(
             id, project_id, lineage_id, run_id, generation,
             expected_head_session_id, state, created_at, updated_at
           )
           SELECT 'rsr_direct_second', project_id, lineage_id, 'run_db_reservation_second',
                  generation + 1, expected_head_session_id, 'ISSUED', created_at, updated_at
             FROM session_launch_reservations WHERE id = ?`,
        )
        .run(reservation.id),
    ).toThrow(/UNIQUE constraint failed/i);
  });

  it("prevents reverse session identity updates from corrupting explicit recipients", () => {
    const sender = register({ agentId: "manual:claude", client: "fake-client", cwd: workerA });
    const target = register({ agentId: "manual:codex", client: "fake-client", cwd: workerB });
    server.store.postMessage(server.credentials.agent.principal, projectId, {
      fromAgentId: sender.agentId,
      fromSessionId: sender.id,
      recipients: [{ agentId: target.agentId, sessionId: target.id }],
      type: "QUESTION",
      priority: "IMPORTANT",
      requiresAck: true,
      requiresResponse: true,
      summary: "reverse identity guard",
      idempotencyKey: "reverse-identity-recipient",
    });
    const now = "2026-08-01T00:00:00.000Z";
    server.store.sqlite
      .prepare(
        `INSERT INTO projects(id, name, current_sequence, created_at, updated_at)
         VALUES ('prj_reverse_identity_foreign', 'foreign', 0, ?, ?)`,
      )
      .run(now, now);
    const probe = (sql: string): string | null => {
      server.store.sqlite.exec("SAVEPOINT reverse_identity_probe");
      try {
        server.store.sqlite.prepare(sql).run(target.id);
        return null;
      } catch (error) {
        return String(error);
      } finally {
        server.store.sqlite.exec(
          "ROLLBACK TO reverse_identity_probe; RELEASE reverse_identity_probe",
        );
      }
    };

    const errors = {
      agent: probe("UPDATE agent_sessions SET agent_id = 'manual:claude' WHERE id = ?"),
      project: probe(
        "UPDATE agent_sessions SET project_id = 'prj_reverse_identity_foreign' WHERE id = ?",
      ),
    };
    expect(errors).toEqual({
      agent: expect.stringMatching(/explicit message recipient binding/i),
      project: expect.stringMatching(/explicit message recipient binding/i),
    });
    expect(server.store.getSession(target.id)).toMatchObject({
      projectId,
      agentId: "manual:codex",
    });
  });

  it("keeps an active reservation ISSUED across reverse update and delete attempts", () => {
    const reservation = server.store.reserveSessionLaunch(projectId, {
      agentId: "codex",
      client: "codex-app-server",
      deliveryMode: "app_server_push",
      externalThreadId: "reverse-reservation-thread",
      runId: "run_reverse_reservation",
      idempotencyKey: "reverse-reservation",
    });
    const probe = (sql: string): string | null => {
      server.store.sqlite.exec("SAVEPOINT reverse_reservation_probe");
      try {
        server.store.sqlite.prepare(sql).run(reservation.id);
        return null;
      } catch (error) {
        return String(error);
      } finally {
        server.store.sqlite.exec(
          "ROLLBACK TO reverse_reservation_probe; RELEASE reverse_reservation_probe",
        );
      }
    };

    const errors = {
      update: probe("UPDATE session_launch_reservations SET state = 'SUPERSEDED' WHERE id = ?"),
      delete: probe("DELETE FROM session_launch_reservations WHERE id = ?"),
    };
    expect(errors).toEqual({
      update: expect.stringMatching(/active reservation/i),
      delete: expect.stringMatching(/active reservation/i),
    });
    expect(
      server.store.sqlite
        .prepare("SELECT state FROM session_launch_reservations WHERE id = ?")
        .get(reservation.id),
    ).toEqual({ state: "ISSUED" });
    expect(
      server.store.sqlite
        .prepare("SELECT active_reservation_id FROM session_lineages WHERE id = ?")
        .get(reservation.lineageId),
    ).toEqual({ active_reservation_id: reservation.id });

    const successor = server.store.reserveSessionLaunch(projectId, {
      agentId: "codex",
      client: "codex-app-server",
      deliveryMode: "app_server_push",
      externalThreadId: "reverse-reservation-thread",
      runId: "run_reverse_reservation_successor",
      idempotencyKey: "reverse-reservation-successor",
    });
    expect(
      server.store.sqlite
        .prepare("SELECT state FROM session_launch_reservations WHERE id = ?")
        .get(reservation.id),
    ).toEqual({ state: "SUPERSEDED" });
    expect(successor).toMatchObject({
      lineageId: reservation.lineageId,
      generation: reservation.generation + 1,
      state: "ISSUED",
    });
    expect(
      server.store.sqlite
        .prepare("SELECT active_reservation_id FROM session_lineages WHERE id = ?")
        .get(reservation.lineageId),
    ).toEqual({ active_reservation_id: successor.id });
  });

  it("rolls back a late reservation-consume failure and safely retries the same registration", () => {
    const reservation = server.store.reserveSessionLaunch(projectId, {
      agentId: "codex",
      client: "codex-app-server",
      deliveryMode: "app_server_push",
      externalThreadId: "late-consume-thread",
      runId: "run_late_consume",
      idempotencyKey: "reserve-late-consume",
    });
    const eventCountBefore = (
      server.store.sqlite
        .prepare("SELECT COUNT(*) AS count FROM events WHERE project_id = ?")
        .get(projectId) as { count: number }
    ).count;
    const registration = {
      projectId,
      agentId: "codex",
      role: "primary" as const,
      client: "codex-app-server",
      transport: "websocket",
      deliveryMode: "app_server_push",
      externalThreadId: "late-consume-thread",
      cwd: workerA,
      capabilities: [],
      expectedHeadSessionId: reservation.expectedHeadSessionId,
      launcherRunId: reservation.runId,
      launchGeneration: reservation.generation,
      idempotencyKey: "register-late-consume",
    };
    server.store.sqlite.exec(`
      CREATE TEMP TRIGGER fail_late_reservation_consume
      BEFORE UPDATE OF state ON session_launch_reservations
      WHEN OLD.id = '${reservation.id}' AND NEW.state = 'CONSUMED'
      BEGIN
        SELECT RAISE(ABORT, 'forced late consume failure');
      END;
    `);

    expect(() => server.store.registerSession(registration)).toThrow(
      /forced late consume failure/i,
    );
    expect(
      server.store.sqlite
        .prepare("SELECT state, consumed_session_id FROM session_launch_reservations WHERE id = ?")
        .get(reservation.id),
    ).toEqual({ state: "ISSUED", consumed_session_id: null });
    expect(
      server.store.sqlite
        .prepare(
          `SELECT head_session_id, head_incarnation
             FROM session_lineages WHERE id = ?`,
        )
        .get(reservation.lineageId),
    ).toEqual({ head_session_id: null, head_incarnation: 0 });
    expect(
      server.store.sqlite
        .prepare("SELECT COUNT(*) AS count FROM agent_sessions WHERE launcher_run_id = ?")
        .get(reservation.runId),
    ).toEqual({ count: 0 });
    expect(
      server.store.sqlite
        .prepare(
          "SELECT COUNT(*) AS count FROM idempotency_keys WHERE project_id = ? AND operation LIKE 'session.register%'",
        )
        .get(projectId),
    ).toEqual({ count: 0 });
    expect(
      server.store.sqlite
        .prepare("SELECT COUNT(*) AS count FROM events WHERE project_id = ?")
        .get(projectId),
    ).toEqual({ count: eventCountBefore });
    expect(
      server.store.sqlite
        .prepare("SELECT active_reservation_id FROM session_lineages WHERE id = ?")
        .get(reservation.lineageId),
    ).toEqual({ active_reservation_id: reservation.id });

    server.store.sqlite.exec("DROP TRIGGER fail_late_reservation_consume");
    const session = server.store.registerSession(registration);
    expect(session).toMatchObject({
      launcherRunId: reservation.runId,
      launchGeneration: reservation.generation,
      connectionState: "ONLINE",
    });
    expect(
      server.store.sqlite
        .prepare("SELECT state, consumed_session_id FROM session_launch_reservations WHERE id = ?")
        .get(reservation.id),
    ).toEqual({ state: "CONSUMED", consumed_session_id: session.id });
    expect(
      server.store.sqlite
        .prepare("SELECT active_reservation_id FROM session_lineages WHERE id = ?")
        .get(reservation.lineageId),
    ).toEqual({ active_reservation_id: null });
  });
});

describe("live session fence forward migration", () => {
  it("repairs the deployed draft's aligned stale consumed-reservation pointer", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "hub-live-fence-stale-active-"));
    const sqlite = openVersionFiveLiveDraft(resolve(root, "hub.db"));
    seedVersionFiveFenceRows(sqlite);
    sqlite.prepare("DELETE FROM session_launch_reservations WHERE id = 'rsr_fence_a_2'").run();
    sqlite
      .prepare(
        `UPDATE session_lineages
            SET reserved_generation = 1, active_reservation_id = 'rsr_fence_a_1'
          WHERE id = 'lin_fence_a'`,
      )
      .run();

    await migrate(sqlite, ":memory:", false);

    expect(
      sqlite
        .prepare(
          `SELECT active_reservation_id
             FROM session_lineages
            WHERE id = 'lin_fence_a'`,
        )
        .get(),
    ).toEqual({ active_reservation_id: null });
    expect(
      sqlite
        .prepare(
          `SELECT state, consumed_session_id
             FROM session_launch_reservations
            WHERE id = 'rsr_fence_a_1'`,
        )
        .get(),
    ).toEqual({ state: "CONSUMED", consumed_session_id: "ses_fence_a" });
    sqlite.close();
  });

  it("upgrades an already-recorded version 5 database and rejects malformed fence writes", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "hub-live-fence-upgrade-"));
    const sqlite = openVersionFiveLiveDraft(resolve(root, "hub.db"));
    seedVersionFiveFenceRows(sqlite);

    const lineageTypes = sqlite.prepare(
      `SELECT typeof(head_incarnation) AS head_type,
              typeof(reserved_generation) AS reserved_type,
              typeof(head_run_generation) AS run_type
         FROM session_lineages WHERE id = 'lin_fence_a'`,
    );
    sqlite
      .prepare(
        `UPDATE session_lineages
            SET head_incarnation = 'corrupt', reserved_generation = 'corrupt',
                head_run_generation = 'corrupt'
          WHERE id = 'lin_fence_a'`,
      )
      .run();
    expect(lineageTypes.get()).toEqual({
      head_type: "text",
      reserved_type: "text",
      run_type: "text",
    });
    sqlite
      .prepare(
        `UPDATE session_lineages
            SET head_incarnation = 1, reserved_generation = 2, head_run_generation = 1
          WHERE id = 'lin_fence_a'`,
      )
      .run();
    sqlite
      .prepare("UPDATE session_launch_reservations SET generation = 'corrupt' WHERE id = ?")
      .run("rsr_fence_a_1");
    expect(
      sqlite
        .prepare(
          "SELECT typeof(generation) AS generation_type FROM session_launch_reservations WHERE id = ?",
        )
        .get("rsr_fence_a_1"),
    ).toEqual({ generation_type: "text" });
    sqlite
      .prepare("UPDATE session_launch_reservations SET generation = 1 WHERE id = ?")
      .run("rsr_fence_a_1");

    await migrate(sqlite, ":memory:", false);
    expect(
      sqlite.prepare("SELECT version, name FROM schema_migrations WHERE version = 6").get(),
    ).toEqual({ version: 6, name: "0006_live_session_fences.sql" });

    sqlite
      .prepare(
        `INSERT INTO agent_sessions(
           id, project_id, agent_id, role, client, transport, delivery_mode,
           external_thread_id, host, cwd, capabilities_json, connected_at,
           transport_last_seen_at, active_files_json, work_state, connection_state,
           lineage_id, incarnation, launcher_run_id, launch_generation
         ) VALUES (
           'ses_fence_a_wrong_run', 'prj_fence_a', 'codex', 'primary',
           'codex-app-server', 'websocket', 'app_server_push', 'thread-a', 'test',
           'R:/fence-a-wrong-run', '[]', '2026-07-31T00:00:00.000Z',
           '2026-07-31T00:00:00.000Z', '[]', 'IDLE', 'CLOSED',
           'lin_fence_a', 2, 'run_fence_a_wrong', 1
         )`,
      )
      .run();

    for (const statement of [
      "UPDATE session_lineages SET head_incarnation = 'corrupt' WHERE id = 'lin_fence_a'",
      "UPDATE session_lineages SET reserved_generation = 'corrupt' WHERE id = 'lin_fence_a'",
      "UPDATE session_lineages SET head_run_generation = 'corrupt' WHERE id = 'lin_fence_a'",
      "UPDATE session_lineages SET head_incarnation = 0 WHERE id = 'lin_fence_a'",
      "UPDATE session_lineages SET reserved_generation = 1 WHERE id = 'lin_fence_a'",
      "UPDATE session_launch_reservations SET generation = 'corrupt' WHERE id = 'rsr_fence_a_1'",
      "UPDATE session_lineages SET head_session_id = 'ses_fence_b' WHERE id = 'lin_fence_a'",
      "UPDATE session_lineages SET head_session_id = 'ses_fence_a_peer' WHERE id = 'lin_fence_a'",
      "UPDATE session_lineages SET active_reservation_id = 'rsr_fence_b_2' WHERE id = 'lin_fence_a'",
      "UPDATE session_lineages SET active_reservation_id = 'rsr_fence_a_peer_1' WHERE id = 'lin_fence_a'",
      "UPDATE session_lineages SET head_run_id = 'run_fence_b_1' WHERE id = 'lin_fence_a'",
      "UPDATE session_lineages SET head_run_id = 'run_fence_a_peer_1' WHERE id = 'lin_fence_a'",
      "UPDATE session_lineages SET head_run_id = 'run_fence_a_2', head_run_generation = 2 WHERE id = 'lin_fence_a'",
      "UPDATE session_launch_reservations SET project_id = 'prj_fence_b' WHERE id = 'rsr_fence_a_1'",
      "UPDATE session_launch_reservations SET lineage_id = 'lin_fence_a_peer' WHERE id = 'rsr_fence_a_1'",
      "UPDATE session_launch_reservations SET consumed_session_id = 'ses_fence_b' WHERE id = 'rsr_fence_a_1'",
      "UPDATE session_launch_reservations SET consumed_session_id = 'ses_fence_a_peer' WHERE id = 'rsr_fence_a_1'",
      "UPDATE session_launch_reservations SET consumed_session_id = 'ses_fence_a_wrong_run' WHERE id = 'rsr_fence_a_1'",
      "UPDATE agent_sessions SET project_id = 'prj_fence_b' WHERE id = 'ses_fence_a'",
      "UPDATE agent_sessions SET lineage_id = 'lin_fence_a_peer' WHERE id = 'ses_fence_a'",
      "UPDATE agent_sessions SET launcher_run_id = 'run_fence_a_wrong' WHERE id = 'ses_fence_a'",
      "UPDATE agent_sessions SET launch_generation = 2 WHERE id = 'ses_fence_a'",
    ]) {
      expect(() => sqlite.exec(statement), statement).toThrow(/live session fence/i);
    }

    sqlite
      .prepare(
        `UPDATE agent_sessions
            SET launcher_run_id = 'run_fence_a_1', launch_generation = 2
          WHERE id = 'ses_fence_a_wrong_run'`,
      )
      .run();
    expect(() =>
      sqlite
        .prepare(
          `UPDATE session_launch_reservations
              SET consumed_session_id = 'ses_fence_a_wrong_run'
            WHERE id = 'rsr_fence_a_1'`,
        )
        .run(),
    ).toThrow(/live session fence/i);

    expect(() =>
      sqlite.exec(
        `INSERT INTO session_launch_reservations(
           id, project_id, lineage_id, run_id, generation, expected_head_session_id,
           state, consumed_session_id, created_at, updated_at
         ) VALUES (
           'rsr_cross_project', 'prj_fence_a', 'lin_fence_b', 'run_cross_project', 3,
           'ses_fence_b', 'ISSUED', NULL,
           '2026-07-31T00:00:00.000Z', '2026-07-31T00:00:00.000Z'
         )`,
      ),
    ).toThrow(/live session fence/i);
    sqlite.close();
  });

  it("rolls version 6 back atomically when the existing version 5 graph is corrupt", async () => {
    const corruptions = [
      [
        "numeric lineage generation",
        "UPDATE session_lineages SET head_incarnation = 'corrupt' WHERE id = 'lin_fence_a'",
      ],
      [
        "cross-project head",
        "UPDATE session_lineages SET head_session_id = 'ses_fence_b' WHERE id = 'lin_fence_a'",
      ],
      [
        "cross-lineage active reservation",
        "UPDATE session_lineages SET active_reservation_id = 'rsr_fence_a_peer_1' WHERE id = 'lin_fence_a'",
      ],
      [
        "head run that does not identify the head session",
        "UPDATE session_lineages SET head_run_id = 'run_fence_a_2', head_run_generation = 2 WHERE id = 'lin_fence_a'",
      ],
      [
        "reservation project that does not identify its lineage",
        "UPDATE session_launch_reservations SET project_id = 'prj_fence_b' WHERE id = 'rsr_fence_a_1'",
      ],
      [
        "consumed session outside the reservation lineage",
        `UPDATE agent_sessions
            SET launcher_run_id = 'run_fence_a_1', launch_generation = 1
          WHERE id = 'ses_fence_a_peer';
         UPDATE session_launch_reservations
            SET consumed_session_id = 'ses_fence_a_peer'
          WHERE id = 'rsr_fence_a_1'`,
      ],
    ] as const;

    for (const [label, statement] of corruptions) {
      const root = mkdtempSync(resolve(tmpdir(), "hub-live-fence-dirty-"));
      const sqlite = openVersionFiveLiveDraft(resolve(root, "hub.db"));
      try {
        seedVersionFiveFenceRows(sqlite);
        sqlite.exec(statement);

        await expect(migrate(sqlite, ":memory:", false), label).rejects.toThrow(
          /live.session.fence/i,
        );
        expect(
          sqlite.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 6").get(),
          label,
        ).toEqual({ count: 0 });
        expect(
          sqlite
            .prepare(
              `SELECT COUNT(*) AS count FROM sqlite_master
                WHERE type = 'trigger' AND name LIKE 'live_session_fence_%'`,
            )
            .get(),
          label,
        ).toEqual({ count: 0 });
      } finally {
        sqlite.close();
      }
    }
    // No explicit timeout: this migrates several databases in a loop and was given 10s back when
    // the suite default was 5s. The default is now higher than that, so naming it here only caps
    // the test lower than every other one.
  });

  it("installs version 6 fences and all forward invariant migrations on a fresh database", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "hub-live-fence-fresh-"));
    const server = await createHubServer({
      databasePath: resolve(root, "hub.db"),
      dataDir: resolve(root, "data"),
      dashboardDir: resolve(root, "missing-dashboard"),
      host: "127.0.0.1",
      port: 0,
      logLevel: "silent",
    });
    try {
      expect(
        server.store.sqlite.prepare("SELECT MAX(version) AS version FROM schema_migrations").get(),
      ).toEqual({ version: 15 });
      expect(
        server.store.sqlite
          .prepare(
            `SELECT name FROM sqlite_master
              WHERE type = 'trigger' AND name LIKE 'live_session_fence_%'
              ORDER BY name`,
          )
          .all(),
      ).toEqual([
        { name: "live_session_fence_lineage_insert" },
        { name: "live_session_fence_lineage_update" },
        { name: "live_session_fence_reservation_insert" },
        { name: "live_session_fence_reservation_update" },
        { name: "live_session_fence_session_identity_update" },
      ]);
      expect(
        server.store.sqlite
          .prepare(
            `SELECT name FROM sqlite_master
              WHERE type = 'table' AND name IN (
                'auth_principals', 'auth_credentials', 'capture_session_bindings',
                'synthetic_prompt_reservations', 'user_turns', 'user_turn_capture_receipts'
              ) ORDER BY name`,
          )
          .all(),
      ).toHaveLength(6);
      expect(
        server.store.sqlite.prepare("SELECT count(*) AS count FROM auth_principals").get(),
      ).toEqual({ count: 9 });
    } finally {
      await server.app.close();
    }
  });

  it("fails version 7 loudly and atomically when an authority table was pre-created incorrectly", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "hub-authority-precreated-"));
    const sqlite = openVersionFiveLiveDraft(resolve(root, "hub.db"));
    try {
      seedVersionFiveFenceRows(sqlite);
      const projectsBefore = sqlite.prepare("SELECT * FROM projects ORDER BY id").all();
      const sessionsBefore = sqlite.prepare("SELECT * FROM agent_sessions ORDER BY id").all();
      sqlite.exec("CREATE TABLE auth_principals(id TEXT PRIMARY KEY)");

      await expect(migrate(sqlite, ":memory:", false)).rejects.toThrow(
        /auth_principals already exists/i,
      );
      expect(
        sqlite.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all(),
      ).toContainEqual({ version: 6, name: "0006_live_session_fences.sql" });
      expect(
        sqlite.prepare("SELECT count(*) AS count FROM schema_migrations WHERE version = 7").get(),
      ).toEqual({ count: 0 });
      expect(sqlite.prepare("PRAGMA table_info(auth_principals)").all()).toHaveLength(1);
      expect(
        sqlite
          .prepare(
            `SELECT count(*) AS count FROM sqlite_master
              WHERE type = 'table' AND name IN (
                'auth_credentials', 'capture_session_bindings', 'synthetic_prompt_reservations',
                'user_turns', 'user_turn_capture_receipts'
              )`,
          )
          .get(),
      ).toEqual({ count: 0 });
      expect(sqlite.prepare("SELECT * FROM projects ORDER BY id").all()).toEqual(projectsBefore);
      expect(sqlite.prepare("SELECT * FROM agent_sessions ORDER BY id").all()).toEqual(
        sessionsBefore,
      );
      expect(sqlite.pragma("foreign_key_check")).toEqual([]);
    } finally {
      sqlite.close();
    }
  });
});

describe("session lineage migration", () => {
  it("forward-migrates the live version-five draft to strict monotonic fences", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "hub-live-v5-forward-migration-"));
    const databasePath = resolve(root, "hub.db");
    const liveDraft = openVersionFiveLiveDraft(databasePath);
    seedVersionFiveFenceRows(liveDraft);

    liveDraft.exec("SAVEPOINT weak_fence_probe");
    expect(() =>
      liveDraft
        .prepare(
          `UPDATE session_lineages
              SET head_incarnation = 'poison',
                  reserved_generation = 'poison',
                  head_run_generation = 'poison'
            WHERE id = 'lin_fence_a'`,
        )
        .run(),
    ).not.toThrow();
    expect(() =>
      liveDraft
        .prepare(
          "UPDATE session_launch_reservations SET generation = 'poison' WHERE id = 'rsr_fence_a_2'",
        )
        .run(),
    ).not.toThrow();
    expect(
      liveDraft
        .prepare(
          `SELECT typeof(head_incarnation) AS head_type,
                  typeof(reserved_generation) AS reserved_type,
                  typeof(head_run_generation) AS run_type
             FROM session_lineages
            WHERE id = 'lin_fence_a'`,
        )
        .get(),
    ).toEqual({ head_type: "text", reserved_type: "text", run_type: "text" });
    liveDraft.exec("ROLLBACK TO weak_fence_probe; RELEASE weak_fence_probe");

    const rowsBefore = {
      lineages: liveDraft.prepare("SELECT * FROM session_lineages ORDER BY id").all(),
      reservations: liveDraft
        .prepare("SELECT * FROM session_launch_reservations ORDER BY id")
        .all(),
    };
    await migrate(liveDraft, databasePath, true);

    expect(
      liveDraft.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all(),
    ).toContainEqual({
      version: 6,
      name: "0006_live_session_fences.sql",
    });
    expect(
      liveDraft.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all(),
    ).toContainEqual({
      version: 7,
      name: "0007_authority_principals_user_turns.sql",
    });
    expect(liveDraft.prepare("SELECT * FROM session_lineages ORDER BY id").all()).toEqual(
      rowsBefore.lineages,
    );
    expect(
      liveDraft.prepare("SELECT * FROM session_launch_reservations ORDER BY id").all(),
    ).toEqual(rowsBefore.reservations);
    expect(liveDraft.pragma("foreign_key_check")).toEqual([]);

    expect(() =>
      liveDraft
        .prepare("UPDATE session_lineages SET head_incarnation = 'poison' WHERE id = 'lin_fence_a'")
        .run(),
    ).toThrow(/live session fence/i);
    expect(() =>
      liveDraft
        .prepare(
          "UPDATE session_lineages SET reserved_generation = 'poison' WHERE id = 'lin_fence_a'",
        )
        .run(),
    ).toThrow(/live session fence/i);
    expect(() =>
      liveDraft
        .prepare(
          "UPDATE session_lineages SET head_run_generation = 'poison' WHERE id = 'lin_fence_a'",
        )
        .run(),
    ).toThrow(/live session fence/i);
    expect(() =>
      liveDraft
        .prepare(
          "UPDATE session_launch_reservations SET generation = 'poison' WHERE id = 'rsr_fence_a_2'",
        )
        .run(),
    ).toThrow(/live session fence/i);
    liveDraft.close();
  });

  it("backfills a legacy succession chain and keeps the migrated head as the registration fence", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "hub-lineage-migration-"));
    const databasePath = resolve(root, "hub.db");
    const migrationOnePath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../../migrations/0001_initial.sql",
    );
    const legacy = new Database(databasePath);
    legacy.pragma("foreign_keys = ON");
    legacy.exec(readFileSync(migrationOnePath, "utf8"));
    legacy
      .prepare("INSERT INTO schema_migrations(version, name, applied_at) VALUES (1, ?, ?)")
      .run("0001_initial.sql", "2026-07-30T00:00:00.000Z");
    legacy
      .prepare(
        `INSERT INTO projects(id, name, current_sequence, created_at, updated_at)
         VALUES (?, ?, 4, ?, ?)`,
      )
      .run(
        "prj_legacy",
        "legacy lineage fixture",
        "2026-07-30T00:00:00.000Z",
        "2026-07-30T00:00:00.000Z",
      );
    const insertLegacySession = legacy.prepare(
      `INSERT INTO agent_sessions(
         id, project_id, agent_id, role, client, transport, delivery_mode,
         external_session_id, external_thread_id, host, cwd, capabilities_json,
         connected_at, transport_last_seen_at, active_files_json, work_state,
         connection_state, closed_at
       ) VALUES (?, 'prj_legacy', 'codex', 'primary', 'codex-app-server', 'app_server',
         'app_server_push', ?, ?, 'legacy-host', ?, '[]', ?, ?, '[]', 'IDLE', ?, ?)`,
    );
    const cwd = mkdtempSync(resolve(tmpdir(), "hub-lineage-worker-"));
    insertLegacySession.run(
      "ses_thread_a_old",
      null,
      "thread-a",
      cwd,
      "2026-07-30T00:01:00.000Z",
      "2026-07-30T00:01:00.000Z",
      "CLOSED",
      "2026-07-30T00:02:00.000Z",
    );
    insertLegacySession.run(
      "ses_thread_a_head",
      null,
      "thread-a",
      cwd,
      "2026-07-30T00:01:00.000Z",
      "2026-07-30T00:03:00.000Z",
      "ONLINE",
      null,
    );
    insertLegacySession.run(
      "ses_thread_b_head",
      null,
      "thread-b",
      cwd,
      "2026-07-30T00:04:00.000Z",
      "2026-07-30T00:04:00.000Z",
      "ONLINE",
      null,
    );
    insertLegacySession.run(
      "ses_generic",
      null,
      null,
      cwd,
      "2026-07-30T00:05:00.000Z",
      "2026-07-30T00:05:00.000Z",
      "ONLINE",
      null,
    );
    insertLegacySession.run(
      "ses_empty_thread_fallback",
      "fallback-session",
      "",
      cwd,
      "2026-07-30T00:06:00.000Z",
      "2026-07-30T00:06:00.000Z",
      "ONLINE",
      null,
    );
    insertLegacySession.run(
      "ses_double_empty",
      "",
      "",
      cwd,
      "2026-07-30T00:07:00.000Z",
      "2026-07-30T00:07:00.000Z",
      "ONLINE",
      null,
    );
    const insertRegistrationEvent = legacy.prepare(
      `INSERT INTO events(
         id, project_id, sequence, type, actor_type, actor_id, aggregate_type,
         aggregate_id, payload_json, created_at
       ) VALUES (?, 'prj_legacy', ?, 'session.registered', 'agent', 'codex',
         'session', ?, '{}', ?)`,
    );
    insertRegistrationEvent.run(
      "evt_thread_a_old",
      1,
      "ses_thread_a_old",
      "2026-07-30T00:01:00.000Z",
    );
    insertRegistrationEvent.run(
      "evt_thread_a_head",
      2,
      "ses_thread_a_head",
      "2026-07-30T00:03:00.000Z",
    );
    insertRegistrationEvent.run(
      "evt_thread_b_head",
      3,
      "ses_thread_b_head",
      "2026-07-30T00:04:00.000Z",
    );
    insertRegistrationEvent.run(
      "evt_empty_thread_fallback",
      4,
      "ses_empty_thread_fallback",
      "2026-07-30T00:06:00.000Z",
    );
    legacy.close();

    const server = await createHubServer({
      databasePath,
      dataDir: resolve(root, "data"),
      dashboardDir: resolve(root, "missing-dashboard"),
      host: "127.0.0.1",
      port: 0,
      logLevel: "silent",
    });
    try {
      const head = server.store.getSessionLineageHead("prj_legacy", {
        agentId: "codex",
        client: "codex-app-server",
        deliveryMode: "app_server_push",
        externalThreadId: "thread-a",
      });
      expect(head).toMatchObject({
        headSessionId: "ses_thread_a_head",
        headIncarnation: 2,
        version: 2,
      });
      expect(server.store.getSession("ses_thread_a_old")).toMatchObject({
        incarnation: 1,
        predecessorSessionId: null,
        supersededBySessionId: "ses_thread_a_head",
      });
      expect(server.store.getSession("ses_thread_a_head")).toMatchObject({
        incarnation: 2,
        predecessorSessionId: "ses_thread_a_old",
        supersededBySessionId: null,
      });
      expect(
        server.store.getSessionLineageHead("prj_legacy", {
          agentId: "codex",
          client: "codex-app-server",
          deliveryMode: "app_server_push",
          externalThreadId: "thread-b",
        }),
      ).toMatchObject({
        headSessionId: "ses_thread_b_head",
        headIncarnation: 1,
        version: 1,
      });
      expect(server.store.getSession("ses_generic")).toMatchObject({
        lineageId: null,
        incarnation: null,
      });
      expect(
        server.store.getSessionLineageHead("prj_legacy", {
          agentId: "codex",
          client: "codex-app-server",
          deliveryMode: "app_server_push",
          externalSessionId: "fallback-session",
        }),
      ).toMatchObject({ headSessionId: "ses_empty_thread_fallback", headIncarnation: 1 });
      expect(server.store.getSession("ses_double_empty")).toMatchObject({
        lineageId: null,
        incarnation: null,
      });

      const before = server.store.listSessions("prj_legacy").length;
      const staleReservation = server.store.reserveSessionLaunch("prj_legacy", {
        agentId: "codex",
        client: "codex-app-server",
        deliveryMode: "app_server_push",
        externalThreadId: "thread-a",
        runId: "run_stale_after_backfill",
        idempotencyKey: "reserve-stale-after-backfill",
      });
      let staleError: unknown;
      try {
        server.store.registerSession({
          projectId: "prj_legacy",
          agentId: "codex",
          role: "primary",
          client: "codex-app-server",
          transport: "app_server",
          deliveryMode: "app_server_push",
          externalThreadId: "thread-a",
          cwd,
          capabilities: [],
          expectedHeadSessionId: "ses_thread_a_old",
          launcherRunId: staleReservation.runId,
          launchGeneration: staleReservation.generation,
          idempotencyKey: "stale-after-backfill",
        });
      } catch (error) {
        staleError = error;
      }
      expect(staleError).toMatchObject({
        statusCode: 409,
        code: "SESSION_LAUNCH_FENCE_STALE",
      });
      expect(server.store.listSessions("prj_legacy")).toHaveLength(before);
      expect(
        server.store.getSessionLineageHead("prj_legacy", {
          agentId: "codex",
          client: "codex-app-server",
          deliveryMode: "app_server_push",
          externalThreadId: "thread-a",
        }),
      ).toMatchObject({
        headSessionId: "ses_thread_a_head",
        headIncarnation: 2,
        version: 3,
      });
      const backupDir = resolve(root, "backups", "pre-migration");
      const backupsBeforeRerun = readdirSync(backupDir).filter((file) => file.endsWith(".db"));
      await migrate(server.store.sqlite, databasePath, true);
      await migrate(server.store.sqlite, databasePath, true);
      expect(
        server.store.sqlite.prepare("SELECT version FROM schema_migrations ORDER BY version").all(),
      ).toEqual([
        { version: 1 },
        { version: 2 },
        { version: 3 },
        { version: 4 },
        { version: 5 },
        { version: 6 },
        { version: 7 },
        { version: 8 },
        { version: 9 },
        { version: 10 },
        { version: 11 },
        { version: 12 },
        { version: 13 },
        { version: 14 },
        { version: 15 },
      ]);
      expect(readdirSync(backupDir).filter((file) => file.endsWith(".db"))).toEqual(
        backupsBeforeRerun,
      );
    } finally {
      await server.app.close();
    }
  });

  it("moves every active legacy owner to the migrated head before later succession", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "hub-legacy-owner-migration-"));
    const databasePath = resolve(root, "hub.db");
    const migrationOnePath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../../migrations/0001_initial.sql",
    );
    const legacy = new Database(databasePath);
    legacy.pragma("foreign_keys = ON");
    legacy.exec(readFileSync(migrationOnePath, "utf8"));
    legacy
      .prepare("INSERT INTO schema_migrations(version, name, applied_at) VALUES (1, ?, ?)")
      .run("0001_initial.sql", "2026-07-30T00:00:00.000Z");
    const createdAt = "2026-07-30T00:00:00.000Z";
    legacy
      .prepare(
        `INSERT INTO projects(id, name, current_sequence, created_at, updated_at)
         VALUES ('prj_owners', 'legacy ownership fixture', 3, ?, ?)`,
      )
      .run(createdAt, createdAt);
    legacy
      .prepare(
        `INSERT INTO objectives(
           id, project_id, title, description, definition_of_done_json, status,
           weight, created_at, updated_at
         ) VALUES (
           'obj_owners', 'prj_owners', 'migrate ownership', '', '[]', 'ACTIVE',
           1, ?, ?
         )`,
      )
      .run(createdAt, createdAt);
    const cwd = mkdtempSync(resolve(tmpdir(), "hub-legacy-owner-worker-"));
    const insertSession = legacy.prepare(
      `INSERT INTO agent_sessions(
         id, project_id, agent_id, role, client, transport, delivery_mode,
         external_session_id, external_thread_id, host, cwd, capabilities_json,
         connected_at, transport_last_seen_at, active_files_json, work_state,
         connection_state, current_review_id
       ) VALUES (
         ?, 'prj_owners', 'codex', 'primary', 'codex-app-server', 'app_server',
         'app_server_push', 'owners-thread', 'owners-thread', 'legacy-host', ?, '[]',
         ?, ?, '[]', ?, 'ONLINE', ?
       )`,
    );
    insertSession.run(
      "ses_owner_a",
      cwd,
      "2026-07-30T00:01:00.000Z",
      "2026-07-30T00:01:00.000Z",
      "WORKING",
      "rev_legacy_active",
    );
    insertSession.run(
      "ses_owner_b",
      cwd,
      "2026-07-30T00:02:00.000Z",
      "2026-07-30T00:02:00.000Z",
      "WORKING",
      null,
    );
    insertSession.run(
      "ses_owner_c",
      cwd,
      "2026-07-30T00:03:00.000Z",
      "2026-07-30T00:03:00.000Z",
      "IDLE",
      null,
    );
    legacy
      .prepare(
        `INSERT INTO tasks(
           id, project_id, objective_id, title, description, status, priority,
           owner_agent_id, owner_session_id, capability_tags_json, scope_globs_json,
           protected_scope, review_required, computed_progress, weight, claim_stale_at,
           created_at, updated_at
         ) VALUES (
           'tsk_owner_active', 'prj_owners', 'obj_owners', 'active legacy work', '',
           'IN_REVIEW', 'critical', 'wrong-legacy-agent', 'ses_owner_a', '[]', '[]',
           0, 1, 30, 1, '2026-07-29T00:00:00.000Z', ?, ?
         )`,
      )
      .run(createdAt, "2026-07-30T00:04:00.000Z");
    legacy
      .prepare(
        `INSERT INTO tasks(
           id, project_id, objective_id, title, description, status, priority,
           owner_agent_id, owner_session_id, capability_tags_json, scope_globs_json,
           protected_scope, review_required, computed_progress, weight, created_at, updated_at
         ) VALUES (
           'tsk_owner_done', 'prj_owners', 'obj_owners', 'terminal legacy work', '',
           'DONE', 'normal', 'codex', 'ses_owner_a', '[]', '[]',
           0, 1, 100, 1, ?, ?
         )`,
      )
      .run(createdAt, createdAt);
    legacy
      .prepare(
        `INSERT INTO artifacts(
           id, project_id, task_id, kind, name, media_type, sha256, size_bytes,
           storage_path, metadata_json, created_by_session_id, created_at
         ) VALUES (
           'art_owner_review', 'prj_owners', 'tsk_owner_active', 'patch',
           'legacy review patch', 'application/octet-stream',
           'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
           1, 'legacy/owner.patch', '{}', 'ses_owner_a', ?
         )`,
      )
      .run(createdAt);
    legacy
      .prepare(
        `INSERT INTO reviews(
           id, project_id, task_id, revision, author_agent_id, author_session_id,
           reviewer_agent_id, base_sha, head_sha, patch_sha256, patch_artifact_id,
           changed_files_json, acceptance_criteria_json, test_evidence_json,
           author_claims_json, known_risks_json, status, created_at, updated_at
         ) VALUES (
           'rev_legacy_active', 'prj_owners', 'tsk_owner_active', 1, 'codex',
           'ses_owner_a', 'claude', 'base', 'head',
           'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
           'art_owner_review', '[]', '[]', '[]', '[]', '[]', 'IN_REVIEW', ?, ?
         )`,
      )
      .run(createdAt, createdAt);
    legacy
      .prepare("UPDATE agent_sessions SET current_task_id = ? WHERE id = ?")
      .run("tsk_owner_active", "ses_owner_a");
    const insertIntent = legacy.prepare(
      `INSERT INTO write_intents(
         id, project_id, task_id, session_id, globs_json, symbols_json, mode, reason,
         observed_changed_files_json, expires_at, released_at, created_at, updated_at
       ) VALUES (?, 'prj_owners', 'tsk_owner_active', ?, '[]', '[]', 'exclusive', ?,
         '[]', ?, ?, ?, ?)`,
    );
    insertIntent.run(
      "wri_owner_active",
      "ses_owner_b",
      "active",
      "2099-01-01T00:00:00.000Z",
      null,
      createdAt,
      createdAt,
    );
    insertIntent.run(
      "wri_owner_released",
      "ses_owner_a",
      "released",
      "2099-01-01T00:00:00.000Z",
      "2026-07-30T00:05:00.000Z",
      createdAt,
      "2026-07-30T00:05:00.000Z",
    );
    insertIntent.run(
      "wri_owner_expired",
      "ses_owner_a",
      "expired",
      "2020-01-01T00:00:00.000Z",
      null,
      createdAt,
      createdAt,
    );
    legacy
      .prepare(
        `INSERT INTO threads(id, project_id, subject, status, created_at, updated_at)
         VALUES ('thr_owners', 'prj_owners', 'ownership mail', 'OPEN', ?, ?)`,
      )
      .run(createdAt, createdAt);
    const insertMessage = legacy.prepare(
      `INSERT INTO messages(
         id, project_id, sequence, thread_id, from_agent_id, type, priority,
         requires_ack, requires_response, summary, created_at
       ) VALUES (?, 'prj_owners', ?, 'thr_owners', 'claude', 'QUESTION', 'IMPORTANT',
         1, 1, ?, ?)`,
    );
    const insertRecipient = legacy.prepare(
      `INSERT INTO message_recipients(
         id, message_id, recipient_agent_id, recipient_session_id, state, attempt_count,
         delivered_at, acknowledged_at, processed_at
       ) VALUES (?, ?, 'codex', ?, ?, 1, ?, ?, ?)`,
    );
    insertMessage.run("msg_owner_pending", 1, "pending legacy mail", createdAt);
    insertRecipient.run(
      "rcp_owner_pending",
      "msg_owner_pending",
      "ses_owner_a",
      "PENDING",
      null,
      null,
      null,
    );
    insertMessage.run("msg_owner_ack", 2, "acknowledged legacy mail", createdAt);
    insertRecipient.run(
      "rcp_owner_ack",
      "msg_owner_ack",
      "ses_owner_b",
      "ACKNOWLEDGED",
      createdAt,
      createdAt,
      null,
    );
    insertMessage.run("msg_owner_processed", 3, "terminal legacy mail", createdAt);
    insertRecipient.run(
      "rcp_owner_processed",
      "msg_owner_processed",
      "ses_owner_a",
      "PROCESSED",
      createdAt,
      createdAt,
      createdAt,
    );
    insertMessage.run("msg_owner_delivered", 4, "delivered legacy mail", createdAt);
    insertRecipient.run(
      "rcp_owner_delivered",
      "msg_owner_delivered",
      "ses_owner_a",
      "DELIVERED",
      createdAt,
      null,
      null,
    );
    insertMessage.run("msg_owner_failed", 5, "retryable failed legacy mail", createdAt);
    insertRecipient.run(
      "rcp_owner_failed",
      "msg_owner_failed",
      "ses_owner_b",
      "FAILED",
      createdAt,
      null,
      null,
    );
    const insertEvent = legacy.prepare(
      `INSERT INTO events(
         id, project_id, sequence, type, actor_type, actor_id, aggregate_type,
         aggregate_id, payload_json, created_at
       ) VALUES (?, 'prj_owners', ?, 'session.registered', 'agent', 'codex',
         'session', ?, '{}', ?)`,
    );
    insertEvent.run("evt_owner_a", 1, "ses_owner_a", "2026-07-30T00:01:00.000Z");
    insertEvent.run("evt_owner_b", 2, "ses_owner_b", "2026-07-30T00:02:00.000Z");
    insertEvent.run("evt_owner_c", 3, "ses_owner_c", "2026-07-30T00:03:00.000Z");
    legacy.close();

    const server = await createHubServer({
      databasePath,
      dataDir: resolve(root, "data"),
      dashboardDir: resolve(root, "missing-dashboard"),
      host: "127.0.0.1",
      port: 0,
      logLevel: "silent",
    });
    try {
      expect(server.store.getSession("ses_owner_a")).toMatchObject({
        connectionState: "CLOSED",
        supersededBySessionId: "ses_owner_b",
        currentTaskId: null,
        currentReviewId: null,
      });
      expect(server.store.getSession("ses_owner_b")).toMatchObject({
        connectionState: "CLOSED",
        supersededBySessionId: "ses_owner_c",
      });
      expect(server.store.getSession("ses_owner_c")).toMatchObject({
        connectionState: "ONLINE",
        currentTaskId: "tsk_owner_active",
        currentReviewId: "rev_legacy_active",
        workState: "WORKING",
      });
      expect(server.store.getTask("tsk_owner_active")).toMatchObject({
        ownerAgentId: "codex",
        ownerSessionId: "ses_owner_c",
        claimStaleAt: null,
      });
      expect(server.store.getTask("tsk_owner_done")).toMatchObject({
        ownerSessionId: "ses_owner_a",
        status: "DONE",
      });
      expect(
        server.store.sqlite
          .prepare("SELECT session_id FROM write_intents WHERE id = ?")
          .get("wri_owner_active"),
      ).toEqual({ session_id: "ses_owner_c" });
      expect(
        server.store.sqlite
          .prepare("SELECT session_id FROM write_intents WHERE id = ?")
          .get("wri_owner_released"),
      ).toEqual({ session_id: "ses_owner_a" });
      expect(
        server.store.sqlite
          .prepare("SELECT session_id FROM write_intents WHERE id = ?")
          .get("wri_owner_expired"),
      ).toEqual({ session_id: "ses_owner_a" });
      expect(
        server.store.sqlite
          .prepare("SELECT recipient_session_id FROM message_recipients WHERE id = ?")
          .get("rcp_owner_pending"),
      ).toEqual({ recipient_session_id: "ses_owner_c" });
      expect(
        server.store.sqlite
          .prepare("SELECT recipient_session_id FROM message_recipients WHERE id = ?")
          .get("rcp_owner_ack"),
      ).toEqual({ recipient_session_id: "ses_owner_c" });
      expect(
        server.store.sqlite
          .prepare("SELECT recipient_session_id FROM message_recipients WHERE id = ?")
          .get("rcp_owner_processed"),
      ).toEqual({ recipient_session_id: "ses_owner_a" });
      expect(
        server.store.sqlite
          .prepare(
            `SELECT id, recipient_session_id FROM message_recipients
              WHERE id IN ('rcp_owner_delivered', 'rcp_owner_failed') ORDER BY id`,
          )
          .all(),
      ).toEqual([
        { id: "rcp_owner_delivered", recipient_session_id: "ses_owner_c" },
        { id: "rcp_owner_failed", recipient_session_id: "ses_owner_c" },
      ]);

      const reservation = server.store.reserveSessionLaunch("prj_owners", {
        agentId: "codex",
        client: "codex-app-server",
        deliveryMode: "app_server_push",
        externalThreadId: "owners-thread",
        runId: "run_owner_d",
        idempotencyKey: "reserve-owner-d",
      });
      const successor = server.store.registerSession({
        projectId: "prj_owners",
        agentId: "codex",
        role: "primary",
        client: "codex-app-server",
        transport: "websocket",
        deliveryMode: "app_server_push",
        externalSessionId: "owners-thread",
        externalThreadId: "owners-thread",
        cwd,
        capabilities: [],
        expectedHeadSessionId: reservation.expectedHeadSessionId,
        launcherRunId: reservation.runId,
        launchGeneration: reservation.generation,
        idempotencyKey: "register-owner-d",
      });
      expect(successor).toMatchObject({
        predecessorSessionId: "ses_owner_c",
        currentTaskId: "tsk_owner_active",
        currentReviewId: "rev_legacy_active",
      });
      expect(server.store.getTask("tsk_owner_active").ownerSessionId).toBe(successor.id);
      expect(
        server.store.sqlite
          .prepare("SELECT session_id FROM write_intents WHERE id = ?")
          .get("wri_owner_active"),
      ).toEqual({ session_id: successor.id });
      expect(
        server.store.sqlite
          .prepare(
            `SELECT COUNT(*) AS count
               FROM message_recipients
              WHERE id IN (
                'rcp_owner_pending', 'rcp_owner_ack',
                'rcp_owner_delivered', 'rcp_owner_failed'
              )
                AND recipient_session_id != ?`,
          )
          .get(successor.id),
      ).toEqual({ count: 0 });
      expect(
        server.store.sqlite
          .prepare(
            `SELECT COUNT(*) AS count
               FROM tasks
              WHERE status NOT IN ('BACKLOG', 'READY', 'APPROVED', 'DONE', 'CANCELLED')
                AND owner_session_id IN ('ses_owner_a', 'ses_owner_b', 'ses_owner_c')`,
          )
          .get(),
      ).toEqual({ count: 0 });
      expect(
        server.store.sqlite
          .prepare(
            `SELECT COUNT(*) AS count
               FROM write_intents
              WHERE released_at IS NULL
                AND expires_at > ?
                AND session_id IN ('ses_owner_a', 'ses_owner_b', 'ses_owner_c')`,
          )
          .get(new Date().toISOString()),
      ).toEqual({ count: 0 });
    } finally {
      await server.app.close();
    }
  });

  it("fails the migration atomically when legacy mail mixes agent-wide and explicit ownership", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "hub-mixed-recipient-migration-"));
    const databasePath = resolve(root, "hub.db");
    const migrationOnePath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../../migrations/0001_initial.sql",
    );
    const legacy = new Database(databasePath);
    legacy.pragma("foreign_keys = ON");
    legacy.exec(readFileSync(migrationOnePath, "utf8"));
    legacy
      .prepare("INSERT INTO schema_migrations(version, name, applied_at) VALUES (1, ?, ?)")
      .run("0001_initial.sql", "2026-07-30T00:00:00.000Z");
    legacy
      .prepare(
        `INSERT INTO projects(id, name, current_sequence, created_at, updated_at)
         VALUES ('prj_mixed', 'mixed recipient fixture', 1, ?, ?)`,
      )
      .run("2026-07-30T00:00:00.000Z", "2026-07-30T00:00:00.000Z");
    const cwd = mkdtempSync(resolve(tmpdir(), "hub-mixed-worker-"));
    legacy
      .prepare(
        `INSERT INTO agent_sessions(
           id, project_id, agent_id, role, client, transport, delivery_mode,
           external_session_id, external_thread_id, host, cwd, capabilities_json,
           connected_at, transport_last_seen_at, active_files_json, work_state, connection_state
         ) VALUES (
           'ses_mixed_explicit', 'prj_mixed', 'codex', 'primary', 'codex-app-server',
           'app_server', 'app_server_push', 'mixed-thread', 'mixed-thread', 'legacy-host', ?,
           '[]', ?, ?, '[]', 'IDLE', 'ONLINE'
         )`,
      )
      .run(cwd, "2026-07-30T00:01:00.000Z", "2026-07-30T00:01:00.000Z");
    legacy
      .prepare(
        `INSERT INTO threads(
           id, project_id, subject, status, created_at, updated_at
         ) VALUES ('thr_mixed', 'prj_mixed', 'mixed', 'OPEN', ?, ?)`,
      )
      .run("2026-07-30T00:00:00.000Z", "2026-07-30T00:00:00.000Z");
    legacy
      .prepare(
        `INSERT INTO messages(
           id, project_id, sequence, thread_id, from_agent_id, type, priority,
           requires_ack, requires_response, summary, created_at
         ) VALUES (
           'msg_mixed', 'prj_mixed', 1, 'thr_mixed', 'claude', 'QUESTION', 'IMPORTANT',
           1, 1, 'must not surface twice', ?
         )`,
      )
      .run("2026-07-30T00:02:00.000Z");
    const insertRecipient = legacy.prepare(
      `INSERT INTO message_recipients(
         id, message_id, recipient_agent_id, recipient_session_id, state, attempt_count
       ) VALUES (?, 'msg_mixed', 'codex', ?, 'PENDING', 0)`,
    );
    insertRecipient.run("rcp_mixed_unbound", null);
    insertRecipient.run("rcp_mixed_explicit", "ses_mixed_explicit");
    const before = legacy
      .prepare(
        `SELECT id, recipient_session_id, state, attempt_count, delivered_at,
                acknowledged_at, processed_at, responded_at, last_error
           FROM message_recipients ORDER BY id`,
      )
      .all();

    await expect(migrate(legacy, databasePath, true)).rejects.toThrow(
      /session_surface_migration_safe/,
    );
    expect(legacy.prepare("SELECT version FROM schema_migrations ORDER BY version").all()).toEqual([
      { version: 1 },
      { version: 2 },
      { version: 3 },
      { version: 4 },
    ]);
    expect(
      legacy
        .prepare(
          `SELECT name FROM sqlite_master
            WHERE name IN (
              'session_lineages',
              'session_launch_reservations',
              'message_surface_attempts',
              'ux_message_recipients_unbound_agent'
            )`,
        )
        .all(),
    ).toEqual([]);
    expect(
      legacy
        .prepare("PRAGMA table_info(agent_sessions)")
        .all()
        .map((column: any) => column.name),
    ).not.toContain("lineage_id");
    expect(
      legacy
        .prepare("PRAGMA table_info(message_recipients)")
        .all()
        .map((column: any) => column.name),
    ).not.toContain("surface_fence");
    expect(
      legacy
        .prepare(
          `SELECT id, recipient_session_id, state, attempt_count, delivered_at,
                  acknowledged_at, processed_at, responded_at, last_error
             FROM message_recipients ORDER BY id`,
        )
        .all(),
    ).toEqual(before);
    const backupDir = resolve(root, "backups", "pre-migration");
    expect(existsSync(backupDir)).toBe(true);
    expect(readdirSync(backupDir).filter((file) => file.endsWith(".db"))).toHaveLength(1);
    legacy.close();
  });

  it("fails the migration atomically for an explicit recipient outside the message project", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "hub-invalid-recipient-migration-"));
    const databasePath = resolve(root, "hub.db");
    const migrationOnePath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../../migrations/0001_initial.sql",
    );
    const legacy = new Database(databasePath);
    legacy.pragma("foreign_keys = ON");
    legacy.exec(readFileSync(migrationOnePath, "utf8"));
    legacy
      .prepare("INSERT INTO schema_migrations(version, name, applied_at) VALUES (1, ?, ?)")
      .run("0001_initial.sql", "2026-07-30T00:00:00.000Z");
    const createdAt = "2026-07-30T00:00:00.000Z";
    const insertProject = legacy.prepare(
      `INSERT INTO projects(id, name, current_sequence, created_at, updated_at)
       VALUES (?, ?, 1, ?, ?)`,
    );
    insertProject.run("prj_recipient_a", "recipient project A", createdAt, createdAt);
    insertProject.run("prj_recipient_b", "recipient project B", createdAt, createdAt);
    const cwd = mkdtempSync(resolve(tmpdir(), "hub-invalid-recipient-worker-"));
    legacy
      .prepare(
        `INSERT INTO agent_sessions(
           id, project_id, agent_id, role, client, transport, delivery_mode,
           external_thread_id, host, cwd, capabilities_json, connected_at,
           transport_last_seen_at, active_files_json, work_state, connection_state
         ) VALUES (
           'ses_recipient_foreign', 'prj_recipient_b', 'codex', 'primary',
           'fake-client', 'websocket', 'native_channel', 'foreign-thread',
           'legacy-host', ?, '[]', ?, ?, '[]', 'IDLE', 'ONLINE'
         )`,
      )
      .run(cwd, createdAt, createdAt);
    legacy
      .prepare(
        `INSERT INTO threads(id, project_id, subject, status, created_at, updated_at)
         VALUES ('thr_recipient_a', 'prj_recipient_a', 'invalid recipient', 'OPEN', ?, ?)`,
      )
      .run(createdAt, createdAt);
    legacy
      .prepare(
        `INSERT INTO messages(
           id, project_id, sequence, thread_id, from_agent_id, type, priority,
           requires_ack, requires_response, summary, created_at
         ) VALUES (
           'msg_recipient_a', 'prj_recipient_a', 1, 'thr_recipient_a', 'claude',
           'QUESTION', 'IMPORTANT', 1, 1, 'cross-project recipient', ?
         )`,
      )
      .run(createdAt);
    legacy
      .prepare(
        `INSERT INTO message_recipients(
           id, message_id, recipient_agent_id, recipient_session_id, state, attempt_count
         ) VALUES (
           'rcp_recipient_foreign', 'msg_recipient_a', 'codex',
           'ses_recipient_foreign', 'PENDING', 0
         )`,
      )
      .run();

    await expect(migrate(legacy, databasePath, true)).rejects.toThrow(
      /session_surface_migration_safe/,
    );
    expect(legacy.prepare("SELECT version FROM schema_migrations ORDER BY version").all()).toEqual([
      { version: 1 },
      { version: 2 },
      { version: 3 },
      { version: 4 },
    ]);
    expect(
      legacy
        .prepare(
          "SELECT recipient_session_id FROM message_recipients WHERE id = 'rcp_recipient_foreign'",
        )
        .get(),
    ).toEqual({ recipient_session_id: "ses_recipient_foreign" });
    expect(
      legacy.prepare("SELECT name FROM sqlite_master WHERE name = 'session_lineages'").all(),
    ).toEqual([]);
    legacy.close();
  });

  it("fails the migration when one task has multiple active reviews despite one projection", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "hub-active-review-migration-"));
    const databasePath = resolve(root, "hub.db");
    const migrationOnePath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../../migrations/0001_initial.sql",
    );
    const legacy = new Database(databasePath);
    legacy.pragma("foreign_keys = ON");
    legacy.exec(readFileSync(migrationOnePath, "utf8"));
    legacy
      .prepare("INSERT INTO schema_migrations(version, name, applied_at) VALUES (1, ?, ?)")
      .run("0001_initial.sql", "2026-07-30T00:00:00.000Z");
    const createdAt = "2026-07-30T00:00:00.000Z";
    legacy
      .prepare(
        `INSERT INTO projects(id, name, current_sequence, created_at, updated_at)
         VALUES ('prj_active_reviews', 'active review guard', 0, ?, ?)`,
      )
      .run(createdAt, createdAt);
    legacy
      .prepare(
        `INSERT INTO objectives(
           id, project_id, title, description, definition_of_done_json, status,
           weight, created_at, updated_at
         ) VALUES ('obj_active_reviews', 'prj_active_reviews', 'objective', '', '[]',
           'ACTIVE', 1, ?, ?)`,
      )
      .run(createdAt, createdAt);
    const cwd = mkdtempSync(resolve(tmpdir(), "hub-active-review-worker-"));
    const insertSession = legacy.prepare(
      `INSERT INTO agent_sessions(
         id, project_id, agent_id, role, client, transport, delivery_mode,
         external_thread_id, host, cwd, capabilities_json, connected_at,
         transport_last_seen_at, active_files_json, work_state, connection_state,
         current_review_id
       ) VALUES (?, 'prj_active_reviews', ?, 'primary', 'fake-client', 'websocket',
         'native_channel', ?, 'legacy-host', ?, '[]', ?, ?, '[]', ?, 'ONLINE', ?)`,
    );
    insertSession.run(
      "ses_active_author",
      "claude",
      "author-thread",
      cwd,
      createdAt,
      createdAt,
      "WAITING_FOR_PEER",
      "rev_active_2",
    );
    insertSession.run(
      "ses_active_reviewer",
      "codex",
      "reviewer-thread",
      cwd,
      createdAt,
      createdAt,
      "IDLE",
      null,
    );
    legacy
      .prepare(
        `INSERT INTO tasks(
           id, project_id, objective_id, title, description, status, priority,
           owner_agent_id, owner_session_id, reviewer_agent_id, capability_tags_json,
           scope_globs_json, protected_scope, review_required, computed_progress,
           weight, created_at, updated_at
         ) VALUES (
           'tsk_active_reviews', 'prj_active_reviews', 'obj_active_reviews', 'task', '',
           'REVIEW_PENDING', 'high', 'claude', 'ses_active_author', 'codex', '[]', '[]',
           0, 1, 0, 1, ?, ?
         )`,
      )
      .run(createdAt, createdAt);
    legacy
      .prepare(
        `INSERT INTO artifacts(
           id, project_id, task_id, kind, name, media_type, sha256, size_bytes,
           storage_path, metadata_json, created_by_session_id, created_at
         ) VALUES (
           'art_active_reviews', 'prj_active_reviews', 'tsk_active_reviews',
           'review_patch', 'patch', 'text/x-diff', 'sha', 0, 'patch', '{}',
           'ses_active_author', ?
         )`,
      )
      .run(createdAt);
    const insertReview = legacy.prepare(
      `INSERT INTO reviews(
         id, project_id, task_id, revision, author_agent_id, author_session_id,
         reviewer_agent_id, base_sha, head_sha, patch_sha256, patch_artifact_id,
         changed_files_json, acceptance_criteria_json, test_evidence_json,
         author_claims_json, known_risks_json, status, supersedes_review_id,
         created_at, updated_at
       ) VALUES (
         ?, 'prj_active_reviews', 'tsk_active_reviews', ?, 'claude',
         'ses_active_author', 'codex', 'base', 'head', 'sha', 'art_active_reviews',
         '[]', '[]', '[]', '[]', '[]', ?, ?, ?, ?
       )`,
    );
    insertReview.run("rev_active_1", 1, "IN_REVIEW", null, createdAt, createdAt);
    insertReview.run("rev_active_2", 2, "PENDING", "rev_active_1", createdAt, createdAt);

    await expect(migrate(legacy, databasePath, true)).rejects.toThrow(
      /session_surface_migration_safe/,
    );
    expect(legacy.prepare("SELECT version FROM schema_migrations ORDER BY version").all()).toEqual([
      { version: 1 },
      { version: 2 },
      { version: 3 },
      { version: 4 },
    ]);
    expect(legacy.prepare("SELECT id, status FROM reviews ORDER BY revision").all()).toEqual([
      { id: "rev_active_1", status: "IN_REVIEW" },
      { id: "rev_active_2", status: "PENDING" },
    ]);
    expect(
      legacy.prepare("SELECT name FROM sqlite_master WHERE name = 'session_lineages'").all(),
    ).toEqual([]);
    legacy.close();
  });

  it("uses registration events only when they cover an entire lineage", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "hub-partial-events-migration-"));
    const databasePath = resolve(root, "hub.db");
    const migrationOnePath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../../migrations/0001_initial.sql",
    );
    const legacy = new Database(databasePath);
    legacy.pragma("foreign_keys = ON");
    legacy.exec(readFileSync(migrationOnePath, "utf8"));
    legacy
      .prepare("INSERT INTO schema_migrations(version, name, applied_at) VALUES (1, ?, ?)")
      .run("0001_initial.sql", "2026-07-30T00:00:00.000Z");
    legacy
      .prepare(
        `INSERT INTO projects(id, name, current_sequence, created_at, updated_at)
         VALUES ('prj_partial_events', 'partial event fixture', 32, ?, ?)`,
      )
      .run("2026-07-30T00:00:00.000Z", "2026-07-30T00:00:00.000Z");
    const cwd = mkdtempSync(resolve(tmpdir(), "hub-partial-events-worker-"));
    const insertSession = legacy.prepare(
      `INSERT INTO agent_sessions(
         id, project_id, agent_id, role, client, transport, delivery_mode,
         external_session_id, external_thread_id, host, cwd, capabilities_json,
         connected_at, transport_last_seen_at, active_files_json, work_state, connection_state
       ) VALUES (
         ?, 'prj_partial_events', 'codex', 'primary', 'codex-app-server', 'app_server',
         'app_server_push', ?, ?, 'legacy-host', ?, '[]', ?, ?, '[]', 'IDLE', 'ONLINE'
       )`,
    );
    insertSession.run(
      "ses_partial_a",
      "partial-thread",
      "partial-thread",
      cwd,
      "2026-07-30T00:01:00.000Z",
      "2026-07-30T00:01:00.000Z",
    );
    insertSession.run(
      "ses_partial_b",
      "partial-thread",
      "partial-thread",
      cwd,
      "2026-07-30T00:02:00.000Z",
      "2026-07-30T00:02:00.000Z",
    );
    insertSession.run(
      "ses_partial_c",
      "partial-thread",
      "partial-thread",
      cwd,
      "2026-07-30T00:03:00.000Z",
      "2026-07-30T00:03:00.000Z",
    );
    insertSession.run(
      "ses_complete_x",
      "complete-thread",
      "complete-thread",
      cwd,
      "2026-07-30T00:04:00.000Z",
      "2026-07-30T00:04:00.000Z",
    );
    insertSession.run(
      "ses_complete_y",
      "complete-thread",
      "complete-thread",
      cwd,
      "2026-07-30T00:05:00.000Z",
      "2026-07-30T00:05:00.000Z",
    );
    const insertEvent = legacy.prepare(
      `INSERT INTO events(
         id, project_id, sequence, type, actor_type, actor_id, aggregate_type,
         aggregate_id, payload_json, created_at
       ) VALUES (?, 'prj_partial_events', ?, 'session.registered', 'agent', 'codex',
         'session', ?, '{}', ?)`,
    );
    // Partial evidence conflicts with timestamps. Because B has no registration event, the entire
    // A/B/C lineage must ignore event sequence and use connected_at/id.
    insertEvent.run("evt_partial_c", 10, "ses_partial_c", "2026-07-30T00:03:00.000Z");
    insertEvent.run("evt_partial_a", 30, "ses_partial_a", "2026-07-30T00:01:00.000Z");
    // The complete control lineage must do the opposite: event order Y -> X wins over timestamps.
    insertEvent.run("evt_complete_y", 31, "ses_complete_y", "2026-07-30T00:05:00.000Z");
    insertEvent.run("evt_complete_x", 32, "ses_complete_x", "2026-07-30T00:04:00.000Z");
    legacy.close();

    const server = await createHubServer({
      databasePath,
      dataDir: resolve(root, "data"),
      dashboardDir: resolve(root, "missing-dashboard"),
      host: "127.0.0.1",
      port: 0,
      logLevel: "silent",
    });
    try {
      expect(
        server.store.getSessionLineageHead("prj_partial_events", {
          agentId: "codex",
          client: "codex-app-server",
          deliveryMode: "app_server_push",
          externalThreadId: "partial-thread",
        }),
      ).toMatchObject({ headSessionId: "ses_partial_c", headIncarnation: 3 });
      expect(server.store.getSession("ses_partial_a")).toMatchObject({
        incarnation: 1,
        predecessorSessionId: null,
        supersededBySessionId: "ses_partial_b",
      });
      expect(server.store.getSession("ses_partial_b")).toMatchObject({
        incarnation: 2,
        predecessorSessionId: "ses_partial_a",
        supersededBySessionId: "ses_partial_c",
      });
      expect(
        server.store.getSessionLineageHead("prj_partial_events", {
          agentId: "codex",
          client: "codex-app-server",
          deliveryMode: "app_server_push",
          externalThreadId: "complete-thread",
        }),
      ).toMatchObject({ headSessionId: "ses_complete_x", headIncarnation: 2 });
    } finally {
      await server.app.close();
    }
  });
});
