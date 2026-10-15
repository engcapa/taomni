# MODEL-INSPECTOR 开发任务

日期：2026-10-15。状态：**设计完成交接，5 个开发任务均未开始**。唯一行为与验收规范为[详细设计](../model-inspector-design.md)（DEC-I/AC-I/V-I 以设计为准，本文件是其 §6 的执行展开版，编号带 I 前缀与 OpenCode Go 任务集区分）。本项源于 OpenCode Go 定案时用户对 D5 的补充（该设计的 DEC-06），与 Go 功能独立排期、互不阻塞验收。

目标：设置页每个 LLM provider 都能打开「模型检查」面板——看清模型名称/协议/上下文/多模态/价格等元数据（带来源标注，未收录不编造）、逐模型做真实连通检测并持久化结果、从目录直接设为当前模型。

## 1. 任务顺序和职责

| TASK | 职责 | 依赖 | 状态 |
|---|---|---|---|
| TASK-I01 | 共享目录底座对齐与子树供给：落实 DEC-I02 唯一底座、按键取子树、别名登记、子树快照 | 开工先核查 Go TASK-03 进度 | 待开发 |
| TASK-I02 | 检视后端：三级解析与行集组装、`get_provider_models` 命令 | TASK-I01 | 待开发 |
| TASK-I03 | 逐模型检测与结果持久化：检测命令泛化、`model-check-results.json` | TASK-I02 的行集（可并行先行接口） | 待开发 |
| TASK-I04 | 检视面板前端：入口、表格、行动作、store/stub、i18n | TASK-I02/I03 契约（stub 可先行） | 待开发 |
| TASK-I05 | 测试、回归与真机交付：V-I01～V-I06 落地、保留回归、证据回填 | TASK-I01～I04 | 待开发 |

全局约束：与 Go 任务集相同——凭据只走 vault 且不得出现在日志/证据；推送前门禁（tsc/cargo check/QA audit/CI 自测）由 TASK-I05 统一执行；代理解析失败显形；不引入平台专有 API 与硬编码路径。

**唯一底座纪律（DEC-I02）**：models.dev 的拉取/缓存/digest 机制在本仓库只许存在一份。TASK-I01 的第一步就是核查 Go 侧目录服务的实现状态：已建则对齐复用，未建则由本项建在中立模块并知会 Go 侧后续在其上叠加。任何任务不得以「赶进度」为由新建第二套。

## 2. TASK-I01：共享目录底座对齐与子树供给

输入：设计 §2.2 映射表与 §4.4 归属规则；Go 设计 §4.2 的目录服务定义。

步骤：

1. 核查 Go 侧进度：`opencode_go/catalog.rs` 是否已存在、是否已按「可按 provider 键取子树」实现。据结果二选一并在本文件回填决定：(a) 已建且可泛化 → 本任务只做适配层（按 §2.2 键名取子树）；(b) 未建 → 在 `src-tauri/src/llm/model_catalog.rs`（拟新增，中立命名）实现底座：全量 api.json 拉取（带 UA/超时/代理参数由调用方传入）、磁盘缓存（独立文件、digest 去噪、失败保 last-good）、按键取子树接口；Go 侧后续复用此底座。
2. 键名映射表落为代码常量（含判定注释）：deepseek→`deepseek`、agnes→`agnes`、anthropic→`anthropic`、groq→`groq`、glm→`zhipuai`、siliconflow 按 base_url 域名选 `siliconflow-cn`/`siliconflow`、opencode-go→`opencode-go`（其行集不走本表，见设计 §4.2）。
3. 子树快照：扩展 Go 的快照脚本（同脚本加参数）或同目录新脚本，抽取上述键的子树为检视的离线下限快照（资源文件拟新增，命名实现时定）；生成时断言每个键存在且 api 与预期域名相符，不符则非零退出待人工裁定。
4. 别名登记表：初始仅 `deepseek-chat` 一条（指向实施时目录中的现行规范条目，先复核再登记），条目含目标 id 与核对日期；登记表与快照同脚本维护。
5. full_local/fully_disabled 口径与 Go 侧一致：只读缓存/快照、不发网，由底座统一执行不在上层重复判断。

迭代验证：

```bash
# src-tauri/
cargo test --lib model_catalog   # 或 Go 侧目录模块的等价过滤名，以实际实现为准
```

