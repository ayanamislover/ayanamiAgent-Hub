import { z } from "zod";
import {
  AuthorizationCapabilitySchema,
  AuthorizationStatusSchema,
  ConnectionStateSchema,
  DeliveryModeSchema,
  FindingSeveritySchema,
  MessagePrioritySchema,
  MessageTypeSchema,
  RecipientStateSchema,
  ReviewStatusSchema,
  TaskStatusSchema,
  ThreadStatusSchema,
  TodoStatusSchema,
  WorkStateSchema,
} from "./constants.js";
import { SessionTicketPurposeSchema, type SessionTicketPurpose } from "./authority.js";

export const IdSchema = z.string().min(4).max(128);
export const IsoDateSchema = z.iso.datetime({ offset: true });
export const CanonicalUtcIsoDateSchema = IsoDateSchema.refine(
  (value) => new Date(value).toISOString() === value,
  "timestamp must use canonical UTC ISO format",
);
export const JsonValueSchema: z.ZodType<unknown> = z.unknown();
export const StringArraySchema = z.array(z.string().max(2048)).default([]);
const ExternalIdentitySchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => value === value.trim(), {
    message: "external identity must not contain leading or trailing whitespace",
  });
const LowerHexSha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const AdapterClientTypeSchema = z.enum(["codex", "claude"]);
export type AdapterClientType = z.infer<typeof AdapterClientTypeSchema>;

export const AdapterSessionClientSchema = z.enum([
  "codex-app-server",
  "codex-cli-hooks",
  "claude-channel",
  "claude-hooks",
]);
export type AdapterSessionClient = z.infer<typeof AdapterSessionClientSchema>;

/**
 * One source of truth for atomic Adapter capability bundles. Offer, activation, rotation and each
 * Adapter's local ticket store must all use this exact matrix; duplicated lists fail closed in
 * incompatible ways and can strand a live session at renewal time.
 */
export const SESSION_TICKET_PURPOSES_BY_CLIENT = {
  "codex-app-server": ["CONTROL", "MODEL_MCP", "INJECTOR"],
  "codex-cli-hooks": ["CONTROL", "CAPTURE"],
  "claude-channel": ["CONTROL"],
  "claude-hooks": ["CONTROL", "CAPTURE"],
} as const satisfies Record<AdapterSessionClient, readonly SessionTicketPurpose[]>;

/** Hook capture provenance is immutable per Hub session, so Hooks renew by session replacement. */
export const SESSION_TICKET_AUXILIARY_CLIENTS = [
  "codex-app-server",
  "claude-channel",
] as const satisfies readonly AdapterSessionClient[];

export const SessionTicketActivationModeSchema = z.enum([
  "FIRST_LINEAGE",
  "CURRENT_HEAD_REPLACEMENT",
  "MANAGED_RESERVATION",
  "SESSION_AUXILIARY",
]);
export type SessionTicketActivationMode = z.infer<typeof SessionTicketActivationModeSchema>;

export const ProjectSchema = z.object({
  id: IdSchema,
  name: z.string().min(1).max(200),
  defaultBranch: z.string().max(512).nullable(),
  activeObjectiveId: IdSchema.nullable(),
  config: z.record(z.string(), z.unknown()),
  version: z.number().int().nonnegative(),
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema,
});
export type Project = z.infer<typeof ProjectSchema>;

export const AgentSessionSchema = z.object({
  id: IdSchema,
  projectId: IdSchema,
  agentId: z.string().min(1).max(100),
  role: z.enum(["primary", "reviewer", "observer"]),
  client: z.enum([
    "codex-app-server",
    "codex-cli-hooks",
    "claude-channel",
    "claude-hooks",
    "fake-client",
  ]),
  transport: z.enum(["websocket", "hook-poll"]),
  deliveryMode: DeliveryModeSchema,
  externalSessionId: z.string().nullable(),
  externalThreadId: z.string().nullable(),
  externalTurnId: z.string().nullable(),
  host: z.string(),
  pid: z.number().int().positive().nullable(),
  cwd: z.string(),
  gitBranch: z.string().nullable(),
  gitHead: z.string().nullable(),
  capabilities: StringArraySchema,
  connectedAt: IsoDateSchema,
  transportLastSeenAt: IsoDateSchema,
  activityLastSeenAt: IsoDateSchema.nullable(),
  currentTaskId: IdSchema.nullable(),
  currentReviewId: IdSchema.nullable(),
  activeFiles: StringArraySchema,
  workState: WorkStateSchema,
  connectionState: ConnectionStateSchema,
  queueDepth: z.number().int().nonnegative(),
  lineageId: IdSchema.nullable(),
  incarnation: z.number().int().positive().nullable(),
  predecessorSessionId: IdSchema.nullable(),
  supersededBySessionId: IdSchema.nullable(),
  launcherRunId: IdSchema.nullable(),
  launchGeneration: z.number().int().positive().nullable(),
  version: z.number().int().nonnegative(),
});
export type AgentSession = z.infer<typeof AgentSessionSchema>;

export const ObjectiveSchema = z.object({
  id: IdSchema,
  projectId: IdSchema,
  title: z.string().min(1).max(300),
  description: z.string().default(""),
  definitionOfDone: StringArraySchema,
  status: z.enum(["PLANNED", "ACTIVE", "COMPLETED", "CANCELLED"]),
  weight: z.number().positive().default(1),
  version: z.number().int().nonnegative(),
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema,
});
export type Objective = z.infer<typeof ObjectiveSchema>;

export const MilestoneSchema = z.object({
  id: IdSchema,
  projectId: IdSchema,
  objectiveId: IdSchema,
  title: z.string().min(1).max(300),
  description: z.string().default(""),
  sortOrder: z.number().int(),
  weight: z.number().positive(),
  status: z.enum(["PLANNED", "ACTIVE", "COMPLETED", "CANCELLED"]),
  version: z.number().int().nonnegative(),
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema,
});
export type Milestone = z.infer<typeof MilestoneSchema>;

