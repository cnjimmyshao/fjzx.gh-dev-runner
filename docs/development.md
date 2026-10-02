<!-- review-refresh: no behavior change; refresh PR head for automated review indexing -->

# 开发环境与验证

## 当前就绪情况

V1 最小闭环已按 [Issue #48](https://github.com/cnjimmyshao/fjzx.gh-dev-runner/issues/48) 在当前 main 上实现：Runner 是普通 Node.js 程序，带最小 `package.json`、零运行时依赖、`npm test`（`node --test`）与 `npm start`。实现位于 `src/`，测试位于 `test/`。

本机验证状态见下面「验证分层与本次证据」。要点：Node **24.16.0** 下完整 `npm test` 通过；真实 `gh`、真实 `git` 与本机 `dsh` 的失败路径已实测；截至 2026-10-02，[Issue #66 的受控真实 E2E](research/2026-10-02-github-mbp01-coordinator-e2e.md) 又完成了一次真实 GitHub 控制评论、MBP01 Runner、原 DSH session、外部 dot Coordinator、一次 return-to、同 session RESUME 与正常 `run_end` 的闭环。该结果仍不覆盖仓库内 Coordinator / Safari 实现、真实 PR Review、多轮／多机或完整 Node 26 兼容。

接单工具采用 Node.js。首次代码 PR 已建立最小 `package.json`、锁文件与真正可运行的测试命令，没有铺空模块或假测试。工具自身的 Node.js 进程不是本地模型推理服务。

## V1 最小闭环的运行方式

```text
.env / .env.example                   Runner 人工部署配置（唯一入口；不含 GitHub / 模型凭据）
<runtime.stateDir>/state.json         触发进度、task binding、active run 与恢复所需状态
<runtime.stateDir>/runner.lock        单实例锁（wx 独占创建）
<runtime.stateDir>/audit/audit.jsonl  append-only 运行追踪
<runtime.stateDir>/runs/<runId>/      Harness 事件流与 stderr 的保留副本（按 KEEP_RUN_LOGS 保留最近若干次；
                                      仍占槽的运行目录不参与清理）
```

```bash
npm run help                                  # 显示帮助；等价于 npm start -- --help
npm start                                    # 常驻轮询（runtime.pollSeconds）
npm run once                                 # 跑一个 cycle 并等本轮启动的 Harness 结束
node src/index.js resolve-run --run <runId> --outcome exited|running [--session <id>]
node src/index.js resolve-session --repo owner/name --issue <n> --session <id>
node src/index.js resolve-session --repo owner/name --issue <n> --no-session
node src/index.js resolve-binding --repo owner/name --issue <n> --take-ownership
```

其他 CLI 参数通过 npm 的 `--` 透传，例如 `npm run once -- --env <path>`；`npm test`／`npm run test` 运行 Node 测试框架，不是 `index.js` 的子命令。

实例锁只用 `wx` 独占创建：锁文件已存在就拒绝启动，不判断 stale、不自动删除、不自动接管。异常退出遗留锁属于低频维护事件，维护者确认没有 Runner 在运行后人工删除，再重新启动。Runner 与 `resolve-*` 都先取得实例锁、再加载 `state.json`。`npm run once` 执行 `node src/index.js --once`；`--once` 会等本轮领取的 Harness 结束后再退出（收到 `SIGINT` / `SIGTERM` 时只等最多 5 秒，之后退出并把在跑的 Harness 交给下次启动按恢复语义接管）。`--wait` 仅为兼容旧命令保留，不会改变运行或等待行为，也不需要与 `--once` 搭配。`resolve-run` / `resolve-session` / `resolve-binding` 都会写 `manual_resolution` 审计（动作、坐标、是否记录或清除 session），因此长期历史里能回查是谁何时释放了 unknown 槽位、确认了 session 或迁移了 Runner。`resolve-run --outcome running` 只在记录里已有可核对 `pid` 时成立：没有进程身份的 `running` 会在下次启动被恢复逻辑归一为 `unknown`，而 `unknown` 同样占槽，所以这种情况明确拒绝并保留 `unknown`（被拒绝的恢复不写盘、也不写审计）。`resolve-run --outcome exited` 表示维护者确认该运行已经结束：释放槽位后同时按 `CAPTURE` 收敛它的捕获（模型正文与 stderr 不长期保留，与正常结算、孤儿恢复同一实现）；`--outcome running` 表示该运行仍在写文件，不做收敛。`resolve-session --no-session` 表示维护者确认该任务没有可续接的 session（清除 `binding.sessionId` 与不明确标记），`resolve-binding --take-ownership` 表示维护者明确把绑定迁移到本机 Runner（目录 / 分支按本机配置重新派生、不续接原机器 session）。

测试与运行都要求在 Node 24 下执行（`engines.node = 24.x`，启动时校验；其他 Node 主版本会明确拒绝启动，测试套件中的端到端用例也会因此失败而不是静默跳过）。

`--env <path>` 可指定 `.env` 之外的部署配置；同名进程环境变量覆盖文件取值（只认 [配置模块](../src/config.js) 列出的键）。`HARNESS_ENV_ALLOWLIST` 只允许非 GitHub 变量：`GH_TOKEN` / `GITHUB_TOKEN` 等保留变量会被直接拒绝，Runner 不向 Harness 转发 GitHub 凭据。`DSH_BIN` 可以是不含分隔符的命令名（按 `PATH` 解析），`.js` 入口由 Runner 自己的 Node 24 进程启动。启动前校验 Node 24、`DSH_BIN`、各仓库 `sourceDir`、`worktreeDir` 与 `gh auth status`，任一项不成立即拒绝启动；`.env.example` 与实现一致。

`GIT_BIN` 的作用域只有 Runner 自己准备／校验任务 worktree 时执行的 `git`：配置值被传给 `workdir` 模块，但不会改写 Harness 子进程的 `PATH`，也不会替 Harness / Dev 选择 `git` 或 `gh`。Harness 继承 Runner 启动环境里的最小系统变量，其中包括 `PATH`；Dev 在 Harness 内调用的 `git` / `gh` 仍按该 `PATH` 解析。因此，若 `GIT_BIN` 指向可用 Git、但 Runner 服务进程的 `PATH` 仍先命中错误架构或不可用的 Git，worktree 操作可以成功而 Dev 内的 Git 仍会失败。部署时须分别核对 Runner 的 `GIT_BIN` 与同一服务启动环境的 `PATH`；设置前者不能代替修正后者。

模块职责：[`config`](../src/config.js) 配置解析与校验；[`state`](../src/state.js) 条件式原子状态与容量记账；[`github`](../src/github.js) `gh` 调用与分页；[`trigger`](../src/trigger.js) Body / 评论候选语义的纯函数；[`workdir`](../src/workdir.js) 每 Issue 独立 worktree；[`prompt`](../src/prompt.js) START / RESUME 消息；[`harness`](../src/harness.js) 官方 headless 调用与 `--json` 判读；[`runner`](../src/runner.js) 轮询、领取临界区与最小反馈；[`index`](../src/index.js) 入口与人工恢复命令。

## 首次实现记录的五项取舍

1. **接单确认的发布时点。** [本机配置与状态 Schema](current/04-local-state.md) 要求 `sessionId` 在会话建立后立即交付，并且只有拿到「本轮已进入可工作 session」的早期判据后才发布接单确认；若调用件没有早期判据，则必须显式选择「以本轮结果为准、不提前发布」的回退口径。官方 headless `--json` 提供两个可用信号：`session` 事件（立即给出 `sessionId`）与第一个已提交助手内容事件（`text` / `thinking` / `tool_call` / `tool_result`）。本实现选择**前者作为标识来源、后者作为早期判据**：取得 `session` 事件后立即补全 `binding.sessionId`；观察到第一个已提交助手内容后才发布 `BOT:<runnerName>` 接单确认；只有 `sessionId` 而本轮从未产生已提交助手内容（例如凭据或模型调用失败）时，按「未进入可工作 session」发失败回复。本机 0.2.0-rc.2 实测支持这一判据：未知 `--session-id`、空任务等失败都在 `session` 事件之前以 `{"type":"error"}` + 退出码 1 结束。
2. **候选版本校验的窗口。** 所选候选的 identity 与 `updated_at` 校验是领取临界区**之外**的一次重读比较（`verifyCandidate`），临界区内只做基于持久化状态的条件判断（Issue 空闲、旧水位、扫描终点）。这样临界区保持短小、不夹带网络 I/O，代价是重读到写入之间存在毫秒级窗口；水位推进本身以旧水位为条件，因此窗口内出现的新评论不会被跳过，只会留到该 Issue 下次扫描处理。Current 的评论扫描采用本轮读取快照语义，这一实现与该语义一致。
3. **`sessionId` 未知时的绑定不明确。** 捕获文件 `runs/<runId>/stdout.jsonl` 在 spawn 前创建、由子进程直接写入，因此正常路径总能核对本轮是否出现过 `session` 事件。判据是**有没有会话证据**，不是文件是否存在：进程确实启动过、却始终没有出现 `session` 事件时（进程可能在建立会话之后、写出标识之前退出），把 `binding.sessionUnresolved` 置真。此后该 Issue 的有效触发不自动新建 session，而是在 Issue 上留下一次「本机存在未确认的遗留会话」的提示（同一条提示不重复刷），等维护者核对后用 `resolve-session --session <id>` 记录真实 session，或用 `resolve-session --no-session` 确认无遗留会话后按 START 新建。
4. **控制反馈的可恢复发布。** 接单确认 / 启动失败回复在 GitHub 临时故障时可能没发出去：运行的记录会保留 `feedbackExpectation`，后续每轮轮询按上限补发（默认 5 次），超过上限写 `feedback_abandoned` 审计并转人工；已结束的运行不会被静默遗忘。“是否已经发过”的常规幂等依据是本机 append-only 审计里的 `feedback_sent`（按 `runId` + 类别回查），不比较 GitHub 的 `created_at` 与本机时钟。V1 明确接受一个极窄崩溃窗口：GitHub 已接受评论、但本机尚未来得及落 `feedback_sent` 就崩溃时，恢复可能重复一条 `BOT:` 控制反馈；这是低频、无业务副作用的可见重复，V1 不为此引入远端幂等协议。
5. **续接时的分支漂移不阻断。** Runner 只在首次 START 时创建 `fjzx/issue-<n>` worktree；Dev 按目标项目规则另开任务分支（例如 `feat/issue-48-...`）是正常路径，因此 RESUME 遇到“当前 HEAD 与绑定分支不同”时只记本机警告、审计 `workdir_branch_drift` 并在运行记录里留下 `currentBranch`，不停止本轮。真正属于“错误 checkout”的情况——目录不再是配置源仓库的 worktree、目录被替换成非 worktree——仍然硬失败（`worktree_source_mismatch` / `task_dir_not_worktree`）。如果维护者希望分支不等也停止，只需把该判定改成与目录校验同级的失败。

## 验证分层与本次证据

### 2026-10-02：真实 GitHub / Harness / 外部 Coordinator 受控 E2E

[带日期的 Research 报告](research/2026-10-02-github-mbp01-coordinator-e2e.md)记录了 Issue #66 的公开评论链与维护者核对的本机 append-only audit。结果是在 MBP01 上完成一次受控闭环：新 D3 评论触发 `run-20261001-171345-c8a140` 以 RESUME 续接原 session；D1 正常 `run_end` 后，外部 dot Coordinator 给出技术判断并发布唯一一次末尾为 `@MBP01` 的 return-to；Runner 后续轮询精确领取该 return-to，启动新的 `run-20261001-172621-de2f03`，复用同一 session、同一规范化任务 worktree 与分支，并以 exit 0、`turn_completed`、`turnEnd=completed`、`timedOut=false` 结束。维护者随后在原 Issue 给出最终 PASS 收尾。

这次验收必须分两步读证据：

1. Harness 内发布的 GitHub 结果评论证明该轮已经执行到回报动作，但评论发生时子进程可能仍未退出；Issue #66 的最终报告就明确写着当时尚无本轮 `run_end`。
2. 评论发布后继续核对同一 `runId` 的 `run_end`，只有其 exit code、outcome、`turnEnd`、`timedOut` 与结束时间均符合预期，才算本轮技术调用正常收尾。`runner_stopped` 只表示 Runner 进程后来停止，职责不同：专项一次性测试可以核对它是否按计划退出，常驻 Runner 无需也不应为了每轮验收而停止。

本次只证明单机、单 Issue、一次受控 Coordinator 往返。外部 dot Coordinator 的成功不表示仓库内 Coordinator / Safari 接入已经实现；没有覆盖真实 PR Review / 修复、多轮或无限往返、多机路由／并发，也不把这次运行外推为完整 Node 26 兼容。

### 2026-09-30：首次实现验证快照（历史）

本次（2026-09-30，本机执行电脑，macOS / arm64）实际执行的验证：

| 层级 | 方式 | 结果 |
| --- | --- | --- |
| 单元与集成测试 | Node **24.16.0** 下 `npm test`（`node --test`，110 个用例 @ `0487492`） | 全部通过：baseline 不回放、整批评论只取最新有效、容量不足不消费水位、Issue single-flight、claim 条件失败（含临界区内机器级 / 仓库级容量复核）、START 早期 sessionId 不丢、RESUME 同 session / 同 cwd、spawn / 超时 / 锁冲突 / JSONL 坏行不冒充完成、并发反馈只发一次、拒绝反馈不重复刷屏、公开反馈脱敏、会话不匹配不误报接单、反馈补发、跨 Runner 绑定不静默接管、worktree 归属校验、多字节事件流、运行日志保留上限、纯 `wx` 单实例锁（遗留锁人工处理）、孤儿恢复的会话不匹配与无证据判定、launch 同步失败、metadata 不保留 stderr、人工恢复审计 |
| 端到端（真实边界替身） | [`test/end-to-end.test.js`](../test/end-to-end.test.js)：真实 CLI 入口 + 真实 state / audit + 真实 `git worktree` + 真实子进程；`gh` 为按 API 语义（含 `since` 过滤与分页）的替身 | 通过：baseline → 新评论触发 → 建 worktree → 启动 Harness → 早期取得 sessionId → 发布接单确认 → 审计留痕；越过水位的评论不重放 |
| 真实 `gh`（只读） | `--once` 对 `cnjimmyshao/fjzx.gh-dev-runner` 做 baseline，`allowedActors` 设为不存在的登录名 | 通过：读到 4 个打开的 Issue（PR 条目被排除）、写入水位、无领取、无 GitHub 回写；第二次 `--once` 无新增内容 |
| 真实 `dsh` 失败路径 | 隔离 `DSH_HOME` 下 `--profile headless --json`：空任务、未知 `--session-id` | 两次都在 `session` 事件之前以 `error` 事件 + 退出码 1 结束；分别判为 `harness_error` 与 `session_refused`，与实现一致 |
| 真实 `git` | [`test/workdir.test.js`](../test/workdir.test.js) 用真实 `git init` / `worktree add` | 通过（本机 `/usr/local/bin/git` 不可用，配置与测试都支持 `GIT_BIN` 覆盖） |

本次**未覆盖**，不得据此声称已验证：

- 没有用真实模型凭据完整跑通一次 Runner → Harness → Dev 轮次；端到端链路里的 Harness 是子进程替身。
- 没有对真实 GitHub 领取过任务，也没有发布过真实接单确认或失败回复。
- 本次验证会话的执行沙箱禁止执行 `ps`，因此「重启后按 pid + 启动时间签名核对旧 Harness」只用注入测试覆盖，未在真实 `ps` 可用环境下实测；该环境下探测按设计退化为 `unknown` 保守占槽。
- 没有在多机、或真实并发 Harness 场景下实测机器级与仓库级并发上限。
- `docs/current/04-local-state.md` 中「当前调用件」一段描述的是 overlay 调用件的历史状态；产品路径已按 Issue #48 改为官方 headless，该段文字未在本次代码 PR 中修改。

## V1 运行与分发口径

V1 直接以标准 Node.js 程序运行，不把 Runner 打包成单文件可执行程序。**正式运行版本统一为 Node.js 24 LTS**；24.x 内允许正常补丁／安全更新，不把某个 patch 版本写死为 Contract。Node.js 作为明确的本机运行时依赖；Runner 自身通过 `package.json`、依赖锁文件和正常的启动／测试命令交付，首次实现时在 `package.json` 的 `engines.node` 中约束为 24.x。Git、已登录的 GitHub CLI（`gh`）与 Harness CLI 仍按各自方式在本机准备，不嵌入 Runner，也不因分发方便新增凭据封装。

当前不建设 Windows EXE、macOS／Linux 单文件二进制、安装器、自动更新器或 Node SEA／pkg／nexe 等打包链路。以后若多台执行电脑的实际部署成本证明单文件分发有价值，再单独开 Issue 评估支持平台、发布方式和升级策略；该未来选择不作为当前 Runner 功能开发的前置条件，也不要求现在为打包预留额外抽象。

运行方向已按 [ADR 0002](decisions/0002-headless-cli-execution.md) 改为直接启动 headless CLI。原 [Issue #3](https://github.com/cnjimmyshao/fjzx.gh-dev-runner/issues/3)／[PR #4](https://github.com/cnjimmyshao/fjzx.gh-dev-runner/pull/4) 的 Web 实验独立收尾；不改写其实验事实，也不把它当作 CLI 已验证。

## 本机 CLI 验证的实际结果（0.1.5-rc.2）

已在本机执行电脑上按 Issue #7 完成一次性接入验证，证据见 [CLI 验证报告](research/2026-09-23-local-harness-cli-first-run-and-resume.md)。结论要点：

- **历史验证环境**实测版本为 Node v26.7.0、`@deepseek-ai/dsh` 0.1.5-rc.2；该 Node 版本只记录当时 Research 环境，不代表 Runner 的 V1 正式运行版本，V1 Contract 仍为 Node.js 24 LTS。**该版本的 headless CLI 只有 `[task...]` 与 `--help`**，没有上游更高版本（`0.1.6-alpha.1` 起）的 `--session-id`／`--json`，因此不能直接按上游文档调用；同目录再次调用只会新建会话。
- 首轮执行、退出后续接、结构化结果与失败信号已由 [`scripts/headless-session/`](../scripts/headless-session/README.md) 在本机实测通过：它用 profile patch 把本地 runner 挂到随附的 headless profile 上，命令仍是「启动器 + headless profile」，未升级、未新增服务或端口。
- **这些结果只对 Node v26.7.0 的验证环境成立，V1 正式运行版本 Node.js 24 LTS 下尚未重跑。** 上述首轮执行、续接、结构化结果与失败信号都取自 v26，不能据此认定同一 `dsh` 与 profile patch 在 Node 24 下可用。开始实现依赖 Harness CLI 的接单链路之前，须在 Node.js 24（24.x）上重跑这几项并如实记录通过／失败／未覆盖范围；在完成并记录之前，本机 CLI 接入不算已在 V1 运行版本上验证，也不得据此认为关键运行时前置验证已完成。
- 仍待执行的验证有两项：上面这项 Node.js 24 LTS 重跑，以及维护者日后授权升级 Harness 后按新版本重新实测官方 `--session-id`／`--json` 并复核 overlay 行 id。未授权前不升级工作中的 Harness，也不改用其他界面。
- 本节记录的是 0.1.5-rc.2 overlay 路线的历史结论。产品路径已由 [Issue #48](https://github.com/cnjimmyshao/fjzx.gh-dev-runner/issues/48) 改为官方 headless profile；官方路径在 Node 24 上的并发／续接行为由 [共享 DSH_HOME 并发实测](research/2026-09-29-shared-dsh-home-concurrency.md) 记录，其失败路径在 2026-09-30 又以隔离 `DSH_HOME` 复核（见上表）。overlay 路线的 Node 24 重跑不再是接单链路的前置条件。

模型 Key 仍按该版本的受支持方式提供（继承环境变量、`$DSH_HOME/.credentials.yaml`、调用目录或 `$DSH_HOME` 下的 `.env`）；本仓库脚本不读取、不打印、不保存 Key。

## 开发与运行环境分开

本仓库是接单工具的源码。被接入项目有各自的代码目录、分支和开发环境。接单工具的本机状态与凭证单独保存，不混入两者的提交。

准备 Git、Node.js、实际运行账户已授权的 GitHub CLI（`gh`）和本机 Harness CLI。模型 Key 在本机配置保存，仅通过受支持方式供给 Harness；不打印到终端、命令行实参或报告。配置 Key 不等于安装完成，也不证明 GitHub 权限、工具链与会话续接可用。

检查这些条件不等于授权安装、升级、重启已有服务或执行真实开发任务。公开材料使用机器别名及脱敏路径，原始会话、日志和私有仓库清单只保存在本机。允许的测试配置与调用范围以验证 Issue 和维护者授权为准。

首台实测使用维护者指定的执行电脑，先覆盖其实际系统；第二台再验证同一程序的配置与路由隔离，不在没有证据时声明全平台支持。

## Runner / Harness 本机配置边界

本机部署分三层，但 Runner state 的实际目录以可配置的 `runtime.stateDir` 为准：

```text
.env / .env.example        Runner 人工部署配置
<runtime.stateDir>/...     Runner runtime state / task bindings / logs
<DSH_HOME>/...             Harness config / credentials / sessions / state
```

V1 Runner 人工部署配置固定从 `.env` 进入；真实 `.env` 不入 Git，`.env.example` 不含 GitHub / 模型凭据，也不能把 repository 与 `allowedActors` 拆成失去对应关系的全局列表。Runner 启动前用 `gh auth status` 验证执行账户的本机认证；Harness 复用同一账户可访问的 `gh` 配置，Runner 不向 Harness 注入或转发 `GH_TOKEN` / `GITHUB_TOKEN`。模型 Key 由 Harness 当前版本支持的凭据机制管理。Runner 不解析、不记录、不持久化模型 Key；仅当实际 Harness 版本要求环境变量凭据时，才把明确 allowlist 中的变量原样透传给子进程。

共享一个 `DSH_HOME` 已由 [Issue #36](https://github.com/cnjimmyshao/fjzx.gh-dev-runner/issues/36) 的实测报告确认：不同 session / 工作目录可并发运行，同 session 的第二写入者由 Harness 自身锁明确拒绝。**是否把 `runtime.maxConcurrentHarnesses` 实际开到大于 1 仍是维护者的决定**；实现按 Contract 默认 `1`，并在运行中重新核对持久化运行态后才占用槽位。

## 先验证 CLI，再开发接单

这是一次性接入验证，不是本工具的环境诊断功能，也不要求每次接单重新检查整台电脑。本机 0.1.5-rc.2 的执行结果已记录在上面与 Research 报告中；下列步骤保留作为重跑口径，以及日后授权升级或换机时的核对清单。在独立测试目录、测试会话与不干扰现有工作的持久化配置中进行：

1. 核对实际 Node／Harness 版本、运行账户、profile、工作目录和持久化位置。按该版本的受支持方式加载本机模型 Key，记录方式而不是凭据值。
2. 首个 CLI 进程发送不调用工具、不读写业务文件的短消息；记录会话标识、输出和实际退出结果。Harness 自身的测试会话持久化是允许的。
3. 确认首个进程退出，再以相同目录、会话标识和匹配配置启动第二个进程。第二条消息依赖第一轮内容，结合标识和持久化证据确认原会话续接，而不是把上一轮答案塞进新会话。
4. 记录 stdout／stderr、可获得的结构化结果、最终结果与退出状态如何区分；用一个安全的无模型失败案例核对错误不会被当作成功，例如引用不存在的测试会话（本机实测：报错退出且不会静默新建会话）。只覆盖当前接入所需场景，不穷举 CLI。
5. 在带日期的 Research 留下可复现步骤、版本、脱敏证据、结果和限制。必要时保留最小探针供后续复用；失败就报告缺口，不新建恢复平台，不自行升级正在工作的 Harness。

上游参考：[Harness headless 文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/headless/README.md)。其 `--json`／`--session-id` 是核对入口，不是本机已通过证明；验证报告需记录所查版本或固定提交及实际安装版本。本机 0.1.5-rc.2 已实测不含这两个选项，报告按该版本的实际退出与完成／错误信息判断；结构化输出不必等同于逐 token 流，也不能仅凭 `final` 字段认定成功。

新 CLI 验证不依赖旧 Web 认证方案，不需要打开、关闭或接管正在工作的 Web 服务。Web 实验与本机 CLI 实测分别保留，不混用结论。

## 最小实现的语义基线（已实现，保留作为核对口径）

以下语义已由 [Issue #48](https://github.com/cnjimmyshao/fjzx.gh-dev-runner/issues/48) 的实现（`src/`）落实；这里保留作为后续修改时的核对口径：少量本机配置、通过 `gh` 读取新建 Issue Body 与扫描水位之后的新评论、维护评论扫描水位、按 `runnerName` 选择最新有效触发候选、去重及任务绑定、CLI 启动／续接、必要日志与反馈。一个 Issue 的当前 task binding 只归一个 Runner。实现覆盖创建时授权主体的一次性初始 Body，以及已有评论后的扫描／候选流程：扫描水位之后的新评论，把水位推进到本轮扫描终点，并只选择其中最新一条通过授权、`BOT:` 排除与 `@<runnerName>` 命令条件的有效控制评论；普通／未授权／`BOT:` 评论不覆盖合法控制评论，多条有效控制评论只执行最新一条；不建设 pending 队列。Runner 自动反馈统一写成 `BOT:<runnerName>` 前缀。文件按实际职责组织，没有预建 Scheduler、Repository、Adapter 等整套层次。

GitHub 资料入口：[gh api](https://cli.github.com/manual/gh_api)、[Issues API](https://docs.github.com/en/rest/issues/issues)、[Issue comments API](https://docs.github.com/en/rest/issues/comments)。后续按实际接口核对分页、更新时间和限流。

实现保持 Issue 级 single-flight：每次准备检查某个 Issue 前，先看本机任务运行状态。若该 Issue 已有 Harness 处于 starting / running / unknown，直接跳过这个 Issue，不读取它的新评论、不更新 `commentScanWatermark`、不向当前 Harness 注入消息，也不启动第二个写入者；Runner 仍继续扫描其他 Issue / 其他仓库。

只有 Issue 空闲时才扫描 `commentScanWatermark` 之后的新评论；没有新评论就不做任何事。有新评论时，把水位推进到本轮实际扫描终点，并只从本轮读取快照中选择最新一条有效的 `@<runnerName>` 控制评论：排除 `BOT:` 自动反馈、核对作者授权并检查正文结尾。普通／未授权／`BOT:` 评论同样被扫描并越过，因此不会因授权变化而复活，但它们不覆盖同一批里的合法控制评论；多条合法控制评论只执行最新一条。是命令时用一次条件式原子状态更新同时推进水位与 starting / START / RESUME；不是命令则只推进水位。领取仍校验旧水位、扫描终点和所选候选版本，只有写入成功的执行者可以 spawn Harness。评论扫描采用**本轮读取快照语义**：不为本轮已读取的每一条中间评论建立整批版本锁；如果某条中间评论在读取后、落盘前被原地编辑成新命令，不保证纳入本轮。需要可靠表达新的执行意图时应发布新的 `@<runnerName>` 控制评论，而不是依赖编辑旧评论。已经越过水位的历史评论也不会因编辑重新触发。Issue 初始 Body 仍按既有一次性、条件式原子领取规则处理。Harness 启动后水位冻结，直到该 Harness 明确结束；运行期间的新回复不保存为待执行队列，结束后再按同一规则扫描水位之后的新评论。

验证至少覆盖（本次实际覆盖情况见上表）：同一 Issue 运行中不会启动第二个 Harness 且水位不动；多个执行者同时领取同一触发时只有一个写入成功、只有一个 Harness 被启动；claim 已落盘但 spawn 结果未确认时重启，不会启动第二个写入者、也不会把同一 trigger 当新请求再执行；Body 首次读取后再次编辑（删掉命令或新加命令）既不撤销本次领取、也不重新触发；同一 Issue 并发进行 Body 判定与 Comment 领取时，Body 判定仍会落盘、不会因 Comment 先置 starting 而丢失；所选候选在读取后、claim 前被编辑时领取失败并重新读取；中间非候选评论在本轮读取后被原地编辑采用快照语义，不保证纳入本轮，可靠的新控制意图通过发布新评论表达；两个执行者读到同一命令、赢家跑完并释放运行状态后，落后的执行者因水位已推进而领取失败，同一条命令不会被执行两次；未授权用户的评论与 `BOT:` 反馈同样推进扫描水位，之后该用户被加入 `allowedActors` 也不会让这条旧评论变成命令；已经越过水位的历史评论被原地编辑成 `@<runnerName>` 结尾也不会重新触发；与此同时其他 Issue / 其他仓库仍可正常领取；当前 Harness 结束后扫描水位之后的新评论，推进水位到扫描终点，并只取其中最新一条有效的 `@<runnerName>` 控制评论决定是否 RESUME；普通评论、未授权评论和 `BOT:` 反馈不覆盖合法命令，多条合法命令只执行最新一条；普通轮询和重启不会重复执行同一触发，也不会静默丢弃已领取的命令。

## 验证分层

Runner 的产品路径是官方 headless profile（`--profile headless --json`）。[`scripts/headless-session/`](../scripts/headless-session/README.md) 是面向 0.1.5-rc.2 缺口的一次性验证脚本与 overlay，**不是** Runner 的运行路径，按 [Issue #48](https://github.com/cnjimmyshao/fjzx.gh-dev-runner/issues/48) 也不再是接单链路的前置条件；其不调用模型的检查（缺 `DSH_TASK`、引用不存在的会话标识、工作目录不匹配）仍可按其 README 重跑。

文档改动检查相对链接、术语、权限、Scope 与隐私，不触发模型或真实任务。纯逻辑测试优先隔离 GitHub／Harness；实际 CLI 验证只使用明确授权的测试会话，GitHub 端到端测试另使用授权的测试仓库。第一条端到端链路通过后，再验证第二台电脑不会重复领取同一任务。

结果记录命令、环境、验证版本、通过／失败／跳过及未覆盖范围。没有运行就写未运行，不预填 pass 数量。进程是否成功启动、模型是否成功回答、原会话是否正确续接、输出是否可读取分别给证据，不把某一层成功等同于开发任务验收完成。

PR Review 通过现有已授权的审查方式完成；尚未配置 Codex 或无法读取其结果时明确标注。不要为此擅自添加 Workflow、Secrets 或调整仓库权限。独立 Review 不等于本机实测。
