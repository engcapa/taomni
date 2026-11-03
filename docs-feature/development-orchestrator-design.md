# Taomni 开发任务编排与调度设计

- 状态：**v0.6重建原型已由用户确认；本轮同步设计、提交并push，随后等待指令。产品开发 / CI执行仍暂停。**
- 日期：2026-11-03。
- 当前分支 `feat/development-orchestrator`，HEAD `0c350c0db`；首轮静态代码基线为`3fb5b06d9`，旧证据不冒充当前运行验证。
- 目标平台：Windows、macOS、Linux。
- 用户已明确：**成本规则由用户定义，不调查全部市场价格；可手工设置计费 / 系数 / 任务适配，显式启用成本感知选择，但不允许系统擅自换未授权模型。**
- 核心契约：[调度](development-orchestrator/scheduler-contract.md)、[上下文 / 会话 / 记忆](development-orchestrator/context-session-memory.md)、[决策路由](development-orchestrator/decision-and-routing.md)。
- v0.3 专题：[少调用打包推理与 CodeGraph](development-orchestrator/packed-inference-and-code-context.md)、[多协议 API](development-orchestrator/llm-protocol-contract.md)、[成本系数与选择](development-orchestrator/cost-and-selection-policy.md)。
- **当前UI基准**：[v0.6会话主界面与统一配置](development-orchestrator/developer-agent-ux-v0.6.md)、[交互原型](development-orchestrator/ui-prototype-v0.6.html)。v0.4调度控制台方向已被用户否定，保留作历史，不作为实施基准。
- 工程交接：[review处理](development-orchestrator/review-resolution-v0.4.md)、[TASK清单](development-orchestrator/p0-p1a-implementation.md)、[Bootstrap](development-orchestrator/workspace-bootstrap.md)。
- 调研依据：[开源生态](development-orchestrator/ecosystem-review.md)、[首轮基线](development-orchestrator/research-and-baseline.md)。八表 / 分帧 / 取消 / 验收等review修正保留，但不把后台复杂度直接铺到主界面。

## 1. 建议结论

面向用户，Taomni 提供**会话式开发Agent主界面**，参考ZCode的项目 / 任务、对话与按需代码预览；面向后台，保留本地优先的跨agent调度控制面。不再以调度管理台或逐任务参数表单作为主要体验，也不重造全部coding harness。

1. **复用执行能力，新建调度内核。** 复用 LLM provider、Claude Code / Codex / ACP 协议、Vault、代理和 Git 基础；新建任务图、原子派发、资源约束、产物、恢复与验收。
2. **确定性控制面 + 可选 LLM 规划器。** LLM 提议任务图和修订；Rust 校验依赖、授权、资源及版本。调度器不依赖一个一直聊天的“总管 agent”维持正确性。
3. **按独立交付物并行，不按角色数量并行。** 小任务允许单 agent 直接完成；可独立的模块、探索和复核才分开。先冻结共享契约，再并行实现。
4. **写任务独立 worktree，结果先进入集成候选。** 不让多个 worker 同写用户工作目录；不因模型说“完成”而改主分支。
5. **执行结束、验证通过、用户接受分别记录。** CLI 退出 0、聊天 End、审批通过，都不是开发完成证明。
6. **用户选资源和策略，系统执行并解释。** 用户指定 profile、模型、候选顺序、并发、重试及可选预算；没有匹配项时等待或报错，不静默替换。
7. **先保证后台正确，再扩展后台寿命。** 首版任务由 Rust 后端持有，离开页面不取消；退出应用后的持续运行属于后续独立 supervisor 能力，不伪装成已支持。
8. **直接 API 与上下文编译是一等能力。** 无需创建聊天线程或启动 CLI，就能按任务组装规范、正文、源码、产物和输出契约；缺必需资料或超容量时明确阻止，不静默裁剪。
9. **共享逻辑会话和知识，不强行共用原生 session。** 原生 session 独占执行，跨 agent 用可回溯的 PortableHandoff；项目记忆有作用域、来源、版本与冲突控制。
10. **规则先行，语义决策可配置。** Jev / 用户选定 LLM / 只读 agent 建议任务与候选适配；程序计算用户成本、控制资源，不让评分取代权限 / 验收。
11. **少调用是一等模式，不只是增大窗口。** 一个功能的设计 / 契约 / 测试规划可联合推理；小范围 patch 有条件打包，反馈密集调试保留循环。调用优化不融合独立验收。
12. **协议、计费和任务类型分离。** 正式支持 OpenAI Chat / Responses、Anthropic Messages；手工费用系数可跨协议配置，按用户规则比较整个工作包，不只比较单轮。
13. **一次统一配置，多任务复用。** Settings管理执行资源和默认开发方案，任务发送时仅引用并冻结版本；日常只需项目、目标和可选资料。方案修改影响后续任务，不追改已执行任务。

主要优化对象是：**在验收标准不下降的前提下，减少端到端交付时间、重复上下文、等待和返工**。本稿不承诺多 agent 一定更快，也不宣称已测出性能提升。

## 2. 需求、边界与非目标

### 2.1 用户应获得什么

- 从一个开发目标建立任务，附仓库、设计、验收标准和允许操作。
- 手工建依赖图，或请已选 LLM 提议任务图；执行前看清谁做什么、依赖什么、写哪里、如何验收。
- 将任务交给已配置的 coding-agent CLI、一个 LLM API 步骤、受限 LLM 工具循环或确定性的命令步骤。
- 按开发任务类型接入外部开源执行器：限定编辑、明确 bug、隔离复杂改造、研究规划等分别匹配，不把所有系统当同一种 agent。
- 直接 API 调用可以选择 / 自动补齐已授权文档、适用规范、代码与验收，并预览实际出站上下文。
- 跨 agent 保留任务决策、证据和未决项；项目知识可共享，私人 / 临时 / 分支限定记忆不能串读。
- 同时跑多个互不阻塞的工作包；忙碌、限流、等待审批、失败、冲突有明确原因。
- 随时查看日志和 diff、提供输入、停止、重试、重规划；关闭面板再打开仍看到同一个任务。
- 在集成候选上获得真实测试与独立复核证据，再决定是否应用到目标分支。
- 中断后保留产物和现场，明确说明哪些能够续接、哪些需要重新执行、哪些副作用结果未知。

