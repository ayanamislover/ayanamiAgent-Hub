import { createHash, randomBytes } from "node:crypto";
import {
  type AbortSyntheticPromptInput,
  type AbortedSyntheticPrompt,
  type AdapterAuthorityDeliveryCandidate,
  type CaptureUserTurnInput,
  type CredentialScope,
  type PrepareSyntheticPromptInput,
  type PreparedSyntheticPrompt,
  type UserTurn,
  createId,
  extractSyntheticOriginNonce,
  nowIso,
  renderAdapterAuthorityDeliveryCandidate,
} from "@crossagent/protocol";
import { ConflictError, ForbiddenError, HubError, NotFoundError } from "../../domain/errors.js";
import type { RequestPrincipal } from "../../security/local-auth.js";
import type { AuthorityAttestationService } from "../authority-attestation.js";
import { mutationFingerprint, type StoreContext } from "./context.js";
import { getAuthorityDeliveryCandidate } from "./directives.js";
import { getMessage } from "./messages.js";

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

type CaptureBindingRow = {
  id: string;
  principal_id: string;
  credential_id: string;
  session_ticket_id: string | null;
  hub_session_id: string;
};

type CaptureReceiptRow = {
  request_sha256: string;
  status: "CAPTURED" | "EXCLUDED";
  user_turn_id: string | null;
  synthetic_reservation_id: string | null;
};

type SyntheticReservationRow = {
  id: string;
  source_message_id: string;
  surface_attempt_id: string;
  recipient_fence: number;
  rpc_method: PreparedSyntheticPrompt["rpcMethod"];
  origin_nonce: string;
  raw_text: string;
  raw_text_sha256: string;
  prepared_at: string;
  expires_at: string;
  state: "PREPARED" | "CONSUMED" | "ABORTED";
  aborted_at: string | null;
  abort_reason: string | null;
  abort_idempotency_key: string | null;
  abort_request_sha256: string | null;
  session_ticket_id: string | null;
};

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function assertScope(principal: RequestPrincipal, required: CredentialScope): void {
  if (!principal.scopes.includes(required)) {
    throw new ForbiddenError(`Principal does not have ${required}`);
  }
}

function resolveCaptureBinding(
  ctx: StoreContext,
  principal: RequestPrincipal,
  input: Pick<CaptureUserTurnInput, "project_id" | "client_type" | "session_id">,
): CaptureBindingRow {
  assertScope(principal, "user_turn:capture");
  if (principal.kind !== "BRIDGE_CAPTURE") {
    throw new ForbiddenError("Only a Bridge capture principal can create a user turn");
  }
  if (
    principal.credentialClass !== "SESSION_TICKET" ||
    principal.ticketPurpose !== "CAPTURE" ||
    principal.ticketState !== "ACTIVE" ||
    principal.projectId !== input.project_id ||
    principal.clientType !== input.client_type ||
    principal.adapterClient !== input.client_type ||
    principal.agentId !== input.client_type ||
    principal.hubSessionId === null
  ) {
    throw new ForbiddenError("Capture credential is bound to another client type");
  }
  const project = ctx.sqlite.prepare("SELECT id FROM projects WHERE id = ?").get(input.project_id);
  if (!project) throw new NotFoundError("Project", input.project_id);
  const bindings = ctx.sqlite
    .prepare(
      `SELECT b.id, b.principal_id, b.credential_id, b.session_ticket_id, b.hub_session_id
       FROM capture_session_bindings b
       JOIN auth_principals capture_principal ON capture_principal.id = b.principal_id
       JOIN auth_credentials credential ON credential.id = b.credential_id
       JOIN adapter_session_tickets ticket ON ticket.id = b.session_ticket_id
       JOIN agent_sessions s ON s.id = b.hub_session_id
       JOIN session_lineages lineage ON lineage.id = s.lineage_id
       WHERE b.session_ticket_id = ? AND b.principal_id = ? AND b.project_id = ?
         AND b.client_type = ? AND b.source_session_id = ? AND b.revoked_at IS NULL
         AND b.hub_session_id = ?
         AND capture_principal.kind = 'BRIDGE_CAPTURE'
         AND capture_principal.status = 'ACTIVE'
         AND capture_principal.client_type = b.client_type
         AND credential.principal_id = b.principal_id
         AND credential.revoked_at IS NULL
         AND (credential.expires_at IS NULL OR credential.expires_at > ?)
         AND ticket.purpose = 'CAPTURE' AND ticket.state = 'ACTIVE'
         AND ticket.expires_at > ? AND ticket.offered_by_auth_credential_id = b.credential_id
         AND ticket.project_id = b.project_id AND ticket.adapter_client = b.client_type
         AND ticket.agent_id = b.client_type AND ticket.hub_session_id = b.hub_session_id
         AND ticket.lineage_id = s.lineage_id AND ticket.incarnation = s.incarnation
         AND s.project_id = b.project_id AND s.agent_id = b.client_type
         AND s.client = CASE b.client_type
           WHEN 'codex' THEN 'codex-cli-hooks'
           WHEN 'claude' THEN 'claude-hooks'
         END
         AND s.connection_state <> 'CLOSED'
         AND lineage.head_session_id = s.id AND lineage.head_incarnation = s.incarnation
       ORDER BY s.connected_at DESC, s.id DESC`,
    )
    .all(
      principal.credentialId,
      principal.id,
      input.project_id,
      input.client_type,
      input.session_id,
      principal.hubSessionId,
      nowIso(),
      nowIso(),
    ) as CaptureBindingRow[];
  if (bindings.length !== 1) {
    throw new ForbiddenError("Capture source is not bound to one open Hook session");
  }
  return bindings[0]!;
}

