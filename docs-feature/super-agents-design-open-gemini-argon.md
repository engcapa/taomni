# Taomni Super-Agents 下一代自主多智能体开发与交付系统设计文档

- **文档编号**：`SUPER-AGENTS-DESIGN-OPEN-GEMINI-ARGON`
- **适用分支与模块**：`src/components/agents/`、`src/stores/orchestrationStore.ts`、`src-tauri/src/orchestration/`、`src/components/editor/workspace/`
- **生成模型**：`open-gemini-argon` (Gemini 4 Argon)
- **更新日期**：2026-11-06
- **设计目标**：融合 **DeepSeek Super-agent**、**IntelliJ ThinkRail**、**AWS Kiro Crew** 三大前沿范式与 Taomni 当前分支已落地的 **Multi-Agent Orchestration** 底座，打造一套**面向生产级软件独立交付、极简低噪交互、内置轻量 Agentic IDE 审阅、全生命周期 E2E 环境编排与自动化质量门禁、精细化成本治理**的超级开发智能体工作台。

---

## 1. 背景、核心痛点与设计愿景

### 1.1 核心痛点剖析
随着底层编码大模型与 CLI Harness（Claude Code、Codex、Pi、OpenCode、DeepSeek、ZCode 等）单点能力的成熟，AI 辅助软件工程的瓶颈已经发生根本转移：

1. **人类注意力成为最大瓶颈（过程噪音过载）**：
   传统 Agent 界面以“单次聊天会话（Chat Session）”为中心，将大量 `Thinking...`、工具调用标准输出、中间文件读取、碎片化代码 diff 实时刷屏给用户。当并发执行 3～5 个任务时，开发者陷入“翻聊天记录考古”的泥潭，无法聚焦于关键架构决策与最终验收。
2. **从“写代码片段”到“交付可上生产的系统”存在质量鸿沟**：
   多数 Agent 止步于生成候选代码（Candidate Diff），缺乏针对不同工程场景（0-1 无设计探索、0-1 有设计实现、存量大库修 Bug、架构重构）的标准化工程流水线，尤其缺乏**高覆盖、高稳定 E2E 自动化用例生成**以及**本地/云端/BYOM 测试环境的自动创建、布置、启动与就绪检测**能力。
3. **IDE 能力与 Agent 编排割裂**：
   纯聊天窗口缺乏代码上下文导航与 Hunk 级精细审阅能力；而传统重型 IDE 又过于繁杂。开发者需要类似 **IntelliJ ThinkRail** 的“薄宿主 + 真引擎 + Git Worktree 级隔离 + Spec 真相源 + Hunk 审阅优先”的现代轻量 IDE 体验。
4. **多模型/多 Harness 协同的成本失控与状态脆弱**：
   长周期自主运行若全部使用昂贵旗舰模型，Token 成本极高；同时进程崩溃、网络闪断或 Agent 死循环若无外部巡检（Watchdog）与快照恢复机制，会导致资金浪费与工作区污染。

### 1.2 设计愿景（The Taomni Super-Agents Vision）
构建 **Taomni Super-Agents**，实现从“陪聊式结对编程”向**“自主研发工程团队（Autonomous Engineering Crew）”**的跃迁：

- **Attention-First 低噪交互**：默认静默执行（Zero Process Spam），主视图仅输出**阶段进展里程碑、关键待决策项（Decision Gates）、重要风险告警、最终交付收据（Delivery Receipt）**，并提供**一键生成结构化《任务全景简报》**（汇总用户提示词、决策答案、开发进度、质量证据与成本账单）。
- **Production-Ready 全场景任务蓝图**：内置面向 0-1（有/无设计）、既有大库 Bug 修复、存量演进重构、专项 E2E 固化的工程模板，支持持久记忆（Durable Lessons & Markdown Skills）沉淀。
- **E2E 环境自动化与铁血质量门禁**：打通“E2E 环境创建 → Worktree 构建布置 → 服务启动 → 健康探针检测 → 全覆盖稳定 E2E 用例生成与执行 → 跨模型独立代码审阅”全闭环，严禁未验证代码声称通过。
- **Lightweight Agentic IDE 融合**：每个任务独占冻结基线的 Git Worktree；内置轻量现代的 **Spec 图谱 (`SPEC.md`) + Hunk 级 Keep/Revert/Ask Agent 审阅器 + 行内锚定批注 + 集成终端**，支持一键在 Taomni 完整 Code Workspace 或外部 IDE 中打开。
- **继承并强化分支既有底座**：100% 保留并扩展当前分支的 `AgentSettings` 不可变版本快照、LLM Provider / CLI Harness 任务角色分类配置、成本系数（`costCoefficient`）、Packed Planning 少调用优化、Vault 密钥安全引用（`vault:<id>`）及三态网络代理（`app` / `custom` / `none`）。

---

## 2. 业界标杆与当前分支能力融合矩阵

