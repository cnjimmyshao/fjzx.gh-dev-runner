# 评论接单工具

`src/` 是接单程序本体：在本机用已登录的 `gh` 按固定间隔读取接入仓库的新评论，按
`runner:<machineId>` 标签与发起人许可路由，为「仓库身份 + Issue 编号」准备独立工作目录并
启动或续接 Harness headless 会话，最后把调用状态回写到原 Issue。

它不分析业务需求、不裁决 Review、不代替维护者决定，也不重建提交与测试编排；那些由 Dev 在
目标项目会话里按该项目规则完成。

## 本目录内容

| 文件 | 职责 |
| --- | --- |
| `src/main.mjs` | 入口：参数、配置加载与前置校验、单实例锁、轮询循环、本机日志 |
| `src/config.mjs` | 本机配置解析与启动期校验 |
| `src/github.mjs` | `gh` 只读增量读取 Issue／评论与最小回写入口 |
| `src/commands.mjs` | 评论命令解析、授权挑选、交给 Dev 的启动消息 |
| `src/runner.mjs` | 接单流程：进度、去重、绑定、调用、反馈、重启恢复 |
| `src/workspace.mjs` | 任务工作目录（git worktree 或已备好的任务根目录） |
| `src/harness.mjs` | Harness headless 调用与结果判读 |
| `src/exec.mjs` | 子进程调用、超时与输出捕获 |
| `src/state.mjs` | 本机状态持久化（绑定、进度、调用记录） |
| `scripts/run-tests.mjs` | `npm test` 入口：同进程加载全部测试文件 |
| `test/` | 自动化测试（`node:test`，不访问 GitHub、不调用模型） |
| `../config.example.json` | 脱敏配置示例 |

## 一次接单的前置条件

1. 本机已装并在实际运行账户下**登录** `gh`，且该账户对目标仓库有读取评论、写入评论的权限。
   `gh auth status` 能看到目标主机；安装 CLI 不等于已登录。
2. 本机已有 Harness 安装与模型凭据；凭据按 Harness 受支持的方式提供，本工具不读取、不打印、
   不保存 Key。调用件与实测边界见 [`../scripts/headless-session/README.md`](../scripts/headless-session/README.md)。
3. 目标仓库的维护者已同意接入，并在目标 Issue 上设置唯一标签 `runner:<本机 machineId>`。
4. 本机配置写好（见下）。配置、凭证与任务状态都留在本机，不入库、不进入公开评论。

## 配置

缺少 `.local/config.json` 时程序拒绝启动。字段含义：

| 字段 | 说明 |
| --- | --- |
| `machineId` | 本机执行机标识，决定监听标签 `runner:<machineId>`；也可用 `--machine-id` 传入 |
| `harness.bin` | `dsh` 安装入口（`lib/bin.js`），同时作为本地 runner 解析随安装包的锚点 |
| `harness.profile` | 缺省 `headless` |
| `harness.patch` | 本仓库 `scripts/headless-session/overlay.yml` 的绝对路径 |
| `harness.home` | 可选；`DSH_HOME` 覆盖点，缺省用 `~/.dsh` |
| `harness.timeoutMs` | 单次调用的硬超时，缺省 15 分钟；超时按调用失败回报，不冒充完成 |
| `runtime.stateDir` | 状态、日志与临时输出目录；缺省 `~/.fjzx-gh-dev-runner` |
| `runtime.workspaceDir` | worktree 缺省父目录 |
| `runtime.pollSeconds` | 检查间隔，缺省 60 秒 |
| `runtime.capture` | 子进程输出捕获：`file`（缺省，落到该轮日志目录）或 `pipe`（在终端直接看输出） |
| `runtime.keepRunLogs` | 每个任务保留的最近调用次数，缺省 20 |
| `github.command` | 命令词，缺省 `@dev` |
| `github.timeoutMs` | 单次 `gh` 调用超时，缺省 120 秒 |
| `github.pageSize` | 分页大小，缺省 100 |
| `repositories[].repo` | `owner/name` |
| `repositories[].allowedActors` | 允许发起命令的 GitHub 登录名；空数组视为配置错误 |
| `repositories[].machineId` | 可选；该仓库用别的执行机标识时填 |
| `repositories[].sourceDir` | 部署者已有的仓库检出；工具从它 `git worktree add` 出独立任务目录 |
| `repositories[].repoDir` | 已经备好的任务根目录；必须已存在（工具不代替维护者做首次 clone，也不代建空目录） |
| `repositories[].baseBranch` | 可选；worktree 的起点，缺省用 sourceDir 的当前 HEAD |
| `repositories[].worktreeDir` | 可选；worktree 父目录，缺省 `<workspaceDir>/<owner-name>` |

`sourceDir` 与 `repoDir` 至少给一个。路径支持 `~` 与相对配置文件目录的写法。
配置示例见 [`../config.example.json`](../config.example.json)。

## 启动与参数

```powershell
npm test                                  # 自动化测试，不访问 GitHub、不调用模型
node src/main.mjs --once                  # 只检查一轮后退出，用于首次核对；有仓库读不出来时退出码非零
node src/main.mjs                         # 常驻，按 runtime.pollSeconds 循环
node src/main.mjs --config .local/config.json --machine-id mb01
node src/main.mjs --capture pipe          # 临时改为管道捕获，在终端直接看子进程输出
```

同一个状态目录只允许一个接单进程：第二个实例会因 `runner.lock` 里活着的 pid 而拒绝启动，
避免同一任务双写。进程被强杀留下的陈旧锁不会阻塞下次启动。

