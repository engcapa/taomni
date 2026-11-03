# 开发编排：OpenAI / Anthropic 协议兼容契约

- 状态：2026-11-03 v0.4 review 修订；先行codec拆分与分帧兼容已明确，目标契约不代表现有传输已满足。
- 关联：[直接调用与上下文](context-session-memory.md)、[打包推理](packed-inference-and-code-context.md)、[成本策略](cost-and-selection-policy.md)。
- 原则：**协议、服务商、模型、计费、执行器是不同维度**；“OpenAI-compatible”不能代替功能合同测试。

## 1. 首版正式支持的协议族

| Protocol ID | 典型路径 / 数据 | 必须正确处理 |
| --- | --- | --- |
| `openai_chat` | `POST /v1/chat/completions`；messages / choices | tools / tool_calls / tool message，finish_reason，SSE chunks，usage，response_format 能力 |
| `openai_responses` | `POST /v1/responses`；input / output items | function_call / function_call_output，事件类型、completed / incomplete / failed、response ID、text.format、状态恢复能力 |
| `anthropic_messages` | `POST /v1/messages`；system / messages / content blocks | tool_use / tool_result、stop_reason、SSE block 生命周期、usage、版本 / beta 头、结构化输出能力 |

同一个第三方网关可按模型选择不同协议；同模型不同 endpoint 也可有不同功能 / 上下文 / 计费约束。用户必须能手工指定并覆盖目录映射，保留来源，不靠模型名猜。

Provider Batch、模型列表、token counting、files upload、provider-managed background / retrieval 是**附加 endpoint 能力**，不是以上三个生成协议必然支持的组成部分。

不把 OpenAI legacy `/completions`、Anthropic legacy completion、Assistants、Azure、Bedrock、Vertex 当成改 base URL 就兼容。后续有实际需求时独立 transport / auth adapter；现有 Google 分发能力保留，但不挤入这三个协议的字段。

## 2. 当前 Taomni 的复用与缺口

| 位置 | 已有 | 编排必须扩展 |
| --- | --- | --- |
| `src-tauri/src/llm/openai_compat.rs` | Chat Completions、文本 / 图像 / tools、SSE | stop / refusal、usage 细项与流结束、structured outputs、参数能力、完整恢复语义 |
| `src-tauri/src/llm/anthropic.rs` | Messages、工具、SSE | stop reason 与扩展 content block、累计 usage、缓存 / 推理字段、版本与可选参数支持 |
| `src-tauri/src/llm/opencode_go/responses.rs` | Responses request / response / 流式事件映射 | 从 Go 专用分发中形成通用传输；不能只扁平化为文本和 tools |
| `src-tauri/src/llm/opencode_go/mod.rs:105` | 按模型分派 chat / messages / responses / google | 共享已验证 codec，保留现有 Go headers / session / 协议覆盖和老 provider 行为 |
| `src-tauri/src/llm/mod.rs:172–210` | 简单请求、文本结果、基本 usage | InvocationRequest / Receipt + typed blocks + 终态 / 能力，不靠现有 ChatResponse 表达全部协议 |

分层建议：`llm/protocols/{chat,responses,messages}` 管 wire codec；`llm/transports` 管 HTTP / auth / SSE / deadline；`orchestration/invocations` 管任务、预算、资料和产物。不能让通用 codec 反向依赖 Go provider 或 ChatDrawer。

### 2.1 先提取 codec，再扩展语义

本轮 `main@3fb5b06d9` 重新数行：`openai_compat.rs` **573**、`anthropic.rs` **433**、`llm/mod.rs` **297**，不是 review 所述 mod.rs=731。复杂度风险仍成立：前者已过 500 审视线，不能继续内联所有新能力。

先建立旧行为 golden / split-stream fixture，再按以下固定落点拆分；每个新文件目标 200–400 行，较小 facade 不为凑行扩写，800 为硬上限：

| 文件（拟新增） | 责任 / 保留面 |
| --- | --- |
| `llm/openai_compat/{request,stream,wire_types}.rs` | 原 builder / tools / 图像 / headers、SSE、wire DTO；父 facade 保留公开构造 / trait 和 re-export |
| `llm/anthropic/{request,stream,wire_types}.rs` | Messages / tools 编解码、content-block SSE、wire DTO；父 facade 保留旧 API |
| `llm/protocols/{mod,chat,responses,messages}.rs` | 规范化适配；Responses 可复用 Go codec，但不得反向依赖 Go 实现；大文件按职责继续拆 |
| `llm/invocation/{mod,request,receipt,capabilities}.rs` | 新请求 / typed blocks / 终态 / usage / 能力，不堆进 llm/mod.rs |
| `llm/invocation/tests/{chat,messages,responses}.rs` | 目标语义、协议参数与任意分块合同；fixtures 独立且受行数检查 |

父 `llm/mod.rs` 仅加模块出口 / 兼容 re-export；先通过行为等价检查再补新语义，不能以“顺便修 streaming”混过纯提取回归。`chat/stream/provider.rs:216–231` 的工具循环确实 `stream:false`：这是当前聊天的非流式 tool loop，不在 P1A 顺带改成 streaming；新直接调用走独立 invocation 的流式路径，禁止仅把此字段改 true 便声称工具增量 / typed blocks 完整。

