# 本机配置与状态 Schema

本文件定义 Runner 首版本机配置与持久化状态的 Current Contract。它描述哪些信息必须被保存、如何寻址，以及哪些字段属于当前 v1 实现；不要求把所有内部字段永久锁死。

## 四类数据的责任边界

| 数据 | 当前位置／入口 | 责任 |
| --- | --- | --- |
| Runner 配置 | 本机 Runner V1 Runner 的人工部署配置规范入口固定为仓库 checkout 外／本机部署目录中的 `.env`；仓库提供 `.env.example` 作为无凭据模板。Runner 自动维护的运行状态不写回 `.env`，而写入 `runtime.stateDir/state.json`。
| Runner 状态 | `<stateDir>/state.json` | 内容处理进度、任务绑定、sessionId、活跃 Harness 运行态与恢复所需技术状态 |
| Harness 会话 | Harness 自己的 `DSH_HOME` | 真正的模型对话、上下文与 Harness 持久化数据 |
| 凭据 | `gh` 登录与 Harness 支持的凭据存储 | GitHub 授权和模型 Key；不进入普通配置／状态 JSON |

Runner **不复制 Harness 会话历史**，也不把 Issue 全文、PR 内容或模型输出作为长期状态保存。Runner 只保存把“仓库 + Issue”重新定位到正确执行机、工作目录和 Harness session，以及判断“哪些 Harness 仍可能占用、重启后如何恢复”所需的技术状态。这些状态如何折算成并发容量属于调度 Contract，不在本文定义。

配置与状态都属于本机数据，不提交到仓库，也不进入公开 Issue 评论。

## 配置 JSON 的稳定语义

接单运行代码尚未实现，当前仓库不把任何未合并实现 PR 中的配置示例当成现行事实。Current 固定的是下面这些配置类别及其责任；具体 JSON 示例由后续实现 PR 在遵守本 Contract 的前提下提供。

| 字段／类别 | 语义 |
| --- | --- |
| `runnerName` | 本机 Runner 的稳定命令标识，例如 `MB01`；触发语义见 [Runner 激活与任务触发](03-runner-trigger.md) |
| `harness.bin` / `profile` / `patch` | 受信任的 Harness 启动入口与当前 headless 调用方式 |
| `harness.home` | 可选的 Harness 持久化 home；真正会话历史仍由 Harness 管 |
| `harness.timeoutMs` | 单次调用的本机控制超时；不表示业务任务完成时限 |
| `runtime.stateDir` | Runner 状态、锁和运行日志的本机根目录 |
| `runtime.workspaceDir` | 独立任务工作目录／worktree 的默认父目录 |
| `runtime.pollSeconds` | polling cycle 间隔，正整数秒；V1 默认 `300`（5 分钟），调度语义见 [Harness 并发与轮询调度](05-harness-scheduling.md) |
| `runtime.maxConcurrentHarnesses` | 本机同时运行 Harness 的机器级上限，必须为正整数；V1 默认 `1` |
| `runtime.capture` / `keepRunLogs` | 本机子进程输出与日志保留策略 |
| `github.timeoutMs` / `pageSize` | `gh` 调用和分页参数 |
| `repositories[].repo` | 接入仓库身份，使用 `owner/name` |
| `repositories[].allowedActors` | 允许发布执行请求的 GitHub 登录名 |
| `repositories[].maxConcurrentHarnesses` | 单仓库同时运行 Harness 的上限，必须为正整数；V1 默认 `1`，且不能绕过机器级上限 |
| `repositories[].sourceDir` | 部署者已有仓库检出，用作创建独立任务 worktree 的源目录 |
| `repositories[].baseBranch` / `worktreeDir` | worktree 起点与存放位置；每个任务最终目录必须唯一 |

同一仓库的多个 Issue **不得共享一个可写任务 checkout**。如果实现保留类似 `repoDir` 的兼容字段，它只能表示源仓库／父目录，或必须有明确的按任务唯一派生规则；不能让两个不同 Issue 的 Harness 写入同一个工作树。

模型 Key 不属于该配置 Contract。Runner 不读取、打印或保存模型 Key；Harness 按自身支持的凭据机制加载它。

## state.json 的任务主键

任务身份必须是：

```text
repository identity + Issue number
```

不能只用 Issue number。不同仓库都可能存在 `#1`、`#9` 等相同编号，状态必须彼此隔离。

