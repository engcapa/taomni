# OPENCODE-GO 开发任务

日期：2026-10-15。状态：**设计定案并按 feature-design 模板完成交接，9 个开发任务均未开始**。唯一行为与验收规范为[详细设计](../opencode-go-provider-design.md)（DEC/AC/V 以设计为准，本文件是其 §6 的执行展开版，ID 一致）。独立项 S1（全 provider 模型检视）不在本任务集内，见 [model-inspector 任务文档](../model-inspector/development-tasks.md)。

目标：taomni 新增一个 OpenCode Go provider 条目——一个 key、在线目录驱动的 30+ 模型、四种协议（chat/messages/responses/google）按模型分发、线程级模型选择；新模型上线无需发版即可用；既有 7 个 provider 的行为零变化。

## 1. 任务顺序和职责

| TASK | 职责 | 依赖 | 状态 |
|---|---|---|---|
| TASK-01 | 基线与契约冻结：改前基线、ChatRequest 构造点清点、三源 fixture 固化 | 无 | 待开发 |
| TASK-02 | 配置与数据模型：ai.json 条目/新字段、ChatRequest 字段、llm_model 列与命令、TS/stub 镜像 | TASK-01 清点结果 | 待开发 |
| TASK-03 | 模型目录服务：三源合并、缓存、快照与种子脚本、目录 IPC | TASK-02 的 DTO 约定 | 待开发 |
| TASK-04 | 协议传输补齐：extra_headers 注入口、responses 与 google 两新传输 | TASK-02 的 ChatRequest 字段 | 待开发 |
| TASK-05 | 分发器与路由接入：OpenCodeGoProvider、router 分支、连接测试 go 分支 | TASK-03、TASK-04 | 待开发 |
| TASK-06 | 前端设置与聊天选择器：go 行（下拉/状态行/协议区）、ChatDrawer 选择器、i18n | TASK-02、TASK-03；真连部分待 TASK-05 | 待开发 |
| TASK-07 | 自动化测试与 QA 用例：V-01～V-06 落地、TC-AI-005 与 CI policy | TASK-03～06 稳定 | 待开发 |
| TASK-08 | 集成回归与三端兼容：保留行为回归集、兼容检查、推送前门禁 | TASK-07 | 待开发 |
| TASK-09 | 真机验证与交付记录：Linux 真连矩阵与离线/重启、证据回填、PR 说明 | TASK-08；真连需订阅 key | 待开发（key 未就绪时离线部分先行） |

按依赖顺序实施即可，不要求并行 agent 或任务板操作。共享文件归属：`llm/mod.rs` 与 `router.rs` 由 TASK-02/05 先后触碰（02 只加字段与模块注册，05 加路由分支）；`ai/commands.rs` 由 TASK-03（目录命令）与 TASK-05（测试分支）先后触碰，按顺序交接。保留用户与其他执行者的改动；制造基线用 TASK-01 的记录，不回退工作树。

全局约束（每项任务都适用，出自设计与仓库规范）：

- 凭据只经现有 vault 链，任何日志/测试/证据不得出现真实 key；真连 key 仅以环境变量名引用（如 `TAOMNI_TEST_OPENCODE_GO_KEY`）。
- 推送前门禁（仓库 AGENTS.md 既定）：`npx tsc --noEmit`、`cargo check`、QA audit 与 CI 工具自测通过；新增 QA case 同步 `qa-ui-auto-tests/ci/policy.yaml`。归 TASK-08 统一执行，不逐任务重复全套。
- 代理解析失败必须显形（新代码），不复制既有传输「记日志后直连」的行为到新模块。
- 三端：不引入平台专有 API 与硬编码路径；路径经 `resolved_config_dir()` 口径。

## 2. TASK-01：基线与契约冻结

输入：设计 §2.1 对接点表、§3 的 AC-13、qa-ui-auto 的既有行为保护规则。职责以只读检查与 fixture 固化为主，不改生产行为。

