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

`COORDINATOR` 是 Coordinator 通道的保留控制名称，不得配置为 Implementer 的 `runnerName`；配置校验必须拒绝该值。这样 `@COORDINATOR` 只表示协调交接，不会同时命中现有 Implementer Runner 的 `@<runnerName>` 触发。

## 命令语法

Runner 只在**授权主体**能够表达 Runner 控制意图的位置检查命令：

- 由授权主体创建的新建 Issue 的初始正文；
- 已有 Issue 中扫描水位之后**最新一条有效的 `@<runnerName>` 控制评论**。

有效控制评论指：作者属于该仓库配置允许触发 Runner 的授权主体，评论不是 Runner 自己生成的接单确认、启动失败等控制反馈，并且正文 trim 后以 `@<runnerName>` 结尾。扫描水位记录“已经检查到哪里”，触发候选则是在水位之后的评论中只取**最新一条有效控制评论**；普通讨论、未授权评论和 `BOT:` 反馈不参与候选选择。

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

未授权用户的评论和 `BOT:` 控制反馈可以正常存在于 Issue 中，但它们不参与“当前候选”的选择，也不会触发 Harness；不过它们仍会被扫描并推进扫描水位，因此不会在之后（例如作者被加入 `allowedActors`）变成一条新的命令。授权主体要改变控制意图，应发布新的控制评论。

V1 不把同一 Issue 的历史控制评论当成待执行命令队列。Issue Body 是一次性的初始触发候选；进入评论阶段后，Runner 扫描水位之后的新评论，只从中选择**最新一条有效的 `@<runnerName>` 控制评论**。如果有多条，只执行最新一条，更早的控制评论不排队、不补执行；普通讨论、未授权评论和 `BOT:` 反馈只影响扫描进度，不覆盖合法控制评论。

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

新建 Issue 时，如果 Issue 创建者属于授权主体，且**初始 Issue Body**满足命令规则，可直接请求对应 Runner 开始工作，不要求再补一条单独评论。

Body 是一次性入口：Runner 只读取并判断一次，之后就按这次结果处理。后续编辑既不撤销、也不重新触发、更不重新评估——把命令删掉不会取消已读到的请求，把命令加上去也不会被当成新请求；需要改变意图时发布新评论，评论才是活的控制通道。重复扫描同样不会再次触发。

已有 Issue 进入评论阶段后，V1 只在该 Issue **当前没有正在运行的 Harness** 时读取它的控制内容。Runner 扫描 `commentScanWatermark` 之后的新评论，把扫描水位推进到本次实际扫描到的最新 comment identity，同时只从这批新评论中选择**最新一条有效的 `@<runnerName>` 控制评论**作为候选。更早的有效控制评论不排队、不补执行；普通讨论、未授权评论和 `BOT:` 反馈不会把合法候选顶掉。

如果这个 Issue 已经有 Harness 处于 starting / running / unknown：

- Runner 直接跳过这个 Issue；
- 不读取或解释该 Issue 在运行期间新增的评论；
- 不更新该 Issue 的 `commentScanWatermark`；
- 不向当前 Harness 注入新消息；
- 不杀掉当前 Harness；
- 不启动第二个 Harness 写同一 task / workspace / session。

这个限制只作用于**当前 Issue**。Runner 仍继续轮询其他 Issue 和其他仓库，并可在调度并发上限允许时启动它们的 Harness。

每个 Issue 只需要一个单调前进的**评论扫描水位**（逻辑名可记为 `commentScanWatermark`），表示“这个 Issue 已经扫描到的最新评论 identity”。它记录的是**扫描进度**，不是“哪些评论曾经是合格候选”：未授权用户的评论、`BOT:<runnerName>` 自动反馈以及不以 `@<runnerName>` 结尾的普通回复虽然都不触发 Harness，仍然被扫描、同样推进水位。当一条 Comment 触发 Harness 后，该水位在整个 Harness 运行期间保持不变。

之所以让水位覆盖所有已扫描评论，是为了不重放历史：如果水位只记录合格候选，那么一条当时不合格的评论（例如作者尚未被加入 `allowedActors`）会在条件变化后重新变成“新命令”。水位越过它之后，它就不再是候选；需要执行时应发布**新的控制评论**。

