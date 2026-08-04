import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import type { AgentSession, AuthorizationGrant, ModelPreset, Project } from "@crossagent/protocol";
import { SECONDARY_PROJECT_NAME } from "./fixture-paths.js";

function navigationButton(page: Page, id: string, fallbackLabel: string) {
  return page
    .getByTestId(`nav-${id}`)
    .or(
      page.getByRole("button", {
        name: new RegExp(`^${fallbackLabel}(?:\\s|$)`, "i"),
      }),
    )
    .first();
}

async function revokeActiveTerminalAuthorizations(
  request: APIRequestContext,
  baseURL: string,
  token: string,
) {
  const projectsResponse = await request.get(`${baseURL}/api/projects`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const projects = (await projectsResponse.json()) as Project[];
  for (const project of projects) {
    const grantsResponse = await request.get(
      `${baseURL}/api/projects/${project.id}/authorizations`,
      {
        headers: { authorization: `Bearer ${token}` },
      },
    );
    const grants = (await grantsResponse.json()) as AuthorizationGrant[];
    for (const grant of grants) {
      if (grant.capability !== "terminal.unrestricted" || grant.status !== "GRANTED") continue;
      const revoked = await request.post(`${baseURL}/api/authorizations/${grant.id}/decision`, {
        headers: { authorization: `Bearer ${token}` },
        data: {
          expectedVersion: grant.version,
          decision: "REVOKED",
          actorId: "e2e-fixture",
          note: "Reset terminal authorization between isolated browser cases",
          idempotencyKey: `e2e:authorization:reset:${grant.id}:${grant.version}`,
        },
      });
      expect(revoked.ok()).toBe(true);
    }
  }
}

test.beforeEach(async ({ page, request, baseURL }) => {
  const root = resolve(import.meta.dirname, "../../..");
  const token = readFileSync(
    resolve(root, "output", "playwright", "e2e-data", "dashboard-token"),
    "utf8",
  ).trim();
  await revokeActiveTerminalAuthorizations(request, String(baseURL), token);
  const response = await request.post(`${baseURL}/api/dashboard/launch`, {
    headers: { authorization: `Bearer ${token}` },
    data: {},
  });
  const launch = (await response.json()) as { code: string };
  await page.goto(`/?launch=${encodeURIComponent(launch.code)}`);
  await expect(page.getByText("CROSSAGENT", { exact: true })).toBeVisible();
});

test("opens the loopback Dashboard without the optional local login gate", async ({ page }) => {
  await page.context().clearCookies();
  // beforeEach already left the browser on this same hash route, so navigating to it again is an
  // in-page hash change: the document is never reloaded and the bootstrap effect never re-runs.
  // Leaving the origin first makes the next goto a real document load.
  await page.goto("about:blank");
  const bootstrapRequest = page.waitForRequest(
    (request) => request.method() === "POST" && request.url().endsWith("/api/dashboard/auth"),
  );
  const bootstrapResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" && response.url().endsWith("/api/dashboard/auth"),
  );
  await page.goto("/#/overview");
  const request = await bootstrapRequest;
  expect(request.headers()).not.toHaveProperty("authorization");
  expect((await bootstrapResponse).ok()).toBe(true);
  await expect(page.getByText("CROSSAGENT", { exact: true })).toBeVisible();
  await expect(page.getByText("LOCAL AUTHENTICATION", { exact: true })).toHaveCount(0);
});

