# Taomni Super Agents：面向生产交付的自主开发编排

| 项 | 内容 |
| --- | --- |
| 状态 | 设计提案（Design Proposal） |
| 日期 | 2026-11-06 |
| 基线分支 | `feat/development-orchestrator` |
| 关联实现 | `src-tauri/src/orchestration/*`、`src/components/agents/*`、`src/stores/orchestrationStore.ts`、`qa-ui-auto-tests/*` |
| 原型 | `docs-feature/super-agents-proto-deepseek-v4.1-flash[1m].html` |

---

## 0. 摘要

Taomni 当前分支已经具备一次开发编排的骨架：冻结 Git 快照、独立 worktree、受监督的 worker 启动、候选产物、事件账本、恢复与取消。它解决的是"一次编排能不能安全跑完"。

本文要解决下一层问题：**能不能把一句需求交给系统，让它在无人值守的情况下，交付一个可上生产、有证据、成本可控的结果；同时几乎不占用人的注意力。**

方案代号 **Super Agents**。它把当前的 `AgentRun` 升级为 **Mission（任务）**，在其上引入五个结构性能力：

1. **常驻 Lead（Router）+ 隔离 Worker**：Lead 只做理解、分诊、决策合成和汇报，不碰代码；Worker 各自拥有隔离现场、完整工具和独立上下文，不直接面对用户。
2. **模板即流程**：0→1 有设计 / 0→1 无设计 / 大库修 bug / 既有库增量 / 重构迁移 / 质量加固 / 只读审查 / 无人值守巡检，八条内置 playbook，而不是一套固定仪式。
3. **证据门**：每个阶段的退出由机器检查的退出码、用例、评审结论和证据包决定；模型的"我完成了"不构成通过。
4. **环境即资源**：E2E 用例的生成、稳定性验证与执行都需要真实环境；环境成为可编排、可租用、可探测、可回收的一等对象（本地 worktree / 容器 / SSH 主机 / 云主机 / CI runner）。
5. **安静协议**：过程输出默认折叠，界面上只保留三类内容——需要你决策、阶段性进展、最终结果；任何时刻可一键生成结构化简报。

设计上综合了三套参考系统的长板：Kiro Crew 的持久会话、并行 subagent 与事件触发；ThinkRail 的 worktree 隔离、审核优先与 SPEC 图谱；DeepSeek Super-agent 的 Router/Worker 分层、事件驱动、投机执行与 Watchdog。同时明确拒绝它们的短板与叙事包装（见第 2 章）。

---

## 1. 目标、非目标与约束

### 1.1 可验证的目标

| 编号 | 目标 | 判定方式 |
| --- | --- | --- |
| G1 | 从一句需求到可评审 PR | 模板 `greenfield-*` / `bugfix-large` 在示例仓库端到端跑通，产出 PR 草稿 + 证据包 |
| G2 | 有限无人值守 | `unattended` 自治等级下，连续运行 ≥ 2 小时不需要人工输入（除不可逆操作与验收） |
| G3 | 注意力经济 | 单个 Mission 默认打断 ≤ 3 次；可视线索（可见文本行）较传统 coding agent 下降 ≥ 70% |
| G4 | 质量可证明 | 每条验收标准映射到 ≥ 1 个可执行用例；E2E 3 次连跑无 flake 才发布；评审零未处理 blocker/high |
| G5 | 成本可控 | 预算三层闸门；预估与实际偏差 ≤ 30%，超支必须转为决策而非静默继续 |
| G6 | 现有能力不回归 | 现有 provider/harness/Vault/代理/worktree/恢复语义全部保留，`pnpm test`、`cargo test`、crash-regression 通过 |

### 1.2 非目标（明确不做）

- **不是通用超级智能体**：不承诺开放式联网研究、任意多步任务全覆盖。系统只对"有仓库、有验收标准、可执行验证"的软件交付负责。
- **不做自动合并**：默认永不自动 merge 自己的 PR。合并是人的动作。
- **不重复造 IDE**：不实现 IntelliJ 级语言智能、调试器、完整扩展体系。编辑器按需打开，复用现有 workspace 能力。
- **不做多租户云控制平面**：桌面应用就是本地的控制面与执行入口；云端只作为可选执行环境。
- **不做无界自治**：所有循环有次数、时长、预算上限；超限转为阻塞与决策。
- **不以 worktree 冒充沙箱**：worktree 只隔离文件与 Git 状态；不可信代码必须进入容器或远端隔离环境。

### 1.3 约束

- 跨平台：Windows / Linux / macOS。Windows 的进程树终止依赖 Job Object，Unix 依赖进程组；现有实现已区分，必须沿用。
- 凭据只允许 Vault 引用；代理必须支持"应用代理 / 任务专属代理 / 不使用代理"三模式，且直连不得暗中走系统代理。
- 原型与文档不得依赖外部资源；原型必须与工程当前主题令牌一致。
- 单实例桌面应用；应用退出必须有序停止或标记中断，不留悬挂 worker。

---

## 2. 参考系统解剖：取什么、不取什么

### 2.1 逐项取舍

