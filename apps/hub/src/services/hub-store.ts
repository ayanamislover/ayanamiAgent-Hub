import type Database from "better-sqlite3";
import {
  type AbortSyntheticPromptInput,
  type AbortedSyntheticPrompt,
  type AgentSession,
  type AdapterAuthorityDeliveryCandidate,
  type AuthorityDirective,
  type AuthorityDirectiveBundle,
  type AuthoritySigningKey,
  type CaptureUserTurnInput,
  type AuthorizationCapability,
  type AuthorizationGrant,
  type ModelPreset,
  type CrossAgentMessage,
  type CreateDelegationGrantInput,
  type DelegateInstructionInput,
  type DelegationGrant,
  type DomainEvent,
  type DirectiveExecutionResultInput,
  type DirectiveLifecycleMutationInput,
  type MessagePriority,
  type MessageSurfacePermit,
  type Project,
  type ModifyDelegationGrantInput,
  type RelayUserDirectiveInput,
  type SupersedeUserDirectiveInput,
  type ReviewBundle,
  type ReviewFinding,
  type PrepareSyntheticPromptInput,
  type PreparedSyntheticPrompt,
  RecoveredAuthorityDeliverySchema,
  type RecoveredAuthorityDelivery,
  type RegisterAdapterSessionInput,
  type RotateAdapterSessionTicketsInput,
  type CloseAdapterSessionInput,
  type CloseAdapterSessionResult,
  type SessionLaunchReservation,
  type SessionLineageHead,
  type SessionTicketOffer,
  type SessionTicketOfferInput,
  type Task,
  type TaskStatus,
  type TerminateDelegationGrantInput,
  type Thread,
  type TodoItem,
  type UserTurn,
  type WriteIntent,
} from "@crossagent/protocol";
import { mkdirSync } from "node:fs";

import type { HubDatabase } from "../db/database.js";
import type { RequestPrincipal } from "../security/local-auth.js";
import { HubError } from "../domain/errors.js";

import { EventBus } from "../events/event-bus.js";
import { AuthorityAttestationService } from "./authority-attestation.js";
import { createStoreContext, type HubStoreOptions, type StoreContext } from "./store/context.js";
import * as authorizations from "./store/authorizations.js";
import * as authority from "./store/authority.js";
import * as contextPack from "./store/context-pack.js";
import * as directives from "./store/directives.js";
import * as insights from "./store/insights.js";
import * as messages from "./store/messages.js";
import * as presets from "./store/presets.js";
import * as reviews from "./store/reviews.js";
import * as projects from "./store/projects.js";
import * as sessions from "./store/sessions.js";
import type {
  RegisterAdapterSessionReceipt,
  RotateAdapterSessionTicketsReceipt,
} from "./store/sessions.js";
import * as writeIntents from "./store/write-intents.js";
import * as tasks from "./store/tasks.js";

export type { HubStoreOptions } from "./store/context.js";

/**
 * The Hub's write and read surface.
 *
 * This used to hold every operation for every domain in one 3700-line class. The behaviour now lives
 * in `./store/*`, one module per domain, layered so a module may only reach for domains declared
 * above it; what remains here is the facade every caller already binds to. Keeping the facade means
 * routes, the MCP server and the tests did not have to change to get the seams.
 */
export class HubStore {
  readonly sqlite: Database.Database;
  private readonly ctx: StoreContext;
  private readonly authorityAttestations: AuthorityAttestationService;

  constructor(
    readonly database: HubDatabase,
    readonly bus: EventBus,
    readonly options: HubStoreOptions,
  ) {
    this.sqlite = database.sqlite;
    mkdirSync(options.dataDir, { recursive: true });
    this.ctx = createStoreContext(this.sqlite, bus, options);
    this.authorityAttestations = new AuthorityAttestationService(this.sqlite, options.dataDir);
  }

  getProject(projectId: string): Project {
    return projects.getProject(this.ctx, projectId);
  }

  listProjects(): Array<Project & { paths: string[] }> {
    return projects.listProjects(this.ctx);
  }

