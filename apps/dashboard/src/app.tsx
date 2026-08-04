import { lazy, Suspense, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Key, Robot } from "@phosphor-icons/react";
import type { RegisteredProject } from "@crossagent/client";
import { hub } from "./api.js";
import { useProjectSocket } from "./hooks.js";
import { useUi } from "./store.js";
import type { Metrics, Overview, ReviewView } from "./types.js";
import { AppShell } from "./components/layout.js";
import { CommandPalette } from "./components/command-palette.js";
import { ErrorState, Loading } from "./components/primitives.js";
import { OverviewPage } from "./pages/overview.js";
import { TasksPage } from "./pages/tasks.js";
import { CommunicationsPage } from "./pages/communications.js";
import { ReviewsPage } from "./pages/reviews.js";
import { AgentsPage } from "./pages/agents.js";
import { ConflictsPage } from "./pages/conflicts.js";
import { AuditPage } from "./pages/audit.js";
import { SettingsPage } from "./pages/settings.js";
import { ProjectOnboarding } from "./components/project-manager.js";
import { t } from "./i18n.js";

const ConsolePage = lazy(() =>
  import("./pages/console.js").then((module) => ({ default: module.ConsolePage })),
);

function AccessGate({ onAuthenticated }: { onAuthenticated: () => void }) {
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const authenticate = async () => {
    const response = await fetch("/api/dashboard/auth", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "{}",
    });
    if (!response.ok) {
      setError(t("Token rejected. Read ~/.crossagent/dashboard-token or run crossagent open."));
      return;
    }
    onAuthenticated();
  };
  return (
    <div className="access-gate">
      <div className="gate-card">
        <div className="brand-mark large">
          <Robot size={28} weight="duotone" />
        </div>
        <span className="eyebrow">{t("Local authentication")}</span>
        <h1>{t("Enter the control plane")}</h1>
        <p>{t("Use crossagent open for a one-time launch, or paste the local Dashboard token.")}</p>
        <label>
          <Key size={18} />
          <input
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder={t("Local Dashboard token")}
          />
        </label>
        {error && <span className="gate-error">{error}</span>}
        <button
          className="primary-button full"
          onClick={() => void authenticate()}
          disabled={token.length < 20}
        >
          {t("Authenticate")}
        </button>
      </div>
    </div>
  );
}

