# 本机 Harness CLI 首轮执行与同会话续接验证

Date: 2026-09-23
Keywords: Harness, dsh, headless CLI, profile patch, session resume, 本机验证
Status: VERIFIED（范围限本文记录的时间、版本、电脑与实际命令）

关联：[Issue #7](https://github.com/cnjimmyshao/fjzx.gh-dev-runner/issues/7)；方案依据 [ADR 0002](../decisions/0002-headless-cli-execution.md) 与 [Issue #3 的维护者决定](https://github.com/cnjimmyshao/fjzx.gh-dev-runner/issues/3#issuecomment-5795769722)，并按 [Issue #7 的维护者补充](https://github.com/cnjimmyshao/fjzx.gh-dev-runner/issues/7#issuecomment-5797451031) 独立实现、不参考旧 Workflow。
已查仓库 commit：`3e0551c`（PR #6 合并后的 `main`）；本地 runner 与本文同时提交。

## 调查问题

按 Issue #7 的验收项核对本机实际安装版本，并按维护者补充提供可复用的最小调用／续接脚本：

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
$repo = '<本仓库>'                         # 例：D:\nodejs\fjzx.gh-dev-runner
$env:DSH_HOME = '<tmp>\dsh-home'          # 独立持久化 home
$env:DSH_BIN  = '<dsh>'                    # dsh 启动器入口
New-Item -ItemType Directory -Force '<tmp>\workdir'
Set-Location '<tmp>\workdir'

# 1) 首轮：headless 单次任务
node <dsh> --profile headless "Reply with exactly this token and nothing else: SMOKE-TOKEN-ISSUE7"

# 2) 同名 flag 核对（上游文档入口在本机版本是否存在）
node <dsh> --profile headless --session-id <id> "hi"
node <dsh> --profile headless --json "hi"

# 3) 同一目录下的第二轮任务（观察是否续接）
node <dsh> --profile headless "Repeat the exact token I asked you for in the previous message. If you cannot see any previous message, reply exactly: NO-PRIOR-CONTEXT"

# 4) 同会话续接：走 `acp` profile（stdio JSON-RPC），探针用仓库绝对路径
node "$repo\docs\research\probes\acp-session-probe.mjs" new    '<tmp>\workdir' "Remember this token for later: CARGO-92. Reply with exactly: STORED"
node "$repo\docs\research\probes\acp-session-probe.mjs" resume '<tmp>\workdir' <sessionId> "You told me a token earlier in this conversation. Reply with exactly that token followed by -RESUMED (no other text)."

# 5) 同会话续接：本地 runner 挂到 headless profile（见 docs/research/probes 与 scripts/headless-session）
$env:DSH_TASK = 'Reply with exactly this token and nothing else: SESSION-CLI-1'
node $env:DSH_BIN --profile headless --patch "$repo\scripts\headless-session\overlay.yml"
$env:DSH_SESSION_ID = '<上一步返回的 sessionId>'
$env:DSH_TASK = 'Repeat the exact token from the previous message followed by -AGAIN.'
node $env:DSH_BIN --profile headless --patch "$repo\scripts\headless-session\overlay.yml"
```

第 4 步的探针在切换工作目录后仍以仓库绝对路径调用，否则会被解析为测试目录下的同名文件。

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

### 2b. 退出后续接：本地 runner 挂到 headless profile 也通过

按维护者「保留 headless CLI 界面、独立实现调用／续接、不擅自升级或改用其他界面」的方向，用 profile composition 的公开扩展点补齐本机版本缺的会话身份：`scripts/headless-session/overlay.yml` 停用该 bundle 自带的 `headless-startup` 与 `headless-runner`，把 `scripts/headless-session/runner.mjs` 挂成 runner；用法与边界见该目录的 [README](../../scripts/headless-session/README.md)。命令仍是启动器 + headless profile：

```powershell
node $env:DSH_BIN --profile headless --patch <仓库>\scripts\headless-session\overlay.yml
```

实测（同一独立 `DSH_HOME`、同一工作目录、多个独立进程）：

| 步骤 | 环境变量 | 实际结果 |
| --- | --- | --- |
| 首轮新建 | `DSH_TASK=…SESSION-CLI-1` | 退出 0；stdout `{"sessionId":"session-8f2793f2…","continueReason":"created","status":{"kind":"completed"},"text":"SESSION-CLI-1","cwd":"…"}` |
| 第二进程续接 | 加 `DSH_SESSION_ID=session-8f2793f2…` | 退出 0；`continueReason":"resumed"`，回答 `SESSION-CLI-1-CONTINUED`；第三轮回答 `SESSION-CLI-1-AGAIN`，均复述首轮 token |
| 结果文件 | `DSH_RESULT_FILE=<path>` | 与 stdout 同一份 JSON 落盘，接单程序可直接读取会话标识与状态 |
| 未知会话标识 | `DSH_SESSION_ID=session-does-not-exist-7` | 退出 1，stderr `dsh: session "session-does-not-exist-7" not found`；会话目录数不变，未静默新建 |
| 工作目录不匹配 | 在另一目录续接 | 退出 1，并报出会话记录目录；未在新目录继续旧任务 |
| 缺凭据 | 空 `DSH_HOME`、无继承 Key | 退出 1；stdout 的 result JSON 带 `status.error.code=MISSING_CREDENTIAL`，stderr 为同一错误行 |

提交前用仓库内副本（`scripts/headless-session/`）重跑一轮新建 + 续接，结果一致（`REPO-RUN-1` → `REPO-RUN-1-RESUMED-REPO`）。

实现要点与代价：

- runner 通过 core 服务 `agentDefaultModel.currentSelection()` 取模型选择，用 `agents.create({ sessionId, meta: { cwd } })` 新建、`agents.resume({ resumeSessionId })` 续接，再 `followup` 一轮、`sessions.flush` 后按 `turn/end` 结果决定退出码；与官方 headless runner 的差异只在会话身份。
- **实测发现本机 headless 的 resume 不校验工作目录**：直接 `agents.resume` 后在新目录继续旧会话会成功（与 acp profile 的 `session cwd does not match` 行为不同）。因此 runner 自己按 session header 的 `cwd` 做前置校验，不匹配即失败退出，避免执行者在错误目录继续旧任务。
- `runner.mjs` 位于仓库，需按 `DSH_BIN` 指向的安装解析随安装提供的包（`@deepseek-ai/dsh-llm` 的 `createUserMessage`）。这是本方案的唯一额外耦合点，已在脚本内显式报错。
- overlay 按行 id 停用 bundle 的两行；bundle 升级后 id 变化会变成 `patch: entry … not found` 警告（0.1.5-rc.2 与 0.1.5-rc.3 相同）。
- 未使用 `--json`（本机版本没有），结构化结果由本地 runner 自己产出；未新增服务、端口或安装。

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

- 本机 headless CLI 自身没有 `--json`，只有「最终回答 + stderr + 退出码」时，调用方不能只靠 stdout 区分「回合失败且无 assistant 消息」与「完成但回答为空」；本地 runner（2b）改为在 stdout 输出 result JSON 并带上 `status`，接单程序按结构与退出码判读，不必解析文本。
- 本机 headless 的失败信息是 `dsh: <code>: <message>` 文本，需要解析文本；acp 侧是结构化 JSON-RPC 错误码与消息，判读更直接。
- 实测短消息不触发工具调用；另用一条需要查证的问题（`which command starts the dsh web surface?`）确认了工具调用事件可按 `tool_call` / `tool_call_update` 读取，答案为 `` `dsh web` ``。该轮执行者只读取本仓库文档与安装包文件作答，未修改文件；审批交互、长任务、并发写入者与跨机场景未覆盖。

## 结论与后续方向

- **首轮执行**：本机 0.1.5-rc.2 的 headless CLI 可以在独立目录、独立 `DSH_HOME` 与已保存凭据下完成一轮短任务，并留下可取出的持久化会话标识。已实测。
- **退出后续接**：本机版本的 headless CLI 自身**不能**按保存的会话标识续接（同名 flag 不存在，同目录再次调用只会新建会话）。已实测，且与上游文档描述不同——上游 `--json` / `--session-id` 属更高版本（`0.1.6-alpha.1` 起），本机尚未安装，本报告不据其判断。
- **用本地 runner 补齐后可用**：按维护者「保留 headless CLI 界面、独立实现、不擅自升级或改用其他界面」的方向，`scripts/headless-session/` 已在本机实测新建、跨进程续接、结构化结果与失败信号，未新增服务、端口或安装。这是后续接单工具可复用的最小调用件。
- **其他界面亦可续接**：同版本的 `acp` stdio profile 也实测跨进程续接成功（第二轮复述首轮 token `CARGO-92`），仅作为「缺的是界面而非持久化能力」的证据保留，不作为选定路径。
- **能力边界**：会话续接依赖「保存会话标识 + 相同工作目录 + 匹配配置」；本机 headless 的 resume 不校验目录，本地 runner 已补该前置校验。跨机、并发写入者与 Harness 进程重启后的续接未验证。

## 已知取舍与遗留

| 项 | 现状 | 影响 |
| --- | --- | --- |
| 依赖本地 runner | 续接、结构化结果由 `scripts/headless-session/runner.mjs` 提供，而非官方 CLI 选项 | 需随 Harness 升级复核 overlay 行 id 与 core 服务签名；本机 0.1.5-rc.2 已实测 |
| 上游更高版本选项 | `--session-id` / `--json` 自 `0.1.6-alpha.1` 起存在 | 若维护者日后授权升级，可改用官方选项并简化 runner；升级前不以其为验收依据 |
| 目录校验 | headless 自身不校验；本地 runner 前置校验 | 接单工具仍须保证「同一任务固定工作目录」 |
| 结构化事件 | 本机无 `--json`，只有本地 runner 的 result JSON 与 stderr | 逐 token 进度与中间工具事件不作为首版依赖 |

## Contract Impact

未改 Current、ADR 或既有需求语义：命令仍是「启动器 + headless profile」，只是通过 profile composition 补上本机版本缺的会话身份与结果输出，工作目录、持久化与凭据边界不变。新增的 `scripts/headless-session/` 为 Research 阶段最小调用件；接入接单工具、配置格式与任务绑定仍属后续实施 Issue。若维护者决定改用上游更高版本选项或调整界面，需同步 Current 与 ADR 后再实现。

## 未覆盖范围

- 未验证升级后的 headless 行为（未安装新版本，未动工作中的 Harness）；本地 runner 未在 0.1.5-rc.2 以外的版本上跑过。
- 未验证审批交互、长任务、并发多写入者与取消语义，只覆盖了创建、续接、单轮投递与失败路径；`acp` 界面同样只覆盖创建、续接、单轮投递与两类失败。
- 未验证第二台电脑、跨机路由与 Harness 进程重启后的续接。
- 未把本验证做成接单程序的环境诊断；评论解析、授权、路由、去重与任务绑定持久化属后续实施 Issue。
- 原始凭据、完整会话日志与绝对机器路径未进入本报告；测试会话与临时目录仅保留在本机。