| 能力 | 来源 | 决定 | 理由 |
| --- | --- | --- | --- |
| 持久会话、记忆、检查点 | Kiro Crew | **采纳** | 桌面重启与崩溃恢复是长期自主的前提；现有 `store` 已有账本基础 |
| 并行 subagent，上下文隔离 | Kiro Crew / ThinkRail | **采纳，上移到阶段级** | 不在聊天线程里嵌套不可见的 subagent；以 Stage fan-out 表达并行，可审计、可限流 |
| 无人值守长任务（10h+） | Kiro Crew | **采纳，但强制预算与 Watchdog** | 长跑必须有外部监督与硬预算，否则是资源泄漏 |
| 定时 / webhook 触发 | Kiro Crew / DeepSeek | **采纳，默认 observe** | 事件驱动是"主动"的来源；默认只观察不执行，避免噪声与越权 |
| 多入口（IM、Slack、CLI） | Kiro Crew | **延后** | 首版桌面优先；通知走系统通知与摘要，不引入多信道适配复杂度 |
| 工具审批、OS 沙箱、审计 | Kiro Crew | **采纳审计与审批；沙箱作为可选环境** | 明确"worktree 不是沙箱"，不可信代码进入容器 |
| 每任务一个 worktree | ThinkRail | **已有，保留** | 已成为当前分支基础；补齐"每个 attempt 一个现场" |
| SPEC.md 图谱 | ThinkRail | **采纳为 Module Specs** | 解决跨会话失忆；规格与代码同版本化 |
| 审核回执（3 files · +27 −4）与 hunk 级操作 | ThinkRail | **采纳** | 以"本轮实际改了什么"取代聊天考古；天然契合安静协议 |
| 多会话并行、每会话选模型与成本 | ThinkRail | **采纳，收敛为资源路由** | 不让用户逐个会话配模型；由任务类别路由，允许 pin |
| Router / Worker 双层 | DeepSeek SA | **核心采纳** | 注意力瓶颈的解耦点；Router 轻、Worker 强 |
| 事件两级过滤（规则快路径 + LLM 慢路径） | DeepSeek SA | **采纳** | 确定性规则挡住 80% 噪声，LLM 只处理灰区 |
| 投机执行（后台先试，有价值才交付） | DeepSeek SA | **采纳为 observe 模式** | 复现、定位这类只读工作可后台预热，无价值则静默丢弃 |
| 异步 ReAct、全双工多信道 | DeepSeek SA | **部分采纳** | 采纳异步执行与打断；拒绝多信道的人格一致性承诺（首版做不到） |
| 存算分离、端侧 daemon | DeepSeek SA | **部分采纳** | 状态落账本、执行可远端；但不引入 daemon（桌面即执行端） |
| 外部 Watchdog | DeepSeek SA | **采纳** | 便宜模型定期判断"有没有实质进展"，是长跑的必要保险 |
| 合成负载实验数据 | DeepSeek SA | **不引用为承诺** | 官方自述仅初步参考；本项目以自身证据为准 |

### 2.2 明确不继承的部分

- **不继承"超级智能体"叙事**：对外只描述为"面向交付的开发编排"。能力边界写在 UI 的模板说明里，而不是营销文案。
- **不继承单仓库假设**：Mission 以"主仓库"为交付单位，但允许只读依赖仓库挂载；多仓库写入首版不支持，避免不可控的联动变更。
- **不继承"聊天即产品"**：聊天记录不是事实来源，账本与证据才是。会话只是渲染层。
- **不继承"多 agent 仪式"**：三个角色不必须对应三个进程；能确定性完成的工作（构建、格式、收集 diff、跑测试）不调用模型。

### 2.3 与三套系统最关键的差异

| 维度 | 三套参考的现状 | Super Agents 的选择 |
| --- | --- | --- |
| 质量保证 | Kiro Crew 以任务完成为主；DeepSeek 原型不测代码质量；ThinkRail 以 review 为主 | 把 E2E 生成、稳定性、执行、评审、证据门做成主链路，而非附加项 |
| 交付物 | 多为"完成任务 / 提交 PR" | 生产就绪清单 + 证据包 + 可回滚的交付说明 |
| 注意力 | 参考系统仍以消息流为主 | 安静协议 + 决策预算 + 一键简报 |
| 环境 | Kiro 用 OS 沙箱，ThinkRail 用 worktree，DeepSeek 用原地执行 | 环境是一等资源，五种形态统一生命周期与健康探测 |
| 成本 | 提供模型配置或 token 显示 | 任务类别路由 + 三层预算 + 系数排序 + 超支转决策 |

---

## 3. 产品模型

### 3.1 对象

| 对象 | 定义 | 关键字段 |
| --- | --- | --- |
| **Mission** | 一次以交付为目标的委托，是用户心智中的工作单位 | 目标、模板、契约、自治等级、预算、状态、主仓库、基线 SHA |
| **Stage** | 模板中的命名阶段，是调度的最小图节点 | 进入/退出条件、资源类别、产物、重试策略、并行宽度 |
| **Attempt** | Stage 的一次具体执行 | 输入快照、资源快照、worktree、环境租约、退出码、成本、日志指针 |
| **Artifact** | 类型化产物 | `spec` / `plan` / `patch` / `testcase` / `evidence` / `review` / `briefing` |
| **Decision** | 需要人回答的问题 | 上下文、选项、推荐项、后果、截止、回答者 |
| **Evidence** | 证据包 | 命令、退出码、用例结果、产物哈希、截图/轨迹 |
| **EnvLease** | 环境租约 | EnvSpec、状态、健康探测、租期、归属 Mission |
| **Lesson** | 沉淀的经验规则 | 作用域、触发条件、动作、来源、可删除 |
| **Skill** | 可复用 Markdown 流程 | 版本、适用条件、步骤、校验 |

### 3.2 状态机

Mission：

```
intake → planning → running → verifying → reviewing → delivering → done
                    ↘ awaiting_decision ↗        ↘ blocked ↗
        ↘ cancelled（任意阶段）        ↘ failed（不可恢复）
```

Attempt：`queued → preparing → running → verifying → succeeded | failed | cancelled | interrupted`。

不变量：

- `done` 必须有全部 gate 的证据；`failed` 必须保留最后现场（worktree、环境日志、证据）。
- `awaiting_decision` 不是失败，不消耗重试次数。
- 任何状态都可由账本重放得出；UI 状态不允许成为唯一事实。

### 3.3 角色是能力束，不是进程

| 角色 | 工具 | 模型档位 | 面对用户 | 改代码 | 职责 |
| --- | --- | --- | --- | --- | --- |
| **Lead / Router** | 读账本、读规格、读证据、发决策、写简报 | 轻量、低成本 | 是 | 否 | 分诊、模板选择、阶段编排、决策合成、汇报 |
| **Planner** | 只读仓库、搜索、读 specs | 强长上下文 | 否 | 否 | 规格、计划、契约、验收标准 |
| **Builder** | 完整编码工具 + 终端 | 最强编码 | 否 | 是 | 在隔离现场实现与自测 |
| **Verifier** | 终端、E2E 运行器、环境 | 中强 | 否 | 仅测试代码 | 生成/稳定/执行用例，产出证据 |
| **Reviewer** | 只读 diff、运行检查 | 中强，**与 Builder 不同模型族** | 否 | 否（可留评论） | 多维评审、验证发现 |
| **Steward** | 账本、记忆、触发 | 轻量 | 否 | 否 | 观察事件、沉淀 lesson、维护 specs |
| **Watchdog** | 只读账本与心跳 | 最便宜 | 否 | 否 | 停滞/打转/偏离检测，介入或升级 |

