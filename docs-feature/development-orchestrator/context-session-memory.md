# 开发编排：直接 LLM 调用、上下文、会话与记忆

- 状态：2026-11-03 v0.4 review 修订；按阶段实现，模型记忆仅proposed，不代表已有能力。
- 关联：[主设计](../development-orchestrator-design.md)、[调度](scheduler-contract.md)、[决策](decision-and-routing.md)、[打包 / CodeGraph](packed-inference-and-code-context.md)、[协议](llm-protocol-contract.md)、[成本](cost-and-selection-policy.md)。
- 修订原因：用户要求独立 LLM API 调用，并解决相关文档 / 规范 / 任务组装、异构 agent session、记忆和决策问题。

## 1. 四个概念不能混为一谈

| 概念 | 内容 | 所有者 / 寿命 |
| --- | --- | --- |
| 任务状态 | 谁做什么、输入版本、执行结果、gate、审批 | 调度数据库；程序提交事实 |
| 逻辑会话 | 同一开发目标下可见的消息、问题、决策、交接 | Taomni；可跨执行器保留 |
| 原生会话 | CC / Codex / ACP / 特定 API 的上下文和协议状态 | 对应 backend；受版本和存储约束 |
| 长期记忆 | 经筛选的项目知识、偏好、经验及其来源 | 有作用域的 MemoryService；不代替前三者 |

**共享任务上下文是目标，共用一个原生 session 不是默认手段。** 多个 agent 可以属于同一逻辑协作空间，但必须保留不同的原生会话和写现场。

## 2. 现有能力到底能复用到哪里

- `src-tauri/src/llm/mod.rs:172`、`:227`：已有请求 / response 和 LLM trait，可复用传输。
- `src-tauri/src/chat/stream/provider.rs:53`：已有 system、终端、历史、附件和用户输入拼装，但依赖 chat thread / UI 请求，不是独立任务编译器。
- `src-tauri/src/chat/context.rs:72`：工作区根、文件名、dirty、LSP 等运行信息，**主要是元数据，不是文件正文、规范依赖解析或知识检索**。
- `src-tauri/src/chat/attachments.rs:239`：API 图片会发实际多模态数据，文本只是受限 preview，截断会标记；CLI 附件则是本地路径提示。二者不能当同一上下文交付保证。
- `src-tauri/src/agent/context/thread.rs:10`：有跨 bridge 的运行 context 类型，但保存的是绑定信息，不是跨 agent 开发会话或长期记忆库。
- `src-tauri/src/chat/acp/conversation.rs:292`：部分新 session 附最近历史文本，是有限兼容降级，不是无损异构 session 迁移。

因此新增独立 `LlmInvocationService` 和 `ContextCompiler`，抽取已有可复用 renderer / 附件校验；不把创建假聊天线程作为调用 LLM 的必需前提，也不改变普通聊天现有契约。

## 3. 独立 LLM 调用是一等执行能力

### 3.1 使用方式

开发会话、模板、任务图都可以创建 `llm_call`，但不要求用户逐任务填写API参数：Settings的共享执行资源和默认开发方案统一提供连接 / 模型 / call策略，发送时只提交目标、意图和资料，冻结配置版本。会话中的“规划”不必启动coding CLI。具体[v0.6 UX](developer-agent-ux-v0.6.md)。典型工作：

- 给设计文档、仓库规范、任务说明，输出任务拆分或设计草案。
- 给精确 diff / 源码片段和验收规范，输出结构化复核建议。
- 给失败日志与测试回执，输出故障分类 / 修复建议。
- 给选定文件，输出结构化 patch；不直接应用到用户目录。
- 给资料输出摘要、迁移清单、测试场景；不必启动 coding-agent CLI。

一个独立调用同样创建最小 Run / TaskAttempt，用于取消、用量、产物、证据和恢复；不要求有 Git worktree，只有要执行文件副作用才分配写现场。

允许本地模型和云端 API；模型、provider、代理和出站数据策略由用户指定。自动补缺资料、摘要、embedding、rerank 也可能调用模型，必须进入相同调用链和用户授权，不是“免费后台功能”。

