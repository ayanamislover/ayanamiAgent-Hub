/**
 * Summarise how much cross-checking actually happened in a Hub database.
 *
 * The interesting claim about two agents reviewing each other is not that they exchange messages;
 * it is how often the reviewer names a concrete defect in the author's work, and how often that
 * defect then gets fixed. Both are already recorded -- reviews carry an author and a reviewer, and
 * review_findings carry a severity, a category and a status -- so this only has to count.
 *
 * It reads the database read-only and prints counts. It never prints a message body, a finding
 * title, a file path or an agent's project, which is what makes the output safe to publish or to
 * paste into an issue.
 *
 *   pnpm collab:stats
 *   pnpm collab:stats -- --db /path/to/crossagent.db
 *
 * It lives under apps/hub rather than scripts/ so that it resolves the Hub's own better-sqlite3
 * -- the same native binding that wrote the file -- instead of installing a second copy of a
 * native module at the workspace root just to read it.
 */
import Database from "better-sqlite3";
import { homedir } from "node:os";
import { resolve } from "node:path";

const flag = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const databasePath = resolve(
  flag("db") ??
    process.env.CROSSAGENT_DATABASE_FILE ??
    resolve(process.env.CROSSAGENT_DATA_DIR ?? resolve(homedir(), ".crossagent"), "crossagent.db"),
);

let database: Database.Database;
try {
  database = new Database(databasePath, { readonly: true, fileMustExist: true });
} catch {
  console.error(`No Hub database at ${databasePath}. Pass --db <path>, or run crossagent start.`);
  process.exit(1);
}

type Row = Record<string, string | number | null>;
const all = <T = Row>(sql: string): T[] => database.prepare(sql).all() as T[];
const one = <T = Row>(sql: string): T => database.prepare(sql).get() as T;
const share = (part: number, whole: number): string =>
  whole === 0 ? "n/a" : `${((part / whole) * 100).toFixed(0)}%`;

const totals = one<{
  rounds: number;
  selfReviews: number;
  findings: number;
  roundsWithFindings: number;
  revisions: number;
  messages: number;
  tasks: number;
  events: number;
  days: number;
}>(`
  SELECT (SELECT COUNT(*) FROM reviews) AS rounds,
         (SELECT COUNT(*) FROM reviews WHERE author_agent_id = reviewer_agent_id) AS selfReviews,
         (SELECT COUNT(*) FROM review_findings) AS findings,
         (SELECT COUNT(DISTINCT review_id) FROM review_findings) AS roundsWithFindings,
         (SELECT COUNT(*) FROM reviews WHERE supersedes_review_id IS NOT NULL) AS revisions,
         (SELECT COUNT(*) FROM messages) AS messages,
         (SELECT COUNT(*) FROM tasks) AS tasks,
         (SELECT COUNT(*) FROM events) AS events,
         (SELECT COUNT(DISTINCT date(created_at)) FROM events) AS days
`);

if (totals.rounds === 0) {
  console.log(`No review rounds recorded in ${databasePath}. Nothing to summarise yet.`);
  process.exit(0);
}

// A "handoff" here is one review round: an author submitted work and a named reviewer looked at it.
// Self-reviews are reported separately because an agent checking itself is not cross-checking.
const crossRounds = totals.rounds - totals.selfReviews;
const roundsPerCatch =
  totals.roundsWithFindings === 0 ? 0 : crossRounds / totals.roundsWithFindings;

console.log(`CrossAgent collaboration log -- ${databasePath}`);
console.log(`  span                   ${totals.days} active days`);
console.log(`  review rounds          ${totals.rounds} (${totals.selfReviews} self-reviewed)`);
console.log(`  findings filed         ${totals.findings}`);
console.log(
  `  rounds that caught something  ${totals.roundsWithFindings} of ${crossRounds} (${share(
    totals.roundsWithFindings,
    crossRounds,
  )})`,
);
if (roundsPerCatch > 0) {
  console.log(`  -> one defect named every ${roundsPerCatch.toFixed(1)} handoffs`);
}
console.log(`  author resubmitted     ${totals.revisions} times after a review`);
console.log(
  `  volume                 ${totals.messages} messages, ${totals.tasks} tasks, ${totals.events} events`,
);

console.log("\nDirection (who reviewed whom)");
for (const row of all<{
  reviewer: string;
  author: string;
  rounds: number;
  findings: number;
  caught: number;
}>(`
  SELECT r.reviewer_agent_id AS reviewer, r.author_agent_id AS author,
         COUNT(DISTINCT r.id) AS rounds,
         COUNT(f.id) AS findings,
         COUNT(DISTINCT f.review_id) AS caught
    FROM reviews r LEFT JOIN review_findings f ON f.review_id = r.id
   WHERE r.author_agent_id <> r.reviewer_agent_id
   GROUP BY 1, 2 ORDER BY findings DESC
`)) {
  console.log(
    `  ${row.reviewer} reviewing ${row.author}: ${row.rounds} rounds, ${row.findings} findings, ` +
      `caught something in ${share(row.caught, row.rounds)}`,
  );
}

console.log("\nWhat the findings were about");
for (const row of all<{ category: string | null; n: number }>(
  `SELECT category, COUNT(*) AS n FROM review_findings GROUP BY 1 ORDER BY n DESC`,
)) {
  console.log(`  ${(row.category ?? "uncategorised").padEnd(16)} ${row.n}`);
}

console.log("\nHow severe, and what happened to them");
for (const row of all<{ severity: string | null; n: number; settled: number }>(`
  SELECT severity, COUNT(*) AS n,
         SUM(CASE WHEN status IN ('FIXED', 'VERIFIED', 'ACCEPTED', 'WONT_FIX') THEN 1 ELSE 0 END)
           AS settled
    FROM review_findings GROUP BY 1 ORDER BY n DESC
`)) {
  console.log(
    `  ${(row.severity ?? "unrated").padEnd(10)} ${String(row.n).padStart(3)} filed, ` +
      `${row.settled} settled (${share(row.settled, row.n)})`,
  );
}

// Findings left OPEN are not a failure of the reviewer -- they are work that was never closed in
// the Hub, which is worth seeing rather than hiding behind a resolution rate.
const open = one<{ n: number; blocking: number }>(`
  SELECT COUNT(*) AS n, SUM(CASE WHEN blocking = 1 THEN 1 ELSE 0 END) AS blocking
    FROM review_findings WHERE status = 'OPEN'
`);
console.log(`\n  still open: ${open.n} findings, ${open.blocking ?? 0} of them blocking`);
