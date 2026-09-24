# Research

保存带日期、版本与环境的外部事实和实验记录。源码／文档检查与本机运行证据必须区分；“最新版有接口”不等于当前安装环境已支持。

命名：`YYYY-MM-DD-<topic>.md`。每份报告写明 Date、Keywords、Status、调查问题、Environment、Evidence、Results、Conclusion、Contract Impact；相关时标注 Supersedes／Superseded By。小验证可以简短，但要让后来人脱离聊天也能理解步骤、结果和限制。

`OPEN` 表示证据尚不足；`VERIFIED` 仅对报告明确的时间、版本、环境和证据范围成立；后续推翻时使用 `PARTIALLY_SUPERSEDED` 或 `SUPERSEDED` 并链接新报告。后续只是增加支持证据，不应误标为推翻。

保留旧调查，不因变旧而移到 Archive。可补纠错和替代链接，不覆盖当时记录；新事实改变目标行为需要维护者决定并同步 Current，Research 不直接成为新需求。

本仓库公开：不附凭证、完整私有代码、真实会话日志或用户数据。保留可复现的脱敏步骤、证据摘录与限制；原始材料如需私下核验，明确其保留位置的性质而不暴露敏感路径。

报告：

- [本机 Harness CLI 首轮执行与同会话续接验证](2026-09-23-local-harness-cli-first-run-and-resume.md)：本机 0.1.5-rc.2 的 headless 单轮执行可用，但该版本自身无 `--session-id` / `--json`；用 profile patch 挂本地 runner 后已实测跨进程续接，脚本在 `scripts/headless-session/`。
- [START 阶段 sessionId 的创建与可见时点实测](2026-09-24-start-sessionid-visibility.md)：会话在进程启动后约 1.5–1.7s（热 profile）创建；本地 runner 只在整轮结束的最终结果里交付 `sessionId`，官方 headless 在本机 0.1.5-rc.2 完全不给，两者之间存在真实的「已创建但调用方不可见」窗口。

原 Web 接入实验未并入本分支，其报告留在 [PR #4](https://github.com/cnjimmyshao/fjzx.gh-dev-runner/pull/4) 与 Issue #3 供追溯，保留其时间点证据，不作为 CLI 已验证的依据。

当前执行方向为 Harness headless CLI；首轮执行、进程退出后同会话续接及输出／失败信号的本机实测结果见上述 CLI 报告，见 [开发说明](../development.md)。既有 Web 接入实验不能视为 CLI 已验证；不同接入方式的报告分别记录，不因方案调整而抹去原实验。

可复现探针放在 `probes/`：独立于接单工具运行代码，仅供 Research 复现。