评论扫描采用**本轮读取快照语义**。已经越过水位的评论不会因为编辑而重新激活；本轮所选候选从读取到领取之间若被编辑，则候选版本校验使领取失败并重新读取。对于本轮已经读取但未被选为候选的中间评论，不为其建立整批版本锁；它若在读取后、落盘前被原地编辑成命令，不保证纳入本轮。需要可靠表达新的执行意图时，应发布新的 `@<runnerName>` 控制评论，而不是依赖编辑旧评论。

当前 Harness 明确结束后，下一次轮询才重新读取该 Issue：

- 如果没有新于扫描水位的评论，什么也不做；
- 如果有新评论，把扫描水位推进到本次实际扫描到的最新 comment identity；
- 在这些新评论中，只选择最新一条有效的 `@<runnerName>` 控制评论：有则 RESUME 原 task / workspace / session，没有则只推进水位、不启动 Harness；
- 多条有效控制评论只取最新一条，更早的控制评论不排队、不逐条补执行；普通讨论、未授权评论和 `BOT:` 反馈不参与候选选择。

水位推进本身不代表该评论成为执行候选，也不代表已经决定不再执行；它只表示“这条评论已经看过”。

Harness 运行期间的新回复不形成待执行队列。当前 Harness 结束以后，再看 GitHub 当时的最新人类意图即可。

未授权用户的评论不参与候选选择，`BOT:<runnerName>` 开头的 Runner 自动反馈同样永不参与；但两者都会被扫描并推进水位，因此不会在授权变化或重新读取后变成命令。

同一个当前候选即使正文中多次出现相同命令，也只作为一次触发处理；同一 Issue Body 或同一条评论不能因正常轮询、重启或重复读取而重复执行。

## 匹配规则

V1 保持简单，并把 Issue Body、空闲 Comment 检查和运行中跳过分开：

**Issue Body：**

1. 仅在 Issue 初次处理时检查，确认创建者属于授权主体；
2. 读取 Body 原文并执行 trim，判断是否以 `@${runnerName}` 结尾；
3. 以条件式原子更新记录 Body 已检查：只在该 Issue 此刻仍无运行记录、且 Body 尚未被检查过时生效；如果是命令，同一次更新还要记录该 Issue 已进入 starting、建立 task binding 并启动 Harness。条件不成立时本次不 spawn，也不单独写入“已检查”；
4. Body 之后不因重复扫描或编辑重新触发；
5. 条件里不校验 Body 内容是否仍是读取时那一版：Body 在“读取”与“条件式更新”之间被编辑时，本次判断不重做，领取与否仍按读取到的内容决定。只有条件式更新从未提交过（例如 Runner 在这之前崩溃），重启后才可以重新读取并判断当时的 Body；
6. 同一个 Issue 的初次处理中，Body 判定必须在任何 Comment 领取之前完成。否则并发的 Comment 检查器可能先把该 Issue 置为 starting，使这里的“仍无运行记录”条件不成立，Body 的已检查状态落不下去；运行期间再编辑 Body，就会让本条规则“不重新评估”的承诺失效。

**Comment：**

1. 先检查该 Issue 是否已有 Harness 处于 starting / running / unknown；如果有，直接跳过该 Issue，不读取新评论、不推进水位；
2. Issue 空闲时，读取 `commentScanWatermark` 之后的新评论；如果没有新评论，不做任何事；
3. 记录本次实际扫描到的最新评论 identity，并在这些新评论中按授权主体、`BOT:` 排除和正文 trim 后以 `@${runnerName}` 结尾三个条件筛选有效控制评论；有多条时只取最新一条；
4. 用一次条件式原子状态更新推进 `commentScanWatermark` 到本次扫描终点，并在存在有效控制评论时同时记录该 Issue 已进入 starting 以及 START / RESUME；没有有效控制评论则只推进水位。该更新只在该 Issue 此刻仍无运行记录、该 Issue 的水位仍等于本轮读取前的旧值、扫描终点仍与刚才读取结果一致，且存在候选时该候选正文版本也未变化时才生效；只有写入成功的执行者可以 spawn Harness；
5. 普通讨论、未授权评论和 `BOT:` 反馈会被扫描并随扫描终点一起越过，但不参与候选选择，因此既不会在未来因授权变化而复活，也不会覆盖同一批新评论里更早的合法 `@<runnerName>`；多条合法控制评论仍只执行最新一条。

