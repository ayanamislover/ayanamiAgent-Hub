import {
  DEFAULT_PROJECT_CONFIG,
  ProjectConfigSchema,
  createId,
  nowIso,
  type DomainEvent,
  type WriteIntent,
} from "@crossagent/protocol";
import picomatch from "picomatch";
import {
  canonicalPath,
  detectIntentOverlap,
  listTrackedFiles,
  observedChangedFiles,
  readGitState,
} from "../../git/git-service.js";
import { ForbiddenError, HubError, NotFoundError } from "../../domain/errors.js";
import type { RequestPrincipal } from "../../security/local-auth.js";
import { json, type StoreContext } from "./context.js";
import { getProject } from "./projects.js";
import { getOpenSession, getSession } from "./sessions.js";
import { getTask } from "./tasks.js";
import {
  assertDashboardMutation,
  mutationOptions,
  resolveMutationActor,
} from "./mutation-authority.js";

/**
 * The shape getConflict actually returns. The facade still declares `any` for the conflict
 * operations, because narrowing a public `any` could break callers that read fields this type does
 * not name; typing it here costs nothing at runtime and makes the module itself checkable.
 */
export type ConflictView = {
  id: string;
  projectId: string;
  leftIntentId: string;
  rightIntentId: string;
  left_session_id: string;
  right_session_id: string;
  left_task_id: string;
  right_task_id: string;
  left: { agentId: string; sessionId: string; taskId: string; globs: string[]; symbols: string[] };
  right: { agentId: string; sessionId: string; taskId: string; globs: string[]; symbols: string[] };
  severity: string;
  overlap: { files?: string[]; symbols?: string[] };
  overlapFiles: string[];
  overlapSymbols: string[];
  reason: string;
  status: string;
  createdAt: string;
  resolvedAt: string | null;
};

function intentFromRow(row: any): WriteIntent {
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    sessionId: row.session_id,
    globs: json(row.globs_json, []),
    symbols: json(row.symbols_json, []),
    mode: row.mode,
    reason: row.reason,
    observedChangedFiles: json(row.observed_changed_files_json, []),
    expiresAt: row.expires_at,
    releasedAt: row.released_at,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  } as WriteIntent;
}

function projectRoot(ctx: StoreContext, projectId: string, preferred?: string): string {
  if (preferred) {
    const canonical = canonicalPath(preferred);
    const match = ctx.sqlite
      .prepare(
        "SELECT canonical_path FROM project_paths WHERE project_id = ? AND canonical_path = ?",
      )
      .get(projectId, canonical);
    if (match) return canonical;
  }
  const row = ctx.sqlite
    .prepare(
      "SELECT canonical_path FROM project_paths WHERE project_id = ? ORDER BY is_primary DESC, last_seen_at DESC LIMIT 1",
    )
    .get(projectId) as { canonical_path: string } | undefined;
  if (!row) throw new HubError("Project has no registered path", 422, "PROJECT_PATH_MISSING");
  return row.canonical_path;
}

/** Reviews needs the same path resolution when it snapshots a patch. */
export function resolveProjectRoot(
  ctx: StoreContext,
  projectId: string,
  preferred?: string,
): string {
  return projectRoot(ctx, projectId, preferred);
}