### 2.2 首版建议范围

- 一台机器上的本地 Git 仓库；一个 workflow 首先对应一个仓库。
- 固定 DAG / 已确认模板自动派发，改计划 / 扩权 / 目标合并人工确认；不无界自主修复。
- P0/P1A 最多8张业务表、4个责任目录；三协议独立 API + 显式设计 / 复核 pack，≤3文本文件 patch 专项验收后启用。
- main=1 / auxiliary=0 / recovery=0；默认 NDJSON 完整项先存 candidate，人工确认才允许一次补救。
- 一个内置 Claude Code fresh task bridge + builtin + worktree Bootstrap；真实进程 / 资源 / 验证生命周期，离开视图不中断，退出宿主停止保存。
- P1B 接 Codex / PortableHandoff、增强审批 / gate 查询；P1A 只读选定批准资料，模型记忆提议只存 artifact。
- P2 才接 Jev shadow / bounded_auto、正式memory / CodeGraph、外部executor / trigger；P3独立daemon。保留扩展接口，不预建完整子系统。

### 2.3 暂不做

- 自动比价、自动采购额度、模型能力榜单、学习式模型路由。
- 无界递归 agent 群、自行扩权、自行把全部开发任务转成多人协作。
- 分布式集群、远端 SSH worker、云端执行环境和跨仓库原子交付。
- 通用插件脚本在调度器进程中执行；第一版模板是声明式数据，不是任意工作流代码。
- 自动 push、发布、部署、付费资源开通；这些是单独的外部副作用和授权边界。
- 在不改执行环境的情况下宣称 worktree 是安全沙箱。

## 3. 当前 Taomni：基础与缺口

| 领域 | 可以复用 | 不能据此声称已有 |
| --- | --- | --- |
| LLM | `Llm`、工具调用、多 provider、多 key、模型组、模型目录 | 任务级调度、所有 provider 的逐任务模型覆盖、可靠总用量账本 |
| Coding agent | CC stream-json、Codex app-server、ACP stdio，部分 session 续接 | 统一 worker API、可靠任务恢复、统一取消、全局并发限制 |
| 工具与安全 | scoped MCP、审批、安全分类、部分原生命令捕获 | 全部工具脱离 renderer 执行、OS 沙箱、完整副作用幂等 |
| Git | 真实分支、diff、merge、cherry-pick、冲突操作 | linked-worktree 管理、任务所有权、可恢复集成事务 |
| 工作区 | 编辑器、终端、Git UI、实例隐藏保留 | 后端 task runner、远端 Code Workspace、退出应用仍执行 |
| 后台与存储 | 备份 jobs 的 journal / revision / 取消 / interrupted 恢复模式，SQLite 事务模式 | 通用 durable workflow、现成的 Agents 数据表 |
| Agents / Crew | 现有入口与占位视图 | 真正派发、真实测试成功、真实 worktree；残留 store 是模拟 |
| 上下文 | 工作区 / LSP 元数据、历史与附件拼装 | 任务级规范解析、正文检索、容量编译、出站 manifest |
| 会话 / 记忆 | backend session ID、聊天持久化 | 统一逻辑会话、异构 handoff、项目记忆和决策记录 |

特别需要避免三个误用：

- `src/stores/agentsStore.ts` 中的派发和“Unit tests passed”是内存模拟，不能改成生产任务真相源。
- `ChatRequest.model_override` 虽存在，普通 OpenAI-compatible / Anthropic adapter 目前不按它换模型；不能只加一个字段就宣布用户的选择已生效。
- 现有聊天 MCP 的部分副作用需要前端收到事件后执行；直接后台调用聊天入口不能获得可靠 headless worker。

详细代码锚点见配套调研文档。旧设计中 Crew 的暂缓约定仍有效；本稿只是为后续开放定义边界。

## 4. 产品模型与使用流程

### 4.1 先区分三层

| 层次 | 对象 | 例子 |
| --- | --- | --- |
| 开发意图 | WorkflowRun | 实现某个设置功能，并满足指定回归 |
| 可验收工作包 | TaskNode | 固化 IPC 契约、后端实现、前端实现、集成验证 |
| 一次具体执行 | TaskAttempt | 用某 profile 在某快照上执行一次；重试产生新 attempt |

Agent 是**执行资源**，不是任务本身；聊天线程是**交互视图或会话引用**，不是任务状态机。

同一个 profile 可以执行多个任务，是否并行由配置决定。同一个 coding agent 可以换模型，但每个 attempt 必须有明确的有效执行配置；不能共享一个活动对话来同时执行两个任务。

### 4.2 推荐默认：有限自治，最终交付仍可控

1. 首次在统一设置配置API / CLI资源和默认开发方案；以后多个任务复用，不重复填写连接、协议和费用。
2. 在项目内描述目标，可选开发 / 规划 / 审阅意图并引用文件；默认方案和规范自动附加。小任务直接执行允许路径，大任务给出会话内计划。
3. 需要副作用时在对话中确认具体计划与授权；已有持久授权的模板不重复走配置向导，改范围 / 扩权仍需确认。
4. 调度器自动派发符合依赖和资源条件的节点，执行预先授权的验证与有限修复。
5. 收集候选，冻结集成快照；执行必要测试、复核和证据校验。
6. 用户接受候选；应用到目标工作区、提交、push 分别按授权处理。

自动执行授权只覆盖已确认的计划与策略。新增网络服务、权限、仓库、模型资源或显著扩展范围时，重新审批。

### 4.3 模板，而不是固定的“多 agent 仪式”

