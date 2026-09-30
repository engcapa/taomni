# IDEA Code Editor 对齐续办任务板

本板是 `docs-feature/code-workspace-idea-alignment` 批次的唯一任务来源。它基于 [2026-09-28 IDEA 实机参照](references/idea-live-audit-20260928.md) 和 [2026-09-29 控件级复核](references/idea-control-audit-20260929.md)，承接旧板未覆盖的整体编辑器对齐差距。旧板 `ED-PARITY-001..009` 的状态不迁移、不重开。

建议领取顺序：先做三个不依赖壳层重构的已确认缺陷切片（012 焦点归还、013 `Ctrl+Shift+A`/默认绑定/键名格式、015 Problems 空态），再做 010 → 011 → 020/014 → 021/022/016/017/018 → 019。

## 规划规则

- 所有新卡当前为 `deferred`，并标记 `p0.planning_required=true`；P1 完成 DEC/AC/V、参照和测试用例后才可转 `ready`。
- 一张卡只处理一个可演示用户结果，必须分别写清功能、交互、快捷键、视觉和保留行为。
- `different`、`unverified` 和“入口存在”都不是匹配通过。没有真实双侧观察的维度保持未验证。
- 当前 IDEA 参照为 Ultimate 2026.2.2 / IU-262.10315.125，窗口 1400×1000，Linux X11，深色主题；其他平台和设置组合单独记录。

## 本批次任务

### ED-PARITY-010 Code Workspace 壳层与工具窗口布局对齐
<!-- ide-task {"id":"ED-PARITY-010","status":"in_progress","priority":"P0","size":"L","depends_on":[],"spec":"docs-feature/code-workspace-idea-alignment/alignment-design.md#ed-parity-010","acceptance":["ED-PARITY-010-A1","ED-PARITY-010-A2","ED-PARITY-010-A3","ED-PARITY-010-A4"],"required_evidence":["code-audit","browser","native","accessibility","idea-comparison"],"audit":{"date":"2026-09-29","head":"06ef13d0","finding":"实机对比显示 IDEA 的左右工具栏、编辑器标签、底部工具窗和状态层级与 Taomni 当前壳层不同；旧 shell 设计未形成当前三维 matched 证据。 2026-09-29 控件级复核：见 references/idea-control-audit-20260929.md；左右 tool rail、Alt+数字/Shift+Esc、空编辑器提示和状态栏导航栏与 IDEA 不同。"},"prior_completion":{"kind":"new-task","completed":false},"p0":{"audit_id":"LIVE-IDEA-20260928","requirements":["REQ-03","REQ-04","REQ-10"],"scenarios":["CW-SHELL-001","CW-SHELL-003","CW-SET-001"],"planning_required":false},"updated_at":"2026-09-29T16:49:36Z","claimed_from":"ready","owner":"claude-20260930-010","claimed_at":"2026-09-29T16:49:36Z","baseline":"db9021b45317848b50866ad1af2ed52c1ecfb82d"} -->

目标：按 IDEA 的空间层级重组 Project、editor、左右 tool rail、bottom tool windows、toolbar 和 status，不丢失现有 workspace、工具数据、dirty 状态和 editor leaf。

