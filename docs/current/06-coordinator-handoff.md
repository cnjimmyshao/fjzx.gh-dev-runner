# Coordinator 协调与交接 Contract

Status: V1 Contract（Issue #64）

## 目标

在现有 Implementer / Runner 闭环上增加最小 Coordinator 协调路径。Coordinator 只处理 Implementer 在开发、PR / Review 中无法依据当前规则自行解决的争议、Contract 冲突、范围不清或需要更高层决定的问题；普通 Review 修复仍由 Implementer 自行处理。

## 原 Issue 是唯一任务主线

Coordinator 不为一次争议另建“协调 Issue”。原业务 Issue 始终保存任务要求、实现交接、协调请求和决定记录，相关 PR / Review 通过链接引用。

```text
原 Issue
  → Implementer 开发 / PR / Review
  → Implementer 在原 Issue 提出协调请求
    写明“处理完成后请交回 @<runnerName>”
    评论 trim 后以 @COORDINATOR 结尾
  → Coordinator 自行读取 GitHub 完整依据并判断
    可继续：自行回写原 Issue，末尾 @<runnerName>
    需 Maintainer 决定：回写待决项并停止
  → 现有 Runner 收到 @<runnerName> 后 RESUME 原 Implementer session
```

## Implementer → Coordinator

Implementer 请求 Coordinator 时必须：

1. 在原业务 Issue 回复，不新开协调 Issue；
2. 说明争议、依据，并链接相关 PR / Review；
3. 明确 return-to Runner，例如“处理完成后请交回 @MB01”；
4. 按 [Logical Actor Identity](07-logical-actor-identity.md) 在最终控制命令之前标记 `Actor: implementer`；
5. 评论 trim 后以 `@COORDINATOR` 结尾。

return-to 是显式交接信息。Coordinator 不根据评论作者、机器历史或其他隐含状态猜测。原 Implementer 若为 HZ01，就明确写“处理完成后请交回 @HZ01”。

发出协调请求后，如果仍有不依赖协调结论的修复、测试或其他工作，Implementer 继续完成这些工作；只有协调事项已经阻塞剩余工作、没有其他不依赖该决定的工作可继续时，才结束本轮 Harness 调用。退出只释放本轮运行态，原 task binding、workspace、branch、PR 和 session 保留。

## Coordinator 工作与回写

Coordinator 被唤醒后自行读取原 Issue 最新决定、相关 PR / Review、项目 AGENTS、Current 和必要 ADR。Safari / 本机投递内容只负责定位和唤醒，不替代 GitHub 上的真实上下文。

Coordinator 可以在已经确认的 Requirement / Contract / ADR / Issue 决定范围内判断 Finding、解释现有规则并给出下一步，但不因承担协调角色自动取得 Maintainer 权限。

能够继续时，Coordinator **自己使用 GitHub 能力**在原 Issue 发布结论。Coordinator 的 Logical Actor 固定为 `coordinator`，业务回写按 [Logical Actor Identity](07-logical-actor-identity.md) 增加可见 `Actor: coordinator` 标记；如果需要 return-to，该标记必须位于最终控制命令之前，并以请求中明确的 return-to Runner 作为 trim 后最后内容，例如：

```text
……协调结论与下一步……

---
Actor: coordinator

@MB01
```

这条评论随后按现有 Runner trigger Contract RESUME 原 Implementer task / workspace / session。

如果问题需要改变 Requirement、业务语义、长期 Contract、范围、权限或其他 Maintainer 决定，Coordinator 在原 Issue 说明待决项、依据和影响后停止，不附加 return-to Runner，也不把候选方案冒充已批准决定。Maintainer 作出决定后，需要继续时仍按现有规则发布新的 `@<runnerName>` 控制评论。

## Runner / 本机协调通道边界

Runner / 本机协调通道只负责识别合法 Coordinator 触发、投递或续接对应 ChatGPT Coordinator conversation，以及必要的会话绑定、去重、运行状态和技术失败信息。

`@COORDINATOR` 的触发授权直接复用目标仓库现有 `repositories[].allowedActors`：只有授权主体发布的控制评论才允许启动 Coordinator 通道。未授权评论按普通非命令评论处理，不启动 Safari / ChatGPT，也不新增第二套 `coordinatorAllowedActors` 配置。

