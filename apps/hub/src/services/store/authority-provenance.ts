import { createHash } from "node:crypto";
import {
  AuthorityDirectiveProvenanceSchema,
  AuthorityDirectiveSummaryPageSchema,
  AuthorityDirectiveSummarySchema,
  DelegationGrantProvenanceSchema,
  DirectiveAttestationSchema,
  UserTurnDetailSchema,
  UserTurnSummaryPageSchema,
  canonicalJson,
  type AuthorityDirectiveProvenance,
  type AuthorityDirectiveSummary,
  type AuthorityDirectiveSummaryPage,
  type AuthoritySupersessionChain,
  type AuthorityTimelineEvent,
  type DelegationGrant,
  type DelegationGrantProvenance,
  type UserTurnDetail,
  type UserTurnSummary,
  type UserTurnSummaryPage,
} from "@crossagent/protocol";
import type Database from "better-sqlite3";
import { HubError, NotFoundError } from "../../domain/errors.js";

type AgentId = "codex" | "claude";
type DirectiveAuthority = "USER_ATTESTED" | "USER_DELEGATED" | "AGENT_PROPOSAL";
type Lifecycle = "ACTIVE" | "SUPERSEDED" | "REVOKED" | "COMPLETED" | "EXPIRED";

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
  priority: "BACKGROUND" | "NORMAL" | "IMPORTANT" | "INTERRUPT";
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

type UserTurnRow = {
  id: string;
  project_id: string;
  source_principal_id: string;
  source_credential_id: string;
  source_session_ticket_id: string | null;
  source_binding_id: string;
  source_hub_session_id: string;
  client_type: "codex" | "claude";
  source_session_id: string;
  source_turn_id: string | null;
  cwd: string;
  raw_text: string;
  raw_text_sha256: string;
  captured_at: string;
  received_at: string;
  correlation_id: string | null;
};
type UserTurnSummaryRow = Omit<UserTurnRow, "raw_text">;

const MAX_USER_TURN_DIRECTIVES = 200;
const MAX_SUPERSESSION_NODES = 100;
const MAX_DELEGATION_VERSIONS = 100;
const MAX_DELEGATION_EVENTS = 500;
const MAX_DIRECTIVE_TIMELINE_EVENTS = 1000;

type AuthorityEventRow = {
  id: string;
  project_id: string;
  directive_id: string;
  event_type:
    | "ISSUED"
    | "DELIVERED"
    | "ACKNOWLEDGED"
    | "PROCESSED"
    | "RESULT_RECORDED"
    | "SUPERSEDED"
    | "REVOKED"
    | "COMPLETED"
    | "EXPIRED";
  actor_principal_id: string | null;
  actor_session_id: string | null;
  target_agent_id: AgentId | null;
  server_sequence: number;
  event_id: string;
  from_lifecycle: Lifecycle | null;
  to_lifecycle: Lifecycle | null;
  causation_id: string | null;
  correlation_id: string;
  payload_json: string;
  created_at: string;
};

type DelegationVersionRow = {
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
  max_priority: "BACKGROUND" | "NORMAL" | "IMPORTANT" | "INTERRUPT";
  expires_at: string;
  issued_at: string;
  issued_by_principal_id: string;
  supersedes_version: number | null;
};

type DelegationEventRow = {
  id: string;
  project_id: string;
  grant_id: string;
  grant_version: number;
  event_type: "ISSUED" | "MODIFIED" | "TERMINATED" | "EXPIRED";
  actor_principal_id: string;
  actor_session_id: string | null;
  server_sequence: number;
  event_id: string;
  causation_id: string | null;
  correlation_id: string;
  payload_json: string;
  created_at: string;
};

type CursorKind = "DIRECTIVES" | "USER_TURNS";
type CursorPayload = {
  v: 1;
  kind: CursorKind;
  projectId: string;
  snapshotSequence: number;
  afterSequence: number;
  afterId: string;
};

export type AuthorityPageQuery = {
  projectId: string;
  pageSize?: number;
  cursor?: string | null;
};

export class AuthorityProvenanceIntegrityError extends HubError {
  constructor(message: string, current?: unknown) {
    super(message, 409, "AUTHORITY_PROVENANCE_INTEGRITY_FAILED", current);
    this.name = "AuthorityProvenanceIntegrityError";
  }
}

function integrity(message: string, current?: unknown): never {
  throw new AuthorityProvenanceIntegrityError(message, current);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function parseJson<T>(value: string, label: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return integrity(`${label} is not valid JSON`);
  }
}

function parseModel<T>(schema: { parse(value: unknown): T }, value: unknown, label: string): T {
  try {
    return schema.parse(value);
  } catch (error) {
    return integrity(`${label} violates the Authority read-model contract`, {
      reason: error instanceof Error ? error.message : "schema validation failed",
    });
  }
}

function canonicalStringSet(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    return integrity(`${label} is not a string set`);
  }
  const sorted = [...new Set(value)].sort();
  if (sorted.length !== value.length || sorted.some((entry, index) => entry !== value[index])) {
    return integrity(`${label} is not canonical, sorted, and unique`);
  }
  return sorted;
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeCursor(
  cursor: string | null | undefined,
  kind: CursorKind,
  projectId: string,
): CursorPayload | null {
  if (!cursor) return null;
  if (cursor.length > 512 || !/^[A-Za-z0-9_-]+$/u.test(cursor)) {
    throw new HubError("Authority cursor is malformed", 422, "AUTHORITY_CURSOR_INVALID");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new HubError("Authority cursor is malformed", 422, "AUTHORITY_CURSOR_INVALID");
  }
  if (
    !decoded ||
    typeof decoded !== "object" ||
    Array.isArray(decoded) ||
    Object.keys(decoded).sort().join(",") !==
      "afterId,afterSequence,kind,projectId,snapshotSequence,v" ||
    (decoded as CursorPayload).v !== 1 ||
    (decoded as CursorPayload).kind !== kind ||
    (decoded as CursorPayload).projectId !== projectId ||
    !Number.isSafeInteger((decoded as CursorPayload).snapshotSequence) ||
    (decoded as CursorPayload).snapshotSequence < 0 ||
    !Number.isSafeInteger((decoded as CursorPayload).afterSequence) ||
    (decoded as CursorPayload).afterSequence < 0 ||
    typeof (decoded as CursorPayload).afterId !== "string" ||
    (decoded as CursorPayload).afterId.length < 4
  ) {
    throw new HubError("Authority cursor binding is invalid", 422, "AUTHORITY_CURSOR_INVALID");
  }
  return decoded as CursorPayload;
}

function boundedPageSize(value: number | undefined): number {
  const pageSize = value ?? 25;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new HubError(
      "Authority page size must be between 1 and 100",
      422,
      "AUTHORITY_PAGE_SIZE_INVALID",
    );
  }
  return pageSize;
}

/**
 * Builds fail-closed Authority projections without mutating lazy lifecycle state. Every public
 * operation executes in one SQLite read transaction, so a response never combines two WAL views.
 */
export class AuthorityProvenanceStore {
  constructor(private readonly sqlite: Database.Database) {}

  listDirectiveSummaries(query: AuthorityPageQuery): AuthorityDirectiveSummaryPage {
    const pageSize = boundedPageSize(query.pageSize);
    const cursor = decodeCursor(query.cursor, "DIRECTIVES", query.projectId);
    return this.readSnapshot(() => {
      const snapshotSequence = this.snapshotSequence(query.projectId, cursor);
      const rows = this.sqlite
        .prepare(
          `SELECT * FROM authority_directives
           WHERE project_id = ? AND server_sequence <= ?
             AND (? IS NULL OR server_sequence < ? OR (server_sequence = ? AND id < ?))
           ORDER BY server_sequence DESC, id DESC
           LIMIT ?`,
        )
        .all(
          query.projectId,
          snapshotSequence,
          cursor?.afterId ?? null,
          cursor?.afterSequence ?? 0,
          cursor?.afterSequence ?? 0,
          cursor?.afterId ?? "",
          pageSize + 1,
        ) as DirectiveRow[];
      const pageRows = rows.slice(0, pageSize);
      const items = pageRows.map((row) => this.directiveSummary(row, snapshotSequence));
      const last = pageRows.at(-1);
      return parseModel(
        AuthorityDirectiveSummaryPageSchema,
        {
          items,
          pageSize,
          snapshotSequence,
          nextCursor:
            rows.length > pageSize && last
              ? encodeCursor({
                  v: 1,
                  kind: "DIRECTIVES",
                  projectId: query.projectId,
                  snapshotSequence,
                  afterSequence: last.server_sequence,
                  afterId: last.id,
                })
              : null,
        },
        "directive summary page",
      );
    });
  }