export const TaskSchema = z.object({
  id: IdSchema,
  projectId: IdSchema,
  objectiveId: IdSchema,
  milestoneId: IdSchema.nullable(),
  parentTaskId: IdSchema.nullable(),
  title: z.string().min(1).max(400),
  description: z.string().default(""),
  status: TaskStatusSchema,
  priority: z.enum(["low", "normal", "high", "critical"]),
  ownerAgentId: z.string().nullable(),
  ownerSessionId: IdSchema.nullable(),
  reviewerAgentId: z.string().nullable(),
  capabilityTags: StringArraySchema,
  scopeGlobs: StringArraySchema,
  protectedScope: z.boolean(),
  reviewRequired: z.boolean(),
  dependsOn: StringArraySchema,
  blockedReason: z.string().nullable(),
  waitingFor: z.string().nullable(),
  baseSha: z.string().nullable(),
  headSha: z.string().nullable(),
  selfReportedSummary: z.string().nullable(),
  agentEstimate: z.number().min(0).max(100).nullable(),
  computedProgress: z.number().min(0).max(100),
  weight: z.number().positive(),
  claimStaleAt: IsoDateSchema.nullable(),
  version: z.number().int().nonnegative(),
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema,
});
export type Task = z.infer<typeof TaskSchema>;

export const TodoItemSchema = z.object({
  id: IdSchema,
  taskId: IdSchema,
  title: z.string().min(1).max(400),
  description: z.string().nullable(),
  type: z.enum(["implementation", "test", "documentation", "validation", "review"]),
  status: TodoStatusSchema,
  weight: z.number().positive(),
  evidenceRequired: z.boolean(),
  evidence: z.array(z.record(z.string(), z.unknown())).default([]),
  completedBySessionId: IdSchema.nullable(),
  completedAt: IsoDateSchema.nullable(),
  version: z.number().int().nonnegative(),
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema,
});
export type TodoItem = z.infer<typeof TodoItemSchema>;

export const MessageRecipientSchema = z.object({
  id: IdSchema,
  messageId: IdSchema,
  recipientAgentId: z.string(),
  recipientSessionId: IdSchema.nullable(),
  state: RecipientStateSchema,
  deliveredAt: IsoDateSchema.nullable(),
  acknowledgedAt: IsoDateSchema.nullable(),
  processedAt: IsoDateSchema.nullable(),
  respondedAt: IsoDateSchema.nullable(),
  attemptCount: z.number().int().nonnegative(),
  lastError: z.string().nullable(),
  surfaceFence: z.number().int().nonnegative().optional(),
});
export type MessageRecipient = z.infer<typeof MessageRecipientSchema>;

export const MessageSurfaceAttemptStateSchema = z.enum([
  "ACTIVE",
  "CONFIRMED",
  "ABORTED",
  "AMBIGUOUS",
]);
export type MessageSurfaceAttemptState = z.infer<typeof MessageSurfaceAttemptStateSchema>;

export const MessageSurfacePermitSchema = z.object({
  id: IdSchema,
  messageId: IdSchema,
  recipientId: IdSchema,
  sessionId: IdSchema,
  sessionIncarnation: z.number().int().nonnegative(),
  recipientFence: z.number().int().positive(),
  state: MessageSurfaceAttemptStateSchema,
  error: z.string().nullable(),
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema,
  confirmedAt: IsoDateSchema.nullable(),
});
export type MessageSurfacePermit = z.infer<typeof MessageSurfacePermitSchema>;

export const CrossAgentMessageSchema = z.object({
  id: IdSchema,
  projectId: IdSchema,
  sequence: z.number().int().positive(),
  threadId: IdSchema,
  replyTo: IdSchema.nullable(),
  taskId: IdSchema.nullable(),
  reviewId: IdSchema.nullable(),
  fromAgentId: z.string(),
  fromSessionId: IdSchema.nullable(),
  type: MessageTypeSchema,
  priority: MessagePrioritySchema,
  requiresAck: z.boolean(),
  requiresResponse: z.boolean(),
  summary: z.string().min(1).max(1600),
  detail: JsonValueSchema.nullable(),
  references: z.array(z.record(z.string(), z.unknown())).default([]),
  dedupeKey: z.string().max(300).nullable(),
  expiresAt: IsoDateSchema.nullable(),
  createdAt: IsoDateSchema,
  recipients: z.array(MessageRecipientSchema).default([]),
});
export type CrossAgentMessage = z.infer<typeof CrossAgentMessageSchema>;

export const ThreadSchema = z.object({
  id: IdSchema,
  projectId: IdSchema,
  subject: z.string().min(1).max(400),
  status: ThreadStatusSchema,
  taskId: IdSchema.nullable(),
  reviewId: IdSchema.nullable(),
  waitingForAgentId: z.string().nullable(),
  proposalRounds: z.number().int().nonnegative(),
  objectionRounds: z.number().int().nonnegative(),
  version: z.number().int().nonnegative(),
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema,
});
export type Thread = z.infer<typeof ThreadSchema>;

export const WriteIntentSchema = z.object({
  id: IdSchema,
  projectId: IdSchema,
  taskId: IdSchema,
  sessionId: IdSchema,
  globs: StringArraySchema,
  symbols: StringArraySchema,
  mode: z.enum(["advisory", "exclusive"]),
  reason: z.string().min(1).max(1000),
  observedChangedFiles: StringArraySchema,
  expiresAt: IsoDateSchema,
  releasedAt: IsoDateSchema.nullable(),
  version: z.number().int().nonnegative(),
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema,
});
export type WriteIntent = z.infer<typeof WriteIntentSchema>;

export const ReviewBundleSchema = z.object({
  id: IdSchema,
  projectId: IdSchema,
  taskId: IdSchema,
  revision: z.number().int().positive(),
  authorAgentId: z.string(),
  authorSessionId: IdSchema,
  reviewerAgentId: z.string(),
  baseSha: z.string(),
  headSha: z.string(),
  patchSha256: z.string(),
  patchArtifactId: IdSchema,
  changedFiles: z.array(z.record(z.string(), z.unknown())),
  acceptanceCriteria: StringArraySchema,
  testEvidence: z.array(z.record(z.string(), z.unknown())),
  authorClaims: StringArraySchema,
  knownRisks: StringArraySchema,
  status: ReviewStatusSchema,
  verdictSummary: z.string().nullable(),
  version: z.number().int().nonnegative(),
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema,
});
export type ReviewBundle = z.infer<typeof ReviewBundleSchema>;