由于 Implementer 会自行发布 `@COORDINATOR`，Coordinator 也会自行发布 return-to `@<runnerName>`，**这两个实际 GitHub 写回身份都必须属于目标仓库的 `allowedActors`**。部署／启动 Coordinator 能力前应校验所使用的 Implementer GitHub 身份与 ChatGPT GitHub connector 身份满足该仓库授权；不满足时该协调通道不得宣称可用，应明确报告配置错误。自动化身份不因角色名称获得授权，也不绕过现有 allowlist。

它不分析业务争议、不裁决 Finding、不解析 Coordinator 业务结论、不代 Coordinator 回写 GitHub，也不根据模型输出自行决定唤醒哪个 Implementer。

Coordinator 的 GitHub 读取与回写由 ChatGPT 自己完成，与 Implementer 自己使用开发工具、提交代码和回复 GitHub 的责任模式一致。Coordinator 是现有“Runner / Harness 的 GitHub 通信统一复用本机 `gh`、不通过浏览器操作 GitHub”规则的**受控例外**：本机程序只通过 Safari 控制正常登录的 ChatGPT Web 来投递／续接 Coordinator conversation；ChatGPT 在该会话内使用已连接、已授权的 GitHub connector 读取和回写目标仓库。Runner 不抓取或转发 ChatGPT / GitHub cookie、token，也不建立自己的第二套 GitHub 登录系统。该例外只适用于 Coordinator 通道，不改变 Implementer / Runner 继续使用本机 `gh` 的规则。

Safari / ChatGPT 登录失效、投递失败、回复无法可靠取得等属于技术失败，不能记录成 Coordinator 已完成业务判断。V1 对这类低频失败不建立 pending 队列或自动 retry：本机通道必须留下明确可见的失败反馈／状态，使维护者知道本次协调没有完成；故障恢复后，由授权主体重新发布一条新的、完整的 `@COORDINATOR` 控制评论再次触发。旧失败触发不自动补执行。

## Coordinator conversation

V1 按原业务 Issue 维持 Coordinator conversation 绑定。同一 Issue 后续再次请求 Coordinator 时继续已绑定的 ChatGPT conversation，不为每条 Finding 新建 conversation。

同一个 Issue / Coordinator conversation 同一时刻只允许一个 Coordinator 调用写入。conversation 处于 starting / running / unknown 时，本机协调通道不读取该 Issue 的新 Coordinator 控制评论、不推进 Coordinator 自己的评论扫描水位，也不向正在运行的 conversation 注入第二条请求。当前 Coordinator 调用明确结束后，下一次扫描才读取原水位之后的新评论，并只取其中**最新一条**合法的 `@COORDINATOR` 控制评论；更早的 Coordinator 控制评论不排队、不补执行，普通／未授权评论不成为候选。claim / 水位推进与 active Coordinator run 的建立必须按与现有 Runner trigger 等价的条件式单写入者语义完成，避免同一本机轮询或重启重复投递；具体字段名和持久化布局仍由后续 Implementation 决定。

Safari / ChatGPT Web 是本机共享控制面，因此 V1 另外固定**机器级 Coordinator 全局并发为 1**，不提供 `maxConcurrentCoordinators` 等可调并发。只要本机任意仓库／Issue 存在 starting / running / unknown 的 Coordinator 调用，本机就不扫描其他仓库／Issue 的 Coordinator 新评论、不推进它们的 Coordinator 扫描水位，也不领取第二个 Coordinator 请求。当前调用明确结束或 unknown 被人工解除后，后续 polling cycle 才恢复扫描，并按各 Issue 自己的水位选择最新合法 `@COORDINATOR`。

如果重启或异常后无法确认旧 Coordinator 调用是否已经结束，则记为 `unknown` 并保守阻止新的投递。V1 不自动猜测结束状态；维护者确认旧调用已经停止／不再可能继续写入后，可以执行一个**明确、可审计的人工解除动作**，将该 Issue 的 Coordinator active / unknown 状态标记为已结束并记录解除时间、操作者和原因。解除本身不补执行旧触发，也不自动启动新调用；需要继续时由授权主体重新发布新的 `@COORDINATOR` 控制评论。

