# Windows 一键启动与双端通信

## 解决 `pnpm` 找不到

PowerShell 报“无法将 `pnpm` 识别为 cmdlet”表示当前终端的 `PATH` 中没有全局 pnpm，
并不代表 Hub 代码损坏。根目录的 `Start-CrossAgent-Hub.cmd` 不依赖全局 pnpm：

1. 优先使用已有 `pnpm`；
2. 否则使用 Node 自带的 `corepack pnpm`；
3. 最后才通过 `npx pnpm@11.9.0` 回退。

双击脚本后，它会完成依赖检查、首次构建、后台启动，并打开
`http://127.0.0.1:4387`。停止时双击 `Stop-CrossAgent-Hub.cmd`。

Node.js 仍需满足 22.13 或更高版本。

## 在 Dashboard 登记多个项目

Hub 只是控制面；Dashboard 启动不等于某个已经打开的 Agent 会话已经接入。项目目录只需在
Dashboard 登记一次：

1. 双击 `Start-CrossAgent-Hub.cmd`。
2. 在左侧 Active project 区域点击 `+`，打开 Project registry。
3. 输入一个已存在的项目目录，例如 `C:\Projects\my-project`。
4. 继续登记其他目录；它们会持久保存在 Hub 数据库和左侧项目列表中。

每个项目都有稳定 UUID。Agent 可以用 UUID 选择项目；Hub 会解析到此前登记的主路径，不再让
每个 Agent 重复输入目录。MCP Agent 可调用 `crossagent_join` 并传入 `projectId`。

## 让 Codex 进入已登记项目

双击 `Connect-Codex.cmd`。脚本会列出 Dashboard 中的项目名称、UUID 和路径；只有一个项目时
自动选择，多个项目时输入编号或粘贴 UUID。

`Connect-Codex.cmd` 会打开一个新的 Codex Bridge：它接收 Claude 的实时消息，并只在该
子进程内注入 Hub token 与 MCP 配置，不修改用户的全局 `config.toml`。

命令行等价方式：

```powershell
node packages/cli/dist/bin.js codex --project-id <project-uuid>
```

## Claude Desktop 与 Claude Code

`Connect-Claude.cmd` 配置的是 Claude Code custom Channel。Claude Desktop 不是同一个接入
模型，不应直接套用该脚本。请把 [`docs/claude-desktop.md`](./claude-desktop.md) 交给 Claude Desktop，让它先
确认当前版本支持的 MCP transport 和配置文件格式，再选择完整 stdio adapter 或受限的 HTTP
接入；不要猜测配置位置，也不要把 bearer token 内容粘贴进聊天。

`Connect-Claude.cmd` 会：

- 为目标项目写入或合并 `.mcp.json` 的 `crossagent-channel`；
- 把下面的协作提示词复制到剪贴板；
- 检测到 `claude` 命令后，以 development Channel 参数启动 Claude Code。

若当前机器尚无 `claude` 命令，配置仍会保留；安装/启用 Claude Code 后再次双击即可。

## 粘贴给 Claude 的话

```text
你已通过 CrossAgent Channel 接入本项目，身份是 claude。请把 CrossAgent 当作与 Codex 协作的控制面：
1. 开始时先调用 check_inbox，再按需调用 get_context_pack。
2. 收到 action-required 事件先 ack_event；处理完成后 mark_processed；需要回复时用 post_reply 并复用原 threadId。
3. 需要主动联系 Codex 时调用 post_message，recipients 使用 ["codex"]；重要问题设 priority="IMPORTANT"、requiresAck=true、requiresResponse=true。
4. 不要把普通状态消息打断成新任务；对对方的代码、Git 和测试结论要自行核验。
现在先检查 inbox，并给 codex 发一条 NORMAL 测试消息："Claude 已接入 CrossAgent，可以通信。"
```

成功时，Dashboard 的 Agents 页会同时出现 `codex` 和 `claude`，Communications 页会出现
测试消息。Claude 主动发消息使用 `post_message`；收到事件后用 `ack_event`、
`post_reply` 和 `mark_processed` 完成可靠交付闭环。

## 命令行等价方式

```powershell
.\scripts\start-windows.ps1
.\scripts\connect-codex.ps1 -ProjectId "prj_..."
.\scripts\connect-claude.ps1 -ProjectId "prj_..."
```

只写 Claude 配置、不立即启动：

```powershell
.\scripts\connect-claude.ps1 -ProjectId "prj_..." -ConfigureOnly
```

自定义端口时，三个脚本必须使用相同的 `-Port`。