| 维度 | AWS Kiro Crew | IntelliJ ThinkRail | DeepSeek Super-agent | 当前分支已实现底座 (`orchestration`) | **Taomni Super-Agents 融合演进设计** |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **架构范式** | Kiro Bots 职责分工 + 并行 Subagent + Gateway 持久化 | 薄宿主 IDE + 外部 `pi` 引擎 + 多并发会话 | **Router / Worker 双层架构** + 独立 **Watchdog** + 存算环境分离 | Rust `OrchestrationRuntime` + SQLite 持久层 + 进程组监管 | **Router（轻量路由/低噪交互） + Worker Pool（多 Harness 并行） + Watchdog（外部巡检防偏离）** |
| **工作区隔离** | 专属 Bot Workspace | **每任务独立 Git Worktree** + 分支，绝不污染主工作树 | 独立 Ticket 目录与独立会话，完成后提 PR | `worktree::prepare` 基于冻结 `HEAD` commit 创建隔离 worktree | **冻结基线 Git Worktree (`agent/<run-id>`)** + 多 Subagent 子工作树切片 + 安全合并/回滚 |
| **规格与记忆** | **Durable Lessons**（纠错沉淀）+ Markdown Skills + 断点续跑 | **Specs as Ground Truth** (`SPEC.md` 互联图谱随代码版本化) | Inline & Spill 链式召回 + 跨任务上下文路由 | `ContextPreview` 项目上下文编译 + `FrameCollector` 断点候选保留 | **双向追溯 `SPEC.md` 图谱**（需求↔设计↔代码↔E2E）+ **Durable Lessons 自动沉淀库** |
| **交互信噪比** | 全程工具调用/审批/日志可见 | **审查优先于聊天记录**：每轮输出 Turn Receipt (`+27 -4`) | **人类注意力优先**：Session 下沉为实现细节，Web 仅展示需人处理的事项 | 结构化 Plan 卡片 + 审批执行 + 候选产物列表 + 事件流 | **默认静默流（仅展示决策卡/阶段汇报/异常/结果收据）** + **一键结构化全景总结（提示词/决策/进度）** |
| **IDE 与审阅** | 偏 Dashboard 与 IM 协同 | Monaco 拆分编辑器 + **Hunk 级 Keep/Revert/Ask** + 行内锚定评论 | GitHub PR 结构化高密度交付 | `TaskInspector` 上下文只读快照与候选 Diff 预览 | **内嵌现代轻量 Agentic IDE**：Spec 树 + Hunk 级审阅器 + 锚定批注 + 一键唤醒完整 Code Workspace |
| **任务工程流** | `TASK.md` Spec 驱动长任务运行器 + Cron/Webhook | 自由 Chat + 共享 Plan + 逐步 Commit | 环境事件 Trigger（Fast/Slow Path）+ 投机执行（Observe 模式） | `develop` / `plan` / `review` 三类意图 + 计划确认门禁 | **场景化生产任务蓝图（0-1 无设计、0-1 有设计、大库 Bugfix、重构、巡检）** + Trigger 观察模式 |
| **质量与 E2E** | 跑测试、失败重试 | PR CI 状态联动、失败检查交给 Agent | 原型未内置独立代码质量与 E2E 验证 | 严禁未执行测试声称通过 + 独立 `reviewResourceId` 配置 | **E2E 环境生命周期管理（创建/布置/启动/检测）+ 自动生成稳定 E2E 用例 + 闭环自愈 + 跨模型 Review** |
| **资源与成本** | 上下文用量统计 | 每会话实时 Token 与成本显示 | Router 用轻量模型，Worker 用最强模型 | **完善的角色资源配置（API/Worker）、`costCoefficient`、Packed Planning、单次显式补全授权、三态代理** | **全面继承分支配置模型**，扩展 **Router/Watchdog/QA 角色矩阵、实时成本账本与任务预算熔断** |

---

## 3. 系统总体架构设计

### 3.1 四层协同架构（Router - Orchestrator - Worker/Sandbox - Watchdog）

```
+---------------------------------------------------------------------------------------------------+
|                           Taomni Super-Agents Workbench (Frontend UI)                             |
|  [Mission & Decision Stream]   [Lightweight Spec & Hunk Review IDE]   [E2E Sandbox & QA Center]   |
|  [One-Click Executive Summary Modal]        [Shared Resource, Routing & Cost Governance Dialog]   |
+-------------------------------------------------+-------------------------------------------------+
                                                  | Tauri IPC (Typed Commands & Low-Noise Events)
+-------------------------------------------------v-------------------------------------------------+
|                        1. Global Router & Attention Gate (常驻轻量路由层)                          |
|  - 多任务非阻塞接入 & 场景蓝图匹配 (0-1 / Bugfix / Refactor)                                        |
|  - 环境事件 Trigger 过滤 (Fast Path 确定性规则 + Slow Path 轻量模型)                                |
|  - 信噪比过滤器 (Signal Filter): 吞吐底层流，仅向上投递 Decision / Milestone / Alert / Receipt      |
|  - 一键总结聚合器 (Executive Summary Synthesizer): 汇总 Prompts + Decisions + Progress + Quality  |
+------------------------+-------------------------------------------------+------------------------+
                         |                                                 |
+------------------------v------------------------+ +----------------------v------------------------+
|     2. Spec, Memory & DAG Core (编排与记忆核心)  | |  4. External Watchdog & Quality Gate (巡检层) |
|  - SQLite 状态机 (state.sqlite3) & 磁盘检查点    | |  - 独立 Watchdog Session: 监控进度/死循环/偏离  |
|  - SPEC.md 图谱引擎 (Req <-> Design <-> E2E)    | |  - Anti-Cheat 审计: 校验测试真实执行与断言完整  |
|  - Durable Lessons & Skills 沉淀库              | |  - Independent Reviewer: 跨模型代码与安全审查   |
|  - Settings Snapshot 冻结与成本账本 (Cost Ledger)| |  - Release Readiness Gate: 生产准出综合评分     |
+------------------------+------------------------+ +----------------------+------------------------+
                         |                                                 |
+------------------------v-------------------------------------------------v------------------------+
|                3. Isolated Execution & E2E Environment Layer (隔离执行与环境层)                    |
|  +-------------------------------------------+  +----------------------------------------------+  |
|  | Git Worktree Isolation Pool               |  | E2E Environment Lifecycle Manager            |  |
|  | - 冻结 HEAD 基线 (`worktrees/<run-id>`)   |  | - Target: Local Sandbox / Cloud / BYOM SSH   |  |
|  | - Parallel Subagent Worktree Slices       |  | - Stage 1: Create (端口/容器/命名空间分配)    |  |
|  | - Multi-Harness Launcher Supervisor       |  | - Stage 2: Provision (构建/迁移/Fixtures布置) |  |
|  |   (Claude Code/Codex/Pi/OpenCode/DeepSeek)|  | - Stage 3: Start (进程组/服务编排启动)        |  |
|  | - Unix Process Group / Windows Job 监管    |  | - Stage 4: Detect (HTTP/TCP/IPC/DOM 就绪探针)|  |
|  +-------------------------------------------+  +----------------------------------------------+  |
+---------------------------------------------------------------------------------------------------+
```

