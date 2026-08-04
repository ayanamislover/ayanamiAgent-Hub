import {
  AbortedSyntheticPromptSchema,
  AdapterAuthorityDeliveryCandidateSchema,
  AuthorityDirectiveBundleSchema,
  AuthorityDirectiveSchema,
  AuthoritySigningKeySchema,
  CloseAdapterSessionInputSchema,
  CloseAdapterSessionResultSchema,
  DelegationGrantSchema,
  PreparedSyntheticPromptSchema,
  ProjectSocketAuthenticatedFrameSchema,
  ProjectSocketAuthenticateFrameSchema,
  RegisterAdapterSessionInputSchema,
  RegisterAdapterSessionResultSchema,
  RotateAdapterSessionTicketsInputSchema,
  RotateAdapterSessionTicketsResultSchema,
  RecoveredAuthorityDeliverySchema,
  SessionTicketOfferInputSchema,
  SessionTicketOfferSchema,
  type AgentSession,
  type AdapterAuthorityDeliveryCandidate,
  type AuthorityDirective,
  type AuthorityDirectiveBundle,
  type AuthoritySigningKey,
  type CloseAdapterSessionInput,
  type CloseAdapterSessionResult,
  type CrossAgentMessage,
  type CreateDelegationGrantInput,
  type DelegateInstructionInput,
  type DelegationGrant,
  type DomainEvent,
  type DirectiveExecutionResultInput,
  type DirectiveLifecycleMutationInput,
  type MessageSurfacePermit,
  type PrepareSyntheticPromptInput,
  type ModifyDelegationGrantInput,
  type RelayUserDirectiveInput,
  type SupersedeUserDirectiveInput,
  type AbortSyntheticPromptInput,
  type AbortedSyntheticPrompt,
  type PreparedSyntheticPrompt,
  type RegisterAdapterSessionInput,
  type RegisterAdapterSessionResult,
  type RotateAdapterSessionTicketsInput,
  type RotateAdapterSessionTicketsResult,
  type RecoveredAuthorityDelivery,
  type Project,
  type SessionLaunchReservation,
  type SessionLineageHead,
  type SessionTicketOffer,
  type SessionTicketOfferInput,
  type Task,
  type TerminateDelegationGrantInput,
} from "@crossagent/protocol";

export type HubClientOptions = {
  baseUrl?: string;
  token?: string;
  fetch?: typeof globalThis.fetch;
  requestTimeoutMs?: number;
};

export type RegisteredProject = Project & {
  paths: string[];
};

export type ProjectRegistration = {
  project: Project;
  root: string;
  paths: string[];
};

export type MessageSurfaceResult = {
  message: CrossAgentMessage;
  permit: MessageSurfacePermit;
};

export type AuthorityDeliveryRequest = {
  session_id: string;
  surface_attempt_id: string;
  recipient_fence: number;
};

export type RecoverAuthorityDeliveryRequest = {
  session_id: string;
};

export type AdapterSessionRegistrationRequest = Omit<RegisterAdapterSessionInput, "projectId">;

const AuthoritySigningKeyListSchema = AuthoritySigningKeySchema.array().max(100);

export class HubHttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly current?: unknown;
  readonly issues?: unknown[];

  constructor(status: number, body: Record<string, unknown>) {
    const issues = Array.isArray(body.issues) ? body.issues : undefined;
    super(
      `${String(body.message ?? `Hub request failed with HTTP ${status}`)}${
        issues ? `: ${issues.map(describeIssue).join("; ")}` : ""
      }`,
    );
    this.name = "HubHttpError";
    this.status = status;
    this.code = String(body.code ?? "HTTP_ERROR");
    this.current = body.current;
    this.issues = issues;
  }
}

/** Zod issues carry the failing field and reason; without them a 422 is undebuggable. */
function describeIssue(issue: unknown): string {
  if (!issue || typeof issue !== "object") return String(issue);
  const record = issue as Record<string, unknown>;
  const path = Array.isArray(record.path) ? record.path.join(".") : "";
  return `${path || "(root)"} ${String(record.message ?? record.code ?? "invalid")}`;
}

