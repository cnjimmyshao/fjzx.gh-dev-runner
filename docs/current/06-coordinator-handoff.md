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
4. 评论 trim 后以 `@COORDINATOR` 结尾。

return-to 是显式交接信息。Coordinator 不根据评论作者、机器历史或其他隐含状态猜测。原 Implementer 若为 HZ01，就明确写“处理完成后请交回 @HZ01”。

发出协调请求后，Implementer 结束本轮 Harness 调用，不长期占用运行态；原 task binding、workspace、branch、PR 和 session 保留。

## Coordinator 工作与回写

Coordinator 被唤醒后自行读取原 Issue 最新决定、相关 PR / Review、项目 AGENTS、Current 和必要 ADR。Safari / 本机投递内容只负责定位和唤醒，不替代 GitHub 上的真实上下文。

Coordinator 可以在已经确认的 Requirement / Contract / ADR / Issue 决定范围内判断 Finding、解释现有规则并给出下一步，但不因承担协调角色自动取得 Maintainer 权限。

能够继续时，Coordinator **自己使用 GitHub 能力**在原 Issue 发布结论，并以请求中明确的 return-to Runner 结尾，例如：

```text
……协调结论与下一步……

@MB01
```

这条评论随后按现有 Runner trigger Contract RESUME 原 Implementer task / workspace / session。

如果问题需要改变 Requirement、业务语义、长期 Contract、范围、权限或其他 Maintainer 决定，Coordinator 在原 Issue 说明待决项、依据和影响后停止，不附加 return-to Runner，也不把候选方案冒充已批准决定。Maintainer 作出决定后，需要继续时仍按现有规则发布新的 `@<runnerName>` 控制评论。

## Runner / 本机协调通道边界

Runner / 本机协调通道只负责识别合法 Coordinator 触发、投递或续接对应 ChatGPT Coordinator conversation，以及必要的会话绑定、去重、运行状态和技术失败信息。

它不分析业务争议、不裁决 Finding、不解析 Coordinator 业务结论、不代 Coordinator 回写 GitHub，也不根据模型输出自行决定唤醒哪个 Implementer。

Coordinator 的 GitHub 读取与回写由 ChatGPT 自己完成，与 Implementer 自己使用开发工具、提交代码和回复 GitHub 的责任模式一致。

Safari / ChatGPT 登录失效、投递失败、回复无法可靠取得等属于技术失败，不能记录成 Coordinator 已完成业务判断。

## Coordinator conversation

V1 按原业务 Issue 维持 Coordinator conversation 绑定。同一 Issue 后续再次请求 Coordinator 时继续已绑定的 ChatGPT conversation，不为每条 Finding 新建 conversation。

具体本机字段、Safari CLI 参数和持久化表示属于后续 Implementation，不在本 Contract 中提前冻结。

## 与现有 Runner trigger 的关系

`@COORDINATOR` 是 Coordinator 通道的控制命令；`@MB01`、`@HZ01` 等仍是现有 Implementer Runner 控制命令。两者都以原 Issue 评论作为显式交接记录。

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