export const ReviewFindingSchema = z.object({
  id: IdSchema,
  reviewId: IdSchema,
  severity: FindingSeveritySchema,
  category: z.enum([
    "correctness",
    "regression",
    "security",
    "concurrency",
    "performance",
    "maintainability",
    "test_gap",
    "scope",
  ]),
  title: z.string().min(1).max(300),
  claim: z.string().min(1),
  impact: z.string().min(1),
  filePath: z.string().nullable(),
  lineStart: z.number().int().positive().nullable(),
  lineEnd: z.number().int().positive().nullable(),
  symbol: z.string().nullable(),
  evidence: z.array(z.record(z.string(), z.unknown())),
  suggestedDirection: z.string().nullable(),
  status: z.enum(["OPEN", "ACCEPTED", "DISPUTED", "FIXED", "VERIFIED", "WONT_FIX"]),
  blocking: z.boolean(),
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema,
});
export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;

export const DomainEventSchema = z.object({
  id: IdSchema,
  projectId: IdSchema,
  sequence: z.number().int().positive(),
  type: z.string(),
  actorType: z.enum(["agent", "user", "system"]),
  actorId: z.string(),
  aggregateType: z.string(),
  aggregateId: IdSchema,
  causationId: z.string().nullable(),
  correlationId: z.string().nullable(),
  payload: JsonValueSchema,
  createdAt: IsoDateSchema,
});
export type DomainEvent = z.infer<typeof DomainEventSchema>;

export const JoinProjectInputSchema = z.object({
  cwd: z.string().min(1),
  name: z.string().min(1).max(200).optional(),
  allowCreate: z.boolean().default(false),
});

/**
 * Ticket secrets are generated and retained by the Adapter. Enrollment sends only the digest and
 * binding facts; a raw ticket has no valid field in this wire contract.
 */
export const SessionTicketOfferInputSchema = z
  .object({
    bundle_id: IdSchema,
    purpose: SessionTicketPurposeSchema,
    token_sha256: LowerHexSha256Schema,
    adapter_client: AdapterClientTypeSchema,
    agent_id: AdapterClientTypeSchema,
    session_client: AdapterSessionClientSchema,
    role: AgentSessionSchema.shape.role,
    transport: AgentSessionSchema.shape.transport,
    delivery_mode: DeliveryModeSchema,
    external_session_id: ExternalIdentitySchema.nullable().default(null),
    external_thread_id: ExternalIdentitySchema.nullable().default(null),
    run_id: IdSchema,
    activation_mode: SessionTicketActivationModeSchema,
    expected_lineage_id: IdSchema.optional(),
    expected_head_session_id: IdSchema.nullable().optional(),
    launch_reservation_id: IdSchema.optional(),
    idempotency_key: z.string().min(1).max(300),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.agent_id !== input.adapter_client) {
      context.addIssue({
        code: "custom",
        path: ["agent_id"],
        message: "agent_id must equal adapter_client",
      });
    }
    const expectedFamily = input.session_client.startsWith("codex-") ? "codex" : "claude";
    if (expectedFamily !== input.adapter_client) {
      context.addIssue({
        code: "custom",
        path: ["session_client"],
        message: "session_client must belong to adapter_client",
      });
    }
    const hasLineage = input.expected_lineage_id !== undefined;
    const hasHead = input.expected_head_session_id !== undefined;
    const hasNonNullHead = typeof input.expected_head_session_id === "string";
    const hasReservation = input.launch_reservation_id !== undefined;
    const requireField = (present: boolean, field: string, mode: string) => {
      if (!present) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: `${field} is required for ${mode}`,
        });
      }
    };
    const forbidField = (present: boolean, field: string, mode: string) => {
      if (present) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: `${field} is not allowed for ${mode}`,
        });
      }
    };
    if (input.activation_mode === "FIRST_LINEAGE") {
      forbidField(hasLineage, "expected_lineage_id", input.activation_mode);
      forbidField(hasHead, "expected_head_session_id", input.activation_mode);
      forbidField(hasReservation, "launch_reservation_id", input.activation_mode);
    } else if (input.activation_mode === "MANAGED_RESERVATION") {
      requireField(hasLineage, "expected_lineage_id", input.activation_mode);
      requireField(hasHead, "expected_head_session_id", input.activation_mode);
      requireField(hasReservation, "launch_reservation_id", input.activation_mode);
    } else {
      requireField(hasLineage, "expected_lineage_id", input.activation_mode);
      requireField(hasNonNullHead, "expected_head_session_id", input.activation_mode);
      forbidField(hasReservation, "launch_reservation_id", input.activation_mode);
    }
  });
export type SessionTicketOfferInput = z.input<typeof SessionTicketOfferInputSchema>;

export const SessionTicketOfferSchema = z
  .object({
    id: IdSchema,
    bundle_id: IdSchema,
    purpose: SessionTicketPurposeSchema,
    state: z.literal("PENDING"),
    project_id: IdSchema,
    adapter_client: AdapterClientTypeSchema,
    agent_id: AdapterClientTypeSchema,
    session_client: AdapterSessionClientSchema,
    role: AgentSessionSchema.shape.role,
    transport: AgentSessionSchema.shape.transport,
    delivery_mode: DeliveryModeSchema,
    external_session_id: ExternalIdentitySchema.nullable(),
    external_thread_id: ExternalIdentitySchema.nullable(),
    run_id: IdSchema,
    offer_expires_at: CanonicalUtcIsoDateSchema,
  })
  .strict()
  .superRefine((offer, context) => {
    if (offer.agent_id !== offer.adapter_client) {
      context.addIssue({
        code: "custom",
        path: ["agent_id"],
        message: "agent_id must equal adapter_client",
      });
    }
    const expectedFamily = offer.session_client.startsWith("codex-") ? "codex" : "claude";
    if (expectedFamily !== offer.adapter_client) {
      context.addIssue({
        code: "custom",
        path: ["session_client"],
        message: "session_client must belong to adapter_client",
      });
    }
  });
