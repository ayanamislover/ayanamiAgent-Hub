import { createHash } from "node:crypto";
import {
  AuthorityDirectiveSchema,
  AdapterAuthorityDeliveryCandidateSchema,
  DelegationGrantSchema,
  canonicalJson,
  canonicalStringSet,
  clipText,
  createId,
  nowIso,
  type AuthorityDirective,
  type AdapterAuthorityDeliveryCandidate,
  type AuthorityDeliveryBinding,
  type AuthorityDirectiveBundle,
  type AuthoritySigningKey,
  type AgentSession,
  type CreateDelegationGrantInput,
  type DelegateInstructionInput,
  type DelegationGrant,
  type DirectiveExecutionResultInput,
  type DirectiveLifecycleMutationInput,
  type DirectivePriority,
  type DirectiveScope,
  type ModifyDelegationGrantInput,
  type RelayUserDirectiveInput,
  type RecoveredAuthorityDelivery,
  type SupersedeUserDirectiveInput,
  type TerminateDelegationGrantInput,
} from "@crossagent/protocol";
import { ConflictError, ForbiddenError, HubError, NotFoundError } from "../../domain/errors.js";
import type { RequestPrincipal } from "../../security/local-auth.js";
import type { AuthorityAttestationService } from "../authority-attestation.js";
import { json, mutationFingerprint, type MutationContext, type StoreContext } from "./context.js";
import { getOpenSession, getSession } from "./sessions.js";
import { assertCanControlAdapterSession } from "./session-identity.js";

type AgentId = "codex" | "claude";
type DirectiveAuthority = "USER_ATTESTED" | "USER_DELEGATED" | "AGENT_PROPOSAL";
type AuthorityEventType =
  | "ISSUED"
  | "DELIVERED"
  | "ACKNOWLEDGED"
  | "PROCESSED"
  | "RESULT_RECORDED"
  | "SUPERSEDED"
  | "REVOKED"
  | "COMPLETED"
  | "EXPIRED";
type DirectiveTerminalEvent = "SUPERSEDED" | "REVOKED" | "COMPLETED" | "EXPIRED";

type AuthorityCandidateSurfaceState = "ACTIVE" | "CONFIRMED";

type DirectiveRow = {
  id: string;
  project_id: string;
  authority: DirectiveAuthority;
  source_user_turn_id: string | null;
  raw_user_turn_sha256: string | null;
  quote_start: number | null;
  quote_end: number | null;
  verbatim_text: string | null;
  verbatim_text_sha256: string | null;
  delegated_text: string | null;
  agent_interpretation: string | null;
  relay_principal_id: string;
  relay_agent_id: AgentId;
  relay_session_id: string | null;
  target_agent_ids_json: string;
  scope_json: string;
  priority: DirectivePriority;
  delegation_grant_id: string | null;
  delegation_version: number | null;
  attempted_delegation_grant_id: string | null;
  attempted_delegation_version: number | null;
  supersedes_directive_id: string | null;
  server_sequence: number;
  issued_at: string;
  expires_at: string | null;
  key_id: string | null;
  canonical_payload_json: string | null;
  canonical_payload_sha256: string | null;
  signature: string | null;
  carrier_message_id: string;
  causation_id: string | null;
  correlation_id: string;
  downgrade_reason: string | null;
};

type GrantVersionRow = {
  grant_id: string;
  project_id: string;
  source_user_turn_id: string | null;
  created_by_principal_id: string;
  version: number;
  delegator_agent_ids_json: string;
  target_agent_ids_json: string;
  allowed_actions_json: string;
  objective_ids_json: string;
  task_ids_json: string;
  file_globs_json: string;
  max_priority: DirectivePriority;
  expires_at: string;
  issued_at: string;
  supersedes_version: number | null;
};

const priorityRank: Record<DirectivePriority, number> = {
  BACKGROUND: 0,
  NORMAL: 1,
  IMPORTANT: 2,
  INTERRUPT: 3,
};
const AUTHORITY_SYSTEM_PRINCIPAL_ID = "prn_authority_system";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function assertActiveStoredPrincipal(
  ctx: StoreContext,
  principal: RequestPrincipal,
  kind: "AGENT" | "DASHBOARD_USER",
  requiredScope: "directive:relay" | "hub:dashboard",
): void {
  const row = ctx.sqlite
    .prepare(
      `SELECT principal.kind, principal.client_type, principal.status, credential.scopes_json
       FROM auth_principals principal
       JOIN auth_credentials credential ON credential.principal_id = principal.id
       WHERE principal.id = ? AND credential.id = ?
         AND credential.revoked_at IS NULL
         AND (credential.expires_at IS NULL OR credential.expires_at > ?)`,
    )
    .get(principal.id, principal.credentialId, nowIso()) as
    { kind: string; client_type: string | null; status: string; scopes_json: string } | undefined;
  const scopes = row ? json<string[]>(row.scopes_json, []) : [];
  if (
    !row ||
    row.kind !== kind ||
    row.status !== "ACTIVE" ||
    !scopes.includes(requiredScope) ||
    !principal.scopes.includes(requiredScope)
  ) {
    throw new ForbiddenError(`This credential cannot perform ${requiredScope}`);
  }
  if (kind === "AGENT" && row.client_type !== principal.clientType) {
    throw new ForbiddenError("Agent credential identity does not match its stored client type");
  }
}

function relayTicketIdentity(
  ctx: StoreContext,
  principal: RequestPrincipal,
  projectId: string,
): { agentId: AgentId; sessionId: string } {
  if (
    principal.kind !== "AGENT" ||
    principal.credentialClass !== "SESSION_TICKET" ||
    principal.ticketState !== "ACTIVE" ||
    (principal.ticketPurpose !== "CONTROL" && principal.ticketPurpose !== "MODEL_MCP") ||
    !principal.scopes.includes("directive:relay") ||
    principal.projectId !== projectId ||
    principal.hubSessionId === null ||
    principal.agentId !== principal.adapterClient ||
    (principal.agentId !== "codex" && principal.agentId !== "claude")
  ) {
    throw new ForbiddenError("Relay requires an ACTIVE session-bound Agent ticket");
  }
  const session = getOpenSession(ctx, principal.hubSessionId);
  assertCanControlAdapterSession(ctx.sqlite, principal, session);
  if (session.projectId !== projectId) {
    throw new ForbiddenError("Relay ticket is bound to another project");
  }
  return { agentId: principal.agentId, sessionId: session.id };
}

function assertDashboard(ctx: StoreContext, principal: RequestPrincipal): void {
  assertActiveStoredPrincipal(ctx, principal, "DASHBOARD_USER", "hub:dashboard");
}

function assertCanonicalUtf16Boundary(value: string, offset: number, label: string): void {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > value.length) {
    throw new HubError(`${label} is outside the source user turn`, 422, "DIRECTIVE_QUOTE_INVALID");
  }
  if (offset > 0 && offset < value.length) {
    const previous = value.charCodeAt(offset - 1);
    const current = value.charCodeAt(offset);
    if (previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff) {
      throw new HubError(`${label} splits a UTF-16 surrogate pair`, 422, "DIRECTIVE_QUOTE_INVALID");
    }
  }
}

function canonicalFileGlobs(values: readonly string[]): string[] {
  const canonical = canonicalStringSet(values);
  for (const value of canonical) {
    if (
      value.includes("\0") ||
      value.includes("\\") ||
      value.startsWith("/") ||
      value.startsWith("//") ||
      /^[A-Za-z]:/.test(value) ||
      value.split("/").some((part) => part === ".." || part === "")
    ) {
      throw new HubError(
        `Authority file glob must be a Git-relative POSIX pattern: ${value}`,
        422,
        "DIRECTIVE_SCOPE_INVALID",
      );
    }
  }
  return canonical;
}

function validateScope(
  ctx: StoreContext,
  projectId: string,
  input: {
    objective_id?: string | null;
    task_ids?: readonly string[];
    file_globs?: readonly string[];
  },
): DirectiveScope {
  const objectiveId = input.objective_id ?? null;
  if (objectiveId) {
    const objective = ctx.sqlite
      .prepare("SELECT project_id FROM objectives WHERE id = ?")
      .get(objectiveId) as { project_id: string } | undefined;
    if (!objective || objective.project_id !== projectId) {
      throw new HubError(
        "Directive objective does not belong to the project",
        422,
        "DIRECTIVE_SCOPE_INVALID",
      );
    }
  }
  const taskIds = canonicalStringSet(input.task_ids ?? []);
  const taskLookup = ctx.sqlite.prepare("SELECT project_id, objective_id FROM tasks WHERE id = ?");
  for (const taskId of taskIds) {
    const task = taskLookup.get(taskId) as { project_id: string; objective_id: string } | undefined;
    if (
      !task ||
      task.project_id !== projectId ||
      (objectiveId !== null && task.objective_id !== objectiveId)
    ) {
      throw new HubError(
        `Directive task is outside the declared project/objective: ${taskId}`,
        422,
        "DIRECTIVE_SCOPE_INVALID",
      );
    }
  }
  return {
    objective_id: objectiveId,
    task_ids: taskIds,
    file_globs: canonicalFileGlobs(input.file_globs ?? []),
  };
}

function assertFutureExpiry(value: string | null): void {
  if (value !== null && Date.parse(value) <= Date.now()) {
    throw new HubError("Directive expiry must be in the future", 422, "DIRECTIVE_EXPIRY_INVALID");
  }
}

function normalizedExpiry(value: string | null | undefined): string | null {
  return value ? new Date(value).toISOString() : null;
}

function terminalEvent(ctx: StoreContext, directiveId: string): DirectiveTerminalEvent | null {
  const row = ctx.sqlite
    .prepare(
      `SELECT event_type FROM authority_events
       WHERE directive_id = ? AND event_type IN ('SUPERSEDED', 'REVOKED', 'COMPLETED', 'EXPIRED')
       ORDER BY server_sequence DESC LIMIT 1`,
    )
    .get(directiveId) as { event_type: DirectiveTerminalEvent } | undefined;
  return row?.event_type ?? null;
}

function lifecycleFor(ctx: StoreContext, row: DirectiveRow): AuthorityDirective["lifecycle"] {
  const terminal = terminalEvent(ctx, row.id);
  if (terminal) return terminal;
  if (row.expires_at !== null && Date.parse(row.expires_at) <= Date.now()) return "EXPIRED";
  return "ACTIVE";
}

