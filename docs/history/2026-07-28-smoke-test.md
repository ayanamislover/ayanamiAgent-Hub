# Historical Smoke Test Record — 2026-07-28

> Historical record. Measurements and capability notes below describe the dated initial release,
> not the current runtime. Screenshots were disposable local evidence below ignored `output/` and
> are intentionally not retained in Git.

Date: 2026-07-28
Platform: Windows, Node 24.14.1, pnpm 11.9.0, Git 2.55.0.windows.3, Codex CLI 0.145.0

## Automated contract coverage

- Protocol state machine, progress and secret redaction unit tests.
- Hub REST authorization, one-time Dashboard cookie exchange, atomic task claim, message delivery/ACK, write-intent conflict, WebSocket replay and exact 16-tool MCP contract.
- Codex JSONL app-server contract: initialize, initialized notification, thread start, turn start, item injection and safe steer.
- Claude stdio MCP Channel initialization, advertised experimental capability and explicit ACK tools.
- Hook installer idempotency and lifecycle fail-open behavior.
- CLI PID, project initialization and consistent backup/restore lifecycle.
- Dashboard eight-page browser E2E at 3440×1440 and 1920×1080.
- Headed Chromium confirmed two ONLINE sessions, native delivery capability labels, a real overlapping write-intent conflict, a live WebSocket indicator, all eight routes, the task inspector, and no horizontal viewport overflow.
- A committed-head review smoke produced a SHA-256 verified immutable patch, rejected approval with an open blocking finding (HTTP 409), accepted author FIXED plus reviewer VERIFIED evidence, then deterministically moved the review to APPROVED and the task to DONE at 100%.
- The installed Codex CLI live app-server returned seven models, accepted initialize plus thread/start, and registered through the real Bridge as `codex-app-server` / `app_server_push` with steer and inject capabilities.
- The production CLI started Hub + Dashboard on port 4391, wrote a PID, returned healthy SQLite WAL/WebSocket/MCP status, stopped cleanly, removed its PID record, and reported `running: false`.

## Performance fixture

The repeatable local benchmark loaded 100,000 events and 10,000 FTS-indexed messages:

| Check            | Measured p95 | Required |
| ---------------- | -----------: | -------: |
| REST health      |     0.217 ms | < 100 ms |
| EventBus publish |     0.001 ms | < 100 ms |
| Project overview |     0.286 ms | < 500 ms |
| Message search   |     2.713 ms | < 500 ms |

## Live capability notes

- Codex CLI was present and the adapter protocol was tested against both a deterministic fake app-server and a live local app-server/Bridge session.
- Claude executable was not present on this machine. Native Claude Channel live launch therefore cannot be claimed; the in-memory MCP contract and hooks fallback are covered, and runtime capability status remains honest.

The release-gate results above are the final recorded run for this dated snapshot. Re-run the
current repository gates rather than treating these measurements as present-day evidence.
