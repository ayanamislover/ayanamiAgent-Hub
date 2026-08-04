import { z } from "zod";
import { AuthorityIngressReasonSchema } from "./adapter-authority.js";
import {
  AuthorityTypeSchema,
  DirectiveLifecycleSchema,
  UserTurnClientTypeSchema,
} from "./authority.js";
import {
  DelegationGrantSchema,
  DirectivePrioritySchema,
  DirectiveScopeSchema,
} from "./directive-attestation.js";
import { TaskStatusSchema } from "./constants.js";

const IdSchema = z.string().min(4).max(160);
const AgentIdSchema = z.enum(["codex", "claude"]);
const IsoDateSchema = z.iso.datetime({ offset: true });
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const CursorSchema = z
  .string()
  .min(8)
  .max(512)
  .regex(/^[A-Za-z0-9_-]+$/u);
const PageSizeSchema = z.number().int().min(1).max(100);
const ServerSequenceSchema = z.number().int().nonnegative();

function sortedUnique(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || values[index - 1]! < value);
}

const CanonicalAgentSetSchema = z
  .array(AgentIdSchema)
  .min(1)
  .max(2)
  .refine(sortedUnique, "agent ids must be sorted and unique");
const CanonicalIdSetSchema = z
  .array(IdSchema)
  .max(200)
  .refine(sortedUnique, "ids must be sorted and unique");

/** The only Authority classes for which the Hub stores an Ed25519 attestation. */
export const SignedDirectiveAuthoritySchema = z.enum(["USER_ATTESTED", "USER_DELEGATED"]);
export type SignedDirectiveAuthority = z.infer<typeof SignedDirectiveAuthoritySchema>;

/** The closed set represented by authority_directives; only the first two members are signed. */
export const PersistedDirectiveAuthoritySchema = z.enum([
  "USER_ATTESTED",
  "USER_DELEGATED",
  "AGENT_PROPOSAL",
]);
export type PersistedDirectiveAuthority = z.infer<typeof PersistedDirectiveAuthoritySchema>;

/**
 * Keeps the six domain classes visible without pretending every class is a persisted directive.
 * USER_DIRECT is a trusted-client turn, while decisions and hearsay are separate provenance.
 */
export const AuthorityClassDescriptorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("USER_TURN"), authority: z.literal("USER_DIRECT") }).strict(),
  z
    .object({ kind: z.literal("SIGNED_DIRECTIVE"), authority: SignedDirectiveAuthoritySchema })
    .strict(),
  z
    .object({ kind: z.literal("UNSIGNED_DIRECTIVE"), authority: z.literal("AGENT_PROPOSAL") })
    .strict(),
  z
    .object({
      kind: z.literal("AGENT_PROVENANCE"),
      authority: z.enum(["AGENT_DECISION", "AGENT_PROPOSAL", "AGENT_HEARSAY"]),
    })
    .strict(),
]);
export type AuthorityClassDescriptor = z.infer<typeof AuthorityClassDescriptorSchema>;

export const HubIssuanceVerificationSchema = z
  .object({
    issuanceState: z.enum(["SIGNED_STRUCTURALLY_VALID", "UNSIGNED", "INVALID"]),
    /** VALID is deliberately absent: only a target Adapter can produce it. */
    verification: z.enum(["UNVERIFIED", "INVALID", "EXPIRED", "REVOKED"]),
    keyId: z.string().min(16).max(200).nullable(),
    canonicalPayloadSha256: Sha256Schema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.issuanceState === "SIGNED_STRUCTURALLY_VALID" &&
      (value.keyId === null || value.canonicalPayloadSha256 === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["keyId"],
        message: "a structurally valid signed issuance requires its key and canonical payload hash",
      });
    }
    if (
      value.issuanceState === "UNSIGNED" &&
      (value.verification !== "UNVERIFIED" ||
        value.keyId !== null ||
        value.canonicalPayloadSha256 !== null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["issuanceState"],
        message: "an unsigned issuance cannot carry signing material or verification",
      });
    }
    if (value.issuanceState === "INVALID" && value.verification !== "INVALID") {
      context.addIssue({
        code: "custom",
        path: ["verification"],
        message: "an invalid issuance must remain INVALID",
      });
    }
    if (value.issuanceState === "SIGNED_STRUCTURALLY_VALID" && value.verification === "INVALID") {
      context.addIssue({
        code: "custom",
        path: ["verification"],
        message: "a structurally valid issuance cannot simultaneously be INVALID",
      });
    }
  });
export type HubIssuanceVerification = z.infer<typeof HubIssuanceVerificationSchema>;

