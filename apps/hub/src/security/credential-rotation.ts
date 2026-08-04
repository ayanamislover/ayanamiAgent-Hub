import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { RequestPrincipal } from "./local-auth.js";
import { revokeSessionTicketBundle } from "./session-tickets.js";

export const STATIC_CREDENTIAL_SLOTS = [
  "token",
  "agent-codex",
  "agent-claude",
  "dashboard",
  "capture-codex",
  "capture-claude",
  "inject-codex",
  "inject-claude",
] as const;

export type StaticCredentialSlot = (typeof STATIC_CREDENTIAL_SLOTS)[number];

const SLOT_IDENTITY: Record<StaticCredentialSlot, { credentialId: string; principalId: string }> = {
  token: { credentialId: "crd_local_agent", principalId: "prn_local_agent" },
  "agent-codex": { credentialId: "crd_agent_codex", principalId: "prn_agent_codex" },
  "agent-claude": { credentialId: "crd_agent_claude", principalId: "prn_agent_claude" },
  dashboard: { credentialId: "crd_local_dashboard", principalId: "prn_local_dashboard" },
  "capture-codex": {
    credentialId: "crd_capture_codex",
    principalId: "prn_capture_codex",
  },
  "capture-claude": {
    credentialId: "crd_capture_claude",
    principalId: "prn_capture_claude",
  },
  "inject-codex": { credentialId: "crd_inject_codex", principalId: "prn_inject_codex" },
  "inject-claude": {
    credentialId: "crd_inject_claude",
    principalId: "prn_inject_claude",
  },
};

const SHA256 = /^[a-f0-9]{64}$/u;
const OPERATION_ID = /^scr_[A-Za-z0-9_-]+$/u;

export type CredentialRotationPhase =
  | "AUTHORIZED"
  | "PREPARED"
  | "STAGED"
  | "SWITCHING"
  | "FILES_INSTALLED"
  | "DB_COMMITTED"
  | "CLEANUP_PENDING"
  | "COMPLETED"
  | "ABORTED";

const FORWARD_PHASES: readonly CredentialRotationPhase[] = [
  "AUTHORIZED",
  "PREPARED",
  "STAGED",
  "SWITCHING",
  "FILES_INSTALLED",
  "DB_COMMITTED",
  "CLEANUP_PENDING",
  "COMPLETED",
];

export class CredentialRotationError extends Error {
  constructor(
    readonly code:
      | "ROTATION_NOT_AUTHORIZED"
      | "ROTATION_CONFLICT"
      | "ROTATION_INTEGRITY_FAILED"
      | "ROTATION_PHASE_INVALID"
      | "SECURITY_EPOCH_FORK"
      | "CREDENTIAL_REVOKED_BY_SECURITY_EPOCH"
      | "INCIDENT_PROOF_INVALID"
      | "INCIDENT_PROOF_REPLAYED",
    message: string,
  ) {
    super(message);
    this.name = "CredentialRotationError";
  }
}

export interface StaticCredentialMemberInput {
  slot: StaticCredentialSlot;
  tokenSha256: string;
  stagedFileSha256: string;
  scopes: readonly string[];
}

export interface StaticCredentialInstalledMember {
  slot: StaticCredentialSlot;
  generation: number;
  tokenSha256: string;
}

export interface ExternalCredentialSecurityReceipt {
  operationId: string | null;
  securityEpoch: number;
  slots: readonly StaticCredentialInstalledMember[];
  receiptSha256: string | null;
  operation?: {
    projectId: string;
    incidentStartedAt: string;
    stoppedAt: string;
    stopReceiptSha256: string;
    requestSha256: string;
    members: readonly StaticCredentialMemberInput[];
  };
}

export interface CredentialRotationStopReceiptProof {
  operationId: string;
  projectId: string;
  stoppedAt: string;
  receiptSha256: string;
}

export interface CredentialRotationFileAdapter {
  inspect(): Promise<ExternalCredentialSecurityReceipt>;
  /** Installs only missing canonical files from an already durable, owner-private staging area. */
  installForward(operationId: string, missingSlots: readonly StaticCredentialSlot[]): Promise<void>;
  writeReceipt(receipt: ExternalCredentialSecurityReceipt): Promise<void>;
}

type SlotRow = {
  slot: StaticCredentialSlot;
  credential_id: string;
  principal_id: string;
  active_generation_id: string | null;
  active_generation: number;
  security_epoch: number;
  token_sha256: string | null;
  scopes_json: string | null;
  state: string | null;
  operation_id: string | null;
};

type OperationRow = {
  id: string;
  authorization_project_id: string;
  incident_started_at: string;
  cutover_at: string;
  epoch_before: number;
  epoch_after: number;
  stop_receipt_sha256: string;
  request_sha256: string;
};

export type CredentialRotationRequestPrincipal = RequestPrincipal & {
  staticCredentialSlot: "dashboard";
  staticCredentialGeneration: number;
  securityEpoch: number;
};

export type CredentialRotationExternalRecoveryAuthorization = {
  principal: CredentialRotationRequestPrincipal;
  authorizationSource: CredentialRotationAuthorizationSource & { kind: "DASHBOARD_EVENT" };
};

export type CredentialRotationAuthorizationSource =
  | { kind: "USER_TURN"; id: string; projectId: string }
  | { kind: "DASHBOARD_EVENT"; id: string; projectId: string };

type ValidatedRotationAuthorization = {
  kind: "DASHBOARD_USER_TURN" | "SYSTEM_RECOVERY";
  sourceKind: "USER_TURN" | "DASHBOARD_EVENT" | "EXTERNAL_RECEIPT";
  principalId: string;
  sourceId: string;
  projectId: string;
  credentialGenerationId: string | null;
};

type MemberRow = {
  operation_id: string;
  slot: StaticCredentialSlot;
  credential_id: string;
  principal_id: string;
  generation: number;
  token_sha256: string;
  scopes_json: string;
  staged_file_sha256: string;
};

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function fail(
  code: ConstructorParameters<typeof CredentialRotationError>[0],
  message: string,
): never {
  throw new CredentialRotationError(code, message);
}

function canonicalInstant(value: string, field: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    fail("ROTATION_INTEGRITY_FAILED", `${field} must be a canonical UTC instant`);
  }
  return value;
}

function assertSha256(value: string, field: string): void {
  if (!SHA256.test(value)) fail("ROTATION_INTEGRITY_FAILED", `${field} must be SHA-256`);
}

function slots(sqlite: Database.Database): SlotRow[] {
  return sqlite
    .prepare(
      `SELECT slot.slot, slot.credential_id, slot.principal_id, slot.active_generation_id,
              slot.active_generation, slot.security_epoch, generation.token_sha256,
              generation.state, generation.operation_id, generation.scopes_json
       FROM static_credential_slots slot
       LEFT JOIN static_credential_generations generation ON generation.id = slot.active_generation_id
       ORDER BY slot.slot`,
    )
    .all() as SlotRow[];
}

function securityState(sqlite: Database.Database): {
  security_epoch: number;
  active_operation_id: string | null;
} {
  const row = sqlite
    .prepare(
      "SELECT security_epoch, active_operation_id FROM static_credential_security_state WHERE singleton = 1",
    )
    .get() as { security_epoch: number; active_operation_id: string | null } | undefined;
  if (!row) fail("ROTATION_INTEGRITY_FAILED", "static credential security state is missing");
  return row;
}

function assertExactMembers(input: readonly StaticCredentialMemberInput[]): void {
  if (input.length !== STATIC_CREDENTIAL_SLOTS.length) {
    fail("ROTATION_INTEGRITY_FAILED", "a rotation must contain exactly eight credential members");
  }
  const seenSlots = new Set<string>();
  const seenDigests = new Set<string>();
  for (const member of input) {
    if (!(STATIC_CREDENTIAL_SLOTS as readonly string[]).includes(member.slot)) {
      fail("ROTATION_INTEGRITY_FAILED", `unknown static credential slot ${member.slot}`);
    }
    if (seenSlots.has(member.slot)) {
      fail("ROTATION_INTEGRITY_FAILED", `duplicate static credential slot ${member.slot}`);
    }
    assertSha256(member.tokenSha256, `${member.slot}.tokenSha256`);
    assertSha256(member.stagedFileSha256, `${member.slot}.stagedFileSha256`);
    if (seenDigests.has(member.tokenSha256)) {
      fail("ROTATION_INTEGRITY_FAILED", "credential digests must be unique across slots");
    }
    if (member.scopes.some((scope) => typeof scope !== "string" || scope.length === 0)) {
      fail("ROTATION_INTEGRITY_FAILED", `${member.slot}.scopes are invalid`);
    }
    seenSlots.add(member.slot);
    seenDigests.add(member.tokenSha256);
  }
  for (const expected of STATIC_CREDENTIAL_SLOTS) {
    if (!seenSlots.has(expected)) {
      fail("ROTATION_INTEGRITY_FAILED", `missing static credential slot ${expected}`);
    }
  }
}

