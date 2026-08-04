import {
  createId,
  describeMessageRecipientConflict,
  nowIso,
  type CrossAgentMessage,
  type MessagePriority,
  type MessageSurfacePermit,
  type Thread,
} from "@crossagent/protocol";
import { ConflictError, ForbiddenError, HubError, NotFoundError } from "../../domain/errors.js";
import type { RequestPrincipal } from "../../security/local-auth.js";
import { bool, json, mutationFingerprint, type StoreContext } from "./context.js";
import { materializeDirectiveExpiryById } from "./directives.js";
import { assertCanControlAdapterSession } from "./session-identity.js";
import { getOpenSession, getSession } from "./sessions.js";
import {
  mutationOptions,
  resolveMessageAuthority,
  resolveMutationActor,
  resolveSessionMutationActor,
} from "./mutation-authority.js";

function assertMessageSender(
  ctx: StoreContext,
  projectId: string,
  fromAgentId: string,
  fromSessionId?: string,
): void {
  if (!fromSessionId) {
    const registeredAgent = ctx.sqlite
      .prepare("SELECT 1 FROM agent_sessions WHERE project_id = ? AND agent_id = ? LIMIT 1")
      .get(projectId, fromAgentId);
    if (registeredAgent) {
      throw new ForbiddenError("A registered agent message sender requires its session id");
    }
    return;
  }
  const session = getOpenSession(ctx, fromSessionId);
  if (session.projectId !== projectId || session.agentId !== fromAgentId) {
    throw new ForbiddenError("Message sender session does not match the project and agent");
  }
}

function recipientFromRow(row: any) {
  return {
    id: row.id,
    messageId: row.message_id,
    recipientAgentId: row.recipient_agent_id,
    recipientSessionId: row.recipient_session_id,
    state: row.state,
    deliveredAt: row.delivered_at,
    acknowledgedAt: row.acknowledged_at,
    processedAt: row.processed_at,
    respondedAt: row.responded_at,
    attemptCount: row.attempt_count,
    lastError: row.last_error,
    surfaceFence: row.surface_fence,
  };
}

function surfacePermitFromRow(row: any): MessageSurfacePermit {
  return {
    id: row.id,
    messageId: row.message_id,
    recipientId: row.recipient_id,
    sessionId: row.session_id,
    sessionIncarnation: row.session_incarnation,
    recipientFence: row.recipient_fence,
    state: row.state,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    confirmedAt: row.confirmed_at,
  };
}

function messageFromRow(row: any, recipients: any[] = []): CrossAgentMessage {
  return {
    id: row.id,
    projectId: row.project_id,
    sequence: row.sequence,
    threadId: row.thread_id,
    replyTo: row.reply_to,
    taskId: row.task_id,
    reviewId: row.review_id,
    fromAgentId: row.from_agent_id,
    fromSessionId: row.from_session_id,
    type: row.type,
    priority: row.priority,
    requiresAck: bool(row.requires_ack),
    requiresResponse: bool(row.requires_response),
    summary: row.summary,
    detail: json(row.detail_json, null),
    references: json(row.references_json, []),
    dedupeKey: row.dedupe_key,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    recipients: recipients.map(recipientFromRow),
  } as CrossAgentMessage;
}

function threadFromRow(row: any): Thread {
  return {
    id: row.id,
    projectId: row.project_id,
    subject: row.subject,
    status: row.status,
    taskId: row.task_id,
    reviewId: row.review_id,
    waitingForAgentId: row.waiting_for_agent_id,
    proposalRounds: row.proposal_rounds,
    objectionRounds: row.objection_rounds,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  } as Thread;
}

function assertMessageReadPrincipal(
  ctx: StoreContext,
  principal: RequestPrincipal,
  projectId: string,
): { agentId: string; sessionId: string } | null {
  if (principal.kind === "DASHBOARD_USER") return null;
  if (
    principal.kind !== "AGENT" ||
    principal.projectId !== projectId ||
    !principal.agentId ||
    !principal.hubSessionId
  ) {
    throw new ForbiddenError("Credential cannot read this project message");
  }
  const session = getOpenSession(ctx, principal.hubSessionId);
  assertCanControlAdapterSession(ctx.sqlite, principal, session);
  return { agentId: principal.agentId, sessionId: principal.hubSessionId };
}

function visibleMessageRecipients(
  recipients: any[],
  reader: { agentId: string; sessionId: string } | null,
): any[] {
  if (!reader) return recipients;
  return recipients.filter(
    (recipient) =>
      recipient.recipient_agent_id !== reader.agentId ||
      recipient.recipient_session_id === null ||
      recipient.recipient_session_id === reader.sessionId,
  );
}

function canReadMessageRow(
  row: any,
  recipients: any[],
  reader: { agentId: string; sessionId: string } | null,
): boolean {
  if (!reader) return true;
  return (
    row.from_session_id === reader.sessionId ||
    recipients.some(
      (recipient) =>
        recipient.recipient_agent_id === reader.agentId &&
        (recipient.recipient_session_id === null ||
          recipient.recipient_session_id === reader.sessionId),
    )
  );
}

export function getMessage(
  ctx: StoreContext,
  messageId: string,
  principal?: RequestPrincipal,
): CrossAgentMessage {
  const row = ctx.sqlite.prepare("SELECT * FROM messages WHERE id = ?").get(messageId) as any;
  if (!row) throw new NotFoundError("Message", messageId);
  const recipients = ctx.sqlite
    .prepare("SELECT * FROM message_recipients WHERE message_id = ?")
    .all(messageId) as any[];
  const reader = principal ? assertMessageReadPrincipal(ctx, principal, row.project_id) : null;
  if (!canReadMessageRow(row, recipients, reader)) throw new NotFoundError("Message", messageId);
  return messageFromRow(row, visibleMessageRecipients(recipients, reader));
}

