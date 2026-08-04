import { createHash, randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { resolve } from "node:path";
import {
  HubClient,
  HubHttpError,
  openProjectSocket,
  type ProjectSocketFrame,
} from "@crossagent/client";
import {
  AdapterAuthorityDeliveryCandidateSchema,
  TrustedAuthorityKeyManifestSchema,
  canonicalJson,
  choosePushAction,
  clipText,
  createId,
  extractSyntheticOriginNonce,
  refreshTrustedAuthoritySigningKeys,
  renderAdapterAuthorityDeliveryCandidate,
  renderUnverifiedCrossAgentMessage,
  verifyAndRenderAuthorityIngress,
  type AdapterAuthorityDeliveryCandidate,
  type AgentSession,
  type CrossAgentMessage,
  type DomainEvent,
  MessageSurfacePermitSchema,
  type MessageSurfacePermit,
  type PreparedSyntheticPrompt,
  type SyntheticPromptRpcMethod,
  type Project,
  type RecoveredAuthorityDelivery,
  type SessionLaunchReservation,
  type TrustedAuthorityKeyManifest,
} from "@crossagent/protocol";
import { CodexAppServer } from "./app-server.js";
import {
  AppServerRecoveryFuse,
  ModelTransportFuseOpenError,
  type AppServerRecoveryFuseStatus,
  type AppServerRecoveryIdentity,
  type AppServerRecoveryProbeCommand,
  type AppServerRecoveryProbeResult,
  type AppServerRecoveryRequired,
} from "./app-server-recovery-fuse.js";
import {
  CredentialCutoverDrain,
  type CredentialAdmission,
  type CredentialAdmissionKind,
  type CredentialDrainBarrier,
} from "./credential-cutover-drain.js";
import { HubReconnectBackoff, isHubNetworkError } from "./hub-resilience.js";
import { sanitizeModelEnvironment } from "./model-environment.js";
import type { JsonRpcMessage } from "./rpc.js";
import {
  RolloutHealthMonitor,
  RolloutSizeReader,
  type RolloutHealthSnapshot,
  type RolloutHealthThresholds,
  type ThreadRetirementRequired,
} from "./rollout-health.js";
import {
  CodexSessionTicketRuntime,
  initialTicketContext,
  type ActiveCodexSessionTicketBundle,
  type CodexSessionOperationalCheckpointStore,
  type CodexSessionTicketVault,
  codexModelTransportConfiguration,
  codexModelTransportFuseGeneration,
} from "./session-ticket-runtime.js";
import {
  SessionTicketRenewal,
  type SessionTicketLease,
  type SessionTicketRenewalClock,
} from "./session-ticket-renewal.js";

export type CodexBridgeLaunchContext =
  | {
      mode: "foreground";
    }
  | {
      mode: "managed-existing-thread";
      runId: string;
      reservation: SessionLaunchReservation;
    }
  | {
      mode: "managed-new-thread";
      runId: string;
    };

export type CodexBridgeTermination =
  | {
      reason: string;
      fatal: false;
    }
  | {
      reason: string;
      fatal: true;
      error: Error;
    };

export type CodexBridgeStopOutcome = {
  sessionExisted: boolean;
  close: {
    state: "NOT_ATTEMPTED" | "CONFIRMED" | "AMBIGUOUS";
    sessionId: string | null;
    bundleId: string | null;
  };
  localCleanup?: {
    state: "FAILED";
    error: string;
  };
};

export type CodexBridgeOptions = {
  cwd: string;
  token: string;
  /** Reserve-only bearer retained by the parent Bridge and never copied into the model process. */
  injectorToken: string;
  /** Locally provisioned key fingerprints. Hub responses can update status, never add trust roots. */
  authorityTrustManifest: TrustedAuthorityKeyManifest;
  baseUrl?: string;
  agentId?: string;
  threadId?: string;
  /**
   * Managed launches use an explicit mode so an existing-thread child can never silently fall back
   * to self-reserving when its launcher forgot the immutable Hub manifest.
   */
  launchContext?: CodexBridgeLaunchContext;
  /** Persist the resolved Codex thread before any Hub reservation/registration can fail. */
  onThreadResolved?: (threadId: string) => void | Promise<void>;
  initialPrompt?: string;
  model?: string;
  approvalPolicy?: string;
  sandbox?: string;
  codexCommand?: string;
  allowCreateProject?: boolean;
  /** Parent-verified Dashboard project attachment; static Adapter bootstrap cannot join projects. */
  projectAttachment?: { projectId: string; root: string };
  wakePolicy?: "interrupt_only" | "urgent_and_action_required" | "never";
  /**
   * `disabled` is an explicit availability compatibility mode for Hosts that do not dispatch
   * lifecycle Hooks. It retains the exact Hub authority candidate and surface permit, but does not
   * ask the Hub to bind the synthetic envelope to a live Hook capture session.
   */
  hookCaptureBindingMode?: "required" | "disabled";
  /**
   * Compatibility escape hatch for an existing ordinary delivery whose full Codex thread is too
   * large for a bounded `thread/read`. The Hub still authenticates the exact successor session,
   * lineage, recipient fence, external thread and ordinary (non-directive) surface before its CAS.
   */
  historicalDeliveryProofMode?: "required" | "disabled";
  appServer?: CodexAppServer;
  /**
   * Called whenever delivery health changes. The Bridge does not decide where health is published:
   * the CLI turns these snapshots into the file `crossagent codex --status` reads.
   */
  onHealthChange?: (health: CodexBridgeHealth) => void;
  /** Called after an unrecoverable transport replacement has closed every Bridge resource. */
  onFatalError?: (error: Error) => void | Promise<void>;
  /**
   * Called once when the Bridge itself reaches a terminal state. Managed launchers use this to
   * retire their local run record and process instead of leaving a stopped Bridge zombie alive.
   */
  onTerminated?: (termination: CodexBridgeTermination) => void | Promise<void>;
  /** No-secret local recovery request for the external OS supervisor Adapter. */
  onAppServerRecoveryRequired?: (request: AppServerRecoveryRequired) => void | Promise<void>;
  /**
   * Called once when this thread's Codex rollout has degraded far enough that it should be retired
   * in favour of a successor. No-secret, and a request rather than an instruction.
   */
  onThreadRetirementRequired?: (request: ThreadRetirementRequired) => void | Promise<void>;
  /** Overridable so tests do not have to write half a gigabyte to cross a threshold. */
  rolloutHealthThresholds?: Partial<RolloutHealthThresholds>;
  /** Seam for the rollout file, which is written by Codex and absent in tests. */
  rolloutSizeReader?: { sizeBytes: (threadId: string) => number | null };
  /** Overridable so tests do not have to wait out a real confirmation window. */
  confirmationTimeoutMs?: number;
  /** Bounds a Hub HTTP request so one black-holed connection cannot stall every later frame. */
  hubRequestTimeoutMs?: number;
  /** Bounds CONNECTING/subscribing sockets; opening TCP alone is not a usable event stream. */
  hubSubscriptionTimeoutMs?: number;
  /** Overridable so recovery tests do not wait for the production heartbeat interval. */
  heartbeatIntervalMs?: number;
  /** Bounds pre-managed initialization retries so a detached process cannot wait forever. */
  hubInitializationMaxAttempts?: number;
  /** Durable raw-ticket owner. Production CLI always supplies this; legacy tests may omit it. */
  sessionTicketVault?: CodexSessionTicketVault;
  sessionTicketVaultFactory?: (runId: string) => CodexSessionTicketVault;
  /** Non-secret, per logical-thread progress retained independently from raw ticket cleanup. */
  sessionOperationalCheckpointStore?: CodexSessionOperationalCheckpointStore;
  /** Fake-clock Seam for multi-day no-user-message regression tests. */
  sessionTicketRenewalClock?: SessionTicketRenewalClock;
  sessionTicketRenewalTiming?: {
    renewalLeadMs?: number;
    renewalJitterMs?: number;
    retryInitialMs?: number;
    retryMaxMs?: number;
    safetyMarginMs?: number;
  };
};

/**
 * End-to-end delivery health, published to whoever asked for it.
 *
 * `--status` used to report only `processExists(pid)`, which is how a Bridge whose Codex
 * notification stream had died could keep answering `running: true` while nothing reached the
 * bound task. Each field here is a separate link in the chain, so a half-alive Bridge is visible
 * without reading a log.
 */
export type CodexBridgeHealth = {
  status: "healthy" | "degraded" | "stopped";
  pid: number;
  projectId: string | null;
  sessionId: string | null;
  threadId: string | null;
  hookCaptureBindingMode: "required" | "disabled";
  /** Whether a Hub socket object is currently held (it reconnects on its own when it drops). */
  hubSocketOpen: boolean;
  /** Whether that socket has actually completed its handshake, rather than merely existing. */
  hubSocketAlive: boolean;
  lastHubEventAt: string | null;
  /**
   * Whether the app-server is answering. An explicit JSON-RPC error still counts as answering — it
   * is a live server disagreeing with us, which is the opposite of the failure being tracked here.
   */
  appServerRpcAlive: boolean;
  lastAppServerRpcAt: string | null;
  /**
   * Whether Codex notifications are still arriving. `null` until there is evidence either way, false
   * once a push went unconfirmed and nothing has arrived since — the signature of the reported
   * incident, where every other link in this list looked healthy. Tri-state rather than boolean
   * because "nothing has happened yet" is not the same claim as "the stream works".
   */
  notificationStreamAlive: boolean | null;
  /** Silence here while pushes are happening is the half-alive signature. */
  lastNotificationAt: string | null;
  lastConfirmedPushAt: string | null;
  lastUnconfirmedPushAt: string | null;
  /** The message that could not be confirmed, kept until a later push succeeds. */
  pendingMessageId: string | null;
  modelTransportState:
    "MODEL_READY" | "MODEL_RECOVERING" | "MODEL_CONFIGURED_OFFLINE" | "MODEL_HALF_OPEN";
  appServerRecoveryFuseGeneration: number;
  /**
   * How the Codex rollout behind this thread is holding up. It is reported even while `OK` because
   * the useful moment is the one before it breaks, and a size that is merely growing is not a fault.
   */
  rollout: RolloutHealthSnapshot;
  /** Non-null from an unconfirmed push until the next confirmed one clears it. */
  degradedReason: string | null;
  updatedAt: string;
};

type ThreadResult = { thread: { id: string; sessionId?: string } };
type TurnResult = { turn: { id: string; status: string } };
type PushAction = "wake" | "steer" | "inject";
type AppServerExit = { generation?: number };
type SurfaceDelivery = {
  message: CrossAgentMessage;
  permit: MessageSurfacePermit;
};

type AuthorityRecoveryTarget = RecoveredAuthorityDelivery["recoveredFor"];
type UnconfirmedSurfaceRecovery = {
  recoveredFor: AuthorityRecoveryTarget;
  permit: MessageSurfacePermit & { state: "AMBIGUOUS" };
};
type ResolvedAuthorityDelivery = {
  candidate: AdapterAuthorityDeliveryCandidate;
  verifiedModelText: string | null;
};
type RecoveredTicketedSession = {
  session: AgentSession;
  active: ActiveCodexSessionTicketBundle;
  requiresCommit: boolean;
  locallyExpired: boolean;
};
type TicketRegistrationInput = Omit<
  Parameters<HubClient["registerAdapterSession"]>[1],
  "ticket_bundle_id"
>;

/**
 * How long a wake waits for Codex to announce the turn its RPC just promised. Generous on purpose:
 * a false timeout costs one duplicate push on replay, while a timeout that is too tight would turn
 * a busy-but-healthy app-server into a permanent "undelivered".
 */
const CONFIRMATION_TIMEOUT_MS = 15_000;
/**
 * How long one confirmation `thread/read` may take, as opposed to how long the poll keeps retrying.
 *
 * The two budgets are separate because they pay for different things. The poll deadline above bounds
 * the retry window against a message that has not landed yet; this bounds a single read of the whole
 * thread, whose cost scales with a rollout that only ever grows and never shrinks. Measured on
 * codex-cli 0.145.0: a 445 MiB rollout answers `thread/read(includeTurns: true)` in 13.28s on an
 * idle app-server, serializes to 67 MB, and exceeded the generic 30s request timeout on a busy one.
 *
 * It matters most for the turn proof, which is the one durable confirmation Codex actually supports:
 * `turn/start` persists its `clientUserMessageId`, while a steered or injected item leaves nothing
 * readable behind (see docs/known-limitations.md). So a read cut short here is the difference
 * between a confirmed wake and a duplicate push on replay.
 */
const CONFIRMATION_READ_TIMEOUT_MS = 60_000;
const HISTORICAL_THREAD_READ_TIMEOUT_MS = 120_000;
/**
 * Recently confirmed client message ids, so a `turn/started` that overtakes its own RPC response
 * still counts as the confirmation for it.
 */
const CONFIRMED_CLIENT_ID_HISTORY = 32;
const HUB_EVENT_PAGE_SIZE = 5_000;
const MAX_CATCHUP_PAGES_PER_CONNECTION = 20;
const RECIPIENT_UNSETTLED_PAGE_SIZE = 500;
const MAX_DURABLE_PENDING_MESSAGES = 10_000;
const DEFAULT_TICKET_SAFETY_MARGIN_MS = 60 * 60 * 1_000;
const APP_SERVER_CRASH_RESTART_MAX_ATTEMPTS = 3;
const APP_SERVER_CRASH_RESTART_INITIAL_DELAY_MS = 250;

function assertPositiveFiniteOption(name: string, value: number | undefined): void {
  if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
    throw new RangeError(`${name} must be a finite positive number`);
  }
}

function assertPositiveSafeIntegerOption(name: string, value: number | undefined): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}

class HubSequenceGapError extends Error {
  constructor(expected: number, received: number) {
    super(`Hub event sequence gap: expected ${expected}, received ${received}`);
    this.name = "HubSequenceGapError";
  }
}

class HubResyncRequiredError extends Error {
  constructor(reason: string) {
    super(`Hub requested event resync: ${reason}`);
    this.name = "HubResyncRequiredError";
  }
}

class HubSocketRetryableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "HubSocketRetryableError";
  }
}
/**
 * Recipient states that are finished with. A restarted Bridge replays the project event stream from
 * sequence zero, and these must not be injected a second time.
 */
const TERMINAL_RECIPIENT_STATES = ["PROCESSED", "RESPONDED", "EXPIRED"];
/**
 * Recipient states that prove Codex actually surfaced the message, whatever the push reported at the
 * time. ACKNOWLEDGED is the important one: an ACK can only be written by Codex after it saw the
 * message, so it retroactively settles a push that timed out waiting for confirmation.
 */
const SURFACED_RECIPIENT_STATES = ["ACKNOWLEDGED", "PROCESSED", "RESPONDED"];

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Child stderr may contain prompts, local paths, or credentials echoed by a failed launcher. Keep
 * enough evidence to correlate an incident without ever copying the free-form bytes into a Bridge
 * log, health reason, Supervisor request, or terminal callback.
 */
function describeAppServerExit(result: unknown): string {
  const record = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
  const stderr = typeof record.stderr === "string" ? record.stderr : "";
  const summary = {
    exitCode:
      typeof record.exitCode === "number" && Number.isSafeInteger(record.exitCode)
        ? record.exitCode
        : null,
    generation:
      typeof record.generation === "number" && Number.isSafeInteger(record.generation)
        ? record.generation
        : null,
    stderrBytes: Buffer.byteLength(stderr, "utf8"),
    stderrSha256: createHash("sha256").update(stderr, "utf8").digest("hex"),
    reason: stderr.length > 0 ? "APP_SERVER_STDERR_PRESENT" : "APP_SERVER_EXITED",
  };
  return `Codex app-server exited unexpectedly: ${JSON.stringify(summary)}`;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

/** Codex reports the turn as either a bare id or a nested object depending on the notification. */
function notifiedTurnId(message: JsonRpcMessage): string | undefined {
  const params = message.params ?? {};
  const turn =
    params.turn && typeof params.turn === "object"
      ? (params.turn as Record<string, unknown>)
      : undefined;
  return stringValue(params.turnId) ?? stringValue(turn?.id);
}

/** A confirmation is a (turn, message) pair: either half alone is not proof the wake landed. */
function announcement(turnId: string, clientId: string): string {
  return `${turnId} ${clientId}`;
}

/** Every client message id a notification announces, so the race against its own RPC is covered. */
function notifiedClientIds(message: JsonRpcMessage): string[] {
  const found: string[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) walk(entry);
      return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    const clientId = stringValue(record.clientId);
    if (clientId) found.push(clientId);
    for (const entry of Object.values(record)) walk(entry);
  };
  walk(message.params ?? {});
  return found;
}

/**
 * Whether some Codex payload durably holds this CrossAgent message.
 *
 * Two markers, because the protocol produces two shapes. An item created by `turn/start` or
 * `turn/steer` carries the `clientUserMessageId` we passed as `clientId` — that is the strong,
 * per-message correlation the report asked for. `thread/inject_items` instead takes raw Responses API
 * items, which have no `clientId` field at all, so the only durable trace of an injected message is
 * the `event_id` marker `compactCodexEvent` writes into its text.
 *
 * Walked structurally rather than matched against a fixed path: `turn/started` nests items under a
 * turn while `thread/read` nests them under turns under a thread, and both should confirm.
 */
function holdsMessage(value: unknown, messageId: string): boolean {
  if (typeof value === "string") return value.includes(`event_id="${messageId}"`);
  if (Array.isArray(value)) return value.some((entry) => holdsMessage(entry, messageId));
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record.clientId === messageId) return true;
    return Object.values(record).some((entry) => holdsMessage(entry, messageId));
  }
  return false;
}

/** A durable wake is proof only when the exact turn returned by `turn/start` holds the marker. */
function threadTurnHoldsMessage(value: unknown, turnId: string, messageId: string): boolean {
  if (!value || typeof value !== "object") return false;
  const response = value as Record<string, unknown>;
  const thread =
    response.thread && typeof response.thread === "object"
      ? (response.thread as Record<string, unknown>)
      : response;
  if (!Array.isArray(thread.turns)) return false;
  return thread.turns.some(
    (turn) =>
      Boolean(turn) &&
      typeof turn === "object" &&
      stringValue((turn as Record<string, unknown>).id) === turnId &&
      holdsMessage(turn, messageId),
  );
}

function unconfirmedSurfaceRecovery(value: unknown): UnconfirmedSurfaceRecovery | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const parsedPermit = MessageSurfacePermitSchema.safeParse(record.permit);
  if (!parsedPermit.success || parsedPermit.data.state !== "AMBIGUOUS") return null;
  if (!record.recoveredFor || typeof record.recoveredFor !== "object") return null;
  const recoveredFor = record.recoveredFor as Record<string, unknown>;
  const kind = stringValue(recoveredFor.kind);
  const sessionId = stringValue(recoveredFor.sessionId);
  const sessionIncarnation = recoveredFor.sessionIncarnation;
  if (
    !sessionId ||
    typeof sessionIncarnation !== "number" ||
    !Number.isSafeInteger(sessionIncarnation) ||
    sessionIncarnation < 0
  ) {
    return null;
  }
  if (kind === "CURRENT_SESSION") {
    return {
      permit: { ...parsedPermit.data, state: "AMBIGUOUS" },
      recoveredFor: { kind, sessionId, sessionIncarnation },
    };
  }
  const lineageId = stringValue(recoveredFor.lineageId);
  if (kind !== "LINEAGE_HANDOFF" || !lineageId) return null;
  return {
    permit: { ...parsedPermit.data, state: "AMBIGUOUS" },
    recoveredFor: { kind, sessionId, sessionIncarnation, lineageId },
  };
}

/**
 * Adapter telemetry is best-effort metadata, but the Hub validates every field length.
 * Codex emits unbounded values (long shell commands, stack traces, wide change sets), so clip
 * to the documented limits here instead of letting the Hub reject the whole event.
 */
function clipValue(value: string | undefined, maxChars: number): string | undefined {
  return value === undefined ? undefined : clipText(value, maxChars);
}

function adapterEventKey(sessionId: string, method: string, identity: string): string {
  const digest = createHash("sha256")
    .update(method)
    .update("\0")
    .update(identity)
    .digest("hex")
    .slice(0, 32);
  return `codex-event:${clipText(sessionId, 128)}:${digest}`;
}

function rpcErrorCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "number" ? code : undefined;
}

function isRpcErrorResponse(error: unknown): boolean {
  return rpcErrorCode(error) !== undefined;
}

type SurfaceRpcMethod = "turn/start" | "turn/steer" | "thread/inject_items";

const PRE_SIDE_EFFECT_RPC_CODES: Readonly<Record<SurfaceRpcMethod, ReadonlySet<number>>> = {
  "turn/start": new Set([-32700, -32600, -32601, -32602]),
  "turn/steer": new Set([-32700, -32600, -32601, -32602]),
  "thread/inject_items": new Set([-32700, -32600, -32601, -32602]),
};

/**
 * Only protocol/parameter rejection proves the handler could not apply user input. Internal and
 * vendor errors are indeterminate even when they carry a numeric JSON-RPC code.
 */
function isProvenPreSideEffectRpcRejection(method: SurfaceRpcMethod, error: unknown): boolean {
  const code = rpcErrorCode(error);
  return code !== undefined && PRE_SIDE_EFFECT_RPC_CODES[method].has(code);
}

function isAppServerRequestTimeout(method: string, error: unknown): boolean {
  return (
    error instanceof Error && error.message === `Codex app-server request timed out: ${method}`
  );
}

function isIndeterminateAppServerTransportFailure(
  method: SurfaceRpcMethod,
  error: unknown,
): boolean {
  if (isAppServerRequestTimeout(method, error)) return true;
  if (!(error instanceof Error)) return false;
  return [
    "Codex app-server stream closed",
    "Codex app-server connection closed",
    "Codex app-server is not running",
  ].includes(error.message);
}

function itemMetadata(params: Record<string, unknown>): {
  itemType?: string;
  itemId?: string;
  commandName?: string;
  exitCode?: number | null;
  files?: string[];
  status?: string;
  error?: string;
} {
  const item = params.item;
  if (!item || typeof item !== "object") return {};
  const record = item as Record<string, unknown>;
  const changes = Array.isArray(record.changes) ? record.changes : [];
  const files = changes
    .map((entry) =>
      entry && typeof entry === "object"
        ? stringValue((entry as Record<string, unknown>).path)
        : undefined,
    )
    .filter((value): value is string => Boolean(value));
  return {
    itemType: clipValue(stringValue(record.type), 120),
    itemId: clipValue(stringValue(record.id), 200),
    commandName: clipValue(
      stringValue(record.command) ??
        (Array.isArray(record.command)
          ? record.command.map(String).slice(0, 4).join(" ")
          : undefined),
      200,
    ),
    exitCode: typeof record.exitCode === "number" ? record.exitCode : null,
    files: files.slice(0, 200).map((path) => clipText(path, 1000)),
    status: clipValue(stringValue(record.status), 100),
    error: clipValue(stringValue(record.error), 4000),
  };
}

export function compactCodexEvent(message: CrossAgentMessage): string {
  return `<CrossAgentEvent priority="${message.priority}" event_id="${message.id}" thread_id="${message.threadId}">
${renderUnverifiedCrossAgentMessage({
  senderAgentId: message.fromAgentId,
  content: message.summary,
})}
处理要求：通过 CrossAgent 获取详情；看到后 ACK；需要回复时复用 thread_id。不要因普通状态偏离当前任务。
</CrossAgentEvent>`;
}

/**
 * Injected into a freshly created thread so Codex writes its rollout to disk.
 *
 * It is visible in the transcript, so it says what it is rather than looking like stray input.
 * A no-footprint alternative does not exist: `thread/read` leaves the thread unpersisted and
 * `thread/inject_items` rejects an empty item list.
 */
const NEW_THREAD_PERSISTENCE_ANCHOR = "CrossAgent Hub is connected to this thread.";

