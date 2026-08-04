import { createHash, randomBytes } from "node:crypto";
import { HubClient, HubHttpError } from "@crossagent/client";
import {
  SESSION_TICKET_PURPOSES_BY_CLIENT,
  RotateAdapterSessionTicketsResultSchema,
  AgentSessionSchema,
  RegisterAdapterSessionInputSchema,
  SessionTicketBindingSchema,
  createId,
  type AgentSession,
  type RegisterAdapterSessionResult,
  type RotateAdapterSessionTicketsResult,
  type SessionLaunchReservation,
  type SessionTicketBinding,
  type SessionTicketOfferInput,
  type SessionTicketPurpose,
} from "@crossagent/protocol";

type CodexTicketPurpose = Extract<SessionTicketPurpose, "CONTROL" | "MODEL_MCP" | "INJECTOR">;
type TicketRegistrationInput = Omit<
  Parameters<HubClient["registerAdapterSession"]>[1],
  "ticket_bundle_id"
>;

export type CodexSessionTicketSecrets = Record<CodexTicketPurpose, string>;
export type CodexModelTransportConfiguration = "MODEL_READY" | "MODEL_CONFIGURED_OFFLINE";

export type CodexSessionTicketContext = {
  projectId: string;
  runId: string;
  activationMode:
    "FIRST_LINEAGE" | "CURRENT_HEAD_REPLACEMENT" | "MANAGED_RESERVATION" | "SESSION_AUXILIARY";
  externalSessionId: string | null;
  externalThreadId: string | null;
  expectedLineageId?: string;
  expectedHeadSessionId?: string | null;
  launchReservationId?: string;
  launchGeneration?: number;
};

export type StoredCodexSessionTicketBundle = {
  bundleId: string;
  phase: "PREPARING" | "OFFERED" | "ACTIVATING" | "ACTIVE";
  /** Immutable launch identity; renewal-specific AUX bindings never overwrite it. */
  launchContext: CodexSessionTicketContext;
  context: CodexSessionTicketContext;
  raw: CodexSessionTicketSecrets;
  offerIds: Partial<Record<CodexTicketPurpose, string>>;
  activationAttempted: boolean;
  binding: SessionTicketBinding | null;
  /** Exact Hub receipt retained across a lost activation response and process restart. */
  rotationReceipt: RotateAdapterSessionTicketsResult | null;
  /** Exact registered session identity needed to resume a committed cutover after process death. */
  sessionReceipt: AgentSession | null;
  /** Immutable session that consumed the original managed launch reservation. */
  launchSessionId: string | null;
  /** Fresh canonical Hub time from the register/rotate response; never inferred from activatedAt. */
  serverNow: string | null;
  observedAt: string | null;
  /** Exact body (without raw ticket) for process-level idempotent registration replay. */
  registrationInput: TicketRegistrationInput | null;
  /** Durable model configuration survives cutover commit and process restart. */
  modelTransportState?: CodexModelTransportConfiguration;
  /** Last fuse generation, retained while READY so later outages remain monotonic after restart. */
  modelTransportFuseGeneration?: number;
};

export type CodexSessionTicketVaultSnapshot = {
  schemaVersion: 1;
  current: StoredCodexSessionTicketBundle | null;
  successor: StoredCodexSessionTicketBundle | null;
  /** Durable Hub-activation progress. Ephemeral sockets/processes are always rebuilt on reentry. */
  cutover?: StoredCodexCredentialCutover | null;
};

export function codexModelTransportConfiguration(
  bundle: Pick<StoredCodexSessionTicketBundle, "modelTransportState">,
): CodexModelTransportConfiguration {
  return bundle.modelTransportState ?? "MODEL_READY";
}

export function codexModelTransportFuseGeneration(
  bundle: Pick<StoredCodexSessionTicketBundle, "modelTransportFuseGeneration">,
): number {
  return bundle.modelTransportFuseGeneration ?? 0;
}

export type CodexCredentialCutoverPhase =
  | "HUB_ACTIVATING"
  | "HUB_ACTIVATED"
  | "CONTROL_READY"
  | "MODEL_READY"
  | "MODEL_CONFIGURED_OFFLINE"
  | "EVENTS_READY";

export type StoredCodexCredentialCutover = {
  kind: "SESSION_AUXILIARY" | "CURRENT_HEAD_REPLACEMENT";
  predecessorBundleId: string;
  successorBundleId: string;
  predecessorSessionId: string;
  successorSessionId: string | null;
  operationId: string;
  phase: CodexCredentialCutoverPhase;
  updatedAt: string;
};

export type CodexSessionOperationalCheckpoint = {
  schemaVersion: 1;
  projectId: string;
  threadId: string;
  ownerRunId: string;
  eventSequence: number;
  /** Claimed work not yet durably settled; survives a cursor advance and process crash. */
  pendingMessageIds: string[];
  session: {
    hubSessionId: string;
    lineageId: string;
    incarnation: number;
    bundleId: string;
    /** The next sequence is reserved durably before it crosses the Hub transport. */
    nextHeartbeatSequence: number;
  } | null;
  /**
   * Write-ahead proof that Hub close was confirmed before raw credentials are deleted. Keeping the
   * live session binding until the vault close commits prevents a failed vault write from exposing
   * `session: null` while reusable credentials still exist.
   */
  confirmedClose?: {
    bundleId: string;
    state: "PREPARED";
    confirmedAt: string;
  };
  updatedAt: string;
};

/** Protocol IdSchema bounds persisted ids at 128 characters; every Adapter reuses this codec. */
export const CODEX_PENDING_MESSAGE_ID_MAX_LENGTH = 128;

export function isCodexPendingMessageId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.startsWith("msg_") &&
    value.length <= CODEX_PENDING_MESSAGE_ID_MAX_LENGTH
  );
}

export interface CodexSessionOperationalCheckpointStore {
  load(projectId: string, threadId: string): Promise<CodexSessionOperationalCheckpoint | null>;
  save(checkpoint: CodexSessionOperationalCheckpoint): Promise<void>;
}

export interface CodexSessionTicketVault {
  load(): Promise<CodexSessionTicketVaultSnapshot | null>;
  save(snapshot: CodexSessionTicketVaultSnapshot): Promise<void>;
}

