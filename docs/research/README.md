# Research

保存带日期、版本与环境的外部事实和实验记录。源码／文档检查与本机运行证据必须区分；“最新版有接口”不等于当前安装环境已支持。

命名：`YYYY-MM-DD-<topic>.md`。每份报告写明 Date、Keywords、Status、调查问题、Environment、Evidence、Results、Conclusion、Contract Impact；相关时标注 Supersedes／Superseded By。小验证可以简短，但要让后来人脱离聊天也能理解步骤、结果和限制。

`OPEN` 表示证据尚不足；`VERIFIED` 仅对报告明确的时间、版本、环境和证据范围成立；后续推翻时使用 `PARTIALLY_SUPERSEDED` 或 `SUPERSEDED` 并链接新报告。后续只是增加支持证据，不应误标为推翻。

保留旧调查，不因变旧而移到 Archive。可补纠错和替代链接，不覆盖当时记录；新事实改变目标行为需要维护者决定并同步 Current，Research 不直接成为新需求。

本仓库公开：不附凭证、完整私有代码、真实会话日志或用户数据。保留可复现的脱敏步骤、证据摘录与限制；原始材料如需私下核验，明确其保留位置的性质而不暴露敏感路径。

当前执行方向为 Harness headless CLI；后续验证首轮执行、进程退出后同会话续接及输出／失败信号，见 [开发说明](../development.md)。既有 Web 接入实验保留其时间点证据，不能视为 CLI 已验证；不同接入方式的报告分别记录，不因方案调整而抹去原实验。