- **单工作包**：实现 → 验证 → 接受。已有充分设计时不强制再请规划器。
- **并行模块**：契约 → 若干独立实现 → 候选集成 → 验证 / 复核 → 接受。
- **并行调查**：不同问题或假设的只读调查 → 证据汇总 → 决定是否实施。
- **修复回路**：失败证据 → 有界修复 → 重新验证；超过上限进入人工处理。
- **批量迁移**：共享变更先落定，再按明确分片执行；每片验证后才能进入集成。

规划、实现、复核是责任，不必是三个常驻进程。构建、格式检查、测试、收集 diff 等确定性工作不需要 LLM。

### 4.4 示例：前后端功能怎样实际调度

以“增加一个新的项目设置项”为例，假设用户选择 planner=P、后端 worker=A、前端 worker=B、reviewer=R：

1. **P 或用户固化契约**：设置字段、默认值、IPC、错误语义、迁移和验收；产出契约版本 C1。
2. **冻结包含 C1 的输入快照**：由确定性 Git 步骤准备，不让 A / B 各自猜接口。
3. **A 与 B 并行**：A 在 worktree-A 实现后端与单测，B 在 worktree-B 实现前端与组件测试；二者消费同一 C1，互不写文件。没有兼容的工作包边界时改为串行，不勉强并行。
4. **执行各自局部检查**：命令执行器占用测试资源，保存真实退出码；失败在授权次数内修复，不能让审批按钮直接变成“测试通过”。
5. **组合集成候选 I1**：等待所需产物，组合时冲突就生成明确阻塞；无冲突也不代表行为已兼容。
6. **R 与部分机器检查可并行**：对冻结的 I1 做复核与检查；native 用例只能独占批准的桌面，不能与其他 UI 操作争抢。
7. **失败则形成 I2**：保留 I1 报告，按影响使证据失效后补验；不覆盖失败记录、不把 I1 的 PASS 冒充 I2。
8. **达到接受条件**：用户审阅 I2 及证据，再授权应用。目标分支已经变化则重新集成，而不是直接套上去。

A 完成早于 B 时释放可释放资源；下游消费版本化产物，不消费 agent 在线状态。契约变化须经控制面修订。

### 4.5 少调用替代路线

同一设置功能的现状分析、架构、字段 / IPC、迁移和测试规划可合为一次 `joint pack`：本地先取足规范、相关实现 / 调用方 / 测试，再让用户指定的大上下文 API 统一输出分项设计。小且输入完备时，也可一次产出前后端 patch 候选；真实应用与验证仍在后面，不能把未来测试结果打包成“已通过”。

pack 有输入 / 输出 / 调用预算、成员 ID、发布组与补救策略；Provider Batch 则是 N 独立请求，不当作一次联合推理。见[专题](development-orchestrator/packed-inference-and-code-context.md)。

## 5. 系统分层与模块责任

### 5.1 控制面

- **RunService**：创建、授权、暂停、取消、接收用户输入及修订计划。
- **PlanValidator**：DAG、必需输入、基线、输出、授权与验收完整性校验。
- **Scheduler**：就绪队列、资源预留、公平性、派发、重试、恢复对账。
- **PolicyEngine**：解析用户策略，返回允许 / 等待 / 需审批 / 拒绝及原因。
- **StateStore**：事务状态、事件、attempt、资源租约、审批和操作 journal。

控制面不解析自然语言来判定权限，也不通过读取终端文字猜任务完成。

### 5.2 执行面

- **ExecutionAdapter**：将统一任务契约映射到一个 CLI、API 或命令执行器。
- **AttemptSupervisor**：启动期即持有取消、deadline、进程树、事件接收和清理。
- **WorkspaceManager**：仓库身份、输入快照、linked-worktree、所有权与保留策略。
- **ArtifactStore**：结构化回执、diff、日志、测试报告、内容摘要与引用。
- **IntegrationService**：组合候选、冲突处理、冻结版本、验证与受控应用。

### 5.3 交互面

- 开发Agent以项目分组任务列表 + 主对话 / 输入框为首页，计划和worker进展在消息中按需展开，不把运行表格作为默认主屏。
- 变更 / diff和上下文在右侧按需打开；统一资源 / 默认方案放Settings，多个任务共享，详情可追溯但不要求逐任务编辑。
- 对话是交互入口，后台任务生命周期仍由Rust持有；前端store只做投影、草稿和偏好，刷新 / 卸载不终止任务。

不先重构整个应用状态。生产模块建议独立落在 `src-tauri/src/orchestration/`，现有 `agent/`、`llm/`、`git/` 提供下层能力，禁止从执行实现反向依赖 UI shell。

### 5.4 上下文、会话、记忆与决策服务

- **LlmInvocationService**：独立 API 请求 / 有界工具循环，复用现有 provider 传输而不依赖 chat thread。
- **ContextCompiler**：整合适用规范、任务、源码、依赖产物和记忆，输出有来源 / 版本 / omission 的 ContextBundle。
- **ConversationService**：逻辑协作空间、分支消息、原生 session lease、portable handoff。
- **MemoryService**：项目 / 私有 / 任务作用域、候选提炼、验证 / 冲突 / 失效，不存活进程真相。
- **DecisionService**：规则、Jev、用户 LLM / agent 建议；不批准权限、不做费用算术。
- **PackPlanner / CodeContextIndex / CostPolicy**：合法任务封包、图 / 源码取证、用户费用与 call-budget；独立 owner，禁止隐藏生成调用。

详见各配套契约。服务有独立状态 owner，不合成一个超大 controller，也不在调度锁内等待索引 / 模型。

### 5.5 为什么不直接嵌入另一套调度器

Rust + Tokio + SQLite 保持为 Taomni 自有控制面，不把 Python / Node 或 Temporal 变成必需基础设施；可选外部执行器使用用户安装的运行时 / 容器，通过适配接口连接。