步骤：

1. 记录基线身份：提交 `6ca83889`、工作区状态（未跟踪设计文件清单）、Rust/Node 工具链版本。
2. 清点 `ChatRequest` 全部构造点与 `Llm::chat/chat_with_tools/chat_stream` 全部调用方（聊天调度、任务调度、fallback、分组、摘要等），逐一标注「是否应写 model_override/session_key」——结论应只有聊天调度两处写、其余不写，并核对各构造点是否走 `..Default::default()` 或全字段字面量（决定 TASK-02 的改法）。
3. 清点 `OpenAiCompatProvider`、`AnthropicProvider` 的全部构造点（router、test_llm_connection、media 等），确认 `extra_headers` 默认空时零影响的构造方式（构造参数 vs builder 方法，实现时定并记录）。
4. 跑一遍受影响既有测试的改前基线：`aiStore` 相关 Vitest、`ai/config` 与 `llm` 相关 Rust 测试、TC-AI-001（browser）。结果如实记录（通过数/失败项/未执行原因）；基线失败项标注既有问题，不在本功能里顺手修。
5. 固化三源 fixture：把 `~/workspace/taomni-research/opencode-go/` 中 2026-10-15 的实时清单与 models.dev 抽取，复制为仓库内测试 fixture 的来源并记录哈希（放 `src-tauri/src/llm/opencode_go/testdata/` 拟新增，或实现时按模块惯例定址）；另构造一份「S1 失败」「缓存损坏」「digest 相同」场景数据说明。
6. 产出保留行为清单（对应 AC-13）：deepseek 非流/流式/工具、anthropic 同、local 同、连接测试、fallback 切换、分组轮换——每项标注现有测试或手工路径，作为 TASK-08 的回归集输入。

产物：基线记录与 fixture 说明，放 `qa-ui-auto-report/opencode-go-provider/baseline.md`（脱敏）；fixture 文件随 TASK-03/07 入库。

完成条件：构造点与调用方清点无遗漏（以全文检索结果为准）、基线结果已记录、fixture 可用。对应 AC-13（依据）、AC-08/09（fixture 侧）。基线缺失或未执行必须如实写明，不得写成「零退化」。

## 3. TASK-02：配置与数据模型

负责文件（设计 §5 对应行）：`src-tauri/src/ai/config.rs`、`src-tauri/src/llm/mod.rs`、`src-tauri/src/chat/store.rs`、`src-tauri/src/chat/mod.rs`、`src/stores/aiStore.ts`、`src/stores/chatStore.ts`（线程类型）、`src/stubs/tauri-core.ts`。

步骤：

1. `LlmConfig::default()` 加 `opencode-go` 条目：base_url `https://opencode.ai/inference/go/v1`、model `deepseek-v4.1-flash`（DEC-07）、runtime `opencode-go`、capabilities 仅 chat、时区外字段按现有云端条目惯例；`ensure_default_providers()` 以 or_insert 补齐（含空 api_key 变体，与其他条目一致）。
2. `LlmProviderConfig` 加 `protocol_overrides: HashMap<String, String>`（`#[serde(default, skip_serializing_if = "HashMap::is_empty")]`）；TS 镜像加 `protocol_overrides?: Record<string, string>`；值域校验放在分发器消费侧（未知协议字符串按 chat 处理并告警），配置层不拒绝保存。
3. `ChatRequest` 加 `model_override: Option<String>`、`session_key: Option<String>`（均 serde default）；按 TASK-01 清点逐一核对构造点可编译且语义不变。
4. `ai_chat_threads` 加 `llm_model TEXT` 列（沿用 cc_model 的 ALTER 惯例）；store 读写函数；新命令 `chat_set_thread_llm_model` 在 `chat/mod.rs` 注册（与 `chat_set_thread_cc_model` 并列，**不触发**任何进程回收）；线程结构 TS/Rust 同步加 `llm_model`。
5. 聊天调度接线：`chat_send` 与 `chat_stream` 组 `ChatRequest` 时，若线程 `llm_model` 非空写 `model_override`，恒写 `session_key = sha256(thread_id)` 前 32 位十六进制（哈希函数用仓库现有依赖，不新引）。
6. 前端镜像：`aiStore.ts` 的 DEFAULT_CONFIG 与 normalize 补 go 条目；`tauri-core.ts` 桩的 `get_ai_config` 同步加条目，`chat_set_thread_llm_model` 加 no-op 桩。