export const AdapterVerificationReceiptSchema = z
  .object({
    verification: z.enum(["VALID", "INVALID", "EXPIRED", "REVOKED"]),
    reason: AuthorityIngressReasonSchema,
    observedAt: IsoDateSchema,
    targetAgentId: AgentIdSchema,
    targetSessionId: IdSchema,
    targetSessionIncarnation: z.number().int().nonnegative(),
    surfaceAttemptId: IdSchema,
    recipientFence: z.number().int().positive(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.verification === "VALID") !== (value.reason === "VERIFIED")) {
      context.addIssue({
        code: "custom",
        path: ["reason"],
        message: "only a VALID Adapter receipt may use VERIFIED",
      });
    }
  });
export type AdapterVerificationReceipt = z.infer<typeof AdapterVerificationReceiptSchema>;

export const AdapterVerificationObservationSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("NOT_REPORTED"), receipt: z.null() }).strict(),
  z
    .object({
      status: z.enum(["VALID", "INVALID", "EXPIRED", "REVOKED"]),
      receipt: AdapterVerificationReceiptSchema,
    })
    .strict()
    .superRefine((value, context) => {
      if (value.status !== value.receipt.verification) {
        context.addIssue({
          code: "custom",
          path: ["receipt", "verification"],
          message: "Adapter verification status must match its receipt",
        });
      }
    }),
]);
export type AdapterVerificationObservation = z.infer<typeof AdapterVerificationObservationSchema>;

export const AuthorityTargetStateSchema = z
  .object({
    targetAgentId: AgentIdSchema,
    carrierMessageId: IdSchema,
    recipientId: IdSchema,
    deliveryState: z.enum([
      "PENDING",
      "FAILED",
      "DELIVERED",
      "ACKNOWLEDGED",
      "PROCESSED",
      "RESPONDED",
    ]),
    targetSessionId: IdSchema.nullable(),
    targetSessionIncarnation: z.number().int().nonnegative().nullable(),
    surfaceAttemptId: IdSchema.nullable(),
    recipientFence: z.number().int().positive().nullable(),
    deliveredAt: IsoDateSchema.nullable(),
    acknowledgedAt: IsoDateSchema.nullable(),
    processedAt: IsoDateSchema.nullable(),
    adapterVerification: AdapterVerificationObservationSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const delivered = !["PENDING", "FAILED"].includes(value.deliveryState);
    const binding = [
      value.targetSessionId,
      value.targetSessionIncarnation,
      value.surfaceAttemptId,
      value.recipientFence,
    ];
    if (delivered && (binding.some((entry) => entry === null) || value.deliveredAt === null)) {
      context.addIssue({
        code: "custom",
        path: ["deliveryState"],
        message: "a delivered target requires the exact session, surface, fence, and timestamp",
      });
    }
    if (!delivered && value.adapterVerification.status !== "NOT_REPORTED") {
      context.addIssue({
        code: "custom",
        path: ["adapterVerification"],
        message: "an undelivered target cannot have an Adapter verification receipt",
      });
    }
    if (
      ["ACKNOWLEDGED", "PROCESSED", "RESPONDED"].includes(value.deliveryState) &&
      value.acknowledgedAt === null
    ) {
      context.addIssue({
        code: "custom",
        path: ["acknowledgedAt"],
        message: "an acknowledged target requires its acknowledgement timestamp",
      });
    }
    if (["PROCESSED", "RESPONDED"].includes(value.deliveryState) && value.processedAt === null) {
      context.addIssue({
        code: "custom",
        path: ["processedAt"],
        message: "a processed target requires its processing timestamp",
      });
    }
    const receipt = value.adapterVerification.receipt;
    if (
      receipt &&
      (receipt.targetAgentId !== value.targetAgentId ||
        receipt.targetSessionId !== value.targetSessionId ||
        receipt.targetSessionIncarnation !== value.targetSessionIncarnation ||
        receipt.surfaceAttemptId !== value.surfaceAttemptId ||
        receipt.recipientFence !== value.recipientFence)
    ) {
      context.addIssue({
        code: "custom",
        path: ["adapterVerification", "receipt"],
        message: "Adapter verification binding must match the exact delivered target surface",
      });
    }
  });
export type AuthorityTargetState = z.infer<typeof AuthorityTargetStateSchema>;

const DirectiveExecutionStatusSchema = z.enum(["SUCCEEDED", "FAILED", "DECLINED"]);

