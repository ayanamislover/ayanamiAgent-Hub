import { homedir } from "node:os";
import { resolve } from "node:path";

export type RuntimeConfig = {
  host: string;
  port: number;
  dataDir: string;
  databasePath: string;
  dashboardDir?: string;
  dashboardAuthMode: DashboardAuthMode;
  logLevel: string;
};

export type DashboardAuthMode = "disabled" | "required";

export function parseDashboardAuthMode(value: string | undefined): DashboardAuthMode {
  const normalized = value?.trim().toLowerCase() || "disabled";
  if (normalized === "disabled" || normalized === "required") return normalized;
  throw new Error("CROSSAGENT_DASHBOARD_AUTH must be either 'disabled' or 'required'");
}

export function loadRuntimeConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  const dataDir =
    overrides.dataDir ?? process.env.CROSSAGENT_DATA_DIR ?? resolve(homedir(), ".crossagent");
  return {
    host: overrides.host ?? process.env.CROSSAGENT_HOST ?? "127.0.0.1",
    port: overrides.port ?? Number(process.env.CROSSAGENT_PORT ?? 4387),
    dataDir,
    databasePath:
      overrides.databasePath ??
      process.env.CROSSAGENT_DATABASE ??
      resolve(dataDir, "crossagent.db"),
    dashboardDir: overrides.dashboardDir ?? process.env.CROSSAGENT_DASHBOARD_DIR,
    dashboardAuthMode:
      overrides.dashboardAuthMode ?? parseDashboardAuthMode(process.env.CROSSAGENT_DASHBOARD_AUTH),
    logLevel: overrides.logLevel ?? process.env.CROSSAGENT_LOG_LEVEL ?? "info",
  };
}