### 3.2 调用契约

逻辑类型，不是当前 IPC：

```text
LlmInvocation {
  invocation_id, attempt_id,
  execution_profile_ref,
  objective, task_type, invocation_mode, pack_ref?, call_budget_ref?,
  context_selection,
  context_recipe_ref,
  logical_session_ref?,
  output_contract: text | json_schema | patch_proposal,
  tool_policy: none | bounded,
  limits, authorization_ref
}

CompiledContext {
  bundle_id, revision, digest,
  input_snapshot_ref?,
  source_manifest[],
  mandatory_items[], selected_items[], omitted_items[],
  policy_revision, memory_read_revision,
  logical_event_watermark,
  token_estimate, estimate_method,
  sensitivity, allowed_destinations
}
```

LLM runtime 返回 `InvocationReceipt`：实际 provider / model、request ID、compiled context hash、停止原因、schema 验证结果、usage、输出 ArtifactRef。API 响应 HTTP 200 不等于输出有效。

### 3.3 真正发给 API 的不是一串路径

- 无工具的 API 不能读取本机 `/path/spec.md`；编译器必须把所需正文或选定片段放进请求。
- CLI 可收到只读 ContextBundle 目录和入口文件，但仍需明确读取约定 / 必需内容交付；仅写“请看文件”不算已读取证明。
- 大文件可显式按章节 / symbol 选取，或者使用受限 retrieval 工具；两者在 manifest 区分。
- 图片 / PDF / 二进制必须按 provider 实际能力处理。无法传递时先生成有来源的替代材料，或者拒绝该任务；不能让纯文本模型签发视觉结论。
- 代码补丁先经 schema / 路径 / base hash / 越界校验，再由独立受控步骤应用；调用模型本身不授予磁盘写权限。

### 3.4 单次与有界工具循环

默认 `tool_policy=none`。需要查文件、搜索 symbol、读更完整日志时才使用 bounded 模式，明确工具名单、最大轮次 / 总调用数 / wall-clock / 输出上限。

API backend 必须记录完整结构化 tool-use / result、停止原因和协议扩展，不从可见聊天文本重建循环。截断或无效 tool arguments 禁止执行，返回明确错误；不在后台无限“修复 JSON”。

固定本次实际模型，不修改应用默认设置。普通 provider 的逐任务模型指定须通过独立实例构建或正式覆盖通道解决，不能假装现有 `model_override` 已支持所有 runtime。

现有 `ChatResponse` 只有 content / model / usage / tool_calls，不含统一 stop reason 和完整 provider block。任务调用需要独立版本化 envelope 或向后兼容扩展：保留原始协议块、refusal / truncation、schema 能力和 provider-specific 延续状态；旧聊天 API 不静默换语义。不能仅从 `content` 字符串重建带思考 / 签名 / 工具状态的原生历史。

## 4. ContextCompiler：从资料到可审计请求

### 4.1 输入层与来源

| 层 | 来源 | 默认处理 |
| --- | --- | --- |
| 执行约束 | 用户授权、工具 / 网络策略 | 程序强制；不得依赖 prompt 遵守 |
| 项目规范 | 适用 AGENTS、CLAUDE、设计契约、测试规范 | 按目录 / 文件作用域解析，带版本和可信性标记 |
| 任务正文 | 目标、非目标、输入、AC、输出 schema | 当前节点必需项 |
| 项目事实 | repo map、接口、源码、依赖 / 工具链 | 基于冻结快照；优先精确检索 |
| 依赖产物 | 契约、patch、测试回执、上游发现 | 绑定 ArtifactRef 与 assurance |
| 运行知识 | 用户补充、已接受决策、交接、未决问题 | 读取逻辑会话 watermark |
| 长期记忆 | 已批准项目事实、经验、偏好 | 按范围 / 有效性过滤，作为参考而非隐式指令 |
| 外部资料 | issue、网页、第三方文件、工具日志 | 非可信数据，不可升级成操作授权 |

