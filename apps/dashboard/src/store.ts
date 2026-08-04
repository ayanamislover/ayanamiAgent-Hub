import { create } from "zustand";
import {
  formatDashboardHash,
  normalizeRouteId,
  parseDashboardHash,
  type DashboardRoute,
  type PageName,
} from "./navigation.js";

export type { PageName } from "./navigation.js";

type UiState = {
  page: PageName;
  projectId: string | null;
  selectedTaskId: string | null;
  connected: boolean;
  stale: boolean;
  commandOpen: boolean;
  setPage: (page: PageName) => void;
  setProjectId: (projectId: string) => void;
  setSelectedTaskId: (taskId: string | null) => void;
  setConnected: (connected: boolean) => void;
  setStale: (stale: boolean) => void;
  setCommandOpen: (open: boolean) => void;
};

function storedProjectId(): string | null {
  return normalizeRouteId(localStorage.getItem("crossagent.project"));
}

function initialRoute(): DashboardRoute {
  const route = parseDashboardHash(window.location.hash);
  if (route.projectId) return route;
  const projectId = storedProjectId();
  return { ...route, projectId, taskId: null };
}

function writeRoute(route: DashboardRoute, replace = false): void {
  const hash = formatDashboardHash(route);
  if (window.location.hash === hash) return;
  if (replace) {
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${window.location.search}${hash}`,
    );
  } else {
    window.location.hash = hash;
  }
}

const route = initialRoute();
writeRoute(route, true);

export const useUi = create<UiState>((set) => ({
  page: route.page,
  projectId: route.projectId,
  selectedTaskId: route.taskId,
  connected: false,
  stale: false,
  commandOpen: false,
  setPage: (page) => {
    const current = useUi.getState();
    const next = { page, projectId: current.projectId, taskId: current.selectedTaskId };
    writeRoute(next);
    set({ page: next.page });
  },
  setProjectId: (projectId) => {
    const normalized = normalizeRouteId(projectId);
    if (!normalized) return;
    localStorage.setItem("crossagent.project", projectId);
    const next = { page: useUi.getState().page, projectId: normalized, taskId: null };
    writeRoute(next);
    set({ projectId: normalized, selectedTaskId: null });
  },
  setSelectedTaskId: (selectedTaskId) => {
    const current = useUi.getState();
    const normalized = normalizeRouteId(selectedTaskId);
    const next = {
      page: current.page,
      projectId: current.projectId,
      taskId: current.projectId ? normalized : null,
    };
    writeRoute(next);
    set({ selectedTaskId: next.taskId });
  },
  setConnected: (connected) => set({ connected }),
  setStale: (stale) => set({ stale }),
  setCommandOpen: (commandOpen) => set({ commandOpen }),
}));

window.addEventListener("hashchange", () => {
  const parsed = parseDashboardHash(window.location.hash);
  const projectId = parsed.projectId ?? storedProjectId();
  const next = { ...parsed, projectId, taskId: parsed.projectId ? parsed.taskId : null };
  if (projectId) localStorage.setItem("crossagent.project", projectId);
  writeRoute(next, true);
  useUi.setState({
    page: next.page,
    projectId: next.projectId,
    selectedTaskId: next.taskId,
  });
});
