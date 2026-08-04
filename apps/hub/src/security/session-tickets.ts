import { createHash, randomBytes } from "node:crypto";
import type {
  AdapterSessionClient,
  CredentialScope,
  DeliveryMode,
  SessionTicketActivationMode,
  SessionTicketBinding,
  SessionTicketPurpose,
  SessionTicketState,
  TerminalSessionTicketBinding,
  TerminalSessionTicketState,
} from "@crossagent/protocol";
import { SESSION_TICKET_PURPOSES_BY_CLIENT } from "@crossagent/protocol";
import type Database from "better-sqlite3";
import { HubError } from "../domain/errors.js";

export const STATIC_ADAPTER_SCOPES = {
  AGENT: ["project:join", "project:select", "session-ticket:offer", "session:enroll:first"],
  CAPTURE: ["session-ticket:offer:capture"],
  INJECTOR: ["session-ticket:offer:injector"],
} as const satisfies Record<string, readonly CredentialScope[]>;

export const SESSION_TICKET_SCOPES = {
  CONTROL: ["directive:relay", "hub:session", "session-ticket:offer"],
  MODEL_MCP: ["directive:relay", "hub:mcp"],
  CAPTURE: ["user_turn:capture"],
  INJECTOR: ["synthetic_prompt:reserve"],
} as const satisfies Record<SessionTicketPurpose, readonly CredentialScope[]>;

export { SESSION_TICKET_PURPOSES_BY_CLIENT };

type TicketRow = {
  id: string;
  bundle_id: string;
  purpose: SessionTicketPurpose;
  token_sha256: string;
  offered_by_auth_credential_id: string | null;
  offered_by_ticket_id: string | null;
  project_id: string;
  adapter_client: "codex" | "claude";
  agent_id: "codex" | "claude";
  session_client: AdapterSessionClient;
  role: "primary" | "reviewer" | "observer";
  transport: "websocket" | "hook-poll";
  delivery_mode: DeliveryMode;
  external_session_id: string | null;
  external_thread_id: string | null;
  run_id: string;
  activation_mode: SessionTicketActivationMode;
  expected_lineage_id: string | null;
  expected_head_session_id: string | null;
  launch_reservation_id: string | null;
  hub_session_id: string | null;
  lineage_id: string | null;
  incarnation: number | null;
  idempotency_key: string;
  request_sha256: string;
  state: SessionTicketState;
  offer_expires_at: string;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
  activated_at: string | null;
  terminal_at: string | null;
  terminal_reason: string | null;
};

export type SessionTicketPublic = {
  id: string;
  bundleId: string;
  purpose: SessionTicketPurpose;
  state: SessionTicketState;
  projectId: string;
  adapterClient: "codex" | "claude";
  agentId: string;
  sessionClient: AdapterSessionClient;
  runId: string;
  offerExpiresAt: string;
};

export type SessionTicketAuthentication = {
  id: string;
  principalId: string;
  principalKind: "AGENT" | "BRIDGE_CAPTURE" | "BRIDGE_INJECTOR";
  displayName: string;
  scopes: CredentialScope[];
  projectId: string;
  adapterClient: "codex" | "claude";
  agentId: string;
  hubSessionId: string | null;
  lineageId: string | null;
  incarnation: number | null;
  purpose: SessionTicketPurpose;
  state: SessionTicketState;
};

export type CreatePendingSessionTicketInput = {
  bundleId: string;
  purpose: SessionTicketPurpose;
  tokenSha256: string;
  offeredByAuthCredentialId?: string;
  offeredByTicketId?: string;
  projectId: string;
  adapterClient: "codex" | "claude";
  agentId: string;
  sessionClient: AdapterSessionClient;
  role: "primary" | "reviewer" | "observer";
  transport: "websocket" | "hook-poll";
  deliveryMode: DeliveryMode;
  externalSessionId?: string;
  externalThreadId?: string;
  runId: string;
  activationMode: SessionTicketActivationMode;
  expectedLineageId?: string;
  expectedHeadSessionId?: string | null;
  launchReservationId?: string;
  idempotencyKey: string;
  now: string;
};

export type ActivateSessionTicketProof =
  | { kind: "FIRST_LINEAGE"; controlTicketId: string }
  | { kind: "CURRENT_HEAD_CONTROL"; controlTicketId: string }
  | { kind: "EXPIRED_CURRENT_HEAD_CONTROL"; controlTicketId: string }
  | { kind: "MANAGED_RESERVATION"; reservationId: string }
  | { kind: "SESSION_AUXILIARY"; controlTicketId: string };

export type ActivateSessionTicketBundleInput = {
  bundleId: string;
  hubSessionId: string;
  lineageId: string;
  incarnation: number;
  proof: ActivateSessionTicketProof;
  now: string;
};

export type RotateSessionTicketBundleResult = {
  binding: SessionTicketBinding;
  superseded: TerminalSessionTicketBinding;
};

type SessionTicketTransitionPermit = {
  bundleId: string;
  pairs: Set<string>;
};

type SessionTicketTransitionGuard = {
  permit: SessionTicketTransitionPermit | null;
};

const transitionGuards = new WeakMap<Database.Database, SessionTicketTransitionGuard>();

function transitionPair(from: SessionTicketState, to: SessionTicketState): string {
  return `${from}:${to}`;
}

function ensureTransitionGuard(sqlite: Database.Database): SessionTicketTransitionGuard {
  const existing = transitionGuards.get(sqlite);
  if (existing) return existing;
  const guard: SessionTicketTransitionGuard = { permit: null };
  sqlite.function(
    "crossagent_session_ticket_transition_guard",
    (bundleId: unknown, from: unknown, to: unknown) =>
      typeof bundleId === "string" &&
      typeof from === "string" &&
      typeof to === "string" &&
      guard.permit?.bundleId === bundleId &&
      guard.permit.pairs.has(`${from}:${to}`)
        ? 1
        : 0,
  );
  transitionGuards.set(sqlite, guard);
  return guard;
}

function withBundleTransition<T>(
  sqlite: Database.Database,
  input: {
    bundleId: string;
    pairs: Array<{ from: SessionTicketState; to: SessionTicketState }>;
  },
  operation: () => T,
): T {
  const guard = ensureTransitionGuard(sqlite);
  if (guard.permit) {
    fail("nested ticket bundle transition is not allowed", 409, "TICKET_ACTIVATION_CONFLICT");
  }
  guard.permit = {
    bundleId: input.bundleId,
    pairs: new Set(input.pairs.map((pair) => transitionPair(pair.from, pair.to))),
  };
  try {
    return operation();
  } finally {
    guard.permit = null;
  }
}

function fail(message: string, statusCode: number, code: string): never {
  throw new HubError(`${code}: ${message}`, statusCode, code);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalInstant(value: string, field: string): string {
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime())) {
    fail(`${field} must be an ISO-8601 instant`, 422, "TICKET_BINDING_MISMATCH");
  }
  return instant.toISOString();
}

function canonicalOffer(input: CreatePendingSessionTicketInput): string {
  return JSON.stringify({
    activation_mode: input.activationMode,
    adapter_client: input.adapterClient,
    agent_id: input.agentId,
    bundle_id: input.bundleId,
    expected_head_session_id: input.expectedHeadSessionId ?? null,
    expected_lineage_id: input.expectedLineageId ?? null,
    delivery_mode: input.deliveryMode,
    external_session_id: input.externalSessionId ?? null,
    external_thread_id: input.externalThreadId ?? null,
    idempotency_key: input.idempotencyKey,
    launch_reservation_id: input.launchReservationId ?? null,
    offered_by_auth_credential_id: input.offeredByAuthCredentialId ?? null,
    offered_by_ticket_id: input.offeredByTicketId ?? null,
    project_id: input.projectId,
    purpose: input.purpose,
    role: input.role,
    run_id: input.runId,
    session_client: input.sessionClient,
    token_sha256: input.tokenSha256,
    transport: input.transport,
  });
}

function publicTicket(row: TicketRow): SessionTicketPublic {
  return {
    id: row.id,
    bundleId: row.bundle_id,
    purpose: row.purpose,
    state: row.state,
    projectId: row.project_id,
    adapterClient: row.adapter_client,
    agentId: row.agent_id,
    sessionClient: row.session_client,
    runId: row.run_id,
    offerExpiresAt: row.offer_expires_at,
  };
}

function ticketId(): string {
  return `stk_${randomBytes(18).toString("base64url")}`;
}