export class CodexBridge {
  private hub: HubClient;
  private syntheticHub: HubClient;
  private readonly authorityTrustManifest: TrustedAuthorityKeyManifest;
  private readonly hookCaptureBindingMode: "required" | "disabled";
  private readonly historicalDeliveryProofMode: "required" | "disabled";
  private readonly appServer: CodexAppServer;
  private readonly sessionTicketRuntime: CodexSessionTicketRuntime | null;
  private activeTickets: ActiveCodexSessionTicketBundle | null = null;
  private ticketRenewal: SessionTicketRenewal | null = null;
  private ticketRegistrationInput: TicketRegistrationInput | null = null;
  private ticketCriticalRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private ticketCriticalRecoveryInFlight: Promise<void> | null = null;
  private ticketCriticalRecoveryFailures = 0;
  private credentialCutoverInFlight: Promise<SessionTicketLease> | null = null;
  private readonly credentialDrain = new CredentialCutoverDrain();
  private credentialPlaneCritical = false;
  /** Narrow exception while an exact successor has MODEL ready but ordered catch-up is unfinished. */
  private credentialRecoveryDataPlaneReady = false;
  private readonly credentialSafePointWaiters = new Set<{
    resolve: () => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout> | null;
  }>();
  private modelTransportReady = false;
  private readonly modelTransportWaiters = new Set<{
    resolve: () => void;
    reject: (error: Error) => void;
  }>();
  private controlSocketToken: string;
  private currentModelMcpToken: string | null;
  private project: Pick<Project, "id"> | null = null;
  private session: AgentSession | null = null;
  private socket: WebSocket | null = null;
  private socketGeneration = 0;
  private socketSubscribed = false;
  private socketHandshakeGeneration: number | null = null;
  private hubFrameTail: Promise<void> = Promise.resolve();
  private reconnectTimer: NodeJS.Timeout | null = null;
  private subscriptionWatchdog: NodeJS.Timeout | null = null;
  private socketSubscriptionWaiter: {
    generation: number;
    resolve: () => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  } | null = null;
  private initializationRetryTimer: NodeJS.Timeout | null = null;
  private initializationRetryWake: (() => void) | null = null;
  private readonly initializationBackoff = new HubReconnectBackoff();
  private readonly socketReconnectBackoff = new HubReconnectBackoff();
  private threadId: string | null = null;
  /** Whether Codex has written this thread's rollout, which is what makes it resumable. */
  private threadRolloutPersisted = false;
  private readonly rolloutHealth: RolloutHealthMonitor;
  private readonly rolloutSize: { sizeBytes: (threadId: string) => number | null };
  private threadRetirementPublished = false;
  private activeTurnId: string | null = null;
  private heartbeatSequence = 0;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private heartbeatInFlight: {
    sessionId: string;
    bundleId: string | null;
    promise: Promise<void>;
  } | null = null;
  private heartbeatAdmissionInFlight: Promise<void> | null = null;
  private coalesceTimer: NodeJS.Timeout | null = null;
  private importantQueue: CrossAgentMessage[] = [];
  private normalQueue: CrossAgentMessage[] = [];
  private lastSequence = 0;
  private durablePendingMessageIds: string[] = [];
  private stopped = false;
  private stopPromise: Promise<CodexBridgeStopOutcome> | null = null;
  private terminalStopOutcome: CodexBridgeStopOutcome | null = null;
  private terminationPromise: Promise<void> | null = null;
  private initializationPromise: Promise<typeof this.state> | null = null;
  /** One replacement owner; every app-server caller waits for the same readiness result. */
  private transportRestartInFlight: Promise<void> | null = null;
  private readonly appServerRecoveryFuse = new AppServerRecoveryFuse({
    maxAutomaticAttempts: APP_SERVER_CRASH_RESTART_MAX_ATTEMPTS,
  });
  private appServerCrashRecoveryInFlight: Promise<void> | null = null;
  private appServerCrashRecoveryOwner: { crashedGeneration: number | null } | null = null;
  private appServerCrashRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private appServerCrashRecoveryWake: (() => void) | null = null;
  private activeAppServerGeneration: number | null = null;
  private appServerHalfOpenCrashObserved = false;
  private pushSequence = 0;
  private degradedReason: string | null = null;
  private hubHttpUnavailableReason: string | null = null;
  private hubSocketUnavailableReason: string | null = null;
  private lastHubEventAt: string | null = null;
  private lastAppServerRpcAt: string | null = null;
  private appServerRpcAlive = true;
  private lastNotificationAt: string | null = null;
  private notificationSequence = 0;
  private notificationStreamEvidence: boolean | null = null;
  private lastConfirmedPushAt: string | null = null;
  private lastUnconfirmedPushAt: string | null = null;
  /** Ambiguous surfaces stay independently visible until that exact recipient is reconciled. */
  private readonly ambiguousMessageReasons = new Map<string, string>();
  /** Process-local proof coordinates used for bounded late durable reconciliation. */
  private readonly ambiguousSurfaceProofs = new Map<
    string,
    { action: PushAction; externalTurnId?: string }
  >();
  /**
   * The subset of the above whose ambiguity is codex-cli 0.145.0 behaving as measured rather than
   * anything here failing: the RPC was accepted and the input reached the model, but Codex writes
   * back nothing readable for it, so no read can ever confirm it (docs/known-limitations.md).
   *
   * They stay fully ambiguous — replayable, never reported delivered — and only stop counting as
   * Bridge ill-health. A Bridge that is working exactly as this Codex version allows should not
   * report itself broken, because a health signal that is always red stops being read.
   */
  private readonly unreadableSurfaceMessageIds = new Set<string>();
  private readonly confirmedClientIds: string[] = [];
  /**
   * Messages Codex has already confirmed receiving in this session. Replay after a restart is a
   * different session and must still recover unresolved DELIVERED work, so this is per-session on
   * purpose: it stops one session pushing the same message twice without giving up the cross-restart
   * recovery property.
   */
  private readonly confirmedMessageIds = new Set<string>();
  /**
   * Messages whose Hub state write also succeeded. Tracked apart from confirmation because the two
   * can come apart: if Codex accepted the message and only the Hub write failed, the retry owes a
   * Hub write and must not push the message at Codex a second time.
   */
  private readonly deliveredMessageIds = new Set<string>();
  /** Confirmed Codex surfaces whose idempotent Hub state write still needs retrying. */
  private readonly pendingDeliveryStates = new Map<string, CrossAgentMessage>();
  /** Terminal Hub work whose local checkpoint save is retried without reopening the model Seam. */
  private operationalHydrationRetryPending = false;
  /** One bounded thread snapshot serves every predecessor ambiguity in the current hydration pass. */
  private operationalRecoveryThreadSnapshot: Promise<unknown | null> | null = null;
  private readonly deliveryWritesInFlight = new Map<string, Promise<void>>();
  /** Exact server-side authority for crossing the app-server surface Seam. */
  private readonly surfacePermits = new Map<string, MessageSurfacePermit>();
  /** In-flight pushes keyed by message, so two events for one message cannot both push it. */
  private readonly pushesInFlight = new Map<string, Promise<void>>();
  /** Ordered events observed during a closed credential epoch; cursor advances, model work waits. */
  private readonly deferredCredentialMessages = new Map<string, CrossAgentMessage>();
  private deferredCredentialFlushInFlight: Promise<void> | null = null;
  private claimSequence = 0;
  private surfaceSequence = 0;
  /** A queue has one drain owner; otherwise two owners can both shift after awaiting one push. */
  private importantFlushInFlight: Promise<void> | null = null;
  private normalFlushInFlight: Promise<void> | null = null;
  /** Ambiguous Codex pushes wait for a real safe checkpoint, never a routine Hub heartbeat. */
  private readonly pausedAmbiguousMessages = new Set<string>();
  private readonly notificationWaiters = new Set<{
    matches: (message: JsonRpcMessage) => boolean;
    resolve: () => void;
  }>();
  // Stable across retries inside one Bridge instance, unique across process restarts. Reusing
  // only the Codex thread id here would resurrect a previously CLOSED Hub session.
  private readonly launcherRunId: string;
  private readonly sessionRegistrationKey: string;

  constructor(private readonly options: CodexBridgeOptions) {
    if (!options.injectorToken || options.injectorToken === options.token) {
      throw new Error("Codex Bridge requires a distinct synthetic injector credential");
    }
    const parsedTrustManifest = TrustedAuthorityKeyManifestSchema.parse(
      options.authorityTrustManifest,
    );
    for (const key of parsedTrustManifest.keys) Object.freeze(key);
    Object.freeze(parsedTrustManifest.keys);
    this.authorityTrustManifest = Object.freeze(parsedTrustManifest);
    this.hookCaptureBindingMode = options.hookCaptureBindingMode ?? "required";
    this.historicalDeliveryProofMode = options.historicalDeliveryProofMode ?? "required";
    this.rolloutHealth = new RolloutHealthMonitor({ thresholds: options.rolloutHealthThresholds });
    this.rolloutSize = options.rolloutSizeReader ?? new RolloutSizeReader();
    assertPositiveFiniteOption("hubRequestTimeoutMs", options.hubRequestTimeoutMs);
    assertPositiveFiniteOption("hubSubscriptionTimeoutMs", options.hubSubscriptionTimeoutMs);
    assertPositiveFiniteOption("heartbeatIntervalMs", options.heartbeatIntervalMs);
    assertPositiveSafeIntegerOption(
      "hubInitializationMaxAttempts",
      options.hubInitializationMaxAttempts,
    );
    const launchContext = options.launchContext ?? { mode: "foreground" };
    if (launchContext.mode === "managed-existing-thread") {
      if (!launchContext.reservation) {
        throw new Error("Managed existing-thread launch requires a Hub reservation manifest");
      }
      if (!launchContext.runId) {
        throw new Error("Managed existing-thread launch requires a launcher run id");
      }
      if (!options.threadId) {
        throw new Error("Managed existing-thread launch requires a Codex thread id");
      }
      if (launchContext.reservation.runId !== launchContext.runId) {
        throw new Error("Launcher run id does not match the supplied Hub reservation");
      }
      if (launchContext.reservation.identityValue !== options.threadId) {
        throw new Error("Hub launch reservation does not match this Codex Bridge thread");
      }
      if (
        launchContext.reservation.state !== "ISSUED" &&
        !(
          launchContext.reservation.state === "CONSUMED" &&
          launchContext.reservation.consumedSessionId &&
          (options.sessionTicketVault || options.sessionTicketVaultFactory)
        )
      ) {
        throw new Error("Hub launch reservation is not issued");
      }
    } else if (launchContext.mode === "managed-new-thread") {
      if (!launchContext.runId) {
        throw new Error("Managed new-thread launch requires a launcher run id");
      }
      if (options.threadId) {
        throw new Error("Managed new-thread launch cannot resume an existing Codex thread");
      }
    } else if (launchContext.mode !== "foreground") {
      throw new Error("Unknown Codex Bridge launch mode");
    }
    this.launcherRunId =
      launchContext.mode === "foreground" ? createId("run") : launchContext.runId;
    this.sessionRegistrationKey = `codex-session:${this.launcherRunId}`;
    if (options.sessionTicketVault && options.sessionTicketVaultFactory) {
      throw new Error("Codex Bridge accepts one session ticket vault owner");
    }
    const sessionTicketVault =
      options.sessionTicketVault ?? options.sessionTicketVaultFactory?.(this.launcherRunId);
    if (sessionTicketVault && !options.sessionOperationalCheckpointStore) {
      throw new Error("Ticketed Codex Bridge requires an operational checkpoint store");
    }
    this.controlSocketToken = options.token;
    this.currentModelMcpToken = sessionTicketVault ? null : options.token;
    this.hub = new HubClient({
      baseUrl: options.baseUrl,
      token: options.token,
      requestTimeoutMs: options.hubRequestTimeoutMs ?? 10_000,
    });
    this.sessionTicketRuntime = sessionTicketVault
      ? new CodexSessionTicketRuntime({
          baseUrl: options.baseUrl,
          bootstrapAgentToken: options.token,
          bootstrapInjectorToken: options.injectorToken,
          vault: sessionTicketVault,
          checkpointStore: options.sessionOperationalCheckpointStore!,
          requestTimeoutMs: options.hubRequestTimeoutMs ?? 10_000,
          now: () => new Date(options.sessionTicketRenewalClock?.now() ?? Date.now()),
        })
      : null;
    this.syntheticHub = new HubClient({
      baseUrl: options.baseUrl,
      token: options.injectorToken,
      requestTimeoutMs: options.hubRequestTimeoutMs ?? 10_000,
    });
    const hubUrl = (
      options.baseUrl ??
      process.env.CROSSAGENT_URL ??
      `http://127.0.0.1:${Number(process.env.CROSSAGENT_PORT ?? 4387)}`
    ).replace(/\/$/, "");
    this.appServer =
      options.appServer ??
      new CodexAppServer({
        command: options.codexCommand,
        cwd: options.cwd,
        experimentalApi: true,
        environment: sanitizeModelEnvironment(process.env, this.currentModelMcpToken ?? undefined),
        argsPrefix: [
          "-c",
          `mcp_servers.crossagent.url=${JSON.stringify(`${hubUrl}/mcp`)}`,
          "-c",
          'mcp_servers.crossagent.bearer_token_env_var="CROSSAGENT_TOKEN"',
        ],
      });
  }

  get state(): {
    projectId?: string;
    sessionId?: string;
    threadId?: string;
    activeTurnId?: string;
    lastSequence: number;
  } {
    return {
      projectId: this.project?.id,
      sessionId: this.session?.id,
      threadId: this.threadId ?? undefined,
      activeTurnId: this.activeTurnId ?? undefined,
      lastSequence: this.lastSequence,
    };
  }

  /** Authoritative teardown evidence for launch managers; a caught startup error is not evidence. */
  get lastStopOutcome(): CodexBridgeStopOutcome | null {
    return this.terminalStopOutcome ? structuredClone(this.terminalStopOutcome) : null;
  }

  get appServerRecoveryStatus(): AppServerRecoveryFuseStatus {
    return this.appServerRecoveryFuse.status;
  }

  async probeAppServerRecovery(
    command: AppServerRecoveryProbeCommand,
  ): Promise<AppServerRecoveryProbeResult> {
    let drain: CredentialDrainBarrier | null = null;
    const result = await this.appServerRecoveryFuse.probe(command, async () => {
      drain = this.credentialDrain.beginDrain(
        `external app-server recovery probe ${command.commandId}`,
      );
      await drain.drained;
      this.ensureRunning("external app-server recovery probe");
      this.appServerHalfOpenCrashObserved = false;
      await this.restartTransport(
        `external recovery probe ${command.commandGeneration}`,
        false,
        false,
      );
      if (this.appServerHalfOpenCrashObserved) {
        throw new TypeError("Replacement app-server exited during the half-open probe");
      }
      if (this.sessionTicketRuntime && this.activeTickets) {
        await this.sessionTicketRuntime.markActiveModelTransportReady(
          this.activeTickets.stored.bundleId,
        );
        this.activeTickets.stored.modelTransportState = "MODEL_READY";
      }
    });
    if (result.kind === "RECOVERED") {
      this.modelTransportReady = true;
      this.releaseModelTransportWaiters();
      this.degradedReason = null;
    } else {
      this.modelTransportReady = false;
    }
    if (drain && this.credentialDrain.phase === "DRAINING") {
      this.credentialDrain.reopen(drain);
    }
    if (result.kind === "RECOVERED") this.scheduleDeferredCredentialFlush();
    this.emitHealth();
    return result;
  }

  private assertLaunchReservation(
    reservation: SessionLaunchReservation,
    projectId: string,
    threadId: string | null,
    deferConsumedProof = false,
  ): void {
    const matches =
      reservation.projectId === projectId &&
      reservation.agentId === (this.options.agentId ?? "codex") &&
      reservation.client === "codex-app-server" &&
      reservation.deliveryMode === "app_server_push" &&
      reservation.identityKind === "external_thread" &&
      (threadId === null || reservation.identityValue === threadId) &&
      reservation.runId === this.launcherRunId &&
      (reservation.state === "ISSUED" ||
        (deferConsumedProof &&
          reservation.state === "CONSUMED" &&
          reservation.consumedSessionId !== null));
    if (!matches) {
      throw new Error("Hub launch reservation does not match this Codex Bridge identity");
    }
  }

  async start(): Promise<typeof this.state> {
    if (this.stopPromise) {
      throw new Error("A stopped Codex Bridge instance cannot be started again");
    }
    this.stopped = false;
    const initialization = this.initialize();
    this.initializationPromise = initialization;
    try {
      return await initialization;
    } catch (error: unknown) {
      try {
        await this.stop();
      } catch (cleanupError: unknown) {
        process.stderr.write(
          `[crossagent] Bridge initialization cleanup failed: ${describeError(cleanupError)}\n`,
        );
      }
      throw error;
    } finally {
      if (this.initializationPromise === initialization) {
        this.initializationPromise = null;
      }
    }
  }

  private async initialize(): Promise<typeof this.state> {
    const attachment = this.options.projectAttachment;
    if (attachment) {
      const normalizeLocalPath = (value: string) => {
        const normalized = resolve(value).replace(/[\\/]+$/u, "");
        return process.platform === "win32" ? normalized.toLowerCase() : normalized;
      };
      if (
        !attachment.projectId.startsWith("prj_") ||
        normalizeLocalPath(attachment.root) !== normalizeLocalPath(this.options.cwd)
      ) {
        throw new Error("Verified CrossAgent project attachment does not match the Bridge cwd");
      }
    }
    const joined = attachment
      ? { project: { id: attachment.projectId }, root: attachment.root, created: false }
      : await this.retryHubInitialization("project join", () =>
          this.hubRequest("project join", () =>
            this.hub.joinProject({
              cwd: this.options.cwd,
              allowCreate: this.options.allowCreateProject ?? true,
            }),
          ),
        );
    this.ensureRunning("project join");
    this.project = joined.project;
    const launchContext = this.options.launchContext ?? { mode: "foreground" };
    let recoveredTicketedSession: RecoveredTicketedSession | null = null;
    let launchReservation =
      launchContext.mode === "managed-existing-thread" ? launchContext.reservation : undefined;
    if (launchReservation) {
      this.assertLaunchReservation(
        launchReservation,
        joined.project.id,
        this.options.threadId ?? null,
        launchReservation.state === "CONSUMED",
      );
    } else if (this.options.threadId) {
      launchReservation = await this.retryHubInitialization("session launch reservation", () =>
        this.hubRequest("session launch reservation", () =>
          this.hub.reserveSessionLaunch(joined.project.id, {
            agentId: this.options.agentId ?? "codex",
            client: "codex-app-server",
            deliveryMode: "app_server_push",
            externalSessionId: this.options.threadId,
            externalThreadId: this.options.threadId,
            runId: this.launcherRunId,
            idempotencyKey: `codex-launch:${this.launcherRunId}`,
          }),
        ),
      );
    }
    this.ensureRunning("session launch reservation");
    if (this.sessionTicketRuntime && launchReservation) {
      const context = initialTicketContext({
        projectId: joined.project.id,
        runId: this.launcherRunId,
        threadId: this.options.threadId,
        reservation: launchReservation,
      });
      recoveredTicketedSession = await this.retryHubInitialization("active ticket recovery", () =>
        this.sessionTicketRuntime!.recoverActive(
          context,
          launchReservation!.state === "CONSUMED"
            ? (launchReservation!.consumedSessionId ?? undefined)
            : undefined,
        ),
      );
      if (launchReservation.state === "CONSUMED" && !recoveredTicketedSession) {
        throw new Error("Consumed Hub reservation has no exact durable Codex recovery proof");
      }
      if (recoveredTicketedSession?.locallyExpired) {
        if (recoveredTicketedSession.requiresCommit) {
          // Both the predecessor and recovered successor can age out while the process is down.
          // Make the Hub-confirmed successor the sole local recovery head before replacing it;
          // no expired credential crosses heartbeat/socket/MODEL seams.
          await this.sessionTicketRuntime.adoptExpiredSuccessorForRecovery(
            recoveredTicketedSession.active.stored.bundleId,
          );
          recoveredTicketedSession = {
            ...recoveredTicketedSession,
            requiresCommit: false,
          };
        }
        const storedInput = recoveredTicketedSession.active.stored.registrationInput;
        if (!storedInput) {
          throw new Error("Expired Codex ticket recovery lacks its durable registration template");
        }
        const replacementInput = this.currentHeadReplacementInput(
          recoveredTicketedSession.session,
          storedInput,
        );
        const recoveredHead = await this.retryHubInitialization(
          "expired current-head ticket recovery",
          () =>
            this.sessionTicketRuntime!.recoverCriticalSuccessor(
              recoveredTicketedSession!.active.stored.bundleId,
              replacementInput,
            ),
        );
        recoveredTicketedSession = {
          session: recoveredHead.session,
          active: recoveredHead.next,
          requiresCommit: true,
          locallyExpired: false,
        };
      }
      const recoveredOrPrepared =
        recoveredTicketedSession ??
        (await this.retryHubInitialization("initial ticket offer", () =>
          this.sessionTicketRuntime!.prepareInitial(context),
        ));
      if ("active" in recoveredOrPrepared) {
        this.activeTickets = recoveredOrPrepared.active;
        this.session = recoveredOrPrepared.session;
        this.hub = recoveredOrPrepared.active.controlHub;
        this.syntheticHub = recoveredOrPrepared.active.injectorHub;
        this.controlSocketToken = recoveredOrPrepared.active.stored.raw.CONTROL;
        this.currentModelMcpToken = recoveredOrPrepared.active.modelMcpToken;
        this.threadId = recoveredOrPrepared.session.externalThreadId;
        if (!this.threadId || this.threadId !== this.options.threadId) {
          throw new Error("Recovered ticketed session does not match the requested Codex thread");
        }
        await this.restoreOperationalCheckpoint(recoveredOrPrepared.active);
      } else {
        this.currentModelMcpToken = recoveredOrPrepared.raw.MODEL_MCP;
      }
      this.appServer.replaceEnvironment(
        sanitizeModelEnvironment(process.env, this.currentModelMcpToken),
      );
    }
    const startsModelConfiguredOffline = Boolean(
      this.activeTickets &&
      codexModelTransportConfiguration(this.activeTickets.stored) === "MODEL_CONFIGURED_OFFLINE",
    );
    if (startsModelConfiguredOffline) {
      const fuseGeneration = codexModelTransportFuseGeneration(this.activeTickets!.stored);
      const request = this.appServerRecoveryFuse.restoreConfiguredOffline(
        this.currentAppServerRecoveryIdentity(),
        fuseGeneration,
      );
      this.modelTransportReady = false;
      this.appServerRpcAlive = false;
      this.degradedReason = "Codex app-server remains configured offline after process recovery";
      this.publishAppServerRecoveryRequired(request);
    } else if (this.activeTickets) {
      const fuseGeneration = codexModelTransportFuseGeneration(this.activeTickets.stored);
      if (fuseGeneration > 0) {
        this.appServerRecoveryFuse.restoreReadyIdentity(
          this.currentAppServerRecoveryIdentity(),
          fuseGeneration,
        );
      }
    }
    let capabilities: { methods: string[]; experimentalApi: boolean };
    if (startsModelConfiguredOffline) {
      const durableCapabilities =
        this.activeTickets?.stored.registrationInput?.capabilities ??
        this.session?.capabilities ??
        [];
      capabilities = {
        methods: durableCapabilities.filter(
          (entry) =>
            entry !== "crossagent-mcp" && entry !== "experimentalApi" && entry !== "stableApi",
        ),
        experimentalApi: durableCapabilities.includes("experimentalApi"),
      };
    } else {
      await this.appServer.start();
      if (this.stopped) {
        await this.appServer.stop();
        this.ensureRunning("app-server start");
      }
      this.captureAppServerGeneration();
      capabilities = await this.appServer.probeCapabilities();
      this.ensureRunning("capability probe");
    }
    this.appServer.on("exit", (result: unknown) => {
      // A restart replaces this child deliberately, so its exit is expected and must not be
      // mistaken for the crash that tears the whole Bridge down. Exit events carry their child
      // generation, so an old child can never consume or impersonate the current child's crash.
      const exitedGeneration =
        result &&
        typeof result === "object" &&
        typeof (result as AppServerExit).generation === "number"
          ? (result as AppServerExit).generation!
          : null;
      if (
        exitedGeneration !== null &&
        this.activeAppServerGeneration !== null &&
        exitedGeneration !== this.activeAppServerGeneration
      ) {
        return;
      }
      if (this.stopped) return;
      // During replacement, an untagged exit (or any exit before the new generation is captured)
      // can only be attributed to the retired child. Once the new generation is known, an exit that
      // names it is a real crash even though the replacement promise has not reached its `finally`.
      if (
        this.transportRestartInFlight &&
        (exitedGeneration === null || this.activeAppServerGeneration === null)
      ) {
        return;
      }
      if (this.appServerRecoveryFuse.status.state === "HALF_OPEN") {
        // The half-open Adapter owns this replacement. Let its exact command resolve STILL_OPEN;
        // terminating CONTROL here would turn a model-only failure into a session outage.
        this.appServerHalfOpenCrashObserved = true;
        return;
      }
      if (this.appServerRecoveryFuse.status.state === "FUSE_OPEN") {
        // A stopped/offline model can report its final exit more than once. The fuse already owns it.
        return;
      }
      if (this.appServerCrashRecoveryOwner?.crashedGeneration === exitedGeneration) {
        // A process adapter may report the same child exit more than once. Ignore only the exact
        // crash already owned by recovery; a newly started generation crashing during resume still
        // falls through and terminates fail-closed.
        return;
      }
      const detail = describeAppServerExit(result);
      process.stderr.write(`[crossagent] ${detail}\n`);
      const crashRecoveryBarrier = this.beginIdleAppServerCrashRecovery();
      if (crashRecoveryBarrier) {
        this.startIdleAppServerCrashRecovery(detail, crashRecoveryBarrier, exitedGeneration);
      } else {
        this.runDetached(
          "shutdown after app-server exit",
          this.terminate(detail, new Error(detail)),
        );
      }
    });
    this.appServer.on("notification", (message: JsonRpcMessage) => {
      // Observed synchronously, ahead of the telemetry write: a turn/started that arrives while
      // that write is still in flight is still proof the push it confirms actually landed.
      this.observeNotification(message);
      // A failed telemetry write must never take the collaboration channel down with it.
      this.runDetached(
        `adapter event dropped (${message.method ?? "unknown"})`,
        this.onCodexNotification(message),
      );
    });
    const resumesExistingThread = Boolean(this.threadId ?? this.options.threadId);
    const threadResult = startsModelConfiguredOffline
      ? { thread: { id: this.threadId as string } }
      : resumesExistingThread
        ? await this.request<ThreadResult>("thread/resume", {
            threadId: this.threadId ?? this.options.threadId,
          })
        : await this.request<ThreadResult>("thread/start", {
            cwd: this.options.cwd,
            model: this.options.model,
            approvalPolicy: this.options.approvalPolicy,
            sandbox: this.options.sandbox,
            serviceName: "crossagent_hub",
          });
    this.ensureRunning("Codex thread initialization");
    // A successful resume is proof Codex already holds a rollout for this thread.
    if (resumesExistingThread) this.threadRolloutPersisted = true;
    if (recoveredTicketedSession && threadResult.thread.id !== this.threadId) {
      throw new Error("Codex app-server resumed a different thread during ticket recovery");
    }
    this.threadId = threadResult.thread.id;
    if (!startsModelConfiguredOffline) {
      this.modelTransportReady = true;
      this.releaseModelTransportWaiters();
    }
    await this.options.onThreadResolved?.(threadResult.thread.id);
    this.ensureRunning("Codex thread ownership recording");
    const sessionIdentity = {
      agentId: this.options.agentId ?? "codex",
      client: "codex-app-server" as const,
      deliveryMode: "app_server_push" as const,
      // One stable logical identity across launch reservation, initial bundle and every AUX bundle.
      // The app-server's transient session id may change when the child restarts; the Codex thread
      // id is the durable identity this Bridge is required to preserve.
      externalSessionId: threadResult.thread.id,
      externalThreadId: threadResult.thread.id,
    };
    if (!launchReservation) {
      launchReservation = await this.retryHubInitialization("session launch reservation", () =>
        this.hubRequest("session launch reservation", () =>
          this.hub.reserveSessionLaunch(joined.project.id, {
            ...sessionIdentity,
            runId: this.launcherRunId,
            idempotencyKey: `codex-launch:${this.launcherRunId}`,
          }),
        ),
      );
    }
    this.assertLaunchReservation(
      launchReservation,
      joined.project.id,
      threadResult.thread.id,
      launchReservation.state === "CONSUMED" && Boolean(recoveredTicketedSession),
    );
    if (this.sessionTicketRuntime && !this.currentModelMcpToken) {
      const prepared = await this.retryHubInitialization("initial ticket offer", () =>
        this.sessionTicketRuntime!.prepareInitial(
          initialTicketContext({
            projectId: joined.project.id,
            runId: this.launcherRunId,
            threadId: threadResult.thread.id,
            reservation: launchReservation,
          }),
        ),
      );
      this.currentModelMcpToken = prepared.raw.MODEL_MCP;
      await this.restartTransport("install initial MODEL_MCP ticket");
      this.ensureRunning("initial MODEL_MCP transport replacement");
    }
    const registrationInput = {
      agentId: sessionIdentity.agentId,
      role: "primary" as const,
      client: sessionIdentity.client,
      transport: "websocket" as const,
      deliveryMode: sessionIdentity.deliveryMode,
      externalSessionId: sessionIdentity.externalSessionId,
      externalThreadId: sessionIdentity.externalThreadId,
      expectedHeadSessionId: launchReservation.expectedHeadSessionId,
      launcherRunId: launchReservation.runId,
      launchGeneration: launchReservation.generation,
      host: hostname(),
      pid: process.pid,
      cwd: this.options.cwd,
      capabilities: [
        ...capabilities.methods,
        "crossagent-mcp",
        capabilities.experimentalApi ? "experimentalApi" : "stableApi",
      ],
      idempotencyKey: this.sessionRegistrationKey,
    };
    this.ticketRegistrationInput = registrationInput;
    const registered =
      recoveredTicketedSession ??
      (await this.retryHubInitialization("session registration", () =>
        this.hubRequest("session registration", async () => {
          if (!this.sessionTicketRuntime) {
            return {
              session: await this.hub.registerSession(joined.project.id, registrationInput),
              active: null,
            };
          }
          const ticketed = await this.sessionTicketRuntime.registerInitial(registrationInput);
          return { session: ticketed.registration.session, active: ticketed.active };
        }),
      ));
    const registeredSession = registered.session;
    if (registered.active) {
      this.activeTickets = registered.active;
      this.hub = registered.active.controlHub;
      this.syntheticHub = registered.active.injectorHub;
      this.controlSocketToken = registered.active.stored.raw.CONTROL;
      this.currentModelMcpToken = registered.active.modelMcpToken;
      await this.restoreOperationalCheckpoint(registered.active);
    }
    if (this.stopped) {
      await this.hub
        .closeSession(registeredSession.id, "codex_bridge_stopped_during_registration")
        .catch(() => undefined);
      this.ensureRunning("session registration");
    }
    this.session = registeredSession;
    this.ensureRunning("session registration");
    await this.retryHubInitialization("initial heartbeat", () =>
      recoveredTicketedSession?.requiresCommit
        ? this.sendHeartbeatAdmitted(true)
        : this.sendHeartbeat(),
    );
    if (recoveredTicketedSession?.requiresCommit && this.sessionTicketRuntime) {
      await this.sessionTicketRuntime.markCutoverPhase(
        recoveredTicketedSession.active.stored.bundleId,
        "CONTROL_READY",
      );
      await this.sessionTicketRuntime.markCutoverPhase(
        recoveredTicketedSession.active.stored.bundleId,
        startsModelConfiguredOffline ? "MODEL_CONFIGURED_OFFLINE" : "MODEL_READY",
        startsModelConfiguredOffline
          ? codexModelTransportFuseGeneration(recoveredTicketedSession.active.stored)
          : undefined,
      );
    }
    const startupRecoveryDrain = recoveredTicketedSession?.requiresCommit
      ? this.credentialDrain.beginDrain(
          `credential transition ${recoveredTicketedSession.active.stored.context.expectedHeadSessionId ?? registeredSession.id}`,
        )
      : null;
    await this.hydrateOperationalPendingMessages();
    const initialSocketGeneration = this.connectSocket(startupRecoveryDrain !== null);
    if (initialSocketGeneration === null) {
      throw new Error("Initial CONTROL socket could not start");
    }
    if (recoveredTicketedSession?.requiresCommit && this.sessionTicketRuntime) {
      // A recovered Hub-committed successor cannot become the durable local head until its ordered
      // event seam is caught up. Ordinary/first-lineage startup has no predecessor credential to
      // retain, so it remains non-blocking while the socket performs its normal subscription.
      await this.waitForSocketSubscription(initialSocketGeneration);
      await this.sessionTicketRuntime.markCutoverPhase(
        recoveredTicketedSession.active.stored.bundleId,
        "EVENTS_READY",
      );
      await this.sessionTicketRuntime.commitSuccessor(
        recoveredTicketedSession.active.stored.bundleId,
      );
      if (startupRecoveryDrain && this.credentialDrain.phase === "DRAINING") {
        this.credentialDrain.reopen(startupRecoveryDrain);
      }
      this.scheduleDeferredCredentialFlush();
    }
    this.ensureRunning("initial heartbeat");
    this.heartbeatTimer = setInterval(() => {
      this.runDetached("session heartbeat", this.sendHeartbeat(), (error) =>
        this.handleSessionFailure(error),
      );
    }, this.options.heartbeatIntervalMs ?? 5_000);
    this.heartbeatTimer.unref();
    this.startTicketRenewal();
    this.emitHealth();
    if (this.options.initialPrompt) await this.startTurn(this.options.initialPrompt);
    return this.state;
  }