### 3.2 核心架构机制说明

#### (1) 双层 Router / Worker 架构（汲取 DeepSeek Super-agent + Kiro Crew）
- **Global Router（全局协调器）**：
  - 使用低成本、高响应速度的 API 资源（如配置系数 `0.15x` 的轻量模型）结合确定性状态机运行。
  - **Session 成为底层实现细节**：用户无需管理多个聊天窗口。用户在统一任务流中随时下发新任务、回答待决策问题或审阅已完成的交付物。
  - Router 不挂载高危文件写入或长耗时 Bash 工具，仅负责：意图分类、任务蓝图实例化、向人类发起结构化决策请求（Decision Gate）、汇总子 Worker 里程碑。
- **Isolated Workers & Subagents（隔离执行集群）**：
  - 每个主任务拥有主 Git Worktree（基于提交时的 `sourceRevision` 冻结创建，沿用 `src-tauri/src/orchestration/execution/worktree.rs`）。
  - 当任务蓝图包含并行子任务（例如：前端组件实现、后端 Rust IPC 实现、E2E 测试用例生成）时，主 Worker 可派生隔离的 **Parallel Subagents**（默认上限由 `settings.concurrency` 控制，支持 1～8 并发），各子 Agent 在独立上下文与切片目录中工作，完成后向父任务提交带 SHA-256 校验的 `AgentArtifact`。

#### (2) 外部独立 Watchdog 巡检机制（汲取 DeepSeek Super-agent）
- 在主执行回路之外运行独立的 **Watchdog 巡检器**（每 N 分钟或每完成一个子阶段触发一次）：
  1. **实质进展检测（Stall & Loop Detection）**：检查 Worker 是否在相同编译错误或测试失败上反复打转超过阈值（如连续 3 次无有效 AST/Diff 收敛）。
  2. **目标偏离检测（Goal & Spec Drift）**：比对当前 Worktree 变更集与冻结的 `SPEC.md` 及用户已确认的决策答案，防止 Agent 擅自扩大重构范围或越界修改无关文件（同时强制检查仓库 `800 行` 文件边界规范）。
  3. **测试诚信审计（Test Integrity Guard）**：严禁 Worker 通过删除测试断言、`#[ignore]`、`.skip` 或伪造 mock 返回值来“骗过”E2E 门禁。一旦发现，Watchdog 立即拦截并回滚该 Hunk，触发告警。

---

## 4. 面向生产交付的多任务蓝图与模板体系

为了真正独立交付可上生产的软件系统，系统不能用同一种粗放 Prompt 应对所有任务。我们在现有 `AgentIntent` (`develop` / `plan` / `review`) 之上引入 **生产级任务蓝图（Task Blueprints / Templates）**。

### 4.1 五大核心内置任务蓝图

| 蓝图 ID | 蓝图名称 | 适用工程场景 | 自动化编排流水线（DAG Stages） | 强制质量门禁（Quality Gates） |
| :--- | :--- | :--- | :--- | :--- |
| **`0-1-discovery`** | **0→1 需求驱动开发**<br>*(有需求、无设计)* | 只有业务/产品需求描述，尚无技术方案与接口设计 | `S1 需求澄清决策门` → `S2 自动生成 SPEC.md 图谱与架构设计` → `S3 架构设计人工确认门` → `S4 并行模块脚手架与实现` → `S5 E2E 环境创建与全量用例生成执行` → `S6 跨模型独立审查` | 必须经过 S1/S3 两次轻量人工拍板；自动生成的 E2E 覆盖全部 Spec 验收项且 100% 通过 |
| **`0-1-spec-driven`** | **0→1 规格驱动开发**<br>*(有需求、有设计)* | 已有 `docs-feature/*.md` 或接口设计，需高质量转化为生产代码 | `S1 解析设计文档并冻结契约` → `S2 派生并行 Worker（前端/后端/存储）` → `S3 契约对齐与集成编译` → `S4 E2E 环境布置与自动化回归` → `S5 独立 Review 与交付收据` | 设计文档所有必选章节逐项映射为测试用例；零架构越界；800 行代码边界检查通过 |
| **`legacy-bugfix`** | **既有大库缺陷修复**<br>*(修改存量复杂大库 Bug)* | 在百万行级既有代码库中定位并修复复杂 Bug 或崩溃回归 | `S1 并行 Explore 子智能体（调用链切片与根因定位）` → `S2 先行编写复现失败用例（Red Test First）` → `S3 根因与最小修复方案确认` → `S4 最小外科手术式修复` → `S5 复现用例转绿 + Crash-Regression 套件全跑` | **强制先复现（Red）后修复（Green）**；变更行数最小化；必跑 `crash-regression` 防回归套件 |
| **`safe-refactor`** | **存量系统演进与重构**<br>*(边界拆分/组件升级)* | 大文件拆分（>800 行治理）、性能优化、架构解耦 | `S1 公共 API/IPC/持久化兼容契约提取` → `S2 增量 Worktree 拆分实现` → `S3 `pnpm check:refactor` 边界校验` → `S4 E2E 行为等价性验证` | Public API 与存储格式零破坏；循环依赖为零；全量既有单测与 E2E 通过 |
| **`e2e-hardening`** | **专项 E2E 补齐与质量加固**<br>*(面向生产准出)* | 已有功能缺乏自动化验证，或现有 E2E 存在偶发脆弱（Flaky） | `S1 路由/交互点与覆盖率盲区扫描` → `S2 自动生成稳定 E2E 用例集` → `S3 沙箱环境启动与 3x 连续燃尽测试（Burn-in）` → `S4 脆弱选择器自愈与报告生成` | 所有新增/修复 E2E 用例连续 3 轮执行零失败（0 Flaky）且包含 `assert_no_runtime_errors` |

