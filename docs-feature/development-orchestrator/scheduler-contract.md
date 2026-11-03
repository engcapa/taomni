# 开发编排：调度与执行契约

- 状态：2026-11-03 讨论稿，配合[主设计](../development-orchestrator-design.md)。以下类型、表、命令均为**拟新增**，不是当前 API。
- 目的：把“能启动多个 agent”推进到“任务有唯一所有者、依赖正确、错误不伪装成功、可取消和可恢复”。
- v0.4：首片八表 / 四目录、NDJSON候选持久化、Bootstrap与构建池锁；成本由用户定义。领域对象是远期合同，具体阶段以 §8.1 和 [TASK清单](p0-p1a-implementation.md) 为准。

## 1. 必须成立的不变量

| ID | 不变量 |
| --- | --- |
| INV-01 | 一个 task generation 最多有一个未确认停止的活动 attempt；一个 session 同时最多执行一个 attempt |
| INV-02 | 所有派发必须能追溯到已授权 graph revision、策略版本、输入快照和实际 profile 配置 |
| INV-03 | 资源预留与任务占有在同一事务中完成；进程真正停止前不能把写现场交给新 attempt |
| INV-04 | 迟到事件和失效 owner 不能改变当前 task 状态、批准权限或发布产物 |
| INV-05 | Worker 完成、产物生成、验证通过、用户接受是不同事实 |
| INV-06 | 取消确认只代表协议请求已收到；只有执行树停止或被明确隔离后才可完成清理 |
| INV-07 | 没有可验证幂等机制的外部副作用不自动重放；不宣称任意工具 exactly-once |
| INV-08 | 验证回执绑定候选内容和验证配置；输入变化必须使相关证据失效 |
| INV-09 | UI 不是执行所有者；renderer 消失不丢任务状态，也不自动表示用户批准 |
| INV-10 | 未知 usage、未知进程状态、未知副作用结果不得用 0、成功、已停止替代 |
| INV-11 | pack 的成员独占、来源 / 输出完整、独立门和发布组不因合包改变；真实调用 / 费用只记一次 |
| INV-12 | 少调用预算覆盖辅助模型、SDK 重试和补救，不能通过换协议或隐藏工具续轮规避 |

## 2. 核心数据对象

### 2.1 身份与版本

- `WorkflowDefinition`：可复用模板，声明输入、节点、依赖和验收；不存活动进程。
- `WorkflowRun`：一次开发意图，含仓库、授权、策略、当前 graph revision、整体验收与控制状态。
- `TaskNode`：一个工作包及其交付契约，属于不可变的 graph revision。
- `TaskAttempt`：一个节点的一次执行，含 task generation、实际配置、输入、owner、执行结果与清理状态。
- `ExecutionProfile`：adapter 类型和用户配置引用；修改产生新 revision，不修改已运行 attempt。
- `SessionRef`：`adapter + profile_id + profile_revision + agent_version + session_id + storage_root_id`；不能跨 provider 复用一个裸 session ID。
- `OperationRecord`：启动、创建 worktree、运行命令、应用 Git 变更等外部动作的 intent / observation / result。
- `ArtifactRef`：不可变产物的内容 hash、类型、base / tree、生成 attempt 和存储引用。
- `GateReceipt`：对精确 ArtifactRef 的验证结果；生成者、平台、工具链、命令 / 用例、报告与时间可追溯。
- `ApprovalRequest`：绑定具体 attempt、操作参数摘要、权限范围、policy revision 和过期时间。
- `ContextBundleRef`：独立 API / CLI 实际输入的资料 manifest、source hash、必要项、omission 与目标模型容量记录。
- `LogicalSessionRef / SessionBranchRef`：Taomni 逻辑协作空间；一个分支可映射多个串行原生会话，不能用裸 session ID 代替。
- `HandoffRecord`：跨 backend 接续的版本化任务、证据、决策与未决项；不伪造原生 resume。
- `MemoryReadSet`：本次使用的项目记忆 ID / revision / 作用域；批准知识与模型候选分开。
- `DecisionRecord`：规则 / Jev / LLM / agent 的建议、实际输入、候选与采纳规则；不自动成为授权。
- `TriggerSpec / TriggerOccurrence`：手工、定时或仓库事件触发定义与去重身份，触发创建 run 不等于绕过准入。
- `InferencePack / PackCallAttempt`：多个 member task 的一次联合 / 同类生成、输入快照、输出契约与发布组；不是 Provider Batch 文件。
- `BillingProfile / CallBudget / RequestLedger`：用户单位 / 系数、主 / 辅助 / 恢复 / transport 尝试、预留与实际观察，费用算术由程序执行。