  private startTicketRenewal(): void {
    if (
      !this.sessionTicketRuntime ||
      !this.activeTickets ||
      !this.session ||
      !this.threadId ||
      this.ticketRenewal
    ) {
      return;
    }
    const timing = this.options.sessionTicketRenewalTiming ?? {};
    this.ticketRenewal = new SessionTicketRenewal({
      initialLease: this.ticketLease(this.activeTickets),
      clock: this.options.sessionTicketRenewalClock,
      ...timing,
      renew: (attempt) =>
        this.renewTicketCredentials(attempt.current.bundleId, attempt.operationId),
      onError: (error) => {
        this.degradedReason = `session ticket renewal failed: ${describeError(error)}`;
        this.emitHealth();
      },
      onActivated: () => {
        this.credentialPlaneCritical = false;
        this.degradedReason = null;
        this.emitHealth();
      },
      onCritical: (error, attempt, reason) => {
        // Keep the managed owner alive for explicit same-thread replacement recovery, but stop new
        // model-visible work once the credential state can no longer be renewed safely.
        this.credentialPlaneCritical = true;
        this.degradedReason = `session ticket renewal entered fail-closed state: ${describeError(error)}`;
        this.emitHealth();
        if (reason === "SAFETY_DEADLINE_EXCEEDED") {
          this.scheduleCurrentHeadRecovery(attempt.current, 0);
        }
      },
    });
    this.ticketRenewal.start();
  }