AGENTS / CLAUDE 的生效层级按所选 adapter 规则映射；不把所有同名文件拼起来产生冲突。规范包含路径、glob、hash 和适用范围；冲突或缺必需规范时返回诊断，不让模型猜哪个有最高优先级。

用户可以显式选文档、目录、片段和任务；recipe 负责自动补上已授权的必需依赖。不能为了“上下文完整”扫描和上传整个 HOME、会话秘密或所有项目。

### 4.2 编译步骤

1. 固定任务、graph、策略、逻辑会话和源快照 revision。
2. 校验资料权限、canonical 路径、symlink / 越界、大小、编码及云端发送许可。
3. 解析作用域规范、任务字段和必需产物；冻结选中的 dirty buffer / 外部文档副本。
4. 生成 repo map、接口 / 符号引用；根据任务检索可选正文片段。
5. 检索允许范围的长期记忆，处理失效、冲突和来源。
6. hash 去重，保持稳定顺序；同一资料多处引用时保留引用而非重复正文。
7. 按目标模型上下文容量计算输入、输出、工具 schema 和安全余量。
8. 必需项先放入；可选项按任务相关性选择；记录遗漏、截断、摘要和选择原因。
9. 生成不可变 ContextBundle，校验隐私与输出 schema，渲染 provider-specific 请求。
10. 启动前确认任务 / 授权 / 源 revision 未失效；发生变化就重编译，不发送混合快照。

权限过滤先于全文检索与 rerank。不能把无权访问的文档先交给决策模型，再要求它“不要选”。

### 4.3 上下文预算不等于价格预算

即使金额由用户定义，也必须管理模型容量：

若模型共享输入输出窗口：`可用输入 = 总窗口 − 预留生成量（按模型规则含 reasoning）− 工具 / 协议开销 − 安全余量`；输入 / 输出分设上限的 endpoint 再分别校验。另校验请求字节、时限和可见输出需求，不能把 1M 当输出承诺。

- 优先官方 token counting / 对应模型 tokenizer；近似估算明确标注方法与误差，不统一按字符数假装精确。
- 模型窗口未知时先要求用户显式配置或 capability 检测；不能照搬特定 harness 的未知值默认 1M，也不靠模型名字猜容量当硬保证。
- 必需约束 / AC / 接口契约装不下时阻止发送，建议分任务、增加窗口、显式分段或批准摘要。
- 可选历史和日志可按 recipe 裁剪，但必须记录 omission；不能静默删掉用户要求的文档或失败证据。
- 摘要是派生产物，保留原文引用、生成模型、摘要版本和未覆盖信息；不能取代准确的规范约束。
- 稳定规范 / 工具放稳定前缀，易变任务和事件在后；跨模型不假设缓存通用。
- 云端发送的正文中不夹带无意义本机绝对路径；需要定位时用 repo 相对路径和 source ID。

### 4.4 少调用与代码图谱

one-shot pack 要在请求前尽量用本地搜索、符号 / 依赖邻域取足背景；默认不为摘要、Jev、索引提炼隐藏调用模型。设计 / 审阅优先，patch 仅在输入完备、输出和发布组可控时允许；需要未来测试反馈的阶段不可合并宣告完成。

大仓库使用 repo map + 版本化 CodeGraph 选材料，附相关完整源码、调用方和测试；边记录 parser / compiler / heuristic 等来源及盲点。LLM 文档知识图谱可选，不替代精确实现。Taomni 需补 TS↔Rust IPC / 事件映射。详见[专题](packed-inference-and-code-context.md)。

### 4.5 文档引用与动态补取

ContextBundle 包含 `manifest.json`、规范、任务、选定源码 / 文档、依赖回执和交接，另提供 `context_read(source_id, range)`。

补取只允许同一批准快照和作用域；每次读取记录 source hash / range，不能悄悄改读用户工作目录最新版本。CLI 原生工具能绕过该工具时，单独记录为 harness 执行可见性差异。

