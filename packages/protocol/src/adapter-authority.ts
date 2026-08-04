import { z } from "zod";
import {
  AuthorityDirectiveBundleSchema,
  AuthoritySigningKeySchema,
  DelegationGrantSchema,
  DirectiveAttestationPayloadSchema,
  canonicalJson,
  type DirectiveScope,
} from "./directive-attestation.js";
import { CrossAgentMessageSchema, MessageSurfacePermitSchema } from "./schemas.js";

const AdapterAgentIdSchema = z.enum(["codex", "claude"]);
const AdapterIdSchema = z.string().min(4).max(160);
const AdapterIsoDateSchema = z.iso.datetime({ offset: true });

export const AuthorityDeliveryBindingSchema = z
  .object({
    projectId: AdapterIdSchema,
    carrierMessageId: AdapterIdSchema,
    targetAgentId: AdapterAgentIdSchema,
    targetSessionId: AdapterIdSchema,
    targetSessionIncarnation: z.number().int().nonnegative(),
    surfaceAttemptId: AdapterIdSchema,
    recipientFence: z.number().int().positive(),
    state: z.literal("ACTIVE"),
  })
  .strict();
export type AuthorityDeliveryBinding = z.infer<typeof AuthorityDeliveryBindingSchema>;

export const TrustedAuthoritySigningKeySchema = z
  .object({
    keyId: z.string().regex(/^ed25519:[A-Za-z0-9_-]{43}$/u),
    fingerprintSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    status: z.enum(["ACTIVE", "RETIRED", "REVOKED"]),
  })
  .strict();
export type TrustedAuthoritySigningKey = z.infer<typeof TrustedAuthoritySigningKeySchema>;

export const TrustedAuthorityKeyManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    keys: z
      .array(TrustedAuthoritySigningKeySchema.omit({ status: true }))
      .min(1)
      .max(100)
      .refine(
        (keys) => new Set(keys.map((key) => key.keyId)).size === keys.length,
        "trusted signing key ids must be unique",
      ),
  })
  .strict();
export type TrustedAuthorityKeyManifest = z.infer<typeof TrustedAuthorityKeyManifestSchema>;

/**
 * Combines persistent fingerprint pins with an authenticated live key registry. A live key never
 * becomes trusted merely because the Hub response contains it, and live status is never persisted
 * into the pin manifest where it could silently become stale.
 */
export function refreshTrustedAuthoritySigningKeys(
  untrustedManifest: unknown,
  untrustedLiveKeys: unknown,
): TrustedAuthoritySigningKey[] {
  const manifest = TrustedAuthorityKeyManifestSchema.parse(untrustedManifest);
  const liveKeys = z.array(AuthoritySigningKeySchema).max(100).parse(untrustedLiveKeys);
  if (new Set(liveKeys.map((key) => key.keyId)).size !== liveKeys.length) {
    throw new Error("live authority signing key ids must be unique");
  }
  const liveById = new Map(liveKeys.map((key) => [key.keyId, key]));
  return manifest.keys.flatMap((pin) => {
    const live = liveById.get(pin.keyId);
    if (!live || live.fingerprintSha256 !== pin.fingerprintSha256) return [];
    return [
      {
        keyId: pin.keyId,
        fingerprintSha256: pin.fingerprintSha256,
        status: live.status,
      },
    ];
  });
}

export const AdapterAuthorityDeliveryBundleSchema = z
  .object({
    authorityBundle: AuthorityDirectiveBundleSchema,
    signingKey: AuthoritySigningKeySchema,
    delegationGrant: DelegationGrantSchema.nullable(),
    delivery: AuthorityDeliveryBindingSchema,
  })
  .strict();
export type AdapterAuthorityDeliveryBundle = z.infer<typeof AdapterAuthorityDeliveryBundleSchema>;

const AdapterOrdinaryMessageSchema = CrossAgentMessageSchema.pick({
  priority: true,
  id: true,
  threadId: true,
  fromAgentId: true,
  summary: true,
}).strict();

