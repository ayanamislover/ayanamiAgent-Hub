import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowsClockwise,
  CheckCircle,
  LockKey,
  Play,
  ShieldCheck,
  Stop,
  TerminalWindow,
  WarningCircle,
} from "@phosphor-icons/react";
import type { AuthorizationGrant, ModelPreset } from "@crossagent/protocol";
import type { TerminalClientFrame } from "@crossagent/protocol/terminal";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { hub, idempotency } from "../api.js";
import { Select } from "../components/select.js";
import { useUi } from "../store.js";
import { localeTag, t } from "../i18n.js";
import {
  chunkTerminalInput,
  clampTerminalSize,
  parseTerminalServerFrame,
  terminalSocketUrl,
  type TerminalSize,
} from "./console-contract.js";
import "./console.css";

type ConsoleAgentId = "codex" | "claude";

type TerminalSession = {
  id: string;
  projectId: string;
  label: string;
  shell: string;
  args: string[];
  cwd: string;
  cols: number;
  rows: number;
  pid: number;
  startedAt: string;
  exitedAt: string | null;
  exitCode: number | null;
};

type AuthorizationCheck = {
  allowed: boolean;
  grant: AuthorizationGrant | null;
};

type PanelState =
  | "idle"
  | "launching"
  | "connecting"
  | "attached"
  | "disconnected"
  | "revoked"
  | "exited"
  | "stopping"
  | "error";

const agentConfig: Record<
  ConsoleAgentId,
  { label: string; shell: string; color: string; softColor: string }
> = {
  codex: {
    label: "Codex CLI",
    shell: "codex",
    color: "#6fb8ff",
    softColor: "rgba(72, 153, 232, 0.14)",
  },
  claude: {
    label: "Claude Code",
    shell: "claude",
    color: "#ef9d68",
    softColor: "rgba(230, 126, 69, 0.14)",
  },
};

const stateLabel: Record<PanelState, string> = {
  idle: t("Not started"),
  launching: t("Launching"),
  connecting: t("Connecting"),
  attached: t("Terminal online"),
  disconnected: t("Disconnected"),
  revoked: t("Control permission revoked"),
  exited: t("Process exited"),
  stopping: t("Stopping"),
  error: t("Terminal error"),
};

function sendTerminalFrame(socket: WebSocket, frame: TerminalClientFrame): void {
  socket.send(JSON.stringify(frame));
}

function sessionMatchesAgent(session: TerminalSession, agentId: ConsoleAgentId): boolean {
  const shell = session.shell.toLowerCase();
  const label = session.label.toLowerCase();
  return shell.includes(agentId) || label.startsWith(`${agentId}:`);
}

function sessionTime(value: string): string {
  return new Intl.DateTimeFormat(localeTag(), {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

type ConsolePreference = {
  presetId: string;
  reasoningEffort: string;
};

function readConsolePreference(storageKey: string): ConsolePreference | null {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) ?? "null") as unknown;
    if (!value || typeof value !== "object") return null;
    const candidate = value as Partial<ConsolePreference>;
    if (typeof candidate.presetId !== "string" || typeof candidate.reasoningEffort !== "string") {
      return null;
    }
    return { presetId: candidate.presetId, reasoningEffort: candidate.reasoningEffort };
  } catch {
    return null;
  }
}