本轮具体核查 KiroCrew、Gas Town / Beads、Agent Orchestrator，以及 OpenHands、Aider、mini-swe-agent、LangGraph / DeepAgents。前一组主要借鉴 owner、队列、session / memory scope 和恢复，后一组按任务接入。OpenViking / Letta 等记忆服务和 Jev 另设 provider，不覆盖任务账本。

代价是仍须实现可靠取消、journal、版本和故障测试；不因引入开源系统就宣称已解决。执行器 / 委派子工作流 / 观察三种模式明确区分，禁止两个总管同时领取同一任务、控制同一 worktree。具体证据与许可证见[生态调研](development-orchestrator/ecosystem-review.md)。

## 6. 执行器与兼容策略

### 6.1 统一四种执行类型

| 类型 | 执行责任 | 第一版约束 |
| --- | --- | --- |
| `coding_agent` | 现成 CLI harness 完成有界工作包 | 一个 attempt 独占 session；真实 cwd；明确取消与终态 |
| `llm_call` | 单次分类、规划或结构化审阅 | 输入产物引用、输出 schema、有限请求，不假设能直接改代码 |
| `llm_agent` | Taomni 自有受限工具循环 | 单独实现有界 runtime；不能沿用当前无总轮次上限的聊天循环 |
| `builtin` | 命令、Git、验证和产物组合 | typed executable / argv / cwd；可信命令、真实退出码和回执 |

`llm_call` 和 `builtin` 足以完成不少节点。API 首版正式支持 `openai_chat / openai_responses / anthropic_messages`，区分 typed content、工具、终态、usage、结构化输出和可选原生状态；不能只改 base URL 便声称完全兼容。复用现有 codec 并保留旧聊天 / Go 分发，详见[协议契约](development-orchestrator/llm-protocol-contract.md)。

### 6.2 Profile 与能力协商

Settings的共享资源定义adapter、现有连接 / 模型 / Vault / proxy引用及能力；统一开发方案定义规划 / worker / review分工和默认策略，供多个任务复用。任务发送时冻结引用revision和非秘密有效配置摘要，不让用户逐任务新建Profile，也不把密钥复制入快照。

能力必须来自已核实版本 / 协议协商 / 合同测试，至少包括：

- 模型指定、真实 cwd、session load / resume、interrupt、native approval。
- usage 是否存在、是否累计值、是否包含子 agent。
- headless 工具执行、进程树终止、协议事件恢复。
- 文件 / 网络权限的实际执行级别，是否 OS 隔离。
- 原生 subagent 是否可禁止、可观测、可受传递约束。

不支持的配置在启动前拒绝，未知能力显式标未知；不能“提示词中写了限制”就当成强制执行。

### 6.3 对已有 bridge 的必要适配

| Bridge | 复用 | 进入编排前必须补齐 |
| --- | --- | --- |
| Claude Code | stream-json、会话 ID、工具事件、设置与 MCP | 真实 cwd、整回合互斥、停止原因、启动期取消、任务独立 runtime、受控配置 |
| Codex | app-server、thread / turn、重入 guard | 原生审批 request、turn/interrupt、持久 session home、恢复失败不能静默新建 |
| ACP | initialize、prompt、permission、cancel、profile | 长任务 timeout 语义、能力协商、丢事件处理、明确 load / resume 降级契约 |
| LLM | provider、Vault、网络 resolver | 钉住具体配置、模型能力校验、结构化结果、请求级归因、可取消有界执行 |

新增任务 runtime 与聊天进程注册表分开；共享协议和安全代码，不把 task_id 塞进 thread_id 就算适配完成。

原生多 agent 默认不作为额外调度层。能关闭则显式关闭；不能限制时标注“内部并发不透明”，不能把这类 profile 当作有严格总并发或费用上限的资源。

### 6.4 按任务类型选择系统

先依据 activity / scope / environment / modality / interaction 描述任务，过滤能力与授权，再在用户配置的候选中选择；可选语义决策不覆盖显式 pin。

| 任务 | 默认路径 | 可选扩展 |
| --- | --- | --- |
| 文档分析、规划、静态复核 | 直接 API + ContextCompiler | 需要调查工具时只读 agent / DeepAgents |
| 跨文件持续开发 | 已有 CC / Codex / ACP | OpenCode agent server |
| 限定文件编辑 / 小迁移 | 用户 profile | Aider CLI，另控写权限 |
| 明确复现 / 测试的有界 bug | 用户 profile | mini-swe-agent |
| 复杂且需隔离环境 | 已授权 CLI / 环境 | OpenHands Agent Server |
| 构建 / 类型检查 / QA | builtin 真实执行 | 复用项目 runner，不靠模型判断退出码 |

开源系统接入是可选能力，不是模型性价比排名。KiroCrew / Gas Town / AO 整体不作为默认子代理，避免重复控制面；需要时以观察或独立授权的 opaque workflow 接入。

## 7. 调度：依赖、资源、公平与自适应边界

完整算法与不变量见 [scheduler-contract.md](development-orchestrator/scheduler-contract.md)。

### 7.1 任务何时可以运行

必须同时满足：计划已授权、依赖产物版本满足、任务未被占用、profile 能力匹配、权限和代理有效、资源可用，以及用户可选预算准入通过。

资源包括 workflow 全局 slot、profile slot、账号 / endpoint 池、仓库写任务名额、Git 元数据操作锁、重型构建名额、测试环境和 native 桌面。**agent 数量不是唯一瓶颈。**

建议起始配置而非硬编码规则：最多 4 个活动 attempt、同仓库最多 2 个独立写 worktree、重型构建 1 个。Taomni 本仓库 QA 仍须遵守全部本地测试 worker 总数 ≤2、native 串行，不能被通用并发设置绕过。

### 7.2 排队顺序

先过滤硬约束，再在 workflow 间做公平轮转，在同一 workflow 内按用户优先级和等待老化排序；关键路径、输入快照 / session 亲和性只作次级偏好。

禁止为凑并发把小任务拆碎；禁止为了利用 slot 自动换模型。无候选 profile 的任务显示缺少什么，不回退到全局 Chat 默认模型。

