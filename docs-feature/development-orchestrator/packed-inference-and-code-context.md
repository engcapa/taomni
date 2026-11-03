# 开发编排：少调用、大上下文与任务打包推理

- 状态：2026-11-03 v0.4 review 修订；分帧 / 显式首版范围已收敛，拟新增、未实测。
- 用户场景：部分 API 按次计费、可用约 1M 上下文，希望一次准备充分背景，一次完成多个相关任务的推理和输出。
- 关联：[主设计](../development-orchestrator-design.md)、[上下文 / 会话](context-session-memory.md)、[成本与选择](cost-and-selection-policy.md)、[协议契约](llm-protocol-contract.md)。

## 1. 必须把四种“批量”分清

| 模式 | 请求 / 上下文 | 适用性 |
| --- | --- | --- |
| **联合推理包 joint pack** | 多个相关目标，一份共享背景，一次模型请求，统一分析与分项交付 | 本次重点：架构设计、契约推导、跨模块一致性 |
| **同类多项包 homogeneous pack** | 多个相对独立条目，一次请求，按 ID 分项输出 | 同一规范下的小型审阅 / 分类 / 迁移建议，注意位置偏差和串项 |
| **Provider Batch API** | 上传 N 个独立请求，通常异步处理；不是共享一次推理 | 吞吐与延后执行；不保证按次网关只计一次 |
| **多轮 agent / tool loop** | 同一任务经过多次模型请求，获得运行反馈后继续 | 开放调试、环境探索、测试驱动修复；不等于一次调用 |

一个 HTTP 请求也不必等于一个计费单位：网关可能按内部生成、工具调用、重试或其他规则结算。`one_shot` 是 Taomni 可控的模型请求边界，实际账单单位由用户配置和服务条款决定，未知时明确显示 unknown。合包须符合账号 / 套餐允许用途、请求和限额规则，不用来规避服务条款或伪装未授权转售。

## 2. 推荐作为独立执行模式

增加 `InvocationMode`：

- `one_shot_pack`：准备完背景后只允许一个业务生成请求；默认无模型工具循环。
- `bounded_call_workflow`：严格少调用预算，例如一次综合设计 + 可选一次有针对性修订；UI 显示“有限调用工作流”。
- `interactive_agent`：有界 feedback loop；用户能看见每轮真实调用与原因。
- `provider_async_batch`：多独立请求的异步通道，明确计费 / 取消差异。

独立总预算同时约束 planner、Jev、摘要、embedding / rerank 和恢复请求。不能主任务说“一次调用”，后台先用十次模型收集上下文；本地搜索、解析和测试不是模型调用，但有其环境 / CPU 资源约束。

建议 UI 用“少调用模式”而不是“1M 模式”。窗口、输出上限、计费和一次推理能力是不同属性。

## 3. 哪些开发任务值得打包

| 场景 | 建议 | 背景 / 输出条件 |
| --- | --- | --- |
| 一个功能的架构 + IPC + 数据模型 + 错误语义 + 测试计划 | **优先 joint pack** | 同一需求和代码快照，共享契约，输出设计包与一致性清单 |
| 同一问题的方案比较 + 风险 + 迁移分期 | **优先 joint pack** | 完整约束与现状；未知点允许明确保留，不伪造调研结论 |
| 同一冻结候选的安全 / 生命周期 / 兼容性静态复核 | **可 joint pack** | 精确 diff、基线 / 候选、调用方和测试；多维自审不等于多名独立 reviewer |
| 同一规范下多个模块的差距盘点 / 测试清单 | **可 homogeneous pack** | 逐模块 ID、资料覆盖、分项输出和总输出上限 |
| 同一 API 变化的少量调用方 / fixtures / 文档同步 patch | **有条件可用** | 基线明确，完整目标文件和契约，修改可机器校验，应用后运行测试 |
| 独立小函数 / 独立新模块及测试候选 | **有条件可用** | 每项输入充分、输出短；可分别验证，不能隐含相互依赖 |
| 大规模机械 rename / schema 转换 | **优先程序变换** | 模型一次产出规则 / 计划，可信 codemod 在受控现场执行；不是让模型输出海量重复文件 |
| 不知道原因的 native crash、环境故障、复杂性能问题 | **不默认打包完成** | 需要真实运行反馈；可先打包诊断已有证据，后续转 interactive |
| 实现 → 跑测试 → 根据失败改实现 | **不能假装一次完整闭环** | 后两步依赖未来观测；一次只能输出候选，验证后才知道是否需再请求 |
| 互不相关项目、不同隐私 / 授权、不同模型 pin | **禁止自动打包** | 不能为了省次数混合信任域、改变用户资源选择 |

