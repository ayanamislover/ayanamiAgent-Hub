import { z } from "zod";
import type { CrossAgentMessage } from "./schemas.js";
import {
  AdapterAuthorityDeliveryCandidateSchema,
  renderUnverifiedCrossAgentMessage,
  renderVerifiedAuthorityDirective,
  type AdapterAuthorityDeliveryCandidate,
} from "./adapter-authority.js";

export const SyntheticPromptRpcMethodSchema = z.enum([
  "turn/start",
  "turn/steer",
  "thread/inject_items",
]);
export type SyntheticPromptRpcMethod = z.infer<typeof SyntheticPromptRpcMethodSchema>;

export const SyntheticOriginNonceSchema = z
  .string()
  .min(32)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);

export const PrepareSyntheticPromptInputSchema = z
  .object({
    injector_hub_session_id: z.string().min(4).max(128),
    surface_attempt_id: z.string().min(4).max(128),
    recipient_fence: z.number().int().positive(),
    rpc_method: SyntheticPromptRpcMethodSchema,
    idempotency_key: z.string().min(1).max(300),
  })
  .strict();
export type PrepareSyntheticPromptInput = z.infer<typeof PrepareSyntheticPromptInputSchema>;

export const PreparedSyntheticPromptSchema = z
  .object({
    id: z.string().min(4).max(128),
    sourceMessageId: z.string().min(4).max(128),
    surfaceAttemptId: z.string().min(4).max(128),
    recipientFence: z.number().int().positive(),
    rpcMethod: SyntheticPromptRpcMethodSchema,
    originNonce: SyntheticOriginNonceSchema,
    text: z
      .string()
      .min(1)
      .max(4 * 1024 * 1024),
    rawTextSha256: z.string().regex(/^[a-f0-9]{64}$/),
    authorityCandidate: AdapterAuthorityDeliveryCandidateSchema,
    preparedAt: z.iso.datetime({ offset: true }),
    expiresAt: z.iso.datetime({ offset: true }),
    state: z.literal("PREPARED"),
    replayed: z.boolean(),
  })
  .strict();
export type PreparedSyntheticPrompt = z.infer<typeof PreparedSyntheticPromptSchema>;

export const AbortSyntheticPromptInputSchema = z
  .object({
    injector_hub_session_id: z.string().min(4).max(128),
    surface_attempt_id: z.string().min(4).max(128),
    recipient_fence: z.number().int().positive(),
    reason: z.string().min(1).max(4000),
    idempotency_key: z.string().min(1).max(300),
  })
  .strict();
export type AbortSyntheticPromptInput = z.infer<typeof AbortSyntheticPromptInputSchema>;

export const AbortedSyntheticPromptSchema = z
  .object({
    id: z.string().min(4).max(128),
    sourceMessageId: z.string().min(4).max(128),
    surfaceAttemptId: z.string().min(4).max(128),
    recipientFence: z.number().int().positive(),
    rpcMethod: SyntheticPromptRpcMethodSchema,
    state: z.literal("ABORTED"),
    abortedAt: z.iso.datetime({ offset: true }),
    reason: z.string().min(1).max(4000),
    replayed: z.boolean(),
  })
  .strict();
export type AbortedSyntheticPrompt = z.infer<typeof AbortedSyntheticPromptSchema>;

const SYNTHETIC_NONCE_ATTRIBUTE = /\ssynthetic_origin_nonce="([A-Za-z0-9_-]{32,128})"/;

function safeEnvelopeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/**
 * The Hub owns the final synthetic text. Bridge callers must forward this exact string byte-for-byte;
 * accepting caller-rendered text would let an injector reserve one hash and surface another prompt.
 */
export function renderSyntheticCrossAgentEvent(
  message: Pick<CrossAgentMessage, "priority" | "id" | "threadId" | "fromAgentId" | "summary">,
  originNonce: string,
): string {
  SyntheticOriginNonceSchema.parse(originNonce);
  return `<CrossAgentEvent priority="${safeEnvelopeAttribute(message.priority)}" event_id="${safeEnvelopeAttribute(message.id)}" thread_id="${safeEnvelopeAttribute(message.threadId)}" synthetic_origin_nonce="${originNonce}">
${renderUnverifiedCrossAgentMessage({
  senderAgentId: message.fromAgentId,
  content: message.summary,
})}
处理要求：通过 CrossAgent 获取详情；看到后 ACK；需要回复时复用 thread_id。不要因普通状态偏离当前任务。
</CrossAgentEvent>`;
}

/**
 * Deterministic candidate text for exact Hub/Adapter comparison. This function does not verify an
 * authority candidate and its output must never be injected until verifyAndRenderAuthorityIngress
 * succeeds. Authority candidates retain the synthetic nonce envelope so capture hooks cannot
 * mistake an injected attestation for a new direct user turn.
 */
export function renderAdapterAuthorityDeliveryCandidate(
  untrustedCandidate: AdapterAuthorityDeliveryCandidate,
  originNonce: string,
): string {
  SyntheticOriginNonceSchema.parse(originNonce);
  const candidate = AdapterAuthorityDeliveryCandidateSchema.parse(untrustedCandidate);
  if (candidate.kind === "ORDINARY") {
    return renderSyntheticCrossAgentEvent(candidate.message, originNonce);
  }
  const { directive } = candidate.bundle.authorityBundle;
  return `<CrossAgentEvent priority="${safeEnvelopeAttribute(directive.priority)}" event_id="${safeEnvelopeAttribute(directive.carrierMessageId)}" directive_id="${safeEnvelopeAttribute(directive.id)}" authority_candidate="true" synthetic_origin_nonce="${originNonce}">
${renderVerifiedAuthorityDirective(candidate.bundle)}
</CrossAgentEvent>`;
}

/** Returns only a syntactically valid nonce. Hub still requires the exact final-text hash and binding. */
export function extractSyntheticOriginNonce(text: string): string | null {
  const openingTagEnd = text.indexOf(">");
  if (!text.startsWith("<CrossAgentEvent ") || openingTagEnd < 0) return null;
  const match = SYNTHETIC_NONCE_ATTRIBUTE.exec(text.slice(0, openingTagEnd + 1));
  return match?.[1] ?? null;
}