  listUserTurnSummaries(query: AuthorityPageQuery): UserTurnSummaryPage {
    const pageSize = boundedPageSize(query.pageSize);
    const cursor = decodeCursor(query.cursor, "USER_TURNS", query.projectId);
    return this.readSnapshot(() => {
      const snapshotSequence = this.snapshotSequence(query.projectId, cursor);
      this.assertProjectUserTurnCaptureCardinality(query.projectId, snapshotSequence);
      const rows = this.sqlite
        .prepare(
          `SELECT turn.id, turn.project_id, turn.source_principal_id,
                  turn.source_credential_id, turn.source_session_ticket_id,
                  turn.source_binding_id, turn.source_hub_session_id, turn.client_type,
                  turn.source_session_id, turn.source_turn_id, turn.cwd,
                  turn.raw_text_sha256, turn.captured_at, turn.received_at,
                  turn.correlation_id, capture.sequence AS capture_sequence
           FROM user_turns turn
           JOIN events capture ON capture.project_id = turn.project_id
             AND capture.type = 'user_turn.captured'
             AND capture.aggregate_type = 'user_turn' AND capture.aggregate_id = turn.id
           WHERE turn.project_id = ? AND capture.sequence <= ?
             AND (? IS NULL OR capture.sequence < ? OR (capture.sequence = ? AND turn.id < ?))
           ORDER BY capture.sequence DESC, turn.id DESC
           LIMIT ?`,
        )
        .all(
          query.projectId,
          snapshotSequence,
          cursor?.afterId ?? null,
          cursor?.afterSequence ?? 0,
          cursor?.afterSequence ?? 0,
          cursor?.afterId ?? "",
          pageSize + 1,
        ) as Array<UserTurnSummaryRow & { capture_sequence: number }>;
      const pageRows = rows.slice(0, pageSize);
      const items = pageRows.map((row) => this.userTurnSummary(row, snapshotSequence));
      const last = pageRows.at(-1);
      return parseModel(
        UserTurnSummaryPageSchema,
        {
          items,
          pageSize,
          snapshotSequence,
          nextCursor:
            rows.length > pageSize && last
              ? encodeCursor({
                  v: 1,
                  kind: "USER_TURNS",
                  projectId: query.projectId,
                  snapshotSequence,
                  afterSequence: last.capture_sequence,
                  afterId: last.id,
                })
              : null,
        },
        "user-turn summary page",
      );
    });
  }

  getDirectiveProvenance(projectId: string, directiveId: string): AuthorityDirectiveProvenance {
    return this.readSnapshot(() => {
      const snapshotSequence = this.snapshotSequence(projectId, null);
      const row = this.directiveRow(projectId, directiveId, snapshotSequence);
      const summary = this.directiveSummary(row, snapshotSequence);
      const supersession = this.supersessionChain(projectId, row, snapshotSequence);
      const sourceUserTurn = row.source_user_turn_id
        ? this.userTurnDetail(
            this.userTurnRow(projectId, row.source_user_turn_id, snapshotSequence),
            snapshotSequence,
          )
        : null;
      const grantId = row.delegation_grant_id ?? row.attempted_delegation_grant_id;
      const grantVersion = row.delegation_version ?? row.attempted_delegation_version;
      const delegationGrant = grantId
        ? this.delegationProvenance(projectId, grantId, grantVersion ?? 0, snapshotSequence)
        : null;
      const executionResults = this.executionResults(row, snapshotSequence);
      const timeline = this.directiveTimeline(
        row,
        supersession,
        sourceUserTurn,
        delegationGrant,
        snapshotSequence,
      );
      return parseModel(
        AuthorityDirectiveProvenanceSchema,
        {
          summary,
          authoritativeContent: {
            kind: row.authority,
            verbatimText: row.authority === "USER_ATTESTED" ? row.verbatim_text : null,
            delegatedText: row.authority === "USER_DELEGATED" ? row.delegated_text : null,
            proposedText: row.authority === "AGENT_PROPOSAL" ? row.delegated_text : null,
            agentInterpretation: row.agent_interpretation,
            downgradeReason: row.authority === "AGENT_PROPOSAL" ? row.downgrade_reason : null,
          },
          sourceUserTurn,
          delegationGrant,
          scopeProjection: this.scopeProjection(row.project_id, summary.scope),
          executionResults,
          timeline,
          supersession,
          integrity: "COMPLETE",
        },
        "directive provenance",
      );
    });
  }

  getDelegationGrantProvenance(
    projectId: string,
    grantId: string,
    referencedVersion?: number,
  ): DelegationGrantProvenance {
    return this.readSnapshot(() => {
      const snapshotSequence = this.snapshotSequence(projectId, null);
      return this.delegationProvenance(projectId, grantId, referencedVersion, snapshotSequence);
    });
  }

  private readSnapshot<T>(read: () => T): T {
    return this.sqlite.transaction(read).deferred();
  }

  private snapshotSequence(projectId: string, cursor: CursorPayload | null): number {
    const row = this.sqlite
      .prepare("SELECT current_sequence FROM projects WHERE id = ?")
      .get(projectId) as { current_sequence: number } | undefined;
    if (!row) throw new NotFoundError("Project", projectId);
    if (cursor && cursor.snapshotSequence > row.current_sequence) {
      throw new HubError(
        "Authority cursor snapshot is from an impossible future",
        422,
        "AUTHORITY_CURSOR_INVALID",
      );
    }
    return cursor?.snapshotSequence ?? row.current_sequence;
  }

  private directiveRow(
    projectId: string,
    directiveId: string,
    snapshotSequence: number,
  ): DirectiveRow {
    const row = this.sqlite
      .prepare("SELECT * FROM authority_directives WHERE id = ? AND server_sequence <= ?")
      .get(directiveId, snapshotSequence) as DirectiveRow | undefined;
    if (!row) throw new NotFoundError("Authority directive", directiveId);
    if (row.project_id !== projectId) {
      return integrity("Directive provenance crosses project boundary", { directiveId, projectId });
    }
    return row;
  }

  private userTurnRow(
    projectId: string,
    userTurnId: string,
    snapshotSequence: number,
  ): UserTurnRow {
    const rows = this.sqlite
      .prepare(
        `SELECT turn.* FROM user_turns turn
         JOIN events capture ON capture.project_id = turn.project_id
           AND capture.type = 'user_turn.captured'
           AND capture.aggregate_type = 'user_turn' AND capture.aggregate_id = turn.id
         WHERE turn.id = ? AND capture.sequence <= ? LIMIT 2`,
      )
      .all(userTurnId, snapshotSequence) as UserTurnRow[];
    if (rows.length !== 1) {
      return integrity("Directive source user turn is missing or has duplicate captures", {
        userTurnId,
      });
    }
    const row = rows[0]!;
    if (row.project_id !== projectId) {
      return integrity("User-turn provenance crosses project boundary", { userTurnId, projectId });
    }
    return row;
  }

  private assertProjectUserTurnCaptureCardinality(
    projectId: string,
    snapshotSequence: number,
  ): void {
    const missing = this.sqlite
      .prepare(
        `SELECT turn.id
         FROM user_turns turn
         LEFT JOIN events capture ON capture.project_id = turn.project_id
           AND capture.type = 'user_turn.captured'
           AND capture.aggregate_type = 'user_turn' AND capture.aggregate_id = turn.id
         WHERE turn.project_id = ?
         GROUP BY turn.id HAVING COUNT(capture.id) = 0 LIMIT 1`,
      )
      .get(projectId) as { id: string } | undefined;
    if (missing) integrity("User turn has no immutable capture event", missing);
    const broken = this.sqlite
      .prepare(
        `SELECT turn.id, COUNT(capture.id) AS count
         FROM user_turns turn
         JOIN events capture ON capture.project_id = turn.project_id
           AND capture.type = 'user_turn.captured'
           AND capture.aggregate_type = 'user_turn' AND capture.aggregate_id = turn.id
           AND capture.sequence <= ?
         WHERE turn.project_id = ?
         GROUP BY turn.id HAVING COUNT(capture.id) <> 1 LIMIT 1`,
      )
      .get(snapshotSequence, projectId) as { id: string; count: number } | undefined;
    if (broken) integrity("User turn does not have one immutable capture event", broken);
  }

  private userTurnSummary(row: UserTurnSummaryRow, snapshotSequence: number): UserTurnSummary {
    this.assertUserTurnBindings(row, snapshotSequence);
    const directiveRows = this.sqlite
      .prepare(
        `SELECT id, project_id FROM authority_directives
         WHERE source_user_turn_id = ? AND server_sequence <= ?
         ORDER BY id LIMIT ?`,
      )
      .all(row.id, snapshotSequence, MAX_USER_TURN_DIRECTIVES + 1) as Array<{
      id: string;
      project_id: string;
    }>;
    if (directiveRows.length > MAX_USER_TURN_DIRECTIVES) {
      integrity("User turn references more directives than the bounded read model", row.id);
    }
    if (directiveRows.some((entry) => entry.project_id !== row.project_id)) {
      integrity("User-turn directive provenance crosses project boundary", row.id);
    }
    const directiveIds = directiveRows.map((entry) => entry.id);
    return parseModel(
      { parse: (value: unknown) => UserTurnSummaryPageSchema.shape.items.element.parse(value) },
      {
        id: row.id,
        projectId: row.project_id,
        authorityClass: { kind: "USER_TURN", authority: "USER_DIRECT" },
        sourcePrincipalId: row.source_principal_id,
        sourceCredentialId: row.source_credential_id,
        sourceBindingId: row.source_binding_id,
        sourceHubSessionId: row.source_hub_session_id,
        sourceSessionTicketId: row.source_session_ticket_id,
        clientType: row.client_type,
        sessionId: row.source_session_id,
        turnId: row.source_turn_id,
        cwd: row.cwd,
        rawTextSha256: row.raw_text_sha256,
        capturedAt: row.captured_at,
        receivedAt: row.received_at,
        correlationId: row.correlation_id,
        directiveIds,
      },
      "user-turn summary",
    );
  }

