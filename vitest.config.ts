import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { configDefaults, defineConfig } from "vitest/config";

/**
 * The canonical form of the machine's temp directory.
 *
 * Most fixtures here build their sandbox with `mkdtempSync(join(tmpdir(), ...))` and hand the
 * result to production code. Several of those paths are security-relevant, and the code checks
 * them: the credential store refuses a directory whose `realpath` differs from the path it was
 * configured with, because a directory that resolves elsewhere is exactly what a swapped
 * junction looks like.
 *
 * `os.tmpdir()` is whatever TEMP happens to hold, and on a GitHub Windows runner that is the 8.3
 * short form under `C:\Users\RUNNER~1`. So the fixtures were handing a non-canonical path to code
 * whose whole job is to reject one, and ten test files failed there while passing on any machine
 * whose temp directory is already canonical. Canonicalising once here fixes every fixture without
 * weakening the check being tested, and without editing 44 files.
 */
const canonicalTmpdir = realpathSync.native(tmpdir());

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "apps/dashboard/e2e/**", "output/**"],
    // Vitest's 5s default is a development-machine number. Much of this suite spawns real child
    // processes, takes real file locks and waits on real sidecars, and a GitHub Windows runner is
    // slow enough at all three that the same tests time out there while finishing in well under a
    // second here. A raised ceiling still fails a genuine hang; it just stops reporting a slower
    // machine as a broken one.
    //
    // 30s was not enough. The heaviest cases -- replaying every declared credential-rotation crash
    // point, and the version 6 migration rollback -- take 6s and 4s here and hit the 30s wall on the
    // runner, where four workers compete for four cores. The runner also reported
    // `[vitest-worker]: Timeout calling "onTaskUpdate"`, which is that same starvation seen from the
    // reporter's side. Which cases failed changed from run to run, so this is a margin problem.
    testTimeout: 90_000,
    hookTimeout: 90_000,
    // With the timeouts raised, every one of the 1249 cases passed on the runner and the job still
    // failed -- on `[vitest-worker]: Timeout calling "onTaskUpdate"`, a worker whose call to the
    // reporter went unanswered for a minute. It surfaced after the last file finished, so nothing
    // was actually wrong with a test; halving the worker count did not move it either.
    //
    // This suite loads better-sqlite3 and node-pty in almost every file. Native addons in
    // worker_threads share one process, and blocking calls in them stall the very loop that serves
    // the RPC. A forked child owns its own loop and cannot. CI pays for that in wall time, which is
    // the right trade for a signal that means something; a developer machine keeps the default.
    //
    // Forking alone did not settle it: a later run again passed all 1249 cases and still failed on
    // that same reporter call. The same configuration under CI=1 passes here, on 32 cores, in 64s.
    // So what is scarce on a four-core runner is the main process, not a worker -- it has to answer
    // every task update while two children and the real Hubs, terminals and app-servers they spawn
    // compete for the same cores. Both settings below hand it headroom: one child at a time, and a
    // reporter that appends lines instead of re-rendering a live summary on every update. Neither
    // touches what is asserted; a genuine hang still fails on the timeouts above.
    ...(process.env.CI
      ? {
          pool: "forks" as const,
          maxWorkers: 1,
          reporters: [["default", { summary: false }] as const],
        }
      : {}),
    env: {
      TMP: canonicalTmpdir,
      TEMP: canonicalTmpdir,
      TMPDIR: canonicalTmpdir,
    },
  },
});