### 7.3 何时并行，何时串行

适合并行：相互独立的探索、边界明确的模块、对同一冻结候选的不同维度复核。

优先串行：共享状态机、同一协议 schema、依赖锁文件、数据库迁移、同一 native 桌面，以及输出要被下一步实时消费的紧耦合任务。

预计文件范围用于识别冲突与讨论拆分，不是依赖证明。运行中越界改动暂停集成，提示修订计划；不假装提前的 glob 锁能解决语义冲突。

### 7.4 受控修订，不做无界循环

失败后先区分环境、权限、限流、协议、模型结果、测试失败和未知副作用。只有策略明确允许的可恢复错误才重试。

修复是有上限的新 attempt 或子图；重新规划形成新的 graph revision。新增权限、资源和验收变更必须重审，不能以“让 agent 自己完成”为由扩大范围。

### 7.5 触发与语义决策

除手工启动，预留 schedule / repository-event → Run 的 TriggerSpec：时区 / DST、misfire、overlap、去重身份明确，所有触发仍过同一准入。首版是否提供定时 UI 尚待确认；没有独立 supervisor 时不承诺宿主关闭期间按时执行。

TaskType / skill / 故障初筛可用规则或已授权语义决策；低置信 / 陈旧结果 abstain，权限 / 验收不 fail-open。

### 7.6 合包与调用预算

P1A 仅显式 / 模板 pack，授权 / 快照 / profile / 输出限制兼容，不跨真实反馈 / 独立验收。默认 NDJSON 按完整item单独验证并落盘candidate，截断只损失未闭合项；candidate不等于PASS。组不完整 / provider终态异常时不自动发布，恢复范围看共享依赖，不一定只有最后一项。

one-shot 默认主生成 1、辅助 / 补救 0，限制摘要、Jev、工具续轮、SDK 重试等真实调用。输入 1M 不等于输出 1M；未知终态、截断、缺项需明确补救授权，不能隐藏重发。

## 8. 工作区隔离与交付链

### 8.1 输入快照

- 用 canonical Git common-dir 标识仓库，不只用用户输入路径。
- 默认基于已提交 SHA；dirty 文件和未保存 buffer 不会自动进入任务。
- UI 提供“使用已提交版本”或“显式包含选定改动”的选择；不自动 stash、commit 或复制秘密文件。
- 输入记录 base commit、tree、依赖产物摘要、工具链 / 测试环境身份和批准的配置。
- 多根工作区首版只选一个仓库。submodule、LFS、稀疏检出等未覆盖语义明确阻止或降为人工，不假装普通复制等价。

### 8.2 每个写 attempt 独立现场

worktree 与分支由不可碰撞的 run/task/attempt ID 命名，放在 Taomni 管理的可配置目录，不依赖任务标题 slug。

同一任务重试可在确认旧进程终止后显式续用现场；否则创建新现场并导入已确认产物。旧 worktree 不因超时或取消自动删除。

worktree 管理操作使用参数化 Git 命令和仓库级短锁。worker 执行期不持有全仓库大锁；只对共享 Git 元数据和最终应用做短时串行化。

**Worktree 仅隔离工作文件，不是安全沙箱。** 执行前必须有[BootstrapReceipt](development-orchestrator/workspace-bootstrap.md)：默认 pnpm 共享受控 store、每 worktree 私有 node_modules 布局；lock相同仍须检查OS / ABI / manifests / 本地链接 / patches。禁止直接共写用户依赖目录。

Cargo managed target pool 与 Heavy slot 在真实构建阶段原子独占；两agent可并行推理但同target构建串行，binary / report锁内归档。无法拦截CLI嵌套构建就不准共享可写pool。依赖安装、脚本、磁盘配额、取消和GC均有owner / 授权，不能用外部文件锁死等冒充运行进度。

### 8.3 依赖的代码怎么传下去

如果后端与前端依赖已冻结的契约，二者都从含契约产物的同一个输入快照出发。

多个上游产物先由 IntegrationService 构造明确的组合快照，再给下游使用；不能简单从目标分支 HEAD 开始，也不能重复套用互相包含的 patch。记录每个产物的 base / tree 与组合来源。

### 8.4 两阶段集成

1. 在 Taomni 自有集成 worktree 上组合候选；冲突形成显式人工 / 修复任务，不自动选 ours / theirs。
2. 冻结候选 tree，运行要求的检查与复核；报告绑定精确候选和测试配置。
3. 用户接受后才进入应用阶段；重新检查目标 SHA、dirty 状态、权限和证据有效性。
4. 目标已经变化时重新集成 / 验证，不能拿旧测试回执替新代码背书。
5. 本地应用操作写 journal；Git 与数据库不是一个事务，崩溃后必须检查实际 ref / tree 再决定操作结果。

首版默认交付可审阅候选，应用到用户工作区需要明确授权。Taomni 内部快照提交也必须属于 run 授权的操作；不能从“允许编辑”推导出允许提交 / 推送。

### 8.5 验证不完全交给模型

- 命令执行器记录 executable / argv、cwd、退出码、时间、stdout / stderr 和报告摘要。
- 测试方案和必需门来自已批准计划；worker 修改测试或验证配置会显式标出，不能自行减少必需门。
- 支持单测、类型检查、构建、native QA、人工验收等不同证据，不能相互替代。
- LLM review 是补充，不是没有测试时的万能替身；高风险任务可要求独立上下文 / profile，但不强制每次多模型投票。
- 可借鉴仓库现有的 P1 规划 / P2 实现 / P3 独立验收材料格式；本功能不接管其历史任务板或重置状态。

### 8.6 上下文、session 和记忆的交付

