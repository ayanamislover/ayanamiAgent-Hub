export const DASHBOARD_PAGES = [
  "overview",
  "tasks",
  "communications",
  "console",
  "reviews",
  "agents",
  "conflicts",
  "audit",
  "settings",
] as const;

export type PageName = (typeof DASHBOARD_PAGES)[number];

export type DashboardRoute = {
  page: PageName;
  projectId: string | null;
  taskId: string | null;
};

const ROUTE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;

export function normalizeRouteId(value: string | null | undefined): string | null {
  return value && ROUTE_ID.test(value) ? value : null;
}

export function parseDashboardHash(hash: string): DashboardRoute {
  const fragment = hash.startsWith("#/") ? hash.slice(2) : "";
  const separator = fragment.indexOf("?");
  const rawPage = separator === -1 ? fragment : fragment.slice(0, separator);
  const page = DASHBOARD_PAGES.includes(rawPage as PageName) ? (rawPage as PageName) : "overview";
  const params = new URLSearchParams(separator === -1 ? "" : fragment.slice(separator + 1));
  const projectId = normalizeRouteId(params.get("projectId"));
  return {
    page,
    projectId,
    taskId: projectId ? normalizeRouteId(params.get("taskId")) : null,
  };
}

export function formatDashboardHash(route: DashboardRoute): string {
  const params = new URLSearchParams();
  const projectId = normalizeRouteId(route.projectId);
  const taskId = projectId ? normalizeRouteId(route.taskId) : null;
  if (projectId) params.set("projectId", projectId);
  if (taskId) params.set("taskId", taskId);
  const query = params.toString();
  return `#/${route.page}${query ? `?${query}` : ""}`;
}
