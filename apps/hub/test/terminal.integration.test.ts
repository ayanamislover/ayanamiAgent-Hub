import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HubServer } from "../src/server.js";
import { createHubServer } from "./test-server.js";
import type { PtyProcess, PtySpawner } from "../src/services/pty-service.js";

/**
 * The console's terminal path is covered here rather than in hub.integration.test.ts because it
 * needs a pty seam: a real shell would make the suite depend on a native build and on process
 * timing, and neither is what these assertions are about.
 */

type FakePty = {
  pid: number;
  shell: string;
  args: string[];
  cols: number;
  rows: number;
  env: Record<string, string>;
  written: string[];
  killed: boolean;
  emit: (chunk: string) => void;
  exit: (code: number) => void;
};

function createSpawnerHarness(): {
  spawner: PtySpawner;
  created: FakePty[];
  failNextSpawn: (error: Error) => void;
} {
  const created: FakePty[] = [];
  let nextPid = 4000;
  let pendingFailure: Error | null = null;

  const spawner: PtySpawner = (shell, args, options) => {
    if (pendingFailure) {
      const failure = pendingFailure;
      pendingFailure = null;
      throw failure;
    }
    const dataListeners = new Set<(chunk: string) => void>();
    const exitListeners = new Set<(event: { exitCode: number }) => void>();
    const fake: FakePty = {
      pid: nextPid++,
      shell,
      args,
      cols: options.cols,
      rows: options.rows,
      env: options.env,
      written: [],
      killed: false,
      emit: (chunk) => {
        for (const listener of dataListeners) listener(chunk);
      },
      exit: (code) => {
        for (const listener of exitListeners) listener({ exitCode: code });
      },
    };
    created.push(fake);
    const handle: PtyProcess = {
      get pid() {
        return fake.pid;
      },
      onData: (listener) => dataListeners.add(listener),
      onExit: (listener) => exitListeners.add(listener),
      write: (data) => fake.written.push(data),
      resize: (cols, rows) => {
        fake.cols = cols;
        fake.rows = rows;
      },
      kill: () => {
        fake.killed = true;
      },
    };
    return handle;
  };

  return {
    spawner,
    created,
    failNextSpawn: (error) => {
      pendingFailure = error;
    },
  };
}