ID 使用不可碰撞标识；用户任务标题仅用于显示。仓库身份以 canonical common-dir 为基础，另保留用户路径用于 UI。

### 2.2 节点契约示例

下面是逻辑类型，实施时以 Rust / IPC schema 统一生成或校验，不手写多份漂移的定义：

```text
TaskNode {
  id, run_id, graph_revision, generation,
  kind: coding_agent | llm_call | llm_agent | builtin,
  role, goal, scope, task_type,
  context_recipe_ref, context_selection, session_mode, memory_policy_ref,
  decision_policy_ref?, external_execution_mode?, invocation_mode, pack_policy_ref?,
  billing_policy_ref?, call_budget_ref?,
  dependencies: [
    { task_id, output_name, required_assurance: produced | verified }
  ],
  input_snapshot_spec,
  output_contract,
  required_capabilities,
  execution_policy_ref,
  resources,
  deadlines,
  retry_policy,
  authorization_ref
}

TaskAttempt {
  id, task_id, generation, attempt_number,
  effective_profile_revision, effective_config_digest,
  input_snapshot, owner_incarnation, fencing_token,
  logical_session_ref?, session_branch_ref?, native_session_ref?, worktree_ref?,
  context_bundle_ref, memory_read_set, decision_refs[], external_workflow_ref?,
  status, stop_reason?, cleanup_status,
  last_transport_event_at?, last_progress_at?,
  request_count, tool_count, usage_refs[],
  started_at?, finished_at?
}
```

模型原生 effort / thinking 参数放入受校验的 profile 配置，不假设不同厂商的 `high` 相等，也不接受“提示词指定模型”作为设置生效证据。

### 2.3 状态与交付事实

**Run 控制状态**：`draft → awaiting_authorization → active`；另有 `draining / paused / cancelling / cancelled / failed / needs_attention / ready_for_acceptance / accepted`。

- `draining`：不派发新 attempt，允许当前工作收敛；没有活动执行后变 `paused`。
- `paused`：恢复必须重新校验策略、输入、凭据和未完成操作。
- `ready_for_acceptance`：必需验证完成、无冲突、无未知副作用，但用户尚未接受。
- `accepted`：接受的是指定候选版本；是否已应用、已提交、已 push 由独立操作记录表达。
- `needs_attention` 是明确阻塞，须带原因和可执行的下一步，不能混成永远转圈的 running。

**Task 状态**：`planned / blocked / ready / active / produced / failed / cancelled / superseded / needs_attention`。

- `produced` 表示该节点的输出契约满足。例如实现节点产出候选 patch，不意味着开发验收通过。
- 验证节点的输出是可信执行器生成的 GateReceipt；检查失败时节点为 failed，不产生通过回执。
- 依赖边必须声明消费普通产物还是经过验证的产物。已冻结的契约可以先授权为 verified，再并行开发。
- RunAcceptanceSpec 指定必需 gate、覆盖范围和人工接受条件，不能由 worker 口头取消。

**Attempt 状态**：`reserved → preparing → executing → collecting → completed`；可能进入 `awaiting_input / stopping / failed / cancelled / lost / needs_attention`。

`completed` 仅是执行契约成功结束：仍要检查输出 schema、快照和停止原因才可把 Task 标记 produced。保留 `truncated / refused / max_turns / timeout / protocol_error / process_lost` 等原因，不折叠成正常完成。

执行事实与 Run 控制状态分开：用户取消整个 run 时，已经实际产出的节点仍保留事实，不抹成“从未执行”。

## 3. 用户策略解析与执行身份

### 3.1 准入顺序

按以下顺序校验，任何硬条件不满足就不启动：

1. 应用级 AI 禁用 / 本地网络策略 / 仓库可信性。
2. 用户授权的范围、graph revision 和操作类型。
3. 输入产物、Git 基线、工具链与依赖是否有效。
4. 角色候选列表及 adapter 能力是否匹配。
5. Vault / 凭据、代理配置是否可解析。
6. 资源池是否有可预留容量。
7. 可选用户成本策略是否允许；未配置则不启用金额判断。

启动前和每个受控请求 / 工具边界再次校验可撤销的权限。限制运行中外部 CLI 的能力若不足，明确展示为部分强制，而不是宣称全程 fail-closed。

### 3.2 选择规则

