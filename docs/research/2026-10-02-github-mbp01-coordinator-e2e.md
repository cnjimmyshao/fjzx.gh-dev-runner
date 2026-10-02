# 真实 GitHub / MBP01 / 外部 dot Coordinator 受控 E2E

Date: 2026-10-02
Keywords: GitHub, MBP01, Runner, Harness, DSH, Coordinator, RESUME, run_end, E2E
Status: VERIFIED（范围限本文记录的单机、单 Issue、一次受控往返及所列公开评论与本机审计字段）

关联：[Issue #66](https://github.com/cnjimmyshao/fjzx.gh-dev-runner/issues/66)、[Issue #69](https://github.com/cnjimmyshao/fjzx.gh-dev-runner/issues/69)。
依据：[Runner 激活与任务触发](../current/03-runner-trigger.md)、[本机配置与状态 Schema](../current/04-local-state.md)、[Harness 并发与轮询调度](../current/05-harness-scheduling.md)、[Coordinator 协调与交接](../current/06-coordinator-handoff.md)。
运行时仓库版本：`60113e7`（当轮所读 `main`；最终维护者复核时源仓库与 #66 worktree 的 HEAD 仍为该提交）。

## 调查问题

1. 一条新的真实 GitHub 控制评论能否由已部署的 MBP01 Runner 精确领取，并以 RESUME 续接 #66 原 DSH session 与原任务 worktree；
2. 外部 dot Coordinator 能否基于 D1 报告作独立技术判断，并在一次性授权后发布唯一一条 return-to 给 `@MBP01`；
3. Runner 能否在前一调用明确结束后自动领取该 return-to，以新的 runId 再次 RESUME 同 session / worktree，并正常产生最终 `run_end`；
4. GitHub 内的 Harness 报告、`run_end` 与 `runner_stopped` 分别能证明什么；
5. 这次受控闭环能更新哪些验证状态，哪些相邻能力仍未覆盖。

## Environment

| 项目 | 实际范围 |
| --- | --- |
| 仓库／任务 | `cnjimmyshao/fjzx.gh-dev-runner` Issue #66 |
| 执行端 | 已部署的 `MBP01` Runner 与 Harness；机器绝对路径不公开 |
| Runner 代码 | 当轮读取 `main` @ `60113e7`；V1 产品实现位于 `src/` |
| Harness 绑定 | `session-4b209aa1-9e1f-4b0b-a8b7-91e0ca95cb9d`；公开比对完整标识，原始会话正文只留本机 |
| 任务目录／分支 | 同一规范化 #66 任务 worktree（绝对路径不公开）；分支 `fjzx/issue-66` |
| Coordinator | 维护者现有外部 dot 对话；没有调用或部署仓库内 Safari / ChatGPT Web 接入 |
| GitHub 身份与回写 | 原 Issue 的公开评论；Runner / Harness / Coordinator 的业务回写均由授权身份完成 |
| 任务范围 | 只读规则、Issue 与必要本机运行证据；不改仓库文件／配置／凭据，不建 commit / PR / 新 Issue，不 merge、不关闭 #66 |
| 本机证据 | `state.json` 与 append-only `audit.jsonl` 留在执行电脑；公开报告只列必要标识、时间与脱敏比对结果 |

本轮没有重新测量 Node / Harness 的安装版本，也没有把版本兼容性作为结论；Node.js 24 LTS 仍是 V1 Contract。完整本机路径、凭据、会话正文和原始捕获未进入公开材料。

## Evidence

下面链接均指向 Issue #66 的公开评论；时间使用 GitHub `created_at` 的 UTC 值。

| 证据 | 时间 | 作用 |
| --- | --- | --- |
| [D3：新的 MBP01 RESUME 触发（comment 5936590888）](https://github.com/cnjimmyshao/fjzx.gh-dev-runner/issues/66#issuecomment-5936590888) | 2026-10-01T17:13:20Z | 明确要求 RESUME 原 session / worktree，末行 `@MBP01` |
| [D1：Harness 协调请求与本机比对报告（comment 5936622434）](https://github.com/cnjimmyshao/fjzx.gh-dev-runner/issues/66#issuecomment-5936622434) | 2026-10-01T17:15:06Z | 报告 D3 对应 runId、kind、session、worktree / branch 与前序 START 证据 |
| [外部 dot Coordinator 技术判断（comment 5936719448）](https://github.com/cnjimmyshao/fjzx.gh-dev-runner/issues/66#issuecomment-5936719448) | 2026-10-01T17:21:11Z | 判定“已有绑定经 Runner 进行了一次 RESUME”证据足够继续，但完整交接仍未 PASS |
| [唯一一次 return-to（comment 5936762110）](https://github.com/cnjimmyshao/fjzx.gh-dev-runner/issues/66#issuecomment-5936762110) | 2026-10-01T17:23:54Z | 准确引用 D1 与技术判断，授权一次最终 RESUME，末行 `@MBP01` |
| [最终 Harness 报告（comment 5936809894）](https://github.com/cnjimmyshao/fjzx.gh-dev-runner/issues/66#issuecomment-5936809894) | 2026-10-01T17:26:58Z | 精确引用 return-to，报告最终 run 的 sourceId / runId / kind 与同 session / worktree 比对，并明确当时尚无 `run_end` |
| [维护者最终收尾（comment 5943382231）](https://github.com/cnjimmyshao/fjzx.gh-dev-runner/issues/66#issuecomment-5943382231) | 2026-10-02T00:38:25Z（北京时间 08:38:25） | 在 Harness 退出后核对最终 `run_end` 与清理状态，把本文所限闭环记为 PASS |

Coordinator 评论明确说明它没有直接读取 MBP01 的原始 state / audit，而是根据 D1 提交的证据作技术判断。最终本机字段由维护者在执行电脑复核后收尾；本文保留这两种证据来源的边界，不把 Coordinator 判断描述成对原始本机日志的独立审计。

## Results

### 1. 前序中断没有被冒充为成功

D1 报告同时保留前序 START：`run-20261001-170137-ad8481` 已建立同一 `session-4b209aa1-…`，但以 exit code 130、outcome `harness_error`、`turnEnd=null` 结束，因此不能算正常完成；旧 D2 评论也没有重放。

Git 故障需分两层记录：[D2 控制评论](https://github.com/cnjimmyshao/fjzx.gh-dev-runner/issues/66#issuecomment-5936380569)说明更早的 `run-20261001-163839-b02e6d` 在 Runner 准备 worktree 时失败，尚未建立 session；维护者随后配置 `GIT_BIN` 再发布新的 D2。D2 真正 spawn 后，本机原 session 持久化记录的首轮 `tool/result`（seq 21，turn 1 / step 1）又记录 Dev Git 调用因错误架构失败（`Bad CPU type in executable`，退出 126）。后者说明仅修 Runner 的 `GIT_BIN` 不会修正 Harness 内继承的 `PATH`；原始正文与路径不公开。现有证据不足以把随后整个 exit 130 归因于 Git，本文不作该因果断言。

### 2. D3 精确触发第一次同 session RESUME

| 字段 | 结果 |
| --- | --- |
| trigger sourceId | `5936590888`（D3 新评论） |
| claim / runId | 2026-10-01T17:13:45Z；`run-20261001-171345-c8a140` |
| kind | `resume` |
| sessionId | `session-4b209aa1-9e1f-4b0b-a8b7-91e0ca95cb9d`，与前序 START 相同 |
| worktree / branch | 同一规范化 #66 任务 worktree；`fjzx/issue-66`；`branchDrift=false` |
| GitHub 报告 | D1 comment `5936622434`，2026-10-01T17:15:06Z |
| 技术结束 | `run_end` at 2026-10-01T17:15:16.718Z；exit code 0；outcome `turn_completed`；`turnEnd=completed` |

D1 评论比对应 `run_end` 早约 10 秒。这正好说明：Dev 能在本轮 Harness 内完成 GitHub 回写，不等于父进程已经观察到子进程退出；本轮正常结束只能由随后同 runId 的 `run_end` 补齐。

### 3. 外部 dot 只交回一次，Runner 后续轮询精确领取

Coordinator 于 17:21:11Z 给出有限技术判断：D1 足以证明一次真实 RESUME，可以继续剩余只读验收，但尚不能把完整闭环标为 PASS。维护者在 dot 当前对话另行批准后，Coordinator 于 17:23:54Z 发布唯一一次 return-to `5936762110`；它准确引用 D1 和技术判断，正文明确只授权一次最终 RESUME，最后一行是 `@MBP01`。

前一 D1 调用已在 17:15:16.718Z 明确结束。Runner 的后续自动轮询于 2026-10-01T17:26:21.890Z 记录 `trigger_claimed`，sourceId 精确等于 `5936762110`，没有在前一写入者仍活动时叠加第二个 Harness，也没有把 D3 或其他旧评论当作最终触发。

### 4. 最终 RESUME 复用同一绑定并正常结束

| 字段 | D1 调用 | 最终调用 | 判定 |
| --- | --- | --- | --- |
| sourceId | `5936590888` | `5936762110` | 各自精确对应新触发 |
| runId | `run-20261001-171345-c8a140` | `run-20261001-172621-de2f03` | 两次独立调用 |
| kind | `resume` | `resume` | 都走已有绑定 |
| sessionId | `session-4b209aa1-9e1f-4b0b-a8b7-91e0ca95cb9d` | 相同 | 原 session 续接 |
| 规范化任务目录 | #66 原任务 worktree | 相同 | 原目录续接；绝对路径不公开 |
| 分支 | `fjzx/issue-66` | `fjzx/issue-66`，`branchDrift=false` | 一致 |
| 结束 | 17:15:16.718Z，exit 0 / `turn_completed` / `completed` | 17:27:05.519Z，exit 0 / `turn_completed` / `completed` / `timedOut=false` | 两轮均有正常 `run_end` |

最终调用的公开时间线：

```text
17:23:54.000Z  return-to comment 5936762110
17:26:21.890Z  trigger_claimed -> run-20261001-172621-de2f03
17:26:21.947Z  harness_spawned
17:26:22.705Z  session_bound（原 sessionId）
17:26:58.000Z  Harness 发布最终报告 5936809894；当时明确写 run_end 待核验
17:27:05.519Z  run_end：exit 0 / turn_completed / completed / timedOut=false
17:27:34.481Z  runner_stopped
```

`run_end` 是这一 Harness 调用的终态证据；`runner_stopped` 是外层 Runner 进程的生命周期事件，只能确认该 Runner 后来停止。无遗留 Runner / Harness 进程或实例锁来自维护者随后另做的现场复核，不能由 `runner_stopped` 这一条事件单独推出。`runner_stopped` 与现场清理检查都不属于每轮成功条件；常驻 Runner 在一轮 `run_end` 后继续轮询是正常行为，无需为了验收每次停止。

### 5. 验收方法需要“公开报告 + 退出后运行证据”两阶段

这次最终 Harness 报告做了正确的证据分层：它能证明 sourceId、runId、kind、session / worktree 比对与 GitHub 回写已经发生；由于评论发布时本轮仍为 `running`，它明确把 exit code、outcome、`turnEnd`、endedAt 留作进程退出后核验，没有预写 PASS。

专项 E2E 的收尾口径因此是：

1. 先核对公开结果评论引用的是本轮实际触发，并记录正确 runId / session / worktree；
2. 等 Harness 退出后，再从本机 state / append-only audit 找同一 runId 的 `run_end`；
3. 分别检查 exit code、outcome、`turnEnd`、`timedOut` 与 endedAt，不用“评论已经发出”替代终态；
4. 仅在测试要求整个 Runner 进程退出时再核对 `runner_stopped`；常驻模式不等待它。

### 6. `GIT_BIN` 与 Harness / Dev `PATH` 是两个边界

当前实现只把配置的 `GIT_BIN` 传给 Runner 的 worktree manager，用于源仓库校验、`git worktree` 与任务目录操作。Harness 子进程环境继承 Runner 服务启动环境里的 `PATH`，不会因为设置了 `GIT_BIN` 就重写该 `PATH`；Harness / Dev 内执行的 `git` / `gh` 仍由 `PATH` 解析。

因此部署验证要分别做两件事：确认 Runner 的 `GIT_BIN` 可用；确认启动 Runner 的同一服务环境中，`PATH` 会让 Harness / Dev 命中预期架构和版本的 `git` / `gh`。某次 worktree 创建成功不能证明 Dev 内的 Git 路径也正确；反过来，前序运行中观察到错误 PATH 也不能在没有完整因果证据时被写成 exit 130 的唯一原因。

## Conclusion

在本文限定范围内，真实链路可以记为 **VERIFIED / PASS**：

```text
GitHub 新控制评论
-> MBP01 Runner 精确领取
-> 原 DSH session / worktree RESUME
-> D1 回写
-> 外部 dot Coordinator 技术判断
-> 唯一一次 return-to @MBP01
-> Runner 后续轮询精确领取
-> 同 session / worktree 再次 RESUME
-> Harness 报告
-> 正常 run_end
-> 维护者退出后验收
```

它把此前“真实模型 / GitHub 完整轮次尚未验证”的笼统状态收窄为：**单机、单 Issue、一次受控外部 Coordinator 往返已经通过**。这是一项明确的正面证据，但不能外推到未测能力。

## Contract Impact

不修改 Node 版本、触发、状态、调度、权限或 Coordinator Contract，也不修改 AGENTS。本文只记录已有运行事实，并据此纠正 README、开发说明及 Current 中过期的“运行代码尚未实现”状态文字。

运行与验收说明增加两项实现边界，但不改变行为：`GIT_BIN` 只选择 Runner worktree 操作的 Git，Harness / Dev 仍从继承的 `PATH` 解析工具；Harness 内结果评论与进程终态是两层证据，专项验收须在退出后核对 `run_end`，常驻 Runner 不要求每轮出现 `runner_stopped`。

## 未覆盖范围

- 只覆盖 `MBP01`、Issue #66 和一次受控 return-to；没有验证多台 Runner、跨机迁移、并发路由、重复多轮或无限自动往返。
- Coordinator 是维护者现有的外部 dot 对话；没有实现或实测仓库内 Coordinator 正式触发、Safari / ChatGPT Web 控制、conversation 持久化与恢复。
- 全程是只读验收，没有创建、审查、修改或合并真实 PR，也没有走真实 Review Finding → 修复 → 复审流程。
- 没有重新测量 Node / Harness 版本，也没有验证完整 Node 26 兼容；V1 正式运行 Contract 仍为 Node.js 24 LTS。
- 没有把前序 exit 130 归因于错误 Git。错误架构 Git 是更早观察到的相邻环境问题，不是已证明的唯一根因。
- Coordinator 没有直接读取原始 state / audit；维护者随后在执行电脑核对终态。原始日志、完整路径、凭据与会话正文没有公开，本文只保存可回查的公开评论和必要脱敏字段。
