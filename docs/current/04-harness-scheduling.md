# Harness 并发与轮询调度

## 目的

Runner 的并发能力必须由明确的调度 Contract 决定，而不是由当前代码中的同步 `await` 结构偶然决定。

本文件规定一台 Runner 机器和单个仓库可同时运行多少个 DeepSeek Harness、每轮最多领取多少新任务、满载时如何处理待领取命令，以及轮询与长时间 Harness 执行之间的关系。具体线程、Promise、子进程管理和内部队列结构属于实现细节。

## 两级并发上限

Runner 同时受机器级与仓库级两个上限约束。

### 机器级

`runtime.maxConcurrentHarnesses` 表示本机同时允许运行的 Harness 调用总数。

- 必须是正整数。
- 默认值为 `1`。
- 所有已接入仓库共享这一总槽位。
- 单实例 Runner 不等于单 Harness；一个 Runner 进程可以在上限允许时管理多个 Harness 调用。

### 仓库级

`repositories[].maxConcurrentHarnesses` 表示该仓库同时允许运行的 Harness 调用数。

- 必须是正整数。
- 默认值为 `1`。
- 仓库级上限只会进一步收紧本机容量，不能绕过机器级上限。

启动一个新任务前必须同时满足：

```text
machineActive < runtime.maxConcurrentHarnesses
AND
repoActive < repository.maxConcurrentHarnesses
```

## Issue 级 single-flight

机器级和仓库级容量之外，还有一条独立且更简单的任务约束：

> **同一个 repository + Issue 同一时刻最多只能有一个 Harness 调用。**

Runner 每轮考虑某个 Issue 时，先查看本机运行状态：

- 如果该 Issue 已有 Harness 处于 starting / running / unknown，直接跳过这个 Issue；
- 不为了这个 Issue 再启动第二个 Harness；
- 不读取或处理该 Issue 在运行期间新增的控制评论，也不推进该 Issue 的触发水位；
- 当前 Harness 明确结束后，后续 polling cycle 才重新检查该 Issue 当时最新的 GitHub 控制意图。

这个锁只作用于当前 Issue，不作用于整个 Runner，也不自动锁住整个仓库。因此：

- 同一仓库的其他 Issue，只要仓库级和机器级并发上限仍有容量，可以同时运行；
- 其他仓库的 Issue 也可以同时运行；
- 不需要为正在运行的 Issue 建立 pending / next-candidate 队列。

例如同一时刻：

```text
repo-A #1  -> running，跳过 #1
repo-A #2  -> 若 repo-A / machine 仍有槽位，可以启动
repo-B #8  -> 若 machine 仍有槽位，可以启动
```

例如：

```json
{
  "runtime": {
    "pollSeconds": 300,
    "maxConcurrentHarnesses": 3
  },
  "repositories": [
    {
      "repo": "owner/project-a",
      "maxConcurrentHarnesses": 1
    },
    {
      "repo": "owner/project-b",
      "maxConcurrentHarnesses": 2
    }
  ]
}
```

此配置允许整台机器最多同时运行 3 个 Harness，但 `project-a` 最多占 1 个，`project-b` 最多占 2 个。

## 每轮只领取一个新 Issue

一次 polling cycle 最多新增领取 **1 个 Issue**。

即使本机还有多个空槽、一次扫描发现多个合法命令，本轮也只允许其中一个任务进入 claimed / in-flight 并启动 Harness。已经在运行的 Harness 不计入“本轮新领取”。

首版不增加“每轮领取数量”配置项。机器并发上限控制“最多同时跑多少个”，轮询规则控制“每一轮最多新增多少个”；两者是不同约束。

因此一个机器上限为 3、轮询周期为 5 分钟的 Runner，可以表现为：

```text
10:00 领取 Issue A
10:05 领取 Issue B
10:10 领取 Issue C
```

前提是前面的任务仍在运行，且机器级与各自仓库级槽位都允许。

## 满载时不领取

若机器级槽位已满，本轮不需要继续为了领取新任务而扫描 GitHub，可直接结束本轮，等待下一个轮询周期或运行任务结束。

若机器仍有空槽，但某个仓库已经达到自己的仓库级上限，则跳过该仓库，继续考虑其他仍有容量的已接入仓库。

**没有槽位时不得消费待领取命令。** 符合 [Runner 激活与任务触发 Contract](03-runner-trigger.md)、且目标为本 Runner 的有效执行请求，在真正领取之前仍保持待处理状态：

