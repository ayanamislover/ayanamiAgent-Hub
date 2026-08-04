import {
  assertTaskTransition,
  createId,
  nowIso,
  type ReviewBundle,
  type ReviewFinding,
} from "@crossagent/protocol";
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { createReviewPatch, saveArtifact } from "../../git/git-service.js";
import { ConflictError, ForbiddenError, HubError, NotFoundError } from "../../domain/errors.js";
import { json, mutationFingerprint, type StoreContext } from "./context.js";
import { findingFromRow } from "./rows.js";
import { getOpenSession, getSession } from "./sessions.js";
import { postMessage } from "./messages.js";
import { assertTaskCompletionGate, getTask, listTodos, recomputeProgress } from "./tasks.js";
import { resolveProjectRoot } from "./write-intents.js";

function reviewFromRow(row: any): ReviewBundle {
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    revision: row.revision,
    authorAgentId: row.author_agent_id,
    authorSessionId: row.author_session_id,
    reviewerAgentId: row.reviewer_agent_id,
    baseSha: row.base_sha,
    headSha: row.head_sha,
    patchSha256: row.patch_sha256,
    patchArtifactId: row.patch_artifact_id,
    changedFiles: json(row.changed_files_json, []),
    acceptanceCriteria: json(row.acceptance_criteria_json, []),
    testEvidence: json(row.test_evidence_json, []),
    authorClaims: json(row.author_claims_json, []),
    knownRisks: json(row.known_risks_json, []),
    status: row.status,
    verdictSummary: row.verdict_summary,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  } as ReviewBundle;
}

/**
 * Resolves a session and asserts it belongs to the same project as the review it is acting on.
 *
 * Comparing `session.agentId` against `reviewerAgentId` is not sufficient on its own. Agent ids are
 * unique per project, not globally -- the same "codex" and "claude" exist in every project at once --
 * so an id match does not establish that the caller is a participant here. Without this check a
 * session in one project could begin, annotate and rule on another project's review, and an APPROVED
 * verdict is precisely what lets the author move the task to DONE.
 */
function sessionInProject(ctx: StoreContext, sessionId: string, projectId: string) {
  const session = getOpenSession(ctx, sessionId);
  if (session.projectId !== projectId) {
    throw new ForbiddenError("Session and review belong to different projects");
  }
  return session;
}

function assertLatestActiveReview(
  ctx: StoreContext,
  review: ReviewBundle,
  allowedStatuses: ReadonlyArray<ReviewBundle["status"]>,
) {
  const active = ctx.sqlite
    .prepare(
      `SELECT id, status
         FROM reviews
        WHERE task_id = ?
          AND status IN ('PENDING', 'DELIVERED', 'IN_REVIEW', 'CHANGES_REQUESTED')
        ORDER BY revision DESC, id DESC
        LIMIT 2`,
    )
    .all(review.taskId) as Array<{ id: string; status: ReviewBundle["status"] }>;
  if (active.length > 1) {
    throw new ConflictError("Task has multiple active reviews", {
      taskId: review.taskId,
      reviewIds: active.map((candidate) => candidate.id),
    });
  }
  const latest = active[0];
  if (!latest || latest.id !== review.id) {
    throw new ConflictError("Only the latest active review can be mutated", review);
  }
  if (!allowedStatuses.includes(review.status)) {
    throw new ConflictError(`Review cannot be mutated from status ${review.status}`, review);
  }
}

function assertAtMostOneActiveReview(ctx: StoreContext, taskId: string): void {
  const active = ctx.sqlite
    .prepare(
      `SELECT id
         FROM reviews
        WHERE task_id = ?
          AND status IN ('PENDING', 'DELIVERED', 'IN_REVIEW', 'CHANGES_REQUESTED')
        ORDER BY revision DESC, id DESC
        LIMIT 2`,
    )
    .all(taskId) as Array<{ id: string }>;
  if (active.length > 1) {
    throw new ConflictError("Task has multiple active reviews", {
      taskId,
      reviewIds: active.map((candidate) => candidate.id),
    });
  }
}