export const DirectiveExecutionResultViewSchema = z
  .object({
    id: IdSchema,
    projectId: IdSchema,
    directiveId: IdSchema,
    targetAgentId: AgentIdSchema,
    sessionId: IdSchema,
    status: DirectiveExecutionStatusSchema,
    summary: z
      .string()
      .min(1)
      .max(16 * 1024),
    /** Existing execution evidence is intentionally an extension seam; the envelope is closed. */
    evidence: z.array(z.record(z.string().min(1).max(200), z.json())).max(200),
    serverSequence: z.number().int().positive(),
    eventId: IdSchema,
    causationId: IdSchema,
    correlationId: IdSchema,
    createdAt: IsoDateSchema,
  })
  .strict();
export type DirectiveExecutionResultView = z.infer<typeof DirectiveExecutionResultViewSchema>;

const AuthorityTimelineEventTypeSchema = z.enum([
  "USER_TURN_CAPTURED",
  "DIRECTIVE_ISSUED",
  "DIRECTIVE_DELIVERED",
  "DIRECTIVE_ACKNOWLEDGED",
  "DIRECTIVE_PROCESSED",
  "ADAPTER_VERIFIED",
  "DIRECTIVE_RESULT_RECORDED",
  "DIRECTIVE_SUPERSEDED",
  "DIRECTIVE_REVOKED",
  "DIRECTIVE_COMPLETED",
  "DIRECTIVE_EXPIRED",
  "DIRECTIVE_DOWNGRADED",
  "DELEGATION_ISSUED",
  "DELEGATION_MODIFIED",
  "DELEGATION_TERMINATED",
  "DELEGATION_EXPIRED",
  "AGENT_DECISION_RECORDED",
  "AGENT_PROPOSAL_RECORDED",
  "AGENT_HEARSAY_RECORDED",
]);

const AuthorityTimelineActorSchema = z
  .object({
    actorType: z.enum(["agent", "user", "system"]),
    principalId: IdSchema.nullable(),
    sessionId: IdSchema.nullable(),
    displayName: z.string().min(1).max(256),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.actorType === "agent" && value.sessionId === null && value.principalId === null) {
      context.addIssue({
        code: "custom",
        path: ["sessionId"],
        message: "an Agent event requires authenticated session or principal provenance",
      });
    }
  });

export const AuthorityTimelineEventSchema = z
  .object({
    id: IdSchema,
    eventId: IdSchema,
    projectId: IdSchema,
    aggregateKind: z.enum(["USER_TURN", "DIRECTIVE", "DELEGATION_GRANT"]),
    directiveId: IdSchema.nullable(),
    delegationGrantId: IdSchema.nullable(),
    delegationVersion: z.number().int().positive().nullable(),
    userTurnId: IdSchema.nullable(),
    eventType: AuthorityTimelineEventTypeSchema,
    authorityClass: AuthorityClassDescriptorSchema.nullable(),
    actor: AuthorityTimelineActorSchema,
    targetAgentId: AgentIdSchema.nullable(),
    serverSequence: z.number().int().positive(),
    fromLifecycle: DirectiveLifecycleSchema.nullable(),
    toLifecycle: DirectiveLifecycleSchema.nullable(),
    causationId: IdSchema.nullable(),
    correlationId: IdSchema,
    occurredAt: IsoDateSchema,
    summary: z
      .string()
      .max(16 * 1024)
      .nullable(),
    adapterVerificationReceipt: AdapterVerificationReceiptSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const aggregateIds = {
      USER_TURN: value.userTurnId,
      DIRECTIVE: value.directiveId,
      DELEGATION_GRANT: value.delegationGrantId,
    } as const;
    if (
      aggregateIds[value.aggregateKind] === null ||
      Object.entries(aggregateIds).some(([kind, id]) => kind !== value.aggregateKind && id !== null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["aggregateKind"],
        message: "timeline aggregate kind must select exactly one matching aggregate id",
      });
    }
    if ((value.aggregateKind === "DELEGATION_GRANT") !== (value.delegationVersion !== null)) {
      context.addIssue({
        code: "custom",
        path: ["delegationVersion"],
        message: "only a delegation event may carry its exact grant version",
      });
    }
    if ((value.eventType === "ADAPTER_VERIFIED") !== (value.adapterVerificationReceipt !== null)) {
      context.addIssue({
        code: "custom",
        path: ["adapterVerificationReceipt"],
        message: "only an Adapter verification event may carry a verification receipt",
      });
    }
    if (
      value.adapterVerificationReceipt &&
      value.targetAgentId !== value.adapterVerificationReceipt.targetAgentId
    ) {
      context.addIssue({
        code: "custom",
        path: ["targetAgentId"],
        message: "Adapter verification target must match its receipt",
      });
    }
    if (value.eventType === "DIRECTIVE_ISSUED" && value.toLifecycle !== "ACTIVE") {
      context.addIssue({
        code: "custom",
        path: ["toLifecycle"],
        message: "directive issuance must enter ACTIVE lifecycle",
      });
    }
  });
