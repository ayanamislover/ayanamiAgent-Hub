import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type HubDatabase } from "../src/db/database.js";
import { initializeCredentialRegistry } from "../src/security/local-auth.js";
import {
  assertCredentialRotationIntegrity,
  bootstrapStaticCredentialGenerations,
  commitStaticCredentialRotation,
  consumeIncidentCurrentHeadProof,
  markStaticCredentialFilesInstalled,
  markStaticCredentialRotationStaged,
  markStaticCredentialRotationSwitching,
  prepareStaticCredentialRotation,
  queryStaticCredentialAdmission,
  reconcileStaticCredentialRotation,
  STATIC_CREDENTIAL_SLOTS,
  type CredentialRotationFileAdapter,
  type CredentialRotationRequestPrincipal,
  type ExternalCredentialSecurityReceipt,
  type StaticCredentialMemberInput,
} from "../src/security/credential-rotation.js";
import {
  activateSessionTicketBundle,
  createPendingSessionTicket,
} from "../src/security/session-tickets.js";

const INCIDENT = "2026-08-01T12:00:00.000Z";
const CUTOVER = "2026-08-01T12:10:00.000Z";
const PROJECT = "prj_rotation";
const SESSION = "ses_rotation";
const LINEAGE = "lin_rotation";

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function nextMembers(suffix = "one"): StaticCredentialMemberInput[] {
  const scopes: Record<(typeof STATIC_CREDENTIAL_SLOTS)[number], string[]> = {
    token: ["project:select"],
    "agent-codex": [
      "project:join",
      "project:select",
      "session-ticket:offer",
      "session:enroll:first",
    ],
    "agent-claude": [
      "project:join",
      "project:select",
      "session-ticket:offer",
      "session:enroll:first",
    ],
    dashboard: ["hub:dashboard"],
    "capture-codex": ["session-ticket:offer:capture"],
    "capture-claude": ["session-ticket:offer:capture"],
    "inject-codex": ["session-ticket:offer:injector"],
    "inject-claude": ["session-ticket:offer:injector"],
  };
  return STATIC_CREDENTIAL_SLOTS.map((slot) => ({
    slot,
    tokenSha256: digest(`new:${suffix}:${slot}`),
    stagedFileSha256: digest(`staged:${suffix}:${slot}`),
    scopes: scopes[slot],
  }));
}

function dashboardPrincipal(
  overrides: Partial<CredentialRotationRequestPrincipal> = {},
): CredentialRotationRequestPrincipal {
  return {
    id: "prn_local_dashboard",
    credentialId: "crd_local_dashboard",
    credentialClass: "STATIC",
    kind: "DASHBOARD_USER",
    displayName: "Local User",
    scopes: ["hub:dashboard"],
    projectId: null,
    clientType: null,
    hubSessionId: null,
    agentId: null,
    adapterClient: null,
    lineageId: null,
    incarnation: null,
    ticketPurpose: null,
    ticketState: null,
    authenticatedVia: "dashboard_cookie",
    staticCredentialSlot: "dashboard",
    staticCredentialGeneration: 0,
    securityEpoch: 0,
    ...overrides,
  };
}

function insertDashboardAuthorizationEvent(
  sqlite: HubDatabase["sqlite"],
  operationId: string,
  projectId = PROJECT,
  eventSuffix = "",
): string {
  const eventId = `evt_auth_${operationId.slice(4)}${eventSuffix}`;
  const sequence = Number(
    sqlite
      .prepare("SELECT COALESCE(MAX(sequence), 0) + 1 FROM events WHERE project_id = ?")
      .pluck()
      .get(projectId),
  );
  sqlite
    .prepare(
      `INSERT INTO events(
         id, project_id, sequence, type, actor_type, actor_id, aggregate_type,
         aggregate_id, causation_id, correlation_id, payload_json, created_at
       ) VALUES (?, ?, ?, 'security.credential_rotation.authorized', 'user', 'Local User',
         'static_credential_rotation', ?, NULL, NULL, '{}', ?)`,
    )
    .run(eventId, projectId, sequence, operationId, INCIDENT);
  return eventId;
}

function installed(members: readonly StaticCredentialMemberInput[], generation = 1) {
  return members.map((member) => ({
    slot: member.slot,
    generation,
    tokenSha256: member.tokenSha256,
  }));
}

function stopReceipt(operationId: string, stoppedAt = CUTOVER, projectId = PROJECT) {
  return {
    operationId,
    projectId,
    stoppedAt,
    receiptSha256: digest(`stop:${operationId}:${projectId}:${stoppedAt}`),
  };
}

function insertProjectAndSession(sqlite: HubDatabase["sqlite"]): void {
  sqlite.exec(`
    INSERT INTO projects(id, name, config_json, current_sequence, version, created_at, updated_at)
    VALUES ('${PROJECT}', 'Rotation', '{}', 0, 0, '${INCIDENT}', '${INCIDENT}');
    INSERT INTO agents(id, project_id, display_name, capabilities_json, created_at, updated_at)
    VALUES ('codex', '${PROJECT}', 'Codex', '[]', '${INCIDENT}', '${INCIDENT}');
    INSERT INTO session_lineages(
      id, project_id, agent_id, client, delivery_mode, identity_kind, identity_value,
      head_session_id, head_incarnation, launch_fence_required, reserved_generation,
      active_reservation_id, head_run_id, head_run_generation, version, created_at, updated_at
    ) VALUES (
      '${LINEAGE}', '${PROJECT}', 'codex', 'codex-app-server', 'app_server_push',
      'external_thread', 'thread-rotation', NULL, 0, 0, 0, NULL, NULL, NULL, 0,
      '${INCIDENT}', '${INCIDENT}'
    );
    INSERT INTO agent_sessions(
      id, project_id, agent_id, role, client, transport, delivery_mode,
      external_session_id, external_thread_id, external_turn_id, host, pid, cwd,
      git_branch, git_head, capabilities_json, connected_at, transport_last_seen_at,
      activity_last_seen_at, current_task_id, current_review_id, active_files_json,
      work_state, connection_state, heartbeat_sequence, queue_depth, version, closed_at,
      lineage_id, incarnation, predecessor_session_id, superseded_by_session_id,
      launcher_run_id, launch_generation
    ) VALUES (
      '${SESSION}', '${PROJECT}', 'codex', 'primary', 'codex-app-server', 'websocket',
      'app_server_push', 'external-rotation', 'thread-rotation', NULL, 'localhost', 1234,
      'R:/rotation', NULL, NULL, '[]', '${INCIDENT}', '${INCIDENT}', '${INCIDENT}',
      NULL, NULL, '[]', 'IDLE', 'ONLINE', 0, 0, 0, NULL, '${LINEAGE}', 1,
      NULL, NULL, 'run-active', 1
    );
    UPDATE session_lineages SET head_session_id = '${SESSION}', head_incarnation = 1
    WHERE id = '${LINEAGE}';
  `);
}