function appendPhase(
  sqlite: Database.Database,
  operationId: string,
  expected: CredentialRotationPhase | null,
  next: CredentialRotationPhase,
  at: string,
): void {
  const events = sqlite
    .prepare(
      `SELECT sequence, phase FROM static_credential_rotation_events
       WHERE operation_id = ? ORDER BY sequence`,
    )
    .all(operationId) as Array<{ sequence: number; phase: CredentialRotationPhase }>;
  const latest = events.at(-1)?.phase ?? null;
  if (latest !== expected) {
    fail(
      "ROTATION_PHASE_INVALID",
      `rotation ${operationId} expected ${expected ?? "no phase"}, observed ${latest ?? "none"}`,
    );
  }
  const sequence = events.length + 1;
  sqlite
    .prepare(
      `INSERT INTO static_credential_rotation_events(
         operation_id, sequence, phase, event_sha256, created_at
       ) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      operationId,
      sequence,
      next,
      sha256(canonicalJson({ operationId, sequence, phase: next, createdAt: at })),
      at,
    );
}

function latestPhase(sqlite: Database.Database, operationId: string): CredentialRotationPhase {
  const row = sqlite
    .prepare(
      `SELECT phase FROM static_credential_rotation_events
       WHERE operation_id = ? ORDER BY sequence DESC LIMIT 1`,
    )
    .get(operationId) as { phase: CredentialRotationPhase } | undefined;
  if (!row) fail("ROTATION_INTEGRITY_FAILED", `rotation ${operationId} has no journal`);
  return row.phase;
}

function rotationGenerationId(
  operationId: string,
  slot: StaticCredentialSlot,
  generation: number,
): string {
  return `scg_${operationId.slice(4)}_${slot.replaceAll("-", "_")}_${generation}`;
}

function abortStagedCredentialRotation(
  sqlite: Database.Database,
  operationId: string,
  at: string,
): void {
  sqlite
    .transaction(() => {
      if (latestPhase(sqlite, operationId) !== "STAGED") {
        fail("ROTATION_PHASE_INVALID", "only a STAGED rotation may abort");
      }
      const changed = sqlite
        .prepare(
          `UPDATE static_credential_generations
           SET state = 'ABORTED', aborted_at = ?
           WHERE operation_id = ? AND state = 'PREPARED'`,
        )
        .run(at, operationId);
      if (changed.changes !== 8) {
        fail("ROTATION_INTEGRITY_FAILED", "aborted generation set is incomplete");
      }
      appendPhase(sqlite, operationId, "STAGED", "ABORTED", at);
    })
    .immediate();
}

/**
 * Fresh databases migrate before local credential files are registered.  This one-time bootstrap
 * copies only their digests/scopes into generation zero; partial bootstrap is rejected atomically.
 */
export function bootstrapStaticCredentialGenerations(sqlite: Database.Database): void {
  sqlite
    .transaction(() => {
      const current = slots(sqlite);
      if (current.length !== 8)
        fail("ROTATION_INTEGRITY_FAILED", "credential slots are incomplete");
      const initialized = current.filter((row) => row.active_generation_id !== null);
      if (initialized.length === 8) {
        assertCredentialRotationIntegrity(sqlite);
        return;
      }
      if (initialized.length !== 0) {
        fail("ROTATION_INTEGRITY_FAILED", "credential generation bootstrap is partial");
      }
      const now = new Date().toISOString();
      for (const slot of current) {
        const identity = SLOT_IDENTITY[slot.slot];
        if (
          slot.credential_id !== identity.credentialId ||
          slot.principal_id !== identity.principalId
        ) {
          fail("ROTATION_INTEGRITY_FAILED", `credential slot identity mismatch for ${slot.slot}`);
        }
        const credential = sqlite
          .prepare(
            `SELECT principal_id, token_sha256, scopes_json, revoked_at, created_at
           FROM auth_credentials WHERE id = ?`,
          )
          .get(slot.credential_id) as
          | {
              principal_id: string;
              token_sha256: string;
              scopes_json: string;
              revoked_at: string | null;
              created_at: string;
            }
          | undefined;
        if (
          !credential ||
          credential.principal_id !== slot.principal_id ||
          credential.revoked_at !== null
        ) {
          fail("ROTATION_INTEGRITY_FAILED", `legacy credential is missing for ${slot.slot}`);
        }
        const generationId = `scg_${slot.slot.replaceAll("-", "_")}_0`;
        sqlite
          .prepare(
            `INSERT INTO static_credential_generations(
             id, slot, credential_id, principal_id, generation, token_sha256, scopes_json,
             operation_id, state, activated_at, revoked_at, created_at
           ) VALUES (?, ?, ?, ?, 0, ?, ?, NULL, 'ACTIVE', ?, NULL, ?)`,
          )
          .run(
            generationId,
            slot.slot,
            slot.credential_id,
            slot.principal_id,
            credential.token_sha256,
            credential.scopes_json,
            credential.created_at,
            credential.created_at,
          );
        sqlite
          .prepare(
            `UPDATE static_credential_slots SET active_generation_id = ?, updated_at = ?
           WHERE slot = ? AND active_generation_id IS NULL AND active_generation = 0`,
          )
          .run(generationId, now, slot.slot);
      }
      assertCredentialRotationIntegrity(sqlite);
    })
    .immediate();
}

function validateCredentialRotationAuthorization(
  sqlite: Database.Database,
  principal: CredentialRotationRequestPrincipal,
  source: CredentialRotationAuthorizationSource,
  operationId: string,
  projectId: string,
): ValidatedRotationAuthorization {
  const state = securityState(sqlite);
  if (
    principal.kind !== "DASHBOARD_USER" ||
    principal.credentialClass !== "STATIC" ||
    principal.id !== "prn_local_dashboard" ||
    principal.staticCredentialSlot !== "dashboard" ||
    principal.authenticatedVia === "bootstrap" ||
    principal.projectId !== null ||
    principal.securityEpoch !== state.security_epoch
  ) {
    fail(
      "ROTATION_NOT_AUTHORIZED",
      "rotation requires an authenticated Dashboard principal at the current security epoch",
    );
  }
  const active = sqlite
    .prepare(
      `SELECT generation.id, generation.generation, generation.credential_id,
              generation.principal_id, generation.state, slot.security_epoch
       FROM static_credential_slots slot
       JOIN static_credential_generations generation ON generation.id = slot.active_generation_id
       WHERE slot.slot = 'dashboard'`,
    )
    .get() as
    | {
        id: string;
        generation: number;
        credential_id: string;
        principal_id: string;
        state: string;
        security_epoch: number;
      }
    | undefined;
  if (
    !active ||
    active.state !== "ACTIVE" ||
    active.generation !== principal.staticCredentialGeneration ||
    active.credential_id !== principal.credentialId ||
    active.principal_id !== principal.id ||
    active.security_epoch !== principal.securityEpoch
  ) {
    fail("ROTATION_NOT_AUTHORIZED", "Dashboard credential is not the exact active generation");
  }
  if (source.projectId !== projectId) {
    fail("ROTATION_NOT_AUTHORIZED", "rotation source belongs to another project");
  }
  if (source.kind === "USER_TURN") {
    const turn = sqlite
      .prepare(
        `SELECT turn.id FROM user_turns turn
         JOIN user_turn_capture_receipts receipt ON receipt.user_turn_id = turn.id
         WHERE turn.id = ? AND turn.project_id = ? AND receipt.status = 'CAPTURED'`,
      )
      .get(source.id, projectId);
    if (!turn) {
      fail("ROTATION_NOT_AUTHORIZED", "rotation source user turn is missing or unauthenticated");
    }
  } else {
    const event = sqlite
      .prepare(
        `SELECT id FROM events
         WHERE id = ? AND project_id = ? AND type = 'security.credential_rotation.authorized'
           AND actor_type = 'user' AND actor_id = ?
           AND aggregate_type = 'static_credential_rotation' AND aggregate_id = ?`,
      )
      .get(source.id, projectId, principal.displayName, operationId);
    if (!event) {
      fail("ROTATION_NOT_AUTHORIZED", "rotation source Dashboard operation is missing or invalid");
    }
  }
  return {
    kind: "DASHBOARD_USER_TURN",
    sourceKind: source.kind,
    principalId: principal.id,
    sourceId: source.id,
    projectId,
    credentialGenerationId: active.id,
  };
}

export function prepareStaticCredentialRotation(
  sqlite: Database.Database,
  principal: CredentialRotationRequestPrincipal,
  input: {
    operationId: string;
    projectId: string;
    incidentStartedAt: string;
    stopReceipt: CredentialRotationStopReceiptProof;
    authorizationSource: CredentialRotationAuthorizationSource;
    members: readonly StaticCredentialMemberInput[];
    now: string;
  },
): void {
  prepareStaticCredentialRotationInternal(sqlite, {
    ...input,
    authorization: () =>
      validateCredentialRotationAuthorization(
        sqlite,
        principal,
        input.authorizationSource,
        input.operationId,
        input.projectId,
      ),
  });
}

function prepareStaticCredentialRotationInternal(
  sqlite: Database.Database,
  input: {
    operationId: string;
    projectId: string;
    incidentStartedAt: string;
    stopReceipt: CredentialRotationStopReceiptProof;
    authorization: () => ValidatedRotationAuthorization;
    members: readonly StaticCredentialMemberInput[];
    externalRequestSha256?: string;
    now: string;
  },
): void {
  if (!OPERATION_ID.test(input.operationId)) {
    fail("ROTATION_INTEGRITY_FAILED", "rotation operation id is invalid");
  }
  const incidentStartedAt = canonicalInstant(input.incidentStartedAt, "incidentStartedAt");
  const cutoverAt = canonicalInstant(input.stopReceipt.stoppedAt, "stopReceipt.stoppedAt");
  const now = canonicalInstant(input.now, "now");
  assertSha256(input.stopReceipt.receiptSha256, "stopReceipt.receiptSha256");
  if (
    input.stopReceipt.operationId !== input.operationId ||
    input.stopReceipt.projectId !== input.projectId
  ) {
    fail("ROTATION_INTEGRITY_FAILED", "stop receipt does not bind the exact operation and project");
  }
  if (Date.parse(cutoverAt) < Date.parse(incidentStartedAt)) {
    fail("ROTATION_INTEGRITY_FAILED", "cutover precedes the incident window");
  }
  assertExactMembers(input.members);
  sqlite
    .transaction(() => {
      assertCredentialRotationIntegrity(sqlite);
      const state = securityState(sqlite);
      const unfinished = sqlite
        .prepare(
          `SELECT operation.id FROM static_credential_rotation_operations operation
         JOIN static_credential_rotation_events event ON event.operation_id = operation.id
         WHERE event.sequence = (
           SELECT MAX(latest.sequence) FROM static_credential_rotation_events latest
           WHERE latest.operation_id = operation.id
         ) AND event.phase NOT IN ('COMPLETED', 'ABORTED') LIMIT 1`,
        )
        .get() as { id: string } | undefined;
      if (unfinished) fail("ROTATION_CONFLICT", `rotation ${unfinished.id} is unfinished`);

      const authorization = input.authorization();
      if (authorization.projectId !== input.projectId) {
        fail("ROTATION_NOT_AUTHORIZED", "rotation source and project differ");
      }
      const currentSlots = slots(sqlite);
      const canonicalMembers = [...input.members]
        .sort((left, right) => left.slot.localeCompare(right.slot))
        .map((member) => ({
          ...member,
          credentialId: SLOT_IDENTITY[member.slot].credentialId,
          principalId: SLOT_IDENTITY[member.slot].principalId,
        }));
      if (input.externalRequestSha256 !== undefined) {
        assertSha256(input.externalRequestSha256, "externalRequestSha256");
        if (
          authorization.kind !== "DASHBOARD_USER_TURN" ||
          authorization.sourceKind !== "DASHBOARD_EVENT"
        ) {
          fail(
            "ROTATION_NOT_AUTHORIZED",
            "external recovery requires a fresh authenticated Dashboard event",
          );
        }
      }
      const requestSha256 =
        input.externalRequestSha256 ??
        sha256(
          canonicalJson({
            operationId: input.operationId,
            incidentStartedAt,
            cutoverAt,
            stopReceiptSha256: input.stopReceipt.receiptSha256,
            epochBefore: state.security_epoch,
            authorizationProjectId: authorization.projectId,
            authorizationKind: authorization.kind,
            authorizationSourceKind: authorization.sourceKind,
            authorizationSourceId: authorization.sourceId,
            authorizationCredentialGenerationId: authorization.credentialGenerationId,
            members: canonicalMembers,
          }),
        );
      sqlite
        .prepare(
          `INSERT INTO static_credential_rotation_operations(
           id, incident_started_at, cutover_at, epoch_before, epoch_after,
           authorization_project_id, authorization_kind, authorization_source_kind,
           authorized_by_principal_id, authorization_source_id, stop_receipt_sha256,
           request_sha256, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.operationId,
          incidentStartedAt,
          cutoverAt,
          state.security_epoch,
          state.security_epoch + 1,
          authorization.projectId,
          authorization.kind,
          authorization.sourceKind,
          authorization.principalId,
          authorization.sourceId,
          input.stopReceipt.receiptSha256,
          requestSha256,
          now,
        );
      appendPhase(sqlite, input.operationId, null, "AUTHORIZED", now);
      for (const member of canonicalMembers) {
        const current = currentSlots.find((slot) => slot.slot === member.slot);
        if (!current?.active_generation_id || current.state !== "ACTIVE") {
          fail("ROTATION_INTEGRITY_FAILED", `slot ${member.slot} has no active predecessor`);
        }
        const generation = current.active_generation + 1;
        const generationId = rotationGenerationId(input.operationId, member.slot, generation);
        const scopesJson = JSON.stringify([...new Set(member.scopes)].sort());
        if (scopesJson !== current.scopes_json) {
          fail(
            "ROTATION_INTEGRITY_FAILED",
            `rotation cannot change credential scopes for ${member.slot}`,
          );
        }
        sqlite
          .prepare(
            `INSERT INTO static_credential_rotation_members(
             operation_id, slot, credential_id, principal_id, generation, token_sha256,
             scopes_json, staged_file_sha256, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            input.operationId,
            member.slot,
            member.credentialId,
            member.principalId,
            generation,
            member.tokenSha256,
            scopesJson,
            member.stagedFileSha256,
            now,
          );
        sqlite
          .prepare(
            `INSERT INTO static_credential_generations(
             id, slot, credential_id, principal_id, generation, token_sha256, scopes_json,
             operation_id, state, activated_at, revoked_at, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PREPARED', NULL, NULL, ?)`,
          )
          .run(
            generationId,
            member.slot,
            member.credentialId,
            member.principalId,
            generation,
            member.tokenSha256,
            scopesJson,
            input.operationId,
            now,
          );
      }
      appendPhase(sqlite, input.operationId, "AUTHORIZED", "PREPARED", now);
    })
    .immediate();
}

