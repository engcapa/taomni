# 开发编排：KiroCrew、开源执行系统、记忆与 Jev 调研

- 核查：2026-11-03；本文保留第二轮生态依据，补充[首轮资料](research-and-baseline.md)。第三轮 [少调用 / CodeGraph](packed-inference-and-code-context.md)、[多协议](llm-protocol-contract.md)、[成本系数](cost-and-selection-policy.md) 已同步到 v0.3 主设计。
- 来源：官方仓库、官方文档及少量关键源码；下载经用户提供的 `http://127.0.0.1:31128` 代理。资料放在独立临时目录，只读，未执行远端代码 / 安装 / 付费调用。
- 证据等级：A=读到具体实现；B=官方接口 / 架构说明；C=README 说明。未列实跑性能排名，许可证仅是快照核查，不是完整法律意见。
- 结论同步到[主设计](../development-orchestrator-design.md)、[上下文与记忆](context-session-memory.md)、[决策与路由](decision-and-routing.md)。

## 1. 总体结论

需要区分四类系统，不能把它们统称成“多 agent 框架”：

1. **调度控制面**：KiroCrew、Gas Town、Agent Orchestrator。它们拥有进程、任务 / session、工作区或队列，整套嵌入会和 Taomni 重复管理。
2. **可调用执行器**：OpenHands、Aider、mini-swe-agent、OpenCode。适合由 Taomni 分配有界工作包。
3. **图 / agent runtime 库**：LangGraph、DeepAgents。适合特定 API 工作流，不天然提供安全隔离，也不必成为桌面运行前提。
4. **上下文 / 记忆 / 判断服务**：OpenViking、Letta / LangMem、Jev。辅助资料与决策，不应成为任务权限和验收的真相源。

**推荐保留 Taomni 确定性内核，扩充 ContextCompiler、LogicalSession / Handoff、MemoryService、DecisionService；通过外部执行器覆盖不同开发任务。** 不复制一个总管 agent，再套另一个总管。

## 2. KiroCrew：本轮重点

### 2.1 身份与架构