function resolveInjectorCaptureBinding(
  ctx: StoreContext,
  clientType: "codex" | "claude",
  projectId: string,
  externalSessionId: string,
): CaptureBindingRow {
  const rows = ctx.sqlite
    .prepare(
      `SELECT binding.id, binding.principal_id, binding.credential_id,
              binding.session_ticket_id, binding.hub_session_id
       FROM capture_session_bindings binding
       JOIN auth_principals principal ON principal.id = binding.principal_id
       JOIN auth_credentials credential ON credential.id = binding.credential_id
       JOIN adapter_session_tickets ticket ON ticket.id = binding.session_ticket_id
       JOIN agent_sessions session ON session.id = binding.hub_session_id
       JOIN session_lineages lineage ON lineage.id = session.lineage_id
       WHERE binding.project_id = ? AND binding.client_type = ?
         AND binding.source_session_id = ? AND binding.revoked_at IS NULL
         AND principal.kind = 'BRIDGE_CAPTURE' AND principal.status = 'ACTIVE'
         AND principal.client_type = binding.client_type
         AND credential.principal_id = principal.id AND credential.revoked_at IS NULL
         AND (credential.expires_at IS NULL OR julianday(credential.expires_at) > julianday('now'))
         AND ticket.purpose = 'CAPTURE' AND ticket.state = 'ACTIVE'
         AND julianday(ticket.expires_at) > julianday('now')
         AND ticket.offered_by_auth_credential_id = binding.credential_id
         AND ticket.project_id = binding.project_id
         AND ticket.adapter_client = binding.client_type
         AND ticket.agent_id = binding.client_type
         AND ticket.hub_session_id = binding.hub_session_id
         AND ticket.lineage_id = session.lineage_id AND ticket.incarnation = session.incarnation
         AND session.project_id = binding.project_id AND session.agent_id = binding.client_type
         AND session.client = CASE binding.client_type
           WHEN 'codex' THEN 'codex-cli-hooks'
           WHEN 'claude' THEN 'claude-hooks'
         END
         AND session.external_session_id = binding.source_session_id
         AND session.connection_state <> 'CLOSED'
         AND lineage.head_session_id = session.id AND lineage.head_incarnation = session.incarnation
       ORDER BY session.connected_at DESC, session.id DESC`,
    )
    .all(projectId, clientType, externalSessionId) as CaptureBindingRow[];
  if (rows.length !== 1) {
    throw new ForbiddenError("Injector requires one exact live Hook capture binding");
  }
  return rows[0]!;
}

function mapUserTurn(row: UserTurnRow): UserTurn {
  return {
    id: row.id,
    projectId: row.project_id,
    sourcePrincipalId: row.source_principal_id,
    sourceCredentialId: row.source_credential_id,
    sourceBindingId: row.source_binding_id,
    sourceHubSessionId: row.source_hub_session_id,
    clientType: row.client_type,
    sessionId: row.source_session_id,
    turnId: row.source_turn_id,
    cwd: row.cwd,
    rawText: row.raw_text,
    rawTextSha256: row.raw_text_sha256,
    capturedAt: row.captured_at,
    receivedAt: row.received_at,
    correlationId: row.correlation_id,
  };
}

