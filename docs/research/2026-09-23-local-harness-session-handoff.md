# 本机 Harness 会话创建、续接与原 Web 界面观察验证

Date: 2026-09-23
Keywords: Harness, session-controller, session/create, session/prompt, session/follow, browser-token-authentication, 接入验证
Status: VERIFIED

关联 Issue: [#3](https://github.com/cnjimmyshao/fjzx.gh-dev-runner/issues/3)

## 调查问题

外部接入程序能否在维护者指定的执行电脑上，向常驻 DeepSeek Harness 创建测试会话、向同一会话发送后续消息，并在**原 Web 界面**观察同一会话？在实现 GitHub 评论接单之前必须先回答这个问题，否则会先建外围系统再发现本机接口不兼容。

本报告只覆盖完成该验证所必需的环境信息与最小调用方式，不建设诊断系统，也不接管、重启、升级工作中的 Harness。

## Environment

| 项 | 实际值 |
| --- | --- |
| 操作系统 | Windows（本机开发机；会话用户为普通用户 `mb01\<user>`，非管理员） |
| Node.js | v26.7.0 |
| npm | 11.19.0 |
| Harness CLI | `@deepseek-ai/dsh` **0.1.5-rc.2**（npm `npx` 缓存安装，非本仓库依赖） |
| 运行入口 | `npx @deepseek-ai/dsh web` |
| Harness 进程 | `node .../@deepseek-ai/dsh/lib/bin.js web`，监听 `127.0.0.1:3080` |
| `DSH_HOME` | `C:\Users\<user>\.dsh` |
| web profile | `$DSH_HOME/profiles/web`，bundles = `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app`，`patchReload: live`；两层 patch 列表均为空（未改动出厂组合） |
| 模型/预设 | `deepseek-official` / `deepseek-flash`，`reasoningEffort: max`；新建会话 `agentPreset: standard` |
| 会话持久化 | `$DSH_HOME/sessions/--<编码后的 cwd>--/<sessionId>/session.v3.jsonl.zstd` |
| 浏览器/界面 | Microsoft Edge（用户已在原 Web 界面登录）；验证时另用独立临时 profile 的 Chrome 154 做只读观察 |
| 验证日期 | 2026-09-23（+08:00） |

凭证、启动令牌、cookie 值与真实会话日志均不写在本仓库；原始材料只保留在本机。

## Evidence

### 1. 传输与认证（本机实测）

`/api` 只接受带浏览器的会话 cookie 的 POST。未认证请求实测返回 **401**，响应正文：

```text
dsh web authentication required; reopen the URL printed by dsh web.
```

`GET /`（未认证）同样返回 401，即**原 Web 界面本身也需要该 cookie**。这与上游已实现的
[浏览器启动令牌认证](https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/architecture/2026-08-24-browser-token-authentication.zh.md)
一致，并且该记录明确说明：**API 路径和 Authorization header 都不接受启动令牌**，启动令牌只用于一次
`GET /?token=...` → cookie 交换；上游当初就是以"没有非浏览器客户端消费方"为理由，拒绝了持久化令牌与
Authorization bearer 方案。

本机核对 `@deepseek-ai/dsh-client-connection` 的 `BrowserAuth` 实现，确认：cookie 为
`dsh-auth-<sha256(authority) 的 base64url>`，签名密钥持久保存在
`$DSH_HOME/.credentials.yaml` 的 `client-connection/browser-session` 记录中，默认有效期 30 天
（`cookieMaxAgeDays`），删除该记录并重启进程才会全局撤销。

### 2. 一次性引导（已在本机执行成功）

本机 Harness 由可见控制台窗口启动，启动输出保留了引导 URL：

```text
dsh web: http://127.0.0.1:3080/?token=<launch-token>
```

用一次 `GET http://127.0.0.1:3080/?token=<launch-token>`（`redirect: manual`）即取得
`Set-Cookie: dsh-auth-<hash>=v1.<payload>.<sig>`，随后该 cookie 可用于全部 API 调用。此步骤与浏览器首次
打开界面所做的事完全相同，没有绕过认证，也没有修改 Harness 配置。

### 3. 最小调用方式（本机实测可用）

一元调用（HTTP）：

```text
POST /api/<namespace>/<method>
Content-Type: application/json
Cookie: dsh-auth-<hash>=v1.<payload>.<sig>

{ "type": "client-request", "rpcId": "<唯一>", "method": "<namespace>/<method>",
  "payload": { "args": { <wire 参数名>: <值> } } }
```

响应：

```json
{ "type": "server-response", "rpcId": "<同请求>",
  "result": { "ok": true, "value": { } } }
```

失败时为 `{ "ok": false, "error": { "code", "message", "details" } }`，业务错误以 `ok:false` 返回而不是 HTTP 错误码。

`args` 的键是 descriptor 的 **wire 参数名**，不是 JS 形参名——实测传错时会得到
`gateway/internal: Remote payload must contain exactly one plain-object args field`：

| 方法 | `args` 键 | 关键字段 |
| --- | --- | --- |
| `session/list` | `_request` | `{}` 或 `{ cursor }` |
| `session/create` | `request` | `{ cwd, workspaceId?, sessionId?, agentPreset? }` → `{ sessionId, agentPreset }` |
| `session/prompt` | `request` | `{ requestId, sessionId, mode: 'queue'\|'steer', content: [{type:'text',text}], clientTimeZone? }` → `{ accepted: true }` |
| `session/cancel` | `request` | `{ sessionId }` |
| `session/rename` | `request` | `{ sessionId, title }` |
| `session/selectModel` | `request` | `{ sessionId, provider, model, reasoningEffort? }` |
| `session/search` | `request` | `{ query }` |
| `session/modelCatalog` | — | 无参数 |
| `skills/list` | `request` | `{ sessionId }` |

只读读取历史/实时跟踪走 **Remote stream**（WebSocket mux），同样是流方法：

```text
GET /api/remote.mux   (WebSocket upgrade, 同一 Cookie 认证)
-> { type:'open', streamId, endpoint:'session/follow', payload:{ args:{ request:{ address:{kind:'session',sessionId}, maxMessages } } } }
<- { type:'item', streamId, value }   // value.type ∈ snapshot | event | assistant-stream
<- { type:'end',  streamId }
<- { type:'error', streamId, error:{ code, message, details } }
-> { type:'cancel', streamId }
```

`session/follow` 的**开启帧**即带一份 `snapshot`（`header` + `cursor` + `records`），可作为一次性的
冷读历史，不必单独使用 `session/page`。实测 `session/page` 的 `throughSeq` 若超过该会话
`cursor` 会被拒绝：`gateway/bad-request: session page through seq ... is past cursor ...`。

### 4. 创建测试会话并投递第一条消息

在独立测试目录（非业务仓库、非本工具仓库）执行：

- `session/create` → `sessionId=session-891eeae0-…`，`agentPreset=standard`
- 创建后立即查询：会话数 83 → 84，`running=false`，`cwd` 与请求一致，`blank=true`
  → **`session/create` 只建立会话，不启动模型**，符合"创建与投递分开"的预期。
- `session/prompt`（`mode:'queue'`，`requestId` 由客户端生成）→ `accepted=true`
- 会话事件（`session/follow` snapshot）：`permission/preset`、`sandbox/mode`、`approval/policy`、
  `agent/inbox/spliced`、`turn/start`、`step/start`、`user/message`、`request/header`、
  `session/title`、`assistant/message`、`step/end`、`turn/end`，共 19 条，`cursor=18`
- 助手回复正文为约定的四字，且**未产生任何工具调用事件**（消息中明确要求不调用工具、不读写文件）

三条证据分别成立：

| 层 | 本机证据 |
| --- | --- |
| 接受回执 | `session/prompt` 返回 `{ accepted: true }` |
| 执行结果 | 会话日志出现 `assistant/message` 与 `turn/end`（`reason.kind = completed`） |
| 界面可见 | 见第 7 节 |

### 5. 第二条消息发往同一会话

- 发送前会话数 84；发送后仍为 **84**（`delta=0`），且"本次消息期间新出现的 sessionId"为空数组
  → **没有创建另一个会话**。
- 同一 `sessionId` 的 `cursor` 由 18 推进到 26，`turn/start` 由 1 增至 2，
  `header.id` 与 `header.cwd` 不变。
- 第二条消息刻意依赖第一轮内容（要求复述上一轮回复的四个字），助手回复为"链路正常 收到。"
  → **上下文衔接正确**，不是新开会话后的全新上下文。

### 6. 只重启测试接入程序（未重启 Harness）

在一个**全新的 `node` 进程**中，只从磁盘读取上一进程保存的 cookie（不重新做令牌交换），直接调用
`session/list` 与 `session/prompt`：

- 目标会话仍能查到，`cwd`、标题一致
- 第三条消息 `accepted=true`，同一 `sessionId` 的 `turn/start` 由 2 增至 **3**，助手回复"绑定有效。"
- 全程未重启、未接管、未修改正在工作的 Harness 进程

即：保存的 cookie（持久签名密钥 + 未过期 cookie）**跨测试接入程序重启仍可使用**。

### 7. 原 Web 界面观察

在独立临时浏览器 profile 中打开原 Web 界面（`http://127.0.0.1:3080/`）：

- 未持 cookie 时界面本身返回 401；注入该会话 cookie 后界面正常加载（标题 `DeepSeek Harness`）。
- 用界面自带的"搜索会话"按标题检索，命中该测试会话，并显示其工作区名称。
- 打开该会话后，"对话"页**完整渲染三轮消息**：两条用户消息原文、两次助手回复
  （"链路正常"、"链路正常 收到。"、"绑定有效。"）以及用量/用时与 `3 轮 3 步` 状态。
- 界面能实时跟进：第三条消息是在浏览器已打开该会话之后由外部程序投递的，界面自行更新出现
  （`刚刚` 时间戳），无需外部程序刷新页面。

界面把会话标题作为可见标识（`连通性测试链路正常`），但**不在 DOM 中暴露 `sessionId`**（实测页面
HTML 内不含该 id）——工具不能指望从界面读回会话标识，必须自己保存 `session/create` 的返回值。

## Results

| 目标 | 结果 | 依据 |
| --- | --- | --- |
| 核对实际 Node/Harness 版本、账户、profile、持久化与 Web 实例 | 通过 | 第 Environment 节 |
| 外部程序创建测试会话 | 通过 | 第 4 节；`session/create` 返回 `sessionId` |
| 投递无文件写入意图的简短消息 | 通过 | 第 4 节；无工具调用事件，测试目录仍只有占位文件 |
| 会话标识与工作目录对应关系 | 通过 | `session/list` 中 `cwd` 与请求目录一致；磁盘落盘目录名与 `sessionId` 对应 |
| 向同一会话发送第二条消息 | 通过 | 第 5 节；会话数不变、cursor 推进、上下文衔接 |
| 区分接受回执 / 执行结果 / 界面可见 | 通过 | 第 4 节三段证据表 |
| 在原 Web 界面观察实际消息与执行状态 | 通过 | 第 7 节 |
| 只重启测试接入程序后绑定可用 | 通过 | 第 6 节；Harness 未重启 |
| 不重启/不升级/不改 Harness、不改凭证与仓库权限 | 通过 | 全程只读 Harness 状态；只做一次令牌换 cookie 的常规引导 |

## Conclusion

**外部本机程序可以向常驻 Harness 创建会话、向同一会话续接投递，并在原 Web 界面看到同一会话——本机验证闭环成立。** 后续实施 Issue 可以使用第 3 节的接口。

但**认证是真正的接入门槛，需要在实施前由维护者决定**：

1. Harness 的 `/api`（含 WebSocket mux）只认浏览器会话 cookie，**没有非浏览器认证通道**。
2. cookie 来自一次性 `GET /?token=<launch-token>` 交换。启动令牌每次进程启动重新生成、不落盘，
   只出现在 `dsh web` 的启动输出里；上游已明确拒绝把令牌做成 API bearer 或持久化。
3. cookie 本身是长期有效的（默认 30 天，签名密钥持久化，跨 Harness 重启有效），
   因此**取得一次之后，接单工具把它存进本机配置（不入库）即可长期复用**——这一点已由第 6 节实测确认。

也就是说：接单工具不需要每次都能读启动令牌，只需要一次可用的引导。可选路径：

- **A（推荐）** 一次性人工/配置引导：部署者从 `dsh web` 启动输出取出带令牌的 URL，填入本机配置，
  工具完成一次换 cookie 后把 cookie 存入本机状态；之后自动运行。简单、明确、不依赖脆弱手段。
- **B** 工具在启动输出可获取时自动抓取（本机 Harness 由可见控制台启动，可用控制台缓冲区读取实现）；
  省一次人工，但依赖启动方式，需要在实施 Issue 中作为单独的、可失败的能力说明。
- **C** 持久化另造一套凭据或改 Harness 认证（新增公网/局域网控制入口或自定义 bearer）——
  超出本 Issue 范围，且与上游安全决定冲突，需维护者另行决定。

另一个实施约束：**评论去重与"同一任务不重复投递"必须由工具自己保证。** `session/create` 支持传入
预分配 `sessionId` 以避免重复建会话，`session/prompt` 的 `requestId` 是客户端生成的相关标识
（上游说明重复 `requestId` 会返回原接受而不重复插入），但工具侧仍必须保存 仓库身份 + Issue 编号 →
sessionId 的绑定与处理进度。

## Contract Impact

- 本报告只提供**时间点证据**，不自动成为需求，也不修改 `docs/current/`。是否采用路径 A/B/C 属于需要
  维护者决定的事项，已留在 Issue #3。
- 对后续实施的有效约束：首版接入必须按**实际安装版本**核对接口；本次结论只对
  `@deepseek-ai/dsh 0.1.5-rc.2` + Windows + 本机 web profile 成立。
- 接口是 **rc 预览版**（`0.1.5-rc.2`），wire 细节可能随版本变化；实施时应在代码中标注所依据的
  版本并保留可重跑的验证脚本思路，不把本次接口细节写成永久 Contract。

## 限制与未覆盖

- 只验证了本机（loopback）接入，未验证第二台电脑、`--trusted-host`/局域网部署或代理场景。
- 未验证并发与多写入者：没有测试同一会话被两个客户端同时投递，也没有测试"任务正在执行时再开一个"。
  本机单机不等于没有并发，这是实施阶段必须单独处理的保障。
- 未验证 Harness 进程重启后的续接（本 Issue 明确不重启工作中的 Harness）；第 6 节只重启了测试接入程序。
  上游说明未过期 cookie 跨重启有效，但**本机未实测**，实施时不应把上游说明当作已验证事实。
- 未验证令牌/cookie 失效路径（删除凭据记录、cookie 过期）后的重新引导体验。
- 未验证 `mode:'steer'`、附件、`session/fork`、`session/rename`、`session/selectModel` 等本次用不到的接口。
- 内容搜索未使用：界面提示"内容搜索暂不可用，仅显示名称匹配"；`session/search` 接口存在但本机未验证。
- 本报告未附真实令牌、cookie 值与完整会话日志；如需私下核验，原始材料只在本机保留。

## 下一步建议

1. 维护者在 Issue #3 就引导方式（A/B/C）给出决定；这决定实施 Issue 的配置字段设计。
2. 决定后开实施 Issue：最小本机配置（Harness 地址 + cookie/引导输入）、GitHub 增量评论检查与去重、
   执行机路由、任务绑定（仓库+Issue → sessionId/cwd）、投递与必要反馈。
3. 实施时把本次的最小调用方式固化为可重跑的接入验证，并在第二台电脑上复验配置与路由隔离。
