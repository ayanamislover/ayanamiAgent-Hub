// Tasks and todos are one module because they are one aggregate. The class's call graph had exactly
// one true cycle in it -- listTasks and assertTaskCompletionGate reach for todos, while createTodo
// and recomputeProgress reach back for the owning task -- and that cycle is not a design flaw to be
// broken, it is the shape of a task and its checklist. Splitting them would have put a write in one
// module and the rule governing it in another.

import {
  assertTaskTransition,
  computeTaskProgress,
  createId,
  nowIso,
  type Task,
  type TaskStatus,
  type TodoItem,
} from "@crossagent/protocol";
import { ConflictError, ForbiddenError, NotFoundError } from "../../domain/errors.js";
import type { RequestPrincipal } from "../../security/local-auth.js";
import { bool, json, mutationFingerprint, type StoreContext } from "./context.js";
import { findingFromRow } from "./rows.js";
import { getOpenSession, getSession } from "./sessions.js";
import { postMessage } from "./messages.js";
import { mutationOptions, resolveMutationActor } from "./mutation-authority.js";

function taskFromRow(row: any, dependencies: string[] = []): Task {
  return {
    id: row.id,
    projectId: row.project_id,
    objectiveId: row.objective_id,
    milestoneId: row.milestone_id,
    parentTaskId: row.parent_task_id,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    ownerAgentId: row.owner_agent_id,
    ownerSessionId: row.owner_session_id,
    reviewerAgentId: row.reviewer_agent_id,
    capabilityTags: json(row.capability_tags_json, []),
    scopeGlobs: json(row.scope_globs_json, []),
    protectedScope: bool(row.protected_scope),
    reviewRequired: bool(row.review_required),
    dependsOn: dependencies,
    blockedReason: row.blocked_reason,
    waitingFor: row.waiting_for,
    baseSha: row.base_sha,
    headSha: row.head_sha,
    selfReportedSummary: row.self_reported_summary,
    agentEstimate: row.agent_estimate,
    computedProgress: row.computed_progress,
    weight: row.weight,
    claimStaleAt: row.claim_stale_at,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  } as Task;
}

function todoFromRow(row: any): TodoItem {
  return {
    id: row.id,
    taskId: row.task_id,
    title: row.title,
    description: row.description,
    type: row.type,
    status: row.status,
    weight: row.weight,
    evidenceRequired: bool(row.evidence_required),
    evidence: json(row.evidence_json, []),
    completedBySessionId: row.completed_by_session_id,
    completedAt: row.completed_at,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  } as TodoItem;
}

function dependenciesForTask(ctx: StoreContext, taskId: string): string[] {
  return (
    ctx.sqlite
      .prepare(
        "SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ? ORDER BY depends_on_task_id",
      )
      .all(taskId) as Array<{ depends_on_task_id: string }>
  ).map((row) => row.depends_on_task_id);
}

export function getTask(ctx: StoreContext, taskId: string): Task {
  const row = ctx.sqlite.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
  if (!row) throw new NotFoundError("Task", taskId);
  return taskFromRow(row, dependenciesForTask(ctx, taskId));
}

export function listTasks(
  ctx: StoreContext,
  projectId: string,
  filters: { status?: string; ownerAgentId?: string; readyOnly?: boolean } = {},
): Array<Task & { todos: TodoItem[]; dependencyReady: boolean }> {
  const clauses = ["project_id = ?"];
  const params: unknown[] = [projectId];
  if (filters.status) {
    clauses.push("status = ?");
    params.push(filters.status);
  }
  if (filters.ownerAgentId) {
    clauses.push("owner_agent_id = ?");
    params.push(filters.ownerAgentId);
  }
  const rows = ctx.sqlite
    .prepare(
      `SELECT * FROM tasks WHERE ${clauses.join(" AND ")}
         ORDER BY
          CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
          created_at`,
    )
    .all(...params) as any[];
  return rows
    .map((row) => {
      const dependencies = dependenciesForTask(ctx, row.id);
      const dependencyReady = dependencies.every((dependencyId) => {
        const dependency = ctx.sqlite
          .prepare("SELECT status FROM tasks WHERE id = ?")
          .get(dependencyId) as { status: string } | undefined;
        return dependency?.status === "DONE";
      });
      return {
        ...taskFromRow(row, dependencies),
        todos: listTodos(ctx, row.id),
        dependencyReady,
      };
    })
    .filter((task) => !filters.readyOnly || (task.dependencyReady && !task.ownerSessionId));
}

