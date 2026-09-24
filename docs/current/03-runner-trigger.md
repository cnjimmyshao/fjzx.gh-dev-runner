# Runner 激活与任务触发 Contract

Status: V1 Contract（Issue #25）

## 目标

首版只解决一件事：让明确接入的本地 Runner 能从 GitHub Issue 内容中识别“现在开始／继续工作”的请求，并以最少的 GitHub 状态反馈启动或续接对应 Harness 会话。

当前规模不拆分独立的“任务路由”和“执行触发”。每台 Runner 使用自己的名称作为命令标识，例如 `MB01`。

## Runner 名称

每台机器在本机 Runner 配置中设置自己的 `runnerName`，例如：

```text
runnerName = MB01
```

不同机器可以使用不同名称，例如 `HZ01`、`NB01`。

`runnerName` 是 fjzx.gh-dev-runner 自己的命令标识，不要求 GitHub 上存在同名用户，也不依赖 GitHub mention 事件。GitHub CLI 只负责读取 Issue / Comment 正文，实际匹配由本地 Runner 完成。

## 命令语法

Runner 只在**授权主体**能够表达 Runner 控制意图的位置检查命令：

- 由授权主体创建的新建 Issue 的初始正文；
- 已有 Issue 中当前最新一条 **eligible control comment**。

eligible control comment 指：作者属于该仓库配置允许触发 Runner 的授权主体，并且该评论不是 Runner 自己生成的接单确认、启动失败等控制反馈。

V1 规定：**一个 Issue 的当前 task binding 只归一个 Runner**。正常流程中不会让 MB01、HZ01 等多个 Runner 同时处理同一个 Issue；如需换 Runner，必须先由维护者明确完成任务绑定迁移，而不是靠多台机器同时竞争评论。

所有 Runner 自动生成的 GitHub 控制反馈统一使用保留前缀：

```text
BOT:<runnerName>
```

例如：

```text
BOT:MB01
MB01 已接单，Session ID: <session-id>
```

任何 trim 后以 `BOT:` 开头的评论都属于 Runner 控制反馈，永远不参与 eligible control comment 选择。该前缀只供 Runner 自动反馈使用，人工控制评论不使用它。这样不依赖本机 comment-id 共享，也不需要多个 Runner 互相同步状态。

未授权用户的评论和 `BOT:` 控制反馈可以正常存在于 Issue 中，但它们不参与“当前候选”的选择，也不能覆盖授权主体已经留下的当前控制意图。

V1 不把同一 Issue 的所有历史评论都当成待执行命令队列。Issue Body 是一次性的初始触发候选；进入评论阶段后，只以**当前最新一条 eligible control comment**作为触发候选。

对正文做首尾空白清理（trim）后，如果正文以：

```text
@<runnerName>
```

结尾，则该正文表示一次对这台 Runner 的执行请求。

例如 `runnerName = MB01`：

```text
请按照上面的讨论完成实现并补测试。

@MB01
```

有效。

```text
请继续处理。 @MB01
```

也有效。

下面内容不触发 MB01：

```text
@MB01 请先讨论，不要执行。
```

因为 trim 后正文不是以 `@MB01` 结尾。

## 语义

`@MB01` 同时表达两件事：

1. 这次工作由 MB01 处理；
2. 现在开始或继续执行一次。

V1 不再使用：

```text
runner:mb01 + @dev
```

这类两层“路由标签 + 通用执行命令”。

未来只有在实际出现“先路由给机器、但暂时不执行”或更复杂跨机调度需求时，才重新讨论是否拆分这两个概念。

## Issue Body 与最新 Comment

新建 Issue 时，如果 Issue 创建者属于授权主体，且**初始 Issue Body**满足命令规则，可直接请求对应 Runner 开始工作，不要求再补一条单独评论。该 Body 只作为一次性的初始触发入口；检查过后不因重复扫描或编辑再次触发。

已有 Issue 进入评论阶段后，V1 只在该 Issue **当前没有正在运行的 Harness** 时读取它的控制内容，并且只检查当前最新一条 eligible control comment。更早的 eligible control comment 即使以 `@<runnerName>` 结尾，也不排队、不补执行。