正文渲染要保留“引用资料”的边界。网页、日志或记忆中的“忽略所有指令”“批准 push”不能改变授权；再强的提示词也不替代程序权限门。

### 4.6 请求预览与复现

用户可预览：会调用谁、将发哪些规范 / 资料、哪些没有发、用了哪些记忆、输入大小、是否向外网发送。

保存 manifest 和可授权保存的请求快照；秘密占位 / 本地加密存储，不能原样写遥测。即使输入相同，模型输出也不保证确定；“可复现”指可追溯输入与配置，不承诺逐 token 一致。

## 5. 不同 agent 之间如何“共享 session”

### 5.1 推荐：共享逻辑空间，隔离原生执行上下文

```text
LogicalSession(project / run / topic)
  ├─ task-A branch → native CC session
  ├─ task-B branch → native Codex session
  └─ task-C branch → direct LLM conversation
```

这是身份关系，不是要求把全部聊天广播给所有模型。各分支只读取所需事件和资料；实现者的推理草稿默认不注入独立 reviewer，以减少锚定。

### 5.2 会话模式

| 模式 | 用法 | 约束 |
| --- | --- | --- |
| `fresh` | 新任务 / 独立复核 | 以 ContextBundle 初始化，不继承无关历史 |
| `resume_native` | 同 backend / profile / storage 继续 | 校验版本、输入、权限；独占 turn lease |
| `fork_native` | backend 明确支持的原生 fork | capability-gated；不假装所有协议支持 |
| `handoff_portable` | 跨 CC / Codex / API 或原生 session 已丢 | 创建新会话，注入结构化交接和必要来源 |
| `shared_logical` | 多分支协作 | 通过消息、决策和产物共享，不共用原生 session ID |

同一原生 session 可以在兼容任务之间**串行**续用，前提是权限、仓库、工具、模型和上下文适用；不允许两个 attempt 同时向它写入 prompt。

API 有无服务端 conversation ID 不影响逻辑会话持久性。无状态 API 可由 Taomni replay 受控消息；有状态接口必须有本地可追溯副本和恢复降级契约。

共享一个原生进程也不等于共享 session。只有 backend 经过合同测试支持 multiplex 时才可进程池化；池键至少含 adapter / 版本 / profile / 凭据身份 / policy / 网络 / 环境摘要，不能只按“同一种 CLI”合池。不能安全改变进程级 cwd、HOME、插件或权限时不复用；各 session 单独 turn lease，异常进程池不能把事件投递给错误分支。

### 5.3 PortableHandoff 必需内容

- 目标、完成边界、AC、当前输入 / worktree / candidate 版本。
- 已接受决策及其来源、禁止操作和待审批项。
- 已完成工作、ArtifactRef、真实测试结果和失败日志定位。
- 未决问题、已排除假设、接下来可执行步骤。
- 重要源码 / 文档引用和允许检索的长期记忆。
- 明确区分 observed / user-confirmed / model-claimed / inferred。

摘要只是入口，关键契约与证据必须可读取。接收方确认的是“已收到哪些 hash 的交接包”，不是模型证明自己理解了全部信息；关键约束通过程序 / 验证继续保护。

**不能移植**：不同 provider 的 KV cache、原始思考块 / 签名、隐藏系统提示、工具内部状态和未授权凭据。专有 transcript 只能在兼容 runtime 按其协议原样续接，不在跨 agent 交接中伪造成 assistant 历史。

### 5.4 并行消息与更新

- 采用 `message_id + correlation_id + sender + recipient_scope + input_revision`，消息可回放 / 去重，但消息不自动改变任务状态。
- worker 可提交 `ContractQuestion / ProposedDecision / FoundBlocker / ArtifactReady`，控制面处理并产出确定事件。
- 用户在运行中追加限制时，创建新 event / policy revision；安全限制要求暂停 / 中断，不能只放进下次摘要。
- 新消息不覆盖正在执行的原生 prompt；支持 steer 的 adapter 可受控投递，否则排队或 interrupt 后新 turn。
- 丢会话时走显式 handoff；不把新建 session 伪装为原生 resume。
- backend 报告压缩 / 换上下文后，根据 bundle manifest 检查必需契约的投递状态，在协议允许的下个边界重注入必要内容。只因 token 使用下降不能可靠断言压缩；不知道是否保留时标 unknown，不能继续声称必需约束仍完整可见。