具体 TASK-OR01 / 05 和保留行为验收见 [p0-p1a-implementation.md](p0-p1a-implementation.md)。

## 3. 配置模型：共享endpoint，而非逐任务表单

EndpointProfile是Settings内**可被多个任务复用的执行资源**。用户日常不重填协议 / URL / key / 系数；统一开发方案引用resources，任务提交时固定revision和digest。高级能力不必常驻主界面；保存 / 取消 / 旧任务快照遵循[v0.6 UX](developer-agent-ux-v0.6.md)。

```text
EndpointProfile {
  id, revision,
  protocol, api_version?, base_url, path_policy,
  auth_ref, header_refs, proxy_policy_ref,
  model_binding,
  capability_ref, parameter_policy_ref,
  billing_profile_ref,
  data_policy_ref, deadline_policy_ref
}
```

- auth 明确 Bearer、x-api-key、官方 OAuth / 云凭据或用户配置的网关鉴权方式；协议和鉴权不是一对一。
- base 与 path 使用明确规范化契约，测试 `/v1` 是否已包含；不能产生 `/v1/v1` 或悄悄改到另一个路径。
- 自定义 header secret 只引用 Vault；日志脱敏。不能让 prompt / repo 文件注入 auth / proxy / host。
- 重定向不得把密钥自动转发到不同 origin；更换 destination 需要出站策略校验。
- app / custom / none 代理严格解析；无代理禁系统 / 环境隐式 proxy，配置失败不直连。
- 参数 override 有 schema 和保留字段，禁止透传覆盖 model、messages / input、tools、stream、认证等已冻结字段。

## 4. Capability：已知、不支持、未知都要表达

按 `(endpoint revision, model, protocol, API version)` 维护：

- max input / context total / generated output / reasoning 规则 / request bytes / timeout。
- text / image / document 等模态，附件实际编码方法。
- tools / parallel tools、工具流式参数、strict input schema。
- structured output schema 子集；JSON mode 与 strict schema 区分。
- streaming、stream usage、stop/refusal 字段、response lookup / resume / cancel。
- optional temperature、max tokens 字段、reasoning / effort、cache controls、store 设置。
- server tools、自动模型 fallback、内部请求 / 计费可见性。

能力来源分 manual / live catalog / documented / contract-tested，记录时间与版本。自动探测需要真实调用或费用时必须显式授权；不能为查能力每分钟发送 prompt。

用户手填 1M / 按次费用可以作为配置来源，但不是网关已经证实可用；预览显示“用户声明，未验证”。

## 5. 请求与结果规范化，不降成最小公分母

### 5.1 统一语义层

请求保留 task / context bundle、逻辑 session、执行 / 输出 policy，再由 protocol renderer 生成 wire：

- 受信系统 / developer 约束与用户资料分层。
- 文本、图像、文档引用、tool use / result 等 typed parts。
- 工具名、输入 schema、输出 schema、生成上限和模型原生参数。
- 原生 continuation ref 及兼容历史，不能跨协议复制隐藏思考 / 签名。
- provider-specific extensions 由明确 typed 区管理，不泄露为所有 provider 的通用参数。

### 5.2 Receipt

```text
InvocationReceipt {
  invocation_id, attempt_id, protocol, endpoint_revision,
  requested_model, effective_model?, request_id?, response_id?,
  status: completed | tool_required | incomplete | refused | failed | cancelled | unknown,
  stop_reason_normalized, stop_reason_raw?,
  content_blocks[], tool_calls[],
  usage: { input?, cached_input?, cache_write?, output?, reasoning?, raw? },
  schema_validation, native_continuation_ref?,
  provider_extensions?, artifact_refs[]
}
```

`output` 与 `reasoning` 的关系按 provider 定义；reasoning 常是 output 的子集，不能一律相加重复计费。usage 为累计还是 delta 在 codec 标准化，账本按 request ID 去重。

保留 protocol-specific 状态供同 backend 合法续接；未知 content type 可保存到受控原始块并标记，不因只认识 text 而忽略重要 stop / tool 信息。

## 6. 三种协议的关键差异

| 行为 | Chat Completions | Responses | Anthropic Messages |
| --- | --- | --- | --- |
| 主输入 | messages | input items + instructions 等 | messages + system / content blocks |
| 主输出 | choices[].message | output[] typed items | content[] typed blocks |
| 工具回复 | role=tool，关联 tool_call_id | function_call_output，关联 call_id | tool_result，关联 tool_use_id |
| 结构化输出 | response_format（按模型 / 网关支持） | text.format | output_config.format（按模型 / 网关支持） |
| 流 | data chunks + 常见 [DONE] | 命名 / typed response events | message / content_block / delta / stop |
| 正常 / 截断 | finish_reason；length / tool_calls / refusal 等 | status、incomplete_details、error / refusal item | stop_reason；end_turn / tool_use / max_tokens / refusal 等 |
| 原生状态 | 通常由客户端保留消息；部分扩展另议 | previous_response_id / conversation / lookup 等能力 | 通常由客户端保留 blocks；其他会话扩展另议 |

