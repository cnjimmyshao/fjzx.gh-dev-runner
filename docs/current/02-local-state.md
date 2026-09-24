# 本机配置与状态 Schema

本文件定义 Runner 首版本机配置与持久化状态的 Current Contract。它描述哪些信息必须被保存、如何寻址，以及哪些字段属于当前 v1 实现；不要求把所有内部字段永久锁死。

## 四类数据的责任边界

| 数据 | 当前位置／入口 | 责任 |
| --- | --- | --- |
| Runner 配置 | 本机配置文件，当前示例为 `.local/config.json` | 本机身份、允许仓库／发起人、工作目录、GitHub/Harness 调用参数 |
| Runner 状态 | `<stateDir>/state.json` | 内容处理进度、任务绑定、sessionId、活跃 Harness 调用、并发容量与恢复所需技术状态 |
| Harness 会话 | Harness 自己的 `DSH_HOME` | 真正的模型对话、上下文与 Harness 持久化数据 |
| 凭据 | `gh` 登录与 Harness 支持的凭据存储 | GitHub 授权和模型 Key；不进入普通配置／状态 JSON |

Runner **不复制 Harness 会话历史**，也不把 Issue 全文、PR 内容或模型输出作为长期状态保存。Runner 只保存把“仓库 + Issue”重新定位到正确执行机、工作目录和 Harness session，以及判断“哪些 Harness 仍在运行、是否还有并发槽位、重启后如何恢复”所需的技术状态。

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
| `runtime.pollSeconds` | GitHub 增量检查间隔；调度 Contract 的目标默认值为 300 秒 |
| `runtime.maxConcurrentHarnesses` | 本机同时允许的 Harness 调用上限；具体语义由调度 Contract 定义 |
| `runtime.capture` / `keepRunLogs` | 本机子进程输出与日志保留策略 |
| `github.timeoutMs` / `pageSize` | `gh` 调用和分页参数 |
| `repositories[].repo` | 接入仓库身份，使用 `owner/name` |
| `repositories[].allowedActors` | 允许发布执行请求的 GitHub 登录名 |
| `repositories[].sourceDir` | 部署者已有仓库检出，用作创建独立任务 worktree 的源目录 |
| `repositories[].baseBranch` / `worktreeDir` | worktree 起点与存放位置；每个任务最终目录必须唯一 |
| `repositories[].maxConcurrentHarnesses` | 单仓库同时允许的 Harness 调用上限；具体语义由调度 Contract 定义 |

同一仓库的多个 Issue **不得共享一个可写任务 checkout**。如果实现保留类似 `repoDir` 的兼容字段，它只能表示源仓库／父目录，或必须有明确的按任务唯一派生规则；不能让两个不同 Issue 的 Harness 写入同一个工作树。

模型 Key 不属于该配置 Contract。Runner 不读取、打印或保存模型 Key；Harness 按自身支持的凭据机制加载它。

## state.json 的任务主键

任务身份必须是：

```text
repository identity + Issue number
```

不能只用 Issue number。不同仓库都可能存在 `#1`、`#9` 等相同编号，状态必须彼此隔离。

当前 v1 以嵌套 JSON 表示：

```text
activeRuns
└── "<runId>"
    ├── repository + issueNumber
    ├── trigger identity
    ├── sessionId + runnerName
    ├── process identity / pid（若可获得）
    ├── status
    └── startedAt / lastObservedAt / endedAt

repositories
└── owner/repo
    └── "<issueNumber>"
        ├── seenSeq
        ├── commands[]
        ├── binding
        └── lastRun
```

这是当前存储形状；稳定 Contract 是“仓库身份 + Issue 编号”的复合主键，而不是要求未来永远使用同样的嵌套对象布局。

## state.json v1 示例

以下示例展示当前实现使用的主要字段。路径、session 和时间均为占位值：