export type SessionTicketOffer = z.infer<typeof SessionTicketOfferSchema>;

export const RegisterSessionInputSchema = z
  .object({
    projectId: IdSchema,
    agentId: z.string().min(1).max(100),
    role: z.enum(["primary", "reviewer", "observer"]).default("primary"),
    client: AgentSessionSchema.shape.client,
    transport: AgentSessionSchema.shape.transport,
    deliveryMode: DeliveryModeSchema,
    externalSessionId: ExternalIdentitySchema.optional(),
    externalThreadId: ExternalIdentitySchema.optional(),
    externalTurnId: z.string().optional(),
    host: z.string().min(1),
    pid: z.number().int().positive().optional(),
    cwd: z.string().min(1),
    gitBranch: z.string().optional(),
    gitHead: z.string().optional(),
    capabilities: StringArraySchema,
    /**
     * A logical worker that prepared its registration against an older head must not be allowed to
     * reverse-supersede the committed successor merely because its HTTP request arrived last.
     *
     * Omitted remains a compatibility path for adapters that do not yet participate in lineage CAS.
     * Current Bridge callers always send either the observed head id or null.
     */
    expectedHeadSessionId: IdSchema.nullable().optional(),
    /** Stable launcher identity issued before a managed child is spawned. */
    launcherRunId: IdSchema.optional(),
    /** Caller copy used only as a consistency check; Hub reloads the authoritative reservation. */
    launchGeneration: z.number().int().positive().optional(),
  })
  .superRefine((input, context) => {
    const hasLauncherField =
      input.launcherRunId !== undefined || input.launchGeneration !== undefined;
    if (
      hasLauncherField &&
      (input.launcherRunId === undefined ||
        input.launchGeneration === undefined ||
        input.expectedHeadSessionId === undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["launcherRunId"],
        message:
          "launcherRunId, launchGeneration, and expectedHeadSessionId must be provided together",
      });
    }
  });

/**
 * Real Adapters register through a pre-offered ticket bundle. The CONTROL raw token authenticates
 * the HTTP request; only the bundle id is serialized in the request body.
 */
export const RegisterAdapterSessionInputSchema = RegisterSessionInputSchema.safeExtend({
  client: AdapterSessionClientSchema,
  ticket_bundle_id: IdSchema,
  idempotencyKey: z.string().min(1).max(300),
}).strict();
export type RegisterAdapterSessionInput = z.input<typeof RegisterAdapterSessionInputSchema>;

/**
 * A ticketed Adapter close is replayable: Hook SessionEnd keeps its local raw tickets until the
 * Hub returns the terminal binding receipt for this exact idempotency key.
 */
export const CloseAdapterSessionInputSchema = z
  .object({
    reason: z.string().min(1).max(500),
    idempotencyKey: z.string().min(1).max(300),
  })
  .strict();
export type CloseAdapterSessionInput = z.input<typeof CloseAdapterSessionInputSchema>;

/** Rotate an exact capability bundle onto an existing current-head session. */
export const RotateAdapterSessionTicketsInputSchema = z
  .object({ idempotencyKey: z.string().min(1).max(300) })
  .strict();
export type RotateAdapterSessionTicketsInput = z.input<
  typeof RotateAdapterSessionTicketsInputSchema
>;

export const SessionTicketBindingSchema = z
  .object({
    bundleId: IdSchema,
    state: z.literal("ACTIVE"),
    projectId: IdSchema,
    agentId: AdapterClientTypeSchema,
    adapterClient: AdapterClientTypeSchema,
    hubSessionId: IdSchema,
    lineageId: IdSchema.nullable(),
    incarnation: z.number().int().positive().nullable(),
    runId: IdSchema,
    activatedAt: CanonicalUtcIsoDateSchema,
    expiresAt: CanonicalUtcIsoDateSchema,
    purposes: z
      .array(
        z
          .object({
            id: IdSchema,
            purpose: SessionTicketPurposeSchema,
            state: z.literal("ACTIVE"),
          })
          .strict(),
      )
      .min(1)
      .max(4),
  })
  .strict()
  .superRefine((binding, context) => {
    if (binding.agentId !== binding.adapterClient) {
      context.addIssue({
        code: "custom",
        path: ["agentId"],
        message: "agentId must equal adapterClient",
      });
    }
    if (new Set(binding.purposes.map((entry) => entry.purpose)).size !== binding.purposes.length) {
      context.addIssue({
        code: "custom",
        path: ["purposes"],
        message: "ticket binding purposes must be unique",
      });
    }
    if (!binding.purposes.some((entry) => entry.purpose === "CONTROL")) {
      context.addIssue({
        code: "custom",
        path: ["purposes"],
        message: "an activated Adapter ticket binding must contain CONTROL",
      });
    }
  });
export type SessionTicketBinding = z.infer<typeof SessionTicketBindingSchema>;

export const TerminalSessionTicketStateSchema = z.enum(["REVOKED", "EXPIRED", "SUPERSEDED"]);
export type TerminalSessionTicketState = z.infer<typeof TerminalSessionTicketStateSchema>;

const TerminalSessionTicketPurposeSchema = z
  .object({
    id: IdSchema,
    purpose: SessionTicketPurposeSchema,
    state: TerminalSessionTicketStateSchema,
    terminalAt: CanonicalUtcIsoDateSchema,
    terminalReason: z.string().min(1).max(1000),
  })
  .strict();

/**
 * Secret-free proof that every purpose in the current session bundle reached one atomic terminal
 * state. Historical bundles are intentionally outside this receipt.
 */
