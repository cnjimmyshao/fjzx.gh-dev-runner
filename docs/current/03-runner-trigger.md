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

Runner 检查：

- 新建 Issue 的正文；
- 已有 Issue 后续新增的普通 Issue 评论正文。

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

## Issue Body 与 Comment

新建 Issue 时，如果 Issue Body 满足命令规则，可直接请求对应 Runner 开始工作，不要求再补一条单独评论。

已有 Issue 中，每一条后续新增的普通 Issue 评论都作为独立内容事件检查。**不是“有新回复就触发”**；只有该条评论自身在 trim 后以 `@<runnerName>` 结尾，才表示现在开始或继续该 Issue 的工作。

因此，人和 Dev 可以在同一个 Issue 中正常来回讨论。Dev 回报问题或结果后，维护者阅读并回复；只有当维护者希望 Runner 再次工作，并在这条新回复最后明确写上例如 `@MB01` 时，MB01 才再次被激活。

同一个 Issue 在整个生命周期内可以多次出现新的有效 `@<runnerName>` 命令：

- 第一次有效命令创建任务绑定并启动新 Harness session；
- 后续新的有效评论表示继续原任务绑定，由会话层恢复原工作目录和原 session；
- 不以 `@<runnerName>` 结尾的普通回复、讨论、Dev 回报或其他状态变化都不会触发 Runner。

同一 GitHub 内容事件即使正文中多次出现相同命令，也只作为一个事件处理；去重依据是 GitHub 内容事件本身，而不是命令文字出现次数。

## 匹配规则

V1 保持简单：

1. 读取正文原文；
2. 对正文执行 trim；
3. 检查是否以 `@${runnerName}` 结尾。

V1 不解析 GitHub 的真实 mention，不依赖通知事件，也不为了 Markdown 引用、代码块等情况建设额外语法解析器。

## 历史与重复执行

Runner 采用增量发现，不在首次接入仓库时重放全部历史命令。

同一 Issue Body 或同一 Comment 不应因正常轮询、重启或重复读取而被重复执行；后来出现其他状态变化也不能让旧的 `@<runnerName>` 重新生效。

具体水位与持久化结构由本地状态 Contract 负责，但不能改变这里定义的用户可见触发语义。

## GitHub 可见反馈

Runner 在真正认领一次命令、成功启动或续接 Harness 并取得本次绑定的 sessionId 后，只在原 Issue 回复一次接单确认，例如：

```text
MB01 已接单，Session ID: <session-id>
```

这条回复只表示本次命令已由 MB01 接管，并已经进入对应 Harness session；不表示开发任务已经完成。

正常执行过程中，Runner 不持续在 GitHub 刷新进度；Harness / Dev 的分析、问题、结果、PR 与后续工作状态由 Dev 按目标项目规则直接 POST 到 Issue / PR。

正常一轮结束后，Runner 不再额外回复“本轮结束”“已完成”等信息。Harness 进程退出属于 Runner 的本机技术状态，不等于业务完成。

如果 Runner 无法正常启动或续接 Harness，导致本轮 Dev 根本没有进入可工作的 session，则 Runner 必须在原 Issue 留下一条简短失败回复，例如：

```text
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
- pending / running 等调度状态；
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
MB01 已接单，Session ID: abc123
```

随后同一 Issue 中的新评论：

```text
Review 已经有结果，请继续处理剩余问题。

@MB01
```

该评论表示再次执行；Runner 续接原任务绑定 / session，成功后仍只回复一次接单确认，后续实际工作结果由 Dev 自己回报。
