import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { createHubServer } from "../apps/hub/test/test-server.js";

function percentile(values: number[], value: number): number {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * value) - 1)] ?? 0;
}

const root = mkdtempSync(resolve(tmpdir(), "crossagent-benchmark-"));
const server = await createHubServer({
  dataDir: root,
  databasePath: resolve(root, "benchmark.db"),
  logLevel: "silent",
});

try {
  const joined = server.store.joinProject(server.credentials.dashboard.principal, {
    cwd: root,
    name: "benchmark",
    allowCreate: true,
  });
  const projectId = joined.project.id;
  const startingSequence = (
    server.store.sqlite
      .prepare("SELECT current_sequence AS value FROM projects WHERE id = ?")
      .get(projectId) as { value: number }
  ).value;
  const now = new Date().toISOString();
  const threadId = "thr_benchmark";
  server.store.sqlite
    .prepare(
      `INSERT INTO threads(
        id, project_id, subject, status, proposal_rounds, objection_rounds,
        version, created_at, updated_at
      ) VALUES (?, ?, ?, 'OPEN', 0, 0, 0, ?, ?)`,
    )
    .run(threadId, projectId, "benchmark search", now, now);

  const insertEvent = server.store.sqlite.prepare(
    `INSERT INTO events(
      id, project_id, sequence, type, actor_type, actor_id,
      aggregate_type, aggregate_id, payload_json, created_at
    ) VALUES (?, ?, ?, 'benchmark.event', 'system', 'benchmark',
      'benchmark', ?, '{}', ?)`,
  );
  const eventBatch = server.store.sqlite.transaction(() => {
    for (let sequence = 1; sequence <= 100_000; sequence += 1) {
      const projectSequence = startingSequence + sequence;
      insertEvent.run(
        `evt_benchmark_${sequence.toString().padStart(6, "0")}`,
        projectId,
        projectSequence,
        `row_${sequence}`,
        now,
      );
    }
    server.store.sqlite
      .prepare("UPDATE projects SET current_sequence = ? WHERE id = ?")
      .run(startingSequence + 100_000, projectId);
  });
  eventBatch();

  const insertMessage = server.store.sqlite.prepare(
    `INSERT INTO messages(
      id, project_id, sequence, thread_id, from_agent_id, type, priority,
      requires_ack, requires_response, summary, detail_json, references_json, created_at
    ) VALUES (?, ?, ?, ?, 'benchmark', 'INFORM', 'BACKGROUND', 0, 0, ?, ?, '[]', ?)`,
  );
  const messageBatch = server.store.sqlite.transaction(() => {
    for (let sequence = 1; sequence <= 10_000; sequence += 1) {
      const searchable = sequence % 50 === 0 ? "needle" : "ordinary";
      insertMessage.run(
        `msg_benchmark_${sequence.toString().padStart(5, "0")}`,
        projectId,
        sequence,
        threadId,
        `${searchable} coordination message ${sequence}`,
        JSON.stringify({ text: `${searchable} payload` }),
        now,
      );
    }
  });
  messageBatch();

  const restDurations: number[] = [];
  for (let index = 0; index < 100; index += 1) {
    const started = performance.now();
    const response = await server.app.inject({ method: "GET", url: "/api/health" });
    if (response.statusCode !== 200)
      throw new Error(`Health benchmark returned ${response.statusCode}`);
    restDurations.push(performance.now() - started);
  }

  const publishDurations: number[] = [];
  for (let index = 0; index < 1_000; index += 1) {
    const started = performance.now();
    server.bus.publish({
      id: `evt_publish_${index}`,
      projectId,
      sequence: startingSequence + 100_001 + index,
      type: "benchmark.publish",
      actorType: "system",
      actorId: "benchmark",
      aggregateType: "benchmark",
      aggregateId: String(index),
      causationId: null,
      correlationId: null,
      payload: {},
      createdAt: now,
    });
    publishDurations.push(performance.now() - started);
  }

  server.store.getOverview(projectId);
  const overviewDurations: number[] = [];
  for (let index = 0; index < 20; index += 1) {
    const started = performance.now();
    server.store.getOverview(projectId);
    overviewDurations.push(performance.now() - started);
  }

  server.store.listMessages(projectId, { search: "needle", limit: 100 });
  const searchDurations: number[] = [];
  for (let index = 0; index < 20; index += 1) {
    const started = performance.now();
    server.store.listMessages(projectId, { search: "needle", limit: 100 });
    searchDurations.push(performance.now() - started);
  }

  const result = {
    rows: { events: 100_000, messages: 10_000 },
    restP95Ms: percentile(restDurations, 0.95),
    eventPublishP95Ms: percentile(publishDurations, 0.95),
    overviewP95Ms: percentile(overviewDurations, 0.95),
    messageSearchP95Ms: percentile(searchDurations, 0.95),
    limitsMs: { rest: 100, eventPublish: 100, overview: 500, messageSearch: 500 },
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (
    result.restP95Ms >= result.limitsMs.rest ||
    result.eventPublishP95Ms >= result.limitsMs.eventPublish ||
    result.overviewP95Ms >= result.limitsMs.overview ||
    result.messageSearchP95Ms >= result.limitsMs.messageSearch
  ) {
    throw new Error("CrossAgent benchmark exceeded a required p95 threshold");
  }
} finally {
  await server.close();
  rmSync(root, { recursive: true, force: true });
}
