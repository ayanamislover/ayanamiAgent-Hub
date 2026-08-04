import {
  DEFAULT_PROJECT_CONFIG,
  ProjectConfigSchema,
  SESSION_TICKET_PURPOSES_BY_CLIENT,
  clipText,
  createId,
  nowIso,
  type AgentSession,
  type CloseAdapterSessionInput,
  type CloseAdapterSessionResult,
  type DomainEvent,
  type RegisterAdapterSessionInput,
  type RegisterAdapterSessionResult,
  type RotateAdapterSessionTicketsInput,
  type RotateAdapterSessionTicketsResult,
  type SessionLaunchReservation,
  type SessionLineageHead,
  type SessionTicketBinding,
  type SessionTicketOffer,
  type SessionTicketOfferInput,
} from "@crossagent/protocol";
import { hostname } from "node:os";
import { canonicalPath } from "../../git/git-service.js";
import { HubError, NotFoundError } from "../../domain/errors.js";
import { json, mutationFingerprint, type StoreContext } from "./context.js";
import type { RequestPrincipal } from "../../security/local-auth.js";
import {
  activateSessionTicketBundle,
  assertExpiredAuxiliaryRotationNotCommitted,
  closeSessionTicketsForHubSession,
  createPendingSessionTicket,
  expireSessionTicketBundleForHubSession,
  getActiveSessionTicketBinding,
  rotateSessionTicketBundleForSession,
} from "../../security/session-tickets.js";
import {
  assertCanControlAdapterSession,
  assertCanControlAdapterTransport,
  assertCanCreateAdapterSession,
  assertCanRegisterTicketedAdapterSession,
  assertCanReserveSessionLaunch,
} from "./session-identity.js";

type SessionRow = Record<string, unknown> & {
  id: string;
  connection_state: AgentSession["connectionState"];
  current_review_id?: string | null;
  work_state?: string | null;
};

type SessionTicketRegistrationRow = {
  id: string;
  bundle_id: string;
  purpose: "CONTROL" | "MODEL_MCP" | "CAPTURE" | "INJECTOR";
  offered_by_ticket_id: string | null;
  project_id: string;
  adapter_client: "codex" | "claude";
  agent_id: string;
  session_client: string;
  role: "primary" | "reviewer" | "observer";
  transport: "websocket" | "hook-poll";
  delivery_mode: RegisterAdapterSessionInput["deliveryMode"];
  external_session_id: string | null;
  external_thread_id: string | null;
  run_id: string;
  activation_mode:
    "FIRST_LINEAGE" | "CURRENT_HEAD_REPLACEMENT" | "MANAGED_RESERVATION" | "SESSION_AUXILIARY";
  expected_lineage_id: string | null;
  expected_head_session_id: string | null;
  launch_reservation_id: string | null;
  hub_session_id: string | null;
  state: string;
  expires_at: string | null;
};

export type RegisterAdapterSessionReceipt = Omit<RegisterAdapterSessionResult, "serverNow">;
export type RotateAdapterSessionTicketsReceipt = Omit<
  RotateAdapterSessionTicketsResult,
  "serverNow"
>;
type AbortedAdapterSessionTicketRotation = {
  rotationState: "ABORTED";
  sessionId: string;
  predecessorBundleId: string;
  successorBundleId: string;
  abortedAt: string;
};

function isAbortedAdapterSessionTicketRotation(
  value: unknown,
): value is AbortedAdapterSessionTicketRotation {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<AbortedAdapterSessionTicketRotation>;
  return (
    candidate.rotationState === "ABORTED" &&
    typeof candidate.sessionId === "string" &&
    typeof candidate.predecessorBundleId === "string" &&
    typeof candidate.successorBundleId === "string" &&
    typeof candidate.abortedAt === "string"
  );
}

function hasActiveTicketBinding(ctx: StoreContext, hubSessionId: string): boolean {
  return Boolean(
    ctx.sqlite
      .prepare(
        `SELECT 1 FROM adapter_session_tickets
         WHERE hub_session_id = ? AND purpose = 'CONTROL' AND state = 'ACTIVE'`,
      )
      .get(hubSessionId),
  );
}