- 用户 pin 优先；任务 / 能力 / 质量过滤后，按用户 ordered / cost_aware / pareto_ask 策略及可比单位选择，无就绪候选则 wait / ask / fail。系数未知不是零费用，不以 Jev confidence 代替质量证据。
- 可配置 Jev / LLM / 只读 agent 对合法候选提供语义建议；仅在用户启用 semantic selection 时采纳，不能覆盖 pin、扩大候选或绕过规则。见 [decision-and-routing.md](decision-and-routing.md)。
- 选择完成就钉住 profile revision 与实际模型，记录为什么选中、为什么跳过其他候选。
- 模型组、key rotation 与 fallback 都可能改变执行身份；编排首版应显式解析，不沿用无记录的聊天轮换。
- 为某个模型创建独立 provider 实例，不修改应用当前默认模型，不让并行任务互相覆盖设置。
- 统一配置跨任务复用。新草稿在发送时解析并冻结resource / plan revision；配置保存只影响后续提交，**已提交但尚未启动的任务也保留旧快照**，不能在等待队列里静默换模型。需要切换就显式重新确认；撤权 / AI禁用等安全收紧即时生效。
- 不能通过换 profile 绕过权限拒绝、安全拒绝或用户禁止的资源。

### 3.3 能力不匹配的处理

- 用户要求可恢复会话，但 agent 只支持新会话：在计划阶段说明，不能假装 resume。
- 用户要求严格目录隔离，但只有 cwd：拒绝严格模式，或让用户明确选择更弱的执行等级。
- 用户要求严格总并发，但 CLI 可隐藏地启动无限子 agent：不准入严格池。
- 用户要求硬金额上限，但只能在回合结束后得到估计 usage：不能声称硬限制可用。
- 原生审批 / 模型选择接口不支持时，要求换已授权 profile 或改策略，而非静默替代。

## 4. 资源模型与公平性

### 4.1 多维资源池

| 资源 | 消耗时段 | 目的 |
| --- | --- | --- |
| 全局 active attempt | reserved 至终止并确认清理 | 防止任务 / 审批大量堆积，作为用户可理解的上限 |
| Profile session | 活动 attempt 生命周期 | 避免同一实际 agent session 重入 |
| 账号 / endpoint request | 单个受控网络请求 | 限流与 backpressure；账号归组由用户定义，不泄露密钥 |
| Repo writer | 写任务执行和现场收集期 | 限制同仓库并行变更及后续集成压力 |
| Worktree owner | 现场存在且可能有写进程时 | 禁止同一现场交给两个 attempt |
| Git metadata operation | 创建、删除、组合、ref 更新等短操作 | 保护 linked-worktree 共用元数据 |
| Heavy build | 构建进程真正存活期间 | 控制 CPU / 内存 / 编译缓存争用 |
| Native test environment | 测试实例与其子进程存活期间 | 避免同一桌面 / 窗口互相干扰 |
| Bootstrap / dependency publish | 指纹对应的依赖准备 / 发布期 | 不共享用户可写 node_modules，不重复发布同一托管快照 |
| Build pool `canonical-target-dir` | 真实 cargo / 编译命令与回执复制期 | 同池独占，和 Heavy slot 原子取得，避免 Cargo 内部 build lock 阻塞 |

等待审批仍占 active attempt 和 worktree 所有权；没有网络请求时可释放 request slot。长时间等待输入可按用户策略停止 / 停放进程，但不能因此放弃写现场所有权。

资源 lease 到期**不代表进程已死**。到期先 reconciliation；不能立即释放 writer、创建重试，让旧进程和新进程共写。

资源按阶段原子取得，未启动的构建不提前占 Heavy / pool；同阶段不持一部分等待另一部分。Git 短锁不跨 install / 模型 / build。worktree ready 必须有 BootstrapReceipt，不因目录创建就执行检查；依赖指纹、pnpm store / 私有布局、Cargo pool、绕锁降级见 [workspace-bootstrap.md](workspace-bootstrap.md)。

### 4.2 队列策略

- 先在各 workflow 之间做带权公平轮转，默认权重相等。
- 各 workflow 内：用户优先级 + 等待老化；关键路径和现场亲和性作稳定的次级排序。
- 不符合资源要求的任务跳过本轮，不堵住完全不相关的仓库 / workflow。
- 对长期等待的大资源任务保留公平性，不能被连续的小任务永久饿死。
- 不用模型自己声明的“我更紧急”调整优先级，不用模型输出修改资源配额。

缓存亲和性仅是性能提示，不降低授权标准，也不作为自动成本路由。不同模型 / provider 的缓存不能假定通用；不预热真实付费请求作为心跳。

## 5. 调度循环与事务边界

事件驱动为主，配一个低频 reconciliation 定时器；工作流没有变化时不调用 LLM。

