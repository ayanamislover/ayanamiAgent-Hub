import { ArrowRight, CheckCircle, ClockCountdown, GitBranch, Warning } from "@phosphor-icons/react";
import type { AgentSession, DomainEvent } from "@crossagent/protocol";
import type { Overview } from "../types.js";
import { EmptyState, Panel, Pill, ProgressBar, StatusDot } from "../components/primitives.js";
import { useUi } from "../store.js";
import { t } from "../i18n.js";
import "./overview-mascots.css";

function timeAgo(value: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 1000));
  if (seconds < 60) return t("{count}s ago", { count: seconds });
  if (seconds < 3600) return t("{count}m ago", { count: Math.floor(seconds / 60) });
  if (seconds < 86400) return t("{count}h ago", { count: Math.floor(seconds / 3600) });
  return t("{count}d ago", { count: Math.floor(seconds / 86400) });
}

function agentTone(session: AgentSession): "ok" | "warn" | "danger" | "muted" {
  if (session.connectionState === "ONLINE") return "ok";
  if (["STALE", "DEGRADED"].includes(session.connectionState)) return "warn";
  return "danger";
}

function ActivityRow({ event }: { event: DomainEvent }) {
  return (
    <div className="activity-row" role="listitem">
      <span className={`activity-icon ${event.actorType}`}>
        {event.type.includes("review") ? <CheckCircle size={15} /> : <GitBranch size={15} />}
      </span>
      <div>
        <strong>{event.type.replaceAll(".", " / ")}</strong>
        <span>
          {event.actorId} · {event.aggregateType} {event.aggregateId.slice(-7)}
        </span>
      </div>
      <time dateTime={event.createdAt} title={new Date(event.createdAt).toLocaleString()}>
        {timeAgo(event.createdAt)}
      </time>
    </div>
  );
}