export function markStaticCredentialRotationStaged(
  sqlite: Database.Database,
  operationId: string,
  at: string,
): void {
  sqlite
    .transaction(() => {
      assertCredentialRotationIntegrity(sqlite, { allowPrepared: true });
      appendPhase(sqlite, operationId, "PREPARED", "STAGED", canonicalInstant(at, "at"));
    })
    .immediate();
}

function operation(sqlite: Database.Database, operationId: string): OperationRow {
  const row = sqlite
    .prepare("SELECT * FROM static_credential_rotation_operations WHERE id = ?")
    .get(operationId) as OperationRow | undefined;
  if (!row) fail("ROTATION_INTEGRITY_FAILED", `rotation ${operationId} does not exist`);
  return row;
}

function members(sqlite: Database.Database, operationId: string): MemberRow[] {
  const rows = sqlite
    .prepare(
      "SELECT * FROM static_credential_rotation_members WHERE operation_id = ? ORDER BY slot",
    )
    .all(operationId) as MemberRow[];
  if (rows.length !== 8) fail("ROTATION_INTEGRITY_FAILED", "rotation member set is incomplete");
  return rows;
}

function assertInstalledMembers(
  expected: readonly MemberRow[],
  installed: readonly StaticCredentialInstalledMember[],
): void {
  if (installed.length !== 8) fail("ROTATION_INTEGRITY_FAILED", "installed slot set is incomplete");
  const actual = new Map(installed.map((member) => [member.slot, member]));
  for (const member of expected) {
    const observed = actual.get(member.slot);
    if (
      !observed ||
      observed.generation !== member.generation ||
      observed.tokenSha256 !== member.token_sha256
    ) {
      fail("ROTATION_INTEGRITY_FAILED", `installed credential mismatch for ${member.slot}`);
    }
  }
}