export const TerminalSessionTicketBindingSchema = z
  .object({
    bundleId: IdSchema,
    state: TerminalSessionTicketStateSchema,
    projectId: IdSchema,
    agentId: AdapterClientTypeSchema,
    adapterClient: AdapterClientTypeSchema,
    hubSessionId: IdSchema,
    lineageId: IdSchema.nullable(),
    incarnation: z.number().int().positive().nullable(),
    runId: IdSchema,
    activatedAt: CanonicalUtcIsoDateSchema,
    expiresAt: CanonicalUtcIsoDateSchema,
    terminalAt: CanonicalUtcIsoDateSchema,
    terminalReason: z.string().min(1).max(1000),
    purposes: z.array(TerminalSessionTicketPurposeSchema).min(1).max(4),
  })
  .strict()
  .superRefine((binding, context) => {
    if (binding.agentId !== binding.adapterClient) {
      context.addIssue({
        code: "custom",
        path: ["agentId"],
        message: "agentId must equal adapterClient",
      });
    }
    if (new Set(binding.purposes.map((entry) => entry.purpose)).size !== binding.purposes.length) {
      context.addIssue({
        code: "custom",
        path: ["purposes"],
        message: "terminal ticket binding purposes must be unique",
      });
    }
    if (!binding.purposes.some((entry) => entry.purpose === "CONTROL")) {
      context.addIssue({
        code: "custom",
        path: ["purposes"],
        message: "a terminal Adapter ticket binding must contain CONTROL",
      });
    }
    for (const [index, entry] of binding.purposes.entries()) {
      if (
        entry.state !== binding.state ||
        entry.terminalAt !== binding.terminalAt ||
        entry.terminalReason !== binding.terminalReason
      ) {
        context.addIssue({
          code: "custom",
          path: ["purposes", index],
          message: "each ticket purpose must match the atomic terminal bundle receipt",
        });
      }
    }
  });
export type TerminalSessionTicketBinding = z.infer<typeof TerminalSessionTicketBindingSchema>;

function validateAdapterTicketSessionIdentity(
  binding: {
    projectId: string;
    agentId: string;
    adapterClient: string;
    hubSessionId: string;
    lineageId: string | null;
    incarnation: number | null;
    purposes: ReadonlyArray<{ purpose: SessionTicketPurpose }>;
  },
  session: AgentSession,
  context: z.RefinementCtx,
): void {
  if (!AdapterSessionClientSchema.safeParse(session.client).success) {
    context.addIssue({
      code: "custom",
      path: ["session", "client"],
      message: "ticket lifecycle requires a real Adapter client",
    });
    return;
  }
  const sessionClientType = session.client.startsWith("codex-") ? "codex" : "claude";
  const mismatches: Array<[string, boolean]> = [
    ["projectId", binding.projectId !== session.projectId],
    ["agentId", binding.agentId !== session.agentId],
    ["adapterClient", binding.adapterClient !== sessionClientType],
    ["hubSessionId", binding.hubSessionId !== session.id],
    ["lineageId", binding.lineageId !== session.lineageId],
    ["incarnation", binding.incarnation !== session.incarnation],
  ];
  for (const [field, mismatched] of mismatches) {
    if (mismatched) {
      context.addIssue({
        code: "custom",
        path: ["ticketBinding", field],
        message: `${field} must match the Hub session`,
      });
    }
  }
  if (!(session.client in SESSION_TICKET_PURPOSES_BY_CLIENT)) {
    context.addIssue({
      code: "custom",
      path: ["session", "client"],
      message: "ticket bindings require a real Adapter session client",
    });
    return;
  }
  const requiredPurposes = SESSION_TICKET_PURPOSES_BY_CLIENT[
    session.client as AdapterSessionClient
  ] as readonly SessionTicketPurpose[];
  const actualPurposes = new Set(binding.purposes.map((entry) => entry.purpose));
  if (
    actualPurposes.size !== requiredPurposes.length ||
    requiredPurposes.some((purpose) => !actualPurposes.has(purpose))
  ) {
    context.addIssue({
      code: "custom",
      path: ["ticketBinding", "purposes"],
      message: "ticket binding purposes must exactly match the Adapter client",
    });
  }
}

export const RegisterAdapterSessionResultSchema = z
  .object({
    session: AgentSessionSchema.strict(),
    ticketBinding: SessionTicketBindingSchema,
    /** Fresh Hub response time; unlike the idempotent ticket receipt, this advances on replay. */
    serverNow: CanonicalUtcIsoDateSchema,
  })
  .strict()
  .superRefine((result, context) => {
    validateAdapterTicketSessionIdentity(result.ticketBinding, result.session, context);
  });
export type RegisterAdapterSessionResult = z.infer<typeof RegisterAdapterSessionResultSchema>;

export const CloseAdapterSessionResultSchema = z
  .object({
    session: AgentSessionSchema.strict(),
    ticketBinding: TerminalSessionTicketBindingSchema,
  })
  .strict()
  .superRefine((result, context) => {
    validateAdapterTicketSessionIdentity(result.ticketBinding, result.session, context);
  });
export type CloseAdapterSessionResult = z.infer<typeof CloseAdapterSessionResultSchema>;

export const RotateAdapterSessionTicketsResultSchema = z
  .object({
    session: AgentSessionSchema.strict(),
    ticketBinding: SessionTicketBindingSchema,
    supersededTicketBinding: TerminalSessionTicketBindingSchema,
    /** Fresh Hub response time; clients use it to measure the unchanged ticket's remaining TTL. */
    serverNow: CanonicalUtcIsoDateSchema,
  })
  .strict()
  .superRefine((result, context) => {
    validateAdapterTicketSessionIdentity(result.ticketBinding, result.session, context);
    validateAdapterTicketSessionIdentity(result.supersededTicketBinding, result.session, context);
    if (result.ticketBinding.bundleId === result.supersededTicketBinding.bundleId) {
      context.addIssue({
        code: "custom",
        path: ["supersededTicketBinding", "bundleId"],
        message: "ticket rotation must replace a distinct predecessor bundle",
      });
    }
    if (result.supersededTicketBinding.state !== "SUPERSEDED") {
      context.addIssue({
        code: "custom",
        path: ["supersededTicketBinding", "state"],
        message: "ticket rotation predecessor must be SUPERSEDED",
      });
    }
  });
export type RotateAdapterSessionTicketsResult = z.infer<
  typeof RotateAdapterSessionTicketsResultSchema
