import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RequestPrincipal } from "../src/security/local-auth.js";
import { SESSION_TICKET_PURPOSES_BY_CLIENT } from "../src/security/session-tickets.js";
import { createHubServer, type HubServer } from "./test-server.js";

/**
 * The ticketed enrollment path had no test fixture, and that is why the fence bug reached
 * production: the only way to register through it is to hold a pending CONTROL ticket, so nothing
 * in the suite exercised it. This builds one.
 *
 * The principal is constructed rather than authenticated on purpose. Authentication has its own
 * tests in session-tickets.integration; what needs covering here is what the store does once a
 * legitimately ticketed caller arrives, which is exactly the seam that was untested.
 */
function controlTicketPrincipal(input: {
  projectId: string;
  controlTicketId: string;
}): RequestPrincipal {
  return {
    id: "prn_agent_claude",
    credentialId: input.controlTicketId,
    credentialClass: "SESSION_TICKET",
    kind: "AGENT",
    displayName: "Claude Agent",
    scopes: ["hub:agent"],
    projectId: input.projectId,
    clientType: "claude",
    hubSessionId: null,
    agentId: "claude",
    adapterClient: "claude",
    lineageId: null,
    incarnation: null,
    ticketPurpose: "CONTROL",
    ticketState: "PENDING",
    authenticatedVia: "authorization_bearer",
  };
}

/**
 * The live CONTROL ticket of the current head, which is the only principal permitted to offer a
 * CURRENT_HEAD_REPLACEMENT. A static credential may offer FIRST_LINEAGE and MANAGED_RESERVATION
 * only, so a replacement has to be offered by the binding it replaces -- exactly what the channel
 * does with the ticket in its vault.
 */
function activeControlPrincipal(input: {
  projectId: string;
  controlTicketId: string;
  hubSessionId: string;
  lineageId: string;
  incarnation: number;
}): RequestPrincipal {
  return {
    ...controlTicketPrincipal(input),
    scopes: ["session-ticket:offer"],
    hubSessionId: input.hubSessionId,
    lineageId: input.lineageId,
    incarnation: input.incarnation,
    ticketState: "ACTIVE",
  };
}

