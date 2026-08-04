import { describe, expect, it } from "vitest";
import {
  assertTaskTransition,
  choosePushAction,
  computeTaskProgress,
  createId,
  createOpaqueToken,
  CreateFindingInputSchema,
  CloseAdapterSessionInputSchema,
  CloseAdapterSessionResultSchema,
  HeartbeatInputSchema,
  ProjectSocketAuthenticatedFrameSchema,
  ProjectSocketAuthenticateFrameSchema,
  ProjectSocketDeliveryFrameSchema,
  RegisterAdapterSessionInputSchema,
  RegisterSessionInputSchema,
  ReserveSessionLaunchInputSchema,
  RegisterAdapterSessionResultSchema,
  RotateAdapterSessionTicketsInputSchema,
  RotateAdapterSessionTicketsResultSchema,
  SESSION_TICKET_AUXILIARY_CLIENTS,
  SESSION_TICKET_PURPOSES_BY_CLIENT,
  SessionTicketBindingSchema,
  SessionTicketErrorCodeSchema,
  SessionTicketOfferInputSchema,
  SessionTicketOfferSchema,
  SessionTicketPurposeSchema,
  SessionTicketStateSchema,
  TerminalSessionTicketBindingSchema,
} from "../src/index.js";

describe("external session identity contracts", () => {
  it("rejects whitespace-only and padded logical identities before lineage selection", () => {
    const registration = {
      projectId: "prj_1234",
      agentId: "codex",
      role: "primary" as const,
      client: "codex-app-server" as const,
      transport: "websocket" as const,
      deliveryMode: "app_server_push" as const,
      host: "test-host",
      cwd: "R:\\project",
      capabilities: [],
    };
    const reservation = {
      agentId: "codex",
      client: "codex-app-server" as const,
      deliveryMode: "app_server_push" as const,
      runId: "run_1234",
      idempotencyKey: "reserve-whitespace",
    };

    for (const invalid of ["   ", "\t", " padded", "padded "]) {
      expect(
        RegisterSessionInputSchema.safeParse({
          ...registration,
          externalThreadId: invalid,
        }).success,
      ).toBe(false);
      expect(
        ReserveSessionLaunchInputSchema.safeParse({
          ...reservation,
          externalThreadId: invalid,
        }).success,
      ).toBe(false);
    }
  });
});

