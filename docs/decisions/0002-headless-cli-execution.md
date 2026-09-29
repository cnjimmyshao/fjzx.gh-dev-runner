# 直接启动 Harness headless CLI

Status: ACCEPTED
Date: 2026-09-23
Partially Supersedes: [ADR 0001](0001-local-polling-and-session-handoff.md) 的常驻 Web 接入与原网页观察部分

依据：[Issue #3 的维护者决定](https://github.com/cnjimmyshao/fjzx.gh-dev-runner/issues/3#issuecomment-5795769722)；文档同步任务为 [Issue #5](https://github.com/cnjimmyshao/fjzx.gh-dev-runner/issues/5)。

## 背景与决定

维护者选择简化部署：模型 Key 本机配置并保存，小接单工具直接启动 Harness headless CLI，不再依赖已有 `dsh web`。原 Web 实验说明另一条路径的调查结果，并非证明 CLI 方案已通过；本次变化来自维护者取舍，不是实验推翻。

GitHub 通信复用本机 `gh`。执行与模型调用交给 Harness，小工具只承担接单、路由、进程调用、任务绑定和必要反馈。保持原有多项目、多机、独立工作目录和同任务续接；新进程仍须使用已保存的会话标识与匹配配置，不默认为新任务。

## 代价与边界

不再承诺原 Web 界面实时观看，首版使用终端／本机日志，不新增替代 Web 界面。Web 启动 URL、cookie 引导、控制台令牌抓取及 Web 认证改造均不进入首版。

工具需要保存并保护本机模型凭据、任务绑定与处理进度，并读取真实进程结果；不重写 Agent 循环、审查裁判或自动恢复系统。保留授权、去重、单任务单写入者和不自动合并的边界。

## 验证状态

这是已确认的目标决定，不是本机实测结论。文档合并后另由 DeepSeek 在指定电脑验证首轮执行、进程退出后同会话续接及输出／失败信号；实际版本和最小调用方式留在对应 Research。旧 Research 保留并按原范围收尾，不删除或伪装成 CLI 证据。
