import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { FullConfig } from "@playwright/test";

async function post(baseURL: string, token: string, path: string, body: unknown) {
  const response = await fetch(`${baseURL}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status} ${await response.text()}`);
  return response.json() as Promise<any>;
}

export default async function globalSetup(config: FullConfig) {
  const root = resolve(import.meta.dirname, "../../..");
  const dataDir = resolve(root, "output", "playwright", "e2e-data");
  const fixture = resolve(root, "output", "playwright", "fixture-project");
  mkdirSync(fixture, { recursive: true });
  // Two credentials, because the Hub deliberately splits them and no single one can do all of this.
  //
  // `dashboard-token` is the Dashboard's own credential (`hub:dashboard`) and drives everything the
  // Dashboard itself can do: joining the project, and creating objectives, milestones, tasks,
  // messages and write intents.
  //
  // `token` is the compatibility bearer, crd_local_agent. It is the only principal allowed to
  // create the fake-client sessions this fixture needs -- see assertCanCreateAdapterSession, which
  // admits prn_local_agent alone precisely so a fixture cannot stand up a session claiming to be a
  // real Codex or Claude Adapter. It carries `project:select` and nothing else, so it cannot be
  // used for the calls above.
  //
  // This used to read `token` for everything, which only worked against a data directory left over
  // from an earlier run. Against a fresh one -- all CI ever has -- setup died on the first call
  // with HTTP 403 "Credential does not have an allowed scope".
  const dashboardTokenFile = resolve(dataDir, "dashboard-token");
  const compatibilityTokenFile = resolve(dataDir, "token");
  for (
    let attempt = 0;
    attempt < 50 && !(existsSync(dashboardTokenFile) && existsSync(compatibilityTokenFile));
    attempt += 1
  ) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  const token = readFileSync(dashboardTokenFile, "utf8").trim();
  const sessionToken = readFileSync(compatibilityTokenFile, "utf8").trim();
  process.env.CROSSAGENT_E2E_TOKEN = token;
  const baseURL = String(config.projects[0]?.use.baseURL ?? "http://127.0.0.1:4390");
  const joined = await post(baseURL, token, "/api/projects/join", {
    cwd: fixture,
    name: "Ayanami Control Plane",
    allowCreate: true,
  });
  const projectId = joined.project.id;
  const objective = await post(baseURL, token, `/api/projects/${projectId}/objectives`, {
    title: "Ship an auditable CrossAgent coordination plane",
    description:
      "Connect Codex and Claude through bounded context, atomic task ownership, explicit write scopes, and independent review.",
    definitionOfDone: ["Both adapters connected", "Conflict and review gates verified"],
    status: "ACTIVE",
    idempotencyKey: "e2e-objective",
  });
  const milestones = [];
  for (const [index, title] of [
    "Protocol core",
    "Agent delivery",
    "Review assurance",
    "Release readiness",
  ].entries()) {
    milestones.push(
      await post(baseURL, token, `/api/projects/${projectId}/milestones`, {
        objectiveId: objective.id,
        title,
        description: "",
        sortOrder: index,
        weight: 1,
        idempotencyKey: `e2e-milestone-${index}`,
      }),
    );
  }
  const register = (agentId: string) =>
    post(baseURL, sessionToken, `/api/projects/${projectId}/sessions`, {
      agentId,
      role: "primary",
      client: agentId === "codex" ? "codex-app-server" : "claude-channel",
      transport: "websocket",
      deliveryMode: agentId === "codex" ? "app_server_push" : "native_channel",
      host: "e2e",
      cwd: fixture,
      capabilities:
        agentId === "codex"
          ? ["turn/steer", "thread/inject_items", "turn/start"]
          : ["claude/channel", "ack_event", "post_reply"],
      idempotencyKey: `e2e-session-${agentId}`,
    });
  const [codex, claude] = await Promise.all([register("codex"), register("claude")]);
  const heartbeatSequence = Math.floor(Date.now() / 1000);
  await Promise.all(
    [codex, claude].map((session, index) =>
      post(baseURL, sessionToken, `/api/sessions/${session.id}/heartbeat`, {
        sequence: heartbeatSequence + index,
        workState: "IDLE",
        activeFiles: [],
        queueDepth: 0,
      }),
    ),
  );
  const taskDefinitions = [
    ["Freeze shared protocol", "IN_PROGRESS", "high", codex, 0],
    ["Wire native delivery", "IN_PROGRESS", "normal", claude, 1],
    ["Validate review gate", "BLOCKED", "critical", codex, 2],
    ["Complete browser acceptance", "READY", "normal", null, 3],
    ["Publish release evidence", "DONE", "normal", null, 3],
  ] as const;
  const tasks = [];
  for (const [
    index,
    [title, status, priority, owner, milestoneIndex],
  ] of taskDefinitions.entries()) {
    const task = await post(baseURL, token, `/api/projects/${projectId}/tasks`, {
      objectiveId: objective.id,
      milestoneId: milestones[milestoneIndex].id,
      title,
      description: `${title} with bounded, independently verifiable evidence.`,
      status: owner ? "READY" : status,
      priority,
      capabilityTags: index % 2 ? ["adapter", "typescript"] : ["protocol", "sqlite"],
      scopeGlobs: index % 2 ? ["packages/**"] : ["apps/**"],
      protectedScope: priority === "critical",
      reviewRequired: status !== "DONE",
      dependsOn: [],
      weight: 1,
      idempotencyKey: `e2e-task-${index}`,
    });
    if (owner) {
      const claimed = await post(baseURL, token, `/api/tasks/${task.id}/claim`, {
        sessionId: owner.id,
        expectedVersion: task.version,
        takeoverStale: false,
        idempotencyKey: `e2e-claim-${index}`,
      });
      await fetch(`${baseURL}/api/tasks/${task.id}`, {
        method: "PATCH",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          sessionId: owner.id,
          expectedVersion: claimed.version,
          status,
          blockedReason: status === "BLOCKED" ? "Waiting for immutable patch evidence" : null,
          idempotencyKey: `e2e-task-state-${index}`,
        }),
      });
    }
    tasks.push(task);
  }
  await post(baseURL, token, `/api/projects/${projectId}/messages`, {
    fromAgentId: "claude",
    fromSessionId: claude.id,
    recipients: [{ agentId: "codex", sessionId: codex.id }],
    type: "PROPOSAL",
    priority: "IMPORTANT",
    requiresAck: true,
    requiresResponse: true,
    summary: "Freeze the event envelope before changing adapter mappings.",
    references: [{ type: "task", id: tasks[0].id }],
    idempotencyKey: "e2e-message-1",
  });
  await post(baseURL, token, `/api/projects/${projectId}/messages`, {
    fromAgentId: "codex",
    fromSessionId: codex.id,
    recipients: [{ agentId: "claude", sessionId: claude.id }],
    type: "STATUS",
    priority: "NORMAL",
    requiresAck: false,
    requiresResponse: false,
    summary: "App-server capability probe passed; steering is available.",
    references: [],
    idempotencyKey: "e2e-message-2",
  });
  await post(baseURL, token, `/api/projects/${projectId}/write-intents`, {
    taskId: tasks[0].id,
    sessionId: codex.id,
    globs: ["packages/protocol/**"],
    symbols: ["DomainEvent"],
    mode: "exclusive",
    reason: "Freeze shared event contract",
    ttlSeconds: 600,
    idempotencyKey: "e2e-intent-codex",
  });
  await post(baseURL, token, `/api/projects/${projectId}/write-intents`, {
    taskId: tasks[1].id,
    sessionId: claude.id,
    globs: ["packages/protocol/**"],
    symbols: ["DomainEvent"],
    mode: "exclusive",
    reason: "Map native delivery envelope",
    ttlSeconds: 600,
    idempotencyKey: "e2e-intent-claude",
  });
}