V1 Contract 采用下面的逻辑形状表达需要持久化的信息；接单实现尚未合并，因此这不是“已部署文件”的描述：

```text
activeRuns
└── "<runId>"
    ├── repository + issueNumber
    ├── trigger identity
    ├── runnerName + sessionId（首次 START 可能尚未取得）
    ├── START / RESUME 区分
    ├── process identity / pid（若可获得）
    ├── status
    └── startedAt / lastObservedAt / endedAt

repositories
└── owner/repo
    ├── baselineCompleted
    └── issues
        └── "<issueNumber>"
        ├── issueBodyHandled
        ├── commentScanWatermark
        ├── lastTrigger
        ├── binding
        └── lastRun
```

这是 V1 的目标存储形状；稳定 Contract 是“仓库身份 + Issue 编号”的复合主键，以及能够恢复活跃 Harness 运行态，而不是要求未来永远使用同样的嵌套对象布局。

## state.json v1 示例

以下示例展示 V1 Contract 需要表达的主要信息。路径、session、PID 和时间均为占位值；后续实现可以在不破坏稳定语义的前提下调整内部字段名：

```json
{
  "version": 1,
  "activeRuns": {
    "run-20260924-001": {
      "repository": "owner/project",
      "issueNumber": 42,
      "trigger": {"sourceType": "comment", "sourceId": "123456"},
      "runnerName": "MB01",
      "status": "starting",
      "kind": "start",
      "dir": "<本机绝对任务目录>",
      "sessionId": null,
      "pid": null,
      "startedAt": "2026-09-24T00:10:00.000Z",
      "lastObservedAt": "2026-09-24T00:10:00.000Z",
      "endedAt": null
    }
  },
  "repositories": {
    "owner/project": {
      "baselineCompleted": true,
      "issues": {
        "42": {
          "issueBodyHandled": true,
          "commentScanWatermark": "123456",
          "lastTrigger": {
            "sourceType": "comment",
            "sourceId": "123456",
            "author": "maintainer-login",
            "status": "starting",
            "at": "2026-09-24T00:10:00.000Z",
            "feedbackSent": false
          },
          "binding": {
            "runnerName": "MB01",
            "dir": "<本机绝对任务目录>",
            "sessionId": null,
            "branch": "fjzx/issue-42",
            "source": "<本机源仓库目录>",
            "worktreeCreated": true,
            "createdAt": "2026-09-24T00:10:00.000Z"
          },
          "lastRun": {
            "at": "2026-09-24T00:10:00.000Z",
            "dir": "<本机绝对任务目录>",
            "runDir": "<本机日志目录>",
            "exitCode": null
          }
        }
      }
    }
  }
}
```

（示例展示的是一次**首次 START** 在领取那一次原子更新刚完成、尚未 spawn 或刚 spawn 的瞬间：水位、`lastTrigger`、`binding`、active run 与 `lastRun` 在同一次更新中写入，因此时间一致。首次 START 时 `pid`、`sessionId` 与真正的运行状态都还可能未知，所以它们为 `null` / `starting`，`lastRun` 也还没有结束结果——实现不能反过来先把这些值写齐再落盘，那等于先 spawn 后记录，会重新引入崩溃后重复启动的窗口。这些字段随后由**独立的后续写入**补全：拿到 `sessionId`、探测到进程、或本轮结束时各自更新，因此运行一段时间后的快照里它们会比 `startedAt` 更新，这是正常的。注意 RESUME 不会出现 `sessionId` 未知的快照——续接本来就要求已有 session 标识，见下文字段表。触发不存在“已观察但尚未启动”的中间状态：写入成功即已领取。）

`lastRun` 记录到结束时的技术结果（例如 `kind=completed` / exit code），或 Harness 自身返回的 `status.kind=completed`，都只表示本机技术调用状态，**不是业务完成**，也不意味着 Runner 要把“完成”写回 GitHub。Runner 与 Dev 的 GitHub 反馈边界以 [范围与工作链路](01-scope-and-flow.md) 与 [Runner 激活与任务触发 Contract](03-runner-trigger.md) 中的反馈规则为准（原决定见已关闭的 Issue #11）。

## v1 字段语义

### 顶层