export function OverviewPage({ overview }: { overview: Overview }) {
  const setPage = useUi((state) => state.setPage);
  return (
    <div className="overview-layout">
      <div className="agent-backdrop" aria-hidden="true">
        <img
          className="agent-backdrop-codex"
          src="/agent-codex.png"
          alt=""
          width={767}
          height={1089}
          draggable="false"
        />
        <img
          className="agent-backdrop-claude"
          src="/agent-claude.png"
          alt=""
          width={1119}
          height={861}
          draggable="false"
        />
      </div>
      <section className="overview-primary">
        <Panel className="objective-panel">
          <div className="objective-top">
            <div>
              <span className="eyebrow">{t("Active objective")}</span>
              <h1>{overview.objective?.title ?? t("No active objective")}</h1>
              <p>
                {overview.objective?.description ??
                  t("Create an objective to turn agent activity into verifiable progress.")}
              </p>
            </div>
            <div className="objective-score">
              <strong>{Math.round(overview.computedProgress)}</strong>
              <span>% {t("Verified")}</span>
            </div>
          </div>
          <ProgressBar value={overview.computedProgress} />
          <div className="milestone-strip">
            {overview.milestones.length === 0 ? (
              <span className="muted">{t("No milestones defined yet.")}</span>
            ) : (
              overview.milestones.map((milestone, index) => (
                <div key={milestone.id} className="milestone">
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <div>
                    <strong>{milestone.title}</strong>
                    <small>{t("{count} tasks", { count: milestone.taskCount })}</small>
                  </div>
                  <b>{Math.round(milestone.computedProgress)}%</b>
                </div>
              ))
            )}
          </div>
        </Panel>

        <div className="section-title">
          <div>
            <span className="eyebrow">{t("Operators")}</span>
            <h2>{t("Agent field state")}</h2>
          </div>
          <button className="text-button" type="button" onClick={() => setPage("agents")}>
            {t("Open matrix")} <ArrowRight size={14} />
          </button>
        </div>
        <div className="agent-grid">
          {overview.sessions.length === 0 ? (
            <Panel className="span-all">
              <EmptyState
                title={t("No agents connected")}
                text={t("Start the Codex Bridge, Claude Channel, or install lifecycle hooks.")}
              />
            </Panel>
          ) : (
            overview.sessions.slice(0, 4).map((session) => (
              <Panel key={session.id} className="agent-card">
                <div className="agent-head">
                  <div className={`agent-avatar ${session.agentId}`}>
                    {session.agentId.slice(0, 1).toUpperCase()}
                  </div>
                  <div>
                    <h3>{session.agentId}</h3>
                    <span>{session.client}</span>
                  </div>
                  <StatusDot state={agentTone(session)} />
                </div>
                <div className="agent-state">
                  <Pill tone={session.workState !== "IDLE" ? "cyan" : "neutral"}>
                    {session.workState}
                  </Pill>
                  <span>{session.deliveryMode.replaceAll("_", " ")}</span>
                </div>
                <dl>
                  <div>
                    <dt>{t("Task")}</dt>
                    <dd>{session.currentTaskId?.slice(-9) ?? t("Unassigned")}</dd>
                  </div>
                  <div>
                    <dt>{t("Branch")}</dt>
                    <dd>{session.gitBranch ?? "—"}</dd>
                  </div>
                  <div>
                    <dt>{t("Last seen")}</dt>
                    <dd>{timeAgo(session.transportLastSeenAt)}</dd>
                  </div>
                </dl>
              </Panel>
            ))
          )}
        </div>

        <Panel
          eyebrow={t("Delivery pipeline")}
          title={t("Milestones & proof")}
          action={
            <Pill tone="green">
              {overview.tasks.filter((task) => task.status === "DONE").length} DONE
            </Pill>
          }
        >
          <div className="proof-list">
            {overview.tasks.slice(0, 6).map((task) => (
              <button
                key={task.id}
                type="button"
                aria-haspopup="dialog"
                aria-label={t("Inspect task: {title}", { title: task.title })}
                onClick={() => {
                  useUi.getState().setPage("tasks");
                  useUi.getState().setSelectedTaskId(task.id);
                }}
              >
                <span className={`task-status-mark ${task.status.toLowerCase()}`} />
                <div>
                  <strong>{task.title}</strong>
                  <small>
                    {task.status} · {task.ownerAgentId ?? t("Unclaimed")}
                  </small>
                </div>
                <span>{Math.round(task.computedProgress)}%</span>
              </button>
            ))}
            {overview.tasks.length === 0 && (
              <EmptyState
                title={t("No task evidence yet")}
                text={t("Tasks and TODO proof will appear here.")}
              />
            )}
          </div>
        </Panel>
      </section>

      <aside className="overview-rail">
        <Panel
          eyebrow={t("Attention")}
          title={t("Blockers")}
          action={
            <Pill tone={overview.blockers.length ? "red" : "green"}>
              {overview.blockers.length}
            </Pill>
          }
        >
          <div className="blocker-list">
            {overview.blockers.slice(0, 5).map((task) => (
              <button
                key={task.id}
                type="button"
                aria-haspopup="dialog"
                onClick={() => {
                  setPage("tasks");
                  useUi.getState().setSelectedTaskId(task.id);
                }}
              >
                <Warning size={17} weight="fill" />
                <div>
                  <strong>{task.title}</strong>
                  <span>{task.blockedReason ?? task.waitingFor ?? task.status}</span>
                </div>
              </button>
            ))}
            {overview.blockers.length === 0 && (
              <div className="quiet-state">
                <CheckCircle size={18} /> {t("No active blockers")}
              </div>
            )}
          </div>
        </Panel>
        <Panel eyebrow={t("Live log")} title={t("Recent activity")}>
          {overview.recentEvents.length ? (
            <div className="activity-list" role="list" aria-label={t("Recent project activity")}>
              {overview.recentEvents
                .slice(-12)
                .reverse()
                .map((event) => (
                  <ActivityRow key={event.id} event={event} />
                ))}
            </div>
          ) : (
            <EmptyState
              title={t("No durable activity yet")}
              text={t("Project mutations will appear here in sequence order.")}
            />
          )}
        </Panel>
        <Panel className="rail-health">
          <div>
            <ClockCountdown size={20} />
            <span>{t("Snapshot")}</span>
            <strong>{timeAgo(overview.generatedAt)}</strong>
          </div>
          <div>
            <GitBranch size={20} />
            <span>{t("Event cursor")}</span>
            <strong>#{overview.currentSequence}</strong>
          </div>
        </Panel>
      </aside>
    </div>
  );
}