  getProjectRegistration(projectId: string): {
    project: Project;
    root: string;
    paths: string[];
  } {
    return projects.getProjectRegistration(this.ctx, projectId);
  }

  joinProject(
    principal: RequestPrincipal,
    input: { cwd: string; name?: string; allowCreate: boolean },
  ): {
    project: Project;
    root: string;
    created: boolean;
  } {
    return projects.joinProject(this.ctx, principal, input);
  }

  captureUserTurn(
    principal: import("../security/local-auth.js").RequestPrincipal,
    input: CaptureUserTurnInput,
  ): authority.CaptureUserTurnResult {
    return authority.captureUserTurn(this.ctx, principal, input);
  }

  getUserTurn(userTurnId: string): UserTurn {
    return authority.getUserTurn(this.ctx, userTurnId);
  }

  relayUserDirective(
    principal: RequestPrincipal,
    projectId: string,
    input: RelayUserDirectiveInput,
  ): AuthorityDirective {
    return directives.relayUserDirective(
      this.ctx,
      this.authorityAttestations,
      principal,
      projectId,
      input,
    );
  }

  supersedeUserDirective(
    principal: RequestPrincipal,
    oldDirectiveId: string,
    input: SupersedeUserDirectiveInput,
  ): AuthorityDirective {
    return directives.supersedeUserDirective(
      this.ctx,
      this.authorityAttestations,
      principal,
      oldDirectiveId,
      input,
    );
  }

  delegateInstruction(
    principal: RequestPrincipal,
    projectId: string,
    input: DelegateInstructionInput,
  ): AuthorityDirective {
    return directives.delegateInstruction(
      this.ctx,
      this.authorityAttestations,
      principal,
      projectId,
      input,
    );
  }

  getDirective(principal: RequestPrincipal, directiveId: string): AuthorityDirectiveBundle {
    return directives.getDirectiveBundleForPrincipal(
      this.ctx,
      this.authorityAttestations,
      principal,
      directiveId,
    );
  }

  listDirectives(principal: RequestPrincipal, projectId: string): AuthorityDirective[] {
    return directives.listDirectives(this.ctx, this.authorityAttestations, principal, projectId);
  }

  listAuthoritySigningKeys(): AuthoritySigningKey[] {
    return directives.listAuthoritySigningKeys(this.ctx);
  }

  getAuthorityDeliveryCandidate(
    principal: RequestPrincipal,
    messageId: string,
    input: directives.AuthorityDeliveryRequest,
  ): AdapterAuthorityDeliveryCandidate {
    return directives.getAuthorityDeliveryCandidate(
      this.ctx,
      this.authorityAttestations,
      principal,
      messageId,
      input,
    );
  }

  recoverAuthorityDelivery(
    principal: RequestPrincipal,
    messageId: string,
    input: { sessionId: string },
  ): RecoveredAuthorityDelivery {
    return this.sqlite.transaction(() => {
      const recovery = messages.recoverConfirmedMessageSurface(
        this.ctx,
        principal,
        messageId,
        input,
      );
      const candidate = directives.getRecoveredAuthorityDeliveryCandidate(
        this.ctx,
        this.authorityAttestations,
        messageId,
        recovery,
      );
      return RecoveredAuthorityDeliverySchema.parse({ ...recovery, candidate });
    })();
  }

  createDelegationGrant(
    principal: RequestPrincipal,
    projectId: string,
    input: CreateDelegationGrantInput,
  ): DelegationGrant {
    return directives.createDelegationGrant(this.ctx, principal, projectId, input);
  }

  modifyDelegationGrant(
    principal: RequestPrincipal,
    grantId: string,
    input: ModifyDelegationGrantInput,
  ): DelegationGrant {
    return directives.modifyDelegationGrant(this.ctx, principal, grantId, input);
  }

  terminateDelegationGrant(
    principal: RequestPrincipal,
    grantId: string,
    input: TerminateDelegationGrantInput,
  ): DelegationGrant {
    return directives.terminateDelegationGrant(this.ctx, principal, grantId, input);
  }