完成条件：任一既有 provider 键可取到子树（单测以 fixture 证明）；底座唯一性有代码事实（全仓仅一处 api.json 拉取实现，检索可证）；快照与别名表入库。对应 AC-I02/I07（底座侧）、V-I01（底座部分）。

## 3. TASK-I02：检视后端（三级解析与行集组装）

负责文件：组装模块（拟新增，如 `src-tauri/src/ai/model_inspector.rs`）、命令注册（`src-tauri/src/ai/commands.rs`）。

步骤：

1. 行集组装纯函数先行并单测（V-I01）：输入 = provider 配置（runtime/base_url/key可用性）+ 底座子树 + 一级清单结果（可缺）+ 别名表；输出 = 行集（每行带全部列字段、来源级别、实时存在标记）。断言四类样本：anthropic 精确命中（全套元数据）、deepseek-chat（别名或未收录、无编造值）、siliconflow 的 Qwen2.5-Coder 样本（未收录）、子树外 id 不成行；一级与二级不一致时行保留且标灰标记。
2. 一级拉取：OpenAI 兼容类 provider 以其 key/代理 `GET {base_url}/models`（10s 超时）；anthropic 与 go 跳过一级（go 行集走其目录服务）；失败记为「实时未知」不报错中断组装（R-I3 降级路径）。
3. local 行集：以 llama-server `/models` 返回为唯一行集（含已加载模型 id），服务不可达时 DTO 明确给出 `unavailable` 状态与原因，不返回空行集冒充无模型（AC-I04）。
4. 协议列推导：runtime → 协议名映射集中一处（openai-compat/llama-server/ollama→chat、anthropic→messages、opencode-go→逐模型值取自 Go 目录行）；未知 runtime 显示其原始名不猜测。
5. 命令 `get_provider_models(provider_id)`：组装 + DTO（rows/fetched_at/source/last_error）；命令本身不因单源失败整体 Err（保证 UI 有 last-good 可画），口径与 Go 的目录命令一致。
6. AC-I07 一致性断言：同一 fixture 下，检视 DTO 中 go 行集与 Go 目录命令输出逐字段一致（若 Go 未落地，本条留待其落地时在 TASK-I05 补验并注明）。

迭代验证：

```bash
# src-tauri/
cargo test --lib model_inspector   # 过滤名以实现为准
```

完成条件：V-I01 全过（含降级路径）；四类样本与 local 两态（可达/不可达）均有测试。对应 AC-I01～I04、I07（后端侧）。

## 4. TASK-I03：逐模型检测与结果持久化

负责文件：`src-tauri/src/ai/commands.rs`（检测命令）、结果存储（并入组装模块或独立小模块，实现时定）。

步骤：

1. 检测命令：把 `test_llm_connection` 的核心（按 runtime 选传输发最小请求）抽为可指定 `(provider_id, model)` 的内部函数，原命令改调它（model = 配置值），**返回口径与错误文案保持**（AC-I09）；新命令（`test_llm_model` 或原命令加可选参数，实现时按注册惯例定）供面板逐行调用。opencode-go 行在 Go 落地后走其分发器；未落地时该 provider 行的检测按其 runtime 现状处理并在结果中如实呈现。
2. 结果文件：`model-check-results.json`（config 目录）读写：键 `provider_id + model_id`；值 `{ok, latency_ms?, error?, checked_at}`；每次检测完成即写（单行合并写回，不覆盖其他键）；文件损坏/字段缺失时视作空集，不报错。
3. 读取命令：面板打开时取该 provider 的全部已存结果并入 DTO 或独立命令返回（实现时定，契约见设计 §4）。
4. full_local 口径：云端 provider 的检测直接拒绝并返回明确原因（不发网，AC-I08）；local 检测不受此限。
5. 单测（V-I02）：假网关三态（成功记延迟、401 记原文摘要、超时记超时）；落盘后重读一致；损坏文件自愈；full_local 拒绝路径零请求（以假网关计数证明）。

迭代验证：

```bash
# src-tauri/
cargo test --lib model_inspector
cargo test --lib ai::commands   # 以实际模块路径为准，含原 test_llm_connection 回归
```

完成条件：V-I02 全过；原连接测试行为与基线一致。对应 AC-I05、I08、I09（后端侧）。

## 5. TASK-I04：检视面板前端

负责文件：`src/components/settings/LlmProvidersPanel.tsx`（入口 + 面板，面板可拆子组件文件）、检视 store（并入 `src/stores/aiStore.ts` 或新文件）、`src/stubs/tauri-core.ts`、i18n 词条。

