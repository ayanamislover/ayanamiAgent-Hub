// ---------------------------------------------------------------------------------------
// Capability authorization
//
// An agent relaying "the user approved this" is not evidence, so a capability that needs the
// user's consent is represented as a row the user decides on in the Dashboard. Note the honest
// decision route is restricted to a scoped Dashboard principal. The event remains append-only so
// revocation and expiry retain their complete provenance rather than rewriting the original grant.
// ---------------------------------------------------------------------------------------

import {
  createId,
  nowIso,
  type AuthorizationCapability,
  type AuthorizationGrant,
} from "@crossagent/protocol";
import { ConflictError, ForbiddenError, NotFoundError } from "../../domain/errors.js";
import type { RequestPrincipal } from "../../security/local-auth.js";
import type { StoreContext } from "./context.js";
import { mutationOptions, resolveMutationActor } from "./mutation-authority.js";

function authorizationFromRow(row: any): AuthorizationGrant {
  return {
    id: row.id,
    projectId: row.project_id,
    capability: row.capability,
    status: row.status,
    reason: row.reason,
    detail: JSON.parse(row.detail_json ?? "{}"),
    requestedByAgentId: row.requested_by_agent_id,
    requestedBySessionId: row.requested_by_session_id ?? null,
    decidedBy: row.decided_by ?? null,
    decidedVia: row.decided_via ?? null,
    decidedAt: row.decided_at ?? null,
    decisionNote: row.decision_note ?? null,
    expiresAt: row.expires_at ?? null,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function findActiveGrant(
  ctx: StoreContext,
  projectId: string,
  capability: AuthorizationCapability,
): AuthorizationGrant | undefined {
  const row = ctx.sqlite
    .prepare(
      `SELECT * FROM authorization_grants
           WHERE project_id = ? AND capability = ? AND status IN ('PENDING', 'GRANTED')
           ORDER BY created_at DESC LIMIT 1`,
    )
    .get(projectId, capability) as Record<string, unknown> | undefined;
  return row ? authorizationFromRow(row) : undefined;
}

function expireAuthorizations(ctx: StoreContext, projectId: string): void {
  ctx.sqlite
    .prepare(
      `UPDATE authorization_grants SET status = 'EXPIRED', version = version + 1, updated_at = ?
           WHERE project_id = ? AND status = 'GRANTED'
             AND expires_at IS NOT NULL AND expires_at <= ?`,
    )
    .run(nowIso(), projectId, nowIso());
}

export function requestAuthorization(
  ctx: StoreContext,
  principal: RequestPrincipal,
  projectId: string,
  input: {
    capability: AuthorizationCapability;
    reason: string;
    detail: Record<string, unknown>;
    requestedByAgentId: string;
    requestedBySessionId?: string;
    idempotencyKey: string;
  },
): AuthorizationGrant {
  if (principal.kind === "DASHBOARD_USER" && input.requestedBySessionId) {
    throw new ForbiddenError("Dashboard authorization requests cannot claim an Agent session");
  }
  const actor = resolveMutationActor(
    ctx,
    principal,
    projectId,
    input.requestedBySessionId,
    principal.kind === "AGENT" ? input.requestedByAgentId : undefined,
  );
  const requester =
    actor.actorType === "user"
      ? { requestedByAgentId: "local-user", requestedBySessionId: undefined }
      : {
          requestedByAgentId: actor.actorId,
          requestedBySessionId: actor.sessionId ?? undefined,
        };
  return ctx.mutate(
    projectId,
    input.idempotencyKey,
    "authorization.request",
    ({ emit }) => {
      const existing = findActiveGrant(ctx, projectId, input.capability);
      if (existing) return existing;
      const id = createId("aut");
      const now = nowIso();
      ctx.sqlite
        .prepare(
          `INSERT INTO authorization_grants(
             id, project_id, capability, status, reason, detail_json,
             requested_by_agent_id, requested_by_session_id, version, created_at, updated_at
           ) VALUES (?, ?, ?, 'PENDING', ?, ?, ?, ?, 0, ?, ?)`,
        )
        .run(
          id,
          projectId,
          input.capability,
          input.reason,
          JSON.stringify(input.detail ?? {}),
          requester.requestedByAgentId,
          requester.requestedBySessionId ?? null,
          now,
          now,
        );
      emit({
        projectId,
        type: "authorization.requested",
        actorType: actor.actorType,
        actorId: actor.actorId,
        aggregateType: "authorization",
        aggregateId: id,
        causationId: null,
        correlationId: null,
        payload: { capability: input.capability, reason: input.reason },
      });
      return getAuthorization(ctx, id);
    },
    mutationOptions(actor, { projectId, ...input, idempotencyKey: undefined }),
  );
}

export function getAuthorization(ctx: StoreContext, id: string): AuthorizationGrant {
  const row = ctx.sqlite.prepare("SELECT * FROM authorization_grants WHERE id = ?").get(id) as
    Record<string, unknown> | undefined;
  if (!row) throw new NotFoundError("Authorization", id);
  return authorizationFromRow(row);
}

export function listAuthorizations(
  ctx: StoreContext,
  projectId: string,
  filters: { status?: string } = {},
): AuthorizationGrant[] {
  expireAuthorizations(ctx, projectId);
  const rows = ctx.sqlite
    .prepare(
      `SELECT * FROM authorization_grants
           WHERE project_id = ? AND (? IS NULL OR status = ?)
           ORDER BY created_at DESC`,
    )
    .all(projectId, filters.status ?? null, filters.status ?? null) as Record<string, unknown>[];
  return rows.map(authorizationFromRow);
}

/** The question an agent should ask before acting: may I use this capability right now? */
export function checkAuthorization(
  ctx: StoreContext,
  projectId: string,
  capability: AuthorizationCapability,
): { allowed: boolean; grant: AuthorizationGrant | null } {
  expireAuthorizations(ctx, projectId);
  const grant = findActiveGrant(ctx, projectId, capability);
  return { allowed: grant?.status === "GRANTED", grant: grant ?? null };
}

export function decideAuthorization(
  ctx: StoreContext,
  principal: RequestPrincipal,
  id: string,
  input: {
    expectedVersion: number;
    decision: "GRANTED" | "DENIED" | "REVOKED";
    note?: string;
    ttlSeconds?: number;
    idempotencyKey: string;
  },
): AuthorizationGrant {
  const current = getAuthorization(ctx, id);
  if (principal.kind !== "DASHBOARD_USER") {
    throw new ForbiddenError("Only an authenticated Dashboard user can decide authorizations");
  }
  const actor = resolveMutationActor(ctx, principal, current.projectId);
  return ctx.mutate(
    current.projectId,
    input.idempotencyKey,
    "authorization.decide",
    ({ emit }) => {
      const grant = getAuthorization(ctx, id);
      if (grant.version !== input.expectedVersion) {
        throw new ConflictError("Authorization was modified concurrently", grant);
      }
      if (input.decision === "REVOKED" && grant.status !== "GRANTED") {
        throw new ConflictError("Only a granted authorization can be revoked", grant);
      }
      if (input.decision !== "REVOKED" && grant.status !== "PENDING") {
        throw new ConflictError("Only a pending authorization can be decided", grant);
      }
      const now = nowIso();
      const expiresAt =
        input.decision === "GRANTED" && input.ttlSeconds
          ? new Date(Date.now() + input.ttlSeconds * 1000).toISOString()
          : null;
      ctx.sqlite
        .prepare(
          `UPDATE authorization_grants SET
             status = ?, decided_by = ?, decided_via = ?, decided_at = ?, decision_note = ?,
             expires_at = ?, version = version + 1, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          input.decision,
          actor.actorId,
          "dashboard",
          now,
          input.note ?? null,
          expiresAt,
          now,
          id,
        );
      emit({
        projectId: grant.projectId,
        type: `authorization.${input.decision.toLowerCase()}`,
        actorType: actor.actorType,
        actorId: actor.actorId,
        aggregateType: "authorization",
        aggregateId: id,
        causationId: null,
        correlationId: null,
        payload: {
          capability: grant.capability,
          decidedVia: "dashboard",
          expiresAt,
          note: input.note ?? null,
        },
      });
      return getAuthorization(ctx, id);
    },
    mutationOptions(actor, { id, ...input, idempotencyKey: undefined }),
  );
}
