# 共享 DSH_HOME 的多 Harness 并发与单 session 单写入实测

Date: 2026-09-29
Keywords: Harness, dsh, headless CLI, DSH_HOME, 并发, 单写入者, session lease, flock, 本机验证
Status: VERIFIED（范围限本文记录的时间、版本、电脑、调用路径与实际命令）

关联：[Issue #36](https://github.com/cnjimmyshao/fjzx.gh-dev-runner/issues/36)；Refs #20 #22 #23 #19 #21。
依据：[Current：范围与工作链路](../current/01-scope-and-flow.md)、[Harness 并发与轮询调度](../current/05-harness-scheduling.md)、[CLI 验证报告](2026-09-23-local-harness-cli-first-run-and-resume.md)、[START sessionId 时点实测](2026-09-24-start-sessionid-visibility.md)。
已查仓库 commit：`31008e9`（`origin/main`，2026-09-29）；探针在本文同一 PR 中提交。

## 调查问题

按 Issue #36 的问题清单，在执行机**实际安装版本**上实测，不升级、不改工作中的 Harness：

1. 当前执行机实际安装的 Node／Harness 版本及本次调用路径；
2. 同一个 `DSH_HOME`、两个不同工作目录、两个不同 session，同时运行两个 Harness 进程时：能否同时正常执行；session／profile／配置是否互相污染；是否出现持久化覆盖、锁冲突或损坏；两边退出后能否再次 resume 原 session；
3. 同一个 session 是否存在 Harness 自身的跨进程单写入保护；
4. 同时启动两个进程写同一 session：第二个是否被明确拒绝／阻塞；是否存在静默并发写入；是否可能损坏 session；
5. 当前版本若不支持安全共享 `DSH_HOME` 并发，冲突点具体在哪里；是否确实需要按任务／进程隔离 home。

## Environment

| 项目 | 实际值 |
| --- | --- |
| 电脑／系统 | 本机执行电脑（macOS／darwin，arm64），普通用户账户 |
| Node.js | v24.16.0（arm64；即 V1 Contract 的 Node.js 24 LTS 线，本机另装有 v26） |
| Harness | `@deepseek-ai/dsh` **0.2.0-rc.2**（`npx` 缓存安装，`<npx-cache>`）；profile `headless` = `dsh-base` + `dsh-headless` |
| 会话持久化 | `$DSH_HOME/sessions/<工作目录 slug>/<sessionId>/`，事件为多帧 Zstandard + JSONL（本机格式 `session.v4.jsonl.zstd`） |
| 写锁 | 同一目录内 `session.lock`（POSIX 非阻塞 `flock(2)`；Windows 为命名内核信号量，见源码，未实测） |
| 调用路径 | `<node> <npx-cache>/node_modules/@deepseek-ai/dsh/lib/bin.js --profile headless [--json] [--session-id <id>] "<task>"`；本机 0.2.0-rc.2 的官方 headless **已有** `--json` 与 `--session-id` |
| 测试工作目录 | `<testroot>/workdir-{a,b,c,d,w1,w2,w3,w4}`，独立临时目录，无业务文件、无 `AGENTS.md` |
| 持久化配置 | 一个共享测试 `DSH_HOME`（`<testroot>/dsh-home`）+ 两个冷启动 home（`dsh-home-cold`、`dsh-home-cold2`），全部独立于生产 `~/.dsh` |
| 模型凭据 | 本机已保存的凭据文档按受支持方式复制进测试 home（mode 600）；未读取内容、未打印、未进入任何输出；运行前后三个 home 与原文件 sha256 一致 |
| 遥测 | 每次调用设 `DSH_TELEMETRY_DISABLED=1`，不向遥测端点发送会话前缀 |
| 权限 | Harness 侧默认组合（`workspace-write`）；测试任务只在测试目录内执行 `sleep`／`echo`，未出现审批交互 |
| 未触碰 | 工作中的 `dsh web`（`127.0.0.1:3080`）与生产 `~/.dsh`：实测全部在独立 home 内；运行后 `~/.dsh` 顶层 mtime 未变、无测试工作目录 slug、凭据文件 sha256 未变 |

与仓库既有记录的环境差异：`docs/development.md` 记录的历史验证环境是 Node v26.7.0 + `dsh` 0.1.5-rc.2（Windows），其 headless 只有 `[task...]`。本文这台执行电脑安装的是 0.2.0-rc.2（macOS），官方的 `--session-id`／`--json` 已存在；本文只回答并发问题，不据此声称 development.md 里"授权升级后按新版本重测"或"Node 24 下重跑 overlay 路径"两项已完成。

## 可复现步骤

脱敏符号：`<node>` 为 Node 24 可执行文件，`<dsh>` 为 `@deepseek-ai/dsh` 的 `lib/bin.js`，`<testroot>` 为独立测试根目录，`<home>` 为共享测试 `DSH_HOME`。

复现件：[`probes/shared-home-concurrency-probe.mjs`](probes/shared-home-concurrency-probe.mjs)（并发编排与外部锁校验）与 [`probes/session-log-integrity.mjs`](probes/session-log-integrity.mjs)（会话日志完整性）。前者按场景文件里各进程的 `atMs` 偏移启动 `dsh --profile headless` 子进程、按同一时间线执行外部锁校验、把每个进程的 stdout／stderr 落盘，并写出 `report.json`（启动／退出时刻、退出码、PID、被强杀时刻、`--json` 事件里解析出的 sessionId／turn 结束原因／最终文本、锁校验结果）；某个进程若根本没起来（工作目录不存在、spawn 失败），同样结算并写入 `spawnError`，报告照常落盘，整次运行以退出 1 表明这是基础设施失败而不是场景结果。

它只给子进程最小环境（`PATH`／`HOME`／`TMPDIR`／`LANG` 等 + 显式 `DSH_HOME` + `DSH_TELEMETRY_DISABLED=1` + 场景自带变量），从不继承探针自身的完整环境——正在工作的 Harness 导出了 `DSH_SESSION_ID`／`DSH_PROFILE` 等变量，不能带进测试进程。

探针版本：本文场景由同一探针运行，提交版本在其上增加了 `killAtMs` 强杀支持，并把"进程启动"与"外部锁校验"放进同一条时间线（早期版本会先把所有进程排完再执行校验）。没有外部锁校验的场景不受该调整影响，提交后已用最终版本重跑一次代表性并发场景（2 个进程仍都退出 0、session 各自独立、stderr 为空）；唯一受影响的强杀场景已用最终版本重跑，本文记录的 4003／6550ms 校验时刻即该次结果。

Review 后另有两处按根因修复，结论与上表数字不变：

- `session-log-integrity.mjs` 改为按 Zstandard 帧结构（RFC 8878 帧头 + 块头）走帧，而不是扫描魔数：Node 的 `zstdDecompressSync` 对截断帧返回部分输出而不报错，且魔数可能出现在压缩负载内部，因此"解码成功"与"魔数命中"都无法可靠区分真实帧边界。现在任何结构性损伤（缺魔数、帧头／块头／校验和越界）、解压失败、JSON 解析错误或头部 `id` 与目录名不一致都以非 0 退出。用四类构造输入核对：中间帧负载损坏（校验和不匹配）、中间截断、末帧截断、块头损坏——修复前全部被判成 OK，修复后全部判 BAD 并退出 1，完好日志仍判 OK；结构走帧与旧魔数扫描在该次比对涉及的 14 个完好日志上给出完全一致的帧数与事件数。
- `shared-home-concurrency-probe.mjs` 在 spawn 失败路径同样结算 entry、关闭句柄并写出报告：用不存在的工作目录复现时，修复前进程以 unsettled top-level await 退出 13 且没有 `report.json`，修复后 0.07s 内写出带 `spawnError` 的报告并退出 1。

```bash
# 1) 测试根目录与共享 home；凭据按受支持方式复制，值不进入命令行与输出
mkdir -p <testroot>/dsh-home <testroot>/workdir-a <testroot>/workdir-b
cp -p ~/.dsh/.credentials.yaml <testroot>/dsh-home/.credentials.yaml && chmod 600 <testroot>/dsh-home/.credentials.yaml

# 2) 场景文件：两个进程 0ms 同时启动、不同工作目录、各自新建 session
cat > <testroot>/s1.json <<'JSON'
{
  "dshBin": "<dsh>", "dshHome": "<testroot>/dsh-home", "outDir": "<testroot>/out/s1",
  "processes": [
    {"label": "s1-a", "cwd": "<testroot>/workdir-a", "atMs": 0,
     "args": ["--profile", "headless", "--json", "Remember this token for later: ALPHA-36. Reply with exactly: STORED-A"]},
    {"label": "s1-b", "cwd": "<testroot>/workdir-b", "atMs": 0,
     "args": ["--profile", "headless", "--json", "Remember this token for later: BRAVO-36. Reply with exactly: STORED-B"]}
  ]
}
JSON
<node> probes/shared-home-concurrency-probe.mjs <testroot>/s1.json

# 3) 续接：两个进程同时对各自 session 发依赖前文的消息（--session-id <各自 id>）
#    同 session 冲突：holder 用 bash 工具 sleep 12 持有写锁，contender 3s 后写同一 session
#    崩溃恢复：killAtMs 强杀 holder，7s 后由新进程 resume 同一 session
```

外部锁校验由探针用 `python3` 的 `fcntl.flock(LOCK_EX|LOCK_NB)` 独立完成：它不是 Harness 代码，直接从内核确认 `session.lock` 是否真的被别的进程持有。

```bash
# 4) 独立校验：按帧结构走帧、逐帧解压并逐行解析 JSONL
<node> probes/session-log-integrity.mjs <testroot>/dsh-home <testroot>/dsh-home-cold <testroot>/dsh-home-cold2
```

`session-log-integrity.mjs` 不依赖 Harness 代码：它按 RFC 8878 的帧头与块头算出每个帧的边界，逐帧解压、把所有行当 JSON 解析，并核对每个日志头部 `id` 与目录名一致；任何结构性损伤、解压失败、解析错误或目录名不一致都以非 0 退出，并打印定位到具体帧的损伤信息。本批运行的输出是 `logs=12 frames=163 events=411 bad=0`（Review 修复后在同一批 home 上复核，此时包含复跑新增的会话，为 `logs=18 frames=222 events=576 bad=0`）。

## Results

### 1. 版本与调用路径（问题 1）

见 Environment。要点：执行机实际安装 `@deepseek-ai/dsh` 0.2.0-rc.2，Node v24.16.0；这次全部实测走官方 headless profile（未使用仓库 `scripts/headless-session/` 的 `--patch` overlay，该 overlay 面向 0.1.5-rc.2 的缺口）。本机版本上 `--json` 的第一个事件就是 `{"type":"session","sessionId":…,"cwd":…}`，调用方在 turn 之前即可取得会话标识。

### 2. 同 home、不同 session／工作目录并发（问题 2）

| 场景 | 进程 | 结果 |
| --- | --- | --- |
| 两个新 session，不同工作目录，0ms 同时启动 | A：0→2059ms；B：2→2102ms | 都退出 0，`turn_end.reason=completed`，两个不同 session；stderr 全空 |
| 四个新 session，四个工作目录，0ms 同时启动 | 4 个进程：1–3ms 启动，2034–2283ms 退出 | 都退出 0，四个不同 session；stderr 全空 |
| 两个新 session，**同一工作目录**，0ms 同时启动 | A：1→1602ms；B：2→1805ms | 都退出 0，两个不同 session 落在同一 slug 目录下；stderr 全空 |
| 冷 home 首次初始化：两个进程同时首启（真实模型轮次） | 2→1787ms；2→2163ms | 都退出 0；profile 层只留一份；共享 `.anonymous-user-id` 是**一个合法 UUID** |
| 冷 home 首次初始化：6 个进程同时首启（`--dump-config`，不调用模型） | 6 个进程：1–4ms 启动，96–102ms 退出 | 都退出 0；6 份输出 sha256 完全相同（1 个唯一值）；stderr 全空 |

持久化写入范围（对 home 做运行前后清单比对，含文件 size+sha256）：

- 每个 session 各自新增／追加自己的 `sessions/<slug>/<sessionId>/session.v4.jsonl.zstd` 与 `session.lock`；
- 每个 session 各自一份 `storages/session_projcache/sessions/<sessionId>.json`（按 session 分文档）；
- 并发运行**没有**改动任何共享文档，没有出现锁冲突、`EEXIST`／`EBUSY` 或损坏信息，没有残留临时文件；
- 不同工作目录的 session 落在各自 slug 目录，未互相写入。

退出后续接（问题 2 第三项）：两个进程**同时**续接各自 session，回答分别是 `ALPHA-36-R1` 与 `BRAVO-36-R2`——第一轮只把 token 交给各自 session，续接进程只发送 sessionId 与当前消息，因此复述只可能来自原会话记录；两个 slug 的 session 目录数不变（没有新建会话）。

跨任务污染检查：在另一工作目录用 `--session-id` 续接原 session 被拒绝（退出 1）：

```text
dsh: session "<id>" was recorded in "<workdir-a>", not "<workdir-b>"
```

### 3. 同 session 的跨进程单写入保护（问题 3）

**存在，且由 Harness 自身提供。** 本机 0.2.0-rc.2 的 JSONL 持久化层对每个 session 目录持有一个跨进程写锁（`@deepseek-ai/dsh-session-persistence-jsonl` 的 `SessionWriteLease`，锁文件 `session.lock`）。以下为该模块文档与源码依据，其中 POSIX 路径已由实测与外部 `flock` 校验确认：

- POSIX 走原生 `flock(2)` 非阻塞独占；争用映射为 `SessionAlreadyOwnedError`；
- 进程死亡（含被强杀）时由内核释放，不依赖清理逻辑；
- 持锁进程存活但没有进展时**没有过期抢占**：设计上不允许夺走停滞写入者后继续追加，避免撕裂日志；
- 既有 session 在 open-for-write 时就取锁，新建 session 在第一次落盘前取锁。

实测（PID 均为不同进程，holder 用 `bash` 工具执行 `sleep 12` 持有写锁）：

| 场景 | 结果 |
| --- | --- |
| 错开启动：holder 0ms 起，contender 3008ms 起 | holder 退出 0（14815ms）；contender 退出 1（3945ms，即约 937ms 内失败），无 session 事件 |
| 0ms 同时启动，试验 1 | p1 退出 1（898ms）；p2 退出 0（2090ms，写入 `RACE-1-P2`） |
| 0ms 同时启动，试验 2 | p1 退出 1（670ms）；p2 退出 0（1647ms，写入 `RACE-2-P2`） |
| 0ms 同时启动，试验 3 | p1 退出 1（643ms）；p2 退出 0（1537ms，写入 `RACE-3-P2`） |

独立锁校验（探针用 `python3` 的 `flock` 直接试锁，不经过 Harness）：

| 时刻 | 结果 |
| --- | --- |
| holder 存活期间（错开冲突场景 5002ms；强杀场景 4003ms） | `acquired=false`，锁确实被另一个进程持有 |
| holder 正常退出后（26001ms） | `acquired=true`，内核已释放，锁文件仍留在原处 |
| holder 被 `SIGKILL` 后、后继进程启动前（6550ms） | `acquired=true`，强杀不留下悬挂锁 |

### 4. 第二写入者的拒绝方式、静默写入与损坏检查（问题 4）

拒绝是**明确且结构化**的，不是阻塞、不是静默、也不是新建会话：

| 观测项 | 实际结果 |
| --- | --- |
| stderr | `dsh: session "<id>" is already owned by an active write handle` |
| stdout（`--json`） | `{"type":"error","message":"session \"<id>\" is already owned by an active write handle"}`，且在 `session` 事件之前 |
| 退出码 | 1 |
| 耗时 | 643–937ms；失败发生在 `session` 事件之前（输出里没有 session 事件，也没有 usage 记录） |
| session 目录数 | 不变；被拒进程没有新建会话，也没有写入任何事件 |

静默并发写入的检查：被争用的 session A 日志里 `turn/start` 与 `turn/end` 各 7 次，对应 7 次合法轮次且全部 `completed`；4 次被拒进程（1 次错开 + 3 次同时启动）在内留下 **0 个事件**。

损坏检查（独立工具按帧结构走帧 + 逐帧解压 + 逐行解析 JSONL，覆盖三个 home 的全部会话日志）：

- 12 个日志、163 个 zstd 帧、411 个事件，**0 个结构性损伤、0 个解压失败、0 个 JSON 解析错误**，每个日志头部 `id` 与目录名一致。
- 修复探针后复核（此时 home 里已含修复期间复跑新增的会话）：18 个日志、222 个帧、576 个事件，同样 `bad=0`。另外用四类构造输入验证探针本身：中间帧负载损坏、中间截断、末帧截断、块头损坏全部判 BAD 并退出 1（修复前这些输入会被判成 OK）。

崩溃恢复（`SIGKILL` 强杀持有写锁的进程）：

| 观测项 | 结果 |
| --- | --- |
| 强杀时刻 | 6002ms（进程 `SIGKILL`，无机会清理） |
| 内核锁 | 6550ms 时可被新进程取得（无悬挂锁） |
| 后继进程 | 7105ms 启动 resume 同一 session，退出 0，stderr 空，回答 `AFTER-CRASH-36b` |
| 日志一致性 | 被强杀的两个轮次在日志中已收尾为 `turn/end reason=interrupted`；该 session 7 次 `turn/start` 对应 7 次 `turn/end` |

### 5. 同一 session 只允许一个活动写入者的边界（问题 5）

在本次所测范围内（同一执行机、同一 `DSH_HOME`、官方 headless profile、不同 session／工作目录并发，以及同 session 双进程），**不需要**按任务或进程隔离 home：跨进程单写入由 Harness 自身保证，第二写入者被明确拒绝。

同时如实记录本次未覆盖、或只由源码支持的相邻风险（不作为本文结论）：

- Web／desktop 界面：本次全部实测只用 headless profile。源码注释说明浏览器 worker 会把原生 flock 入口替换为立即成功（该界面为单进程，进程内 claim 已足够），因此**混用界面**时同一 session 的跨进程互斥证据不适用于 Web 侧；未实测。
- 共享文档：`storages/` 下的 JSON 后端是"整文件原子 rename + 每进程单写入者 + 跨进程 last-write-wins"（源码）。headless 实测只写按 session 分文档的投影缓存，没有并发写同一个共享文档；若未来某界面并发写同一文档，可能丢更新（不是损坏），属未实测推测。
- 锁文件生命周期：正常退出不删除 `session.lock`（每个已落盘 session 一个，本批 10 个 session 对应 10 个锁文件）；源码明确在 POSIX 上删掉活动 session 的锁文件会放弃互斥（锁绑定 inode）。Harness 自身不删，Runner 也不要清理。
- 存活但停滞的写入者：按设计不会被抢占，本次只覆盖"存活并正常推进的 holder 阻塞后继者"（`sleep 12`），未覆盖永久停滞。

## Conclusion（逐条回答 Issue #36）

1. **版本与路径**：执行机安装 `@deepseek-ai/dsh` 0.2.0-rc.2（npx 缓存），Node v24.16.0；实际调用路径是官方 headless profile，支持 `--json` 与 `--session-id`。已实测。
2. **共享 home 并发**：同一 `DSH_HOME` 下，不同工作目录／不同 session 的两个（以及四个、以及同一工作目录的两个）进程可以同时正常执行；session 与投影缓存按 session 分文档，未观测到互相污染、持久化覆盖、锁冲突或损坏；两边退出后都能再次 resume 原 session，且续接进程准确复述原会话内容。冷 home 首次初始化在 2 进程（真实轮次）与 6 进程（`--dump-config`）竞争下都正常。已实测。
3. **跨进程单写入保护**：**存在**，是 Harness 自身的 `session.lock` 内核写锁（POSIX `flock`），不是 wrapper 或 Runner 的约定。已实测（外部 `flock` 校验独立确认）。
4. **同 session 双进程**：第二个进程被**明确拒绝**（退出 1，stderr／`--json` 结构化错误 `already owned by an active write handle`，0.6–1.0s 内失败）；无静默并发写入（被拒进程在内 0 事件，合法轮次计数完全对得上）；未观测到损坏，全部日志可完整解码，强杀后后继进程可正常 resume。已实测。
5. **冲突点与隔离需求**：所测范围内冲突点只有一个——同一 session 的第二写入者，而它已被 Harness 正确拒绝，因此**不需要**按任务／进程隔离 `DSH_HOME`。上面列出的 Web 界面混用、共享文档 last-write-wins、锁文件清理属于未覆盖或源码级风险，不构成当前 headless 并发配置的阻塞。

## Contract Impact

未改 Current、ADR、运行代码或任何已确认 Contract；本文只补本机实测证据。可以指出、供后续任务决定的三点，不作为本任务需求：

- **支持 #20／#22 的目标边界**：本机 0.2.0-rc.2 上，"同一执行机一个 `DSH_HOME`、不同任务不同 session 与工作目录、同一 session 单写入者"这一目标配置有正面实测证据。是否把 `runtime.maxConcurrentHarnesses` 实际开到大于 1 仍是维护者的决定（#22），本文不代为设定。
- **Runner 可利用的既有信号**：第二写入者会以退出 1 + `{"type":"error",…}`／`dsh: …` 明确失败，Runner 不必自建 session 级锁；但必须把这种失败判为"未启动／未写入"，不能当成一次正常完成。任务级 single-flight 仍按 [Current 05](../current/05-harness-scheduling.md) 由 Runner 自己保证。
- **版本差异需要单独收口**：本机 0.2.0-rc.2 已有官方 `--session-id`／`--json`，与 `docs/development.md` 记录的 0.1.5-rc.2 环境不同。本文在 Node 24 上跑通了官方 headless 的首轮执行、跨进程续接、结构化结果与失败信号（并发场景内），但**没有**使用或重测 `scripts/headless-session/` 的 overlay；因此 development.md 里"在 Node 24 上重跑这几项"和"授权升级后按新版本重测官方选项／复核 overlay 行 id"仍未由本文完成，需要各自的任务与授权。

## 未覆盖范围

- 未安装、未升级、未重启任何 Harness；未触碰工作中的 `dsh web` 与生产 `~/.dsh`。
- 未验证 Web／desktop 界面参与的并发，也未验证混用界面时同一 session 的互斥；相关结论只有源码依据。
- 未验证 Windows（命名信号量路径）与其他操作系统；本文只覆盖 macOS／arm64。
- 未验证跨机、共享网络文件系统、容器或多用户同时使用同一 home 的场景。
- holder 最长只测到约 15s（`sleep 12` 的真实轮次）；未覆盖长时间运行、频繁 flush 的大 session，也没有做压力／重复次数统计（每个冲突场景 1 次错开 + 3 次同时启动）。
- 未覆盖审批交互、取消语义、模型侧错误与限流下的并发行为；未把本实测做成 Runner 的环境诊断功能。
- 未重测 0.1.5-rc.2（该版本在另一台执行电脑上），也未使用 `--patch` overlay；本文结论只对 0.2.0-rc.2 的本机实测成立。
- 原始凭据、完整会话正文与绝对机器路径未进入本文；会话标识只保留前 8–12 个字符，测试目录与会话只留在本机。
