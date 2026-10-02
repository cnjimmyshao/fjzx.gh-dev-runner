# 当前需求基线

Current Version: 未编号（版本编号由维护者决定）

**状态（实现进度，不是 Contract 变更）：目标 Contract 已调整为 headless CLI；V1 最小闭环已按 [Issue #48](https://github.com/cnjimmyshao/fjzx.gh-dev-runner/issues/48) 在当前 main 上实现，实际验证范围与未覆盖项见[开发环境与验证](../development.md)。** 此处不是安装指南或上线声明；本机验证只对报告记录的版本、环境与命令成立。

- [范围与工作链路](01-scope-and-flow.md)
- [Runner → Dev 唤醒消息协议](02-dev-invocation-protocol.md)
- [Runner 激活与任务触发](03-runner-trigger.md)
- [本机配置与状态 Schema](04-local-state.md)
- [Harness 并发与轮询调度](05-harness-scheduling.md)
- [Coordinator 协调与交接](06-coordinator-handoff.md)
- [开发环境与验证结果](../development.md)
- [架构取舍](../decisions/README.md)

已确认方向是轻量、本地增量检查、多个项目和多台电脑独立配置。 Runner 的人工部署配置、运行状态与 Harness 持久化分层：`.env` 只保存 Runner 部署入口；`runtime.stateDir`（可配置，`.local/` 仅可作为示例／默认）保存 Runner state / bindings / logs；`DSH_HOME` 保存 Harness credentials / profiles / sessions。GitHub 通信复用执行账户已认证的本机 `gh`，Runner 不向 Harness 转发 `GH_TOKEN` / `GITHUB_TOKEN`。GitHub 通信复用本机 `gh`；执行侧使用本机模型 Key 直接启动 Harness headless CLI，按任务记录和续接持久化会话，过程通过终端／本机日志观察。首版不再依赖常驻 Web 服务、cookie 引导或原 Web 界面。

V1 的程序交付形态已确认：Runner 直接作为标准 Node.js 程序运行，Node.js 是显式运行时依赖。实现建立最小 `package.json`、依赖锁文件以及真实可用的启动／测试命令。当前 Scope 不生成 Windows EXE、macOS／Linux 单文件二进制或安装器，也不引入 Node SEA、pkg、nexe 等打包链路；Git、`gh` 与 Harness CLI 继续作为本机外部依赖，不打入 Runner。若未来多机部署确实需要单文件分发，再通过独立 Issue／决定评估，不阻塞 V1 功能实现。

### Node 运行范围

本节修订由 [Issue #71](https://github.com/cnjimmyshao/fjzx.gh-dev-runner/issues/71) 跟进，**随其独立 documentation-only PR 合并生效**，替代 [Issue #43](https://github.com/cnjimmyshao/fjzx.gh-dev-runner/issues/43)／[PR #44](https://github.com/cnjimmyshao/fjzx.gh-dev-runner/pull/44) 的 `24.x` 上限；未合并分支上的内容不覆盖 main 的有效规则。当前代码、锁文件和启动校验仍只允许 Node 24，后续实现与兼容验收另行交付；文档合并不等于这些工作完成。

- 最低运行时为 **Node.js 24**；`engines.node` 与启动校验的目标范围统一为 **`>=24`**，拒绝低于 24 的主版本，不再仅因主版本高于 24 拒绝启动。
- 正式部署推荐仍受官方支持的 Active LTS／Maintenance LTS，允许该发布线的正常补丁与安全更新；不固定某个 patch，不自动安装、升级或切换执行电脑的 Node。
- **版本放行与实际验证分开。** `>=24` 是最低门槛，不是所有未来主版本、平台或外部 Harness 已验收的保证。每份验证记录具体 Node／Harness 版本、环境、通过／失败／跳过与未覆盖范围；新运行时实际出现不兼容时如实报告，不以版本号推断通过。
- 文档合并后在 #71 继续独立 Implementation PR：同步 package／lock、启动校验和版本测试，使 Node 24／26 的完整入口与 E2E 用例实际执行；在明确授权的隔离会话核验当前 Harness 的 START／RESUME、JSONL 与退出状态。完成前 #71 保持开放。

当前证据与限制见 [Node 运行时范围核验](../research/2026-10-02-node-runtime-range.md)；正式部署的 LTS 建议依据 [Node.js 官方发布说明](https://nodejs.org/en/about/previous-releases)。

Harness 调度采用机器级 + 仓库级两级并发上限；一次 polling cycle 最多新增领取一个 Issue；`runtime.pollSeconds` 默认 300 秒并可配置；容量不足时不扫描／不消费新的触发候选；Runner 重启后无法确认旧 Harness 已退出时保守占槽。具体见 [Harness 并发与轮询调度](05-harness-scheduling.md)。

变更依据与代价见 [ADR 0002](../decisions/0002-headless-cli-execution.md)。原 Web Research 仍保留其时间点证据，不因运行方向改变而改写为 CLI 已验证。具体 CLI、凭据加载、续接和输出行为必须在实际安装版本上验证，不能从上游最新文档推断本机可用；实测记录见 [CLI 验证报告](../research/2026-09-23-local-harness-cli-first-run-and-resume.md)。

首版 Runner 的用户可见触发语义已经在 [Runner 激活与任务触发 Contract](03-runner-trigger.md) 中确定：每台机器配置自己的 `runnerName`；一个 Issue 的当前 task binding 只归一个 Runner。新建 Issue 时只检查一次授权主体的初始 Body；已有评论后，只在该 Issue 没有正在运行的 Harness 时扫描水位之后的新评论，把水位推进到本轮扫描终点，并只选择其中最新一条有效的 `@<runnerName>` 控制评论。Runner 自动反馈统一以 `BOT:<runnerName>` 开头，不触发 Harness，但与未授权评论、普通非命令回复一样都会推进扫描水位。运行中的 Issue 直接跳过：不读取新评论、不推进评论水位、不向当前 Harness 注入消息，也不启动第二个写入者；其他 Issue / 其他仓库继续正常轮询。当前 Harness 结束后，下一次轮询才扫描水位之后的新评论；运行期间的新回复不排队，多条有效控制评论只取最新一条，普通／未授权／`BOT:` 评论不覆盖合法控制评论。不再使用 `runner:<machineId>` + `@dev` 两层触发。

Coordinator 的目标交接语义见 [Coordinator 协调与交接 Contract](06-coordinator-handoff.md)：Implementer 在原业务 Issue 显式写明 return-to Runner，并以 `@COORDINATOR` 交接；Coordinator 自行读取 GitHub 依据并自行回写原 Issue，能够继续时以该 return-to Runner 结尾。该 Contract 不表示 Coordinator / Safari 接入代码已经实现。

Coordinator 通道是 Runner / Implementer“本机 `gh` + 无 Web 接入”规则的限定例外：本机只经 Safari 投递／续接正常 ChatGPT Web conversation，ChatGPT 自己使用已连接的 GitHub connector 读写 GitHub；两端实际写回身份都必须进入目标仓库 `allowedActors`。同一 Issue 的 Coordinator conversation 保持单写入者，运行中不注入第二条请求，结束后只取水位之后最新合法 `@COORDINATOR`。