export function listMessages(
  ctx: StoreContext,
  projectId: string,
  filters: {
    agentId?: string;
    sessionId?: string;
    type?: string;
    unresolved?: boolean;
    unread?: boolean;
    recipientUnsettled?: boolean;
    taskId?: string;
    search?: string;
    limit?: number;
    beforeSequence?: number;
  } = {},
  principal?: RequestPrincipal,
): CrossAgentMessage[] {
  let effectiveFilters = filters;
  let exactRecipientReader: { agentId: string; sessionId: string } | null = null;
  if (filters.recipientUnsettled) {
    if (!filters.agentId?.trim() || !filters.sessionId?.trim()) {
      throw new HubError(
        "recipientUnsettled requires an exact agentId and sessionId",
        422,
        "RECIPIENT_UNSETTLED_QUERY_INVALID",
      );
    }
    if (filters.unread || filters.unresolved) {
      throw new HubError(
        "recipientUnsettled cannot be combined with unread or unresolved",
        422,
        "RECIPIENT_UNSETTLED_QUERY_INVALID",
      );
    }
    if (!principal) {
      throw new ForbiddenError("recipientUnsettled requires a session-bound credential");
    }
    const reader = assertMessageReadPrincipal(ctx, principal, projectId);
    if (!reader || reader.agentId !== filters.agentId || reader.sessionId !== filters.sessionId) {
      throw new ForbiddenError("Credential cannot read another recipient's unsettled inbox");
    }
    exactRecipientReader = reader;
  } else if (principal && principal.kind !== "DASHBOARD_USER") {
    if (
      principal.kind !== "AGENT" ||
      principal.projectId !== projectId ||
      !principal.agentId ||
      !principal.hubSessionId
    ) {
      throw new ForbiddenError("Credential cannot read this project inbox");
    }
    const session = getOpenSession(ctx, principal.hubSessionId);
    assertCanControlAdapterSession(ctx.sqlite, principal, session);
    effectiveFilters = {
      ...filters,
      agentId: principal.agentId,
      sessionId: principal.hubSessionId,
    };
  }
  const clauses = ["m.project_id = ?"];
  const params: unknown[] = [projectId];
  let join = "";
  if (
    effectiveFilters.agentId ||
    effectiveFilters.sessionId ||
    effectiveFilters.unread ||
    effectiveFilters.recipientUnsettled
  ) {
    join = "JOIN message_recipients mr ON mr.message_id = m.id";
    if (effectiveFilters.agentId) {
      clauses.push("mr.recipient_agent_id = ?");
      params.push(effectiveFilters.agentId);
    }
    if (effectiveFilters.recipientUnsettled) {
      clauses.push("mr.recipient_session_id = ?");
      params.push(effectiveFilters.sessionId);
    } else if (effectiveFilters.sessionId) {
      clauses.push("(mr.recipient_session_id IS NULL OR mr.recipient_session_id = ?)");
      params.push(effectiveFilters.sessionId);
    }
    if (effectiveFilters.recipientUnsettled) {
      clauses.push("mr.state IN ('PENDING', 'FAILED', 'DELIVERED', 'ACKNOWLEDGED')");
    } else if (effectiveFilters.unread) {
      clauses.push("mr.state IN ('PENDING', 'DELIVERED')");
    }
  }
  if (effectiveFilters.type) {
    clauses.push("m.type = ?");
    params.push(effectiveFilters.type);
  }
  if (effectiveFilters.taskId) {
    clauses.push("m.task_id = ?");
    params.push(effectiveFilters.taskId);
  }
  if (effectiveFilters.beforeSequence) {
    clauses.push("m.sequence < ?");
    params.push(effectiveFilters.beforeSequence);
  }
  if (effectiveFilters.unresolved) clauses.push("th.status IN ('OPEN', 'NEEDS_USER')");
  if (effectiveFilters.search) {
    clauses.push("m.id IN (SELECT message_id FROM messages_fts WHERE messages_fts MATCH ?)");
    params.push(effectiveFilters.search.replaceAll(/["']/g, " "));
  }
  params.push(Math.min(effectiveFilters.limit ?? 100, 500));
  const rows = ctx.sqlite
    .prepare(
      `SELECT DISTINCT m.* FROM messages m
         ${join}
         JOIN threads th ON th.id = m.thread_id
         WHERE ${clauses.join(" AND ")}
         ORDER BY m.sequence DESC LIMIT ?`,
    )
    .all(...params) as any[];
  return rows.map((row) => {
    const recipients = ctx.sqlite
      .prepare("SELECT * FROM message_recipients WHERE message_id = ?")
      .all(row.id) as any[];
    if (exactRecipientReader) {
      return messageFromRow(
        row,
        recipients.filter(
          (recipient) =>
            recipient.recipient_agent_id === exactRecipientReader.agentId &&
            recipient.recipient_session_id === exactRecipientReader.sessionId,
        ),
      );
    }
    const reader =
      principal && principal.kind !== "DASHBOARD_USER"
        ? { agentId: principal.agentId!, sessionId: principal.hubSessionId! }
        : null;
    return messageFromRow(row, visibleMessageRecipients(recipients, reader));
  });
}

export function postMessage(
  ctx: StoreContext,
  projectId: string,
  input: {
    threadId?: string;
    subject?: string;
    replyTo?: string;
    taskId?: string;
    reviewId?: string;
    fromAgentId: string;
    fromSessionId?: string;
    recipients: Array<{ agentId: string; sessionId?: string }>;
    type: string;
    priority: MessagePriority;
    requiresAck: boolean;
    requiresResponse: boolean;
    summary: string;
    detail?: unknown;
    references?: Array<Record<string, unknown>>;
    dedupeKey?: string;
    expiresAt?: string;
    idempotencyKey: string;
  },
  principal?: RequestPrincipal,
): CrossAgentMessage {
  const authority = principal
    ? resolveMessageAuthority(ctx, principal, projectId, input)
    : input.fromSessionId
      ? {
          actor: resolveSessionMutationActor(
            ctx,
            projectId,
            input.fromSessionId,
            input.fromAgentId,
          ),
          fromAgentId: input.fromAgentId,
          fromSessionId: input.fromSessionId,
        }
      : (() => {
          throw new ForbiddenError("Trusted Agent message composition requires an open session");
        })();
  const effectiveInput = {
    ...input,
    fromAgentId: authority.fromAgentId,
    fromSessionId: authority.fromSessionId,
  };
  const requestIdentity = {
    ...effectiveInput,
    idempotencyKey: undefined,
    projectId,
  };
  const cached = ctx.mutate(
    projectId,
    input.idempotencyKey,
    "message.post",
    ({ emit }) => {
      assertMessageSender(ctx, projectId, effectiveInput.fromAgentId, effectiveInput.fromSessionId);
      if (effectiveInput.dedupeKey) {
        const duplicate = ctx.sqlite
          .prepare("SELECT * FROM messages WHERE project_id = ? AND dedupe_key = ?")
          .get(projectId, effectiveInput.dedupeKey);
        if (duplicate) return { messageId: (duplicate as any).id as string };
      }
      const recipientConflict = describeMessageRecipientConflict(effectiveInput.recipients);
      if (recipientConflict) {
        throw new HubError(recipientConflict, 422, "DUPLICATE_MESSAGE_RECIPIENT");
      }
      const recipientSession = ctx.sqlite.prepare(
        "SELECT project_id, agent_id FROM agent_sessions WHERE id = ?",
      );
      for (const recipient of effectiveInput.recipients) {
        if (!recipient.sessionId) continue;
        const session = recipientSession.get(recipient.sessionId) as
          { project_id: string; agent_id: string } | undefined;
        if (
          !session ||
          session.project_id !== projectId ||
          session.agent_id !== recipient.agentId
        ) {
          throw new HubError(
            "Explicit message recipient session does not match the project and agent",
            422,
            "MESSAGE_RECIPIENT_SESSION_INVALID",
          );
        }
      }
      const id = createId("msg");
      const now = nowIso();
      let threadId = effectiveInput.threadId;
      if (threadId) {
        const thread = ctx.sqlite.prepare("SELECT * FROM threads WHERE id = ?").get(threadId);
        if (!thread || (thread as any).project_id !== projectId) {
          throw new NotFoundError("Thread", threadId);
        }
      } else {
        threadId = createId("thr");
        ctx.sqlite
          .prepare(
            `INSERT INTO threads(
                id, project_id, subject, status, task_id, review_id, waiting_for_agent_id,
                proposal_rounds, objection_rounds, version, created_at, updated_at
              ) VALUES (?, ?, ?, 'OPEN', ?, ?, ?, 0, 0, 0, ?, ?)`,
          )
          .run(
            threadId,
            projectId,
            effectiveInput.subject ?? effectiveInput.summary.slice(0, 160),
            effectiveInput.taskId ?? null,
            effectiveInput.reviewId ?? null,
            effectiveInput.requiresResponse
              ? (effectiveInput.recipients[0]?.agentId ?? null)
              : null,
            now,
            now,
          );
      }
      const event = emit({
        projectId,
        type: "message.posted",
        actorType: authority.actor.actorType,
        actorId: authority.actor.actorId,
        aggregateType: "message",
        aggregateId: id,
        causationId: effectiveInput.replyTo ?? null,
        correlationId: threadId,
        payload: {
          threadId,
          taskId: effectiveInput.taskId ?? null,
          reviewId: effectiveInput.reviewId ?? null,
          type: effectiveInput.type,
          priority: effectiveInput.priority,
          requiresAck: effectiveInput.requiresAck,
          requiresResponse: effectiveInput.requiresResponse,
          recipients: effectiveInput.recipients,
          summary: effectiveInput.summary,
        },
      });
      ctx.sqlite
        .prepare(
          `INSERT INTO messages(
            id, project_id, sequence, thread_id, reply_to, task_id, review_id,
            from_agent_id, from_session_id, type, priority, requires_ack,
            requires_response, summary, detail_json, references_json, dedupe_key,
            expires_at, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          projectId,
          event.sequence,
          threadId,
          effectiveInput.replyTo ?? null,
          effectiveInput.taskId ?? null,
          effectiveInput.reviewId ?? null,
          effectiveInput.fromAgentId,
          effectiveInput.fromSessionId ?? null,
          effectiveInput.type,
          effectiveInput.priority,
          effectiveInput.requiresAck ? 1 : 0,
          effectiveInput.requiresResponse ? 1 : 0,
          effectiveInput.summary,
          effectiveInput.detail === undefined ? null : JSON.stringify(effectiveInput.detail),
          JSON.stringify(effectiveInput.references ?? []),
          effectiveInput.dedupeKey ?? null,
          effectiveInput.expiresAt ?? null,
          now,
        );
      const recipientInsert = ctx.sqlite.prepare(
        `INSERT INTO message_recipients(
          id, message_id, recipient_agent_id, recipient_session_id, state, attempt_count
        ) VALUES (?, ?, ?, ?, 'PENDING', 0)`,
      );
      for (const recipient of effectiveInput.recipients) {
        recipientInsert.run(createId("rcp"), id, recipient.agentId, recipient.sessionId ?? null);
      }
      const roundColumn =
        effectiveInput.type === "PROPOSAL"
          ? "proposal_rounds"
          : ["CONFLICT", "BLOCKER"].includes(effectiveInput.type)
            ? "objection_rounds"
            : null;
      if (roundColumn) {
        ctx.sqlite
          .prepare(
            `UPDATE threads SET ${roundColumn} = ${roundColumn} + 1,
             version = version + 1, updated_at = ? WHERE id = ?`,
          )
          .run(now, threadId);
        const rounds = ctx.sqlite
          .prepare("SELECT proposal_rounds, objection_rounds FROM threads WHERE id = ?")
          .get(threadId) as { proposal_rounds: number; objection_rounds: number };
        if (rounds.proposal_rounds >= 2 && rounds.objection_rounds >= 2) {
          ctx.sqlite
            .prepare(
              `UPDATE threads SET status = 'NEEDS_USER', waiting_for_agent_id = NULL,
               version = version + 1, updated_at = ? WHERE id = ?`,
            )
            .run(now, threadId);
        }
      } else if (effectiveInput.requiresResponse) {
        ctx.sqlite
          .prepare(
            `UPDATE threads SET waiting_for_agent_id = ?, version = version + 1,
             updated_at = ? WHERE id = ?`,
          )
          .run(effectiveInput.recipients[0]?.agentId ?? null, now, threadId);
      }
      return { messageId: id };
    },
    {
      ...mutationOptions(authority.actor, requestIdentity),
      validateReplay: () =>
        assertMessageSender(
          ctx,
          projectId,
          effectiveInput.fromAgentId,
          effectiveInput.fromSessionId,
        ),
    },
  );
  return getMessage(ctx, cached.messageId);
}

/**
 * Atomically assigns an agent-wide recipient to one concrete session before an adapter performs
 * any user-visible delivery. The project event is broadcast, so two same-agent adapters can race
 * here; SQLite serializes the mutation and only the winner receives the message.
 */
function assertMessageSurfacePrincipal(
  ctx: StoreContext,
  principal: RequestPrincipal,
  messageId: string,
  sessionId: string,
  operation: "TRANSPORT" | "MODEL_RECEIPT" = "TRANSPORT",
): void {
  if (
    principal.kind !== "AGENT" ||
    principal.credentialClass !== "SESSION_TICKET" ||
    principal.ticketState !== "ACTIVE" ||
    principal.hubSessionId !== sessionId
  ) {
    throw new ForbiddenError(
      "Only the current session-bound credential can perform this message operation",
    );
  }
  const session = getOpenSession(ctx, sessionId);
  const requiredPurpose =
    operation === "MODEL_RECEIPT" && session.client === "codex-app-server"
      ? "MODEL_MCP"
      : "CONTROL";
  if (principal.ticketPurpose !== requiredPurpose) {
    throw new ForbiddenError(
      `This message operation requires the session's ${requiredPurpose} credential`,
    );
  }
  assertCanControlAdapterSession(ctx.sqlite, principal, session);
  const message = ctx.sqlite
    .prepare("SELECT project_id FROM messages WHERE id = ?")
    .get(messageId) as { project_id: string } | undefined;
  if (
    !message ||
    principal.projectId !== session.projectId ||
    principal.agentId !== session.agentId ||
    message.project_id !== session.projectId
  ) {
    throw new ForbiddenError("Message surface does not match the CONTROL credential binding");
  }
  const authorityLinked = ctx.sqlite
    .prepare("SELECT 1 FROM message_directive_links WHERE message_id = ?")
    .get(messageId);
  if (authorityLinked && principal.agentId !== session.agentId) {
    throw new ForbiddenError(
      "Authority message surfaces require the exact client-specific Agent credential",
    );
  }
}

function assertAuthorityMessageActive(ctx: StoreContext, messageId: string): void {
  const directive = ctx.sqlite
    .prepare(
      `SELECT directive.id, directive.expires_at
       FROM message_directive_links link
       JOIN authority_directives directive ON directive.id = link.directive_id
       WHERE link.message_id = ?`,
    )
    .get(messageId) as { id: string; expires_at: string | null } | undefined;
  if (!directive) return;
  const terminal = ctx.sqlite
    .prepare(
      `SELECT 1 FROM authority_events
       WHERE directive_id = ?
         AND event_type IN ('SUPERSEDED', 'REVOKED', 'COMPLETED', 'EXPIRED')
       LIMIT 1`,
    )
    .get(directive.id);
  if (
    terminal ||
    (directive.expires_at !== null && Date.parse(directive.expires_at) <= Date.now())
  ) {
    throw new HubError("Authority directive is no longer active", 409, "DIRECTIVE_INACTIVE");
  }
}

export function claimMessageRecipient(
  ctx: StoreContext,
  principal: RequestPrincipal,
  messageId: string,
  input: { sessionId: string; idempotencyKey: string },
): CrossAgentMessage {
  const message = getMessage(ctx, messageId);
  assertMessageSurfacePrincipal(ctx, principal, messageId, input.sessionId);
  const cached = ctx.mutate(
    message.projectId,
    input.idempotencyKey,
    "message.recipient.claim",
    ({ emit }) => {
      assertAuthorityMessageActive(ctx, messageId);
      const session = getSession(ctx, input.sessionId);
      if (session.projectId !== message.projectId) {
        throw new ForbiddenError("Session and message belong to different projects");
      }
      // Claim is a pre-surface liveness check even when this recipient is already pinned here.
      // A superseded adapter can still hold an old message object in a local queue; returning that
      // object without rechecking CLOSED would let it surface work after ownership moved.
      getOpenSession(ctx, input.sessionId);
      const exact = ctx.sqlite
        .prepare(
          `SELECT * FROM message_recipients
           WHERE message_id = ? AND recipient_agent_id = ? AND recipient_session_id = ?
           ORDER BY id LIMIT 1`,
        )
        .get(messageId, session.agentId, session.id);
      // A session-pinned recipient is already exclusively owned, so this stays idempotent once the
      // open-session check above succeeds. Final in-flight acknowledgement after close is handled
      // by updateMessageState, not by this pre-surface endpoint.
      if (exact) return { messageId };

      const unbound = ctx.sqlite
        .prepare(
          `SELECT * FROM message_recipients
           WHERE message_id = ? AND recipient_agent_id = ? AND recipient_session_id IS NULL
             AND state NOT IN ('PROCESSED', 'RESPONDED', 'EXPIRED')
           ORDER BY id LIMIT 1`,
        )
        .get(messageId, session.agentId) as { id: string } | undefined;
      if (!unbound) {
        const claimedByPeer = ctx.sqlite
          .prepare(
            `SELECT 1 FROM message_recipients
             WHERE message_id = ? AND recipient_agent_id = ?
               AND recipient_session_id IS NOT NULL
             LIMIT 1`,
          )
          .get(messageId, session.agentId);
        if (claimedByPeer) {
          throw new HubError(
            "Message recipient was claimed by another session",
            409,
            "MESSAGE_RECIPIENT_CLAIMED",
          );
        }
        throw new ForbiddenError("Session is not a recipient of this message");
      }
      const claimed = ctx.sqlite
        .prepare(
          `UPDATE message_recipients SET recipient_session_id = ?
           WHERE id = ? AND recipient_session_id IS NULL`,
        )
        .run(session.id, unbound.id);
      if (claimed.changes !== 1) {
        throw new HubError(
          "Message recipient was claimed by another session",
          409,
          "MESSAGE_RECIPIENT_CLAIMED",
        );
      }
      emit({
        projectId: message.projectId,
        type: "message.recipient.claimed",
        actorType: "agent",
        actorId: session.agentId,
        aggregateType: "message",
        aggregateId: messageId,
        causationId: null,
        correlationId: message.threadId,
        payload: { sessionId: session.id },
      });
      return { messageId };
    },
    {
      requestFingerprint: `${messageId}:${input.sessionId}`,
      validateReplay: () => {
        assertAuthorityMessageActive(ctx, messageId);
        const session = getOpenSession(ctx, input.sessionId);
        const current = getMessage(ctx, messageId);
        if (
          session.projectId !== current.projectId ||
          !current.recipients.some(
            (recipient) =>
              recipient.recipientAgentId === session.agentId &&
              recipient.recipientSessionId === session.id,
          )
        ) {
          throw new HubError(
            "Message recipient ownership changed after the original claim",
            409,
            "MESSAGE_RECIPIENT_CLAIMED",
          );
        }
      },
    },
  );
  return getMessage(ctx, cached.messageId);
}

function getCurrentSurfaceSession(ctx: StoreContext, projectId: string, sessionId: string) {
  const session = getOpenSession(ctx, sessionId);
  if (session.projectId !== projectId) {
    throw new ForbiddenError("Session and message belong to different projects");
  }
  if (session.lineageId) {
    const head = ctx.sqlite
      .prepare("SELECT head_session_id FROM session_lineages WHERE id = ?")
      .get(session.lineageId) as { head_session_id: string | null } | undefined;
    if (head?.head_session_id !== session.id) {
      throw new HubError(
        "Session is not the current logical incarnation",
        409,
        "SESSION_INCARNATION_CONFLICT",
      );
    }
  }
  return session;
}

type ConfirmedSurfaceRecovery = {
  row: Record<string, unknown> & {
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
    owner_project_id: string;
    owner_agent_id: string;
    owner_lineage_id: string | null;
    owner_incarnation: number;
    thread_id: string;
  };
  permit: MessageSurfacePermit & { state: "CONFIRMED" };
  recoveredFor:
    | { kind: "CURRENT_SESSION"; sessionId: string; sessionIncarnation: number }
    | {
        kind: "LINEAGE_HANDOFF";
        sessionId: string;
        sessionIncarnation: number;
        lineageId: string;
      };
};

function findConfirmedSurfaceRecovery(
  ctx: StoreContext,
  messageId: string,
  session: ReturnType<typeof getOpenSession>,
): ConfirmedSurfaceRecovery | undefined {
  const rows = ctx.sqlite
    .prepare(
      `SELECT surface.*, recipient.surface_fence, recipient.state AS recipient_state,
              recipient.recipient_agent_id, recipient.recipient_session_id,
              message.project_id, message.thread_id, owner.project_id AS owner_project_id,
              owner.agent_id AS owner_agent_id, owner.lineage_id AS owner_lineage_id,
              owner.incarnation AS owner_incarnation
         FROM message_surface_attempts AS surface
         JOIN message_recipients AS recipient ON recipient.id = surface.recipient_id
         JOIN messages AS message ON message.id = surface.message_id
         JOIN agent_sessions AS owner ON owner.id = surface.session_id
        WHERE surface.message_id = ?
          AND surface.state = 'CONFIRMED'
          AND recipient.message_id = surface.message_id
          AND recipient.recipient_agent_id = ?
          AND recipient.recipient_session_id = ?
          AND message.project_id = ?
          AND (
            surface.session_id = ?
            OR (? IS NOT NULL AND owner.lineage_id = ?)
          )
        ORDER BY surface.recipient_fence DESC, surface.created_at DESC`,
    )
    .all(
      messageId,
      session.agentId,
      session.id,
      session.projectId,
      session.id,
      session.lineageId,
      session.lineageId,
    ) as ConfirmedSurfaceRecovery["row"][];
  if (rows.length === 0) return undefined;
  if (rows.length !== 1) {
    throw new HubError(
      "Confirmed surface provenance is not unique",
      409,
      "AUTHORITY_DELIVERY_RECOVERY_RECEIPT_MISSING",
    );
  }
  const row = rows[0]!;
  const currentSession = row.session_id === session.id;
  const exactOwner =
    row.owner_project_id === session.projectId &&
    row.owner_agent_id === session.agentId &&
    row.session_incarnation === row.owner_incarnation &&
    (currentSession
      ? row.owner_incarnation === (session.incarnation ?? 0)
      : session.lineageId !== null &&
        row.owner_lineage_id === session.lineageId &&
        row.owner_incarnation < (session.incarnation ?? 0));
  const exactRecipient =
    ["DELIVERED", "ACKNOWLEDGED", "PROCESSED", "RESPONDED"].includes(row.recipient_state) &&
    row.recipient_fence === row.surface_fence;
  const durableDelivery = ctx.sqlite
    .prepare(
      `SELECT 1 FROM message_deliveries
        WHERE recipient_id = ? AND session_id = ? AND state = 'DELIVERED'
          AND completed_at IS NOT NULL
        LIMIT 1`,
    )
    .get(row.recipient_id, row.session_id);
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
      session.projectId,
      session.agentId,
      messageId,
      row.recipient_id,
      row.session_id,
      row.id,
      row.recipient_fence,
    );
  const directive = ctx.sqlite
    .prepare("SELECT directive_id FROM message_directive_links WHERE message_id = ?")
    .get(messageId) as { directive_id: string } | undefined;
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
          session.agentId,
          row.session_id,
          messageId,
          session.agentId,
          row.session_id,
          row.id,
          row.recipient_fence,
        )
    : true;
  const recordedHandoff = currentSession
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
              AND handoff.predecessor_session_id = ?
              AND handoff.predecessor_incarnation = ?
              AND handoff.successor_session_id = ?
              AND handoff.successor_incarnation = ?
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
          session.projectId,
          messageId,
          row.recipient_id,
          row.id,
          session.lineageId,
          row.session_id,
          row.session_incarnation,
          session.predecessorSessionId,
          (session.incarnation ?? 0) - 1,
          session.id,
          session.incarnation,
          row.recipient_fence,
          row.thread_id,
        );
  const reconciledHandoff = currentSession
    ? true
    : ctx.sqlite
        .prepare(
          `SELECT 1 FROM events AS event
            WHERE event.project_id = ?
              AND event.type = 'message.surface.reconciled'
              AND event.actor_type = 'agent' AND event.actor_id = ?
              AND event.aggregate_type = 'message' AND event.aggregate_id = ?
              AND event.causation_id = ? AND event.correlation_id = ?
              AND json_extract(event.payload_json, '$.recipientId') = ?
              AND json_extract(event.payload_json, '$.sessionId') = ?
              AND json_extract(event.payload_json, '$.surfaceAttemptId') = ?
              AND json_extract(event.payload_json, '$.recipientFence') = ?
              AND json_extract(event.payload_json, '$.reconciledBySessionId') = ?
              AND json_extract(event.payload_json, '$.externalThreadId') = ?
              AND NOT EXISTS (
                SELECT 1 FROM message_directive_links AS link
                 WHERE link.message_id = event.aggregate_id
              )
            LIMIT 1`,
        )
        .get(
          session.projectId,
          session.agentId,
          messageId,
          row.id,
          row.thread_id,
          row.recipient_id,
          row.session_id,
          row.id,
          row.recipient_fence,
          session.id,
          session.externalThreadId,
        );
  const chainedReconciledHandoff = currentSession
    ? true
    : ctx.sqlite
        .prepare(
          `SELECT 1 FROM events AS event
            WHERE event.project_id = ?
              AND event.type = 'message.surface.reconciled_handoff'
              AND event.actor_type = 'system' AND event.actor_id = 'session-replacement'
              AND event.aggregate_type = 'message' AND event.aggregate_id = ?
              AND event.causation_id = ? AND event.correlation_id = ?
              AND json_extract(event.payload_json, '$.recipientId') = ?
              AND json_extract(event.payload_json, '$.sessionId') = ?
              AND json_extract(event.payload_json, '$.sessionIncarnation') = ?
              AND json_extract(event.payload_json, '$.recipientFence') = ?
              AND json_extract(event.payload_json, '$.reboundToSessionId') = ?
              AND json_extract(event.payload_json, '$.lineageId') = ?
              AND NOT EXISTS (
                SELECT 1 FROM message_directive_links AS link
                 WHERE link.message_id = event.aggregate_id
              )
            LIMIT 1`,
        )
        .get(
          session.projectId,
          messageId,
          row.id,
          row.thread_id,
          row.recipient_id,
          row.session_id,
          row.session_incarnation,
          row.recipient_fence,
          session.id,
          session.lineageId,
        );
  const handoffEvent =
    currentSession || recordedHandoff || reconciledHandoff || chainedReconciledHandoff;
  if (
    !exactOwner ||
    !exactRecipient ||
    row.error !== null ||
    row.confirmed_at === null ||
    !durableDelivery ||
    !genericEvent ||
    !authorityDelivery ||
    !handoffEvent
  ) {
    throw new HubError(
      "Confirmed surface has no exact durable delivery receipt",
      409,
      "AUTHORITY_DELIVERY_RECOVERY_RECEIPT_MISSING",
    );
  }
  return {
    row,
    permit: { ...surfacePermitFromRow(row), state: "CONFIRMED" },
    recoveredFor: currentSession
      ? {
          kind: "CURRENT_SESSION",
          sessionId: session.id,
          sessionIncarnation: session.incarnation ?? 0,
        }
      : {
          kind: "LINEAGE_HANDOFF",
          sessionId: session.id,
          sessionIncarnation: session.incarnation ?? 0,
          lineageId: session.lineageId!,
        },
  };
}

/**
 * Recover the immutable evidence for a delivery that this exact current Adapter session already
 * confirmed. This is intentionally not a new surface permit: it only reconstructs the permit that
 * was durably consumed before an Adapter cache eviction or process restart.
 */
export function recoverConfirmedMessageSurface(
  ctx: StoreContext,
  principal: RequestPrincipal,
  messageId: string,
  input: { sessionId: string },
): Pick<ConfirmedSurfaceRecovery, "permit" | "recoveredFor"> {
  const session = getOpenSession(ctx, input.sessionId);
  assertCanControlAdapterSession(ctx.sqlite, principal, session);
  getCurrentSurfaceSession(ctx, session.projectId, session.id);

  const unresolved = ctx.sqlite
    .prepare(
      `SELECT surface.*, recipient.surface_fence,
              owner.lineage_id AS owner_lineage_id, owner.incarnation AS owner_incarnation
         FROM message_surface_attempts AS surface
         JOIN message_recipients AS recipient ON recipient.id = surface.recipient_id
         JOIN messages AS message ON message.id = surface.message_id
         JOIN agent_sessions AS owner ON owner.id = surface.session_id
        WHERE surface.message_id = ?
          AND surface.state IN ('ACTIVE', 'AMBIGUOUS')
          AND recipient.message_id = surface.message_id
          AND recipient.recipient_agent_id = ?
          AND recipient.recipient_session_id = ?
          AND message.project_id = ?
          AND owner.agent_id = recipient.recipient_agent_id
          AND (
            surface.session_id = ?
            OR (? IS NOT NULL AND owner.lineage_id = ?)
          )
        ORDER BY surface.recipient_fence DESC, surface.created_at DESC LIMIT 1`,
    )
    .get(
      messageId,
      session.agentId,
      session.id,
      session.projectId,
      session.id,
      session.lineageId,
      session.lineageId,
    ) as
    | (Record<string, unknown> & {
        session_id: string;
        session_incarnation: number;
        recipient_fence: number;
        surface_fence: number;
        state: "ACTIVE" | "AMBIGUOUS";
        owner_lineage_id: string | null;
        owner_incarnation: number;
      })
    | undefined;
  if (unresolved && unresolved.surface_fence !== unresolved.recipient_fence) {
    throw new HubError(
      "Message delivery surface was replaced by a newer recipient fence",
      409,
      "AUTHORITY_DELIVERY_RECOVERY_FENCE_CHANGED",
    );
  }
  if (unresolved) {
    const exactCurrent = unresolved.session_id === session.id;
    const exactPredecessor =
      session.lineageId !== null &&
      unresolved.owner_lineage_id === session.lineageId &&
      unresolved.owner_incarnation < (session.incarnation ?? 0);
    const recoveryTarget = exactCurrent
      ? {
          kind: "CURRENT_SESSION" as const,
          sessionId: session.id,
          sessionIncarnation: session.incarnation ?? 0,
        }
      : exactPredecessor
        ? {
            kind: "LINEAGE_HANDOFF" as const,
            sessionId: session.id,
            sessionIncarnation: session.incarnation ?? 0,
            lineageId: session.lineageId!,
          }
        : null;
    throw new HubError(
      "Message delivery surface is not confirmed",
      409,
      "AUTHORITY_DELIVERY_RECOVERY_UNCONFIRMED",
      recoveryTarget
        ? {
            permit: surfacePermitFromRow(unresolved),
            recoveredFor: recoveryTarget,
          }
        : undefined,
    );
  }
  const recovered = findConfirmedSurfaceRecovery(ctx, messageId, session);
  if (!recovered) {
    // Do not reveal whether another project, Agent, session, incarnation, or lineage owns a receipt.
    throw new NotFoundError("Confirmed message delivery", messageId);
  }
  return { permit: recovered.permit, recoveredFor: recovered.recoveredFor };
}

export function beginMessageSurface(
  ctx: StoreContext,
  principal: RequestPrincipal,
  messageId: string,
  input: { sessionId: string; idempotencyKey: string },
): { message: CrossAgentMessage; permit: MessageSurfacePermit } {
  const message = getMessage(ctx, messageId);
  assertMessageSurfacePrincipal(ctx, principal, messageId, input.sessionId);
  const cached = ctx.mutate(
    message.projectId,
    input.idempotencyKey,
    "message.surface.begin",
    ({ emit }) => {
      assertAuthorityMessageActive(ctx, messageId);
      const session = getCurrentSurfaceSession(ctx, message.projectId, input.sessionId);

      let recipient = ctx.sqlite
        .prepare(
          `SELECT * FROM message_recipients
             WHERE message_id = ? AND recipient_agent_id = ? AND recipient_session_id = ?
             ORDER BY id LIMIT 1`,
        )
        .get(messageId, session.agentId, session.id) as any;

      if (!recipient) {
        recipient = ctx.sqlite
          .prepare(
            `SELECT * FROM message_recipients
               WHERE message_id = ? AND recipient_agent_id = ?
                 AND recipient_session_id IS NULL
                 AND state NOT IN ('PROCESSED', 'RESPONDED', 'EXPIRED')
               ORDER BY id LIMIT 1`,
          )
          .get(messageId, session.agentId) as any;
      }

      if (!recipient && session.lineageId) {
        const inFlight = ctx.sqlite
          .prepare(
            `SELECT surface.*
               FROM message_surface_attempts AS surface
               JOIN message_recipients AS recipient ON recipient.id = surface.recipient_id
               JOIN agent_sessions AS owner ON owner.id = surface.session_id
              WHERE surface.message_id = ? AND recipient.recipient_agent_id = ?
                AND owner.lineage_id = ? AND surface.state IN ('ACTIVE', 'AMBIGUOUS')
              ORDER BY surface.created_at DESC LIMIT 1`,
          )
          .get(messageId, session.agentId, session.lineageId);
        if (inFlight) {
          throw new HubError(
            "A predecessor still owns an unresolved surface permit",
            409,
            "MESSAGE_SURFACE_IN_FLIGHT",
          );
        }
      }
      if (!recipient) {
        const claimedByPeer = ctx.sqlite
          .prepare(
            `SELECT 1 FROM message_recipients
              WHERE message_id = ? AND recipient_agent_id = ?
                AND recipient_session_id IS NOT NULL
              LIMIT 1`,
          )
          .get(messageId, session.agentId);
        if (claimedByPeer) {
          throw new HubError(
            "Message recipient was claimed by another session",
            409,
            "MESSAGE_RECIPIENT_CLAIMED",
          );
        }
        throw new ForbiddenError("Session is not a recipient of this message");
      }
      const confirmedRecovery = findConfirmedSurfaceRecovery(ctx, messageId, session);
      if (confirmedRecovery) {
        throw new HubError("Message was already surfaced", 409, "MESSAGE_ALREADY_SURFACED");
      }
      const surfacedByThisSession = ctx.sqlite
        .prepare(
          `SELECT 1
             FROM message_deliveries
            WHERE recipient_id = ? AND session_id = ? AND state = 'DELIVERED'
           UNION ALL
           SELECT 1
             FROM message_acks
            WHERE recipient_id = ? AND session_id = ?
           LIMIT 1`,
        )
        .get(recipient.id, session.id, recipient.id, session.id);
      if (
        ["PROCESSED", "RESPONDED", "EXPIRED"].includes(recipient.state) ||
        (["DELIVERED", "ACKNOWLEDGED"].includes(recipient.state) && surfacedByThisSession)
      ) {
        throw new HubError("Message was already surfaced", 409, "MESSAGE_ALREADY_SURFACED");
      }

      const currentPermit = ctx.sqlite
        .prepare(
          `SELECT * FROM message_surface_attempts
            WHERE recipient_id = ? AND state IN ('ACTIVE', 'AMBIGUOUS')
            ORDER BY created_at DESC LIMIT 1`,
        )
        .get(recipient.id) as any;
      if (currentPermit) {
        throw new HubError(
          "Message has an unresolved surface permit",
          409,
          "MESSAGE_SURFACE_IN_FLIGHT",
        );
      }

      if (!recipient.recipient_session_id) {
        const bound = ctx.sqlite
          .prepare(
            `UPDATE message_recipients SET recipient_session_id = ?
              WHERE id = ? AND recipient_session_id IS NULL`,
          )
          .run(session.id, recipient.id);
        if (bound.changes !== 1) {
          throw new HubError(
            "Message recipient was claimed by another session",
            409,
            "MESSAGE_RECIPIENT_CLAIMED",
          );
        }
      }
      ctx.sqlite
        .prepare("UPDATE message_recipients SET surface_fence = surface_fence + 1 WHERE id = ?")
        .run(recipient.id);
      const fencedRecipient = ctx.sqlite
        .prepare("SELECT surface_fence FROM message_recipients WHERE id = ?")
        .get(recipient.id) as { surface_fence: number };
      const permitId = createId("srf");
      const now = nowIso();
      ctx.sqlite
        .prepare(
          `INSERT INTO message_surface_attempts(
              id, message_id, recipient_id, session_id, session_incarnation, recipient_fence,
              state, error, created_at, updated_at, confirmed_at
            ) VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE', NULL, ?, ?, NULL)`,
        )
        .run(
          permitId,
          messageId,
          recipient.id,
          session.id,
          session.incarnation ?? 0,
          fencedRecipient.surface_fence,
          now,
          now,
        );
      emit({
        projectId: message.projectId,
        type: "message.surface.started",
        actorType: "agent",
        actorId: session.agentId,
        aggregateType: "message",
        aggregateId: messageId,
        causationId: permitId,
        correlationId: message.threadId,
        payload: {
          recipientId: recipient.id,
          sessionId: session.id,
          sessionIncarnation: session.incarnation ?? 0,
          recipientFence: fencedRecipient.surface_fence,
        },
      });
      const permit = ctx.sqlite
        .prepare("SELECT * FROM message_surface_attempts WHERE id = ?")
        .get(permitId);
      return {
        message: getMessage(ctx, messageId),
        permit: surfacePermitFromRow(permit),
      };
    },
    {
      requestFingerprint: `${messageId}:${input.sessionId}`,
      validateReplay: (cachedResponse) => {
        assertAuthorityMessageActive(ctx, messageId);
        getCurrentSurfaceSession(ctx, message.projectId, input.sessionId);
        const permitId = (cachedResponse as { permit?: { id?: unknown } })?.permit?.id;
        const attempt =
          typeof permitId === "string"
            ? (ctx.sqlite
                .prepare(
                  `SELECT state FROM message_surface_attempts
                    WHERE id = ? AND message_id = ? AND session_id = ?`,
                )
                .get(permitId, messageId, input.sessionId) as { state: string } | undefined)
            : undefined;
        if (!attempt) {
          throw new HubError(
            "Cached surface permit no longer matches this session",
            409,
            "SURFACE_PERMIT_INVALID",
          );
        }
        if (attempt.state !== "ACTIVE") {
          throw new HubError("Surface permit was already settled", 409, "SURFACE_PERMIT_SETTLED");
        }
      },
    },
  );
  return cached;
}

export function updateMessageSurface(
  ctx: StoreContext,
  principal: RequestPrincipal,
  messageId: string,
  attemptId: string,
  input: {
    sessionId: string;
    state: "ABORTED" | "AMBIGUOUS";
    error?: string;
    idempotencyKey: string;
  },
): { message: CrossAgentMessage; permit: MessageSurfacePermit } {
  const message = getMessage(ctx, messageId);
  assertMessageSurfacePrincipal(ctx, principal, messageId, input.sessionId);
  const cached = ctx.mutate(
    message.projectId,
    input.idempotencyKey,
    "message.surface.state",
    ({ emit }) => {
      const session = getSession(ctx, input.sessionId);
      if (session.projectId !== message.projectId) {
        throw new ForbiddenError("Session and message belong to different projects");
      }
      const attempt = ctx.sqlite
        .prepare(
          `SELECT * FROM message_surface_attempts
            WHERE id = ? AND message_id = ? AND session_id = ?`,
        )
        .get(attemptId, messageId, session.id) as any;
      if (!attempt) {
        throw new HubError(
          "Surface permit does not match this session",
          409,
          "SURFACE_PERMIT_INVALID",
        );
      }
      if (attempt.state !== "ACTIVE") {
        if (attempt.state === input.state) {
          return { permitId: attempt.id as string };
        }
        throw new HubError(
          `Surface permit is already ${String(attempt.state).toLowerCase()}`,
          409,
          "SURFACE_PERMIT_SETTLED",
        );
      }
      const now = nowIso();
      ctx.sqlite
        .prepare(
          `UPDATE message_surface_attempts
              SET state = ?, error = ?, updated_at = ?
            WHERE id = ? AND state = 'ACTIVE'`,
        )
        .run(input.state, input.error ?? null, now, attemptId);
      if (input.state === "ABORTED") {
        const pendingReservations = ctx.sqlite
          .prepare(
            `SELECT id, principal_id, credential_id, rpc_method
             FROM synthetic_prompt_reservations
             WHERE surface_attempt_id = ? AND injector_hub_session_id = ?
               AND recipient_fence = ? AND state = 'PREPARED'`,
          )
          .all(attemptId, session.id, attempt.recipient_fence) as Array<{
          id: string;
          principal_id: string;
          credential_id: string;
          rpc_method: string;
        }>;
        for (const reservation of pendingReservations) {
          const abortReason = input.error ?? "message surface aborted before app-server acceptance";
          const abortIdempotencyKey = `surface:${attemptId}:${reservation.id}`;
          const abortRequestSha256 = mutationFingerprint({
            source: "message.surface.aborted",
            messageId,
            surfaceAttemptId: attemptId,
            reservationId: reservation.id,
            sessionId: session.id,
            recipientFence: attempt.recipient_fence,
            reason: abortReason,
          });
          ctx.sqlite
            .prepare(
              `UPDATE synthetic_prompt_reservations
               SET state = 'ABORTED', aborted_at = ?, abort_reason = ?,
                   abort_idempotency_key = ?, abort_request_sha256 = ?
               WHERE id = ? AND state = 'PREPARED'`,
            )
            .run(now, abortReason, abortIdempotencyKey, abortRequestSha256, reservation.id);
          emit({
            projectId: message.projectId,
            type: "synthetic_prompt.aborted",
            actorType: "system",
            actorId: reservation.principal_id,
            aggregateType: "synthetic_prompt_reservation",
            aggregateId: reservation.id,
            causationId: attemptId,
            correlationId: message.threadId,
            payload: {
              sourceMessageId: messageId,
              surfaceAttemptId: attemptId,
              recipientFence: attempt.recipient_fence,
              rpcMethod: reservation.rpc_method,
              reason: abortReason,
            },
          });
        }
      }
      let releasedToSessionId: string | null = null;
      if (input.state === "ABORTED" && session.lineageId) {
        const head = ctx.sqlite
          .prepare("SELECT head_session_id FROM session_lineages WHERE id = ?")
          .get(session.lineageId) as { head_session_id: string | null } | undefined;
        if (head?.head_session_id && head.head_session_id !== session.id) {
          const released = ctx.sqlite
            .prepare(
              `UPDATE message_recipients SET recipient_session_id = ?
                WHERE id = ? AND recipient_session_id = ?`,
            )
            .run(head.head_session_id, attempt.recipient_id, session.id);
          if (released.changes === 1) releasedToSessionId = head.head_session_id;
        }
      }
      emit({
        projectId: message.projectId,
        type: `message.surface.${input.state.toLowerCase()}`,
        actorType: "agent",
        actorId: session.agentId,
        aggregateType: "message",
        aggregateId: messageId,
        causationId: attemptId,
        correlationId: message.threadId,
        payload: {
          recipientId: attempt.recipient_id,
          sessionId: session.id,
          recipientFence: attempt.recipient_fence,
          error: input.error ?? null,
        },
      });
      if (releasedToSessionId) {
        emit({
          projectId: message.projectId,
          type: "message.surface.released",
          actorType: "agent",
          actorId: session.agentId,
          aggregateType: "message",
          aggregateId: messageId,
          causationId: attemptId,
          correlationId: message.threadId,
          payload: {
            recipientId: attempt.recipient_id,
            predecessorSessionId: session.id,
            successorSessionId: releasedToSessionId,
            recipientFence: attempt.recipient_fence,
          },
        });
      }
      const permit = ctx.sqlite
        .prepare("SELECT * FROM message_surface_attempts WHERE id = ?")
        .get(attemptId);
      return { permitId: (permit as { id: string }).id };
    },
    {
      requestFingerprint: `${messageId}:${attemptId}:${input.sessionId}:${input.state}`,
    },
  );
  const permit = ctx.sqlite
    .prepare("SELECT * FROM message_surface_attempts WHERE id = ?")
    .get(cached.permitId);
  if (!permit) throw new HubError("Surface permit no longer exists", 409, "SURFACE_PERMIT_INVALID");
  return { message: getMessage(ctx, messageId), permit: surfacePermitFromRow(permit) };
}

/**
 * Confirms an ordinary predecessor surface only after the current Adapter has independently found
 * the exact message marker in its bound external thread. The Hub cannot inspect Codex, so this is
 * the same authenticated Adapter assertion as `/delivered`, narrowed to one immutable ambiguous
 * permit, recipient fence, project/thread, and logical session lineage. Signed authority is
 * deliberately excluded: it keeps the stricter confirmed-receipt recovery contract.
 */
export function reconcileOrdinaryMessageSurface(
  ctx: StoreContext,
  principal: RequestPrincipal,
  messageId: string,
  attemptId: string,
  input: {
    sessionId: string;
    recipientFence: number;
    externalThreadId: string;
    idempotencyKey: string;
  },
): CrossAgentMessage {
  const message = getMessage(ctx, messageId);
  assertMessageSurfacePrincipal(ctx, principal, messageId, input.sessionId);
  const directiveLink = ctx.sqlite
    .prepare("SELECT 1 FROM message_directive_links WHERE message_id = ?")
    .get(messageId);
  if (directiveLink) {
    throw new HubError(
      "Authority-linked ambiguity requires the signed recovery path",
      409,
      "AUTHORITY_SURFACE_PERMIT_REQUIRED",
    );
  }
  const cached = ctx.mutate(
    message.projectId,
    input.idempotencyKey,
    "message.surface.reconcile_ordinary",
    ({ emit }) => {
      const session = getCurrentSurfaceSession(ctx, message.projectId, input.sessionId);
      const attempt = ctx.sqlite
        .prepare(
          `SELECT surface.*, recipient.surface_fence,
                  recipient.recipient_agent_id, recipient.recipient_session_id,
                  recipient.state AS recipient_state, recipient.attempt_count,
                  owner.project_id AS owner_project_id, owner.agent_id AS owner_agent_id,
                  owner.lineage_id AS owner_lineage_id, owner.incarnation AS owner_incarnation,
                  owner.external_thread_id AS owner_external_thread_id,
                  stored_message.thread_id
             FROM message_surface_attempts AS surface
             JOIN message_recipients AS recipient ON recipient.id = surface.recipient_id
             JOIN agent_sessions AS owner ON owner.id = surface.session_id
             JOIN messages AS stored_message ON stored_message.id = surface.message_id
            WHERE surface.id = ? AND surface.message_id = ?`,
        )
        .get(attemptId, messageId) as
        | {
            id: string;
            recipient_id: string;
            session_id: string;
            session_incarnation: number;
            recipient_fence: number;
            state: string;
            surface_fence: number;
            recipient_agent_id: string;
            recipient_session_id: string | null;
            recipient_state: string;
            attempt_count: number;
            owner_project_id: string;
            owner_agent_id: string;
            owner_lineage_id: string | null;
            owner_incarnation: number;
            owner_external_thread_id: string | null;
            thread_id: string;
          }
        | undefined;
      const sameSession = attempt?.session_id === session.id;
      const exactPredecessor =
        attempt &&
        session.lineageId !== null &&
        attempt.owner_lineage_id === session.lineageId &&
        attempt.owner_incarnation < (session.incarnation ?? 0);
      if (
        !attempt ||
        attempt.state !== "AMBIGUOUS" ||
        attempt.owner_project_id !== message.projectId ||
        attempt.owner_agent_id !== session.agentId ||
        attempt.recipient_agent_id !== session.agentId ||
        attempt.recipient_session_id !== session.id ||
        attempt.session_incarnation !== attempt.owner_incarnation ||
        attempt.recipient_fence !== input.recipientFence ||
        attempt.surface_fence !== input.recipientFence ||
        session.externalThreadId !== input.externalThreadId ||
        attempt.owner_external_thread_id !== input.externalThreadId ||
        (!sameSession && !exactPredecessor) ||
        !["PENDING", "FAILED", "DELIVERED", "ACKNOWLEDGED"].includes(attempt.recipient_state)
      ) {
        throw new HubError(
          "Ambiguous surface does not match the current logical recipient",
          409,
          "MESSAGE_SURFACE_RECONCILIATION_INVALID",
        );
      }
      const now = nowIso();
      const settled = ctx.sqlite
        .prepare(
          `UPDATE message_surface_attempts
              SET state = 'CONFIRMED', error = NULL, updated_at = ?, confirmed_at = ?
            WHERE id = ? AND message_id = ? AND recipient_id = ?
              AND recipient_fence = ? AND state = 'AMBIGUOUS'`,
        )
        .run(now, now, attempt.id, messageId, attempt.recipient_id, input.recipientFence);
      if (settled.changes !== 1) {
        throw new HubError(
          "Ambiguous surface changed during reconciliation",
          409,
          "MESSAGE_SURFACE_RECONCILIATION_INVALID",
        );
      }
      ctx.sqlite
        .prepare(
          `UPDATE message_recipients
              SET state = CASE
                    WHEN state IN ('PENDING', 'FAILED') THEN 'DELIVERED'
                    ELSE state
                  END,
                  delivered_at = COALESCE(delivered_at, ?),
                  attempt_count = attempt_count + 1,
                  last_error = NULL
            WHERE id = ? AND recipient_session_id = ? AND surface_fence = ?`,
        )
        .run(now, attempt.recipient_id, session.id, input.recipientFence);
      ctx.sqlite
        .prepare(
          `INSERT INTO message_deliveries(
              id, recipient_id, session_id, transport, attempt, state, error,
              created_at, completed_at
            ) VALUES (?, ?, ?, 'app_server_push', ?, 'DELIVERED', NULL, ?, ?)`,
        )
        .run(
          createId("dlv"),
          attempt.recipient_id,
          attempt.session_id,
          attempt.attempt_count + 1,
          now,
          now,
        );
      const evidence = {
        recipientId: attempt.recipient_id,
        sessionId: attempt.session_id,
        surfaceAttemptId: attempt.id,
        recipientFence: input.recipientFence,
        reconciledBySessionId: session.id,
        externalThreadId: input.externalThreadId,
      };
      emit({
        projectId: message.projectId,
        type: "message.surface.reconciled",
        actorType: "agent",
        actorId: session.agentId,
        aggregateType: "message",
        aggregateId: messageId,
        causationId: attempt.id,
        correlationId: message.threadId,
        payload: evidence,
      });
      emit({
        projectId: message.projectId,
        type: "message.delivered",
        actorType: "agent",
        actorId: session.agentId,
        aggregateType: "message",
        aggregateId: messageId,
        causationId: attempt.id,
        correlationId: message.threadId,
        payload: evidence,
      });
      return { messageId };
    },
    {
      requestFingerprint: `${messageId}:${attemptId}:${input.sessionId}:${input.recipientFence}:${input.externalThreadId}`,
      validateReplay: () => {
        getCurrentSurfaceSession(ctx, message.projectId, input.sessionId);
        const exact = ctx.sqlite
          .prepare(
            `SELECT 1 FROM message_surface_attempts AS surface
             JOIN message_recipients AS recipient ON recipient.id = surface.recipient_id
             WHERE surface.id = ? AND surface.message_id = ? AND surface.state = 'CONFIRMED'
               AND surface.recipient_fence = ? AND recipient.surface_fence = ?
               AND recipient.recipient_session_id = ?
               AND recipient.state IN ('DELIVERED', 'ACKNOWLEDGED', 'PROCESSED', 'RESPONDED')`,
          )
          .get(attemptId, messageId, input.recipientFence, input.recipientFence, input.sessionId);
        if (!exact) {
          throw new HubError(
            "Reconciled surface no longer matches the current recipient",
            409,
            "MESSAGE_SURFACE_RECONCILIATION_INVALID",
          );
        }
      },
    },
  );
  return getMessage(ctx, cached.messageId);
}

export function updateMessageState(
  ctx: StoreContext,
  principal: RequestPrincipal,
  messageId: string,
  input: {
    sessionId: string;
    state: "DELIVERED" | "ACKNOWLEDGED" | "PROCESSED" | "RESPONDED" | "FAILED";
    error?: string;
    surfaceAttemptId?: string;
    recipientFence?: number;
    idempotencyKey: string;
    transport?: string;
  },
): CrossAgentMessage {
  const message = getMessage(ctx, messageId);
  assertMessageSurfacePrincipal(
    ctx,
    principal,
    messageId,
    input.sessionId,
    ["ACKNOWLEDGED", "PROCESSED", "RESPONDED"].includes(input.state)
      ? "MODEL_RECEIPT"
      : "TRANSPORT",
  );
  const directiveLink = ctx.sqlite
    .prepare(
      `SELECT link.directive_id, directive.correlation_id, directive.expires_at
       FROM message_directive_links link
       JOIN authority_directives directive ON directive.id = link.directive_id
       WHERE link.message_id = ?`,
    )
    .get(messageId) as
    { directive_id: string; correlation_id: string; expires_at: string | null } | undefined;
  if (directiveLink) materializeDirectiveExpiryById(ctx, directiveLink.directive_id);
  if (input.surfaceAttemptId && input.state === "FAILED") {
    throw new HubError(
      "A failed delivery cannot confirm a surface permit; abort or mark the surface ambiguous instead",
      409,
      "SURFACE_PERMIT_INVALID",
    );
  }
  const cached = ctx.mutate(
    message.projectId,
    input.idempotencyKey,
    "message.state",
    ({ emit }) => {
      // Message state may finish in flight after close. Once registerSession rebinds an unresolved
      // recipient, the predecessor no longer matches this query and cannot mutate it.
      const session = getSession(ctx, input.sessionId);
      if (session.projectId !== message.projectId) {
        throw new ForbiddenError("Session and message belong to different projects");
      }
      if ((input.surfaceAttemptId === undefined) !== (input.recipientFence === undefined)) {
        throw new HubError(
          "surfaceAttemptId and recipientFence must be provided together",
          422,
          "SURFACE_PERMIT_INVALID",
        );
      }
      if (
        directiveLink &&
        ["DELIVERED", "ACKNOWLEDGED", "PROCESSED", "RESPONDED"].includes(input.state) &&
        (!input.surfaceAttemptId || input.recipientFence === undefined)
      ) {
        throw new HubError(
          "Authority-linked message state requires the exact surface attempt and recipient fence",
          409,
          "AUTHORITY_SURFACE_PERMIT_REQUIRED",
        );
      }
      if (
        directiveLink &&
        ["DELIVERED", "ACKNOWLEDGED", "PROCESSED", "RESPONDED"].includes(input.state)
      ) {
        const terminal = ctx.sqlite
          .prepare(
            `SELECT event_type, server_sequence FROM authority_events
             WHERE directive_id = ?
               AND event_type IN ('SUPERSEDED', 'REVOKED', 'COMPLETED', 'EXPIRED')
             LIMIT 1`,
          )
          .get(directiveLink.directive_id) as
          { event_type: string; server_sequence: number } | undefined;
        const isPostTerminalReceipt =
          terminal &&
          ["ACKNOWLEDGED", "PROCESSED", "RESPONDED"].includes(input.state) &&
          ctx.sqlite
            .prepare(
              `SELECT 1 FROM authority_events delivered
               JOIN message_surface_attempts surface
                 ON surface.id = ? AND surface.message_id = ? AND surface.state = 'CONFIRMED'
               WHERE delivered.directive_id = ? AND delivered.event_type = 'DELIVERED'
                 AND delivered.target_agent_id = ?
                 AND delivered.actor_session_id = surface.session_id
                 AND delivered.server_sequence < ?
                 AND json_extract(delivered.payload_json, '$.surfaceAttemptId') = ?
                 AND json_extract(delivered.payload_json, '$.recipientFence') = ?`,
            )
            .get(
              input.surfaceAttemptId,
              messageId,
              directiveLink.directive_id,
              session.agentId,
              terminal?.server_sequence,
              input.surfaceAttemptId,
              input.recipientFence,
            );
        if (
          !isPostTerminalReceipt &&
          (terminal || (directiveLink.expires_at && directiveLink.expires_at <= nowIso()))
        ) {
          throw new HubError("Authority directive is no longer active", 409, "DIRECTIVE_INACTIVE");
        }
      }
      let surfaceAttempt = input.surfaceAttemptId
        ? (ctx.sqlite
            .prepare(
              `SELECT * FROM message_surface_attempts
              WHERE id = ? AND message_id = ? AND session_id = ? AND recipient_fence = ?
                AND state IN ('ACTIVE', 'AMBIGUOUS', 'CONFIRMED')`,
            )
            .get(input.surfaceAttemptId, messageId, session.id, input.recipientFence) as any)
        : undefined;
      if (input.surfaceAttemptId && !surfaceAttempt) {
        const recovered = findConfirmedSurfaceRecovery(ctx, messageId, session);
        if (
          recovered?.permit.id === input.surfaceAttemptId &&
          recovered.permit.recipientFence === input.recipientFence
        ) {
          surfaceAttempt = recovered.row;
        }
      }
      if (
        surfaceAttempt &&
        input.state !== "DELIVERED" &&
        !directiveLink &&
        surfaceAttempt.state !== "CONFIRMED"
      ) {
        throw new HubError(
          "Only a confirmed surface permit can carry a downstream message receipt",
          422,
          "SURFACE_PERMIT_INVALID",
        );
      }
      if (input.surfaceAttemptId && !surfaceAttempt) {
        throw new HubError(
          "Surface permit does not match this session, message, and fence",
          409,
          "SURFACE_PERMIT_INVALID",
        );
      }
      let recipient = surfaceAttempt
        ? (ctx.sqlite
            .prepare("SELECT * FROM message_recipients WHERE id = ?")
            .get(surfaceAttempt.recipient_id) as any)
        : (ctx.sqlite
            .prepare(
              `SELECT * FROM message_recipients
               WHERE message_id = ? AND recipient_agent_id = ?
                 AND recipient_session_id = ?
               ORDER BY id LIMIT 1`,
            )
            .get(messageId, session.agentId, session.id) as any);
      if (recipient && recipient.recipient_agent_id !== session.agentId) {
        throw new ForbiddenError("Session is not a recipient of this message");
      }
      if (recipient && recipient.recipient_session_id !== session.id) {
        throw new ForbiddenError("Session is not the current recipient of this message");
      }
      if (surfaceAttempt?.state === "CONFIRMED" && input.state === "DELIVERED") {
        // The exact attempt/fence is semantic idempotency even under a fresh HTTP key. Downstream ACK
        // may have confirmed it before the Bridge's delayed DELIVERED callback arrived.
        return { messageId };
      }
      if (!recipient) {
        // The compatibility path may bind a legacy agent-wide recipient, but it is still a new claim:
        // a CLOSED predecessor cannot use /delivered to bypass the explicit claim gate.
        recipient = ctx.sqlite
          .prepare(
            `SELECT * FROM message_recipients
             WHERE message_id = ? AND recipient_agent_id = ?
               AND recipient_session_id IS NULL
             ORDER BY id LIMIT 1`,
          )
          .get(messageId, session.agentId) as any;
        if (recipient) getOpenSession(ctx, input.sessionId);
      }
      if (!recipient) throw new ForbiddenError("Session is not a recipient of this message");
      if (
        !surfaceAttempt &&
        ["DELIVERED", "ACKNOWLEDGED", "PROCESSED", "RESPONDED"].includes(input.state)
      ) {
        const predecessorPermit = ctx.sqlite
          .prepare(
            `SELECT 1 FROM message_surface_attempts
              WHERE recipient_id = ? AND session_id <> ?
                AND state IN ('ACTIVE', 'AMBIGUOUS')
              LIMIT 1`,
          )
          .get(recipient.id, session.id);
        if (predecessorPermit) {
          throw new HubError(
            "A predecessor still owns an unresolved surface permit",
            409,
            "MESSAGE_SURFACE_IN_FLIGHT",
          );
        }
      }
      const authorityEventType = directiveLink
        ? (
            {
              DELIVERED: "DELIVERED",
              ACKNOWLEDGED: "ACKNOWLEDGED",
              PROCESSED: "PROCESSED",
            } as const
          )[input.state as "DELIVERED" | "ACKNOWLEDGED" | "PROCESSED"]
        : undefined;
      let authorityLifecycle: string | undefined;
      const appendAuthorityReceiptEvent = (
        eventType: "DELIVERED" | "ACKNOWLEDGED" | "PROCESSED",
      ) => {
        if (!directiveLink || !surfaceAttempt) {
          throw new HubError(
            "Authority receipt requires an exact surface attempt",
            409,
            "AUTHORITY_SURFACE_PERMIT_REQUIRED",
          );
        }
        authorityLifecycle ??=
          (
            ctx.sqlite
              .prepare(
                `SELECT event_type FROM authority_events
               WHERE directive_id = ?
                 AND event_type IN ('SUPERSEDED', 'REVOKED', 'COMPLETED', 'EXPIRED')
               ORDER BY server_sequence DESC LIMIT 1`,
              )
              .get(directiveLink.directive_id) as { event_type: string } | undefined
          )?.event_type ?? "ACTIVE";
        const authorityPayload = {
          carrierMessageId: messageId,
          targetAgentId: session.agentId,
          sessionId: session.id,
          surfaceAttemptId: surfaceAttempt.id,
          recipientFence: surfaceAttempt.recipient_fence,
        };
        const authorityEvent = emit({
          projectId: message.projectId,
          type: `directive.${eventType.toLowerCase()}`,
          actorType: "agent",
          actorId: session.agentId,
          aggregateType: "authority_directive",
          aggregateId: directiveLink.directive_id,
          causationId: messageId,
          correlationId: directiveLink.correlation_id,
          payload: authorityPayload,
        });
        ctx.sqlite
          .prepare(
            `INSERT INTO authority_events(
               id, project_id, directive_id, event_type, actor_principal_id, actor_session_id,
               target_agent_id, server_sequence, event_id, from_lifecycle, to_lifecycle,
               causation_id, correlation_id, payload_json, created_at
             ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            createId("aev"),
            message.projectId,
            directiveLink.directive_id,
            eventType,
            session.id,
            session.agentId,
            authorityEvent.sequence,
            authorityEvent.id,
            authorityLifecycle,
            authorityLifecycle,
            messageId,
            directiveLink.correlation_id,
            JSON.stringify(authorityPayload),
            authorityEvent.createdAt,
          );
      };
      if (authorityEventType) {
        const existing = ctx.sqlite
          .prepare(
            `SELECT 1 FROM authority_events
             WHERE directive_id = ? AND target_agent_id = ? AND event_type = ?`,
          )
          .get(directiveLink!.directive_id, session.agentId, authorityEventType);
        if (existing) return { messageId };
      }
      if (input.state === "DELIVERED" && !surfaceAttempt) {
        const unresolvedPermit = ctx.sqlite
          .prepare(
            `SELECT 1 FROM message_surface_attempts
            WHERE recipient_id = ? AND state IN ('ACTIVE', 'AMBIGUOUS')
            LIMIT 1`,
          )
          .get(recipient.id);
        if (unresolvedPermit) {
          throw new HubError(
            "An unresolved surface permit must be confirmed explicitly",
            409,
            "SURFACE_PERMIT_REQUIRED",
          );
        }
      }
      // Legacy adapters may still report delivery without the explicit pre-push claim. Bind on the
      // first state transition as a defensive backstop, while adapters migrate to claiming before
      // they surface anything to a user.
      if (!recipient.recipient_session_id) {
        const bound = ctx.sqlite
          .prepare(
            `UPDATE message_recipients SET recipient_session_id = ?
             WHERE id = ? AND recipient_session_id IS NULL`,
          )
          .run(session.id, recipient.id);
        if (bound.changes !== 1) {
          throw new HubError(
            "Message recipient was claimed by another session",
            409,
            "MESSAGE_RECIPIENT_CLAIMED",
          );
        }
        recipient.recipient_session_id = session.id;
      }
      if (!surfaceAttempt && ["ACKNOWLEDGED", "PROCESSED", "RESPONDED"].includes(input.state)) {
        // A downstream acknowledgement is stronger evidence than a Bridge-side poll: Codex could not
        // acknowledge work that never crossed the app-server Seam. Settle the owning attempt here so
        // a lost AMBIGUOUS write cannot leave the recipient pinned forever.
        surfaceAttempt = ctx.sqlite
          .prepare(
            `SELECT * FROM message_surface_attempts
            WHERE recipient_id = ? AND session_id = ?
              AND state IN ('ACTIVE', 'AMBIGUOUS')
            ORDER BY created_at DESC LIMIT 1`,
          )
          .get(recipient.id, session.id) as any;
      }
      const order = ["PENDING", "DELIVERED", "ACKNOWLEDGED", "PROCESSED", "RESPONDED"];
      const currentIndex = order.indexOf(recipient.state);
      const nextIndex = order.indexOf(input.state);
      if (
        input.state === "FAILED" &&
        ["DELIVERED", "ACKNOWLEDGED", "PROCESSED", "RESPONDED", "EXPIRED"].includes(recipient.state)
      ) {
        return { messageId };
      }
      const regressiveState =
        input.state !== "FAILED" && nextIndex >= 0 && currentIndex >= 0 && nextIndex < currentIndex;
      if (regressiveState && !surfaceAttempt) {
        return { messageId };
      }
      const timestampColumn: Record<string, string> = {
        DELIVERED: "delivered_at",
        ACKNOWLEDGED: "acknowledged_at",
        PROCESSED: "processed_at",
        RESPONDED: "responded_at",
      };
      const now = nowIso();
      const column = timestampColumn[input.state];
      if (!regressiveState) {
        ctx.sqlite
          .prepare(
            `UPDATE message_recipients SET state = ?,
               ${column ? `${column} = ?,` : ""}
               attempt_count = attempt_count + ?,
               last_error = ? WHERE id = ?`,
          )
          .run(
            input.state,
            ...(column ? [now] : []),
            input.state === "FAILED" || (input.state === "DELIVERED" && !surfaceAttempt) ? 1 : 0,
            input.error ?? null,
            recipient.id,
          );
      }
      const confirmsSurface =
        surfaceAttempt && ["ACTIVE", "AMBIGUOUS"].includes(surfaceAttempt.state);
      if (confirmsSurface) {
        const settled = ctx.sqlite
          .prepare(
            `UPDATE message_surface_attempts
              SET state = 'CONFIRMED', error = NULL, updated_at = ?, confirmed_at = ?
            WHERE id = ? AND state IN ('ACTIVE', 'AMBIGUOUS')`,
          )
          .run(now, now, surfaceAttempt.id);
        if (settled.changes !== 1) {
          throw new HubError("Surface permit was already settled", 409, "SURFACE_PERMIT_SETTLED");
        }
        ctx.sqlite
          .prepare(
            `UPDATE message_recipients
              SET delivered_at = COALESCE(delivered_at, ?),
                  attempt_count = attempt_count + 1
            WHERE id = ?`,
          )
          .run(now, recipient.id);
        if (session.lineageId) {
          const head = ctx.sqlite
            .prepare("SELECT head_session_id FROM session_lineages WHERE id = ?")
            .get(session.lineageId) as { head_session_id: string | null } | undefined;
          if (head?.head_session_id && head.head_session_id !== session.id) {
            ctx.sqlite
              .prepare(
                `UPDATE message_recipients SET recipient_session_id = ?
                WHERE id = ? AND recipient_session_id = ?`,
              )
              .run(head.head_session_id, recipient.id, session.id);
          }
        }
        ctx.sqlite
          .prepare(
            `INSERT INTO message_deliveries(
              id, recipient_id, session_id, transport, attempt, state, error,
              created_at, completed_at
            ) VALUES (?, ?, ?, ?, ?, 'DELIVERED', NULL, ?, ?)`,
          )
          .run(
            createId("dlv"),
            recipient.id,
            session.id,
            input.transport ?? session.deliveryMode,
            recipient.attempt_count + 1,
            now,
            now,
          );
      }
      if (input.state === "FAILED" || (input.state === "DELIVERED" && !surfaceAttempt)) {
        ctx.sqlite
          .prepare(
            `INSERT INTO message_deliveries(
                id, recipient_id, session_id, transport, attempt, state, error,
                created_at, completed_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            createId("dlv"),
            recipient.id,
            session.id,
            input.transport ?? session.deliveryMode,
            recipient.attempt_count + 1,
            input.state,
            input.error ?? null,
            now,
            now,
          );
      }
      if (["ACKNOWLEDGED", "PROCESSED", "RESPONDED"].includes(input.state)) {
        ctx.sqlite
          .prepare(
            `INSERT OR IGNORE INTO message_acks(
                id, message_id, recipient_id, session_id, ack_type, created_at
              ) VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(createId("ack"), messageId, recipient.id, session.id, input.state, now);
      }
      if (input.state === "RESPONDED") {
        ctx.sqlite
          .prepare(
            `UPDATE threads SET waiting_for_agent_id = NULL, version = version + 1,
               updated_at = ? WHERE id = ?`,
          )
          .run(now, message.threadId);
      }
      if (
        directiveLink &&
        ["ACKNOWLEDGED", "PROCESSED", "RESPONDED"].includes(input.state) &&
        confirmsSurface
      ) {
        const delivered = ctx.sqlite
          .prepare(
            `SELECT 1 FROM authority_events
             WHERE directive_id = ? AND target_agent_id = ? AND event_type = 'DELIVERED'`,
          )
          .get(directiveLink.directive_id, session.agentId);
        if (!delivered) appendAuthorityReceiptEvent("DELIVERED");
      }
      emit({
        projectId: message.projectId,
        type: `message.${input.state.toLowerCase()}`,
        actorType: "agent",
        actorId: session.agentId,
        aggregateType: "message",
        aggregateId: messageId,
        causationId: null,
        correlationId: message.threadId,
        payload: {
          recipientId: recipient.id,
          sessionId: session.id,
          surfaceAttemptId: surfaceAttempt?.id ?? null,
          recipientFence: surfaceAttempt?.recipient_fence ?? null,
          error: input.error,
        },
      });
      if (directiveLink && authorityEventType) {
        appendAuthorityReceiptEvent(authorityEventType);
      }
      return { messageId };
    },
    {
      requestFingerprint: `${messageId}:${input.sessionId}:${input.state}:${input.surfaceAttemptId ?? "legacy"}:${input.recipientFence ?? "none"}`,
    },
  );
  return getMessage(ctx, cached.messageId);
}

export function getThread(
  ctx: StoreContext,
  threadId: string,
  principal?: RequestPrincipal,
): {
  thread: Thread;
  messages: CrossAgentMessage[];
  decisions: any[];
} {
  const row = ctx.sqlite.prepare("SELECT * FROM threads WHERE id = ?").get(threadId);
  if (!row) throw new NotFoundError("Thread", threadId);
  const reader = principal
    ? assertMessageReadPrincipal(ctx, principal, (row as any).project_id)
    : null;
  const messages = (
    ctx.sqlite
      .prepare("SELECT * FROM messages WHERE thread_id = ? ORDER BY sequence")
      .all(threadId) as any[]
  )
    .map((message) => {
      const recipients = ctx.sqlite
        .prepare("SELECT * FROM message_recipients WHERE message_id = ?")
        .all(message.id) as any[];
      return canReadMessageRow(message, recipients, reader)
        ? messageFromRow(message, visibleMessageRecipients(recipients, reader))
        : null;
    })
    .filter((message): message is CrossAgentMessage => message !== null);
  if (reader && messages.length === 0) throw new NotFoundError("Thread", threadId);
  return {
    thread: threadFromRow(row),
    messages,
    decisions: ctx.sqlite
      .prepare("SELECT * FROM decisions WHERE thread_id = ? ORDER BY created_at")
      .all(threadId),
  };
}

export function resolveThread(
  ctx: StoreContext,
  principal: RequestPrincipal,
  threadId: string,
  input: {
    expectedVersion: number;
    status: "RESOLVED" | "NEEDS_USER" | "ARCHIVED";
    idempotencyKey: string;
  },
): Thread {
  const current = getThread(ctx, threadId).thread;
  const actor = resolveMutationActor(ctx, principal, current.projectId);
  return ctx.mutate(
    current.projectId,
    input.idempotencyKey,
    "thread.resolve",
    ({ emit }) => {
      const next = getThread(ctx, threadId).thread;
      if (next.version !== input.expectedVersion) {
        throw new ConflictError("Thread version changed", next);
      }
      ctx.sqlite
        .prepare(
          `UPDATE threads SET status = ?, waiting_for_agent_id = NULL,
           version = version + 1, updated_at = ? WHERE id = ?`,
        )
        .run(input.status, nowIso(), threadId);
      emit({
        projectId: current.projectId,
        type: "thread.status.changed",
        actorType: actor.actorType,
        actorId: actor.actorId,
        aggregateType: "thread",
        aggregateId: threadId,
        causationId: null,
        correlationId: threadId,
        payload: { previousStatus: current.status, status: input.status },
      });
      return getThread(ctx, threadId).thread;
    },
    mutationOptions(actor, { threadId, ...input, idempotencyKey: undefined }),
  );
}