**结论：不是“设计能打包、patch 一律不能”，而是看输入完备、输出容量、反馈依赖与失败半径。**

## 4. 打包准入：不是把所有 ready task 拼起来

### 4.1 硬约束

只有同时满足才进入 pack：

1. 相同授权 / 出站数据域，兼容的模型 pin、协议、能力和参数。
2. 资料来自同一基线，或每项独立快照明确标识且没有混淆风险；首版推荐同仓库 / 同快照。
3. 全部外部依赖已满足；包内仅允许纯推理子步骤，不跨真实测试、审批、Git 应用或网络观察门。
4. 验收没有要求执行者独立、blind review 或不同模型；此类职责不可融合。
5. 不能消费另一项尚未实际产生的运行结果；可以在一份设计中先定义接口、再推导调用方，但不能宣称已跑过调用方。
6. 合并后的必需输入、预留输出、推理 / 协议余量和 HTTP body size 均适配实际 endpoint。
7. 共同失败和等待时间可接受，未超过用户 `max_items / max_wait / output_limit / recovery_budget`。
8. 子项修改边界 / patch 原子单元可定义，不能由同一包里的两项各自覆盖同一文件却无组合规则。

“semantic 相似”只用于排序，不能绕过硬约束。用户手工建 pack 也必须校验，不能用手工选择跳过权限。

### 4.2 组合策略

- 优先共享目标、契约、source 集合和预期输出结构的任务。
- 用本地 source overlap、TaskType、依赖关系先筛；不为每一对任务都调用 Jev。
- joint pack 中紧耦合目标按共享契约组织；homogeneous pack 保持每项隔离和稳定 ID。
- 与不打包方案比较一次等待、输出截断、返工成本，不按“打满 1M”优化。
- 设 flush 条件：达到输出 / 输入边界、最长等待、deadline、用户点击立即执行即封包；低流量任务不无限等凑批。
- 第一个版本优先用户显式打包 + 明确模板；自动 pack 建议在收集真实行为后再启用。

### 4.3 数据对象

```text
InferencePack {
  id, revision, mode: joint | homogeneous,
  member_tasks: [{ task_id, generation, output_contract, required_sources }],
  effective_profile_ref, input_snapshot_refs,
  shared_context_ref, per_task_context_refs,
  output_manifest_schema, publication_groups,
  call_budget, retry_policy, authorization_ref
}

PackCallAttempt {
  id, pack_id, member_attempt_ids[],
  compiled_request_digest, effective_model, endpoint,
  status, request_id?, billing_observations[],
  stop_reason?, result_manifest_ref?, validation_results[]
}
```

原子 claim 全部成员 task generation，事务创建 member attempt 与 PackCallAttempt；一条模型生成请求占一个实际请求 slot，每个成员仍保留任务身份和验证责任。成员不能同时被单独派发。

共享费用只记一次，成员归因可按用户规则分摊，所有分摊相加不得大于实际 pack 用量；不对每个成员重复记完整请求费用。

## 5. 一次准备充分，而不是盲目塞满

### 5.1 前置取证，不依赖模型再问

`one_shot_pack` 开始请求前做 `ContextReadinessCheck`：

- 需求、规范、目标版本、任务列表、AC 与交付 schema。
- 相关接口、调用方 / 被调用方、状态 owner、取消 / 清理路径。
- 相关完整实现、配置、测试、已知失败证据和历史约束。
- 明确已读与未覆盖区域；缺少必需项就 block / 用户批准缩小范围。
- 补取尽量使用本地 parser、搜索、LSP / 索引，不先用模型反复探索或压缩。

即使窗口大也保留 allowed-destinations、秘密过滤、资料版本和隐私边界。低边际 token 成本不是上传所有代码 / 私人历史的理由。