function currentAuthorProjectionSessionId(ctx: StoreContext, review: ReviewBundle): string {
  const author = getSession(ctx, review.authorSessionId);
  if (author.projectId !== review.projectId || author.agentId !== review.authorAgentId) {
    throw new ConflictError("Immutable review author does not match the review", review);
  }
  if (!author.lineageId) return author.id;

  const lineage = ctx.sqlite
    .prepare(
      `SELECT head_session_id
         FROM session_lineages
        WHERE id = ? AND project_id = ? AND agent_id = ?`,
    )
    .get(author.lineageId, review.projectId, review.authorAgentId) as
    { head_session_id: string | null } | undefined;
  if (!lineage?.head_session_id) {
    throw new ConflictError("Review author lineage has no current head", review);
  }
  const head = getSession(ctx, lineage.head_session_id);
  if (
    head.lineageId !== author.lineageId ||
    head.projectId !== review.projectId ||
    head.agentId !== review.authorAgentId
  ) {
    throw new ConflictError("Review author lineage head does not match the review", review);
  }
  return head.id;
}

function reviewMutationFingerprint(resource: Record<string, unknown>, input: object): string {
  return mutationFingerprint({ ...resource, ...input, idempotencyKey: undefined });
}

function assignedReviewerSession(ctx: StoreContext, review: ReviewBundle, sessionId: string) {
  const session = sessionInProject(ctx, sessionId, review.projectId);
  if (session.agentId !== review.reviewerAgentId) {
    throw new ForbiddenError("Session is not the assigned reviewer");
  }
  return session;
}

function assertFindingResolutionRole(
  session: ReturnType<typeof sessionInProject>,
  review: ReviewBundle,
  status: "ACCEPTED" | "DISPUTED" | "FIXED" | "VERIFIED" | "WONT_FIX",
): void {
  if (["VERIFIED", "WONT_FIX"].includes(status)) {
    if (session.agentId !== review.reviewerAgentId) {
      throw new ForbiddenError("Only the reviewer can verify or waive a finding");
    }
    return;
  }
  if (session.agentId !== review.authorAgentId) {
    throw new ForbiddenError("Only the author can respond to this finding");
  }
}