  private scheduleCurrentHeadRecovery(lease: SessionTicketLease, delayMs: number): void {
    if (this.stopped || this.ticketCriticalRecoveryTimer) {
      return;
    }
    const clock = this.options.sessionTicketRenewalClock;
    const timer = (clock?.setTimeout ?? ((callback, delay) => setTimeout(callback, delay)))(
      () => {
        this.ticketCriticalRecoveryTimer = null;
        const operation = this.performCurrentHeadRecovery(lease);
        const owned = operation.finally(() => {
          if (this.ticketCriticalRecoveryInFlight === owned) {
            this.ticketCriticalRecoveryInFlight = null;
          }
        });
        this.ticketCriticalRecoveryInFlight = owned;
        this.runDetached("session ticket current-head recovery", owned);
      },
      Math.max(1, delayMs),
    );
    (timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
    this.ticketCriticalRecoveryTimer = timer;
  }

  private async performCurrentHeadRecovery(lease: SessionTicketLease): Promise<void> {
    if (this.stopped || !this.sessionTicketRuntime || !this.activeTickets || !this.session) {
      return;
    }
    if (
      this.appServerCrashRecoveryOwner ||
      this.appServerRecoveryFuse.status.state === "RECOVERING" ||
      this.appServerRecoveryFuse.status.state === "HALF_OPEN"
    ) {
      this.scheduleCurrentHeadRecovery(lease, 5_000);
      return;
    }
    if (this.credentialCutoverInFlight) {
      this.scheduleCurrentHeadRecovery(lease, 5_000);
      return;
    }
    const activeContext = this.activeTickets.stored.context;
    const ownsPredecessor =
      this.activeTickets.stored.bundleId === lease.bundleId ||
      ((activeContext.activationMode === "SESSION_AUXILIARY" ||
        activeContext.activationMode === "CURRENT_HEAD_REPLACEMENT") &&
        activeContext.expectedHeadSessionId === lease.sessionId &&
        this.activeTickets.stored.launchContext.runId === lease.launcherRunId);
    if (!ownsPredecessor) return;
    const drain = this.credentialDrain.beginDrain(`credential transition ${lease.bundleId}`);
    this.retireCredentialSocket();
    const activeTurnId = this.activeTurnId;
    if (activeTurnId && !(await this.isTurnDurablyTerminal(activeTurnId))) {
      this.scheduleCurrentHeadRecovery(lease, 5_000);
      return;
    }
    if (this.activeTurnId === activeTurnId) this.activeTurnId = null;
    const previousSession = this.session;
    if (!previousSession.externalSessionId || !previousSession.externalThreadId) {
      throw new Error("Codex current-head recovery requires its stable external thread identity");
    }
    const storedInput = this.activeTickets.stored.registrationInput ?? this.ticketRegistrationInput;
    if (!storedInput) {
      throw new Error("Codex current-head recovery lacks its durable registration template");
    }
    const replacementInput = this.currentHeadReplacementInput(
      previousSession,
      storedInput,
      lease.sessionId,
    );
    await this.awaitCredentialOwnerQuiescence(drain);
    this.modelTransportReady = false;
    let durableSuccessorKnown = false;
    try {
      const replacement = await this.sessionTicketRuntime.recoverCriticalSuccessor(
        lease.bundleId,
        replacementInput,
      );
      durableSuccessorKnown = true;
      this.activeTickets = replacement.next;
      this.session = replacement.session;
      this.ticketRegistrationInput = replacementInput;
      this.hub = replacement.next.controlHub;
      this.syntheticHub = replacement.next.injectorHub;
      this.controlSocketToken = replacement.next.stored.raw.CONTROL;
      this.currentModelMcpToken = replacement.next.modelMcpToken;
      await this.restoreOperationalCheckpoint(replacement.next);
      if (this.stopped) {
        return;
      }
      await this.sendHeartbeatAdmitted(true);
      await this.sessionTicketRuntime.markCutoverPhase(
        replacement.next.stored.bundleId,
        "CONTROL_READY",
      );
      const generation = this.connectSocket(true);
      if (generation === null) throw new TypeError("replacement CONTROL socket could not start");
      const configuredOffline = this.appServerRecoveryFuse.status.state === "FUSE_OPEN";
      if (configuredOffline) {
        await this.sessionTicketRuntime.markCutoverPhase(
          replacement.next.stored.bundleId,
          "MODEL_CONFIGURED_OFFLINE",
          this.appServerRecoveryFuse.status.fuseGeneration,
        );
        replacement.next.stored.modelTransportState = "MODEL_CONFIGURED_OFFLINE";
        replacement.next.stored.modelTransportFuseGeneration =
          this.appServerRecoveryFuse.status.fuseGeneration;
        this.publishAppServerRecoveryRequired(
          this.appServerRecoveryFuse.rebindOfflineIdentity(this.currentAppServerRecoveryIdentity()),
        );
      } else {
        await this.restartTransport(
          `${replacement.kind.toLowerCase()} ticket recovery ${replacement.next.stored.bundleId}`,
          false,
        );
        await this.sessionTicketRuntime.markCutoverPhase(
          replacement.next.stored.bundleId,
          "MODEL_READY",
        );
      }
      await this.hydrateOperationalPendingMessages();
      this.credentialRecoveryDataPlaneReady = true;
      await this.waitForSocketSubscription(generation);
      await this.sessionTicketRuntime.markCutoverPhase(
        replacement.next.stored.bundleId,
        "EVENTS_READY",
      );
      await this.sessionTicketRuntime.commitSuccessor(replacement.next.stored.bundleId);
      const retiredRenewal = this.ticketRenewal;
      this.ticketRenewal = null;
      await retiredRenewal?.stop();
      this.ticketCriticalRecoveryFailures = 0;
      this.credentialPlaneCritical = false;
      this.credentialRecoveryDataPlaneReady = false;
      this.degradedReason = null;
      this.startTicketRenewal();
      if (this.credentialDrain.phase === "DRAINING") this.credentialDrain.reopen(drain);
      this.scheduleDeferredCredentialFlush();
      this.emitHealth();
    } catch (error: unknown) {
      this.credentialRecoveryDataPlaneReady = false;
      const normalized = error instanceof Error ? error : new Error(String(error));
      const retryableHubFailure =
        isHubNetworkError(normalized) ||
        (normalized instanceof HubHttpError &&
          (normalized.status === 408 || normalized.status === 429 || normalized.status >= 500));
      const cutover = await this.sessionTicketRuntime.getCutover().catch(() => null);
      const durableCutoverKnown =
        durableSuccessorKnown ||
        hasErrorCode(normalized, "DURABLE_SUCCESSOR_INCOMPLETE") ||
        Boolean(
          cutover &&
          cutover.predecessorBundleId === lease.bundleId &&
          cutover.phase !== "HUB_ACTIVATING",
        );
      const retryable = retryableHubFailure || durableCutoverKnown;
      if (retryable && !this.stopped) {
        const retryInitial = this.options.sessionTicketRenewalTiming?.retryInitialMs ?? 30_000;
        const retryMax = this.options.sessionTicketRenewalTiming?.retryMaxMs ?? 15 * 60_000;
        const delay = Math.min(
          retryMax,
          retryInitial * 2 ** Math.min(this.ticketCriticalRecoveryFailures, 20),
        );
        this.ticketCriticalRecoveryFailures += 1;
        this.scheduleCurrentHeadRecovery(lease, delay);
      }
      throw normalized;
    }
  }

  private currentHeadReplacementInput(
    previousSession: AgentSession,
    storedInput: TicketRegistrationInput,
    expectedHeadSessionId = previousSession.id,
  ): TicketRegistrationInput {
    if (!previousSession.externalSessionId || !previousSession.externalThreadId) {
      throw new Error("Codex current-head recovery requires its stable external thread identity");
    }
    const {
      launcherRunId: _launcherRunId,
      launchGeneration: _launchGeneration,
      expectedHeadSessionId: _expectedHeadSessionId,
      ...baseInput
    } = storedInput;
    return {
      ...baseInput,
      externalSessionId: previousSession.externalSessionId,
      externalThreadId: previousSession.externalThreadId,
      host: hostname(),
      pid: process.pid,
      cwd: this.options.cwd,
      expectedHeadSessionId,
      idempotencyKey: `codex-current-head:${this.launcherRunId}:${expectedHeadSessionId}`,
    };
  }

  private ticketLease(active: ActiveCodexSessionTicketBundle): SessionTicketLease {
    if (!this.session || !this.threadId || !active.stored.observedAt || !active.stored.serverNow) {
      throw new Error("Codex ticket lease requires the registered session and persisted receipt");
    }
    const binding = active.stored.binding;
    if (!binding.lineageId || binding.incarnation === null) {
      throw new Error("Codex ticket lease requires a concrete session lineage");
    }
    return {
      bundleId: binding.bundleId,
      projectId: binding.projectId,
      agentId: "codex",
      sessionId: binding.hubSessionId,
      threadId: this.threadId,
      lineageId: binding.lineageId,
      incarnation: binding.incarnation,
      launcherRunId: binding.runId,
      activatedAt: binding.activatedAt,
      expiresAt: binding.expiresAt,
      serverNow: active.stored.serverNow,
      observedAt: active.stored.observedAt,
    };
  }

  private async restoreOperationalCheckpoint(
    active: ActiveCodexSessionTicketBundle,
  ): Promise<void> {
    if (!this.sessionTicketRuntime) return;
    const checkpoint = await this.sessionTicketRuntime.restoreOperationalCheckpoint(active);
    if (!checkpoint.session) {
      throw new Error("Active Codex ticket has no operational checkpoint session");
    }
    this.heartbeatSequence = checkpoint.session.nextHeartbeatSequence - 1;
    this.lastSequence = checkpoint.eventSequence;
    this.durablePendingMessageIds = [...checkpoint.pendingMessageIds];
  }

  private async hydrateOperationalPendingMessages(): Promise<void> {
    // Durable hydration belongs exclusively to the ticketed checkpoint Module. Legacy Bridges have
    // no checkpoint to recover and must not gain an unconditional unresolved-inbox request during
    // bootstrap merely because ticket recovery exists as an optional Adapter seam.
    if (!this.sessionTicketRuntime || !this.activeTickets || !this.project || !this.session) {
      return;
    }
    this.operationalRecoveryThreadSnapshot = null;
    const recovered = await this.loadRecipientUnsettledMessages();
    for (const messageId of this.durablePendingMessageIds) {
      const message = await this.hubRequest("durable pending message read", () =>
        this.hub.getMessage(messageId),
      );
      recovered.set(message.id, message);
    }
    if (recovered.size > MAX_DURABLE_PENDING_MESSAGES) {
      throw new RangeError("Codex recipient recovery exceeds the durable pending capacity");
    }
    // CURRENT_HEAD replacement rebinds unsettled recipients without manufacturing a second
    // message event. Reserve the complete, bounded union before any model RPC so a late page or
    // crash cannot make early pages visible and then lose the tail.
    const orderedRecovered = [...recovered.values()].sort(
      (left, right) => left.sequence - right.sequence,
    );
    let checkpointRetryPending = false;
    for (const message of orderedRecovered) {
      if (this.durablePendingMessageIds.includes(message.id)) continue;
      await this.sessionTicketRuntime.reservePendingMessage(this.activeTickets, message.id);
    }
    for (const message of orderedRecovered) {
      const terminalRecipient = this.recipientFor(message);
      if (terminalRecipient && TERMINAL_RECIPIENT_STATES.includes(terminalRecipient.state)) {
        // A terminal recipient is already durable Hub proof that no further model surface is
        // allowed. This check must precede historical surface recovery: the recovery endpoint is
        // intentionally limited to DELIVERED/ACKNOWLEDGED and would otherwise turn a checkpoint
        // save failure after PROCESSED/RESPONDED into a permanent false ambiguity.
        this.surfacePermits.delete(message.id);
        this.pendingDeliveryStates.delete(message.id);
        this.clearAmbiguousMessage(message.id);
        this.deliveredMessageIds.add(message.id);
        try {
          await this.sessionTicketRuntime.settlePendingMessage(this.activeTickets, message.id);
        } catch (error: unknown) {
          // Hub terminal state already forbids model replay. A transient checkpoint write must not
          // kill the managed Bridge and depend on an external supervisor; retain the pending id and
          // retry this zero-model settlement from the next ordinary heartbeat.
          checkpointRetryPending = true;
          this.degradedReason = `operational checkpoint settlement pending: ${describeError(error)}`;
          this.emitHealth();
        }
        continue;
      }
      const recovery = await this.recoverOperationalPendingMessage(message);
      if (recovery === "AMBIGUOUS" || recovery === "SETTLED") continue;
      await this.onMessageEvent({ aggregateId: message.id } as DomainEvent);
      const refreshed = await this.hubRequest("hydrated message settlement read", () =>
        this.hub.getMessage(message.id),
      );
      const recipient = this.recipientFor(refreshed);
      if (
        !recipient ||
        TERMINAL_RECIPIENT_STATES.includes(recipient.state) ||
        this.deliveredMessageIds.has(message.id)
      ) {
        await this.sessionTicketRuntime.settlePendingMessage(this.activeTickets, message.id);
      } else if (this.pushAction(message) === "mailbox") {
        await this.sessionTicketRuntime.settlePendingMessage(this.activeTickets, message.id);
      }
    }
    const checkpoint = await this.sessionTicketRuntime.restoreOperationalCheckpoint(
      this.activeTickets,
    );
    this.durablePendingMessageIds = [...checkpoint.pendingMessageIds];
    this.operationalHydrationRetryPending = checkpointRetryPending;
    if (
      !checkpointRetryPending &&
      this.degradedReason?.startsWith("operational checkpoint settlement pending:")
    ) {
      this.degradedReason = null;
      this.emitHealth();
    }
    this.operationalRecoveryThreadSnapshot = null;
  }

  private async loadRecipientUnsettledMessages(): Promise<Map<string, CrossAgentMessage>> {
    const recovered = new Map<string, CrossAgentMessage>();
    if (!this.project || !this.session) return recovered;
    let beforeSequence: number | undefined;
    while (true) {
      const page = await this.hubRequest("recipient-unsettled message page", () =>
        this.hub.listMessages(this.project!.id, {
          agentId: "codex",
          sessionId: this.session!.id,
          recipientUnsettled: true,
          limit: RECIPIENT_UNSETTLED_PAGE_SIZE,
          ...(beforeSequence === undefined ? {} : { beforeSequence }),
        }),
      );
      if (page.length > RECIPIENT_UNSETTLED_PAGE_SIZE) {
        throw new Error("Hub exceeded the recipient-unsettled page contract");
      }
      let previousSequence = beforeSequence ?? Number.POSITIVE_INFINITY;
      for (const message of page) {
        if (message.sequence >= previousSequence) {
          throw new Error("Hub recipient-unsettled pages are not strictly descending");
        }
        previousSequence = message.sequence;
        const recipient = this.recipientFor(message);
        if (
          !recipient ||
          !["PENDING", "FAILED", "DELIVERED", "ACKNOWLEDGED"].includes(recipient.state)
        ) {
          throw new Error("Hub recipient-unsettled page escaped the exact recipient contract");
        }
        recovered.set(message.id, message);
        if (recovered.size > MAX_DURABLE_PENDING_MESSAGES) {
          throw new RangeError("Codex recipient recovery exceeds the durable pending capacity");
        }
      }
      if (page.length < RECIPIENT_UNSETTLED_PAGE_SIZE) break;
      const nextBefore = page.at(-1)?.sequence;
      if (!nextBefore || nextBefore === beforeSequence) {
        throw new Error("Hub recipient-unsettled pagination did not advance");
      }
      beforeSequence = nextBefore;
    }
    return recovered;
  }

  /**
   * Reconcile a checkpointed message before normal dispatch. A CONFIRMED surface proves that this
   * exact Adapter incarnation already crossed the model Seam, so replaying it would duplicate a
   * user-visible instruction. An unresolved surface is equally important evidence in the opposite
   * direction: it forbids retry and remains visible/durable until an operator or later recovery can
   * establish what happened. Only a true absence of any surface may return to ordinary dispatch.
   */
  private async recoverOperationalPendingMessage(
    message: CrossAgentMessage,
  ): Promise<"NO_SURFACE" | "SETTLED" | "AMBIGUOUS"> {
    if (!this.sessionTicketRuntime || !this.activeTickets || !this.session) {
      return "NO_SURFACE";
    }
    try {
      const recovered = await this.hubRequest("durable authority delivery recovery", () =>
        this.hub.recoverAuthorityDelivery(message.id, {
          session_id: this.session!.id,
        }),
      );
      if (
        recovered.permit.messageId !== message.id ||
        !this.recoveredDeliveryTargetsActiveSession(recovered) ||
        !this.authorityCandidateMatchesSurface(recovered.candidate, message, recovered.permit)
      ) {
        throw new Error("Recovered delivery does not match the durable Codex surface binding");
      }
      const verification = await this.verifyRecoveredAuthorityCandidate(
        recovered.candidate,
        message,
        recovered.permit,
      );
      if (verification === "TERMINAL") {
        this.clearAmbiguousMessage(message.id);
        await this.sessionTicketRuntime.settlePendingMessage(this.activeTickets, message.id);
        return "SETTLED";
      }
      if (verification !== "VALID") {
        const reason = `durable authority recovery remains ambiguous: ${verification}`;
        this.ambiguousMessageReasons.set(message.id, reason);
        this.degradedReason = reason;
        this.emitHealth();
        return "AMBIGUOUS";
      }
      this.confirmedMessageIds.add(message.id);
      this.deliveredMessageIds.add(message.id);
      this.surfacePermits.delete(message.id);
      this.pendingDeliveryStates.delete(message.id);
      this.clearAmbiguousMessage(message.id);
      await this.sessionTicketRuntime.settlePendingMessage(this.activeTickets, message.id);
      return "SETTLED";
    } catch (error: unknown) {
      if (error instanceof HubHttpError && error.status === 404 && error.code === "NOT_FOUND") {
        return "NO_SURFACE";
      }
      if (
        error instanceof HubHttpError &&
        [
          "DIRECTIVE_INACTIVE",
          "DIRECTIVE_REVOKED",
          "DIRECTIVE_EXPIRED",
          "DELEGATION_INACTIVE",
        ].includes(error.code)
      ) {
        // recoverAuthorityDelivery first proves the exact CONFIRMED receipt, then resolves the
        // candidate. A later terminal authority state must suppress replay and can retire the local
        // pending marker without pretending that the directive is still valid.
        this.clearAmbiguousMessage(message.id);
        await this.sessionTicketRuntime.settlePendingMessage(this.activeTickets, message.id);
        return "SETTLED";
      }
      if (
        error instanceof HubHttpError &&
        [
          "AUTHORITY_DELIVERY_RECOVERY_UNCONFIRMED",
          "AUTHORITY_DELIVERY_RECOVERY_RECEIPT_MISSING",
          "AUTHORITY_DELIVERY_RECOVERY_FENCE_CHANGED",
        ].includes(error.code)
      ) {
        if (error.code === "AUTHORITY_DELIVERY_RECOVERY_UNCONFIRMED") {
          const unresolved = unconfirmedSurfaceRecovery(error.current);
          if (
            unresolved &&
            unresolved.permit.messageId === message.id &&
            this.recoveredDeliveryTargetsActiveSession(unresolved) &&
            (this.historicalDeliveryProofMode === "disabled" ||
              (await this.operationalRecoveryThreadHoldsMessage(message.id)))
          ) {
            try {
              const reconciled = await this.hubRequest(
                "ordinary ambiguous surface reconciliation",
                () =>
                  this.hub.reconcileOrdinaryMessageSurface(message.id, unresolved.permit.id, {
                    sessionId: this.session!.id,
                    recipientFence: unresolved.permit.recipientFence,
                    externalThreadId: this.threadId!,
                    idempotencyKey: `codex-reconcile-ordinary:${this.session!.id}:${message.id}`,
                  }),
              );
              const recipient = this.recipientFor(reconciled);
              if (
                !recipient ||
                !["DELIVERED", ...SURFACED_RECIPIENT_STATES].includes(recipient.state)
              ) {
                throw new Error(
                  "Ordinary surface reconciliation did not return a surfaced recipient",
                );
              }
              this.confirmedMessageIds.add(message.id);
              this.deliveredMessageIds.add(message.id);
              this.surfacePermits.delete(message.id);
              this.pendingDeliveryStates.delete(message.id);
              this.lastConfirmedPushAt = new Date().toISOString();
              this.degradedReason = null;
              this.clearAmbiguousMessage(message.id);
              await this.sessionTicketRuntime.settlePendingMessage(this.activeTickets, message.id);
              this.emitHealth();
              return "SETTLED";
            } catch (reconciliationError: unknown) {
              if (
                reconciliationError instanceof HubHttpError &&
                [
                  "AUTHORITY_SURFACE_PERMIT_REQUIRED",
                  "MESSAGE_SURFACE_RECONCILIATION_INVALID",
                ].includes(reconciliationError.code)
              ) {
                const reason = `durable ordinary recovery remains ambiguous: ${reconciliationError.code}`;
                this.ambiguousMessageReasons.set(message.id, reason);
                this.degradedReason = reason;
                this.emitHealth();
                return "AMBIGUOUS";
              }
              throw reconciliationError;
            }
          }
        }
        const stalePermit = this.surfacePermits.get(message.id);
        if (stalePermit && stalePermit.sessionId !== this.session.id) {
          // CURRENT_HEAD has already terminalized the predecessor surface in the Hub. Retaining its
          // process-local delivery owner would make every later heartbeat or AUX drain try to write
          // with a superseded ticket. Keep the durable checkpoint and explicit ambiguity, but shed
          // only this stale local owner.
          this.surfacePermits.delete(message.id);
          this.pendingDeliveryStates.delete(message.id);
        }
        const reason = `durable delivery recovery remains ambiguous: ${error.code}`;
        this.ambiguousMessageReasons.set(message.id, reason);
        this.degradedReason = reason;
        this.emitHealth();
        return "AMBIGUOUS";
      }
      throw error;
    }
  }

  /**
   * A historical CONFIRMED permit remains bound to the Adapter incarnation that crossed the model
   * Seam. CURRENT_SESSION recovery therefore binds both halves to the live session, while a
   * LINEAGE_HANDOFF deliberately keeps the candidate on the predecessor and authenticates the
   * successor separately through `recoveredFor`. Mixing those identities would manufacture a
   * surface that never existed; accepting only a session id would let a sibling incarnation consume
   * this Bridge's checkpoint.
   */
  private recoveredDeliveryTargetsActiveSession(recovered: {
    permit: MessageSurfacePermit;
    recoveredFor: AuthorityRecoveryTarget;
  }): boolean {
    if (!this.session || !this.activeTickets) return false;
    const binding = this.activeTickets.stored.binding;
    const currentIncarnation = this.session.incarnation;
    if (
      currentIncarnation === null ||
      binding.incarnation === null ||
      binding.lineageId === null ||
      binding.hubSessionId !== this.session.id ||
      binding.incarnation !== currentIncarnation ||
      recovered.recoveredFor.sessionId !== this.session.id ||
      recovered.recoveredFor.sessionIncarnation !== currentIncarnation
    ) {
      return false;
    }
    if (recovered.recoveredFor.kind === "CURRENT_SESSION") {
      return (
        recovered.permit.sessionId === this.session.id &&
        recovered.permit.sessionIncarnation === currentIncarnation
      );
    }
    return (
      recovered.recoveredFor.lineageId === binding.lineageId &&
      recovered.permit.sessionId !== this.session.id &&
      recovered.permit.sessionIncarnation < currentIncarnation
    );
  }

  private async verifyRecoveredAuthorityCandidate(
    candidate: AdapterAuthorityDeliveryCandidate,
    message: CrossAgentMessage,
    permit: MessageSurfacePermit,
  ): Promise<"VALID" | "TERMINAL" | string> {
    if (candidate.kind === "ORDINARY") return "VALID";
    const liveKeys = await this.hubRequest("recovered authority signing keys", () =>
      this.hub.listAuthoritySigningKeys(),
    );
    const trustedSigningKeys = refreshTrustedAuthoritySigningKeys(
      this.authorityTrustManifest,
      liveKeys,
    );
    if (trustedSigningKeys.length === 0) return "INVALID/UNTRUSTED_SIGNING_KEY";
    const result = await verifyAndRenderAuthorityIngress(candidate.bundle, {
      projectId: message.projectId,
      carrierMessageId: message.id,
      targetAgentId: "codex",
      targetSessionId: permit.sessionId,
      targetSessionIncarnation: permit.sessionIncarnation,
      surfaceAttemptId: permit.id,
      recipientFence: permit.recipientFence,
      observedAt: new Date().toISOString(),
      trustedSigningKeys,
    });
    if (result.verification === "VALID") return "VALID";
    if (this.isTerminalAuthorityCandidate(candidate, result.reason)) return "TERMINAL";
    return `${result.verification}/${result.reason}`;
  }

  private renewTicketCredentials(
    expectedBundleId: string,
    operationId: string,
  ): Promise<SessionTicketLease> {
    if (
      this.appServerCrashRecoveryOwner ||
      this.appServerRecoveryFuse.status.state === "RECOVERING" ||
      this.appServerRecoveryFuse.status.state === "HALF_OPEN"
    ) {
      return Promise.reject(
        Object.assign(
          new TypeError("Codex app-server crash recovery temporarily owns model admission"),
          { code: "APP_SERVER_CRASH_RECOVERY_IN_PROGRESS" },
        ),
      );
    }
    if (this.credentialCutoverInFlight) return this.credentialCutoverInFlight;
    const operation = this.performTicketCredentialCutover(expectedBundleId, operationId).catch(
      async (error: unknown) => {
        const cutover = await this.sessionTicketRuntime?.getCutover().catch(() => null);
        if (
          hasErrorCode(error, "DURABLE_SUCCESSOR_INCOMPLETE") ||
          (cutover &&
            cutover.predecessorBundleId === expectedBundleId &&
            cutover.operationId === operationId &&
            cutover.phase !== "HUB_ACTIVATING")
        ) {
          throw Object.assign(
            new TypeError("Hub-committed Codex successor has incomplete local cutover", {
              cause: error,
            }),
            { code: "DURABLE_SUCCESSOR_INCOMPLETE" },
          );
        }
        throw error;
      },
    );
    const owned = operation.finally(() => {
      if (this.credentialCutoverInFlight === owned) this.credentialCutoverInFlight = null;
    });
    this.credentialCutoverInFlight = owned;
    return owned;
  }

  private async performTicketCredentialCutover(
    expectedBundleId: string,
    operationId: string,
  ): Promise<SessionTicketLease> {
    if (!this.sessionTicketRuntime || !this.activeTickets || !this.session) {
      throw new Error("Codex ticket cutover is unavailable before session registration");
    }
    const alreadyActivatedForExpected =
      this.activeTickets.stored.rotationReceipt?.supersededTicketBinding.bundleId ===
      expectedBundleId;
    if (this.activeTickets.stored.bundleId !== expectedBundleId && !alreadyActivatedForExpected) {
      throw new Error("Codex ticket cutover no longer owns the expected current bundle");
    }
    const drain = this.credentialDrain.beginDrain(`credential transition ${expectedBundleId}`);
    this.retireCredentialSocket();
    if (!alreadyActivatedForExpected) {
      await this.awaitCredentialSafePoint(this.ticketLease(this.activeTickets));
    }
    await this.awaitCredentialEpochDrain(drain);
    this.modelTransportReady = false;
    const rotated = await this.sessionTicketRuntime.activateSuccessor(this.session, operationId);
    this.activeTickets = rotated.next;
    this.hub = rotated.next.controlHub;
    this.syntheticHub = rotated.next.injectorHub;
    this.controlSocketToken = rotated.next.stored.raw.CONTROL;
    this.currentModelMcpToken = rotated.next.modelMcpToken;
    await this.restoreOperationalCheckpoint(rotated.next);
    const nextLease = this.ticketLease(rotated.next);

    // A caller-initiated stop may race a committed Hub rotation. Adopt the exact receipt so close
    // uses the live CONTROL credential, but do not restart a child that teardown is retiring.
    if (this.stopped) {
      await this.sessionTicketRuntime.adoptSuccessorForConfirmedClose(rotated.next.stored.bundleId);
      return nextLease;
    }

    await this.sendHeartbeatAdmitted(true);
    await this.sessionTicketRuntime.markCutoverPhase(rotated.next.stored.bundleId, "CONTROL_READY");
    const generation = this.connectSocket(true);
    if (generation === null) throw new TypeError("replacement CONTROL socket could not start");
    if (this.appServerRecoveryFuse.status.state === "FUSE_OPEN") {
      await this.sessionTicketRuntime.markCutoverPhase(
        rotated.next.stored.bundleId,
        "MODEL_CONFIGURED_OFFLINE",
        this.appServerRecoveryFuse.status.fuseGeneration,
      );
      rotated.next.stored.modelTransportState = "MODEL_CONFIGURED_OFFLINE";
      rotated.next.stored.modelTransportFuseGeneration =
        this.appServerRecoveryFuse.status.fuseGeneration;
      this.publishAppServerRecoveryRequired(
        this.appServerRecoveryFuse.rebindOfflineIdentity(this.currentAppServerRecoveryIdentity()),
      );
    } else {
      await this.restartTransport(`session ticket rotation ${rotated.next.stored.bundleId}`, false);
      await this.sessionTicketRuntime.markCutoverPhase(rotated.next.stored.bundleId, "MODEL_READY");
    }
    await this.hydrateOperationalPendingMessages();
    await this.waitForSocketSubscription(generation);
    await this.sessionTicketRuntime.markCutoverPhase(rotated.next.stored.bundleId, "EVENTS_READY");
    if (this.stopped) {
      await this.sessionTicketRuntime.adoptSuccessorForConfirmedClose(rotated.next.stored.bundleId);
      return nextLease;
    }
    await this.sessionTicketRuntime.commitSuccessor(rotated.next.stored.bundleId);
    if (this.credentialDrain.phase === "DRAINING") this.credentialDrain.reopen(drain);
    this.scheduleDeferredCredentialFlush();
    return nextLease;
  }

  private async awaitCredentialSafePoint(lease: SessionTicketLease): Promise<void> {
    if (!this.activeTurnId) return Promise.resolve();
    const clock = this.options.sessionTicketRenewalClock;
    const localExpiryAt =
      Date.parse(lease.observedAt) + (Date.parse(lease.expiresAt) - Date.parse(lease.serverNow));
    const safetyMarginMs =
      this.options.sessionTicketRenewalTiming?.safetyMarginMs ?? DEFAULT_TICKET_SAFETY_MARGIN_MS;
    const safetyDeadline = localExpiryAt - safetyMarginMs;
    if (safetyDeadline <= (clock?.now() ?? Date.now())) {
      throw new TypeError("active Codex turn did not reach a safe ticket-rotation point");
    }
    const expectedTurnId = this.activeTurnId;
    if (await this.isTurnDurablyTerminal(expectedTurnId)) {
      if (this.activeTurnId === expectedTurnId) this.activeTurnId = null;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const clear = (timer: ReturnType<typeof setTimeout> | null) => {
        if (!timer) return;
        (
          clock ?? {
            clearTimeout: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle),
          }
        ).clearTimeout(timer);
      };
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        this.credentialSafePointWaiters.delete(waiter);
        clear(waiter.timer);
        waiter.timer = null;
        if (error) reject(error);
        else resolve();
      };
      const schedule = () => {
        const remaining = safetyDeadline - (clock?.now() ?? Date.now());
        if (remaining <= 0) {
          finish(new TypeError("active Codex turn exceeded the ticket safety deadline"));
          return;
        }
        waiter.timer = (clock?.setTimeout ?? ((callback, delay) => setTimeout(callback, delay)))(
          () => void poll(),
          Math.min(5_000, remaining),
        );
        (waiter.timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
      };
      const poll = async () => {
        waiter.timer = null;
        if (settled) return;
        if (
          this.activeTurnId !== expectedTurnId ||
          (await this.isTurnDurablyTerminal(expectedTurnId))
        ) {
          if (this.activeTurnId === expectedTurnId) this.activeTurnId = null;
          finish();
          return;
        }
        schedule();
      };
      const waiter = {
        resolve: () => finish(),
        reject: finish,
        timer: null as ReturnType<typeof setTimeout> | null,
      };
      this.credentialSafePointWaiters.add(waiter);
      schedule();
    });
  }

  private async withCredentialAdmission<T>(
    kind: CredentialAdmissionKind,
    operation: (admission: CredentialAdmission) => Promise<T>,
  ): Promise<T> {
    const admission = await this.credentialDrain.admit(kind);
    try {
      return await operation(admission);
    } finally {
      admission.release();
    }
  }

  /**
   * Wait for every old-credential owner, then turn any residual ACTIVE surface into durable
   * ambiguity before the Hub can revoke that credential. Pending DELIVERED writes are retried with
   * the old CONTROL token; a failed durable write aborts cutover instead of being treated as drain.
   */
  private async awaitCredentialEpochDrain(barrier: CredentialDrainBarrier): Promise<void> {
    await barrier.drained;
    await this.flushPendingDeliveryStates();
    for (const permit of [...this.surfacePermits.values()]) {
      if (permit.state !== "ACTIVE") continue;
      await this.settleSurfacePermit(
        permit,
        "AMBIGUOUS",
        "credential epoch retired before an exact delivery receipt",
        true,
      );
    }
    if (
      this.pushesInFlight.size > 0 ||
      this.deliveryWritesInFlight.size > 0 ||
      this.pendingDeliveryStates.size > 0 ||
      [...this.surfacePermits.values()].some((permit) =>
        ["ACTIVE", "CONFIRMED"].includes(permit.state),
      )
    ) {
      throw new TypeError("Codex credential epoch did not reach a durable delivery drain");
    }
  }

  /** Expired CURRENT_HEAD credentials cannot settle Hub state; replacement owns that transaction. */
  private async awaitCredentialOwnerQuiescence(barrier: CredentialDrainBarrier): Promise<void> {
    await barrier.drained;
    if (this.pushesInFlight.size > 0 || this.deliveryWritesInFlight.size > 0) {
      throw new TypeError("Codex credential owners remained active after the local drain");
    }
  }

  private retireCredentialSocket(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.clearSubscriptionWatchdog();
    const oldSocket = this.socket;
    const oldGeneration = this.socketGeneration;
    if (!oldSocket) return;
    this.invalidateSocket(oldGeneration, oldSocket);
    this.closeSocketBestEffort(oldSocket);
  }

  private async isTurnDurablyTerminal(turnId: string): Promise<boolean> {
    if (!this.threadId) return false;
    try {
      const response = await this.requestAppServer<unknown>("thread/read", {
        threadId: this.threadId,
        includeTurns: true,
      });
      if (!response || typeof response !== "object") return false;
      const thread = (response as { thread?: unknown }).thread;
      if (!thread || typeof thread !== "object") return false;
      const turns = (thread as { turns?: unknown }).turns;
      if (!Array.isArray(turns)) return false;
      const exact = turns.find(
        (turn) =>
          turn !== null && typeof turn === "object" && (turn as { id?: unknown }).id === turnId,
      ) as { status?: unknown } | undefined;
      if (!exact || typeof exact.status !== "string") return false;
      return !["inprogress", "running"].includes(
        exact.status.toLowerCase().replace(/[^a-z]/gu, ""),
      );
    } catch {
      // A missing durable answer is not proof of idleness; keep waiting until notification/deadline.
      return false;
    }
  }

  private releaseCredentialSafePointWaiters(): void {
    for (const waiter of [...this.credentialSafePointWaiters]) waiter.resolve();
  }

  private rejectCredentialSafePointWaiters(error: Error): void {
    for (const waiter of [...this.credentialSafePointWaiters]) waiter.reject(error);
  }

  private awaitModelTransportReady(): Promise<void> {
    if (this.modelTransportReady) return Promise.resolve();
    if (this.stopped) return Promise.reject(new Error("Codex Bridge is stopped"));
    return new Promise<void>((resolve, reject) => {
      const waiter = {
        resolve: () => {
          this.modelTransportWaiters.delete(waiter);
          resolve();
        },
        reject: (error: Error) => {
          this.modelTransportWaiters.delete(waiter);
          reject(error);
        },
      };
      this.modelTransportWaiters.add(waiter);
    });
  }

  private releaseModelTransportWaiters(): void {
    for (const waiter of [...this.modelTransportWaiters]) waiter.resolve();
  }

  private rejectModelTransportWaiters(error: Error): void {
    for (const waiter of [...this.modelTransportWaiters]) waiter.reject(error);
  }

  /**
   * `clientUserMessageId` is the correlation id Codex echoes back as the thread item's `clientId`,
   * which is what lets a push be confirmed against the exact message rather than against "some turn
   * started".
   */
  async startTurn(text: string, clientUserMessageId?: string): Promise<string> {
    this.assertModelTransportAdmission();
    return this.withCredentialAdmission("DIRECT_USER_INPUT", () =>
      this.startTurnAdmitted(text, clientUserMessageId),
    );
  }

  private async startTurnAdmitted(text: string, clientUserMessageId?: string): Promise<string> {
    if (!this.threadId) throw new Error("Codex Bridge has no thread");
    const result = await this.request<TurnResult>("turn/start", {
      threadId: this.threadId,
      input: [{ type: "text", text }],
      cwd: this.options.cwd,
      clientUserMessageId,
    });
    this.activeTurnId = result.turn.id;
    // The Codex RPC is already durable at this point. Retrying the whole start on a transient Hub
    // failure would duplicate the user's prompt, while propagating the telemetry failure would tear
    // down a managed Bridge that successfully started its turn. Own the heartbeat independently.
    this.runDetached("turn heartbeat", this.sendHeartbeat(), (error) =>
      this.handleSessionFailure(error),
    );
    return result.turn.id;
  }

  async sendUserText(text: string): Promise<string> {
    this.assertModelTransportAdmission();
    return this.withCredentialAdmission("DIRECT_USER_INPUT", async () => {
      if (!this.threadId) throw new Error("Codex Bridge has no thread");
      if (!this.activeTurnId) return this.startTurnAdmitted(text);
      const result = await this.request<{ turnId: string }>("turn/steer", {
        threadId: this.threadId,
        expectedTurnId: this.activeTurnId,
        input: [{ type: "text", text }],
      });
      return result.turnId;
    });
  }

  async stop(): Promise<CodexBridgeStopOutcome> {
    if (this.stopPromise) return this.stopPromise;
    if (this.stopped) {
      return (
        this.terminalStopOutcome ?? {
          sessionExisted: false,
          close: { state: "NOT_ATTEMPTED", sessionId: null, bundleId: null },
        }
      );
    }
    const stopDrain = this.credentialDrain.close("Codex Bridge stopped");
    this.stopped = true;
    this.rejectCredentialSafePointWaiters(
      new TypeError("Codex Bridge stopped before ticket rotation reached a safe point"),
    );
    const initialization = this.initializationPromise;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.coalesceTimer) clearTimeout(this.coalesceTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.subscriptionWatchdog) clearTimeout(this.subscriptionWatchdog);
    if (this.initializationRetryTimer) clearTimeout(this.initializationRetryTimer);
    if (this.ticketCriticalRecoveryTimer) {
      const clock = this.options.sessionTicketRenewalClock;
      (
        clock ?? {
          clearTimeout: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle),
        }
      ).clearTimeout(this.ticketCriticalRecoveryTimer);
    }
    if (this.appServerCrashRecoveryTimer) clearTimeout(this.appServerCrashRecoveryTimer);
    this.appServerCrashRecoveryTimer = null;
    this.appServerCrashRecoveryWake?.();
    this.appServerCrashRecoveryWake = null;
    this.ticketCriticalRecoveryTimer = null;
    this.initializationRetryTimer = null;
    this.initializationRetryWake?.();
    this.initializationRetryWake = null;
    this.heartbeatTimer = null;
    this.coalesceTimer = null;
    this.reconnectTimer = null;
    this.subscriptionWatchdog = null;
    this.socketGeneration += 1;
    this.socketSubscribed = false;
    this.socketHandshakeGeneration = null;
    this.rejectModelTransportWaiters(
      new TypeError("Codex Bridge stopped before the MODEL_MCP transport became ready"),
    );
    const socket = this.socket;
    this.socket = null;
    try {
      socket?.close();
    } catch (error: unknown) {
      process.stderr.write(`[crossagent] Hub socket close failed: ${describeError(error)}\n`);
    }
    // Reported before the app-server is torn down: once stop has begun, neither link is usable, and
    // a snapshot claiming otherwise is the sort of stale good news this whole change is about.
    this.appServerRpcAlive = false;
    this.emitHealth();
    const cleanup = (async () => {
      // Start model teardown before any potentially black-holed Hub reconciliation. The child must
      // not remain able to complete a late push while close authority is being established.
      let appServerStop: Promise<void>;
      try {
        appServerStop = Promise.resolve(this.appServer.stop());
      } catch (error: unknown) {
        appServerStop = Promise.reject(error);
      }
      // Attach the rejection owner immediately. Credential reconciliation can perform multiple Hub
      // awaits before it reaches cleanup; leaving an already-rejected child-stop promise bare during
      // that interval produces an unhandled rejection and makes repeated stop() calls disagree.
      const appServerStopResult: Promise<PromiseSettledResult<void>> = appServerStop.then(
        (): PromiseSettledResult<void> => ({ status: "fulfilled", value: undefined }),
        (reason: unknown): PromiseSettledResult<void> => ({ status: "rejected", reason }),
      );
      const awaitLocalCleanup = async (): Promise<Error | null> => {
        const [result] = await Promise.all([
          appServerStopResult,
          Promise.allSettled([initialization ?? Promise.resolve()]),
        ]);
        if (result.status === "rejected") {
          const error =
            result.reason instanceof Error
              ? result.reason
              : new Error(describeError(result.reason));
          process.stderr.write(
            `[crossagent] Codex app-server stop failed: ${describeError(error)}\n`,
          );
          return error;
        }
        return null;
      };
      const withLocalCleanupFailure = (
        outcome: CodexBridgeStopOutcome,
        error: Error | null,
      ): CodexBridgeStopOutcome =>
        error
          ? {
              ...outcome,
              localCleanup: { state: "FAILED", error: describeError(error) },
            }
          : outcome;
      if (this.ticketRenewal) await this.ticketRenewal.stop();
      if (this.ticketCriticalRecoveryInFlight) {
        await this.ticketCriticalRecoveryInFlight.catch(() => undefined);
      }
      try {
        await this.awaitCredentialEpochDrain(stopDrain);
      } catch (error: unknown) {
        const outcome: CodexBridgeStopOutcome = {
          sessionExisted: this.session !== null,
          close: {
            state: this.session ? "AMBIGUOUS" : "NOT_ATTEMPTED",
            sessionId: this.session?.id ?? null,
            bundleId: this.activeTickets?.stored.bundleId ?? null,
          },
        };
        process.stderr.write(
          `[crossagent] credential drain remains recoverable during stop: ${describeError(error)}\n`,
        );
        const finalOutcome = withLocalCleanupFailure(outcome, await awaitLocalCleanup());
        this.terminalStopOutcome = structuredClone(finalOutcome);
        return finalOutcome;
      }
      if (this.sessionTicketRuntime && this.activeTickets) {
        try {
          const reconciled = await this.sessionTicketRuntime.reconcileForConfirmedClose();
          this.activeTickets = reconciled.active;
          this.session = reconciled.session;
          this.hub = reconciled.active.controlHub;
          this.syntheticHub = reconciled.active.injectorHub;
          this.controlSocketToken = reconciled.active.stored.raw.CONTROL;
          this.currentModelMcpToken = reconciled.active.modelMcpToken;
        } catch (error: unknown) {
          const outcome: CodexBridgeStopOutcome = {
            sessionExisted: this.session !== null,
            close: {
              state: this.session ? "AMBIGUOUS" : "NOT_ATTEMPTED",
              sessionId: this.session?.id ?? null,
              bundleId: this.activeTickets?.stored.bundleId ?? null,
            },
          };
          process.stderr.write(
            `[crossagent] ticketed session close reconciliation remains recoverable: ${describeError(error)}\n`,
          );
          const finalOutcome = withLocalCleanupFailure(outcome, await awaitLocalCleanup());
          this.terminalStopOutcome = structuredClone(finalOutcome);
          return finalOutcome;
        }
      }
      const sessionId = this.session?.id ?? null;
      const bundleId = this.activeTickets?.stored.bundleId ?? null;
      let outcome: CodexBridgeStopOutcome = {
        sessionExisted: sessionId !== null,
        close: {
          state: sessionId === null ? "NOT_ATTEMPTED" : "AMBIGUOUS",
          sessionId,
          bundleId,
        },
      };
      const sessionClose = this.session
        ? this.sessionTicketRuntime && this.activeTickets
          ? (async () => {
              const closed = await this.hub.closeAdapterSession(this.session!.id, {
                reason: "codex_bridge_closed",
                idempotencyKey: `codex-session-close:${this.session!.id}:${this.launcherRunId}`,
              });
              if (closed.ticketBinding.bundleId !== this.activeTickets!.stored.bundleId) {
                throw new Error("Hub close receipt does not match the active Codex ticket bundle");
              }
              await this.sessionTicketRuntime!.clearAfterConfirmedClose(
                closed.ticketBinding.bundleId,
              );
              outcome = {
                sessionExisted: true,
                close: {
                  state: "CONFIRMED",
                  sessionId: closed.session.id,
                  bundleId: closed.ticketBinding.bundleId,
                },
              };
            })().catch((error: unknown) => {
              // Ambiguous close must retain raw material for exact replay by the managed successor.
              process.stderr.write(
                `[crossagent] ticketed session close remains recoverable: ${describeError(error)}\n`,
              );
            })
          : this.hub
              .closeSession(this.session.id, "codex_bridge_closed")
              .then((closed) => {
                outcome = {
                  sessionExisted: true,
                  close: {
                    state: "CONFIRMED",
                    sessionId: closed.id,
                    bundleId: null,
                  },
                };
              })
              .catch(() => undefined)
        : Promise.resolve();
      const [localCleanupError] = await Promise.all([awaitLocalCleanup(), sessionClose]);
      const finalOutcome = withLocalCleanupFailure(outcome, localCleanupError);
      this.terminalStopOutcome = structuredClone(finalOutcome);
      return finalOutcome;
    })();
    this.stopPromise = cleanup;
    return cleanup;
  }

  private connectSocket(credentialOwner = false): number | null {
    if (
      this.stopped ||
      !this.project ||
      !this.session ||
      this.socket ||
      (!credentialOwner && this.credentialDrain.phase !== "OPEN")
    ) {
      return null;
    }
    const generation = ++this.socketGeneration;
    this.hubFrameTail = Promise.resolve();
    this.socketSubscribed = false;
    this.socketHandshakeGeneration = null;
    this.setHubSocketUnavailable("Hub socket is awaiting a complete subscription");
    let socket!: WebSocket;
    try {
      socket = openProjectSocket({
        baseUrl: this.options.baseUrl,
        token: this.controlSocketToken,
        projectId: this.project.id,
        sessionId: this.session.id,
        clientType: "codex_bridge",
        lastSequence: this.lastSequence,
        onFrame: (frame) => this.enqueueHubFrame(frame, generation, socket),
        onClose: (event) => {
          if (!this.invalidateSocket(generation, socket)) return;
          if (this.isTerminalSocketClose(event)) {
            this.credentialPlaneCritical = true;
            this.setHubSocketUnavailable(
              `Hub socket closed permanently (${event.code || "unknown"}): ${
                event.reason || "authentication/policy failure"
              }`,
            );
            this.emitHealth();
            const detail = `Hub permanently rejected this Bridge CONTROL credential (${event.code || "unknown"})`;
            this.runDetached(
              "terminal credential rejection",
              this.terminate(detail, new Error(detail)),
            );
            return;
          }
          this.scheduleHubReconnect("Hub socket closed");
        },
      });
      this.socket = socket;
      this.startSubscriptionWatchdog(generation, socket);
      return generation;
    } catch (error: unknown) {
      this.invalidateSocket(generation, socket);
      this.setHubSocketUnavailable(`Hub socket construction failed: ${describeError(error)}`);
      this.scheduleHubReconnect("Hub socket construction failed");
      return null;
    }
  }

  private waitForSocketSubscription(generation: number): Promise<void> {
    if (generation === this.socketHandshakeGeneration) return Promise.resolve();
    if (this.socketSubscriptionWaiter) {
      return Promise.reject(new Error("A CONTROL socket subscription wait is already active"));
    }
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.socketSubscriptionWaiter?.generation === generation) {
          this.socketSubscriptionWaiter = null;
        }
        reject(new TypeError("replacement CONTROL socket subscription timed out"));
      }, this.options.hubSubscriptionTimeoutMs ?? 10_000);
      timer.unref();
      this.socketSubscriptionWaiter = { generation, resolve, reject, timer };
    });
  }

  private resolveSocketSubscription(generation: number): void {
    const waiter = this.socketSubscriptionWaiter;
    if (!waiter || waiter.generation !== generation) return;
    this.socketSubscriptionWaiter = null;
    clearTimeout(waiter.timer);
    waiter.resolve();
  }

  private rejectSocketSubscription(generation: number, error: Error): void {
    const waiter = this.socketSubscriptionWaiter;
    if (!waiter || waiter.generation !== generation) return;
    this.socketSubscriptionWaiter = null;
    clearTimeout(waiter.timer);
    waiter.reject(error);
  }

  private startSubscriptionWatchdog(generation: number, socket: WebSocket): void {
    if (this.subscriptionWatchdog) clearTimeout(this.subscriptionWatchdog);
    this.subscriptionWatchdog = setTimeout(() => {
      this.subscriptionWatchdog = null;
      if (!this.invalidateSocket(generation, socket)) return;
      this.closeSocketBestEffort(socket);
      this.scheduleHubReconnect("Hub socket subscription timed out");
    }, this.options.hubSubscriptionTimeoutMs ?? 10_000);
    this.subscriptionWatchdog.unref();
  }

  private clearSubscriptionWatchdog(): void {
    if (this.subscriptionWatchdog) clearTimeout(this.subscriptionWatchdog);
    this.subscriptionWatchdog = null;
  }

  private invalidateSocket(generation: number, socket: WebSocket): boolean {
    if (generation !== this.socketGeneration) return false;
    this.rejectSocketSubscription(
      generation,
      new TypeError("replacement CONTROL socket closed before subscription"),
    );
    this.socketGeneration += 1;
    if (this.socket === socket) this.socket = null;
    this.socketSubscribed = false;
    if (this.socketHandshakeGeneration === generation) this.socketHandshakeGeneration = null;
    this.clearSubscriptionWatchdog();
    return true;
  }

  private closeSocketBestEffort(socket: WebSocket): void {
    try {
      socket.close();
    } catch (error: unknown) {
      process.stderr.write(`[crossagent] Hub socket close failed: ${describeError(error)}\n`);
    }
  }

  /**
   * Serializes frames from one socket generation and owns the promise-chain terminus.
   *
   * WebSocket listeners are synchronous callbacks, but processing a message performs HTTP reads and
   * Codex pushes. Letting every callback float independently permits sequence N+1 to commit while N
   * is still failing. A failed generation is invalidated immediately; reconnect then asks the Hub to
   * replay from the last sequence that actually completed.
   */
  private enqueueHubFrame(frame: ProjectSocketFrame, generation: number, socket: WebSocket): void {
    this.lastHubEventAt = new Date().toISOString();
    if (
      frame.type === "event" &&
      (frame as { event?: DomainEvent }).event?.type === "session.superseded" &&
      (frame as { event: DomainEvent }).event.aggregateId === this.session?.id &&
      generation === this.socketGeneration &&
      this.socket === socket
    ) {
      // Replacement is a control-plane barrier, not ordinary delivery work. Marking stopped happens
      // synchronously before stop's first await, so a slow frame already in the tail cannot surface
      // any later message while this session is known to be retired.
      this.runDetached("session superseded", this.terminate("session superseded"));
      return;
    }
    if (frame.type === "subscribed" && generation === this.socketGeneration) {
      // TCP and the subscribe handshake completed. Catch-up may still fail, but the CONNECTING
      // watchdog no longer owns this socket while the ordered tail validates the high-water mark.
      this.clearSubscriptionWatchdog();
    }
    const processing = this.hubFrameTail.then(async () => {
      if (this.stopped || generation !== this.socketGeneration) return;
      await this.onHubFrame(frame, generation, socket);
    });
    this.hubFrameTail = processing.catch((error: unknown) => {
      if (this.stopped || generation !== this.socketGeneration) return;
      this.handleDetachedHubFailure(`Hub frame ${frame.type}`, error);
      if (!this.invalidateSocket(generation, socket)) return;
      this.closeSocketBestEffort(socket);
      if (this.isRetryableHubFrameError(error)) {
        this.scheduleHubReconnect(`Hub frame ${frame.type} failed`);
      } else {
        // A permanent/ambiguous event is poison until a human or a new build resolves it. Replaying
        // it every 250ms would burn CPU and could duplicate an external Codex side effect.
        this.setHubSocketUnavailable(
          `Hub event processing paused after ${frame.type}: ${describeError(error)}`,
        );
      }
    });
  }

  private isRetryableHubFrameError(error: unknown): boolean {
    if (isHubNetworkError(error)) return true;
    if (
      error instanceof HubSequenceGapError ||
      error instanceof HubResyncRequiredError ||
      error instanceof HubSocketRetryableError
    )
      return true;
    return (
      error instanceof HubHttpError &&
      (error.status === 408 || error.status === 429 || error.status >= 500)
    );
  }

  private scheduleHubReconnect(reason: string): void {
    if (
      this.stopped ||
      this.reconnectTimer ||
      this.credentialPlaneCritical ||
      this.credentialDrain.phase !== "OPEN"
    ) {
      return;
    }
    const delayMs = this.socketReconnectBackoff.nextDelayMs();
    this.setHubSocketUnavailable(`${reason}; reconnecting in ${delayMs}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectSocket();
    }, delayMs);
    this.reconnectTimer.unref();
  }

  private isTerminalSocketClose(event: CloseEvent): boolean {
    if ([1002, 1003, 1008].includes(event.code)) return true;
    if ([1006, 1012, 1013].includes(event.code)) return false;
    return /auth|credential|token|revok|forbidden|unauthor|policy|binding|incarnation|build(?:_|\s|-)?mismatch/iu.test(
      event.reason,
    );
  }

  private async onHubFrame(
    frame: ProjectSocketFrame,
    generation = this.socketGeneration,
    socket = this.socket as WebSocket,
  ): Promise<void> {
    if (frame.type === "subscribed") {
      const currentSequence = Number((frame as { currentSequence?: unknown }).currentSequence);
      if (!Number.isSafeInteger(currentSequence) || currentSequence < 0) {
        throw new Error("Hub subscribed frame carried an invalid currentSequence");
      }
      await this.catchUpTo(currentSequence, generation, socket);
      this.ensureSocketGeneration(generation, socket);
      this.socketHandshakeGeneration = generation;
      this.socketSubscribed = true;
      this.markHubSocketAvailable();
      this.resolveSocketSubscription(generation);
      return;
    }
    if (frame.type === "event") {
      const event = (frame as { event: DomainEvent }).event;
      await this.commitHubEvent(
        event,
        generation,
        socket,
        (frame as { replay?: unknown }).replay === true,
      );
      return;
    }
    if (frame.type === "resync_required") {
      throw new HubResyncRequiredError(
        String((frame as { reason?: unknown }).reason ?? "server requested resync"),
      );
    }
    if (frame.type === "error") {
      const code = String((frame as { code?: unknown }).code ?? "UNKNOWN");
      const detail = `Hub socket error ${code}: ${String(
        (frame as { message?: unknown }).message ?? "unknown error",
      )}`;
      if (code === "PONG_FAILED") throw new HubSocketRetryableError(detail);
      throw new Error(detail);
    }
  }

  private async catchUpTo(
    targetSequence: number,
    generation: number,
    socket: WebSocket,
  ): Promise<void> {
    if (!this.project) return;
    let pages = 0;
    while (this.lastSequence < targetSequence) {
      if (pages >= MAX_CATCHUP_PAGES_PER_CONNECTION) {
        throw new HubSequenceGapError(this.lastSequence + 1, targetSequence);
      }
      const events = await this.hubRequest("event catch-up", () =>
        this.hub.listEvents(this.project!.id, this.lastSequence, HUB_EVENT_PAGE_SIZE),
      );
      this.ensureSocketGeneration(generation, socket);
      let progressed = false;
      for (const event of events) {
        if (event.sequence > targetSequence) break;
        const before = this.lastSequence;
        // REST catch-up is the same closed historical set as an explicit WebSocket replay frame.
        await this.commitHubEvent(event, generation, socket, true);
        progressed ||= this.lastSequence > before;
      }
      if (!progressed) {
        throw new HubSequenceGapError(this.lastSequence + 1, targetSequence);
      }
      pages += 1;
    }
  }

  private async commitHubEvent(
    event: DomainEvent,
    generation: number,
    socket: WebSocket,
    historicalReplay = false,
  ): Promise<void> {
    if (event.sequence <= this.lastSequence) return;
    const expected = this.lastSequence + 1;
    if (event.sequence !== expected) throw new HubSequenceGapError(expected, event.sequence);
    let checkpointMessage: CrossAgentMessage | null = null;
    let historicalReferenceMissing = false;
    try {
      checkpointMessage = await this.preflightCheckpointMessage(event);
    } catch (error: unknown) {
      if (!this.isDeterministicHistoricalMessageNotFound(event, historicalReplay, error)) {
        throw error;
      }
      // A replay flag is Hub evidence that the event predates this subscription. A typed, exact
      // message absence at that read seam is therefore deterministic for this authenticated
      // session. Persist a bounded idempotent diagnostic before advancing: the cursor may move only
      // after the poison reference itself has an auditable terminal outcome.
      await this.recordHistoricalMissingMessageReference(event);
      historicalReferenceMissing = true;
    }
    const checkpointMessageId = checkpointMessage?.id ?? null;
    if (checkpointMessageId && this.sessionTicketRuntime && this.activeTickets) {
      // Write-ahead capacity and recovery authority must be durable before any synthetic prompt or
      // app-server RPC can make the event model-visible.
      await this.sessionTicketRuntime.reservePendingMessage(
        this.activeTickets,
        checkpointMessageId,
      );
    }
    if (!historicalReferenceMissing) {
      await this.processHubEvent(event, generation, socket, checkpointMessage ?? undefined);
    }
    if (this.stopped) return;
    this.ensureSocketGeneration(generation, socket);
    if (this.sessionTicketRuntime && this.activeTickets) {
      const pendingMessageIds = this.checkpointPendingMessageIds(event);
      await this.sessionTicketRuntime.commitEventSequence(
        this.activeTickets,
        event.sequence,
        pendingMessageIds,
      );
      this.ensureSocketGeneration(generation, socket);
      if (checkpointMessageId && this.checkpointPendingMessageIds(event).length === 0) {
        await this.sessionTicketRuntime.settlePendingMessage(
          this.activeTickets,
          checkpointMessageId,
        );
      }
    }
    this.lastSequence = event.sequence;
  }

  private isDeterministicHistoricalMessageNotFound(
    event: DomainEvent,
    historicalReplay: boolean,
    error: unknown,
  ): boolean {
    return (
      historicalReplay &&
      (event.type === "message.posted" || event.type === "message.surface.released") &&
      error instanceof HubHttpError &&
      error.status === 404 &&
      error.code === "NOT_FOUND" &&
      error.message === `Message not found: ${event.aggregateId}`
    );
  }

  private async recordHistoricalMissingMessageReference(event: DomainEvent): Promise<void> {
    const session = this.session;
    if (!session) throw new HubResyncRequiredError("session disappeared during historical replay");
    await this.hubRequest("historical message reference audit", () =>
      this.hub.recordAdapterEvent(session.id, {
        method: "history.reference_missing",
        itemType: event.type,
        itemId: event.aggregateId,
        commandName: event.id,
        status: `historical_not_found:${event.sequence}`,
        error: "Explicitly replayed message reference returned exact NOT_FOUND",
        idempotencyKey: adapterEventKey(session.id, "history.reference_missing", event.id),
      }),
    );
  }

  /** Classify without model side effects so unrelated project mail never consumes local capacity. */
  private async preflightCheckpointMessage(event: DomainEvent): Promise<CrossAgentMessage | null> {
    if (event.type !== "message.posted" && event.type !== "message.surface.released") {
      return null;
    }
    if (event.type === "message.surface.released") {
      const payload =
        event.payload && typeof event.payload === "object"
          ? (event.payload as Record<string, unknown>)
          : undefined;
      if (stringValue(payload?.successorSessionId) !== this.session?.id) return null;
    }
    const message = await this.hubRequest("message checkpoint preflight", () =>
      this.hub.getMessage(event.aggregateId),
    );
    const recipient = this.recipientFor(message);
    if (
      !recipient ||
      TERMINAL_RECIPIENT_STATES.includes(recipient.state) ||
      message.fromSessionId === this.session?.id
    ) {
      return null;
    }
    return message;
  }

  private checkpointPendingMessageIds(event: DomainEvent): string[] {
    const messageId = event.aggregateId;
    if (event.type !== "message.posted" && event.type !== "message.surface.released") {
      return [];
    }
    const queued = [...this.importantQueue, ...this.normalQueue].some(
      (message) => message.id === messageId,
    );
    return queued ||
      this.pendingDeliveryStates.has(messageId) ||
      this.pausedAmbiguousMessages.has(messageId) ||
      this.ambiguousMessageReasons.has(messageId) ||
      this.deferredCredentialMessages.has(messageId) ||
      this.surfacePermits.has(messageId)
      ? [messageId]
      : [];
  }

  private ensureSocketGeneration(generation: number, socket: WebSocket): void {
    if (this.stopped || generation !== this.socketGeneration || this.socket !== socket) {
      throw new HubResyncRequiredError("socket generation changed during event processing");
    }
  }

  private async processHubEvent(
    event: DomainEvent,
    generation: number,
    socket: WebSocket,
    checkpointMessage?: CrossAgentMessage,
  ): Promise<void> {
    if (event.type === "session.superseded" && event.aggregateId === this.session?.id) {
      await this.terminate("session superseded");
      return;
    }
    const payload =
      event.payload && typeof event.payload === "object"
        ? (event.payload as Record<string, unknown>)
        : undefined;
    const releasedToThisSession =
      event.type === "message.surface.released" &&
      stringValue(payload?.successorSessionId) === this.session?.id;
    if (event.type === "message.posted" || releasedToThisSession) {
      if (!this.appServerRecoveryFuse.blocksModelAdmission) {
        await this.awaitModelTransportReady();
      }
      this.ensureSocketGeneration(generation, socket);
      await this.onMessageEvent(event, generation, socket, checkpointMessage);
    }
  }

  /**
   * This session's own recipient row, which is the only one whose state says anything about what
   * this Bridge still owes. A row addressed to the agent with no session bound to it counts: that is
   * how a message sent before this session existed reaches it.
   */
  private recipientFor(message: CrossAgentMessage) {
    const agentId = this.session?.agentId;
    const sessionId = this.session?.id;
    return (
      message.recipients.find(
        (candidate) =>
          candidate.recipientAgentId === agentId && candidate.recipientSessionId === sessionId,
      ) ??
      message.recipients.find(
        (candidate) =>
          candidate.recipientAgentId === agentId && candidate.recipientSessionId === null,
      )
    );
  }

  private clearAmbiguousMessage(messageId: string): void {
    this.ambiguousMessageReasons.delete(messageId);
    this.ambiguousSurfaceProofs.delete(messageId);
    this.pausedAmbiguousMessages.delete(messageId);
    this.unreadableSurfaceMessageIds.delete(messageId);
  }

  private async onMessageEvent(
    event: DomainEvent,
    generation?: number,
    socket?: WebSocket,
    checkpointMessage?: CrossAgentMessage,
  ): Promise<void> {
    if (!this.session) return;
    const message =
      checkpointMessage ??
      (await this.hubRequest("message read", () => this.hub.getMessage(event.aggregateId)));
    this.ensureOptionalSocketGeneration(generation, socket);
    const recipient = this.recipientFor(message);
    // Unresolved delivery states stay eligible so a restarted adapter recovers work that was never
    // completed; the terminal ones are finished with, and so is anything this session already saw
    // all the way through — DELIVERED is deliberately replayable across a restart, which without
    // this would also mean replayable within the session that just delivered it.
    if (
      !recipient ||
      TERMINAL_RECIPIENT_STATES.includes(recipient.state) ||
      this.deliveredMessageIds.has(message.id) ||
      message.fromSessionId === this.session.id
    ) {
      return;
    }
    if (
      this.credentialDrain.phase === "DRAINING" ||
      this.appServerRecoveryFuse.blocksModelAdmission
    ) {
      this.deferredCredentialMessages.set(message.id, message);
      return;
    }
    // Codex already has it and only the Hub write is outstanding, so finish that and nothing else:
    // pushing again would show the user the same event twice for a bookkeeping failure.
    if (this.confirmedMessageIds.has(message.id)) {
      await this.withCredentialAdmission("MESSAGE_SURFACE", async () => {
        const owned = await this.claimForSurface(message, generation, socket);
        const permit = this.surfacePermits.get(message.id);
        if (owned && permit) await this.markDelivered(owned, permit);
      });
      return;
    }
    return this.pushOnce(message, () => this.dispatchPush(message, generation, socket));
  }

  /**
   * Runs a push at most once per message, whichever way the message arrived.
   *
   * Both the socket and the queue flush can reach for the same message, and a push is not a quick
   * operation any more — it waits for Codex to confirm. Without this, a second event arriving during
   * that window pushes it again and the user sees one event twice.
   */
  private async pushOnce(
    message: CrossAgentMessage,
    push: () => Promise<void>,
    admission?: CredentialAdmission,
  ): Promise<void> {
    const ownedAdmission = admission ?? (await this.credentialDrain.admit("MESSAGE_SURFACE"));
    try {
      if (this.deliveredMessageIds.has(message.id)) return;
      const inFlight = this.pushesInFlight.get(message.id);
      if (inFlight) return inFlight;
      const started = push();
      this.pushesInFlight.set(message.id, started);
      try {
        await started;
      } finally {
        this.pushesInFlight.delete(message.id);
      }
    } finally {
      if (!admission) ownedAdmission.release();
    }
  }

  private async flushDeferredCredentialMessages(): Promise<void> {
    for (const deferred of [...this.deferredCredentialMessages.values()].sort(
      (left, right) => left.sequence - right.sequence,
    )) {
      if (this.stopped) return;
      const message = await this.hubRequest("deferred credential message read", () =>
        this.hub.getMessage(deferred.id),
      );
      await this.onMessageEvent(
        { aggregateId: message.id } as DomainEvent,
        undefined,
        undefined,
        message,
      );
      if (
        this.credentialDrain.phase !== "OPEN" ||
        this.appServerRecoveryFuse.blocksModelAdmission
      ) {
        return;
      }
      if (
        this.pushAction(message) === "mailbox" &&
        this.sessionTicketRuntime &&
        this.activeTickets
      ) {
        await this.sessionTicketRuntime.settlePendingMessage(this.activeTickets, message.id);
      }
      this.deferredCredentialMessages.delete(message.id);
    }
  }

  private scheduleDeferredCredentialFlush(): void {
    if (
      this.stopped ||
      this.credentialDrain.phase !== "OPEN" ||
      this.appServerRecoveryFuse.blocksModelAdmission ||
      !this.modelTransportReady ||
      this.deferredCredentialMessages.size === 0 ||
      this.deferredCredentialFlushInFlight
    ) {
      return;
    }
    const operation = this.flushDeferredCredentialMessages();
    const owned = operation.finally(() => {
      if (this.deferredCredentialFlushInFlight === owned) {
        this.deferredCredentialFlushInFlight = null;
      }
    });
    this.deferredCredentialFlushInFlight = owned;
    this.runDetached("deferred credential delivery", owned);
  }

  private async dispatchPush(
    message: CrossAgentMessage,
    generation?: number,
    socket?: WebSocket,
  ): Promise<void> {
    const action = this.pushAction(message);
    if (action === "mailbox") return;
    const owned = await this.claimForSurface(message, generation, socket);
    if (!owned) return;
    if (action === "steer") return this.steer(owned, generation, socket);
    if (action === "wake") return this.wake(owned, generation, socket);
    if (action === "inject") return this.inject(owned, undefined, generation, socket);
    if (owned.priority === "IMPORTANT") {
      this.enqueue(this.importantQueue, owned);
      this.scheduleImportantFlush();
    } else {
      this.enqueue(this.normalQueue, owned);
    }
  }

  private pushAction(message: CrossAgentMessage): ReturnType<typeof choosePushAction> {
    return choosePushAction(message.priority, {
      activeTurn: Boolean(this.activeTurnId),
      online: true,
      atSafeCheckpoint: false,
      wakePolicy: this.options.wakePolicy ?? "urgent_and_action_required",
    });
  }

  /**
   * Claims an agent-wide recipient before any Codex-visible push or queue entry. Every Bridge sees
   * the same project event, but only the SQLite claim winner may cross the app-server Seam.
   */
  private async claimForSurface(
    message: CrossAgentMessage,
    generation?: number,
    socket?: WebSocket,
  ): Promise<CrossAgentMessage | null> {
    const session = this.session;
    if (!session) return null;
    const recipient = this.recipientFor(message);
    if (!recipient) return null;
    try {
      const claimed = await this.hubRequest("message recipient claim", () =>
        this.hub.claimMessageRecipient(message.id, {
          sessionId: session.id,
          // This endpoint is also the just-in-time liveness/state fence. Reusing the first claim's
          // idempotency key would replay its cached response and silently skip that revalidation.
          idempotencyKey: `codex-claim:${session.id}:${message.id}:${++this.claimSequence}`,
        }),
      );
      this.ensureOptionalSocketGeneration(generation, socket);
      const claimedRecipient = this.recipientFor(claimed);
      if (claimedRecipient?.recipientSessionId !== session.id) return null;
      if (TERMINAL_RECIPIENT_STATES.includes(claimedRecipient.state)) {
        this.clearAmbiguousMessage(message.id);
        this.emitHealth();
        return null;
      }
      return claimed;
    } catch (error) {
      if (error instanceof HubHttpError && error.code === "MESSAGE_RECIPIENT_CLAIMED") return null;
      if (error instanceof HubHttpError && error.code === "SESSION_CLOSED") {
        this.runDetached(
          "session closed during recipient claim",
          this.terminate("Hub closed this Bridge session"),
        );
        return null;
      }
      throw error;
    }
  }

  /**
   * The soft recipient claim decides which queue owns work; this persisted permit is the authority
   * to cross the app-server Seam. Replacement and permit acquisition serialize in SQLite, so either
   * the predecessor gets the permit and keeps the recipient, or the successor advances first and
   * the predecessor is rejected before Codex can see anything.
   */
  private async acquireSurfacePermit(
    message: CrossAgentMessage,
    generation?: number,
    socket?: WebSocket,
  ): Promise<SurfaceDelivery | null> {
    const session = this.session;
    if (!session) return null;
    try {
      const result = await this.hubRequest("surface permit", () =>
        this.hub.beginMessageSurface(message.id, {
          sessionId: session.id,
          idempotencyKey: `codex-surface:${session.id}:${message.id}:${++this.surfaceSequence}`,
        }),
      );
      try {
        this.ensureOptionalSocketGeneration(generation, socket);
      } catch (error: unknown) {
        await this.settleSurfacePermit(result.permit, "ABORTED", describeError(error));
        throw error;
      }
      this.surfacePermits.set(message.id, result.permit);
      return result;
    } catch (error) {
      if (
        error instanceof HubHttpError &&
        [
          "MESSAGE_ALREADY_SURFACED",
          "MESSAGE_RECIPIENT_CLAIMED",
          "MESSAGE_SURFACE_IN_FLIGHT",
        ].includes(error.code)
      ) {
        return null;
      }
      if (
        error instanceof HubHttpError &&
        ["SESSION_CLOSED", "SESSION_INCARNATION_CONFLICT"].includes(error.code)
      ) {
        this.runDetached(
          "session rejected during surface admission",
          this.terminate(`Hub rejected this Bridge incarnation: ${error.code}`),
        );
        return null;
      }
      throw error;
    }
  }

  private authorityCandidateMatchesSurface(
    candidate: AdapterAuthorityDeliveryCandidate,
    message: CrossAgentMessage,
    permit: MessageSurfacePermit,
  ): boolean {
    const delivery =
      candidate.kind === "AUTHORITY" ? candidate.bundle.delivery : candidate.delivery;
    const expectedMessage = {
      priority: message.priority,
      id: message.id,
      threadId: message.threadId,
      fromAgentId: message.fromAgentId,
      summary: clipText(message.summary, 1_600),
    };
    return (
      delivery.projectId === message.projectId &&
      delivery.carrierMessageId === message.id &&
      delivery.targetAgentId === "codex" &&
      delivery.targetSessionId === permit.sessionId &&
      delivery.targetSessionIncarnation === permit.sessionIncarnation &&
      delivery.surfaceAttemptId === permit.id &&
      delivery.recipientFence === permit.recipientFence &&
      delivery.state === "ACTIVE" &&
      (candidate.kind === "AUTHORITY" ||
        canonicalJson(candidate.message) === canonicalJson(expectedMessage))
    );
  }

  private isTerminalAuthorityCandidate(
    candidate: AdapterAuthorityDeliveryCandidate,
    reason?: string,
  ): boolean {
    return (
      candidate.kind === "AUTHORITY" &&
      (["REVOKED", "SUPERSEDED", "COMPLETED", "EXPIRED"].includes(
        candidate.bundle.authorityBundle.directive.lifecycle,
      ) ||
        [
          "DIRECTIVE_REVOKED",
          "DIRECTIVE_EXPIRED",
          "DIRECTIVE_NOT_ACTIVE",
          "DELEGATION_NOT_ACTIVE",
          "DELEGATION_EXPIRED",
        ].includes(reason ?? ""))
    );
  }

  /**
   * Resolve the candidate over the Agent-authenticated channel and, for signed authority, validate
   * it against local fingerprint pins. A live Hub key response can refresh status for a known pin;
   * it can never enroll a new trust root. Terminal lifecycle is a safe zero-injection checkpoint,
   * while every malformed or unverifiable ACTIVE authority carrier remains a hard failure.
   */
  private async resolveAuthorityDeliveryCandidate(
    message: CrossAgentMessage,
    permit: MessageSurfacePermit,
  ): Promise<ResolvedAuthorityDelivery | null> {
    let candidate: AdapterAuthorityDeliveryCandidate;
    try {
      candidate = await this.hubRequest("authority delivery candidate", () =>
        this.hub.getAuthorityDeliveryCandidate(message.id, {
          session_id: permit.sessionId,
          surface_attempt_id: permit.id,
          recipient_fence: permit.recipientFence,
        }),
      );
    } catch (error: unknown) {
      if (
        error instanceof HubHttpError &&
        ["DIRECTIVE_INACTIVE", "DIRECTIVE_REVOKED", "DIRECTIVE_EXPIRED"].includes(error.code)
      ) {
        await this.settleSurfacePermit(permit, "ABORTED", error.code);
        return null;
      }
      throw error;
    }
    const parsed = AdapterAuthorityDeliveryCandidateSchema.parse(candidate);
    if (!this.authorityCandidateMatchesSurface(parsed, message, permit)) {
      throw new Error("Hub returned an authority candidate outside the active surface binding");
    }
    if (parsed.kind === "ORDINARY") {
      return { candidate: parsed, verifiedModelText: null };
    }

    const liveKeys = await this.hubRequest("authority signing keys", () =>
      this.hub.listAuthoritySigningKeys(),
    );
    const trustedSigningKeys = refreshTrustedAuthoritySigningKeys(
      this.authorityTrustManifest,
      liveKeys,
    );
    if (trustedSigningKeys.length === 0) {
      throw new Error(
        `Authority verification failed for ${message.id}: INVALID/UNTRUSTED_SIGNING_KEY`,
      );
    }
    const result = await verifyAndRenderAuthorityIngress(parsed.bundle, {
      projectId: message.projectId,
      carrierMessageId: message.id,
      targetAgentId: "codex",
      targetSessionId: permit.sessionId,
      targetSessionIncarnation: permit.sessionIncarnation,
      surfaceAttemptId: permit.id,
      recipientFence: permit.recipientFence,
      observedAt: new Date().toISOString(),
      trustedSigningKeys,
    });
    if (result.verification === "VALID") {
      return { candidate: parsed, verifiedModelText: result.modelText };
    }
    if (this.isTerminalAuthorityCandidate(parsed, result.reason)) {
      await this.settleSurfacePermit(
        permit,
        "ABORTED",
        `terminal authority directive: ${result.verification}/${result.reason}`,
      );
      return null;
    }
    throw new Error(
      `Authority verification failed for ${message.id}: ${result.verification}/${result.reason}`,
    );
  }

  /**
   * Prepare the exact role=user text before the app-server can observe it. Hub and Bridge render the
   * same strictly parsed candidate independently; both the candidate and final UTF-8 bytes must be
   * identical before any of the three app-server input RPCs can run.
   */
  private async prepareSyntheticPrompt(
    message: CrossAgentMessage,
    permit: MessageSurfacePermit,
    rpcMethod: SyntheticPromptRpcMethod,
  ): Promise<PreparedSyntheticPrompt | null> {
    let prepared: PreparedSyntheticPrompt | null = null;
    try {
      const authorityDelivery = await this.resolveAuthorityDeliveryCandidate(message, permit);
      if (!authorityDelivery) return null;
      const { candidate: authorityCandidate, verifiedModelText } = authorityDelivery;
      if (this.hookCaptureBindingMode === "disabled") {
        const originNonce = randomBytes(32).toString("base64url");
        const text = renderAdapterAuthorityDeliveryCandidate(authorityCandidate, originNonce);
        const preparedAt = new Date().toISOString();
        prepared = {
          id: createId("spr_compat"),
          sourceMessageId: message.id,
          surfaceAttemptId: permit.id,
          recipientFence: permit.recipientFence,
          rpcMethod,
          originNonce,
          text,
          rawTextSha256: createHash("sha256").update(text, "utf8").digest("hex"),
          authorityCandidate,
          preparedAt,
          expiresAt: new Date(Date.parse(preparedAt) + 120_000).toISOString(),
          state: "PREPARED",
          replayed: false,
        };
      } else {
        prepared = await this.hubRequest(`synthetic prompt ${rpcMethod}`, () =>
          this.syntheticHub.prepareSyntheticPrompt(message.id, {
            injector_hub_session_id: permit.sessionId,
            surface_attempt_id: permit.id,
            recipient_fence: permit.recipientFence,
            rpc_method: rpcMethod,
            idempotency_key: `codex-synthetic:${permit.id}:${rpcMethod}`,
          }),
        );
      }
      const preparedCandidate = AdapterAuthorityDeliveryCandidateSchema.parse(
        prepared.authorityCandidate,
      );
      const candidateMatches =
        canonicalJson(preparedCandidate) === canonicalJson(authorityCandidate);
      const locallyRenderedText = renderAdapterAuthorityDeliveryCandidate(
        preparedCandidate,
        prepared.originNonce,
      );
      const firstLineEnd = locallyRenderedText.indexOf("\n");
      const closingTagStart = locallyRenderedText.lastIndexOf("\n</CrossAgentEvent>");
      const locallyRenderedModelText =
        firstLineEnd >= 0 && closingTagStart > firstLineEnd
          ? locallyRenderedText.slice(firstLineEnd + 1, closingTagStart)
          : null;
      const exactHash = createHash("sha256").update(prepared.text, "utf8").digest("hex");
      const preparedAt = Date.parse(prepared.preparedAt);
      const expiresAt = Date.parse(prepared.expiresAt);
      if (
        prepared.state !== "PREPARED" ||
        prepared.sourceMessageId !== message.id ||
        prepared.surfaceAttemptId !== permit.id ||
        prepared.recipientFence !== permit.recipientFence ||
        prepared.rpcMethod !== rpcMethod ||
        !candidateMatches ||
        !this.authorityCandidateMatchesSurface(preparedCandidate, message, permit) ||
        (verifiedModelText !== null && locallyRenderedModelText !== verifiedModelText) ||
        locallyRenderedText !== prepared.text ||
        exactHash !== prepared.rawTextSha256 ||
        extractSyntheticOriginNonce(prepared.text) !== prepared.originNonce ||
        !Number.isFinite(preparedAt) ||
        !Number.isFinite(expiresAt) ||
        expiresAt <= Date.now() ||
        expiresAt <= preparedAt ||
        expiresAt - preparedAt > 120_000
      ) {
        throw new Error("Hub returned a synthetic prompt outside the requested surface binding");
      }
      return prepared;
    } catch (error: unknown) {
      if (prepared) {
        try {
          await this.abortSyntheticPromptReservation(prepared, permit, describeError(error));
        } catch (abortError: unknown) {
          process.stderr.write(
            `[crossagent] synthetic prompt abort failed: ${describeError(abortError)}\n`,
          );
        }
      }
      // No app-server call has happened. Releasing the surface is safe; if Hub itself is unavailable,
      // the failed settlement leaves the ACTIVE permit fail-closed rather than risking an untracked push.
      await this.settleSurfacePermit(permit, "ABORTED", describeError(error));
      throw error;
    }
  }

  private async settleSurfacePermit(
    permit: MessageSurfacePermit,
    state: "ABORTED" | "AMBIGUOUS",
    error?: string,
    requireDurable = false,
  ): Promise<void> {
    try {
      const result = await this.hubRequest(`surface permit ${state.toLowerCase()}`, () =>
        this.hub.updateMessageSurface(permit.messageId, permit.id, {
          sessionId: permit.sessionId,
          state,
          error,
          idempotencyKey: `codex-surface-${state.toLowerCase()}:${permit.id}`,
        }),
      );
      this.surfacePermits.set(permit.messageId, result.permit);
      if (state === "ABORTED") this.surfacePermits.delete(permit.messageId);
    } catch (settleError: unknown) {
      // ACTIVE is already fail-closed if this bookkeeping write cannot reach Hub. Never compensate
      // by issuing a second app-server call: the first request may still settle remotely.
      process.stderr.write(
        `[crossagent] surface permit ${state.toLowerCase()} write failed: ${describeError(
          settleError,
        )}\n`,
      );
      if (requireDurable) throw settleError;
    }
  }

  private async abortSyntheticPromptReservation(
    prepared: PreparedSyntheticPrompt,
    permit: MessageSurfacePermit,
    reason: string,
  ): Promise<void> {
    if (this.hookCaptureBindingMode === "disabled" && prepared.id.startsWith("spr_compat_")) {
      return;
    }
    const aborted = await this.hubRequest("synthetic prompt abort", () =>
      this.syntheticHub.abortSyntheticPrompt(prepared.id, {
        injector_hub_session_id: permit.sessionId,
        surface_attempt_id: permit.id,
        recipient_fence: permit.recipientFence,
        reason,
        idempotency_key: `codex-synthetic-abort:${prepared.id}`,
      }),
    );
    if (
      aborted.id !== prepared.id ||
      aborted.sourceMessageId !== permit.messageId ||
      aborted.surfaceAttemptId !== permit.id ||
      aborted.recipientFence !== permit.recipientFence ||
      aborted.rpcMethod !== prepared.rpcMethod ||
      aborted.state !== "ABORTED"
    ) {
      throw new Error("Hub returned a synthetic abort outside the requested surface binding");
    }
  }

  private ensureOptionalSocketGeneration(generation?: number, socket?: WebSocket): void {
    if (generation === undefined || socket === undefined) {
      if (this.stopped) throw new HubResyncRequiredError("Bridge stopped during event processing");
      return;
    }
    this.ensureSocketGeneration(generation, socket);
  }

  private async handleSessionFailure(error: unknown): Promise<void> {
    if (error instanceof HubHttpError && error.code === "SESSION_CLOSED") {
      await this.terminate("Hub closed this Bridge session");
      return;
    }
    if (isHubNetworkError(error)) {
      this.handleDetachedHubFailure("session heartbeat", error);
      return;
    }
    process.stderr.write(
      `[crossagent] session heartbeat failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
  }

  /**
   * Queued once per message. Nothing has been pushed at Codex yet, so the confirmation bookkeeping
   * cannot deduplicate here, and two events for one message would otherwise become two injections
   * when the turn ends — the user seeing the same event twice.
   */
  private enqueue(queue: CrossAgentMessage[], message: CrossAgentMessage): void {
    if (queue.some((queued) => queued.id === message.id)) return;
    queue.push(message);
  }

  /**
   * Wakes an idle task, and reports delivery only once Codex says the turn actually started.
   *
   * This is the whole point of the fix: `turn/start` resolving with a turn id proves the app-server
   * answered, not that the bound thread received anything. In the reported incident it answered
   * three times, Hub recorded three DELIVERED messages, no turn ever started, and the reviews sat
   * unread until the user typed a message by hand.
   */
  private async wake(
    message: CrossAgentMessage,
    generation?: number,
    socket?: WebSocket,
    existingPermit?: MessageSurfacePermit,
  ): Promise<void> {
    const surface = existingPermit
      ? { message, permit: existingPermit }
      : await this.acquireSurfacePermit(message, generation, socket);
    if (!surface) return;
    const prepared = await this.prepareSyntheticPrompt(
      surface.message,
      surface.permit,
      "turn/start",
    );
    if (!prepared) return;
    const push = this.beginPush("wake", surface.message, surface.permit);
    let turnId: string;
    try {
      turnId = await this.startTurnAdmitted(prepared.text, surface.message.id);
    } catch (error: unknown) {
      if (isProvenPreSideEffectRpcRejection("turn/start", error)) {
        await this.settleSurfacePermit(surface.permit, "ABORTED", describeError(error));
        throw error;
      }
      await push.ambiguous(describeError(error));
      if (isIndeterminateAppServerTransportFailure("turn/start", error)) {
        await this.restartTransport(`ambiguous turn/start transport for ${surface.message.id}`);
        return;
      }
      throw error;
    }
    this.runDetached("wake RPC telemetry", push.rpcAccepted(turnId));
    // Prefer the live notification, but accept a durable read only when the exact turn returned by
    // this `turn/start` holds the exact client id. Either half alone remains insufficient: a marker
    // in another turn cannot prove this wake, and a bare RPC answer cannot prove Codex stored it.
    if (await this.awaitClientMessage(surface.message.id, turnId)) {
      await push.confirmed(`turn ${turnId} carries the message`, turnId);
      await this.markDelivered(surface.message, surface.permit);
      return;
    }
    // Deliberately left undelivered: the recipient stays replayable and the sender keeps seeing an
    // unresolved message, instead of being told a lie that only a human notices.
    await push.ambiguous(
      `Codex never surfaced ${surface.message.id} in turn ${turnId} within ${
        this.confirmationTimeoutMs
      }ms`,
      turnId,
    );
  }

  private async steer(
    message: CrossAgentMessage,
    generation?: number,
    socket?: WebSocket,
  ): Promise<void> {
    if (!this.threadId || !this.activeTurnId) {
      // The turn ended between choosing "steer" and getting here, so the thread is idle again and
      // this is a wake, not a steer. Injecting instead would neither rouse Codex nor be confirmable.
      await this.wake(message, generation, socket);
      return;
    }
    const surface = await this.acquireSurfacePermit(message, generation, socket);
    if (!surface) return;
    const prepared = await this.prepareSyntheticPrompt(
      surface.message,
      surface.permit,
      "turn/steer",
    );
    if (!prepared) return;
    const expectedTurnId = this.activeTurnId;
    const push = this.beginPush("steer", surface.message, surface.permit);
    let steeredTurnId: string | undefined;
    try {
      const result = await this.request<{ turnId?: string }>("turn/steer", {
        threadId: this.threadId,
        expectedTurnId,
        input: [{ type: "text", text: prepared.text }],
        clientUserMessageId: surface.message.id,
      });
      steeredTurnId = stringValue(result?.turnId);
    } catch (error: unknown) {
      // A numeric wire code means app-server explicitly rejected the steer (the real
      // turn-rollover response is -32600), so the message was not accepted and can be
      // injected safely. A timeout or closed transport has no wire code and is
      // indeterminate; rethrow it instead of risking a duplicate delivery.
      if (!isProvenPreSideEffectRpcRejection("turn/steer", error)) {
        await push.ambiguous(describeError(error), expectedTurnId);
        if (isIndeterminateAppServerTransportFailure("turn/steer", error)) {
          // Delivery ownership stays ambiguous, so never issue this message again. The connection
          // itself is no longer trustworthy: replace it in-band, then commit this Hub event so later
          // events can continue on the fresh app-server transport.
          await this.restartTransport(`ambiguous turn/steer timeout for ${surface.message.id}`);
          return;
        }
        throw error;
      }
      // No terminal push event here on purpose: the inject below opens its own, so the stream reads
      // "steer attempted, then inject confirmed" rather than claiming the steer failed outright.
      //
      // Known gap, deliberately left: the rejected steer means the turn is over, so this injects
      // into a thread that is now idle -- and on codex-cli 0.145.0 that can never be confirmed.
      // The message stays PENDING and replayable rather than being falsely reported delivered, and
      // the retry re-enters choosePushAction, which wakes. See docs/known-limitations.md.
      await this.abortSyntheticPromptReservation(prepared, surface.permit, describeError(error));
      this.activeTurnId = null;
      await this.inject(surface.message, surface.permit);
      return;
    }
    if (steeredTurnId && steeredTurnId !== expectedTurnId) {
      // app-server validates expectedTurnId against its live state, so an answer naming a different
      // turn means our view of the thread was stale and we cannot say which turn will show this.
      this.activeTurnId = null;
      await push.ambiguous(
        `turn/steer answered with turn ${steeredTurnId}, not ${expectedTurnId}`,
        steeredTurnId,
      );
      return;
    }
    // Steering an active turn emits no new turn/started, so the notification stream cannot confirm
    // it, and on codex-cli 0.145.0 neither can the durable read: a completed steer leaves neither a
    // clientId nor its own text behind. Probed on the 445 MB thread -- `thread/read` succeeded and
    // serialized 67,375,659 bytes without the marker. The read stays because it is the check that
    // starts working the moment Codex persists the steered input, but its failure is expected here
    // and says nothing about this Bridge's health.
    if (!(await this.pollThreadForMessage(surface.message.id))) {
      this.unreadableSurfaceMessageIds.add(surface.message.id);
      await push.ambiguous(
        `turn/steer accepted ${surface.message.id} but Codex writes back nothing readable for a steer`,
        expectedTurnId,
      );
      return;
    }
    await push.confirmed(`turn ${expectedTurnId} holds the message`, expectedTurnId);
    await this.markDelivered(surface.message, surface.permit);
  }

  private async inject(
    message: CrossAgentMessage,
    existingPermit?: MessageSurfacePermit,
    generation?: number,
    socket?: WebSocket,
  ): Promise<void> {
    if (!this.threadId) return;
    const surface = existingPermit
      ? { message, permit: existingPermit }
      : await this.acquireSurfacePermit(message, generation, socket);
    if (!surface) return;
    const prepared = await this.prepareSyntheticPrompt(
      surface.message,
      surface.permit,
      "thread/inject_items",
    );
    if (!prepared) return;
    const push = this.beginPush("inject", surface.message, surface.permit);
    try {
      await this.request("thread/inject_items", {
        threadId: this.threadId,
        items: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: prepared.text }],
          },
        ],
      });
    } catch (error: unknown) {
      if (isProvenPreSideEffectRpcRejection("thread/inject_items", error)) {
        await this.settleSurfacePermit(surface.permit, "ABORTED", describeError(error));
        throw error;
      }
      await push.ambiguous(describeError(error));
      if (isIndeterminateAppServerTransportFailure("thread/inject_items", error)) {
        await this.restartTransport(
          `ambiguous thread/inject_items transport for ${surface.message.id}`,
        );
        return;
      }
      throw error;
    }
    this.runDetached("inject RPC telemetry", push.rpcAccepted());
    // Injection answers with an empty result and starts no turn, so there is no notification to wait
    // for — an idle thread emits nothing. The durable read is the only available acknowledgement, and
    // it is the one the report asks for: a bounded thread check keyed by the correlation marker.
    if (!(await this.pollThreadForMessage(surface.message.id))) {
      await push.ambiguous(
        `thread/inject_items accepted ${surface.message.id} but the thread never held it`,
      );
      return;
    }
    await push.confirmed("the thread holds the injected message");
    await this.markDelivered(surface.message, surface.permit);
  }

  /**
   * Reads the bound thread back and reports whether it durably contains this message.
   *
   * A failed read is reported as "not held" rather than thrown: the caller's job is to decide whether
   * delivery can be claimed, and a transport that cannot answer is exactly the case where it cannot.
   */
  private async threadHoldsMessage(messageId: string): Promise<boolean> {
    if (!this.threadId) return false;
    try {
      const thread = await this.request<unknown>(
        "thread/read",
        { threadId: this.threadId, includeTurns: true },
        CONFIRMATION_READ_TIMEOUT_MS,
      );
      return holdsMessage(thread, messageId);
    } catch (error: unknown) {
      process.stderr.write(`[crossagent] thread/read failed: ${describeError(error)}\n`);
      return false;
    }
  }

  /**
   * Cold recovery can contain many predecessor ambiguities in one long-lived Codex task. Loading the
   * complete thread once is sufficient because every marker is checked independently in that exact
   * immutable snapshot; repeating the same expensive read per message can starve Hub heartbeats.
   */
  private async operationalRecoveryThreadHoldsMessage(messageId: string): Promise<boolean> {
    if (!this.threadId) return false;
    this.operationalRecoveryThreadSnapshot ??= this.request<unknown>(
      "thread/read",
      { threadId: this.threadId, includeTurns: true },
      HISTORICAL_THREAD_READ_TIMEOUT_MS,
    ).catch((error: unknown) => {
      process.stderr.write(`[crossagent] thread/read failed: ${describeError(error)}\n`);
      return null;
    });
    const thread = await this.operationalRecoveryThreadSnapshot;
    return thread !== null && holdsMessage(thread, messageId);
  }

  /** Reads only the exact returned turn so another turn cannot satisfy a wake or steer receipt. */
  private async threadTurnHoldsMessage(turnId: string, messageId: string): Promise<boolean> {
    if (!this.threadId) return false;
    try {
      const thread = await this.request<unknown>(
        "thread/read",
        { threadId: this.threadId, includeTurns: true },
        CONFIRMATION_READ_TIMEOUT_MS,
      );
      return threadTurnHoldsMessage(thread, turnId, messageId);
    } catch (error: unknown) {
      process.stderr.write(`[crossagent] thread/read failed: ${describeError(error)}\n`);
      return false;
    }
  }

  private get confirmationTimeoutMs(): number {
    return this.options.confirmationTimeoutMs ?? CONFIRMATION_TIMEOUT_MS;
  }

  /**
   * Resolves true once Codex announces a turn that carries this message, false once the confirmation
   * window closes. Falls back to a durable read before giving up, because the notification could have
   * been missed while the answer is still knowable.
   */
  private async awaitClientMessage(messageId: string, turnId: string): Promise<boolean> {
    if (this.confirmedClientIds.includes(announcement(turnId, messageId))) return true;
    const deadline = Date.now() + this.confirmationTimeoutMs;
    const interval = Math.max(5, Math.min(50, Math.floor(this.confirmationTimeoutMs / 6)));
    let notificationConfirmed = false;
    let wakeNotification: () => void = () => undefined;
    const notification = new Promise<void>((resolve) => {
      wakeNotification = resolve;
    });
    const waiter = {
      // The turn id has to match the one the RPC just returned. A turn/started for some other turn
      // that happens to carry our client id says the item exists somewhere, not that the turn we
      // were promised is running.
      matches: (message: JsonRpcMessage) =>
        message.method === "turn/started" &&
        notifiedTurnId(message) === turnId &&
        holdsMessage(message.params ?? {}, messageId),
      resolve: () => {
        notificationConfirmed = true;
        wakeNotification();
      },
    };
    this.notificationWaiters.add(waiter);
    try {
      for (;;) {
        if (
          notificationConfirmed ||
          this.confirmedClientIds.includes(announcement(turnId, messageId))
        ) {
          return true;
        }
        if (await this.threadTurnHoldsMessage(turnId, messageId)) return true;
        const remaining = deadline - Date.now();
        if (remaining <= 0) return false;
        await Promise.race([
          notification,
          new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, Math.min(interval, remaining));
            timer.unref();
          }),
        ]);
      }
    } finally {
      this.notificationWaiters.delete(waiter);
    }
  }

  /**
   * Reads the thread back until it holds the message or the confirmation window closes.
   *
   * Polled rather than read once because acceptance is durable but not instant: `turn/steer` and
   * `thread/inject_items` both answer before the item is visible in the thread, so a single read
   * races them and would call a healthy push ambiguous.
   */
  private async pollThreadForMessage(messageId: string): Promise<boolean> {
    const deadline = Date.now() + this.confirmationTimeoutMs;
    const interval = Math.max(5, Math.min(50, Math.floor(this.confirmationTimeoutMs / 6)));
    for (;;) {
      if (await this.threadHoldsMessage(messageId)) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, interval);
        timer.unref();
      });
    }
  }

  private observeNotification(message: JsonRpcMessage): void {
    this.notificationSequence += 1;
    this.notificationStreamEvidence = true;
    this.lastNotificationAt = new Date().toISOString();
    if (message.method === "turn/started") {
      const turnId = notifiedTurnId(message);
      for (const clientId of turnId ? notifiedClientIds(message) : []) {
        this.confirmedClientIds.push(announcement(turnId as string, clientId));
        if (this.confirmedClientIds.length > CONFIRMED_CLIENT_ID_HISTORY) {
          this.confirmedClientIds.shift();
        }
      }
    }
    for (const waiter of [...this.notificationWaiters]) {
      if (!waiter.matches(message)) continue;
      this.notificationWaiters.delete(waiter);
      waiter.resolve();
    }
  }

  private beginIdleAppServerCrashRecovery(): CredentialDrainBarrier | null {
    if (
      !this.stopped &&
      this.appServerRecoveryFuse.status.state === "CLOSED" &&
      this.credentialDrain.phase === "OPEN" &&
      this.credentialCutoverInFlight === null &&
      this.ticketCriticalRecoveryInFlight === null &&
      this.transportRestartInFlight === null &&
      !this.credentialDrain.hasActiveNonHeartbeatAdmission &&
      this.activeTurnId === null &&
      this.pushesInFlight.size === 0 &&
      this.deliveryWritesInFlight.size === 0 &&
      this.pendingDeliveryStates.size === 0 &&
      this.surfacePermits.size === 0 &&
      this.ambiguousMessageReasons.size === 0 &&
      this.durablePendingMessageIds.length === 0 &&
      !this.operationalHydrationRetryPending
    ) {
      // The exit handler owns this synchronously before returning to the event loop. That closes
      // model-visible admission across the can-recover/restart boundary, so a user turn cannot slip
      // onto the dead transport after the apparent idle snapshot.
      return this.credentialDrain.beginDrain("idle app-server crash recovery");
    }
    return null;
  }

  private startIdleAppServerCrashRecovery(
    detail: string,
    barrier: CredentialDrainBarrier,
    crashedGeneration: number | null,
  ): void {
    if (this.appServerCrashRecoveryInFlight) return;
    const recovery = this.appServerRecoveryFuse.beginAutomaticRecovery(
      crashedGeneration,
      this.currentAppServerRecoveryIdentity(),
    );
    if (!recovery.accepted) return;
    this.appServerCrashRecoveryOwner = { crashedGeneration };
    const operation = this.recoverIdleAppServerCrash(detail, barrier);
    const owned = operation.finally(() => {
      if (this.appServerCrashRecoveryInFlight === owned) {
        this.appServerCrashRecoveryInFlight = null;
        this.appServerCrashRecoveryOwner = null;
      }
    });
    this.appServerCrashRecoveryInFlight = owned;
    this.runDetached("idle app-server crash recovery", owned);
  }

  private async recoverIdleAppServerCrash(
    detail: string,
    barrier: CredentialDrainBarrier,
  ): Promise<void> {
    await barrier.drained;
    let lastError: Error = new Error(detail);
    for (let attempt = 1; attempt <= APP_SERVER_CRASH_RESTART_MAX_ATTEMPTS; attempt += 1) {
      if (attempt > 1) {
        await this.waitForAppServerCrashRetry(
          APP_SERVER_CRASH_RESTART_INITIAL_DELAY_MS * 2 ** (attempt - 2),
        );
      }
      if (this.stopped) return;
      if (
        this.stopped ||
        this.credentialDrain.phase !== "DRAINING" ||
        this.credentialCutoverInFlight !== null ||
        this.ticketCriticalRecoveryInFlight !== null ||
        this.transportRestartInFlight !== null ||
        this.credentialDrain.hasActiveNonHeartbeatAdmission ||
        this.activeTurnId !== null ||
        this.pushesInFlight.size > 0 ||
        this.deliveryWritesInFlight.size > 0 ||
        this.pendingDeliveryStates.size > 0 ||
        this.surfacePermits.size > 0 ||
        this.ambiguousMessageReasons.size > 0 ||
        this.durablePendingMessageIds.length > 0 ||
        this.operationalHydrationRetryPending
      ) {
        await this.terminate("Codex app-server crash recovery lost its idle safe point", lastError);
        return;
      }
      try {
        await this.restartTransport(`idle crash recovery attempt ${attempt}`, false);
        this.appServerRecoveryFuse.recordAutomaticSuccess();
        if (!this.stopped) this.credentialDrain.reopen(barrier);
        return;
      } catch (error: unknown) {
        lastError = error instanceof Error ? error : new Error(describeError(error));
        const recoveryRequired = this.appServerRecoveryFuse.recordAutomaticFailure();
        if (recoveryRequired) {
          this.modelTransportReady = false;
          this.appServerRpcAlive = false;
          if (this.sessionTicketRuntime && this.activeTickets) {
            try {
              await this.sessionTicketRuntime.markActiveModelTransportOffline(
                this.activeTickets.stored.bundleId,
                recoveryRequired.fuseGeneration,
              );
              this.activeTickets.stored.modelTransportState = "MODEL_CONFIGURED_OFFLINE";
              this.activeTickets.stored.modelTransportFuseGeneration =
                recoveryRequired.fuseGeneration;
            } catch (persistenceError: unknown) {
              this.degradedReason = `Codex app-server recovery fuse could not persist its offline state: ${describeError(persistenceError)}`;
              this.rejectModelTransportWaiters(new ModelTransportFuseOpenError());
              process.stderr.write(
                `[crossagent] app-server offline checkpoint failed: ${describeError(persistenceError)}\n`,
              );
              this.emitHealth();
              return;
            }
          }
          this.degradedReason = `Codex app-server recovery fuse open after ${APP_SERVER_CRASH_RESTART_MAX_ATTEMPTS} attempts`;
          this.rejectModelTransportWaiters(new ModelTransportFuseOpenError());
          if (!this.stopped && this.credentialDrain.phase === "DRAINING") {
            this.credentialDrain.reopen(barrier);
          }
          this.publishAppServerRecoveryRequired(recoveryRequired);
          this.emitHealth();
          return;
        }
      }
    }
    // recordAutomaticFailure opens the fuse on the final bounded attempt. Reaching this line would
    // mean the state Module and retry owner diverged, which remains fail-closed.
    await this.terminate("Codex app-server recovery state diverged", lastError);
  }

  private currentAppServerRecoveryIdentity(): AppServerRecoveryIdentity {
    if (!this.project || !this.session || !this.threadId) {
      throw new Error("Codex app-server recovery identity is unavailable before registration");
    }
    if (
      !this.session.lineageId?.startsWith("lin_") ||
      !Number.isSafeInteger(this.session.incarnation) ||
      (this.session.incarnation ?? 0) <= 0
    ) {
      throw new Error("Codex app-server recovery requires a bound Hub lineage identity");
    }
    const lineageId = this.session.lineageId;
    const incarnation = this.session.incarnation as number;
    const legacyBundleId = `stb_legacy_${createHash("sha256")
      .update(`${this.project.id}\0${this.session.id}\0${this.threadId}`, "utf8")
      .digest("hex")
      .slice(0, 24)}`;
    return {
      projectId: this.project.id,
      hubSessionId: this.session.id,
      threadId: this.threadId,
      lineageId,
      incarnation,
      launcherRunId: this.launcherRunId,
      bundleId: this.activeTickets?.stored.bundleId ?? legacyBundleId,
    };
  }

  private publishAppServerRecoveryRequired(request: AppServerRecoveryRequired): void {
    const listener = this.options.onAppServerRecoveryRequired;
    if (!listener) return;
    this.runDetached(
      "app-server recovery request",
      Promise.resolve(listener(structuredClone(request))),
    );
  }

  private waitForAppServerCrashRetry(delayMs: number): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (this.appServerCrashRecoveryTimer === timer) {
          this.appServerCrashRecoveryTimer = null;
        }
        if (this.appServerCrashRecoveryWake === finish) {
          this.appServerCrashRecoveryWake = null;
        }
        resolve();
      };
      const timer = setTimeout(finish, delayMs);
      (timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
      this.appServerCrashRecoveryTimer = timer;
      this.appServerCrashRecoveryWake = finish;
    });
  }

  /**
   * Rebuilds the app-server transport after a wake could not be confirmed — the half-alive state
   * where PID, Hub socket and JSON-RPC all answer while Codex notifications have stopped. Only the
   * transport is replaced: project, session, thread id and the Hub socket survive, so the message
   * that failed to confirm is still replayable onto the fresh one.
   */
  private restartTransport(
    reason: string,
    fatalOnFailure = true,
    publishModelReady = true,
  ): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.transportRestartInFlight) return this.transportRestartInFlight;
    const operation = this.performTransportRestart(reason, fatalOnFailure, publishModelReady);
    const owned = operation.finally(() => {
      if (this.transportRestartInFlight === owned) this.transportRestartInFlight = null;
      // Ambiguous messages deliberately survive the restart: a fresh transport is not delivery.
      // Only confirmation or the Hub's recipient state can settle each exact message.
      this.emitHealth();
    });
    this.transportRestartInFlight = owned;
    return owned;
  }

  private async performTransportRestart(
    reason: string,
    fatalOnFailure: boolean,
    publishModelReady: boolean,
  ): Promise<void> {
    process.stderr.write(`[crossagent] restarting the Codex app-server transport: ${reason}\n`);
    this.modelTransportReady = false;
    try {
      // Codex writes a thread's rollout only once the thread holds an item, and answers
      // `thread/resume` with -32600 "no rollout found" until it does. The resume below therefore
      // has to find a thread that was persisted while the retiring child still held it -- after the
      // stop, the replacement cannot reach an unpersisted thread to fix this either.
      //
      // A launch hits this every time: the initial MODEL_MCP ticket is bound to the thread id, so
      // it can only be minted after thread/start, installing it requires this restart, and the
      // thread has held nothing yet. Anchoring here rather than at creation keeps the anchor out of
      // threads that never restart.
      //
      // Best-effort, and skipped unless the retiring child is answering: most restarts exist to
      // replace an app-server that already stopped responding, and a recovery restart must not be
      // held up -- or failed -- by an anchor it cannot deliver. Failing to anchor leaves the resume
      // exactly as it behaved before, so this can only improve the outcome.
      if (this.threadId && !this.threadRolloutPersisted && this.appServerRpcAlive) {
        try {
          await this.requestAppServer("thread/inject_items", {
            threadId: this.threadId,
            // The same item shape every real delivery uses. A bare `{type:"text"}` item also
            // triggers the rollout write, but Codex stores nothing for it -- relying on an item
            // type it silently drops would put launch on undefined behaviour.
            items: [
              {
                type: "message",
                role: "user",
                content: [{ type: "input_text", text: NEW_THREAD_PERSISTENCE_ANCHOR }],
              },
            ],
          });
          this.threadRolloutPersisted = true;
        } catch (error: unknown) {
          process.stderr.write(
            `[crossagent] could not anchor the thread before restart: ${describeError(error)}\n`,
          );
        }
      }
      // Until captureAppServerGeneration installs the replacement identity, every tagged exit belongs
      // to the retiring child. This removes the ambiguous "restart boolean means any exit is fine"
      // window that used to consume a crash from the already-started replacement.
      this.activeAppServerGeneration = null;
      await this.appServer.stop();
      if (this.stopped) return;
      this.appServer.replaceEnvironment(
        sanitizeModelEnvironment(process.env, this.currentModelMcpToken ?? undefined),
      );
      await this.appServer.start();
      if (this.stopped) {
        await this.appServer.stop();
        return;
      }
      this.captureAppServerGeneration();
      this.activeTurnId = null;
      if (this.threadId) {
        const resumed = await this.requestAppServer<ThreadResult>("thread/resume", {
          threadId: this.threadId,
        });
        if (resumed.thread.id !== this.threadId) {
          throw new TypeError("Codex app-server resumed a different thread during recovery");
        }
        if (this.stopped) {
          await this.appServer.stop();
          return;
        }
      }
      if (publishModelReady) {
        this.modelTransportReady = true;
        this.releaseModelTransportWaiters();
      }
      this.degradedReason = `transport restarted after ${reason}`;
    } catch (error: unknown) {
      try {
        await this.appServer.stop();
      } catch (cleanupError: unknown) {
        process.stderr.write(
          `[crossagent] transport restart rollback failed: ${describeError(cleanupError)}\n`,
        );
      }
      this.degradedReason = `transport restart failed after ${reason}: ${describeError(error)}`;
      process.stderr.write(`[crossagent] ${this.degradedReason}\n`);
      const fatal =
        error instanceof Error
          ? error
          : new Error(`Codex app-server transport restart failed: ${describeError(error)}`);
      if (fatalOnFailure) {
        await this.terminate(`transport restart failed after ${reason}`, fatal);
        throw fatal;
      }
      throw new TypeError(`Codex credential transport restart failed: ${describeError(fatal)}`);
    }
  }

  /**
   * The single terminal lifecycle Interface between Bridge internals and their process owner.
   *
   * `stop()` owns resource cleanup and remains safe for a caller-initiated shutdown. Internal
   * terminal events come through here so the CLI also learns that its otherwise-live process and
   * run record must end. Cleanup failure upgrades a normal retirement into a fatal outcome.
   */
  private terminate(reason: string, error?: Error): Promise<void> {
    if (this.terminationPromise) return this.terminationPromise;
    const operation = (async () => {
      let effectiveError = error;
      try {
        const stopOutcome = await this.stop();
        if (stopOutcome.localCleanup?.state === "FAILED") {
          const cleanupError = new Error(stopOutcome.localCleanup.error);
          effectiveError = error
            ? new AggregateError(
                [error, cleanupError],
                `Bridge terminal cleanup failed: ${stopOutcome.localCleanup.error}`,
              )
            : cleanupError;
          const cleanupContext = reason.startsWith("Codex app-server exited unexpectedly")
            ? "shutdown after app-server exit"
            : `terminal cleanup after ${reason}`;
          process.stderr.write(
            `[crossagent] ${cleanupContext} failed: ${stopOutcome.localCleanup.error}\n`,
          );
        }
      } catch (cleanupError: unknown) {
        effectiveError =
          cleanupError instanceof Error
            ? cleanupError
            : new Error(`Bridge terminal cleanup failed: ${describeError(cleanupError)}`);
        const cleanupContext = reason.startsWith("Codex app-server exited unexpectedly")
          ? "shutdown after app-server exit"
          : `terminal cleanup after ${reason}`;
        process.stderr.write(
          `[crossagent] ${cleanupContext} failed: ${describeError(cleanupError)}\n`,
        );
      }
      const termination: CodexBridgeTermination = effectiveError
        ? { reason, fatal: true, error: effectiveError }
        : { reason, fatal: false };
      try {
        await this.options.onTerminated?.(termination);
      } catch (callbackError: unknown) {
        process.stderr.write(
          `[crossagent] terminal Bridge callback failed: ${describeError(callbackError)}\n`,
        );
      }
      if (termination.fatal) {
        try {
          await this.options.onFatalError?.(termination.error);
        } catch (callbackError: unknown) {
          process.stderr.write(
            `[crossagent] fatal transport callback failed: ${describeError(callbackError)}\n`,
          );
        }
      }
    })();
    this.terminationPromise = operation;
    return operation;
  }

  /**
   * Push telemetry. The incident was slow to diagnose because "the Bridge accepted it" and "Codex
   * actually received it" were indistinguishable on the event stream; these keep them apart.
   */
  private beginPush(action: PushAction, message: CrossAgentMessage, permit: MessageSurfacePermit) {
    this.pushSequence += 1;
    const sequence = this.pushSequence;
    const notificationSequenceAtStart = this.notificationSequence;
    const startedAt = Date.now();
    const elapsed = () => `${Date.now() - startedAt}ms`;
    const record = (method: string, status: string, externalTurnId?: string, error?: string) =>
      this.recordPushEvent({ method, status, action, message, sequence, externalTurnId, error });
    this.runDetached("push attempt telemetry", record("push.attempted", "attempted"));
    return {
      rpcAccepted: (externalTurnId?: string) =>
        record("push.rpc_accepted", `accepted after ${elapsed()}`, externalTurnId),
      confirmed: async (detail: string, externalTurnId?: string) => {
        this.confirmedMessageIds.add(message.id);
        this.clearAmbiguousMessage(message.id);
        this.degradedReason = null;
        this.lastConfirmedPushAt = new Date().toISOString();
        await record("push.confirmed", `${detail} after ${elapsed()}`, externalTurnId);
        this.emitHealth();
      },
      ambiguous: async (reason: string, externalTurnId?: string) => {
        this.ambiguousMessageReasons.set(message.id, reason);
        this.ambiguousSurfaceProofs.set(message.id, { action, externalTurnId });
        this.lastUnconfirmedPushAt = new Date().toISOString();
        await this.settleSurfacePermit(permit, "AMBIGUOUS", reason);
        // Only wake confirmation depends on notifications. A failed durable steer/inject says the
        // transport lost work, not that the notification stream died. An integer sequence avoids
        // same-millisecond timestamp races when a retry immediately produces turn/started.
        if (action === "wake") {
          this.notificationStreamEvidence = this.notificationSequence > notificationSequenceAtStart;
        }
        await record(
          "push.failed_or_ambiguous",
          `unconfirmed after ${elapsed()}`,
          externalTurnId,
          reason,
        );
        this.emitHealth();
      },
    };
  }

  private async recordPushEvent(input: {
    method: string;
    status: string;
    action: PushAction;
    message: CrossAgentMessage;
    sequence: number;
    externalTurnId?: string;
    error?: string;
  }): Promise<void> {
    if (!this.session) return;
    try {
      await this.hubRequest("push telemetry", () =>
        this.hub.recordAdapterEvent(this.session!.id, {
          method: input.method,
          itemType: input.action,
          itemId: input.message.id,
          externalTurnId: input.externalTurnId ?? null,
          status: clipText(input.status, 100),
          error: input.error === undefined ? undefined : clipText(input.error, 4000),
          // The push sequence keeps two pushes of the same message apart while still letting one
          // push's own HTTP retry deduplicate.
          idempotencyKey: adapterEventKey(
            this.session!.id,
            input.method,
            `${input.message.id}:${input.sequence}`,
          ),
        }),
      );
    } catch (error: unknown) {
      process.stderr.write(
        `[crossagent] push event dropped (${input.method}): ${describeError(error)}\n`,
      );
    }
  }

  /**
   * One word for the whole chain, derived from the links rather than only from the last push. A
   * Bridge whose socket never opened has nothing wrong with its pushes yet and is still not working,
   * and reporting that as healthy is the same category of lie this change exists to remove.
   */
  /** The first unconfirmed message whose ambiguity is not simply what this Codex version allows. */
  private faultAmbiguity(): [string, string] | null {
    for (const entry of this.ambiguousMessageReasons) {
      if (!this.unreadableSurfaceMessageIds.has(entry[0])) return entry;
    }
    return null;
  }

  private healthStatus(): CodexBridgeHealth["status"] {
    if (this.stopped) return "stopped";
    if (this.appServerRecoveryFuse.status.state !== "CLOSED") return "degraded";
    if (this.hubSocketUnavailableReason || this.hubHttpUnavailableReason || this.degradedReason) {
      return "degraded";
    }
    // An ambiguity Codex's own surface guarantees is not a fault here; anything else is.
    if (this.faultAmbiguity() !== null) return "degraded";
    if (this.pendingDeliveryStates.size > 0) return "degraded";
    // A rollout that is merely growing is not a fault, so only the retirement verdict counts here.
    if (this.rolloutHealth.snapshot().state === "RETIRE") return "degraded";
    if (!this.hubSocketAlive() || !this.appServerRpcAlive) return "degraded";
    return this.notificationStreamAlive() === false ? "degraded" : "healthy";
  }

  /**
   * Whether the Hub socket is not known to be going away. Held-but-closing is the state that makes
   * `hubSocketOpen` alone misleading, so it is reported separately rather than folded into it.
   */
  private hubSocketAlive(): boolean {
    // OPEN and nothing else. A socket still CONNECTING, or already CLOSING, is held but cannot carry
    // an event — which is the whole distinction that makes `hubSocketOpen` alone misleading. The
    // numeric literal rather than WebSocket.OPEN because the constant is not on every transport.
    return this.socket?.readyState === 1 && this.socketSubscribed;
  }

  /**
   * Reports evidence, not optimism. A Bridge that has heard nothing and failed nothing knows nothing
   * yet, so it says so; one that failed a push and has heard nothing since is the half-alive case.
   */
  private notificationStreamAlive(): boolean | null {
    return this.notificationStreamEvidence;
  }

  private captureAppServerGeneration(): void {
    const generation = (this.appServer as CodexAppServer & { activeGeneration?: number | null })
      .activeGeneration;
    this.activeAppServerGeneration = typeof generation === "number" ? generation : null;
    this.notificationStreamEvidence = null;
    this.lastNotificationAt = null;
    this.confirmedClientIds.splice(0);
  }

  /**
   * Records app-server liveness around every call, so health can tell an RPC outage apart from a
   * merely quiet Codex.
   */
  private async request<T>(
    method: string,
    params: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<T> {
    this.assertModelTransportAdmission();
    const credentialCutover = this.credentialCutoverInFlight;
    if (credentialCutover && !this.modelTransportReady) await credentialCutover;
    const restart = this.transportRestartInFlight;
    if (restart) await restart;
    this.assertModelTransportAdmission();
    if (this.credentialPlaneCritical && !this.credentialRecoveryDataPlaneReady) {
      throw new Error("Codex Bridge credential plane is fail-closed pending same-thread recovery");
    }
    this.ensureRunning(`app-server request ${method}`);
    return this.requestAppServer(method, params, timeoutMs);
  }

  private assertModelTransportAdmission(): void {
    if (this.appServerRecoveryFuse.blocksModelAdmission) {
      throw new ModelTransportFuseOpenError();
    }
  }

  private async requestAppServer<T>(
    method: string,
    params: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<T> {
    const startedAt = Date.now();
    try {
      const result = await this.appServer.request<T>(method, params, timeoutMs);
      this.appServerRpcAlive = true;
      this.lastAppServerRpcAt = new Date().toISOString();
      if (method === "thread/read") {
        this.observeRolloutRead(Date.now() - startedAt, false);
      }
      return result;
    } catch (error: unknown) {
      // An explicit wire code means the app-server answered and disagreed, which is aliveness.
      this.appServerRpcAlive = isRpcErrorResponse(error);
      if (method === "thread/read") {
        this.observeRolloutRead(Date.now() - startedAt, isAppServerRequestTimeout(method, error));
      }
      throw error;
    }
  }

  /**
   * The single place a `thread/read` is timed, because it is the one call whose cost scales with a
   * rollout that never shrinks. Sampling the file here rather than on a timer keeps the observation
   * attached to the operation it explains, and costs one stat per confirmation read.
   */
  private observeRolloutRead(durationMs: number, timedOut: boolean): void {
    const previous = this.rolloutHealth.snapshot().state;
    this.rolloutHealth.observeRead({ durationMs, timedOut });
    if (this.threadId) this.rolloutHealth.observeSize(this.rolloutSize.sizeBytes(this.threadId));
    this.settleRolloutHealth(previous);
  }

  private observeRolloutSize(): void {
    if (!this.threadId) return;
    const previous = this.rolloutHealth.snapshot().state;
    this.rolloutHealth.observeSize(this.rolloutSize.sizeBytes(this.threadId));
    this.settleRolloutHealth(previous);
  }

  private settleRolloutHealth(previous: RolloutHealthSnapshot["state"]): void {
    const current = this.rolloutHealth.snapshot();
    if (current.state === previous) return;
    if (current.state === "RETIRE") this.publishThreadRetirementRequired(current);
    this.emitHealth();
  }

  /**
   * Asks the supervisor for a successor thread. It is a request, not an action: swapping the thread
   * under a live session would have to rebind the ticket lineage, which the ticket runtime refuses
   * by design. The Bridge keeps delivering into the old thread meanwhile — degraded and honest is
   * better than silently moving delivery to a thread nobody is reading.
   */
  private publishThreadRetirementRequired(snapshot: RolloutHealthSnapshot): void {
    if (!this.threadId || this.threadRetirementPublished) return;
    this.threadRetirementPublished = true;
    process.stderr.write(
      `[crossagent] this Codex thread should be retired: ${snapshot.reason ?? "rollout degraded"}\n`,
    );
    const listener = this.options.onThreadRetirementRequired;
    if (!listener) return;
    const request: ThreadRetirementRequired = {
      schemaVersion: 1,
      kind: "CODEX_THREAD_RETIREMENT_REQUIRED",
      issuedAt: new Date().toISOString(),
      projectId: this.project?.id ?? null,
      threadId: this.threadId,
      reason: snapshot.reason ?? "rollout degraded",
      rolloutBytes: snapshot.rolloutBytes,
      slowestReadMs: snapshot.slowestReadMs,
    };
    this.runDetached("thread retirement request", Promise.resolve(listener(request)));
  }

  /**
   * The single Hub HTTP availability Seam.
   *
   * Callers still decide whether an operation is retryable or message-terminal; this method only
   * records the transport fact consistently. An HTTP error proves the Hub answered and is therefore
   * not classified as an outage, while an Undici/socket rejection is.
   */
  private async hubRequest<T>(label: string, request: () => Promise<T>): Promise<T> {
    try {
      const result = await request();
      this.markHubHttpAvailable();
      return result;
    } catch (error: unknown) {
      if (isHubNetworkError(error)) {
        this.setHubHttpUnavailable(`Hub unavailable during ${label}: ${describeError(error)}`);
      } else {
        // A protocol/HTTP error still proves that the Hub transport answered.
        this.markHubHttpAvailable();
      }
      throw error;
    }
  }

  private ensureRunning(stage: string): void {
    if (this.stopped) throw new Error(`Codex Bridge stopped during ${stage}`);
  }

  /**
   * Retries only the identity-establishing startup window and gives it a finite owner.
   *
   * The CLI cannot install its managed stop watcher until start() returns, so this must never be an
   * unbounded loop. Once the Bridge is registered, the normal heartbeat/socket owners keep it alive
   * and independently degraded instead.
   */
  private async retryHubInitialization<T>(label: string, operation: () => Promise<T>): Promise<T> {
    const configuredAttempts = Math.floor(this.options.hubInitializationMaxAttempts ?? 8);
    const maxAttempts = Number.isFinite(configuredAttempts) ? Math.max(1, configuredAttempts) : 8;
    let attempts = 0;
    while (!this.stopped) {
      attempts += 1;
      try {
        const result = await operation();
        this.initializationBackoff.reset();
        return result;
      } catch (error: unknown) {
        if (!isHubNetworkError(error) || attempts >= maxAttempts) throw error;
        const delayMs = this.initializationBackoff.nextDelayMs();
        this.setHubHttpUnavailable(
          `Hub unavailable during ${label}: ${describeError(error)}; retrying in ${delayMs}ms`,
        );
        await this.waitForInitializationRetry(delayMs);
      }
    }
    throw new Error(`Codex Bridge stopped while retrying Hub ${label}`);
  }

  private waitForInitializationRetry(delayMs: number): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return new Promise((resolve) => {
      this.initializationRetryWake = resolve;
      this.initializationRetryTimer = setTimeout(() => {
        this.initializationRetryTimer = null;
        this.initializationRetryWake = null;
        resolve();
      }, delayMs);
    });
  }

  /**
   * Owns every promise intentionally detached from an event, timer, or telemetry callback.
   *
   * The error handler is awaited inside its own guarded terminal so an async cleanup failure cannot
   * manufacture the next unhandled rejection while trying to report the first one.
   */
  private runDetached(
    label: string,
    operation: Promise<unknown>,
    onError?: (error: unknown) => void | Promise<void>,
  ): void {
    void operation.catch(async (error: unknown) => {
      try {
        if (onError) await onError(error);
        else this.handleDetachedHubFailure(label, error);
      } catch (handlerError: unknown) {
        process.stderr.write(
          `[crossagent] ${label} error handler failed: ${describeError(handlerError)}\n`,
        );
      }
    });
  }

  private handleDetachedHubFailure(label: string, error: unknown): void {
    if (isHubNetworkError(error)) {
      this.setHubHttpUnavailable(`Hub unavailable during ${label}: ${describeError(error)}`);
    }
    process.stderr.write(`[crossagent] ${label} failed: ${describeError(error)}\n`);
  }

  private setHubHttpUnavailable(reason: string): void {
    if (this.stopped) return;
    this.hubHttpUnavailableReason = reason;
    // Publish even when the wording is unchanged. The managed status file has its own freshness
    // deadline, so suppressing a repeated outage would make a live degraded Bridge look dead.
    this.emitHealth();
  }

  private markHubHttpAvailable(): void {
    if (!this.hubHttpUnavailableReason) return;
    this.hubHttpUnavailableReason = null;
    this.emitHealth();
  }

  private setHubSocketUnavailable(reason: string): void {
    if (this.stopped) return;
    this.hubSocketUnavailableReason = reason;
    this.emitHealth();
  }

  private markHubSocketAvailable(): void {
    this.socketReconnectBackoff.reset();
    if (!this.hubSocketUnavailableReason) return;
    this.hubSocketUnavailableReason = null;
    this.emitHealth();
  }

  private emitHealth(): void {
    const listener = this.options.onHealthChange;
    if (!listener) return;
    const pendingAmbiguity = this.ambiguousMessageReasons.entries().next().value as
      [string, string] | undefined;
    // `pendingMessageId` reports every unconfirmed message, because all of them are still awaiting
    // confirmation. `degradedReason` reports only the ones that mean something is wrong, so the two
    // can legitimately disagree: one message pending against a Codex that cannot confirm it is a
    // healthy Bridge with work outstanding.
    const fault = this.faultAmbiguity();
    const rollout = this.rolloutHealth.snapshot();
    const faultCount = this.ambiguousMessageReasons.size - this.unreadableSurfaceMessageIds.size;
    const ambiguousReason = fault
      ? faultCount === 1
        ? fault[1]
        : `${fault[1]} (${faultCount} messages pending confirmation)`
      : null;
    const snapshot: CodexBridgeHealth = {
      status: this.healthStatus(),
      pid: process.pid,
      projectId: this.project?.id ?? null,
      sessionId: this.session?.id ?? null,
      threadId: this.threadId,
      hookCaptureBindingMode: this.hookCaptureBindingMode,
      hubSocketOpen: Boolean(this.socket),
      hubSocketAlive: this.hubSocketAlive(),
      lastHubEventAt: this.lastHubEventAt,
      appServerRpcAlive: this.appServerRpcAlive,
      lastAppServerRpcAt: this.lastAppServerRpcAt,
      notificationStreamAlive: this.notificationStreamAlive(),
      lastNotificationAt: this.lastNotificationAt,
      lastConfirmedPushAt: this.lastConfirmedPushAt,
      lastUnconfirmedPushAt: this.lastUnconfirmedPushAt,
      pendingMessageId: pendingAmbiguity?.[0] ?? null,
      modelTransportState: this.appServerRecoveryFuse.status.modelTransportState,
      appServerRecoveryFuseGeneration: this.appServerRecoveryFuse.status.fuseGeneration,
      rollout,
      degradedReason:
        this.hubSocketUnavailableReason ??
        this.hubHttpUnavailableReason ??
        ambiguousReason ??
        (this.appServerRecoveryFuse.status.state !== "CLOSED"
          ? `Codex model transport recovery is ${this.appServerRecoveryFuse.status.state}`
          : null) ??
        this.degradedReason ??
        (this.pendingDeliveryStates.size > 0
          ? `${this.pendingDeliveryStates.size} confirmed delivery state write(s) pending`
          : null) ??
        // Last, because it is the slowest-moving of these and should not mask a live fault.
        (rollout.state === "RETIRE" ? rollout.reason : null),
      updatedAt: new Date().toISOString(),
    };
    try {
      listener(snapshot);
    } catch (error: unknown) {
      // Health is diagnostics. A publisher that throws must not stop messages being delivered.
      process.stderr.write(`[crossagent] health listener failed: ${describeError(error)}\n`);
    }
  }

  private scheduleImportantFlush(delayMs = 750): void {
    if (this.coalesceTimer) return;
    this.coalesceTimer = setTimeout(() => {
      this.coalesceTimer = null;
      // Nothing awaits a coalesced flush, so this is the end of its promise chain and the only
      // place its failure can be consumed. Rebuilding the transport rejects whatever RPC this push
      // still has in flight — an ordinary part of recovery — and without a handler here that
      // rejection reached Node as an unhandled one and took the whole managed Bridge down with it.
      // The message itself is already recorded unconfirmed by the push, so it stays replayable.
      this.runDetached("queued push", this.flushImportant());
    }, delayMs);
    this.coalesceTimer.unref();
  }

  private flushImportant(): Promise<void> {
    if (this.importantFlushInFlight) return this.importantFlushInFlight;
    const operation = this.drainQueue(this.importantQueue, (message) =>
      this.activeTurnId ? this.steer(message) : this.inject(message),
    );
    const owned = operation.finally(() => {
      if (this.importantFlushInFlight === owned) this.importantFlushInFlight = null;
    });
    this.importantFlushInFlight = owned;
    return owned;
  }

  private flushNormal(): Promise<void> {
    if (this.normalFlushInFlight) return this.normalFlushInFlight;
    const operation = this.drainQueue(this.normalQueue, (message) => this.inject(message));
    const owned = operation.finally(() => {
      if (this.normalFlushInFlight === owned) this.normalFlushInFlight = null;
    });
    this.normalFlushInFlight = owned;
    return owned;
  }

  private async drainQueue(
    queue: CrossAgentMessage[],
    push: (message: CrossAgentMessage) => Promise<void>,
  ): Promise<void> {
    while (!this.stopped && queue.length > 0) {
      const message = queue[0]!;
      if (this.deliveredMessageIds.has(message.id)) {
        this.pausedAmbiguousMessages.delete(message.id);
        queue.shift();
        continue;
      }
      if (this.pausedAmbiguousMessages.has(message.id)) return;
      const admission = await this.credentialDrain.admit("QUEUE_DRAIN");
      try {
        // Ownership can change while a message waits for a safe checkpoint. The claim call is also
        // an open-session and latest-recipient-state fence, and must happen immediately before Codex
        // sees anything rather than only when the stale local queue entry was created.
        const owned = await this.claimForSurface(message);
        if (!owned) {
          this.clearAmbiguousMessage(message.id);
          queue.shift();
          continue;
        }
        try {
          await this.pushOnce(owned, () => push(owned), admission);
        } catch (error: unknown) {
          // Codex already confirmed the surface. Only the idempotent Hub state write failed, so keep
          // this item as the queue's commit barrier until the heartbeat-owned state retry succeeds.
          // Later messages must not make the durable receipt stream disagree with surface order.
          if (this.pendingDeliveryStates.has(message.id)) {
            this.pausedAmbiguousMessages.delete(message.id);
            return;
          } else if (!this.stopped && this.ambiguousMessageReasons.has(message.id)) {
            // The server-side permit remains AMBIGUOUS and the health surface keeps it visible. It is
            // intentionally absent from the runnable queue: a later item must not be starved by work
            // this incarnation is forbidden to retry.
            this.pausedAmbiguousMessages.delete(message.id);
            queue.shift();
          } else {
            this.pausedAmbiguousMessages.add(message.id);
            throw error;
          }
          continue;
        }
        if (
          this.deliveredMessageIds.has(message.id) ||
          this.pendingDeliveryStates.has(message.id)
        ) {
          this.pausedAmbiguousMessages.delete(message.id);
          queue.shift();
          continue;
        }
        if (this.ambiguousMessageReasons.has(message.id)) {
          // Quarantine only this unresolved recipient. The durable permit and ambiguity map preserve
          // proof and fail-closed replay while unrelated queue items retain forward progress.
          this.pausedAmbiguousMessages.delete(message.id);
          queue.shift();
          continue;
        }
        this.pausedAmbiguousMessages.add(message.id);
        return;
      } finally {
        admission.release();
      }
    }
  }

  private releasePausedHead(queue: CrossAgentMessage[]): void {
    const head = queue[0];
    if (head) this.pausedAmbiguousMessages.delete(head.id);
  }

  private hasRunnableHead(queue: CrossAgentMessage[]): boolean {
    const head = queue[0];
    return Boolean(head && !this.pausedAmbiguousMessages.has(head.id));
  }

  private async markDelivered(
    message: CrossAgentMessage,
    permit = this.surfacePermits.get(message.id),
  ): Promise<void> {
    if (!this.session) return;
    if (this.deliveredMessageIds.has(message.id)) return;
    if (!permit) {
      throw new Error(`Cannot mark ${message.id} delivered without its surface permit`);
    }
    const inFlight = this.deliveryWritesInFlight.get(message.id);
    if (inFlight) return inFlight;
    this.pendingDeliveryStates.set(message.id, message);
    this.emitHealth();
    const sessionId = this.session.id;
    const write = (async () => {
      try {
        await this.hubRequest("delivery state write", () =>
          this.hub.setMessageState(message.id, "delivered", {
            sessionId,
            transport: "app_server_push",
            surfaceAttemptId: permit.id,
            recipientFence: permit.recipientFence,
            idempotencyKey: `codex-delivered:${sessionId}:${message.id}`,
          }),
        );
        if (this.sessionTicketRuntime && this.activeTickets) {
          await this.sessionTicketRuntime.settlePendingMessage(this.activeTickets, message.id);
        }
        this.pendingDeliveryStates.delete(message.id);
        this.surfacePermits.delete(message.id);
        this.deliveredMessageIds.add(message.id);
        this.emitHealth();
      } catch (error: unknown) {
        this.emitHealth();
        throw error;
      }
    })();
    this.deliveryWritesInFlight.set(message.id, write);
    try {
      await write;
    } finally {
      if (this.deliveryWritesInFlight.get(message.id) === write) {
        this.deliveryWritesInFlight.delete(message.id);
      }
    }
  }

  private isRetryableDeliveryError(error: unknown): boolean {
    return (
      isHubNetworkError(error) ||
      (error instanceof HubHttpError &&
        (error.status === 408 || error.status === 429 || error.status >= 500))
    );
  }

  private async flushPendingDeliveryStates(): Promise<void> {
    let firstError: unknown;
    for (const message of [...this.pendingDeliveryStates.values()]) {
      try {
        await this.markDelivered(message);
      } catch (error: unknown) {
        firstError ??= error;
      }
    }
    if (firstError !== undefined) throw firstError;
  }

  private async onCodexNotification(message: JsonRpcMessage): Promise<void> {
    if (!message.method || !this.session) return;
    const params = message.params ?? {};
    const turnId = notifiedTurnId(message) ?? this.activeTurnId ?? undefined;
    if (message.method === "turn/started") this.activeTurnId = turnId ?? null;
    if (message.method === "turn/completed") {
      this.activeTurnId = null;
      this.releaseCredentialSafePointWaiters();
      this.releasePausedHead(this.normalQueue);
      this.releasePausedHead(this.importantQueue);
      await this.flushImportant();
      await this.flushNormal();
    }
    if (message.method === "item/completed" && this.importantQueue.length > 0) {
      this.releasePausedHead(this.importantQueue);
      await this.flushImportant();
    }
    // Streaming deltas arrive hundreds of times per command; they carry no lifecycle information
    // the Hub stores, and one HTTP write each exhausts the local connection pool.
    if (/delta$/i.test(message.method)) return;
    const metadata = itemMetadata(params);
    const eventIdentity = metadata.itemId ?? turnId ?? createId("evt");
    const workState =
      message.method === "turn/started"
        ? "WORKING"
        : message.method === "turn/completed"
          ? "IDLE"
          : undefined;
    await this.hubRequest("adapter event write", () =>
      this.hub.recordAdapterEvent(this.session!.id, {
        method: clipText(message.method!, 160),
        externalTurnId: turnId,
        workState,
        ...metadata,
        idempotencyKey: adapterEventKey(this.session!.id, message.method!, eventIdentity),
      }),
    );
    await this.sendHeartbeat();
  }

  private sendHeartbeat(): Promise<void> {
    if (this.heartbeatAdmissionInFlight) return this.heartbeatAdmissionInFlight;
    const operation = this.withCredentialAdmission("HEARTBEAT", () => this.sendHeartbeatAdmitted());
    const owned = operation.finally(() => {
      if (this.heartbeatAdmissionInFlight === owned) this.heartbeatAdmissionInFlight = null;
    });
    this.heartbeatAdmissionInFlight = owned;
    return owned;
  }

  private sendHeartbeatAdmitted(controlOnly = false): Promise<void> {
    if (!this.session || this.stopped) return Promise.resolve();
    const session = this.session;
    const active = this.activeTickets;
    const bundleId = active?.stored.bundleId ?? null;
    if (
      this.heartbeatInFlight?.sessionId === session.id &&
      this.heartbeatInFlight.bundleId === bundleId
    ) {
      return this.heartbeatInFlight.promise;
    }
    const hub = this.hub;
    const heartbeat = this.performHeartbeat(session, active, hub, controlOnly).finally(() => {
      if (this.heartbeatInFlight?.promise === heartbeat) this.heartbeatInFlight = null;
    });
    this.heartbeatInFlight = { sessionId: session.id, bundleId, promise: heartbeat };
    return heartbeat;
  }

  private async performHeartbeat(
    ownedSession: AgentSession,
    ownedTickets: ActiveCodexSessionTicketBundle | null,
    ownedHub: HubClient,
    controlOnly = false,
  ): Promise<void> {
    if (this.stopped) return;
    const sessionId = ownedSession.id;
    const sequence =
      this.sessionTicketRuntime && ownedTickets
        ? await this.sessionTicketRuntime.reserveHeartbeatSequence(ownedTickets)
        : this.heartbeatSequence + 1;
    const updatedSession = await this.hubRequest("session heartbeat", () =>
      ownedHub.heartbeat(sessionId, {
        sequence,
        sentAt: new Date().toISOString(),
        workState: this.activeTurnId ? "WORKING" : "IDLE",
        currentTurnId: this.activeTurnId,
        activeFiles: [],
        queueDepth:
          this.importantQueue.length + this.normalQueue.length + this.pendingDeliveryStates.size,
      }),
    );
    if (
      this.stopped ||
      this.session?.id !== sessionId ||
      (ownedTickets && this.activeTickets?.stored.bundleId !== ownedTickets.stored.bundleId)
    ) {
      return;
    }
    this.heartbeatSequence = sequence;
    this.session = updatedSession;
    // Sampled here as well as around a read, because the user's own conversation grows the rollout
    // whether or not this Bridge delivers anything. Without it, an idle Bridge would only find out
    // how large the thread had become when a confirmation read finally failed.
    this.observeRolloutSize();
    // A successor CONTROL ticket must prove liveness before its local cutover commits, but it must
    // not settle predecessor delivery state, reconcile messages, or schedule any model-visible work.
    // MODEL_READY hydration owns those transitions using successor-bound Hub provenance.
    if (controlOnly) {
      this.emitHealth();
      return;
    }
    if (this.operationalHydrationRetryPending) {
      await this.hydrateOperationalPendingMessages();
    }
    await this.flushPendingDeliveryStates();
    await this.reconcilePendingMessages();
    this.scheduleDeferredCredentialFlush();
    if (this.hasRunnableHead(this.importantQueue)) this.scheduleImportantFlush(0);
    if (
      !this.activeTurnId &&
      !this.importantFlushInFlight &&
      this.hasRunnableHead(this.normalQueue)
    ) {
      this.runDetached("normal queue recovery", this.flushNormal());
    }
    // Republished on every heartbeat so the snapshot has a heartbeat of its own: that is what lets a
    // reader tell a Bridge that is idle from one that has stopped reporting altogether.
    this.emitHealth();
  }

  /**
   * Drops a degraded state that the Hub's own record has since disproved.
   *
   * A push is reported ambiguous when Codex does not surface the message inside the confirmation
   * window, and staying degraded is right while that is still true. But a slow injection can land
   * afterwards, and once the recipient has moved past DELIVERED, Codex demonstrably did surface it.
   * Holding an ambiguity past that point reports a failure the Hub has already disproved. Each
   * message is reconciled independently: a later success must not erase an older unresolved push.
   * Guarded on the map being non-empty, so a healthy Bridge makes no extra request.
   */
  private async reconcilePendingMessages(): Promise<void> {
    if (this.ambiguousMessageReasons.size === 0 || !this.session) return;
    let changed = false;
    for (const pendingId of [...this.ambiguousMessageReasons.keys()]) {
      const message = await this.hubRequest("pending message reconciliation", () =>
        this.hub.getMessage(pendingId),
      ).catch(() => null);
      if (!message) continue;
      const recipient = this.recipientFor(message);
      if (!recipient) continue;
      const proof = this.ambiguousSurfaceProofs.get(pendingId);
      const permit = this.surfacePermits.get(pendingId);
      const durableSurfaceConfirmed =
        proof && permit?.sessionId === this.session.id
          ? proof.action === "inject"
            ? await this.threadHoldsMessage(pendingId)
            : proof.externalTurnId
              ? await this.threadTurnHoldsMessage(proof.externalTurnId, pendingId)
              : false
          : false;
      if (durableSurfaceConfirmed && permit) {
        await this.markDelivered(message, permit);
        this.confirmedMessageIds.add(pendingId);
        this.lastConfirmedPushAt = new Date().toISOString();
        this.degradedReason = null;
        this.clearAmbiguousMessage(pendingId);
        changed = true;
        continue;
      }
      if (SURFACED_RECIPIENT_STATES.includes(recipient.state)) {
        this.confirmedMessageIds.add(pendingId);
        this.deliveredMessageIds.add(pendingId);
        this.pendingDeliveryStates.delete(pendingId);
        this.lastConfirmedPushAt = new Date().toISOString();
        this.degradedReason = null;
      } else if (!TERMINAL_RECIPIENT_STATES.includes(recipient.state)) {
        continue;
      }
      if (this.sessionTicketRuntime && this.activeTickets) {
        await this.sessionTicketRuntime.settlePendingMessage(this.activeTickets, pendingId);
      }
      this.clearAmbiguousMessage(pendingId);
      changed = true;
    }
    if (changed) this.emitHealth();
  }
}
