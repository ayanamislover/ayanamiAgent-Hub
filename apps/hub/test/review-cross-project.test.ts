import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HubServer } from "../src/server.js";
import { createHubServer } from "./test-server.js";

/**
 * A review's authorization checks compare `session.agentId` against `reviewerAgentId`. Agent ids are
 * only unique within a project -- "codex" and "claude" legitimately exist in every project at once --
 * so an agent id match alone does not establish that the caller belongs to the review's project.
 *
 * That makes a session in one project able to begin, annotate and rule on a review in another, and a
 * verdict is a gate: APPROVED is what lets the author move the task to DONE. The hole became easy to
 * reach the moment two workers deliberately shared an agent id across projects.
 */
describe("reviews reject a same-agent session from another project", () => {
  let server: HubServer;
  let projectA: string;
  let projectB: string;
  let projectARoot: string;
  let projectASha: string;
  let dataDir: string;
  let ownerSession: string;
  let reviewerInA: string;
  let reviewerInB: string;
  let reviewId: string;

  const makeRepo = () => {
    const root = mkdtempSync(resolve(tmpdir(), "review-xp-"));
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    git("init", "-q");
    git("config", "user.email", "test@local");
    git("config", "user.name", "test");
    writeFileSync(join(root, "file.ts"), "export const a = 1;\n");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    return { root, sha: git("rev-parse", "HEAD") };
  };

  const register = (projectId: string, agentId: string, cwd: string) =>
    server.store.registerSession({
      projectId,
      agentId,
      role: "primary",
      client: "fake-client",
      transport: "websocket",
      deliveryMode: "native_channel",
      cwd,
      capabilities: [],
      idempotencyKey: `reg-${projectId}-${agentId}-${Math.random()}`,
    }).id;

  beforeEach(async () => {
    const root = mkdtempSync(resolve(tmpdir(), "hub-review-xp-"));
    dataDir = resolve(root, "data");
    server = await createHubServer({
      databasePath: resolve(root, "hub.db"),
      dataDir,
      dashboardDir: resolve(root, "missing-dashboard"),
      host: "127.0.0.1",
      port: 0,
      logLevel: "silent",
    });

    const repoA = makeRepo();
    const repoB = makeRepo();
    projectARoot = repoA.root;
    projectASha = repoA.sha;
    projectA = server.store.joinProject(server.credentials.dashboard.principal, {
      cwd: repoA.root,
      name: "a",
      allowCreate: true,
    }).project.id;
    projectB = server.store.joinProject(server.credentials.dashboard.principal, {
      cwd: repoB.root,
      name: "b",
      allowCreate: true,
    }).project.id;

    ownerSession = register(projectA, "claude", repoA.root);
    reviewerInA = register(projectA, "codex", repoA.root);
    // The same agent id, in a different project. This session has no business with project A.
    reviewerInB = register(projectB, "codex", repoB.root);

    const objective = server.store.createObjective(
      server.credentials.dashboard.principal,
      projectA,
      {
        title: "o",
        description: "",
        definitionOfDone: [],
        status: "ACTIVE",
        idempotencyKey: "obj",
      },
    ) as { id: string };
    const task = server.store.createTask(server.credentials.dashboard.principal, projectA, {
      objectiveId: objective.id,
      title: "t",
      description: "",
      status: "READY",
      priority: "normal",
      capabilityTags: [],
      scopeGlobs: [],
      protectedScope: false,
      reviewRequired: true,
      dependsOn: [],
      weight: 1,
      idempotencyKey: "task",
    });
    const claimed = server.store.claimTask(task.id, {
      sessionId: ownerSession,
      expectedVersion: task.version,
      takeoverStale: false,
      idempotencyKey: "claim",
    });
    reviewId = server.store.requestReview(claimed.id, {
      sessionId: ownerSession,
      reviewerAgentId: "codex",
      baseSha: repoA.sha,
      headSha: repoA.sha,
      acceptanceCriteria: [],
      testEvidence: [],
      authorClaims: [],
      knownRisks: [],
      includeUncommitted: false,
      idempotencyKey: "review",
    }).id;
  });

  afterEach(async () => {
    await server.app.close();
  });

  const version = () => server.store.getReview(reviewId).version;

  it("refuses to let another project's session begin the review", () => {
    expect(() =>
      server.store.beginReview(reviewId, {
        sessionId: reviewerInB,
        expectedVersion: version(),
        idempotencyKey: "begin-from-b",
      }),
    ).toThrow(/different project/i);
  });

  it("refuses a verdict from another project's session", () => {
    expect(() =>
      server.store.submitReviewVerdict(reviewId, {
        sessionId: reviewerInB,
        expectedVersion: version(),
        verdict: "APPROVED",
        summary: "approved from the wrong project",
        idempotencyKey: "verdict-from-b",
      }),
    ).toThrow(/different project/i);
  });

  it("refuses a finding from another project's session", () => {
    expect(() =>
      server.store.createFinding(reviewId, {
        sessionId: reviewerInB,
        severity: "low",
        category: "correctness",
        title: "from the wrong project",
        claim: "c",
        impact: "i",
        // A non-info finding needs a location, and that guard runs after the authorization check --
        // without this the test would pass for the wrong reason.
        filePath: "file.ts",
        lineStart: 1,
        evidence: [],
        idempotencyKey: "finding-from-b",
      }),
    ).toThrow(/different project/i);
  });

  it("still lets the real reviewer in the right project work", () => {
    const begun = server.store.beginReview(reviewId, {
      sessionId: reviewerInA,
      expectedVersion: version(),
      idempotencyKey: "begin-from-a",
    });
    expect(begun.status).toBe("IN_REVIEW");

    const approved = server.store.submitReviewVerdict(reviewId, {
      sessionId: reviewerInA,
      expectedVersion: begun.version,
      verdict: "APPROVED",
      summary: "fine",
      idempotencyKey: "verdict-from-a",
    });
    expect(approved.status).toBe("APPROVED");
  });

  it("lets only the assigned reviewer waive a blocking finding", () => {
    const begun = server.store.beginReview(reviewId, {
      sessionId: reviewerInA,
      expectedVersion: version(),
      idempotencyKey: "waive-begin",
    });
    const finding = server.store.createFinding(reviewId, {
      sessionId: reviewerInA,
      severity: "blocking",
      category: "correctness",
      title: "must not be waived by the author",
      claim: "A blocking finding is reviewer-owned evidence",
      impact: "An arbitrary participant could otherwise erase the gate",
      filePath: "file.ts",
      lineStart: 1,
      evidence: [],
      idempotencyKey: "waive-finding",
    });
    expect(begun.status).toBe("IN_REVIEW");

    expect(() =>
      server.store.resolveFinding(finding.id, {
        sessionId: ownerSession,
        status: "WONT_FIX",
        resolution: "author tried to waive it",
        idempotencyKey: "waive-by-author",
      }),
    ).toThrow(/reviewer/i);

    expect(
      server.store.resolveFinding(finding.id, {
        sessionId: reviewerInA,
        status: "WONT_FIX",
        resolution: "reviewer explicitly waived it",
        idempotencyKey: "waive-by-reviewer",
      }),
    ).toMatchObject({ status: "WONT_FIX" });
  });

  it("does not let overrideReason impersonate a user or bypass the assigned reviewer", () => {
    const begun = server.store.beginReview(reviewId, {
      sessionId: reviewerInA,
      expectedVersion: version(),
      idempotencyKey: "override-begin",
    });

    expect(() =>
      server.store.submitReviewVerdict(reviewId, {
        sessionId: ownerSession,
        expectedVersion: begun.version,
        verdict: "APPROVED",
        summary: "author supplied an override string",
        overrideReason: "pretend this came from a human",
        idempotencyKey: "override-by-author",
      }),
    ).toThrow(/assigned reviewer/i);

    server.store.submitReviewVerdict(reviewId, {
      sessionId: reviewerInA,
      expectedVersion: begun.version,
      verdict: "APPROVED",
      summary: "reviewer approved with an explanatory note",
      overrideReason: "still an agent-authored verdict",
      idempotencyKey: "override-by-reviewer",
    });
    const event = server.store
      .listEvents(projectA)
      .find(
        (candidate) => candidate.type === "review.approved" && candidate.aggregateId === reviewId,
      );
    expect(event).toMatchObject({ actorType: "agent", actorId: "codex" });
  });

  it("fingerprints every review mutation instead of sharing a cache entry by operation name", () => {
    const begun = server.store.beginReview(reviewId, {
      sessionId: reviewerInA,
      expectedVersion: version(),
      idempotencyKey: "fingerprint-begin",
    });
    expect(() =>
      server.store.beginReview(reviewId, {
        sessionId: reviewerInA,
        expectedVersion: begun.version,
        idempotencyKey: "fingerprint-begin",
      }),
    ).toThrow(/idempotency key/i);
    const finding = server.store.createFinding(reviewId, {
      sessionId: reviewerInA,
      severity: "blocking",
      category: "correctness",
      title: "fingerprinted finding",
      claim: "the full request identifies the mutation",
      impact: "changed retries must conflict",
      filePath: "file.ts",
      lineStart: 1,
      evidence: [],
      idempotencyKey: "fingerprint-finding",
    });
    expect(() =>
      server.store.createFinding(reviewId, {
        sessionId: reviewerInA,
        severity: "blocking",
        category: "correctness",
        title: "changed request under the same key",
        claim: "the full request identifies the mutation",
        impact: "changed retries must conflict",
        filePath: "file.ts",
        lineStart: 1,
        evidence: [],
        idempotencyKey: "fingerprint-finding",
      }),
    ).toThrow(/idempotency key/i);
    server.store.resolveFinding(finding.id, {
      sessionId: reviewerInA,
      status: "WONT_FIX",
      resolution: "fingerprinted resolution",
      idempotencyKey: "fingerprint-resolution",
    });
    server.store.submitReviewVerdict(reviewId, {
      sessionId: reviewerInA,
      expectedVersion: server.store.getReview(reviewId).version,
      verdict: "APPROVED",
      summary: "fingerprinted verdict",
      idempotencyKey: "fingerprint-verdict",
    });
    expect(begun.status).toBe("IN_REVIEW");

    const operations = new Map(
      (
        server.store.sqlite
          .prepare(
            `SELECT key, operation FROM idempotency_keys
              WHERE project_id = ? AND key IN (?, ?, ?, ?, ?)`,
          )
          .all(
            projectA,
            "review",
            "fingerprint-begin",
            "fingerprint-finding",
            "fingerprint-resolution",
            "fingerprint-verdict",
          ) as Array<{ key: string; operation: string }>
      ).map((row) => [row.key, row.operation]),
    );
    expect(operations.get("review")).toMatch(/^review\.request#/);
    expect(operations.get("fingerprint-begin")).toMatch(/^review\.begin#/);
    expect(operations.get("fingerprint-finding")).toMatch(/^finding\.create#/);
    expect(operations.get("fingerprint-resolution")).toMatch(/^finding\.resolve#/);
    expect(operations.get("fingerprint-verdict")).toMatch(/^review\.verdict#/);
  });

  it("does not replay a superseded review request after a newer revision exists", () => {
    const taskId = server.store.getReview(reviewId).taskId;
    const originalRequest = {
      sessionId: ownerSession,
      reviewerAgentId: "codex",
      baseSha: projectASha,
      headSha: projectASha,
      acceptanceCriteria: [],
      testEvidence: [],
      authorClaims: [],
      knownRisks: [],
      includeUncommitted: false,
      idempotencyKey: "review",
    };
    const begun = server.store.beginReview(reviewId, {
      sessionId: reviewerInA,
      expectedVersion: version(),
      idempotencyKey: "superseded-replay-begin",
    });
    server.store.submitReviewVerdict(reviewId, {
      sessionId: reviewerInA,
      expectedVersion: begun.version,
      verdict: "CHANGES_REQUESTED",
      summary: "request a new revision",
      idempotencyKey: "superseded-replay-verdict",
    });

    const latestRequest = {
      ...originalRequest,
      idempotencyKey: "latest-review-request",
    };
    const latest = server.store.requestReview(taskId, latestRequest);
    expect(latest.id).not.toBe(reviewId);
    expect(server.store.requestReview(taskId, latestRequest).id).toBe(latest.id);
    expect(server.store.getReview(reviewId).status).toBe("SUPERSEDED");

    const oldMessageIds = server.store.sqlite
      .prepare("SELECT id FROM messages WHERE review_id = ? AND type = 'REVIEW_REQUEST'")
      .all(reviewId) as Array<{ id: string }>;
    const deleteRecipients = server.store.sqlite.prepare(
      "DELETE FROM message_recipients WHERE message_id = ?",
    );
    for (const message of oldMessageIds) deleteRecipients.run(message.id);
    server.store.sqlite
      .prepare("DELETE FROM messages WHERE review_id = ? AND type = 'REVIEW_REQUEST'")
      .run(reviewId);
    server.store.sqlite
      .prepare("DELETE FROM idempotency_keys WHERE project_id = ? AND key = ?")
      .run(projectA, "review:message");

    expect(() => server.store.requestReview(taskId, originalRequest)).toThrow(/latest active/i);
    expect(
      server.store.sqlite
        .prepare(
          "SELECT COUNT(*) AS count FROM messages WHERE review_id = ? AND type = 'REVIEW_REQUEST'",
        )
        .get(reviewId),
    ).toMatchObject({ count: 0 });
  });

  it("revalidates live participants before returning cached review mutations", () => {
    const beginInput = {
      sessionId: reviewerInA,
      expectedVersion: version(),
      idempotencyKey: "replay-live-begin",
    };
    server.store.beginReview(reviewId, beginInput);
    const findingInput = {
      sessionId: reviewerInA,
      severity: "blocking",
      category: "correctness",
      title: "cached finding",
      claim: "a cached response is not current authorization",
      impact: "a retired reviewer could keep mutating the audit",
      filePath: "file.ts",
      lineStart: 1,
      evidence: [],
      idempotencyKey: "replay-live-finding",
    };
    const finding = server.store.createFinding(reviewId, findingInput);
    const resolveInput = {
      sessionId: reviewerInA,
      status: "WONT_FIX" as const,
      resolution: "reviewer waiver",
      idempotencyKey: "replay-live-resolution",
    };
    server.store.resolveFinding(finding.id, resolveInput);
    const verdictInput = {
      sessionId: reviewerInA,
      expectedVersion: server.store.getReview(reviewId).version,
      verdict: "APPROVED" as const,
      summary: "reviewer verdict",
      idempotencyKey: "replay-live-verdict",
    };
    server.store.submitReviewVerdict(reviewId, verdictInput);
    server.store.closeSession(reviewerInA, "retired reviewer");
    server.store.closeSession(ownerSession, "retired author");

    expect(() => server.store.beginReview(reviewId, beginInput)).toThrow(/closed/i);
    expect(() => server.store.createFinding(reviewId, findingInput)).toThrow(/closed/i);
    expect(() => server.store.resolveFinding(finding.id, resolveInput)).toThrow(/closed/i);
    expect(() => server.store.submitReviewVerdict(reviewId, verdictInput)).toThrow(/closed/i);
    expect(() =>
      server.store.requestReview(server.store.getReview(reviewId).taskId, {
        sessionId: ownerSession,
        reviewerAgentId: "codex",
        baseSha: projectASha,
        headSha: projectASha,
        acceptanceCriteria: [],
        testEvidence: [],
        authorClaims: [],
        knownRisks: [],
        includeUncommitted: false,
        idempotencyKey: "review",
      }),
    ).toThrow(/closed/i);
  });

  it("rejects a closed review author before committing the review transaction", () => {
    const closedAuthor = register(projectA, "closed-author", projectARoot);
    const objective = server.store.createObjective(
      server.credentials.dashboard.principal,
      projectA,
      {
        title: "closed author objective",
        description: "",
        definitionOfDone: [],
        status: "ACTIVE",
        idempotencyKey: "closed-author-objective",
      },
    ) as { id: string };
    const task = server.store.createTask(server.credentials.dashboard.principal, projectA, {
      objectiveId: objective.id,
      title: "closed author task",
      description: "",
      status: "READY",
      priority: "high",
      capabilityTags: [],
      scopeGlobs: [],
      protectedScope: false,
      reviewRequired: true,
      dependsOn: [],
      weight: 1,
      idempotencyKey: "closed-author-task",
    });
    const claimed = server.store.claimTask(task.id, {
      sessionId: closedAuthor,
      expectedVersion: task.version,
      takeoverStale: false,
      idempotencyKey: "closed-author-claim",
    });
    server.store.closeSession(closedAuthor, "closed before review request");

    expect(() =>
      server.store.requestReview(task.id, {
        sessionId: closedAuthor,
        reviewerAgentId: "codex",
        baseSha: projectASha,
        headSha: projectASha,
        acceptanceCriteria: [],
        testEvidence: [],
        authorClaims: [],
        knownRisks: [],
        includeUncommitted: false,
        idempotencyKey: "closed-author-review",
      }),
    ).toThrow(/closed/i);
    expect(server.store.getTask(task.id)).toMatchObject({
      status: claimed.status,
      version: claimed.version,
    });
    expect(
      server.store.listReviews(projectA).filter((review) => review.taskId === task.id),
    ).toEqual([]);
  });

  it("rolls back a review request, its message, and its artifact when the message key conflicts", () => {
    const author = register(projectA, "manual:atomic-author", projectARoot);
    const objective = server.store.createObjective(
      server.credentials.dashboard.principal,
      projectA,
      {
        title: "atomic request objective",
        description: "",
        definitionOfDone: [],
        status: "ACTIVE",
        idempotencyKey: "atomic-request-objective",
      },
    ) as { id: string };
    const task = server.store.createTask(server.credentials.dashboard.principal, projectA, {
      objectiveId: objective.id,
      title: "atomic request task",
      description: "",
      status: "READY",
      priority: "high",
      capabilityTags: [],
      scopeGlobs: [],
      protectedScope: false,
      reviewRequired: true,
      dependsOn: [],
      weight: 1,
      idempotencyKey: "atomic-request-task",
    });
    const claimed = server.store.claimTask(task.id, {
      sessionId: author,
      expectedVersion: task.version,
      takeoverStale: false,
      idempotencyKey: "atomic-request-claim",
    });
    server.store.postMessage(server.credentials.agent.principal, projectA, {
      fromAgentId: "manual:atomic-author",
      fromSessionId: author,
      recipients: [{ agentId: "codex" }],
      type: "STATUS",
      priority: "NORMAL",
      requiresAck: false,
      requiresResponse: false,
      summary: "Occupy review request message key",
      idempotencyKey: "atomic-request:message",
    });
    const artifactRoot = resolve(dataDir, "artifacts", projectA);
    const artifactCount = () =>
      existsSync(artifactRoot)
        ? readdirSync(artifactRoot, { recursive: true }).filter((entry) =>
            String(entry).endsWith(".patch"),
          ).length
        : 0;
    const artifactsBefore = artifactCount();
    const published: string[] = [];
    const unsubscribe = server.bus.subscribe(projectA, (event) => published.push(event.type));
    try {
      expect(() =>
        server.store.requestReview(task.id, {
          sessionId: author,
          reviewerAgentId: "codex",
          baseSha: projectASha,
          headSha: projectASha,
          acceptanceCriteria: [],
          testEvidence: [],
          authorClaims: [],
          knownRisks: [],
          includeUncommitted: false,
          idempotencyKey: "atomic-request",
        }),
      ).toThrow(/idempotency key/i);
    } finally {
      unsubscribe();
    }

    expect(server.store.getTask(task.id)).toMatchObject({
      status: claimed.status,
      ownerSessionId: author,
      version: claimed.version,
    });
    expect(
      server.store.listReviews(projectA).filter((review) => review.taskId === task.id),
    ).toEqual([]);
    expect(artifactCount()).toBe(artifactsBefore);
    expect(published).not.toContain("review.requested");
    expect(published).not.toContain("message.posted");
  });

  it("rolls back a verdict and task state when the review-result message key conflicts", () => {
    const begun = server.store.beginReview(reviewId, {
      sessionId: reviewerInA,
      expectedVersion: version(),
      idempotencyKey: "atomic-verdict-begin",
    });
    server.store.postMessage(server.credentials.dashboard.principal, projectA, {
      fromAgentId: "local-user",
      recipients: [{ agentId: "claude" }],
      type: "STATUS",
      priority: "NORMAL",
      requiresAck: false,
      requiresResponse: false,
      summary: "Occupy review result message key",
      idempotencyKey: "atomic-verdict:message",
    });
    const taskBefore = server.store.getTask(begun.taskId);
    const published: string[] = [];
    const unsubscribe = server.bus.subscribe(projectA, (event) => published.push(event.type));
    try {
      expect(() =>
        server.store.submitReviewVerdict(reviewId, {
          sessionId: reviewerInA,
          expectedVersion: begun.version,
          verdict: "CHANGES_REQUESTED",
          summary: "This verdict must roll back with its result message",
          idempotencyKey: "atomic-verdict",
        }),
      ).toThrow(/idempotency key/i);
    } finally {
      unsubscribe();
    }

    expect(server.store.getReview(reviewId)).toMatchObject({
      status: begun.status,
      version: begun.version,
      verdictSummary: begun.verdictSummary,
    });
    expect(server.store.getTask(begun.taskId)).toMatchObject({
      status: taskBefore.status,
      version: taskBefore.version,
    });
    expect(
      server.store
        .listMessages(projectA)
        .filter((message) => message.reviewId === reviewId && message.type === "REVIEW_RESULT"),
    ).toEqual([]);
    expect(published).not.toContain("review.changes_requested");
    expect(published).not.toContain("message.posted");
  });
});

describe("review ownership follows the current logical author session", () => {
  let server: HubServer;
  let projectId: string;
  let projectRoot: string;
  let baseSha: string;
  let authorPredecessor: string;
  let authorSuccessor: string;
  let reviewerSession: string;
  let reviewId: string;

  beforeEach(async () => {
    const root = mkdtempSync(resolve(tmpdir(), "hub-review-owner-"));
    server = await createHubServer({
      databasePath: resolve(root, "hub.db"),
      dataDir: resolve(root, "data"),
      dashboardDir: resolve(root, "missing-dashboard"),
      host: "127.0.0.1",
      port: 0,
      logLevel: "silent",
    });

    const repo = makeReviewRepo();
    projectRoot = repo.root;
    baseSha = repo.sha;
    projectId = server.store.joinProject(server.credentials.dashboard.principal, {
      cwd: projectRoot,
      name: "review ownership",
      allowCreate: true,
    }).project.id;
    authorPredecessor = registerLogicalSession(server, {
      projectId,
      projectRoot,
      agentId: "claude",
      externalThreadId: "author-thread",
      idempotencyKey: "author-predecessor",
    });
    reviewerSession = registerLogicalSession(server, {
      projectId,
      projectRoot,
      agentId: "codex",
      externalThreadId: "reviewer-thread",
      idempotencyKey: "reviewer",
    });

    const objective = server.store.createObjective(
      server.credentials.dashboard.principal,
      projectId,
      {
        title: "review projection",
        description: "",
        definitionOfDone: [],
        status: "ACTIVE",
        idempotencyKey: "review-projection-objective",
      },
    ) as { id: string };
    const task = server.store.createTask(server.credentials.dashboard.principal, projectId, {
      objectiveId: objective.id,
      title: "review projection task",
      description: "",
      status: "READY",
      priority: "high",
      capabilityTags: [],
      scopeGlobs: [],
      protectedScope: false,
      reviewRequired: true,
      dependsOn: [],
      weight: 1,
      idempotencyKey: "review-projection-task",
    });
    const claimed = server.store.claimTask(task.id, {
      sessionId: authorPredecessor,
      expectedVersion: task.version,
      takeoverStale: false,
      idempotencyKey: "review-projection-claim",
    });
    reviewId = server.store.requestReview(claimed.id, {
      sessionId: authorPredecessor,
      reviewerAgentId: "codex",
      baseSha,
      headSha: baseSha,
      acceptanceCriteria: [],
      testEvidence: [],
      authorClaims: [],
      knownRisks: [],
      includeUncommitted: false,
      idempotencyKey: "review-projection-request",
    }).id;

    authorSuccessor = registerLogicalSession(server, {
      projectId,
      projectRoot,
      agentId: "claude",
      externalThreadId: "author-thread",
      idempotencyKey: "author-successor",
    });
    server.store.beginReview(reviewId, {
      sessionId: reviewerSession,
      expectedVersion: server.store.getReview(reviewId).version,
      idempotencyKey: "review-projection-begin",
    });
  });

  afterEach(async () => {
    await server.app.close();
  });

  it("clears the successor projection and routes an APPROVED result to it", () => {
    server.store.submitReviewVerdict(reviewId, {
      sessionId: reviewerSession,
      expectedVersion: server.store.getReview(reviewId).version,
      verdict: "APPROVED",
      summary: "approved",
      idempotencyKey: "review-projection-approved",
    });

    expect(server.store.getReview(reviewId).authorSessionId).toBe(authorPredecessor);
    expect(server.store.getSession(authorPredecessor)).toMatchObject({
      connectionState: "CLOSED",
      currentReviewId: null,
    });
    expect(server.store.getSession(authorSuccessor)).toMatchObject({
      connectionState: "ONLINE",
      currentTaskId: null,
      currentReviewId: null,
      workState: "IDLE",
    });
    expect(reviewResultRecipient(server, reviewId)).toBe(authorSuccessor);
  });

  it("moves a CHANGES_REQUESTED projection and result to the successor", () => {
    server.store.submitReviewVerdict(reviewId, {
      sessionId: reviewerSession,
      expectedVersion: server.store.getReview(reviewId).version,
      verdict: "CHANGES_REQUESTED",
      summary: "fix it",
      idempotencyKey: "review-projection-changes",
    });

    expect(server.store.getReview(reviewId).authorSessionId).toBe(authorPredecessor);
    expect(server.store.getSession(authorPredecessor)).toMatchObject({
      connectionState: "CLOSED",
      currentReviewId: null,
    });
    expect(server.store.getSession(authorSuccessor)).toMatchObject({
      connectionState: "ONLINE",
      currentReviewId: reviewId,
      workState: "FIXING_REVIEW",
    });
    expect(reviewResultRecipient(server, reviewId)).toBe(authorSuccessor);
  });

  it("routes the result along the immutable author's lineage, not another thread's heartbeat", () => {
    let unrelatedAuthor = registerLogicalSession(server, {
      projectId,
      projectRoot,
      agentId: "claude",
      externalThreadId: "unrelated-author-thread",
      idempotencyKey: "unrelated-author-one",
    });
    unrelatedAuthor = registerLogicalSession(server, {
      projectId,
      projectRoot,
      agentId: "claude",
      externalThreadId: "unrelated-author-thread",
      idempotencyKey: "unrelated-author-two",
    });
    unrelatedAuthor = registerLogicalSession(server, {
      projectId,
      projectRoot,
      agentId: "claude",
      externalThreadId: "unrelated-author-thread",
      idempotencyKey: "unrelated-author-three",
    });
    server.store.heartbeat({
      sessionId: unrelatedAuthor,
      sequence: 1,
      workState: "WAITING_FOR_PEER",
      currentReviewId: reviewId,
      activeFiles: [],
      queueDepth: 0,
    });

    server.store.submitReviewVerdict(reviewId, {
      sessionId: reviewerSession,
      expectedVersion: server.store.getReview(reviewId).version,
      verdict: "CHANGES_REQUESTED",
      summary: "return to the author lineage",
      idempotencyKey: "immutable-author-lineage-result",
    });

    expect(reviewResultRecipient(server, reviewId)).toBe(authorSuccessor);
    expect(server.store.getSession(authorSuccessor)).toMatchObject({
      currentReviewId: reviewId,
      workState: "FIXING_REVIEW",
    });
    expect(server.store.getSession(unrelatedAuthor)).not.toMatchObject({
      workState: "FIXING_REVIEW",
    });
  });

  it("rejects begin and verdict mutations when a task has multiple active revisions", () => {
    const current = server.store.getReview(reviewId);
    server.store.sqlite.exec("DROP INDEX IF EXISTS ux_reviews_one_active_per_task");
    server.store.sqlite
      .prepare(
        `INSERT INTO reviews(
           id, project_id, task_id, revision, author_agent_id, author_session_id,
           reviewer_agent_id, base_sha, head_sha, patch_sha256, patch_artifact_id,
           changed_files_json, acceptance_criteria_json, test_evidence_json,
           author_claims_json, known_risks_json, status, supersedes_review_id,
           version, created_at, updated_at
         )
         SELECT 'rev_newer', project_id, task_id, revision + 1, author_agent_id,
                author_session_id, reviewer_agent_id, base_sha, head_sha, patch_sha256,
                patch_artifact_id, changed_files_json, acceptance_criteria_json,
                test_evidence_json, author_claims_json, known_risks_json, 'PENDING', id,
                0, created_at, updated_at
           FROM reviews WHERE id = ?`,
      )
      .run(reviewId);

    expect(() =>
      server.store.submitReviewVerdict(reviewId, {
        sessionId: reviewerSession,
        expectedVersion: current.version,
        verdict: "CHANGES_REQUESTED",
        summary: "stale review",
        idempotencyKey: "stale-review-verdict",
      }),
    ).toThrow(/multiple active reviews/i);

    server.store.sqlite
      .prepare("UPDATE reviews SET status = 'PENDING', version = version + 1 WHERE id = ?")
      .run(reviewId);
    expect(() =>
      server.store.beginReview(reviewId, {
        sessionId: reviewerSession,
        expectedVersion: current.version + 1,
        idempotencyKey: "stale-review-begin",
      }),
    ).toThrow(/multiple active reviews/i);
  });

  it("fails closed when the latest revision shares a task with another active review", () => {
    const current = server.store.getReview(reviewId);
    server.store.sqlite.exec("DROP INDEX IF EXISTS ux_reviews_one_active_per_task");
    server.store.sqlite
      .prepare(
        `INSERT INTO reviews(
           id, project_id, task_id, revision, author_agent_id, author_session_id,
           reviewer_agent_id, base_sha, head_sha, patch_sha256, patch_artifact_id,
           changed_files_json, acceptance_criteria_json, test_evidence_json,
           author_claims_json, known_risks_json, status, supersedes_review_id,
           version, created_at, updated_at
         )
         SELECT 'rev_duplicate_active', project_id, task_id, revision + 1, author_agent_id,
                author_session_id, reviewer_agent_id, base_sha, head_sha, patch_sha256,
                patch_artifact_id, changed_files_json, acceptance_criteria_json,
                test_evidence_json, author_claims_json, known_risks_json, 'PENDING', id,
                0, created_at, updated_at
           FROM reviews WHERE id = ?`,
      )
      .run(reviewId);
    const eventsBefore = server.store.listEvents(projectId).length;

    expect(() =>
      server.store.beginReview("rev_duplicate_active", {
        sessionId: reviewerSession,
        expectedVersion: 0,
        idempotencyKey: "duplicate-active-review-begin",
      }),
    ).toThrow(/multiple active reviews/i);

    expect(server.store.getReview(reviewId)).toMatchObject({
      status: current.status,
      version: current.version,
    });
    expect(server.store.getReview("rev_duplicate_active")).toMatchObject({
      status: "PENDING",
      version: 0,
    });
    expect(server.store.listEvents(projectId)).toHaveLength(eventsBefore);
    expect(
      server.store.sqlite
        .prepare("SELECT 1 FROM idempotency_keys WHERE project_id = ? AND key = ?")
        .get(projectId, "duplicate-active-review-begin"),
    ).toBeUndefined();
  });

  it("enforces one active review per task at the SQLite boundary", () => {
    server.store.sqlite.exec("SAVEPOINT duplicate_active_review_probe");
    let error: string | null = null;
    try {
      server.store.sqlite
        .prepare(
          `INSERT INTO reviews(
             id, project_id, task_id, revision, author_agent_id, author_session_id,
             reviewer_agent_id, base_sha, head_sha, patch_sha256, patch_artifact_id,
             changed_files_json, acceptance_criteria_json, test_evidence_json,
             author_claims_json, known_risks_json, status, supersedes_review_id,
             version, created_at, updated_at
           )
           SELECT 'rev_direct_duplicate', project_id, task_id, revision + 1, author_agent_id,
                  author_session_id, reviewer_agent_id, base_sha, head_sha, patch_sha256,
                  patch_artifact_id, changed_files_json, acceptance_criteria_json,
                  test_evidence_json, author_claims_json, known_risks_json, 'PENDING', id,
                  0, created_at, updated_at
             FROM reviews WHERE id = ?`,
        )
        .run(reviewId);
    } catch (candidate) {
      error = String(candidate);
    } finally {
      server.store.sqlite.exec(
        "ROLLBACK TO duplicate_active_review_probe; RELEASE duplicate_active_review_probe",
      );
    }

    expect(error).toMatch(/UNIQUE constraint failed: reviews\.task_id/i);
  });
});

function makeReviewRepo() {
  const root = mkdtempSync(resolve(tmpdir(), "review-owner-repo-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.email", "test@local");
  git("config", "user.name", "test");
  writeFileSync(join(root, "file.ts"), "export const a = 1;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  return { root, sha: git("rev-parse", "HEAD") };
}

function registerLogicalSession(
  server: HubServer,
  input: {
    projectId: string;
    projectRoot: string;
    agentId: "codex" | "claude";
    externalThreadId: string;
    idempotencyKey: string;
  },
) {
  return server.store.registerSession({
    projectId: input.projectId,
    agentId: input.agentId,
    role: "primary",
    client: "fake-client",
    transport: "websocket",
    deliveryMode: "native_channel",
    externalThreadId: input.externalThreadId,
    cwd: input.projectRoot,
    capabilities: [],
    idempotencyKey: input.idempotencyKey,
  }).id;
}

function reviewResultRecipient(server: HubServer, reviewId: string) {
  return (
    server.store.sqlite
      .prepare(
        `SELECT recipient.recipient_session_id AS sessionId
           FROM messages AS message
           JOIN message_recipients AS recipient ON recipient.message_id = message.id
          WHERE message.review_id = ? AND message.type = 'REVIEW_RESULT'
          ORDER BY message.sequence DESC LIMIT 1`,
      )
      .get(reviewId) as { sessionId: string }
  ).sessionId;
}
