# 开发编排：代码基线与业界调研

- 核查日期：2026-11-03；代码基线 `main@3fb5b06d9`。
- 配合[主设计](../development-orchestrator-design.md)和[执行契约](scheduler-contract.md)。
- 本文保留首轮基线；第二轮已补充 [KiroCrew 与开源生态核查](ecosystem-review.md)、[上下文 / session / memory](context-session-memory.md)、[Jev 与决策路由](decision-and-routing.md)，包含固定源码版本和许可差异。
- 范围：调度、执行、隔离、恢复和验证。**按用户补充，不继续调查全体 agent 价格，不生成性价比榜单；成本配置交给用户。**
- 方法：只读源码核查与公开官方资料在线检索。没有启动实际 CLI 任务、登录账户、发起付费模型请求或执行横向 benchmark。
- 以下“缺失”指本次核查范围内没有可用的生产契约，不表示所有底层组件都要重写。

## 1. Taomni 当前能力与可复用边界

### 1.1 Agents / Crew 与工作区

| 能力 | 代码事实 | 设计影响 / 依据 |
| --- | --- | --- |
| Agents 主界面 | 仅“开发中”占位 | `src/components/agents/AgentsPlatformView.tsx:5`；本稿不是已实现能力说明 |
| 残留 Agents store | 派发、worktree 路径、成功轨迹都由前端同步生成；approve 直接追加测试通过 | `src/stores/agentsStore.ts:63`、`:104`；必须替换为后端真实状态投影，不能保留模拟成功逻辑 |
| 历史暂缓范围 | 2026-10-25 文档明确 Crew 后续再做 | `docs-feature/workspace-platform-redesign-design.md:9`；当前调研不擅自重新开放入口 |
| Git 基础 | 已注册分支、merge、rebase、cherry-pick、冲突处理 | `src-tauri/src/commands/git.rs:2`；可复用操作底层，但没有注册 linked-worktree CRUD |
| Worktree 命名误区 | 普通 Git 工作树操作不等于 `git worktree add/list/remove` 管理 | 不能因模块名含 worktree 就认为已有任务隔离 |
| Diff 移交 | 当前 helper 只把字符串作为 focusPath 交给 Git tab | `src/stores/agentsStore.ts:139`、`src/components/workspace/WorkspaceGitPanel.tsx:24`；需要真正注册和选中任务仓库 / 候选 |
| 工作区存活 | 已访问 workspace 隐藏不卸载，保留终端 / 编辑器 | `src/components/workspace/WorkspaceMainPanel.tsx:44`；不等于 renderer 无关的执行 owner |
| 应用退出 | 关闭主窗口转入安全退出流程，最终 `exitApp()` | `src/layouts/main/useApplicationExit.ts:43`、`:79`；没有独立调度 daemon 的契约 |
| 远端 workspace | 本地 WorkspaceFs spike 明确 deferred；SSH/SFTP 是独立会话 | `src-tauri/src/workspace_fs.rs:1`；首版不宣称支持远端代码 worker |

现行 `qa-ui-auto-tests/cases/TC-WS-011-agents-worktree-orchestrator-and-global-search.testcase.yaml` 保护开发中提示和真实搜索，不证明编排已落地。`docs-feature/testcases/` 同名历史副本不能作为当前行为证据。

### 1.2 LLM 和路由

| 能力 | 代码事实 | 编排层需要什么 |
| --- | --- | --- |
| 通用 LLM API | `Llm` 有 chat、tools、stream；response 有可选 usage | `src-tauri/src/llm/mod.rs:172`、`:196`、`:227`；可以作为直接调用 adapter 基础 |
| 逐请求模型 | 请求有 model_override，但普通 OpenAI / Anthropic adapter 保留原构造模型 | `src-tauri/src/llm/openai_compat.rs:15`、`src-tauri/src/llm/anthropic.rs:15`；不能直接承诺任意 provider per-task pin |
| OpenCode Go | 按请求选择模型、协议和 session header | `src-tauri/src/llm/opencode_go/mod.rs:90`；是聚合 LLM provider，不是 OpenCode coding-agent CLI |
| 模型组 / key | 原子 round-robin，失败尝试下一个 | `src-tauri/src/llm/router/groups.rs:46`、`src-tauri/src/llm/router/rotation.rs:59`；是请求路由，不是 DAG 或 resource scheduler |
| Fallback | `complete` 有特定 primary / secondary 路径，stream / Agent 可能直接取 provider | `src-tauri/src/llm/router/routing.rs:174`；不能把配置开关理解为所有 runtime 都有相同失败语义 |
| 当前工具循环 | 直到 final 或取消，无硬 tool-round cap，工具逐个执行 | `src-tauri/src/chat/stream/provider.rs:209`；需单独有界任务 runtime，不能把聊天入口当 durable worker |
| 模型目录 / 检视 | 有元数据、目录缓存与检测结果 | `src-tauri/src/llm/model_catalog.rs:38`、`src-tauri/src/ai/model_inspector.rs:22`；目录缓存不是推理缓存，检测也不是 benchmark |

