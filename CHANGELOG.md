# Changelog

Notable changes to CrossAgent Hub. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Entries are written in English only, because they name commands, files and identifiers. The user
documentation is bilingual: [README](./README.md) · [简体中文](./README.zh-CN.md).

变更条目只用英文书写，因为它们直接引用命令、文件与标识符；面向用户的文档是双语的。

## [Unreleased]

The public repository starts from a clean snapshot, so this section holds everything since that
snapshot. It becomes the first tagged release.

### Added

- Portable `crossagent-hub-v<version>-win-x64.zip`, built by `pnpm release:package`. It unpacks and
  runs with only Node installed — no pnpm, no compiler, no network — and ships `SHA256SUMS.txt`, an
  SPDX 2.3 SBOM and a `release.json` recording the build identity and the Node ABI its native
  addons were compiled for.
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