迭代验证（相关文件稳定后一次跑，不逐文件全量）：

```bash
# 仓库根目录
npx tsc --noEmit
pnpm exec vitest run src/stores/aiStore.test.ts
# src-tauri/
cargo check
cargo test --lib ai::config
cargo test --lib chat
```

完成条件：AC-01 的存储层成立（老 ai.json 加载出 go 条目、老字段无变化——以 V-03 中本任务负责的部分先行自测）；AC-07 的存储层成立（llm_model 落盘/清除/重启读回）；AC-13 无回归（既有相关测试与基线一致）。对应 V-03、V-05（store 部分）。

## 4. TASK-03：模型目录服务

负责文件：`src-tauri/src/llm/opencode_go/catalog.rs`（拟新增，含 `GoModelEntry`、合并、缓存、刷新状态机）、`src-tauri/resources/opencode-go-catalog.snapshot.json`（拟新增）、`scripts/opencode-go-protocol-seed.json` 与 `scripts/update-opencode-go-snapshot.mjs`（拟新增）、目录 IPC 命令（`src-tauri/src/ai/commands.rs` 或同模块新文件）、`src-tauri/src/llm/mod.rs` 的模块注册（与 TASK-02 协调顺序）。

步骤：

1. 先写合并纯函数与单测（V-01）：输入三源（任一可缺）输出目录 + digest；断言用 TASK-01 fixture（kimi-k2.6 在列、omen-alpha 未分类、deepseek-v4-flash 不在列、种子>npm、覆盖>种子、status 不过滤）。
2. 快照脚本：拉 `https://models.opencode.ai/api.json` 抽 `opencode-go` 子树 → 与种子表逐 id 断言协议一致（不一致输出 diff 并非零退出供人工裁定）→ 生成快照 JSON（含生成时间与源 digest）→ 首次运行生成入库快照。脚本用 Node 内置能力，不加新依赖。
3. 在线拉取：S1 走 provider base_url（默认即 go 网关，可被用户改 base 时跟随）+ provider 代理；S2 走固定常量地址 + 同一代理；均带 `User-Agent: taomni/<版本>`、超时 10s；full_local/fully_disabled 时直接返回缓存/快照路径（AC-12）。
4. 缓存：读写 `opencode-go-catalog.json`（config 目录）；解析失败/字段缺失 → 忽略缓存回退快照，不抛错阻断。
5. 刷新状态机：四触发点接线（启动异步、按需过期、手动、报错强制）；在途去重（后到者合并）；成功且 digest 变才换内存 Arc 并更新 `fetched_at`；失败保留 last-good 并记录 `last_error`。
6. IPC `get_opencode_go_catalog(force_refresh)`：返回 DTO（models/fetched_at/source/last_error）；force 时等待本轮刷新完成再返回；source 按实际所用来源标注（live/cache/snapshot）。AppState 持有服务实例并注入 router 与命令层（依赖 TASK-05 的接线点时先以构造参数预留）。

迭代验证：

```bash
# src-tauri/
cargo test --lib opencode_go::catalog
node scripts/update-opencode-go-snapshot.mjs --check   # 以脚本实际实现的参数为准
```

完成条件：V-01 全过；AC-08（合并/去噪/触发）、AC-09（回退链）、AC-12（不发网）后端成立。对应 V-01、V-03（目录侧）。

## 5. TASK-04：协议传输补齐

