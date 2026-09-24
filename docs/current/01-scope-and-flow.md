# 范围与工作链路

## 定位与部署

一个独立的本地接单工具，不属于任何被接入业务项目的业务代码。每台执行电脑安装同一程序，配置自己的机器标识、允许的仓库与发起人、项目目录及 Harness CLI 运行与持久化配置。只处理显式接入的仓库，不自动扫描并启动所有未完成 Issue。

首版接 DeepSeek Harness，不预建多模型适配。不同电脑可承担不同项目，但不承诺任意操作系统和工具链已经兼容；支持矩阵由实际验证逐步形成。

## 职责

接单工具通过本机 `gh` 增量读取 GitHub Issue Body 与后续评论、检查授权并识别本机 Runner 命令、定位任务会话、启动或续接 Harness CLI，并管理必要的本机控制状态。Runner 只负责确认是否把 Dev 正确叫起、维持任务绑定与单写入者边界；GitHub 上只做最小接单／启动失败反馈，完整进程状态与运行轨迹保留在本机。它不分析业务需求、不裁决 Finding、不代替维护者作决定，也不建设第二套提交、测试和 Review 编排系统。

模型调用、Agent 循环与工具执行由 Harness 负责。Dev 在目标项目会话中读取该项目的 Issue、AGENTS、Current 和最新决定，按任务要求研究、编码、测试、提交 PR 或提问，并自行把工作结果和待决问题 POST 回目标 Issue / PR。目标项目需要的开发环境仍由该执行电脑提供。

## 任务入口

本地按配置周期检查已接入仓库的新增内容，不用 Actions 定时扫描，也不为每次空检查调用模型。读取增量而非反复重读全部 Issue；初次启动不把历史命令全部重放。

每台 Runner 在本机配置自己的 `runnerName`。V1 一个 Issue 的当前 task binding 只归一个 Runner，不让多台机器同时处理同一 Issue；换 Runner 必须由维护者明确迁移绑定。新建 Issue 时只检查一次授权主体的初始 Body；进入评论阶段后，只在该 Issue **没有正在运行的 Harness** 时检查当前最新一条 eligible control comment，也就是“授权主体发布且不是 Runner 自动反馈”的普通评论。所有 Runner 自动反馈统一以保留前缀 `BOT:<runnerName>` 开头并从候选中排除。候选正文 trim 后只有以 `@<runnerName>` 结尾，才表示请求该机器现在开始或继续工作。运行中的 Issue 直接跳过，不读取它的新评论、不推进它的触发水位；当前 Harness 结束后，下一次轮询才重新读取当时的最新评论。完整规则见 [Runner 激活与任务触发 Contract](03-runner-trigger.md)。

示意链路（尚未实现）：

```text
新建 Issue：检查一次授权主体的初始 Body
已有评论：只检查当前最新 eligible control comment
且当前候选 trim 后以 @<runnerName> 结尾
→ 对应电脑通过 gh 识别执行请求
→ 按仓库身份 + Issue 编号定位工作目录和绑定
→ 首次：START，新建并记录 Harness session
→ 后续：RESUME，在相同任务绑定下续接原工作目录 / session
→ Runner 成功进入 session 后回复“Runner 名 + Session ID”
→ Dev 按目标项目规则工作并自己 POST 结果／问题／PR
→ Runner 本机记录启动、运行、结束与异常轨迹
```

同一任务同一时刻只允许一个 Harness 写入者。某个 Issue 已有 Harness 处于 starting / running / unknown 时，Runner 对这个 Issue 只做“正在运行，跳过”的判断，不再读取或解释该 Issue 的 GitHub 新内容，也不推进其评论水位；这不会阻塞 Runner 继续轮询和处理其他 Issue / 其他仓库。该 Harness 明确结束并释放任务级运行状态后，下一次轮询再从原水位出发读取该 Issue 当时最新的 eligible control comment：最新回复以 `@<runnerName>` 结尾则 RESUME 原 task / workspace / session；否则只推进水位，不启动 Harness。运行期间出现的中间旧评论不排队、不补执行。具体机器级／仓库级容量与领取规则由调度 Contract 负责。多台电脑的 Runner 名称由部署者保持唯一，不建设分布式选主。

## 会话与工作目录

默认一条任务（仓库身份 + Issue 编号）绑定一个 Harness 开发会话，同时关联执行机、工作目录、分支及已有 PR。不能只按 Issue 数字寻址，也不为每条 Finding 新建会话。

