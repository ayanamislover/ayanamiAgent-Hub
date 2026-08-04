/**
 * Seed a disposable Hub with a worked Codex x Claude collaboration, so the Dashboard can be
 * evaluated without owning two agent subscriptions.
 *
 * Everything below is drawn from this repository's own collaboration log and then anonymised:
 * machine paths, commit hashes, message ids and session ids are replaced, and the technical
 * substance is kept. Inventing the content would have produced a demo where the reviewer only
 * ever finds tidy, obvious defects -- which is exactly the impression worth not giving. The real
 * log includes a reviewer retracting its own blocking finding after measuring wrong, and that
 * round is kept here for the same reason.
 *
 * It writes to output/demo/ and nothing else. Delete that directory to undo it entirely; the
 * Hub you normally run is never touched.
 *
 *   pnpm demo
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { createHubServer } from "../test/test-server.js";

const workspaceRoot = resolve(import.meta.dirname, "../../..");
const dataDir = resolve(workspaceRoot, "output/demo");

// Refuse to delete anything that is not the disposable demo directory this script owns.
if (!dataDir.replaceAll("\\", "/").endsWith("/output/demo")) {
  throw new Error(`Refusing to reset ${dataDir}: not the demo directory`);
}
if (existsSync(dataDir)) {
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch (error) {
    // Almost always a demo Hub from a previous run still holding its own database open. Saying so
    // beats an EPERM on a path the reader has no reason to recognise.
    throw new Error(
      `Could not reset ${dataDir}. If a demo Hub is still running, stop it first:\n` +
        `  PowerShell:  $env:CROSSAGENT_DATA_DIR='output/demo'; pnpm crossagent stop\n` +
        `  bash:        CROSSAGENT_DATA_DIR=output/demo pnpm crossagent stop\n` +
        `(${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

// The demo gets its own throwaway repository rather than borrowing this checkout. Joining the
// checkout reads whatever .crossagent/project.json already sits there, so on a machine that has
// used the Hub before, the demo shows up under someone else's project name -- and its reviews get
// cut against real history. A private repo makes the demo identical everywhere.
const demoRepo = resolve(dataDir, "workspace");
mkdirSync(demoRepo, { recursive: true });
const git = (...args: string[]): string => {
  const run = spawnSync("git", args, { cwd: demoRepo, encoding: "utf8", windowsHide: true });
  if (run.status !== 0) throw new Error(`git ${args[0]} failed: ${run.stderr || run.stdout}`);
  return run.stdout.trim();
};
git("init", "--quiet", "--initial-branch=main");
git("config", "user.email", "demo@example.invalid");
git("config", "user.name", "CrossAgent demo");
writeFileSync(resolve(demoRepo, "README.md"), "# CrossAgent demo workspace\n");
git("add", "README.md");
git("commit", "--quiet", "-m", "demo baseline");

/** Commit one change and return the range it occupies, so a review has a real patch to show. */
function commitChange(file: string, body: string, subject: string): { base: string; head: string } {
  const base = git("rev-parse", "HEAD");
  writeFileSync(resolve(demoRepo, file), body);
  git("add", file);
  git("commit", "--quiet", "-m", subject);
  return { base, head: git("rev-parse", "HEAD") };
}

const terminalRange = commitChange(
  "terminal.ts",
  `export function onFrame(frame: Frame, socket: Attached): void {\n` +
    `  // Re-read the grant on every frame: a socket that attached before a revocation must not\n` +
    `  // keep writing. The kill path stays grant-free so a runaway process can always be stopped.\n` +
    `  if (!hasLiveGrant(socket.projectId)) return socket.rejectAndDetach("authorization revoked");\n` +
    `  forward(frame);\n` +
    `}\n`,
  "Re-check the live grant on every terminal frame",
);
const steerRange = commitChange(
  "bridge.ts",
  `const TURN_ROLLED_OVER = -32602;\n\n` +
    `async function steer(message: Message): Promise<void> {\n` +
    `  try {\n` +
    `    await appServer.steer(message);\n` +
    `  } catch (error) {\n` +
    `    if (error.code !== TURN_ROLLED_OVER) throw error;\n` +
    `    await appServer.inject(message);\n` +
    `  }\n` +
    `}\n`,
  "Fall back to inject when a steer is refused mid-turn",
);
const mascotRange = commitChange(
  "overview.css",
  `.agent-backdrop {\n  display: grid;\n  opacity: 0.35;\n}\n\n` +
    `@media (max-width: 2499px) {\n  .agent-backdrop {\n    display: none;\n  }\n}\n`,
  "Show the agent mascots on the Overview page",
);
const headSha = git("rev-parse", "HEAD");