type IncidentBundle = {
  bundleId: string;
  state: "PENDING" | "ACTIVE";
  ids: string[];
};

function incidentBundles(sqlite: Database.Database, op: OperationRow): IncidentBundle[] {
  const candidates = sqlite
    .prepare(
      `SELECT DISTINCT bundle_id
       FROM adapter_session_tickets
       WHERE state IN ('PENDING', 'ACTIVE')
         AND created_at <= ?
         AND (
           (state = 'PENDING' AND offer_expires_at >= ?)
           OR (state = 'ACTIVE' AND expires_at >= ?)
         )
       ORDER BY bundle_id`,
    )
    .all(op.cutover_at, op.incident_started_at, op.incident_started_at) as Array<{
    bundle_id: string;
  }>;
  return candidates.map(({ bundle_id }) => {
    const rows = sqlite
      .prepare(
        `SELECT id, state, purpose, session_client, project_id, adapter_client, agent_id,
                role, transport, delivery_mode, run_id, activation_mode,
                offer_expires_at, expires_at, hub_session_id, lineage_id, incarnation, created_at
         FROM adapter_session_tickets WHERE bundle_id = ? ORDER BY purpose`,
      )
      .all(bundle_id) as Array<
      Record<string, unknown> & { id: string; state: "PENDING" | "ACTIVE" }
    >;
    if (rows.length === 0) fail("ROTATION_INTEGRITY_FAILED", `ticket bundle ${bundle_id} vanished`);
    const first = rows[0]!;
    const requiredPurposes: Record<string, readonly string[]> = {
      "codex-app-server": ["CONTROL", "INJECTOR", "MODEL_MCP"],
      "codex-cli-hooks": ["CAPTURE", "CONTROL"],
      "claude-channel": ["CONTROL"],
      "claude-hooks": ["CAPTURE", "CONTROL"],
    };
    const expectedPurposes = requiredPurposes[String(first.session_client)];
    const purposes = rows.map((row) => String(row.purpose)).sort();
    if (
      !expectedPurposes ||
      canonicalJson(purposes) !== canonicalJson([...expectedPurposes].sort())
    ) {
      fail("ROTATION_INTEGRITY_FAILED", `ticket bundle ${bundle_id} is incomplete`);
    }
    const invariantKeys = [
      "state",
      "session_client",
      "project_id",
      "adapter_client",
      "agent_id",
      "role",
      "transport",
      "delivery_mode",
      "run_id",
      "activation_mode",
      "offer_expires_at",
      "expires_at",
      "hub_session_id",
      "lineage_id",
      "incarnation",
    ];
    if (rows.some((row) => invariantKeys.some((key) => row[key] !== first[key]))) {
      fail("ROTATION_INTEGRITY_FAILED", `ticket bundle ${bundle_id} changed or is incoherent`);
    }
    const everyMemberOverlaps = rows.every(
      (row) =>
        Date.parse(String(row.created_at ?? op.cutover_at)) <= Date.parse(op.cutover_at) &&
        (row.state === "PENDING"
          ? Date.parse(String(row.offer_expires_at)) >= Date.parse(op.incident_started_at)
          : Date.parse(String(row.expires_at)) >= Date.parse(op.incident_started_at)),
    );
    if (!everyMemberOverlaps) {
      fail(
        "ROTATION_INTEGRITY_FAILED",
        `ticket bundle ${bundle_id} only partially overlaps incident`,
      );
    }
    return { bundleId: bundle_id, state: first.state, ids: rows.map((row) => row.id) };
  });
}

type IncidentDependencyKind = "CAPTURE_BINDING" | "SYNTHETIC_PROMPT" | "LAUNCH_RESERVATION";

function appendIncidentDependencyReceipt(
  sqlite: Database.Database,
  input: {
    operationId: string;
    dependencyKind: IncidentDependencyKind;
    dependencyId: string;
    priorState: "ACTIVE" | "PREPARED" | "ISSUED";
    terminalState: "REVOKED" | "ABORTED" | "SUPERSEDED";
    terminalAt: string;
  },
): void {
  sqlite
    .prepare(
      `INSERT INTO static_credential_incident_dependency_receipts(
         operation_id, dependency_kind, dependency_id, prior_state, terminal_state,
         terminal_at, receipt_sha256
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.operationId,
      input.dependencyKind,
      input.dependencyId,
      input.priorState,
      input.terminalState,
      input.terminalAt,
      sha256(canonicalJson(input)),
    );
}

function terminalizeIncidentDependents(
  sqlite: Database.Database,
  op: OperationRow,
  operationId: string,
): void {
  for (const bundle of incidentBundles(sqlite, op)) {
    const changed = revokeSessionTicketBundle(sqlite, {
      bundleId: bundle.bundleId,
      state: "REVOKED",
      reason: `static credential incident rotation ${operationId}`,
      now: op.cutover_at,
    });
    if (changed !== bundle.ids.length) {
      fail("ROTATION_INTEGRITY_FAILED", `ticket bundle ${bundle.bundleId} changed during cutover`);
    }
    const idsHash = sha256(canonicalJson([...bundle.ids].sort()));
    sqlite
      .prepare(
        `INSERT INTO static_credential_incident_ticket_receipts(
           operation_id, bundle_id, prior_state, ticket_count, ticket_ids_sha256,
           terminal_at, receipt_sha256
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        operationId,
        bundle.bundleId,
        bundle.state,
        bundle.ids.length,
        idsHash,
        op.cutover_at,
        sha256(
          canonicalJson({
            operationId,
            bundleId: bundle.bundleId,
            priorState: bundle.state,
            ticketCount: bundle.ids.length,
            ticketIdsSha256: idsHash,
            terminalAt: op.cutover_at,
          }),
        ),
      );
  }

  const captureBindings = sqlite
    .prepare(
      `SELECT id FROM capture_session_bindings
       WHERE revoked_at IS NULL AND created_at <= ? ORDER BY id`,
    )
    .all(op.cutover_at) as Array<{ id: string }>;
  for (const binding of captureBindings) {
    const revoked = sqlite
      .prepare(
        `UPDATE capture_session_bindings SET revoked_at = ?
         WHERE id = ? AND revoked_at IS NULL`,
      )
      .run(op.cutover_at, binding.id);
    if (revoked.changes !== 1) {
      fail("ROTATION_INTEGRITY_FAILED", `capture binding ${binding.id} changed during cutover`);
    }
    appendIncidentDependencyReceipt(sqlite, {
      operationId,
      dependencyKind: "CAPTURE_BINDING",
      dependencyId: binding.id,
      priorState: "ACTIVE",
      terminalState: "REVOKED",
      terminalAt: op.cutover_at,
    });
  }

  const prepared = sqlite
    .prepare(
      `SELECT id FROM synthetic_prompt_reservations
       WHERE state = 'PREPARED' AND prepared_at <= ? ORDER BY id`,
    )
    .all(op.cutover_at) as Array<{ id: string }>;
  for (const reservation of prepared) {
    const key = `security-rotation:${operationId}:${reservation.id}`;
    const aborted = sqlite
      .prepare(
        `UPDATE synthetic_prompt_reservations
         SET state = 'ABORTED', aborted_at = ?, abort_reason = ?, abort_idempotency_key = ?,
             abort_request_sha256 = ?
         WHERE id = ? AND state = 'PREPARED'`,
      )
      .run(
        op.cutover_at,
        `static credential incident rotation ${operationId}`,
        key,
        sha256(canonicalJson({ operationId, reservationId: reservation.id, key })),
        reservation.id,
      );
    if (aborted.changes !== 1) {
      fail(
        "ROTATION_INTEGRITY_FAILED",
        `synthetic prompt reservation ${reservation.id} changed during cutover`,
      );
    }
    appendIncidentDependencyReceipt(sqlite, {
      operationId,
      dependencyKind: "SYNTHETIC_PROMPT",
      dependencyId: reservation.id,
      priorState: "PREPARED",
      terminalState: "ABORTED",
      terminalAt: op.cutover_at,
    });
  }

  const issued = sqlite
    .prepare(
      `SELECT reservation.id, reservation.lineage_id
       FROM session_launch_reservations reservation
       WHERE reservation.state = 'ISSUED'
         AND reservation.created_at <= ?
       ORDER BY reservation.id`,
    )
    .all(op.cutover_at) as Array<{ id: string; lineage_id: string }>;
  for (const reservation of issued) {
    const detached = sqlite
      .prepare(
        `UPDATE session_lineages SET active_reservation_id = NULL, version = version + 1,
           updated_at = ? WHERE id = ? AND active_reservation_id = ?`,
      )
      .run(op.cutover_at, reservation.lineage_id, reservation.id);
    if (detached.changes !== 1) {
      fail(
        "ROTATION_INTEGRITY_FAILED",
        `ISSUED launch reservation ${reservation.id} lost its fence`,
      );
    }
    const superseded = sqlite
      .prepare(
        `UPDATE session_launch_reservations
         SET state = 'SUPERSEDED', updated_at = ?
         WHERE id = ? AND state = 'ISSUED'`,
      )
      .run(op.cutover_at, reservation.id);
    if (superseded.changes !== 1) {
      fail(
        "ROTATION_INTEGRITY_FAILED",
        `launch reservation ${reservation.id} changed during cutover`,
      );
    }
    appendIncidentDependencyReceipt(sqlite, {
      operationId,
      dependencyKind: "LAUNCH_RESERVATION",
      dependencyId: reservation.id,
      priorState: "ISSUED",
      terminalState: "SUPERSEDED",
      terminalAt: op.cutover_at,
    });
  }
}