function bindCaptureSession(
  ctx: StoreContext,
  input: {
    sessionId: string;
    projectId: string;
    client: string;
    externalSessionId?: string;
    sessionTicketId?: string;
  },
  now: string,
): void {
  const clientType =
    input.client === "codex-cli-hooks"
      ? "codex"
      : input.client === "claude-hooks"
        ? "claude"
        : null;
  if (!clientType) return;
  if (!input.externalSessionId) {
    throw new HubError(
      "Hook sessions require an explicit external session id for user-turn capture",
      422,
      "CAPTURE_SESSION_ID_REQUIRED",
    );
  }
  if (!input.sessionTicketId) {
    throw new HubError(
      "Hook session registration requires an activated CAPTURE ticket",
      403,
      "CAPTURE_SESSION_TICKET_REQUIRED",
    );
  }
  const principalId = `prn_capture_${clientType}`;
  const credentialId = `crd_capture_${clientType}`;
  const credential = ctx.sqlite
    .prepare(
      `SELECT 1
       FROM auth_credentials c
       JOIN auth_principals p ON p.id = c.principal_id
       WHERE c.id = ? AND c.principal_id = ? AND c.revoked_at IS NULL
         AND p.kind = 'BRIDGE_CAPTURE' AND p.status = 'ACTIVE'`,
    )
    .get(credentialId, principalId);
  if (!credential) {
    throw new HubError(
      `Capture credential is unavailable for ${clientType}`,
      503,
      "CAPTURE_CREDENTIAL_UNAVAILABLE",
    );
  }
  ctx.sqlite
    .prepare(
      `INSERT INTO capture_session_bindings(
         id, project_id, principal_id, credential_id, session_ticket_id, client_type,
         source_session_id, hub_session_id, revoked_at, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    )
    .run(
      createId("cbd"),
      input.projectId,
      principalId,
      credentialId,
      input.sessionTicketId,
      clientType,
      input.externalSessionId,
      input.sessionId,
      now,
    );
}

function sessionFromRow(row: any): AgentSession {
  return {
    id: row.id,
    projectId: row.project_id,
    agentId: row.agent_id,
    role: row.role,
    client: row.client,
    transport: row.transport,
    deliveryMode: row.delivery_mode,
    externalSessionId: row.external_session_id,
    externalThreadId: row.external_thread_id,
    externalTurnId: row.external_turn_id,
    host: row.host,
    pid: row.pid,
    cwd: row.cwd,
    gitBranch: row.git_branch,
    gitHead: row.git_head,
    capabilities: json(row.capabilities_json, []),
    connectedAt: row.connected_at,
    transportLastSeenAt: row.transport_last_seen_at,
    activityLastSeenAt: row.activity_last_seen_at,
    currentTaskId: row.current_task_id,
    currentReviewId: row.current_review_id,
    activeFiles: json(row.active_files_json, []),
    workState: row.work_state,
    connectionState: row.connection_state,
    queueDepth: row.queue_depth,
    lineageId: row.lineage_id,
    incarnation: row.incarnation,
    predecessorSessionId: row.predecessor_session_id,
    supersededBySessionId: row.superseded_by_session_id,
    launcherRunId: row.launcher_run_id,
    launchGeneration: row.launch_generation,
    version: row.version,
  } as AgentSession;
}

type LogicalIdentity = {
  kind: "external_thread" | "external_session";
  value: string;
};

type SessionLineageRow = {
  id: string;
  project_id: string;
  head_session_id: string | null;
  head_incarnation: number;
  launch_fence_required: number;
  reserved_generation: number;
  active_reservation_id: string | null;
  head_run_id: string | null;
  head_run_generation: number | null;
  version: number;
};

type SessionLaunchReservationRow = {
  id: string;
  project_id: string;
  lineage_id: string;
  run_id: string;
  generation: number;
  expected_head_session_id: string | null;
  state: SessionLaunchReservation["state"];
  consumed_session_id: string | null;
  created_at: string;
  updated_at: string;
};

type SessionLaunchReservationViewRow = SessionLaunchReservationRow & {
  agent_id: string;
  client: string;
  delivery_mode: string;
  identity_kind: LogicalIdentity["kind"];
  identity_value: string;
};

function launchReservationFromRow(row: SessionLaunchReservationViewRow): SessionLaunchReservation {
  return {
    id: row.id,
    projectId: row.project_id,
    lineageId: row.lineage_id,
    agentId: row.agent_id,
    client: row.client as SessionLaunchReservation["client"],
    deliveryMode: row.delivery_mode as SessionLaunchReservation["deliveryMode"],
    identityKind: row.identity_kind,
    identityValue: row.identity_value,
    runId: row.run_id,
    generation: row.generation,
    expectedHeadSessionId: row.expected_head_session_id,
    state: row.state,
    consumedSessionId: row.consumed_session_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function logicalIdentity(input: {
  externalThreadId?: string;
  externalSessionId?: string;
}): LogicalIdentity | null {
  if (input.externalThreadId) {
    return { kind: "external_thread", value: input.externalThreadId };
  }
  if (input.externalSessionId) {
    return { kind: "external_session", value: input.externalSessionId };
  }
  return null;
}

function lineageRow(
  ctx: StoreContext,
  projectId: string,
  input: {
    agentId: string;
    client: string;
    deliveryMode: string;
    externalThreadId?: string;
    externalSessionId?: string;
  },
): SessionLineageRow | undefined {
  const identity = logicalIdentity(input);
  if (!identity) return undefined;
  return ctx.sqlite
    .prepare(
      `SELECT id, project_id, head_session_id, head_incarnation,
              launch_fence_required, reserved_generation, active_reservation_id,
              head_run_id, head_run_generation, version
         FROM session_lineages
        WHERE project_id = ? AND agent_id = ? AND client = ? AND delivery_mode = ?
          AND identity_kind = ? AND identity_value = ?`,
    )
    .get(
      projectId,
      input.agentId,
      input.client,
      input.deliveryMode,
      identity.kind,
      identity.value,
    ) as SessionLineageRow | undefined;
}

function createLineage(
  ctx: StoreContext,
  projectId: string,
  input: {
    agentId: string;
    client: string;
    deliveryMode: string;
  },
  identity: LogicalIdentity,
  now: string,
  launchFenceRequired: boolean,
): SessionLineageRow {
  const lineageId = createId("lin");
  ctx.sqlite
    .prepare(
      `INSERT INTO session_lineages(
          id, project_id, agent_id, client, delivery_mode, identity_kind, identity_value,
          head_session_id, head_incarnation, launch_fence_required, reserved_generation,
          active_reservation_id, head_run_id, head_run_generation, version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, 0, NULL, NULL, NULL, 0, ?, ?)`,
    )
    .run(
      lineageId,
      projectId,
      input.agentId,
      input.client,
      input.deliveryMode,
      identity.kind,
      identity.value,
      launchFenceRequired ? 1 : 0,
      now,
      now,
    );
  return lineageRow(ctx, projectId, input)!;
}

function launchReservationRowByRun(
  ctx: StoreContext,
  runId: string,
): SessionLaunchReservationViewRow | undefined {
  return ctx.sqlite
    .prepare(
      `SELECT reservation.*, lineage.agent_id, lineage.client, lineage.delivery_mode,
              lineage.identity_kind, lineage.identity_value
         FROM session_launch_reservations AS reservation
         JOIN session_lineages AS lineage ON lineage.id = reservation.lineage_id
        WHERE reservation.run_id = ?`,
    )
    .get(runId) as SessionLaunchReservationViewRow | undefined;
}

export function reserveSessionLaunch(
  ctx: StoreContext,
  projectId: string,
  input: {
    agentId: string;
    client: string;
    deliveryMode: string;
    externalThreadId?: string;
    externalSessionId?: string;
    runId: string;
    idempotencyKey: string;
  },
  principal?: RequestPrincipal,
): SessionLaunchReservation {
  // Calls without a principal are trusted in-process maintenance/test calls. Every transport route
  // passes its server-derived RequestPrincipal, before mutate can observe an idempotency replay.
  if (principal) assertCanReserveSessionLaunch(principal, { projectId, ...input });
  const identity = logicalIdentity(input);
  if (!identity) {
    throw new HubError(
      "A managed session launch requires an external thread or session identity",
      422,
      "SESSION_LOGICAL_IDENTITY_REQUIRED",
    );
  }
  const reserved = ctx.mutate(
    projectId,
    input.idempotencyKey,
    "session.launch.reserve",
    ({ emit }) => {
      const existingRun = launchReservationRowByRun(ctx, input.runId);
      if (existingRun) {
        const sameLineage =
          existingRun.project_id === projectId &&
          existingRun.agent_id === input.agentId &&
          existingRun.client === input.client &&
          existingRun.delivery_mode === input.deliveryMode &&
          existingRun.identity_kind === identity.kind &&
          existingRun.identity_value === identity.value;
        if (!sameLineage) {
          throw new HubError(
            "Launcher run id is already reserved for another logical session",
            409,
            "SESSION_LAUNCH_RUN_CONFLICT",
          );
        }
        if (existingRun.state === "SUPERSEDED") {
          throw new HubError(
            "Launcher reservation has been superseded",
            409,
            "SESSION_LAUNCH_RESERVATION_SUPERSEDED",
          );
        }
        return launchReservationFromRow(existingRun);
      }

      const now = nowIso();
      let lineage = lineageRow(ctx, projectId, input);
      if (!lineage) {
        lineage = createLineage(ctx, projectId, input, identity, now, true);
      }
      const generation = lineage.reserved_generation + 1;
      const reservationId = createId("rsr");
      const detached = ctx.sqlite
        .prepare(
          `UPDATE session_lineages
              SET active_reservation_id = NULL, updated_at = ?
            WHERE id = ? AND active_reservation_id IS ?
              AND reserved_generation = ? AND version = ?`,
        )
        .run(
          now,
          lineage.id,
          lineage.active_reservation_id,
          lineage.reserved_generation,
          lineage.version,
        );
      if (detached.changes !== 1) {
        throw new HubError(
          "Logical session launch reservation changed before replacement",
          409,
          "SESSION_LAUNCH_FENCE_STALE",
        );
      }
      ctx.sqlite
        .prepare(
          `UPDATE session_launch_reservations
              SET state = 'SUPERSEDED', updated_at = ?
            WHERE lineage_id = ? AND state = 'ISSUED'`,
        )
        .run(now, lineage.id);
      ctx.sqlite
        .prepare(
          `INSERT INTO session_launch_reservations(
              id, project_id, lineage_id, run_id, generation, expected_head_session_id,
              state, consumed_session_id, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, 'ISSUED', NULL, ?, ?)`,
        )
        .run(
          reservationId,
          projectId,
          lineage.id,
          input.runId,
          generation,
          lineage.head_session_id,
          now,
          now,
        );
      const advanced = ctx.sqlite
        .prepare(
          `UPDATE session_lineages
              SET launch_fence_required = 1, reserved_generation = ?,
                  active_reservation_id = ?, version = version + 1, updated_at = ?
            WHERE id = ? AND reserved_generation = ? AND version = ?`,
        )
        .run(
          generation,
          reservationId,
          now,
          lineage.id,
          lineage.reserved_generation,
          lineage.version,
        );
      if (advanced.changes !== 1) {
        throw new HubError(
          "Logical session launch reservation changed before commit",
          409,
          "SESSION_LAUNCH_FENCE_STALE",
        );
      }
      emit({
        projectId,
        type: "session.launch.reserved",
        actorType: "agent",
        actorId: input.agentId,
        aggregateType: "session_lineage",
        aggregateId: lineage.id,
        causationId: reservationId,
        correlationId: identity.value,
        payload: {
          reservationId,
          runId: input.runId,
          generation,
          expectedHeadSessionId: lineage.head_session_id,
          client: input.client,
          deliveryMode: input.deliveryMode,
        },
      });
      return launchReservationFromRow(launchReservationRowByRun(ctx, input.runId)!);
    },
  );
  const current = launchReservationRowByRun(ctx, reserved.runId);
  const requestMatches =
    current?.id === reserved.id &&
    current.run_id === input.runId &&
    current.project_id === projectId &&
    current.agent_id === input.agentId &&
    current.client === input.client &&
    current.delivery_mode === input.deliveryMode &&
    current.identity_kind === identity.kind &&
    current.identity_value === identity.value;
  if (!requestMatches) {
    throw new HubError(
      "Idempotency key was already used for another session launch request",
      409,
      "SESSION_LAUNCH_REQUEST_CONFLICT",
    );
  }
  if (!current || current.state === "SUPERSEDED") {
    throw new HubError(
      "Launcher reservation has been superseded",
      409,
      "SESSION_LAUNCH_RESERVATION_SUPERSEDED",
    );
  }
  return launchReservationFromRow(current);
}

export function getSessionLineageHead(
  ctx: StoreContext,
  projectId: string,
  input: {
    agentId: string;
    client: string;
    deliveryMode: string;
    externalThreadId?: string;
    externalSessionId?: string;
  },
): SessionLineageHead | null {
  const lineage = lineageRow(ctx, projectId, input);
  if (!lineage?.head_session_id || lineage.head_incarnation < 1) return null;
  return {
    lineageId: lineage.id,
    headSessionId: lineage.head_session_id,
    headIncarnation: lineage.head_incarnation,
    version: lineage.version,
  };
}

function assertTicketOfferAuthority(
  ctx: StoreContext,
  principal: RequestPrincipal,
  projectId: string,
  input: SessionTicketOfferInput,
): { offeredByAuthCredentialId?: string; offeredByTicketId?: string } {
  if (principal.projectId && principal.projectId !== projectId) {
    throw new HubError(
      "Ticket offer credential is bound to another project",
      403,
      "TICKET_OFFER_NOT_AUTHORIZED",
    );
  }
  if (input.adapter_client !== input.agent_id || principal.clientType !== input.adapter_client) {
    throw new HubError(
      "Ticket offer identity does not match the Adapter",
      403,
      "TICKET_OFFER_NOT_AUTHORIZED",
    );
  }
  if (
    input.session_client !== "codex-app-server" &&
    !input.external_session_id &&
    !input.external_thread_id
  ) {
    throw new HubError(
      "Channel and Hook ticket offers require a stable external identity",
      422,
      "TICKET_BINDING_MISMATCH",
    );
  }
  if (principal.credentialClass === "STATIC") {
    const permitted =
      (principal.kind === "AGENT" &&
        principal.scopes.includes("session-ticket:offer") &&
        (input.purpose === "CONTROL" || input.purpose === "MODEL_MCP") &&
        (input.activation_mode === "FIRST_LINEAGE" ||
          input.activation_mode === "MANAGED_RESERVATION")) ||
      (principal.kind === "BRIDGE_CAPTURE" &&
        principal.scopes.includes("session-ticket:offer:capture") &&
        input.purpose === "CAPTURE") ||
      (principal.kind === "BRIDGE_INJECTOR" &&
        principal.scopes.includes("session-ticket:offer:injector") &&
        input.purpose === "INJECTOR");
    if (!permitted) {
      throw new HubError(
        "Static credential cannot offer this ticket",
        403,
        "TICKET_OFFER_NOT_AUTHORIZED",
      );
    }
    return { offeredByAuthCredentialId: principal.credentialId };
  }
  if (
    principal.kind === "AGENT" &&
    principal.credentialClass === "SESSION_TICKET" &&
    principal.ticketPurpose === "CONTROL" &&
    principal.ticketState === "EXPIRED" &&
    principal.scopes.length === 0 &&
    principal.projectId === projectId &&
    principal.agentId === input.agent_id &&
    principal.adapterClient === input.adapter_client &&
    principal.hubSessionId &&
    principal.lineageId &&
    principal.incarnation &&
    input.activation_mode === "CURRENT_HEAD_REPLACEMENT" &&
    input.expected_lineage_id === principal.lineageId &&
    input.expected_head_session_id === principal.hubSessionId &&
    (input.purpose === "CONTROL" || input.purpose === "MODEL_MCP")
  ) {
    const current = getOpenSession(ctx, principal.hubSessionId);
    if (
      current.projectId !== projectId ||
      current.agentId !== input.agent_id ||
      current.client !== input.session_client ||
      current.role !== input.role ||
      current.transport !== input.transport ||
      current.deliveryMode !== input.delivery_mode ||
      current.lineageId !== principal.lineageId ||
      current.incarnation !== principal.incarnation ||
      current.externalSessionId !== (input.external_session_id ?? null) ||
      current.externalThreadId !== (input.external_thread_id ?? null)
    ) {
      throw new HubError(
        "Expired CONTROL replacement binding differs from the current Hook session",
        403,
        "TICKET_BINDING_MISMATCH",
      );
    }
    return { offeredByTicketId: principal.credentialId };
  }
  if (
    principal.kind !== "AGENT" ||
    principal.ticketPurpose !== "CONTROL" ||
    principal.ticketState !== "ACTIVE" ||
    !principal.scopes.includes("session-ticket:offer") ||
    principal.projectId !== projectId ||
    principal.agentId !== input.agent_id ||
    principal.adapterClient !== input.adapter_client ||
    !principal.hubSessionId ||
    !principal.lineageId ||
    (input.purpose !== "CONTROL" && input.purpose !== "MODEL_MCP") ||
    (input.activation_mode !== "CURRENT_HEAD_REPLACEMENT" &&
      input.activation_mode !== "SESSION_AUXILIARY") ||
    input.expected_lineage_id !== principal.lineageId ||
    input.expected_head_session_id !== principal.hubSessionId
  ) {
    throw new HubError(
      "CONTROL ticket cannot offer this binding",
      403,
      "TICKET_OFFER_NOT_AUTHORIZED",
    );
  }
  const controllingSession = getOpenSession(ctx, principal.hubSessionId);
  assertCanControlAdapterSession(ctx.sqlite, principal, controllingSession);
  if (
    input.activation_mode === "SESSION_AUXILIARY" &&
    (input.session_client !== controllingSession.client ||
      input.role !== controllingSession.role ||
      input.transport !== controllingSession.transport ||
      input.delivery_mode !== controllingSession.deliveryMode ||
      input.run_id !== controllingSession.launcherRunId ||
      input.external_session_id !== controllingSession.externalSessionId ||
      input.external_thread_id !== controllingSession.externalThreadId)
  ) {
    throw new HubError(
      "Auxiliary ticket binding differs from the active session",
      403,
      "TICKET_BINDING_MISMATCH",
    );
  }
  return { offeredByTicketId: principal.credentialId };
}

export function createSessionTicketOffer(
  ctx: StoreContext,
  principal: RequestPrincipal,
  projectId: string,
  input: SessionTicketOfferInput,
): SessionTicketOffer {
  if (!ctx.sqlite.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId)) {
    throw new NotFoundError("Project", projectId);
  }
  const provenance = assertTicketOfferAuthority(ctx, principal, projectId, input);
  return ctx.mutate(
    projectId,
    input.idempotency_key,
    "session.ticket.offer",
    ({ emit }) => {
      const offered = createPendingSessionTicket(ctx.sqlite, {
        bundleId: input.bundle_id,
        purpose: input.purpose,
        tokenSha256: input.token_sha256,
        ...provenance,
        projectId,
        adapterClient: input.adapter_client,
        agentId: input.agent_id,
        sessionClient: input.session_client,
        role: input.role,
        transport: input.transport,
        deliveryMode: input.delivery_mode,
        externalSessionId: input.external_session_id ?? undefined,
        externalThreadId: input.external_thread_id ?? undefined,
        runId: input.run_id,
        activationMode: input.activation_mode,
        expectedLineageId: input.expected_lineage_id,
        expectedHeadSessionId: input.expected_head_session_id ?? undefined,
        launchReservationId: input.launch_reservation_id,
        idempotencyKey: input.idempotency_key,
        now: nowIso(),
      });
      emit({
        projectId,
        type: "session.ticket.offered",
        actorType: "agent",
        actorId: principal.agentId ?? principal.id,
        aggregateType: "session_ticket_bundle",
        aggregateId: input.bundle_id,
        causationId: offered.id,
        correlationId: input.run_id,
        payload: {
          purpose: input.purpose,
          adapterClient: input.adapter_client,
          sessionClient: input.session_client,
          activationMode: input.activation_mode,
        },
      });
      return {
        id: offered.id,
        bundle_id: offered.bundleId,
        purpose: offered.purpose,
        state: "PENDING" as const,
        project_id: offered.projectId,
        adapter_client: offered.adapterClient,
        agent_id: offered.agentId as "codex" | "claude",
        session_client: offered.sessionClient,
        role: input.role,
        transport: input.transport,
        delivery_mode: input.delivery_mode,
        external_session_id: input.external_session_id ?? null,
        external_thread_id: input.external_thread_id ?? null,
        run_id: offered.runId,
        offer_expires_at: offered.offerExpiresAt,
      };
    },
    {
      requestFingerprint: mutationFingerprint({ principalId: principal.id, projectId, input }),
    },
  );
}

export function registerSession(
  ctx: StoreContext,
  input: {
    projectId: string;
    agentId: string;
    role: "primary" | "reviewer" | "observer";
    client: string;
    transport: string;
    deliveryMode: string;
    externalSessionId?: string;
    externalThreadId?: string;
    externalTurnId?: string;
    host?: string;
    pid?: number;
    cwd: string;
    gitBranch?: string;
    gitHead?: string;
    capabilities: string[];
    expectedHeadSessionId?: string | null;
    launcherRunId?: string;
    launchGeneration?: number;
    idempotencyKey: string;
  },
  principal?: RequestPrincipal,
  ticketEnrollment?: { bundleId: string; controlTicketId: string },
): AgentSession {
  if (principal) {
    if (ticketEnrollment) assertCanRegisterTicketedAdapterSession(principal, input);
    else assertCanCreateAdapterSession(principal, input);
  }
  const registered = ctx.mutate(
    input.projectId,
    input.idempotencyKey,
    ticketEnrollment ? "session.register.ticketed" : "session.register",
    ({ emit }) => {
      const id = createId("ses");
      const now = nowIso();
      let ticketControl: SessionTicketRegistrationRow | undefined;
      let ticketRows: SessionTicketRegistrationRow[] = [];
      if (ticketEnrollment) {
        ticketControl = ctx.sqlite
          .prepare(
            `SELECT * FROM adapter_session_tickets
             WHERE id = ? AND bundle_id = ? AND purpose = 'CONTROL'`,
          )
          .get(ticketEnrollment.controlTicketId, ticketEnrollment.bundleId) as
          SessionTicketRegistrationRow | undefined;
        ticketRows = ctx.sqlite
          .prepare("SELECT * FROM adapter_session_tickets WHERE bundle_id = ? ORDER BY purpose")
          .all(ticketEnrollment.bundleId) as SessionTicketRegistrationRow[];
        const expectedPurposes =
          SESSION_TICKET_PURPOSES_BY_CLIENT[
            input.client as keyof typeof SESSION_TICKET_PURPOSES_BY_CLIENT
          ] ?? [];
        const actualPurposes = ticketRows.map((ticket) => ticket.purpose).sort();
        if (
          !ticketControl ||
          ticketControl.state !== "PENDING" ||
          ticketRows.some((ticket) => ticket.state !== "PENDING") ||
          actualPurposes.length !== expectedPurposes.length ||
          expectedPurposes.some((purpose) => !actualPurposes.includes(purpose)) ||
          ticketControl.project_id !== input.projectId ||
          ticketControl.agent_id !== input.agentId ||
          ticketControl.adapter_client !== input.agentId ||
          ticketControl.session_client !== input.client ||
          ticketControl.role !== input.role ||
          ticketControl.transport !== input.transport ||
          ticketControl.delivery_mode !== input.deliveryMode ||
          ticketControl.external_session_id !== (input.externalSessionId ?? null) ||
          ticketControl.external_thread_id !== (input.externalThreadId ?? null) ||
          ticketControl.activation_mode === "SESSION_AUXILIARY"
        ) {
          throw new HubError(
            "Ticket bundle does not exactly authorize this Adapter registration",
            403,
            "TICKET_BINDING_MISMATCH",
          );
        }
      }
      // An explicit external identity is the replacement Seam. Two workers can share one project and
      // agent id without being replacements; only another primary for the exact same adapter/logical
      // worker may be closed and rebound. Treating two absent identities as equivalent would make
      // independent generic adapters steal each other's work, so those sessions age out through
      // presence instead of being implicitly replaced.
      const declaredIdentity = logicalIdentity(input);
      if (input.client === "codex-app-server" && !declaredIdentity) {
        throw new HubError(
          "Managed Codex app-server registration requires an external thread or session identity",
          422,
          "SESSION_LOGICAL_IDENTITY_REQUIRED",
        );
      }
      if (input.client === "codex-app-server" && input.role !== "primary") {
        throw new HubError(
          "Managed Codex app-server sessions must use the primary role",
          422,
          "SESSION_ROLE_UNSUPPORTED",
        );
      }
      const identity = input.role === "primary" ? declaredIdentity : null;
      if (
        identity &&
        input.client === "codex-app-server" &&
        !input.launcherRunId &&
        !ticketEnrollment
      ) {
        throw new HubError(
          "Codex app-server registration requires a Hub-issued launch reservation",
          409,
          "SESSION_LAUNCH_FENCE_REQUIRED",
        );
      }
      let lineage = identity ? lineageRow(ctx, input.projectId, input) : undefined;
      if (ticketControl) {
        const ticketMatchesLineage =
          ticketControl.activation_mode === "FIRST_LINEAGE"
            ? ticketControl.expected_lineage_id === null &&
              ticketControl.expected_head_session_id === null &&
              ticketControl.launch_reservation_id === null &&
              (input.expectedHeadSessionId ?? null) === null &&
              !input.launcherRunId
            : ticketControl.activation_mode === "CURRENT_HEAD_REPLACEMENT"
              ? lineage?.id === ticketControl.expected_lineage_id &&
                lineage.head_session_id === ticketControl.expected_head_session_id &&
                input.expectedHeadSessionId === ticketControl.expected_head_session_id &&
                ticketControl.launch_reservation_id === null &&
                !input.launcherRunId
              : lineage?.id === ticketControl.expected_lineage_id &&
                lineage.head_session_id === ticketControl.expected_head_session_id &&
                input.expectedHeadSessionId === ticketControl.expected_head_session_id &&
                input.launcherRunId === ticketControl.run_id &&
                ticketControl.launch_reservation_id !== null;
        if (!ticketMatchesLineage) {
          throw new HubError(
            "Ticket registration lineage proof is stale or mismatched",
            409,
            "TICKET_REPLACEMENT_PROOF_REQUIRED",
          );
        }
      }
      let launchReservation:
        | (SessionLaunchReservationRow & {
            agent_id: string;
            client: string;
            delivery_mode: string;
            identity_kind: LogicalIdentity["kind"];
            identity_value: string;
          })
        | undefined;
      if (input.launcherRunId) {
        if (!identity || !lineage) {
          throw new HubError(
            "Launcher reservation does not match a logical session lineage",
            409,
            "SESSION_LAUNCH_FENCE_STALE",
          );
        }
        launchReservation = launchReservationRowByRun(ctx, input.launcherRunId);
        const reservationMatches =
          launchReservation?.project_id === input.projectId &&
          launchReservation.lineage_id === lineage.id &&
          launchReservation.agent_id === input.agentId &&
          launchReservation.client === input.client &&
          launchReservation.delivery_mode === input.deliveryMode &&
          launchReservation.identity_kind === identity.kind &&
          launchReservation.identity_value === identity.value &&
          launchReservation.state === "ISSUED" &&
          lineage.active_reservation_id === launchReservation.id &&
          lineage.reserved_generation === launchReservation.generation &&
          lineage.head_session_id === launchReservation.expected_head_session_id &&
          input.launchGeneration === launchReservation.generation &&
          input.expectedHeadSessionId === launchReservation.expected_head_session_id &&
          (!ticketControl || ticketControl.launch_reservation_id === launchReservation.id);
        if (!reservationMatches) {
          throw new HubError(
            "Managed session launch reservation is stale or does not match this registration",
            409,
            "SESSION_LAUNCH_FENCE_STALE",
          );
        }
      } else if (lineage?.launch_fence_required) {
        // Ticketed enrollments used to be exempt here, which promised something the durable fence
        // does not allow: 0006 keeps head_run_generation monotonic, so once a lineage has consumed
        // one reservation its head can never advance to a session that carries no generation. The
        // exemption let such a registration through to the trigger, which aborted it as an
        // unmapped 500 that read as a transient Hub fault. Refusing it here states the real
        // requirement in a code the caller can act on, and the channel answers it by taking a
        // reservation. Holding a valid CONTROL ticket proves who you are, not that you may skip
        // the launch fence.
        throw new HubError(
          "Logical session lineage requires a Hub-issued launch reservation",
          409,
          "SESSION_LAUNCH_FENCE_REQUIRED",
        );
      } else if (
        lineage &&
        input.expectedHeadSessionId !== undefined &&
        input.expectedHeadSessionId !== lineage.head_session_id
      ) {
        throw new HubError(
          "Logical session head changed before registration committed",
          409,
          "SESSION_INCARNATION_CONFLICT",
          {
            currentHeadSessionId: lineage.head_session_id,
            expectedHeadSessionId: input.expectedHeadSessionId,
          },
        );
      }
      if (!lineage && identity && input.expectedHeadSessionId) {
        throw new HubError(
          "Logical session lineage does not have the expected head",
          409,
          "SESSION_INCARNATION_CONFLICT",
          {
            currentHeadSessionId: null,
            expectedHeadSessionId: input.expectedHeadSessionId,
          },
        );
      }
      if (!lineage && identity) {
        lineage = createLineage(ctx, input.projectId, input, identity, now, false);
      }
      const predecessor =
        lineage?.head_session_id === null || lineage?.head_session_id === undefined
          ? undefined
          : (ctx.sqlite
              .prepare("SELECT * FROM agent_sessions WHERE id = ?")
              .get(lineage.head_session_id) as SessionRow | undefined);
      if (lineage?.head_session_id && !predecessor) {
        throw new HubError(
          "Logical session lineage points to a missing head",
          409,
          "SESSION_LINEAGE_CORRUPT",
        );
      }
      const incarnation = lineage ? lineage.head_incarnation + 1 : null;
      ctx.sqlite
        .prepare(
          `INSERT INTO agents(id, project_id, display_name, capabilities_json, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(id, project_id) DO UPDATE SET
               capabilities_json = excluded.capabilities_json,
               updated_at = excluded.updated_at`,
        )
        .run(
          input.agentId,
          input.projectId,
          input.agentId,
          JSON.stringify(input.capabilities),
          now,
          now,
        );
      ctx.sqlite
        .prepare(
          `INSERT INTO agent_sessions(
              id, project_id, agent_id, role, client, transport, delivery_mode,
              external_session_id, external_thread_id, external_turn_id, host, pid,
              cwd, git_branch, git_head, capabilities_json, connected_at,
              transport_last_seen_at, activity_last_seen_at, active_files_json,
              work_state, connection_state, heartbeat_sequence, queue_depth,
              lineage_id, incarnation, predecessor_session_id, launcher_run_id,
              launch_generation, version
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]',
              'IDLE', 'ONLINE', 0, 0, ?, ?, ?, ?, ?, 0)`,
        )
        .run(
          id,
          input.projectId,
          input.agentId,
          input.role,
          input.client,
          input.transport,
          input.deliveryMode,
          input.externalSessionId ?? null,
          input.externalThreadId ?? null,
          input.externalTurnId ?? null,
          input.host ?? hostname(),
          input.pid ?? null,
          canonicalPath(input.cwd),
          input.gitBranch ?? null,
          input.gitHead ?? null,
          JSON.stringify(input.capabilities),
          now,
          now,
          now,
          lineage?.id ?? null,
          incarnation,
          predecessor?.id ?? null,
          ticketControl?.run_id ?? launchReservation?.run_id ?? null,
          launchReservation?.generation ?? null,
        );
      let reboundRecipientCount = 0;
      if (predecessor) {
        const predecessorIncarnation = Number(predecessor.incarnation ?? 0);
        const unresolvedSurfaces = ctx.sqlite
          .prepare(
            `SELECT surface.id, surface.message_id, surface.recipient_id, surface.session_id,
                    surface.session_incarnation, surface.recipient_fence, surface.state,
                    recipient.surface_fence, message.thread_id
               FROM message_recipients AS recipient
               JOIN messages AS message ON message.id = recipient.message_id
               JOIN message_surface_attempts AS surface ON surface.recipient_id = recipient.id
              WHERE recipient.recipient_session_id = ?
                AND recipient.recipient_agent_id = ?
                AND recipient.state IN ('PENDING', 'DELIVERED', 'ACKNOWLEDGED', 'FAILED')
                AND message.project_id = ?
                AND surface.state IN ('ACTIVE', 'AMBIGUOUS')
              ORDER BY surface.recipient_id, surface.created_at`,
          )
          .all(predecessor.id, input.agentId, input.projectId) as Array<{
          id: string;
          message_id: string;
          recipient_id: string;
          session_id: string;
          session_incarnation: number;
          recipient_fence: number;
          state: "ACTIVE" | "AMBIGUOUS";
          surface_fence: number;
          thread_id: string;
        }>;
        const lineageSessions = ctx.sqlite
          .prepare(
            `SELECT id, incarnation, predecessor_session_id
               FROM agent_sessions
              WHERE project_id = ? AND agent_id = ? AND lineage_id = ?
                AND incarnation <= ?`,
          )
          .all(
            input.projectId,
            input.agentId,
            predecessor.lineage_id,
            predecessorIncarnation,
          ) as Array<{
          id: string;
          incarnation: number | null;
          predecessor_session_id: string | null;
        }>;
        const lineageById = new Map(lineageSessions.map((session) => [session.id, session]));
        const predecessorChain = new Set<string>();
        let chainCursor = lineageById.get(predecessor.id);
        for (let depth = 0; chainCursor && depth <= lineageSessions.length; depth += 1) {
          predecessorChain.add(chainCursor.id);
          if (chainCursor.predecessor_session_id === null) {
            chainCursor = undefined;
            break;
          }
          const parent = lineageById.get(chainCursor.predecessor_session_id);
          if (
            !parent ||
            parent.incarnation === null ||
            chainCursor.incarnation === null ||
            parent.incarnation !== chainCursor.incarnation - 1
          ) {
            throw new HubError(
              "Predecessor session lineage is not a contiguous recovery chain",
              409,
              "SESSION_SURFACE_HANDOFF_INVALID",
            );
          }
          chainCursor = parent;
        }
        if (chainCursor) {
          throw new HubError(
            "Predecessor session lineage contains a recovery cycle",
            409,
            "SESSION_SURFACE_HANDOFF_INVALID",
          );
        }
        const unresolvedRecipients = new Set<string>();
        for (const surface of unresolvedSurfaces) {
          const sourceSession = lineageById.get(surface.session_id);
          if (
            unresolvedRecipients.has(surface.recipient_id) ||
            !sourceSession ||
            !predecessorChain.has(surface.session_id) ||
            sourceSession.incarnation !== surface.session_incarnation ||
            surface.recipient_fence !== surface.surface_fence
          ) {
            throw new HubError(
              "Predecessor message surface cannot be handed to the successor safely",
              409,
              "SESSION_SURFACE_HANDOFF_INVALID",
            );
          }
          unresolvedRecipients.add(surface.recipient_id);
          if (surface.state === "ACTIVE") {
            const error = "session replaced before surface outcome was confirmed";
            const marked = ctx.sqlite
              .prepare(
                `UPDATE message_surface_attempts
                    SET state = 'AMBIGUOUS', error = ?, updated_at = ?
                  WHERE id = ? AND recipient_id = ? AND session_id = ?
                    AND session_incarnation = ? AND recipient_fence = ? AND state = 'ACTIVE'`,
              )
              .run(
                error,
                now,
                surface.id,
                surface.recipient_id,
                surface.session_id,
                surface.session_incarnation,
                surface.recipient_fence,
              );
            if (marked.changes !== 1) {
              throw new HubError(
                "Predecessor message surface changed during successor registration",
                409,
                "SESSION_SURFACE_HANDOFF_INVALID",
              );
            }
            emit({
              projectId: input.projectId,
              type: "message.surface.ambiguous",
              actorType: "system",
              actorId: "session-replacement",
              aggregateType: "message",
              aggregateId: surface.message_id,
              causationId: surface.id,
              correlationId: surface.thread_id,
              payload: {
                recipientId: surface.recipient_id,
                sessionId: surface.session_id,
                recipientFence: surface.recipient_fence,
                error,
                reboundToSessionId: id,
              },
            });
          }
          emit({
            projectId: input.projectId,
            type: "message.surface.ambiguous_handoff",
            actorType: "system",
            actorId: "session-replacement",
            aggregateType: "message",
            aggregateId: surface.message_id,
            causationId: surface.id,
            correlationId: surface.thread_id,
            payload: {
              recipientId: surface.recipient_id,
              sessionId: surface.session_id,
              sessionIncarnation: surface.session_incarnation,
              recipientFence: surface.recipient_fence,
              previousRecipientSessionId: predecessor.id,
              reboundToSessionId: id,
              lineageId: predecessor.lineage_id,
            },
          });
        }
        const confirmedSurfaces = ctx.sqlite
          .prepare(
            `SELECT surface.id, surface.message_id, surface.recipient_id, surface.session_id,
                    surface.session_incarnation, surface.recipient_fence, surface.state,
                    surface.error, surface.confirmed_at, recipient.surface_fence,
                    recipient.state AS recipient_state, message.thread_id,
                    owner.project_id AS owner_project_id, owner.agent_id AS owner_agent_id,
                    owner.lineage_id AS owner_lineage_id, owner.incarnation AS owner_incarnation
               FROM message_recipients AS recipient
               JOIN messages AS message ON message.id = recipient.message_id
               JOIN message_surface_attempts AS surface ON surface.recipient_id = recipient.id
               JOIN agent_sessions AS owner ON owner.id = surface.session_id
              WHERE recipient.recipient_session_id = ?
                AND recipient.recipient_agent_id = ?
                AND recipient.state IN ('PENDING', 'DELIVERED', 'ACKNOWLEDGED', 'FAILED')
                AND message.project_id = ?
                AND surface.state = 'CONFIRMED'
              ORDER BY surface.recipient_id, surface.created_at`,
          )
          .all(predecessor.id, input.agentId, input.projectId) as Array<{
          id: string;
          message_id: string;
          recipient_id: string;
          session_id: string;
          session_incarnation: number;
          recipient_fence: number;
          state: "CONFIRMED";
          error: string | null;
          confirmed_at: string | null;
          surface_fence: number;
          recipient_state: string;
          thread_id: string;
          owner_project_id: string;
          owner_agent_id: string;
          owner_lineage_id: string | null;
          owner_incarnation: number;
        }>;
        const confirmedRecipients = new Set<string>();
        for (const surface of confirmedSurfaces) {
          const exactOwner =
            surface.owner_project_id === input.projectId &&
            surface.owner_agent_id === input.agentId &&
            surface.owner_lineage_id === predecessor.lineage_id &&
            surface.session_incarnation === surface.owner_incarnation &&
            surface.owner_incarnation < Number(incarnation);
          const exactRecipient =
            ["DELIVERED", "ACKNOWLEDGED"].includes(surface.recipient_state) &&
            surface.recipient_fence === surface.surface_fence;
          if (
            unresolvedRecipients.has(surface.recipient_id) ||
            confirmedRecipients.has(surface.recipient_id) ||
            !exactOwner ||
            !exactRecipient ||
            surface.error !== null ||
            surface.confirmed_at === null
          ) {
            throw new HubError(
              "Confirmed predecessor surface cannot be handed to the successor safely",
              409,
              "SESSION_SURFACE_HANDOFF_INVALID",
            );
          }
          const durableDelivery = ctx.sqlite
            .prepare(
              `SELECT 1 FROM message_deliveries
                WHERE recipient_id = ? AND session_id = ? AND state = 'DELIVERED'
                  AND completed_at IS NOT NULL
                LIMIT 1`,
            )
            .get(surface.recipient_id, surface.session_id);
          const genericEvent = ctx.sqlite
            .prepare(
              `SELECT 1 FROM events
                WHERE project_id = ?
                  AND type IN (
                    'message.delivered', 'message.acknowledged',
                    'message.processed', 'message.responded'
                  )
                  AND actor_type = 'agent' AND actor_id = ?
                  AND aggregate_type = 'message' AND aggregate_id = ?
                  AND json_extract(payload_json, '$.recipientId') = ?
                  AND json_extract(payload_json, '$.sessionId') = ?
                  AND json_extract(payload_json, '$.surfaceAttemptId') = ?
                  AND json_extract(payload_json, '$.recipientFence') = ?
                LIMIT 1`,
            )
            .get(
              input.projectId,
              input.agentId,
              surface.message_id,
              surface.recipient_id,
              surface.session_id,
              surface.id,
              surface.recipient_fence,
            );
          const directive = ctx.sqlite
            .prepare("SELECT directive_id FROM message_directive_links WHERE message_id = ?")
            .get(surface.message_id) as { directive_id: string } | undefined;
          const authorityDelivery = directive
            ? ctx.sqlite
                .prepare(
                  `SELECT 1 FROM authority_events
                    WHERE directive_id = ? AND event_type = 'DELIVERED'
                      AND target_agent_id = ? AND actor_session_id = ?
                      AND json_extract(payload_json, '$.carrierMessageId') = ?
                      AND json_extract(payload_json, '$.targetAgentId') = ?
                      AND json_extract(payload_json, '$.sessionId') = ?
                      AND json_extract(payload_json, '$.surfaceAttemptId') = ?
                      AND json_extract(payload_json, '$.recipientFence') = ?
                    LIMIT 1`,
                )
                .get(
                  directive.directive_id,
                  input.agentId,
                  surface.session_id,
                  surface.message_id,
                  input.agentId,
                  surface.session_id,
                  surface.id,
                  surface.recipient_fence,
                )
            : true;
          const priorConfirmedHandoff =
            surface.session_id === predecessor.id
              ? true
              : ctx.sqlite
                  .prepare(
                    `SELECT 1
                       FROM message_surface_handoffs AS handoff
                       JOIN events AS event
                         ON event.id = handoff.event_id
                        AND event.project_id = handoff.project_id
                        AND event.sequence = handoff.server_sequence
                      WHERE handoff.project_id = ?
                        AND handoff.message_id = ?
                        AND handoff.recipient_id = ?
                        AND handoff.surface_attempt_id = ?
                        AND handoff.lineage_id = ?
                        AND handoff.source_surface_session_id = ?
                        AND handoff.source_surface_incarnation = ?
                        AND handoff.successor_session_id = ?
                        AND handoff.successor_incarnation = ?
                        AND handoff.predecessor_incarnation = handoff.successor_incarnation - 1
                        AND handoff.recipient_fence = ?
                        AND event.type = 'message.surface.confirmed_handoff'
                        AND event.actor_type = 'system'
                        AND event.actor_id = 'session-replacement'
                        AND event.aggregate_type = 'message'
                        AND event.aggregate_id = handoff.message_id
                        AND event.causation_id = handoff.surface_attempt_id
                        AND event.correlation_id = ?
                        AND json_extract(event.payload_json, '$.recipientId') = handoff.recipient_id
                        AND json_extract(event.payload_json, '$.sessionId') = handoff.source_surface_session_id
                        AND json_extract(event.payload_json, '$.sessionIncarnation') = handoff.source_surface_incarnation
                        AND json_extract(event.payload_json, '$.recipientFence') = handoff.recipient_fence
                        AND json_extract(event.payload_json, '$.previousRecipientSessionId') = handoff.predecessor_session_id
                        AND json_extract(event.payload_json, '$.reboundToSessionId') = handoff.successor_session_id
                        AND json_extract(event.payload_json, '$.lineageId') = handoff.lineage_id
                      LIMIT 1`,
                  )
                  .get(
                    input.projectId,
                    surface.message_id,
                    surface.recipient_id,
                    surface.id,
                    predecessor.lineage_id,
                    surface.session_id,
                    surface.session_incarnation,
                    predecessor.id,
                    predecessorIncarnation,
                    surface.recipient_fence,
                    surface.thread_id,
                  );
          const reconciledAmbiguousHandoff =
            surface.session_id === predecessor.id
              ? true
              : ctx.sqlite
                  .prepare(
                    `SELECT 1
                       FROM events AS handoff
                       JOIN events AS reconciled
                         ON reconciled.project_id = handoff.project_id
                        AND reconciled.aggregate_id = handoff.aggregate_id
                        AND reconciled.causation_id = handoff.causation_id
                        AND reconciled.sequence > handoff.sequence
                      WHERE handoff.project_id = ?
                        AND handoff.type = 'message.surface.ambiguous_handoff'
                        AND handoff.actor_type = 'system'
                        AND handoff.actor_id = 'session-replacement'
                        AND handoff.aggregate_type = 'message'
                        AND handoff.aggregate_id = ?
                        AND handoff.causation_id = ?
                        AND handoff.correlation_id = ?
                        AND json_extract(handoff.payload_json, '$.recipientId') = ?
                        AND json_extract(handoff.payload_json, '$.sessionId') = ?
                        AND json_extract(handoff.payload_json, '$.sessionIncarnation') = ?
                        AND json_extract(handoff.payload_json, '$.recipientFence') = ?
                        AND json_extract(handoff.payload_json, '$.reboundToSessionId') = ?
                        AND json_extract(handoff.payload_json, '$.lineageId') = ?
                        AND reconciled.type = 'message.surface.reconciled'
                        AND reconciled.actor_type = 'agent'
                        AND reconciled.actor_id = ?
                        AND reconciled.aggregate_type = 'message'
                        AND reconciled.correlation_id = ?
                        AND json_extract(reconciled.payload_json, '$.recipientId') = ?
                        AND json_extract(reconciled.payload_json, '$.sessionId') = ?
                        AND json_extract(reconciled.payload_json, '$.surfaceAttemptId') = ?
                        AND json_extract(reconciled.payload_json, '$.recipientFence') = ?
                        AND json_extract(reconciled.payload_json, '$.reconciledBySessionId') = ?
                        AND json_extract(reconciled.payload_json, '$.externalThreadId') = ?
                      LIMIT 1`,
                  )
                  .get(
                    input.projectId,
                    surface.message_id,
                    surface.id,
                    surface.thread_id,
                    surface.recipient_id,
                    surface.session_id,
                    surface.session_incarnation,
                    surface.recipient_fence,
                    predecessor.id,
                    predecessor.lineage_id,
                    input.agentId,
                    surface.thread_id,
                    surface.recipient_id,
                    surface.session_id,
                    surface.id,
                    surface.recipient_fence,
                    predecessor.id,
                    input.externalThreadId,
                  );
          const priorReconciledHandoff =
            surface.session_id === predecessor.id
              ? true
              : ctx.sqlite
                  .prepare(
                    `SELECT 1
                       FROM events AS event
                      WHERE event.project_id = ?
                        AND event.type = 'message.surface.reconciled_handoff'
                        AND event.actor_type = 'system'
                        AND event.actor_id = 'session-replacement'
                        AND event.aggregate_type = 'message'
                        AND event.aggregate_id = ?
                        AND event.causation_id = ?
                        AND event.correlation_id = ?
                        AND json_extract(event.payload_json, '$.recipientId') = ?
                        AND json_extract(event.payload_json, '$.sessionId') = ?
                        AND json_extract(event.payload_json, '$.sessionIncarnation') = ?
                        AND json_extract(event.payload_json, '$.recipientFence') = ?
                        AND json_extract(event.payload_json, '$.reboundToSessionId') = ?
                        AND json_extract(event.payload_json, '$.lineageId') = ?
                      LIMIT 1`,
                  )
                  .get(
                    input.projectId,
                    surface.message_id,
                    surface.id,
                    surface.thread_id,
                    surface.recipient_id,
                    surface.session_id,
                    surface.session_incarnation,
                    surface.recipient_fence,
                    predecessor.id,
                    predecessor.lineage_id,
                  );
          const usesReconciledOrdinaryChain =
            !priorConfirmedHandoff && Boolean(reconciledAmbiguousHandoff || priorReconciledHandoff);
          if (
            !durableDelivery ||
            !genericEvent ||
            !authorityDelivery ||
            (!priorConfirmedHandoff && !usesReconciledOrdinaryChain)
          ) {
            throw new HubError(
              "Confirmed predecessor surface is missing exact durable provenance",
              409,
              "SESSION_SURFACE_HANDOFF_INVALID",
            );
          }
          confirmedRecipients.add(surface.recipient_id);
          const handoffEvent = emit({
            projectId: input.projectId,
            type: usesReconciledOrdinaryChain
              ? "message.surface.reconciled_handoff"
              : "message.surface.confirmed_handoff",
            actorType: "system",
            actorId: "session-replacement",
            aggregateType: "message",
            aggregateId: surface.message_id,
            causationId: surface.id,
            correlationId: surface.thread_id,
            payload: {
              recipientId: surface.recipient_id,
              sessionId: surface.session_id,
              sessionIncarnation: surface.session_incarnation,
              recipientFence: surface.recipient_fence,
              previousRecipientSessionId: predecessor.id,
              reboundToSessionId: id,
              lineageId: predecessor.lineage_id,
            },
          });
          if (!usesReconciledOrdinaryChain) {
            ctx.sqlite
              .prepare(
                `INSERT INTO message_surface_handoffs(
                   id, project_id, message_id, recipient_id, surface_attempt_id, lineage_id,
                   source_surface_session_id, predecessor_session_id, successor_session_id,
                   source_surface_incarnation, predecessor_incarnation, successor_incarnation,
                   recipient_fence, server_sequence, event_id, created_at
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              )
              .run(
                createId("msh"),
                input.projectId,
                surface.message_id,
                surface.recipient_id,
                surface.id,
                predecessor.lineage_id,
                surface.session_id,
                predecessor.id,
                id,
                surface.session_incarnation,
                predecessorIncarnation,
                Number(incarnation),
                surface.recipient_fence,
                handoffEvent.sequence,
                handoffEvent.id,
                handoffEvent.createdAt,
              );
          }
        }
        const expectedRecipientCount = Number(
          ctx.sqlite
            .prepare(
              `SELECT COUNT(*)
                 FROM message_recipients AS recipient
                 JOIN messages AS message ON message.id = recipient.message_id
                WHERE recipient.recipient_session_id = ?
                  AND recipient.recipient_agent_id = ?
                  AND recipient.state IN ('PENDING', 'DELIVERED', 'ACKNOWLEDGED', 'FAILED')
                  AND message.project_id = ?`,
            )
            .pluck()
            .get(predecessor.id, input.agentId, input.projectId),
        );
        reboundRecipientCount = ctx.sqlite
          .prepare(
            `UPDATE message_recipients
                SET recipient_session_id = ?
              WHERE recipient_session_id = ?
                AND recipient_agent_id = ?
                AND state IN ('PENDING', 'DELIVERED', 'ACKNOWLEDGED', 'FAILED')
                AND message_id IN (SELECT id FROM messages WHERE project_id = ?)`,
          )
          .run(id, predecessor.id, input.agentId, input.projectId).changes;
        if (reboundRecipientCount !== expectedRecipientCount) {
          throw new HubError(
            "Predecessor message recipients changed during successor registration",
            409,
            "SESSION_SURFACE_HANDOFF_INVALID",
          );
        }
      }
      if (lineage) {
        const advanced = launchReservation
          ? ctx.sqlite
              .prepare(
                `UPDATE session_lineages
                  SET head_session_id = ?, head_incarnation = ?, head_run_id = ?,
                      head_run_generation = ?, version = version + 1, updated_at = ?
                WHERE id = ? AND head_session_id IS ? AND version = ?
                  AND active_reservation_id = ? AND reserved_generation = ?`,
              )
              .run(
                id,
                incarnation,
                launchReservation.run_id,
                launchReservation.generation,
                now,
                lineage.id,
                launchReservation.expected_head_session_id,
                lineage.version,
                launchReservation.id,
                launchReservation.generation,
              )
          : ctx.sqlite
              .prepare(
                `UPDATE session_lineages
                  SET head_session_id = ?, head_incarnation = ?, version = version + 1,
                      updated_at = ?
                WHERE id = ? AND head_session_id IS ? AND version = ?`,
              )
              .run(id, incarnation, now, lineage.id, lineage.head_session_id, lineage.version);
        if (advanced.changes !== 1) {
          throw new HubError(
            "Logical session head changed before registration committed",
            409,
            "SESSION_INCARNATION_CONFLICT",
          );
        }
        if (launchReservation) {
          const cleared = ctx.sqlite
            .prepare(
              `UPDATE session_lineages
                  SET active_reservation_id = NULL, version = version + 1, updated_at = ?
                WHERE id = ? AND active_reservation_id = ?`,
            )
            .run(now, lineage.id, launchReservation.id);
          if (cleared.changes !== 1) {
            throw new HubError(
              "Managed session launch reservation changed before registration committed",
              409,
              "SESSION_LAUNCH_FENCE_STALE",
            );
          }
          const consumed = ctx.sqlite
            .prepare(
              `UPDATE session_launch_reservations
                SET state = 'CONSUMED', consumed_session_id = ?, updated_at = ?
              WHERE id = ? AND state = 'ISSUED'`,
            )
            .run(id, now, launchReservation.id);
          if (consumed.changes !== 1) {
            throw new HubError(
              "Managed session launch reservation changed before registration committed",
              409,
              "SESSION_LAUNCH_FENCE_STALE",
            );
          }
        }
      }
      let ticketBinding: SessionTicketBinding | undefined;
      if (ticketControl) {
        const predecessorControl = ticketControl.offered_by_ticket_id
          ? (ctx.sqlite
              .prepare(
                `SELECT * FROM adapter_session_tickets
                 WHERE id = ? AND purpose = 'CONTROL'`,
              )
              .get(ticketControl.offered_by_ticket_id) as SessionTicketRegistrationRow | undefined)
          : undefined;
        const expiredCurrentHeadProof =
          ticketControl.activation_mode === "CURRENT_HEAD_REPLACEMENT" &&
          predecessorControl !== undefined &&
          predecessorControl.hub_session_id !== null &&
          (predecessorControl.state === "EXPIRED" ||
            (predecessorControl.state === "ACTIVE" &&
              predecessorControl.expires_at !== null &&
              Date.parse(predecessorControl.expires_at) <= Date.parse(now)));
        if (expiredCurrentHeadProof && predecessorControl.state === "ACTIVE") {
          expireSessionTicketBundleForHubSession(ctx.sqlite, {
            hubSessionId: predecessorControl.hub_session_id!,
            reason: "ticket expired before current-head replacement",
            now,
          });
        }
        const proof =
          ticketControl.activation_mode === "FIRST_LINEAGE"
            ? ({ kind: "FIRST_LINEAGE", controlTicketId: ticketControl.id } as const)
            : ticketControl.activation_mode === "CURRENT_HEAD_REPLACEMENT"
              ? ({
                  kind: expiredCurrentHeadProof
                    ? "EXPIRED_CURRENT_HEAD_CONTROL"
                    : "CURRENT_HEAD_CONTROL",
                  controlTicketId: ticketControl.offered_by_ticket_id!,
                } as const)
              : ({
                  kind: "MANAGED_RESERVATION",
                  reservationId: ticketControl.launch_reservation_id!,
                } as const);
        ticketBinding = activateSessionTicketBundle(ctx.sqlite, {
          bundleId: ticketControl.bundle_id,
          hubSessionId: id,
          lineageId: lineage!.id,
          incarnation: incarnation!,
          proof,
          now,
        });
      }
      const captureTicketId = ticketBinding?.purposes.find(
        (purpose) => purpose.purpose === "CAPTURE",
      )?.id;
      bindCaptureSession(
        ctx,
        {
          sessionId: id,
          projectId: input.projectId,
          client: input.client,
          externalSessionId: input.externalSessionId,
          sessionTicketId: captureTicketId,
        },
        now,
      );
      const superseded = predecessor?.connection_state !== "CLOSED" ? predecessor : undefined;
      if (predecessor) {
        ctx.sqlite
          .prepare(
            `UPDATE agent_sessions SET
              connection_state = 'CLOSED', closed_at = ?, superseded_by_session_id = ?,
              current_task_id = NULL, current_review_id = NULL, work_state = 'IDLE',
              version = version + 1
            WHERE id = ?`,
          )
          .run(now, id, predecessor.id);
        ctx.sqlite
          .prepare(
            `UPDATE capture_session_bindings
             SET revoked_at = ?
             WHERE hub_session_id = ? AND revoked_at IS NULL`,
          )
          .run(now, predecessor.id);
        if (hasActiveTicketBinding(ctx, predecessor.id)) {
          closeSessionTicketsForHubSession(ctx.sqlite, {
            hubSessionId: predecessor.id,
            reason: `superseded by ${id}`,
            state: "SUPERSEDED",
            now,
          });
        }
      }
      let reboundTaskCount = 0;
      let reboundIntentCount = 0;
      if (predecessor) {
        reboundTaskCount = ctx.sqlite
          .prepare(
            `UPDATE tasks
              SET owner_session_id = ?, owner_agent_id = ?,
                  claim_stale_at = NULL, version = version + 1, updated_at = ?
            WHERE owner_session_id = ?
              AND status NOT IN ('BACKLOG', 'READY', 'APPROVED', 'DONE', 'CANCELLED')`,
          )
          .run(id, input.agentId, now, predecessor.id).changes;
        reboundIntentCount = ctx.sqlite
          .prepare(
            `UPDATE write_intents
              SET session_id = ?, version = version + 1, updated_at = ?
            WHERE session_id = ?
              AND released_at IS NULL AND expires_at > ?`,
          )
          .run(id, now, predecessor.id, now).changes;

        const reboundTask = ctx.sqlite
          .prepare(
            `SELECT id FROM tasks
             WHERE owner_session_id = ?
               AND status NOT IN ('BACKLOG', 'READY', 'APPROVED', 'DONE', 'CANCELLED')
             ORDER BY updated_at DESC LIMIT 1`,
          )
          .get(id) as { id: string } | undefined;
        ctx.sqlite
          .prepare(
            `UPDATE agent_sessions
              SET current_task_id = ?, current_review_id = ?, work_state = ?,
                  version = version + 1
            WHERE id = ?`,
          )
          .run(
            reboundTask?.id ?? null,
            predecessor.current_review_id ?? null,
            reboundTask || predecessor.current_review_id
              ? (predecessor.work_state ?? "WORKING")
              : "IDLE",
            id,
          );
      }
      if (superseded) {
        emit({
          projectId: input.projectId,
          type: "session.superseded",
          actorType: "agent",
          actorId: input.agentId,
          aggregateType: "session",
          aggregateId: superseded.id,
          causationId: id,
          correlationId: input.externalThreadId ?? input.externalSessionId ?? null,
          payload: {
            supersededBySessionId: id,
            agentId: input.agentId,
            client: input.client,
            deliveryMode: input.deliveryMode,
            externalThreadId: input.externalThreadId ?? null,
            externalSessionId: input.externalSessionId ?? null,
            reboundRecipientCount,
            reboundTaskCount,
            reboundIntentCount,
          },
        });
      }
      emit({
        projectId: input.projectId,
        type: "session.registered",
        actorType: "agent",
        actorId: input.agentId,
        aggregateType: "session",
        aggregateId: id,
        causationId: null,
        correlationId: null,
        payload: {
          client: input.client,
          role: input.role,
          deliveryMode: input.deliveryMode,
          reboundRecipientCount,
          reboundTaskCount,
          reboundIntentCount,
          lineageId: lineage?.id ?? null,
          incarnation,
          predecessorSessionId: predecessor?.id ?? null,
          launcherRunId: ticketControl?.run_id ?? launchReservation?.run_id ?? null,
          launchGeneration: launchReservation?.generation ?? null,
          ticketBundleId: ticketBinding?.bundleId ?? null,
        },
      });
      return sessionFromRow(
        ctx.sqlite.prepare("SELECT * FROM agent_sessions WHERE id = ?").get(id),
      );
    },
    ticketEnrollment
      ? {
          requestFingerprint: mutationFingerprint({
            principalId: principal?.id,
            credentialId: principal?.credentialId,
            ticketEnrollment,
            input,
          }),
        }
      : undefined,
  );
  const current = ctx.sqlite
    .prepare("SELECT * FROM agent_sessions WHERE id = ?")
    .get(registered.id) as SessionRow | undefined;
  if (!current) {
    throw new HubError("Registered session disappeared", 409, "SESSION_REGISTRATION_STALE");
  }
  const currentReservation = input.launcherRunId
    ? launchReservationRowByRun(ctx, input.launcherRunId)
    : undefined;
  const requestMatches =
    current.project_id === input.projectId &&
    current.agent_id === input.agentId &&
    current.role === input.role &&
    current.client === input.client &&
    current.transport === input.transport &&
    current.delivery_mode === input.deliveryMode &&
    current.external_session_id === (input.externalSessionId ?? null) &&
    current.external_thread_id === (input.externalThreadId ?? null) &&
    current.launcher_run_id ===
      (ticketEnrollment
        ? ((
            ctx.sqlite
              .prepare("SELECT run_id FROM adapter_session_tickets WHERE id = ? AND bundle_id = ?")
              .get(ticketEnrollment.controlTicketId, ticketEnrollment.bundleId) as
              { run_id: string } | undefined
          )?.run_id ?? null)
        : (input.launcherRunId ?? null)) &&
    current.launch_generation === (input.launchGeneration ?? null) &&
    (!input.launcherRunId ||
      (currentReservation?.consumed_session_id === current.id &&
        currentReservation.generation === input.launchGeneration &&
        currentReservation.expected_head_session_id === input.expectedHeadSessionId));
  if (!requestMatches) {
    throw new HubError(
      "Idempotency key was already used for another session registration request",
      409,
      "SESSION_REGISTRATION_REQUEST_CONFLICT",
    );
  }
  if (current.connection_state === "CLOSED" && current.superseded_by_session_id) {
    throw new HubError("Registered session has been superseded", 409, "SESSION_SUPERSEDED", {
      supersededBySessionId: current.superseded_by_session_id,
    });
  }
  return sessionFromRow(current);
}

