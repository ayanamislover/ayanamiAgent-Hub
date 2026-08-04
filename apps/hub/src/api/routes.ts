import {
  AbortSyntheticPromptInputSchema,
  AuthorizationCapabilitySchema,
  BeginMessageSurfaceInputSchema,
  ClaimMessageRecipientInputSchema,
  ClaimTaskInputSchema,
  CaptureUserTurnInputSchema,
  ContextPackRequestSchema,
  DecideAuthorizationInputSchema,
  CreateFindingInputSchema,
  CreateDelegationGrantInputSchema,
  CreateMilestoneInputSchema,
  CreateObjectiveInputSchema,
  CreateTaskInputSchema,
  CreateTodoInputSchema,
  DelegateInstructionInputSchema,
  DirectiveExecutionResultInputSchema,
  DirectiveLifecycleMutationInputSchema,
  HeartbeatInputSchema,
  JoinProjectInputSchema,
  MessageStateInputSchema,
  PostMessageInputSchema,
  CloseAdapterSessionInputSchema,
  RegisterAdapterSessionInputSchema,
  RotateAdapterSessionTicketsInputSchema,
  RegisterSessionInputSchema,
  ReconcileOrdinaryMessageSurfaceInputSchema,
  ReserveSessionLaunchInputSchema,
  RequestAuthorizationInputSchema,
  RequestReviewInputSchema,
  RelayUserDirectiveInputSchema,
  SupersedeUserDirectiveInputSchema,
  PrepareSyntheticPromptInputSchema,
  ReviewVerdictInputSchema,
  SessionLineageHeadQuerySchema,
  SessionTicketOfferInputSchema,
  TerminalSizeSchema,
  TerminateDelegationGrantInputSchema,
  UpdateTaskInputSchema,
  UpdateMessageSurfaceInputSchema,
  UpdateTodoInputSchema,
  ModifyDelegationGrantInputSchema,
  UpsertModelPresetInputSchema,
  WriteIntentInputSchema,
} from "@crossagent/protocol";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { HubStore } from "../services/hub-store.js";
import type { PtyService } from "../services/pty-service.js";
import { readArtifact } from "../git/git-service.js";
import { readOnboardingState } from "./onboarding.js";
import { HubError, NotFoundError } from "../domain/errors.js";
import {
  assertPrincipalKind,
  requestPrincipal,
  type RequestPrincipal,
} from "../security/local-auth.js";
import type { RuntimeBuildIdentity } from "../runtime/build-identity.js";

const IdParamSchema = z.object({ id: z.string().min(4) });
const ProjectParamSchema = z.object({ projectId: z.string().min(4) });
const MessageSurfaceParamSchema = z.object({
  id: z.string().min(4),
  attemptId: z.string().min(4),
});
const SessionTicketBundleParamSchema = z.object({
  sessionId: z.string().min(4),
  bundleId: z.string().min(4),
});
const AuthorityDeliveryInputSchema = z
  .object({
    session_id: z.string().min(4).max(128),
    surface_attempt_id: z.string().min(4).max(128),
    recipient_fence: z.number().int().positive(),
  })
  .strict();
const RecoverAuthorityDeliveryInputSchema = z
  .object({ session_id: z.string().min(4).max(128) })
  .strict();
