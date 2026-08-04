import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HubServer } from "../src/server.js";
import { createHubServer } from "./test-server.js";

/**
 * The artifact route and the health route each used to reach past the store and run their own SQL
 * through `store.sqlite`, which is the only reason that handle is public. These cover the two
 * replacements so the HTTP layer can be switched over to them, and so nothing quietly regresses to
 * raw SQL later.
 */
describe("store seams that replace raw sqlite access", () => {
  let server: HubServer;
  let projectId: string;

  beforeEach(async () => {
    const root = mkdtempSync(resolve(tmpdir(), "hub-seams-"));
    server = await createHubServer({
      databasePath: resolve(root, "hub.db"),
      dataDir: resolve(root, "data"),
      dashboardDir: resolve(root, "missing-dashboard"),
      host: "127.0.0.1",
      port: 0,
      logLevel: "silent",
    });
    projectId = server.store.joinProject(server.credentials.dashboard.principal, {
      cwd: mkdtempSync(resolve(tmpdir(), "hub-seams-project-")),
      name: "store-seams",
      allowCreate: true,
    }).project.id;
  });

  afterEach(async () => {
    await server.app.close();
  });

  it("reads a published artifact back with everything the content route needs", () => {
    const published = server.store.publishArtifact(
      server.credentials.dashboard.principal,
      projectId,
      {
        kind: "report",
        name: "verdict.txt",
        mediaType: "text/plain",
        text: "hello",
        idempotencyKey: "seam-artifact-1",
      },
    );

    const artifact = server.store.getArtifact(published.id);

    expect(artifact).not.toBeNull();
    expect(artifact).toMatchObject({
      id: published.id,
      projectId,
      kind: "report",
      name: "verdict.txt",
      mediaType: "text/plain",
      sizeBytes: 5,
    });
    // The route streams the file itself, so the path has to survive the mapping.
    expect(artifact?.storagePath).toBeTruthy();
    expect(artifact?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns null for an unknown artifact instead of throwing", () => {
    expect(server.store.getArtifact("art_does_not_exist")).toBeNull();
  });

  it("reports the pragmas the health endpoint publishes", () => {
    const health = server.store.databaseHealth();

    // WAL is what the Hub configures; reporting anything else means the pragma read is wrong.
    expect(health.journalMode).toBe("WAL");
    expect(health.foreignKeys).toBe(true);
    expect(typeof health.busyTimeoutMs).toBe("number");
    expect(health.busyTimeoutMs).toBeGreaterThan(0);
  });
});
