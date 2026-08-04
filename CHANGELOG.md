# Changelog

Notable changes to CrossAgent Hub. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Entries are written in English only, because they name commands, files and identifiers. The user
documentation is bilingual: [README](./README.md) · [简体中文](./README.zh-CN.md).

变更条目只用英文书写，因为它们直接引用命令、文件与标识符；面向用户的文档是双语的。

## [Unreleased]

### Fixed

- `tsconfig.base.json` no longer sets `baseUrl`. TypeScript 6 reports it as deprecated and 7 removes
  it, which failed the typecheck on the TypeScript 6 upgrade; `paths` has not needed it since
  TypeScript 5.0 as long as the entries are explicitly relative.

## [0.1.0-alpha.1] - 2026-08-04

The first tagged release. The public repository starts from a clean snapshot, so this section holds
everything since that snapshot.

It is an alpha because of what
[known limitations](./docs/known-limitations.md) records rather than because the code is unfinished:
Windows is the only tested platform, Hook lifecycle capture is not yet verified end to end against a
live host application, static credential rotation is blocked, and nothing has been through a
multi-day soak. Read that page before depending on it.

### Added

- Portable `crossagent-hub-v<version>-win-x64.zip`, built by `pnpm release:package`. It unpacks and
  runs with only Node installed — no pnpm, no compiler, no network — and ships `SHA256SUMS.txt`, an
  SPDX 2.3 SBOM and a `release.json` recording the build identity and the Node ABI its native
  addons were compiled for.
- `crossagent setup .` runs the whole first-run sequence in one command: initialize, start the Hub,
  register the project, probe both CLIs, install whichever Adapter each one actually supports, run
  diagnostics and open the Dashboard. It keeps going past a step that fails when the rest is still
  worth doing, and reports what is left to do by hand.
- The Dashboard opens on a six-step first-run wizard, backed by a read-only `GET /api/onboarding`.
  Every step is recomputed from what the Hub can see rather than from a stored checklist, so it
  cannot disagree with the Agents page or claim an uninstalled Adapter is still there.
- `crossagent compatibility probe codex|claude` measures what a client's app-server actually
  supports instead of inferring it from a version string, stores the dated result under
  `~/.crossagent/compatibility/`, and `crossagent doctor` carries it into a bug report. Only a
  JSON-RPC `-32601` counts as unsupported; any other refusal is reported inconclusive.
- The Bridge watches the Codex rollout behind its thread — read latency, read timeouts and file
  size — and reports it in health. Past the point where `thread/read` stops answering it marks the
  thread for retirement, and the next launch starts a successor thread instead of resuming it.
- `@crossagent/protocol` and `@crossagent/client` are no longer private: both carry publishing
  metadata, a README and AGPL-3.0-only, so an Adapter can be written against the same schemas the
  Hub validates its own requests with.
- `docs/adapter-authoring.md` and `examples/fake-agent-adapter/`, which state the third-party
  boundary rather than implying there is none: a non-Codex, non-Claude client can register and close
  a `fake-client` session and nothing else, because heartbeat, inbox, acknowledgement and posting
  all require `hub:session`, which only a session ticket carries. The document lists the five places
  that must change to admit a third client family, and `apps/hub/test/third-party-adapter.test.ts`
  pins the closed state so it cannot drift.
- `SECURITY.md` with a private vulnerability reporting route and an explicit in-scope boundary.
- `docs/evidence/self-hosting-results.md`, holding the collaboration and review statistics with a
  provenance note naming where the numbers come from.
- Repository hygiene refuses two more classes: a credential in a URL inside any tracked Markdown,
  and this checkout's own directory or the current account's home directory appearing in a tracked
  text file.

### Changed

- The product is named CrossAgent Hub everywhere. The repository keeps the name
  `ayanamiAgent-Hub`, so clone URLs and badges still spell it that way.
- README leads with what the product is and what it looks like; the long self-hosting statistics
  moved into `docs/evidence/`.
- The Dashboard end-to-end fixture enrolls both Adapters through the real reservation, ticket-offer
  and session-registration flow instead of impersonating them, and runs against a fresh temporary
  project each time. The suite now runs in CI.

### Fixed

- `docs/protocol.md` documented a bearer token in the WebSocket URL query long after the server
  started refusing one there. Both flows — Dashboard by cookie, Agent by an `authenticate` frame
  carrying a CONTROL session ticket — are now documented as the server implements them.
- README described the Dashboard credential as `~/.crossagent/token`. It is
  `~/.crossagent/dashboard-token`; `token` is a separate bootstrap credential with only
  `project:select`.
- Static file responses lost their `Cache-Control`, `X-Content-Type-Options` and `Referrer-Policy`
  headers when `@fastify/static` 10 changed the `setHeaders` signature, and the failing request hung
  rather than erroring. Restored, and now asserted.

### Security

- Cleared all reported dependency advisories: `@fastify/static` 8 → 10,
  `@modelcontextprotocol/sdk` → 1.30, and esbuild pinned forward to the patched line through a
  workspace override.