export function registerAdapterSession(
  ctx: StoreContext,
  input: RegisterAdapterSessionInput,
  principal: RequestPrincipal,
): RegisterAdapterSessionReceipt {
  const normalized = {
    ...input,
    role: input.role ?? "primary",
    capabilities: input.capabilities ?? [],
  };
  const session = registerSession(ctx, normalized, principal, {
    bundleId: input.ticket_bundle_id,
    controlTicketId: principal.credentialId,
  });
  const ticketBinding = getActiveSessionTicketBinding(ctx.sqlite, {
    bundleId: input.ticket_bundle_id,
  });
  if (ticketBinding.hubSessionId !== session.id) {
    throw new HubError(
      "Ticket binding does not match the registered session",
      409,
      "TICKET_ACTIVATION_CONFLICT",
    );
  }
  return { session, ticketBinding };
}

/**
 * Rotates only long-lived model transports in place. Hook capture provenance is intentionally
 * immutable for one host turn/session binding, so Hook clients renew through same-identity session
 * replacement instead of rewriting a capture binding underneath already-attested user turns.
 */
export function rotateAdapterSessionTickets(
  ctx: StoreContext,
  sessionId: string,
  successorBundleId: string,
  input: RotateAdapterSessionTicketsInput,
  principal: RequestPrincipal,
): RotateAdapterSessionTicketsReceipt {
  if (
    principal.kind !== "AGENT" ||
    principal.credentialClass !== "SESSION_TICKET" ||
    principal.ticketPurpose !== "CONTROL" ||
    principal.hubSessionId !== sessionId
  ) {
    throw new HubError(
      "A session-bound CONTROL ticket is required to rotate this Adapter session",
      403,
      "TICKET_ROTATION_NOT_AUTHORIZED",
    );
  }
  const predecessor = ctx.sqlite
    .prepare(
      `SELECT bundle_id FROM adapter_session_tickets
       WHERE id = ? AND purpose = 'CONTROL' AND hub_session_id = ?`,
    )
    .get(principal.credentialId, sessionId) as { bundle_id: string } | undefined;
  if (!predecessor || predecessor.bundle_id === successorBundleId) {
    throw new HubError(
      "Rotation requires a distinct predecessor and successor bundle",
      403,
      "TICKET_ROTATION_NOT_AUTHORIZED",
    );
  }
  const session = getSession(ctx, sessionId);
  const requestFingerprint = mutationFingerprint({
    credentialId: principal.credentialId,
    predecessorBundleId: predecessor.bundle_id,
    successorBundleId,
    sessionId,
  });
  const outcome = ctx.mutate<
    RotateAdapterSessionTicketsReceipt | AbortedAdapterSessionTicketRotation
  >(
    session.projectId,
    input.idempotencyKey,
    "session.ticket.rotate",
    ({ emit }) => {
      if (principal.ticketState === "EXPIRED") {
        const proof = assertExpiredAuxiliaryRotationNotCommitted(ctx.sqlite, {
          predecessorControlTicketId: principal.credentialId,
          hubSessionId: sessionId,
          successorBundleId,
          now: nowIso(),
        });
        return {
          rotationState: "ABORTED",
          sessionId,
          predecessorBundleId: proof.predecessorBundleId,
          successorBundleId,
          abortedAt: nowIso(),
        };
      }
      if (principal.ticketState !== "ACTIVE") {
        throw new HubError(
          "A terminal ticket is valid only for an exact cached rotation replay",
          403,
          "TICKET_ROTATION_NOT_AUTHORIZED",
        );
      }
      const open = getOpenSession(ctx, sessionId);
      assertCanControlAdapterSession(ctx.sqlite, principal, open);
      if (open.client !== "codex-app-server" && open.client !== "claude-channel") {
        throw new HubError(
          "Hook sessions renew through same-identity session replacement",
          422,
          "TICKET_ROTATION_UNSUPPORTED",
        );
      }
      if (!open.lineageId || !open.incarnation) {
        throw new HubError(
          "The current session has no renewable lineage binding",
          409,
          "TICKET_REPLACEMENT_PROOF_REQUIRED",
        );
      }
      const successorControl = ctx.sqlite
        .prepare(
          `SELECT offered_by_ticket_id, activation_mode, expected_lineage_id,
                  expected_head_session_id, hub_session_id, state
           FROM adapter_session_tickets
           WHERE bundle_id = ? AND purpose = 'CONTROL'`,
        )
        .get(successorBundleId) as
        | {
            offered_by_ticket_id: string | null;
            activation_mode: string;
            expected_lineage_id: string | null;
            expected_head_session_id: string | null;
            hub_session_id: string | null;
            state: string;
          }
        | undefined;
      if (
        !successorControl ||
        successorControl.state !== "PENDING" ||
        successorControl.hub_session_id !== null ||
        successorControl.offered_by_ticket_id !== principal.credentialId ||
        successorControl.activation_mode !== "SESSION_AUXILIARY" ||
        successorControl.expected_lineage_id !== open.lineageId ||
        successorControl.expected_head_session_id !== sessionId
      ) {
        throw new HubError(
          "Successor bundle is not the exact auxiliary offer from this CONTROL ticket",
          409,
          "TICKET_REPLACEMENT_PROOF_REQUIRED",
        );
      }
      const now = nowIso();
      const rotated = rotateSessionTicketBundleForSession(ctx.sqlite, {
        bundleId: successorBundleId,
        hubSessionId: sessionId,
        lineageId: open.lineageId,
        incarnation: open.incarnation,
        proof: { kind: "SESSION_AUXILIARY", controlTicketId: principal.credentialId },
        reason: `superseded by ${successorBundleId}`,
        now,
      });
      emit({
        projectId: open.projectId,
        type: "session.ticket.rotated",
        actorType: "agent",
        actorId: open.agentId,
        aggregateType: "session",
        aggregateId: sessionId,
        causationId: rotated.binding.bundleId,
        correlationId: open.lineageId,
        payload: {
          successorBundleId: rotated.binding.bundleId,
          predecessorBundleId: rotated.superseded.bundleId,
          predecessorState: rotated.superseded.state,
        },
      });
      return {
        session: getSession(ctx, sessionId),
        ticketBinding: rotated.binding,
        supersededTicketBinding: rotated.superseded,
      };
    },
    {
      requestFingerprint,
      validateReplay: (cached) => {
        if (isAbortedAdapterSessionTicketRotation(cached)) {
          if (
            cached.sessionId !== sessionId ||
            cached.predecessorBundleId !== predecessor.bundle_id ||
            cached.successorBundleId !== successorBundleId
          ) {
            throw new HubError(
              "Cached rotation abort does not match this CONTROL ticket",
              409,
              "TICKET_IDEMPOTENCY_CONFLICT",
            );
          }
          return;
        }
        const result = cached as Partial<RotateAdapterSessionTicketsReceipt>;
        if (
          result.session?.id !== sessionId ||
          result.ticketBinding?.bundleId !== successorBundleId ||
          result.supersededTicketBinding?.bundleId !== predecessor.bundle_id ||
          result.supersededTicketBinding?.state !== "SUPERSEDED" ||
          !result.supersededTicketBinding?.purposes.some(
            (purpose) => purpose.id === principal.credentialId && purpose.purpose === "CONTROL",
          )
        ) {
          throw new HubError(
            "Cached rotation receipt does not match the predecessor CONTROL ticket",
            409,
            "TICKET_IDEMPOTENCY_CONFLICT",
          );
        }
      },
    },
  );
  if (isAbortedAdapterSessionTicketRotation(outcome)) {
    throw new HubError(
      "The exact auxiliary rotation request was durably aborted before commit",
      409,
      "TICKET_ROTATION_NOT_COMMITTED",
      {
        state: outcome.rotationState,
        sessionId: outcome.sessionId,
        predecessorBundleId: outcome.predecessorBundleId,
        successorBundleId: outcome.successorBundleId,
        abortedAt: outcome.abortedAt,
      },
    );
  }
  return outcome;
}