test("renders all nine live control surfaces without viewport overflow", async ({
  page,
}, testInfo) => {
  const root = resolve(import.meta.dirname, "../../..");
  const screenshots = resolve(root, "output", "playwright", "screenshots");
  mkdirSync(screenshots, { recursive: true });
  await page.screenshot({
    path: resolve(screenshots, `overview-${testInfo.project.name}.png`),
    fullPage: true,
  });
  // Navigation is located by test id, not by visible label: the sidebar copy is localised and
  // will keep changing. The label fallback keeps the test valid against the pre-localisation build.
  const surfaces = [
    ["overview", "Overview", "Ship an auditable CrossAgent coordination plane"],
    ["tasks", "Tasks", "Task board"],
    ["communications", "Communications", "Communications"],
    ["console", "Console", "Dual terminal console"],
    ["reviews", "Reviews", "Review bundles"],
    ["agents", "Agents", "Agents"],
    ["conflicts", "Conflicts", "Conflicts"],
    ["audit", "Audit", "Audit stream"],
    ["settings", "Settings", "Settings & runtime"],
  ] as const;
  for (const [nav, fallbackLabel, heading] of surfaces) {
    await navigationButton(page, nav, fallbackLabel).click();
    await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
    if (nav === "tasks") {
      await page.getByRole("button", { name: "New task", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Create task", exact: true });
      await expect(dialog).toBeVisible();
      const initialState = dialog.getByRole("button", { name: /^Initial state/ });
      await initialState.click();
      const stateList = page.getByRole("listbox", { name: "Initial state", exact: true });
      await expect(stateList).toBeVisible();
      expect(
        await stateList.evaluate((element) => element.parentElement?.matches("dialog[open]")),
      ).toBe(true);
      await page.getByRole("option", { name: "Backlog", exact: true }).click();
      await expect(initialState).toHaveAccessibleName("Initial state Backlog");
      await dialog.getByRole("button", { name: "Close task form", exact: true }).click();
      await expect(dialog).toBeHidden();
    }
    if (nav === "agents") {
      await expect(page.getByRole("heading", { name: "codex", exact: true })).toHaveCount(1);
      await expect(page.getByRole("heading", { name: "claude", exact: true })).toHaveCount(1);
      await expect(page.getByText("app_server_push", { exact: true })).toBeVisible();
      await expect(page.getByText("native_channel", { exact: true })).toBeVisible();
    }
    if (nav === "conflicts") {
      await expect(page.getByText("WRITE INTENT OVERLAP", { exact: true })).toBeVisible();
      await expect(page.getByText("packages/protocol/**", { exact: true })).toHaveCount(2);
    }
    if (nav === "console") {
      const geometry = await page
        .locator(".console-agent-mark")
        .first()
        .evaluate((element) => {
          const icon = element.querySelector("svg");
          if (!icon) throw new Error("Console agent icon is missing");
          const parentRect = element.getBoundingClientRect();
          const iconRect = icon.getBoundingClientRect();
          return {
            display: getComputedStyle(element).display,
            x: iconRect.left + iconRect.width / 2 - (parentRect.left + parentRect.width / 2),
            y: iconRect.top + iconRect.height / 2 - (parentRect.top + parentRect.height / 2),
          };
        });
      expect(geometry.display).toBe("grid");
      expect(Math.abs(geometry.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(geometry.y)).toBeLessThanOrEqual(1);
    }
    if (nav === "settings") {
      const geometry = await page
        .locator(".adapter-list .agent-avatar.mini")
        .first()
        .evaluate((element) => {
          const range = document.createRange();
          range.selectNodeContents(element);
          const parentRect = element.getBoundingClientRect();
          const glyphRect = range.getBoundingClientRect();
          return {
            display: getComputedStyle(element).display,
            x: glyphRect.left + glyphRect.width / 2 - (parentRect.left + parentRect.width / 2),
            y: glyphRect.top + glyphRect.height / 2 - (parentRect.top + parentRect.height / 2),
          };
        });
      expect(geometry.display).toBe("grid");
      expect(Math.abs(geometry.x)).toBeLessThanOrEqual(1.5);
      expect(Math.abs(geometry.y)).toBeLessThanOrEqual(1.5);
    }
  }
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});

test("opens a task inspector and receives the live stream", async ({ page }, testInfo) => {
  await navigationButton(page, "tasks", "Tasks").click();
  await page.getByRole("button", { name: /Freeze shared protocol/ }).click();
  await expect(
    page.getByRole("heading", { name: "Freeze shared protocol", level: 2 }),
  ).toBeVisible();
  // The pill is uppercased by CSS, so the DOM still holds the dictionary casing.
  await expect(page.getByText(/^(?:live|实时)$/i)).toBeVisible();
  const root = resolve(import.meta.dirname, "../../..");
  const screenshots = resolve(root, "output", "playwright", "screenshots");
  mkdirSync(screenshots, { recursive: true });
  await page.screenshot({
    path: resolve(screenshots, `task-inspector-${testInfo.project.name}.png`),
    fullPage: true,
  });
});

test("keeps the exact project and task in the Communications URL across reload", async ({
  page,
  request,
  baseURL,
}) => {
  const root = resolve(import.meta.dirname, "../../..");
  const token = readFileSync(
    resolve(root, "output", "playwright", "e2e-data", "dashboard-token"),
    "utf8",
  ).trim();
  const headers = { authorization: `Bearer ${token}` };
  const projectsResponse = await request.get(`${baseURL}/api/projects`, { headers });
  const projects = (await projectsResponse.json()) as Project[];
  const primary = projects.find((project) => project.name === "Ayanami Control Plane");
  if (!primary) throw new Error("Primary E2E project is missing");
  const overviewResponse = await request.get(`${baseURL}/api/projects/${primary.id}/overview`, {
    headers,
  });
  const overview = (await overviewResponse.json()) as {
    tasks: Array<{ id: string; title: string }>;
  };
  const task = overview.tasks.find((candidate) => candidate.title === "Freeze shared protocol");
  if (!task) throw new Error("Primary E2E task is missing");

  const secondary = projects.find((project) => project.name === SECONDARY_PROJECT_NAME);
  if (!secondary) throw new Error("Secondary E2E project is missing");

  const filteredMessages = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      response.request().method() === "GET" &&
      url.pathname === `/api/projects/${primary.id}/messages` &&
      url.searchParams.get("taskId") === task.id
    );
  });
  await page.goto(
    `/#/communications?projectId=${encodeURIComponent(primary.id)}&taskId=${encodeURIComponent(task.id)}`,
  );
  await filteredMessages;
  await expect(page.getByRole("heading", { name: "Communications", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: `Task scope ${task.title}` })).toBeVisible();
  expect(new URL(page.url()).hash).toBe(
    `#/communications?projectId=${primary.id}&taskId=${task.id}`,
  );

  await page.reload();
  await expect(page.getByRole("button", { name: `Task scope ${task.title}` })).toBeVisible();
  expect(new URL(page.url()).hash).toBe(
    `#/communications?projectId=${primary.id}&taskId=${task.id}`,
  );

  await page.goto(
    `/#/communications?projectId=${encodeURIComponent(secondary.id)}&taskId=${encodeURIComponent(task.id)}`,
  );
  await expect(page.getByRole("heading", { name: "Communications", exact: true })).toBeVisible();
  await expect
    .poll(() => new URL(page.url()).hash)
    .toBe(`#/communications?projectId=${secondary.id}`);

  const projectPicker = page.getByRole("button", { name: /^Current project/ });
  await projectPicker.click();
  await page.getByRole("option", { name: new RegExp(`^${primary.name}`) }).click();
  await expect
    .poll(() => new URL(page.url()).hash)
    .toBe(`#/communications?projectId=${primary.id}`);
  await page.reload();
  await expect(
    page.getByRole("button", { name: new RegExp(`^Current project ${primary.name}`) }),
  ).toBeVisible();
});