"不同模型族"是推荐而非硬约束；若用户只有一个供应商，则在 UI 标明"评审独立性下降"，并使用不同提示与不同上下文构造来降低同源偏差。

### 3.4 自治等级

| 等级 | 行为 | 适用 |
| --- | --- | --- |
| `observe` | 只分析、只报告，不产生副作用 | 巡检、issue 分诊、首次接入仓库 |
| `propose` | 产出计划与候选补丁，所有写入需确认 | 高风险仓库、合规环境 |
| `act-with-gates`（默认） | 自动执行只读与可逆操作；不可逆操作（安装依赖、联网、写凭据、推送、合并）需要决策 | 日常开发 |
| `unattended` | 模板预先授权的不可逆操作也可自动执行，但预算与验收仍需人 | 夜间长跑、CI 修复 |

不可逆操作清单：推送远端、创建/修改 PR、合并、删除分支、安装系统依赖、对外发请求、修改 Vault、写入共享环境。任何等级下，**自动合并永远不允许**。

---

## 4. 交互设计

### 4.1 信息架构

```
Rail
├── Mission Control        任务总览：待决策 / 运行中 / 待评审 / 完成
├── Mission                单个任务：阶段、安静线程、检查器
├── Library                模板、Skills、Lessons、Module Specs
├── Fleet                  环境与执行资源
├── Quality                用例覆盖、稳定性、评审发现
└── Settings               路由、预算、自治、触发器、集成
```

主界面不是聊天窗口，而是**任务控制台**。聊天线程只存在于单个 Mission 内部，并且默认只显示决策、里程碑和结果。

### 4.2 安静协议

所有 Agent 输出先归类，再决定是否渲染：

| 事件类别 | 例子 | 默认显示 | 渲染形式 |
| --- | --- | --- | --- |
| `decision` | 需要选择方案、授权不可逆操作、验收 | **是，中断** | 决策卡（选项 + 推荐 + 后果） |
| `blocked` | 环境失败、权限缺失、依赖冲突 | **是，中断** | 问题卡（原因 + 已尝试 + 建议） |
| `result` | 阶段交付、最终交付 | **是** | 结果卡 + 证据入口 |
| `milestone` | 阶段开始/完成、关键发现 | 是，合并节流 | 单行时间线，可展开 |
| `receipt` | 代码变更回执 | 是 | `4 files · +142 −37` + 检查徽章 |
| `trace` | 思考、工具调用、逐行日志 | **否** | 折叠区"过程"，可搜索 |
| `heartbeat` | 仍在运行 | 否 | 状态栏脉冲 + 阶段进度 |

节流规则：

- 同一 Mission 的 milestone 合并到最多每 2 分钟 1 条；阶段边界不受限。
- trace 永不主动滚动；用户点开"过程"才渲染。
- 通知只在 `decision` / `blocked` / `done` 时发出，且合并为摘要。

### 4.3 决策预算

每个 Mission 默认最多 3 次中断。超出后：

1. 继续可逆工作，把非阻塞问题收进"待决策摘要"；
2. 到达必须停下的边界（不可逆操作、验收）才再次打断；
3. 若判断错误，复盘时把该情形写入 Lesson，下一轮自动采用可逆默认值。

每个决策卡必须包含：**为什么现在问、选项、推荐项及理由、每个选项的后果、默认超时行为**。禁止"是否继续？"这类空问题。

### 4.4 简报（Briefing）

任何时候可点"简报"，由账本确定性生成，模型只做措辞组织，不得引入账本外事实：

1. 目标与约束（原始提示词、模板、范围）
2. 关键决策与回答（时间、问题、选择、理由）
3. 进度（阶段、完成/剩余、阻塞）
4. 变更（文件清单、增删行、提交/分支）
5. 证据（构建、单测、E2E、评审、覆盖率）
6. 成本（预算、已用、按阶段）
7. 风险与未决
8. 下一步建议

导出 Markdown；可作为 PR 描述底稿。

### 4.5 IDE 能力：按需，不喧宾夺主

保留但收敛：

- 文件树、Monaco 编辑器、Git 变更视图、终端、worktree 切换、PR 状态。
- 默认不展示编辑器；点击变更回执或文件才打开。
- Diff 支持 hunk 级 `Keep / Revert / Ask agent`，与 ThinkRail 的回执语义一致。
- 编辑器与终端是 Mission 的检查工具，不是主界面。
- 不提供调试器、语言服务器重构等重能力；需要时"在已安装 IDE 中打开 worktree"。

### 4.6 键盘与效率

| 快捷键 | 动作 |
| --- | --- |
| `⌘/Ctrl + K` | 命令面板（新建任务、切任务、打开模板、运行证据） |
| `J / K` | 上下切换 Mission |
| `D` | 跳到下一个待决策 |
| `B` | 生成当前 Mission 简报 |
| `⌘/Ctrl + Enter` | 提交 |
| `Esc` | 关闭检查器/弹窗 |

### 4.7 状态可见但不打扰

- 顶部：Mission 状态、阶段进度、预算条。
- 状态栏：分支、worktree、环境、活动 worker 数、今日成本、隐私/代理状态。
- 阶段轨：每个阶段一个状态点，悬停给出进入/退出条件。
- 心跳：运行中显示低频脉冲，不输出日志。

### 4.8 失败表达

问题卡固定三段：**发生了什么（事实 + 退出码）→ 已尝试什么（次数与结果）→ 你只需做什么（一个动作或一个选择）**。禁止把原始堆栈直接倾泻到主线程。

---

## 5. 模板系统

### 5.1 模板结构

模板是声明式 playbook，可版本化、可校验、可从成功 Mission 反推生成。