### 5.2 输入与输出分开预算

不能把“1M 上下文”当“能输出 1M”：

- capability 分别记录 `max_input / context_total / max_generated / visible_output / request_bytes` 等实际已知值。
- 对共享输入输出窗口，输入 + 预留生成量 + schema / 工具 / 余量必须小于总窗口；生成量包含按模型规则计入的 reasoning，不能只预留可见文本。
- 对分别限制输入 / 输出的 endpoint，按各约束检查，不强行套同一公式。
- 只按模型 ID 推断不够，网关还可能有更小 body、输出和时限。
- 输出大小往往先成为 patch pack 瓶颈；拒绝“输入装下就能合批”的判断。
- 请求前估算每项可见输出 + NDJSON 转义 / header 开销 + shared item + 终帧 / 保守生成余量；使用 endpoint 已知的 16K / 32K / 64K 等实际限制，不从 1M 推导输出能力。未知上限则要求用户补配置或拆小。
- 设计正文和 patch 都给明确长度 / byte / item 预算；超限在发送前拆包，拆成多次请求必须更新调用预览，用户不允许增加调用时只能减少本次范围而非静默多发。

不硬编码“必须使用 80% / 90% 窗口”。按 recipe 做背景充分性和任务覆盖，在同等充分性下减少噪声。

### 5.3 推荐请求布局

在受信系统 / developer 约束保持正确层级的前提下：

1. 资料目录和 source manifest：每份资料的 ID、hash、作用域。
2. 共享规范 / 背景文档 / 项目 map / 必要实现，稳定、去重。
3. 每项任务专属源码、日志与资料，使用 ID 关联共享来源。
4. 任务目标、交付矩阵、依赖 / 一致性约束。
5. 输出契约、覆盖检查和阻塞报告规则。

长文档的定位、索引和清晰 metadata 比裸拼接更重要。最终任务清单靠近生成位置，关键约束可在清单重申但不制造互相冲突副本。具体布局按模型 recipe 验证，不宣称跨厂商唯一最优。

不要求暴露隐藏思考；要求结构化结论、来源、假设、未决问题和分项覆盖。若 prompt 要求先分析再统一输出，仍不能把这个过程记录成多个真实节点已分别验收。

## 6. 大代码上下文：代码图选材料，源码作证据

### 6.1 四个层次

| 层次 | 优点 | 不能承诺 |
| --- | --- | --- |
| 全量授权源码 | 保留所有实现；小仓库简单可行 | 大窗口不保证注意力 / 推理充分，依赖 / 生成物可能淹没有效信息 |
| Repo map / 符号大纲 | 紧凑全局导航、文件 / 接口位置 | 同名引用 / parser 规则可能不精确，不是完整调用证明 |
| 静态 CodeGraph | 定义 / 引用 / import / 调用 / 类型 / 实现关系，用来扩展邻域 | 动态派发、反射、FFI、多语言字符串桥接不自动完备 |
| LLM 文档知识图谱 | 把设计、issue、概念和经验联系起来 | 关系可能推断 / 幻觉，构建也需模型调用；不能替代精确代码事实 |

推荐先做 **repo map + 轻量 CodeGraph + 精确文本 / symbol 搜索**；需要时接 SCIP / language-specific 索引。LLM GraphRAG 后置且可选，不是少调用模式的必需预处理。

Taomni 已有可复用导航：`src-tauri/src/lsp/navigation_commands/locations.rs:25` / `:93` 的 definition / references，`src-tauri/src/lsp/navigation_commands/symbols.rs:15` 的 document symbols；它们依赖活动 LSP，不等于完整后台索引。`src-tauri/Cargo.toml:107` 的 tree-sitter 目前用于 Java structural search，不能宣称已支持 TS / Rust 的 repo graph；新增 grammar / indexer 要有独立 owner、快照和资源限制。

### 6.2 CodeGraph 最小契约

节点：repo / file / symbol / type / module / config / test / IPC endpoint / doc anchor。

边：defines / imports / references / calls / implements / configures / invokes_ipc / emits / listens / tested_by / documents。

每条边保存 source range、file hash、extractor / version、build config、精确度 `compiler_resolved | parser_derived | heuristic | model_proposed`。查询命中不能把 heuristic 当 compiler truth；缺边不证明无依赖。

