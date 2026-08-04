export const supportedLocales = ["en", "zh-CN"] as const;

export type DashboardLocale = (typeof supportedLocales)[number];

type Message = Record<DashboardLocale, string>;

export const messageCatalog = {
  "Loading live state": { en: "Loading live state", "zh-CN": "正在载入实时状态" },
  "Unable to load this surface": {
    en: "Unable to load this surface",
    "zh-CN": "无法载入当前页面",
  },
  "Verified progress": { en: "Verified progress", "zh-CN": "已验证进度" },
  Select: { en: "Select", "zh-CN": "请选择" },
  "Local control plane": { en: "Local control plane", "zh-CN": "本地控制面" },
  "Current project": { en: "Current project", "zh-CN": "当前项目" },
  "Manage registered projects": {
    en: "Manage registered projects",
    "zh-CN": "管理已登记的项目",
  },
  "No project selected": { en: "No project selected", "zh-CN": "未选择项目" },
  "No registered path": { en: "No registered path", "zh-CN": "未登记路径" },
  Scheduling: { en: "Scheduling", "zh-CN": "调度" },
  Overview: { en: "Overview", "zh-CN": "总览" },
  Tasks: { en: "Tasks", "zh-CN": "任务" },
  Communications: { en: "Communications", "zh-CN": "通信" },
  Console: { en: "Console", "zh-CN": "主控台" },
  "Quality assurance": { en: "Quality assurance", "zh-CN": "质量保障" },
  Reviews: { en: "Reviews", "zh-CN": "审查" },
  Agents: { en: "Agents", "zh-CN": "智能体" },
  Conflicts: { en: "Conflicts", "zh-CN": "冲突" },
  System: { en: "System", "zh-CN": "系统" },
  Audit: { en: "Audit", "zh-CN": "审计" },
  Settings: { en: "Settings", "zh-CN": "设置" },
  "Live connection": { en: "Live connection", "zh-CN": "实时连接" },
  "Resync required": { en: "Resync required", "zh-CN": "需要重新同步" },
  Reconnecting: { en: "Reconnecting", "zh-CN": "正在重连" },
  "Local only": { en: "Local only", "zh-CN": "仅本地" },
  "Search tasks, sessions, and agents…": {
    en: "Search tasks, sessions, and agents…",
    "zh-CN": "搜索任务、会话和智能体…",
  },
  Inbox: { en: "Inbox", "zh-CN": "收件箱" },
  "Event stream": { en: "Event stream", "zh-CN": "事件流" },
  Live: { en: "Live", "zh-CN": "实时" },
  Syncing: { en: "Syncing", "zh-CN": "同步中" },
  "Command palette": { en: "Command palette", "zh-CN": "命令面板" },
  "Search tasks and Dashboard surfaces": {
    en: "Search tasks and Dashboard surfaces",
    "zh-CN": "搜索任务和 Dashboard 页面",
  },
  "Find a task or jump to a surface": {
    en: "Find a task or jump to a surface",
    "zh-CN": "查找任务或跳转到页面",
  },
  "Close command palette": { en: "Close command palette", "zh-CN": "关闭命令面板" },
  "Matching tasks": { en: "MATCHING TASKS", "zh-CN": "匹配的任务" },
  "Quick jumps": { en: "QUICK JUMPS", "zh-CN": "快速跳转" },
  "Open overview": { en: "Open overview", "zh-CN": "打开总览" },
  "Inspect live agents": { en: "Inspect live agents", "zh-CN": "查看实时智能体" },
  "Review communications": { en: "Review communications", "zh-CN": "查看通信" },
  "Open audit stream": { en: "Open audit stream", "zh-CN": "打开审计流" },
  "No matching tasks": { en: "No matching tasks", "zh-CN": "没有匹配的任务" },
  "Search by title, description, ID, status, or owner.": {
    en: "Search by title, description, ID, status, or owner.",
    "zh-CN": "可按标题、说明、ID、状态或负责人搜索。",
  },
  "Local project directory": {
    en: "Local project directory",
    "zh-CN": "本地项目目录",
  },
  "Enter an existing folder once. The Hub stores its stable UUID and path for future Agent sessions.":
    {
      en: "Enter an existing folder once. The Hub stores its stable UUID and path for future Agent sessions.",
      "zh-CN": "只需输入一次现有文件夹。Hub 会保存稳定的 UUID 和路径，供以后的智能体会话使用。",
    },
  "Registering…": { en: "Registering…", "zh-CN": "登记中…" },
  "Register project": { en: "Register project", "zh-CN": "登记项目" },
  "Validating and registering this directory…": {
    en: "Validating and registering this directory…",
    "zh-CN": "正在验证并登记此目录…",
  },
  "Project registry": { en: "Project registry", "zh-CN": "项目登记表" },
  "Register your first workspace": {
    en: "Register your first workspace",
    "zh-CN": "登记第一个工作区",
  },
  "Projects stay in this Dashboard. Codex and other Agents can reconnect using the stable project UUID instead of asking for the directory every time.":
    {
      en: "Projects stay in this Dashboard. Codex and other Agents can reconnect using the stable project UUID instead of asking for the directory every time.",
      "zh-CN":
        "项目会保留在此 Dashboard 中。Codex 和其他智能体可用稳定的项目 UUID 重连，无需每次询问目录。",
    },
  "Persistent workspaces": { en: "PERSISTENT WORKSPACES", "zh-CN": "持久工作区" },
  "Close project registry": { en: "Close project registry", "zh-CN": "关闭项目登记表" },
  "Registered projects": { en: "Registered projects", "zh-CN": "已登记项目" },
  "Switch to": { en: "Switch to", "zh-CN": "切换到" },
  Active: { en: "ACTIVE", "zh-CN": "当前" },
  "No local path": { en: "No local path", "zh-CN": "无本地路径" },
  "Copied UUID for {name}": { en: "Copied UUID for {name}", "zh-CN": "已复制 {name} 的 UUID" },
  "Copy UUID for {name}": { en: "Copy UUID for {name}", "zh-CN": "复制 {name} 的 UUID" },
  "Clipboard access was denied.": {
    en: "Clipboard access was denied.",
    "zh-CN": "剪贴板访问被拒绝。",
  },
  "No registered projects": { en: "No registered projects", "zh-CN": "没有已登记项目" },
  "Register a local directory below to create a stable project UUID.": {
    en: "Register a local directory below to create a stable project UUID.",
    "zh-CN": "在下方登记本地目录，以创建稳定的项目 UUID。",
  },
  "Could not copy the project UUID: {error}": {
    en: "Could not copy the project UUID: {error}",
    "zh-CN": "无法复制项目 UUID：{error}",
  },
  "Opening local control plane": {
    en: "Opening local control plane",
    "zh-CN": "正在打开本地控制面",
  },
  "Opening terminal console": {
    en: "Opening terminal console",
    "zh-CN": "正在打开终端主控台",
  },
  "Local authentication": { en: "LOCAL AUTHENTICATION", "zh-CN": "本地身份验证" },
  "Enter the control plane": { en: "Enter the control plane", "zh-CN": "进入控制面" },
  "Use crossagent open for a one-time launch, or paste the local Dashboard token.": {
    en: "Use crossagent open for a one-time launch, or paste the local Dashboard token.",
    "zh-CN": "使用 crossagent open 进行一次性启动，或粘贴本地 Dashboard token。",
  },
  "Local Dashboard token": { en: "Local Dashboard token", "zh-CN": "本地 Dashboard token" },
  Authenticate: { en: "Authenticate", "zh-CN": "验证身份" },
  "Token rejected. Read ~/.crossagent/dashboard-token or run crossagent open.": {
    en: "Token rejected. Read ~/.crossagent/dashboard-token or run crossagent open.",
    "zh-CN": "Token 被拒绝。请读取 ~/.crossagent/dashboard-token 或运行 crossagent open。",
  },
  "{count}s ago": { en: "{count}s ago", "zh-CN": "{count} 秒前" },
  "{count}m ago": { en: "{count}m ago", "zh-CN": "{count} 分钟前" },
  "{count}h ago": { en: "{count}h ago", "zh-CN": "{count} 小时前" },
  "{count}d ago": { en: "{count}d ago", "zh-CN": "{count} 天前" },
  "Active objective": { en: "ACTIVE OBJECTIVE", "zh-CN": "当前目标" },
  "No active objective": { en: "No active objective", "zh-CN": "暂无当前目标" },
  "Create an objective to turn agent activity into verifiable progress.": {
    en: "Create an objective to turn agent activity into verifiable progress.",
    "zh-CN": "创建目标，将智能体活动转化为可验证的进度。",
  },
  Verified: { en: "VERIFIED", "zh-CN": "已验证" },
  "No milestones defined yet.": {
    en: "No milestones defined yet.",
    "zh-CN": "尚未定义里程碑。",
  },
  "{count} tasks": { en: "{count} tasks", "zh-CN": "{count} 个任务" },
  Operators: { en: "OPERATORS", "zh-CN": "执行者" },
  "Agent field state": { en: "Agent field state", "zh-CN": "智能体现场状态" },
  "Open matrix": { en: "Open matrix", "zh-CN": "打开矩阵" },
  "No agents connected": { en: "No agents connected", "zh-CN": "没有智能体已连接" },
  "Start the Codex Bridge, Claude Channel, or install lifecycle hooks.": {
    en: "Start the Codex Bridge, Claude Channel, or install lifecycle hooks.",
    "zh-CN": "启动 Codex Bridge、Claude Channel，或安装生命周期 Hook。",
  },
  Task: { en: "Task", "zh-CN": "任务" },
  Branch: { en: "Branch", "zh-CN": "分支" },
  "Last seen": { en: "Last seen", "zh-CN": "最后活跃" },
  Unassigned: { en: "Unassigned", "zh-CN": "未分配" },
  Unclaimed: { en: "Unclaimed", "zh-CN": "未领取" },
  "Delivery pipeline": { en: "DELIVERY PIPELINE", "zh-CN": "交付流程" },
  "Milestones & proof": { en: "Milestones & proof", "zh-CN": "里程碑与证据" },
  "Inspect task: {title}": { en: "Inspect task: {title}", "zh-CN": "检查任务：{title}" },
  "No task evidence yet": { en: "No task evidence yet", "zh-CN": "暂无任务证据" },
  "Tasks and TODO proof will appear here.": {
    en: "Tasks and TODO proof will appear here.",
    "zh-CN": "任务和 TODO 证据将显示在此处。",
  },
  Attention: { en: "ATTENTION", "zh-CN": "需关注" },
  Blockers: { en: "Blockers", "zh-CN": "阻塞项" },
  "No active blockers": { en: "No active blockers", "zh-CN": "没有活跃阻塞项" },
  "Live log": { en: "LIVE LOG", "zh-CN": "实时日志" },
  "Recent activity": { en: "Recent activity", "zh-CN": "最近活动" },
  "Recent project activity": { en: "Recent project activity", "zh-CN": "最近项目活动" },
  "No durable activity yet": {
    en: "No durable activity yet",
    "zh-CN": "暂无持久化活动",
  },
  "Project mutations will appear here in sequence order.": {
    en: "Project mutations will appear here in sequence order.",
    "zh-CN": "项目变更将按序列顺序显示在此处。",
  },
  Snapshot: { en: "Snapshot", "zh-CN": "快照" },
  "Event cursor": { en: "Event cursor", "zh-CN": "事件游标" },
  "Session telemetry": { en: "SESSION TELEMETRY", "zh-CN": "会话遥测" },
  "Connection state is kept separate from work state and claim freshness.": {
    en: "Connection state is kept separate from work state and claim freshness.",
    "zh-CN": "连接状态与工作状态、领取新鲜度分开记录。",
  },
  "No session telemetry": { en: "No session telemetry", "zh-CN": "暂无会话遥测" },
  "Connected Bridges, Channels, and hooks appear here.": {
    en: "Connected Bridges, Channels, and hooks appear here.",
    "zh-CN": "已连接的 Bridge、Channel 和 Hook 将显示在此处。",
  },
  "Agent sessions": { en: "Agent sessions", "zh-CN": "智能体会话" },
  Delivery: { en: "Delivery", "zh-CN": "投递" },
  Heartbeat: { en: "Heartbeat", "zh-CN": "心跳" },
  Client: { en: "Client", "zh-CN": "客户端" },
  Queue: { en: "Queue", "zh-CN": "队列" },
  "{current} current · {history} historical": {
    en: "{current} current · {history} historical",
    "zh-CN": "{current} 个当前会话 · {history} 个历史会话",
  },
  "No current sessions.": { en: "No current sessions.", "zh-CN": "没有当前会话。" },
  "Session history ({count})": {
    en: "Session history ({count})",
    "zh-CN": "会话历史（{count}）",
  },
  "Append-only record": { en: "APPEND-ONLY RECORD", "zh-CN": "只追加记录" },
  "Audit stream": { en: "Audit stream", "zh-CN": "审计流" },
  "Every durable mutation is sequenced, attributable, and replayable.": {
    en: "Every durable mutation is sequenced, attributable, and replayable.",
    "zh-CN": "每个持久化变更都有序列、可归因且可重放。",
  },
  "{filtered} of {total} events": {
    en: "{filtered} of {total} events",
    "zh-CN": "{filtered} / {total} 个事件",
  },
  "Filter audit events": { en: "Filter audit events", "zh-CN": "筛选审计事件" },
  "Filter events": { en: "Filter events", "zh-CN": "筛选事件" },
  "Loading the audit stream": {
    en: "Loading the audit stream",
    "zh-CN": "正在载入审计流",
  },
  "Replaying sequenced project events…": {
    en: "Replaying sequenced project events…",
    "zh-CN": "正在重放有序项目事件…",
  },
  "Unable to load the audit stream": {
    en: "Unable to load the audit stream",
    "zh-CN": "无法载入审计流",
  },
  "Try again": { en: "Try again", "zh-CN": "重试" },
  "Sequenced project events": {
    en: "Sequenced project events",
    "zh-CN": "有序项目事件",
  },
  Sequence: { en: "SEQ", "zh-CN": "序列" },
  Time: { en: "TIME", "zh-CN": "时间" },
  Event: { en: "EVENT", "zh-CN": "事件" },
  Actor: { en: "ACTOR", "zh-CN": "执行者" },
  Aggregate: { en: "AGGREGATE", "zh-CN": "聚合" },
  Detail: { en: "DETAIL", "zh-CN": "详情" },
  "No matching events": { en: "No matching events", "zh-CN": "没有匹配的事件" },
  "No audit events yet": { en: "No audit events yet", "zh-CN": "暂无审计事件" },
  "Adjust the filter to return to the complete event stream.": {
    en: "Adjust the filter to return to the complete event stream.",
    "zh-CN": "调整筛选条件以返回完整事件流。",
  },
  "Durable project mutations will appear here in sequence order.": {
    en: "Durable project mutations will appear here in sequence order.",
    "zh-CN": "持久化项目变更将按序列顺序显示在此处。",
  },
  "Independent assurance": { en: "INDEPENDENT ASSURANCE", "zh-CN": "独立保障" },
  "Review bundles": { en: "Review bundles", "zh-CN": "审查包" },
  "Immutable patches, explicit evidence, and blocking findings before DONE.": {
    en: "Immutable patches, explicit evidence, and blocking findings before DONE.",
    "zh-CN": "任务标记 DONE 前，要求不可变补丁、明确证据和阻断性发现。",
  },
  "{count} live": { en: "{count} live", "zh-CN": "{count} 个进行中" },
  "{count} approved": { en: "{count} approved", "zh-CN": "{count} 个已批准" },
  "Loading review bundles": {
    en: "Loading review bundles",
    "zh-CN": "正在载入审查包",
  },
  "Verifying immutable patches and finding state…": {
    en: "Verifying immutable patches and finding state…",
    "zh-CN": "正在验证不可变补丁和发现状态…",
  },
  "Unable to load review bundles": {
    en: "Unable to load review bundles",
    "zh-CN": "无法载入审查包",
  },
  "No review bundles": { en: "No review bundles", "zh-CN": "暂无审查包" },
  "A task author can request an immutable peer review after acceptance evidence is ready.": {
    en: "A task author can request an immutable peer review after acceptance evidence is ready.",
    "zh-CN": "验收证据就绪后，任务作者可请求不可变的同行审查。",
  },
  "Revision {revision}": { en: "REVISION {revision}", "zh-CN": "修订 {revision}" },
  Author: { en: "Author", "zh-CN": "作者" },
  Reviewer: { en: "Reviewer", "zh-CN": "审查者" },
  Files: { en: "Files", "zh-CN": "文件" },
  "Patch hash": { en: "Patch hash", "zh-CN": "补丁哈希" },
  "Acceptance criteria": { en: "Acceptance criteria", "zh-CN": "验收标准" },
  "{count} changed paths": {
    en: "{count} changed paths",
    "zh-CN": "{count} 个变更路径",
  },
  "{count} findings": { en: "{count} findings", "zh-CN": "{count} 个发现" },
  "Write safety": { en: "WRITE SAFETY", "zh-CN": "写入安全" },
  "Declared write overlap reconciled against actual Git changes.": {
    en: "Declared write overlap reconciled against actual Git changes.",
    "zh-CN": "将声明的写入重叠与实际 Git 变更进行核对。",
  },
  "No open write conflicts": {
    en: "No open write conflicts",
    "zh-CN": "没有未解决的写入冲突",
  },
  "Exclusive scopes and protected paths are currently clear.": {
    en: "Exclusive scopes and protected paths are currently clear.",
    "zh-CN": "当前独占范围和受保护路径均无冲突。",
  },
  "Write intent overlap": { en: "WRITE INTENT OVERLAP", "zh-CN": "写入意图重叠" },
  "No intersecting files or symbols were reported. Review the intent patterns before resolving.": {
    en: "No intersecting files or symbols were reported. Review the intent patterns before resolving.",
    "zh-CN": "未报告相交文件或符号。解决前请检查意图模式。",
  },
  "Mark conflict {id} resolved": {
    en: "Mark conflict {id} resolved",
    "zh-CN": "将冲突 {id} 标记为已解决",
  },
  "Resolving…": { en: "Resolving…", "zh-CN": "解决中…" },
  "Mark resolved": { en: "Mark resolved", "zh-CN": "标记为已解决" },
  Ready: { en: "Ready", "zh-CN": "就绪" },
  "In flight": { en: "In flight", "zh-CN": "进行中" },
  Review: { en: "Review", "zh-CN": "审查" },
  Done: { en: "Done", "zh-CN": "已完成" },
  "No implementation note supplied.": {
    en: "No implementation note supplied.",
    "zh-CN": "未提供实施说明。",
  },
  Evidence: { en: "Evidence", "zh-CN": "证据" },
  "Task inspector": { en: "Task inspector", "zh-CN": "任务检查器" },
  "Close task inspector": { en: "Close task inspector", "zh-CN": "关闭任务检查器" },
  "Loading task": { en: "Loading task", "zh-CN": "正在载入任务" },
  "Retrieving the latest version and acceptance evidence…": {
    en: "Retrieving the latest version and acceptance evidence…",
    "zh-CN": "正在获取最新版本和验收证据…",
  },
  "Unable to load this task": {
    en: "Unable to load this task",
    "zh-CN": "无法载入此任务",
  },
  Status: { en: "Status", "zh-CN": "状态" },
  Owner: { en: "Owner", "zh-CN": "负责人" },
  Version: { en: "Version", "zh-CN": "版本" },
  "Acceptance TODO": { en: "Acceptance TODO", "zh-CN": "验收 TODO" },
  "No TODO evidence.": { en: "No TODO evidence.", "zh-CN": "暂无 TODO 证据。" },
  "State transition": { en: "State transition", "zh-CN": "状态转换" },
  "Task state transition": { en: "Task state transition", "zh-CN": "任务状态转换" },
  "Move task to {status}": {
    en: "Move task to {status}",
    "zh-CN": "将任务移至 {status}",
  },
  "Task unavailable": { en: "Task unavailable", "zh-CN": "任务不可用" },
  "The selected task no longer exists or is outside this project.": {
    en: "The selected task no longer exists or is outside this project.",
    "zh-CN": "所选任务已不存在，或不属于此项目。",
  },
  "Create an active objective before adding tasks.": {
    en: "Create an active objective before adding tasks.",
    "zh-CN": "添加任务前请先创建当前目标。",
  },
  "Work orchestration": { en: "WORK ORCHESTRATION", "zh-CN": "工作编排" },
  "Create task": { en: "Create task", "zh-CN": "创建任务" },
  "Close task form": { en: "Close task form", "zh-CN": "关闭任务表单" },
  Title: { en: "Title", "zh-CN": "标题" },
  "Concrete, reviewable outcome": {
    en: "Concrete, reviewable outcome",
    "zh-CN": "具体、可审查的成果",
  },
  Description: { en: "Description", "zh-CN": "说明" },
  "Scope, constraints, and acceptance evidence": {
    en: "Scope, constraints, and acceptance evidence",
    "zh-CN": "范围、约束和验收证据",
  },
  "Initial state": { en: "Initial state", "zh-CN": "初始状态" },
  "Ready to claim": { en: "Ready to claim", "zh-CN": "可领取" },
  Backlog: { en: "Backlog", "zh-CN": "待办" },
  Priority: { en: "Priority", "zh-CN": "优先级" },
  Low: { en: "Low", "zh-CN": "低" },
  Normal: { en: "Normal", "zh-CN": "普通" },
  High: { en: "High", "zh-CN": "高" },
  Critical: { en: "Critical", "zh-CN": "紧急" },
  Cancel: { en: "Cancel", "zh-CN": "取消" },
  "Creating…": { en: "Creating…", "zh-CN": "创建中…" },
  "Task board": { en: "Task board", "zh-CN": "任务看板" },
  "Atomic ownership, evidence-weighted progress, and explicit review gates.": {
    en: "Atomic ownership, evidence-weighted progress, and explicit review gates.",
    "zh-CN": "原子化归属、证据加权进度和明确审查门禁。",
  },
  "Filter tasks": { en: "Filter tasks", "zh-CN": "筛选任务" },
  "Task visualization": { en: "Task visualization", "zh-CN": "任务可视化" },
  Board: { en: "Board", "zh-CN": "看板" },
  Dependencies: { en: "Dependencies", "zh-CN": "依赖关系" },
  "Create a task in the active objective": {
    en: "Create a task in the active objective",
    "zh-CN": "在当前目标中创建任务",
  },
  "Create an active objective before adding tasks": {
    en: "Create an active objective before adding tasks",
    "zh-CN": "添加任务前请先创建当前目标",
  },
  "New task": { en: "New task", "zh-CN": "新建任务" },
  "No tasks yet": { en: "No tasks yet", "zh-CN": "暂无任务" },
  "Adjust the filter to return to the full task board.": {
    en: "Adjust the filter to return to the full task board.",
    "zh-CN": "调整筛选条件以返回完整任务看板。",
  },
  "Create the first task for the active objective.": {
    en: "Create the first task for the active objective.",
    "zh-CN": "为当前目标创建第一个任务。",
  },
  "Create an active objective before adding work.": {
    en: "Create an active objective before adding work.",
    "zh-CN": "添加工作前请先创建当前目标。",
  },
  "No tasks in this state": {
    en: "No tasks in this state",
    "zh-CN": "此状态下没有任务",
  },
  "No dependency graph": { en: "No dependency graph", "zh-CN": "暂无依赖图" },
  "Create tasks to populate the objective graph.": {
    en: "Create tasks to populate the objective graph.",
    "zh-CN": "创建任务以填充目标图。",
  },
  Both: { en: "Both · Codex + Claude", "zh-CN": "两者 · Codex + Claude" },
  Background: { en: "Background", "zh-CN": "后台" },
  Important: { en: "Important", "zh-CN": "重要" },
  Interrupt: { en: "Interrupt", "zh-CN": "中断" },
  "Mailbox only": { en: "Mailbox only", "zh-CN": "仅收件箱" },
  "Safe next context": { en: "Safe next context", "zh-CN": "下个安全上下文" },
  "Checkpoint + ACK": { en: "Checkpoint + ACK", "zh-CN": "检查点 + ACK" },
  "Immediate steer + ACK": { en: "Immediate steer + ACK", "zh-CN": "立即引导 + ACK" },
  "Message control": { en: "MESSAGE CONTROL", "zh-CN": "消息控制" },
  "Threaded coordination with delivery, ACK, and processing evidence.": {
    en: "Threaded coordination with delivery, ACK, and processing evidence.",
    "zh-CN": "带投递、ACK 和处理证据的线程化协调。",
  },
  "Search communications": { en: "Search communications", "zh-CN": "搜索通信" },
  "Search sender, thread, or summary": {
    en: "Search sender, thread, or summary",
    "zh-CN": "搜索发送者、线程或摘要",
  },
  "Message priority": { en: "Message priority", "zh-CN": "消息优先级" },
  "Task scope": { en: "Task scope", "zh-CN": "任务范围" },
  "All tasks": { en: "All tasks", "zh-CN": "全部任务" },
  "All project messages": {
    en: "All project messages",
    "zh-CN": "当前项目的全部消息",
  },
  "{filtered} of {total} envelopes": {
    en: "{filtered} of {total} envelopes",
    "zh-CN": "{filtered} / {total} 个信封",
  },
  "Newest first": { en: "Newest first", "zh-CN": "最新优先" },
  "Loading communications": {
    en: "Loading communications",
    "zh-CN": "正在载入通信",
  },
  "Retrieving delivery, ACK, and response evidence…": {
    en: "Retrieving delivery, ACK, and response evidence…",
    "zh-CN": "正在获取投递、ACK 和响应证据…",
  },
  "Unable to load communications": {
    en: "Unable to load communications",
    "zh-CN": "无法载入通信",
  },
  Acknowledged: { en: "acknowledged", "zh-CN": "已确认" },
  Pending: { en: "pending", "zh-CN": "待处理" },
  "No matching envelopes": {
    en: "No matching envelopes",
    "zh-CN": "没有匹配的信封",
  },
  "Quiet channel": { en: "Quiet channel", "zh-CN": "安静频道" },
  "Adjust the search or priority filter.": {
    en: "Adjust the search or priority filter.",
    "zh-CN": "调整搜索或优先级筛选条件。",
  },
  "Coordination envelopes will appear here when agents begin collaborating.": {
    en: "Coordination envelopes will appear here when agents begin collaborating.",
    "zh-CN": "智能体开始协作后，协调信封将显示在此处。",
  },
  Compose: { en: "COMPOSE", "zh-CN": "撰写" },
  "Send coordination note": { en: "Send coordination note", "zh-CN": "发送协调备注" },
  "Message recipient": { en: "Message recipient", "zh-CN": "消息接收者" },
  "Recipient acknowledgement is required (ACK).": {
    en: "Recipient acknowledgement is required (ACK).",
    "zh-CN": "接收方必须确认（ACK）。",
  },
  "Acknowledgement is optional.": {
    en: "Acknowledgement is optional.",
    "zh-CN": "无需强制确认。",
  },
  Summary: { en: "Summary", "zh-CN": "摘要" },
  "Use for concrete coordination, not courtesy status.": {
    en: "Use for concrete coordination, not courtesy status.",
    "zh-CN": "用于具体协调，不用于礼节性状态通知。",
  },
  "Sending…": { en: "Sending…", "zh-CN": "发送中…" },
  "Send envelope": { en: "Send envelope", "zh-CN": "发送信封" },
  "Envelope sent at {time}.": {
    en: "Envelope sent at {time}.",
    "zh-CN": "信封已于 {time} 发送。",
  },
  Policy: { en: "POLICY", "zh-CN": "策略" },
  "Push semantics": { en: "Push semantics", "zh-CN": "推送语义" },
  "Immediate steer": { en: "Immediate steer", "zh-CN": "立即引导" },
  "Pending approval": { en: "Pending approval", "zh-CN": "待审批" },
  Granted: { en: "Granted", "zh-CN": "已授权" },
  Denied: { en: "Denied", "zh-CN": "已拒绝" },
  Revoked: { en: "Revoked", "zh-CN": "已撤销" },
  Expired: { en: "Expired", "zh-CN": "已过期" },
  "Does not expire automatically": {
    en: "Does not expire automatically",
    "zh-CN": "不会自动过期",
  },
  "Unrestricted local terminal": {
    en: "Unrestricted local terminal",
    "zh-CN": "不受限本地终端",
  },
  "Approved through the Dashboard": {
    en: "Approved through the Dashboard",
    "zh-CN": "用户通过 Dashboard 批准",
  },
  "Denied through the Dashboard": {
    en: "Denied through the Dashboard",
    "zh-CN": "用户通过 Dashboard 拒绝",
  },
  "Revoked through the Dashboard": {
    en: "Revoked through the Dashboard",
    "zh-CN": "用户通过 Dashboard 撤销",
  },
  "Approved for 24 hours": {
    en: "Approved for 24 hours",
    "zh-CN": "已批准 24 小时",
  },
  "Capability authorization": { en: "CAPABILITY AUTHORIZATION", "zh-CN": "能力授权" },
  "Terminal permissions": { en: "Terminal permissions", "zh-CN": "终端权限" },
  "This is an audit record, not cryptographic isolation": {
    en: "This is an audit record, not cryptographic isolation",
    "zh-CN": "这是审计记录，不是密码学隔离",
  },
  "A holder of the local token can still call the decision API. The Dashboard records the decision source, time, expiry, and revocation.":
    {
      en: "A holder of the local token can still call the decision API. The Dashboard records the decision source, time, expiry, and revocation.",
      "zh-CN": "本机 token 持有者仍可调用决策 API。Dashboard 会记录决策来源、时间、有效期和撤销。",
    },
  "Loading authorization records": {
    en: "Loading authorization records",
    "zh-CN": "正在读取授权记录",
  },
  "Unable to load authorization records": {
    en: "Unable to load authorization records",
    "zh-CN": "授权记录读取失败",
  },
  Retry: { en: "Retry", "zh-CN": "重试" },
  "Pending requests": { en: "Pending requests", "zh-CN": "待审批请求" },
  "Only decisions clicked here are marked as originating from the Dashboard.": {
    en: "Only decisions clicked here are marked as originating from the Dashboard.",
    "zh-CN": "只有这里的点击决策会被标记为 Dashboard 来源。",
  },
  "{count} items": { en: "{count} items", "zh-CN": "{count} 项" },
  "There are no pending permission requests.": {
    en: "There are no pending permission requests.",
    "zh-CN": "当前没有等待处理的权限请求。",
  },
  "Requesting Agent": { en: "Requesting Agent", "zh-CN": "发起 Agent" },
  "Requested at": { en: "Requested at", "zh-CN": "申请时间" },
  Deny: { en: "Deny", "zh-CN": "拒绝" },
  Processing: { en: "Processing", "zh-CN": "处理中" },
  "Approve for 24 hours": { en: "Approve for 24 hours", "zh-CN": "批准 24 小时" },
  "Active authorizations": { en: "Active authorizations", "zh-CN": "有效授权" },
  "Authorizations expire automatically and can be revoked by the user at any time.": {
    en: "Authorizations expire automatically and can be revoked by the user at any time.",
    "zh-CN": "到期后自动失效，也可由用户随时撤销。",
  },
  "There are no active authorizations.": {
    en: "There are no active authorizations.",
    "zh-CN": "当前没有有效授权。",
  },
  "Approval source": { en: "Approval source", "zh-CN": "批准来源" },
  "Dashboard click": { en: "Dashboard click", "zh-CN": "Dashboard 点击" },
  "Expires at": { en: "Expires at", "zh-CN": "到期时间" },
  "Revoke authorization": { en: "Revoke authorization", "zh-CN": "撤销授权" },
  "Settings & runtime": { en: "Settings & runtime", "zh-CN": "设置与运行状态" },
  "Inspect project policy, capability authorizations, persistence, and local security boundaries.":
    {
      en: "Inspect project policy, capability authorizations, persistence, and local security boundaries.",
      "zh-CN": "查看项目策略、能力授权、持久化状态和本地安全边界。",
    },
  "Project policy": { en: "PROJECT POLICY", "zh-CN": "项目策略" },
  Configuration: { en: "Configuration", "zh-CN": "配置" },
  "Validated JSON": { en: "Validated JSON", "zh-CN": "经过校验的 JSON" },
  "Settings saved at {time}": {
    en: "Settings saved at {time}",
    "zh-CN": "设置已保存于 {time}",
  },
  Saving: { en: "Saving", "zh-CN": "正在保存" },
  "Save settings": { en: "Save settings", "zh-CN": "保存设置" },
  Runtime: { en: "RUNTIME", "zh-CN": "运行时" },
  "Service status": { en: "Service status", "zh-CN": "服务状态" },
  None: { en: "None", "zh-CN": "无" },
  "Heartbeat lag": { en: "Heartbeat lag", "zh-CN": "心跳延迟" },
  "Network boundary": { en: "Network boundary", "zh-CN": "网络边界" },
  "Loopback + token": { en: "Loopback + token", "zh-CN": "本机回环 + token" },
  Adapters: { en: "ADAPTERS", "zh-CN": "适配器" },
  "Delivery methods": { en: "Delivery methods", "zh-CN": "投递方式" },
  "No adapters observed yet.": {
    en: "No adapters observed yet.",
    "zh-CN": "尚未观察到适配器。",
  },
  Boundaries: { en: "BOUNDARIES", "zh-CN": "边界" },
  "Security guarantees": { en: "Security guarantees", "zh-CN": "安全保证" },
  "Binds only to 127.0.0.1": {
    en: "Binds only to 127.0.0.1",
    "zh-CN": "仅绑定 127.0.0.1",
  },
  "Bearer or HttpOnly launch session": {
    en: "Bearer or HttpOnly launch session",
    "zh-CN": "Bearer 或 HttpOnly 启动会话",
  },
  "Capability authorization before PTY launch": {
    en: "Capability authorization before PTY launch",
    "zh-CN": "PTY 启动前检查能力授权",
  },
  "Bounded payload sizes and event replay": {
    en: "Bounded payload sizes and event replay",
    "zh-CN": "限制负载大小与事件重放",
  },
  "Secret-redacted diagnostic exports": {
    en: "Secret-redacted diagnostic exports",
    "zh-CN": "诊断导出自动隐去密钥",
  },
  "Not started": { en: "Not started", "zh-CN": "尚未启动" },
  Launching: { en: "Launching", "zh-CN": "正在启动" },
  Connecting: { en: "Connecting", "zh-CN": "正在连接" },
  "Terminal online": { en: "Terminal online", "zh-CN": "终端在线" },
  Disconnected: { en: "Disconnected", "zh-CN": "连接已断开" },
  "Control permission revoked": {
    en: "Control permission revoked",
    "zh-CN": "控制权限已撤销",
  },
  "Process exited": { en: "Process exited", "zh-CN": "进程已退出" },
  Stopping: { en: "Stopping", "zh-CN": "正在终止" },
  "Terminal error": { en: "Terminal error", "zh-CN": "终端错误" },
  "Local PTY": { en: "Local PTY", "zh-CN": "本机 PTY" },
  "{agent} model": { en: "{agent} model", "zh-CN": "{agent} 模型" },
  "Loading models…": { en: "Loading models…", "zh-CN": "正在载入模型…" },
  "No models available": { en: "No models available", "zh-CN": "没有可用模型" },
  "Unable to load the model registry. Try again.": {
    en: "Unable to load the model registry. Try again.",
    "zh-CN": "模型注册表载入失败，请重试。",
  },
  "No model presets are enabled for this Agent. Enable one in the model registry first.": {
    en: "No model presets are enabled for this Agent. Enable one in the model registry first.",
    "zh-CN": "当前 Agent 没有已启用的模型预设。请先在模型注册表中启用一个预设。",
  },
  "{agent} reasoning effort": {
    en: "{agent} reasoning effort",
    "zh-CN": "{agent} 推理强度",
  },
  "Model default": { en: "Model default", "zh-CN": "模型默认" },
  Unavailable: { en: "Unavailable", "zh-CN": "不可用" },
  "This model does not expose reasoning-effort options. The model default will be used.": {
    en: "This model does not expose reasoning-effort options. The model default will be used.",
    "zh-CN": "该模型不提供推理强度选项，将使用模型默认值。",
  },
  "New terminal": { en: "New terminal", "zh-CN": "新建终端" },
  "{agent} session": { en: "{agent} session", "zh-CN": "{agent} 会话" },
  "Not selected": { en: "Not selected", "zh-CN": "未选择" },
  Exited: { en: "Exited", "zh-CN": "已退出" },
  Running: { en: "Running", "zh-CN": "运行中" },
  Connect: { en: "Connect", "zh-CN": "连接" },
  "Confirm terminate": { en: "Confirm terminate", "zh-CN": "确认终止" },
  Terminate: { en: "Terminate", "zh-CN": "终止" },
  "Waiting for explicit launch": {
    en: "Waiting for explicit launch",
    "zh-CN": "等待显式启动",
  },
  "Select a model, then click New terminal. No command runs automatically here.": {
    en: "Select a model, then click New terminal. No command runs automatically here.",
    "zh-CN": "选择模型后点击“新建终端”。这里不会自动执行任何命令。",
  },
  "Terminal control locked": {
    en: "Terminal control locked",
    "zh-CN": "终端控制已锁定",
  },
  "The server detached the attachment. Reauthorize, then click Connect manually.": {
    en: "The server detached the attachment. Reauthorize, then click Connect manually.",
    "zh-CN": "服务端已断开 attachment。重新授权后手动点击“连接”。",
  },
  "Ctrl+C is sent directly by you inside the terminal": {
    en: "Ctrl+C is sent directly by you inside the terminal",
    "zh-CN": "Ctrl+C 由你在终端内直接发送",
  },
  "Exit code {code}": { en: "Exit code {code}", "zh-CN": "退出码 {code}" },
  "Input goes directly to the local PTY": {
    en: "Input goes directly to the local PTY",
    "zh-CN": "输入直达本机 PTY",
  },
  "Local command surface": { en: "LOCAL COMMAND SURFACE", "zh-CN": "本地命令界面" },
  "Dual terminal console": { en: "Dual terminal console", "zh-CN": "双终端主控台" },
  "Codex CLI and Claude Code each run in a real local PTY, and their sessions persist across page navigation.":
    {
      en: "Codex CLI and Claude Code each run in a real local PTY, and their sessions persist across page navigation.",
      "zh-CN": "Codex CLI 与 Claude Code 各自运行在真实本机 PTY，会话切页后仍保持。",
    },
  "Unrestricted local commands": {
    en: "Unrestricted local commands",
    "zh-CN": "不受限本地命令",
  },
  "Only text you type or paste in the terminal is sent. Closing the page does not terminate the process.":
    {
      en: "Only text you type or paste in the terminal is sent. Closing the page does not terminate the process.",
      "zh-CN": "只有你在终端内输入或粘贴的内容会被发送。关闭页面不会终止进程。",
    },
  "Launch a local CLI from the Dashboard dual terminal console": {
    en: "Launch a local CLI from the Dashboard dual terminal console",
    "zh-CN": "在 Dashboard 双终端主控台中启动本地 CLI",
  },
  "Authorization request created. Approve it on the Settings page.": {
    en: "Authorization request created. Approve it on the Settings page.",
    "zh-CN": "授权请求已创建，请前往设置页批准。",
  },
  "Terminal authorization pending": {
    en: "Terminal authorization pending",
    "zh-CN": "终端授权等待批准",
  },
  "Terminal authorization required": {
    en: "Terminal authorization required",
    "zh-CN": "需要终端授权",
  },
  "The request already exists. Approve it on the Settings page, then return and connect manually.":
    {
      en: "The request already exists. Approve it on the Settings page, then return and connect manually.",
      "zh-CN": "请求已经存在。请在设置页完成批准，然后回到这里手动连接。",
    },
  "Before launching any local command, create and approve terminal.unrestricted authorization.": {
    en: "Before launching any local command, create and approve terminal.unrestricted authorization.",
    "zh-CN": "启动任意本地命令前，必须先创建并批准 terminal.unrestricted 授权。",
  },
  "Creating request": { en: "Creating request", "zh-CN": "正在创建" },
  "Create authorization request": {
    en: "Create authorization request",
    "zh-CN": "创建授权请求",
  },
  "Open Settings to approve": {
    en: "Open Settings to approve",
    "zh-CN": "前往设置批准",
  },
  "Terminal permission is not active yet. Approve it in Settings first.": {
    en: "Terminal permission is not active yet. Approve it in Settings first.",
    "zh-CN": "终端权限尚未生效，请先在设置中批准。",
  },
  "The terminal returned data that could not be parsed.": {
    en: "The terminal returned data that could not be parsed.",
    "zh-CN": "终端返回了无法解析的数据。",
  },
  "Terminal authorization was revoked and must be approved again.": {
    en: "Terminal authorization was revoked and must be approved again.",
    "zh-CN": "终端授权已撤销，需要重新批准。",
  },
  "The WebSocket connection failed. The terminal process will not be terminated.": {
    en: "The WebSocket connection failed. The terminal process will not be terminated.",
    "zh-CN": "WebSocket 连接失败，终端进程不会因此被终止。",
  },
  "The previous connection ended because permission was revoked. Approve it again, then connect manually.":
    {
      en: "The previous connection ended because permission was revoked. Approve it again, then connect manually.",
      "zh-CN": "上一次连接因权限撤销而结束。重新批准后，请手动连接。",
    },
  "Terminal control permission was revoked. The process is still running and can be reconnected after approval.":
    {
      en: "Terminal control permission was revoked. The process is still running and can be reconnected after approval.",
      "zh-CN": "终端控制权限已撤销。进程仍在运行，重新批准后才能连接。",
    },
  "The selected reasoning effort is not supported by the current model. Choose another value.": {
    en: "The selected reasoning effort is not supported by the current model. Choose another value.",
    "zh-CN": "所选推理强度不受当前模型支持，请重新选择。",
  },
  Interface: { en: "Interface", "zh-CN": "界面" },
  Language: { en: "Language", "zh-CN": "语言" },
  "Follow the browser": { en: "Follow the browser", "zh-CN": "跟随浏览器" },
  "Switching the language reloads the Dashboard.": {
    en: "Switching the language reloads the Dashboard.",
    "zh-CN": "切换语言会重新载入 Dashboard。",
  },
} as const satisfies Record<string, Message>;

