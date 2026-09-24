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

- 父进程在 `spawn()` 前一瞬记录 `t0`（`spawn-called` 事件实测在 6–8ms）；
- 会话创建时刻取会话头 `session.v3.jsonl.zstd` 的 `createdAt`（毫秒 epoch），另记文件 `birthtime`；
- 输出可见时刻取 stdout／stderr 文件的 mtime，轮询粒度 5ms，即表里的可见时刻最多偏晚 5–10ms，不会偏早；
- 会话目录是否已存在的观测粒度同为 5ms；每条路径至少跑 2 次（acp 那条因下述限制只跑 2 次均未成功），同一路径各次的会话创建时刻相差不超过 180ms。

## Evidence

复现件：[`probes/start-sessionid-timing-probe.mjs`](probes/start-sessionid-timing-probe.mjs)。每个模式跑一次，结果落到 `PROBE_OUT` 下的 report JSON 与 stdout／stderr 日志：

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

`scripts/headless-session/runner.mjs` 在 `agents.create()` 时先用 `session-${randomUUID()}` 定下标识（第 138、159 行），turn 结束后才把 `sessionId` 写进最后那行 result JSON（第 186–193 行）；`DSH_RESULT_FILE` 写的是同一份内容。

| 运行 | 会话创建 | stdout／stderr 首次可见 | 结果行的 sessionId 可见 | 子进程退出 | 退出码 |
| --- | --- | --- | --- | --- | --- |
| 新建 + 真实模型轮次（`completed`，第 1 次） | 1631ms | stderr 1647ms（`DSH_DEBUG_RUNNER=1` 的 `created …` 行）；stdout 2534ms | 2630ms（父进程读到，实测写入 2530ms） | 2574ms | 0 |
| 新建 + 真实模型轮次（`completed`，第 2 次，未开调试） | 1807ms | 无 stderr 输出；stdout 2582ms | 2662ms（写入 2565ms） | 2615ms | 0 |
| 新建 + 无凭据（`MISSING_CREDENTIAL`） | 1585ms | stderr 1599ms（调试行）；stdout 1662ms | 1758ms | 1710ms | 1 |
| 续接不存在的会话 | 不适用（未创建） | stderr 1704ms | 无（stdout 为空） | 1748ms | 1 |

结论：**默认输出下，从会话创建到 turn 结束之间的整段区间（第 1 次 1631–2530ms、第 2 次 1807–2565ms）调用方拿不到任何 sessionId**；唯一交付点是 turn 结束后的 result JSON。第 2 次运行更能说明问题：那次没有开调试输出，会话创建后直到 turn 结束前 stdout／stderr 一个字节都没有。打开 `DSH_DEBUG_RUNNER=1` 后，会话创建到调试行可见相隔约 12–16ms，但调试行不是正式交付契约（脚本 README 只把它列为可选运行细节），且它是自由文本、不能单独作为绑定依据。

### 2. 调用路径 B：官方 headless（本机 0.1.5-rc.2 只有 `[task...]`）

`@deepseek-ai/dsh-headless` 的 runner 同样在 `agents.create()` 时用 `session-${randomUUID()}` 创建会话，但只用 `io.stdout.write(outcome.text + "\n")` 输出最终回答，从不回传标识。

| 运行 | 会话创建 | stdout 首次可见 | 子进程退出 | 退出码 | 输出里能否取得 sessionId |
| --- | --- | --- | --- | --- | --- |
| 真实模型轮次（冷 profile 首次链接） | 20503ms | 20605ms（最终回答） | 20663ms | 0 | 不能 |
| 无凭据（热 profile） | 1628ms | 1708ms（stderr 错误行；stdout 为空） | 1744ms | 1 | 不能 |

两次运行都在会话创建后约 100ms 内结束输出并退出；即使在 model turn 正常完成的那次，输出也只有最终回答一行。本机版本没有 `--json`／`--session-id`（与 [CLI 验证报告](2026-09-23-local-harness-cli-first-run-and-resume.md) 一致），因此**官方路径在本机版本下完全没有取得 sessionId 的调用方接口**。

### 3. 调用路径 C：acp profile（只做 `session/new`，不投递 prompt）

`@deepseek-ai/dsh-acp` 的 `newSession` 实现是「生成 `randomUUID()` → 创建会话 → 返回 `sessionId`」，会话创建与返回都发生在任何模型请求之前。

| 运行 | `initialize` 响应 | `session/new` 响应 | 会话目录 | 结论 |
| --- | --- | --- | --- | --- |
| Node 探针（普通文件当 stdin） | 18ms | 未观察到 | 未创建 | 不可用：文件 stdin 会重放，服务端只处理了同 id 的首条请求 |
| PowerShell 管道 stdin（两行请求一次送入） | 实测返回 | 未返回；子进程 2003ms 后自行退出，退出码 0 | 未创建 | 本机沙箱下**未能复现**该路径 |

`initialize` 两次都成功返回（说明请求投递链路是通的），但 `session/new` 没有响应、也没有留下会话目录。这与 [CLI 验证报告](2026-09-23-local-harness-cli-first-run-and-resume.md) 用 `acp-session-probe.mjs` 实测成功的结论不同：那次探针由自己的 Node 进程用管道逐条交互，本次因沙箱禁止管道而改用静态 stdin，**属于本次工具链限制，不推翻原记录**。因此路径 C 的「`session/new` 能在 turn 之前返回 sessionId」只有源码依据（`newSession` 的返回位置）与 #7 的历史实测，本次没有新增独立证据。

### 4. 崩溃窗口（路径 A，turn 中途强杀）

