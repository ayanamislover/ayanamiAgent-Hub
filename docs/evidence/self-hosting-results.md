# Self-hosting results / 自举结果

CrossAgent Hub was built using its own collaboration and review workflow. These are the numbers that
came out of it, and the two commands that produce the same numbers for your own Hub.

CrossAgent Hub 是用它自己的协作与评审流程做出来的。下面是由此得到的数据，以及能在你自己的 Hub 上
产出同样数据的两条命令。

A note on provenance: the public repository starts from a clean snapshot, so these numbers do not
come from its git history. They come from the private development workspace this project was built
in, read out of that workspace's Hub database. Nothing here is reconstructed by hand.

关于数据来源：公开仓库从一个干净快照开始，所以这些数字并不来自它的 git 历史，而是来自构建本项目时
使用的私有开发工作区，直接从那个工作区的 Hub 数据库里读出。这里没有任何手工重建的内容。

## The collaboration log / 协作日志

```bash
pnpm collab:stats
```

Reads your database read-only and prints counts — how many review rounds produced a finding, in
which direction, of what kind, and how many are still open. It never prints a message body, a
finding title or a file path. It does print your database path and your agent ids verbatim, because
naming who reviewed whom is the point of the direction breakdown; check those two before pasting the
output somewhere public, since an agent id is whatever you named it.

只读地读取你的数据库并打印计数——多少轮评审产出了 finding、方向如何、属于哪类、还有多少未关闭。它
从不打印消息正文、finding 标题或文件路径。但它会原样打印你的数据库路径和 agent id，因为「谁评审了谁」
正是方向统计的意义所在；把输出贴到公开场合前请先检查这两项，毕竟 agent id 是你自己起的名字。

Run against the demo database (`pnpm demo` seeds it), it prints:

对 demo 数据库运行（由 `pnpm demo` 生成）时的输出：

```text
CrossAgent collaboration log -- ~/.crossagent/crossagent.db
  span                   1 active days
  review rounds          3 (0 self-reviewed)
  findings filed         3
  rounds that caught something  3 of 3 (100%)
  -> one defect named every 1.0 handoffs
  author resubmitted     0 times after a review
  volume                 10 messages, 3 tasks, 39 events

Direction (who reviewed whom)
  claude reviewing codex: 2 rounds, 2 findings, caught something in 100%
  codex reviewing claude: 1 rounds, 1 findings, caught something in 100%

What the findings were about
  security         1
  maintainability  1
  correctness      1

How severe, and what happened to them
  info         1 filed, 0 settled (0%)
  high         1 filed, 0 settled (0%)
  blocking     1 filed, 1 settled (100%)

  still open: 2 findings, 0 of them blocking
```

## The review loop / 评审回路

```bash
pnpm review:stats
```

Reports the same database from the review loop's side, and prints no agent id or path at all. Here
it is on the private development workspace, which is where the review guidance in
[the collaboration charter](../collaboration-charter.md) comes from:

从评审回路一侧汇报同一个数据库，完全不打印 agent id 或路径。以下是在私有开发工作区上的输出，
[协作章程](../collaboration-charter.md)里的评审建议正是由此而来：

```text
71 reviews, 60 findings, 77 tasks
2026-07-28 .. 2026-08-01

Findings by category
----------------------------------------------------------------
  correctness             18  blocking   2 ( 11%)  ########################
  maintainability         11  blocking   0 (  0%)  ###############
  scope                    9  blocking   3 ( 33%)  ############
  concurrency              9  blocking   5 ( 56%)  ############
  test_gap                 8  blocking   0 (  0%)  ###########
  security                 3  blocking   1 ( 33%)  ####
  regression               2  blocking   0 (  0%)  ###

Yield by review size
----------------------------------------------------------------
   1-5 files     24 reviews    57 files   19 findings (0.8/review, 0.333/file)   0 blocking
   6-20 files    37 reviews   452 files   34 findings (0.9/review, 0.075/file)  10 blocking
  21-50 files     7 reviews   186 files    5 findings (0.7/review, 0.027/file)   1 blocking
  50+ files       3 reviews   286 files    2 findings (0.7/review, 0.007/file)   0 blocking

  a file in the 1-5 bucket gets 48x the scrutiny of one in the 50+ bucket
```

## What the size buckets say / 规模分桶说明了什么

Findings per review barely move with size — 0.7 to 0.9 whichever bucket you land in. A bigger
snapshot is not reviewed harder, only thinner, which is why the MCP tool that opens a review asks
for under 20 changed files.

每轮评审的 finding 数几乎不随规模变化——落在哪个桶里都是 0.7 到 0.9。更大的快照并不会被审得更用力，
只会被审得更稀，这正是开启评审的 MCP 工具要求改动文件数少于 20 的原因。

Both stats scripts honour `CROSSAGENT_DATA_DIR` and `CROSSAGENT_DATABASE_FILE`, so you can point
them at the demo instead of your own data.

两个统计脚本都遵循 `CROSSAGENT_DATA_DIR` 与 `CROSSAGENT_DATABASE_FILE`，因此可以让它们指向 demo 而
不是你自己的数据。
