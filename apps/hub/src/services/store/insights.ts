// Read-side projections plus artifact publication. Like context-pack this owns no domain tables of
// its own -- except artifacts, which have no lifecycle beyond being written once and read back.

import {
  createId,
  nowIso,
  type AgentSession,
  type DomainEvent,
  type Project,
  type ReviewBundle,
  type Task,
  type TodoItem,
} from "@crossagent/protocol";
import { saveArtifact } from "../../git/git-service.js";
import { ForbiddenError, HubError } from "../../domain/errors.js";
import type { RequestPrincipal } from "../../security/local-auth.js";
import { json, type StoreContext } from "./context.js";
import { mutationOptions, resolveMutationActor } from "./mutation-authority.js";
import { getProject } from "./projects.js";
import { listSessions, refreshDerivedPresence } from "./sessions.js";
import { listTasks } from "./tasks.js";
import { listConflicts, type ConflictView } from "./write-intents.js";
import { listReviews } from "./reviews.js";

type TaskWithTodos = Task & { todos: TodoItem[]; dependencyReady: boolean };

const PRIVATE_AUTHORITY_EVENT_TYPES = new Set([
  "user_turn.captured",
  "user_turn.synthetic_excluded",
  "synthetic_prompt.prepared",
  "synthetic_prompt.aborted",
]);
const REDACTED_AUTHORITY_EVENT_TYPE = "authority.private_redacted";

function assertEventProjectAccess(
  principal: RequestPrincipal | undefined,
  projectId: string,
): void {
  if (principal?.kind === "AGENT" && principal.projectId !== projectId) {
    throw new ForbiddenError("Credential is bound to another project");
  }
}

function eventFromRow(row: any): DomainEvent {
  return {
    id: row.id,
    projectId: row.project_id,
    sequence: row.sequence,
    type: row.type,
    actorType: row.actor_type,
    actorId: row.actor_id,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    causationId: row.causation_id,
    correlationId: row.correlation_id,
    payload: json(row.payload_json, null),
    createdAt: row.created_at,
  } as DomainEvent;
}

export function projectEventForPrincipal(
  principal: RequestPrincipal | undefined,
  event: DomainEvent,
): DomainEvent {
  assertEventProjectAccess(principal, event.projectId);
  if (principal?.kind === "DASHBOARD_USER" || !PRIVATE_AUTHORITY_EVENT_TYPES.has(event.type)) {
    return event;
  }
  return {
    id: event.id,
    projectId: event.projectId,
    sequence: event.sequence,
    type: REDACTED_AUTHORITY_EVENT_TYPE,
    actorType: "system",
    actorId: "authority-private",
    aggregateType: "authority_private",
    aggregateId: "redacted",
    causationId: null,
    correlationId: null,
    payload: { redacted: true },
    createdAt: event.createdAt,
  };
}

/**
 * What getOverview actually returns. The facade still declares `any` for the same reason it does for
 * the conflict operations -- narrowing a public `any` can break a caller reading a field a new type
 * does not name -- but naming the shape here closes a real hole: this object is assembled as a
 * literal and handed straight to the Dashboard, so before this a renamed or mistyped key was
 * invisible to the compiler and only showed up as a missing field in the UI.
 *
 * Rows that genuinely have no model yet (objectives, milestones, decisions come straight from SQL)
 * stay loose on purpose rather than being given an invented shape.
 */
export type ProjectOverview = {
  project: Project;
  objective: Record<string, unknown> | null;
  computedProgress: number;
  milestones: Array<Record<string, unknown>>;
  tasks: TaskWithTodos[];
  sessions: AgentSession[];
  pendingReviews: ReviewBundle[];
  blockers: TaskWithTodos[];
  conflicts: ConflictView[];
  decisions: unknown[];
  recentEvents: DomainEvent[];
  currentSequence: number;
  generatedAt: string;
};

