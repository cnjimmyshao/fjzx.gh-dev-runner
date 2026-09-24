# 开发环境与验证

## 当前就绪情况

接单程序位于 [`src/`](../src/README.md)，随仓库带最小 `package.json`、测试入口与脱敏配置示例
（[`config.example.json`](../config.example.json)）；没有第三方依赖，`npm install` 不安装任何包。

| 命令 | 说明 |
| --- | --- |
| `npm test` | 自动化测试；`gh` 与 Harness 调用用替身隔离，另有几个真实的只读/失败路径冒烟项 |
| `npm run once` | 只检查一轮后退出，用于首次核对配置与 `gh` 授权 |
| `npm start` | 常驻，按 `runtime.pollSeconds`（缺省 60 秒）检查接入仓库的新评论 |

本工具自身的 Node.js 进程不是本地模型推理服务；模型调用仍由它启动的 Harness headless CLI 完成。

测试分层：多数用例用替身隔离 GitHub 与 Harness，覆盖评论解析、分页与进度、授权路由、去重、绑定、
单写入者与重启恢复；另有几项走真实边界——真实 `execFileAsync` 的 file 捕获与超时、真实 `git
worktree add`、以及对本仓库公开 Issue 的一次真实只读 `gh` 调用（未登录或无网络时明确跳过并打印
原因，跳过不算通过）。这些都不调用模型、不启动真实 Harness 会话。

真实接单链路（真实评论命令 → 真实 Harness 会话 → 真实回写）需要维护者提供授权的测试 Issue 与
独立目录；§Runtime 联调证据当前为空。