export function getSession(ctx: StoreContext, sessionId: string): AgentSession {
  const row = ctx.sqlite.prepare("SELECT * FROM agent_sessions WHERE id = ?").get(sessionId);
  if (!row) throw new NotFoundError("Session", sessionId);
  return sessionFromRow(row);
}

/**
 * A CLOSED session is immutable history. In particular, a superseded adapter may still have a
 * heartbeat timer or an app-server notification in flight; accepting either would silently revive
 * the losing logical session after registerSession transferred its ownership.
 */
export function getOpenSession(ctx: StoreContext, sessionId: string): AgentSession {
  const session = getSession(ctx, sessionId);
  if (session.connectionState === "CLOSED") {
    throw new HubError(`Session is closed: ${sessionId}`, 409, "SESSION_CLOSED");
  }
  return session;
}

export function assertSessionControl(
  ctx: StoreContext,
  principal: RequestPrincipal,
  sessionId: string,
): AgentSession {
  const session = getSession(ctx, sessionId);
  assertCanControlAdapterSession(ctx.sqlite, principal, session);
  return session;
}

export function listSessions(ctx: StoreContext, projectId: string): AgentSession[] {
  refreshDerivedPresence(ctx, projectId);
  // A CLOSED session is a historical row, not a participant. Returning them made the Agents
  // view grow by one card per adapter restart — 19 rows for two live agents — and made every
  // caller that reasons about peers (context packs, review routing) consider dead sessions.
  return ctx.sqlite
    .prepare(
      `SELECT * FROM agent_sessions
           WHERE project_id = ? AND connection_state != 'CLOSED'
              AND (
                connection_state != 'OFFLINE'
                OR id = (
                  SELECT prior.id FROM agent_sessions AS prior
                    WHERE prior.project_id = agent_sessions.project_id
                      AND prior.agent_id = agent_sessions.agent_id
                      AND prior.client = agent_sessions.client
                      AND prior.role = agent_sessions.role
                      AND prior.delivery_mode = agent_sessions.delivery_mode
                      AND prior.lineage_id IS agent_sessions.lineage_id
                      AND prior.connection_state != 'CLOSED'
                    ORDER BY prior.connected_at DESC, prior.id DESC LIMIT 1
                )
              )
           ORDER BY connected_at DESC`,
    )
    .all(projectId)
    .map(sessionFromRow);
}

