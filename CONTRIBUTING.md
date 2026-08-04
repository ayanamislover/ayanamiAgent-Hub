# Contributing / 参与贡献

Thank you for looking. This is an alpha project with a small surface and a strict verification
gate, so the fastest way to get a change merged is to know what the gate checks before you push.

感谢关注。这是一个 alpha 阶段的项目，范围不大但验证门槛严格；想让改动尽快合入，最有效的办法是在推送
之前就知道这道门会检查什么。

## Before anything else: never paste a credential / 首先：不要粘贴任何凭据

Issues, pull requests and discussions are public. Do not paste the contents of anything under
`~/.crossagent/` — `token`, `dashboard-token`, `agent-*-token`, `capture-*`, `inject-*`, a session
ticket, or the database. Paths, byte lengths, HTTP status codes and the shape of an error are all
fine and are usually what actually diagnoses the problem.

`crossagent diagnostics export` writes a bundle that excludes bearer tokens, message bodies and
code diffs. It does include your local paths and environment variable values, so read it before
attaching it. Security reports do not belong in an issue at all — see [SECURITY.md](./SECURITY.md).

Issue、PR 和讨论都是公开的。不要粘贴 `~/.crossagent/` 下任何文件的内容——`token`、
`dashboard-token`、`agent-*-token`、`capture-*`、`inject-*`、session ticket 或数据库。路径、字节
长度、HTTP 状态码和报错形状都可以贴，而且通常正是定位问题的关键。

`crossagent diagnostics export` 生成的诊断包不含 bearer token、消息正文和代码 diff，但包含你的本地
路径和环境变量取值，附上之前请先看一眼。安全问题不要开 Issue，见 [SECURITY.md](./SECURITY.md)。

## Platform reality / 平台现状

Development and verification happen on Windows 10/11. The macOS and Linux branches exist in the
code but are not routinely exercised, and CI does not cover them. A fix for one of those platforms
is welcome; it needs to say which platform you tested it on, because nobody else can confirm it.

开发与验证都在 Windows 10/11 上进行。代码里有 macOS 和 Linux 分支，但没有被例行验证，CI 也不覆盖。
欢迎针对这两个平台的修复，但请写明你在哪个平台上验证过——别人没法替你确认。

## Getting set up / 环境准备

Node.js 22.13+, pnpm 11+, Git. Then:

```bash
pnpm install --frozen-lockfile
pnpm build
```

`pnpm build` is the root release builder and it is the only supported way to build. It takes a
workspace BUILD lock and hands each component the lock's pid and nonce; `pnpm -r build` reaches the
components directly and every one of them refuses. It also refuses to run while a Hub is serving
this workspace, so stop it first with `pnpm crossagent stop`.

`pnpm build` 是根级发布构建器，也是唯一受支持的构建方式。它会取得 workspace BUILD 锁，并把锁的 pid
与 nonce 传给每个组件；`pnpm -r build` 绕过它直接触达组件，每个组件都会拒绝。它同样拒绝在有 Hub 正
在服务本工作区时运行，请先 `pnpm crossagent stop`。

## What CI will check / CI 会检查什么

Run these before pushing. They are the same commands the workflow runs, in the same order.