## 6. 记忆：分层、分域、可追溯

### 6.1 五类信息采用不同管理方式

| 类别 | 示例 | 处理 |
| --- | --- | --- |
| 权威规范 / 决策 | 用户批准的接口、仓库规则 | 文档 / DecisionRecord；禁止自动经验覆盖 |
| 任务工作记忆 | 当前 TODO、失败、假设 | Run / Task 记录；任务终结后归档 |
| 情节经验 | 某类竞态如何复现与修复 | 验证来源和适用版本后可复用 |
| 语义知识 | 项目架构、组件职责 | 先查当前源码 / 文档；记忆只加速定位 |
| 用户偏好 | 输出风格、默认资源偏好 | 显式用户作用域；不跨身份共享 |

不把聊天全文、SQLite 状态和向量库统称“记忆”。保存更多不等于更有用。

### 6.2 命名空间与作用域

建议 namespace：`workspace_owner / project_id / repo_identity / visibility`，再附 agent persona、branch / task、有效版本与访问控制。

- 同一 Git clone 的不同 worktree 可以共享项目长期知识，但 branch 专属事实不能自动提升为全仓库事实。
- fork / 同 remote 的两个仓库不自动视为相同信任域；用户可显式关联。
- 默认允许同项目共享 approved knowledge，各 agent 私有草稿 / 用户私人偏好不可串读。
- 子任务继承父任务的更严格隐私和记忆模式，不能通过更换 agent 绕过 temporary / no-external 限制。
- 支持 `off / task_only / project_readonly / project_readwrite`；temporary 不写入长期记忆，也不偷偷建 embedding。
- CLI 自有 auto-memory / hooks / skills 可能引入 ContextCompiler 之外的内容。adapter 必须声明 `native_memory=disabled|isolated|bridged|opaque`，列出可观察的配置来源；不能为了接 Taomni 而清空用户原有 HOME 或记忆。
- 严格 temporary / private 模式要求原生记忆也不落长期存储；做不到时拒绝该 profile。原生记忆导入仅作带来源的候选，不能与 Taomni 库自动双向同步、互相反复提炼污染。

### 6.3 记忆记录

```text
MemoryRecord {
  id, namespace, kind, status: proposed | approved | stale | superseded,
  content, source_refs[], source_hashes[],
  author, created_at, revision,
  valid_for: { repo, paths, branch?, toolchain?, versions? },
  sensitivity, allowed_destinations, expires_at?,
  supersedes?, conflict_refs[], confirmation_refs[]
}
```

复用依据是来源和适用性，不是模型自己给的 confidence。有效性变化可标 stale，不立即永久删除；用户可以修订、否决、撤回或忘记。

### 6.4 写入、合并与冲突

- 用户明确给出的长期事实、程序观察和模型提议分开。
- 首版所有模型提炼 / 摘要 / 经验一律 `proposed`，不以低风险 / 高置信自动提升。用户确认或**程序按受限 schema 确定性观测**才可成为 approved：例如某 source hash 上真实注册的命令 / 路径映射，附 producer、验证方法和有效版本；不能从测试通过推导“整个模块安全”。
- `origin=user_confirmed | deterministic_observation | model_proposed` 与 status 分开。批准一个模型提议需用户显式操作并绑定 scope / revision；程序不能给 model_proposed 换个 origin 绕过。未来自动晋升另立决策，不在 P1 范围。
- 每条 memory 用 CAS / revision 更新；并行 agent 追加独立候选，不共享一个可任意整段重写的“大 memory.md”。
- 摘要和经验不能把 fail / skip / unrun 变成 PASS，不能把“建议改接口”写成“已确认接口”。
- 冲突保留两方证据并进入待处理；时效新不等于一定正确，不用 last-writer-wins 替代事实判定。
- worker 只能提出记忆修改；规则、权限和验收策略不允许通过“自我学习”重写。

