import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HubServer } from "../src/server.js";
import { createHubServer } from "./test-server.js";

describe("project join bootstrap", () => {
  let server: HubServer;

  afterEach(async () => {
    await server?.close();
  });

  it("allows the static Claude Agent to join existing metadata before session enrollment", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "crossagent-project-join-"));
    const projectRoot = resolve(root, "project");
    mkdirSync(resolve(projectRoot, ".crossagent"), { recursive: true });
    writeFileSync(
      resolve(projectRoot, ".crossagent", "project.json"),
      `${JSON.stringify({
        schema_version: 1,
        project_id: "prj_existing_bootstrap",
        name: "existing bootstrap project",
        default_branch: null,
      })}\n`,
      "utf8",
    );
    server = await createHubServer({
      databasePath: resolve(root, "hub.db"),
      dataDir: resolve(root, "data"),
      dashboardDir: resolve(root, "missing-dashboard"),
      host: "127.0.0.1",
      port: 0,
      logLevel: "silent",
    });

    const response = await server.app.inject({
      method: "POST",
      url: "/api/projects/join",
      headers: { authorization: `Bearer ${server.credentials.agentByClient.claude.token}` },
      payload: { cwd: projectRoot, allowCreate: true },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      project: { id: "prj_existing_bootstrap" },
      root: projectRoot,
      created: false,
    });
    expect(server.store.listEvents("prj_existing_bootstrap", 0, 20).at(-1)).toMatchObject({
      type: "project.joined",
      actorType: "agent",
      actorId: "claude",
    });
  });

  it("keeps project metadata creation Dashboard-only", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "crossagent-project-create-"));
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

    const response = await server.app.inject({
      method: "POST",
      url: "/api/projects/join",
      headers: { authorization: `Bearer ${server.credentials.agentByClient.claude.token}` },
      payload: { cwd: projectRoot, allowCreate: true },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      code: "FORBIDDEN",
      message: "This operation requires an authenticated Dashboard user",
    });
    expect(existsSync(resolve(projectRoot, ".crossagent", "project.json"))).toBe(false);
  });
});