export function heartbeat(
  ctx: StoreContext,
  input: {
    sessionId: string;
    sequence: number;
    workState: string;
    currentTaskId?: string | null;
    currentReviewId?: string | null;
    currentTurnId?: string | null;
    gitHead?: string | null;
    activeFiles: string[];
    queueDepth: number;
  },
  principal?: RequestPrincipal,
): AgentSession {
  if (principal) {
    assertCanControlAdapterTransport(ctx.sqlite, principal, getOpenSession(ctx, input.sessionId));
  }
  let event: DomainEvent | null = null;
  const applyHeartbeat = ctx.sqlite.transaction(() => {
    const current = getOpenSession(ctx, input.sessionId);
    const currentSequence = Number(
      (
        ctx.sqlite
          .prepare("SELECT heartbeat_sequence FROM agent_sessions WHERE id = ?")
          .get(input.sessionId) as { heartbeat_sequence: number }
      ).heartbeat_sequence,
    );
    const firstZeroSequence =
      input.sequence === 0 &&
      currentSequence === 0 &&
      !ctx.sqlite
        .prepare("SELECT 1 FROM session_heartbeats WHERE session_id = ? LIMIT 1")
        .get(input.sessionId);
    if (input.sequence < currentSequence) return;
    if (input.sequence === currentSequence && !firstZeroSequence) return;

    const now = nowIso();
    const stateChanged =
      current.connectionState !== "ONLINE" || current.workState !== input.workState;
    // Task/review projections are ownership state, not adapter telemetry. Their aggregate mutations
    // (claim, release, handoff, review begin/verdict, same-lineage replacement) are the only writers.
    // Accepting the fields keeps older adapters wire-compatible, but a heartbeat cannot appoint its
    // own session to another task or review merely by naming an in-project id.
    ctx.sqlite
      .prepare(
        `UPDATE agent_sessions SET
            transport_last_seen_at = ?, activity_last_seen_at = ?, work_state = ?,
            connection_state = 'ONLINE',
            external_turn_id = COALESCE(?, external_turn_id), git_head = COALESCE(?, git_head),
            active_files_json = ?, heartbeat_sequence = ?, queue_depth = ?, version = version + 1
           WHERE id = ?`,
      )
      .run(
        now,
        now,
        input.workState,
        input.currentTurnId ?? null,
        input.gitHead ?? null,
        JSON.stringify(input.activeFiles),
        input.sequence,
        input.queueDepth,
        input.sessionId,
      );
    if (input.sequence % 12 === 0 || stateChanged) {
      ctx.sqlite
        .prepare(
          `INSERT INTO session_heartbeats(
              id, session_id, sequence, received_at, work_state, queue_depth, sampled
            ) VALUES (?, ?, ?, ?, ?, ?, 1)`,
        )
        .run(
          createId("hbt"),
          input.sessionId,
          input.sequence,
          now,
          input.workState,
          input.queueDepth,
        );
    }
    if (stateChanged) {
      event = ctx.appendEvent({
        projectId: current.projectId,
        type: "session.state.changed",
        actorType: "agent",
        actorId: current.agentId,
        aggregateType: "session",
        aggregateId: input.sessionId,
        causationId: null,
        correlationId: null,
        payload: {
          connectionState: "ONLINE",
          workState: input.workState,
          currentTaskId: current.currentTaskId,
          currentReviewId: current.currentReviewId,
        },
      });
    }
  });
  // Acquire the SQLite write reservation before reading the current sequence. A second Hub process
  // can therefore observe only the committed winner, never read the same sequence and overwrite it
  // with a different payload between the comparison and update.
  applyHeartbeat.immediate();
  if (event) ctx.bus.publish(event);
  return getSession(ctx, input.sessionId);
}