```text
on wake:
  reconcile owners, leases, deadlines, pending operations and finished attempts
  fold newly satisfied artifact dependencies into ready set
  for each run selected by fairness:
    inspect eligible tasks and explicit wait reasons
    evaluate policy and effective profile
    transaction:
      compare task revision and generation
      verify no live or unresolved attempt
      reserve all required resources
      insert attempt + prepare operation intent + outbox record
      set task active and increment revision
    supervisor consumes outbox using operation_id
    publish durable state event
```

关键规则：

- DB 中 claim 成功后才能启动；启动失败也必须产生失败回执并清理资源。
- 外部启动和数据库不可能天然原子，使用 operation_id、owner 握手和 reconciliation 收敛。
- 重复消费 outbox 不直接再次 spawn；先检查已登记 owner / 运行操作。无法判断则标为 unknown。
- 一个调度 actor 串行处理状态变更，adapter I/O 在外并行执行；持有 DB 锁或 scheduler 锁时不等待 LLM / 子进程。
- SQLite 条件更新 / 唯一约束是最后防线，不能只靠内存布尔值防重入。
- ContextCompiler / 语义决策 / 记忆检索可能需要 I/O 或模型调用，在调度锁外执行。先冻结 task / policy / source revision，准备结果再以 CAS 提交；过期结果丢弃。持久化 preparation owner，不能让多个 wake 重复调用付费服务。
- 配置默认模型改变不得污染已编译 bundle；真正调用前复核 context hash、目标 model 容量、授权和输入版本。

### 5.1 定时和事件触发

借鉴 KiroCrew / Gas Town 的长期调度用途，定义 `TriggerSpec`，首版可从手工触发开始，不能把“拥有 cron parser”当完整任务调度：

- `manual`、`schedule`、`repository_event` 创建 workflow run，之后仍过同一依赖、授权和资源准入。
- schedule 固定时区、DST 处理和 `misfire=skip|latest|bounded_catch_up`；恢复不能一次补跑无限过期任务。
- overlap 策略为 `forbid|queue|allow_with_cap`；默认 forbid，既有未确认停止 run 仍算重叠。
- 以 `trigger_id + trigger_revision + scheduled_occurrence`，或受验证的外部 event ID 去重；唯一键原子创建 run。
- 修改 / 暂停 trigger 不改变正在运行的授权事实；是否停止当前 run 必须是单独操作。
- trigger 指向用户已授权模板 / 策略，源码或权限范围变化须重审。不能执行仓库事件里携带的任意 shell。
- 仓库事件首版可先本地观察 / 手工导入；远程 webhook 服务不在本稿默认部署范围。
- 宿主未运行且没有 supervisor 时不会凭空按时触发，重启按 misfire 处理并显示错过记录。

### 5.2 多任务单次推理

- P1A 仅用户显式 / 已确认模板建 pack；规则只检查合法性，不自动合包。设计 / 静态复核和总计 ≤3 文本文件的有界 patch 逐项开门；独立验收 / 真反馈边不融合。
- 原子 claim 所有 member generation 并创建 member attempt；持久化 PackCallAttempt，禁止成员另行派发。单个实际生成占一个 request slot，member 任务和 gate 不消失。
- preparation 本地收集 / CodeGraph 展开资料；若用模型摘要 / 判断，先消费辅助 CallBudget。发送前冻结 bundle 和 pack revision，只有主生成许可才发出。
- 默认 NDJSON 增量分帧：完整 item 先落盘 candidate + 事件，不等整个 JSON / pack 闭合；最终按协议终态、成员 / source 覆盖和 publication group 验证后才 produced / 发布。截断保留有效前缀但冻结自动发布；费用 / usage 仅记一次。
- 请求后取消单成员默认撤发布资格，不假装可从一个上游生成单独停止；授权紧急撤销或整包取消则停止整个请求。未确认结果仍保留 call reservation。
- main=1 / auxiliary=0 / recovery=0；截断 / 无效 / unknown 保留 / ask。用户确认才允许一次 recovery 新请求，带失败范围和旧候选引用；不自动 JSON 修复、重发、工具续轮，也不把候选恢复当免费续流。

详见 [packed-inference-and-code-context.md](packed-inference-and-code-context.md)。

## 6. ExecutionAdapter 契约

### 6.1 生命周期

概念接口，不要求为不支持的功能提供虚假实现：

```text
describe_capabilities(profile) -> capabilities + evidence
prepare(attempt, snapshot, policy) -> prepared | unsupported | failed
start(prepared, owner) -> handle
observe(handle) -> normalized events
interrupt(handle, reason) -> requested | unsupported
terminate_tree(handle) -> stopped | unknown
reconcile(persisted_attempt) -> running | stopped | recoverable | unknown
resume(checkpoint, effective_policy) -> resumed | requires_fresh_attempt | failed
collect(handle) -> execution receipt + artifact references
```