function verificationFor(
  ctx: StoreContext,
  signer: AuthorityAttestationService,
  row: DirectiveRow,
  lifecycle: AuthorityDirective["lifecycle"],
): AuthorityDirective["verification"] {
  if (lifecycle === "REVOKED" || lifecycle === "SUPERSEDED") return "REVOKED";
  if (lifecycle === "EXPIRED") return "EXPIRED";
  if (row.authority === "AGENT_PROPOSAL") return "UNVERIFIED";
  if (!row.canonical_payload_json || !row.canonical_payload_sha256 || !row.signature) {
    return "INVALID";
  }
  try {
    const verification = signer.verify({
      payload: JSON.parse(row.canonical_payload_json),
      canonical_payload_sha256: row.canonical_payload_sha256,
      signature: row.signature,
    });
    // VALID is reserved for a target Adapter after it also checks audience, scope, lifecycle, and
    // the exact surface fence. The Hub only reports that the stable issuance is structurally sound.
    return verification.valid ? "UNVERIFIED" : "INVALID";
  } catch {
    return "INVALID";
  }
}

function directiveFromRow(
  ctx: StoreContext,
  signer: AuthorityAttestationService,
  row: DirectiveRow,
): AuthorityDirective {
  const lifecycle = lifecycleFor(ctx, row);
  return AuthorityDirectiveSchema.parse({
    id: row.id,
    projectId: row.project_id,
    authority: row.authority,
    lifecycle,
    verification: verificationFor(ctx, signer, row, lifecycle),
    sourceUserTurnId: row.source_user_turn_id,
    rawUserTurnSha256: row.raw_user_turn_sha256,
    verbatimText: row.verbatim_text,
    verbatimTextSha256: row.verbatim_text_sha256,
    quoteStart: row.quote_start,
    quoteEnd: row.quote_end,
    delegatedText: row.delegated_text,
    agentInterpretation: row.agent_interpretation,
    relayPrincipalId: row.relay_principal_id,
    relayAgentId: row.relay_agent_id,
    relaySessionId: row.relay_session_id,
    targetAgentIds: json(row.target_agent_ids_json, []),
    scope: json(row.scope_json, { objective_id: null, task_ids: [], file_globs: [] }),
    priority: row.priority,
    delegationGrantId: row.delegation_grant_id,
    delegationVersion: row.delegation_version,
    attemptedDelegationGrantId: row.attempted_delegation_grant_id,
    attemptedDelegationVersion: row.attempted_delegation_version,
    supersedesDirectiveId: row.supersedes_directive_id,
    serverSequence: row.server_sequence,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    keyId: row.key_id,
    canonicalPayloadSha256: row.canonical_payload_sha256,
    signature: row.signature,
    carrierMessageId: row.carrier_message_id,
    causationId: row.causation_id,
    correlationId: row.correlation_id,
    downgradeReason: row.downgrade_reason,
  });
}

export function getDirective(
  ctx: StoreContext,
  signer: AuthorityAttestationService,
  directiveId: string,
): AuthorityDirective {
  const row = ctx.sqlite
    .prepare("SELECT * FROM authority_directives WHERE id = ?")
    .get(directiveId) as DirectiveRow | undefined;
  if (!row) throw new NotFoundError("Authority directive", directiveId);
  materializeDirectiveExpiry(ctx, row);
  return directiveFromRow(ctx, signer, row);
}

function assertDirectiveReadable(
  ctx: StoreContext,
  principal: RequestPrincipal,
  directive: AuthorityDirective,
): void {
  if (principal.kind === "DASHBOARD_USER") {
    assertDashboard(ctx, principal);
    return;
  }
  const agentId = relayTicketIdentity(ctx, principal, directive.projectId).agentId;
  if (!directive.targetAgentIds.includes(agentId) && directive.relayAgentId !== agentId) {
    throw new ForbiddenError("Directive is outside this Agent credential's audience");
  }
}

export function getDirectiveForPrincipal(
  ctx: StoreContext,
  signer: AuthorityAttestationService,
  principal: RequestPrincipal,
  directiveId: string,
): AuthorityDirective {
  const directive = getDirective(ctx, signer, directiveId);
  assertDirectiveReadable(ctx, principal, directive);
  return directive;
}

export function getDirectiveBundleForPrincipal(
  ctx: StoreContext,
  signer: AuthorityAttestationService,
  principal: RequestPrincipal,
  directiveId: string,
): AuthorityDirectiveBundle {
  const directive = getDirectiveForPrincipal(ctx, signer, principal, directiveId);
  return directiveBundleFromProjection(ctx, directive);
}

function directiveBundleFromProjection(
  ctx: StoreContext,
  directive: AuthorityDirective,
): AuthorityDirectiveBundle {
  const row = ctx.sqlite
    .prepare("SELECT * FROM authority_directives WHERE id = ?")
    .get(directive.id) as DirectiveRow;
  const attestation =
    row.canonical_payload_json && row.canonical_payload_sha256 && row.signature
      ? {
          payload: JSON.parse(row.canonical_payload_json),
          canonical_payload_sha256: row.canonical_payload_sha256,
          signature: row.signature,
        }
      : null;
  return { directive, attestation };
}

export type AuthorityDeliveryRequest = {
  sessionId: string;
  surfaceAttemptId: string;
  recipientFence: number;
  surfaceState?: "ACTIVE" | "CONFIRMED";
};

function proposalSummary(directive: AuthorityDirective): string {
  const proposedText = directive.verbatimText ?? directive.delegatedText ?? "";
  const interpretation = directive.agentInterpretation
    ? `\nAgent interpretation (advice only): ${directive.agentInterpretation}`
    : "";
  return `Agent proposal (NO USER AUTHORITY): ${proposedText}${interpretation}\nDowngrade reason: ${
    directive.downgradeReason ?? "UNVERIFIED_AGENT_PROPOSAL"
  }`;
}

function buildAuthorityDeliveryCandidate(
  ctx: StoreContext,
  signer: AuthorityAttestationService,
  messageId: string,
  requiredSurfaceState: AuthorityCandidateSurfaceState,
  session: AgentSession,
  delivery: AuthorityDeliveryBinding,
): AdapterAuthorityDeliveryCandidate {
  const message = ctx.sqlite.prepare("SELECT * FROM messages WHERE id = ?").get(messageId) as
    | {
        id: string;
        project_id: string;
        thread_id: string;
        from_agent_id: string;
        priority: DirectivePriority;
        summary: string;
      }
    | undefined;
  if (!message || message.project_id !== session.projectId) {
    throw new NotFoundError("Authority delivery message", messageId);
  }
  const link = ctx.sqlite
    .prepare("SELECT directive_id FROM message_directive_links WHERE message_id = ?")
    .get(messageId) as { directive_id: string } | undefined;
  if (!link) {
    return AdapterAuthorityDeliveryCandidateSchema.parse({
      kind: "ORDINARY",
      message: {
        id: message.id,
        threadId: message.thread_id,
        fromAgentId: message.from_agent_id,
        priority: message.priority,
        summary: clipText(message.summary, 1_600),
      },
      delivery,
    });
  }
  const directiveRow = ctx.sqlite
    .prepare("SELECT * FROM authority_directives WHERE id = ?")
    .get(link.directive_id) as DirectiveRow | undefined;
  if (!directiveRow) throw new NotFoundError("Authority directive", link.directive_id);
  // Recovery runs inside one read transaction with its confirmed delivery proof. Keep that path
  // side-effect free while still projecting expiry from the current clock and append-only events.
  const directive =
    requiredSurfaceState === "CONFIRMED"
      ? directiveFromRow(ctx, signer, directiveRow)
      : getDirective(ctx, signer, link.directive_id);
  if (directive.lifecycle !== "ACTIVE") {
    throw new HubError(`Authority directive is ${directive.lifecycle}`, 409, "DIRECTIVE_INACTIVE", {
      directiveId: directive.id,
      lifecycle: directive.lifecycle,
    });
  }
  if (!directive.targetAgentIds.includes(session.agentId as AgentId)) {
    throw new ForbiddenError("Authority directive is outside this delivery audience");
  }
  if (directive.authority === "AGENT_PROPOSAL") {
    return AdapterAuthorityDeliveryCandidateSchema.parse({
      kind: "ORDINARY",
      message: {
        id: message.id,
        threadId: message.thread_id,
        fromAgentId: directive.relayAgentId,
        priority: message.priority,
        summary: clipText(proposalSummary(directive), 1_600),
      },
      delivery,
    });
  }
  if (directive.verification !== "UNVERIFIED") {
    throw new HubError(
      "Authority attestation or signing key is not currently valid",
      409,
      "DIRECTIVE_ATTESTATION_INVALID",
    );
  }
  const authorityBundle = directiveBundleFromProjection(ctx, directive);
  const signingKey = listAuthoritySigningKeys(ctx).find((key) => key.keyId === directive.keyId);
  if (!signingKey || signingKey.status === "REVOKED") {
    throw new HubError(
      "Authority signing key is not present in the registry",
      409,
      "DIRECTIVE_KEY_UNTRUSTED",
    );
  }
  const delegationGrant = directive.delegationGrantId
    ? requiredSurfaceState === "CONFIRMED"
      ? grantFromRow(ctx, latestGrantRow(ctx, directive.delegationGrantId))
      : getDelegationGrant(ctx, directive.delegationGrantId)
    : null;
  if (
    delegationGrant &&
    (delegationGrant.status !== "ACTIVE" || delegationGrant.version !== directive.delegationVersion)
  ) {
    throw new HubError(
      "Authority delegation is no longer the signed active grant version",
      409,
      "DELEGATION_INACTIVE",
    );
  }
  return AdapterAuthorityDeliveryCandidateSchema.parse({
    kind: "AUTHORITY",
    bundle: { authorityBundle, signingKey, delegationGrant, delivery },
  });
}

/**
 * Resolve one message only after the target Adapter proves the exact live surface it owns.
 *
 * This response is still untrusted input to the Adapter: the Adapter validates the signature and
 * re-renders it locally. The Hub deliberately keeps `verification=UNVERIFIED` in the projection.
 */