- 每个 attempt 关联不可变 ContextBundle：适用规范、实际正文 / 片段、任务、依赖、有效记忆、输出契约，保存 source manifest 和 omission。无工具 API 必须收到正文，不只是本机路径。
- 同一个开发目标属于 LogicalSession，worker 各有 branch / 原生 session。共享的是已接受决策、资料、消息与产物，不是 CC / Codex 的原生 session ID 或模型隐藏状态。
- 同 backend 串行 resume；跨 backend 通过 PortableHandoff 新建会话，保留目标、约束、结果、证据、未决项和下一步。独立 reviewer 默认不继承实现者全部草稿。
- 模型记忆一律 proposed，只有用户确认或有来源 / 版本的程序确定事实可 approved；P1A 用typed artifacts，P2再建正式memory表，不做自动模型晋升。项目 / 私有 / task隔离和冲突仍保留。
- 可选 recall sidecar 只读建议、提炼异步受限；默认不要求外部向量库或记忆服务，也不把完整聊天历史反复广播给所有 agent。

代码量大时采用全局 repo map + 静态符号 / 依赖邻域 + 相关完整源码 / 测试；CodeGraph 边带来源、hash、精度和构建配置，显式补 TS↔Rust IPC / 事件。图选材料，源码作证据；LLM GraphRAG 不作为精确 patch 的唯一事实源或少调用必需前处理。

具体边界见[上下文 / 会话](development-orchestrator/context-session-memory.md)与[打包 / CodeGraph](development-orchestrator/packed-inference-and-code-context.md)。

## 9. 用户定义策略与成本边界

### 9.1 系统执行什么，不决定什么

用户定义：角色到 profile 的映射、精确模型 / 原生参数、可用候选顺序、并发限制、超时、重试、审批、可选预算与单价。

系统负责：能力 / 质量硬过滤、按用户 `pinned / ordered / cost_aware / pareto_ask` 策略选择、记录原因与触限。**不爬市场价格，不擅自换未授权模型；显式 cost_aware 可使用用户系数。** Jev 判断适配 / 澄清 / 反馈需求，程序算完整 pack / workflow 成本；详见[费用策略](development-orchestrator/cost-and-selection-policy.md)。

面向用户仅“统一开发方案 / 执行资源”两层：基础填角色资源，协议 / 成本 / 并发 / call budget高级展开并跨任务复用。任务只显示默认方案摘要，不重复配置。底层typed字段仍按[决策](development-orchestrator/decision-and-routing.md)、[协议](development-orchestrator/llm-protocol-contract.md)、[成本](development-orchestrator/cost-and-selection-policy.md)分开，保存 / 快照 / 继承见[v0.6 UX](development-orchestrator/developer-agent-ux-v0.6.md)。

`ordered` 固定用户顺序；`cost_aware` 显式使用手工成本。两者都钉住实际 attempt 身份，换模型 / provider 必须可见；引用 profile 不自动安装或调用第三方，无匹配则 block / ask。

现有 round-robin 模型组可继续用于普通聊天；编排不得把组 ID 当作固定执行身份。需要先解析并钉住实际成员，或者显式声明用户允许动态路由并记录每次实际请求。首版推荐前者。

### 9.2 成本扩展接口的最小范围

- usage 按实际请求和 attempt 记录，缺失为 unknown，不能记成 0。
- 外部 CLI 的累计会话 usage 要计算高水位差值，不能每次 resume 都重复相加。
- 价格及预算只引用用户版本化策略；官方返回金额与用户估算分列，订阅额度不强制折算美元。
- `PolicyEngine` 可调用可选成本准入模块，返回允许 / 等待 / 需确认 / 拒绝；调度核心不内置任何厂商单价。
- 不能控制 CLI 内部请求、隐藏子 agent 或延迟 usage 时，只能提供软约束；用户要求硬上限而 adapter 做不到时，禁止宣称可用。
- 取消本地请求不保证上游停止生成 / 停止计费，UI 必须说明该边界。

用户可配置 per-call / token / credit / subscription / mixed、相对 points 或货币、coefficient 与 task tags。系数必须对应基础计费单位；不同单位不默认可比，unknown 不当免费。比较完成工作包的主 / 辅助 / 恢复生成和未知项，不只比较一次请求单价；按次 CallBudget 进入首版。

## 10. 取消、恢复、后台与安全

### 10.1 取消

从 reserved / preparing 开始就能取消。依次停止派发、作废待审批、请求协议 interrupt、终止受控进程树、回收 token，再收集部分产物。

“取消请求已接收”不等于“执行已停止”；清理未确认时保持 stopping / needs_attention，不能释放现场让新 worker 同时写。已发生的副作用不自动回滚。

### 10.2 恢复

重新启动时对账数据库、运行 owner、子进程身份、session、worktree 和操作 journal。只恢复能证明的状态；不能仅凭 session ID 或 PID 继续。

- 支持续接且输入与策略仍兼容：显式恢复同一任务的会话。
- 无法续接但产物可信：新 attempt 从检查点材料继续，并标明 fresh-context continuation。
- 外部操作结果未知：人工核对，不自动重放。

后台持久化保证的是状态和证据可恢复，不是任意 Bash 命令 exactly-once，也不是还原模型内存。

### 10.3 后台寿命

- 关闭面板 / 切换 workspace / renderer reload：Rust owner 继续持有任务，UI 通过快照与事件恢复。
- 明确退出应用：显示任务清单，允许取消退出或停止并保存；首版不承诺继续执行。
- 宿主崩溃：重启后先检查孤儿进程；确定失去控制则隔离现场，不盲目再派发。
- 若用户需要“关掉应用仍继续”，后续将同一内核放入独立本地 supervisor，由安全的本地 IPC 接入；无需更换任务模型。

### 10.4 代理、凭据与权限

