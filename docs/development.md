# 开发环境与验证

## 当前就绪情况

目前只有规则、需求、文档入口与 Research 阶段的最小调用件（[`scripts/headless-session/`](../scripts/headless-session/README.md)），没有接单运行代码、package.json、依赖锁文件、测试脚本或 Actions Workflow。不能执行不存在的 npm 命令，也不能将这份说明当作环境已部署的证明。

接单工具计划采用 Node.js。首次代码 PR 建立最小 package.json、必要锁文件与真正可运行的测试命令，不先铺空模块或假测试。工具自身的 Node.js 进程不是本地模型推理服务。

运行方向已按 [ADR 0002](decisions/0002-headless-cli-execution.md) 改为直接启动 headless CLI。原 [Issue #3](https://github.com/cnjimmyshao/fjzx.gh-dev-runner/issues/3)／[PR #4](https://github.com/cnjimmyshao/fjzx.gh-dev-runner/pull/4) 的 Web 实验独立收尾；不改写其实验事实，也不把它当作 CLI 已验证。

## 本机 CLI 验证的实际结果（0.1.5-rc.2）

已在本机执行电脑上按 Issue #7 完成一次性接入验证，证据见 [CLI 验证报告](research/2026-09-23-local-harness-cli-first-run-and-resume.md)。结论要点：

- 实测版本 Node v26.7.0、`@deepseek-ai/dsh` 0.1.5-rc.2。**该版本的 headless CLI 只有 `[task...]` 与 `--help`**，没有上游更高版本（`0.1.6-alpha.1` 起）的 `--session-id`／`--json`，因此不能直接按上游文档调用；同目录再次调用只会新建会话。
- 首轮执行、退出后续接、结构化结果与失败信号已由 [`scripts/headless-session/`](../scripts/headless-session/README.md) 在本机实测通过：它用 profile patch 把本地 runner 挂到随附的 headless profile 上，命令仍是「启动器 + headless profile」，未升级、未新增服务或端口。
- 仍待执行的验证只在维护者日后授权升级 Harness 时才需要（届时按新版本重新实测官方 `--session-id`／`--json`，并复核 overlay 行 id）。未授权前不升级工作中的 Harness，也不改用其他界面。

模型 Key 仍按该版本的受支持方式提供（继承环境变量、`$DSH_HOME/.credentials.yaml`、调用目录或 `$DSH_HOME` 下的 `.env`）；本仓库脚本不读取、不打印、不保存 Key。

## 开发与运行环境分开

本仓库是接单工具的源码。被接入项目有各自的代码目录、分支和开发环境。接单工具的本机状态与凭证单独保存，不混入两者的提交。

本机部署明确分三层：

```text
.env / .env.example        Runner 人工部署配置
.local/...                 Runner runtime state / task bindings / logs
<DSH_HOME>/...             Harness config / credentials / sessions / state
```

`.env` 只配置 Runner 自身需要的入口，不保存模型 Key 或 GitHub token；`.local/` 只由 Runner 维护运行状态；Harness 的 credentials、profiles、sessions 与其他持久化数据归 `DSH_HOME`。仓库中的 `.env.example` 是部署入口示例，不代表 Scheduling Contract 已在此固定精确默认值。

准备 Git、Node.js、实际运行账户已授权的 GitHub CLI（`gh`）和本机 Harness CLI。Runner 启动前先用 `gh auth status` 验证该执行账户可访问本机认证配置；失败时不进入轮询。Harness 复用同一执行账户可访问的本机 `gh` 配置，Runner 不向 Harness 注入或转发 `GH_TOKEN` / `GITHUB_TOKEN`。

模型 Key 由 Harness 当前版本支持的凭据／配置机制保存并加载，仅通过其受支持方式供给 Harness；Runner 不建立第二份模型凭据存储。Key 不打印到终端、命令行实参或报告。配置 Key 不等于安装完成，也不证明 GitHub 权限、工具链与会话续接可用。

共享一个 `DSH_HOME` 是首版优先目标，不是当前版本并发安全性的已验证事实。在 [Issue #36](https://github.com/cnjimmyshao/fjzx.gh-dev-runner/issues/36) 完成“同 home、不同 session 并发 + 同 session 单写入”实测前，实际 Runner 并发保持保守，不因文档目标直接开放到大于 1。

检查这些条件不等于授权安装、升级、重启已有服务或执行真实开发任务。公开材料使用机器别名及脱敏路径，原始会话、日志和私有仓库清单只保存在本机。允许的测试配置与调用范围以验证 Issue 和维护者授权为准。

首台实测使用维护者指定的执行电脑，先覆盖其实际系统；第二台再验证同一程序的配置与路由隔离，不在没有证据时声明全平台支持。

## 先验证 CLI，再开发接单

这是一次性接入验证，不是本工具的环境诊断功能，也不要求每次接单重新检查整台电脑。本机 0.1.5-rc.2 的执行结果已记录在上面与 Research 报告中；下列步骤保留作为重跑口径，以及日后授权升级或换机时的核对清单。在独立测试目录、测试会话与不干扰现有工作的持久化配置中进行：

1. 核对实际 Node／Harness 版本、运行账户、profile、工作目录和持久化位置。按该版本的受支持方式加载本机模型 Key，记录方式而不是凭据值。
2. 首个 CLI 进程发送不调用工具、不读写业务文件的短消息；记录会话标识、输出和实际退出结果。Harness 自身的测试会话持久化是允许的。
3. 确认首个进程退出，再以相同目录、会话标识和匹配配置启动第二个进程。第二条消息依赖第一轮内容，结合标识和持久化证据确认原会话续接，而不是把上一轮答案塞进新会话。
4. 记录 stdout／stderr、可获得的结构化结果、最终结果与退出状态如何区分；用一个安全的无模型失败案例核对错误不会被当作成功，例如引用不存在的测试会话（本机实测：报错退出且不会静默新建会话）。只覆盖当前接入所需场景，不穷举 CLI。
5. 在带日期的 Research 留下可复现步骤、版本、脱敏证据、结果和限制。必要时保留最小探针供后续复用；失败就报告缺口，不新建恢复平台，不自行升级正在工作的 Harness。

上游参考：[Harness headless 文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/headless/README.md)。其 `--json`／`--session-id` 是核对入口，不是本机已通过证明；验证报告需记录所查版本或固定提交及实际安装版本。本机 0.1.5-rc.2 已实测不含这两个选项，报告按该版本的实际退出与完成／错误信息判断；结构化输出不必等同于逐 token 流，也不能仅凭 `final` 字段认定成功。

新 CLI 验证不依赖旧 Web 认证方案，不需要打开、关闭或接管正在工作的 Web 服务。Web 实验与本机 CLI 实测分别保留，不混用结论。

## 后续最小实现

CLI 验证确认可用后，再写明确的实施 Issue：少量本机配置与凭据保存、通过 `gh` 增量发现新建 Issue Body 与后续新增 Issue 评论、按 `runnerName` 识别执行请求、去重及任务绑定、CLI 启动／续接、必要日志与反馈。实现时必须同时覆盖两类正式触发入口，不能只轮询 comments 而漏掉“新建 Issue 的 Body 末尾直接写 `@<runnerName>`”的情况。新增文件按实际职责组织，不预建 Scheduler、Repository、Adapter 等整套层次。

GitHub 资料入口：[gh api](https://cli.github.com/manual/gh_api)、[Issues API](https://docs.github.com/en/rest/issues/issues)、[Issue comments API](https://docs.github.com/en/rest/issues/comments)。后续按实际接口核对分页、更新时间和限流；对每个新内容事件独立读取正文、trim 并检查是否以当前机器的 `@<runnerName>` 结尾。普通回复本身不触发，只有该条新 Body / Comment 满足结尾规则才触发。验证初次启动与普通重启不会重放历史命令，不靠不断创建 Actions run 检查状态。

## 验证分层

`scripts/headless-session/` 的用法与已验证步骤见其 [README](../scripts/headless-session/README.md)：不调用模型的路径（缺 `DSH_TASK`、引用不存在的会话标识、工作目录不匹配）可直接重跑，不需要 Key；新建与续接需要有效 Key，属本机实测项。

文档改动检查相对链接、术语、权限、Scope 与隐私，不触发模型或真实任务。纯逻辑测试优先隔离 GitHub／Harness；实际 CLI 验证只使用明确授权的测试会话，GitHub 端到端测试另使用授权的测试仓库。第一条端到端链路通过后，再验证第二台电脑不会重复领取同一任务。

结果记录命令、环境、验证版本、通过／失败／跳过及未覆盖范围。没有运行就写未运行，不预填 pass 数量。进程是否成功启动、模型是否成功回答、原会话是否正确续接、输出是否可读取分别给证据，不把某一层成功等同于开发任务验收完成。

PR Review 通过现有已授权的审查方式完成；尚未配置 Codex 或无法读取其结果时明确标注。不要为此擅自添加 Workflow、Secrets 或调整仓库权限。独立 Review 不等于本机实测。