表只描述常用路径，不保证所有模型和网关完整实现。参数支持按能力判断，不把 `max_tokens / max_completion_tokens / max_output_tokens` 混成一个任意发出的字段。

状态存储、retention / store 配置按 endpoint 的实际规则显式设置；不依赖服务默认值来保护隐私。有 response ID 不意味着能离线恢复或免费取回。

## 7. 流式、超时与请求恢复

1. 增量 SSE parser 正确处理任意 TCP 分块、多行 data、心跳、UTF-8 边界、多个 content / choice index。
2. HTTP 200 后仍可能有 stream error；收到文本不代表调用成功。
3. 等协议明确终态和必要 final metadata；连接 EOF 且无终态是 incomplete / unknown，不自动合成 completed。
4. 流 usage 可能迟到 / 累计 / 缺失，不能在每个 delta 重复累加。
5. 工具参数未完整解析 / 校验前不执行；one-shot 模式遇到 tool_required 按 policy 阻塞，不能自动再发一轮。
6. 长上下文请求配置启动 / 首包 / idle / 总时限，长时间计算不能被默认短 timeout 误杀，也不能无限等。
7. 断线只有官方接口确实可查询 / 续接时才走恢复；SSE 自动重连不是通用幂等保证。
8. SDK / transport / router 的自动重试开关集中管理，按次和硬少调用模式默认禁止结果未知后的透明重发。
9. 取消本地流、远端生成取消、账单停止分别记录；没有 server cancel 能力不伪造。

大输出解协议流后交 application-frame parser，完整 item 独立保存 candidate，不再等末尾闭合大 JSON；终态 / 发布组门通过后才发布。SSE delta 不是 NDJSON 行；“流式 token 很多”不代表越过输出上限。

## 8. 结构化输出与少调用保护

- provider schema-constrained output 与工具 strict input 分开，不用伪造一次强制 tool call 替代返回 schema。
- 本地 JSON parse / schema 验证始终执行；strict schema 保证语法不保证事实和任务覆盖。
- 单结构结果 strict 与多产物 NDJSON 分帧是不同 output mode。多文档 / patch 默认 NDJSON + 每帧 host schema，保留前缀候选；只有 endpoint 明确支持才声明 server-strict-frame。要求 server-strict 单 JSON 的任务不可静默换 NDJSON，应预览改小 / 拆请求和调用数。
- schema / grammar 编译的服务端限制、首请求延迟和缓存按协议处理，不因兼容网关报错自动换 text 模式。
- refusal、max output、incomplete、未知格式保留，不通过隐藏“修复 JSON”请求破坏 call budget。
- pack 的成员 ID、source 引用、输出覆盖由 host 校验，不能只依赖 schema 的数组长度。

## 9. 兼容测试与实施顺序

### 9.1 合同测试

每种协议至少覆盖：普通 / streamed text、图片实际传递、tools / tool results、多块 / 并行工具、structured output、拒绝 / 截断 / failed、流中 error、EOF、usage、代理三模式、取消、版本 / 不支持参数、base path、出站重定向、重复请求防护。

使用固定官方形状 fixture + 本地假网关；兼容网关逐 profile 记录合同结果。fake pass 不能代替真实服务连通与行为验证，真实请求需用户授权。

### 9.2 验收

- AC-L01：三个协议都能独立配置 / 调用，不通过 Go provider 伪装唯一入口。
- AC-L02：实际 model、auth / proxy、输入模态和 schema 与预览一致，无静默改协议 / 降级。
- AC-L03：正常、工具、拒绝、截断、流中错误和未知终态完整区分。
- AC-L04：完整结构化历史能同 backend 续接；跨 backend 只能显式 portable handoff。
- AC-L05：usage 累计和缺失不造账；隐藏重试 / fallback 在少调用模式受控。
- AC-L06：旧聊天 / Go 分发与协议覆盖、headers / session 仍兼容，必须过既有回归。

先旧行为 fixture → request / SSE / types 提取并过回归 → 独立 Receipt / 三协议映射 → one-shot 分帧。大小 / boundaries 检查和聊天 / Go 回归各自验收，不能只凭新模块编译通过。

## 10. 官方核查来源与界限

- [OpenAI Responses migration](https://developers.openai.com/api/docs/guides/migrate-to-responses)：messages vs items、text.format、state 等差异。
- [OpenAI structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs)：schema、refusal、能力限制。
- [Anthropic Messages](https://platform.claude.com/docs/en/api/messages)、[Streaming](https://platform.claude.com/docs/en/build-with-claude/streaming)、[Structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)：content blocks、stream error、累计 usage、schema。
- [Anthropic context windows](https://platform.claude.com/docs/en/build-with-claude/context-windows)：输入 / 生成容量及请求字节等不同限制。

本稿未向这些 API 发真实请求；文档更新与网关差异须在实施时固定 API / 模型版本核查，不把兼容三个协议等同所有厂商全部功能都已可用。