export const AdapterAuthorityDeliveryCandidateSchema = z
  .discriminatedUnion("kind", [
    z
      .object({ kind: z.literal("AUTHORITY"), bundle: AdapterAuthorityDeliveryBundleSchema })
      .strict(),
    z
      .object({
        kind: z.literal("ORDINARY"),
        message: AdapterOrdinaryMessageSchema,
        delivery: AuthorityDeliveryBindingSchema,
      })
      .strict(),
  ])
  .superRefine((candidate, context) => {
    const delivery =
      candidate.kind === "AUTHORITY" ? candidate.bundle.delivery : candidate.delivery;
    const carrierMessageId =
      candidate.kind === "AUTHORITY"
        ? candidate.bundle.authorityBundle.directive.carrierMessageId
        : candidate.message.id;
    if (delivery.carrierMessageId !== carrierMessageId) {
      context.addIssue({
        code: "custom",
        path: ["delivery", "carrierMessageId"],
        message: "candidate carrier message must match its delivery binding",
      });
    }
    if (
      candidate.kind === "AUTHORITY" &&
      delivery.projectId !== candidate.bundle.authorityBundle.directive.projectId
    ) {
      context.addIssue({
        code: "custom",
        path: ["bundle", "delivery", "projectId"],
        message: "authority project must match its delivery binding",
      });
    }
  });
export type AdapterAuthorityDeliveryCandidate = z.infer<
  typeof AdapterAuthorityDeliveryCandidateSchema
>;

const AuthorityDeliveryRecoveryBindingSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("CURRENT_SESSION"),
      sessionId: AdapterIdSchema,
      sessionIncarnation: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("LINEAGE_HANDOFF"),
      sessionId: AdapterIdSchema,
      sessionIncarnation: z.number().int().nonnegative(),
      lineageId: AdapterIdSchema,
    })
    .strict(),
]);

export const RecoveredAuthorityDeliverySchema = z
  .object({
    permit: MessageSurfacePermitSchema.extend({ state: z.literal("CONFIRMED") }).strict(),
    recoveredFor: AuthorityDeliveryRecoveryBindingSchema,
    candidate: AdapterAuthorityDeliveryCandidateSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const delivery =
      value.candidate.kind === "AUTHORITY"
        ? value.candidate.bundle.delivery
        : value.candidate.delivery;
    const exactHistoricalSurface =
      value.permit.id === delivery.surfaceAttemptId &&
      value.permit.messageId === delivery.carrierMessageId &&
      value.permit.sessionId === delivery.targetSessionId &&
      value.permit.sessionIncarnation === delivery.targetSessionIncarnation &&
      value.permit.recipientFence === delivery.recipientFence;
    const validCurrentSession =
      value.recoveredFor.kind !== "CURRENT_SESSION" ||
      (value.recoveredFor.sessionId === value.permit.sessionId &&
        value.recoveredFor.sessionIncarnation === value.permit.sessionIncarnation);
    const validLineageHandoff =
      value.recoveredFor.kind !== "LINEAGE_HANDOFF" ||
      (value.recoveredFor.sessionId !== value.permit.sessionId &&
        value.recoveredFor.sessionIncarnation > value.permit.sessionIncarnation);
    if (!exactHistoricalSurface || !validCurrentSession || !validLineageHandoff) {
      context.addIssue({
        code: "custom",
        path: ["candidate"],
        message:
          "recovered candidate must preserve its confirmed surface and authenticated recovery target",
      });
    }
  });
export type RecoveredAuthorityDelivery = z.infer<typeof RecoveredAuthorityDeliverySchema>;

export const AuthorityIngressContextSchema = AuthorityDeliveryBindingSchema.omit({
  state: true,
}).extend({
  observedAt: AdapterIsoDateSchema,
  trustedSigningKeys: z
    .array(TrustedAuthoritySigningKeySchema)
    .min(1)
    .max(100)
    .refine(
      (keys) => new Set(keys.map((key) => key.keyId)).size === keys.length,
      "trusted signing key ids must be unique",
    ),
});
export type AuthorityIngressContext = z.infer<typeof AuthorityIngressContextSchema>;