  private userTurnDetail(row: UserTurnRow, snapshotSequence: number): UserTurnDetail {
    const summary = this.userTurnSummary(row, snapshotSequence);
    const { directiveIds: _directiveIds, ...base } = summary;
    if (sha256(row.raw_text) !== row.raw_text_sha256) {
      integrity("User-turn raw text hash does not match the immutable source", {
        userTurnId: row.id,
      });
    }
    return parseModel(UserTurnDetailSchema, { ...base, rawText: row.raw_text }, "user-turn detail");
  }

  private assertUserTurnBindings(row: UserTurnSummaryRow, snapshotSequence: number): void {
    const binding = this.sqlite
      .prepare(
        `SELECT binding.project_id, binding.principal_id, binding.credential_id,
                binding.session_ticket_id, binding.client_type, binding.source_session_id,
                binding.hub_session_id, principal.kind, principal.client_type AS principal_client,
                session.project_id AS session_project, session.agent_id, session.external_session_id
         FROM capture_session_bindings binding
         JOIN auth_principals principal ON principal.id = binding.principal_id
         JOIN agent_sessions session ON session.id = binding.hub_session_id
         WHERE binding.id = ?`,
      )
      .get(row.source_binding_id) as Record<string, unknown> | undefined;
    if (
      !binding ||
      binding.project_id !== row.project_id ||
      binding.principal_id !== row.source_principal_id ||
      binding.credential_id !== row.source_credential_id ||
      binding.session_ticket_id !== row.source_session_ticket_id ||
      binding.client_type !== row.client_type ||
      binding.source_session_id !== row.source_session_id ||
      binding.hub_session_id !== row.source_hub_session_id ||
      binding.kind !== "BRIDGE_CAPTURE" ||
      binding.principal_client !== row.client_type ||
      binding.session_project !== row.project_id ||
      binding.agent_id !== row.client_type ||
      binding.external_session_id !== row.source_session_id
    ) {
      integrity("User-turn capture binding provenance is broken", { userTurnId: row.id });
    }
    const captures = this.sqlite
      .prepare(
        `SELECT * FROM events WHERE project_id = ? AND type = 'user_turn.captured'
         AND aggregate_type = 'user_turn' AND aggregate_id = ?
         AND sequence <= ? LIMIT 2`,
      )
      .all(row.project_id, row.id, snapshotSequence) as Array<Record<string, unknown>>;
    if (captures.length !== 1) integrity("User turn must have exactly one capture event", row.id);
    const capture = captures[0]!;
    const payload = parseJson<Record<string, unknown>>(
      String(capture.payload_json),
      "capture event payload",
    );
    if (
      capture.actor_type !== "system" ||
      capture.actor_id !== row.source_principal_id ||
      capture.causation_id !== null ||
      capture.correlation_id !== (row.correlation_id ?? row.id) ||
      payload.clientType !== row.client_type ||
      payload.sessionId !== row.source_session_id ||
      (payload.turnId ?? null) !== row.source_turn_id ||
      payload.rawTextSha256 !== row.raw_text_sha256 ||
      payload.capturedAt !== row.captured_at
    ) {
      integrity("User-turn capture event is not causally bound to its source", {
        userTurnId: row.id,
      });
    }
  }

  private directiveSummary(row: DirectiveRow, snapshotSequence: number): AuthorityDirectiveSummary {
    const targetAgentIds = canonicalStringSet(
      parseJson(row.target_agent_ids_json, "directive audience"),
      "directive audience",
    ) as AgentId[];
    const scope = parseJson<{
      objective_id: string | null;
      task_ids: string[];
      file_globs: string[];
    }>(row.scope_json, "directive scope");
    this.assertScopeProjection(row.project_id, scope);
    this.assertDirectiveReferences(row, snapshotSequence);
    this.assertDirectiveIssuance(row, targetAgentIds, scope, snapshotSequence);
    const successors = this.sqlite
      .prepare(
        `SELECT id FROM authority_directives
         WHERE supersedes_directive_id = ? AND server_sequence <= ? ORDER BY id LIMIT 2`,
      )
      .all(row.id, snapshotSequence) as Array<{ id: string }>;
    if (successors.length > 1) integrity("Directive supersession chain is forked", row.id);
    const successor = successors[0]
      ? this.directiveRow(row.project_id, successors[0].id, snapshotSequence)
      : null;
    this.assertImmediateSuccessorTerminal(row, successor, snapshotSequence);
    const lifecycle = this.directiveLifecycle(row, snapshotSequence);
    const executionResultStatuses = (
      this.sqlite
        .prepare(
          `SELECT target_agent_id, status FROM directive_execution_results
           WHERE directive_id = ? AND server_sequence <= ?
           ORDER BY target_agent_id LIMIT 3`,
        )
        .all(row.id, snapshotSequence) as Array<{ target_agent_id: AgentId; status: string }>
    ).map((result) => ({ targetAgentId: result.target_agent_id, status: result.status }));
    if (executionResultStatuses.length > 2) {
      integrity("Directive has more execution results than its bounded audience", row.id);
    }
    const summary = {
      id: row.id,
      projectId: row.project_id,
      authorityClass:
        row.authority === "AGENT_PROPOSAL"
          ? { kind: "UNSIGNED_DIRECTIVE", authority: "AGENT_PROPOSAL" }
          : { kind: "SIGNED_DIRECTIVE", authority: row.authority },
      lifecycle,
      priority: row.priority,
      sourceUserTurnId: row.source_user_turn_id,
      relayAgentId: row.relay_agent_id,
      relaySessionId: row.relay_session_id,
      targetAgentIds,
      scope,
      delegationGrantId: row.delegation_grant_id,
      delegationVersion: row.delegation_version,
      attemptedDelegationGrantId: row.attempted_delegation_grant_id,
      attemptedDelegationVersion: row.attempted_delegation_version,
      supersedesDirectiveId: row.supersedes_directive_id,
      supersededByDirectiveId: successor?.id ?? null,
      carrierMessageId: row.carrier_message_id,
      serverSequence: row.server_sequence,
      issuedAt: row.issued_at,
      expiresAt: row.expires_at,
      causationId: row.causation_id,
      correlationId: row.correlation_id,
      hubIssuance: this.hubIssuance(row, lifecycle, targetAgentIds, scope, snapshotSequence),
      targets: this.targetStates(row, targetAgentIds, snapshotSequence),
      executionResultStatuses,
    };
    return parseModel(AuthorityDirectiveSummarySchema, summary, "directive summary");
  }

  private assertScopeProjection(
    projectId: string,
    scope: { objective_id: string | null; task_ids: string[]; file_globs: string[] },
  ): void {
    canonicalStringSet(scope.task_ids, "directive scope task ids");
    canonicalStringSet(scope.file_globs, "directive scope file globs");
    if (scope.objective_id) {
      const objective = this.sqlite
        .prepare("SELECT project_id FROM objectives WHERE id = ?")
        .get(scope.objective_id) as { project_id: string } | undefined;
      if (!objective || objective.project_id !== projectId) {
        integrity("Directive objective projection crosses project boundary", scope.objective_id);
      }
    }
    for (const taskId of scope.task_ids) {
      const task = this.sqlite
        .prepare("SELECT project_id, objective_id FROM tasks WHERE id = ?")
        .get(taskId) as { project_id: string; objective_id: string } | undefined;
      if (
        !task ||
        task.project_id !== projectId ||
        (scope.objective_id !== null && task.objective_id !== scope.objective_id)
      ) {
        integrity("Directive task projection crosses its declared project/objective", taskId);
      }
    }
  }

  private assertDirectiveReferences(row: DirectiveRow, snapshotSequence: number): void {
    if (row.source_user_turn_id !== null) {
      const turn = this.userTurnRow(row.project_id, row.source_user_turn_id, snapshotSequence);
      if (
        sha256(turn.raw_text) !== turn.raw_text_sha256 ||
        row.raw_user_turn_sha256 !== turn.raw_text_sha256
      ) {
        integrity("Directive source hash is not bound to its user turn", row.id);
      }
    }
    for (const [grantId, version, label] of [
      [row.delegation_grant_id, row.delegation_version, "delegation"],
      [row.attempted_delegation_grant_id, row.attempted_delegation_version, "attempted delegation"],
    ] as const) {
      if ((grantId === null) !== (version === null)) {
        integrity(`Directive ${label} id/version binding is partial`, row.id);
      }
      if (grantId !== null) {
        const grants = this.sqlite
          .prepare(
            `SELECT grant.project_id FROM delegation_grants grant
             JOIN delegation_grant_versions version ON version.grant_id = grant.id
             JOIN delegation_events issuance ON issuance.grant_id = grant.id
               AND issuance.grant_version = version.version
               AND issuance.event_type = CASE version.version WHEN 1 THEN 'ISSUED' ELSE 'MODIFIED' END
             WHERE grant.id = ? AND version.version = ? AND issuance.server_sequence <= ?
             LIMIT 2`,
          )
          .all(grantId, version, snapshotSequence) as Array<{ project_id: string }>;
        if (grants.length !== 1 || grants[0]!.project_id !== row.project_id) {
          integrity(`Directive ${label} references a missing or cross-project exact version`, {
            directiveId: row.id,
            grantId,
            version,
          });
        }
      }
    }
    if (row.supersedes_directive_id !== null) {
      const predecessor = this.sqlite
        .prepare(
          "SELECT project_id FROM authority_directives WHERE id = ? AND server_sequence <= ?",
        )
        .get(row.supersedes_directive_id, snapshotSequence) as { project_id: string } | undefined;
      if (!predecessor || predecessor.project_id !== row.project_id) {
        integrity("Directive predecessor is missing or cross-project", row.id);
      }
      if (row.causation_id !== row.supersedes_directive_id) {
        integrity("Directive successor causation does not name its predecessor", row.id);
      }
    }
  }