| 字段 | 稳定性 | 含义 |
| --- | --- | --- |
| `version` | 稳定 Contract | 持久化 Schema 版本。读到不支持的版本不得静默当成新状态 |
| `repositories` | 稳定 Contract | 按仓库身份隔离任务状态 |
| `activeRuns` | 稳定语义、内部字段可演进 | 当前或恢复中的 Harness 调用索引，用于判断哪些 Harness 仍可能占用、并防止重启后重复拉起同一任务 |

### 每个仓库 + Issue

| 字段 | 稳定性 | 含义 |
| --- | --- | --- |
| `issueBodyHandled` | 稳定语义 | 初始 Issue Body 是否已经作为一次性候选处理；正常重启不能重新触发同一个初始 Body。同一个 Issue 初次处理时 Body 判定必须先于任何 Comment 领取，否则并发的 Comment 领取会先把该 Issue 置为 starting，使这个状态落不下去。它与该 Body 对应的领取状态必须像 Comment 路径一样**在同一次原子更新中**写入：Body 是命令时要同时记录该 Issue 已进入 starting 并建立 task binding，不能只把这里标成已处理就先落盘 |
| `commentScanWatermark` | 稳定语义 | 单一、只前进的评论**扫描**水位：该 Issue 已经扫描到的最新 Comment identity。它记录扫描进度，不是“哪些评论曾经触发 Harness”——未授权用户的评论、`BOT:` 自动反馈与普通回复都推进它。运行中的 Issue 不读取新评论、水位冻结；不得因删除、授权变化、评论编辑或重启回退到更旧评论 |
| `lastTrigger` | 稳定语义、内部字段可演进 | 最近一次真正被认领的执行请求及其处理状态，用于恢复／必要反馈；只保存最近一次，不形成历史命令队列 |
| `binding` | 稳定 Contract | 任务与执行机、工作目录、Harness session 的持久绑定；首次绑定前可为空 |
| `lastRun` | 稳定语义、内部字段可演进 | 最近一次本机调用的技术结果与诊断入口；不代表业务结果 |
| `inFlight` 等瞬时／恢复字段 | 实现 Schema | 可缓存任务内当前调用引用；机器级真实活跃调用以可恢复的运行态记录为准，字段名可演进，但不能破坏单写入者 Contract |

### `binding`

| 字段 | 稳定性 | 含义 |
| --- | --- | --- |
| `runnerName` | 稳定 Contract | 绑定所属 Runner；配置不匹配时不得静默在另一台机器继续 |
| `dir` | 稳定 Contract | 任务的本机工作目录；后续续接必须回到同一目录 |
| `sessionId` | 稳定 Contract | Harness 持久会话标识；后续针对同一任务的有效触发必须续接该 session，不能静默新建。首次 START 时它可以先写入为未知，取得后再补全，见下文“首次 START 时 sessionId 可能尚不可见” |
| `branch` | 稳定语义 | 已知任务分支；用于继续原开发而不是创建重复工作 |
| `source` | 实现 Schema | 当前工作目录来源／源仓库信息，用于校验配置变化 |
| `worktreeCreated` | 实现 Schema | 当前目录是否由 Runner 创建为 worktree |
| `createdAt` | 实现 Schema | 绑定创建时间，便于排查 |
| 未来的已知 PR 标识 | 稳定语义 | 若实现保存 PR 绑定，必须属于同一“仓库 + Issue”任务；字段名由实现任务确定 |

### 触发进度与 `lastTrigger`

V1 不保存同一 Issue 的历史命令队列。Trigger Contract 只需要三个很小的状态：

1. `issueBodyHandled`：初始 Body 这个一次性入口是否已经处理；
2. `commentScanWatermark`：该 Issue 已经扫描到的最新 Comment identity，只能向前；
3. `lastTrigger`：最近一次真正被领取的执行请求及其处理状态，用于恢复与必要反馈。

Runner 在 Issue 空闲时读取 `commentScanWatermark` 之后的全部新评论，并以**本轮读取快照**作为本次判断输入：

- 把 `commentScanWatermark` 推进到本轮实际扫描终点；
- 在这批新评论中，只选择最新一条由授权主体发布、非 `BOT:` 自动反馈且正文 trim 后以 `@<runnerName>` 结尾的有效控制评论；普通讨论、未授权评论和 `BOT:` 反馈不参与候选选择，也不会覆盖合法控制评论；
- 若有多条有效控制评论，只领取最新一条，更早的控制评论不排队、不补执行；
- 没有有效控制评论：只推进 `commentScanWatermark`；存在有效控制评论：在同一次原子状态更新中推进水位，并记录该 Issue 已进入 starting、建立 task binding、`lastTrigger` 与 active run。

