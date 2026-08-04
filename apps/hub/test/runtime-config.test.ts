import { afterEach, describe, expect, it } from "vitest";
import { loadRuntimeConfig, parseDashboardAuthMode } from "../src/config/runtime.js";

const previousDashboardAuth = process.env.CROSSAGENT_DASHBOARD_AUTH;

afterEach(() => {
  if (previousDashboardAuth === undefined) delete process.env.CROSSAGENT_DASHBOARD_AUTH;
  else process.env.CROSSAGENT_DASHBOARD_AUTH = previousDashboardAuth;
});

describe("runtime configuration", () => {
  it("disables the optional Dashboard authentication gate by default", () => {
    delete process.env.CROSSAGENT_DASHBOARD_AUTH;
    expect(loadRuntimeConfig().dashboardAuthMode).toBe("disabled");
  });

  it("accepts only explicit disabled or required Dashboard authentication modes", () => {
    expect(parseDashboardAuthMode("disabled")).toBe("disabled");
    expect(parseDashboardAuthMode(" REQUIRED ")).toBe("required");
    expect(() => parseDashboardAuthMode("off")).toThrow(/disabled.*required/i);
  });
});
