# 本机 Harness CLI 首轮执行与同会话续接验证

Date: 2026-09-23
Keywords: Harness, dsh, headless CLI, ACP, session resume, 本机验证
Status: VERIFIED（范围限本文记录的时间、版本、电脑与实际命令）

关联：[Issue #7](https://github.com/cnjimmyshao/fjzx.gh-dev-runner/issues/7)；方案依据 [ADR 0002](../decisions/0002-headless-cli-execution.md) 与 [Issue #3 的维护者决定](https://github.com/cnjimmyshao/fjzx.gh-dev-runner/issues/3#issuecomment-5795769722)。
已查仓库 commit：`3e0551c`（PR #6 合并后的 `main`）。

## 调查问题

按 Issue #7 的验收项核对本机实际安装版本：

1. 能否用本机已保存的模型配置启动 Harness CLI 完成一轮短任务，并取得真实会话标识；
2. 首个进程退出后，第二个进程能否续接同一持久化会话，而不是新开会话或把前文复制给新会话；
3. 调用方能否从输出与退出状态区分成功、错误与中止。

上游 headless 文档提供 `--json` / `--session-id` 作为核对入口，本报告不作为本机已支持的证明。

## Environment

| 项目 | 实际值 |
| --- | --- |
| 电脑／系统 | 维护者指定的本机执行电脑（Windows），普通用户账户 |
| Node.js | v26.7.0 |
| Harness | `@deepseek-ai/dsh` 0.1.5-rc.2（`npx` 缓存安装），`dsh` 启动器 |
| 涉及 bundle | `@deepseek-ai/dsh-headless` 0.1.5-rc.2、`@deepseek-ai/dsh-acp-app` 0.1.5-rc.2 |
| 测试工作目录 | 独立临时目录（`%TEMP%\fjzx-gh-dev-runner-issue7\workdir`），无业务文件、无 `AGENTS.md` |
| 持久化配置 | 独立 `DSH_HOME`（`%TEMP%\fjzx-gh-dev-runner-issue7\dsh-home`），首次启动由启动器自动初始化 profile 与模块链接 |
| 模型凭据 | 本机已保存的凭据文档复制进该独立 home，未重新手填、未写入命令行、未进入任何输出 |
| 权限 | 默认 `workspace-write` + `ask`；本轮短消息未触发工具调用，未出现审批提示 |
| 未触碰 | 工作中的 `dsh web`（`127.0.0.1:3080`，进程自 10:44 起未重启、未升级、未接管）；未改仓库、Actions、权限 |

`DSH_HOME` 是受支持的家目录覆盖点；消息、会话与日志因此全部落在独立 home，与工作中的 Web 会话互不可见。另一条查证型问题触发过读取类工具调用：执行者只读取了本仓库文档与 `npx` 缓存里的 `@deepseek-ai/dsh` 包文件（事后按文件访问时间核对），全部实测结束后测试目录仍为空，未产生业务写入。

## 可复现步骤

脱敏符号：`<dsh>` 为 `dsh` 启动器入口，`<tmp>` 为上述独立测试根目录。

```powershell
$env:DSH_HOME = '<tmp>\dsh-home'          # 独立持久化 home
New-Item -ItemType Directory -Force '<tmp>\workdir'
Set-Location '<tmp>\workdir'

# 1) 首轮：headless 单次任务
node <dsh> --profile headless "Reply with exactly this token and nothing else: SMOKE-TOKEN-ISSUE7"

# 2) 同名 flag 核对（上游文档入口在本机版本是否存在）
node <dsh> --profile headless --session-id <id> "hi"
node <dsh> --profile headless --json "hi"

# 3) 同一目录下的第二轮任务（观察是否续接）
node <dsh> --profile headless "Repeat the exact token I asked you for in the previous message. If you cannot see any previous message, reply exactly: NO-PRIOR-CONTEXT"

# 4) 同会话续接：走 `acp` profile（stdio JSON-RPC），探针见 probes/acp-session-probe.mjs
$env:DSH_BIN = '<dsh>'
node probes/acp-session-probe.mjs new    '<tmp>\workdir' "Remember this token for later: CARGO-92. Reply with exactly: STORED"
node probes/acp-session-probe.mjs resume '<tmp>\workdir' <sessionId> "You told me a token earlier in this conversation. Reply with exactly that token followed by -RESUMED (no other text)."
```

会话标识取自持久化目录名（`<DSH_HOME>\sessions\<工作目录 slug>\<sessionId>`）与 `session/new` 的返回值；报告中的标识均为测试会话。

## Results

### 1. 首轮执行：通过（headless）

| 观测项 | 实际结果 |
| --- | --- |
| 命令 | `dsh --profile headless "<短消息>"`，工作目录为独立测试目录 |
| stdout | `SMOKE-TOKEN-ISSUE7`（仅最终回答一行） |
| stderr | `dsh: reasoning:` 段落与模型的思考文本 |
| 退出状态 | 0 |
| 会话标识 | `session-aedfc48c…`（脱敏）；持久化于 `<DSH_HOME>\sessions\--…workdir--\session-aedfc48c…\session.v3.jsonl.zstd`，同目录另有投影缓存记录 |
| 工具调用 | 无；测试目录未被写入 |

Headless 只输出「最终回答 + stderr + 退出码」，没有结构化事件流，因此第一轮的工具调用无法从输出直接观察；该轮结束后检查测试目录，未发现新增或修改的文件（目录为空）。

未配置凭据时同一命令的表现为：stdout 空、stderr `dsh: MISSING_CREDENTIAL: llm-deepseek: no API key for provider route "deepseek-official"; …`、退出状态 1，且未产生模型请求（该会话 token 用量为 0）。凭据按受支持方式放入独立 home 后，无需再次手填即可重跑成功。

### 2. 退出后续接：本机 headless **不支持**，`acp` profile 通过

headless 侧（同一工作目录、同一 `DSH_HOME`、第二个独立进程）：

| 观测项 | 实际结果 |
| --- | --- |
| `--session-id <id>` | 退出 1，stderr `error: unknown option '--session-id'` |
| `--json` | 退出 1，stderr `error: unknown option '--json'` |
| 同目录第二轮普通任务 | 退出 0，回答 `NO-PRIOR-CONTEXT`；会话目录由 2 个变为 3 个，即**新建会话**而非续接 |
| `--profile headless --help` | 只有 `[task...]` 与 `-h, --help`，无会话或结构化输出选项 |

依据：本机 `@deepseek-ai/dsh-headless@0.1.5-rc.2` 的 runner 固定以 `session-${randomUUID()}` 创建新 Agent，配置项只有 `task`；同版本 `0.1.5-rc.3` 仍相同，`0.1.6-alpha.1` 起 `startup` 才出现 `--session-id` / `--json`（比对 npm 包内容与上游 README，未安装、未升级）。

`acp` profile（同版本随附的 stdio JSON-RPC 界面，同样是本地进程，不开端口）：

| 步骤 | 进程 | 结果 |
| --- | --- | --- |
| `session/new` + 首条消息 | 进程 A | `sessionId = 6ad2faae…`，回答 `STORED`，`stopReason = end_turn`，会话持久化到独立 home |
| 进程 A 退出后 `session/resume` + 依赖前文的消息 | 进程 B（新进程） | 回答 `CARGO-92-RESUMED`，即准确复述首轮 token；`stopReason = end_turn` |
| 会话记录 | — | 两轮追加在同一会话目录与同一日志文件（首轮后约 13 KB，续接后约 23 KB），未新建会话 |

调用方只发送会话标识与当前消息，未把首轮回答或前文拼进请求；第二轮回答复述的 token 只存在于该会话自身的持久化记录中，因此不可能由新会话推断得出。

### 3. 结果与失败：可区分，但 headless 的成功／中止不等于业务成功

| 场景 | stdout | stderr | 退出状态 | 调用方可判定 |
| --- | --- | --- | --- | --- |
| headless 正常完成 | 最终回答一行 | reasoning 段落 | 0 | 完成 |
| headless 缺少凭据（不调用模型的安全失败） | 空 | `dsh: MISSING_CREDENTIAL: …` | 1 | 错误，且能读到错误码 |
| headless 缺任务参数 | 空 | `error: a task is required, …` | 1 | 用法错误 |
| headless 未声明的选项 | 空 | `error: unknown option '--session-id'` | 1 | 用法错误 |
| acp 续接不存在的会话 | 无结果对象 | JSON-RPC `-32602`，`session is not resumable: <id>` | 探针退出 1，任务未运行 | 错误 |
| acp 用不匹配的工作目录续接 | 无结果对象 | JSON-RPC `-32602`，`session cwd does not match: …` | 探针退出 1，任务未运行 | 错误 |

限制与注意：

- 本机 headless 没有 `--json`，只有「最终回答 + stderr + 退出码」；`final` 之类的结构化事件在本版本不可用，报告不据此判定成功。
- headless 的退出 0 只表示回合以 `completed` 结束，不代表业务完成；而「回合失败且无 assistant 消息」与「正常完成但回答为空」都会是 stdout 空行，调用方不能只靠 stdout 区分，必须结合退出码与 stderr。
- headless 的失败信息是 `dsh: <code>: <message>` 文本，需要解析文本；acp 侧是结构化 JSON-RPC 错误码与消息，判读更直接。
- 实测短消息不触发工具调用；另用一条需要查证的问题（`which command starts the dsh web surface?`）确认了工具调用事件可按 `tool_call` / `tool_call_update` 读取，答案为 `` `dsh web` ``。该轮执行者只读取本仓库文档与安装包文件作答，未修改文件；审批交互、长任务、并发写入者与跨机场景未覆盖。

## Conclusion

- **首轮执行**：本机 0.1.5-rc.2 的 headless CLI 可以在独立目录、独立 `DSH_HOME` 与已保存凭据下完成一轮短任务，并留下可取出的持久化会话标识。已实测。
- **退出后续接**：本机版本的 headless **不能**按保存的会话标识续接，同名 flag 不存在，同目录再次调用只会新建会话。已实测，且与上游文档描述不同——上游 `--json` / `--session-id` 属更高版本（`0.1.6-alpha.1` 起），本机尚未安装。仅上游说明，本机未验证。
- **会话续接能力本身存在**：同版本的 `acp` stdio profile 已在本机跨进程通过 `session/resume` 续接成功，并可用工作目录校验拒绝错配会话（第二轮准确复述了首轮 token `CARGO-92`）。这是本机实测证据，说明缺的是首版所选 CLI 界面，而不是 Harness 的持久化能力。
- **进入接单功能开发的条件**：具备。进程调用、会话标识保存、续接与失败判读都有可用路径；需要先由维护者选定使用哪条调用路径（见下），因为它改变工具实现与 Harness 版本前提。

## 需要维护者决定（阻塞接单实现的首版形态，不阻塞其他工作）

| 方案 | 内容 | 代价与前提 |
| --- | --- | --- |
| A（当前文档方向） | 继续用 headless CLI，但**需要先升级本机 Harness** 到含 `--session-id` / `--json` 的版本（`0.1.6-alpha.1` 起） | 需要维护者授权升级工作中的 Harness；升级后行为须按新版本重新实测，本报告不构成其证据 |
| B（本机现状可用） | 首版改用同版本随附的 `acp` stdio profile：`session/new` 取标识、`session/resume` 续接、`session/prompt` 投递、`session/close` 收尾 | 与 ADR 0002 及 Current 写的「headless CLI」界面不同，需要同步 Current／ADR；相对 headless 多一层 JSON-RPC 协议，但不新增服务与端口 |
| C | 保持 headless，接受每轮新建会话 | 与 Issue #7 验收项 2 及 Current 的「同任务续接、不每次从头开始」冲突，不建议 |

Issue #7 记录的是「验证 headless CLI」这一方向；方案 B 属于界面变更，超出 Implementer 取舍范围，因此本报告只提出，不据此改代码或改 Current。

## Contract Impact

未改任何代码、Current 或 ADR。本报告只提供证据：i) headless 单轮调用可用；ii) 本机 headless 版本无会话续接与结构化输出；iii) 同版本 acp 界面可跨进程续接会话。是否据此调整首版调用界面或版本前提，待维护者决定后再同步 `docs/current/`。

## 未覆盖范围

- 未验证升级后的 headless 行为（未安装新版本，未动工作中的 Harness）。
- 未验证 `acp` 界面的审批交互、工具调用、长任务、并发多写入者与取消语义，只覆盖了创建、续接、单轮投递与两类失败。
- 未验证第二台电脑、跨机路由与 Harness 进程重启后的续接。
- 未把本验证做成接单程序的环境诊断；工具自身的配置、去重与绑定持久化属后续实施 Issue。
- 原始凭据、完整会话日志与绝对机器路径未进入本报告；测试会话与临时目录仅保留在本机。
