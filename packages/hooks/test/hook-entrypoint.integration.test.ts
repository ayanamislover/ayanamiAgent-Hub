import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

type RecordedCall = {
  method: string;
  pathname: string;
  body: Record<string, unknown> | null;
  authorization: string;
  stdoutWasConfirmed: boolean;
};

type HookFixture = {
  root: string;
  cwd: string;
  agentTokenPath: string;
  captureTokenPath: string;
  trustManifestPath: string;
  invalidTrustManifestPath: string;
  stdoutMarkerPath: string;
};

type ChildResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolveClose) => {
          server.close(() => resolveClose());
        }),
    ),
  );
});

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function fixture(): HookFixture {
  const root = mkdtempSync(resolve(tmpdir(), "crossagent-hook-entrypoint-"));
  const cwd = resolve(root, "project");
  mkdirSync(resolve(cwd, ".crossagent"), { recursive: true });
  writeFileSync(
    resolve(cwd, ".crossagent", "project.json"),
    JSON.stringify({ schema_version: 1, project_id: "prj_entrypoint", name: "fixture" }),
  );
  const agentTokenPath = resolve(root, "agent-token");
  const captureTokenPath = resolve(root, "capture-token");
  const trustManifestPath = resolve(root, "trusted-signing-keys.json");
  const invalidTrustManifestPath = resolve(root, "untrusted-signing-keys.json");
  const stdoutMarkerPath = resolve(root, "stdout-confirmed");
  writeFileSync(agentTokenPath, "agent-token\n");
  writeFileSync(captureTokenPath, "capture-token\n");
  writeFileSync(
    trustManifestPath,
    JSON.stringify({
      schemaVersion: 1,
      keys: [
        {
          keyId: `ed25519:${"A".repeat(43)}`,
          fingerprintSha256: "0".repeat(64),
        },
      ],
    }),
  );
  // The schema is strict: an Agent must not smuggle a live key or status into the local pin file.
  writeFileSync(
    invalidTrustManifestPath,
    JSON.stringify({
      schemaVersion: 1,
      keys: [
        {
          keyId: `ed25519:${"A".repeat(43)}`,
          fingerprintSha256: "0".repeat(64),
          publicKeySpkiBase64Url: "agent-controlled-key",
        },
      ],
    }),
  );
  return {
    root,
    cwd,
    agentTokenPath,
    captureTokenPath,
    trustManifestPath,
    invalidTrustManifestPath,
    stdoutMarkerPath,
  };
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown> | null> {
  let raw = "";
  for await (const chunk of request) raw += Buffer.from(chunk).toString("utf8");
  return raw.length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : null;
}

function sendJson(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function session(
  now: string,
  cwd: string,
  clientKind: "codex" | "claude",
): Record<string, unknown> {
  return {
    id: "ses_entrypoint",
    projectId: "prj_entrypoint",
    agentId: clientKind,
    role: "primary",
    client: clientKind === "codex" ? "codex-cli-hooks" : "claude-hooks",
    transport: "hook-poll",
    deliveryMode: "hook_poll",
    externalSessionId: "external-entrypoint",
    externalThreadId: "external-entrypoint",
    externalTurnId: null,
    host: "test",
    pid: 1,
    cwd,
    gitBranch: null,
    gitHead: null,
    capabilities: [],
    connectedAt: now,
    transportLastSeenAt: now,
    activityLastSeenAt: now,
    workState: "IDLE",
    connectionState: "ONLINE",
    currentTaskId: null,
    currentReviewId: null,
    activeFiles: [],
    queueDepth: 0,
    lineageId: "lin_entrypoint",
    incarnation: 1,
    predecessorSessionId: null,
    supersededBySessionId: null,
    launcherRunId: null,
    launchGeneration: null,
    version: 0,
  };
}

async function startHubHarness(input: {
  cwd: string;
  stdoutMarkerPath: string;
  clientKind: "codex" | "claude";
}): Promise<{ baseUrl: string; calls: RecordedCall[] }> {
  const calls: RecordedCall[] = [];
  const now = new Date().toISOString();
  const message = {
    id: "msg_entrypoint",
    projectId: "prj_entrypoint",
    sequence: 1,
    threadId: "thr_entrypoint",
    replyTo: null,
    taskId: null,
    reviewId: null,
    fromAgentId: input.clientKind === "codex" ? "claude" : "codex",
    fromSessionId: null,
    type: "NOTE",
    priority: "IMPORTANT",
    requiresAck: true,
    requiresResponse: false,
    summary: "ordinary entrypoint message",
    detail: null,
    references: [],
    dedupeKey: null,
    expiresAt: null,
    createdAt: now,
    recipients: [],
  };
  const offers = new Map<string, { id: string; runId: string; bundleId: string }>();
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      const body = await readJsonBody(request);
      calls.push({
        method: request.method ?? "GET",
        pathname,
        body,
        authorization: String(request.headers.authorization ?? ""),
        stdoutWasConfirmed: existsSync(input.stdoutMarkerPath),
      });
      if (pathname.endsWith("/session-lineages/head")) {
        sendJson(response, null);
        return;
      }
      if (pathname.endsWith("/session-ticket-offers")) {
        const purpose = String(body?.purpose);
        const id = purpose === "CONTROL" ? "stk_entrypoint_control" : "stk_entrypoint_capture";
        offers.set(purpose, {
          id,
          runId: String(body?.run_id),
          bundleId: String(body?.bundle_id),
        });
        sendJson(response, {
          id,
          bundle_id: body?.bundle_id,
          purpose,
          state: "PENDING",
          project_id: "prj_entrypoint",
          adapter_client: input.clientKind,
          agent_id: input.clientKind,
          session_client: input.clientKind === "codex" ? "codex-cli-hooks" : "claude-hooks",
          role: "primary",
          transport: "hook-poll",
          delivery_mode: "hook_poll",
          external_session_id: body?.external_session_id,
          external_thread_id: body?.external_thread_id,
          run_id: body?.run_id,
          offer_expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
        });
        return;
      }
      if (pathname === "/api/user-turns/capture") {
        const rawPrompt = String(body?.raw_prompt ?? "");
        sendJson(response, {
          status: "CAPTURED",
          user_turn_id: body?.user_turn_id,
          raw_user_turn_sha256: sha256(rawPrompt),
          received_at: now,
        });
        return;
      }
      if (pathname === "/api/projects/join") {
        sendJson(response, {
          project: {
            id: "prj_entrypoint",
            name: "fixture",
            defaultBranch: "main",
            activeObjectiveId: null,
            config: {},
            version: 0,
            createdAt: now,
            updatedAt: now,
          },
          root: input.cwd,
          paths: [input.cwd],
          created: false,
        });
        return;
      }
      if (pathname.endsWith("/sessions")) {
        const control = offers.get("CONTROL");
        const capture = offers.get("CAPTURE");
        const registeredSession = {
          ...session(now, input.cwd, input.clientKind),
          externalSessionId: body?.externalSessionId,
          externalThreadId: body?.externalThreadId,
        };
        sendJson(response, {
          session: registeredSession,
          ticketBinding: {
            bundleId: body?.ticket_bundle_id,
            state: "ACTIVE",
            projectId: "prj_entrypoint",
            agentId: input.clientKind,
            adapterClient: input.clientKind,
            hubSessionId: "ses_entrypoint",
            lineageId: "lin_entrypoint",
            incarnation: 1,
            runId: control?.runId,
            activatedAt: now,
            expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
            purposes: [
              { id: control?.id, purpose: "CONTROL", state: "ACTIVE" },
              { id: capture?.id, purpose: "CAPTURE", state: "ACTIVE" },
            ],
          },
          serverNow: now,
        });
        return;
      }
      if (pathname.includes("/heartbeat")) {
        sendJson(response, session(now, input.cwd, input.clientKind));
        return;
      }
      if (pathname.includes("/reconcile-git")) {
        sendJson(response, {});
        return;
      }
      if (pathname === "/api/authority/signing-keys") {
        sendJson(response, []);
        return;
      }
      if (pathname === "/api/projects/prj_entrypoint/messages") {
        sendJson(response, [message]);
        return;
      }
      if (pathname.endsWith("/msg_entrypoint/claim")) {
        sendJson(response, message);
        return;
      }
      if (pathname.endsWith("/msg_entrypoint/surface-attempts")) {
        sendJson(response, {
          message,
          permit: {
            id: "srf_entrypoint",
            messageId: message.id,
            recipientId: "rcp_entrypoint",
            sessionId: "ses_entrypoint",
            sessionIncarnation: 1,
            recipientFence: 3,
            state: "ACTIVE",
            error: null,
            createdAt: now,
            updatedAt: now,
            confirmedAt: null,
          },
        });
        return;
      }
      if (pathname.endsWith("/msg_entrypoint/authority-delivery")) {
        sendJson(response, {
          kind: "ORDINARY",
          message: {
            id: message.id,
            threadId: message.threadId,
            priority: message.priority,
            fromAgentId: message.fromAgentId,
            summary: message.summary,
          },
          delivery: {
            projectId: "prj_entrypoint",
            carrierMessageId: message.id,
            targetAgentId: input.clientKind,
            targetSessionId: "ses_entrypoint",
            targetSessionIncarnation: 1,
            surfaceAttemptId: "srf_entrypoint",
            recipientFence: 3,
            state: "ACTIVE",
          },
        });
        return;
      }
      if (
        pathname.endsWith("/msg_entrypoint/delivered") ||
        pathname.endsWith("/msg_entrypoint/surface-attempts/srf_entrypoint/state")
      ) {
        sendJson(response, message);
        return;
      }
      sendJson(response, {});
    } catch (error) {
      sendJson(response, { error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });
  servers.push(server);
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server has no TCP address");
  return { baseUrl: `http://127.0.0.1:${address.port}`, calls };
}

function createLauncher(input: { fixture: HookFixture; mode: "confirm" | "fail" }): string {
  const launcherPath = resolve(input.fixture.root, `launcher-${input.mode}.mjs`);
  const hookUrl = pathToFileURL(resolve(dirname(import.meta.dirname), "src", "hook.ts")).href;
  const marker = JSON.stringify(input.fixture.stdoutMarkerPath);
  const implementation =
    input.mode === "confirm"
      ? `
const originalWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = function (chunk, encoding, callback) {
  const done = typeof encoding === "function" ? encoding : callback;
  return originalWrite(chunk, (error) => {
    if (!error) appendFileSync(${marker}, "stdout-ok\\n");
    if (done) done(error);
  });
};`
      : `
process.stdout.write = function (_chunk, encoding, callback) {
  const done = typeof encoding === "function" ? encoding : callback;
  queueMicrotask(() => done?.(new Error("forced_stdout_failure")));
  return false;
};`;
  writeFileSync(
    launcherPath,
    `import { appendFileSync } from "node:fs";${implementation}\nawait import(${JSON.stringify(hookUrl)});\n`,
  );
  return launcherPath;
}

async function runHook(input: {
  fixture: HookFixture;
  baseUrl: string;
  hookInput: Record<string, unknown>;
  clientKind?: "codex" | "claude";
  trustManifestPath?: string;
  stdoutMode?: "confirm" | "fail";
}): Promise<ChildResult> {
  const entrypoint = input.stdoutMode
    ? createLauncher({ fixture: input.fixture, mode: input.stdoutMode })
    : resolve(dirname(import.meta.dirname), "src", "hook.ts");
  const args = [
    "--conditions=development",
    "--import",
    "tsx",
    entrypoint,
    "--client",
    input.clientKind ?? "codex",
    "--agent-token-file",
    input.fixture.agentTokenPath,
    "--capture-token-file",
    input.fixture.captureTokenPath,
    "--spool-dir",
    resolve(input.fixture.root, "spool"),
    "--base-url",
    input.baseUrl,
  ];
  if (input.trustManifestPath) {
    args.push("--authority-trust-file", input.trustManifestPath);
  }
  const child = spawn(process.execPath, args, {
    cwd: resolve(dirname(import.meta.dirname), "..", ".."),
    env: {
      ...process.env,
      CROSSAGENT_DATA_DIR: input.fixture.root,
      NO_COLOR: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.stdin.end(JSON.stringify(input.hookInput));
  const code = await new Promise<number | null>((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    // `close` follows stdio teardown; waiting for `exit` alone can race the final stdout chunk.
    child.once("close", resolveExit);
  });
  return { code, stdout, stderr };
}

describe("Hook process entrypoint delivery boundary", () => {
  it("confirms delivery only after the real stdout write callback succeeds", async () => {
    const files = fixture();
    const hub = await startHubHarness({
      cwd: files.cwd,
      stdoutMarkerPath: files.stdoutMarkerPath,
      clientKind: "claude",
    });
    const result = await runHook({
      fixture: files,
      baseUrl: hub.baseUrl,
      clientKind: "claude",
      hookInput: {
        session_id: "external-entrypoint",
        cwd: files.cwd,
        hook_event_name: "PostToolUse",
      },
      trustManifestPath: files.trustManifestPath,
      stdoutMode: "confirm",
    });

    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      hookSpecificOutput: { hookEventName: "PostToolUse" },
    });
    expect(result.stdout).toContain("[UNVERIFIED CROSSAGENT MESSAGE]");
    const delivered = hub.calls.find((call) => call.pathname.endsWith("/delivered"));
    expect(delivered?.stdoutWasConfirmed).toBe(true);
    expect(delivered?.body).toMatchObject({
      sessionId: "ses_entrypoint",
      surfaceAttemptId: "srf_entrypoint",
      recipientFence: 3,
    });
    expect(delivered?.authorization).not.toBe("Bearer agent-token");
    expect(delivered?.authorization).not.toBe("Bearer capture-token");
  }, 15_000);

  it("marks the exact surface AMBIGUOUS when stdout completion is uncertain", async () => {
    const files = fixture();
    const hub = await startHubHarness({
      cwd: files.cwd,
      stdoutMarkerPath: files.stdoutMarkerPath,
      clientKind: "claude",
    });
    const result = await runHook({
      fixture: files,
      baseUrl: hub.baseUrl,
      clientKind: "claude",
      hookInput: {
        session_id: "external-entrypoint",
        cwd: files.cwd,
        hook_event_name: "PostToolUse",
      },
      trustManifestPath: files.trustManifestPath,
      stdoutMode: "fail",
    });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("forced_stdout_failure");
    expect(hub.calls.some((call) => call.pathname.endsWith("/delivered"))).toBe(false);
    const ambiguous = hub.calls.find((call) =>
      call.pathname.endsWith("/surface-attempts/srf_entrypoint/state"),
    );
    expect(ambiguous?.body).toMatchObject({
      sessionId: "ses_entrypoint",
      state: "AMBIGUOUS",
      error: "forced_stdout_failure",
    });
  }, 15_000);

  it.each([
    ["missing", undefined, "missing_trust_manifest"],
    ["strictly invalid", "invalid", "missing_trust_manifest"],
  ] as const)(
    "keeps capture working with a %s trust manifest and never starts coordination",
    async (_label, manifestKind, expectedReason) => {
      const files = fixture();
      const hub = await startHubHarness({
        cwd: files.cwd,
        stdoutMarkerPath: files.stdoutMarkerPath,
        clientKind: "codex",
      });
      const result = await runHook({
        fixture: files,
        baseUrl: hub.baseUrl,
        hookInput: {
          session_id: "capture-entrypoint",
          turn_id: "turn-entrypoint",
          cwd: files.cwd,
          hook_event_name: "UserPromptSubmit",
          prompt: "capture this exact prompt",
        },
        trustManifestPath: manifestKind === "invalid" ? files.invalidTrustManifestPath : undefined,
      });

      expect(result.code, result.stderr).toBe(0);
      const output = JSON.parse(result.stdout) as {
        hookSpecificOutput?: { additionalContext?: string };
      };
      expect(output.hookSpecificOutput?.additionalContext).toContain('status="CAPTURED"');
      expect(output.hookSpecificOutput?.additionalContext).toContain(
        `coordination="UNAVAILABLE" reason="${expectedReason}"`,
      );
      const captureCalls = hub.calls.filter((call) => call.pathname === "/api/user-turns/capture");
      expect(captureCalls).toHaveLength(1);
      expect(captureCalls[0]?.authorization).not.toBe("Bearer capture-token");
      expect(captureCalls[0]?.authorization).not.toBe("Bearer agent-token");
      const controlDataPlane = hub.calls.find((call) => call.pathname.includes("/heartbeat"));
      expect(captureCalls[0]?.authorization).not.toBe(controlDataPlane?.authorization);
      expect(hub.calls.some((call) => call.pathname === "/api/projects/join")).toBe(false);
    },
    15_000,
  );
});
