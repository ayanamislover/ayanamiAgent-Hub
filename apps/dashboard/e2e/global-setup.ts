import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { FullConfig } from "@playwright/test";
import { SECONDARY_PROJECT_NAME, fixtureProject, resetFixtureProjects } from "./fixture-paths.js";

/**
 * The exact capability bundle each Adapter client must present, mirroring
 * SESSION_TICKET_PURPOSES_BY_CLIENT. Activation rejects a bundle that is missing a purpose or
 * carries a spare one, so this list is the contract, not a convenience.
 */
const ADAPTERS = [
  {
    agentId: "codex",
    client: "codex-app-server",
    deliveryMode: "app_server_push",
    purposes: ["CONTROL", "MODEL_MCP", "INJECTOR"],
    capabilities: ["turn/steer", "thread/inject_items", "turn/start"],
  },
  {
    agentId: "claude",
    client: "claude-channel",
    deliveryMode: "native_channel",
    purposes: ["CONTROL"],
    capabilities: ["claude/channel", "ack_event", "post_reply"],
  },
] as const;

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
  resetFixtureProjects();
  const fixture = fixtureProject("control-plane");
  // Four credentials, because the Hub deliberately splits them and no single one can do all of this.
  //
  // `dashboard-token` (`hub:dashboard`) drives everything the Dashboard itself can do: joining the
  // project, reserving an Adapter launch, and creating objectives, milestones, tasks, messages and
  // write intents.
  //
  // `agent-<client>-token` carries `session-ticket:offer` and is what actually enrolls a session:
  // it offers the CONTROL and MODEL_MCP tickets. `inject-codex-token` offers the INJECTOR ticket,
  // which no other static credential may offer.
  //
  // This used to register sessions with the compatibility bearer instead, which meant the fixture
  // was standing up sessions that merely claimed to be Codex and Claude. The Hub closed that door
  // -- assertCanCreateAdapterSession now admits prn_local_agent only for fake-client sessions in a
  // `manual:` or `local:` Agent namespace -- so the fixture now does what a real Adapter does.
  const credentialFiles = {
    dashboard: resolve(dataDir, "dashboard-token"),
    codexAgent: resolve(dataDir, "agent-codex-token"),
    claudeAgent: resolve(dataDir, "agent-claude-token"),
    codexInjector: resolve(dataDir, "inject-codex-token"),
  };
  const paths = Object.values(credentialFiles);
  for (let attempt = 0; attempt < 50 && !paths.every((path) => existsSync(path)); attempt += 1) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  const read = (path: string) => readFileSync(path, "utf8").trim();
  const token = read(credentialFiles.dashboard);
  const offerTokens = {
    codex: {
      agent: read(credentialFiles.codexAgent),
      injector: read(credentialFiles.codexInjector),
    },
    claude: { agent: read(credentialFiles.claudeAgent), injector: "" },
  };
  process.env.CROSSAGENT_E2E_TOKEN = token;
  const baseURL = String(config.projects[0]?.use.baseURL ?? "http://127.0.0.1:4390");
  // The Dashboard defaults to the most recently joined project, so the secondary project the
  // navigation case needs is created first and never touched again. Created inside that case
  // instead, it would become the default for every case that ran after it.
  await post(baseURL, token, "/api/projects/join", {
    cwd: fixtureProject("navigation"),
    name: SECONDARY_PROJECT_NAME,
    allowCreate: true,
  });
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
  // Enroll each Adapter the way the Bridge does: reserve the launch, offer the client's exact
  // ticket bundle against that reservation, then register the session authenticated by the raw
  // CONTROL token. The Hub only ever sees each ticket's SHA-256; the raw token stays here.
  const enroll = async (adapter: (typeof ADAPTERS)[number]) => {
    const { agentId, client, deliveryMode, purposes, capabilities } = adapter;
    const externalSessionId = `e2e-external-${agentId}`;
    const reservation = await post(
      baseURL,
      token,
      `/api/projects/${projectId}/session-launch-reservations`,
      {
        agentId,
        client,
        deliveryMode,
        externalSessionId,
        runId: `run-e2e-${agentId}`,
        idempotencyKey: `e2e-reservation-${agentId}`,
      },
    );
    const bundleId = `stb_e2e_${agentId}`;
    const rawTickets: Record<string, string> = {};
    for (const purpose of purposes) {
      const raw = randomBytes(32).toString("base64url");
      rawTickets[purpose] = raw;
      const offerer =
        purpose === "INJECTOR" ? offerTokens[agentId].injector : offerTokens[agentId].agent;
      await post(baseURL, offerer, `/api/projects/${projectId}/session-ticket-offers`, {
        bundle_id: bundleId,
        purpose,
        token_sha256: createHash("sha256").update(raw).digest("hex"),
        adapter_client: agentId,
        agent_id: agentId,
        session_client: client,
        role: "primary",
        transport: "websocket",
        delivery_mode: deliveryMode,
        external_session_id: externalSessionId,
        external_thread_id: null,
        run_id: reservation.runId,
        activation_mode: "MANAGED_RESERVATION",
        expected_lineage_id: reservation.lineageId,
        expected_head_session_id: reservation.expectedHeadSessionId,
        launch_reservation_id: reservation.id,
        idempotency_key: `e2e-offer-${agentId}-${purpose}`,
      });
    }
    const control = rawTickets.CONTROL!;
    const receipt = await post(baseURL, control, `/api/projects/${projectId}/sessions`, {
      agentId,
      role: "primary",
      client,
      transport: "websocket",
      deliveryMode,
      externalSessionId,
      host: "e2e",
      cwd: fixture,
      capabilities,
      expectedHeadSessionId: reservation.expectedHeadSessionId,
      launcherRunId: reservation.runId,
      launchGeneration: reservation.generation,
      ticket_bundle_id: bundleId,
      idempotencyKey: `e2e-session-${agentId}`,
    });
    return { session: receipt.session, control };
  };
  const [codexAdapter, claudeAdapter] = [await enroll(ADAPTERS[0]), await enroll(ADAPTERS[1])];
  const codex = codexAdapter.session;
  const claude = claudeAdapter.session;
  // Anything attributed to an Agent must be authored by that Agent's own CONTROL ticket. The
  // Dashboard credential is refused outright ("Dashboard messages cannot claim an Agent session"),
  // which is the whole point: authorship is not a field the caller gets to fill in.
  const codexControl = codexAdapter.control;
  const claudeControl = claudeAdapter.control;
  // Presence is derived from the transport, and a session that stops beating is OFFLINE after
  // twenty seconds. A single heartbeat here left both Agents offline before the second browser case
  // even started, so every assertion about a live session failed. Beat for as long as the run
  // lasts, which is what an attached Adapter does.
  const enrolled = [codexAdapter, claudeAdapter];
  let heartbeatSequence = Math.floor(Date.now() / 1000);
  const beat = () =>
    Promise.all(
      enrolled.map((adapter) =>
        post(baseURL, adapter.control, `/api/sessions/${adapter.session.id}/heartbeat`, {
          sequence: heartbeatSequence,
          workState: "IDLE",
          activeFiles: [],
          queueDepth: 0,
        }),
      ),
    );
  await beat();
  const heartbeat = setInterval(() => {
    heartbeatSequence += 1;
    void beat().catch(() => undefined);
  }, 5_000);
  heartbeat.unref();
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
  await post(baseURL, claudeControl, `/api/projects/${projectId}/messages`, {
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
  await post(baseURL, codexControl, `/api/projects/${projectId}/messages`, {
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
  await post(baseURL, codexControl, `/api/projects/${projectId}/write-intents`, {
    taskId: tasks[0].id,
    sessionId: codex.id,
    globs: ["packages/protocol/**"],
    symbols: ["DomainEvent"],
    mode: "exclusive",
    reason: "Freeze shared event contract",
    ttlSeconds: 600,
    idempotencyKey: "e2e-intent-codex",
  });
  await post(baseURL, claudeControl, `/api/projects/${projectId}/write-intents`, {
    taskId: tasks[1].id,
    sessionId: claude.id,
    globs: ["packages/protocol/**"],
    symbols: ["DomainEvent"],
    mode: "exclusive",
    reason: "Map native delivery envelope",
    ttlSeconds: 600,
    idempotencyKey: "e2e-intent-claude",
  });
  return () => clearInterval(heartbeat);
}
