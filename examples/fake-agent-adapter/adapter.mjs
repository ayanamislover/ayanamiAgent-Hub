/**
 * A third-party Adapter, end to end, with nothing hidden.
 *
 * It joins a project, registers a session, then attempts every surface a real Adapter needs and
 * prints what the Hub answers. Four of those attempts are refused today; that is the point of the
 * example, and `docs/adapter-authoring.md` explains why and what would have to change.
 *
 * Deliberately dependency-free: plain `fetch` against the documented routes, so it runs from a
 * checkout with no install. A real Adapter would use `@crossagent/client`, which parses every
 * response through `@crossagent/protocol` instead of trusting it.
 *
 *   node examples/fake-agent-adapter/adapter.mjs [projectDir]
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

const baseUrl = process.env.CROSSAGENT_HUB_URL ?? "http://127.0.0.1:4387";
const dataDir = process.env.CROSSAGENT_DATA_DIR ?? resolve(homedir(), ".crossagent");
const tokenPath = resolve(dataDir, "token");
const projectDir = resolve(process.argv[2] ?? process.cwd());

const AGENT_ID = "local:fake-agent"; // a third party may only use `local:` or `manual:`
const CLIENT = "fake-client"; // ...and only this client family

let token;
try {
  token = readFileSync(tokenPath, "utf8").trim();
} catch (error) {
  console.error(`Could not read the compatibility credential at ${tokenPath}: ${error.message}`);
  console.error("Start the Hub first: crossagent setup .");
  process.exit(1);
}
console.log(`credential: ${tokenPath} (${token.length} chars, not printed)`);
console.log(`hub:        ${baseUrl}`);
console.log(`project:    ${projectDir}\n`);

async function call(method, path, payload) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(payload === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

function report(label, { status, body }) {
  const detail = status === 200 ? "" : `  ${body.code ?? "?"}: ${body.message ?? ""}`;
  console.log(`${status === 200 ? "ok    " : "refused"} ${status}  ${label}${detail}`);
  return body;
}

/**
 * A third party selects a project, it does not join one: `POST /api/projects/join` needs
 * `project:join` or `hub:dashboard`, and the compatibility credential holds neither. What it does
 * hold is `project:select`, which is enough to list the registered projects and match a directory.
 */
const listed = report("list projects", await call("GET", "/api/projects"));
if (!Array.isArray(listed)) {
  console.error("\nThe compatibility credential could not select a project.");
  process.exit(1);
}
const wanted = projectDir.replace(/\\/gu, "/").toLowerCase();
const project = listed.find((candidate) =>
  (candidate.paths ?? []).some((path) => path.replace(/\\/gu, "/").toLowerCase() === wanted),
);
if (!project) {
  console.error(`\nNo registered project has the path ${projectDir}. Run: crossagent setup .`);
  process.exit(1);
}
const projectId = project.id;
console.log(`       selected project ${projectId}`);

const session = report(
  "register session",
  await call("POST", `/api/projects/${projectId}/sessions`, {
    agentId: AGENT_ID,
    role: "primary",
    client: CLIENT,
    transport: "hook-poll",
    deliveryMode: "mailbox_only",
    host: "example",
    cwd: projectDir,
    capabilities: ["check_inbox"],
    idempotencyKey: `fake-agent-${Date.now()}`,
  }),
);

console.log("\nEverything a working Adapter actually needs:\n");

report(
  "heartbeat",
  await call("POST", `/api/sessions/${session.id}/heartbeat`, {
    sequence: 1,
    sentAt: new Date().toISOString(),
    workState: "IDLE",
    currentTurnId: null,
    activeFiles: [],
    queueDepth: 0,
  }),
);
report(
  "read the inbox",
  await call(
    "GET",
    `/api/projects/${projectId}/messages?agentId=${encodeURIComponent(AGENT_ID)}&unreadOnly=true`,
  ),
);
report(
  "post a message",
  await call("POST", `/api/projects/${projectId}/messages`, {
    fromAgentId: AGENT_ID,
    fromSessionId: session.id,
    recipients: [{ agentId: "user" }],
    type: "STATUS",
    priority: "NORMAL",
    summary: "hello from a third-party Adapter",
    idempotencyKey: `fake-agent-message-${Date.now()}`,
  }),
);

console.log("");
report("close session", await call("POST", `/api/sessions/${session.id}/close`, {}));

console.log(
  "\nThe refusals above are the current third-party boundary, not a misconfiguration.\n" +
    "See docs/adapter-authoring.md for what has to change in the Hub to lift it.",
);