export type AuthorityTimelineEvent = z.infer<typeof AuthorityTimelineEventSchema>;

const UserTurnSummarySchema = z
  .object({
    id: IdSchema,
    projectId: IdSchema,
    authorityClass: z
      .object({ kind: z.literal("USER_TURN"), authority: z.literal("USER_DIRECT") })
      .strict(),
    sourcePrincipalId: IdSchema,
    sourceCredentialId: IdSchema,
    sourceBindingId: IdSchema,
    sourceHubSessionId: IdSchema,
    sourceSessionTicketId: IdSchema.nullable(),
    clientType: UserTurnClientTypeSchema,
    sessionId: z.string().min(1).max(512),
    turnId: z.string().min(1).max(512).nullable(),
    cwd: z.string().min(1).max(4096),
    rawTextSha256: Sha256Schema,
    capturedAt: IsoDateSchema,
    receivedAt: IsoDateSchema,
    correlationId: IdSchema.nullable(),
    directiveIds: CanonicalIdSetSchema,
  })
  .strict();
export type UserTurnSummary = z.infer<typeof UserTurnSummarySchema>;

export const UserTurnDetailSchema = UserTurnSummarySchema.omit({ directiveIds: true })
  .extend({ rawText: z.string().max(4 * 1024 * 1024) })
  .strict();
export type UserTurnDetail = z.infer<typeof UserTurnDetailSchema>;

const DirectiveResultStatusSummarySchema = z
  .object({ targetAgentId: AgentIdSchema, status: DirectiveExecutionStatusSchema })
  .strict();

export const AuthorityDirectiveSummarySchema = z
  .object({
    id: IdSchema,
    projectId: IdSchema,
    authorityClass: z.discriminatedUnion("kind", [
      z
        .object({ kind: z.literal("SIGNED_DIRECTIVE"), authority: SignedDirectiveAuthoritySchema })
        .strict(),
      z
        .object({ kind: z.literal("UNSIGNED_DIRECTIVE"), authority: z.literal("AGENT_PROPOSAL") })
        .strict(),
    ]),
    lifecycle: DirectiveLifecycleSchema,
    priority: DirectivePrioritySchema,
    sourceUserTurnId: IdSchema.nullable(),
    relayAgentId: AgentIdSchema,
    relaySessionId: IdSchema.nullable(),
    targetAgentIds: CanonicalAgentSetSchema,
    scope: DirectiveScopeSchema,
    delegationGrantId: IdSchema.nullable(),
    delegationVersion: z.number().int().positive().nullable(),
    attemptedDelegationGrantId: IdSchema.nullable(),
    attemptedDelegationVersion: z.number().int().positive().nullable(),
    supersedesDirectiveId: IdSchema.nullable(),
    supersededByDirectiveId: IdSchema.nullable(),
    carrierMessageId: IdSchema,
    serverSequence: z.number().int().positive(),
    issuedAt: IsoDateSchema,
    expiresAt: IsoDateSchema.nullable(),
    causationId: IdSchema.nullable(),
    correlationId: IdSchema,
    hubIssuance: HubIssuanceVerificationSchema,
    targets: z.array(AuthorityTargetStateSchema).min(1).max(2),
    executionResultStatuses: z.array(DirectiveResultStatusSummarySchema).max(2),
  })
  .strict()
  .superRefine((value, context) => {
    const signed = value.authorityClass.kind === "SIGNED_DIRECTIVE";
    if (
      (signed && value.hubIssuance.issuanceState === "UNSIGNED") ||
      (!signed && value.hubIssuance.issuanceState !== "UNSIGNED")
    ) {
      context.addIssue({
        code: "custom",
        path: ["hubIssuance", "issuanceState"],
        message: "Hub issuance state must match the persisted directive authority class",
      });
    }
    const authority = value.authorityClass.authority;
    if (
      authority === "USER_ATTESTED" &&
      (value.sourceUserTurnId === null || value.delegationGrantId !== null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["sourceUserTurnId"],
        message: "USER_ATTESTED requires a source user turn and no delegation grant",
      });
    }
    if (
      authority === "USER_DELEGATED" &&
      (value.sourceUserTurnId !== null ||
        value.delegationGrantId === null ||
        value.delegationVersion === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["delegationGrantId"],
        message: "USER_DELEGATED requires an exact delegation version and no source turn quote",
      });
    }
    if (
      authority === "AGENT_PROPOSAL" &&
      (value.delegationGrantId !== null || value.delegationVersion !== null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["delegationGrantId"],
        message: "AGENT_PROPOSAL cannot inherit a delegation grant",
      });
    }
    if (
      (value.attemptedDelegationGrantId === null) !==
      (value.attemptedDelegationVersion === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["attemptedDelegationVersion"],
        message: "attempted delegation id and version must appear together",
      });
    }
    const targetIds = value.targets.map((target) => target.targetAgentId).sort();
    if (
      !sortedUnique(targetIds) ||
      JSON.stringify(targetIds) !== JSON.stringify(value.targetAgentIds) ||
      value.targets.some((target) => target.carrierMessageId !== value.carrierMessageId)
    ) {
      context.addIssue({
        code: "custom",
        path: ["targets"],
        message: "target state set and carrier must exactly match the directive audience",
      });
    }
    const resultTargets = value.executionResultStatuses.map((entry) => entry.targetAgentId).sort();
    if (
      !sortedUnique(resultTargets) ||
      resultTargets.some((target) => !value.targetAgentIds.includes(target))
    ) {
      context.addIssue({
        code: "custom",
        path: ["executionResultStatuses"],
        message: "execution results must be unique members of the directive audience",
      });
    }
  });