推送前请先在本地跑一遍，和 workflow 里的命令与顺序完全一致。

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm build
pnpm test
pnpm test:e2e
```

A pull request runs exactly that far. Merging to main additionally runs `pnpm smoke:cli`,
`pnpm smoke:review` and the browser suite, plus a clean-install acceptance that installs from
scratch and starts, restarts and stops a Hub. Benchmark and dependency audit run nightly, and the
portable package is unpacked, started and restored from a backup at release. A change that only
touches `docs/` or a `.md` file runs the two checks that can still fail on prose and nothing else.

PR 只跑到上面这一步。合入 main 会额外跑 `pnpm smoke:cli`、`pnpm smoke:review`、浏览器套件，以及一次
从零安装并完成启动/重启/停止的验收。基准测试与依赖审计在 nightly 跑；便携包会在 release 时解压、启动
并从备份恢复一次。只改 `docs/` 或 `.md` 的变更只跑那两项在散文上仍可能失败的检查。

`pnpm lint` runs `scripts/repository-hygiene.mjs` before ESLint. It fails a change that:

- tracks a generated or runtime artifact (`dist/`, `output/`, `*.db`, `*.log`, …);
- declares a direct dependency nothing imports, or a workspace library nothing consumes;
- writes a no-op package script;
- documents a credential inside a URL in any tracked Markdown file;
- carries your own checkout directory or home directory into a tracked text file. Test fixtures do
  need Windows absolute paths — use a neutral one, not the machine you are sitting at;
- leaves a relative Markdown link pointing at a path that does not exist;
- writes a product version literal that disagrees with the root `package.json`;
- leaves `docs/generated/protocol-reference.md` out of date, or a JSON example in
  `docs/protocol.md` without a `<!-- schema: Name -->` annotation. Run `pnpm docs:generate` and
  commit the result whenever you add a route, an MCP tool or a command.

`pnpm lint` 会先运行 `scripts/repository-hygiene.mjs`，再运行 ESLint。以下情况会直接失败：跟踪了生成
物或运行时产物；声明了没人 import 的直接依赖，或没人使用的 workspace 库；写了空转的 package script；
在任何被跟踪的 Markdown 里把凭据写进了 URL；把你自己的 checkout 目录或 home 目录带进了被跟踪的文本
文件——测试夹具确实需要 Windows 绝对路径，请用中性路径，而不是你此刻所在的机器。

## What a good change looks like / 什么样的改动是好的

One change per pull request, with the reasoning in the commit body rather than in a review comment.
The log here reads as prose: what was wrong, why it was wrong, what the fix does, and how it was
verified. Copy that shape.

Behaviour changes need a test that fails without them. This is enforced socially, not mechanically,
but a fix with no failing case is hard to argue for — the suite has 1249 cases precisely because
past fixes brought their own.

Two rules that are not negotiable, because they are the reason the security model holds:

- A static bootstrap credential is never a data-plane fallback. If a data-plane path can reach one,
  that is the bug.
- Do not weaken a check to make CI green. If a check is wrong, change the check and say why in the
  commit; if it is right, the code is what needs fixing.

一个 PR 只做一件事，理由写在 commit 正文里，而不是留到 review 评论里。本仓库的提交记录是当作散文写
的：哪里错了、为什么错、这次改动做了什么、怎么验证的。照这个形状写就好。

行为变更需要一个「不改就会红」的测试。这一条靠自觉而非机器强制，但没有失败用例的修复很难被说服——
这套 1249 个用例的测试集，正是因为过去每个修复都自带用例才长成这样。

两条不可商量的规则，它们正是安全模型成立的原因：静态 bootstrap 凭据永远不能作为数据面回退，数据面
能摸到它本身就是 bug；不要为了让 CI 变绿而削弱检查——检查错了就改检查并在 commit 里说明理由，检查
没错就该改代码。

## Commit messages / 提交信息

`type(scope): summary` in the subject, imperative mood, then a body that explains why. Types in use:
`feat`, `fix`, `test`, `docs`, `chore`, `refactor`, `perf`.

主题行用 `type(scope): summary`，祈使语气，正文解释「为什么」。在用的 type：`feat`、`fix`、`test`、
`docs`、`chore`、`refactor`、`perf`。

## Where things live / 代码在哪

| Path                      | What                                                                           |
| ------------------------- | ------------------------------------------------------------------------------ |
| `apps/hub`                | Fastify server, REST, WebSocket, MCP tools, SQLite schema access               |
| `apps/dashboard`          | React Dashboard, plus the Playwright suite in `e2e/`                           |
| `packages/protocol`       | Zod schemas and shared types. Every wire shape starts here                     |
| `packages/client`         | Typed Hub client used by every Adapter                                         |
| `packages/codex-bridge`   | Codex app-server Adapter                                                       |
| `packages/claude-channel` | Claude Code custom Channel Adapter                                             |
| `packages/hooks`          | Claude Code hook fallback                                                      |
| `packages/cli`            | `crossagent` command, process supervision, installers                          |
| `migrations`              | Ordered SQL. Their hash is part of the build identity, so they are append-only |
| `scripts`                 | Release build and identity, hygiene, launchers, packaging                      |

Deeper reading: [architecture](docs/architecture.md), [protocol](docs/protocol.md),
[known limitations](docs/known-limitations.md), and the
[collaboration charter](docs/collaboration-charter.md) that describes how the two agents building
this project review each other.

延伸阅读见上表下方的四份文档。

## Licence / 许可

Contributions are accepted under [AGPL-3.0-only](./LICENSE), the licence this project ships under.

贡献以本项目所采用的 [AGPL-3.0-only](./LICENSE) 授权接受。