export function recordAdapterEvent(
  ctx: StoreContext,
  sessionId: string,
  input: {
    method: string;
    externalTurnId?: string | null;
    workState?: string;
    itemType?: string;
    itemId?: string;
    commandName?: string;
    exitCode?: number | null;
    files?: string[];
    status?: string;
    error?: string;
    idempotencyKey: string;
  },
  principal?: RequestPrincipal,
): DomainEvent {
  const session = getOpenSession(ctx, sessionId);
  if (principal) assertCanControlAdapterTransport(ctx.sqlite, principal, session);
  const safeMethod = input.method.replace(/[^a-zA-Z0-9/_.:-]/g, "").slice(0, 120);
  return ctx.mutate(
    session.projectId,
    input.idempotencyKey,
    "session.adapter_event",
    ({ emit }) => {
      if (input.externalTurnId !== undefined || input.workState) {
        ctx.sqlite
          .prepare(
            `UPDATE agent_sessions SET
                external_turn_id = COALESCE(?, external_turn_id),
                work_state = COALESCE(?, work_state),
                activity_last_seen_at = ?,
                version = version + 1
               WHERE id = ?`,
          )
          .run(input.externalTurnId ?? null, input.workState ?? null, nowIso(), sessionId);
      }
      return emit({
        projectId: session.projectId,
        type: `adapter.${safeMethod.replaceAll("/", ".")}`,
        actorType: "agent",
        actorId: session.agentId,
        aggregateType: "session",
        aggregateId: sessionId,
        causationId: input.itemId ?? null,
        correlationId: input.externalTurnId ?? session.externalTurnId,
        payload: {
          method: safeMethod,
          itemType: input.itemType ?? null,
          commandName: input.commandName?.slice(0, 200) ?? null,
          exitCode: input.exitCode ?? null,
          files: (input.files ?? []).slice(0, 200),
          status: input.status?.slice(0, 100) ?? null,
          error: input.error ? clipText(input.error, 800) : null,
        },
      });
    },
  );
}