>;

export const SessionLineageHeadQuerySchema = z.object({
  agentId: z.string().min(1).max(100),
  client: AgentSessionSchema.shape.client,
  deliveryMode: DeliveryModeSchema,
  externalThreadId: ExternalIdentitySchema.optional(),
  externalSessionId: ExternalIdentitySchema.optional(),
});

export const SessionLineageHeadSchema = z.object({
  lineageId: IdSchema,
  headSessionId: IdSchema,
  headIncarnation: z.number().int().positive(),
  version: z.number().int().positive(),
});
export type SessionLineageHead = z.infer<typeof SessionLineageHeadSchema>;

export const ReserveSessionLaunchInputSchema = z
  .object({
    agentId: z.string().min(1).max(100),
    client: AgentSessionSchema.shape.client,
    deliveryMode: DeliveryModeSchema,
    externalThreadId: ExternalIdentitySchema.optional(),
    externalSessionId: ExternalIdentitySchema.optional(),
    runId: IdSchema,
    idempotencyKey: z.string().min(1).max(300),
  })
  .superRefine((input, context) => {
    if (!input.externalThreadId && !input.externalSessionId) {
      context.addIssue({
        code: "custom",
        path: ["externalThreadId"],
        message: "externalThreadId or externalSessionId is required",
      });
    }
  });

export const SessionLaunchReservationSchema = z
  .object({
    id: IdSchema,
    projectId: IdSchema,
    lineageId: IdSchema,
    agentId: z.string().min(1).max(100),
    client: AgentSessionSchema.shape.client,
    deliveryMode: DeliveryModeSchema,
    identityKind: z.enum(["external_thread", "external_session"]),
    identityValue: ExternalIdentitySchema,
    runId: IdSchema,
    generation: z.number().int().positive(),
    expectedHeadSessionId: IdSchema.nullable(),
    state: z.enum(["ISSUED", "CONSUMED", "SUPERSEDED"]),
    consumedSessionId: IdSchema.nullable(),
    createdAt: IsoDateSchema,
    updatedAt: IsoDateSchema,
  })
  .superRefine((reservation, context) => {
    const consumed = reservation.consumedSessionId !== null;
    if ((reservation.state === "CONSUMED") !== consumed) {
      context.addIssue({
        code: "custom",
        path: ["consumedSessionId"],
        message: "consumedSessionId is required only when the launch reservation state is CONSUMED",
      });
    }
  });
export type SessionLaunchReservation = z.infer<typeof SessionLaunchReservationSchema>;

export const HeartbeatInputSchema = z
  .object({
    sessionId: IdSchema,
    sequence: z.number().int().nonnegative(),
    sentAt: IsoDateSchema.optional(),
    workState: WorkStateSchema,
    currentTaskId: IdSchema.optional().nullable(),
    currentReviewId: IdSchema.optional().nullable(),
    currentTurnId: z.string().optional().nullable(),
    gitHead: z.string().optional().nullable(),
    activeFiles: StringArraySchema,
    queueDepth: z.number().int().nonnegative().default(0),
  })
  .strict();

export const CreateObjectiveInputSchema = z.object({
  title: z.string().min(1).max(300),
  description: z.string().default(""),
  definitionOfDone: StringArraySchema,
  status: z.enum(["PLANNED", "ACTIVE"]).default("ACTIVE"),
});

export const CreateMilestoneInputSchema = z.object({
  objectiveId: IdSchema,
  title: z.string().min(1).max(300),
  description: z.string().default(""),
  sortOrder: z.number().int().default(0),
  weight: z.number().positive().default(1),
});

export const CreateTaskInputSchema = z.object({
  objectiveId: IdSchema,
  milestoneId: IdSchema.optional().nullable(),
  parentTaskId: IdSchema.optional().nullable(),
  title: z.string().min(1).max(400),
  description: z.string().default(""),
  status: TaskStatusSchema.default("BACKLOG"),
  priority: z.enum(["low", "normal", "high", "critical"]).default("normal"),
  reviewerAgentId: z.string().optional().nullable(),
  capabilityTags: StringArraySchema,
  scopeGlobs: StringArraySchema,
  protectedScope: z.boolean().default(false),
  reviewRequired: z.boolean().default(true),
  dependsOn: StringArraySchema,
  weight: z.number().positive().default(1),
  idempotencyKey: z.string().min(1).max(300),
});

export const UpdateTaskInputSchema = z.object({
  expectedVersion: z.number().int().nonnegative(),
  status: TaskStatusSchema.optional(),
  title: z.string().min(1).max(400).optional(),
  description: z.string().optional(),
  blockedReason: z.string().nullable().optional(),
  waitingFor: z.string().nullable().optional(),
  selfReportedSummary: z.string().nullable().optional(),
  agentEstimate: z.number().min(0).max(100).nullable().optional(),
  reviewerAgentId: z.string().nullable().optional(),
  scopeGlobs: StringArraySchema.optional(),
  capabilityTags: StringArraySchema.optional(),
  idempotencyKey: z.string().min(1).max(300),
});

export const ClaimTaskInputSchema = z.object({
  sessionId: IdSchema,
  expectedVersion: z.number().int().nonnegative(),
  takeoverStale: z.boolean().default(false),
  idempotencyKey: z.string().min(1).max(300),
});

export const CreateTodoInputSchema = z.object({
  title: z.string().min(1).max(400),
  description: z.string().optional(),
  type: z.enum(["implementation", "test", "documentation", "validation", "review"]),
  weight: z.number().positive().default(1),
  evidenceRequired: z.boolean().default(false),
  idempotencyKey: z.string().min(1).max(300),
});

export const UpdateTodoInputSchema = z.object({
  expectedVersion: z.number().int().nonnegative(),
  status: TodoStatusSchema,
  evidence: z.array(z.record(z.string(), z.unknown())).optional(),
  completedBySessionId: IdSchema.optional(),
  idempotencyKey: z.string().min(1).max(300),
});

export type MessageRecipientTarget = { agentId: string; sessionId?: string };

