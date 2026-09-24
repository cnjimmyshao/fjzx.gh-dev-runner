# 当前需求基线

Current Version: 未编号（版本编号由维护者决定）

**状态：目标 Contract 是 Harness 官方 headless CLI。** 接单程序已在 [Issue #9](https://github.com/cnjimmyshao/fjzx.gh-dev-runner/issues/9) 中实现于 `src/`，并由 [Issue #19](https://github.com/cnjimmyshao/fjzx.gh-dev-runner/issues/19) 收缩为直接使用官方 `--json` / `--session-id`；真实 GitHub 评论与升级后真实 Harness 的端到端接单尚未验证。0.1.5-rc.2 的自定义续接实验仍是历史实测，不代表当前官方路径已经在执行电脑通过。此处不是安装指南或上线声明。

- [范围与工作链路](01-scope-and-flow.md)
- [开发环境与验证结果](../development.md)
- [架构取舍](../decisions/README.md)

已确认方向是轻量、本地增量检查、多个项目和多台电脑独立配置。GitHub 通信复用本机 `gh`；执行侧使用本机模型 Key 直接启动 Harness 官方 headless CLI：首轮以 `--json` 取得真实 sessionId，后续在原工作目录用 `--session-id` 续接。接单工具不重写 Harness Session/Agent 层，也不长期维护旧版兼容 runner。过程通过终端／本机日志观察；首版不依赖常驻 Web 服务、cookie 引导或原 Web 界面。

变更依据与代价见 [ADR 0002](../decisions/0002-headless-cli-execution.md)。原 Web Research 仍保留其时间点证据，不因运行方向改变而改写为 CLI 已验证。具体 CLI、凭据加载、续接和输出行为必须在实际安装版本上验证，不能从上游最新文档推断本机可用；实测记录见 [CLI 验证报告](../research/2026-09-23-local-harness-cli-first-run-and-resume.md)。

评论命令与执行机标签的精确语法、标签 `runner:<machineId>` 的格式已由 [Issue #9](https://github.com/cnjimmyshao/fjzx.gh-dev-runner/issues/9) 确认并写入[范围与工作链路](01-scope-and-flow.md)；运行与配置字段见[接单工具说明](../../src/README.md)，存储格式与文件组织仍属实现细节。除影响业务边界的事项外，普通实现取舍由实现者完成，不为每个配置字段增加人工审批。
