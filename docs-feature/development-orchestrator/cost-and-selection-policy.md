# 开发编排：用户成本系数、计费模型与确定性选择

- 状态：2026-11-03 讨论稿 v0.3；不含厂商价格表，不自动采购 / 比价。
- 用户明确需要：按次 / 大上下文 API 的打包调用、手工成本系数、任务类型辅助 Jev 决策。
- 关联：[决策服务](decision-and-routing.md)、[打包推理](packed-inference-and-code-context.md)、[协议](llm-protocol-contract.md)。

## 1. 先把配置维度拆开

| 维度 | 回答什么 | 例子 |
| --- | --- | --- |
| Transport protocol | 怎么发 / 收请求 | openai_chat / openai_responses / anthropic_messages |
| Model capability | 能处理什么、容量多少 | tools / image / strict schema / input-output limits |
| Billing profile | 什么算一次、如何计费 | per_generation / tokens / credits / subscription / mixed |
| Task suitability | 适合什么工作 | design / targeted_patch / diagnose / review |
| Cost preference | 用户认为资源相对有多贵 | 系数 1、4、20，或实际货币报价 |
| Routing policy | 如何在合格候选中选 | pinned / ordered / cost_aware / ask |

**不能把“Anthropic 协议”绑定为按 token，把“OpenAI 协议”绑定为按次。** 同一网关可能多协议、同模型不同渠道不同计费和限额。

## 2. 最小可用的手工配置

```yaml
billing_profiles:
  long-call:
    mode: per_call
    unit: relative_points
    fixed_per_generation: 8       # 纯示例：用户给定，不是市场报价
    coefficient: 1.0
    billing_unit: generation     # 不是一条业务 task，也不必是一条 HTTP
    retry_charge: unknown
    cached_input_charge: not_applicable
    unknown_spend_action: ask
  interactive:
    mode: per_call
    unit: relative_points
    fixed_per_generation: 1
    coefficient: 1.0
    billing_unit: generation
    retry_charge: unknown
endpoints:
  long-context-api:
    protocol: anthropic_messages
    capability_ref: my-verified-long-context
    billing_ref: long-call
    task_tags: [design, contract, static_review, migration_plan]
    task_overrides:
      targeted_patch: { allowed: true, output_limit_ref: small-patch }
routing:
  selection: cost_aware           # 用户显式启用；默认仍可 ordered
  quality_gate: required_capabilities_and_task_rules
  call_budget: { main_generations: 1, auxiliary_generations: 0 }
  recovery: { generations: 0, on_failure: ask }
```

示例只说明结构，capability / profile / task tag 都是用户定义引用。成本配置不自动证明 1M、schema、质量或按次收费已实测。

**只有一个系数时**，定义它为“一单位基础消耗的相对成本”；必须同时选基础单位。系数 3 不能在不知道调用次数 / token / credits 的情况下直接表示整个任务贵三倍。

## 3. 可扩展的 BillingProfile

```text
BillingProfile {
  id, revision, source: user,
  mode: per_call | token | credit | subscription | mixed | unknown,
  unit: currency(code) | relative_points | provider_credits(pool),
  coefficient,
  fixed_per_generation?, fixed_per_attempt?,
  token_rates?: { uncached_input, cached_input, cache_write, output, tiers },
  credits_rule_ref?, quota_pool_ref?,
  billing_unit, rounding_rule?, minimum_charge?,
  retry_charge, failure_charge, tool_charge, server_internal_charge,
  request_meter_ref?, point_conversion_ref?,
  reset_period?, valid_until?,
  unknown_spend_action
}
```

- token 价格分段、长上下文加价、最低收费、四舍五入 / credits 重置按用户规则计算。`request_meter_ref` 可独立记录“本次生成消耗一个调用”的限制，即使实际金额按 token 收取。
- 只想比较简单系数时，可显式设 `relative_points_per_generation`；按 token 端点需按用户 point_conversion 折算，不能把 1 point / call 与 1 point / Mtok 直接比较。
- 不同货币 / points / provider credits 不自动比较。需要用户显式换算且记录版本，否则只在同单位内排序。
- `coefficient` 统一作可选乘数，默认 1；不能一处当基础价、一处当质量权重，避免重复加权。
- 一份 billing profile 可被多个 endpoint 引用，但实际账号 / 配额池独立标识。
- 改系数只影响后续选路；已发请求和历史账本保留当时策略版本。
- 订阅包含额度不等于“零成本 / 无限并发”；可记录 quota 与用户机会成本权重，不强制折算货币。

