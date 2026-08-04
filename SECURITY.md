# Security Policy / 安全策略

## Supported versions / 支持的版本

CrossAgent Hub is alpha software. Only the current `main` is supported; there are no backports to
earlier tags.

CrossAgent Hub 是 alpha 阶段的软件。只有当前的 `main` 受支持，不会向更早的 tag 回移修复。

## Reporting a vulnerability / 报告漏洞

Use GitHub's private vulnerability reporting on this repository:
[Report a vulnerability](https://github.com/ayanamislover/ayanamiAgent-Hub/security/advisories/new).
Please do not open a public issue for a security problem.

请使用本仓库的 GitHub 私密漏洞报告：
[Report a vulnerability](https://github.com/ayanamislover/ayanamiAgent-Hub/security/advisories/new)。
请不要用公开 issue 提交安全问题。

Include what you did, what happened, and what you expected. Never paste the contents of a token
file, a session ticket, or a database — a path, a byte length, or a SHA-256 digest is enough to
describe them.

请说明你做了什么、发生了什么、你预期的是什么。**不要**粘贴任何 token 文件、session ticket 或数据库
的内容——用路径、字节长度或 SHA-256 摘要来描述就够了。

This is an unpaid personal project: there is no bounty and no response-time guarantee.

这是一个无偿的个人项目：没有赏金，也不保证响应时间。

## What is in scope / 哪些属于范围内

The Hub binds `127.0.0.1` and is designed for a single local user. Credentials live under
`~/.crossagent` with owner-only permissions. Reports that matter most are the ones that break one of
these boundaries:

Hub 绑定 `127.0.0.1`，面向单个本地用户设计。凭据存放在 `~/.crossagent`，仅所有者可访问。最有价值的
报告是能打破以下边界的：

- reaching the Hub, the Dashboard, or a terminal session from off the loopback interface
  （从 loopback 之外访问 Hub、Dashboard 或终端会话）
- acting with an authority a credential was not granted — a static credential used on the data
  plane, a session ticket used outside its purpose or its bound session, or an Agent identity one
  principal can claim but was never issued
  （越权行为：静态凭据被用于数据平面、session ticket 越出其 purpose 或绑定的会话、以及冒用未被签发的
  Agent 身份）
- a token, ticket, or user prompt reaching a log, an error message, a URL, or an event payload
  （token、ticket 或用户输入出现在日志、错误信息、URL 或事件负载中）
- forging the provenance of a user directive, a review verdict, or an audit event
  （伪造用户指令、评审结论或审计事件的来源）

Known gaps are already written down in [docs/known-limitations.md](docs/known-limitations.md) — they
are documented, not secret, so please file those as ordinary issues.

已知的缺口都写在 [docs/known-limitations.md](docs/known-limitations.md) 里——它们是公开记录的，不是
秘密，请用普通 issue 提交。
