# 全 Provider 模型检视（Settings 模型检查）详细设计

> 本文档按仓库 `.agents/skills/feature-design` 的模板与工作流编制。本地编号前缀 `I` 与 OpenCode Go 设计区分但规则同构：决策 `DEC-I*`、验收 `AC-I*`、任务 `TASK-I*`、验证 `V-I*`。开发任务展开版见 [model-inspector/development-tasks.md](model-inspector/development-tasks.md)。来源设计为 [opencode-go-provider-design.md](opencode-go-provider-design.md) 的 DEC-06（其原 §16 的内容已由本文正式化替代）。

## 1. 设计摘要与范围

- 类型：现有能力扩展（设置页新增跨 provider 的模型检视能力）
- 文档位置：`docs-feature/model-inspector-design.md`
- 设计状态：**可实施**（DEC-I01 已由用户定案；其余为有代码/实测依据的 agent 自决，无待决阻塞）
- 来源：用户 2026-10-15 在 OpenCode Go 设计定案时对 D5 的补充——「在 settings 的地方可以增加模型检查，包括模型名称，协议，上下文长度，多模态等信息，这个 feature 可以单独一项，因为所有已经做 provider 都要支持」
- 调研基线：taomni main `6ca83889`（v0.4.38）；models.dev 覆盖实测于 2026-10-15（证据在 `~/workspace/taomni-research/opencode-go/` 的全量快照抽取过程中取得，关键结论记录于 §2.2）
- 平台与运行方式：Windows、macOS、Linux 三端 Tauri 桌面应用，代码必须兼容三端构建与运行
- 本轮真机执行端：Linux（当前环境）；三端均保留计划，本轮完成当前端验证即可，其他端未执行不单独阻塞交付
- 推荐方案：在设置页每个 provider 行加一个「模型检查」入口，打开检视面板：以表格呈现该 provider 的模型名称/id、协议、上下文长度、输出上限、多模态、工具/推理、价格、状态、元数据来源与最近检测结果，并支持逐模型真实连通检测与「设为当前模型」回写。数据来自三级解析（provider 实时 `/models` → models.dev 精确命中 → 未收录如实标注）；目录机制与 OpenCode Go 功能**共用一套** models.dev 拉取/缓存底座，不建第二套。

用户问题：现在每个 provider 在设置页只有一个手填的 model 文本框——用户不知道某个模型走什么协议、多大上下文、支不支持图片/工具，也无法确认手填的 id 是否真实可用、key 是否能通到该模型。完成后的可观察结果：任何 provider 都能一键打开体检表看清上述信息，能对指定模型点一次真实检测并看到结果（重启后仍在），还能从目录里直接把某个模型设为当前模型，不再靠猜 id 手填。

本次范围：全部 LLM provider 的检视面板（既有 7 个 + opencode-go + 未来新增条目自动纳入）、元数据三级解析、逐模型检测与结果持久化、设为当前模型回写。不做：计费/余额/用量看板；检测失败自动换模型或自动改协议（只呈现事实）；批量一键全测作为默认动作（仅提供显式按钮且点击时明示会逐个发请求）；opencode-go 的协议编辑（那是 Go 设计 §4.4 协议区的 DEC-04 通道，本功能只读展示其现值与来源）。

与 Go 功能的排期关系：**独立项**，可先于、平行于或后于 Go P0；两边验收互不阻塞。唯一的共享点是目录底座（DEC-I02 的实现归属规则）。

## 2. 当前实现与功能缺口

### 2.1 现状（基线实查）