function TerminalPanel({
  agentId,
  projectId,
  presets,
  presetsLoading,
  presetsError,
  sessions,
  authorized,
  authorizationLoading,
}: {
  agentId: ConsoleAgentId;
  projectId: string;
  presets: ModelPreset[];
  presetsLoading: boolean;
  presetsError: unknown;
  sessions: TerminalSession[];
  authorized: boolean;
  authorizationLoading: boolean;
}) {
  const config = agentConfig[agentId];
  const queryClient = useQueryClient();
  const terminalHostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const statusRef = useRef<PanelState>("idle");
  const sizeRef = useRef<TerminalSize>({ cols: 120, rows: 30 });
  const autoAttachAttemptedRef = useRef(false);
  const stopTimerRef = useRef<number | null>(null);
  const preferenceStorageKey = `crossagent.console.preference.${projectId}.${agentId}`;
  const initialPreference = useRef(readConsolePreference(preferenceStorageKey));
  const [status, setStatus] = useState<PanelState>("idle");
  const [error, setError] = useState("");
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [selectedPresetId, setSelectedPresetId] = useState(
    () => initialPreference.current?.presetId ?? "",
  );
  const [reasoningEffort, setReasoningEffort] = useState(
    () => initialPreference.current?.reasoningEffort ?? "",
  );
  const [selectedSessionId, setSelectedSessionId] = useState("");
  const [stopArmed, setStopArmed] = useState(false);
  const sessionStorageKey = `crossagent.console.session.${projectId}.${agentId}`;
  const revokedStorageKey = `crossagent.console.revoked.${projectId}.${agentId}`;

  const updateStatus = useCallback((next: PanelState) => {
    statusRef.current = next;
    setStatus(next);
  }, []);

  const enabledPresets = useMemo(
    () =>
      presets
        .filter((preset) => preset.enabled)
        .sort((left, right) => left.sortOrder - right.sortOrder),
    [presets],
  );
  const selectedPreset = enabledPresets.find((preset) => preset.id === selectedPresetId);
  const effortIsValid = Boolean(
    selectedPreset &&
    (!reasoningEffort || selectedPreset.reasoningEfforts.includes(reasoningEffort)),
  );
  const panelSessions = useMemo(
    () =>
      sessions
        .filter((session) => sessionMatchesAgent(session, agentId))
        .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt)),
    [agentId, sessions],
  );
  const selectedSession = panelSessions.find((session) => session.id === selectedSessionId);

  useEffect(() => {
    if (presetsLoading || presetsError) return;
    const preferredId = selectedPresetId || initialPreference.current?.presetId || "";
    const nextId = enabledPresets.some((preset) => preset.id === preferredId)
      ? preferredId
      : (enabledPresets[0]?.id ?? "");
    if (nextId !== selectedPresetId) setSelectedPresetId(nextId);
  }, [enabledPresets, presetsError, presetsLoading, selectedPresetId]);

  useEffect(() => {
    if (
      reasoningEffort &&
      selectedPreset &&
      !selectedPreset.reasoningEfforts.includes(reasoningEffort)
    ) {
      setReasoningEffort("");
    }
  }, [reasoningEffort, selectedPreset]);

  useEffect(() => {
    if (
      presetsLoading ||
      presetsError ||
      !selectedPreset ||
      (reasoningEffort && !selectedPreset.reasoningEfforts.includes(reasoningEffort))
    ) {
      return;
    }
    try {
      localStorage.setItem(
        preferenceStorageKey,
        JSON.stringify({
          presetId: selectedPreset.id,
          reasoningEffort,
        } satisfies ConsolePreference),
      );
    } catch {
      // Storage can be unavailable in hardened browser profiles; the in-memory selection remains usable.
    }
  }, [preferenceStorageKey, presetsError, presetsLoading, reasoningEffort, selectedPreset]);

  useEffect(() => {
    const host = terminalHostRef.current;
    if (!host) return;
    const terminal = new XTerm({
      allowProposedApi: false,
      convertEol: false,
      cursorBlink: true,
      cursorStyle: "bar",
      fontFamily: '"Cascadia Code", "SFMono-Regular", Consolas, monospace',
      fontSize: 15,
      letterSpacing: 0,
      lineHeight: 1.24,
      scrollback: 10_000,
      theme: {
        background: "#0d0d0e",
        foreground: "#dedbd5",
        cursor: config.color,
        cursorAccent: "#0d0d0e",
        selectionBackground: `${config.color}55`,
        black: "#171719",
        brightBlack: "#68686e",
        red: "#e27272",
        brightRed: "#f08a8a",
        green: "#76bf8b",
        brightGreen: "#8bd5a0",
        yellow: "#d6a45d",
        brightYellow: "#e8bd7b",
        blue: "#6fa9e8",
        brightBlue: "#8bbbf0",
        magenta: "#bb8fd6",
        brightMagenta: "#cfa8e4",
        cyan: "#66b9bc",
        brightCyan: "#82cdd0",
        white: "#d7d3cd",
        brightWhite: "#f3efe8",
      },
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(host);
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    const fitAndSend = () => {
      if (!terminal.element || host.clientWidth === 0 || host.clientHeight === 0) return;
      try {
        fitAddon.fit();
      } catch {
        return;
      }
      const next = clampTerminalSize(terminal.cols, terminal.rows);
      if (terminal.cols !== next.cols || terminal.rows !== next.rows) {
        terminal.resize(next.cols, next.rows);
      }
      sizeRef.current = next;
      const socket = socketRef.current;
      if (statusRef.current === "attached" && socket?.readyState === WebSocket.OPEN) {
        sendTerminalFrame(socket, { type: "resize", ...next });
      }
    };

    let resizeTimer: number | null = null;
    const resizeObserver = new ResizeObserver(() => {
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(fitAndSend, 125);
    });
    resizeObserver.observe(host);
    window.requestAnimationFrame(fitAndSend);

    const inputSubscription = terminal.onData((data) => {
      const socket = socketRef.current;
      if (statusRef.current !== "attached" || socket?.readyState !== WebSocket.OPEN) return;
      for (const chunk of chunkTerminalInput(data)) {
        sendTerminalFrame(socket, { type: "input", data: chunk });
      }
    });

    return () => {
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      resizeObserver.disconnect();
      inputSubscription.dispose();
      socketRef.current?.close();
      socketRef.current = null;
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      if (stopTimerRef.current !== null) window.clearTimeout(stopTimerRef.current);
    };
  }, [config.color]);

  const attachSession = useCallback(
    (sessionId: string, explicit = true) => {
      if (!authorized) {
        setError(t("Terminal permission is not active yet. Approve it in Settings first."));
        updateStatus("revoked");
        return;
      }
      const terminal = terminalRef.current;
      if (!terminal) return;
      if (explicit) sessionStorage.removeItem(revokedStorageKey);
      setError("");
      setExitCode(null);
      updateStatus("connecting");
      const previous = socketRef.current;
      socketRef.current = null;
      previous?.close();

      const socket = new WebSocket(terminalSocketUrl(window.location));
      socketRef.current = socket;
      socket.addEventListener("open", () => {
        if (socketRef.current !== socket) return;
        sendTerminalFrame(socket, { type: "attach", projectId, sessionId });
      });
      socket.addEventListener("message", (event) => {
        if (socketRef.current !== socket) return;
        const frame = parseTerminalServerFrame(String(event.data));
        if (!frame) {
          setError(t("The terminal returned data that could not be parsed."));
          updateStatus("error");
          return;
        }
        if (frame.type === "attached") {
          terminal.reset();
          if (frame.backlog) terminal.write(frame.backlog);
          setSelectedSessionId(frame.sessionId);
          localStorage.setItem(sessionStorageKey, frame.sessionId);
          sessionStorage.removeItem(revokedStorageKey);
          updateStatus("attached");
          sendTerminalFrame(socket, { type: "resize", ...sizeRef.current });
          terminal.focus();
          return;
        }
        if (frame.type === "output") {
          terminal.write(frame.data);
          return;
        }
        if (frame.type === "exit") {
          setExitCode(frame.exitCode);
          updateStatus("exited");
          void queryClient.invalidateQueries({ queryKey: ["project", projectId, "terminals"] });
          socketRef.current = null;
          socket.close();
          return;
        }
        if (frame.type === "unauthorized") {
          sessionStorage.setItem(revokedStorageKey, "1");
          setError(t("Terminal authorization was revoked and must be approved again."));
          updateStatus("revoked");
          socketRef.current = null;
          socket.close();
          return;
        }
        if (frame.type === "error") {
          setError(frame.message);
          if (statusRef.current === "connecting") updateStatus("error");
        }
      });
      socket.addEventListener("close", () => {
        if (socketRef.current !== socket) return;
        socketRef.current = null;
        if (!["exited", "revoked", "stopping"].includes(statusRef.current)) {
          updateStatus("disconnected");
        }
      });
      socket.addEventListener("error", () => {
        if (socketRef.current !== socket) return;
        setError(
          t("The WebSocket connection failed. The terminal process will not be terminated."),
        );
        updateStatus("error");
      });
    },
    [authorized, projectId, queryClient, revokedStorageKey, sessionStorageKey, updateStatus],
  );

  useEffect(() => {
    if (autoAttachAttemptedRef.current || authorizationLoading || !authorized) return;
    if (!terminalRef.current || panelSessions.length === 0) return;
    autoAttachAttemptedRef.current = true;
    const remembered = localStorage.getItem(sessionStorageKey);
    const candidate =
      panelSessions.find((session) => session.id === remembered) ??
      panelSessions.find((session) => !session.exitedAt);
    if (!candidate) return;
    setSelectedSessionId(candidate.id);
    if (sessionStorage.getItem(revokedStorageKey) !== "1") {
      attachSession(candidate.id, false);
    } else {
      updateStatus("revoked");
      setError(
        t(
          "The previous connection ended because permission was revoked. Approve it again, then connect manually.",
        ),
      );
    }
  }, [
    attachSession,
    authorizationLoading,
    authorized,
    panelSessions,
    revokedStorageKey,
    sessionStorageKey,
    updateStatus,
  ]);

  useEffect(() => {
    if (authorizationLoading || authorized) return;
    if (!["attached", "connecting"].includes(statusRef.current)) return;
    sessionStorage.setItem(revokedStorageKey, "1");
    const socket = socketRef.current;
    socketRef.current = null;
    socket?.close();
    setError(
      t(
        "Terminal control permission was revoked. The process is still running and can be reconnected after approval.",
      ),
    );
    updateStatus("revoked");
  }, [authorizationLoading, authorized, revokedStorageKey, updateStatus]);

  const launch = async () => {
    if (!selectedPreset || !effortIsValid) {
      setError(
        t(
          "The selected reasoning effort is not supported by the current model. Choose another value.",
        ),
      );
      return;
    }
    setError("");
    updateStatus("launching");
    const terminal = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    if (terminal && fitAddon) {
      try {
        fitAddon.fit();
      } catch {
        // The default below remains valid if the panel has not completed layout yet.
      }
      const size = clampTerminalSize(terminal.cols || 120, terminal.rows || 30);
      if (terminal.cols !== size.cols || terminal.rows !== size.rows) {
        terminal.resize(size.cols, size.rows);
      }
      sizeRef.current = size;
    }
    try {
      const session = await hub.request<TerminalSession>(
        "POST",
        `/api/projects/${projectId}/terminals`,
        {
          label: `${agentId}:${selectedPreset.label}`,
          shell: config.shell,
          args: [],
          cols: sizeRef.current.cols,
          rows: sizeRef.current.rows,
          requestedByAgentId: "Local User",
          modelPresetId: selectedPreset.id,
          reasoningEffort:
            reasoningEffort && selectedPreset.reasoningEfforts.includes(reasoningEffort)
              ? reasoningEffort
              : undefined,
        },
      );
      setSelectedSessionId(session.id);
      localStorage.setItem(sessionStorageKey, session.id);
      await queryClient.invalidateQueries({ queryKey: ["project", projectId, "terminals"] });
      attachSession(session.id);
    } catch (launchError) {
      setError(launchError instanceof Error ? launchError.message : String(launchError));
      updateStatus("error");
    }
  };

  const terminate = async () => {
    if (!selectedSessionId) return;
    if (!stopArmed) {
      setStopArmed(true);
      stopTimerRef.current = window.setTimeout(() => setStopArmed(false), 4_000);
      return;
    }
    if (stopTimerRef.current !== null) window.clearTimeout(stopTimerRef.current);
    setStopArmed(false);
    updateStatus("stopping");
    setError("");
    try {
      await hub.request("DELETE", `/api/terminals/${selectedSessionId}`);
      await queryClient.invalidateQueries({ queryKey: ["project", projectId, "terminals"] });
    } catch (stopError) {
      setError(stopError instanceof Error ? stopError.message : String(stopError));
      updateStatus("error");
    }
  };

  const reconnect = () => {
    if (!selectedSessionId) return;
    attachSession(selectedSessionId);
  };

  const style = {
    "--console-agent": config.color,
    "--console-agent-soft": config.softColor,
  } as CSSProperties;
  const connected = status === "attached";
  const canLaunch =
    authorized &&
    !authorizationLoading &&
    !presetsLoading &&
    !presetsError &&
    Boolean(selectedPreset) &&
    effortIsValid &&
    status !== "launching";

  return (
    <section
      className="console-terminal-panel"
      style={style}
      data-testid={`terminal-panel-${agentId}`}
      aria-labelledby={`terminal-title-${agentId}`}
    >
      <header className="console-terminal-head">
        <div className="console-terminal-identity">
          <span className="console-agent-mark">
            <TerminalWindow size={19} weight="duotone" />
          </span>
          <div>
            <h2 id={`terminal-title-${agentId}`}>{config.label}</h2>
            <span>
              {config.shell} · {t("Local PTY")}
            </span>
          </div>
        </div>
        <span className={`console-state console-state-${status}`}>
          <i />
          {stateLabel[status]}
        </span>
      </header>

      <div className="console-launch-bar">
        <Select
          className="console-field"
          popupClassName="console-field-popup"
          label={t("{agent} model", { agent: config.label })}
          value={selectedPreset?.id ?? ""}
          options={enabledPresets.map((preset) => ({
            value: preset.id,
            label: preset.label,
          }))}
          onChange={(presetId) => {
            const nextPreset = enabledPresets.find((preset) => preset.id === presetId);
            setSelectedPresetId(presetId);
            if (reasoningEffort && !nextPreset?.reasoningEfforts.includes(reasoningEffort)) {
              setReasoningEffort("");
            }
          }}
          disabled={status === "launching" || presetsLoading || enabledPresets.length === 0}
          placeholder={presetsLoading ? t("Loading models…") : t("No models available")}
          error={presetsError ? t("Unable to load the model registry. Try again.") : undefined}
          hint={
            !presetsLoading && !presetsError && enabledPresets.length === 0
              ? t(
                  "No model presets are enabled for this Agent. Enable one in the model registry first.",
                )
              : undefined
          }
        />
        <Select
          className="console-field"
          popupClassName="console-field-popup"
          label={t("{agent} reasoning effort", { agent: config.label })}
          value={reasoningEffort}
          options={[
            { value: "", label: t("Model default") },
            ...(selectedPreset?.reasoningEfforts.map((effort) => ({
              value: effort,
              label: effort,
            })) ?? []),
          ]}
          onChange={setReasoningEffort}
          disabled={!selectedPreset?.reasoningEfforts.length || status === "launching"}
          placeholder={t("Unavailable")}
          hint={
            selectedPreset && selectedPreset.reasoningEfforts.length === 0
              ? t(
                  "This model does not expose reasoning-effort options. The model default will be used.",
                )
              : undefined
          }
        />
        <button
          className="console-launch-button"
          type="button"
          onClick={() => void launch()}
          disabled={!canLaunch}
          aria-busy={status === "launching"}
        >
          <Play size={15} weight="fill" />
          {status === "launching" ? t("Launching") : t("New terminal")}
        </button>
      </div>

      <div className="console-session-bar">
        <Select
          className="console-field"
          popupClassName="console-field-popup"
          label={t("{agent} session", { agent: config.label })}
          value={selectedSessionId}
          options={[
            { value: "", label: t("Not selected") },
            ...panelSessions.map((session) => ({
              value: session.id,
              label: `${session.exitedAt ? t("Exited") : t("Running")} · PID ${session.pid} · ${sessionTime(session.startedAt)}`,
            })),
          ]}
          onChange={(sessionId) => {
            setSelectedSessionId(sessionId);
            if (sessionId) attachSession(sessionId);
          }}
        />
        <div className="console-session-actions">
          <button
            type="button"
            onClick={reconnect}
            disabled={!selectedSessionId || connected || !authorized}
          >
            <ArrowsClockwise size={15} />
            {t("Connect")}
          </button>
          <button
            className={stopArmed ? "danger armed" : "danger"}
            type="button"
            onClick={() => void terminate()}
            disabled={
              !selectedSessionId || status === "stopping" || Boolean(selectedSession?.exitedAt)
            }
          >
            <Stop size={15} weight={stopArmed ? "fill" : "regular"} />
            {stopArmed ? t("Confirm terminate") : t("Terminate")}
          </button>
        </div>
      </div>

      <div className="console-screen">
        <div ref={terminalHostRef} className="console-xterm" />
        {status === "idle" && !selectedSessionId && (
          <div className="console-screen-empty">
            <TerminalWindow size={27} />
            <strong>{t("Waiting for explicit launch")}</strong>
            <span>
              {t("Select a model, then click New terminal. No command runs automatically here.")}
            </span>
          </div>
        )}
        {status === "revoked" && (
          <div className="console-screen-lock" role="alert">
            <LockKey size={22} />
            <strong>{t("Terminal control locked")}</strong>
            <span>
              {t("The server detached the attachment. Reauthorize, then click Connect manually.")}
            </span>
          </div>
        )}
      </div>

      <footer className="console-terminal-foot">
        <span>
          {selectedSession ? (
            <>
              PID {selectedSession.pid} · {selectedSession.cwd}
            </>
          ) : (
            t("Ctrl+C is sent directly by you inside the terminal")
          )}
        </span>
        <span aria-live="polite">
          {exitCode !== null
            ? t("Exit code {code}", { code: exitCode })
            : connected
              ? t("Input goes directly to the local PTY")
              : ""}
        </span>
      </footer>
      {error && (
        <div className="console-error" role="alert">
          <WarningCircle size={16} weight="fill" />
          <span>{error}</span>
        </div>
      )}
    </section>
  );
}

export function ConsolePage({ projectId }: { projectId: string }) {
  const setPage = useUi((state) => state.setPage);
  const queryClient = useQueryClient();
  const [requestFeedback, setRequestFeedback] = useState("");
  const authorization = useQuery<AuthorizationCheck>({
    queryKey: ["project", projectId, "authorization", "terminal.unrestricted"],
    queryFn: () =>
      hub.request(
        "GET",
        `/api/projects/${projectId}/authorizations/check?capability=terminal.unrestricted`,
      ),
    refetchInterval: 5_000,
  });
  const authorizations = useQuery<AuthorizationGrant[]>({
    queryKey: ["project", projectId, "authorizations"],
    queryFn: () => hub.request("GET", `/api/projects/${projectId}/authorizations`),
  });
  const terminals = useQuery<TerminalSession[]>({
    queryKey: ["project", projectId, "terminals"],
    queryFn: () => hub.request("GET", `/api/projects/${projectId}/terminals`),
    refetchInterval: 4_000,
  });
  const codexPresets = useQuery<ModelPreset[]>({
    queryKey: ["model-presets", "codex"],
    queryFn: () => hub.request("GET", "/api/model-presets?agentId=codex"),
  });
  const claudePresets = useQuery<ModelPreset[]>({
    queryKey: ["model-presets", "claude"],
    queryFn: () => hub.request("GET", "/api/model-presets?agentId=claude"),
  });
  const requestAuthorization = useMutation({
    mutationFn: () =>
      hub.request<AuthorizationGrant>("POST", `/api/projects/${projectId}/authorizations`, {
        capability: "terminal.unrestricted",
        reason: t("Launch a local CLI from the Dashboard dual terminal console"),
        detail: { surface: "dashboard-console" },
        requestedByAgentId: "Local User",
        idempotencyKey: idempotency(`dashboard-console-authorization-${projectId}`),
      }),
    onMutate: () => setRequestFeedback(""),
    onSuccess: () => {
      setRequestFeedback(t("Authorization request created. Approve it on the Settings page."));
      void queryClient.invalidateQueries({ queryKey: ["project", projectId, "authorizations"] });
      void queryClient.invalidateQueries({
        queryKey: ["project", projectId, "authorization", "terminal.unrestricted"],
      });
    },
    onError: (requestError) => {
      setRequestFeedback(
        requestError instanceof Error ? requestError.message : String(requestError),
      );
    },
  });

  const pendingGrant = authorizations.data?.find(
    (grant) => grant.capability === "terminal.unrestricted" && grant.status === "PENDING",
  );
  const authorized = authorization.data?.allowed ?? false;
  const queryErrors = [
    terminals.error,
    codexPresets.error,
    claudePresets.error,
    authorization.error,
  ].filter(Boolean);

  return (
    <div className="console-page">
      <header className="console-page-head">
        <div>
          <span className="eyebrow">{t("Local command surface")}</span>
          <h1>{t("Dual terminal console")}</h1>
          <p>
            {t(
              "Codex CLI and Claude Code each run in a real local PTY, and their sessions persist across page navigation.",
            )}
          </p>
        </div>
        <div className="console-safety-note" role="note">
          <WarningCircle size={19} weight="fill" />
          <div>
            <strong>{t("Unrestricted local commands")}</strong>
            <span>
              {t(
                "Only text you type or paste in the terminal is sent. Closing the page does not terminate the process.",
              )}
            </span>
          </div>
        </div>
      </header>

      {!authorization.isLoading && !authorized && (
        <section className="console-authorization-gate" aria-labelledby="console-auth-title">
          <span className="console-auth-icon">
            <LockKey size={21} />
          </span>
          <div>
            <h2 id="console-auth-title">
              {pendingGrant
                ? t("Terminal authorization pending")
                : t("Terminal authorization required")}
            </h2>
            <p>
              {pendingGrant
                ? t(
                    "The request already exists. Approve it on the Settings page, then return and connect manually.",
                  )
                : t(
                    "Before launching any local command, create and approve terminal.unrestricted authorization.",
                  )}
            </p>
            {requestFeedback && (
              <span role={requestAuthorization.isError ? "alert" : "status"}>
                {requestFeedback}
              </span>
            )}
          </div>
          <div className="console-auth-actions">
            {!pendingGrant && (
              <button
                type="button"
                onClick={() => requestAuthorization.mutate()}
                disabled={requestAuthorization.isPending}
              >
                <ShieldCheck size={16} />
                {requestAuthorization.isPending
                  ? t("Creating request")
                  : t("Create authorization request")}
              </button>
            )}
            <button className="primary" type="button" onClick={() => setPage("settings")}>
              <CheckCircle size={16} weight="fill" />
              {t("Open Settings to approve")}
            </button>
          </div>
        </section>
      )}

      {queryErrors.length > 0 && (
        <div className="console-query-error" role="alert">
          <WarningCircle size={17} weight="fill" />
          <span>
            {queryErrors[0] instanceof Error ? queryErrors[0].message : String(queryErrors[0])}
          </span>
          <button
            type="button"
            onClick={() => {
              void authorization.refetch();
              void authorizations.refetch();
              void terminals.refetch();
              void codexPresets.refetch();
              void claudePresets.refetch();
            }}
          >
            {t("Retry")}
          </button>
        </div>
      )}

      <div className="console-grid">
        <TerminalPanel
          key={`${projectId}:codex`}
          agentId="codex"
          projectId={projectId}
          presets={codexPresets.data ?? []}
          presetsLoading={codexPresets.isLoading}
          presetsError={codexPresets.error}
          sessions={terminals.data ?? []}
          authorized={authorized}
          authorizationLoading={authorization.isLoading}
        />
        <TerminalPanel
          key={`${projectId}:claude`}
          agentId="claude"
          projectId={projectId}
          presets={claudePresets.data ?? []}
          presetsLoading={claudePresets.isLoading}
          presetsError={claudePresets.error}
          sessions={terminals.data ?? []}
          authorized={authorized}
          authorizationLoading={authorization.isLoading}
        />
      </div>
    </div>
  );
}
