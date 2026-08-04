/**
 * Read-only report on how the review loop actually performed.
 *
 * Lives under apps/hub so it resolves the Hub's own better-sqlite3 native build.
 * Run with `pnpm review:stats`. Prints aggregates only -- no titles, no file paths, no message
 * bodies -- so its output is safe to paste into an issue or a README.
 */
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3") as typeof import("better-sqlite3");

// Same resolution chain as the Hub itself, so pointing this at a throwaway Hub -- the `pnpm demo`
// one, say -- works with the variable that already moves the Hub, instead of silently reporting on
// the real database because only this script's own private name was understood.
const dbPath = resolve(
  process.env.CROSSAGENT_DATABASE_FILE ??
    resolve(process.env.CROSSAGENT_DATA_DIR ?? resolve(homedir(), ".crossagent"), "crossagent.db"),
);
const db = new Database(dbPath, { readonly: true });

const one = <T>(sql: string, ...args: unknown[]): T => db.prepare(sql).get(...args) as T;
const all = <T>(sql: string, ...args: unknown[]): T[] => db.prepare(sql).all(...args) as T[];

const bar = (n: number, max: number, width = 24): string =>
  "#".repeat(max === 0 ? 0 : Math.round((n / max) * width));

console.log("CrossAgent review statistics");
console.log("=".repeat(64));

const totals = one<{ reviews: number; findings: number; tasks: number }>(`
  SELECT (SELECT COUNT(*) FROM reviews)         AS reviews,
         (SELECT COUNT(*) FROM review_findings) AS findings,
         (SELECT COUNT(*) FROM tasks)           AS tasks
`);
const span = one<{ first: string; last: string }>(
  "SELECT MIN(created_at) AS first, MAX(created_at) AS last FROM reviews",
);
console.log(
  `\n${totals.reviews} reviews, ${totals.findings} findings, ${totals.tasks} tasks` +
    `\n${String(span.first).slice(0, 10)} .. ${String(span.last).slice(0, 10)}`,
);

// How many rounds a task needed before it stopped coming back.
console.log("\n\nRounds per task");
console.log("-".repeat(64));
const rounds = all<{ revisions: number; tasks: number }>(`
  SELECT revisions, COUNT(*) AS tasks FROM (
    SELECT task_id, MAX(revision) AS revisions FROM reviews WHERE task_id IS NOT NULL GROUP BY task_id
  ) GROUP BY revisions ORDER BY revisions
`);
const maxRoundTasks = Math.max(...rounds.map((r) => r.tasks), 1);
let reviewed = 0;
let weighted = 0;
for (const r of rounds) {
  reviewed += r.tasks;
  weighted += r.revisions * r.tasks;
  console.log(
    `  ${String(r.revisions).padStart(2)} round(s)  ${String(r.tasks).padStart(3)} tasks  ${bar(r.tasks, maxRoundTasks)}`,
  );
}
if (reviewed > 0) {
  console.log(`\n  mean ${(weighted / reviewed).toFixed(2)} rounds per reviewed task`);
  const firstPass = rounds.find((r) => r.revisions === 1)?.tasks ?? 0;
  console.log(
    `  ${firstPass}/${reviewed} (${Math.round((firstPass / reviewed) * 100)}%) settled in one round`,
  );
}

// Where the blocking findings came from.
console.log("\n\nFindings by severity");
console.log("-".repeat(64));
const sev = all<{ severity: string; n: number; blocking: number }>(`
  SELECT severity, COUNT(*) AS n, SUM(blocking) AS blocking
    FROM review_findings GROUP BY severity ORDER BY n DESC
`);
const maxSev = Math.max(...sev.map((s) => s.n), 1);
for (const s of sev) {
  console.log(
    `  ${String(s.severity ?? "?").padEnd(10)} ${String(s.n).padStart(3)}  blocking ${String(s.blocking ?? 0).padStart(3)}  ${bar(s.n, maxSev)}`,
  );
}

console.log("\n\nFindings by category");
console.log("-".repeat(64));
const cat = all<{ category: string; n: number; blocking: number }>(`
  SELECT COALESCE(category, '(none)') AS category, COUNT(*) AS n, SUM(blocking) AS blocking
    FROM review_findings GROUP BY category ORDER BY n DESC LIMIT 15
`);
const maxCat = Math.max(...cat.map((c) => c.n), 1);
// The blocking rate, not the count, says where to look first: a category can be the largest and
// still never block, while a small one blocks half the time.
for (const c of cat) {
  const rate = c.n === 0 ? 0 : Math.round(((c.blocking ?? 0) / c.n) * 100);
  console.log(
    `  ${c.category.slice(0, 22).padEnd(22)} ${String(c.n).padStart(3)}  blocking ${String(c.blocking ?? 0).padStart(3)} (${String(rate).padStart(3)}%)  ${bar(c.n, maxCat)}`,
  );
}