  private scopeProjection(
    projectId: string,
    scope: { objective_id: string | null; task_ids: string[]; file_globs: string[] },
  ) {
    const objective = scope.objective_id
      ? (this.sqlite
          .prepare("SELECT id, project_id, title, status FROM objectives WHERE id = ?")
          .get(scope.objective_id) as
          { id: string; project_id: string; title: string; status: string } | undefined)
      : undefined;
    if (scope.objective_id !== null && (!objective || objective.project_id !== projectId)) {
      integrity("Directive objective projection is missing or cross-project", scope.objective_id);
    }
    const taskLookup = this.sqlite.prepare(
      "SELECT id, project_id, objective_id, title, status FROM tasks WHERE id = ?",
    );
    const tasks = scope.task_ids.map((taskId) => {
      const task = taskLookup.get(taskId) as
        | {
            id: string;
            project_id: string;
            objective_id: string;
            title: string;
            status: string;
          }
        | undefined;
      if (
        !task ||
        task.project_id !== projectId ||
        (scope.objective_id !== null && task.objective_id !== scope.objective_id)
      ) {
        return integrity("Directive task projection is missing or outside its objective", taskId);
      }
      return {
        id: task.id,
        projectId: task.project_id,
        title: task.title,
        status: task.status,
        objectiveId: task.objective_id,
      };
    });
    return {
      objective: objective
        ? {
            id: objective.id,
            projectId: objective.project_id,
            title: objective.title,
            status: objective.status,
          }
        : null,
      tasks,
    };
  }

  private assertImmediateSuccessorTerminal(
    row: DirectiveRow,
    successor: DirectiveRow | null,
    snapshotSequence: number,
  ): void {
    const terminal = this.sqlite
      .prepare(
        `SELECT * FROM authority_events
         WHERE directive_id = ? AND event_type = 'SUPERSEDED'
           AND server_sequence <= ? ORDER BY server_sequence LIMIT 2`,
      )
      .all(row.id, snapshotSequence) as AuthorityEventRow[];
    if (
      successor
        ? terminal.length !== 1 ||
          terminal[0]!.causation_id !== successor.id ||
          terminal[0]!.correlation_id !== successor.correlation_id ||
          terminal[0]!.from_lifecycle !== "ACTIVE" ||
          terminal[0]!.to_lifecycle !== "SUPERSEDED" ||
          terminal[0]!.server_sequence <= row.server_sequence ||
          terminal[0]!.server_sequence >= successor.server_sequence
        : terminal.length !== 0
    ) {
      integrity("Directive terminal event is not bound to its immediate successor", row.id);
    }
    if (terminal[0]) this.assertAuthorityEventBacking(terminal[0], row);
  }

  private directiveLifecycle(row: DirectiveRow, snapshotSequence: number): Lifecycle {
    const terminal = this.sqlite
      .prepare(
        `SELECT * FROM authority_events WHERE directive_id = ?
         AND event_type IN ('SUPERSEDED','REVOKED','COMPLETED','EXPIRED')
         AND server_sequence <= ? ORDER BY server_sequence LIMIT 2`,
      )
      .all(row.id, snapshotSequence) as AuthorityEventRow[];
    if (terminal.length > 1) integrity("Directive has duplicate terminal lifecycle facts", row.id);
    if (terminal[0]) {
      const event = terminal[0];
      this.assertAuthorityEventBacking(event, row);
      if (
        event.from_lifecycle !== "ACTIVE" ||
        event.to_lifecycle !== event.event_type ||
        (event.event_type !== "SUPERSEDED" && event.correlation_id !== row.correlation_id)
      ) {
        integrity("Directive terminal lifecycle event is malformed", row.id);
      }
      return event.event_type;
    }
    return "ACTIVE";
  }

  private assertDirectiveIssuance(
    row: DirectiveRow,
    targetAgentIds: AgentId[],
    scope: unknown,
    snapshotSequence: number,
  ): void {
    const carrier = this.sqlite
      .prepare("SELECT * FROM messages WHERE id = ?")
      .get(row.carrier_message_id) as Record<string, unknown> | undefined;
    const links = this.sqlite
      .prepare(
        "SELECT * FROM message_directive_links WHERE directive_id = ? OR message_id = ? LIMIT 2",
      )
      .all(row.id, row.carrier_message_id) as Array<Record<string, unknown>>;
    if (links.length > 1) {
      integrity("Directive has more than one carrier link", row.id);
    }
    const principal = this.sqlite
      .prepare("SELECT kind, client_type, status FROM auth_principals WHERE id = ?")
      .get(row.relay_principal_id) as Record<string, unknown> | undefined;
    const relaySession = row.relay_session_id
      ? (this.sqlite
          .prepare("SELECT project_id, agent_id FROM agent_sessions WHERE id = ?")
          .get(row.relay_session_id) as Record<string, unknown> | undefined)
      : null;
    if (
      !carrier ||
      carrier.project_id !== row.project_id ||
      carrier.from_agent_id !== row.relay_agent_id ||
      carrier.from_session_id !== row.relay_session_id ||
      Number(carrier.sequence) > snapshotSequence ||
      links.length !== 1 ||
      links[0]!.directive_id !== row.id ||
      links[0]!.message_id !== row.carrier_message_id ||
      !principal ||
      principal.kind !== "AGENT" ||
      principal.client_type !== row.relay_agent_id ||
      (row.relay_session_id !== null &&
        (!relaySession ||
          relaySession.project_id !== row.project_id ||
          relaySession.agent_id !== row.relay_agent_id))
    ) {
      integrity("Directive relay or carrier provenance is broken", { directiveId: row.id });
    }
    const issuance = this.sqlite
      .prepare(
        `SELECT * FROM authority_events
         WHERE directive_id = ? AND event_type = 'ISSUED' AND server_sequence <= ? LIMIT 2`,
      )
      .all(row.id, snapshotSequence) as AuthorityEventRow[];
    if (issuance.length !== 1) integrity("Directive must have exactly one issuance event", row.id);
    const event = issuance[0]!;
    this.assertAuthorityEventBacking(event, row);
    const issuancePrincipal = event.actor_principal_id
      ? (this.sqlite
          .prepare("SELECT kind FROM auth_principals WHERE id = ?")
          .get(event.actor_principal_id) as { kind: string } | undefined)
      : undefined;
    if (
      event.server_sequence !== row.server_sequence ||
      event.created_at !== row.issued_at ||
      event.from_lifecycle !== null ||
      event.to_lifecycle !== "ACTIVE" ||
      event.causation_id !== row.causation_id ||
      event.correlation_id !== row.correlation_id ||
      (row.relay_session_id !== null
        ? event.actor_principal_id !== null || event.actor_session_id !== row.relay_session_id
        : event.actor_session_id !== null ||
          event.actor_principal_id === null ||
          (event.actor_principal_id !== row.relay_principal_id &&
            issuancePrincipal?.kind !== "DASHBOARD_USER"))
    ) {
      integrity("Directive issuance event is not bound to the immutable directive", row.id);
    }
    const payload = parseJson<Record<string, unknown>>(
      event.payload_json,
      "directive issuance payload",
    );
    if (
      payload.authority !== row.authority ||
      JSON.stringify(payload.audience) !== JSON.stringify(targetAgentIds) ||
      JSON.stringify(payload.scope) !== JSON.stringify(scope) ||
      payload.priority !== row.priority ||
      (payload.supersedesDirectiveId ?? null) !== row.supersedes_directive_id
    ) {
      integrity("Directive issuance payload disagrees with the directive", row.id);
    }
  }

