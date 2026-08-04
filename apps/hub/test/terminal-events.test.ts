import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DomainEvent } from "@crossagent/protocol";
import type { HubServer } from "../src/server.js";
import { createHubServer } from "./test-server.js";

/**
 * Terminal lifecycle events used to be appended without being published, so they consumed a project
 * sequence number and reached the events table but never a live subscriber: a Dashboard holding an
 * open project socket saw no terminal activity until it reconnected and replayed over REST.
 */
describe("terminal event publication", () => {
  let server: HubServer;
  let projectDir: string;
  let projectId: string;

  beforeEach(async () => {
    const root = mkdtempSync(resolve(tmpdir(), "hub-term-events-"));
    projectDir = mkdtempSync(resolve(tmpdir(), "hub-term-project-"));
    server = await createHubServer({
      databasePath: resolve(root, "hub.db"),
      dataDir: resolve(root, "data"),
      dashboardDir: resolve(root, "missing-dashboard"),
      host: "127.0.0.1",
      port: 0,
      logLevel: "silent",
    });
    const joined = server.store.joinProject(server.credentials.dashboard.principal, {
      cwd: projectDir,
      name: "terminal-events",
      allowCreate: true,
    });
    projectId = joined.project.id;
  });

  afterEach(async () => {
    await server.app.close();
  });

  it("publishes terminal lifecycle events to live subscribers", () => {
    const received: DomainEvent[] = [];
    const unsubscribe = server.store.bus.subscribe(projectId, (event) => received.push(event));

    server.store.recordTerminalEvent(projectId, {
      type: "terminal.spawned",
      sessionId: "term-1",
      payload: { pid: 4242 },
    });

    unsubscribe();

    expect(received.map((event) => event.type)).toEqual(["terminal.spawned"]);
    expect(received[0]).toMatchObject({
      projectId,
      aggregateType: "terminal",
      aggregateId: "term-1",
      actorType: "user",
      payload: { pid: 4242 },
    });
  });

  it("still records the event durably and advances the project sequence", () => {
    const before = server.store.getOverview(projectId).currentSequence;

    server.store.recordTerminalEvent(projectId, {
      type: "terminal.exited",
      sessionId: "term-2",
      payload: { exitCode: 0 },
    });

    const after = server.store.getOverview(projectId).currentSequence;
    expect(after).toBe(before + 1);

    const persisted = server.store.listEvents(projectId, before);
    expect(persisted.map((event) => event.type)).toContain("terminal.exited");
  });
});