/**
 * Terminal lifecycle is audited but not transactional: a pty has already started or died by
 * the time we hear about it, so this appends an event rather than guarding a state change.
 *
 * It publishes, like every other direct appendEvent caller here. It used not to, which meant
 * terminal events consumed a project sequence number and landed in the events table but never
 * reached a live subscriber -- an open Dashboard saw no terminal activity until it reconnected and
 * replayed over REST. That reading of the omission as deliberate does not survive the code: resize
 * is deduplicated at the source in PtyService specifically so a window drag cannot "drown the event
 * stream", and an unpublished event cannot drown a stream, only fill a table. The volume is bounded
 * either way -- spawned, exited, killed, resized and error are lifecycle events, none of them
 * per-output-chunk.
 */
export function recordTerminalEvent(
  ctx: StoreContext,
  projectId: string,
  input: { type: string; sessionId: string; payload: Record<string, unknown> },
): void {
  const event = ctx.appendEvent({
    projectId,
    type: input.type,
    actorType: "user",
    actorId: "local-user",
    aggregateType: "terminal",
    aggregateId: input.sessionId,
    causationId: null,
    correlationId: null,
    payload: input.payload,
  });
  ctx.bus.publish(event);
}

export function closeSession(
  ctx: StoreContext,
  sessionId: string,
  reason = "client_closed",
  principal?: RequestPrincipal,
): AgentSession {
  const session = getSession(ctx, sessionId);
  if (principal) assertCanControlAdapterSession(ctx.sqlite, principal, session);
  const now = nowIso();
  let event: DomainEvent;
  ctx.sqlite.transaction(() => {
    ctx.sqlite
      .prepare(
        `UPDATE agent_sessions SET connection_state = 'CLOSED', closed_at = ?,
           version = version + 1 WHERE id = ?`,
      )
      .run(now, sessionId);
    if (hasActiveTicketBinding(ctx, sessionId)) {
      closeSessionTicketsForHubSession(ctx.sqlite, {
        hubSessionId: sessionId,
        reason,
        now,
      });
    }
    ctx.sqlite
      .prepare(
        `UPDATE capture_session_bindings
         SET revoked_at = ?
         WHERE hub_session_id = ? AND revoked_at IS NULL`,
      )
      .run(now, sessionId);
    event = ctx.appendEvent({
      projectId: session.projectId,
      type: "session.closed",
      actorType: "agent",
      actorId: session.agentId,
      aggregateType: "session",
      aggregateId: sessionId,
      causationId: null,
      correlationId: null,
      payload: { reason },
    });
  })();
  ctx.bus.publish(event!);
  return getSession(ctx, sessionId);
}