不同任务使用独立目录或 worktree，保护未提交工作；已有 PR 的任务继续原分支，不另开重复 PR。绑定、目录或会话不明确时报告，不凭会话标题猜测，不悄悄从头开发。

接单工具直接启动本机 Harness headless CLI，不连接或启动 `dsh web`。每次调用是一个执行进程；进程退出不删除任务绑定，后续以已保存的会话标识、相同工作目录和匹配的持久化／profile 配置继续。首次取得标识、续接条件与失败信号已通过一次性本机 CLI 验证确认（见 [CLI 验证报告](../research/2026-09-23-local-harness-cli-first-run-and-resume.md)）；当已装版本自身没有会话身份选项时，用该版本支持的 profile 组合挂本地 runner 补齐，命令仍保持「启动器 + headless profile」。不得将发现历史文件或仅收到启动回执当作正确续接的证据。

重启后应保留必要的内容处理进度和任务绑定，正常重试不重复启动。不承诺跨进程崩溃的端到端 exactly-once；执行是否已经发生不确定时明确报告并核对，不盲目重跑或新建会话。

会话丢失、上下文压缩失败或环境不兼容时保留已有工作并报告。首版不实现自动换会话、迁移会话或无限修复；需要换会话／换机时由维护者确认后记录新绑定。不自动接管已有 Web 会话。

## 凭据与本机调用

GitHub 通信复用实际运行账户已授权的 `gh`；安装 CLI 不等于该账户已登录或具备目标仓库权限。不通过浏览器操作 GitHub，不另建 GitHub 登录系统。

部署者在本机配置并保存 DeepSeek 模型 API Key，通过 Harness 支持的凭据配置或子进程环境提供给它。具体存储与加载方式由实际版本验证后落实。Key 不进入仓库、Issue、任务正文、可见命令行实参或日志；本机凭据文件使用适当受限的访问权限，密钥失效时明确提示，不自行轮换或绕过认证。

首版不实现 Web 启动 URL/cookie 引导、Web API 调用、令牌抓取或 Harness 认证改造。取消的是本机 Web 接入依赖，Harness 调用模型服务仍需要网络与有效模型凭据。

## 权限与可见状态

本机配置和凭证不入库，授权至少绑定仓库、发起人和目标 Runner。GitHub 内容是外部输入，不得拼成 shell 命令；启动受信任的 CLI 并将任务作为数据传递。其他权限和沙箱使用已有工具能力，不为内部约定重复制造防御框架。

Runner 的 GitHub 回写只覆盖自己的控制责任：合法的授权初始 Body 或当前 eligible control comment 触发成功启动或续接 Harness，并进入对应 session 后，以 `BOT:<runnerName>` 开头回复一次“Runner 名 + Session ID”；如果 Harness 根本无法正常启动或续接，导致 Dev 没有进入可工作的 session，则同样以 `BOT:<runnerName>` 开头留一条简短失败回复。普通讨论、Dev 回报以及不以本机 `@<runnerName>` 结尾的回复不是执行请求，不因“有新评论”本身触发 Runner。

Harness 正常退出后，Runner **不**自动写 `completed`、执行结束、开发完成或模型回答摘要，也不把 stdout、exit code、`status.kind` 转述成业务结果。Runner 在本机保存完整运行追踪，包括触发来源、START/RESUME、session、启动/结束时间、运行时长、进程/退出状态、异常摘要及必要恢复信息；这些技术状态用于去重、释放执行状态、正确续接和故障诊断，不等于需要公开到 GitHub。业务完成、测试结果、PR、Review 修复与待维护者决定的问题，由 Dev 在 Harness 会话中按目标项目规则直接处理。

问题归档到任务所属 Issue，不能把私有任务内容转贴到本公开工具仓库。保留必要本机日志，不默认把完整模型输出公开。GitHub 上的“已开始工作”只表示 Runner 已成功启动正确的 Harness 调用，不表示 Dev 已完成任务。

## 首版不做

不搬运旧 Workflow；不建设自动 Review 裁判、自动 merge／部署、中央数据库、跨机抢单、负载均衡、自动接管现有会话、新 Web 管理界面或复杂故障恢复。已有 Codex Review 和人工决策方式保留；如何自动衔接 Review 信号不属于本次基础接单范围。