[官方仓库](https://github.com/kirodotdev/KiroCrew)，读取快照 [`689e2ccffa6be598dc74f2d3da12ebd531c8c075`](https://github.com/kirodotdev/KiroCrew/commit/689e2ccffa6be598dc74f2d3da12ebd531c8c075)，commit 时间 2026-11-03 05:08 UTC。`pyproject.toml` 标记 0.13.0，不能据此宣称已发布 stable 版本；LICENSE 为 Apache-2.0。

[架构说明](https://github.com/kirodotdev/KiroCrew/blob/689e2ccffa6be598dc74f2d3da12ebd531c8c075/docs/architecture/overview.md) 描述：gateway 是长期 asyncio owner，承接 CLI / dashboard / messaging；agent provider 固定 ACP，由 backend 选择 harness，默认 `kiro-cli`；LLM 连接和原生工具主要交给 harness。

本轮只对下表列出的实现做进一步核查，不把架构介绍中的全部子系统当作逐项代码验证。

**和 Taomni 的关键区别**：不能假定直接独立 LLM API 已被 KiroCrew 的 ACP 通道解决。Taomni 的 `llm_call` 必须保留独立服务，不经 CLI 绕行。

### 2.2 读到的具体实现

| 领域 | 证据 | 能证明什么 / 不能证明什么 |
| --- | --- | --- |
| 启动互斥 | [`taskrunner.py:353–400`](https://github.com/kirodotdev/KiroCrew/blob/689e2ccffa6be598dc74f2d3da12ebd531c8c075/src/kiro_crew/taskrunner.py#L353-L400) | 检查可启动状态与旧 task 是否真正结束，先 reserve；无统一 admission 时检查活动任务数 |
| 任务恢复 | [`taskrunner.py:402–450`](https://github.com/kirodotdev/KiroCrew/blob/689e2ccffa6be598dc74f2d3da12ebd531c8c075/src/kiro_crew/taskrunner.py#L402-L450) | 默认保留 PASSED / SKIPPED，fresh 可重置；进入 running 后持久化、检查原 worktree；不证明外部动作 exactly-once |
| 现场降级 | [`taskrunner.py:453–460`](https://github.com/kirodotdev/KiroCrew/blob/689e2ccffa6be598dc74f2d3da12ebd531c8c075/src/kiro_crew/taskrunner.py#L453-L460) | 首次 Git 初始化可 best-effort 失败后继续；Taomni 严格 worktree 模式不能照搬这一降级 |
| 停止与清理 | [`taskrunner.py:480–519`](https://github.com/kirodotdev/KiroCrew/blob/689e2ccffa6be598dc74f2d3da12ebd531c8c075/src/kiro_crew/taskrunner.py#L480-L519) | 清理 session 后再结束 cancelling / pausing，保存进度并 finalization；不能仅看终态就忽略清理仍在运行 |
| 记忆身份 | [`context.py:520–556`](https://github.com/kirodotdev/KiroCrew/blob/689e2ccffa6be598dc74f2d3da12ebd531c8c075/src/kiro_crew/context.py#L520-L556) | session 解析绑定 memory store，身份损坏不静默回退 Global |
| 子会话隐私 | [`context.py:584–613`](https://github.com/kirodotdev/KiroCrew/blob/689e2ccffa6be598dc74f2d3da12ebd531c8c075/src/kiro_crew/context.py#L584-L613) | 子任务继承父 memory 身份并取更严格模式；独立 session 仍可共享同一 memory scope |
| Cron 结算 | [`cron_service/execution.py:174–350`](https://github.com/kirodotdev/KiroCrew/blob/689e2ccffa6be598dc74f2d3da12ebd531c8c075/src/kiro_crew/cron_service/execution.py#L174-L350) | 有 generation 快照及保留运行期间暂停变更；未核实完整 loop、漏触发补偿、重复触发与跨进程锁 |
| 上下文预算 | [`context_assembly/budget.py:133–229`](https://github.com/kirodotdev/KiroCrew/blob/689e2ccffa6be598dc74f2d3da12ebd531c8c075/src/kiro_crew/context_assembly/budget.py#L133-L229) | 明确字符级背景额度不等于完整输入 token 预算；未知窗口退回 1M 参考，不能作为 Taomni 保证请求能装下的算法 |
| 压缩后补入 | [`context_assembly/turn.py:38–109`](https://github.com/kirodotdev/KiroCrew/blob/689e2ccffa6be598dc74f2d3da12ebd531c8c075/src/kiro_crew/context_assembly/turn.py#L38-L109) | 压缩后重注入契约 / 相关索引；minimal / guest 不注入私人学习内容；不证明所有 backend 都准确报告压缩 |

### 2.3 借鉴与不照搬

采用：UI 无关 owner；完成 / 清理分开；明确恢复入口；会话与记忆作用域分离；子任务不放宽隐私；上下文组装独立于协议。

不照搬：ACP-only 作为所有推理入口；Git 隔离失败后无声降级；把巨型组合门面 / 共享 globals 移入 Taomni；从 README 的“恢复、自学习”推断完整行为已验证。

未验证：实际 backend 模型切换、冷启动恢复完整性、全部队列公平性、压缩摘要准确性、session 交接确认 / 重投和每个 harness 的权限强制。已补读 budget / turn 两个上下文 owner，但没有执行模型来验证其实际上下文保真。

## 3. 其他调度控制面

### 3.1 Gas Town + Beads

- [Gas Town](https://github.com/gastownhall/gastown) 快照 `466aa41c83ee73b1fa0eb79eb9d172fb1eca9476`，MIT。
- [Beads](https://github.com/gastownhall/beads) 快照 `eda3326ba198fe86668a1bee19ed36b29363c62d`，MIT。

官方说明：Mayor 协调、worker 有长期身份 / 短期 session、handoff / mailbox、worktree、Beads 依赖任务和项目记忆、Refinery 合并队列。当前 Beads README 明确采用 **Dolt**；不能照抄旧文章中“一个 JSONL 文件就是全部状态”的描述。

[调度设计](https://github.com/gastownhall/gastown/blob/466aa41c83ee73b1fa0eb79eb9d172fb1eca9476/docs/design/scheduler.md)：设置 `scheduler.max_polecats > 0` 才启用延后派发；默认 direct dispatch，不是默认全部排队限流。

实际代码 [`capacity_dispatch.go:154–269`](https://github.com/gastownhall/gastown/blob/466aa41c83ee73b1fa0eb79eb9d172fb1eca9476/internal/cmd/capacity_dispatch.go#L154-L269) 有独占 flock、容量检查、执行与成功关单分离。源码还处理“worker 启动成功但关单失败”的窗口，并明确提示仍可能重复派发，不能据此宣称全系统 exactly-once。

借鉴：持久工作 ledger、session 可替换、结构化 handoff、容量 governor、独立 merge queue。

代价：完整体系包含 Go、Dolt、Beads、tmux 和多个常驻角色；Windows 全量 tmux 工作流依赖 WSL / Linux 环境。**不作为 Taomni 跨平台必需运行时**，未来可用观察模式或显式 opaque 子工作流接入。

### 3.2 Agent Orchestrator

原 `ComposioHQ/agent-orchestrator` 已迁至 [OrchestratorInc/agent-orchestrator](https://github.com/OrchestratorInc/agent-orchestrator)。快照 `630debf6d216150e1cc8c5aff6daf4ba7a1f45c2`，Apache-2.0。

本轮源码是 Go daemon + 桌面控制面；不是旧资料中的轻量 TypeScript 库。关键接口：[backend/internal/ports/agent.go](https://github.com/OrchestratorInc/agent-orchestrator/blob/630debf6d216150e1cc8c5aff6daf4ba7a1f45c2/backend/internal/ports/agent.go)，启动、提示交付、恢复和 native session 信息分离。

官方 CLI / 本地 HTTP 提供 spawn / send / kill / restore；支持多个 CLI，部分 chat 经 ACP。PTY / ConPTY 与 worktree 的平台能力值得借鉴；三平台 E2E 配置存在，但本轮没有执行。

推荐：借鉴 adapter seam、进程 / session 生命周期；不让 AO 和 Taomni 同时拥有同一个 worktree / attempt。若完整委派，作为独立 root 的外部系统，不假装内部资源透明。

### 3.3 Oh My OpenAgent：类别路由与 recall sidecar

[仓库](https://github.com/code-yeongyu/oh-my-openagent)，快照 `7ad7757ad9d2ed498eb8fc4446c2f8c9811c7535`。

[配置说明](https://github.com/code-yeongyu/oh-my-openagent/blob/7ad7757ad9d2ed498eb8fc4446c2f8c9811c7535/docs/reference/omo-json.md) 有 categories / agents 模型链、任务执行模式 / 深度 / 工具限制；模型在 spawn 时选择，不在每条消息换。memory 配置把只读 recall sidecar 和 reflection 分开，并支持 Git worktree 共享项目记忆身份。这些是设计参考，不是本轮逐项运行证明。

**许可证限制重要**：[Sustainable Use License](https://github.com/code-yeongyu/oh-my-openagent/blob/7ad7757ad9d2ed498eb8fc4446c2f8c9811c7535/LICENSE.md) 对使用 / 分发有条件，不能当 MIT / Apache 或不受限制的开源依赖。仅借鉴“任务类型 → 用户 profile”与受限 recall 的概念，不复制实现；产品集成需单独许可检查。

## 4. 按任务类型接入的开源执行器

| 系统 / 快照 | 适合什么 | 实际接入 / 证据 | 限制与建议 |
| --- | --- | --- | --- |
| **OpenHands SDK** `b0789c73151a967fdd4a10f8383d2c0bc7109563`，MIT | 需要隔离环境的复杂、多文件任务 | Agent / Conversation，Agent Server REST + WebSocket；[remote-conversation.ts](https://github.com/OpenHands/software-agent-sdk/blob/b0789c73151a967fdd4a10f8383d2c0bc7109563/clients/typescript/src/conversation/remote-conversation.ts) 有创建 / run / pause / 审批 | 优先选配外部执行器；固定 server / OpenAPI。TS client README 标 alpha，不宜直接耦合到前端；本地 / 容器模式强制能力不同 |
| **Aider** `5dc9490bb35f9729ef2c95d00a19ccd30c26339c`，Apache-2.0 | 明确文件、小迁移、结对编辑 | 单次 `--message` CLI，可禁自动 commit；[allowed_to_edit](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/coders/base_coder.py#L2191) 可请求加入更多文件 | 优先接 CLI，不依赖不稳定 Python 内部 API；文件参数不是安全白名单，需隔离和补丁检查 |
| **mini-swe-agent** `04d809ceab9df28f9adaed044884180159172930`，MIT | 明确复现 / 测试 / 退出条件的有界 bug | CLI 或 [DefaultAgent.run](https://github.com/SWE-agent/mini-swe-agent/blob/04d809ceab9df28f9adaed044884180159172930/src/minisweagent/agents/default.py)，步数 / wall-clock / 轨迹，Docker / Podman 可选 | 第二批 adapter；主要模型 + bash 循环，各 shell 命令独立，不是多 CLI 调度器；取消与验收另封装 |
| **LangGraph** `3c916d750575b22c464790e9774494d810ccd322`，MIT | 有分支、checkpoint、interrupt 的 API 图流程 | [StateGraph](https://github.com/langchain-ai/langgraph/blob/3c916d750575b22c464790e9774494d810ccd322/libs/langgraph/langgraph/graph/state.py)，checkpointer / stream / Command | 可选 service，首版直接 API 步骤不需要它；不提供任意工具副作用 exactly-once |
| **DeepAgents** `5829691de8f43d201f9534fb731643223c0bbccc`，MIT | 研究、规划、工具型长任务 | [create_deep_agent](https://github.com/langchain-ai/deepagents/blob/5829691de8f43d201f9534fb731643223c0bbccc/libs/deepagents/deepagents/graph.py)，基于 LangGraph，有工具 / 子代理与 ACP 入口 | 需额外运行时、backend 和权限配置；`tools=[]` 不等于移除全部内置工具，虚拟根不是沙箱 |
| **OpenCode**，本轮使用官方 server 文档 | 用户自选多 provider coding harness | [Server API](https://opencode.ai/docs/server)：session、async prompt、abort、permission、SSE；也可走 ACP | 已有可用 ACP profile 时不重复实现；Go provider 不等于 agent server；此项未固定源码版本，不作源码兼容承诺 |

这些是**接口与任务适配建议**，不是实测“优秀程度”排行榜。建议先选一个覆盖现有 CLI 不足的 executor 做纵向验证，而不是第一版全装。

## 5. 上下文和记忆系统

### 5.1 OpenViking

[仓库](https://github.com/volcengine/OpenViking)，快照 `17f1536b42f19dd957ed9406bcfff609d59b305b`。

README 提出 `viking://` 虚拟文件系统，resources / memories / skills，共享来源可导航；L0 摘要、L1 概述、L2 全文；按目录作用域检索，session commit 后提炼记忆。

借鉴：上下文分层、摘要先行 / 原文可取、作用域检索和可查看记忆。摘要不能替代必需规范和真实证据。

当前根 [LICENSE](https://github.com/volcengine/OpenViking/blob/17f1536b42f19dd957ed9406bcfff609d59b305b/LICENSE) 是 **AGPLv3**，README 还含额外重写 / 转译声明；一些子目录另有许可证。不能沿用旧文章的 Apache 假设，也不能假定经 HTTP 调用就自动没有许可义务。作为可选外部 MemoryProvider 前需完成实际部署 / 分发的许可证审查。

未运行其 benchmark；README 的对话 / 电商测试收益不能当 Taomni 开发任务效果证明。

### 5.2 Letta、LangMem、Mem0

- [Letta 当前仓库入口](https://github.com/letta-ai/letta/tree/8816d3a8516893bfdc0fa14bfb1235226012e295) 已把当前 harness 指向 `letta-ai/letta-code`；旧 MemGPT / v1 API 资料需要区别版本。
- [Letta shared memory 文档](https://docs.letta.com/guides/agents/multi-agent-shared-memory/) 本次已明确旧 block API 不建议新项目继续使用，推荐 shared memory repositories / MemFS；旧 block 全量 rewrite 会 last-writer-wins，append / targeted update 的并发语义不同。**本稿不再建议把旧 shared block 直接当新系统基础。**
- [LangMem 概念](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/) 区分 semantic / episodic / procedural，hot path / background。namespace 是组织方式，不自动等于授权。
- [Mem0 add 文档](https://docs.mem0.ai/core-concepts/memory-operations/add) 区分 infer / raw、user / agent / run scope，托管模式有异步 PENDING；写入被接收不等于已提炼可用，也不保证自动冲突解决。

v0.4收敛：P1A仅选定approved来源与proposed typed artifact，P2才建正式project memory；保留外部MemoryProvider seam。不在首片上线常驻提炼 / 语义检索，更不先把所有信息送不透明向量库。

## 6. Jev：决策服务而非完整 coding agent

### 6.1 官方核查

[TypeSafe 官方 docs](https://docs.typesafe.ai/)、[API](https://docs.typesafe.ai/api/system-one.md)、[已知限制](https://docs.typesafe.ai/model-jaggedness.md)。端点 `https://api.typesafe.ai/v1/systemone` 已由官方 OpenAPI 核实。

输入 `state + questions + model`；相关输出 choice / score / noul，部分含概率分布和 confidence。官方明确 Jev 不生成代码、不维持对话，不是 CLI 主模型替代。

适合：有限候选任务分类、技能 / 资料候选、是否澄清、错误归因初筛、记忆候选筛选。

不适合：资源计数、预算算术、复杂开放规划、权限最终裁决、用评分替真实测试。confidence 不保证本域已校准。未验证开放模型权重 / license，不列为已证实开源本地模型。

### 6.2 社区 jev-router

[仓库](https://github.com/drmaas/jev-router)，快照 `3c920e949d0b17b0b06c8fab9cd52d36f146ab2a`。README 描述 OpenCode / Cursor hook，技能、工具、澄清、失败、子 agent、review 建议；预览评估很小且建议自动审批默认关闭。

已读 [`jev.ts:39–77`](https://github.com/drmaas/jev-router/blob/3c920e949d0b17b0b06c8fab9cd52d36f146ab2a/plugins/jev-router/jev.ts#L39-L77)：有独立 decision 请求和超时，失败返回 null。不能把这种 fail-open 哲学复制为 Taomni 权限边界；也不继承 README 价格 / 延迟宣称作为已测事实。

本轮请求根 `LICENSE` 未取得，未完成其许可核实；只参考架构和接口，不直接复制源码。普通便宜 LLM / 只读 agent 同样可经 DecisionProvider 接入，不绑定 Jev。

## 7. 调研对原设计的具体修改

| 原稿缺口 | 本轮修订 |
| --- | --- |
| `llm_call` 只有执行类型定义 | 独立 LlmInvocationService、ContextCompiler、请求预览 / manifest、输出契约、无 CLI 运行 |
| 没有任务类型到系统的匹配 | TaskType + profile capability + 用户候选规则，语义判断可插拔 |
| 只说“不要共用 session” | LogicalSession / branch / native session / portable handoff 的明确设计 |
| 记忆未展开 | 分层知识、作用域、候选提炼、CAS 更新、失效 / 冲突 / 删除、read-only recall |
| 只有 LLM planner | rules / Jev / llm_json / agent_advice / human 的 DecisionService，不能越过权限 |
| 外部系统接入边界不明 | executor / delegated-workflow / observe 三模式，禁止双主控 |
| 非明确支持定时任务 | TriggerSpec 设计：manual / schedule / repository event，幂等建 run，时区 / misfire / overlap 可配置 |
| 全部扩展都放后期 | 上下文、独立 API、portable handoff 和基本项目记忆进入首个闭环，不等自动规划成熟后再补 |

## 8. 后续验证与待讨论

- 选择少量真实任务，验证 direct API / 现有 CLI / 一个外部 executor，而不是只测“能启动”。
- 跨 CC / Codex / API 交接时，对比来源完整性、约束保留、重复工作和最终验收。
- 决策器先 shadow，比较 rules / Jev / 用户模型的误路由、abstention、延迟；不擅自发付费评测。
- 项目记忆初期默认“共享已批准知识，自动提炼只提议”；用户可选择更强或更弱自治。
- 定时触发是否需要首版 UI、退出应用仍运行是否硬需求，仍需用户确认；提到 KiroCrew 不等于已经确认其全部产品范围。

所有源码结论仅针对上述快照；外部接口、仓库 owner、license 和默认模式都可能变化。正式实现前必须固定版本、检查许可并运行合同 / 原生行为测试。
