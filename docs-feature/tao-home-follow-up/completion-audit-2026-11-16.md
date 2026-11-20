# Tao Home follow-up 完成度复核

复核日期：2026-11-16。产品/runner 基线为 `c11a90e35` 所含实现；本轮只复核并更新文档，未修改产品、用例或运行新的测试。范围为本目录全部 7 份既有文件、主表 39 个稳定任务 ID（TH-001～032、MD-001～007），以及三模式/上下文补强和后续用户反馈。

**结论：尚未全部完成。** 最近一批用户反馈已有实现和具名测试，但原设计还存在实现缺口、商业 provider 未执行项及完整 AC 未覆盖的边界。主表 39 个任务均保留早期未勾选状态，与后续追加回执没有逐项收敛；不能据此认为 39 项都未开发，也不能由某个测试批次通过推定全部任务完成。

## 2026-11-17 本轮覆盖说明

用户随后优先要求修复 Markdown 导出和 Home 历史，并追加真实 OpenCode Agent 深测；本批进展与当前回执统一记录在 [verification-md-history-agent-2026-11-17.md](verification-md-history-agent-2026-11-17.md)。本页下面的版本、测试和商业请求状态均为 **11 月 16 日的历史审计基线**，不能替代新源码的验收。

本轮已实际发起 OpenCode Go / `deepseek-v4.1-flash` / thinking=max 商业请求，图片数字与颜色、文档问答已有真实成功证据。R13 Python 与 TypeScript 工程均完成九轮真实模型调用，实际交付代码、运行测试、注入故障、模型修复和功能扩展；最终分别 16/15 项测试通过，独立补充检查也通过，未手工修补生成工程。随后 HOME046 在真实 native 中复现分支会话丢失附件授权，`c4925d0a3` 已修复；R14 Linux 50 项 deterministic native 及 macOS 50 项 native 均已通过；Windows 52 项中 HOME045/046 因附件控件遮挡失败。附件控件、导出提示布局和快速回复历史保存均已继续修复，当前源码验收见下段 R16，不用 R13 或 R14 代替。本次授权为全任务累计 **100M tokens**，覆盖旧 50M 计划；R13 后已知完成用量累计 **1,097,910 tokens**，取消或缺失用量仍未知。旧审批拒绝与“未发起新请求”不再是当前阻塞。真实费用/预算持久化、工作流执行器、增量索引、安全审计和语音等原有设计缺口仍按本表跟踪，不能随本批修复一并标为完成。

