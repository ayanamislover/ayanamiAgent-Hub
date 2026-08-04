import type { AgentSession } from "@crossagent/protocol";
import type Database from "better-sqlite3";
import { ForbiddenError } from "../../domain/errors.js";
import type { RequestPrincipal } from "../../security/local-auth.js";
import { findActiveSessionTicketById } from "../../security/session-tickets.js";

export type AdapterClientType = NonNullable<RequestPrincipal["adapterClient"]>;

type SessionIdentity = Pick<
  AgentSession,
  "id" | "projectId" | "agentId" | "client" | "lineageId" | "incarnation"
>;

const CLIENT_FAMILY: Readonly<Record<AgentSession["client"], AdapterClientType | null>> = {
  "codex-app-server": "codex",
  "codex-cli-hooks": "codex",
  "claude-channel": "claude",
  "claude-hooks": "claude",
  "fake-client": null,
};

function clientFamily(client: string): AdapterClientType | null | undefined {
  return CLIENT_FAMILY[client as AgentSession["client"]];
}

function isExplicitManualAgentId(agentId: string): boolean {
  return ["manual:", "local:"].some(
    (namespace) => agentId.startsWith(namespace) && agentId.length > namespace.length,
  );
}

function assertProjectBinding(principal: RequestPrincipal, projectId: string): void {
  if (principal.projectId && principal.projectId !== projectId) {
    throw new ForbiddenError("Credential is bound to another project");
  }
}

/**
 * The SessionIdentityGate is the single server-side authority seam for Adapter sessions.
 *
 * `agentId`, `client`, and any WebSocket `clientType` frame are caller-controlled strings. Only the
 * authenticated RequestPrincipal identifies the Adapter. The compatibility bearer deliberately
 * remains usable for non-privileged fake-client fixtures, but it cannot create or control a real
 * Codex/Claude Adapter session.
 */
export function assertCanCreateAdapterSession(
  principal: RequestPrincipal,
  input: { projectId: string; agentId: string; client: string },
): void {
  if (
    principal.kind !== "AGENT" ||
    principal.credentialClass !== "STATIC" ||
    principal.id !== "prn_local_agent"
  ) {
    throw new ForbiddenError("Only the compatibility credential can create legacy sessions");
  }
  assertProjectBinding(principal, input.projectId);
  const family = clientFamily(input.client);
  if (family === undefined) {
    throw new ForbiddenError("Credential cannot create an unknown Adapter client family");
  }
  if (family !== null || principal.clientType !== null || !isExplicitManualAgentId(input.agentId)) {
    throw new ForbiddenError(
      "Compatibility sessions require fake-client and an explicit manual: or local: Agent namespace",
    );
  }
}

/**
 * Possession of the CONTROL secret authorizes the bound registration. ACTIVE is accepted only so
 * the Store's idempotency cache can replay a registration response lost after commit; a cache miss
 * still reaches the PENDING-only bundle checks and fails without side effects.
 */
export function assertCanRegisterTicketedAdapterSession(
  principal: RequestPrincipal,
  input: { projectId: string; agentId: string; client: string },
): void {
  if (
    principal.kind !== "AGENT" ||
    principal.credentialClass !== "SESSION_TICKET" ||
    principal.ticketPurpose !== "CONTROL" ||
    (principal.ticketState !== "PENDING" && principal.ticketState !== "ACTIVE") ||
    (principal.ticketState === "PENDING" && principal.hubSessionId !== null) ||
    !principal.adapterClient ||
    !principal.agentId
  ) {
    throw new ForbiddenError("A pending CONTROL ticket is required for Adapter registration");
  }
  assertProjectBinding(principal, input.projectId);
  const family = clientFamily(input.client);
  if (
    family === undefined ||
    family === null ||
    family !== principal.adapterClient ||
    input.agentId !== principal.agentId
  ) {
    throw new ForbiddenError("Ticket identity does not match the Adapter registration");
  }
}

export function assertCanReserveSessionLaunch(
  principal: RequestPrincipal,
  input: { projectId: string; agentId: string; client: string },
): void {
  assertProjectBinding(principal, input.projectId);
  if (principal.kind === "DASHBOARD_USER") return;
  const family = clientFamily(input.client);
  if (
    principal.kind !== "AGENT" ||
    principal.credentialClass !== "STATIC" ||
    !principal.scopes.includes("session:enroll:first") ||
    family === undefined ||
    family === null ||
    principal.clientType !== family ||
    principal.agentId !== input.agentId ||
    input.agentId !== family
  ) {
    throw new ForbiddenError("Credential cannot reserve this Adapter launch");
  }
}

export function assertCanControlAdapterSession(
  sqlite: Database.Database,
  principal: RequestPrincipal,
  session: SessionIdentity,
): void {
  if (principal.kind === "DASHBOARD_USER") {
    assertProjectBinding(principal, session.projectId);
    return;
  }
  if (
    principal.kind === "AGENT" &&
    principal.credentialClass === "STATIC" &&
    principal.id === "prn_local_agent" &&
    session.client === "fake-client" &&
    isExplicitManualAgentId(session.agentId)
  ) {
    assertProjectBinding(principal, session.projectId);
    return;
  }
  const family = clientFamily(session.client);
  const activeTickets =
    principal.credentialClass === "SESSION_TICKET"
      ? findActiveSessionTicketById(sqlite, principal.credentialId, new Date().toISOString())
      : [];
  const active = activeTickets.length === 1 ? activeTickets[0] : undefined;
  if (
    principal.kind !== "AGENT" ||
    principal.credentialClass !== "SESSION_TICKET" ||
    principal.ticketState !== "ACTIVE" ||
    (principal.ticketPurpose !== "CONTROL" && principal.ticketPurpose !== "MODEL_MCP") ||
    family === undefined ||
    family === null ||
    principal.projectId !== session.projectId ||
    principal.agentId !== session.agentId ||
    principal.adapterClient !== family ||
    principal.hubSessionId !== session.id ||
    principal.lineageId !== session.lineageId ||
    principal.incarnation !== session.incarnation ||
    !active ||
    active.id !== principal.credentialId ||
    active.state !== "ACTIVE" ||
    active.purpose !== principal.ticketPurpose ||
    active.projectId !== session.projectId ||
    active.agentId !== session.agentId ||
    active.adapterClient !== family ||
    active.hubSessionId !== session.id ||
    active.lineageId !== session.lineageId ||
    active.incarnation !== session.incarnation
  ) {
    throw new ForbiddenError("Credential is not bound to this active Adapter session");
  }
}

/** Transport/process control is never delegated to the model-facing MCP ticket. */
export function assertCanControlAdapterTransport(
  sqlite: Database.Database,
  principal: RequestPrincipal,
  session: SessionIdentity,
): void {
  if (principal.ticketPurpose !== "CONTROL") {
    throw new ForbiddenError("This Adapter transport operation requires the CONTROL ticket");
  }
  assertCanControlAdapterSession(sqlite, principal, session);
}