/**
 * One stored artifact's metadata. `storagePath` is deliberately included: the HTTP layer needs it to
 * stream the bytes back, and the alternative -- having the store read the file itself -- would make
 * every caller buy the whole 10 MiB just to learn a media type.
 */
export type StoredArtifact = {
  id: string;
  projectId: string;
  taskId: string | null;
  reviewId: string | null;
  kind: string;
  name: string;
  mediaType: string;
  sha256: string;
  sizeBytes: number;
  storagePath: string;
  createdAt: string;
};

/** What the health endpoint reports about the database it is serving from. */
export type DatabaseHealth = {
  journalMode: string;
  foreignKeys: boolean;
  busyTimeoutMs: number;
};

/** Operational counters for the metrics endpoint. Every value is a scalar read out of SQL. */
export type ProjectMetrics = {
  activeSessions: number;
  maxHeartbeatLagMs: number;
  pendingMessages: number;
  actionRequiredAgeSeconds: number;
  taskCounts: unknown[];
  blockingFindings: number;
  writeConflicts: number;
  websocketClients: number;
  adapterReconnects: number;
  dbBusyRetries: number;
  generatedAt: string;
};

export function listEvents(
  ctx: StoreContext,
  projectId: string,
  afterSequence = 0,
  limit = 1000,
  types?: string[],
  principal?: RequestPrincipal,
): DomainEvent[] {
  assertEventProjectAccess(principal, projectId);
  const clauses = ["project_id = ?", "sequence > ?"];
  const params: unknown[] = [projectId, afterSequence];
  let projectedTypes = types;
  if (types?.length) {
    const sqlTypes = [...types];
    if (principal?.kind !== "DASHBOARD_USER") {
      const requestedRedacted = sqlTypes.includes(REDACTED_AUTHORITY_EVENT_TYPE);
      projectedTypes = sqlTypes.filter((type) => !PRIVATE_AUTHORITY_EVENT_TYPES.has(type));
      const publicTypes = projectedTypes.filter((type) => type !== REDACTED_AUTHORITY_EVENT_TYPE);
      sqlTypes.splice(0, sqlTypes.length, ...publicTypes);
      if (requestedRedacted) sqlTypes.push(...PRIVATE_AUTHORITY_EVENT_TYPES);
    }
    if (sqlTypes.length === 0) return [];
    clauses.push(`type IN (${sqlTypes.map(() => "?").join(",")})`);
    params.push(...sqlTypes);
  }
  params.push(Math.min(limit, 5000));
  const events = (
    ctx.sqlite
      .prepare(
        `SELECT * FROM events WHERE ${clauses.join(" AND ")}
           ORDER BY sequence LIMIT ?`,
      )
      .all(...params) as any[]
  ).map(eventFromRow);
  const projected = events.map((event) => projectEventForPrincipal(principal, event));
  return projectedTypes?.length
    ? projected.filter((event) => projectedTypes.includes(event.type))
    : projected;
}