R16 当前产品为 `dc6de5f80`，在 draw.io、Mermaid 查看、PDF 性能和共享 AI 设置之外，继续修复换行工具栏的导出提示遮挡和普通 provider 快速回复后的历史标题/配置保存。本地受影响单测 **60 文件 / 273 项通过**；三平台 browser 均 **46/46**，各含全部 **18 项 crash-regression**。匹配的 QA release 原生用例最终为 **Linux 54/54、Windows 54/54、macOS 52/52 通过**，各含全部 **22 项 crash-regression**。源码/构建/用例/配置/回执、产物及选集完整并集均已独立核验，索引为 `history-final-execution-coverage.json`。Windows 主批 **53/54** 中 AI009 在执行步骤前发生文档根节点准备超时；相同源码/用例的 AI009 加完整 crash 集合补跑 [44025575103](https://github.com/engcapa/taomni/actions/runs/44025575103) **23/23 通过**，未放宽超时或断言。Windows 最终 54 项为主批与补跑合并结果，原始失败及未明确归因的间歇启动问题均保留，不把原失败 workflow 改为通过。HOME045/046 当前仅声明 Linux/Windows native，不扩称 macOS 附件分支验收。原任务表的实现缺口和未验收范围继续保留。

### 当前范围与统计口径

原始主表共 **39 项**：**13 项具名范围已交付、11 项部分实现、15 项整体验收未齐**（含 TH-032）。这是原任务逐项复核的状态分布；验收未齐的任务已有主要实现，不能将此分布直接换算为代码完成百分比。本轮新增的 draw.io、Mermaid 查看器和 MD-008～011 等不计入这 39 项，也不以通过用例数替代全部原 AC 验收。

| 最近追加的要求 | 当前交付与边界 |
| --- | --- |
| 导出下拉、无工具栏滚动条、窄窗提示遮挡 | 已实现并通过受影响 browser/native 回归；重复导出保留真实点击与布局断言。 |
| 预览主题旁文案精简、记忆导出目录 | 已实现 tooltip 和跨格式的上次成功目录；取消或失败不更新目录记忆。 |
| 独立、可搜索 PDF 与性能优化 | 三平台原生复测完成，性能与逐页质量结果见 [性能记录](../markdown-drawio/pdf-performance-2026-11-17.md)。 |
| Word 图形与框中文字清晰度 | SVG 矢量、明确文字布局、600 DPI 回退和关闭 Office 自动压缩已实现；三平台实际文件经独立解析和 LibreOffice 渲染复核。当前 Microsoft Word 客户端视觉与完整版式矩阵仍待补验。 |
| Mermaid 右键、悬浮按钮与大图查看 | 已实现缩放/平移、100%、适应窗口/宽度、双向 90° 旋转、水平/垂直翻转、重置、背景切换、保存 SVG/PNG、复制图片/文字/源码，不使用 OCR。 |
| draw.io 导入导出与内容链接 | 已实现全文/全部图片、单 Sheet/每图独立 Sheet、可编辑正文表格，以及导入时选择布局或文字恢复并保留原始数据。此前流程/状态/类/ER 图的三平台回归完成；后续手测修复再加入可编辑时序图、默认无整体组合及保留原折线/曲线路由，新增源码验收见下段。其他未支持图族仍明确保留 SVG/源码并提示回退。 |
| History 保存、恢复与显示 | 本批已修流式更新、离开刷新、快速回复后的标题/provider/草稿，以及附件分支授权与恢复；具名回归通过。全部冷重启/旧迁移组合仍随 TH-004 验收。 |
| 合并 AI 设置、选择普通聊天 provider | 已实现共享保存及 OpenAI 兼容、Anthropic、本地模型等支持的聊天运行时；缺失 provider 不静默改路由。普通 provider 的原生附件/分支 HOME045/046 目前只验 Linux/Windows。 |
| 真实 OpenCode Agent 多场景与工程开发 | 指定模型/max 已有简单、多轮、图片/文档及 Python/TypeScript 各九轮真实开发证据，包含测试、注入失败、模型修复和功能扩展。Python/TS 最终各 16/15 项测试通过；商业 CC/Codex、完整长任务及语音等边界仍待验。 |

本次状态复核未新增商业请求或重跑产品用例；本页 R16 与 [最终验证记录](verification-md-history-agent-2026-11-17.md#r16-wrapped-export-notice-and-fast-reply-history) 指向已有的当前源码回执。深研/工作流真实执行、持久预算与费用确认、增量索引、本地结果导航、完整审计、长任务恢复等实现缺口仍在后文逐项跟踪。

后续优先六项（Git 用 Tao 打开、Workspace 命名/添加目标、导出产物用 Tao 打开、Query Result 搜索导航、Agnes 无代理）及其验收，独立记录在 [workspace-result-follow-up-2026-11-17.md](../workspace-result-follow-up-2026-11-17.md)。新反馈的 Mermaid 保存图标、可编辑时序/原线路由和重复导入按钮，记录在 [修复与验收](../../docs-issue/markdown-mermaid-editable-export-2026-11-17.md)。产品提交 `97e89ead9`、修正用例 `00696cf81`；本机 149 项 Markdown 单测通过，当前源码与用例的有效并集为 Linux/Windows/macOS browser 各 28/28（18 项 crash）、匹配 QA release 的 native 各 33/33（22 项 crash），Linux Agnes 另有 1/1 无代理真实回复。[原批次 44052981988](https://github.com/engcapa/taomni/actions/runs/44052981988) 的 023/026 失败原件保留，[修正后 44057813183](https://github.com/engcapa/taomni/actions/runs/44057813183) 成功结束，Windows/macOS native 各 25/25。签名、身份、配置与绑定文件散列独立复核通过；R16 是历史基线，原 39 项状态统计不因这些追加修复整体关闭。

用户随后用真实 `testing.md` 又报告 Word 流程图线身、draw.io 时序连接点与 Live 表格格式问题；追加修复和原文件 QA 验收见 [真实文档回归](../../docs-issue/markdown-mermaid-editable-export-2026-11-17.md#真实-testingmd-追加回归)。`b7f8252fc` 的本机验收及 [44113948966](https://github.com/engcapa/taomni/actions/runs/44113948966) 均已完成：三平台 browser 各 29/29（18 crash）、native 各 34/34（22 crash）。Linux 直接打开原文件，实际 draw.io Desktop 两图和 PDF/Word 逐页视觉已检查；Linux Word 使用 LibreOffice，不扩称 Win11 Microsoft Word 客户端验收。

## 2026-11-18 新增两项

`e07d7823b` 改为紧凑的 draw.io 原生曲线控制多边形；原文件长弧线从 87/101 个点降为 8/7 个，实际 Desktop 鼠标编辑、撤销及节点连接已验证。`839cda93d` 增加 [Explorer 明细列宽](../file-explorer/resizable-details-2026-11-18.md) 的四列拖动、双击适配、键盘调整、横滚对齐和持久化。Node 22.23.4 下受影响 unit 45 文件 / 293 项、独立导出检查器 16 项及 TypeScript/refactor/audit/开发契约均通过。

Linux 当前有效并集为 browser **34/34（18 crash）**、native **37/38（全部 22 crash 通过）**，新 006 与原文件 028 均通过；唯一保留失败为 005 的既有后台终端标签关闭交互。最终本机签名、源码/runner/build、用例/配置和全部绑定文件核验为 `independent-local-node22.json/.log`。Windows/macOS 最终具名补跑 [44153057201](https://github.com/engcapa/taomni/actions/runs/44153057201) 成功结束，两端 browser 各 19/19、native 各 23/23，八片均在 workflow 结束前下载。完整当前有效并集为三平台 browser 各 34/34、Linux/Windows native 各 37/38、macOS native 38/38，全部 crash 18/22 通过；两个 37/38 都仅保留同一个既有 005 失败。48 份报告及其绑定产物独立核验通过，入口为 `independent-three-platform-final.json/.log` 与 `final-selection-matrix.json`；原失败和验证边界统一在列宽专项记录。本次新增两项完成，原 39 项实现缺口及统计不改变。

Agnes 最近一次真实复验因服务端账户配额不足失败，明确返回 `Failed to pre-consume quota`（余额 $0.000814，所需 $0.000870）。该次为 `agnes-2.5-pro-beta` 且无代理；原始失败保留，不以之前成功的请求替代当前结果，也不重复消耗余额。工作流执行、持久预算、增量索引、审计和语音等旧任务仍未整体关闭。

## 历史变化：macOS native 已补齐原缺失项

[43886401191](https://github.com/engcapa/taomni/actions/runs/43886401191) 已成功结束。只选择 macOS native release，实际 **32 passed / 0 failed / 0 skipped**，包含此前缺失的全部 **21 项**及完整适用 **22 项 native crash-regression**。

已下载原始 selection、ci-summary、native summary/receipt、配置、build identity 和产物，独立核对回执签名、687 个绑定产物的字节数/SHA-256、32 项 selection/实际执行集合、当前源码/runner、每项 case 指纹、配置指纹和 QA release build 身份。全部匹配，`identity_stable=true`。另查看了历史删除确认框及 Markdown 深色预览代表截图。

- 测试提交：`2d8d0ff5b544669767238253493da48d78187bf5`；workflow 所在分支 HEAD 为 `c11a90e35`。
- source：`b48dea9e9aee3ac8981e03cded1e6bc5cc6674e9fd65565264adb06783755cf3`；runner：`05ea30cecb11dedbc74f98d32689872d7b6993ab11e2fda9ae60ccdd42b12283`。
- `com.taomni.app.qa`，Darwin / release，binary：`4c12e0ae53b4d9c4f18d4a6d6bbdddc5033235ade38fb7ed55b9894ecc6805ec`。
- 本机取证根：`qa-ui-auto-report/_local/h43886401191/`；独立核对：该目录 `independent-feedback-verification.json`。

因此，“macOS 剩余 21 项因 runner 容量未执行”已是历史状态。与此前记录的 macOS 20 项通过合并，原定 41 项已补齐；本轮没有重新下载全部历史 Windows/Linux/macOS 回执或重跑三平台合并 `status --gate`，不把上次失败的 gate 文件改写为成功。旧 `TC-auto-F12-1-vault-setup-and-lock` 本批实际通过，但 aggregate 仍列为 `unreviewed`，其 `reviewed`/`needs-review` 冲突仍需专门复核。

## 逐项复核

“具名范围已交付”表示已有实现和对应的具体行为证据；“验收未齐”表示不能据现有证据关闭整个原 AC；“部分实现”表示仍有可定位的实现缺口。表中证据包含此前文档已核对的历史批次，本轮未把这些旧批次重跑。Tao 用例编号省略 `TC-TAO-HOME-` 前缀。

| ID | 当前实现/验收状态 | 已有内容与未关闭边界 |
|---|---|---|
| TH-001 | 具名范围已交付 | Messages DTO、真实 Tauri IPC/HTTP 已贯通；002 的原生契约与历史真实 DeepSeek 请求均已有通过记录。 |
| TH-002 | 验收未齐 | 模型、thinking、工具块、usage、安全校验和新旧轨道已有实现；完整外部搜索/读链接与各 provider 事件组合尚未全部验收，不能沿用旧探针的读链接失败当作通过。 |
| TH-003 | 具名范围已交付 | 实时分片、服务端 socket 取消、错误/重试/继续和 Vault 恢复有 002/004/009 等 native 证据；新的商业 OpenCode 全集另列待验。 |
| TH-004 | 验收未齐 | SQLite snapshot、多轮、分支、旧历史共存、删除与过期加载保护已实现；完整冷重启、迁移及商业 provider 的 019/023 组合尚未结清。 |
| TH-005 | 具名范围已交付 | 复用旧目录 owner/comparator、最近会话排序选项及默认值、最近工作区排序和原打开路径；原 Welcome 恢复场景已从 History 入口复用。 |
| TH-006 | 具名范围已交付 | 顶栏可直接新建 Tao 对话，001 与 controller/历史用例保护原线程和草稿。 |
| TH-007 | 验收未齐 | 真实资源选择、显式引用/预览/移除和解绑清理已有实现；008/028 覆盖工作区与 Notes 路径，全部终端/数据库/来源组合尚未验收。 |
| TH-008 | 具名范围已交付 | 已修主入口浮层选择、外部点击、Escape、重复触发和焦点；001/003/008/031 等复用实际交互。 |
| TH-009 | 具名范围已交付 | 缺 executor、失败/拒绝/取消不会标成功；真实结果来自原生 action runner，025/032 覆盖副作用与取消。 |
| TH-010 | 验收未齐 | Home active/focus 所有权与前端重复派发已修；完整 macOS 系统按键送达、原生菜单及 IME 组合仍无完整具名证据。 |
| TH-011 | 部分实现 | 设置导航、Key 分流、provider/model/effort 默认值和线程覆盖已接通；费用确认参数目前只有设置/持久化，未接实际确认流程，完整安全中心也未实现。 |
| TH-012 | 具名范围已交付 | 中英文、平台快捷键文案、发送偏好、语言切换保留草稿及 browser 降级有实现与测试；macOS OS 输入边界仍沿 TH-010 跟踪。 |
| TH-013 | 部分实现 | 已修居中的四项快捷问答、侧栏避让、真实版本和用户最新顶栏决定；`SuggestionRow.tsx` 仍为固定四条文案，完整上下文建议与原型全部状态/尺寸对照未完成。 |
| TH-014 | 部分实现 | 侧栏八页签和主要入口已有实现；工作流页尚不能实际执行步骤，不能据页面存在关闭此完整 AC。最新顶栏以用户反馈为准。 |
| TH-015 | 具名范围已交付 | 演示模式/F9、历史/目录/绑定/引用隐藏规则有实现和用例，恢复不改底层记录。 |
| TH-016 | 验收未齐 | Markdown/代码/Mermaid、编辑/再生成/分支、三类交接入口已接；真实 ACP 子进程闭环已验，商业 CC/Codex 推理仍未验收。 |
| TH-017 | 验收未齐 | 来源/工具渲染、DeepSeek 工具协议与 Go 的真实搜索/HTTPS reader 已实现；本轮 Go fixture 未配置外部服务，只证明不可用分支，成功联网/自动读链接/继续回传仍须补证。 |
| TH-018 | 部分实现 | 文件选择、provider 隔离、内容复用、取消、面板外任务 owner 和任务状态持久化已接；长上传进度、应用重启后的在途任务恢复尚未闭环。现 `files.rs` 中上传过程字节仅从 0 跳至完成，不是完整连续进度。 |
| TH-019 | 验收未齐 | 本地 Dictation、可选 DeepSeek ASR/TTS、朗读/停止端口已有代码；实际麦克风、识别成功、音频播放和权限/设备失败尚无完整真机证据。 |
| TH-020 | 验收未齐 | ZIP v3 导入/导出和新线程写入有实现；022 商业集合未完成，损坏/重复/版本、事务回滚和各字段 round-trip 的完整验收仍须补齐。 |
| TH-021 | 部分实现 | usage 胶囊和调用用量明细已接；完整费用估算/价格来源与各 provider 汇总验收未齐，费用确认仍缺实际接线。 |
| TH-022 | 部分实现 | 单轮 usage 去重累计、50%/80% 提示和预算中止已有实现；费用再次确认未接，hydrate 将 runtime 预算重置为 0，未实现完整持久检查点预算续跑。 |
| TH-023 | 部分实现 | FTS、来源开关、短词/别名/日期、脱敏及多源工具已接；仍在主库全量重建，无独立增量 `tao_index.db`。搜索结果仅对 HTTP ref 提供“打开”，本地原记录导航也未接通。 |
| TH-024 | 验收未齐 | Dock 真实 session/目录/邮件/设置、Shell 选择和 Home 目录已接，031/033 与恢复用例有证据；管理员 UAC、安装 WSL 的实际分支及全部系统条件仍须具名验收。 |
| TH-025 | 部分实现 | 本地开发/测试/失败反馈/修复/扩展、审核、Undo、真实进程树取消已通过确定性 native 025/032；完整远端 terminal/全部执行器能力尚未接齐，商业开发闭环待验。 |
| TH-026 | 部分实现 | 五种定义、创建、列表和步骤表已存在；advance 只更新 completed/skipped，尚无实际步骤 executor、结果检查点与不重复副作用的重启恢复闭环。 |
| TH-027 | 部分实现 | 非空记忆/身份/技能管理、受控编辑、保存/取消/删除/导出和下一轮注入已有实现，034 已验管理路径；完整建议→确认创建、全入口及关联索引契约尚未关闭。 |
| TH-028 | 验收未齐 | command/SQL 写入脱敏、事务化旧历史迁移、计数和设置摘要已有代码/单测；实际旧数据磁盘迁移、可恢复性与正常参数误伤的完整验收证据未齐。 |
| TH-029 | 具名范围已交付 | Vault 锁定真实停止网络、保留收到内容、解锁后显式继续，009 和 037 有原生证据；遮罩取消保留受保护操作门禁。 |
| TH-030 | 部分实现 | 来源开关、预览/排除、脱敏/注入防护与后端绑定授权已有实现；完整 `tao_audit`、审计读删导出及安全中心未实现。 |
| TH-031 | 具名范围已交付 | 主设计无代理约定已勘误；共享代理解析与 `.no_proxy()`、应用/独立/直连路径有 002 原生证据；新增语音/附件所有网络分支仍随各自 AC 补验。 |
| TH-032 | 本批回归已补齐，整体验收未齐 | 原缺失 21 项 macOS native 已全部执行通过，Windows/Linux 原有通过保留；旧 F12 评审、商业验证、完整设计 AC 和三平台汇总 gate 尚未全部关闭。 |
| MD-001 | 具名范围已交付 | 共享 TOC 默认关闭，FILE013 及原生导出/取消用例有证据，保留手动开启。 |
| MD-002 | 验收未齐 | 共享 split 拖拽/键盘/最小宽度已实现，FILE013 当前 macOS native 已通过；Code Workspace/Notes 全入口、选区/Undo 等完整组合需补齐验收映射。 |
| MD-003 | 具名范围已交付 | Live 默认浏览、显式 Edit、硬只读优先、保存重开与实际任务写入有 FILE013 和 focused 单测保护。 |
| MD-004 | 验收未齐 | Notes Workspace 复用共享 Markdown owner，保留 noteId/保存适配及小 tao-chat；有 Notes 专项历史通过，完整浮窗/冲突/菜单/共享消费者组合尚未逐 AC 结清。 |
| MD-005 | 验收未齐 | 独立 auto/light/dark、真实 Mermaid 代表流程图及对比度已有 browser/native 证据；sequence/class/ER、中文长标签、显式 style/classDef、多实例/导出矩阵未全部验收。 |
| MD-006 | 验收未齐 | SVG + 约 300DPI 回退和 OOXML 尺寸 oracle 已实现；Word16 代表流程图 100%/200% 排版通过，不能覆盖全部长/宽/竖图、A4/Letter、方向和边距组合。 |
| MD-007 | 具名范围已交付 | 代表分数/上标单份 Office Math 已由 FILE004/007 与 Word16 OMaths=2 记录验证；支持范围仍以现有转换器为准，不扩称全 MathML 支持。 |

## 三模式与上下文补强任务

这些是 `agent-context-alignment.md` 对 TH 任务的细化，与上表有重叠，不重复相加为另一批已完成任务。

| 任务 | 结论 |
|---|---|
| TASK-CTX01 | 来源别名、时间、会话协议/分组元数据与短词已实现；所有 session/过滤/删除组合的完整端到端验收仍未齐。 |
| TASK-CTX02 | 多库只读连接器及 opt-in 来源已实现；独立增量索引、所有来源的同步/权限/错误全组合未完成。 |
| TASK-CTX03 | 显式资料预览/移除、条数/字符限额、功能目录和真实文件工具已有 028 证据；本地原记录“打开”尚未接。 |
| TASK-MODE01 | 问只读、做确认/拒绝/失败/Undo 与后端绑定授权已交付确定性 native 流程；商业推理不由该结果替代。 |
| TASK-MODE02 | 尚未完成真实深研计划、阶段结果、预算/取消/恢复和报告交付状态机。 |
| TASK-GO01 | provider/model/max 持久化及协议接入已有实现与 deterministic 验证；完整商业 native 复跑未完成。 |
| TASK-GO02 | 图片实际载荷、文档提取、provider 隔离和错误恢复已有实现；商业图片/文档与长任务完整验收未完成。 |
| TASK-DEV01 | loopback 的真实本机文件/进程开发闭环已通过；024/030 等商业模型从 0 到 1 工程流程未执行完成。 |
| TASK-DEV02 | 原生 ACP 真实子进程、持久化、返回 Tao/显式继续已验；商业 CC/Codex 模型执行仍未验证。 |

上表与以下源码缺口保留 11 月 16 日复核时的范围；其中商业执行状态已由 11 月 17 日的实测更新：TASK-GO01 的指定 provider/model/max、TASK-GO02 的代表图片/文档路径，以及 TASK-DEV01 的 Python/TypeScript 开发闭环均已有真实 QA release 证据，详见本页“本轮覆盖说明”和 [11 月 17 日验证记录](verification-md-history-agent-2026-11-17.md)。完整长任务矩阵、CC/Codex 商业执行和未列举的设计 AC 仍未全部验收。旧记录中的审批拒绝不再是当前阻塞；当前授权为累计 100M tokens，也不等同于产品已实现持久预算状态机。

## 关键实现缺口的源码依据

| 缺口 | 当前源码依据 |
|---|---|
| 工作流没有实际执行步骤 | `src-tauri/src/deepseek_app/workflow.rs:105` 的 advance 只读状态并更新步骤/run 表；`src/components/tao/ai-chat/WorkflowPanel.tsx` 的开始动作只创建 pending run。 |
| 费用设置没有控制执行 | `cost_confirm_threshold_cny` 仅见配置默认值/持久化与 Settings 输入；`src/components/tao/home/TaoHomeHost.tsx:29` 仍固定传入 0.5，未找到费用阈值确认的调用路径。 |
| 重启后的预算续跑未实现 | `src/components/tao/ai-chat/controller.ts:399` hydrate 为每个线程重建 `usedTokens: 0` 的 runtime；工作流也没有真实阶段结果执行器。 |
| 检索仍全量重建 | `src-tauri/src/deepseek_app/search.rs:144` 的 synchronize 在主库连接执行 `DELETE FROM ds_app_search` 再重新收集插入；产品源码未见独立 `tao_index.db` 或 `last_indexed_at` 水位。 |
| 本地检索结果不能打开原记录 | `src/components/tao/search/SearchPanel.tsx` 仅在 `result.ref.startsWith("http")` 时提供打开链接，没有本地 note/session/thread 的导航 adapter。 |
| 完整安全中心未实现 | 已有 `TaoPrivacySettings.tsx` 的来源开关与迁移摘要；产品源码未见设计要求的 `tao_audit` 或审计读删导出链路。 |
| 长上传的进度和重启恢复未闭环 | `src-tauri/src/deepseek_app/files.rs` 的上传进度只在开始/结束写入 0/总字节，任务表读取只返回存储 JSON；不能据此声称真实连续进度和重启后续传。 |

## 仍须推进的工作

1. 深研及五类工作流的实际执行器、真实阶段结果、取消/失败/重启检查点（TH-026、TASK-MODE02）。
2. 预算/费用阈值的真实确认与持久续跑，设置到执行的接线（TH-011/021/022）。
3. 独立增量索引、本地原记录导航、全部存储来源，以及完整审计/安全中心（TH-023/028/030）。
4. 在已有 OpenCode Go / deepseek-v4.1-flash / max 图片、文档和 Python/TypeScript 工程实测基础上，按具名 AC 补齐尚未覆盖的商业长任务路径；真实 CC/Codex、语音、管理员/WSL 条件分支按各自边界验收。
5. 文件长任务进度与重启恢复；完整原型状态/窗口/主题和 Markdown/Notes/Word 矩阵。
6. 复核旧 F12 的评审元数据并按新 case 身份执行；恢复所需原始历史报告后再做三平台合并 gate，不改写旧失败/阻塞证据。

## 本目录记录应如何阅读

- `development-tasks.md` 的初始 checkbox、2A/7 节及早期“最新批次”是历史快照；第 9～11 节和本复核记录更晚。
- `native-expansion-2026-11-16.md` 的 DeepSeek 2M 计划已被后续 OpenCode Go 50M 授权覆盖；其诊断通过/失败仍按当时输入保存，未取得完整新商业全集通过。
- `agent-context-alignment.md` 的“基线代码核对”是开发前基线，不能把全部旧缺口当成当前仍缺；但其深研、增量索引等缺口经本轮源码确认仍存在。
- `button-action-coverage.md` 是行为映射，不能替代执行回执；大部分新增按钮路径已验，环境条件能力仍有缺口。
- `verification-history-vault-2026-11-16.md` 保留历史失败和 runner 阻塞，最新补跑结果已追加；这只关闭对应执行缺口，不关闭本表所有设计任务。

历史证据迁移另有缺失：原 Windows `_local` 回执/日志未随代码带入，主表原有 `evidence/user-feedback-2026-11-15.png` 链接在当前 Linux checkout 也不存在。本轮只新增的链接均已校验，不把缺失的历史图片当作当前可查看证据。

11 月 16 日首次复核仅检查文档、源码和既有回执；11 月 17 日补充已实际构建、运行并独立核验产品证据，新增回归及最新输入范围见 [11 月 17 日验证记录](verification-md-history-agent-2026-11-17.md)。历史失败和未完成需求均保留。
