import { useState } from "react";
import {
  CheckCircle,
  Database,
  FloppyDisk,
  LockKey,
  Pulse,
  ShieldCheck,
  WarningCircle,
  XCircle,
} from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AuthorizationGrant } from "@crossagent/protocol";
import { hub, idempotency } from "../api.js";
import { Panel, Pill } from "../components/primitives.js";
import { Select } from "../components/select.js";
import type { Metrics, Overview } from "../types.js";
import { localeOverride, localeTag, setLocaleOverride, t, type DashboardLocale } from "../i18n.js";
import "./settings-authorizations.css";

type AuthorizationDecision = "GRANTED" | "DENIED" | "REVOKED";

type AuthorizationMutationInput = {
  grant: AuthorizationGrant;
  decision: AuthorizationDecision;
  ttlSeconds?: number;
  idempotencyKey: string;
};

const authorizationStatus: Record<
  AuthorizationGrant["status"],
  { label: string; tone: "amber" | "green" | "red" }
> = {
  PENDING: { label: t("Pending approval"), tone: "amber" },
  GRANTED: { label: t("Granted"), tone: "green" },
  DENIED: { label: t("Denied"), tone: "red" },
  REVOKED: { label: t("Revoked"), tone: "red" },
  EXPIRED: { label: t("Expired"), tone: "amber" },
};

