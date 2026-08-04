import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify, { LogController, type FastifyInstance } from "fastify";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { z, ZodError } from "zod";
import { registerApiRoutes } from "./api/routes.js";
import { loadRuntimeConfig, type RuntimeConfig } from "./config/runtime.js";
import { closeDatabase, openDatabase } from "./db/database.js";
import { HubError, hubErrorFromDatabase } from "./domain/errors.js";
import { EventBus } from "./events/event-bus.js";
import { registerMcpEndpoint } from "./mcp/server.js";
import {
  assertLocalOrigin,
  initializeCredentialRegistry,
  requestPrincipal,
  type LocalCredentials,
} from "./security/local-auth.js";
import { HubStore } from "./services/hub-store.js";
import { registerProjectWebSocket } from "./websocket/project-socket.js";
import { registerTerminalWebSocket } from "./websocket/terminal-socket.js";
import { PtyService, type PtySpawner } from "./services/pty-service.js";
import {
  assertVerifiedHubRelease,
  type RuntimeBuildIdentity,
  type VerifiedHubRelease,
} from "./runtime/build-identity.js";

export type HubServer = {
  app: FastifyInstance;
  store: HubStore;
  bus: EventBus;
  config: RuntimeConfig;
  token: string;
  tokenPath: string;
  credentials: LocalCredentials;
  buildIdentity: RuntimeBuildIdentity;
  instanceId: string;
  startedAt: string;
  shutdownRequested: Promise<{ idempotencyKey: string; scheduledAt: string }>;
  close: () => Promise<void>;
};

function findDashboardDir(config: RuntimeConfig): string | undefined {
  if (!config.dashboardDir) return undefined;
  const dashboardDir = resolve(config.dashboardDir);
  return existsSync(resolve(dashboardDir, "index.html")) ? dashboardDir : undefined;
}

/**
 * Runtime collaborators that are not configuration. Currently only the pty spawner, so a test can
 * exercise the terminal lifecycle without a native build or a real shell.
 */
export type HubServerDeps = {
  ptySpawner?: PtySpawner;
  /** Production runtime assets must come from the exact verified release root. */
  verifiedRelease?: VerifiedHubRelease;
};

const DASHBOARD_COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;
const PENDING_MCP_METHODS = new Set([
  "initialize",
  "notifications/initialized",
  "ping",
  "tools/list",
  "resources/list",
  "prompts/list",
]);
const PendingMcpRequestSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: z.union([z.string(), z.number().finite(), z.null()]).optional(),
    method: z.string().refine((method) => PENDING_MCP_METHODS.has(method)),
    params: z.union([z.record(z.string(), z.unknown()), z.array(z.unknown())]).optional(),
  })
  .strict();

function isPendingMcpHandshakeBody(value: unknown): boolean {
  const requests = Array.isArray(value) ? value : [value];
  return (
    requests.length > 0 &&
    requests.every((request) => PendingMcpRequestSchema.safeParse(request).success)
  );
}

function dashboardAuthCookie(token: string): string {
  return [
    `crossagent_token=${encodeURIComponent(token)}`,
    "HttpOnly",
    "SameSite=Strict",
    "Path=/",
    `Max-Age=${DASHBOARD_COOKIE_MAX_AGE_SECONDS}`,
  ].join("; ");
}

function isLoopbackHost(host: string): boolean {
  return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(host.trim().toLowerCase());
}