| 位置与符号 | 当前行为 / 契约 | 本次影响 | 依据与确定性 |
|---|---|---|---|
| `src/components/settings/LlmProvidersPanel.tsx` | 每 provider 行展开区有 model 纯文本输入与「测试连接」按钮；无任何模型元数据呈现 | 每行加「模型检查」入口与检视面板（抽屉或行内展开，沿现有展开层级） | 源码实查（事实） |
| `src-tauri/src/ai/commands.rs` `test_llm_connection` | 以 provider 当前 model 发一次测试，按 runtime 二分 | 泛化出「指定模型」检测命令，复用其链路与返回口径；原命令行为不变 | 源码实查（事实） |
| 各 provider 的 `/models` 端点 | 全仓**无**调用先例；OpenAI 兼容类（含 local 的 llama-server）协议上支持 `GET {base_url}/models` | 拟新增只读拉取（存在性校验）；llama-server 的该端点返回实际加载模型，是 local 的权威来源 | 检索实查 + 协议常识（事实/推断已标注） |
| models.dev 目录机制 | 仓库内不存在；Go 设计的目录服务按 `opencode-go` 子树专用设计 | 泛化为可按 provider 键取子树的共享底座（DEC-I02） | Go 设计 §4.2（拟新增对象的复用） |
| 配置与存储 | `ai.json` 管配置；无「检测结果」类独立小文件先例，但 Go 目录缓存文件确立了「非配置数据独立落盘」的做法 | 检测结果存独立文件 `model-check-results.json`，不进 ai.json | 源码实查 + Go 设计口径（事实） |

### 2.2 models.dev 对既有 provider 的覆盖（2026-10-15 实测）

全量目录 230 个 provider 条目；既有 provider 均有对应条目，键名与 api 对照如下（判定方法：条目 `api` 字段与 taomni 内置 base_url 逐字/同域比对）：

| taomni provider | models.dev 键 | 子树模型数（实测） | 备注 |
|---|---|---|---|
| deepseek | `deepseek` | 4 | 当前默认 `deepseek-chat` 是别名 id，子树内**无**此 id（只有 deepseek-v4-flash 等规范 id） |
| agnes | `agnes` | 4 | 含当前默认 agnes-2.0-flash（精确命中） |
| anthropic | `anthropic` | 17 | 含 claude-sonnet-4-5 等当前可用 id |
| groq | `groq` | 16 | 含当前默认 llama-3.3-70b-versatile |
| siliconflow | `siliconflow-cn`（缺省） | 44 | 其 api 与 taomni 的 `.cn` 域名一致；用户改用 `.com` 时键为 `siliconflow`（57）——按 base_url 域名选键 |
| glm | `zhipuai` | 17 | 其 api `https://open.bigmodel.cn/api/paas/v4` 与 taomni glm 配置逐字一致；当前默认 `glm-4-flash` 子树内**无**此 id |
| local | —（不用目录） | — | 权威来源是 llama-server 自身 `/models` |
| （参考）siliconflow 的 `Qwen/Qwen2.5-Coder-7B-Instruct` | 两键均无此 id | — | 第三类样本：第三方模型 id 未被目录收录 |

结论：**条目级全覆盖、id 级部分命中**。故解析必须分级且未命中如实标注，这是本设计 §4.2 三级解析的直接依据；别名登记（如 deepseek-chat → deepseek-v4-flash）只许标注为「别名映射」，不许冒充精确命中。

## 3. 验收条件

| ID | 场景与前置条件 | 用户动作或触发 | 必须观察到的结果 | 适用平台 / 边界 |
|---|---|---|---|---|
| AC-I01 | 任一既有 provider 已配置（共 7 个逐个验） | 在其设置行点「模型检查」 | 检视面板打开；当前配置模型行必在且高亮；协议列与其 runtime 相符（openai-compat→chat、anthropic→messages、llama-server→chat） | 三端 |
| AC-I02 | anthropic（目录精确命中样本） | 打开检视 | claude-sonnet-4-5 行显示上下文/输出上限/多模态/价格等目录值，来源标「目录命中」 | 三端 |
| AC-I03 | deepseek（别名样本） | 打开检视 | deepseek-chat 行在列；元数据或标「别名映射」（若已登记）或各列 `—` 且标「目录未收录」，**不出现编造数值** | 三端 |
| AC-I04 | local 且 llama-server 已加载某模型 | 打开检视 | 行集来自服务器实际返回，来源标「实时清单」；服务器未启动时显示明确的不可用状态而非空表假象 | 三端 |
| AC-I05 | 任一模型行 | 点该行「检测」，分别在正常、错 key/断网两种条件下 | 正常时显示 ✓ + 延迟 ms + 时间；异常时显示 ✗ + 错误摘要 + 时间；关闭面板并重启应用后结果仍在（独立文件落盘） | 三端 |
| AC-I06 | 面板中任一「可选用模型」行 | 点「设为当前模型」 | 该 provider 的 `model` 配置经现有保存链更新，设置行与聊天随即以新模型工作；vault 与其它字段不受影响 | 三端 |
| AC-I07 | opencode-go 已按 Go 设计落地 | 打开其检视 | 行集与协议（含来源与手工覆盖值）与 Go 目录服务/协议区完全一致，不出现第二套数据口径；协议在本面板只读 | 三端；依赖 Go 功能或其目录底座先行（见 DEC-I02） |
| AC-I08 | `full_local_mode` 开启 | 打开任一云端 provider 的检视 | 只读本地缓存/快照数据，检测按钮禁用并注明原因，不发出网络请求 | 三端；策略门（保留行为扩展） |
| AC-I09 | 既有设置流程 | 改 key、改 model 文本框、测试连接、保存，各走一遍 | 行为与改前基线一致；检视面板的加入不改变行展开区既有控件与保存语义 | 三端；**保留行为回归** |

