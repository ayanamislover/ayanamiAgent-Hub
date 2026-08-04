import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Appends one timestamped line to the channel's own log file.
 *
 * The channel kept no durable account of itself. Its only report of a failure was a line on stderr,
 * which the host that spawns this process does not persist, so a channel that gave up attaching left
 * nothing behind at all -- diagnosing one such failure took the process table, the socket table and
 * the Hub's SQLite file, because the Hub does not log requests either. The Bridge already writes to
 * ~/.crossagent/bridges/*.log; this is the same idea for the channel.
 *
 * Logging is best effort on purpose. A channel that cannot write its log must still serve its tools.
 */
export function createChannelLogger(
  path: string,
  maxBytes = 8 * 1024 * 1024,
): (line: string) => void {
  return (line: string): void => {
    try {
      mkdirSync(dirname(path), { recursive: true });
      try {
        // One generation is kept. An unrotated log on this machine reached 229MB.
        if (statSync(path).size >= maxBytes) renameSync(path, `${path}.1`);
      } catch {
        // No file yet, or another process is rotating it. Appending is still the right next step.
      }
      appendFileSync(path, `${new Date().toISOString()} ${line.trimEnd()}\n`, "utf8");
    } catch {
      // A channel that cannot write its log is still a working channel.
    }
  };
}