// The signal worth the most: findings the reviewer or author later withdrew.
console.log("\n\nFinding outcomes");
console.log("-".repeat(64));
const outcomes = all<{ status: string; n: number; blocking: number }>(`
  SELECT COALESCE(status, '(none)') AS status, COUNT(*) AS n, SUM(blocking) AS blocking
    FROM review_findings GROUP BY status ORDER BY n DESC
`);
const maxOut = Math.max(...outcomes.map((o) => o.n), 1);
for (const o of outcomes) {
  console.log(
    `  ${o.status.padEnd(14)} ${String(o.n).padStart(3)}  blocking ${String(o.blocking ?? 0).padStart(3)}  ${bar(o.n, maxOut)}`,
  );
}
const withdrawn = outcomes
  .filter((o) => /WONT_FIX|REJECT|WITHDRAW|INVALID|SUPERSED/i.test(o.status))
  .reduce((n, o) => n + o.n, 0);
if (totals.findings > 0) {
  console.log(
    `\n  ${withdrawn}/${totals.findings} (${Math.round((withdrawn / totals.findings) * 100)}%) did not survive as actionable`,
  );
}

// Review verdicts, and how much of the corpus never reached one.
console.log("\n\nReview status");
console.log("-".repeat(64));
const statuses = all<{ status: string; n: number }>(`
  SELECT COALESCE(status, '(none)') AS status, COUNT(*) AS n
    FROM reviews GROUP BY status ORDER BY n DESC
`);
const maxStatus = Math.max(...statuses.map((s) => s.n), 1);
for (const s of statuses) {
  console.log(`  ${s.status.padEnd(20)} ${String(s.n).padStart(3)}  ${bar(s.n, maxStatus)}`);
}

// Reviews that produced nothing are the ones to aim at: they cost a full pass.
const empty = one<{ n: number }>(`
  SELECT COUNT(*) AS n FROM reviews r
   WHERE NOT EXISTS (SELECT 1 FROM review_findings f WHERE f.review_id = r.id)
`);
console.log(
  `\n  ${empty.n}/${totals.reviews} (${Math.round((empty.n / Math.max(totals.reviews, 1)) * 100)}%) reviews produced no finding at all`,
);

// Review size vs. yield: does reviewing more files find more?
console.log("\n\nYield by review size");
console.log("-".repeat(64));
const buckets = all<{
  bucket: string;
  reviews: number;
  files: number;
  findings: number;
  blocking: number;
}>(`
  SELECT CASE
           WHEN files <=  5 THEN 'a| 1-5'
           WHEN files <= 20 THEN 'b| 6-20'
           WHEN files <= 50 THEN 'c|21-50'
           ELSE                  'd|50+'
         END AS bucket,
         COUNT(*) AS reviews, SUM(files) AS files, SUM(n) AS findings, SUM(b) AS blocking
    FROM (
      SELECT r.id,
             COALESCE(json_array_length(r.changed_files_json), 0) AS files,
             (SELECT COUNT(*) FROM review_findings f WHERE f.review_id = r.id) AS n,
             (SELECT COALESCE(SUM(f.blocking), 0) FROM review_findings f WHERE f.review_id = r.id) AS b
        FROM reviews r
    ) GROUP BY bucket ORDER BY bucket
`);
// Two different numbers. Per review is what a reviewer produces in one pass, and it stays flat
// across every bucket -- attention is spent per pass, not per file. Per file is therefore what the
// pass cost, and it is the one that collapses as reviews get bigger.
for (const b of buckets) {
  const label = b.bucket.split("|")[1] ?? b.bucket;
  const perReview = b.reviews === 0 ? 0 : b.findings / b.reviews;
  const perFile = b.files === 0 ? 0 : b.findings / b.files;
  console.log(
    `  ${`${label} files`.padEnd(13)} ${String(b.reviews).padStart(3)} reviews  ` +
      `${String(b.files).padStart(4)} files  ${String(b.findings).padStart(3)} findings ` +
      `(${perReview.toFixed(1)}/review, ${perFile.toFixed(3)}/file)  ${String(b.blocking).padStart(2)} blocking`,
  );
}
const densest = buckets.reduce(
  (best, b) =>
    b.files > 0 && b.findings / b.files > best.rate ? { rate: b.findings / b.files, b } : best,
  { rate: 0, b: buckets[0] },
);
const thinnest = buckets.reduce(
  (worst, b) =>
    b.files > 0 && b.findings / b.files < worst.rate ? { rate: b.findings / b.files, b } : worst,
  { rate: Number.POSITIVE_INFINITY, b: buckets[0] },
);
if (densest.b && thinnest.b && thinnest.rate > 0 && densest.b !== thinnest.b) {
  console.log(
    `\n  a file in the ${densest.b.bucket.split("|")[1]?.trim()} bucket gets ` +
      `${Math.round(densest.rate / thinnest.rate)}x the scrutiny of one in the ` +
      `${thinnest.b.bucket.split("|")[1]?.trim()} bucket`,
  );
}

console.log("");
db.close();