function selectIdempotentTicket(
  sqlite: Database.Database,
  input: CreatePendingSessionTicketInput,
): TicketRow | undefined {
  if (input.offeredByAuthCredentialId) {
    return sqlite
      .prepare(
        `SELECT * FROM adapter_session_tickets
         WHERE offered_by_auth_credential_id = ? AND idempotency_key = ?`,
      )
      .get(input.offeredByAuthCredentialId, input.idempotencyKey) as TicketRow | undefined;
  }
  if (input.offeredByTicketId) {
    return sqlite
      .prepare(
        `SELECT * FROM adapter_session_tickets
         WHERE offered_by_ticket_id = ? AND idempotency_key = ?`,
      )
      .get(input.offeredByTicketId, input.idempotencyKey) as TicketRow | undefined;
  }
  return undefined;
}

function exactBundleRows(sqlite: Database.Database, offerer: TicketRow): TicketRow[] | undefined {
  const rows = sqlite
    .prepare("SELECT * FROM adapter_session_tickets WHERE bundle_id = ? ORDER BY purpose")
    .all(offerer.bundle_id) as TicketRow[];
  const requiredPurposes = SESSION_TICKET_PURPOSES_BY_CLIENT[offerer.session_client];
  const actualPurposes = new Set(rows.map((row) => row.purpose));
  return rows.length === requiredPurposes.length &&
    actualPurposes.size === requiredPurposes.length &&
    requiredPurposes.every((purpose) => actualPurposes.has(purpose))
    ? rows
    : undefined;
}

function isExactWholeExpiredBundle(sqlite: Database.Database, offerer: TicketRow): boolean {
  const rows = exactBundleRows(sqlite, offerer);
  return Boolean(
    rows &&
    offerer.terminal_at !== null &&
    offerer.terminal_reason !== null &&
    rows.every(
      (row) =>
        row.state === "EXPIRED" &&
        row.hub_session_id === offerer.hub_session_id &&
        row.lineage_id === offerer.lineage_id &&
        row.incarnation === offerer.incarnation &&
        row.terminal_at === offerer.terminal_at &&
        row.terminal_reason === offerer.terminal_reason,
    ),
  );
}

function isExactWholeElapsedActiveBundle(
  sqlite: Database.Database,
  offerer: TicketRow,
  now: string,
): boolean {
  const rows = exactBundleRows(sqlite, offerer);
  return Boolean(
    rows &&
    offerer.expires_at !== null &&
    Date.parse(offerer.expires_at) <= Date.parse(now) &&
    rows.every(
      (row) =>
        row.state === "ACTIVE" &&
        row.hub_session_id === offerer.hub_session_id &&
        row.lineage_id === offerer.lineage_id &&
        row.incarnation === offerer.incarnation &&
        row.expires_at === offerer.expires_at &&
        row.activated_at === offerer.activated_at &&
        row.terminal_at === null &&
        row.terminal_reason === null,
    ),
  );
}

/**
 * Read-only proof that an auxiliary rotation never committed before its predecessor expired.
 *
 * This deliberately accepts an elapsed PENDING offer window: the caller is not activating that
 * bundle, only proving that Hub still has the complete, unbound offer which the exact predecessor
 * CONTROL created. A successful proof grants no scope and performs no state transition.
 */
export function assertExpiredAuxiliaryRotationNotCommitted(
  sqlite: Database.Database,
  input: {
    predecessorControlTicketId: string;
    hubSessionId: string;
    successorBundleId: string;
    now: string;
  },
): { predecessorBundleId: string; projectId: string } {
  const now = canonicalInstant(input.now, "now");
  const predecessor = sqlite
    .prepare("SELECT * FROM adapter_session_tickets WHERE id = ?")
    .get(input.predecessorControlTicketId) as TicketRow | undefined;
  const expiredPredecessor = Boolean(
    predecessor &&
    predecessor.purpose === "CONTROL" &&
    predecessor.hub_session_id === input.hubSessionId &&
    predecessor.lineage_id !== null &&
    predecessor.incarnation !== null &&
    ((predecessor.state === "EXPIRED" && isExactWholeExpiredBundle(sqlite, predecessor)) ||
      (predecessor.state === "ACTIVE" &&
        isExactWholeElapsedActiveBundle(sqlite, predecessor, now))) &&
    isCurrentOpenHeadTicket(sqlite, authenticationProjection(predecessor)),
  );
  if (!predecessor || !expiredPredecessor) {
    fail(
      "expired rotation recovery requires the exact current-head CONTROL ticket",
      403,
      "TICKET_ROTATION_NOT_AUTHORIZED",
    );
  }

  const successor = sqlite
    .prepare("SELECT * FROM adapter_session_tickets WHERE bundle_id = ? ORDER BY purpose")
    .all(input.successorBundleId) as TicketRow[];
  const first = successor[0];
  const requiredPurposes = first
    ? SESSION_TICKET_PURPOSES_BY_CLIENT[first.session_client]
    : undefined;
  const actualPurposes = new Set(successor.map((ticket) => ticket.purpose));
  const exactPurposeSet = Boolean(
    requiredPurposes &&
    successor.length === requiredPurposes.length &&
    actualPurposes.size === requiredPurposes.length &&
    requiredPurposes.every((purpose) => actualPurposes.has(purpose)),
  );
  const exactBinding = Boolean(
    first &&
    exactPurposeSet &&
    first.project_id === predecessor.project_id &&
    first.adapter_client === predecessor.adapter_client &&
    first.agent_id === predecessor.agent_id &&
    first.session_client === predecessor.session_client &&
    first.role === predecessor.role &&
    first.transport === predecessor.transport &&
    first.delivery_mode === predecessor.delivery_mode &&
    first.external_session_id === predecessor.external_session_id &&
    first.external_thread_id === predecessor.external_thread_id &&
    first.run_id === predecessor.run_id &&
    first.activation_mode === "SESSION_AUXILIARY" &&
    first.expected_lineage_id === predecessor.lineage_id &&
    first.expected_head_session_id === input.hubSessionId &&
    first.launch_reservation_id === null &&
    successor.every(
      (ticket) =>
        ticket.state === "PENDING" &&
        ticket.project_id === first.project_id &&
        ticket.adapter_client === first.adapter_client &&
        ticket.agent_id === first.agent_id &&
        ticket.session_client === first.session_client &&
        ticket.role === first.role &&
        ticket.transport === first.transport &&
        ticket.delivery_mode === first.delivery_mode &&
        ticket.external_session_id === first.external_session_id &&
        ticket.external_thread_id === first.external_thread_id &&
        ticket.run_id === first.run_id &&
        ticket.activation_mode === first.activation_mode &&
        ticket.expected_lineage_id === first.expected_lineage_id &&
        ticket.expected_head_session_id === first.expected_head_session_id &&
        ticket.launch_reservation_id === null &&
        ticket.hub_session_id === null &&
        ticket.lineage_id === null &&
        ticket.incarnation === null &&
        ticket.expires_at === null &&
        ticket.activated_at === null &&
        ticket.terminal_at === null &&
        ticket.terminal_reason === null &&
        (ticket.purpose === "INJECTOR"
          ? ticket.offered_by_auth_credential_id === `crd_inject_${predecessor.adapter_client}` &&
            ticket.offered_by_ticket_id === null
          : ticket.offered_by_auth_credential_id === null &&
            ticket.offered_by_ticket_id === predecessor.id),
    ),
  );
  if (!exactBinding) {
    fail(
      "successor is not the complete uncommitted auxiliary bundle from this CONTROL ticket",
      409,
      "TICKET_REPLACEMENT_PROOF_REQUIRED",
    );
  }
  return { predecessorBundleId: predecessor.bundle_id, projectId: predecessor.project_id };
}

/**
 * Persists a digest-only offer. This synchronous helper deliberately does not open a transaction so
 * Store registration can compose it with session/head/event/idempotency mutations atomically.
 */