### 4.2 `SPEC.md` 真相源图谱与 Durable Lessons 持久记忆
1. **Specs as Ground Truth（汲取 ThinkRail）**：
   - 每个项目维护结构化的 `SPEC.md` 节点树（或在 `docs-feature/` 下受管映射），每个节点包含：`ID`、`意图描述`、`接口契约`、`关联源码路径`、`关联 E2E 用例 ID`。
   - Worker 修改代码时必须同步校验或更新对应的 Spec 节点，审阅界面可直接按 Spec 节点查看“需求意图 → 改动代码 Hunk → 对应 E2E 验证结果”的三位一体视图。
2. **Durable Lessons & Skills（汲取 Kiro Crew）**：
   - 当用户在决策卡或 Hunk Review 中纠正了 Agent 的行为（例如：“本仓库禁止使用隐式系统代理回退”、“Vitest 文件过滤禁止加 `--`”），系统自动提示或静默提炼为一条 **Durable Lesson**，存入项目级记忆库并在后续任务上下文编译（`orchestration::context::compile`）时按相关性自动注入。

---

## 5. 静默式低噪交互协议与一键结构化总结

针对需求中强调的：**“希望输出更少，一般只有希望与用户决策，报告重要信息，以及结果才需要输出，其它没有必要的不输出……也可以有按钮，点击后可总结以清晰的形式输出：用户提示词、决策答案、开发进度等”**，设计如下核心交互机制。

### 5.1 四级消息过滤协议（Signal-Only Filtering Protocol）

```
[Worker 内部高频流: Thinking / Read / Grep / Edit / Cargo Build / Stdout]
                                   │
                                   ▼
         ┌───────────────────────────────────────────────────┐
         │    Runtime Signal Filter (静默吞吐与状态折叠器)     │
         └───────┬─────────────────┬─────────────────┬───────┘
                 │ (默认丢弃/归档)   │ (状态聚合)        │ (关键信号直通)
                 ▼                 ▼                 ▼
       [底层遥测归档日志]   [顶部阶段进度条]   [主视图低噪卡片流 (仅4类)]
       (按需点击才展开)     (实时更新百分比)   1. 待用户决策卡 (Decision Gate)
                                              2. 阶段性里程碑汇报 (Milestone Brief)
                                              3. 重要风险/Watchdog告警 (Critical Alert)
                                              4. 最终交付收据 (Delivery Receipt)
```

- **彻底隐藏的过程噪音**：
  - 模型思考过程（`Thinking...` / CoT）、文件树遍历、每次 `read`/`grep` 调用、中间编译输出、未定稿的多次代码涂改、E2E 重试过程中的冗长堆栈，**一律不在主对话流中输出**。
- **保留的轻量阶段感知**：
  - 任务视图顶部固定一条紧凑的 **Stage Pipeline Bar（阶段流水线进度条）**，以呼吸灯与耗时徽章展示当前所处阶段（如：`[✓ 规格对齐 18s] ──> [✓ 并行编码 3/3 Workers 2m10s] ──> [● E2E 环境就绪 & 执行中 19/24] ──> [○ 独立审阅]`）。
- **主对话流仅允许出现的 4 类高价值卡片**：
  1. **`DecisionRequestCard`（待决策卡片）**：当需要人类拍板（如：0-1 架构选型、模糊边界确认、预算超限授权、高风险数据库变更确认）时弹出。提供结构化单选/多选方案（标注推荐项、成本影响、架构影响），用户点击即可继续，无需手敲长段文字。
  2. **`MilestoneBriefCard`（阶段性重要汇报）**：每个大阶段完成时仅生成 **1 条 3 行以内** 的高密度阶段小结（例如：`已完成 3 个隔离 Worktree 的并行编码，生成 6 个候选模块，准备启动本地 E2E 沙箱验证`）。
  3. **`WatchdogAlertCard`（重要风险/纠偏报告）**：仅在 Watchdog 发现异常（如外部依赖不可达、已有测试基线破损）且自动自愈需要知会用户时输出。
  4. **`DeliveryReceiptCard`（最终交付收据卡片）**：任务抵达 `candidate` 状态时输出，包含：改动文件统计（`6 files changed · +318 −42`）、E2E 通过率（`24/24 Passed · 0 Flaky`）、独立 Review 结论、实际消耗成本，以及 `[进入 Hunk 审阅]`、`[一键合并到主工作区]` 按钮。