  private hubIssuance(
    row: DirectiveRow,
    lifecycle: Lifecycle,
    targetAgentIds: AgentId[],
    scope: unknown,
    snapshotSequence: number,
  ) {
    if (row.authority === "AGENT_PROPOSAL") {
      if (
        row.key_id !== null ||
        row.canonical_payload_json !== null ||
        row.canonical_payload_sha256 !== null ||
        row.signature !== null
      ) {
        integrity("Unsigned proposal contains signing material", row.id);
      }
      return {
        issuanceState: "UNSIGNED" as const,
        verification: "UNVERIFIED" as const,
        keyId: null,
        canonicalPayloadSha256: null,
      };
    }
    if (
      row.key_id === null ||
      row.canonical_payload_json === null ||
      row.canonical_payload_sha256 === null ||
      row.signature === null
    ) {
      return {
        issuanceState: "INVALID" as const,
        verification: "INVALID" as const,
        keyId: row.key_id,
        canonicalPayloadSha256: row.canonical_payload_sha256,
      };
    }
    const payload = parseJson<unknown>(row.canonical_payload_json, "directive canonical payload");
    const attestation = DirectiveAttestationSchema.safeParse({
      payload,
      canonical_payload_sha256: row.canonical_payload_sha256,
      signature: row.signature,
    });
    const parsed = attestation.success ? attestation.data.payload : null;
    const structural =
      parsed !== null &&
      canonicalJson(parsed) === row.canonical_payload_json &&
      sha256(row.canonical_payload_json) === row.canonical_payload_sha256 &&
      parsed.directive_id === row.id &&
      parsed.project_id === row.project_id &&
      parsed.carrier_message_id === row.carrier_message_id &&
      parsed.authority === row.authority &&
      parsed.key_id === row.key_id &&
      parsed.server_sequence === row.server_sequence &&
      parsed.issued_at === row.issued_at &&
      parsed.expires_at === row.expires_at &&
      parsed.supersedes_directive_id === row.supersedes_directive_id &&
      parsed.causation_id === row.causation_id &&
      parsed.correlation_id === row.correlation_id &&
      JSON.stringify(parsed.audience.target_agent_ids) === JSON.stringify(targetAgentIds) &&
      JSON.stringify(parsed.scope) === JSON.stringify(scope) &&
      parsed.priority === row.priority &&
      parsed.relay.principal_id === row.relay_principal_id &&
      parsed.relay.agent_id === row.relay_agent_id &&
      parsed.relay.session_id === row.relay_session_id &&
      this.attestationAuthorityBodyMatches(row, parsed, snapshotSequence);
    if (!structural) {
      return {
        issuanceState: "INVALID" as const,
        verification: "INVALID" as const,
        keyId: row.key_id,
        canonicalPayloadSha256: row.canonical_payload_sha256,
      };
    }
    const key = this.sqlite
      .prepare("SELECT key_id FROM authority_signing_keys WHERE key_id = ?")
      .get(row.key_id) as { key_id: string } | undefined;
    if (!key) integrity("Signed directive references a missing Authority key", row.id);
    const keyEvents = this.sqlite
      .prepare(
        `SELECT event_type FROM authority_key_events
         WHERE key_id = ? ORDER BY created_at, id LIMIT 4`,
      )
      .all(row.key_id) as Array<{ event_type: "ACTIVATED" | "RETIRED" | "REVOKED" }>;
    if (keyEvents.length > 3) {
      integrity("Authority key history exceeds its closed event set", row.key_id);
    }
    if (
      keyEvents.filter((event) => event.event_type === "ACTIVATED").length !== 1 ||
      keyEvents[0]!.event_type !== "ACTIVATED" ||
      keyEvents.filter((event) => event.event_type === "REVOKED").length > 1
    ) {
      integrity("Authority key has no valid activation provenance", row.key_id);
    }
    const keyRevoked = keyEvents.some((event) => event.event_type === "REVOKED");
    return {
      issuanceState: "SIGNED_STRUCTURALLY_VALID" as const,
      verification:
        keyRevoked || lifecycle === "REVOKED" || lifecycle === "SUPERSEDED"
          ? ("REVOKED" as const)
          : lifecycle === "EXPIRED"
            ? ("EXPIRED" as const)
            : ("UNVERIFIED" as const),
      keyId: row.key_id,
      canonicalPayloadSha256: row.canonical_payload_sha256,
    };
  }

  private attestationAuthorityBodyMatches(
    row: DirectiveRow,
    payload: ReturnType<typeof DirectiveAttestationSchema.parse>["payload"],
    snapshotSequence: number,
  ): boolean {
    if (row.authority === "USER_ATTESTED") {
      if (
        payload.source === null ||
        payload.quote === null ||
        payload.delegation !== null ||
        payload.delegated_instruction !== null ||
        payload.source.user_turn_id !== row.source_user_turn_id ||
        payload.source.raw_user_turn_sha256 !== row.raw_user_turn_sha256 ||
        payload.quote.start_utf16 !== row.quote_start ||
        payload.quote.end_utf16 !== row.quote_end ||
        payload.quote.verbatim_text !== row.verbatim_text ||
        payload.quote.verbatim_text_sha256 !== row.verbatim_text_sha256
      ) {
        return false;
      }
      const turn = this.userTurnRow(row.project_id, payload.source.user_turn_id, snapshotSequence);
      const start = payload.quote.start_utf16;
      const end = payload.quote.end_utf16;
      return (
        Number.isSafeInteger(start) &&
        Number.isSafeInteger(end) &&
        start >= 0 &&
        start < end &&
        end <= turn.raw_text.length &&
        sha256(turn.raw_text) === turn.raw_text_sha256 &&
        sha256(payload.quote.verbatim_text) === payload.quote.verbatim_text_sha256 &&
        payload.source.client_type === turn.client_type &&
        payload.source.session_id === turn.source_session_id &&
        payload.source.turn_id === turn.source_turn_id &&
        payload.source.raw_user_turn_sha256 === turn.raw_text_sha256 &&
        payload.quote.verbatim_text === turn.raw_text.slice(start, end)
      );
    }
    if (
      payload.source !== null ||
      payload.quote !== null ||
      payload.delegation === null ||
      payload.delegated_instruction === null ||
      payload.delegation.grant_id !== row.delegation_grant_id ||
      payload.delegation.version !== row.delegation_version ||
      payload.delegated_instruction.text !== row.delegated_text ||
      payload.delegated_instruction.text_sha256 !== sha256(row.delegated_text ?? "")
    ) {
      return false;
    }
    const versions = this.sqlite
      .prepare(
        `SELECT version.* FROM delegation_grant_versions version
         JOIN delegation_events issuance ON issuance.grant_id = version.grant_id
           AND issuance.grant_version = version.version
           AND issuance.event_type = CASE version.version WHEN 1 THEN 'ISSUED' ELSE 'MODIFIED' END
         WHERE version.grant_id = ? AND version.version = ?
           AND issuance.server_sequence <= ? LIMIT 2`,
      )
      .all(row.delegation_grant_id, row.delegation_version, snapshotSequence) as Array<{
      delegator_agent_ids_json: string;
      target_agent_ids_json: string;
      allowed_actions_json: string;
      objective_ids_json: string;
      task_ids_json: string;
      file_globs_json: string;
      max_priority: string;
      expires_at: string;
    }>;
    if (versions.length > 1) {
      integrity("Delegated directive has duplicate exact grant issuance", row.id);
    }
    const version = versions[0];
    return Boolean(
      version &&
      JSON.stringify(payload.delegation.delegator_agent_ids) ===
        JSON.stringify(parseJson(version.delegator_agent_ids_json, "grant delegators")) &&
      JSON.stringify(payload.delegation.target_agent_ids) ===
        JSON.stringify(parseJson(version.target_agent_ids_json, "grant targets")) &&
      JSON.stringify(payload.delegation.allowed_actions) ===
        JSON.stringify(parseJson(version.allowed_actions_json, "grant actions")) &&
      JSON.stringify(payload.delegation.objective_ids) ===
        JSON.stringify(parseJson(version.objective_ids_json, "grant objectives")) &&
      JSON.stringify(payload.delegation.task_ids) ===
        JSON.stringify(parseJson(version.task_ids_json, "grant tasks")) &&
      JSON.stringify(payload.delegation.file_globs) ===
        JSON.stringify(parseJson(version.file_globs_json, "grant globs")) &&
      payload.delegation.max_priority === version.max_priority &&
      payload.delegation.expires_at === version.expires_at,
    );
  }

