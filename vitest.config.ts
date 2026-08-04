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
    testTimeout: 30_000,
    hookTimeout: 30_000,
    env: {
      TMP: canonicalTmpdir,
      TEMP: canonicalTmpdir,
      TMPDIR: canonicalTmpdir,
    },
  },
});
