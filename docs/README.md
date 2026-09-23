# 文档导航与权威

根 [README](../README.md) 是项目入口，[AGENTS](../AGENTS.md) 规定怎么工作。本目录区分目标、原因、证据与历史，不为不同角色维护不同版本的业务事实。

| 位置 | 回答的问题 |
| --- | --- |
| [current/](current/README.md) | 当前确认要做什么、支持到哪里；不表示已经实现。 |
| [decisions/](decisions/README.md) | 已接受的重要取舍及原因；待决问题仍在 Issue。 |
| [research/](research/README.md) | 某时点、某版本和环境实际查到或验证了什么。 |
| [archive/](archive/README.md) | 已失效的需求／Contract；不作为当前实现依据。 |
| [development.md](development.md) | 本仓库开发环境、验证顺序与真实就绪情况。 |

Issue 保存任务范围、问题、维护者决定及处理状态；PR 交付改动和验证。新决定改变长期行为时同步 Current；ADR 解释重要原因，Research 提供证据，二者不另维护一套当前需求。

代码与测试可能落后于 Current，应核对差异而不是用旧实现反推需求。工作规则和业务事实有冲突时先澄清，不用机械优先级掩盖冲突。

Current 路径不按版本号分目录；历史由 Git 追溯，必要时存 Archive。版本号如被采用只在 Current README 声明。Research 是时间点证据，不因变旧而移到 Archive；后续纠正需保留原结论及关联。
