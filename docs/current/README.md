# 当前需求基线

Current Version: 未编号（版本编号由维护者决定）

**状态：目标 Contract 已调整为 headless CLI；本机 CLI 首轮执行与同会话续接已实测通过，接单功能尚未实现。** 此处不是安装指南或上线声明；本机验证只对报告记录的版本、环境与命令成立。

- [范围与工作链路](01-scope-and-flow.md)
- [Runner → Dev 唤醒消息协议](02-dev-invocation-protocol.md)
- [Runner 激活与任务触发](03-runner-trigger.md)
- [开发环境与验证结果](../development.md)
- [架构取舍](../decisions/README.md)

已确认方向是轻量、本地增量检查、多个项目和多台电脑独立配置。GitHub 通信复用本机 `gh`；执行侧使用本机模型 Key 直接启动 Harness headless CLI，按任务记录和续接持久化会话，过程通过终端／本机日志观察。首版不再依赖常驻 Web 服务、cookie 引导或原 Web 界面。

变更依据与代价见 [ADR 0002](../decisions/0002-headless-cli-execution.md)。原 Web Research 仍保留其时间点证据，不因运行方向改变而改写为 CLI 已验证。具体 CLI、凭据加载、续接和输出行为必须在实际安装版本上验证，不能从上游最新文档推断本机可用；实测记录见 [CLI 验证报告](../research/2026-09-23-local-harness-cli-first-run-and-resume.md)。

首版 Runner 的用户可见触发语义已经在 [Runner 激活与任务触发 Contract](03-runner-trigger.md) 中确定：每台机器配置自己的 `runnerName`；一个 Issue 的当前 task binding 只归一个 Runner。新建 Issue 时只检查一次授权主体的初始 Body；已有评论后，只在该 Issue 没有正在运行的 Harness 时读取当前最新一条 eligible control comment（授权主体发布、且不是 Runner 自动反馈）。Runner 自动反馈统一以 `BOT:<runnerName>` 开头并排除。运行中的 Issue 直接跳过：不读取新评论、不推进评论水位、不向当前 Harness 注入消息，也不启动第二个写入者；其他 Issue / 其他仓库继续正常轮询。当前 Harness 结束后，下一次轮询才读取该 Issue 当时最新的人类控制意图，决定是否 RESUME。V1 不维护 pending / next-candidate 队列。不再使用 `runner:<machineId>` + `@dev` 两层触发。