function offerPendingClaudeBundle(
  sqlite: HubDatabase["sqlite"],
  bundleId: string,
  now: string,
  tokenSha256 = digest(`ticket:${bundleId}`),
): void {
  createPendingSessionTicket(sqlite, {
    bundleId,
    purpose: "CONTROL",
    tokenSha256,
    offeredByAuthCredentialId: "crd_agent_claude",
    projectId: PROJECT,
    adapterClient: "claude",
    agentId: "claude",
    sessionClient: "claude-channel",
    role: "primary",
    transport: "websocket",
    deliveryMode: "native_channel",
    externalSessionId: `external-${bundleId}`,
    runId: `run-${bundleId}`,
    activationMode: "FIRST_LINEAGE",
    idempotencyKey: `offer-${bundleId}`,
    now,
  });
}

function offerAndActivateCodexBundle(sqlite: HubDatabase["sqlite"], now: string): void {
  const ids: Record<string, string> = {};
  for (const purpose of ["CONTROL", "MODEL_MCP", "INJECTOR"] as const) {
    const offer = createPendingSessionTicket(sqlite, {
      bundleId: "stb_active_overlap",
      purpose,
      tokenSha256: digest(`active:${purpose}`),
      offeredByAuthCredentialId: purpose === "INJECTOR" ? "crd_inject_codex" : "crd_agent_codex",
      projectId: PROJECT,
      adapterClient: "codex",
      agentId: "codex",
      sessionClient: "codex-app-server",
      role: "primary",
      transport: "websocket",
      deliveryMode: "app_server_push",
      externalSessionId: "external-rotation",
      externalThreadId: "thread-rotation",
      runId: "run-active",
      activationMode: "FIRST_LINEAGE",
      idempotencyKey: `offer-active-${purpose}`,
      now,
    });
    ids[purpose] = offer.id;
  }
  activateSessionTicketBundle(sqlite, {
    bundleId: "stb_active_overlap",
    hubSessionId: SESSION,
    lineageId: LINEAGE,
    incarnation: 1,
    proof: { kind: "FIRST_LINEAGE", controlTicketId: ids.CONTROL! },
    now,
  });
}

function prepareThroughFiles(
  sqlite: HubDatabase["sqlite"],
  members: StaticCredentialMemberInput[],
) {
  const sourceId = insertDashboardAuthorizationEvent(sqlite, "scr_test_one");
  prepareStaticCredentialRotation(sqlite, dashboardPrincipal(), {
    operationId: "scr_test_one",
    projectId: PROJECT,
    incidentStartedAt: INCIDENT,
    stopReceipt: stopReceipt("scr_test_one"),
    authorizationSource: { kind: "DASHBOARD_EVENT", id: sourceId, projectId: PROJECT },
    members,
    now: INCIDENT,
  });
  markStaticCredentialRotationStaged(sqlite, "scr_test_one", INCIDENT);
  markStaticCredentialRotationSwitching(sqlite, "scr_test_one", INCIDENT);
  markStaticCredentialFilesInstalled(sqlite, "scr_test_one", installed(members), INCIDENT);
}

