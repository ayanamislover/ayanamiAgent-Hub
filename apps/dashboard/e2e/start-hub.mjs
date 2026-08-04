import { rmSync } from "node:fs";

/**
 * Starts the Hub the suite runs against, from an empty data directory.
 *
 * The fixture enrolls its Adapters with fixed launcher run ids, so a second run against a surviving
 * database is refused with SESSION_LAUNCH_RUN_CONFLICT — the Hub correctly protecting a logical
 * session the previous run left behind. CI never saw it, because a fresh workspace is a fresh
 * directory; locally it made the suite runnable exactly once.
 *
 * The delete belongs here rather than in the Playwright config, which every worker re-evaluates
 * while the Hub already holds the database open, or in globalSetup, which only runs afterwards.
 * The Hub is imported rather than spawned so it stays this process, and Playwright's own teardown
 * keeps working.
 */
rmSync(process.env.CROSSAGENT_DATA_DIR ?? "", { recursive: true, force: true });
await import("../../hub/dist/main.js");