如果这个 Issue 已经有 Harness 处于 starting / running / unknown：

- Runner 直接跳过这个 Issue；
- 不读取或解释该 Issue 在运行期间新增的评论；
- 不更新该 Issue 的 `eligibleCommentWatermark`；
- 不向当前 Harness 注入新消息；
- 不杀掉当前 Harness；
- 不启动第二个 Harness 写同一 task / workspace / session。

这个限制只作用于**当前 Issue**。Runner 仍继续轮询其他 Issue 和其他仓库，并可在调度并发上限允许时启动它们的 Harness。

每个 Issue 只需要一个单调前进的评论水位（逻辑名可记为 `eligibleCommentWatermark`），表示“这个 Issue 上一次在空闲状态下已经处理到的最新 eligible 人类评论”。当一条 Comment 触发 Harness 后，该水位在整个 Harness 运行期间保持不变。

当前 Harness 明确结束后，下一次轮询才重新读取该 Issue。此时只看**当时最新**的 eligible control comment：

- 如果没有比水位更新的 eligible comment：什么也不做；
- 如果最新 eligible comment 比水位更新、且 trim 后以 `@<runnerName>` 结尾：把水位推进到该 comment，并 RESUME 原 task / workspace / session；
- 如果最新 eligible comment 比水位更新、但不是命令：把水位推进到该 comment，不启动 Harness；
- 运行期间夹在旧水位和当前最新评论之间的其他评论不排队、不逐条补执行。

Harness 运行期间的新回复不形成待执行队列。当前 Harness 结束以后，再看 GitHub 当时的最新人类意图即可。

未授权用户的新评论不参与候选选择。Runner 自动生成的接单确认、启动失败等控制反馈统一以 `BOT:<runnerName>` 开头，因此直接排除，不参与 eligible control comment 选择。

同一个当前候选即使正文中多次出现相同命令，也只作为一次触发处理；同一 Issue Body 或同一 eligible control comment 不能因正常轮询、重启或重复读取而重复执行。

## 匹配规则

V1 保持简单，并把 Issue Body、空闲 Comment 检查和运行中跳过分开：

**Issue Body：**

1. 仅在 Issue 初次处理时检查，确认创建者属于授权主体；
2. 读取 Body 原文并执行 trim，判断是否以 `@${runnerName}` 结尾；
3. 记录 Body 已检查；如果是命令则建立 task binding 并启动 Harness；
4. Body 之后不因重复扫描或编辑重新触发。

**Comment：**

1. 先检查该 Issue 是否已有 Harness 处于 starting / running / unknown；如果有，直接跳过该 Issue，不读取新评论、不推进水位；
2. Issue 空闲时，读取当前最新一条 eligible control comment：排除 trim 后以 `BOT:` 开头的 Runner 自动反馈，并确认作者属于授权主体；
3. 若该 comment identity 不新于 `eligibleCommentWatermark`，不做任何事；
4. 若它更新，则把水位推进到这条当前最新评论；
5. 若正文 trim 后以 `@${runnerName}` 结尾，START / RESUME 对应 Harness；否则只保存新水位，不执行。

V1 不解析 GitHub 的真实 mention，不依赖通知事件，也不为了 Markdown 引用、代码块等情况建设额外语法解析器。

## 历史与重复执行

Runner 采用增量发现，不在首次接入仓库时重放全部历史命令。

每个 Issue 的触发状态保持最小化：一次性的 Body 处理状态、单调前进的 `eligibleCommentWatermark`，以及“这个 Issue 当前是否有 Harness 在运行/结果未知”的任务运行状态。Harness 真正的 session 历史仍由 Harness / `DSH_HOME` 管理。

运行状态与评论水位的关系只有一条：**Issue 运行中，水位冻结；Issue 空闲后，下一次轮询才读取当前最新评论并决定是否推进水位和再次执行。** Runner 不保存运行期间出现的待执行命令；这些回复只在 Harness 结束后的下一次轮询中，以当时最新的一条为准。

