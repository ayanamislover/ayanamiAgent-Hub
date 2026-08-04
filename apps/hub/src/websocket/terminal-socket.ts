import { TerminalClientFrameSchema, type TerminalServerFrame } from "@crossagent/protocol";
import type { FastifyInstance } from "fastify";
import { ForbiddenError, HubError } from "../domain/errors.js";
import {
  assertLocalOrigin,
  requestPrincipal,
  type CredentialRegistry,
} from "../security/local-auth.js";
import type { PtyService } from "../services/pty-service.js";

/**
 * Frames arrive from a browser and are therefore untrusted input, not a typed API: they get
 * parsed, not cast. The bounds mirror the REST spawn route so a session cannot be resized to
 * dimensions it could not have been created with.
 */
/**
 * One socket drives one terminal session. Input only ever flows from a client frame into the
 * pty — nothing here originates a command, which is the boundary that still matters now that
 * the command text itself is unrestricted.
 */
export function registerTerminalWebSocket(
  app: FastifyInstance,
  pty: PtyService,
  credentials: CredentialRegistry,
): void {
  app.get(
    "/ws/terminal",
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
            "Terminal WebSocket authentication requires the Dashboard cookie",
          );
        }
        credentials.authenticate(request, ["hub:dashboard"]);
      },
    },
    (socket, request) => {
      const principal = requestPrincipal(request);
      const allowed =
        principal.kind === "DASHBOARD_USER" && principal.scopes.includes("hub:dashboard");
      if (!allowed) {
        socket.close(1008, "Credential principal cannot use the terminal WebSocket");
        return;
      }
      let detach: (() => void) | null = null;
      let attachedId: string | null = null;
      let attachedProjectId: string | null = null;

      const dropAttachment = () => {
        detach?.();
        detach = null;
        attachedId = null;
        attachedProjectId = null;
      };

      const send = (frame: TerminalServerFrame) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame));
      };

      socket.on("message", (raw: Buffer) => {
        try {
          credentials.revalidate(principal);
        } catch (error) {
          dropAttachment();
          send({
            type: "unauthorized",
            projectId: null,
            message: error instanceof Error ? error.message : "Credential is no longer active",
          });
          socket.close(1008, "Credential is no longer active");
          return;
        }
        let payload: unknown;
        try {
          payload = JSON.parse(raw.toString());
        } catch {
          send({ type: "error", message: "Terminal frames must be JSON" });
          return;
        }
        const parsed = TerminalClientFrameSchema.safeParse(payload);
        if (!parsed.success) {
          const issue = parsed.error.issues[0];
          send({
            type: "error",
            message: issue
              ? `Invalid terminal frame: ${issue.path.join(".") || "type"} ${issue.message}`
              : "Invalid terminal frame",
          });
          return;
        }
        const frame = parsed.data;
        try {
          if (frame.type === "attach") {
            dropAttachment();
            const attachment = pty.attach(
              frame.projectId,
              frame.sessionId,
              (chunk) => send({ type: "output", data: chunk }),
              (exitCode) => send({ type: "exit", exitCode }),
            );
            detach = attachment.detach;
            attachedId = frame.sessionId;
            attachedProjectId = frame.projectId;
            send({ type: "attached", sessionId: frame.sessionId, backlog: attachment.backlog });
            return;
          }
          if (!attachedId) {
            send({ type: "error", message: "Attach to a session before sending input" });
            return;
          }
          if (frame.type === "input") pty.write(attachedId, frame.data);
          if (frame.type === "resize") pty.resize(attachedId, frame.cols, frame.rows);
        } catch (error) {
          // Losing authorization is not a failed frame, it is the end of this attachment: the
          // stream stops and the client has to attach again once the user re-approves. Anything
          // else (a session that exited, a pty write failure) leaves the attachment alone.
          const revoked = error instanceof HubError && error.code === "TERMINAL_NOT_AUTHORIZED";
          if (revoked) {
            const projectId = attachedProjectId;
            dropAttachment();
            send({
              type: "unauthorized",
              projectId,
              message: error.message,
            });
            return;
          }
          send({ type: "error", message: error instanceof Error ? error.message : "Unknown" });
        }
      });

      // Detaching leaves the pty running: closing a browser tab must not kill the user's shell.
      socket.on("close", () => detach?.());
    },
  );
}
