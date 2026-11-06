# Taomni Super Agents：以可验证交付为中心的自主开发工作台

> 模型：`gpt-6.1-sol[1m]` · 日期：2026-11-06 · 状态：新设计 / 可交互研究原型，非已实现产品承诺。
> 实现基线：`feat/development-orchestrator`，调研时 HEAD `16a0c3a27`。
> 配套文件：[离线高保真 HTML 原型](./super-agents-proto-gpt-6.1-sol%5B1m%5D.html)。直接以现代浏览器打开，无外部资源、模型请求或真实云操作。
> 研究方法：当前分支产品源码 + 四个上游仓库的固定提交源码；未读取或复用本分支已有的同任务设计文档、HTML 原型及相关历史设计内容。

## 1. 产品定义与关键决策

**一句话：用户给目标与授权边界，Taomni 在持久化任务中组织多个 Agent，直到交付具有匹配证据、可独立验收的软件候选；不能证明完成时，清楚报告阻塞，而不是生成更多聊天。**

“自主”不是不问用户，也不是自动上线：在已批准的契约、权限和预算内自主分解、执行、修复、验证；需求歧义、高风险副作用、费用越界和最终生产操作交还决策。质量来自真实环境和可核验结果，不来自 Agent 自评、会话数量或生成的测试数量。

| 决策 | 本方案选择 | 明确不做 |
| --- | --- | --- |
| 管理单位 | Delivery Task / 交付任务；Session 是内部执行资源 | 让用户维护十几个并行聊天窗口 |
| 自主架构 | 无执行权限的 Router + 有限权限 Worker + 确定性调度与门禁 | 一个拥有全部工具的万能主 Agent |
| 质量 | 契约 → 覆盖矩阵 → 实际 E2E → 独立 Review → 证据门禁 | “代码生成成功”即“可生产” |
| IDE | 复用现有 Workspace / CodeMirror / Git / 终端，Review-first | 为接近 Thinkrail 而替换编辑器或另造 IDE |
| 模型与 Harness | Provider API 与 Coding Harness 分层适配，保留原始身份与能力 | 把六个可选 Harness 名称当作已支持的六人团队 |
| 成本 | 能力硬约束后的成本优化；金额、预留、估算分离 | 只看 Token 单价、静默换模型、未知费用按零计算 |
| 人机交互 | 决策、阻塞、阶段收据、交付结果默认可见 | 流式工具噪音、私有思维链、全屏聊天记录 |
| 长期运行 | 状态持久化，计算可重启；执行环境归运行时所有 | renderer 存活等于任务存活；Worktree 等于沙箱 |
| 主动触发 | Observe 默认；书面规则授权后可 Auto | 所有 Issue / 聊天消息自动启动有副作用工作 |

### 1.1 衡量目标与非承诺

- 北极星：**满足冻结验收契约且被验收的交付数 / 用户有效干预时间**；同时报告拒收、失败和返工，不只统计成功样本。
- 质量：需求到实际证据的可追踪率、关键路径缺口、首次执行失败、稳定性重复实验、逃逸缺陷与回滚情况。
- 效率：等待人 / 等待环境 / 实际执行耗时分别统计；并发不等于进度，更不自动等于提速。
- 成本：每个被验收交付的模型、Harness、环境、存储与重试成本；所有价格必须有来源与生效时间。
- 注意力：每个任务的打扰次数、未解决决策数、决策等待时间、简报恢复上下文耗时。
- 不承诺任意任务独立成功、穷举测试“全覆盖”、零 flaky、100% 无缺陷或合成实验可外推的生产加速比。

## 2. 上游源码研究：吸收机制，不复制宣传结论

### 2.1 固定版本与可验证来源

2026-11-06 通过 GitHub API 获取下列默认分支 HEAD，并以提交固定读取实现。下文是静态源码研究，不是对上游运行通过、产品安全性或性能的认证；未执行下载代码或上游测试。