  private targetStates(row: DirectiveRow, targetAgentIds: AgentId[], snapshotSequence: number) {
    const recipients = this.sqlite
      .prepare(
        `SELECT * FROM message_recipients WHERE message_id = ?
         ORDER BY recipient_agent_id, id LIMIT ?`,
      )
      .all(row.carrier_message_id, targetAgentIds.length + 1) as Array<Record<string, unknown>>;
    if (
      recipients.length !== targetAgentIds.length ||
      recipients.some(
        (recipient, index) =>
          recipient.recipient_agent_id !== targetAgentIds[index] ||
          recipient.recipient_session_id !== null,
      )
    ) {
      integrity("Directive carrier recipients do not exactly match its audience", row.id);
    }
    return recipients.map((recipient) => {
      const target = recipient.recipient_agent_id as AgentId;
      const facts = this.sqlite
        .prepare(
          `SELECT * FROM authority_events WHERE directive_id = ? AND target_agent_id = ?
           AND event_type IN ('DELIVERED','ACKNOWLEDGED','PROCESSED')
           AND server_sequence <= ? ORDER BY server_sequence LIMIT 4`,
        )
        .all(row.id, target, snapshotSequence) as AuthorityEventRow[];
      if (facts.length > 3) {
        integrity("Directive target has more receipt facts than the bounded lifecycle", {
          directiveId: row.id,
          target,
        });
      }
      for (const kind of ["DELIVERED", "ACKNOWLEDGED", "PROCESSED"] as const) {
        if (facts.filter((fact) => fact.event_type === kind).length > 1) {
          integrity(`Directive target has duplicate ${kind} facts`, {
            directiveId: row.id,
            target,
          });
        }
      }
      facts.forEach((fact) => this.assertAuthorityEventBacking(fact, row));
      const delivered = facts.find((fact) => fact.event_type === "DELIVERED");
      const acknowledged = facts.find((fact) => fact.event_type === "ACKNOWLEDGED");
      const processed = facts.find((fact) => fact.event_type === "PROCESSED");
      const state = processed
        ? "PROCESSED"
        : acknowledged
          ? "ACKNOWLEDGED"
          : delivered
            ? "DELIVERED"
            : "PENDING";
      if (
        (acknowledged && !delivered) ||
        (processed && !acknowledged) ||
        (delivered && acknowledged && acknowledged.server_sequence <= delivered.server_sequence) ||
        (acknowledged && processed && processed.server_sequence <= acknowledged.server_sequence)
      ) {
        integrity("Directive target lifecycle disagrees with carrier recipient state", {
          directiveId: row.id,
          target,
          state,
        });
      }
      let binding: {
        sessionId: string;
        incarnation: number;
        surfaceId: string;
        fence: number;
      } | null = null;
      if (delivered) {
        const payload = parseJson<Record<string, unknown>>(
          delivered.payload_json,
          "directive delivery payload",
        );
        const surface = this.sqlite
          .prepare("SELECT * FROM message_surface_attempts WHERE id = ?")
          .get(payload.surfaceAttemptId) as Record<string, unknown> | undefined;
        const deliverySession = this.sqlite
          .prepare("SELECT project_id, agent_id, incarnation FROM agent_sessions WHERE id = ?")
          .get(delivered.actor_session_id) as
          { project_id: string; agent_id: string; incarnation: number } | undefined;
        if (
          !surface ||
          !deliverySession ||
          surface.message_id !== row.carrier_message_id ||
          surface.recipient_id !== recipient.id ||
          surface.session_id !== delivered.actor_session_id ||
          surface.session_incarnation !== deliverySession.incarnation ||
          surface.recipient_fence !== payload.recipientFence ||
          surface.state !== "CONFIRMED" ||
          deliverySession.project_id !== row.project_id ||
          deliverySession.agent_id !== target ||
          payload.carrierMessageId !== row.carrier_message_id ||
          payload.targetAgentId !== target ||
          payload.sessionId !== delivered.actor_session_id ||
          delivered.causation_id !== row.carrier_message_id
        ) {
          integrity("Directive delivery surface provenance is broken", {
            directiveId: row.id,
            target,
          });
        }
        binding = {
          sessionId: String(surface.session_id),
          incarnation: Number(surface.session_incarnation),
          surfaceId: String(surface.id),
          fence: Number(surface.recipient_fence),
        };
        for (const fact of facts) {
          const factPayload = parseJson<Record<string, unknown>>(
            fact.payload_json,
            `directive ${fact.event_type.toLowerCase()} payload`,
          );
          const factSession = this.sqlite
            .prepare("SELECT project_id, agent_id FROM agent_sessions WHERE id = ?")
            .get(fact.actor_session_id) as { project_id: string; agent_id: string } | undefined;
          const inherited =
            fact.actor_session_id !== surface.session_id
              ? this.sqlite
                  .prepare(
                    `SELECT 1 FROM message_surface_handoffs
                     WHERE project_id = ? AND message_id = ? AND recipient_id = ?
                       AND surface_attempt_id = ? AND source_surface_session_id = ?
                       AND successor_session_id = ? AND recipient_fence = ?`,
                  )
                  .get(
                    row.project_id,
                    row.carrier_message_id,
                    recipient.id,
                    surface.id,
                    surface.session_id,
                    fact.actor_session_id,
                    surface.recipient_fence,
                  )
              : true;
          if (
            !factSession ||
            factSession.project_id !== row.project_id ||
            factSession.agent_id !== target ||
            !inherited ||
            fact.causation_id !== row.carrier_message_id ||
            fact.correlation_id !== row.correlation_id ||
            factPayload.carrierMessageId !== row.carrier_message_id ||
            factPayload.targetAgentId !== target ||
            factPayload.sessionId !== fact.actor_session_id ||
            factPayload.surfaceAttemptId !== surface.id ||
            factPayload.recipientFence !== surface.recipient_fence
          ) {
            integrity("Directive target receipt provenance is broken", {
              directiveId: row.id,
              target,
              eventType: fact.event_type,
            });
          }
        }
      }
      return {
        targetAgentId: target,
        carrierMessageId: row.carrier_message_id,
        recipientId: String(recipient.id),
        deliveryState: state,
        targetSessionId: binding?.sessionId ?? null,
        targetSessionIncarnation: binding?.incarnation ?? null,
        surfaceAttemptId: binding?.surfaceId ?? null,
        recipientFence: binding?.fence ?? null,
        deliveredAt: delivered?.created_at ?? null,
        acknowledgedAt: acknowledged?.created_at ?? null,
        processedAt: processed?.created_at ?? null,
        // The current schema has no durable Adapter verification receipt. Delivery is not proof.
        adapterVerification: { status: "NOT_REPORTED", receipt: null },
      };
    });
  }

  private assertAuthorityEventBacking(event: AuthorityEventRow, directive: DirectiveRow): void {
    const backing = this.sqlite.prepare("SELECT * FROM events WHERE id = ?").get(event.event_id) as
      Record<string, unknown> | undefined;
    const actor = this.eventActor(event.actor_principal_id, event.actor_session_id);
    if (
      event.project_id !== directive.project_id ||
      !backing ||
      backing.project_id !== event.project_id ||
      backing.sequence !== event.server_sequence ||
      backing.type !== `directive.${event.event_type.toLowerCase()}` ||
      backing.actor_type !== actor.actorType ||
      backing.actor_id !== actor.displayName ||
      backing.aggregate_type !== "authority_directive" ||
      backing.aggregate_id !== event.directive_id ||
      backing.causation_id !== event.causation_id ||
      backing.correlation_id !== event.correlation_id ||
      backing.created_at !== event.created_at ||
      JSON.stringify(parseJson(backing.payload_json as string, "event payload")) !==
        JSON.stringify(parseJson(event.payload_json, "authority event payload"))
    ) {
      integrity("Authority event backing provenance is broken", event.event_id);
    }
  }

  private eventActor(
    principalId: string | null,
    sessionId: string | null,
  ): {
    actorType: "agent" | "user" | "system";
    principalId: string | null;
    sessionId: string | null;
    displayName: string;
  } {
    if ((principalId === null) === (sessionId === null)) {
      integrity("Authority event must have exactly one authenticated actor", {
        principalId,
        sessionId,
      });
    }
    if (sessionId) {
      const session = this.sqlite
        .prepare("SELECT agent_id FROM agent_sessions WHERE id = ?")
        .get(sessionId) as { agent_id: string } | undefined;
      if (!session) integrity("Authority event actor session is missing", sessionId);
      return { actorType: "agent", principalId: null, sessionId, displayName: session!.agent_id };
    }
    const principal = this.sqlite
      .prepare("SELECT kind, display_name, client_type FROM auth_principals WHERE id = ?")
      .get(principalId) as
      { kind: string; display_name: string; client_type: string | null } | undefined;
    if (!principal) integrity("Authority event actor principal is missing", principalId);
    const actorType =
      principal!.kind === "DASHBOARD_USER"
        ? "user"
        : principal!.kind === "AGENT"
          ? "agent"
          : "system";
    return {
      actorType,
      principalId,
      sessionId: null,
      displayName:
        principal!.kind === "AGENT"
          ? (principal!.client_type ?? principal!.display_name)
          : principal!.display_name,
    };
  }

