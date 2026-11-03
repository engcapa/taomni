# 开发编排：任务类型路由与可配置决策服务

- 状态：2026-11-03 v0.4 review 修订；P1A仅rules，语义provider在P2以shadow / bounded_auto接通。
- 关联：[主设计](../development-orchestrator-design.md)、[上下文 / 会话 / 记忆](context-session-memory.md)、[开源调研](ecosystem-review.md)、[打包推理](packed-inference-and-code-context.md)、[成本选择](cost-and-selection-policy.md)。
- 用户明确允许考虑 Jev、可配置的低成本 LLM API 或 agent；**具体模型、价格、阈值和预算由用户定义**。

## 1. 决策分四层，不把所有事情交给“总管”

| 层 | 例子 | 权限 |
| --- | --- | --- |
| 确定规则 | DAG 就绪、资源占用、文件权限、required tests | 程序计算并强制，不问模型 |
| 语义判断 | 任务类别、需不需要澄清、候选技能、失败类别 | 可配置 DecisionProvider，给建议 |
| 开放规划 | 复杂任务拆分、设计取舍、修复方案 | 规划 LLM / coding agent 生成提案 |
| 权威接受 | 扩权、减少验收、最终合并 / 发布 | 用户或已明确授权规则，不由语义评分替代 |

首版不要求常驻协调 agent。人或模板给足任务时，确定规则可直接派发；自然语言不明确时才调用决策器 / 规划器。

## 2. Jev 的实际定位与证据