`src-tauri/src/agent/mod.rs` 的旧 ReAct 入口与当前 chat 工具循环不是同一执行器；旧 `MAX_AGENT_STEPS` 不能代表现在的任务预算。

### 1.3 Coding-agent bridge

| Bridge | 可复用 | 必须补齐或不能承诺 |
| --- | --- | --- |
| Claude Code | 长驻 child、双向 stream-json、session ID / resume、模型和设置、工具事件 | 聊天传来的 cwd 只是 prompt 信息，不设置 child 目录；无整回合互斥；取消主要 kill child；不是任务 checkpoint |
| Codex | app-server initialize / thread / turn、模型选择、局部重入 guard | 原生 server request 审批未完整接入；stop 主要 kill；resume 失败可新建会话；自定义 profile 的临时 home 不适合 durable resume |
| ACP | stdio JSON-RPC、initialize / session / prompt、permission / cancel、turn guard | 能力相关的 load；当前 timeout 包括 prompt 总时长；事件可能 lag；未接通统一标准模型选择，不代表任何 ACP agent 都支持相同能力 |

关键锚点：

- CC runtime：`src-tauri/src/agent/cc_bridge/process.rs:94`、`:190`、`:472`；信息性 cwd：`src-tauri/src/chat/mod.rs:89`。
- Codex resume fallback / 重入：`src-tauri/src/agent/codex_bridge/process.rs:173`、`:210`；reader：`:504`；临时 home：`src-tauri/src/agent/codex_bridge/config.rs:213`。
- ACP prompt / cancel：`src-tauri/src/agent/acp_bridge/process/conversation.rs:64`；request 总超时：`src-tauri/src/agent/acp_bridge/process/requests.rs:40`。
- 中立事件类型已有起点：`src-tauri/src/agent/local/types.rs:3`；当前不是统一 start / execute / cancel / reconcile executor trait。
- 聊天运行 stop registry：`src-tauri/src/chat/run.rs:11`；进程 reaper：`src-tauri/src/lib.rs:257`，只是资源回收，不是持久队列。

### 1.4 工具、持久化、安全与网络

| 领域 | 已有事实与可复用部分 | 不应继承的隐含假设 |
| --- | --- | --- |
| scoped MCP | Bearer token、scope、权限流水线、安全分类 | scope 不等于 OS 沙箱，通用控制工具也不等于限定 repo 工具 |
| 副作用执行 | 部分 MCP 发前端事件，等待前端执行回执 | `src-tauri/src/agent/cc_bridge/mcp_http/handler.rs:18`、`:46`；完全后台任务需改为后端执行 owner |
| 任务化基础 | 备份先落盘 job 再 spawn，有 cancel token 与启动恢复 | `src-tauri/src/backup/jobs.rs:343`、`:464`；可借鉴 lifecycle，不把备份任务类直接扩成所有编排业务 |
| 命令运行 | 编辑器 terminal 可真实执行命令、传 cwd / env、接退出回调 | `src/components/editor/workspace/panels/TerminalDockPanel.tsx:60`；React Promise 和终端标记不是 durable command receipt |
| SQLite | 有事务 upsert 和兼容增列惯例 | `src-tauri/src/database/query_workspace.rs:65`、`:160`；没有现成编排 schema，也不能假设新目录自动备份 |
| LLM 代理 | 有 app / custom / none 的严格 resolver | `src-tauri/src/ai/config/proxy.rs:14`；configured proxy 失败不应直连 |
| CLI 代理 | ACP 会清理继承 proxy env；CC / Codex 当前 none 不等于清理父环境 | `src-tauri/src/agent/acp_bridge/config.rs:295`；`src-tauri/src/agent/cc_bridge/mod.rs:39`、`codex_bridge/mod.rs:33`；进入调度需统一三模式契约 |
| 凭据 | provider / profile 可用 Vault ref | 不把明文临时配置、随机目录名视为安全保证；需要文件权限、日志脱敏和崩溃清理 |
| usage | 多协议能报告部分 token / 回合数据，chat 层主要 live-only | `src-tauri/src/chat/mod.rs:258`、`agent/local/types.rs:3`；任务归因、持久化、累计差值另做，unknown 不填 0 |

现有协议测试和 fake-agent fixture 是 adapter contract 测试起点，不证明真实 CLI 的取消、进程树、代理和重启恢复效果。

## 2. 在线调研：哪些方法值得吸收