```yaml
id: bugfix-large
version: 3
name: 大库缺陷修复
when:
  activity: bugfix
  repo: { minFiles: 2000 }
stages:
  - id: triage
    resource: triage           # 资源类别，不是具体模型
    tools: [read, search]
    exit: [root_cause_hypothesis, affected_area]
  - id: reproduce
    resource: verifier
    tools: [read, search, write-tests, terminal]
    exit: [failing_test_added, failure_confirmed_3_of_3]
  - id: localize
    fanout: { min: 2, max: 4, split: hypothesis }
    resource: builder
    exit: [candidate_root_causes]
  - id: fix
    resource: builder
    exit: [patch_proposed, local_checks_green]
  - id: regression
    resource: verifier
    exit: [target_case_green, related_suite_green, stability_3_runs]
  - id: review
    resource: reviewer
    exit: [no_blocker, findings_triaged]
  - id: deliver
    resource: lead
    exit: [pr_draft, evidence_bundle, rollback_note]
gates: [G1, G2, G3, G4, G5, G6]
budget: { mission: 12.0, stage: { fix: 4.0, regression: 3.0 } }
autonomy: act-with-gates
```

### 5.2 内置模板

| 模板 | 适用 | 阶段骨架 | 默认自治 | 预算档 |
| --- | --- | --- | --- | --- |
| `greenfield-designed` | 0→1，有需求与设计 | 规格增量 → 计划 → 脚手架 → 并行实现 → 集成 → 验证 → E2E → 评审 → 交付 | act-with-gates | 中 |
| `greenfield-discovery` | 0→1，只有想法 | 发现（并行假设）→ 规格草案 → **规格确认** → 计划 → 实现 → 验证 → 评审 → 交付 | propose → act-with-gates | 中高 |
| `bugfix-large` | 大库缺陷修复 | 分诊 → 复现 → 定位（并行）→ 修复 → 回归 → 评审 → 交付 | act-with-gates | 低中 |
| `feature-existing` | 既有库功能增量 | 影响面 → 契约 → 实现 → 测试 → 评审 → 交付 | act-with-gates | 中 |
| `refactor-migration` | 重构 / 迁移 | 盘点 → **策略决策** → 分批变更 → 每批验证 → 集成 → 评审 | propose | 高 |
| `quality-hardening` | 补 E2E / 稳定性 | 覆盖审计 → 缺口 → 用例生成 → 3 次稳定 → 隔离 flake → 报告 | act-with-gates | 中 |
| `review-audit` | 只读审查 | 多维并行 → 发现验证 → 分级 → 报告 | observe | 低 |
| `steward-watch` | CI/issue 巡检 | 事件过滤 → 复现尝试 → 有价值才建 Mission | observe 默认 | 极低 |

模板差异化的关键不在流程名字，而在：**入口条件、退出证据、默认并行宽度、预算上限、哪些动作需要人工授权**。

### 5.3 0→1 无设计的处理

这类任务最容易失控。约束：

1. 发现阶段只读，最多 4 个并行假设，产出"事实 / 未知 / 风险"三张清单。
2. 规格草案必须包含：用户故事、非功能约束、数据模型、接口、失败语义、验收标准（可执行）。
3. **规格确认是一次显式决策**，选项是"按草案实现 / 缩减范围 / 补充信息"。
4. 计划必须映射到验收标准；实现阶段不允许新增未在规格中的公共接口。
5. 如果规格无法闭合，Mission 转 `blocked`，而不是"边写边想"。

### 5.4 模板选择

优先级：用户显式 pin > 仓库策略文件（`.taomni/mission.yaml`）> 规则分诊 > 语义分类 > 默认 `feature-existing`。

分类只决定**候选与默认**，不得覆盖显式选择。低置信时选择更保守的自治等级，而不是更激进的模板。

### 5.5 自定义模板

- 从已完成 Mission 提取：账本 + 决策 + gate 结果 → 候选模板 → 人工确认。
- 强制字段校验：每个 stage 必须有 `exit`，每个 gate 必须绑定可执行检查。
- 版本化；旧 Mission 固定引用旧版本，不随模板漂移。

---

## 6. 质量体系

这是与参考系统差距最大的部分，也是"可上生产"的核心。

### 6.1 验收标准的形状

每条标准必须可执行或可判定：

```
AC-3: 当订单支付超时后再次查询，接口返回原订单且不产生第二条支付记录。
Given 一笔处于 pending 的订单
When 支付回调超时后 30 秒内再次查询
Then 返回同一 order_id，且 payments 表只有一条记录
```

不可执行的标准（"体验流畅""代码优雅"）必须被拆解或移出 gate，不能作为通过条件。

### 6.2 E2E 用例生成

来源：验收标准（主）、变更 diff（回归）、历史缺陷（防回归）、规格中的失败语义。

场景矩阵（每条验收标准至少覆盖）：

| 维度 | 必测 |
| --- | --- |
| 正常路径 | 主流程一次成功 |
| 边界 | 空值、上限、并发、重复提交 |
| 错误 | 依赖失败、超时、非法输入 |
| 权限 | 未授权、越权、只读 |
| 持久化 | 刷新/重启后状态一致 |
| 兼容 | 目标平台差异（Windows 路径、Ctrl/Meta） |
| 运行时 | `assert_no_runtime_errors` |

确定性规则：

- 选择器只用 `data-testid` 或语义角色，禁止 CSS 结构选择器。
- 禁止固定 `sleep`；等待显式状态。
- 数据隔离：每个用例自建 fixture，使用随机主键；结束后清理。
- 时间、随机数、网络、外部服务全部可注入或固定。
- 用例文件遵循 `TC-XXX-<slug>.testcase.yaml`，带 feature 归属与标签。

反模式（生成后自动拒绝）：断言只检查"元素存在"而不检查行为结果；用 `try/catch` 吞掉失败；依赖执行顺序；依赖上一用例残留数据。

### 6.3 稳定性

- **3 次连续干净运行**才视为稳定；任一次失败即不通过。
- 重试语义：允许一次基础设施重试，但结果标记为 `retried`；重试成功不等于首次通过，必须记录。
- Flake 进入隔离区（quarantine），保留 owner、首次时间、复现率、到期日；隔离不等于删除，也不等于通过。
- 证据保留：报告、截图、trace、视频、日志、退出码；按 Mission 归档并哈希。