### 5.2 一键“任务全景简报（Executive Summary）”功能设计

在任务头部工具栏提供醒目的 **`[📋 任务全景总结 (Executive Summary)]`** 按钮。用户随时点击（无论任务执行中还是已交付），系统立即从结构化状态库聚合生成一份清晰、无废话、支持一键复制 Markdown / 导出归档的全景报告面板：

#### 《任务全景简报》标准结构：
1. **一、用户原始提示词与追加指令（User Prompts & Context）**
   - 展示初始目标（Goal）、所选任务蓝图（如 `0-1 有需求无设计`）、附加的上下文文件列表（`sourcePaths`）及中途追加的指导指令。
2. **二、关键决策问答录（User Decisions & Answers）**
   - 以清晰的时间轴表格展示：`决策阶段` | `Agent 提出的核心问题` | `用户选择的决策答案` | `对架构/范围的影响`。
3. **三、开发进度与多 Agent 编排状态（Development Progress & Orchestration）**
   - 阶段完成度百分比、Git Worktree 隔离分支信息、Planning / Workers / QA / Reviewer 各智能体的执行状态与耗时分布。
4. **四、E2E 环境与质量验证结论（E2E Sandbox & Quality Gate）**
   - E2E 环境拓扑状态（如 `Local Sandbox #env-04 · Ready · 4 Services Up`）、自动生成的 E2E 用例清单与通过率、Crash-Regression 结果、独立 Review 评分与风险项。
5. **五、代码变更收据与成本账单（Turn Receipt & Cost Ledger）**
   - 核心改动文件摘要（`+ / -` 行数）、关联 `SPEC.md` 节点、配置快照版本（`settingsSnapshot.revision`）、宿主派发次数与加权成本明细。

---

## 6. 轻量现代 Agentic IDE 工作台设计

参考 **IntelliJ ThinkRail** 与 Taomni 现有的 **Code Workspace** 能力，我们将 Super-Agents 工作台设计为**“薄宿主、高密度、审阅优先”**的现代三模界面，避免传统重型 IDE 的视觉压迫感，同时提供完备的工程掌控力。

### 6.1 顶层导航与三视图无缝切换
在主工作区顶部提供极简 Segmented Switcher，一键切换三种核心工作模式：

1. **`流式主控 (Mission Stream)`**：默认视图。极简低噪交互流 + 阶段进度条 + 底部多模态任务 Composer。
2. **`规格与代码审阅 (Spec & Code IDE)`**：ThinkRail 风格轻量 IDE 审阅台：
   - **左侧树**：切换 `Changed Files (本轮变更 +318 -42)`、`SPEC.md 图谱树`、`Worktree 文件树`。
   - **中央画布**：支持单栏/双栏拆分的轻量代码与 Diff 编辑器（语法高亮复用 `--taomni-code-*` 主题变量）。
   - **Hunk 级审阅操作条**：每个 Diff Hunk 右上角悬浮 `[✓ Keep 保留]`、`[↺ Revert 回退此块]`、`[💬 Ask Agent 留批注返工]`。
   - **行内锚定批注（Anchored Review Comments）**：点击任意代码行号可在行下插入结构化 Review 批注；所有批注汇总为底部“待发送审阅指令包（Review Batch）”，一键派发给 Worker 精准返工，无需在聊天框里复制粘贴代码行！
   - **一键外部联动**：提供 `[在 Taomni Code Workspace 中打开]` 与 `[在外部 IDE 中打开 Worktree]` 按钮。
3. **`E2E 环境与质量中心 (E2E & Quality Lab)`**：
   - 可视化管理 E2E 运行环境的创建、布置、启动、健康检测，以及 E2E 用例生成、执行轨迹、DOM/日志证据和跨模型 Review 矩阵。

---

## 7. 生产级质量保障体系：E2E 自动生成、闭环执行与多维 Review

### 7.1 全覆盖、高稳定 E2E 用例自动生成（E2E Synthesizer）
为了确保交付物真正达到生产可用标准，系统内置专门的 **QA & E2E Architect Agent**：

1. **三源驱动的用例派生**：
   - **从 `SPEC.md` 派生正向验收流**：每个业务验收条件至少映射为 1 条端到端主路径用例。
   - **从代码 AST / 路由 / `data-testid` 派生边界与异常流**：自动扫描新增/修改组件的 `data-testid`、Tauri IPC 命令边界、表单校验、空状态、错误恢复（如网络超时、权限拒绝）。
   - **强制挂载防崩溃套件（`crash-regression`）**：自动纳入工程规范要求的 `crash-regression` 标签用例集，每个用例强制包含实际面板状态断言与 `assert_no_runtime_errors`。
2. **稳定性加固与防脆弱机制（Anti-Flake Engine）**：
   - **确定性选择器约束**：优先绑定稳定的 `data-testid` 与语义角色（`role`），禁止生成脆弱的深层 CSS 路径（如 `div > div:nth-child(4)`）。
   - **显式状态等待**：禁止使用硬编码 `sleep(2000)`，强制生成基于条件探针（DOM 条件就绪、IPC 响应完成、网络空闲）的等待断言。
   - **3x Burn-in 稳定性门禁**：新生成的 E2E 用例在沙箱中自动连续运行 3 次；若出现偶发失败，立即标记为 `flaky` 并交由 QA Agent 修复时序竞态，直至 3/3 稳定全绿。

