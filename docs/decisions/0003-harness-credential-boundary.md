# Harness 凭据与 Runner 配置职责分离

Status: ACCEPTED  
Date: 2026-09-29  
Supersedes: [ADR 0002](0002-headless-cli-execution.md) 中由接单工具保存模型 Key / 模型凭据的责任

依据：[Issue #20](https://github.com/cnjimmyshao/fjzx.gh-dev-runner/issues/20)。

## 决定

Runner 不建立第二份模型凭据存储。DeepSeek 模型凭据归 Harness 当前实际版本支持的配置／凭据机制及其 `DSH_HOME` 边界管理；Runner 的 `.env` 只保存 Runner 自身的人工部署配置。

GitHub 认证同样不由 Runner 保存或转发 token。Runner 与 Harness 复用执行账户已经认证的本机 `gh` 配置；Runner 启动前检查 `gh auth status`，不向 Harness 注入 `GH_TOKEN` / `GITHUB_TOKEN`。

Runner 启动 Harness 时只传递正常启动所需的最小系统环境、明确允许的变量及可选 `DSH_HOME` 覆盖，不把完整 `process.env` 当作 Harness 配置面。

## 边界

本 ADR 只替代 ADR 0002 中“谁保存／提供模型凭据”的责任划分，不改变 ADR 0002 选择 headless CLI、放弃 Web 接入依赖等其它历史决定。

若实际 Harness 版本只能通过子进程环境取得某项凭据，Runner 可以把明确 allowlist 中的对应环境变量从父进程**原样透传**给 Harness 子进程；Runner 不解析其值、不记录、不持久化，也不把它转换成 Runner 自己的配置字段。这种受控透传不使 Runner 成为凭据管理者或第二个凭据存储。