进程退出、协议最终消息、输出产物、清理完成分别观察。`start` 返回 handle 不代表任务成功；`interrupt` 返回请求已接收不代表已停止。

额外描述 context 交付方式、session 模式、真实隔离等级与内部子执行可见性。外部系统分 executor / delegated-workflow / observe，不能两个控制面同时 claim 同一 task / worktree。opaque 子工作流没有内部并发证据时，不准入宣称严格全局限额的资源池。

### 6.2 事件与迟到结果

持久语义事件至少包括：

```text
EventEnvelope {
  run_id, graph_revision, task_id, generation, attempt_id,
  owner_incarnation, fencing_token,
  source_event_id?, source_sequence?, run_sequence,
  event_type, payload, observed_at
}
```

- 所有状态变更使用 attempt / generation / fencing token 校验。
- 数据库为每个 run 分配单调序号；adapter 时间戳不决定先后胜负。
- 有 provider event ID 时按 ID 去重；没有时不要按相同文本去重，两段重复输出可能是真实事件。
- 原始 token delta 可临时流式、合并写日志；终态、工具操作、审批、产物及 gate 必须落盘。
- 发现协议事件丢失 / broadcast lag 时保留不完整标记，不能凭最后一个 End 推断完整执行。
- 旧 attempt 的迟到产物可以保存在隔离区作为诊断，不得覆盖当前有效产物或自动集成。

### 6.3 Headless 工具执行

直接 LLM agent 所用的文件、命令与 Git 工具必须由 Rust runtime 执行；UI 只处理审批和展示。

不要复用必须等待 renderer 完成副作用的 `dispatch_side_effect` 作为后台执行能力。现有 MCP 的鉴权、scope、安全分类可共享，但编排 scope 需要收紧到授权 repo / worktree，不暴露全局连接、生产数据库或任意终端。

工具执行前写 OperationRecord；执行后保存真实回执。输出大小限制、临时文件、deadline、取消 token 和进程树都属于工具 owner，不能把清理交给组件卸载。

## 7. 超时、停止与重试

### 7.1 四种时限分别记录

- **排队时限**：等资源太久，不启动就过期；不是模型失败。
- **启动时限**：spawn、认证、协议初始化、准备现场。
- **Transport idle**：没有事件；与进程仍存活、模型正在思考分别判断。
- **总 wall-clock / 无进展时限**：不让持续刷心跳绕过任务期限；等待人工的计时规则单独配置。

单个 request timeout 不等于任务 timeout。ACP 当前总请求超时、Codex / CC 的 idle 语义需要在 adapter 层映射清楚，不能共用一个含义不明的 timeout。

### 7.2 取消顺序

1. 写入取消意图并停止后续派发，阻止新的受控请求 / 工具。
2. 作废待审批，标记 waiting input 已结束。
3. 尝试协议 interrupt / cancel，给配置的宽限期。
4. 受控终止进程树：Unix process group；Windows Job Object 等平台能力必须由原生测试验证。
5. 撤销 MCP token，清理尚未执行的工具请求，关闭事件通道。
6. 收集部分产物、验证进程终止，再释放资源。

不能证明已停止则 `needs_attention` 并保留现场占有；不能静默显示 cancelled 并重新派发。上游 API 可能继续生成 / 计费，也不能自动回滚已经执行的命令。

取消和完成竞态以持久提交点处理：已提交的产物保留；取消先提交则禁止后续自动发布，只能保留 partial。Git ref 已经实际更新时按 journal 对账显示事实，不谎称取消恢复了原状。

### 7.3 有界重试策略

| 失败 | 默认建议 |
| --- | --- |
| 429 / 明确可重试 5xx | 按 Retry-After 与退避 + jitter 重试，受 task 总重试上限约束 |
| 认证失败 / Vault locked / 代理错误 | 等用户处理，不换 key / 直连 / profile 绕过 |
| 不支持模型 / 参数 / schema | 配置错误，先修配置，不盲重试 |
| 用户拒绝 / 安全拒绝 | 停止相关动作；不能换 provider 规避 |
| 测试失败 | 生成有界修复工作包，不重复同一 prompt 冒充网络重试 |
| 输出截断 / max-turns | 保留产物与原因；明确续接或新 attempt，不标成功 |
| 网络断线且请求结果未知 | 先核查是否已有结果；不能承诺重发不重复计费 |
| 命令 / Git 外部动作结果未知 | 先检查后置条件，无法确认则人工处理 |