### 7.2 自动化 E2E 执行与有界自愈循环（Bounded Self-Healing）
```
[生成/更新候选代码 + E2E 用例] ──> [在隔离 E2E 环境中执行测试套件]
                                           │
                      ┌────────────────────┴────────────────────┐
                      ▼ (全部通过 + 3x 稳定)                     ▼ (存在失败用例)
          [进入跨模型独立 Review 门禁]             [采集结构化失败证据包 (Evidence Pack)]
                                                  - 失败步骤截图 & DOM 快照
                                                  - 浏览器 Console / Runtime Error
                                                  - 后端 Rust Stderr / IPC Trace
                                                                │
                                                                ▼
                                                  [Watchdog 审计 & 派发修复 Worker]
                                                  (最多允许 N=3 轮自动自愈，超限转人工决策)
```

### 7.3 多维质量门禁（Multi-Layered Quality Gates）
只有同时通过以下 4 道门禁，任务状态才能从 `running` 晋升为可交付的 `candidate`（Ready for Production Merge）：
- **Gate 1：静态契约与架构边界门禁**：`TypeScript strict`、`cargo check/clippy`、`pnpm check:refactor`（单文件 ≤ 800 行、无循环依赖、无逆向壳层引用）。
- **Gate 2：单元与集成测试门禁**：受影响模块的 Vitest 单测与 Rust `cargo test` 100% 通过。
- **Gate 3：E2E 自动化与防崩溃门禁**：新增特性 E2E 用例 + `crash-regression` 套件在真实启动的环境中 100% 通过，且无运行时异常。
- **Gate 4：跨模型独立 Review 门禁**：由独立于编码 Worker 的 `reviewResource` 执行盲审，输出安全、并发竞态、资源释放、代理合规性审查报告，无 Blocker 级问题。

---

## 8. E2E 运行环境生命周期管理：创建、布置、启动与检测

自动化跑通用户级 E2E 用例的前提，是系统具备**自主管理测试环境（Environment Orchestration）**的能力。我们在 `src-tauri/src/orchestration/` 下扩展 `environment` 子模块，支持**本地、云端、远程 BYOM** 三种形态，并提供标准化的**“创建 → 布置 → 启动 → 检测”**四阶段闭环。

### 8.1 三种环境运行目标（Environment Targets）

| 环境类型 | 标识 | 适用场景 | 底层实现机制 |
| :--- | :--- | :--- | :--- |
| **本地隔离沙箱**<br>*(Local Sandbox)* | `local_sandbox` | 桌面端/前后端一体化快速 E2E 验证 | 基于任务专属 Git Worktree + 动态分配空闲回环端口（如 `:5192`）+ 独立临时数据目录（`--app-data-dir`）+ OS 进程组监管（复用 `unix_group` / `windows_job`） |
| **云端弹性沙箱**<br>*(Cloud Ephemeral)* | `cloud_ephemeral` | 大规模并发 E2E 分片、重型微服务依赖环境 | 通过标准容器/云沙箱 API 拉起临时隔离 Namespace，增量同步 Worktree 产物，支持多 Worker 并行跑 E2E 分片，任务结束后自动销毁计费实例 |
| **远程自带机器**<br>*(BYOM / SSH Host)* | `byom_ssh` | 复用团队测试机、特定 Linux/macOS/Windows 硬件环境 | 融合 DeepSeek Super-agent BYOM 理念与 Taomni 原生 SSH/SFTP 能力，在远程主机部署轻量 Daemon，通过加密隧道同步 Worktree 并驱动远程无头浏览器/原生二进制测试 |

### 8.2 环境生命周期四阶段状态机（Create -> Provision -> Start -> Detect）

```
┌─────────────────────────┐
│ 1. CREATE (环境创建)     │  分配环境 ID、隔离目录/容器、动态端口映射、注入 Vault 测试凭据与代理配置
└────────────┬────────────┘
             ▼
┌─────────────────────────┐
│ 2. PROVISION (环境布置)  │  同步冻结 Git Worktree 与候选补丁、执行依赖准备、构建测试产物、初始化测试 DB/Fixtures
└────────────┬────────────┘
             ▼
┌─────────────────────────┐
│ 3. START (服务启动)      │  按拓扑顺序拉起 Mock 服务、后端守护进程、前端/桌面被测实例、Headless WebDriver
└────────────┬────────────┘
             ▼
┌─────────────────────────┐
│ 4. DETECT (就绪与健康检测)│  执行多维探针：TCP 端口探针 -> HTTP/IPC 握手探针 -> 首屏渲染与 Runtime Error 零报错探针
└────────────┬────────────┘
             ▼
   [ENVIRONMENT READY] ──> 触发自动化 E2E Runner 执行测试套件 (结束后自动 Teardown 或保留现场供调试)
```

#### 四阶段关键技术细节：
1. **阶段 1：创建（Create）**
   - 自动扫描并锁定冲突无关的端口池（如 Frontend Port、Mock API Port、CDP/WebDriver Port）。
   - 生成独立环境清单 `env-manifest.json`，绑定当前 `run.id` 与 `worktreePath`。
2. **阶段 2：布置（Provision）**
   - 对本地 Worktree，通过软硬链接共享只读缓存（如 `node_modules` / Cargo target 缓存层）实现秒级布置，或在沙箱内执行受控构建。
   - 自动注入测试专用 Fixture 数据与 Mock 外部服务配置，确保测试不污染生产数据。
