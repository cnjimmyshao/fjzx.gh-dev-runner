# fjzx.gh-dev-runner

轻量、可部署在不同执行电脑上的 GitHub Issue 接单与 DeepSeek Harness 会话续接工具。

**当前阶段：已确定 headless CLI 方向，尚无可运行的接单程序，CLI 本机验证待完成。** 示例命令不是已上线功能；本工具尚未部署或接管真实开发任务。

## 目标

一个本地接单程序服务多个明确接入的仓库。它通过本机 GitHub CLI（`gh`）增量检查授权人的评论命令，按执行电脑路由，在对应工作目录直接启动 Harness headless CLI。首次执行记录会话标识，后续启动新进程续接同一持久化会话，不每次从头开发。

DeepSeek 模型 API Key 在本机配置并保存，由 Harness 用于模型调用；实际需求分析、编码、测试与 PR 交付由 Dev 遵循目标项目的文档完成。过程先通过终端／本机日志观察，结果与问题回到目标 Issue。

首版不依赖 Harness Web 服务、浏览器 cookie 或原网页实时观看，不依赖 GitHub Actions 定时轮询，不建设新的审查系统、中央调度平台或管理界面。已确认的取舍见 [ADR 0002](docs/decisions/0002-headless-cli-execution.md)。

## 从哪里开始

- [AGENTS.md](AGENTS.md)：角色、权限、开发与 Review 方法、决策交接。
- [文档导航](docs/README.md)：Current、ADR、Research 与 Archive 的分工。
- [当前需求](docs/current/README.md)：已确认目标、边界与尚未落实的部分。
- [开发环境与验证](docs/development.md)：先做一次性 CLI 接入验证，再实现最小闭环。

开发入口是关联 Issue。Issue 保存问题与决定，PR 交付变更；读取仓库规则后按任务执行，不依赖聊天里另发一份长提示词。当前没有 package.json、安装脚本或本工具的运行命令；外部 Review 集成是否已启用需另行核验，不能据此声称环境已就绪。

## 公开仓库与本机数据

示例仅使用占位信息。凭证、真实仓库接入清单、机器路径、任务绑定、会话历史与原始日志留在本机，不上传到本仓库或公开评论。模型 Key 不写入任务正文、命令行实参或日志。`.local/` 可用于尚未形成正式配置格式前的本机材料，已加入忽略规则；凭据存储仍需适当的本机访问权限，`.gitignore` 不替代提交前的内容检查。