/**
 * A NULL target is agent-wide ownership, so it cannot coexist with another target for that agent.
 * Distinct explicit sessions remain a deliberate fan-out Interface.
 */
export function describeMessageRecipientConflict(
  recipients: readonly MessageRecipientTarget[],
): string | null {
  const targets = new Map<string, Set<string>>();
  for (const recipient of recipients) {
    const sessions = targets.get(recipient.agentId) ?? new Set<string>();
    const target = recipient.sessionId ?? "<agent-wide>";
    if (sessions.has(target)) {
      return `Duplicate recipient target for agent ${recipient.agentId}`;
    }
    if (target === "<agent-wide>" ? sessions.size > 0 : sessions.has("<agent-wide>")) {
      return `Agent-wide recipient cannot be mixed with another target for agent ${recipient.agentId}`;
    }
    sessions.add(target);
    targets.set(recipient.agentId, sessions);
  }
  return null;
}

export const PostMessageInputSchema = z
  .object({
    threadId: IdSchema.optional(),
    subject: z.string().max(400).optional(),
    replyTo: IdSchema.optional(),
    taskId: IdSchema.optional(),
    reviewId: IdSchema.optional(),
    fromAgentId: z.string().min(1),
    fromSessionId: IdSchema.optional(),
    recipients: z
      .array(
        z.object({
          agentId: z.string().min(1),
          sessionId: IdSchema.optional(),
        }),
      )
      .min(1),
    type: MessageTypeSchema,
    priority: MessagePrioritySchema.default("NORMAL"),
    requiresAck: z.boolean().default(false),
    requiresResponse: z.boolean().default(false),
    summary: z.string().min(1).max(1600),
    detail: JsonValueSchema.optional(),
    references: z.array(z.record(z.string(), z.unknown())).default([]),
    dedupeKey: z.string().max(300).optional(),
    expiresAt: IsoDateSchema.optional(),
    idempotencyKey: z.string().min(1).max(300),
  })
  .superRefine((value, ctx) => {
    const conflict = describeMessageRecipientConflict(value.recipients);
    if (conflict) {
      ctx.addIssue({
        code: "custom",
        path: ["recipients"],
        message: conflict,
      });
    }
  });

export const MessageStateInputSchema = z.object({
  sessionId: IdSchema,
  state: z.enum(["DELIVERED", "ACKNOWLEDGED", "PROCESSED", "RESPONDED", "FAILED"]),
  error: z.string().optional(),
  surfaceAttemptId: IdSchema.optional(),
  recipientFence: z.number().int().positive().optional(),
  idempotencyKey: z.string().min(1).max(300),
});

export const ClaimMessageRecipientInputSchema = z.object({
  sessionId: IdSchema,
  idempotencyKey: z.string().min(1).max(300),
});

export const BeginMessageSurfaceInputSchema = z.object({
  sessionId: IdSchema,
  idempotencyKey: z.string().min(1).max(300),
});

export const UpdateMessageSurfaceInputSchema = z.object({
  sessionId: IdSchema,
  state: z.enum(["ABORTED", "AMBIGUOUS"]),
  error: z.string().max(4000).optional(),
  idempotencyKey: z.string().min(1).max(300),
});

export const ReconcileOrdinaryMessageSurfaceInputSchema = z.object({
  sessionId: IdSchema,
  recipientFence: z.number().int().positive(),
  externalThreadId: ExternalIdentitySchema,
  idempotencyKey: z.string().min(1).max(300),
});

/** Agent sockets authenticate in-band so bearer material never enters URLs or proxy logs. */
export const ProjectSocketAuthenticateFrameSchema = z
  .object({
    type: z.literal("authenticate"),
    token: z
      .string()
      .min(1)
      .max(8192)
      .refine((value) => value.trim() === value && !/[\r\n]/u.test(value), {
        message: "socket bearer must not contain padding or line breaks",
      }),
  })
  .strict();
export type ProjectSocketAuthenticateFrame = z.infer<typeof ProjectSocketAuthenticateFrameSchema>;

export const ProjectSocketAuthenticatedFrameSchema = z
  .object({ type: z.literal("authenticated") })
  .strict();
export type ProjectSocketAuthenticatedFrame = z.infer<typeof ProjectSocketAuthenticatedFrameSchema>;

export const ProjectSocketDeliveryFrameSchema = z
  .object({
    type: z.literal("delivery"),
    messageId: IdSchema,
    state: z.enum(["DELIVERED", "ACKNOWLEDGED", "PROCESSED", "RESPONDED", "FAILED"]),
    attempt: z.number().int().nonnegative().optional(),
    error: z.string().max(4000).optional(),
    transport: z.string().min(1).max(100).optional(),
    surfaceAttemptId: IdSchema.optional(),
    recipientFence: z.number().int().positive().optional(),
    idempotencyKey: z.string().min(1).max(300).optional(),
  })
  .strict()
  .superRefine((frame, context) => {
    const hasAttempt = frame.surfaceAttemptId !== undefined;
    const hasFence = frame.recipientFence !== undefined;
    if (hasAttempt !== hasFence) {
      context.addIssue({
        code: "custom",
        path: hasAttempt ? ["recipientFence"] : ["surfaceAttemptId"],
        message: "surfaceAttemptId and recipientFence must be provided together",
      });
    }
    if ((hasAttempt || hasFence) && frame.state !== "DELIVERED") {
      context.addIssue({
        code: "custom",
        path: ["state"],
        message: "A surface permit can only confirm DELIVERED",
      });
    }
  });
export type ProjectSocketDeliveryFrame = z.infer<typeof ProjectSocketDeliveryFrameSchema>;

export const WriteIntentInputSchema = z.object({
  taskId: IdSchema,
  sessionId: IdSchema,
  globs: StringArraySchema,
  symbols: StringArraySchema,
  mode: z.enum(["advisory", "exclusive"]).default("advisory"),
  reason: z.string().min(1).max(1000),
  ttlSeconds: z.number().int().min(30).max(86400).default(600),
  idempotencyKey: z.string().min(1).max(300),
});

