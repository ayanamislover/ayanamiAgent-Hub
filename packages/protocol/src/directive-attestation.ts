import { z } from "zod";
import {
  AuthorityTypeSchema,
  DirectiveLifecycleSchema,
  DirectiveVerificationSchema,
  UserTurnClientTypeSchema,
} from "./authority.js";

const AuthorityIdSchema = z.string().min(4).max(160);
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const Base64UrlSchema = z.string().regex(/^[A-Za-z0-9_-]+$/);
const IsoDateSchema = z.iso.datetime({ offset: true });
const AgentIdSchema = z.enum(["codex", "claude"]);

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return true;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

const ExactStringSchema = z
  .string()
  .refine((value) => !hasUnpairedSurrogate(value), "value contains an unpaired surrogate");

function sortedUnique(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || values[index - 1]! < value);
}

const CanonicalAgentSetSchema = z
  .array(AgentIdSchema)
  .min(1)
  .refine(sortedUnique, "agent ids must be sorted and unique");
const CanonicalIdSetSchema = z
  .array(AuthorityIdSchema)
  .refine(sortedUnique, "ids must be sorted and unique");
const CanonicalGlobSetSchema = z
  .array(ExactStringSchema.min(1).max(1024))
  .refine(sortedUnique, "file globs must be sorted and unique");

export const DirectivePrioritySchema = z.enum(["BACKGROUND", "NORMAL", "IMPORTANT", "INTERRUPT"]);
export type DirectivePriority = z.infer<typeof DirectivePrioritySchema>;

export const DelegationActionSchema = z.enum(["ASSIGN_TASK", "RELAY_DIRECTIVE"]);
export type DelegationAction = z.infer<typeof DelegationActionSchema>;

export const DirectiveScopeSchema = z
  .object({
    objective_id: AuthorityIdSchema.nullable(),
    task_ids: CanonicalIdSetSchema,
    file_globs: CanonicalGlobSetSchema,
  })
  .strict();
export type DirectiveScope = z.infer<typeof DirectiveScopeSchema>;

export const DirectiveAttestationPayloadSchema = z
  .object({
    type: z.literal("crossagent.user-directive-attestation.v2"),
    schema_version: z.literal(2),
    directive_id: AuthorityIdSchema,
    project_id: AuthorityIdSchema,
    carrier_message_id: AuthorityIdSchema,
    authority: z.enum(["USER_ATTESTED", "USER_DELEGATED"]),
    source: z
      .object({
        user_turn_id: AuthorityIdSchema,
        client_type: UserTurnClientTypeSchema,
        session_id: ExactStringSchema.min(1).max(512),
        turn_id: ExactStringSchema.min(1).max(512).nullable(),
        raw_user_turn_sha256: Sha256Schema,
      })
      .strict()
      .nullable(),
    quote: z
      .object({
        start_utf16: z.number().int().nonnegative(),
        end_utf16: z.number().int().positive(),
        verbatim_text: ExactStringSchema.min(1).max(64 * 1024),
        verbatim_text_sha256: Sha256Schema,
      })
      .strict()
      .nullable(),
    delegated_instruction: z
      .object({
        text: ExactStringSchema.min(1).max(64 * 1024),
        text_sha256: Sha256Schema,
      })
      .strict()
      .nullable(),
    relay: z
      .object({
        principal_id: AuthorityIdSchema,
        agent_id: AgentIdSchema,
        session_id: AuthorityIdSchema.nullable(),
      })
      .strict(),
    audience: z.object({ target_agent_ids: CanonicalAgentSetSchema }).strict(),
    scope: DirectiveScopeSchema,
    delegation: z
      .object({
        grant_id: AuthorityIdSchema,
        version: z.number().int().positive(),
        delegator_agent_ids: CanonicalAgentSetSchema,
        target_agent_ids: CanonicalAgentSetSchema,
        allowed_actions: z
          .array(DelegationActionSchema)
          .min(1)
          .refine(sortedUnique, "delegation actions must be sorted and unique"),
        objective_ids: CanonicalIdSetSchema,
        task_ids: CanonicalIdSetSchema,
        file_globs: CanonicalGlobSetSchema,
        max_priority: DirectivePrioritySchema,
        expires_at: IsoDateSchema,
      })
      .strict()
      .nullable(),
    supersedes_directive_id: AuthorityIdSchema.nullable(),
    priority: DirectivePrioritySchema,
    server_sequence: z.number().int().positive(),
    issued_at: IsoDateSchema,
    expires_at: IsoDateSchema.nullable(),
    key_id: ExactStringSchema.min(16).max(200),
    causation_id: AuthorityIdSchema.nullable(),
    correlation_id: AuthorityIdSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.quote && value.quote.start_utf16 >= value.quote.end_utf16) {
      context.addIssue({
        code: "custom",
        path: ["quote", "end_utf16"],
        message: "quote end must be greater than quote start",
      });
    }
    if (value.authority === "USER_ATTESTED") {
      if (value.delegation !== null || value.delegated_instruction !== null) {
        context.addIssue({
          code: "custom",
          path: ["delegation"],
          message: "USER_ATTESTED cannot reference delegated authority",
        });
      }
      if (value.source === null || value.quote === null) {
        context.addIssue({
          code: "custom",
          path: ["source"],
          message: "USER_ATTESTED requires an exact source user turn quote",
        });
      }
    }
    if (
      value.authority === "USER_DELEGATED" &&
      (value.delegation === null || value.delegated_instruction === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["delegation"],
        message: "USER_DELEGATED requires a delegation grant and signed agent instruction",
      });
    }
    if (value.authority === "USER_DELEGATED" && (value.source !== null || value.quote !== null)) {
      context.addIssue({
        code: "custom",
        path: ["source"],
        message: "USER_DELEGATED cannot inherit a user-turn quote outside its delegation grant",
      });
    }
  });