  listDelegationGrants(principal: RequestPrincipal, projectId: string): DelegationGrant[] {
    return directives.listDelegationGrants(this.ctx, principal, projectId);
  }

  revokeDirective(
    principal: RequestPrincipal,
    directiveId: string,
    input: DirectiveLifecycleMutationInput,
  ): AuthorityDirective {
    return directives.revokeDirective(
      this.ctx,
      this.authorityAttestations,
      principal,
      directiveId,
      input,
    );
  }

  recordDirectiveExecutionResult(
    principal: RequestPrincipal,
    directiveId: string,
    input: DirectiveExecutionResultInput,
  ): AuthorityDirective {
    return directives.recordExecutionResult(
      this.ctx,
      this.authorityAttestations,
      principal,
      directiveId,
      input,
    );
  }

  prepareSyntheticPrompt(
    principal: import("../security/local-auth.js").RequestPrincipal,
    messageId: string,
    input: PrepareSyntheticPromptInput,
  ): PreparedSyntheticPrompt {
    return authority.prepareSyntheticPrompt(
      this.ctx,
      this.authorityAttestations,
      principal,
      messageId,
      input,
    );
  }

  abortSyntheticPrompt(
    principal: RequestPrincipal,
    reservationId: string,
    input: AbortSyntheticPromptInput,
  ): AbortedSyntheticPrompt {
    return authority.abortSyntheticPrompt(this.ctx, principal, reservationId, input);
  }

  createObjective(
    principal: RequestPrincipal,
    projectId: string,
    input: {
      title: string;
      description: string;
      definitionOfDone: string[];
      status: "PLANNED" | "ACTIVE";
      idempotencyKey: string;
    },
  ) {
    return projects.createObjective(this.ctx, principal, projectId, input);
  }

  createMilestone(
    principal: RequestPrincipal,
    projectId: string,
    input: {
      objectiveId: string;
      title: string;
      description: string;
      sortOrder: number;
      weight: number;
      idempotencyKey: string;
    },
  ) {
    return projects.createMilestone(this.ctx, principal, projectId, input);
  }

  registerSession(
    input: {
      projectId: string;
      agentId: string;
      role: "primary" | "reviewer" | "observer";
      client: string;
      transport: string;
      deliveryMode: string;
      externalSessionId?: string;
      externalThreadId?: string;
      externalTurnId?: string;
      host?: string;
      pid?: number;
      cwd: string;
      gitBranch?: string;
      gitHead?: string;
      capabilities: string[];
      expectedHeadSessionId?: string | null;
      launcherRunId?: string;
      launchGeneration?: number;
      idempotencyKey: string;
    },
    principal?: RequestPrincipal,
  ): AgentSession {
    return sessions.registerSession(this.ctx, input, principal);
  }

  createSessionTicketOffer(
    principal: RequestPrincipal,
    projectId: string,
    input: SessionTicketOfferInput,
  ): SessionTicketOffer {
    return sessions.createSessionTicketOffer(this.ctx, principal, projectId, input);
  }

  registerAdapterSession(
    input: RegisterAdapterSessionInput,
    principal: RequestPrincipal,
  ): RegisterAdapterSessionReceipt {
    return sessions.registerAdapterSession(this.ctx, input, principal);
  }

