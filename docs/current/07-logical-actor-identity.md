# 自动化 GitHub 回写的 Logical Actor Identity

Status: V1 Contract（Issue #78）

## 目标

Runner、Implementer、Coordinator 可以继续复用现有 GitHub authentication identity，同时让 GitHub 上的自动化业务评论明确表达“是哪一个逻辑角色在发言”。

GitHub author / authenticated account 负责认证、授权和 GitHub 审计主体；Logical Actor 只表达自动化工作流里的角色来源。二者是不同层次，不要求一一对应，也不得互相替代。

## V1 Logical Actor

V1 只定义两个业务 Logical Actor：

- `implementer`
- `coordinator`

Runner 自己的接单／启动失败控制反馈已经以 `BOT:<runnerName>` 开头，继续沿用现有格式；V1 不为这类 Runner 控制反馈再增加 `runner` Logical Actor。

人类维护者的普通评论不自动增加 Actor 标记，也不根据 GitHub author、评论内容或历史上下文反推其 Logical Actor。

## 可见标记

Implementer / Coordinator 自己发布的自动化业务评论必须包含一个紧凑、可见的 Actor 标记：

```text
---
Actor: implementer
```

或：

```text
---
Actor: coordinator
```

V1 只强制 `Actor`。不要求每条评论增加 `sessionId`、`conversationId`、机器路径、token 或其他 provenance 字段；以后若真实审计需求证明有必要，再通过独立 Issue 扩展。

Actor 标记是给人和自动化阅读的来源说明，不是安全凭据。缺失、伪造或改写 Actor 标记都不能取得额外权限。

## 与控制命令尾部规则兼容

现有 Runner / Coordinator trigger Contract 要求控制评论 trim 后以控制命令结尾：

- Implementer → Coordinator：`@COORDINATOR`
- Coordinator → Implementer：`@<runnerName>`

因此，带控制交接的评论必须把 Actor 标记放在最终控制命令之前，不能把任何 Actor metadata 追加到控制命令之后。

Implementer 示例：

```text
……协调请求、依据与 return-to 说明……

---
Actor: implementer

@COORDINATOR
```

Coordinator 示例：

```text
……协调结论与下一步……

---
Actor: coordinator

@MBP01
```

普通、不承担控制触发的自动化业务评论可以让 Actor 标记位于正文末尾。

## Authentication / Authorization 边界

Logical Actor 不改变任何现有 GitHub authentication / authorization 规则：

- Runner / Implementer 继续复用实际运行账户已经认证的本机 `gh`；
- Coordinator 继续按其 Contract 使用 ChatGPT 已连接的 GitHub connector；
- 两端实际 GitHub 写回身份仍必须满足目标仓库的 `allowedActors`；
- `allowedActors` 检查真实 GitHub 写回身份，不读取 `Actor:` 文本决定授权；
- Actor 标记不能绕过、扩大或替代 GitHub 权限、仓库 allowlist、Runner trigger 授权或 Maintainer 权限。

V1 不创建新的 GitHub machine user，不为 Implementer / Coordinator 拆独立普通用户，不引入 GitHub App，也不重构 PAT、SSH Key 或 `gh auth`。以后若权限隔离或 GitHub 原生 bot identity 成为真实需求，再独立评估。

## Runner → Implementer

Runner 唤醒 Harness / Dev 时，应把当前自动化角色明确为 `implementer`，并要求 Dev：

1. 自己的 GitHub 业务评论按本 Contract 标记 `Actor: implementer`；
2. 如果评论末尾承担 `@COORDINATOR` 或 `@<runnerName>` 控制触发，Actor 标记必须位于最终控制命令之前；
3. 不把 Actor 标记当作授权或 Maintainer 身份；
4. 不因为标记要求而改变 Issue / PR / Review 的既有业务内容和交接语义。

这是轻量 attribution，不建立 actor registry、数据库或第二套身份系统。

## Coordinator

Coordinator 被唤醒时，其 logical actor 固定为 `coordinator`。Coordinator 自己写回 GitHub 的业务评论按本 Contract标记 `Actor: coordinator`。

Coordinator 回写 return-to Runner 时，`@<runnerName>` 仍必须是 trim 后的最后控制命令；Actor 标记放在它之前。若需要 Maintainer 决定而不 return-to，则 Actor 标记可位于正文末尾。

本 Contract 不表示仓库内 Safari / Coordinator 运行代码已经实现，也不借本任务扩大 Coordinator 功能 Scope。

## V1 不做

- 为角色建立独立 GitHub 用户；
- GitHub App / bot account；
- PAT / SSH / `gh auth` 重构；
- actor registry、数据库或中央身份服务；
- 根据 Actor 文本授权；
- 强制 session / conversation / machine provenance；
- 顺带实现完整 Coordinator / Safari 通道。