const server = await createHubServer({ dataDir, logLevel: "silent" });

type Json = Record<string, any>;

// Control-plane setup runs as the Dashboard principal; the agent credential is deliberately
// scoped too narrowly to register projects, which is the same boundary a real Bridge sits behind.
async function api<T = Json>(
  method: "GET" | "POST" | "PATCH",
  path: string,
  body?: unknown,
  as: "dashboard" | "agent" = "dashboard",
): Promise<T> {
  const token = as === "agent" ? server.token : server.credentials.dashboard.token;
  const response = await server.app.inject({
    method,
    url: path,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
  if (response.statusCode >= 300) {
    throw new Error(`${method} ${path} -> ${response.statusCode} ${response.body}`);
  }
  return response.json() as T;
}

let keySeed = 0;
const key = (name: string) => `demo-${name}-${(keySeed += 1)}`;

try {
  const { project } = await api<Json>("POST", "/api/projects/join", {
    cwd: demoRepo,
    name: "CrossAgent demo",
    allowCreate: true,
  });
  const projectId = project.id;

  const objective = await api<Json>("POST", `/api/projects/${projectId}/objectives`, {
    title: "Two agents review each other's work before it lands",
    description:
      "Codex implements, Claude reviews, and either one may block the other. Findings are " +
      "evidence-bearing and a task cannot complete while a blocking finding is open.",
    definitionOfDone: [
      "Every landed change carries an independent review",
      "No task reaches DONE with an unresolved blocking finding",
    ],
    status: "ACTIVE",
    idempotencyKey: key("objective"),
  });

  // Sessions go through the store rather than REST on purpose. Over HTTP a static credential is
  // refused a real agent session -- it may only create an explicitly-namespaced compatibility one
  // -- which is the correct fence and the reason a Bridge enrols with a session ticket instead.
  // A seeder legitimately sits below that boundary; everything after this point goes over REST.
  const session = (
    agentId: string,
    role: "primary" | "reviewer",
    client: "codex-app-server" | "claude-channel",
  ) => {
    const base = {
      projectId,
      agentId,
      role,
      client,
      transport: "websocket",
      deliveryMode: "native_channel",
      cwd: demoRepo,
      gitHead: headSha,
      capabilities: ["review", "implement"],
      // A real client is identified by its own thread, not by its agent name, so that a restarted
      // Bridge is recognised as the same logical session rather than a second agent.
      externalSessionId: `demo-${agentId}-session`,
      externalThreadId: `demo-${agentId}-thread`,
      idempotencyKey: key(`session-${agentId}`),
    };
    if (client !== "codex-app-server") return server.store.registerSession(base);
    // A managed Codex Bridge must reserve its launch before it may take the session head, so that
    // a restart cannot silently displace a Bridge that is still running.
    const reservation = server.store.reserveSessionLaunch(projectId, {
      agentId: base.agentId,
      client: base.client,
      deliveryMode: base.deliveryMode,
      externalThreadId: base.externalThreadId,
      externalSessionId: base.externalSessionId,
      runId: `run_demo_${agentId}`,
      idempotencyKey: key(`reserve-${agentId}`),
    });
    return server.store.registerSession({
      ...base,
      expectedHeadSessionId: reservation.expectedHeadSessionId,
      launcherRunId: reservation.runId,
      launchGeneration: reservation.generation,
    });
  };
  const codex = session("codex", "primary", "codex-app-server");
  const claude = session("claude", "reviewer", "claude-channel");

  const task = async (input: {
    title: string;
    description: string;
    priority: "high" | "medium" | "low";
    scopeGlobs: string[];
  }) =>
    api<Json>("POST", `/api/projects/${projectId}/tasks`, {
      objectiveId: objective.id,
      status: "READY",
      capabilityTags: ["implement"],
      reviewRequired: true,
      dependsOn: [],
      weight: 1,
      idempotencyKey: key("task"),
      ...input,
    });

  // ---- Round 1: Codex reviews Claude, files a blocking security finding, and it gets fixed.
  const terminalTask = await task({
    title: "Re-check the live grant on every terminal frame, not only on attach",
    description:
      "Revoking terminal.unrestricted must stop an already-attached socket, not just refuse the " +
      "next attach.",
    priority: "high",
    scopeGlobs: ["apps/hub/src/api/**", "apps/dashboard/src/pages/console.tsx"],
  });
  await api("POST", `/api/tasks/${terminalTask.id}/claim`, {
    sessionId: claude.id,
    expectedVersion: terminalTask.version,
    takeoverStale: false,
    idempotencyKey: key("claim"),
  });
  const terminalReview = await api<Json>("POST", `/api/tasks/${terminalTask.id}/reviews`, {
    sessionId: claude.id,
    reviewerAgentId: codex.agentId,
    baseSha: terminalRange.base,
    headSha: terminalRange.head,
    acceptanceCriteria: [
      "A revoked grant stops input on a socket that attached before the revocation",
      "Stopping the process stays possible without a grant",
    ],
    testEvidence: [{ command: "pnpm test", exitCode: 0, outputSummary: "hub suite green" }],
    authorClaims: ["Authorization is enforced at attach and at spawn"],
    knownRisks: [],
    includeUncommitted: false,
    idempotencyKey: key("review"),
  });
  const terminalBegun = await api<Json>("POST", `/api/reviews/${terminalReview.id}/begin`, {
    sessionId: codex.id,
    expectedVersion: terminalReview.version,
    idempotencyKey: key("begin"),
  });
  const revocationFinding = await api<Json>("POST", `/api/reviews/${terminalReview.id}/findings`, {
    sessionId: codex.id,
    severity: "blocking",
    category: "security",
    title: "Revocation still permits input on an already-attached terminal",
    claim:
      "After terminal.unrestricted is revoked, a socket attached before the revocation can keep " +
      "sending input and resize frames: authorization is checked in attach and spawn only, while " +
      "write and resize receive nothing but the terminal id.",
    impact:
      "The Dashboard states that authorization can be revoked at any time, but the user has not " +
      "actually revoked control of a terminal that is already open. Commands keep running " +
      "without a live grant until the socket happens to disconnect.",
    filePath: "apps/hub/src/api/routes.ts",
    symbol: "terminalSocket",
    evidence: [{ kind: "manual", note: "grant -> attach -> revoke -> input still forwarded" }],
    suggestedDirection:
      "Do not kill the process on revoke. Keep the attached project id, re-check that project's " +
      "live grant before every input and resize, and on failure send an authorization error and " +
      "detach the socket. Leave the kill path grant-free. Regression: grant, attach, revoke, " +
      "assert input and resize are rejected while stopping the process still works.",
    idempotencyKey: key("finding"),
  });
  await api("POST", `/api/findings/${revocationFinding.id}/resolve`, {
    sessionId: claude.id,
    status: "FIXED",
    resolution:
      "Every frame now re-reads the grant for the attached project. The kill path stays " +
      "grant-free so a runaway process can always be stopped.",
    idempotencyKey: key("fixed"),
  });
  await api("POST", `/api/findings/${revocationFinding.id}/resolve`, {
    sessionId: codex.id,
    status: "VERIFIED",
    resolution: "Reproduced the original sequence: input is now refused after revocation.",
    idempotencyKey: key("verified"),
  });
  await api("POST", `/api/reviews/${terminalReview.id}/verdict`, {
    sessionId: codex.id,
    expectedVersion: terminalBegun.version,
    verdict: "APPROVED",
    summary: "The blocking finding is resolved and independently verified.",
    idempotencyKey: key("verdict"),
  });

  // ---- Round 2: Claude reviews Codex. Green tests, wrong error code -- still open.
  const steerTask = await task({
    title: "Fall back to inject when a steer is refused mid-turn",
    description:
      "A cross-agent message must not be dropped when the Codex app-server rolls the turn over " +
      "between the read and the steer.",
    priority: "high",
    scopeGlobs: ["packages/codex-bridge/src/bridge.ts"],
  });
  await api("POST", `/api/tasks/${steerTask.id}/claim`, {
    sessionId: codex.id,
    expectedVersion: steerTask.version,
    takeoverStale: false,
    idempotencyKey: key("claim"),
  });
  const steerReview = await api<Json>("POST", `/api/tasks/${steerTask.id}/reviews`, {
    sessionId: codex.id,
    reviewerAgentId: claude.agentId,
    baseSha: steerRange.base,
    headSha: steerRange.head,
    acceptanceCriteria: ["A refused steer falls back to inject rather than dropping the message"],
    testEvidence: [
      {
        command: "pnpm --filter @crossagent/codex-bridge test",
        exitCode: 0,
        outputSummary: "green",
      },
    ],
    authorClaims: ["The fallback is covered by two regression tests"],
    knownRisks: [],
    includeUncommitted: false,
    idempotencyKey: key("review"),
  });
  const steerBegun = await api<Json>("POST", `/api/reviews/${steerReview.id}/begin`, {
    sessionId: claude.id,
    expectedVersion: steerReview.version,
    idempotencyKey: key("begin"),
  });
  await api("POST", `/api/reviews/${steerReview.id}/findings`, {
    sessionId: claude.id,
    severity: "high",
    category: "correctness",
    title: "The fallback matches the wrong JSON-RPC code, so a real turn rollover is dropped",
    claim:
      "steer() falls back to inject only when error.code is -32602 and rethrows otherwise. The " +
      'app-server returns -32600 on a turn rollover; the captured stderr reads "expected active ' +
      'turn id ... but found ..." with code -32600. Both regression tests assert -32602 and ' +
      "-32000, so neither uses the code that actually occurs and the suite stays green.",
    impact:
      "The rethrow is swallowed by the frame handler, so the message is neither steered nor " +
      "injected nor marked delivered. Cross-agent messages disappear silently under exactly the " +
      "race this fallback exists to cover, and the passing tests argue that they do not.",
    filePath: "packages/codex-bridge/src/bridge.ts",
    symbol: "steer",
    evidence: [{ kind: "stderr", note: "app-server error -32600 on turn rollover" }],
    suggestedDirection:
      "Include -32600. Better: fall back to inject on any steer failure -- inject is always " +
      "semantically safe, and narrowing by error code does not buy enough to be worth losing a " +
      "message silently. Make -32600 the primary test case.",
    idempotencyKey: key("finding"),
  });
  await api("POST", `/api/reviews/${steerReview.id}/verdict`, {
    sessionId: claude.id,
    expectedVersion: steerBegun.version,
    verdict: "CHANGES_REQUESTED",
    summary:
      "The mechanism is right and the tests are green, but they pin codes that production does " +
      "not emit. One high finding, no blocking finding.",
    idempotencyKey: key("verdict"),
  });

  // ---- The reviewer being wrong, kept deliberately.
  const mascotTask = await task({
    title: "Show the agent mascots on the Overview page",
    description: "Decorative only; the user asked for them on an ultrawide display.",
    priority: "low",
    scopeGlobs: ["apps/dashboard/src/pages/overview.tsx"],
  });
  await api("POST", `/api/tasks/${mascotTask.id}/claim`, {
    sessionId: codex.id,
    expectedVersion: mascotTask.version,
    takeoverStale: false,
    idempotencyKey: key("claim"),
  });
  const mascotReview = await api<Json>("POST", `/api/tasks/${mascotTask.id}/reviews`, {
    sessionId: codex.id,
    reviewerAgentId: claude.agentId,
    baseSha: mascotRange.base,
    headSha: mascotRange.head,
    acceptanceCriteria: ["The mascots appear on the display the user actually uses"],
    testEvidence: [
      { command: "pnpm test:e2e", exitCode: 0, outputSummary: "dashboard specs green" },
    ],
    authorClaims: ["Breakpoint chosen deliberately for the user's ultrawide display"],
    knownRisks: ["Hidden below 2499px by design"],
    includeUncommitted: false,
    idempotencyKey: key("review"),
  });
  const mascotBegun = await api<Json>("POST", `/api/reviews/${mascotReview.id}/begin`, {
    sessionId: claude.id,
    expectedVersion: mascotReview.version,
    idempotencyKey: key("begin"),
  });
  await api("POST", `/api/reviews/${mascotReview.id}/findings`, {
    sessionId: claude.id,
    severity: "info",
    category: "maintainability",
    title: "The 2499px breakpoint means the mascots only ever show on an ultrawide display",
    claim:
      "The media query hides the whole backdrop below 2499px; at 1920 and 1280 the images " +
      "measure 0x0.",
    impact:
      "This is a deliberate trade-off, not a defect. I first filed it as blocking, which was " +
      "wrong -- I measured it in my own 1920 pane, and the user confirmed it renders correctly " +
      "on the display it was built for and asked for it to stay. Retracted and kept on record " +
      "as known behaviour.",
    filePath: "apps/dashboard/src/pages/overview.tsx",
    evidence: [
      { kind: "retraction", note: "originally filed blocking; withdrawn by the reviewer" },
    ],
    suggestedDirection: "Leave the breakpoint alone.",
    idempotencyKey: key("finding"),
  });
  await api("POST", `/api/reviews/${mascotReview.id}/verdict`, {
    sessionId: claude.id,
    expectedVersion: mascotBegun.version,
    verdict: "APPROVED",
    summary: "Approved. My earlier blocking call was my measurement error, not a defect.",
    idempotencyKey: key("verdict"),
  });

  // ---- The human's own notes on the Communications page.
  //
  // These are posted as the local user, and read as the local user, because that is what they are:
  // the Hub takes a message's sender from the credential that called it, never from a field in the
  // body. Composing as Codex or Claude needs that agent's session ticket, which a seeder cannot
  // mint and should not be able to -- so the agents speak here only through the review traffic
  // above, which their own sessions authored. Demonstrating the compose box is the honest use of
  // the remaining four.
  const say = (
    to: "codex" | "claude",
    input: {
      type: string;
      priority: "BACKGROUND" | "NORMAL" | "IMPORTANT" | "INTERRUPT";
      summary: string;
      detail?: string;
    },
  ) =>
    api("POST", `/api/projects/${projectId}/messages`, {
      // The schema requires a sender and the Hub then overrides it from the calling credential;
      // this is the name the Dashboard's own compose box sends, so the demo matches what a user
      // typing into it would produce.
      fromAgentId: "Local User",
      recipients: [{ agentId: to }],
      requiresAck: input.priority === "IMPORTANT" || input.priority === "INTERRUPT",
      requiresResponse: false,
      idempotencyKey: key("message"),
      ...input,
    });

  await say("claude", {
    type: "QUESTION",
    priority: "IMPORTANT",
    summary: "Is the -32600 finding a blocker for shipping, or can it land behind a follow-up?",
    detail:
      "You filed it high rather than blocking. I want to know whether that was a judgement about " +
      "severity or about scope before I decide the order of work.",
  });
  await say("codex", {
    type: "DECISION",
    priority: "IMPORTANT",
    summary: "Take the wider fallback: inject on any steer failure, not only on -32600.",
    detail:
      "Losing a message silently costs more than an occasional redundant inject. Make -32600 the " +
      "primary test case so the suite fails for the reason production would.",
  });
  await say("codex", {
    type: "STATUS",
    priority: "NORMAL",
    summary: "The mascot breakpoint stays as it is. Claude already withdrew that finding.",
    detail: "It renders correctly on the display it was built for. No change wanted.",
  });
  await say("claude", {
    type: "QUESTION",
    priority: "NORMAL",
    summary: "Which of the three open findings would you fix first, and why that one?",
  });

  const overview = await api<Json>("GET", `/api/projects/${projectId}/overview`);
  console.log(`Seeded ${dataDir}`);
  console.log(
    `  ${overview.tasks.length} tasks, ${overview.sessions.length} agents, ` +
      `3 review rounds, 3 findings, 4 messages`,
  );
  // One Hub per built workspace: the runtime lease lives in .crossagent-build, not in the data
  // directory, so pointing a second Hub at output/demo while your own is up fails on the lease
  // rather than on anything to do with the demo. Stopping first is the whole of the workaround.
  console.log("\nStop your own Hub first if it is running -- one Hub per workspace:\n");
  console.log("  crossagent stop\n");
  console.log("Then start against the demo data (your own database is not opened):\n");
  console.log("  PowerShell:  $env:CROSSAGENT_DATA_DIR='output/demo'; pnpm start --open");
  console.log("  bash:        CROSSAGENT_DATA_DIR=output/demo pnpm start --open\n");
  console.log("Unset CROSSAGENT_DATA_DIR and start again to go back to your own Hub.");
  console.log("Delete output/demo to remove the demo entirely.");
} finally {
  await server.close();
}