## 4. 方案与关键决策

### 4.1 入口与界面

- 入口：`LlmProvidersPanel` 每个 provider 行展开区加「模型检查」按钮（与测试连接同排）；打开方式沿用现有展开/抽屉层级，不新开页面、不改设置页结构（不改变结构/流程，故不另制原型图稿，与 Go 设计 DEC-02 同一判断口径）。
- 面板结构：顶部汇总行（`共 N 个模型 · 目录更新于 HH:MM · [刷新目录] [检测当前模型]`）+ 表格 + 行级动作。表格列：模型（名+id）、协议、上下文长度、输出上限、多模态（输入/输出）、工具/推理徽标、价格（入/出/缓存读）、状态徽标、元数据来源、最近检测、行动作（检测 / 设为当前模型）。
- 当前配置模型行置顶高亮；其余为「可选用模型」（行集口径见 §4.2）。未知值一律 `—`，不留空、不填 0。
- 空态与错误态：目录拉取失败显示失败原因并保留 last-good（同 Go 设计 §4.4 状态口径）；local 服务器未启动显示「本地服务未运行」而非空表；full_local 时检测禁用并注明（AC-I08）。

### 4.2 元数据三级解析与行集

逐 provider 按下列顺序解析（每行记录命中级别，写入来源列）：

1. **一级 · 实时清单**：对 OpenAI 兼容类与 local 拉 `GET {base_url}/models`（带该 provider 的 key 与代理）——判定 id 是否真实存在；local 以此为行集与权威来源。
2. **二级 · models.dev 精确命中**：按 §2.2 映射表取子树（siliconflow 按 base_url 域名选 `siliconflow-cn`/`siliconflow`；opencode-go 走 Go 目录服务结果，不重复解析），按 id 精确匹配得全套元数据。
3. **二级半 · 别名映射**（可选登记）：别名登记表把已知别名 id 指向规范 id 的元数据，来源列必须标「别名映射」；登记表随共享快照脚本维护，初始只登记实测确认的 `deepseek-chat`（指向当时规范条目，实施时以目录现状复核）。
4. **三级 · 未收录**：只显示可确知项（id、协议=provider runtime、配置值），其余 `—` + 标「目录未收录」。

行集口径：必有行 = 当前配置模型（无论命中与否）；可选用行 = 二级子树全部模型（一级清单用于给行打「实时存在/不存在」标记，不一致时标灰注明，不直接删行——与 Go 的 DEC-05 同一哲学：呈现差异，不替用户删除）；local 的行集 = 一级返回。opencode-go 行集 = Go 目录合并结果（含其 S1 可用性过滤），不在本功能重复呈现差异。

### 4.3 逐模型检测与结果持久化

- 检测动作：以该 provider 的 key/base/代理 + 指定模型发一次最小聊天请求。后端把 `test_llm_connection` 的核心链路泛化为可指定 `(provider_id, model)` 的命令（拟新增 `test_llm_model`，或给现有命令加可选 model 参数——实现时按命令注册惯例定，原命令签名与行为保持，见 AC-I09）；opencode-go 行走其分发器对应协议；local 走 llama-server。
- 结果结构：`{ ok, latency_ms?, error?, checked_at }`，按 `provider_id + model_id` 键存 `~/.config/taomni/model-check-results.json`（与 ai.json 同目录的独立文件）；写入时机为每次检测完成；读取时机为面板打开。
- 不自动重测：结果只展示，不因打开面板而发请求；「检测全部」为显式按钮，点击时明示将逐个发送测试请求（消耗用户额度），逐行更新结果。
- 错误摘要：取网关原文首行截断显示，完整错误可在悬停/展开查看；不翻译、不归因加工。

