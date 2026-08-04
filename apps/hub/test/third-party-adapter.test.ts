import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HubServer } from "../src/server.js";
import { createHubServer } from "./test-server.js";

/**
 * The boundary a third-party Adapter meets today, pinned so `docs/adapter-authoring.md` cannot
 * quietly become a promise the Hub does not keep.
 *
 * A non-Codex, non-Claude client can create and close a session record, and nothing else: every
 * working surface — heartbeat, inbox, acknowledgement, posting — is gated on `hub:session`, which
 * only a session ticket carries, and tickets are only offered by the per-client static credentials
 * the Hub provisions for the two known client families. The compatibility credential deliberately
 * holds `project:select` alone.
 *
 * These assertions are the specification of what has to change before a third party can enroll, not
 * a wish list: each 403 here is one gate, and widening the compatibility credential to open them is
 * the wrong fix, because that credential is the one recorded as disclosed in
 * docs/known-limitations.md.
 */

describe("third-party Adapter enrollment boundary", () => {
  let server: HubServer;

  afterEach(async () => {
    await server?.close();
  });

  async function hub() {
    const root = mkdtempSync(resolve(tmpdir(), "crossagent-third-party-"));
    const projectRoot = resolve(root, "project");
    mkdirSync(projectRoot, { recursive: true });
    server = await createHubServer({
      databasePath: resolve(root, "hub.db"),
      dataDir: resolve(root, "data"),
      dashboardDir: resolve(root, "missing-dashboard"),
      host: "127.0.0.1",
      port: 0,
      logLevel: "silent",
    });
    const call = (method: "GET" | "POST", url: string, token: string, payload?: unknown) =>
      server.app.inject({
        method,
        url,
        headers: { authorization: `Bearer ${token}` },
        ...(payload === undefined ? {} : { payload: payload as object }),
      });
    const joined = await call("POST", "/api/projects/join", server.credentials.dashboard.token, {
      cwd: projectRoot,
      allowCreate: true,
    });
    return {
      call,
      projectRoot,
      projectId: (joined.json() as { project: { id: string } }).project.id,
      compat: server.credentials.agent.token,
      dashboard: server.credentials.dashboard.token,
    };
  }

  function registration(projectRoot: string, overrides: Record<string, unknown> = {}) {
    return {
      agentId: "local:example",
      role: "primary",
      client: "fake-client",
      transport: "hook-poll",
      deliveryMode: "mailbox_only",
      host: "example",
      cwd: projectRoot,
      capabilities: ["check_inbox"],
      idempotencyKey: "example-session",
      ...overrides,
    };
  }

  it("registers and closes a fake-client session in an explicit local namespace", async () => {
    const { call, compat, projectId, projectRoot } = await hub();

    const session = await call(
      "POST",
      `/api/projects/${projectId}/sessions`,
      compat,
      registration(projectRoot),
    );

    expect(session.statusCode).toBe(200);
    expect(session.json()).toMatchObject({
      agentId: "local:example",
      client: "fake-client",
      deliveryMode: "mailbox_only",
    });

    const closed = await call(
      "POST",
      `/api/sessions/${(session.json() as { id: string }).id}/close`,
      compat,
      { reason: "client_closed" },
    );
    expect(closed.statusCode).toBe(200);
  });

  it("refuses a borrowed client family or an unnamespaced agent id", async () => {
    const { call, compat, projectId, projectRoot } = await hub();

    const borrowedFamily = await call(
      "POST",
      `/api/projects/${projectId}/sessions`,
      compat,
      registration(projectRoot, { client: "codex-app-server", idempotencyKey: "borrowed-family" }),
    );
    expect(borrowedFamily.statusCode).toBe(403);

    const borrowedIdentity = await call(
      "POST",
      `/api/projects/${projectId}/sessions`,
      compat,
      registration(projectRoot, { agentId: "codex", idempotencyKey: "borrowed-identity" }),
    );
    expect(borrowedIdentity.statusCode).toBe(403);
  });

  it("admits only the compatibility credential, not the Dashboard or a first-party Agent one", async () => {
    const { call, dashboard, projectId, projectRoot } = await hub();

    for (const [label, token] of [
      ["dashboard", dashboard],
      ["codex agent", server.credentials.agentByClient.codex.token],
    ] as const) {
      const response = await call(
        "POST",
        `/api/projects/${projectId}/sessions`,
        token,
        registration(projectRoot, { idempotencyKey: `${label}-session` }),
      );
      expect(response.statusCode, label).toBe(403);
    }
  });

  it("leaves every working surface closed to it, because each one needs a session ticket", async () => {
    const { call, compat, dashboard, projectId, projectRoot } = await hub();
    const session = await call(
      "POST",
      `/api/projects/${projectId}/sessions`,
      compat,
      registration(projectRoot),
    );
    const sessionId = (session.json() as { id: string }).id;
    const posted = await call("POST", `/api/projects/${projectId}/messages`, dashboard, {
      fromAgentId: "user",
      recipients: [{ agentId: "local:example" }],
      type: "STATUS",
      priority: "NORMAL",
      summary: "hello adapter",
      idempotencyKey: "example-message",
    });
    expect(posted.statusCode).toBe(200);
    const messageId = (posted.json() as { id: string }).id;

    const attempts = [
      [
        "heartbeat",
        await call("POST", `/api/sessions/${sessionId}/heartbeat`, compat, {
          sequence: 1,
          sentAt: new Date().toISOString(),
          workState: "IDLE",
          currentTurnId: null,
          activeFiles: [],
          queueDepth: 0,
        }),
      ],
      [
        "inbox",
        await call(
          "GET",
          `/api/projects/${projectId}/messages?agentId=local:example&unreadOnly=true`,
          compat,
        ),
      ],
      [
        "ack",
        await call("POST", `/api/messages/${messageId}/ack`, compat, {
          agentId: "local:example",
          sessionId,
        }),
      ],
      [
        "reply",
        await call("POST", `/api/projects/${projectId}/messages`, compat, {
          fromAgentId: "local:example",
          fromSessionId: sessionId,
          recipients: [{ agentId: "user" }],
          type: "STATUS",
          priority: "NORMAL",
          summary: "got it",
          idempotencyKey: "example-reply",
        }),
      ],
    ] as const;

    for (const [label, response] of attempts) {
      expect(response.statusCode, label).toBe(403);
      expect(response.json(), label).toMatchObject({ code: "FORBIDDEN" });
    }
  });
});