### 2.1 OpenAI Symphony：最接近“开发调度器”的参考

来源：[官方 SPEC.md](https://github.com/openai/symphony/blob/main/SPEC.md)，本次读取标为 **Draft v1**；重点 §§8–11、14–15。

观察：

- 区分 issue 身份、workspace、运行 worker 和重试；派发前检查是否已经 claimed / running。
- 每轮先 reconciliation，再取候选并排序；有全局 / 状态并发限制。
- 有 stall 检测、有界退避、运行资格重新检查和 workspace 复用。
- agent 成功退出不等于 issue 已完成。
- 该版 scheduler bookkeeping 在内存中，重启不恢复 live session / retry timer；工作目录保留不是完整工作流恢复。
- workspace 分离也不自动等于沙箱，hook 是可信执行代码。

采用：确定性 admission、先对账再派发、独立执行身份、显式等待 / 重试。

不照搬：不要求 Taomni 先依赖 issue tracker；不能照搬内存状态然后宣传 durable；不自动删除仍有用户价值的现场。

### 2.2 Cursor：规划 / 执行分工有价值，大规模输出不等于质量证明

来源：[Scaling long-running autonomous coding](https://cursor.com/blog/scaling-agents)，2026-01-14。

观察：

- 平级 agent 通过共享锁协调，出现吞吐瓶颈和任务无人承担。
- 分离 planner、worker、judge 后协调改善；周期性新上下文减少漂移。
- 其 judge 的继续 / 停止判断不是完备软件验收；研究实验的产量不能当生产质量证明。
- 独立 integration agent 在该实验成为瓶颈，被移除；不能据此认定所有系统都不需要集成控制。

采用：工作包清晰 owner；规划 / 实现责任分离；artifact handoff 和有界重规划。

不照搬：常驻一大群 agent、自主递归、以代码行数做性能指标。Taomni 的 IntegrationService 是受控 Git 操作与证据链，不要求一个常驻 LLM 集成代理。

### 2.3 Anthropic：独立探索适合并行，紧耦合编码未必

来源：[How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)，2025-06-13。

观察：

- 独立上下文和明确委派有利于并行信息搜集，产物引用减少重复复制。
- coding 往往比 research 更少真正可并行的任务，需要共享上下文时协调更难。
- 文章中的性能改善来自研究评测，不是 Taomni coding benchmark。
- 文章的多 agent token 倍数以普通 chat 为基线，不能误写成“比单 agent 贵相同倍数”。

采用：先证明工作包独立；给目标、范围、产物和验收；独立验证而非所有 agent 广播全部日志。

不照搬：把研究场景收益当开发保证，或为了多 agent 自动扩展数量。

### 2.4 Aider：强规划 / 独立编辑是选项，不是强制流水线

来源：[Chat modes](https://aider.chat/docs/usage/modes.html)。

Architect 产出方案，editor 转成文件编辑；两个角色可以是同一个模型，也会多一次请求与等待。默认并非所有任务都用 architect 模式。

采用：用户可配置规划与执行分工，已有充分设计则跳过重复规划。

不照搬：不预设“强模型设计 + 便宜模型写代码”必然最优；具体资源由用户定义。

### 2.5 Temporal：恢复调度状态不等于副作用只发生一次

来源：[Retry Policies](https://docs.temporal.io/encyclopedia/retry-policies)、[Tasks](https://docs.temporal.io/tasks)。

观察：workflow 状态回放、workflow 重启重试、activity 重试是不同概念。外部动作可能成功但回执丢失；自动重试必须以幂等和可检查后置条件为基础，不能把 checkpoint 等同任意副作用 exactly-once。

采用：控制面 / 执行操作分离、持久 intent / result、有限重试、未知动作人工对账。

不照搬：MVP 不引入 Temporal 服务。取其可靠性原则，不给桌面应用强加分布式基础设施。

## 3. 接口调研：跨 agent 适配应保留差异

### 3.1 ACP

来源：[Protocol Overview](https://agentclientprotocol.com/protocol/overview)、[Session Setup](https://agentclientprotocol.com/protocol/session-setup)。

- JSON-RPC 请求 / 通知、initialize 能力协商、session/new、prompt、cancel、权限。
- load / resume 要按实际协商能力使用。overview 与详细 lifecycle 页面覆盖程度不同，应以具体协议版本和握手结果为准。
- client 提供文件 / terminal RPC 是能力项，不代表 agent 不会通过自身进程访问 OS。
- 不提供通用 durable job、任务验收或 OS 隔离保证。

设计结论：ACP 是长期通用 adapter 通道，不是整个调度器。Taomni 需要继续定义 Attempt、资源、产物和恢复契约；不能只做“统一 ACP session”就完成开发编排。

### 3.2 Claude Code

来源：[Run programmatically](https://code.claude.com/docs/en/headless)、[Agent teams](https://code.claude.com/docs/en/agent-teams)。

- 非交互 CLI 有结构化流、session resume、工具许可和执行上限；最终回执有停止原因与可选 usage。
- session resume 续接对话，不保证任何外部动作可重放；SIGTERM 与正常 interrupt 的行为不同。
- 非交互模式可能自动加载项目 hooks / MCP / 插件，可信边界必须在启动前建立。bare / 配置来源等行为版本敏感，不能盲目给所有用户强行开 bare。
- Agent teams 仍有实验性和恢复 / 协调限制；不能假定当前 `-p` bridge 能直接承载 teams。

设计结论：优先复用现有 CLI 协议，并补齐受控任务 runtime，不把一个原生 team 当 Taomni 的任务数据库。

### 3.3 Codex

来源：[App server](https://learn.chatgpt.com/docs/app-server)。原 `developers.openai.com/codex/app-server/` 本次重定向到此官方文档入口。

- stdio JSON-RPC、initialize、thread/start / resume、turn/start / interrupt、事件及 server-to-client 权限请求适合 IDE / desktop 集成。
- interrupt 的应答和 turn 结束是不同事件。
- 具体 schema 应由安装的 CLI 生成 / 匹配，实验字段按能力 opt-in；不要把网页示例当所有版本兼容保证。
- 本次取到的内容没有核实完整 token usage payload 及聚合规则，因此不声称能仅靠文档统一金额 / 用量。

设计结论：app-server 是已有高价值底座，先补原生审批、终态与 session 存储，再纳入统一 adapter。

### 3.4 OpenCode

来源：[Server](https://opencode.ai/docs/server)。

- `opencode serve`、session API、异步 prompt、abort、permissions 和 SSE 可用于编排接入。
- HTTP / SSE 接口存在不等于服务重启可自动恢复任何任务，也不等于工作目录有安全隔离。
- 独立 HTTP adapter 是可选扩展；用户已通过 ACP 接入的 profile 可先走 ACP，不必第一版全部实现一遍。

设计结论：保留 adapter 扩展能力；不要混淆 OpenCode agent server 与 Taomni 现有 OpenCode Go LLM provider。

## 4. 认证与产品集成的实施检查

来源：[Claude Code Legal and Compliance](https://code.claude.com/docs/en/legal-and-compliance)，本次在线核查版本。

- 文档允许在满足适用 Commercial Terms 等条件下预装 / 运行**未修改的** Claude Code，并要求不能移除或限制其内建认证方式。
- 每个终端用户使用自己的凭据并由相应服务向其计费，平台不得代用户支付 / 转售 / 中介 Claude usage。
- 订阅登录必须由 Anthropic 官方流程完成；第三方不能收集、存储、中介 Claude.ai 凭据或 session token。
- 文档也明确：这不禁止终端用户在未修改的官方 Claude Code 中，用自己的订阅登录。

本设计据此区分：**用户自有、未修改 CLI 的正常使用**与**Taomni 提取订阅 token 后直接调用 API / 代付转售**。不把二者混成“所有订阅 CLI 编排都禁止”，也不据此宣称任何产品分发方案天然合规。API 使用、SDK 使用和产品分发在实施前按实际模式复核最新条款。

其他 provider / CLI 同样需要检查其实际产品条款；本次没有逐个完成法律审查。用户定义成本策略不代表可以绕过服务配额或认证限制。

## 5. 本轮结论与证据限制

1. 更适合 Taomni 的路线是：**确定性开发工作流 + 可选智能规划 + 可插拔执行器**。
2. 可落地的核心不是 agent 聊天室，而是任务 owner、输入版本、有限资源、产物、证据与恢复对账。
3. 跨 agent 差异必须通过 capability 真实暴露，不能为了统一 UI 隐藏不支持的模型、审批、取消和恢复。
4. 原生测试、真实 Git 后置条件和最终用户接受比模型口头总结更重要。
5. 成本保持用户策略接口；本轮不形成模型选型 / 价格结论。

**未验证**：任何真实 CLI profile 在本机的登录状态、版本兼容、性能、费用、强沙箱、进程树停止、代理三模式或崩溃恢复。在线文档是设计证据，不能代替这些实施验收。

**首轮检索限制**：部分长页面只返回摘要或局部，若没有读到具体字段就不作支持承诺；当时未成功取得完整 LangGraph durable-execution 正文。第二轮改读固定版本的 LangGraph / DeepAgents 关键实现，结果见[生态核查](ecosystem-review.md)，不把首轮缺口误写成永远不支持。外部页面可变化，正式实现时需固定目标协议 / CLI 版本并运行 adapter contract tests。