### 4.4 与 Go 功能的关系：共享目录底座

models.dev 的全量拉取、缓存文件、digest 去噪、刷新时机整套机制**只建一份**：归属规则按排期先后定——若 Go 功能先行，其目录服务在实现时即按「可按 provider 键取子树」泛化（Go 消费 `opencode-go` 子树，检视消费其余子树），本功能直接复用；若本功能先行，则由本功能建底座（落在中立模块，如 `llm/model_catalog.rs`），Go 的目录服务在其上加 S1 合并与种子层。两者不许各建一套拉取/缓存。此归属在先行一方的任务文档中落实（Go 侧 TASK-03 已预留泛化要求时以其为准；本功能 TASK-I01 负责对齐核查）。DTO 共用同一结构（Go 的 `GoModelEntry` 泛化为通用 `ModelCatalogEntry`，或两边字段对齐，实现时定并记录）。

### 决策记录

| DEC ID / 问题 | 可行选项、影响与代价 | 结论或待决推荐及理由 | 状态 | 决策来源 | 关联 AC / TASK / V |
|---|---|---|---|---|---|
| DEC-I01 本功能归属 | A 并入 Go 功能交付；B 单独立项覆盖全部 provider | B：用户明确「可以单独一项，因为所有已经做 provider 都要支持」；与 Go 验收解耦 | 用户已定 | 用户 2026-10-15 D5 补充 | 全部 AC-I；TASK-I01～05 |
| DEC-I02 目录底座归属 | A 各建一套（重复拉取/缓存，口径易漂移）；B 共用一套、先行方负责泛化 | B：同一数据源两套缓存必然不一致（AC-I07 兜底） | agent 自决 | 依据 §4.4 与 AC-I07 的一致性要求 | AC-I07，TASK-I01 |
| DEC-I03 未命中元数据的呈现 | A 按相似 id 猜测填充；B 只标未收录、别名须显式登记且标注 | B：实测存在别名与未收录 id（§2.2），猜测填充会给出错误上下文/价格误导用户 | agent 自决 | 2026-10-15 models.dev 实测（§2.2） | AC-I02/I03，TASK-I02 |
| DEC-I04 检测结果存储 | A 进 ai.json（污染配置保存链、与检视无关的写入）；B 独立小文件 | B：与 Go 目录缓存同一隔离原则 | agent 自决 | 代码依据：配置保存链现状 + Go 设计口径 | AC-I05，TASK-I03 |
| DEC-I05 检测的自动化程度 | A 打开面板自动全测；B 只在用户点按时测 | B：真实请求消耗用户额度，不做无请求发生的后台流量；面板只读已存结果 | agent 自决 | 依据成本与「只呈现事实」的范围约定 | AC-I05，TASK-I03 |

### 接口与共享契约

| 类型 / 名称（现有或拟新增） | 调用方 → 实现方 | 输入及序列化 | 输出 / 错误 / 事件 | 兼容规则 |
|---|---|---|---|---|
| 共享目录底座 `ModelCatalog` 服务（拟新增或由 Go 目录服务泛化） | 检视命令 / Go 目录服务 → Rust | provider 键（§2.2 映射）或子树请求 | 子树条目 + fetched_at + source；失败返回 last-good + error | 两功能共用，见 DEC-I02 |
| IPC `get_provider_models(provider_id)`（拟新增） | 前端检视面板 → Rust | provider id | `ProviderModelsDto{ rows: InspectorRow[], fetched_at, source, last_error? }`；`InspectorRow` 含 §4.1 全部列字段 + 来源级别 + 实时存在标记 | 新命令，无既有调用方 |
| IPC 模型检测（拟新增 `test_llm_model(provider_id, model)` 或现有命令加可选参数） | 前端行动作 → Rust | provider id + 模型 id | 沿用 `test_llm_connection` 的返回口径（成功/状态/错误/延迟），并由后端顺手写入结果文件 | 原命令行为不变（AC-I09） |
| IPC `get_model_check_results()` 或并入面板 DTO（拟新增） | 前端 → Rust | 无（或 provider id） | 键值表（provider/model → 结果结构，§4.3） | 新命令 |
| 结果文件 `model-check-results.json`（拟新增） | 检测命令写、面板读 | JSON 键值表 | 损坏时忽略并视作无结果（不阻断面板） | 非用户配置 |

