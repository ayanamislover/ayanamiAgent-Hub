import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHubServer } from "../apps/hub/test/test-server.js";

const root = resolve(import.meta.dirname, "..");
const git = spawnSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
  windowsHide: true,
});
if (git.status !== 0) {
  throw new Error("Review smoke requires this repository to have a Git commit");
}
const headSha = git.stdout.trim();
const dataDir = mkdtempSync(resolve(tmpdir(), "crossagent-review-smoke-"));
const server = await createHubServer({
  dataDir,
  databasePath: resolve(dataDir, "review-smoke.db"),
  logLevel: "silent",
});

// Control-plane calls run as the Dashboard principal. The agent credential is scoped to what an
// adapter may do and cannot register a project, so passing it everywhere fails on the first call.
async function request<T>(
  method: "GET" | "POST" | "PATCH",
  path: string,
  body?: unknown,
  expectedStatus = 200,
  as: "dashboard" | "agent" = "dashboard",
): Promise<T> {
  const response = await server.app.inject({
    method,
    url: path,
    headers: {
      authorization: `Bearer ${as === "agent" ? server.token : server.credentials.dashboard.token}`,
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
  if (response.statusCode !== expectedStatus) {
    throw new Error(`${method} ${path}: HTTP ${response.statusCode} ${response.body}`);
  }
  return response.json() as T;
}

try {
  const joined = await request<any>("POST", "/api/projects/join", {
    cwd: root,
    name: "CrossAgent review smoke",
    allowCreate: true,
  });
  const projectId = joined.project.id;
  const objective = await request<any>("POST", `/api/projects/${projectId}/objectives`, {
    title: "Verify immutable review gate",
    description: "Exercise the complete author and reviewer state machine.",
    definitionOfDone: ["Blocking finding prevents approval", "Verified fix allows DONE"],
    status: "ACTIVE",
    idempotencyKey: "review-smoke-objective",
  });
  // A static credential may only create a compatibility session, and only one that says so in its
  // own name: fake-client plus a manual: or local: namespace. That fence is what keeps a bootstrap
  // token from impersonating a real adapter, so the smoke test lives inside it rather than around
  // it -- the review gate under test does not care which namespace the two parties came from.
  const register = (agentId: string, role: "primary" | "reviewer") =>
    request<any>(
      "POST",
      `/api/projects/${projectId}/sessions`,
      {
        agentId,
        role,
        client: "fake-client",
        transport: "websocket",
        deliveryMode: "mailbox_only",
        host: "review-smoke",
        cwd: root,
        gitHead: headSha,
        capabilities: ["review-smoke"],
        idempotencyKey: `review-smoke-session-${agentId}`,
      },
      200,
      "agent",
    );
  const [author, reviewer] = await Promise.all([
    register("manual:codex-smoke", "primary"),
    register("manual:claude-smoke", "reviewer"),
  ]);
  const task = await request<any>("POST", `/api/projects/${projectId}/tasks`, {
    objectiveId: objective.id,
    title: "Prove review completion gate",
    description: "Use an immutable empty patch at the current committed head.",
    status: "READY",
    priority: "high",
    capabilityTags: ["review"],
    scopeGlobs: ["apps/hub/**"],
    reviewRequired: true,
    dependsOn: [],
    weight: 1,
    idempotencyKey: "review-smoke-task",
  });
  const claimed = await request<any>("POST", `/api/tasks/${task.id}/claim`, {
    sessionId: author.id,
    expectedVersion: task.version,
    takeoverStale: false,
    idempotencyKey: "review-smoke-claim",
  });
  const todo = await request<any>("POST", `/api/tasks/${task.id}/todos`, {
    sessionId: author.id,
    title: "Run the release suite",
    type: "test",
    weight: 1,
    evidenceRequired: true,
    idempotencyKey: "review-smoke-todo",
  });
  await request("PATCH", `/api/todos/${todo.id}`, {
    expectedVersion: todo.version,
    status: "DONE",
    evidence: [{ command: "pnpm test", exitCode: 0, summary: "Release suite passed" }],
    completedBySessionId: author.id,
    idempotencyKey: "review-smoke-todo-done",
  });
  if (claimed.status !== "CLAIMED") throw new Error("Task claim did not enter CLAIMED");

  const review = await request<any>("POST", `/api/tasks/${task.id}/reviews`, {
    sessionId: author.id,
    reviewerAgentId: reviewer.agentId,
    baseSha: headSha,
    headSha,
    acceptanceCriteria: ["All TODO evidence complete", "No open blocking finding"],
    testEvidence: [{ command: "pnpm test", exitCode: 0, outputSummary: "24 tests passed" }],
    authorClaims: ["Current committed state passes the release suite"],
    knownRisks: [],
    includeUncommitted: false,
    idempotencyKey: "review-smoke-request",
  });
  const artifact = await server.app.inject({
    method: "GET",
    url: `/api/artifacts/${review.patchArtifactId}/content`,
    headers: { authorization: `Bearer ${server.credentials.dashboard.token}` },
  });
  if (artifact.statusCode !== 200) {
    throw new Error(
      `Immutable review artifact was not readable: HTTP ${artifact.statusCode} ${artifact.body}`,
    );
  }
  const artifactSha = createHash("sha256").update(artifact.rawPayload).digest("hex");
  if (artifactSha !== review.patchSha256)
    throw new Error("Review patch hash did not match content");

  const begun = await request<any>("POST", `/api/reviews/${review.id}/begin`, {
    sessionId: reviewer.id,
    expectedVersion: review.version,
    idempotencyKey: "review-smoke-begin",
  });
  const finding = await request<any>("POST", `/api/reviews/${review.id}/findings`, {
    sessionId: reviewer.id,
    severity: "blocking",
    category: "correctness",
    title: "Synthetic blocking gate",
    claim: "Approval must be impossible while this finding is open.",
    impact: "A premature DONE state would invalidate independent review.",
    symbol: "submitReviewVerdict",
    evidence: [{ kind: "state-machine-smoke" }],
    suggestedDirection: "Resolve and independently verify the finding.",
    idempotencyKey: "review-smoke-finding",
  });
  await request(
    "POST",
    `/api/reviews/${review.id}/verdict`,
    {
      sessionId: reviewer.id,
      expectedVersion: begun.version,
      verdict: "APPROVED",
      summary: "This approval must be rejected.",
      idempotencyKey: "review-smoke-premature-approval",
    },
    409,
  );
  await request("POST", `/api/findings/${finding.id}/resolve`, {
    sessionId: author.id,
    status: "FIXED",
    resolution: "Author supplied the requested evidence.",
    idempotencyKey: "review-smoke-finding-fixed",
  });
  await request("POST", `/api/findings/${finding.id}/resolve`, {
    sessionId: reviewer.id,
    status: "VERIFIED",
    resolution: "Reviewer independently verified the resolution.",
    idempotencyKey: "review-smoke-finding-verified",
  });
  const approved = await request<any>("POST", `/api/reviews/${review.id}/verdict`, {
    sessionId: reviewer.id,
    expectedVersion: begun.version,
    verdict: "APPROVED",
    summary: "All blocking evidence is resolved and independently verified.",
    idempotencyKey: "review-smoke-approval",
  });
  const completed = await request<any>("GET", `/api/tasks/${task.id}`);
  if (approved.status !== "APPROVED" || completed.status !== "DONE") {
    throw new Error("Approved review did not deterministically complete the task");
  }
  if (completed.computedProgress !== 100) {
    throw new Error(`Completed task progress was ${completed.computedProgress}, expected 100`);
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        projectId,
        taskId: task.id,
        reviewId: review.id,
        patchSha256: review.patchSha256,
        prematureApprovalStatus: 409,
        findingStatus: "VERIFIED",
        reviewStatus: approved.status,
        taskStatus: completed.status,
        computedProgress: completed.computedProgress,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await server.close();
  rmSync(dataDir, { recursive: true, force: true });
}
