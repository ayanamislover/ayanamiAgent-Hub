# Known limitations / 已知限制

Things this project does not yet do, or does not do everywhere. Written for people deciding whether
it fits their setup, not as a roadmap.

本文列出目前做不到、或并非在所有环境下都能做到的事，供你判断它是否适合你的环境；这不是路线图。

---

## Platform support / 平台支持

**Windows-first.** Developed and exercised on Windows 10/11 with PowerShell. The source carries 36
platform branches; the managed Bridge supervisor relies on a Windows named-pipe singleton, the
one-click launchers are `.cmd` files, and the credential files are protected with Windows ACLs.

It may start on macOS or Linux, but it is not tested there and the supervisor's single-instance
guarantee has no equivalent implementation. Treat non-Windows as unsupported until that changes.

**以 Windows 为主。** 在 Windows 10/11 + PowerShell 上开发与验证。源码中有 36 处平台分支；托管
Bridge 的单例依赖 Windows 命名管道，一键脚本是 `.cmd`，凭据文件用 Windows ACL 保护。在 macOS 或
Linux 上或许能启动，但未经测试，且单例保证没有对应实现。在此之前请视为不支持。

---

## Hook lifecycle capture is not verified end to end / Hook 生命周期捕获尚未端到端验证

`required` Hook capture binding stays disabled until a real `SessionStart` or `UserPromptSubmit`
arrives from the host application and produces the full evidence chain: a hooks-client session with
exact external session and thread ids, an ONLINE session, an owner-private Hook ticket, and a
captured user-turn record. The Authority Dashboard's raw-user-turn provenance chain depends on that
same live binding.

This cannot be satisfied by invoking the Hook entrypoint by hand or replaying Hook input; doing so
would record a provenance claim that never happened.

在宿主应用真正触发一次 `SessionStart` 或 `UserPromptSubmit`、并产生完整证据链之前，`required`
Hook 捕获绑定保持关闭。Authority Dashboard 的原始 user-turn 溯源链依赖同一个实时绑定。不能靠手工
调用 Hook 入口或重放 Hook 输入来满足——那会记录一条从未发生过的溯源声明。

---

## An injected Codex message cannot be confirmed / 注入 Codex 的消息无法确认送达

The Bridge reports a delivery only after reading the message back out of the Codex thread, never on
the app-server's bare acknowledgement. For `thread/inject_items` that read is impossible on
codex-cli 0.145.0. Injection starts no turn, and measured against a fresh 133 KB thread with a
healthy app-server:

| call                                 | result                                                                                                   |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `thread/read` (`includeTurns: true`) | 674 bytes of metadata, empty `turns`, item absent                                                        |
| `thread/items/list`                  | `-32601: thread/items/list is not supported yet`                                                         |
| `thread/turns/list`                  | empty on a fresh thread; on a large one it answers in ~1.9s but exposes no `clientId` for a steered item |

The item really is in the thread — it appears in the rollout file on disk — but nothing can observe
it, so the Bridge goes `degraded` with `thread/inject_items accepted <id> but the thread never held
it` and the recipient stays `PENDING`. That is the safe direction: nothing is lost and nothing is
falsely reported delivered. The peer is simply never woken.

Idle pushes therefore wake instead of injecting, which also solves the deeper problem that an
injected message does not rouse the peer at all. Two inject routes remain and stay unconfirmable
until Codex implements `thread/items/list`: an IMPORTANT message to a peer whose `wakePolicy` opted
out of being woken, and the fallback after an explicitly rejected `turn/steer`.

`turn/steer` has the same gap, and this is measured rather than assumed. The RPC is healthy: it
answers in 1ms on the 445 MB thread and names the expected turn. What Codex never writes back is the
steered input. Confirmation accepts either match, and both were probed against a real steer that ran
to completion on that thread:

| route                                 | result                                                                                                               |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `clientId === messageId`              | absent — `thread/turns/list` shows the `clientId` of the `turn/start` and nothing for the steer                      |
| literal `event_id="<id>"` in the text | absent — `thread/read(includeTurns: true)` succeeded, serialized to 67,375,659 bytes, and the marker does not appear |

So an INTERRUPT steered into an active turn reaches the model but cannot be proven to, exactly like
an injected message. `turn/start` is the one surface Codex does persist a `clientUserMessageId` for,
which is why a wake can be confirmed and nothing else can.

Steer is kept anyway — an INTERRUPT that arrives after the damage is not an interrupt — and the
message stays unconfirmed, replayable, and never reported delivered. What it no longer does is mark
the Bridge `degraded`: this outcome is the Codex version behaving as measured, not a fault here, and
a health signal that turns red on every INTERRUPT stops being read. Any other ambiguity still
degrades, and when both are pending the reported reason names the fault rather than the steer. The
fallback after an explicitly _rejected_ steer is not exempt: that one means the turn state was not
what the Bridge believed, which is a real anomaly.

