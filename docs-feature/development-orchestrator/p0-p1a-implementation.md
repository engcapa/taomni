# 开发编排：P0 / P1A 纵向切片实施交接

- 状态：v0.6 UI已确认、实施计划同步稿。本轮仅文档 / 原型commit与push，之后等指令，暂停产品开发 / CI运行。
- 当前HEAD `0c350c0db`，初始静态基线`3fb5b06d9`；AGENTS.md三端 / 800行 / crash-regression继续有效。
- 设计来源：[主设计](../development-orchestrator-design.md)、[review工程修正](review-resolution-v0.4.md)。
- 当前UI基准：[v0.6交互原型](ui-prototype-v0.6.html)、[UX / 配置继承](developer-agent-ux-v0.6.md)，**用户已查看并确认**。v0.4仍保留历史，不作为TASK-OR09实施基准。

## 1. 首版范围收敛

### P0

仅 core state / store / service / fake executor；5 表。固定 DAG，无无界重规划。单机 AppState owner，不建常驻 daemon。

### P1A

1. 独立 API 三协议（先保留旧行为再提 codec）+ 用户资料 / 规范 / 任务预览。
2. 用户显式 / 模板合包：设计、静态审阅；总计 ≤3 文本文件 patch 通过专项门后在同阶段启用。
3. 默认 main=1 / auxiliary=0 / recovery=0；完整帧独立落盘 candidate，用户确认才增加至多一次 recovery。
4. 内置 **Claude Code** fresh task adapter，含真实 cwd、原生 session 独占、启动期取消、权限门和进程树。选择依据是已有双向 stream-json / MCP 许可接点可复用；不声称它已满足 task contract 或全局最优。检测不到可用 CLI 时该节点明确 blocked，API 不受影响。
5. builtin 验证 + 独立 worktree + BootstrapRecipe + 真实 Heavy / build-pool 锁。
6. 8 表，不预建 memory / Jev / 外部 executor / trigger。记忆提议和受限事实仅作 typed artifacts。
7. 计划 / 模板确认后自动派发批准步骤；改计划、扩权、目标应用 / 合并需人确认。测试失败默认停下，只有已批准模板明列、且调用预算允许的有限修复才可运行。

P1B 接 **Codex**、portable handoff、审批 / gate 查询投影；P2 才接外部 OpenHands / Aider、Jev shadow / bounded_auto、正式记忆、触发；P3 独立 daemon。阶段是实现边界，不提前造空目录 / 表。

## 2. 首版模块与唯一 owner

目录边界不是服务数量。P0/P1A 最多四个责任目录：`core/`、`execution/`、`context/`、`pack/`，其余用明确 typed 接口，不预建十七个子系统。

| 拟新增路径 | 责任 |
| --- | --- |
| `src-tauri/src/orchestration/{mod,commands}.rs` | facade / IPC；只组装，不持第二套业务状态 |
| `orchestration/core/{model,store,service,scheduler,recovery}.rs` | typed 状态、8表、单写准入、操作 intent 和恢复 |
| `orchestration/execution/{adapter,supervisor,claude_code,builtin,workspace,bootstrap}.rs` | 执行、进程、worktree、环境与资源生命周期 |
| `orchestration/context/{model,compiler,sources}.rs` | 规范 / 文件快照、出站能力和 manifest |
| `orchestration/pack/{model,frames,collect,publication}.rs` | NDJSON 增量、候选落盘、覆盖 / 发布组 |

每文件目标 200–400 行、facade 可更短；增加职责可继续拆文件，不为满足目录数硬压单文件。ArtifactStore 的文件原子写 / hash 由 core/store 引用独立 helper（需要时 `core/artifact_files.rs`），不把磁盘副作用放 UI。

新 API wire 代码位于 `llm/*`，不和上述目录混成第二套协议层。新增模块必须保留旧 `ChatRequest / ChatResponse / StreamEventOut` 兼容。