export function createTask(
  ctx: StoreContext,
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
  const actor = resolveMutationActor(ctx, principal, projectId);
  return ctx.mutate(
    projectId,
    input.idempotencyKey,
    "task.create",
    ({ emit }) => {
      for (const dependencyId of input.dependsOn) {
        const dependency = getTask(ctx, dependencyId);
        if (dependency.projectId !== projectId) {
          throw new ForbiddenError("Task dependency belongs to a different project");
        }
      }
      const id = createId("tsk");
      const now = nowIso();
      const status =
        input.status === "READY" &&
        input.dependsOn.some((dependencyId) => getTask(ctx, dependencyId).status !== "DONE")
          ? "BACKLOG"
          : input.status;
      ctx.sqlite
        .prepare(
          `INSERT INTO tasks(
            id, project_id, objective_id, milestone_id, parent_task_id, title, description,
            status, priority, reviewer_agent_id, capability_tags_json, scope_globs_json,
            protected_scope, review_required, computed_progress, weight, version, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 0, ?, ?)`,
        )
        .run(
          id,
          projectId,
          input.objectiveId,
          input.milestoneId ?? null,
          input.parentTaskId ?? null,
          input.title,
          input.description,
          status,
          input.priority,
          input.reviewerAgentId ?? null,
          JSON.stringify(input.capabilityTags),
          JSON.stringify(input.scopeGlobs),
          input.protectedScope ? 1 : 0,
          input.reviewRequired ? 1 : 0,
          input.weight,
          now,
          now,
        );
      const dependencyInsert = ctx.sqlite.prepare(
        "INSERT INTO task_dependencies(task_id, depends_on_task_id) VALUES (?, ?)",
      );
      for (const dependencyId of input.dependsOn) dependencyInsert.run(id, dependencyId);
      emit({
        projectId,
        type: "task.created",
        actorType: actor.actorType,
        actorId: actor.actorId,
        aggregateType: "task",
        aggregateId: id,
        causationId: null,
        correlationId: null,
        payload: {
          title: input.title,
          status,
          priority: input.priority,
          dependsOn: input.dependsOn,
        },
      });
      return getTask(ctx, id);
    },
    mutationOptions(actor, { projectId, ...input, idempotencyKey: undefined }),
  );
}

export function splitTask(
  ctx: StoreContext,
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
): Task[] {
  const parent = getTask(ctx, taskId);
  return ctx.mutate(parent.projectId, input.idempotencyKey, "task.split", ({ emit }) => {
    const current = getTask(ctx, taskId);
    if (current.version !== input.expectedVersion) {
      throw new ConflictError("Task version changed", current);
    }
    const session = getSession(ctx, input.sessionId);
    const now = nowIso();
    const children: Task[] = [];
    for (const child of input.children) {
      const id = createId("tsk");
      ctx.sqlite
        .prepare(
          `INSERT INTO tasks(
              id, project_id, objective_id, milestone_id, parent_task_id, title, description,
              status, priority, reviewer_agent_id, capability_tags_json, scope_globs_json,
              protected_scope, review_required, computed_progress, weight, version, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'READY', ?, ?, ?, ?, ?, ?, 0, ?, 0, ?, ?)`,
        )
        .run(
          id,
          parent.projectId,
          parent.objectiveId,
          parent.milestoneId,
          parent.id,
          child.title,
          child.description ?? "",
          parent.priority,
          parent.reviewerAgentId,
          JSON.stringify(child.capabilityTags ?? parent.capabilityTags),
          JSON.stringify(child.scopeGlobs ?? []),
          parent.protectedScope ? 1 : 0,
          parent.reviewRequired ? 1 : 0,
          child.weight ?? 1,
          now,
          now,
        );
      children.push(getTask(ctx, id));
    }
    ctx.sqlite
      .prepare(
        "UPDATE tasks SET status = 'BLOCKED', blocked_reason = ?, version = version + 1, updated_at = ? WHERE id = ?",
      )
      .run(`Split into ${children.length} child tasks`, now, taskId);
    emit({
      projectId: parent.projectId,
      type: "task.split",
      actorType: "agent",
      actorId: session.agentId,
      aggregateType: "task",
      aggregateId: taskId,
      causationId: null,
      correlationId: null,
      payload: { childTaskIds: children.map((child) => child.id) },
    });
    return children;
  });
}