Bridge 只有把消息从 Codex 线程里读回来才算送达，不接受 app-server 的裸 ACK。而在 codex-cli 0.145.0
上，`thread/inject_items` 注入的内容读不回来：注入不开启 turn，实测一个全新的 133 KB 线程、app-server
完全健康时，`thread/read` 只返回 674 字节元数据且 `turns` 为空，`thread/items/list` 回
`not supported yet`，`thread/turns/list` 为空。消息确实进了线程（磁盘上的 rollout 文件里能搜到），但
没有任何接口观察得到，于是 Bridge 转 `degraded`、收件人停在 `PENDING`。这是安全方向的失败：不丢消息、
不谎报送达，只是对方永远不会被唤醒。因此空闲时的推送改为 wake——这同时解决了更根本的问题：注入本来就
唤不醒对方。仍有两条 inject 路径在 Codex 实现 `thread/items/list` 之前无法确认：对方 `wakePolicy`
选择不被唤醒时的 IMPORTANT 消息，以及 `turn/steer` 被显式拒绝后的回退。

`turn/steer` 有同样的缺口，而且这是实测结论不是推断。RPC 本身健康：445 MB 线程上 1ms 返回，turnId
与预期一致。Codex 不写回的是被 steer 进去的输入本身。确认逻辑接受两种命中，两条都在那个线程上用一次
真实、跑完整的 steer 验过：`clientId` 等于 messageId——不存在，turn 结束后 `thread/turns/list` 只有
`turn/start` 的 `clientId`；正文里的 `event_id="<id>"` 字面量——也不存在，`thread/read(includeTurns:
true)` 调用成功、完整序列化 67,375,659 字节，搜不到该标记。所以 steer 进活跃 turn 的 INTERRUPT 确实
到得了模型，但无法证明到达，与注入完全同类。`turn/start` 是 Codex 唯一会持久化
`clientUserMessageId` 的入口，这就是为什么只有 wake 能被确认。

steer 仍然保留——等 turn 结束才到的 INTERRUPT 就不叫 INTERRUPT 了——消息照旧停在未确认、可重放、绝不
谎报送达。改掉的只有一点：它不再把 Bridge 标成 `degraded`。这个结果是该 Codex 版本的实测行为，不是本
项目故障；每次 INTERRUPT 都变红的健康信号等于没有信号。其他任何歧义仍然降级，两者同时挂起时上报的
原因取那个真故障，而不是 steer。被**显式拒绝**的 steer 走的回退不在豁免之列：那说明 turn 状态与
Bridge 的认知不一致，属于真异常。

---

## Codex thread rollouts grow without bound / Codex 线程 rollout 无限增长

Separate from the above, and not something this project writes. Codex stores each thread as an
append-only `~/.codex/sessions/rollout-*.jsonl` that only grows; there is no compaction or rotation.
Observed on 2026-08-03: one thread running since 2026-07-28 had reached 605 MB, and two others were
466 MB and 634 MB. At that size the append still succeeds but `thread/read` times out outright, so a
long-lived thread eventually stops answering even the calls that would otherwise work.

The Bridge only appends to this file when it delivers; the bulk is the user's own Codex
conversation. It cannot be truncated safely — Codex owns and reads the format. The mitigation is to
retire a long-running thread rather than keep one alive indefinitely.

这一条与上一条无关，且该文件不是本项目写的。Codex 把每个线程存成只增不减的
`~/.codex/sessions/rollout-*.jsonl`，没有压缩或轮转机制。2026-08-03 实测：一个 7 月 28 日开始的线程已
达 605 MB，另有 466 MB 和 634 MB 各一。到这个体量时追加仍然成功，但 `thread/read` 会直接超时，于是长期
运行的线程最终连本来能用的调用也不再响应。Bridge 只在投递时往里追加，绝大部分是用户自己与 Codex 的对话；
该文件不能安全截断——格式归 Codex 所有并由它读取。缓解办法只有让长期线程适时退役，而不是永远续用。

---

## The Bridge is pinned to observed Codex app-server behaviour / Bridge 依赖实测的 Codex 行为

Codex only writes a thread's rollout once the thread holds at least one item, and refuses
`thread/resume` with `-32600 no rollout found` until it does. The Bridge must restart the
app-server mid-launch to install the initial MODEL_MCP ticket — the ticket is bound to the thread
id, so it cannot be minted before the thread exists — and then resume the thread it just created.
So the Bridge injects one visible anchor line, `CrossAgent Hub is connected to this thread.`, before
that restart. `thread/read` does not persist a thread and an empty item list is rejected, so there
is no invisible alternative.

None of this is in a published contract; it was measured against codex-cli 0.145.0. A future Codex
release that changes when rollouts are written, or what `thread/resume` accepts, can break Bridge
launch without any change on this side.