export function closeAdapterSession(
  ctx: StoreContext,
  sessionId: string,
  input: CloseAdapterSessionInput,
  principal: RequestPrincipal,
): CloseAdapterSessionResult {
  if (
    principal.kind !== "AGENT" ||
    principal.credentialClass !== "SESSION_TICKET" ||
    principal.ticketPurpose !== "CONTROL" ||
    principal.hubSessionId !== sessionId
  ) {
    throw new HubError(
      "A session-bound CONTROL ticket is required to close this Adapter session",
      403,
      "TERMINAL_NOT_AUTHORIZED",
    );
  }
  const ticket = ctx.sqlite
    .prepare(
      `SELECT bundle_id, state, expires_at FROM adapter_session_tickets
       WHERE id = ? AND purpose = 'CONTROL' AND hub_session_id = ?`,
    )
    .get(principal.credentialId, sessionId) as
    { bundle_id: string; state: string; expires_at: string | null } | undefined;
  if (!ticket) {
    throw new HubError("CONTROL ticket binding was not found", 403, "TERMINAL_NOT_AUTHORIZED");
  }
  const session = getSession(ctx, sessionId);
  const requestFingerprint = mutationFingerprint({
    credentialId: principal.credentialId,
    bundleId: ticket.bundle_id,
    sessionId,
    reason: input.reason,
  });
  return ctx.mutate(
    session.projectId,
    input.idempotencyKey,
    "session.close.ticketed",
    ({ emit }) => {
      const now = nowIso();
      const expiredRecovery =
        principal.ticketState === "EXPIRED" &&
        principal.scopes.length === 0 &&
        ticket.state === "ACTIVE" &&
        ticket.expires_at !== null &&
        Date.parse(ticket.expires_at) <= Date.parse(now);
      if (principal.ticketState !== "ACTIVE" && !expiredRecovery) {
        throw new HubError(
          "Terminal ticket is valid only for an exact cached close replay",
          403,
          "TERMINAL_NOT_AUTHORIZED",
        );
      }
      const open = getOpenSession(ctx, sessionId);
      if (!expiredRecovery) {
        assertCanControlAdapterSession(ctx.sqlite, principal, open);
      }
      ctx.sqlite
        .prepare(
          `UPDATE agent_sessions SET connection_state = 'CLOSED', closed_at = ?,
             version = version + 1 WHERE id = ? AND connection_state <> 'CLOSED'`,
        )
        .run(now, sessionId);
      ctx.sqlite
        .prepare(
          `UPDATE capture_session_bindings SET revoked_at = ?
           WHERE hub_session_id = ? AND revoked_at IS NULL`,
        )
        .run(now, sessionId);
      const ticketBinding = expiredRecovery
        ? expireSessionTicketBundleForHubSession(ctx.sqlite, {
            hubSessionId: sessionId,
            reason: input.reason,
            now,
          })
        : closeSessionTicketsForHubSession(ctx.sqlite, {
            hubSessionId: sessionId,
            reason: input.reason,
            now,
          });
      const closed = getSession(ctx, sessionId);
      emit({
        projectId: session.projectId,
        type: "session.closed",
        actorType: "agent",
        actorId: session.agentId,
        aggregateType: "session",
        aggregateId: sessionId,
        causationId: ticketBinding.bundleId,
        correlationId: session.lineageId,
        payload: { reason: input.reason, ticketState: ticketBinding.state },
      });
      return { session: closed, ticketBinding };
    },
    {
      requestFingerprint,
      validateReplay: (cached) => {
        const result = cached as Partial<CloseAdapterSessionResult>;
        if (
          result.session?.id !== sessionId ||
          result.ticketBinding?.bundleId !== ticket.bundle_id ||
          result.ticketBinding?.hubSessionId !== sessionId ||
          !result.ticketBinding.purposes.some(
            (purpose) => purpose.id === principal.credentialId && purpose.purpose === "CONTROL",
          )
        ) {
          throw new HubError(
            "Cached close receipt does not match the terminal CONTROL ticket",
            409,
            "TICKET_IDEMPOTENCY_CONFLICT",
          );
        }
      },
    },
  );
}

export function refreshDerivedPresence(ctx: StoreContext, projectId?: string): void {
  const rows = ctx.sqlite
    .prepare(
      `SELECT s.*, p.config_json FROM agent_sessions s
         JOIN projects p ON p.id = s.project_id
         WHERE s.connection_state NOT IN ('CLOSED', 'OFFLINE')
         ${projectId ? "AND s.project_id = ?" : ""}`,
    )
    .all(...(projectId ? [projectId] : [])) as any[];
  const now = Date.now();
  for (const row of rows) {
    const config = ProjectConfigSchema.parse({
      ...DEFAULT_PROJECT_CONFIG,
      ...json(row.config_json, {}),
    });
    const lag = now - Date.parse(row.transport_last_seen_at);
    const nextConnection =
      lag > config.offlineAfterSeconds * 1000
        ? "OFFLINE"
        : lag > (config.offlineAfterSeconds * 1000) / 2
          ? "STALE"
          : "ONLINE";
    const activityLag = row.activity_last_seen_at
      ? now - Date.parse(row.activity_last_seen_at)
      : Number.POSITIVE_INFINITY;
    const nextWork =
      nextConnection === "ONLINE" &&
      activityLag > config.idleAfterSeconds * 1000 &&
      !row.current_task_id
        ? "IDLE"
        : row.work_state;
    if (nextConnection === row.connection_state && nextWork === row.work_state) continue;
    let event: DomainEvent;
    ctx.sqlite.transaction(() => {
      ctx.sqlite
        .prepare(
          `UPDATE agent_sessions SET connection_state = ?, work_state = ?,
             version = version + 1 WHERE id = ?`,
        )
        .run(nextConnection, nextWork, row.id);
      if (
        nextConnection === "OFFLINE" &&
        row.current_task_id &&
        lag > config.staleClaimAfterSeconds * 1000
      ) {
        ctx.sqlite
          .prepare(
            `UPDATE tasks SET claim_stale_at = COALESCE(claim_stale_at, ?),
               version = version + 1, updated_at = ? WHERE id = ?`,
          )
          .run(nowIso(), nowIso(), row.current_task_id);
      }
      event = ctx.appendEvent({
        projectId: row.project_id,
        type: "session.presence.derived",
        actorType: "system",
        actorId: "presence-monitor",
        aggregateType: "session",
        aggregateId: row.id,
        causationId: null,
        correlationId: null,
        payload: { connectionState: nextConnection, workState: nextWork, lagMs: lag },
      });
    })();
    ctx.bus.publish(event!);
  }
}