export type AuthorityDirectiveSummary = z.infer<typeof AuthorityDirectiveSummarySchema>;

function boundedPage<T extends z.ZodType>(item: T) {
  return z
    .object({
      items: z.array(item).max(100),
      pageSize: PageSizeSchema,
      snapshotSequence: ServerSequenceSchema,
      nextCursor: CursorSchema.nullable(),
    })
    .strict()
    .superRefine((value, context) => {
      if (value.items.length > value.pageSize) {
        context.addIssue({
          code: "custom",
          path: ["items"],
          message: "page contains more items than its bounded page size",
        });
      }
      if (value.items.length === 0 && value.nextCursor !== null) {
        context.addIssue({
          code: "custom",
          path: ["nextCursor"],
          message: "an empty page cannot advance a cursor",
        });
      }
    });
}

export const AuthorityDirectiveSummaryPageSchema = boundedPage(AuthorityDirectiveSummarySchema);
export type AuthorityDirectiveSummaryPage = z.infer<typeof AuthorityDirectiveSummaryPageSchema>;

export const UserTurnSummaryPageSchema = boundedPage(UserTurnSummarySchema);
export type UserTurnSummaryPage = z.infer<typeof UserTurnSummaryPageSchema>;

const DelegationVersionViewSchema = DelegationGrantSchema.strict();

export const DelegationGrantProvenanceSchema = z
  .object({
    grantId: IdSchema,
    projectId: IdSchema,
    referencedVersion: z.number().int().positive(),
    currentVersion: z.number().int().positive(),
    status: z.enum(["ACTIVE", "TERMINATED", "EXPIRED"]),
    sourceUserTurnId: IdSchema.nullable(),
    versions: z.array(DelegationVersionViewSchema).min(1).max(100),
    timeline: z.array(AuthorityTimelineEventSchema).min(1).max(500),
    integrity: z.literal("COMPLETE_LINEAR"),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = new Set<number>();
    value.versions.forEach((version, index) => {
      const expected = index + 1;
      const expectedStatus = index === value.versions.length - 1 ? value.status : "SUPERSEDED";
      if (
        ids.has(version.version) ||
        version.id !== value.grantId ||
        version.projectId !== value.projectId ||
        version.version !== expected ||
        version.supersedesVersion !== (expected === 1 ? null : expected - 1) ||
        version.sourceUserTurnId !== value.sourceUserTurnId ||
        version.status !== expectedStatus
      ) {
        context.addIssue({
          code: "custom",
          path: ["versions", index],
          message: "delegation version history must be complete, unique, and linear",
        });
      }
      ids.add(version.version);
    });
    if (
      value.currentVersion !== value.versions.at(-1)?.version ||
      !ids.has(value.referencedVersion)
    ) {
      context.addIssue({
        code: "custom",
        path: ["currentVersion"],
        message: "referenced and current grant versions must both resolve in complete history",
      });
    }
    const issuance = value.timeline.filter((event) => event.eventType === "DELEGATION_ISSUED");
    const modifications = value.timeline.filter(
      (event) => event.eventType === "DELEGATION_MODIFIED",
    );
    if (issuance.length !== 1 || modifications.length !== value.versions.length - 1) {
      context.addIssue({
        code: "custom",
        path: ["timeline"],
        message: "delegation timeline must account for every exact version",
      });
    }
    let previousSequence = 0;
    for (const [index, event] of value.timeline.entries()) {
      if (
        event.aggregateKind !== "DELEGATION_GRANT" ||
        event.delegationGrantId !== value.grantId ||
        event.projectId !== value.projectId ||
        event.correlationId !== value.grantId ||
        (event.eventType === "DELEGATION_ISSUED" && event.delegationVersion !== 1) ||
        (event.eventType === "DELEGATION_MODIFIED" &&
          event.delegationVersion !== modifications.indexOf(event) + 2) ||
        event.serverSequence <= previousSequence
      ) {
        context.addIssue({
          code: "custom",
          path: ["timeline", index],
          message: "delegation provenance correlation and sequence must be complete and ordered",
        });
      }
      previousSequence = event.serverSequence;
    }
  });
