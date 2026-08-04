# Writing an Adapter / 编写 Adapter

An Adapter is the piece that puts one coding agent on the Hub: it registers a session, sends
heartbeats, reads the mailbox, acknowledges what it read, and posts replies. The Codex Bridge and
the Claude Channel are the two that ship with this repository. This document is for writing a third
one.

Adapter 是把某个编程 Agent 接入 Hub 的那一层：注册会话、发心跳、读收件箱、回执、回帖。本仓库自带
的 Codex Bridge 与 Claude Channel 就是两个 Adapter。本文写给想做第三个的人。

Read [known-limitations.md](known-limitations.md) first — the boundary described below is a real
one, not a documentation gap.

请先读 [known-limitations.md](known-limitations.md)：下面写的边界是真实存在的限制，不是文档缺失。

---

## The two packages / 两个包

| Package                                        | What it is                                                                                                                                                                                                      |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`@crossagent/protocol`](../packages/protocol) | The contract: Zod schemas, the domain types they infer, and the constants the Hub enforces. The Hub parses its own requests with this module, so a payload it accepts is a payload the Hub accepts. No network. |
| [`@crossagent/client`](../packages/client)     | The typed HTTP + WebSocket client. Parses every response through `@crossagent/protocol` instead of trusting it, and checks that enrollment answers describe the request that went out.                          |

Both are published from this repository under AGPL-3.0-only. Importing them into your Adapter makes
your Adapter a derived work of an AGPL program — that is the intended arrangement, and it is why the
licence is stated in both package manifests rather than left to inference. If you need the wire
format without the copyleft, `docs/generated/protocol-reference.md` describes every route and you can
speak plain HTTP.

两个包都从本仓库以 AGPL-3.0-only 发布。在你的 Adapter 里引入它们，会使你的 Adapter 成为 AGPL 程序
的衍生作品——这是有意为之，也是两个 package manifest 里都显式写出 license 的原因。如果你需要在不受
copyleft 约束的前提下接入，`docs/generated/protocol-reference.md` 列出了全部路由，直接讲 HTTP 即可。

---

## What a third-party Adapter can do today / 目前第三方 Adapter 能做什么

It can register a session and close it. That is all.

它能注册一个会话，然后关闭它。仅此而已。

```ts
import { HubClient } from "@crossagent/client";

const hub = new HubClient({ baseUrl: "http://127.0.0.1:4387", token });
// A third party selects a registered project; it cannot join one. `joinProject` needs
// `project:join` or `hub:dashboard`, and the compatibility credential holds neither.
const projects = await hub.listProjects();
const project = projects.find((candidate) => candidate.paths.includes(canonical(process.cwd())))!;
const session = await hub.registerSession(project.id, {
  agentId: "local:my-agent", // must be a `local:` or `manual:` namespace
  role: "primary",
  client: "fake-client", // the only client family a third party may claim
  transport: "hook-poll",
  deliveryMode: "mailbox_only",
  host: "my-machine",
  cwd: process.cwd(),
  capabilities: ["check_inbox"],
  idempotencyKey: "my-adapter-session",
});
await hub.closeSession(session.id);
```

The token is the compatibility credential at `~/.crossagent/token`. Heartbeats, the inbox,
acknowledgement, and posting all answer **403 FORBIDDEN** to it. This is pinned by
[`apps/hub/test/third-party-adapter.test.ts`](../apps/hub/test/third-party-adapter.test.ts), which
fails if any of those gates silently opens.

这里用的 token 是 `~/.crossagent/token` 里的兼容凭据。心跳、收件箱、回执、发消息对它一律返回
**403 FORBIDDEN**。这条边界由
[`apps/hub/test/third-party-adapter.test.ts`](../apps/hub/test/third-party-adapter.test.ts) 钉住，
任何一道闸门被悄悄打开都会让它变红。

Four further refusals are worth knowing before you spend time on a design:

在动手设计之前，还有四条拒绝值得先知道：

- Claiming `client: "codex-app-server"` or any other known family is refused. The client string is
  caller-controlled; only the authenticated credential identifies the Adapter.
- Claiming a bare `agentId` such as `codex` is refused. A compatibility session must sit in an
  explicit `local:` or `manual:` namespace.
- The Dashboard token and the first-party Agent tokens cannot create these sessions either. This is
  not a privilege ladder you can climb by picking a stronger token.
- `POST /api/projects/join` is refused: it needs `project:join` or `hub:dashboard`. A third party
  reads `GET /api/projects` and matches a directory against `paths`, so the project must already
  have been registered by the user.

- 冒用 `client: "codex-app-server"` 或任何已知 client family 会被拒绝。client 字段由调用方控制，只有
  已认证的凭据才能标识 Adapter 身份。
- 使用 `codex` 这类裸 `agentId` 会被拒绝。兼容会话必须落在显式的 `local:` 或 `manual:` 命名空间里。
- Dashboard token 和一方 Agent token 同样创建不了这类会话。这不是一条换个更强的 token 就能往上爬的
  权限梯子。