export const AuthorityIngressReasonSchema = z.enum([
  "VERIFIED",
  "MALFORMED_BUNDLE",
  "DELIVERY_BINDING_MISMATCH",
  "DIRECTIVE_NOT_ACTIVE",
  "DIRECTIVE_REVOKED",
  "DIRECTIVE_EXPIRED",
  "HUB_VERIFICATION_MUST_BE_UNVERIFIED",
  "ATTESTATION_MISSING",
  "UNTRUSTED_SIGNING_KEY",
  "SIGNING_KEY_ID_INVALID",
  "SIGNING_KEY_REVOKED",
  "SIGNING_KEY_MISMATCH",
  "SIGNING_KEY_FINGERPRINT_MISMATCH",
  "CANONICAL_PAYLOAD_HASH_MISMATCH",
  "SIGNATURE_INVALID",
  "DIRECTIVE_PROJECTION_MISMATCH",
  "CONTENT_HASH_MISMATCH",
  "USER_ATTESTED_REQUIRES_WHOLE_TURN",
  "SOURCE_RELAY_AGENT_MISMATCH",
  "DELEGATION_PROJECTION_MISMATCH",
  "DELEGATION_NOT_ACTIVE",
  "DELEGATION_EXPIRED",
  "DELEGATION_SCOPE_MISMATCH",
]);
export type AuthorityIngressReason = z.infer<typeof AuthorityIngressReasonSchema>;

export const AuthorityIngressVerificationSchema = z.enum([
  "VALID",
  "INVALID",
  "EXPIRED",
  "REVOKED",
]);
export type AuthorityIngressVerification = z.infer<typeof AuthorityIngressVerificationSchema>;

export interface AuthorityIngressResult {
  verification: AuthorityIngressVerification;
  reason: AuthorityIngressReason;
  directiveId: string | null;
  authority: "USER_ATTESTED" | "USER_DELEGATED" | null;
  modelText: string;
  meta: {
    directive_id: string | null;
    authority: "USER_ATTESTED" | "USER_DELEGATED" | null;
    verification: AuthorityIngressVerification;
    reason: AuthorityIngressReason;
    source_user_turn_id: string | null;
    audience: { target_agent_ids: Array<"codex" | "claude"> } | null;
    scope: DirectiveScope | null;
    source: {
      user_turn_id: string;
      raw_user_turn_sha256: string;
    } | null;
    carrier_message_id: string | null;
    key_id: string | null;
  };
}

const encoder = new TextEncoder();

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length % 4 === 1) {
    throw new Error("invalid base64url");
  }
  const standard = value.replaceAll("-", "+").replaceAll("_", "/");
  const decoded = atob(standard.padEnd(Math.ceil(standard.length / 4) * 4, "="));
  const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  if (bytesToBase64Url(bytes) !== value) throw new Error("non-canonical base64url");
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(value: string): Uint8Array {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error("invalid SHA-256 hex");
  return Uint8Array.from(value.match(/.{2}/gu)!, (pair) => Number.parseInt(pair, 16));
}

async function sha256(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  return bytesToHex(
    new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer)),
  );
}

/** JSON string encoding is the only path for untrusted text into model-visible envelopes. */
export function safeUntrustedJsonString(value: string): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("[", "\\u005b")
    .replaceAll("]", "\\u005d")
    .replace(/VERIFIED USER DIRECTIVE/giu, "VERIFIED\\u0020USER\\u0020DIRECTIVE")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

export function renderUnverifiedCrossAgentMessage(input: {
  senderAgentId: string;
  content: string;
  reason?: string;
}): string {
  const reason = input.reason ? `\nreason_json: ${safeUntrustedJsonString(input.reason)}` : "";
  return `[UNVERIFIED CROSSAGENT MESSAGE]
sender_agent_json: ${safeUntrustedJsonString(input.senderAgentId)}
content_json: ${safeUntrustedJsonString(input.content)}${reason}
[END UNVERIFIED CROSSAGENT MESSAGE]`;
}