3. **阶段 3：启动（Start）**
   - 所有启动的服务进程全部纳入 Taomni 的 `OrchestrationRuntime` 进程树监管（Linux `procfs` 进程组 / macOS / Windows Job Object），保证随时可停止、应用退出零孤儿进程残留。
4. **阶段 4：检测（Detect & Health Probes）**
   - **L1 网络连通性探针**：TCP 端口监听就绪检测。
   - **L2 协议健康探针**：HTTP `/healthz` 或 Tauri IPC 握手探针响应 `200 OK`。
   - **L3 界面与运行时探针**：无头浏览器加载首屏根节点（如 `[data-testid="platform-workbench"]`）成功挂载，且 `window.onerror` / `unhandledrejection` 计数为 `0`。
   - 若任一探针失败，环境状态标记为 `degraded/failed`，自动截取启动日志并触发自愈或向用户发出简洁告警卡。

---

## 9. 模型/Harness 资源分类路由与成本治理体系

成本是规模化使用多 Agent 的核心考量。本设计完整保留当前分支 `src/lib/ipc/orchestration.ts` 与 `src-tauri/src/orchestration/core/model.rs` 中的配置成果，并将其升级为**面向全角色的成本感知路由矩阵（Cost-Aware Role Routing Matrix）**。

### 9.1 保留并扩展的资源模型（`AgentResource` & `AgentSettings`）
- **完全保留现有字段与安全契约**：
  - `kind`: `"api"`（直连大模型 API）或 `"worker"`（本机/沙箱 CLI Coding Harness）。
  - `protocol`: `"openai_chat"` | `"openai_responses"` | `"anthropic_messages"`。
  - `harness`: `"claude_code"` | `"codex"` | `"pi"` | `"opencode"` | `"deepseek"` | `"zcode"`。
  - `keyRef`: 强制仅接受 `vault:<id>` 引用，杜绝明文密钥落盘。
  - `proxyMode`: `"app"`（默认复用应用代理）、`"custom"`（资源独立代理，不覆盖全局设置）、`"none"`（强制直连，绕过系统与环境变量代理，且代理失败绝不静默回退直连）。
  - `costCoefficient`: 正数成本系数（如 `0.15`、`1.0`、`2.5`），用于直观衡量不同模型/Harness 的单价权重。
  - `preferPackedPlanning`: 规划阶段优先单次打包输出多份产物，追加调用前必须询问用户（保留现有 `RecoveryPrompt` 机制）。

### 9.2 任务角色与成本分级路由矩阵（Role-to-Resource Cost Tiering）

| 编排角色 (Role) | 任务职责特点 | 推荐资源类型与模型档位 | 典型成本系数 (`costCoefficient`) | 成本优化策略 |
| :--- | :--- | :--- | :--- | :--- |
| **1. Router & Watchdog**<br>(`routerResourceId`) | 意图分类、事件过滤、进度巡检、生成全景总结 | 极速轻量 API 模型（如 DeepSeek-V4-Flash / Haiku / GPT-5-Mini） | **`0.10x ~ 0.25x`** | 高频调用但单次 Context 极小，节省 85% 协调开销 |
| **2. Architect & Planner**<br>(`planningResourceId`) | 0-1 架构设计、`SPEC.md` 图谱生成、复杂任务拆解 | 高推理能力 API 模型（如 Claude Opus / Gemini Pro / DeepSeek-R1） | **`1.00x ~ 2.00x`** | 启用 `preferPackedPlanning`，单次请求打包生成设计+契约+测试计划 |
| **3. Coding Workers**<br>(`workerResourceIds[]`) | 隔离 Worktree 代码实现、复杂 Bug 定位与修复 | 专业 Coding Harness（Claude Code / Codex / Pi / OpenCode / ZCode） | **`0.80x ~ 1.50x`** | 按子任务复杂度动态分配：脚手架/简单模块派发低成本 Worker，核心算法派发主力 Worker |
| **4. QA & E2E Worker**<br>(`qaResourceId`) | E2E 用例自动生成、环境布置诊断、Flaky 用例修复 | 高吞吐编码 Worker 或高性价比 API 模型 | **`0.40x ~ 0.80x`** | 基于结构化 DOM/契约快照生成测试，限制自动自愈轮数（最多 3 轮） |
| **5. Independent Reviewer**<br>(`reviewResourceId`) | 跨模型代码审查、安全与边界合规核验 | 异构高可靠审阅模型（与主编码 Worker 不同家族） | **`0.60x ~ 1.20x`** | 仅在编码与 E2E 通过后触发一次全量 Hunk 盲审，避免无效重审 |

### 9.3 刚性预算护栏（Budget Guardrails）
- **预估与实时账本**：提交任务前，`previewAgentContext` 预估输入 Token 与预期成本区间；执行过程中实时累计宿主派发次数（`requestCount`）、Worker 消耗与折算费用。
- **单任务预算暂停门（Budget Pause Gate）**：支持在统一配置中设置单任务成本软上限（如 `$2.00` 或等效成本积分）。一旦达到阈值，系统优雅暂停并弹出低噪 `DecisionRequestCard`（附带已完成进度与剩余工作量），由用户一键决定“授权追加额度继续”或“保留现有候选产物结束”。

---

## 10. 数据模型、IPC 契约与实现演进路线

### 10.1 核心 TypeScript / Rust 扩展类型定义