### 6.4 执行

| 模式 | 载体 | 并行策略 |
| --- | --- | --- |
| Browser | Vite + Playwright（复用 `qa-ui-auto-tests`） | 按 worker 数并行，默认 ≤ 4 |
| Native | 打包后的桌面二进制 + 驱动 | **串行**，独占批准的桌面 |
| API / 集成 | 命令执行器 + 本地服务 fixture | 按资源配额并行 |

平台矩阵：Linux 必测；Windows 必测涉及路径/编码/原生 UI 的用例；macOS 按发布策略。每次产品 PR 必须运行 `crash-regression` 全量。

### 6.5 评审

维度：正确性、安全、性能、兼容/契约、测试覆盖、可维护性、可访问性（UI）。

规则：

- Reviewer 与 Builder 不同 attempt、不同上下文，优先不同模型族。
- 发现必须经过一次**对抗验证**（独立上下文判断能否复现/是否误报）才进入阻塞列表。
- 严重度：`blocker > high > medium > low > nit`。仅 blocker/high 阻塞交付。
- 以 diff 为锚：每条发现绑定文件与行号，支持 hunk 级采纳/回退。
- 评审产出"回执"，不产出聊天长文：`3 files · +27 −4 · 2 findings · 0 blocker`。

### 6.6 证据门

| Gate | 检查 | 通过条件 |
| --- | --- | --- |
| G1 计划 | 计划覆盖全部验收标准 | 映射完整，无悬空标准 |
| G2 构建 | 类型检查、lint、单测、构建 | 真实退出码全 0 |
| G3 用例完备 | 每条 AC 有 ≥1 用例；负向/边界清单已勾 | 自动映射 + 人工抽检 |
| G4 稳定性 | 目标用例 3 次连跑、相关套件通过 | 0 失败；flake 已隔离并说明 |
| G5 评审 | blocker/high 发现 | 0 未处理；所有发现已分级 |
| G6 生产就绪 | 迁移可回滚、配置/密钥、可观测性、文档、发布说明 | 清单全部满足 |

**任何 gate 都不能由模型文本推断通过。** 证据缺失即视为未通过。

### 6.7 质量度量

- 逃逸缺陷率（交付后 14 天内）
- E2E flake 率与平均恢复时间
- 验收标准覆盖率（有可执行用例的比例）
- 评审发现的确认率（确认为真 / 总数）
- 平均 gate 返工次数

---

## 7. 环境服务

### 7.1 为什么需要独立的环境对象

"跑 E2E"从来不只是执行一条命令：需要依赖、服务、种子数据、端口、健康检查、清理，以及失败后的可诊断性。把它塞进 worker 的终端里，会导致不可复现、不可并行、不可回收。

### 7.2 EnvSpec 与 EnvRecipe

```yaml
id: env-checkout-e2e
kind: container            # local-worktree | container | ssh-host | cloud-vm | ci-runner
base: mcr.microsoft.com/playwright:v1.49.0-jammy
bootstrap:
  - pnpm install --frozen-lockfile
  - pnpm exec playwright install --with-deps
services:
  - name: db
    image: mysql:8.4
    health: { type: sql, query: "SELECT 1", timeout: 30s }
  - name: mail
    image: mailhog/mailhog
    health: { type: http, path: /api/v2/messages }
ports: [3000, 5433]
seed: fixtures/checkout-seed.sql
ttl: 90m
network: { proxy: app, egress: allowlist }
```

### 7.3 五种形态

| 形态 | 用途 | 隔离强度 | 成本 |
| --- | --- | --- | --- |
| `local-worktree` | 编码、单测、快速验证 | 文件级 | 极低 |
| `container` | 不可信代码、E2E、服务依赖 | 进程/文件/网络 | 中 |
| `ssh-host` | 真实目标环境、原生依赖 | 主机级（需隔离用户） | 中 |
| `cloud-vm` | 长时间、跨平台、团队共享 | 主机级 | 高 |
| `ci-runner` | 提交后验证、矩阵执行 | 虚拟机级 | 按次 |

### 7.4 生命周期

```
draft → provisioning → bootstrapping → ready → in-use → verifying → released
                          ↘ failed（保留日志与部分镜像）
```

- 所有步骤幂等；重复 provision 返回同一 lease。
- 租约（lease）带 owner 与 TTL；到期前 10 分钟提醒，超时回收。
- 回收顺序：停止服务 → 收集日志/证据 → 释放端口 → 删除或快照。
- 中断不删除部分数据：镜像层与日志保留，供重试复用。

### 7.5 健康探测分层

1. **进程存活**：PID/容器状态。
2. **端口可达**：TCP connect。
3. **语义就绪**：HTTP 200 + 业务字段、`SELECT 1`（端口打开不代表数据库可用，仓库已有此教训）。
4. **版本/内容匹配**：镜像标签、迁移版本、种子数据校验。
5. **E2E 冒烟**：一条 10 秒内的最小用例。

任一层失败都给出具体层与原始输出，禁止"环境未就绪"这种笼统错误。

### 7.6 网络、代理与凭据

- 三种代理模式（应用 / 专属 / 无）沿用现有 Settings，环境创建时快照。
- 容器内代理通过环境变量注入；`none` 必须清空隐式代理。
- 凭据只注入 Vault 引用解析后的短期值，不写入镜像、不写入日志；证据包统一脱敏。
- 环境默认只绑 loopback 或内部网络；共享环境必须有访问控制。

### 7.7 与现有 QA 能力的接线

- 复用 `qa-ui-auto-tests` 的用例格式、选择器规范、fixture 服务（sshd/mysql）、报告目录与 crash-regression 套件。
- 新增的能力是：环境生命周期由 Mission 驱动、证据自动归档到 Mission、flake 结论回写 Gate。
- 不新造第二套 E2E 框架。

### 7.8 失败与恢复

- 基础设施失败与用例失败必须区分；前者可重试，后者进入修复回路。
- 不允许"环境失败 → 直接连本地"的静默降级；必须显式决策。
- 恢复时从最后成功步骤继续，不重新拉取已完成镜像。

---