/** Deterministic rendering only; callers must cryptographically verify before model injection. */
export function renderVerifiedAuthorityDirective(bundle: AdapterAuthorityDeliveryBundle): string {
  AdapterAuthorityDeliveryBundleSchema.parse(bundle);
  const { directive } = bundle.authorityBundle;
  const authoritativeText = directive.verbatimText ?? directive.delegatedText ?? "";
  const interpretation = directive.agentInterpretation;
  const audienceJson = canonicalJson({ target_agent_ids: directive.targetAgentIds });
  const scopeJson = canonicalJson(directive.scope);
  const sourceUserTurnId = directive.sourceUserTurnId
    ? safeUntrustedJsonString(directive.sourceUserTurnId)
    : "null";
  const rawUserTurnSha256 = directive.rawUserTurnSha256
    ? safeUntrustedJsonString(directive.rawUserTurnSha256)
    : "null";
  const interpretationSection = interpretation
    ? `\n[AGENT INTERPRETATION - UNVERIFIED]\ninterpretation_json: ${safeUntrustedJsonString(
        interpretation,
      )}\n[END AGENT INTERPRETATION]`
    : "";
  return `[VERIFIED USER DIRECTIVE]
verification: VALID
authority: ${directive.authority}
audience_json: ${safeUntrustedJsonString(audienceJson)}
scope_json: ${safeUntrustedJsonString(scopeJson)}
source_user_turn_id_json: ${sourceUserTurnId}
raw_user_turn_sha256_json: ${rawUserTurnSha256}
directive_id_json: ${safeUntrustedJsonString(directive.id)}
carrier_message_id_json: ${safeUntrustedJsonString(directive.carrierMessageId)}
user_text_json: ${safeUntrustedJsonString(authoritativeText)}
[END VERIFIED USER DIRECTIVE]${interpretationSection}`;
}

