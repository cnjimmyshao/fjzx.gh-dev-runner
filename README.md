# fjzx.gh-dev-runner

轻量、可部署在不同执行电脑上的 GitHub Issue 接单与 DeepSeek Harness 会话续接工具。

**当前阶段：已确定 headless CLI 方向，尚无可运行的接单程序；本机 0.1.5-rc.2 的首轮执行与同会话续接已实测通过（见 `scripts/headless-session/`），接单闭环仍待实现。** 示例命令不是已上线功能；本工具尚未部署或接管真实开发任务。

## 目标

一个本地接单程序服务多个明确接入的仓库。它通过本机 GitHub CLI（`gh`）增量检查授权人的 Issue Body / 后续新评论；每台电脑配置自己的 `runnerName`，每个新内容事件的正文 trim 后以 `@<runnerName>` 结尾时，才表示请求该电脑现在开始或继续工作。Runner 在对应工作目录直接启动 Harness headless CLI；首次执行记录会话标识，后续启动新进程续接同一持久化会话，不每次从头开发。

Runner 与 Harness 都复用执行机上同一运行账户已经完成认证的本机 GitHub CLI（`gh`）。Runner 启动时先执行 `gh auth status`；检查失败则启动失败、不进入轮询。Runner 不向 Harness 注入或转发 `GH_TOKEN` / `GITHUB_TOKEN`，Harness 在能够访问同一本机 `gh` 认证配置的执行用户／环境中直接调用 `gh`。

DeepSeek 模型凭据由 Harness 自己的受支持配置管理；Runner 只负责定位并启动指定的 Harness 环境，不把自己的整套配置当成 Harness 配置。实际需求分析、编码、测试与 PR 交付由 Dev 遵循目标项目的文档完成。Runner 只负责把正确的 Dev 叫起来并维护本机任务状态：合法执行请求成功启动或续接 Harness、进入对应 session 并取得 sessionId 后，只在目标 Issue 回复一次“Runner 名 + Session ID”；正常结束不代写开发结果，业务问题、PR 与交接由 Dev 自己处理。

首版不依赖 Harness Web 服务、浏览器 cookie 或原网页实时观看，不依赖 GitHub Actions 定时轮询，不建设新的审查系统、中央调度平台或管理界面。已确认的取舍见 [ADR 0002](docs/decisions/0002-headless-cli-execution.md)。

## 从哪里开始

- [AGENTS.md](AGENTS.md)：角色、权限、开发与 Review 方法、决策交接。
- [文档导航](docs/README.md)：Current、ADR、Research 与 Archive 的分工。
- [当前需求](docs/current/README.md)：已确认目标、边界与尚未落实的部分。
- [Runner 激活与任务触发](docs/current/03-runner-trigger.md)：V1 的 `runnerName` 与 `@<runnerName>` 结尾触发 Contract。
- [开发环境与验证](docs/development.md)：本机 CLI 验证结果与最小实现前的口径。
- [CLI 本机验证报告](docs/research/2026-09-23-local-harness-cli-first-run-and-resume.md)：实际版本、实测结果与遗留取舍。
- [headless 会话调用与续接](scripts/headless-session/README.md)：本机实测通过的调用／续接脚本及其边界。

开发入口是关联 Issue。Issue 保存问题与决定，PR 交付变更；读取仓库规则后按任务执行，不依赖聊天里另发一份长提示词。当前没有 package.json、安装脚本或本工具的运行命令；外部 Review 集成是否已启用需另行核验，不能据此声称环境已就绪。

## 公开仓库与本机数据

示例仅使用占位信息。真实 `.env`、凭证、真实仓库接入清单、机器路径、任务绑定、会话历史与原始日志留在本机，不上传到本仓库或公开评论。`.env.example` 只描述 Runner 的部署配置；Runner 自动维护的状态放在 `.local/`；Harness 自己的凭据、profile、session 与其他持久化数据放在独立 `DSH_HOME`。GitHub 登录状态由本机 `gh` 自己管理，不把 `GH_TOKEN` / `GITHUB_TOKEN` 复制进 Runner `.env` 再转交 Harness。模型 Key 不写入任务正文、可见命令行实参或日志。凭据存储仍需适当的本机访问权限，`.gitignore` 不替代提交前的内容检查。

## Runner 与 Dev 的反馈边界

Runner 不是 Harness 结果转述器。它需要在本机知道 Harness 是否成功启动、当前 session、工作目录、是否仍在运行以及必要退出状态，以便去重、释放执行状态和正确续接；这些技术状态默认留在本机。

GitHub 上由 Runner 反馈的只是自己的控制结果：合法执行请求成功启动或续接 Harness、进入对应 session 并取得 sessionId 后，回复一次“Runner 名 + Session ID”；如果 Harness 根本无法正常启动或续接、Dev 未进入可工作的 session，则在原 Issue 留一条简短失败回复。正常执行过程中和 Harness 正常结束后不额外刷状态，也不自动发布 `completed`、exit code、模型回答或“开发完成”。业务完成与否继续由 Dev 的代码、测试、PR、Review 和 Issue 交接体现。详见 [Current](docs/current/01-scope-and-flow.md)、[Runner Trigger Contract](docs/current/03-runner-trigger.md) 与 [Issue #11](https://github.com/cnjimmyshao/fjzx.gh-dev-runner/issues/11)。