下层 SDK 重试也计入可观察的总尝试数，避免 adapter、provider router、scheduler 各重试一层造成乘法放大。首次可只支持有限重试，不引入自动学习策略。

## 8. 持久化、操作 journal 与恢复

### 8.1 分期存储：首个闭环最多八张业务表

使用独立 `orchestration/state.sqlite3`；以下是**唯一 Schema 分期清单**，其他文档列的领域对象不再一对象一张表。P0/P1A 不预建后续空表，不引入通用事件溯源框架。

| 阶段 | 新增业务表 | 实现边界 |
| --- | --- | --- |
| P0 | `runs / tasks / attempts / artifacts / events`（5） | 计划 / 状态、原子 claim、资源与操作 intent、假执行器、恢复 |
| P1A | `context_bundles / inference_packs / request_ledger`（+3，累计8） | 三协议、显式合包、调用预算、分帧 candidate、一个 CC bridge、Bootstrap |
| P1B | `logical_sessions / handoffs / approvals / gate_receipts`（+4） | Codex / portable handoff、可查询审批与验证投影、受控集成 |
| P2 | `memory_records / decision_records / triggers`（+3） | 正式项目记忆、shadow / bounded_auto 决策、可选定时；其余表按实际负载另立设计 |

schema version 用 SQLite `PRAGMA user_version`，编号迁移由 store 持有并事务执行；不把现有目录 `migrate.rs` 当 schema runner。待迁移数据有校验 / 失败回滚；旧程序遇到更高版本拒绝打开，不盲写。

**精简表数不能删除可靠性语义，P0/P1A 的归属明确如下：**

| 原拟独立对象 | 早期实际持久化 / 事务边界 | 以后何时拆 |
| --- | --- | --- |
| graph revisions | `runs.plan_revision + plan_artifact_id`，不可变 typed 计划存在 artifacts；tasks 引用 revision | P1A 只人工确认 / 修订；确需跨图查询再提表 |
| resource leases / session leases | `attempts` 的 owner、fencing、session / worktree / build-pool 键及 typed 资源声明；未确认停止的记录仍占位 | owner lock + 单调度器 + SQLite 写事务准入；不先做分布式 lease 系统 |
| operation journal / outbox | `events` 的结构化 `operation_intent / observation / outcome`，带 operation_id、scope、序号；物化状态和事件同事务 | pending 由未有终态的 intent 查询，派发仍须对账，不做无脑事件重放 |
| approvals | P1A 审批 request / resolution 在 events，包含参数摘要、scope、revision / 到期；无 UI 时保持暂停 / 拒绝 | P1B 增 approvals 投影，迁移时校验；不能因为表后置就跳审批 |
| gate receipts / handoff / bootstrap | typed artifacts + 引用事件；由可信执行器生成验证回执 | P1B 增强查询，artifact 身份和历史不变 |
| pack members / PackCallAttempt | `tasks.pack_id` FK、`attempts.pack_call_id → request_ledger.id` FK；pack_call持久状态由预留ledger行和typed member manifest承载，尚未发送标reserved，不算已调用。成员claim / ledger预留同事务 | 不在 P1A 增 pack_members / pack_call_attempts 表 |
| budget reservations | `request_ledger` 中 policy / pool / request / reserved / observed / unknown；attempt 内部池键 | 每次发送前同写事务计算余量并预留；unknown 不释放 |
| memory proposals / read set / decision advice | P1A 只保留 namespace / source / revision 的 typed artifacts，读用户选定的批准资料；不自动提炼 / 检索常驻知识库 | P2 合并进 memory_records，status 区分 proposed / approved，无需三张 proposal / usage 空表 |
| trigger occurrences | P2 `events` 中 trigger_id / revision / occurrence 唯一键，原子创建 run | 不在 P1A 做 cron；量大再评审拆表 |

核心身份、status、revision、FK、claim / 去重键、事件序号和预算字段必须有 typed 列、约束 / 索引；JSON payload 仅保存有 schema_version 的领域明细。活动 session / worktree owner 建partial unique约束，pool容量由单写事务计算；unknown旧attempt不释放。

最少约束：`UNIQUE(task_id,generation)`针对未停止活动attempt；`UNIQUE(run_id,sequence)`、source_event去重键、`UNIQUE(operation_id,phase,phase_sequence)`；`request_ledger`含request_kind、policy_revision、budget_pool、charge_unit、reserved_amount、observed_amount?、request_status和parent_recovery_id?。费用使用integer micro-unit或精确定点表示，状态未知不归零，未发预留不计实际生成。