export type DirectiveAttestationPayload = z.infer<typeof DirectiveAttestationPayloadSchema>;

export const DirectiveAttestationSchema = z
  .object({
    payload: DirectiveAttestationPayloadSchema,
    canonical_payload_sha256: Sha256Schema,
    signature: Base64UrlSchema,
  })
  .strict();
export type DirectiveAttestation = z.infer<typeof DirectiveAttestationSchema>;

export const AuthorityDirectiveSchema = z
  .object({
    id: AuthorityIdSchema,
    projectId: AuthorityIdSchema,
    authority: AuthorityTypeSchema,
    lifecycle: DirectiveLifecycleSchema,
    verification: DirectiveVerificationSchema,
    sourceUserTurnId: AuthorityIdSchema.nullable(),
    rawUserTurnSha256: Sha256Schema.nullable(),
    verbatimText: ExactStringSchema.nullable(),
    verbatimTextSha256: Sha256Schema.nullable(),
    quoteStart: z.number().int().nonnegative().nullable(),
    quoteEnd: z.number().int().positive().nullable(),
    delegatedText: ExactStringSchema.nullable(),
    agentInterpretation: ExactStringSchema.nullable(),
    relayPrincipalId: AuthorityIdSchema,
    relayAgentId: AgentIdSchema,
    relaySessionId: AuthorityIdSchema.nullable(),
    targetAgentIds: z.array(AgentIdSchema).min(1),
    scope: DirectiveScopeSchema,
    priority: DirectivePrioritySchema,
    delegationGrantId: AuthorityIdSchema.nullable(),
    delegationVersion: z.number().int().positive().nullable(),
    attemptedDelegationGrantId: AuthorityIdSchema.nullable(),
    attemptedDelegationVersion: z.number().int().positive().nullable(),
    supersedesDirectiveId: AuthorityIdSchema.nullable(),
    serverSequence: z.number().int().positive(),
    issuedAt: IsoDateSchema,
    expiresAt: IsoDateSchema.nullable(),
    keyId: ExactStringSchema.nullable(),
    canonicalPayloadSha256: Sha256Schema.nullable(),
    signature: Base64UrlSchema.nullable(),
    carrierMessageId: AuthorityIdSchema,
    causationId: AuthorityIdSchema.nullable(),
    correlationId: AuthorityIdSchema,
    downgradeReason: ExactStringSchema.nullable(),
  })
  .strict();