未知计费 / 额度不是 0。用户可显式接受 unknown 并设软限制，或 hard policy 禁止准入。

## 4. 程序计算费用，Jev 评估语义

### 4.1 推荐路由分工

1. 用户显式 pin 和授权决定可选范围。
2. 程序过滤协议、上下文 / 输出、隐私、工具、隔离、schema、资源和 task 硬门。
3. 可选 Jev / LLM 根据任务与候选说明判断适配、是否澄清、可否打包、是否需要反馈。
4. 程序编译上下文，估计请求 / 输出规模，按 billing profile 计算消耗。
5. 程序按用户 selection policy 排序、预留预算；不合格就 ask / wait / fail。
6. 真实结果更新 usage / call ledger，profile 与模型身份固定为本 attempt。

不让 Jev 做小数计算、token 精确计数、资源扣减或安全最后裁决；它的 confidence 也不是 patch 成功率。

### 4.2 两阶段结果

`SuitabilityAdvice`：候选 ID、task labels、supports_one_shot、requires_feedback、上下文缺口、risk / uncertainty、evidence；可无建议。

`CostEstimate`：计费单位、已知下界 / 上界、预计调用数、token / credit 估计、系数、未知项和策略版本，由本地确定计算产生。

真正的 quality gate 来自 capability、用户任务规则和验证数据，不因为某个模型自报 0.95 就达标。建议先提供语义适配分与 Pareto 候选，不把所有维度藏进一个无法解释的“智能分”。

### 4.3 简单、可解释的选择策略

- `pinned`：只用用户指定资源，不可用就等待或询问。
- `ordered`：合法候选按用户顺序，成本仅展示。
- `cost_aware`：用户启用后，在质量 / 能力门达标者中按可比较成本排序，可加 latency / deadline 约束。
- `pareto_ask`：质量证据、费用区间、时延互有取舍时显示候选供用户定。

没有任务质量实测时显示未校准；可以按用户显式规则选择，但不宣称自动找到最佳性价比。

## 5. 比较的是完成任务消耗，不是一次请求单价

### 5.1 费用模型

程序使用用户价格和规则计算。概念公式：

`已知基础消耗 = 调用固定费 × 已知生成次数 + 各计费 token / credit 项 + 明确工具 / 服务费用`。

`策略估算 = coefficient × 已知基础消耗`。

需要 reasoning / cache 细分时按 provider 定义排除重叠，不能把 reasoning 作为 output 子集又算一次。

interactive 所需总轮次难以预知，展示区间和推断来源；不能拿一轮成本与完整 pack 成本比较。一次 API 生成多个子任务只计真实生成次数，不按任务数重复收 fixed fee。

### 5.2 打包示例

纯假设，单位 relative points：

- 大上下文端点：一次 8 points，允许输出规模满足本组设计。
- 交互端点：一次 1 point，多个任务预计要 12 次生成。

候选成本是 8 对约 12，不是“8 的接口比 1 贵所以不用”。如果 pack 还需一次付费规划和一次补救，实际可能 10、16 或更多，按各自 endpoint 计算；不能仍写一次 8。

合包有价值的条件还包括质量、延迟和错误耦合，不能仅用金额。若交互端点的程序工具就能完成任务，不需要 12 次，则不应人为夸大它。

### 5.3 重试与失败半径

没有可靠成功率时不编造 `成本 / success_probability`。可显示“无补救”和“允许一次补救”两个场景，或用户 / 本地历史给定的范围。

失败重发可能再次收费；网关超时不代表服务没运行。发出请求前保守预留，结果未知时保留 reservation 并核对，不自动释放再重发。

金额硬上限只有在上游 / 执行器可约束并且成本项足够明确时才能声称强保证。隐藏 agent 调用或 token 总量未知时明确软限制。

## 6. CallBudget：按次计费必须额外有调用账本

区分：

- `business_request`：用户要做一件事。
- `generation`：实际一次模型生成，工具 loop 继续会增加。
- `transport_attempt`：一次 HTTP / SDK 尝试，是否收费按服务规则。
- `provider_job_item`：Batch 中每条独立请求，不能当整个文件一次。
- `auxiliary_generation`：Jev、规划、摘要、rerank、恢复 / 格式修订等调用。
- `billable_observation`：上游已知收费单元和最终或未知账单。