| 来源 | 固定提交 | 研究重点 |
| --- | --- | --- |
| [KiroCrew](https://github.com/kirodotdev/KiroCrew/tree/c90e2c05978427441d58c0ac7202a94a6d3b06f6) | `c90e2c05978427441d58c0ac7202a94a6d3b06f6` | 持久任务、claim fencing、恢复、等待与审批 |
| [KiroCrewApps](https://github.com/kirodotdev/KiroCrewApps/tree/713a1722eea13cbdc730d8825bc792dd8934b50d) | `713a1722eea13cbdc730d8825bc792dd8934b50d` | 模板 / 应用目录的不可变发布与签名验证 |
| [Thinkrail](https://github.com/JetBrains/thinkrail/tree/0b076d8cbd0a2a78473d9f7e809f1f6e2bca84a6) | `0b076d8cbd0a2a78473d9f7e809f1f6e2bca84a6` | Harness 复用、worktree 生命周期、Spec 图与 Review 结算 |
| [DeepSeek Super-agent prototype](https://github.com/deepseek-ai/dsh-superagent-prototype/tree/8c32a9dc5d72c033816c6a8110b37f40cf94fba4) | `8c32a9dc5d72c033816c6a8110b37f40cf94fba4` | Router / Worker、触发归属、事务 effects、Observe 策略、监督边界 |

### 2.2 取舍矩阵

| 源码机制与证据 | 采用方式 | 不直接继承的假设 |
| --- | --- | --- |
| KiroCrew [`taskq/store.py:903–1200`](https://github.com/kirodotdev/KiroCrew/blob/c90e2c05978427441d58c0ac7202a94a6d3b06f6/src/kiro_crew/taskq/store.py#L903-L1200)：事务接受、claim generation、状态边验证 | 持久接受后才向用户确认；每次执行携带 fencing token | DB 拒绝旧写入不代表远程副作用只执行一次；上游 generation 可选，本方案必须传递 |
| KiroCrew [`reconcile.py:252–321`](https://github.com/kirodotdev/KiroCrew/blob/c90e2c05978427441d58c0ac7202a94a6d3b06f6/src/kiro_crew/taskq/reconcile.py#L252-L321)、[`waits.py:152–197`](https://github.com/kirodotdev/KiroCrew/blob/c90e2c05978427441d58c0ac7202a94a6d3b06f6/src/kiro_crew/taskq/waits.py#L152-L197)：恢复区分未知副作用；等待有明确原因与唤醒条件 | `reconciling` / `waiting_*` 独立状态，分别计算执行额度与驻留资源 | 不把所有任务种类都视为已有恢复适配；等待进程仍占 RAM / FD |
| KiroCrew [`tool_approval.py:576–852`](https://github.com/kirodotdev/KiroCrew/blob/c90e2c05978427441d58c0ac7202a94a6d3b06f6/src/kiro_crew/dashboard/chat_turn/tool_approval.py#L576-L852)：原始工具身份、参数与 hook gate | 统一 Host 授权服务，拒绝优先、来源可追溯 | UI 显示文字不构成授权，审批系统本身不是 OS 沙箱 |
| KiroCrewApps [`publish.py:273–342`](https://github.com/kirodotdev/KiroCrewApps/blob/713a1722eea13cbdc730d8825bc792dd8934b50d/tools/publish.py#L273-L342)、[`verify_dist.py:34–160`](https://github.com/kirodotdev/KiroCrewApps/blob/713a1722eea13cbdc730d8825bc792dd8934b50d/tools/verify_dist.py#L34-L160)：ref 固定、hash、信任锚与签名 | 远期模板包使用版本、不可变内容 hash 与独立可信公钥 | 签名只是发布者身份，不是行为安全审计；该仓库不是第二套编排引擎 |
| Thinkrail [`agentSessionManager.ts:1504–1516`](https://github.com/JetBrains/thinkrail/blob/0b076d8cbd0a2a78473d9f7e809f1f6e2bca84a6/packages/server/src/agent/agentSessionManager.ts#L1504-L1516)：调用 Pi 真正的 Session | 复用成熟 Harness 的模型循环，Host 管流程、权限、环境与证据 | “薄宿主”不是零集成成本；不复制其数千行 Manager 到 Taomni |
| Thinkrail [`creations.ts:257–307`](https://github.com/JetBrains/thinkrail/blob/0b076d8cbd0a2a78473d9f7e809f1f6e2bca84a6/packages/server/src/workspaces/creations.ts#L257-L307)：基准 OID 与工作区创建阶段 | 独立 worktree / branch，记录应用所有权与创建阶段 | 不照搬强制清理；dirty / untracked 内容须保留和显式确认 |
| Thinkrail [`spec_create`](https://github.com/JetBrains/thinkrail/blob/0b076d8cbd0a2a78473d9f7e809f1f6e2bca84a6/packages/spec-graph/tools/create.ts#L41-L83)、[`validateGraph`](https://github.com/JetBrains/thinkrail/blob/0b076d8cbd0a2a78473d9f7e809f1f6e2bca84a6/packages/spec-graph/core/validate.ts#L26-L79)：稳定 ID、关系、循环校验 | 版本化的需求 / 决策 / 证据图；审批绑定 hash | 结构链接正确不证明实现符合需求；调度 DAG 仍需独立验证 |
| Thinkrail [`requestReview.ts:355–430`](https://github.com/JetBrains/thinkrail/blob/0b076d8cbd0a2a78473d9f7e809f1f6e2bca84a6/packages/server/src/host/requestReview.ts#L355-L430)：未解决 finding 阻止 approve，自动修复次数受限 | Finding 有唯一身份；Host 结算，修复与审查分别预算 | Reviewer 带 bash 不等于只读安全边界；须用权限与执行器强制隔离 |
| DeepSeek [`intake.ts:19–61`](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/core/intake.ts#L19-L61)：去重 trigger、关联 thread 与 ticket | Trigger、业务任务、Worker assignment 分层；任务可跨会话 | 频道、人 / bot 分类不等于身份认证；单仓库研究原型不能直接外推多租户生产 |
| DeepSeek [`effects.ts:38–146`](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/app/effects.ts#L38-L146)：事务内写 effect、generation 防旧完成删除新意图 | Task 变更与 outbox 原子提交；执行后保留 receipt | 不声称 exactly-once；远程成功、回执丢失必须对账，不能盲重试 |
| DeepSeek [`policy.ts:18–60`](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/policy.ts#L18-L60)、[`evals.ts:18–69`](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/core/evals.ts#L18-L69) | 默认 Observe；显式评估、超时、暂停与重排 | LLM 评估不是硬性沙箱；部分后台子任务有例外，不能当全局 watchdog / 费用上限 |

**综合：KiroCrew 解决“长期工作如何不丢、不乱”，Thinkrail 解决“如何审查真实代码与意图”，DeepSeek 解决“如何把人从 Session 管理中释放”。Taomni 额外补上三者不能直接证明的生产交付质量链、环境供给与全成本治理。**

## 3. 当前分支基线与演进约束

下列“已有”来自产品源码，不以旧设计稿、浏览器 mock 或未经本次执行的 QA 报告作运行结论。

| 责任 | 已有事实 / 代码定位 | 新方案补齐 |
| --- | --- | --- |
| IPC 与资源配置 | `src/lib/ipc/orchestration.ts:4–104`：三种 intent、三种 API 协议、六种 Harness 名称、资源、代理、成本系数和 10 个命令 | 能力探测、角色适配、任务分类、真实用量与预算约束；不删除旧字段 |
| 任务持久化 | `src-tauri/src/orchestration/core/store.rs:16–107`：SQLite WAL，runs/tasks/attempts/artifacts/events/context_bundles/inference_packs/request_ledger；command ID 幂等 | workflow / nodes / decisions / leases / outbox / evidence / ledger 的版本化迁移 |
| 编排程度 | `core/service.rs:135–175`：plan 固定三个文档项，review 一个项，develop 一个 implementation；依赖为空；develop 选择首个 Worker | 真正 DAG、多 Worker 依赖、集成节点、评审与测试闭环，不能把多独立运行称协作 |
| 状态与并发 | `core/lifecycle.rs:18–85`：显式开始、容量事务预留；当前并发 1–4，满额返回 `CAPACITY_FULL`，没有等待队列 | 公平队列、分资源额度、租约、等待原因与实际驻留统计 |
| Renderer 生命周期 | `src/stores/orchestrationStore.ts`：revision/CAS、提交 commandId、迟到结果保护；`useOrchestrationRuntime.ts`：1.8 秒轮询 | 保持 CAS / 防迟到；新增可追溯事件游标、断线补拉；旧轮询保底 |
| Context / 输出 | `orchestration/context/mod.rs:5–90`：显式文件、脱敏和大小限制；`pack/records.rs`：NDJSON 验证、完整前缀保留 | 版本化 Spec 图、嵌套指令发现与可审查 Context Manifest；禁止隐藏 Prompt 拼装 |
| Worker | `execution/worker.rs:19–85`：Claude Code 默认执行参数；其它 Harness 需明确二进制 / argv 输出契约 | Adapter capability probe 与角色契约测试；未支持 resume / review 时明确拒绝，不伪装兼容 |
| API 模式 | `execution/api.rs:24–117`：一次文档生成，receipt 尚未完整落库，不是通用带工具 Agent loop | API 保留规划 / 摘要用途；开发交给可验证 Harness，或后续实现独立受控工具循环 |
| 隔离 | `execution/worktree.rs:9–106`：clean committed HEAD、detached worktree、保留产物；`worker_environment.rs`：部分环境与代理控制 | 按能力选择容器 / VM / 受控本地 daemon；独立 HOME、凭据、网络边界 |
| 取消与重启 | `execution/process.rs`、`unix_group.rs`、`windows_job.rs`：监督进程树；未知清理保留容量；重启变 interrupted | 显式 reconciliation / ownership 证明 / 安全释放入口；不能按旧 PID 杀进程或自动重派 |
| 质量与成本 | Artifact 只是 `candidate`；`costCoefficient` 是配置元数据，不是实际路由 / 美元账本 | 真实 diff、执行 receipt、Review finding、环境身份与确定性门禁 |
| 现有 Workspace | `workspacePlatformStore.ts:23–101`：多根目录、独立 tabs / sessions；`WorkspaceShellView.tsx`、`WorkspaceToolbar.tsx`：工具窗、编辑器、Run / Debug | 用 worktree 作为绑定根，复用现有能力，不复制第二个 shell、terminal 或 Git 状态 owner |

注意：`src/stores/agentsStore.ts` 的旧展示流会合成 worktree / 单测文字，不是本方案复用的执行依据；实际 UI 使用 `orchestrationStore`。Browser stubs 不验证 native HTTP、SQLite、worktree、进程树或真实工具权限。

### 3.1 必须保留的兼容性不变量

1. 保留现有 `orchestration_*` 十个命令名、`AgentRun` v1 持久格式的可读性、`commandId` 幂等与 revision/CAS。
2. 保留 candidate / partial 含义、完整前缀候选及原始失败；不得把部分成功改成完成，或隐式重复有费用请求。
3. 保留 app / custom / none 三种代理，Vault 引用与已配置代理失败的显式报错；none 绕过系统 / 环境代理。
4. 保留进程清理“不确定就不声称已停”，Renderer 关闭不取消后端工作的所有权边界。
5. 启用新能力前修正角色契约：当前 plan/review 选择 Worker 不能直接认为有效；UI 选项受 Adapter 探测结果约束。
6. 不读取用户 dirty 工作目录当冻结输入；默认沿用 clean HEAD。可选快照导入必须明确展示 dirty / untracked 范围并获确认，绝不自动 stash 或清理用户数据。

## 4. 信息架构与低打扰交互

### 4.1 主布局

保留 Taomni 的工具 rail、Workspace 切换、Git 状态与主题。Agents 内：左侧交付队列，中间任务视图；详情使用按需抽屉，不常驻海量聊天或 Agent 头像墙。

| 主视图 | 默认内容 | 按需展开 |
| --- | --- | --- |
| 交付概览 | 一条最重要决策、阶段状态、交付收据、阻塞与预计费用 | 依赖图、Worker、原始事件、Context Manifest |
| 工作区与变更 | changed files、实际 diff、候选 SHA、锚定评论、Keep / Rework | 编辑器、PTY、完整 Git、外部 IDE、hunk Revert |
| 质量中心 | 验收覆盖、独立 Review、执行矩阵、失败 / flaky / 缺证据 | 具体 trace、截图、视频、日志、receipt、原始失败 |
| 执行环境 | 蓝图、位置、创建 / 部署 / 启动 / 探测、下载与租约 | 工具链指纹、代理、数据种子、资源与清理记录 |
| 路由与成本 | 资源任务分类、能力、成本系数、已确认 / 预留 / 预计费用 | 定价来源、模型 usage、Harness 账单、路由解释与对账 |

### 4.2 输出契约

- **立即通知**：需要用户决定的歧义、权限、超预算、数据 / 安全风险；任务级失败或长时间无进展。相同原因合并成一个可更新的 decision。
- **阶段收据**：契约冻结、可审查候选、独立 Review、完整验证、最终阻塞 / 结果。每条包含结果、影响、证据链接与下一步，默认不超过一个紧凑卡片。
- **不通知**：单次读文件、检索、普通命令、每个 token、重试心跳、重复“思考中”。内部完整记录，但不伪装成待阅读消息。
- **进展保持可见**：显示当前阶段、子任务状态、最近实质结果时间、下一唤醒条件；不虚构线性百分比。已完成阶段与在途阶段分开。
- **生成简报**：用户原始提示与增量约束、已答 / 待答决策、阶段进度、候选与证据、费用、阻塞、下一步。标明摘要基于哪个 event cursor，可导出 Markdown。
- **不采集私有思维链**：保存工具事实、简要行动理由、决策依据与用户可见消息，不要求模型输出隐藏推理。
- 通知可设仅决策 / 阶段 / 详细、免打扰与每日汇总；重大安全与费用阻塞不能静默消失。IM 默认短摘要；Git / 文档提供结构化高密度收据，多渠道都绑定同一任务。

### 4.3 决策不是聊天追问

`Decision` 包含：问题、推荐、备选与影响、目标 / 候选 / 计划 hash、费用与权限范围、有效期、拒绝结果、授权主体与审计。回答通过 CAS 幂等提交，过期答案拒绝；拒绝不等于失败，也不会自动选择更宽权限方案。可委派决策给已授权人员，不能由 Worker 给自己批权。

## 5. 可复用流程：Recipe + 交付契约 + 约束型 DAG

不把每一种开发任务写成不同产品入口。Recipe 是版本化声明：输入 schema、必要澄清、阶段 / 节点、能力需求、证据门禁、允许的修复循环、权限和预算；Planner 只能在这些边界内实例化 DAG。Recipe 更新不会改变运行中的任务快照。

| Recipe | 特有流程 | 不能跳过的验收 |
| --- | --- | --- |
| 0→1，有需求无设计 | 需求清理 → 关键未知 / 用户旅程 → 设计方案与取舍 → 垂直切片 → 并行功能 → 集成 | 关键设计决策、API / 数据模型、权限、错误态、真实服务全链路、可部署与回滚说明 |
| 0→1，已有需求与设计 | 设计版本冻结 → 需求差异 / 可实现性 → 契约与 stub 边界 → 按模块并行 | 设计偏离记录、契约兼容、UI / API / 持久化 E2E、部署演练 |
| 既有大库修 Bug | 仓库 / 指令 / 模块地图 → 基线 → 真实复现先红 → 最小补丁 → 独立审查 → 影响面回归 | 原始失败、修复后同路径与邻接状态、真实内容 / 生命周期断言、平台身份 |
| 功能迭代 / 重构 | 行为契约 → 依赖与迁移面 → 小批替换 → 差异审查 → 等价回归 | 旧 API / 持久格式 / 取消 / 故障语义、性能边界、完整关联回归 |
| 依赖或安全升级 | SBOM / 影响范围 → 修复版选择 → 兼容矩阵 → 回滚试验 | 漏洞来源与版本身份、运行回归、供应链校验；不擅自发布公开漏洞或凭据 |

### 5.1 一个 Bug Recipe 的实例

```text
冻结基线 / 验收契约
  → 复现 Worker ───────────────→ 不可变失败证据
  → 范围分析 Worker ──────────→ 模块 / 风险 / 影响用例
  → 实现 Worker（独立 worktree）→ 候选 patch
  → QA Worker（独立上下文）────→ E2E 草案 + 审核
  → 集成候选（单一写入者）─────→ 固定 candidate SHA
  → 独立 Reviewer + 环境准备（可并行）
  → 静态 / 单测 / 集成 / 受影响 E2E + 完整 crash 集合
  → 发现问题？有限修复 → 新候选 → 失效证据重跑
  → 证据门禁 → 人类验收 → 准备 PR / 发布计划（单独授权）
```

- DAG 验证循环、缺失输入、多写冲突、资源不可能满足和越权；动态加节点需要新的 plan revision 与范围 / 预算评估。
- 并行不按 Agent 数量设 KPI：同一文件冲突、共享服务与稀缺测试桌面串行；探索可并行，集成、最终验收有单一 owner。
- Worker 输出结构化 Artifact / Candidate / Finding / Receipt，不直接向用户刷屏；Router 聚合事件，但不能把未验证的 Worker 自述当成成功。
- 大库采用路径 / 符号 / 依赖影响的分层检索，记录源文件 hash 与指令作用域；不能将检索遗漏包装成“已理解全部仓库”。

## 6. 架构、数据与长任务可靠性

### 6.1 责任边界

```text
Workspace UI / CLI / 后续 IM、Issue、CI
  → Intake：身份、scope、签名、去重、限流
  → Router：归属任务、过滤、摘要、决策，不配 Bash
  → Durable Control Plane：Task / Recipe / DAG / Policy / Budget / Outbox
     ├─ Scheduler：能力匹配、队列、lease、fencing、并发
     ├─ Harness Adapter：启动、有限 steer/resume、取消、事件、usage
     ├─ Environment Manager：本地 / VM / 容器 / BYOM / 云
     ├─ Quality Engine：用例、执行、Review、Evidence Gate
     └─ Supervisor：心跳、实质进度、重启对账、资源回收
  → Execution daemon / Harness / QA runner / Artifact store
  → 结构化事实事件 → 通知 / 简报 / 审计
```

- 首期控制面留在现有 Rust 服务 / 本地 SQLite；不引入必须上云的账号或服务。UI 不拥有进程、下载和 lease。
- 桌面关闭后的持续执行需要用户启用的本地后台服务；关闭 renderer 与退出整个应用区分。未启用时先检查点并标记 interrupted，不承诺电脑关机仍执行。
- 第二阶段 daemon 支持机器离线重连、短期 capability token、mTLS、任务租约与资源证明。无头 Linux 容器不能替代桌面 GUI / OS 输入验证。
- 第三阶段才将无状态 Router / Scheduler 计算移到云；任务状态、密钥、数据驻留与环境执行位置可分离。单机文件锁不可冒充分布式协调，需服务端事务与租约设计。
- 外部 Supervisor 不与目标 Worker 共用上下文和生命周期；确定性监督先行，LLM 只在确有停滞迹象时低频判断方向，不无限轮询烧费。

### 6.2 核心实体与版本绑定

| 实体 | 关键字段 / 不变量 |
| --- | --- |
| `DeliveryTask` | `taskId, commandId, revision, workspaceId, contractHash, recipeVersion, baseSha, planRevision, state`；业务身份不随 Session 改变 |
| `TaskNode / Attempt` | 依赖、输入 / 输出 schema、resource snapshot、attempt ID、generation、lease、retry budget、heartbeat、result receipt |
| `Candidate` | base SHA、patch / tree hash、integration SHA、源 task / attempts、变更文件、Spec 版本；immutable |
| `Decision / Grant` | 问题、选择、actor、scope、plan / candidate hash、上限、过期时间、拒绝与撤销记录 |
| `EnvironmentLease` | blueprint hash、owner、platform / arch、image / toolchain digest、resource IDs、TTL、proxy snapshot、health receipt |
| `TestCase / Execution` | requirement IDs、case / runner hash、platform、candidate / binary digest、attempt、状态与 assertion results |
| `Evidence / Finding` | 输入 hash、原始产物 hash / 存储引用、失败场景 / 严重性、reviewed SHA、是否失效 / 缺失 / 已验证 |
| `BudgetLedger` | 货币、价格来源、生效时间、confirmed / reserved / estimated / unknown、usage ID、request / lease 唯一键 |
| `Event / Outbox` | task revision、单调 sequence、因果关系、payload schema、effect key、generation、重试与接收方幂等键 |
| `Lesson` | 来源证据、project / user scope、审批、版本、有效期、冲突与撤销；不是授权凭证 |

候选、契约、测试脚本、Runner、二进制或环境关键身份任一改变，受影响 evidence 标记 stale。失效是新状态记录，不删除旧 receipt；重新验收不得只修改一条“最终通过”布尔值。

### 6.3 工作流状态与恢复

- 工作流：`draft → awaiting_contract → queued → active → awaiting_acceptance → accepted`；可到 `blocked / failed / stopping / cancelled / reconciling`。
- 节点：`pending / ready / leased / running / waiting_input / waiting_environment / retry_wait / succeeded / failed / unknown`，不能用同一个“运行中”覆盖所有等待。
- 旧 `AgentRunStatus` 保持不变，由兼容投影映射新状态；`accepted` 是新实体状态，不能把旧 `candidate` 重新解释为完成。
- 接收命令：校验权限 / 版本 → 单事务写 Task / Event / Outbox → commit → 返回 durable ID。派发失败仍能从 outbox 恢复。
- Claim 同事务获取 generation、预留预算 / 配额；每次 heartbeat、产物发布与终态写回校验 token。租约过期只能拒绝旧写入，无法自动撤销旧进程的外部副作用。
- 重启先对账：daemon 任务身份、进程所有权与启动时间、云资源标签、账单 / artifact，再决定 attach、标记 unknown 或重排。禁止用旧 PID 单独认领 / 杀进程。
- 外发 PR / 评论 / 云创建等使用稳定 effect key 与可查询回执；远程成功但本地不知时，`reconciling`，不能盲重放。不承诺 exactly-once。
- 取消：停止新派单 → 传播到子任务 / 网络 → TERM / KILL 或 Adapter abort → 核实清理 → 释放已证明空闲的配额。未知子进程仍占有 ownership，需可审计对账入口。
- 同时计算活动执行位、驻留 Session / 进程、环境 lease 与下载；等待可以释放执行位，但不能把依然驻留的资源写成零。
- 本设计默认节点自动安全重试最多 2 次，自动 Review 修复循环 1 次；仅限无未知副作用且在授权 / 预算内。原有 API partial 显式补救的一次上限不被全局策略暗中改变。
- Watchdog 分别监控准入等待、心跳、无实质进展、绝对执行时限、子 Agent / 后台命令、环境 lease；先诊断，有限恢复，最后请求决策，不只放一个 900 秒总超时。

### 6.4 Harness 与 Prompt 契约

保留现有三协议与六 Harness 配置，新增能力声明及运行探测：`start, resume, steer, abort, structuredEvents, usage, toolApproval, sandbox, childBudget, roleSupport`。缺少能力时展示限制，禁止 silent fallback。

- Provider / model、Harness / version、执行环境与 workflow role 是四个不同维度；一个 CLI 的订阅额度不等于模型 API 单价。
- 现有 API one-shot 继续用于文档、评估或摘要；不能无工具地宣称实现软件。Harness 接受明确 cwd、argv、冻结输入、范围权限与最大 turns / 子任务预算。
- Host 展示其任务指令、上下文来源、规则与 hash；Harness 自有系统提示 / compact 策略标为 Harness 所有，不谎称宿主能完全解释闭源引擎内部 Prompt。
- Harness 自带多 Agent 必须计入父级预算、并发与取消树；不支持观测时只能作为有明确上界的 opaque 执行，不能任意递归派生。
- stdout / stderr / NDJSON 的结束结果、退出码与产物身份共同判断执行结果；“文本说完成”不能代替退出与证据。

## 7. 质量系统：从生成用例到生产候选

### 7.1 验收覆盖与 E2E 编写

覆盖矩阵按 `需求 × 用户角色 × 状态转换 × 数据边界 × 异步/并发 × 故障 × 平台` 展开，风险决定主路径全检、边界 / 组合覆盖与探索比例；不以页面数、行覆盖或用例数代替业务覆盖。

1. 从冻结契约、设计、历史缺陷、代码变更和现有用例推导验收项与风险；明确不支持的平台与尚未覆盖状态。
2. 独立 QA Worker 生成版本化草案，优先复用项目 YAML / Playwright / native runner，而不是另建不可维护脚本体系。
3. 静态检查 selector、Fixture、断言、超时、权限、平台、清理、用例去重与可执行 schema；生成状态为 `draft / needs-review`，不是 passed。
4. Locator 优先 role/name 或稳定 test ID；显式健康 / 就绪条件，不使用固定 sleep、易变 CSS 链或脆弱截图作为唯一 oracle。
5. 独立审阅断言：检查真实业务内容、pane 数量 / 映射、dirty buffer、实际文件 / DB / API 副作用与生命周期；`assert_no_runtime_errors` 是必要补充，不是全部证明。
6. 在隔离数据与真实目标环境执行；预期失败反例、受控故障注入或可行的变异验证能证明断言确会失败，不能生成永远绿的空壳测试。
7. 关键路径进行重复运行、不同数据种子与相关时序验证，保留每次 attempt；稳定性目标与费用可配置，不声称有限重复可证明零 flaky。
8. 用例审核通过、执行证据齐全后入库，并建立需求与反例链接；后续变更按影响面重选，但不缩减必跑专项。

### 7.2 质量门禁与修复闭环

| Gate | 必须满足 | 不接受的替代 |
| --- | --- | --- |
| G0 契约 / 基线 | 可测试验收条件、依赖版本、基线 / 已有失败归属 | 模糊目标、“看起来没问题” |
| G1 静态 / 单元 / 契约 | 项目规定命令、类型、格式、边界与兼容检查 | 构建通过就跳过行为测试 |
| G2 独立 Review | Finding 反例验证、严重项解决、reviewed SHA 一致 | 实现者自己的批准文本 |
| G3 E2E | 受影响功能与关键用户旅程、真实结果与故障语义 | 生成用例、Browser stub 或测试截图即 native 通过 |
| G4 平台 / Crash | 项目要求的完整 `crash-regression` browser/native；匹配源码的 QA release 与目标平台矩阵 | 缺失、跳过、旧二进制、环境失败记为通过 |
| G5 生产准备 | 可复现构建、配置 / Secret 检查、迁移 / 回滚、部署探针、制品身份 | 自动把候选直接部署生产 |

失败 → 分类产品 / 测试 / 环境 → 归属责任 Worker → 在预算内修复 → 新候选 → 失效证据重跑。测试作者不能自行删断言、降低要求、隔离关键 flaky 后放行；范围或门槛变化需要有理由的契约变更与重新授权。

Review 至少区分 correctness、安全 / 数据边界、维护性 / 性能、测试充分性；优先做目标明确的独立读，不为“多 Agent”盲目增加审查层数。Finding 包含具体输入 / 状态 → 错误结果、位置、severity、验证、处置与重审；严重 Finding 未关闭时 Host 拒绝交付。

### 7.3 项目原生质量规则

复用 [`qa-ui-auto-tests/ci/crash-regressions.md`](../qa-ui-auto-tests/ci/crash-regressions.md) 与现有 runner：完整 tag + 受影响功能；native 串行、本地全部测试 worker 不超过 2、隔离 QA 配置和测试桌面、匹配 QA release。候选身份、case / runner hash、平台 / WebView、二进制 digest、原始 receipt 与 runtime-errors 同时入证据。

示例运行方式（正式产品改动时，不是本次文档原型已通过的声明）：

```sh
# 通过项目 background_job.py 启动，browser 完成后再跑 native。
PYTHONPATH=.agents/skills/qa-ui-auto/scripts python -m qa_ui_auto run \
  --mode browser --config /isolated/browser.yaml --tag crash-regression --workers 2 --require-pass
PYTHONPATH=.agents/skills/qa-ui-auto/scripts python -m qa_ui_auto run \
  --mode native --config /isolated/native-release.yaml --tag crash-regression --workers 1 --require-pass
```

## 8. E2E 环境工厂与网络 / 下载生命周期

### 8.1 一个 Environment Blueprint 管到底

蓝图锁定平台 / arch、镜像 digest、工具链与依赖锁、构建命令、应用启动、服务 / 数据 fixture、健康 / 就绪探针、网络白名单、代理模式、秘密引用、资源上限、证据收集和清理。测试过程使用合成账号与隔离数据；生产数据克隆必须独立审批与脱敏。

| 位置 | 用途与边界 |
| --- | --- |
| 本地隔离 | 小型 Web / API、容器与项目已有 QA 桌面；不占用用户个人浏览器 / app-data |
| BYOM daemon | 真实 Windows / macOS / Linux 桌面、签名 / WebView / 原生权限；用户显式注册，短期能力授权 |
| 临时云环境 | Linux 服务容器 / Windows VM；macOS 使用有资质的真实 Mac 执行器，不假设普通容器可提供 |

生命周期：`requested → authorized → provisioning → dependencies → deployed → starting → health_check → ready → running_tests → collecting → stopped / retained / destroying → destroyed`；各阶段可 `failed / cancelling / cancelled / reconciling`。TCP 端口打开不是健康；服务探针、数据库真实查询、应用语义 locator / native readiness 共同验证。

- 环境 ownership 与 UI 生命周期分离；重开恢复 task state；蓝图 + artifact + owner 去重，不重复创建或下载同一制品。
- 同一环境可以安全复用时校验指纹与数据重置；无法证明干净则新建。用户机器上的未知旧进程不能被当作可删除 Fixture。
- 收集日志 / trace / 截图 / 视频 / crash dump / receipt，敏感内容先脱敏再允许外发。优先结构化断言；录屏用于定位，不是唯一通过条件。
- TTL、闲置回收、最大租约与费用一起限制；保留调试环境需要明确时限与费用确认；清理失败持续可见，对账后释放额度。

### 8.2 代理与大制品下载：不降低仓库规则

1. 三种模式：应用代理（默认）、独立持久化 feature proxy、none。复用 Settings 配置 UI 与 backend resolver，不另写代理语义，feature 设置不覆盖应用设置。
2. none 显式禁用系统 / 环境隐式代理；配置代理失败报可操作错误，不静默直连。云、daemon、Runner 子进程都遵守同一模式快照。
3. 状态：connecting、downloading、verifying、completed、cancelled、failed。显示 bytes / total / percent；未知 total 使用不定进度，不伪造百分比。
4. 后台下载由服务拥有；关闭对话框不取消。显式取消关闭网络 / 子进程，并保留安全 `.part` 与 manifest；重试、应用重启扫描可复用分片。
5. 恢复验证 Range / Content-Range、offset、ETag / Last-Modified 与实际字节；服务器返回 200 或 validator 变化时，清晰提示并安全重下，绝不把整文件追加到分片。
6. 完成前检查可用 checksum / 签名 / pinned digest；只有通过后原子发布 completed artifact。取消、失败不覆盖可用镜像；缺少可信完整性来源时降低可用性声明并按策略阻塞。
7. native 测试覆盖三种代理、环境变量绕过、代理失败、未知长度、断点跨重启、无 Range / 错误 Range、checksum 失败、取消与 duplicate 请求。Browser stub 不作为网络语义验证。

## 9. 任务适配与成本治理

### 9.1 资源 Profile

在 `AgentResource` 现有配置之上增加：任务分类（事件路由、规划、UI、API、大库修复、测试编写、Review）、上下文 / 工具 / 模态能力、平台、隐私 / 区域、并发 / rate limit、成功 / 失败样本来源、延迟分布、价格版本与近期连通性。历史表现按项目和任务类型分层，样本不足标 unknown，不能拿一次成功作通用评分。

调度两步：先满足角色 / 工具 / sandbox / 上下文 / 数据驻留 / 独立性等硬约束；再比较预期总成本与时延，选最便宜的合格资源，而不是最便宜的名字。

`预计成本 = API 输入/输出/缓存用量 × 有来源单价 + Harness 计费 + 环境/存储 + 预计重试/修复`。模型自报不等于账单；usage 与厂商对账分开。相对 `costCoefficient` 没有美元锚点时只提供相对估算；金额 unknown 不得填零，也不凭空给模型定价。

### 9.2 硬上限与升级策略

- 全局日预算 / 项目 / 任务 / 节点 / effect 预留，事务扣额防并发超售；请求结束将 reservation 转 confirmed，不能同时重复计费。
- 已确认、运行中预留、未来估算、未知账单四栏独立。预计最终 = 已确认 + 在途预留 + 后续估算；用户可查看价目来源和误差。
- Provider usage / 实际 model / stop reason / cache / reasoning usage receipt 落库，关联 request ID；Harness 不支持 usage 时显示 unknown 与配置上限，不伪造精确费用。
- 将超额时暂停新派单，已在途工作采取最安全可取消策略并披露远端可能继续计费；预算不是“取消 API 请求就撤销所有账单”的保证。
- 升级强模型必须有失败类型与剩余预算依据，次数受限；隐私区域、功能或授权范围变化必须重新决策。
- 先避免不必要的 Agent：事件 fast path、局部检索、缓存稳定 Spec、合并结构化规划、只对可验证缺项补救。保留 `preferPackedPlanning` 的用户偏好，但实施真实可测策略，不继续停留在开关展示。

## 10. 安全、主动工作与持久记忆

- 默认权限为只读 / Observe；用户启动任务可批准有限开发范围。生产凭据、对外发布、删除用户数据、云付费、合并与生产部署是不同 capability，不能由“自主模式”一键隐式授权。
- Worker 用短期 Vault 引用、独立 HOME、最小环境变量、文件范围、出站白名单与实际 OS 边界；容器挂载 `.git` / SSH agent / cloud credential 的风险显式展示。
- Repo 指令、Issue 文本、网页、日志、依赖包与工具返回视为不可信输入；不能扩大系统策略。Router 的模型分类只提出建议，确定性校验决定能否执行。
- Trigger 做签名 / 身份认证、白名单、scope、去重、重放防护、速率限制与 retention；传入“我是管理员”不是授权。
- 主动任务先 Observe 记录 `would_accept`，用户审核规则、项目、允许操作、预算、quiet hours 后启用 Auto；允许停用、撤销与全局 kill switch。
- lesson 来源绑定失败 / 纠正证据，区分用户偏好、项目事实与执行规则；需审核、冲突检测、期限与撤销。重复模式生成 Skill 草案，不能悄悄成为新权限或下载可执行插件。
- 未来模板目录固定内容 identity、可信签名、权限 manifest 与撤销策略；下载与执行分离。签名通过不代表免审，内置模板首期随产品发布，不引入必须联网的 marketplace。

## 11. 与当前代码的分层落地

### 11.1 模块与 API 建议（均为新增设计，非现有命令）

- Rust 在现有 `orchestration/` facade 下按状态所有者拆 `workflow/`、`scheduler/`、`policy/`、`adapters/`、`environments/`、`quality/`、`ledger/`、`supervision/`；每个 owner 同时拥有状态、异步操作、取消与清理，不把它们塞入一个巨型 service。
- 前端 `components/agents/superAgents/` 是视图组合层；typed stores / lib 分别拥有任务投影、决策、证据、环境、成本；复用 Workspace capability ports，不从 owner 回引 UI shell。
- 新增命令空间示意：`orchestration_v2_create_task / submit_decision / get_events / reconcile_attempt / request_environment / cancel_environment / run_quality_gate / get_ledger`。所有写命令携带 `commandId + expectedRevision`，输入 schema 版本化。
- `get_events(taskId, afterSequence, limit)` 提供补拉；未来 push 只发 cursor 提示，不能成为唯一状态来源。幂等去重、断线恢复、跨视图选择与迟到结果 guard 都要测试。
- DB migration 从 schema v1 原子迁移、备份、失败不启动新派单，旧记录继续可读；同一 task 的新事件与旧投影事务更新。不可让旧客户端写坏 v2 owner。
- 单个新增 / 拆分源文件目标 200–500 行，上限 800；按生命周期 / 协议 / 平台边界拆分；测试 harness 单独归属。`pnpm check:refactor` 与每项行为 / 合同测试共同验收，行数减少不能证明等价。

### 11.2 分期与出口条件

| 阶段 | 范围 | 可检查出口 |
| --- | --- | --- |
| P0 · 契约与真实收据 | 修复角色能力约束，落库 invocation usage，真实 diff，低打扰投影，决策版本绑定 | 不再伪兼容 Worker plan/review；receipt / candidate 身份一致；旧 IPC / partial / 取消测试不退化 |
| P1 · 本地可交付闭环 | 两种 0→1 + Bug / Refactor Recipe、DAG、队列、独立 Review、预算预留、确定性门禁 | 小规模并行实现 + 集成 + Review + 失败修复完整运行；不能用固定“成功”文案通过 |
| P2 · 环境与原生验证 | 本地 / BYOM，部署启动健康、下载续传、完整 E2E / crash、未知副作用对账 | daemon 掉线重连、后台所有权、真实网络 / 进程 / 三平台证据；匹配 QA release |
| P3 · 云与主动工作 | 云 lease、无状态计算、Issue / CI 触发、Observe→Auto、长期 lesson | 用户离线时按规则推进；预算不越界；多租户 / 审计 / 撤销经安全验证 |

首个可落地纵切片选“既有大库 Bug”：复现先红 → 一个实现 Worker → 一个独立 Reviewer → 本地 / BYOM 真实回归 → 证据 gate → 人工验收。先验证这条闭环，再增加并行度和全自动触发，不先造几十个 Agent 的展示墙。

### 11.3 必测失败场景

| 边界 | 测试与必须观察到的事实 |
| --- | --- |
| 持久化 / 并发 | 创建回应丢失重试只有一个 Task；claim 竞争、旧 generation 发布被拒；迁移失败不派发 |
| 重启 / 副作用 | 远程创建成功但 receipt 丢失先对账；unknown 子进程不得释放额度；PID 复用不误杀 |
| Harness | 真实 CLI 版本、stdin / NDJSON / exit、不同角色、不支持能力拒绝、cancel 子树、usage unknown |
| 多 Worker | context 隔离、同文件冲突、依赖与集成顺序、child 预算传播、超额不启动新任务 |
| 质量证据 | 候选 / case / Runner / binary 改变后 stale；失败重测不能覆盖原件；缺平台 / flaky gate 拒绝发布 |
| 环境与网络 | 真正服务健康、取消不泄漏、重开恢复、云 TTL / 清理失败、代理 / Range / checksum 的 native 测试 |
| 权限 | 过期 / 错目标 decision 拒绝、Worker 自批权拒绝、外部文本注入不能升级权限、撤销阻止新 effect |
| 交互 | 少输出仍可看到进展、阻塞与失败；简报可追溯；键盘 / 深色 / 窄屏 / 重载无状态错配 |

## 12. HTML 原型说明与验证边界

### 12.1 高保真范围

原型是一个自包含 HTML：内联 CSS / SVG 图标 / 原生 JavaScript / 系统字体；无 CDN、远程图片、字体、框架、网络 API 或构建依赖。CSP 禁止网络与外部资源。样式依据 `src/styles/chrome.css` 的浅色 / 深色 tokens、`theme.css` 的紧凑 chrome 与 Workspace 工具窗；正文稍放宽留白以减少信息噪音，不改变产品色系。

默认 TASK-042 展示一次生产交付前的**阻塞状态**，不是展示“所有 Agent 已成功”的乐观故事：有候选、有失败原件、有未齐的平台证据、一次云环境申请。所有金额、检查数、提交标识、时间线与证据都是显式标注的示例，不是本次运行事实。46 是演示 manifest 的检查总数，不等于仓库真实 tag 的 case 数量。

### 12.2 可操作路径

1. **交付概览**：批准 / 拒绝本次环境申请；查看权限；暂停 / 恢复新调度；追加约束；展开阶段事件；生成 / 导出简报。
2. **新建任务**：四种 Recipe、目标、项目、预算、自主程度；生成队列契约预览，不伪造后台执行。
3. **工作区与变更**：三文件切换、只读 diff、候选保留、锚定 Review 意见；重做标记导致旧证据失效。没有真正编辑、PTY 或 Git 操作。
4. **质量中心**：覆盖与用例生成方法、执行矩阵、失败原件 / 重测详情、独立审查；门禁缺证据时不可交付。
5. **执行环境**：本地 / 云 / BYOM、平台、三代理；模拟准备、取消、分片继续、后台视图切换、刷新恢复、显式回收。不是 Docker / 云 API 实现。
6. **路由与成本**：新增 Provider / Harness 资源、任务分类、成本系数、feature 独立代理；成本账本、路由解释、超预算拦截。
7. 深浅主题、Tab 键盘左右 / Home / End、`Ctrl/Cmd+K`、原生 dialog / Escape、窄屏布局与命名空间 localStorage 恢复；保存失败退化为会话内状态。

只有 TASK-042 有完整详细演示；其它任务明确显示契约预览，不复用它的费用、环境或测试结果。localStorage 只存演示数据，不接受供应商密钥、不覆盖真实应用配置。刷新中的模拟测试标记 interrupted 而不是 passed；模拟环境阶段可恢复，但这不是后端持久执行能力的实证。

### 12.3 本次交付的验证记录

| 检查 | 本次实际结果 | 证据 / 限制 |
| --- | --- | --- |
| 自包含静态检查 | 通过 | 内联 JavaScript 通过 Node VM 语法检查；无外部资源标签；CSP 禁止外联 |
| 浏览器交互 | 13 组全部通过 | 使用已安装 Chrome、Playwright JS API，`file://` 打开；不是 Browser stub 的后端验证 |
| 生命周期与证据 | 通过原型断言 | 环境取消 / 分片继续 / 切换视图 / 刷新恢复；平台不匹配禁止重测；失败原件保留；Review 重做使旧证据与授权失效 |
| 配置与低打扰 | 通过原型断言 | 四 Recipe、新任务不复用旧证据、三代理、资源分类 / 成本系数持久化、超预算拦截、简报导出、提示内容转义 |
| 视觉 / 可访问操作 | 通过所测范围 | 浅深主题已截图检查；1440 / 1100 / 768 / 390 宽度下五视图无页面 / 主内容横向溢出；Tab 方向键 / 命令面板可用；非完整 WCAG 审计 |
| 运行时与外联 | 所测交互中无异常 / 无外部请求 | Playwright `pageerror` 与请求监听；不外推未执行浏览器或路径 |
| 颜色 | 12 对关键配色通过 | 浅深文字 / 状态色计算均 ≥ 4.5:1，最小 4.79:1；仅单一预算 meter 与文字统计，无分类多色图表 |
| 仓库边界 | `check:refactor` 通过 | pnpm 10.33.0；785 native commands、328 facade exports、39 literal events 合同保留，928 modules 边界、4312 sources 行数检查通过 |
| 完整 browser crash-regression | **未通过：setup 环境阻塞** | runner 已选择整组 9 个 browser cases，均在 setup 阶段失败，退出 1；指定 `chromium_headless_shell-1228` 不存在，未能完成真实用例步骤。没有用安装的 Chrome 偷换其二进制身份 |
| 完整 native crash-regression | **未通过：setup 环境阻塞** | runner 选择 10 个 native cases，退出 2；默认 QA 二进制的 `.qa-identity.json` 不存在；无匹配 QA release，无桌面 display，未开始用例执行 |

本机实际 Node 为 24.13.0，不是 CI 要求的 Node 22；因此以上工具执行不声称 CI 同环境验证。未执行产品构建 / Rust 测试 / 三平台产品回归，也未为文档工作安装新的浏览器或构建大型 native 二进制。正式实现评审前仍必须在 Node 22 / pnpm 10、匹配 QA release 和隔离桌面中完成 §7.3；当前失败 / 缺失证据不能计为通过。

本地诊断材料保存在 gitignored `qa-ui-auto-report/super-agents-gpt61/`：`prototype-check.mjs`、`prototype-results.json`、四张浅深 / 质量 / 窄屏截图、导出简报、browser `runner_receipt.json` / summary 与 native setup 日志。未提交运行时材料，不将其中的模拟测试身份当作真实产品凭据或质量证据。

本次仅新增这份设计与离线 HTML，不修改产品源码或 native 行为。原型可用于方案讨论和交互体验；它不证明产品原生 E2E、云环境或多 Agent 自主交付已实现，产品功能的完整验收仍然开放。

---

**最终建议：把 Super Agents 定义为“对交付负责的持久化控制面”，而不是“更热闹的聊天”。先用一个真实 Bug 闭环证明：能复现、能改对、能独立审查、能部署测试环境、能拿到匹配证据、能在预算内停止；然后再扩大自主与并发。**