function queryString(values: Record<string, string | number | boolean | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) query.set(key, String(value));
  }
  const suffix = query.toString();
  return suffix ? `?${suffix}` : "";
}

export class HubClient {
  readonly baseUrl: string;
  readonly token?: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly requestTimeoutMs?: number;

  constructor(options: HubClientOptions) {
    if (
      options.requestTimeoutMs !== undefined &&
      (!Number.isFinite(options.requestTimeoutMs) || options.requestTimeoutMs <= 0)
    ) {
      throw new RangeError("requestTimeoutMs must be a finite positive number");
    }
    this.baseUrl = (options.baseUrl ?? "http://127.0.0.1:4387").replace(/\/$/, "");
    this.token = options.token;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.requestTimeoutMs = options.requestTimeoutMs;
  }

  /**
   * Bind a new immutable client to one locally-held bearer without mutating the bootstrap client.
   * Session-ticket raw material belongs only in the Authorization header and is never serialized
   * into an enrollment or registration request body.
   */
  withToken(raw: string): HubClient {
    if (raw.length === 0 || raw.trim() !== raw || /[\r\n]/u.test(raw)) {
      throw new TypeError("withToken requires a non-empty bearer token without whitespace padding");
    }
    return new HubClient({
      baseUrl: this.baseUrl,
      token: raw,
      fetch: this.fetchImpl,
      requestTimeoutMs: this.requestTimeoutMs,
    });
  }

