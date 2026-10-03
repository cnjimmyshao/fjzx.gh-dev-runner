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
5. 本消息只负责指向任务，不是需求正文；
6. 本轮 Dev 的 Logical Actor 是 `implementer`；Dev 自己发布 GitHub 业务评论时按 [Logical Actor Identity](07-logical-actor-identity.md) 标记 `Actor: implementer`，且不得破坏 `@COORDINATOR` / `@<runnerName>` 必须位于控制评论末尾的规则；
7. START 与 RESUME 都提醒 Dev 依据目标项目规则执行范围核对、Finding 判断、重复修复复盘和验收收口，不把 Review 评论或级别标签直接升级为新的 Requirement。

共享核心应保持短小，不复制整套 AGENTS，也不维护第二份项目工作方法。

### Scope 与 Review 处理提醒

本节由 [Issue #81](https://github.com/cnjimmyshao/fjzx.gh-dev-runner/issues/81) 跟进，随独立 documentation-only PR Review / Merge 后成为实现依据；消息代码与样例通过后续独立 Implementation Issue / PR 落实。它将 [AGENTS](../../AGENTS.md) 已有的范围、Review、修复与交接原则转成唤醒提醒，目标项目 AGENTS、Current 与 Issue 最新决定仍负责具体要求和授权。

共享消息中的提醒覆盖以下动作：

1. **修改前核对边界。** Dev 实际读取依据后，核对本次 Scope、非目标、Acceptance 及最新暂停 / 冻结决定；普通 Finding 不解除 Scope Freeze，也不扩大既有授权。
2. **每批 Finding 先判断。** Dev 核实运行前提、违反的已确认要求与具体后果，并简短说明修复、证据回应、Follow-up 或待决事项的依据。已授权范围内的明确缺陷仍由 Implementer 自主处理；额外增强记录 Follow-up；现有依据无法决定的 Scope / Contract / 保障范围改变，按目标项目规则交接。判断可沿用 PR 线程或 Issue 现有记录，不要求固定表格、重复完整日志或逐条人工审批。
3. **重复修复时复盘。** 同根因反复出现、补丁持续增加例外或修复将扩大 Scope 时，先审视根因和责任边界；需要协调 / 更高权限决定的问题在原 Issue 交接。不受影响的工作继续；只有待决事项阻塞全部剩余工作时，才结束本轮调用并保留原任务、分支、PR 与 session。普通任务完成仍按既有调用语义退出。
4. **按验收证据收口。** Dev 按已确认 Acceptance 与当前 head 的实际证据判断交付，分别报告实现、Review 和验收状态；不能把所有 Review 评论消失或所有 P1/P2/P3 清零作为无范围限定的完成条件。真实正确性、安全性问题、已承诺场景的缺陷及本 PR 新增代码引入的真实回归仍须处理，不能仅因位于外围工具就称为 Follow-up；必要时可在既有授权内移除不必要的新增实现。

可采用以下简短措辞，具体任务事实仍由 Dev 自行读取，不由 Runner 填写：

```text
开始或恢复修改前，依据目标项目规则和 Issue 最新决定核对本次 Scope、非目标、Acceptance 及暂停／冻结要求；先确认边界再修改。
处理每批 Review Finding 前，先核实前提、违反的已确认要求与具体后果，并简短记录修复、证据回应、Follow-up 或待决事项的判断依据；不按 P1/P2/P3 标签机械增加代码。
同根因反复出现、补丁持续增加例外或修复将扩大 Scope 时，先复盘责任边界，按目标项目规则在原 Issue 交接需要协调／决定的问题；继续不受影响的工作，只有待决事项阻塞全部剩余工作时才结束本轮调用并保留已有任务。
按已确认 Acceptance 与当前 head 的实际证据判断交付，区分实现、Review 和验收状态；不以所有 Review 评论消失或 P1/P2/P3 清零作为无范围限定的完成条件，不忽略真实缺陷或既有承诺。
```

这些文字提醒 Dev 执行目标项目规则，不要求 Runner 读取并裁决 Finding、不规定固定 Review 轮数，也不把 Coordinator 或 Maintainer 审批加入每个普通修复步骤。若目标项目对交接方式或暂停 / 冻结另有明确决定，Dev 遵循该决定；只有剩余工作确实依赖用户或维护者时才交接等待。

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

### 等待 Maintainer 决定后的 RESUME

Dev 在开发过程中遇到必须由 Maintainer 决定、且已经没有不依赖该决定的工作可继续时，应把待决问题回贴原关联 Issue，然后结束本轮 Harness 调用。等待人工决定不是任务完成：原 task binding、workspace、branch、已有 PR 与 sessionId 都继续保留。

等待期间不要求 Harness / Dev 自己定时轮询 Issue，也不向已经运行的 Harness 动态注入后续评论。Maintainer 的普通回复只记录讨论或决定。需要继续时应发布新的控制评论；Runner 在后续正常 polling 中扫描水位之后的新评论，把水位推进到本轮扫描终点，并只选择其中最新一条来自授权主体、不是 `BOT:` 自动反馈且以 `@<runnerName>` 结尾的有效控制评论；有则表示“现在继续执行”并以 RESUME 续接原 session。普通／未授权／`BOT:` 评论不覆盖合法控制评论；若又有更新的有效控制评论，则只执行更新的那一条。

这类 RESUME 与其他 RESUME 使用同一刷新规则：Dev 必须先读取 Issue 最新决定、相关 PR / Review、当前 head、AGENTS 与 Current，再从已有工作继续，不因等待过人工决定而新建 session、分支或重复 PR。

## 动态字段边界

Runner 只把已经过授权和路由校验的结构化身份写入消息。首版允许：

- repository；
- Issue number / URL；
- trigger source（Issue Body 或 Comment）及其可用 URL / id；
- requester；
- START / RESUME 类型；
- 固定 Logical Actor：`implementer`。

Logical Actor 是轻量 attribution，不是权限字段；Runner 不允许从任意 GitHub 文本接受或覆盖该值。V1 不需要把 Actor 建成可配置 registry。

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

## 配置样例与 sessionId 边界

仓库提供 [`prompts.example.json`](../../prompts.example.json) 作为可手工调整措辞的样例。样例使用“共享核心 + START / RESUME 模式文本”的组合，并只暴露本文允许的结构化占位符。

该样例目前只是配置格式与措辞示意，**不表示当前 Runner 运行代码已经读取该文件**。后续实现可以把它作为默认模板或本机覆盖模板的来源，但配置不能删除或反转本文规定的核心语义；Current Contract 仍高于具体模板文字。

sessionId 不属于 Dev 消息必须重复描述的业务上下文。Runner 在 RESUME 时应从本机 task binding 取得已保存的 sessionId，并通过 Harness 的正式启动／续接参数传递；Dev 消息只需明确“这是同一任务既有 session 的续接”，避免把 session 身份同时维护在命令参数和 prompt 两处。

## 与实现的关系

本文件先定义行为 Contract，不表示当前代码已经实现 START / RESUME 两种消息。

实现必须在本文件合并成为 Current 后，通过独立 Implementation Issue / PR 完成。实现时应有自动测试证明：

- START 与 RESUME 的语义确实不同；
- 两种消息都包含正确任务坐标与共享核心；
- RESUME 会要求刷新 Issue / PR / Review / 当前 head，并明确不要重复开工；
- 两种消息都包含上述 Scope 与 Review 提醒，且不覆盖目标项目规则、暂停 / 冻结决定或授权；
- 消息不会把 Issue / Review 正文、本机路径或凭证带入 Harness；
- 修改消息模板不改变 Runner 与 Dev 的既有职责边界。