export const RequestReviewInputSchema = z.object({
  sessionId: IdSchema,
  reviewerAgentId: z.string().min(1),
  baseSha: z.string().min(4),
  headSha: z.string().min(4),
  acceptanceCriteria: StringArraySchema,
  testEvidence: z.array(z.record(z.string(), z.unknown())),
  authorClaims: StringArraySchema,
  knownRisks: StringArraySchema,
  includeUncommitted: z.boolean().default(false),
  idempotencyKey: z.string().min(1).max(300),
});

/**
 * Strict on purpose. `blocking` exists on ReviewFinding but is derived from
 * `severity === "blocking"`, and this input has no such field. Under a permissive object an unknown
 * key is stripped in silence, so a reviewer who sent `blocking: true` got HTTP 200 with the flag
 * discarded and went on believing they had filed a blocking finding -- which is exactly what
 * happened, and it took a peer reading the stored record to notice. Refusing the key names it in the
 * error; losing caller intent without saying so does not.
 */
export const CreateFindingInputSchema = z
  .object({
    sessionId: IdSchema,
    severity: FindingSeveritySchema,
    category: ReviewFindingSchema.shape.category,
    title: z.string().min(1).max(300),
    claim: z.string().min(1),
    impact: z.string().min(1),
    filePath: z.string().optional(),
    lineStart: z.number().int().positive().optional(),
    lineEnd: z.number().int().positive().optional(),
    symbol: z.string().optional(),
    evidence: z.array(z.record(z.string(), z.unknown())).default([]),
    suggestedDirection: z.string().optional(),
    idempotencyKey: z.string().min(1).max(300),
  })
  .strict();

export const ReviewVerdictInputSchema = z.object({
  sessionId: IdSchema,
  expectedVersion: z.number().int().nonnegative(),
  verdict: z.enum(["APPROVED", "CHANGES_REQUESTED"]),
  summary: z.string().min(1),
  overrideReason: z.string().optional(),
  idempotencyKey: z.string().min(1).max(300),
});

export const ContextPackRequestSchema = z.object({
  sessionId: IdSchema,
  taskId: IdSchema.optional(),
  files: StringArraySchema,
  symbols: StringArraySchema,
  maxChars: z.number().int().min(1000).max(50000).default(12000),
});

export const ProjectConfigSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  reviewRequiredByDefault: z.boolean().default(true),
  heartbeatIntervalSeconds: z.number().int().min(1).max(300).default(5),
  offlineAfterSeconds: z.number().int().min(5).max(3600).default(20),
  staleClaimAfterSeconds: z.number().int().min(15).max(86400).default(120),
  idleAfterSeconds: z.number().int().min(15).max(86400).default(60),
  wakePolicy: z
    .enum(["interrupt_only", "urgent_and_action_required", "never"])
    .default("urgent_and_action_required"),
  statusCoalesceWindowSeconds: z.number().int().min(0).max(3600).default(20),
  maxPushSummaryChars: z.number().int().min(100).max(10000).default(1600),
  maxContextPackChars: z.number().int().min(1000).max(50000).default(12000),
  commands: z
    .object({
      test: z.string().default("pnpm test"),
      lint: z.string().default("pnpm lint"),
      typecheck: z.string().default("pnpm typecheck"),
    })
    .default({
      test: "pnpm test",
      lint: "pnpm lint",
      typecheck: "pnpm typecheck",
    }),
  protectedGlobs: StringArraySchema,
});
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

export const AuthorizationGrantSchema = z.object({
  id: IdSchema,
  projectId: IdSchema,
  capability: AuthorizationCapabilitySchema,
  status: AuthorizationStatusSchema,
  reason: z.string(),
  detail: z.record(z.string(), z.unknown()),
  requestedByAgentId: z.string(),
  requestedBySessionId: IdSchema.nullable(),
  decidedBy: z.string().nullable(),
  decidedVia: z.enum(["dashboard", "api"]).nullable(),
  decidedAt: IsoDateSchema.nullable(),
  decisionNote: z.string().nullable(),
  expiresAt: IsoDateSchema.nullable(),
  version: z.number().int().nonnegative(),
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema,
});
export type AuthorizationGrant = z.infer<typeof AuthorizationGrantSchema>;

export const ModelPresetSchema = z.object({
  id: IdSchema,
  agentId: z.string(),
  modelId: z.string(),
  label: z.string(),
  reasoningEfforts: z.array(z.string()),
  launchArgs: z.array(z.string()),
  effortArgs: z.array(z.string()),
  enabled: z.boolean(),
  sortOrder: z.number().int(),
  version: z.number().int().nonnegative(),
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema,
});
export type ModelPreset = z.infer<typeof ModelPresetSchema>;

export const UpsertModelPresetInputSchema = z.object({
  agentId: z.string().min(1).max(100),
  modelId: z.string().min(1).max(200),
  label: z.string().min(1).max(200),
  reasoningEfforts: z.array(z.string().max(40)).max(10).default([]),
  /** Always applied. Tokens may contain {model}. */
  launchArgs: z.array(z.string().max(500)).max(32).default([]),
  /** Applied as a whole only when an effort is selected, so a flag never outlives its value. */
  effortArgs: z.array(z.string().max(500)).max(16).default([]),
  enabled: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(9999).default(0),
});

export const RequestAuthorizationInputSchema = z.object({
  capability: AuthorizationCapabilitySchema,
  reason: z.string().min(1).max(2000),
  detail: z.record(z.string(), z.unknown()).default({}),
  requestedByAgentId: z.string().min(1).max(100),
  requestedBySessionId: IdSchema.optional(),
  idempotencyKey: z.string().min(1).max(300),
});

export const DecideAuthorizationInputSchema = z.object({
  expectedVersion: z.number().int().nonnegative(),
  decision: z.enum(["GRANTED", "DENIED", "REVOKED"]),
  actorId: z.string().min(1).default("local-user"),
  note: z.string().max(2000).optional(),
  /** Absent means the grant does not expire on its own and must be revoked explicitly. */
  ttlSeconds: z.number().int().min(60).max(31_536_000).optional(),
  idempotencyKey: z.string().min(1).max(300),
});