这两处都不能拆成“先推进水位／先标记 Body 已检查，再记录 starting 后启动”，也不能反过来先 spawn Harness、之后再补记录 claim / starting。Runner 在两次写入之间崩溃时，重启后这条触发已经不新于水位、或 Body 已经算检查过，而该 Issue 又没有任何运行记录，于是命令被永久静默丢弃。反过来先启动 Harness 再补记录，重启后又会因为查不到运行记录而重新领取同一 Issue，可能启动第二个写入者。因此水位推进／Body 检查状态与本次执行的持久化必须一起生效，且发生在 spawn 之前：写入成功才允许 spawn。

原子和条件是两个要求，分别解决两个窗口：原子解决两次写入之间崩溃，条件解决两个执行者先后通过空闲检查、再各自写入而双双认为领取成功。只有检查与写入在同一临界区内完成，从空闲到 starting 的转移才只有一个执行者能成功。具体持久化形式和互斥方式由本地状态 Contract 决定，这里只要求这两项状态同时生效，且领取是条件式的。

如果原子状态已经成功落盘，但 Runner 在 spawn 是否完成为止无法可靠确认时崩溃，重启后应把这次调用当成 starting / unknown 的恢复问题：保守避开第二个写入者，等待进程探测或明确人工恢复；不能因为重启或无法确认，就把同一个 trigger 当作新的未处理请求再执行一次。原子写入已经表示这次触发被领取，这一点不因结果未知而失效。

上面的原子要求只覆盖接单瞬间的 crash-safety，不等于引入命令队列、pending trigger、运行中评论观察或复杂恢复框架。每个 Issue 仍然只保存一次性的 Body 处理状态、单调前进的扫描水位与运行状态，不维护运行期间的待执行命令，也不补执行中间评论。

V1 不解析 GitHub 的真实 mention，不依赖通知事件，也不为了 Markdown 引用、代码块等情况建设额外语法解析器。

Comment 的所选候选校验不能只看 comment identity：GitHub 评论可以被原地编辑，identity 不变。因此存在候选时，条件里还要比较该候选读取到的正文版本（例如正文摘要或 `updated_at`）；候选被编辑就让这次领取条件不成立并重新读取。V1 不对本轮所有中间评论做整批版本校验，评论扫描采用本轮读取快照语义；中间非候选评论在读取后被编辑，不保证改变本轮选择。已经越过扫描水位的评论不会因为之后被编辑而重新变成命令；需要可靠改变控制意图时发布新的控制评论。Body 同样接受读取时的快照语义，并且只判断一次。

## 历史与重复执行

Runner 采用增量发现，不在首次接入仓库时重放全部历史命令。

每个 Issue 的触发状态保持最小化：一次性的 Body 处理状态、单调前进的 `commentScanWatermark`，以及“这个 Issue 当前是否有 Harness 在运行/结果未知”的任务运行状态。Harness 真正的 session 历史仍由 Harness / `DSH_HOME` 管理。

增量发现以扫描水位为边界：水位记录已经看到过哪些评论；每次只在水位之后的新评论中寻找**最新一条有效的 `@<runnerName>` 控制评论**。因此“授权变化后旧评论复活”和“历史评论被编辑后复活”都不会发生，同时普通讨论、未授权评论或 `BOT:` 反馈也不会把同一批新评论里的合法命令顶掉。

运行状态与评论水位的关系只有一条：**Issue 运行中，水位冻结；Issue 空闲后，下一次轮询才扫描水位之后的新评论，并只取其中最新一条有效控制评论。** Runner 不保存运行期间出现的待执行命令队列；多条有效控制评论只执行最新一条。

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

随后同一 Issue 中，授权主体发布了一条新的有效控制评论：

```text
Review 已经有结果，请继续处理剩余问题。

@MB01
```

Runner 下一次扫描时，如果水位之后没有更新的有效 `@MB01` 控制评论，就执行这一条并续接原任务绑定 / session；后续普通评论、未授权评论或 `BOT:` 反馈不会覆盖它。如果水位之后又出现更新的有效 `@MB01`，则只执行最新那一条。成功后仍只回复一次接单确认，后续实际工作结果由 Dev 自己回报。