describe("session ticket wire contracts", () => {
  const offerInput = {
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
  const offeredAt = "2026-08-01T04:00:00.000Z";
  const offerExpiresAt = "2026-08-01T04:10:00.000Z";

  it("keeps ticket purposes and states closed", () => {
    for (const purpose of ["CONTROL", "MODEL_MCP", "CAPTURE", "INJECTOR"] as const) {
      expect(SessionTicketPurposeSchema.parse(purpose)).toBe(purpose);
    }
    for (const state of ["PENDING", "ACTIVE", "REVOKED", "EXPIRED", "SUPERSEDED"] as const) {
      expect(SessionTicketStateSchema.parse(state)).toBe(state);
    }
    expect(SessionTicketPurposeSchema.safeParse("ADMIN").success).toBe(false);
    expect(SessionTicketStateSchema.safeParse("CONSUMED").success).toBe(false);
  });

  it("accepts only digest metadata in a strict ticket offer body", () => {
    expect(SessionTicketOfferInputSchema.parse(offerInput)).toEqual(offerInput);
    for (const forbidden of [
      { raw_token: "secret" },
      { token: "secret" },
      { hub_session_id: "ses_1234" },
      { expires_at: "2099-01-01T00:00:00.000Z" },
      { unknown: true },
    ]) {
      expect(SessionTicketOfferInputSchema.safeParse({ ...offerInput, ...forbidden }).success).toBe(
        false,
      );
    }
  });

  it("binds each activation mode to one exact proof shape", () => {
    expect(
      SessionTicketOfferInputSchema.safeParse({
        ...offerInput,
        expected_lineage_id: "lin_forbidden",
      }).success,
    ).toBe(false);
    for (const activation_mode of ["CURRENT_HEAD_REPLACEMENT", "SESSION_AUXILIARY"] as const) {
      expect(
        SessionTicketOfferInputSchema.parse({
          ...offerInput,
          activation_mode,
          expected_lineage_id: "lin_1234",
          expected_head_session_id: "ses_1234",
        }),
      ).toMatchObject({ activation_mode });
      expect(
        SessionTicketOfferInputSchema.safeParse({ ...offerInput, activation_mode }).success,
      ).toBe(false);
      expect(
        SessionTicketOfferInputSchema.safeParse({
          ...offerInput,
          activation_mode,
          expected_lineage_id: "lin_1234",
          expected_head_session_id: null,
        }).success,
      ).toBe(false);
      expect(
        SessionTicketOfferInputSchema.safeParse({
          ...offerInput,
          activation_mode,
          expected_lineage_id: "lin_1234",
          expected_head_session_id: "ses_1234",
          launch_reservation_id: "rsr_forbidden",
        }).success,
      ).toBe(false);
    }
    expect(
      SessionTicketOfferInputSchema.parse({
        ...offerInput,
        activation_mode: "MANAGED_RESERVATION",
        expected_lineage_id: "lin_1234",
        expected_head_session_id: null,
        launch_reservation_id: "rsr_1234",
      }),
    ).toMatchObject({
      activation_mode: "MANAGED_RESERVATION",
      expected_head_session_id: null,
    });
    expect(
      SessionTicketOfferInputSchema.safeParse({
        ...offerInput,
        activation_mode: "MANAGED_RESERVATION",
      }).success,
    ).toBe(false);
    expect(
      SessionTicketOfferInputSchema.safeParse({
        ...offerInput,
        expected_head_session_id: null,
      }).success,
    ).toBe(false);
  });

  it("publishes one exact purpose matrix for every real Adapter client", () => {
    expect(SESSION_TICKET_PURPOSES_BY_CLIENT).toEqual({
      "codex-app-server": ["CONTROL", "MODEL_MCP", "INJECTOR"],
      "codex-cli-hooks": ["CONTROL", "CAPTURE"],
      "claude-channel": ["CONTROL"],
      "claude-hooks": ["CONTROL", "CAPTURE"],
    });
    expect(SESSION_TICKET_AUXILIARY_CLIENTS).toEqual(["codex-app-server", "claude-channel"]);
  });

  it("normalizes deferred identities while keeping ticket expiry server-owned", () => {
    const parsed = SessionTicketOfferInputSchema.parse({
      ...offerInput,
      external_session_id: undefined,
      external_thread_id: undefined,
    });
    expect(parsed.external_session_id).toBeNull();
    expect(parsed.external_thread_id).toBeNull();
    expect("expires_at" in parsed).toBe(false);
  });

  it("strictly projects PENDING offer metadata without returning raw material", () => {
    const offer = {
      id: "sto_1234",
      bundle_id: offerInput.bundle_id,
      purpose: offerInput.purpose,
      state: "PENDING" as const,
      project_id: "prj_1234",
      adapter_client: offerInput.adapter_client,
      agent_id: offerInput.agent_id,
      session_client: offerInput.session_client,
      role: offerInput.role,
      transport: offerInput.transport,
      delivery_mode: offerInput.delivery_mode,
      external_session_id: offerInput.external_session_id,
      external_thread_id: offerInput.external_thread_id,
      run_id: offerInput.run_id,
      offer_expires_at: offerExpiresAt,
    };
    expect(SessionTicketOfferSchema.parse(offer)).toEqual(offer);
    expect(SessionTicketOfferSchema.parse(structuredClone(offer))).toEqual(offer);
    expect(SessionTicketOfferSchema.safeParse({ ...offer, raw_token: "secret" }).success).toBe(
      false,
    );
    expect(
      SessionTicketOfferSchema.safeParse({ ...offer, token_sha256: "a".repeat(64) }).success,
    ).toBe(false);
  });

  it("binds ACTIVE ticket metadata to an explicit Hub session identity", () => {
    const binding = {
      bundleId: offerInput.bundle_id,
      state: "ACTIVE" as const,
      projectId: "prj_1234",
      agentId: "codex" as const,
      adapterClient: "codex" as const,
      hubSessionId: "ses_1234",
      lineageId: "lin_1234",
      incarnation: 2,
      runId: offerInput.run_id,
      activatedAt: offeredAt,
      expiresAt: "2026-08-01T05:00:00.000Z",
      purposes: [
        { id: "stk_control", purpose: "CONTROL" as const, state: "ACTIVE" as const },
        { id: "stk_mcp", purpose: "MODEL_MCP" as const, state: "ACTIVE" as const },
        { id: "stk_injector", purpose: "INJECTOR" as const, state: "ACTIVE" as const },
      ],
    };
    expect(SessionTicketBindingSchema.parse(binding)).toEqual(binding);
    expect(
      SessionTicketBindingSchema.safeParse({ ...binding, sessionId: "ses_1234" }).success,
    ).toBe(false);
    expect(SessionTicketBindingSchema.safeParse({ ...binding, raw_token: "secret" }).success).toBe(
      false,
    );
    expect(
      SessionTicketBindingSchema.safeParse({
        ...binding,
        purposes: [{ id: "stk_mcp", purpose: "MODEL_MCP", state: "ACTIVE" }],
      }).success,
    ).toBe(false);

    const session = {
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
      connectedAt: offeredAt,
      transportLastSeenAt: offeredAt,
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
      launcherRunId: offerInput.run_id,
      launchGeneration: 1,
      version: 1,
    };
    expect(
      RegisterAdapterSessionResultSchema.parse({
        session,
        ticketBinding: binding,
        serverNow: offeredAt,
      }),
    ).toEqual({ session, ticketBinding: binding, serverNow: offeredAt });
    expect(
      RegisterAdapterSessionResultSchema.safeParse({ session, ticketBinding: binding }).success,
    ).toBe(false);
    expect(
      RegisterAdapterSessionResultSchema.safeParse({
        session,
        ticketBinding: { ...binding, hubSessionId: "ses_other" },
      }).success,
    ).toBe(false);
  });

  it("requires one strict ticket bundle id when registering a real Adapter", () => {
    const input = {
      projectId: "prj_1234",
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
      ticket_bundle_id: offerInput.bundle_id,
      idempotencyKey: "register:ticketed",
    };
    expect(RegisterAdapterSessionInputSchema.parse(input)).toEqual(input);
    expect(
      RegisterAdapterSessionInputSchema.safeParse({ ...input, raw_control_ticket: "secret" })
        .success,
    ).toBe(false);
    expect(
      RegisterAdapterSessionInputSchema.safeParse({ ...input, session_id: "ses_1234" }).success,
    ).toBe(false);
    expect(
      RegisterAdapterSessionInputSchema.safeParse({ ...input, client: "fake-client" }).success,
    ).toBe(false);
  });

  it("requires an idempotent strict close body and terminal ticket receipt", () => {
    const closeInput = {
      reason: "hook_session_end",
      idempotencyKey: "close:session-end:ses_1234",
    };
    expect(CloseAdapterSessionInputSchema.parse(closeInput)).toEqual(closeInput);
    expect(
      CloseAdapterSessionInputSchema.safeParse({ ...closeInput, raw_control_ticket: "secret" })
        .success,
    ).toBe(false);

    const terminalAt = "2026-08-01T04:30:00.000Z";
    const terminalReason = `SESSION_CLOSED:${closeInput.reason}`;
    const ticketBinding = {
      bundleId: offerInput.bundle_id,
      state: "REVOKED" as const,
      projectId: "prj_1234",
      agentId: "codex" as const,
      adapterClient: "codex" as const,
      hubSessionId: "ses_1234",
      lineageId: "lin_1234",
      incarnation: 2,
      runId: offerInput.run_id,
      activatedAt: offeredAt,
      expiresAt: "2026-08-01T05:00:00.000Z",
      terminalAt,
      terminalReason,
      purposes: [
        {
          id: "stk_control",
          purpose: "CONTROL" as const,
          state: "REVOKED" as const,
          terminalAt,
          terminalReason,
        },
        {
          id: "stk_mcp",
          purpose: "MODEL_MCP" as const,
          state: "REVOKED" as const,
          terminalAt,
          terminalReason,
        },
        {
          id: "stk_injector",
          purpose: "INJECTOR" as const,
          state: "REVOKED" as const,
          terminalAt,
          terminalReason,
        },
      ],
    };
    expect(TerminalSessionTicketBindingSchema.parse(ticketBinding)).toEqual(ticketBinding);
    for (const malformed of [
      { ...ticketBinding, state: "ACTIVE" },
      { ...ticketBinding, terminalAt: undefined },
      { ...ticketBinding, terminalReason: undefined },
      { ...ticketBinding, raw_token: "secret" },
      { ...ticketBinding, tokenSha256: "a".repeat(64) },
      {
        ...ticketBinding,
        purposes: ticketBinding.purposes.map((entry, index) =>
          index === 0 ? { ...entry, state: "ACTIVE" } : entry,
        ),
      },
      {
        ...ticketBinding,
        purposes: ticketBinding.purposes.map((entry, index) =>
          index === 0 ? { ...entry, terminalReason: "different" } : entry,
        ),
      },
    ]) {
      expect(TerminalSessionTicketBindingSchema.safeParse(malformed).success).toBe(false);
    }

    const session = {
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
      connectedAt: offeredAt,
      transportLastSeenAt: offeredAt,
      activityLastSeenAt: null,
      currentTaskId: null,
      currentReviewId: null,
      activeFiles: [],
      workState: "IDLE" as const,
      connectionState: "OFFLINE" as const,
      queueDepth: 0,
      lineageId: "lin_1234",
      incarnation: 2,
      predecessorSessionId: null,
      supersededBySessionId: null,
      launcherRunId: offerInput.run_id,
      launchGeneration: 1,
      version: 2,
    };
    expect(CloseAdapterSessionResultSchema.parse({ session, ticketBinding })).toEqual({
      session,
      ticketBinding,
    });
    for (const mismatchedBinding of [
      { ...ticketBinding, projectId: "prj_other" },
      { ...ticketBinding, agentId: "claude", adapterClient: "claude" },
      { ...ticketBinding, hubSessionId: "ses_other" },
      { ...ticketBinding, lineageId: "lin_other" },
      { ...ticketBinding, incarnation: 3 },
    ]) {
      expect(
        CloseAdapterSessionResultSchema.safeParse({
          session,
          ticketBinding: mismatchedBinding,
        }).success,
      ).toBe(false);
    }

    const rotatedAt = "2026-08-01T04:20:00.000Z";
    const activeReplacement = {
      bundleId: "stb_replacement",
      state: "ACTIVE" as const,
      projectId: ticketBinding.projectId,
      agentId: ticketBinding.agentId,
      adapterClient: ticketBinding.adapterClient,
      hubSessionId: ticketBinding.hubSessionId,
      lineageId: ticketBinding.lineageId,
      incarnation: ticketBinding.incarnation,
      runId: "run_replacement",
      activatedAt: rotatedAt,
      expiresAt: "2026-08-02T04:20:00.000Z",
      purposes: ticketBinding.purposes.map((entry) => ({
        id: `${entry.id}_replacement`,
        purpose: entry.purpose,
        state: "ACTIVE" as const,
      })),
    };
    const superseded = {
      ...ticketBinding,
      state: "SUPERSEDED" as const,
      terminalAt: rotatedAt,
      terminalReason: "SESSION_TICKET_ROTATED",
      purposes: ticketBinding.purposes.map((entry) => ({
        ...entry,
        state: "SUPERSEDED" as const,
        terminalAt: rotatedAt,
        terminalReason: "SESSION_TICKET_ROTATED",
      })),
    };
    expect(
      RotateAdapterSessionTicketsResultSchema.parse({
        session: { ...session, connectionState: "ONLINE" },
        ticketBinding: activeReplacement,
        supersededTicketBinding: superseded,
        serverNow: rotatedAt,
      }),
    ).toMatchObject({
      ticketBinding: { bundleId: "stb_replacement", state: "ACTIVE" },
      supersededTicketBinding: { bundleId: offerInput.bundle_id, state: "SUPERSEDED" },
      serverNow: rotatedAt,
    });
    expect(
      RotateAdapterSessionTicketsResultSchema.safeParse({
        session: { ...session, connectionState: "ONLINE" },
        ticketBinding: activeReplacement,
        supersededTicketBinding: { ...superseded, bundleId: activeReplacement.bundleId },
        serverNow: rotatedAt,
      }).success,
    ).toBe(false);
    expect(
      RotateAdapterSessionTicketsResultSchema.safeParse({
        session: { ...session, connectionState: "ONLINE" },
        ticketBinding: activeReplacement,
        supersededTicketBinding: superseded,
        serverNow: "2026-08-01T06:20:00.000+02:00",
      }).success,
    ).toBe(false);
    expect(
      RotateAdapterSessionTicketsResultSchema.safeParse({
        session: { ...session, connectionState: "ONLINE" },
        ticketBinding: activeReplacement,
        supersededTicketBinding: superseded,
      }).success,
    ).toBe(false);
    expect(
      RotateAdapterSessionTicketsInputSchema.parse({ idempotencyKey: "rotate:stb_replacement" }),
    ).toEqual({ idempotencyKey: "rotate:stb_replacement" });
    expect(
      RotateAdapterSessionTicketsInputSchema.safeParse({
        idempotencyKey: "rotate:stb_replacement",
        raw_control_ticket: "secret",
      }).success,
    ).toBe(false);
  });

  it("publishes fail-closed ticket collision and binding error codes", () => {
    for (const code of [
      "TICKET_DIGEST_COLLISION",
      "TICKET_IDEMPOTENCY_CONFLICT",
      "TICKET_OFFER_NOT_AUTHORIZED",
      "TICKET_NOT_FOUND",
      "TICKET_NOT_PENDING",
      "TICKET_EXPIRED",
      "TICKET_BINDING_MISMATCH",
      "TICKET_REPLACEMENT_PROOF_REQUIRED",
      "TICKET_ACTIVATION_CONFLICT",
      "TICKET_AMBIGUOUS_CREDENTIAL",
      "TICKET_NOT_ACTIVE",
    ] as const) {
      expect(SessionTicketErrorCodeSchema.parse(code)).toBe(code);
    }
  });
});

describe("browser-safe secure identifiers", () => {
  it("creates opaque URL-safe values without a Node-only crypto import", () => {
    const firstId = createId("msg");
    const secondId = createId("msg");
    const token = createOpaqueToken();

    expect(firstId).toMatch(/^msg_[a-z0-9]{10}[a-f0-9]{16}$/);
    expect(secondId).not.toBe(firstId);
    expect(token).toMatch(/^[A-Za-z0-9_-]{80,}$/);
  });
});

describe("task transitions", () => {
  it("allows a normal review lifecycle", () => {
    expect(() => assertTaskTransition("IN_PROGRESS", "REVIEW_PENDING")).not.toThrow();
    expect(() => assertTaskTransition("APPROVED", "DONE")).not.toThrow();
  });

  it("rejects skipping the review gate", () => {
    expect(() => assertTaskTransition("IN_PROGRESS", "DONE")).toThrow("Invalid task transition");
  });
});

describe("computed progress", () => {
  const todos = [
    { status: "DONE" as const, weight: 3 },
    { status: "TODO" as const, weight: 1 },
  ];

  it("caps review-required implementation at 85%", () => {
    expect(computeTaskProgress(todos, true, false)).toBe(63.8);
  });

  it("adds the review contribution only after approval", () => {
    expect(computeTaskProgress([{ status: "DONE", weight: 1 }], true, true, [])).toBe(100);
  });

  it("never reports 100 while a blocking finding is open", () => {
    expect(
      computeTaskProgress([{ status: "DONE", weight: 1 }], true, true, [
        { blocking: true, status: "OPEN" },
      ]),
    ).toBe(99);
  });
});

describe("push policy", () => {
  it("steers only action-required traffic into an active turn", () => {
    const state = {
      activeTurn: true,
      online: true,
      atSafeCheckpoint: true,
      wakePolicy: "urgent_and_action_required" as const,
    };
    expect(choosePushAction("BACKGROUND", state)).toBe("mailbox");
    expect(choosePushAction("NORMAL", state)).toBe("queue");
    expect(choosePushAction("IMPORTANT", state)).toBe("steer");
    expect(choosePushAction("INTERRUPT", state)).toBe("steer");
  });

  // Injecting into an idle thread rouses nothing, and on codex-cli 0.145.0 no API can read the
  // injected item back, so it could not even be confirmed. Every NORMAL message sat PENDING
  // forever while the identical IMPORTANT message was delivered in four seconds.
  it("wakes an idle peer rather than injecting a message nothing will read", () => {
    const idle = {
      activeTurn: false,
      online: true,
      atSafeCheckpoint: false,
      wakePolicy: "urgent_and_action_required" as const,
    };
    expect(choosePushAction("NORMAL", idle)).toBe("wake");
    expect(choosePushAction("IMPORTANT", idle)).toBe("wake");
    expect(choosePushAction("INTERRUPT", idle)).toBe("wake");
    expect(choosePushAction("BACKGROUND", idle)).toBe("mailbox");
  });

  it("still wakes a NORMAL message for a peer that opted out, and injects only IMPORTANT", () => {
    for (const wakePolicy of ["interrupt_only", "never"] as const) {
      const idle = { activeTurn: false, online: true, atSafeCheckpoint: false, wakePolicy };
      // NORMAL is unconditional: an unconfirmable inject is not a delivery on any policy.
      expect(choosePushAction("NORMAL", idle)).toBe("wake");
      expect(choosePushAction("INTERRUPT", idle)).toBe("wake");
      // IMPORTANT honours the opt-out and injects, which docs/known-limitations.md records as
      // still unconfirmable on codex-cli 0.145.0.
      expect(choosePushAction("IMPORTANT", idle)).toBe("inject");
    }
  });

  it("keeps offline traffic in the persistent mailbox", () => {
    expect(
      choosePushAction("INTERRUPT", {
        activeTurn: false,
        online: false,
        atSafeCheckpoint: false,
        wakePolicy: "urgent_and_action_required",
      }),
    ).toBe("mailbox");
  });
});

describe("finding input", () => {
  const valid = {
    sessionId: "ses_1",
    severity: "medium" as const,
    category: "correctness" as const,
    title: "t",
    claim: "c",
    impact: "i",
    idempotencyKey: "k",
  };

  it("accepts a well-formed finding", () => {
    expect(CreateFindingInputSchema.safeParse(valid).success).toBe(true);
  });

  /**
   * `blocking` exists on ReviewFinding but is derived from severity === "blocking"; the input schema
   * has no such field. A plain z.object() strips unknown keys, so a reviewer who set blocking: true
   * got HTTP 200 with the flag silently discarded and believed they had filed a blocking finding.
   * Losing caller intent without saying so is worse than refusing it.
   */
  it("refuses a blocking flag instead of silently discarding it", () => {
    const result = CreateFindingInputSchema.safeParse({ ...valid, blocking: true });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("blocking");
  });

  it("refuses any other unrecognised key for the same reason", () => {
    expect(CreateFindingInputSchema.safeParse({ ...valid, sevrity: "high" }).success).toBe(false);
  });
});

describe("project socket delivery frames", () => {
  it("keeps bearer authentication and its acknowledgement strict", () => {
    expect(
      ProjectSocketAuthenticateFrameSchema.parse({ type: "authenticate", token: "socket-secret" }),
    ).toEqual({ type: "authenticate", token: "socket-secret" });
    expect(ProjectSocketAuthenticatedFrameSchema.parse({ type: "authenticated" })).toEqual({
      type: "authenticated",
    });
    expect(
      ProjectSocketAuthenticateFrameSchema.safeParse({
        type: "authenticate",
        token: "socket-secret",
        projectId: "prj_forbidden",
      }).success,
    ).toBe(false);
    expect(
      ProjectSocketAuthenticatedFrameSchema.safeParse({
        type: "authenticated",
        token: "forged-echo",
      }).success,
    ).toBe(false);
  });

  it("accepts only the finite recipient state machine", () => {
    expect(
      ProjectSocketDeliveryFrameSchema.safeParse({
        type: "delivery",
        messageId: "msg_1",
        state: "ACKNOWLEDGED",
      }).success,
    ).toBe(true);
    expect(
      ProjectSocketDeliveryFrameSchema.safeParse({
        type: "delivery",
        messageId: "msg_1",
        state: "GARBAGE",
      }).success,
    ).toBe(false);
  });

  it("keeps surface permit identity paired and exclusive to delivered frames", () => {
    expect(
      ProjectSocketDeliveryFrameSchema.safeParse({
        type: "delivery",
        messageId: "msg_1",
        state: "DELIVERED",
        surfaceAttemptId: "srf_1",
        recipientFence: 2,
      }).success,
    ).toBe(true);
    expect(
      ProjectSocketDeliveryFrameSchema.safeParse({
        type: "delivery",
        messageId: "msg_1",
        state: "DELIVERED",
        surfaceAttemptId: "srf_1",
      }).success,
    ).toBe(false);
    expect(
      ProjectSocketDeliveryFrameSchema.safeParse({
        type: "delivery",
        messageId: "msg_1",
        state: "ACKNOWLEDGED",
        surfaceAttemptId: "srf_1",
        recipientFence: 2,
      }).success,
    ).toBe(false);
  });
});

describe("heartbeat input", () => {
  const valid = {
    sessionId: "ses_1",
    sequence: 1,
    workState: "IDLE" as const,
    activeFiles: [],
    queueDepth: 0,
  };

  it("strictly rejects fields outside the heartbeat protocol", () => {
    expect(HeartbeatInputSchema.safeParse({ ...valid, forged: true }).success).toBe(false);
  });

  it("rejects malformed queue and active file telemetry", () => {
    expect(HeartbeatInputSchema.safeParse({ ...valid, queueDepth: -1 }).success).toBe(false);
    expect(HeartbeatInputSchema.safeParse({ ...valid, activeFiles: [42] }).success).toBe(false);
  });
});