## 8. 路由、成本与预算

### 8.1 任务分类维度

`activity`（实现/修复/审查/测试/规划/迁移）× `scope`（单文件/模块/跨模块/跨仓库）× `risk`（可逆/不可逆）× `modality`（代码/文档/UI）× `parallelism`（可并行/必须串行）× `context`（小/大/超大）。

### 8.2 资源矩阵

| 任务类别 | 默认资源类别 | 模型档位 | 典型 harness | 备注 |
| --- | --- | --- | --- | --- |
| 分诊、摘要、里程碑 | triage | 最便宜 | 直接 API | 低温度、短输出 |
| 规格、计划、契约 | planning | 强长上下文 | 直接 API / 只读 agent | 工具最小化 |
| 跨文件实现 | builder | 最强编码 | claude_code / codex / opencode | 隔离 worktree |
| 用例生成 | verifier | 强 | 编码 harness + 浏览器工具 | 必须能运行 |
| 用例执行 | verifier | 便宜/无模型 | 确定性 runner | 不调用模型 |
| 评审 | reviewer | 中强 | 只读 harness | 与 builder 不同族 |
| 修复回路 | builder | 强 | 同 builder | 有界次数 |
| Watchdog | watchdog | 最便宜 | 直接 API | 只看账本摘要 |

### 8.3 成本系数与真实计量

- 现有 `costCoefficient` 保留：用于**排序与预估**，不替代真实账单。
- 每个 attempt 记录：输入/输出 token、缓存命中、调用数、时长、真实计费（若供应商返回）。
- 系数来源可配置（订阅折算、批处理折扣、免费额度）；UI 明示"预估值"。
- 榜单不以价格排序覆盖能力约束；先过滤能力与授权，再在候选中按"预估成本/成功概率"排序。

### 8.4 三层预算

| 层 | 作用 | 超限行为 |
| --- | --- | --- |
| Mission | 总上限 | 停止派发，转决策（追加 / 缩减范围 / 中止） |
| Stage | 单阶段上限 | 停止该阶段，保留现场，转决策 |
| Attempt | 单次上限 | 中止该 attempt，计为失败，不自动重试 |

预估在 Mission 创建时给出区间；每阶段结束更新预测。**预估超出剩余预算的 20% 时必须提前决策**，而不是跑到一半再停。

### 8.5 降级与 abstain

- 不允许为了省成本自动把 builder 换成弱模型；要换必须显式配置候选并在 UI 标注。
- 分类置信度低时，选择更保守的自治等级与更小的并行宽度，而不是更便宜的模型。
- 供应商失败时：先重试（有界），再转决策；禁止静默回退到全局 Chat 默认模型。
- 评审资源缺失时，Gate G5 标记为"未独立评审"，不能标记通过。

### 8.6 与现有配置的关系

- 只读取 `AiConfig` 的连接元数据与 Vault 引用，不修改应用 AI 设置。
- 任务专属代理不覆盖应用代理。
- 资源仍以 `AgentResource` 为最小单位，新增 `role` 与 `tags` 便于路由；保留 `harness` 白名单。

---

## 9. 编排运行时

### 9.1 分层

| 层 | 职责 | 现状 |
| --- | --- | --- |
| 控制面 | Lead、模板解析、决策、预算、简报 | `core/service.rs` 扩展 |
| 调度 | Stage DAG、槽位、租约、公平、背压 | 新增 `scheduler/` |
| 执行面 | attempt 生命周期、worktree、进程、取消 | `execution/*` 复用 |
| 证据面 | 命令执行、E2E、评审、证据归档 | 新增 `evidence/` + `qa-ui-auto` |
| 状态 | 账本、快照、迁移 | `core/store.rs` 演进 |

### 9.2 Lead 的职责边界

做：理解目标、选择模板、编排阶段、合成决策、写简报、处理触发、守护预算。
不做：改代码、执行命令、直接调用 Bash、替用户回答自己的决策。

Lead 的上下文只包含：Mission 契约、阶段状态、未决问题、证据摘要。它看不到 worker 的全部日志，避免上下文膨胀与"代替执行"。

### 9.3 调度

- 以 Stage DAG 为单位；节点满足依赖、资源、权限、预算才可派发。
- 槽位：全局 attempt 数、每仓库写 worktree 数、重型构建数、测试环境数、native 桌面数。
- 公平：Mission 间轮转；关键路径优先；避免饥饿。
- 背压：当证据面或环境面饱和时，暂停派发而不是无界排队。
- 写操作在同一仓库默认 ≤ 2 个并发 worktree；只读调查可到 8。

### 9.4 并行宽度

- 只读调查：按假设拆，2–4 路。
- 独立模块：按契约边界拆，2–3 路。
- 同一 schema / 迁移 / 锁文件：串行。
- E2E：browser 可并行；native 串行。
- 不为凑并发而拆任务；宽度是上限，不是目标。

### 9.5 事件触发

```yaml
trigger:
  source: github            # github | ci | schedule | watch | manual
  filter:
    fast: [label:bug, author_in:maintainers]
    slow: triage             # LLM 仅处理灰区
  mode: observe              # observe | propose | act
  dedupe: event_id
  budget: 0.50
```

- 两级过滤：确定性规则先行，LLM 只判断灰区；两者都不通过则不建 Mission。
- 去重：来源事件 ID + 仓库 + 规则版本。
- 默认 `observe`：只复现、只记录，不产生外部副作用。
- 触发产生的 Mission 使用更小预算与更保守模板。
- 计划任务明确时区/DST、错过补偿与重叠策略；宿主关闭期间不承诺执行。

### 9.6 Watchdog

独立于主循环的廉价会话，每 2–5 分钟读取：

- 心跳与最后事件时间
- 同一文件/同一命令的重复次数
- 预算燃烧速率
- 计划与当前工作的一致性
- 证据是否在推进

判定与动作：`nudge`（注入提示）→ `pause`（暂停并请求决策）→ `terminate`（终止 attempt，保留现场）。所有介入写入账本，可审计。

### 9.7 取消、恢复与检查点