describe("Hub terminal console", () => {
  let server: HubServer;
  let projectDir: string;
  let otherProjectDir: string;
  let baseUrl: string;
  let harness: ReturnType<typeof createSpawnerHarness>;
  const sockets: WebSocket[] = [];

  beforeEach(async () => {
    const root = mkdtempSync(resolve(tmpdir(), "crossagent-terminal-test-"));
    projectDir = resolve(root, "project");
    otherProjectDir = resolve(root, "other");
    mkdirSync(projectDir);
    mkdirSync(otherProjectDir);
    harness = createSpawnerHarness();
    server = await createHubServer(
      {
        databasePath: resolve(root, "hub.db"),
        dataDir: resolve(root, "data"),
        dashboardDir: resolve(root, "missing-dashboard"),
        host: "127.0.0.1",
        port: 0,
        logLevel: "silent",
      },
      { ptySpawner: harness.spawner },
    );
    await server.app.listen({ host: "127.0.0.1", port: 0 });
    const address = server.app.server.address();
    if (!address || typeof address === "string") throw new Error("Missing test server port");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.close();
    await server.close();
  });

  async function request<T>(
    method: string,
    path: string,
    body?: unknown,
    token = server.token,
  ): Promise<{ status: number; body: T }> {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as T };
  }

  async function joinProject(cwd: string, name: string): Promise<string> {
    const joined = await request<any>(
      "POST",
      "/api/projects/join",
      {
        cwd,
        allowCreate: true,
        name,
      },
      server.credentials.dashboard.token,
    );
    return joined.body.project.id as string;
  }

  /** Requests the terminal capability and approves it the way the Dashboard does. */
  async function grantTerminal(projectId: string, key: string): Promise<string> {
    const requested = await request<any>(
      "POST",
      `/api/projects/${projectId}/authorizations`,
      {
        capability: "terminal.unrestricted",
        reason: "Console integration test",
        requestedByAgentId: "claude",
        idempotencyKey: `auth-${key}`,
      },
      server.credentials.dashboard.token,
    );
    expect(requested.body.status).toBe("PENDING");
    const decided = await request<any>(
      "POST",
      `/api/authorizations/${requested.body.id}/decision`,
      {
        expectedVersion: requested.body.version,
        decision: "GRANTED",
        actorId: "local-user",
        idempotencyKey: `decide-${key}`,
      },
      server.credentials.dashboard.token,
    );
    expect(decided.body.status).toBe("GRANTED");
    return requested.body.id as string;
  }

  function spawnTerminal(projectId: string, body: Record<string, unknown> = {}) {
    return request<any>(
      "POST",
      `/api/projects/${projectId}/terminals`,
      {
        label: "console",
        shell: "fake-shell",
        ...body,
      },
      server.credentials.dashboard.token,
    );
  }

  async function openTerminalSocket(token = server.credentials.dashboard.token) {
    const socket = await server.app.injectWS("/ws/terminal", {
      headers: { cookie: `crossagent_token=${encodeURIComponent(token)}` },
    });
    sockets.push(socket);
    const pending: any[] = [];
    const waiters: { match: (frame: any) => boolean; deliver: (frame: any) => void }[] = [];

    socket.addEventListener("message", (event: MessageEvent) => {
      const frame = JSON.parse(String(event.data));
      const waiterIndex = waiters.findIndex((waiter) => waiter.match(frame));
      const [waiter] = waiterIndex >= 0 ? waiters.splice(waiterIndex, 1) : [];
      if (waiter) {
        waiter.deliver(frame);
        return;
      }
      pending.push(frame);
    });

    /** Consumes the matched frame so waiting twice for the same type cannot see a stale one. */
    const next = (match: (frame: any) => boolean, timeoutMs = 4000) =>
      new Promise<any>((resolvePromise, reject) => {
        const index = pending.findIndex(match);
        if (index >= 0) {
          resolvePromise(pending.splice(index, 1)[0]);
          return;
        }
        const timer = setTimeout(() => reject(new Error("Timed out waiting for frame")), timeoutMs);
        waiters.push({
          match,
          deliver: (frame) => {
            clearTimeout(timer);
            resolvePromise(frame);
          },
        });
      });

    const nextOfType = (type: string) => next((frame) => frame.type === type);
    return {
      socket,
      opened: Promise.resolve(),
      next,
      nextOfType,
      send: (frame: unknown) => socket.send(JSON.stringify(frame)),
    };
  }

  async function expectTerminalSocketRejected(token: string): Promise<void> {
    await expect(
      server.app.injectWS("/ws/terminal", {
        headers: { cookie: `crossagent_token=${encodeURIComponent(token)}` },
      }),
    ).rejects.toThrow();
  }

  it("accepts the authenticated Dashboard principal on the terminal WebSocket", async () => {
    const projectId = await joinProject(projectDir, "Dashboard terminal credential");
    await grantTerminal(projectId, "dashboard-socket");
    const spawned = await spawnTerminal(projectId);
    expect(spawned.status).toBe(200);

    const client = await openTerminalSocket(server.credentials.dashboard.token);
    await client.opened;
    client.send({ type: "attach", projectId, sessionId: spawned.body.id });
    await expect(client.nextOfType("attached")).resolves.toMatchObject({
      sessionId: spawned.body.id,
    });
    client.send({ type: "input", data: "dashboard\r" });
    await expect.poll(() => harness.created[0]?.written).toContain("dashboard\r");
  });

  it("authenticates terminal WebSockets against live credential scope, revocation, and expiry", async () => {
    await expect(
      server.app.injectWS(
        `/ws/terminal?token=${encodeURIComponent(server.credentials.dashboard.token)}`,
      ),
    ).rejects.toThrow();
    await expect(
      server.app.injectWS("/ws/terminal", {
        headers: { authorization: `Bearer ${server.credentials.dashboard.token}` },
      }),
    ).rejects.toThrow();
    await expect(
      server.app.injectWS("/ws/terminal", {
        headers: { "x-crossagent-token": server.credentials.dashboard.token },
      }),
    ).rejects.toThrow();
    await expectTerminalSocketRejected(server.credentials.capture.claude.token);

    server.store.sqlite
      .prepare("UPDATE auth_credentials SET revoked_at = ? WHERE id = 'crd_local_agent'")
      .run(new Date().toISOString());
    await expectTerminalSocketRejected(server.credentials.agent.token);

    server.store.sqlite.exec("DROP TRIGGER auth_credentials_restricted_update");
    server.store.sqlite
      .prepare("UPDATE auth_credentials SET expires_at = ? WHERE id = 'crd_local_dashboard'")
      .run("2000-01-01T00:00:00.000Z");
    await expectTerminalSocketRejected(server.credentials.dashboard.token);
  });

  it("gates spawning on a live grant the user approved, and again once it is revoked", async () => {
    const projectId = await joinProject(projectDir, "terminal fixture");

    const beforeRequesting = await spawnTerminal(projectId);
    expect(beforeRequesting.status).toBe(403);
    expect(beforeRequesting.body.message).toContain("No terminal authorization");

    const requested = await request<any>(
      "POST",
      `/api/projects/${projectId}/authorizations`,
      {
        capability: "terminal.unrestricted",
        reason: "Console integration test",
        requestedByAgentId: "claude",
        idempotencyKey: "auth-pending",
      },
      server.credentials.dashboard.token,
    );
    const whilePending = await spawnTerminal(projectId);
    expect(whilePending.status).toBe(403);
    expect(whilePending.body.message).toContain("PENDING");

    const decided = await request<any>(
      "POST",
      `/api/authorizations/${requested.body.id}/decision`,
      {
        expectedVersion: requested.body.version,
        decision: "GRANTED",
        actorId: "local-user",
        idempotencyKey: "decide-granted",
      },
      server.credentials.dashboard.token,
    );
    const granted = await spawnTerminal(projectId);
    expect(granted.status).toBe(200);
    expect(harness.created).toHaveLength(1);
    expect(harness.created[0]?.shell).toBe("fake-shell");

    await request<any>(
      "POST",
      `/api/authorizations/${requested.body.id}/decision`,
      {
        expectedVersion: decided.body.version,
        decision: "REVOKED",
        actorId: "local-user",
        idempotencyKey: "decide-revoked",
      },
      server.credentials.dashboard.token,
    );
    const afterRevoke = await spawnTerminal(projectId);
    expect(afterRevoke.status).toBe(403);
    expect(afterRevoke.body.message).toContain("REVOKED");
    // Revoking must not have reached back into a process that is already running.
    expect(harness.created[0]?.killed).toBe(false);
  });

  it("takes control of an attached terminal away on revoke, while leaving it killable", async () => {
    const projectId = await joinProject(projectDir, "revocation fixture");
    const authorizationId = await grantTerminal(projectId, "revoke-live");
    const spawned = await spawnTerminal(projectId);
    expect(spawned.status).toBe(200);
    const sessionId = spawned.body.id as string;
    const pty = harness.created[0];
    if (!pty) throw new Error("Expected the harness to have spawned a pty");

    const waitUntil = async (predicate: () => boolean, label: string) => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (predicate()) return;
        await new Promise((done) => setTimeout(done, 10));
      }
      throw new Error(`Timed out waiting for ${label}`);
    };

    // Two sockets so input and resize are each exercised on an attachment that was established
    // while the grant was live — the situation the attach-time check alone did not cover.
    const [typist, resizer] = await Promise.all([openTerminalSocket(), openTerminalSocket()]);
    await Promise.all([typist.opened, resizer.opened]);
    typist.send({ type: "attach", projectId, sessionId });
    resizer.send({ type: "attach", projectId, sessionId });
    await Promise.all([typist.nextOfType("attached"), resizer.nextOfType("attached")]);

    typist.send({ type: "input", data: "granted\r" });
    await waitUntil(() => pty.written.includes("granted\r"), "the authorized write");

    const authorizations = await request<any[]>(
      "GET",
      `/api/projects/${projectId}/authorizations`,
      undefined,
      server.credentials.dashboard.token,
    );
    const live = authorizations.body.find((entry: any) => entry.id === authorizationId);
    expect(live?.status).toBe("GRANTED");
    const revoked = await request<any>(
      "POST",
      `/api/authorizations/${authorizationId}/decision`,
      {
        expectedVersion: live.version,
        decision: "REVOKED",
        actorId: "local-user",
        idempotencyKey: "revoke-live-attachment",
      },
      server.credentials.dashboard.token,
    );
    expect(revoked.body.status).toBe("REVOKED");

    typist.send({ type: "input", data: "revoked\r" });
    const inputRejected = await typist.nextOfType("unauthorized");
    expect(inputRejected.projectId).toBe(projectId);
    expect(inputRejected.message).toContain("REVOKED");
    expect(pty.written).not.toContain("revoked\r");

    resizer.send({ type: "resize", cols: 200, rows: 50 });
    const resizeRejected = await resizer.nextOfType("unauthorized");
    expect(resizeRejected.message).toContain("REVOKED");
    expect(pty.cols).toBe(120);
    expect(pty.rows).toBe(30);

    // The attachment is gone, not merely refused once: the next frame has nothing to write to.
    typist.send({ type: "input", data: "still-gone\r" });
    const detached = await typist.nextOfType("error");
    expect(detached.message).toContain("Attach to a session");
    expect(pty.written).not.toContain("still-gone\r");

    // Re-attaching needs the user to approve again.
    typist.send({ type: "attach", projectId, sessionId });
    const reattach = await typist.nextOfType("unauthorized");
    expect(reattach.message).toContain("REVOKED");

    // Stopping a process the user can no longer drive must still work, and must not need a grant.
    const killed = await request<any>(
      "DELETE",
      `/api/terminals/${sessionId}`,
      undefined,
      server.credentials.dashboard.token,
    );
    expect(killed.status).toBe(200);
    expect(pty.killed).toBe(true);
  });

  // The live cap only counts running sessions, so spawning and exiting one at a time used to grow
  // the in-memory map without limit, each entry holding its scrollback.
  it("stops retaining exited sessions once a project has more than it keeps", async () => {
    const projectId = await joinProject(projectDir, "retention fixture");
    await grantTerminal(projectId, "retention");

    const spawnedIds: string[] = [];
    for (let index = 0; index < 11; index += 1) {
      const spawned = await spawnTerminal(projectId, { label: `retained ${index}` });
      expect(spawned.status).toBe(200);
      spawnedIds.push(spawned.body.id as string);
      const pty = harness.created[index];
      if (!pty) throw new Error(`Expected a pty for spawn ${index}`);
      // Each one emits before exiting, so a retained entry is holding real scrollback.
      pty.emit(`output from ${index}\r\n`);
      pty.exit(0);
      // exitedAt has millisecond resolution and the prune orders by it, so the exits must be
      // distinguishable rather than all landing on the same timestamp.
      await new Promise((done) => setTimeout(done, 2));
    }

    const listed = await request<any[]>(
      "GET",
      `/api/projects/${projectId}/terminals`,
      undefined,
      server.credentials.dashboard.token,
    );
    expect(listed.status).toBe(200);
    expect(listed.body).toHaveLength(8);
    // The three oldest are gone and the most recent survive.
    const retainedIds = listed.body.map((session: any) => session.id);
    expect(retainedIds).not.toContain(spawnedIds[0]);
    expect(retainedIds).not.toContain(spawnedIds[1]);
    expect(retainedIds).not.toContain(spawnedIds[2]);
    expect(retainedIds).toContain(spawnedIds[10]);
    expect(listed.body.every((session: any) => session.exitedAt)).toBe(true);

    // Retaining exited sessions is only worth doing if their output is still readable, so pin that
    // instead of only the count. A future change that cleared the buffer on exit would otherwise
    // keep this test green while destroying the reason the sessions are kept at all.
    const survivor = spawnedIds[10];
    const pruned = spawnedIds[0];
    if (!survivor || !pruned) throw new Error("Expected both a survivor and a pruned id");
    const reader = await openTerminalSocket();
    await reader.opened;
    reader.send({ type: "attach", projectId, sessionId: survivor });
    const replayed = await reader.nextOfType("attached");
    expect(replayed.backlog).toContain("output from 10");

    // And a pruned id has to read as gone rather than as an empty session.
    reader.send({ type: "attach", projectId, sessionId: pruned });
    const gone = await reader.nextOfType("error");
    expect(gone.message).toContain("not found");

    // Pruning must not have disturbed the live cap: a fresh session still starts.
    const afterPrune = await spawnTerminal(projectId, { label: "after prune" });
    expect(afterPrune.status).toBe(200);
  });

  it("resolves preset argv and refuses presets or efforts the registry does not offer", async () => {
    const projectId = await joinProject(projectDir, "preset fixture");
    await grantTerminal(projectId, "preset");

    const preset = await request<any>(
      "POST",
      "/api/model-presets",
      {
        agentId: "codex",
        modelId: "fake-model",
        label: "Fake Model",
        reasoningEfforts: ["low", "high"],
        launchArgs: ["-m", "{model}"],
        effortArgs: ["-c", "model_reasoning_effort={effort}"],
      },
      server.credentials.dashboard.token,
    );
    expect(preset.status).toBe(200);

    const withEffort = await spawnTerminal(projectId, {
      modelPresetId: preset.body.id,
      reasoningEffort: "high",
    });
    expect(withEffort.status).toBe(200);
    expect(withEffort.body.args).toEqual(["-m", "fake-model", "-c", "model_reasoning_effort=high"]);

    // The whole point of splitting effortArgs: without an effort the flag leaves with its value.
    const withoutEffort = await spawnTerminal(projectId, { modelPresetId: preset.body.id });
    expect(withoutEffort.status).toBe(200);
    expect(withoutEffort.body.args).toEqual(["-m", "fake-model"]);

    const undeclaredEffort = await spawnTerminal(projectId, {
      modelPresetId: preset.body.id,
      reasoningEffort: "ludicrous",
    });
    expect(undeclaredEffort.status).toBe(422);
    expect(undeclaredEffort.body.code).toBe("REASONING_EFFORT_UNSUPPORTED");

    const effortWithoutPreset = await spawnTerminal(projectId, { reasoningEffort: "high" });
    expect(effortWithoutPreset.status).toBe(422);
    expect(effortWithoutPreset.body.code).toBe("MODEL_PRESET_REQUIRED");

    const missingPreset = await spawnTerminal(projectId, { modelPresetId: "mdp_missing" });
    expect(missingPreset.status).toBe(404);

    await request<any>(
      "POST",
      "/api/model-presets",
      {
        agentId: "codex",
        modelId: "fake-model",
        label: "Fake Model",
        reasoningEfforts: ["low", "high"],
        launchArgs: ["-m", "{model}"],
        effortArgs: ["-c", "model_reasoning_effort={effort}"],
        enabled: false,
      },
      server.credentials.dashboard.token,
    );
    const disabled = await spawnTerminal(projectId, { modelPresetId: preset.body.id });
    expect(disabled.status).toBe(422);
    expect(disabled.body.code).toBe("MODEL_PRESET_DISABLED");
  });

  it("launches an agent named without an extension, the way the console asks for it", async () => {
    const projectId = await joinProject(projectDir, "resolve fixture");
    await grantTerminal(projectId, "resolve");

    // The console page sends the bare agent name. On Windows node-pty goes through CreateProcess,
    // which does not apply PATHEXT, so an unresolved bare name fails with an empty "File not found:"
    // and both launch buttons were dead. `where` is used as the stand-in because it ships with
    // Windows; nothing is executed here, the fake spawner only records what it was handed.
    const bare = await spawnTerminal(projectId, { shell: "where" });
    expect(bare.status).toBe(200);
    const handed = harness.created.at(-1)!.shell;
    if (process.platform === "win32") {
      expect(handed.toLowerCase()).toMatch(/\\where\.exe$/);
      // Reported as what actually ran, and still recognisable to the console's label matching.
      expect(bare.body.shell).toBe(handed);
    } else {
      // Nothing to resolve off Windows: a bare name is already spawnable there.
      expect(handed).toBe("where");
    }

    // Declared for the child too, not just for the pty. Inheriting the Hub's TERM is how a Hub
    // started as a service handed Codex TERM=dumb and got a warning plus an unusable transcript.
    expect(harness.created.at(-1)!.env.TERM).toBe("xterm-256color");

    // A caller that named a location has made a decision the resolver must not overrule.
    const explicit = await spawnTerminal(projectId, { shell: "C:\\custom\\agent.exe" });
    expect(explicit.status).toBe(200);
    expect(harness.created.at(-1)!.shell).toBe("C:\\custom\\agent.exe");

    // An unresolvable name is passed through untouched, so the spawn failure is the real one rather
    // than a path this function invented.
    const missing = await spawnTerminal(projectId, { shell: "definitely-not-installed-anywhere" });
    expect(missing.status).toBe(200);
    expect(harness.created.at(-1)!.shell).toBe("definitely-not-installed-anywhere");
  });

  it("streams output over the socket, replays backlog, and audits the whole lifecycle", async () => {
    const projectId = await joinProject(projectDir, "stream fixture");
    await grantTerminal(projectId, "stream");
    const spawned = await spawnTerminal(projectId, { cols: 100, rows: 40 });
    const sessionId = spawned.body.id as string;
    const fake = harness.created[0]!;

    // Output produced before anyone attaches has to survive for the first client.
    fake.emit("before attach\r\n");

    const client = await openTerminalSocket();
    await client.opened;
    client.send({ type: "attach", projectId, sessionId });
    const attached = await client.nextOfType("attached");
    expect(attached.sessionId).toBe(sessionId);
    expect(attached.backlog).toBe("before attach\r\n");

    fake.emit("live output");
    const output = await client.nextOfType("output");
    expect(output.data).toBe("live output");

    client.send({ type: "input", data: "echo hi\r" });
    client.send({ type: "resize", cols: 120, rows: 50 });
    // Same dimensions again: the service must treat it as a no-op, not a second audit event.
    client.send({ type: "resize", cols: 120, rows: 50 });
    await expect.poll(() => fake.written.length, { timeout: 4000 }).toBe(1);
    expect(fake.written[0]).toBe("echo hi\r");
    await expect.poll(() => fake.cols, { timeout: 4000 }).toBe(120);
    expect(fake.rows).toBe(50);

    fake.exit(0);
    const exit = await client.nextOfType("exit");
    expect(exit.exitCode).toBe(0);

    const terminalEvents = server.store
      .listEvents(projectId, 0, 1000)
      .filter((event) => event.type.startsWith("terminal."));
    expect(terminalEvents.map((event) => event.type)).toEqual([
      "terminal.spawned",
      "terminal.resized",
      "terminal.exited",
    ]);
    const resized = terminalEvents.find((event) => event.type === "terminal.resized");
    expect(resized?.payload).toMatchObject({ cols: 120, rows: 50 });
    expect(terminalEvents.every((event) => event.aggregateId === sessionId)).toBe(true);
  });

  it("audits a failure to start and reports kills", async () => {
    const projectId = await joinProject(projectDir, "failure fixture");
    await grantTerminal(projectId, "failure");

    harness.failNextSpawn(new Error("spawn ENOENT missing-shell"));
    const failed = await spawnTerminal(projectId, { shell: "missing-shell" });
    expect(failed.status).toBe(500);

    const errorEvent = server.store
      .listEvents(projectId, 0, 1000)
      .find((event) => event.type === "terminal.error");
    expect(errorEvent?.payload).toMatchObject({ operation: "spawn" });
    expect(String((errorEvent?.payload as any).message)).toContain("ENOENT");

    const spawned = await spawnTerminal(projectId);
    const killed = await request<any>(
      "DELETE",
      `/api/terminals/${spawned.body.id}`,
      undefined,
      server.credentials.dashboard.token,
    );
    expect(killed.status).toBe(200);
    expect(harness.created.at(-1)?.killed).toBe(true);
    expect(
      server.store.listEvents(projectId, 0, 1000).some((e) => e.type === "terminal.killed"),
    ).toBe(true);
  });

  it("rejects malformed frames and refuses to attach across projects", async () => {
    const projectId = await joinProject(projectDir, "owner project");
    const otherProjectId = await joinProject(otherProjectDir, "other project");
    await grantTerminal(projectId, "owner");
    await grantTerminal(otherProjectId, "other");
    const spawned = await spawnTerminal(projectId);
    const sessionId = spawned.body.id as string;

    const client = await openTerminalSocket();
    await client.opened;

    client.socket.send("not json");
    expect((await client.nextOfType("error")).message).toContain("must be JSON");

    client.send({ type: "teleport", sessionId });
    expect((await client.nextOfType("error")).message).toContain("Invalid terminal frame");

    client.send({ type: "attach", sessionId });
    expect((await client.nextOfType("error")).message).toContain("projectId");

    // A session id from another project must read exactly like one that does not exist.
    client.send({ type: "attach", projectId: otherProjectId, sessionId });
    expect((await client.nextOfType("error")).message).toContain("not found");

    client.send({ type: "input", data: "before attaching" });
    expect((await client.nextOfType("error")).message).toContain("Attach to a session");

    client.send({ type: "attach", projectId, sessionId });
    await client.nextOfType("attached");

    client.send({ type: "input", data: "x".repeat(8 * 1024 + 1) });
    expect((await client.nextOfType("error")).message).toContain("Invalid terminal frame");

    client.send({ type: "resize", cols: 4, rows: 40 });
    expect((await client.nextOfType("error")).message).toContain("cols");

    // Nothing invalid reached the pty.
    expect(harness.created[0]?.written).toEqual([]);
    expect(harness.created[0]?.cols).toBe(120);
  });

  it("caps live terminal sessions per project and frees a slot when one exits", async () => {
    const projectId = await joinProject(projectDir, "limit fixture");
    await grantTerminal(projectId, "limit");

    for (let index = 0; index < 8; index += 1) {
      const spawned = await spawnTerminal(projectId, { label: `console ${index}` });
      expect(spawned.status).toBe(200);
    }
    const ninth = await spawnTerminal(projectId);
    expect(ninth.status).toBe(403);
    expect(ninth.body.message).toContain("8 live terminal sessions");

    harness.created[0]!.exit(0);
    const afterExit = await spawnTerminal(projectId);
    expect(afterExit.status).toBe(200);

    const listed = await request<any[]>(
      "GET",
      `/api/projects/${projectId}/terminals`,
      undefined,
      server.credentials.dashboard.token,
    );
    expect(listed.body).toHaveLength(9);
    expect(listed.body.filter((session) => session.exitedAt === null)).toHaveLength(8);
  });
});