## 3. 最小接口（拟新增）

统一命令前缀 `orchestration_`，修改命令带 `command_id / expected_revision`：

| IPC | 输入 / 输出 | 完成语义 |
| --- | --- | --- |
| `preview_context` | task / profile / source selection → manifest / omissions / 容量 / 调用预算 | 不发生成请求；预览不等授权 |
| `create_run` / `authorize_run` | 固定计划 / bundle / policy revision → run snapshot | 授权人、范围、成本 / 默认补救明确 |
| `get_run` / `list_runs` / `list_events` | run ID / after_sequence → 状态 / 单调事件 | 先订阅再快照 + gap 补读，不由 UI 重发任务 |
| `cancel_run` / `request_pause` | 目标 / 理由 → 已接受控制请求 | 不等于实际停止；展示 stopping / needs_attention |
| `resolve_approval` | request / 参数 digest / revision / allow-or-deny | P1A events 持久保存，过期 / 无主请求不得执行 |
| `authorize_recovery` | pack / failed scope / 候选 hash / max_generations=1 | 新 request ledger；默认0，不复用旧授权无限修复 |
| `accept_candidate` / `apply_candidate` | group / candidate / target base / action | 接受 / 应用不同操作，需真实验证和人工确认 |

快照 `RunSnapshot` 至少含 revision、event sequence、计划、成员 / attempt 状态、候选、bootstrap wait reason、审批和调用预算。产物事件含 `artifact_id / member_id / validation_state / content_hash`，不能只发“成功”字符串。

配置一次、多任务复用：Settings持有共享resources + default_plan，复用已有provider / model / Vault / proxy，不为每task复制endpoint / 密钥。`orchestration/profiles.json`保存版本化共享配置，安全原子写、CAS且无秘密明文；TaskSubmission仅项目、目标、意图、资料和继承plan引用，发送时冻结effective revision。保存影响未来任务，旧任务不热换；取消设置不保存。schema细节见[v0.6 UX §5](developer-agent-ux-v0.6.md)，无需第9张表。

## 4. TASK 工作包（全部待实施）

### TASK-OR01 旧行为保护 + Codec 先行拆分

- 文件：修改 `src-tauri/src/llm/{openai_compat,anthropic,mod}.rs`；新增 `llm/openai_compat/{request,stream,wire_types}.rs`、`llm/anthropic/{request,stream,wire_types}.rs` 和 `tests.rs` / 分情景 fixture。
- 输入：[协议 §2.1](llm-protocol-contract.md)，现有聊天 / Go / router 测试。
- 依赖：无。负责 shared llm/mod.rs 出口，OR05 仅通过此 owner 顺序集成。
- 改动：旧接口 / body / headers / model 语义保持；先拆纯 request / SSE / types，再接新接口，不先改旧工具循环 stream:false。
- AC：AC-L06、AC-O16；V-OR01。
- 完成：旧行为 golden + 任意 SSE 分块、tools / image / Go headers / model pin 回归；新文件≤800，目标200–400，无跨 facade 环依赖。

### TASK-OR02 Core store 与八表迁移边界

- 新增：`orchestration/mod.rs`、`core/{model,store,artifact_files}.rs`；`core/tests/{schema,claim,artifacts}.rs`。
- 依赖：无，可与 OR01 独立。必读 scheduler §8.1，唯一 schema owner。
- 改动：P0五表 / P1A增三表、PRAGMA user_version、FK / claim / event / request去重；typed operation intent 与原子文件 + artifact引用；无其他阶段空表。
- AC：AC-O02/O03/O08、INV-01/03/04/11；V-OR02。
- 完成：事务失败 / 重复 claim / 新旧 schema / 文件落盘崩溃均可检查；unknown attempt 不释放现场，schema拒绝未来版本；可查询缺终态 intent，不重放付费请求。

### TASK-OR03 Scheduler / owner / cancel / exit

