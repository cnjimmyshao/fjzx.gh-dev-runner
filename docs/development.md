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

准备 Git、Node.js、实际运行账户已授权的 GitHub CLI（`gh`）和本机 Harness CLI。模型 Key 在本机配置保存，仅通过受支持方式供给 Harness；不打印到终端、命令行实参或报告。配置 Key 不等于安装完成，也不证明 GitHub 权限、工具链与会话续接可用。

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

CLI 验证确认可用后，再写明确的实施 Issue：少量本机配置与凭据保存、通过 `gh` 读取新建 Issue Body 与当前最新 eligible control comment、按 `runnerName` 识别当前触发候选、去重及任务绑定、CLI 启动／续接、必要日志与反馈。一个 Issue 的当前 task binding 只归一个 Runner。实现时必须同时覆盖两类正式候选：创建时授权主体的一次性初始 Body，以及已有评论后“授权主体发布且不以保留前缀 `BOT:` 开头”的当前最新评论；运行期间的新回复不排队，Harness 结束后再读取当时最新的一条。Runner 自动反馈统一写成 `BOT:<runnerName>` 前缀。新增文件按实际职责组织，不预建 Scheduler、Repository、Adapter 等整套层次。

GitHub 资料入口：[gh api](https://cli.github.com/manual/gh_api)、[Issues API](https://docs.github.com/en/rest/issues/issues)、[Issue comments API](https://docs.github.com/en/rest/issues/comments)。后续按实际接口核对分页、更新时间和限流。

实现保持 Issue 级 single-flight：每次准备检查某个 Issue 前，先看本机任务运行状态。若该 Issue 已有 Harness 处于 starting / running / unknown，直接跳过这个 Issue，不读取它的新评论、不更新 `eligibleCommentWatermark`、不向当前 Harness 注入消息，也不启动第二个写入者；Runner 仍继续扫描其他 Issue / 其他仓库。

只有 Issue 空闲时才读取当前最新一条 eligible control comment，排除 `BOT:` 自动反馈并核对作者授权。若最新评论不新于该 Issue 的水位则忽略；若更新则把水位推进到它，然后只对这**一条当前最新评论**做 trim + `@<runnerName>` 结尾判断。是命令就 START / RESUME，不是命令就仅保存新水位。Harness 启动后水位保持在本次触发位置，直到该 Harness 明确结束；下次轮询再看那时的最新回复。Harness 运行期间的新回复不保存为待执行任务；Harness 结束后再读取当时最新的一条。

验证至少覆盖：同一 Issue 运行中不会启动第二个 Harness且水位不动；与此同时其他 Issue / 其他仓库仍可正常领取；当前 Harness 结束后只依据当时最新 eligible comment 决定是否 RESUME；普通轮询和重启不会重复执行同一触发。

## 验证分层

`scripts/headless-session/` 的用法与已验证步骤见其 [README](../scripts/headless-session/README.md)：不调用模型的路径（缺 `DSH_TASK`、引用不存在的会话标识、工作目录不匹配）可直接重跑，不需要 Key；新建与续接需要有效 Key，属本机实测项。

文档改动检查相对链接、术语、权限、Scope 与隐私，不触发模型或真实任务。纯逻辑测试优先隔离 GitHub／Harness；实际 CLI 验证只使用明确授权的测试会话，GitHub 端到端测试另使用授权的测试仓库。第一条端到端链路通过后，再验证第二台电脑不会重复领取同一任务。

结果记录命令、环境、验证版本、通过／失败／跳过及未覆盖范围。没有运行就写未运行，不预填 pass 数量。进程是否成功启动、模型是否成功回答、原会话是否正确续接、输出是否可读取分别给证据，不把某一层成功等同于开发任务验收完成。

PR Review 通过现有已授权的审查方式完成；尚未配置 Codex 或无法读取其结果时明确标注。不要为此擅自添加 Workflow、Secrets 或调整仓库权限。独立 Review 不等于本机实测。