export function updateTask(
  ctx: StoreContext,
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
  const before = getTask(ctx, taskId);
  const actor = resolveMutationActor(ctx, principal, before.projectId, input.sessionId);
  return ctx.mutate(
    before.projectId,
    input.idempotencyKey,
    "task.update",
    ({ emit }) => {
      const current = getTask(ctx, taskId);
      if (current.version !== input.expectedVersion) {
        throw new ConflictError("Task version changed", current);
      }
      if (input.status) {
        assertTaskTransition(current.status, input.status);
        if (input.status === "DONE") assertTaskCompletionGate(ctx, current);
      }
      const updates: string[] = [];
      const params: unknown[] = [];
      const fields: Array<[keyof typeof input, string, (value: any) => any]> = [
        ["status", "status", (value) => value],
        ["title", "title", (value) => value],
        ["description", "description", (value) => value],
        ["blockedReason", "blocked_reason", (value) => value],
        ["waitingFor", "waiting_for", (value) => value],
        ["selfReportedSummary", "self_reported_summary", (value) => value],
        ["agentEstimate", "agent_estimate", (value) => value],
        ["reviewerAgentId", "reviewer_agent_id", (value) => value],
        ["scopeGlobs", "scope_globs_json", (value) => JSON.stringify(value)],
        ["capabilityTags", "capability_tags_json", (value) => JSON.stringify(value)],
      ];
      for (const [key, column, map] of fields) {
        if (key in input && input[key] !== undefined) {
          updates.push(`${column} = ?`);
          params.push(map(input[key]));
        }
      }
      if (updates.length === 0) return current;
      updates.push("version = version + 1", "updated_at = ?");
      params.push(nowIso(), taskId);
      ctx.sqlite.prepare(`UPDATE tasks SET ${updates.join(", ")} WHERE id = ?`).run(...params);
      emit({
        projectId: current.projectId,
        type: "task.updated",
        actorType: actor.actorType,
        actorId: actor.actorId,
        aggregateType: "task",
        aggregateId: taskId,
        causationId: null,
        correlationId: null,
        payload: {
          changed: updates.filter(
            (value) => !value.startsWith("version") && !value.startsWith("updated"),
          ),
          previousStatus: current.status,
          status: input.status ?? current.status,
        },
      });
      return getTask(ctx, taskId);
    },
    mutationOptions(actor, { taskId, ...input, idempotencyKey: undefined }),
  );
}