- 新增：`core/{service,scheduler,recovery}.rs`、`execution/{adapter,supervisor}.rs`，对应 `core/tests/lifecycle.rs`、`execution/tests/process_tree.rs`。
- 修改接点：`src-tauri/src/lib.rs` 初始化持有独立 `OrchestrationRuntime`（不塞聊天 registry）；`src/layouts/main/useApplicationExit.ts` 在显式退出前查询任务 / 持久停止结果。
- 依赖：OR02；与 OR04可并行，均只读核心 DTO。
- 改动：单 owner、按阶段资源准入、fake adapter、启动到收集的取消、renderer reload 无影响；安全退出拦截；崩溃对账无自动未知重发。
- AC：AC-O03/O05～08；V-OR03。
- 完成：重复 wake 不重复spawn；停止真实受控进程树或明示 unknown；前端关闭 / refresh 不清 owner；宿主退出有持久现场。

### TASK-OR04 Context / profile / 可预览编译

- 新增：`context/{model,compiler,sources}.rs`、`context/tests/{sources,budget}.rs`，配置存取 helper `context/profiles.rs`。
- 依赖：OR02；协议 capability 由 OR05 合同输入，先用 fake shape。
- 改动：文档 / 规范 / 代码 / task快照、出站与容量检查；共享resources / default_plan配置读取 / CAS保存、Settings变更只影响新任务。编译时解析继承并pin版本，不向UI要求逐任务编辑；read set存bundle字段，无memory库。
- AC：AC-C01～03/08、AC-P03；V-OR04。
- 完成：无CLI / 无聊天thread可生成真实正文请求；source变更拒用旧预览；缺必需 / 过大 / 不支持模态明确blocked；预览零生成调用。

### TASK-OR05 三协议 Invocation

- 新增：`llm/invocation/{mod,request,receipt,capabilities}.rs`、`llm/protocols/{mod,chat,messages,responses}.rs`、`llm/invocation/tests/{chat,messages,responses}.rs`。
- 修改：必要时提取 `llm/opencode_go/responses.rs` 的中立codec，`opencode_go/mod.rs` 仍保留其路由 / session契约；出口与OR01顺序合入。
- 依赖：OR01、OR04；OR02 request ledger接口。
- 改动：typed blocks / stop / usage / schema 与原生扩展；独立流式调用；call reserve前于发送、aux / SDK retries受限；三代理模式和Vault复用。
- AC：AC-L01～06、AC-K04；V-OR05。
- 完成：本地假网关三协议文本 / 拒绝 / 截断 / SSE error / usage测试；旧chat不退化；无模型探针暗耗费。

### TASK-OR06 Pack 分帧 / 部分候选 / 一次补救

- 新增：`pack/{model,frames,collect,publication}.rs`、`pack/tests/{frames,partial_recovery,publication}.rs`；fixtures独立文件。
- 依赖：OR02、OR04、OR05（解析器可先离线独立开发）。
- 改动：用户显式成员、NDJSON item/chunk/end、流任意边界；候选逐项持久化、共享组阻塞、≤3文件patch gate；main1/aux0/recovery0，人工授权一次recovery。
- AC：AC-P01～08、AC-O15；V-OR06 / V-PF01～05。
- 完成：第N项无效或截断前N−1项磁盘候选仍在，task不伪成功；重启不丢已保存项；未授权无第二请求；恢复带旧hash且不重复前项 / 费用。

### TASK-OR07 Worktree / Bootstrap / builtin / 一个 CC bridge