参照：[总体设计](alignment-design.md#ed-parity-010) / [P1 设计与用例](ed-parity-010-shell-design.md) / [控件级复核 §1](references/idea-control-audit-20260929.md#shell)。

### ED-PARITY-011 编辑器表面、标签、面包屑与状态提示对齐
<!-- ide-task {"id":"ED-PARITY-011","status":"ready","priority":"P0","size":"M","depends_on":["ED-PARITY-010"],"spec":"docs-feature/code-workspace-idea-alignment/alignment-design.md#ed-parity-011","acceptance":["ED-PARITY-011-A1","ED-PARITY-011-A2","ED-PARITY-011-A3","ED-PARITY-011-A4"],"required_evidence":["code-audit","unit","browser","native","idea-comparison"],"audit":{"date":"2026-09-29","head":"06ef13d0","finding":"实机对比显示 IDEA 的 editor tab、breadcrumb、问题提示、代码区边界和滚动标记与 Taomni 当前 editor surface 信息密度不同。 2026-09-29 控件级复核：见 references/idea-control-audit-20260929.md；编辑区顶部两条常驻条、Go to File 打开 preview tab、无默认折叠、选区 AI 工具条遮挡代码。"},"prior_completion":{"kind":"new-task","completed":false},"p0":{"audit_id":"LIVE-IDEA-20260928","requirements":["REQ-03","REQ-04","REQ-11"],"scenarios":["CW-TAB-001","CW-TAB-002","CW-EDIT-005"],"planning_required":false},"updated_at":"2026-09-30T06:00:00Z"} -->

目标：统一编辑器标签、breadcrumb、代码区顶部通知、问题标记、字体/行高、选中/失焦和分屏表面，同时保留 preview、正式 tab、共享文档和 undo 契约。

参照：[总体设计](alignment-design.md#ed-parity-011) / [P1 设计与用例](ed-parity-011-editor-surface-design.md) / [IDEA 编辑器截图](../../qa-ui-auto-report/idea-reference/current-design-audit-20260928/idea-03-editor.png)。

### ED-PARITY-012 Find、Replace 与弹层焦点生命周期对齐
<!-- ide-task {"id":"ED-PARITY-012","status":"ready","priority":"P0","size":"M","depends_on":["ED-PARITY-010","ED-PARITY-011"],"spec":"docs-feature/code-workspace-idea-alignment/alignment-design.md#ed-parity-012","acceptance":["ED-PARITY-012-A1","ED-PARITY-012-A2","ED-PARITY-012-A3","ED-PARITY-012-A4"],"required_evidence":["code-audit","unit","browser","native","accessibility","idea-comparison"],"audit":{"date":"2026-09-29","head":"06ef13d0","finding":"IDEA 与 Taomni 都有编辑器内查找入口，但查找栏布局、按钮语义、Esc 后焦点和弹层 owner/快捷键穿透仍未完成双侧验证。 2026-09-29 控件级复核：见 references/idea-control-audit-20260929.md；Go to File/Recent/Structure/Search Everywhere/Keymap 对话框 Esc 后焦点落 BODY（CodeWorkspaceTab.tsx:21592/21607/21651）；Ctrl+R 焦点移到 Replace 框。"},"prior_completion":{"kind":"new-task","completed":false},"p0":{"audit_id":"LIVE-IDEA-20260928","requirements":["REQ-01","REQ-08"],"scenarios":["CW-SEARCH-001","CW-SEARCH-002","CW-SHELL-002"],"planning_required":false},"updated_at":"2026-09-30T08:00:00Z"} -->

目标：让 Ctrl/Cmd+F、Replace、Enter/Shift+Enter、Tab、Esc、外部点击和迟到结果拥有与 IDEA 一致的焦点归属、锚点、状态反馈和恢复路径。

参照：[总体设计](alignment-design.md#ed-parity-012) / [P1 设计与用例](ed-parity-012-find-focus-design.md) / [IDEA 查找截图](../../qa-ui-auto-report/idea-reference/current-design-audit-20260928/idea-04-find.png)。

### ED-PARITY-013 Keymap、冲突提示与平台快捷键对齐
<!-- ide-task {"id":"ED-PARITY-013","status":"in_progress","priority":"P0","size":"M","depends_on":[],"spec":"docs-feature/code-workspace-idea-alignment/alignment-design.md#ed-parity-013","acceptance":["ED-PARITY-013-A1","ED-PARITY-013-A2","ED-PARITY-013-A3","ED-PARITY-013-A4"],"required_evidence":["code-audit","unit","browser","native","accessibility","idea-comparison"],"audit":{"date":"2026-09-29","head":"06ef13d0","finding":"Taomni 已注册多项 IDEA 风格快捷键，但实机对比尚未证明冲突列表、Apply/Cancel、重开持久化、输入框保护、IME 和三端 Mod 映射与 IDEA 一致。 2026-09-29 控件级复核：见 references/idea-control-audit-20260929.md；Ctrl+Shift+A 未注册且后续输入替换编辑器选区；F12 与 IDEA 默认冲突；快捷键显示 ARROWLEFT/Meta+。"},"prior_completion":{"kind":"new-task","completed":false},"p0":{"audit_id":"LIVE-IDEA-20260928","requirements":["REQ-10","REQ-11"],"scenarios":["CW-SET-002","CW-SHELL-002","CW-NAV-001"],"planning_required":false},"updated_at":"2026-09-29T15:36:13Z","claimed_from":"ready","owner":"claude-20260930-013","claimed_at":"2026-09-29T15:36:13Z","baseline":"6763642b575f05295ceaca52d947006734e14dba"} -->

目标：把 Action Registry、Keymap 设置、冲突提示、取消/重开和 Ctrl/Meta/AltGr/IME 派发收敛到同一套 owner，并逐项校准 IDEA 绑定。

参照：[总体设计](alignment-design.md#ed-parity-013) / [P1 设计与用例](ed-parity-013-keymap-design.md) / [旧改键设计](../code-workspace-idea-parity/keymap-rebind-conflict-plan.md)。

### ED-PARITY-014 项目树、Search Everywhere 与导航入口对齐
<!-- ide-task {"id":"ED-PARITY-014","status":"ready","priority":"P1","size":"L","depends_on":["ED-PARITY-010","ED-PARITY-013"],"spec":"docs-feature/code-workspace-idea-alignment/alignment-design.md#ed-parity-014","acceptance":["ED-PARITY-014-A1","ED-PARITY-014-A2","ED-PARITY-014-A3","ED-PARITY-014-A4"],"required_evidence":["code-audit","unit","browser","native","provider","idea-comparison"],"audit":{"date":"2026-09-29","head":"06ef13d0","finding":"IDEA 的 Project、Go to File、Search Everywhere、Recent Files 和编辑器返回焦点已实机观察；Taomni 虽有对应入口，完整结果密度、预览、焦点和 provider 语义仍未闭合。 2026-09-29 控件级复核：见 references/idea-control-audit-20260929.md；Search Everywhere All 结果与查询无关并外露 provider 诊断；Recent Files 单列；File Structure 无降级大纲；Find in Files 无预览。"},"prior_completion":{"kind":"new-task","completed":false},"p0":{"audit_id":"LIVE-IDEA-20260928","requirements":["REQ-02","REQ-05"],"scenarios":["CW-PROJ-002","CW-NAV-001","CW-NAV-002","CW-NAV-004"],"planning_required":false},"updated_at":"2026-09-30T12:00:00Z"} -->

目标：统一树行密度、选择/展开/打开策略、Go to File、Search Everywhere、Recent Files、声明跳转和 Back 的入口、结果、焦点与取消行为。

参照：[总体设计](alignment-design.md#ed-parity-014) / [P1 设计与用例](ed-parity-014-navigation-design.md) / [IDEA 文件搜索截图](../../qa-ui-auto-report/idea-reference/current-design-audit-20260928/idea-02-file-search.png)。

### ED-PARITY-015 Java 工程就绪、补全与诊断反馈对齐
<!-- ide-task {"id":"ED-PARITY-015","status":"ready","priority":"P1","size":"L","depends_on":["ED-PARITY-010","ED-PARITY-011","ED-PARITY-013"],"spec":"docs-feature/code-workspace-idea-alignment/alignment-design.md#ed-parity-015","acceptance":["ED-PARITY-015-A1","ED-PARITY-015-A2","ED-PARITY-015-A3","ED-PARITY-015-A4"],"required_evidence":["code-audit","unit","typecheck","browser","native","provider","idea-comparison"],"audit":{"date":"2026-09-29","head":"06ef13d0","finding":"Taomni 实机隔离工程显示 Java language server degraded 与 Facts Failed；旧 Basic Completion 卡仅证明首包 provider 行为，未覆盖与 IDEA 的就绪态、候选布局、resolve 失败和诊断反馈整体对齐。 2026-09-29 控件级复核：见 references/idea-control-audit-20260929.md；Problems 在语言服务不可用时显示 No problems in open files（panels/ProblemsPanel.tsx:176）。"},"prior_completion":{"kind":"new-task","completed":false},"p0":{"audit_id":"LIVE-IDEA-20260928","requirements":["REQ-05","REQ-11"],"scenarios":["CW-LANG-001","CW-LANG-002","CW-LANG-004","CW-LANG-005"],"planning_required":false},"updated_at":"2026-09-30T10:00:00Z"} -->

目标：在真实 JDK/JDT LS 就绪、降级、加载、超时和恢复状态下，对齐补全候选、文档、参数信息、Problems/诊断和接受/撤销反馈。

参照：[总体设计](alignment-design.md#ed-parity-015) / [P1 设计与用例](ed-parity-015-java-readiness-design.md) / [旧补全设计](../code-workspace-idea-parity/java-basic-completion-plan.md)。

### ED-PARITY-016 Structural Search 对话框、结果树与过滤器对齐
<!-- ide-task {"id":"ED-PARITY-016","status":"ready","priority":"P1","size":"L","depends_on":["ED-PARITY-010","ED-PARITY-011","ED-PARITY-013"],"spec":"docs-feature/code-workspace-idea-alignment/alignment-design.md#ed-parity-016","acceptance":["ED-PARITY-016-A1","ED-PARITY-016-A2","ED-PARITY-016-A3"],"required_evidence":["code-audit","unit","typecheck","browser","native","provider","idea-comparison"],"audit":{"date":"2026-09-29","head":"ade7da19b630483449fc65da3da36df2f80751c8","finding":"Taomni Structural Search 首包与 IDEA 的 AST 结果集合有交集，但实机参照显示 IDEA 有独立对话框、Java/template/modifier/scope 控件和不同结果树；现有 comparison 明确为 unverified/different。"},"prior_completion":{"kind":"new-task","completed":false},"p0":{"audit_id":"LIVE-IDEA-20260928","requirements":["REQ-09"],"scenarios":["CW-SEARCH-003","CW-LANG-003"],"planning_required":false},"updated_at":"2026-09-30T14:00:00Z"} -->

目标：把 Search Structurally 的入口、模板编辑、语言/作用域、Count/Text/Reference/Type 状态、结果树、预览/导航、空态和取消行为做成可与 IDEA 逐项比较的体验。

参照：[总体设计](alignment-design.md#ed-parity-016) / [P1 设计与用例](ed-parity-016-structural-search-design.md) / [IDEA 结构搜索参照](references/idea-live-audit-20260928.md#structural-search)。

### ED-PARITY-017 Refactor Preview、Rename/Extract 与事务撤销对齐
<!-- ide-task {"id":"ED-PARITY-017","status":"deferred","priority":"P1","size":"L","depends_on":["ED-PARITY-011","ED-PARITY-014","ED-PARITY-015"],"spec":"docs-feature/code-workspace-idea-alignment/alignment-design.md#ed-parity-017","acceptance":["ED-PARITY-017-A1","ED-PARITY-017-A2","ED-PARITY-017-A3"],"required_evidence":["code-audit","unit","browser","native","provider","idea-comparison"],"audit":{"date":"2026-09-29","head":"ade7da19b630483449fc65da3da36df2f80751c8","finding":"旧 Rename/Extract 卡已交付局部功能，但本次目标要求的是 IDEA 风格 preview、冲突/失败反馈、跨文件修改可视性和一次事务撤销；旧卡没有关闭整个 refactor 场景。"},"prior_completion":{"kind":"new-task","completed":false},"p0":{"audit_id":"LIVE-IDEA-20260928","requirements":["REQ-06","REQ-11"],"scenarios":["CW-REFACTOR-001","CW-REFACTOR-002","CW-REFACTOR-003","CW-REFACTOR-004"],"planning_required":true},"updated_at":"2026-09-29T09:00:00Z"} -->

目标：统一 Rename、Extract Method、Safe Delete、Reformat/Optimize Imports 的候选/预览/提交/取消/失败/恢复和单次事务 undo，同时保护 dirty、外部变更和共享文档。

参照：[总体设计](alignment-design.md#ed-parity-017) / [旧 Extract 设计](../code-workspace-idea-parity/extract-method-plan.md)。

### ED-PARITY-018 Git、Run/Debug 与底部工具窗口上下文对齐
<!-- ide-task {"id":"ED-PARITY-018","status":"deferred","priority":"P1","size":"L","depends_on":["ED-PARITY-010","ED-PARITY-011","ED-PARITY-013"],"spec":"docs-feature/code-workspace-idea-alignment/alignment-design.md#ed-parity-018","acceptance":["ED-PARITY-018-A1","ED-PARITY-018-A2","ED-PARITY-018-A3"],"required_evidence":["code-audit","browser","native","provider","idea-comparison"],"audit":{"date":"2026-09-29","head":"ade7da19b630483449fc65da3da36df2f80751c8","finding":"Git 多仓库 diff 首包已验证部分数据隔离，但 IDEA 的 Git/Run/Debug/Terminal 工具窗口组织、返回编辑器、会话保持和完整快捷键仍未整体对齐。"},"prior_completion":{"kind":"new-task","completed":false},"p0":{"audit_id":"LIVE-IDEA-20260928","requirements":["REQ-07","REQ-04"],"scenarios":["CW-GIT-001","CW-GIT-002","CW-GIT-003","CW-RUN-001","CW-RUN-002","CW-RUN-005"],"planning_required":true},"updated_at":"2026-09-29T09:00:00Z"} -->

目标：按 IDEA 工具窗口上下文，对齐 Git Changes/Diff、Build/Run/Debug/Terminal 的打开、停留、返回编辑器、取消、迟到结果和会话保留，不扩大首包到远端发布。

参照：[总体设计](alignment-design.md#ed-parity-018) / [旧 Git/SSR 交接](../code-workspace-idea-parity/p1-remaining-unified-plan.md#p2-results)。

### ED-PARITY-019 三端可访问性、主题与最终 IDEA 对比收口
<!-- ide-task {"id":"ED-PARITY-019","status":"deferred","priority":"P0","size":"L","depends_on":["ED-PARITY-010","ED-PARITY-011","ED-PARITY-012","ED-PARITY-013","ED-PARITY-014","ED-PARITY-015","ED-PARITY-016","ED-PARITY-017","ED-PARITY-018","ED-PARITY-020","ED-PARITY-021","ED-PARITY-022"],"spec":"docs-feature/code-workspace-idea-alignment/alignment-design.md#ed-parity-019","acceptance":["ED-PARITY-019-A1","ED-PARITY-019-A2","ED-PARITY-019-A3"],"required_evidence":["code-audit","browser","native","accessibility","idea-comparison"],"audit":{"date":"2026-09-29","head":"ade7da19b630483449fc65da3da36df2f80751c8","finding":"现有卡分别记录当前端通过和其他平台未验证；本次需要一个组合收口任务，统一验证 Windows/macOS/Linux 的快捷键、焦点、缩放、主题、可访问性和代表性 IDEA comparison。"},"prior_completion":{"kind":"new-task","completed":false},"p0":{"audit_id":"LIVE-IDEA-20260928","requirements":["REQ-03","REQ-04","REQ-10","REQ-11"],"scenarios":["CW-SET-001","CW-SET-002","CW-SHELL-002","CW-SHELL-003"],"planning_required":true},"updated_at":"2026-09-29T09:00:00Z"} -->

目标：在功能任务完成后做组合验证，分别记录 Windows WebView2、macOS WKWebView、Linux WebKitGTK 的快捷键、IME、200% 缩放、焦点、主题、role/name/state、恢复和 IDEA 三维比较结论。

参照：[总体设计](alignment-design.md#ed-parity-019) / [验证范围](references/idea-live-audit-20260928.md#verification-boundary)。

### ED-PARITY-020 代码洞察弹层与无 provider 态对齐
<!-- ide-task {"id":"ED-PARITY-020","status":"ready","priority":"P0","size":"M","depends_on":["ED-PARITY-011","ED-PARITY-013"],"spec":"docs-feature/code-workspace-idea-alignment/alignment-design.md#ed-parity-020","acceptance":["ED-PARITY-020-A1","ED-PARITY-020-A2","ED-PARITY-020-A3"],"required_evidence":["code-audit","unit","typecheck","browser","native","provider","idea-comparison"],"audit":{"date":"2026-09-29","head":"06ef13d0","finding":"同 fixture 实测：IDEA 补全/Quick Doc/Parameter Info/Alt+Enter 均为结构化弹层；Taomni 无 provider 时在 calculator. 处弹出缓冲区单词列表（0、1、acme…）并向上遮挡代码，Quick Doc 与 Alt+Enter 只写截断状态栏。"},"prior_completion":{"kind":"new-task","completed":false},"p0":{"audit_id":"LIVE-IDEA-20260929","requirements":["REQ-05","REQ-11"],"scenarios":["CW-LANG-001","CW-LANG-002","CW-LANG-004"],"planning_required":false},"updated_at":"2026-09-30T11:00:00Z"} -->

目标：统一补全、补全文档、Quick Doc、Parameter Info、Intention 列表和错误 tooltip 的外观、位置、键盘与无 provider 态；不再用单词补全冒充成员补全。

参照：[总体设计](alignment-design.md#ed-parity-020) / [P1 设计与用例](ed-parity-020-code-insight-design.md) / [控件级复核 §5](references/idea-control-audit-20260929.md#code-insight)。

### ED-PARITY-021 右键菜单结构、顺序与可用态对齐
<!-- ide-task {"id":"ED-PARITY-021","status":"ready","priority":"P1","size":"M","depends_on":["ED-PARITY-013"],"spec":"docs-feature/code-workspace-idea-alignment/alignment-design.md#ed-parity-021","acceptance":["ED-PARITY-021-A1","ED-PARITY-021-A2","ED-PARITY-021-A3"],"required_evidence":["code-audit","unit","browser","accessibility","idea-comparison"],"audit":{"date":"2026-09-29","head":"06ef13d0","finding":"IDEA 编辑器菜单以 Show Context Actions 置顶、按剪贴板/导航/重构/VCS 分组并用子菜单与助记符；Taomni editorContextMenu.ts 平铺约 20 项且可用态不一致，EditorGroup.tsx 的 tab 菜单顺序不同、单 tab 时 Close Others 仍可用、菜单越过状态栏。"},"prior_completion":{"kind":"new-task","completed":false},"p0":{"audit_id":"LIVE-IDEA-20260929","requirements":["REQ-03","REQ-10"],"scenarios":["CW-TAB-001","CW-SHELL-002"],"planning_required":false},"updated_at":"2026-09-30T13:00:00Z"} -->

目标：编辑器、tab、项目树、工具窗 tab 的右键菜单按 IDEA 的分组、顺序、子菜单、助记符和禁用态重建，快捷键文本与可用态来自同一 Action Registry。

参照：[总体设计](alignment-design.md#ed-parity-021) / [P1 设计与用例](ed-parity-021-context-menus-design.md) / [控件级复核 §6](references/idea-control-audit-20260929.md#menus)。

### ED-PARITY-022 Gutter、滚动条标记与用法高亮对齐
<!-- ide-task {"id":"ED-PARITY-022","status":"deferred","priority":"P1","size":"L","depends_on":["ED-PARITY-011","ED-PARITY-015","ED-PARITY-018"],"spec":"docs-feature/code-workspace-idea-alignment/alignment-design.md#ed-parity-022","acceptance":["ED-PARITY-022-A1","ED-PARITY-022-A2","ED-PARITY-022-A3"],"required_evidence":["code-audit","unit","browser","native","provider","idea-comparison"],"audit":{"date":"2026-09-29","head":"06ef13d0","finding":"IDEA gutter 含 VCS 变更条（点击出行内 diff/Rollback/Commit this change）、运行三角菜单、灯泡，右侧 error stripe 显示错误/用法/TODO/查找刻度，caret 用法高亮与参数 inlay；Taomni browser 只有行号与折叠。"},"prior_completion":{"kind":"new-task","completed":false},"p0":{"audit_id":"LIVE-IDEA-20260929","requirements":["REQ-04","REQ-07"],"scenarios":["CW-EDIT-005","CW-GIT-001","CW-RUN-001"],"planning_required":true},"updated_at":"2026-09-29T09:00:00Z"} -->

目标：补齐 VCS 变更条与行内 diff、运行/调试 gutter、error stripe、caret 用法高亮、参数名 inlay 和默认折叠，并在数据不可用时不显示伪造标记。

参照：[总体设计](alignment-design.md#ed-parity-022) / [控件级复核 §2、§8](references/idea-control-audit-20260929.md#editor-surface)。

## 当前批次边界

本板不覆盖完整插件生态、所有语言、远端开发、全部 Git 发布动作、所有 IDEA 主题/DPI 组合、Code Vision（usages/作者 inlay）、Scratch、Injected Language、Coverage 高级功能、Services/Database/AI Chat 等 IDEA 右侧工具窗内容和多窗口拖拽。发现这些范围存在具体用户需求时新增独立卡并扩充分母。