```json
{
  "version": 1,
  "activeRuns": {
    "run-20260924-001": {
      "repository": "owner/project",
      "issueNumber": 42,
      "trigger": {"sourceType": "comment", "sourceId": "123456"},
      "runnerName": "MB01",
      "sessionId": "session-...",
      "status": "running",
      "pid": 12345,
      "startedAt": "2026-09-24T00:10:00.000Z",
      "lastObservedAt": "2026-09-24T00:12:00.000Z",
      "endedAt": null
    }
  },
  "repositories": {
    "owner/project": {
      "42": {
        "seenSeq": 123456,
        "commands": [
          {
            "sourceType": "comment",
            "sourceId": "123456",
            "author": "maintainer-login",
            "status": "claimed",
            "at": "2026-09-24T00:00:00.000Z",
            "finishedAt": null,
            "feedbackSent": false,
            "retryable": false
          }
        ],
        "binding": {
          "runnerName": "MB01",
          "dir": "<本机绝对任务目录>",
          "sessionId": "session-...",
          "branch": "fjzx/issue-42",
          "source": "<本机源仓库目录>",
          "worktreeCreated": true,
          "createdAt": "2026-09-24T00:00:00.000Z"
        },
        "lastRun": {
          "at": "2026-09-24T00:10:00.000Z",
          "kind": "completed",
          "exitCode": 0,
          "statusKind": "completed",
          "dir": "<本机绝对任务目录>",
          "runDir": "<本机日志目录>"
        }
      }
    }
  }
}
```

`lastRun.kind=completed` 或 Harness 的 `status.kind=completed` 只表示本机技术调用状态，**不是业务完成**，也不意味着 Runner 要把“完成”写回 GitHub。Runner 与 Dev 的 GitHub 反馈边界以 Issue #11 / 对应 Current 决定为准。

## v1 字段语义

### 顶层

| 字段 | 稳定性 | 含义 |
| --- | --- | --- |
| `version` | 稳定 Contract | 持久化 Schema 版本。读到不支持的版本不得静默当成新状态 |
| `repositories` | 稳定 Contract | 按仓库身份隔离任务状态 |
| `activeRuns` | 稳定语义、内部字段可演进 | 当前或恢复中的 Harness 调用索引，用于重建机器／仓库并发占用并防止重启后重复拉起 |

### 每个仓库 + Issue

| 字段 | 稳定性 | 含义 |
| --- | --- | --- |
| `seenSeq` | 稳定语义 | 评论增量处理进度；正常重启不能因此重放已处理命令 |
| `commands[]` | 稳定语义、内部字段可演进 | 已观察／认领命令的处理记录，用于去重、恢复与必要反馈 |
| `binding` | 稳定 Contract | 任务与执行机、工作目录、Harness session 的持久绑定；首次绑定前可为空 |
| `lastRun` | 稳定语义、内部字段可演进 | 最近一次本机调用的技术结果与诊断入口；不代表业务结果 |
| `inFlight` 等瞬时／恢复字段 | 实现 Schema | 可缓存任务内当前调用引用；机器级真实活跃调用以可恢复的运行态记录为准，字段名可演进，但不能破坏单写入者 Contract |

### `binding`

| 字段 | 稳定性 | 含义 |
| --- | --- | --- |
| `runnerName` | 稳定 Contract | 绑定所属 Runner；配置不匹配时不得静默在另一台机器继续 |
| `dir` | 稳定 Contract | 任务的本机工作目录；后续续接必须回到同一目录 |
| `sessionId` | 稳定 Contract | Harness 持久会话标识；后续针对同一任务的有效触发必须续接该 session，不能静默新建 |
| `branch` | 稳定语义 | 已知任务分支；用于继续原开发而不是创建重复工作 |
| `source` | 实现 Schema | 当前工作目录来源／源仓库信息，用于校验配置变化 |
| `worktreeCreated` | 实现 Schema | 当前目录是否由 Runner 创建为 worktree |
| `createdAt` | 实现 Schema | 绑定创建时间，便于排查 |
| 未来的已知 PR 标识 | 稳定语义 | 若实现保存 PR 绑定，必须属于同一“仓库 + Issue”任务；字段名由实现任务确定 |

### `commands[]`

命令记录至少要能回答“哪一个 GitHub 内容事件已经处理、是否真正启动、是否允许恢复／重试”，防止重复轮询或重启造成重复开发。Issue Body 与 Comment 都是正式触发入口，因此不能把幂等键固定成“评论 id”。

| 字段 | 稳定性 | 含义 |
| --- | --- | --- |
| `sourceType` | 稳定 Contract | `issue_body` 或 `comment`，区分触发来源 |
| `sourceId` | 稳定 Contract | 对应 GitHub 内容事件的稳定身份；Comment 使用 comment id，Issue Body 使用能够唯一指向“新建 Issue Body 事件”的 GitHub identity |
| `author` | 稳定语义 | 内容作者，用于审计／授权结果回查 |
| `status` | 实现 Schema | 当前处理状态名称，例如 pending / claimed / running / failed 等；名称可随实现收敛 |
| `at` / `finishedAt` | 实现 Schema | 本机处理时间 |
| `feedbackSent` | 实现 Schema | 是否已经发送必要的 Runner 控制反馈，避免重复刷评论 |
| `retryable` / 兼容标记 | 实现 Schema | 恢复判定所需的内部标记；不得因此无依据扩大自动恢复 Contract |

