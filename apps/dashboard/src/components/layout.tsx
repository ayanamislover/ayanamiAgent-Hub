import { useState, type ReactNode } from "react";
import {
  ArrowsClockwise,
  Broadcast,
  Bug,
  CirclesFour,
  GitDiff,
  Kanban,
  MagnifyingGlass,
  Plus,
  Pulse,
  Robot,
  SlidersHorizontal,
  TerminalWindow,
  UsersThree,
} from "@phosphor-icons/react";
import type { RegisteredProject } from "@crossagent/client";
import clsx from "clsx";
import { useUi, type PageName } from "../store.js";
import type { Metrics } from "../types.js";
import { Pill, StatusDot } from "./primitives.js";
import { ProjectManagerDialog } from "./project-manager.js";
import { Select } from "./select.js";
import { t } from "../i18n.js";

const NAV: Array<{
  page: PageName;
  label: string;
  icon: typeof CirclesFour;
  group?: string;
}> = [
  { page: "overview", label: t("Overview"), icon: CirclesFour, group: t("Scheduling") },
  { page: "tasks", label: t("Tasks"), icon: Kanban },
  { page: "communications", label: t("Communications"), icon: Broadcast },
  { page: "console", label: t("Console"), icon: TerminalWindow },
  { page: "reviews", label: t("Reviews"), icon: GitDiff, group: t("Quality assurance") },
  { page: "agents", label: t("Agents"), icon: UsersThree },
  { page: "conflicts", label: t("Conflicts"), icon: Bug },
  { page: "audit", label: t("Audit"), icon: Pulse, group: t("System") },
  { page: "settings", label: t("Settings"), icon: SlidersHorizontal },
];

export function AppShell({
  projects,
  metrics,
  children,
}: {
  projects: RegisteredProject[];
  metrics?: Metrics;
  children: ReactNode;
}) {
  const page = useUi((state) => state.page);
  const projectId = useUi((state) => state.projectId);
  const setPage = useUi((state) => state.setPage);
  const setProjectId = useUi((state) => state.setProjectId);
  const connected = useUi((state) => state.connected);
  const stale = useUi((state) => state.stale);
  const [projectManagerOpen, setProjectManagerOpen] = useState(false);
  const project = projects.find((item) => item.id === projectId) ?? projects[0];

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <Robot size={22} weight="duotone" />
          </div>
          <div>
            <strong>CROSSAGENT</strong>
            <span>{t("Local control plane")}</span>
          </div>
        </div>
        <div className="project-switcher">
          <div className="project-switcher-head">
            <span>{t("Current project")}</span>
            <button
              className="project-manager-trigger"
              type="button"
              aria-label={t("Manage registered projects")}
              title={t("Manage registered projects")}
              onClick={() => setProjectManagerOpen(true)}
            >
              <Plus size={15} weight="bold" />
            </button>
          </div>
          <Select
            className="project-picker"
            popupClassName="project-picker-popup"
            label={t("Current project")}
            hideLabel
            value={project?.id ?? ""}
            options={projects.map((item) => ({
              value: item.id,
              label: item.name,
              description: item.paths[0] ?? t("No registered path"),
            }))}
            onChange={setProjectId}
            placeholder={t("No project selected")}
          />
          <code title={project?.id}>{project?.id ?? t("No project selected")}</code>
          <small title={project?.paths[0]}>{project?.paths[0] ?? t("No registered path")}</small>
        </div>
        <nav>
          {NAV.map((item, index) => {
            const previous = NAV[index - 1];
            return (
              <div key={item.page}>
                {item.group && item.group !== previous?.group && (
                  <span className="nav-group">{item.group}</span>
                )}
                <button
                  className={clsx("nav-item", page === item.page && "active")}
                  data-testid={`nav-${item.page}`}
                  onClick={() => setPage(item.page)}
                >
                  <item.icon size={18} weight={page === item.page ? "fill" : "regular"} />
                  <span>{item.label}</span>
                  {item.page === "conflicts" && Boolean(metrics?.writeConflicts) && (
                    <b>{metrics?.writeConflicts}</b>
                  )}
                </button>
              </div>
            );
          })}
        </nav>
        <div className="sidebar-foot">
          <div>
            <StatusDot state={connected ? "ok" : stale ? "warn" : "danger"} />
            <span>
              {connected ? t("Live connection") : stale ? t("Resync required") : t("Reconnecting")}
            </span>
          </div>
          <span>v0.1.0-alpha.1 · {t("Local only")}</span>
        </div>
      </aside>
      <main className="main-shell">
        <header className="topbar">
          <div className="crumb">
            <span>{project?.name ?? t("Current project")}</span>
            <strong>/</strong>
            <b>{NAV.find((item) => item.page === page)?.label}</b>
          </div>
          <button
            className="search-trigger"
            data-testid="command-trigger"
            onClick={() => useUi.getState().setCommandOpen(true)}
          >
            <MagnifyingGlass size={16} />
            <span>{t("Search tasks, sessions, and agents…")}</span>
            <kbd>⌘ K</kbd>
          </button>
          <div className="top-metrics">
            <div>
              <span>{t("Agents")}</span>
              <strong>{metrics?.activeSessions ?? "—"}</strong>
            </div>
            <div>
              <span>{t("Inbox")}</span>
              <strong>{metrics?.pendingMessages ?? "—"}</strong>
            </div>
            <div>
              <span>{t("Event stream")}</span>
              <Pill tone={connected ? "green" : "amber"}>
                <ArrowsClockwise size={12} className={!connected ? "spin" : ""} />
                {connected ? t("Live") : t("Syncing")}
              </Pill>
            </div>
          </div>
        </header>
        <div className="page-shell">{children}</div>
      </main>
      <ProjectManagerDialog
        open={projectManagerOpen}
        projects={projects}
        activeProjectId={project?.id ?? null}
        onClose={() => setProjectManagerOpen(false)}
      />
    </div>
  );
}