export type MessageKey = keyof typeof messageCatalog;
export type MessageValues = Record<string, string | number>;

export function resolveLocale(languages?: readonly string[]): DashboardLocale {
  const candidates =
    languages ??
    (typeof navigator === "undefined"
      ? []
      : navigator.languages.length
        ? navigator.languages
        : [navigator.language]);
  return candidates.some((language) => language.trim().toLowerCase().startsWith("zh"))
    ? "zh-CN"
    : "en";
}

const localeStorageKey = "crossagent.locale";

function isSupported(value: unknown): value is DashboardLocale {
  return supportedLocales.includes(value as DashboardLocale);
}

/** The manual choice, or null when the Dashboard is following the browser. */
export function localeOverride(): DashboardLocale | null {
  try {
    const stored = window.localStorage.getItem(localeStorageKey);
    return isSupported(stored) ? stored : null;
  } catch {
    return null;
  }
}

// Resolved once, at module load. Much of the Dashboard calls t() at module scope -- the whole
// navigation in layout.tsx, the priority options in communications.tsx, the authorization status
// labels in settings.tsx -- so the language is baked into module state before anything renders.
// Re-deriving it from navigator on every t() call therefore paid for a lookup that could not
// change its own answer.
const activeLocale: DashboardLocale = localeOverride() ?? resolveLocale();

export function dashboardLocale(): DashboardLocale {
  return activeLocale;
}

/**
 * Record a manual choice, or clear it to follow the browser again, then reload.
 *
 * The reload is the point rather than a shortcut: the module-scope t() calls above already hold
 * strings in the old language, and no re-render reaches them. Reloading is what actually makes the
 * whole surface consistent, and on a loopback Dashboard it costs nothing.
 */
export function setLocaleOverride(locale: DashboardLocale | null): void {
  try {
    if (locale) window.localStorage.setItem(localeStorageKey, locale);
    else window.localStorage.removeItem(localeStorageKey);
  } catch {
    return;
  }
  window.location.reload();
}

export function localeTag(locale: DashboardLocale = activeLocale): string {
  return locale === "zh-CN" ? "zh-CN" : "en-GB";
}

export function translate(
  locale: DashboardLocale,
  key: MessageKey,
  values: MessageValues = {},
): string {
  return Object.entries(values).reduce<string>(
    (message, [name, value]) => message.replaceAll(`{${name}}`, String(value)),
    messageCatalog[key][locale] as string,
  );
}

export function t(key: MessageKey, values?: MessageValues): string {
  return translate(activeLocale, key, values);
}
