# Node 24／26 实现与兼容验证

Date: 2026-10-02（Asia/Shanghai）
Keywords: Node.js, engines, version guard, Node 24, Node 26, Harness, START, RESUME, JSONL, Issue #71
Status: VERIFIED（仅限下面记录的源码、测试、运行时与 Harness 版本范围）

## 调查问题

在 [Issue #71](https://github.com/cnjimmyshao/fjzx.gh-dev-runner/issues/71) 的规则修订（最低 Node 24、`engines`／启动校验允许 `>=24`、推荐受支持 LTS，见 [Current](../current/README.md#node-运行范围)）合并后，实现是否已与规则一致，Node 26 的完整入口／E2E 与真实 Harness START／RESUME、JSONL 和退出状态是否有可核对证据？本报告提供该实现 PR 的验证证据，不自行改变 Contract。

## Environment

- macOS / arm64；实现基线为 main `56490eae78a4c839d96a42597e6bac86bcd3567f`（[PR #76](https://github.com/cnjimmyshao/fjzx.gh-dev-runner/pull/76) 合并后的 main）。
- Node：v24.16.0（`/usr/local/bin/node`）与 v26.8.1（`/opt/homebrew/bin/node`）；两者均为本机既有 arm64 运行时。未安装、升级或切换部署运行时。
- Harness：本机既有 `@deepseek-ai/dsh` 0.2.0-rc.2（`--version` 实测）。Runner 零运行时依赖。
- 未启动 Runner 的真实 GitHub 领取，未消费任何真实控制评论；Harness 验证在隔离 `DSH_HOME` 与隔离临时工作目录中进行。
- 测试进程的 `PATH` 选用可用 Git；没有修改机器的持久化 `PATH`。

## Evidence

### 实现与静态检查

- `package.json` 与 `package-lock.json` 的 `engines.node` 为 `>=24`（新增单元测试断言二者与启动校验一致）。
- `src/config.js` 的 `checkEnvironment` 以主版本判断，低于 24 才拒绝；`>=24` 不再仅因主版本高于 24 拒绝。
- `test/config.test.js`、`test/index.test.js`、`test/end-to-end.test.js` 中按 `process.versions.node` 跳过的 5 个用例已移除，只在缺少可用 Git 时跳过 worktree 用例。

### 完整测试

在同一源码副本分别以 Node 24.16.0 与 Node 26.8.1 执行完整 `npm test`（`node --test`）：

| Node | tests | pass | fail | skipped |
| --- | ---: | ---: | ---: | ---: |
| 24.16.0 | 117 | 117 | 0 | 0 |
| 26.8.1 | 117 | 117 | 0 | 0 |

### 真实 CLI 的版本校验

用只包含 Node 版本校验、后续 `sourceDir` 故意缺失的配置分别以 Node 24.16.0／26.8.1 运行 `node src/index.js --env <path> --once`：两版本都越过版本校验，随后以 `repositories[].sourceDir 不存在或不是目录` 正常拒绝，说明真实入口同样接受两个版本，而不是只在注入 `nodeVersion` 的单测里成立。

### 真实 Harness START／RESUME

为绕过本次执行沙箱对 workspace 之外的写入限制，使用隔离且可写的 `DSH_HOME`：复制 headless profile 的小型配置、按其既有机制提供本机凭据，并以隔离临时目录作为工作目录；不启动 Runner、不接触 GitHub。命令形态与 Runner 产品路径一致：

```text
<node> <dsh>/lib/bin.js --profile headless --json [--session-id <id>]
```

任务正文经 stdin 传入，内容为要求记住一个数字并只回复的短提示；第二轮引用第一轮的数字。

| Node | 轮次 | exit | sessionId | cwd | JSONL 事件序列 |
| --- | --- | ---: | --- | --- | --- |
| 24.16.0 | START | 0 | `session-246fb5ad-2b3b-4ecd-99d6-09c0c1596710` | 隔离工作目录 | `session,status,status,thinking,text,status,status,final` |
| 24.16.0 | RESUME | 0 | 同上（一致） | 同上（一致） | `session,status,status,thinking,text,status,status,final` |
| 26.8.1 | START | 0 | `session-d7a7f708-2215-4ea9-b117-209f68e8a81c` | 隔离工作目录 | `session,status,status,thinking,text,status,status,final` |
| 26.8.1 | RESUME | 0 | 同上（一致） | 同上（一致） | `session,status,status,thinking,text,status,status,final` |

两版本的 RESUME 都在第二轮复述出第一轮要求记住的数字，证明是同一条持久化 session 的续接，而不是新建会话；两轮 stderr 均为 0 字节。

环境说明：直接以本机真实 `~/.dsh` 启动 headless 时，Harness 需要重写 `<DSH_HOME>/profiles/headless/cordis.yml`，而本次执行沙箱（workspace-write）拒绝该 workspace 之外的写入，`--help` 即报 `EPERM`。改用隔离可写 `DSH_HOME` 后正常。这是执行沙箱限制，不是 Node 或 Harness 兼容缺陷；它同时说明 `DSH_HOME` 需要位于 Harness 可写的位置。

## Results

- Node 24.16.0 与 Node 26.8.1 下完整测试套件均 117/117 通过，0 skip。
- 真实 CLI 在 Node 24／26 下都通过版本校验。
- 真实 Harness（0.2.0-rc.2 headless）在 Node 24／26 下的 START 与同 session RESUME 均 exit 0，JSONL 结构一致，sessionId／cwd 一致，且可确认会话续接。

## Conclusion

本实现范围内，`engines`、启动校验与测试不再把 Node 26 排除，Node 26 的完整入口／E2E 与真实 Harness START／RESUME 均有在册通过证据。**版本放行与实际验证仍分开**：`>=24` 只是最低门槛，不等于所有未来主版本、平台或外部 Harness 已验收。

未覆盖：

- 低于 24 的真实运行时拒绝只用注入 `nodeVersion` 的单元测试覆盖；本机未安装 <24 的 Node，也未安装／切换运行时。
- 真实 Harness 验证只覆盖单机、`@deepseek-ai/dsh` 0.2.0-rc.2、headless profile 与隔离 `DSH_HOME`；未覆盖完整 Runner → GitHub → Harness 真实轮次、其他 Node 主版本、其他平台或多机。
- 未覆盖 Runner 在 Node 26 下以真实 GitHub 控制评论完成一次接单闭环；本报告的 GitHub 边界仍是替身测试。

## Contract Impact

无新增规则：本文记录 #71 已合并规则（最低 Node 24、`engines`／启动校验 `>=24`）的实现与兼容验证。规则生效、代码实现与兼容验收三种状态分别见 [Current](../current/README.md#node-运行范围)、实现 PR 与本文；#71 在实现与验证经 Review／合并前保持开放。
