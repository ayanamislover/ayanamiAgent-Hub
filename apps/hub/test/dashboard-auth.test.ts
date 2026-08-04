import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HubServer } from "../src/server.js";
import { createHubServer } from "./test-server.js";

const servers: HubServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function serverFixture(dashboardAuthMode?: "disabled" | "required"): Promise<HubServer> {
  const root = mkdtempSync(resolve(tmpdir(), "crossagent-dashboard-auth-"));
  const server = await createHubServer({
    dataDir: resolve(root, "data"),
    databasePath: resolve(root, "hub.db"),
    dashboardDir: resolve(root, "missing-dashboard"),
    host: "127.0.0.1",
    port: 0,
    logLevel: "silent",
    ...(dashboardAuthMode ? { dashboardAuthMode } : {}),
  });
  servers.push(server);
  return server;
}

describe("optional local Dashboard authentication", () => {
  it("bootstraps a Dashboard cookie without a pasted token by default", async () => {
    const server = await serverFixture();

    const bareProjects = await server.app.inject({ method: "GET", url: "/api/projects" });
    expect(bareProjects.statusCode).toBe(403);

    const bootstrap = await server.app.inject({
      method: "POST",
      url: "/api/dashboard/auth",
      payload: {},
    });
    expect(bootstrap.statusCode).toBe(200);
    expect(bootstrap.json()).toEqual({ ok: true, authMode: "disabled" });
    const setCookie = bootstrap.headers["set-cookie"];
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(";", 1)[0];
    expect(cookie).toMatch(/^crossagent_token=/);

    const projects = await server.app.inject({
      method: "GET",
      url: "/api/projects",
      headers: { cookie: cookie! },
    });
    expect(projects.statusCode).toBe(200);
  });

  it("keeps the token gate available when explicitly required", async () => {
    const server = await serverFixture("required");
    const rejected = await server.app.inject({
      method: "POST",
      url: "/api/dashboard/auth",
      payload: {},
    });
    expect(rejected.statusCode).toBe(403);

    const authenticated = await server.app.inject({
      method: "POST",
      url: "/api/dashboard/auth",
      headers: { authorization: `Bearer ${server.credentials.dashboard.token}` },
      payload: {},
    });
    expect(authenticated.statusCode).toBe(200);
    expect(authenticated.json()).toEqual({ ok: true, authMode: "required" });
  });

  it("refuses disabled Dashboard auth on a non-loopback listener before SQLite opens", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "crossagent-dashboard-auth-public-"));
    const databasePath = resolve(root, "must-not-exist.db");
    await expect(
      createHubServer({
        dataDir: resolve(root, "data"),
        databasePath,
        dashboardDir: resolve(root, "missing-dashboard"),
        host: "0.0.0.0",
        port: 0,
        logLevel: "silent",
        dashboardAuthMode: "disabled",
      }),
    ).rejects.toThrow(/only be disabled.*loopback/i);
    expect(existsSync(databasePath)).toBe(false);
  });
});