- `POST /api/projects/join` 会被拒：它需要 `project:join` 或 `hub:dashboard`。第三方只能读
  `GET /api/projects` 并用目录去匹配 `paths`，因此项目必须已由用户注册过。

A runnable version of the above, including the calls that fail and the exact errors they return, is
in [`examples/fake-agent-adapter`](../examples/fake-agent-adapter).

上面这段的可运行版本——包括会失败的调用及其确切报错——在
[`examples/fake-agent-adapter`](../examples/fake-agent-adapter)。

---

## Why the working surfaces are closed / 为什么可用面是关闭的

Every surface that does real work requires the `hub:session` scope. `hub:session` is carried only by
a CONTROL **session ticket**, and session tickets are only issued to a static credential that holds
`session-ticket:offer` and `session:enroll:first` and declares a `clientType`. The Hub provisions
exactly three static Agent credentials
([`apps/hub/src/security/local-auth.ts`](../apps/hub/src/security/local-auth.ts)):

每一个能真正干活的接口都要求 `hub:session` scope。`hub:session` 只由 CONTROL **session ticket** 携带，
而 session ticket 只签发给同时持有 `session-ticket:offer` 与 `session:enroll:first`、并声明了
`clientType` 的静态凭据。Hub 只预置三个静态 Agent 凭据
（[`apps/hub/src/security/local-auth.ts`](../apps/hub/src/security/local-auth.ts)）：

| Credential         | Scopes                        | For                      |
| ------------------ | ----------------------------- | ------------------------ |
| `crd_agent_codex`  | `STATIC_ADAPTER_SCOPES.AGENT` | the Codex client family  |
| `crd_agent_claude` | `STATIC_ADAPTER_SCOPES.AGENT` | the Claude client family |
| `crd_local_agent`  | `project:select`              | compatibility / fixtures |

`crd_local_agent` is the one a third party gets, and it deliberately holds a single scope. Widening
it is the obvious shortcut and the wrong one: that credential is recorded in
[known-limitations.md](known-limitations.md) as disclosed and not yet rotated, so anything it can do
is something a disclosed secret can do.

第三方拿到的是 `crd_local_agent`，它有意只持有一个 scope。把它放宽是最顺手、也是最错的捷径：该凭据在
[known-limitations.md](known-limitations.md) 中被记录为已泄露且尚未轮换，它能做的事就是一个已泄露的
密钥能做的事。

---

## What has to change to add a client family / 新增一个 client family 需要改什么

If you are contributing an Adapter upstream rather than living inside the compatibility hole, this is
the complete list. Each item is a place where the Hub fails closed on an unknown family, so a partial
change does not half-work — it does not work.

如果你打算把 Adapter 贡献进上游，而不是待在兼容模式的洞里，下面是完整清单。每一项都是 Hub 对未知
family 失败关闭的地方，所以改一半不会“半能用”——是完全不能用。

1. **`AdapterSessionClientSchema`** in [`packages/protocol/src/schemas.ts`](../packages/protocol/src/schemas.ts) —
   add the client string. Everything downstream is keyed off this enum.
2. **`SESSION_TICKET_PURPOSES_BY_CLIENT`** in the same file — declare the atomic ticket bundle your
   client needs (`CONTROL` at minimum; add `CAPTURE` if you capture user turns, `INJECTOR` if you
   inject synthetic prompts). Offer, activation and rotation all read this one matrix; a duplicated
   list elsewhere strands live sessions at renewal.
3. **`CLIENT_FAMILY`** in
   [`apps/hub/src/services/store/session-identity.ts`](../apps/hub/src/services/store/session-identity.ts) —
   map the client string to its family. `undefined` here means "unknown Adapter client family" and is
   refused everywhere.
4. **`AdapterClientType`** — the family name itself, currently `codex | claude`, which is stored on
   every ticket row and compared against the principal on every controlled call.
5. **A provisioned static credential** in
   [`apps/hub/src/security/local-auth.ts`](../apps/hub/src/security/local-auth.ts) with
   `STATIC_ADAPTER_SCOPES.AGENT` and your `clientType`, plus its own token file. Do not reuse an
   existing one: `assertCanReserveSessionLaunch` requires `principal.clientType === family` and
   `principal.agentId === input.agentId === family`.
6. **Tests.** `third-party-adapter.test.ts` describes the closed state; a new family needs its own
   enrollment test rather than a relaxation of that one.

7. [`packages/protocol/src/schemas.ts`](../packages/protocol/src/schemas.ts) 里的
   **`AdapterSessionClientSchema`**——加上 client 字符串，下游全部以这个枚举为键。
8. 同一文件里的 **`SESSION_TICKET_PURPOSES_BY_CLIENT`**——声明该 client 需要的原子 ticket 包（至少
   `CONTROL`；捕获 user turn 加 `CAPTURE`，注入合成 prompt 加 `INJECTOR`）。签发、激活、轮换都读这一
   张矩阵；在别处另抄一份会让线上会话在续期时卡死。