export type AuthorityDirective = z.infer<typeof AuthorityDirectiveSchema>;

export const AuthorityDirectiveBundleSchema = z
  .object({
    directive: AuthorityDirectiveSchema,
    attestation: DirectiveAttestationSchema.nullable(),
  })
  .strict();
export type AuthorityDirectiveBundle = z.infer<typeof AuthorityDirectiveBundleSchema>;

export const AuthoritySigningKeySchema = z
  .object({
    keyId: ExactStringSchema.min(16).max(200),
    algorithm: z.literal("Ed25519"),
    publicKeySpkiBase64Url: Base64UrlSchema,
    fingerprintSha256: Sha256Schema,
    status: z.enum(["ACTIVE", "RETIRED", "REVOKED"]),
    createdAt: IsoDateSchema,
  })
  .strict();
export type AuthoritySigningKey = z.infer<typeof AuthoritySigningKeySchema>;

export const RelayUserDirectiveInputSchema = z
  .object({
    source_user_turn_id: AuthorityIdSchema,
    target_agent_ids: z.array(AgentIdSchema).min(1).max(2),
    verbatim_text: ExactStringSchema.min(1).max(64 * 1024),
    quote_start: z.number().int().nonnegative(),
    quote_end: z.number().int().positive(),
    agent_interpretation: ExactStringSchema.max(16 * 1024)
      .nullable()
      .optional(),
    objective_id: AuthorityIdSchema.nullable().optional(),
    task_ids: z.array(AuthorityIdSchema).max(200).default([]),
    file_globs: z.array(ExactStringSchema.min(1).max(1024)).max(500).default([]),
    idempotency_key: z.string().min(1).max(300),
  })
  .strict();
export type RelayUserDirectiveInput = z.infer<typeof RelayUserDirectiveInputSchema>;

export const SupersedeUserDirectiveInputSchema = RelayUserDirectiveInputSchema.extend({
  reason: ExactStringSchema.min(1).max(4000),
}).strict();
export type SupersedeUserDirectiveInput = z.infer<typeof SupersedeUserDirectiveInputSchema>;

export const CreateDelegationGrantInputSchema = z
  .object({
    delegator_agent_ids: z.array(AgentIdSchema).min(1).max(2),
    target_agent_ids: z.array(AgentIdSchema).min(1).max(2),
    allowed_actions: z.array(DelegationActionSchema).min(1).max(2),
    objective_ids: z.array(AuthorityIdSchema).max(200).default([]),
    task_ids: z.array(AuthorityIdSchema).max(500).default([]),
    file_globs: z.array(ExactStringSchema.min(1).max(1024)).max(500).default([]),
    max_priority: DirectivePrioritySchema.default("IMPORTANT"),
    expires_at: IsoDateSchema,
    source_user_turn_id: AuthorityIdSchema.nullable().optional(),
    idempotency_key: z.string().min(1).max(300),
  })
  .strict();
export type CreateDelegationGrantInput = z.infer<typeof CreateDelegationGrantInputSchema>;

export const ModifyDelegationGrantInputSchema = CreateDelegationGrantInputSchema.omit({
  idempotency_key: true,
  source_user_turn_id: true,
}).extend({
  expected_version: z.number().int().positive(),
  idempotency_key: z.string().min(1).max(300),
});
export type ModifyDelegationGrantInput = z.infer<typeof ModifyDelegationGrantInputSchema>;

