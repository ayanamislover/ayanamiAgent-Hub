import type { RequestPrincipal } from "../../security/local-auth.js";
import { ForbiddenError } from "../../domain/errors.js";
import { mutationFingerprint, type MutationOptions, type StoreContext } from "./context.js";
import { getOpenSession } from "./sessions.js";
import { assertCanControlAdapterSession } from "./session-identity.js";

export type MutationActor = {
  actorType: "agent" | "user";
  actorId: string;
  principalId: string;
  sessionId: string | null;
};

function assertMutationPrincipal(
  principal: RequestPrincipal,
): asserts principal is RequestPrincipal & { kind: "AGENT" | "DASHBOARD_USER" } {
  if (principal.kind !== "AGENT" && principal.kind !== "DASHBOARD_USER") {
    throw new ForbiddenError(`Principal kind ${principal.kind} cannot perform Hub mutations`);
  }
}

export function assertDashboardMutation(principal: RequestPrincipal): void {
  if (principal.kind !== "DASHBOARD_USER") {
    throw new ForbiddenError("This operation requires an authenticated Dashboard user");
  }
}

/**
 * Project join is the one ordinary mutation that must happen before an Agent has a session.
 * Keep this bootstrap exception narrow: it requires the static project:join scope, can only
 * record the authenticated client as the actor, and never creates project metadata (that remains
 * Dashboard-only in the caller).
 */
export function resolveProjectJoinActor(
  ctx: StoreContext,
  principal: RequestPrincipal,
  projectId: string,
): MutationActor {
  if (
    principal.kind === "AGENT" &&
    principal.credentialClass === "STATIC" &&
    principal.scopes.includes("project:join")
  ) {
    if (principal.projectId && principal.projectId !== projectId) {
      throw new ForbiddenError("Credential and mutation belong to different projects");
    }
    return {
      actorType: "agent",
      actorId: principal.agentId ?? principal.displayName,
      principalId: principal.id,
      sessionId: null,
    };
  }
  return resolveMutationActor(ctx, principal, projectId);
}

/**
 * Resolve the event actor from authenticated server state. Request bodies may point at an open
 * Agent session as evidence, but they never get to choose whether the event is a user action.
 */
export function resolveMutationActor(
  ctx: StoreContext,
  principal: RequestPrincipal,
  projectId?: string,
  sessionId?: string,
  claimedAgentId?: string,
): MutationActor {
  assertMutationPrincipal(principal);
  if (principal.projectId && projectId && principal.projectId !== projectId) {
    throw new ForbiddenError("Credential and mutation belong to different projects");
  }
  if (principal.kind === "DASHBOARD_USER") {
    if (sessionId) {
      const session = getOpenSession(ctx, sessionId);
      if (projectId && session.projectId !== projectId) {
        throw new ForbiddenError("Session and mutation belong to different projects");
      }
    }
    return {
      actorType: "user",
      actorId: principal.displayName,
      principalId: principal.id,
      sessionId: null,
    };
  }
  const effectiveSessionId = sessionId ?? principal.hubSessionId;
  if (!effectiveSessionId) {
    throw new ForbiddenError("Agent mutations require an active session-bound credential");
  }
  if (sessionId && principal.hubSessionId && sessionId !== principal.hubSessionId) {
    throw new ForbiddenError("Credential is bound to a different session");
  }
  const session = getOpenSession(ctx, effectiveSessionId);
  assertCanControlAdapterSession(ctx.sqlite, principal, session);
  const actor = resolveSessionMutationActor(ctx, projectId, effectiveSessionId, claimedAgentId);
  return { ...actor, principalId: principal.id };
}

/** Trusted in-process compositions still prove their actor through the open session row. */
export function resolveSessionMutationActor(
  ctx: StoreContext,
  projectId: string | undefined,
  sessionId: string,
  claimedAgentId?: string,
): MutationActor {
  const session = getOpenSession(ctx, sessionId);
  if (projectId && session.projectId !== projectId) {
    throw new ForbiddenError("Session and mutation belong to different projects");
  }
  if (claimedAgentId && claimedAgentId !== session.agentId) {
    throw new ForbiddenError("Claimed Agent identity does not match the authenticated session");
  }
  return {
    actorType: "agent",
    actorId: session.agentId,
    principalId: `session:${session.id}`,
    sessionId: session.id,
  };
}

export function resolveMessageAuthority(
  ctx: StoreContext,
  principal: RequestPrincipal,
  projectId: string,
  input: { fromAgentId: string; fromSessionId?: string },
): { actor: MutationActor; fromAgentId: string; fromSessionId?: string } {
  assertMutationPrincipal(principal);
  if (principal.kind === "DASHBOARD_USER") {
    if (input.fromSessionId) {
      throw new ForbiddenError("Dashboard messages cannot claim an Agent session");
    }
    const actor = resolveMutationActor(ctx, principal, projectId);
    return {
      actor,
      fromAgentId: actor.actorId,
    };
  }
  if (!input.fromSessionId) {
    throw new ForbiddenError("Agent messages require an exact open sender session");
  }
  const actor = resolveMutationActor(
    ctx,
    principal,
    projectId,
    input.fromSessionId,
    input.fromAgentId,
  );
  return { actor, fromAgentId: actor.actorId, fromSessionId: actor.sessionId ?? undefined };
}

export function mutationOptions(
  actor: MutationActor,
  request: unknown,
  validateReplay?: MutationOptions["validateReplay"],
): MutationOptions {
  return {
    requestFingerprint: mutationFingerprint({
      principalId: actor.principalId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      sessionId: actor.sessionId,
      request,
    }),
    validateReplay,
  };
}