test("sends one envelope to both agents", async ({ page }, testInfo) => {
  await navigationButton(page, "communications", "Communications").click();
  const summary = `Both-recipient browser evidence · ${testInfo.project.name}`;
  const taskScope = page.getByRole("button", { name: /^Task scope/ });
  await taskScope.click();
  await page.getByRole("option", { name: /^Freeze shared protocol/ }).click();
  // Committing an option restores focus to its trigger on the next frame. Without waiting for that,
  // the Enter below lands back on the task scope trigger and reopens it instead.
  await expect(taskScope).toBeFocused();
  const scopedTaskId = new URLSearchParams(new URL(page.url()).hash.split("?", 2)[1]).get("taskId");
  expect(scopedTaskId).toBeTruthy();
  const recipient = page.getByRole("button", { name: /^Message recipient/ });
  await recipient.focus();
  await page.keyboard.press("Enter");
  const recipientList = page.getByRole("listbox", { name: "Message recipient" });
  await expect(recipientList).toBeVisible();
  // Opening moves focus onto the selected option a frame later. Pressing End before that lands,
  // the trigger handles the key instead of the list and the roving tabindex is left behind.
  await expect(recipientList.locator(":focus")).toHaveCount(1);
  await page.keyboard.press("End");
  const finalRecipient = page.getByRole("option", {
    name: "Both · Codex + Claude",
    exact: true,
  });
  await expect(finalRecipient).toBeFocused();
  await expect(finalRecipient).toHaveAttribute("tabindex", "0");
  await expect(page.getByRole("option", { name: "Codex", exact: true })).toHaveAttribute(
    "tabindex",
    "-1",
  );
  await page.keyboard.press("Escape");
  await expect(recipient).toBeFocused();
  await recipient.click();
  await page.getByRole("option", { name: "Both · Codex + Claude", exact: true }).click();

  const priority = page.getByRole("button", { name: /^Message priority/ });
  await recipient.click();
  // Opening also moves focus onto the selected option on the next frame. Tabbing before that lands
  // leaves the trigger focused, and a trigger does not handle Tab -- the list would stay open.
  await expect(
    page.getByRole("option", { name: "Both · Codex + Claude", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(priority).toBeFocused();
  await expect(page.getByRole("listbox", { name: "Message recipient" })).toBeHidden();
  await priority.click();
  for (const option of ["Background", "Normal", "Important", "Interrupt"]) {
    await expect(page.getByRole("option", { name: new RegExp(`^${option}`) })).toBeVisible();
  }
  await page.getByRole("option", { name: /Important/ }).click();
  await expect(
    page.getByText("Recipient acknowledgement is required (ACK).", { exact: true }),
  ).toBeVisible();
  await expect(priority).toHaveAccessibleName("Message priority Important");
  await priority.click();
  const priorityList = page.getByRole("listbox", { name: "Message priority" });
  await expect(priorityList).toBeVisible();
  const popupGeometry = await priorityList.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      parentIsBody: element.parentElement === document.body,
      position: getComputedStyle(element).position,
      top: rect.top,
      bottom: window.innerHeight - rect.bottom,
    };
  });
  expect(popupGeometry.parentIsBody).toBe(true);
  expect(popupGeometry.position).toBe("fixed");
  expect(popupGeometry.top).toBeGreaterThanOrEqual(0);
  expect(popupGeometry.bottom).toBeGreaterThanOrEqual(0);
  const root = resolve(import.meta.dirname, "../../..");
  const screenshots = resolve(root, "output", "playwright", "screenshots");
  mkdirSync(screenshots, { recursive: true });
  await page.screenshot({
    path: resolve(screenshots, `communications-priority-picker-${testInfo.project.name}.png`),
    fullPage: true,
  });
  await page.getByRole("heading", { name: "Communications", exact: true }).click();
  await expect(page.getByRole("listbox", { name: "Message priority" })).toBeHidden();
  await priority.click();
  await expect(
    page.getByRole("listbox", { name: "Message priority" }).locator(":focus"),
  ).toHaveCount(1);
  await page.keyboard.press("Shift+Tab");
  await expect(recipient).toBeFocused();
  await expect(page.getByRole("listbox", { name: "Message priority" })).toBeHidden();
  await page.getByPlaceholder("Use for concrete coordination, not courtesy status.").fill(summary);
  const posted = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      /\/api\/projects\/[^/]+\/messages$/.test(response.url()),
  );
  await page.getByRole("button", { name: "Send envelope", exact: true }).click();
  const response = await posted;
  expect(response.ok()).toBe(true);
  const payload = response.request().postDataJSON() as {
    fromAgentId: string;
    recipients: Array<{ agentId: string }>;
    priority: string;
    requiresAck: boolean;
    taskId: string;
  };
  const created = (await response.json()) as { id: string };
  expect(payload.recipients).toEqual([{ agentId: "codex" }, { agentId: "claude" }]);
  expect(payload.fromAgentId).toBe("Local User");
  expect(payload.priority).toBe("IMPORTANT");
  expect(payload.requiresAck).toBe(true);
  expect(payload.taskId).toBe(scopedTaskId);
  const envelope = page.locator(`[aria-labelledby="message-${created.id}"]`);
  await expect(envelope).toBeVisible();
  await expect(envelope).toContainText("Local User");
  await expect(envelope).toContainText(/→ (?:claude, codex|codex, claude)/);

  for (const [label, expectedPriority, expectedAck] of [
    ["Background", "BACKGROUND", false],
    ["Normal", "NORMAL", false],
    ["Interrupt", "INTERRUPT", true],
  ] as const) {
    await priority.click();
    await page.getByRole("option", { name: new RegExp(`^${label}`) }).click();
    await page
      .getByPlaceholder("Use for concrete coordination, not courtesy status.")
      .fill(`${label} priority contract · ${testInfo.project.name}`);
    const priorityPost = page.waitForResponse(
      (candidate) =>
        candidate.request().method() === "POST" &&
        /\/api\/projects\/[^/]+\/messages$/.test(candidate.url()),
    );
    await page.getByRole("button", { name: "Send envelope", exact: true }).click();
    const priorityResponse = await priorityPost;
    expect(priorityResponse.ok()).toBe(true);
    expect(priorityResponse.request().postDataJSON()).toMatchObject({
      priority: expectedPriority,
      requiresAck: expectedAck,
    });
  }
});