const BUNDLE_PHASES = new Set(["PREPARING", "OFFERED", "ACTIVATING", "ACTIVE"]);
const CONTEXT_MODES = new Set([
  "FIRST_LINEAGE",
  "CURRENT_HEAD_REPLACEMENT",
  "MANAGED_RESERVATION",
  "SESSION_AUXILIARY",
]);
const RAW_TICKET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseStoredBundle(value: unknown): StoredCodexSessionTicketBundle {
  const candidate = record(value);
  const launchContext = record(candidate?.launchContext);
  const context = record(candidate?.context);
  const raw = record(candidate?.raw);
  const offerIds = record(candidate?.offerIds);
  const purposes: CodexTicketPurpose[] = ["CONTROL", "MODEL_MCP", "INJECTOR"];
  if (
    !candidate ||
    typeof candidate.bundleId !== "string" ||
    !candidate.bundleId.startsWith("stb_") ||
    typeof candidate.phase !== "string" ||
    !BUNDLE_PHASES.has(candidate.phase) ||
    !launchContext ||
    !context ||
    typeof context.projectId !== "string" ||
    !context.projectId.startsWith("prj_") ||
    typeof context.runId !== "string" ||
    !context.runId.startsWith("run_") ||
    typeof context.activationMode !== "string" ||
    !CONTEXT_MODES.has(context.activationMode) ||
    !raw ||
    purposes.some(
      (purpose) =>
        typeof raw[purpose] !== "string" || !RAW_TICKET_PATTERN.test(raw[purpose] as string),
    ) ||
    new Set(purposes.map((purpose) => raw[purpose])).size !== purposes.length ||
    !offerIds ||
    Object.keys(offerIds).some(
      (purpose) =>
        !purposes.includes(purpose as CodexTicketPurpose) || typeof offerIds[purpose] !== "string",
    ) ||
    typeof candidate.activationAttempted !== "boolean" ||
    (candidate.launchSessionId !== null &&
      (typeof candidate.launchSessionId !== "string" ||
        !candidate.launchSessionId.startsWith("ses_"))) ||
    (candidate.observedAt !== null &&
      (typeof candidate.observedAt !== "string" ||
        new Date(candidate.observedAt).toISOString() !== candidate.observedAt)) ||
    (candidate.modelTransportState !== undefined &&
      !["MODEL_READY", "MODEL_CONFIGURED_OFFLINE"].includes(
        String(candidate.modelTransportState),
      )) ||
    (candidate.modelTransportFuseGeneration !== undefined &&
      (!Number.isSafeInteger(candidate.modelTransportFuseGeneration) ||
        Number(candidate.modelTransportFuseGeneration) < 0)) ||
    (candidate.modelTransportState === "MODEL_CONFIGURED_OFFLINE" &&
      (!Number.isSafeInteger(candidate.modelTransportFuseGeneration) ||
        Number(candidate.modelTransportFuseGeneration) <= 0))
  ) {
    throw new Error("Invalid Codex session ticket vault snapshot");
  }
  for (const key of [
    "externalSessionId",
    "externalThreadId",
    "expectedLineageId",
    "expectedHeadSessionId",
    "launchReservationId",
  ]) {
    if (context[key] !== undefined && context[key] !== null && typeof context[key] !== "string") {
      throw new Error("Invalid Codex session ticket vault snapshot");
    }
    if (
      launchContext[key] !== undefined &&
      launchContext[key] !== null &&
      typeof launchContext[key] !== "string"
    ) {
      throw new Error("Invalid Codex session ticket vault snapshot");
    }
  }
  if (
    (context.launchGeneration !== undefined &&
      (!Number.isSafeInteger(context.launchGeneration) || Number(context.launchGeneration) <= 0)) ||
    (launchContext.launchGeneration !== undefined &&
      (!Number.isSafeInteger(launchContext.launchGeneration) ||
        Number(launchContext.launchGeneration) <= 0))
  ) {
    throw new Error("Invalid Codex session ticket vault snapshot");
  }
  if (
    typeof launchContext.projectId !== "string" ||
    typeof launchContext.runId !== "string" ||
    typeof launchContext.activationMode !== "string" ||
    !CONTEXT_MODES.has(launchContext.activationMode) ||
    ["CURRENT_HEAD_REPLACEMENT", "SESSION_AUXILIARY"].includes(launchContext.activationMode) ||
    launchContext.projectId !== context.projectId ||
    launchContext.runId !== context.runId
  ) {
    throw new Error("Invalid Codex session ticket vault snapshot");
  }
  const binding =
    candidate.binding === null ? null : SessionTicketBindingSchema.parse(candidate.binding);
  const rotationReceipt =
    candidate.rotationReceipt === null
      ? null
      : RotateAdapterSessionTicketsResultSchema.parse(candidate.rotationReceipt);
  const sessionReceipt =
    candidate.sessionReceipt === null ? null : AgentSessionSchema.parse(candidate.sessionReceipt);
  const serverNow =
    candidate.serverNow === null ||
    (typeof candidate.serverNow === "string" &&
      new Date(candidate.serverNow).toISOString() === candidate.serverNow)
      ? candidate.serverNow
      : (() => {
          throw new Error("invalid Hub receipt time");
        })();
  const registrationInput =
    candidate.registrationInput === null
      ? null
      : (() => {
          const parsed = RegisterAdapterSessionInputSchema.parse({
            ...(record(candidate.registrationInput) ?? {}),
            projectId: context.projectId,
            ticket_bundle_id: candidate.bundleId,
          });
          const { projectId: _projectId, ticket_bundle_id: _bundleId, ...input } = parsed;
          return input;
        })();
  if ((candidate.phase === "ACTIVE") !== Boolean(binding)) {
    throw new Error("Invalid Codex session ticket vault snapshot");
  }
  if (
    binding &&
    (binding.bundleId !== candidate.bundleId ||
      binding.projectId !== context.projectId ||
      binding.runId !== context.runId ||
      binding.agentId !== "codex" ||
      binding.adapterClient !== "codex" ||
      new Set(binding.purposes.map((entry) => entry.purpose)).size !== purposes.length ||
      purposes.some((purpose) => !binding.purposes.some((entry) => entry.purpose === purpose)) ||
      Date.parse(binding.expiresAt) <= Date.parse(binding.activatedAt) ||
      (context.expectedLineageId !== undefined &&
        binding.lineageId !== context.expectedLineageId) ||
      (context.activationMode === "SESSION_AUXILIARY" &&
        binding.hubSessionId !== context.expectedHeadSessionId))
  ) {
    throw new Error("Invalid Codex session ticket vault snapshot");
  }
  if (binding && candidate.observedAt === null) {
    throw new Error("Invalid Codex session ticket vault snapshot");
  }
  if (binding && (!sessionReceipt || !serverNow)) {
    throw new Error("Invalid Codex session ticket vault snapshot");
  }
  if (binding && !candidate.launchSessionId) {
    throw new Error("Invalid Codex session ticket vault snapshot");
  }
  if (
    binding &&
    !["SESSION_AUXILIARY", "CURRENT_HEAD_REPLACEMENT"].includes(context.activationMode) &&
    candidate.launchSessionId !== sessionReceipt?.id
  ) {
    throw new Error("Invalid Codex session ticket vault snapshot");
  }
  if (binding && !registrationInput) {
    throw new Error("Invalid Codex session ticket vault snapshot");
  }
  if (
    sessionReceipt &&
    (!binding ||
      sessionReceipt.id !== binding.hubSessionId ||
      sessionReceipt.projectId !== binding.projectId ||
      sessionReceipt.agentId !== "codex" ||
      sessionReceipt.client !== "codex-app-server" ||
      sessionReceipt.lineageId !== binding.lineageId ||
      sessionReceipt.incarnation !== binding.incarnation ||
      sessionReceipt.externalThreadId !== launchContext.externalThreadId)
  ) {
    throw new Error("Invalid Codex session ticket vault snapshot");
  }
  if (rotationReceipt && rotationReceipt.ticketBinding.bundleId !== candidate.bundleId) {
    throw new Error("Invalid Codex session ticket vault snapshot");
  }
  if (
    rotationReceipt &&
    (!binding ||
      JSON.stringify(rotationReceipt.ticketBinding) !== JSON.stringify(binding) ||
      rotationReceipt.session.id !== binding.hubSessionId ||
      rotationReceipt.session.projectId !== binding.projectId ||
      rotationReceipt.session.agentId !== "codex" ||
      rotationReceipt.session.client !== "codex-app-server" ||
      rotationReceipt.session.lineageId !== binding.lineageId ||
      rotationReceipt.session.incarnation !== binding.incarnation ||
      rotationReceipt.session.externalThreadId !== launchContext.externalThreadId)
  ) {
    throw new Error("Invalid Codex session ticket vault snapshot");
  }
  if (
    rotationReceipt &&
    (JSON.stringify(rotationReceipt.session) !== JSON.stringify(sessionReceipt) ||
      rotationReceipt.serverNow !== serverNow)
  ) {
    throw new Error("Invalid Codex session ticket vault snapshot");
  }
  // Preserve the exact v1 object shape. Missing state is interpreted as legacy MODEL_READY through
  // codexModelTransportConfiguration rather than rewriting every unrelated historical fixture.
  return structuredClone(candidate) as StoredCodexSessionTicketBundle;
}

/** Parse untrusted disk state without ever including a secret value in diagnostics. */
export function parseCodexSessionTicketVaultSnapshot(
  value: unknown,
): CodexSessionTicketVaultSnapshot {
  const candidate = record(value);
  if (
    !candidate ||
    candidate.schemaVersion !== 1 ||
    !("current" in candidate) ||
    !("successor" in candidate)
  ) {
    throw new Error("Invalid Codex session ticket vault snapshot");
  }
  try {
    const current = candidate.current === null ? null : parseStoredBundle(candidate.current);
    const successor = candidate.successor === null ? null : parseStoredBundle(candidate.successor);
    if (successor && (!current || successor.bundleId === current.bundleId)) {
      throw new Error("invalid bundle relationship");
    }
    const raws = [current, successor]
      .filter((bundle): bundle is StoredCodexSessionTicketBundle => Boolean(bundle))
      .flatMap((bundle) => Object.values(bundle.raw));
    if (new Set(raws).size !== raws.length) throw new Error("duplicate raw ticket");
    const cutoverValue = candidate.cutover;
    const cutover =
      cutoverValue === undefined || cutoverValue === null
        ? null
        : parseStoredCredentialCutover(cutoverValue, current, successor);
    return { schemaVersion: 1, current, successor, cutover };
  } catch {
    throw new Error("Invalid Codex session ticket vault snapshot");
  }
}

function parseStoredCredentialCutover(
  value: unknown,
  current: StoredCodexSessionTicketBundle | null,
  successor: StoredCodexSessionTicketBundle | null,
): StoredCodexCredentialCutover {
  const candidate = record(value);
  if (
    !candidate ||
    !["SESSION_AUXILIARY", "CURRENT_HEAD_REPLACEMENT"].includes(String(candidate.kind)) ||
    typeof candidate.predecessorBundleId !== "string" ||
    typeof candidate.successorBundleId !== "string" ||
    typeof candidate.predecessorSessionId !== "string" ||
    (candidate.successorSessionId !== null && typeof candidate.successorSessionId !== "string") ||
    typeof candidate.operationId !== "string" ||
    candidate.operationId.length === 0 ||
    ![
      "HUB_ACTIVATING",
      "HUB_ACTIVATED",
      "CONTROL_READY",
      "MODEL_READY",
      "MODEL_CONFIGURED_OFFLINE",
      "EVENTS_READY",
    ].includes(String(candidate.phase)) ||
    typeof candidate.updatedAt !== "string" ||
    new Date(candidate.updatedAt).toISOString() !== candidate.updatedAt ||
    !current ||
    !successor ||
    current.bundleId !== candidate.predecessorBundleId ||
    successor.bundleId !== candidate.successorBundleId ||
    successor.context.activationMode !== candidate.kind ||
    current.sessionReceipt?.id !== candidate.predecessorSessionId ||
    (candidate.phase === "HUB_ACTIVATING"
      ? successor.phase !== "ACTIVATING" || candidate.successorSessionId !== null
      : successor.phase !== "ACTIVE" ||
        successor.sessionReceipt?.id !== candidate.successorSessionId) ||
    (candidate.phase === "MODEL_READY" &&
      codexModelTransportConfiguration(successor) !== "MODEL_READY") ||
    (candidate.phase === "MODEL_CONFIGURED_OFFLINE" &&
      successor.modelTransportState !== "MODEL_CONFIGURED_OFFLINE")
  ) {
    throw new Error("Invalid Codex credential cutover checkpoint");
  }
  return structuredClone(candidate) as StoredCodexCredentialCutover;
}