  private supersessionChain(
    projectId: string,
    focus: DirectiveRow,
    snapshotSequence: number,
  ): AuthoritySupersessionChain {
    const ancestors: DirectiveRow[] = [focus];
    const seen = new Set([focus.id]);
    let cursor = focus;
    while (cursor.supersedes_directive_id !== null) {
      const predecessor = this.directiveRow(
        projectId,
        cursor.supersedes_directive_id,
        snapshotSequence,
      );
      if (seen.has(predecessor.id))
        integrity("Directive supersession chain contains a cycle", focus.id);
      if (cursor.causation_id !== predecessor.id) {
        integrity("Directive supersession causation does not name its predecessor", cursor.id);
      }
      ancestors.unshift(predecessor);
      seen.add(predecessor.id);
      cursor = predecessor;
      if (ancestors.length > MAX_SUPERSESSION_NODES)
        integrity("Directive supersession chain exceeds the bounded model");
    }
    const chain = [...ancestors];
    cursor = focus;
    for (;;) {
      const successors = this.sqlite
        .prepare(
          `SELECT * FROM authority_directives
           WHERE supersedes_directive_id = ? AND server_sequence <= ? ORDER BY id LIMIT 2`,
        )
        .all(cursor.id, snapshotSequence) as DirectiveRow[];
      if (successors.length > 1) integrity("Directive supersession chain is forked", cursor.id);
      const successor = successors[0];
      if (!successor) break;
      if (successor.project_id !== projectId || successor.causation_id !== cursor.id) {
        integrity("Directive successor crosses project or causation boundary", successor.id);
      }
      if (seen.has(successor.id))
        integrity("Directive supersession chain contains a cycle", focus.id);
      chain.push(successor);
      seen.add(successor.id);
      cursor = successor;
      if (chain.length > MAX_SUPERSESSION_NODES) {
        integrity("Directive supersession chain exceeds the bounded model");
      }
    }
    const nodes = chain.map((row, index) => {
      const successor = chain[index + 1];
      this.assertImmediateSuccessorTerminal(row, successor ?? null, snapshotSequence);
      const lifecycle = this.directiveLifecycle(row, snapshotSequence);
      if (successor && lifecycle !== "SUPERSEDED") {
        integrity("Every non-current directive must be terminally superseded", row.id);
      }
      return {
        directiveId: row.id,
        correlationId: row.correlation_id,
        supersedesDirectiveId: row.supersedes_directive_id,
        successorDirectiveIds: successor ? [successor.id] : [],
        lifecycle,
        serverSequence: row.server_sequence,
        issuedAt: row.issued_at,
      };
    });
    return {
      rootDirectiveId: chain[0]!.id,
      focusDirectiveId: focus.id,
      currentDirectiveId: chain.at(-1)!.id,
      nodes,
      integrity: "COMPLETE_LINEAR",
    };
  }

  private delegationProvenance(
    projectId: string,
    grantId: string,
    referencedVersion?: number,
    snapshotSequence?: number,
  ): DelegationGrantProvenance {
    const cutoff = snapshotSequence ?? this.snapshotSequence(projectId, null);
    const base = this.sqlite
      .prepare("SELECT * FROM delegation_grants WHERE id = ?")
      .get(grantId) as Record<string, unknown> | undefined;
    if (!base) throw new NotFoundError("Delegation grant", grantId);
    if (base.project_id !== projectId) {
      integrity("Delegation provenance crosses project boundary", { grantId, projectId });
    }
    const rows = this.sqlite
      .prepare(
        `SELECT grant.id AS grant_id, grant.project_id, grant.source_user_turn_id,
                grant.created_by_principal_id, version.*
         FROM delegation_grants grant JOIN delegation_grant_versions version
           ON version.grant_id = grant.id
         JOIN delegation_events issuance ON issuance.grant_id = grant.id
           AND issuance.grant_version = version.version
           AND issuance.event_type = CASE version.version WHEN 1 THEN 'ISSUED' ELSE 'MODIFIED' END
         WHERE grant.id = ? AND issuance.server_sequence <= ?
         ORDER BY version.version LIMIT ?`,
      )
      .all(grantId, cutoff, MAX_DELEGATION_VERSIONS + 1) as DelegationVersionRow[];
    if (rows.length === 0 || rows.length > MAX_DELEGATION_VERSIONS) {
      integrity("Delegation grant has no bounded version history", grantId);
    }
    if (rows[0]!.source_user_turn_id !== null) {
      this.userTurnRow(projectId, rows[0]!.source_user_turn_id, cutoff);
    }
    const events = this.sqlite
      .prepare(
        `SELECT * FROM delegation_events
         WHERE grant_id = ? AND server_sequence <= ?
         ORDER BY server_sequence, id LIMIT ?`,
      )
      .all(grantId, cutoff, MAX_DELEGATION_EVENTS + 1) as DelegationEventRow[];
    if (events.length > MAX_DELEGATION_EVENTS) {
      integrity("Delegation event history exceeds the bounded read model", grantId);
    }
    const terminal = events.filter(
      (event) => event.event_type === "TERMINATED" || event.event_type === "EXPIRED",
    );
    if (terminal.length > 1) integrity("Delegation has duplicate terminal events", grantId);
    const currentVersion = rows.at(-1)!.version;
    const resolvedVersion = referencedVersion ?? currentVersion;
    if (!rows.some((row) => row.version === resolvedVersion)) {
      integrity("Directive references a missing delegation version", { grantId, resolvedVersion });
    }
    const status: "ACTIVE" | "TERMINATED" | "EXPIRED" = terminal[0]
      ? (terminal[0].event_type as "TERMINATED" | "EXPIRED")
      : "ACTIVE";
    const versions = rows.map((row, index): DelegationGrant => {
      if (
        row.project_id !== projectId ||
        row.version !== index + 1 ||
        row.supersedes_version !== (index === 0 ? null : index)
      ) {
        integrity("Delegation version history is missing, duplicated, or forked", grantId);
      }
      const versionEvent = events.filter(
        (event) =>
          event.grant_version === row.version &&
          event.event_type === (row.version === 1 ? "ISSUED" : "MODIFIED"),
      );
      if (
        versionEvent.length !== 1 ||
        versionEvent[0]!.actor_principal_id !== row.issued_by_principal_id ||
        versionEvent[0]!.created_at !== row.issued_at ||
        (row.version === 1
          ? versionEvent[0]!.causation_id !== row.source_user_turn_id
          : versionEvent[0]!.causation_id !== row.grant_id)
      ) {
        integrity("Delegation version is not bound to one exact issuance event", {
          grantId,
          version: row.version,
        });
      }
      const objectiveIds = canonicalStringSet(
        parseJson(row.objective_ids_json, "grant objectives"),
        "grant objectives",
      );
      for (const objectiveId of objectiveIds) {
        const objective = this.sqlite
          .prepare("SELECT project_id FROM objectives WHERE id = ?")
          .get(objectiveId) as { project_id: string } | undefined;
        if (!objective || objective.project_id !== projectId) {
          integrity("Delegation objective scope is missing or cross-project", objectiveId);
        }
      }
      const taskIds = canonicalStringSet(
        parseJson(row.task_ids_json, "grant task ids"),
        "grant task ids",
      );
      this.assertScopeProjection(projectId, {
        objective_id: null,
        task_ids: taskIds,
        file_globs: canonicalStringSet(
          parseJson(row.file_globs_json, "grant globs"),
          "grant globs",
        ),
      });
      if (objectiveIds.length > 0) {
        for (const taskId of taskIds) {
          const task = this.sqlite
            .prepare("SELECT objective_id FROM tasks WHERE id = ?")
            .get(taskId) as { objective_id: string };
          if (!objectiveIds.includes(task.objective_id)) {
            integrity("Delegation task lies outside its objective set", taskId);
          }
        }
      }
      const versionStatus = index === rows.length - 1 ? status : "SUPERSEDED";
      return {
        id: row.grant_id,
        projectId: row.project_id,
        version: row.version,
        status: versionStatus,
        delegatorAgentIds: canonicalStringSet(
          parseJson(row.delegator_agent_ids_json, "grant delegators"),
          "grant delegators",
        ) as AgentId[],
        targetAgentIds: canonicalStringSet(
          parseJson(row.target_agent_ids_json, "grant targets"),
          "grant targets",
        ) as AgentId[],
        allowedActions: canonicalStringSet(
          parseJson(row.allowed_actions_json, "grant actions"),
          "grant actions",
        ) as Array<"ASSIGN_TASK" | "RELAY_DIRECTIVE">,
        objectiveIds,
        taskIds,
        fileGlobs: parseJson(row.file_globs_json, "grant globs"),
        maxPriority: row.max_priority,
        sourceUserTurnId: row.source_user_turn_id,
        expiresAt: row.expires_at,
        issuedAt: row.issued_at,
        createdByPrincipalId: row.created_by_principal_id,
        supersedesVersion: row.supersedes_version,
      };
    });
    const timeline = events.map((event) => this.delegationTimelineEvent(event, rows));
    const provenance = {
      grantId,
      projectId,
      referencedVersion: resolvedVersion,
      currentVersion,
      status,
      sourceUserTurnId: rows[0]!.source_user_turn_id,
      versions,
      timeline,
      integrity: "COMPLETE_LINEAR",
    };
    return parseModel(DelegationGrantProvenanceSchema, provenance, "delegation provenance");
  }