任务换成需要长输出的 turn，进程启动后 12s 用 `Kill()` 强杀，再逐项核对留下什么：

| 观测项 | 结果 |
| --- | --- |
| 会话创建 | `createdAt` 在 t0+1637ms，文件 `birthtime` t0+1663ms |
| 强杀时刻 | t0+12045ms（子进程退出 t0+12066ms） |
| 本轮的 result 文件 | **不存在**（目录里那份是上一次运行遗留，其 sessionId 属于上一轮的会话） |
| 会话目录 | **已存在**，内含 `session.v3.jsonl.zstd`，但强杀时文件只有部分内容，`zstd` 解压失败，读不出 `id`／`createdAt` |
| 调用方可见的 sessionId | 仅 stderr 的 `dsh-session: created session-1a38b738…`（`DSH_DEBUG_RUNNER=1`）；默认设置下为空 |
| stdout | 空 |

窗口存在且可复核：**从会话创建（约 t0+1.6s）到结果交付之间，会话已经存在于 Harness 持久化里，但调用方拿不到标识**；这段窗口内进程被杀，就会留下一个没有绑定关系的会话。

### 5. 「只创建会话、不跑 turn」

分三层看，结论不同：

- **Harness 侧（代码依据，未新增实测）**：`agents.create()` 在收到模型错误前就已经把会话写进持久化——两次 `MISSING_CREDENTIAL` 运行都留下了完整会话头（约 12.7KB 的 `session.v3.jsonl.zstd`，内容只有一行 `session` 头），说明「创建会话」与「跑 model turn」是两个可分离的阶段。
- **官方 headless CLI（实测）**：没有只创建会话的接口；本机版本连 `--session-id`／`--json` 都没有（本报告 2）。
- **本地 runner（实测 + 源码）**：也没有这种模式，但它已经持有标识——`sessionId` 在 `agents.create()` 之前就由 wrapper 生成（`runner.mjs` 第 138 行），唯一的问题是只在最后输出。**这一层的缺口属于 wrapper，不属于 Harness**。

## Conclusion（逐条回答 Issue #33）

1. **版本与路径**：本机 `@deepseek-ai/dsh` 0.1.5-rc.2；START 实际有三条可测路径——本地 runner（`--patch` overlay）、官方 headless、acp profile。产品当前使用第一条（[Current](../current/01-scope-and-flow.md)），官方 `--json`／`--session-id` 路径属更高版本，本机不具备。
2. **会话何时创建**：`agents.create()` 一执行就创建，实测相对进程启动约 **1.6–1.8s**（路径 A／B 的热 profile：1.58–1.81s；路径 B 冷 profile 首次链接：20.5s，差值来自启动器建立 profile 链接，不是会话创建本身）。
3. **调用方何时第一次可靠取得 sessionId**：路径 A 是「**整轮结束后的最终结果**」（result JSON／`DSH_RESULT_FILE`）；路径 B 是「**任何时刻都取不到**」；路径 C 按源码与 #7 实测是「`session/new` 响应」，本次未复现。
4. **长任务能否先取得**：路径 A **不能**。实测模型轮次进行中 stdout 为空，结果行在 turn 结束之后（第 1 次 2630ms、第 2 次 2662ms）才出现。若打开 `DSH_DEBUG_RUNNER=1`，stderr 会在创建后约 12–16ms 出现 `created <id>`，但那是可选调试输出，不是契约。
5. **崩溃窗口是否真实存在**：**存在**。位于「会话创建（约 t0+1.6s）」与「结果交付（turn 结束后）」之间；窗口内强杀会留下已创建但无法从调用方输出读取的会话，且会话文件可能只写入了一部分。
6. **只创建会话、不跑 turn 的接口**：Harness **没有**官方或已验证的独立接口（`agents.create()` 与 turn 是两个阶段，但 CLI／runner 都不暴露前者）。**对当前 runner 而言不需要新接口**：标识由 wrapper 自己生成，改成创建后立即交付即可；官方 headless 则需要上游提供（#19／#21 的 JSONL `session` 事件方向正是针对这一点，本机版本未验证）。

## Contract Impact

未改 Current、ADR、运行代码或任何已确认 Contract；本报告只补时间线证据。可以指出的两点，供后续任务决定，不作为本任务需求：

- **交付时点**：Issue #17／#18 定义的绑定状态需要 `sessionId`。当前 runner 只在最终结果里交付它，因此「进程已启动但结果没读回」的调用需要一个保守处理（例如按工作目录与创建时间识别遗留会话，或在 wrapper 内改成创建后立即交付标识）。这是实现选择，不属于本 Issue 的验收。
- **上游路径**：若 #19／#21 的官方 `--json` 路径在升级后可用，`session` 事件会把取得时点提前到 turn 之前；在那之前不把上游文档当作本机已支持。

## 未覆盖范围

- 未安装、未升级、未重启任何 Harness；本报告只描述 0.1.5-rc.2 的实测结果。
- 未复现 acp `session/new`（沙箱限制，见证据 3）；该路径的结论依赖源码与 #7 历史实测，本次无新增独立证据。
- 未覆盖并发写入者、审批交互、多台电脑、Harness 进程重启后的续接。
- 长 turn 实测用的是 12s 强杀；模型推理耗时受网络与模型侧影响，本报告只按实际观测的时间线陈述，不外推到其他时长。
- 原始凭据、完整会话日志、模型正文与绝对机器路径未进入本报告；测试会话与临时目录只留在本机。
- 探针本身的运行受本机沙箱限制（不能用管道），复现时若环境允许管道，可用更直接的方式重跑。