```typescript
// 扩展任务蓝图类型（向后兼容原有 AgentIntent）
export type TaskBlueprintId =
  | "0-1-discovery"      // 0-1 有需求无设计
  | "0-1-spec-driven"    // 0-1 有需求有设计
  | "legacy-bugfix"      // 既有大库 Bug 修复
  | "safe-refactor"      // 存量演进与重构
  | "e2e-hardening";     // 专项 E2E 质量加固

// 低噪流核心卡片类型（替代杂乱的过程日志）
export type StreamSignalKind =
  | "decision_request"   // 待用户决策
  | "milestone_brief"    // 阶段性关键汇报
  | "watchdog_alert"     // Watchdog 重要风险/纠偏报告
  | "delivery_receipt";  // 最终交付收据

export interface AgentDecisionOption {
  id: string;
  label: string;
  description: string;
  recommended?: boolean;
  costImpact?: string;   // 如 "+0.2x 预计调用"
  scopeImpact?: string;  // 如 "涉及 3 个模块"
}

export interface AgentDecisionItem {
  id: string;
  runId: string;
  stageId: string;
  question: string;
  contextSummary: string;
  options: AgentDecisionOption[];
  selectedOptionId?: string;
  customAnswer?: string;
  decidedAt?: number;
  blocking: boolean;
}

// E2E 环境生命周期模型
export type E2eEnvTarget = "local_sandbox" | "cloud_ephemeral" | "byom_ssh";
export type E2eEnvLifecycleStage = "idle" | "creating" | "provisioning" | "starting" | "detecting" | "ready" | "degraded" | "stopped";

export interface E2eEnvironmentState {
  id: string;
  runId: string;
  target: E2eEnvTarget;
  stage: E2eEnvLifecycleStage;
  endpointUrl: string;
  worktreeBranch: string;
  services: Array<{
    name: string;
    port: number;
    pid?: number;
    status: "starting" | "healthy" | "unhealthy";
    latencyMs?: number;
  }>;
  probes: Array<{
    name: string;
    kind: "tcp" | "http" | "ipc" | "dom_runtime";
    passed: boolean;
    detail: string;
  }>;
}

// E2E 自动化测试与质量门禁报告
export interface QualityGateReport {
  e2eTotal: number;
  e2ePassed: number;
  e2eFailed: number;
  burnInRounds: number;       // 连续稳定执行轮数 (如 3/3)
  crashRegressionPassed: boolean;
  refactorBoundaryPassed: boolean;
  reviewScore: number;        // 0 - 100
  cases: Array<{
    id: string;               // 如 "TC-E2E-001"
    title: string;
    specNodeId: string;
    category: "happy_path" | "boundary" | "crash_regression";
    status: "passed" | "failed" | "running" | "healed";
    durationMs: number;
    assertionsCount: number;
  }>;
}

// 一键生成的结构化《任务全景总结》
export interface TaskExecutiveSummary {
  runId: string;
  title: string;
  blueprintId: TaskBlueprintId;
  generatedAt: number;
  promptSummary: {
    initialGoal: string;
    attachedSources: string[];
    followUpInstructions: string[];
  };
  decisions: Array<{
    stage: string;
    question: string;
    answer: string;
    decidedAt: number;
  }>;
  progress: {
    overallPercent: number;
    currentStage: string;
    worktreeBranch: string;
    subagentsSummary: string;
    milestones: Array<{ title: string; status: string; duration: string }>;
  };
  quality: QualityGateReport;
  costAndReceipt: {
    filesChanged: number;
    insertions: number;
    deletions: number;
    settingsRevision: number;
    hostDispatches: number;
    weightedCostUnits: number;
  };
}
```

### 10.2 分阶段实施路线图（Implementation Roadmap）

1. **Phase 1：低噪交互流、任务蓝图与一键全景总结（Frontend + Store 演进）**
   - 在 `src/components/agents/orchestration/` 中升级 `AgentComposer`（支持任务蓝图选择器）与 `AgentConversation`（实现四类低噪信号卡片渲染与顶部阶段进度条）。
   - 新增 `ExecutiveSummaryDialog.tsx`，实现一键聚合用户提示词、决策问答录、开发进度、质量与成本账单。
   - 保持所有文件在 200～500 行健康边界内，严格通过 `pnpm check:refactor`。
2. **Phase 2：轻量 Agentic IDE 审阅视图与 `SPEC.md` 图谱联动**
   - 扩展 `TaskInspector` 为可切换的全宽/分栏轻量审阅台，支持 `SPEC.md` 节点导航、Hunk 级 `Keep / Revert / Ask Agent` 与行内锚定批注打包派发。
   - 打通一键在 Taomni `CodeWorkspaceTab` 中打开当前任务隔离 Worktree 的路由桥接。
3. **Phase 3：E2E 环境编排器与自动化质量门禁（Rust Backend + QA Runner）**
   - 在 `src-tauri/src/orchestration/` 下新增 `environment/` 模块，落地 `Create -> Provision -> Start -> Detect` 四阶段状态机与健康探针。
   - 集成 QA E2E 生成与执行回路，落地 3x 稳定性燃尽校验与 Watchdog 防作弊断言审计。
4. **Phase 4：多角色成本路由矩阵与 Durable Lessons 记忆库**
   - 在 `SharedAgentSettings` 中扩展 Router / Watchdog / QA 角色资源配置与单任务预算上限护栏。
   - 实现从用户决策与 Hunk 批注中提炼项目级 `Durable Lessons` 并自动注入后续任务上下文。
   - 执行完整單元测试、原生进程生命周期集成测试以及全量 `crash-regression` 套件验收。