水位记录的是**扫描进度**，不是“哪些评论曾经触发 Harness”。未授权用户的评论、`BOT:` 自动反馈与普通回复同样被扫描并随扫描终点越过，因此不会在授权变化后重新变成命令；但它们不参与候选选择，所以不会把同一批新评论中的合法 `@<runnerName>` 控制评论顶掉。评论扫描采用本轮读取快照语义：所选候选在领取前被编辑时应按 Trigger Contract 重新读取；本轮已读取但未选中的中间评论若随后被原地编辑，不保证纳入本轮。需要可靠表达新的执行意图时，应发布新的控制评论。

这里不引入“先标记已观察、稍后再启动”的两阶段状态：`03-runner-trigger.md` 明确要求水位推进（Body 路径则是 `issueBodyHandled`）与本次执行的持久化**一起生效**，且发生在 spawn 之前；拆成两次写入会留下“命令已过水位但没有任何运行记录”的中间态，崩溃重启后这条命令被静默丢弃，那正是要避免的窗口。

因此不存在“已观察但尚未启动”的命令状态。一次原子更新要么只推进本轮扫描水位（本轮没有有效控制评论），要么在推进扫描水位的同时领取本轮最新有效控制评论并转入 starting / 恢复语义。`lastTrigger` 只记录真正被领取的控制评论，不保存被较新有效控制评论取代的旧命令，也不形成 pending 队列。claim 成功但 spawn 结果无法确认时按 starting / unknown 保守恢复，不能把同一个 trigger 当作未处理请求再执行一次。

只有真正领取并写入 starting 之后，Runner 才 spawn 子进程。领取更新还必须是**条件式**的：只在该 Issue 此刻仍无运行记录、水位仍等于本轮读取前的旧值、扫描终点仍与读取结果一致，且所选候选的 identity / 正文版本仍与读取结果一致时才写入成功；条件不成立时重新读取，不 spawn。没有有效候选时也以旧水位为条件推进到本轮扫描终点，避免并发扫描互相覆盖。具体的持久化形式与互斥方式由本文负责，条件本身见 `03-runner-trigger.md` 的匹配规则。长期历史追溯写入 audit/run log，不在 `state.json` 中维护 `commands[]` 历史列表，也不维护 pending 队列。

`lastTrigger` 至少能表达：

| 字段 | 稳定性 | 含义 |
| --- | --- | --- |
| `sourceType` | 稳定 Contract | `issue_body` 或 `comment`，区分触发来源 |
| `sourceId` | 稳定 Contract | 本次最近触发来源的稳定身份；Comment 使用 comment id，Issue Body 使用能够唯一指向初始 Body 的 identity |
| `author` | 稳定语义 | 内容作者，用于审计／授权结果回查 |
| `status` | 稳定语义（名称可演进） | 最近一次触发的技术处理状态。至少要能表达“已经领取并开始尝试 / 已经开始运行”与“已结束及技术结果”的等价语义；具体状态名由实现收敛 |
| `at` / `finishedAt` | 实现 Schema | 本机处理时间 |
| `feedbackSent` | 实现 Schema | 是否已经发送必要的 Runner 控制反馈。**它不能单独作为“发过没有”的依据**：如果 GitHub 已经接受了评论、而 Runner 在把这个标记置为已发之前崩溃，重启会重复发一条；反过来先标记后调用 GitHub，则会在另一个窗口永久漏掉要求的反馈。因此恢复时需要一条**可回查的幂等依据**来核对，而不是只读这个布尔值：重启后先查询该 Issue 是否已存在对应反馈，再决定是否补发。这条依据的具体标记形式属于 Trigger Contract 的反馈写法，不在本文规定；`BOT:<runnerName>` 保留前缀使它可被检索 |

重启后的读取顺序也与 `03-runner-trigger.md` 一致：同一个 Issue 初次处理时，Body 判定必须先于任何 Comment 领取；Issue 空闲时扫描水位之后的新评论，并把水位推进到本轮扫描终点；若本轮存在有效控制评论，则只领取其中最新一条。`lastTrigger` 记录的是**已经领取**的最近一次执行请求，不是尚未启动的排队项。