  private delegationTimelineEvent(
    event: DelegationEventRow,
    versions: DelegationVersionRow[],
  ): AuthorityTimelineEvent {
    const backing = this.sqlite.prepare("SELECT * FROM events WHERE id = ?").get(event.event_id) as
      Record<string, unknown> | undefined;
    const actor = this.eventActor(event.actor_principal_id, event.actor_session_id);
    const expectedType = `delegation.${event.event_type.toLowerCase()}`;
    if (
      !backing ||
      event.project_id !== versions[0]!.project_id ||
      backing.project_id !== event.project_id ||
      backing.sequence !== event.server_sequence ||
      backing.type !== expectedType ||
      backing.actor_type !== actor.actorType ||
      backing.actor_id !== actor.displayName ||
      backing.aggregate_type !== "delegation_grant" ||
      backing.aggregate_id !== event.grant_id ||
      backing.causation_id !== event.causation_id ||
      backing.correlation_id !== event.correlation_id ||
      backing.created_at !== event.created_at ||
      event.correlation_id !== event.grant_id ||
      JSON.stringify(parseJson(backing.payload_json as string, "delegation event payload")) !==
        JSON.stringify(parseJson(event.payload_json, "delegation ledger payload"))
    ) {
      integrity("Delegation event backing or correlation is broken", event.event_id);
    }
    const expectedVersion =
      event.event_type === "ISSUED"
        ? 1
        : event.event_type === "MODIFIED"
          ? event.grant_version
          : null;
    if (
      (expectedVersion !== null && event.grant_version !== expectedVersion) ||
      !versions.some((version) => version.version === event.grant_version)
    ) {
      integrity("Delegation event references a missing exact version", event.event_id);
    }
    return {
      id: event.id,
      eventId: event.event_id,
      projectId: event.project_id,
      aggregateKind: "DELEGATION_GRANT",
      directiveId: null,
      delegationGrantId: event.grant_id,
      delegationVersion: event.grant_version,
      userTurnId: null,
      eventType: `DELEGATION_${event.event_type}` as AuthorityTimelineEvent["eventType"],
      authorityClass: null,
      actor,
      targetAgentId: null,
      serverSequence: event.server_sequence,
      fromLifecycle: null,
      toLifecycle: null,
      causationId: event.causation_id,
      correlationId: event.correlation_id,
      occurredAt: event.created_at,
      summary: this.payloadSummary(event.payload_json),
      adapterVerificationReceipt: null,
    };
  }

  private executionResults(row: DirectiveRow, snapshotSequence: number) {
    const results = this.sqlite
      .prepare(
        `SELECT * FROM directive_execution_results
         WHERE directive_id = ? AND server_sequence <= ?
         ORDER BY target_agent_id, id LIMIT 3`,
      )
      .all(row.id, snapshotSequence) as Array<Record<string, unknown>>;
    if (results.length > 2) {
      integrity("Directive has more execution results than its bounded audience", row.id);
    }
    const seen = new Set<string>();
    return results.map((result) => {
      const target = String(result.target_agent_id);
      if (seen.has(target))
        integrity("Directive has duplicate execution results", { directiveId: row.id, target });
      seen.add(target);
      const eventRows = this.sqlite
        .prepare(
          `SELECT * FROM authority_events
           WHERE event_id = ? AND event_type = 'RESULT_RECORDED'
             AND server_sequence <= ? LIMIT 2`,
        )
        .all(result.event_id, snapshotSequence) as AuthorityEventRow[];
      if (eventRows.length !== 1)
        integrity("Execution result has no unique Authority event", result.id);
      const event = eventRows[0]!;
      this.assertAuthorityEventBacking(event, row);
      if (
        result.project_id !== row.project_id ||
        result.directive_id !== row.id ||
        event.directive_id !== row.id ||
        event.target_agent_id !== result.target_agent_id ||
        event.actor_session_id !== result.session_id ||
        event.server_sequence !== result.server_sequence ||
        event.causation_id !== row.carrier_message_id ||
        event.correlation_id !== row.correlation_id
      ) {
        integrity("Execution result causation or correlation is broken", result.id);
      }
      return {
        id: String(result.id),
        projectId: String(result.project_id),
        directiveId: String(result.directive_id),
        targetAgentId: result.target_agent_id,
        sessionId: String(result.session_id),
        status: result.status,
        summary: String(result.summary),
        evidence: parseJson(String(result.evidence_json), "execution evidence"),
        serverSequence: Number(result.server_sequence),
        eventId: String(result.event_id),
        causationId: event.causation_id,
        correlationId: event.correlation_id,
        createdAt: String(result.created_at),
      };
    });
  }

  private directiveTimeline(
    focus: DirectiveRow,
    chain: AuthoritySupersessionChain,
    source: UserTurnDetail | null,
    grant: DelegationGrantProvenance | null,
    snapshotSequence: number,
  ): AuthorityTimelineEvent[] {
    const ids = chain.nodes.map((node) => node.directiveId);
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.sqlite
      .prepare(
        `SELECT authority_event.*, directive.authority
         FROM authority_events authority_event
         JOIN authority_directives directive ON directive.id = authority_event.directive_id
         WHERE authority_event.directive_id IN (${placeholders})
           AND authority_event.server_sequence <= ?
         ORDER BY authority_event.server_sequence, authority_event.id LIMIT ?`,
      )
      .all(...ids, snapshotSequence, MAX_DIRECTIVE_TIMELINE_EVENTS + 1) as Array<
      AuthorityEventRow & { authority: DirectiveAuthority }
    >;
    if (rows.length > MAX_DIRECTIVE_TIMELINE_EVENTS) {
      integrity("Directive timeline exceeds the bounded read model", focus.id);
    }
    const events = rows.map((event) => {
      const directive = this.directiveRow(focus.project_id, event.directive_id, snapshotSequence);
      this.assertAuthorityEventBacking(event, directive);
      return this.authorityTimelineEvent(event, event.authority);
    });
    if (source) events.push(this.userTurnTimelineEvent(source, snapshotSequence));
    if (grant) events.push(...grant.timeline);
    events.sort(
      (left, right) =>
        left.serverSequence - right.serverSequence || left.eventId.localeCompare(right.eventId),
    );
    const eventIds = new Set<string>();
    for (const event of events) {
      if (eventIds.has(event.eventId))
        integrity("Authority timeline contains duplicate events", event.eventId);
      eventIds.add(event.eventId);
    }
    return events;
  }

  private authorityTimelineEvent(
    event: AuthorityEventRow,
    authority: DirectiveAuthority,
  ): AuthorityTimelineEvent {
    const map = {
      ISSUED: "DIRECTIVE_ISSUED",
      DELIVERED: "DIRECTIVE_DELIVERED",
      ACKNOWLEDGED: "DIRECTIVE_ACKNOWLEDGED",
      PROCESSED: "DIRECTIVE_PROCESSED",
      RESULT_RECORDED: "DIRECTIVE_RESULT_RECORDED",
      SUPERSEDED: "DIRECTIVE_SUPERSEDED",
      REVOKED: "DIRECTIVE_REVOKED",
      COMPLETED: "DIRECTIVE_COMPLETED",
      EXPIRED: "DIRECTIVE_EXPIRED",
    } as const;
    return {
      id: event.id,
      eventId: event.event_id,
      projectId: event.project_id,
      aggregateKind: "DIRECTIVE",
      directiveId: event.directive_id,
      delegationGrantId: null,
      delegationVersion: null,
      userTurnId: null,
      eventType: map[event.event_type],
      authorityClass:
        authority === "AGENT_PROPOSAL"
          ? { kind: "UNSIGNED_DIRECTIVE", authority: "AGENT_PROPOSAL" }
          : { kind: "SIGNED_DIRECTIVE", authority },
      actor: this.eventActor(event.actor_principal_id, event.actor_session_id),
      targetAgentId: event.target_agent_id,
      serverSequence: event.server_sequence,
      fromLifecycle: event.from_lifecycle,
      toLifecycle: event.to_lifecycle,
      causationId: event.causation_id,
      correlationId: event.correlation_id,
      occurredAt: event.created_at,
      summary: this.payloadSummary(event.payload_json),
      adapterVerificationReceipt: null,
    };
  }

  private userTurnTimelineEvent(
    source: UserTurnDetail,
    snapshotSequence: number,
  ): AuthorityTimelineEvent {
    const rows = this.sqlite
      .prepare(
        `SELECT * FROM events WHERE project_id = ? AND type = 'user_turn.captured'
         AND aggregate_type = 'user_turn' AND aggregate_id = ?
         AND sequence <= ? LIMIT 2`,
      )
      .all(source.projectId, source.id, snapshotSequence) as Array<Record<string, unknown>>;
    if (rows.length !== 1) integrity("User turn has no unique capture timeline event", source.id);
    const row = rows[0]!;
    return {
      id: String(row.id),
      eventId: String(row.id),
      projectId: source.projectId,
      aggregateKind: "USER_TURN",
      directiveId: null,
      delegationGrantId: null,
      delegationVersion: null,
      userTurnId: source.id,
      eventType: "USER_TURN_CAPTURED",
      authorityClass: { kind: "USER_TURN", authority: "USER_DIRECT" },
      actor: {
        actorType: "system",
        principalId: source.sourcePrincipalId,
        sessionId: null,
        displayName: String(row.actor_id),
      },
      targetAgentId: null,
      serverSequence: Number(row.sequence),
      fromLifecycle: null,
      toLifecycle: null,
      causationId: null,
      correlationId: String(row.correlation_id),
      occurredAt: String(row.created_at),
      summary: null,
      adapterVerificationReceipt: null,
    };
  }

  private payloadSummary(payloadJson: string): string | null {
    const payload = parseJson<Record<string, unknown> | null>(
      payloadJson,
      "Authority event payload",
    );
    if (!payload) return null;
    for (const key of ["summary", "reason"] as const) {
      if (typeof payload[key] === "string") return payload[key];
    }
    return null;
  }
}