export function createPendingSessionTicket(
  sqlite: Database.Database,
  input: CreatePendingSessionTicketInput,
): SessionTicketPublic {
  ensureTransitionGuard(sqlite);
  const now = canonicalInstant(input.now, "now");
  let offerExpiresAt = new Date(Date.parse(now) + 10 * 60 * 1000).toISOString();
  const normalizedInput = { ...input, now };
  if ((input.offeredByAuthCredentialId === undefined) === (input.offeredByTicketId === undefined)) {
    fail("exactly one offerer is required", 403, "TICKET_OFFER_NOT_AUTHORIZED");
  }
  if (!/^[a-f0-9]{64}$/u.test(input.tokenSha256)) {
    fail("ticket digest must be lowercase SHA-256", 422, "TICKET_BINDING_MISMATCH");
  }
  if (input.agentId !== input.adapterClient) {
    fail("adapter client and agent identity differ", 403, "TICKET_BINDING_MISMATCH");
  }
  if (
    input.activationMode === "SESSION_AUXILIARY" &&
    (input.sessionClient === "codex-cli-hooks" || input.sessionClient === "claude-hooks")
  ) {
    fail(
      "Hook clients rotate by same-identity session replacement, not auxiliary bundles",
      422,
      "TICKET_BINDING_MISMATCH",
    );
  }
  if (input.offeredByTicketId) {
    if (
      !["CONTROL", "MODEL_MCP"].includes(input.purpose) ||
      !["CURRENT_HEAD_REPLACEMENT", "SESSION_AUXILIARY"].includes(input.activationMode)
    ) {
      fail(
        "dynamic CONTROL may offer only replacement or auxiliary CONTROL/MODEL_MCP",
        403,
        "TICKET_OFFER_NOT_AUTHORIZED",
      );
    }
    const offerer = sqlite
      .prepare(
        `SELECT ticket.*
         FROM adapter_session_tickets ticket
         JOIN agent_sessions session ON session.id = ticket.hub_session_id
         JOIN session_lineages lineage ON lineage.id = ticket.lineage_id
         WHERE ticket.id = ? AND ticket.purpose = 'CONTROL'
           AND session.id = lineage.head_session_id
           AND session.incarnation = ticket.incarnation
           AND session.connection_state <> 'CLOSED'`,
      )
      .get(input.offeredByTicketId) as TicketRow | undefined;
    const activeOfferer =
      offerer?.state === "ACTIVE" &&
      offerer.expires_at !== null &&
      Date.parse(offerer.expires_at) > Date.parse(now);
    const expiredReplacementOfferer =
      input.activationMode === "CURRENT_HEAD_REPLACEMENT" &&
      offerer !== undefined &&
      ((offerer.state === "EXPIRED" && isExactWholeExpiredBundle(sqlite, offerer)) ||
        (offerer.state === "ACTIVE" && isExactWholeElapsedActiveBundle(sqlite, offerer, now)));
    if (
      !offerer ||
      (!activeOfferer && !expiredReplacementOfferer) ||
      offerer.project_id !== input.projectId ||
      offerer.adapter_client !== input.adapterClient ||
      offerer.agent_id !== input.agentId ||
      offerer.session_client !== input.sessionClient ||
      offerer.role !== input.role ||
      offerer.transport !== input.transport ||
      offerer.delivery_mode !== input.deliveryMode ||
      offerer.external_session_id !== (input.externalSessionId ?? null) ||
      offerer.external_thread_id !== (input.externalThreadId ?? null) ||
      offerer.lineage_id !== input.expectedLineageId ||
      offerer.hub_session_id !== input.expectedHeadSessionId
    ) {
      fail(
        "dynamic offer is not bound to the current CONTROL head",
        403,
        "TICKET_OFFER_NOT_AUTHORIZED",
      );
    }
  }
  const requestSha256 = sha256(canonicalOffer(normalizedInput));
  const prior = selectIdempotentTicket(sqlite, normalizedInput);
  if (prior) {
    if (prior.request_sha256 !== requestSha256) {
      fail("idempotency key was reused for a different offer", 409, "TICKET_IDEMPOTENCY_CONFLICT");
    }
    return publicTicket(prior);
  }
  const collisionCount = Number(
    sqlite
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM auth_credentials WHERE token_sha256 = ?) +
           (SELECT COUNT(*) FROM adapter_session_tickets WHERE token_sha256 = ?)`,
      )
      .pluck()
      .get(input.tokenSha256, input.tokenSha256),
  );
  if (collisionCount !== 0) {
    fail("ticket digest already exists", 409, "TICKET_DIGEST_COLLISION");
  }
  const bundlePeer = sqlite
    .prepare("SELECT * FROM adapter_session_tickets WHERE bundle_id = ? LIMIT 1")
    .get(input.bundleId) as TicketRow | undefined;
  if (
    bundlePeer &&
    Number(
      sqlite
        .prepare(
          "SELECT COUNT(*) FROM adapter_session_tickets WHERE bundle_id = ? AND state <> 'PENDING'",
        )
        .pluck()
        .get(input.bundleId),
    ) !== 0
  ) {
    fail(
      "cannot append a purpose after bundle activation or terminalization",
      409,
      "TICKET_NOT_PENDING",
    );
  }
  if (bundlePeer) offerExpiresAt = bundlePeer.offer_expires_at;
  if (bundlePeer && Date.parse(bundlePeer.offer_expires_at) <= Date.parse(now)) {
    fail("ticket bundle offer window expired", 403, "TICKET_EXPIRED");
  }
  if (
    bundlePeer &&
    (bundlePeer.project_id !== input.projectId ||
      bundlePeer.adapter_client !== input.adapterClient ||
      bundlePeer.agent_id !== input.agentId ||
      bundlePeer.session_client !== input.sessionClient ||
      bundlePeer.role !== input.role ||
      bundlePeer.transport !== input.transport ||
      bundlePeer.delivery_mode !== input.deliveryMode ||
      bundlePeer.external_session_id !== (input.externalSessionId ?? null) ||
      bundlePeer.external_thread_id !== (input.externalThreadId ?? null) ||
      bundlePeer.run_id !== input.runId ||
      bundlePeer.activation_mode !== input.activationMode ||
      bundlePeer.expected_lineage_id !== (input.expectedLineageId ?? null) ||
      bundlePeer.expected_head_session_id !== (input.expectedHeadSessionId ?? null) ||
      bundlePeer.launch_reservation_id !== (input.launchReservationId ?? null))
  ) {
    fail("ticket bundle binding differs across purposes", 409, "TICKET_BINDING_MISMATCH");
  }

  const id = ticketId();
  try {
    sqlite
      .prepare(
        `INSERT INTO adapter_session_tickets(
           id, bundle_id, purpose, token_sha256,
           offered_by_auth_credential_id, offered_by_ticket_id,
           project_id, adapter_client, agent_id, session_client, role, transport, delivery_mode,
           external_session_id, external_thread_id, run_id, activation_mode,
           expected_lineage_id, expected_head_session_id, launch_reservation_id,
           hub_session_id, lineage_id, incarnation, idempotency_key, request_sha256, state,
           offer_expires_at, expires_at, created_at, updated_at,
           activated_at, terminal_at, terminal_reason
         ) VALUES (
           ?, ?, ?, ?,
           ?, ?,
           ?, ?, ?, ?, ?, ?, ?, ?, ?,
           ?, ?, ?, ?, ?,
           NULL, NULL, NULL,
           ?, ?, 'PENDING',
           ?, NULL, ?, ?, NULL, NULL, NULL
         )`,
      )
      .run(
        id,
        input.bundleId,
        input.purpose,
        input.tokenSha256,
        input.offeredByAuthCredentialId ?? null,
        input.offeredByTicketId ?? null,
        input.projectId,
        input.adapterClient,
        input.agentId,
        input.sessionClient,
        input.role,
        input.transport,
        input.deliveryMode,
        input.externalSessionId ?? null,
        input.externalThreadId ?? null,
        input.runId,
        input.activationMode,
        input.expectedLineageId ?? null,
        input.expectedHeadSessionId ?? null,
        input.launchReservationId ?? null,
        input.idempotencyKey,
        requestSha256,
        offerExpiresAt,
        now,
        now,
      );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("TICKET_DIGEST_COLLISION")) {
      fail("ticket digest already exists", 409, "TICKET_DIGEST_COLLISION");
    }
    if (message.includes("TICKET_OFFER_NOT_AUTHORIZED")) {
      fail(
        "offer credential is not authorized for this purpose",
        403,
        "TICKET_OFFER_NOT_AUTHORIZED",
      );
    }
    if (message.includes("UNIQUE constraint failed")) {
      fail("ticket offer conflicts with existing provenance", 409, "TICKET_IDEMPOTENCY_CONFLICT");
    }
    throw error;
  }
  return publicTicket(
    sqlite.prepare("SELECT * FROM adapter_session_tickets WHERE id = ?").get(id) as TicketRow,
  );
}

type SessionBindingRow = {
  id: string;
  project_id: string;
  agent_id: string;
  client: string;
  role: string;
  transport: string;
  delivery_mode: string;
  external_session_id: string | null;
  external_thread_id: string | null;
  connection_state: string;
  lineage_id: string | null;
  incarnation: number | null;
  predecessor_session_id: string | null;
  launcher_run_id: string | null;
  launch_generation: number | null;
  head_session_id: string | null;
  head_incarnation: number;
};

function assertActivationProof(
  sqlite: Database.Database,
  tickets: TicketRow[],
  session: SessionBindingRow,
  proof: ActivateSessionTicketProof,
  now: string,
): void {
  const first = tickets[0]!;
  if (proof.kind === "FIRST_LINEAGE") {
    const control = tickets.find((ticket) => ticket.id === proof.controlTicketId);
    if (
      first.activation_mode !== "FIRST_LINEAGE" ||
      !control ||
      control.purpose !== "CONTROL" ||
      control.state !== "PENDING" ||
      session.predecessor_session_id !== null ||
      session.incarnation !== 1
    ) {
      fail(
        "first lineage requires the same bundle's pending CONTROL ticket",
        403,
        "TICKET_REPLACEMENT_PROOF_REQUIRED",
      );
    }
    return;
  }
  if (proof.kind === "MANAGED_RESERVATION") {
    if (
      first.activation_mode !== "MANAGED_RESERVATION" ||
      first.launch_reservation_id !== proof.reservationId ||
      !sqlite
        .prepare(
          `SELECT 1 FROM session_launch_reservations
           WHERE id = ? AND lineage_id = ? AND run_id = ?
             AND state = 'CONSUMED' AND consumed_session_id = ?`,
        )
        .get(proof.reservationId, session.lineage_id, first.run_id, session.id)
    ) {
      fail(
        "managed reservation does not prove this registration",
        403,
        "TICKET_REPLACEMENT_PROOF_REQUIRED",
      );
    }
    return;
  }
  const control = sqlite
    .prepare("SELECT * FROM adapter_session_tickets WHERE id = ?")
    .get(proof.controlTicketId) as TicketRow | undefined;
  const dynamicOffersUseProof = tickets
    .filter((ticket) => ticket.offered_by_ticket_id !== null)
    .every((ticket) => ticket.offered_by_ticket_id === proof.controlTicketId);
  if (proof.kind === "EXPIRED_CURRENT_HEAD_CONTROL") {
    const predecessor = control?.hub_session_id
      ? (sqlite
          .prepare(
            `SELECT session.id, session.project_id, session.agent_id, session.client, session.role,
                    session.transport, session.delivery_mode, session.external_session_id,
                    session.external_thread_id, session.connection_state, session.lineage_id,
                    session.incarnation, session.predecessor_session_id, session.launcher_run_id,
                    session.launch_generation, lineage.head_session_id, lineage.head_incarnation
             FROM agent_sessions session
             JOIN session_lineages lineage ON lineage.id = session.lineage_id
             WHERE session.id = ?`,
          )
          .get(control.hub_session_id) as SessionBindingRow | undefined)
      : undefined;
    const dormantExpiredControl =
      control !== undefined &&
      ((control.state === "EXPIRED" && isExactWholeExpiredBundle(sqlite, control)) ||
        (control.state === "ACTIVE" && isExactWholeElapsedActiveBundle(sqlite, control, now)));
    if (
      !control ||
      control.purpose !== "CONTROL" ||
      !dormantExpiredControl ||
      !dynamicOffersUseProof ||
      first.activation_mode !== "CURRENT_HEAD_REPLACEMENT" ||
      first.expected_head_session_id !== control.hub_session_id ||
      session.predecessor_session_id !== control.hub_session_id ||
      control.project_id !== first.project_id ||
      control.adapter_client !== first.adapter_client ||
      control.agent_id !== first.agent_id ||
      control.session_client !== first.session_client ||
      control.role !== first.role ||
      control.transport !== first.transport ||
      control.delivery_mode !== first.delivery_mode ||
      control.external_session_id !== first.external_session_id ||
      control.external_thread_id !== first.external_thread_id ||
      control.lineage_id !== session.lineage_id ||
      control.incarnation === null ||
      session.incarnation !== control.incarnation + 1 ||
      !predecessor ||
      predecessor.project_id !== control.project_id ||
      predecessor.agent_id !== control.agent_id ||
      predecessor.client !== control.session_client ||
      predecessor.role !== control.role ||
      predecessor.transport !== control.transport ||
      predecessor.delivery_mode !== control.delivery_mode ||
      predecessor.external_session_id !== control.external_session_id ||
      predecessor.external_thread_id !== control.external_thread_id ||
      predecessor.connection_state === "CLOSED" ||
      predecessor.lineage_id !== control.lineage_id ||
      predecessor.incarnation !== control.incarnation ||
      predecessor.head_session_id !== session.id ||
      predecessor.head_incarnation !== session.incarnation
    ) {
      fail(
        "expired CONTROL ticket does not prove this exact dormant head replacement",
        403,
        "TICKET_REPLACEMENT_PROOF_REQUIRED",
      );
    }
    return;
  }
  if (
    !control ||
    control.purpose !== "CONTROL" ||
    control.state !== "ACTIVE" ||
    !control.expires_at ||
    Date.parse(control.expires_at) <= Date.parse(now) ||
    control.project_id !== first.project_id ||
    control.agent_id !== first.agent_id ||
    control.lineage_id !== session.lineage_id ||
    !dynamicOffersUseProof
  ) {
    fail("an active CONTROL ticket is required", 403, "TICKET_REPLACEMENT_PROOF_REQUIRED");
  }
  if (proof.kind === "CURRENT_HEAD_CONTROL") {
    if (
      first.activation_mode !== "CURRENT_HEAD_REPLACEMENT" ||
      first.expected_head_session_id !== control.hub_session_id ||
      session.predecessor_session_id !== control.hub_session_id
    ) {
      fail(
        "CONTROL ticket is not bound to the replaced head",
        403,
        "TICKET_REPLACEMENT_PROOF_REQUIRED",
      );
    }
  } else if (
    first.activation_mode !== "SESSION_AUXILIARY" ||
    control.hub_session_id !== session.id
  ) {
    fail(
      "auxiliary ticket is not bound to the controlling session",
      403,
      "TICKET_REPLACEMENT_PROOF_REQUIRED",
    );
  }
}

/** Synchronous transaction seam; callers own the encompassing registration transaction. */
export function activateSessionTicketBundle(
  sqlite: Database.Database,
  input: ActivateSessionTicketBundleInput,
): SessionTicketBinding {
  const now = canonicalInstant(input.now, "now");
  const tickets = sqlite
    .prepare("SELECT * FROM adapter_session_tickets WHERE bundle_id = ? ORDER BY purpose")
    .all(input.bundleId) as TicketRow[];
  if (tickets.length === 0) fail("ticket bundle was not found", 404, "TICKET_NOT_FOUND");
  if (tickets.every((ticket) => ticket.state === "ACTIVE")) {
    const first = tickets[0]!;
    if (
      first.hub_session_id === input.hubSessionId &&
      first.lineage_id === input.lineageId &&
      first.incarnation === input.incarnation
    ) {
      return bindingFromRows(tickets);
    }
    fail("active bundle is bound elsewhere", 409, "TICKET_ACTIVATION_CONFLICT");
  }
  if (tickets.some((ticket) => ticket.state !== "PENDING")) {
    fail("ticket bundle is not pending", 409, "TICKET_NOT_PENDING");
  }
  const first = tickets[0]!;
  const requiredPurposes = SESSION_TICKET_PURPOSES_BY_CLIENT[first.session_client];
  const actualPurposeSet = new Set(tickets.map((ticket) => ticket.purpose));
  if (
    actualPurposeSet.size !== requiredPurposes.length ||
    requiredPurposes.some((purpose) => !actualPurposeSet.has(purpose))
  ) {
    fail(
      "ticket bundle does not contain the exact client purpose set",
      409,
      "TICKET_BINDING_MISMATCH",
    );
  }
  if (tickets.some((ticket) => Date.parse(ticket.offer_expires_at) <= Date.parse(now))) {
    fail("ticket bundle expired before activation", 403, "TICKET_EXPIRED");
  }
  const activeExpiresAt = new Date(Date.parse(now) + 24 * 60 * 60 * 1000).toISOString();
  const session = sqlite
    .prepare(
      `SELECT session.id, session.project_id, session.agent_id, session.client, session.role,
              session.transport, session.delivery_mode, session.external_session_id,
              session.external_thread_id,
              session.connection_state, session.lineage_id, session.incarnation,
              session.predecessor_session_id, session.launcher_run_id, session.launch_generation,
              lineage.head_session_id, lineage.head_incarnation
       FROM agent_sessions session
       JOIN session_lineages lineage ON lineage.id = session.lineage_id
       WHERE session.id = ?`,
    )
    .get(input.hubSessionId) as SessionBindingRow | undefined;
  if (
    !session ||
    session.connection_state === "CLOSED" ||
    session.project_id !== first.project_id ||
    session.agent_id !== first.agent_id ||
    session.client !== first.session_client ||
    session.role !== first.role ||
    session.transport !== first.transport ||
    session.delivery_mode !== first.delivery_mode ||
    session.external_session_id !== first.external_session_id ||
    session.external_thread_id !== first.external_thread_id ||
    session.lineage_id !== input.lineageId ||
    session.incarnation !== input.incarnation ||
    session.head_session_id !== session.id ||
    session.head_incarnation !== input.incarnation ||
    session.launcher_run_id !== first.run_id
  ) {
    fail("registered session does not match the ticket bundle", 403, "TICKET_BINDING_MISMATCH");
  }
  if (
    tickets.some(
      (ticket) =>
        ticket.project_id !== first.project_id ||
        ticket.adapter_client !== first.adapter_client ||
        ticket.agent_id !== first.agent_id ||
        ticket.session_client !== first.session_client ||
        ticket.role !== first.role ||
        ticket.transport !== first.transport ||
        ticket.delivery_mode !== first.delivery_mode ||
        ticket.external_session_id !== first.external_session_id ||
        ticket.external_thread_id !== first.external_thread_id ||
        ticket.run_id !== first.run_id ||
        ticket.activation_mode !== first.activation_mode ||
        ticket.expected_lineage_id !== first.expected_lineage_id ||
        ticket.expected_head_session_id !== first.expected_head_session_id ||
        ticket.launch_reservation_id !== first.launch_reservation_id,
    )
  ) {
    fail("ticket bundle contains mixed bindings", 409, "TICKET_BINDING_MISMATCH");
  }
  assertActivationProof(sqlite, tickets, session, input.proof, now);
  const updated = withBundleTransition(
    sqlite,
    { bundleId: input.bundleId, pairs: [{ from: "PENDING", to: "ACTIVE" }] },
    () =>
      sqlite
        .prepare(
          `UPDATE adapter_session_tickets
           SET state = 'ACTIVE', hub_session_id = ?, lineage_id = ?, incarnation = ?,
               expires_at = ?, activated_at = ?, updated_at = ?
           WHERE bundle_id = ? AND state = 'PENDING'`,
        )
        .run(
          input.hubSessionId,
          input.lineageId,
          input.incarnation,
          activeExpiresAt,
          now,
          now,
          input.bundleId,
        ),
  );
  if (updated.changes !== tickets.length) {
    fail("ticket bundle changed during activation", 409, "TICKET_ACTIVATION_CONFLICT");
  }
  return bindingFromRows(
    sqlite
      .prepare("SELECT * FROM adapter_session_tickets WHERE bundle_id = ? ORDER BY purpose")
      .all(input.bundleId) as TicketRow[],
  );
}

function bindingFromRows(rows: TicketRow[]): SessionTicketBinding {
  const first = rows[0]!;
  if (
    rows.some(
      (row) =>
        row.state !== "ACTIVE" ||
        !row.hub_session_id ||
        !row.lineage_id ||
        row.incarnation === null ||
        !row.expires_at ||
        !row.activated_at,
    )
  ) {
    fail("ticket bundle is not fully active", 409, "TICKET_ACTIVATION_CONFLICT");
  }
  return {
    bundleId: first.bundle_id,
    state: "ACTIVE",
    projectId: first.project_id,
    agentId: first.agent_id,
    adapterClient: first.adapter_client,
    hubSessionId: first.hub_session_id!,
    lineageId: first.lineage_id!,
    incarnation: first.incarnation!,
    runId: first.run_id,
    activatedAt: first.activated_at!,
    expiresAt: rows.reduce(
      (earliest, row) => (row.expires_at! < earliest ? row.expires_at! : earliest),
      first.expires_at!,
    ),
    purposes: rows.map((row) => ({ id: row.id, purpose: row.purpose, state: "ACTIVE" })),
  };
}

export function getActiveSessionTicketBinding(
  sqlite: Database.Database,
  input: { bundleId?: string; hubSessionId?: string },
): SessionTicketBinding {
  if ((input.bundleId === undefined) === (input.hubSessionId === undefined)) {
    fail("exactly one active binding selector is required", 422, "TICKET_BINDING_MISMATCH");
  }
  const rows = input.bundleId
    ? (sqlite
        .prepare(
          "SELECT * FROM adapter_session_tickets WHERE bundle_id = ? AND state = 'ACTIVE' ORDER BY purpose",
        )
        .all(input.bundleId) as TicketRow[])
    : (sqlite
        .prepare(
          `SELECT ticket.* FROM adapter_session_tickets ticket
           JOIN adapter_session_tickets control
             ON control.bundle_id = ticket.bundle_id AND control.purpose = 'CONTROL'
           WHERE control.hub_session_id = ? AND control.state = 'ACTIVE'
             AND ticket.state = 'ACTIVE'
           ORDER BY ticket.purpose`,
        )
        .all(input.hubSessionId) as TicketRow[]);
  if (rows.length === 0) fail("active ticket binding was not found", 404, "TICKET_NOT_FOUND");
  if (new Set(rows.map((row) => row.bundle_id)).size !== 1) {
    fail(
      "multiple active CONTROL bundles exist for one session",
      409,
      "TICKET_ACTIVATION_CONFLICT",
    );
  }
  return bindingFromRows(rows);
}

function terminalBindingFromRows(rows: TicketRow[]): TerminalSessionTicketBinding {
  const first = rows[0]!;
  if (
    !first.hub_session_id ||
    !first.activated_at ||
    !first.expires_at ||
    !first.terminal_at ||
    !first.terminal_reason ||
    !["REVOKED", "EXPIRED", "SUPERSEDED"].includes(first.state) ||
    rows.some(
      (row) =>
        row.bundle_id !== first.bundle_id ||
        row.state !== first.state ||
        row.terminal_at !== first.terminal_at ||
        row.terminal_reason !== first.terminal_reason ||
        !row.activated_at ||
        !row.expires_at,
    )
  ) {
    fail("ticket bundle lacks one atomic terminal receipt", 409, "TICKET_ACTIVATION_CONFLICT");
  }
  const state = first.state as TerminalSessionTicketState;
  return {
    bundleId: first.bundle_id,
    state,
    projectId: first.project_id,
    agentId: first.agent_id as "codex" | "claude",
    adapterClient: first.adapter_client,
    hubSessionId: first.hub_session_id,
    lineageId: first.lineage_id,
    incarnation: first.incarnation,
    runId: first.run_id,
    activatedAt: first.activated_at,
    expiresAt: first.expires_at,
    terminalAt: first.terminal_at,
    terminalReason: first.terminal_reason,
    purposes: rows.map((row) => ({
      id: row.id,
      purpose: row.purpose,
      state,
      terminalAt: first.terminal_at!,
      terminalReason: first.terminal_reason!,
    })),
  };
}

/**
 * Terminalizes exactly the predecessor bundle used to authorize a same-session rotation.
 * This is intentionally a transaction-free primitive so registration/orchestration code can
 * compose it with other Store mutations. Callers that are not already transactional should use
 * rotateSessionTicketBundleForSession instead.
 */
export function supersedePredecessorSessionTicketBundle(
  sqlite: Database.Database,
  input: {
    successorBundleId: string;
    predecessorControlTicketId: string;
    hubSessionId: string;
    reason: string;
    now: string;
  },
): TerminalSessionTicketBinding {
  const now = canonicalInstant(input.now, "now");
  const successor = getActiveSessionTicketBinding(sqlite, { bundleId: input.successorBundleId });
  if (successor.hubSessionId !== input.hubSessionId) {
    fail("successor bundle is bound to another session", 409, "TICKET_ACTIVATION_CONFLICT");
  }
  const predecessorControl = sqlite
    .prepare("SELECT * FROM adapter_session_tickets WHERE id = ?")
    .get(input.predecessorControlTicketId) as TicketRow | undefined;
  if (
    !predecessorControl ||
    predecessorControl.purpose !== "CONTROL" ||
    predecessorControl.state !== "ACTIVE" ||
    predecessorControl.hub_session_id !== input.hubSessionId ||
    predecessorControl.bundle_id === input.successorBundleId
  ) {
    fail(
      "rotation predecessor is not the exact active CONTROL bundle",
      409,
      "TICKET_ACTIVATION_CONFLICT",
    );
  }
  const predecessorRows = sqlite
    .prepare("SELECT * FROM adapter_session_tickets WHERE bundle_id = ? ORDER BY purpose")
    .all(predecessorControl.bundle_id) as TicketRow[];
  const predecessor = bindingFromRows(predecessorRows);
  if (
    predecessor.hubSessionId !== input.hubSessionId ||
    predecessor.projectId !== successor.projectId ||
    predecessor.agentId !== successor.agentId ||
    predecessor.adapterClient !== successor.adapterClient ||
    predecessor.lineageId !== successor.lineageId ||
    predecessor.incarnation !== successor.incarnation
  ) {
    fail("rotation predecessor and successor bindings differ", 409, "TICKET_ACTIVATION_CONFLICT");
  }
  const activeControlBundles = sqlite
    .prepare(
      `SELECT bundle_id FROM adapter_session_tickets
       WHERE hub_session_id = ? AND purpose = 'CONTROL' AND state = 'ACTIVE'
       ORDER BY bundle_id`,
    )
    .all(input.hubSessionId) as Array<{ bundle_id: string }>;
  if (
    activeControlBundles.length !== 2 ||
    !activeControlBundles.some((row) => row.bundle_id === predecessor.bundleId) ||
    !activeControlBundles.some((row) => row.bundle_id === successor.bundleId)
  ) {
    fail(
      "rotation must have exactly one predecessor and one successor",
      409,
      "TICKET_ACTIVATION_CONFLICT",
    );
  }
  const result = withBundleTransition(
    sqlite,
    {
      bundleId: predecessor.bundleId,
      pairs: [{ from: "ACTIVE", to: "SUPERSEDED" }],
    },
    () =>
      sqlite
        .prepare(
          `UPDATE adapter_session_tickets
           SET state = 'SUPERSEDED', terminal_at = ?, terminal_reason = ?, updated_at = ?
           WHERE bundle_id = ? AND state = 'ACTIVE'`,
        )
        .run(now, input.reason, now, predecessor.bundleId),
  );
  if (result.changes !== predecessor.purposes.length) {
    fail("predecessor bundle changed during rotation", 409, "TICKET_ACTIVATION_CONFLICT");
  }
  const remaining = sqlite
    .prepare(
      `SELECT bundle_id FROM adapter_session_tickets
       WHERE hub_session_id = ? AND purpose = 'CONTROL' AND state = 'ACTIVE'`,
    )
    .all(input.hubSessionId) as Array<{ bundle_id: string }>;
  if (remaining.length !== 1 || remaining[0]!.bundle_id !== successor.bundleId) {
    fail("rotation did not leave one active successor", 409, "TICKET_ACTIVATION_CONFLICT");
  }
  return terminalBindingFromRows(
    sqlite
      .prepare("SELECT * FROM adapter_session_tickets WHERE bundle_id = ? ORDER BY purpose")
      .all(predecessor.bundleId) as TicketRow[],
  );
}

/**
 * Atomically rotates an ACTIVE session to a fresh 24-hour bundle. The predecessor CONTROL raw
 * value is the proof; every predecessor purpose becomes SUPERSEDED before the transaction commits.
 */
export function rotateSessionTicketBundleForSession(
  sqlite: Database.Database,
  input: ActivateSessionTicketBundleInput & { reason?: string },
): RotateSessionTicketBundleResult {
  if (input.proof.kind !== "SESSION_AUXILIARY") {
    fail(
      "same-session rotation requires SESSION_AUXILIARY proof",
      422,
      "TICKET_REPLACEMENT_PROOF_REQUIRED",
    );
  }
  const predecessorControlTicketId = input.proof.controlTicketId;
  return sqlite.transaction(() => {
    const binding = activateSessionTicketBundle(sqlite, input);
    const superseded = supersedePredecessorSessionTicketBundle(sqlite, {
      successorBundleId: input.bundleId,
      predecessorControlTicketId,
      hubSessionId: input.hubSessionId,
      reason: input.reason ?? `superseded by ${input.bundleId}`,
      now: input.now,
    });
    return { binding, superseded };
  })();
}

export function revokeSessionTicketBundle(
  sqlite: Database.Database,
  input: {
    bundleId: string;
    reason: string;
    now: string;
    state?: "REVOKED" | "EXPIRED" | "SUPERSEDED";
  },
): number {
  const state = input.state ?? "REVOKED";
  const now = canonicalInstant(input.now, "now");
  const rows = sqlite
    .prepare(
      "SELECT state FROM adapter_session_tickets WHERE bundle_id = ? AND state IN ('PENDING', 'ACTIVE')",
    )
    .all(input.bundleId) as Array<{ state: "PENDING" | "ACTIVE" }>;
  if (rows.length === 0) return 0;
  const result = withBundleTransition(
    sqlite,
    {
      bundleId: input.bundleId,
      pairs: [...new Set(rows.map((row) => row.state))].map((from) => ({ from, to: state })),
    },
    () =>
      sqlite
        .prepare(
          `UPDATE adapter_session_tickets
           SET state = ?, terminal_at = ?, terminal_reason = ?, updated_at = ?
           WHERE bundle_id = ? AND state IN ('PENDING', 'ACTIVE')`,
        )
        .run(state, now, input.reason, now, input.bundleId),
  );
  if (result.changes !== rows.length) {
    fail("ticket bundle changed during terminalization", 409, "TICKET_ACTIVATION_CONFLICT");
  }
  return result.changes;
}

export function closeSessionTicketsForHubSession(
  sqlite: Database.Database,
  input: { hubSessionId: string; reason: string; now: string; state?: "REVOKED" | "SUPERSEDED" },
): TerminalSessionTicketBinding {
  const state = input.state ?? "REVOKED";
  const now = canonicalInstant(input.now, "now");
  const active = getActiveSessionTicketBinding(sqlite, { hubSessionId: input.hubSessionId });
  const result = withBundleTransition(
    sqlite,
    { bundleId: active.bundleId, pairs: [{ from: "ACTIVE", to: state }] },
    () =>
      sqlite
        .prepare(
          `UPDATE adapter_session_tickets
           SET state = ?, terminal_at = ?, terminal_reason = ?, updated_at = ?
           WHERE bundle_id = ? AND state = 'ACTIVE'`,
        )
        .run(state, now, input.reason, now, active.bundleId),
  );
  if (result.changes !== active.purposes.length) {
    fail("ticket bundle changed during terminalization", 409, "TICKET_ACTIVATION_CONFLICT");
  }
  return terminalBindingFromRows(
    sqlite
      .prepare("SELECT * FROM adapter_session_tickets WHERE bundle_id = ? ORDER BY purpose")
      .all(active.bundleId) as TicketRow[],
  );
}

export function expireSessionTickets(sqlite: Database.Database, now: string): number {
  const canonicalNow = canonicalInstant(now, "now");
  const bundles = sqlite
    .prepare(
      `SELECT DISTINCT bundle_id FROM adapter_session_tickets
       WHERE (state = 'PENDING' AND unixepoch(offer_expires_at) <= unixepoch(?))
          OR (state = 'ACTIVE' AND unixepoch(expires_at) <= unixepoch(?))
       ORDER BY bundle_id`,
    )
    .all(canonicalNow, canonicalNow) as Array<{ bundle_id: string }>;
  return sqlite.transaction(() => {
    let changed = 0;
    for (const bundle of bundles) {
      const rows = sqlite
        .prepare(
          `SELECT state FROM adapter_session_tickets
           WHERE bundle_id = ? AND state IN ('PENDING', 'ACTIVE')`,
        )
        .all(bundle.bundle_id) as Array<{ state: "PENDING" | "ACTIVE" }>;
      if (rows.length === 0) continue;
      const result = withBundleTransition(
        sqlite,
        {
          bundleId: bundle.bundle_id,
          pairs: [...new Set(rows.map((row) => row.state))].map((from) => ({
            from,
            to: "EXPIRED",
          })),
        },
        () =>
          sqlite
            .prepare(
              `UPDATE adapter_session_tickets
               SET state = 'EXPIRED', terminal_at = ?, terminal_reason = 'ticket expired', updated_at = ?
               WHERE bundle_id = ?
                 AND ((state = 'PENDING' AND unixepoch(offer_expires_at) <= unixepoch(?))
                   OR (state = 'ACTIVE' AND unixepoch(expires_at) <= unixepoch(?)))`,
            )
            .run(canonicalNow, canonicalNow, bundle.bundle_id, canonicalNow, canonicalNow),
      );
      if (result.changes !== rows.length) {
        fail("expired bundle changed during maintenance", 409, "TICKET_ACTIVATION_CONFLICT");
      }
      changed += result.changes;
    }
    return changed;
  })();
}

/**
 * Materializes one exact expired ACTIVE session bundle for close/maintenance recovery and returns
 * its secret-free receipt. Ordinary authentication never calls this mutation.
 */
export function expireSessionTicketBundleForHubSession(
  sqlite: Database.Database,
  input: { hubSessionId: string; reason?: string; now: string },
): TerminalSessionTicketBinding {
  const now = canonicalInstant(input.now, "now");
  const controls = sqlite
    .prepare(
      `SELECT * FROM adapter_session_tickets
       WHERE hub_session_id = ? AND purpose = 'CONTROL' AND state = 'ACTIVE'
         AND unixepoch(expires_at) <= unixepoch(?)`,
    )
    .all(input.hubSessionId, now) as TicketRow[];
  if (controls.length !== 1) {
    fail("exactly one expired CONTROL bundle is required", 409, "TICKET_ACTIVATION_CONFLICT");
  }
  const control = controls[0]!;
  const rows = sqlite
    .prepare("SELECT * FROM adapter_session_tickets WHERE bundle_id = ? ORDER BY purpose")
    .all(control.bundle_id) as TicketRow[];
  const binding = bindingFromRows(rows);
  if (binding.hubSessionId !== input.hubSessionId) {
    fail("expired bundle is bound to another session", 409, "TICKET_ACTIVATION_CONFLICT");
  }
  const reason = input.reason ?? "ticket expired";
  const result = withBundleTransition(
    sqlite,
    { bundleId: binding.bundleId, pairs: [{ from: "ACTIVE", to: "EXPIRED" }] },
    () =>
      sqlite
        .prepare(
          `UPDATE adapter_session_tickets
           SET state = 'EXPIRED', terminal_at = ?, terminal_reason = ?, updated_at = ?
           WHERE bundle_id = ? AND state = 'ACTIVE' AND unixepoch(expires_at) <= unixepoch(?)`,
        )
        .run(now, reason, now, binding.bundleId, now),
  );
  if (result.changes !== binding.purposes.length) {
    fail("expired bundle changed during recovery", 409, "TICKET_ACTIVATION_CONFLICT");
  }
  return terminalBindingFromRows(
    sqlite
      .prepare("SELECT * FROM adapter_session_tickets WHERE bundle_id = ? ORDER BY purpose")
      .all(binding.bundleId) as TicketRow[],
  );
}

function authenticationProjection(row: TicketRow): SessionTicketAuthentication {
  const principalKind =
    row.purpose === "CAPTURE"
      ? "BRIDGE_CAPTURE"
      : row.purpose === "INJECTOR"
        ? "BRIDGE_INJECTOR"
        : "AGENT";
  const label =
    row.purpose === "CAPTURE"
      ? "UserPromptSubmit Capture"
      : row.purpose === "INJECTOR"
        ? "Synthetic Prompt Injector"
        : row.purpose === "MODEL_MCP"
          ? "Model MCP"
          : "Adapter Control";
  return {
    id: row.id,
    principalId: `prn_${
      row.purpose === "CAPTURE" ? "capture" : row.purpose === "INJECTOR" ? "inject" : "agent"
    }_${row.adapter_client}`,
    principalKind,
    displayName: `${row.adapter_client === "codex" ? "Codex" : "Claude"} ${label}`,
    scopes: row.state === "ACTIVE" ? [...SESSION_TICKET_SCOPES[row.purpose]] : [],
    projectId: row.project_id,
    adapterClient: row.adapter_client,
    agentId: row.agent_id,
    hubSessionId: row.hub_session_id,
    lineageId: row.lineage_id,
    incarnation: row.incarnation,
    purpose: row.purpose,
    state: row.state,
  };
}

export function findActiveSessionTicketsByDigest(
  sqlite: Database.Database,
  tokenSha256: string,
  now: string,
): SessionTicketAuthentication[] {
  const canonicalNow = canonicalInstant(now, "now");
  const rows = sqlite
    .prepare(
      `SELECT ticket.*
       FROM adapter_session_tickets ticket
       JOIN agent_sessions session ON session.id = ticket.hub_session_id
       JOIN session_lineages lineage ON lineage.id = ticket.lineage_id
       WHERE ticket.token_sha256 = ?
         AND ticket.state = 'ACTIVE'
         AND unixepoch(ticket.expires_at) > unixepoch(?)
         AND session.project_id = ticket.project_id
         AND session.agent_id = ticket.agent_id
         AND session.client = ticket.session_client
         AND session.lineage_id = ticket.lineage_id
         AND session.incarnation = ticket.incarnation
         AND session.connection_state <> 'CLOSED'
         AND lineage.project_id = ticket.project_id
         AND lineage.agent_id = ticket.agent_id
         AND lineage.client = ticket.session_client
         AND lineage.head_session_id = session.id
         AND lineage.head_incarnation = ticket.incarnation
         AND NOT EXISTS (
           SELECT 1 FROM adapter_session_tickets bundle_peer
           WHERE bundle_peer.bundle_id = ticket.bundle_id AND bundle_peer.state <> 'ACTIVE'
         )
         AND (
           SELECT COUNT(*) = CASE ticket.session_client
                    WHEN 'codex-app-server' THEN 3 WHEN 'codex-cli-hooks' THEN 2
                    WHEN 'claude-channel' THEN 1 WHEN 'claude-hooks' THEN 2 END
             AND SUM(member.purpose = 'CONTROL') = 1
             AND SUM(member.purpose = 'MODEL_MCP') =
               CASE WHEN ticket.session_client = 'codex-app-server' THEN 1 ELSE 0 END
             AND SUM(member.purpose = 'CAPTURE') =
               CASE WHEN ticket.session_client IN ('codex-cli-hooks', 'claude-hooks') THEN 1 ELSE 0 END
             AND SUM(member.purpose = 'INJECTOR') =
               CASE WHEN ticket.session_client = 'codex-app-server' THEN 1 ELSE 0 END
           FROM adapter_session_tickets member
           WHERE member.bundle_id = ticket.bundle_id
         )
         AND EXISTS (
           SELECT 1 FROM auth_principals principal
           WHERE principal.id = CASE ticket.purpose
             WHEN 'CAPTURE' THEN 'prn_capture_' || ticket.adapter_client
             WHEN 'INJECTOR' THEN 'prn_inject_' || ticket.adapter_client
             ELSE 'prn_agent_' || ticket.adapter_client
           END
             AND principal.status = 'ACTIVE'
             AND principal.client_type = ticket.adapter_client
         )
         AND (
           ticket.purpose NOT IN ('CAPTURE', 'INJECTOR')
           OR EXISTS (
             SELECT 1 FROM auth_credentials root_credential
             WHERE root_credential.id = ticket.offered_by_auth_credential_id
               AND root_credential.revoked_at IS NULL
               AND (root_credential.expires_at IS NULL
                 OR unixepoch(root_credential.expires_at) > unixepoch(?))
           )
         )`,
    )
    .all(tokenSha256, canonicalNow, canonicalNow) as TicketRow[];
  return rows.map(authenticationProjection);
}

export function findPendingSessionTicketByDigest(
  sqlite: Database.Database,
  tokenSha256: string,
  purpose: "MODEL_MCP" | "CONTROL",
  now: string,
): SessionTicketAuthentication[] {
  const canonicalNow = canonicalInstant(now, "now");
  const rows = sqlite
    .prepare(
      `SELECT * FROM adapter_session_tickets
       WHERE token_sha256 = ? AND purpose = ? AND state = 'PENDING'
         AND unixepoch(offer_expires_at) > unixepoch(?)
         AND EXISTS (
           SELECT 1 FROM auth_principals principal
           WHERE principal.id = CASE adapter_session_tickets.purpose
             WHEN 'CAPTURE' THEN 'prn_capture_' || adapter_session_tickets.adapter_client
             WHEN 'INJECTOR' THEN 'prn_inject_' || adapter_session_tickets.adapter_client
             ELSE 'prn_agent_' || adapter_session_tickets.adapter_client
           END
             AND principal.status = 'ACTIVE'
             AND principal.client_type = adapter_session_tickets.adapter_client
         )`,
    )
    .all(tokenSha256, purpose, canonicalNow) as TicketRow[];
  return rows.map(authenticationProjection);
}

export function findTerminalSessionTicketsByDigest(
  sqlite: Database.Database,
  tokenSha256: string,
): SessionTicketAuthentication[] {
  const rows = sqlite
    .prepare(
      `SELECT * FROM adapter_session_tickets
       WHERE token_sha256 = ? AND state IN ('REVOKED', 'EXPIRED', 'SUPERSEDED')
         AND hub_session_id IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM adapter_session_tickets bundle_peer
           WHERE bundle_peer.bundle_id = adapter_session_tickets.bundle_id
             AND (
               bundle_peer.state <> adapter_session_tickets.state
               OR bundle_peer.terminal_at IS NOT adapter_session_tickets.terminal_at
               OR bundle_peer.terminal_reason IS NOT adapter_session_tickets.terminal_reason
             )
         )
         AND (
           SELECT COUNT(*) = CASE adapter_session_tickets.session_client
                    WHEN 'codex-app-server' THEN 3 WHEN 'codex-cli-hooks' THEN 2
                    WHEN 'claude-channel' THEN 1 WHEN 'claude-hooks' THEN 2 END
             AND SUM(member.purpose = 'CONTROL') = 1
             AND SUM(member.purpose = 'MODEL_MCP') =
               CASE WHEN adapter_session_tickets.session_client = 'codex-app-server' THEN 1 ELSE 0 END
             AND SUM(member.purpose = 'CAPTURE') =
               CASE WHEN adapter_session_tickets.session_client IN ('codex-cli-hooks', 'claude-hooks') THEN 1 ELSE 0 END
             AND SUM(member.purpose = 'INJECTOR') =
               CASE WHEN adapter_session_tickets.session_client = 'codex-app-server' THEN 1 ELSE 0 END
           FROM adapter_session_tickets member
           WHERE member.bundle_id = adapter_session_tickets.bundle_id
         )
         AND EXISTS (
           SELECT 1 FROM auth_principals principal
           WHERE principal.id = CASE adapter_session_tickets.purpose
             WHEN 'CAPTURE' THEN 'prn_capture_' || adapter_session_tickets.adapter_client
             WHEN 'INJECTOR' THEN 'prn_inject_' || adapter_session_tickets.adapter_client
             ELSE 'prn_agent_' || adapter_session_tickets.adapter_client
           END
             AND principal.status = 'ACTIVE'
             AND principal.client_type = adapter_session_tickets.adapter_client
         )`,
    )
    .all(tokenSha256) as TicketRow[];
  return rows.map((row) => ({
    ...authenticationProjection(row),
    scopes: [],
    state: row.state,
  })) as SessionTicketAuthentication[];
}

export function findExpiredTerminalCurrentHeadControlTicketsByDigest(
  sqlite: Database.Database,
  tokenSha256: string,
): SessionTicketAuthentication[] {
  return findTerminalSessionTicketsByDigest(sqlite, tokenSha256).filter((ticket) => {
    if (
      ticket.purpose !== "CONTROL" ||
      ticket.state !== "EXPIRED" ||
      !ticket.hubSessionId ||
      !ticket.lineageId ||
      ticket.incarnation === null
    ) {
      return false;
    }
    return isCurrentOpenHeadTicket(sqlite, ticket);
  });
}

function isCurrentOpenHeadTicket(
  sqlite: Database.Database,
  ticket: SessionTicketAuthentication,
): boolean {
  return Boolean(
    ticket.hubSessionId &&
    ticket.lineageId &&
    ticket.incarnation !== null &&
    sqlite
      .prepare(
        `SELECT 1
           FROM agent_sessions session
           JOIN session_lineages lineage ON lineage.id = session.lineage_id
           JOIN adapter_session_tickets source_ticket ON source_ticket.id = ?
           WHERE session.id = ?
             AND session.project_id = ?
             AND session.agent_id = ?
             AND session.client = source_ticket.session_client
             AND session.role = source_ticket.role
             AND session.transport = source_ticket.transport
             AND session.delivery_mode = source_ticket.delivery_mode
             AND session.external_session_id IS source_ticket.external_session_id
             AND session.external_thread_id IS source_ticket.external_thread_id
             AND session.connection_state <> 'CLOSED'
             AND session.lineage_id = ?
             AND session.incarnation = ?
             AND lineage.project_id = session.project_id
             AND lineage.agent_id = session.agent_id
             AND lineage.client = session.client
             AND lineage.head_session_id = session.id
             AND lineage.head_incarnation = session.incarnation`,
      )
      .get(
        ticket.id,
        ticket.hubSessionId,
        ticket.projectId,
        ticket.agentId,
        ticket.lineageId,
        ticket.incarnation,
      ),
  );
}

export function findExpiredActiveControlTicketsByDigest(
  sqlite: Database.Database,
  tokenSha256: string,
  now: string,
): SessionTicketAuthentication[] {
  const canonicalNow = canonicalInstant(now, "now");
  const rows = sqlite
    .prepare(
      `SELECT ticket.*
       FROM adapter_session_tickets ticket
       JOIN agent_sessions session ON session.id = ticket.hub_session_id
       WHERE ticket.token_sha256 = ?
         AND ticket.purpose = 'CONTROL'
         AND ticket.state = 'ACTIVE'
         AND unixepoch(ticket.expires_at) <= unixepoch(?)
         AND session.project_id = ticket.project_id
         AND session.agent_id = ticket.agent_id
         AND session.client = ticket.session_client
         AND session.role = ticket.role
         AND session.transport = ticket.transport
         AND session.delivery_mode = ticket.delivery_mode
         AND session.external_session_id IS ticket.external_session_id
         AND session.external_thread_id IS ticket.external_thread_id
         AND session.lineage_id = ticket.lineage_id
         AND session.incarnation = ticket.incarnation
         AND NOT EXISTS (
           SELECT 1 FROM adapter_session_tickets bundle_peer
           WHERE bundle_peer.bundle_id = ticket.bundle_id
             AND (
               bundle_peer.state <> 'ACTIVE'
               OR bundle_peer.hub_session_id IS NOT ticket.hub_session_id
               OR bundle_peer.lineage_id IS NOT ticket.lineage_id
               OR bundle_peer.incarnation IS NOT ticket.incarnation
               OR bundle_peer.expires_at IS NOT ticket.expires_at
               OR bundle_peer.activated_at IS NOT ticket.activated_at
               OR bundle_peer.terminal_at IS NOT NULL
               OR bundle_peer.terminal_reason IS NOT NULL
             )
         )
         AND (
           SELECT COUNT(*) = CASE ticket.session_client
                    WHEN 'codex-app-server' THEN 3 WHEN 'codex-cli-hooks' THEN 2
                    WHEN 'claude-channel' THEN 1 WHEN 'claude-hooks' THEN 2 END
             AND SUM(member.purpose = 'CONTROL') = 1
             AND SUM(member.purpose = 'MODEL_MCP') =
               CASE WHEN ticket.session_client = 'codex-app-server' THEN 1 ELSE 0 END
             AND SUM(member.purpose = 'CAPTURE') =
               CASE WHEN ticket.session_client IN ('codex-cli-hooks', 'claude-hooks') THEN 1 ELSE 0 END
             AND SUM(member.purpose = 'INJECTOR') =
               CASE WHEN ticket.session_client = 'codex-app-server' THEN 1 ELSE 0 END
           FROM adapter_session_tickets member
           WHERE member.bundle_id = ticket.bundle_id
         )
         AND EXISTS (
           SELECT 1 FROM auth_principals principal
           WHERE principal.id = 'prn_agent_' || ticket.adapter_client
             AND principal.status = 'ACTIVE'
             AND principal.client_type = ticket.adapter_client
         )`,
    )
    .all(tokenSha256, canonicalNow) as TicketRow[];
  return rows.map((row) => ({
    ...authenticationProjection(row),
    scopes: [],
    state: "EXPIRED",
  }));
}

export function findDormantCurrentHeadControlTicketsByDigest(
  sqlite: Database.Database,
  tokenSha256: string,
  now: string,
): SessionTicketAuthentication[] {
  return [
    ...findExpiredTerminalCurrentHeadControlTicketsByDigest(sqlite, tokenSha256),
    ...findExpiredActiveControlTicketsByDigest(sqlite, tokenSha256, now).filter((ticket) =>
      isCurrentOpenHeadTicket(sqlite, ticket),
    ),
  ];
}

export function findActiveSessionTicketById(
  sqlite: Database.Database,
  ticketIdValue: string,
  now: string,
): SessionTicketAuthentication[] {
  const row = sqlite
    .prepare("SELECT token_sha256 FROM adapter_session_tickets WHERE id = ?")
    .get(ticketIdValue) as { token_sha256: string } | undefined;
  return row ? findActiveSessionTicketsByDigest(sqlite, row.token_sha256, now) : [];
}
