import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const outputRoot = resolve(root, "output", "playwright");
const dataDir = resolve(outputRoot, "e2e-data");

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  // Playwright's 5s assertion budget and 30s case budget are developer-machine numbers. The first
  // paint after a launch-code exchange missed 5s once on a GitHub Windows runner -- a cold start at
  // 3440x1440, not a broken page, which never renders at all however long you wait. Raising the
  // ceilings costs nothing on a passing run and keeps a failure meaningful.
  timeout: 60_000,
  expect: { timeout: 15_000 },
  outputDir: resolve(outputRoot, "test-results"),
  globalSetup: "./e2e/global-setup.ts",
  use: {
    baseURL: "http://127.0.0.1:4390",
    colorScheme: "dark",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "ultrawide",
      use: { viewport: { width: 3440, height: 1440 } },
    },
    {
      name: "full-hd",
      use: { viewport: { width: 1920, height: 1080 } },
    },
  ],
  webServer: {
    command: "node apps/dashboard/e2e/start-hub.mjs",
    cwd: root,
    url: "http://127.0.0.1:4390/api/health",
    timeout: 30_000,
    reuseExistingServer: false,
    env: {
      ...process.env,
      CROSSAGENT_DATA_DIR: dataDir,
      CROSSAGENT_PORT: "4390",
      CROSSAGENT_DASHBOARD_DIR: resolve(root, "apps", "dashboard", "dist"),
      CROSSAGENT_LOG_LEVEL: "silent",
    },
  },
});