步骤：

1. 入口：每行展开区在测试连接旁加「模型检查」按钮（新 testid 按 qa-ui-auto 规范命名，TASK-I05 登记）；点击打开面板（沿现有展开/抽屉层级与焦点行为，不新开路由）。
2. 面板：汇总行（计数/目录时间/刷新/检测当前模型）+ 表格（设计 §4.1 列定义）；当前模型行置顶高亮；来源列文案四态（目录命中/别名映射/实时清单/目录未收录）；状态徽标中性文案；未知值 `—`；行数多（siliconflow）时以真实数据验证滚动与渲染流畅，出现卡顿再评估分页，不预先造优化。
3. 行动作：检测（进行中禁用重复点击、完成即以返回结果刷新该行并已由后端落盘）；设为当前模型（走现有配置保存链更新 model 字段，成功后行高亮迁移且设置行 model 显示同步）；「检测全部」按钮带明示文案（逐个发送测试请求），逐行更新、不可中途重复触发。
4. 状态与错误：加载中、目录失败保 last-good + 原因、local 不可用态、full_local 禁用态（检测禁用 + 注明）四种呈现齐全；空行集只在真正无数据时出现且带说明。
5. stub：新命令桩返回四类样本行（命中/别名/未收录/实时）与可变检测结果（按 model id 约定一例失败），供浏览器层走全状态；i18n 中英双份，无硬编码文案残留。

迭代验证：

```bash
# 仓库根目录
npx tsc --noEmit
pnpm exec vitest run src/components/settings src/stores
pnpm dev   # 浏览器层人工走查四类行与四种状态（stub 边界，如实记录）
```

完成条件：V-I03 全过；AC-I01/I06 的 UI 侧成立；面板不改变既有行展开区的控件与保存语义（与 TASK-I05 的保留回归互证）。对应 V-I03、V-I04（UI 侧）。

## 6. TASK-I05：测试、回归与真机交付

步骤：

1. 补齐并执行 V-I01～V-I04：新 browser case（标题拟 `provider-model-inspector`，编号按 `qa-ui-auto-tests/cases` 现状去重）覆盖打开检视、四类行呈现、检测一例（stub）、设为当前模型回显；同步 `qa-ui-auto-tests/ci/policy.yaml` 并跑 `python -m qa_ui_auto audit --gate`；新 testid 按既有工具更新目录。
2. 保留回归（AC-I09）：既有设置相关 case 与 Vitest 子集（改 key/改 model/测试连接/保存）全量跑相关文件并与基线对照；`test_llm_connection` 的 Rust 既有测试复跑。本项引入的退化在本任务内修复并补最小持久测试。
3. 三端兼容（V-I05）：审查 diff（无平台 API/硬编码路径/新第三方依赖）；`pnpm build` 与 `cargo check` 通过；推送前门禁全套执行一次（tsc、cargo check、audit、CI 工具自测，命令同仓库 AGENTS.md）。
4. 真机 V-I06（Linux 当前端）：按设计 §8 执行——7 个 provider 逐个开检视、anthropic 一行真检测、错 key 一行假检测、重启后结果仍在、local 两态、full_local 只读；证据入 `qa-ui-auto-report/model-inspector/`；Windows/macOS 整理接续清单标未验证。
5. 回填：设计 §9 与本文件状态表写实际结果；PR 说明含底座归属结论（与 Go 的先后与复用事实）、四类样本证据、保留回归对照、回退方式。

完成条件：V-I01～V-I06 中本轮应执行项全部有实际结果（其他端真机除外，标未验证）；AC-I07 若因 Go 未落地顺延，须在交付记录中显式注明补验条件。对应全部 AC-I 的交付侧。

## 7. 实施后的交付记录

当前所有项目为待执行；完成后填写实际值，不删除未覆盖项：

- 底座归属：与 Go 侧的先后事实、最终底座位置与复用方式。
- 验证结果：V-I01～V-I06 逐项结果与证据路径；选中/跳过计数；基线对照差异。
- 真机：Linux 端 V-I06 实际结果；Windows/macOS 未验证范围与接续条件。
- 改动范围：实际产品/测试文件；超出设计的小范围改动及必要性；新依赖（如有）及理由。
- 发布边界：子树快照与别名表的本次刷新记录；回退方式复述。