export function claimTask(
  ctx: StoreContext,
  taskId: string,
  input: {
    sessionId: string;
    expectedVersion: number;
    takeoverStale: boolean;
    idempotencyKey: string;
  },
): Task {
  const task = getTask(ctx, taskId);
  return ctx.mutate(task.projectId, input.idempotencyKey, "task.claim", ({ emit }) => {
    const current = getTask(ctx, taskId);
    const session = getSession(ctx, input.sessionId);
    if (session.projectId !== current.projectId) {
      throw new ForbiddenError("Session and task belong to different projects");
    }
    if (current.version !== input.expectedVersion) {
      throw new ConflictError("Task version changed", current);
    }
    if (!["READY", "BACKLOG"].includes(current.status)) {
      throw new ConflictError(`Task cannot be claimed from ${current.status}`, current);
    }
    const dependenciesReady = current.dependsOn.every(
      (dependencyId) => getTask(ctx, dependencyId).status === "DONE",
    );
    if (!dependenciesReady) {
      throw new ConflictError("Task dependencies are not complete", current);
    }
    if (current.ownerSessionId) {
      const stale = Boolean(current.claimStaleAt);
      if (!stale || !input.takeoverStale) {
        throw new ConflictError("Task is already owned", current);
      }
    }
    const now = nowIso();
    ctx.sqlite
      .prepare(
        `UPDATE tasks SET status = 'CLAIMED', owner_agent_id = ?, owner_session_id = ?,
           claim_stale_at = NULL, version = version + 1, updated_at = ? WHERE id = ?`,
      )
      .run(session.agentId, session.id, now, taskId);
    ctx.sqlite
      .prepare(
        `UPDATE agent_sessions SET current_task_id = ?, work_state = 'PLANNING',
           version = version + 1 WHERE id = ?`,
      )
      .run(taskId, session.id);
    emit({
      projectId: current.projectId,
      type: "task.claimed",
      actorType: "agent",
      actorId: session.agentId,
      aggregateType: "task",
      aggregateId: taskId,
      causationId: null,
      correlationId: null,
      payload: {
        sessionId: session.id,
        takeoverStale: input.takeoverStale,
      },
    });
    return getTask(ctx, taskId);
  });
}

export function releaseTask(
  ctx: StoreContext,
  taskId: string,
  input: { sessionId: string; expectedVersion: number; idempotencyKey: string },
): Task {
  const task = getTask(ctx, taskId);
  return ctx.mutate(task.projectId, input.idempotencyKey, "task.release", ({ emit }) => {
    const current = getTask(ctx, taskId);
    const session = getSession(ctx, input.sessionId);
    if (current.version !== input.expectedVersion) {
      throw new ConflictError("Task version changed", current);
    }
    if (current.ownerSessionId !== session.id && !current.claimStaleAt) {
      throw new ForbiddenError("Only the owner or a stale-claim release may release this task");
    }
    ctx.sqlite
      .prepare(
        `UPDATE tasks SET status = 'READY', owner_agent_id = NULL, owner_session_id = NULL,
           claim_stale_at = NULL, version = version + 1, updated_at = ? WHERE id = ?`,
      )
      .run(nowIso(), taskId);
    ctx.sqlite
      .prepare(
        `UPDATE agent_sessions SET current_task_id = NULL, work_state = 'IDLE',
           version = version + 1 WHERE id = ?`,
      )
      .run(current.ownerSessionId);
    emit({
      projectId: current.projectId,
      type: "task.released",
      actorType: "agent",
      actorId: session.agentId,
      aggregateType: "task",
      aggregateId: taskId,
      causationId: null,
      correlationId: null,
      payload: { previousOwnerSessionId: current.ownerSessionId },
    });
    return getTask(ctx, taskId);
  });
}