export type DelegationGrantProvenance = z.infer<typeof DelegationGrantProvenanceSchema>;

const SupersessionNodeSchema = z
  .object({
    directiveId: IdSchema,
    /** The correlation owned by this exact directive generation. */
    correlationId: IdSchema,
    supersedesDirectiveId: IdSchema.nullable(),
    successorDirectiveIds: z.array(IdSchema).max(1),
    lifecycle: DirectiveLifecycleSchema,
    serverSequence: z.number().int().positive(),
    issuedAt: IsoDateSchema,
  })
  .strict();

export const AuthoritySupersessionChainSchema = z
  .object({
    rootDirectiveId: IdSchema,
    focusDirectiveId: IdSchema,
    currentDirectiveId: IdSchema,
    nodes: z.array(SupersessionNodeSchema).min(1).max(100),
    integrity: z.literal("COMPLETE_LINEAR"),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = new Set<string>();
    value.nodes.forEach((node, index) => {
      const previous = value.nodes[index - 1];
      const next = value.nodes[index + 1];
      if (
        ids.has(node.directiveId) ||
        node.supersedesDirectiveId !== (previous?.directiveId ?? null) ||
        JSON.stringify(node.successorDirectiveIds) !==
          JSON.stringify(next ? [next.directiveId] : []) ||
        (previous !== undefined && node.serverSequence <= previous.serverSequence)
      ) {
        context.addIssue({
          code: "custom",
          path: ["nodes", index],
          message: "supersession history is broken, forked, duplicated, or non-monotonic",
        });
      }
      ids.add(node.directiveId);
      if (next && node.lifecycle !== "SUPERSEDED") {
        context.addIssue({
          code: "custom",
          path: ["nodes", index, "lifecycle"],
          message: "every non-current supersession node must be SUPERSEDED",
        });
      }
    });
    if (
      value.rootDirectiveId !== value.nodes[0]?.directiveId ||
      value.currentDirectiveId !== value.nodes.at(-1)?.directiveId ||
      !ids.has(value.focusDirectiveId)
    ) {
      context.addIssue({
        code: "custom",
        path: ["nodes"],
        message: "supersession root, focus, and current ids must resolve in one linear chain",
      });
    }
  });
export type AuthoritySupersessionChain = z.infer<typeof AuthoritySupersessionChainSchema>;

const AuthorityObjectiveProjectionSchema = z
  .object({
    id: IdSchema,
    projectId: IdSchema,
    title: z.string().min(1).max(300),
    status: z.enum(["PLANNED", "ACTIVE", "COMPLETED", "CANCELLED"]),
  })
  .strict();

const AuthorityTaskProjectionSchema = z
  .object({
    id: IdSchema,
    projectId: IdSchema,
    title: z.string().min(1).max(400),
    status: TaskStatusSchema,
    objectiveId: IdSchema.optional(),
  })
  .strict();

/** Resolved scope objects for detail views; summary pages retain only bounded identifiers. */
export const AuthorityScopeProjectionSchema = z
  .object({
    objective: AuthorityObjectiveProjectionSchema.nullable(),
    tasks: z.array(AuthorityTaskProjectionSchema).max(200),
  })
  .strict();
export type AuthorityScopeProjection = z.infer<typeof AuthorityScopeProjectionSchema>;

const AuthorityDirectiveContentSchema = z
  .object({
    kind: PersistedDirectiveAuthoritySchema,
    verbatimText: z
      .string()
      .max(64 * 1024)
      .nullable(),
    delegatedText: z
      .string()
      .max(64 * 1024)
      .nullable(),
    proposedText: z
      .string()
      .max(64 * 1024)
      .nullable(),
    agentInterpretation: z
      .string()
      .max(16 * 1024)
      .nullable(),
    downgradeReason: z.string().max(4000).nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const valid =
      (value.kind === "USER_ATTESTED" &&
        value.verbatimText !== null &&
        value.delegatedText === null &&
        value.proposedText === null &&
        value.downgradeReason === null) ||
      (value.kind === "USER_DELEGATED" &&
        value.verbatimText === null &&
        value.delegatedText !== null &&
        value.proposedText === null &&
        value.downgradeReason === null) ||
      (value.kind === "AGENT_PROPOSAL" &&
        value.verbatimText === null &&
        value.delegatedText === null &&
        value.proposedText !== null &&
        value.downgradeReason !== null);
    if (!valid) {
      context.addIssue({
        code: "custom",
        path: ["kind"],
        message: "directive content fields must match the exact persisted authority class",
      });
    }
  });