恢复产生新ledger行和append-only候选manifest revision；member当前pack_call引用可更新，但旧关联必须保留在事件 / artifact来源。固定pack_id不是仅能存一次请求的去重键，不能阻止合法一次恢复，也不能覆盖原失败记录。

`events` 是有界操作 journal，不是从 token 流重建全部状态：操作前和终态提交事务，网络 / 进程 I/O 在事务外；恢复先看物化行 + 未结 intent / 实际后置条件。表少不能变成只有内存 handle。

大正文 / 日志在私有 ArtifactStore。完整帧先 flush（需要可承诺的磁盘恢复时 sync）、hash、原子落盘，再在同事务插 artifact 引用和 frame_saved 事件，最后通知 UI；半帧只留诊断，不伪造闭合。孤儿文件 / 孤儿 intent 在启动时对账。

WAL 使用 SQLite snapshot / backup API 接入备份；恢复备份只恢复历史，不自动恢复授权和启动任务。下载 / 自动安装 agent 不在首版范围。更多上下文语义见 [context-session-memory.md](context-session-memory.md)，本节分期优先于其中的远期接口。

### 8.2 Owner 与 fencing

- 单机内核持有独立 OS owner lock，避免同一数据目录两个进程都当调度主控。
- 每次宿主启动产生新 incarnation；每个 claim 产生 fencing token。
- token 防止迟到回调写状态，但**不能阻止失联进程继续改文件**。
- 因此失去 lease 后先查实际进程 / 现场；进程未知时隔离 worktree，不复用、不集成、不自动删除。
- PID 可能复用，不能只看 `kill(pid, 0)`；须结合进程创建身份、supervisor 记录和平台句柄能力。

### 8.3 外部副作用的幂等边界

OperationRecord 最少包含 `operation_id / intent / target / expected_precondition / observed_result / state`。

- 创建 worktree：路径、Git 注册与 ownership marker 均匹配才能复用；已有未知目录不能覆盖。
- 执行命令：没有业务幂等保证时不自动重放 lost command；退出码丢失不能自动补成成功。
- 应用 Git：使用 expected-old ref 等 compare-and-set 语义；崩溃后比较实际 ref / tree / 操作状态，不重新执行一遍。
- 请求 provider：有官方请求幂等机制时按其语义使用；否则 unknown receipt 仍可能产生第二次请求和费用。
- 外部 push / 发布：需要独立授权与后置条件检查，不属于默认重试。

### 8.4 启动恢复流程

1. 获取 owner lock，打开 DB 并验证 schema。
2. 读取非终态 attempts、未完成 operations、审批与现场索引。
3. 对账进程身份、session 存储、worktree、ref 和产物完整性。
4. 已完成但未记账：根据可信后置条件补 observation，不伪造原始执行证据。
5. 可续接：校验 profile / agent 版本、输入摘要、权限、配置和存储，提出恢复。
6. 不可续接：标 lost / interrupted，保留现场，允许新 attempt 从已确认产物继续。
7. unknown 外部动作进入 needs_attention；只有所有权明确后才重新开放资源。

不支持 session load 的 profile 只允许显式 fresh-context continuation；带旧 session ID 启新会话不能冒充恢复成功。

## 9. 输入快照、集成与证据版本

输入不等于某个目录路径。至少记录：仓库身份、base commit / tree、依赖产物 hash、选定 dirty 内容摘要、工具链和验证配置。

- 多个上游通过 IntegrationService 形成组合快照；组合过程遇到冲突就停止，不暗中选择一侧。
- Artifact manifest 记录依赖来源，避免重复应用已经包含祖先变更的 patch。
- code / test / lockfile / schema 的影响分析决定哪些下游和 gate 失效；不只按任务是否完成判断。
- 原生验证记录 OS、source SHA / tree、case、runner、fixture、配置与 QA release binary 身份。
- 隔离的 verifier 不能默认带生产凭据；测试代码和依赖安装本身也是可执行代码。
- 所需 gate 由已授权 RunAcceptanceSpec 确定，LLM 不能用“看起来没问题”补发 PASS。

运行中的图不原地改写。修订产生新 revision，已有活动 attempt 保持旧输入；受影响子图在停止确认后 supersede，再生成新 generation。可复用产物必须满足摘要、权限和证据有效性条件，不因 task 名字相同就继承成功。

## 10. IPC、事件恢复与 UI 边界

拟新增命令：`orchestration_create_run`、`validate_plan`、`authorize_run`、`get_run`、`list_runs`、`request_pause`、`cancel_run`、`retry_task`、`resolve_approval`、`revise_plan`、`accept_candidate`、`apply_candidate`。