export function handoffTask(
  ctx: StoreContext,
  taskId: string,
  input: {
    sessionId: string;
    expectedVersion: number;
    toAgentId: string;
    summary: string;
    idempotencyKey: string;
  },
): Task {
  const task = getTask(ctx, taskId);
  const owner = getOpenSession(ctx, input.sessionId);
  if (owner.projectId !== task.projectId) {
    throw new ForbiddenError("Task and owner session belong to different projects");
  }
  const result = ctx.mutate(
    task.projectId,
    input.idempotencyKey,
    "task.handoff",
    ({ emit }) => {
      const current = getTask(ctx, taskId);
      if (current.version !== input.expectedVersion) {
        throw new ConflictError("Task version changed", current);
      }
      if (current.ownerSessionId !== owner.id) {
        throw new ForbiddenError("Only the current owner can hand off a task");
      }
      ctx.sqlite
        .prepare(
          `UPDATE tasks SET status = 'WAITING_FOR_PEER', owner_agent_id = NULL,
             owner_session_id = NULL, waiting_for = ?, self_reported_summary = ?,
             version = version + 1, updated_at = ? WHERE id = ?`,
        )
        .run(input.toAgentId, input.summary, nowIso(), taskId);
      ctx.sqlite
        .prepare(
          "UPDATE agent_sessions SET current_task_id = NULL, work_state = 'IDLE', version = version + 1 WHERE id = ?",
        )
        .run(owner.id);
      emit({
        projectId: current.projectId,
        type: "task.handed_off",
        actorType: "agent",
        actorId: owner.agentId,
        aggregateType: "task",
        aggregateId: taskId,
        causationId: null,
        correlationId: null,
        payload: { toAgentId: input.toAgentId, summary: input.summary },
      });
      const handedOff = getTask(ctx, taskId);
      postMessage(ctx, task.projectId, {
        taskId,
        fromAgentId: owner.agentId,
        fromSessionId: input.sessionId,
        recipients: [{ agentId: input.toAgentId }],
        type: "HANDOFF",
        priority: "IMPORTANT",
        requiresAck: true,
        requiresResponse: false,
        summary: input.summary,
        references: [{ type: "task", id: taskId }],
        idempotencyKey: `${input.idempotencyKey}:message`,
      });
      return handedOff;
    },
    {
      requestFingerprint: mutationFingerprint({ taskId, ...input }),
      validateReplay: () => {
        const replayOwner = getOpenSession(ctx, input.sessionId);
        if (replayOwner.projectId !== task.projectId) {
          throw new ForbiddenError("Task and owner session belong to different projects");
        }
      },
    },
  );
  return result;
}

export function listTodos(ctx: StoreContext, taskId: string): TodoItem[] {
  return ctx.sqlite
    .prepare("SELECT * FROM todo_items WHERE task_id = ? ORDER BY created_at")
    .all(taskId)
    .map(todoFromRow);
}

export function createTodo(
  ctx: StoreContext,
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
  const task = getTask(ctx, taskId);
  const actor = resolveMutationActor(ctx, principal, task.projectId, input.sessionId);
  return ctx.mutate(
    task.projectId,
    input.idempotencyKey,
    "todo.create",
    ({ emit }) => {
      const id = createId("todo");
      const now = nowIso();
      ctx.sqlite
        .prepare(
          `INSERT INTO todo_items(
            id, task_id, title, description, type, status, weight, evidence_required,
            evidence_json, version, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 'TODO', ?, ?, '[]', 0, ?, ?)`,
        )
        .run(
          id,
          taskId,
          input.title,
          input.description ?? null,
          input.type,
          input.weight,
          input.evidenceRequired ? 1 : 0,
          now,
          now,
        );
      recomputeProgress(ctx, taskId);
      emit({
        projectId: task.projectId,
        type: "todo.created",
        actorType: actor.actorType,
        actorId: actor.actorId,
        aggregateType: "todo",
        aggregateId: id,
        causationId: null,
        correlationId: taskId,
        payload: { taskId, title: input.title, type: input.type },
      });
      return todoFromRow(ctx.sqlite.prepare("SELECT * FROM todo_items WHERE id = ?").get(id));
    },
    mutationOptions(actor, { taskId, ...input, idempotencyKey: undefined }),
  );
}