- 网络模式为应用代理 / 独立持久化代理 / 无代理；复用 Settings 组件和严格 resolver，不覆盖应用设置。
- 无代理清除子进程大小写代理环境变量；还要检查 CLI 自有配置。无法证明模式生效的 adapter 明确拒绝严格策略。
- 配置代理失败不得回退直连；启用 fully-disabled / full-local 等限制时，入口和运行中请求边界都要校验。
- 密钥只保留 Vault 引用；临时配置使用严格文件权限 / Windows ACL，不落日志或产物，启动扫描崩溃遗留。
- Worker 默认只能接触授权仓库和工具，不继承生产 SSH、数据库会话或全局终端控制面。
- 仓库说明、issue、依赖日志、agent 消息是非可信输入，不能批准权限或修改用户策略。
- 非交互 CLI 可能自动加载仓库 hooks、MCP、插件；启动之前完成项目可信性检查，不能等协议握手后再防护。
- CLI 自有登录由官方流程管理；不提取或代管订阅 OAuth token。具体分发与认证限制见调研文档，实施时复核当时条款。

## 11. 已确认交互：开发Agent会话主界面

**用户已查看并接受v0.6重建原型。** 当前有效基准：[HTML](development-orchestrator/ui-prototype-v0.6.html)、[新任务](development-orchestrator/ui-prototype-v0.6.png)、[开发会话](development-orchestrator/ui-prototype-conversation-v0.6.png)、[统一设置](development-orchestrator/ui-prototype-settings-v0.6.png)；详细行为 / 配置继承见[UX契约](development-orchestrator/developer-agent-ux-v0.6.md)。v0.4保留历史，不再指导实施。

- **左侧项目 / 任务**：新任务、搜索、按项目分组的会话；状态只提示进行中 / 待处理，不使用全局调度表占主屏。
- **中间会话与输入**：描述目标、@引用资料、开发 / 规划 / 审阅意图；默认方案自动沿用，无逐任务协议 / key / 预算配置向导。
- **对话内计划和协作**：确认范围后开始；worker / 实际profile / 调用记录按需展开，普通用户先看到做了什么、下一步、需确认什么。
- **右侧按需预览**：代码diff / 文档候选、上下文正文 / 来源；默认关闭，不常驻费用表。真实产物类型决定展示，不用假文件装饰。
- **统一设置**：基础仅默认规划资源、允许worker、review资源；连接 / 模型配置一次，多任务复用。协议 / 成本 / 并发 / 恢复在高级展开，不强迫所有人填写。
- **保存和快照**：取消 / Esc放弃设置草稿；保存更新共享revision。新任务采用新版本，已提交任务保持原有效配置；凭据撤销 / 禁用策略仍可立即收紧。
- **部分产物 / 审批**：会话内可操作消息；candidate不等于PASS，补全需确认一次额外调用，拒绝不改默认方案。目标应用 / 提交 / 合并与接受分开。
- **资源缺失或失败**：保留目标草稿，提供统一设置修复入口，不逐任务要求重填，也不静默fallback。

未知工作量不伪造百分比。关闭右栏 / 切换任务 / renderer刷新不取消工作；后台owner、真实停止与退出拦截保持review契约，UI简化不放宽权限。图稿是实现基准而非已完成产品，后续unit / GitHub browser/native仍须实际证明。

## 12. 实施分期与完成门

| 阶段 | 交付 | 必须证明 |
| --- | --- | --- |
| P0 最小内核 | 5表、固定计划、单写claim / events intent、fake adapter | 防重 / 取消 / 崩溃窗口，不预铺memory / Jev / trigger |
| P1A 纵向闭环 | 增3表累计8；先拆codec再三协议、分帧pack / ≤3文件patch、CC + builtin / Bootstrap | 前缀候选不丢、无隐藏重发、真实构建锁、UI重连与退出恢复 |
| P1B 异构交接 | Codex / handoff；增logical_sessions / handoffs / approvals / gate_receipts | 第二CLI合同、查询投影与迁移、原生审批 / 受控集成 |
| P2 可选增强 | memory_records / decision_records / triggers；Jev shadow或显式bounded_auto、CodeGraph / 外部executor | 模型记忆仅proposed、合法候选内路由、无双主控 / 重复触发 |
| P3 驻留扩展 | 独立daemon、之后远端worker / 外部memory | 三端IPC鉴权 / 升级 / 进程与状态恢复 |

P0/P1A仅 `orchestration/{core,execution,context,pack}` 四个责任目录；大职责拆文件，不造十七个空子系统。Schema按[scheduler §8.1](development-orchestrator/scheduler-contract.md)；精确文件owner、TASK-OR01～10、依赖 / AC / V见[实施交接](development-orchestrator/p0-p1a-implementation.md)。新文件目标200–400行，800硬限；llm/mod.rs当前297行，仍只保留facade。

### 必须建立的验收

- AC-O01：用户选定 profile / 模型实际生效；不支持时启动前明确失败。
- AC-O02：DAG 依赖和产物版本正确；不执行被阻塞或未授权任务。
- AC-O03：并发上限和资源池约束在多 workflow、重试、审批、恢复时均成立。
- AC-O04：独立 worktree、组合快照、dirty 保护及真实 diff 可核查。
- AC-O05：终端错误、截断、拒绝、max-turns、测试失败不能被当作开发成功。
- AC-O06：取消覆盖启动期和实际子进程树；未知停止状态不重新派发。
- AC-O07：UI 卸载 / 重开恢复同一任务；宿主重启执行对账，不丢审批与现场。
- AC-O08：重复事件、迟到回调、未知外部副作用及 Git 应用中崩溃不重复发布。
- AC-O09：三代理模式、失败不直连、权限拒绝不绕过、Vault 锁定可观察。
- AC-O10：实际候选验证与接受绑定版本；没有证据或 required gate 未跑不得完成。
- AC-O11：独立 API 的上下文、规范、资料和输出契约真实交付；过大 / 缺失 / 不支持不静默裁掉（AC-C01～03/09）。
- AC-O12：逻辑 / 原生 session、portable handoff、记忆作用域与 revision 正确，事实 / 模型声称 / 权威不混淆（AC-C04～08）。
- AC-O13：规则 / Jev / 用户模型可替换；决策不扩权、不覆盖 pin，低置信或失败可 abstain（AC-D01～05）。
- AC-O14：任务类型匹配真实能力，外部子调度 owner 独立，触发 / 重启无重复发布（AC-D06～07、V-O16）。
- AC-O15：少调用 pack 准入、成员原子 claim、输出覆盖、base hash / 发布组和失败补救成立（AC-P01～08）。
- AC-O16：三协议终态、typed blocks、schema 与 usage 兼容，旧行为回归；成本 / 调用账本不重复、不隐藏生成（AC-L01～06、AC-K01～06）。