三端兼容：与 Go 功能相同——纯 HTTPS + 数据处理、无平台 API、无硬编码路径（结果文件经 `resolved_config_dir()`）；前端沿用现有表格/抽屉形态，无新浏览器 API；浏览器 stub 提供固定样本行集（含命中/别名/未收录/实时四类样本）与假检测结果，真实检测与真实目录必须原生验证。

## 5. 改动清单

| 路径 / 模块（标注拟新增） | 具体变更与保持的约束 | 相关 AC | 所属任务 |
|---|---|---|---|
| 共享目录底座模块（`src-tauri/src/llm/model_catalog.rs` 拟新增，或 Go 的 `opencode_go/catalog.rs` 泛化） | models.dev 拉取/缓存/digest/按键取子树；与 Go 侧只建一份（DEC-I02） | AC-I02/I07 | TASK-I01 |
| 快照脚本扩展（与 Go 的 `scripts/update-opencode-go-snapshot.mjs` 同脚本扩参数或同目录新脚本） | 抽取既有 provider 子树快照 + 别名登记表维护 | AC-I02/I03 | TASK-I01 |
| `src-tauri/src/ai/commands.rs`（检视命令拟新增） | `get_provider_models`、模型检测泛化、结果读命令 | AC-I01～I06 | TASK-I02/I03 |
| 检视行集组装模块（拟新增，如 `ai/model_inspector.rs`） | 三级解析、行集与来源标记、local 实时行集 | AC-I01～I04 | TASK-I02 |
| 检测结果存储（拟新增，同上模块） | `model-check-results.json` 读写与损坏自愈 | AC-I05 | TASK-I03 |
| `src/components/settings/LlmProvidersPanel.tsx` | 每行加「模型检查」入口；检视面板组件（可同文件或拆子组件） | AC-I01/I06/I09 | TASK-I04 |
| `src/stores/aiStore.ts` 或新 inspector store（拟新增） | 面板数据/检测结果/刷新状态 | AC-I01/I05 | TASK-I04 |
| `src/stubs/tauri-core.ts` | 新命令桩（四类样本行 + 假检测结果） | 浏览器层 | TASK-I04 |
| i18n 词条 | 面板标题、列名、来源与状态文案（中英） | AC-I01 | TASK-I04 |
| 测试与 QA case（拟新增） | §7 的 V-I01～V-I04；browser case（拟新增 TC 编号实现时按目录去重） | 全部 | TASK-I05 |

## 6. 实现任务与交接

展开版见 [development-tasks.md](model-inspector/development-tasks.md)，ID 一致。

### TASK-I01 共享目录底座对齐与子树供给
- 职责：按 DEC-I02 落实唯一底座；提供按键取子树 + 别名登记表 + 既有 provider 子树快照。
- 依赖：与 Go TASK-03 的先后关系在开工时核查（先行方已建则只做对齐）。完成条件：V-I01 的底座部分通过。

### TASK-I02 检视后端（三级解析与行集组装）
- 职责：`get_provider_models` 命令与组装模块；local 实时行集；来源标记与实时存在标记。
- 依赖：TASK-I01。完成条件：四类样本（精确命中/别名/未收录/实时）在单测中成立。

### TASK-I03 逐模型检测与结果持久化
- 职责：检测命令泛化、结果文件读写、full_local 禁用口径。
- 依赖：TASK-I02 的行集（或可独立先行）。完成条件：V-I02 通过。

### TASK-I04 检视面板前端
- 职责：入口按钮、面板表格与状态、行动作（检测/设为当前模型）、store 与 stub、i18n。
- 依赖：TASK-I02/I03 的命令契约（stub 可先行并行）。完成条件：V-I03、V-I04 浏览器层成立。