### `activeRuns` / Harness 运行态

Runner 在决定是否领取并启动一个新任务之前，必须先依据本机持久化状态恢复“当前有哪些 Harness 调用仍可能占用槽位”，并在可行时与本机真实进程状态核对。单靠内存中的 Promise / 子进程对象不够，因为 Runner 自身可能崩溃或重启。

每个活跃／待恢复调用至少必须能追溯：

- 本机唯一 `runId`；
- repository + Issue number；
- 触发来源 identity；
- `runnerName`；
- START / RESUME；
- `sessionId`（首次 START 尚未取得时允许缺省，取得后补全）；
- Harness 启动时间；
- 当前技术状态（至少能区分 starting / running / exited / unknown 的等价语义）；
- 进程身份（PID 若可获得；实现还应保存足以避免 PID 重用误判的附加证据）；
- 最近一次确认该进程状态的时间；
- 已结束时的结束时间、exit code / 技术结果与诊断入口。

这些字段的精确 JSON 名称可以演进，但“能够在重启后恢复活跃 Harness 运行态、确认旧 Harness 是否仍在运行”是稳定 Contract。

Runner 重启后，对上次记录为 starting / running、但当前尚未确认结果的调用必须先做恢复核对：

1. 能确认原 Harness 仍在运行：记为仍在运行，并保留其占用；
2. 能确认原 Harness 已退出：记录退出／失效结果，并标记该占用已经释放；
3. 无法可靠确认：标为 unknown，**保守按“可能仍占用”处理**，不得仅因为 Runner 重启就再启动同一任务；
4. unknown 只有在后续进程探测取得确定结果，或维护者执行明确的恢复／解除动作后，才改为已确定状态。

**责任边界：** 本节只要求把上述运行态持久化并在重启后暴露出来，使单写入者判断与恢复有可靠输入。这些状态具体如何计入机器级／仓库级并发上限（容量记账意义上的释放条件）、一次轮询最多领取多少任务，以及容量检查与 claim 的串行临界区，都由 [Harness 并发与轮询调度 Contract](05-harness-scheduling.md) 定义；本文只负责提供可恢复的持久化运行态，不重复定义调度策略。

完整长期追溯**必须**写入持久化的 append-only audit/run history（可以是结构化日志、JSONL 或实现选择的等价本机载体），至少能够按每一轮触发回查 repository + Issue、trigger identity、START / RESUME、runner/session、开始与结束时间、技术结果以及必要的 GitHub feedback 结果。`state.json` 只保存恢复必须的当前／最近状态，不能用会被覆盖的 `lastTrigger` / `lastRun` 代替长期历史。具体历史文件布局、轮转与字段扩展属于实现细节。

### 首次 START 时 `sessionId` 可能尚不可见

Issue #17 原先假定“启动 Harness 时就能记录 `sessionId`”，但本机实测（见 [START 阶段 sessionId 的创建与可见时点实测](../research/2026-09-24-start-sessionid-visibility.md)）表明存在这个窗口：在该报告记录的环境（`@deepseek-ai/dsh` 0.1.5-rc.2、维护者指定的执行电脑）下，实测到时序的两条 headless 路径（本地 runner 与官方 headless）表明会话标识并非 spawn 时立即可见：**热 profile** 场景中会话约在子进程启动后 1.5–1.7 秒创建；报告同时记录了首次建立 profile 链接的**冷启动**场景，实际从进程启动到会话创建约 20.5 秒。该冷启动延迟包含启动器建立 profile 链接的成本，但对父 Runner 的等待、timeout 与按创建时间恢复关联仍是真实窗口，因此 1.5–1.7 秒不得被实现当作启动／恢复上限。本地 runner 只在整轮结束时才把 `sessionId` 写进结果，官方 headless CLI 则完全没有取得该标识的调用方接口；报告中的 acp 路径本次未复现，没有给出会话创建时序。因此 `sessionId` 不能作为建立运行态记录的前提；该结论只对报告记录的版本与环境成立。

Contract 因此要求：