### `activeRuns` / Harness 运行态

Runner 在决定是否领取并启动一个新任务之前，必须先依据本机持久化状态恢复“当前有哪些 Harness 调用仍可能占用槽位”，并在可行时与本机真实进程状态核对。单靠内存中的 Promise / 子进程对象不够，因为 Runner 自身可能崩溃或重启。

每个活跃／待恢复调用至少必须能追溯：

- 本机唯一 `runId`；
- repository + Issue number；
- 触发来源 identity；
- `runnerName`；
- START / RESUME；
- `sessionId`；
- Harness 启动时间；
- 当前技术状态（至少能区分 starting / running / exited / unknown 的等价语义）；
- 进程身份（PID 若可获得；实现还应保存足以避免 PID 重用误判的附加证据）；
- 最近一次确认该进程状态的时间；
- 已结束时的结束时间、exit code / 技术结果与诊断入口。

这些字段的精确 JSON 名称可以演进，但“能够在重启后恢复并发占用、确认旧 Harness 是否仍在运行”是稳定 Contract。

Runner 重启后，对上次记录为 starting / running、但当前尚未确认结果的调用必须先做恢复核对：

1. 能确认原 Harness 仍在运行：继续按 running 计入机器级和仓库级并发槽位；
2. 能确认原 Harness 已退出：记录退出／失效结果并释放槽位；
3. 无法可靠确认：标为 unknown，**保守继续占用槽位**，不得仅因为 Runner 重启就再启动同一任务或用新任务突破并发上限；
4. unknown 只有在后续进程探测取得确定结果，或维护者执行明确的恢复／解除动作后才释放。

因此，历史／状态记录不是只用于审计；它也是 Scheduler 在每次领取前计算真实可用容量的输入。完整长期追溯可继续写结构化 audit/run log，而 `state.json` 至少保存调度恢复必须的当前技术状态。

## 稳定 Contract 与实现 Schema

### 需要先改 Current 的变化

下列语义属于长期 Contract，修改时先更新本文或相关 Current，再改运行代码：

- 任务主键不再是“仓库 + Issue”；
- 不再保存评论处理进度，或允许正常重启重放已处理命令；
- 不再持久化执行机、工作目录或 session 绑定；
- 不再保存足以恢复活跃 Harness 调用和并发占用的技术运行态；
- 允许目录／session 不匹配时静默换目录或新建会话；
- 改变单写入者、正常重启去重或状态损坏处理语义；
- 把 Harness 会话正文、模型输出或凭据纳入 Runner 普通状态文件。

### 实现可以自主演进的内容

在不破坏上述语义时，Implementer 可以直接调整：

- `commands[]` 内部状态名称和诊断字段；
- `lastRun` 的附加诊断字段；
- 时间戳、日志引用、缓存字段；
- JSON 对象的内部组织方式；
- 原子写入、日志轮转等实现细节。

不为每个内部字段增加维护者审批。

## 版本与兼容

- 当前持久化版本为 `version: 1`。
- 文件不存在可视为首次接入；文件存在但无法可靠解析时不得静默覆盖原状态。
- 不兼容变化必须选择一种明确行为：升级 Schema 并提供必要迁移，或拒绝启动并要求人工确认。
- 不要求为尚未部署、仅存在于开发 PR 中的每个中间版本建立迁移链。只有真实持久化兼容需求成立时才增加迁移。
- 状态写入应避免把半截文件当成有效状态；当前实现采用“临时文件 + rename”，但具体原子写实现不属于长期数据模型 Contract。

## 状态与 GitHub 可见性的边界

`state.json` 可以包含真实本机目录、sessionId、运行日志路径等，因为它是受控本机状态；这些内容**不因此自动适合公开**。

Runner 的 GitHub 控制反馈应遵循 Current 的职责边界：成功叫起 Dev、命令未启动、根本启动失败，以及 Dev 无法自行交接时的必要基础设施异常。正常 Harness 结束后的 exit/status、模型输出与本机绑定继续留在本地，不由 Runner 转述成业务完成。

## 当前存储选择

首版使用本机 JSON 文件，不引入 SQLite、MongoDB、中央数据库或分布式状态服务。当前数据量、单机单实例和人工可检查需求下，JSON 足够简单；未来只有在真实并发、查询或数据量需求出现时再通过新的 Issue / Contract 讨论替换。