test("groups sessions by agent and keeps history collapsed", async ({ page }) => {
  await page.route("**/api/projects/*/overview", async (route) => {
    const response = await route.fetch();
    const overview = (await response.json()) as { sessions: AgentSession[] };
    const codex = overview.sessions.find((session) => session.agentId === "codex");
    if (!codex) {
      await route.fulfill({ response });
      return;
    }
    const historical: AgentSession = {
      ...codex,
      id: `${codex.id}-history`,
      role: "observer",
      client: "codex-cli-hooks",
      transport: "hook-poll",
      deliveryMode: "hook_poll",
      connectedAt: new Date(Date.parse(codex.connectedAt) - 60_000).toISOString(),
      connectionState: "OFFLINE",
      workState: "IDLE",
    };
    await route.fulfill({
      response,
      json: { ...overview, sessions: [...overview.sessions, historical] },
    });
  });
  await page.reload();
  await navigationButton(page, "agents", "Agents").click();
  await expect(page.getByRole("heading", { name: "codex", exact: true })).toHaveCount(1);
  await expect(page.getByText("1 current · 1 historical", { exact: true })).toBeVisible();
  await expect(page.getByText("OFFLINE", { exact: true })).toBeHidden();
  await page.getByText("Session history (1)", { exact: true }).click();
  await expect(page.getByText("OFFLINE", { exact: true })).toBeVisible();
});