- 取消必须终止进程树（Unix 进程组 / Windows Job Object），不残留子进程。
- Mission 每阶段结束写检查点（状态、产物哈希、worktree、环境租约）。
- 崩溃后恢复：重放账本 → 标记中断 attempt → 从不含未完成外部效果的边界继续。
- 外部效果（推送、发请求、安装）先记账后执行；边界不明时不得自动重派。
- worktree 与环境永不自动清理，除非用户显式释放。

### 9.8 投机执行

适用于只读或可丢弃的工作：复现、定位、影响面分析、CI 失败初筛。产出有价值时升级为 Mission；无价值时丢弃，只保留摘要。投机预算独立，不能挤占用户任务预算。

---

## 10. 记忆

### 10.1 从账本到 Lesson

```
用户纠正 / 失败复盘 / 决策被驳回
        ↓ 提取
Lesson { scope, trigger, action, confidence, source }
        ↓ 作用域匹配（仓库 / 模块 / 模板）
注入到相关角色的系统提示或阶段前置检查
```

规则：

- 用户可见、可编辑、可删除；默认不跨仓库共享。
- 冲突时新规则覆盖旧规则，但保留历史。
- 过期：90 天未命中或仓库结构变化后降权。
- 不能把"一次偶然正确"直接升为规则；至少两次命中或用户显式确认。

### 10.2 Skills

重复出现的流程合成为 Markdown Skill（构建/发布/特定框架的测试方式）。启用前必须评审；版本固定；Skill 不能携带凭据与本地绝对路径。

### 10.3 Module Specs

每个模块一份 `SPEC.md`（或仓库既有文档），描述职责、公开接口、失败语义、验收标准。Agent 通过只读工具检索，通过受控工具更新。UI 提供只读 Specs 树，变更进入 diff 评审。

### 10.4 注入策略

- 只注入与当前 Stage 相关的 Lesson 与 Spec 片段，避免上下文污染。
- 注入内容带来源与置信度；低置信只作为提示，不作为约束。
- 注入预算独立计量；超预算时优先保留验收标准与安全约束。

---

## 11. 数据模型与 IPC

### 11.1 Mission 示例

```json
{
  "id": "m-1042",
  "revision": 7,
  "projectPath": "/repos/checkout",
  "title": "修复支付超时后订单状态不一致",
  "templateId": "bugfix-large",
  "templateVersion": 3,
  "goal": "支付回调超时后再次查询应返回原订单且不产生二次扣款",
  "autonomy": "act_with_gates",
  "status": "awaiting_decision",
  "contract": {
    "acceptance": [{ "id": "AC-1", "text": "..." }],
    "scope": ["src/order/**", "src/payment/**"],
    "outOfScope": ["src/billing/**"]
  },
  "budget": { "mission": 12.0, "spent": 6.1, "stageCap": { "fix": 4.0 } },
  "baseRevision": "3f2c...",
  "stages": [
    { "id": "reproduce", "status": "succeeded", "attempt": "a-2" },
    { "id": "fix", "status": "awaiting_decision", "attempt": "a-3" }
  ],
  "decisions": [{ "id": "d-7", "status": "pending" }],
  "evidenceIds": ["ev-2", "ev-3"],
  "createdAt": 1770000000
}
```

### 11.2 新增命令（保留现有命令）

| 命令 | 作用 |
| --- | --- |
| `orchestration_list_missions` / `orchestration_get_mission` | 任务列表/详情 |
| `orchestration_create_mission` | 创建（模板、目标、契约、预算） |
| `orchestration_start_stage` / `orchestration_cancel_mission` | 阶段推进/取消 |
| `orchestration_answer_decision` | 回答问题（带命令 ID 去重） |
| `orchestration_generate_briefing` | 生成简报 |
| `orchestration_recover_mission` | 崩溃恢复 |
| `orchestration_list_templates` / `orchestration_save_template` | 模板 |
| `environment_list` / `environment_provision` / `environment_health` / `environment_release` | 环境租约 |
| `evidence_list` / `evidence_run_gate` | 证据与 gate |
| `orchestration_get_policy` / `orchestration_save_policy` | 路由、预算、自治、触发 |

兼容：

- 现有 `AgentRun` 字段全部保留；新增 `missionId`、`stageId`、`decisions`、`budget`、`evidence` 为可选。
- 现有 `orchestration_*` 命令保持签名；内部映射到 Mission 的第一个 Stage。
- 存储迁移：`state.json` 版本号递增；无法迁移时保留旧文件并显式提示，不静默丢弃。

### 11.3 账本

- 追加写 `events.ndjson`（序号、时间、Mission、Stage、类别、摘要、引用）。
- 周期快照 `state.json`（原子替换）。
- 证据存 `evidence/<mission>/<attempt>/`，带内容哈希与脱敏标记。
- UI 只读账本；本地状态可丢失并重建。

---

## 12. 安全、隐私与治理

1. **Worktree 不是沙箱**：文案与 UI 明确标注；不可信代码或第三方依赖安装必须使用容器/远端。
2. **不可逆操作需授权**：见 3.4；授权按 Mission 作用域，不跨 Mission 复用。
3. **凭据**：只接受 `vault:` 引用；日志、证据、简报统一脱敏；不允许把密钥写入 prompt。
4. **网络出口**：三代理模式；容器环境额外支持 allowlist；被拒绝的请求显式报错，不静默直连。
5. **触发白名单**：只接受指定作者/标签/分支的事件；未知来源只记录。
6. **审计**：谁在何时授权了什么、Agent 执行了哪些外部效果，全部可从账本还原。
7. **供应链**：Agent 安装依赖必须固定版本并记录哈希；禁止全局安装。
8. **数据最小化**：简报与证据默认不含源码全文，只含摘要与链接。

---

## 13. 可观测性与度量

### 13.1 指标

| 指标 | 定义 | 目标 |
| --- | --- | --- |
| Time to first decision | 创建 → 首个决策 | < 3 min（小任务） |
| Interruptions per mission | 中断次数 | ≤ 3 |
| Visible output ratio | 可见文本 / 总输出 | < 20% |
| Gate first-pass rate | 一次通过门禁的比例 | > 70% |
| E2E flake rate | flake 次数 / 执行次数 | < 1% |
| Cost prediction error | \|预估−实际\| / 实际 | ≤ 30% |
| Recovery success | 崩溃后成功继续 | > 95% |