export function getOverview(
  ctx: StoreContext,
  projectId: string,
  principal?: RequestPrincipal,
): ProjectOverview {
  assertEventProjectAccess(principal, projectId);
  refreshDerivedPresence(ctx, projectId);
  const project = getProject(ctx, projectId);
  const objective = project.activeObjectiveId
    ? ((ctx.sqlite
        .prepare("SELECT * FROM objectives WHERE id = ?")
        .get(project.activeObjectiveId) ?? null) as Record<string, unknown> | null)
    : null;
  const milestones = project.activeObjectiveId
    ? (ctx.sqlite
        .prepare("SELECT * FROM milestones WHERE objective_id = ? ORDER BY sort_order, created_at")
        .all(project.activeObjectiveId) as any[])
    : [];
  const taskList = listTasks(ctx, projectId);
  const taskWeight = taskList.reduce((sum, task) => sum + task.weight, 0);
  const computedProgress =
    taskWeight === 0
      ? 0
      : Math.round(
          (taskList.reduce((sum, task) => sum + task.computedProgress * task.weight, 0) /
            taskWeight) *
            10,
        ) / 10;
  const milestoneViews = milestones.map((milestone) => {
    const children = taskList.filter((task) => task.milestoneId === milestone.id);
    const total = children.reduce((sum, task) => sum + task.weight, 0);
    return {
      ...milestone,
      computedProgress:
        total === 0
          ? 0
          : Math.round(
              (children.reduce((sum, task) => sum + task.computedProgress * task.weight, 0) /
                total) *
                10,
            ) / 10,
      taskCount: children.length,
    };
  });
  const currentSequence = (
    ctx.sqlite.prepare("SELECT current_sequence FROM projects WHERE id = ?").get(projectId) as {
      current_sequence: number;
    }
  ).current_sequence;
  return {
    project,
    objective,
    computedProgress,
    milestones: milestoneViews,
    tasks: taskList,
    sessions: listSessions(ctx, projectId),
    pendingReviews: listReviews(ctx, projectId).filter((review) =>
      ["PENDING", "DELIVERED", "IN_REVIEW", "CHANGES_REQUESTED"].includes(review.status),
    ),
    blockers: taskList.filter(
      (task) =>
        task.status === "BLOCKED" ||
        task.status === "WAITING_FOR_USER" ||
        task.priority === "critical",
    ),
    conflicts: listConflicts(ctx, projectId, "OPEN"),
    decisions: ctx.sqlite
      .prepare(
        "SELECT * FROM decisions WHERE project_id = ? AND status = 'ACTIVE' ORDER BY updated_at DESC LIMIT 10",
      )
      .all(projectId),
    recentEvents: listEvents(
      ctx,
      projectId,
      Math.max(0, currentSequence - 50),
      50,
      undefined,
      principal,
    ),
    currentSequence,
    generatedAt: nowIso(),
  };
}

export function getMetrics(ctx: StoreContext, projectId?: string): ProjectMetrics {
  const param = projectId ? [projectId] : [];
  const where = projectId ? "WHERE project_id = ?" : "";
  const value = (query: string, params: unknown[] = param) =>
    (ctx.sqlite.prepare(query).get(...params) as any)?.value ?? 0;
  return {
    activeSessions: value(
      `SELECT COUNT(*) AS value FROM agent_sessions ${where}
         ${where ? "AND" : "WHERE"} connection_state IN ('ONLINE','STALE','DEGRADED')`,
    ),
    maxHeartbeatLagMs:
      value(
        `SELECT COALESCE(MAX((julianday('now') - julianday(transport_last_seen_at)) * 86400000), 0) AS value
           FROM agent_sessions ${where}`,
      ) ?? 0,
    pendingMessages: value(
      `SELECT COUNT(*) AS value FROM message_recipients mr JOIN messages m ON m.id = mr.message_id
         ${projectId ? "WHERE m.project_id = ? AND" : "WHERE"} mr.state IN ('PENDING','DELIVERED')`,
    ),
    actionRequiredAgeSeconds: value(
      `SELECT COALESCE(MAX((julianday('now') - julianday(m.created_at)) * 86400), 0) AS value
         FROM messages m JOIN message_recipients mr ON mr.message_id = m.id
         ${projectId ? "WHERE m.project_id = ? AND" : "WHERE"}
         m.priority IN ('IMPORTANT','INTERRUPT') AND mr.state IN ('PENDING','DELIVERED')`,
    ),
    taskCounts: ctx.sqlite
      .prepare(
        `SELECT status, COUNT(*) AS count FROM tasks ${where} GROUP BY status ORDER BY status`,
      )
      .all(...param),
    blockingFindings: value(
      `SELECT COUNT(*) AS value FROM review_findings f JOIN reviews r ON r.id = f.review_id
         ${projectId ? "WHERE r.project_id = ? AND" : "WHERE"}
         f.blocking = 1 AND f.status NOT IN ('VERIFIED','WONT_FIX')`,
    ),
    writeConflicts: value(
      `SELECT COUNT(*) AS value FROM write_conflicts ${where}
         ${where ? "AND" : "WHERE"} status = 'OPEN'`,
    ),
    websocketClients: ctx.bus.websocketClients,
    adapterReconnects: 0,
    dbBusyRetries: 0,
    generatedAt: nowIso(),
  };
}