export function setWriteIntent(
  ctx: StoreContext,
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
): { intent: WriteIntent; conflicts: any[] } {
  return ctx.mutate(projectId, input.idempotencyKey, "write_intent.set", ({ emit }) => {
    const session = getSession(ctx, input.sessionId);
    const task = getTask(ctx, input.taskId);
    if (session.projectId !== projectId || task.projectId !== projectId) {
      throw new ForbiddenError("Intent session/task does not belong to the project");
    }
    if (task.ownerSessionId !== session.id) {
      throw new ForbiddenError("Declare write intent only for a task owned by this session");
    }
    const existing = ctx.sqlite
      .prepare(
        `SELECT * FROM write_intents
           WHERE task_id = ? AND session_id = ? AND released_at IS NULL
           ORDER BY created_at DESC LIMIT 1`,
      )
      .get(input.taskId, input.sessionId) as any;
    const id = existing?.id ?? createId("wri");
    const now = nowIso();
    const expiresAt = new Date(Date.now() + input.ttlSeconds * 1000).toISOString();
    if (existing) {
      ctx.sqlite
        .prepare(
          `UPDATE write_intents SET globs_json = ?, symbols_json = ?, mode = ?,
             reason = ?, expires_at = ?, version = version + 1, updated_at = ? WHERE id = ?`,
        )
        .run(
          JSON.stringify(input.globs),
          JSON.stringify(input.symbols),
          input.mode,
          input.reason,
          expiresAt,
          now,
          id,
        );
    } else {
      ctx.sqlite
        .prepare(
          `INSERT INTO write_intents(
              id, project_id, task_id, session_id, globs_json, symbols_json, mode,
              reason, observed_changed_files_json, expires_at, version, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, 0, ?, ?)`,
        )
        .run(
          id,
          projectId,
          input.taskId,
          input.sessionId,
          JSON.stringify(input.globs),
          JSON.stringify(input.symbols),
          input.mode,
          input.reason,
          expiresAt,
          now,
          now,
        );
    }
    ctx.sqlite
      .prepare(
        `UPDATE write_conflicts SET status = 'RESOLVED', resolved_at = ?
           WHERE status = 'OPEN' AND (left_intent_id = ? OR right_intent_id = ?)`,
      )
      .run(now, id, id);
    const root = projectRoot(ctx, projectId, session.cwd);
    const files = listTrackedFiles(root);
    const project = getProject(ctx, projectId);
    const config = ProjectConfigSchema.parse({
      ...DEFAULT_PROJECT_CONFIG,
      ...project.config,
    });
    const current = intentFromRow(
      ctx.sqlite.prepare("SELECT * FROM write_intents WHERE id = ?").get(id),
    );
    const peers = (
      ctx.sqlite
        .prepare(
          `SELECT * FROM write_intents
             WHERE project_id = ? AND id != ? AND released_at IS NULL AND expires_at > ?`,
        )
        .all(projectId, id, now) as any[]
    ).map(intentFromRow);
    const conflictIds: string[] = [];
    for (const peer of peers) {
      const overlap = detectIntentOverlap(current, peer, files, config.protectedGlobs);
      if (!overlap) continue;
      const [left, right] = [id, peer.id].sort();
      const conflictId = createId("cfl");
      ctx.sqlite
        .prepare(
          `INSERT INTO write_conflicts(
              id, project_id, left_intent_id, right_intent_id, severity, overlap_json,
              reason, status, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'OPEN', ?)
            ON CONFLICT(left_intent_id, right_intent_id) DO UPDATE SET
              severity = excluded.severity, overlap_json = excluded.overlap_json,
              reason = excluded.reason, status = 'OPEN', resolved_at = NULL`,
        )
        .run(
          conflictId,
          projectId,
          left,
          right,
          overlap.severity,
          JSON.stringify({ files: overlap.files, symbols: overlap.symbols }),
          overlap.reason,
          now,
        );
      const actual = ctx.sqlite
        .prepare("SELECT id FROM write_conflicts WHERE left_intent_id = ? AND right_intent_id = ?")
        .get(left, right) as { id: string };
      conflictIds.push(actual.id);
      emit({
        projectId,
        type: "write_conflict.detected",
        actorType: "system",
        actorId: "intent-overlap",
        aggregateType: "write_conflict",
        aggregateId: actual.id,
        causationId: null,
        correlationId: input.taskId,
        payload: {
          leftIntentId: left,
          rightIntentId: right,
          severity: overlap.severity,
          files: overlap.files,
          symbols: overlap.symbols,
          reason: overlap.reason,
        },
      });
    }
    emit({
      projectId,
      type: existing ? "write_intent.updated" : "write_intent.created",
      actorType: "agent",
      actorId: session.agentId,
      aggregateType: "write_intent",
      aggregateId: id,
      causationId: null,
      correlationId: input.taskId,
      payload: {
        taskId: input.taskId,
        globs: input.globs,
        symbols: input.symbols,
        mode: input.mode,
      },
    });
    return {
      intent: intentFromRow(ctx.sqlite.prepare("SELECT * FROM write_intents WHERE id = ?").get(id)),
      conflicts: conflictIds.map((conflictId) => getConflict(ctx, conflictId)),
    };
  });
}