function formatTimestamp(value: string | null): string {
  if (!value) return t("Does not expire automatically");
  return new Intl.DateTimeFormat(localeTag(), {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date(value));
}

function capabilityName(capability: AuthorizationGrant["capability"]): string {
  if (capability === "terminal.unrestricted") return t("Unrestricted local terminal");
  return capability;
}

function AuthorizationPanel({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const [feedback, setFeedback] = useState("");
  const authorizations = useQuery({
    queryKey: ["project", projectId, "authorizations"],
    queryFn: () =>
      hub.request<AuthorizationGrant[]>("GET", `/api/projects/${projectId}/authorizations`),
  });
  const mutation = useMutation({
    mutationFn: ({ grant, decision, ttlSeconds, idempotencyKey }: AuthorizationMutationInput) =>
      hub.request<AuthorizationGrant>("POST", `/api/authorizations/${grant.id}/decision`, {
        expectedVersion: grant.version,
        decision,
        actorId: "local-user",
        note:
          decision === "GRANTED"
            ? t("Approved through the Dashboard")
            : decision === "DENIED"
              ? t("Denied through the Dashboard")
              : t("Revoked through the Dashboard"),
        ttlSeconds,
        idempotencyKey,
      }),
    onMutate: () => setFeedback(""),
    onSuccess: (grant, input) => {
      const action =
        input.decision === "GRANTED"
          ? t("Approved for 24 hours")
          : input.decision === "DENIED"
            ? t("Denied")
            : t("Revoked");
      setFeedback(`${capabilityName(grant.capability)} · ${action}`);
      void queryClient.invalidateQueries({
        queryKey: ["project", projectId, "authorizations"],
      });
      void queryClient.invalidateQueries({ queryKey: ["project", projectId] });
    },
    onError: (error) => {
      setFeedback(error instanceof Error ? error.message : String(error));
      void queryClient.invalidateQueries({
        queryKey: ["project", projectId, "authorizations"],
      });
    },
  });

  const pending = authorizations.data?.filter((grant) => grant.status === "PENDING") ?? [];
  const active = authorizations.data?.filter((grant) => grant.status === "GRANTED") ?? [];

  const decide = (
    grant: AuthorizationGrant,
    decision: AuthorizationDecision,
    ttlSeconds?: number,
  ) => {
    mutation.mutate({
      grant,
      decision,
      ttlSeconds,
      idempotencyKey: idempotency(`dashboard-authorization-${grant.id}-${decision.toLowerCase()}`),
    });
  };

  return (
    <Panel eyebrow={t("Capability authorization")} title={t("Terminal permissions")}>
      <div className="authorization-panel" data-testid="authorization-panel">
        <div className="authorization-boundary" role="note">
          <WarningCircle size={18} weight="fill" />
          <div>
            <strong>{t("This is an audit record, not cryptographic isolation")}</strong>
            <span>
              {t(
                "A holder of the local token can still call the decision API. The Dashboard records the decision source, time, expiry, and revocation.",
              )}
            </span>
          </div>
        </div>

        {authorizations.isLoading && (
          <div className="authorization-loading" role="status" aria-live="polite">
            <span />
            <span />
            <span />
            {t("Loading authorization records")}
          </div>
        )}

        {authorizations.isError && (
          <div className="authorization-error" role="alert">
            <XCircle size={18} />
            <div>
              <strong>{t("Unable to load authorization records")}</strong>
              <span>
                {authorizations.error instanceof Error
                  ? authorizations.error.message
                  : String(authorizations.error)}
              </span>
            </div>
            <button type="button" onClick={() => void authorizations.refetch()}>
              {t("Retry")}
            </button>
          </div>
        )}

        {!authorizations.isLoading && !authorizations.isError && (
          <>
            <section
              className="authorization-section"
              aria-labelledby="pending-authorization-title"
            >
              <header>
                <div>
                  <h3 id="pending-authorization-title">{t("Pending requests")}</h3>
                  <span>
                    {t("Only decisions clicked here are marked as originating from the Dashboard.")}
                  </span>
                </div>
                <Pill tone={pending.length ? "amber" : "green"}>
                  {t("{count} items", { count: pending.length })}
                </Pill>
              </header>
              {pending.length === 0 ? (
                <div className="authorization-empty">
                  <ShieldCheck size={20} />
                  <span>{t("There are no pending permission requests.")}</span>
                </div>
              ) : (
                <div className="authorization-list">
                  {pending.map((grant) => {
                    const busy = mutation.isPending && mutation.variables?.grant.id === grant.id;
                    return (
                      <article className="authorization-request" key={grant.id}>
                        <div className="authorization-request-heading">
                          <div>
                            <strong>{capabilityName(grant.capability)}</strong>
                            <code>{grant.capability}</code>
                          </div>
                          <Pill tone={authorizationStatus[grant.status].tone}>
                            {authorizationStatus[grant.status].label}
                          </Pill>
                        </div>
                        <p>{grant.reason}</p>
                        <dl>
                          <div>
                            <dt>{t("Requesting Agent")}</dt>
                            <dd>{grant.requestedByAgentId}</dd>
                          </div>
                          <div>
                            <dt>{t("Requested at")}</dt>
                            <dd>
                              <time dateTime={grant.createdAt}>
                                {formatTimestamp(grant.createdAt)}
                              </time>
                            </dd>
                          </div>
                        </dl>
                        <div className="authorization-actions">
                          <button
                            className="authorization-deny"
                            type="button"
                            disabled={busy}
                            onClick={() => decide(grant, "DENIED")}
                            data-testid={`authorization-deny-${grant.id}`}
                          >
                            <XCircle size={16} />
                            {t("Deny")}
                          </button>
                          <button
                            className="authorization-approve"
                            type="button"
                            disabled={busy}
                            aria-busy={busy}
                            onClick={() => decide(grant, "GRANTED", 86_400)}
                            data-testid={`authorization-approve-${grant.id}`}
                          >
                            <CheckCircle size={16} weight="fill" />
                            {busy ? t("Processing") : t("Approve for 24 hours")}
                          </button>
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
            </section>

            <section className="authorization-section" aria-labelledby="active-authorization-title">
              <header>
                <div>
                  <h3 id="active-authorization-title">{t("Active authorizations")}</h3>
                  <span>
                    {t(
                      "Authorizations expire automatically and can be revoked by the user at any time.",
                    )}
                  </span>
                </div>
                <Pill tone={active.length ? "green" : "amber"}>
                  {t("{count} items", { count: active.length })}
                </Pill>
              </header>
              {active.length === 0 ? (
                <div className="authorization-empty">
                  <LockKey size={20} />
                  <span>{t("There are no active authorizations.")}</span>
                </div>
              ) : (
                <div className="authorization-list">
                  {active.map((grant) => {
                    const busy = mutation.isPending && mutation.variables?.grant.id === grant.id;
                    return (
                      <article className="authorization-request active" key={grant.id}>
                        <div className="authorization-request-heading">
                          <div>
                            <strong>{capabilityName(grant.capability)}</strong>
                            <code>{grant.capability}</code>
                          </div>
                          <Pill tone={authorizationStatus[grant.status].tone}>
                            {authorizationStatus[grant.status].label}
                          </Pill>
                        </div>
                        <dl>
                          <div>
                            <dt>{t("Approval source")}</dt>
                            <dd>
                              {grant.decidedVia === "dashboard" ? t("Dashboard click") : "API"}
                            </dd>
                          </div>
                          <div>
                            <dt>{t("Expires at")}</dt>
                            <dd>
                              {grant.expiresAt ? (
                                <time dateTime={grant.expiresAt}>
                                  {formatTimestamp(grant.expiresAt)}
                                </time>
                              ) : (
                                formatTimestamp(null)
                              )}
                            </dd>
                          </div>
                        </dl>
                        <div className="authorization-actions">
                          <button
                            className="authorization-revoke"
                            type="button"
                            disabled={busy}
                            aria-busy={busy}
                            onClick={() => decide(grant, "REVOKED")}
                            data-testid={`authorization-revoke-${grant.id}`}
                          >
                            <LockKey size={16} />
                            {busy ? t("Processing") : t("Revoke authorization")}
                          </button>
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
            </section>
          </>
        )}

        <span
          className="authorization-feedback"
          role={mutation.isError ? "alert" : "status"}
          aria-live="polite"
        >
          {feedback}
        </span>
      </div>
    </Panel>
  );
}

export function SettingsPage({
  overview,
  metrics,
  health,
}: {
  overview: Overview;
  metrics: Metrics;
  health: Record<string, unknown>;
}) {
  const [value, setValue] = useState(JSON.stringify(overview.project.config, null, 2));
  const [message, setMessage] = useState("");
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: () =>
      hub.request("PATCH", `/api/projects/${overview.project.id}/settings`, {
        expectedVersion: overview.project.version,
        config: JSON.parse(value),
        idempotencyKey: idempotency("dashboard-settings"),
      }),
    onSuccess: () => {
      setMessage(
        t("Settings saved at {time}", { time: new Date().toLocaleTimeString(localeTag()) }),
      );
      void queryClient.invalidateQueries({ queryKey: ["project", overview.project.id] });
    },
    onError: (error) => setMessage(error instanceof Error ? error.message : String(error)),
  });
  const database = health.database as Record<string, unknown> | undefined;
  return (
    <div className="standard-page">
      <div className="page-heading">
        <div>
          <span className="eyebrow">{t("Local control plane")}</span>
          <h1>{t("Settings & runtime")}</h1>
          <p>
            {t(
              "Inspect project policy, capability authorizations, persistence, and local security boundaries.",
            )}
          </p>
        </div>
      </div>
      <div className="settings-grid">
        <div className="settings-main">
          <AuthorizationPanel projectId={overview.project.id} />
          <Panel eyebrow={t("Project policy")} title={t("Configuration")}>
            <label className="field">
              <span>{t("Validated JSON")}</span>
              <textarea
                className="code-editor"
                rows={18}
                spellCheck={false}
                aria-invalid={mutation.isError}
                value={value}
                onChange={(event) => {
                  setValue(event.target.value);
                  setMessage("");
                  mutation.reset();
                }}
              />
            </label>
            <div className="settings-actions">
              <span role={mutation.isError ? "alert" : "status"} aria-live="polite">
                {message}
              </span>
              <button
                className="primary-button"
                type="button"
                onClick={() => mutation.mutate()}
                disabled={mutation.isPending}
                aria-busy={mutation.isPending}
              >
                <FloppyDisk size={16} /> {mutation.isPending ? t("Saving") : t("Save settings")}
              </button>
            </div>
          </Panel>
        </div>
        <div className="settings-rail">
          <Panel eyebrow={t("Runtime")} title={t("Service status")}>
            <div className="health-checks">
              <div>
                <CheckCircle size={17} />
                <span>Hub API</span>
                <Pill tone="green">ONLINE</Pill>
              </div>
              <div>
                <Database size={17} />
                <span>SQLite</span>
                <strong>{String(database?.journalMode ?? t("None"))}</strong>
              </div>
              <div>
                <Pulse size={17} />
                <span>{t("Heartbeat lag")}</span>
                <strong>{Math.round(metrics.maxHeartbeatLagMs)} ms</strong>
              </div>
              <div>
                <LockKey size={17} />
                <span>{t("Network boundary")}</span>
                <strong>{t("Loopback + token")}</strong>
              </div>
            </div>
          </Panel>
          <Panel eyebrow={t("Adapters")} title={t("Delivery methods")}>
            <div className="adapter-list">
              {overview.sessions.map((session) => (
                <div key={session.id}>
                  <span className={`agent-avatar mini ${session.agentId}`}>
                    {session.agentId[0]?.toUpperCase()}
                  </span>
                  <div>
                    <strong>{session.agentId}</strong>
                    <span>{session.client}</span>
                  </div>
                  <Pill tone={session.connectionState === "ONLINE" ? "green" : "amber"}>
                    {session.deliveryMode}
                  </Pill>
                </div>
              ))}
              {overview.sessions.length === 0 && (
                <span className="muted">{t("No adapters observed yet.")}</span>
              )}
            </div>
          </Panel>
          <Panel eyebrow={t("Interface")} title={t("Language")}>
            <Select
              label={t("Language")}
              hideLabel
              value={localeOverride() ?? "auto"}
              options={[
                { value: "auto", label: t("Follow the browser") },
                // Endonyms: each option names its own language, so it stays readable to someone
                // who cannot read the language currently on screen.
                { value: "en", label: "English" },
                { value: "zh-CN", label: "简体中文" },
              ]}
              onChange={(value) =>
                setLocaleOverride(value === "auto" ? null : (value as DashboardLocale))
              }
              hint={t("Switching the language reloads the Dashboard.")}
            />
          </Panel>
          <Panel eyebrow={t("Boundaries")} title={t("Security guarantees")}>
            <ul className="guardrail-list">
              <li>{t("Binds only to 127.0.0.1")}</li>
              <li>{t("Bearer or HttpOnly launch session")}</li>
              <li>{t("Capability authorization before PTY launch")}</li>
              <li>{t("Bounded payload sizes and event replay")}</li>
              <li>{t("Secret-redacted diagnostic exports")}</li>
            </ul>
          </Panel>
        </div>
      </div>
    </div>
  );
}