Taomni 特别需要 TS `invoke` ↔ Rust command 注册、事件 emit ↔ listen、serde DTO / 配置字段映射。LSP 单语言索引不会天然贯通这些字符串连接；用显式抽取规则与 native contract tests 补齐。

索引绑定 source snapshot 与构建配置；dirty 覆盖另建 overlay，不用主分支旧索引指向新内容。缓存按内容 hash 验证，不能只依赖 mtime。

### 6.3 一次性代码包 recipe

- **设计**：全局 map + 目标模块完整实现 + 接口邻域 + 生命周期 / 配置 / 测试规范。
- **静态审阅**：diff + base / candidate + 上下游 + 测试 / 迁移 + 已知风险；不导入实现者全部自辩。
- **Patch**：完整目标文件 + 修改相关符号邻域 + 精确接口 / fixtures / 测试；外部调用方必要处展开。
- **小仓库**：授权且输出 / 请求限制适配时可提供全码，仍排除无用构建产物和秘密。
- **大仓库**：先本地多跳扩展，再在宽上下文下给足相关正文；graph 提供导航，不把图摘要当全部背景。

每项有 `required_sources / included_sources / known_gaps`。没有覆盖完整实现不自动宣称“全仓架构审计”。

## 7. 输出、补丁和部分结果

### 7.1 默认分帧，逐项验证，不用一个大 JSON 承载多份产物

`PackResult` 保留为 **host 根据帧计算的投影**，不再要求模型输出包住全部正文的顶层 JSON。多文档 / 多 patch 默认 `ndjson-v1`：每个物理行是独立 JSON record，正文换行为合法转义；每条记录分别 parse / schema 验证，不能只给流最外层套 schema。

```jsonl
{"type":"pack_start","version":1,"pack_id":"p1","input_digest":"host-input-id","expected_ids":["A","B"],"publication_groups":["g1"]}
{"type":"item_header","item_id":"A","group_id":"g1","source_refs":["src-1"],"format":"markdown"}
{"type":"item_chunk","item_id":"A","seq":0,"text":"第一节正文\n"}
{"type":"item_chunk","item_id":"A","seq":1,"text":"第二节正文\n"}
{"type":"item_end","item_id":"A","chunk_count":2,"status":"candidate"}
{"type":"item_header","item_id":"B","group_id":"g1","source_refs":["src-2"],"format":"patch"}
{"type":"item_chunk","item_id":"B","seq":0,"text":"受约束的 patch 正文"}
{"type":"item_end","item_id":"B","chunk_count":1,"status":"candidate"}
{"type":"group_end","group_id":"g1","item_ids":["A","B"],"constraint_refs":[]}
{"type":"pack_end","item_ids":["A","B"],"blocked_ids":[]}
```

这是分帧格式示意，不是可直接应用的 patch fixture。若 B 截断，A 的 item_end 已闭合即可保存候选，g1 未完整则不能发布。pack ID / digest / 预期成员由 host 对照验证，不相信模型回填；hash / 实际 byte count 由 host 对收到的正文计算，不要求模型算 hash。

- 块级 chunk 默认最多 8 KiB UTF-8 正文，单 record 原始上限 64 KiB；均为实现防护默认，可在本地 profile 缩小，不是模型天然保证。超过上限明确 invalid，不无界分配内存。大 patch 分多 chunk，完整 item_end 后才做 patch 语义校验。
- P1A 只顺序输出一个 item 的 chunks，不支持帧交错 / 任意并行；item ID、seq、chunk_count、source refs、format 都有 host 验证。重复 / 非法记录隔离并记录 offset，不悄悄跳过，也不覆盖之前保存的候选。
- provider SSE / content blocks 是外层传输，application NDJSON 是内层输出；先解协议块、按 output / choice 分流，再缓冲不完整物理行。HTTP chunk / SSE delta 可以从 JSON 任意字节处分开，绝不能按 delta 直接 parse JSON。
- item 通过 schema / 来源 / 输出契约后持久化为 `candidate_saved`，`artifact_received` 事件提交后才通知 UI；不能等整个 pack_end 才保存前面产物。
- shared_decisions / 跨项约束单独作为必需的 shared item，后续项引用；`group_end` 关联必需 shared item 和所有成员。joint pack 默认一个发布组，homogeneous 可预先声明独立组；group 不能由模型临时拆小来绕门。
- coverage 由 host 计算：expected / complete / blocked / invalid / missing，以及 groups 完整性、provider 终态，模型清单只是待核对输入。

