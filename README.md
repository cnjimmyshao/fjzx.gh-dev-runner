# fjzx.gh-dev-runner

轻量、可部署在不同执行电脑上的 GitHub Issue 接单与 DeepSeek Harness 会话续接工具。

**当前阶段：V1 最小闭环已按 [Issue #48](https://github.com/cnjimmyshao/fjzx.gh-dev-runner/issues/48) 在当前 main 上实现（`src/`，Node.js 24 LTS，`npm start` / `npm test`）。[Issue #66 的受控真实 E2E](docs/research/2026-10-02-github-mbp01-coordinator-e2e.md) 已验证一次 GitHub → MBP01 Runner → 原 DSH session → 外部 dot Coordinator → 一次性 return-to → 同 session RESUME → 正常 `run_end`；这不代表仓库内 Coordinator / Safari 接入、真实 PR Review、多轮／多机运行或完整 Node 26 兼容已经验证。当前证据分层见 [开发环境与验证](docs/development.md)。**

## 目标

一个本地接单程序服务多个明确接入的仓库。每台电脑配置自己的 `runnerName`，一个 Issue 的当前 task binding 只归一个 Runner。Runner 通过本机 GitHub CLI（`gh`）检查当前控制意图：新建 Issue 时只检查一次初始 Body；已有评论后扫描水位之后的新评论，把水位推进到扫描终点，并只选择其中最新一条由授权主体发布、非 `BOT:<runnerName>` 且正文 trim 后以 `@<runnerName>` 结尾的有效控制评论。只有这些条件全部成立，才表示请求该电脑现在开始或继续工作；未授权评论、`BOT:` 反馈和普通非命令回复同样推进扫描水位，旧命令不排队、不补执行。**如果这个 Issue 已经有 Harness 正在运行，Runner 直接跳过这个 Issue：不读取它的新评论、不更新它的评论水位、也不启动第二个 Harness；其他 Issue 和其他仓库仍照常轮询并可在并发上限内运行。** 当前 Harness 退出后，下一次轮询才扫描该 Issue 水位之后的新评论，并只按其中最新一条有效控制评论决定是否续接原 session。Runner 在对应工作目录直接启动 Harness headless CLI；首次执行记录会话标识，后续启动新进程续接同一持久化会话，不每次从头开发。

DeepSeek 模型 API Key 在本机配置并保存，由 Harness 用于模型调用；实际需求分析、编码、测试与 PR 交付由 Dev 遵循目标项目的文档完成。Runner 只负责把正确的 Dev 叫起来并维护本机任务状态：合法执行请求成功启动或续接 Harness、进入对应 session 并取得 sessionId 后，只在目标 Issue 回复一次“Runner 名 + Session ID”；正常结束不代写开发结果，业务问题、PR 与交接由 Dev 自己处理。

首版不依赖 Harness Web 服务、浏览器 cookie 或原网页实时观看，不依赖 GitHub Actions 定时轮询，不建设新的审查系统、中央调度平台或管理界面。已确认的取舍见 [ADR 0002](docs/decisions/0002-headless-cli-execution.md)。

## 从哪里开始

- [AGENTS.md](AGENTS.md)：角色、权限、开发与 Review 方法、决策交接。
- [文档导航](docs/README.md)：Current、ADR、Research 与 Archive 的分工。
- [当前需求](docs/current/README.md)：已确认目标、边界与尚未落实的部分。
- [Runner 激活与任务触发](docs/current/03-runner-trigger.md)：V1 的 `runnerName` 与 `@<runnerName>` 结尾触发 Contract。
- [开发环境与验证](docs/development.md)：运行方式、`.env` 配置、验证分层与本次实际证据。
- [CLI 本机验证报告](docs/research/2026-09-23-local-harness-cli-first-run-and-resume.md)：实际版本、实测结果与遗留取舍。
- [共享 DSH_HOME 并发实测](docs/research/2026-09-29-shared-dsh-home-concurrency.md)：官方 headless 的并发与单 session 单写入证据。
- [真实 GitHub / MBP01 / 外部 Coordinator 受控 E2E](docs/research/2026-10-02-github-mbp01-coordinator-e2e.md)：同 session 续接、一次 return-to、最终 `run_end` 与验收边界。

开发入口是关联 Issue。Issue 保存问题与决定，PR 交付变更；读取仓库规则后按任务执行，不依赖聊天里另发一份长提示词。

```bash
cp .env.example .env     # 填写 RUNNER_NAME / REPOSITORIES_JSON / STATE_DIR / DSH_BIN 等
npm run help             # 显示帮助；等价于 npm start -- --help
npm start                # 常驻轮询
npm run once             # 只跑一轮，并等本轮启动的 Harness 结束
npm test                 # Node 24 下运行全部测试
```

`npm run once` 执行 `node src/index.js --once`。`--wait` 仅为兼容旧命令保留，不会改变运行或等待行为，也不需要与 `--once` 搭配。

其他 CLI 参数通过 npm 的 `--` 透传，例如 `npm run once -- --env <path>`。`npm test`／`npm run test` 运行 Node 测试框架，不是 `index.js` 的子命令。

Runner 直接以 Node.js 24 运行，没有运行时依赖与安装脚本，也不打包成单文件可执行程序；`scripts/headless-session/` 是 0.1.5-rc.2 时期的一次性验证脚本，不是 Runner 的运行路径。外部 Review 集成是否已启用需另行核验，不能据此声称环境已就绪。

## 公开仓库与本机数据

示例仅使用占位信息。凭证、真实仓库接入清单、机器路径、任务绑定、会话历史与原始日志留在本机，不上传到本仓库或公开评论。模型 Key 不写入任务正文、命令行实参或日志。`.local/` 可用于尚未形成正式配置格式前的本机材料，已加入忽略规则；凭据存储仍需适当的本机访问权限，`.gitignore` 不替代提交前的内容检查。

## Runner 与 Dev 的反馈边界

Runner 不是 Harness 结果转述器。它需要在本机知道 Harness 是否成功启动、当前 session、工作目录、是否仍在运行以及必要退出状态，以便去重、释放执行状态和正确续接；这些技术状态默认留在本机。

GitHub 上由 Runner 反馈的只是自己的控制结果：合法执行请求成功启动或续接 Harness、进入对应 session 并取得 sessionId 后，以 `BOT:<runnerName>` 开头回复一次“Runner 名 + Session ID”；如果 Harness 根本无法正常启动或续接、Dev 未进入可工作的 session，则同样以 `BOT:<runnerName>` 开头留一条简短失败回复。一次命令被认领并尝试启动后即消费，失败不自动重试同一候选。正常执行过程中和 Harness 正常结束后不额外刷状态，也不自动发布 `completed`、exit code、模型回答或“开发完成”。业务完成与否继续由 Dev 的代码、测试、PR、Review 和 Issue 交接体现。详见 [Current](docs/current/01-scope-and-flow.md)、[Runner Trigger Contract](docs/current/03-runner-trigger.md) 与 [Issue #11](https://github.com/cnjimmyshao/fjzx.gh-dev-runner/issues/11)。
