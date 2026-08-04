import { useMemo, useState } from "react";
import { MagnifyingGlass, Pulse } from "@phosphor-icons/react";
import type { DomainEvent } from "@crossagent/protocol";
import { EmptyState, Panel, Pill } from "../components/primitives.js";
import { t } from "../i18n.js";

export function AuditPage({
  events,
  loading = false,
  error = null,
  onRetry,
}: {
  events: DomainEvent[];
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
}) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(
    () =>
      [...events]
        .reverse()
        .filter((event) =>
          `${event.type} ${event.actorId} ${event.aggregateId}`
            .toLowerCase()
            .includes(query.toLowerCase()),
        ),
    [events, query],
  );
  const errorText = error instanceof Error ? error.message : String(error ?? "");
  return (
    <div className="standard-page">
      <div className="page-heading">
        <div>
          <span className="eyebrow">{t("Append-only record")}</span>
          <h1>{t("Audit stream")}</h1>
          <p>{t("Every durable mutation is sequenced, attributable, and replayable.")}</p>
        </div>
        <div className="heading-actions">
          <span className="muted" role="status" aria-live="polite">
            {t("{filtered} of {total} events", {
              filtered: filtered.length,
              total: events.length,
            })}
          </span>
          <label className="inline-search">
            <MagnifyingGlass size={16} aria-hidden="true" />
            <input
              type="search"
              aria-label={t("Filter audit events")}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("Filter events")}
            />
          </label>
        </div>
      </div>
      <Panel className="audit-panel">
        {loading ? (
          <div className="empty-state" role="status" aria-live="polite">
            <strong>{t("Loading the audit stream")}</strong>
            <span>{t("Replaying sequenced project events…")}</span>
          </div>
        ) : error ? (
          <div className="error-state" role="alert">
            <div>
              <strong>{t("Unable to load the audit stream")}</strong>
              <span>{errorText}</span>
              {onRetry && (
                <button className="primary-button" type="button" onClick={onRetry}>
                  {t("Try again")}
                </button>
              )}
            </div>
          </div>
        ) : (
          <div role="table" aria-label={t("Sequenced project events")}>
            <div className="audit-header" role="row">
              <span role="columnheader">{t("Sequence")}</span>
              <span role="columnheader">{t("Time")}</span>
              <span role="columnheader">{t("Event")}</span>
              <span role="columnheader">{t("Actor")}</span>
              <span role="columnheader">{t("Aggregate")}</span>
              <span role="columnheader">{t("Detail")}</span>
            </div>
            <div className="audit-rows" role="rowgroup">
              {filtered.map((event) => (
                <div key={event.id} className="audit-row" role="row">
                  <code role="cell">#{event.sequence}</code>
                  <time
                    role="cell"
                    dateTime={event.createdAt}
                    title={new Date(event.createdAt).toLocaleString()}
                  >
                    {new Date(event.createdAt).toLocaleTimeString()}
                  </time>
                  <span role="cell">
                    <Pulse size={13} aria-hidden="true" />
                    <strong>{event.type}</strong>
                  </span>
                  <span role="cell">{event.actorId}</span>
                  <code role="cell" title={`${event.aggregateType}:${event.aggregateId}`}>
                    {event.aggregateType}:{event.aggregateId.slice(-8)}
                  </code>
                  <span role="cell">
                    <Pill tone={event.actorType === "system" ? "neutral" : "cyan"}>
                      {event.actorType}
                    </Pill>
                  </span>
                </div>
              ))}
              {filtered.length === 0 && (
                <EmptyState
                  title={events.length ? t("No matching events") : t("No audit events yet")}
                  text={
                    events.length
                      ? t("Adjust the filter to return to the complete event stream.")
                      : t("Durable project mutations will appear here in sequence order.")
                  }
                />
              )}
            </div>
          </div>
        )}
      </Panel>
    </div>
  );
}