/** Parse untrusted non-secret progress independently from the raw credential vault. */
export function parseCodexSessionOperationalCheckpoint(
  value: unknown,
): CodexSessionOperationalCheckpoint {
  const candidate = record(value);
  const session = record(candidate?.session);
  const confirmedClose = record(candidate?.confirmedClose);
  if (
    !candidate ||
    candidate.schemaVersion !== 1 ||
    typeof candidate.projectId !== "string" ||
    !candidate.projectId.startsWith("prj_") ||
    typeof candidate.threadId !== "string" ||
    candidate.threadId.length === 0 ||
    typeof candidate.ownerRunId !== "string" ||
    !candidate.ownerRunId.startsWith("run_") ||
    !Number.isSafeInteger(candidate.eventSequence) ||
    Number(candidate.eventSequence) < 0 ||
    !Array.isArray(candidate.pendingMessageIds) ||
    candidate.pendingMessageIds.length > 10_000 ||
    candidate.pendingMessageIds.some((entry) => !isCodexPendingMessageId(entry)) ||
    new Set(candidate.pendingMessageIds).size !== candidate.pendingMessageIds.length ||
    typeof candidate.updatedAt !== "string" ||
    new Date(candidate.updatedAt).toISOString() !== candidate.updatedAt ||
    (candidate.confirmedClose !== undefined &&
      (!confirmedClose ||
        confirmedClose.state !== "PREPARED" ||
        typeof confirmedClose.bundleId !== "string" ||
        !confirmedClose.bundleId.startsWith("stb_") ||
        typeof confirmedClose.confirmedAt !== "string" ||
        new Date(confirmedClose.confirmedAt).toISOString() !== confirmedClose.confirmedAt)) ||
    (candidate.session !== null &&
      (!session ||
        typeof session.hubSessionId !== "string" ||
        !session.hubSessionId.startsWith("ses_") ||
        typeof session.lineageId !== "string" ||
        !session.lineageId.startsWith("lin_") ||
        !Number.isSafeInteger(session.incarnation) ||
        Number(session.incarnation) <= 0 ||
        typeof session.bundleId !== "string" ||
        !session.bundleId.startsWith("stb_") ||
        !Number.isSafeInteger(session.nextHeartbeatSequence) ||
        Number(session.nextHeartbeatSequence) <= 0)) ||
    (confirmedClose && (!session || confirmedClose.bundleId !== session.bundleId))
  ) {
    throw new Error("Invalid Codex operational checkpoint");
  }
  return structuredClone(candidate) as CodexSessionOperationalCheckpoint;
}

export type ActiveCodexSessionTicketBundle = {
  stored: StoredCodexSessionTicketBundle & { phase: "ACTIVE"; binding: SessionTicketBinding };
  controlHub: HubClient;
  injectorHub: HubClient;
  modelMcpToken: string;
};

type RuntimeOptions = {
  baseUrl?: string;
  bootstrapAgentToken: string;
  bootstrapInjectorToken: string;
  vault: CodexSessionTicketVault;
  checkpointStore: CodexSessionOperationalCheckpointStore;
  /** Test/embedding Seam; production uses global fetch through HubClient. */
  fetch?: typeof globalThis.fetch;
  requestTimeoutMs?: number;
  now?: () => Date;
};

