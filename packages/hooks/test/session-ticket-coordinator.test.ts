import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { HookSessionTicketCoordinator } from "../src/session-ticket-coordinator.js";
import {
  HookSessionTicketStore,
  type HookTicketSessionIdentity,
} from "../src/session-ticket-store.js";

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const identity: HookTicketSessionIdentity = {
  projectId: "prj_ticket_hook",
  adapterClient: "codex",
  agentId: "codex",
  sessionClient: "codex-cli-hooks",
  externalSessionId: "external-ticket-hook",
  externalThreadId: "external-ticket-hook",
};

function session(
  now: string,
  cwd: string,
  input: { id?: string; incarnation?: number; predecessorSessionId?: string | null } = {},
) {
  return {
    id: input.id ?? "ses_ticket_hook",
    projectId: identity.projectId,
    agentId: identity.agentId,
    role: "primary",
    client: identity.sessionClient,
    transport: "hook-poll",
    deliveryMode: "hook_poll",
    externalSessionId: identity.externalSessionId,
    externalThreadId: identity.externalThreadId,
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
    lineageId: "lin_ticket_hook",
    incarnation: input.incarnation ?? 1,
    predecessorSessionId: input.predecessorSessionId ?? null,
    supersededBySessionId: null,
    launcherRunId: null,
    launchGeneration: null,
    version: 0,
  };
}

function ticketHarness(input: {
  cwd: string;
  existingHead?: boolean;
  delayRegisterMs?: number;
  now?: () => Date;
  corruptOfferPurpose?: "CONTROL" | "CAPTURE";
  expiredOfferPurpose?: "CONTROL" | "CAPTURE";
  loseFirstCloseResponse?: boolean;
}) {
  const currentNow = () => input.now?.() ?? new Date("2026-08-01T00:00:00.000Z");
  const calls: Array<{
    path: string;
    authorization: string;
    body: Record<string, unknown> | null;
  }> = [];
  const offers = new Map<string, { id: string; tokenSha256: string; purpose: string }>();
  let registrationCount = 0;
  let closeCount = 0;
  let latestActiveBinding: Record<string, unknown> | undefined;
  let latestSession: Record<string, unknown> | undefined;
  const fetch = (async (request: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(request));
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    const authorization = String(
      (init?.headers as Record<string, string> | undefined)?.authorization ?? "",
    );
    calls.push({ path: url.pathname, authorization, body });
    if (url.pathname.endsWith("/session-lineages/head")) {
      return response(
        input.existingHead
          ? {
              lineageId: "lin_existing",
              headSessionId: "ses_existing",
              headIncarnation: 1,
              version: 1,
            }
          : null,
      );
    }
    if (url.pathname.endsWith("/session-ticket-offers")) {
      const purpose = String(body?.purpose);
      const bundleId = String(body?.bundle_id);
      const id = `stk_hook_${purpose.toLowerCase()}_${offers.size + 1}`;
      offers.set(`${bundleId}:${purpose}`, {
        id,
        tokenSha256: String(body?.token_sha256),
        purpose,
      });
      const now = currentNow();
      return response({
        id,
        bundle_id: body?.bundle_id,
        purpose:
          input.corruptOfferPurpose === purpose
            ? purpose === "CONTROL"
              ? "CAPTURE"
              : "CONTROL"
            : purpose,
        state: "PENDING",
        project_id: identity.projectId,
        adapter_client: "codex",
        agent_id: "codex",
        session_client: "codex-cli-hooks",
        role: "primary",
        transport: "hook-poll",
        delivery_mode: "hook_poll",
        external_session_id: identity.externalSessionId,
        external_thread_id: identity.externalThreadId,
        run_id: body?.run_id,
        offer_expires_at: new Date(
          now.getTime() + (input.expiredOfferPurpose === purpose ? -1 : 5 * 60_000),
        ).toISOString(),
      });
    }
    if (url.pathname.endsWith("/sessions")) {
      if (input.delayRegisterMs) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, input.delayRegisterMs));
      }
      registrationCount += 1;
      const now = currentNow();
      const nowIso = now.toISOString();
      const bundleId = String(body?.ticket_bundle_id);
      const sessionId =
        registrationCount === 1 ? "ses_ticket_hook" : `ses_ticket_hook_${registrationCount}`;
      const activeBinding = {
        bundleId: body?.ticket_bundle_id,
        state: "ACTIVE",
        projectId: identity.projectId,
        agentId: "codex",
        adapterClient: "codex",
        hubSessionId: sessionId,
        lineageId: "lin_ticket_hook",
        incarnation: registrationCount,
        runId: body?.ticket_bundle_id,
        activatedAt: nowIso,
        expiresAt: new Date(now.getTime() + 24 * 60 * 60_000).toISOString(),
        purposes: [
          { id: offers.get(`${bundleId}:CONTROL`)?.id, purpose: "CONTROL", state: "ACTIVE" },
          { id: offers.get(`${bundleId}:CAPTURE`)?.id, purpose: "CAPTURE", state: "ACTIVE" },
        ],
      };
      // The coordinator validates runId against its persisted pending bundle, so copy the real one.
      activeBinding.runId = calls.find(
        (call) => call.body?.purpose === "CONTROL" && call.body.bundle_id === bundleId,
      )?.body?.run_id;
      latestActiveBinding = activeBinding;
      latestSession = session(nowIso, input.cwd, {
        id: sessionId,
        incarnation: registrationCount,
        predecessorSessionId:
          registrationCount === 1
            ? null
            : registrationCount === 2
              ? "ses_ticket_hook"
              : `ses_ticket_hook_${registrationCount - 1}`,
      });
      return response({
        session: latestSession,
        ticketBinding: activeBinding,
        serverNow: nowIso,
      });
    }
    if (url.pathname.includes("/api/sessions/") && url.pathname.endsWith("/close")) {
      closeCount += 1;
      if (input.loseFirstCloseResponse && closeCount === 1) {
        return response({ code: "LOST_RESPONSE" }, 503);
      }
      if (!latestActiveBinding || !latestSession) {
        return response({ code: "NO_ACTIVE_SESSION" }, 409);
      }
      const terminalAt = currentNow().toISOString();
      const terminalReason = String(body?.reason);
      const terminalBinding = {
        ...latestActiveBinding,
        state: "REVOKED",
        terminalAt,
        terminalReason,
        purposes: (latestActiveBinding.purposes as Array<Record<string, unknown>>).map(
          (purpose) => ({
            ...purpose,
            state: "REVOKED",
            terminalAt,
            terminalReason,
          }),
        ),
      };
      return response({
        session: { ...latestSession, connectionState: "OFFLINE", version: 1 },
        ticketBinding: terminalBinding,
      });
    }
    if (url.pathname === "/probe-control" || url.pathname === "/probe-capture") {
      return response({ ok: true });
    }
    return response({ message: `unexpected ${url.pathname}` }, 404);
  }) as typeof globalThis.fetch;
  return { calls, fetch };
}

