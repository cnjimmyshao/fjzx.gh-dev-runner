# Architecture Decisions

ADR 保存已接受的重要取舍与原因，不替代 Current，也不作为另一份待决问题清单。尚未决定的事项留在关联 Issue；获批后若值得长期解释，再补 ADR 并同步 Current。

按 `NNNN-<topic>.md` 命名。简单记录状态、背景、决定、代价与依据即可，不为每个局部实现写 ADR。改变既有决定时保留历史并说明替代关系。

| ADR | 状态 | 主题 |
| --- | --- | --- |
| [0001](0001-local-polling-and-session-handoff.md) | PARTIALLY_SUPERSEDED | 本地轻量接单与任务绑定继续有效；Web 接入部分由 0002 替代 |
| [0002](0002-headless-cli-execution.md) | ACCEPTED | 直接启动 Harness headless CLI，模型 Key 本机保存，不依赖 Web 服务 |