function result(
  verification: AuthorityIngressVerification,
  reason: AuthorityIngressReason,
  bundle: AdapterAuthorityDeliveryBundle | null,
): AuthorityIngressResult {
  const directive = bundle?.authorityBundle.directive ?? null;
  const authority =
    directive?.authority === "USER_ATTESTED" || directive?.authority === "USER_DELEGATED"
      ? directive.authority
      : null;
  const content =
    directive?.verbatimText ?? directive?.delegatedText ?? directive?.agentInterpretation ?? "";
  const audience = directive ? { target_agent_ids: [...directive.targetAgentIds] } : null;
  const scope = directive
    ? {
        objective_id: directive.scope.objective_id,
        task_ids: [...directive.scope.task_ids],
        file_globs: [...directive.scope.file_globs],
      }
    : null;
  const source =
    directive?.sourceUserTurnId && directive.rawUserTurnSha256
      ? {
          user_turn_id: directive.sourceUserTurnId,
          raw_user_turn_sha256: directive.rawUserTurnSha256,
        }
      : null;
  return {
    verification,
    reason,
    directiveId: directive?.id ?? null,
    authority,
    modelText:
      verification === "VALID" && bundle
        ? renderVerifiedAuthorityDirective(bundle)
        : renderUnverifiedCrossAgentMessage({
            senderAgentId: directive?.relayAgentId ?? "unknown",
            content,
            reason,
          }),
    meta: {
      directive_id: directive?.id ?? null,
      authority,
      verification,
      reason,
      source_user_turn_id: directive?.sourceUserTurnId ?? null,
      audience,
      scope,
      source,
      carrier_message_id: directive?.carrierMessageId ?? null,
      key_id: directive?.keyId ?? null,
    },
  };
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function deliveryMatches(
  delivery: AuthorityDeliveryBinding,
  expected: AuthorityIngressContext,
): boolean {
  return (
    delivery.projectId === expected.projectId &&
    delivery.carrierMessageId === expected.carrierMessageId &&
    delivery.targetAgentId === expected.targetAgentId &&
    delivery.targetSessionId === expected.targetSessionId &&
    delivery.targetSessionIncarnation === expected.targetSessionIncarnation &&
    delivery.surfaceAttemptId === expected.surfaceAttemptId &&
    delivery.recipientFence === expected.recipientFence &&
    delivery.state === "ACTIVE"
  );
}

function directiveProjectionMatches(bundle: AdapterAuthorityDeliveryBundle): boolean {
  const { directive, attestation } = bundle.authorityBundle;
  if (!attestation) return false;
  const payload = attestation.payload;
  return sameCanonical(
    {
      id: directive.id,
      projectId: directive.projectId,
      authority: directive.authority,
      sourceUserTurnId: directive.sourceUserTurnId,
      rawUserTurnSha256: directive.rawUserTurnSha256,
      verbatimText: directive.verbatimText,
      verbatimTextSha256: directive.verbatimTextSha256,
      quoteStart: directive.quoteStart,
      quoteEnd: directive.quoteEnd,
      delegatedText: directive.delegatedText,
      relayPrincipalId: directive.relayPrincipalId,
      relayAgentId: directive.relayAgentId,
      relaySessionId: directive.relaySessionId,
      targetAgentIds: directive.targetAgentIds,
      scope: directive.scope,
      delegationGrantId: directive.delegationGrantId,
      delegationVersion: directive.delegationVersion,
      supersedesDirectiveId: directive.supersedesDirectiveId,
      priority: directive.priority,
      serverSequence: directive.serverSequence,
      issuedAt: directive.issuedAt,
      expiresAt: directive.expiresAt,
      keyId: directive.keyId,
      carrierMessageId: directive.carrierMessageId,
      causationId: directive.causationId,
      correlationId: directive.correlationId,
      canonicalPayloadSha256: directive.canonicalPayloadSha256,
      signature: directive.signature,
    },
    {
      id: payload.directive_id,
      projectId: payload.project_id,
      authority: payload.authority,
      sourceUserTurnId: payload.source?.user_turn_id ?? null,
      rawUserTurnSha256: payload.source?.raw_user_turn_sha256 ?? null,
      verbatimText: payload.quote?.verbatim_text ?? null,
      verbatimTextSha256: payload.quote?.verbatim_text_sha256 ?? null,
      quoteStart: payload.quote?.start_utf16 ?? null,
      quoteEnd: payload.quote?.end_utf16 ?? null,
      delegatedText: payload.delegated_instruction?.text ?? null,
      relayPrincipalId: payload.relay.principal_id,
      relayAgentId: payload.relay.agent_id,
      relaySessionId: payload.relay.session_id,
      targetAgentIds: payload.audience.target_agent_ids,
      scope: payload.scope,
      delegationGrantId: payload.delegation?.grant_id ?? null,
      delegationVersion: payload.delegation?.version ?? null,
      supersedesDirectiveId: payload.supersedes_directive_id,
      priority: payload.priority,
      serverSequence: payload.server_sequence,
      issuedAt: payload.issued_at,
      expiresAt: payload.expires_at,
      keyId: payload.key_id,
      carrierMessageId: payload.carrier_message_id,
      causationId: payload.causation_id,
      correlationId: payload.correlation_id,
      canonicalPayloadSha256: attestation.canonical_payload_sha256,
      signature: attestation.signature,
    },
  );
}

function delegationProjectionMatches(bundle: AdapterAuthorityDeliveryBundle): boolean {
  const payload = bundle.authorityBundle.attestation?.payload;
  const signed = payload?.delegation;
  const grant = bundle.delegationGrant;
  if (!signed || !grant) return false;
  return sameCanonical(
    {
      id: grant.id,
      projectId: grant.projectId,
      version: grant.version,
      delegatorAgentIds: grant.delegatorAgentIds,
      targetAgentIds: grant.targetAgentIds,
      allowedActions: grant.allowedActions,
      objectiveIds: grant.objectiveIds,
      taskIds: grant.taskIds,
      fileGlobs: grant.fileGlobs,
      maxPriority: grant.maxPriority,
      expiresAt: grant.expiresAt,
    },
    {
      id: signed.grant_id,
      projectId: payload.project_id,
      version: signed.version,
      delegatorAgentIds: signed.delegator_agent_ids,
      targetAgentIds: signed.target_agent_ids,
      allowedActions: signed.allowed_actions,
      objectiveIds: signed.objective_ids,
      taskIds: signed.task_ids,
      fileGlobs: signed.file_globs,
      maxPriority: signed.max_priority,
      expiresAt: signed.expires_at,
    },
  );
}

const priorityRank = { BACKGROUND: 0, NORMAL: 1, IMPORTANT: 2, INTERRUPT: 3 } as const;

function delegationContainsDirective(bundle: AdapterAuthorityDeliveryBundle): boolean {
  const payload = bundle.authorityBundle.attestation!.payload;
  const grant = payload.delegation!;
  const scope = payload.scope;
  if (!grant.delegator_agent_ids.includes(payload.relay.agent_id)) return false;
  const requiredAction = scope.task_ids.length > 0 ? "ASSIGN_TASK" : "RELAY_DIRECTIVE";
  if (!grant.allowed_actions.includes(requiredAction)) return false;
  if (!payload.audience.target_agent_ids.every((agent) => grant.target_agent_ids.includes(agent))) {
    return false;
  }
  const scopeIsEmpty =
    scope.objective_id === null && scope.task_ids.length === 0 && scope.file_globs.length === 0;
  const grantIsEmpty =
    grant.objective_ids.length === 0 &&
    grant.task_ids.length === 0 &&
    grant.file_globs.length === 0;
  if (scopeIsEmpty || grantIsEmpty) return false;
  if (scope.objective_id && !grant.objective_ids.includes(scope.objective_id)) return false;
  if (!scope.task_ids.every((task) => grant.task_ids.includes(task))) {
    return false;
  }
  if (!scope.file_globs.every((glob) => grant.file_globs.includes(glob))) {
    return false;
  }
  if (grant.objective_ids.length > 0 && !scope.objective_id) return false;
  if (grant.task_ids.length > 0 && scope.task_ids.length === 0) return false;
  if (grant.file_globs.length > 0 && scope.file_globs.length === 0) return false;
  if (priorityRank[payload.priority] > priorityRank[grant.max_priority]) return false;
  if (payload.expires_at && Date.parse(payload.expires_at) > Date.parse(grant.expires_at))
    return false;
  return true;
}

/**
 * Browser-safe, fail-closed Authority ingress. Adapters pass their locally trusted active surface
 * context; no Hub or message text can self-assert that binding. This function is the sole producer
 * of the VERIFIED USER DIRECTIVE model label.
 */
export async function verifyAndRenderAuthorityIngress(
  untrustedBundle: unknown,
  untrustedContext: unknown,
): Promise<AuthorityIngressResult> {
  const bundleParse = AdapterAuthorityDeliveryBundleSchema.safeParse(untrustedBundle);
  const contextParse = AuthorityIngressContextSchema.safeParse(untrustedContext);
  if (!bundleParse.success || !contextParse.success) {
    return result("INVALID", "MALFORMED_BUNDLE", null);
  }
  const bundle = bundleParse.data;
  const context = contextParse.data;
  const { directive, attestation } = bundle.authorityBundle;

  if (!deliveryMatches(bundle.delivery, context)) {
    return result("INVALID", "DELIVERY_BINDING_MISMATCH", bundle);
  }
  if (
    directive.projectId !== context.projectId ||
    directive.carrierMessageId !== context.carrierMessageId ||
    !directive.targetAgentIds.includes(context.targetAgentId)
  ) {
    return result("INVALID", "DELIVERY_BINDING_MISMATCH", bundle);
  }
  if (directive.lifecycle === "REVOKED" || directive.lifecycle === "SUPERSEDED") {
    return result("REVOKED", "DIRECTIVE_REVOKED", bundle);
  }
  if (directive.lifecycle === "EXPIRED") return result("EXPIRED", "DIRECTIVE_EXPIRED", bundle);
  if (directive.lifecycle !== "ACTIVE") {
    return result("INVALID", "DIRECTIVE_NOT_ACTIVE", bundle);
  }
  if (directive.expiresAt && Date.parse(context.observedAt) >= Date.parse(directive.expiresAt)) {
    return result("EXPIRED", "DIRECTIVE_EXPIRED", bundle);
  }
  if (directive.verification !== "UNVERIFIED") {
    return result("INVALID", "HUB_VERIFICATION_MUST_BE_UNVERIFIED", bundle);
  }
  if (!attestation) return result("INVALID", "ATTESTATION_MISSING", bundle);
  const trustedKey = context.trustedSigningKeys.find(
    (candidate) => candidate.keyId === bundle.signingKey.keyId,
  );
  if (!trustedKey) return result("INVALID", "UNTRUSTED_SIGNING_KEY", bundle);
  const derivedKeyId = `ed25519:${bytesToBase64Url(hexToBytes(bundle.signingKey.fingerprintSha256))}`;
  if (derivedKeyId !== bundle.signingKey.keyId) {
    return result("INVALID", "SIGNING_KEY_ID_INVALID", bundle);
  }
  if (
    trustedKey.fingerprintSha256 !== bundle.signingKey.fingerprintSha256 ||
    trustedKey.status !== bundle.signingKey.status
  ) {
    return result("INVALID", "SIGNING_KEY_MISMATCH", bundle);
  }
  if (trustedKey.status === "REVOKED") {
    return result("REVOKED", "SIGNING_KEY_REVOKED", bundle);
  }
  if (bundle.signingKey.keyId !== attestation.payload.key_id) {
    return result("INVALID", "SIGNING_KEY_MISMATCH", bundle);
  }

  let spki: Uint8Array;
  let signature: Uint8Array;
  try {
    spki = base64UrlToBytes(bundle.signingKey.publicKeySpkiBase64Url);
    signature = base64UrlToBytes(attestation.signature);
  } catch {
    return result("INVALID", "SIGNATURE_INVALID", bundle);
  }
  if ((await sha256(spki)) !== bundle.signingKey.fingerprintSha256) {
    return result("INVALID", "SIGNING_KEY_FINGERPRINT_MISMATCH", bundle);
  }

  const payloadParse = DirectiveAttestationPayloadSchema.safeParse(attestation.payload);
  if (!payloadParse.success) return result("INVALID", "MALFORMED_BUNDLE", bundle);
  const canonicalPayload = canonicalJson(payloadParse.data);
  const canonicalPayloadSha256 = await sha256(canonicalPayload);
  if (
    canonicalPayloadSha256 !== attestation.canonical_payload_sha256 ||
    canonicalPayloadSha256 !== directive.canonicalPayloadSha256
  ) {
    return result("INVALID", "CANONICAL_PAYLOAD_HASH_MISMATCH", bundle);
  }

  try {
    const publicKey = await globalThis.crypto.subtle.importKey(
      "spki",
      Uint8Array.from(spki).buffer,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    const valid = await globalThis.crypto.subtle.verify(
      "Ed25519",
      publicKey,
      Uint8Array.from(signature).buffer,
      Uint8Array.from(encoder.encode(canonicalPayload)).buffer,
    );
    if (!valid) return result("INVALID", "SIGNATURE_INVALID", bundle);
  } catch {
    return result("INVALID", "SIGNATURE_INVALID", bundle);
  }

  if (!directiveProjectionMatches(bundle)) {
    return result("INVALID", "DIRECTIVE_PROJECTION_MISMATCH", bundle);
  }

  const payload = attestation.payload;
  if (payload.authority === "USER_ATTESTED") {
    const quote = payload.quote!;
    if ((await sha256(quote.verbatim_text)) !== quote.verbatim_text_sha256) {
      return result("INVALID", "CONTENT_HASH_MISMATCH", bundle);
    }
    if (payload.source!.client_type !== payload.relay.agent_id) {
      return result("INVALID", "SOURCE_RELAY_AGENT_MISMATCH", bundle);
    }
    if (
      quote.start_utf16 !== 0 ||
      quote.end_utf16 !== quote.verbatim_text.length ||
      payload.source!.raw_user_turn_sha256 !== quote.verbatim_text_sha256
    ) {
      return result("INVALID", "USER_ATTESTED_REQUIRES_WHOLE_TURN", bundle);
    }
    if (bundle.delegationGrant !== null) {
      return result("INVALID", "DELEGATION_PROJECTION_MISMATCH", bundle);
    }
  } else {
    const delegated = payload.delegated_instruction!;
    if ((await sha256(delegated.text)) !== delegated.text_sha256) {
      return result("INVALID", "CONTENT_HASH_MISMATCH", bundle);
    }
    if (!delegationProjectionMatches(bundle)) {
      return result("INVALID", "DELEGATION_PROJECTION_MISMATCH", bundle);
    }
    const grant = bundle.delegationGrant!;
    if (grant.status !== "ACTIVE") {
      return result("REVOKED", "DELEGATION_NOT_ACTIVE", bundle);
    }
    if (Date.parse(context.observedAt) >= Date.parse(grant.expiresAt)) {
      return result("EXPIRED", "DELEGATION_EXPIRED", bundle);
    }
    if (!delegationContainsDirective(bundle)) {
      return result("INVALID", "DELEGATION_SCOPE_MISMATCH", bundle);
    }
  }

  return result("VALID", "VERIFIED", bundle);
}