负责文件：`src-tauri/src/llm/openai_compat.rs`、`src-tauri/src/llm/anthropic.rs`（仅加注入口）、`src-tauri/src/llm/opencode_go/responses.rs`、`src-tauri/src/llm/opencode_go/google.rs`（均拟新增）。

步骤：

1. 给两现有传输加可选 `extra_headers`（按 TASK-01 结论的构造方式）；注入点为请求构建处统一合并，默认空时请求逐字节与改前一致——用既有传输测试 + 一条「空头集合」断言证明（AC-13）。
2. responses：先写纯映射函数（请求体组装、非流解析、SSE 事件归约）与单测（V-02），fixture 按设计 §4.3 映射表构造，覆盖：多轮历史、图片、工具声明、function_call 与 function_call_output 回填、流式 delta/completed/failed、usage 映射、max_output_tokens。
3. responses 的 `Llm` 实现：非流/流式/带工具三方法共用映射；错误走 `LlmError::Provider` 原文；超时 60s；`previous_response_id` 不用。
4. google：同法先映射后实现；端点两形态（generateContent / streamGenerateContent?alt=sse）；角色名 `model`；functionCall/functionResponse 回填；usageMetadata 映射；超时 60s。
5. 两新传输的 Client 构造统一支持 UA 与代理参数（由分发器传入），不在传输内读全局配置。

迭代验证：

```bash
# src-tauri/
cargo test --lib opencode_go
cargo test --lib llm::openai_compat
cargo test --lib llm::anthropic
```

完成条件：V-02 全过；既有两传输测试与基线一致（AC-13）；新传输无未处理事件类型导致的 panic（未知 SSE 事件忽略并记录）。对应 V-02、V-04（映射侧）。

## 6. TASK-05：分发器与路由接入

负责文件：`src-tauri/src/llm/opencode_go/mod.rs`（拟新增，分发器）、`src-tauri/src/llm/router.rs`、`src-tauri/src/ai/commands.rs`（`test_llm_connection` go 分支）。

步骤：

1. 分发器构造：入参（provider_id、base_url、api_key、默认模型、代理、目录句柄、覆盖表快照）；四传输懒建缓存（键=协议）；UA 与会话头在构造传输时经 extra_headers/参数注入。
2. 请求路径：定模型（override ?? 默认）→ 查目录得协议（覆盖表优先于目录协议）→ 选传输透传；查不到模型按 chat 发且返回后（或错误时）触发目录强制刷新一次；响应为「model not found」类错误时同样触发刷新但不重试改模型（AC-11）；同一请求最多触发一次刷新。
3. `supports_tools()` 读条目 tool_call（未知 true）；`model()` 返回默认模型；流式三方法与非流同一分发逻辑（避免两套选路）。
4. router：runtime 集合加 `opencode-go`；每 key variant 各建一份分发器但共享目录 Arc 与覆盖表快照；vault unresolved 与 full_local 跳过逻辑沿用现有分支形态，不特判。
5. `test_llm_connection`：runtime 为 opencode-go 时走分发器默认模型 pong，返回口径与现有分支一致（成功/状态码/错误消息）。
6. 分发器单测（V-04）：以本地假网关/假传输断言选路、未知模型回落、UA 与会话头（同 session_key 同值）、覆盖表改协议生效；并断言非 go provider 的请求构造不受新字段影响（AC-13 的一部分）。

迭代验证：

```bash
# src-tauri/
cargo test --lib opencode_go
cargo test --lib llm
```

完成条件：V-04 全过；AC-03～AC-06 的后端链路在假网关下成立（真连归 TASK-09）；AC-11、AC-12 后端成立。对应 V-03、V-04。

## 7. TASK-06：前端设置与聊天选择器

负责文件：`src/components/settings/LlmProvidersPanel.tsx`、`src/components/chat/ChatDrawer.tsx`、`src/stores/aiStore.ts`（catalog store 部分）、`src/stubs/tauri-core.ts`（`get_opencode_go_catalog` 桩）、i18n 词条文件（按现状定位，中英双份）。

