# Runner → Dev 唤醒消息协议

## 定位

Runner 负责把正确的目标任务交给 Harness / DeepSeek Dev，并在已有绑定时续接原 session。唤醒消息只提供任务坐标与工作方式，不复制或重写业务需求。

目标项目的 `AGENTS.md`、`docs/current/`、关联 Issue 的最新决定、现有 PR / Review 与当前代码状态才是业务事实来源。Runner 消息不是第二份 Requirement，也不因为它写了某句话就覆盖仓库中的当前规范。

## 两种调用语义

Runner 必须区分两类唤醒：

- **START**：该任务首次建立 Harness session。
- **RESUME**：该任务已经有持久化 session，本轮继续同一任务，不是新任务。

两种消息共享一小段固定核心规则，但各自强调不同动作。不得用一段无法区分首次与续接语义的万能文本代替。

## 共享核心

每次唤醒至少让 Dev 明确：

1. 自己是被 Runner 唤醒来处理一个明确 GitHub Issue 的 Dev；
2. 必须实际读取目标仓库当前的 AGENTS、Current、Issue 与相关 PR / Review，不能假设 session 中已有认识仍然最新；
3. 分析、编码、测试、提交 PR、处理 Review 与提出待决问题由 Dev 按目标项目规则完成；
4. 需要 Maintainer 决定或授权的事项回到关联 Issue；
5. 本消息只负责指向任务，不是需求正文。

共享核心应保持短小，不复制整套 AGENTS，也不维护第二份项目工作方法。

## START

START 用于首次创建该任务的 Harness session。

消息应包含最小任务坐标：

- repository；
- Issue number 与 Issue URL；
- 触发来源（Issue Body 或 Comment）及其可用的 URL / id；
- 请求人身份。

START 应明确要求 Dev：

- 先读取目标项目 AGENTS、文档导航、Current、Issue 全文与最新评论；
- 核对是否已经存在相关分支、PR、Review 或未提交工作；
- 在确认当前事实和工作状态后再开始实际开发；
- 不根据启动消息复述或猜测需求，不因为是新 session 就忽略仓库已有工作。

Runner 的 machine / runnerId 属于本机路由与诊断信息，首版不作为 Dev 必需的业务上下文写入消息。

## RESUME

RESUME 用于已有任务绑定和 sessionId 的后续调用。

消息必须明确：

- 这是同一任务既有 session 的继续，不是新任务；
- 保留原 session 上下文是为了避免失忆，不代表旧上下文仍然是最新事实；
- 先刷新关联 Issue 的最新讨论与决定、现有 PR 的最新 Review、当前 head 和必要的仓库文档；
- 如果 AGENTS / Current 已更新，按当前版本工作；
- 以 GitHub 与仓库当前状态覆盖 session 中已经过时的认识；
- 从现有工作目录、分支和 PR 继续，不重新从头开发，不创建重复 PR。

因此，session resume 解决“不要失忆”，RESUME 消息负责解决“不要把旧记忆当作最新事实”。

## 动态字段边界

Runner 只把已经过授权和路由校验的结构化身份写入消息。首版允许：

- repository；
- Issue number / URL；
- trigger source（Issue Body 或 Comment）及其可用 URL / id；
- requester；
- START / RESUME 类型。

不把任意 GitHub 文本直接拼成指令。触发 Body / Comment 的正文无需复制；当前命令本身只代表“开始 / 继续”。

如果实现为了本机排查需要记录消息协议版本，可在本机调用记录里保存轻量版本标识；这不是业务 Contract，也不要求建设 prompt 版本迁移系统。

## 不进入唤醒消息的内容

Runner 不在唤醒消息中复制、总结或推断：

- Issue body；
- 普通评论正文或最新评论全文；
- PR Review / Finding 全文；
- “当前应该修哪一条 Finding”之类的业务判断；
- 未经目标 Issue / 项目规则明确授权的 merge、close、deploy 等动作；
- Harness 的 `completed`、exit code 或 Runner 本机状态所推导出的“业务已完成”结论；
- 本机绝对路径、凭证、API Key、完整 stdout / stderr 或原始日志。

这些边界避免 Runner 逐渐演变成第二个 Coordinator 或第二份需求来源。

## 与实现的关系

本文件先定义行为 Contract，不表示当前代码已经实现 START / RESUME 两种消息。

实现必须在本文件合并成为 Current 后，通过独立 Implementation Issue / PR 完成。实现时应有自动测试证明：

- START 与 RESUME 的语义确实不同；
- 两种消息都包含正确任务坐标与共享核心；
- RESUME 会要求刷新 Issue / PR / Review / 当前 head，并明确不要重复开工；
- 消息不会把 Issue / Review 正文、本机路径或凭证带入 Harness；
- 修改消息模板不改变 Runner 与 Dev 的既有职责边界。
