import { Cpu, GitBranch, Heartbeat, Plug, TerminalWindow } from "@phosphor-icons/react";
import type { AgentSession } from "@crossagent/protocol";
import { EmptyState, Panel, Pill, StatusDot } from "../components/primitives.js";
import { t } from "../i18n.js";

function lag(value: string): number {
  return Math.max(0, Date.now() - Date.parse(value));
}

function isCurrent(session: AgentSession): boolean {
  return !["OFFLINE", "CLOSED"].includes(session.connectionState);
}

function sessionTone(session: AgentSession): "ok" | "warn" | "danger" {
  if (session.connectionState === "ONLINE") return "ok";
  if (["CONNECTING", "DEGRADED", "STALE"].includes(session.connectionState)) return "warn";
  return "danger";
}

function sortNewest(first: AgentSession, second: AgentSession): number {
  return Date.parse(second.connectedAt) - Date.parse(first.connectedAt);
}

function SessionTelemetry({ session }: { session: AgentSession }) {
  const heartbeatLag = lag(session.transportLastSeenAt);
  return (
    <section aria-label={`${session.agentId} ${session.client} session ${session.id}`}>
      <div className="session-status">
        <Pill tone={session.connectionState === "ONLINE" ? "green" : "amber"}>
          {session.connectionState}
        </Pill>
        <Pill tone={session.workState !== "IDLE" ? "cyan" : "neutral"}>{session.workState}</Pill>
        <code title={session.id}>{session.id}</code>
      </div>
      <div className="session-stats">
        <div>
          <Plug size={16} />
          <span>{t("Delivery")}</span>
          <strong title={session.deliveryMode}>{session.deliveryMode}</strong>
        </div>
        <div>
          <Heartbeat size={16} />
          <span>{t("Heartbeat")}</span>
          <strong>{Math.round(heartbeatLag / 1000)}s</strong>
        </div>
        <div>
          <TerminalWindow size={16} />
          <span>{t("Client")}</span>
          <strong title={session.client}>{session.client}</strong>
        </div>
        <div>
          <GitBranch size={16} />
          <span>{t("Branch")}</span>
          <strong>{session.gitBranch ?? "—"}</strong>
        </div>
        <div>
          <Cpu size={16} />
          <span>{t("Queue")}</span>
          <strong>{session.queueDepth}</strong>
        </div>
      </div>
      <div className="capability-list">
        {session.capabilities.slice(0, 8).map((capability) => (
          <span key={capability}>{capability}</span>
        ))}
      </div>
      <footer>
        <span title={session.cwd}>{session.cwd}</span>
        <code>v{session.version}</code>
      </footer>
    </section>
  );
}

export function AgentsPage({ sessions }: { sessions: AgentSession[] }) {
  const groups = Array.from(
    sessions.reduce((grouped, session) => {
      const group = grouped.get(session.agentId) ?? [];
      group.push(session);
      grouped.set(session.agentId, group);
      return grouped;
    }, new Map<string, AgentSession[]>()),
  )
    .map(([agentId, agentSessions]) => ({
      agentId,
      current: agentSessions.filter(isCurrent).sort(sortNewest),
      history: agentSessions.filter((session) => !isCurrent(session)).sort(sortNewest),
    }))
    .sort((first, second) => first.agentId.localeCompare(second.agentId));

  return (
    <div className="standard-page">
      <div className="page-heading">
        <div>
          <span className="eyebrow">{t("Session telemetry")}</span>
          <h1>{t("Agents")}</h1>
          <p>{t("Connection state is kept separate from work state and claim freshness.")}</p>
        </div>
      </div>
      {sessions.length === 0 ? (
        <Panel>
          <EmptyState
            title={t("No session telemetry")}
            text={t("Connected Bridges, Channels, and hooks appear here.")}
          />
        </Panel>
      ) : (
        <div className="session-matrix" aria-label={t("Agent sessions")}>
          {groups.map(({ agentId, current, history }) => {
            const representative = (current[0] ?? history[0])!;
            return (
              <Panel key={agentId} className="session-card">
                <div className="session-identity">
                  <div className={`agent-avatar ${agentId}`}>{agentId[0]?.toUpperCase()}</div>
                  <div>
                    <h2>{agentId}</h2>
                    <code>
                      {t("{current} current · {history} historical", {
                        current: current.length,
                        history: history.length,
                      })}
                    </code>
                  </div>
                  <StatusDot state={sessionTone(representative)} />
                </div>
                {current.length ? (
                  current.map((session) => <SessionTelemetry key={session.id} session={session} />)
                ) : (
                  <p className="muted">{t("No current sessions.")}</p>
                )}
                {history.length > 0 && (
                  <details>
                    <summary>{t("Session history ({count})", { count: history.length })}</summary>
                    {history.map((session) => (
                      <SessionTelemetry key={session.id} session={session} />
                    ))}
                  </details>
                )}
              </Panel>
            );
          })}
        </div>
      )}
    </div>
  );
}
