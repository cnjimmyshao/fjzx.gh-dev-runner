# headless 会话调用与续接

本机已装 Harness 版本（实测 `@deepseek-ai/dsh` 0.1.5-rc.2）的 headless CLI 只有
`[task...]` 与 `--help`，没有上游更高版本才有的 `--session-id` / `--json`，也不会
续接既有会话。本目录用 profile composition 的公开扩展点补上这一层，不改安装、不
新增服务与端口，也不改用其他界面：

- `runner.mjs`：本地 runner，new / resume 一个持久化会话并投递一轮任务。
- `overlay.yml`：`--patch` overlay，停用 headless bundle 自带的 `headless-startup`
  与 `headless-runner`，把 `runner.mjs` 挂成 runner。

## 用法

```powershell
$env:DSH_BIN  = '<dsh 安装的 lib/bin.js>'          # 例如 <npm 缓存>\...\@deepseek-ai\dsh\lib\bin.js
$env:DSH_TASK = '<本次任务文本>'
$env:DSH_HOME = '<持久化 home>'                    # 可选；缺省用 ~/.dsh

# 首轮：不带 DSH_SESSION_ID，输出里会带新建的会话标识
node $env:DSH_BIN --profile headless --patch <仓库>\scripts\headless-session\overlay.yml

# 续接：把上一轮结果里的 sessionId 传回去，必须仍在同一工作目录启动
$env:DSH_SESSION_ID = 'session-<上一轮返回的 id>'
node $env:DSH_BIN --profile headless --patch <仓库>\scripts\headless-session\overlay.yml
```

可选：`DSH_RESULT_FILE` 把同一份结果写成 JSON 文件；`DSH_DEBUG_RUNNER=1` 在 stderr
打印运行细节。模型 Key 仍按 Harness 受支持的方式提供——继承的环境变量、
`$DSH_HOME/.credentials.yaml`、调用目录或 `$DSH_HOME` 下的 `.env`——本脚本不读取、
不打印也不保存 Key。

## 输出与失败

stdout 是一行 result JSON：

```json
{"sessionId":"session-…","continueReason":"created|resumed","status":{"kind":"completed"},"text":"…","cwd":"…"}
```

- 退出码 `0`：本轮 turn 以 `completed` 结束。这不代表业务任务完成，也不代表测试或
  Review 通过。
- 退出码 `1`：失败、中止或用法错误。stderr 给出 `dsh: <code>: <message>`；可在
  result JSON 的 `status.error` 里读到同一错误的 `code` 与 `message`。
- 续接不存在的会话标识：失败退出，**不会**静默新建会话。
- 在与会话记录不一致的工作目录续接：失败退出并报出记录目录；不会在新目录里继续旧任务。

## 依赖与边界

- `runner.mjs` 位于仓库，需按 `DSH_BIN` 指向的安装解析随安装提供的包；`DSH_BIN`
  缺失且包名无法从本文件解析时会加载失败并明示。
- `overlay.yml` 按行 id 停用 headless bundle 的两行；该 bundle 升级后 id 变化会变成
  `patch: entry … not found` 警告，需重新核对（实测 0.1.5-rc.2 与 0.1.5-rc.3 相同）。
- 权限、沙箱与审批沿用 headless profile 的默认值（`DSH_PERMISSION_MODE`，缺省
  `workspace-write` + `ask`），本脚本不额外放宽。
- 这是 Research 阶段的最小调用件，不是接单工具的完整实现：评论解析、授权、路由与
  任务绑定不在本目录。