export function getAuthorityDeliveryCandidate(
  ctx: StoreContext,
  signer: AuthorityAttestationService,
  principal: RequestPrincipal,
  messageId: string,
  input: AuthorityDeliveryRequest,
): AdapterAuthorityDeliveryCandidate {
  const requiredSurfaceState = input.surfaceState ?? "ACTIVE";
  const session = getOpenSession(ctx, input.sessionId);
  if (principal.kind === "AGENT") {
    assertCanControlAdapterSession(ctx.sqlite, principal, session);
  } else if (
    principal.kind !== "BRIDGE_INJECTOR" ||
    principal.credentialClass !== "SESSION_TICKET" ||
    principal.ticketPurpose !== "INJECTOR" ||
    principal.ticketState !== "ACTIVE" ||
    !principal.scopes.includes("synthetic_prompt:reserve") ||
    principal.projectId !== session.projectId ||
    principal.clientType !== session.agentId ||
    principal.agentId !== session.agentId ||
    principal.adapterClient !== session.agentId ||
    principal.hubSessionId !== session.id ||
    principal.lineageId !== session.lineageId ||
    principal.incarnation !== session.incarnation ||
    !ctx.sqlite
      .prepare(
        `SELECT 1
         FROM adapter_session_tickets ticket
         JOIN agent_sessions bound_session ON bound_session.id = ticket.hub_session_id
         JOIN session_lineages lineage ON lineage.id = bound_session.lineage_id
         WHERE ticket.id = ? AND ticket.purpose = 'INJECTOR' AND ticket.state = 'ACTIVE'
           AND ticket.expires_at > ? AND ticket.project_id = ? AND ticket.agent_id = ?
           AND ticket.adapter_client = ? AND ticket.hub_session_id = ?
           AND ticket.lineage_id = ? AND ticket.incarnation = ?
           AND bound_session.connection_state <> 'CLOSED'
           AND lineage.head_session_id = bound_session.id
           AND lineage.head_incarnation = bound_session.incarnation`,
      )
      .get(
        principal.credentialId,
        nowIso(),
        session.projectId,
        session.agentId,
        session.agentId,
        session.id,
        session.lineageId,
        session.incarnation,
      )
  ) {
    throw new ForbiddenError("Credential identity does not match the Authority delivery session");
  }
  const sessionIncarnation = session.incarnation ?? 0;
  if (session.lineageId) {
    const head = ctx.sqlite
      .prepare("SELECT head_session_id, head_incarnation FROM session_lineages WHERE id = ?")
      .get(session.lineageId) as
      { head_session_id: string | null; head_incarnation: number } | undefined;
    if (head?.head_session_id !== session.id || head.head_incarnation !== sessionIncarnation) {
      throw new HubError(
        "Authority delivery session is not the current logical incarnation",
        409,
        "AUTHORITY_DELIVERY_SESSION_INCARNATION_CHANGED",
      );
    }
  }
  const surface = ctx.sqlite
    .prepare(
      `SELECT message.project_id, surface.session_incarnation, surface.state,
              recipient.recipient_agent_id, recipient.recipient_session_id
       FROM message_surface_attempts surface
       JOIN messages message ON message.id = surface.message_id
       JOIN message_recipients recipient ON recipient.id = surface.recipient_id
       WHERE surface.id = ? AND surface.message_id = ? AND surface.session_id = ?
         AND surface.session_incarnation = ? AND surface.recipient_fence = ?
         AND surface.state = ?
         AND recipient.message_id = message.id
         AND recipient.recipient_agent_id = ?
         AND recipient.recipient_session_id = surface.session_id`,
    )
    .get(
      input.surfaceAttemptId,
      messageId,
      session.id,
      sessionIncarnation,
      input.recipientFence,
      requiredSurfaceState,
      session.agentId,
    ) as
    | {
        project_id: string;
        session_incarnation: number;
        state: "ACTIVE" | "CONFIRMED";
        recipient_agent_id: AgentId;
        recipient_session_id: string;
      }
    | undefined;
  if (!surface || surface.project_id !== session.projectId) {
    throw new HubError(
      "Authority delivery requires the exact active message surface",
      409,
      "AUTHORITY_DELIVERY_SURFACE_INVALID",
    );
  }
  const delivery = {
    projectId: session.projectId,
    carrierMessageId: messageId,
    targetAgentId: session.agentId as AgentId,
    targetSessionId: session.id,
    targetSessionIncarnation: sessionIncarnation,
    surfaceAttemptId: input.surfaceAttemptId,
    recipientFence: input.recipientFence,
    state: "ACTIVE" as const,
  };
  return buildAuthorityDeliveryCandidate(
    ctx,
    signer,
    messageId,
    requiredSurfaceState,
    session,
    delivery,
  );
}

/**
 * Reconstructs a candidate for an already-confirmed historical surface after the Store has proven
 * that the authenticated current head inherited that exact delivery. The immutable permit and
 * candidate remain bound to their predecessor; `recoveredFor` separately identifies the current
 * Adapter incarnation that may consume the proof without rewriting who crossed the model Seam.
 */
export function getRecoveredAuthorityDeliveryCandidate(
  ctx: StoreContext,
  signer: AuthorityAttestationService,
  messageId: string,
  recovery: Pick<RecoveredAuthorityDelivery, "permit" | "recoveredFor">,
): AdapterAuthorityDeliveryCandidate {
  const session = getOpenSession(ctx, recovery.recoveredFor.sessionId);
  if (session.incarnation !== recovery.recoveredFor.sessionIncarnation) {
    throw new HubError(
      "Authority recovery target incarnation changed",
      409,
      "AUTHORITY_DELIVERY_SESSION_INCARNATION_CHANGED",
    );
  }
  if (recovery.recoveredFor.kind === "LINEAGE_HANDOFF") {
    if (session.lineageId !== recovery.recoveredFor.lineageId) {
      throw new HubError(
        "Authority recovery target lineage changed",
        409,
        "AUTHORITY_DELIVERY_SESSION_INCARNATION_CHANGED",
      );
    }
    const head = ctx.sqlite
      .prepare("SELECT head_session_id, head_incarnation FROM session_lineages WHERE id = ?")
      .get(session.lineageId) as
      { head_session_id: string | null; head_incarnation: number } | undefined;
    if (head?.head_session_id !== session.id || head.head_incarnation !== session.incarnation) {
      throw new HubError(
        "Authority recovery target is not the current logical incarnation",
        409,
        "AUTHORITY_DELIVERY_SESSION_INCARNATION_CHANGED",
      );
    }
  }
  const predecessor = getSession(ctx, recovery.permit.sessionId);
  if (
    predecessor.projectId !== session.projectId ||
    predecessor.agentId !== session.agentId ||
    predecessor.incarnation !== recovery.permit.sessionIncarnation ||
    (recovery.recoveredFor.kind === "LINEAGE_HANDOFF" &&
      predecessor.lineageId !== recovery.recoveredFor.lineageId)
  ) {
    throw new HubError(
      "Authority recovery predecessor binding changed",
      409,
      "AUTHORITY_DELIVERY_SESSION_INCARNATION_CHANGED",
    );
  }
  return buildAuthorityDeliveryCandidate(ctx, signer, messageId, "CONFIRMED", predecessor, {
    projectId: predecessor.projectId,
    carrierMessageId: messageId,
    targetAgentId: predecessor.agentId as AgentId,
    targetSessionId: predecessor.id,
    targetSessionIncarnation: predecessor.incarnation ?? 0,
    surfaceAttemptId: recovery.permit.id,
    recipientFence: recovery.permit.recipientFence,
    state: "ACTIVE",
  });
}

export function listAuthoritySigningKeys(ctx: StoreContext): AuthoritySigningKey[] {
  return (
    ctx.sqlite
      .prepare(
        `SELECT key.key_id, key.algorithm, key.public_key_spki_base64url,
                key.fingerprint_sha256, key.created_at,
                CASE
                  WHEN EXISTS (
                    SELECT 1 FROM authority_key_events event
                    WHERE event.key_id = key.key_id AND event.event_type = 'REVOKED'
                  ) THEN 'REVOKED'
                  WHEN EXISTS (
                    SELECT 1 FROM authority_key_events event
                    WHERE event.key_id = key.key_id AND event.event_type = 'RETIRED'
                  ) THEN 'RETIRED'
                  ELSE 'ACTIVE'
                END AS status
         FROM authority_signing_keys key ORDER BY key.created_at, key.key_id`,
      )
      .all() as Array<{
      key_id: string;
      algorithm: "Ed25519";
      public_key_spki_base64url: string;
      fingerprint_sha256: string;
      status: "ACTIVE" | "RETIRED" | "REVOKED";
      created_at: string;
    }>
  ).map((row) => ({
    keyId: row.key_id,
    algorithm: row.algorithm,
    publicKeySpkiBase64Url: row.public_key_spki_base64url,
    fingerprintSha256: row.fingerprint_sha256,
    status: row.status,
    createdAt: row.created_at,
  }));
}

export function listDirectives(
  ctx: StoreContext,
  signer: AuthorityAttestationService,
  principal: RequestPrincipal,
  projectId: string,
): AuthorityDirective[] {
  const rows = ctx.sqlite
    .prepare(
      "SELECT * FROM authority_directives WHERE project_id = ? ORDER BY server_sequence DESC",
    )
    .all(projectId) as DirectiveRow[];
  for (const row of rows) materializeDirectiveExpiry(ctx, row);
  if (principal.kind === "DASHBOARD_USER") {
    assertDashboard(ctx, principal);
    return rows.map((row) => directiveFromRow(ctx, signer, row));
  }
  const agentId = relayTicketIdentity(ctx, principal, projectId).agentId;
  return rows
    .filter(
      (row) =>
        row.relay_agent_id === agentId ||
        json<AgentId[]>(row.target_agent_ids_json, []).includes(agentId),
    )
    .map((row) => directiveFromRow(ctx, signer, row));
}

function insertCarrier(
  ctx: StoreContext,
  mutation: MutationContext,
  input: {
    projectId: string;
    directiveId: string;
    relayAgentId: AgentId;
    relaySessionId: string | null;
    targetAgentIds: AgentId[];
    priority: DirectivePriority;
    expiresAt: string | null;
    correlationId: string;
  },
): { messageId: string; threadId: string } {
  const now = nowIso();
  const messageId = createId("msg");
  const threadId = createId("thr");
  ctx.sqlite
    .prepare(
      `INSERT INTO threads(
        id, project_id, subject, status, task_id, review_id, waiting_for_agent_id,
        proposal_rounds, objection_rounds, version, created_at, updated_at
      ) VALUES (?, ?, ?, 'OPEN', NULL, NULL, NULL, 0, 0, 0, ?, ?)`,
    )
    .run(threadId, input.projectId, `Authority directive ${input.directiveId}`, now, now);
  const messageEvent = mutation.emit({
    projectId: input.projectId,
    type: "message.posted",
    actorType: "agent",
    actorId: input.relayAgentId,
    aggregateType: "message",
    aggregateId: messageId,
    causationId: input.directiveId,
    correlationId: input.correlationId,
    payload: {
      threadId,
      type: "SYSTEM",
      priority: input.priority,
      requiresAck: true,
      requiresResponse: false,
      recipients: input.targetAgentIds.map((agentId) => ({ agentId })),
      directiveId: input.directiveId,
    },
  });
  ctx.sqlite
    .prepare(
      `INSERT INTO messages(
        id, project_id, sequence, thread_id, reply_to, task_id, review_id,
        from_agent_id, from_session_id, type, priority, requires_ack,
        requires_response, summary, detail_json, references_json, dedupe_key,
        expires_at, created_at
      ) VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, ?, 'SYSTEM', ?, 1, 0, ?, ?, '[]', ?, ?, ?)`,
    )
    .run(
      messageId,
      input.projectId,
      messageEvent.sequence,
      threadId,
      input.relayAgentId,
      input.relaySessionId,
      input.priority,
      `Authority directive ${input.directiveId}`,
      JSON.stringify({ directiveId: input.directiveId }),
      `authority:${input.directiveId}`,
      input.expiresAt,
      now,
    );
  const insertRecipient = ctx.sqlite.prepare(
    `INSERT INTO message_recipients(
       id, message_id, recipient_agent_id, recipient_session_id, state, attempt_count
     ) VALUES (?, ?, ?, NULL, 'PENDING', 0)`,
  );
  for (const targetAgentId of input.targetAgentIds) {
    insertRecipient.run(createId("rcp"), messageId, targetAgentId);
  }
  return { messageId, threadId };
}