- 修改命令带 command_id 与 expected_revision，防止重复点击或旧 UI 覆盖新状态。
- `retry_task` 不能绕过失联旧进程；`resolve_approval` 必须检查 attempt、参数摘要和审批有效期。
- 快照返回 run revision 与 event sequence；`list_events(after_sequence)` 用于断线恢复。
- UI 先订阅，再取快照，并补读 sequence 之后事件；过滤已包含事件，避免订阅 / 快照之间丢状态。
- 事件丢失时重取快照，不从终端文本反推任务状态。
- 原始流量可采样展示，但用户控制、审批、错误、终态和证据不能被 backpressure 丢弃。
- 应用退出先列出运行任务，不能只统计前端打开的 tabs。

## 11. 必需的故障注入与验收

| 验证 | 注入 / 操作 | 必须看到的结果 |
| --- | --- | --- |
| V-O01 防重派 | 同 task 同时 claim、重复消费 outbox | 只有一个真实 worker；其他请求得到可解释拒绝 |
| V-O02 依赖 | 上游 artifact 未出 / 版本更新 / gate 失败 | 下游不提前运行；旧证据不被继承 |
| V-O03 资源 | 多 workflow、审批长等待、限流、重型构建 | 所有池不超限；无死锁、饥饿与相互错误释放 |
| V-O04 生命周期 | preparing / executing / awaiting_input 取消 | 实际子进程树停止或明确 unknown；现场不交给第二 worker |
| V-O05 迟到事件 | 旧 attempt 取消后发送完成、旧审批回传 | 不改变新状态、不批准新操作、不发布旧产物 |
| V-O06 真终态 | CLI 非零、refusal、max-turns、ACP 超时、缺字段 | 不伪造成功；有停止原因和部分产物 |
| V-O07 崩溃窗口 | claim 后 spawn 前、spawn 后记账前、Git 更新后 DB 提交前 | 重启可对账；不重复启动、不重复应用、不覆盖未知目录 |
| V-O08 UI 重连 | 卸载视图、StrictMode、renderer reload、事件缺口 | 同一任务 / 进程保持，快照能恢复审批、日志和真实状态 |
| V-O09 工作区 | 两写任务、dirty 用户目录、同仓库不同路径、冲突 | 现场隔离、仓库身份一致、用户文件不覆盖、冲突显式 |
| V-O10 策略 | 模型不支持、配置修改、Vault 锁、三代理模式 | 真实配置可核对；无权限 / 网络 / 模型静默降级 |
| V-O11 验收 | 目标分支推进、测试方案被 worker 改小、native build 不匹配 | 不能接受过期或不足证据；要求重验或人工处理 |
| V-O12 用量 | usage 缺失、累计值重复、重连重复事件 | unknown 不为 0；累计不重算；按版本化用户规则，不擅自采用市场价格 / 越权换模型 |
| V-O13 上下文 | 文档缺失 / 过大、源版本变更、纯 API 无工具 | 正文实际送达；必需资料不静默裁掉；输入版本一致 |
| V-O14 交接 / 记忆 | CC → Codex → API、跨项目检索、并行更新 | portable handoff 不伪装原生 resume；无串读 / 丢更新 / 伪 PASS |
| V-O15 决策 | Jev / LLM 超时、低置信、陈旧建议、未授权候选 | 可 abstain，不 fail-open 扩权，不覆盖 pin 或 required gate |
| V-O16 触发 | DST、重启补触发、重复事件、上一 run 仍在清理 | occurrence 去重与 overlap / misfire 成立，无无限补跑 |
| V-O17 合包 | 成员重复 claim、缺项 / 截断、输出超限、发送后取消一项 | 不融合独立门，身份 / 发布组正确，无伪部分成功或重复调用 / 费用 |
| V-O18 协议 / 费用 | 三协议 stream 终态、usage 累计、SDK 重试、用户改系数 | 不扁平丢语义；未知不当免费；预算覆盖辅助 / 补救 / transport，历史不改价 |

P0 主要使用 fake adapter / fake clock 做确定性状态测试；P1 必须增加真实本地进程、Git、权限、代理和停止效果的原生测试。真实模型请求 / 登录 / 订阅额度使用需要用户明确授权，不把 detect 中的测试 prompt 当免费探针。

每个用户可观察行为同步 QA case 和 policy；完整 crash-regression 与受影响功能 suite 按主设计执行。本稿只新增设计文档，未运行产品功能、付费请求或上述实施验收，不能据此宣布功能完成。