function digest(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

function newRaw(): string {
  return randomBytes(32).toString("base64url");
}

function cloneSnapshot(snapshot: CodexSessionTicketVaultSnapshot): CodexSessionTicketVaultSnapshot {
  return structuredClone(snapshot);
}

function contextMatches(
  actual: CodexSessionTicketContext,
  expected: CodexSessionTicketContext,
): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

/**
 * Owns raw ticket generation, per-purpose offer provenance, durable ambiguous activation state,
 * and exact idempotent replay. Raw values never cross its Interface except as purpose-specific
 * parent-process credentials needed for the actual transport cutover.
 */
export class CodexSessionTicketRuntime {
  private readonly bootstrapAgentHub: HubClient;
  private readonly bootstrapInjectorHub: HubClient;
  private readonly now: () => Date;
  private snapshot: CodexSessionTicketVaultSnapshot | null = null;
  private durableSnapshot: CodexSessionTicketVaultSnapshot | null = null;
  private checkpoint: CodexSessionOperationalCheckpoint | null | undefined;
  private operationTail: Promise<void> = Promise.resolve();

  constructor(private readonly options: RuntimeOptions) {
    if (
      !options.bootstrapAgentToken ||
      !options.bootstrapInjectorToken ||
      options.bootstrapAgentToken === options.bootstrapInjectorToken
    ) {
      throw new Error(
        "Codex ticket runtime requires distinct Agent and injector bootstrap credentials",
      );
    }
    this.bootstrapAgentHub = this.client(options.bootstrapAgentToken);
    this.bootstrapInjectorHub = this.client(options.bootstrapInjectorToken);
    this.now = options.now ?? (() => new Date());
  }

  prepareInitial(context: CodexSessionTicketContext): Promise<StoredCodexSessionTicketBundle> {
    return this.exclusive(() => this.prepareInitialOwned(context));
  }

  private async prepareInitialOwned(
    context: CodexSessionTicketContext,
  ): Promise<StoredCodexSessionTicketBundle> {
    if (context.activationMode === "SESSION_AUXILIARY") {
      throw new Error("Initial ticket preparation cannot use SESSION_AUXILIARY");
    }
    const snapshot = await this.load();
    if (!snapshot.current && !snapshot.successor && !snapshot.cutover) {
      await this.finalizeOrphanedConfirmedClose(context);
    }
    if (snapshot.current) {
      if (!contextMatches(snapshot.current.context, context)) {
        throw new Error("Persisted initial ticket bundle belongs to another launch binding");
      }
      if (snapshot.current.phase === "ACTIVE") return structuredClone(snapshot.current);
      await this.offerBundle(snapshot.current, this.bootstrapAgentHub);
      return structuredClone(snapshot.current);
    }
    const current = this.createBundle(context);
    snapshot.current = current;
    await this.persist();
    await this.offerBundle(current, this.bootstrapAgentHub);
    return structuredClone(current);
  }

  registerInitial(
    input: Omit<Parameters<HubClient["registerAdapterSession"]>[1], "ticket_bundle_id">,
  ): Promise<{
    registration: RegisterAdapterSessionResult;
    active: ActiveCodexSessionTicketBundle;
  }> {
    return this.exclusive(() => this.registerInitialOwned(input));
  }

  private async registerInitialOwned(input: TicketRegistrationInput): Promise<{
    registration: RegisterAdapterSessionResult;
    active: ActiveCodexSessionTicketBundle;
  }> {
    const snapshot = await this.load();
    const current = snapshot.current;
    if (!current) throw new Error("No prepared Codex ticket bundle exists");
    if (current.phase === "ACTIVE" && current.binding) {
      throw new Error("Initial Codex ticket bundle is already active; use explicit recovery");
    }
    if (current.phase !== "OFFERED" && current.phase !== "ACTIVATING") {
      throw new Error("Initial Codex ticket bundle is not fully offered");
    }
    current.phase = "ACTIVATING";
    current.activationAttempted = true;
    if (
      current.registrationInput &&
      JSON.stringify(current.registrationInput) !== JSON.stringify(input)
    ) {
      throw new Error("Initial Codex ticket registration replay body changed");
    }
    current.registrationInput = structuredClone(input);
    await this.persist();
    const controlHub = this.client(current.raw.CONTROL);
    const registration = await controlHub.registerAdapterSession(current.context.projectId, {
      ...current.registrationInput,
      ticket_bundle_id: current.bundleId,
    });
    this.assertActivatedBinding(current, registration.ticketBinding, registration.session);
    current.phase = "ACTIVE";
    current.binding = registration.ticketBinding;
    current.sessionReceipt = registration.session;
    current.launchSessionId = registration.session.id;
    current.serverNow = registration.serverNow;
    current.observedAt = this.now().toISOString();
    await this.persist();
    await this.bindCheckpointForActivated(current, null, true);
    return { registration, active: this.activeProjection(current) };
  }

  activateSuccessor(
    currentSession: AgentSession,
    operationId: string,
  ): Promise<{
    rotation: RotateAdapterSessionTicketsResult;
    previous: ActiveCodexSessionTicketBundle;
    next: ActiveCodexSessionTicketBundle;
  }> {
    return this.exclusive(() => this.activateSuccessorOwned(currentSession, operationId));
  }

  replaceCurrentHead(
    currentSession: AgentSession,
    input: TicketRegistrationInput,
  ): Promise<{
    registration: RegisterAdapterSessionResult;
    previous: ActiveCodexSessionTicketBundle;
    next: ActiveCodexSessionTicketBundle;
  }> {
    return this.exclusive(() => this.replaceCurrentHeadOwned(currentSession, input));
  }

  /**
   * One critical-recovery owner resumes the exact durable successor first. It creates a
   * CURRENT_HEAD replacement only when no AUX/CURRENT_HEAD activation is already in flight.
   */
  recoverCriticalSuccessor(
    expectedPredecessorBundleId: string,
    replacementInput: TicketRegistrationInput,
  ): Promise<{
    kind: "SESSION_AUXILIARY" | "CURRENT_HEAD_REPLACEMENT";
    previous: ActiveCodexSessionTicketBundle;
    next: ActiveCodexSessionTicketBundle;
    session: AgentSession;
  }> {
    return this.exclusive(async () => {
      const snapshot = await this.load();
      const current = snapshot.current;
      if (
        !current ||
        current.bundleId !== expectedPredecessorBundleId ||
        current.phase !== "ACTIVE" ||
        !current.sessionReceipt
      ) {
        throw new Error("Critical Codex recovery no longer owns the durable predecessor");
      }
      const successor = snapshot.successor;
      if (successor?.context.activationMode === "SESSION_AUXILIARY") {
        const expired = this.isLocallyExpired(current);
        if (expired && !successor.activationAttempted) {
          snapshot.successor = null;
          snapshot.cutover = null;
          await this.persist();
        } else {
          try {
            const resumed = await this.activateSuccessorOwned(
              current.sessionReceipt,
              snapshot.cutover?.operationId ?? `session-ticket-renewal:${current.bundleId}`,
            );
            return {
              kind: "SESSION_AUXILIARY",
              previous: resumed.previous,
              next: resumed.next,
              session: resumed.rotation.session,
            };
          } catch (error: unknown) {
            const aborted =
              error instanceof HubHttpError &&
              error.status === 409 &&
              error.code === "TICKET_ROTATION_NOT_COMMITTED" &&
              record(error.current)?.state === "ABORTED" &&
              record(error.current)?.sessionId === current.sessionReceipt.id &&
              record(error.current)?.predecessorBundleId === current.bundleId &&
              record(error.current)?.successorBundleId === successor.bundleId;
            if (!aborted) {
              throw error;
            }
            // This typed response is a Hub-linearized terminal tombstone for the exact operation.
            // Generic 403/409 responses never authorize dropping an ambiguous raw successor.
            snapshot.successor = null;
            snapshot.cutover = null;
            await this.persist();
          }
        }
      }
      const remainingSuccessor = snapshot.successor;
      if (
        remainingSuccessor &&
        remainingSuccessor.context.activationMode !== "CURRENT_HEAD_REPLACEMENT"
      ) {
        throw new Error("Critical Codex recovery found an invalid durable successor mode");
      }
      const replaced = await this.replaceCurrentHeadOwned(
        current.sessionReceipt,
        remainingSuccessor?.registrationInput ?? replacementInput,
      );
      return {
        kind: "CURRENT_HEAD_REPLACEMENT",
        previous: replaced.previous,
        next: replaced.next,
        session: replaced.registration.session,
      };
    });
  }

  private async replaceCurrentHeadOwned(
    currentSession: AgentSession,
    input: TicketRegistrationInput,
  ): Promise<{
    registration: RegisterAdapterSessionResult;
    previous: ActiveCodexSessionTicketBundle;
    next: ActiveCodexSessionTicketBundle;
  }> {
    const snapshot = await this.load();
    const current = snapshot.current;
    if (!current || current.phase !== "ACTIVE" || !current.binding) {
      throw new Error("Codex current-head recovery requires one durable ACTIVE predecessor");
    }
    this.assertSessionBinding(current, currentSession);
    const previous = this.activeProjection(current);
    const lineageId = current.binding.lineageId;
    if (!lineageId || !currentSession.externalThreadId || !currentSession.externalSessionId) {
      throw new Error("Codex current-head recovery requires its complete logical identity");
    }
    const context: CodexSessionTicketContext = {
      projectId: current.binding.projectId,
      runId: current.binding.runId,
      activationMode: "CURRENT_HEAD_REPLACEMENT",
      externalSessionId: currentSession.externalSessionId,
      externalThreadId: currentSession.externalThreadId,
      expectedLineageId: lineageId,
      expectedHeadSessionId: currentSession.id,
    };
    let successor = snapshot.successor;
    if (
      successor &&
      !contextMatches(successor.context, context) &&
      !successor.activationAttempted
    ) {
      // A partially offered AUX bundle never became an authentication principal. Once its current
      // predecessor is at the safety boundary it cannot block a current-head replacement forever.
      snapshot.successor = null;
      await this.persist();
      successor = null;
    }
    if (!successor) {
      successor = this.createBundle(
        context,
        current.launchContext,
        null,
        current.launchSessionId,
        codexModelTransportFuseGeneration(current),
      );
      snapshot.successor = successor;
      await this.persist();
    } else if (!contextMatches(successor.context, context)) {
      throw new Error("Persisted successor is not the exact current-head recovery attempt");
    }
    if (successor.phase !== "ACTIVE") {
      await this.offerBundle(successor, previous.controlHub);
      successor.phase = "ACTIVATING";
      successor.activationAttempted = true;
      if (
        successor.registrationInput &&
        JSON.stringify(successor.registrationInput) !== JSON.stringify(input)
      ) {
        throw new Error("Current-head Codex ticket registration replay body changed");
      }
      successor.registrationInput = structuredClone(input);
      snapshot.cutover = this.createActivatingCutover(
        "CURRENT_HEAD_REPLACEMENT",
        current,
        successor,
        input.idempotencyKey,
      );
      await this.persist();
      const controlHub = this.client(successor.raw.CONTROL);
      const registration = await controlHub.registerAdapterSession(context.projectId, {
        ...successor.registrationInput,
        expectedHeadSessionId: currentSession.id,
        launcherRunId: undefined,
        launchGeneration: undefined,
        ticket_bundle_id: successor.bundleId,
      });
      this.assertActivatedBinding(successor, registration.ticketBinding, registration.session);
      if (
        currentSession.incarnation === null ||
        registration.session.incarnation !== currentSession.incarnation + 1
      ) {
        throw new Error("Hub current-head replacement did not advance the exact predecessor");
      }
      successor.phase = "ACTIVE";
      successor.binding = registration.ticketBinding;
      successor.sessionReceipt = registration.session;
      successor.serverNow = registration.serverNow;
      successor.observedAt = this.now().toISOString();
      snapshot.cutover = this.createCutover(
        "CURRENT_HEAD_REPLACEMENT",
        current,
        successor,
        successor.registrationInput!.idempotencyKey,
      );
      await this.persistHubCommittedSuccessor();
      await this.bindCheckpointForActivated(successor, current);
      return { registration, previous, next: this.activeProjection(successor) };
    }
    if (!successor.sessionReceipt || !successor.binding || !successor.serverNow) {
      throw new Error("ACTIVE current-head recovery lacks its exact Hub receipt");
    }
    return {
      registration: {
        session: successor.sessionReceipt,
        ticketBinding: successor.binding,
        serverNow: successor.serverNow,
      },
      previous,
      next: this.activeProjection(successor),
    };
  }

  private async activateSuccessorOwned(
    currentSession: AgentSession,
    operationId: string,
  ): Promise<{
    rotation: RotateAdapterSessionTicketsResult;
    previous: ActiveCodexSessionTicketBundle;
    next: ActiveCodexSessionTicketBundle;
  }> {
    const snapshot = await this.load();
    const current = snapshot.current;
    if (!current || current.phase !== "ACTIVE" || !current.binding) {
      throw new Error("Codex ticket renewal requires one durable ACTIVE current bundle");
    }
    this.assertSessionBinding(current, currentSession);
    const previous = this.activeProjection(current);
    let successor = snapshot.successor;
    const context: CodexSessionTicketContext = {
      projectId: current.binding.projectId,
      runId: current.binding.runId,
      activationMode: "SESSION_AUXILIARY",
      externalSessionId: currentSession.externalSessionId,
      externalThreadId: currentSession.externalThreadId,
      expectedLineageId: current.binding.lineageId!,
      expectedHeadSessionId: current.binding.hubSessionId,
    };
    if (!successor) {
      successor = this.createBundle(
        context,
        current.launchContext,
        current.registrationInput,
        current.launchSessionId,
        codexModelTransportFuseGeneration(current),
      );
      snapshot.successor = successor;
      await this.persist();
    } else if (!contextMatches(successor.context, context)) {
      throw new Error("Persisted successor ticket bundle belongs to another session binding");
    }
    if (successor.phase !== "ACTIVE") {
      await this.offerBundle(successor, previous.controlHub);
      successor.phase = "ACTIVATING";
      successor.activationAttempted = true;
      snapshot.cutover = this.createActivatingCutover(
        "SESSION_AUXILIARY",
        current,
        successor,
        operationId,
      );
      await this.persist();
      const rotation = await previous.controlHub.rotateAdapterSessionTickets(
        current.binding.hubSessionId,
        successor.bundleId,
        { idempotencyKey: operationId },
      );
      this.assertRotation(current, successor, rotation);
      successor.phase = "ACTIVE";
      successor.binding = rotation.ticketBinding;
      successor.rotationReceipt = rotation;
      successor.sessionReceipt = rotation.session;
      successor.serverNow = rotation.serverNow;
      successor.observedAt = this.now().toISOString();
      snapshot.cutover = this.createCutover("SESSION_AUXILIARY", current, successor, operationId);
      await this.persistHubCommittedSuccessor();
      await this.bindCheckpointForActivated(successor, current);
      return { rotation, previous, next: this.activeProjection(successor) };
    }
    if (!successor.binding) throw new Error("ACTIVE successor ticket bundle lacks its Hub binding");
    if (!successor.rotationReceipt) {
      throw new Error("ACTIVE successor ticket bundle lacks its exact Hub rotation receipt");
    }
    this.assertRotation(current, successor, successor.rotationReceipt);
    return {
      rotation: structuredClone(successor.rotationReceipt),
      previous,
      next: this.activeProjection(successor),
    };
  }

  commitSuccessor(bundleId: string): Promise<void> {
    return this.exclusive(() => this.commitSuccessorOwned(bundleId));
  }

  adoptSuccessorForConfirmedClose(bundleId: string): Promise<void> {
    return this.exclusive(() => this.commitSuccessorOwned(bundleId, true));
  }

  adoptExpiredSuccessorForRecovery(bundleId: string): Promise<void> {
    return this.exclusive(async () => {
      const snapshot = await this.load();
      if (!snapshot.successor || snapshot.successor.bundleId !== bundleId) {
        throw new Error("Expired Codex recovery does not match the durable successor");
      }
      if (!this.isLocallyExpired(snapshot.successor)) {
        throw new Error(
          "Only an expired Hub-confirmed successor may bypass ephemeral cutover phases",
        );
      }
      await this.commitSuccessorOwned(bundleId, true);
    });
  }

  markCutoverPhase(
    bundleId: string,
    phase: Extract<
      CodexCredentialCutoverPhase,
      "CONTROL_READY" | "MODEL_READY" | "MODEL_CONFIGURED_OFFLINE" | "EVENTS_READY"
    >,
    modelTransportFuseGeneration?: number,
  ): Promise<void> {
    return this.exclusive(async () => {
      const snapshot = await this.load();
      const cutover = snapshot.cutover;
      if (!cutover || cutover.successorBundleId !== bundleId) {
        throw new Error("Codex credential cutover phase does not match the durable successor");
      }
      const successor = snapshot.successor;
      if (!successor || successor.bundleId !== bundleId) {
        throw new Error("Codex credential cutover phase lacks its durable successor");
      }
      if (phase === "MODEL_CONFIGURED_OFFLINE") {
        if (
          !Number.isSafeInteger(modelTransportFuseGeneration) ||
          Number(modelTransportFuseGeneration) <= 0
        ) {
          throw new Error("Configured-offline model transport requires a positive fuse generation");
        }
      }
      if (phase === cutover.phase) {
        if (
          phase === "MODEL_CONFIGURED_OFFLINE" &&
          codexModelTransportFuseGeneration(successor) !== modelTransportFuseGeneration
        ) {
          throw new Error("Configured-offline model transport generation replay changed");
        }
        return;
      }
      if (
        cutover.phase === "EVENTS_READY" ||
        ((cutover.phase === "MODEL_READY" || cutover.phase === "MODEL_CONFIGURED_OFFLINE") &&
          phase === "CONTROL_READY")
      ) {
        return;
      }
      if (
        (cutover.phase === "MODEL_READY" && phase === "MODEL_CONFIGURED_OFFLINE") ||
        (cutover.phase === "MODEL_CONFIGURED_OFFLINE" && phase === "MODEL_READY")
      ) {
        throw new Error("Codex credential cutover cannot change model branch after configuration");
      }
      const allowed =
        (cutover.phase === "HUB_ACTIVATED" && phase === "CONTROL_READY") ||
        (cutover.phase === "CONTROL_READY" &&
          (phase === "MODEL_READY" || phase === "MODEL_CONFIGURED_OFFLINE")) ||
        ((cutover.phase === "MODEL_READY" || cutover.phase === "MODEL_CONFIGURED_OFFLINE") &&
          phase === "EVENTS_READY");
      if (!allowed) {
        throw new Error("Codex credential cutover phases cannot be skipped");
      }
      if (phase === "MODEL_READY" || phase === "MODEL_CONFIGURED_OFFLINE") {
        successor.modelTransportState = phase;
        if (phase === "MODEL_CONFIGURED_OFFLINE") {
          successor.modelTransportFuseGeneration = modelTransportFuseGeneration;
        }
      }
      cutover.phase = phase;
      cutover.updatedAt = this.now().toISOString();
      await this.persist();
    });
  }

  markActiveModelTransportOffline(bundleId: string, fuseGeneration: number): Promise<void> {
    return this.markActiveModelTransportState(bundleId, "MODEL_CONFIGURED_OFFLINE", fuseGeneration);
  }

  markActiveModelTransportReady(bundleId: string): Promise<void> {
    return this.markActiveModelTransportState(bundleId, "MODEL_READY");
  }

  getCutover(): Promise<StoredCodexCredentialCutover | null> {
    return this.exclusive(async () => {
      const snapshot = await this.load();
      return snapshot.cutover ? structuredClone(snapshot.cutover) : null;
    });
  }

  restoreOperationalCheckpoint(
    active: ActiveCodexSessionTicketBundle,
  ): Promise<CodexSessionOperationalCheckpoint> {
    return this.exclusive(async () => {
      const snapshot = await this.load();
      const predecessor =
        snapshot.successor?.bundleId === active.stored.bundleId ? snapshot.current : null;
      await this.bindCheckpointForActivated(active.stored, predecessor);
      return structuredClone(this.checkpoint!);
    });
  }

  reserveHeartbeatSequence(active: ActiveCodexSessionTicketBundle): Promise<number> {
    return this.exclusive(async () => {
      await this.assertAndLoadCheckpoint(active.stored);
      const sequence = this.checkpoint!.session!.nextHeartbeatSequence;
      const candidate = structuredClone(this.checkpoint!);
      candidate.session!.nextHeartbeatSequence = sequence + 1;
      candidate.updatedAt = this.now().toISOString();
      await this.persistCheckpointCandidate(candidate);
      return sequence;
    });
  }

  reservePendingMessage(active: ActiveCodexSessionTicketBundle, messageId: string): Promise<void> {
    return this.exclusive(async () => {
      if (!isCodexPendingMessageId(messageId)) {
        throw new Error("Codex pending checkpoint message id is invalid");
      }
      await this.assertAndLoadCheckpoint(active.stored);
      if (this.checkpoint!.pendingMessageIds.includes(messageId)) return;
      if (this.checkpoint!.pendingMessageIds.length >= 10_000) {
        throw new Error("Codex operational checkpoint pending message limit exceeded");
      }
      const candidate = structuredClone(this.checkpoint!);
      candidate.pendingMessageIds.push(messageId);
      candidate.updatedAt = this.now().toISOString();
      await this.persistCheckpointCandidate(candidate);
    });
  }

  commitEventSequence(
    active: ActiveCodexSessionTicketBundle,
    sequence: number,
    pendingMessageIds: readonly string[] = [],
  ): Promise<void> {
    return this.exclusive(async () => {
      if (!Number.isSafeInteger(sequence) || sequence <= 0) {
        throw new Error("Codex event checkpoint sequence is invalid");
      }
      await this.assertAndLoadCheckpoint(active.stored);
      if (sequence <= this.checkpoint!.eventSequence) return;
      if (sequence !== this.checkpoint!.eventSequence + 1) {
        throw new Error("Codex event checkpoint cannot skip an unprocessed Hub event");
      }
      const nextPendingMessageIds = [...this.checkpoint!.pendingMessageIds];
      for (const messageId of pendingMessageIds) {
        if (!isCodexPendingMessageId(messageId)) {
          throw new Error("Codex pending checkpoint message id is invalid");
        }
        if (!nextPendingMessageIds.includes(messageId)) {
          nextPendingMessageIds.push(messageId);
        }
      }
      if (nextPendingMessageIds.length > 10_000) {
        // Reject before mutating either the cursor or the in-memory checkpoint. Persisting a file
        // that our own parser cannot reopen would turn one oversized inbox into permanent poison.
        throw new Error("Codex operational checkpoint pending message limit exceeded");
      }
      const candidate = structuredClone(this.checkpoint!);
      candidate.pendingMessageIds = nextPendingMessageIds;
      candidate.eventSequence = sequence;
      candidate.updatedAt = this.now().toISOString();
      await this.persistCheckpointCandidate(candidate);
    });
  }

  settlePendingMessage(active: ActiveCodexSessionTicketBundle, messageId: string): Promise<void> {
    return this.exclusive(async () => {
      await this.assertAndLoadCheckpoint(active.stored);
      const before = this.checkpoint!.pendingMessageIds.length;
      const nextPendingMessageIds = this.checkpoint!.pendingMessageIds.filter(
        (entry) => entry !== messageId,
      );
      if (nextPendingMessageIds.length === before) return;
      const candidate = structuredClone(this.checkpoint!);
      candidate.pendingMessageIds = nextPendingMessageIds;
      candidate.updatedAt = this.now().toISOString();
      await this.persistCheckpointCandidate(candidate);
    });
  }

  clearAfterConfirmedClose(bundleId: string): Promise<void> {
    return this.exclusive(() => this.clearAfterConfirmedCloseOwned(bundleId));
  }

  reconcileForConfirmedClose(): Promise<{
    session: AgentSession;
    active: ActiveCodexSessionTicketBundle;
  }> {
    return this.exclusive(() => this.reconcileForConfirmedCloseOwned());
  }

  /** Exact close-only replay used by a managed DRAINING recovery before any new reservation. */
  replayConfirmedClose(): Promise<void> {
    return this.exclusive(async () => {
      const reconciled = await this.reconcileForConfirmedCloseOwned();
      const current = reconciled.active.stored;
      const session = reconciled.session;
      const closed = await this.activeProjection(current).controlHub.closeAdapterSession(
        session.id,
        {
          reason: "codex_bridge_closed",
          idempotencyKey: `codex-session-close:${session.id}:${current.launchContext.runId}`,
        },
      );
      if (
        closed.session.id !== session.id ||
        closed.ticketBinding.hubSessionId !== session.id ||
        closed.ticketBinding.bundleId !== current.bundleId
      ) {
        throw new Error("Hub close receipt does not match the durable Codex ticket bundle");
      }
      await this.clearAfterConfirmedCloseOwned(current.bundleId);
    });
  }

  private async reconcileForConfirmedCloseOwned(): Promise<{
    session: AgentSession;
    active: ActiveCodexSessionTicketBundle;
  }> {
    let snapshot = await this.load();
    let current = snapshot.current;
    if (!current || current.phase !== "ACTIVE" || !current.binding || !current.sessionReceipt) {
      throw new Error("Exact Codex close reconciliation requires a durable ACTIVE current bundle");
    }
    const successor = snapshot.successor;
    if (successor) {
      const safelyUnattempted =
        !successor.activationAttempted &&
        (successor.phase === "PREPARING" || successor.phase === "OFFERED");
      if (safelyUnattempted) {
        snapshot.successor = null;
        snapshot.cutover = null;
        await this.persist();
      } else {
        if (
          !snapshot.cutover ||
          snapshot.cutover.predecessorBundleId !== current.bundleId ||
          snapshot.cutover.successorBundleId !== successor.bundleId ||
          snapshot.cutover.predecessorSessionId !== current.sessionReceipt.id
        ) {
          throw new Error("Exact Codex close reconciliation found an unbound durable successor");
        }
        if (successor.phase !== "ACTIVE") {
          if (successor.phase !== "ACTIVATING" || !successor.activationAttempted) {
            // No Hub activation request crossed the network, so raw successor material is not an
            // ambiguous authority owner and can be discarded before closing the predecessor.
            snapshot.successor = null;
            snapshot.cutover = null;
            await this.persist();
          } else if (successor.context.activationMode === "SESSION_AUXILIARY") {
            try {
              await this.activateSuccessorOwned(
                current.sessionReceipt,
                snapshot.cutover.operationId,
              );
            } catch (error: unknown) {
              const aborted =
                error instanceof HubHttpError &&
                error.status === 409 &&
                error.code === "TICKET_ROTATION_NOT_COMMITTED" &&
                record(error.current)?.state === "ABORTED" &&
                record(error.current)?.sessionId === current.sessionReceipt.id &&
                record(error.current)?.predecessorBundleId === current.bundleId &&
                record(error.current)?.successorBundleId === successor.bundleId;
              if (!aborted) throw error;
              snapshot.successor = null;
              snapshot.cutover = null;
              await this.persist();
            }
          } else if (successor.context.activationMode === "CURRENT_HEAD_REPLACEMENT") {
            if (!successor.registrationInput) {
              throw new Error(
                "Exact Codex close reconciliation lacks the current-head replay body",
              );
            }
            await this.replaceCurrentHeadOwned(current.sessionReceipt, successor.registrationInput);
          } else {
            throw new Error("Exact Codex close reconciliation found an invalid successor mode");
          }
        }
      }
      snapshot = await this.load();
      if (snapshot.successor) {
        await this.bindCheckpointForActivated(snapshot.successor, current);
        await this.commitSuccessorOwned(snapshot.successor.bundleId, true);
        snapshot = await this.load();
      }
      current = snapshot.current;
      if (!current || current.phase !== "ACTIVE" || !current.binding || !current.sessionReceipt) {
        throw new Error(
          "Exact Codex close reconciliation could not establish the live durable head",
        );
      }
    }
    return {
      session: structuredClone(current.sessionReceipt),
      active: this.activeProjection(current),
    };
  }

  /**
   * Recover a previously registered Adapter without re-registering it. If Hub activation committed
   * before process death, replay the exact deterministic operation and surface only the durable
   * successor. The caller must complete CONTROL/socket/MODEL cutover before `commitSuccessor`.
   */
  recoverActive(
    initialContext: CodexSessionTicketContext,
    consumedReservationSessionId?: string,
  ): Promise<{
    session: AgentSession;
    active: ActiveCodexSessionTicketBundle;
    requiresCommit: boolean;
    locallyExpired: boolean;
  } | null> {
    return this.exclusive(async () => {
      const snapshot = await this.load();
      const current = snapshot.current;
      if (!current) return null;
      const startupCheckpoint = await this.loadCheckpoint(current);
      if (startupCheckpoint?.confirmedClose?.bundleId === current.bundleId) {
        // Hub close was already confirmed before the prior process died. Finish the local
        // write-ahead transaction instead of reviving a credential/session pair whose authority is
        // terminal at the Hub.
        await this.clearAfterConfirmedCloseOwned(current.bundleId);
        return null;
      }
      if (!contextMatches(current.launchContext, initialContext)) {
        throw new Error("Persisted active ticket bundle belongs to another launch binding");
      }
      if (current.phase !== "ACTIVE") {
        if (
          consumedReservationSessionId === undefined ||
          current.phase !== "ACTIVATING" ||
          !current.activationAttempted ||
          !current.registrationInput
        ) {
          return null;
        }
        const replayed = await this.registerInitialOwned(current.registrationInput);
        if (replayed.registration.session.id !== consumedReservationSessionId) {
          throw new Error("Consumed Hub reservation does not match replayed initial registration");
        }
        return {
          session: replayed.registration.session,
          active: replayed.active,
          requiresCommit: false,
          locallyExpired: this.isLocallyExpired(replayed.active.stored),
        };
      }
      if (!current.sessionReceipt) {
        throw new Error("Persisted active ticket bundle lacks its exact session receipt");
      }
      if (
        consumedReservationSessionId !== undefined &&
        current.launchSessionId !== consumedReservationSessionId
      ) {
        throw new Error(
          "Consumed Hub reservation does not match the durable Codex session receipt",
        );
      }
      if (snapshot.successor) {
        const successor = snapshot.successor;
        if (
          successor.context.activationMode !== "SESSION_AUXILIARY" &&
          successor.context.activationMode !== "CURRENT_HEAD_REPLACEMENT"
        ) {
          throw new Error("Persisted successor has an invalid activation mode");
        }
        const recovered =
          successor.context.activationMode === "CURRENT_HEAD_REPLACEMENT"
            ? successor.phase === "ACTIVE"
              ? {
                  next: this.activeProjection(successor),
                }
              : await this.replaceCurrentHeadOwned(
                  current.sessionReceipt,
                  successor.registrationInput ??
                    (() => {
                      throw new Error(
                        "Persisted current-head recovery lacks its exact replay body",
                      );
                    })(),
                )
            : await this.activateSuccessorOwned(
                current.sessionReceipt,
                snapshot.cutover?.operationId ?? `session-ticket-renewal:${current.bundleId}`,
              );
        if (!recovered.next.stored.sessionReceipt) {
          throw new Error("Recovered successor lacks its exact session receipt");
        }
        if (!snapshot.cutover) {
          snapshot.cutover = this.createCutover(
            successor.context.activationMode,
            current,
            recovered.next.stored,
            successor.context.activationMode === "SESSION_AUXILIARY"
              ? `session-ticket-renewal:${current.bundleId}`
              : successor.registrationInput!.idempotencyKey,
          );
          await this.persist();
        } else if (snapshot.cutover.phase !== "HUB_ACTIVATED") {
          // Sockets and the model child are process-local. A new Runtime must rebuild them even
          // when the previous owner had durably reached a later ephemeral cutover phase.
          snapshot.cutover.phase = "HUB_ACTIVATED";
          snapshot.cutover.updatedAt = this.now().toISOString();
          await this.persist();
        }
        await this.bindCheckpointForActivated(recovered.next.stored, current);
        return {
          session: recovered.next.stored.sessionReceipt,
          active: recovered.next,
          requiresCommit: true,
          locallyExpired: this.isLocallyExpired(recovered.next.stored),
        };
      }
      await this.bindCheckpointForActivated(current, null);
      return {
        session: current.sessionReceipt,
        active: this.activeProjection(current),
        requiresCommit: false,
        locallyExpired: this.isLocallyExpired(current),
      };
    });
  }

  private isLocallyExpired(bundle: StoredCodexSessionTicketBundle): boolean {
    if (!bundle.binding || !bundle.serverNow || !bundle.observedAt) {
      throw new Error("Codex ticket expiry requires the canonical Hub receipt clock");
    }
    const remainingAtObservation =
      Date.parse(bundle.binding.expiresAt) - Date.parse(bundle.serverNow);
    const localExpiry = Date.parse(bundle.observedAt) + remainingAtObservation;
    return !Number.isFinite(localExpiry) || localExpiry <= this.now().getTime();
  }

  private async commitSuccessorOwned(bundleId: string, forConfirmedClose = false): Promise<void> {
    const snapshot = await this.load();
    if (!snapshot.successor && snapshot.current?.bundleId === bundleId) return;
    if (
      !snapshot.successor ||
      snapshot.successor.bundleId !== bundleId ||
      snapshot.successor.phase !== "ACTIVE" ||
      !snapshot.successor.binding
    ) {
      throw new Error("Only the durable ACTIVE successor may become current");
    }
    if (!forConfirmedClose) {
      if (
        !snapshot.cutover ||
        snapshot.cutover.successorBundleId !== bundleId ||
        snapshot.cutover.phase !== "EVENTS_READY"
      ) {
        throw new Error("Codex successor cannot commit before ordered catch-up is durable");
      }
      await this.assertAndLoadCheckpoint(snapshot.successor);
    }
    snapshot.current = snapshot.successor;
    snapshot.successor = null;
    snapshot.cutover = null;
    await this.persist();
  }

  private async persistHubCommittedSuccessor(): Promise<void> {
    try {
      await this.persist();
    } catch (error: unknown) {
      throw Object.assign(
        new TypeError("Hub-committed Codex successor is not yet durable locally", {
          cause: error,
        }),
        { code: "DURABLE_SUCCESSOR_INCOMPLETE" },
      );
    }
  }

  private createCutover(
    kind: StoredCodexCredentialCutover["kind"],
    predecessor: StoredCodexSessionTicketBundle,
    successor: StoredCodexSessionTicketBundle,
    operationId: string,
  ): StoredCodexCredentialCutover {
    if (!predecessor.sessionReceipt || !successor.sessionReceipt) {
      throw new Error("Codex credential cutover requires exact predecessor and successor receipts");
    }
    return {
      kind,
      predecessorBundleId: predecessor.bundleId,
      successorBundleId: successor.bundleId,
      predecessorSessionId: predecessor.sessionReceipt.id,
      successorSessionId: successor.sessionReceipt.id,
      operationId,
      phase: "HUB_ACTIVATED",
      updatedAt: this.now().toISOString(),
    };
  }

  private createActivatingCutover(
    kind: StoredCodexCredentialCutover["kind"],
    predecessor: StoredCodexSessionTicketBundle,
    successor: StoredCodexSessionTicketBundle,
    operationId: string,
  ): StoredCodexCredentialCutover {
    if (!predecessor.sessionReceipt || successor.phase !== "ACTIVATING") {
      throw new Error("Codex credential activation requires an exact predecessor receipt");
    }
    return {
      kind,
      predecessorBundleId: predecessor.bundleId,
      successorBundleId: successor.bundleId,
      predecessorSessionId: predecessor.sessionReceipt.id,
      successorSessionId: null,
      operationId,
      phase: "HUB_ACTIVATING",
      updatedAt: this.now().toISOString(),
    };
  }

  private createBundle(
    context: CodexSessionTicketContext,
    launchContext = context,
    registrationInput: TicketRegistrationInput | null = null,
    launchSessionId: string | null = null,
    modelTransportFuseGeneration = 0,
  ): StoredCodexSessionTicketBundle {
    return {
      bundleId: createId("stb"),
      phase: "PREPARING",
      launchContext: structuredClone(launchContext),
      context: structuredClone(context),
      raw: { CONTROL: newRaw(), MODEL_MCP: newRaw(), INJECTOR: newRaw() },
      offerIds: {},
      activationAttempted: false,
      binding: null,
      rotationReceipt: null,
      sessionReceipt: null,
      launchSessionId,
      serverNow: null,
      observedAt: null,
      registrationInput: registrationInput ? structuredClone(registrationInput) : null,
      modelTransportState: "MODEL_READY",
      ...(modelTransportFuseGeneration > 0 ? { modelTransportFuseGeneration } : {}),
    };
  }

  private markActiveModelTransportState(
    bundleId: string,
    state: CodexModelTransportConfiguration,
    fuseGeneration?: number,
  ): Promise<void> {
    return this.exclusive(async () => {
      const snapshot = await this.load();
      if (
        !snapshot.current ||
        snapshot.current.bundleId !== bundleId ||
        snapshot.current.phase !== "ACTIVE" ||
        !snapshot.current.binding
      ) {
        throw new Error("Model transport state does not match the durable ACTIVE bundle");
      }
      if (state === "MODEL_CONFIGURED_OFFLINE") {
        if (!Number.isSafeInteger(fuseGeneration) || Number(fuseGeneration) <= 0) {
          throw new Error("Configured-offline model transport requires a positive fuse generation");
        }
      }
      if (snapshot.current.modelTransportState === state) {
        if (
          state === "MODEL_CONFIGURED_OFFLINE" &&
          codexModelTransportFuseGeneration(snapshot.current) !== fuseGeneration
        ) {
          throw new Error("Configured-offline model transport generation replay changed");
        }
        return;
      }
      snapshot.current.modelTransportState = state;
      if (state === "MODEL_CONFIGURED_OFFLINE") {
        snapshot.current.modelTransportFuseGeneration = fuseGeneration;
      }
      await this.persist();
    });
  }

  private async offerBundle(
    bundle: StoredCodexSessionTicketBundle,
    controlOfferer: HubClient,
  ): Promise<void> {
    if (bundle.phase === "ACTIVE" || bundle.phase === "ACTIVATING") return;
    for (const purpose of SESSION_TICKET_PURPOSES_BY_CLIENT["codex-app-server"]) {
      if (bundle.offerIds[purpose]) continue;
      const offerer = purpose === "INJECTOR" ? this.bootstrapInjectorHub : controlOfferer;
      const input: SessionTicketOfferInput = {
        bundle_id: bundle.bundleId,
        purpose,
        token_sha256: digest(bundle.raw[purpose]),
        adapter_client: "codex",
        agent_id: "codex",
        session_client: "codex-app-server",
        role: "primary",
        transport: "websocket",
        delivery_mode: "app_server_push",
        external_session_id: bundle.context.externalSessionId,
        external_thread_id: bundle.context.externalThreadId,
        run_id: bundle.context.runId,
        activation_mode: bundle.context.activationMode,
        ...(bundle.context.expectedLineageId
          ? { expected_lineage_id: bundle.context.expectedLineageId }
          : {}),
        ...(bundle.context.expectedHeadSessionId !== undefined
          ? { expected_head_session_id: bundle.context.expectedHeadSessionId }
          : {}),
        ...(bundle.context.launchReservationId
          ? { launch_reservation_id: bundle.context.launchReservationId }
          : {}),
        idempotency_key: `session-ticket-offer:${bundle.bundleId}:${purpose}`,
      };
      const offered = await offerer.createSessionTicketOffer(bundle.context.projectId, input);
      bundle.offerIds[purpose] = offered.id;
      await this.persist();
    }
    bundle.phase = "OFFERED";
    await this.persist();
  }

  private checkpointIdentity(bundle: StoredCodexSessionTicketBundle): {
    projectId: string;
    threadId: string;
    ownerRunId: string;
  } {
    const threadId = bundle.launchContext.externalThreadId;
    if (!threadId) {
      throw new Error("Codex operational checkpoint requires a stable external thread id");
    }
    return {
      projectId: bundle.launchContext.projectId,
      threadId,
      ownerRunId: bundle.launchContext.runId,
    };
  }

  private async loadCheckpoint(
    bundle: StoredCodexSessionTicketBundle,
  ): Promise<CodexSessionOperationalCheckpoint | null> {
    if (this.checkpoint !== undefined) return this.checkpoint;
    const identity = this.checkpointIdentity(bundle);
    const stored = await this.options.checkpointStore.load(identity.projectId, identity.threadId);
    this.checkpoint = stored ? parseCodexSessionOperationalCheckpoint(stored) : null;
    if (
      this.checkpoint &&
      (this.checkpoint.projectId !== identity.projectId ||
        this.checkpoint.threadId !== identity.threadId)
    ) {
      throw new Error("Codex operational checkpoint belongs to another logical thread");
    }
    return this.checkpoint;
  }

  private async finalizeOrphanedConfirmedClose(context: CodexSessionTicketContext): Promise<void> {
    const threadId = context.externalThreadId ?? context.externalSessionId;
    if (!threadId) return;
    const stored = await this.options.checkpointStore.load(context.projectId, threadId);
    if (!stored) return;
    const checkpoint = parseCodexSessionOperationalCheckpoint(stored);
    if (!checkpoint.confirmedClose) return;
    if (
      checkpoint.projectId !== context.projectId ||
      checkpoint.threadId !== threadId ||
      checkpoint.session?.bundleId !== checkpoint.confirmedClose.bundleId
    ) {
      throw new Error("Orphaned Codex confirmed close marker is inconsistent");
    }
    const completed = structuredClone(checkpoint);
    completed.session = null;
    delete completed.confirmedClose;
    completed.updatedAt = this.now().toISOString();
    await this.options.checkpointStore.save(completed);
    this.checkpoint = structuredClone(completed);
  }

  private async bindCheckpointForActivated(
    bundle: StoredCodexSessionTicketBundle,
    predecessor: StoredCodexSessionTicketBundle | null,
    allowCreate = false,
  ): Promise<void> {
    if (!bundle.binding || !bundle.sessionReceipt || bundle.phase !== "ACTIVE") {
      throw new Error("Codex operational checkpoint can bind only an ACTIVE ticket bundle");
    }
    const identity = this.checkpointIdentity(bundle);
    let existing = await this.loadCheckpoint(bundle);
    if (existing?.confirmedClose) {
      // The raw vault was already deleted but the final checkpoint save failed. A newly registered
      // lineage may reuse the logical thread only after completing that old close marker.
      const closed = structuredClone(existing);
      closed.session = null;
      delete closed.confirmedClose;
      closed.updatedAt = this.now().toISOString();
      await this.persistCheckpointCandidate(closed);
      existing = this.checkpoint ?? null;
    }
    if (!existing && !allowCreate) {
      throw new Error("Active Codex session is missing its durable operational checkpoint");
    }
    const previousSession = existing?.session ?? null;
    const predecessorMatches =
      predecessor?.binding &&
      previousSession &&
      previousSession.bundleId === predecessor.bundleId &&
      previousSession.hubSessionId === predecessor.binding.hubSessionId &&
      previousSession.lineageId === predecessor.binding.lineageId &&
      previousSession.incarnation === predecessor.binding.incarnation;
    const exactCurrent =
      previousSession &&
      previousSession.bundleId === bundle.bundleId &&
      previousSession.hubSessionId === bundle.binding.hubSessionId &&
      previousSession.lineageId === bundle.binding.lineageId &&
      previousSession.incarnation === bundle.binding.incarnation;
    const closedPriorRun = existing && existing.session === null;
    if (existing && existing.ownerRunId !== identity.ownerRunId && !closedPriorRun) {
      throw new Error("Another managed Codex run owns the operational checkpoint session");
    }
    if (existing && existing.ownerRunId === identity.ownerRunId && previousSession) {
      if (!exactCurrent && !predecessorMatches) {
        throw new Error("Codex operational checkpoint session binding is inconsistent");
      }
    }
    const sameHubSession =
      exactCurrent ||
      (predecessorMatches &&
        predecessor!.binding!.hubSessionId === bundle.binding.hubSessionId &&
        predecessor!.binding!.lineageId === bundle.binding.lineageId &&
        predecessor!.binding!.incarnation === bundle.binding.incarnation);
    const eventSequence = existing?.eventSequence ?? 0;
    const nextHeartbeatSequence = sameHubSession ? previousSession!.nextHeartbeatSequence : 1;
    const candidate: CodexSessionOperationalCheckpoint = {
      schemaVersion: 1,
      projectId: identity.projectId,
      threadId: identity.threadId,
      ownerRunId: identity.ownerRunId,
      eventSequence,
      pendingMessageIds: existing?.pendingMessageIds ?? [],
      session: {
        hubSessionId: bundle.binding.hubSessionId,
        lineageId: bundle.binding.lineageId!,
        incarnation: bundle.binding.incarnation!,
        bundleId: bundle.bundleId,
        nextHeartbeatSequence,
      },
      updatedAt: this.now().toISOString(),
    };
    await this.persistCheckpointCandidate(candidate);
  }

  private async assertAndLoadCheckpoint(bundle: StoredCodexSessionTicketBundle): Promise<void> {
    const checkpoint = await this.loadCheckpoint(bundle);
    if (
      !checkpoint?.session ||
      !bundle.binding ||
      checkpoint.ownerRunId !== bundle.launchContext.runId ||
      checkpoint.session.bundleId !== bundle.bundleId ||
      checkpoint.session.hubSessionId !== bundle.binding.hubSessionId ||
      checkpoint.session.lineageId !== bundle.binding.lineageId ||
      checkpoint.session.incarnation !== bundle.binding.incarnation
    ) {
      throw new Error("Codex operational checkpoint does not match the ACTIVE session ticket");
    }
  }

  private async clearAfterConfirmedCloseOwned(bundleId: string): Promise<void> {
    const snapshot = await this.load();
    if (snapshot.successor || snapshot.current?.bundleId !== bundleId) {
      throw new Error("Confirmed close does not match the sole durable Codex ticket bundle");
    }
    const current = snapshot.current;
    await this.assertAndLoadCheckpoint(current);
    if (this.checkpoint!.confirmedClose && this.checkpoint!.confirmedClose.bundleId !== bundleId) {
      throw new Error("Codex confirmed close marker belongs to another ticket bundle");
    }
    if (!this.checkpoint!.confirmedClose) {
      const prepared = structuredClone(this.checkpoint!);
      prepared.confirmedClose = {
        bundleId,
        state: "PREPARED",
        confirmedAt: this.now().toISOString(),
      };
      prepared.updatedAt = this.now().toISOString();
      await this.persistCheckpointCandidate(prepared);
    }

    // File-backed vaults atomically remove the raw vault plus owned recovery index here. A failed
    // write rolls the in-memory snapshot back while the PREPARED checkpoint retains the exact
    // replay identity; crucially, its session is still live rather than falsely appearing closed.
    snapshot.current = null;
    snapshot.cutover = null;
    await this.persist();

    const completed = structuredClone(this.checkpoint!);
    completed.session = null;
    delete completed.confirmedClose;
    completed.updatedAt = this.now().toISOString();
    await this.persistCheckpointCandidate(completed);
  }

  private async persistCheckpointCandidate(
    checkpoint: CodexSessionOperationalCheckpoint,
  ): Promise<void> {
    const candidate = parseCodexSessionOperationalCheckpoint(structuredClone(checkpoint));
    await this.options.checkpointStore.save(candidate);
    // Publish only after the store confirms durability. A failed save must leave this process able
    // to replay the same heartbeat/event/settlement rather than believing an unpersisted mutation.
    this.checkpoint = structuredClone(candidate);
  }

  private activeProjection(bundle: StoredCodexSessionTicketBundle): ActiveCodexSessionTicketBundle {
    if (bundle.phase !== "ACTIVE" || !bundle.binding) {
      throw new Error("Ticket bundle is not ACTIVE");
    }
    return {
      stored: structuredClone(bundle) as ActiveCodexSessionTicketBundle["stored"],
      controlHub: this.client(bundle.raw.CONTROL),
      injectorHub: this.client(bundle.raw.INJECTOR),
      modelMcpToken: bundle.raw.MODEL_MCP,
    };
  }

  private assertActivatedBinding(
    bundle: StoredCodexSessionTicketBundle,
    binding: SessionTicketBinding,
    session: AgentSession,
  ): void {
    if (
      binding.bundleId !== bundle.bundleId ||
      binding.projectId !== bundle.context.projectId ||
      binding.hubSessionId !== session.id ||
      binding.lineageId !== session.lineageId ||
      binding.incarnation !== session.incarnation ||
      binding.runId !== bundle.context.runId ||
      session.projectId !== bundle.context.projectId ||
      session.agentId !== "codex" ||
      session.client !== "codex-app-server" ||
      session.role !== "primary" ||
      session.transport !== "websocket" ||
      session.deliveryMode !== "app_server_push" ||
      (bundle.context.activationMode === "MANAGED_RESERVATION"
        ? session.launcherRunId !== bundle.context.runId
        : session.launcherRunId !== null) ||
      (bundle.context.externalSessionId !== null &&
        session.externalSessionId !== bundle.context.externalSessionId) ||
      (bundle.context.externalThreadId !== null &&
        session.externalThreadId !== bundle.context.externalThreadId) ||
      (bundle.context.expectedLineageId !== undefined &&
        binding.lineageId !== bundle.context.expectedLineageId) ||
      (bundle.context.activationMode === "CURRENT_HEAD_REPLACEMENT" &&
        (session.predecessorSessionId !== bundle.context.expectedHeadSessionId ||
          session.incarnation === null ||
          binding.incarnation === null ||
          session.incarnation <= 1)) ||
      new Set(binding.purposes.map((entry) => entry.purpose)).size !== 3 ||
      (["CONTROL", "MODEL_MCP", "INJECTOR"] as const).some(
        (purpose) => !binding.purposes.some((entry) => entry.purpose === purpose),
      ) ||
      Date.parse(binding.expiresAt) <= Date.parse(binding.activatedAt)
    ) {
      throw new Error("Hub activated the initial ticket bundle outside its requested binding");
    }
  }

  private assertSessionBinding(
    bundle: StoredCodexSessionTicketBundle,
    session: AgentSession,
  ): void {
    const binding = bundle.binding!;
    if (
      binding.hubSessionId !== session.id ||
      binding.projectId !== session.projectId ||
      binding.lineageId !== session.lineageId ||
      binding.incarnation !== session.incarnation ||
      binding.runId !== bundle.context.runId
    ) {
      throw new Error("Current ticket bundle no longer matches the live Hub session head");
    }
  }

  private assertRotation(
    previous: StoredCodexSessionTicketBundle,
    successor: StoredCodexSessionTicketBundle,
    result: RotateAdapterSessionTicketsResult,
  ): void {
    if (
      result.ticketBinding.bundleId !== successor.bundleId ||
      result.ticketBinding.hubSessionId !== previous.binding!.hubSessionId ||
      result.ticketBinding.lineageId !== previous.binding!.lineageId ||
      result.ticketBinding.incarnation !== previous.binding!.incarnation ||
      result.ticketBinding.runId !== previous.binding!.runId ||
      result.ticketBinding.expiresAt <= previous.binding!.expiresAt ||
      result.supersededTicketBinding.bundleId !== previous.bundleId ||
      result.supersededTicketBinding.state !== "SUPERSEDED" ||
      result.supersededTicketBinding.projectId !== previous.binding!.projectId ||
      result.supersededTicketBinding.hubSessionId !== previous.binding!.hubSessionId ||
      result.supersededTicketBinding.lineageId !== previous.binding!.lineageId ||
      result.supersededTicketBinding.incarnation !== previous.binding!.incarnation ||
      result.session.id !== previous.binding!.hubSessionId ||
      result.session.projectId !== previous.binding!.projectId ||
      result.session.agentId !== "codex" ||
      result.session.client !== "codex-app-server" ||
      result.session.lineageId !== previous.binding!.lineageId ||
      result.session.incarnation !== previous.binding!.incarnation ||
      result.ticketBinding.runId !== previous.binding!.runId
    ) {
      throw new Error("Hub returned a rotation receipt outside the current session binding");
    }
  }

  private client(token: string): HubClient {
    return new HubClient({
      token,
      baseUrl: this.options.baseUrl,
      fetch: this.options.fetch,
      requestTimeoutMs: this.options.requestTimeoutMs ?? 10_000,
    });
  }

  private async load(): Promise<CodexSessionTicketVaultSnapshot> {
    if (this.snapshot) return this.snapshot;
    const stored = await this.options.vault.load();
    this.snapshot = stored
      ? parseCodexSessionTicketVaultSnapshot(stored)
      : { schemaVersion: 1, current: null, successor: null, cutover: null };
    this.durableSnapshot = cloneSnapshot(this.snapshot);
    return this.snapshot;
  }

  private async persist(): Promise<void> {
    if (!this.snapshot) throw new Error("Codex session ticket vault was not loaded");
    const candidate = parseCodexSessionTicketVaultSnapshot(cloneSnapshot(this.snapshot));
    try {
      await this.options.vault.save(candidate);
      this.durableSnapshot = cloneSnapshot(candidate);
    } catch (error) {
      if (this.durableSnapshot) this.snapshot = cloneSnapshot(this.durableSnapshot);
      throw error;
    }
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const owned = this.operationTail.then(operation, operation);
    this.operationTail = owned.then(
      () => undefined,
      () => undefined,
    );
    return owned;
  }
}

export function initialTicketContext(input: {
  projectId: string;
  runId: string;
  threadId?: string;
  reservation?: SessionLaunchReservation;
}): CodexSessionTicketContext {
  if (input.reservation) {
    return {
      projectId: input.projectId,
      runId: input.runId,
      activationMode: "MANAGED_RESERVATION",
      externalSessionId: input.threadId ?? null,
      externalThreadId: input.threadId ?? null,
      expectedLineageId: input.reservation.lineageId,
      expectedHeadSessionId: input.reservation.expectedHeadSessionId,
      launchReservationId: input.reservation.id,
      launchGeneration: input.reservation.generation,
    };
  }
  return {
    projectId: input.projectId,
    runId: input.runId,
    activationMode: "FIRST_LINEAGE",
    externalSessionId: input.threadId ?? null,
    externalThreadId: input.threadId ?? null,
  };
}