export const DelegationGrantSchema = z
  .object({
    id: AuthorityIdSchema,
    projectId: AuthorityIdSchema,
    version: z.number().int().positive(),
    status: z.enum(["ACTIVE", "SUPERSEDED", "TERMINATED", "EXPIRED"]),
    delegatorAgentIds: z.array(AgentIdSchema).min(1),
    targetAgentIds: z.array(AgentIdSchema).min(1),
    allowedActions: z.array(DelegationActionSchema).min(1),
    objectiveIds: z.array(AuthorityIdSchema),
    taskIds: z.array(AuthorityIdSchema),
    fileGlobs: z.array(ExactStringSchema),
    maxPriority: DirectivePrioritySchema,
    sourceUserTurnId: AuthorityIdSchema.nullable(),
    expiresAt: IsoDateSchema,
    issuedAt: IsoDateSchema,
    createdByPrincipalId: AuthorityIdSchema,
    supersedesVersion: z.number().int().positive().nullable(),
  })
  .strict();
export type DelegationGrant = z.infer<typeof DelegationGrantSchema>;

export const DelegateInstructionInputSchema = z
  .object({
    delegation_grant_id: AuthorityIdSchema,
    target_agent_ids: z.array(AgentIdSchema).min(1).max(2),
    delegated_text: ExactStringSchema.min(1).max(64 * 1024),
    objective_id: AuthorityIdSchema.nullable().optional(),
    task_ids: z.array(AuthorityIdSchema).max(200).default([]),
    file_globs: z.array(ExactStringSchema.min(1).max(1024)).max(500).default([]),
    priority: DirectivePrioritySchema.default("IMPORTANT"),
    expires_at: IsoDateSchema.nullable().optional(),
    idempotency_key: z.string().min(1).max(300),
  })
  .strict();
export type DelegateInstructionInput = z.infer<typeof DelegateInstructionInputSchema>;

export const DirectiveExecutionResultInputSchema = z
  .object({
    session_id: AuthorityIdSchema,
    status: z.enum(["SUCCEEDED", "FAILED", "DECLINED"]),
    summary: ExactStringSchema.min(1).max(16 * 1024),
    evidence: z.array(z.record(z.string(), z.unknown())).max(200).default([]),
    idempotency_key: z.string().min(1).max(300),
  })
  .strict();
export type DirectiveExecutionResultInput = z.infer<typeof DirectiveExecutionResultInputSchema>;

export const DirectiveLifecycleMutationInputSchema = z
  .object({
    reason: ExactStringSchema.min(1).max(4000),
    idempotency_key: z.string().min(1).max(300),
  })
  .strict();
export type DirectiveLifecycleMutationInput = z.infer<typeof DirectiveLifecycleMutationInputSchema>;

export const TerminateDelegationGrantInputSchema = z
  .object({
    reason: ExactStringSchema.min(1).max(4000),
    expected_version: z.number().int().positive(),
    idempotency_key: z.string().min(1).max(300),
  })
  .strict();
export type TerminateDelegationGrantInput = z.infer<typeof TerminateDelegationGrantInputSchema>;

type JsonPrimitive = null | boolean | string | number;
export type CanonicalJsonValue =
  | JsonPrimitive
  | CanonicalJsonValue[]
  | {
      [key: string]: CanonicalJsonValue;
    };

/**
 * Canonical JSON for signed Authority payloads. The accepted subset deliberately excludes floats,
 * negative zero, undefined, sparse arrays, non-plain objects, and unpaired surrogates. Object keys
 * use JavaScript's UTF-16 code-unit ordering; callers must sort semantic set arrays before signing.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") {
    if (hasUnpairedSurrogate(value)) throw new Error("Canonical JSON rejects unpaired surrogates");
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
      throw new Error("Canonical JSON accepts only safe non-negative-zero integers");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) throw new Error("Canonical JSON rejects sparse arrays");
    }
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys
      .map((key) => {
        if (hasUnpairedSurrogate(key)) throw new Error("Canonical JSON rejects invalid keys");
        const entry = record[key];
        if (entry === undefined) throw new Error("Canonical JSON rejects undefined values");
        return `${JSON.stringify(key)}:${canonicalJson(entry)}`;
      })
      .join(",")}}`;
  }
  throw new Error("Canonical JSON rejects unsupported values");
}

export function canonicalStringSet(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}