### 13.2 证据包

每个 Mission 交付时生成：变更摘要、命令与退出码、测试报告、截图/轨迹、评审结论、成本明细、环境信息、脱敏声明、回滚步骤。

### 13.3 日志分级

`error`（需人）→ 主线程问题卡；`warn`（可恢复）→ 折叠；`info`（过程）→ 账本；`debug` → 仅本地文件。日志不进入模型上下文，除非显式引用。

---

## 14. 实施计划

### 14.1 阶段

| 阶段 | 范围 | 退出标准 |
| --- | --- | --- |
| **M0（2–3 周）** | Mission/Stage/Decision 账本；`bugfix-large` 与 `greenfield-designed`；安静渲染；决策卡；简报；预算条 | 两个模板在小/中型仓库端到端产出 PR 草稿与简报；恢复测试通过 |
| **M1（3–4 周）** | 证据门 G1–G4；E2E 生成与 3 次稳定；本地/容器环境生命周期；Quality 视图 | 用例自动生成并稳定运行；环境失败可诊断；gate 不可被文本绕过 |
| **M2（3 周）** | 多维评审 + 发现验证；Module Specs；Lesson/Skill；路由与三层预算 | 评审确认率 > 60%；成本预估误差 ≤ 30% |
| **M3（3–4 周）** | 触发器 + Watchdog；远程环境；`steward-watch`；通知摘要 | 无人值守 ≥ 2h；Watchdog 能识别停滞与打转 |
| **M4（持续）** | 多仓库只读挂载、PR 自动化、团队共享模板与证据 | 团队复用模板；跨项目质量度量 |

### 14.2 验证策略

- Rust：调度、预算、状态机、取消/恢复、环境生命周期使用单元/集成测试；外部效果用假实现，native 行为必须真实验证。
- 前端：Vitest + Testing Library 覆盖安静渲染规则、决策卡、简报生成、预算条、检查器。
- QA：新增 `TC-XXX-super-agents-*` 用例；每次产品 PR 跑完整 crash-regression；用真实打包二进制验证 native 交互。
- 证据：每个 Gate 有对应测试；禁止只验证"能构建"。

### 14.3 风险

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 安静过度导致失去信任 | 用户不知道 Agent 在做什么 | 阶段轨 + 心跳 + 可展开过程 + 简报 |
| 模板僵化 | 真实任务不匹配 | 模板可派生、可局部覆盖；未知任务降级为手工 Mission |
| 评审同源偏差 | 漏掉缺陷 | 独立上下文/模型族；对抗验证；抽检 |
| E2E 生成噪声 | 用例多但无效 | 验收标准映射 + 反模式拒绝 + flake 隔离 |
| 环境成本失控 | 云主机闲置 | TTL、租约、GC、预算告警 |
| 长跑偏离目标 | 交付错误结果 | Watchdog + 阶段退出证据 + 预算闸门 |
| Windows 进程树/路径差异 | 取消失败、测试误判 | 现有 Job Object 复用；平台专用用例 |

---

## 15. 未决问题

1. 云环境供应商抽象是否首版就做，还是先只支持"用户自带 SSH 主机"？
2. 评审模型族的"不同族"是否应成为硬性准入（只有一个供应商时如何降级表达）？
3. 规格图谱放在仓库内（可提交、可评审）还是应用数据目录（不污染仓库）？建议前者，需处理私有信息。
4. 投机执行的预算上限与用户可见性如何平衡（完全静默 vs 状态栏提示）？
5. 多仓库 Mission 的边界：只读依赖是否足以覆盖微服务场景？
6. 简报中的模型措辞是否允许超出账本事实的归纳？建议只允许组织，不允许新增结论。

---

## 附录 A：术语

- **Mission**：一次以交付为目标的委托。
- **Stage**：模板中的阶段节点。
- **Attempt**：阶段的一次执行实例。
- **Gate**：机器可验证的退出条件。
- **Receipt**：本轮变更回执。
- **Quiet protocol**：输出分类与节流规则。
- **EnvLease**：环境租约。

## 附录 B：与当前分支的映射

| 现有能力 | 位置 | 演进方式 |
| --- | --- | --- |
| 资源与设置 | `lib/ipc/orchestration.ts`、`SharedAgentSettings.tsx` | 增加角色与标签；保留 provider/Vault/代理字段 |
| 冻结快照与 worktree | `execution/worktree.rs` | 每个 attempt 独立现场；保留不自动清理 |
| Worker 启动与取消 | `execution/worker.rs`、`unix_group`、`windows_job` | 由 Stage 调度器驱动；增加环境变量与租约 |
| 账本与恢复 | `core/store.rs`、`core/lifecycle.rs` | 升级为事件账本 + 快照；增加决策与证据 |
| 候选产物 | `pack/*`、`AgentArtifact` | 增加 `testcase`、`evidence`、`briefing` 类型 |
| 编排 UI | `components/agents/*` | 从"单次会话"改为 Mission Control + 安静线程 |
| QA 能力 | `qa-ui-auto-tests/*` | 作为证据面执行器与用例格式来源 |
| 工作区 | `workspace/*`、`AgentsPlatformView` | 编辑器按需打开；worktree 与 workspace 关联 |

## 附录 C：原型导览

原型 `docs-feature/super-agents-proto-deepseek-v4.1-flash[1m].html` 为单文件、无外部依赖，覆盖：

1. **Mission Control**：待决策/运行/评审/完成分组，预算与注意力指标。
2. **Mission 工作台**：安静线程、决策卡、变更回执、过程折叠、阶段轨、检查器（计划/变更/证据/环境/成本）。
3. **Templates**：八个内置 playbook 与阶段图。
4. **Fleet**：环境租约、健康探测与开通流程。
5. **Quality**：覆盖矩阵、用例、flake 隔离、评审发现。
6. **Briefing**：结构化简报。
7. **Routing**：任务路由、预算、自治、触发器、记忆。

原型中的"显示过程"开关用于演示安静协议的默认值与可展开性；"简报"按钮演示一键汇总；"新建任务"演示模板驱动的入口。