### TASK-I05 测试、回归与真机交付
- 职责：补齐 V-I01～V-I04、AC-I09 保留回归、三端兼容检查、Linux 真机（真实 key 检测一例 + local 一例）、证据与回填。
- 依赖：TASK-I01～I04。完成条件：§9 交付条件满足。

可开始：TASK-I01（底座对齐核查）立即；其余按依赖。必须等待：无（与 Go 功能互不阻塞；AC-I07 的一致性验证需 Go 目录底座存在，若 Go 未先行则该 AC 顺延至 Go 落地时补验，在 §9 注明）。

## 7. 自动化测试计划

| V ID | AC / 用途 | 层级与文件 / case（标注拟新增） | 前置数据与操作 | 核心断言 | 命令、工作目录与前置依赖 | 改前依据 / 改后结果 |
|---|---|---|---|---|---|---|
| V-I01 | AC-I01/I02/I03 三级解析 | Rust unit：组装模块内测试（拟新增） | §2.2 实测样本 fixture（anthropic 子树、deepseek 子树、假实时清单） | 精确命中带全套元数据且来源=目录；deepseek-chat 来源=别名映射或未收录且无编造值；子树外 id 不产生行；实时不存在的行被标灰标记而非删除 | `src-tauri/` 下 `cargo test --lib`（模块过滤名以实现为准） | 新组件 / 待执行 |
| V-I02 | AC-I05/I08 检测与持久化 | Rust unit/integration（拟新增） | 本地假网关（成功/401/超时三态） | 成功记 latency 且落盘可重读；失败记原文摘要；full_local 下检测被拒且不发请求；结果文件损坏时视作空 | 同上 | 新组件 / 待执行 |
| V-I03 | AC-I01/I06 面板行为 | Vitest（拟新增/扩展） | stub 四类样本行 | 每行有入口可开面板；当前模型置顶高亮；协议列与 runtime 对应；「设为当前模型」调用保存链且参数正确 | 仓库根 `pnpm exec vitest run <相关文件>` | 既有面板测试为基线 / 待执行 |
| V-I04 | AC-I01/I09 浏览器主流程 + 保留 | browser QA：新 case（拟新增，编号实现时去重）+ 既有设置相关 case 复跑 | browser + stub | 打开任一 provider 检视、四类行呈现正确；既有改 key/保存/测试连接流程不变 | qa-ui-auto runner 既有入口；同步 ci/policy.yaml | 既有 case 为基线 / 待执行 |
| V-I05 | 三端兼容 | 审查 + 当前环境构建 | diff 审查清单 | 无平台 API/硬编码路径；`pnpm build` 与 `cargo check` 通过 | 仓库根 / `src-tauri/` | — / 待执行 |

（真机项 V-I06 见 §8。）

## 8. 真机验证手册

### 环境与准备

同 Go 设计 §8 的隔离配置与凭据口径；另需一个本地 llama-server（或既有 local provider 目标）处于已加载模型状态，以及未启动状态各一次。本轮执行端 Linux；Windows/macOS 保留同等步骤、未执行标未验证。

### V-I06 真机检视与检测（Linux，当前端执行）

- 对应验收：AC-I01～I06、AC-I08
- 步骤：逐个打开 7 个既有 provider 的检视（云端项在已填 key 时顺带核对一级实时标记）；对 anthropic 任一行点检测得 ✓ 与延迟；人为改错一个 key 后检测得 ✗ 与原文摘要；重启应用确认结果仍在；对 local 在服务运行/未运行两态各开一次检视；开 full_local 后确认云端检视只读缓存且检测禁用。
- 证据：各关键状态截图 + 结果文件内容摘要（脱敏）存 `qa-ui-auto-report/model-inspector/`。
- 清理：恢复被改错的 key 与隔离配置；删除测试结果文件或恢复原状。
- 状态：待执行。

### Windows / macOS 接续计划（本轮未验证）

同 V-I06 步骤在各端原生构建执行；重点复核表格在各 WebView 的渲染/滚动与抽屉焦点行为。接续条件与回填规则同 Go 设计 §8。

## 9. 验收追踪与交付条件

