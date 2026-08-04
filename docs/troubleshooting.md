# Troubleshooting

## Hub 无法启动

1. 运行 `pnpm build`，确认 `apps/hub/dist/main.js` 与 `apps/dashboard/dist/index.html` 存在。
2. 运行 `crossagent status`；它会清理已不存在进程对应的 stale PID。
3. 查看用户数据目录中的 `hub.log`。默认目录为 `~/.crossagent`，可用 `CROSSAGENT_DATA_DIR` 覆盖。
4. 端口被占用时使用 `crossagent start --port <port>`，并让客户端设置同一个 `CROSSAGENT_URL`。

CLI 不调用 WMI；进程状态仅由 PID 文件、标准进程存活检查和 `/api/health` 确认。

## Dashboard 显示未授权

本机 loopback Dashboard 默认不显示登录页，并自动换取 HttpOnly cookie。如果显式设置了 `CROSSAGENT_DASHBOARD_AUTH=required`，请运行 `crossagent open`；它会生成 60 秒有效、一次性使用的 launch code 并交换 HttpOnly cookie。手工登录使用的是 `~/.crossagent/dashboard-token`，不是 Agent 的 `~/.crossagent/token`；token 不会写入 URL 或 localStorage。非 loopback 监听不能关闭 Dashboard 登录门。

## Codex Bridge 无法连接

- `codex --version` 必须成功。
- 用 `crossagent doctor` 查看 Codex 探测结果。
- Bridge 会先执行 app-server `initialize` capability probe；不支持的 method 会被显式降级，不会伪报 native push。
- 查看 Hub Audit 页与 `hub.log` 中经过脱敏的 adapter error。

## Claude Channel 不出现

- 确认 `claude --version` 可用且该版本支持 custom Channels。
- 先运行 `crossagent claude-channel install .`。
- custom Channel 是预览能力，启动参数可能随 Claude Code 变化；若 capability probe 失败，使用 `crossagent hooks install claude .`。
- Hook 模式只在 hook 安全点收取消息，不等同于 turn 中即时 push。

## 消息没有唤醒对方

- `BACKGROUND` 永远只进 mailbox。
- `NORMAL` 等待下一个安全点。
- `IMPORTANT` 需要 ACK，并按项目 wake policy 在 idle 或 checkpoint 推送。
- `INTERRUPT` 受速率限制。
- Agents 页若显示 `mailbox_only`，对方必须主动查询 inbox。

## review checkout 失败

review bundle 记录的 commit 必须仍存在于本地 Git object database。CLI 只在 `~/.crossagent/review-worktrees/<project-id>/` 下创建 detached worktree；下载或应用 patch 失败会自动移除未完成 worktree。完成后运行：

```bash
crossagent review cleanup <review-id> --project-id <project-id>
```

## 数据库与恢复

新 migration 应用前，Hub 把既有数据库备份到 `~/.crossagent/backups/pre-migration/`。手动备份：

```bash
crossagent backup create
crossagent stop
crossagent backup restore <backup-directory>
```

DB 与 artifacts 在备份目录中分开存放。restore 不覆盖运行中的 Hub，并在覆盖前保留 pre-restore 副本。

## 数据库越来越大

体积几乎全部来自三张记账表：`idempotency_keys`（重放护栏，没有任何东西会过期它们）、`events`
（追加日志，其中约四分之三是 Codex 转录遥测）、`session_heartbeats`（在线心跳）。实测一个运行 6 天的
库：88 MB，其中这三张表占 96%，按这个速率一年约 5 GB。任务、review、findings、messages 加起来只有几百
行，不参与清理——它们是 `pnpm review:stats` 的全部依据。

```bash
pnpm prune:history
```

默认只做试算，打印会删什么、留什么，不写任何东西。加 `--apply` 才真正执行；被删的行先整行写进
JSONL 归档，再在同一个事务里删除，最后 VACUUM。

保留窗口是 `--days`，可选 7 / 14 / 30 / 90 / 180 / 365，默认 30。它同时是数据库自己的规则：migration
0015 把 `events` 的删除护栏从「永不可删」收窄为「窗口内不可删」，窗口值存在 `event_retention_policy`
表里，`--apply` 时写入。所以传一个更大的 `--days` 也够不到窗口内的行；策略行丢失时护栏回到全锁死，而
不是全放开。被 `authority_events`、`delegation_events`、`message_surface_handoffs` 等表引用的事件永远
不删，试算输出里会单独报出这些被保留的行数。

```bash
pnpm prune:history -- --days=90 --apply
```

## 生成诊断包

```bash
crossagent diagnostics export crossagent-diagnostics.zip
```

诊断包包含版本、系统、DB pragma、Hub health、脱敏配置与近期错误摘要；默认排除消息正文、secret 和完整代码 diff。
