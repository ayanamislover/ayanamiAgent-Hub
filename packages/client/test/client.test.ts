import { describe, expect, it, vi } from "vitest";
import { HubClient, openProjectSocket } from "../src/index.js";

class FakeSocket extends EventTarget {
  readyState = 0;
  readonly sent: string[] = [];
  readonly closes: Array<{ code?: number; reason?: string }> = [];

  send(value: string): void {
    this.sent.push(value);
  }

  receive(value: string): void {
    this.dispatchEvent(new MessageEvent("message", { data: value }));
  }

  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason });
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }
}

function directiveFixture() {
  return {
    id: "dir_1234",
    projectId: "prj_1234",
    authority: "USER_ATTESTED",
    lifecycle: "ACTIVE",
    verification: "UNVERIFIED",
    sourceUserTurnId: "utr_1234",
    rawUserTurnSha256: "a".repeat(64),
    verbatimText: "exact user text",
    verbatimTextSha256: "b".repeat(64),
    quoteStart: 0,
    quoteEnd: 15,
    delegatedText: null,
    agentInterpretation: "agent note",
    relayPrincipalId: "prn_agent_codex",
    relayAgentId: "codex",
    relaySessionId: null,
    targetAgentIds: ["claude"],
    scope: { objective_id: null, task_ids: [], file_globs: [] },
    priority: "IMPORTANT",
    delegationGrantId: null,
    delegationVersion: null,
    attemptedDelegationGrantId: null,
    attemptedDelegationVersion: null,
    supersedesDirectiveId: null,
    serverSequence: 3,
    issuedAt: "2026-08-01T00:00:00.000Z",
    expiresAt: null,
    keyId: `ed25519:${"k".repeat(43)}`,
    canonicalPayloadSha256: "c".repeat(64),
    signature: "s".repeat(86),
    carrierMessageId: "msg_1234",
    causationId: "utr_1234",
    correlationId: "dir_1234",
    downgradeReason: null,
  };
}

function deliveryBindingFixture() {
  return {
    projectId: "prj_1234",
    carrierMessageId: "msg_1234",
    targetAgentId: "claude" as const,
    targetSessionId: "ses_1234",
    targetSessionIncarnation: 4,
    surfaceAttemptId: "srf_1234",
    recipientFence: 2,
    state: "ACTIVE" as const,
  };
}

function ordinaryAuthorityCandidateFixture() {
  return {
    kind: "ORDINARY" as const,
    message: {
      priority: "IMPORTANT" as const,
      id: "msg_1234",
      threadId: "thr_1234",
      fromAgentId: "codex",
      summary: "ordinary coordination note",
    },
    delivery: deliveryBindingFixture(),
  };
}

function authorityCandidateFixture() {
  const directive = directiveFixture();
  const payload = {
    type: "crossagent.user-directive-attestation.v2" as const,
    schema_version: 2 as const,
    directive_id: directive.id,
    project_id: directive.projectId,
    carrier_message_id: directive.carrierMessageId,
    authority: "USER_ATTESTED" as const,
    source: {
      user_turn_id: directive.sourceUserTurnId,
      client_type: "codex" as const,
      session_id: "desktop-session",
      turn_id: "turn-1",
      raw_user_turn_sha256: directive.rawUserTurnSha256,
    },
    quote: {
      start_utf16: directive.quoteStart,
      end_utf16: directive.quoteEnd,
      verbatim_text: directive.verbatimText,
      verbatim_text_sha256: directive.verbatimTextSha256,
    },
    delegated_instruction: null,
    relay: {
      principal_id: directive.relayPrincipalId,
      agent_id: directive.relayAgentId,
      session_id: directive.relaySessionId,
    },
    audience: { target_agent_ids: directive.targetAgentIds },
    scope: directive.scope,
    delegation: null,
    supersedes_directive_id: directive.supersedesDirectiveId,
    priority: directive.priority,
    server_sequence: directive.serverSequence,
    issued_at: directive.issuedAt,
    expires_at: directive.expiresAt,
    key_id: directive.keyId,
    causation_id: directive.causationId,
    correlation_id: directive.correlationId,
  };
  return {
    kind: "AUTHORITY" as const,
    bundle: {
      authorityBundle: {
        directive,
        attestation: {
          payload,
          canonical_payload_sha256: directive.canonicalPayloadSha256,
          signature: directive.signature,
        },
      },
      signingKey: {
        keyId: directive.keyId,
        algorithm: "Ed25519" as const,
        publicKeySpkiBase64Url: "a2V5",
        fingerprintSha256: "d".repeat(64),
        status: "ACTIVE" as const,
        createdAt: "2026-08-01T00:00:00.000Z",
      },
      delegationGrant: null,
      delivery: deliveryBindingFixture(),
    },
  };
}

function adapterSessionFixture() {
  const timestamp = "2026-08-01T04:00:00.000Z";
  return {
    id: "ses_1234",
    projectId: "prj_1234",
    agentId: "codex",
    role: "primary" as const,
    client: "codex-app-server" as const,
    transport: "websocket" as const,
    deliveryMode: "app_server_push" as const,
    externalSessionId: "external-1",
    externalThreadId: "thread-1",
    externalTurnId: null,
    host: "localhost",
    pid: 1234,
    cwd: "C:\\work\\crossagent-hub",
    gitBranch: null,
    gitHead: null,
    capabilities: [],
    connectedAt: timestamp,
    transportLastSeenAt: timestamp,
    activityLastSeenAt: null,
    currentTaskId: null,
    currentReviewId: null,
    activeFiles: [],
    workState: "IDLE" as const,
    connectionState: "ONLINE" as const,
    queueDepth: 0,
    lineageId: "lin_1234",
    incarnation: 2,
    predecessorSessionId: null,
    supersededBySessionId: null,
    launcherRunId: "run_1234",
    launchGeneration: 1,
    version: 1,
  };
}

function sessionTicketBindingFixture() {
  return {
    bundleId: "stb_1234",
    state: "ACTIVE" as const,
    projectId: "prj_1234",
    agentId: "codex" as const,
    adapterClient: "codex" as const,
    hubSessionId: "ses_1234",
    lineageId: "lin_1234",
    incarnation: 2,
    runId: "run_1234",
    activatedAt: "2026-08-01T04:00:00.000Z",
    expiresAt: "2026-08-02T04:00:00.000Z",
    purposes: [
      { id: "stk_control", purpose: "CONTROL" as const, state: "ACTIVE" as const },
      { id: "stk_mcp", purpose: "MODEL_MCP" as const, state: "ACTIVE" as const },
      { id: "stk_injector", purpose: "INJECTOR" as const, state: "ACTIVE" as const },
    ],
  };
}

function terminalSessionTicketBindingFixture() {
  const terminalAt = "2026-08-01T04:30:00.000Z";
  const terminalReason = "SESSION_CLOSED:hook_session_end";
  return {
    ...sessionTicketBindingFixture(),
    state: "REVOKED" as const,
    terminalAt,
    terminalReason,
    purposes: sessionTicketBindingFixture().purposes.map((entry) => ({
      ...entry,
      state: "REVOKED" as const,
      terminalAt,
      terminalReason,
    })),
  };
}