function coordinator(input: {
  directory: string;
  cwd: string;
  fetch: typeof fetch;
  now?: () => Date;
}) {
  return new HookSessionTicketCoordinator({
    store: new HookSessionTicketStore({ directory: input.directory }),
    agentBootstrapToken: "agent-bootstrap-token",
    captureBootstrapToken: "capture-bootstrap-token",
    baseUrl: "http://127.0.0.1:4387",
    fetch: input.fetch,
    now: input.now ?? (() => new Date("2026-08-01T00:00:00.000Z")),
  });
}

describe("HookSessionTicketCoordinator", () => {
  it("uses static credentials only to offer, then rebuilds exact CONTROL and CAPTURE clients", async () => {
    const directory = mkdtempSync(resolve(tmpdir(), "crossagent-hook-ticket-coordinator-"));
    const cwd = resolve(directory, "project");
    const harness = ticketHarness({ cwd });
    const runtime = await coordinator({ directory, cwd, fetch: harness.fetch }).open({
      identity,
      cwd,
    });

    const controlOffer = harness.calls.find((call) => call.body?.purpose === "CONTROL");
    const captureOffer = harness.calls.find((call) => call.body?.purpose === "CAPTURE");
    const register = harness.calls.find((call) => call.path.endsWith("/sessions"));
    expect(controlOffer?.authorization).toBe("Bearer agent-bootstrap-token");
    expect(captureOffer?.authorization).toBe("Bearer capture-bootstrap-token");
    expect(register?.authorization).not.toBe("Bearer agent-bootstrap-token");
    expect(register?.authorization).not.toBe("Bearer capture-bootstrap-token");

    await runtime.controlClient.request("GET", "/probe-control");
    await runtime.captureClient.request("GET", "/probe-capture");
    const controlProbe = harness.calls.find((call) => call.path === "/probe-control");
    const captureProbe = harness.calls.find((call) => call.path === "/probe-capture");
    expect(controlProbe?.authorization).not.toBe(controlOffer?.authorization);
    expect(captureProbe?.authorization).not.toBe(captureOffer?.authorization);
    expect(controlProbe?.authorization).not.toBe(captureProbe?.authorization);
  });

  it("allows two independent Hook invocations to perform only one enrollment", async () => {
    const directory = mkdtempSync(resolve(tmpdir(), "crossagent-hook-ticket-race-"));
    const cwd = resolve(directory, "project");
    const harness = ticketHarness({ cwd, delayRegisterMs: 30 });
    const first = coordinator({ directory, cwd, fetch: harness.fetch });
    const second = coordinator({ directory, cwd, fetch: harness.fetch });

    const [left, right] = await Promise.all([
      first.open({ identity, cwd }),
      second.open({ identity, cwd }),
    ]);

    expect(left.session.id).toBe(right.session.id);
    expect(harness.calls.filter((call) => call.body?.purpose === "CONTROL")).toHaveLength(1);
    expect(harness.calls.filter((call) => call.body?.purpose === "CAPTURE")).toHaveLength(1);
    expect(harness.calls.filter((call) => call.path.endsWith("/sessions"))).toHaveLength(1);
  });

  it("fails closed when local secrets are missing for an existing lineage", async () => {
    const directory = mkdtempSync(resolve(tmpdir(), "crossagent-hook-ticket-missing-"));
    const cwd = resolve(directory, "project");
    const harness = ticketHarness({ cwd, existingHead: true });

    let missingCode = "";
    try {
      await coordinator({ directory, cwd, fetch: harness.fetch }).open({ identity, cwd });
    } catch (error) {
      missingCode = error instanceof Error ? error.message : "non_error";
    }
    expect(missingCode).toBe("hook_ticket_bundle_missing_for_existing_lineage");
    expect(harness.calls.some((call) => call.path.endsWith("/session-ticket-offers"))).toBe(false);
    expect(harness.calls.some((call) => call.path.endsWith("/sessions"))).toBe(false);
  });

  it("replaces an expired 25-hour current head with the old exact CONTROL proof", async () => {
    const directory = mkdtempSync(resolve(tmpdir(), "crossagent-hook-ticket-expired-"));
    const cwd = resolve(directory, "project");
    let now = new Date("2026-08-01T00:00:00.000Z");
    const harness = ticketHarness({ cwd, now: () => now });
    const first = coordinator({ directory, cwd, fetch: harness.fetch, now: () => now });
    const initial = await first.open({ identity, cwd });
    const initialControlAuthorization = `Bearer ${
      (await new HookSessionTicketStore({ directory }).read(identity))?.active?.control.rawToken
    }`;

    now = new Date("2026-08-02T01:00:00.000Z");
    const successor = await coordinator({
      directory,
      cwd,
      fetch: harness.fetch,
      now: () => now,
    }).open({ identity, cwd });

    expect(initial.session.id).toBe("ses_ticket_hook");
    expect(successor.session.id).toBe("ses_ticket_hook_2");
    const controlOffers = harness.calls.filter((call) => call.body?.purpose === "CONTROL");
    const captureOffers = harness.calls.filter((call) => call.body?.purpose === "CAPTURE");
    expect(controlOffers).toHaveLength(2);
    expect(controlOffers[1]?.authorization).toBe(initialControlAuthorization);
    expect(controlOffers[1]?.body).toMatchObject({
      activation_mode: "CURRENT_HEAD_REPLACEMENT",
      expected_lineage_id: "lin_ticket_hook",
      expected_head_session_id: "ses_ticket_hook",
    });
    expect(captureOffers).toHaveLength(2);
    expect(captureOffers[1]?.authorization).toBe("Bearer capture-bootstrap-token");
    expect(successor.ticketExpiresAt).toBe("2026-08-03T01:00:00.000Z");
  });

  it("uses fresh server time so a skewed host still replaces after 25 elapsed hours", async () => {
    const directory = mkdtempSync(resolve(tmpdir(), "crossagent-hook-ticket-skew-"));
    const cwd = resolve(directory, "project");
    let serverNow = new Date("2026-08-01T00:00:00.000Z");
    let localNow = new Date("2026-07-25T00:00:00.000Z");
    const harness = ticketHarness({ cwd, now: () => serverNow });
    await coordinator({
      directory,
      cwd,
      fetch: harness.fetch,
      now: () => localNow,
    }).open({ identity, cwd });

    serverNow = new Date("2026-08-02T01:00:00.000Z");
    localNow = new Date("2026-07-26T01:00:00.000Z");
    const successor = await coordinator({
      directory,
      cwd,
      fetch: harness.fetch,
      now: () => localNow,
    }).open({ identity, cwd });

    expect(successor.session.id).toBe("ses_ticket_hook_2");
    expect(harness.calls.filter((call) => call.body?.purpose === "CONTROL")).toHaveLength(2);
  });

  it("blocks replacement until the predecessor exact CAPTURE receipt replay drains", async () => {
    const directory = mkdtempSync(resolve(tmpdir(), "crossagent-hook-ticket-capture-drain-"));
    const cwd = resolve(directory, "project");
    let now = new Date("2026-08-01T00:00:00.000Z");
    const harness = ticketHarness({ cwd, now: () => now });
    await coordinator({ directory, cwd, fetch: harness.fetch, now: () => now }).open({
      identity,
      cwd,
    });
    now = new Date("2026-08-02T01:00:00.000Z");
    let replayAuthorization = "";

    let blockedCode = "";
    try {
      await coordinator({ directory, cwd, fetch: harness.fetch, now: () => now }).open({
        identity,
        cwd,
        beforeReplacement: async (channel) => {
          await channel.client.request("GET", "/probe-capture");
          replayAuthorization = harness.calls.at(-1)?.authorization ?? "";
          return "BLOCKED";
        },
      });
    } catch (error) {
      blockedCode = error instanceof Error ? error.message : "non_error";
    }
    expect(blockedCode).toBe("hook_ticket_terminal_capture_replay_pending");
    expect(harness.calls.filter((call) => call.body?.purpose === "CONTROL")).toHaveLength(1);

    const successor = await coordinator({
      directory,
      cwd,
      fetch: harness.fetch,
      now: () => now,
    }).open({
      identity,
      cwd,
      beforeReplacement: async (channel) => {
        await channel.client.request("GET", "/probe-capture");
        expect(harness.calls.at(-1)?.authorization).toBe(replayAuthorization);
        return "DRAINED";
      },
    });
    expect(successor.session.id).toBe("ses_ticket_hook_2");
  });

  it("keeps CLOSING state and replays one exact close after a lost response", async () => {
    const directory = mkdtempSync(resolve(tmpdir(), "crossagent-hook-ticket-close-replay-"));
    const cwd = resolve(directory, "project");
    const harness = ticketHarness({ cwd, loseFirstCloseResponse: true });
    const first = coordinator({ directory, cwd, fetch: harness.fetch });
    const runtime = await first.open({ identity, cwd });

    await expect(runtime.close("test_session_end")).rejects.toThrow(/503/u);
    expect((await new HookSessionTicketStore({ directory }).read(identity))?.state).toBe("CLOSING");

    const replay = await coordinator({ directory, cwd, fetch: harness.fetch }).open({
      identity,
      cwd,
    });
    await replay.close("test_session_end");

    const closeCalls = harness.calls.filter((call) => call.path.endsWith("/close"));
    expect(closeCalls).toHaveLength(2);
    expect(closeCalls[1]?.authorization).toBe(closeCalls[0]?.authorization);
    expect(closeCalls[1]?.body).toEqual(closeCalls[0]?.body);
    expect(await new HookSessionTicketStore({ directory }).read(identity)).toBeNull();
    expect(harness.calls.filter((call) => call.body?.purpose === "CONTROL")).toHaveLength(1);
  });

  it("never registers or persists ACTIVE when an offer receipt changes purpose", async () => {
    const directory = mkdtempSync(resolve(tmpdir(), "crossagent-hook-ticket-offer-mismatch-"));
    const cwd = resolve(directory, "project");
    const harness = ticketHarness({ cwd, corruptOfferPurpose: "CONTROL" });

    await expect(
      coordinator({ directory, cwd, fetch: harness.fetch }).open({ identity, cwd }),
    ).rejects.toThrow(/^hook_ticket_offer_receipt_mismatch$/u);
    expect(harness.calls.some((call) => call.path.endsWith("/sessions"))).toBe(false);
    expect((await new HookSessionTicketStore({ directory }).read(identity))?.state).toBe(
      "ENROLLING",
    );
  });

  it("rejects a structurally exact offer receipt that is already expired", async () => {
    const directory = mkdtempSync(resolve(tmpdir(), "crossagent-hook-ticket-expired-offer-"));
    const cwd = resolve(directory, "project");
    const harness = ticketHarness({ cwd, expiredOfferPurpose: "CONTROL" });

    let expiredCode = "";
    try {
      await coordinator({ directory, cwd, fetch: harness.fetch }).open({ identity, cwd });
    } catch (error) {
      expiredCode = error instanceof Error ? error.message : "non_error";
    }
    expect(expiredCode).toBe("hook_ticket_offer_receipt_mismatch");
    expect(harness.calls.some((call) => call.path.endsWith("/sessions"))).toBe(false);
  });
});