test("serves separate local mascot background cutouts", async ({ page, request }, testInfo) => {
  const backdrop = page.locator(".agent-backdrop");
  await expect(backdrop).toHaveAttribute("aria-hidden", "true");
  const codex = backdrop.locator(".agent-backdrop-codex");
  const claude = backdrop.locator(".agent-backdrop-claude");
  await expect(codex).toHaveAttribute("src", "/agent-codex.png");
  await expect(claude).toHaveAttribute("src", "/agent-claude.png");
  await expect
    .poll(() => codex.evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBeGreaterThan(0);
  await expect
    .poll(() => claude.evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBeGreaterThan(0);

  for (const asset of ["/agent-codex.png", "/agent-claude.png"]) {
    const response = await request.get(asset);
    expect(response.ok()).toBe(true);
    expect(response.headers()["content-type"]).toContain("image/png");
  }

  await expect
    .poll(() => backdrop.evaluate((element) => getComputedStyle(element).display))
    .toBe(testInfo.project.name === "ultrawide" ? "block" : "none");
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const mascot of [codex, claude]) {
    await expect
      .poll(() => mascot.evaluate((element) => getComputedStyle(element).animationName))
      .toBe("none");
    if (testInfo.project.name === "ultrawide") {
      await expect
        .poll(() => mascot.evaluate((element) => getComputedStyle(element).transform))
        .toMatch(/^matrix\(-1,/);
    }
  }
});

test("lets the user approve, deny, and revoke unrestricted terminal access", async ({
  page,
  request,
  baseURL,
}, testInfo) => {
  const root = resolve(import.meta.dirname, "../../..");
  const token = readFileSync(
    resolve(root, "output", "playwright", "e2e-data", "dashboard-token"),
    "utf8",
  ).trim();
  const projectsResponse = await request.get(`${baseURL}/api/projects`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(projectsResponse.ok()).toBe(true);
  const [project] = (await projectsResponse.json()) as Project[];
  if (!project) throw new Error("E2E project was not created");

  const marker = `authorization-e2e-${testInfo.project.name}-${crypto.randomUUID()}`;
  const requested = await request.post(`${baseURL}/api/projects/${project.id}/authorizations`, {
    headers: { authorization: `Bearer ${token}` },
    data: {
      capability: "terminal.unrestricted",
      reason: `Browser authorization lifecycle ${marker}`,
      detail: { marker },
      requestedByAgentId: "claude",
      idempotencyKey: `e2e:authorization:request:${marker}`,
    },
  });
  expect(requested.ok()).toBe(true);
  const pending = (await requested.json()) as AuthorizationGrant;
  expect(pending.status).toBe("PENDING");

  await navigationButton(page, "settings", "Settings").click();
  await expect(
    page.getByRole("heading", { name: "Settings & runtime", exact: true }),
  ).toBeVisible();
  await expect(page.getByText(`Browser authorization lifecycle ${marker}`)).toBeVisible();
  const screenshots = resolve(root, "output", "playwright", "screenshots");
  mkdirSync(screenshots, { recursive: true });
  await page.screenshot({
    path: resolve(screenshots, `settings-authorizations-pending-${testInfo.project.name}.png`),
    fullPage: true,
  });

  const decisionPattern = `**/api/authorizations/${pending.id}/decision`;
  await page.route(decisionPattern, async (route) => {
    await route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({
        code: "CONFLICT",
        message: "Authorization changed; refresh and retry",
      }),
    });
  });
  await page.getByTestId(`authorization-approve-${pending.id}`).click();
  await expect(page.getByRole("alert")).toContainText("Authorization changed; refresh and retry");
  await page.unroute(decisionPattern);
  await expect(page.getByText(`Browser authorization lifecycle ${marker}`)).toBeVisible();

  const approvalResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith(`/api/authorizations/${pending.id}/decision`),
  );
  await page.getByTestId(`authorization-approve-${pending.id}`).click();
  const approvedHttp = await approvalResponse;
  expect(approvedHttp.ok()).toBe(true);
  const approvalPayload = approvedHttp.request().postDataJSON() as {
    expectedVersion: number;
    decision: string;
    ttlSeconds: number;
    idempotencyKey: string;
  };
  expect(approvalPayload).toMatchObject({
    expectedVersion: pending.version,
    decision: "GRANTED",
    ttlSeconds: 86_400,
  });
  expect(approvalPayload.idempotencyKey).toContain(`dashboard-authorization-${pending.id}-granted`);
  const approved = (await approvedHttp.json()) as AuthorizationGrant;
  expect(approved.status).toBe("GRANTED");
  expect(approved.decidedVia).toBe("dashboard");
  expect(approved.expiresAt).not.toBeNull();
  await expect(page.getByTestId(`authorization-revoke-${pending.id}`)).toBeVisible();
  await page.screenshot({
    path: resolve(screenshots, `settings-authorizations-granted-${testInfo.project.name}.png`),
    fullPage: true,
  });

  const revokeResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith(`/api/authorizations/${pending.id}/decision`),
  );
  await page.getByTestId(`authorization-revoke-${pending.id}`).click();
  const revokedHttp = await revokeResponse;
  expect(revokedHttp.ok()).toBe(true);
  const revokePayload = revokedHttp.request().postDataJSON() as {
    expectedVersion: number;
    decision: string;
    idempotencyKey: string;
  };
  expect(revokePayload).toMatchObject({
    expectedVersion: approved.version,
    decision: "REVOKED",
  });
  expect(revokePayload.idempotencyKey).toContain(`dashboard-authorization-${pending.id}-revoked`);
  expect(((await revokedHttp.json()) as AuthorizationGrant).status).toBe("REVOKED");
  await expect(
    page.getByText("There are no active authorizations.", { exact: true }),
  ).toBeVisible();

  const denyMarker = `authorization-deny-e2e-${testInfo.project.name}-${crypto.randomUUID()}`;
  const denyRequested = await request.post(`${baseURL}/api/projects/${project.id}/authorizations`, {
    headers: { authorization: `Bearer ${token}` },
    data: {
      capability: "terminal.unrestricted",
      reason: `Browser authorization denial ${denyMarker}`,
      detail: { marker: denyMarker },
      requestedByAgentId: "codex",
      idempotencyKey: `e2e:authorization:request:${denyMarker}`,
    },
  });
  expect(denyRequested.ok()).toBe(true);
  const pendingDenial = (await denyRequested.json()) as AuthorizationGrant;
  await page.reload();
  await expect(page.getByText(`Browser authorization denial ${denyMarker}`)).toBeVisible();

  const denialResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith(`/api/authorizations/${pendingDenial.id}/decision`),
  );
  await page.getByTestId(`authorization-deny-${pendingDenial.id}`).click();
  const deniedHttp = await denialResponse;
  expect(deniedHttp.ok()).toBe(true);
  const denialPayload = deniedHttp.request().postDataJSON() as {
    expectedVersion: number;
    decision: string;
    idempotencyKey: string;
  };
  expect(denialPayload).toMatchObject({
    expectedVersion: pendingDenial.version,
    decision: "DENIED",
  });
  expect(denialPayload.idempotencyKey).toContain(
    `dashboard-authorization-${pendingDenial.id}-denied`,
  );
  const denied = (await deniedHttp.json()) as AuthorizationGrant;
  expect(denied.status).toBe("DENIED");
  expect(denied.decidedVia).toBe("dashboard");
  await expect(
    page.getByText("There are no pending permission requests.", { exact: true }),
  ).toBeVisible();
});