单条短结构结果仍可用 provider strict JSON schema；NDJSON 多 record 默认不是各厂商通用 strict-output 能力。endpoint 明确支持逐帧结构约束才标 strict-frame；否则 prompt-framed + host 校验，并显示保证等级。若用户要求 server-strict 而 endpoint 只有单 JSON，则改小单项包 / 拆请求并明确次数，**不透明降级**。

可选 `framed-blocks-v1` 使用 host 生成的随机边界、独立 JSON 头和 raw body，正文 marker 行必须转义，head / end / seq 和大小都要验证；不让模型生成 byte-length 作为解析依据。P1A 只实现 NDJSON 一种解析器，这个备用格式留后续，不同时造两套协议。

### 7.2 Patch 可行，但必须收紧发布边界

- 首版显式 / 模板 patch pack 总计 **≤3 个去重后的文本文件（含测试文件）**，且每项均有完整输入、base hash、有限 edits。3 个大文件仍可能超限，另过 byte / output 预算；这是首版产品范围，不是质量充分条件。
- 限定目标路径、每文件 base hash、允许修改范围和最大变更规模；不含二进制、生成物、依赖安装、lockfile / 大迁移更新。超范围转人工批准的新计划，不自动扩写。
- 输出统一 diff 或结构化 edits，禁止模型通过任意 shell 命令“交付补丁”。
- 在隔离 candidate 验证 patch 是否能应用、是否越界、重叠、包含不允许的文件 / 二进制；禁止 fuzzy apply 悄悄改错位置。
- 多文件共享契约默认一个 publication group，全部适用才发布；独立项只有预先声明可分离才能拆开。
- 应用后运行类型检查 / 单测 / native gate；一请求可生成“代码 + 测试候选”，不能生成“测试确已通过”的事实。
- 同次模型自审可帮助发现问题，但不能当独立复核；需要独立门时不能为了省调用取消。

### 7.3 截断、串项和补救：保留前项，不误报整包成功

- EOF、invalid record、max output、缺终态、refusal 分别记录。持久化的完整项保留 candidate，末尾半行 / 半 item 保存原始诊断，不补括号 / 猜转义 / 伪造 item_end。
- `candidate_saved` ≠ task produced ≠ 发布 ≠ gate PASS。首版即使某 group 已闭合，provider 终态异常 / refusal 时仍冻结自动发布，交给用户处理；不能用分帧绕过安全拒绝。
- 同一 joint publication group 缺少共享约束 / 其他成员时整组阻塞，但已收产物不丢。预声明 independent group 可单独校验，是否接受仍遵从用户门和真实 gate。
- 恢复请求包含旧 pack / snapshot / 已完整项 hash、所需 shared constraints 和失败成员；恢复只生成缺失项，不重发全部已完成正文。不盲选“最后第 N 项”：若共享约束本身未完成或前项依赖不成立，要扩展恢复范围或拆包并说明原因。
- 用户确认一次后创建新 recovery invocation（不得伪装原请求免费续流），`recovery_generations += 1`，更新请求预留与 pack revision。patch 合并前核对旧 candidate / source hash，禁止旧新包混写。
- 默认 main=1、auxiliary=0、recovery=0；截断弹出“已保存 N 项；是否允许最多 1 次补救，预计范围 / 费用为……”。拒绝或关闭保留现场，不自动消费额度。
- 单个坏 record 不删除先前项；P1A 对坏记录之后内容只留 raw 诊断，不承诺任意位置自动 resync。保住有效前缀足以解决末尾截断，不为 salvage 添加复杂容错引擎。
- 严格预算也禁止 SDK / router 透明重试、工具续轮和“JSON 修复请求”。网络结果未知先查询可取回的原 response；不可恢复则标 unknown，不能安全重发假象。

## 8. 调度集成与取消