## 接单规则

- 只在已接入仓库的 **Open Issue** 上工作，且该 Issue **恰好**带一个执行机标签，就是本机的
  `runner:<machineId>`。无标签、多标签、带别的执行机标签都不启动；改标签本身不启动任务，也不把
  已绑定任务迁到别的电脑。`issues` 接口同时返回的 Pull Request 不是接单入口。
- 只有 `allowedActors` 里的发起人发布的、正文去除首尾空白后**恰好等于** `@dev` 的独立评论才算
  命令。**编辑过的评论不算命令**（`created_at` 与 `updated_at` 不同即排除），引用或代码块里的
  `@dev`、长评论中的片段也不算；继续任务要另发一条新评论。
- 同一条命令只执行一次。进度与「已认领」在同一次落盘、且都在启动 Harness 之前，重复轮询、重复
  拉取与正常重启都不会重放。
- 同一任务一次只跑一个写入者。本轮已有调用时，其余新命令立即回复「执行中，本条未启动；结束后
  重新发指令」，不排队、不在下一轮补跑。
- 首次接入从启动时点开始：已存在的评论只登记为已看过，不重放历史命令。

## 工作目录与会话绑定

每个「仓库 + Issue」绑定一个执行机、一个独立工作目录、一个会话标识与已知分支／PR：

- 给了 `sourceDir` 时首次任务执行 `git worktree add -b fjzx/issue-<n> <worktreeDir>/issue-<n>`，
  不与部署者的检出互相影响；worktree 建失败就报告，不静默改用别的目录。目标路径已存在时交给
  git 判定（可能已是同一任务的既有工作树）。
- 给了 `repoDir` 时直接使用那个已备好的任务根目录；**目录必须已存在**（不存在说明路径写错或还没
  准备），工具不代建空目录，避免 Harness 在没有目标仓库的情况下开工。
- **一个工作目录只服务一个任务**：只配 `repoDir` 时该仓库的多个 Issue 会落在同一目录，因此第二个
  任务会被拒绝并回报原因（否则两个任务会在同一份检出上并行开发、互相覆盖未提交的工作）。同一仓库
  要接多个任务请改用 `sourceDir`（每个 Issue 一个独立 git worktree），或为任务分别准备目录。
- 首轮启动后把返回的真实 `sessionId` 写进绑定；后续命令在**同一目录**带该标识续接原会话。
- 目录不存在、绑定属于别的执行机、绑定来源与配置不一致时，报告并停止，不静默新建会话或换目录。
- 上次调用在取得会话标识前中断时，保留绑定与目录，下一轮在同一目录新建会话并在 Issue 说明。
- 上次停在「准备工作目录」阶段（还没有绑定，Harness 从未启动）时，恢复会如实回报，并把进度回退到
  该评论之前，让它在下一轮被重新受理一次；只有这一次重试，之后的重复仍由状态记录挡住。

## 状态、日志与反馈

```text
<stateDir>/state.json                          # 绑定、进度、命令处理记录（本机）
<stateDir>/runner.lock                         # 单实例锁（独占创建，活着的持有进程会让第二个实例退出）
<stateDir>/logs/<repo>-issue-<n>/<时间>-<评论 id>/
    result.json                                # 本轮调用的结构化结果（sessionId、status）
    harness.stdout.log / harness.stderr.log    # Harness 原始输出（capture=file 时）
    git.stdout.log / git.stderr.log            # 建 worktree 的 git 输出
<stateDir>/logs/runner-YYYY-MM-DD.log          # 接单过程日志（token 形态已脱敏）
<stateDir>/tmp/                                # gh 输出临时文件
```

进程启动、回合结束、Dev 自报完成、业务验收是四件事：退出码 `0` 且 `status.kind=completed`
只表示本轮 turn 正常结束，不代表任务完成或测试、Review 通过。这类结论由 Dev 按目标项目规则
报告，工具不代判。

评论只回必要的几条，不每分钟刷：接单（新建／续接，含稳定任务标识 `ws-xxxxxxxx` 与会话标识）、
执行中未启动、未授权或路由不符、编辑过的评论未启动、调用失败、**回合没有正常完成**、上次调用
结果不确定。回写失败只记本机日志，**不会**因此重跑同一次开发任务。

公开评论不带任何本机路径信息（连目录名也不带）：只给执行机、会话标识与由工作目录派生的稳定标识
`ws-xxxxxxxx`，本机可用它在本机状态与日志里对齐任务。完整模型输出、原始日志与凭据留在本机。

## 已知限制

- 真实端到端只在维护者授权的测试 Issue 上验证；第二台电脑的真实部署、跨机路由与 Harness 升级后
  的续接未验证。
- 不承诺跨进程崩溃的 exactly-once：中断后如实报「结果不确定」，由人工核对后另发指令。
- 不实现排队、跨机调度、自动换会话、自动 Review 修复循环、自动 merge 或部署。
- 同一任务执行期间程序阻塞在该轮调用上，其他仓库的检查会顺延到本轮结束。
- 每轮按标签拉取该仓库的 Open Issue 列表：默认 `github.pageSize` 为 100，大仓库（数百个带标签的
  Open Issue）会产生多次分页请求。实测把 pageSize 调到 3 时，对 `microsoft/vscode`（label=bug）
  会在 120 秒超时；接入这类仓库时请调大 `pageSize`，或只接入确实需要接单的仓库。
- `harness.home` 缺省 `~/.dsh`；本工具只复用该安装与凭据，不安装、不升级、不重启工作中的 Harness。