export function updateTodo(
  ctx: StoreContext,
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
  const row = ctx.sqlite
    .prepare(
      "SELECT t.project_id, i.* FROM todo_items i JOIN tasks t ON t.id = i.task_id WHERE i.id = ?",
    )
    .get(todoId) as any;
  if (!row) throw new NotFoundError("Todo", todoId);
  const actor = resolveMutationActor(ctx, principal, row.project_id, input.completedBySessionId);
  return ctx.mutate(
    row.project_id,
    input.idempotencyKey,
    "todo.update",
    ({ emit }) => {
      const current = todoFromRow(
        ctx.sqlite.prepare("SELECT * FROM todo_items WHERE id = ?").get(todoId),
      );
      if (current.version !== input.expectedVersion) {
        throw new ConflictError("Todo version changed", current);
      }
      const evidence = input.evidence ?? current.evidence;
      if (input.status === "DONE" && current.evidenceRequired && evidence.length === 0) {
        throw new ConflictError("Todo requires evidence before completion", current);
      }
      const completedAt = input.status === "DONE" ? nowIso() : null;
      ctx.sqlite
        .prepare(
          `UPDATE todo_items SET status = ?, evidence_json = ?, completed_by_session_id = ?,
           completed_at = ?, version = version + 1, updated_at = ? WHERE id = ?`,
        )
        .run(
          input.status,
          JSON.stringify(evidence),
          input.completedBySessionId ?? null,
          completedAt,
          nowIso(),
          todoId,
        );
      recomputeProgress(ctx, current.taskId);
      emit({
        projectId: row.project_id,
        type: "todo.updated",
        actorType: actor.actorType,
        actorId: actor.actorId,
        aggregateType: "todo",
        aggregateId: todoId,
        causationId: null,
        correlationId: current.taskId,
        payload: { taskId: current.taskId, previousStatus: current.status, status: input.status },
      });
      return todoFromRow(ctx.sqlite.prepare("SELECT * FROM todo_items WHERE id = ?").get(todoId));
    },
    mutationOptions(actor, { todoId, ...input, idempotencyKey: undefined }),
  );
}

/**
 * Task progress is derived partly from review state, which is why this reads the reviews tables
 * directly rather than going through the reviews module: doing it the other way would point the
 * dependency from tasks at reviews, and reviews already depends on tasks.
 */
export function recomputeProgress(ctx: StoreContext, taskId: string): number {
  const task = getTask(ctx, taskId);
  const latestReview = ctx.sqlite
    .prepare("SELECT * FROM reviews WHERE task_id = ? ORDER BY revision DESC LIMIT 1")
    .get(taskId) as any;
  const findings = latestReview
    ? (
        ctx.sqlite
          .prepare("SELECT * FROM review_findings WHERE review_id = ?")
          .all(latestReview.id) as any[]
      ).map(findingFromRow)
    : [];
  const progress = computeTaskProgress(
    listTodos(ctx, taskId),
    task.reviewRequired,
    latestReview?.status === "APPROVED",
    findings,
  );
  ctx.sqlite
    .prepare("UPDATE tasks SET computed_progress = ?, updated_at = ? WHERE id = ?")
    .run(progress, nowIso(), taskId);
  return progress;
}

export function assertTaskCompletionGate(ctx: StoreContext, task: Task): void {
  const todos = listTodos(ctx, task.id);
  const requiredIncomplete = todos.filter(
    (todo) => todo.status !== "DONE" && todo.status !== "SKIPPED",
  );
  if (requiredIncomplete.length > 0) {
    throw new ConflictError("Task has incomplete TODO items", task);
  }
  if (!task.reviewRequired) return;
  const review = ctx.sqlite
    .prepare("SELECT * FROM reviews WHERE task_id = ? ORDER BY revision DESC LIMIT 1")
    .get(task.id) as any;
  if (!review || review.status !== "APPROVED") {
    throw new ConflictError("Task requires an approved review", task);
  }
  const blocking = ctx.sqlite
    .prepare(
      `SELECT COUNT(*) AS count FROM review_findings
         WHERE review_id = ? AND blocking = 1 AND status NOT IN ('VERIFIED', 'WONT_FIX')`,
    )
    .get(review.id) as { count: number };
  if (blocking.count > 0) {
    throw new ConflictError("Task has unresolved blocking review findings", task);
  }
}