/**
 * Reads one artifact's metadata back. This exists so the HTTP layer can serve artifact content
 * without reaching into `store.sqlite` itself -- that raw `prepare(...) as any` in the route was the
 * one remaining reason the sqlite handle had to stay public.
 */
export function getArtifact(ctx: StoreContext, id: string): StoredArtifact | null {
  const row = ctx.sqlite
    .prepare(
      `SELECT id, project_id, task_id, review_id, kind, name, media_type,
         sha256, size_bytes, storage_path, created_at
         FROM artifacts WHERE id = ?`,
    )
    .get(id) as Record<string, any> | undefined;
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    reviewId: row.review_id,
    kind: row.kind,
    name: row.name,
    mediaType: row.media_type,
    sha256: row.sha256,
    sizeBytes: row.size_bytes,
    storagePath: row.storage_path,
    createdAt: row.created_at,
  };
}

/**
 * The pragmas the health endpoint reports. Read through the store for the same reason as
 * getArtifact: so that nothing outside this directory needs the sqlite handle.
 */
export function databaseHealth(ctx: StoreContext): DatabaseHealth {
  return {
    journalMode: String(ctx.sqlite.pragma("journal_mode", { simple: true })).toUpperCase(),
    foreignKeys: Boolean(ctx.sqlite.pragma("foreign_keys", { simple: true })),
    busyTimeoutMs: Number(ctx.sqlite.pragma("busy_timeout", { simple: true })),
  };
}

export function publishArtifact(
  ctx: StoreContext,
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
  const content = input.base64
    ? Buffer.from(input.base64, "base64")
    : Buffer.from(input.text ?? "", "utf8");
  if (content.length > 10 * 1024 * 1024) {
    throw new HubError("Artifact exceeds the 10 MiB limit", 413, "ARTIFACT_TOO_LARGE");
  }
  const artifactId = createId("art");
  const actor = resolveMutationActor(ctx, principal, projectId, input.sessionId);
  return ctx.mutate(
    projectId,
    input.idempotencyKey,
    "artifact.publish",
    ({ emit }) => {
      const saved = saveArtifact(ctx.options.dataDir, projectId, artifactId, input.name, content);
      const now = nowIso();
      ctx.sqlite
        .prepare(
          `INSERT INTO artifacts(
            id, project_id, task_id, review_id, kind, name, media_type, sha256,
            size_bytes, storage_path, metadata_json, created_by_session_id, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          artifactId,
          projectId,
          input.taskId ?? null,
          input.reviewId ?? null,
          input.kind,
          input.name,
          input.mediaType,
          saved.sha256,
          saved.sizeBytes,
          saved.storagePath,
          JSON.stringify(input.metadata ?? {}),
          input.sessionId ?? null,
          now,
        );
      emit({
        projectId,
        type: "artifact.published",
        actorType: actor.actorType,
        actorId: actor.actorId,
        aggregateType: "artifact",
        aggregateId: artifactId,
        causationId: null,
        correlationId: input.reviewId ?? input.taskId ?? null,
        payload: {
          taskId: input.taskId ?? null,
          reviewId: input.reviewId ?? null,
          kind: input.kind,
          name: input.name,
          mediaType: input.mediaType,
          sha256: saved.sha256,
          sizeBytes: saved.sizeBytes,
        },
      });
      return ctx.sqlite
        .prepare(
          `SELECT id, project_id, task_id, review_id, kind, name, media_type,
           sha256, size_bytes, metadata_json, created_by_session_id, created_at
           FROM artifacts WHERE id = ?`,
        )
        .get(artifactId);
    },
    mutationOptions(actor, { projectId, ...input, idempotencyKey: undefined }),
  );
}