- 不把它登记成已经执行；
- 不因为容量不足回复“忙，请重新发一次”；
- 不推进到会导致下轮忽略它的评论处理水位；
- 等后续有槽位时再正常领取。

“同一 Issue 已经有 Harness 在运行”不是容量不足意义上的待领取任务，而是 Issue 级 single-flight：该 Issue 本轮直接跳过，水位保持不动；Runner 继续考虑其他 Issue。当前 Harness 结束后，再由后续 polling cycle 重新读取该 Issue 当时最新的控制意图。

## 多仓库公平选择

多个仓库同时存在可领取任务时，Runner 不应永久从配置数组第一项开始而让后续仓库长期饥饿。

首版使用简单的 round-robin（轮转）语义，或实现上等价且可在正常重启后继续的公平选择方式：

1. 从上次成功领取后的位置继续考虑仓库；
2. 仓库无待领取任务或已达仓库级上限时跳过；
3. 找到第一个满足条件的仓库后，本轮只从该仓库领取一个 Issue；
4. 下一轮从后续仓库继续。

状态文件只需要保存足以恢复这一公平语义的信息，不要求固定内部字段名。

## 轮询与 Harness 执行解耦

Harness 调用可以持续很久，不能阻塞 polling loop。

Runner 应将“周期检查 / 领取”和“已领取 Harness 的持续执行”视为两个生命周期：

```text
poller / scheduler
    │
    ├── Harness A ─────────────►
    ├── Harness B ─────────────►
    └── Harness C ─────────────►

下一次 polling cycle 仍按配置时间发生
```

当已有 Harness 正在运行但机器仍有空槽时，后续轮询仍可再领取一个新 Issue；当机器已满载时，本轮不领取。

Harness 正常结束、失败或进入需要人工核对的恢复状态时，Runner 必须更新本机控制状态，使后续调度不会重复启动同一命令。跨崩溃 exactly-once 仍不承诺。

Runner 每次准备领取新任务前，都必须先依据持久化运行态恢复当前 Harness 占用，并在可行时与本机真实进程核对：

1. 能确认旧 Harness 仍在运行：继续计入 machineActive / repoActive；
2. 能确认旧 Harness 已退出：记录结果并释放槽位；
3. 无法可靠确认：进入 unknown，并**继续占用机器级和对应仓库级槽位**；
4. unknown 只有在后续探测取得确定结果，或维护者执行明确恢复／解除动作后才释放。

因此 Runner 重启本身绝不能把旧调用自动视为“已结束”。宁可暂时保守占槽，也不能因为状态不确定而再次启动同一任务，或让新任务突破并发上限。

## 轮询周期

`runtime.pollSeconds` 是 V1 调度 Contract 的可配置项，表示两次 polling cycle 之间的间隔。

- Contract 默认值为 `300` 秒，即 5 分钟。
- 部署者可以配置其他正整数值。
- 轮询周期只决定检查频率，不改变机器级/仓库级并发上限，也不改变“每轮最多领取一个新 Issue”。

当前接单运行代码尚未实现，因此这里不声称存在一个已部署的 60 秒默认值。后续实现直接以本 Contract 的 300 秒为默认值，并允许部署者显式覆盖。

## 状态与恢复

Runner 的本机状态必须能够支撑以下稳定语义：

- 区分尚未领取、已领取、正在运行、已结束和结果不确定的调用；
- 正常重启后不重放已处理命令；
- 能重建机器级和仓库级容量判断所需的信息；
- 能判断某个 repository + Issue 是否已有 starting / running / unknown Harness，从而维持 Issue 级 single-flight；
- 能继续多仓库公平选择；
- 已领取任务与尚未领取命令不能混淆；
- GitHub 回写失败不能导致同一 Harness 调用再次执行。

具体 JSON 字段属于本地状态 Schema 的职责；本文件只固定上述调度与恢复语义。对应的本机配置 / state Contract 由 Issue #17 / PR #18 单独收敛，在其成为 Current 前，本文件不把任何尚未合并的字段布局描述成现行事实。两份 Contract 发生交叉时，本文件定义调度语义，本地状态文档定义如何持久化这些语义。

## 不包含

本调度 Contract 不引入：

- 中央数据库或外部任务队列；
- 多 Runner 之间的分布式抢单或负载均衡；
- 动态 CPU / GPU / 内存资源探测；
- 自动按模型额度扩缩容；
- 一轮批量领取多个 Issue。

这些能力若以后需要，另开 Issue 修改 Contract 后再实现。