步骤：

1. catalog store：状态（models/fetched_at/source/last_error/loading）+ 动作（ensureLoaded 按 DEC-09 阈值、refresh(force)）；数据只经 `get_opencode_go_catalog` 命令，组件不直连外网。
2. 设置页：`PROVIDER_LABELS["opencode-go"]="OpenCode Go"`；`PROVIDER_NOTES` 写订阅说明与 Console 链接文案（链接走仓库既有外链打开方式）；go 行展开区按设计 §4.4 顺序组装：默认模型下拉（分组+搜索，目录空回退文本框）、目录状态行（计数/时间/来源/刷新按钮，full_local 时禁用并注明）、协议区（全量行、协议下拉、来源小字、恢复自动；改动经现有配置保存链写 `protocol_overrides`）、训练徽标（google 与两个 muse 条目）。
3. 选择器：ChatDrawer 仅当线程 provider 为 opencode-go 时渲染，复用 cc/codex 模型选择的既有组件形态与 testid 命名惯例；条目含搜索、协议徽标、上下文、未分类/已弃用/训练徽标；已下线钉住项置顶标注；底部目录年龄行（点击刷新）；选中即调 `chat_set_thread_llm_model` 并更新线程状态，清除钉住回默认。
4. 新控件的 `data-testid` 按 qa-ui-auto 规范命名并在 TASK-07 登记（实现前先查 testid 目录去重；目录生成走既有工具，不手改生成物）。
5. stub：`get_opencode_go_catalog` 返回与快照同构的固定样本（含一个未分类、一个 google、一个 deprecated 例子）供浏览器层走通全状态。

迭代验证：

```bash
# 仓库根目录
npx tsc --noEmit
pnpm exec vitest run src/stores/aiStore.test.ts src/components/settings
pnpm dev   # 浏览器层人工走查：设置页 go 行全状态 + 聊天选择器（stub 边界，如实记录）
```

完成条件：V-05 中本任务部分全过；浏览器层主流程可走通（AC-01/06/07/10 的 UI 侧）；文案无硬编码残留（全走 i18n）。对应 V-05、V-06（UI 侧）。

## 8. TASK-07：自动化测试与 QA 用例

职责：把设计 §7 的 V-01～V-06 中尚未随 TASK-02～06 落地的部分补齐，并做 QA 目录维护。

步骤：

1. 对照 §7 表逐项核对：V-01（目录）、V-02（映射）、V-03（配置/路由）、V-04（分发/保留）、V-05（前端）——缺哪补哪；每个测试文件单独可跑，记录选中/跳过计数，不把未选中当跳过。
2. 新增 browser case `TC-AI-005-opencode-go-provider`（文件名以仓库命名惯例为准）：covers 与 feature 归属按 `feature-list.md` 现状去重确认（拟挂 F-AI-2.4 相邻条目）；步骤覆盖设置页出现 go 行→展开可见默认模型下拉与协议区→聊天选 go→选择器出现→切换模型→线程钉住回显；stub 边界在 case 描述中写明（不证明真实网关）。
3. 同步 `qa-ui-auto-tests/ci/policy.yaml`（新 case 纳入目录），跑 `python -m qa_ui_auto audit --gate`；控件/testid 目录按既有生成工具更新，不手改生成文件。
4. 回归对子：复跑 TC-AI-001（保留行为）并记录结果；与 TASK-01 基线对照，差异逐项说明（期望变化 vs 退化）。

完成条件：V-01～V-06 全部实际执行且结果记录在案；audit 通过。对应 AC-01/07/08/10/13（自动化侧）。

## 9. TASK-08：集成回归与三端兼容

步骤：