describe("launch fence and ticketed enrollment", () => {
  let server: HubServer;
  let projectId: string;
  let cwd: string;

  const EXTERNAL_SESSION_ID = "claude-channel:cci_fixture";

  /** Offers a complete pending bundle the way the channel does, and returns the CONTROL ticket. */
  const offerControlBundle = (input: {
    bundleId: string;
    runId: string;
    activationMode: "FIRST_LINEAGE" | "CURRENT_HEAD_REPLACEMENT" | "MANAGED_RESERVATION";
    expectedLineageId?: string;
    expectedHeadSessionId?: string;
    launchReservationId?: string;
    offeredBy?: RequestPrincipal;
  }): string => {
    let controlTicketId = "";
    for (const purpose of SESSION_TICKET_PURPOSES_BY_CLIENT["claude-channel"]) {
      const secret = randomBytes(32).toString("base64url");
      const offer = server.store.createSessionTicketOffer(
        input.offeredBy ?? server.credentials.agentByClient.claude.principal,
        projectId,
        {
          bundle_id: input.bundleId,
          purpose,
          token_sha256: createHash("sha256").update(secret, "utf8").digest("hex"),
          adapter_client: "claude",
          agent_id: "claude",
          session_client: "claude-channel",
          role: "primary",
          transport: "websocket",
          delivery_mode: "native_channel",
          external_session_id: EXTERNAL_SESSION_ID,
          external_thread_id: null,
          run_id: input.runId,
          activation_mode: input.activationMode,
          ...(input.expectedLineageId ? { expected_lineage_id: input.expectedLineageId } : {}),
          ...(input.expectedHeadSessionId
            ? { expected_head_session_id: input.expectedHeadSessionId }
            : {}),
          ...(input.launchReservationId
            ? { launch_reservation_id: input.launchReservationId }
            : {}),
          idempotency_key: `fixture-offer:${input.bundleId}:${purpose}`,
        },
      );
      if (purpose === "CONTROL") controlTicketId = offer.id;
    }
    return controlTicketId;
  };

  const enroll = (input: {
    bundleId: string;
    runId: string;
    activationMode: "FIRST_LINEAGE" | "CURRENT_HEAD_REPLACEMENT" | "MANAGED_RESERVATION";
    expectedLineageId?: string;
    expectedHeadSessionId?: string;
    launchReservationId?: string;
    launcherRunId?: string;
    launchGeneration?: number;
    offeredBy?: RequestPrincipal;
  }) => {
    const controlTicketId = offerControlBundle(input);
    return server.store.registerAdapterSession(
      {
        projectId,
        agentId: "claude",
        role: "primary",
        client: "claude-channel",
        transport: "websocket",
        deliveryMode: "native_channel",
        externalSessionId: EXTERNAL_SESSION_ID,
        capabilities: [],
        host: "fixture-host",
        cwd,
        idempotencyKey: `fixture-register:${input.bundleId}`,
        ticket_bundle_id: input.bundleId,
        ...(input.expectedHeadSessionId
          ? { expectedHeadSessionId: input.expectedHeadSessionId }
          : {}),
        ...(input.launcherRunId ? { launcherRunId: input.launcherRunId } : {}),
        ...(input.launchGeneration !== undefined
          ? { launchGeneration: input.launchGeneration }
          : {}),
      },
      controlTicketPrincipal({ projectId, controlTicketId }),
    );
  };

  /** Drives the lineage into the fenced state: one reservation consumed, so head_run_* are set. */
  const armFence = () => {
    const first = enroll({
      bundleId: "stb_fixture_first",
      runId: "run_fixture_first",
      activationMode: "FIRST_LINEAGE",
    });
    const reservation = server.store.reserveSessionLaunch(projectId, {
      agentId: "claude",
      client: "claude-channel",
      deliveryMode: "native_channel",
      externalSessionId: EXTERNAL_SESSION_ID,
      runId: "run_fixture_reserved",
      idempotencyKey: "fixture-reservation",
    });
    const second = enroll({
      bundleId: "stb_fixture_reserved",
      runId: reservation.runId,
      activationMode: "MANAGED_RESERVATION",
      expectedLineageId: reservation.lineageId,
      ...(reservation.expectedHeadSessionId
        ? { expectedHeadSessionId: reservation.expectedHeadSessionId }
        : {}),
      launchReservationId: reservation.id,
      launcherRunId: reservation.runId,
      launchGeneration: reservation.generation,
    });
    return { first, second, reservation };
  };

  const lineageRow = (lineageId: string) =>
    server.store.sqlite
      .prepare(
        `SELECT launch_fence_required, head_run_id, head_run_generation, head_incarnation
           FROM session_lineages WHERE id = ?`,
      )
      .get(lineageId) as {
      launch_fence_required: number;
      head_run_id: string | null;
      head_run_generation: number | null;
      head_incarnation: number;
    };

  const controlTicketOf = (bundleId: string): string =>
    server.store.sqlite
      .prepare("SELECT id FROM adapter_session_tickets WHERE bundle_id = ? AND purpose = 'CONTROL'")
      .pluck()
      .get(bundleId) as string;

  beforeEach(async () => {
    const root = mkdtempSync(resolve(tmpdir(), "hub-launch-fence-"));
    cwd = mkdtempSync(resolve(tmpdir(), "hub-launch-fence-cwd-"));
    server = await createHubServer({
      databasePath: resolve(root, "hub.db"),
      dataDir: resolve(root, "data"),
      dashboardDir: resolve(root, "missing-dashboard"),
      host: "127.0.0.1",
      port: 0,
      logLevel: "silent",
    });
    projectId = server.store.joinProject(server.credentials.dashboard.principal, {
      cwd: mkdtempSync(resolve(tmpdir(), "hub-launch-fence-project-")),
      name: "launch-fence",
      allowCreate: true,
    }).project.id;
  });

  afterEach(async () => {
    await server.app.close();
  });

  it("arms the fence and records a run identity once a reservation is consumed", () => {
    const { second } = armFence();
    const lineage = lineageRow(second.session.lineageId!);

    expect(lineage.launch_fence_required).toBe(1);
    expect(lineage.head_run_id).toBe("run_fixture_reserved");
    expect(lineage.head_run_generation).toBeGreaterThan(0);
  });

  it("refuses a ticket-only head advance on a fenced lineage with a code the caller can act on", () => {
    const { second } = armFence();
    const lineageId = second.session.lineageId!;
    const before = lineageRow(lineageId);

    // Exactly what the channel attempts when its vault still holds a live CONTROL binding. A valid
    // ticket proves identity; it does not exempt the holder from the launch fence, because 0006
    // keeps head_run_generation monotonic and this session would carry none.
    let thrown: unknown;
    try {
      enroll({
        bundleId: "stb_fixture_ticket_only",
        runId: "run_fixture_ticket_only",
        activationMode: "CURRENT_HEAD_REPLACEMENT",
        expectedLineageId: lineageId,
        expectedHeadSessionId: second.session.id,
        offeredBy: activeControlPrincipal({
          projectId,
          controlTicketId: controlTicketOf("stb_fixture_reserved"),
          hubSessionId: second.session.id,
          lineageId,
          incarnation: second.session.incarnation!,
        }),
      });
    } catch (error) {
      thrown = error;
    }

    // A coded 409, not a trigger abort surfacing as a 500. The distinction is the whole point: a
    // 500 reads as transient, and the channel retried one of these 76 times before giving up was
    // even possible.
    expect(thrown).toMatchObject({ statusCode: 409, code: "SESSION_LAUNCH_FENCE_REQUIRED" });

    // And the refusal left the lineage exactly as it found it.
    expect(lineageRow(lineageId)).toEqual(before);
  });

  it("accepts the same enrollment once it carries a reservation", () => {
    const { second } = armFence();
    const lineageId = second.session.lineageId!;
    const before = lineageRow(lineageId);

    const reservation = server.store.reserveSessionLaunch(projectId, {
      agentId: "claude",
      client: "claude-channel",
      deliveryMode: "native_channel",
      externalSessionId: EXTERNAL_SESSION_ID,
      runId: "run_fixture_converted",
      idempotencyKey: "fixture-reservation-converted",
    });
    const converted = enroll({
      bundleId: "stb_fixture_converted",
      runId: reservation.runId,
      activationMode: "MANAGED_RESERVATION",
      expectedLineageId: reservation.lineageId,
      ...(reservation.expectedHeadSessionId
        ? { expectedHeadSessionId: reservation.expectedHeadSessionId }
        : {}),
      launchReservationId: reservation.id,
      launcherRunId: reservation.runId,
      launchGeneration: reservation.generation,
    });

    const after = lineageRow(lineageId);
    expect(converted.session.id).not.toBe(second.session.id);
    expect(after.head_incarnation).toBe(before.head_incarnation + 1);
    // Monotonic, which is the invariant my first attempt at this fix violated by clearing it.
    expect(after.head_run_generation!).toBeGreaterThan(before.head_run_generation!);
  });
});