describe("static credential incident rotation", () => {
  let database: HubDatabase;
  let root: string;

  beforeEach(async () => {
    database = await openDatabase(":memory:");
    root = mkdtempSync(resolve(tmpdir(), "crossagent-credential-rotation-"));
    initializeCredentialRegistry(database.sqlite, root);
    bootstrapStaticCredentialGenerations(database.sqlite);
    insertProjectAndSession(database.sqlite);
  });

  afterEach(() => {
    database?.sqlite.close();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("bootstraps exactly eight generation-zero slots and rejects prepared roots before cutover", () => {
    const rows = database.sqlite
      .prepare(
        `SELECT slot, active_generation, security_epoch FROM static_credential_slots ORDER BY slot`,
      )
      .all() as Array<{ slot: string; active_generation: number; security_epoch: number }>;
    expect(rows).toHaveLength(8);
    expect(rows.every((row) => row.active_generation === 0 && row.security_epoch === 0)).toBe(true);
    const members = nextMembers();
    const sourceId = insertDashboardAuthorizationEvent(database.sqlite, "scr_prepared_only");
    prepareStaticCredentialRotation(database.sqlite, dashboardPrincipal(), {
      operationId: "scr_prepared_only",
      projectId: PROJECT,
      incidentStartedAt: INCIDENT,
      stopReceipt: stopReceipt("scr_prepared_only"),
      authorizationSource: { kind: "DASHBOARD_EVENT", id: sourceId, projectId: PROJECT },
      members,
      now: INCIDENT,
    });
    expect(
      queryStaticCredentialAdmission(database.sqlite, {
        slot: "agent-codex",
        tokenSha256: members.find((member) => member.slot === "agent-codex")!.tokenSha256,
      }),
    ).toMatchObject({ valid: false, code: "CREDENTIAL_REVOKED_BY_SECURITY_EPOCH" });
  });

  it("does not let an Agent principal authorize or upgrade a rotation", () => {
    const sourceId = insertDashboardAuthorizationEvent(database.sqlite, "scr_agent_forgery");
    expect(() =>
      prepareStaticCredentialRotation(
        database.sqlite,
        dashboardPrincipal({
          id: "prn_agent_codex",
          credentialId: "crd_agent_codex",
          kind: "AGENT",
          displayName: "Codex Agent",
          clientType: "codex",
          agentId: "codex",
          staticCredentialGeneration: 0,
        }),
        {
          operationId: "scr_agent_forgery",
          projectId: PROJECT,
          incidentStartedAt: INCIDENT,
          stopReceipt: stopReceipt("scr_agent_forgery"),
          authorizationSource: { kind: "DASHBOARD_EVENT", id: sourceId, projectId: PROJECT },
          members: nextMembers(),
          now: INCIDENT,
        },
      ),
    ).toThrowError(expect.objectContaining({ code: "ROTATION_NOT_AUTHORIZED" }));
    expect(
      database.sqlite
        .prepare("SELECT COUNT(*) FROM static_credential_rotation_operations")
        .pluck()
        .get(),
    ).toBe(0);
  });

  it("rejects a missing or cross-project authorization source without side effects", () => {
    expect(() =>
      prepareStaticCredentialRotation(database.sqlite, dashboardPrincipal(), {
        operationId: "scr_missing_source",
        projectId: PROJECT,
        incidentStartedAt: INCIDENT,
        stopReceipt: stopReceipt("scr_missing_source"),
        authorizationSource: {
          kind: "DASHBOARD_EVENT",
          id: "evt_does_not_exist",
          projectId: PROJECT,
        },
        members: nextMembers(),
        now: INCIDENT,
      }),
    ).toThrowError(expect.objectContaining({ code: "ROTATION_NOT_AUTHORIZED" }));

    database.sqlite
      .prepare(
        `INSERT INTO projects(id, name, config_json, current_sequence, version, created_at, updated_at)
         VALUES ('prj_other_rotation', 'Other', '{}', 0, 0, ?, ?)`,
      )
      .run(INCIDENT, INCIDENT);
    const foreignEvent = insertDashboardAuthorizationEvent(
      database.sqlite,
      "scr_cross_project",
      "prj_other_rotation",
    );
    expect(() =>
      prepareStaticCredentialRotation(database.sqlite, dashboardPrincipal(), {
        operationId: "scr_cross_project",
        projectId: PROJECT,
        incidentStartedAt: INCIDENT,
        stopReceipt: stopReceipt("scr_cross_project"),
        authorizationSource: {
          kind: "DASHBOARD_EVENT",
          id: foreignEvent,
          projectId: "prj_other_rotation",
        },
        members: nextMembers(),
        now: INCIDENT,
      }),
    ).toThrowError(expect.objectContaining({ code: "ROTATION_NOT_AUTHORIZED" }));
    expect(
      database.sqlite
        .prepare("SELECT COUNT(*) FROM static_credential_rotation_operations")
        .pluck()
        .get(),
    ).toBe(0);
  });

  it("rejects caller-selected scope escalation before writing an operation", () => {
    const operationId = "scr_scope_escalation";
    const sourceId = insertDashboardAuthorizationEvent(database.sqlite, operationId);
    const members = nextMembers();
    members.find((member) => member.slot === "agent-codex")!.scopes = [
      "hub:dashboard",
      "project:select",
    ];
    expect(() =>
      prepareStaticCredentialRotation(database.sqlite, dashboardPrincipal(), {
        operationId,
        projectId: PROJECT,
        incidentStartedAt: INCIDENT,
        stopReceipt: stopReceipt(operationId),
        authorizationSource: { kind: "DASHBOARD_EVENT", id: sourceId, projectId: PROJECT },
        members,
        now: INCIDENT,
      }),
    ).toThrowError(expect.objectContaining({ code: "ROTATION_INTEGRITY_FAILED" }));
    expect(
      database.sqlite
        .prepare("SELECT COUNT(*) FROM static_credential_rotation_operations")
        .pluck()
        .get(),
    ).toBe(0);
  });

  it("rejects static-generation and session-ticket digest collisions in both directions", () => {
    const ticketFirstMembers = nextMembers("ticket-first-collision");
    const ticketFirstDigest = ticketFirstMembers.find(
      (member) => member.slot === "agent-codex",
    )!.tokenSha256;
    offerPendingClaudeBundle(
      database.sqlite,
      "stb_ticket_first_collision",
      INCIDENT,
      ticketFirstDigest,
    );
    const ticketFirstOperationId = "scr_ticket_first_collision";
    const ticketFirstSourceId = insertDashboardAuthorizationEvent(
      database.sqlite,
      ticketFirstOperationId,
    );
    expect(() =>
      prepareStaticCredentialRotation(database.sqlite, dashboardPrincipal(), {
        operationId: ticketFirstOperationId,
        projectId: PROJECT,
        incidentStartedAt: INCIDENT,
        stopReceipt: stopReceipt(ticketFirstOperationId),
        authorizationSource: {
          kind: "DASHBOARD_EVENT",
          id: ticketFirstSourceId,
          projectId: PROJECT,
        },
        members: ticketFirstMembers,
        now: INCIDENT,
      }),
    ).toThrow();
    expect(
      database.sqlite
        .prepare("SELECT COUNT(*) FROM static_credential_rotation_operations")
        .pluck()
        .get(),
    ).toBe(0);

    const generationFirstMembers = nextMembers("generation-first-collision");
    const generationFirstOperationId = "scr_generation_first_collision";
    const generationFirstSourceId = insertDashboardAuthorizationEvent(
      database.sqlite,
      generationFirstOperationId,
    );
    prepareStaticCredentialRotation(database.sqlite, dashboardPrincipal(), {
      operationId: generationFirstOperationId,
      projectId: PROJECT,
      incidentStartedAt: INCIDENT,
      stopReceipt: stopReceipt(generationFirstOperationId),
      authorizationSource: {
        kind: "DASHBOARD_EVENT",
        id: generationFirstSourceId,
        projectId: PROJECT,
      },
      members: generationFirstMembers,
      now: INCIDENT,
    });
    const generationFirstDigest = generationFirstMembers.find(
      (member) => member.slot === "agent-claude",
    )!.tokenSha256;
    expect(() =>
      offerPendingClaudeBundle(
        database.sqlite,
        "stb_generation_first_collision",
        INCIDENT,
        generationFirstDigest,
      ),
    ).toThrow();
    expect(
      database.sqlite
        .prepare(
          `SELECT COUNT(*) FROM adapter_session_tickets
           WHERE bundle_id = 'stb_generation_first_collision'`,
        )
        .pluck()
        .get(),
    ).toBe(0);
  });

  it("derives the exact incident cutover from the bound cooperative-stop receipt", () => {
    const operationId = "scr_stop_receipt_cutover";
    const stoppedAt = "2026-08-01T12:10:00.002Z";
    offerPendingClaudeBundle(
      database.sqlite,
      "stb_between_planned_and_stopped",
      "2026-08-01T12:10:00.001Z",
    );
    const members = nextMembers("stop-receipt");
    const sourceId = insertDashboardAuthorizationEvent(database.sqlite, operationId);
    const receipt = stopReceipt(operationId, stoppedAt);
    prepareStaticCredentialRotation(database.sqlite, dashboardPrincipal(), {
      operationId,
      projectId: PROJECT,
      incidentStartedAt: INCIDENT,
      stopReceipt: receipt,
      authorizationSource: { kind: "DASHBOARD_EVENT", id: sourceId, projectId: PROJECT },
      members,
      now: INCIDENT,
    });
    markStaticCredentialRotationStaged(database.sqlite, operationId, INCIDENT);
    markStaticCredentialRotationSwitching(database.sqlite, operationId, INCIDENT);
    markStaticCredentialFilesInstalled(database.sqlite, operationId, installed(members), INCIDENT);
    expect(
      commitStaticCredentialRotation(database.sqlite, {
        operationId,
        installedSecurityEpoch: 1,
        installedMembers: installed(members),
        at: stoppedAt,
      }),
    ).toMatchObject({ revokedTicketBundles: 1 });
    expect(
      database.sqlite
        .prepare(
          `SELECT cutover_at, stop_receipt_sha256
           FROM static_credential_rotation_operations WHERE id = ?`,
        )
        .get(operationId),
    ).toEqual({ cutover_at: stoppedAt, stop_receipt_sha256: receipt.receiptSha256 });
    expect(
      database.sqlite
        .prepare(
          `SELECT state, terminal_at FROM adapter_session_tickets
           WHERE bundle_id = 'stb_between_planned_and_stopped'`,
        )
        .get(),
    ).toEqual({ state: "REVOKED", terminal_at: stoppedAt });
  });

  it("rejects a cooperative-stop receipt bound to another operation or project", () => {
    const operationId = "scr_stop_receipt_spoof";
    const sourceId = insertDashboardAuthorizationEvent(database.sqlite, operationId);
    expect(() =>
      prepareStaticCredentialRotation(database.sqlite, dashboardPrincipal(), {
        operationId,
        projectId: PROJECT,
        incidentStartedAt: INCIDENT,
        stopReceipt: stopReceipt("scr_other_operation"),
        authorizationSource: { kind: "DASHBOARD_EVENT", id: sourceId, projectId: PROJECT },
        members: nextMembers("stop-spoof"),
        now: INCIDENT,
      }),
    ).toThrowError(expect.objectContaining({ code: "ROTATION_INTEGRITY_FAILED" }));
    expect(
      database.sqlite
        .prepare("SELECT COUNT(*) FROM static_credential_rotation_operations")
        .pluck()
        .get(),
    ).toBe(0);
  });

  it("uses the exact incident window for PENDING and ACTIVE whole bundles", () => {
    offerPendingClaudeBundle(database.sqlite, "stb_pending_before", "2026-08-01T11:49:59.000Z");
    offerPendingClaudeBundle(
      database.sqlite,
      "stb_pending_before_one_ms",
      "2026-08-01T11:49:59.999Z",
    );
    offerPendingClaudeBundle(database.sqlite, "stb_pending_boundary", "2026-08-01T11:50:00.000Z");
    offerPendingClaudeBundle(
      database.sqlite,
      "stb_pending_after_cutover_one_ms",
      "2026-08-01T12:10:00.001Z",
    );
    offerPendingClaudeBundle(
      database.sqlite,
      "stb_pending_after_cutover",
      "2026-08-01T12:11:00.000Z",
    );
    offerAndActivateCodexBundle(database.sqlite, "2026-08-01T11:59:00.000Z");
    const members = nextMembers();
    prepareThroughFiles(database.sqlite, members);
    const result = commitStaticCredentialRotation(database.sqlite, {
      operationId: "scr_test_one",
      installedSecurityEpoch: 1,
      installedMembers: installed(members),
      at: CUTOVER,
    });
    expect(result).toEqual({ securityEpoch: 1, revokedTicketBundles: 2 });
    const states = Object.fromEntries(
      (
        database.sqlite
          .prepare(
            `SELECT bundle_id, state, terminal_at FROM adapter_session_tickets
             WHERE purpose = 'CONTROL' ORDER BY bundle_id`,
          )
          .all() as Array<{ bundle_id: string; state: string; terminal_at: string | null }>
      ).map((row) => [row.bundle_id, row]),
    );
    expect(states.stb_pending_before).toMatchObject({ state: "PENDING", terminal_at: null });
    expect(states.stb_pending_before_one_ms).toMatchObject({
      state: "PENDING",
      terminal_at: null,
    });
    expect(states.stb_pending_boundary).toMatchObject({ state: "REVOKED", terminal_at: CUTOVER });
    expect(states.stb_pending_after_cutover_one_ms).toMatchObject({
      state: "PENDING",
      terminal_at: null,
    });
    expect(states.stb_pending_after_cutover).toMatchObject({ state: "PENDING", terminal_at: null });
    expect(states.stb_active_overlap).toMatchObject({ state: "REVOKED", terminal_at: CUTOVER });
  });

  it("switches all eight slots and revokes predecessors in one transaction", () => {
    const members = nextMembers();
    prepareThroughFiles(database.sqlite, members);
    commitStaticCredentialRotation(database.sqlite, {
      operationId: "scr_test_one",
      installedSecurityEpoch: 1,
      installedMembers: installed(members),
      at: CUTOVER,
    });
    assertCredentialRotationIntegrity(database.sqlite);
    const rows = database.sqlite
      .prepare(
        `SELECT slot.security_epoch, slot.active_generation, generation.state,
                generation.token_sha256
         FROM static_credential_slots slot
         JOIN static_credential_generations generation ON generation.id = slot.active_generation_id`,
      )
      .all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(8);
    expect(rows.every((row) => row.security_epoch === 1 && row.active_generation === 1)).toBe(true);
    expect(
      database.sqlite
        .prepare("SELECT COUNT(*) FROM auth_credentials WHERE revoked_at IS NOT NULL")
        .pluck()
        .get(),
    ).toBe(8);
    expect(
      queryStaticCredentialAdmission(database.sqlite, {
        slot: "agent-codex",
        tokenSha256: members.find((member) => member.slot === "agent-codex")!.tokenSha256,
        observedSecurityEpoch: 1,
      }),
    ).toMatchObject({ valid: true, securityEpoch: 1, generation: 1 });
  });

  it("writes an immutable causation receipt for each terminalized launch reservation", () => {
    database.sqlite
      .prepare(
        `INSERT INTO session_lineages(
           id, project_id, agent_id, client, delivery_mode, identity_kind, identity_value,
           head_session_id, head_incarnation, launch_fence_required, reserved_generation,
           active_reservation_id, head_run_id, head_run_generation, version, created_at, updated_at
         ) VALUES (
           'lin_after_cutover', ?, 'codex', 'codex-app-server', 'app_server_push',
           'external_thread', 'thread-after-cutover', NULL, 0, 0, 0, NULL, NULL, NULL, 0, ?, ?
         )`,
      )
      .run(PROJECT, INCIDENT, INCIDENT);
    database.sqlite
      .prepare(
        `INSERT INTO session_launch_reservations(
           id, project_id, lineage_id, run_id, generation, expected_head_session_id,
           state, consumed_session_id, created_at, updated_at
         ) VALUES (
           'slr_rotation_incident', ?, ?, 'run-incident-reservation', 1, ?,
           'ISSUED', NULL, ?, ?
         )`,
      )
      .run(PROJECT, LINEAGE, SESSION, INCIDENT, INCIDENT);
    database.sqlite
      .prepare(
        `UPDATE session_lineages
         SET reserved_generation = 1, active_reservation_id = 'slr_rotation_incident',
             version = version + 1, updated_at = ?
         WHERE id = ?`,
      )
      .run(INCIDENT, LINEAGE);
    database.sqlite
      .prepare(
        `INSERT INTO session_launch_reservations(
           id, project_id, lineage_id, run_id, generation, expected_head_session_id,
           state, consumed_session_id, created_at, updated_at
         ) VALUES (
           'slr_after_cutover', ?, 'lin_after_cutover', 'run-after-cutover', 1, NULL,
           'ISSUED', NULL, '2026-08-01T12:10:00.001Z', '2026-08-01T12:10:00.001Z'
         )`,
      )
      .run(PROJECT);
    database.sqlite
      .prepare(
        `UPDATE session_lineages
         SET reserved_generation = 1, active_reservation_id = 'slr_after_cutover',
             version = version + 1, updated_at = '2026-08-01T12:10:00.001Z'
         WHERE id = 'lin_after_cutover'`,
      )
      .run();
    const members = nextMembers("dependency-receipt");
    prepareThroughFiles(database.sqlite, members);
    commitStaticCredentialRotation(database.sqlite, {
      operationId: "scr_test_one",
      installedSecurityEpoch: 1,
      installedMembers: installed(members),
      at: CUTOVER,
    });
    expect(
      database.sqlite
        .prepare(
          `SELECT dependency_kind, dependency_id, prior_state, terminal_state, terminal_at
           FROM static_credential_incident_dependency_receipts`,
        )
        .get(),
    ).toEqual({
      dependency_kind: "LAUNCH_RESERVATION",
      dependency_id: "slr_rotation_incident",
      prior_state: "ISSUED",
      terminal_state: "SUPERSEDED",
      terminal_at: CUTOVER,
    });
    expect(
      database.sqlite
        .prepare("SELECT state FROM session_launch_reservations WHERE id = 'slr_after_cutover'")
        .pluck()
        .get(),
    ).toBe("ISSUED");
    expect(() =>
      database.sqlite
        .prepare(
          `UPDATE static_credential_incident_dependency_receipts
           SET receipt_sha256 = ?`,
        )
        .run("0".repeat(64)),
    ).toThrow();
    assertCredentialRotationIntegrity(database.sqlite);
    database.sqlite.exec(
      "DROP TRIGGER static_credential_incident_dependency_receipts_immutable_update",
    );
    database.sqlite
      .prepare(
        `UPDATE static_credential_incident_dependency_receipts
         SET receipt_sha256 = ?`,
      )
      .run("0".repeat(64));
    expect(() => assertCredentialRotationIntegrity(database.sqlite)).toThrowError(
      expect.objectContaining({ code: "ROTATION_INTEGRITY_FAILED" }),
    );
  });

  it("consumes incident current-head proof once for the exact new Agent generation", () => {
    offerAndActivateCodexBundle(database.sqlite, "2026-08-01T11:59:00.000Z");
    const members = nextMembers();
    prepareThroughFiles(database.sqlite, members);
    commitStaticCredentialRotation(database.sqlite, {
      operationId: "scr_test_one",
      installedSecurityEpoch: 1,
      installedMembers: installed(members),
      at: CUTOVER,
    });
    const request = {
      operationId: "scr_test_one",
      projectId: PROJECT,
      adapterClient: "codex" as const,
      lineageId: LINEAGE,
      headSessionId: SESSION,
      predecessorBundleId: "stb_active_overlap",
      credentialGeneration: 1,
      presentedTokenSha256: members.find((member) => member.slot === "agent-codex")!.tokenSha256,
      now: CUTOVER,
    };
    expect(consumeIncidentCurrentHeadProof(database.sqlite, request)).toEqual({
      securityEpoch: 1,
      generation: 1,
      headSessionId: SESSION,
    });
    expect(() => consumeIncidentCurrentHeadProof(database.sqlite, request)).toThrowError(
      expect.objectContaining({ code: "INCIDENT_PROOF_REPLAYED" }),
    );
  });

  it("rolls the entire DB commit back when a candidate bundle changes state", () => {
    offerAndActivateCodexBundle(database.sqlite, "2026-08-01T11:59:00.000Z");
    const members = nextMembers();
    prepareThroughFiles(database.sqlite, members);
    database.sqlite.exec("DROP TRIGGER adapter_session_tickets_immutable_delete");
    database.sqlite
      .prepare(
        `DELETE FROM adapter_session_tickets
         WHERE bundle_id = 'stb_active_overlap' AND purpose = 'MODEL_MCP'`,
      )
      .run();
    expect(() =>
      commitStaticCredentialRotation(database.sqlite, {
        operationId: "scr_test_one",
        installedSecurityEpoch: 1,
        installedMembers: installed(members),
        at: CUTOVER,
      }),
    ).toThrow();
    expect(
      database.sqlite
        .prepare("SELECT security_epoch FROM static_credential_security_state")
        .pluck()
        .get(),
    ).toBe(0);
    expect(
      database.sqlite
        .prepare("SELECT COUNT(*) FROM static_credential_slots WHERE active_generation = 1")
        .pluck()
        .get(),
    ).toBe(0);
  });

  it("aborts STAGED when every canonical file is still old", async () => {
    const members = nextMembers();
    const sourceId = insertDashboardAuthorizationEvent(database.sqlite, "scr_abort_old");
    prepareStaticCredentialRotation(database.sqlite, dashboardPrincipal(), {
      operationId: "scr_abort_old",
      projectId: PROJECT,
      incidentStartedAt: INCIDENT,
      stopReceipt: stopReceipt("scr_abort_old"),
      authorizationSource: { kind: "DASHBOARD_EVENT", id: sourceId, projectId: PROJECT },
      members,
      now: INCIDENT,
    });
    markStaticCredentialRotationStaged(database.sqlite, "scr_abort_old", INCIDENT);
    const old = database.sqlite
      .prepare(
        `SELECT slot.slot, slot.active_generation AS generation, generation.token_sha256 AS tokenSha256
         FROM static_credential_slots slot JOIN static_credential_generations generation
           ON generation.id = slot.active_generation_id ORDER BY slot.slot`,
      )
      .all() as ExternalCredentialSecurityReceipt["slots"];
    const adapter: CredentialRotationFileAdapter = {
      inspect: async () => ({
        operationId: null,
        securityEpoch: 0,
        slots: old,
        receiptSha256: null,
      }),
      installForward: async () => {
        throw new Error("must not install");
      },
      writeReceipt: async () => {
        throw new Error("must not write receipt");
      },
    };
    await expect(
      reconcileStaticCredentialRotation(database.sqlite, adapter, "scr_abort_old", CUTOVER),
    ).resolves.toBe("ABORTED");
  });

  it("allows a fresh rotation to commit after an all-old rotation aborts", async () => {
    const abortedMembers = nextMembers("aborted");
    const abortedOperationId = "scr_abort_reusable";
    const abortedSourceId = insertDashboardAuthorizationEvent(database.sqlite, abortedOperationId);
    prepareStaticCredentialRotation(database.sqlite, dashboardPrincipal(), {
      operationId: abortedOperationId,
      projectId: PROJECT,
      incidentStartedAt: INCIDENT,
      stopReceipt: stopReceipt(abortedOperationId),
      authorizationSource: {
        kind: "DASHBOARD_EVENT",
        id: abortedSourceId,
        projectId: PROJECT,
      },
      members: abortedMembers,
      now: INCIDENT,
    });
    markStaticCredentialRotationStaged(database.sqlite, abortedOperationId, INCIDENT);
    const old = database.sqlite
      .prepare(
        `SELECT slot.slot, slot.active_generation AS generation, generation.token_sha256 AS tokenSha256
         FROM static_credential_slots slot JOIN static_credential_generations generation
           ON generation.id = slot.active_generation_id ORDER BY slot.slot`,
      )
      .all() as ExternalCredentialSecurityReceipt["slots"];
    const allOldAdapter: CredentialRotationFileAdapter = {
      inspect: async () => ({
        operationId: null,
        securityEpoch: 0,
        slots: old,
        receiptSha256: null,
      }),
      installForward: async () => {
        throw new Error("must not install an aborted rotation");
      },
      writeReceipt: async () => {
        throw new Error("must not write an aborted rotation receipt");
      },
    };
    await reconcileStaticCredentialRotation(
      database.sqlite,
      allOldAdapter,
      abortedOperationId,
      CUTOVER,
    );

    const committedMembers = nextMembers("after-abort");
    const committedOperationId = "scr_after_abort";
    const committedSourceId = insertDashboardAuthorizationEvent(
      database.sqlite,
      committedOperationId,
    );
    expect(() =>
      prepareStaticCredentialRotation(database.sqlite, dashboardPrincipal(), {
        operationId: committedOperationId,
        projectId: PROJECT,
        incidentStartedAt: INCIDENT,
        stopReceipt: stopReceipt(committedOperationId),
        authorizationSource: {
          kind: "DASHBOARD_EVENT",
          id: committedSourceId,
          projectId: PROJECT,
        },
        members: committedMembers,
        now: CUTOVER,
      }),
    ).not.toThrow();
    markStaticCredentialRotationStaged(database.sqlite, committedOperationId, CUTOVER);
    markStaticCredentialRotationSwitching(database.sqlite, committedOperationId, CUTOVER);
    markStaticCredentialFilesInstalled(
      database.sqlite,
      committedOperationId,
      installed(committedMembers),
      CUTOVER,
    );
    expect(() =>
      commitStaticCredentialRotation(database.sqlite, {
        operationId: committedOperationId,
        installedSecurityEpoch: 1,
        installedMembers: installed(committedMembers),
        at: CUTOVER,
      }),
    ).not.toThrow();
  });

  it("forward-installs all eight files after SWITCHING is journaled even when none changed", async () => {
    const operationId = "scr_switching_all_old";
    const members = nextMembers("switching");
    const sourceId = insertDashboardAuthorizationEvent(database.sqlite, operationId);
    prepareStaticCredentialRotation(database.sqlite, dashboardPrincipal(), {
      operationId,
      projectId: PROJECT,
      incidentStartedAt: INCIDENT,
      stopReceipt: stopReceipt(operationId),
      authorizationSource: { kind: "DASHBOARD_EVENT", id: sourceId, projectId: PROJECT },
      members,
      now: INCIDENT,
    });
    markStaticCredentialRotationStaged(database.sqlite, operationId, INCIDENT);
    markStaticCredentialRotationSwitching(database.sqlite, operationId, INCIDENT);
    const old = database.sqlite
      .prepare(
        `SELECT slot.slot, slot.active_generation AS generation, generation.token_sha256 AS tokenSha256
         FROM static_credential_slots slot JOIN static_credential_generations generation
           ON generation.id = slot.active_generation_id ORDER BY slot.slot`,
      )
      .all() as ExternalCredentialSecurityReceipt["slots"];
    let externalState: ExternalCredentialSecurityReceipt = {
      operationId: null,
      securityEpoch: 0,
      slots: old,
      receiptSha256: null,
    };
    let installedSlots: readonly string[] = [];
    const adapter: CredentialRotationFileAdapter = {
      inspect: async () => externalState,
      installForward: async (_operationId, missing) => {
        installedSlots = missing;
        externalState = {
          operationId: null,
          securityEpoch: 0,
          slots: installed(members),
          receiptSha256: null,
        };
      },
      writeReceipt: async (receipt) => {
        externalState = receipt;
      },
    };
    await expect(
      reconcileStaticCredentialRotation(database.sqlite, adapter, operationId, CUTOVER),
    ).resolves.toBe("COMPLETED");
    expect([...installedSlots].sort()).toEqual([...STATIC_CREDENTIAL_SLOTS].sort());
  });

  it("does not mark cleanup complete until the external receipt is durably observable", async () => {
    const members = nextMembers("missing-receipt");
    prepareThroughFiles(database.sqlite, members);
    commitStaticCredentialRotation(database.sqlite, {
      operationId: "scr_test_one",
      installedSecurityEpoch: 1,
      installedMembers: installed(members),
      at: CUTOVER,
    });
    const adapter: CredentialRotationFileAdapter = {
      inspect: async () => ({
        operationId: "scr_test_one",
        securityEpoch: 1,
        slots: installed(members),
        receiptSha256: null,
      }),
      installForward: async () => undefined,
      writeReceipt: async () => undefined,
    };
    await expect(
      reconcileStaticCredentialRotation(database.sqlite, adapter, "scr_test_one", CUTOVER),
    ).rejects.toMatchObject({ code: "ROTATION_INTEGRITY_FAILED" });
    expect(
      database.sqlite
        .prepare(
          `SELECT phase FROM static_credential_rotation_events
           WHERE operation_id = 'scr_test_one' ORDER BY sequence DESC LIMIT 1`,
        )
        .pluck()
        .get(),
    ).toBe("CLEANUP_PENDING");
  });

  it("forward-commits files-new/db-old and supplements a lost external receipt", async () => {
    const members = nextMembers();
    const sourceId = insertDashboardAuthorizationEvent(database.sqlite, "scr_forward_files");
    prepareStaticCredentialRotation(database.sqlite, dashboardPrincipal(), {
      operationId: "scr_forward_files",
      projectId: PROJECT,
      incidentStartedAt: INCIDENT,
      stopReceipt: stopReceipt("scr_forward_files"),
      authorizationSource: { kind: "DASHBOARD_EVENT", id: sourceId, projectId: PROJECT },
      members,
      now: INCIDENT,
    });
    markStaticCredentialRotationStaged(database.sqlite, "scr_forward_files", INCIDENT);
    let writtenReceipt: ExternalCredentialSecurityReceipt | null = null;
    const canonicalNew = installed(members);
    let externalState: ExternalCredentialSecurityReceipt = {
      operationId: null,
      securityEpoch: 0,
      slots: canonicalNew,
      receiptSha256: null,
    };
    const adapter: CredentialRotationFileAdapter = {
      inspect: async () => externalState,
      installForward: async () => {
        throw new Error("all canonical files are already new");
      },
      writeReceipt: async (receipt) => {
        writtenReceipt = receipt;
        externalState = receipt;
      },
    };
    await expect(
      reconcileStaticCredentialRotation(database.sqlite, adapter, "scr_forward_files", CUTOVER),
    ).resolves.toBe("COMPLETED");
    expect(writtenReceipt).toMatchObject({ operationId: "scr_forward_files", securityEpoch: 1 });
    expect(
      database.sqlite
        .prepare("SELECT security_epoch FROM static_credential_security_state")
        .pluck()
        .get(),
    ).toBe(1);

    database.sqlite.exec("DROP TRIGGER static_credential_external_receipts_immutable_delete");
    database.sqlite
      .prepare("DELETE FROM static_credential_external_receipts WHERE operation_id = ?")
      .run("scr_forward_files");
    database.sqlite.exec("DROP TRIGGER static_credential_rotation_events_immutable_delete");
    database.sqlite
      .prepare(
        `DELETE FROM static_credential_rotation_events
         WHERE operation_id = ? AND phase = 'COMPLETED'`,
      )
      .run("scr_forward_files");
    writtenReceipt = null;
    let lostExternalState: ExternalCredentialSecurityReceipt = {
      operationId: "scr_forward_files",
      securityEpoch: 1,
      slots: canonicalNew,
      receiptSha256: null,
    };
    const lostReceiptAdapter: CredentialRotationFileAdapter = {
      inspect: async () => lostExternalState,
      installForward: async () => {
        throw new Error("must not reinstall files");
      },
      writeReceipt: async (receipt) => {
        writtenReceipt = receipt;
        lostExternalState = receipt;
      },
    };
    await expect(
      reconcileStaticCredentialRotation(
        database.sqlite,
        lostReceiptAdapter,
        "scr_forward_files",
        "2026-08-01T12:11:00.000Z",
      ),
    ).resolves.toBe("COMPLETED");
    expect(writtenReceipt).toMatchObject({ operationId: "scr_forward_files", securityEpoch: 1 });
    expect(
      database.sqlite
        .prepare(
          `SELECT COUNT(*) FROM static_credential_incident_ticket_receipts
           WHERE operation_id = 'scr_forward_files'`,
        )
        .pluck()
        .get(),
    ).toBe(0);
  });

  it("forward-recovers an old database from a complete higher external epoch receipt", async () => {
    const members = nextMembers("external");
    prepareThroughFiles(database.sqlite, members);
    commitStaticCredentialRotation(database.sqlite, {
      operationId: "scr_test_one",
      installedSecurityEpoch: 1,
      installedMembers: installed(members),
      at: CUTOVER,
    });
    let external: ExternalCredentialSecurityReceipt | null = null;
    let capturedState: ExternalCredentialSecurityReceipt = {
      operationId: "scr_test_one",
      securityEpoch: 1,
      slots: installed(members),
      receiptSha256: null,
    };
    const captureAdapter: CredentialRotationFileAdapter = {
      inspect: async () => capturedState,
      installForward: async () => undefined,
      writeReceipt: async (receipt) => {
        external = receipt;
        capturedState = receipt;
      },
    };
    await reconcileStaticCredentialRotation(
      database.sqlite,
      captureAdapter,
      "scr_test_one",
      CUTOVER,
    );
    expect(external).not.toBeNull();

    const restoredRoot = mkdtempSync(resolve(tmpdir(), "crossagent-restored-epoch-"));
    const restored = await openDatabase(":memory:");
    try {
      initializeCredentialRegistry(restored.sqlite, restoredRoot);
      bootstrapStaticCredentialGenerations(restored.sqlite);
      insertProjectAndSession(restored.sqlite);
      const adapter: CredentialRotationFileAdapter = {
        inspect: async () => external!,
        installForward: async () => {
          throw new Error("external canonical files are already new");
        },
        writeReceipt: async () => undefined,
      };
      await expect(
        reconcileStaticCredentialRotation(
          restored.sqlite,
          adapter,
          "scr_test_one",
          "2026-08-01T12:12:00.000Z",
        ),
      ).rejects.toMatchObject({ code: "ROTATION_NOT_AUTHORIZED" });
      const recoverySourceId = insertDashboardAuthorizationEvent(
        restored.sqlite,
        "scr_test_one",
        PROJECT,
        "_recovery",
      );
      await expect(
        reconcileStaticCredentialRotation(
          restored.sqlite,
          adapter,
          "scr_test_one",
          "2026-08-01T12:12:00.000Z",
          {
            principal: dashboardPrincipal(),
            authorizationSource: {
              kind: "DASHBOARD_EVENT",
              id: recoverySourceId,
              projectId: PROJECT,
            },
          },
        ),
      ).resolves.toBe("COMPLETED");
      expect(
        restored.sqlite
          .prepare("SELECT security_epoch FROM static_credential_security_state")
          .pluck()
          .get(),
      ).toBe(1);
      assertCredentialRotationIntegrity(restored.sqlite, { externalSecurityEpoch: 1 });
    } finally {
      restored.sqlite.close();
      rmSync(restoredRoot, { recursive: true, force: true });
    }
  });

  it.each(["PREPARED", "STAGED", "SWITCHING"] as const)(
    "forward-recovers an existing %s database operation from the higher external receipt",
    async (restorePhase) => {
      const members = nextMembers("external-existing");
      const operationId = "scr_external_existing";
      const sourceId = insertDashboardAuthorizationEvent(database.sqlite, operationId);
      prepareStaticCredentialRotation(database.sqlite, dashboardPrincipal(), {
        operationId,
        projectId: PROJECT,
        incidentStartedAt: INCIDENT,
        stopReceipt: stopReceipt(operationId),
        authorizationSource: { kind: "DASHBOARD_EVENT", id: sourceId, projectId: PROJECT },
        members,
        now: INCIDENT,
      });
      markStaticCredentialRotationStaged(database.sqlite, operationId, INCIDENT);
      markStaticCredentialRotationSwitching(database.sqlite, operationId, INCIDENT);
      markStaticCredentialFilesInstalled(
        database.sqlite,
        operationId,
        installed(members),
        INCIDENT,
      );
      commitStaticCredentialRotation(database.sqlite, {
        operationId,
        installedSecurityEpoch: 1,
        installedMembers: installed(members),
        at: CUTOVER,
      });
      let externalState: ExternalCredentialSecurityReceipt = {
        operationId,
        securityEpoch: 1,
        slots: installed(members),
        receiptSha256: null,
      };
      const captureAdapter: CredentialRotationFileAdapter = {
        inspect: async () => externalState,
        installForward: async () => undefined,
        writeReceipt: async (receipt) => {
          externalState = receipt;
        },
      };
      await reconcileStaticCredentialRotation(
        database.sqlite,
        captureAdapter,
        operationId,
        CUTOVER,
      );
      const durableExternal = externalState;

      const restoredRoot = mkdtempSync(resolve(tmpdir(), `crossagent-${restorePhase}-`));
      const restored = await openDatabase(":memory:");
      try {
        initializeCredentialRegistry(restored.sqlite, restoredRoot);
        bootstrapStaticCredentialGenerations(restored.sqlite);
        insertProjectAndSession(restored.sqlite);
        const restoredSourceId = insertDashboardAuthorizationEvent(restored.sqlite, operationId);
        prepareStaticCredentialRotation(restored.sqlite, dashboardPrincipal(), {
          operationId,
          projectId: PROJECT,
          incidentStartedAt: INCIDENT,
          stopReceipt: stopReceipt(operationId),
          authorizationSource: {
            kind: "DASHBOARD_EVENT",
            id: restoredSourceId,
            projectId: PROJECT,
          },
          members,
          now: INCIDENT,
        });
        if (restorePhase !== "PREPARED") {
          markStaticCredentialRotationStaged(restored.sqlite, operationId, INCIDENT);
        }
        if (restorePhase === "SWITCHING") {
          markStaticCredentialRotationSwitching(restored.sqlite, operationId, INCIDENT);
        }
        const recoveryAdapter: CredentialRotationFileAdapter = {
          inspect: async () => durableExternal,
          installForward: async () => {
            throw new Error("external canonical files are already new");
          },
          writeReceipt: async () => undefined,
        };
        const recoverySourceId = insertDashboardAuthorizationEvent(
          restored.sqlite,
          operationId,
          PROJECT,
          `_recovery_${restorePhase.toLowerCase()}`,
        );
        await expect(
          reconcileStaticCredentialRotation(
            restored.sqlite,
            recoveryAdapter,
            operationId,
            CUTOVER,
            {
              principal: dashboardPrincipal(),
              authorizationSource: {
                kind: "DASHBOARD_EVENT",
                id: recoverySourceId,
                projectId: PROJECT,
              },
            },
          ),
        ).resolves.toBe("COMPLETED");
        assertCredentialRotationIntegrity(restored.sqlite, { externalSecurityEpoch: 1 });
      } finally {
        restored.sqlite.close();
        rmSync(restoredRoot, { recursive: true, force: true });
      }
    },
  );

  it("validates aborted and committed operations by epoch group, not same-millisecond ids", async () => {
    const abortedOperationId = "scr_z_same_millisecond_abort";
    const abortedMembers = nextMembers("same-ms-abort");
    const abortedSourceId = insertDashboardAuthorizationEvent(database.sqlite, abortedOperationId);
    prepareStaticCredentialRotation(database.sqlite, dashboardPrincipal(), {
      operationId: abortedOperationId,
      projectId: PROJECT,
      incidentStartedAt: INCIDENT,
      stopReceipt: stopReceipt(abortedOperationId),
      authorizationSource: {
        kind: "DASHBOARD_EVENT",
        id: abortedSourceId,
        projectId: PROJECT,
      },
      members: abortedMembers,
      now: INCIDENT,
    });
    markStaticCredentialRotationStaged(database.sqlite, abortedOperationId, INCIDENT);
    const old = database.sqlite
      .prepare(
        `SELECT slot.slot, slot.active_generation AS generation, generation.token_sha256 AS tokenSha256
         FROM static_credential_slots slot JOIN static_credential_generations generation
           ON generation.id = slot.active_generation_id ORDER BY slot.slot`,
      )
      .all() as ExternalCredentialSecurityReceipt["slots"];
    await reconcileStaticCredentialRotation(
      database.sqlite,
      {
        inspect: async () => ({
          operationId: null,
          securityEpoch: 0,
          slots: old,
          receiptSha256: null,
        }),
        installForward: async () => undefined,
        writeReceipt: async () => undefined,
      },
      abortedOperationId,
      CUTOVER,
    );

    const committedOperationId = "scr_a_same_millisecond_commit";
    const committedMembers = nextMembers("same-ms-commit");
    const committedSourceId = insertDashboardAuthorizationEvent(
      database.sqlite,
      committedOperationId,
    );
    prepareStaticCredentialRotation(database.sqlite, dashboardPrincipal(), {
      operationId: committedOperationId,
      projectId: PROJECT,
      incidentStartedAt: INCIDENT,
      stopReceipt: stopReceipt(committedOperationId),
      authorizationSource: {
        kind: "DASHBOARD_EVENT",
        id: committedSourceId,
        projectId: PROJECT,
      },
      members: committedMembers,
      now: INCIDENT,
    });
    markStaticCredentialRotationStaged(database.sqlite, committedOperationId, INCIDENT);
    markStaticCredentialRotationSwitching(database.sqlite, committedOperationId, INCIDENT);
    markStaticCredentialFilesInstalled(
      database.sqlite,
      committedOperationId,
      installed(committedMembers),
      INCIDENT,
    );
    expect(() =>
      commitStaticCredentialRotation(database.sqlite, {
        operationId: committedOperationId,
        installedSecurityEpoch: 1,
        installedMembers: installed(committedMembers),
        at: CUTOVER,
      }),
    ).not.toThrow();
    expect(() => assertCredentialRotationIntegrity(database.sqlite)).not.toThrow();
  });

  it("fails before listen on an external epoch fork or corrupt journal", () => {
    expect(() =>
      assertCredentialRotationIntegrity(database.sqlite, { externalSecurityEpoch: -1 }),
    ).toThrowError(expect.objectContaining({ code: "SECURITY_EPOCH_FORK" }));
    database.sqlite.exec("DROP TRIGGER static_credential_slots_immutable_delete");
    database.sqlite.prepare("DELETE FROM static_credential_slots WHERE slot = 'token'").run();
    expect(() => assertCredentialRotationIntegrity(database.sqlite)).toThrowError(
      expect.objectContaining({ code: "ROTATION_INTEGRITY_FAILED" }),
    );
  });

  it("recomputes append-only event hashes before accepting the journal", () => {
    const members = nextMembers("hash");
    prepareThroughFiles(database.sqlite, members);
    database.sqlite.exec("DROP TRIGGER static_credential_rotation_events_immutable_update");
    database.sqlite
      .prepare(
        `UPDATE static_credential_rotation_events SET event_sha256 = ?
         WHERE operation_id = 'scr_test_one' AND sequence = 2`,
      )
      .run("0".repeat(64));
    expect(() => assertCredentialRotationIntegrity(database.sqlite)).toThrowError(
      expect.objectContaining({ code: "ROTATION_INTEGRITY_FAILED" }),
    );
  });
});