const RuntimeBuildIdentitySchema = z
  .object({
    buildSessionId: z.string().uuid(),
    buildId: z.string().regex(/^[a-f0-9]{64}$/u),
    migrationId: z.string().regex(/^[a-f0-9]{64}$/u),
    protocolId: z.string().regex(/^[a-f0-9]{64}$/u),
    manifestSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();
const RuntimeShutdownInputSchema = z
  .object({
    instanceId: z.string().regex(/^[a-f0-9]{32}$/u),
    build: RuntimeBuildIdentitySchema,
    idempotencyKey: z.string().uuid(),
  })
  .strict();

function body<T extends z.ZodType>(schema: T, request: FastifyRequest): z.output<T> {
  return schema.parse(request.body);
}

function params<T extends z.ZodType>(schema: T, request: FastifyRequest): z.output<T> {
  return schema.parse(request.params);
}

function query<T extends z.ZodType>(schema: T, request: FastifyRequest): z.output<T> {
  return schema.parse(request.query);
}

function assertReadableProject(
  store: HubStore,
  principal: RequestPrincipal,
  projectId: string,
): void {
  if (principal.credentialClass === "SESSION_TICKET") {
    if (principal.projectId !== projectId || !principal.hubSessionId) {
      throw new HubError("Credential cannot access another project", 403, "PROJECT_NOT_AUTHORIZED");
    }
    store.assertProjectRead(principal, projectId);
  }
}

export async function registerApiRoutes(
  app: FastifyInstance,
  store: HubStore,
  runtime: { host: string; port: number; databasePath: string; dataDir: string },
  pty: PtyService,
  runtimeIdentity: {
    buildIdentity: RuntimeBuildIdentity;
    instanceId: string;
    startedAt: string;
    prepareShutdown: (idempotencyKey: string) => {
      accepted: true;
      idempotencyKey: string;
      scheduledAt: string;
    };
    commitShutdown: (idempotencyKey: string) => void;
  },
): Promise<void> {
  app.get("/api/health", async (_request, reply) => {
    reply.header("x-crossagent-build-id", runtimeIdentity.buildIdentity.buildId);
    return {
      ok: true,
      service: "crossagent-hub",
      version: "0.1.0",
      time: new Date().toISOString(),
      instanceId: runtimeIdentity.instanceId,
      startedAt: runtimeIdentity.startedAt,
      pid: process.pid,
      build: runtimeIdentity.buildIdentity,
      host: runtime.host,
      port: runtime.port,
      database: {
        path: runtime.databasePath,
        journalMode: (
          store.sqlite.pragma("journal_mode", { simple: true }) as string
        ).toUpperCase(),
        foreignKeys: Boolean(store.sqlite.pragma("foreign_keys", { simple: true })),
        busyTimeoutMs: store.sqlite.pragma("busy_timeout", { simple: true }),
      },
      websocket: "available",
      mcp: "available",
    };
  });

  app.post("/api/runtime/shutdown", async (request, reply) => {
    const principal = requestPrincipal(request);
    assertPrincipalKind(principal, "DASHBOARD_USER");
    if (principal.id !== "prn_local_dashboard") {
      throw new HubError(
        "Only the current local controller may stop the Hub",
        403,
        "RUNTIME_SHUTDOWN_NOT_AUTHORIZED",
      );
    }
    const input = body(RuntimeShutdownInputSchema, request);
    if (
      input.instanceId !== runtimeIdentity.instanceId ||
      input.build.buildSessionId !== runtimeIdentity.buildIdentity.buildSessionId ||
      input.build.buildId !== runtimeIdentity.buildIdentity.buildId ||
      input.build.migrationId !== runtimeIdentity.buildIdentity.migrationId ||
      input.build.protocolId !== runtimeIdentity.buildIdentity.protocolId ||
      input.build.manifestSha256 !== runtimeIdentity.buildIdentity.manifestSha256
    ) {
      throw new HubError(
        "Runtime shutdown target does not match this Hub instance",
        409,
        "RUNTIME_IDENTITY_MISMATCH",
      );
    }
    const acknowledgement = runtimeIdentity.prepareShutdown(input.idempotencyKey);
    reply.raw.once("finish", () => runtimeIdentity.commitShutdown(input.idempotencyKey));
    return reply.code(202).send({
      ...acknowledgement,
      instanceId: runtimeIdentity.instanceId,
      buildId: runtimeIdentity.buildIdentity.buildId,
    });
  });

  app.post("/api/user-turns/capture", async (request) => {
    const result = store.captureUserTurn(
      requestPrincipal(request),
      body(CaptureUserTurnInputSchema, request),
    );
    return result.status === "CAPTURED"
      ? {
          status: result.status,
          user_turn_id: result.userTurn.id,
          raw_user_turn_sha256: result.userTurn.rawTextSha256,
          received_at: result.userTurn.receivedAt,
        }
      : {
          status: result.status,
          user_turn_id: null,
          synthetic_reservation_id: result.syntheticReservationId,
        };
  });

  app.post("/api/messages/:id/synthetic-prompts", async (request) =>
    store.prepareSyntheticPrompt(
      requestPrincipal(request),
      params(IdParamSchema, request).id,
      body(PrepareSyntheticPromptInputSchema, request),
    ),
  );

  app.post("/api/synthetic-prompts/:id/abort", async (request) =>
    store.abortSyntheticPrompt(
      requestPrincipal(request),
      params(IdParamSchema, request).id,
      body(AbortSyntheticPromptInputSchema, request),
    ),
  );

  app.get("/api/user-turns/:id", async (request) => {
    assertPrincipalKind(requestPrincipal(request), "DASHBOARD_USER");
    const { id } = params(IdParamSchema, request);
    return store.getUserTurn(id);
  });

  app.get("/api/authority/signing-keys", async () => store.listAuthoritySigningKeys());

  app.post("/api/messages/:id/authority-delivery", async (request) => {
    const principal = requestPrincipal(request);
    assertPrincipalKind(principal, "AGENT");
    const input = body(AuthorityDeliveryInputSchema, request);
    return store.getAuthorityDeliveryCandidate(principal, params(IdParamSchema, request).id, {
      sessionId: input.session_id,
      surfaceAttemptId: input.surface_attempt_id,
      recipientFence: input.recipient_fence,
    });
  });

  app.post("/api/messages/:id/authority-delivery/recover", async (request) => {
    const principal = requestPrincipal(request);
    assertPrincipalKind(principal, "AGENT");
    const input = body(RecoverAuthorityDeliveryInputSchema, request);
    return store.recoverAuthorityDelivery(principal, params(IdParamSchema, request).id, {
      sessionId: input.session_id,
    });
  });

  app.post("/api/projects/:projectId/directives/relay", async (request) => {
    const { projectId } = params(ProjectParamSchema, request);
    return store.relayUserDirective(
      requestPrincipal(request),
      projectId,
      body(RelayUserDirectiveInputSchema, request),
    );
  });

  app.post("/api/projects/:projectId/directives/delegate", async (request) => {
    const { projectId } = params(ProjectParamSchema, request);
    return store.delegateInstruction(
      requestPrincipal(request),
      projectId,
      body(DelegateInstructionInputSchema, request),
    );
  });

  app.get("/api/projects/:projectId/directives", async (request) => {
    const { projectId } = params(ProjectParamSchema, request);
    return store.listDirectives(requestPrincipal(request), projectId);
  });

  app.get("/api/directives/:id", async (request) => {
    const { id } = params(IdParamSchema, request);
    return store.getDirective(requestPrincipal(request), id);
  });

  app.post("/api/directives/:id/revoke", async (request) => {
    const { id } = params(IdParamSchema, request);
    return store.revokeDirective(
      requestPrincipal(request),
      id,
      body(DirectiveLifecycleMutationInputSchema, request),
    );
  });

  app.post("/api/directives/:id/supersede", async (request) => {
    const { id } = params(IdParamSchema, request);
    return store.supersedeUserDirective(
      requestPrincipal(request),
      id,
      body(SupersedeUserDirectiveInputSchema, request),
    );
  });

  app.post("/api/directives/:id/results", async (request) => {
    const { id } = params(IdParamSchema, request);
    return store.recordDirectiveExecutionResult(
      requestPrincipal(request),
      id,
      body(DirectiveExecutionResultInputSchema, request),
    );
  });

  app.post("/api/projects/:projectId/delegation-grants", async (request) => {
    const { projectId } = params(ProjectParamSchema, request);
    return store.createDelegationGrant(
      requestPrincipal(request),
      projectId,
      body(CreateDelegationGrantInputSchema, request),
    );
  });

  app.get("/api/projects/:projectId/delegation-grants", async (request) => {
    const { projectId } = params(ProjectParamSchema, request);
    return store.listDelegationGrants(requestPrincipal(request), projectId);
  });

  app.patch("/api/delegation-grants/:id", async (request) => {
    const { id } = params(IdParamSchema, request);
    return store.modifyDelegationGrant(
      requestPrincipal(request),
      id,
      body(ModifyDelegationGrantInputSchema, request),
    );
  });

  app.post("/api/delegation-grants/:id/terminate", async (request) => {
    const { id } = params(IdParamSchema, request);
    return store.terminateDelegationGrant(
      requestPrincipal(request),
      id,
      body(TerminateDelegationGrantInputSchema, request),
    );
  });

  app.get("/api/projects", async (request) => {
    const principal = requestPrincipal(request);
    if (principal.credentialClass === "SESSION_TICKET" && principal.projectId) {
      assertReadableProject(store, principal, principal.projectId);
    }
    const projects = store.listProjects();
    return principal.credentialClass === "SESSION_TICKET"
      ? projects.filter((project) => project.id === principal.projectId)
      : projects;
  });
  app.post("/api/projects/join", async (request) =>
    store.joinProject(requestPrincipal(request), body(JoinProjectInputSchema, request)),
  );
  app.get("/api/projects/:projectId/registration", async (request) => {
    const { projectId } = params(ProjectParamSchema, request);
    return store.getProjectRegistration(projectId);
  });

  app.get("/api/projects/:projectId/overview", async (request) => {
    const { projectId } = params(ProjectParamSchema, request);
    return store.getOverview(projectId, requestPrincipal(request));
  });

  app.get("/api/projects/:projectId/events", async (request) => {
    const { projectId } = params(ProjectParamSchema, request);
    const filters = query(
      z.object({
        afterSequence: z.coerce.number().int().nonnegative().default(0),
        limit: z.coerce.number().int().min(1).max(5000).default(1000),
        types: z.string().optional(),
      }),
      request,
    );
    return store.listEvents(
      projectId,
      filters.afterSequence,
      filters.limit,
      filters.types?.split(",").filter(Boolean),
      requestPrincipal(request),
    );
  });

  app.get("/api/projects/:projectId/sessions", async (request) => {
    const { projectId } = params(ProjectParamSchema, request);
    return store.listSessions(projectId);
  });

  app.get("/api/projects/:projectId/session-lineages/head", async (request) => {
    const { projectId } = params(ProjectParamSchema, request);
    return store.getSessionLineageHead(projectId, query(SessionLineageHeadQuerySchema, request));
  });

  app.post("/api/projects/:projectId/session-launch-reservations", async (request) => {
    const { projectId } = params(ProjectParamSchema, request);
    return store.reserveSessionLaunch(
      projectId,
      body(ReserveSessionLaunchInputSchema, request),
      requestPrincipal(request),
    );
  });

  app.post("/api/projects/:projectId/session-ticket-offers", async (request) => {
    const { projectId } = params(ProjectParamSchema, request);
    return store.createSessionTicketOffer(
      requestPrincipal(request),
      projectId,
      body(SessionTicketOfferInputSchema, request),
    );
  });

  app.post("/api/projects/:projectId/sessions", async (request) => {
    const { projectId } = params(ProjectParamSchema, request);
    const principal = requestPrincipal(request);
    if (principal.credentialClass === "SESSION_TICKET") {
      const parsed = RegisterAdapterSessionInputSchema.parse({
        ...(request.body as object),
        projectId,
      });
      return {
        ...store.registerAdapterSession(parsed, principal),
        serverNow: new Date().toISOString(),
      };
    }
    const parsed = RegisterSessionInputSchema.safeExtend({
      idempotencyKey: z.string().min(1),
    }).parse({ ...(request.body as object), projectId });
    return store.registerSession(parsed, principal);
  });

  app.post("/api/sessions/:id/heartbeat", async (request) => {
    const { id } = params(IdParamSchema, request);
    const parsed = HeartbeatInputSchema.parse({ ...(request.body as object), sessionId: id });
    return store.heartbeat(parsed, requestPrincipal(request));
  });

  app.post("/api/sessions/:id/adapter-events", async (request) => {
    const { id } = params(IdParamSchema, request);
    const parsed = z
      .object({
        method: z.string().min(1).max(160),
        externalTurnId: z.string().nullable().optional(),
        workState: z.string().max(80).optional(),
        itemType: z.string().max(120).optional(),
        itemId: z.string().max(200).optional(),
        commandName: z.string().max(200).optional(),
        exitCode: z.number().int().nullable().optional(),
        files: z.array(z.string().max(1000)).max(200).optional(),
        status: z.string().max(100).optional(),
        error: z.string().max(4000).optional(),
        idempotencyKey: z.string().min(1).max(300),
      })
      .parse(request.body);
    return store.recordAdapterEvent(id, parsed, requestPrincipal(request));
  });

  app.post("/api/sessions/:id/close", async (request) => {
    const { id } = params(IdParamSchema, request);
    const principal = requestPrincipal(request);
    if (principal.credentialClass === "SESSION_TICKET") {
      return store.closeAdapterSession(
        id,
        body(CloseAdapterSessionInputSchema, request),
        principal,
      );
    }
    const parsed = z
      .object({ reason: z.string().default("client_closed") })
      .strict()
      .parse(request.body);
    return store.closeSession(id, parsed.reason, principal);
  });

  app.post(
    "/api/sessions/:sessionId/session-ticket-bundles/:bundleId/activate",
    async (request) => {
      const { sessionId, bundleId } = params(SessionTicketBundleParamSchema, request);
      return {
        ...store.rotateAdapterSessionTickets(
          sessionId,
          bundleId,
          body(RotateAdapterSessionTicketsInputSchema, request),
          requestPrincipal(request),
        ),
        serverNow: new Date().toISOString(),
      };
    },
  );

  app.post("/api/projects/:projectId/objectives", async (request) => {
    const { projectId } = params(ProjectParamSchema, request);
    const parsed = CreateObjectiveInputSchema.extend({
      idempotencyKey: z.string().min(1),
    }).parse(request.body);
    return store.createObjective(requestPrincipal(request), projectId, parsed);
  });

  app.post("/api/projects/:projectId/milestones", async (request) => {
    const { projectId } = params(ProjectParamSchema, request);
    const parsed = CreateMilestoneInputSchema.extend({
      idempotencyKey: z.string().min(1),
    }).parse(request.body);
    return store.createMilestone(requestPrincipal(request), projectId, parsed);
  });

  app.get("/api/projects/:projectId/tasks", async (request) => {
    const { projectId } = params(ProjectParamSchema, request);
    const filters = query(
      z.object({
        status: z.string().optional(),
        ownerAgentId: z.string().optional(),
        readyOnly: z
          .union([z.boolean(), z.literal("true"), z.literal("false")])
          .transform((value) => value === true || value === "true")
          .optional(),
      }),
      request,
    );
    return store.listTasks(projectId, filters);
  });

  app.post("/api/projects/:projectId/tasks", async (request) => {
    const { projectId } = params(ProjectParamSchema, request);
    return store.createTask(
      requestPrincipal(request),
      projectId,
      body(CreateTaskInputSchema, request),
    );
  });

  app.get("/api/tasks/:id", async (request) => {
    const { id } = params(IdParamSchema, request);
    const task = store.getTask(id);
    assertReadableProject(store, requestPrincipal(request), task.projectId);
    return { ...task, todos: store.listTodos(id) };
  });

  app.patch("/api/tasks/:id", async (request) => {
    const { id } = params(IdParamSchema, request);
    const parsed = UpdateTaskInputSchema.extend({
      sessionId: z.string().optional(),
    }).parse(request.body);
    return store.updateTask(requestPrincipal(request), id, parsed);
  });

  app.post("/api/tasks/:id/claim", async (request) => {
    const { id } = params(IdParamSchema, request);
    return store.claimTask(id, body(ClaimTaskInputSchema, request), requestPrincipal(request));
  });

  app.post("/api/tasks/:id/release", async (request) => {
    const { id } = params(IdParamSchema, request);
    const parsed = z
      .object({
        sessionId: z.string(),
        expectedVersion: z.number().int().nonnegative(),
        idempotencyKey: z.string().min(1),
      })
      .parse(request.body);
    return store.releaseTask(id, parsed, requestPrincipal(request));
  });

  app.post("/api/tasks/:id/handoff", async (request) => {
    const { id } = params(IdParamSchema, request);
    const parsed = z
      .object({
        sessionId: z.string(),
        expectedVersion: z.number().int().nonnegative(),
        toAgentId: z.string().min(1),
        summary: z.string().min(1).max(1600),
        idempotencyKey: z.string().min(1),
      })
      .parse(request.body);
    return store.handoffTask(id, parsed, requestPrincipal(request));
  });

  app.post("/api/tasks/:id/split", async (request) => {
    const { id } = params(IdParamSchema, request);
    const parsed = z
      .object({
        expectedVersion: z.number().int().nonnegative(),
        sessionId: z.string(),
        idempotencyKey: z.string().min(1),
        children: z
          .array(
            z.object({
              title: z.string().min(1).max(400),
              description: z.string().optional(),
              capabilityTags: z.array(z.string()).optional(),
              scopeGlobs: z.array(z.string()).optional(),
              weight: z.number().positive().optional(),
            }),
          )
          .min(2),
      })
      .parse(request.body);
    return store.splitTask(id, parsed, requestPrincipal(request));
  });

  app.post("/api/tasks/:id/todos", async (request) => {
    const { id } = params(IdParamSchema, request);
    const parsed = CreateTodoInputSchema.extend({
      sessionId: z.string().optional(),
    }).parse(request.body);
    return store.createTodo(requestPrincipal(request), id, parsed);
  });

  app.patch("/api/todos/:id", async (request) => {
    const { id } = params(IdParamSchema, request);
    return store.updateTodo(requestPrincipal(request), id, body(UpdateTodoInputSchema, request));
  });

  app.get("/api/projects/:projectId/messages", async (request) => {
    const { projectId } = params(ProjectParamSchema, request);
    const filters = query(
      z
        .object({
          agentId: z.string().optional(),
          sessionId: z.string().optional(),
          type: z.string().optional(),
          unresolved: z
            .union([z.boolean(), z.literal("true"), z.literal("false")])
            .transform((value) => value === true || value === "true")
            .optional(),
          unread: z
            .union([z.boolean(), z.literal("true"), z.literal("false")])
            .transform((value) => value === true || value === "true")
            .optional(),
          recipientUnsettled: z
            .union([z.boolean(), z.literal("true"), z.literal("false")])
            .transform((value) => value === true || value === "true")
            .optional(),
          taskId: z.string().optional(),
          search: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(500).default(100),
          beforeSequence: z.coerce.number().int().positive().optional(),
        })
        .superRefine((value, ctx) => {
          if (!value.recipientUnsettled) return;
          if (!value.agentId?.trim()) {
            ctx.addIssue({
              code: "custom",
              path: ["agentId"],
              message: "recipientUnsettled requires agentId",
            });
          }
          if (!value.sessionId?.trim()) {
            ctx.addIssue({
              code: "custom",
              path: ["sessionId"],
              message: "recipientUnsettled requires sessionId",
            });
          }
          for (const legacyFilter of ["unread", "unresolved"] as const) {
            if (value[legacyFilter]) {
              ctx.addIssue({
                code: "custom",
                path: [legacyFilter],
                message: `recipientUnsettled cannot be combined with ${legacyFilter}`,
              });
            }
          }
        }),
      request,
    );
    return store.listMessages(projectId, filters, requestPrincipal(request));
  });

  app.post("/api/projects/:projectId/messages", async (request) => {
    const { projectId } = params(ProjectParamSchema, request);
    return store.postMessage(
      requestPrincipal(request),
      projectId,
      body(PostMessageInputSchema, request),
    );
  });

  app.get("/api/messages/:id", async (request) => {
    const { id } = params(IdParamSchema, request);
    return store.getMessage(id, requestPrincipal(request));
  });

  app.post("/api/messages/:id/claim", async (request) => {
    const { id } = params(IdParamSchema, request);
    return store.claimMessageRecipient(
      requestPrincipal(request),
      id,
      body(ClaimMessageRecipientInputSchema, request),
    );
  });

  app.post("/api/messages/:id/surface-attempts", async (request) => {
    const { id } = params(IdParamSchema, request);
    return store.beginMessageSurface(
      requestPrincipal(request),
      id,
      body(BeginMessageSurfaceInputSchema, request),
    );
  });

  app.post("/api/messages/:id/surface-attempts/:attemptId/state", async (request) => {
    const { id, attemptId } = params(MessageSurfaceParamSchema, request);
    return store.updateMessageSurface(
      requestPrincipal(request),
      id,
      attemptId,
      body(UpdateMessageSurfaceInputSchema, request),
    );
  });

  app.post("/api/messages/:id/surface-attempts/:attemptId/reconcile-ordinary", async (request) => {
    const { id, attemptId } = params(MessageSurfaceParamSchema, request);
    return store.reconcileOrdinaryMessageSurface(
      requestPrincipal(request),
      id,
      attemptId,
      body(ReconcileOrdinaryMessageSurfaceInputSchema, request),
    );
  });

  for (const [path, state] of [
    ["ack", "ACKNOWLEDGED"],
    ["processed", "PROCESSED"],
    ["responded", "RESPONDED"],
    ["delivered", "DELIVERED"],
  ] as const) {
    app.post(`/api/messages/:id/${path}`, async (request) => {
      const { id } = params(IdParamSchema, request);
      const parsed = MessageStateInputSchema.omit({ state: true }).parse(request.body);
      return store.updateMessageState(requestPrincipal(request), id, { ...parsed, state });
    });
  }

  app.get("/api/projects/:projectId/authorizations", async (request) => {
    const { projectId } = params(ProjectParamSchema, request);
    const filters = query(z.object({ status: z.string().optional() }), request);
    return store.listAuthorizations(projectId, filters);
  });

  app.post("/api/projects/:projectId/authorizations", async (request) => {
    const { projectId } = params(ProjectParamSchema, request);
    return store.requestAuthorization(
      requestPrincipal(request),
      projectId,
      body(RequestAuthorizationInputSchema, request),
    );
  });

  app.get("/api/projects/:projectId/authorizations/check", async (request) => {
    const { projectId } = params(ProjectParamSchema, request);
    const { capability } = query(z.object({ capability: AuthorizationCapabilitySchema }), request);
    return store.checkAuthorization(projectId, capability);
  });

  app.post("/api/authorizations/:id/decision", async (request) => {
    const { id } = params(IdParamSchema, request);
    const parsed = body(DecideAuthorizationInputSchema, request);
    const principal = requestPrincipal(request);
    assertPrincipalKind(principal, "DASHBOARD_USER");
    return store.decideAuthorization(principal, id, parsed);
  });

  app.get("/api/onboarding", async (request) => {
    assertPrincipalKind(requestPrincipal(request), "DASHBOARD_USER");
    const { projectId } = query(z.object({ projectId: z.string().min(4).optional() }), request);
    // The root comes from the Hub's own registration, never from the request, so the paths this
    // reads are ones the Hub already recorded rather than ones a caller named.
    const root = projectId ? (store.getProjectRegistration(projectId).root ?? null) : null;
    return readOnboardingState({ dataDir: runtime.dataDir, projectRoot: root });
  });

  app.get("/api/model-presets", async (request) => {
    const { agentId } = query(z.object({ agentId: z.string().optional() }), request);
    return store.listModelPresets(agentId);
  });

  app.post("/api/model-presets", async (request) => {
    assertPrincipalKind(requestPrincipal(request), "DASHBOARD_USER");
    return store.upsertModelPreset(body(UpsertModelPresetInputSchema, request));
  });

  app.delete("/api/model-presets/:id", async (request) => {
    assertPrincipalKind(requestPrincipal(request), "DASHBOARD_USER");
    const { id } = params(IdParamSchema, request);
    store.deleteModelPreset(id);
    return { ok: true };
  });

  app.get("/api/projects/:projectId/terminals", async (request) => {
    const { projectId } = params(ProjectParamSchema, request);
    return pty.list(projectId);
  });

  app.post("/api/projects/:projectId/terminals", async (request) => {
    assertPrincipalKind(requestPrincipal(request), "DASHBOARD_USER");
    const { projectId } = params(ProjectParamSchema, request);
    const parsed = z
      .object({
        label: z.string().min(1).max(120),
        shell: z.string().min(1).max(500),
        args: z.array(z.string().max(2000)).max(64).default([]),
        cwd: z.string().min(1).optional(),
        cols: TerminalSizeSchema.shape.cols.optional(),
        rows: TerminalSizeSchema.shape.rows.optional(),
        requestedByAgentId: z.string().min(1).max(100).default("local-user"),
        /** Optional: resolve model and effort flags from the registry instead of hardcoding. */
        modelPresetId: z.string().optional(),
        reasoningEffort: z.string().max(40).optional(),
      })
      .parse(request.body);
    const registration = store.getProjectRegistration(projectId);
    const preset = parsed.modelPresetId
      ? store.listModelPresets().find((item) => item.id === parsed.modelPresetId)
      : undefined;
    if (parsed.modelPresetId && !preset) {
      throw new NotFoundError("Model preset", parsed.modelPresetId);
    }
    // Both checks exist because the failure they prevent is invisible until the CLI refuses to
    // start: a disabled preset and an effort the preset never declared each produce argv that
    // looks well-formed here and dies in the terminal.
    if (preset && !preset.enabled) {
      throw new HubError(`Model preset ${preset.label} is disabled`, 422, "MODEL_PRESET_DISABLED");
    }
    if (parsed.reasoningEffort) {
      if (!preset) {
        throw new HubError("reasoningEffort requires modelPresetId", 422, "MODEL_PRESET_REQUIRED");
      }
      if (!preset.reasoningEfforts.includes(parsed.reasoningEffort)) {
        throw new HubError(
          `Model preset ${preset.label} does not declare the reasoning effort ${parsed.reasoningEffort}`,
          422,
          "REASONING_EFFORT_UNSUPPORTED",
        );
      }
    }
    const args = preset
      ? [...parsed.args, ...store.resolveLaunchArgs(preset, parsed.reasoningEffort)]
      : parsed.args;
    return pty.spawn({ ...parsed, args, projectId, cwd: parsed.cwd ?? registration.root });
  });

  app.delete("/api/terminals/:id", async (request) => {
    assertPrincipalKind(requestPrincipal(request), "DASHBOARD_USER");
    const { id } = params(IdParamSchema, request);
    pty.kill(id);
    return { ok: true };
  });

  app.get("/api/threads/:id", async (request) => {
    const { id } = params(IdParamSchema, request);
    return store.getThread(id, requestPrincipal(request));
  });

  app.post("/api/threads/:id/status", async (request) => {
    const { id } = params(IdParamSchema, request);
    const parsed = z
      .object({
        expectedVersion: z.number().int().nonnegative(),
        status: z.enum(["RESOLVED", "NEEDS_USER", "ARCHIVED"]),
        idempotencyKey: z.string().min(1),
      })
      .parse(request.body);
    return store.resolveThread(requestPrincipal(request), id, parsed);
  });

  app.post("/api/context-pack", async (request) =>
    store.getContextPack(body(ContextPackRequestSchema, request), requestPrincipal(request)),
  );

  app.get("/api/projects/:projectId/conflicts", async (request) => {
    const { projectId } = params(ProjectParamSchema, request);
    const filters = query(z.object({ status: z.string().optional() }), request);
    return store.listConflicts(projectId, filters.status);
  });

  app.post("/api/projects/:projectId/write-intents", async (request) => {
    const { projectId } = params(ProjectParamSchema, request);
    return store.setWriteIntent(
      projectId,
      body(WriteIntentInputSchema, request),
      requestPrincipal(request),
    );
  });

  app.delete("/api/write-intents/:id", async (request) => {
    const { id } = params(IdParamSchema, request);
    const parsed = z
      .object({
        sessionId: z.string().optional(),
        force: z.boolean().default(false),
        idempotencyKey: z.string().min(1),
      })
      .parse(request.body);
    return store.releaseWriteIntent(requestPrincipal(request), id, parsed);
  });

  app.post("/api/conflicts/:id/resolve", async (request) => {
    const { id } = params(IdParamSchema, request);
    const parsed = z
      .object({
        reason: z.string().min(1),
        idempotencyKey: z.string().min(1),
      })
      .parse(request.body);
    return store.resolveConflict(requestPrincipal(request), id, parsed);
  });

  app.post("/api/sessions/:id/reconcile-git", async (request) => {
    const { id } = params(IdParamSchema, request);
    return store.reconcileObservedChanges(id, requestPrincipal(request));
  });

  app.post("/api/tasks/:id/reviews", async (request) => {
    const { id } = params(IdParamSchema, request);
    return store.requestReview(
      id,
      body(RequestReviewInputSchema, request),
      requestPrincipal(request),
    );
  });

  app.get("/api/projects/:projectId/reviews", async (request) => {
    const { projectId } = params(ProjectParamSchema, request);
    const filters = query(z.object({ status: z.string().optional() }), request);
    return store.listReviews(projectId, filters.status);
  });

  app.get("/api/reviews/:id", async (request) => {
    const { id } = params(IdParamSchema, request);
    const review = store.getReview(id);
    assertReadableProject(store, requestPrincipal(request), review.projectId);
    return review;
  });

  app.post("/api/reviews/:id/begin", async (request) => {
    const { id } = params(IdParamSchema, request);
    const parsed = z
      .object({
        sessionId: z.string(),
        expectedVersion: z.number().int().nonnegative(),
        idempotencyKey: z.string().min(1),
      })
      .parse(request.body);
    return store.beginReview(id, parsed, requestPrincipal(request));
  });

  app.post("/api/reviews/:id/findings", async (request) => {
    const { id } = params(IdParamSchema, request);
    return store.createFinding(
      id,
      body(CreateFindingInputSchema, request),
      requestPrincipal(request),
    );
  });

  app.post("/api/reviews/:id/verdict", async (request) => {
    const { id } = params(IdParamSchema, request);
    return store.submitReviewVerdict(
      id,
      body(ReviewVerdictInputSchema, request),
      requestPrincipal(request),
    );
  });

  app.post("/api/findings/:id/resolve", async (request) => {
    const { id } = params(IdParamSchema, request);
    const parsed = z
      .object({
        sessionId: z.string(),
        status: z.enum(["ACCEPTED", "DISPUTED", "FIXED", "VERIFIED", "WONT_FIX"]),
        resolution: z.string().min(1),
        idempotencyKey: z.string().min(1),
      })
      .parse(request.body);
    return store.resolveFinding(id, parsed, requestPrincipal(request));
  });

  app.post("/api/projects/:projectId/artifacts", async (request) => {
    const { projectId } = params(ProjectParamSchema, request);
    const parsed = z
      .object({
        sessionId: z.string().optional(),
        taskId: z.string().optional(),
        reviewId: z.string().optional(),
        kind: z.string().min(1),
        name: z.string().min(1).max(240),
        mediaType: z.string().min(1),
        text: z.string().optional(),
        base64: z.string().optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
        idempotencyKey: z.string().min(1),
      })
      .refine((value) => value.text !== undefined || value.base64 !== undefined, {
        message: "text or base64 content is required",
      })
      .parse(request.body);
    return store.publishArtifact(requestPrincipal(request), projectId, parsed);
  });

  app.get("/api/artifacts/:id/content", async (request, reply) => {
    const { id } = params(IdParamSchema, request);
    const artifact = store.sqlite.prepare("SELECT * FROM artifacts WHERE id = ?").get(id) as any;
    if (!artifact) return reply.code(404).send({ code: "NOT_FOUND" });
    assertReadableProject(store, requestPrincipal(request), artifact.project_id as string);
    reply.type(artifact.media_type);
    reply.header(
      "content-disposition",
      `attachment; filename="${artifact.name.replaceAll('"', "")}"`,
    );
    return reply.send(readArtifact(artifact.storage_path));
  });

  app.get("/api/metrics/summary", async (request) => {
    const filters = query(z.object({ projectId: z.string().optional() }), request);
    const principal = requestPrincipal(request);
    if (filters.projectId) assertReadableProject(store, principal, filters.projectId);
    else if (principal.credentialClass === "SESSION_TICKET" && principal.projectId) {
      assertReadableProject(store, principal, principal.projectId);
    }
    return store.getMetrics(
      principal.credentialClass === "SESSION_TICKET"
        ? (principal.projectId ?? undefined)
        : filters.projectId,
    );
  });

  app.patch("/api/projects/:projectId/settings", async (request) => {
    const { projectId } = params(ProjectParamSchema, request);
    const parsed = z
      .object({
        expectedVersion: z.number().int().nonnegative(),
        config: z.record(z.string(), z.unknown()),
        idempotencyKey: z.string().min(1),
      })
      .parse(request.body);
    return store.updateProjectConfig(requestPrincipal(request), projectId, parsed);
  });
}
