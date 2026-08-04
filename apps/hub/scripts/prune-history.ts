/**
 * Trims the bookkeeping tables that grow without bound, archiving every row it removes.
 *
 * Lives under apps/hub so it resolves the Hub's own better-sqlite3 native build.
 * Dry-run by default: it reports what it would delete and writes nothing until `--apply`.
 *
 *   pnpm prune:history                    # dry run, current stored window
 *   pnpm prune:history -- --days=90       # dry run, preview a 90-day window
 *   pnpm prune:history -- --days=90 --apply
 *
 * `--days` is the retention window for everything here, including `events`. In apply mode it is
 * stored in `event_retention_policy`, which is what the database itself enforces: migration 0015
 * lets an event be deleted only once it is older than the stored window, so a caller cannot reach
 * past it by passing a larger number here. Dry runs preview a window without storing it.
 *
 * What it deliberately never touches:
 *   tasks, reviews, review_findings, messages -- a few hundred rows in total, and the entire
 *     basis for `pnpm review:stats`. Deleting them to save a rounding error of disk would be a
 *     bad trade.
 *   any event another table is standing on -- authority_events, delegation_events,
 *     message_surface_handoffs and the directive tables all pin their event with ON DELETE
 *     RESTRICT. Those rows are excluded by name rather than left to abort the run.
 */