具体本机字段、Safari CLI 参数和持久化表示属于后续 Implementation，不在本 Contract 中提前冻结。

## Coordinator 首次启用与迁移 baseline

某个仓库第一次在本机启用 Coordinator，或把该仓库的 Coordinator 归属迁移到另一台机器时，先做一次**简单的历史 baseline**。baseline 完成以前，该仓库的 Coordinator 通道尚未正式接单。

V1 采用与现有 Runner 首次接入相同的简单语义：

1. 读取该仓库当前已有 Issue / Comment 的 Coordinator 相关扫描边界；
2. 把当时已有评论全部视为历史，只建立各 Issue 的 Coordinator 扫描水位，不执行其中任何历史 `@COORDINATOR`；
3. baseline 完成后，该仓库才开始正常增量扫描新的 Coordinator 控制评论；
4. baseline 期间恰好出现的新评论，可能在初始化完成时被划入历史而不执行；V1 接受这一低频边界；
5. 需要可靠执行时，在 baseline 完成后由授权主体重新发布一条新的、完整的 `@COORDINATOR`；
6. baseline 中断或失败时不建立 pending 队列，也不回放历史；下次从头重新做该仓库的 Coordinator baseline。

迁移到新机器时同样按上述规则重新 baseline，不搬运旧机器尚未处理的 Coordinator trigger 队列。**迁移由用户／部署者人工负责：启用新机器前必须确保旧机器已经不再运行该仓库的 Coordinator。** V1 只在部署说明中明确提示这一约束，不增加跨机探测、迁移握手、状态转移或程序级阻塞校验；如果旧、新机器同时运行同一仓库的 Coordinator，可能产生重复投递、重复回写或冲突结论。原有 ChatGPT conversation 是否能够继续复用，由后续 Implementation 在不破坏本 Contract 的前提下决定；不能确认时明确人工恢复，不把历史 `@COORDINATOR` 当成新请求重放。

## Coordinator 仓库归属与多机部署

每台机器通过自己的本地配置决定哪些仓库启用 Coordinator 通道；只有本机明确启用 Coordinator 的仓库，才处理该仓库的 `@COORDINATOR`。具体配置字段名由后续 Implementation 决定，不要求新增中央路由服务。

V1 将“**同一个仓库在任一时刻只由一台机器启用 Coordinator**”作为部署约束，由用户／部署者保证。即使同一仓库可以同时被 MB01、HZ01 等多台机器用于 Implementer 工作，也不应在多台机器上同时为该仓库启用 Coordinator。配置／启动说明必须明确提示：**请确保该 Repo 的 Coordinator 只在这一台机器运行；多台机器同时运行会导致重复投递、重复回写或冲突结论。** V1 不建设跨机发现、选主、分布式锁、迁移检查或自动重复配置检测；若发生误配，由用户修正本机配置恢复。

## 与现有 Runner trigger 的关系

`@COORDINATOR` 是 Coordinator 通道的保留控制命令；`COORDINATOR` 同时是保留名称，**不得配置为任何 Implementer 的 `runnerName`**。`@MB01`、`@HZ01` 等仍是现有 Implementer Runner 控制命令。这样两类命令在语法上互斥，都以原 Issue 评论作为显式交接记录。

Coordinator 回写的 return-to 评论仍必须满足目标 Runner 已有的授权与触发条件；Coordinator 身份或工具能力不绕过 Runner 授权规则。

本 Contract 不改变现有 Implementer task binding、START / RESUME、评论水位、单写入者或并发语义。Coordinator 触发、conversation binding 与 Safari 正式接入由后续 Implementation Issue 落实。

## V1 不做

- 自动 Review 裁判或自动介入每条 Finding；
- 新建独立协调 Issue；
- Runner 代写 Coordinator 结论；
- `AUTO_REPLY` / `NEED_HUMAN` 等业务结果协议；
- 自动 merge / deploy；
- 多 Coordinator 池、中央队列或复杂跨机调度；
- 为 return-to 新建业务路由数据库。