- 领取（claim）成功后、spawn 子进程之前，先用当时已知的信息落盘 `lastTrigger(status=starting)`、active run（含本机唯一 `runId`、repository + Issue、触发来源 identity、任务工作目录、启动时间）与 `binding`；此时 `binding.sessionId` 允许为未知（`null` / 缺省），不得因为还不知道标识就推迟建记录。
- 取得 `sessionId` 之后立即补全 `binding.sessionId` 与对应 active run，作为一次独立写入。
- 在 `sessionId` 仍未知时崩溃：会话可能已经在磁盘上存在但本机没有绑定关系，这属于“绑定不明确”而不是新任务。恢复时按 [范围与工作链路](01-scope-and-flow.md) 的“执行是否已经发生不确定时明确报告并核对，不盲目重跑或新建会话”处理，尝试按任务工作目录与创建时间核对遗留会话；不得静默新建一个并行 session。
- 这个窗口来自当前 wrapper 的交付方式，不是 Harness 的能力限制：标识由 wrapper 自己在创建会话前生成（`scripts/headless-session/runner.mjs`），改成创建后立即交付即可，不需要新接口。官方 headless 路径若要在 turn 之前拿到标识，才需要上游提供结构化事件（Issue #19 / #21 的 JSONL `session` 事件方向）。无论走哪条路，这条保守要求都可以随实现证据一并收紧。

由此产生一个与 GitHub 反馈的衔接问题：`03-runner-trigger.md` 要求接单确认里带本次绑定的 `sessionId`，而该标识在 spawn 时可能还取不到。延迟的只是**发布这一条接单确认**，不是“还没接单”。实现要求：

- **调用件必须在会话建立后立即交付 `sessionId`，而不是等到整轮结束**。当前 `scripts/headless-session/runner.mjs` 在 `agents.create()` / `agents.resume()` 之后才调用 `agent.whenIdle()` 并向模型投递任务，但只在本轮全部结束后才把 `sessionId` 写进结果（L186–196），因此默认输出下父 Runner 在此之前拿不到任何标识（`DSH_DEBUG_RUNNER=1` 的 stderr 调试行不是正式交付契约）。这不满足 Trigger Contract 的接单确认时点：长任务会变成“开发都快做完了才说已接单”。把标识改为会话建立后立即交付不需要新接口（标识本就由该调用件在 `agents.create()` 之前生成），属于首次实现必须落实的一项。
- **提前交付标识必须同时提供早期成败判据**。只把标识提前是不够的：标识到达时本轮失败往往还不可观测（例如凭据缺失时，会话已经建立、但错误与失败结果要稍后才出现，那一轮没有任何 turn 事件）。若此时既不能判定成功、又不许等待结果，Runner 只能二选一——抢发接单确认（在真实失败时违反“失败要发失败回复”）或等整轮结果（回到上面要消除的窗口）。因此同一处还要给出一个**早期判据**：调用件在会话建立后，除了标识，还应交付“本轮已进入可工作 session”的确认，或凭据类等启动失败的早期信号；Runner 只在拿到该判据后才发布接单确认。
- **若调用件暂不提供早期判据，则必须明确回退口径**：接单确认以本轮结果为准，不得提前发布。这条回退与上一条不能同时选；实现者要显式选择并记录，不能留空。
- 这不改变本 State Contract 的字段形状：`binding.sessionId` 仍允许在 claim 时暂为未知、取得后补全；上面的要求只是让这个窗口缩短到“会话建立”，而不是“整轮结束”。
- **取得 `sessionId` 不等于启动成功**：当前调用件在整轮失败时同样会把 `sessionId` 写进结果并以非零码退出（例如凭据缺失导致 `status.kind !== 'completed'`）。按 `03-runner-trigger.md`，这种情况下 Dev 并没有进入可工作的 session，应发启动失败回复，而不是“已接单”。因此不能以“拿到标识”作为成功条件。
- 具体判定信号与回复写法属于 Trigger Contract 的可见反馈语义，不在本文另立规则；此处只说明本 State Contract 不会因为 `sessionId` 的交付时点而阻断接单。

## 稳定 Contract 与实现 Schema

### 需要先改 Current 的变化

下列语义属于长期 Contract，修改时先更新本文或相关 Current，再改运行代码：