  async request<T>(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    let requestSignal = signal;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let removeExternalAbortListener: (() => void) | undefined;

    if (this.requestTimeoutMs !== undefined) {
      const controller = new AbortController();
      requestSignal = controller.signal;
      const abortFromCaller = () => controller.abort(signal?.reason);

      if (signal?.aborted) {
        abortFromCaller();
      } else if (signal) {
        signal.addEventListener("abort", abortFromCaller, { once: true });
        removeExternalAbortListener = () => signal.removeEventListener("abort", abortFromCaller);
      }

      timeout = setTimeout(() => {
        controller.abort(
          new DOMException(
            `Hub request timed out after ${this.requestTimeoutMs} ms`,
            "TimeoutError",
          ),
        );
      }, this.requestTimeoutMs);
    }

    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        credentials: "same-origin",
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: requestSignal,
      });
      const text = await response.text();
      let value: unknown = null;
      if (text) {
        try {
          value = JSON.parse(text);
        } catch {
          value = { message: text };
        }
      }
      if (!response.ok) {
        throw new HubHttpError(
          response.status,
          value && typeof value === "object"
            ? (value as Record<string, unknown>)
            : { message: text },
        );
      }
      return value as T;
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      removeExternalAbortListener?.();
    }
  }

  health(): Promise<Record<string, unknown>> {
    return this.request("GET", "/api/health");
  }

  listProjects(): Promise<RegisteredProject[]> {
    return this.request("GET", "/api/projects");
  }

  joinProject(input: {
    cwd: string;
    name?: string;
    allowCreate?: boolean;
  }): Promise<{ project: Project; root: string; created: boolean }> {
    return this.request("POST", "/api/projects/join", input);
  }

  getProjectRegistration(projectId: string): Promise<ProjectRegistration> {
    return this.request("GET", `/api/projects/${encodeURIComponent(projectId)}/registration`);
  }

  getOverview(projectId: string): Promise<Record<string, unknown>> {
    return this.request("GET", `/api/projects/${encodeURIComponent(projectId)}/overview`);
  }

  registerSession(projectId: string, input: Record<string, unknown>): Promise<AgentSession> {
    return this.request("POST", `/api/projects/${encodeURIComponent(projectId)}/sessions`, input);
  }

  createSessionTicketOffer(
    projectId: string,
    input: SessionTicketOfferInput,
  ): Promise<SessionTicketOffer> {
    const parsed = SessionTicketOfferInputSchema.parse(input);
    return this.request<unknown>(
      "POST",
      `/api/projects/${encodeURIComponent(projectId)}/session-ticket-offers`,
      parsed,
    ).then((value) => {
      const offer = SessionTicketOfferSchema.parse(value);
      if (
        offer.project_id !== projectId ||
        offer.bundle_id !== parsed.bundle_id ||
        offer.purpose !== parsed.purpose ||
        offer.adapter_client !== parsed.adapter_client ||
        offer.agent_id !== parsed.agent_id ||
        offer.session_client !== parsed.session_client ||
        offer.role !== parsed.role ||
        offer.transport !== parsed.transport ||
        offer.delivery_mode !== parsed.delivery_mode ||
        offer.external_session_id !== parsed.external_session_id ||
        offer.external_thread_id !== parsed.external_thread_id ||
        offer.run_id !== parsed.run_id
      ) {
        throw new TypeError("Session ticket offer response does not match the enrollment request");
      }
      return offer;
    });
  }

  registerAdapterSession(
    projectId: string,
    input: AdapterSessionRegistrationRequest,
  ): Promise<RegisterAdapterSessionResult> {
    const parsed = RegisterAdapterSessionInputSchema.parse({ ...input, projectId });
    const { projectId: _validatedProjectId, ...body } = parsed;
    return this.request<unknown>(
      "POST",
      `/api/projects/${encodeURIComponent(projectId)}/sessions`,
      body,
    ).then((value) => {
      const result = RegisterAdapterSessionResultSchema.parse(value);
      if (
        result.session.projectId !== projectId ||
        result.session.agentId !== parsed.agentId ||
        result.session.client !== parsed.client ||
        result.session.transport !== parsed.transport ||
        result.session.deliveryMode !== parsed.deliveryMode ||
        result.session.externalSessionId !== (parsed.externalSessionId ?? null) ||
        result.session.externalThreadId !== (parsed.externalThreadId ?? null) ||
        result.ticketBinding.bundleId !== parsed.ticket_bundle_id
      ) {
        throw new TypeError("Adapter registration response does not match the ticketed request");
      }
      return result;
    });
  }

  reserveSessionLaunch(
    projectId: string,
    input: {
      agentId: string;
      client: string;
      deliveryMode: string;
      externalThreadId?: string;
      externalSessionId?: string;
      runId: string;
      idempotencyKey: string;
    },
    signal?: AbortSignal,
  ): Promise<SessionLaunchReservation> {
    return this.request(
      "POST",
      `/api/projects/${encodeURIComponent(projectId)}/session-launch-reservations`,
      input,
      signal,
    );
  }

  getSessionLineageHead(
    projectId: string,
    input: {
      agentId: string;
      client: string;
      deliveryMode: string;
      externalThreadId?: string;
      externalSessionId?: string;
    },
  ): Promise<SessionLineageHead | null> {
    return this.request(
      "GET",
      `/api/projects/${encodeURIComponent(projectId)}/session-lineages/head${queryString(input)}`,
    );
  }

  heartbeat(sessionId: string, input: Record<string, unknown>): Promise<AgentSession> {
    return this.request("POST", `/api/sessions/${encodeURIComponent(sessionId)}/heartbeat`, input);
  }

  recordAdapterEvent(sessionId: string, input: Record<string, unknown>): Promise<DomainEvent> {
    return this.request(
      "POST",
      `/api/sessions/${encodeURIComponent(sessionId)}/adapter-events`,
      input,
    );
  }

  closeSession(sessionId: string, reason = "client_closed"): Promise<AgentSession> {
    return this.request("POST", `/api/sessions/${encodeURIComponent(sessionId)}/close`, { reason });
  }

  closeAdapterSession(
    sessionId: string,
    input: CloseAdapterSessionInput,
  ): Promise<CloseAdapterSessionResult> {
    const parsed = CloseAdapterSessionInputSchema.parse(input);
    return this.request<unknown>(
      "POST",
      `/api/sessions/${encodeURIComponent(sessionId)}/close`,
      parsed,
    ).then((value) => {
      const result = CloseAdapterSessionResultSchema.parse(value);
      if (result.session.id !== sessionId || result.ticketBinding.hubSessionId !== sessionId) {
        throw new TypeError("Adapter close response does not match the requested Hub session");
      }
      return result;
    });
  }

  rotateAdapterSessionTickets(
    sessionId: string,
    bundleId: string,
    input: RotateAdapterSessionTicketsInput,
  ): Promise<RotateAdapterSessionTicketsResult> {
    const parsed = RotateAdapterSessionTicketsInputSchema.parse(input);
    return this.request<unknown>(
      "POST",
      `/api/sessions/${encodeURIComponent(sessionId)}/session-ticket-bundles/${encodeURIComponent(bundleId)}/activate`,
      parsed,
    ).then((value) => {
      const result = RotateAdapterSessionTicketsResultSchema.parse(value);
      if (
        result.session.id !== sessionId ||
        result.ticketBinding.hubSessionId !== sessionId ||
        result.ticketBinding.bundleId !== bundleId ||
        result.supersededTicketBinding.hubSessionId !== sessionId
      ) {
        throw new TypeError("Adapter ticket rotation response does not match the request");
      }
      return result;
    });
  }

  listTasks(
    projectId: string,
    filters: { status?: string; ownerAgentId?: string; readyOnly?: boolean } = {},
  ): Promise<Task[]> {
    return this.request(
      "GET",
      `/api/projects/${encodeURIComponent(projectId)}/tasks${queryString(filters)}`,
    );
  }

  claimTask(taskId: string, input: Record<string, unknown>): Promise<Task> {
    return this.request("POST", `/api/tasks/${encodeURIComponent(taskId)}/claim`, input);
  }

  updateTask(taskId: string, input: Record<string, unknown>): Promise<Task> {
    return this.request("PATCH", `/api/tasks/${encodeURIComponent(taskId)}`, input);
  }

  listMessages(
    projectId: string,
    filters: {
      agentId?: string;
      sessionId?: string;
      unread?: boolean;
      unresolved?: boolean;
      recipientUnsettled?: boolean;
      taskId?: string;
      search?: string;
      limit?: number;
      beforeSequence?: number;
    } = {},
  ): Promise<CrossAgentMessage[]> {
    if (filters.recipientUnsettled) {
      if (!filters.agentId?.trim() || !filters.sessionId?.trim()) {
        throw new TypeError("recipientUnsettled requires agentId and sessionId");
      }
      if (filters.unread || filters.unresolved) {
        throw new TypeError("recipientUnsettled cannot be combined with unread or unresolved");
      }
    }
    if (
      filters.beforeSequence !== undefined &&
      (!Number.isSafeInteger(filters.beforeSequence) || filters.beforeSequence <= 0)
    ) {
      throw new RangeError("beforeSequence must be a positive safe integer");
    }
    return this.request(
      "GET",
      `/api/projects/${encodeURIComponent(projectId)}/messages${queryString(filters)}`,
    );
  }

  getMessage(messageId: string): Promise<CrossAgentMessage> {
    return this.request("GET", `/api/messages/${encodeURIComponent(messageId)}`);
  }

  postMessage(projectId: string, input: Record<string, unknown>): Promise<CrossAgentMessage> {
    return this.request("POST", `/api/projects/${encodeURIComponent(projectId)}/messages`, input);
  }

  relayUserDirective(
    projectId: string,
    input: RelayUserDirectiveInput,
  ): Promise<AuthorityDirective> {
    return this.request<unknown>(
      "POST",
      `/api/projects/${encodeURIComponent(projectId)}/directives/relay`,
      input,
    ).then((value) => AuthorityDirectiveSchema.parse(value));
  }

  supersedeUserDirective(
    directiveId: string,
    input: SupersedeUserDirectiveInput,
  ): Promise<AuthorityDirective> {
    return this.request<unknown>(
      "POST",
      `/api/directives/${encodeURIComponent(directiveId)}/supersede`,
      input,
    ).then((value) => AuthorityDirectiveSchema.parse(value));
  }

  delegateInstruction(
    projectId: string,
    input: DelegateInstructionInput,
  ): Promise<AuthorityDirective> {
    return this.request<unknown>(
      "POST",
      `/api/projects/${encodeURIComponent(projectId)}/directives/delegate`,
      input,
    ).then((value) => AuthorityDirectiveSchema.parse(value));
  }

  getDirective(directiveId: string): Promise<AuthorityDirectiveBundle> {
    return this.request<unknown>("GET", `/api/directives/${encodeURIComponent(directiveId)}`).then(
      (value) => AuthorityDirectiveBundleSchema.parse(value),
    );
  }

  listDirectives(projectId: string): Promise<AuthorityDirective[]> {
    return this.request<unknown[]>(
      "GET",
      `/api/projects/${encodeURIComponent(projectId)}/directives`,
    ).then((values) => values.map((value) => AuthorityDirectiveSchema.parse(value)));
  }

  listAuthoritySigningKeys(): Promise<AuthoritySigningKey[]> {
    return this.request<unknown>("GET", "/api/authority/signing-keys").then((value) =>
      AuthoritySigningKeyListSchema.parse(value),
    );
  }

  createDelegationGrant(
    projectId: string,
    input: CreateDelegationGrantInput,
  ): Promise<DelegationGrant> {
    return this.request<unknown>(
      "POST",
      `/api/projects/${encodeURIComponent(projectId)}/delegation-grants`,
      input,
    ).then((value) => DelegationGrantSchema.parse(value));
  }

  listDelegationGrants(projectId: string): Promise<DelegationGrant[]> {
    return this.request<unknown[]>(
      "GET",
      `/api/projects/${encodeURIComponent(projectId)}/delegation-grants`,
    ).then((values) => values.map((value) => DelegationGrantSchema.parse(value)));
  }

  modifyDelegationGrant(
    grantId: string,
    input: ModifyDelegationGrantInput,
  ): Promise<DelegationGrant> {
    return this.request<unknown>(
      "PATCH",
      `/api/delegation-grants/${encodeURIComponent(grantId)}`,
      input,
    ).then((value) => DelegationGrantSchema.parse(value));
  }

  terminateDelegationGrant(
    grantId: string,
    input: TerminateDelegationGrantInput,
  ): Promise<DelegationGrant> {
    return this.request<unknown>(
      "POST",
      `/api/delegation-grants/${encodeURIComponent(grantId)}/terminate`,
      input,
    ).then((value) => DelegationGrantSchema.parse(value));
  }

  revokeDirective(
    directiveId: string,
    input: DirectiveLifecycleMutationInput,
  ): Promise<AuthorityDirective> {
    return this.request<unknown>(
      "POST",
      `/api/directives/${encodeURIComponent(directiveId)}/revoke`,
      input,
    ).then((value) => AuthorityDirectiveSchema.parse(value));
  }

  recordDirectiveResult(
    directiveId: string,
    input: DirectiveExecutionResultInput,
  ): Promise<AuthorityDirective> {
    return this.request<unknown>(
      "POST",
      `/api/directives/${encodeURIComponent(directiveId)}/results`,
      input,
    ).then((value) => AuthorityDirectiveSchema.parse(value));
  }

  claimMessageRecipient(
    messageId: string,
    input: { sessionId: string; idempotencyKey: string },
  ): Promise<CrossAgentMessage> {
    return this.request("POST", `/api/messages/${encodeURIComponent(messageId)}/claim`, input);
  }

  beginMessageSurface(
    messageId: string,
    input: { sessionId: string; idempotencyKey: string },
  ): Promise<MessageSurfaceResult> {
    return this.request(
      "POST",
      `/api/messages/${encodeURIComponent(messageId)}/surface-attempts`,
      input,
    );
  }

  getAuthorityDeliveryCandidate(
    messageId: string,
    input: AuthorityDeliveryRequest,
  ): Promise<AdapterAuthorityDeliveryCandidate> {
    return this.request<unknown>(
      "POST",
      `/api/messages/${encodeURIComponent(messageId)}/authority-delivery`,
      input,
    ).then((value) => AdapterAuthorityDeliveryCandidateSchema.parse(value));
  }

  recoverAuthorityDelivery(
    messageId: string,
    input: RecoverAuthorityDeliveryRequest,
  ): Promise<RecoveredAuthorityDelivery> {
    return this.request<unknown>(
      "POST",
      `/api/messages/${encodeURIComponent(messageId)}/authority-delivery/recover`,
      input,
    ).then((value) => RecoveredAuthorityDeliverySchema.parse(value));
  }

  prepareSyntheticPrompt(
    messageId: string,
    input: PrepareSyntheticPromptInput,
  ): Promise<PreparedSyntheticPrompt> {
    return this.request<unknown>(
      "POST",
      `/api/messages/${encodeURIComponent(messageId)}/synthetic-prompts`,
      input,
    ).then((value) => PreparedSyntheticPromptSchema.parse(value));
  }

  abortSyntheticPrompt(
    reservationId: string,
    input: AbortSyntheticPromptInput,
  ): Promise<AbortedSyntheticPrompt> {
    return this.request<unknown>(
      "POST",
      `/api/synthetic-prompts/${encodeURIComponent(reservationId)}/abort`,
      input,
    ).then((value) => AbortedSyntheticPromptSchema.parse(value));
  }

  updateMessageSurface(
    messageId: string,
    attemptId: string,
    input: {
      sessionId: string;
      state: "ABORTED" | "AMBIGUOUS";
      error?: string;
      idempotencyKey: string;
    },
  ): Promise<MessageSurfaceResult> {
    return this.request(
      "POST",
      `/api/messages/${encodeURIComponent(messageId)}/surface-attempts/${encodeURIComponent(attemptId)}/state`,
      input,
    );
  }

  reconcileOrdinaryMessageSurface(
    messageId: string,
    attemptId: string,
    input: {
      sessionId: string;
      recipientFence: number;
      externalThreadId: string;
      idempotencyKey: string;
    },
  ): Promise<CrossAgentMessage> {
    return this.request(
      "POST",
      `/api/messages/${encodeURIComponent(messageId)}/surface-attempts/${encodeURIComponent(attemptId)}/reconcile-ordinary`,
      input,
    );
  }

  setMessageState(
    messageId: string,
    state: "ack" | "processed" | "responded" | "delivered",
    input: Record<string, unknown>,
  ): Promise<CrossAgentMessage> {
    return this.request("POST", `/api/messages/${encodeURIComponent(messageId)}/${state}`, input);
  }

  getContextPack(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("POST", "/api/context-pack", input);
  }

  listEvents(projectId: string, afterSequence = 0, limit = 1000): Promise<DomainEvent[]> {
    return this.request(
      "GET",
      `/api/projects/${encodeURIComponent(projectId)}/events${queryString({
        afterSequence,
        limit,
      })}`,
    );
  }
}