export function App() {
  const [bootstrapReady, setBootstrapReady] = useState(false);
  const [authEpoch, setAuthEpoch] = useState(0);
  const projectId = useUi((state) => state.projectId);
  const setProjectId = useUi((state) => state.setProjectId);
  const selectedTaskId = useUi((state) => state.selectedTaskId);
  const setSelectedTaskId = useUi((state) => state.setSelectedTaskId);
  const page = useUi((state) => state.page);

  useEffect(() => {
    const url = new URL(window.location.href);
    const launch = url.searchParams.get("launch");
    void (async () => {
      let authenticated = false;
      if (launch) {
        const response = await fetch("/api/dashboard/exchange", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code: launch }),
        });
        authenticated = response.ok;
        url.searchParams.delete("launch");
        window.history.replaceState({}, "", url);
      }
      if (!authenticated) {
        await fetch("/api/dashboard/auth", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
      }
    })()
      .catch(() => undefined)
      .finally(() => {
        setBootstrapReady(true);
        setAuthEpoch((value) => value + 1);
      });
  }, []);

  const projects = useQuery<RegisteredProject[]>({
    queryKey: ["projects", authEpoch],
    queryFn: () => hub.listProjects(),
    enabled: bootstrapReady,
    retry: false,
  });
  useEffect(() => {
    if (!projectId && projects.data?.[0]) setProjectId(projects.data[0].id);
    if (
      projectId &&
      projects.data &&
      !projects.data.some((item) => item.id === projectId) &&
      projects.data[0]
    ) {
      setProjectId(projects.data[0].id);
    }
  }, [projectId, projects.data, setProjectId]);
  const activeProjectId =
    projectId && projects.data?.some((project) => project.id === projectId)
      ? projectId
      : (projects.data?.[0]?.id ?? null);
  const overview = useQuery<Overview>({
    queryKey: ["project", activeProjectId, "overview"],
    queryFn: () => hub.getOverview(activeProjectId!) as Promise<Overview>,
    enabled: Boolean(activeProjectId),
  });
  useEffect(() => {
    if (!selectedTaskId || !activeProjectId || overview.data?.project.id !== activeProjectId) {
      return;
    }
    if (!overview.data.tasks.some((task) => task.id === selectedTaskId)) {
      setSelectedTaskId(null);
    }
  }, [activeProjectId, overview.data, selectedTaskId, setSelectedTaskId]);
  const metrics = useQuery<Metrics>({
    queryKey: ["project", activeProjectId, "metrics"],
    queryFn: () => hub.request("GET", `/api/metrics/summary?projectId=${activeProjectId}`),
    enabled: Boolean(activeProjectId),
    refetchInterval: 5000,
  });
  const selectedTaskIsValid =
    !selectedTaskId ||
    (overview.data?.project.id === activeProjectId &&
      overview.data.tasks.some((task) => task.id === selectedTaskId));
  const messages = useQuery({
    queryKey: ["project", activeProjectId, "messages", selectedTaskId ?? "all"],
    queryFn: () =>
      hub.listMessages(activeProjectId!, {
        limit: 200,
        ...(selectedTaskId ? { taskId: selectedTaskId } : {}),
      }),
    enabled: Boolean(activeProjectId) && page === "communications" && selectedTaskIsValid,
  });
  const reviews = useQuery<ReviewView[]>({
    queryKey: ["project", activeProjectId, "reviews"],
    queryFn: async () => {
      const list = await hub.request<ReviewView[]>(
        "GET",
        `/api/projects/${activeProjectId}/reviews`,
      );
      return Promise.all(
        list.map((review) => hub.request<ReviewView>("GET", `/api/reviews/${review.id}`)),
      );
    },
    enabled: Boolean(activeProjectId) && page === "reviews",
  });
  const events = useQuery({
    queryKey: ["project", activeProjectId, "events"],
    queryFn: () => hub.listEvents(activeProjectId!, 0, 5000),
    enabled: Boolean(activeProjectId) && page === "audit",
  });
  const health = useQuery<Record<string, unknown>>({
    queryKey: ["health"],
    queryFn: () => hub.health(),
    refetchInterval: 10000,
  });

  useProjectSocket(activeProjectId, overview.data?.currentSequence ?? 0);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        useUi.getState().setCommandOpen(true);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  if (!bootstrapReady || projects.isLoading)
    return <Loading label={t("Opening local control plane")} />;
  if (projects.error) {
    const status = (projects.error as { status?: number }).status;
    if (status === 403) {
      return <AccessGate onAuthenticated={() => setAuthEpoch((value) => value + 1)} />;
    }
    return <ErrorState error={projects.error} />;
  }
  if (!projects.data?.length) {
    return <ProjectOnboarding />;
  }
  if (overview.error) return <ErrorState error={overview.error} />;
  if (metrics.error) return <ErrorState error={metrics.error} />;
  if (!overview.data || !metrics.data) return <Loading />;
  const content = (() => {
    switch (page) {
      case "overview":
        return <OverviewPage overview={overview.data} />;
      case "tasks":
        return <TasksPage overview={overview.data} />;
      case "communications":
        return (
          <CommunicationsPage
            projectId={overview.data.project.id}
            tasks={overview.data.tasks}
            messages={messages.data ?? []}
            loading={messages.isLoading}
            error={messages.error}
            onRetry={() => void messages.refetch()}
          />
        );
      case "console":
        return (
          <Suspense fallback={<Loading label={t("Opening terminal console")} />}>
            <ConsolePage projectId={overview.data.project.id} />
          </Suspense>
        );
      case "reviews":
        return (
          <ReviewsPage
            reviews={reviews.data ?? []}
            loading={reviews.isLoading}
            error={reviews.error}
            onRetry={() => void reviews.refetch()}
          />
        );
      case "agents":
        return <AgentsPage sessions={overview.data.sessions} />;
      case "conflicts":
        return (
          <ConflictsPage projectId={overview.data.project.id} conflicts={overview.data.conflicts} />
        );
      case "audit":
        return (
          <AuditPage
            events={events.data ?? []}
            loading={events.isLoading}
            error={events.error}
            onRetry={() => void events.refetch()}
          />
        );
      case "settings":
        return (
          <SettingsPage
            overview={overview.data}
            metrics={metrics.data}
            health={health.data ?? {}}
          />
        );
    }
  })();
  return (
    <>
      <AppShell projects={projects.data} metrics={metrics.data}>
        {content}
      </AppShell>
      <CommandPalette tasks={overview.data.tasks} />
    </>
  );
}