- 新增：`execution/{workspace,bootstrap,builtin,claude_code}.rs`、`execution/tests/{worktree,bootstrap,claude_code}.rs`。
- 修改范围：仅必要 `agent/cc_bridge/{process,config}.rs` 的受控选项 / 复用协议；新 task owner 不复用 chat线程身份。共享Git helpers按现有模块公开typed内部函数，不暴露任意shell IPC。
- 依赖：OR03、OR04、OR06；必读 [Bootstrap](workspace-bootstrap.md)。
- 改动：唯一worktree、真实cwd、完整准备receipt；pnpm store + 私有布局；Cargo pool与Heavy原子锁；CC turn guard / permission / process-tree / event归因；验证binary在锁内归档。
- AC：AC-O01/O03～06/O09、V-BS01～06；V-OR07。
- 完成：双attempt推理可并行，构建同池仅一真进程；缺依赖不是假测试失败；lock不同不共享；CLI绕不过slot或禁止其共享可写target；工作区 / 用户目录不被清理。

### TASK-OR08 IPC / stub / 前端投影

- 新增：`orchestration/commands.rs`、`src-tauri/src/commands/orchestration.rs`、`src/lib/ipc/orchestration.ts`、`src/stores/orchestrationStore.ts`、`src/stubs/commands/orchestration.ts` 及同位测试。
- 修改：`commands/mod.rs` 注册、`src/stubs/tauri-core.ts` 注册（不改其他域）；OR03负责lib初始化，避免双owner。
- 依赖：OR03～07；UI wire合同可用fake先集成。
- 改动：命令 / revision / seq / 错误码、订阅后快照和事件gap恢复；真实后端不可用不落回假成功；stub明确browser demo。
- AC：AC-O07/O11/O15、AC-C03；V-OR08。
- 完成：StrictMode / 双点击 / 旧revision / renderer重连仅投影一次；前端unmount不cancel；快照能还原部分候选和审批。

### TASK-OR09 开发Agent主界面与统一设置（v0.6已确认）

- 新增：`src/components/agents/orchestration/{AgentTaskSidebar,AgentConversation,AgentComposer,PlanMessage,TaskInspector,RecoveryPrompt}.tsx`、`SharedAgentSettings.tsx`与同位行为测试、typed `model.ts`。按职责200–500行，不造单一超大UI controller。
- 修改：`AgentsPlatformView.tsx`只组合；入口 / locale沿现有Taomni，设置复用已有provider / Vault / proxy UI；`useApplicationExit.ts`与OR03协调。不恢复旧agentsStore模拟执行。
- 依赖：OR08、OR04共享配置与OR06产物合同；DEC-OR11/13/14已由用户确认，UI不再等待重复方向审批，实施本身仍等下一指令。
- 行为：左项目任务、中会话和输入、右按需diff / context；计划 / worker展开在消息中。默认方案跨任务沿用，输入仅目标 / 意图 / 文件；设置保存 / 取消与旧任务快照、部分候选 / 显式恢复都有真实状态。
- AC：AC-UX01～07、AC-O07/O11/O15/O16；V-OR09。
- 完成：高度对齐v0.6主布局与状态；unit证明多个任务共用配置、改设置不追改旧任务、Esc不保存、无逐任务必填参数；GitHub browser/native证明真实交互，不以原型demo当完成。

### TASK-OR10 集成验收与当前端真机

- 新增：`src-tauri/tests/integration/orchestration.rs`、`tests/support/orchestration_fixture.rs`；注册 `tests/integration/main.rs`。
- 拟新增 QA：`qa-ui-auto-tests/cases/TC-ORCH-001-context-preview.testcase.yaml`、`TC-ORCH-002-pack-partial-recovery.testcase.yaml`、`TC-ORCH-003-background-exit.testcase.yaml`，经目录去重后登记 `ci/policy.yaml` / feature-list / controls；维护现行TC-WS-011从“开发中”到真实入口的有意变更，保留真实搜索断言。
- 依赖：OR01～09；共享集成owner只在代码稳定后集中build与QA，不为每小包全量native。
- AC：全部P1A适用AC；V-OR10。
- 完成：受影响单测 / 原生副作用、boundaries / size / build、当前Linux真实WebView + 完整browser/native crash-regression（matching QA release）和ORCH cases；缺证据不报完成。Windows/macOS代码兼容检查与真机待执行步骤分别记录，不把Linux结果复制。