  rotateAdapterSessionTickets(
    sessionId: string,
    successorBundleId: string,
    input: RotateAdapterSessionTicketsInput,
    principal: RequestPrincipal,
  ): RotateAdapterSessionTicketsReceipt {
    return sessions.rotateAdapterSessionTickets(
      this.ctx,
      sessionId,
      successorBundleId,
      input,
      principal,
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
  ): SessionLineageHead | null {
    return sessions.getSessionLineageHead(this.ctx, projectId, input);
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
    principal?: RequestPrincipal,
  ): SessionLaunchReservation {
    return sessions.reserveSessionLaunch(this.ctx, projectId, input, principal);
  }

  getSession(sessionId: string): AgentSession {
    return sessions.getSession(this.ctx, sessionId);
  }

  assertSessionControl(principal: RequestPrincipal, sessionId: string): AgentSession {
    return sessions.assertSessionControl(this.ctx, principal, sessionId);
  }

  /** Central read boundary for REST, MCP and WebSocket project projections. */
  assertProjectRead(principal: RequestPrincipal, projectId: string): void {
    if (principal.kind === "DASHBOARD_USER") return;
    if (
      principal.credentialClass !== "SESSION_TICKET" ||
      principal.projectId !== projectId ||
      !principal.hubSessionId
    ) {
      throw new HubError("Credential cannot read this project", 403, "PROJECT_NOT_AUTHORIZED");
    }
    const session = sessions.assertSessionControl(this.ctx, principal, principal.hubSessionId);
    if (session.projectId !== projectId) {
      throw new HubError("Credential cannot read this project", 403, "PROJECT_NOT_AUTHORIZED");
    }
  }

  listSessions(projectId: string): AgentSession[] {
    return sessions.listSessions(this.ctx, projectId);
  }

  heartbeat(
    input: {
      sessionId: string;
      sequence: number;
      workState: string;
      currentTaskId?: string | null;
      currentReviewId?: string | null;
      currentTurnId?: string | null;
      gitHead?: string | null;
      activeFiles: string[];
      queueDepth: number;
    },
    principal?: RequestPrincipal,
  ): AgentSession {
    return sessions.heartbeat(this.ctx, input, principal);
  }

  recordAdapterEvent(
    sessionId: string,
    input: {
      method: string;
      externalTurnId?: string | null;
      workState?: string;
      itemType?: string;
      itemId?: string;
      commandName?: string;
      exitCode?: number | null;
      files?: string[];
      status?: string;
      error?: string;
      idempotencyKey: string;
    },
    principal?: RequestPrincipal,
  ): DomainEvent {
    return sessions.recordAdapterEvent(this.ctx, sessionId, input, principal);
  }

  closeSession(
    sessionId: string,
    reason = "client_closed",
    principal?: RequestPrincipal,
  ): AgentSession {
    return sessions.closeSession(this.ctx, sessionId, reason, principal);
  }

  closeAdapterSession(
    sessionId: string,
    input: CloseAdapterSessionInput,
    principal: RequestPrincipal,
  ): CloseAdapterSessionResult {
    return sessions.closeAdapterSession(this.ctx, sessionId, input, principal);
  }

  refreshDerivedPresence(projectId?: string): void {
    sessions.refreshDerivedPresence(this.ctx, projectId);
  }

  getTask(taskId: string): Task {
    return tasks.getTask(this.ctx, taskId);
  }

  listTasks(
    projectId: string,
    filters: { status?: string; ownerAgentId?: string; readyOnly?: boolean } = {},
  ): Array<Task & { todos: TodoItem[]; dependencyReady: boolean }> {
    return tasks.listTasks(this.ctx, projectId, filters);
  }

  createTask(
    principal: RequestPrincipal,
    projectId: string,
    input: {
      objectiveId: string;
      milestoneId?: string | null;
      parentTaskId?: string | null;
      title: string;
      description: string;
      status: TaskStatus;
      priority: "low" | "normal" | "high" | "critical";
      reviewerAgentId?: string | null;
      capabilityTags: string[];
      scopeGlobs: string[];
      protectedScope: boolean;
      reviewRequired: boolean;
      dependsOn: string[];
      weight: number;
      idempotencyKey: string;
    },
  ): Task {
    return tasks.createTask(this.ctx, principal, projectId, input);
  }

  splitTask(
    taskId: string,
    input: {
      expectedVersion: number;
      children: Array<{
        title: string;
        description?: string;
        capabilityTags?: string[];
        scopeGlobs?: string[];
        weight?: number;
      }>;
      sessionId: string;
      idempotencyKey: string;
    },
    principal?: RequestPrincipal,
  ): Task[] {
    if (principal) sessions.assertSessionControl(this.ctx, principal, input.sessionId);
    return tasks.splitTask(this.ctx, taskId, input);
  }

  updateTask(
    principal: RequestPrincipal,
    taskId: string,
    input: {
      expectedVersion: number;
      status?: TaskStatus;
      title?: string;
      description?: string;
      blockedReason?: string | null;
      waitingFor?: string | null;
      selfReportedSummary?: string | null;
      agentEstimate?: number | null;
      reviewerAgentId?: string | null;
      scopeGlobs?: string[];
      capabilityTags?: string[];
      idempotencyKey: string;
      sessionId?: string;
    },
  ): Task {
    return tasks.updateTask(this.ctx, principal, taskId, input);
  }

  claimTask(
    taskId: string,
    input: {
      sessionId: string;
      expectedVersion: number;
      takeoverStale: boolean;
      idempotencyKey: string;
    },
    principal?: RequestPrincipal,
  ): Task {
    if (principal) sessions.assertSessionControl(this.ctx, principal, input.sessionId);
    return tasks.claimTask(this.ctx, taskId, input);
  }

  releaseTask(
    taskId: string,
    input: { sessionId: string; expectedVersion: number; idempotencyKey: string },
    principal?: RequestPrincipal,
  ): Task {
    if (principal) sessions.assertSessionControl(this.ctx, principal, input.sessionId);
    return tasks.releaseTask(this.ctx, taskId, input);
  }

  handoffTask(
    taskId: string,
    input: {
      sessionId: string;
      expectedVersion: number;
      toAgentId: string;
      summary: string;
      idempotencyKey: string;
    },
    principal?: RequestPrincipal,
  ): Task {
    if (principal) sessions.assertSessionControl(this.ctx, principal, input.sessionId);
    return tasks.handoffTask(this.ctx, taskId, input);
  }

  listTodos(taskId: string): TodoItem[] {
    return tasks.listTodos(this.ctx, taskId);
  }

  createTodo(
    principal: RequestPrincipal,
    taskId: string,
    input: {
      title: string;
      description?: string;
      type: string;
      weight: number;
      evidenceRequired: boolean;
      idempotencyKey: string;
      sessionId?: string;
    },
  ): TodoItem {
    return tasks.createTodo(this.ctx, principal, taskId, input);
  }

  updateTodo(
    principal: RequestPrincipal,
    todoId: string,
    input: {
      expectedVersion: number;
      status: "TODO" | "DOING" | "DONE" | "SKIPPED";
      evidence?: Array<Record<string, unknown>>;
      completedBySessionId?: string;
      idempotencyKey: string;
    },
  ): TodoItem {
    return tasks.updateTodo(this.ctx, principal, todoId, input);
  }

  getMessage(messageId: string, principal?: RequestPrincipal): CrossAgentMessage {
    return messages.getMessage(this.ctx, messageId, principal);
  }

  listMessages(
    projectId: string,
    filters: {
      agentId?: string;
      sessionId?: string;
      type?: string;
      unresolved?: boolean;
      unread?: boolean;
      recipientUnsettled?: boolean;
      taskId?: string;
      search?: string;
      limit?: number;
      beforeSequence?: number;
    } = {},
    principal?: RequestPrincipal,
  ): CrossAgentMessage[] {
    return messages.listMessages(this.ctx, projectId, filters, principal);
  }

  postMessage(
    principal: RequestPrincipal,
    projectId: string,
    input: {
      threadId?: string;
      subject?: string;
      replyTo?: string;
      taskId?: string;
      reviewId?: string;
      fromAgentId: string;
      fromSessionId?: string;
      recipients: Array<{ agentId: string; sessionId?: string }>;
      type: string;
      priority: MessagePriority;
      requiresAck: boolean;
      requiresResponse: boolean;
      summary: string;
      detail?: unknown;
      references?: Array<Record<string, unknown>>;
      dedupeKey?: string;
      expiresAt?: string;
      idempotencyKey: string;
    },
  ): CrossAgentMessage {
    return messages.postMessage(this.ctx, projectId, input, principal);
  }

  claimMessageRecipient(
    principal: RequestPrincipal,
    messageId: string,
    input: { sessionId: string; idempotencyKey: string },
  ): CrossAgentMessage {
    return messages.claimMessageRecipient(this.ctx, principal, messageId, input);
  }

  beginMessageSurface(
    principal: RequestPrincipal,
    messageId: string,
    input: { sessionId: string; idempotencyKey: string },
  ): { message: CrossAgentMessage; permit: MessageSurfacePermit } {
    return messages.beginMessageSurface(this.ctx, principal, messageId, input);
  }

  updateMessageSurface(
    principal: RequestPrincipal,
    messageId: string,
    attemptId: string,
    input: {
      sessionId: string;
      state: "ABORTED" | "AMBIGUOUS";
      error?: string;
      idempotencyKey: string;
    },
  ): { message: CrossAgentMessage; permit: MessageSurfacePermit } {
    return messages.updateMessageSurface(this.ctx, principal, messageId, attemptId, input);
  }

  reconcileOrdinaryMessageSurface(
    principal: RequestPrincipal,
    messageId: string,
    attemptId: string,
    input: {
      sessionId: string;
      recipientFence: number;
      externalThreadId: string;
      idempotencyKey: string;
    },
  ): CrossAgentMessage {
    return messages.reconcileOrdinaryMessageSurface(
      this.ctx,
      principal,
      messageId,
      attemptId,
      input,
    );
  }

  updateMessageState(
    principal: RequestPrincipal,
    messageId: string,
    input: {
      sessionId: string;
      state: "DELIVERED" | "ACKNOWLEDGED" | "PROCESSED" | "RESPONDED" | "FAILED";
      error?: string;
      surfaceAttemptId?: string;
      recipientFence?: number;
      idempotencyKey: string;
      transport?: string;
    },
  ): CrossAgentMessage {
    return messages.updateMessageState(this.ctx, principal, messageId, input);
  }

  getThread(
    threadId: string,
    principal?: RequestPrincipal,
  ): {
    thread: Thread;
    messages: CrossAgentMessage[];
    decisions: any[];
  } {
    return messages.getThread(this.ctx, threadId, principal);
  }

  // A capability needing the user's consent is a row the user decides on in the Dashboard, because
  // an agent relaying "the user approved this" is not evidence. See store/authorizations.ts for the
  // honest limit on what this enforces.

  requestAuthorization(
    principal: RequestPrincipal,
    projectId: string,
    input: {
      capability: AuthorizationCapability;
      reason: string;
      detail: Record<string, unknown>;
      requestedByAgentId: string;
      requestedBySessionId?: string;
      idempotencyKey: string;
    },
  ): AuthorizationGrant {
    return authorizations.requestAuthorization(this.ctx, principal, projectId, input);
  }

  getAuthorization(id: string): AuthorizationGrant {
    return authorizations.getAuthorization(this.ctx, id);
  }

  listAuthorizations(projectId: string, filters: { status?: string } = {}): AuthorizationGrant[] {
    return authorizations.listAuthorizations(this.ctx, projectId, filters);
  }

  checkAuthorization(
    projectId: string,
    capability: AuthorizationCapability,
  ): { allowed: boolean; grant: AuthorizationGrant | null } {
    return authorizations.checkAuthorization(this.ctx, projectId, capability);
  }

  decideAuthorization(
    principal: RequestPrincipal,
    id: string,
    input: {
      expectedVersion: number;
      decision: "GRANTED" | "DENIED" | "REVOKED";
      note?: string;
      ttlSeconds?: number;
      idempotencyKey: string;
    },
  ): AuthorizationGrant {
    return authorizations.decideAuthorization(this.ctx, principal, id, input);
  }

  // Model presets are global rather than per-project: which models a CLI accepts is a property of
  // the installed tool, not of the repository being worked on. See store/presets.ts.

  listModelPresets(agentId?: string): ModelPreset[] {
    return presets.listModelPresets(this.ctx, agentId);
  }

  upsertModelPreset(input: {
    agentId: string;
    modelId: string;
    label: string;
    reasoningEfforts: string[];
    launchArgs: string[];
    effortArgs: string[];
    enabled: boolean;
    sortOrder: number;
  }): ModelPreset {
    return presets.upsertModelPreset(this.ctx, input);
  }

  deleteModelPreset(id: string): void {
    presets.deleteModelPreset(this.ctx, id);
  }

  resolveLaunchArgs(preset: ModelPreset, effort?: string): string[] {
    return presets.resolveLaunchArgs(preset, effort);
  }

  recordTerminalEvent(
    projectId: string,
    input: { type: string; sessionId: string; payload: Record<string, unknown> },
  ): void {
    sessions.recordTerminalEvent(this.ctx, projectId, input);
  }

  resolveThread(
    principal: RequestPrincipal,
    threadId: string,
    input: {
      expectedVersion: number;
      status: "RESOLVED" | "NEEDS_USER" | "ARCHIVED";
      idempotencyKey: string;
    },
  ): Thread {
    return messages.resolveThread(this.ctx, principal, threadId, input);
  }

  getContextPack(
    input: {
      sessionId: string;
      taskId?: string;
      files: string[];
      symbols: string[];
      maxChars: number;
    },
    principal?: RequestPrincipal,
  ): {
    generatedAt: string;
    project: Project;
    objective: any;
    task: (Task & { todos: TodoItem[] }) | null;
    inbox: CrossAgentMessage[];
    decisions: any[];
    peerSessions: AgentSession[];
    conflicts: any[];
    reviews: any[];
    text: string;
    truncated: boolean;
  } {
    if (principal) sessions.assertSessionControl(this.ctx, principal, input.sessionId);
    return contextPack.getContextPack(this.ctx, input);
  }

  setWriteIntent(
    projectId: string,
    input: {
      taskId: string;
      sessionId: string;
      globs: string[];
      symbols: string[];
      mode: "advisory" | "exclusive";
      reason: string;
      ttlSeconds: number;
      idempotencyKey: string;
    },
    principal?: RequestPrincipal,
  ): { intent: WriteIntent; conflicts: any[] } {
    if (principal) sessions.assertSessionControl(this.ctx, principal, input.sessionId);
    return writeIntents.setWriteIntent(this.ctx, projectId, input);
  }

  releaseWriteIntent(
    principal: RequestPrincipal,
    intentId: string,
    input: { sessionId?: string; force?: boolean; idempotencyKey: string },
  ): WriteIntent {
    return writeIntents.releaseWriteIntent(this.ctx, principal, intentId, input);
  }

  reconcileObservedChanges(
    sessionId: string,
    principal?: RequestPrincipal,
  ): {
    files: string[];
    undeclared: string[];
    protectedUndeclared: string[];
  } {
    if (principal) {
      // Reuse the same identity gate as the session Store without widening the write-intent Module.
      sessions.assertSessionControl(this.ctx, principal, sessionId);
    }
    return writeIntents.reconcileObservedChanges(this.ctx, sessionId);
  }

  listConflicts(projectId: string, status?: string): any[] {
    return writeIntents.listConflicts(this.ctx, projectId, status);
  }

  resolveConflict(
    principal: RequestPrincipal,
    conflictId: string,
    input: { reason: string; idempotencyKey: string },
  ): any {
    return writeIntents.resolveConflict(this.ctx, principal, conflictId, input);
  }

  requestReview(
    taskId: string,
    input: {
      sessionId: string;
      reviewerAgentId: string;
      baseSha: string;
      headSha: string;
      acceptanceCriteria: string[];
      testEvidence: Array<Record<string, unknown>>;
      authorClaims: string[];
      knownRisks: string[];
      includeUncommitted: boolean;
      idempotencyKey: string;
    },
    principal?: RequestPrincipal,
  ): ReviewBundle {
    if (principal) sessions.assertSessionControl(this.ctx, principal, input.sessionId);
    return reviews.requestReview(this.ctx, taskId, input);
  }

  getReview(reviewId: string): ReviewBundle & {
    findings: ReviewFinding[];
    artifact: any;
    testEvidenceRows: any[];
  } {
    return reviews.getReview(this.ctx, reviewId);
  }

  listReviews(projectId: string, status?: string): ReviewBundle[] {
    return reviews.listReviews(this.ctx, projectId, status);
  }

  beginReview(
    reviewId: string,
    input: { sessionId: string; expectedVersion: number; idempotencyKey: string },
    principal?: RequestPrincipal,
  ): ReviewBundle {
    if (principal) sessions.assertSessionControl(this.ctx, principal, input.sessionId);
    return reviews.beginReview(this.ctx, reviewId, input);
  }

  createFinding(
    reviewId: string,
    input: {
      sessionId: string;
      severity: string;
      category: string;
      title: string;
      claim: string;
      impact: string;
      filePath?: string;
      lineStart?: number;
      lineEnd?: number;
      symbol?: string;
      evidence: Array<Record<string, unknown>>;
      suggestedDirection?: string;
      idempotencyKey: string;
    },
    principal?: RequestPrincipal,
  ): ReviewFinding {
    if (principal) sessions.assertSessionControl(this.ctx, principal, input.sessionId);
    return reviews.createFinding(this.ctx, reviewId, input);
  }

  resolveFinding(
    findingId: string,
    input: {
      sessionId: string;
      status: "ACCEPTED" | "DISPUTED" | "FIXED" | "VERIFIED" | "WONT_FIX";
      resolution: string;
      idempotencyKey: string;
    },
    principal?: RequestPrincipal,
  ): ReviewFinding {
    if (principal) sessions.assertSessionControl(this.ctx, principal, input.sessionId);
    return reviews.resolveFinding(this.ctx, findingId, input);
  }

  submitReviewVerdict(
    reviewId: string,
    input: {
      sessionId: string;
      expectedVersion: number;
      verdict: "APPROVED" | "CHANGES_REQUESTED";
      summary: string;
      overrideReason?: string;
      idempotencyKey: string;
    },
    principal?: RequestPrincipal,
  ): ReviewBundle {
    if (principal) sessions.assertSessionControl(this.ctx, principal, input.sessionId);
    return reviews.submitReviewVerdict(this.ctx, reviewId, input);
  }

  listEvents(
    projectId: string,
    afterSequence = 0,
    limit = 1000,
    types?: string[],
    principal?: RequestPrincipal,
  ): DomainEvent[] {
    return insights.listEvents(this.ctx, projectId, afterSequence, limit, types, principal);
  }

  projectEventForPrincipal(principal: RequestPrincipal, event: DomainEvent): DomainEvent {
    return insights.projectEventForPrincipal(principal, event);
  }

  getOverview(projectId: string, principal?: RequestPrincipal): any {
    return insights.getOverview(this.ctx, projectId, principal);
  }

  getMetrics(projectId?: string): any {
    return insights.getMetrics(this.ctx, projectId);
  }

  updateProjectConfig(
    principal: RequestPrincipal,
    projectId: string,
    input: {
      expectedVersion: number;
      config: unknown;
      idempotencyKey: string;
    },
  ): Project {
    return projects.updateProjectConfig(this.ctx, principal, projectId, input);
  }

  publishArtifact(
    principal: RequestPrincipal,
    projectId: string,
    input: {
      sessionId?: string;
      taskId?: string;
      reviewId?: string;
      kind: string;
      name: string;
      mediaType: string;
      text?: string;
      base64?: string;
      metadata?: Record<string, unknown>;
      idempotencyKey: string;
    },
  ): any {
    return insights.publishArtifact(this.ctx, principal, projectId, input);
  }

  getArtifact(id: string): insights.StoredArtifact | null {
    return insights.getArtifact(this.ctx, id);
  }

  databaseHealth(): insights.DatabaseHealth {
    return insights.databaseHealth(this.ctx);
  }
}