- pack 是调用优化单元，不取代 TaskNode / generation / gate。
- preparing 阶段 claim 成员并冻结背景；发送前取消单项可重新封包并增加 revision。
- 发送后不能从一个生成请求里物理取消某个子任务。默认单项取消只撤销其自动发布资格，说明请求仍在进行；整包取消才请求停止上游。
- 如果隐私 / 授权撤销要求立即停出站，按整包停止；已经发给 provider 的资料不能收回。
- input、member 或 policy 改变，旧结果按版本隔离，不能混到新包。
- 接收中逐完整 item 落盘 candidate；完整 / 恢复后的 provider 终态及成员覆盖验证后，才按 publication group 提交 task produced，gate 另行执行。模型仍在输出时，前项可查看但不能自动应用。

## 9. 与业界公开方法的关系

- [Batch Prompting，EMNLP 2023](https://aclanthology.org/2023.emnlp-industry.74/)研究多条样本同 prompt，有实验证据但任务为 QA / 推理 / NLU，不是当代 1M 全仓开发保证。
- [BatchPrompt，ICLR 2024](https://proceedings.iclr.cc/paper_files/paper/2024/hash/5d8c01de2dc698c54201c1c7d0b86974-Abstract-Conference.html)指出批大小 / 顺序影响；其多次洗牌投票也消耗额外调用，不可直接用于严格一次模式。
- [OpenAI Batch](https://developers.openai.com/api/docs/guides/batch)是独立请求异步通道，不是这里的联合推理。
- [长上下文官方建议](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices)强调文档位置与结构；[context window 文档](https://platform.claude.com/docs/en/build-with-claude/context-windows)明确大容量不代表越多越好。
- [Lost in the Middle](https://aclanthology.org/2024.tacl-1.9/)和[NoLiMa](https://proceedings.mlr.press/v267/modarressi25a.html)说明评估不能只看标称窗口 / 简单 needle retrieval；这些历史模型结果不作为当前模型的固定性能上限。
- [Aider repo map](https://aider.chat/docs/repomap.html)、[SCIP](https://github.com/sourcegraph/scip)、[Sourcegraph precise code navigation](https://sourcegraph.com/docs/code_navigation/explanations/precise_code_navigation)是代码导航依据；[GraphRAG](https://microsoft.github.io/graphrag/query/overview/)定位不同，其 global 查询可能包含多轮 map-reduce。

本方案是上述通用技术与用户按次计费约束的组合设计，不宣称业界已有一个验证过的“1M 一次完成所有开发”标准。

## 10. 验收与上线

- AC-P01：one_shot_pack 只有一个业务生成请求；所有隐藏摘要 / 决策 / 重试可见且受总预算约束。
- AC-P02：不把 Provider Batch 的 N 请求算作一次，不把 TCP / SSE 重连自动当免费恢复。
- AC-P03：相同背景去重，分项输入和输出完整；必需 source 不因输出预算被悄悄遗漏。
- AC-P04：独立 reviewer、外部门、隐私 / pin 不兼容、输出超限的任务不能被自动融合。
- AC-P05：联合 patch 绑定 base hash、范围和 publication group；真实 gate 在执行后产生，不采信模型自报 PASS。
- AC-P06：截断 / 缺项 / 网络未知不伪成功，补救有限且明确增加调用。
- AC-P07：CodeGraph 版本、边精确度和覆盖缺口可核查；图不能取代必要源码。
- AC-P08：成员并发 claim、取消、重规划和费用分摊无重复 / 串线。

P1A 先依次通过设计 / 静态审阅分帧验收，再在同阶段 gated 开放显式 ≤3 文件 patch（未过测试时保持禁用，不影响纯文档包）。无自动合包 / 无透明补救；自动建议 P2 后再评估。

新增 V-PF01～05：任意 TCP / SSE 分块（含中文 UTF-8、转义、换行）；第 N 项半行 / 半 item / length；第 N 项转义非法；重复 ID / seq / 超长记录；A candidate 提交后进程崩溃与重启恢复。逐项断言前 N−1 完整项磁盘 hash / candidate 保留、坏项未发布、共享组阻塞、无附加模型请求，用户批准后仅一次明确恢复。

用真实任务集比较分开 / joint pack 的覆盖、错误耦合、缺项、返工、时间和实际收费；未运行前不承诺节省比例。