export const AuthorityDirectiveProvenanceSchema = z
  .object({
    summary: AuthorityDirectiveSummarySchema,
    authoritativeContent: AuthorityDirectiveContentSchema,
    /** Raw user text is available only in this detail read-model, never in summary pages. */
    sourceUserTurn: UserTurnDetailSchema.nullable(),
    delegationGrant: DelegationGrantProvenanceSchema.nullable(),
    scopeProjection: AuthorityScopeProjectionSchema,
    executionResults: z.array(DirectiveExecutionResultViewSchema).max(2),
    timeline: z.array(AuthorityTimelineEventSchema).min(1).max(1000),
    supersession: AuthoritySupersessionChainSchema,
    integrity: z.literal("COMPLETE"),
  })
  .strict()
  .superRefine((value, context) => {
    const authority = value.summary.authorityClass.authority;
    if (value.authoritativeContent.kind !== authority) {
      context.addIssue({
        code: "custom",
        path: ["authoritativeContent", "kind"],
        message: "detail content must match its summary authority class",
      });
    }
    if (
      (value.summary.sourceUserTurnId === null) !== (value.sourceUserTurn === null) ||
      (value.sourceUserTurn !== null &&
        (value.sourceUserTurn.id !== value.summary.sourceUserTurnId ||
          value.sourceUserTurn.projectId !== value.summary.projectId))
    ) {
      context.addIssue({
        code: "custom",
        path: ["sourceUserTurn"],
        message: "source user turn detail must match the attested directive source",
      });
    }
    const referencedGrantId =
      value.summary.delegationGrantId ?? value.summary.attemptedDelegationGrantId;
    const referencedGrantVersion =
      value.summary.delegationVersion ?? value.summary.attemptedDelegationVersion;
    if (
      (referencedGrantId === null) !== (value.delegationGrant === null) ||
      (value.delegationGrant !== null &&
        (value.delegationGrant.grantId !== referencedGrantId ||
          value.delegationGrant.referencedVersion !== referencedGrantVersion ||
          value.delegationGrant.projectId !== value.summary.projectId))
    ) {
      context.addIssue({
        code: "custom",
        path: ["delegationGrant"],
        message: "delegation provenance must match the exact signed grant version",
      });
    }
    const projectedObjective = value.scopeProjection.objective;
    if (
      (value.summary.scope.objective_id === null) !== (projectedObjective === null) ||
      (projectedObjective !== null &&
        (projectedObjective.id !== value.summary.scope.objective_id ||
          projectedObjective.projectId !== value.summary.projectId))
    ) {
      context.addIssue({
        code: "custom",
        path: ["scopeProjection", "objective"],
        message: "scope objective projection must resolve the exact summary objective in-project",
      });
    }
    const projectedTaskIds = value.scopeProjection.tasks.map((task) => task.id);
    if (
      new Set(projectedTaskIds).size !== projectedTaskIds.length ||
      JSON.stringify(projectedTaskIds) !== JSON.stringify(value.summary.scope.task_ids)
    ) {
      context.addIssue({
        code: "custom",
        path: ["scopeProjection", "tasks"],
        message:
          "scope task projection must exactly preserve summary task order without duplicates",
      });
    }
    value.scopeProjection.tasks.forEach((task, index) => {
      if (
        task.projectId !== value.summary.projectId ||
        (task.objectiveId !== undefined &&
          projectedObjective !== null &&
          task.objectiveId !== projectedObjective.id)
      ) {
        context.addIssue({
          code: "custom",
          path: ["scopeProjection", "tasks", index],
          message:
            "scope task projection must stay in-project and reference its projected objective",
        });
      }
    });
    const focus = value.supersession.nodes.find(
      (node) => node.directiveId === value.supersession.focusDirectiveId,
    );
    if (
      value.supersession.focusDirectiveId !== value.summary.id ||
      focus?.correlationId !== value.summary.correlationId ||
      focus?.supersedesDirectiveId !== value.summary.supersedesDirectiveId ||
      (focus?.successorDirectiveIds[0] ?? null) !== value.summary.supersededByDirectiveId ||
      (value.summary.supersedesDirectiveId !== null &&
        value.summary.causationId !== value.summary.supersedesDirectiveId)
    ) {
      context.addIssue({
        code: "custom",
        path: ["supersession"],
        message: "summary supersession and causation must match the complete linear chain",
      });
    }
    const resultTargets = new Set<string>();
    for (const [index, result] of value.executionResults.entries()) {
      if (
        resultTargets.has(result.targetAgentId) ||
        result.projectId !== value.summary.projectId ||
        result.directiveId !== value.summary.id ||
        !value.summary.targetAgentIds.includes(result.targetAgentId) ||
        result.causationId !== value.summary.carrierMessageId ||
        result.correlationId !== value.summary.correlationId
      ) {
        context.addIssue({
          code: "custom",
          path: ["executionResults", index],
          message: "execution result provenance does not match directive causation and audience",
        });
      }
      resultTargets.add(result.targetAgentId);
    }
    let previousSequence = 0;
    const eventIds = new Set<string>();
    const terminalEventsByDirective = new Map<string, number>();
    for (const [index, event] of value.timeline.entries()) {
      const isSuccessorTerminalEvent =
        event.eventType === "DIRECTIVE_SUPERSEDED" || event.eventType === "DIRECTIVE_DOWNGRADED";
      const directiveNodeIndex =
        event.aggregateKind === "DIRECTIVE" && event.directiveId !== null
          ? value.supersession.nodes.findIndex((node) => node.directiveId === event.directiveId)
          : -1;
      const directiveNode = value.supersession.nodes[directiveNodeIndex];
      const directiveSuccessor = value.supersession.nodes[directiveNodeIndex + 1];
      if (isSuccessorTerminalEvent && event.directiveId !== null) {
        terminalEventsByDirective.set(
          event.directiveId,
          (terminalEventsByDirective.get(event.directiveId) ?? 0) + 1,
        );
      }
      const directiveEventInvalid =
        event.aggregateKind === "DIRECTIVE" &&
        (directiveNode === undefined ||
          (isSuccessorTerminalEvent
            ? directiveSuccessor === undefined ||
              event.correlationId !== directiveSuccessor.correlationId ||
              event.causationId !== directiveSuccessor.directiveId ||
              event.fromLifecycle !== "ACTIVE" ||
              event.toLifecycle !== "SUPERSEDED" ||
              event.serverSequence <= directiveNode.serverSequence ||
              event.serverSequence >= directiveSuccessor.serverSequence
            : event.correlationId !== directiveNode.correlationId));
      if (
        eventIds.has(event.eventId) ||
        event.projectId !== value.summary.projectId ||
        event.serverSequence <= previousSequence ||
        directiveEventInvalid
      ) {
        context.addIssue({
          code: "custom",
          path: ["timeline", index],
          message:
            "timeline provenance is duplicated, unordered, outside the chain, or has mismatched successor causation/correlation",
        });
      }
      previousSequence = event.serverSequence;
      eventIds.add(event.eventId);
    }
    value.supersession.nodes.forEach((node, index) => {
      const expectedTerminalCount = index < value.supersession.nodes.length - 1 ? 1 : 0;
      if ((terminalEventsByDirective.get(node.directiveId) ?? 0) !== expectedTerminalCount) {
        context.addIssue({
          code: "custom",
          path: ["timeline"],
          message:
            "every superseded directive must have exactly one successor-bound terminal event and the current directive must have none",
        });
      }
    });
  });
export type AuthorityDirectiveProvenance = z.infer<typeof AuthorityDirectiveProvenanceSchema>;

export const DowngradeAuthorityDirectiveInputSchema = z
  .object({
    expected_authority: SignedDirectiveAuthoritySchema,
    expected_lifecycle: z.literal("ACTIVE"),
    expected_server_sequence: z.number().int().positive(),
    reason: z.string().min(1).max(4000),
    idempotency_key: z.string().min(1).max(300),
  })
  .strict();
export type DowngradeAuthorityDirectiveInput = z.infer<
  typeof DowngradeAuthorityDirectiveInputSchema
>;

// Compile-time guard: the descriptor vocabulary must remain a partition of the domain enum.
const authorityClassCoverage = {
  USER_DIRECT: true,
  USER_ATTESTED: true,
  USER_DELEGATED: true,
  AGENT_DECISION: true,
  AGENT_PROPOSAL: true,
  AGENT_HEARSAY: true,
} as const satisfies Record<z.infer<typeof AuthorityTypeSchema>, true>;
void authorityClassCoverage;