一个数字“max_calls=1”不足以覆盖所有情况。建议明确 scope 与额度：主生成、辅助生成、恢复生成、最大 transport attempts；所有真实出站均记录，即使失败。

同一 request ID 的重复事件不多算，但两个不同请求不能因 prompt 相同去重成一个。GET 取回、token count、files upload 是否收费 / 泄露数据也按 profile 能力和 policy 记录。

按次严格模式默认：主生成 1、辅助生成 0、恢复 0、未知结果不透明重试；用户可显式允许第二次修复。配置 SDK 自动重试 / server fallback 时必须验证是否符合该预算。

## 7. 任务标签与 profile 适配数据

在现有 TaskType 追加：

- `deliverable`：design_bundle / api_contract / static_review / targeted_patch / test_plan / diagnosis。
- `input_readiness`：complete / partial / unknown。
- `feedback_need`：none / optional / required。
- `packability`：forbidden / isolated_items / joint_reasoning / suggested，附规则来源。
- `output_shape / estimated_output`、`independence_requirement`、`risk`、`call_strategy`。

Endpoint / execution profile 可配置 allowed / preferred / disallowed task tags、条件、context recipe、output cap、billing ref；这些字段也可供 Jev 作有限候选判断。

Jev 不需要读所有账户信息、密钥、完整百万 token 代码或私有账单。给它最小任务事实、候选能力、匿名 ID 和任务偏好即可；系数最多作为用户策略说明，最终算费和阈值在程序。

一次可询问多个相关语义问题，但 provider 的每问题收费 / 独立性 / 容量仍按真实协议配置，不假装它必然免费或不受 limits。

## 8. 通用方法与本方案的取舍

公开实践中可以验证的组合：

- 显式用户 pin → capability / 安全硬过滤 → 语义 intent / complexity 分类 → 代码路由。
- 质量评估支撑的 cascade / escalation，失败或不确定才升级；不能只看 token 单价。
- token-based 场景通过稳定前缀 / 缓存减少重复输入；per-call 场景通过完整背景和 joint packing 减少生成次数。
- Provider Batch 用于可等待的独立请求吞吐，不混成一次联合推理。
- 图检索 / repo map 与相关源码一起组织上下文，按任务保留反馈循环。

[TypeSafe intent routing](https://docs.typesafe.ai/patterns/intent-routing.md)和[composite scoring](https://docs.typesafe.ai/patterns/composite-scoring.md)支持“模型给有限判断，host 组合权重 / 路由”的结构；并没有提供本项目通用成本公式或已证明最佳阈值。

没有一个被公开证据证明对所有开发任务最优的打包大小、模型层级和系数。Taomni 应让策略可解释、可手工覆盖、可用真实任务校准，而不是宣称固定“领先默认”永远正确。

## 9. UI 与验收

v0.6采用**统一设置、跨任务复用**：基础只有默认开发方案的规划 / worker / review资源；协议 / endpoint / 费用单位 / 系数 / 能力等属于共享执行资源的高级展开。底层概念分开不等于前台六张配置页，更不是每次调用重填。

主输入只显示默认方案摘要。运行的实际资源、call budget / 费用和拒绝原因可按需展开；缺资料、超预算、额外补救等才主动提示并确认，不把每次发送都变成长参数向导。保存新共享revision作用于后续任务，旧任务保留原snapshot；详见[v0.6 UX](developer-agent-ux-v0.6.md)。

- AC-K01：同协议可绑定不同计费，跨协议可共享用户费用规则；未知不当免费。
- AC-K02：系数、计费单位、任务偏好可手工配置并版本化，Jev 无法改写。
- AC-K03：比较 pack 总成本与完整工作流区间，不比较孤立单轮；不重复分摊。
- AC-K04：主 / 辅助 / 恢复 / transport 调用均可审计，one-shot 没有隐藏生成。
- AC-K05：启用 cost_aware 才用成本选路，pin / 权限 / 质量门和独立验收不被覆盖。
- AC-K06：币种 / credits / points 不可比时 ask，不伪造精确最低价；未知结果保留预算现场。

本轮仅设计和官方资料核查，没有发起实际路由 / 费用校准请求。
