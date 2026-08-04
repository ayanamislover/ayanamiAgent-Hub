import websocket from "@fastify/websocket";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  HeartbeatInputSchema,
  ProjectSocketAuthenticateFrameSchema,
  ProjectSocketDeliveryFrameSchema,
  type DomainEvent,
} from "@crossagent/protocol";
import {
  assertLocalOrigin,
  requestPrincipal,
  type CredentialRegistry,
  type RequestPrincipal,
} from "../security/local-auth.js";
import type { HubStore } from "../services/hub-store.js";
import type { EventBus } from "../events/event-bus.js";
import { ForbiddenError } from "../domain/errors.js";

type SubscribeFrame = {
  type: "subscribe";
  clientType?: "dashboard" | "codex_bridge" | "claude_channel";
  client_type?: "dashboard" | "codex_bridge" | "claude_channel";
  projectId?: string;
  project_id?: string;
  sessionId?: string;
  session_id?: string;
  lastSequence?: number;
  last_sequence?: number;
};

export async function registerProjectWebSocket(
  app: FastifyInstance,
  store: HubStore,
  bus: EventBus,
  credentials: CredentialRegistry,
): Promise<void> {
  await app.register(websocket, {
    options: {
      maxPayload: 256 * 1024,
      perMessageDeflate: false,
    },
  });

  app.get(
    "/ws",
    {
      websocket: true,
      preValidation: async (request) => {
        assertLocalOrigin(request);
        const query = request.query as Record<string, unknown> | undefined;
        if (
          query?.token !== undefined ||
          request.headers.authorization !== undefined ||
          request.headers["x-crossagent-token"] !== undefined
        ) {
          throw new ForbiddenError(
            "Project WebSocket Agent bearer tokens must use the authenticate frame",
          );
        }
        const hasDashboardCookie = request.headers.cookie
          ?.split(";")
          .some((part) => part.trim().startsWith("crossagent_token="));
        if (hasDashboardCookie) credentials.authenticate(request, ["hub:dashboard"]);
      },
    },
    (socket, request) => {
      let principal: RequestPrincipal | null = null;
      try {
        principal = requestPrincipal(request);
      } catch {
        // Agent sockets authenticate in their first frame; no bearer is accepted in the URL.
      }
      let isDashboard =
        principal?.kind === "DASHBOARD_USER" && principal.scopes.includes("hub:dashboard");
      let isAgent = false;
      let authenticated = isDashboard;
      const disconnectClient = bus.connectWebSocket();
      let unsubscribe: (() => void) | null = null;
      let projectId: string | null = null;
      let sessionId: string | null = null;
      let subscribed = false;
      let overflowed = false;
      let terminal = false;
      const authenticationDeadline = setTimeout(() => {
        if (!authenticated && !terminal) {
          terminal = true;
          socket.close(1008, "Authentication required");
        }
      }, 3_000);
      authenticationDeadline.unref();

      const stopSubscription = () => {
        const stop = unsubscribe;
        unsubscribe = null;
        stop?.();
      };

      // Credential revocation is terminal for this socket. In particular, do not emit an error
      // frame from an outbound bus callback: once authority is gone, no further project data or
      // protocol frame may cross the connection. Clearing the subscription before close also makes
      // a concurrent project publish harmless while the WebSocket close handshake is in flight.
      const terminateRevokedSocket = () => {
        if (terminal) return;
        terminal = true;
        subscribed = false;
        projectId = null;
        sessionId = null;
        stopSubscription();
        if (socket.readyState === 0 || socket.readyState === 1) {
          socket.close(1008, "Credential is no longer active");
        }
      };

      const send = (value: unknown): boolean => {
        if (terminal || socket.readyState !== 1) return false;
        if (socket.bufferedAmount > 1024 * 1024) {
          if (!overflowed) {
            overflowed = true;
            socket.send(
              JSON.stringify({
                type: "resync_required",
                reason: "bounded_queue_overflow",
              }),
            );
          }
          stopSubscription();
          return false;
        }
        socket.send(JSON.stringify(value));
        return true;
      };

      const sendAuthenticated = (value: unknown): boolean => {
        if (terminal || !authenticated || !principal) return false;
        try {
          credentials.revalidate(principal);
        } catch {
          terminateRevokedSocket();
          return false;
        }
        return send(value);
      };

      const subscribe = (frame: SubscribeFrame) => {
        if (subscribed) {
          sendAuthenticated({
            type: "error",
            code: "ALREADY_SUBSCRIBED",
            message: "Subscribe only once",
          });
          return;
        }
        const requestedProjectId = frame.projectId ?? frame.project_id;
        if (!requestedProjectId) throw new Error("Subscribe frame requires projectId");
        if (isAgent && requestedProjectId !== principal?.projectId) {
          throw new Error("Agent WebSocket is bound to another project");
        }
        store.getProject(requestedProjectId);
        projectId = requestedProjectId;
        const declaredSessionId = frame.sessionId ?? frame.session_id ?? null;
        const requestedSessionId = isAgent ? (principal?.hubSessionId ?? null) : declaredSessionId;
        if (isAgent && declaredSessionId && declaredSessionId !== requestedSessionId) {
          throw new Error("Agent WebSocket is bound to another session");
        }
        if (requestedSessionId && !isAgent) {
          throw new Error(
            "Dashboard WebSocket subscriptions are read-only and cannot bind a session",
          );
        }
        if (requestedSessionId) {
          const session = store.getSession(requestedSessionId);
          if (session.projectId !== requestedProjectId) {
            throw new Error("Session and WebSocket subscription belong to different projects");
          }
          if (session.connectionState === "CLOSED") {
            throw new Error("Closed sessions cannot bind a WebSocket subscription");
          }
          store.assertSessionControl(principal!, requestedSessionId);
        }
        sessionId = requestedSessionId;
        const lastSequence = Math.max(0, frame.lastSequence ?? frame.last_sequence ?? 0);
        for (const event of store.listEvents(
          requestedProjectId,
          lastSequence,
          5000,
          undefined,
          principal!,
        )) {
          if (!sendAuthenticated({ type: "event", event, replay: true })) return;
        }
        unsubscribe = bus.subscribe(requestedProjectId, (event: DomainEvent) => {
          sendAuthenticated({
            type: "event",
            event: store.projectEventForPrincipal(principal!, event),
            replay: false,
          });
        });
        const overview = store.getOverview(requestedProjectId, principal!);
        subscribed = true;
        sendAuthenticated({
          type: "subscribed",
          projectId: requestedProjectId,
          currentSequence: overview.currentSequence,
          serverTime: new Date().toISOString(),
        });
      };

      socket.on("message", (buffer: Buffer) => {
        if (!authenticated) {
          let frame: unknown;
          try {
            frame = JSON.parse(buffer.toString());
          } catch {
            terminal = true;
            socket.close(1008, "Invalid authentication frame");
            return;
          }
          const parsed = ProjectSocketAuthenticateFrameSchema.safeParse(frame);
          if (!parsed.success) {
            terminal = true;
            socket.close(1008, "Invalid authentication frame");
            return;
          }
          try {
            const authenticationRequest = {
              headers: { authorization: `Bearer ${parsed.data.token}` },
              query: {},
            } as FastifyRequest;
            const candidate = credentials.authenticate(authenticationRequest, ["hub:session"]);
            if (
              candidate.kind !== "AGENT" ||
              candidate.credentialClass !== "SESSION_TICKET" ||
              candidate.ticketPurpose !== "CONTROL" ||
              candidate.ticketState !== "ACTIVE" ||
              !candidate.projectId ||
              !candidate.hubSessionId
            ) {
              throw new Error("CONTROL ticket required");
            }
            principal = candidate;
            isAgent = true;
            isDashboard = false;
            authenticated = true;
            clearTimeout(authenticationDeadline);
            send({ type: "authenticated" });
          } catch {
            terminal = true;
            socket.close(1008, "Authentication failed");
          }
          return;
        }
        if ((buffer.length > 0 && !principal) || terminal) return;
        try {
          credentials.revalidate(principal!);
        } catch {
          terminateRevokedSocket();
          return;
        }
        let frame: any;
        try {
          frame = JSON.parse(buffer.toString());
        } catch {
          sendAuthenticated({ type: "error", code: "INVALID_JSON", message: "Frame must be JSON" });
          return;
        }
        try {
          if (frame.type === "subscribe") {
            subscribe(frame);
            return;
          }
          if (frame.type === "authenticate") {
            terminal = true;
            stopSubscription();
            socket.close(1008, "Authentication may be sent only once");
            return;
          }
          if (!subscribed || !projectId) {
            sendAuthenticated({
              type: "error",
              code: "SUBSCRIBE_REQUIRED",
              message: "Subscribe first",
            });
            return;
          }
          if (frame.type === "pong") return;
          if (["heartbeat", "delivery", "reconcile_git"].includes(frame.type) && !isAgent) {
            throw new Error("Dashboard WebSocket subscriptions are read-only");
          }
          if (frame.type === "heartbeat") {
            if (!sessionId) throw new Error("Heartbeat frames require an agent session");
            const parsed = HeartbeatInputSchema.safeParse(frame.heartbeat);
            if (!parsed.success) {
              sendAuthenticated({
                type: "error",
                code: "INVALID_HEARTBEAT_FRAME",
                message: "Heartbeat frame does not match the protocol",
              });
              return;
            }
            const heartbeat = parsed.data;
            if (heartbeat.sessionId !== sessionId) {
              throw new Error("Heartbeat session does not match the subscription");
            }
            if (heartbeat.currentTaskId) {
              const task = store.getTask(heartbeat.currentTaskId);
              if (task.projectId !== projectId) {
                throw new Error(
                  "Heartbeat task and WebSocket subscription belong to different projects",
                );
              }
            }
            if (heartbeat.currentReviewId) {
              const review = store.getReview(heartbeat.currentReviewId);
              if (review.projectId !== projectId) {
                throw new Error(
                  "Heartbeat review and WebSocket subscription belong to different projects",
                );
              }
            }
            const session = store.heartbeat(heartbeat, principal!);
            sendAuthenticated({ type: "heartbeat_ack", sequence: heartbeat.sequence, session });
            return;
          }
          if (frame.type === "delivery") {
            if (!sessionId) throw new Error("Delivery frames require an agent session");
            const parsed = ProjectSocketDeliveryFrameSchema.safeParse(frame);
            if (!parsed.success) {
              sendAuthenticated({
                type: "error",
                code: "INVALID_DELIVERY_FRAME",
                message: "Delivery frame does not match the protocol",
              });
              return;
            }
            const delivery = parsed.data;
            const message = store.updateMessageState(principal!, delivery.messageId, {
              sessionId,
              state: delivery.state,
              error: delivery.error,
              surfaceAttemptId: delivery.surfaceAttemptId,
              recipientFence: delivery.recipientFence,
              transport: delivery.transport,
              idempotencyKey:
                delivery.idempotencyKey ??
                `ws:${sessionId}:${delivery.messageId}:${delivery.state}:${delivery.attempt ?? 0}`,
            });
            sendAuthenticated({ type: "delivery_ack", messageId: delivery.messageId, message });
            return;
          }
          if (frame.type === "reconcile_git") {
            if (!sessionId) throw new Error("Git reconciliation requires an agent session");
            sendAuthenticated({
              type: "git_reconciled",
              ...store.reconcileObservedChanges(sessionId, principal!),
            });
            return;
          }
          sendAuthenticated({
            type: "error",
            code: "UNKNOWN_FRAME",
            message: `Unknown frame: ${frame.type}`,
          });
        } catch (error) {
          try {
            credentials.revalidate(principal!);
          } catch {
            terminateRevokedSocket();
            return;
          }
          sendAuthenticated({
            type: "error",
            code: "FRAME_FAILED",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      });

      const pingTimer = setInterval(() => {
        sendAuthenticated({ type: "ping", sentAt: new Date().toISOString() });
      }, 10_000);
      pingTimer.unref();

      socket.on("close", () => {
        terminal = true;
        clearTimeout(authenticationDeadline);
        clearInterval(pingTimer);
        stopSubscription();
        disconnectClient();
      });
    },
  );
}