运行方向已按 [ADR 0002](decisions/0002-headless-cli-execution.md) 改为直接启动 headless CLI。原 [Issue #3](https://github.com/cnjimmyshao/fjzx.gh-dev-runner/issues/3)／[PR #4](https://github.com/cnjimmyshao/fjzx.gh-dev-runner/pull/4) 的 Web 实验独立收尾；不改写其实验事实，也不把它当作 CLI 已验证。

## 本机 CLI 验证的实际结果（0.1.5-rc.2）

已在本机执行电脑上按 Issue #7 完成一次性接入验证，证据见 [CLI 验证报告](research/2026-09-23-local-harness-cli-first-run-and-resume.md)。结论要点：

- 实测版本 Node v26.7.0、`@deepseek-ai/dsh` 0.1.5-rc.2。**该版本的 headless CLI 只有 `[task...]` 与 `--help`**，没有上游更高版本（`0.1.6-alpha.1` 起）的 `--session-id`／`--json`，因此不能直接按上游文档调用；同目录再次调用只会新建会话。
- 当时的首轮执行、退出后续接、结构化结果与失败信号曾由 [`scripts/headless-session/`](../scripts/headless-session/README.md) 的 profile patch 在本机实测通过；这是 0.1.5-rc.2 的历史兼容实验，不再是产品运行路径。
- [Issue #19](https://github.com/cnjimmyshao/fjzx.gh-dev-runner/issues/19) 已把产品 Contract 收缩到 Harness 官方 `--session-id`／`--json`。旧执行电脑仍是 0.1.5-rc.2 的事实不变；本任务不擅自升级，因此“官方路径在该执行电脑可用”仍属未验证。

模型 Key 仍按该版本的受支持方式提供（继承环境变量、`$DSH_HOME/.credentials.yaml`、调用目录或 `$DSH_HOME` 下的 `.env`）；本仓库脚本不读取、不打印、不保存 Key。

## 当前产品 CLI Contract

产品代码不再依赖仓库自定义 runner 或 overlay。部署版本的 headless 必须原生提供 `--json` 与
`--session-id`；DeepSeek Harness 发布记录从 **0.1.6-alpha.1** 起列出这两项能力，当前上游
v0.1.7-rc.1 仍包含它们。版本号只作为来源记录，实际部署仍以该安装的
`dsh --profile headless --help` 与本机验证为准。

调用约定：

1. 首轮：`dsh --profile headless --json`，任务从 stdin 传入；从首个 `session` 事件保存真实 sessionId。
2. 续接：相同工作目录下追加 `--session-id <id>`；未知 id、cwd / ownership / preset 不匹配由 Harness 拒绝，本工具不改成新建会话。
3. stdout 是官方 JSONL。接单工具只使用 `session`、`status.phase=turn_end`、`final` / `error`
   等控制信息；模型正文、thinking、tool result 与完整 stdout/stderr 只留本机日志。
4. 退出码 0 仍只说明该 turn 以 completed 结束，不代表业务完成。

当前自动化测试按上述 Contract 使用替身验证；真实 Harness 冒烟先读取 `--help`，如果安装缺少
这两个选项就明确 skip，而不是调用旧兼容层或自动升级。

## 开发与运行环境分开

本仓库是接单工具的源码。被接入项目有各自的代码目录、分支和开发环境。接单工具的本机状态与凭证单独保存，不混入两者的提交。

准备 Git、Node.js、实际运行账户已授权的 GitHub CLI（`gh`）和本机 Harness CLI。模型 Key 在本机配置保存，仅通过受支持方式供给 Harness；不打印到终端、命令行实参或报告。配置 Key 不等于安装完成，也不证明 GitHub 权限、工具链与会话续接可用。

检查这些条件不等于授权安装、升级、重启已有服务或执行真实开发任务。公开材料使用机器别名及脱敏路径，原始会话、日志和私有仓库清单只保存在本机。允许的测试配置与调用范围以验证 Issue 和维护者授权为准。

首台实测使用维护者指定的执行电脑，先覆盖其实际系统；第二台再验证同一程序的配置与路由隔离，不在没有证据时声明全平台支持。

## 一次性 CLI 接入验证（重跑口径）

这是一次性接入验证，不是本工具的环境诊断功能，也不要求每次接单重新检查整台电脑。本机 0.1.5-rc.2 的历史执行结果已记录在上面与 Research 报告中；下列步骤现在用于授权升级后验证**官方** headless Contract，或换机时重新核对。在独立测试目录、测试会话与不干扰现有工作的持久化配置中进行：

1. 核对实际 Node／Harness 版本、运行账户、profile、工作目录和持久化位置。按该版本的受支持方式加载本机模型 Key，记录方式而不是凭据值。
2. 首个 CLI 进程发送不调用工具、不读写业务文件的短消息；记录会话标识、输出和实际退出结果。Harness 自身的测试会话持久化是允许的。
3. 确认首个进程退出，再以相同目录、会话标识和匹配配置启动第二个进程。第二条消息依赖第一轮内容，结合标识和持久化证据确认原会话续接，而不是把上一轮答案塞进新会话。
4. 记录 stdout／stderr、可获得的结构化结果、最终结果与退出状态如何区分；用一个安全的无模型失败案例核对错误不会被当作成功，例如引用不存在的测试会话（本机实测：报错退出且不会静默新建会话）。只覆盖当前接入所需场景，不穷举 CLI。
5. 在带日期的 Research 留下可复现步骤、版本、脱敏证据、结果和限制。必要时保留最小探针供后续复用；失败就报告缺口，不新建恢复平台，不自行升级正在工作的 Harness。

上游参考：[Harness headless 文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/headless/README.md)。当前产品直接依赖其 `--json`／`--session-id` Contract；上游文档或 release note 不是本机已通过证明，验证报告仍需记录实际安装版本。本机 0.1.5-rc.2 已实测不含这两个选项，因此不能部署当前产品调用路径；授权升级后需重新实测。JSONL 是事件 projection，不是 Session log，且不能仅凭 `final` 字段认定成功。

新 CLI 验证不依赖旧 Web 认证方案，不需要打开、关闭或接管正在工作的 Web 服务。Web 实验与本机 CLI 实测分别保留，不混用结论。

## 后续最小实现

接单工具的最小实现已按 [Issue #9](https://github.com/cnjimmyshao/fjzx.gh-dev-runner/issues/9) 落地：
本机配置、通过 `gh` 增量检查评论、执行机路由、去重与任务绑定、CLI 启动／续接、必要日志与反馈，
代码按实际职责放在 [`src/`](../src/README.md)，没有预建 Scheduler、Repository、Adapter 层次。

GitHub 资料入口：[gh api](https://cli.github.com/manual/gh_api)、[Issue comments API](https://docs.github.com/en/rest/issues/comments)。当前实现用 `gh api --paginate -q '.[] | {…}'` 逐行读取，标签过滤在服务端完成，限流按错误文本识别并在下一轮重试。

## 验证分层

`scripts/headless-session/` 只保留 [历史兼容实验说明](../scripts/headless-session/README.md)，不再参与产品测试。当前无模型真实边界用例直接对官方 headless 调用不存在的 `--session-id`；若本机安装的 `--help` 不含 `--json`／`--session-id`，该用例明确 skip。

接单程序的自动化测试（`npm test`）分两层：多数用例用替身隔离 GitHub 与 Harness，覆盖成功路径、
关键非法输入与状态、去重与单写入者；少数用例走真实边界——真实 `execFileAsync`（file 捕获、超时、
命令不存在、stdin 任务输入）、真实 `git worktree add`、真实 Harness 官方 CLI 的失败路径（支持原生选项时续接不存在的会话：不调用模型、不需要凭据）、以及对本仓库公开 Issue 的一次真实只读 `gh` 读取。替身只替换进程与网络边界，被测
判定逻辑仍是生产代码；真实边界用例在环境不支持时明确跳过并打印原因（跳过 ≠ 通过），也不安装、
升级或重启任何已有服务。全部用例都不调用模型、不启动真实 Harness 会话，可在本机直接重跑。

真实接单链路只使用维护者确认的专用测试 Issue、独立目录与少量测试消息：`npm run once` 用于核对配置与
`gh` 授权；真实接单需要授权的测试仓库、标签 `runner:<machineId>` 与真实 Harness 会话。没有授权时
只做代码与隔离测试，并在关联 Issue 精确列出缺口，不把模拟测试当本机实测。第一条端到端链路通过后，
再验证第二台电脑不会重复领取同一任务。

结果记录命令、环境、验证版本、通过／失败／跳过及未覆盖范围。没有运行就写未运行，不预填 pass 数量。进程是否成功启动、模型是否成功回答、原会话是否正确续接、输出是否可读取分别给证据，不把某一层成功等同于开发任务验收完成。

PR Review 通过现有已授权的审查方式完成；尚未配置 Codex 或无法读取其结果时明确标注。不要为此擅自添加 Workflow、Secrets 或调整仓库权限。独立 Review 不等于本机实测。