function mapSyntheticReservation(
  row: SyntheticReservationRow,
  replayed: boolean,
  authorityCandidate: AdapterAuthorityDeliveryCandidate,
): PreparedSyntheticPrompt {
  return {
    id: row.id,
    sourceMessageId: row.source_message_id,
    surfaceAttemptId: row.surface_attempt_id,
    recipientFence: row.recipient_fence,
    rpcMethod: row.rpc_method,
    originNonce: row.origin_nonce,
    text: row.raw_text,
    rawTextSha256: row.raw_text_sha256,
    authorityCandidate,
    preparedAt: row.prepared_at,
    expiresAt: row.expires_at,
    state: "PREPARED",
    replayed,
  };
}

export type CaptureUserTurnResult =
  | { status: "CAPTURED"; userTurn: UserTurn; syntheticReservationId: null }
  | { status: "EXCLUDED"; userTurn: null; syntheticReservationId: string };

export function captureUserTurn(
  ctx: StoreContext,
  principal: RequestPrincipal,
  input: CaptureUserTurnInput,
): CaptureUserTurnResult {
  const requestSha256 = mutationFingerprint(input);
  const receivedAt = nowIso();
  const rawTextSha256 = sha256(input.raw_prompt);
  const embeddedSyntheticNonce = extractSyntheticOriginNonce(input.raw_prompt);
  if (
    input.synthetic_origin_nonce !== undefined &&
    input.synthetic_origin_nonce !== embeddedSyntheticNonce
  ) {
    throw new HubError(
      "Synthetic origin nonce does not match the raw prompt envelope",
      422,
      "SYNTHETIC_PROMPT_NONCE_MISMATCH",
    );
  }
  const events: ReturnType<StoreContext["appendEvent"]>[] = [];
  const transaction = ctx.sqlite.transaction((): CaptureUserTurnResult => {
    const existing = ctx.sqlite
      .prepare(
        `SELECT request_sha256, status, user_turn_id, synthetic_reservation_id
          FROM user_turn_capture_receipts
          WHERE session_ticket_id = ? AND idempotency_key = ?`,
      )
      .get(principal.credentialId, input.idempotency_key) as CaptureReceiptRow | undefined;
    const terminalCaptureReplay =
      principal.kind === "BRIDGE_CAPTURE" &&
      principal.credentialClass === "SESSION_TICKET" &&
      principal.ticketPurpose === "CAPTURE" &&
      principal.ticketState !== null &&
      principal.ticketState !== "ACTIVE";
    const replayExisting = (receipt: CaptureReceiptRow): CaptureUserTurnResult => {
      if (receipt.request_sha256 !== requestSha256) {
        throw new ConflictError("Capture idempotency key was reused with a different user turn");
      }
      if (receipt.status === "EXCLUDED") {
        return {
          status: "EXCLUDED",
          userTurn: null,
          syntheticReservationId: receipt.synthetic_reservation_id!,
        };
      }
      return {
        status: "CAPTURED",
        userTurn: getUserTurn(ctx, receipt.user_turn_id!),
        syntheticReservationId: null,
      };
    };
    if (terminalCaptureReplay) {
      if (!existing) {
        throw new ForbiddenError(
          "A terminal CAPTURE ticket can replay only its exact committed receipt",
        );
      }
      return replayExisting(existing);
    }
    const binding = resolveCaptureBinding(ctx, principal, input);
    if (existing) return replayExisting(existing);
    const existingTurn = ctx.sqlite
      .prepare(
        `SELECT * FROM user_turns
         WHERE id = ?
            OR (? IS NOT NULL AND project_id = ? AND client_type = ?
                AND source_session_id = ? AND source_turn_id = ?)
         ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END
         LIMIT 1`,
      )
      .get(
        input.user_turn_id,
        input.turn_id ?? null,
        input.project_id,
        input.client_type,
        input.session_id,
        input.turn_id ?? null,
        input.user_turn_id,
      ) as UserTurnRow | undefined;
    if (existingTurn) {
      const sameFact =
        existingTurn.id === input.user_turn_id &&
        existingTurn.project_id === input.project_id &&
        existingTurn.source_principal_id === principal.id &&
        existingTurn.source_credential_id === binding.credential_id &&
        existingTurn.source_session_ticket_id === principal.credentialId &&
        existingTurn.source_binding_id === binding.id &&
        existingTurn.source_hub_session_id === binding.hub_session_id &&
        existingTurn.client_type === input.client_type &&
        existingTurn.source_session_id === input.session_id &&
        existingTurn.source_turn_id === (input.turn_id ?? null) &&
        existingTurn.cwd === input.cwd &&
        existingTurn.raw_text === input.raw_prompt &&
        existingTurn.raw_text_sha256 === rawTextSha256 &&
        existingTurn.captured_at === input.captured_at &&
        existingTurn.correlation_id === (input.correlation_id ?? null);
      if (!sameFact) {
        throw new ConflictError("User turn id or source turn already has different captured facts");
      }
      ctx.sqlite
        .prepare(
          `INSERT INTO user_turn_capture_receipts(
              id, principal_id, credential_id, session_ticket_id, binding_id,
              idempotency_key, request_sha256,
              status, user_turn_id, synthetic_reservation_id, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'CAPTURED', ?, NULL, ?)`,
        )
        .run(
          createId("ucr"),
          principal.id,
          binding.credential_id,
          principal.credentialId,
          binding.id,
          input.idempotency_key,
          requestSha256,
          existingTurn.id,
          receivedAt,
        );
      return {
        status: "CAPTURED",
        userTurn: mapUserTurn(existingTurn),
        syntheticReservationId: null,
      };
    }
    const reservation = embeddedSyntheticNonce
      ? (ctx.sqlite
          .prepare(
            `SELECT id FROM synthetic_prompt_reservations
             WHERE capture_binding_id = ? AND capture_principal_id = ?
               AND project_id = ? AND client_type = ?
               AND external_session_id = ? AND origin_nonce = ? AND raw_text_sha256 = ?
               AND raw_text = ?
               AND state = 'PREPARED'
               AND julianday(?) >= julianday(prepared_at)
               AND julianday(?) <= julianday(expires_at)
             ORDER BY prepared_at, id LIMIT 1`,
          )
          .get(
            binding.id,
            principal.id,
            input.project_id,
            input.client_type,
            input.session_id,
            embeddedSyntheticNonce,
            rawTextSha256,
            input.raw_prompt,
            input.captured_at,
            input.captured_at,
          ) as { id: string } | undefined)
      : undefined;
    if (reservation) {
      const consumed = ctx.sqlite
        .prepare(
          `UPDATE synthetic_prompt_reservations
           SET state = 'CONSUMED', consumed_at = ?
           WHERE id = ? AND state = 'PREPARED'`,
        )
        .run(receivedAt, reservation.id);
      if (consumed.changes !== 1) {
        throw new ConflictError("Synthetic prompt reservation was already consumed");
      }
      ctx.sqlite
        .prepare(
          `INSERT INTO user_turn_capture_receipts(
              id, principal_id, credential_id, session_ticket_id, binding_id,
              idempotency_key, request_sha256,
              status, user_turn_id, synthetic_reservation_id, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'EXCLUDED', NULL, ?, ?)`,
        )
        .run(
          createId("ucr"),
          principal.id,
          binding.credential_id,
          principal.credentialId,
          binding.id,
          input.idempotency_key,
          requestSha256,
          reservation.id,
          receivedAt,
        );
      events.push(
        ctx.appendEvent({
          projectId: input.project_id,
          type: "user_turn.synthetic_excluded",
          actorType: "system",
          actorId: principal.id,
          aggregateType: "synthetic_prompt_reservation",
          aggregateId: reservation.id,
          causationId: input.user_turn_id,
          correlationId: input.correlation_id ?? input.user_turn_id,
          payload: {
            clientType: input.client_type,
            sessionId: input.session_id,
            rawTextSha256,
          },
        }),
      );
      return { status: "EXCLUDED", userTurn: null, syntheticReservationId: reservation.id };
    }
    if (embeddedSyntheticNonce) {
      throw new ConflictError(
        "Synthetic prompt does not match one exact PREPARED capture reservation",
      );
    }

    ctx.sqlite
      .prepare(
        `INSERT INTO user_turns(
            id, project_id, source_principal_id, source_credential_id,
            source_session_ticket_id, source_binding_id,
            source_hub_session_id, client_type, source_session_id, source_turn_id,
            cwd, raw_text, raw_text_sha256, captured_at, received_at, idempotency_key,
            request_sha256, correlation_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.user_turn_id,
        input.project_id,
        principal.id,
        binding.credential_id,
        principal.credentialId,
        binding.id,
        binding.hub_session_id,
        input.client_type,
        input.session_id,
        input.turn_id ?? null,
        input.cwd,
        input.raw_prompt,
        rawTextSha256,
        input.captured_at,
        receivedAt,
        input.idempotency_key,
        requestSha256,
        input.correlation_id ?? null,
      );
    ctx.sqlite
      .prepare(
        `INSERT INTO user_turn_capture_receipts(
             id, principal_id, credential_id, session_ticket_id, binding_id,
             idempotency_key, request_sha256,
             status, user_turn_id, synthetic_reservation_id, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 'CAPTURED', ?, NULL, ?)`,
      )
      .run(
        createId("ucr"),
        principal.id,
        binding.credential_id,
        principal.credentialId,
        binding.id,
        input.idempotency_key,
        requestSha256,
        input.user_turn_id,
        receivedAt,
      );
    events.push(
      ctx.appendEvent({
        projectId: input.project_id,
        type: "user_turn.captured",
        actorType: "system",
        actorId: principal.id,
        aggregateType: "user_turn",
        aggregateId: input.user_turn_id,
        causationId: null,
        correlationId: input.correlation_id ?? input.user_turn_id,
        payload: {
          clientType: input.client_type,
          sessionId: input.session_id,
          turnId: input.turn_id ?? null,
          rawTextSha256,
          capturedAt: input.captured_at,
        },
      }),
    );
    return {
      status: "CAPTURED",
      userTurn: getUserTurn(ctx, input.user_turn_id),
      syntheticReservationId: null,
    };
  });
  const result = transaction.immediate();
  for (const event of events) ctx.bus.publish(event);
  return result;
}

export function getUserTurn(ctx: StoreContext, userTurnId: string): UserTurn {
  const row = ctx.sqlite.prepare("SELECT * FROM user_turns WHERE id = ?").get(userTurnId) as
    UserTurnRow | undefined;
  if (!row) throw new NotFoundError("User turn", userTurnId);
  return mapUserTurn(row);
}

export function prepareSyntheticPrompt(
  ctx: StoreContext,
  signer: AuthorityAttestationService,
  principal: RequestPrincipal,
  messageId: string,
  input: PrepareSyntheticPromptInput,
): PreparedSyntheticPrompt {
  assertScope(principal, "synthetic_prompt:reserve");
  if (principal.kind !== "BRIDGE_INJECTOR") {
    throw new ForbiddenError("Only a Bridge injector principal can prepare a synthetic prompt");
  }
  const message = getMessage(ctx, messageId);
  if (
    principal.credentialClass !== "SESSION_TICKET" ||
    principal.ticketPurpose !== "INJECTOR" ||
    principal.ticketState !== "ACTIVE" ||
    !principal.clientType ||
    principal.projectId !== message.projectId ||
    principal.adapterClient !== principal.clientType ||
    principal.agentId !== principal.clientType ||
    principal.hubSessionId === null ||
    principal.hubSessionId !== input.injector_hub_session_id
  ) {
    throw new ForbiddenError("Injector credential is not bound to the requested Hub session");
  }
  const session = ctx.sqlite
    .prepare(
      `SELECT s.id, s.project_id, s.agent_id, s.client, s.external_session_id,
              s.connection_state, s.lineage_id, s.incarnation, l.head_session_id,
              l.head_incarnation, ticket.offered_by_auth_credential_id AS credential_id
       FROM agent_sessions s
       JOIN session_lineages l ON l.id = s.lineage_id
       JOIN adapter_session_tickets ticket ON ticket.hub_session_id = s.id
       WHERE s.id = ? AND ticket.id = ? AND ticket.purpose = 'INJECTOR'
         AND ticket.state = 'ACTIVE' AND ticket.expires_at > ?
         AND ticket.project_id = s.project_id AND ticket.agent_id = s.agent_id
         AND ticket.adapter_client = s.agent_id
         AND ticket.lineage_id = s.lineage_id AND ticket.incarnation = s.incarnation`,
    )
    .get(principal.hubSessionId, principal.credentialId, nowIso()) as
    | {
        id: string;
        project_id: string;
        agent_id: string;
        client: string;
        external_session_id: string | null;
        connection_state: string;
        lineage_id: string | null;
        incarnation: number | null;
        head_session_id: string | null;
        head_incarnation: number;
        credential_id: string | null;
      }
    | undefined;
  if (
    !session ||
    session.connection_state === "CLOSED" ||
    session.project_id !== message.projectId ||
    session.agent_id !== principal.clientType ||
    session.client !== `${principal.clientType}-app-server` ||
    !session.external_session_id ||
    !session.credential_id ||
    session.lineage_id !== principal.lineageId ||
    session.incarnation !== principal.incarnation ||
    session.head_session_id !== session.id ||
    session.head_incarnation !== session.incarnation
  ) {
    throw new ForbiddenError("Injector is not bound to the current app-server session");
  }
  const surface = ctx.sqlite
    .prepare(
      `SELECT surface.id
       FROM message_surface_attempts surface
       JOIN message_recipients recipient ON recipient.id = surface.recipient_id
       WHERE surface.id = ? AND surface.message_id = ? AND surface.session_id = ?
         AND surface.recipient_fence = ? AND surface.state = 'ACTIVE'
         AND recipient.message_id = ? AND recipient.recipient_agent_id = ?`,
    )
    .get(
      input.surface_attempt_id,
      messageId,
      session.id,
      input.recipient_fence,
      messageId,
      principal.clientType,
    );
  if (!surface) {
    throw new ForbiddenError("Synthetic prompt requires the exact active message surface permit");
  }
  const authorityCandidate = getAuthorityDeliveryCandidate(ctx, signer, principal, messageId, {
    sessionId: session.id,
    surfaceAttemptId: input.surface_attempt_id,
    recipientFence: input.recipient_fence,
  });
  const captureBinding = resolveInjectorCaptureBinding(
    ctx,
    principal.clientType,
    message.projectId,
    session.external_session_id,
  );
  const requestSha256 = mutationFingerprint({ messageId, ...input });
  let event: ReturnType<StoreContext["appendEvent"]> | null = null;
  const transaction = ctx.sqlite.transaction((): PreparedSyntheticPrompt => {
    const existing = ctx.sqlite
      .prepare(
        `SELECT id, source_message_id, surface_attempt_id, recipient_fence, rpc_method,
                origin_nonce, raw_text, raw_text_sha256, prepared_at, expires_at, state,
                request_sha256, session_ticket_id
         FROM synthetic_prompt_reservations
          WHERE session_ticket_id = ? AND idempotency_key = ?`,
      )
      .get(principal.credentialId, input.idempotency_key) as
      (SyntheticReservationRow & { request_sha256: string }) | undefined;
    if (existing) {
      if (existing.request_sha256 !== requestSha256) {
        throw new ConflictError(
          "Synthetic reservation idempotency key was reused with another prompt",
        );
      }
      if (existing.state !== "PREPARED" || Date.parse(existing.expires_at) < Date.now()) {
        throw new ConflictError("Synthetic prompt reservation is no longer executable");
      }
      const currentText = renderAdapterAuthorityDeliveryCandidate(
        authorityCandidate,
        existing.origin_nonce,
      );
      if (currentText !== existing.raw_text || sha256(currentText) !== existing.raw_text_sha256) {
        throw new HubError(
          "Prepared synthetic Authority candidate no longer matches its reserved text",
          409,
          "SYNTHETIC_AUTHORITY_CANDIDATE_CHANGED",
        );
      }
      return mapSyntheticReservation(existing, true, authorityCandidate);
    }
    if (
      ctx.sqlite
        .prepare(
          `SELECT 1 FROM synthetic_prompt_reservations
           WHERE surface_attempt_id = ? AND state = 'PREPARED'`,
        )
        .get(input.surface_attempt_id)
    ) {
      throw new ConflictError("Synthetic surface already has an executable reservation");
    }
    const id = createId("spr");
    const originNonce = randomBytes(32).toString("base64url");
    const text = renderAdapterAuthorityDeliveryCandidate(authorityCandidate, originNonce);
    const rawTextSha256 = sha256(text);
    const preparedAt = nowIso();
    const expiresAt = new Date(Date.parse(preparedAt) + 120_000).toISOString();
    ctx.sqlite
      .prepare(
        `INSERT INTO synthetic_prompt_reservations(
           id, project_id, principal_id, credential_id, session_ticket_id,
           capture_principal_id, capture_binding_id,
           client_type,
           external_session_id, injector_hub_session_id, source_message_id, surface_attempt_id,
           recipient_fence, rpc_method, origin_nonce, raw_text, raw_text_sha256, state,
           prepared_at, expires_at, consumed_at, aborted_at, idempotency_key, request_sha256,
           correlation_id, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PREPARED',
                    ?, ?, NULL, NULL, ?, ?, ?, ?)`,
      )
      .run(
        id,
        message.projectId,
        principal.id,
        session.credential_id,
        principal.credentialId,
        captureBinding.principal_id,
        captureBinding.id,
        principal.clientType,
        session.external_session_id,
        session.id,
        messageId,
        input.surface_attempt_id,
        input.recipient_fence,
        input.rpc_method,
        originNonce,
        text,
        rawTextSha256,
        preparedAt,
        expiresAt,
        input.idempotency_key,
        requestSha256,
        message.threadId,
        preparedAt,
      );
    event = ctx.appendEvent({
      projectId: message.projectId,
      type: "synthetic_prompt.prepared",
      actorType: "system",
      actorId: principal.id,
      aggregateType: "synthetic_prompt_reservation",
      aggregateId: id,
      causationId: messageId,
      correlationId: message.threadId,
      payload: {
        clientType: principal.clientType,
        injectorHubSessionId: session.id,
        externalSessionId: session.external_session_id,
        surfaceAttemptId: input.surface_attempt_id,
        recipientFence: input.recipient_fence,
        rpcMethod: input.rpc_method,
        rawTextSha256,
        expiresAt,
        capturePrincipalId: captureBinding.principal_id,
        captureBindingId: captureBinding.id,
      },
    });
    return {
      id,
      sourceMessageId: messageId,
      surfaceAttemptId: input.surface_attempt_id,
      recipientFence: input.recipient_fence,
      rpcMethod: input.rpc_method,
      originNonce,
      text,
      rawTextSha256,
      authorityCandidate,
      preparedAt,
      expiresAt,
      state: "PREPARED",
      replayed: false,
    };
  });
  const result = transaction.immediate();
  if (event) ctx.bus.publish(event);
  return result;
}

export function abortSyntheticPrompt(
  ctx: StoreContext,
  principal: RequestPrincipal,
  reservationId: string,
  input: AbortSyntheticPromptInput,
): AbortedSyntheticPrompt {
  assertScope(principal, "synthetic_prompt:reserve");
  if (
    principal.kind !== "BRIDGE_INJECTOR" ||
    principal.credentialClass !== "SESSION_TICKET" ||
    principal.ticketPurpose !== "INJECTOR" ||
    principal.ticketState !== "ACTIVE" ||
    !principal.clientType ||
    principal.hubSessionId === null ||
    principal.hubSessionId !== input.injector_hub_session_id
  ) {
    throw new ForbiddenError("Only a Bridge injector principal can abort a synthetic prompt");
  }
  const requestSha256 = mutationFingerprint({ reservationId, ...input });
  let event: ReturnType<StoreContext["appendEvent"]> | null = null;
  const transaction = ctx.sqlite.transaction((): AbortedSyntheticPrompt => {
    const row = ctx.sqlite
      .prepare(
        `SELECT reservation.*, session.project_id AS session_project_id,
                 session.agent_id AS session_agent_id, session.connection_state,
                 session.lineage_id AS session_lineage_id,
                 session.incarnation AS session_incarnation,
                 lineage.head_session_id, lineage.head_incarnation,
                 ticket.state AS ticket_state, ticket.expires_at AS ticket_expires_at,
                 surface.state AS surface_state
          FROM synthetic_prompt_reservations reservation
          JOIN agent_sessions session ON session.id = reservation.injector_hub_session_id
          JOIN session_lineages lineage ON lineage.id = session.lineage_id
          JOIN adapter_session_tickets ticket ON ticket.id = reservation.session_ticket_id
          JOIN message_surface_attempts surface ON surface.id = reservation.surface_attempt_id
         WHERE reservation.id = ?`,
      )
      .get(reservationId) as
      | (SyntheticReservationRow & {
          project_id: string;
          principal_id: string;
          credential_id: string;
          client_type: "codex" | "claude";
          injector_hub_session_id: string;
          session_ticket_id: string | null;
          session_project_id: string;
          session_agent_id: string;
          session_lineage_id: string | null;
          session_incarnation: number | null;
          head_session_id: string | null;
          head_incarnation: number;
          connection_state: string;
          ticket_state: string;
          ticket_expires_at: string;
          surface_state: string;
        })
      | undefined;
    if (!row) throw new NotFoundError("Synthetic prompt reservation", reservationId);
    if (
      row.principal_id !== principal.id ||
      row.session_ticket_id !== principal.credentialId ||
      row.client_type !== principal.clientType ||
      row.project_id !== principal.projectId ||
      row.injector_hub_session_id !== input.injector_hub_session_id ||
      row.injector_hub_session_id !== principal.hubSessionId ||
      row.surface_attempt_id !== input.surface_attempt_id ||
      row.recipient_fence !== input.recipient_fence ||
      row.session_project_id !== row.project_id ||
      row.session_agent_id !== principal.clientType ||
      row.session_lineage_id !== principal.lineageId ||
      row.session_incarnation !== principal.incarnation ||
      row.head_session_id !== row.injector_hub_session_id ||
      row.head_incarnation !== row.session_incarnation ||
      row.connection_state === "CLOSED" ||
      row.ticket_state !== "ACTIVE" ||
      row.ticket_expires_at <= nowIso()
    ) {
      throw new ForbiddenError("Synthetic prompt abort does not match the injector surface");
    }
    const abortKeyOwner = ctx.sqlite
      .prepare(
        `SELECT id FROM synthetic_prompt_reservations
          WHERE session_ticket_id = ? AND abort_idempotency_key = ?`,
      )
      .get(principal.credentialId, input.idempotency_key) as { id: string } | undefined;
    if (abortKeyOwner && abortKeyOwner.id !== row.id) {
      throw new ConflictError(
        "Synthetic prompt abort idempotency key belongs to another reservation",
      );
    }
    if (row.state === "ABORTED") {
      if (
        row.abort_idempotency_key !== input.idempotency_key ||
        row.abort_request_sha256 !== requestSha256 ||
        !row.aborted_at ||
        !row.abort_reason
      ) {
        throw new ConflictError("Synthetic prompt reservation was already aborted differently");
      }
      return {
        id: row.id,
        sourceMessageId: row.source_message_id,
        surfaceAttemptId: row.surface_attempt_id,
        recipientFence: row.recipient_fence,
        rpcMethod: row.rpc_method,
        state: "ABORTED",
        abortedAt: row.aborted_at,
        reason: row.abort_reason,
        replayed: true,
      };
    }
    if (row.state !== "PREPARED") {
      throw new ConflictError("Synthetic prompt reservation is no longer abortable");
    }
    if (row.surface_state !== "ACTIVE") {
      throw new ConflictError("Synthetic prompt surface is no longer active");
    }
    const abortedAt = nowIso();
    const updated = ctx.sqlite
      .prepare(
        `UPDATE synthetic_prompt_reservations
         SET state = 'ABORTED', aborted_at = ?, abort_reason = ?,
             abort_idempotency_key = ?, abort_request_sha256 = ?
         WHERE id = ? AND state = 'PREPARED'`,
      )
      .run(abortedAt, input.reason, input.idempotency_key, requestSha256, row.id);
    if (updated.changes !== 1) {
      throw new ConflictError("Synthetic prompt reservation changed concurrently");
    }
    event = ctx.appendEvent({
      projectId: row.project_id,
      type: "synthetic_prompt.aborted",
      actorType: "system",
      actorId: principal.id,
      aggregateType: "synthetic_prompt_reservation",
      aggregateId: row.id,
      causationId: row.surface_attempt_id,
      correlationId: null,
      payload: {
        sourceMessageId: row.source_message_id,
        surfaceAttemptId: row.surface_attempt_id,
        recipientFence: row.recipient_fence,
        rpcMethod: row.rpc_method,
        reason: input.reason,
      },
    });
    return {
      id: row.id,
      sourceMessageId: row.source_message_id,
      surfaceAttemptId: row.surface_attempt_id,
      recipientFence: row.recipient_fence,
      rpcMethod: row.rpc_method,
      state: "ABORTED",
      abortedAt,
      reason: input.reason,
      replayed: false,
    };
  });
  const result = transaction.immediate();
  if (event) ctx.bus.publish(event);
  return result;
}