export type ProjectSocketFrame =
  | { type: "authenticated" }
  | { type: "subscribed"; projectId: string; currentSequence: number; serverTime: string }
  | { type: "event"; event: DomainEvent; replay: boolean }
  | { type: "ping"; sentAt: string }
  | { type: "resync_required"; reason: string }
  | { type: "error"; code: string; message: string }
  | Record<string, unknown>;

export type ProjectSocketOptions = {
  baseUrl?: string;
  token?: string;
  projectId: string;
  sessionId?: string;
  clientType: "dashboard" | "codex_bridge" | "claude_channel";
  lastSequence?: number;
  authenticationTimeoutMs?: number;
  WebSocket?: typeof globalThis.WebSocket;
  onFrame: (frame: ProjectSocketFrame) => void;
  onClose?: (event: CloseEvent) => void;
};

export function openProjectSocket(options: ProjectSocketOptions): WebSocket {
  const baseUrl = (options.baseUrl ?? "http://127.0.0.1:4387").replace(/\/$/, "");
  const websocketUrl = new URL(`${baseUrl.replace(/^http/, "ws")}/ws`);
  const requiresAgentAuthentication = options.clientType !== "dashboard";
  if (requiresAgentAuthentication && !options.token) {
    throw new TypeError("Agent project sockets require an in-band bearer token");
  }
  const authenticationTimeoutMs = options.authenticationTimeoutMs ?? 5_000;
  if (!Number.isFinite(authenticationTimeoutMs) || authenticationTimeoutMs <= 0) {
    throw new TypeError("Project socket authentication timeout must be positive and finite");
  }
  const authenticationFrame = requiresAgentAuthentication
    ? ProjectSocketAuthenticateFrameSchema.safeParse({
        type: "authenticate",
        token: options.token,
      })
    : null;
  if (authenticationFrame && !authenticationFrame.success) {
    throw new TypeError("Project socket bearer token is invalid");
  }
  const WebSocketImpl = options.WebSocket ?? globalThis.WebSocket;
  const socket = new WebSocketImpl(websocketUrl);
  let subscribed = false;
  let authenticated = !requiresAgentAuthentication;
  let authenticationFailed = false;
  let authenticationTimer: ReturnType<typeof setTimeout> | undefined;
  const clearAuthenticationTimer = () => {
    if (authenticationTimer !== undefined) {
      clearTimeout(authenticationTimer);
      authenticationTimer = undefined;
    }
  };
  const failAuthentication = (code: string, message: string, reason: string) => {
    if (authenticated || authenticationFailed) return;
    authenticationFailed = true;
    clearAuthenticationTimer();
    options.onFrame({ type: "error", code, message });
    if (socket.readyState < 2) socket.close(1008, reason);
  };
  const subscribe = () => {
    if (subscribed) return;
    socket.send(
      JSON.stringify({
        type: "subscribe",
        clientType: options.clientType,
        projectId: options.projectId,
        sessionId: options.sessionId,
        lastSequence: options.lastSequence ?? 0,
      }),
    );
    subscribed = true;
  };
  socket.addEventListener("open", () => {
    if (requiresAgentAuthentication) {
      socket.send(JSON.stringify(authenticationFrame?.data));
      authenticationTimer = setTimeout(() => {
        failAuthentication(
          "AUTHENTICATION_TIMEOUT",
          "Hub socket Agent authentication timed out",
          "authentication_timeout",
        );
      }, authenticationTimeoutMs);
      return;
    }
    subscribe();
  });
  socket.addEventListener("message", (event) => {
    let frame: ProjectSocketFrame;
    try {
      frame = JSON.parse(String(event.data)) as ProjectSocketFrame;
    } catch {
      if (requiresAgentAuthentication && !authenticated) {
        failAuthentication(
          "INVALID_FRAME",
          "Hub socket sent malformed JSON",
          "invalid_authentication_frame",
        );
      } else {
        options.onFrame({
          type: "error",
          code: "INVALID_FRAME",
          message: "Hub socket sent malformed JSON",
        });
      }
      return;
    }
    if (requiresAgentAuthentication && !authenticated && frame.type !== "authenticated") {
      failAuthentication(
        "AUTHENTICATION_REQUIRED",
        "Hub socket sent data before Agent authentication completed",
        "authentication_required",
      );
      return;
    }
    if (frame.type === "authenticated") {
      const authenticatedFrame = ProjectSocketAuthenticatedFrameSchema.safeParse(frame);
      if (!authenticatedFrame.success) {
        failAuthentication(
          "INVALID_AUTHENTICATION_FRAME",
          "Hub socket sent an invalid authentication acknowledgement",
          "invalid_authentication_frame",
        );
        return;
      }
      if (requiresAgentAuthentication) {
        if (authenticationFailed) return;
        authenticated = true;
        clearAuthenticationTimer();
        subscribe();
      }
      options.onFrame(authenticatedFrame.data);
      return;
    }
    if (frame.type === "ping") {
      // A ping already queued while close started must not turn normal teardown into an uncaught
      // InvalidStateError. OPEN is numeric in every WebSocket implementation, while the static
      // constant is not consistently exposed by test and native transports.
      if (socket.readyState === 1) {
        try {
          socket.send(JSON.stringify({ type: "pong" }));
        } catch {
          options.onFrame({
            type: "error",
            code: "PONG_FAILED",
            message: "Hub socket could not send pong",
          });
          return;
        }
      }
    }
    options.onFrame(frame);
  });
  socket.addEventListener("close", clearAuthenticationTimer);
  if (options.onClose) socket.addEventListener("close", options.onClose);
  return socket;
}