import { createRequire } from "node:module";
import { closeSync, fsyncSync, mkdirSync, openSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3") as typeof import("better-sqlite3");

/** The windows migration 0015 accepts. A free-form number invites "--days=1" on nobody's backup. */
const ALLOWED_DAYS = [7, 14, 30, 90, 180, 365] as const;
const DEFAULT_DAYS = 30;

const arg = (name: string): string | undefined =>
  process.argv
    .find((a) => a.startsWith(`--${name}=`))
    ?.split("=")
    .slice(1)
    .join("=");

const apply = process.argv.includes("--apply");

// Same resolution chain as the Hub itself. This one deletes, so understanding only a private name
// was the worse half of the bug: `CROSSAGENT_DATA_DIR=output/demo pnpm prune:history --apply` reads
// as pruning the demo and would have pruned the real database.
const dbPath = resolve(
  process.env.CROSSAGENT_DATABASE_FILE ??
    resolve(process.env.CROSSAGENT_DATA_DIR ?? resolve(homedir(), ".crossagent"), "crossagent.db"),
);
const db = new Database(dbPath, { readonly: !apply });

if (
  !db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'event_retention_policy'")
    .get()
) {
  console.error(
    `${dbPath} predates migration 0015, which owns the retention window.\n` +
      `Start the Hub once to migrate it, then run this again.`,
  );
  process.exit(2);
}

const storedDays = db.prepare("SELECT days FROM event_retention_policy WHERE id = 1").pluck().get();
const days = Number(arg("days") ?? storedDays ?? DEFAULT_DAYS);
if (!ALLOWED_DAYS.includes(days as (typeof ALLOWED_DAYS)[number])) {
  console.error(
    `--days must be one of ${ALLOWED_DAYS.join(", ")}; got ${arg("days")}.\n` +
      `These are the retention windows this project supports; pick the closest one.`,
  );
  process.exit(2);
}

const stamp = new Date().toISOString().replaceAll(/[:.]/gu, "-");
const archivePath = resolve(
  arg("archive") ?? resolve(process.cwd(), `output/history-archive-${stamp}.jsonl`),
);
const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();

/**
 * Every event a live table pins, discovered rather than listed, so a table added later cannot be
 * forgotten here. Each foreign key contributes one NOT EXISTS; composite keys join their columns.
 */
function eventReferenceGuards(): string {
  type ForeignKey = { id: number; table: string; from: string; to: string | null };
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .pluck()
    .all() as string[];
  const guards: string[] = [];
  for (const table of tables) {
    const grouped = new Map<number, ForeignKey[]>();
    for (const key of db.pragma(`foreign_key_list("${table}")`) as ForeignKey[]) {
      if (key.table !== "events") continue;
      grouped.set(key.id, [...(grouped.get(key.id) ?? []), key]);
    }
    for (const columns of grouped.values()) {
      const join = columns
        .map((column) => `child."${column.from}" IS e."${column.to ?? "id"}"`)
        .join(" AND ");
      guards.push(`NOT EXISTS (SELECT 1 FROM "${table}" child WHERE ${join})`);
    }
  }
  return guards.length > 0 ? guards.join("\n     AND ") : "1 = 1";
}

const eventsWhere = `e.created_at < ?\n     AND ${eventReferenceGuards()}`;

/** Each table names the column that decides age, so a wrong column cannot silently match nothing. */
const PLAN = [
  {
    table: "session_heartbeats",
    what: "presence telemetry",
    count: 'SELECT COUNT(*) AS n FROM "session_heartbeats" e WHERE e.received_at < ?',
    select: 'SELECT e.* FROM "session_heartbeats" e WHERE e.received_at < ?',
    remove: 'DELETE FROM "session_heartbeats" WHERE received_at < ?',
  },
  {
    // Measured on a six-day-old database: 42,921 rows, every one with expires_at NULL. Nothing
    // expires these; the window is the only thing that ever removes them.
    table: "idempotency_keys",
    what: "replay guards, which nothing else expires",
    count: 'SELECT COUNT(*) AS n FROM "idempotency_keys" e WHERE e.created_at < ?',
    select: 'SELECT e.* FROM "idempotency_keys" e WHERE e.created_at < ?',
    remove: 'DELETE FROM "idempotency_keys" WHERE created_at < ?',
  },
  {
    table: "events",
    what: "append-only log, minus anything another table pins",
    count: `SELECT COUNT(*) AS n FROM "events" e WHERE ${eventsWhere}`,
    select: `SELECT e.* FROM "events" e WHERE ${eventsWhere}`,
    remove: `DELETE FROM "events" WHERE id IN (SELECT e.id FROM "events" e WHERE ${eventsWhere})`,
  },
] as const;

console.log(`database  ${dbPath}`);
console.log(
  `window    ${days} days  (cutoff ${cutoff.slice(0, 19)}Z)` +
    `${storedDays === undefined ? "  -- no stored policy" : `  stored ${storedDays}`}`,
);
console.log(
  `mode      ${apply ? "APPLY -- rows will be deleted" : "dry run -- nothing is written"}`,
);
console.log("");

let totalStale = 0;
for (const { table, what, count } of PLAN) {
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n;
  const stale = (db.prepare(count).get(cutoff) as { n: number }).n;
  totalStale += stale;
  console.log(
    `  ${table.padEnd(20)} ${String(total).padStart(7)} rows  ->  remove ${String(stale).padStart(7)}, keep ${String(total - stale).padStart(7)}   (${what})`,
  );
}

const pinned = (
  db.prepare(`SELECT COUNT(*) AS n FROM "events" e WHERE e.created_at < ?`).get(cutoff) as {
    n: number;
  }
).n;
const prunable = (db.prepare(PLAN[2].count).get(cutoff) as { n: number }).n;
if (pinned > prunable) {
  console.log(
    `  ${" ".repeat(20)} ${String(pinned - prunable).padStart(7)} stale events retained: another table references them`,
  );
}

const preserved = ["tasks", "reviews", "review_findings", "messages"]
  .map((t) => `${t} ${(db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get() as { n: number }).n}`)
  .join(", ");
console.log(`\n  kept whole for analysis: ${preserved}`);

if (!apply) {
  console.log(`\nDry run. Re-run with --apply to delete, or --days=<${ALLOWED_DAYS.join("|")}>.`);
  db.close();
  process.exit(0);
}

// The window becomes the database's rule before anything is deleted under it, so the stored policy
// can never be looser than the run that just happened.
db.prepare(
  `INSERT INTO event_retention_policy (id, days, updated_at) VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET days = excluded.days, updated_at = excluded.updated_at`,
).run(days, new Date().toISOString());
console.log(`\nretention policy stored: ${days} days`);

if (totalStale === 0) {
  console.log("Nothing older than the window. No rows removed.");
  db.close();
  process.exit(0);
}

// Archive first, delete second, and only inside one transaction: a crash mid-way must not leave
// rows deleted with no archive of them. Streamed because events alone can reach six figures.
mkdirSync(dirname(archivePath), { recursive: true });
const archive = openSync(archivePath, "w");
let archived = 0;
try {
  for (const { table, select } of PLAN) {
    let batch = "";
    for (const row of db.prepare(select).iterate(cutoff)) {
      batch += `${JSON.stringify({ table, row })}\n`;
      archived += 1;
      if (batch.length > 1_000_000) {
        writeSync(archive, batch);
        batch = "";
      }
    }
    if (batch.length > 0) writeSync(archive, batch);
  }
  fsyncSync(archive);
} finally {
  closeSync(archive);
}
console.log(`archived ${archived} rows -> ${archivePath}`);

const removed = db.transaction(() => {
  let n = 0;
  for (const { remove } of PLAN) n += db.prepare(remove).run(cutoff).changes;
  return n;
})();

console.log(`deleted  ${removed} rows`);
db.exec("VACUUM");
console.log("vacuumed");
db.close();
