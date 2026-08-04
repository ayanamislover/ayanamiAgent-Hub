# fake-agent-adapter

A third-party Adapter that runs against a live Hub and prints exactly what it is allowed to do.

一个能对着运行中的 Hub 真实跑起来的第三方 Adapter，把自己被允许做什么原样打印出来。

```bash
node examples/fake-agent-adapter/adapter.mjs .
```

It needs a Hub that is already running with the project registered (`crossagent setup .`), and it
reads the compatibility credential from `~/.crossagent/token` — the path and length are printed, the
token itself never is.

它需要一个已经启动、并且项目已注册的 Hub（`crossagent setup .`），并从 `~/.crossagent/token` 读取兼容
凭据——只打印路径和长度，绝不打印 token 本身。

Expected output: `join project` and `register session` succeed, `heartbeat`, `read the inbox` and
`post a message` are refused with **403 FORBIDDEN**, and `close session` succeeds. That is the whole
current surface for a third party — the refusals are the Hub working as designed, not a broken
setup.

预期输出：`join project` 与 `register session` 成功；`heartbeat`、`read the inbox`、`post a message`
以 **403 FORBIDDEN** 被拒；`close session` 成功。这就是目前第三方的全部可用面——那些拒绝是 Hub 按设计
工作，不是环境坏了。

Every refused call needs the `hub:session` scope, which only a CONTROL session ticket carries, and
tickets are only issued to the per-client static credentials the Hub provisions for the Codex and
Claude families. [`docs/adapter-authoring.md`](../../docs/adapter-authoring.md) lists the five places
that have to change to add a third family, and
[`apps/hub/test/third-party-adapter.test.ts`](../../apps/hub/test/third-party-adapter.test.ts) pins
this boundary so it cannot drift silently.

每一个被拒的调用都需要 `hub:session` scope，它只由 CONTROL session ticket 携带，而 ticket 只签发给 Hub
为 Codex 与 Claude 两个 family 预置的按 client 划分的静态凭据。
[`docs/adapter-authoring.md`](../../docs/adapter-authoring.md) 列出了新增第三个 family 需要改动的五处，
[`apps/hub/test/third-party-adapter.test.ts`](../../apps/hub/test/third-party-adapter.test.ts) 则钉住
这条边界，使它不会悄悄漂移。

The script speaks plain HTTP so it runs with no install. A real Adapter should use
[`@crossagent/client`](../../packages/client), which validates every response against
[`@crossagent/protocol`](../../packages/protocol) rather than trusting it.

脚本直接讲 HTTP，因此无需安装即可运行。真正的 Adapter 应当使用
[`@crossagent/client`](../../packages/client)，它会用
[`@crossagent/protocol`](../../packages/protocol) 校验每一个响应，而不是直接信任。