实现必须运行受影响单测 / 原生集成测试、`pnpm check:refactor`、`pnpm build`，以及匹配源码 QA release 的完整 browser/native `crash-regression` 与新增功能用例。native 进程、Git、代理、磁盘和取消效果必须由原生测试核查，不能只靠 stub。

建议用固定历史工作包比较单 agent 与编排两种方式，记录验收通过率、端到端耗时、返工和资源等待；usage 可选记录。没有真实测量前不发布“更快 / 更省”的结论。

## 13. 决策记录与交付状态

本轮用户要求核实review并对认可项采纳，以下以**授权代决**记录，不伪称每条都曾被用户单独确认；原D-O ID保留，详细原因见[review处理](development-orchestrator/review-resolution-v0.4.md)。

| 原决策 / DEC | v0.4 结论 | 状态 / 来源 / 关联 |
| --- | --- | --- |
| D-O01 / DEC-OR01 | 已确认计划 / 模板自动派发局部验证，改计划 / 扩权人工确认，无界重规划不做 | 授权代决；review建议1；OR03/09，AC-O02/09 |
| D-O02 / DEC-OR02 | 无daemon；Rust AppState持有，退出拦截 / 停止保存 / 重启对账；P3驻留 | 授权代决；建议2；OR03/10，AC-O06～08 |
| D-O03 / DEC-OR03 | P1A三协议API + CC，P1B Codex / handoff；未满足合同不得假就绪 | 授权代决；建议3 + 现有CC许可接口；OR01/05/07 |
| D-O04 / DEC-OR04 | 本地worktree + Bootstrap / 构建池；非OS沙箱，强隔离后续按需 | agent自决；工程约束；OR07，AC-O04/09 |
| D-O05 / DEC-OR05 | 候选接受 / 应用 / 目标合并各有人工门；不连带push | 授权代决；建议1；OR06/09，AC-O10 |
| D-O06 / DEC-OR06 | P2 shadow默认 / 显式bounded_auto；严格aux0旁路Jev | 授权代决；建议5；AC-D01～05 |
| D-O07 / DEC-OR07 | 模型记忆仅proposed；用户确认或受限确定观察才approved，无自动模型晋升 | 授权代决；建议6；AC-C06/07 |
| D-O08 / DEC-OR08 | 外部executor到P2，具体OpenHands/Aider不阻塞P1A | 授权代决；建议3；OR07/10 |
| D-O09 / DEC-OR09 | 首版手工 / 模板；trigger UI到P2，misfire等契约保留 | agent自决；首片减负；AC-O14 |
| D-O10 / DEC-OR10 | 显式设计 / 审阅 + ≤3文件patch gated；NDJSON分帧保存；默认1/0/0，人工可允一次recovery | 授权代决；建议4 / 风险2；OR06，AC-P01～08 |
| DEC-OR11 UI（修订） | v0.4控制台过复杂，改为ZCode风格：项目任务 / 中会话输入 / 右按需变更与资料；当前基准v0.6重建 | **用户已定**；用户指出方向并在查看后确认“可以”；OR09 / AC-UX01/04 |
| DEC-OR12 Schema | P0/P1A≤8表、4目录，journal / 审批 / 回执语义保留在typed列 / events / artifacts | 授权代决；风险1；OR02，INV-01～12 |
| DEC-OR13 统一配置 | Settings管理共享执行资源和默认开发方案，多任务引用，保存影响后续任务而非追改旧任务 | **用户已定**；明确要求统一配置多个任务使用；OR04/08/09，AC-UX02/03 |
| DEC-OR14 常规入口 | 输入框只显示方案摘要 / 意图，不放逐任务协议 / key / 费用表；高级设置集中、详情按需展开 | **用户确认原型**；日常先简洁，临时model override不默认加入；AC-UX01/04/05 |

成本仍由用户定义；cost_aware不扩大候选、不跳验收。已确认原型不等于产品已实现；依用户最新指令，本次只完成设计提交 / push，之后等待，不自行恢复编码。

## 14. 本轮文档交付与核查

- v0.6：新增用户确认的会话式原型、共享配置状态模型 / 7项unit test、三张静态设计预览和UX文档；v0.4原型保留历史。无产品代码 / workflow / 个人配置变更，按用户要求提交 / push后等待。
- 本地仅运行原型纯状态unit与静态检查，7/7通过；首次空白方案名校验失败已修正。截图仅用于设计视觉检查，没有运行产品browser/native suite或真实worker。
- 13份Markdown的本地链接 / 源码锚点 / NDJSON、原型103个DOM ID / 3个本地依赖与脚本语法检查通过；source-file-size通过：4228文件、4项既有例外。
- 已按提交要求尝试`pnpm check:refactor`，环境意外触发产品依赖下载，已停止；直接contracts / boundaries均报`ERR_MODULE_NOT_FOUND: typescript`，因此完整检查**未通过 / 环境阻塞**，不能以size单项替代。
- 当前Node24.13.0、pnpm12.15.0，不是工程Node22 / pnpm10；没有为纯文档提交继续安装依赖，也未修改lockfile。
- 后续执行位置遵从用户：本地unit，GitHub qa-ui-auto-platforms执行browser/native + 匹配QA release / crash-regression；fixture LLM兼容OpenAI / Anthropic，真实多harness能力按合同验证。当前没有CI运行或产品行为通过结论。
- 所有原型均无模型生成 / API key / 实际仓库修改；没有性能或成本实测。原型确认不是编码完成。