export function requestReview(
  ctx: StoreContext,
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
): ReviewBundle {
  const task = getTask(ctx, taskId);
  const session = getOpenSession(ctx, input.sessionId);
  if (task.ownerSessionId !== session.id) {
    throw new ForbiddenError("Only the task owner can request review");
  }
  const incomplete = listTodos(ctx, taskId).filter(
    (todo) => todo.status !== "DONE" && todo.status !== "SKIPPED",
  );
  if (incomplete.length > 0) {
    throw new ConflictError("All non-skipped TODO items must be complete before review", task);
  }
  const root = resolveProjectRoot(ctx, task.projectId, session.cwd);
  // The task's own scope bounds what uncommitted work may enter the snapshot. Without this the
  // review froze the whole working tree and the declared scope was silently ignored.
  const patchData = createReviewPatch(
    root,
    input.baseSha,
    input.headSha,
    input.includeUncommitted,
    task.scopeGlobs,
  );
  const reviewId = createId("rev");
  const artifactId = createId("art");
  let artifactStoragePath: string | null = null;
  let review: ReviewBundle;
  try {
    review = ctx.mutate(
      task.projectId,
      input.idempotencyKey,
      "review.request",
      ({ emit }) => {
        assertAtMostOneActiveReview(ctx, taskId);
        const artifact = saveArtifact(
          ctx.options.dataDir,
          task.projectId,
          artifactId,
          `${reviewId}.patch`,
          patchData.patch,
        );
        artifactStoragePath = artifact.storagePath;
        const previous = ctx.sqlite
          .prepare("SELECT * FROM reviews WHERE task_id = ? ORDER BY revision DESC LIMIT 1")
          .get(taskId) as any;
        const revision = previous ? previous.revision + 1 : 1;
        const now = nowIso();
        if (previous && previous.status !== "APPROVED") {
          ctx.sqlite
            .prepare(
              `UPDATE reviews SET status = 'SUPERSEDED', version = version + 1,
                 updated_at = ? WHERE id = ?`,
            )
            .run(now, previous.id);
        }
        ctx.sqlite
          .prepare(
            `INSERT INTO artifacts(
                id, project_id, task_id, review_id, kind, name, media_type, sha256,
                size_bytes, storage_path, metadata_json, created_by_session_id, created_at
              ) VALUES (?, ?, ?, ?, 'review_patch', ?, 'text/x-diff', ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            artifactId,
            task.projectId,
            taskId,
            reviewId,
            `${reviewId}.patch`,
            artifact.sha256,
            artifact.sizeBytes,
            artifact.storagePath,
            JSON.stringify({ includeUncommitted: input.includeUncommitted }),
            session.id,
            now,
          );
        ctx.sqlite
          .prepare(
            `INSERT INTO reviews(
                id, project_id, task_id, revision, author_agent_id, author_session_id,
                reviewer_agent_id, base_sha, head_sha, patch_sha256, patch_artifact_id,
                changed_files_json, acceptance_criteria_json, test_evidence_json,
                author_claims_json, known_risks_json, status, supersedes_review_id,
                version, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, 0, ?, ?)`,
          )
          .run(
            reviewId,
            task.projectId,
            taskId,
            revision,
            session.agentId,
            session.id,
            input.reviewerAgentId,
            input.baseSha,
            input.headSha,
            artifact.sha256,
            artifactId,
            JSON.stringify(patchData.changedFiles),
            JSON.stringify(input.acceptanceCriteria),
            JSON.stringify(input.testEvidence),
            JSON.stringify(input.authorClaims),
            JSON.stringify(input.knownRisks),
            previous?.id ?? null,
            now,
            now,
          );
        for (const evidence of input.testEvidence) {
          if (typeof evidence.command === "string" && typeof evidence.exitCode === "number") {
            ctx.sqlite
              .prepare(
                `INSERT INTO test_evidence(
                    id, review_id, command, exit_code, output_summary, created_at
                  ) VALUES (?, ?, ?, ?, ?, ?)`,
              )
              .run(
                createId("tst"),
                reviewId,
                evidence.command,
                evidence.exitCode,
                String(evidence.outputSummary ?? ""),
                now,
              );
          }
        }
        const currentTask = getTask(ctx, taskId);
        if (currentTask.status === "CLAIMED") {
          ctx.sqlite
            .prepare(
              "UPDATE tasks SET status = 'IN_PROGRESS', version = version + 1, updated_at = ? WHERE id = ?",
            )
            .run(now, taskId);
        }
        const taskForReview = getTask(ctx, taskId);
        assertTaskTransition(taskForReview.status, "REVIEW_PENDING");
        ctx.sqlite
          .prepare(
            `UPDATE tasks SET status = 'REVIEW_PENDING', base_sha = ?, head_sha = ?,
               reviewer_agent_id = ?, version = version + 1, updated_at = ? WHERE id = ?`,
          )
          .run(input.baseSha, input.headSha, input.reviewerAgentId, now, taskId);
        ctx.sqlite
          .prepare(
            `UPDATE agent_sessions SET work_state = 'WAITING_FOR_PEER',
               current_review_id = ?, version = version + 1 WHERE id = ?`,
          )
          .run(reviewId, session.id);
        emit({
          projectId: task.projectId,
          type: "review.requested",
          actorType: "agent",
          actorId: session.agentId,
          aggregateType: "review",
          aggregateId: reviewId,
          causationId: null,
          correlationId: taskId,
          payload: {
            taskId,
            revision,
            reviewerAgentId: input.reviewerAgentId,
            baseSha: input.baseSha,
            headSha: input.headSha,
            patchSha256: artifact.sha256,
            changedFiles: patchData.changedFiles,
          },
        });
        recomputeProgress(ctx, taskId);
        const requestedReview = reviewFromRow(
          ctx.sqlite.prepare("SELECT * FROM reviews WHERE id = ?").get(reviewId),
        );
        postMessage(ctx, task.projectId, {
          taskId,
          reviewId: requestedReview.id,
          fromAgentId: session.agentId,
          fromSessionId: session.id,
          recipients: [{ agentId: input.reviewerAgentId }],
          type: "REVIEW_REQUEST",
          priority: "IMPORTANT",
          requiresAck: true,
          requiresResponse: true,
          summary: `Review requested for ${task.title} · revision ${requestedReview.revision}`,
          detail: {
            reviewId: requestedReview.id,
            baseSha: requestedReview.baseSha,
            headSha: requestedReview.headSha,
            patchSha256: requestedReview.patchSha256,
          },
          references: [
            { type: "task", id: taskId },
            { type: "review", id: requestedReview.id },
          ],
          dedupeKey: `review-request:${requestedReview.id}`,
          idempotencyKey: `${input.idempotencyKey}:message`,
        });
        return requestedReview;
      },
      {
        requestFingerprint: reviewMutationFingerprint({ taskId }, input),
        validateReplay: (cachedResponse) => {
          const currentTask = getTask(ctx, taskId);
          const currentSession = getOpenSession(ctx, input.sessionId);
          if (
            currentTask.projectId !== currentSession.projectId ||
            currentTask.ownerSessionId !== currentSession.id
          ) {
            throw new ForbiddenError("Only the live task owner can replay a review request");
          }
          const cachedReviewId = (cachedResponse as { id?: unknown } | null)?.id;
          if (typeof cachedReviewId !== "string") {
            throw new ConflictError("Cached review request is invalid");
          }
          const cachedReview = getReview(ctx, cachedReviewId);
          if (
            cachedReview.taskId !== currentTask.id ||
            cachedReview.projectId !== currentTask.projectId ||
            cachedReview.authorSessionId !== currentSession.id ||
            cachedReview.reviewerAgentId !== input.reviewerAgentId
          ) {
            throw new ConflictError("Cached review request no longer matches the live task owner");
          }
          assertLatestActiveReview(ctx, cachedReview, [
            "PENDING",
            "DELIVERED",
            "IN_REVIEW",
            "CHANGES_REQUESTED",
          ]);
        },
      },
    );
  } catch (error) {
    if (artifactStoragePath) rmSync(dirname(artifactStoragePath), { recursive: true, force: true });
    throw error;
  }
  return review;
}

export function getReview(
  ctx: StoreContext,
  reviewId: string,
): ReviewBundle & {
  findings: ReviewFinding[];
  artifact: any;
  testEvidenceRows: any[];
} {
  const row = ctx.sqlite.prepare("SELECT * FROM reviews WHERE id = ?").get(reviewId);
  if (!row) throw new NotFoundError("Review", reviewId);
  const review = reviewFromRow(row);
  return {
    ...review,
    findings: (
      ctx.sqlite
        .prepare("SELECT * FROM review_findings WHERE review_id = ? ORDER BY created_at")
        .all(reviewId) as any[]
    ).map(findingFromRow),
    artifact: ctx.sqlite
      .prepare(
        "SELECT id, name, media_type, sha256, size_bytes, storage_path, metadata_json, created_at FROM artifacts WHERE id = ?",
      )
      .get(review.patchArtifactId),
    testEvidenceRows: ctx.sqlite
      .prepare("SELECT * FROM test_evidence WHERE review_id = ? ORDER BY created_at")
      .all(reviewId),
  };
}

export function listReviews(ctx: StoreContext, projectId: string, status?: string): ReviewBundle[] {
  return (
    ctx.sqlite
      .prepare(
        `SELECT * FROM reviews WHERE project_id = ?
           ${status ? "AND status = ?" : ""} ORDER BY created_at DESC`,
      )
      .all(...(status ? [projectId, status] : [projectId])) as any[]
  ).map(reviewFromRow);
}

export function beginReview(
  ctx: StoreContext,
  reviewId: string,
  input: { sessionId: string; expectedVersion: number; idempotencyKey: string },
): ReviewBundle {
  const review = getReview(ctx, reviewId);
  return ctx.mutate(
    review.projectId,
    input.idempotencyKey,
    "review.begin",
    ({ emit }) => {
      const current = getReview(ctx, reviewId);
      const session = assignedReviewerSession(ctx, current, input.sessionId);
      assertLatestActiveReview(ctx, current, ["PENDING", "DELIVERED"]);
      if (current.version !== input.expectedVersion) {
        throw new ConflictError("Review version changed", current);
      }
      ctx.sqlite
        .prepare(
          `UPDATE reviews SET status = 'IN_REVIEW', version = version + 1,
           updated_at = ? WHERE id = ?`,
        )
        .run(nowIso(), reviewId);
      ctx.sqlite
        .prepare(
          `UPDATE tasks SET status = 'IN_REVIEW', version = version + 1,
           updated_at = ? WHERE id = ?`,
        )
        .run(nowIso(), review.taskId);
      ctx.sqlite
        .prepare(
          `UPDATE agent_sessions SET work_state = 'REVIEWING', current_review_id = ?,
           version = version + 1 WHERE id = ?`,
        )
        .run(reviewId, session.id);
      emit({
        projectId: review.projectId,
        type: "review.started",
        actorType: "agent",
        actorId: session.agentId,
        aggregateType: "review",
        aggregateId: reviewId,
        causationId: null,
        correlationId: review.taskId,
        payload: { sessionId: session.id },
      });
      return reviewFromRow(ctx.sqlite.prepare("SELECT * FROM reviews WHERE id = ?").get(reviewId));
    },
    {
      requestFingerprint: reviewMutationFingerprint({ reviewId }, input),
      validateReplay: () => {
        assignedReviewerSession(ctx, getReview(ctx, reviewId), input.sessionId);
      },
    },
  );
}

export function createFinding(
  ctx: StoreContext,
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
): ReviewFinding {
  const review = getReview(ctx, reviewId);
  return ctx.mutate(
    review.projectId,
    input.idempotencyKey,
    "finding.create",
    ({ emit }) => {
      const current = getReview(ctx, reviewId);
      const session = assignedReviewerSession(ctx, current, input.sessionId);
      assertLatestActiveReview(ctx, current, [
        "PENDING",
        "DELIVERED",
        "IN_REVIEW",
        "CHANGES_REQUESTED",
      ]);
      if (
        input.severity !== "info" &&
        !input.filePath &&
        !input.symbol &&
        input.evidence.length === 0
      ) {
        throw new HubError(
          "Non-info findings require a location or reproducible evidence",
          422,
          "FINDING_EVIDENCE_REQUIRED",
        );
      }
      const id = createId("fnd");
      const now = nowIso();
      const blocking = input.severity === "blocking";
      ctx.sqlite
        .prepare(
          `INSERT INTO review_findings(
              id, review_id, severity, category, title, claim, impact, file_path,
              line_start, line_end, symbol, evidence_json, suggested_direction,
              status, blocking, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?, ?)`,
        )
        .run(
          id,
          reviewId,
          input.severity,
          input.category,
          input.title,
          input.claim,
          input.impact,
          input.filePath ?? null,
          input.lineStart ?? null,
          input.lineEnd ?? null,
          input.symbol ?? null,
          JSON.stringify(input.evidence),
          input.suggestedDirection ?? null,
          blocking ? 1 : 0,
          now,
          now,
        );
      emit({
        projectId: current.projectId,
        type: "review.finding.created",
        actorType: "agent",
        actorId: session.agentId,
        aggregateType: "finding",
        aggregateId: id,
        causationId: null,
        correlationId: reviewId,
        payload: {
          reviewId,
          taskId: current.taskId,
          severity: input.severity,
          blocking,
          title: input.title,
          filePath: input.filePath ?? null,
        },
      });
      recomputeProgress(ctx, current.taskId);
      return findingFromRow(
        ctx.sqlite.prepare("SELECT * FROM review_findings WHERE id = ?").get(id),
      );
    },
    {
      requestFingerprint: reviewMutationFingerprint({ reviewId }, input),
      validateReplay: () => {
        const current = getReview(ctx, reviewId);
        assignedReviewerSession(ctx, current, input.sessionId);
        assertLatestActiveReview(ctx, current, [
          "PENDING",
          "DELIVERED",
          "IN_REVIEW",
          "CHANGES_REQUESTED",
        ]);
      },
    },
  );
}

export function resolveFinding(
  ctx: StoreContext,
  findingId: string,
  input: {
    sessionId: string;
    status: "ACCEPTED" | "DISPUTED" | "FIXED" | "VERIFIED" | "WONT_FIX";
    resolution: string;
    idempotencyKey: string;
  },
): ReviewFinding {
  const row = ctx.sqlite
    .prepare(
      `SELECT f.*, r.project_id, r.task_id, r.author_agent_id, r.reviewer_agent_id
         FROM review_findings f JOIN reviews r ON r.id = f.review_id WHERE f.id = ?`,
    )
    .get(findingId) as any;
  if (!row) throw new NotFoundError("Finding", findingId);
  return ctx.mutate(
    row.project_id,
    input.idempotencyKey,
    "finding.resolve",
    ({ emit }) => {
      const currentReview = getReview(ctx, String(row.review_id));
      const session = sessionInProject(ctx, input.sessionId, currentReview.projectId);
      assertLatestActiveReview(ctx, currentReview, [
        "PENDING",
        "DELIVERED",
        "IN_REVIEW",
        "CHANGES_REQUESTED",
      ]);
      assertFindingResolutionRole(session, currentReview, input.status);
      ctx.sqlite
        .prepare(
          `UPDATE review_findings SET status = ?, resolution = ?, updated_at = ?
             WHERE id = ?`,
        )
        .run(input.status, input.resolution, nowIso(), findingId);
      emit({
        projectId: currentReview.projectId,
        type: "review.finding.updated",
        actorType: "agent",
        actorId: session.agentId,
        aggregateType: "finding",
        aggregateId: findingId,
        causationId: null,
        correlationId: currentReview.id,
        payload: { status: input.status, resolution: input.resolution },
      });
      recomputeProgress(ctx, currentReview.taskId);
      return findingFromRow(
        ctx.sqlite.prepare("SELECT * FROM review_findings WHERE id = ?").get(findingId),
      );
    },
    {
      requestFingerprint: reviewMutationFingerprint({ findingId }, input),
      validateReplay: () => {
        const currentReview = getReview(ctx, String(row.review_id));
        const session = sessionInProject(ctx, input.sessionId, currentReview.projectId);
        assertLatestActiveReview(ctx, currentReview, [
          "PENDING",
          "DELIVERED",
          "IN_REVIEW",
          "CHANGES_REQUESTED",
        ]);
        assertFindingResolutionRole(session, currentReview, input.status);
      },
    },
  );
}

export function submitReviewVerdict(
  ctx: StoreContext,
  reviewId: string,
  input: {
    sessionId: string;
    expectedVersion: number;
    verdict: "APPROVED" | "CHANGES_REQUESTED";
    summary: string;
    overrideReason?: string;
    idempotencyKey: string;
  },
): ReviewBundle {
  const review = getReview(ctx, reviewId);
  const result = ctx.mutate(
    review.projectId,
    input.idempotencyKey,
    "review.verdict",
    ({ emit }) => {
      const current = getReview(ctx, reviewId);
      // This Interface is agent-authored. A textual overrideReason may explain a verdict, but it is
      // not proof of a human principal and therefore never changes authorization or audit identity.
      const session = assignedReviewerSession(ctx, current, input.sessionId);
      assertLatestActiveReview(ctx, current, ["IN_REVIEW"]);
      if (current.version !== input.expectedVersion) {
        throw new ConflictError("Review version changed", current);
      }
      const openBlocking = current.findings.filter(
        (finding) => finding.blocking && !["VERIFIED", "WONT_FIX"].includes(finding.status),
      );
      if (input.verdict === "APPROVED" && openBlocking.length > 0) {
        throw new ConflictError("Blocking findings must be resolved before approval", current);
      }
      const resultRecipientSessionId = currentAuthorProjectionSessionId(ctx, current);
      const now = nowIso();
      ctx.sqlite
        .prepare(
          `UPDATE reviews SET status = ?, verdict_summary = ?, version = version + 1,
             updated_at = ? WHERE id = ?`,
        )
        .run(input.verdict, input.summary, now, reviewId);
      ctx.sqlite
        .prepare(`UPDATE tasks SET status = ?, version = version + 1, updated_at = ? WHERE id = ?`)
        .run(input.verdict, now, current.taskId);
      if (input.verdict === "APPROVED") {
        const approvedTask = getTask(ctx, current.taskId);
        assertTaskCompletionGate(ctx, approvedTask);
        ctx.sqlite
          .prepare(
            `UPDATE tasks SET status = 'DONE', computed_progress = 100,
               version = version + 1, updated_at = ? WHERE id = ?`,
          )
          .run(now, current.taskId);
        ctx.sqlite
          .prepare(
            `UPDATE agent_sessions SET current_task_id = NULL, current_review_id = NULL,
               work_state = 'IDLE', version = version + 1
               WHERE id IN (?, ?)`,
          )
          .run(resultRecipientSessionId, session.id);
      } else {
        ctx.sqlite
          .prepare(
            `UPDATE agent_sessions SET work_state = 'FIXING_REVIEW',
               current_review_id = ?, version = version + 1 WHERE id = ?`,
          )
          .run(reviewId, resultRecipientSessionId);
        ctx.sqlite
          .prepare(
            `UPDATE agent_sessions SET current_review_id = NULL, work_state = 'IDLE',
               version = version + 1 WHERE id = ?`,
          )
          .run(session.id);
      }
      emit({
        projectId: current.projectId,
        type: input.verdict === "APPROVED" ? "review.approved" : "review.changes_requested",
        actorType: "agent",
        actorId: session.agentId,
        aggregateType: "review",
        aggregateId: reviewId,
        causationId: null,
        correlationId: current.taskId,
        payload: {
          verdict: input.verdict,
          summary: input.summary,
          overrideReason: input.overrideReason ?? null,
          taskStatus: input.verdict === "APPROVED" ? "DONE" : "CHANGES_REQUESTED",
        },
      });
      recomputeProgress(ctx, current.taskId);
      const verdictReview = reviewFromRow(
        ctx.sqlite.prepare("SELECT * FROM reviews WHERE id = ?").get(reviewId),
      );
      postMessage(ctx, current.projectId, {
        taskId: current.taskId,
        reviewId,
        fromAgentId: session.agentId,
        fromSessionId: session.id,
        recipients: [{ agentId: current.authorAgentId, sessionId: resultRecipientSessionId }],
        type: "REVIEW_RESULT",
        priority: input.verdict === "CHANGES_REQUESTED" ? "INTERRUPT" : "IMPORTANT",
        requiresAck: true,
        requiresResponse: input.verdict === "CHANGES_REQUESTED",
        summary: input.summary,
        detail: { verdict: input.verdict, reviewId },
        references: [
          { type: "task", id: current.taskId },
          { type: "review", id: reviewId },
        ],
        dedupeKey: `review-result:${reviewId}:${verdictReview.version}`,
        idempotencyKey: `${input.idempotencyKey}:message`,
      });
      return verdictReview;
    },
    {
      requestFingerprint: reviewMutationFingerprint({ reviewId }, input),
      validateReplay: () => {
        const current = getReview(ctx, reviewId);
        assignedReviewerSession(ctx, current, input.sessionId);
        currentAuthorProjectionSessionId(ctx, current);
      },
    },
  );
  return result;
}