export function commitStaticCredentialRotation(
  sqlite: Database.Database,
  input: {
    operationId: string;
    installedSecurityEpoch: number;
    installedMembers: readonly StaticCredentialInstalledMember[];
    at: string;
  },
): { securityEpoch: number; revokedTicketBundles: number } {
  const at = canonicalInstant(input.at, "at");
  return sqlite
    .transaction(() => {
      assertCredentialRotationIntegrity(sqlite, { allowPrepared: true });
      if (latestPhase(sqlite, input.operationId) !== "FILES_INSTALLED") {
        fail("ROTATION_PHASE_INVALID", "database commit requires FILES_INSTALLED");
      }
      const op = operation(sqlite, input.operationId);
      const state = securityState(sqlite);
      if (
        state.security_epoch !== op.epoch_before ||
        input.installedSecurityEpoch !== op.epoch_after
      ) {
        fail("SECURITY_EPOCH_FORK", "installed and database security epochs diverged");
      }
      const nextMembers = members(sqlite, input.operationId);
      assertInstalledMembers(nextMembers, input.installedMembers);
      const currentSlots = slots(sqlite);
      for (const member of nextMembers) {
        const current = currentSlots.find((slot) => slot.slot === member.slot)!;
        if (
          current.active_generation + 1 !== member.generation ||
          current.security_epoch !== op.epoch_before
        ) {
          fail("ROTATION_INTEGRITY_FAILED", `slot ${member.slot} changed during rotation`);
        }
      }

      const affectedBundles = incidentBundles(sqlite, op).length;
      terminalizeIncidentDependents(sqlite, op, input.operationId);

      for (const member of nextMembers) {
        const generationId = rotationGenerationId(
          input.operationId,
          member.slot,
          member.generation,
        );
        const activated = sqlite
          .prepare(
            `UPDATE static_credential_generations
           SET state = 'ACTIVE', activated_at = ?
           WHERE id = ? AND state = 'PREPARED' AND operation_id = ?`,
          )
          .run(at, generationId, input.operationId);
        if (activated.changes !== 1) {
          fail("ROTATION_INTEGRITY_FAILED", `next generation for ${member.slot} changed`);
        }
        const switched = sqlite
          .prepare(
            `UPDATE static_credential_slots
           SET active_generation_id = ?, active_generation = ?, security_epoch = ?, updated_at = ?
           WHERE slot = ? AND active_generation = ? AND security_epoch = ?`,
          )
          .run(
            generationId,
            member.generation,
            op.epoch_after,
            at,
            member.slot,
            member.generation - 1,
            op.epoch_before,
          );
        if (switched.changes !== 1) {
          fail("ROTATION_INTEGRITY_FAILED", `active slot ${member.slot} changed`);
        }
      }
      for (const current of currentSlots) {
        const revoked = sqlite
          .prepare(
            `UPDATE static_credential_generations SET state = 'REVOKED', revoked_at = ?
           WHERE id = ? AND state = 'ACTIVE'`,
          )
          .run(at, current.active_generation_id);
        if (revoked.changes !== 1) {
          fail("ROTATION_INTEGRITY_FAILED", `predecessor generation for ${current.slot} changed`);
        }
      }
      sqlite
        .prepare(
          `UPDATE auth_credentials SET revoked_at = ?
         WHERE id IN (
           'crd_local_agent', 'crd_agent_codex', 'crd_agent_claude', 'crd_local_dashboard',
           'crd_capture_codex', 'crd_capture_claude', 'crd_inject_codex', 'crd_inject_claude'
         ) AND revoked_at IS NULL`,
        )
        .run(at);
      const epoch = sqlite
        .prepare(
          `UPDATE static_credential_security_state
         SET security_epoch = ?, active_operation_id = ?, updated_at = ?
         WHERE singleton = 1 AND security_epoch = ?`,
        )
        .run(op.epoch_after, input.operationId, at, op.epoch_before);
      if (epoch.changes !== 1) fail("SECURITY_EPOCH_FORK", "security epoch changed during commit");
      appendPhase(sqlite, input.operationId, "FILES_INSTALLED", "DB_COMMITTED", at);
      assertCredentialRotationIntegrity(sqlite);
      return { securityEpoch: op.epoch_after, revokedTicketBundles: affectedBundles };
    })
    .immediate();
}

export function markStaticCredentialRotationSwitching(
  sqlite: Database.Database,
  operationId: string,
  at: string,
): void {
  sqlite
    .transaction(() =>
      appendPhase(sqlite, operationId, "STAGED", "SWITCHING", canonicalInstant(at, "at")),
    )
    .immediate();
}

export function markStaticCredentialFilesInstalled(
  sqlite: Database.Database,
  operationId: string,
  installed: readonly StaticCredentialInstalledMember[],
  at: string,
): void {
  sqlite
    .transaction(() => {
      assertInstalledMembers(members(sqlite, operationId), installed);
      appendPhase(sqlite, operationId, "SWITCHING", "FILES_INSTALLED", canonicalInstant(at, "at"));
    })
    .immediate();
}

export function queryStaticCredentialAdmission(
  sqlite: Database.Database,
  input: { slot: StaticCredentialSlot; tokenSha256: string; observedSecurityEpoch?: number },
):
  | { valid: true; securityEpoch: number; generation: number; principalId: string }
  | { valid: false; code: "CREDENTIAL_REVOKED_BY_SECURITY_EPOCH"; securityEpoch: number } {
  assertSha256(input.tokenSha256, "tokenSha256");
  assertCredentialRotationIntegrity(sqlite);
  const state = securityState(sqlite);
  const row = slots(sqlite).find((candidate) => candidate.slot === input.slot)!;
  if (
    input.observedSecurityEpoch !== undefined &&
    input.observedSecurityEpoch !== state.security_epoch
  ) {
    return {
      valid: false,
      code: "CREDENTIAL_REVOKED_BY_SECURITY_EPOCH",
      securityEpoch: state.security_epoch,
    };
  }
  if (row.state !== "ACTIVE" || row.token_sha256 !== input.tokenSha256) {
    return {
      valid: false,
      code: "CREDENTIAL_REVOKED_BY_SECURITY_EPOCH",
      securityEpoch: state.security_epoch,
    };
  }
  return {
    valid: true,
    securityEpoch: state.security_epoch,
    generation: row.active_generation,
    principalId: row.principal_id,
  };
}

/**
 * One-shot recovery proof for reconnecting the exact current head after an incident cutover.  It
 * grants no general enrollment authority: the caller must present the new active Agent generation,
 * and the predecessor bundle must have an immutable revocation receipt from this same operation.
 */
