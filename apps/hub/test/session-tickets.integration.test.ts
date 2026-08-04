import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase, type HubDatabase } from "../src/db/database.js";
import { CredentialRegistry, initializeCredentialRegistry } from "../src/security/local-auth.js";
import {
  activateSessionTicketBundle,
  closeSessionTicketsForHubSession,
  createPendingSessionTicket,
  expireSessionTicketBundleForHubSession,
  getActiveSessionTicketBinding,
  revokeSessionTicketBundle,
  rotateSessionTicketBundleForSession,
  SESSION_TICKET_PURPOSES_BY_CLIENT,
  SESSION_TICKET_SCOPES,
} from "../src/security/session-tickets.js";

const PROJECT_ID = "prj_ticket_security";
const SESSION_ID = "ses_ticket_security";
const LINEAGE_ID = "lin_ticket_security";
const HOOK_SESSION_ID = "ses_ticket_hook";
const HOOK_LINEAGE_ID = "lin_ticket_hook";
const NOW = "2026-08-01T12:00:00.000Z";

function digest(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function bearer(token: string): FastifyRequest {
  return {
    headers: { authorization: `Bearer ${token}` },
    query: {},
  } as FastifyRequest;
}

function queryCredential(token: string): FastifyRequest {
  return { headers: {}, query: { token } } as FastifyRequest;
}

function insertActiveSession(sqlite: HubDatabase["sqlite"]): void {
  sqlite
    .prepare(
      `INSERT INTO projects(id, name, config_json, current_sequence, version, created_at, updated_at)
       VALUES (?, 'Ticket project', '{}', 0, 0, ?, ?)`,
    )
    .run(PROJECT_ID, NOW, NOW);
  sqlite
    .prepare(
      `INSERT INTO agents(id, project_id, display_name, capabilities_json, created_at, updated_at)
       VALUES ('codex', ?, 'Codex', '[]', ?, ?)`,
    )
    .run(PROJECT_ID, NOW, NOW);
  sqlite
    .prepare(
      `INSERT INTO session_lineages(
         id, project_id, agent_id, client, delivery_mode, identity_kind, identity_value,
         head_session_id, head_incarnation, launch_fence_required, reserved_generation,
         active_reservation_id, head_run_id, head_run_generation, version, created_at, updated_at
       ) VALUES (?, ?, 'codex', 'codex-app-server', 'app_server_push', 'external_thread',
         '019-test-thread', NULL, 0, 0, 0, NULL, NULL, NULL, 0, ?, ?)`,
    )
    .run(LINEAGE_ID, PROJECT_ID, NOW, NOW);
  sqlite
    .prepare(
      `INSERT INTO agent_sessions(
         id, project_id, agent_id, role, client, transport, delivery_mode,
         external_session_id, external_thread_id, external_turn_id, host, pid, cwd,
         git_branch, git_head, capabilities_json, connected_at, transport_last_seen_at,
         activity_last_seen_at, current_task_id, current_review_id, active_files_json,
         work_state, connection_state, heartbeat_sequence, queue_depth, version, closed_at,
         lineage_id, incarnation, predecessor_session_id, superseded_by_session_id,
         launcher_run_id, launch_generation
       ) VALUES (
         ?, ?, 'codex', 'primary', 'codex-app-server', 'websocket', 'app_server_push',
         '019-test-session', '019-test-thread', NULL, 'localhost', 1234, 'C:/projects/example',
         NULL, NULL, '[]', ?, ?, ?, NULL, NULL, '[]', 'IDLE', 'ONLINE', 0, 0, 0, NULL,
         ?, 1, NULL, NULL, 'run_ticket', 1
       )`,
    )
    .run(SESSION_ID, PROJECT_ID, NOW, NOW, NOW, LINEAGE_ID);
  sqlite
    .prepare(
      `UPDATE session_lineages
       SET head_session_id = ?, head_incarnation = 1, updated_at = ?
       WHERE id = ?`,
    )
    .run(SESSION_ID, NOW, LINEAGE_ID);
}

function insertActiveHookSession(sqlite: HubDatabase["sqlite"]): void {
  sqlite
    .prepare(
      `INSERT INTO session_lineages(
         id, project_id, agent_id, client, delivery_mode, identity_kind, identity_value,
         head_session_id, head_incarnation, launch_fence_required, reserved_generation,
         active_reservation_id, head_run_id, head_run_generation, version, created_at, updated_at
       ) VALUES (?, ?, 'codex', 'codex-cli-hooks', 'hook_poll', 'external_session',
         'codex-hook-external', NULL, 0, 0, 0, NULL, NULL, NULL, 0, ?, ?)`,
    )
    .run(HOOK_LINEAGE_ID, PROJECT_ID, NOW, NOW);
  sqlite
    .prepare(
      `INSERT INTO agent_sessions(
         id, project_id, agent_id, role, client, transport, delivery_mode,
         external_session_id, external_thread_id, external_turn_id, host, pid, cwd,
         git_branch, git_head, capabilities_json, connected_at, transport_last_seen_at,
         activity_last_seen_at, current_task_id, current_review_id, active_files_json,
         work_state, connection_state, heartbeat_sequence, queue_depth, version, closed_at,
         lineage_id, incarnation, predecessor_session_id, superseded_by_session_id,
         launcher_run_id, launch_generation
       ) VALUES (
         ?, ?, 'codex', 'primary', 'codex-cli-hooks', 'hook-poll', 'hook_poll',
         'codex-hook-external', NULL, NULL, 'localhost', 1235, 'C:/projects/example',
         NULL, NULL, '[]', ?, ?, ?, NULL, NULL, '[]', 'IDLE', 'ONLINE', 0, 0, 0, NULL,
         ?, 1, NULL, NULL, 'run_hook_ticket', 1
       )`,
    )
    .run(HOOK_SESSION_ID, PROJECT_ID, NOW, NOW, NOW, HOOK_LINEAGE_ID);
  sqlite
    .prepare(
      `UPDATE session_lineages
       SET head_session_id = ?, head_incarnation = 1, updated_at = ?
       WHERE id = ?`,
    )
    .run(HOOK_SESSION_ID, NOW, HOOK_LINEAGE_ID);
}

describe("session-bound adapter tickets", () => {
  let root: string;
  let database: HubDatabase;
  let registry: CredentialRegistry;

  beforeEach(async () => {
    // The fixture issues every ticket at NOW, but authentication reads the real wall clock
    // (local-auth.ts builds its `now` from `new Date()`). An ACTIVE ticket lives twenty-four hours,
    // so once real time passed NOW + 24h every test that authenticates one began failing on its
    // own -- nine of them, with no code change involved. Pinning the clock makes the suite hermetic
    // rather than valid only on the day it was written. Only Date is faked: the setup below awaits
    // real I/O, which faked timers would stall.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    root = mkdtempSync(resolve(tmpdir(), "crossagent-session-ticket-"));
    database = await openDatabase(":memory:");
    registry = initializeCredentialRegistry(database.sqlite, root);
    insertActiveSession(database.sqlite);
  });

  afterEach(() => {
    vi.useRealTimers();
    database.sqlite.close();
    rmSync(root, { recursive: true, force: true });
  });

  function offerCodexAppServerBundle(
    bundleId: string,
    externalSessionId = "019-test-session",
    now = NOW,
  ): {
    tokens: Record<"CONTROL" | "MODEL_MCP" | "INJECTOR", string>;
    controlId: string;
  } {
    const tokens = {
      CONTROL: randomBytes(32).toString("base64url"),
      MODEL_MCP: randomBytes(32).toString("base64url"),
      INJECTOR: randomBytes(32).toString("base64url"),
    };
    const offers = (["CONTROL", "MODEL_MCP", "INJECTOR"] as const).map((ticketPurpose) =>
      createPendingSessionTicket(database.sqlite, {
        bundleId,
        purpose: ticketPurpose,
        tokenSha256: digest(tokens[ticketPurpose]),
        offeredByAuthCredentialId:
          ticketPurpose === "INJECTOR" ? "crd_inject_codex" : "crd_agent_codex",
        projectId: PROJECT_ID,
        adapterClient: "codex",
        agentId: "codex",
        sessionClient: "codex-app-server",
        role: "primary",
        transport: "websocket",
        deliveryMode: "app_server_push",
        externalSessionId,
        externalThreadId: "019-test-thread",
        runId: "run_ticket",
        activationMode: "FIRST_LINEAGE",
        idempotencyKey: `offer-${bundleId}-${ticketPurpose}`,
        now,
      }),
    );
    const control = offers.find((offer) => offer.purpose === "CONTROL")!;
    return { tokens, controlId: control.id };
  }

  function issueAndActivate(purpose: "CONTROL" | "MODEL_MCP" | "INJECTOR" = "CONTROL"): string {
    const bundleId = `stb_${purpose.toLowerCase()}`;
    const offered = offerCodexAppServerBundle(bundleId);
    activateSessionTicketBundle(database.sqlite, {
      bundleId,
      hubSessionId: SESSION_ID,
      lineageId: LINEAGE_ID,
      incarnation: 1,
      proof: { kind: "FIRST_LINEAGE", controlTicketId: offered.controlId },
      now: NOW,
    });
    return offered.tokens[purpose];
  }

  function offerAndActivateHookBundle(): {
    tokens: Record<"CONTROL" | "CAPTURE", string>;
    ids: Record<"CONTROL" | "CAPTURE", string>;
  } {
    insertActiveHookSession(database.sqlite);
    const tokens = {
      CONTROL: randomBytes(32).toString("base64url"),
      CAPTURE: randomBytes(32).toString("base64url"),
    };
    const offers = SESSION_TICKET_PURPOSES_BY_CLIENT["codex-cli-hooks"].map((purpose) =>
      createPendingSessionTicket(database.sqlite, {
        bundleId: "stb_hook_active",
        purpose,
        tokenSha256: digest(tokens[purpose]),
        offeredByAuthCredentialId: purpose === "CAPTURE" ? "crd_capture_codex" : "crd_agent_codex",
        projectId: PROJECT_ID,
        adapterClient: "codex",
        agentId: "codex",
        sessionClient: "codex-cli-hooks",
        role: "primary",
        transport: "hook-poll",
        deliveryMode: "hook_poll",
        externalSessionId: "codex-hook-external",
        runId: "run_hook_ticket",
        activationMode: "FIRST_LINEAGE",
        idempotencyKey: `hook-active-${purpose}`,
        now: NOW,
      }),
    );
    const ids = Object.fromEntries(offers.map((offer) => [offer.purpose, offer.id])) as Record<
      "CONTROL" | "CAPTURE",
      string
    >;
    activateSessionTicketBundle(database.sqlite, {
      bundleId: "stb_hook_active",
      hubSessionId: HOOK_SESSION_ID,
      lineageId: HOOK_LINEAGE_ID,
      incarnation: 1,
      proof: { kind: "FIRST_LINEAGE", controlTicketId: ids.CONTROL },
      now: NOW,
    });
    return { tokens, ids };
  }

  function offerCodexRotationBundle(
    bundleId: string,
    predecessorControlTicketId: string,
    now: string,
  ): {
    tokens: Record<"CONTROL" | "MODEL_MCP" | "INJECTOR", string>;
    controlId: string;
  } {
    const tokens = {
      CONTROL: randomBytes(32).toString("base64url"),
      MODEL_MCP: randomBytes(32).toString("base64url"),
      INJECTOR: randomBytes(32).toString("base64url"),
    };
    const offers = SESSION_TICKET_PURPOSES_BY_CLIENT["codex-app-server"].map((purpose) =>
      createPendingSessionTicket(database.sqlite, {
        bundleId,
        purpose,
        tokenSha256: digest(tokens[purpose]),
        ...(purpose === "INJECTOR"
          ? { offeredByAuthCredentialId: "crd_inject_codex" }
          : { offeredByTicketId: predecessorControlTicketId }),
        projectId: PROJECT_ID,
        adapterClient: "codex",
        agentId: "codex",
        sessionClient: "codex-app-server",
        role: "primary",
        transport: "websocket",
        deliveryMode: "app_server_push",
        externalSessionId: "019-test-session",
        externalThreadId: "019-test-thread",
        runId: "run_ticket",
        activationMode: "SESSION_AUXILIARY",
        expectedLineageId: LINEAGE_ID,
        expectedHeadSessionId: SESSION_ID,
        idempotencyKey: `rotate-${bundleId}-${purpose}`,
        now,
      }),
    );
    return { tokens, controlId: offers.find((offer) => offer.purpose === "CONTROL")!.id };
  }

  it("keeps static adapter credentials out of every data plane", () => {
    expect(() =>
      registry.authenticate(
        bearer(registry.credentials.agentByClient.codex.token),
        SESSION_TICKET_SCOPES.CONTROL,
      ),
    ).toThrow(/required scope/i);
    expect(() =>
      registry.authenticate(
        bearer(registry.credentials.capture.codex.token),
        SESSION_TICKET_SCOPES.CAPTURE,
      ),
    ).toThrow(/required scope/i);
    expect(() =>
      registry.authenticate(
        bearer(registry.credentials.injector.codex.token),
        SESSION_TICKET_SCOPES.INJECTOR,
      ),
    ).toThrow(/required scope/i);
  });

  it("invalidates CAPTURE and INJECTOR when their offering root is revoked", () => {
    const hook = offerAndActivateHookBundle();
    const capturePrincipal = registry.authenticate(
      bearer(hook.tokens.CAPTURE),
      SESSION_TICKET_SCOPES.CAPTURE,
    );
    database.sqlite
      .prepare("UPDATE auth_credentials SET revoked_at = ? WHERE id = 'crd_capture_codex'")
      .run(NOW);
    expect(() =>
      registry.authenticate(bearer(hook.tokens.CAPTURE), SESSION_TICKET_SCOPES.CAPTURE),
    ).toThrow(/invalid.*local bearer/i);
    expect(() => registry.revalidate(capturePrincipal)).toThrow(/no longer active/i);

    const injectorToken = issueAndActivate("INJECTOR");
    const injectorPrincipal = registry.authenticate(
      bearer(injectorToken),
      SESSION_TICKET_SCOPES.INJECTOR,
    );
    database.sqlite
      .prepare("UPDATE auth_credentials SET revoked_at = ? WHERE id = 'crd_inject_codex'")
      .run(NOW);
    expect(() =>
      registry.authenticate(bearer(injectorToken), SESSION_TICKET_SCOPES.INJECTOR),
    ).toThrow(/invalid.*local bearer/i);
    expect(() => registry.revalidate(injectorPrincipal)).toThrow(/no longer active/i);
  });

  it("keeps an activated CONTROL independent from later bootstrap-root revocation", () => {
    const token = issueAndActivate("CONTROL");
    const before = registry.authenticate(bearer(token), SESSION_TICKET_SCOPES.CONTROL);
    database.sqlite
      .prepare("UPDATE auth_credentials SET revoked_at = ? WHERE id = 'crd_agent_codex'")
      .run(NOW);

    expect(registry.authenticate(bearer(token), SESSION_TICKET_SCOPES.CONTROL)).toMatchObject({
      credentialId: before.credentialId,
      ticketState: "ACTIVE",
      scopes: SESSION_TICKET_SCOPES.CONTROL,
    });
    expect(registry.revalidate(before)).toMatchObject({ credentialId: before.credentialId });
  });

  it("accepts terminal CAPTURE raw only for zero-scope exact receipt replay", () => {
    const hook = offerAndActivateHookBundle();
    expect(() => registry.authenticateTerminalCaptureReplay(bearer(hook.tokens.CAPTURE))).toThrow(
      /terminal CAPTURE replay/i,
    );
    closeSessionTicketsForHubSession(database.sqlite, {
      hubSessionId: HOOK_SESSION_ID,
      reason: "hook session closed",
      now: NOW,
    });

    expect(registry.authenticateTerminalCaptureReplay(bearer(hook.tokens.CAPTURE))).toMatchObject({
      credentialId: hook.ids.CAPTURE,
      ticketPurpose: "CAPTURE",
      ticketState: "REVOKED",
      hubSessionId: HOOK_SESSION_ID,
      projectId: PROJECT_ID,
      scopes: [],
    });
    expect(() =>
      registry.authenticateTerminalCaptureReplay(queryCredential(hook.tokens.CAPTURE)),
    ).toThrow(/invalid local bearer/i);
    expect(() =>
      registry.authenticateTerminalCaptureReplay(bearer(registry.credentials.capture.codex.token)),
    ).toThrow(/terminal CAPTURE replay/i);
  });

  it("accepts only exact current-head logical expiry for dormant replacement", () => {
    const hook = offerAndActivateHookBundle();
    const afterExpiry = "2026-08-02T12:00:00.001Z";
    expireSessionTicketBundleForHubSession(database.sqlite, {
      hubSessionId: HOOK_SESSION_ID,
      now: afterExpiry,
    });

    expect(
      registry.authenticateExpiredControlReplacementRecovery(bearer(hook.tokens.CONTROL)),
    ).toMatchObject({
      credentialId: hook.ids.CONTROL,
      ticketPurpose: "CONTROL",
      ticketState: "EXPIRED",
      hubSessionId: HOOK_SESSION_ID,
      lineageId: HOOK_LINEAGE_ID,
      projectId: PROJECT_ID,
      scopes: [],
    });
    expect(() =>
      registry.authenticate(bearer(hook.tokens.CONTROL), SESSION_TICKET_SCOPES.CONTROL),
    ).toThrow(/invalid.*local bearer/i);
    expect(() =>
      registry.authenticateExpiredControlReplacementRecovery(queryCredential(hook.tokens.CONTROL)),
    ).toThrow(/invalid local bearer/i);

    database.sqlite.exec("DROP TRIGGER live_session_fence_lineage_update");
    database.sqlite
      .prepare("UPDATE session_lineages SET head_session_id = NULL WHERE id = ?")
      .run(HOOK_LINEAGE_ID);
    expect(() =>
      registry.authenticateExpiredControlReplacementRecovery(bearer(hook.tokens.CONTROL)),
    ).toThrow(/expired CONTROL recovery/i);

    const revoked = offerCodexAppServerBundle("stb_recovery_revoke");
    activateSessionTicketBundle(database.sqlite, {
      bundleId: "stb_recovery_revoke",
      hubSessionId: SESSION_ID,
      lineageId: LINEAGE_ID,
      incarnation: 1,
      proof: { kind: "FIRST_LINEAGE", controlTicketId: revoked.controlId },
      now: NOW,
    });
    closeSessionTicketsForHubSession(database.sqlite, {
      hubSessionId: SESSION_ID,
      reason: "revoked fixture",
      now: NOW,
    });
    expect(() =>
      registry.authenticateExpiredControlReplacementRecovery(bearer(revoked.tokens.CONTROL)),
    ).toThrow(/expired CONTROL recovery/i);
    expect(() =>
      database.sqlite
        .prepare(
          `INSERT INTO adapter_session_tickets(
             id, bundle_id, purpose, token_sha256, offered_by_auth_credential_id,
             offered_by_ticket_id, project_id, adapter_client, agent_id, session_client,
             role, transport, delivery_mode, external_session_id, external_thread_id,
             run_id, activation_mode, expected_lineage_id, expected_head_session_id,
             launch_reservation_id, hub_session_id, lineage_id, incarnation,
             idempotency_key, request_sha256, state, offer_expires_at, expires_at,
             created_at, updated_at, activated_at, terminal_at, terminal_reason
           ) VALUES (
             'stk_revoked_offer_sql', 'stb_revoked_offer_sql', 'CONTROL', ?, NULL,
             ?, ?, 'codex', 'codex', 'codex-app-server',
             'primary', 'websocket', 'app_server_push', '019-test-session', '019-test-thread',
             'run_revoked_offer', 'CURRENT_HEAD_REPLACEMENT', ?, ?,
             NULL, NULL, NULL, NULL,
             'revoked-offer-sql', ?, 'PENDING', '2026-08-01T12:10:00.000Z', NULL,
             ?, ?, NULL, NULL, NULL
           )`,
        )
        .run(
          digest(randomBytes(32).toString("base64url")),
          revoked.controlId,
          PROJECT_ID,
          LINEAGE_ID,
          SESSION_ID,
          "d".repeat(64),
          NOW,
          NOW,
        ),
    ).toThrow(/TICKET_OFFER_NOT_AUTHORIZED/);

    const superseded = offerCodexAppServerBundle("stb_recovery_supersede");
    activateSessionTicketBundle(database.sqlite, {
      bundleId: "stb_recovery_supersede",
      hubSessionId: SESSION_ID,
      lineageId: LINEAGE_ID,
      incarnation: 1,
      proof: { kind: "FIRST_LINEAGE", controlTicketId: superseded.controlId },
      now: NOW,
    });
    closeSessionTicketsForHubSession(database.sqlite, {
      hubSessionId: SESSION_ID,
      reason: "superseded fixture",
      state: "SUPERSEDED",
      now: NOW,
    });
    expect(() =>
      registry.authenticateExpiredControlReplacementRecovery(bearer(superseded.tokens.CONTROL)),
    ).toThrow(/expired CONTROL recovery/i);
  });

  it("lets an exact whole-bundle EXPIRED CONTROL activate only a dormant head replacement", () => {
    const source = offerCodexAppServerBundle("stb_dormant_offer_source");
    activateSessionTicketBundle(database.sqlite, {
      bundleId: "stb_dormant_offer_source",
      hubSessionId: SESSION_ID,
      lineageId: LINEAGE_ID,
      incarnation: 1,
      proof: { kind: "FIRST_LINEAGE", controlTicketId: source.controlId },
      now: NOW,
    });
    const afterExpiry = "2026-08-02T12:00:00.001Z";
    vi.useFakeTimers();
    vi.setSystemTime(afterExpiry);
    expect(() =>
      registry.authenticate(bearer(source.tokens.CONTROL), SESSION_TICKET_SCOPES.CONTROL),
    ).toThrow(/invalid.*local bearer/i);
    expect(
      registry.authenticateExpiredControlReplacementRecovery(
        bearer(source.tokens.CONTROL),
        afterExpiry,
      ),
    ).toMatchObject({
      credentialId: source.controlId,
      ticketPurpose: "CONTROL",
      ticketState: "EXPIRED",
      hubSessionId: SESSION_ID,
      lineageId: LINEAGE_ID,
      scopes: [],
    });
    expect(
      database.sqlite
        .prepare("SELECT DISTINCT state FROM adapter_session_tickets WHERE bundle_id = ?")
        .pluck()
        .all("stb_dormant_offer_source"),
    ).toEqual(["ACTIVE"]);

    expect(() =>
      createPendingSessionTicket(database.sqlite, {
        bundleId: "stb_dormant_auxiliary_denied",
        purpose: "CONTROL",
        tokenSha256: digest(randomBytes(32).toString("base64url")),
        offeredByTicketId: source.controlId,
        projectId: PROJECT_ID,
        adapterClient: "codex",
        agentId: "codex",
        sessionClient: "codex-app-server",
        role: "primary",
        transport: "websocket",
        deliveryMode: "app_server_push",
        externalSessionId: "019-test-session",
        externalThreadId: "019-test-thread",
        runId: "run_ticket",
        activationMode: "SESSION_AUXILIARY",
        expectedLineageId: LINEAGE_ID,
        expectedHeadSessionId: SESSION_ID,
        idempotencyKey: "dormant-auxiliary-denied",
        now: afterExpiry,
      }),
    ).toThrow(/TICKET_OFFER_NOT_AUTHORIZED/);

    const offers = SESSION_TICKET_PURPOSES_BY_CLIENT["codex-app-server"].map((purpose) =>
      createPendingSessionTicket(database.sqlite, {
        bundleId: "stb_dormant_replacement",
        purpose,
        tokenSha256: digest(randomBytes(32).toString("base64url")),
        ...(purpose === "INJECTOR"
          ? { offeredByAuthCredentialId: "crd_inject_codex" }
          : { offeredByTicketId: source.controlId }),
        projectId: PROJECT_ID,
        adapterClient: "codex",
        agentId: "codex",
        sessionClient: "codex-app-server",
        role: "primary",
        transport: "websocket",
        deliveryMode: "app_server_push",
        externalSessionId: "019-test-session",
        externalThreadId: "019-test-thread",
        runId: "run_dormant_successor",
        activationMode: "CURRENT_HEAD_REPLACEMENT",
        expectedLineageId: LINEAGE_ID,
        expectedHeadSessionId: SESSION_ID,
        idempotencyKey: `dormant-replacement-${purpose}`,
        now: afterExpiry,
      }),
    );

    expect(offers).toHaveLength(3);
    expect(
      database.sqlite
        .prepare(
          `SELECT COUNT(*) FROM adapter_session_tickets
           WHERE bundle_id = 'stb_dormant_replacement' AND state = 'PENDING'`,
        )
        .pluck()
        .get(),
    ).toBe(3);

    const successorId = "ses_dormant_successor";
    database.sqlite
      .prepare(
        `INSERT INTO agent_sessions(
           id, project_id, agent_id, role, client, transport, delivery_mode,
           external_session_id, external_thread_id, external_turn_id, host, pid, cwd,
           git_branch, git_head, capabilities_json, connected_at, transport_last_seen_at,
           activity_last_seen_at, current_task_id, current_review_id, active_files_json,
           work_state, connection_state, heartbeat_sequence, queue_depth, version, closed_at,
           lineage_id, incarnation, predecessor_session_id, superseded_by_session_id,
           launcher_run_id, launch_generation
         ) VALUES (
           ?, ?, 'codex', 'primary', 'codex-app-server', 'websocket', 'app_server_push',
           '019-test-session', '019-test-thread', NULL, 'localhost', 1236, 'C:/projects/example',
           NULL, NULL, '[]', ?, ?, ?, NULL, NULL, '[]', 'IDLE', 'ONLINE', 0, 0, 0, NULL,
           ?, 2, ?, NULL, 'run_dormant_successor', NULL
         )`,
      )
      .run(successorId, PROJECT_ID, afterExpiry, afterExpiry, afterExpiry, LINEAGE_ID, SESSION_ID);
    database.sqlite
      .prepare(
        `UPDATE session_lineages
         SET head_session_id = ?, head_incarnation = 2, version = version + 1, updated_at = ?
         WHERE id = ? AND head_session_id = ? AND head_incarnation = 1`,
      )
      .run(successorId, afterExpiry, LINEAGE_ID, SESSION_ID);

    expect(
      activateSessionTicketBundle(database.sqlite, {
        bundleId: "stb_dormant_replacement",
        hubSessionId: successorId,
        lineageId: LINEAGE_ID,
        incarnation: 2,
        proof: { kind: "EXPIRED_CURRENT_HEAD_CONTROL", controlTicketId: source.controlId },
        now: afterExpiry,
      }),
    ).toMatchObject({
      bundleId: "stb_dormant_replacement",
      state: "ACTIVE",
      hubSessionId: successorId,
      incarnation: 2,
    });
  });

  it("authenticates only an ACTIVE ticket with its exact session binding", () => {
    const token = issueAndActivate();
    const principal = registry.authenticate(bearer(token), SESSION_TICKET_SCOPES.CONTROL);

    expect(principal).toMatchObject({
      credentialClass: "SESSION_TICKET",
      projectId: PROJECT_ID,
      agentId: "codex",
      adapterClient: "codex",
      hubSessionId: SESSION_ID,
      lineageId: LINEAGE_ID,
      incarnation: 1,
      ticketPurpose: "CONTROL",
      ticketState: "ACTIVE",
    });
    expect(principal).not.toHaveProperty("sessionId");
    expect(() =>
      registry.authenticate(queryCredential(token), SESSION_TICKET_SCOPES.CONTROL),
    ).toThrow(/invalid local bearer/i);
  });

  it("uses Hub-owned ten-minute offer and twenty-four-hour active expiries", () => {
    const token = issueAndActivate();
    const binding = getActiveSessionTicketBinding(database.sqlite, { hubSessionId: SESSION_ID });
    const stored = database.sqlite
      .prepare(
        `SELECT DISTINCT offer_expires_at, expires_at
         FROM adapter_session_tickets WHERE bundle_id = 'stb_control'`,
      )
      .all();

    expect(stored).toEqual([
      {
        offer_expires_at: "2026-08-01T12:10:00.000Z",
        expires_at: "2026-08-02T12:00:00.000Z",
      },
    ]);
    expect(binding.expiresAt).toBe("2026-08-02T12:00:00.000Z");
    expect(registry.authenticate(bearer(token), SESSION_TICKET_SCOPES.CONTROL).ticketState).toBe(
      "ACTIVE",
    );
  });

  it("uses one exact purpose matrix and real delivery enum for every Adapter client", () => {
    expect(SESSION_TICKET_PURPOSES_BY_CLIENT).toEqual({
      "codex-app-server": ["CONTROL", "MODEL_MCP", "INJECTOR"],
      "codex-cli-hooks": ["CONTROL", "CAPTURE"],
      "claude-channel": ["CONTROL"],
      "claude-hooks": ["CONTROL", "CAPTURE"],
    });
    const fixtures = [
      {
        bundleId: "stb_fixture_codex_hooks",
        adapterClient: "codex" as const,
        sessionClient: "codex-cli-hooks" as const,
        transport: "hook-poll" as const,
        deliveryMode: "hook_poll" as const,
      },
      {
        bundleId: "stb_fixture_claude_channel",
        adapterClient: "claude" as const,
        sessionClient: "claude-channel" as const,
        transport: "websocket" as const,
        deliveryMode: "native_channel" as const,
      },
      {
        bundleId: "stb_fixture_claude_hooks",
        adapterClient: "claude" as const,
        sessionClient: "claude-hooks" as const,
        transport: "hook-poll" as const,
        deliveryMode: "hook_poll" as const,
      },
    ];
    for (const fixture of fixtures) {
      for (const purpose of SESSION_TICKET_PURPOSES_BY_CLIENT[fixture.sessionClient]) {
        createPendingSessionTicket(database.sqlite, {
          bundleId: fixture.bundleId,
          purpose,
          tokenSha256: digest(randomBytes(32).toString("base64url")),
          offeredByAuthCredentialId:
            purpose === "CAPTURE"
              ? `crd_capture_${fixture.adapterClient}`
              : `crd_agent_${fixture.adapterClient}`,
          projectId: PROJECT_ID,
          adapterClient: fixture.adapterClient,
          agentId: fixture.adapterClient,
          sessionClient: fixture.sessionClient,
          role: "primary",
          transport: fixture.transport,
          deliveryMode: fixture.deliveryMode,
          runId: `run_${fixture.bundleId}`,
          activationMode: "FIRST_LINEAGE",
          idempotencyKey: `fixture-${fixture.bundleId}-${purpose}`,
          now: NOW,
        });
      }
    }
    expect(
      database.sqlite
        .prepare(
          `SELECT bundle_id, delivery_mode, group_concat(purpose, ',') AS purposes,
                  group_concat(state, ',') AS states
           FROM (
             SELECT bundle_id, delivery_mode, purpose, state
             FROM adapter_session_tickets
             WHERE bundle_id LIKE 'stb_fixture_%'
             ORDER BY bundle_id, purpose
           )
           GROUP BY bundle_id, delivery_mode
           ORDER BY bundle_id`,
        )
        .all(),
    ).toEqual([
      {
        bundle_id: "stb_fixture_claude_channel",
        delivery_mode: "native_channel",
        purposes: "CONTROL",
        states: "PENDING",
      },
      {
        bundle_id: "stb_fixture_claude_hooks",
        delivery_mode: "hook_poll",
        purposes: "CAPTURE,CONTROL",
        states: "PENDING,PENDING",
      },
      {
        bundle_id: "stb_fixture_codex_hooks",
        delivery_mode: "hook_poll",
        purposes: "CAPTURE,CONTROL",
        states: "PENDING,PENDING",
      },
    ]);
  });

  it("proactively rotates a live session for days while every predecessor raw ticket dies", () => {
    const initial = offerCodexAppServerBundle("stb_rotation_0");
    activateSessionTicketBundle(database.sqlite, {
      bundleId: "stb_rotation_0",
      hubSessionId: SESSION_ID,
      lineageId: LINEAGE_ID,
      incarnation: 1,
      proof: { kind: "FIRST_LINEAGE", controlTicketId: initial.controlId },
      now: NOW,
    });
    let currentControlId = initial.controlId;
    let currentToken = initial.tokens.CONTROL;
    const rotations = [
      { bundleId: "stb_rotation_1", now: "2026-08-02T08:00:00.000Z" },
      { bundleId: "stb_rotation_2", now: "2026-08-03T04:00:00.000Z" },
      { bundleId: "stb_rotation_3", now: "2026-08-04T00:00:00.000Z" },
    ];
    for (const rotation of rotations) {
      const predecessorToken = currentToken;
      const offered = offerCodexRotationBundle(rotation.bundleId, currentControlId, rotation.now);
      const result = rotateSessionTicketBundleForSession(database.sqlite, {
        bundleId: rotation.bundleId,
        hubSessionId: SESSION_ID,
        lineageId: LINEAGE_ID,
        incarnation: 1,
        proof: { kind: "SESSION_AUXILIARY", controlTicketId: currentControlId },
        now: rotation.now,
      });

      expect(result.binding).toMatchObject({
        bundleId: rotation.bundleId,
        state: "ACTIVE",
        expiresAt: new Date(Date.parse(rotation.now) + 24 * 60 * 60 * 1000).toISOString(),
      });
      expect(result.superseded).toMatchObject({ state: "SUPERSEDED", hubSessionId: SESSION_ID });
      expect(() =>
        registry.authenticate(bearer(predecessorToken), SESSION_TICKET_SCOPES.CONTROL),
      ).toThrow(/invalid.*local bearer/i);
      expect(
        registry.authenticate(bearer(offered.tokens.CONTROL), SESSION_TICKET_SCOPES.CONTROL),
      ).toMatchObject({ credentialId: offered.controlId, ticketState: "ACTIVE" });
      expect(
        database.sqlite
          .prepare(
            `SELECT COUNT(*) FROM adapter_session_tickets
             WHERE hub_session_id = ? AND purpose = 'CONTROL' AND state = 'ACTIVE'`,
          )
          .pluck()
          .get(SESSION_ID),
      ).toBe(1);
      currentControlId = offered.controlId;
      currentToken = offered.tokens.CONTROL;
    }
  });

  it("rolls back a successor activation if exact predecessor terminalization fails", () => {
    const initial = offerCodexAppServerBundle("stb_rotation_rollback_0");
    activateSessionTicketBundle(database.sqlite, {
      bundleId: "stb_rotation_rollback_0",
      hubSessionId: SESSION_ID,
      lineageId: LINEAGE_ID,
      incarnation: 1,
      proof: { kind: "FIRST_LINEAGE", controlTicketId: initial.controlId },
      now: NOW,
    });
    const nextNow = "2026-08-02T08:00:00.000Z";
    const successor = offerCodexRotationBundle(
      "stb_rotation_rollback_1",
      initial.controlId,
      nextNow,
    );
    database.sqlite.exec(`
      CREATE TEMP TRIGGER fixture_reject_rotation_terminalization
      BEFORE UPDATE OF state ON adapter_session_tickets
      WHEN OLD.bundle_id = 'stb_rotation_rollback_0' AND NEW.state = 'SUPERSEDED'
      BEGIN
        SELECT RAISE(ABORT, 'fixture terminalization failure');
      END;
    `);

    expect(() =>
      rotateSessionTicketBundleForSession(database.sqlite, {
        bundleId: "stb_rotation_rollback_1",
        hubSessionId: SESSION_ID,
        lineageId: LINEAGE_ID,
        incarnation: 1,
        proof: { kind: "SESSION_AUXILIARY", controlTicketId: initial.controlId },
        now: nextNow,
      }),
    ).toThrow(/fixture terminalization failure/i);
    database.sqlite.exec("DROP TRIGGER fixture_reject_rotation_terminalization");
    expect(
      database.sqlite
        .prepare(
          `SELECT group_concat(DISTINCT state) FROM adapter_session_tickets
           WHERE bundle_id = 'stb_rotation_rollback_1'`,
        )
        .pluck()
        .get(),
    ).toBe("PENDING");
    expect(
      registry.authenticate(bearer(initial.tokens.CONTROL), SESSION_TICKET_SCOPES.CONTROL),
    ).toMatchObject({ ticketState: "ACTIVE" });
    expect(() =>
      registry.authenticate(bearer(successor.tokens.CONTROL), SESSION_TICKET_SCOPES.CONTROL),
    ).toThrow(/invalid.*local bearer/i);
  });

  it("uses an expired CONTROL raw only for exact zero-scope close recovery", () => {
    const activationTime = "2020-08-01T12:00:00.000Z";
    const initial = offerCodexAppServerBundle(
      "stb_expired_recovery",
      "019-test-session",
      activationTime,
    );
    activateSessionTicketBundle(database.sqlite, {
      bundleId: "stb_expired_recovery",
      hubSessionId: SESSION_ID,
      lineageId: LINEAGE_ID,
      incarnation: 1,
      proof: { kind: "FIRST_LINEAGE", controlTicketId: initial.controlId },
      now: activationTime,
    });
    const afterExpiry = "2020-08-02T12:00:00.001Z";

    expect(() =>
      registry.authenticate(bearer(initial.tokens.CONTROL), SESSION_TICKET_SCOPES.CONTROL),
    ).toThrow(/invalid.*local bearer/i);
    expect(() =>
      createPendingSessionTicket(database.sqlite, {
        bundleId: "stb_expired_reoffer",
        purpose: "CONTROL",
        tokenSha256: digest(randomBytes(32).toString("base64url")),
        offeredByTicketId: initial.controlId,
        projectId: PROJECT_ID,
        adapterClient: "codex",
        agentId: "codex",
        sessionClient: "codex-app-server",
        role: "primary",
        transport: "websocket",
        deliveryMode: "app_server_push",
        externalSessionId: "019-test-session",
        externalThreadId: "019-test-thread",
        runId: "run_ticket",
        activationMode: "SESSION_AUXILIARY",
        expectedLineageId: LINEAGE_ID,
        expectedHeadSessionId: SESSION_ID,
        idempotencyKey: "expired-reoffer",
        now: afterExpiry,
      }),
    ).toThrow(/TICKET_OFFER_NOT_AUTHORIZED/);
    expect(
      registry.authenticateExpiredTicketCloseRecovery(bearer(initial.tokens.CONTROL), {
        hubSessionId: SESSION_ID,
        now: afterExpiry,
      }),
    ).toMatchObject({
      credentialId: initial.controlId,
      ticketPurpose: "CONTROL",
      ticketState: "EXPIRED",
      hubSessionId: SESSION_ID,
      scopes: [],
    });
    expect(() =>
      registry.authenticateExpiredTicketCloseRecovery(bearer(initial.tokens.CONTROL), {
        hubSessionId: "ses_foreign",
        now: afterExpiry,
      }),
    ).toThrow(/expired ticket recovery/i);

    const receipt = expireSessionTicketBundleForHubSession(database.sqlite, {
      hubSessionId: SESSION_ID,
      now: afterExpiry,
    });
    expect(receipt).toMatchObject({
      bundleId: "stb_expired_recovery",
      state: "EXPIRED",
      hubSessionId: SESSION_ID,
      terminalReason: "ticket expired",
    });
    expect(
      registry.authenticateTerminalTicketReplay(bearer(initial.tokens.CONTROL), {
        hubSessionId: SESSION_ID,
      }),
    ).toMatchObject({ ticketState: "EXPIRED", scopes: [] });
  });

  it("rejects Hook auxiliary rotation and dynamic CONTROL mode overreach", () => {
    expect(() =>
      createPendingSessionTicket(database.sqlite, {
        bundleId: "stb_hook_auxiliary",
        purpose: "CONTROL",
        tokenSha256: digest(randomBytes(32).toString("base64url")),
        offeredByAuthCredentialId: "crd_agent_codex",
        projectId: PROJECT_ID,
        adapterClient: "codex",
        agentId: "codex",
        sessionClient: "codex-cli-hooks",
        role: "primary",
        transport: "hook-poll",
        deliveryMode: "hook_poll",
        runId: "run_hook_auxiliary",
        activationMode: "SESSION_AUXILIARY",
        expectedLineageId: LINEAGE_ID,
        expectedHeadSessionId: SESSION_ID,
        idempotencyKey: "hook-auxiliary",
        now: NOW,
      }),
    ).toThrow(/Hook clients rotate.*replacement/i);

    const initial = offerCodexAppServerBundle("stb_dynamic_mode_source");
    activateSessionTicketBundle(database.sqlite, {
      bundleId: "stb_dynamic_mode_source",
      hubSessionId: SESSION_ID,
      lineageId: LINEAGE_ID,
      incarnation: 1,
      proof: { kind: "FIRST_LINEAGE", controlTicketId: initial.controlId },
      now: NOW,
    });
    expect(() =>
      createPendingSessionTicket(database.sqlite, {
        bundleId: "stb_dynamic_mode_service",
        purpose: "CONTROL",
        tokenSha256: digest(randomBytes(32).toString("base64url")),
        offeredByTicketId: initial.controlId,
        projectId: PROJECT_ID,
        adapterClient: "codex",
        agentId: "codex",
        sessionClient: "codex-app-server",
        role: "primary",
        transport: "websocket",
        deliveryMode: "app_server_push",
        runId: "run_ticket",
        activationMode: "FIRST_LINEAGE",
        idempotencyKey: "dynamic-first-lineage",
        now: NOW,
      }),
    ).toThrow(/TICKET_OFFER_NOT_AUTHORIZED/);

    expect(() =>
      database.sqlite
        .prepare(
          `INSERT INTO adapter_session_tickets(
             id, bundle_id, purpose, token_sha256, offered_by_auth_credential_id,
             offered_by_ticket_id, project_id, adapter_client, agent_id, session_client,
             role, transport, delivery_mode, external_session_id, external_thread_id,
             run_id, activation_mode, expected_lineage_id, expected_head_session_id,
             launch_reservation_id, hub_session_id, lineage_id, incarnation,
             idempotency_key, request_sha256, state, offer_expires_at, expires_at,
             created_at, updated_at, activated_at, terminal_at, terminal_reason
           ) VALUES (
             'stk_dynamic_mode_sql', 'stb_dynamic_mode_sql', 'CONTROL', ?, NULL,
             ?, ?, 'codex', 'codex', 'codex-app-server',
             'primary', 'websocket', 'app_server_push', NULL, NULL,
             'run_ticket', 'FIRST_LINEAGE', NULL, NULL,
             NULL, NULL, NULL, NULL,
             'dynamic-mode-sql', ?, 'PENDING', '2026-08-01T12:10:00.000Z', NULL,
             ?, ?, NULL, NULL, NULL
           )`,
        )
        .run(
          digest(randomBytes(32).toString("base64url")),
          initial.controlId,
          PROJECT_ID,
          "c".repeat(64),
          NOW,
          NOW,
        ),
    ).toThrow(/TICKET_OFFER_NOT_AUTHORIZED/);
  });

  it("activates a managed first-lineage bundle whose reservation has no predecessor head", () => {
    database.sqlite
      .prepare(
        `INSERT INTO session_launch_reservations(
           id, project_id, lineage_id, run_id, generation, expected_head_session_id,
           state, consumed_session_id, created_at, updated_at
         ) VALUES (?, ?, ?, 'run_ticket', 1, NULL, 'ISSUED', NULL, ?, ?)`,
      )
      .run("rsr_managed_first", PROJECT_ID, LINEAGE_ID, NOW, NOW);
    database.sqlite
      .prepare(
        `UPDATE session_launch_reservations
         SET state = 'CONSUMED', consumed_session_id = ?, updated_at = ?
         WHERE id = 'rsr_managed_first' AND state = 'ISSUED'`,
      )
      .run(SESSION_ID, NOW);

    const offers = SESSION_TICKET_PURPOSES_BY_CLIENT["codex-app-server"].map((purpose) =>
      createPendingSessionTicket(database.sqlite, {
        bundleId: "stb_managed_first",
        purpose,
        tokenSha256: digest(randomBytes(32).toString("base64url")),
        offeredByAuthCredentialId: purpose === "INJECTOR" ? "crd_inject_codex" : "crd_agent_codex",
        projectId: PROJECT_ID,
        adapterClient: "codex",
        agentId: "codex",
        sessionClient: "codex-app-server",
        role: "primary",
        transport: "websocket",
        deliveryMode: "app_server_push",
        externalSessionId: "019-test-session",
        externalThreadId: "019-test-thread",
        runId: "run_ticket",
        activationMode: "MANAGED_RESERVATION",
        expectedLineageId: LINEAGE_ID,
        expectedHeadSessionId: null,
        launchReservationId: "rsr_managed_first",
        idempotencyKey: `managed-first-${purpose}`,
        now: NOW,
      }),
    );

    const binding = activateSessionTicketBundle(database.sqlite, {
      bundleId: "stb_managed_first",
      hubSessionId: SESSION_ID,
      lineageId: LINEAGE_ID,
      incarnation: 1,
      proof: { kind: "MANAGED_RESERVATION", reservationId: "rsr_managed_first" },
      now: NOW,
    });

    expect(binding).toMatchObject({
      bundleId: "stb_managed_first",
      state: "ACTIVE",
      hubSessionId: SESSION_ID,
      lineageId: LINEAGE_ID,
      incarnation: 1,
    });
    expect(offers).toHaveLength(3);
    expect(
      database.sqlite
        .prepare(
          `SELECT COUNT(*) FROM adapter_session_tickets
           WHERE bundle_id = 'stb_managed_first'
             AND expected_head_session_id IS NULL
             AND state = 'ACTIVE'`,
        )
        .pluck()
        .get(),
    ).toBe(3);
  });

  it("rejects partial activation and late purpose append with zero ticket mutation", () => {
    const token = randomBytes(32).toString("base64url");
    const partial = createPendingSessionTicket(database.sqlite, {
      bundleId: "stb_partial",
      purpose: "CONTROL",
      tokenSha256: digest(token),
      offeredByAuthCredentialId: "crd_agent_codex",
      projectId: PROJECT_ID,
      adapterClient: "codex",
      agentId: "codex",
      sessionClient: "codex-app-server",
      role: "primary",
      transport: "websocket",
      deliveryMode: "app_server_push",
      externalSessionId: "019-test-session",
      externalThreadId: "019-test-thread",
      runId: "run_ticket",
      activationMode: "FIRST_LINEAGE",
      idempotencyKey: "partial-control",
      now: NOW,
    });
    expect(() =>
      activateSessionTicketBundle(database.sqlite, {
        bundleId: "stb_partial",
        hubSessionId: SESSION_ID,
        lineageId: LINEAGE_ID,
        incarnation: 1,
        proof: { kind: "FIRST_LINEAGE", controlTicketId: partial.id },
        now: NOW,
      }),
    ).toThrow(/TICKET_BINDING_MISMATCH/);
    expect(
      database.sqlite
        .prepare("SELECT state FROM adapter_session_tickets WHERE id = ?")
        .pluck()
        .get(partial.id),
    ).toBe("PENDING");
    expect(() =>
      database.sqlite
        .prepare(
          `UPDATE adapter_session_tickets
           SET state = 'ACTIVE', hub_session_id = ?, lineage_id = ?, incarnation = 1,
               expires_at = '2026-08-02T12:00:00.000Z', activated_at = ?, updated_at = ?
           WHERE id = ? AND state = 'PENDING'`,
        )
        .run(SESSION_ID, LINEAGE_ID, NOW, NOW, partial.id),
    ).toThrow(/TICKET_BINDING_MISMATCH/);
    expect(
      database.sqlite
        .prepare("SELECT state FROM adapter_session_tickets WHERE id = ?")
        .pluck()
        .get(partial.id),
    ).toBe("PENDING");

    issueAndActivate();
    const before = database.sqlite
      .prepare("SELECT COUNT(*) FROM adapter_session_tickets WHERE bundle_id = 'stb_control'")
      .pluck()
      .get();
    expect(() =>
      createPendingSessionTicket(database.sqlite, {
        bundleId: "stb_control",
        purpose: "CAPTURE",
        tokenSha256: digest(randomBytes(32).toString("base64url")),
        offeredByAuthCredentialId: "crd_capture_codex",
        projectId: PROJECT_ID,
        adapterClient: "codex",
        agentId: "codex",
        sessionClient: "codex-app-server",
        role: "primary",
        transport: "websocket",
        deliveryMode: "app_server_push",
        externalSessionId: "019-test-session",
        externalThreadId: "019-test-thread",
        runId: "run_ticket",
        activationMode: "FIRST_LINEAGE",
        idempotencyKey: "late-capture",
        now: NOW,
      }),
    ).toThrow(/TICKET_NOT_PENDING/);
    expect(
      database.sqlite
        .prepare("SELECT COUNT(*) FROM adapter_session_tickets WHERE bundle_id = 'stb_control'")
        .pluck()
        .get(),
    ).toBe(before);
  });

  it("rejects direct single-row activation inside a complete pending bundle", () => {
    const offered = offerCodexAppServerBundle("stb_single_row_activation");
    expect(() =>
      database.sqlite
        .prepare(
          `UPDATE adapter_session_tickets
           SET state = 'ACTIVE', hub_session_id = ?, lineage_id = ?, incarnation = 1,
               expires_at = '2026-08-02T12:00:00.000Z', activated_at = ?, updated_at = ?
           WHERE id = ? AND state = 'PENDING'`,
        )
        .run(SESSION_ID, LINEAGE_ID, NOW, NOW, offered.controlId),
    ).toThrow(/TICKET_BUNDLE_TRANSITION_REQUIRED/);
    expect(
      database.sqlite
        .prepare(
          `SELECT group_concat(DISTINCT state) FROM adapter_session_tickets
           WHERE bundle_id = 'stb_single_row_activation'`,
        )
        .pluck()
        .get(),
    ).toBe("PENDING");
  });

  it("rejects direct single-row terminalization inside a complete active bundle", () => {
    const offered = offerCodexAppServerBundle("stb_single_row_terminal");
    activateSessionTicketBundle(database.sqlite, {
      bundleId: "stb_single_row_terminal",
      hubSessionId: SESSION_ID,
      lineageId: LINEAGE_ID,
      incarnation: 1,
      proof: { kind: "FIRST_LINEAGE", controlTicketId: offered.controlId },
      now: NOW,
    });
    expect(() =>
      database.sqlite
        .prepare(
          `UPDATE adapter_session_tickets
           SET state = 'REVOKED', terminal_at = ?, terminal_reason = 'forged', updated_at = ?
           WHERE id = ? AND state = 'ACTIVE'`,
        )
        .run(NOW, NOW, offered.controlId),
    ).toThrow(/TICKET_BUNDLE_TRANSITION_REQUIRED/);
    expect(
      database.sqlite
        .prepare(
          `SELECT group_concat(DISTINCT state) FROM adapter_session_tickets
           WHERE bundle_id = 'stb_single_row_terminal'`,
        )
        .pluck()
        .get(),
    ).toBe("ACTIVE");
    expect(
      registry.authenticate(bearer(offered.tokens.MODEL_MCP), SESSION_TICKET_SCOPES.MODEL_MCP),
    ).toMatchObject({ ticketState: "ACTIVE" });
  });

  it("keeps mixed bundles unauthenticated even if the DB transition guard is absent", () => {
    const partial = offerCodexAppServerBundle("stb_auth_defense_partial");
    database.sqlite.exec("DROP TRIGGER adapter_session_tickets_guarded_state_transition");
    database.sqlite
      .prepare(
        `UPDATE adapter_session_tickets
         SET state = 'ACTIVE', hub_session_id = ?, lineage_id = ?, incarnation = 1,
             expires_at = '2026-08-02T12:00:00.000Z', activated_at = ?, updated_at = ?
         WHERE id = ? AND state = 'PENDING'`,
      )
      .run(SESSION_ID, LINEAGE_ID, NOW, NOW, partial.controlId);
    expect(() =>
      registry.authenticate(bearer(partial.tokens.CONTROL), SESSION_TICKET_SCOPES.CONTROL),
    ).toThrow(/invalid.*local bearer/i);

    revokeSessionTicketBundle(database.sqlite, {
      bundleId: "stb_auth_defense_partial",
      reason: "clear corrupt fixture",
      now: NOW,
    });
    const terminal = offerCodexAppServerBundle("stb_auth_defense_terminal");
    activateSessionTicketBundle(database.sqlite, {
      bundleId: "stb_auth_defense_terminal",
      hubSessionId: SESSION_ID,
      lineageId: LINEAGE_ID,
      incarnation: 1,
      proof: { kind: "FIRST_LINEAGE", controlTicketId: terminal.controlId },
      now: NOW,
    });
    database.sqlite
      .prepare(
        `UPDATE adapter_session_tickets
         SET state = 'REVOKED', terminal_at = ?, terminal_reason = 'forged', updated_at = ?
         WHERE id = ? AND state = 'ACTIVE'`,
      )
      .run(NOW, NOW, terminal.controlId);
    expect(() =>
      registry.authenticate(bearer(terminal.tokens.MODEL_MCP), SESSION_TICKET_SCOPES.MODEL_MCP),
    ).toThrow(/invalid.*local bearer/i);
    expect(() =>
      registry.authenticateTerminalTicketReplay(bearer(terminal.tokens.CONTROL), {
        hubSessionId: SESSION_ID,
      }),
    ).toThrow(/terminal ticket replay/i);
  });

  it("blocks a schema-valid direct activation with a mismatched external identity", () => {
    offerCodexAppServerBundle("stb_wrong_external", "019-attacker-session");

    expect(() =>
      database.sqlite
        .prepare(
          `UPDATE adapter_session_tickets
           SET state = 'ACTIVE', hub_session_id = ?, lineage_id = ?, incarnation = 1,
               expires_at = '2026-08-02T12:00:00.000Z', activated_at = ?, updated_at = ?
           WHERE bundle_id = 'stb_wrong_external' AND state = 'PENDING'`,
        )
        .run(SESSION_ID, LINEAGE_ID, NOW, NOW),
    ).toThrow(/TICKET_BINDING_MISMATCH/);
    expect(
      database.sqlite
        .prepare(
          `SELECT COUNT(*) FROM adapter_session_tickets
           WHERE bundle_id = 'stb_wrong_external' AND state <> 'PENDING'`,
        )
        .pluck()
        .get(),
    ).toBe(0);
  });

  it("treats absent offered external identities as exact nulls rather than wildcards", () => {
    const offers = SESSION_TICKET_PURPOSES_BY_CLIENT["codex-app-server"].map((purpose) =>
      createPendingSessionTicket(database.sqlite, {
        bundleId: "stb_null_external_identity",
        purpose,
        tokenSha256: digest(randomBytes(32).toString("base64url")),
        offeredByAuthCredentialId: purpose === "INJECTOR" ? "crd_inject_codex" : "crd_agent_codex",
        projectId: PROJECT_ID,
        adapterClient: "codex",
        agentId: "codex",
        sessionClient: "codex-app-server",
        role: "primary",
        transport: "websocket",
        deliveryMode: "app_server_push",
        runId: "run_ticket",
        activationMode: "FIRST_LINEAGE",
        idempotencyKey: `null-external-${purpose}`,
        now: NOW,
      }),
    );

    expect(() =>
      activateSessionTicketBundle(database.sqlite, {
        bundleId: "stb_null_external_identity",
        hubSessionId: SESSION_ID,
        lineageId: LINEAGE_ID,
        incarnation: 1,
        proof: {
          kind: "FIRST_LINEAGE",
          controlTicketId: offers.find((offer) => offer.purpose === "CONTROL")!.id,
        },
        now: NOW,
      }),
    ).toThrow(/TICKET_BINDING_MISMATCH/);
    expect(
      database.sqlite
        .prepare(
          `SELECT COUNT(*) FROM adapter_session_tickets
           WHERE bundle_id = 'stb_null_external_identity' AND state <> 'PENDING'`,
        )
        .pluck()
        .get(),
    ).toBe(0);
  });

  it("blocks direct activation that lacks the exact expected lineage/head proof", () => {
    for (const purpose of SESSION_TICKET_PURPOSES_BY_CLIENT["codex-app-server"]) {
      createPendingSessionTicket(database.sqlite, {
        bundleId: "stb_direct_head_overreach",
        purpose,
        tokenSha256: digest(randomBytes(32).toString("base64url")),
        offeredByAuthCredentialId: purpose === "INJECTOR" ? "crd_inject_codex" : "crd_agent_codex",
        projectId: PROJECT_ID,
        adapterClient: "codex",
        agentId: "codex",
        sessionClient: "codex-app-server",
        role: "primary",
        transport: "websocket",
        deliveryMode: "app_server_push",
        externalSessionId: "019-test-session",
        externalThreadId: "019-test-thread",
        runId: "run_ticket",
        activationMode: "CURRENT_HEAD_REPLACEMENT",
        expectedLineageId: LINEAGE_ID,
        expectedHeadSessionId: SESSION_ID,
        idempotencyKey: `direct-head-${purpose}`,
        now: NOW,
      });
    }

    expect(() =>
      database.sqlite
        .prepare(
          `UPDATE adapter_session_tickets
           SET state = 'ACTIVE', hub_session_id = ?, lineage_id = ?, incarnation = 1,
               expires_at = '2026-08-02T12:00:00.000Z', activated_at = ?, updated_at = ?
           WHERE bundle_id = 'stb_direct_head_overreach' AND state = 'PENDING'`,
        )
        .run(SESSION_ID, LINEAGE_ID, NOW, NOW),
    ).toThrow(/TICKET_BINDING_MISMATCH/);
    expect(
      database.sqlite
        .prepare(
          `SELECT COUNT(*) FROM adapter_session_tickets
           WHERE bundle_id = 'stb_direct_head_overreach' AND state <> 'PENDING'`,
        )
        .pluck()
        .get(),
    ).toBe(0);
  });

  it("returns a secret-free terminal receipt and permits only narrow close replay", () => {
    const token = issueAndActivate();
    const principal = registry.authenticate(bearer(token), SESSION_TICKET_SCOPES.CONTROL);
    const receipt = closeSessionTicketsForHubSession(database.sqlite, {
      hubSessionId: SESSION_ID,
      reason: "SESSION_CLOSED:test",
      now: NOW,
    });

    expect(receipt).toMatchObject({
      bundleId: "stb_control",
      state: "REVOKED",
      hubSessionId: SESSION_ID,
      terminalReason: "SESSION_CLOSED:test",
    });
    expect(JSON.stringify(receipt)).not.toMatch(/sha256|token/i);
    expect(() => registry.revalidate(principal)).toThrow(/no longer active/i);
    expect(
      registry.authenticateTerminalTicketReplay(bearer(token), { hubSessionId: SESSION_ID }),
    ).toMatchObject({ ticketState: "REVOKED", ticketPurpose: "CONTROL", scopes: [] });
    expect(() =>
      registry.authenticateTerminalTicketReplay(bearer(token), { hubSessionId: "ses_foreign" }),
    ).toThrow(/terminal ticket replay/i);
  });

  it("does not grant a purpose a sibling purpose's scopes", () => {
    const token = issueAndActivate("MODEL_MCP");
    expect(() => registry.authenticate(bearer(token), SESSION_TICKET_SCOPES.CONTROL)).toThrow(
      /required scope/i,
    );
    expect(registry.authenticate(bearer(token), SESSION_TICKET_SCOPES.MODEL_MCP)).toMatchObject({
      ticketPurpose: "MODEL_MCP",
      hubSessionId: SESSION_ID,
    });
  });

  it("fails revalidation after its exact session closes or the ticket is revoked", () => {
    const token = issueAndActivate();
    const principal = registry.authenticate(bearer(token), SESSION_TICKET_SCOPES.CONTROL);

    database.sqlite
      .prepare("UPDATE agent_sessions SET connection_state = 'CLOSED', closed_at = ? WHERE id = ?")
      .run(NOW, SESSION_ID);
    expect(() => registry.revalidate(principal)).toThrow(/no longer active/i);

    database.sqlite
      .prepare(
        "UPDATE agent_sessions SET connection_state = 'ONLINE', closed_at = NULL WHERE id = ?",
      )
      .run(SESSION_ID);
    revokeSessionTicketBundle(database.sqlite, {
      bundleId: "stb_control",
      reason: "test revocation",
      now: NOW,
    });
    expect(() => registry.authenticate(bearer(token), SESSION_TICKET_SCOPES.CONTROL)).toThrow(
      /invalid.*local bearer/i,
    );
  });

  it("rejects a dynamic digest colliding with any static credential, even if static is revoked", () => {
    const staticCredential = registry.credentials.agentByClient.codex;
    database.sqlite
      .prepare("UPDATE auth_credentials SET revoked_at = ? WHERE id = ?")
      .run(NOW, staticCredential.principal.credentialId);

    expect(() =>
      createPendingSessionTicket(database.sqlite, {
        bundleId: "stb_collision",
        purpose: "CONTROL",
        tokenSha256: digest(staticCredential.token),
        offeredByAuthCredentialId: "crd_agent_claude",
        projectId: PROJECT_ID,
        adapterClient: "claude",
        agentId: "claude",
        sessionClient: "claude-channel",
        role: "primary",
        transport: "websocket",
        deliveryMode: "native_channel",
        runId: "run_collision",
        activationMode: "FIRST_LINEAGE",
        idempotencyKey: "collision",
        now: NOW,
      }),
    ).toThrow(/TICKET_DIGEST_COLLISION/);
  });

  it("keeps PENDING MODEL_MCP out of tool scopes while permitting only its handshake seam", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const token = randomBytes(32).toString("base64url");
    createPendingSessionTicket(database.sqlite, {
      bundleId: "stb_pending_mcp",
      purpose: "MODEL_MCP",
      tokenSha256: digest(token),
      offeredByAuthCredentialId: "crd_agent_codex",
      projectId: PROJECT_ID,
      adapterClient: "codex",
      agentId: "codex",
      sessionClient: "codex-app-server",
      role: "primary",
      transport: "websocket",
      deliveryMode: "app_server_push",
      runId: "run_pending_mcp",
      activationMode: "FIRST_LINEAGE",
      idempotencyKey: "pending-mcp",
      now: NOW,
    });

    expect(() => registry.authenticate(bearer(token), SESSION_TICKET_SCOPES.MODEL_MCP)).toThrow(
      /invalid.*local bearer/i,
    );
    expect(registry.authenticateModelMcpHandshake(bearer(token))).toMatchObject({
      ticketPurpose: "MODEL_MCP",
      ticketState: "PENDING",
      hubSessionId: null,
      scopes: [],
    });
  });

  it("fails closed if direct SQL attempts to forge an initially ACTIVE ticket", () => {
    expect(() =>
      database.sqlite
        .prepare(
          `INSERT INTO adapter_session_tickets(
             id, bundle_id, purpose, token_sha256, offered_by_auth_credential_id,
             offered_by_ticket_id, project_id, adapter_client, agent_id, session_client,
             role, transport, delivery_mode, external_session_id, external_thread_id,
             run_id, activation_mode, expected_lineage_id, expected_head_session_id,
             launch_reservation_id, hub_session_id, lineage_id, incarnation,
             idempotency_key, request_sha256, state, offer_expires_at, expires_at,
             created_at, updated_at, activated_at, terminal_at, terminal_reason
           ) VALUES (
             'stk_orphan', 'stb_orphan', 'CONTROL', ?, 'crd_agent_codex',
             NULL, ?, 'codex', 'codex', 'codex-app-server',
             'primary', 'websocket', 'app_server_push', '019-test-session', '019-test-thread',
             'run_ticket', 'FIRST_LINEAGE', NULL, NULL,
             NULL, ?, ?, 1,
             'orphan', ?, 'ACTIVE', '2026-08-01T12:10:00.000Z', '2026-08-02T12:00:00.000Z',
             ?, ?, ?, NULL, NULL
           )`,
        )
        .run(
          digest(randomBytes(32).toString("base64url")),
          PROJECT_ID,
          SESSION_ID,
          LINEAGE_ID,
          "a".repeat(64),
          NOW,
          NOW,
          NOW,
        ),
    ).toThrow(/TICKET_NOT_PENDING/);

    expect(
      database.sqlite
        .prepare("SELECT COUNT(*) FROM adapter_session_tickets WHERE id = 'stk_orphan'")
        .pluck()
        .get(),
    ).toBe(0);

    expect(() =>
      database.sqlite
        .prepare(
          `INSERT INTO adapter_session_tickets(
             id, bundle_id, purpose, token_sha256, offered_by_auth_credential_id,
             offered_by_ticket_id, project_id, adapter_client, agent_id, session_client,
             role, transport, delivery_mode, external_session_id, external_thread_id,
             run_id, activation_mode, expected_lineage_id, expected_head_session_id,
             launch_reservation_id, hub_session_id, lineage_id, incarnation,
             idempotency_key, request_sha256, state, offer_expires_at, expires_at,
             created_at, updated_at, activated_at, terminal_at, terminal_reason
           ) VALUES (
             'stk_offset', 'stb_offset', 'CONTROL', ?, 'crd_agent_codex',
             NULL, ?, 'codex', 'codex', 'codex-app-server',
             'primary', 'websocket', 'app_server_push', NULL, NULL,
             'run_offset', 'FIRST_LINEAGE', NULL, NULL,
             NULL, NULL, NULL, NULL,
             'offset', ?, 'PENDING', '2026-08-01T14:10:00.000+02:00', NULL,
             ?, ?, NULL, NULL, NULL
           )`,
        )
        .run(digest(randomBytes(32).toString("base64url")), PROJECT_ID, "b".repeat(64), NOW, NOW),
    ).toThrow(/CHECK constraint failed/i);
  });
});
