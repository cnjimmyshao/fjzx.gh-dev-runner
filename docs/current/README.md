# 当前需求基线

Current Version: 未编号（版本编号由维护者决定）

**状态：目标 Contract 已调整为 headless CLI；本机 CLI 首轮执行与同会话续接已实测通过，接单功能尚未实现。** 此处不是安装指南或上线声明；本机验证只对报告记录的版本、环境与命令成立。

- [范围与工作链路](01-scope-and-flow.md)
- [Runner → Dev 唤醒消息协议](02-dev-invocation-protocol.md)
- [本机配置与状态 Schema](02-local-state.md)
- [Runner 激活与任务触发](03-runner-trigger.md)
- [开发环境与验证结果](../development.md)
- [架构取舍](../decisions/README.md)

已确认方向是轻量、本地增量检查、多个项目和多台电脑独立配置。GitHub 通信复用本机 `gh`；执行侧使用本机模型 Key 直接启动 Harness headless CLI，按任务记录和续接持久化会话，过程通过终端／本机日志观察。首版不再依赖常驻 Web 服务、cookie 引导或原 Web 界面。

变更依据与代价见 [ADR 0002](../decisions/0002-headless-cli-execution.md)。原 Web Research 仍保留其时间点证据，不因运行方向改变而改写为 CLI 已验证。具体 CLI、凭据加载、续接和输出行为必须在实际安装版本上验证，不能从上游最新文档推断本机可用；实测记录见 [CLI 验证报告](../research/2026-09-23-local-harness-cli-first-run-and-resume.md)。

本机状态必须持久化任务绑定、内容去重和活跃 Harness 技术运行态，使 Runner 重启后仍能恢复单写入者与并发占用判断；具体见 [本机配置与状态 Schema](02-local-state.md)。

首版 Runner 的用户可见触发语义已经在 [Runner 激活与任务触发 Contract](03-runner-trigger.md) 中确定：每台机器配置自己的 `runnerName`；新建 Issue Body 或后续**每一条新评论**都独立判断，只有该内容 trim 后以 `@<runnerName>` 结尾才表示现在开始／继续工作。普通回复本身不触发；同一 Issue 可在后续新回复末尾再次写 `@<runnerName>` 来 RESUME 原任务。不再使用 `runner:<machineId>` + `@dev` 两层触发。本机持久化的稳定语义见 [本机配置与状态 Schema](02-local-state.md)；具体配置文件路径、JSON 内部字段与实现细节由后续 Implementation PR 在该 Contract 内收敛。除影响业务边界的事项外，普通实现取舍由实现者完成，不为每个内部字段增加人工审批。