export async function createHubServer(
  overrides: Partial<RuntimeConfig> = {},
  deps: HubServerDeps = {},
): Promise<HubServer> {
  const verifiedRelease = deps.verifiedRelease;
  assertVerifiedHubRelease(verifiedRelease);
  const buildIdentity = Object.freeze({ ...verifiedRelease.buildIdentity });
  const instanceId = randomBytes(16).toString("hex");
  const startedAt = new Date().toISOString();
  let preparedShutdown: { idempotencyKey: string; scheduledAt: string } | null = null;
  let committedShutdown = false;
  let resolveShutdown!: (value: { idempotencyKey: string; scheduledAt: string }) => void;
  const shutdownRequested = new Promise<{ idempotencyKey: string; scheduledAt: string }>(
    (resolvePromise) => {
      resolveShutdown = resolvePromise;
    },
  );
  const prepareShutdown = (idempotencyKey: string) => {
    if (preparedShutdown && preparedShutdown.idempotencyKey !== idempotencyKey) {
      throw new HubError(
        "A different runtime shutdown is already pending",
        409,
        "RUNTIME_SHUTDOWN_CONFLICT",
      );
    }
    preparedShutdown ??= { idempotencyKey, scheduledAt: new Date().toISOString() };
    return { accepted: true as const, ...preparedShutdown };
  };
  const commitShutdown = (idempotencyKey: string) => {
    if (
      committedShutdown ||
      !preparedShutdown ||
      preparedShutdown.idempotencyKey !== idempotencyKey
    ) {
      return;
    }
    committedShutdown = true;
    resolveShutdown(preparedShutdown);
  };
  const config = loadRuntimeConfig({
    ...overrides,
    dashboardDir: verifiedRelease.dashboardDir,
  });
  if (config.dashboardAuthMode === "disabled" && !isLoopbackHost(config.host)) {
    throw new Error(
      "Dashboard authentication can only be disabled while the Hub listens on loopback",
    );
  }
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.x-crossagent-token",
          "req.headers.cookie",
          "req.query.token",
        ],
        censor: "[REDACTED]",
      },
    },
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 12 * 1024 * 1024,
    requestTimeout: 30_000,
  });

  // Fastify's default JSON parser rejects an empty body, so any client that sets a JSON
  // content-type on a DELETE — which is the normal thing for a client with one shared request
  // helper — got a 500 instead of performing the delete. Treat an empty body as no body.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_request, payload, done) => {
    const text = typeof payload === "string" ? payload.trim() : "";
    if (!text) return done(null, undefined);
    try {
      done(null, JSON.parse(text));
    } catch (error) {
      done(error as Error, undefined);
    }
  });
  const database = await openDatabase(config.databasePath, {
    migrationsDir: verifiedRelease.migrationsDir,
  });
  const bus = new EventBus();
  const store = new HubStore(database, bus, { dataDir: config.dataDir });
  const credentialRegistry = initializeCredentialRegistry(database.sqlite, config.dataDir);
  const credentials = credentialRegistry.credentials;
  const dashboardLaunchCodes = new Map<string, { expiresAt: number; principalId: string }>();

  await app.register(cors, {
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      try {
        const url = new URL(origin);
        callback(null, ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
      } catch {
        callback(null, false);
      }
    },
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "authorization",
      "content-type",
      "x-crossagent-token",
      "mcp-protocol-version",
      "mcp-session-id",
    ],
  });

  app.addHook("preValidation", async (request) => {
    assertLocalOrigin(request);
    if (request.method === "OPTIONS") return;
    if (request.url.startsWith("/api/health")) return;
    if (request.url.startsWith("/api/dashboard/exchange")) return;
    if (
      config.dashboardAuthMode === "disabled" &&
      request.method === "POST" &&
      /^\/api\/dashboard\/auth(?:\?|$)/u.test(request.url)
    ) {
      return;
    }
    if (request.url.startsWith("/api/user-turns/capture")) {
      try {
        credentialRegistry.authenticateBearer(request, ["user_turn:capture"]);
      } catch (activeError) {
        try {
          credentialRegistry.authenticateTerminalCaptureReplay(request);
        } catch {
          throw activeError;
        }
      }
      return;
    }
    if (
      /^\/api\/messages\/[^/]+\/synthetic-prompts(?:\?|$)/.test(request.url) ||
      /^\/api\/synthetic-prompts\/[^/]+\/abort(?:\?|$)/.test(request.url)
    ) {
      credentialRegistry.authenticateBearer(request, ["synthetic_prompt:reserve"]);
      return;
    }
    if (request.url.startsWith("/api/dashboard/")) {
      credentialRegistry.authenticate(request, ["hub:dashboard"]);
      return;
    }
    if (request.url.startsWith("/mcp")) {
      try {
        credentialRegistry.authenticate(request, ["hub:mcp"]);
      } catch (activeError) {
        if (!isPendingMcpHandshakeBody(request.body)) throw activeError;
        credentialRegistry.authenticateModelMcpHandshake(request);
      }
      return;
    }
    if (/^\/api\/projects\/[^/]+\/session-ticket-offers(?:\?|$)/u.test(request.url)) {
      try {
        credentialRegistry.authenticate(request, []);
      } catch (activeError) {
        try {
          credentialRegistry.authenticateExpiredControlReplacementRecovery(request);
        } catch {
          throw activeError;
        }
      }
      return;
    }
    if (
      request.method === "POST" &&
      /^\/api\/projects\/[^/]+\/sessions(?:\?|$)/u.test(request.url)
    ) {
      try {
        credentialRegistry.authenticatePendingControlEnrollment(request);
      } catch {
        credentialRegistry.authenticate(request, []);
      }
      return;
    }
    const closeMatch = /^\/api\/sessions\/([^/?]+)\/close(?:\?|$)/u.exec(request.url);
    if (request.method === "POST" && closeMatch) {
      try {
        credentialRegistry.authenticateAny(request, ["hub:session", "hub:dashboard"]);
      } catch {
        try {
          credentialRegistry.authenticateTerminalTicketReplay(request, {
            hubSessionId: decodeURIComponent(closeMatch[1]!),
          });
        } catch {
          try {
            credentialRegistry.authenticateExpiredTicketCloseRecovery(request, {
              hubSessionId: decodeURIComponent(closeMatch[1]!),
            });
          } catch {
            // The legacy fake-client close path keeps its compatibility principal. The Store gate
            // rejects every real Adapter/static-agent combination before any mutation.
            credentialRegistry.authenticate(request, []);
          }
        }
      }
      return;
    }
    const rotationMatch =
      /^\/api\/sessions\/([^/?]+)\/session-ticket-bundles\/([^/?]+)\/activate(?:\?|$)/u.exec(
        request.url,
      );
    if (request.method === "POST" && rotationMatch) {
      try {
        credentialRegistry.authenticate(request, ["hub:session"]);
      } catch {
        try {
          credentialRegistry.authenticateTerminalTicketReplay(request, {
            hubSessionId: decodeURIComponent(rotationMatch[1]!),
          });
        } catch {
          credentialRegistry.authenticateExpiredTicketRotationRecovery(request, {
            hubSessionId: decodeURIComponent(rotationMatch[1]!),
          });
        }
      }
      return;
    }
    if (request.url.startsWith("/api/projects/join")) {
      credentialRegistry.authenticateAny(request, ["project:join", "hub:dashboard"]);
      return;
    }
    if (
      request.url === "/api/projects" ||
      /^\/api\/projects\/[^/]+\/registration(?:\?|$)/u.test(request.url)
    ) {
      credentialRegistry.authenticateAny(request, [
        "project:select",
        "hub:session",
        "hub:dashboard",
      ]);
      return;
    }
    if (/^\/api\/projects\/[^/]+\/session-launch-reservations(?:\?|$)/u.test(request.url)) {
      credentialRegistry.authenticateAny(request, [
        "session:enroll:first",
        "hub:session",
        "hub:dashboard",
      ]);
      return;
    }
    if (
      request.method === "POST" &&
      /^\/api\/messages\/[^/]+\/(?:ack|processed|responded)(?:\?|$)/u.test(request.url)
    ) {
      // Codex model receipts use its same-session MODEL_MCP ticket. Claude Channel performs the
      // equivalent operation through its local CONTROL-ticketed proxy. The Store rechecks the
      // exact client/session/purpose after this coarse transport scope gate.
      credentialRegistry.authenticateAny(request, ["hub:mcp", "hub:session"]);
      return;
    }
    if (request.url.startsWith("/api/")) {
      credentialRegistry.authenticateAny(request, ["hub:session", "hub:dashboard"]);
    }
  });

  // A session ticket is a one-project capability. Enforce path binding once for the entire REST
  // surface so a newly-added project route cannot accidentally omit its own project comparison.
  app.addHook("preHandler", async (request) => {
    const match = /^\/api\/projects\/([^/?]+)(?:[/?]|$)/u.exec(request.url);
    if (!match || match[1] === "join") return;
    const principal = requestPrincipal(request);
    const pendingRegistration =
      request.method === "POST" &&
      /^\/api\/projects\/[^/]+\/sessions(?:\?|$)/u.test(request.url) &&
      principal.credentialClass === "SESSION_TICKET" &&
      principal.ticketPurpose === "CONTROL" &&
      principal.ticketState === "PENDING";
    const expiredReplacementOffer =
      request.method === "POST" &&
      /^\/api\/projects\/[^/]+\/session-ticket-offers(?:\?|$)/u.test(request.url) &&
      principal.credentialClass === "SESSION_TICKET" &&
      principal.ticketPurpose === "CONTROL" &&
      principal.ticketState === "EXPIRED" &&
      principal.scopes.length === 0;
    if (pendingRegistration || expiredReplacementOffer) return;
    if (
      principal.credentialClass === "SESSION_TICKET" &&
      principal.projectId !== decodeURIComponent(match[1]!)
    ) {
      throw new HubError("Credential cannot access another project", 403, "PROJECT_NOT_AUTHORIZED");
    }
    if (principal.credentialClass === "SESSION_TICKET") {
      if (!principal.hubSessionId) {
        throw new HubError("Ticket has no active session binding", 403, "PROJECT_NOT_AUTHORIZED");
      }
      store.assertProjectRead(principal, decodeURIComponent(match[1]!));
    }
  });

  app.post("/api/dashboard/launch", async (request) => {
    const code = randomBytes(24).toString("base64url");
    const expiresAt = Date.now() + 60_000;
    const principal = credentialRegistry.authenticate(request, ["hub:dashboard"]);
    dashboardLaunchCodes.set(code, { expiresAt, principalId: principal.id });
    for (const [candidate, entry] of dashboardLaunchCodes) {
      if (entry.expiresAt < Date.now()) dashboardLaunchCodes.delete(candidate);
    }
    return { code, expiresAt: new Date(expiresAt).toISOString() };
  });

  app.post("/api/dashboard/exchange", async (request, reply) => {
    const value = request.body as { code?: string } | undefined;
    const launch = value?.code ? dashboardLaunchCodes.get(value.code) : undefined;
    if (!value?.code || !launch || launch.expiresAt < Date.now()) {
      return reply.code(403).send({
        code: "INVALID_LAUNCH_CODE",
        message: "Dashboard launch code is missing, expired, or already used",
      });
    }
    dashboardLaunchCodes.delete(value.code);
    reply.header("set-cookie", dashboardAuthCookie(credentials.dashboard.token));
    return { ok: true };
  });

  app.post("/api/dashboard/auth", async (_request, reply) => {
    reply.header("set-cookie", dashboardAuthCookie(credentials.dashboard.token));
    return { ok: true, authMode: config.dashboardAuthMode };
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(422).send({
        code: "VALIDATION_ERROR",
        message: "Request validation failed",
        issues: error.issues,
        requestId: request.id,
      });
    }
    if (error instanceof HubError) {
      return reply.code(error.statusCode).send({
        code: error.code,
        message: error.message,
        current: error.current,
        requestId: request.id,
      });
    }
    const refused = hubErrorFromDatabase(error);
    if (refused) {
      // Logged at warn, not error: the Hub is working exactly as designed. Something asked for a
      // write the durable layer forbids, and the caller is being told so.
      request.log.warn({ err: error }, "Durable invariant refused a write");
      return reply.code(refused.statusCode).send({
        code: refused.code,
        message: refused.message,
        requestId: request.id,
      });
    }
    request.log.error({ err: error }, "Unhandled request error");
    return reply.code(500).send({
      code: "INTERNAL_ERROR",
      message: error instanceof Error ? error.message : "Unknown error",
      requestId: request.id,
    });
  });

  const pty = new PtyService(store, deps.ptySpawner);
  await registerApiRoutes(app, store, config, pty, {
    buildIdentity,
    instanceId,
    startedAt,
    prepareShutdown,
    commitShutdown,
  });
  // The websocket plugin is registered by the project socket; the terminal route reuses it and
  // therefore has to come after.
  await registerProjectWebSocket(app, store, bus, credentialRegistry);
  registerTerminalWebSocket(app, pty, credentialRegistry);
  await registerMcpEndpoint(app, store);

  const dashboardDir = findDashboardDir(config);
  if (dashboardDir) {
    await app.register(fastifyStatic, {
      root: dashboardDir,
      // Must stay true: with wildcard:false @fastify/static enumerates the directory once at
      // registration, so any asset rebuilt while the Hub is running 404s into the SPA fallback
      // and the browser receives index.html in place of the stylesheet.
      wildcard: true,
      // @fastify/static 10 hands this a FastifyReply where 8 handed the raw ServerResponse, so the
      // headers go through the Fastify API rather than node's.
      setHeaders(reply) {
        reply.header("Cache-Control", "no-store");
        reply.header("X-Content-Type-Options", "nosniff");
        reply.header("Referrer-Policy", "no-referrer");
      },
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/") || request.url.startsWith("/mcp")) {
        return reply.code(404).send({ code: "NOT_FOUND", message: "Route not found" });
      }
      return reply.sendFile("index.html");
    });
  } else {
    app.get("/", async () => ({
      service: "crossagent-hub",
      dashboard: "not_built",
      hint: "Run pnpm --filter @crossagent/dashboard build",
    }));
  }

  const presenceTimer = setInterval(() => store.refreshDerivedPresence(), 5_000);
  presenceTimer.unref();

  const close = async () => {
    clearInterval(presenceTimer);
    pty.disposeAll();
    await app.close();
    closeDatabase(database);
  };

  return {
    app,
    store,
    bus,
    config,
    token: credentials.agent.token,
    tokenPath: credentials.agent.path,
    credentials,
    buildIdentity,
    instanceId,
    startedAt,
    shutdownRequested,
    close,
  };
}