export function consumeIncidentCurrentHeadProof(
  sqlite: Database.Database,
  input: {
    operationId: string;
    projectId: string;
    adapterClient: "codex" | "claude";
    lineageId: string;
    headSessionId: string;
    predecessorBundleId: string;
    credentialGeneration: number;
    presentedTokenSha256: string;
    now: string;
  },
): { securityEpoch: number; generation: number; headSessionId: string } {
  const now = canonicalInstant(input.now, "now");
  assertSha256(input.presentedTokenSha256, "presentedTokenSha256");
  return sqlite
    .transaction(() => {
      assertCredentialRotationIntegrity(sqlite);
      const admission = queryStaticCredentialAdmission(sqlite, {
        slot: `agent-${input.adapterClient}`,
        tokenSha256: input.presentedTokenSha256,
      });
      if (
        !admission.valid ||
        admission.generation !== input.credentialGeneration ||
        input.credentialGeneration <= 0
      ) {
        fail("INCIDENT_PROOF_INVALID", "incident proof did not use the exact new Agent generation");
      }
      const op = operation(sqlite, input.operationId);
      if (op.epoch_after !== admission.securityEpoch) {
        fail("INCIDENT_PROOF_INVALID", "incident proof operation is not the active security epoch");
      }
      const head = sqlite
        .prepare(
          `SELECT session.id
         FROM session_lineages lineage
         JOIN agent_sessions session ON session.id = lineage.head_session_id
         WHERE lineage.id = ? AND lineage.project_id = ? AND lineage.agent_id = ?
           AND lineage.client LIKE ? AND session.id = ?
           AND session.project_id = lineage.project_id AND session.lineage_id = lineage.id
           AND session.incarnation = lineage.head_incarnation
           AND session.connection_state <> 'CLOSED'`,
        )
        .get(
          input.lineageId,
          input.projectId,
          input.adapterClient,
          `${input.adapterClient}-%`,
          input.headSessionId,
        ) as { id: string } | undefined;
      const predecessor = sqlite
        .prepare(
          `SELECT receipt.bundle_id
         FROM static_credential_incident_ticket_receipts receipt
         WHERE receipt.operation_id = ? AND receipt.bundle_id = ?
           AND receipt.terminal_at = ?
           AND NOT EXISTS (
             SELECT 1 FROM adapter_session_tickets ticket
             WHERE ticket.bundle_id = receipt.bundle_id
               AND (ticket.state <> 'REVOKED' OR ticket.project_id <> ?
                 OR ticket.adapter_client <> ? OR ticket.lineage_id IS NOT ?)
           )`,
        )
        .get(
          input.operationId,
          input.predecessorBundleId,
          op.cutover_at,
          input.projectId,
          input.adapterClient,
          input.lineageId,
        ) as { bundle_id: string } | undefined;
      if (!head || !predecessor) {
        fail(
          "INCIDENT_PROOF_INVALID",
          "incident proof is not bound to the exact current head and revoked predecessor",
        );
      }
      const proofSha256 = sha256(
        canonicalJson({
          operationId: input.operationId,
          projectId: input.projectId,
          adapterClient: input.adapterClient,
          lineageId: input.lineageId,
          headSessionId: input.headSessionId,
          predecessorBundleId: input.predecessorBundleId,
          credentialGeneration: input.credentialGeneration,
          consumedAt: now,
        }),
      );
      try {
        sqlite
          .prepare(
            `INSERT INTO static_credential_incident_head_proofs(
             operation_id, project_id, adapter_client, lineage_id, head_session_id,
             predecessor_bundle_id, credential_generation, consumed_at, proof_sha256
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            input.operationId,
            input.projectId,
            input.adapterClient,
            input.lineageId,
            input.headSessionId,
            input.predecessorBundleId,
            input.credentialGeneration,
            now,
            proofSha256,
          );
      } catch (error) {
        if (String(error).includes("UNIQUE constraint failed")) {
          fail("INCIDENT_PROOF_REPLAYED", "incident current-head proof was already consumed");
        }
        throw error;
      }
      return {
        securityEpoch: admission.securityEpoch,
        generation: admission.generation,
        headSessionId: input.headSessionId,
      };
    })
    .immediate();
}

export function assertCredentialRotationIntegrity(
  sqlite: Database.Database,
  options: { allowPrepared?: boolean; externalSecurityEpoch?: number } = {},
): void {
  const state = securityState(sqlite);
  if (
    options.externalSecurityEpoch !== undefined &&
    options.externalSecurityEpoch < state.security_epoch
  ) {
    fail("SECURITY_EPOCH_FORK", "external security epoch is behind the database");
  }
  const current = slots(sqlite);
  if (current.length !== 8)
    fail("ROTATION_INTEGRITY_FAILED", "static credential slots are missing");
  for (const expected of STATIC_CREDENTIAL_SLOTS) {
    const row = current.find((slot) => slot.slot === expected);
    const identity = SLOT_IDENTITY[expected];
    if (
      !row ||
      row.credential_id !== identity.credentialId ||
      row.principal_id !== identity.principalId ||
      !row.active_generation_id ||
      row.state !== "ACTIVE" ||
      row.security_epoch !== state.security_epoch
    ) {
      fail("ROTATION_INTEGRITY_FAILED", `active static credential slot ${expected} is invalid`);
    }
  }
  if (state.security_epoch > 0) {
    const activeOperations = new Set(current.map((row) => row.operation_id));
    if (
      activeOperations.size !== 1 ||
      !activeOperations.has(state.active_operation_id) ||
      !state.active_operation_id
    ) {
      fail("ROTATION_INTEGRITY_FAILED", "active slots do not share one rotation operation");
    }
    const phase = latestPhase(sqlite, state.active_operation_id);
    if (!["DB_COMMITTED", "CLEANUP_PENDING", "COMPLETED"].includes(phase)) {
      fail("ROTATION_INTEGRITY_FAILED", "active rotation has no committed journal phase");
    }
  }

  const operations = sqlite
    .prepare(
      `SELECT id, epoch_before, epoch_after
       FROM static_credential_rotation_operations ORDER BY epoch_before, id`,
    )
    .all() as Array<{ id: string; epoch_before: number; epoch_after: number }>;
  const committedByEpoch = new Map<number, string>();
  let unfinishedAtCurrentEpoch = 0;
  for (const op of operations) {
    const events = sqlite
      .prepare(
        `SELECT sequence, phase, event_sha256, created_at
         FROM static_credential_rotation_events
         WHERE operation_id = ? ORDER BY sequence`,
      )
      .all(op.id) as Array<{
      sequence: number;
      phase: CredentialRotationPhase;
      event_sha256: string;
      created_at: string;
    }>;
    if (events.length === 0 || events.some((event, index) => event.sequence !== index + 1)) {
      fail("ROTATION_INTEGRITY_FAILED", `rotation ${op.id} journal sequence is corrupt`);
    }
    if (
      events.some(
        (event) =>
          event.event_sha256 !==
          sha256(
            canonicalJson({
              operationId: op.id,
              sequence: event.sequence,
              phase: event.phase,
              createdAt: event.created_at,
            }),
          ),
      )
    ) {
      fail("ROTATION_INTEGRITY_FAILED", `rotation ${op.id} journal hash is corrupt`);
    }
    const phases = events.map((event) => event.phase);
    const validForward = phases.every((phase, index) => phase === FORWARD_PHASES[index]);
    const validAbort =
      phases.length === 4 &&
      phases[0] === "AUTHORIZED" &&
      phases[1] === "PREPARED" &&
      phases[2] === "STAGED" &&
      phases[3] === "ABORTED";
    if (!validForward && !validAbort) {
      fail("ROTATION_INTEGRITY_FAILED", `rotation ${op.id} journal phase chain is corrupt`);
    }
    if (op.epoch_after !== op.epoch_before + 1 || op.epoch_before > state.security_epoch) {
      fail("ROTATION_INTEGRITY_FAILED", `rotation ${op.id} security epoch chain is corrupt`);
    }
    if (phases.includes("DB_COMMITTED")) {
      if (op.epoch_before >= state.security_epoch || committedByEpoch.has(op.epoch_before)) {
        fail("ROTATION_INTEGRITY_FAILED", `rotation ${op.id} security epoch fork is corrupt`);
      }
      committedByEpoch.set(op.epoch_before, op.id);
    } else if (!validAbort) {
      if (op.epoch_before !== state.security_epoch || ++unfinishedAtCurrentEpoch > 1) {
        fail("ROTATION_INTEGRITY_FAILED", `rotation ${op.id} unfinished epoch is corrupt`);
      }
    }
    const count = Number(
      sqlite
        .prepare("SELECT COUNT(*) FROM static_credential_rotation_members WHERE operation_id = ?")
        .pluck()
        .get(op.id),
    );
    if (count !== 8 && !(options.allowPrepared && phases.length === 1)) {
      fail("ROTATION_INTEGRITY_FAILED", `rotation ${op.id} member set is incomplete`);
    }
    if (validAbort) {
      const abortedCount = Number(
        sqlite
          .prepare(
            `SELECT COUNT(*) FROM static_credential_generations
             WHERE operation_id = ? AND state = 'ABORTED' AND aborted_at IS NOT NULL`,
          )
          .pluck()
          .get(op.id),
      );
      if (abortedCount !== 8) {
        fail("ROTATION_INTEGRITY_FAILED", `rotation ${op.id} aborted generation set is corrupt`);
      }
    }
  }
  for (let epoch = 0; epoch < state.security_epoch; epoch += 1) {
    if (!committedByEpoch.has(epoch)) {
      fail("ROTATION_INTEGRITY_FAILED", `security epoch ${epoch} has no committed rotation`);
    }
  }
  const ticketReceipts = sqlite
    .prepare(
      `SELECT receipt.operation_id, receipt.bundle_id, receipt.prior_state,
              receipt.ticket_count, receipt.ticket_ids_sha256, receipt.terminal_at,
              receipt.receipt_sha256, operation.cutover_at
       FROM static_credential_incident_ticket_receipts receipt
       JOIN static_credential_rotation_operations operation ON operation.id = receipt.operation_id`,
    )
    .all() as Array<{
    operation_id: string;
    bundle_id: string;
    prior_state: string;
    ticket_count: number;
    ticket_ids_sha256: string;
    terminal_at: string;
    receipt_sha256: string;
    cutover_at: string;
  }>;
  for (const receipt of ticketReceipts) {
    const expected = sha256(
      canonicalJson({
        operationId: receipt.operation_id,
        bundleId: receipt.bundle_id,
        priorState: receipt.prior_state,
        ticketCount: receipt.ticket_count,
        ticketIdsSha256: receipt.ticket_ids_sha256,
        terminalAt: receipt.terminal_at,
      }),
    );
    if (receipt.terminal_at !== receipt.cutover_at || receipt.receipt_sha256 !== expected) {
      fail("ROTATION_INTEGRITY_FAILED", "incident ticket receipt is corrupt");
    }
  }
  const dependencyReceipts = sqlite
    .prepare(
      `SELECT receipt.operation_id, receipt.dependency_kind, receipt.dependency_id,
              receipt.prior_state, receipt.terminal_state, receipt.terminal_at,
              receipt.receipt_sha256, operation.cutover_at
       FROM static_credential_incident_dependency_receipts receipt
       JOIN static_credential_rotation_operations operation ON operation.id = receipt.operation_id`,
    )
    .all() as Array<{
    operation_id: string;
    dependency_kind: IncidentDependencyKind;
    dependency_id: string;
    prior_state: "ACTIVE" | "PREPARED" | "ISSUED";
    terminal_state: "REVOKED" | "ABORTED" | "SUPERSEDED";
    terminal_at: string;
    receipt_sha256: string;
    cutover_at: string;
  }>;
  for (const receipt of dependencyReceipts) {
    const expected = sha256(
      canonicalJson({
        operationId: receipt.operation_id,
        dependencyKind: receipt.dependency_kind,
        dependencyId: receipt.dependency_id,
        priorState: receipt.prior_state,
        terminalState: receipt.terminal_state,
        terminalAt: receipt.terminal_at,
      }),
    );
    if (receipt.terminal_at !== receipt.cutover_at || receipt.receipt_sha256 !== expected) {
      fail("ROTATION_INTEGRITY_FAILED", "incident dependency receipt is corrupt");
    }
  }
  const externalReceipts = sqlite
    .prepare(
      `SELECT operation_id, security_epoch, receipt_sha256
       FROM static_credential_external_receipts`,
    )
    .all() as Array<{
    operation_id: string;
    security_epoch: number;
    receipt_sha256: string;
  }>;
  for (const recorded of externalReceipts) {
    const op = operation(sqlite, recorded.operation_id);
    const operationMembers = members(sqlite, recorded.operation_id);
    const reconstructed: ExternalCredentialSecurityReceipt = {
      operationId: recorded.operation_id,
      securityEpoch: recorded.security_epoch,
      slots: operationMembers.map((member) => ({
        slot: member.slot,
        generation: member.generation,
        tokenSha256: member.token_sha256,
      })),
      receiptSha256: null,
      operation: {
        projectId: op.authorization_project_id,
        incidentStartedAt: op.incident_started_at,
        stoppedAt: op.cutover_at,
        stopReceiptSha256: op.stop_receipt_sha256,
        requestSha256: op.request_sha256,
        members: operationMembers.map((member) => ({
          slot: member.slot,
          tokenSha256: member.token_sha256,
          stagedFileSha256: member.staged_file_sha256,
          scopes: JSON.parse(member.scopes_json) as string[],
        })),
      },
    };
    if (
      recorded.security_epoch !== op.epoch_after ||
      recorded.receipt_sha256 !== externalReceiptSha256(reconstructed)
    ) {
      fail("ROTATION_INTEGRITY_FAILED", "external receipt journal is corrupt");
    }
  }
}

export async function reconcileStaticCredentialRotation(
  sqlite: Database.Database,
  adapter: CredentialRotationFileAdapter,
  operationId: string,
  now: string,
  externalRecoveryAuthorization?: CredentialRotationExternalRecoveryAuthorization,
): Promise<"ABORTED" | "COMPLETED"> {
  const at = canonicalInstant(now, "now");
  const external = await adapter.inspect();
  assertCredentialRotationIntegrity(sqlite, {
    allowPrepared: true,
    externalSecurityEpoch: external.securityEpoch,
  });
  const state = securityState(sqlite);
  if (external.securityEpoch > state.security_epoch) {
    if (!externalRecoveryAuthorization) {
      fail(
        "ROTATION_NOT_AUTHORIZED",
        "external credential recovery requires a fresh authenticated Dashboard action",
      );
    }
    return recoverExternalStaticCredentialRotation(
      sqlite,
      adapter,
      external,
      at,
      externalRecoveryAuthorization,
    );
  }
  const phase = latestPhase(sqlite, operationId);
  if (["DB_COMMITTED", "CLEANUP_PENDING", "COMPLETED"].includes(phase)) {
    return finishCredentialRotationCleanup(sqlite, adapter, operationId, at);
  }
  const next = members(sqlite, operationId);
  const current = slots(sqlite);
  const observed = new Map(external.slots.map((slot) => [slot.slot, slot]));
  const newSlots = next.filter((member) => {
    const found = observed.get(member.slot);
    return found?.generation === member.generation && found.tokenSha256 === member.token_sha256;
  });
  const oldSlots = current.filter((member) => {
    const found = observed.get(member.slot);
    return (
      found?.generation === member.active_generation && found.tokenSha256 === member.token_sha256
    );
  });
  if (newSlots.length === 0 && oldSlots.length === 8 && phase === "STAGED") {
    abortStagedCredentialRotation(sqlite, operationId, at);
    return "ABORTED";
  }
  if (newSlots.length + oldSlots.length !== 8 || (newSlots.length === 0 && phase !== "SWITCHING")) {
    fail("ROTATION_INTEGRITY_FAILED", "canonical credential files contain an unknown generation");
  }
  if (phase === "STAGED") markStaticCredentialRotationSwitching(sqlite, operationId, at);
  if (newSlots.length !== 8) {
    await adapter.installForward(
      operationId,
      next.filter((member) => !newSlots.includes(member)).map((member) => member.slot),
    );
  }
  const installed = await adapter.inspect();
  assertInstalledMembers(next, installed.slots);
  if (latestPhase(sqlite, operationId) === "SWITCHING") {
    markStaticCredentialFilesInstalled(sqlite, operationId, installed.slots, at);
  }
  if (latestPhase(sqlite, operationId) === "FILES_INSTALLED") {
    commitStaticCredentialRotation(sqlite, {
      operationId,
      installedSecurityEpoch: operation(sqlite, operationId).epoch_after,
      installedMembers: installed.slots,
      at,
    });
  }
  return finishCredentialRotationCleanup(sqlite, adapter, operationId, at);
}

async function finishCredentialRotationCleanup(
  sqlite: Database.Database,
  adapter: CredentialRotationFileAdapter,
  operationId: string,
  at: string,
): Promise<"COMPLETED"> {
  let phase = latestPhase(sqlite, operationId);
  if (phase === "DB_COMMITTED") {
    sqlite
      .transaction(() => appendPhase(sqlite, operationId, "DB_COMMITTED", "CLEANUP_PENDING", at))
      .immediate();
    phase = "CLEANUP_PENDING";
  }
  if (phase !== "CLEANUP_PENDING" && phase !== "COMPLETED") {
    fail("ROTATION_PHASE_INVALID", `cleanup cannot continue from ${phase}`);
  }
  const op = operation(sqlite, operationId);
  const operationMembers = members(sqlite, operationId);
  const receipt: ExternalCredentialSecurityReceipt = {
    operationId,
    securityEpoch: op.epoch_after,
    slots: operationMembers.map((member) => ({
      slot: member.slot,
      generation: member.generation,
      tokenSha256: member.token_sha256,
    })),
    receiptSha256: null,
    operation: {
      projectId: op.authorization_project_id,
      incidentStartedAt: op.incident_started_at,
      stoppedAt: op.cutover_at,
      stopReceiptSha256: op.stop_receipt_sha256,
      requestSha256: op.request_sha256,
      members: operationMembers.map((member) => ({
        slot: member.slot,
        tokenSha256: member.token_sha256,
        stagedFileSha256: member.staged_file_sha256,
        scopes: JSON.parse(member.scopes_json) as string[],
      })),
    },
  };
  const receiptSha256 = externalReceiptSha256(receipt);
  const recorded = sqlite
    .prepare("SELECT 1 FROM static_credential_external_receipts WHERE operation_id = ?")
    .get(operationId);
  if (!recorded) {
    await adapter.writeReceipt({ ...receipt, receiptSha256 });
  }
  const durableReceipt = await adapter.inspect();
  if (
    durableReceipt.operationId !== operationId ||
    durableReceipt.securityEpoch !== op.epoch_after ||
    durableReceipt.receiptSha256 !== receiptSha256 ||
    externalReceiptSha256(durableReceipt) !== receiptSha256
  ) {
    fail("ROTATION_INTEGRITY_FAILED", "external security receipt was not durably observed");
  }
  assertInstalledMembers(operationMembers, durableReceipt.slots);
  if (!recorded) {
    sqlite
      .transaction(() => {
        sqlite
          .prepare(
            `INSERT INTO static_credential_external_receipts(
             operation_id, security_epoch, receipt_sha256, recorded_at
           ) VALUES (?, ?, ?, ?)`,
          )
          .run(operationId, op.epoch_after, receiptSha256, at);
        appendPhase(sqlite, operationId, "CLEANUP_PENDING", "COMPLETED", at);
      })
      .immediate();
  } else if (phase !== "COMPLETED") {
    sqlite
      .transaction(() => appendPhase(sqlite, operationId, "CLEANUP_PENDING", "COMPLETED", at))
      .immediate();
  }
  return "COMPLETED";
}

async function recoverExternalStaticCredentialRotation(
  sqlite: Database.Database,
  adapter: CredentialRotationFileAdapter,
  external: ExternalCredentialSecurityReceipt,
  at: string,
  recoveryAuthorization: CredentialRotationExternalRecoveryAuthorization,
): Promise<"COMPLETED"> {
  if (!external.operationId || !external.operation || !external.receiptSha256) {
    fail("SECURITY_EPOCH_FORK", "newer external epoch lacks a complete forward recovery receipt");
  }
  const completeExternal = {
    ...external,
    operationId: external.operationId,
    operation: external.operation,
    receiptSha256: external.receiptSha256,
  };
  if (externalReceiptSha256(external) !== external.receiptSha256) {
    fail("ROTATION_INTEGRITY_FAILED", "external security receipt hash is invalid");
  }
  const state = securityState(sqlite);
  if (external.securityEpoch !== state.security_epoch + 1) {
    fail("SECURITY_EPOCH_FORK", "external security epoch skipped a generation");
  }
  const validatedRecoveryAuthorization = validateCredentialRotationAuthorization(
    sqlite,
    recoveryAuthorization.principal,
    recoveryAuthorization.authorizationSource,
    external.operationId,
    external.operation.projectId,
  );
  if (validatedRecoveryAuthorization.sourceKind !== "DASHBOARD_EVENT") {
    fail("ROTATION_NOT_AUTHORIZED", "external recovery requires a Dashboard event");
  }
  const existing = sqlite
    .prepare("SELECT id FROM static_credential_rotation_operations WHERE id = ?")
    .get(external.operationId);
  if (!existing) {
    prepareStaticCredentialRotationInternal(sqlite, {
      operationId: external.operationId,
      projectId: external.operation.projectId,
      incidentStartedAt: external.operation.incidentStartedAt,
      stopReceipt: {
        operationId: external.operationId,
        projectId: external.operation.projectId,
        stoppedAt: external.operation.stoppedAt,
        receiptSha256: external.operation.stopReceiptSha256,
      },
      authorization: () => validatedRecoveryAuthorization,
      members: external.operation.members,
      externalRequestSha256: external.operation.requestSha256,
      now: at,
    });
  }
  assertExternalRecoveryOperationMatches(sqlite, completeExternal);
  let phase = latestPhase(sqlite, external.operationId);
  if (phase === "PREPARED") {
    markStaticCredentialRotationStaged(sqlite, external.operationId, at);
    phase = "STAGED";
  }
  if (phase === "STAGED") {
    markStaticCredentialRotationSwitching(sqlite, external.operationId, at);
    phase = "SWITCHING";
  }
  if (phase === "SWITCHING") {
    markStaticCredentialFilesInstalled(sqlite, external.operationId, external.slots, at);
    phase = "FILES_INSTALLED";
  }
  if (phase === "FILES_INSTALLED") {
    commitStaticCredentialRotation(sqlite, {
      operationId: external.operationId,
      installedSecurityEpoch: external.securityEpoch,
      installedMembers: external.slots,
      at,
    });
    phase = "DB_COMMITTED";
  }
  if (!["DB_COMMITTED", "CLEANUP_PENDING", "COMPLETED"].includes(phase)) {
    fail("ROTATION_PHASE_INVALID", `external recovery cannot continue from ${phase}`);
  }
  await finishCredentialRotationCleanup(sqlite, adapter, external.operationId, at);
  return "COMPLETED";
}

function assertExternalRecoveryOperationMatches(
  sqlite: Database.Database,
  external: ExternalCredentialSecurityReceipt & {
    operationId: string;
    receiptSha256: string;
    operation: NonNullable<ExternalCredentialSecurityReceipt["operation"]>;
  },
): void {
  assertExactMembers(external.operation.members);
  assertSha256(external.operation.requestSha256, "external operation requestSha256");
  const op = operation(sqlite, external.operationId);
  if (
    op.authorization_project_id !== external.operation.projectId ||
    op.incident_started_at !== external.operation.incidentStartedAt ||
    op.cutover_at !== external.operation.stoppedAt ||
    op.stop_receipt_sha256 !== external.operation.stopReceiptSha256 ||
    op.request_sha256 !== external.operation.requestSha256 ||
    op.epoch_after !== external.securityEpoch
  ) {
    fail("ROTATION_INTEGRITY_FAILED", "external operation provenance differs from the database");
  }
  const externalMembers = new Map(
    external.operation.members.map((member) => [member.slot, member]),
  );
  const externalSlots = new Map(external.slots.map((slot) => [slot.slot, slot]));
  for (const member of members(sqlite, external.operationId)) {
    const described = externalMembers.get(member.slot);
    const installedMember = externalSlots.get(member.slot);
    if (
      !described ||
      !installedMember ||
      described.tokenSha256 !== member.token_sha256 ||
      described.stagedFileSha256 !== member.staged_file_sha256 ||
      JSON.stringify([...new Set(described.scopes)].sort()) !== member.scopes_json ||
      installedMember.generation !== member.generation ||
      installedMember.tokenSha256 !== member.token_sha256
    ) {
      fail("ROTATION_INTEGRITY_FAILED", `external operation member ${member.slot} differs`);
    }
  }
}

function externalReceiptSha256(receipt: ExternalCredentialSecurityReceipt): string {
  return sha256(
    canonicalJson({
      operationId: receipt.operationId,
      securityEpoch: receipt.securityEpoch,
      slots: [...receipt.slots].sort((left, right) => left.slot.localeCompare(right.slot)),
      operation: receipt.operation
        ? {
            ...receipt.operation,
            members: [...receipt.operation.members].sort((left, right) =>
              left.slot.localeCompare(right.slot),
            ),
          }
        : null,
    }),
  );
}