test("shows and recovers from an authorization query failure", async ({ page }) => {
  await page.route("**/api/projects/*/authorizations", async (route) => {
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({
        code: "TEST_AUTHORIZATION_FAILURE",
        message: "Authorization store unavailable",
      }),
    });
  });
  await navigationButton(page, "settings", "Settings").click();
  await expect(page.getByRole("alert")).toContainText("Authorization store unavailable");

  await page.unroute("**/api/projects/*/authorizations");
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByTestId("authorization-panel")).toContainText("Pending requests");
});

test("explains failed and empty model registries without enabling launch", async ({ page }) => {
  await page.route(/\/api\/model-presets\?agentId=codex$/, async (route) => {
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ code: "PRESET_TEST_FAILURE", message: "Preset registry unavailable" }),
    });
  });
  await page.route(/\/api\/model-presets\?agentId=claude$/, async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });

  await navigationButton(page, "console", "Console").click();
  const codexPanel = page.getByTestId("terminal-panel-codex");
  const claudePanel = page.getByTestId("terminal-panel-claude");
  await expect(
    codexPanel.getByText("Unable to load the model registry. Try again.", { exact: true }),
  ).toBeVisible();
  await expect(
    claudePanel.getByText(
      "No model presets are enabled for this Agent. Enable one in the model registry first.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    codexPanel.getByRole("button", { name: "New terminal", exact: true }),
  ).toBeDisabled();
  await expect(
    claudePanel.getByRole("button", { name: "New terminal", exact: true }),
  ).toBeDisabled();
});