export function releaseWriteIntent(
  ctx: StoreContext,
  principal: RequestPrincipal,
  intentId: string,
  input: { sessionId?: string; force?: boolean; idempotencyKey: string },
): WriteIntent {
  const row = ctx.sqlite.prepare("SELECT * FROM write_intents WHERE id = ?").get(intentId);
  if (!row) throw new NotFoundError("Write intent", intentId);
  const current = intentFromRow(row);
  if (input.force) assertDashboardMutation(principal);
  const actor = resolveMutationActor(ctx, principal, current.projectId, input.sessionId);
  return ctx.mutate(
    current.projectId,
    input.idempotencyKey,
    "write_intent.release",
    ({ emit }) => {
      if (!input.force && input.sessionId !== current.sessionId) {
        throw new ForbiddenError("Only the owner can release this write intent");
      }
      const now = nowIso();
      ctx.sqlite
        .prepare(
          "UPDATE write_intents SET released_at = ?, version = version + 1, updated_at = ? WHERE id = ?",
        )
        .run(now, now, intentId);
      ctx.sqlite
        .prepare(
          `UPDATE write_conflicts SET status = 'RESOLVED', resolved_at = ?
             WHERE status = 'OPEN' AND (left_intent_id = ? OR right_intent_id = ?)`,
        )
        .run(now, intentId, intentId);
      emit({
        projectId: current.projectId,
        type: "write_intent.released",
        actorType: actor.actorType,
        actorId: actor.actorId,
        aggregateType: "write_intent",
        aggregateId: intentId,
        causationId: null,
        correlationId: current.taskId,
        payload: { force: Boolean(input.force) },
      });
      return intentFromRow(
        ctx.sqlite.prepare("SELECT * FROM write_intents WHERE id = ?").get(intentId),
      );
    },
    mutationOptions(actor, { intentId, ...input, idempotencyKey: undefined }),
  );
}

export function reconcileObservedChanges(
  ctx: StoreContext,
  sessionId: string,
): {
  files: string[];
  undeclared: string[];
  protectedUndeclared: string[];
} {
  const session = getOpenSession(ctx, sessionId);
  const root = projectRoot(ctx, session.projectId, session.cwd);
  const files = observedChangedFiles(root);
  const intents = (
    ctx.sqlite
      .prepare(
        `SELECT * FROM write_intents WHERE session_id = ? AND released_at IS NULL AND expires_at > ?`,
      )
      .all(sessionId, nowIso()) as any[]
  ).map(intentFromRow);
  const declaredGlobs = intents.flatMap((intent) => intent.globs);
  const isDeclared = (file: string) =>
    declaredGlobs.some((glob) =>
      picomatch.isMatch(file, glob.replaceAll("\\", "/"), { dot: true }),
    );
  const undeclared = files.filter((file) => !isDeclared(file));
  const project = getProject(ctx, session.projectId);
  const config = ProjectConfigSchema.parse({
    ...DEFAULT_PROJECT_CONFIG,
    ...project.config,
  });
  const protectedUndeclared = undeclared.filter((file) =>
    config.protectedGlobs.some((glob) =>
      picomatch.isMatch(file, glob.replaceAll("\\", "/"), { dot: true }),
    ),
  );
  let event: DomainEvent | null = null;
  ctx.sqlite.transaction(() => {
    ctx.sqlite
      .prepare(
        "UPDATE agent_sessions SET active_files_json = ?, git_head = ?, version = version + 1 WHERE id = ?",
      )
      .run(JSON.stringify(files), readGitState(root).head, sessionId);
    ctx.sqlite
      .prepare(
        `UPDATE write_intents SET observed_changed_files_json = ?, version = version + 1,
           updated_at = ? WHERE session_id = ? AND released_at IS NULL`,
      )
      .run(JSON.stringify(files), nowIso(), sessionId);
    if (undeclared.length > 0) {
      event = ctx.appendEvent({
        projectId: session.projectId,
        type: "write_scope.observed_outside_intent",
        actorType: "system",
        actorId: "git-observer",
        aggregateType: "session",
        aggregateId: sessionId,
        causationId: null,
        correlationId: session.currentTaskId,
        payload: { undeclared, protectedUndeclared },
      });
    }
  })();
  if (event) ctx.bus.publish(event);
  return { files, undeclared, protectedUndeclared };
}