## 5. 验证表与命令（实现后使用）

**执行位置以用户最新测试约束为准**：本地仅unit；所有产品browser/native用例和相关真实边界集成在GitHub `qa-ui-auto-platforms`，不运行本地Tauri / browser suite。下面命令是实现后对应层的入口，不授权本轮执行。

CI还须提供兼容OpenAI / Anthropic的隔离fixture LLM server，并验证Claude Code / Codex / Pi / OpenCode / DeepSeek Harness / ZCode的真实worker编排连接；版本 / 可配置端点 / 功能覆盖据实记录，不以fixture worker替代真实harness。fixture资源不得污染生产共享默认配置；多harness范围需后续实施包补充，原P1分期不是自动豁免用户此项要求。

| V | 层级 / 命令 | 关键断言 |
| --- | --- | --- |
| V-OR01 | `cd src-tauri; cargo test --lib llm::`；既有router / ACP集成按筛选执行 | 拆分前后旧body / stream / headers保持，新边界不环依赖 |
| V-OR02～07 | `cd src-tauri; cargo test --lib orchestration::`，特定scenario可筛子模块 | 八表 / 原子claim / 进程树 / 分帧 / 依赖 / build-pool真实效果 |
| V-OR08～09 | `pnpm exec vitest run src/stores/orchestrationStore.test.ts src/components/agents/orchestration`（拟新增后） | 可见资料、候选、恢复、revision和UI生命周期，不只查内部调用 |
| V-OR10集成 | `cd src-tauri; cargo test --test integration orchestration`（新增注册后） | fake endpoint + 真Git / 子进程 / 磁盘 + live UI闭环 |
| 集成边界 | `pnpm check:refactor`、`pnpm build`、`cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` | file / contract / 旧public行为 / 三端代码兼容 |
| QA | 依 `.agents/skills/qa-ui-auto` 和 `qa-ui-auto-tests/ci/crash-regressions.md` 选plan后通过background_job运行 | 新增case+受影响TC-WS-011+完整tag；native串行、总本地worker≤2 |

命令当前不代表已存在新测试。依赖Node22 / pnpm10 / Rust与Tauri系统环境；真实模型调用另需授权，不以空skip证明通过。

## 6. 当前端手册与平台检查

当前Linux：隔离app-data / 临时repo / 本地假网关，无个人凭据。先保存source / runner / case / QA release hash；真实UI创建设计pack、预览资料、确认一次发送；假网关截断第2项，独立核对第1项artifact hash与DB；切换工作区 / renderer reload保持owner；同意一次recovery只产生一次新增POST。patch fixture≤3文本文件，实际Git diff / tests gate / 人工accept分开核查。

再启动两受控命令验证同Cargo pool排队、取消进程树、退出拦截与重启对账；不为此运行全产品两次cargo并发。测试结束只清理有marker且无活owner的本轮目录。

Windows：WebView2、Job Object、junction / ACL、命令argv / 路径；macOS：WKWebView、process group、沙箱 / 文件权限；二者保留相同case与二进制身份，不把无设备写成通过。若原生parser/进程边界已知不兼容，必须修复，不能以“只在Linux”放行。

## 7. 交接状态与发布门

- 全部 TASK 当前 pending / 未领取，AC/V均待实施 / 待执行。
- 用户曾要求开始开发，后明确暂停为“先重做原型 / 设计”；当前原型已确认，但最新动作仅详细英文提交 / push后等待。**不能用此前开发请求跳过当前暂停。**
- DEC-OR11/13/14图稿 / 统一配置方向已确认，无需重复审批。真实CC与其他harness能力仍须OR07 / 后续合同证明，不足blocked，不静默替换或用mockworker冒充。
- 若P1A纵向闭环没跑通，暂停memory / Jev / trigger / 外部executor工作，不以先铺基础设施替代交付。
