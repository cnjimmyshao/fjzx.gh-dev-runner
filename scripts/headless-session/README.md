# 0.1.5-rc.2 headless 会话兼容实验（历史）

本目录对应 [Issue #7 的 CLI Research](../../docs/research/2026-09-23-local-harness-cli-first-run-and-resume.md)。
当时本机安装的 `@deepseek-ai/dsh 0.1.5-rc.2` 的 headless CLI 没有
`--session-id` / `--json`，因此曾通过 profile composition 临时挂一个本地 runner，
验证“跨进程继续同一持久化 Session”是否可行。

该实验已经完成并保留在 Git 历史和 Research 报告里；它证明的是**当时版本与当时方案**，
不是当前产品运行 Contract。

## 当前状态

[Issue #19](https://github.com/cnjimmyshao/fjzx.gh-dev-runner/issues/19) 已决定产品直接使用
Harness 官方 headless 能力：

- 首轮：`--json`，从 `session` 事件取得真实 sessionId；
- 续接：相同工作目录下使用 `--session-id <id>`；
- 任务正文从 stdin 传入；
- unknown session、cwd / ownership / preset 不匹配由 Harness 官方实现拒绝。

因此历史 `runner.mjs` 与 `overlay.yml` 已从当前 HEAD 删除，接单程序也不再引用
`DSH_TASK`、`DSH_SESSION_ID`、`DSH_RESULT_FILE`、`DSH_BIN` 或 `--patch`。

需要复核旧实验时，请读取关联 Research 和对应 Git 历史；**不要把本目录恢复成生产兼容层**。
若执行电脑仍是 0.1.5-rc.2，应由维护者明确授权升级到具备官方 headless Contract 的版本，
然后按 `docs/development.md` 重新做本机验证。本仓库不会自动升级正在工作的 Harness。