1. 按 TASK-01 的保留行为清单执行回归集（V-09）：既有 provider 代表性单测（Vitest + Rust 的受影响子集全量跑相关文件，不做 -t 过滤收尾）、fallback 与分组既有测试、TC-AI-001；逐项与基线对表，本功能引入的退化在本任务内修复并补最小持久测试，不留给后续。
2. 三端兼容检查（V-10）：审查本功能 diff 中的条件编译、路径拼接、依赖新增（应为零新增第三方依赖，如有例外在本节记录理由）、WebView 相关前端 API（应为零新 API）；当前环境执行 `pnpm build` 与 `cargo check` 全量通过。
3. 推送前门禁（仓库既定，全量执行一次）：`npx tsc --noEmit`、`cargo check`、`python -m qa_ui_auto audit --gate`、CI 工具自测 `python -m unittest test_ci_selection test_ci_report test_ci_execute test_ci_desktop test_ci_provenance test_ci_services test_dev_contract`。
4. 检查最终组合代码上的相交行为：目录热替换 × 正在流式的请求（旧 Arc 完成本请求）、协议覆盖保存 × router 重建、full_local 切换 × 目录刷新在途——各以单测或手工步骤留结论。

完成条件：V-09、V-10 通过；无已知代码不兼容；门禁全绿。对应 AC-13 及全部 AC 的集成侧。

## 10. TASK-09：真机验证与交付记录

输入：设计 §8 手册。当前运行端 Linux 本轮执行；Windows/macOS 留接续清单。

步骤：

1. 准备：按 §8 的环境与就绪检查建隔离配置；确认订阅有效与网络路径（代理走应用内配置）；记录被测构建标识（提交 + 是否 no-bundle）。
2. 执行 V-07 四协议真连矩阵：逐组完成「多轮 + 工具 + 流式」，逐组留脱敏证据；鉴权头问题按设计只在分发器适配并重测该组，适配内容写入交付记录。
3. 执行 V-08：钉住持久化、断网冷启动、刷新失败保旧、恢复刷新；顺带记录真实下线事件（若有）对 AC-11 的旁证。
4. 其余端：把 Windows/macOS 的同等步骤整理为接续清单（含环境前提与预期），状态标未验证，不在本任务内声称通过。
5. PR 说明与回填：问题背景、四协议与目录机制、保留行为与基线对照、各 V 结果、三端状态、回退方式（设计 §10）；把实际结果回填设计 §9 与本文件状态表；证据入 `qa-ui-auto-report/opencode-go-provider/`。

完成条件：V-07、V-08 在 Linux 端通过且证据齐全；§9 追踪表无「未实现」残留（真机列）；已知问题如实列明。对应 AC-02～AC-07、AC-09、AC-11、AC-14 的真机侧。

## 11. 实施后的交付记录

2026-10-15 本轮开发/验证记录见
`docs-feature/opencode-go-provider/delivery-notes.md`；本地基线见
`qa-ui-auto-report/opencode-go-provider/baseline.md`。应用户要求，本轮不执行
browser/native 真机用例；TASK-07 的「浏览器已运行」及 TASK-09 的「真连」
完成条件未满足，不能把用例已编写等同验收已通过。完整 Rust crate 单测
在无关 ASR 系统库处中断，其余局部单测结果均写明作用范围。

当前所有项目为待执行；完成后填写实际值，不删除未覆盖项：

- 源码与构建：实现提交、相关未提交变更、被测构建标识与 hash、前端 mode。
- 验证结果：V-01～V-10 逐项结果（通过/失败/环境阻塞/未验证）与证据路径；选中/跳过计数；基线对照差异说明。
- 真机：Linux 端 V-07 四组与 V-08 的实际结果、鉴权头适配记录（如有）；Windows/macOS 未验证范围与接续条件。
- 改动范围：实际产品/测试文件清单；超出本设计的小范围改动及必要性；新依赖（如有）及理由。
- 发布边界：快照与种子的本次刷新记录；回退方式复述；DEC-09 的最终取值（若用户已定）。
