# Node 运行时范围核验

Date: 2026-10-02（Asia/Shanghai）
Keywords: Node.js, engines, version guard, LTS, compatibility, Issue #71
Status: VERIFIED（仅限下面记录的源码、测试与元数据范围）

## 调查问题

是否有当前证据要求 Runner 只接受 Node 24.x，而不是以 Node 24 为最低门槛？相关 [Issue #71](https://github.com/cnjimmyshao/fjzx.gh-dev-runner/issues/71)；原规则来自 [#43](https://github.com/cnjimmyshao/fjzx.gh-dev-runner/issues/43)／[PR #44](https://github.com/cnjimmyshao/fjzx.gh-dev-runner/pull/44)。本报告提供证据，不自行批准新 Contract。

## Environment

- macOS / arm64；隔离源码副本，main `60113e7766c71a9d48575b76d8b668fd1ceb1068`。
- 本机已有 Node v24.16.0 与 v26.8.1；未安装、升级或切换部署运行时。
- Runner 零运行时依赖；本机已有 `@deepseek-ai/dsh` 0.2.0-rc.2。本次不启动真实 Harness，不读取或修改真实部署配置、凭据、session 或 Runner state。
- 测试进程的 `PATH` 选用可用 Git；没有修改机器的持久化 `PATH`。

## Evidence

在同一源码副本分别以两版本执行 `node --test`（`npm test` 的实际脚本）。测试使用隔离目录、GitHub／Harness 替身及真实 Git worktree，不触发真实 GitHub 任务。

源码检查：`package.json`／`package-lock.json` 的 `engines.node` 是 `24.x`；`src/config.js` 的 `checkEnvironment` 明确要求主版本等于 24；`test/end-to-end.test.js` 与 `test/index.test.js` 存在对应非 24 skip。因此 Node 26 的入口／E2E 未执行由现有门槛直接造成，不能据此推断底层运行时不兼容。

元数据检查：本机 `dsh` 0.2.0-rc.2 的 `package.json` 没有 `engines` 声明。没有声明不是兼容证明，也不代表其全部依赖或 native 模块已在 Node 26 通过真实执行。

[Node.js 官方发布说明](https://nodejs.org/en/about/previous-releases)建议生产应用使用 Active LTS／Maintenance LTS。这里据此建议受支持 LTS，不把「数字大于 24」等同于适合生产部署。

## Results

| Node | tests | pass | fail | skipped | 能证明的范围 |
| --- | ---: | ---: | ---: | ---: | --- |
| 24.16.0 | 113 | 113 | 0 | 0 | 当前完整单元／集成／替身 E2E 套件通过 |
| 26.8.1 | 113 | 108 | 0 | 5 | 其余用例通过；1 个 E2E 与 4 个入口用例未执行 |

真实 Node 24 Runner／Harness 的受控闭环另见 [#66 收尾证据](https://github.com/cnjimmyshao/fjzx.gh-dev-runner/issues/66#issuecomment-5943382231)。需区分两次 Git 故障：[D2 控制评论](https://github.com/cnjimmyshao/fjzx.gh-dev-runner/issues/66#issuecomment-5936380569)记录更早的 Runner worktree 准备失败，随后以 `GIT_BIN` 固定可用 Git；D2 实际 spawn 后，同 session 的本机持久化记录又显示 Dev 首条 Git 调用命中不可用 Git（`Bad CPU type in executable`，退出 126），这才是 Harness 继承 `PATH` 的边界。两次都发生在 Node 24 下，不能转记为 Node 26 缺陷，也不能把后续 exit 130 全部归因于 Git。

## Conclusion

本次未发现实际证据要求永久保留 `24.x` 上限。维护者提出的最低 24／允许 `>=24` 方向可作为候选规则提交 Review，但当前测试结果**尚不能证明**本版本栈在 Node 26 的完整入口、真实 Harness START／RESUME、JSONL 与退出状态通过。

未覆盖：移除版本门槛后的 Node 26 完整测试；本机当前 Harness 在 Node 26 的真实 START／RESUME；其他 Node 主版本、平台、多机或真实并发；未来主版本兼容性。

## Contract Impact

#71 的 documentation-only PR 将最低门槛与已验证矩阵分开，规则修订随该 PR 合并生效。本文核验时文档 PR 尚未合并，main 的有效规则与实现仍为 Node 24.x；合并后须另交付 Implementation PR 和兼容验证，不能把文档合并当作完成实现。最终验证完成前 #71 保持开放。