describe("HubClient", () => {
  it("includes a strict backward message cursor for full 500-row recovery pages", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(
        `http://hub.test/api/projects/prj_1234/messages?sessionId=ses_exact&unresolved=true&limit=500&beforeSequence=${Number.MAX_SAFE_INTEGER}`,
      );
      expect(init?.method).toBe("GET");
      return Response.json([]);
    });
    const client = new HubClient({
      baseUrl: "http://hub.test",
      fetch: fetchMock as typeof fetch,
    });

    await expect(
      client.listMessages("prj_1234", {
        sessionId: "ses_exact",
        unresolved: true,
        limit: 500,
        beforeSequence: Number.MAX_SAFE_INTEGER,
      }),
    ).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("rejects invalid backward message cursors before issuing a request", () => {
    const fetchMock = vi.fn(async () => Response.json([]));
    const client = new HubClient({ fetch: fetchMock as typeof fetch });

    for (const beforeSequence of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      expect(() => client.listMessages("prj_1234", { beforeSequence } as never)).toThrow(
        "beforeSequence must be a positive safe integer",
      );
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requests only the exact session recipient's unsettled inbox", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(
        `http://hub.test/api/projects/prj_1234/messages?agentId=codex&sessionId=ses_successor&recipientUnsettled=true&limit=500&beforeSequence=${Number.MAX_SAFE_INTEGER}`,
      );
      expect(init?.method).toBe("GET");
      return Response.json([]);
    });
    const client = new HubClient({
      baseUrl: "http://hub.test",
      fetch: fetchMock as typeof fetch,
    });

    await expect(
      client.listMessages("prj_1234", {
        agentId: "codex",
        sessionId: "ses_successor",
        recipientUnsettled: true,
        limit: 500,
        beforeSequence: Number.MAX_SAFE_INTEGER,
      }),
    ).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("rejects incomplete or ambiguous recipient-unsettled filters before issuing a request", () => {
    const fetchMock = vi.fn(async () => Response.json([]));
    const client = new HubClient({ fetch: fetchMock as typeof fetch });

    expect(() =>
      client.listMessages("prj_1234", {
        sessionId: "ses_successor",
        recipientUnsettled: true,
      }),
    ).toThrow("recipientUnsettled requires agentId and sessionId");
    expect(() =>
      client.listMessages("prj_1234", {
        agentId: "codex",
        recipientUnsettled: true,
      }),
    ).toThrow("recipientUnsettled requires agentId and sessionId");
    expect(() =>
      client.listMessages("prj_1234", {
        agentId: "codex",
        sessionId: "ses_successor",
        recipientUnsettled: true,
        unread: true,
      }),
    ).toThrow("recipientUnsettled cannot be combined with unread or unresolved");
    expect(() =>
      client.listMessages("prj_1234", {
        agentId: "codex",
        sessionId: "ses_successor",
        recipientUnsettled: true,
        unresolved: true,
      }),
    ).toThrow("recipientUnsettled cannot be combined with unread or unresolved");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts the exact relay contract and strictly validates Authority directives", async () => {
    const input = {
      source_user_turn_id: "utr_1234",
      target_agent_ids: ["claude" as const],
      verbatim_text: "exact user text",
      quote_start: 0,
      quote_end: 15,
      agent_interpretation: "agent note",
      objective_id: null,
      task_ids: [],
      file_globs: [],
      idempotency_key: "relay:1234",
    };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://hub.test/api/projects/prj_1234/directives/relay");
      expect(JSON.parse(String(init?.body))).toEqual(input);
      return Response.json(directiveFixture());
    });
    const client = new HubClient({
      baseUrl: "http://hub.test",
      token: "codex-agent-token",
      fetch: fetchMock as typeof fetch,
    });
    await expect(client.relayUserDirective("prj_1234", input)).resolves.toMatchObject({
      id: "dir_1234",
      authority: "USER_ATTESTED",
      verification: "UNVERIFIED",
    });

    const malformed = new HubClient({
      fetch: async () => Response.json({ ...directiveFixture(), forgedVerification: "VALID" }),
    });
    await expect(malformed.relayUserDirective("prj_1234", input)).rejects.toThrow();
  });

  it("posts the Dashboard-only supersession contract and validates its successor", async () => {
    const input = {
      source_user_turn_id: "utr_5678",
      target_agent_ids: ["claude" as const],
      verbatim_text: "corrected user text",
      quote_start: 0,
      quote_end: 19,
      agent_interpretation: null,
      objective_id: null,
      task_ids: [],
      file_globs: [],
      reason: "The user corrected the instruction.",
      idempotency_key: "supersede:1234",
    };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://hub.test/api/directives/dir_1234/supersede");
      expect(JSON.parse(String(init?.body))).toEqual(input);
      return Response.json({
        ...directiveFixture(),
        id: "dir_5678",
        sourceUserTurnId: "utr_5678",
        supersedesDirectiveId: "dir_1234",
        correlationId: "dir_5678",
      });
    });
    const client = new HubClient({
      baseUrl: "http://hub.test",
      token: "dashboard-token",
      fetch: fetchMock as typeof fetch,
    });
    await expect(client.supersedeUserDirective("dir_1234", input)).resolves.toMatchObject({
      id: "dir_5678",
      supersedesDirectiveId: "dir_1234",
    });
  });

  it("uses its configured bearer and strictly validates prepared synthetic prompts", async () => {
    const preparedAt = "2026-07-31T12:00:00.000Z";
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://hub.test/api/messages/msg_1234/synthetic-prompts");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer injector-secret");
      expect(JSON.parse(String(init?.body))).toEqual({
        injector_hub_session_id: "ses_1234",
        surface_attempt_id: "srf_1234",
        recipient_fence: 2,
        rpc_method: "turn/start",
        idempotency_key: "prepare:msg-1234",
      });
      return Response.json({
        id: "spr_1234",
        sourceMessageId: "msg_1234",
        surfaceAttemptId: "srf_1234",
        recipientFence: 2,
        rpcMethod: "turn/start",
        originNonce: "n".repeat(43),
        text: "synthetic prompt",
        rawTextSha256: "a".repeat(64),
        authorityCandidate: ordinaryAuthorityCandidateFixture(),
        preparedAt,
        expiresAt: "2026-07-31T12:02:00.000Z",
        state: "PREPARED",
        replayed: false,
      });
    });
    const client = new HubClient({
      baseUrl: "http://hub.test",
      token: "injector-secret",
      fetch: fetchMock as typeof fetch,
    });

    await expect(
      client.prepareSyntheticPrompt("msg_1234", {
        injector_hub_session_id: "ses_1234",
        surface_attempt_id: "srf_1234",
        recipient_fence: 2,
        rpc_method: "turn/start",
        idempotency_key: "prepare:msg-1234",
      }),
    ).resolves.toMatchObject({ id: "spr_1234", state: "PREPARED" });
  });

  it("rejects an otherwise valid prepared prompt when authorityCandidate is missing", async () => {
    const client = new HubClient({
      token: "injector-secret",
      fetch: async () =>
        Response.json({
          id: "spr_1234",
          sourceMessageId: "msg_1234",
          surfaceAttemptId: "srf_1234",
          recipientFence: 2,
          rpcMethod: "turn/start",
          originNonce: "n".repeat(43),
          text: "synthetic prompt",
          rawTextSha256: "a".repeat(64),
          preparedAt: "2026-08-01T00:00:00.000Z",
          expiresAt: "2026-08-01T00:02:00.000Z",
          state: "PREPARED",
          replayed: false,
        }),
    });

    await expect(
      client.prepareSyntheticPrompt("msg_1234", {
        injector_hub_session_id: "ses_1234",
        surface_attempt_id: "srf_1234",
        recipient_fence: 2,
        rpc_method: "turn/start",
        idempotency_key: "prepare:missing-authority-candidate",
      }),
    ).rejects.toThrow();
  });

  it.each([
    ["ordinary", ordinaryAuthorityCandidateFixture()],
    ["signed authority", authorityCandidateFixture()],
  ])("posts the exact authority-delivery surface contract and parses %s", async (_label, body) => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://hub.test/api/messages/msg_1234/authority-delivery");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({
        session_id: "ses_1234",
        surface_attempt_id: "srf_1234",
        recipient_fence: 2,
      });
      return Response.json(body);
    });
    const client = new HubClient({ baseUrl: "http://hub.test", fetch: fetchMock as typeof fetch });

    await expect(
      client.getAuthorityDeliveryCandidate("msg_1234", {
        session_id: "ses_1234",
        surface_attempt_id: "srf_1234",
        recipient_fence: 2,
      }),
    ).resolves.toEqual(body);
  });

  it("rejects missing and unknown authority-delivery candidate fields", async () => {
    const invalidCandidates = [
      { ...ordinaryAuthorityCandidateFixture(), delivery: undefined },
      { ...ordinaryAuthorityCandidateFixture(), forgedVerification: "VALID" },
    ];
    for (const invalidCandidate of invalidCandidates) {
      const client = new HubClient({ fetch: async () => Response.json(invalidCandidate) });
      await expect(
        client.getAuthorityDeliveryCandidate("msg_1234", {
          session_id: "ses_1234",
          surface_attempt_id: "srf_1234",
          recipient_fence: 2,
        }),
      ).rejects.toThrow();
    }
  });

  it.each([
    ["ordinary", ordinaryAuthorityCandidateFixture()],
    ["signed authority", authorityCandidateFixture()],
  ])(
    "recovers a confirmed %s delivery with an exact session-only request",
    async (_label, candidate) => {
      const permit = {
        id: "srf_1234",
        messageId: "msg_1234",
        recipientId: "rcp_1234",
        sessionId: "ses_1234",
        sessionIncarnation: 4,
        recipientFence: 2,
        state: "CONFIRMED" as const,
        error: null,
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:01:00.000Z",
        confirmedAt: "2026-08-01T00:01:00.000Z",
      };
      const recoveredFor = {
        kind: "CURRENT_SESSION" as const,
        sessionId: "ses_1234",
        sessionIncarnation: 4,
      };
      const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
        expect(url).toBe("http://hub.test/api/messages/msg_1234/authority-delivery/recover");
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toEqual({ session_id: "ses_1234" });
        return Response.json({ permit, candidate, recoveredFor });
      });
      const client = new HubClient({
        baseUrl: "http://hub.test",
        fetch: fetchMock as typeof fetch,
      });

      await expect(
        client.recoverAuthorityDelivery("msg_1234", { session_id: "ses_1234" }),
      ).resolves.toEqual({ permit, candidate, recoveredFor });
    },
  );

  it("keeps predecessor proof immutable while identifying the exact lineage successor", async () => {
    const permit = {
      id: "srf_1234",
      messageId: "msg_1234",
      recipientId: "rcp_1234",
      sessionId: "ses_1234",
      sessionIncarnation: 4,
      recipientFence: 2,
      state: "CONFIRMED" as const,
      error: null,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:01:00.000Z",
      confirmedAt: "2026-08-01T00:01:00.000Z",
    };
    const candidate = authorityCandidateFixture();
    const recoveredFor = {
      kind: "LINEAGE_HANDOFF" as const,
      sessionId: "ses_successor",
      sessionIncarnation: 5,
      lineageId: "lin_1234",
    };
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({ session_id: "ses_successor" });
      return Response.json({ permit, candidate, recoveredFor });
    });
    const client = new HubClient({ fetch: fetchMock as typeof fetch });

    await expect(
      client.recoverAuthorityDelivery("msg_1234", { session_id: "ses_successor" }),
    ).resolves.toEqual({ permit, candidate, recoveredFor });
    expect(candidate.bundle.delivery.targetSessionId).toBe(permit.sessionId);
    expect(recoveredFor.sessionId).not.toBe(permit.sessionId);
  });

  it("strictly rejects malformed confirmed-delivery recovery responses", async () => {
    const permit = {
      id: "srf_1234",
      messageId: "msg_1234",
      recipientId: "rcp_1234",
      sessionId: "ses_1234",
      sessionIncarnation: 4,
      recipientFence: 2,
      state: "CONFIRMED",
      error: null,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:01:00.000Z",
      confirmedAt: "2026-08-01T00:01:00.000Z",
    };
    for (const malformed of [
      {
        permit: { ...permit, state: "ACTIVE" },
        candidate: ordinaryAuthorityCandidateFixture(),
        recoveredFor: { kind: "CURRENT_SESSION", sessionId: "ses_1234", sessionIncarnation: 4 },
      },
      {
        permit,
        candidate: ordinaryAuthorityCandidateFixture(),
        recoveredFor: { kind: "CURRENT_SESSION", sessionId: "ses_1234", sessionIncarnation: 4 },
        forged: true,
      },
      { permit },
      {
        permit,
        candidate: ordinaryAuthorityCandidateFixture(),
        recoveredFor: {
          kind: "LINEAGE_HANDOFF",
          sessionId: "ses_successor",
          sessionIncarnation: 5,
        },
      },
    ]) {
      const client = new HubClient({ fetch: async () => Response.json(malformed) });
      await expect(
        client.recoverAuthorityDelivery("msg_1234", { session_id: "ses_1234" }),
      ).rejects.toThrow();
    }
  });

  it("strictly validates the complete authority signing-key list", async () => {
    const key = authorityCandidateFixture().bundle.signingKey;
    const valid = new HubClient({ fetch: async () => Response.json([key]) });
    await expect(valid.listAuthoritySigningKeys()).resolves.toEqual([key]);

    const malformedTopLevel = new HubClient({ fetch: async () => Response.json({ keys: [key] }) });
    await expect(malformedTopLevel.listAuthoritySigningKeys()).rejects.toThrow();

    const unknownKeyField = new HubClient({
      fetch: async () => Response.json([{ ...key, forged: true }]),
    });
    await expect(unknownKeyField.listAuthoritySigningKeys()).rejects.toThrow();
  });

  it("rejects a malformed prepared synthetic prompt instead of casting it", async () => {
    const client = new HubClient({
      token: "injector-secret",
      fetch: async () => Response.json({ id: "spr_1234", state: "PREPARED", forged: true }),
    });

    await expect(
      client.prepareSyntheticPrompt("msg_1234", {
        injector_hub_session_id: "ses_1234",
        surface_attempt_id: "srf_1234",
        recipient_fence: 1,
        rpc_method: "turn/start",
        idempotency_key: "prepare:malformed",
      }),
    ).rejects.toThrow();
  });

  it("aborts a synthetic reservation with the injector bearer and validates the response", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://hub.test/api/synthetic-prompts/spr_1234/abort");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer injector-secret");
      expect(JSON.parse(String(init?.body))).toEqual({
        injector_hub_session_id: "ses_1234",
        surface_attempt_id: "srf_1234",
        recipient_fence: 2,
        reason: "turn/steer rejected before side effects",
        idempotency_key: "abort:spr-1234",
      });
      return Response.json({
        id: "spr_1234",
        sourceMessageId: "msg_1234",
        surfaceAttemptId: "srf_1234",
        recipientFence: 2,
        rpcMethod: "turn/steer",
        state: "ABORTED",
        abortedAt: "2026-08-01T00:00:00.000Z",
        reason: "turn/steer rejected before side effects",
        replayed: false,
      });
    });
    const client = new HubClient({
      baseUrl: "http://hub.test",
      token: "injector-secret",
      fetch: fetchMock as typeof fetch,
    });
    await expect(
      client.abortSyntheticPrompt("spr_1234", {
        injector_hub_session_id: "ses_1234",
        surface_attempt_id: "srf_1234",
        recipient_fence: 2,
        reason: "turn/steer rejected before side effects",
        idempotency_key: "abort:spr-1234",
      }),
    ).resolves.toMatchObject({ id: "spr_1234", state: "ABORTED" });
  });

  it("rejects a malformed synthetic abort response instead of trusting terminal state", async () => {
    const client = new HubClient({
      token: "injector-secret",
      fetch: async () =>
        Response.json({
          id: "spr_1234",
          state: "ABORTED",
          replayed: false,
          forged: true,
        }),
    });

    await expect(
      client.abortSyntheticPrompt("spr_1234", {
        injector_hub_session_id: "ses_1234",
        surface_attempt_id: "srf_1234",
        recipient_fence: 2,
        reason: "rejected before side effects",
        idempotency_key: "abort:malformed",
      }),
    ).rejects.toThrow();
  });

  it("offers only a local ticket digest and strictly parses replay-safe metadata", async () => {
    const input = {
      bundle_id: "stb_1234",
      purpose: "CONTROL" as const,
      token_sha256: "a".repeat(64),
      adapter_client: "codex" as const,
      agent_id: "codex" as const,
      session_client: "codex-app-server" as const,
      role: "primary" as const,
      transport: "websocket" as const,
      delivery_mode: "app_server_push" as const,
      external_session_id: "external-1",
      external_thread_id: "thread-1",
      run_id: "run_1234",
      activation_mode: "FIRST_LINEAGE" as const,
      idempotency_key: "ticket-offer:control",
    };
    const response = {
      id: "stk_control",
      bundle_id: input.bundle_id,
      purpose: input.purpose,
      state: "PENDING" as const,
      project_id: "prj_1234",
      adapter_client: input.adapter_client,
      agent_id: input.agent_id,
      session_client: input.session_client,
      role: input.role,
      transport: input.transport,
      delivery_mode: input.delivery_mode,
      external_session_id: input.external_session_id,
      external_thread_id: input.external_thread_id,
      run_id: input.run_id,
      offer_expires_at: "2026-08-01T04:10:00.000Z",
    };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://hub.test/api/projects/prj_1234/session-ticket-offers");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual(input);
      expect(String(init?.body)).not.toContain("raw");
      return Response.json(structuredClone(response));
    });
    const bootstrap = new HubClient({
      baseUrl: "http://hub.test",
      token: "bootstrap-secret",
      fetch: fetchMock as typeof fetch,
    });

    await expect(bootstrap.createSessionTicketOffer("prj_1234", input)).resolves.toEqual(response);
    await expect(bootstrap.createSessionTicketOffer("prj_1234", input)).resolves.toEqual(response);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    expect(() =>
      bootstrap.createSessionTicketOffer("prj_1234", {
        ...input,
        raw_token: "must-never-leave-adapter",
      } as typeof input),
    ).toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects ticket offer responses that expose a digest, raw token, or unknown field", async () => {
    const base = {
      id: "stk_control",
      bundle_id: "stb_1234",
      purpose: "CONTROL",
      state: "PENDING",
      project_id: "prj_1234",
      adapter_client: "codex",
      agent_id: "codex",
      session_client: "codex-app-server",
      role: "primary",
      transport: "websocket",
      delivery_mode: "app_server_push",
      external_session_id: "external-1",
      external_thread_id: "thread-1",
      run_id: "run_1234",
      offer_expires_at: "2026-08-01T04:10:00.000Z",
    };
    for (const forbidden of [
      { token_sha256: "a".repeat(64) },
      { raw_token: "secret" },
      { replayed: true },
      { expires_at: "2099-01-01T00:00:00.000Z" },
      { project_id: "prj_other" },
      { role: "reviewer" },
      { transport: "hook-poll" },
      { delivery_mode: "mailbox" },
      { external_session_id: "external-other" },
      { external_thread_id: "thread-other" },
      { offer_expires_at: "2026-08-01T06:10:00.000+02:00" },
    ]) {
      const client = new HubClient({ fetch: async () => Response.json({ ...base, ...forbidden }) });
      await expect(
        client.createSessionTicketOffer("prj_1234", {
          bundle_id: "stb_1234",
          purpose: "CONTROL",
          token_sha256: "a".repeat(64),
          adapter_client: "codex",
          agent_id: "codex",
          session_client: "codex-app-server",
          role: "primary",
          transport: "websocket",
          delivery_mode: "app_server_push",
          external_session_id: "external-1",
          external_thread_id: "thread-1",
          run_id: "run_1234",
          activation_mode: "FIRST_LINEAGE",
          idempotency_key: "ticket-offer:strict-response",
        }),
      ).rejects.toThrow();
    }
  });

  it("normalizes deferred identity and refuses caller-controlled ticket expiry", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).not.toHaveProperty("expires_at");
      expect(body.external_session_id).toBeNull();
      expect(body.external_thread_id).toBeNull();
      return Response.json({
        id: "stk_control",
        bundle_id: body.bundle_id,
        purpose: body.purpose,
        state: "PENDING",
        project_id: "prj_1234",
        adapter_client: body.adapter_client,
        agent_id: body.agent_id,
        session_client: body.session_client,
        role: body.role,
        transport: body.transport,
        delivery_mode: body.delivery_mode,
        external_session_id: body.external_session_id,
        external_thread_id: body.external_thread_id,
        run_id: body.run_id,
        offer_expires_at: "2026-08-01T04:10:00.000Z",
      });
    });
    const client = new HubClient({ fetch: fetchMock as typeof fetch });

    await expect(
      client.createSessionTicketOffer("prj_1234", {
        bundle_id: "stb_1234",
        purpose: "CONTROL",
        token_sha256: "a".repeat(64),
        adapter_client: "codex",
        agent_id: "codex",
        session_client: "codex-app-server",
        role: "primary",
        transport: "websocket",
        delivery_mode: "app_server_push",
        run_id: "run_1234",
        activation_mode: "FIRST_LINEAGE",
        idempotency_key: "ticket-offer:server-expiry",
      }),
    ).resolves.toMatchObject({ offer_expires_at: "2026-08-01T04:10:00.000Z" });
    expect(fetchMock).toHaveBeenCalledOnce();

    expect(() =>
      client.createSessionTicketOffer("prj_1234", {
        bundle_id: "stb_1234",
        purpose: "CONTROL",
        token_sha256: "a".repeat(64),
        adapter_client: "codex",
        agent_id: "codex",
        session_client: "codex-app-server",
        role: "primary",
        transport: "websocket",
        delivery_mode: "app_server_push",
        run_id: "run_1234",
        activation_mode: "FIRST_LINEAGE",
        expires_at: "2099-01-01T00:00:00.000Z",
        idempotency_key: "ticket-offer:forged-expiry",
      } as never),
    ).toThrow();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("preserves an explicit null managed head for a reserved first lineage", async () => {
    const input = {
      bundle_id: "stb_1234",
      purpose: "CONTROL" as const,
      token_sha256: "a".repeat(64),
      adapter_client: "codex" as const,
      agent_id: "codex" as const,
      session_client: "codex-app-server" as const,
      role: "primary" as const,
      transport: "websocket" as const,
      delivery_mode: "app_server_push" as const,
      external_session_id: null,
      external_thread_id: "thread-new",
      run_id: "run_1234",
      activation_mode: "MANAGED_RESERVATION" as const,
      expected_lineage_id: "lin_1234",
      expected_head_session_id: null,
      launch_reservation_id: "rsr_1234",
      idempotency_key: "ticket-offer:managed-first-lineage",
    };
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual(input);
      return Response.json({
        id: "stk_control",
        bundle_id: input.bundle_id,
        purpose: input.purpose,
        state: "PENDING",
        project_id: "prj_1234",
        adapter_client: input.adapter_client,
        agent_id: input.agent_id,
        session_client: input.session_client,
        role: input.role,
        transport: input.transport,
        delivery_mode: input.delivery_mode,
        external_session_id: input.external_session_id,
        external_thread_id: input.external_thread_id,
        run_id: input.run_id,
        offer_expires_at: "2026-08-01T04:10:00.000Z",
      });
    });
    const client = new HubClient({ fetch: fetchMock as typeof fetch });

    await expect(client.createSessionTicketOffer("prj_1234", input)).resolves.toMatchObject({
      bundle_id: input.bundle_id,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("registers a real Adapter and preserves TTL truth across a 23-hour replay", async () => {
    const input = {
      agentId: "codex",
      role: "primary" as const,
      client: "codex-app-server" as const,
      transport: "websocket" as const,
      deliveryMode: "app_server_push" as const,
      externalSessionId: "external-1",
      externalThreadId: "thread-1",
      host: "localhost",
      cwd: "C:\\work\\crossagent-hub",
      capabilities: [],
      ticket_bundle_id: "stb_1234",
      idempotencyKey: "register:ticketed",
    };
    const stateReceipt = {
      session: adapterSessionFixture(),
      ticketBinding: sessionTicketBindingFixture(),
    };
    const serverTimes = ["2026-08-01T04:00:01.000Z", "2026-08-02T03:00:01.000Z"];
    let responseIndex = 0;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://hub.test/api/projects/prj_1234/sessions");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer control-ticket-raw");
      expect(JSON.parse(String(init?.body))).toEqual(input);
      expect(String(init?.body)).not.toContain("control-ticket-raw");
      return Response.json({ ...stateReceipt, serverNow: serverTimes[responseIndex++] });
    });
    const control = new HubClient({
      baseUrl: "http://hub.test",
      token: "bootstrap-secret",
      fetch: fetchMock as typeof fetch,
    }).withToken("control-ticket-raw");

    const original = await control.registerAdapterSession("prj_1234", input);
    const delayedReplay = await control.registerAdapterSession("prj_1234", input);
    expect(original.ticketBinding).toEqual(delayedReplay.ticketBinding);
    expect(delayedReplay.ticketBinding.expiresAt).toBe("2026-08-02T04:00:00.000Z");
    expect(original.serverNow).toBe(serverTimes[0]);
    expect(delayedReplay.serverNow).toBe(serverTimes[1]);
    expect(Date.parse(delayedReplay.serverNow) - Date.parse(original.serverNow)).toBe(
      23 * 60 * 60 * 1_000,
    );
    expect(() =>
      control.registerAdapterSession("prj_1234", {
        ...input,
        session_id: "ambiguous-and-forbidden",
      } as typeof input),
    ).toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects malformed or secret-bearing Adapter registration results", async () => {
    const input = {
      agentId: "codex",
      client: "codex-app-server" as const,
      transport: "websocket" as const,
      deliveryMode: "app_server_push" as const,
      host: "localhost",
      cwd: "C:\\work\\crossagent-hub",
      capabilities: [],
      ticket_bundle_id: "stb_1234",
      idempotencyKey: "register:strict-response",
    };
    const valid = {
      session: adapterSessionFixture(),
      ticketBinding: sessionTicketBindingFixture(),
      serverNow: "2026-08-01T04:00:01.000Z",
    };
    for (const malformed of [
      { ...valid, serverNow: undefined },
      { ...valid, serverNow: "2026-08-01T06:00:01.000+02:00" },
      { ...valid, raw_token: "secret" },
      { ...valid, ticketBinding: { ...valid.ticketBinding, tokenSha256: "a".repeat(64) } },
      { ...valid, ticketBinding: { ...valid.ticketBinding, hubSessionId: "ses_other" } },
      { ...valid, ticketBinding: { ...valid.ticketBinding, bundleId: "stb_other" } },
    ]) {
      const client = new HubClient({ fetch: async () => Response.json(malformed) });
      await expect(client.registerAdapterSession("prj_1234", input)).rejects.toThrow();
    }
  });

  it("closes a ticketed Adapter session with one strict idempotent terminal receipt", async () => {
    const input = {
      reason: "hook_session_end",
      idempotencyKey: "close:session-end:ses_1234",
    };
    const response = {
      session: {
        ...adapterSessionFixture(),
        connectionState: "OFFLINE" as const,
        version: 2,
      },
      ticketBinding: terminalSessionTicketBindingFixture(),
    };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://hub.test/api/sessions/ses_1234/close");
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer control-ticket-raw");
      expect(JSON.parse(String(init?.body))).toEqual(input);
      expect(String(init?.body)).not.toContain("control-ticket-raw");
      return Response.json(structuredClone(response));
    });
    const control = new HubClient({
      baseUrl: "http://hub.test",
      token: "bootstrap-secret",
      fetch: fetchMock as typeof fetch,
    }).withToken("control-ticket-raw");

    await expect(control.closeAdapterSession("ses_1234", input)).resolves.toEqual(response);
    await expect(control.closeAdapterSession("ses_1234", input)).resolves.toEqual(response);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(() =>
      control.closeAdapterSession("ses_1234", {
        ...input,
        raw_control_ticket: "must-never-leave-adapter",
      } as typeof input),
    ).toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects malformed or mismatched Adapter close receipts", async () => {
    const input = {
      reason: "hook_session_end",
      idempotencyKey: "close:strict-response",
    };
    const valid = {
      session: {
        ...adapterSessionFixture(),
        connectionState: "OFFLINE" as const,
        version: 2,
      },
      ticketBinding: terminalSessionTicketBindingFixture(),
    };
    for (const malformed of [
      { ...valid, raw_token: "secret" },
      { ...valid, session: { ...valid.session, id: "ses_other" } },
      { ...valid, ticketBinding: { ...valid.ticketBinding, tokenSha256: "a".repeat(64) } },
      { ...valid, ticketBinding: { ...valid.ticketBinding, state: "ACTIVE" } },
      {
        ...valid,
        ticketBinding: {
          ...valid.ticketBinding,
          purposes: valid.ticketBinding.purposes.map((entry, index) =>
            index === 0 ? { ...entry, state: "ACTIVE" } : entry,
          ),
        },
      },
    ]) {
      const client = new HubClient({ fetch: async () => Response.json(malformed) });
      await expect(client.closeAdapterSession("ses_1234", input)).rejects.toThrow();
    }
  });

  it("rotates one exact bundle and preserves TTL truth across a 23-hour replay", async () => {
    const input = { idempotencyKey: "rotate:ses_1234:stb_replacement" };
    const terminalAt = "2026-08-01T04:30:00.000Z";
    const oldBinding = terminalSessionTicketBindingFixture();
    const supersededTicketBinding = {
      ...oldBinding,
      state: "SUPERSEDED" as const,
      terminalAt,
      terminalReason: "SESSION_TICKET_ROTATED",
      purposes: oldBinding.purposes.map((entry) => ({
        ...entry,
        state: "SUPERSEDED" as const,
        terminalAt,
        terminalReason: "SESSION_TICKET_ROTATED",
      })),
    };
    const ticketBinding = {
      ...sessionTicketBindingFixture(),
      bundleId: "stb_replacement",
      runId: "run_replacement",
      activatedAt: terminalAt,
      expiresAt: "2026-08-02T04:30:00.000Z",
      purposes: sessionTicketBindingFixture().purposes.map((entry) => ({
        ...entry,
        id: `${entry.id}_replacement`,
      })),
    };
    const stateReceipt = {
      session: adapterSessionFixture(),
      ticketBinding,
      supersededTicketBinding,
    };
    const serverTimes = [terminalAt, "2026-08-02T03:30:00.000Z"];
    let responseIndex = 0;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(
        "http://hub.test/api/sessions/ses_1234/session-ticket-bundles/stb_replacement/activate",
      );
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer old-control-raw");
      expect(JSON.parse(String(init?.body))).toEqual(input);
      return Response.json({
        ...structuredClone(stateReceipt),
        serverNow: serverTimes[responseIndex++],
      });
    });
    const control = new HubClient({
      baseUrl: "http://hub.test",
      fetch: fetchMock as typeof fetch,
    }).withToken("old-control-raw");

    const original = await control.rotateAdapterSessionTickets(
      "ses_1234",
      "stb_replacement",
      input,
    );
    const delayedReplay = await control.rotateAdapterSessionTickets(
      "ses_1234",
      "stb_replacement",
      input,
    );
    expect(original.ticketBinding).toEqual(delayedReplay.ticketBinding);
    expect(original.supersededTicketBinding).toEqual(delayedReplay.supersededTicketBinding);
    expect(delayedReplay.ticketBinding.expiresAt).toBe("2026-08-02T04:30:00.000Z");
    expect(original.serverNow).toBe(serverTimes[0]);
    expect(delayedReplay.serverNow).toBe(serverTimes[1]);
    expect(Date.parse(delayedReplay.serverNow) - Date.parse(original.serverNow)).toBe(
      23 * 60 * 60 * 1_000,
    );
    expect(JSON.stringify(original)).not.toMatch(/raw|sha256/i);
    expect(() =>
      control.rotateAdapterSessionTickets("ses_1234", "stb_replacement", {
        ...input,
        raw_control_ticket: "forbidden",
      } as typeof input),
    ).toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects ticket rotation receipts for another session or bundle", async () => {
    const input = { idempotencyKey: "rotate:strict" };
    const oldBinding = terminalSessionTicketBindingFixture();
    const supersededTicketBinding = {
      ...oldBinding,
      state: "SUPERSEDED" as const,
      terminalReason: "SESSION_TICKET_ROTATED",
      purposes: oldBinding.purposes.map((entry) => ({
        ...entry,
        state: "SUPERSEDED" as const,
        terminalReason: "SESSION_TICKET_ROTATED",
      })),
    };
    const valid = {
      session: adapterSessionFixture(),
      ticketBinding: { ...sessionTicketBindingFixture(), bundleId: "stb_replacement" },
      supersededTicketBinding,
      serverNow: "2026-08-01T04:30:00.000Z",
    };
    for (const malformed of [
      { ...valid, serverNow: undefined },
      { ...valid, serverNow: "2026-08-01T06:30:00.000+02:00" },
      { ...valid, session: { ...valid.session, id: "ses_other" } },
      { ...valid, ticketBinding: { ...valid.ticketBinding, bundleId: "stb_other" } },
      {
        ...valid,
        supersededTicketBinding: {
          ...valid.supersededTicketBinding,
          hubSessionId: "ses_other",
        },
      },
      {
        ...valid,
        supersededTicketBinding: {
          ...valid.supersededTicketBinding,
          bundleId: "stb_replacement",
        },
      },
    ]) {
      const client = new HubClient({ fetch: async () => Response.json(malformed) });
      await expect(
        client.rotateAdapterSessionTickets("ses_1234", "stb_replacement", input),
      ).rejects.toThrow();
    }
  });

  it("sends the local bearer token and decodes JSON", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret");
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
      });
    });
    const client = new HubClient({ token: "secret", fetch: fetchMock as typeof fetch });
    await expect(client.health()).resolves.toEqual({ ok: true });
  });

  it("creates an immutable token-bound clone without mutating the bootstrap client", async () => {
    const observedAuthorization: Array<string | null> = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      observedAuthorization.push(new Headers(init?.headers).get("authorization"));
      return Response.json({ ok: true });
    });
    const bootstrap = new HubClient({
      baseUrl: "http://hub.test/",
      token: "bootstrap-secret",
      fetch: fetchMock as typeof fetch,
      requestTimeoutMs: 500,
    });
    const control = bootstrap.withToken("session-control-secret");

    expect(control).not.toBe(bootstrap);
    expect(control.baseUrl).toBe("http://hub.test");
    expect(control.token).toBe("session-control-secret");
    expect(bootstrap.token).toBe("bootstrap-secret");
    await bootstrap.health();
    await control.health();
    expect(observedAuthorization).toEqual([
      "Bearer bootstrap-secret",
      "Bearer session-control-secret",
    ]);
    expect(() => bootstrap.withToken("")).toThrow("non-empty");
  });

  it("preserves structured conflict details", async () => {
    const client = new HubClient({
      token: "secret",
      fetch: async () =>
        new Response(
          JSON.stringify({ code: "VERSION_CONFLICT", message: "stale", current: { version: 3 } }),
          { status: 409 },
        ),
    });
    await expect(client.health()).rejects.toMatchObject({
      status: 409,
      code: "VERSION_CONFLICT",
      current: { version: 3 },
    });
  });

  it("preserves validation issues and includes their field paths in the error message", async () => {
    const issues = [
      {
        code: "too_big",
        path: ["commandName"],
        message: "Too big: expected string to have <=200 characters",
      },
    ];
    const client = new HubClient({
      token: "secret",
      fetch: async () =>
        new Response(
          JSON.stringify({
            code: "VALIDATION_ERROR",
            message: "Request validation failed",
            issues,
          }),
          { status: 422 },
        ),
    });

    await expect(client.health()).rejects.toMatchObject({
      status: 422,
      code: "VALIDATION_ERROR",
      issues,
      message: expect.stringContaining("commandName"),
    });
  });

  it("claims a message recipient through the single-owner endpoint", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://hub.test/api/messages/msg_123/claim");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({
        sessionId: "ses_123",
        idempotencyKey: "claim-msg-123",
      });
      return new Response(JSON.stringify({ id: "msg_123", recipients: [] }), {
        headers: { "content-type": "application/json" },
      });
    });
    const client = new HubClient({
      baseUrl: "http://hub.test/",
      token: "secret",
      fetch: fetchMock as typeof fetch,
    });

    await expect(
      client.claimMessageRecipient("msg_123", {
        sessionId: "ses_123",
        idempotencyKey: "claim-msg-123",
      }),
    ).resolves.toMatchObject({ id: "msg_123" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("aborts an unfinished request after the configured timeout", async () => {
    vi.useFakeTimers();
    try {
      let receivedSignal: AbortSignal | undefined;
      const fetchMock = vi.fn(
        async (_url: string, init?: RequestInit): Promise<Response> =>
          new Promise((_resolve, reject) => {
            receivedSignal = init?.signal ?? undefined;
            receivedSignal?.addEventListener("abort", () => reject(receivedSignal?.reason), {
              once: true,
            });
          }),
      );
      const client = new HubClient({
        fetch: fetchMock as typeof fetch,
        requestTimeoutMs: 250,
      });

      const request = client.health();
      const rejection = expect(request).rejects.toMatchObject({
        name: "TimeoutError",
        message: "Hub request timed out after 250 ms",
      });
      await vi.advanceTimersByTimeAsync(250);

      await rejection;
      expect(receivedSignal?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a non-positive or non-finite request timeout", () => {
    for (const requestTimeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new HubClient({ requestTimeoutMs })).toThrow(
        "requestTimeoutMs must be a finite positive number",
      );
    }
  });

  it("combines the caller signal with the configured timeout", async () => {
    vi.useFakeTimers();
    try {
      const callerController = new AbortController();
      const callerReason = new DOMException("cancelled by caller", "AbortError");
      let receivedSignal: AbortSignal | undefined;
      const fetchMock = vi.fn(
        async (_url: string, init?: RequestInit): Promise<Response> =>
          new Promise((_resolve, reject) => {
            receivedSignal = init?.signal ?? undefined;
            receivedSignal?.addEventListener("abort", () => reject(receivedSignal?.reason), {
              once: true,
            });
          }),
      );
      const client = new HubClient({
        fetch: fetchMock as typeof fetch,
        requestTimeoutMs: 1_000,
      });

      const request = client.request("GET", "/api/health", undefined, callerController.signal);
      const rejection = expect(request).rejects.toBe(callerReason);
      callerController.abort(callerReason);

      await rejection;
      expect(receivedSignal).not.toBe(callerController.signal);
      expect(receivedSignal?.reason).toBe(callerReason);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cleans up timeout state after a successful request", async () => {
    vi.useFakeTimers();
    try {
      let receivedSignal: AbortSignal | undefined;
      const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
        receivedSignal = init?.signal ?? undefined;
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
        });
      });
      const client = new HubClient({
        fetch: fetchMock as typeof fetch,
        requestTimeoutMs: 100,
      });

      await expect(client.health()).resolves.toEqual({ ok: true });
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(100);
      expect(receivedSignal?.aborted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("authenticates an Agent socket in-band before subscribing without URL secret leakage", () => {
    const socket = new FakeSocket();
    const constructedUrls: string[] = [];
    const frames: Record<string, unknown>[] = [];
    const secret = "agent-socket-secret";
    openProjectSocket({
      baseUrl: "http://hub.test",
      token: secret,
      projectId: "prj_test",
      sessionId: "ses_test",
      clientType: "codex_bridge",
      WebSocket: class {
        constructor(url: string | URL) {
          constructedUrls.push(String(url));
          return socket;
        }
      } as unknown as typeof WebSocket,
      onFrame: (frame) => frames.push(frame),
    });

    expect(constructedUrls).toEqual(["ws://hub.test/ws"]);
    expect(constructedUrls[0]).not.toContain("?");
    expect(constructedUrls[0]).not.toContain(secret);
    socket.readyState = 1;
    socket.dispatchEvent(new Event("open"));
    expect(socket.sent.map((frame) => JSON.parse(frame))).toEqual([
      { type: "authenticate", token: secret },
    ]);

    socket.receive(JSON.stringify({ type: "authenticated" }));
    expect(socket.sent.map((frame) => JSON.parse(frame))).toEqual([
      { type: "authenticate", token: secret },
      {
        type: "subscribe",
        clientType: "codex_bridge",
        projectId: "prj_test",
        sessionId: "ses_test",
        lastSequence: 0,
      },
    ]);
    socket.receive(JSON.stringify({ type: "authenticated" }));
    expect(socket.sent).toHaveLength(2);
    expect(JSON.stringify(frames)).not.toContain(secret);
  });

  it("rejects a malformed Agent authentication acknowledgement without exposing the bearer", () => {
    const socket = new FakeSocket();
    const frames: Record<string, unknown>[] = [];
    const secret = "agent-socket-secret";
    openProjectSocket({
      baseUrl: "http://hub.test",
      token: secret,
      projectId: "prj_test",
      sessionId: "ses_test",
      clientType: "codex_bridge",
      WebSocket: class {
        constructor() {
          return socket;
        }
      } as unknown as typeof WebSocket,
      onFrame: (frame) => frames.push(frame),
    });
    socket.readyState = 1;
    socket.dispatchEvent(new Event("open"));

    socket.receive(JSON.stringify({ type: "authenticated", token: secret }));

    expect(frames).toEqual([
      {
        type: "error",
        code: "INVALID_AUTHENTICATION_FRAME",
        message: "Hub socket sent an invalid authentication acknowledgement",
      },
    ]);
    expect(JSON.stringify(frames)).not.toContain(secret);
    expect(socket.sent).toHaveLength(1);
    expect(socket.closes).toEqual([{ code: 1008, reason: "invalid_authentication_frame" }]);
  });

  it("fails closed when an Agent socket receives project data before authentication", () => {
    const socket = new FakeSocket();
    const frames: Record<string, unknown>[] = [];
    openProjectSocket({
      baseUrl: "http://hub.test",
      token: "agent-socket-secret",
      projectId: "prj_test",
      sessionId: "ses_test",
      clientType: "codex_bridge",
      WebSocket: class {
        constructor() {
          return socket;
        }
      } as unknown as typeof WebSocket,
      onFrame: (frame) => frames.push(frame),
    });
    socket.readyState = 1;
    socket.dispatchEvent(new Event("open"));

    socket.receive(
      JSON.stringify({
        type: "event",
        event: { sequence: 1, payload: { private: "must-not-reach-adapter" } },
        replay: false,
      }),
    );

    expect(frames).toEqual([
      {
        type: "error",
        code: "AUTHENTICATION_REQUIRED",
        message: "Hub socket sent data before Agent authentication completed",
      },
    ]);
    expect(JSON.stringify(frames)).not.toContain("must-not-reach-adapter");
    expect(socket.closes).toEqual([{ code: 1008, reason: "authentication_required" }]);
  });

  it("closes an Agent socket when the in-band authentication acknowledgement times out", async () => {
    vi.useFakeTimers();
    try {
      const socket = new FakeSocket();
      const frames: Record<string, unknown>[] = [];
      openProjectSocket({
        baseUrl: "http://hub.test",
        token: "agent-socket-secret",
        projectId: "prj_test",
        sessionId: "ses_test",
        clientType: "claude_channel",
        authenticationTimeoutMs: 250,
        WebSocket: class {
          constructor() {
            return socket;
          }
        } as unknown as typeof WebSocket,
        onFrame: (frame) => frames.push(frame),
      });
      socket.readyState = 1;
      socket.dispatchEvent(new Event("open"));

      await vi.advanceTimersByTimeAsync(250);

      expect(frames).toEqual([
        {
          type: "error",
          code: "AUTHENTICATION_TIMEOUT",
          message: "Hub socket Agent authentication timed out",
        },
      ]);
      expect(socket.closes).toEqual([{ code: 1008, reason: "authentication_timeout" }]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets a Dashboard cookie socket subscribe directly without a query", () => {
    const socket = new FakeSocket();
    const constructedUrls: string[] = [];
    openProjectSocket({
      baseUrl: "http://hub.test",
      projectId: "prj_test",
      clientType: "dashboard",
      WebSocket: class {
        constructor(url: string | URL) {
          constructedUrls.push(String(url));
          return socket;
        }
      } as unknown as typeof WebSocket,
      onFrame: () => undefined,
    });

    expect(constructedUrls).toEqual(["ws://hub.test/ws"]);
    socket.readyState = 1;
    socket.dispatchEvent(new Event("open"));
    expect(socket.sent.map((frame) => JSON.parse(frame))).toEqual([
      {
        type: "subscribe",
        clientType: "dashboard",
        projectId: "prj_test",
        lastSequence: 0,
      },
    ]);
  });

  it("fails Agent socket construction without leaking an invalid or missing bearer", () => {
    const WebSocketMock = vi.fn();
    expect(() =>
      openProjectSocket({
        projectId: "prj_test",
        clientType: "codex_bridge",
        WebSocket: WebSocketMock as unknown as typeof WebSocket,
        onFrame: () => undefined,
      }),
    ).toThrow("require an in-band bearer token");

    const secret = " invalid\r\nsecret ";
    let captured: unknown;
    try {
      openProjectSocket({
        token: secret,
        projectId: "prj_test",
        clientType: "claude_channel",
        WebSocket: WebSocketMock as unknown as typeof WebSocket,
        onFrame: () => undefined,
      });
    } catch (error) {
      captured = error;
    }
    expect(String(captured)).not.toContain(secret);
    expect(String(captured)).toContain("bearer token is invalid");
    expect(WebSocketMock).not.toHaveBeenCalled();
  });

  it("reports malformed WebSocket JSON as a protocol frame instead of throwing", () => {
    const socket = new FakeSocket();
    const frames: Record<string, unknown>[] = [];
    openProjectSocket({
      baseUrl: "http://hub.test",
      token: "agent-socket-secret",
      projectId: "prj_test",
      clientType: "codex_bridge",
      WebSocket: class {
        constructor() {
          return socket;
        }
      } as unknown as typeof WebSocket,
      onFrame: (frame) => frames.push(frame),
    });

    expect(() => socket.receive("{not-json")).not.toThrow();
    expect(frames).toEqual([
      {
        type: "error",
        code: "INVALID_FRAME",
        message: "Hub socket sent malformed JSON",
      },
    ]);
  });

  it("does not send a pong after the socket has started closing", () => {
    const socket = new FakeSocket();
    const frames: Record<string, unknown>[] = [];
    openProjectSocket({
      baseUrl: "http://hub.test",
      token: "agent-socket-secret",
      projectId: "prj_test",
      clientType: "codex_bridge",
      WebSocket: class {
        constructor() {
          return socket;
        }
      } as unknown as typeof WebSocket,
      onFrame: (frame) => frames.push(frame),
    });
    socket.readyState = 1;
    socket.dispatchEvent(new Event("open"));
    socket.receive(JSON.stringify({ type: "authenticated" }));
    socket.sent.length = 0;
    frames.length = 0;
    socket.readyState = 2;

    socket.receive(JSON.stringify({ type: "ping", sentAt: new Date().toISOString() }));

    expect(socket.sent).toEqual([]);
    expect(frames).toEqual([expect.objectContaining({ type: "ping" })]);
  });
});