| AC | 方案位置 | 开发任务 | 验证项与平台 | 所需证据 / 实际证据链接 | 当前缺口 |
|---|---|---|---|---|---|
| AC-I01 | §4.1/§4.2 | TASK-I02/I04 | V-I01、V-I03、V-I04、V-I06 | [交付记录](model-inspector/delivery-notes.md) | 已实现/本地单测通过；browser/native 未执行 |
| AC-I02 | §4.2 | TASK-I02 | V-I01 | 同上；组装/子树/差异单测 | 已实现/核心单测通过；IPC 整包未验证 |
| AC-I03 | §4.2 | TASK-I02 | V-I01、V-I06 | 同上；alias/未收录单测 | 生产 deepseek-chat 目标未确认，显示未收录；真机未执行 |
| AC-I04 | §4.2 | TASK-I02 | V-I01、V-I06 | 同上；local live/不可用/空态 | 核心与 UI 单测通过；local 真机未执行 |
| AC-I05 | §4.3 | TASK-I03 | V-I02、V-I06 | 同上；probe/文件/store 单测 | 核心单测通过；vault/IPC/冷重启未验证 |
| AC-I06 | §4.1 | TASK-I04 | V-I03 | 同上；真实 save 链 mounted/store 测试 | 本地单测通过；原生保存链未验证 |
| AC-I07 | §4.4 | TASK-I01 | V-I01（一致性断言）、V-I06 | 同上；共享目录与 Go DTO 对照单测 | Go 先行且已改共享；真机流量/四协议未验证 |
| AC-I08 | §4.1/§4.3 | TASK-I03 | V-I02 | 同上；拒绝/取消与 disabled 单测 | 本地单测通过；系统级零流量未验证 |
| AC-I09 | §2.1 | TASK-I05 | V-I04 | 同上；改前9条、改后保留回归 | 本地保留单测通过；browser/native 旧流程未执行 |

本轮交付条件：三端代码兼容检查（V-I05）通过、所选自动化（V-I01～V-I04）实际执行通过、Linux 端真机（V-I06）通过且无已知代码不兼容；其他端未验证保留接续计划。推送前门禁同仓库既定规矩（TASK-I05 执行）。

**2026-10-15 本轮授权范围调整**：用户明确仅运行本地单元测试，编写 browser/native
用例但不执行。因此上述完整验收条件仍未满足，不宣称真机或三端通过。
TASK-I01～I04 已实现；本地前端 29、Rust 隔离 26、Node 3 条通过，tsc 与
QA 静态检查通过；整包 Rust 单测被 bindgen/libclang 环境阻塞。
实际范围和 AC/V 映射见 [delivery-notes.md](model-inspector/delivery-notes.md)，
TC-AI-012～020 与 [native 接续用例](../qa-ui-auto-tests/native/model-inspector.md)
全标为未运行。

## 10. 风险、未决项与回退

| 项目 | 影响与依据 | 建议 / 缓解 / 最小验证 | 阻塞的具体任务 | 解除条件 |
|---|---|---|---|---|
| R-I1 与 Go 功能底座重复建设 | 两套拉取/缓存导致口径漂移（AC-I07 失效） | DEC-I02 归属规则；TASK-I01 开工先核查 Go 侧进度并对齐 | TASK-I01（对齐前不建第二套） | 先行方底座接口确定 |
| R-I2 别名登记过期（如 deepseek-chat 指向的规范条目变更） | 别名行元数据指向错误模型 | 登记表带核对日期、随快照脚本刷新时复核；来源标注使错误可被用户识别 | 不阻塞 | 持续项 |
| R-I3 某 provider 的 `/models` 需特殊权限或形态不同 | 一级解析对该 provider 失效 | 一级失败只降级为「实时未知」，不影响二级/三级呈现（V-I01 覆盖降级路径） | 不阻塞 | 出现时单独适配 |
| R-I4 子树模型很多（siliconflow 57）时面板性能 | 表格渲染与检测列表卡顿 | 行集渲染沿用现有列表惯例；必要时分页/虚拟滚动归 TASK-I04 实施判断（有实测卡顿才做） | 不阻塞 | 实施时以真实数据验证 |

回退边界：检视全部为只读呈现 + 一个显式写动作（设为当前模型，走既有保存链）；回退 = 移除入口与新命令即可，结果文件可删，`ai.json` 无新必填字段，无数据迁移。

现在可开始的任务：TASK-I01。必须等待的：无（AC-I07 的补验依赖 Go 落地时点，见 §6）。
