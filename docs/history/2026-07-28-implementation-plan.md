# Historical Implementation Plan — 2026-07-28

> Historical record. This plan describes the initial build and is not the current backlog or
> capability status. Current work is tracked in CrossAgent tasks and `agents_task.md`.

This plan follows vertical slices. Each phase ends in a runnable product state and reruns lint, typecheck, unit tests, integration tests, and relevant documentation checks.

## Environment baseline

Verified on 2026-07-28:

- Node.js 24.14.1
- npm/npx 11.11.0
- pnpm 11.9.0
- Git 2.55.0.windows.3
- Codex CLI 0.145.0
- Claude CLI not currently present on `PATH`

The implementation must therefore pass a real Codex app-server smoke test on this machine. Claude Channel gets a real stdio MCP contract test and an installation probe; an authenticated live Claude session is attempted at final validation but may remain environment-blocked. The UI must show the resulting delivery mode honestly.

## Phase 1 — Hub foundation

- workspace, protocol package, config loader;
- SQLite migration runner and WAL pragmas;
- project/path, agent/session, heartbeat, message, recipient, event tables;
- join, health, session, message, ACK REST APIs;
- WebSocket gap replay and bounded queues;
- initial health Dashboard;
- fake-client integration test.

## Phase 2 — objectives and work

- objective, milestone, task, dependency, TODO schema and services;
- deterministic state transitions and weighted progress;
- optimistic concurrency, atomic claims, stale claims, release, handoff;
- objective/task endpoints and task board UI.

## Phase 3 — communication efficiency

- threads, decisions, dedupe/coalescing, delivery attempts;
- deterministic priority policy and Context Pack;
- inbox/search and communication UI.

## Phase 4 — Codex

- JSONL app-server client and generated-schema capability probe;
- thread/session mapping and reconnect;
- turn/item/command/file/review event mapping;
- steer/inject/wake policy;
- Codex lifecycle hooks fallback;
- fake app-server contract suite and live app-server smoke.

## Phase 5 — Claude

- stdio MCP Channel with `claude/channel`;
- Hub WebSocket queue, dedupe cursor, ACK/processed/reply tools;
- hooks fallback and installer;
- fake MCP client contract test;
- live CLI probe when an authenticated Claude executable is available.

## Phase 6 — Git and reviews

- write intent overlap and protected-scope classification;
- observed changed-file reconciliation;
- immutable committed/uncommitted review bundles;
- patch hashing, test evidence, findings, revisions and approval gate;
- isolated detached review worktree lifecycle.

## Phase 7 — complete Dashboard

- Overview, Tasks, Communications, Reviews, Agents, Conflicts, Audit, Settings;
- 3440×1440 three-column control room and 16:9 adaptation;
- real WebSocket updates, stale-data state, filters, drawers and forms;
- dark-first, icon plus color state coding, relative/absolute timestamps;
- loading, empty, error and offline states.

## Phase 8 — release readiness

- CLI start/stop/status/open/doctor/diagnostics;
- backup/restore/migration backup/stale PID cleanup;
- security and path traversal tests;
- 100k-event and 10k-message bounded benchmarks;
- cross-platform install scripts and troubleshooting;
- build, lint, typecheck, unit, integration, contract and Playwright E2E;
- real headed-browser acceptance at 3440×1440 and 1920×1080.

## Completion evidence

The final smoke record must list exact commands, exit codes, version probes, tested adapter capabilities, browser viewport results, and any environmental blocker. A missing Claude executable or account authorization cannot be reported as a passed native Channel smoke; the fallback mode remains functional and visible instead.