Runner 重启后，如果无法确认某个旧 Harness 是否已经退出，应继续把该 Issue 当作 active / unknown，先跳过它，直到进程探测或明确人工恢复动作得到确定结果；不能因为重启就重新读取新评论并启动第二个写入者。

具体持久化字段由本地状态 Contract 负责，但不能改变这里定义的用户可见触发语义。

## GitHub 可见反馈

Runner 在真正认领一次命令、成功启动或续接 Harness 并取得本次绑定的 sessionId 后，只在原 Issue 回复一次接单确认，例如：

```text
BOT:MB01
MB01 已接单，Session ID: <session-id>
```

这条回复只表示本次命令已由 MB01 接管，并已经进入对应 Harness session；不表示开发任务已经完成。所有 Runner 控制反馈统一以 `BOT:<runnerName>` 开头，因此永远不参与“当前 eligible control comment”的选择。

正常执行过程中，Runner 不持续在 GitHub 刷新进度；Harness / Dev 的分析、问题、结果、PR 与后续工作状态由 Dev 按目标项目规则直接 POST 到 Issue / PR。

正常一轮结束后，Runner 不再额外回复“本轮结束”“已完成”等信息。Harness 进程退出属于 Runner 的本机技术状态，不等于业务完成。

如果 Runner 无法正常启动或续接 Harness，导致本轮 Dev 根本没有进入可工作的 session，则 Runner 必须在原 Issue 留下一条简短失败回复，例如：

```text
BOT:MB01
MB01 启动 Harness 失败，请检查本机 Runner / Harness 状态。
```

GitHub 回复不得包含 API Key、本机敏感路径、完整 stderr 或模型输出。

## 本机运行追踪

GitHub 只保留上述最小人类可见反馈；Runner 本机必须保留完整的运行追踪，能够事后回答“哪条命令在什么时候由哪台 Runner 拉起了哪个 session、运行多久、如何结束”。

至少应能追溯：

- repository + Issue number；
- 触发来源（Issue Body 或 Comment）及其 GitHub identity；
- runnerName；
- 命令发现与 claim 时间；
- START 或 RESUME；
- sessionId；
- Harness 启动时间、结束时间和运行时长；
- Harness 进程标识（若可获得）；
- 技术退出状态 / exit code；
- 启动或运行异常的简短本机诊断；
- GitHub 接单或启动失败回复是否成功；
- Runner 重启后恢复到的状态或结果不确定状态。

具体日志文件和字段布局属于实现细节。首版优先使用简单的本机结构化追加记录（例如 JSONL），不因此引入数据库、中央日志服务或新的调度平台。

用于去重、任务绑定和恢复的 runtime state，与用于历史追溯的 audit/run log 职责分开；两者都只保存在本机，不把完整运行轨迹公开到 GitHub。

## 与其他 Contract 的边界

本文定义：

- 什么内容算一次 Runner 执行请求；
- Runner 成功接单或无法启动 Harness 时，GitHub 最少应该看到什么；
- Runner 本机运行追踪需要保留到什么程度。

以下内容由各自 Contract 负责：

- Runner / Harness 配置文件的具体格式；
- 机器级和仓库级并发；
- 当前任务 running / capacity 等调度状态；
- task binding、worktree 与 session 的具体 Schema；
- START / RESUME 交给 Harness 的消息内容；
- Harness / Dev 如何完成业务开发和汇报结果。

## V1 示例

机器配置：

```text
runnerName = MB01
```

Issue Body：

```text
实现新的配置加载逻辑，并补充测试。

@MB01
```

Runner 识别并成功拉起 Harness 后回复：

```text
BOT:MB01
MB01 已接单，Session ID: abc123
```

随后同一 Issue 中，授权主体发布的**当前最新 eligible control comment**：

```text
Review 已经有结果，请继续处理剩余问题。

@MB01
```

如果它在 Runner 准备执行时仍是当前最新评论，则表示再次执行；Runner 续接原任务绑定 / session。若它后来被新的普通评论覆盖，则不再补执行。成功后仍只回复一次接单确认，后续实际工作结果由 Dev 自己回报。