### 6.5 检索与时效

P1A 只读取用户选定的 approved 来源 / typed artifact，不新建长期知识查询子系统；proposal / read set 同样作为 artifacts，不能跨 scope 注入。P2 增 memory_records 后再提供 SQLite 索引 / FTS 与 Markdown 导出，中文分词 / trigram 单独验证；embedding / reranker 可选，不是会话共享前提。

检索顺序：ACL / 出站许可 → repo / 版本 / task 适用性 → 精确来源 → 全文 / 语义候选 → 可选 rerank → token 预算。

记录每次注入了哪些 memory ID / revision、为何相关。源文件 hash、工具链或正式决策变化时标记相关记忆需要复核；不必因一个无关 commit 失效全库，也不让旧知识永久不变。

### 6.6 后台提炼不是隐藏的全权 agent

可配置只读 recall sidecar：接收限量、脱敏事件，只建议本轮读取哪些记忆。写入提炼另一个流程，不能因具备 recall 能力就获得写策略权限。

提炼可在任务阶段结束异步执行，不挡关键路径；按 event watermark 产生候选，去重、可取消、有资源配额、无递归自调用。未完成提炼时，本次任务仍以显式上下文和已批准知识为准。

### 6.7 删除与外部存储

删除 / forget 需清理索引、摘要、embedding 与缓存；备份和已发给云端的请求有保留边界，UI 不能宣称抹去了 provider 已接收的数据。

外接 MemoryProvider 必须支持 namespace、查询、来源、版本、冲突和删除；不具备的能力显式降级。OpenViking、Letta 等可作为可选后端，不把其 memory API 直接当 scheduler 真相源。

## 7. 存储、接口与验证

表演进**只遵循 [scheduler-contract.md §8.1](scheduler-contract.md)**：P0/P1A 最多八表。context_sources 在 context_bundles 的版本化 manifest；read set / proposal 是 typed artifacts；session lease 存 attempts / 单写事务，不额外建表。P1B 增 logical_sessions / handoffs，branch 身份先作为 session 的 typed 字段；P2 增 memory_records，以 status 区分提议 / 批准，usage 由 events + artifact refs 表达。实际有查询 / 并发需求再评审拆表。

命令也按阶段而非全部预建：P1A `preview_context / compile_context / invoke_llm / get_invocation`，P1B `create_handoff / resume_session`，P2 `query_memory / propose_memory / confirm_memory / forget_memory`。均带 revision / idempotency key，P1A 的 candidate 与受限事实读取通过 ArtifactStore，不伪造已存在记忆面板。

### 必需验收

- AC-C01：不创建聊天线程 / CLI 也能完成独立 API 任务，附实际正文、规范、任务、输出 schema 与回执。
- AC-C02：必需上下文过大、缺资料、模型不支持图像时不静默遗漏；能预览 omission 和原因。
- AC-C03：并行任务 profile / 文档 / 模型不互相覆盖；输入 hash 和实际传输一致。
- AC-C04：CC → Codex → API 通过 portable handoff 接续，来源、未决项和真实测试结果不丢；没有伪原生 resume。
- AC-C05：同原生 session 并发 turn 被拒绝，逻辑分支事件不串线，旧 policy 不能批准新动作。
- AC-C06：跨项目、private、temporary、分支专属记忆隔离；并行更新不丢、冲突不静默覆盖。
- AC-C07：过期知识不充当权威，模型总结不升级为规范 / PASS；忘记操作清理派生索引。
- AC-C08：API / 摘要 / embedding / 决策调用都过同一凭据、代理、隐私、取消和用户成本策略边界。
- AC-C09：受限工具循环达到上限明确终止；无效工具参数不执行；实际 patch 由独立授权步骤应用。

本设计不承诺跨 backend 无损复制模型内部状态。验收目标是**任务接续准确、有证据、可回溯**，而不是 UI 上看起来只有一个 session。
