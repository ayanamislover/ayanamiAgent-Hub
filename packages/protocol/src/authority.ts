import { z } from "zod";

const AuthorityIdSchema = z.string().min(4).max(128);
const UserTurnIdSchema = z
  .string()
  .min(5)
  .max(128)
  .regex(/^utr_[A-Za-z0-9_-]+$/);
const AuthorityIsoDateSchema = z.iso.datetime({ offset: true });

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

export const PrincipalKindSchema = z.enum([
  "AGENT",
  "BRIDGE_CAPTURE",
  "BRIDGE_INJECTOR",
  "DASHBOARD_USER",
  "SYSTEM",
]);
export type PrincipalKind = z.infer<typeof PrincipalKindSchema>;

export const CredentialScopeSchema = z.enum([
  "hub:agent",
  "hub:dashboard",
  "project:select",
  "project:join",
  "session-ticket:offer",
  "session-ticket:offer:capture",
  "session-ticket:offer:injector",
  "session:enroll:first",
  "hub:session",
  "hub:mcp",
  "user_turn:capture",
  "synthetic_prompt:reserve",
  "directive:relay",
]);
export type CredentialScope = z.infer<typeof CredentialScopeSchema>;

/**
 * A session ticket grants exactly one Adapter capability. These values are deliberately closed:
 * accepting a caller-defined purpose would let an Adapter mint a capability the Hub never
 * authorized.
 */
export const SessionTicketPurposeSchema = z.enum(["CONTROL", "MODEL_MCP", "CAPTURE", "INJECTOR"]);
export type SessionTicketPurpose = z.infer<typeof SessionTicketPurposeSchema>;

export const SessionTicketStateSchema = z.enum([
  "PENDING",
  "ACTIVE",
  "REVOKED",
  "EXPIRED",
  "SUPERSEDED",
]);
export type SessionTicketState = z.infer<typeof SessionTicketStateSchema>;

/** Stable machine codes for fail-closed enrollment and binding failures. */
export const SessionTicketErrorCodeSchema = z.enum([
  "TICKET_DIGEST_COLLISION",
  "TICKET_IDEMPOTENCY_CONFLICT",
  "TICKET_OFFER_NOT_AUTHORIZED",
  "TICKET_NOT_FOUND",
  "TICKET_NOT_PENDING",
  "TICKET_EXPIRED",
  "TICKET_BINDING_MISMATCH",
  "TICKET_REPLACEMENT_PROOF_REQUIRED",
  "TICKET_ACTIVATION_CONFLICT",
  "TICKET_AMBIGUOUS_CREDENTIAL",
  "TICKET_NOT_ACTIVE",
]);
export type SessionTicketErrorCode = z.infer<typeof SessionTicketErrorCodeSchema>;

export const AuthorityTypeSchema = z.enum([
  "USER_DIRECT",
  "USER_ATTESTED",
  "USER_DELEGATED",
  "AGENT_DECISION",
  "AGENT_PROPOSAL",
  "AGENT_HEARSAY",
]);
export type AuthorityType = z.infer<typeof AuthorityTypeSchema>;

export const DirectiveLifecycleSchema = z.enum([
  "ACTIVE",
  "SUPERSEDED",
  "REVOKED",
  "COMPLETED",
  "EXPIRED",
]);
export type DirectiveLifecycle = z.infer<typeof DirectiveLifecycleSchema>;

export const DirectiveVerificationSchema = z.enum([
  "VALID",
  "INVALID",
  "UNVERIFIED",
  "EXPIRED",
  "REVOKED",
]);
export type DirectiveVerification = z.infer<typeof DirectiveVerificationSchema>;

export const UserTurnClientTypeSchema = z.enum(["codex", "claude"]);
export type UserTurnClientType = z.infer<typeof UserTurnClientTypeSchema>;

export const UserTurnSchema = z.object({
  id: UserTurnIdSchema,
  projectId: AuthorityIdSchema,
  sourcePrincipalId: AuthorityIdSchema,
  sourceCredentialId: AuthorityIdSchema,
  sourceBindingId: AuthorityIdSchema,
  sourceHubSessionId: AuthorityIdSchema,
  clientType: UserTurnClientTypeSchema,
  sessionId: z.string().min(1).max(512),
  turnId: z.string().min(1).max(512).nullable(),
  cwd: z.string().min(1).max(4096),
  rawText: z.string().max(4 * 1024 * 1024),
  rawTextSha256: z.string().regex(/^[a-f0-9]{64}$/),
  capturedAt: AuthorityIsoDateSchema,
  receivedAt: AuthorityIsoDateSchema,
  correlationId: z.string().min(1).max(300).nullable(),
});
export type UserTurn = z.infer<typeof UserTurnSchema>;

/** Wire schema intentionally follows the public capture endpoint's snake_case contract. */
export const CaptureUserTurnInputSchema = z
  .object({
    user_turn_id: UserTurnIdSchema,
    project_id: AuthorityIdSchema,
    client_type: UserTurnClientTypeSchema,
    session_id: z.string().min(1).max(512),
    turn_id: z.string().min(1).max(512).nullable().optional(),
    cwd: z.string().min(1).max(4096),
    raw_prompt: z
      .string()
      .max(4 * 1024 * 1024)
      .refine((value) => !hasUnpairedSurrogate(value), "raw_prompt contains an unpaired surrogate"),
    synthetic_origin_nonce: z
      .string()
      .min(32)
      .max(128)
      .regex(/^[A-Za-z0-9_-]+$/)
      .nullable()
      .optional(),
    captured_at: AuthorityIsoDateSchema,
    idempotency_key: z.string().min(1).max(300),
    correlation_id: z.string().min(1).max(300).nullable().optional(),
  })
  .strict();
export type CaptureUserTurnInput = z.infer<typeof CaptureUserTurnInputSchema>;