Codex 只有在线程至少含一个 item 之后才写 rollout，在那之前 `thread/resume` 一律返回 `-32600 no
rollout found`。而 Bridge 必须在启动中途重启 app-server 来装载初始 MODEL_MCP ticket（ticket 绑定
thread id，因此只能在 thread 创建之后签发），重启后再 resume 刚创建的线程。所以 Bridge 会在重启前注入
一行可见的锚点 `CrossAgent Hub is connected to this thread.`——`thread/read` 不会持久化线程，空 item
列表会被拒绝，没有隐形的替代做法。以上都不是公开契约，只是在 codex-cli 0.145.0 上实测所得；Codex 未来
若改变 rollout 的写入时机或 `thread/resume` 的接受条件，Bridge 启动可能在本项目毫无改动的情况下失效。

---

## Static credentials cannot be rotated yet / 静态凭据暂时无法轮换

The rotation machinery itself is complete and tested: the durable schema, a coordinator with
crash-recovery phases and fault-injection points, and owner-private ACL verification. What is
missing is a way to authorize a rotation. Both accepted sources depend on the Hook chain above —
one requires a captured user-turn record, the other a user-actor Dashboard authorization event — so
until that chain works, the eight static credentials stay at their first generation.

If you ran a build from before the WebSocket query-credential fix, treat `~/.crossagent/token` as
disclosed: it was written in plaintext to `hub.log` on every socket handshake. That path is closed
and the log now rotates, but the credential itself cannot be replaced for the reason above. Its
scope is `project:select` only and the Hub binds to loopback, so the practical exposure is narrow.

轮换机制本身完整且有测试（持久层 schema、带崩溃恢复阶段与故障注入点的协调器、owner-private ACL
校验），缺的是**授权来源**：两条可接受的来源都依赖上面的 Hook 链，因此在那条链打通前，八个静态凭据
停留在第一代。若你用过 WebSocket 查询参数凭据修复之前的版本，请将 `~/.crossagent/token` 视为已泄露
——它曾在每次握手时明文写入 `hub.log`。该路径已封闭、日志也已支持轮转，但凭据本身因上述原因无法更换；
它的权限仅为 `project:select`，且 Hub 只监听回环地址，实际暴露面很窄。

---

## Long-duration acceptance not yet run / 长时程验收尚未执行

The 72-hour control and journal lease-renewal observation has not been performed against a frozen
immutable candidate. Behaviour over multi-day uptime is therefore unproven.

尚未针对冻结的不可变候选执行 72 小时的控制与 journal 租约续期观察，多日连续运行的行为因此未经证实。

---

## Dashboard end-to-end suite cannot seed itself / Dashboard 端到端套件无法自行准备数据

`pnpm test:e2e` does not run against a clean data directory. Its fixture registers two sessions
claiming `agentId: "codex"` with `client: "codex-app-server"` and the Claude equivalent, and the Hub
refuses:

```
403 Compatibility sessions require fake-client and an explicit manual: or local: Agent namespace
```

That refusal is correct. `assertCanCreateAdapterSession` admits only `prn_local_agent`, only for
`fake-client`, and only under a `manual:` or `local:` agent namespace, precisely so that a fixture
cannot stand up a session claiming to be a real Codex or Claude Adapter. A real adapter session is
supposed to come from the enrollment and session-ticket flow.

The suite appeared to pass because `output/playwright/e2e-data` survives between runs, so the
sessions were created once under an older, looser rule and reused ever after. Deleting that
directory reproduces the failure on any machine.

Fixing it means driving the real enrollment flow rather than pretending, which is not a fixture
tweak; renaming the fixture agents instead would only move the pretence and break the Dashboard
assertions that legitimately key on `codex` and `claude`. Until then the suite is not wired into
CI, and the credential half of the problem is fixed: the fixture now uses `dashboard-token` for
Dashboard operations and the compatibility bearer only where that principal is genuinely required.

`pnpm test:e2e` 无法在干净的数据目录上运行。它的夹具注册了两个自称 `agentId: "codex"`、
`client: "codex-app-server"` 的 session（Claude 同理），而 Hub 会拒绝，且这个拒绝是正确的：
`assertCanCreateAdapterSession` 只接受 `prn_local_agent`、只接受 `fake-client`、且只接受
`manual:`/`local:` 命名空间下的 agent id——正是为了防止夹具假冒真实 Codex/Claude Adapter。真实的
adapter session 应当来自 enrollment 与 session ticket 流程。

它此前看起来是通过的，是因为 `output/playwright/e2e-data` 会跨次运行保留：那两个 session 是在更宽松
的旧规则下创建过一次，此后一直被复用。删掉该目录即可在任何机器上复现失败。

真正修好需要走通真实的 enrollment 流程而不是假冒，这不是改夹具能解决的；而把夹具里的 agent 改名只是
把假冒挪个位置，还会破坏 Dashboard 中那些本就应该以 `codex`/`claude` 为键的断言。在此之前该套件不接入
CI。凭据那一半的问题已经修好：夹具现在用 `dashboard-token` 执行 Dashboard 操作，仅在确实需要该主体的
地方使用兼容 bearer。
