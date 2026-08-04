import { useMemo, useState } from "react";
import {
  ArrowBendUpLeft,
  CheckCircle,
  Funnel,
  MagnifyingGlass,
  PaperPlaneTilt,
} from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Task } from "@crossagent/protocol";
import type { MessageView } from "../types.js";
import { hub, idempotency } from "../api.js";
import { EmptyState, Panel, Pill } from "../components/primitives.js";
import { Select } from "../components/select.js";
import { localeTag, t } from "../i18n.js";
import { useUi } from "../store.js";

type RecipientChoice = "codex" | "claude" | "both";
type PriorityChoice = MessageView["priority"];

const RECIPIENT_OPTIONS = [
  { value: "codex", label: "Codex" },
  { value: "claude", label: "Claude" },
  { value: "both", label: t("Both") },
];

const PRIORITY_OPTIONS = [
  { value: "BACKGROUND", label: t("Background"), description: t("Mailbox only") },
  { value: "NORMAL", label: t("Normal"), description: t("Safe next context") },
  { value: "IMPORTANT", label: t("Important"), description: t("Checkpoint + ACK") },
  { value: "INTERRUPT", label: t("Interrupt"), description: t("Immediate steer + ACK") },
];

// Must match the Hub's Dashboard principal display name (see local-auth.ts and migration 0014):
// the Hub verifies an authored event by comparing its actor_id against that principal.
const LOCAL_USER_NAME = "Local User";

function displayAgentId(agentId: string): string {
  return agentId === "local-user" ? LOCAL_USER_NAME : agentId;
}

function avatarAgentId(agentId: string): string {
  return agentId === "local-user" || agentId === LOCAL_USER_NAME ? "user" : agentId;
}