已确认对应 **TypeSafe Jev / System One**，官方来源：[Quick start](https://docs.typesafe.ai/introduction/quickstart.md)、[API](https://docs.typesafe.ai/api/system-one.md)、[coding agents](https://docs.typesafe.ai/introduction/coding-agents.md)。

官方 API 是 `POST https://api.typesafe.ai/v1/systemone`，请求含 `model / state / questions`，模型目录另有接口。Jev 不生成代码、解释性长文或维护对话，不能作为 CC / Codex 主模型的直接替换。

相关结构：

- `choice`：从有限选项选择，返回选项分布和 confidence。
- `score`：按有序 rubric 评分，返回分布和 confidence。
- `noul`：命题成立的概率；没有相同的独立 confidence 字段。

confidence 是分布的统计量，不等于“这个具体软件决策正确的概率”。[官方说明](https://docs.typesafe.ai/confidence.md)给出计算方法；阈值要按任务校准。

[官方已知限制](https://docs.typesafe.ai/model-jaggedness.md)指出数值精度、计数、间接推理等弱点。因此依赖检测、资源算术、路径检查、预算扣减都在程序中完成，不让 Jev 判断。

本次未发现 / 验证 Jev 模型权重的开源发布与许可证；**Jev 是可选外部决策服务，不把它写成已证实的开源本地模型**。搜索中的相似域名和第三方代理不作为官方端点，配置第三方 gateway 时由用户显式选择并确认出站数据。

## 3. DecisionProvider：Jev、普通 LLM、agent 可替换

### 3.1 输入不是整个聊天记录

`DecisionRequest` 使用最小必要 ContextBundle：

```text
DecisionRequest {
  id, task_id, graph_revision, input_digest,
  decision_kind,
  state: { objective, constraints, facts, evidence_refs, missing_inputs },
  candidates: [{ id, description, capabilities, restrictions }],
  rubric_ref, authorization_scope,
  output_schema, limits
}

DecisionResult {
  request_id, input_digest,
  status: proposed | abstained | failed,
  selected_ids[], scores?, distribution?,
  confidence_kind: model_distribution | self_reported | calibrated | unavailable,
  confidence_value?,
  evidence_refs[], evidence_origin,
  effective_provider_ref, model, model_version?,
  prompt_revision, rubric_revision, usage_ref?,
  created_at, expires_at?, applied_by_rule?
}
```

Jev 可能不返回推理说明 / 文献引用；`evidence_refs` 可由调用方提供，`evidence_origin` 说明是 request 提供还是模型产生，不能伪造模型解释。

普通 LLM 的自报 confidence 与 Jev 分布统计分列，不统一当成已校准概率。决策结果缺必需证据时，允许 abstain，不强行生成貌似完整的结论。

### 3.2 可选 backend

- **rules**：默认；任务显式类型、路径 / 文件类型、必需环境等确定信息。
- **jev**：窄范围 choice / score / noul；单独 TypeSafe transport，不伪装成聊天 provider。
- **llm_json**：用户指定普通 API profile + structured output；通过独立 LlmInvocationService 执行。
- **agent_advice**：用户指定只读 agent profile；适合需要工具调查的复杂分类 / 失败分析，不为每个排队决策启动 agent。
- **human**：缺资料、低置信、策略冲突或高风险时。

所有决策调用也占资源、记录 usage、受用户预算 / 隐私 / 代理约束。不是调度器每个 tick 都调用模型，使用输入 digest 与 prompt / rubric revision 缓存；输入或权限变化使旧结果失效。

### 3.3 失败策略

- advisory 决策服务不可用：可以退回**既有确定规则**，明确记录未获得建议。
- 需要决策才能确定安全执行范围：停止 / 询问，不能 fail-open 扩权。
- API 超时、拒绝或无效输出：有限重试，之后 abstain；不自动切到用户没授权的模型。
- 即使 confidence 很高，也不能覆盖 PolicyEngine、人工审批和 required gate。

社区 [jev-router](https://github.com/drmaas/jev-router) 的类型化判断值得借鉴，但所读 `jev.ts:51` 在错误时返回 null，部分 hook 默认放行。**Taomni 不把这种 fail-open 行为照搬成权限门。** 仓库 README 也建议未校准前关闭自动审批；其小样本评估不能替代本仓库验证。

## 4. 哪些节点值得调用决策器

| 决策点 | 程序先做什么 | 模型可建议什么 | 最终执行 |
| --- | --- | --- | --- |
| 任务分类 | 校验用户显式类型和资料 | debug / feature / research / review 等标签 | 用户类型优先；记录覆盖原因 |
| 资料是否充分 | 必需文档 / schema / AC 是否存在 | 是否仍有语义歧义 | 澄清 / planner，不凭评分补造缺失资料 |
| 模板 / 执行器选择 | 过滤未授权 / 能力不符 / 不可用候选 | 对剩余候选做语义匹配 | 用户策略内固定 profile |
| 技能 / 上下文 | 权限、scope、版本、token 预算 | 候选 skill / 文档重排 | 编译器校验，必需规范不可被删 |
| 故障归因 | 退出码、协议错误、超时分类 | 环境 / 实现 / 契约问题的建议 | 对应有界恢复流程 |
| 修复 / 升级 | 检查次数、授权、资源 | 继续修复、需规划、建议人工 | 程序限制，不擅自扩大模型名单 |
| 记忆提炼 | 去重、来源、敏感范围 | 哪些经验值得保留 | proposal → 校验 / 审核 → approved |
| 结果初筛 | required gate 状态 | 发现可疑遗漏或需独立 review | 不能自发 PASS 或接受候选 |

开放架构设计由 generative planner 承担，不能把一句“给任务选标签”扩成让 Jev 生成完整开发 DAG。

## 5. 根据开发任务类型选择开源能力

### 5.1 类型描述

采用多标签而非一个粗粒度类别：

```text
TaskType {
  activity: investigate | plan | implement | edit | review | verify,
  scope: snippet | files | module | cross_module | repository,
  environment: pure_api | local_git | isolated_container | browser | native_desktop,
  modality: text | image | mixed,
  interaction: one_shot | bounded_loop | long_running,
  deliverable: design_bundle | contract | review | targeted_patch | test_plan | diagnosis,
  input_readiness: complete | partial | unknown,
  feedback_need: none | optional | required,
  packability, output_shape, independence_requirement,
  constraints: { readonly, required_tools, required_protocol, isolation, privacy }
}
```

用户可以直接指定类型和执行器；分类模型只负责建议。不能因为名字包含“UI”就认定某个模型 / 工具有实际桌面控制能力。

### 5.2 路由建议矩阵

| 工作 | 推荐首选路径 | 可选开源执行系统 / 边界 |
| --- | --- | --- |
| 任务分类、技能候选、失败初筛 | rules + 可选 Jev / llm_json | 无需启动完整 coding harness |
| 文档分析、规划、静态 diff 审阅 | 直接 llm_call + ContextCompiler | 需深度工具调查时可选 DeepAgents / 只读 CLI |
| 跨文件、长期交互开发 | Taomni 已有 CC / Codex / ACP | 外部 OpenCode；不再套第二个调度总管 |
| 指定文件编辑 / 小迁移 | Aider CLI 或现有 agent | Aider 文件参数不是硬写白名单；补丁和执行环境另控 |
| 明确复现和测试的有界 bug | mini-swe-agent | 自有 model+bash loop，不是驱动其他 CLI；外置取消和验收 |
| 复杂、依赖多、需隔离环境改造 | OpenHands Agent Server | 固定 API / 容器版本；结果仍由 Taomni 验证 |
| API 多步研究 / 分支审批 | 简单流程优先；必要时 LangGraph / DeepAgents service | library / harness，不是天然隔离沙箱，不默认装入桌面 |
| 类型检查、构建、确定测试 | builtin 真实命令执行器 | 不为命令成功与否调用 LLM |
| browser / native UI 验证 | 已批准环境、既有 QA runner | 开源 agent 不是“支持图片就能验 native” |
| 长期调度 / 跨项目任务总管 | Taomni own kernel | KiroCrew、Gas Town、AO 主要借鉴，避免双主控 |

这是一张任务适配表，不是模型性能榜。具体质量和速度需在用户实际任务上验证。

### 5.3 Profile 的 task matching

每个 ExecutionProfile 可声明 `task_types / capability_requirements / context_recipe / tool_policy / output_contract / nested_execution_mode`。

流程：用户 pin → 能力 / 授权过滤 → 可选语义适配 → 用户 `ordered / cost_aware / pareto_ask` 策略 → 固定 attempt 身份。缺容器不降为无隔离，缺图像不签发视觉验收。

### 5.4 合包与成本的决策分工

Jev 可对合法候选判断 `task_fit / input_sufficiency / requires_feedback / pack_fit`，不能凭任务相似度越过独立验收、隐私和输出限制。程序先用本地 task / source overlap 筛包，不逐对请求模型；严格 one-shot 若辅助预算为 0，就不调用 Jev。

成本系数手工绑定 BillingProfile / endpoint 和基础计费单位，不附会成模型质量。程序比较完整调用工作流 / pack 的主、辅助、重试与补救区间，Jev 不计算金额 / token、不把自报 confidence 当成功率。只有用户启用 cost_aware 才按可比成本选路，详见[费用策略](cost-and-selection-policy.md)。

## 6. 外部系统接入与“两个总管”的问题

### 6.1 区分三个模式

- **执行器模式**：Taomni 拥有 task / attempt / worktree / acceptance，外部系统只执行有界工作包。首选 OpenHands / Aider / mini 等。
- **代理子工作流**：外部系统自有内部调度，Taomni 只拥有一个 opaque parent attempt，使用独立 root 和受限授权。显式声明内部并发 / usage / session 可见性，不伪装成严格可控池。
- **观察模式**：只显示用户已运行的 KiroCrew / Gas Town / AO，不争夺其 worktree 和进程；命令转发需有接口契约与用户授权。

不同时由 Taomni 和外部调度器领取同一任务、创建同一路径、自动合并到同一个分支。外部系统执行态是 observation，Taomni 的任务验收仍由本地契约控制。

### 6.2 适配契约

除现有 ExecutionAdapter 生命周期，增加：

- 外部版本 / API schema / license 证据；兼容范围与 capability probe。
- context 交付：inline、挂载 bundle、原生 resource、允许的动态检索。
- session 模式：fresh / native resume / portable handoff。
- 内部子执行：禁用、受约束、或者显式 opaque；总资源约束可否真实执行。
- 工具 / 文件 / 网络限制的强制级别，不只接收一个貌似有效的参数。
- pause / interrupt / kill / reconcile / artifact export 的差异。
- 不直接把外部系统返回的 task_completed 写成 GateReceipt PASS。

## 7. 校准、审计与上线方式

### 7.1 先 shadow，再有限自动化

语义决策提供两个显式模式，均在 P2 接通 provider，P1A 只留规则 / 配置 seam：

- `shadow`（默认）：记录建议但不影响 dispatch；真实调用仍需启用并给辅助预算，不为“默认 shadow”自动发请求。
- `bounded_auto`：用户显式开启、候选已授权且过硬过滤时可自动路由；校准 / 不确定性门不满足则 rules / ask。不能改计划、扩候选、覆盖 pin、审批或验收。

严格 one-shot 的 auxiliary=0 无条件旁路语义 provider，不用一次额外 Jev 来决定“是否只调一次”。用人工标注任务先比较规则与语义结果；没实测不宣称已校准，配置可随时退回 shadow / rules。

评价任务分类、候选匹配、澄清遗漏、错误自动执行、abstention、延迟、上下文缺失和数据泄露；usage 可观察，不做未经用户定义的金额排名。

权限相关误放行比额外询问严重。不要统一复制某社区项目的 0.3 / 0.9 阈值，也不以模型自报 confidence 当生产校准。

### 7.2 决策审计

保存 input hash、候选过滤原因、prompt / rubric / 模型版本、输出、最终应用规则、人工覆盖和结果；不保存模型隐藏思考。

提供 replay / compare，但任何真实 replay 会发送资料并产生用量，需要用户授权；本轮没有运行。

### 7.3 验收

- AC-D01：rules、Jev、普通 LLM、只读 agent 可按配置替换，禁用语义决策仍能运行显式任务。
- AC-D02：决策仅在授权候选内起作用，不覆盖 pin、不扩权、不降低验收。
- AC-D03：低置信、超时、不可用和 schema 错误可以 abstain；权限门不 fail-open。
- AC-D04：任务、资料或策略 revision 更新使旧决策失效；相同输入不重复无限调用。
- AC-D05：置信来源区分，不把自报分数当已校准概率；未知数值不默认 0 / 通过。
- AC-D06：外部子工作流有独立 owner / root，内部不透明时不承诺严格并发或用量上限。
- AC-D07：候选工具能力、文件白名单与真实隔离等级相符；不能只靠 prompt。

## 8. 推荐取舍

1. **P0/P1A**：rules / TaskType、直接 API + 分帧 pack、一个 CC bridge；approved 资料读取 / proposal artifact，不建正式记忆 / Jev 服务。
2. **P1B**：第二个 Codex bridge、portable handoff、审批 / 回执查询增强，不接外部 executor。
3. **P2 可选**：Jev / 用户 LLM 的 shadow（默认）和 bounded_auto、候选记忆提炼 / recall、OpenHands 或 Aider；模型记忆永远先 proposed，不在本期自动晋升。mini-swe-agent 后续按需。
4. **借鉴而非整套嵌入**：KiroCrew 的 gateway / scope；Gas Town 的 durable handoff / merge queue；AO 的进程与 session seam。
5. **暂不成为必需依赖**：外部图框架、云记忆服务、完整第二调度器。需要时经适配接入，不先推翻 Taomni 的 Rust 生命周期。