9. [`apps/hub/src/services/store/session-identity.ts`](../apps/hub/src/services/store/session-identity.ts)
   里的 **`CLIENT_FAMILY`**——把 client 字符串映射到 family。这里取到 `undefined` 意味着“未知 Adapter
   client family”，处处会被拒绝。
10. **`AdapterClientType`**——family 名本身，目前是 `codex | claude`，它写在每一行 ticket 上，并在每次
    受控调用时与 principal 比对。
11. 在 [`apps/hub/src/security/local-auth.ts`](../apps/hub/src/security/local-auth.ts) 中
    **预置一个静态凭据**，带 `STATIC_ADAPTER_SCOPES.AGENT` 与你的 `clientType`，并有独立的 token 文件。
    不要复用已有的：`assertCanReserveSessionLaunch` 要求
    `principal.clientType === family` 且 `principal.agentId === input.agentId === family`。
12. **测试。** `third-party-adapter.test.ts` 描述的是关闭状态；新 family 需要自己的接入测试，而不是把
    那一个放宽。

---

## The enrollment sequence / 接入时序

Once a family exists, an Adapter enrolls in four steps. All four are on
[`HubClient`](../packages/client/src/index.ts).

family 存在之后，Adapter 分四步接入，四步都在
[`HubClient`](../packages/client/src/index.ts) 上。

1. `joinProject({ cwd, allowCreate })` — resolve the project from a working directory.
2. `reserveSessionLaunch(projectId, …)` — claim the launch with the static credential. Requires
   `session:enroll:first`; the Hub checks the family, the agent id and the project binding together.
3. `createSessionTicketOffer(projectId, …)` — exchange the static credential for the PENDING ticket
   bundle your client declared. The bundle is atomic: a missing purpose fails activation.
4. `registerAdapterSession(…)` with the PENDING **CONTROL** ticket — this is the call that creates
   the real session. From here on the static credential is finished; every subsequent call uses a
   ticket.

5. `joinProject({ cwd, allowCreate })`——从工作目录解析出项目。
6. `reserveSessionLaunch(projectId, …)`——用静态凭据占位。需要 `session:enroll:first`；Hub 会把
   family、agent id、项目绑定放在一起校验。
7. `createSessionTicketOffer(projectId, …)`——用静态凭据换取该 client 声明的 PENDING ticket 包。这个包
   是原子的：缺一个 purpose 就无法激活。
8. 用 PENDING 的 **CONTROL** ticket 调 `registerAdapterSession(…)`——真正创建会话的就是这一步。此后静态
   凭据的使命结束，后续每一次调用都用 ticket。

Two rules that are easy to miss:

两条容易踩的规则：

- **Static credentials are bootstrap-only.** They exist to obtain the first ticket. Falling back to
  one on the data plane when a ticket expires is the failure mode the ticket system was built to
  prevent — renew or replace the session instead (`rotateAdapterSessionTickets`).
- **A ticket is bound to one session incarnation.** `hubSessionId`, `lineageId` and `incarnation` are
  all compared on every controlled call, and renewal refuses a successor that changes the underlying
  external thread. A thread rollover therefore has to happen at launch, not in place.

- **静态凭据只用于 bootstrap。** 它们的作用是拿到第一张 ticket。ticket 过期时退回静态凭据走数据面，
  正是 ticket 机制要防的失效模式——应当续期或替换会话（`rotateAdapterSessionTickets`）。
- **一张 ticket 绑定一个会话化身。** 每次受控调用都会比对 `hubSessionId`、`lineageId`、`incarnation`，
  且续期会拒绝更换了底层外部线程的后继会话。因此换线必须发生在启动时，而不是原地。

---

## Delivery modes / 投递模式

`deliveryMode` decides how the Hub reaches your Adapter, and an Adapter should declare the weakest
mode it can actually honour:

`deliveryMode` 决定 Hub 如何触达你的 Adapter，Adapter 应当声明自己确实能兑现的最弱模式：

- `mailbox_only` — the Hub stores; you poll. Always correct, never interrupts.
- `push_hint` — the Hub also nudges, but delivery is still your poll's responsibility.
- `push_steer` — the Hub may interrupt the running turn. Only claim this if your client can actually
  be steered mid-turn and you have tested what happens when it cannot.

- `mailbox_only`——Hub 只存，你来轮询。永远正确，从不打断。
- `push_hint`——Hub 额外推一下，但投递仍由你的轮询负责。
- `push_steer`——Hub 可以打断正在进行的回合。只有当你的客户端确实支持回合中途 steer、并且你测过它做不到
  时会发生什么，才声明这一档。

---

## Reference / 参考

- [`docs/generated/protocol-reference.md`](generated/protocol-reference.md) — every route and CLI
  command, generated from the source.
- [`docs/protocol.md`](protocol.md) — the message and delivery semantics behind them.
- [`docs/architecture.md`](architecture.md) — where an Adapter sits relative to the Hub, the Bridge
  and the Dashboard.
