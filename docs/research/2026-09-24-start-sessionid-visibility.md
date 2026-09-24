# START 阶段 sessionId 的创建与可见时点实测

Date: 2026-09-24
Keywords: Harness, dsh, headless CLI, sessionId, START, 时序实测, profile patch, acp
Status: VERIFIED（范围限本文记录的时间、版本、电脑、调用路径与实际命令）
关联：[Issue #33](https://github.com/cnjimmyshao/fjzx.gh-dev-runner/issues/33)、Refs #17 #18 #19 #21
依据：[CLI 验证报告](2026-09-23-local-harness-cli-first-run-and-resume.md)（首轮执行与同会话续接）、[ADR 0002](../decisions/0002-headless-cli-execution.md)、[Current：会话与工作目录](../current/01-scope-and-flow.md)
已查仓库 commit：`8d51e0b`（PR #8 合并后的 `main`）；探针在本文同一 PR 中提交。

## 调查问题

按 Issue #33 的问题清单实测：从 Runner／Harness 进程启动到会话创建、再到调用方第一次能取得 `sessionId` 的真实时间线；不预设「必须等整轮结束才有 sessionId」，也不预设「进程一启动就返回 sessionId」。目标是判断 START 步骤是否存在「进程已启动但 sessionId 尚不可见」的窗口，以及这个窗口是 Harness 的限制还是当前 wrapper 的限制。

## Environment

| 项目 | 实际值 |
| --- | --- |
| 电脑／系统 | 维护者指定的本机执行电脑（Windows），普通用户账户 |
| Node.js | v26.7.0 |
| Harness | `@deepseek-ai/dsh` 0.1.5-rc.2（`npx` 缓存安装），`dsh` 启动器；未安装、未升级、未重启任何 Harness 组件 |
| 涉及的 bundle | `@deepseek-ai/dsh-headless` 0.1.5-rc.2、`@deepseek-ai/dsh-acp`／`dsh-acp-app` 0.1.5-rc.2 |
| 测试工作目录 | 独立临时目录（`%TEMP%\<独立测试根>\workdir`），无业务文件、无 `AGENTS.md` |
| 持久化配置 | 两个独立 `DSH_HOME`（headless 与 acp 各一份），由启动器自行初始化 profile 与模块链接 |
| 模型凭据 | 本机已保存的凭据文档复制进独立 home；未写入命令行、未打印、未进入报告与公开输出 |
| 权限 | 默认 `workspace-write` + `ask`；本轮短消息未触发工具调用，未出现审批提示 |
| 未触碰 | 工作中的 `dsh web` 与 `~/.dsh`：本次全部实测都在独立工作目录与独立 `DSH_HOME` 内进行，未重启、未升级、未写入；未改仓库配置、Actions、权限 |
| 命令路径 | 一是「启动器 + headless profile + `--patch` overlay」，二是官方「启动器 + headless profile」，三是「启动器 + acp profile」 |

沙箱环境的两条约束影响了探针实现，并已在结果里显式标注（详见「未覆盖范围」）：父进程不能用管道捕获子进程输出（`spawn EPERM`），也不能用命名管道充当 stdin（`open EPERM`）。因此子进程 stdout／stderr 接到父进程预先打开的普通文件句柄，父进程按 5ms 轮询文件增长并读 mtime；ACP 的 stdin 用普通文件代替管道。

时间基准与精度：

- 父进程在 `spawn()` 前一瞬记录 `t0`（`spawn-called` 事件实测在 7–10ms）；
- 会话创建时刻取会话头 `session.v3.jsonl.zstd` 的 `createdAt`（毫秒 epoch），并以目录／文件 `birthtime` 交叉核对：目录比 `createdAt` 晚 13–20ms，会话文件再晚 1–14ms（最晚合计 34ms）；无凭据那个失败样本的文件 `birthtime` 晚 69ms，因为该轮先失败、文件后写；
- 输出可见时刻取 stdout／stderr 文件的 mtime，扫描间隔为 5ms；
- **扫描间隔不是精度上界**：Node 事件循环与文件系统调度都不保证回调按时运行，本批样本里「写入 mtime → 被观察到」的差值为 1–22ms。因此表里的可见时刻是「不早于实际写入」的观测值，逐次误差由日志里的 `mtime` 字段给出，不要把它当成固定 5–10ms 的保证；
- 会话创建时刻在热 profile 下的分布：路径 A 三次分别 1534／1546／1661ms，路径 B 两次 1531／1588ms（同批样本极差 <200ms）；路径 B 的冷 profile 首次建链接样本（20503ms）不计入该比较，它是启动器建 profile 链接的耗时。

## Evidence

复现件：[`probes/start-sessionid-timing-probe.mjs`](probes/start-sessionid-timing-probe.mjs)。每个模式跑一次，结果落到 `PROBE_OUT` 下的 report JSON 与 stdout／stderr 日志。report 里的事件按模式出现，检查时不要期待每个模式都有全部事件：

| 事件 | 何时出现 |
| --- | --- |
| `session-slug-created` | 观测到某个工作目录 slug 目录第一次出现 |
| `session-created` | 本轮启动之后新建的会话目录第一次被看到；带该次会话的目录／文件时刻与会话头 `createdAt`（头还没写完时为 `null`，之后补读）。运行前就存在的旧会话不会产生该事件 |
| `first-stdout-visible` / `first-stderr-visible` | 子进程真的往对应流写了字节 |
| `sessionId-visible-in-stdout` | 仅 `overlay` 模式，且 stdout 出现可解析、带 `sessionId` 的 result JSON；`official` 的 stdout 是模型正文、不做该解析，`acp-new-only` 不产生 |
| `result-file-visible` / `result-file-parsable` | 仅 `overlay` 模式（只有它设置 `DSH_RESULT_FILE`） |
| `acp-initialized` / `acp-error` / `sessionId-not-observed` | 仅 `acp-new-only` 模式 |

探针自身的失败路径也有约定：子进程起不来（例如工作目录不存在）时只记 `child-spawn-error` 的 `code` 与 `stage`，不写任何消息原文（Node 的错误消息里可能带本机绝对路径）；判定 `sessionId-not-observed` 之前会补读一次 stdout。

```powershell
$env:DSH_HOME = '<独立测试 home>'
$env:DSH_BIN  = '<dsh 安装入口，即 @deepseek-ai/dsh 的 lib/bin.js>'
$env:PROBE_REPO = '<本仓库>'
$env:PROBE_OUT  = '<独立输出目录>'
node docs\research\probes\start-sessionid-timing-probe.mjs overlay        <独立工作目录> <任务文本文件>
node docs\research\probes\start-sessionid-timing-probe.mjs official       <独立工作目录> <任务文本文件>
node docs\research\probes\start-sessionid-timing-probe.mjs acp-new-only   <独立工作目录>
```

`overlay` 模式加 `PROBE_DEBUG_RUNNER=1` 可复现调试行那一列。模型轮次需要有效模型凭据（按 Harness 受支持方式提供，探针不读取也不打印）；崩溃窗口用同样命令另起进程、在 turn 结束前强杀即可（本报告用 PowerShell 的 `Start-Process` + `Kill()`）。

### 1. 调用路径 A：本地 runner（`--patch scripts/headless-session/overlay.yml`）

`scripts/headless-session/runner.mjs` 在 `agents.create()` 时先用 `session-${randomUUID()}` 定下标识（第 138、159 行），turn 结束后才把 `sessionId` 写进最后那行 result JSON（第 186–193 行）；`DSH_RESULT_FILE` 写的是同一份内容。下列时刻都相对本进程的 spawn，单位 ms。

| 运行 | 会话创建（header `createdAt`） | 目录／会话文件 `birthtime` | stderr 首次可见 | stdout 首次可见 | 结果行 sessionId 可见 | 结果文件可见 | 子进程退出 | 退出码 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 真实模型轮次（第 1 次） | 1546 | 1566／1573 | 无 stderr 输出 | 2181 | 2182 | 2182 | 2223 | 0 |
| 真实模型轮次（第 2 次，重复） | 1661 | 1680／1688 | 2186（模型 reasoning） | 2404 | 2405 | 2405 | 2448 | 0 |
| 真实模型轮次（开 `DSH_DEBUG_RUNNER=1`） | 1534 | 1554／1562 | 1558（`created …` 调试行） | 2592 | 2593 | 2593 | 2637 | 0 |
| 无凭据（`MISSING_CREDENTIAL`） | 1585 | 1610／1654 | 1599（调试行）、1662（错误行） | 1662（result JSON） | 1758（父进程读到，实测写入 1662） | 1758 | 1710 | 1 |
| 续接不存在的会话 | 不适用（未创建） | — | 1556（`session … not found`） | 无（stdout 为空） | 无 | 无 | 1604 | 1 |

（会话创建时刻以会话头 `createdAt` 为准。`createdAt`→目录 `birthtime` 的偏差为 18／19／20ms，→会话文件 `birthtime` 再晚 7／8／8ms（合计 26／27／28ms）；无凭据那行的文件 `birthtime` 偏差更大（69ms），因为该轮先失败、文件后写。无凭据那一行取自更早一批样本：该轮的会话目录与文件时刻为 1610／1654ms，stdout 在 1662ms 写出带 `sessionId` 的 result JSON——失败路径同样先写 stdout 再写结果文件，所以这一行与同批「第 1／2 次」的 stdout 时点不可直接比较。）

结论：

- **默认输出下，从会话创建到 turn 结束之间的整段区间调用方拿不到任何 sessionId**：创建→可见的间隔第 1 次 636ms、第 2 次 744ms；这两次 stdout 在 2181／2404ms 才首次出现字节，而第一个字节就是最终 result 行，stderr 要么整轮为空（第 1 次）、要么只有模型 reasoning（第 2 次）。
- 唯一交付点是 turn 结束后的 result JSON／`DSH_RESULT_FILE`，两者在同一毫秒级窗口内可读，且都落在 turn 结束之后。
- 打开 `DSH_DEBUG_RUNNER=1` 后，会话创建到调试行可见只隔 **24ms**（1534→1558），而同一次运行的 stdout 直到 2592ms 才出现（相隔约 1.06s）；但调试行不是正式交付契约（脚本 README 只把它列为可选运行细节），且是自由文本、不能单独作为绑定依据。
- 热 profile 下会话创建时刻集中在 **1531–1661ms**；冷 profile 首次建 profile 链接那次是 20503ms（见路径 B），差值来自启动器建立 profile 链接而不是会话创建本身。

### 2. 调用路径 B：官方 headless（本机 0.1.5-rc.2 只有 `[task...]`）

`@deepseek-ai/dsh-headless` 的 runner 同样在 `agents.create()` 时用 `session-${randomUUID()}` 创建会话，但只用 `io.stdout.write(outcome.text + "\n")` 输出最终回答，从不回传标识。

| 运行 | 会话创建（header `createdAt`） | stderr 首次可见 | stdout 首次可见 | 子进程退出 | 退出码 | 输出里能否取得 sessionId |
| --- | --- | --- | --- | --- | --- | --- |
| 真实模型轮次（热 profile） | 1588 | 2499（reasoning） | 2654（最终回答） | 2689 | 0 | 不能 |
| 无凭据（独立空 home，热 profile） | 1531 | 1617（错误行） | 无（stdout 为空） | 1647 | 1 | 不能 |
| 真实模型轮次（冷 profile 首次建链接，首轮实测） | 20503 | —（未单独记录） | 20605（最终回答） | 20663 | 0 | 不能 |

三次运行的「会话创建 → 进程退出」间隔差别很大：热 profile 的真实模型轮次是 1101ms，无凭据那次是 116ms，冷 profile 首次建链接那次是 160ms——创建之后剩下的时间取决于该轮的模型调用，不是固定值。即使在 model turn 正常完成的那次，输出也只有最终回答一行。本机版本没有 `--json`／`--session-id`（与 [CLI 验证报告](2026-09-23-local-harness-cli-first-run-and-resume.md) 一致），因此**官方路径在本机版本下完全没有取得 sessionId 的调用方接口**。

### 3. 调用路径 C：acp profile（只做 `session/new`，不投递 prompt）

`@deepseek-ai/dsh-acp` 的 `newSession` 实现是「生成 `randomUUID()` → 创建会话 → 返回 `sessionId`」，会话创建与返回都发生在任何模型请求之前。

| 运行 | `initialize` 响应 | `session/new` 响应 | 会话目录 | 结论 |
| --- | --- | --- | --- | --- |
| Node 探针（普通文件当 stdin，固定提交版） | 1723ms | 未观察到 | 未创建 | 不可用：两条请求在等待 `initialize` 响应前就已同时可读，服务端只回了 id 1 |
| PowerShell 管道 stdin（两行请求一次送入） | 实测返回 | 未返回；子进程 2003ms 后自行退出，退出码 0 | 未创建 | 本机沙箱下**未能复现**该路径 |

`initialize` 每次都成功返回（说明请求投递链路是通的），但 `session/new` 没有响应、也没有留下会话目录。判定「未观察到」之前探针会再读一次 stdout（响应可能落在两次扫描之间、子进程随即退出），本批运行加上这次补读仍然没有观察到。能确定的原因只有一条：**请求顺序不受控**——沙箱不允许管道，两条请求必须预写、同时可读，`session/new` 可能在 `initialize` 完成前被处理；而仓库里逐条交互的 `acp-session-probe.mjs` 是等 `initialize` 响应后再发的。（早先版本曾把原因写成「普通文件 stdin 会重放请求」，这一归因不成立：实现只打开一次读句柄、没有 seek 或重开，文件位置会随读取推进。）这与 [CLI 验证报告](2026-09-23-local-harness-cli-first-run-and-resume.md) 用 `acp-session-probe.mjs` 实测成功的结论不同，**属于本次工具链限制，不推翻原记录**。路径 C 的「`session/new` 能在 turn 之前返回 sessionId」只有源码依据（`newSession` 的返回位置）与 #7 的历史实测，本次没有新增独立证据。

### 4. 崩溃窗口（路径 A，turn 中途强杀）

任务换成需要长输出的 turn，进程启动后 12s 用 `Kill()` 强杀，再逐项核对留下什么：

| 观测项 | 结果 |
| --- | --- |
| 会话创建 | header `createdAt` 在 t0+1573ms，目录 `birthtime` t0+1598ms |
| 会话文件 | t0+1609ms 出现，t0+2457ms 写入完成：12.7KB 的 `session.v3.jsonl.zstd`，强杀后可解压，内容只有一行 `session` 头（本轮 turn 的事件一个都没落盘） |
| 强杀时刻 | t0+12041ms（子进程退出 t0+12060ms） |
| 本轮的 result 文件 | **不存在**（探针在启动前已删除同 tag 的旧文件，因此不会被上次运行的结果误认） |
| 会话目录 | **已存在**，`id`／`createdAt` 可从会话头读出（会话身份在强杀前已经落盘） |
| 调用方可见的 sessionId | 仅 stderr 的 `dsh-session: created session-8bd75ccd…`（本次为观察窗口打开了 `DSH_DEBUG_RUNNER=1`）；默认设置下为空 |
| stdout | 空（0 字节） |

窗口存在且可复核：**从会话创建（约 t0+1.6s）到结果交付之间，会话头已经落盘、会话身份可以恢复，但调用方拿不到标识**；这段窗口内进程被杀，就会留下一个没有绑定关系的会话，而本轮 turn 的事件也没有落盘。窗口长度等于整轮 turn 的时长，本机短任务 0.6–0.7s（见路径 A 的创建→可见间隔），长任务按实际耗时放大。

### 5. 「只创建会话、不跑 turn」

分三层看，结论不同：

- **Harness 侧（代码依据，未新增实测）**：`agents.create()` 在收到模型错误前就已经把会话头写进持久化——两次 `MISSING_CREDENTIAL` 运行都留下了可解压的 `session.v3.jsonl.zstd`（约 12.7KB，内容只有一行 `session` 头），说明「创建会话」与「跑 model turn」是两个可分离的阶段，只是**所测的两条 headless 路径**都没有把前者单独暴露出来（ACP 的 `session/new` 是另一种界面，见证据 3）。
- **官方 headless CLI（实测）**：没有只创建会话的接口；本机版本连 `--session-id`／`--json` 都没有（本报告 2）。
- **本地 runner（实测 + 源码）**：也没有这种模式，但它已经持有标识——`sessionId` 在 `agents.create()` 之前就由 wrapper 生成（`runner.mjs` 第 138 行），唯一的问题是只在最后输出。**这一层的缺口属于 wrapper，不属于 Harness**。

## Conclusion（逐条回答 Issue #33）

1. **版本与路径**：本机 `@deepseek-ai/dsh` 0.1.5-rc.2；START 实际有三条可测路径——本地 runner（`--patch` overlay）、官方 headless、acp profile。产品当前使用第一条（[Current](../current/01-scope-and-flow.md)），官方 `--json`／`--session-id` 路径属更高版本，本机不具备。
2. **会话何时创建**：`agents.create()` 一执行就创建，实测相对进程启动约 **1.5–1.7s**（路径 A 三次 1534／1546／1661ms，路径 B 热 profile 1531／1588ms；路径 B 冷 profile 首次建链接那次 20503ms，差值来自启动器建立 profile 链接，不是会话创建本身）。
3. **调用方何时第一次可靠取得 sessionId**：路径 A 是「**整轮结束后的最终结果**」（result JSON／`DSH_RESULT_FILE`）；路径 B 是「**任何时刻都取不到**」；路径 C 按源码与 #7 实测是「`session/new` 响应」，本次未复现。
4. **长任务能否先取得**：路径 A **不能**。实测会话创建到 stdout 首个字节之间 636／744ms（调试行那次 1059ms），而 stdout 首个字节就是结果行；也就是说 turn 进行中调用方没有任何可用输出。若打开 `DSH_DEBUG_RUNNER=1`，stderr 会在创建后约 24ms 出现 `created <id>`，但那是可选调试输出，不是契约。
5. **崩溃窗口是否真实存在**：**存在**。位于「会话创建（约 t0+1.6s）」与「结果交付（turn 结束后）」之间；窗口内强杀时，会话头已经落盘、标识可从持久化恢复，但调用方输出里没有它，且本轮 turn 的事件尚未落盘。
6. **只创建会话、不跑 turn 的接口**：**所选的两条 headless 路径都没有**——本地 runner 没有这种模式，官方 headless CLI 在本机版本连 `--session-id` 都没有；这与路径 C 的事实（bundled ACP 的 `session/new` 会在模型 turn 前返回 sessionId，见证据 3 与 #7）并不矛盾：ACP 是另一种界面，本机沙箱下未能复现，不能据此说「Harness 完全没有该能力」。**对当前 runner 而言也不需要新接口**：标识由 wrapper 自己生成（`runner.mjs` 第 138 行），改成创建后立即交付即可；官方 headless 需要上游提供（#19／#21 的 JSONL `session` 事件方向正是针对这一点，本机版本未验证）。

## Contract Impact

未改 Current、ADR、运行代码或任何已确认 Contract；本报告只补时间线证据。可以指出的两点，供后续任务决定，不作为本任务需求：

- **交付时点**：Issue #17／#18 定义的绑定状态需要 `sessionId`。当前 runner 只在最终结果里交付它，因此「进程已启动但结果没读回」的调用需要一个保守处理（例如按工作目录与创建时间识别遗留会话，或在 wrapper 内改成创建后立即交付标识）。这是实现选择，不属于本 Issue 的验收。
- **上游路径**：若 #19／#21 的官方 `--json` 路径在升级后可用，`session` 事件会把取得时点提前到 turn 之前；在那之前不把上游文档当作本机已支持。

## 未覆盖范围

- 未安装、未升级、未重启任何 Harness；本报告只描述 0.1.5-rc.2 的实测结果。
- 未复现 acp `session/new`（沙箱限制 + 请求时序未受控，见证据 3）；该路径的结论依赖源码与 #7 历史实测，本次无新增独立证据。
- 未覆盖并发写入者、审批交互、多台电脑、Harness 进程重启后的续接。
- 长 turn 实测用的是 12s 强杀；模型推理耗时受网络与模型侧影响，本报告只按实际观测的时间线陈述，不外推到其他时长。
- 可见时刻的观测误差逐次不同（见「时间基准与精度」），不构成固定精度保证。
- 原始凭据、完整会话日志、模型正文与绝对机器路径未进入本报告；测试会话与临时目录只留在本机，报告里的会话标识只保留前 12 个字符。
- 探针本身的运行受本机沙箱限制（不能用管道），复现时若环境允许管道，可用更直接的方式重跑。