function authorityEventActor(
  ctx: StoreContext,
  principalId: string | null,
  sessionId: string | null,
): { actorType: "agent" | "user" | "system"; actorId: string } {
  if (sessionId) {
    const session = ctx.sqlite
      .prepare("SELECT agent_id FROM agent_sessions WHERE id = ?")
      .get(sessionId) as { agent_id: string } | undefined;
    if (!session) throw new NotFoundError("Authority event actor session", sessionId);
    return { actorType: "agent", actorId: session.agent_id };
  }
  if (principalId) {
    const principal = ctx.sqlite
      .prepare("SELECT kind, display_name, client_type FROM auth_principals WHERE id = ?")
      .get(principalId) as
      { kind: string; display_name: string; client_type: string | null } | undefined;
    if (!principal) throw new NotFoundError("Authority event actor principal", principalId);
    if (principal.kind === "DASHBOARD_USER") {
      return { actorType: "user", actorId: principal.display_name };
    }
    if (principal.kind === "AGENT") {
      return { actorType: "agent", actorId: principal.client_type ?? principal.display_name };
    }
    return { actorType: "system", actorId: principal.display_name };
  }
  return { actorType: "system", actorId: "crossagent-hub" };
}

function appendAuthorityEvent(
  ctx: StoreContext,
  mutation: MutationContext,
  input: {
    directiveId: string;
    projectId: string;
    type: AuthorityEventType;
    actorPrincipalId: string | null;
    actorSessionId: string | null;
    targetAgentId?: AgentId | null;
    fromLifecycle?: string | null;
    toLifecycle?: string | null;
    causationId?: string | null;
    correlationId: string;
    payload?: unknown;
  },
): void {
  const actor = authorityEventActor(ctx, input.actorPrincipalId, input.actorSessionId);
  const event = mutation.emit({
    projectId: input.projectId,
    type: `directive.${input.type.toLowerCase()}`,
    actorType: actor.actorType,
    actorId: actor.actorId,
    aggregateType: "authority_directive",
    aggregateId: input.directiveId,
    causationId: input.causationId ?? null,
    correlationId: input.correlationId,
    payload: input.payload ?? null,
  });
  ctx.sqlite
    .prepare(
      `INSERT INTO authority_events(
         id, project_id, directive_id, event_type, actor_principal_id, actor_session_id,
         target_agent_id, server_sequence, event_id, from_lifecycle, to_lifecycle,
         causation_id, correlation_id, payload_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      createId("aev"),
      input.projectId,
      input.directiveId,
      input.type,
      input.actorPrincipalId,
      input.actorSessionId,
      input.targetAgentId ?? null,
      event.sequence,
      event.id,
      input.fromLifecycle ?? null,
      input.toLifecycle ?? null,
      input.causationId ?? null,
      input.correlationId,
      JSON.stringify(input.payload ?? null),
      event.createdAt,
    );
}

function materializeDirectiveExpiry(ctx: StoreContext, row: DirectiveRow): void {
  if (row.expires_at === null || Date.parse(row.expires_at) > Date.now()) return;
  if (terminalEvent(ctx, row.id)) return;
  ctx.mutate(
    row.project_id,
    `authority-expire:${createId("mut")}`,
    "directive.expire",
    ({ emit }) => {
      const current = ctx.sqlite
        .prepare("SELECT * FROM authority_directives WHERE id = ?")
        .get(row.id) as DirectiveRow;
      if (terminalEvent(ctx, current.id)) return { directiveId: current.id };
      if (current.expires_at === null || Date.parse(current.expires_at) > Date.now()) {
        return { directiveId: current.id };
      }
      appendAuthorityEvent(
        ctx,
        { emit },
        {
          directiveId: current.id,
          projectId: current.project_id,
          type: "EXPIRED",
          actorPrincipalId: AUTHORITY_SYSTEM_PRINCIPAL_ID,
          actorSessionId: null,
          fromLifecycle: "ACTIVE",
          toLifecycle: "EXPIRED",
          causationId: current.id,
          correlationId: current.correlation_id,
          payload: { expiresAt: current.expires_at },
        },
      );
      return { directiveId: current.id };
    },
    {
      requestFingerprint: mutationFingerprint({
        directiveId: row.id,
        expiresAt: row.expires_at,
      }),
    },
  );
}

export function materializeDirectiveExpiryById(ctx: StoreContext, directiveId: string): void {
  const row = ctx.sqlite
    .prepare("SELECT * FROM authority_directives WHERE id = ?")
    .get(directiveId) as DirectiveRow | undefined;
  if (row) materializeDirectiveExpiry(ctx, row);
}

function supersedeInsideMutation(
  ctx: StoreContext,
  mutation: MutationContext,
  input: {
    oldDirectiveId: string;
    newDirectiveId: string;
    projectId: string;
    actorPrincipalId: string;
    correlationId: string;
    reason: string | null;
  },
): void {
  const old = ctx.sqlite
    .prepare("SELECT * FROM authority_directives WHERE id = ?")
    .get(input.oldDirectiveId) as DirectiveRow | undefined;
  if (!old || old.project_id !== input.projectId) {
    throw new NotFoundError("Superseded authority directive", input.oldDirectiveId);
  }
  if (lifecycleFor(ctx, old) !== "ACTIVE") {
    throw new ConflictError("Only an ACTIVE directive can be superseded");
  }
  appendAuthorityEvent(ctx, mutation, {
    directiveId: old.id,
    projectId: old.project_id,
    type: "SUPERSEDED",
    actorPrincipalId: input.actorPrincipalId,
    actorSessionId: null,
    fromLifecycle: "ACTIVE",
    toLifecycle: "SUPERSEDED",
    causationId: input.newDirectiveId,
    correlationId: input.correlationId,
    payload: { supersededByDirectiveId: input.newDirectiveId, reason: input.reason },
  });
}

function issueDirective(
  ctx: StoreContext,
  signer: AuthorityAttestationService,
  mutation: MutationContext,
  input: {
    projectId: string;
    directiveId: string;
    authority: DirectiveAuthority;
    source: {
      userTurnId: string;
      clientType: "codex" | "claude";
      sessionId: string;
      turnId: string | null;
      rawSha256: string;
    } | null;
    quote: {
      start: number;
      end: number;
      text: string;
      sha256: string;
    } | null;
    delegatedText: string | null;
    interpretation: string | null;
    relayPrincipalId: string;
    relayAgentId: AgentId;
    relaySessionId: string | null;
    targetAgentIds: AgentId[];
    scope: DirectiveScope;
    priority: DirectivePriority;
    grant: DelegationGrant | null;
    attemptedGrant: { id: string; version: number } | null;
    supersedesDirectiveId: string | null;
    supersedeReason: string | null;
    issuanceActorPrincipalId: string | null;
    issuanceActorSessionId: string | null;
    expiresAt: string | null;
    downgradeReason: string | null;
    causationId: string | null;
    correlationId: string;
  },
): string {
  // The carrier is part of the signed v2 statement. Create it first inside the surrounding
  // IMMEDIATE mutation so a signing failure rolls the carrier, its recipients, and its sequence
  // back together with the directive.
  const carrier = insertCarrier(ctx, mutation, {
    projectId: input.projectId,
    directiveId: input.directiveId,
    relayAgentId: input.relayAgentId,
    relaySessionId: input.relaySessionId,
    targetAgentIds: input.targetAgentIds,
    priority: input.priority,
    expiresAt: input.expiresAt,
    correlationId: input.correlationId,
  });
  if (input.supersedesDirectiveId) {
    supersedeInsideMutation(ctx, mutation, {
      oldDirectiveId: input.supersedesDirectiveId,
      newDirectiveId: input.directiveId,
      projectId: input.projectId,
      actorPrincipalId: input.issuanceActorPrincipalId!,
      correlationId: input.correlationId,
      reason: input.supersedeReason,
    });
  }
  const issuancePayload = {
    authority: input.authority,
    audience: input.targetAgentIds,
    scope: input.scope,
    priority: input.priority,
    supersedesDirectiveId: input.supersedesDirectiveId,
  };
  const issuanceActor = authorityEventActor(
    ctx,
    input.issuanceActorPrincipalId,
    input.issuanceActorSessionId,
  );
  const issuance = mutation.emit({
    projectId: input.projectId,
    type: "directive.issued",
    actorType: issuanceActor.actorType,
    actorId: issuanceActor.actorId,
    aggregateType: "authority_directive",
    aggregateId: input.directiveId,
    causationId: input.causationId,
    correlationId: input.correlationId,
    payload: issuancePayload,
  });
  let canonicalPayload: string | null = null;
  let canonicalPayloadSha256: string | null = null;
  let signature: string | null = null;
  let keyId: string | null = null;
  if (input.authority !== "AGENT_PROPOSAL") {
    const attestation = signer.sign({
      type: "crossagent.user-directive-attestation.v2",
      schema_version: 2,
      directive_id: input.directiveId,
      project_id: input.projectId,
      carrier_message_id: carrier.messageId,
      authority: input.authority,
      source: input.source
        ? {
            user_turn_id: input.source.userTurnId,
            client_type: input.source.clientType,
            session_id: input.source.sessionId,
            turn_id: input.source.turnId,
            raw_user_turn_sha256: input.source.rawSha256,
          }
        : null,
      quote: input.quote
        ? {
            start_utf16: input.quote.start,
            end_utf16: input.quote.end,
            verbatim_text: input.quote.text,
            verbatim_text_sha256: input.quote.sha256,
          }
        : null,
      delegated_instruction: input.delegatedText
        ? { text: input.delegatedText, text_sha256: sha256(input.delegatedText) }
        : null,
      relay: {
        principal_id: input.relayPrincipalId,
        agent_id: input.relayAgentId,
        session_id: input.relaySessionId,
      },
      audience: { target_agent_ids: input.targetAgentIds },
      scope: input.scope,
      delegation: input.grant
        ? {
            grant_id: input.grant.id,
            version: input.grant.version,
            delegator_agent_ids: canonicalStringSet(input.grant.delegatorAgentIds) as AgentId[],
            target_agent_ids: canonicalStringSet(input.grant.targetAgentIds) as AgentId[],
            allowed_actions: canonicalStringSet(input.grant.allowedActions) as Array<
              "ASSIGN_TASK" | "RELAY_DIRECTIVE"
            >,
            objective_ids: canonicalStringSet(input.grant.objectiveIds),
            task_ids: canonicalStringSet(input.grant.taskIds),
            file_globs: canonicalStringSet(input.grant.fileGlobs),
            max_priority: input.grant.maxPriority,
            expires_at: input.grant.expiresAt,
          }
        : null,
      supersedes_directive_id: input.supersedesDirectiveId,
      priority: input.priority,
      server_sequence: issuance.sequence,
      issued_at: issuance.createdAt,
      expires_at: input.expiresAt,
      key_id: signer.keyId,
      causation_id: input.causationId,
      correlation_id: input.correlationId,
    });
    canonicalPayload = canonicalJson(attestation.payload);
    canonicalPayloadSha256 = attestation.canonical_payload_sha256;
    signature = attestation.signature;
    keyId = attestation.payload.key_id;
  }
  ctx.sqlite
    .prepare(
      `INSERT INTO authority_directives(
         id, project_id, authority, source_user_turn_id, raw_user_turn_sha256,
         quote_start, quote_end, verbatim_text, verbatim_text_sha256, delegated_text,
         agent_interpretation, relay_principal_id, relay_agent_id, relay_session_id,
         target_agent_ids_json, scope_json, priority, delegation_grant_id,
         delegation_version, attempted_delegation_grant_id, attempted_delegation_version,
         supersedes_directive_id, server_sequence, issued_at,
         expires_at, key_id, canonical_payload_json, canonical_payload_sha256,
         signature, carrier_message_id, causation_id, correlation_id, downgrade_reason
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.directiveId,
      input.projectId,
      input.authority,
      input.source?.userTurnId ?? null,
      input.source?.rawSha256 ?? null,
      input.quote?.start ?? null,
      input.quote?.end ?? null,
      input.quote?.text ?? null,
      input.quote?.sha256 ?? null,
      input.delegatedText,
      input.interpretation,
      input.relayPrincipalId,
      input.relayAgentId,
      input.relaySessionId,
      JSON.stringify(input.targetAgentIds),
      JSON.stringify(input.scope),
      input.priority,
      input.grant?.id ?? null,
      input.grant?.version ?? null,
      input.attemptedGrant?.id ?? null,
      input.attemptedGrant?.version ?? null,
      input.supersedesDirectiveId,
      issuance.sequence,
      issuance.createdAt,
      input.expiresAt,
      keyId,
      canonicalPayload,
      canonicalPayloadSha256,
      signature,
      carrier.messageId,
      input.causationId,
      input.correlationId,
      input.downgradeReason,
    );
  ctx.sqlite
    .prepare(
      "INSERT INTO message_directive_links(message_id, directive_id, created_at) VALUES (?, ?, ?)",
    )
    .run(carrier.messageId, input.directiveId, issuance.createdAt);
  ctx.sqlite
    .prepare(
      `INSERT INTO authority_events(
         id, project_id, directive_id, event_type, actor_principal_id, actor_session_id,
         target_agent_id, server_sequence, event_id, from_lifecycle, to_lifecycle,
         causation_id, correlation_id, payload_json, created_at
       ) VALUES (?, ?, ?, 'ISSUED', ?, ?, NULL, ?, ?, NULL, 'ACTIVE', ?, ?, ?, ?)`,
    )
    .run(
      createId("aev"),
      input.projectId,
      input.directiveId,
      input.issuanceActorPrincipalId,
      input.issuanceActorSessionId,
      issuance.sequence,
      issuance.id,
      input.causationId,
      input.correlationId,
      JSON.stringify(issuancePayload),
      issuance.createdAt,
    );
  return input.directiveId;
}

export function relayUserDirective(
  ctx: StoreContext,
  signer: AuthorityAttestationService,
  principal: RequestPrincipal,
  projectId: string,
  input: RelayUserDirectiveInput,
): AuthorityDirective {
  const relay = relayTicketIdentity(ctx, principal, projectId);
  const agentId = relay.agentId;
  // A user turn is captured by one immutable client identity. Possession of its opaque id is not
  // authority to re-attest it: in particular, the receiving Agent must not re-sign the source turn
  // under its own identity with a wider audience or scope. Do this read-only preflight before the
  // idempotent mutation so a rejected cross-client relay cannot create even a transient carrier,
  // event, sequence, directive, or idempotency record.
  const turn = ctx.sqlite
    .prepare(
      `SELECT id, project_id, client_type, source_session_id, source_turn_id,
              raw_text, raw_text_sha256
       FROM user_turns WHERE id = ?`,
    )
    .get(input.source_user_turn_id) as
    | {
        id: string;
        project_id: string;
        client_type: "codex" | "claude";
        source_session_id: string;
        source_turn_id: string | null;
        raw_text: string;
        raw_text_sha256: string;
      }
    | undefined;
  if (!turn || turn.project_id !== projectId) {
    throw new NotFoundError("Source user turn", input.source_user_turn_id);
  }
  if (turn.client_type !== agentId) {
    throw new ForbiddenError(
      "Relay Agent must match the client that captured the source user turn",
    );
  }
  if (sha256(turn.raw_text) !== turn.raw_text_sha256) {
    throw new HubError(
      "Source user turn hash no longer matches its immutable text",
      409,
      "USER_TURN_INTEGRITY_FAILED",
    );
  }
  const audience = canonicalStringSet(input.target_agent_ids) as AgentId[];
  const identity = mutationFingerprint({ projectId, principalId: principal.id, input });
  const cached = ctx.mutate(
    projectId,
    input.idempotency_key,
    "directive.relay",
    ({ emit }) => {
      // The immutable turn is a one-shot signing capability, not a reusable bearer. Exact replay
      // returns from StoreContext.mutate before this action; every distinct request reaches this
      // guard and loses once one non-superseding USER_ATTESTED relay committed. Dashboard
      // supersession is a separately authenticated user action and remains outside this fence.
      const priorSignedRelay = ctx.sqlite
        .prepare(
          `SELECT id FROM authority_directives
           WHERE source_user_turn_id = ? AND authority = 'USER_ATTESTED'
             AND supersedes_directive_id IS NULL
           ORDER BY issued_at, id LIMIT 1`,
        )
        .get(turn.id) as { id: string } | undefined;
      if (priorSignedRelay) {
        throw new ConflictError("Source user turn already has a signed relay", {
          directiveId: priorSignedRelay.id,
        });
      }
      const scope = validateScope(ctx, projectId, input);
      assertCanonicalUtf16Boundary(turn.raw_text, input.quote_start, "quote_start");
      assertCanonicalUtf16Boundary(turn.raw_text, input.quote_end, "quote_end");
      if (
        input.quote_start >= input.quote_end ||
        turn.raw_text.slice(input.quote_start, input.quote_end) !== input.verbatim_text
      ) {
        throw new HubError(
          "verbatim_text is not the exact UTF-16 slice of the source user turn",
          422,
          "DIRECTIVE_QUOTE_MISMATCH",
        );
      }
      const wholeTurn =
        input.quote_start === 0 &&
        input.quote_end === turn.raw_text.length &&
        input.verbatim_text === turn.raw_text;
      const directiveId = createId("dir");
      const correlationId = directiveId;
      issueDirective(
        ctx,
        signer,
        { emit },
        {
          projectId,
          directiveId,
          // Exact slicing proves provenance, but only the complete captured turn preserves enough
          // context to inherit user authority. A partial quote remains useful coordination content
          // while being explicitly unsigned and non-authoritative.
          authority: wholeTurn ? "USER_ATTESTED" : "AGENT_PROPOSAL",
          source: {
            userTurnId: turn.id,
            clientType: turn.client_type,
            sessionId: turn.source_session_id,
            turnId: turn.source_turn_id,
            rawSha256: turn.raw_text_sha256,
          },
          quote: {
            start: input.quote_start,
            end: input.quote_end,
            text: input.verbatim_text,
            sha256: sha256(input.verbatim_text),
          },
          // 0008 requires every unsigned proposal to carry its proposed instruction explicitly.
          // Preserve the exact partial slice in both provenance and proposal text; neither field is
          // signed and no complete source turn is disclosed to the target.
          delegatedText: wholeTurn ? null : input.verbatim_text,
          interpretation: input.agent_interpretation ?? null,
          relayPrincipalId: principal.id,
          relayAgentId: agentId,
          relaySessionId: relay.sessionId,
          targetAgentIds: audience,
          scope,
          priority: "IMPORTANT",
          grant: null,
          attemptedGrant: null,
          // Relaying Agent credentials cannot decide that an existing user directive is obsolete.
          // Supersession is reserved for a separately authenticated Dashboard/user operation.
          supersedesDirectiveId: null,
          supersedeReason: null,
          issuanceActorPrincipalId: null,
          issuanceActorSessionId: relay.sessionId,
          expiresAt: null,
          downgradeReason: wholeTurn ? null : "PARTIAL_QUOTE_CONTEXT_UNPROVEN",
          causationId: turn.id,
          correlationId,
        },
      );
      return { directiveId };
    },
    { requestFingerprint: identity },
  );
  return getDirective(ctx, signer, cached.directiveId);
}

export function supersedeUserDirective(
  ctx: StoreContext,
  signer: AuthorityAttestationService,
  principal: RequestPrincipal,
  oldDirectiveId: string,
  input: SupersedeUserDirectiveInput,
): AuthorityDirective {
  assertDashboard(ctx, principal);
  const old = ctx.sqlite
    .prepare("SELECT project_id FROM authority_directives WHERE id = ?")
    .get(oldDirectiveId) as { project_id: string } | undefined;
  if (!old) throw new NotFoundError("Superseded authority directive", oldDirectiveId);
  const projectId = old.project_id;
  const audience = canonicalStringSet(input.target_agent_ids) as AgentId[];
  const cached = ctx.mutate(
    projectId,
    input.idempotency_key,
    "directive.supersede",
    ({ emit }) => {
      const scope = validateScope(ctx, projectId, input);
      const turn = ctx.sqlite
        .prepare(
          `SELECT id, project_id, client_type, source_session_id, source_turn_id,
                  raw_text, raw_text_sha256
           FROM user_turns WHERE id = ?`,
        )
        .get(input.source_user_turn_id) as
        | {
            id: string;
            project_id: string;
            client_type: AgentId;
            source_session_id: string;
            source_turn_id: string | null;
            raw_text: string;
            raw_text_sha256: string;
          }
        | undefined;
      if (!turn || turn.project_id !== projectId) {
        throw new NotFoundError("Source user turn", input.source_user_turn_id);
      }
      if (sha256(turn.raw_text) !== turn.raw_text_sha256) {
        throw new HubError(
          "Source user turn hash no longer matches its immutable text",
          409,
          "USER_TURN_INTEGRITY_FAILED",
        );
      }
      assertCanonicalUtf16Boundary(turn.raw_text, input.quote_start, "quote_start");
      assertCanonicalUtf16Boundary(turn.raw_text, input.quote_end, "quote_end");
      if (
        input.quote_start >= input.quote_end ||
        turn.raw_text.slice(input.quote_start, input.quote_end) !== input.verbatim_text
      ) {
        throw new HubError(
          "verbatim_text is not the exact UTF-16 slice of the source user turn",
          422,
          "DIRECTIVE_QUOTE_MISMATCH",
        );
      }
      if (
        input.quote_start !== 0 ||
        input.quote_end !== turn.raw_text.length ||
        input.verbatim_text !== turn.raw_text
      ) {
        throw new HubError(
          "A user-attested successor requires the complete captured user turn",
          422,
          "DIRECTIVE_WHOLE_TURN_REQUIRED",
        );
      }
      const relayPrincipal = ctx.sqlite
        .prepare(
          `SELECT id FROM auth_principals
           WHERE kind = 'AGENT' AND client_type = ? AND status = 'ACTIVE'`,
        )
        .get(turn.client_type) as { id: string } | undefined;
      if (!relayPrincipal) {
        throw new HubError(
          "The source user-turn client has no active relay principal",
          409,
          "DIRECTIVE_RELAY_PRINCIPAL_UNAVAILABLE",
        );
      }
      const directiveId = createId("dir");
      issueDirective(
        ctx,
        signer,
        { emit },
        {
          projectId,
          directiveId,
          authority: "USER_ATTESTED",
          source: {
            userTurnId: turn.id,
            clientType: turn.client_type,
            sessionId: turn.source_session_id,
            turnId: turn.source_turn_id,
            rawSha256: turn.raw_text_sha256,
          },
          quote: {
            start: input.quote_start,
            end: input.quote_end,
            text: input.verbatim_text,
            sha256: sha256(input.verbatim_text),
          },
          delegatedText: null,
          interpretation: input.agent_interpretation ?? null,
          relayPrincipalId: relayPrincipal.id,
          relayAgentId: turn.client_type,
          relaySessionId: null,
          targetAgentIds: audience,
          scope,
          priority: "IMPORTANT",
          grant: null,
          attemptedGrant: null,
          supersedesDirectiveId: oldDirectiveId,
          supersedeReason: input.reason,
          issuanceActorPrincipalId: principal.id,
          issuanceActorSessionId: null,
          expiresAt: null,
          downgradeReason: null,
          causationId: oldDirectiveId,
          correlationId: directiveId,
        },
      );
      return { directiveId };
    },
    {
      requestFingerprint: mutationFingerprint({
        oldDirectiveId,
        principalId: principal.id,
        input,
      }),
    },
  );
  return getDirective(ctx, signer, cached.directiveId);
}

function latestGrantRow(ctx: StoreContext, grantId: string): GrantVersionRow {
  const row = ctx.sqlite
    .prepare(
      `SELECT grant.id AS grant_id, grant.project_id, grant.source_user_turn_id,
              grant.created_by_principal_id, version.*
       FROM delegation_grants grant
       JOIN delegation_grant_versions version ON version.grant_id = grant.id
       WHERE grant.id = ? ORDER BY version.version DESC LIMIT 1`,
    )
    .get(grantId) as GrantVersionRow | undefined;
  if (!row) throw new NotFoundError("Delegation grant", grantId);
  return row;
}

function grantStatus(ctx: StoreContext, row: GrantVersionRow): DelegationGrant["status"] {
  const terminal = ctx.sqlite
    .prepare(
      `SELECT event_type FROM delegation_events
       WHERE grant_id = ? AND event_type IN ('TERMINATED', 'EXPIRED')
       ORDER BY server_sequence DESC LIMIT 1`,
    )
    .get(row.grant_id) as { event_type: "TERMINATED" | "EXPIRED" } | undefined;
  if (terminal) return terminal.event_type;
  if (Date.parse(row.expires_at) <= Date.now()) return "EXPIRED";
  const newest = latestGrantRow(ctx, row.grant_id);
  return newest.version === row.version ? "ACTIVE" : "SUPERSEDED";
}

function grantFromRow(ctx: StoreContext, row: GrantVersionRow): DelegationGrant {
  return DelegationGrantSchema.parse({
    id: row.grant_id,
    projectId: row.project_id,
    version: row.version,
    status: grantStatus(ctx, row),
    delegatorAgentIds: json(row.delegator_agent_ids_json, []),
    targetAgentIds: json(row.target_agent_ids_json, []),
    allowedActions: json(row.allowed_actions_json, []),
    objectiveIds: json(row.objective_ids_json, []),
    taskIds: json(row.task_ids_json, []),
    fileGlobs: json(row.file_globs_json, []),
    maxPriority: row.max_priority,
    sourceUserTurnId: row.source_user_turn_id,
    expiresAt: row.expires_at,
    issuedAt: row.issued_at,
    createdByPrincipalId: row.created_by_principal_id,
    supersedesVersion: row.supersedes_version,
  });
}

export function getDelegationGrant(ctx: StoreContext, grantId: string): DelegationGrant {
  const row = latestGrantRow(ctx, grantId);
  materializeDelegationExpiry(ctx, row);
  return grantFromRow(ctx, row);
}

export function listDelegationGrants(
  ctx: StoreContext,
  principal: RequestPrincipal,
  projectId: string,
): DelegationGrant[] {
  assertDashboard(ctx, principal);
  const rows = ctx.sqlite
    .prepare(
      `SELECT grant.id AS grant_id, grant.project_id, grant.source_user_turn_id,
              grant.created_by_principal_id, version.*
       FROM delegation_grants grant
       JOIN delegation_grant_versions version ON version.grant_id = grant.id
       WHERE grant.project_id = ? AND version.version = (
         SELECT MAX(candidate.version) FROM delegation_grant_versions candidate
         WHERE candidate.grant_id = grant.id
       ) ORDER BY grant.created_at DESC`,
    )
    .all(projectId) as GrantVersionRow[];
  for (const row of rows) materializeDelegationExpiry(ctx, row);
  return rows.map((row) => grantFromRow(ctx, row));
}

function validateGrantTerms(
  ctx: StoreContext,
  projectId: string,
  input: CreateDelegationGrantInput | ModifyDelegationGrantInput,
): {
  delegators: AgentId[];
  targets: AgentId[];
  actions: Array<"ASSIGN_TASK" | "RELAY_DIRECTIVE">;
  objectiveIds: string[];
  taskIds: string[];
  fileGlobs: string[];
  expiresAt: string;
} {
  const expiresAt = new Date(input.expires_at).toISOString();
  if (Date.parse(expiresAt) <= Date.now()) {
    throw new HubError("Delegation expiry must be in the future", 422, "DELEGATION_EXPIRY_INVALID");
  }
  const objectiveIds = canonicalStringSet(input.objective_ids);
  const taskIds = canonicalStringSet(input.task_ids);
  for (const objectiveId of objectiveIds)
    validateScope(ctx, projectId, { objective_id: objectiveId });
  const taskScope = validateScope(ctx, projectId, { task_ids: taskIds });
  if (objectiveIds.length > 0) {
    const lookup = ctx.sqlite.prepare("SELECT objective_id FROM tasks WHERE id = ?");
    for (const taskId of taskScope.task_ids) {
      const task = lookup.get(taskId) as { objective_id: string };
      if (!objectiveIds.includes(task.objective_id)) {
        throw new HubError(
          `Delegation task is outside its objective set: ${taskId}`,
          422,
          "DELEGATION_SCOPE_INVALID",
        );
      }
    }
  }
  return {
    delegators: canonicalStringSet(input.delegator_agent_ids) as AgentId[],
    targets: canonicalStringSet(input.target_agent_ids) as AgentId[],
    actions: canonicalStringSet(input.allowed_actions) as Array<"ASSIGN_TASK" | "RELAY_DIRECTIVE">,
    objectiveIds,
    taskIds,
    fileGlobs: canonicalFileGlobs(input.file_globs),
    expiresAt,
  };
}

function appendDelegationEvent(
  ctx: StoreContext,
  mutation: MutationContext,
  input: {
    projectId: string;
    grantId: string;
    version: number;
    type: "ISSUED" | "MODIFIED" | "TERMINATED" | "EXPIRED";
    principalId: string;
    actorType: "user" | "system";
    causationId: string | null;
    correlationId: string;
    payload: unknown;
  },
): void {
  const principal = ctx.sqlite
    .prepare("SELECT display_name FROM auth_principals WHERE id = ?")
    .get(input.principalId) as { display_name: string } | undefined;
  if (!principal) throw new NotFoundError("Delegation event actor principal", input.principalId);
  const event = mutation.emit({
    projectId: input.projectId,
    type: `delegation.${input.type.toLowerCase()}`,
    actorType: input.actorType,
    actorId: principal.display_name,
    aggregateType: "delegation_grant",
    aggregateId: input.grantId,
    causationId: input.causationId,
    correlationId: input.correlationId,
    payload: input.payload,
  });
  ctx.sqlite
    .prepare(
      `INSERT INTO delegation_events(
         id, project_id, grant_id, grant_version, event_type, actor_principal_id,
         actor_session_id, server_sequence, event_id, causation_id, correlation_id,
         payload_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      createId("dev"),
      input.projectId,
      input.grantId,
      input.version,
      input.type,
      input.principalId,
      event.sequence,
      event.id,
      input.causationId,
      input.correlationId,
      JSON.stringify(input.payload),
      event.createdAt,
    );
}

function materializeDelegationExpiry(ctx: StoreContext, row: GrantVersionRow): void {
  if (Date.parse(row.expires_at) > Date.now()) return;
  const terminal = ctx.sqlite
    .prepare(
      `SELECT 1 FROM delegation_events
       WHERE grant_id = ? AND event_type IN ('TERMINATED', 'EXPIRED') LIMIT 1`,
    )
    .get(row.grant_id);
  if (terminal) return;
  ctx.mutate(
    row.project_id,
    `delegation-expire:${createId("mut")}`,
    "delegation.expire",
    ({ emit }) => {
      const current = latestGrantRow(ctx, row.grant_id);
      const currentTerminal = ctx.sqlite
        .prepare(
          `SELECT 1 FROM delegation_events
           WHERE grant_id = ? AND event_type IN ('TERMINATED', 'EXPIRED') LIMIT 1`,
        )
        .get(row.grant_id);
      if (currentTerminal || Date.parse(current.expires_at) > Date.now()) {
        return { grantId: current.grant_id };
      }
      appendDelegationEvent(
        ctx,
        { emit },
        {
          projectId: current.project_id,
          grantId: current.grant_id,
          version: current.version,
          type: "EXPIRED",
          principalId: AUTHORITY_SYSTEM_PRINCIPAL_ID,
          actorType: "system",
          causationId: current.grant_id,
          correlationId: current.grant_id,
          payload: { expiresAt: current.expires_at },
        },
      );
      const delegated = ctx.sqlite
        .prepare("SELECT * FROM authority_directives WHERE delegation_grant_id = ?")
        .all(current.grant_id) as DirectiveRow[];
      for (const directive of delegated) {
        if (terminalEvent(ctx, directive.id)) continue;
        appendAuthorityEvent(
          ctx,
          { emit },
          {
            directiveId: directive.id,
            projectId: directive.project_id,
            type: "EXPIRED",
            actorPrincipalId: AUTHORITY_SYSTEM_PRINCIPAL_ID,
            actorSessionId: null,
            fromLifecycle: "ACTIVE",
            toLifecycle: "EXPIRED",
            causationId: current.grant_id,
            correlationId: directive.correlation_id,
            payload: { delegationGrantId: current.grant_id, expiresAt: current.expires_at },
          },
        );
      }
      return { grantId: current.grant_id };
    },
    {
      requestFingerprint: mutationFingerprint({
        grantId: row.grant_id,
        grantVersion: row.version,
        expiresAt: row.expires_at,
      }),
    },
  );
}

function insertGrantVersion(
  ctx: StoreContext,
  input: {
    grantId: string;
    version: number;
    supersedesVersion: number | null;
    principalId: string;
    issuedAt: string;
    terms: ReturnType<typeof validateGrantTerms>;
    source: CreateDelegationGrantInput | ModifyDelegationGrantInput;
  },
): void {
  ctx.sqlite
    .prepare(
      `INSERT INTO delegation_grant_versions(
         grant_id, version, delegator_agent_ids_json, target_agent_ids_json,
         allowed_actions_json, objective_ids_json, task_ids_json, file_globs_json,
         max_priority, expires_at, issued_at, issued_by_principal_id, supersedes_version
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.grantId,
      input.version,
      JSON.stringify(input.terms.delegators),
      JSON.stringify(input.terms.targets),
      JSON.stringify(input.terms.actions),
      JSON.stringify(input.terms.objectiveIds),
      JSON.stringify(input.terms.taskIds),
      JSON.stringify(input.terms.fileGlobs),
      input.source.max_priority,
      input.terms.expiresAt,
      input.issuedAt,
      input.principalId,
      input.supersedesVersion,
    );
}

export function createDelegationGrant(
  ctx: StoreContext,
  principal: RequestPrincipal,
  projectId: string,
  input: CreateDelegationGrantInput,
): DelegationGrant {
  assertDashboard(ctx, principal);
  const cached = ctx.mutate(
    projectId,
    input.idempotency_key,
    "delegation.create",
    ({ emit }) => {
      const terms = validateGrantTerms(ctx, projectId, input);
      if (input.source_user_turn_id) {
        const turn = ctx.sqlite
          .prepare("SELECT project_id FROM user_turns WHERE id = ?")
          .get(input.source_user_turn_id) as { project_id: string } | undefined;
        if (!turn || turn.project_id !== projectId) {
          throw new HubError(
            "Delegation source user turn does not belong to the project",
            422,
            "DELEGATION_SOURCE_INVALID",
          );
        }
      }
      const grantId = createId("grt");
      const issuedAt = nowIso();
      ctx.sqlite
        .prepare(
          `INSERT INTO delegation_grants(
             id, project_id, source_user_turn_id, created_by_principal_id, created_at
           ) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(grantId, projectId, input.source_user_turn_id ?? null, principal.id, issuedAt);
      insertGrantVersion(ctx, {
        grantId,
        version: 1,
        supersedesVersion: null,
        principalId: principal.id,
        issuedAt,
        terms,
        source: input,
      });
      appendDelegationEvent(
        ctx,
        { emit },
        {
          projectId,
          grantId,
          version: 1,
          type: "ISSUED",
          principalId: principal.id,
          actorType: "user",
          causationId: input.source_user_turn_id ?? null,
          correlationId: grantId,
          payload: { version: 1 },
        },
      );
      return { grantId };
    },
    { requestFingerprint: mutationFingerprint({ projectId, principalId: principal.id, input }) },
  );
  return getDelegationGrant(ctx, cached.grantId);
}

function revokeDelegatedDirectives(
  ctx: StoreContext,
  mutation: MutationContext,
  grantId: string,
  principalId: string,
  reason: string,
  correlationId: string,
): void {
  const rows = ctx.sqlite
    .prepare("SELECT * FROM authority_directives WHERE delegation_grant_id = ?")
    .all(grantId) as DirectiveRow[];
  for (const row of rows) {
    if (lifecycleFor(ctx, row) !== "ACTIVE") continue;
    appendAuthorityEvent(ctx, mutation, {
      directiveId: row.id,
      projectId: row.project_id,
      type: "REVOKED",
      actorPrincipalId: principalId,
      actorSessionId: null,
      fromLifecycle: "ACTIVE",
      toLifecycle: "REVOKED",
      causationId: grantId,
      correlationId,
      payload: { reason, delegationGrantId: grantId },
    });
  }
}

export function modifyDelegationGrant(
  ctx: StoreContext,
  principal: RequestPrincipal,
  grantId: string,
  input: ModifyDelegationGrantInput,
): DelegationGrant {
  assertDashboard(ctx, principal);
  const before = latestGrantRow(ctx, grantId);
  materializeDelegationExpiry(ctx, before);
  const cached = ctx.mutate(
    before.project_id,
    input.idempotency_key,
    "delegation.modify",
    ({ emit }) => {
      const terms = validateGrantTerms(ctx, before.project_id, input);
      const current = latestGrantRow(ctx, grantId);
      if (grantStatus(ctx, current) !== "ACTIVE") {
        throw new ConflictError("Only an ACTIVE delegation grant can be modified");
      }
      if (current.version !== input.expected_version) {
        throw new ConflictError("Delegation grant version changed", grantFromRow(ctx, current));
      }
      const version = current.version + 1;
      const issuedAt = nowIso();
      insertGrantVersion(ctx, {
        grantId,
        version,
        supersedesVersion: current.version,
        principalId: principal.id,
        issuedAt,
        terms,
        source: input,
      });
      appendDelegationEvent(
        ctx,
        { emit },
        {
          projectId: current.project_id,
          grantId,
          version,
          type: "MODIFIED",
          principalId: principal.id,
          actorType: "user",
          causationId: grantId,
          correlationId: grantId,
          payload: { version, supersedesVersion: current.version },
        },
      );
      revokeDelegatedDirectives(
        ctx,
        { emit },
        grantId,
        principal.id,
        "Delegation grant was modified",
        grantId,
      );
      return { grantId };
    },
    {
      requestFingerprint: mutationFingerprint({ grantId, principalId: principal.id, input }),
      validateReplay: () => {
        const replay = latestGrantRow(ctx, grantId);
        if (replay.version < input.expected_version + 1) {
          throw new ConflictError("Delegation modification is no longer current");
        }
      },
    },
  );
  return getDelegationGrant(ctx, cached.grantId);
}

export function terminateDelegationGrant(
  ctx: StoreContext,
  principal: RequestPrincipal,
  grantId: string,
  input: TerminateDelegationGrantInput,
): DelegationGrant {
  assertDashboard(ctx, principal);
  const before = latestGrantRow(ctx, grantId);
  materializeDelegationExpiry(ctx, before);
  const cached = ctx.mutate(
    before.project_id,
    input.idempotency_key,
    "delegation.terminate",
    ({ emit }) => {
      const current = latestGrantRow(ctx, grantId);
      if (grantStatus(ctx, current) !== "ACTIVE") {
        throw new ConflictError("Only an ACTIVE delegation grant can be terminated");
      }
      if (current.version !== input.expected_version) {
        throw new ConflictError("Delegation grant version changed", grantFromRow(ctx, current));
      }
      appendDelegationEvent(
        ctx,
        { emit },
        {
          projectId: current.project_id,
          grantId,
          version: current.version,
          type: "TERMINATED",
          principalId: principal.id,
          actorType: "user",
          causationId: grantId,
          correlationId: grantId,
          payload: { reason: input.reason },
        },
      );
      revokeDelegatedDirectives(ctx, { emit }, grantId, principal.id, input.reason, grantId);
      return { grantId };
    },
    { requestFingerprint: mutationFingerprint({ grantId, principalId: principal.id, input }) },
  );
  return getDelegationGrant(ctx, cached.grantId);
}

function setIsSubset<T extends string>(candidate: readonly T[], allowed: readonly T[]): boolean {
  const allowedSet = new Set(allowed);
  return candidate.every((value) => allowedSet.has(value));
}

export function delegateInstruction(
  ctx: StoreContext,
  signer: AuthorityAttestationService,
  principal: RequestPrincipal,
  projectId: string,
  input: DelegateInstructionInput,
): AuthorityDirective {
  const relay = relayTicketIdentity(ctx, principal, projectId);
  const agentId = relay.agentId;
  const audience = canonicalStringSet(input.target_agent_ids) as AgentId[];
  const grantPreflight = latestGrantRow(ctx, input.delegation_grant_id);
  if (grantPreflight.project_id !== projectId) {
    throw new NotFoundError("Delegation grant", input.delegation_grant_id);
  }
  materializeDelegationExpiry(ctx, grantPreflight);
  const cached = ctx.mutate(
    projectId,
    input.idempotency_key,
    "directive.delegate",
    ({ emit }) => {
      const scope = validateScope(ctx, projectId, input);
      const requestedExpiry = normalizedExpiry(input.expires_at);
      assertFutureExpiry(requestedExpiry);
      const grantRow = latestGrantRow(ctx, input.delegation_grant_id);
      if (grantRow.project_id !== projectId) {
        throw new NotFoundError("Delegation grant", input.delegation_grant_id);
      }
      const grant = grantFromRow(ctx, grantRow);
      const action = scope.task_ids.length > 0 ? "ASSIGN_TASK" : "RELAY_DIRECTIVE";
      const delegatedExpiry = requestedExpiry ?? grant.expiresAt;
      const reasons: string[] = [];
      if (!scope.objective_id && scope.task_ids.length === 0 && scope.file_globs.length === 0) {
        reasons.push("delegated instruction has no bounded scope");
      }
      if (
        grant.objectiveIds.length === 0 &&
        grant.taskIds.length === 0 &&
        grant.fileGlobs.length === 0
      ) {
        reasons.push("grant authorizes no objective, task, or file scope");
      }
      if (grant.objectiveIds.length > 0 && !scope.objective_id) {
        reasons.push("delegated instruction omits the grant objective scope");
      }
      if (grant.taskIds.length > 0 && scope.task_ids.length === 0) {
        reasons.push("delegated instruction omits the grant task scope");
      }
      if (grant.fileGlobs.length > 0 && scope.file_globs.length === 0) {
        reasons.push("delegated instruction omits the grant file scope");
      }
      if (grant.status !== "ACTIVE") reasons.push(`grant is ${grant.status}`);
      if (!grant.delegatorAgentIds.includes(agentId))
        reasons.push("relay Agent is not a delegator");
      if (!setIsSubset(audience, grant.targetAgentIds))
        reasons.push("audience exceeds grant targets");
      if (!grant.allowedActions.includes(action)) reasons.push(`grant does not allow ${action}`);
      if (scope.objective_id && !grant.objectiveIds.includes(scope.objective_id)) {
        reasons.push("objective exceeds grant scope");
      }
      if (!setIsSubset(scope.task_ids, grant.taskIds)) reasons.push("tasks exceed grant scope");
      if (!setIsSubset(scope.file_globs, grant.fileGlobs))
        reasons.push("file globs exceed grant scope");
      if (priorityRank[input.priority] > priorityRank[grant.maxPriority]) {
        reasons.push("priority exceeds grant scope");
      }
      if (Date.parse(delegatedExpiry) > Date.parse(grant.expiresAt)) {
        reasons.push("expiry exceeds grant lifetime");
      }
      const authority: DirectiveAuthority =
        reasons.length === 0 ? "USER_DELEGATED" : "AGENT_PROPOSAL";
      const issuedExpiry = authority === "USER_DELEGATED" ? delegatedExpiry : requestedExpiry;
      const directiveId = createId("dir");
      issueDirective(
        ctx,
        signer,
        { emit },
        {
          projectId,
          directiveId,
          authority,
          source: null,
          quote: null,
          delegatedText: input.delegated_text,
          interpretation: null,
          relayPrincipalId: principal.id,
          relayAgentId: agentId,
          relaySessionId: relay.sessionId,
          targetAgentIds: audience,
          scope,
          priority: input.priority,
          // Sign the complete grant bounds, not merely an id/version pointer. The target Adapter
          // then compares this immutable projection with the live grant before accepting it.
          grant: authority === "USER_DELEGATED" ? grant : null,
          attemptedGrant:
            authority === "AGENT_PROPOSAL" ? { id: grant.id, version: grant.version } : null,
          supersedesDirectiveId: null,
          supersedeReason: null,
          issuanceActorPrincipalId: null,
          issuanceActorSessionId: relay.sessionId,
          expiresAt: issuedExpiry,
          downgradeReason: reasons.length > 0 ? reasons.join("; ") : null,
          causationId: grant.id,
          correlationId: directiveId,
        },
      );
      return { directiveId };
    },
    {
      requestFingerprint: mutationFingerprint({ projectId, principalId: principal.id, input }),
    },
  );
  return getDirective(ctx, signer, cached.directiveId);
}

export function revokeDirective(
  ctx: StoreContext,
  signer: AuthorityAttestationService,
  principal: RequestPrincipal,
  directiveId: string,
  input: DirectiveLifecycleMutationInput,
): AuthorityDirective {
  assertDashboard(ctx, principal);
  const before = getDirective(ctx, signer, directiveId);
  const cached = ctx.mutate(
    before.projectId,
    input.idempotency_key,
    "directive.revoke",
    ({ emit }) => {
      const row = ctx.sqlite
        .prepare("SELECT * FROM authority_directives WHERE id = ?")
        .get(directiveId) as DirectiveRow;
      if (lifecycleFor(ctx, row) !== "ACTIVE") {
        throw new ConflictError("Only an ACTIVE directive can be revoked");
      }
      appendAuthorityEvent(
        ctx,
        { emit },
        {
          directiveId,
          projectId: row.project_id,
          type: "REVOKED",
          actorPrincipalId: principal.id,
          actorSessionId: null,
          fromLifecycle: "ACTIVE",
          toLifecycle: "REVOKED",
          correlationId: row.correlation_id,
          payload: { reason: input.reason },
        },
      );
      return { directiveId };
    },
    { requestFingerprint: mutationFingerprint({ directiveId, principalId: principal.id, input }) },
  );
  return getDirective(ctx, signer, cached.directiveId);
}

export function recordExecutionResult(
  ctx: StoreContext,
  signer: AuthorityAttestationService,
  principal: RequestPrincipal,
  directiveId: string,
  input: DirectiveExecutionResultInput,
): AuthorityDirective {
  const before = getDirective(ctx, signer, directiveId);
  const relay = relayTicketIdentity(ctx, principal, before.projectId);
  const cached = ctx.mutate(
    before.projectId,
    input.idempotency_key,
    "directive.result",
    ({ emit }) => {
      const row = ctx.sqlite
        .prepare("SELECT * FROM authority_directives WHERE id = ?")
        .get(directiveId) as DirectiveRow;
      // The caller may not choose another same-Agent session as the apparent result actor. A
      // successor that continues work after handoff must first record its own PROCESSED fact, then
      // submit the result as itself. This keeps authenticated reporter and processor provenance
      // identical until a future schema explicitly represents both roles.
      const session = getSession(ctx, input.session_id);
      const targets = json<AgentId[]>(row.target_agent_ids_json, []);
      if (
        session.id !== relay.sessionId ||
        session.projectId !== row.project_id ||
        session.agentId !== relay.agentId ||
        !targets.includes(session.agentId as AgentId)
      ) {
        throw new ForbiddenError("Session is not in this directive's audience");
      }
      const existingResult = ctx.sqlite
        .prepare(
          `SELECT id, status, summary FROM directive_execution_results
           WHERE directive_id = ? AND target_agent_id = ?`,
        )
        .get(directiveId, session.agentId) as
        { id: string; status: string; summary: string } | undefined;
      if (existingResult) {
        throw new ConflictError(
          "An execution result is already recorded for this directive target",
          existingResult,
        );
      }
      const lifecycle = lifecycleFor(ctx, row);
      const terminal =
        lifecycle === "ACTIVE"
          ? undefined
          : (ctx.sqlite
              .prepare(
                `SELECT event_type, server_sequence FROM authority_events
                 WHERE directive_id = ?
                   AND event_type IN ('SUPERSEDED', 'REVOKED', 'COMPLETED', 'EXPIRED')
                 ORDER BY server_sequence DESC LIMIT 1`,
              )
              .get(directiveId) as { event_type: string; server_sequence: number } | undefined);
      const processed = ctx.sqlite
        .prepare(
          `SELECT server_sequence FROM authority_events
           WHERE directive_id = ? AND target_agent_id = ? AND event_type = 'PROCESSED'
             AND actor_session_id = ?`,
        )
        .get(directiveId, session.agentId, session.id) as { server_sequence: number } | undefined;
      if (!processed) {
        throw new HubError(
          "Directive must be processed through its exact delivery surface before recording a result",
          409,
          "DIRECTIVE_NOT_PROCESSED",
        );
      }
      if (
        lifecycle !== "ACTIVE" &&
        (!terminal || processed.server_sequence >= terminal.server_sequence)
      ) {
        throw new ConflictError(
          "A terminal directive only accepts a delayed result for processing recorded before termination",
        );
      }
      const resultPayload = {
        targetAgentId: session.agentId,
        sessionId: session.id,
        status: input.status,
        summary: input.summary,
        evidence: input.evidence,
      };
      const event = emit({
        projectId: row.project_id,
        type: "directive.result_recorded",
        actorType: "agent",
        actorId: session.agentId,
        aggregateType: "authority_directive",
        aggregateId: directiveId,
        causationId: row.carrier_message_id,
        correlationId: row.correlation_id,
        payload: resultPayload,
      });
      ctx.sqlite
        .prepare(
          `INSERT INTO authority_events(
             id, project_id, directive_id, event_type, actor_principal_id, actor_session_id,
             target_agent_id, server_sequence, event_id, from_lifecycle, to_lifecycle,
             causation_id, correlation_id, payload_json, created_at
           ) VALUES (?, ?, ?, 'RESULT_RECORDED', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          createId("aev"),
          row.project_id,
          directiveId,
          session.id,
          session.agentId,
          event.sequence,
          event.id,
          lifecycle,
          lifecycle,
          row.carrier_message_id,
          row.correlation_id,
          JSON.stringify(resultPayload),
          event.createdAt,
        );
      ctx.sqlite
        .prepare(
          `INSERT INTO directive_execution_results(
             id, project_id, directive_id, target_agent_id, session_id, status,
             summary, evidence_json, server_sequence, event_id, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          createId("der"),
          row.project_id,
          directiveId,
          session.agentId,
          session.id,
          input.status,
          input.summary,
          JSON.stringify(input.evidence),
          event.sequence,
          event.id,
          event.createdAt,
        );
      const resultCount = ctx.sqlite
        .prepare(
          "SELECT COUNT(DISTINCT target_agent_id) AS count FROM directive_execution_results WHERE directive_id = ?",
        )
        .get(directiveId) as { count: number };
      if (lifecycle === "ACTIVE" && resultCount.count === targets.length) {
        appendAuthorityEvent(
          ctx,
          { emit },
          {
            directiveId,
            projectId: row.project_id,
            type: "COMPLETED",
            actorPrincipalId: null,
            actorSessionId: session.id,
            targetAgentId: session.agentId as AgentId,
            fromLifecycle: "ACTIVE",
            toLifecycle: "COMPLETED",
            causationId: event.id,
            correlationId: row.correlation_id,
            payload: { completedTargetAgentIds: targets },
          },
        );
      }
      return { directiveId };
    },
    { requestFingerprint: mutationFingerprint({ directiveId, principalId: principal.id, input }) },
  );
  return getDirective(ctx, signer, cached.directiveId);
}