- 任务主键不再是“仓库 + Issue”；
- 不再保证初始 Body 已处理状态／Comment 扫描水位与本次执行的持久化在同一次原子更新中生效，或允许正常重启／评论删除后重放已经被消费的旧命令；
- 不再让扫描水位覆盖所有已读评论，或允许授权变化、评论编辑把已经越过水位的旧评论重新变成命令；
- 不再持久化执行机、工作目录或 session 绑定；
- 不再保存足以恢复活跃 Harness 运行态的技术状态；
- 允许目录／session 不匹配时静默换目录或新建会话；
- 改变单写入者、正常重启去重或状态损坏处理语义；
- 把 Harness 会话正文、模型输出或凭据纳入 Runner 普通状态文件。

### 实现可以自主演进的内容

在不破坏上述语义时，Implementer 可以直接调整：

- `lastTrigger` 内部状态名称和诊断字段；
- `lastRun` 的附加诊断字段；
- 时间戳、日志引用、缓存字段；
- JSON 对象的内部组织方式；
- 原子写入、日志轮转等实现细节。

不为每个内部字段增加维护者审批。

## 首次接入与历史扫描基线

新仓库第一次加入 Runner 时，先做一次**简单的全量历史 baseline**；baseline 完成以前，该仓库尚未进入正式接单状态，Runner **不接受也不保证保留这段初始化期间出现的触发**。

V1 只需要一个仓库级完成状态，例如 `baselineCompleted: false | true`，不保存 Issue cutoff、初始化 cursor、pending 命令、快照队列或复杂恢复状态机：

1. 新仓库首次接入时先持久化 `baselineCompleted=false`；
2. 读取该仓库当前已有的 Issue；对这些 Issue 把初始 Body 记为已处理，并把当时最新评论写入各自的 `commentScanWatermark`，不执行其中任何历史 `@<runnerName>`；
3. baseline 本身不写 `lastTrigger`、不建立 active run，也不发送接单反馈；
4. 全部 baseline 成功落盘后，再把仓库级 `baselineCompleted=true`；**只有此后**该仓库才进入正常增量轮询和 Trigger Contract；
5. baseline 过程中 Runner 崩溃或中断时，`baselineCompleted` 仍为 false。下次启动直接**从头重做整个 baseline**，不恢复“做到哪个 Issue”的进度；
6. baseline 初始化期间恰好出现的 Issue／评论可能在重做或完成 baseline 时被视为历史而不执行，这是 V1 明确接受的低频人工边界。需要可靠执行时，在 `baselineCompleted=true` 后重新发布新的 `@<runnerName>` 控制评论。

这个取舍刻意把首次接入定义成“初始化完成后才正式启用”。它避免为极少发生的首次初始化崩溃／并发新增场景引入仓库快照边界、Issue cutoff、恢复 cursor 或 pending queue。人工重新发布一次命令是允许的恢复方式。

正常运行中的新 Issue 不属于 baseline：仓库一旦 `baselineCompleted=true`，后续新 Issue 的一次性 Body 与评论都按 Trigger Contract 正常处理。

## 版本与兼容

- 当前持久化版本为 `version: 1`。
- 文件不存在可视为首次接入；文件存在但无法可靠解析时不得静默覆盖原状态。
- 不兼容变化必须选择一种明确行为：升级 Schema 并提供必要迁移，或拒绝启动并要求人工确认。
- 不要求为尚未部署、仅存在于开发 PR 中的每个中间版本建立迁移链。只有真实持久化兼容需求成立时才增加迁移。
- 状态写入应避免把半截文件当成有效状态；可采用“临时文件 + rename”等原子替换方式，但具体原子写实现不属于长期数据模型 Contract。

## 状态与 GitHub 可见性的边界

`state.json` 可以包含真实本机目录、sessionId、运行日志路径等，因为它是受控本机状态；这些内容**不因此自动适合公开**。

Runner 的 GitHub 控制反馈应遵循 Current 定义的职责边界：[范围与工作链路](01-scope-and-flow.md) 与 [Runner 激活与任务触发 Contract](03-runner-trigger.md) 只规定两类可见反馈——成功接单（`BOT:<runnerName>` + Session ID）与 Harness 根本无法正常启动／续接时的简短失败回复。正常 Harness 结束后的 exit/status、模型输出与本机绑定继续留在本地，不由 Runner 转述成业务完成。

## 当前存储选择

首版使用本机 JSON 文件，不引入 SQLite、MongoDB、中央数据库或分布式状态服务。当前数据量、单机单实例和人工可检查需求下，JSON 足够简单；未来只有在真实并发、查询或数据量需求出现时再通过新的 Issue / Contract 讨论替换。
