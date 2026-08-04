import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyRequest } from "fastify";
import {
  SESSION_TICKET_PURPOSES_BY_CLIENT,
  type AdapterSessionClient,
  type SessionTicketPurpose,
} from "@crossagent/protocol";
import type { HubServer } from "../src/server.js";
import { createHubServer } from "./test-server.js";
import { CredentialRegistry } from "../src/security/local-auth.js";

describe("multi-session isolation", () => {
  let server: HubServer;
  let projectDir: string;
  let projectId: string;
  let objectiveId: string;
  let baseUrl: string;
  const sessionTickets = new Map<
    string,
    {
      bundleId: string;
      client: AdapterSessionClient;
      tokens: Partial<Record<SessionTicketPurpose, string>>;
    }
  >();

  beforeEach(async () => {
    sessionTickets.clear();
    const root = mkdtempSync(resolve(tmpdir(), "crossagent-multi-session-"));
    projectDir = resolve(root, "project");
    mkdirSync(projectDir);
    server = await createHubServer({
      databasePath: resolve(root, "hub.db"),
      dataDir: resolve(root, "data"),
      dashboardDir: resolve(root, "missing-dashboard"),
      host: "127.0.0.1",
      port: 0,
      logLevel: "silent",
    });
    await server.app.listen({ host: "127.0.0.1", port: 0 });
    const address = server.app.server.address();
    if (!address || typeof address === "string") throw new Error("Missing test server port");
    baseUrl = `http://127.0.0.1:${address.port}`;

    const joined = await request<any>(
      "POST",
      "/api/projects/join",
      {
        cwd: projectDir,
        allowCreate: true,
        name: "multi-session fixture",
      },
      server.credentials.dashboard.token,
    );
    projectId = joined.body.project.id;
    const objective = await request<any>("POST", `/api/projects/${projectId}/objectives`, {
      title: "Keep sessions isolated",
      description: "One logical thread must not own another thread's state.",
      definitionOfDone: ["No cross-session close", "One delivery owner"],
      status: "ACTIVE",
      idempotencyKey: "multi-session-objective",
    });
    objectiveId = objective.body.id;
  });

  afterEach(async () => {
    await server.close();
  });

  async function request<T>(
    method: string,
    path: string,
    body?: unknown,
    token?: string,
  ): Promise<{ status: number; body: T }> {
    let effectiveToken = token;
    if (!effectiveToken) {
      const candidate = body as
        | {
            agentId?: string;
            client?: string;
            sessionId?: string;
            fromSessionId?: string;
            completedBySessionId?: string;
            requestedBySessionId?: string;
          }
        | undefined;
      const sessionId =
        /^\/api\/sessions\/([^/]+)\//.exec(path)?.[1] ??
        candidate?.sessionId ??
        candidate?.fromSessionId ??
        candidate?.completedBySessionId ??
        candidate?.requestedBySessionId;
      const ticket = sessionId ? sessionTickets.get(sessionId) : undefined;
      if (ticket) {
        const modelReceipt = /\/(?:ack|processed|responded)(?:\?|$)/u.test(path);
        effectiveToken =
          modelReceipt && ticket.client === "codex-app-server"
            ? ticket.tokens.MODEL_MCP
            : ticket.tokens.CONTROL;
      } else if (sessionId) {
        try {
          const session = server.store.getSession(sessionId);
          effectiveToken = session.client.startsWith("codex-")
            ? server.credentials.agentByClient.codex.token
            : session.client.startsWith("claude-")
              ? server.credentials.agentByClient.claude.token
              : server.credentials.dashboard.token;
        } catch {
          effectiveToken = server.credentials.dashboard.token;
        }
      } else {
        effectiveToken = server.credentials.dashboard.token;
      }
    }
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${effectiveToken}`,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {
      status: response.status,
      body: (await response.json()) as T,
    };
  }

  async function registerForProject(
    targetProjectId: string,
    agentId: string,
    externalThreadId: string,
    idempotencyKey: string,
    client = agentId === "codex" ? "codex-app-server" : "claude-channel",
    overrides: Record<string, unknown> = {},
    token = agentId === "codex"
      ? server.credentials.agentByClient.codex.token
      : server.credentials.agentByClient.claude.token,
  ) {
    const targetProjectDir = (
      server.store.sqlite
        .prepare("SELECT canonical_path FROM project_paths WHERE project_id = ? LIMIT 1")
        .get(targetProjectId) as { canonical_path: string }
    ).canonical_path;
    const adapterClient = agentId as "codex" | "claude";
    const adapterSessionClient = client as AdapterSessionClient;
    const bundleId = `stb_${idempotencyKey}`;
    const runId = `run_${idempotencyKey}`;
    const transport = client.endsWith("hooks") ? "hook-poll" : "websocket";
    const deliveryMode =
      client === "codex-app-server"
        ? "app_server_push"
        : client === "claude-channel"
          ? "native_channel"
          : "hook_poll";
    const launch =
      client === "codex-app-server"
        ? (
            await request<any>(
              "POST",
              `/api/projects/${targetProjectId}/session-launch-reservations`,
              {
                agentId,
                client,
                deliveryMode,
                externalThreadId,
                externalSessionId: externalThreadId,
                runId,
                idempotencyKey: `reserve_${idempotencyKey}`,
              },
              token,
            )
          ).body
        : null;
    const tokens: Partial<Record<SessionTicketPurpose, string>> = {};
    for (const purpose of SESSION_TICKET_PURPOSES_BY_CLIENT[adapterSessionClient]) {
      const raw = randomBytes(32).toString("base64url");
      tokens[purpose] = raw;
      const offered = await request<any>(
        "POST",
        `/api/projects/${targetProjectId}/session-ticket-offers`,
        {
          bundle_id: bundleId,
          purpose,
          token_sha256: createHash("sha256").update(raw, "utf8").digest("hex"),
          adapter_client: adapterClient,
          agent_id: agentId,
          session_client: client,
          role: "primary",
          transport,
          delivery_mode: deliveryMode,
          external_session_id: externalThreadId,
          external_thread_id: externalThreadId,
          run_id: runId,
          activation_mode: launch ? "MANAGED_RESERVATION" : "FIRST_LINEAGE",
          ...(launch
            ? {
                expected_lineage_id: launch.lineageId,
                expected_head_session_id: launch.expectedHeadSessionId,
                launch_reservation_id: launch.id,
              }
            : {}),
          idempotency_key: `offer_${idempotencyKey}_${purpose}`,
        },
        purpose === "CAPTURE"
          ? server.credentials.capture[adapterClient].token
          : purpose === "INJECTOR"
            ? server.credentials.injector[adapterClient].token
            : token,
      );
      expect(offered, JSON.stringify(offered.body)).toMatchObject({
        status: 200,
        body: { state: "PENDING", purpose },
      });
    }
    const response = await request<any>(
      "POST",
      `/api/projects/${targetProjectId}/sessions`,
      {
        agentId,
        role: "primary",
        client,
        transport,
        deliveryMode,
        externalSessionId: externalThreadId,
        externalThreadId,
        host: "test",
        cwd: targetProjectDir,
        capabilities: [],
        ticket_bundle_id: bundleId,
        idempotencyKey,
        ...(launch
          ? {
              expectedHeadSessionId: launch.expectedHeadSessionId,
              launcherRunId: launch.runId,
              launchGeneration: launch.generation,
            }
          : {}),
        ...overrides,
      },
      tokens.CONTROL,
    );
    if (response.status === 200 && response.body?.session) {
      sessionTickets.set(response.body.session.id, {
        bundleId,
        client: adapterSessionClient,
        tokens,
      });
      return {
        ...response,
        body: response.body.session,
        ticketBinding: response.body.ticketBinding,
      };
    }
    return response;
  }

  async function register(
    agentId: string,
    externalThreadId: string,
    idempotencyKey: string,
    client = agentId === "codex" ? "codex-app-server" : "claude-channel",
    overrides: Record<string, unknown> = {},
    token = agentId === "codex"
      ? server.credentials.agentByClient.codex.token
      : server.credentials.agentByClient.claude.token,
  ) {
    return registerForProject(
      projectId,
      agentId,
      externalThreadId,
      idempotencyKey,
      client,
      overrides,
      token,
    );
  }

  function sessionToken(sessionId: string, purpose: SessionTicketPurpose = "CONTROL"): string {
    const token = sessionTickets.get(sessionId)?.tokens[purpose];
    if (!token) throw new Error(`Missing ${purpose} ticket for ${sessionId}`);
    return token;
  }

  async function prepareClaudeCurrentHeadReplacement(predecessor: any, suffix: string) {
    const bundleId = `stb_${suffix}`;
    const runId = `run_${suffix}`;
    const control = randomBytes(32).toString("base64url");
    const offered = await request<any>(
      "POST",
      `/api/projects/${predecessor.projectId}/session-ticket-offers`,
      {
        bundle_id: bundleId,
        purpose: "CONTROL",
        token_sha256: createHash("sha256").update(control, "utf8").digest("hex"),
        adapter_client: "claude",
        agent_id: "claude",
        session_client: "claude-channel",
        role: predecessor.role,
        transport: predecessor.transport,
        delivery_mode: predecessor.deliveryMode,
        external_session_id: predecessor.externalSessionId,
        external_thread_id: predecessor.externalThreadId,
        run_id: runId,
        activation_mode: "CURRENT_HEAD_REPLACEMENT",
        expected_lineage_id: predecessor.lineageId,
        expected_head_session_id: predecessor.id,
        idempotency_key: `offer_${suffix}_CONTROL`,
      },
      sessionToken(predecessor.id),
    );
    expect(offered, JSON.stringify(offered.body)).toMatchObject({
      status: 200,
      body: { state: "PENDING", purpose: "CONTROL" },
    });
    return {
      bundleId,
      control,
      body: {
        agentId: "claude",
        role: predecessor.role,
        client: "claude-channel",
        transport: predecessor.transport,
        deliveryMode: predecessor.deliveryMode,
        externalSessionId: predecessor.externalSessionId,
        externalThreadId: predecessor.externalThreadId,
        expectedHeadSessionId: predecessor.id,
        host: "test",
        cwd: projectDir,
        capabilities: [],
        ticket_bundle_id: bundleId,
        idempotencyKey: `register_${suffix}`,
      },
    };
  }

  async function replaceClaudeCurrentHead(predecessor: any, suffix: string) {
    const prepared = await prepareClaudeCurrentHeadReplacement(predecessor, suffix);
    const registered = await request<any>(
      "POST",
      `/api/projects/${predecessor.projectId}/sessions`,
      prepared.body,
      prepared.control,
    );
    expect(registered, JSON.stringify(registered.body)).toMatchObject({
      status: 200,
      body: {
        session: {
          agentId: "claude",
          lineageId: predecessor.lineageId,
          predecessorSessionId: predecessor.id,
        },
        ticketBinding: { bundleId: prepared.bundleId, state: "ACTIVE" },
      },
    });
    sessionTickets.set(registered.body.session.id, {
      bundleId: prepared.bundleId,
      client: "claude-channel",
      tokens: { CONTROL: prepared.control },
    });
    return registered.body.session;
  }

  async function confirmMessageSurface(messageId: string, session: any, suffix: string) {
    const surfaced = await request<any>(
      "POST",
      `/api/messages/${messageId}/surface-attempts`,
      {
        sessionId: session.id,
        idempotencyKey: `${suffix}:surface`,
      },
      sessionToken(session.id),
    );
    expect(surfaced).toMatchObject({
      status: 200,
      body: {
        permit: {
          messageId,
          sessionId: session.id,
          sessionIncarnation: session.incarnation,
          state: "ACTIVE",
        },
      },
    });
    const delivered = await request<any>(
      "POST",
      `/api/messages/${messageId}/delivered`,
      {
        sessionId: session.id,
        surfaceAttemptId: surfaced.body.permit.id,
        recipientFence: surfaced.body.permit.recipientFence,
        idempotencyKey: `${suffix}:delivered`,
      },
      sessionToken(session.id),
    );
    expect(delivered).toMatchObject({
      status: 200,
      body: {
        recipients: [
          expect.objectContaining({
            recipientSessionId: session.id,
            state: "DELIVERED",
          }),
        ],
      },
    });
    return surfaced.body.permit;
  }

  async function relayAuthorityDirectiveToClaude(
    relaySession: any,
    rawPrompt: string,
    suffix: string,
  ) {
    const userTurnId = `utr_confirmed_handoff_${suffix}`;
    const captured = await request<any>(
      "POST",
      "/api/user-turns/capture",
      {
        user_turn_id: userTurnId,
        project_id: projectId,
        client_type: "codex",
        session_id: relaySession.externalSessionId,
        turn_id: `turn-${suffix}`,
        cwd: projectDir,
        raw_prompt: rawPrompt,
        captured_at: "2026-08-01T00:00:00.000Z",
        idempotency_key: `capture:${suffix}`,
      },
      sessionToken(relaySession.id, "CAPTURE"),
    );
    expect(captured).toMatchObject({ status: 200, body: { user_turn_id: userTurnId } });
    const relayed = await request<any>(
      "POST",
      `/api/projects/${projectId}/directives/relay`,
      {
        source_user_turn_id: userTurnId,
        target_agent_ids: ["claude"],
        verbatim_text: rawPrompt,
        quote_start: 0,
        quote_end: rawPrompt.length,
        agent_interpretation: "Confirmed handoff integrity fixture",
        objective_id: objectiveId,
        task_ids: [],
        file_globs: ["apps/hub/src/**"],
        idempotency_key: `relay:${suffix}`,
      },
      sessionToken(relaySession.id),
    );
    expect(relayed).toMatchObject({
      status: 200,
      body: {
        authority: "USER_ATTESTED",
        targetAgentIds: ["claude"],
      },
    });
    return relayed.body;
  }

  function mutateImmutableTable(
    table: "events" | "authority_events" | "message_surface_handoffs",
    sql: string,
    values: unknown[],
  ): number {
    const triggers = server.store.sqlite
      .prepare(
        `SELECT name, sql FROM sqlite_master
          WHERE type = 'trigger' AND tbl_name = ? AND sql IS NOT NULL`,
      )
      .all(table) as Array<{ name: string; sql: string }>;
    for (const trigger of triggers) {
      server.store.sqlite.exec(`DROP TRIGGER "${trigger.name.replaceAll('"', '""')}"`);
    }
    let changes = 0;
    try {
      changes = server.store.sqlite.prepare(sql).run(...values).changes;
    } finally {
      for (const trigger of triggers) server.store.sqlite.exec(trigger.sql);
    }
    return changes;
  }

  function expectDirectAuthorityReceiptRejected(input: {
    directive: { id: string; carrierMessageId: string; correlationId: string };
    permit: { id: string; recipientFence: number };
    actorSessionId: string;
    eventType: "ACKNOWLEDGED" | "PROCESSED";
    suffix: string;
  }) {
    const snapshot = () => ({
      project: server.store.sqlite
        .prepare("SELECT current_sequence FROM projects WHERE id = ?")
        .get(projectId),
      events: server.store.sqlite
        .prepare("SELECT COUNT(*) AS count FROM events WHERE project_id = ?")
        .get(projectId),
      authorityEvents: server.store.sqlite
        .prepare("SELECT COUNT(*) AS count FROM authority_events WHERE directive_id = ?")
        .get(input.directive.id),
    });
    const before = snapshot();
    expect(() =>
      server.store.sqlite.transaction(() => {
        const sequence = (
          server.store.sqlite
            .prepare(
              "UPDATE projects SET current_sequence = current_sequence + 1 WHERE id = ? RETURNING current_sequence",
            )
            .get(projectId) as { current_sequence: number }
        ).current_sequence;
        const payload = JSON.stringify({
          carrierMessageId: input.directive.carrierMessageId,
          targetAgentId: "claude",
          sessionId: input.actorSessionId,
          surfaceAttemptId: input.permit.id,
          recipientFence: input.permit.recipientFence,
        });
        const createdAt = "2026-08-01T08:00:00.000Z";
        const eventId = `evt_direct_handoff_${input.suffix}`;
        server.store.sqlite
          .prepare(
            `INSERT INTO events(
               id, project_id, sequence, type, actor_type, actor_id, aggregate_type,
               aggregate_id, causation_id, correlation_id, payload_json, created_at
             ) VALUES (?, ?, ?, ?, 'agent', 'claude', 'authority_directive', ?, ?, ?, ?, ?)`,
          )
          .run(
            eventId,
            projectId,
            sequence,
            `directive.${input.eventType.toLowerCase()}`,
            input.directive.id,
            input.directive.carrierMessageId,
            input.directive.correlationId,
            payload,
            createdAt,
          );
        server.store.sqlite
          .prepare(
            `INSERT INTO authority_events(
               id, project_id, directive_id, event_type, actor_principal_id, actor_session_id,
               target_agent_id, server_sequence, event_id, from_lifecycle, to_lifecycle,
               causation_id, correlation_id, payload_json, created_at
             ) VALUES (?, ?, ?, ?, NULL, ?, 'claude', ?, ?, 'ACTIVE', 'ACTIVE', ?, ?, ?, ?)`,
          )
          .run(
            `aev_direct_handoff_${input.suffix}`,
            projectId,
            input.directive.id,
            input.eventType,
            input.actorSessionId,
            sequence,
            eventId,
            input.directive.carrierMessageId,
            input.directive.correlationId,
            payload,
            createdAt,
          );
      })(),
    ).toThrow(/authority event provenance is invalid/);
    expect(snapshot()).toEqual(before);
  }

  async function offerSessionTicketBundle(input: {
    projectId: string;
    agentId: "codex" | "claude";
    client: AdapterSessionClient;
    role?: "primary" | "reviewer" | "observer";
    externalSessionId?: string | null;
    externalThreadId?: string | null;
    runId: string;
    suffix: string;
    launchReservation?: {
      id: string;
      lineageId: string;
      expectedHeadSessionId: string | null;
    };
  }): Promise<{
    bundleId: string;
    tokens: Partial<Record<SessionTicketPurpose, string>>;
  }> {
    const bundleId = `stb_${input.suffix}`;
    const tokens: Partial<Record<SessionTicketPurpose, string>> = {};
    const transport = input.client.endsWith("hooks") ? "hook-poll" : "websocket";
    const deliveryMode =
      input.client === "codex-app-server"
        ? "app_server_push"
        : input.client === "claude-channel"
          ? "native_channel"
          : "hook_poll";
    for (const purpose of SESSION_TICKET_PURPOSES_BY_CLIENT[input.client]) {
      const raw = randomBytes(32).toString("base64url");
      tokens[purpose] = raw;
      const offered = await request<any>(
        "POST",
        `/api/projects/${input.projectId}/session-ticket-offers`,
        {
          bundle_id: bundleId,
          purpose,
          token_sha256: createHash("sha256").update(raw, "utf8").digest("hex"),
          adapter_client: input.agentId,
          agent_id: input.agentId,
          session_client: input.client,
          role: input.role ?? "primary",
          transport,
          delivery_mode: deliveryMode,
          external_session_id: input.externalSessionId ?? null,
          external_thread_id: input.externalThreadId ?? null,
          run_id: input.runId,
          activation_mode: input.launchReservation ? "MANAGED_RESERVATION" : "FIRST_LINEAGE",
          ...(input.launchReservation
            ? {
                expected_lineage_id: input.launchReservation.lineageId,
                expected_head_session_id: input.launchReservation.expectedHeadSessionId,
                launch_reservation_id: input.launchReservation.id,
              }
            : {}),
          idempotency_key: `offer_${input.suffix}_${purpose}`,
        },
        purpose === "CAPTURE"
          ? server.credentials.capture[input.agentId].token
          : purpose === "INJECTOR"
            ? server.credentials.injector[input.agentId].token
            : server.credentials.agentByClient[input.agentId].token,
      );
      expect(offered, JSON.stringify(offered.body)).toMatchObject({
        status: 200,
        body: { state: "PENDING", purpose },
      });
    }
    return { bundleId, tokens };
  }

  async function prepareManagedCodexRegistration(input: {
    projectId: string;
    externalThreadId: string;
    reservation: {
      id: string;
      lineageId: string;
      runId: string;
      generation: number;
      expectedHeadSessionId: string | null;
    };
    suffix: string;
    idempotencyKey: string;
    expectedHeadSessionId?: string | null;
  }) {
    const offered = await offerSessionTicketBundle({
      projectId: input.projectId,
      agentId: "codex",
      client: "codex-app-server",
      externalSessionId: input.externalThreadId,
      externalThreadId: input.externalThreadId,
      runId: input.reservation.runId,
      suffix: input.suffix,
      launchReservation: input.reservation,
    });
    const cwd = (
      server.store.sqlite
        .prepare("SELECT canonical_path FROM project_paths WHERE project_id = ? LIMIT 1")
        .get(input.projectId) as { canonical_path: string }
    ).canonical_path;
    return {
      ...offered,
      body: {
        agentId: "codex",
        role: "primary",
        client: "codex-app-server",
        transport: "websocket",
        deliveryMode: "app_server_push",
        externalSessionId: input.externalThreadId,
        externalThreadId: input.externalThreadId,
        expectedHeadSessionId:
          input.expectedHeadSessionId === undefined
            ? input.reservation.expectedHeadSessionId
            : input.expectedHeadSessionId,
        launcherRunId: input.reservation.runId,
        launchGeneration: input.reservation.generation,
        host: "test",
        cwd,
        capabilities: [],
        ticket_bundle_id: offered.bundleId,
        idempotencyKey: input.idempotencyKey,
      },
    };
  }

  it("binds every privileged session mutation to the authenticated Adapter identity", async () => {
    const countRows = () => ({
      sessions: Number(
        (
          server.store.sqlite.prepare("SELECT COUNT(*) AS count FROM agent_sessions").get() as {
            count: number;
          }
        ).count,
      ),
      reservations: Number(
        (
          server.store.sqlite
            .prepare("SELECT COUNT(*) AS count FROM session_launch_reservations")
            .get() as { count: number }
        ).count,
      ),
      events: Number(
        (
          server.store.sqlite.prepare("SELECT COUNT(*) AS count FROM events").get() as {
            count: number;
          }
        ).count,
      ),
      idempotency: Number(
        (
          server.store.sqlite.prepare("SELECT COUNT(*) AS count FROM idempotency_keys").get() as {
            count: number;
          }
        ).count,
      ),
    });
    const baseline = countRows();
    const codexToken = server.credentials.agentByClient.codex.token;
    const claudeToken = server.credentials.agentByClient.claude.token;

    const invalidSessionAttempts = [
      request<any>(
        "POST",
        `/api/projects/${projectId}/sessions`,
        {
          agentId: "claude",
          role: "primary",
          client: "claude-channel",
          transport: "websocket",
          deliveryMode: "native_channel",
          externalSessionId: "forged-claude-session",
          host: "test",
          cwd: projectDir,
          capabilities: [],
          idempotencyKey: "codex-forges-claude-session",
        },
        codexToken,
      ),
      request<any>(
        "POST",
        `/api/projects/${projectId}/sessions`,
        {
          agentId: "codex",
          role: "primary",
          client: "codex-app-server",
          transport: "websocket",
          deliveryMode: "app_server_push",
          externalThreadId: "forged-codex-thread",
          host: "test",
          cwd: projectDir,
          capabilities: [],
          idempotencyKey: "claude-forges-codex-session",
        },
        claudeToken,
      ),
      request<any>(
        "POST",
        `/api/projects/${projectId}/sessions`,
        {
          agentId: "codex",
          role: "primary",
          client: "claude-channel",
          transport: "websocket",
          deliveryMode: "native_channel",
          externalSessionId: "codex-declares-claude-client",
          host: "test",
          cwd: projectDir,
          capabilities: [],
          idempotencyKey: "codex-client-family-mismatch",
        },
        codexToken,
      ),
      request<any>(
        "POST",
        `/api/projects/${projectId}/sessions`,
        {
          agentId: "claude",
          role: "primary",
          client: "codex-app-server",
          transport: "websocket",
          deliveryMode: "app_server_push",
          externalThreadId: "claude-declares-codex-client",
          host: "test",
          cwd: projectDir,
          capabilities: [],
          idempotencyKey: "claude-client-family-mismatch",
        },
        claudeToken,
      ),
      request<any>(
        "POST",
        `/api/projects/${projectId}/sessions`,
        {
          agentId: "codex",
          role: "primary",
          client: "codex-app-server",
          transport: "websocket",
          deliveryMode: "app_server_push",
          externalThreadId: "compat-codex-thread",
          host: "test",
          cwd: projectDir,
          capabilities: [],
          idempotencyKey: "compat-forges-codex-session",
        },
        server.token,
      ),
      request<any>(
        "POST",
        `/api/projects/${projectId}/sessions`,
        {
          agentId: "codex",
          role: "observer",
          client: "fake-client",
          transport: "hook-poll",
          deliveryMode: "mailbox_only",
          host: "test",
          cwd: projectDir,
          capabilities: [],
          idempotencyKey: "compat-fake-client-forges-codex",
        },
        server.token,
      ),
      request<any>(
        "POST",
        `/api/projects/${projectId}/sessions`,
        {
          agentId: "claude",
          role: "observer",
          client: "fake-client",
          transport: "hook-poll",
          deliveryMode: "mailbox_only",
          host: "test",
          cwd: projectDir,
          capabilities: [],
          idempotencyKey: "compat-fake-client-forges-claude",
        },
        server.token,
      ),
      request<any>(
        "POST",
        `/api/projects/${projectId}/sessions`,
        {
          agentId: "unnamespaced-fixture",
          role: "observer",
          client: "fake-client",
          transport: "hook-poll",
          deliveryMode: "mailbox_only",
          host: "test",
          cwd: projectDir,
          capabilities: [],
          idempotencyKey: "compat-fake-client-without-manual-namespace",
        },
        server.token,
      ),
      request<any>(
        "POST",
        `/api/projects/${projectId}/sessions`,
        {
          agentId: "claude",
          role: "primary",
          client: "claude-channel",
          transport: "websocket",
          deliveryMode: "native_channel",
          externalSessionId: "compat-claude-session",
          host: "test",
          cwd: projectDir,
          capabilities: [],
          idempotencyKey: "compat-forges-claude-session",
        },
        server.token,
      ),
      request<any>(
        "POST",
        `/api/projects/${projectId}/session-launch-reservations`,
        {
          agentId: "claude",
          client: "claude-channel",
          deliveryMode: "native_channel",
          externalSessionId: "forged-claude-reservation",
          runId: "run_codex_forces_claude",
          idempotencyKey: "codex-forges-claude-reservation",
        },
        codexToken,
      ),
      request<any>(
        "POST",
        `/api/projects/${projectId}/session-launch-reservations`,
        {
          agentId: "codex",
          client: "codex-app-server",
          deliveryMode: "app_server_push",
          externalThreadId: "forged-codex-reservation",
          runId: "run_claude_forces_codex",
          idempotencyKey: "claude-forges-codex-reservation",
        },
        claudeToken,
      ),
    ];
    for (const attempt of await Promise.all(invalidSessionAttempts)) {
      expect(attempt, JSON.stringify(attempt.body)).toMatchObject({ status: 403 });
    }
    expect(countRows()).toEqual(baseline);

    const codex = (await register("codex", "identity-codex", "identity-codex-session")).body;
    const claude = (await register("claude", "identity-claude", "identity-claude-session")).body;
    const codexControl = sessionToken(codex.id);
    const claudeControl = sessionToken(claude.id);
    const beforeMutations = countRows();
    const codexBefore = server.store.getSession(codex.id);
    const claudeBefore = server.store.getSession(claude.id);
    const invalidMutations = [
      request<any>(
        "POST",
        `/api/sessions/${claude.id}/heartbeat`,
        { sequence: 99, workState: "WORKING", activeFiles: ["forged"], queueDepth: 7 },
        codexControl,
      ),
      request<any>(
        "POST",
        `/api/sessions/${codex.id}/heartbeat`,
        { sequence: 99, workState: "WORKING", activeFiles: ["forged"], queueDepth: 7 },
        claudeControl,
      ),
      request<any>(
        "POST",
        `/api/sessions/${claude.id}/adapter-events`,
        { method: "forged/codex", idempotencyKey: "codex-forges-claude-event" },
        codexControl,
      ),
      request<any>(
        "POST",
        `/api/sessions/${codex.id}/adapter-events`,
        { method: "forged/claude", idempotencyKey: "claude-forges-codex-event" },
        claudeControl,
      ),
      request<any>(
        "POST",
        `/api/sessions/${claude.id}/close`,
        { reason: "forged", idempotencyKey: "codex-forges-claude-close" },
        codexControl,
      ),
      request<any>(
        "POST",
        `/api/sessions/${codex.id}/close`,
        { reason: "forged", idempotencyKey: "claude-forges-codex-close" },
        claudeControl,
      ),
      request<any>(
        "POST",
        `/api/sessions/${codex.id}/adapter-events`,
        { method: "compat/forged", idempotencyKey: "compat-forges-codex-event" },
        server.token,
      ),
      request<any>(
        "POST",
        `/api/sessions/${claude.id}/heartbeat`,
        { sequence: 100, workState: "WORKING", activeFiles: ["compat-forged"], queueDepth: 8 },
        server.token,
      ),
    ];
    for (const attempt of await Promise.all(invalidMutations)) {
      expect(attempt).toMatchObject({ status: 403 });
    }
    expect(countRows()).toEqual(beforeMutations);
    expect(server.store.getSession(codex.id)).toEqual(codexBefore);
    expect(server.store.getSession(claude.id)).toEqual(claudeBefore);

    expect(
      await request<any>(
        "POST",
        `/api/sessions/${codex.id}/heartbeat`,
        { sequence: 1, workState: "WORKING", activeFiles: [], queueDepth: 1 },
        codexControl,
      ),
    ).toMatchObject({ status: 200, body: { agentId: "codex", queueDepth: 1 } });
    const validAdapterEvent = {
      method: "claude/valid",
      idempotencyKey: "claude-valid-event",
    };
    expect(
      await request<any>(
        "POST",
        `/api/sessions/${claude.id}/adapter-events`,
        validAdapterEvent,
        claudeControl,
      ),
    ).toMatchObject({ status: 200, body: { actorId: "claude" } });
    const beforeReplay = countRows();
    expect(
      await request<any>(
        "POST",
        `/api/sessions/${claude.id}/adapter-events`,
        validAdapterEvent,
        codexControl,
      ),
    ).toMatchObject({ status: 403 });
    expect(countRows()).toEqual(beforeReplay);
  });

  it("does not let the compatibility bearer act through a legacy reserved fake-client session", async () => {
    const legacy = server.store.registerSession({
      projectId,
      agentId: "codex",
      role: "observer",
      client: "fake-client",
      transport: "hook-poll",
      deliveryMode: "mailbox_only",
      host: "legacy-test",
      cwd: projectDir,
      capabilities: [],
      idempotencyKey: "trusted-legacy-codex-fixture",
    });
    const claude = (await register("claude", "legacy-target", "legacy-target-session")).body;
    const createTask = (key: string) =>
      server.store.createTask(server.credentials.dashboard.principal, projectId, {
        objectiveId,
        title: key,
        description: "reserved fake-client provenance must not be reusable",
        status: "READY",
        priority: "normal",
        reviewerAgentId: null,
        capabilityTags: [],
        scopeGlobs: [],
        protectedScope: false,
        reviewRequired: false,
        dependsOn: [],
        weight: 1,
        idempotencyKey: `create-${key}`,
      });
    const claimCandidate = createTask("legacy-claim-candidate");
    const releaseCandidate = createTask("legacy-release-candidate");
    const handoffCandidate = createTask("legacy-handoff-candidate");
    const splitCandidate = createTask("legacy-split-candidate");
    const claimedForRelease = server.store.claimTask(releaseCandidate.id, {
      sessionId: legacy.id,
      expectedVersion: releaseCandidate.version,
      takeoverStale: false,
      idempotencyKey: "trusted-claim-for-release-fixture",
    });
    const claimedForHandoff = server.store.claimTask(handoffCandidate.id, {
      sessionId: legacy.id,
      expectedVersion: handoffCandidate.version,
      takeoverStale: false,
      idempotencyKey: "trusted-claim-for-handoff-fixture",
    });
    const taskIds = [
      claimCandidate.id,
      claimedForRelease.id,
      claimedForHandoff.id,
      splitCandidate.id,
    ];
    const countRows = () => ({
      events: Number(
        (
          server.store.sqlite.prepare("SELECT COUNT(*) AS count FROM events").get() as {
            count: number;
          }
        ).count,
      ),
      idempotency: Number(
        (
          server.store.sqlite.prepare("SELECT COUNT(*) AS count FROM idempotency_keys").get() as {
            count: number;
          }
        ).count,
      ),
      messages: Number(
        (
          server.store.sqlite.prepare("SELECT COUNT(*) AS count FROM messages").get() as {
            count: number;
          }
        ).count,
      ),
      tasks: Number(
        (
          server.store.sqlite.prepare("SELECT COUNT(*) AS count FROM tasks").get() as {
            count: number;
          }
        ).count,
      ),
      reviews: Number(
        (
          server.store.sqlite.prepare("SELECT COUNT(*) AS count FROM reviews").get() as {
            count: number;
          }
        ).count,
      ),
      writeIntents: Number(
        (
          server.store.sqlite.prepare("SELECT COUNT(*) AS count FROM write_intents").get() as {
            count: number;
          }
        ).count,
      ),
    });
    const beforeRows = countRows();
    const beforeTasks = taskIds.map((taskId) => server.store.getTask(taskId));
    const beforeLegacy = server.store.getSession(legacy.id);

    const attempts = await Promise.all([
      request<any>(
        "POST",
        `/api/projects/${projectId}/messages`,
        {
          fromAgentId: "codex",
          fromSessionId: legacy.id,
          recipients: [{ agentId: "claude", sessionId: claude.id }],
          type: "HANDOFF",
          priority: "IMPORTANT",
          requiresAck: true,
          requiresResponse: false,
          summary: "forged legacy message",
          idempotencyKey: "compat-legacy-message",
        },
        server.token,
      ),
      request<any>(
        "POST",
        `/api/tasks/${claimCandidate.id}/claim`,
        {
          sessionId: legacy.id,
          expectedVersion: claimCandidate.version,
          takeoverStale: false,
          idempotencyKey: "compat-legacy-claim",
        },
        server.token,
      ),
      request<any>(
        "POST",
        `/api/tasks/${claimedForRelease.id}/release`,
        {
          sessionId: legacy.id,
          expectedVersion: claimedForRelease.version,
          idempotencyKey: "compat-legacy-release",
        },
        server.token,
      ),
      request<any>(
        "POST",
        `/api/tasks/${claimedForHandoff.id}/handoff`,
        {
          sessionId: legacy.id,
          expectedVersion: claimedForHandoff.version,
          toAgentId: "claude",
          summary: "forged legacy handoff",
          idempotencyKey: "compat-legacy-handoff",
        },
        server.token,
      ),
      request<any>(
        "POST",
        `/api/tasks/${splitCandidate.id}/split`,
        {
          sessionId: legacy.id,
          expectedVersion: splitCandidate.version,
          children: [{ title: "forged child one" }, { title: "forged child two" }],
          idempotencyKey: "compat-legacy-split",
        },
        server.token,
      ),
      request<any>(
        "POST",
        "/api/context-pack",
        {
          sessionId: legacy.id,
          taskId: claimCandidate.id,
          files: [],
          symbols: [],
          maxChars: 2000,
        },
        server.token,
      ),
      request<any>(
        "POST",
        `/api/projects/${projectId}/write-intents`,
        {
          taskId: claimCandidate.id,
          sessionId: legacy.id,
          globs: ["apps/hub/**"],
          symbols: [],
          mode: "advisory",
          reason: "forged legacy write intent",
          ttlSeconds: 300,
          idempotencyKey: "compat-legacy-write-intent",
        },
        server.token,
      ),
      request<any>(
        "POST",
        `/api/tasks/${claimedForRelease.id}/reviews`,
        {
          sessionId: legacy.id,
          reviewerAgentId: "claude",
          baseSha: "0".repeat(40),
          headSha: "0".repeat(40),
          acceptanceCriteria: [],
          testEvidence: [],
          authorClaims: [],
          knownRisks: [],
          includeUncommitted: false,
          idempotencyKey: "compat-legacy-review",
        },
        server.token,
      ),
    ]);

    for (const attempt of attempts) {
      expect(attempt, JSON.stringify(attempt.body)).toMatchObject({ status: 403 });
    }
    expect(countRows()).toEqual(beforeRows);
    expect(taskIds.map((taskId) => server.store.getTask(taskId))).toEqual(beforeTasks);
    expect(server.store.getSession(legacy.id)).toEqual(beforeLegacy);
  });

  it("rejects every managed Codex role that omits its logical identity and launch fence", async () => {
    for (const role of ["primary", "reviewer", "observer"] as const) {
      const offered = await offerSessionTicketBundle({
        projectId,
        agentId: "codex",
        client: "codex-app-server",
        role,
        runId: `run_missing_codex_identity_${role}`,
        suffix: `missing_codex_identity_${role}`,
      });
      const response = await request<any>(
        "POST",
        `/api/projects/${projectId}/sessions`,
        {
          agentId: "codex",
          role,
          client: "codex-app-server",
          transport: "websocket",
          deliveryMode: "app_server_push",
          host: "test",
          cwd: projectDir,
          capabilities: [],
          ticket_bundle_id: offered.bundleId,
          idempotencyKey: `missing-codex-identity-${role}`,
        },
        offered.tokens.CONTROL,
      );

      expect(response).toMatchObject({
        status: 422,
        body: { code: "SESSION_LOGICAL_IDENTITY_REQUIRED" },
      });
    }
    expect(
      server.store.sqlite
        .prepare(
          "SELECT COUNT(*) AS count FROM agent_sessions WHERE project_id = ? AND client = 'codex-app-server'",
        )
        .get(projectId),
    ).toEqual({ count: 0 });
  });

  it("keeps distinct logical threads live and replaces only the matching thread", async () => {
    const first = (await register("codex", "desktop-thread-a", "session-a")).body;
    const second = (await register("codex", "desktop-thread-b", "session-b")).body;

    expect(server.store.getSession(first.id).connectionState).toBe("ONLINE");
    expect(server.store.getSession(second.id).connectionState).toBe("ONLINE");
    expect(
      server.store.listEvents(projectId).filter((event) => event.type === "session.superseded"),
    ).toHaveLength(0);

    const replacement = (await register("codex", "desktop-thread-a", "session-a-replacement")).body;

    expect(server.store.getSession(first.id).connectionState).toBe("CLOSED");
    expect(server.store.getSession(second.id).connectionState).toBe("ONLINE");
    expect(server.store.getSession(replacement.id).connectionState).toBe("ONLINE");
    expect(
      server.store
        .listSessions(projectId)
        .filter((session) => session.agentId === "codex")
        .map((session) => session.id),
    ).toEqual([replacement.id, second.id]);
    expect(
      server.store.listEvents(projectId).filter((event) => event.type === "session.superseded"),
    ).toEqual([
      expect.objectContaining({
        aggregateType: "session",
        aggregateId: first.id,
        causationId: replacement.id,
        payload: expect.objectContaining({
          supersededBySessionId: replacement.id,
          externalThreadId: "desktop-thread-a",
          reboundRecipientCount: 0,
          reboundTaskCount: 0,
          reboundIntentCount: 0,
        }),
      }),
    ]);
  });

  it("does not let a superseded session heartbeat or emit adapter activity back to life", async () => {
    const predecessor = (await register("codex", "desktop-thread", "closed-predecessor")).body;
    const replacement = (await register("codex", "desktop-thread", "live-replacement")).body;

    const heartbeat = await request<any>("POST", `/api/sessions/${predecessor.id}/heartbeat`, {
      sequence: 1,
      workState: "WORKING",
      currentTaskId: null,
      currentReviewId: null,
      activeFiles: ["stale-worker.ts"],
      queueDepth: 1,
    });
    const adapterEvent = await request<any>(
      "POST",
      `/api/sessions/${predecessor.id}/adapter-events`,
      {
        method: "turn/started",
        workState: "WORKING",
        idempotencyKey: "stale-adapter-event",
      },
    );

    expect(heartbeat).toMatchObject({ status: 403, body: { code: "FORBIDDEN" } });
    expect(adapterEvent).toMatchObject({ status: 403, body: { code: "FORBIDDEN" } });
    expect(() => server.store.reconcileObservedChanges(predecessor.id)).toThrow(/closed/i);
    expect(server.store.getSession(predecessor.id)).toMatchObject({
      connectionState: "CLOSED",
      activeFiles: [],
    });
    expect(server.store.getSession(replacement.id)).toMatchObject({
      connectionState: "ONLINE",
      currentTaskId: null,
    });
    expect(
      server.store
        .listEvents(projectId)
        .filter(
          (event) => event.aggregateId === predecessor.id && event.type.startsWith("adapter."),
        ),
    ).toHaveLength(0);
  });

  it("atomically transfers active ownership when the same logical thread restarts", async () => {
    const predecessor = (await register("codex", "desktop-thread", "predecessor-session")).body;
    const claude = (await register("claude", "claude-thread", "claude-session")).body;
    const task = (
      await request<any>("POST", `/api/projects/${projectId}/tasks`, {
        objectiveId,
        milestoneId: null,
        parentTaskId: null,
        title: "Owned by the logical Desktop thread",
        description: "",
        status: "READY",
        priority: "critical",
        reviewerAgentId: "claude",
        capabilityTags: [],
        scopeGlobs: ["src/**"],
        protectedScope: true,
        reviewRequired: true,
        dependsOn: [],
        weight: 1,
        idempotencyKey: "owned-task",
      })
    ).body;
    const claimed = (
      await request<any>("POST", `/api/tasks/${task.id}/claim`, {
        sessionId: predecessor.id,
        expectedVersion: task.version,
        takeoverStale: false,
        idempotencyKey: "claim-owned-task",
      })
    ).body;
    server.store.sqlite
      .prepare("UPDATE tasks SET claim_stale_at = ? WHERE id = ?")
      .run("2026-01-01T00:00:00.000Z", task.id);
    const intent = (
      await request<any>("POST", `/api/projects/${projectId}/write-intents`, {
        taskId: task.id,
        sessionId: predecessor.id,
        globs: ["src/**"],
        symbols: ["SessionOwner"],
        mode: "exclusive",
        reason: "Keep ownership on restart",
        ttlSeconds: 600,
        idempotencyKey: "owned-intent",
      })
    ).body.intent;
    const message = (
      await request<any>("POST", `/api/projects/${projectId}/messages`, {
        fromAgentId: "claude",
        fromSessionId: claude.id,
        recipients: [{ agentId: "codex", sessionId: predecessor.id }],
        taskId: task.id,
        type: "QUESTION",
        priority: "IMPORTANT",
        requiresAck: true,
        requiresResponse: true,
        summary: "Continue on the same logical thread",
        idempotencyKey: "owned-message",
      })
    ).body;

    expect(claimed.ownerSessionId).toBe(predecessor.id);
    const replacement = (await register("codex", "desktop-thread", "replacement-session")).body;

    const reboundTask = (await request<any>("GET", `/api/tasks/${task.id}`)).body;
    const reboundMessage = (await request<any>("GET", `/api/messages/${message.id}`)).body;
    const reboundIntent = server.store.sqlite
      .prepare("SELECT session_id FROM write_intents WHERE id = ?")
      .get(intent.id) as { session_id: string };

    expect(reboundTask.ownerSessionId).toBe(replacement.id);
    expect(reboundTask.claimStaleAt).toBeNull();
    expect(server.store.getSession(replacement.id)).toMatchObject({
      currentTaskId: task.id,
      workState: "PLANNING",
    });
    expect(reboundIntent.session_id).toBe(replacement.id);
    expect(reboundMessage.recipients[0]).toMatchObject({
      recipientSessionId: replacement.id,
      state: "PENDING",
    });
    expect(
      await request<any>("POST", `/api/messages/${message.id}/delivered`, {
        sessionId: predecessor.id,
        idempotencyKey: "superseded-message-delivery",
      }),
    ).toMatchObject({ status: 403, body: { code: "FORBIDDEN" } });
    expect(
      await request<any>("POST", `/api/tasks/${task.id}/release`, {
        sessionId: claude.id,
        expectedVersion: reboundTask.version,
        idempotencyKey: "non-owner-release-after-replacement",
      }),
    ).toMatchObject({ status: 403, body: { code: "FORBIDDEN" } });
  });

  it("transfers a retryable FAILED recipient to the same-thread successor", async () => {
    const predecessor = (await register("codex", "failed-retry-thread", "failed-retry-predecessor"))
      .body;
    const claude = (await register("claude", "failed-retry-claude", "failed-retry-claude-session"))
      .body;
    const message = (
      await request<any>("POST", `/api/projects/${projectId}/messages`, {
        fromAgentId: "claude",
        fromSessionId: claude.id,
        recipients: [{ agentId: "codex", sessionId: predecessor.id }],
        type: "QUESTION",
        priority: "IMPORTANT",
        requiresAck: true,
        requiresResponse: true,
        summary: "Retry this after replacement",
        idempotencyKey: "failed-retry-message",
      })
    ).body;
    server.store.sqlite
      .prepare(
        "UPDATE message_recipients SET state = 'FAILED', last_error = 'transport failed' WHERE message_id = ?",
      )
      .run(message.id);

    const successor = (await register("codex", "failed-retry-thread", "failed-retry-successor"))
      .body;

    expect(
      (await request<any>("GET", `/api/messages/${message.id}`)).body.recipients[0],
    ).toMatchObject({
      recipientSessionId: successor.id,
      state: "FAILED",
    });
    expect(
      await request<any>("POST", `/api/messages/${message.id}/surface-attempts`, {
        sessionId: successor.id,
        idempotencyKey: "failed-retry-surface",
      }),
    ).toMatchObject({ status: 200 });
  });

  it("recovers only the exact successor session's unsettled recipients after current-head replacement", async () => {
    const sender = (await register("codex", "unsettled-sender", "unsettled-sender-session")).body;
    const predecessor = (await register("claude", "unsettled-thread", "unsettled-predecessor"))
      .body;
    const sibling = (await register("claude", "unsettled-sibling", "unsettled-sibling-session"))
      .body;
    const postPinned = async (sessionId: string | undefined, key: string) =>
      (
        await request<any>("POST", `/api/projects/${projectId}/messages`, {
          fromAgentId: "codex",
          fromSessionId: sender.id,
          recipients: [{ agentId: "claude", ...(sessionId ? { sessionId } : {}) }],
          type: "QUESTION",
          priority: "IMPORTANT",
          requiresAck: true,
          requiresResponse: true,
          summary: key,
          idempotencyKey: key,
        })
      ).body;
    const setState = (messageId: string, path: string, sessionId: string, key: string) =>
      request<any>("POST", `/api/messages/${messageId}/${path}`, {
        sessionId,
        idempotencyKey: key,
      });

    const delivered = await postPinned(predecessor.id, "unsettled-delivered");
    const acknowledged = await postPinned(predecessor.id, "unsettled-acknowledged");
    expect(
      await setState(delivered.id, "delivered", predecessor.id, "unsettled-delivered-state"),
    ).toMatchObject({ status: 200, body: { recipients: [{ state: "DELIVERED" }] } });
    expect(
      await setState(acknowledged.id, "ack", predecessor.id, "unsettled-acknowledged-state"),
    ).toMatchObject({ status: 200, body: { recipients: [{ state: "ACKNOWLEDGED" }] } });

    for (const message of [delivered, acknowledged]) {
      const thread = server.store.getThread(message.threadId).thread;
      expect(
        await request<any>(
          "POST",
          `/api/threads/${thread.id}/status`,
          {
            expectedVersion: thread.version,
            status: "RESOLVED",
            idempotencyKey: `resolve_${message.id}`,
          },
          server.credentials.dashboard.token,
        ),
      ).toMatchObject({ status: 200, body: { status: "RESOLVED" } });
    }

    const successor = await replaceClaudeCurrentHead(predecessor, "unsettled-successor");
    for (const [message, state] of [
      [delivered, "DELIVERED"],
      [acknowledged, "ACKNOWLEDGED"],
    ] as const) {
      expect((await request<any>("GET", `/api/messages/${message.id}`)).body).toMatchObject({
        recipients: [{ recipientSessionId: successor.id, state }],
      });
    }

    const pending = await postPinned(successor.id, "unsettled-pending");
    const failed = await postPinned(successor.id, "unsettled-failed");
    const successorPrincipal = new CredentialRegistry(
      server.store.sqlite,
      server.credentials,
    ).authenticate(
      {
        headers: { authorization: `Bearer ${sessionToken(successor.id)}` },
        query: {},
      } as FastifyRequest,
      ["hub:session"],
    );
    expect(
      server.store.updateMessageState(successorPrincipal, failed.id, {
        sessionId: successor.id,
        state: "FAILED",
        error: "retryable transport failure",
        idempotencyKey: "unsettled-failed-state",
      }),
    ).toMatchObject({ recipients: [{ recipientSessionId: successor.id, state: "FAILED" }] });
    const processed = await postPinned(successor.id, "unsettled-terminal-processed");
    const responded = await postPinned(successor.id, "unsettled-terminal-responded");
    const expired = await postPinned(successor.id, "unsettled-terminal-expired");
    const agentWide = await postPinned(undefined, "unsettled-agent-wide");
    const siblingPinned = await postPinned(sibling.id, "unsettled-sibling-pinned");
    expect(
      await setState(processed.id, "processed", successor.id, "unsettled-processed-state"),
    ).toMatchObject({ status: 200, body: { recipients: [{ state: "PROCESSED" }] } });
    expect(
      await setState(responded.id, "responded", successor.id, "unsettled-responded-state"),
    ).toMatchObject({ status: 200, body: { recipients: [{ state: "RESPONDED" }] } });
    server.store.sqlite
      .prepare("UPDATE message_recipients SET state = 'EXPIRED' WHERE message_id = ?")
      .run(expired.id);

    const exactPath =
      `/api/projects/${projectId}/messages?agentId=claude&sessionId=${successor.id}` +
      "&recipientUnsettled=true&limit=500";
    const unsettled = await request<any[]>("GET", exactPath, undefined, sessionToken(successor.id));
    expect(unsettled.status).toBe(200);
    expect(unsettled.body).toHaveLength(4);
    for (const [message, state] of [
      [pending, "PENDING"],
      [failed, "FAILED"],
      [delivered, "DELIVERED"],
      [acknowledged, "ACKNOWLEDGED"],
    ] as const) {
      expect(unsettled.body.filter((entry) => entry.recipients[0].state === state)).toEqual([
        expect.objectContaining({ id: message.id }),
      ]);
    }
    for (const message of unsettled.body) {
      expect(message.recipients).toEqual([
        expect.objectContaining({ recipientAgentId: "claude", recipientSessionId: successor.id }),
      ]);
    }
    expect(unsettled.body.map((message) => message.id)).not.toEqual(
      expect.arrayContaining([
        processed.id,
        responded.id,
        expired.id,
        agentWide.id,
        siblingPinned.id,
      ]),
    );

    const pageBeforeAcknowledged = await request<any[]>(
      "GET",
      `${exactPath}&beforeSequence=${acknowledged.sequence}`,
      undefined,
      sessionToken(successor.id),
    );
    expect(pageBeforeAcknowledged).toMatchObject({
      status: 200,
      body: [{ id: delivered.id, recipients: [{ state: "DELIVERED" }] }],
    });

    const foreignDir = resolve(dirname(projectDir), "unsettled-foreign-project");
    mkdirSync(foreignDir);
    const foreignProject = (
      await request<any>(
        "POST",
        "/api/projects/join",
        { cwd: foreignDir, allowCreate: true, name: "unsettled foreign" },
        server.credentials.dashboard.token,
      )
    ).body.project;
    const foreign = (
      await registerForProject(
        foreignProject.id,
        "claude",
        "unsettled-foreign-thread",
        "unsettled-foreign-session",
      )
    ).body;
    const sideEffects = () => ({
      projectSequence: (
        server.store.sqlite
          .prepare("SELECT current_sequence FROM projects WHERE id = ?")
          .get(projectId) as { current_sequence: number }
      ).current_sequence,
      messages: Number(server.store.sqlite.prepare("SELECT COUNT(*) FROM messages").pluck().get()),
      recipients: Number(
        server.store.sqlite.prepare("SELECT COUNT(*) FROM message_recipients").pluck().get(),
      ),
      surfaces: Number(
        server.store.sqlite.prepare("SELECT COUNT(*) FROM message_surface_attempts").pluck().get(),
      ),
      idempotency: Number(
        server.store.sqlite.prepare("SELECT COUNT(*) FROM idempotency_keys").pluck().get(),
      ),
    });
    const beforeRejectedReads = sideEffects();
    for (const invalidPath of [
      `/api/projects/${projectId}/messages?sessionId=${successor.id}&recipientUnsettled=true`,
      `/api/projects/${projectId}/messages?agentId=claude&recipientUnsettled=true`,
      `${exactPath}&unread=true`,
      `${exactPath}&unresolved=true`,
    ]) {
      expect(
        await request<any>("GET", invalidPath, undefined, sessionToken(successor.id)),
      ).toMatchObject({ status: 422, body: { code: "VALIDATION_ERROR" } });
    }
    for (const token of [
      sessionToken(sibling.id),
      sessionToken(foreign.id),
      server.credentials.agentByClient.claude.token,
      server.credentials.dashboard.token,
    ]) {
      const rejected = await request<any>("GET", exactPath, undefined, token);
      expect(rejected.status).toBe(403);
      expect(rejected.body.code).toEqual(expect.any(String));
    }
    expect(sideEffects()).toEqual(beforeRejectedReads);
  });

  it("atomically hands an ACTIVE predecessor surface to exactly one concurrent current-head successor", async () => {
    const sender = (
      await register("codex", "surface-handoff-sender", "surface-handoff-sender-session")
    ).body;
    const predecessor = (
      await register("claude", "surface-handoff-thread", "surface-handoff-predecessor")
    ).body;
    const message = (
      await request<any>("POST", `/api/projects/${projectId}/messages`, {
        fromAgentId: "codex",
        fromSessionId: sender.id,
        recipients: [{ agentId: "claude", sessionId: predecessor.id }],
        type: "QUESTION",
        priority: "IMPORTANT",
        requiresAck: true,
        requiresResponse: true,
        summary: "Do not lose an in-flight surface during replacement",
        idempotencyKey: "surface-handoff-message",
      })
    ).body;
    const surface = (
      await request<any>("POST", `/api/messages/${message.id}/surface-attempts`, {
        sessionId: predecessor.id,
        idempotencyKey: "surface-handoff-active",
      })
    ).body.permit;
    const replacements = await Promise.all([
      prepareClaudeCurrentHeadReplacement(predecessor, "surface-handoff-successor-a"),
      prepareClaudeCurrentHeadReplacement(predecessor, "surface-handoff-successor-b"),
    ]);
    const registrations = await Promise.all(
      replacements.map((prepared) =>
        request<any>(
          "POST",
          `/api/projects/${projectId}/sessions`,
          prepared.body,
          prepared.control,
        ),
      ),
    );
    const winnerIndex = registrations.findIndex((entry) => entry.status === 200);
    expect(winnerIndex).toBeGreaterThanOrEqual(0);
    expect(registrations.filter((entry) => entry.status === 200)).toHaveLength(1);
    expect(registrations.filter((entry) => entry.status !== 200)).toHaveLength(1);
    const winner = registrations[winnerIndex]!.body.session;
    const winningBundle = replacements[winnerIndex]!;
    sessionTickets.set(winner.id, {
      bundleId: winningBundle.bundleId,
      client: "claude-channel",
      tokens: { CONTROL: winningBundle.control },
    });

    expect(server.store.getSession(predecessor.id).connectionState).toBe("CLOSED");
    expect(
      server.store.sqlite
        .prepare("SELECT state FROM message_surface_attempts WHERE id = ?")
        .get(surface.id),
    ).toEqual({ state: "AMBIGUOUS" });
    expect((await request<any>("GET", `/api/messages/${message.id}`)).body).toMatchObject({
      recipients: [{ recipientSessionId: winner.id, state: "PENDING" }],
    });
    const unsettledPath =
      `/api/projects/${projectId}/messages?agentId=claude&sessionId=${winner.id}` +
      "&recipientUnsettled=true";
    expect(
      await request<any[]>("GET", unsettledPath, undefined, sessionToken(winner.id)),
    ).toMatchObject({ status: 200, body: [{ id: message.id }] });
    expect(
      await request<any>(
        "POST",
        `/api/messages/${message.id}/authority-delivery/recover`,
        { session_id: winner.id },
        sessionToken(winner.id),
      ),
    ).toMatchObject({
      status: 409,
      body: { code: "AUTHORITY_DELIVERY_RECOVERY_UNCONFIRMED" },
    });
    expect(
      await request<any>("POST", `/api/messages/${message.id}/surface-attempts`, {
        sessionId: winner.id,
        idempotencyKey: "surface-handoff-no-third-surface",
      }),
    ).toMatchObject({ status: 409, body: { code: "MESSAGE_SURFACE_IN_FLIGHT" } });
    expect(
      await request<any>(
        "POST",
        `/api/messages/${message.id}/surface-attempts/${surface.id}/state`,
        {
          sessionId: predecessor.id,
          state: "ABORTED",
          idempotencyKey: "surface-handoff-late-predecessor-settle",
        },
        sessionToken(predecessor.id),
      ),
    ).toMatchObject({ status: 403 });
    expect(
      await request<any>(
        "POST",
        `/api/messages/${message.id}/delivered`,
        {
          sessionId: predecessor.id,
          surfaceAttemptId: surface.id,
          recipientFence: surface.recipientFence,
          idempotencyKey: "surface-handoff-late-predecessor-delivery",
        },
        sessionToken(predecessor.id),
      ),
    ).toMatchObject({ status: 403 });
    expect(
      server.store.sqlite
        .prepare("SELECT COUNT(*) FROM message_surface_attempts WHERE recipient_id = ?")
        .pluck()
        .get(surface.recipientId),
    ).toBe(1);
    expect(
      server.store
        .listEvents(projectId, 0, 5000)
        .filter(
          (event) => event.type === "message.surface.ambiguous" && event.causationId === surface.id,
        ),
    ).toEqual([
      expect.objectContaining({
        actorType: "system",
        aggregateId: message.id,
        payload: expect.objectContaining({
          recipientId: surface.recipientId,
          sessionId: predecessor.id,
          recipientFence: surface.recipientFence,
          reboundToSessionId: winner.id,
        }),
      }),
    ]);
  });

  it("reconciles an ordinary AMBIGUOUS predecessor from the exact external thread", async () => {
    const sender = (
      await register("codex", "ambiguous-handoff-sender", "ambiguous-handoff-sender-session")
    ).body;
    const predecessor = (
      await register("claude", "ambiguous-handoff-thread", "ambiguous-handoff-predecessor")
    ).body;
    const message = (
      await request<any>("POST", `/api/projects/${projectId}/messages`, {
        fromAgentId: "codex",
        fromSessionId: sender.id,
        recipients: [{ agentId: "claude", sessionId: predecessor.id }],
        type: "QUESTION",
        priority: "IMPORTANT",
        requiresAck: true,
        requiresResponse: true,
        summary: "Preserve an already ambiguous predecessor surface",
        idempotencyKey: "ambiguous-handoff-message",
      })
    ).body;
    const surface = (
      await request<any>("POST", `/api/messages/${message.id}/surface-attempts`, {
        sessionId: predecessor.id,
        idempotencyKey: "ambiguous-handoff-active",
      })
    ).body.permit;
    expect(
      await request<any>(
        "POST",
        `/api/messages/${message.id}/surface-attempts/${surface.id}/state`,
        {
          sessionId: predecessor.id,
          state: "AMBIGUOUS",
          error: "delivery outcome unknown before replacement",
          idempotencyKey: "ambiguous-handoff-mark",
        },
      ),
    ).toMatchObject({ status: 200, body: { permit: { state: "AMBIGUOUS" } } });
    const before = server.store.sqlite
      .prepare("SELECT state, error, updated_at FROM message_surface_attempts WHERE id = ?")
      .get(surface.id);
    const intermediate = await replaceClaudeCurrentHead(
      predecessor,
      "ambiguous-handoff-intermediate",
    );
    const successor = await replaceClaudeCurrentHead(intermediate, "ambiguous-handoff-successor");

    expect(
      server.store.sqlite
        .prepare("SELECT state, error, updated_at FROM message_surface_attempts WHERE id = ?")
        .get(surface.id),
    ).toEqual(before);
    expect((await request<any>("GET", `/api/messages/${message.id}`)).body).toMatchObject({
      recipients: [{ recipientSessionId: successor.id, state: "PENDING" }],
    });
    expect(
      await request<any>("POST", `/api/messages/${message.id}/surface-attempts`, {
        sessionId: successor.id,
        idempotencyKey: "ambiguous-handoff-no-third-surface",
      }),
    ).toMatchObject({ status: 409, body: { code: "MESSAGE_SURFACE_IN_FLIGHT" } });
    expect(
      await request<any>(
        "POST",
        `/api/messages/${message.id}/authority-delivery/recover`,
        { session_id: successor.id },
        sessionToken(successor.id),
      ),
    ).toMatchObject({
      status: 409,
      body: {
        code: "AUTHORITY_DELIVERY_RECOVERY_UNCONFIRMED",
        current: {
          permit: {
            id: surface.id,
            sessionId: predecessor.id,
            recipientFence: surface.recipientFence,
            state: "AMBIGUOUS",
          },
          recoveredFor: {
            kind: "LINEAGE_HANDOFF",
            sessionId: successor.id,
            sessionIncarnation: successor.incarnation,
            lineageId: successor.lineageId,
          },
        },
      },
    });
    expect(
      await request<any>(
        "POST",
        `/api/messages/${message.id}/surface-attempts/${surface.id}/reconcile-ordinary`,
        {
          sessionId: successor.id,
          recipientFence: surface.recipientFence,
          externalThreadId: "ambiguous-handoff-wrong-thread",
          idempotencyKey: "ambiguous-handoff-wrong-thread",
        },
        sessionToken(successor.id),
      ),
    ).toMatchObject({
      status: 409,
      body: { code: "MESSAGE_SURFACE_RECONCILIATION_INVALID" },
    });
    const reconciled = await request<any>(
      "POST",
      `/api/messages/${message.id}/surface-attempts/${surface.id}/reconcile-ordinary`,
      {
        sessionId: successor.id,
        recipientFence: surface.recipientFence,
        externalThreadId: successor.externalThreadId,
        idempotencyKey: "ambiguous-handoff-reconcile",
      },
      sessionToken(successor.id),
    );
    expect(reconciled).toMatchObject({
      status: 200,
      body: { recipients: [{ recipientSessionId: successor.id, state: "DELIVERED" }] },
    });
    expect(
      await request<any>(
        "POST",
        `/api/messages/${message.id}/surface-attempts/${surface.id}/reconcile-ordinary`,
        {
          sessionId: successor.id,
          recipientFence: surface.recipientFence,
          externalThreadId: successor.externalThreadId,
          idempotencyKey: "ambiguous-handoff-reconcile",
        },
        sessionToken(successor.id),
      ),
    ).toEqual(reconciled);
    expect(
      server.store.sqlite
        .prepare("SELECT state, error, confirmed_at FROM message_surface_attempts WHERE id = ?")
        .get(surface.id),
    ).toMatchObject({ state: "CONFIRMED", error: null, confirmed_at: expect.any(String) });
    expect(
      server.store.sqlite
        .prepare(
          `SELECT COUNT(*) FROM message_deliveries
            WHERE recipient_id = ? AND session_id = ? AND state = 'DELIVERED'`,
        )
        .pluck()
        .get(surface.recipientId, predecessor.id),
    ).toBe(1);
    expect(
      await request<any>(
        "POST",
        `/api/messages/${message.id}/authority-delivery/recover`,
        { session_id: successor.id },
        sessionToken(successor.id),
      ),
    ).toMatchObject({
      status: 200,
      body: {
        permit: { id: surface.id, state: "CONFIRMED" },
        recoveredFor: { kind: "LINEAGE_HANDOFF", sessionId: successor.id },
      },
    });
    const restarted = await replaceClaudeCurrentHead(
      successor,
      "ambiguous-handoff-post-reconcile-restart",
    );
    expect((await request<any>("GET", `/api/messages/${message.id}`)).body).toMatchObject({
      recipients: [{ recipientSessionId: restarted.id, state: "DELIVERED" }],
    });
    expect(
      await request<any>(
        "POST",
        `/api/messages/${message.id}/authority-delivery/recover`,
        { session_id: restarted.id },
        sessionToken(restarted.id),
      ),
    ).toMatchObject({
      status: 200,
      body: {
        permit: { id: surface.id, state: "CONFIRMED" },
        recoveredFor: { kind: "LINEAGE_HANDOFF", sessionId: restarted.id },
      },
    });
    const restartedAgain = await replaceClaudeCurrentHead(
      restarted,
      "ambiguous-handoff-second-post-reconcile-restart",
    );
    expect((await request<any>("GET", `/api/messages/${message.id}`)).body).toMatchObject({
      recipients: [{ recipientSessionId: restartedAgain.id, state: "DELIVERED" }],
    });
    expect(
      server.store
        .listEvents(projectId, 0, 5000)
        .filter(
          (event) => event.type === "message.surface.ambiguous" && event.causationId === surface.id,
        ),
    ).toHaveLength(1);
    expect(
      server.store
        .listEvents(projectId, 0, 5000)
        .filter(
          (event) =>
            event.type === "message.surface.confirmed_handoff" && event.causationId === surface.id,
        ),
    ).toHaveLength(0);
    expect(
      server.store
        .listEvents(projectId, 0, 5000)
        .filter(
          (event) =>
            event.type === "message.surface.reconciled_handoff" && event.causationId === surface.id,
        ),
    ).toHaveLength(2);
    expect(
      server.store
        .listEvents(projectId, 0, 5000)
        .filter(
          (event) =>
            event.type === "message.surface.ambiguous_handoff" && event.causationId === surface.id,
        )
        .map((event) => event.payload),
    ).toEqual([
      expect.objectContaining({
        sessionId: predecessor.id,
        previousRecipientSessionId: predecessor.id,
        reboundToSessionId: intermediate.id,
      }),
      expect.objectContaining({
        sessionId: predecessor.id,
        previousRecipientSessionId: intermediate.id,
        reboundToSessionId: successor.id,
      }),
    ]);
    expect(
      server.store
        .listEvents(projectId, 0, 5000)
        .filter(
          (event) =>
            event.type === "message.surface.reconciled" && event.causationId === surface.id,
        ),
    ).toHaveLength(1);
    expect(
      server.store.sqlite
        .prepare("SELECT COUNT(*) FROM message_surface_attempts WHERE recipient_id = ?")
        .pluck()
        .get(surface.recipientId),
    ).toBe(1);
  });

  it("keeps authority-linked predecessor ambiguity outside ordinary reconciliation", async () => {
    const relay = (
      await register(
        "codex",
        "authority-ambiguity-relay",
        "authority-ambiguity-relay-session",
        "codex-cli-hooks",
      )
    ).body;
    const predecessor = (
      await register("claude", "authority-ambiguity-thread", "authority-ambiguity-predecessor")
    ).body;
    const directive = await relayAuthorityDirectiveToClaude(
      relay,
      "Do not downgrade signed authority during ambiguous recovery.",
      "authority-ambiguity",
    );
    const surface = (
      await request<any>(
        "POST",
        `/api/messages/${directive.carrierMessageId}/surface-attempts`,
        {
          sessionId: predecessor.id,
          idempotencyKey: "authority-ambiguity-surface",
        },
        sessionToken(predecessor.id),
      )
    ).body.permit;
    expect(
      await request<any>(
        "POST",
        `/api/messages/${directive.carrierMessageId}/surface-attempts/${surface.id}/state`,
        {
          sessionId: predecessor.id,
          state: "AMBIGUOUS",
          error: "authority transport outcome unknown",
          idempotencyKey: "authority-ambiguity-mark",
        },
        sessionToken(predecessor.id),
      ),
    ).toMatchObject({ status: 200, body: { permit: { state: "AMBIGUOUS" } } });
    const successor = await replaceClaudeCurrentHead(predecessor, "authority-ambiguity-successor");

    expect(
      await request<any>(
        "POST",
        `/api/messages/${directive.carrierMessageId}/surface-attempts/${surface.id}/reconcile-ordinary`,
        {
          sessionId: successor.id,
          recipientFence: surface.recipientFence,
          externalThreadId: successor.externalThreadId,
          idempotencyKey: "authority-ambiguity-reconcile-rejected",
        },
        sessionToken(successor.id),
      ),
    ).toMatchObject({
      status: 409,
      body: { code: "AUTHORITY_SURFACE_PERMIT_REQUIRED" },
    });
    expect(
      server.store.sqlite
        .prepare("SELECT state, confirmed_at FROM message_surface_attempts WHERE id = ?")
        .get(surface.id),
    ).toEqual({ state: "AMBIGUOUS", confirmed_at: null });
  });

  it("rolls the whole replacement back when an in-flight recipient cannot be rebound", async () => {
    const sender = (
      await register("codex", "rollback-handoff-sender", "rollback-handoff-sender-session")
    ).body;
    const predecessor = (
      await register("claude", "rollback-handoff-thread", "rollback-handoff-predecessor")
    ).body;
    const message = (
      await request<any>("POST", `/api/projects/${projectId}/messages`, {
        fromAgentId: "codex",
        fromSessionId: sender.id,
        recipients: [{ agentId: "claude", sessionId: predecessor.id }],
        type: "QUESTION",
        priority: "IMPORTANT",
        requiresAck: true,
        requiresResponse: true,
        summary: "Replacement rollback must restore every in-flight fact",
        idempotencyKey: "rollback-handoff-message",
      })
    ).body;
    const surface = (
      await request<any>("POST", `/api/messages/${message.id}/surface-attempts`, {
        sessionId: predecessor.id,
        idempotencyKey: "rollback-handoff-active",
      })
    ).body.permit;
    const prepared = await prepareClaudeCurrentHeadReplacement(
      predecessor,
      "rollback-handoff-successor",
    );
    const snapshot = () => ({
      sequence: (
        server.store.sqlite
          .prepare("SELECT current_sequence FROM projects WHERE id = ?")
          .get(projectId) as { current_sequence: number }
      ).current_sequence,
      sessions: Number(
        server.store.sqlite.prepare("SELECT COUNT(*) FROM agent_sessions").pluck().get(),
      ),
      events: Number(server.store.sqlite.prepare("SELECT COUNT(*) FROM events").pluck().get()),
      recipient: server.store.sqlite
        .prepare(
          "SELECT recipient_session_id, state, surface_fence FROM message_recipients WHERE id = ?",
        )
        .get(surface.recipientId),
      surface: server.store.sqlite
        .prepare(
          "SELECT state, error, updated_at, session_incarnation FROM message_surface_attempts WHERE id = ?",
        )
        .get(surface.id),
      head: server.store.sqlite
        .prepare("SELECT head_session_id, head_incarnation FROM session_lineages WHERE id = ?")
        .get(predecessor.lineageId),
      predecessor: server.store.sqlite
        .prepare(
          "SELECT connection_state, superseded_by_session_id FROM agent_sessions WHERE id = ?",
        )
        .get(predecessor.id),
      predecessorTicket: server.store.sqlite
        .prepare(
          "SELECT state FROM adapter_session_tickets WHERE hub_session_id = ? AND purpose = 'CONTROL'",
        )
        .get(predecessor.id),
      successorTicket: server.store.sqlite
        .prepare(
          "SELECT state, hub_session_id FROM adapter_session_tickets WHERE bundle_id = ? AND purpose = 'CONTROL'",
        )
        .get(prepared.bundleId),
      registrationKey: server.store.sqlite
        .prepare("SELECT 1 FROM idempotency_keys WHERE project_id = ? AND key = ?")
        .get(projectId, prepared.body.idempotencyKey),
    });
    server.store.sqlite
      .prepare("UPDATE message_surface_attempts SET session_incarnation = ? WHERE id = ?")
      .run(predecessor.incarnation + 1, surface.id);
    const beforeGuardFailure = snapshot();
    expect(
      await request<any>(
        "POST",
        `/api/projects/${projectId}/sessions`,
        prepared.body,
        prepared.control,
      ),
    ).toMatchObject({
      status: 409,
      body: { code: "SESSION_SURFACE_HANDOFF_INVALID" },
    });
    expect(snapshot()).toEqual(beforeGuardFailure);
    server.store.sqlite
      .prepare("UPDATE message_surface_attempts SET session_incarnation = ? WHERE id = ?")
      .run(predecessor.incarnation, surface.id);
    const before = snapshot();
    server.store.sqlite.exec(`
      CREATE TEMP TRIGGER fail_inflight_recipient_rebind
      BEFORE UPDATE OF recipient_session_id ON message_recipients
      WHEN OLD.id = '${surface.recipientId}' AND NEW.recipient_session_id <> OLD.recipient_session_id
      BEGIN
        SELECT RAISE(ABORT, 'injected in-flight recipient rebind failure');
      END;
    `);
    let failed: { status: number; body: any };
    try {
      failed = await request<any>(
        "POST",
        `/api/projects/${projectId}/sessions`,
        prepared.body,
        prepared.control,
      );
    } finally {
      server.store.sqlite.exec("DROP TRIGGER IF EXISTS fail_inflight_recipient_rebind");
    }
    expect(failed!).toMatchObject({ status: 500, body: { code: "INTERNAL_ERROR" } });
    expect(snapshot()).toEqual(before);

    const replay = await request<any>(
      "POST",
      `/api/projects/${projectId}/sessions`,
      prepared.body,
      prepared.control,
    );
    expect(replay).toMatchObject({
      status: 200,
      body: {
        session: { predecessorSessionId: predecessor.id },
        ticketBinding: { bundleId: prepared.bundleId, state: "ACTIVE" },
      },
    });
    const successor = replay.body.session;
    sessionTickets.set(successor.id, {
      bundleId: prepared.bundleId,
      client: "claude-channel",
      tokens: { CONTROL: prepared.control },
    });
    expect(
      server.store.sqlite
        .prepare("SELECT state FROM message_surface_attempts WHERE id = ?")
        .get(surface.id),
    ).toEqual({ state: "AMBIGUOUS" });
    expect((await request<any>("GET", `/api/messages/${message.id}`)).body).toMatchObject({
      recipients: [{ recipientSessionId: successor.id, state: "PENDING" }],
    });
    expect(
      await request<any>("POST", `/api/messages/${message.id}/surface-attempts`, {
        sessionId: successor.id,
        idempotencyKey: "rollback-handoff-no-third-surface",
      }),
    ).toMatchObject({ status: 409, body: { code: "MESSAGE_SURFACE_IN_FLIGHT" } });
    expect(
      server.store.sqlite
        .prepare("SELECT COUNT(*) FROM message_surface_attempts WHERE recipient_id = ?")
        .pluck()
        .get(surface.recipientId),
    ).toBe(1);
  });

  it("recovers one durable CONFIRMED surface across repeated current-head replacement", async () => {
    const sender = (
      await register("codex", "confirmed-handoff-sender", "confirmed-handoff-sender-session")
    ).body;
    const predecessor = (
      await register("claude", "confirmed-handoff-thread", "confirmed-handoff-predecessor")
    ).body;
    const confirmedMessage = (
      await request<any>("POST", `/api/projects/${projectId}/messages`, {
        fromAgentId: "codex",
        fromSessionId: sender.id,
        recipients: [{ agentId: "claude", sessionId: predecessor.id }],
        type: "QUESTION",
        priority: "IMPORTANT",
        requiresAck: true,
        requiresResponse: true,
        summary: "A durable confirmed surface survives Adapter restart",
        idempotencyKey: "confirmed-handoff-message",
      })
    ).body;
    const permit = await confirmMessageSurface(
      confirmedMessage.id,
      predecessor,
      "confirmed-handoff",
    );
    expect(
      await request<any>("POST", `/api/messages/${confirmedMessage.id}/ack`, {
        sessionId: predecessor.id,
        surfaceAttemptId: permit.id,
        recipientFence: permit.recipientFence,
        idempotencyKey: "confirmed-handoff-predecessor-ack",
      }),
    ).toMatchObject({ status: 200, body: { recipients: [{ state: "ACKNOWLEDGED" }] } });
    const legacyMessage = (
      await request<any>("POST", `/api/projects/${projectId}/messages`, {
        fromAgentId: "codex",
        fromSessionId: sender.id,
        recipients: [{ agentId: "claude", sessionId: predecessor.id }],
        type: "QUESTION",
        priority: "NORMAL",
        requiresAck: false,
        requiresResponse: false,
        summary: "Legacy delivery without a surface must remain replayable",
        idempotencyKey: "confirmed-handoff-legacy-message",
      })
    ).body;
    expect(
      await request<any>("POST", `/api/messages/${legacyMessage.id}/delivered`, {
        sessionId: predecessor.id,
        idempotencyKey: "confirmed-handoff-legacy-delivered",
      }),
    ).toMatchObject({ status: 200, body: { recipients: [{ state: "DELIVERED" }] } });
    const legacyAckMessage = (
      await request<any>("POST", `/api/projects/${projectId}/messages`, {
        fromAgentId: "codex",
        fromSessionId: sender.id,
        recipients: [{ agentId: "claude", sessionId: predecessor.id }],
        type: "QUESTION",
        priority: "NORMAL",
        requiresAck: true,
        requiresResponse: false,
        summary: "Legacy acknowledgement without a surface must remain replayable",
        idempotencyKey: "confirmed-handoff-legacy-ack-message",
      })
    ).body;
    expect(
      await request<any>("POST", `/api/messages/${legacyAckMessage.id}/ack`, {
        sessionId: predecessor.id,
        idempotencyKey: "confirmed-handoff-legacy-ack",
      }),
    ).toMatchObject({ status: 200, body: { recipients: [{ state: "ACKNOWLEDGED" }] } });

    const immutablePermit = server.store.sqlite
      .prepare("SELECT * FROM message_surface_attempts WHERE id = ?")
      .get(permit.id);
    const originalRecipient = server.store.sqlite
      .prepare(
        `SELECT state, delivered_at, acknowledged_at, attempt_count, surface_fence
           FROM message_recipients WHERE id = ?`,
      )
      .get(permit.recipientId);
    const originalDeliveryCount = Number(
      server.store.sqlite
        .prepare(
          `SELECT COUNT(*) FROM message_deliveries
            WHERE recipient_id = ? AND session_id = ? AND state = 'DELIVERED'`,
        )
        .pluck()
        .get(permit.recipientId, predecessor.id),
    );
    const successor = await replaceClaudeCurrentHead(predecessor, "confirmed-handoff-successor");
    const firstHandoff = server.store.sqlite
      .prepare(
        `SELECT id, payload_json FROM events
          WHERE project_id = ? AND type = 'message.surface.confirmed_handoff'
            AND aggregate_id = ? AND causation_id = ?
          ORDER BY sequence DESC LIMIT 1`,
      )
      .get(projectId, confirmedMessage.id, permit.id) as { id: string; payload_json: string };
    const firstHandoffRow = server.store.sqlite
      .prepare(
        `SELECT * FROM message_surface_handoffs
          WHERE project_id = ? AND message_id = ? AND surface_attempt_id = ?
            AND successor_session_id = ?`,
      )
      .get(projectId, confirmedMessage.id, permit.id, successor.id) as Record<string, unknown>;
    expect(firstHandoffRow).toMatchObject({
      project_id: projectId,
      message_id: confirmedMessage.id,
      recipient_id: permit.recipientId,
      surface_attempt_id: permit.id,
      lineage_id: predecessor.lineageId,
      source_surface_session_id: predecessor.id,
      predecessor_session_id: predecessor.id,
      successor_session_id: successor.id,
      source_surface_incarnation: predecessor.incarnation,
      predecessor_incarnation: predecessor.incarnation,
      successor_incarnation: successor.incarnation,
      recipient_fence: permit.recipientFence,
      event_id: firstHandoff.id,
    });
    expect(() =>
      server.store.sqlite
        .prepare(
          "UPDATE message_surface_handoffs SET recipient_fence = recipient_fence + 1 WHERE id = ?",
        )
        .run(firstHandoffRow.id),
    ).toThrow("message surface handoffs are immutable");
    expect(() =>
      server.store.sqlite
        .prepare("DELETE FROM message_surface_handoffs WHERE id = ?")
        .run(firstHandoffRow.id),
    ).toThrow("message surface handoffs cannot be deleted");
    const wrongLineage = (
      await register(
        "claude",
        "confirmed-handoff-wrong-lineage",
        "confirmed-handoff-wrong-lineage-session",
      )
    ).body;
    const finalPrepared = await prepareClaudeCurrentHeadReplacement(
      successor,
      "confirmed-handoff-final-head",
    );
    const finalRegistrationSnapshot = () => ({
      sequence: server.store.sqlite
        .prepare("SELECT current_sequence FROM projects WHERE id = ?")
        .get(projectId),
      sessions: server.store.sqlite.prepare("SELECT COUNT(*) AS count FROM agent_sessions").get(),
      events: server.store.sqlite.prepare("SELECT COUNT(*) AS count FROM events").get(),
      handoffs: server.store.sqlite
        .prepare("SELECT * FROM message_surface_handoffs ORDER BY id")
        .all(),
      recipient: server.store.sqlite
        .prepare("SELECT * FROM message_recipients WHERE id = ?")
        .get(permit.recipientId),
      head: server.store.sqlite
        .prepare("SELECT * FROM session_lineages WHERE id = ?")
        .get(successor.lineageId),
      ticket: server.store.sqlite
        .prepare(
          "SELECT state, hub_session_id FROM adapter_session_tickets WHERE bundle_id = ? AND purpose = 'CONTROL'",
        )
        .get(finalPrepared.bundleId),
      key: server.store.sqlite
        .prepare("SELECT 1 FROM idempotency_keys WHERE project_id = ? AND key = ?")
        .get(projectId, finalPrepared.body.idempotencyKey),
    });
    const expectFinalRegistrationRejectedWithoutMutation = async () => {
      const before = finalRegistrationSnapshot();
      expect(
        await request<any>(
          "POST",
          `/api/projects/${projectId}/sessions`,
          finalPrepared.body,
          finalPrepared.control,
        ),
      ).toMatchObject({
        status: 409,
        body: { code: "SESSION_SURFACE_HANDOFF_INVALID" },
      });
      expect(finalRegistrationSnapshot()).toEqual(before);
    };
    mutateImmutableTable(
      "message_surface_handoffs",
      "UPDATE message_surface_handoffs SET recipient_fence = recipient_fence + 1 WHERE id = ?",
      [firstHandoffRow.id],
    );
    await expectFinalRegistrationRejectedWithoutMutation();
    mutateImmutableTable(
      "message_surface_handoffs",
      "UPDATE message_surface_handoffs SET recipient_fence = ? WHERE id = ?",
      [firstHandoffRow.recipient_fence, firstHandoffRow.id],
    );
    mutateImmutableTable(
      "message_surface_handoffs",
      "UPDATE message_surface_handoffs SET successor_session_id = ? WHERE id = ?",
      [wrongLineage.id, firstHandoffRow.id],
    );
    await expectFinalRegistrationRejectedWithoutMutation();
    mutateImmutableTable(
      "message_surface_handoffs",
      "UPDATE message_surface_handoffs SET successor_session_id = ? WHERE id = ?",
      [firstHandoffRow.successor_session_id, firstHandoffRow.id],
    );
    mutateImmutableTable(
      "message_surface_handoffs",
      "UPDATE message_surface_handoffs SET lineage_id = ? WHERE id = ?",
      [wrongLineage.lineageId, firstHandoffRow.id],
    );
    await expectFinalRegistrationRejectedWithoutMutation();
    mutateImmutableTable(
      "message_surface_handoffs",
      "UPDATE message_surface_handoffs SET lineage_id = ? WHERE id = ?",
      [firstHandoffRow.lineage_id, firstHandoffRow.id],
    );
    mutateImmutableTable("events", "UPDATE events SET payload_json = ? WHERE id = ?", [
      JSON.stringify({
        ...JSON.parse(firstHandoff.payload_json),
        reboundToSessionId: "ses_tampered_prior_handoff",
      }),
      firstHandoff.id,
    ]);
    await expectFinalRegistrationRejectedWithoutMutation();
    mutateImmutableTable("events", "UPDATE events SET payload_json = ? WHERE id = ?", [
      firstHandoff.payload_json,
      firstHandoff.id,
    ]);
    const finalRegistered = await request<any>(
      "POST",
      `/api/projects/${projectId}/sessions`,
      finalPrepared.body,
      finalPrepared.control,
    );
    expect(finalRegistered).toMatchObject({ status: 200 });
    const finalHead = finalRegistered.body.session;
    sessionTickets.set(finalHead.id, {
      bundleId: finalPrepared.bundleId,
      client: "claude-channel",
      tokens: { CONTROL: finalPrepared.control },
    });

    expect(
      server.store.sqlite
        .prepare("SELECT * FROM message_surface_attempts WHERE id = ?")
        .get(permit.id),
    ).toEqual(immutablePermit);
    expect(
      server.store.sqlite
        .prepare(
          `SELECT state, delivered_at, acknowledged_at, attempt_count, surface_fence
             FROM message_recipients WHERE id = ?`,
        )
        .get(permit.recipientId),
    ).toEqual(originalRecipient);
    expect(
      (await request<any>("GET", `/api/messages/${confirmedMessage.id}`)).body.recipients[0],
    ).toMatchObject({ recipientSessionId: finalHead.id, state: "ACKNOWLEDGED" });
    expect(
      server.store.sqlite
        .prepare(
          `SELECT COUNT(*) FROM message_deliveries
            WHERE recipient_id = ? AND session_id = ? AND state = 'DELIVERED'`,
        )
        .pluck()
        .get(permit.recipientId, predecessor.id),
    ).toBe(originalDeliveryCount);
    const finalHandoff = server.store.sqlite
      .prepare(
        `SELECT id, payload_json FROM events
          WHERE project_id = ? AND type = 'message.surface.confirmed_handoff'
            AND aggregate_id = ? AND causation_id = ?
            AND json_extract(payload_json, '$.reboundToSessionId') = ?
          ORDER BY sequence DESC LIMIT 1`,
      )
      .get(projectId, confirmedMessage.id, permit.id, finalHead.id) as {
      id: string;
      payload_json: string;
    };
    const finalHandoffRow = server.store.sqlite
      .prepare("SELECT * FROM message_surface_handoffs WHERE event_id = ?")
      .get(finalHandoff.id) as Record<string, unknown>;
    expect(
      mutateImmutableTable(
        "message_surface_handoffs",
        "UPDATE message_surface_handoffs SET recipient_fence = recipient_fence + 1 WHERE id = ?",
        [finalHandoffRow.id],
      ),
    ).toBe(1);
    expect(
      server.store.sqlite
        .prepare("SELECT recipient_fence FROM message_surface_handoffs WHERE id = ?")
        .get(finalHandoffRow.id),
    ).toEqual({ recipient_fence: Number(finalHandoffRow.recipient_fence) + 1 });
    expect(
      await request<any>(
        "POST",
        `/api/messages/${confirmedMessage.id}/authority-delivery/recover`,
        { session_id: finalHead.id },
        sessionToken(finalHead.id),
      ),
    ).toMatchObject({
      status: 409,
      body: { code: "AUTHORITY_DELIVERY_RECOVERY_RECEIPT_MISSING" },
    });
    expect(
      mutateImmutableTable(
        "message_surface_handoffs",
        "UPDATE message_surface_handoffs SET recipient_fence = ? WHERE id = ?",
        [finalHandoffRow.recipient_fence, finalHandoffRow.id],
      ),
    ).toBe(1);
    mutateImmutableTable("events", "UPDATE events SET payload_json = ? WHERE id = ?", [
      JSON.stringify({
        ...JSON.parse(finalHandoff.payload_json),
        recipientFence: permit.recipientFence + 1,
      }),
      finalHandoff.id,
    ]);
    expect(
      await request<any>(
        "POST",
        `/api/messages/${confirmedMessage.id}/authority-delivery/recover`,
        { session_id: finalHead.id },
        sessionToken(finalHead.id),
      ),
    ).toMatchObject({
      status: 409,
      body: { code: "AUTHORITY_DELIVERY_RECOVERY_RECEIPT_MISSING" },
    });
    mutateImmutableTable("events", "UPDATE events SET payload_json = ? WHERE id = ?", [
      finalHandoff.payload_json,
      finalHandoff.id,
    ]);
    expect(
      await request<any>("POST", `/api/messages/${confirmedMessage.id}/surface-attempts`, {
        sessionId: finalHead.id,
        idempotencyKey: "confirmed-handoff-no-second-surface",
      }),
    ).toMatchObject({ status: 409, body: { code: "MESSAGE_ALREADY_SURFACED" } });
    const recovered = await request<any>(
      "POST",
      `/api/messages/${confirmedMessage.id}/authority-delivery/recover`,
      { session_id: finalHead.id },
      sessionToken(finalHead.id),
    );
    expect(recovered).toMatchObject({
      status: 200,
      body: {
        permit: { id: permit.id, sessionId: predecessor.id, state: "CONFIRMED" },
        recoveredFor: {
          kind: "LINEAGE_HANDOFF",
          sessionId: finalHead.id,
          sessionIncarnation: finalHead.incarnation,
          lineageId: finalHead.lineageId,
        },
      },
    });
    const recoveredDelivery =
      recovered.body.candidate?.kind === "AUTHORITY"
        ? recovered.body.candidate.bundle.delivery
        : recovered.body.candidate?.delivery;
    expect(recoveredDelivery).toMatchObject({
      carrierMessageId: confirmedMessage.id,
      surfaceAttemptId: permit.id,
      targetSessionId: predecessor.id,
      targetSessionIncarnation: predecessor.incarnation,
      recipientFence: permit.recipientFence,
    });
    expect(
      await request<any>("POST", `/api/messages/${legacyMessage.id}/surface-attempts`, {
        sessionId: finalHead.id,
        idempotencyKey: "confirmed-handoff-legacy-replay",
      }),
    ).toMatchObject({
      status: 200,
      body: { permit: { sessionId: finalHead.id, state: "ACTIVE" } },
    });
    expect(
      await request<any>("POST", `/api/messages/${legacyAckMessage.id}/surface-attempts`, {
        sessionId: finalHead.id,
        idempotencyKey: "confirmed-handoff-legacy-ack-replay",
      }),
    ).toMatchObject({
      status: 200,
      body: { permit: { sessionId: finalHead.id, state: "ACTIVE" } },
    });
    expect(
      server.store
        .listEvents(projectId, 0, 5000)
        .filter(
          (event) =>
            event.type === "message.surface.confirmed_handoff" &&
            event.aggregateId === confirmedMessage.id &&
            event.causationId === permit.id,
        ),
    ).toHaveLength(2);
    expect(
      server.store.sqlite
        .prepare(
          `SELECT source_surface_session_id, predecessor_session_id, successor_session_id,
                  source_surface_incarnation, predecessor_incarnation, successor_incarnation,
                  recipient_fence
             FROM message_surface_handoffs
            WHERE project_id = ? AND message_id = ? AND surface_attempt_id = ?
            ORDER BY successor_incarnation`,
        )
        .all(projectId, confirmedMessage.id, permit.id),
    ).toEqual([
      {
        source_surface_session_id: predecessor.id,
        predecessor_session_id: predecessor.id,
        successor_session_id: successor.id,
        source_surface_incarnation: predecessor.incarnation,
        predecessor_incarnation: predecessor.incarnation,
        successor_incarnation: successor.incarnation,
        recipient_fence: permit.recipientFence,
      },
      {
        source_surface_session_id: predecessor.id,
        predecessor_session_id: successor.id,
        successor_session_id: finalHead.id,
        source_surface_incarnation: predecessor.incarnation,
        predecessor_incarnation: successor.incarnation,
        successor_incarnation: finalHead.incarnation,
        recipient_fence: permit.recipientFence,
      },
    ]);

    const sibling = (
      await register("claude", "confirmed-handoff-sibling", "confirmed-handoff-sibling-session")
    ).body;
    expect(
      await request<any>(
        "POST",
        `/api/messages/${confirmedMessage.id}/authority-delivery/recover`,
        { session_id: sibling.id },
        sessionToken(sibling.id),
      ),
    ).toMatchObject({ status: 404 });

    const foreignDir = resolve(dirname(projectDir), "confirmed-handoff-foreign");
    mkdirSync(foreignDir);
    const foreignProject = (
      await request<any>("POST", "/api/projects/join", {
        cwd: foreignDir,
        allowCreate: true,
        name: "confirmed handoff foreign fixture",
      })
    ).body.project;
    const foreignSession = (
      await registerForProject(
        foreignProject.id,
        "claude",
        "confirmed-handoff-foreign-thread",
        "confirmed-handoff-foreign-session",
      )
    ).body;
    expect(
      await request<any>(
        "POST",
        `/api/messages/${confirmedMessage.id}/authority-delivery/recover`,
        { session_id: foreignSession.id },
        sessionToken(foreignSession.id),
      ),
    ).toMatchObject({ status: 404 });
  });

  it("rolls replacement back for every incomplete CONFIRMED provenance component", async () => {
    const relay = (
      await register(
        "codex",
        "confirmed-proof-relay",
        "confirmed-proof-relay-session",
        "codex-cli-hooks",
      )
    ).body;
    const predecessor = (
      await register("claude", "confirmed-proof-thread", "confirmed-proof-predecessor")
    ).body;
    const sender = (
      await register("codex", "confirmed-proof-sender", "confirmed-proof-sender-session")
    ).body;
    const genericMessage = (
      await request<any>("POST", `/api/projects/${projectId}/messages`, {
        fromAgentId: "codex",
        fromSessionId: sender.id,
        recipients: [{ agentId: "claude", sessionId: predecessor.id }],
        type: "QUESTION",
        priority: "IMPORTANT",
        requiresAck: true,
        requiresResponse: true,
        summary: "Every generic confirmed proof component is mandatory",
        idempotencyKey: "confirmed-proof-generic-message",
      })
    ).body;
    const genericPermit = await confirmMessageSurface(
      genericMessage.id,
      predecessor,
      "confirmed-proof-generic",
    );
    const directive = await relayAuthorityDirectiveToClaude(
      relay,
      "Preserve exact authority delivery evidence across restart.",
      "confirmed-proof-authority",
    );
    const authorityPermit = await confirmMessageSurface(
      directive.carrierMessageId,
      predecessor,
      "confirmed-proof-authority",
    );
    const prepared = await prepareClaudeCurrentHeadReplacement(
      predecessor,
      "confirmed-proof-successor",
    );
    const snapshot = () => ({
      sequence: server.store.sqlite
        .prepare("SELECT current_sequence FROM projects WHERE id = ?")
        .get(projectId),
      sessions: server.store.sqlite.prepare("SELECT COUNT(*) AS count FROM agent_sessions").get(),
      events: server.store.sqlite.prepare("SELECT COUNT(*) AS count FROM events").get(),
      authorityEvents: server.store.sqlite
        .prepare("SELECT COUNT(*) AS count FROM authority_events")
        .get(),
      handoffs: server.store.sqlite
        .prepare("SELECT * FROM message_surface_handoffs ORDER BY id")
        .all(),
      recipients: server.store.sqlite
        .prepare(
          `SELECT id, recipient_session_id, state, delivered_at, acknowledged_at,
                  attempt_count, surface_fence
             FROM message_recipients
            WHERE id IN (?, ?) ORDER BY id`,
        )
        .all(genericPermit.recipientId, authorityPermit.recipientId),
      surfaces: server.store.sqlite
        .prepare(
          `SELECT id, session_id, session_incarnation, recipient_fence, state,
                  error, updated_at, confirmed_at
             FROM message_surface_attempts
            WHERE id IN (?, ?) ORDER BY id`,
        )
        .all(genericPermit.id, authorityPermit.id),
      deliveries: server.store.sqlite
        .prepare(
          `SELECT id, recipient_id, session_id, state, completed_at
             FROM message_deliveries
            WHERE recipient_id IN (?, ?) ORDER BY id`,
        )
        .all(genericPermit.recipientId, authorityPermit.recipientId),
      head: server.store.sqlite
        .prepare("SELECT * FROM session_lineages WHERE id = ?")
        .get(predecessor.lineageId),
      predecessor: server.store.sqlite
        .prepare(
          "SELECT connection_state, superseded_by_session_id FROM agent_sessions WHERE id = ?",
        )
        .get(predecessor.id),
      successorTicket: server.store.sqlite
        .prepare(
          "SELECT state, hub_session_id FROM adapter_session_tickets WHERE bundle_id = ? AND purpose = 'CONTROL'",
        )
        .get(prepared.bundleId),
      registrationKey: server.store.sqlite
        .prepare("SELECT 1 FROM idempotency_keys WHERE project_id = ? AND key = ?")
        .get(projectId, prepared.body.idempotencyKey),
    });
    const expectRejectedWithoutMutation = async () => {
      const before = snapshot();
      expect(
        await request<any>(
          "POST",
          `/api/projects/${projectId}/sessions`,
          prepared.body,
          prepared.control,
        ),
      ).toMatchObject({
        status: 409,
        body: { code: "SESSION_SURFACE_HANDOFF_INVALID" },
      });
      expect(snapshot()).toEqual(before);
    };
    for (const invalidState of ["PENDING", "FAILED"] as const) {
      server.store.sqlite
        .prepare("UPDATE message_recipients SET state = ? WHERE id = ?")
        .run(invalidState, genericPermit.recipientId);
      await expectRejectedWithoutMutation();
      server.store.sqlite
        .prepare("UPDATE message_recipients SET state = 'DELIVERED' WHERE id = ?")
        .run(genericPermit.recipientId);
    }

    server.store.sqlite
      .prepare("UPDATE message_recipients SET surface_fence = surface_fence + 1 WHERE id = ?")
      .run(genericPermit.recipientId);
    await expectRejectedWithoutMutation();
    server.store.sqlite
      .prepare("UPDATE message_recipients SET surface_fence = ? WHERE id = ?")
      .run(genericPermit.recipientFence, genericPermit.recipientId);

    server.store.sqlite
      .prepare("UPDATE message_deliveries SET state = 'FAILED' WHERE recipient_id = ?")
      .run(genericPermit.recipientId);
    await expectRejectedWithoutMutation();
    server.store.sqlite
      .prepare("UPDATE message_deliveries SET state = 'DELIVERED' WHERE recipient_id = ?")
      .run(genericPermit.recipientId);

    const genericEvent = server.store.sqlite
      .prepare(
        `SELECT id, payload_json FROM events
          WHERE type = 'message.delivered' AND aggregate_id = ? ORDER BY sequence DESC LIMIT 1`,
      )
      .get(genericMessage.id) as { id: string; payload_json: string };
    mutateImmutableTable("events", "UPDATE events SET payload_json = ? WHERE id = ?", [
      JSON.stringify({
        ...JSON.parse(genericEvent.payload_json),
        surfaceAttemptId: "srf_tampered_confirmed_proof",
      }),
      genericEvent.id,
    ]);
    await expectRejectedWithoutMutation();
    mutateImmutableTable("events", "UPDATE events SET payload_json = ? WHERE id = ?", [
      genericEvent.payload_json,
      genericEvent.id,
    ]);

    const authorityReceipt = server.store.sqlite
      .prepare(
        `SELECT id, actor_session_id FROM authority_events
          WHERE directive_id = ? AND event_type = 'DELIVERED'`,
      )
      .get(directive.id) as { id: string; actor_session_id: string };
    mutateImmutableTable(
      "authority_events",
      "UPDATE authority_events SET actor_session_id = ? WHERE id = ?",
      [relay.id, authorityReceipt.id],
    );
    await expectRejectedWithoutMutation();
    mutateImmutableTable(
      "authority_events",
      "UPDATE authority_events SET actor_session_id = ? WHERE id = ?",
      [authorityReceipt.actor_session_id, authorityReceipt.id],
    );

    server.store.sqlite
      .prepare(
        `INSERT INTO message_surface_attempts(
           id, message_id, recipient_id, session_id, session_incarnation, recipient_fence,
           state, error, created_at, updated_at, confirmed_at
         )
         SELECT ?, message_id, recipient_id, session_id, session_incarnation,
                recipient_fence + 1, 'CONFIRMED', NULL, created_at, updated_at, confirmed_at
           FROM message_surface_attempts WHERE id = ?`,
      )
      .run("srf_confirmed_proof_duplicate", genericPermit.id);
    await expectRejectedWithoutMutation();
    server.store.sqlite
      .prepare("DELETE FROM message_surface_attempts WHERE id = ?")
      .run("srf_confirmed_proof_duplicate");

    const recovered = await request<any>(
      "POST",
      `/api/projects/${projectId}/sessions`,
      prepared.body,
      prepared.control,
    );
    expect(recovered).toMatchObject({ status: 200 });
  });

  it("continues ordinary and authority lifecycle on the current head without redelivering", async () => {
    const relay = (
      await register(
        "codex",
        "confirmed-lifecycle-relay",
        "confirmed-lifecycle-relay-session",
        "codex-cli-hooks",
      )
    ).body;
    const sender = (
      await register("codex", "confirmed-lifecycle-sender", "confirmed-lifecycle-sender-session")
    ).body;
    const predecessor = (
      await register("claude", "confirmed-lifecycle-thread", "confirmed-lifecycle-predecessor")
    ).body;
    const ordinary = (
      await request<any>("POST", `/api/projects/${projectId}/messages`, {
        fromAgentId: "codex",
        fromSessionId: sender.id,
        recipients: [{ agentId: "claude", sessionId: predecessor.id }],
        type: "QUESTION",
        priority: "IMPORTANT",
        requiresAck: true,
        requiresResponse: true,
        summary: "Continue ordinary lifecycle from immutable predecessor proof",
        idempotencyKey: "confirmed-lifecycle-ordinary-message",
      })
    ).body;
    const ordinaryPermit = await confirmMessageSurface(
      ordinary.id,
      predecessor,
      "confirmed-lifecycle-ordinary",
    );
    const directive = await relayAuthorityDirectiveToClaude(
      relay,
      "Continue the authenticated directive lifecycle after restart.",
      "confirmed-lifecycle-authority",
    );
    const authorityPermit = await confirmMessageSurface(
      directive.carrierMessageId,
      predecessor,
      "confirmed-lifecycle-authority",
    );
    const deliveryCountBefore = Number(
      server.store.sqlite
        .prepare(
          `SELECT COUNT(*) FROM message_deliveries
            WHERE recipient_id IN (?, ?) AND state = 'DELIVERED'`,
        )
        .pluck()
        .get(ordinaryPermit.recipientId, authorityPermit.recipientId),
    );
    const successor = await replaceClaudeCurrentHead(predecessor, "confirmed-lifecycle-successor");
    expect(
      server.store.sqlite
        .prepare("UPDATE message_recipients SET surface_fence = surface_fence + 1 WHERE id = ?")
        .run(authorityPermit.recipientId).changes,
    ).toBe(1);
    expect(
      server.store.sqlite
        .prepare(
          `SELECT surface.session_id, surface.recipient_fence AS immutable_fence,
                  recipient.recipient_session_id, recipient.surface_fence AS current_fence
             FROM message_surface_attempts AS surface
             JOIN message_recipients AS recipient ON recipient.id = surface.recipient_id
            WHERE surface.id = ?`,
        )
        .get(authorityPermit.id),
    ).toEqual({
      session_id: predecessor.id,
      immutable_fence: authorityPermit.recipientFence,
      recipient_session_id: successor.id,
      current_fence: authorityPermit.recipientFence + 1,
    });
    for (const eventType of ["ACKNOWLEDGED", "PROCESSED"] as const) {
      expectDirectAuthorityReceiptRejected({
        directive,
        permit: authorityPermit,
        actorSessionId: successor.id,
        eventType,
        suffix: `stale_fence_${eventType.toLowerCase()}`,
      });
    }
    expect(
      server.store.sqlite
        .prepare("UPDATE message_recipients SET surface_fence = ? WHERE id = ?")
        .run(authorityPermit.recipientFence, authorityPermit.recipientId).changes,
    ).toBe(1);

    const finalHead = await replaceClaudeCurrentHead(successor, "confirmed-lifecycle-final-head");
    for (const eventType of ["ACKNOWLEDGED", "PROCESSED"] as const) {
      expectDirectAuthorityReceiptRejected({
        directive,
        permit: authorityPermit,
        actorSessionId: successor.id,
        eventType,
        suffix: `stale_head_${eventType.toLowerCase()}`,
      });
    }
    for (const [messageId, permit, suffix] of [
      [ordinary.id, ordinaryPermit, "ordinary"],
      [directive.carrierMessageId, authorityPermit, "authority"],
    ] as const) {
      expect(
        await request<any>("POST", `/api/messages/${messageId}/ack`, {
          sessionId: finalHead.id,
          surfaceAttemptId: permit.id,
          recipientFence: permit.recipientFence,
          idempotencyKey: `confirmed-lifecycle-${suffix}-ack`,
        }),
      ).toMatchObject({
        status: 200,
        body: { recipients: [{ recipientSessionId: finalHead.id, state: "ACKNOWLEDGED" }] },
      });
      expect(
        await request<any>("POST", `/api/messages/${messageId}/processed`, {
          sessionId: finalHead.id,
          surfaceAttemptId: permit.id,
          recipientFence: permit.recipientFence,
          idempotencyKey: `confirmed-lifecycle-${suffix}-processed`,
        }),
      ).toMatchObject({
        status: 200,
        body: { recipients: [{ recipientSessionId: finalHead.id, state: "PROCESSED" }] },
      });
    }
    expect(
      server.store.sqlite
        .prepare(
          `SELECT COUNT(*) FROM message_deliveries
            WHERE recipient_id IN (?, ?) AND state = 'DELIVERED'`,
        )
        .pluck()
        .get(ordinaryPermit.recipientId, authorityPermit.recipientId),
    ).toBe(deliveryCountBefore);
    expect(
      server.store.sqlite
        .prepare(
          `SELECT event_type, actor_session_id FROM authority_events
            WHERE directive_id = ? AND event_type IN ('DELIVERED', 'ACKNOWLEDGED', 'PROCESSED')
            ORDER BY server_sequence`,
        )
        .all(directive.id),
    ).toEqual([
      { event_type: "DELIVERED", actor_session_id: predecessor.id },
      { event_type: "ACKNOWLEDGED", actor_session_id: finalHead.id },
      { event_type: "PROCESSED", actor_session_id: finalHead.id },
    ]);
    expect(
      server.store.sqlite
        .prepare("SELECT COUNT(*) FROM message_surface_attempts WHERE recipient_id IN (?, ?)")
        .pluck()
        .get(ordinaryPermit.recipientId, authorityPermit.recipientId),
    ).toBe(2);
  });

  it("allows exactly one live session to claim an agent-wide recipient before delivery", async () => {
    const first = (await register("codex", "desktop-thread-a", "claim-session-a")).body;
    const second = (await register("codex", "desktop-thread-b", "claim-session-b")).body;
    const claude = (await register("claude", "claude-thread", "claim-claude")).body;
    const message = (
      await request<any>("POST", `/api/projects/${projectId}/messages`, {
        fromAgentId: "claude",
        fromSessionId: claude.id,
        recipients: [{ agentId: "codex" }],
        type: "QUESTION",
        priority: "IMPORTANT",
        requiresAck: true,
        requiresResponse: true,
        summary: "Only one Desktop thread may surface this",
        idempotencyKey: "agent-wide-message",
      })
    ).body;

    const claims = await Promise.all(
      [first, second].map((session, index) =>
        request<any>("POST", `/api/messages/${message.id}/claim`, {
          sessionId: session.id,
          idempotencyKey: `claim-agent-wide-${index}`,
        }),
      ),
    );
    const winner = claims.find((claim) => claim.status === 200);
    const loser = claims.find((claim) => claim.status === 409);

    expect(winner).toBeDefined();
    expect(loser?.body).toMatchObject({ code: "MESSAGE_RECIPIENT_CLAIMED" });
    const claimedRecipient = winner!.body.recipients[0];
    expect(claimedRecipient).toMatchObject({
      recipientAgentId: "codex",
      state: "PENDING",
    });
    expect([first.id, second.id]).toContain(claimedRecipient.recipientSessionId);

    const winningSessionId = claimedRecipient.recipientSessionId;
    const losingSessionId = winningSessionId === first.id ? second.id : first.id;
    expect(
      await request<any>("POST", `/api/messages/${message.id}/claim`, {
        sessionId: winningSessionId,
        idempotencyKey: "winning-claim-repeat",
      }),
    ).toMatchObject({
      status: 200,
      body: {
        recipients: [
          expect.objectContaining({
            recipientSessionId: winningSessionId,
          }),
        ],
      },
    });
    expect(
      await request<any>("POST", `/api/messages/${message.id}/claim`, {
        sessionId: claude.id,
        idempotencyKey: "wrong-agent-claim",
      }),
    ).toMatchObject({ status: 403, body: { code: "FORBIDDEN" } });
    expect(
      await request<any>("POST", `/api/messages/${message.id}/delivered`, {
        sessionId: winningSessionId,
        idempotencyKey: "winning-delivery",
      }),
    ).toMatchObject({ status: 200 });
    expect(
      await request<any>("POST", `/api/messages/${message.id}/delivered`, {
        sessionId: losingSessionId,
        idempotencyKey: "losing-delivery",
      }),
    ).toMatchObject({ status: 403 });
  });

  it("revalidates a cached claim after same-thread replacement", async () => {
    const predecessor = (await register("codex", "claim-replay-thread", "claim-replay-predecessor"))
      .body;
    const claude = (await register("claude", "claim-replay-claude", "claim-replay-claude-session"))
      .body;
    const message = (
      await request<any>("POST", `/api/projects/${projectId}/messages`, {
        fromAgentId: "claude",
        fromSessionId: claude.id,
        recipients: [{ agentId: "codex" }],
        type: "QUESTION",
        priority: "IMPORTANT",
        requiresAck: true,
        requiresResponse: true,
        summary: "A cached claim is not current ownership proof",
        idempotencyKey: "claim-replay-message",
      })
    ).body;
    const claimBody = {
      sessionId: predecessor.id,
      idempotencyKey: "claim-replay-key",
    };

    expect(
      await request<any>("POST", `/api/messages/${message.id}/claim`, claimBody),
    ).toMatchObject({ status: 200 });
    const successor = (await register("codex", "claim-replay-thread", "claim-replay-successor"))
      .body;

    expect(
      await request<any>("POST", `/api/messages/${message.id}/claim`, claimBody),
    ).toMatchObject({ status: 403, body: { code: "FORBIDDEN" } });
    expect(
      (await request<any>("GET", `/api/messages/${message.id}`)).body.recipients[0],
    ).toMatchObject({
      recipientSessionId: successor.id,
      state: "PENDING",
    });
  });

  it("rejects reusing one surface idempotency key for another message", async () => {
    const codex = (await register("codex", "surface-key-thread", "surface-key-codex")).body;
    const claude = (await register("claude", "surface-key-claude", "surface-key-claude-session"))
      .body;
    const post = (summary: string, idempotencyKey: string) =>
      request<any>("POST", `/api/projects/${projectId}/messages`, {
        fromAgentId: "claude",
        fromSessionId: claude.id,
        recipients: [{ agentId: "codex", sessionId: codex.id }],
        type: "QUESTION",
        priority: "IMPORTANT",
        requiresAck: true,
        requiresResponse: true,
        summary,
        idempotencyKey,
      });
    const first = (await post("first surface", "surface-key-message-a")).body;
    const second = (await post("second surface", "surface-key-message-b")).body;
    const beginBody = {
      sessionId: codex.id,
      idempotencyKey: "shared-surface-key",
    };

    expect(
      await request<any>("POST", `/api/messages/${first.id}/surface-attempts`, beginBody),
    ).toMatchObject({ status: 200 });
    expect(
      await request<any>("POST", `/api/messages/${second.id}/surface-attempts`, beginBody),
    ).toMatchObject({ status: 409, body: { code: "VERSION_CONFLICT" } });
    expect(
      server.store.sqlite
        .prepare("SELECT COUNT(*) AS count FROM message_surface_attempts WHERE message_id = ?")
        .get(second.id),
    ).toEqual({ count: 0 });
  });

  it("does not replay a stale ACTIVE permit after that exact surface attempt was aborted", async () => {
    const codex = (await register("codex", "surface-replay-thread", "surface-replay-codex")).body;
    const claude = (
      await register("claude", "surface-replay-claude", "surface-replay-claude-session")
    ).body;
    const message = (
      await request<any>("POST", `/api/projects/${projectId}/messages`, {
        fromAgentId: "claude",
        fromSessionId: claude.id,
        recipients: [{ agentId: "codex", sessionId: codex.id }],
        type: "QUESTION",
        priority: "IMPORTANT",
        requiresAck: true,
        requiresResponse: true,
        summary: "A cached permit must reflect its durable state",
        idempotencyKey: "surface-replay-message",
      })
    ).body;
    const beginBody = {
      sessionId: codex.id,
      idempotencyKey: "surface-replay-begin",
    };
    const first = await request<any>(
      "POST",
      `/api/messages/${message.id}/surface-attempts`,
      beginBody,
    );
    expect(first).toMatchObject({ status: 200, body: { permit: { state: "ACTIVE" } } });

    expect(
      await request<any>(
        "POST",
        `/api/messages/${message.id}/surface-attempts/${first.body.permit.id}/state`,
        {
          sessionId: codex.id,
          state: "ABORTED",
          error: "proven pre-side-effect rejection",
          idempotencyKey: "surface-replay-abort",
        },
      ),
    ).toMatchObject({ status: 200, body: { permit: { state: "ABORTED" } } });

    expect(
      await request<any>("POST", `/api/messages/${message.id}/surface-attempts`, beginBody),
    ).toMatchObject({ status: 409, body: { code: "SURFACE_PERMIT_SETTLED" } });
  });

  it("keeps acknowledgement monotonic when a late FAILED frame arrives", async () => {
    const codex = (await register("codex", "late-failed-thread", "late-failed-codex")).body;
    const claude = (await register("claude", "late-failed-claude", "late-failed-claude-session"))
      .body;
    const message = (
      await request<any>("POST", `/api/projects/${projectId}/messages`, {
        fromAgentId: "claude",
        fromSessionId: claude.id,
        recipients: [{ agentId: "codex", sessionId: codex.id }],
        type: "QUESTION",
        priority: "IMPORTANT",
        requiresAck: true,
        requiresResponse: true,
        summary: "A downstream acknowledgement is terminal evidence for this attempt",
        idempotencyKey: "late-failed-message",
      })
    ).body;
    expect(
      await request<any>("POST", `/api/messages/${message.id}/surface-attempts`, {
        sessionId: codex.id,
        idempotencyKey: "late-failed-surface",
      }),
    ).toMatchObject({ status: 200, body: { permit: { state: "ACTIVE" } } });

    expect(
      await request<any>("POST", `/api/messages/${message.id}/ack`, {
        sessionId: codex.id,
        idempotencyKey: "late-failed-ack",
      }),
    ).toMatchObject({ status: 200, body: { recipients: [{ state: "ACKNOWLEDGED" }] } });
    const principal = new CredentialRegistry(server.store.sqlite, server.credentials).authenticate(
      {
        headers: { authorization: `Bearer ${sessionToken(codex.id)}` },
        query: {},
      } as FastifyRequest,
      ["hub:session"],
    );
    expect(
      server.store.updateMessageState(principal, message.id, {
        sessionId: codex.id,
        state: "FAILED",
        error: "retired transport emitted a late error",
        idempotencyKey: "late-failed-frame",
      }),
    ).toMatchObject({ recipients: [{ state: "ACKNOWLEDGED" }] });
    expect(
      await request<any>("POST", `/api/messages/${message.id}/surface-attempts`, {
        sessionId: codex.id,
        idempotencyKey: "late-failed-second-surface",
      }),
    ).toMatchObject({ status: 409, body: { code: "MESSAGE_ALREADY_SURFACED" } });
  });

  it("binds message posting and cached replays to the live sender session", async () => {
    const claude = (await register("claude", "post-sender-thread", "post-sender-session")).body;
    const body = {
      fromAgentId: "claude",
      fromSessionId: claude.id,
      recipients: [{ agentId: "codex" }],
      type: "QUESTION",
      priority: "IMPORTANT",
      requiresAck: true,
      requiresResponse: true,
      summary: "Sender provenance is part of the idempotent operation",
      idempotencyKey: "post-sender-key",
    };
    const posted = await request<any>("POST", `/api/projects/${projectId}/messages`, body);
    expect(posted).toMatchObject({ status: 200 });

    expect(
      await request<any>("POST", `/api/projects/${projectId}/messages`, {
        ...body,
        summary: "Same key, different message",
      }),
    ).toMatchObject({ status: 409, body: { code: "VERSION_CONFLICT" } });

    expect(
      await request<any>(
        "POST",
        `/api/projects/${projectId}/messages`,
        {
          ...body,
          fromSessionId: undefined,
          idempotencyKey: "post-sender-missing-session",
        },
        sessionToken(claude.id),
      ),
    ).toMatchObject({ status: 403, body: { code: "FORBIDDEN" } });

    const foreignDir = resolve(projectDir, "foreign-sender-project");
    mkdirSync(foreignDir);
    const foreignProject = (
      await request<any>(
        "POST",
        "/api/projects/join",
        {
          cwd: foreignDir,
          allowCreate: true,
          name: "foreign sender fixture",
        },
        server.credentials.dashboard.token,
      )
    ).body.project;
    const foreignClaude = (
      await registerForProject(
        foreignProject.id,
        "claude",
        "foreign-sender-thread",
        "foreign-sender-session",
      )
    ).body;
    expect(
      await request<any>("POST", `/api/projects/${projectId}/messages`, {
        ...body,
        fromSessionId: foreignClaude.id,
        idempotencyKey: "post-sender-cross-project",
      }),
    ).toMatchObject({ status: 403, body: { code: "PROJECT_NOT_AUTHORIZED" } });

    server.store.closeSession(claude.id, "sender replay test");
    expect(await request<any>("POST", `/api/projects/${projectId}/messages`, body)).toMatchObject({
      status: 403,
      body: { code: "FORBIDDEN" },
    });
  });

  it("keeps task handoff atomic at the live-owner and idempotency seams", async () => {
    const createClaimedTask = async (suffix: string, ownerSessionId: string) => {
      const created = (
        await request<any>("POST", `/api/projects/${projectId}/tasks`, {
          objectiveId,
          milestoneId: null,
          parentTaskId: null,
          title: `Handoff fixture ${suffix}`,
          description: "",
          status: "READY",
          priority: "high",
          reviewerAgentId: "claude",
          capabilityTags: [],
          scopeGlobs: [`${suffix}/**`],
          protectedScope: true,
          reviewRequired: true,
          dependsOn: [],
          weight: 1,
          idempotencyKey: `handoff-task-${suffix}`,
        })
      ).body;
      return (
        await request<any>("POST", `/api/tasks/${created.id}/claim`, {
          sessionId: ownerSessionId,
          expectedVersion: created.version,
          takeoverStale: false,
          idempotencyKey: `handoff-claim-${suffix}`,
        })
      ).body;
    };

    const closedOwner = (await register("codex", "handoff-closed-thread", "handoff-closed-owner"))
      .body;
    const closedTask = await createClaimedTask("closed-owner", closedOwner.id);
    server.store.closeSession(closedOwner.id, "handoff owner closed before request");

    expect(
      await request<any>("POST", `/api/tasks/${closedTask.id}/handoff`, {
        sessionId: closedOwner.id,
        expectedVersion: closedTask.version,
        toAgentId: "claude",
        summary: "This must not commit from a closed owner",
        idempotencyKey: "handoff-closed-key",
      }),
    ).toMatchObject({ status: 403, body: { code: "FORBIDDEN" } });
    expect((await request<any>("GET", `/api/tasks/${closedTask.id}`)).body).toMatchObject({
      status: closedTask.status,
      ownerAgentId: "codex",
      ownerSessionId: closedOwner.id,
      version: closedTask.version,
    });

    const collisionOwner = (
      await register("codex", "handoff-collision-thread", "handoff-collision-owner")
    ).body;
    const collisionTask = await createClaimedTask("message-collision", collisionOwner.id);
    expect(
      await request<any>("POST", `/api/projects/${projectId}/messages`, {
        fromAgentId: "codex",
        fromSessionId: collisionOwner.id,
        recipients: [{ agentId: "claude" }],
        type: "STATUS",
        priority: "NORMAL",
        requiresAck: false,
        requiresResponse: false,
        summary: "Occupy the downstream handoff key",
        idempotencyKey: "handoff-collision-key:message",
      }),
    ).toMatchObject({ status: 200 });
    expect(
      await request<any>("POST", `/api/tasks/${collisionTask.id}/handoff`, {
        sessionId: collisionOwner.id,
        expectedVersion: collisionTask.version,
        toAgentId: "claude",
        summary: "The downstream collision must roll back this task mutation",
        idempotencyKey: "handoff-collision-key",
      }),
    ).toMatchObject({ status: 409, body: { code: "VERSION_CONFLICT" } });
    expect((await request<any>("GET", `/api/tasks/${collisionTask.id}`)).body).toMatchObject({
      status: collisionTask.status,
      ownerSessionId: collisionOwner.id,
      version: collisionTask.version,
    });

    const rollbackOwner = (
      await register("codex", "handoff-rollback-thread", "handoff-rollback-owner")
    ).body;
    const rollbackTask = await createClaimedTask("outer-rollback", rollbackOwner.id);
    const published: Array<{ aggregateId: string; type: string }> = [];
    const unsubscribe = server.bus.subscribe(projectId, (event) => published.push(event));
    server.store.sqlite.exec(`
      CREATE TEMP TRIGGER fail_outer_handoff_idempotency
      BEFORE INSERT ON idempotency_keys
      WHEN NEW.key = 'handoff-outer-failure-key'
      BEGIN
        SELECT RAISE(ABORT, 'forced outer handoff failure');
      END;
    `);
    try {
      expect(
        await request<any>("POST", `/api/tasks/${rollbackTask.id}/handoff`, {
          sessionId: rollbackOwner.id,
          expectedVersion: rollbackTask.version,
          toAgentId: "claude",
          summary: "Nested message and events must roll back with the task",
          idempotencyKey: "handoff-outer-failure-key",
        }),
      ).toMatchObject({ status: 500 });
    } finally {
      server.store.sqlite.exec("DROP TRIGGER fail_outer_handoff_idempotency");
      unsubscribe();
    }
    expect((await request<any>("GET", `/api/tasks/${rollbackTask.id}`)).body).toMatchObject({
      status: rollbackTask.status,
      ownerSessionId: rollbackOwner.id,
      version: rollbackTask.version,
    });
    expect(
      server.store.sqlite
        .prepare("SELECT COUNT(*) AS count FROM messages WHERE summary = ?")
        .get("Nested message and events must roll back with the task"),
    ).toEqual({ count: 0 });
    expect(
      published.filter(
        (event) => event.aggregateId === rollbackTask.id || event.type === "message.posted",
      ),
    ).toEqual([]);

    const liveOwner = (await register("codex", "handoff-live-thread", "handoff-live-owner")).body;
    const liveTask = await createClaimedTask("fingerprint", liveOwner.id);
    const handoffBody = {
      sessionId: liveOwner.id,
      expectedVersion: liveTask.version,
      toAgentId: "claude",
      summary: "Original handoff",
      idempotencyKey: "handoff-fingerprint-key",
    };
    const handedOff = await request<any>("POST", `/api/tasks/${liveTask.id}/handoff`, handoffBody);
    expect(handedOff).toMatchObject({
      status: 200,
      body: { status: "WAITING_FOR_PEER", waitingFor: "claude" },
    });

    // Remove the downstream message cache so this assertion is carried by task.handoff itself,
    // rather than accidentally relying on postMessage's independent fingerprint.
    server.store.sqlite
      .prepare("DELETE FROM idempotency_keys WHERE project_id = ? AND key = ?")
      .run(projectId, `${handoffBody.idempotencyKey}:message`);
    expect(
      await request<any>("POST", `/api/tasks/${liveTask.id}/handoff`, {
        ...handoffBody,
        toAgentId: "reviewer-shadow",
        summary: "Same key, different handoff",
      }),
    ).toMatchObject({ status: 409, body: { code: "VERSION_CONFLICT" } });
    expect(
      await request<any>("POST", `/api/tasks/${liveTask.id}/handoff`, handoffBody),
    ).toMatchObject({
      status: 200,
      body: { id: liveTask.id, waitingFor: "claude" },
    });
  });

  it("treats heartbeat task and review ids as telemetry, not ownership authority", async () => {
    const owner = (await register("codex", "projection-owner-thread", "projection-owner")).body;
    const observer = (await register("claude", "projection-observer-thread", "projection-observer"))
      .body;
    const created = (
      await request<any>("POST", `/api/projects/${projectId}/tasks`, {
        objectiveId,
        milestoneId: null,
        parentTaskId: null,
        title: "Authoritative task projection",
        description: "",
        status: "READY",
        priority: "high",
        reviewerAgentId: "claude",
        capabilityTags: [],
        scopeGlobs: ["projection/**"],
        protectedScope: true,
        reviewRequired: true,
        dependsOn: [],
        weight: 1,
        idempotencyKey: "projection-task",
      })
    ).body;
    const claimed = (
      await request<any>("POST", `/api/tasks/${created.id}/claim`, {
        sessionId: owner.id,
        expectedVersion: created.version,
        takeoverStale: false,
        idempotencyKey: "projection-claim",
      })
    ).body;

    const heartbeat = await request<any>("POST", `/api/sessions/${observer.id}/heartbeat`, {
      sequence: 1,
      workState: "WORKING",
      currentTaskId: claimed.id,
      currentReviewId: "rev_untrusted_telemetry",
      activeFiles: [],
      queueDepth: 0,
    });
    expect(heartbeat).toMatchObject({
      status: 200,
      body: { currentTaskId: null, currentReviewId: null, workState: "WORKING" },
    });
    expect(server.store.getSession(owner.id)).toMatchObject({ currentTaskId: claimed.id });
    expect(server.store.getTask(claimed.id)).toMatchObject({ ownerSessionId: owner.id });
  });

  it("keeps unclaimed agent-wide mail out of read-only context packs", async () => {
    const first = (await register("codex", "context-thread-a", "context-session-a")).body;
    const second = (await register("codex", "context-thread-b", "context-session-b")).body;
    const claude = (await register("claude", "context-claude", "context-claude-session")).body;
    const message = (
      await request<any>("POST", `/api/projects/${projectId}/messages`, {
        fromAgentId: "claude",
        fromSessionId: claude.id,
        recipients: [{ agentId: "codex" }],
        type: "QUESTION",
        priority: "IMPORTANT",
        requiresAck: true,
        requiresResponse: true,
        summary: "Context belongs to exactly one logical worker",
        idempotencyKey: "context-agent-wide-message",
      })
    ).body;

    const contextFor = (sessionId: string) =>
      request<any>("POST", "/api/context-pack", {
        sessionId,
        files: [],
        symbols: [],
        maxChars: 12000,
      });
    const [unclaimedFirst, unclaimedSecond] = await Promise.all([
      contextFor(first.id),
      contextFor(second.id),
    ]);

    expect(unclaimedFirst.body.inbox).toEqual([]);
    expect(unclaimedSecond.body.inbox).toEqual([]);
    expect(unclaimedFirst.body.text).not.toContain(message.id);
    expect(unclaimedSecond.body.text).not.toContain(message.id);

    await request<any>("POST", `/api/messages/${message.id}/claim`, {
      sessionId: first.id,
      idempotencyKey: "context-first-claim",
    });
    const [claimedFirst, losingSecond] = await Promise.all([
      contextFor(first.id),
      contextFor(second.id),
    ]);

    expect(claimedFirst.body.inbox).toEqual([
      expect.objectContaining({
        id: message.id,
        recipients: [
          expect.objectContaining({
            recipientSessionId: first.id,
          }),
        ],
      }),
    ]);
    expect(claimedFirst.body.text).toContain(message.id);
    expect(losingSecond.body.inbox).toEqual([]);
    expect(losingSecond.body.text).not.toContain(message.id);
  });

  it("does not let a closed session claim new agent-wide mail", async () => {
    const closed = (await register("codex", "closed-thread", "closed-session")).body;
    const claude = (await register("claude", "claude-thread", "closed-claim-claude")).body;
    expect(
      await request<any>("POST", `/api/sessions/${closed.id}/close`, {
        reason: "test_closed",
        idempotencyKey: "close-closed-session",
      }),
    ).toMatchObject({ status: 200 });
    const message = (
      await request<any>("POST", `/api/projects/${projectId}/messages`, {
        fromAgentId: "claude",
        fromSessionId: claude.id,
        recipients: [{ agentId: "codex" }],
        type: "QUESTION",
        priority: "IMPORTANT",
        requiresAck: true,
        requiresResponse: true,
        summary: "Closed sessions cannot take fresh work",
        idempotencyKey: "closed-session-message",
      })
    ).body;

    expect(
      await request<any>("POST", `/api/messages/${message.id}/claim`, {
        sessionId: closed.id,
        idempotencyKey: "closed-session-claim",
      }),
    ).toMatchObject({ status: 403, body: { code: "FORBIDDEN" } });
    expect(
      await request<any>("POST", `/api/messages/${message.id}/delivered`, {
        sessionId: closed.id,
        idempotencyKey: "closed-session-legacy-delivery",
      }),
    ).toMatchObject({ status: 403, body: { code: "FORBIDDEN" } });
    expect(
      (await request<any>("GET", `/api/messages/${message.id}`)).body.recipients[0],
    ).toMatchObject({
      recipientSessionId: null,
      state: "PENDING",
    });
  });

  it("requires an open session to revalidate pinned mail before surface", async () => {
    const pinned = (await register("codex", "pinned-thread", "pinned-session")).body;
    const claude = (await register("claude", "pinned-claude", "pinned-claude-session")).body;
    const message = (
      await request<any>("POST", `/api/projects/${projectId}/messages`, {
        fromAgentId: "claude",
        fromSessionId: claude.id,
        recipients: [{ agentId: "codex", sessionId: pinned.id }],
        type: "QUESTION",
        priority: "IMPORTANT",
        requiresAck: true,
        requiresResponse: true,
        summary: "A cached pinned row is not proof that its session is still live",
        idempotencyKey: "closed-pinned-message",
      })
    ).body;
    expect(
      await request<any>("POST", `/api/sessions/${pinned.id}/close`, {
        reason: "test_pinned_closed",
        idempotencyKey: "close-pinned-session",
      }),
    ).toMatchObject({ status: 200 });

    expect(
      await request<any>("POST", `/api/messages/${message.id}/claim`, {
        sessionId: pinned.id,
        idempotencyKey: "closed-pinned-claim",
      }),
    ).toMatchObject({ status: 403, body: { code: "FORBIDDEN" } });
    // A closed session ticket cannot be reused as a post-close delivery capability either.
    expect(
      await request<any>("POST", `/api/messages/${message.id}/delivered`, {
        sessionId: pinned.id,
        idempotencyKey: "closed-pinned-inflight-delivery",
      }),
    ).toMatchObject({ status: 403, body: { code: "FORBIDDEN" } });
  });

  it("does not let a same-agent session from another project claim or deliver this project's mail", async () => {
    const claude = (await register("claude", "claude-thread", "foreign-project-claude")).body;
    const otherProjectDir = resolve(projectDir, "other-project");
    mkdirSync(otherProjectDir);
    const otherProject = (
      await request<any>(
        "POST",
        "/api/projects/join",
        {
          cwd: otherProjectDir,
          allowCreate: true,
          name: "foreign session fixture",
        },
        server.credentials.dashboard.token,
      )
    ).body.project;
    const foreignCodex = (
      await registerForProject(otherProject.id, "codex", "foreign-thread", "foreign-codex-session")
    ).body;
    const message = (
      await request<any>("POST", `/api/projects/${projectId}/messages`, {
        fromAgentId: "claude",
        fromSessionId: claude.id,
        recipients: [{ agentId: "codex" }],
        type: "QUESTION",
        priority: "IMPORTANT",
        requiresAck: true,
        requiresResponse: true,
        summary: "Project identity is part of recipient ownership",
        idempotencyKey: "foreign-project-message",
      })
    ).body;

    expect(
      await request<any>("POST", `/api/messages/${message.id}/claim`, {
        sessionId: foreignCodex.id,
        idempotencyKey: "foreign-project-claim",
      }),
    ).toMatchObject({ status: 403, body: { code: "FORBIDDEN" } });
    expect(
      await request<any>("POST", `/api/messages/${message.id}/delivered`, {
        sessionId: foreignCodex.id,
        idempotencyKey: "foreign-project-delivery",
      }),
    ).toMatchObject({ status: 403, body: { code: "FORBIDDEN" } });
    expect(
      (await request<any>("GET", `/api/messages/${message.id}`)).body.recipients[0],
    ).toMatchObject({
      recipientSessionId: null,
      state: "PENDING",
    });
  });

  it("does not let a delayed stale registration reverse-supersede the committed logical head", async () => {
    const predecessor = (
      await register("codex", "lineage-thread", "lineage-predecessor", "codex-app-server", {
        expectedHeadSessionId: null,
      })
    ).body;
    const staleReservation = (
      await request<any>("POST", `/api/projects/${projectId}/session-launch-reservations`, {
        agentId: "codex",
        client: "codex-app-server",
        deliveryMode: "app_server_push",
        externalSessionId: "lineage-thread",
        externalThreadId: "lineage-thread",
        runId: "run_lineage_delayed_stale",
        idempotencyKey: "reserve-lineage-delayed-stale",
      })
    ).body;
    const stalePrepared = await prepareManagedCodexRegistration({
      projectId,
      externalThreadId: "lineage-thread",
      reservation: staleReservation,
      suffix: "lineage_delayed_stale",
      idempotencyKey: "lineage-delayed-stale",
      expectedHeadSessionId: predecessor.id,
    });
    const successor = (
      await register("codex", "lineage-thread", "lineage-successor", "codex-app-server", {
        expectedHeadSessionId: predecessor.id,
      })
    ).body;
    const eventCountBeforeStale = server.store.listEvents(projectId).length;
    const sessionCountBeforeStale = (
      server.store.sqlite
        .prepare("SELECT COUNT(*) AS count FROM agent_sessions WHERE project_id = ?")
        .get(projectId) as { count: number }
    ).count;

    // This request was fully prepared against the predecessor but reached the Hub only after the
    // successor committed. Arrival order is not incarnation order.
    const stale = await request<any>(
      "POST",
      `/api/projects/${projectId}/sessions`,
      stalePrepared.body,
      stalePrepared.tokens.CONTROL,
    );

    expect(stale).toMatchObject({
      status: 409,
      body: { code: "TICKET_REPLACEMENT_PROOF_REQUIRED" },
    });
    expect(server.store.getSession(predecessor.id).connectionState).toBe("CLOSED");
    expect(server.store.getSession(successor.id).connectionState).toBe("ONLINE");
    expect(
      server.store
        .listSessions(projectId)
        .filter(
          (session) => session.agentId === "codex" && session.externalThreadId === "lineage-thread",
        )
        .map((session) => session.id),
    ).toEqual([successor.id]);
    expect(server.store.listEvents(projectId)).toHaveLength(eventCountBeforeStale);
    expect(
      (
        server.store.sqlite
          .prepare("SELECT COUNT(*) AS count FROM agent_sessions WHERE project_id = ?")
          .get(projectId) as { count: number }
      ).count,
    ).toBe(sessionCountBeforeStale);
    expect(
      server.store.sqlite
        .prepare("SELECT 1 FROM idempotency_keys WHERE key = ?")
        .get("lineage-delayed-stale"),
    ).toBeUndefined();
  });

  it("allows exactly one successor to advance a shared expected head", async () => {
    const predecessor = (await register("codex", "lineage-race", "lineage-race-predecessor")).body;

    const results = await Promise.all([
      register("codex", "lineage-race", "lineage-race-a", "codex-app-server", {
        expectedHeadSessionId: predecessor.id,
      }),
      register("codex", "lineage-race", "lineage-race-b", "codex-app-server", {
        expectedHeadSessionId: predecessor.id,
      }),
    ]);
    const winner = results.find((result) => result.status === 200);
    const loser = results.find((result) => result.status === 409);

    expect(winner).toBeDefined();
    expect(loser).toMatchObject({
      body: { code: "SESSION_LAUNCH_FENCE_STALE" },
    });
    expect(
      server.store
        .listSessions(projectId)
        .filter(
          (session) => session.agentId === "codex" && session.externalThreadId === "lineage-race",
        )
        .map((session) => session.id),
    ).toEqual([winner!.body.id]);
    expect(
      server.store
        .listEvents(projectId)
        .filter(
          (event) => event.type === "session.superseded" && event.aggregateId === predecessor.id,
        ),
    ).toHaveLength(1);
  });

  it("lets only the newest Hub-reserved managed run register the first lineage head", async () => {
    const reserve = (runId: string, idempotencyKey: string) =>
      request<any>("POST", `/api/projects/${projectId}/session-launch-reservations`, {
        agentId: "codex",
        client: "codex-app-server",
        deliveryMode: "app_server_push",
        externalThreadId: "reserved-first-head",
        runId,
        idempotencyKey,
      });
    const first = await reserve("run_reserved_first", "reserve-first");
    expect(first).toMatchObject({
      status: 200,
      body: {
        runId: "run_reserved_first",
        generation: 1,
        expectedHeadSessionId: null,
      },
    });
    expect(await reserve("run_reserved_conflict", "reserve-first")).toMatchObject({
      status: 409,
      body: { code: "SESSION_LAUNCH_REQUEST_CONFLICT" },
    });
    expect(
      await request<any>("POST", `/api/projects/${projectId}/session-launch-reservations`, {
        agentId: "codex",
        client: "codex-app-server",
        deliveryMode: "app_server_push",
        externalThreadId: "reserved-different-thread",
        runId: "run_reserved_first",
        idempotencyKey: "reserve-first",
      }),
    ).toMatchObject({
      status: 409,
      body: { code: "SESSION_LAUNCH_REQUEST_CONFLICT" },
    });
    expect(await reserve("run_reserved_first", "reserve-first-fresh-key")).toMatchObject({
      status: 200,
      body: {
        lineageId: first.body.lineageId,
        runId: "run_reserved_first",
        generation: 1,
        expectedHeadSessionId: null,
      },
    });
    const preparedFirst = await prepareManagedCodexRegistration({
      projectId,
      externalThreadId: "reserved-first-head",
      reservation: first.body,
      suffix: "register_reserved_first_late",
      idempotencyKey: "register-reserved-first-late",
    });
    const second = await reserve("run_reserved_second", "reserve-second");
    expect(second).toMatchObject({
      status: 200,
      body: {
        lineageId: first.body.lineageId,
        runId: "run_reserved_second",
        generation: 2,
        expectedHeadSessionId: null,
      },
    });
    const preparedSecond = await prepareManagedCodexRegistration({
      projectId,
      externalThreadId: "reserved-first-head",
      reservation: second.body,
      suffix: "register_reserved_second",
      idempotencyKey: "register-reserved-second",
    });

    const registration = async (prepared: typeof preparedSecond) => {
      const response = await request<any>(
        "POST",
        `/api/projects/${projectId}/sessions`,
        prepared.body,
        prepared.tokens.CONTROL,
      );
      if (response.status === 200 && response.body.session) {
        sessionTickets.set(response.body.session.id, {
          bundleId: prepared.bundleId,
          client: "codex-app-server",
          tokens: prepared.tokens,
        });
        return { ...response, body: response.body.session };
      }
      return response;
    };
    const winner = await registration(preparedSecond);
    expect(winner).toMatchObject({
      status: 200,
      body: {
        launcherRunId: second.body.runId,
        launchGeneration: second.body.generation,
        predecessorSessionId: null,
      },
    });
    const sessionCount = server.store.sqlite
      .prepare("SELECT COUNT(*) AS count FROM agent_sessions WHERE project_id = ?")
      .get(projectId) as { count: number };
    const eventCount = server.store
      .listEvents(projectId)
      .filter((event) => event.type === "session.registered").length;

    expect(await registration(preparedFirst)).toMatchObject({
      status: 409,
      body: { code: "TICKET_REPLACEMENT_PROOF_REQUIRED" },
    });
    expect(
      server.store.sqlite
        .prepare("SELECT COUNT(*) AS count FROM agent_sessions WHERE project_id = ?")
        .get(projectId),
    ).toEqual(sessionCount);
    expect(
      server.store.listEvents(projectId).filter((event) => event.type === "session.registered"),
    ).toHaveLength(eventCount);
    expect(
      server.store.getSessionLineageHead(projectId, {
        agentId: "codex",
        client: "codex-app-server",
        deliveryMode: "app_server_push",
        externalThreadId: "reserved-first-head",
      }),
    ).toMatchObject({ headSessionId: winner.body.id, headIncarnation: 1 });
  });

  it("rejects an old managed registration and stale idempotency replay after succession", async () => {
    const reserve = async (runId: string, idempotencyKey: string) =>
      (
        await request<any>("POST", `/api/projects/${projectId}/session-launch-reservations`, {
          agentId: "codex",
          client: "codex-app-server",
          deliveryMode: "app_server_push",
          externalThreadId: "reserved-replay-thread",
          runId,
          idempotencyKey,
        })
      ).body;
    const firstReservation = await reserve("run_replay_first", "reserve-replay-first");
    const firstPrepared = await prepareManagedCodexRegistration({
      projectId,
      externalThreadId: "reserved-replay-thread",
      reservation: firstReservation,
      suffix: "register_replay_first",
      idempotencyKey: "register-replay-first",
    });
    const firstResponse = await request<any>(
      "POST",
      `/api/projects/${projectId}/sessions`,
      firstPrepared.body,
      firstPrepared.tokens.CONTROL,
    );
    const first = {
      ...firstResponse,
      body: firstResponse.body.session ?? firstResponse.body,
    };
    expect(first.status).toBe(200);
    sessionTickets.set(first.body.id, {
      bundleId: firstPrepared.bundleId,
      client: "codex-app-server",
      tokens: firstPrepared.tokens,
    });
    const secondReservation = await reserve("run_replay_second", "reserve-replay-second");
    expect(secondReservation.expectedHeadSessionId).toBe(first.body.id);
    const secondPrepared = await prepareManagedCodexRegistration({
      projectId,
      externalThreadId: "reserved-replay-thread",
      reservation: secondReservation,
      suffix: "register_replay_second",
      idempotencyKey: "register-replay-second",
    });
    expect(
      await request<any>(
        "POST",
        `/api/projects/${projectId}/sessions`,
        { ...secondPrepared.body, idempotencyKey: "register-replay-first" },
        secondPrepared.tokens.CONTROL,
      ),
    ).toMatchObject({
      status: 409,
      body: { code: "VERSION_CONFLICT" },
    });
    expect(
      server.store.sqlite
        .prepare("SELECT state, consumed_session_id FROM session_launch_reservations WHERE id = ?")
        .get(secondReservation.id),
    ).toEqual({ state: "ISSUED", consumed_session_id: null });
    expect(
      server.store.getSessionLineageHead(projectId, {
        agentId: "codex",
        client: "codex-app-server",
        deliveryMode: "app_server_push",
        externalThreadId: "reserved-replay-thread",
      }),
    ).toMatchObject({ headSessionId: first.body.id, headIncarnation: 1 });
    const second = await request<any>(
      "POST",
      `/api/projects/${projectId}/sessions`,
      secondPrepared.body,
      secondPrepared.tokens.CONTROL,
    );
    expect(second.status).toBe(200);
    const secondSession = second.body.session ?? second.body;
    sessionTickets.set(secondSession.id, {
      bundleId: secondPrepared.bundleId,
      client: "codex-app-server",
      tokens: secondPrepared.tokens,
    });

    expect(
      await request<any>(
        "POST",
        `/api/projects/${projectId}/sessions`,
        firstPrepared.body,
        firstPrepared.tokens.CONTROL,
      ),
    ).toMatchObject({
      status: 403,
      body: { code: "FORBIDDEN" },
    });
    expect(
      await request<any>(
        "POST",
        `/api/projects/${projectId}/sessions`,
        {
          ...secondPrepared.body,
          launcherRunId: undefined,
          launchGeneration: undefined,
          idempotencyKey: "register-without-launch-fence",
        },
        secondPrepared.tokens.CONTROL,
      ),
    ).toMatchObject({
      status: 403,
      body: { code: "TICKET_BINDING_MISMATCH" },
    });
    expect(
      server.store.getSessionLineageHead(projectId, {
        agentId: "codex",
        client: "codex-app-server",
        deliveryMode: "app_server_push",
        externalThreadId: "reserved-replay-thread",
      }),
    ).toMatchObject({ headSessionId: secondSession.id, headIncarnation: 2 });
    expect(server.store.getSession(first.body.id)).toMatchObject({
      connectionState: "CLOSED",
      supersededBySessionId: secondSession.id,
    });
  });

  it("rejects empty external identities instead of disagreeing with migration backfill", async () => {
    expect(
      await request<any>("POST", `/api/projects/${projectId}/session-launch-reservations`, {
        agentId: "codex",
        client: "codex-app-server",
        deliveryMode: "app_server_push",
        externalThreadId: "",
        externalSessionId: "",
        runId: "run_empty_identity",
        idempotencyKey: "reserve-empty-identity",
      }),
    ).toMatchObject({
      status: 422,
      body: { code: "VALIDATION_ERROR" },
    });
  });

  it("rejects duplicate agent-wide recipient targets at the protocol boundary", async () => {
    const claude = (await register("claude", "duplicate-claude", "duplicate-claude-session")).body;
    const explicitA = (
      await register("codex", "duplicate-explicit-a", "duplicate-explicit-a-session")
    ).body;
    const explicitB = (
      await register("codex", "duplicate-explicit-b", "duplicate-explicit-b-session")
    ).body;

    expect(
      await request<any>("POST", `/api/projects/${projectId}/messages`, {
        fromAgentId: "claude",
        fromSessionId: claude.id,
        recipients: [{ agentId: "codex" }, { agentId: "codex" }],
        type: "QUESTION",
        priority: "IMPORTANT",
        requiresAck: true,
        requiresResponse: true,
        summary: "One logical recipient, not two nullable rows",
        idempotencyKey: "duplicate-unbound-input",
      }),
    ).toMatchObject({
      status: 422,
      body: { code: "VALIDATION_ERROR" },
    });
    expect(
      await request<any>("POST", `/api/projects/${projectId}/messages`, {
        fromAgentId: "claude",
        fromSessionId: claude.id,
        recipients: [
          { agentId: "codex", sessionId: explicitA.id },
          { agentId: "codex", sessionId: explicitA.id },
        ],
        type: "QUESTION",
        priority: "IMPORTANT",
        requiresAck: true,
        requiresResponse: true,
        summary: "An exact explicit target is unique too",
        idempotencyKey: "duplicate-explicit-input",
      }),
    ).toMatchObject({
      status: 422,
      body: { code: "VALIDATION_ERROR" },
    });
    expect(
      await request<any>("POST", `/api/projects/${projectId}/messages`, {
        fromAgentId: "claude",
        fromSessionId: claude.id,
        recipients: [{ agentId: "codex" }, { agentId: "codex", sessionId: explicitB.id }],
        type: "QUESTION",
        priority: "IMPORTANT",
        requiresAck: true,
        requiresResponse: true,
        summary: "Agent-wide and explicit ownership cannot coexist",
        idempotencyKey: "mixed-unbound-explicit-input",
      }),
    ).toMatchObject({
      status: 422,
      body: { code: "VALIDATION_ERROR" },
    });
    expect(
      await request<any>("POST", `/api/projects/${projectId}/messages`, {
        fromAgentId: "claude",
        fromSessionId: claude.id,
        recipients: [
          { agentId: "codex", sessionId: explicitA.id },
          { agentId: "codex", sessionId: explicitB.id },
        ],
        type: "QUESTION",
        priority: "IMPORTANT",
        requiresAck: false,
        requiresResponse: false,
        summary: "Distinct explicit sessions remain deliberate fan-out",
        idempotencyKey: "distinct-explicit-input",
      }),
    ).toMatchObject({
      status: 200,
      body: {
        recipients: [{ recipientSessionId: explicitA.id }, { recipientSessionId: explicitB.id }],
      },
    });
  });

  it("rejects missing, cross-project, and wrong-agent explicit recipient sessions atomically", async () => {
    const localClaude = (
      await register("claude", "recipient-check-claude", "recipient-check-claude-session")
    ).body;
    const foreignDir = resolve(dirname(projectDir), "recipient-check-foreign");
    mkdirSync(foreignDir);
    const foreignProject = (
      await request<any>(
        "POST",
        "/api/projects/join",
        {
          cwd: foreignDir,
          allowCreate: true,
          name: "recipient check foreign",
        },
        server.credentials.dashboard.token,
      )
    ).body.project;
    const foreignRegistration = await registerForProject(
      foreignProject.id,
      "claude",
      "recipient-check-foreign-thread",
      "recipient-check-foreign-session",
    );
    expect(foreignRegistration).toMatchObject({ status: 200 });
    const foreignClaude = foreignRegistration.body;
    const before = {
      messages: server.store.listMessages(projectId, { limit: 500 }).length,
      events: server.store.listEvents(projectId).length,
    };
    const cases = [
      { key: "missing", agentId: "codex", sessionId: "ses_missing" },
      { key: "foreign", agentId: "claude", sessionId: foreignClaude.id },
      { key: "wrong-agent", agentId: "codex", sessionId: localClaude.id },
    ];

    for (const fixture of cases) {
      expect(
        await request<any>("POST", `/api/projects/${projectId}/messages`, {
          fromAgentId: "claude",
          fromSessionId: localClaude.id,
          recipients: [{ agentId: fixture.agentId, sessionId: fixture.sessionId }],
          type: "QUESTION",
          priority: "IMPORTANT",
          requiresAck: true,
          requiresResponse: true,
          summary: `invalid recipient ${fixture.key}`,
          idempotencyKey: `invalid-recipient-${fixture.key}`,
        }),
      ).toMatchObject({
        status: 422,
        body: { code: "MESSAGE_RECIPIENT_SESSION_INVALID" },
      });
    }
    expect(server.store.listMessages(projectId, { limit: 500 })).toHaveLength(before.messages);
    expect(server.store.listEvents(projectId)).toHaveLength(before.events);
    for (const fixture of cases) {
      expect(
        server.store.sqlite
          .prepare("SELECT 1 FROM idempotency_keys WHERE project_id = ? AND key = ?")
          .get(projectId, `invalid-recipient-${fixture.key}`),
      ).toBeUndefined();
    }
  });

  it("enforces unbound recipient uniqueness inside SQLite as the final concurrency fence", async () => {
    const claude = (await register("claude", "unique-claude", "unique-claude-session")).body;
    const message = (
      await request<any>("POST", `/api/projects/${projectId}/messages`, {
        fromAgentId: "claude",
        fromSessionId: claude.id,
        recipients: [{ agentId: "codex" }],
        type: "QUESTION",
        priority: "IMPORTANT",
        requiresAck: true,
        requiresResponse: true,
        summary: "SQLite owns the final uniqueness invariant",
        idempotencyKey: "unique-unbound-message",
      })
    ).body;

    expect(() =>
      server.store.sqlite
        .prepare(
          `INSERT INTO message_recipients(
             id, message_id, recipient_agent_id, recipient_session_id, state, attempt_count
           ) VALUES (?, ?, ?, NULL, 'PENDING', 0)`,
        )
        .run("rcp_duplicate_unbound", message.id, "codex"),
    ).toThrow(/unique/i);
  });

  it("keeps unresolved surface ambiguity while rebinding the recipient to its successor", async () => {
    const predecessor = (
      await register("codex", "permit-thread", "permit-predecessor", "codex-app-server", {
        expectedHeadSessionId: null,
      })
    ).body;
    const claude = (await register("claude", "permit-claude", "permit-claude-session")).body;
    const message = (
      await request<any>("POST", `/api/projects/${projectId}/messages`, {
        fromAgentId: "claude",
        fromSessionId: claude.id,
        recipients: [{ agentId: "codex" }],
        type: "QUESTION",
        priority: "IMPORTANT",
        requiresAck: true,
        requiresResponse: true,
        summary: "The permit, not a cached claim, authorizes one surface",
        idempotencyKey: "surface-permit-message",
      })
    ).body;
    const acquired = await request<any>("POST", `/api/messages/${message.id}/surface-attempts`, {
      sessionId: predecessor.id,
      idempotencyKey: "surface-permit-predecessor",
    });
    expect(acquired).toMatchObject({
      status: 200,
      body: {
        permit: {
          messageId: message.id,
          sessionId: predecessor.id,
          recipientFence: 1,
          state: "ACTIVE",
        },
      },
    });
    expect(
      await request<any>("POST", `/api/messages/${message.id}/surface-attempts`, {
        sessionId: predecessor.id,
        idempotencyKey: "surface-permit-predecessor",
      }),
    ).toMatchObject({
      status: 200,
      body: { permit: { id: acquired.body.permit.id, state: "ACTIVE" } },
    });
    expect(
      await request<any>("POST", `/api/messages/${message.id}/surface-attempts`, {
        sessionId: predecessor.id,
        idempotencyKey: "surface-permit-predecessor-fresh-operation",
      }),
    ).toMatchObject({
      status: 409,
      body: { code: "MESSAGE_SURFACE_IN_FLIGHT" },
    });
    expect(
      await request<any>(
        "POST",
        `/api/messages/${message.id}/surface-attempts/${acquired.body.permit.id}/state`,
        {
          sessionId: predecessor.id,
          state: "AMBIGUOUS",
          error: "RPC outcome is not knowable",
          idempotencyKey: "surface-permit-predecessor-ambiguous",
        },
      ),
    ).toMatchObject({
      status: 200,
      body: { permit: { state: "AMBIGUOUS" } },
    });
    expect(
      await request<any>("POST", `/api/messages/${message.id}/surface-attempts`, {
        sessionId: predecessor.id,
        idempotencyKey: "surface-permit-predecessor-no-retry",
      }),
    ).toMatchObject({
      status: 409,
      body: { code: "MESSAGE_SURFACE_IN_FLIGHT" },
    });

    const successor = (
      await register("codex", "permit-thread", "permit-successor", "codex-app-server", {
        expectedHeadSessionId: predecessor.id,
      })
    ).body;
    expect(
      (await request<any>("GET", `/api/messages/${message.id}`)).body.recipients[0],
    ).toMatchObject({
      recipientSessionId: successor.id,
      state: "PENDING",
    });
    expect(
      await request<any>("POST", `/api/messages/${message.id}/surface-attempts`, {
        sessionId: successor.id,
        idempotencyKey: "surface-permit-successor-blocked",
      }),
    ).toMatchObject({
      status: 409,
      body: { code: "MESSAGE_SURFACE_IN_FLIGHT" },
    });
    expect(
      await request<any>("POST", `/api/messages/${message.id}/delivered`, {
        sessionId: predecessor.id,
        idempotencyKey: "surface-permit-legacy-bypass",
      }),
    ).toMatchObject({
      status: 403,
      body: { code: "FORBIDDEN" },
    });

    expect(
      await request<any>("POST", `/api/messages/${message.id}/delivered`, {
        sessionId: predecessor.id,
        surfaceAttemptId: acquired.body.permit.id,
        recipientFence: acquired.body.permit.recipientFence,
        idempotencyKey: "surface-permit-predecessor-confirmed",
      }),
    ).toMatchObject({
      status: 403,
      body: { code: "FORBIDDEN" },
    });
    expect(
      (await request<any>("GET", `/api/messages/${message.id}`)).body.recipients[0],
    ).toMatchObject({ recipientSessionId: successor.id, state: "PENDING" });
  });

  it("releases only a proven-aborted permit and rejects a stale recipient fence", async () => {
    const predecessor = (await register("codex", "abort-thread", "abort-predecessor")).body;
    const claude = (await register("claude", "abort-claude", "abort-claude-session")).body;
    const message = (
      await request<any>("POST", `/api/projects/${projectId}/messages`, {
        fromAgentId: "claude",
        fromSessionId: claude.id,
        recipients: [{ agentId: "codex" }],
        type: "QUESTION",
        priority: "IMPORTANT",
        requiresAck: true,
        requiresResponse: true,
        summary: "Only proof of no external side effect can release a permit",
        idempotencyKey: "abort-surface-message",
      })
    ).body;
    const predecessorSurface = await request<any>(
      "POST",
      `/api/messages/${message.id}/surface-attempts`,
      {
        sessionId: predecessor.id,
        idempotencyKey: "abort-predecessor-surface",
      },
    );
    expect(
      await request<any>(
        "POST",
        `/api/messages/${message.id}/surface-attempts/${predecessorSurface.body.permit.id}/state`,
        {
          sessionId: predecessor.id,
          state: "ABORTED",
          error: "app-server explicitly rejected before accepting input",
          idempotencyKey: "abort-predecessor-settled",
        },
      ),
    ).toMatchObject({
      status: 200,
      body: {
        message: {
          recipients: [expect.objectContaining({ recipientSessionId: predecessor.id })],
        },
        permit: { state: "ABORTED" },
      },
    });
    const successor = (
      await register("codex", "abort-thread", "abort-successor", "codex-app-server", {
        expectedHeadSessionId: predecessor.id,
      })
    ).body;
    expect(
      (await request<any>("GET", `/api/messages/${message.id}`)).body.recipients[0],
    ).toMatchObject({ recipientSessionId: successor.id, state: "PENDING" });
    expect(
      server.store
        .listEvents(projectId)
        .filter(
          (event) => event.type === "message.surface.aborted" && event.aggregateId === message.id,
        ),
    ).toEqual([expect.objectContaining({ aggregateId: message.id })]);

    const successorSurface = await request<any>(
      "POST",
      `/api/messages/${message.id}/surface-attempts`,
      {
        sessionId: successor.id,
        idempotencyKey: "abort-successor-surface",
      },
    );
    expect(successorSurface).toMatchObject({
      status: 200,
      body: {
        permit: {
          sessionId: successor.id,
          recipientFence: predecessorSurface.body.permit.recipientFence + 1,
          state: "ACTIVE",
        },
      },
    });
    expect(
      await request<any>("POST", `/api/messages/${message.id}/delivered`, {
        sessionId: successor.id,
        surfaceAttemptId: successorSurface.body.permit.id,
        recipientFence: predecessorSurface.body.permit.recipientFence,
        idempotencyKey: "abort-successor-stale-fence",
      }),
    ).toMatchObject({
      status: 409,
      body: { code: "SURFACE_PERMIT_INVALID" },
    });
    expect(
      await request<any>("POST", `/api/messages/${message.id}/delivered`, {
        sessionId: successor.id,
        surfaceAttemptId: successorSurface.body.permit.id,
        recipientFence: successorSurface.body.permit.recipientFence,
        idempotencyKey: "abort-successor-confirmed",
      }),
    ).toMatchObject({
      status: 200,
      body: {
        recipients: [
          expect.objectContaining({ recipientSessionId: successor.id, state: "DELIVERED" }),
        ],
      },
    });
  });

  it("does not let a superseded ticket settle an in-flight permit", async () => {
    const predecessor = (
      await register("codex", "ack-race-thread", "ack-race-predecessor", "codex-app-server", {
        expectedHeadSessionId: null,
      })
    ).body;
    const claude = (await register("claude", "ack-race-claude", "ack-race-claude-session")).body;
    const message = (
      await request<any>("POST", `/api/projects/${projectId}/messages`, {
        fromAgentId: "claude",
        fromSessionId: claude.id,
        recipients: [{ agentId: "codex" }],
        type: "QUESTION",
        priority: "IMPORTANT",
        requiresAck: true,
        requiresResponse: true,
        summary: "A downstream acknowledgement is proof that the exact surface arrived",
        idempotencyKey: "ack-race-message",
      })
    ).body;
    const surface = (
      await request<any>("POST", `/api/messages/${message.id}/surface-attempts`, {
        sessionId: predecessor.id,
        idempotencyKey: "ack-race-surface",
      })
    ).body.permit;
    const successor = (
      await register("codex", "ack-race-thread", "ack-race-successor", "codex-app-server", {
        expectedHeadSessionId: predecessor.id,
      })
    ).body;

    expect(
      await request<any>("POST", `/api/messages/${message.id}/ack`, {
        sessionId: predecessor.id,
        idempotencyKey: "ack-race-downstream-proof",
      }),
    ).toMatchObject({
      status: 403,
      body: { code: "FORBIDDEN" },
    });
    expect(
      server.store.sqlite
        .prepare("SELECT state FROM message_surface_attempts WHERE id = ?")
        .get(surface.id),
    ).toEqual({ state: "AMBIGUOUS" });

    expect(
      await request<any>("POST", `/api/messages/${message.id}/delivered`, {
        sessionId: predecessor.id,
        surfaceAttemptId: surface.id,
        recipientFence: surface.recipientFence,
        idempotencyKey: "ack-race-late-exact-delivered",
      }),
    ).toMatchObject({
      status: 403,
      body: { code: "FORBIDDEN" },
    });
    expect(
      await request<any>("POST", `/api/messages/${message.id}/processed`, {
        sessionId: successor.id,
        idempotencyKey: "ack-race-successor-processed",
      }),
    ).toMatchObject({
      status: 409,
      body: { code: "MESSAGE_SURFACE_IN_FLIGHT" },
    });
    expect(
      (await request<any>("GET", `/api/messages/${message.id}`)).body.recipients[0],
    ).toMatchObject({ recipientSessionId: successor.id, state: "PENDING" });
  });
});