test("launches, drives, revokes, and explicitly terminates a mocked terminal", async ({
  page,
  request,
  baseURL,
}, testInfo) => {
  const root = resolve(import.meta.dirname, "../../..");
  const screenshots = resolve(root, "output", "playwright", "screenshots");
  mkdirSync(screenshots, { recursive: true });
  const token = readFileSync(
    resolve(root, "output", "playwright", "e2e-data", "dashboard-token"),
    "utf8",
  ).trim();
  const projectsResponse = await request.get(`${baseURL}/api/projects`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const [project] = (await projectsResponse.json()) as Project[];
  if (!project) throw new Error("E2E project was not created");

  const marker = `console-e2e-${testInfo.project.name}-${crypto.randomUUID()}`;
  const authorizationResponse = await request.post(
    `${baseURL}/api/projects/${project.id}/authorizations`,
    {
      headers: { authorization: `Bearer ${token}` },
      data: {
        capability: "terminal.unrestricted",
        reason: `Console browser evidence ${marker}`,
        detail: { marker },
        requestedByAgentId: "local-user",
        idempotencyKey: `e2e:console:authorization:${marker}`,
      },
    },
  );
  const pending = (await authorizationResponse.json()) as AuthorizationGrant;
  const decisionResponse = await request.post(
    `${baseURL}/api/authorizations/${pending.id}/decision`,
    {
      headers: { authorization: `Bearer ${token}` },
      data: {
        expectedVersion: pending.version,
        decision: "GRANTED",
        actorId: "local-user",
        ttlSeconds: 3_600,
        idempotencyKey: `e2e:console:grant:${marker}`,
      },
    },
  );
  expect(decisionResponse.ok()).toBe(true);

  await page.addInitScript(() => {
    type Frame = Record<string, unknown> & { type: string };
    const harness: {
      frames: Frame[];
      sockets: MockTerminalSocket[];
      emit: (frame: Frame) => void;
    } = {
      frames: [],
      sockets: [],
      emit(frame) {
        const socket = this.sockets.findLast(
          (candidate) => candidate.readyState === MockTerminalSocket.OPEN,
        );
        socket?.receive(frame);
      },
    };

    class MockTerminalSocket extends EventTarget {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      readonly url: string;
      readyState = MockTerminalSocket.CONNECTING;

      constructor(url: string | URL) {
        super();
        this.url = String(url);
        harness.sockets.push(this);
        window.setTimeout(() => {
          this.readyState = MockTerminalSocket.OPEN;
          this.dispatchEvent(new Event("open"));
        }, 0);
      }

      send(data: string) {
        const frame = JSON.parse(data) as Frame;
        harness.frames.push(frame);
        if (frame.type === "attach") {
          window.setTimeout(
            () =>
              this.receive({
                type: "attached",
                sessionId: String(frame.sessionId),
                backlog: "mock backlog ready\r\n",
              }),
            0,
          );
        }
        if (frame.type === "input") {
          window.setTimeout(() => this.receive({ type: "output", data: String(frame.data) }), 0);
        }
      }

      receive(frame: Frame) {
        this.dispatchEvent(
          new MessageEvent("message", {
            data: JSON.stringify(frame),
          }),
        );
      }

      close() {
        if (this.readyState === MockTerminalSocket.CLOSED) return;
        this.readyState = MockTerminalSocket.CLOSED;
        this.dispatchEvent(new CloseEvent("close"));
      }
    }

    Object.defineProperty(window, "__consoleTerminalHarness", { value: harness });
    Object.defineProperty(window, "WebSocket", { value: MockTerminalSocket });
  });

  const fakeSessions: Array<Record<string, unknown>> = [];
  await page.route("**/api/projects/*/terminals", async (route) => {
    if (route.request().method() === "POST") {
      const payload = route.request().postDataJSON() as {
        label: string;
        shell: string;
        args: string[];
        cols: number;
        rows: number;
      };
      const session = {
        id: `pty_${marker}`,
        projectId: project.id,
        label: payload.label,
        shell: payload.shell,
        args: payload.args,
        cwd: "R:\\fixture-project",
        cols: payload.cols,
        rows: payload.rows,
        pid: 4242,
        startedAt: new Date().toISOString(),
        exitedAt: null,
        exitCode: null,
      };
      fakeSessions.splice(0, fakeSessions.length, session);
      await route.fulfill({ status: 200, json: session });
      return;
    }
    await route.fulfill({ status: 200, json: fakeSessions });
  });
  await page.route("**/api/terminals/*", async (route) => {
    await route.fulfill({ status: 200, json: { ok: true } });
  });
  await page.route(/\/api\/model-presets\?agentId=codex$/, async (route) => {
    const response = await route.fetch();
    const presets = (await response.json()) as ModelPreset[];
    const timestamp = new Date().toISOString();
    await route.fulfill({
      response,
      json: [
        ...presets,
        {
          id: "mdp_e2e_no_effort",
          agentId: "codex",
          modelId: "e2e-no-effort",
          label: "E2E No Effort",
          reasoningEfforts: [],
          launchArgs: ["-m", "{model}"],
          effortArgs: ["-c", "model_reasoning_effort={effort}"],
          enabled: true,
          sortOrder: 99,
          version: 0,
          createdAt: timestamp,
          updatedAt: timestamp,
        } satisfies ModelPreset,
      ],
    });
  });

  await page.reload();
  await navigationButton(page, "console", "Console").click();
  const panel = page.getByTestId("terminal-panel-codex");
  await expect(
    page.getByRole("heading", { name: "Dual terminal console", exact: true }),
  ).toBeVisible();
  await expect(panel.getByRole("heading", { name: "Codex CLI", exact: true })).toBeVisible();
  const modelPicker = panel.getByRole("button", { name: "Codex CLI model" });
  await expect(modelPicker).toContainText("GPT-5.1 Codex");
  await modelPicker.click();
  await expect(page.getByRole("listbox", { name: "Codex CLI model" })).toBeVisible();
  await expect(page.getByRole("option", { name: "GPT-5.1 Codex" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.getByRole("option", { name: "GPT-5.1", exact: true }).click();
  const effortPicker = panel.getByRole("button", { name: "Codex CLI reasoning effort" });
  await effortPicker.click();
  await page.getByRole("option", { name: "high", exact: true }).click();
  await expect(modelPicker).toContainText("GPT-5.1");
  await expect(effortPicker).toContainText("high");
  await expect(
    page
      .getByTestId("terminal-panel-claude")
      .getByText(
        "This model does not expose reasoning-effort options. The model default will be used.",
        { exact: true },
      ),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        ([currentProjectId]) =>
          localStorage.getItem(`crossagent.console.preference.${currentProjectId}.codex`),
        [project.id],
      ),
    )
    .toContain('"reasoningEffort":"high"');

  await navigationButton(page, "settings", "Settings").click();
  await navigationButton(page, "console", "Console").click();
  await expect(panel.getByRole("button", { name: "Codex CLI model" })).toContainText("GPT-5.1");
  await expect(panel.getByRole("button", { name: "Codex CLI reasoning effort" })).toContainText(
    "high",
  );
  await modelPicker.click();
  await page.screenshot({
    path: resolve(screenshots, `console-model-picker-${testInfo.project.name}.png`),
    fullPage: true,
  });
  await page.keyboard.press("Escape");

  await modelPicker.click();
  await page.getByRole("option", { name: "E2E No Effort", exact: true }).click();
  await expect(effortPicker).toContainText("Model default");
  await expect(effortPicker).toBeDisabled();
  await modelPicker.click();
  await page.getByRole("option", { name: "GPT-5.1", exact: true }).click();
  await effortPicker.click();
  await page.getByRole("option", { name: "high", exact: true }).click();

  const spawnRequest = page.waitForRequest(
    (candidate) =>
      candidate.method() === "POST" && /\/api\/projects\/[^/]+\/terminals$/.test(candidate.url()),
  );
  await panel.getByRole("button", { name: "New terminal", exact: true }).click();
  const spawnPayload = (await spawnRequest).postDataJSON() as {
    shell: string;
    modelPresetId: string;
    reasoningEffort: string;
    cols: number;
    rows: number;
  };
  expect(spawnPayload.shell).toBe("codex");
  expect(spawnPayload.modelPresetId).toBe("mdp_codex_gpt51");
  expect(spawnPayload.reasoningEffort).toBe("high");
  expect(spawnPayload.cols).toBeGreaterThanOrEqual(20);
  expect(spawnPayload.rows).toBeGreaterThanOrEqual(5);
  await expect(panel.getByText("Terminal online", { exact: true })).toBeVisible();
  await expect(panel.locator(".console-xterm")).toContainText("mock backlog ready");

  const terminalInput = panel.locator("textarea.xterm-helper-textarea");
  await terminalInput.focus();
  await page.keyboard.type("status");
  await page.keyboard.press("Enter");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const harness = (
          window as unknown as {
            __consoleTerminalHarness: { frames: Array<{ type: string; data?: string }> };
          }
        ).__consoleTerminalHarness;
        return harness.frames
          .filter((frame) => frame.type === "input")
          .map((frame) => frame.data ?? "")
          .join("");
      }),
    )
    .toContain("status\r");

  const socketCountBeforeRevoke = await page.evaluate(
    () =>
      (
        window as unknown as {
          __consoleTerminalHarness: { sockets: unknown[] };
        }
      ).__consoleTerminalHarness.sockets.length,
  );
  await page.evaluate((currentProjectId) => {
    const harness = (
      window as unknown as {
        __consoleTerminalHarness: {
          emit: (frame: Record<string, unknown> & { type: string }) => void;
        };
      }
    ).__consoleTerminalHarness;
    harness.emit({
      type: "unauthorized",
      projectId: currentProjectId,
      message: "Terminal authorization is REVOKED",
    });
  }, project.id);
  await expect(panel.getByText("Terminal control locked", { exact: true })).toBeVisible();
  await expect(
    panel.getByText("Terminal authorization was revoked and must be approved again.", {
      exact: true,
    }),
  ).toBeVisible();
  await page.waitForTimeout(250);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              __consoleTerminalHarness: { sockets: unknown[] };
            }
          ).__consoleTerminalHarness.sockets.length,
      ),
    )
    .toBe(socketCountBeforeRevoke);

  await page.screenshot({
    path: resolve(screenshots, `console-revoked-${testInfo.project.name}.png`),
    fullPage: true,
  });

  const deleteRequest = page.waitForRequest(
    (candidate) =>
      candidate.method() === "DELETE" && candidate.url().includes(`/api/terminals/pty_${marker}`),
  );
  await panel.getByRole("button", { name: "Terminate", exact: true }).click();
  await panel.getByRole("button", { name: "Confirm terminate", exact: true }).click();
  await deleteRequest;
});
