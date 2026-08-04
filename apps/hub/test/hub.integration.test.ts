import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { HubServer } from "../src/server.js";
import { createHubServer } from "./test-server.js";
import { createMcpServer } from "../src/mcp/server.js";
import {
  SESSION_TICKET_PURPOSES_BY_CLIENT,
  type AdapterSessionClient,
  type SessionTicketPurpose,
} from "@crossagent/protocol";
import { CredentialRegistry } from "../src/security/local-auth.js";
import type { FastifyRequest } from "fastify";
import {
  activateSessionTicketBundle,
  createPendingSessionTicket,
  revokeSessionTicketBundle,
} from "../src/security/session-tickets.js";

describe("Hub integration", () => {
  let server: HubServer;
  let projectDir: string;
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
    const root = mkdtempSync(resolve(tmpdir(), "crossagent-hub-test-"));
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
  });

  afterEach(async () => {
    vi.useRealTimers();
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
      if (candidate?.agentId === "codex" && candidate.client?.startsWith("codex-")) {
        effectiveToken = server.credentials.agentByClient.codex.token;
      } else if (candidate?.agentId === "claude" && candidate.client?.startsWith("claude-")) {
        effectiveToken = server.credentials.agentByClient.claude.token;
      } else {
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
                : server.token;
          } catch {
            effectiveToken = server.token;
          }
        } else {
          effectiveToken = server.credentials.dashboard.token;
        }
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

  async function expectWebSocketRejected(path: string, token: string): Promise<void> {
    await new Promise<void>((resolvePromise, reject) => {
      const socket = new WebSocket(
        `${baseUrl.replace("http", "ws")}${path}?token=${encodeURIComponent(token)}`,
      );
      const timeout = setTimeout(() => {
        socket.close();
        reject(new Error(`Timed out waiting for ${path} credential rejection`));
      }, 2000);
      let opened = false;
      socket.addEventListener("open", () => {
        opened = true;
        clearTimeout(timeout);
        socket.close();
        reject(new Error(`${path} accepted a credential that should have been rejected`));
      });
      socket.addEventListener("error", () => {
        if (opened) return;
        clearTimeout(timeout);
        resolvePromise();
      });
      socket.addEventListener("close", () => {
        if (opened) return;
        clearTimeout(timeout);
        resolvePromise();
      });
    });
  }

  type TestSocket = Awaited<ReturnType<HubServer["app"]["injectWS"]>>;

  function waitForSocketFrame(
    socket: TestSocket,
    predicate: (frame: any) => boolean,
  ): Promise<any> {
    return new Promise<any>((resolvePromise, reject) => {
      const timeout = setTimeout(() => {
        socket.close();
        reject(new Error("Timed out waiting for WebSocket frame"));
      }, 2000);
      const onMessage = (event: MessageEvent) => {
        const frame = JSON.parse(String(event.data));
        if (!predicate(frame)) return;
        clearTimeout(timeout);
        socket.removeEventListener("message", onMessage);
        resolvePromise(frame);
      };
      socket.addEventListener("message", onMessage);
    });
  }

  async function openDashboardSocket(): Promise<TestSocket> {
    return server.app.injectWS("/ws", {
      headers: {
        cookie: `crossagent_token=${encodeURIComponent(server.credentials.dashboard.token)}`,
      },
    });
  }

  async function openAgentSocket(token: string): Promise<TestSocket> {
    const socket = await server.app.injectWS("/ws");
    const authenticated = waitForSocketFrame(socket, (frame) => frame.type === "authenticated");
    socket.send(JSON.stringify({ type: "authenticate", token }));
    await authenticated;
    return socket;
  }

  async function fixture() {
    const joined = await request<any>(
      "POST",
      "/api/projects/join",
      {
        cwd: projectDir,
        allowCreate: true,
        name: "fixture",
      },
      server.credentials.dashboard.token,
    );
    const projectId = joined.body.project.id as string;
    const objective = await request<any>("POST", `/api/projects/${projectId}/objectives`, {
      title: "Ship the integration",
      description: "Test every durable boundary.",
      definitionOfDone: ["Messages ACK", "Review gate enforced"],
      status: "ACTIVE",
      idempotencyKey: "objective-1",
    });
    const [codex, claude] = await Promise.all([
      registerTicketedAdapter({
        projectId,
        client: "codex-app-server",
        externalThreadId: "fixture-codex-thread",
        suffix: "fixture_codex",
      }),
      registerTicketedAdapter({
        projectId,
        client: "claude-channel",
        externalSessionId: "fixture-claude-session",
        suffix: "fixture_claude",
      }),
    ]);
    return {
      projectId,
      objectiveId: objective.body.id as string,
      codex: codex.session,
      claude: claude.session,
    };
  }

  async function createProject(name: string): Promise<string> {
    const cwd = resolve(projectDir, name.replaceAll(/[^a-zA-Z0-9_-]/g, "-"));
    mkdirSync(cwd, { recursive: true });
    const joined = await request<any>(
      "POST",
      "/api/projects/join",
      { cwd, allowCreate: true, name },
      server.credentials.dashboard.token,
    );
    expect(joined.status).toBe(200);
    return joined.body.project.id as string;
  }

  async function registerTicketedAdapter(input: {
    projectId: string;
    client: AdapterSessionClient;
    externalSessionId?: string;
    externalThreadId?: string;
    managedLaunch?: boolean;
    suffix: string;
  }): Promise<{
    session: any;
    bundleId: string;
    ticketBinding: any;
    tokens: Partial<Record<SessionTicketPurpose, string>>;
    registrationRequest: Record<string, unknown>;
    serverNow: string;
  }> {
    const agentId = input.client.startsWith("codex-") ? "codex" : "claude";
    const adapterClient = agentId as "codex" | "claude";
    const bundleId = `stb_${input.suffix}`;
    const runId = `run_${input.suffix}`;
    const transport = input.client.endsWith("hooks") ? "hook-poll" : "websocket";
    const deliveryMode =
      input.client === "codex-app-server"
        ? "app_server_push"
        : input.client === "claude-channel"
          ? "native_channel"
          : "hook_poll";
    const projectCwd = (
      server.store.sqlite
        .prepare("SELECT canonical_path FROM project_paths WHERE project_id = ? LIMIT 1")
        .get(input.projectId) as { canonical_path: string }
    ).canonical_path;
    const launchReservation =
      input.client === "codex-app-server" && input.managedLaunch
        ? await request<any>(
            "POST",
            `/api/projects/${input.projectId}/session-launch-reservations`,
            {
              agentId,
              client: input.client,
              deliveryMode,
              externalSessionId: input.externalSessionId,
              externalThreadId: input.externalThreadId,
              runId,
              idempotencyKey: `reserve_${input.suffix}`,
            },
            server.credentials.agentByClient.codex.token,
          )
        : null;
    if (launchReservation) {
      expect(launchReservation, JSON.stringify(launchReservation.body)).toMatchObject({
        status: 200,
        body: { runId },
      });
      expect(launchReservation.body).toHaveProperty("expectedHeadSessionId");
      if (launchReservation.body.generation === 1) {
        expect(launchReservation.body.expectedHeadSessionId).toBeNull();
      }
    }
    const activationMode = launchReservation ? "MANAGED_RESERVATION" : "FIRST_LINEAGE";
    const tokens: Partial<Record<SessionTicketPurpose, string>> = {};
    for (const purpose of SESSION_TICKET_PURPOSES_BY_CLIENT[input.client]) {
      const raw = randomBytes(32).toString("base64url");
      tokens[purpose] = raw;
      const offerCredential =
        purpose === "CAPTURE"
          ? server.credentials.capture[adapterClient].token
          : purpose === "INJECTOR"
            ? server.credentials.injector[adapterClient].token
            : server.credentials.agentByClient[adapterClient].token;
      const offered = await request<any>(
        "POST",
        `/api/projects/${input.projectId}/session-ticket-offers`,
        {
          bundle_id: bundleId,
          purpose,
          token_sha256: createHash("sha256").update(raw, "utf8").digest("hex"),
          adapter_client: adapterClient,
          agent_id: adapterClient,
          session_client: input.client,
          role: "primary",
          transport,
          delivery_mode: deliveryMode,
          external_session_id: input.externalSessionId ?? null,
          external_thread_id: input.externalThreadId ?? null,
          run_id: runId,
          activation_mode: activationMode,
          ...(launchReservation
            ? {
                expected_lineage_id: launchReservation.body.lineageId,
                // This property must stay present when the first managed lineage has no head.
                expected_head_session_id: launchReservation.body.expectedHeadSessionId,
                launch_reservation_id: launchReservation.body.id,
              }
            : {}),
          idempotency_key: `offer_${input.suffix}_${purpose}`,
        },
        offerCredential,
      );
      expect(offered).toMatchObject({ status: 200, body: { state: "PENDING", purpose } });
    }
    const registrationRequest = {
      agentId,
      role: "primary",
      client: input.client,
      transport,
      deliveryMode,
      externalSessionId: input.externalSessionId,
      externalThreadId: input.externalThreadId,
      host: "ticket-test",
      cwd: projectCwd,
      capabilities: [],
      expectedHeadSessionId: launchReservation?.body.expectedHeadSessionId,
      launcherRunId: launchReservation?.body.runId,
      launchGeneration: launchReservation?.body.generation,
      ticket_bundle_id: bundleId,
      idempotencyKey: `register_${input.suffix}`,
    };
    const registered = await request<any>(
      "POST",
      `/api/projects/${input.projectId}/sessions`,
      registrationRequest,
      tokens.CONTROL,
    );
    expect(registered).toMatchObject({
      status: 200,
      body: { session: { projectId: input.projectId, client: input.client } },
    });
    sessionTickets.set(registered.body.session.id, {
      bundleId,
      client: input.client,
      tokens,
    });
    return {
      session: registered.body.session,
      bundleId,
      ticketBinding: registered.body.ticketBinding,
      tokens,
      registrationRequest,
      serverNow: registered.body.serverNow,
    };
  }

  it("registers a first managed lineage from an explicit nullable reservation head", async () => {
    const projectId = await createProject("managed-null-head");
    const registered = await registerTicketedAdapter({
      projectId,
      client: "codex-app-server",
      externalThreadId: "managed-null-head-thread",
      managedLaunch: true,
      suffix: "managed_null_head",
    });
    expect(registered.session).toMatchObject({
      projectId,
      client: "codex-app-server",
      incarnation: 1,
    });
    expect(
      server.store.sqlite
        .prepare(
          `SELECT activation_mode, expected_head_session_id, launch_reservation_id, state
           FROM adapter_session_tickets
           WHERE bundle_id = ? AND purpose = 'CONTROL'`,
        )
        .get(registered.bundleId),
    ).toMatchObject({
      activation_mode: "MANAGED_RESERVATION",
      expected_head_session_id: null,
      launch_reservation_id: expect.any(String),
      state: "ACTIVE",
    });
    const registeredReceipt = {
      session: registered.session,
      ticketBinding: registered.ticketBinding,
    };
    const registrationTime = Date.parse(registered.serverNow);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(registrationTime + 23 * 60 * 60 * 1000);
    const replayed = await request<any>(
      "POST",
      `/api/projects/${projectId}/sessions`,
      registered.registrationRequest,
      registered.tokens.CONTROL,
    );
    expect(replayed).toMatchObject({ status: 200, body: registeredReceipt });
    expect(replayed.body.ticketBinding.expiresAt).toBe(registered.ticketBinding.expiresAt);
    expect(Date.parse(replayed.body.serverNow) - registrationTime).toBe(23 * 60 * 60 * 1000);
  });

  it("rejects a registration identity that was absent from its pending ticket bundle", async () => {
    const projectId = await createProject("ticket-registration-identity");
    const bundleId = "stb_registration_identity_mismatch";
    const tokens: Partial<Record<SessionTicketPurpose, string>> = {};
    for (const purpose of SESSION_TICKET_PURPOSES_BY_CLIENT["codex-app-server"]) {
      const raw = randomBytes(32).toString("base64url");
      tokens[purpose] = raw;
      const offered = await request<any>(
        "POST",
        `/api/projects/${projectId}/session-ticket-offers`,
        {
          bundle_id: bundleId,
          purpose,
          token_sha256: createHash("sha256").update(raw, "utf8").digest("hex"),
          adapter_client: "codex",
          agent_id: "codex",
          session_client: "codex-app-server",
          role: "primary",
          transport: "websocket",
          delivery_mode: "app_server_push",
          external_session_id: null,
          external_thread_id: null,
          run_id: "run_registration_identity_mismatch",
          activation_mode: "FIRST_LINEAGE",
          idempotency_key: `offer_registration_identity_mismatch_${purpose}`,
        },
        purpose === "INJECTOR"
          ? server.credentials.injector.codex.token
          : server.credentials.agentByClient.codex.token,
      );
      expect(offered).toMatchObject({ status: 200, body: { state: "PENDING", purpose } });
    }

    expect(
      await request<any>(
        "POST",
        `/api/projects/${projectId}/sessions`,
        {
          agentId: "codex",
          role: "primary",
          client: "codex-app-server",
          transport: "websocket",
          deliveryMode: "app_server_push",
          externalThreadId: "thread-added-after-ticket-offer",
          host: "ticket-test",
          cwd: projectDir,
          capabilities: [],
          ticket_bundle_id: bundleId,
          idempotencyKey: "register_identity_mismatch",
        },
        tokens.CONTROL,
      ),
    ).toMatchObject({
      status: 403,
      body: { code: "TICKET_BINDING_MISMATCH" },
    });
    expect(
      server.store.sqlite
        .prepare("SELECT COUNT(*) FROM agent_sessions WHERE project_id = ?")
        .pluck()
        .get(projectId),
    ).toBe(0);
    expect(
      server.store.sqlite
        .prepare(
          "SELECT purpose, state FROM adapter_session_tickets WHERE bundle_id = ? ORDER BY purpose",
        )
        .all(bundleId),
    ).toEqual([
      { purpose: "CONTROL", state: "PENDING" },
      { purpose: "INJECTOR", state: "PENDING" },
      { purpose: "MODEL_MCP", state: "PENDING" },
    ]);
  });

  it("rotates one exact live Adapter bundle and kills every predecessor capability", async () => {
    const projectId = await createProject("ticket-rotation");
    const current = await registerTicketedAdapter({
      projectId,
      client: "codex-app-server",
      externalSessionId: "host-rotation-session",
      externalThreadId: "host-rotation-thread",
      managedLaunch: true,
      suffix: "http_rotation_0",
    });
    const successorBundleId = "stb_http_rotation_1";
    const successorTokens: Partial<Record<SessionTicketPurpose, string>> = {};
    const wrongIdentityBundleId = "stb_http_rotation_wrong_identity";
    const wrongIdentityRaw = randomBytes(32).toString("base64url");
    expect(
      await request<any>(
        "POST",
        `/api/projects/${projectId}/session-ticket-offers`,
        {
          bundle_id: wrongIdentityBundleId,
          purpose: "CONTROL",
          token_sha256: createHash("sha256").update(wrongIdentityRaw, "utf8").digest("hex"),
          adapter_client: "codex",
          agent_id: "codex",
          session_client: "codex-app-server",
          role: "primary",
          transport: "websocket",
          delivery_mode: "app_server_push",
          external_session_id: null,
          external_thread_id: "host-rotation-thread",
          run_id: current.ticketBinding.runId,
          activation_mode: "SESSION_AUXILIARY",
          expected_lineage_id: current.session.lineageId,
          expected_head_session_id: current.session.id,
          idempotency_key: "offer_http_rotation_wrong_identity",
        },
        current.tokens.CONTROL,
      ),
    ).toMatchObject({ status: 403, body: { code: "TICKET_BINDING_MISMATCH" } });
    expect(
      server.store.sqlite
        .prepare("SELECT COUNT(*) FROM adapter_session_tickets WHERE bundle_id = ?")
        .pluck()
        .get(wrongIdentityBundleId),
    ).toBe(0);
    for (const purpose of SESSION_TICKET_PURPOSES_BY_CLIENT["codex-app-server"]) {
      const raw = randomBytes(32).toString("base64url");
      successorTokens[purpose] = raw;
      const offered = await request<any>(
        "POST",
        `/api/projects/${projectId}/session-ticket-offers`,
        {
          bundle_id: successorBundleId,
          purpose,
          token_sha256: createHash("sha256").update(raw, "utf8").digest("hex"),
          adapter_client: "codex",
          agent_id: "codex",
          session_client: "codex-app-server",
          role: "primary",
          transport: "websocket",
          delivery_mode: "app_server_push",
          external_session_id: "host-rotation-session",
          external_thread_id: "host-rotation-thread",
          run_id: current.ticketBinding.runId,
          activation_mode: "SESSION_AUXILIARY",
          expected_lineage_id: current.session.lineageId,
          expected_head_session_id: current.session.id,
          idempotency_key: `offer_http_rotation_1_${purpose}`,
        },
        purpose === "INJECTOR" ? server.credentials.injector.codex.token : current.tokens.CONTROL,
      );
      expect(offered).toMatchObject({ status: 200, body: { state: "PENDING", purpose } });
    }

    const rotated = await request<any>(
      "POST",
      `/api/sessions/${current.session.id}/session-ticket-bundles/${successorBundleId}/activate`,
      { idempotencyKey: "rotate_http_bundle" },
      current.tokens.CONTROL,
    );
    expect(rotated).toMatchObject({
      status: 200,
      body: {
        serverNow: expect.any(String),
        session: { id: current.session.id },
        ticketBinding: { bundleId: successorBundleId, state: "ACTIVE" },
        supersededTicketBinding: { bundleId: current.bundleId, state: "SUPERSEDED" },
      },
    });
    const rotationReceipt = {
      session: rotated.body.session,
      ticketBinding: rotated.body.ticketBinding,
      supersededTicketBinding: rotated.body.supersededTicketBinding,
    };
    const immediateReplay = await request<any>(
      "POST",
      `/api/sessions/${current.session.id}/session-ticket-bundles/${successorBundleId}/activate`,
      { idempotencyKey: "rotate_http_bundle" },
      current.tokens.CONTROL,
    );
    expect(immediateReplay).toMatchObject({ status: 200, body: rotationReceipt });
    const rotationTime = Date.parse(rotated.body.serverNow);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(rotationTime + 23 * 60 * 60 * 1000);
    const delayedReplay = await request<any>(
      "POST",
      `/api/sessions/${current.session.id}/session-ticket-bundles/${successorBundleId}/activate`,
      { idempotencyKey: "rotate_http_bundle" },
      current.tokens.CONTROL,
    );
    expect(delayedReplay).toMatchObject({ status: 200, body: rotationReceipt });
    expect(delayedReplay.body.ticketBinding.expiresAt).toBe(rotated.body.ticketBinding.expiresAt);
    expect(Date.parse(delayedReplay.body.serverNow) - rotationTime).toBe(23 * 60 * 60 * 1000);
    expect(
      await request<any>("GET", "/api/projects", undefined, current.tokens.CONTROL),
    ).toMatchObject({
      status: 403,
    });

    const beforeSequence = Number(
      server.store.sqlite
        .prepare("SELECT heartbeat_sequence FROM agent_sessions WHERE id = ?")
        .pluck()
        .get(current.session.id),
    );
    expect(
      await request<any>(
        "POST",
        `/api/sessions/${current.session.id}/heartbeat`,
        {
          sequence: beforeSequence + 1,
          workState: "IDLE",
          activeFiles: [],
          queueDepth: 0,
        },
        successorTokens.MODEL_MCP,
      ),
    ).toMatchObject({ status: 403 });
    expect(
      Number(
        server.store.sqlite
          .prepare("SELECT heartbeat_sequence FROM agent_sessions WHERE id = ?")
          .pluck()
          .get(current.session.id),
      ),
    ).toBe(beforeSequence);
    expect(
      await request<any>(
        "POST",
        `/api/sessions/${current.session.id}/heartbeat`,
        {
          sequence: beforeSequence + 1,
          workState: "IDLE",
          activeFiles: [],
          queueDepth: 0,
        },
        successorTokens.CONTROL,
      ),
    ).toMatchObject({ status: 200 });
    expect(
      Number(
        server.store.sqlite
          .prepare("SELECT heartbeat_sequence FROM agent_sessions WHERE id = ?")
          .pluck()
          .get(current.session.id),
      ),
    ).toBe(beforeSequence + 1);

    vi.setSystemTime(rotationTime + 25 * 60 * 60 * 1000);
    expect(
      await request<any>(
        "POST",
        `/api/sessions/${current.session.id}/session-ticket-bundles/${successorBundleId}/activate`,
        { idempotencyKey: "rotate_http_bundle" },
        current.tokens.CONTROL,
      ),
    ).toMatchObject({ status: 200, body: rotationReceipt });
    const terminalReplaySnapshot = {
      sequence: server.store.sqlite
        .prepare("SELECT current_sequence FROM projects WHERE id = ?")
        .pluck()
        .get(projectId),
      events: server.store.sqlite.prepare("SELECT COUNT(*) FROM events").pluck().get(),
      idempotency: server.store.sqlite
        .prepare("SELECT COUNT(*) FROM idempotency_keys")
        .pluck()
        .get(),
    };
    expect(
      await request<any>(
        "POST",
        `/api/sessions/${current.session.id}/session-ticket-bundles/stb_wrong_cached_successor/activate`,
        { idempotencyKey: "rotate_http_bundle" },
        current.tokens.CONTROL,
      ),
    ).toMatchObject({ status: 409 });
    expect(
      await request<any>(
        "POST",
        `/api/sessions/${current.session.id}/session-ticket-bundles/${successorBundleId}/activate`,
        { idempotencyKey: "rotate_http_bundle_fresh_terminal" },
        current.tokens.CONTROL,
      ),
    ).toMatchObject({ status: 403 });
    expect({
      sequence: server.store.sqlite
        .prepare("SELECT current_sequence FROM projects WHERE id = ?")
        .pluck()
        .get(projectId),
      events: server.store.sqlite.prepare("SELECT COUNT(*) FROM events").pluck().get(),
      idempotency: server.store.sqlite
        .prepare("SELECT COUNT(*) FROM idempotency_keys")
        .pluck()
        .get(),
    }).toEqual(terminalReplaySnapshot);
  });

  it("durably aborts an expired auxiliary rotation before any late activation", async () => {
    const startedAt = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(startedAt);
    const projectId = await createProject("expired-uncommitted-rotation");
    const current = await registerTicketedAdapter({
      projectId,
      client: "codex-app-server",
      externalSessionId: "expired-rotation-session",
      externalThreadId: "expired-rotation-thread",
      managedLaunch: true,
      suffix: "expired_uncommitted_rotation",
    });
    const sibling = await registerTicketedAdapter({
      projectId,
      client: "codex-app-server",
      externalSessionId: "expired-rotation-sibling-session",
      externalThreadId: "expired-rotation-sibling-thread",
      suffix: "expired_uncommitted_rotation_sibling",
    });
    const otherProjectId = await createProject("expired-uncommitted-rotation-other");
    const otherProject = await registerTicketedAdapter({
      projectId: otherProjectId,
      client: "codex-app-server",
      externalSessionId: "expired-rotation-other-session",
      externalThreadId: "expired-rotation-other-thread",
      suffix: "expired_uncommitted_rotation_other",
    });
    const offerAuxiliaryBundle = async (
      owner: typeof current,
      bundleId: string,
      suffix: string,
    ) => {
      for (const purpose of SESSION_TICKET_PURPOSES_BY_CLIENT["codex-app-server"]) {
        const raw = randomBytes(32).toString("base64url");
        const offered = await request<any>(
          "POST",
          `/api/projects/${owner.session.projectId}/session-ticket-offers`,
          {
            bundle_id: bundleId,
            purpose,
            token_sha256: createHash("sha256").update(raw, "utf8").digest("hex"),
            adapter_client: "codex",
            agent_id: "codex",
            session_client: "codex-app-server",
            role: "primary",
            transport: "websocket",
            delivery_mode: "app_server_push",
            external_session_id: owner.session.externalSessionId,
            external_thread_id: owner.session.externalThreadId,
            run_id: owner.ticketBinding.runId,
            activation_mode: "SESSION_AUXILIARY",
            expected_lineage_id: owner.session.lineageId,
            expected_head_session_id: owner.session.id,
            idempotency_key: `offer_${suffix}_${purpose}`,
          },
          purpose === "INJECTOR" ? server.credentials.injector.codex.token : owner.tokens.CONTROL,
        );
        expect(offered).toMatchObject({ status: 200, body: { purpose, state: "PENDING" } });
      }
    };
    const successorBundleId = "stb_expired_uncommitted_aux";
    const siblingBundleId = "stb_expired_uncommitted_aux_sibling";
    const otherProjectBundleId = "stb_expired_uncommitted_aux_other";
    await offerAuxiliaryBundle(current, successorBundleId, "expired_uncommitted_aux");
    await offerAuxiliaryBundle(sibling, siblingBundleId, "expired_uncommitted_aux_sibling");
    await offerAuxiliaryBundle(otherProject, otherProjectBundleId, "expired_uncommitted_aux_other");

    vi.setSystemTime(startedAt + 25 * 60 * 60 * 1000);
    const before = {
      sequence: server.store.sqlite
        .prepare("SELECT current_sequence FROM projects WHERE id = ?")
        .pluck()
        .get(projectId),
      events: server.store.sqlite.prepare("SELECT COUNT(*) FROM events").pluck().get(),
      idempotency: server.store.sqlite
        .prepare("SELECT COUNT(*) FROM idempotency_keys")
        .pluck()
        .get(),
      tickets: server.store.sqlite
        .prepare(
          `SELECT id, state, hub_session_id, lineage_id, incarnation, updated_at,
                  activated_at, terminal_at, terminal_reason
           FROM adapter_session_tickets
           WHERE bundle_id IN (?, ?)
           ORDER BY bundle_id, purpose`,
        )
        .all(current.bundleId, successorBundleId),
    };
    const recovery = await request<any>(
      "POST",
      `/api/sessions/${current.session.id}/session-ticket-bundles/${successorBundleId}/activate`,
      { idempotencyKey: "rotate_expired_uncommitted_aux" },
      current.tokens.CONTROL,
    );
    expect(recovery).toMatchObject({
      status: 409,
      body: {
        code: "TICKET_ROTATION_NOT_COMMITTED",
        current: {
          state: "ABORTED",
          sessionId: current.session.id,
          predecessorBundleId: current.bundleId,
          successorBundleId,
        },
      },
    });
    const abortRecord = server.store.sqlite
      .prepare(
        `SELECT operation, response_json
         FROM idempotency_keys
         WHERE project_id = ? AND key = ?`,
      )
      .get(projectId, "rotate_expired_uncommitted_aux") as
      { operation: string; response_json: string } | undefined;
    expect(abortRecord?.operation).toMatch(/^session\.ticket\.rotate#[a-f0-9]{64}$/u);
    expect(JSON.parse(abortRecord!.response_json)).toMatchObject({
      rotationState: "ABORTED",
      sessionId: current.session.id,
      predecessorBundleId: current.bundleId,
      successorBundleId,
      abortedAt: expect.any(String),
    });
    expect(
      await request<any>(
        "POST",
        `/api/sessions/${current.session.id}/session-ticket-bundles/${successorBundleId}/activate`,
        { idempotencyKey: "rotate_expired_uncommitted_aux" },
        current.tokens.CONTROL,
      ),
    ).toMatchObject({ status: 409, body: { code: "TICKET_ROTATION_NOT_COMMITTED" } });
    const ticketsAfterNegativeRecovery = server.store.sqlite
      .prepare(
        `SELECT id, state, hub_session_id, lineage_id, incarnation, updated_at,
                activated_at, terminal_at, terminal_reason
         FROM adapter_session_tickets
         WHERE bundle_id IN (?, ?)
         ORDER BY bundle_id, purpose`,
      )
      .all(current.bundleId, successorBundleId);
    // Model an activation request authenticated before expiry but delayed behind the negative
    // recovery. The durable ABORTED fact, not the wall clock, must linearize the outcome.
    vi.setSystemTime(startedAt + 5 * 60 * 1000);
    expect(
      await request<any>(
        "POST",
        `/api/sessions/${current.session.id}/session-ticket-bundles/${successorBundleId}/activate`,
        { idempotencyKey: "rotate_expired_uncommitted_aux" },
        current.tokens.CONTROL,
      ),
    ).toMatchObject({ status: 409, body: { code: "TICKET_ROTATION_NOT_COMMITTED" } });
    expect(
      server.store.sqlite
        .prepare(
          `SELECT id, state, hub_session_id, lineage_id, incarnation, updated_at,
                  activated_at, terminal_at, terminal_reason
           FROM adapter_session_tickets
           WHERE bundle_id IN (?, ?)
           ORDER BY bundle_id, purpose`,
        )
        .all(current.bundleId, successorBundleId),
    ).toEqual(ticketsAfterNegativeRecovery);
    vi.setSystemTime(startedAt + 25 * 60 * 60 * 1000);
    expect(
      await request<any>(
        "POST",
        `/api/sessions/${current.session.id}/session-ticket-bundles/${siblingBundleId}/activate`,
        { idempotencyKey: "rotate_expired_uncommitted_aux" },
        current.tokens.CONTROL,
      ),
    ).toMatchObject({ status: 409, body: { code: "VERSION_CONFLICT" } });
    expect(
      await request<any>(
        "POST",
        `/api/sessions/${current.session.id}/session-ticket-bundles/${siblingBundleId}/activate`,
        { idempotencyKey: "rotate_expired_wrong_lineage_head" },
        current.tokens.CONTROL,
      ),
    ).toMatchObject({ status: 409, body: { code: "TICKET_REPLACEMENT_PROOF_REQUIRED" } });
    expect(
      await request<any>(
        "POST",
        `/api/sessions/${current.session.id}/session-ticket-bundles/${otherProjectBundleId}/activate`,
        { idempotencyKey: "rotate_expired_wrong_project_bundle" },
        current.tokens.CONTROL,
      ),
    ).toMatchObject({ status: 409, body: { code: "TICKET_REPLACEMENT_PROOF_REQUIRED" } });
    expect(
      await request<any>(
        "POST",
        `/api/sessions/${current.session.id}/session-ticket-bundles/${successorBundleId}/activate`,
        { idempotencyKey: "rotate_expired_sibling_control" },
        sibling.tokens.CONTROL,
      ),
    ).toMatchObject({ status: 403 });
    expect(
      await request<any>(
        "POST",
        `/api/sessions/${otherProject.session.id}/session-ticket-bundles/${successorBundleId}/activate`,
        { idempotencyKey: "rotate_expired_wrong_project_session" },
        current.tokens.CONTROL,
      ),
    ).toMatchObject({ status: 403 });
    expect(
      await request<any>(
        "POST",
        `/api/sessions/${current.session.id}/session-ticket-bundles/${successorBundleId}/activate`,
        { idempotencyKey: "rotate_expired_random_raw" },
        randomBytes(32).toString("base64url"),
      ),
    ).toMatchObject({ status: 403 });
    expect({
      sequence: server.store.sqlite
        .prepare("SELECT current_sequence FROM projects WHERE id = ?")
        .pluck()
        .get(projectId),
      events: server.store.sqlite.prepare("SELECT COUNT(*) FROM events").pluck().get(),
      idempotency: server.store.sqlite
        .prepare("SELECT COUNT(*) FROM idempotency_keys")
        .pluck()
        .get(),
      tickets: server.store.sqlite
        .prepare(
          `SELECT id, state, hub_session_id, lineage_id, incarnation, updated_at,
                  activated_at, terminal_at, terminal_reason
           FROM adapter_session_tickets
           WHERE bundle_id IN (?, ?)
           ORDER BY bundle_id, purpose`,
        )
        .all(current.bundleId, successorBundleId),
    }).toEqual({ ...before, idempotency: Number(before.idempotency) + 1 });

    revokeSessionTicketBundle(server.store.sqlite, {
      bundleId: current.bundleId,
      reason: "revoked recovery proof",
      now: new Date().toISOString(),
    });
    const revokedSnapshot = {
      sequence: server.store.sqlite
        .prepare("SELECT current_sequence FROM projects WHERE id = ?")
        .pluck()
        .get(projectId),
      events: server.store.sqlite.prepare("SELECT COUNT(*) FROM events").pluck().get(),
      idempotency: server.store.sqlite
        .prepare("SELECT COUNT(*) FROM idempotency_keys")
        .pluck()
        .get(),
    };
    expect(
      await request<any>(
        "POST",
        `/api/sessions/${current.session.id}/session-ticket-bundles/${successorBundleId}/activate`,
        { idempotencyKey: "rotate_revoked_uncommitted_aux" },
        current.tokens.CONTROL,
      ),
    ).toMatchObject({ status: 403 });
    expect({
      sequence: server.store.sqlite
        .prepare("SELECT current_sequence FROM projects WHERE id = ?")
        .pluck()
        .get(projectId),
      events: server.store.sqlite.prepare("SELECT COUNT(*) FROM events").pluck().get(),
      idempotency: server.store.sqlite
        .prepare("SELECT COUNT(*) FROM idempotency_keys")
        .pluck()
        .get(),
    }).toEqual(revokedSnapshot);
  });

  it("binds broad and id-based reads to one live project ticket", async () => {
    const projectA = await createProject("read-boundary-a");
    const projectB = await createProject("read-boundary-b");
    const sessionA = await registerTicketedAdapter({
      projectId: projectA,
      client: "codex-app-server",
      externalThreadId: "read-boundary-thread-a",
      suffix: "read_boundary_a",
    });
    const objective = await request<any>(
      "POST",
      `/api/projects/${projectB}/objectives`,
      {
        title: "Private B objective",
        definitionOfDone: ["not visible from A"],
        idempotencyKey: "read_boundary_objective_b",
      },
      server.credentials.dashboard.token,
    );
    const task = await request<any>(
      "POST",
      `/api/projects/${projectB}/tasks`,
      {
        objectiveId: objective.body.id,
        title: "Private B task",
        idempotencyKey: "read_boundary_task_b",
      },
      server.credentials.dashboard.token,
    );

    expect(
      await request<any[]>("GET", "/api/projects", undefined, sessionA.tokens.CONTROL),
    ).toMatchObject({ status: 200, body: [{ id: projectA }] });
    for (const path of [
      `/api/projects/${projectB}/registration`,
      `/api/projects/${projectB}/overview`,
      `/api/projects/${projectB}/events`,
      `/api/projects/${projectB}/sessions`,
      `/api/projects/${projectB}/tasks`,
      `/api/tasks/${task.body.id}`,
    ]) {
      expect(await request<any>("GET", path, undefined, sessionA.tokens.CONTROL)).toMatchObject({
        status: 403,
      });
    }

    const registry = new CredentialRegistry(server.store.sqlite, server.credentials);
    const principal = registry.authenticate(
      {
        headers: { authorization: `Bearer ${sessionA.tokens.CONTROL}` },
        query: {},
      } as FastifyRequest,
      ["hub:session"],
    );
    expect(() => server.store.assertProjectRead(principal, projectA)).not.toThrow();
    revokeSessionTicketBundle(server.store.sqlite, {
      bundleId: sessionA.bundleId,
      reason: "TOCTOU regression",
      now: new Date().toISOString(),
    });
    expect(() => server.store.assertProjectRead(principal, projectA)).toThrow(
      /not bound to this active Adapter session/i,
    );
  });

  it("closes an expired Adapter bundle once and replays only its exact terminal receipt", async () => {
    const projectId = await createProject("expired-close-recovery");
    const session = server.store.registerSession({
      projectId,
      agentId: "claude",
      role: "primary",
      client: "claude-channel",
      transport: "websocket",
      deliveryMode: "native_channel",
      externalSessionId: "expired-close-host-session",
      host: "expired-close-fixture",
      cwd: (
        server.store.sqlite
          .prepare("SELECT canonical_path FROM project_paths WHERE project_id = ? LIMIT 1")
          .get(projectId) as { canonical_path: string }
      ).canonical_path,
      capabilities: [],
      idempotencyKey: "expired_close_legacy_session",
    });
    expect(session.lineageId).toBeTruthy();
    const runId = "run_expired_close";
    server.store.sqlite
      .prepare("UPDATE agent_sessions SET launcher_run_id = ? WHERE id = ?")
      .run(runId, session.id);
    const raw = randomBytes(32).toString("base64url");
    const activationTime = "2020-01-01T00:00:00.000Z";
    const offered = createPendingSessionTicket(server.store.sqlite, {
      bundleId: "stb_expired_http_close",
      purpose: "CONTROL",
      tokenSha256: createHash("sha256").update(raw, "utf8").digest("hex"),
      offeredByAuthCredentialId: "crd_agent_claude",
      projectId,
      adapterClient: "claude",
      agentId: "claude",
      sessionClient: "claude-channel",
      role: "primary",
      transport: "websocket",
      deliveryMode: "native_channel",
      externalSessionId: "expired-close-host-session",
      runId,
      activationMode: "FIRST_LINEAGE",
      idempotencyKey: "offer_expired_http_close",
      now: activationTime,
    });
    activateSessionTicketBundle(server.store.sqlite, {
      bundleId: "stb_expired_http_close",
      hubSessionId: session.id,
      lineageId: session.lineageId!,
      incarnation: session.incarnation!,
      proof: { kind: "FIRST_LINEAGE", controlTicketId: offered.id },
      now: activationTime,
    });

    const closeBody = {
      reason: "expired host ended",
      idempotencyKey: "close_expired_http_once",
    };
    const closed = await request<any>("POST", `/api/sessions/${session.id}/close`, closeBody, raw);
    expect(closed).toMatchObject({
      status: 200,
      body: {
        session: { id: session.id, connectionState: "CLOSED" },
        ticketBinding: { bundleId: "stb_expired_http_close", state: "EXPIRED" },
      },
    });
    expect(await request<any>("POST", `/api/sessions/${session.id}/close`, closeBody, raw)).toEqual(
      closed,
    );
    const eventCount = Number(
      server.store.sqlite
        .prepare("SELECT COUNT(*) FROM events WHERE type = 'session.closed' AND aggregate_id = ?")
        .pluck()
        .get(session.id),
    );
    expect(
      await request<any>(
        "POST",
        `/api/sessions/${session.id}/close`,
        { ...closeBody, reason: "changed replay" },
        raw,
      ),
    ).toMatchObject({ status: 409 });
    expect(
      await request<any>(
        "POST",
        `/api/sessions/${session.id}/close`,
        { reason: closeBody.reason, idempotencyKey: "fresh_terminal_close" },
        raw,
      ),
    ).toMatchObject({ status: 403 });
    expect(
      Number(
        server.store.sqlite
          .prepare("SELECT COUNT(*) FROM events WHERE type = 'session.closed' AND aggregate_id = ?")
          .pluck()
          .get(session.id),
      ),
    ).toBe(eventCount);
  });

  it("replaces an idle Hook session from only its exact expired current-head CONTROL ticket", async () => {
    const startedAt = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(startedAt);
    const projectId = await createProject("expired-hook-replacement");
    const predecessor = await registerTicketedAdapter({
      projectId,
      client: "codex-cli-hooks",
      externalSessionId: "host-hook-session",
      suffix: "expired_hook_predecessor",
    });
    vi.setSystemTime(startedAt + 25 * 60 * 60 * 1000);
    expect(
      server.store.sqlite
        .prepare(
          `SELECT state, expires_at < ? AS expired
           FROM adapter_session_tickets
           WHERE bundle_id = ? AND purpose = 'CONTROL'`,
        )
        .get(new Date().toISOString(), predecessor.bundleId),
    ).toEqual({ state: "ACTIVE", expired: 1 });
    const sibling = await registerTicketedAdapter({
      projectId,
      client: "codex-cli-hooks",
      externalSessionId: "sibling-hook-session",
      suffix: "expired_hook_sibling",
    });
    expect(
      await request<any>(
        "GET",
        `/api/projects/${projectId}/sessions`,
        undefined,
        predecessor.tokens.CONTROL,
      ),
    ).toMatchObject({ status: 403 });

    const successorBundleId = "stb_expired_hook_successor";
    const runId = "run_expired_hook_successor";
    const successorTokens = {
      CONTROL: randomBytes(32).toString("base64url"),
      CAPTURE: randomBytes(32).toString("base64url"),
    };
    const controlOffer = {
      bundle_id: successorBundleId,
      purpose: "CONTROL",
      token_sha256: createHash("sha256").update(successorTokens.CONTROL, "utf8").digest("hex"),
      adapter_client: "codex",
      agent_id: "codex",
      session_client: "codex-cli-hooks",
      role: "primary",
      transport: "hook-poll",
      delivery_mode: "hook_poll",
      external_session_id: "host-hook-session",
      external_thread_id: null,
      run_id: runId,
      activation_mode: "CURRENT_HEAD_REPLACEMENT",
      expected_lineage_id: predecessor.session.lineageId,
      expected_head_session_id: predecessor.session.id,
      idempotency_key: "offer_expired_hook_successor_CONTROL",
    };
    expect(
      await request<any>(
        "POST",
        `/api/projects/${projectId}/session-ticket-offers`,
        {
          ...controlOffer,
          bundle_id: "stb_expired_hook_wrong_lineage",
          expected_lineage_id: sibling.session.lineageId,
          token_sha256: createHash("sha256")
            .update(randomBytes(32).toString("base64url"), "utf8")
            .digest("hex"),
          idempotency_key: "offer_expired_hook_wrong_lineage",
        },
        predecessor.tokens.CONTROL,
      ),
    ).toMatchObject({ status: 403 });
    expect(
      await request<any>(
        "POST",
        `/api/projects/${projectId}/session-ticket-offers`,
        {
          ...controlOffer,
          bundle_id: "stb_expired_hook_sibling_proof",
          token_sha256: createHash("sha256")
            .update(randomBytes(32).toString("base64url"), "utf8")
            .digest("hex"),
          idempotency_key: "offer_expired_hook_sibling_proof",
        },
        sibling.tokens.CONTROL,
      ),
    ).toMatchObject({ status: 403 });
    expect(
      await request<any>(
        "POST",
        `/api/projects/${projectId}/session-ticket-offers`,
        {
          ...controlOffer,
          bundle_id: "stb_expired_hook_raw_proof",
          token_sha256: createHash("sha256")
            .update(randomBytes(32).toString("base64url"), "utf8")
            .digest("hex"),
          idempotency_key: "offer_expired_hook_raw_proof",
        },
        randomBytes(32).toString("base64url"),
      ),
    ).toMatchObject({ status: 403 });
    const offered = await request<any>(
      "POST",
      `/api/projects/${projectId}/session-ticket-offers`,
      controlOffer,
      predecessor.tokens.CONTROL,
    );
    expect(offered, JSON.stringify(offered.body)).toMatchObject({
      status: 200,
      body: { bundle_id: successorBundleId, state: "PENDING", purpose: "CONTROL" },
    });
    expect(
      await request<any>(
        "POST",
        `/api/projects/${projectId}/session-ticket-offers`,
        controlOffer,
        predecessor.tokens.CONTROL,
      ),
    ).toEqual(offered);
    expect(
      await request<any>(
        "POST",
        `/api/projects/${projectId}/session-ticket-offers`,
        { ...controlOffer, run_id: "run_changed_lost_response" },
        predecessor.tokens.CONTROL,
      ),
    ).toMatchObject({ status: 409 });
    const wrongBundleId = "stb_expired_hook_wrong_identity";
    expect(
      await request<any>(
        "POST",
        `/api/projects/${projectId}/session-ticket-offers`,
        {
          ...controlOffer,
          bundle_id: wrongBundleId,
          token_sha256: createHash("sha256")
            .update(randomBytes(32).toString("base64url"), "utf8")
            .digest("hex"),
          external_session_id: "another-host-session",
          idempotency_key: "offer_expired_hook_wrong_identity",
        },
        predecessor.tokens.CONTROL,
      ),
    ).toMatchObject({ status: 403 });
    expect(
      server.store.sqlite
        .prepare("SELECT COUNT(*) FROM adapter_session_tickets WHERE bundle_id = ?")
        .pluck()
        .get(wrongBundleId),
    ).toBe(0);

    expect(
      await request<any>(
        "POST",
        `/api/projects/${projectId}/session-ticket-offers`,
        {
          ...controlOffer,
          purpose: "CAPTURE",
          token_sha256: createHash("sha256").update(successorTokens.CAPTURE, "utf8").digest("hex"),
          idempotency_key: "offer_expired_hook_successor_CAPTURE",
        },
        server.credentials.capture.codex.token,
      ),
    ).toMatchObject({ status: 200, body: { purpose: "CAPTURE", state: "PENDING" } });

    const replacement = await request<any>(
      "POST",
      `/api/projects/${projectId}/sessions`,
      {
        agentId: "codex",
        role: "primary",
        client: "codex-cli-hooks",
        transport: "hook-poll",
        deliveryMode: "hook_poll",
        externalSessionId: "host-hook-session",
        host: "ticket-test",
        cwd: projectDir,
        capabilities: [],
        expectedHeadSessionId: predecessor.session.id,
        ticket_bundle_id: successorBundleId,
        idempotencyKey: "register_expired_hook_successor",
      },
      successorTokens.CONTROL,
    );
    expect(replacement, JSON.stringify(replacement.body)).toMatchObject({
      status: 200,
      body: {
        session: {
          projectId,
          predecessorSessionId: predecessor.session.id,
          incarnation: 2,
        },
        ticketBinding: { bundleId: successorBundleId, state: "ACTIVE" },
      },
    });
    expect(server.store.getSession(predecessor.session.id)).toMatchObject({
      connectionState: "CLOSED",
      supersededBySessionId: replacement.body.session.id,
    });
    expect(
      server.store.sqlite
        .prepare(
          "SELECT DISTINCT state FROM adapter_session_tickets WHERE bundle_id = ? ORDER BY state",
        )
        .all(predecessor.bundleId),
    ).toEqual([{ state: "EXPIRED" }]);
    expect(
      server.store.sqlite
        .prepare(
          "SELECT purpose, state FROM adapter_session_tickets WHERE bundle_id = ? ORDER BY purpose",
        )
        .all(successorBundleId),
    ).toEqual([
      { purpose: "CAPTURE", state: "ACTIVE" },
      { purpose: "CONTROL", state: "ACTIVE" },
    ]);
    expect(
      await request<any>(
        "POST",
        `/api/projects/${projectId}/session-ticket-offers`,
        controlOffer,
        predecessor.tokens.CONTROL,
      ),
    ).toMatchObject({ status: 403 });
  });

  it("builds one complete Codex replacement bundle from an exact expired current-head proof", async () => {
    const startedAt = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(startedAt);
    const projectId = await createProject("expired-codex-replacement");
    const otherProjectId = await createProject("expired-codex-replacement-other");
    const predecessor = await registerTicketedAdapter({
      projectId,
      client: "codex-app-server",
      externalSessionId: "expired-codex-session",
      externalThreadId: "expired-codex-thread",
      suffix: "expired_codex_predecessor",
    });
    vi.setSystemTime(startedAt + 25 * 60 * 60 * 1000);
    const sibling = await registerTicketedAdapter({
      projectId,
      client: "codex-app-server",
      externalSessionId: "expired-codex-sibling-session",
      externalThreadId: "expired-codex-sibling-thread",
      suffix: "expired_codex_sibling",
    });

    const successorBundleId = "stb_expired_codex_successor";
    const successorRunId = "run_expired_codex_successor";
    const successorTokens = {
      CONTROL: randomBytes(32).toString("base64url"),
      MODEL_MCP: randomBytes(32).toString("base64url"),
      INJECTOR: randomBytes(32).toString("base64url"),
    };
    const offerBody = (
      bundleId: string,
      purpose: SessionTicketPurpose,
      raw: string,
      suffix: string,
      overrides: Record<string, unknown> = {},
    ) => ({
      bundle_id: bundleId,
      purpose,
      token_sha256: createHash("sha256").update(raw, "utf8").digest("hex"),
      adapter_client: "codex",
      agent_id: "codex",
      session_client: "codex-app-server",
      role: "primary",
      transport: "websocket",
      delivery_mode: "app_server_push",
      external_session_id: "expired-codex-session",
      external_thread_id: "expired-codex-thread",
      run_id: successorRunId,
      activation_mode: "CURRENT_HEAD_REPLACEMENT",
      expected_lineage_id: predecessor.session.lineageId,
      expected_head_session_id: predecessor.session.id,
      idempotency_key: `offer_expired_codex_${suffix}`,
      ...overrides,
    });
    const rejectedBundles = new Set<string>();
    const expectRejected = async (
      suffix: string,
      purpose: SessionTicketPurpose,
      token: string,
      overrides: Record<string, unknown> = {},
      targetProjectId = projectId,
    ) => {
      const bundleId = `stb_expired_codex_rejected_${suffix}`;
      rejectedBundles.add(bundleId);
      expect(
        await request<any>(
          "POST",
          `/api/projects/${targetProjectId}/session-ticket-offers`,
          offerBody(bundleId, purpose, randomBytes(32).toString("base64url"), suffix, overrides),
          token,
        ),
      ).toMatchObject({ status: 403 });
    };

    await expectRejected("static_model", "MODEL_MCP", server.credentials.agentByClient.codex.token);
    await expectRejected("capture", "CAPTURE", predecessor.tokens.CONTROL!);
    await expectRejected("injector", "INJECTOR", predecessor.tokens.CONTROL!);
    await expectRejected("auxiliary", "CONTROL", predecessor.tokens.CONTROL!, {
      activation_mode: "SESSION_AUXILIARY",
    });
    await expectRejected("sibling", "CONTROL", sibling.tokens.CONTROL!);
    await expectRejected("project", "CONTROL", predecessor.tokens.CONTROL!, {}, otherProjectId);
    await expectRejected("lineage", "CONTROL", predecessor.tokens.CONTROL!, {
      expected_lineage_id: sibling.session.lineageId,
    });
    await expectRejected("head", "CONTROL", predecessor.tokens.CONTROL!, {
      expected_head_session_id: sibling.session.id,
    });
    await expectRejected("identity", "CONTROL", predecessor.tokens.CONTROL!, {
      external_session_id: "forged-codex-session",
    });
    await expectRejected("raw", "CONTROL", randomBytes(32).toString("base64url"));
    expect(
      server.store.sqlite
        .prepare(
          `SELECT COUNT(*) FROM adapter_session_tickets
           WHERE bundle_id IN (${[...rejectedBundles].map(() => "?").join(", ")})`,
        )
        .pluck()
        .get(...rejectedBundles),
    ).toBe(0);

    for (const purpose of ["CONTROL", "MODEL_MCP"] as const) {
      const offered = await request<any>(
        "POST",
        `/api/projects/${projectId}/session-ticket-offers`,
        offerBody(successorBundleId, purpose, successorTokens[purpose], `successor_${purpose}`),
        predecessor.tokens.CONTROL,
      );
      expect(offered, JSON.stringify(offered.body)).toMatchObject({
        status: 200,
        body: { bundle_id: successorBundleId, purpose, state: "PENDING" },
      });
    }
    expect(
      await request<any>(
        "POST",
        `/api/projects/${projectId}/session-ticket-offers`,
        offerBody(successorBundleId, "INJECTOR", successorTokens.INJECTOR, "successor_INJECTOR"),
        server.credentials.injector.codex.token,
      ),
    ).toMatchObject({
      status: 200,
      body: { bundle_id: successorBundleId, purpose: "INJECTOR", state: "PENDING" },
    });

    const replacement = await request<any>(
      "POST",
      `/api/projects/${projectId}/sessions`,
      {
        agentId: "codex",
        role: "primary",
        client: "codex-app-server",
        transport: "websocket",
        deliveryMode: "app_server_push",
        externalSessionId: "expired-codex-session",
        externalThreadId: "expired-codex-thread",
        host: "ticket-test",
        cwd: projectDir,
        capabilities: [],
        expectedHeadSessionId: predecessor.session.id,
        ticket_bundle_id: successorBundleId,
        idempotencyKey: "register_expired_codex_successor",
      },
      successorTokens.CONTROL,
    );
    expect(replacement, JSON.stringify(replacement.body)).toMatchObject({
      status: 200,
      body: {
        session: {
          predecessorSessionId: predecessor.session.id,
          incarnation: 2,
        },
        ticketBinding: { bundleId: successorBundleId, state: "ACTIVE" },
      },
    });
    expect(
      server.store.sqlite
        .prepare(
          "SELECT purpose, state FROM adapter_session_tickets WHERE bundle_id = ? ORDER BY purpose",
        )
        .all(successorBundleId),
    ).toEqual([
      { purpose: "CONTROL", state: "ACTIVE" },
      { purpose: "INJECTOR", state: "ACTIVE" },
      { purpose: "MODEL_MCP", state: "ACTIVE" },
    ]);
    await expectRejected("after_replacement", "CONTROL", predecessor.tokens.CONTROL!);
  });

  it("enforces local bearer auth and one-time dashboard launch exchange", async () => {
    const unauthorized = await request<any>("GET", "/api/projects", undefined, "wrong");
    expect(unauthorized.status).toBe(403);
    const launch = await request<{ code: string }>(
      "POST",
      "/api/dashboard/launch",
      {},
      server.credentials.dashboard.token,
    );
    expect(launch.status).toBe(200);
    const exchange = await fetch(`${baseUrl}/api/dashboard/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: launch.body.code }),
    });
    expect(exchange.status).toBe(200);
    expect(exchange.headers.get("set-cookie")).toContain("HttpOnly");
    expect(exchange.headers.get("set-cookie")).toContain("Max-Age=31536000");
    const repeated = await fetch(`${baseUrl}/api/dashboard/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: launch.body.code }),
    });
    expect(repeated.status).toBe(403);

    const manualAuth = await fetch(`${baseUrl}/api/dashboard/auth`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${server.credentials.dashboard.token}`,
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(manualAuth.status).toBe(200);
    expect(manualAuth.headers.get("set-cookie")).toContain("Max-Age=31536000");
  });

  it("persists Dashboard project directories and resolves them by stable UUID", async () => {
    const joined = await request<any>(
      "POST",
      "/api/projects/join",
      {
        cwd: projectDir,
        allowCreate: true,
        name: "dashboard fixture",
      },
      server.credentials.dashboard.token,
    );
    expect(joined.status).toBe(200);
    const projectId = joined.body.project.id as string;
    const projects = await request<any[]>("GET", "/api/projects");
    expect(projects.body).toEqual([
      expect.objectContaining({
        id: projectId,
        name: "dashboard fixture",
        paths: [projectDir],
      }),
    ]);
    const registration = await request<any>("GET", `/api/projects/${projectId}/registration`);
    expect(registration.body).toMatchObject({
      project: { id: projectId },
      root: projectDir,
      paths: [projectDir],
    });
    const invalid = await request<any>(
      "POST",
      "/api/projects/join",
      {
        cwd: resolve(projectDir, "missing"),
        allowCreate: true,
      },
      server.credentials.dashboard.token,
    );
    expect(invalid.status).toBe(422);
    expect(invalid.body.code).toBe("PROJECT_PATH_INVALID");
  });

  it("atomically claims tasks, tracks inbox state, and detects intent conflicts", async () => {
    const context = await fixture();
    const task = await request<any>("POST", `/api/projects/${context.projectId}/tasks`, {
      objectiveId: context.objectiveId,
      title: "Implement contract",
      description: "Create the shared protocol.",
      status: "READY",
      priority: "high",
      capabilityTags: ["typescript"],
      scopeGlobs: ["src/**"],
      protectedScope: false,
      reviewRequired: false,
      dependsOn: [],
      weight: 1,
      idempotencyKey: "task-1",
    });
    const firstClaim = await request<any>("POST", `/api/tasks/${task.body.id}/claim`, {
      sessionId: context.codex.id,
      expectedVersion: task.body.version,
      takeoverStale: false,
      idempotencyKey: "claim-codex",
    });
    expect(firstClaim.status).toBe(200);
    const staleClaim = await request<any>("POST", `/api/tasks/${task.body.id}/claim`, {
      sessionId: context.claude.id,
      expectedVersion: task.body.version,
      takeoverStale: false,
      idempotencyKey: "claim-claude",
    });
    expect(staleClaim.status).toBe(409);
    expect(staleClaim.body.current.ownerAgentId).toBe("codex");

    const message = await request<any>("POST", `/api/projects/${context.projectId}/messages`, {
      fromAgentId: "codex",
      fromSessionId: context.codex.id,
      recipients: [{ agentId: "claude", sessionId: context.claude.id }],
      type: "QUESTION",
      priority: "IMPORTANT",
      requiresAck: true,
      requiresResponse: true,
      summary: "Confirm the public return shape.",
      references: [{ type: "task", id: task.body.id }],
      idempotencyKey: "message-1",
    });
    expect(message.body.recipients[0].state).toBe("PENDING");
    const acknowledged = await request<any>("POST", `/api/messages/${message.body.id}/ack`, {
      sessionId: context.claude.id,
      idempotencyKey: "ack-1",
    });
    expect(acknowledged.body.recipients[0].state).toBe("ACKNOWLEDGED");

    const peerTask = await request<any>("POST", `/api/projects/${context.projectId}/tasks`, {
      objectiveId: context.objectiveId,
      title: "Consume contract",
      description: "Use the shared type from a peer-owned task.",
      status: "READY",
      priority: "normal",
      capabilityTags: ["review"],
      scopeGlobs: ["test/**"],
      protectedScope: false,
      reviewRequired: false,
      dependsOn: [],
      weight: 1,
      idempotencyKey: "task-2",
    });
    await request<any>("POST", `/api/tasks/${peerTask.body.id}/claim`, {
      sessionId: context.claude.id,
      expectedVersion: peerTask.body.version,
      takeoverStale: false,
      idempotencyKey: "claim-peer",
    });

    const left = await request<any>("POST", `/api/projects/${context.projectId}/write-intents`, {
      taskId: task.body.id,
      sessionId: context.codex.id,
      globs: [],
      symbols: ["SharedContract"],
      mode: "exclusive",
      reason: "Change shared type",
      ttlSeconds: 600,
      idempotencyKey: "intent-left",
    });
    expect(left.status).toBe(200);
    const right = await request<any>("POST", `/api/projects/${context.projectId}/write-intents`, {
      taskId: peerTask.body.id,
      sessionId: context.claude.id,
      globs: [],
      symbols: ["SharedContract"],
      mode: "advisory",
      reason: "Review dependent code",
      ttlSeconds: 600,
      idempotencyKey: "intent-right",
    });
    expect(right.body.conflicts).toHaveLength(1);
    const conflicts = await request<any[]>(
      "GET",
      `/api/projects/${context.projectId}/conflicts?status=OPEN`,
    );
    expect(conflicts.body[0]).toMatchObject({
      overlapSymbols: ["SharedContract"],
      left: { agentId: expect.any(String) },
      right: { agentId: expect.any(String) },
    });
  });

  it("atomically rebinds unresolved inactive-predecessor mail without taking live mail", async () => {
    const context = await fixture();
    const registerCodex = async (
      key: string,
      externalThreadId: string,
      overrides: Record<string, unknown> = {},
    ) => {
      const client = (overrides.client ?? "codex-app-server") as AdapterSessionClient;
      const registered = await registerTicketedAdapter({
        projectId: context.projectId,
        client,
        externalThreadId,
        externalSessionId:
          typeof overrides.externalSessionId === "string" ? overrides.externalSessionId : undefined,
        managedLaunch: client === "codex-app-server",
        suffix: key,
      });
      return { status: 200, body: registered.session };
    };
    const postPinned = (sessionId: string, key: string) =>
      request<any>("POST", `/api/projects/${context.projectId}/messages`, {
        fromAgentId: "claude",
        fromSessionId: context.claude.id,
        recipients: [{ agentId: "codex", sessionId }],
        type: "QUESTION",
        priority: "IMPORTANT",
        requiresAck: true,
        requiresResponse: false,
        summary: key,
        idempotencyKey: key,
      });
    const setState = (messageId: string, path: string, sessionId: string, key: string) =>
      request<any>("POST", `/api/messages/${messageId}/${path}`, {
        sessionId,
        idempotencyKey: key,
      });

    const predecessor = (await registerCodex("predecessor-session", "desktop-thread")).body;
    const pending = (await postPinned(predecessor.id, "predecessor-pending")).body;
    const delivered = (await postPinned(predecessor.id, "predecessor-delivered")).body;
    const acknowledged = (await postPinned(predecessor.id, "predecessor-acknowledged")).body;
    const processed = (await postPinned(predecessor.id, "predecessor-processed")).body;
    const responded = (await postPinned(predecessor.id, "predecessor-responded")).body;
    const expired = (await postPinned(predecessor.id, "predecessor-expired")).body;

    expect(
      await setState(delivered.id, "delivered", predecessor.id, "predecessor-delivery"),
    ).toMatchObject({ status: 200 });
    expect(await setState(acknowledged.id, "ack", predecessor.id, "predecessor-ack")).toMatchObject(
      { status: 200 },
    );
    expect(
      await setState(processed.id, "processed", predecessor.id, "predecessor-processed-state"),
    ).toMatchObject({ status: 200 });
    expect(
      await setState(responded.id, "responded", predecessor.id, "predecessor-responded-state"),
    ).toMatchObject({ status: 200 });
    server.store.sqlite
      .prepare("UPDATE message_recipients SET state = 'EXPIRED' WHERE message_id = ?")
      .run(expired.id);
    await request<any>("POST", `/api/sessions/${predecessor.id}/close`, {
      reason: "managed_bridge_replaced",
      idempotencyKey: "close-predecessor-session",
    });

    const otherThread = (await registerCodex("other-thread-session", "other-thread")).body;
    await request<any>("POST", `/api/sessions/${otherThread.id}/close`, {
      reason: "inactive_other_thread",
      idempotencyKey: "close-other-thread-session",
    });
    const otherThreadMail = (await postPinned(otherThread.id, "other-thread-pending")).body;

    const liveResponse = await registerCodex("live-session", "desktop-thread", {
      role: "observer",
      client: "codex-cli-hooks",
      transport: "hook-poll",
      deliveryMode: "mailbox_only",
      externalSessionId: "live-hooks-session",
    });
    expect(liveResponse, JSON.stringify(liveResponse.body)).toMatchObject({ status: 200 });
    const live = liveResponse.body;
    const liveMail = (await postPinned(live.id, "live-session-pending")).body;
    const replacementResponse = await registerCodex("replacement-session", "desktop-thread");
    expect(replacementResponse.status).toBe(200);
    const replacement = replacementResponse.body;

    const recipientOf = async (messageId: string) =>
      (await request<any>("GET", `/api/messages/${messageId}`)).body.recipients[0];
    for (const message of [pending, delivered, acknowledged]) {
      expect(await recipientOf(message.id)).toMatchObject({
        recipientSessionId: replacement.id,
      });
    }
    for (const message of [processed, responded, expired]) {
      expect(await recipientOf(message.id)).toMatchObject({
        recipientSessionId: predecessor.id,
      });
    }
    expect(await recipientOf(otherThreadMail.id)).toMatchObject({
      recipientSessionId: otherThread.id,
    });
    expect(await recipientOf(liveMail.id)).toMatchObject({
      recipientSessionId: live.id,
    });

    const registrationEvent = server.store
      .listEvents(context.projectId, 0, 5000)
      .find((event) => event.type === "session.registered" && event.aggregateId === replacement.id);
    expect(registrationEvent?.payload).toMatchObject({ reboundRecipientCount: 3 });

    const resumedAcknowledged = await request<any>(
      "POST",
      `/api/messages/${acknowledged.id}/surface-attempts`,
      {
        sessionId: replacement.id,
        idempotencyKey: "replacement-resume-acknowledged",
      },
    );
    expect(resumedAcknowledged).toMatchObject({
      status: 200,
      body: {
        message: { recipients: [expect.objectContaining({ state: "ACKNOWLEDGED" })] },
        permit: { sessionId: replacement.id, state: "ACTIVE" },
      },
    });
    expect(
      await request<any>("POST", `/api/messages/${acknowledged.id}/delivered`, {
        sessionId: replacement.id,
        surfaceAttemptId: resumedAcknowledged.body.permit.id,
        recipientFence: resumedAcknowledged.body.permit.recipientFence,
        idempotencyKey: "replacement-confirm-resumed-acknowledged",
      }),
    ).toMatchObject({
      status: 200,
      body: { recipients: [expect.objectContaining({ state: "ACKNOWLEDGED" })] },
    });
    expect(
      await request<any>("POST", `/api/messages/${acknowledged.id}/surface-attempts`, {
        sessionId: replacement.id,
        idempotencyKey: "replacement-cannot-repeat-resumed-acknowledged",
      }),
    ).toMatchObject({ status: 409, body: { code: "MESSAGE_ALREADY_SURFACED" } });

    const deliveredOnce = await setState(
      pending.id,
      "delivered",
      replacement.id,
      "replacement-delivery",
    );
    const deliveredReplay = await setState(
      pending.id,
      "delivered",
      replacement.id,
      "replacement-delivery",
    );
    expect(deliveredOnce).toMatchObject({
      status: 200,
      body: { recipients: [expect.objectContaining({ state: "DELIVERED", attemptCount: 1 })] },
    });
    expect(deliveredReplay.body).toEqual(deliveredOnce.body);
    expect(
      (
        server.store.sqlite
          .prepare(
            `SELECT COUNT(*) AS count FROM message_deliveries
               WHERE recipient_id = (SELECT id FROM message_recipients WHERE message_id = ?)`,
          )
          .get(pending.id) as { count: number }
      ).count,
    ).toBe(1);

    const acknowledgedOnce = await setState(delivered.id, "ack", replacement.id, "replacement-ack");
    const acknowledgedReplay = await setState(
      delivered.id,
      "ack",
      replacement.id,
      "replacement-ack",
    );
    expect(acknowledgedOnce).toMatchObject({
      status: 200,
      body: { recipients: [expect.objectContaining({ state: "ACKNOWLEDGED" })] },
    });
    expect(acknowledgedReplay.body).toEqual(acknowledgedOnce.body);
    expect(
      (
        server.store.sqlite
          .prepare(
            `SELECT COUNT(*) AS count FROM message_acks
               WHERE message_id = ? AND ack_type = 'ACKNOWLEDGED'`,
          )
          .get(delivered.id) as { count: number }
      ).count,
    ).toBe(1);

    expect(
      await setState(pending.id, "ack", predecessor.id, "old-session-cannot-ack-rebound"),
    ).toMatchObject({ status: 403 });
    for (const [message, key] of [
      [liveMail, "replacement-cannot-take-live"],
      [otherThreadMail, "replacement-cannot-take-other-thread"],
      [processed, "replacement-cannot-take-processed"],
      [responded, "replacement-cannot-take-responded"],
      [expired, "replacement-cannot-take-expired"],
    ] as const) {
      expect(await setState(message.id, "delivered", replacement.id, key)).toMatchObject({
        status: 403,
      });
    }
  });

  it("hides closed roster history and keeps only the newest repeated offline session", async () => {
    const context = await fixture();
    const register = (key: string, role: "primary" | "observer", client: string) =>
      request<any>(
        "POST",
        `/api/projects/${context.projectId}/sessions`,
        {
          agentId: "manual:roster",
          role,
          client,
          transport: "websocket",
          deliveryMode: "app_server_push",
          host: "test",
          cwd: projectDir,
          capabilities: [],
          idempotencyKey: key,
        },
        server.credentials.agent.token,
      );

    const first = (await register("roster-first", "primary", "fake-client")).body;
    const second = (await register("roster-second", "primary", "fake-client")).body;
    server.store.sqlite
      .prepare(
        `UPDATE agent_sessions
            SET connection_state = 'OFFLINE', closed_at = NULL, connected_at = ?
          WHERE id = ?`,
      )
      .run("2026-01-01T00:00:00.000Z", first.id);
    server.store.sqlite
      .prepare(
        `UPDATE agent_sessions
            SET connection_state = 'OFFLINE', closed_at = NULL, connected_at = ?
          WHERE id = ?`,
      )
      .run("2026-01-02T00:00:00.000Z", second.id);
    const closed = (await register("roster-closed", "observer", "fake-client")).body;
    await request<any>("POST", `/api/sessions/${closed.id}/close`, {
      reason: "test_closed_history",
    });

    const sessions = await request<any[]>("GET", `/api/projects/${context.projectId}/sessions`);
    const roster = sessions.body.filter(
      (session) => session.agentId === "manual:roster" && session.client === "fake-client",
    );
    expect(roster, JSON.stringify(roster)).toHaveLength(1);
    expect(roster.map((session) => session.id)).toEqual([second.id]);
    expect(sessions.body.map((session) => session.id)).not.toContain(first.id);
    expect(sessions.body.map((session) => session.id)).not.toContain(closed.id);
  });

  it("replays sequenced WebSocket events and exposes the exact MCP tool budget", async () => {
    const context = await fixture();
    const frames: any[] = [];
    const socket = await openDashboardSocket();
    socket.addEventListener("message", (event: MessageEvent) => {
      frames.push(JSON.parse(String(event.data)));
    });
    const subscribed = waitForSocketFrame(socket, (frame) => frame.type === "subscribed");
    socket.send(
      JSON.stringify({
        type: "subscribe",
        clientType: "dashboard",
        projectId: context.projectId,
        lastSequence: 0,
      }),
    );
    await subscribed;
    expect(frames.some((frame) => frame.type === "event" && frame.replay)).toBe(true);

    const liveEvent = new Promise<any>((resolvePromise, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Timed out waiting for live WS event")),
        2000,
      );
      const onMessage = (event: MessageEvent) => {
        const frame = JSON.parse(String(event.data));
        if (frame.type !== "event" || frame.replay) return;
        clearTimeout(timeout);
        socket.removeEventListener("message", onMessage);
        resolvePromise(frame);
      };
      socket.addEventListener("message", onMessage);
    });
    const created = await request<any>("POST", `/api/projects/${context.projectId}/objectives`, {
      title: "Dashboard live event",
      description: "Proves the authenticated Dashboard socket remains subscribed.",
      definitionOfDone: [],
      status: "ACTIVE",
      idempotencyKey: "dashboard-live-event",
    });
    expect(created.status).toBe(200);
    await expect(liveEvent).resolves.toMatchObject({ type: "event", replay: false });
    socket.close();

    const initializeBody = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "integration-test", version: "1.0.0" },
      },
    });
    const bootstrapFallback = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${server.credentials.agentByClient.codex.token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
      },
      body: initializeBody,
    });
    expect(bootstrapFallback.status).toBe(403);

    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${sessionTickets.get(context.codex.id)!.tokens.MODEL_MCP}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
      },
      body: initializeBody,
    });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("crossagent-hub");
    expect(text).toContain(
      "An Agent cannot create, modify, upgrade, or mark a user_turn or directive verification as VALID.",
    );
    expect(text).toContain(
      "Static bootstrap credentials are enrollment-only and must never be accepted as an MCP or data-plane fallback.",
    );
    const mcpPrincipal = new CredentialRegistry(
      server.store.sqlite,
      server.credentials,
    ).authenticate(
      {
        headers: {
          authorization: `Bearer ${sessionTickets.get(context.codex.id)!.tokens.MODEL_MCP}`,
        },
        query: {},
      } as FastifyRequest,
      ["hub:mcp"],
    );
    const mcp = createMcpServer(server.store, mcpPrincipal);
    const mcpClient = new Client({ name: "tool-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([mcp.connect(serverTransport), mcpClient.connect(clientTransport)]);
    const tools = await mcpClient.listTools();
    expect(tools.tools).toHaveLength(19);
    expect(tools.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        "crossagent_join",
        "crossagent_relay_user_directive",
        "crossagent_delegate_instruction",
        "crossagent_get_directive",
      ]),
    );
    const selected = await mcpClient.callTool({
      name: "crossagent_join",
      arguments: { projectId: context.projectId },
    });
    expect(selected.structuredContent).toMatchObject({
      project: { id: context.projectId },
      root: projectDir,
    });
    await mcpClient.close();
    await mcp.close();
  });

  it("binds an agent WebSocket only to an open session in the subscribed project", async () => {
    const context = await fixture();
    const otherDir = resolve(projectDir, "other-project");
    mkdirSync(otherDir);
    const other = await request<any>(
      "POST",
      "/api/projects/join",
      {
        cwd: otherDir,
        allowCreate: true,
        name: "other fixture",
      },
      server.credentials.dashboard.token,
    );
    const otherSession = await request<any>(
      "POST",
      `/api/projects/${other.body.project.id}/sessions`,
      {
        agentId: "manual:cross-project-ws",
        role: "observer",
        client: "fake-client",
        transport: "websocket",
        deliveryMode: "mailbox_only",
        host: "test",
        cwd: otherDir,
        capabilities: [],
        idempotencyKey: "other-project-session",
      },
      server.credentials.agent.token,
    );
    expect(otherSession.status).toBe(200);

    const subscribeOnce = async (projectId: string, sessionId: string) => {
      const socket = await openAgentSocket(sessionTickets.get(context.codex.id)!.tokens.CONTROL!);
      const result = waitForSocketFrame(socket, (frame) =>
        ["subscribed", "error"].includes(frame.type),
      );
      socket.send(
        JSON.stringify({
          type: "subscribe",
          clientType: "codex_bridge",
          projectId,
          sessionId,
          lastSequence: 0,
        }),
      );
      const frame = await result;
      socket.close();
      return frame;
    };

    await expect(subscribeOnce(context.projectId, otherSession.body.id)).resolves.toMatchObject({
      type: "error",
      code: "FRAME_FAILED",
    });

    const closed = await request<any>("POST", `/api/sessions/${context.codex.id}/close`, {
      reason: "subscription-test",
      idempotencyKey: "close-subscription-test-session",
    });
    expect(closed, JSON.stringify(closed.body)).toMatchObject({ status: 200 });
    const terminalSocket = await server.app.injectWS("/ws");
    const terminalClose = new Promise<{ code: number }>((resolvePromise, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Terminal CONTROL ticket socket stayed open")),
        2000,
      );
      terminalSocket.addEventListener("close", (event: CloseEvent) => {
        clearTimeout(timeout);
        resolvePromise({ code: event.code });
      });
    });
    terminalSocket.send(
      JSON.stringify({
        type: "authenticate",
        token: sessionTickets.get(context.codex.id)!.tokens.CONTROL!,
      }),
    );
    await expect(terminalClose).resolves.toMatchObject({ code: 1008 });
  });

  it("strictly validates heartbeat frames before mutating session telemetry", async () => {
    const context = await fixture();
    const socket = await openAgentSocket(sessionTickets.get(context.codex.id)!.tokens.CONTROL!);
    const waitForFrame = (predicate: (frame: any) => boolean) =>
      new Promise<any>((resolvePromise, reject) => {
        const timeout = setTimeout(() => reject(new Error("Timed out waiting for WS frame")), 2000);
        const onMessage = (event: MessageEvent) => {
          const frame = JSON.parse(String(event.data));
          if (!predicate(frame)) return;
          clearTimeout(timeout);
          socket.removeEventListener("message", onMessage);
          resolvePromise(frame);
        };
        socket.addEventListener("message", onMessage);
      });
    const subscribed = waitForFrame((frame) => frame.type === "subscribed");
    socket.send(
      JSON.stringify({
        type: "subscribe",
        clientType: "codex_bridge",
        projectId: context.projectId,
        sessionId: context.codex.id,
        lastSequence: 0,
      }),
    );
    await subscribed;

    const invalid = waitForFrame(
      (frame) => frame.type === "error" && frame.code === "INVALID_HEARTBEAT_FRAME",
    );
    socket.send(
      JSON.stringify({
        type: "heartbeat",
        heartbeat: {
          sessionId: context.codex.id,
          sequence: 91,
          workState: "IDLE",
          activeFiles: [],
          queueDepth: 0,
          forged: true,
        },
      }),
    );
    await expect(invalid).resolves.toMatchObject({ code: "INVALID_HEARTBEAT_FRAME" });
    expect(server.store.getSession(context.codex.id)).toMatchObject({ queueDepth: 0 });

    const otherDir = resolve(projectDir, "heartbeat-other-project");
    mkdirSync(otherDir);
    const other = await request<any>(
      "POST",
      "/api/projects/join",
      {
        cwd: otherDir,
        allowCreate: true,
        name: "heartbeat other fixture",
      },
      server.credentials.dashboard.token,
    );
    const objective = await request<any>(
      "POST",
      `/api/projects/${other.body.project.id}/objectives`,
      {
        title: "Other objective",
        description: "Must not cross the socket project boundary.",
        definitionOfDone: [],
        status: "ACTIVE",
        idempotencyKey: "heartbeat-other-objective",
      },
    );
    const task = await request<any>("POST", `/api/projects/${other.body.project.id}/tasks`, {
      objectiveId: objective.body.id,
      title: "Other project task",
      description: "Must not become current through this socket.",
      status: "READY",
      priority: "normal",
      capabilityTags: [],
      scopeGlobs: [],
      protectedScope: false,
      reviewRequired: false,
      dependsOn: [],
      weight: 1,
      idempotencyKey: "heartbeat-other-task",
    });
    const crossProject = waitForFrame(
      (frame) => frame.type === "error" && frame.code === "FRAME_FAILED",
    );
    socket.send(
      JSON.stringify({
        type: "heartbeat",
        heartbeat: {
          sessionId: context.codex.id,
          sequence: 92,
          workState: "WORKING",
          currentTaskId: task.body.id,
          activeFiles: [],
          queueDepth: 0,
        },
      }),
    );
    await expect(crossProject).resolves.toMatchObject({ code: "FRAME_FAILED" });
    expect(server.store.getSession(context.codex.id)).toMatchObject({ currentTaskId: null });
    socket.close();
  });

  it("keeps agent mutation frames unavailable on an unbound Dashboard socket", async () => {
    const context = await fixture();
    const socket = await openDashboardSocket();
    const waitForFrame = (predicate: (frame: any) => boolean) =>
      new Promise<any>((resolvePromise, reject) => {
        const timeout = setTimeout(() => reject(new Error("Timed out waiting for WS frame")), 2000);
        const onMessage = (event: MessageEvent) => {
          const frame = JSON.parse(String(event.data));
          if (!predicate(frame)) return;
          clearTimeout(timeout);
          socket.removeEventListener("message", onMessage);
          resolvePromise(frame);
        };
        socket.addEventListener("message", onMessage);
      });
    const subscribed = waitForFrame((frame) => frame.type === "subscribed");
    socket.send(
      JSON.stringify({
        type: "subscribe",
        clientType: "dashboard",
        projectId: context.projectId,
        lastSequence: 0,
      }),
    );
    await subscribed;

    for (const mutation of [
      {
        type: "heartbeat",
        heartbeat: {
          sessionId: context.codex.id,
          sequence: 1,
          workState: "IDLE",
          activeFiles: [],
          queueDepth: 0,
        },
      },
      { type: "delivery", messageId: "msg_fake", state: "DELIVERED" },
      { type: "reconcile_git" },
    ]) {
      const rejected = waitForFrame(
        (frame) => frame.type === "error" && frame.code === "FRAME_FAILED",
      );
      socket.send(JSON.stringify(mutation));
      await expect(rejected).resolves.toMatchObject({ code: "FRAME_FAILED" });
    }
    socket.close();
  });

  it("keeps a Dashboard principal read-only when it claims an Agent client type and session", async () => {
    const context = await fixture();
    const socket = await openDashboardSocket();
    const frames: any[] = [];
    const waitForFrame = (predicate: (frame: any) => boolean) =>
      new Promise<any>((resolvePromise, reject) => {
        const timeout = setTimeout(() => reject(new Error("Timed out waiting for WS frame")), 2000);
        const onMessage = (event: MessageEvent) => {
          const frame = JSON.parse(String(event.data));
          frames.push(frame);
          if (!predicate(frame)) return;
          clearTimeout(timeout);
          socket.removeEventListener("message", onMessage);
          resolvePromise(frame);
        };
        socket.addEventListener("message", onMessage);
      });
    const rejectedSubscribe = waitForFrame((frame) => frame.type === "error");
    socket.send(
      JSON.stringify({
        type: "subscribe",
        clientType: "codex_bridge",
        projectId: context.projectId,
        sessionId: context.codex.id,
        lastSequence: 0,
      }),
    );
    await rejectedSubscribe;
    expect(frames.at(-1)).toMatchObject({ type: "error", code: "FRAME_FAILED" });

    const before = server.store.getSession(context.codex.id);
    const rejectedMutation = waitForFrame((frame) => frame.type === "error");
    socket.send(
      JSON.stringify({
        type: "heartbeat",
        heartbeat: {
          sessionId: context.codex.id,
          sequence: 777,
          workState: "WORKING",
          activeFiles: ["forged.ts"],
          queueDepth: 9,
        },
      }),
    );
    await expect(rejectedMutation).resolves.toMatchObject({
      type: "error",
      code: "SUBSCRIBE_REQUIRED",
    });
    expect(server.store.getSession(context.codex.id)).toMatchObject({
      version: before.version,
      queueDepth: before.queueDepth,
    });
    socket.close();
  });

  it("does not let the compatibility Agent bearer bind a privileged Adapter session", async () => {
    const context = await fixture();
    const before = server.store.getSession(context.codex.id);
    const socket = await server.app.injectWS("/ws");
    const closed = new Promise<{ code: number; reason: string }>((resolvePromise, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Compatibility bearer socket stayed open")),
        2000,
      );
      socket.addEventListener("close", (event: CloseEvent) => {
        clearTimeout(timeout);
        resolvePromise({ code: event.code, reason: event.reason });
      });
    });
    socket.send(
      JSON.stringify({
        type: "authenticate",
        token: server.credentials.agent.token,
      }),
    );
    await expect(closed).resolves.toMatchObject({ code: 1008 });
    expect(server.store.getSession(context.codex.id)).toEqual(before);
  });

  it("binds WebSockets to the credential identity and fails closed after revocation", async () => {
    const context = await fixture();
    const waitForFrame = (socket: TestSocket, predicate: (frame: any) => boolean) =>
      new Promise<any>((resolvePromise, reject) => {
        const timeout = setTimeout(() => reject(new Error("Timed out waiting for WS frame")), 2000);
        const onMessage = (event: MessageEvent) => {
          const frame = JSON.parse(String(event.data));
          if (!predicate(frame)) return;
          clearTimeout(timeout);
          socket.removeEventListener("message", onMessage);
          resolvePromise(frame);
        };
        socket.addEventListener("message", onMessage);
      });
    const subscribe = async (
      token: string,
      sessionId: string,
      claimedClientType: "codex_bridge" | "claude_channel",
    ) => {
      const socket = await openAgentSocket(token);
      const firstFrame = waitForFrame(
        socket,
        (frame) => frame.type === "subscribed" || frame.type === "error",
      );
      socket.send(
        JSON.stringify({
          type: "subscribe",
          clientType: claimedClientType,
          projectId: context.projectId,
          sessionId,
          lastSequence: 0,
        }),
      );
      return { socket, firstFrame };
    };

    const codexOnClaude = await subscribe(
      sessionTickets.get(context.codex.id)!.tokens.CONTROL!,
      context.claude.id,
      "codex_bridge",
    );
    const beforeCrossBindings = {
      codex: server.store.getSession(context.codex.id),
      claude: server.store.getSession(context.claude.id),
    };
    await expect(codexOnClaude.firstFrame).resolves.toMatchObject({
      type: "error",
      code: "FRAME_FAILED",
    });
    codexOnClaude.socket.close();

    const claudeOnCodex = await subscribe(
      sessionTickets.get(context.claude.id)!.tokens.CONTROL!,
      context.codex.id,
      "claude_channel",
    );
    await expect(claudeOnCodex.firstFrame).resolves.toMatchObject({
      type: "error",
      code: "FRAME_FAILED",
    });
    claudeOnCodex.socket.close();
    expect(server.store.getSession(context.codex.id)).toEqual(beforeCrossBindings.codex);
    expect(server.store.getSession(context.claude.id)).toEqual(beforeCrossBindings.claude);

    // The clientType frame is deliberately false. Authority still comes from the Codex credential.
    const codexBinding = await subscribe(
      sessionTickets.get(context.codex.id)!.tokens.CONTROL!,
      context.codex.id,
      "claude_channel",
    );
    await expect(codexBinding.firstFrame).resolves.toMatchObject({
      type: "subscribed",
      projectId: context.projectId,
    });
    const codex = codexBinding.socket;
    const heartbeatAck = waitForFrame(codex, (frame) => frame.type === "heartbeat_ack");
    codex.send(
      JSON.stringify({
        type: "heartbeat",
        heartbeat: {
          sessionId: context.codex.id,
          sequence: 780,
          workState: "WORKING",
          activeFiles: [],
          queueDepth: 4,
        },
      }),
    );
    await expect(heartbeatAck).resolves.toMatchObject({ type: "heartbeat_ack", sequence: 780 });
    const beforeRevocation = server.store.getSession(context.codex.id);

    revokeSessionTicketBundle(server.store.sqlite, {
      bundleId: sessionTickets.get(context.codex.id)!.bundleId,
      reason: "test credential revocation",
      now: new Date().toISOString(),
    });
    const framesAfterRevocation: any[] = [];
    codex.addEventListener("message", (event: MessageEvent) => {
      framesAfterRevocation.push(JSON.parse(String(event.data)));
    });
    const revoked = new Promise<{ code: number }>((resolvePromise, reject) => {
      const timeout = setTimeout(() => reject(new Error("Revoked socket stayed open")), 2000);
      codex.addEventListener("close", (event: CloseEvent) => {
        clearTimeout(timeout);
        resolvePromise({ code: event.code });
      });
    });
    codex.send(
      JSON.stringify({
        type: "heartbeat",
        heartbeat: {
          sessionId: context.codex.id,
          sequence: 781,
          workState: "WORKING",
          activeFiles: ["must-not-land"],
          queueDepth: 9,
        },
      }),
    );
    await expect(revoked).resolves.toMatchObject({ code: 1008 });
    expect(framesAfterRevocation).toEqual([]);
    expect(server.store.getSession(context.codex.id)).toEqual(beforeRevocation);
  });

  it("stops a silent subscribed socket before leaking project events after credential revocation", async () => {
    const context = await fixture();
    const socket = await openAgentSocket(sessionTickets.get(context.codex.id)!.tokens.CONTROL!);
    const framesAfterRevocation: any[] = [];
    const subscribed = new Promise<void>((resolvePromise, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Timed out waiting for subscription")),
        2000,
      );
      const onMessage = (event: MessageEvent) => {
        const frame = JSON.parse(String(event.data));
        if (frame.type !== "subscribed") return;
        clearTimeout(timeout);
        socket.removeEventListener("message", onMessage);
        resolvePromise();
      };
      socket.addEventListener("message", onMessage);
      socket.addEventListener("error", reject);
      socket.send(
        JSON.stringify({
          type: "subscribe",
          clientType: "codex_bridge",
          projectId: context.projectId,
          sessionId: context.codex.id,
          lastSequence: 0,
        }),
      );
    });
    await subscribed;
    socket.addEventListener("message", (event: MessageEvent) => {
      framesAfterRevocation.push(JSON.parse(String(event.data)));
    });
    const closed = new Promise<void>((resolvePromise, reject) => {
      const timeout = setTimeout(() => reject(new Error("Revoked socket stayed open")), 2000);
      socket.addEventListener("close", () => {
        clearTimeout(timeout);
        resolvePromise();
      });
    });

    revokeSessionTicketBundle(server.store.sqlite, {
      bundleId: sessionTickets.get(context.codex.id)!.bundleId,
      reason: "test outbound revocation",
      now: new Date().toISOString(),
    });
    const milestone = await request<any>(
      "POST",
      `/api/projects/${context.projectId}/milestones`,
      {
        objectiveId: context.objectiveId,
        title: "Must not cross the revoked socket",
        description: "The bus event is the outbound credential revalidation trigger.",
        sortOrder: 99,
        weight: 1,
        idempotencyKey: "revoked-socket-outbound-event",
      },
      server.credentials.dashboard.token,
    );
    expect(milestone.status).toBe(200);
    await closed;
    expect(framesAfterRevocation).toEqual([]);

    // A later event must be harmless after both the socket and bus subscription are terminal.
    expect(
      await request<any>(
        "POST",
        `/api/projects/${context.projectId}/milestones`,
        {
          objectiveId: context.objectiveId,
          title: "Post-close event",
          description: "Exercises idempotent unsubscribe/close cleanup.",
          sortOrder: 100,
          weight: 1,
          idempotencyKey: "revoked-socket-post-close-event",
        },
        server.credentials.dashboard.token,
      ),
    ).toMatchObject({ status: 200 });
    expect(framesAfterRevocation).toEqual([]);
  });

  it("authenticates project WebSockets against live credential scope, revocation, and expiry", async () => {
    await expectWebSocketRejected("/ws", server.credentials.capture.codex.token);

    server.store.sqlite
      .prepare("UPDATE auth_credentials SET revoked_at = ? WHERE id = 'crd_local_agent'")
      .run(new Date().toISOString());
    await expectWebSocketRejected("/ws", server.credentials.agent.token);

    // Built-in credential identities are immutable and do not expire. Drop only the fixture's
    // mutation guard to model a credential that was originally issued with an expiry, then prove
    // the WebSocket handshake evaluates that live row rather than a startup token snapshot.
    server.store.sqlite.exec("DROP TRIGGER auth_credentials_restricted_update");
    server.store.sqlite
      .prepare("UPDATE auth_credentials SET expires_at = ? WHERE id = 'crd_local_dashboard'")
      .run("2000-01-01T00:00:00.000Z");
    await expectWebSocketRejected("/ws", server.credentials.dashboard.token);
  });

  it("rejects invalid delivery frames and keeps terminal recipient state monotonic", async () => {
    const context = await fixture();
    const message = (
      await request<any>("POST", `/api/projects/${context.projectId}/messages`, {
        fromAgentId: "claude",
        fromSessionId: context.claude.id,
        recipients: [{ agentId: "codex", sessionId: context.codex.id }],
        type: "QUESTION",
        priority: "IMPORTANT",
        requiresAck: true,
        requiresResponse: true,
        summary: "Recipient state is monotonic",
        idempotencyKey: "ws-state-message",
      })
    ).body;
    const socket = await openAgentSocket(sessionTickets.get(context.codex.id)!.tokens.CONTROL!);
    const frames: any[] = [];
    const waitForFrame = (predicate: (frame: any) => boolean) =>
      new Promise<any>((resolvePromise, reject) => {
        const timeout = setTimeout(() => reject(new Error("Timed out waiting for WS frame")), 2000);
        const onMessage = (event: MessageEvent) => {
          const frame = JSON.parse(String(event.data));
          frames.push(frame);
          if (!predicate(frame)) return;
          clearTimeout(timeout);
          socket.removeEventListener("message", onMessage);
          resolvePromise(frame);
        };
        socket.addEventListener("message", onMessage);
      });
    const subscribed = waitForFrame((frame) => frame.type === "subscribed");
    socket.send(
      JSON.stringify({
        type: "subscribe",
        clientType: "codex_bridge",
        projectId: context.projectId,
        sessionId: context.codex.id,
        lastSequence: 0,
      }),
    );
    await subscribed;

    const invalidFrame = waitForFrame(
      (frame) => frame.type === "error" && frame.code === "INVALID_DELIVERY_FRAME",
    );
    socket.send(JSON.stringify({ type: "delivery", messageId: message.id, state: "GARBAGE" }));
    await expect(invalidFrame).resolves.toMatchObject({ code: "INVALID_DELIVERY_FRAME" });
    expect(
      (await request<any>("GET", `/api/messages/${message.id}`)).body.recipients[0],
    ).toMatchObject({ state: "PENDING" });

    const surface = await request<any>("POST", `/api/messages/${message.id}/surface-attempts`, {
      sessionId: context.codex.id,
      idempotencyKey: "ws-state-surface",
    });
    expect(surface).toMatchObject({ status: 200 });
    const missingFence = waitForFrame(
      (frame) => frame.type === "error" && frame.code === "INVALID_DELIVERY_FRAME",
    );
    socket.send(
      JSON.stringify({
        type: "delivery",
        messageId: message.id,
        state: "DELIVERED",
        surfaceAttemptId: surface.body.permit.id,
        idempotencyKey: "ws-state-delivered-missing-fence",
      }),
    );
    await expect(missingFence).resolves.toMatchObject({ code: "INVALID_DELIVERY_FRAME" });

    const wrongFence = waitForFrame(
      (frame) => frame.type === "error" && frame.code === "FRAME_FAILED",
    );
    socket.send(
      JSON.stringify({
        type: "delivery",
        messageId: message.id,
        state: "DELIVERED",
        surfaceAttemptId: surface.body.permit.id,
        recipientFence: surface.body.permit.recipientFence + 1,
        idempotencyKey: "ws-state-delivered-wrong-fence",
      }),
    );
    await expect(wrongFence).resolves.toMatchObject({ code: "FRAME_FAILED" });
    expect(
      (await request<any>("GET", `/api/messages/${message.id}`)).body.recipients[0],
    ).toMatchObject({ state: "PENDING" });

    const deliveredAck = waitForFrame(
      (frame) => frame.type === "delivery_ack" && frame.messageId === message.id,
    );
    socket.send(
      JSON.stringify({
        type: "delivery",
        messageId: message.id,
        state: "DELIVERED",
        surfaceAttemptId: surface.body.permit.id,
        recipientFence: surface.body.permit.recipientFence,
        idempotencyKey: "ws-state-delivered-with-permit",
      }),
    );
    await expect(deliveredAck).resolves.toMatchObject({ type: "delivery_ack" });
    expect(
      (await request<any>("GET", `/api/messages/${message.id}`)).body.recipients[0],
    ).toMatchObject({ state: "DELIVERED" });

    expect(
      await request<any>("POST", `/api/messages/${message.id}/responded`, {
        sessionId: context.codex.id,
        idempotencyKey: "ws-state-responded",
      }),
    ).toMatchObject({ status: 200 });
    const failedAck = waitForFrame(
      (frame) => frame.type === "delivery_ack" && frame.messageId === message.id,
    );
    socket.send(
      JSON.stringify({
        type: "delivery",
        messageId: message.id,
        state: "FAILED",
        error: "late transport report",
        idempotencyKey: "ws-state-late-failed",
      }),
    );
    await expect(failedAck).resolves.toMatchObject({ type: "delivery_ack" });
    expect(
      (await request<any>("GET", `/api/messages/${message.id}`)).body.recipients[0],
    ).toMatchObject({ state: "RESPONDED", lastError: null });
    expect(
      await request<any>("POST", `/api/messages/${message.id}/surface-attempts`, {
        sessionId: context.codex.id,
        idempotencyKey: "ws-state-reopen",
      }),
    ).toMatchObject({ status: 409, body: { code: "MESSAGE_ALREADY_SURFACED" } });
    socket.close();
    expect(frames.some((frame) => frame.code === "INVALID_DELIVERY_FRAME")).toBe(true);
  });
});