export function getConflict(ctx: StoreContext, conflictId: string): ConflictView {
  const row = ctx.sqlite
    .prepare(
      `SELECT c.*,
          li.session_id AS left_session_id, li.task_id AS left_task_id,
          li.globs_json AS left_globs_json, li.symbols_json AS left_symbols_json,
          ri.session_id AS right_session_id, ri.task_id AS right_task_id,
          ri.globs_json AS right_globs_json, ri.symbols_json AS right_symbols_json,
          ls.agent_id AS left_agent_id, rs.agent_id AS right_agent_id
         FROM write_conflicts c
         JOIN write_intents li ON li.id = c.left_intent_id
         JOIN write_intents ri ON ri.id = c.right_intent_id
         JOIN agent_sessions ls ON ls.id = li.session_id
         JOIN agent_sessions rs ON rs.id = ri.session_id
         WHERE c.id = ?`,
    )
    .get(conflictId) as any;
  if (!row) throw new NotFoundError("Write conflict", conflictId);
  const overlap = json<{ files?: string[]; symbols?: string[] }>(row.overlap_json, {});
  return {
    id: row.id,
    projectId: row.project_id,
    leftIntentId: row.left_intent_id,
    rightIntentId: row.right_intent_id,
    left_session_id: row.left_session_id,
    right_session_id: row.right_session_id,
    left_task_id: row.left_task_id,
    right_task_id: row.right_task_id,
    left: {
      agentId: row.left_agent_id,
      sessionId: row.left_session_id,
      taskId: row.left_task_id,
      globs: json(row.left_globs_json, []),
      symbols: json(row.left_symbols_json, []),
    },
    right: {
      agentId: row.right_agent_id,
      sessionId: row.right_session_id,
      taskId: row.right_task_id,
      globs: json(row.right_globs_json, []),
      symbols: json(row.right_symbols_json, []),
    },
    severity: row.severity,
    overlap,
    overlapFiles: overlap.files ?? [],
    overlapSymbols: overlap.symbols ?? [],
    reason: row.reason,
    status: row.status,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

export function listConflicts(
  ctx: StoreContext,
  projectId: string,
  status?: string,
): ConflictView[] {
  const rows = ctx.sqlite
    .prepare(
      `SELECT id FROM write_conflicts WHERE project_id = ?
         ${status ? "AND status = ?" : ""} ORDER BY created_at DESC`,
    )
    .all(...(status ? [projectId, status] : [projectId])) as Array<{ id: string }>;
  return rows.map((row) => getConflict(ctx, row.id));
}

export function resolveConflict(
  ctx: StoreContext,
  principal: RequestPrincipal,
  conflictId: string,
  input: { reason: string; idempotencyKey: string },
): ConflictView {
  const current = getConflict(ctx, conflictId);
  assertDashboardMutation(principal);
  const actor = resolveMutationActor(ctx, principal, current.projectId);
  return ctx.mutate(
    current.projectId,
    input.idempotencyKey,
    "write_conflict.resolve",
    ({ emit }) => {
      ctx.sqlite
        .prepare("UPDATE write_conflicts SET status = 'RESOLVED', resolved_at = ? WHERE id = ?")
        .run(nowIso(), conflictId);
      emit({
        projectId: current.projectId,
        type: "write_conflict.resolved",
        actorType: actor.actorType,
        actorId: actor.actorId,
        aggregateType: "write_conflict",
        aggregateId: conflictId,
        causationId: null,
        correlationId: null,
        payload: { reason: input.reason },
      });
      return getConflict(ctx, conflictId);
    },
    mutationOptions(actor, { conflictId, ...input, idempotencyKey: undefined }),
  );
}