function time(value: string): string {
  return new Date(value).toLocaleString(localeTag(), {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function CommunicationsPage({
  projectId,
  tasks,
  messages,
  loading = false,
  error = null,
  onRetry,
}: {
  projectId: string;
  tasks: Task[];
  messages: MessageView[];
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
}) {
  const [filter, setFilter] = useState("ALL");
  const [query, setQuery] = useState("");
  const [summary, setSummary] = useState("");
  const [recipient, setRecipient] = useState<RecipientChoice>("codex");
  const [priority, setPriority] = useState<PriorityChoice>("NORMAL");
  const [sentMessage, setSentMessage] = useState("");
  const selectedTaskId = useUi((state) => state.selectedTaskId);
  const setSelectedTaskId = useUi((state) => state.setSelectedTaskId);
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: () =>
      hub.postMessage(projectId, {
        fromAgentId: LOCAL_USER_NAME,
        recipients:
          recipient === "both"
            ? [{ agentId: "codex" }, { agentId: "claude" }]
            : [{ agentId: recipient }],
        type: "STATUS",
        taskId: selectedTaskId ?? undefined,
        priority,
        requiresAck: priority === "IMPORTANT" || priority === "INTERRUPT",
        requiresResponse: false,
        summary,
        references: [],
        idempotencyKey: idempotency("dashboard-message"),
      }),
    onMutate: () => setSentMessage(""),
    onSuccess: () => {
      setSummary("");
      setSentMessage(
        t("Envelope sent at {time}.", { time: new Date().toLocaleTimeString(localeTag()) }),
      );
      void queryClient.invalidateQueries({ queryKey: ["project", projectId, "messages"] });
    },
  });
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return messages.filter((message) => {
      if (filter !== "ALL" && message.priority !== filter) return false;
      if (!normalized) return true;
      return `${message.summary} ${message.fromAgentId} ${displayAgentId(message.fromAgentId)} ${message.recipients
        .map((item) => item.recipientAgentId)
        .join(" ")} ${message.threadId} ${message.type} ${message.priority}`
        .toLowerCase()
        .includes(normalized);
    });
  }, [filter, messages, query]);
  const errorText = error instanceof Error ? error.message : String(error ?? "");
  return (
    <div className="standard-page communications-page">
      <div className="page-heading">
        <div>
          <span className="eyebrow">{t("Message control")}</span>
          <h1>{t("Communications")}</h1>
          <p>{t("Threaded coordination with delivery, ACK, and processing evidence.")}</p>
        </div>
        <div className="heading-actions">
          <label className="inline-search">
            <MagnifyingGlass size={16} aria-hidden="true" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label={t("Search communications")}
              placeholder={t("Search sender, thread, or summary")}
            />
          </label>
          <div className="segmented" role="group" aria-label={t("Message priority")}>
            {["ALL", "INTERRUPT", "IMPORTANT", "NORMAL", "BACKGROUND"].map((value) => (
              <button
                key={value}
                type="button"
                className={filter === value ? "active" : ""}
                aria-pressed={filter === value}
                onClick={() => setFilter(value)}
              >
                {value}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="communications-layout">
        <Panel className="message-stream">
          <div className="stream-toolbar">
            <span>
              <Funnel size={15} />{" "}
              {t("{filtered} of {total} envelopes", {
                filtered: filtered.length,
                total: messages.length,
              })}
            </span>
            <small>{t("Newest first")}</small>
          </div>
          {loading ? (
            <div className="empty-state" role="status" aria-live="polite">
              <strong>{t("Loading communications")}</strong>
              <span>{t("Retrieving delivery, ACK, and response evidence…")}</span>
            </div>
          ) : error ? (
            <div className="error-state" role="alert">
              <div>
                <strong>{t("Unable to load communications")}</strong>
                <span>{errorText}</span>
                {onRetry && (
                  <button className="primary-button" type="button" onClick={onRetry}>
                    {t("Try again")}
                  </button>
                )}
              </div>
            </div>
          ) : (
            <div className="message-list" aria-live="polite">
              {filtered.map((message) => (
                <article
                  key={message.id}
                  className={`message ${message.priority.toLowerCase()}`}
                  aria-labelledby={`message-${message.id}`}
                >
                  <div className="message-line">
                    <div
                      className={`agent-avatar small ${avatarAgentId(message.fromAgentId)}`}
                      aria-hidden="true"
                    >
                      {displayAgentId(message.fromAgentId).slice(0, 1).toUpperCase()}
                    </div>
                    <div>
                      <strong>{displayAgentId(message.fromAgentId)}</strong>
                      <span>
                        → {message.recipients.map((item) => item.recipientAgentId).join(", ")}
                      </span>
                    </div>
                    <Pill
                      tone={
                        message.priority === "INTERRUPT"
                          ? "red"
                          : message.priority === "IMPORTANT"
                            ? "amber"
                            : "neutral"
                      }
                    >
                      {message.priority}
                    </Pill>
                    <time
                      dateTime={message.createdAt}
                      title={new Date(message.createdAt).toString()}
                    >
                      {time(message.createdAt)}
                    </time>
                  </div>
                  <h3 id={`message-${message.id}`}>{message.summary}</h3>
                  <div className="message-foot">
                    <code title={message.threadId}>{message.threadId}</code>
                    <span>{message.type.replaceAll("_", " ")}</span>
                    <span className="delivery-state">
                      {message.recipients.every((item) =>
                        ["ACKNOWLEDGED", "PROCESSED", "RESPONDED"].includes(item.state),
                      ) ? (
                        <>
                          <CheckCircle size={14} /> {t("Acknowledged")}
                        </>
                      ) : (
                        <>
                          <ArrowBendUpLeft size={14} />{" "}
                          {message.recipients[0]?.state.toLowerCase() ?? t("Pending")}
                        </>
                      )}
                    </span>
                  </div>
                </article>
              ))}
              {filtered.length === 0 && (
                <EmptyState
                  title={messages.length ? t("No matching envelopes") : t("Quiet channel")}
                  text={
                    messages.length
                      ? t("Adjust the search or priority filter.")
                      : t(
                          "Coordination envelopes will appear here when agents begin collaborating.",
                        )
                  }
                />
              )}
            </div>
          )}
        </Panel>
        <aside>
          <Panel eyebrow={t("Compose")} title={t("Send coordination note")}>
            <form
              aria-busy={mutation.isPending}
              onSubmit={(event) => {
                event.preventDefault();
                if (summary.trim()) mutation.mutate();
              }}
            >
              <Select
                className="field"
                label={t("Task scope")}
                value={selectedTaskId ?? ""}
                options={[
                  { value: "", label: t("All tasks"), description: t("All project messages") },
                  ...tasks.map((task) => ({
                    value: task.id,
                    label: task.title,
                    description: task.id,
                  })),
                ]}
                onChange={(value) => {
                  setSelectedTaskId(value || null);
                  mutation.reset();
                  setSentMessage("");
                }}
              />
              <Select
                className="field"
                label={t("Message recipient")}
                value={recipient}
                options={RECIPIENT_OPTIONS}
                onChange={(value) => {
                  setRecipient(value as RecipientChoice);
                  mutation.reset();
                  setSentMessage("");
                }}
              />
              <Select
                className="field"
                label={t("Message priority")}
                value={priority}
                options={PRIORITY_OPTIONS}
                onChange={(value) => {
                  setPriority(value as PriorityChoice);
                  mutation.reset();
                  setSentMessage("");
                }}
                hint={
                  priority === "IMPORTANT" || priority === "INTERRUPT"
                    ? t("Recipient acknowledgement is required (ACK).")
                    : t("Acknowledgement is optional.")
                }
              />
              <label className="field">
                <span>
                  {t("Summary")} · {summary.length}/1600
                </span>
                <textarea
                  value={summary}
                  maxLength={1600}
                  onChange={(event) => {
                    setSummary(event.target.value);
                    mutation.reset();
                    setSentMessage("");
                  }}
                  placeholder={t("Use for concrete coordination, not courtesy status.")}
                  rows={6}
                />
              </label>
              {mutation.error && (
                <span className="project-register-error" role="alert">
                  {mutation.error.message}
                </span>
              )}
              {sentMessage && (
                <span className="muted" role="status" aria-live="polite">
                  {sentMessage}
                </span>
              )}
              <button
                className="primary-button full"
                type="submit"
                disabled={!summary.trim() || mutation.isPending}
              >
                <PaperPlaneTilt size={16} />{" "}
                {mutation.isPending ? t("Sending…") : t("Send envelope")}
              </button>
            </form>
          </Panel>
          <Panel eyebrow={t("Policy")} title={t("Push semantics")}>
            <ul className="policy-list">
              <li>
                <i className="background" />
                <div>
                  <strong>{t("Background")}</strong>
                  <span>{t("Mailbox only")}</span>
                </div>
              </li>
              <li>
                <i className="normal" />
                <div>
                  <strong>{t("Normal")}</strong>
                  <span>{t("Safe next context")}</span>
                </div>
              </li>
              <li>
                <i className="important" />
                <div>
                  <strong>{t("Important")}</strong>
                  <span>{t("Checkpoint + ACK")}</span>
                </div>
              </li>
              <li>
                <i className="interrupt" />
                <div>
                  <strong>{t("Interrupt")}</strong>
                  <span>{t("Immediate steer")}</span>
                </div>
              </li>
            </ul>
          </Panel>
        </aside>
      </div>
    </div>
  );
}
