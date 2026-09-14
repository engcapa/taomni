# Code Workspace 总能力矩阵

唯一有效整体场景矩阵：`AUDIT-20260913-01`，2026-09-13首次建立。总需求见 [overall audit plan](overall-audit-plan-20260913.md)，入口见 [index](index.md)。此处是需求与证据结论，不是开发任务状态表。

## 分母、结论与共同身份

整体需求目录为 **45 个稳定场景 / 11 个能力域 / 135 个功能、视觉、交互维度**。这是首次明确分母，不宣称枚举完所有IDEA动作。语言/provider/edition/平台变体见 [fixture catalog](references/fixture-catalog.md)，尚未量化的扩展不会计作已对齐。没有总体对齐百分比。

所有场景共同继承：`main` / HEAD `27f99b6116f4f6aae906d324cb84e8359695e17a`、起始干净、当前源码/runner/case/config/build identity [provenance](evidence/provenance-20260913.json)；本轮源码审查时间为2026-09-13。生产链的具体文件、符号和hash见 [source audit](source-audit.md) / [source map](evidence/source-map-20260913.json)。

Taomni T0 = [本轮browser基线](references/taomni-baseline-20260913.md)，Bxx 是该基线的逐状态编号；Windows/Chromium153/Vite开发态/stubs/F0/1400×992/DPR1，只有列出的已执行子动作是 current。没有Bxx的交互为 unverified；candidate case从未在本轮执行。全体native/实际磁盘/LSP/DAP/IME证据缺失。Windows native旧tree receipt是stale；其他历史报告保留historical，不臆测均stale。Linux/macOS本轮unverified。

IDEA I0 = [REF-TREE-2026-09-13](references/project-tree-navigation-2026.2.2.md)，IU-262.10315.125 / Ultimate / Windows / New UI深色，08:31–08:36原始采样。原图准确路径与hash、限定复用状态及本轮焦点阻塞见 [IDEA对照摘要](references/idea-comparison-audit-20260913.md)。其他场景没有同fixture真实参照即待采；安装版本和源码不是参照。

五态只用于对应维度：已对齐 / 部分对齐 / 未实现 / 待验证 / 不可比较。静态确认无生产引擎单列“能力缺失”，双侧观测不齐时不把三维强行写成未实现或已对齐。功能通过不能替代视觉或交互。优先级P0/P1/P2是需求排序，和协作入口P1/P2/P5不是同一编码。

共同必须保留契约 K0：正确的保存、撤销、取消、恢复；已有正确功能和数据兼容；Windows/macOS/Linux代码兼容。每行另列有区分性的保留断言；UI/组件/动作可以重组，不要求保留现有布局。

关联规格/旧卡只提供各自原范围的来源与保留合同，不代表覆盖该场景全部目标。例如 ED-TREE-001 的键盘合同不能替代新建模板、多根或删除恢复的完整验收。candidate case 也是补证候选，不表示已包含本行全部步骤。

## 总览

| 稳定ID | 能力域 / 用户场景 | 功能 | 视觉 | 交互 | 差距性质 / 需求 |
|---|---|---|---|---|---|
| [CW-PROJ-001](#cw-proj-001) | 项目树 / 打开项目、多根与 loose file | 待验证 | 待验证 | 待验证 | 纯证据缺口；待归因风险 / [REQ-03](overall-audit-plan-20260913.md#req-03) |
| [CW-PROJ-002](#cw-proj-002) | 项目树 / 项目树选择、展开、打开与编辑焦点 | 部分对齐 | 不可比较 | 部分对齐 | 视觉/交互体验差异；native 证据缺口 / [REQ-02](overall-audit-plan-20260913.md#req-02) |
| [CW-PROJ-003](#cw-proj-003) | 项目树 / 新建、重命名、删除与树菜单 | 待验证 | 待验证 | 待验证 | 纯证据缺口；菜单目标待验证 / [REQ-02](overall-audit-plan-20260913.md#req-02) |
| [CW-PROJ-004](#cw-proj-004) | 项目树 / 树视图、过滤、隐藏与刷新 | 待验证 | 待验证 | 待验证 | 纯证据缺口；视图映射待决 / [REQ-03](overall-audit-plan-20260913.md#req-03) |
| [CW-TAB-001](#cw-tab-001) | 标签与分屏 / 预览、固定、关闭策略与溢出 | 待验证 | 待验证 | 待验证 | 纯证据缺口；体验差异待验证 / [REQ-04](overall-audit-plan-20260913.md#req-04) |
| [CW-TAB-002](#cw-tab-002) | 标签与分屏 / 递归分屏、移动 tab 与独立视图 | 待验证 | 待验证 | 待验证 | 纯证据缺口 / [REQ-04](overall-audit-plan-20260913.md#req-04) |
| [CW-TAB-003](#cw-tab-003) | 标签与分屏 / MRU 切换、关闭与重开标签 | 待验证 | 待验证 | 待验证 | 纯证据缺口 / [REQ-04](overall-audit-plan-20260913.md#req-04) |
| [CW-TAB-004](#cw-tab-004) | 标签与分屏 / 重启恢复工作区与视图 | 待验证 | 待验证 | 待验证 | 纯证据缺口；恢复入口待验证 / [REQ-04](overall-audit-plan-20260913.md#req-04) |
| [CW-EDIT-001](#cw-edit-001) | 编辑与输入 / 日常输入、多光标与结构编辑 | 待验证 | 待验证 | 待验证 | 纯证据缺口；语法适配边界 / [REQ-11](overall-audit-plan-20260913.md#req-11) |
| [CW-EDIT-002](#cw-edit-002) | 编辑与输入 / 剪贴板历史、粘贴与 IME | 待验证 | 待验证 | 待验证 | 纯证据缺口 / [REQ-11](overall-audit-plan-20260913.md#req-11) |
| [CW-EDIT-003](#cw-edit-003) | 保存与恢复 / 保存、编码、换行和规范化 | 待验证 | 待验证 | 待验证 | 纯证据缺口 / [REQ-11](overall-audit-plan-20260913.md#req-11) |
| [CW-EDIT-004](#cw-edit-004) | 保存与恢复 / 外部冲突与 Local History 恢复 | 待验证 | 待验证 | 待验证 | 纯证据缺口 / [REQ-11](overall-audit-plan-20260913.md#req-11) |
| [CW-EDIT-005](#cw-edit-005) | 编辑与输入 / 折叠、选区扩展、文档呈现与大文件 | 待验证 | 待验证 | 待验证 | 纯证据缺口 / [REQ-11](overall-audit-plan-20260913.md#req-11) |
| [CW-NAV-001](#cw-nav-001) | 导航与查询 / Search Everywhere / File / Class / Symbol / Action | 待验证 | 待验证 | 待验证 | 纯证据缺口 / [REQ-05](overall-audit-plan-20260913.md#req-05) |
| [CW-NAV-002](#cw-nav-002) | 导航与查询 / 声明、类型、实现与依赖源码导航 | 待验证 | 待验证 | 待验证 | 纯证据缺口；provider限制待验证 / [REQ-05](overall-audit-plan-20260913.md#req-05) |
| [CW-NAV-003](#cw-nav-003) | 导航与查询 / Find / Show Usages 与 Call / Type Hierarchy | 待验证 | 待验证 | 待验证 | 纯证据缺口；完整性待证 / [REQ-05](overall-audit-plan-20260913.md#req-05) |
| [CW-NAV-004](#cw-nav-004) | 导航与查询 / Recent Locations、书签、结构与导航条 | 待验证 | 待验证 | 待验证 | 纯证据缺口 / [REQ-05](overall-audit-plan-20260913.md#req-05) |
| [CW-SEARCH-001](#cw-search-001) | 查找替换 / 文件内查找替换与焦点返回 | 待验证 | 待验证 | 待验证 | 确认产品缺陷（browser renderer）；其余纯证据缺口 / [REQ-01](overall-audit-plan-20260913.md#req-01) |
| [CW-SEARCH-002](#cw-search-002) | 查找替换 / 项目查找、范围与批量替换预览 | 待验证 | 待验证 | 待验证 | 纯证据缺口 / [REQ-08](overall-audit-plan-20260913.md#req-08) |
| [CW-SEARCH-003](#cw-search-003) | 查找替换 / Structural Search / Replace | 待验证 | 待验证 | 待验证 | 能力缺失（源码）；目标行为待采 / [REQ-09](overall-audit-plan-20260913.md#req-09) |
| [CW-LANG-001](#cw-lang-001) | 语言服务与诊断 / SDK、导入、索引状态与服务恢复 | 待验证 | 待验证 | 待验证 | 纯证据缺口；环境限制 / [REQ-05](overall-audit-plan-20260913.md#req-05) |
| [CW-LANG-002](#cw-lang-002) | 语言服务与诊断 / Basic Completion、导入、snippet 与接受/撤销 | 待验证 | 待验证 | 待验证 | 纯证据缺口 / [REQ-05](overall-audit-plan-20260913.md#req-05) |
| [CW-LANG-003](#cw-lang-003) | 语言服务与诊断 / Smart / Type-Matching 与 Full Line | 待验证 | 待验证 | 待验证 | 能力缺失（源码）；edition/provider待决 / [REQ-09](overall-audit-plan-20260913.md#req-09) |
| [CW-LANG-004](#cw-lang-004) | 语言服务与诊断 / Quick Documentation、参数、类型信息与 inlay | 待验证 | 待验证 | 待验证 | 纯证据缺口 / [REQ-05](overall-audit-plan-20260913.md#req-05) |
| [CW-LANG-005](#cw-lang-005) | 语言服务与诊断 / 诊断、Inspection 与 Quick Fix | 待验证 | 待验证 | 待验证 | 能力语义差异待验证；纯证据缺口 / [REQ-06](overall-audit-plan-20260913.md#req-06) |
| [CW-REFACTOR-001](#cw-refactor-001) | 重构与代码动作 / Rename 符号、文件与跨文件恢复 | 待验证 | 待验证 | 待验证 | 纯证据缺口；provider完整性风险 / [REQ-06](overall-audit-plan-20260913.md#req-06) |
| [CW-REFACTOR-002](#cw-refactor-002) | 重构与代码动作 / Extract / Inline / Change Signature / Move | 待验证 | 待验证 | 待验证 | provider能力差距待验证；纯证据缺口 / [REQ-06](overall-audit-plan-20260913.md#req-06) |
| [CW-REFACTOR-003](#cw-refactor-003) | 重构与代码动作 / Safe Delete 与完整引用检查 | 待验证 | 待验证 | 待验证 | 能力限制（源码）；纯证据缺口 / [REQ-06](overall-audit-plan-20260913.md#req-06) |
| [CW-REFACTOR-004](#cw-refactor-004) | 重构与代码动作 / Reformat、Optimize Imports、Rearrange 与 Cleanup | 待验证 | 待验证 | 待验证 | 能力限制；纯证据缺口 / [REQ-06](overall-audit-plan-20260913.md#req-06) |
| [CW-REFACTOR-005](#cw-refactor-005) | 重构与代码动作 / Live / Postfix Templates、Surround、Generate 与 Complete Statement | 待验证 | 待验证 | 待验证 | 语义差异待验证；纯证据缺口 / [REQ-06](overall-audit-plan-20260913.md#req-06) |
| [CW-GIT-001](#cw-git-001) | Git / Git 状态、gutter、blame 与 diff | 待验证 | 待验证 | 待验证 | 纯证据缺口 / [REQ-07](overall-audit-plan-20260913.md#req-07) |
| [CW-GIT-002](#cw-git-002) | Git / 变更选择、Stage / Commit 与取消 | 待验证 | 待验证 | 待验证 | 纯证据缺口；目标设置待决 / [REQ-07](overall-audit-plan-20260913.md#req-07) |
| [CW-GIT-003](#cw-git-003) | Git / 分支、日志、比较与多根上下文 | 待验证 | 待验证 | 待验证 | 纯证据缺口 / [REQ-07](overall-audit-plan-20260913.md#req-07) |
| [CW-GIT-004](#cw-git-004) | Git / Merge / Rebase / Cherry-pick 冲突与恢复 | 待验证 | 待验证 | 待验证 | 纯证据缺口；跨入口集成待归因风险 / [REQ-07](overall-audit-plan-20260913.md#req-07) |
| [CW-RUN-001](#cw-run-001) | Build / Run / Debug / Test / 导入后 Build / Rebuild / 任务定位 | 待验证 | 待验证 | 待验证 | 纯证据缺口 / [REQ-07](overall-audit-plan-20260913.md#req-07) |
| [CW-RUN-002](#cw-run-002) | Build / Run / Debug / Test / Run configuration、运行输出与停止 | 待验证 | 待验证 | 待验证 | 纯证据缺口；browser模式限制 / [REQ-07](overall-audit-plan-20260913.md#req-07) |
| [CW-RUN-003](#cw-run-003) | Build / Run / Debug / Test / 断点、步进、变量、Watch 与会话恢复 | 待验证 | 待验证 | 待验证 | 纯证据缺口；adapter/edition边界 / [REQ-07](overall-audit-plan-20260913.md#req-07) |
| [CW-RUN-004](#cw-run-004) | Build / Run / Debug / Test / 测试树、失败重跑与 Coverage | 待验证 | 待验证 | 待验证 | 纯证据缺口；执行关联待验证 / [REQ-07](overall-audit-plan-20260913.md#req-07) |
| [CW-RUN-005](#cw-run-005) | Build / Run / Debug / Test / 内置终端、工作目录与焦点切换 | 待验证 | 待验证 | 待验证 | 纯证据缺口 / [REQ-07](overall-audit-plan-20260913.md#req-07) |
| [CW-SET-001](#cw-set-001) | 设置与快捷键 / 外观、密度、主题、字号与可访问性 | 待验证 | 待验证 | 待验证 | 纯证据缺口；视觉不可比较条件 / [REQ-03](overall-audit-plan-20260913.md#req-03) |
| [CW-SET-002](#cw-set-002) | 设置与快捷键 / Keymap、快捷键冲突与动作可发现性 | 待验证 | 待验证 | 待验证 | 纯证据缺口 / [REQ-10](overall-audit-plan-20260913.md#req-10) |
| [CW-SET-003](#cw-set-003) | 设置与快捷键 / Code Style、EditorConfig 与设置作用域 | 待验证 | 待验证 | 待验证 | 纯证据缺口 / [REQ-10](overall-audit-plan-20260913.md#req-10) |
| [CW-SHELL-001](#cw-shell-001) | 布局与动作 / 整体布局、Tool Windows、菜单与状态栏 | 待验证 | 待验证 | 待验证 | 视觉/交互体验差异待验证；纯证据缺口 / [REQ-03](overall-audit-plan-20260913.md#req-03) |
| [CW-SHELL-002](#cw-shell-002) | 布局与动作 / 弹层、菜单与编辑器焦点生命周期 | 待验证 | 待验证 | 待验证 | 确认产品缺陷（搜索focus链）；其余纯证据缺口 / [REQ-01](overall-audit-plan-20260913.md#req-01) |
| [CW-SHELL-003](#cw-shell-003) | 布局与动作 / 多工作区、跨窗口与三端恢复 | 待验证 | 待验证 | 待验证 | 纯证据缺口；跨窗口能力待决 / [REQ-04](overall-audit-plan-20260913.md#req-04) |

本轮有局部实际UI动作/状态记录的场景 **16/45**；其余 **29/45** 仅静态核对与补采规格。仅CW-PROJ-002有足以判定部分行为的双侧子样本；0个场景三维完整通过。此计数表示取证范围，不表示一致程度。所有“待验证”的缺失状态仍属于分母。

## 逐场景契约、证据和需求

<a id="cw-proj-001"></a>

### CW-PROJ-001 — 打开项目、多根与 loose file

- **IDEA目标结果：** 能辨认项目/root/source/library，打开与关闭项目不丢文件；空/加载/失败有恢复入口。目标为需求；除I0明确事实外，细节未冒充实测。
- **Fixture / 入口：** [F0/F2](references/fixture-catalog.md)；Tools → Code workspace… → Add folder / Open file。
- **完整采样序列（未列为已执行的步骤均待采）：** 空工作区→添加 F0→展开 root→打开 README→再加第二 root/loose file→取消选择器→移除 root→重开。每次保存初始/关键状态/退出后的原图或录屏，分别记录focus、caret/selection、菜单/弹层、错误、取消、undo与恢复；不适用项说明原因。
- **当前生产链 / 用户观察点：** Tools → Code workspace… → Add folder / Open file → MainLayout → CodeWorkspaceTab → ProjectTree / handleTreeKeyDown → navigateProjectTree 或 useWorkspaceFileActions → useWorkspaceTreeData → workspace_list_dir / workspace_read_file / 资源事务 → 树行、tabs、正文。具体caller/符号/IPC与源文件：[S-TREE](source-audit.md#tree)。
- **状态owner / IPC-provider：** codeWorkspaceStore 的 treeSelection / expandedRootIds / expandedDirKeys；目录缓存与 file actions 在 shell/hooks。MainLayout → CodeWorkspaceTab → ProjectTree / handleTreeKeyDown → navigateProjectTree 或 useWorkspaceFileActions → useWorkspaceTreeData → workspace_list_dir / workspace_read_file / 资源事务 → 树行、tabs、正文。真实provider、native build与OS边界未执行时保持unverified。
- **当前实现与实际观测：** 已实拍空工作区、添加 F0、README；browser path prompt 和 Facts Failed 不代表 native chooser/import；第二 root、取消与重开未采。
- **独立结论：** 功能 **待验证**；视觉 **待验证**；交互 **待验证**。不输出百分比。
- **Taomni证据与当前性：** [B01](../../qa-ui-auto-report/overall-audit-20260913/browser/01-empty-workspace.png) / [B02](../../qa-ui-auto-report/overall-audit-20260913/browser/02-readme-open.png)。共用身份T0/provenance；原始日志、snapshot与具体焦点记录见baseline。未采正常/失败/取消/恢复状态仍缺失，已有case仅候选：[TC-IDE-TREE-01-project-tree-keyboard-native](../../qa-ui-auto-tests/cases/TC-IDE-TREE-01-project-tree-keyboard-native.testcase.yaml)（本轮未运行）。
- **IDEA证据 / 环境 / 状态：** 待采：目标IU-262.10315.125，按本行fixture与步骤采同状态；本机只有I0项目树局部参照，不能跨场景复用。build/主题/scale/font/keymap/语言provider边界见IDEA对照摘要。
- **差异性质：** 纯证据缺口；待归因风险。缺证据本身不是产品bug；没有真实双侧支持的目标差异保留待验证。
- **需求 / 影响 / 方向：** [REQ-03](overall-audit-plan-20260913.md#req-03)，P1：贯穿全部能力，决定空间利用与可发现性；需要先锁定真实UI设置。先采匹配主题/scale/font，再细化tool-window位置、层级、密度、选中/失焦、菜单溢出；不先写假token。进入条件/依赖：目标环境就绪；SHELL/SET/TREE消费者清单；用户未接受任何有限差异。
- **必须保留：** K0；移除 root 不删除磁盘；多根/loose file 数据兼容；取消不改打开文件。后续验收必须观察这些结果，不能只写“保持原功能”。
- **规格与任务来源：** [project-tree-keyboard-idea-alignment-design.md](../../docs-issue/project-tree-keyboard-idea-alignment-design.md)；[code-workspace-idea-parity-backlog-2026-09-tree-e2e.md](../../claudedocs/code-workspace-idea-parity-backlog-2026-09-tree-e2e.md) `ED-TREE-001`（原记录 2026-09-13T01:30:00Z）。旧卡不重开；新观察需求尚未author/领取任务。
- **上次结论 / 本次变化：** 首次整体场景结论，无上一轮同ID三维判定；本轮新增目标、静态生产链和上述实际子样本。历史卡原验收及日期仅按原链接保留，未作为本轮PASS。当前判断日期2026-09-13；没有双侧新观测关闭差距。

<a id="cw-proj-002"></a>

### CW-PROJ-002 — 项目树选择、展开、打开与编辑焦点

- **IDEA目标结果：** 方向键只导航；目录标签选择与展开动作按 IDEA 设置；Enter 打开文件并将焦点交给编辑器。目标为需求；除I0明确事实外，细节未冒充实测。
- **Fixture / 入口：** [F0](references/fixture-catalog.md)；Project tree treeitem；handleTreeKeyDown / onClick。
- **完整采样序列（未列为已执行的步骤均待采）：** README 唯一 tab→docs 单击/Right/Right/Left/Left→src/main→Down 选择 example→Enter→核对 caret→右键/Esc→回树。每次保存初始/关键状态/退出后的原图或录屏，分别记录focus、caret/selection、菜单/弹层、错误、取消、undo与恢复；不适用项说明原因。
- **当前生产链 / 用户观察点：** Project tree treeitem；handleTreeKeyDown / onClick → MainLayout → CodeWorkspaceTab → ProjectTree / handleTreeKeyDown → navigateProjectTree 或 useWorkspaceFileActions → useWorkspaceTreeData → workspace_list_dir / workspace_read_file / 资源事务 → 树行、tabs、正文。具体caller/符号/IPC与源文件：[S-TREE](source-audit.md#tree)。
- **状态owner / IPC-provider：** codeWorkspaceStore 的 treeSelection / expandedRootIds / expandedDirKeys；目录缓存与 file actions 在 shell/hooks。MainLayout → CodeWorkspaceTab → ProjectTree / handleTreeKeyDown → navigateProjectTree 或 useWorkspaceFileActions → useWorkspaceTreeData → workspace_list_dir / workspace_read_file / 资源事务 → 树行、tabs、正文。真实provider、native build与OS边界未执行时保持unverified。
- **当前实现与实际观测：** 本轮 B03–B05 有选择/展开/Enter 及 activeElement；Enter 后留在树。IDEA 旧有效参照 Enter 后 editor caret、树失焦；目录单击差异待匹配设置冻结。
- **独立结论：** 功能 **部分对齐**；视觉 **不可比较**；交互 **部分对齐**。不输出百分比。
- **Taomni证据与当前性：** [B03](../../qa-ui-auto-report/overall-audit-20260913/browser/03-child-selected.png) / [B04](../../qa-ui-auto-report/overall-audit-20260913/browser/04-example-selected.png) / [B05](../../qa-ui-auto-report/overall-audit-20260913/browser/05-example-enter.png)。共用身份T0/provenance；原始日志、snapshot与具体焦点记录见baseline。未采正常/失败/取消/恢复状态仍缺失，已有case仅候选：[TC-IDE-TREE-01-project-tree-keyboard-native](../../qa-ui-auto-tests/cases/TC-IDE-TREE-01-project-tree-keyboard-native.testcase.yaml)（本轮未运行）。
- **IDEA证据 / 环境 / 状态：** I0：09-right-expand、10-right-child、11-left-parent、12-left-collapse、13-down-select-src、29-up-main、30-right-expand-main、31-down-example、32-enter-example 的PNG/JSON；根路径 `qa-ui-auto-report/project-tree-e2e/idea/`，逐hash见provenance。仅方向/Enter可复用；mouse设置、Home/End、多选、视觉待采。
- **差异性质：** 视觉/交互体验差异；native 证据缺口。缺证据本身不是产品bug；没有真实双侧支持的目标差异保留待验证。
- **需求 / 影响 / 方向：** [REQ-02](overall-audit-plan-20260913.md#req-02)，P1：每天使用，已有Enter局部双侧差异；改动影响tab预览与dirty保护。按目标设置统一label/arrow/single/double/Enter语义与editor focus，允许调整树动作组织。进入条件/依赖：F0匹配的鼠标设置、Enter/Esc参照；REQ-04的共享文档保留契约。
- **必须保留：** K0；选择不打开；展开不改正文；正式打开、Ctrl+Enter 分屏、菜单取消与 dirty buffer 继续正确。后续验收必须观察这些结果，不能只写“保持原功能”。
- **规格与任务来源：** [project-tree-keyboard-idea-alignment-design.md](../../docs-issue/project-tree-keyboard-idea-alignment-design.md)；[code-workspace-idea-parity-backlog-2026-09-tree-e2e.md](../../claudedocs/code-workspace-idea-parity-backlog-2026-09-tree-e2e.md) `ED-TREE-001`（原记录 2026-09-13T01:30:00Z）。旧卡不重开；新观察需求尚未author/领取任务。
- **上次结论 / 本次变化：** 首次整体场景结论，无上一轮同ID三维判定；本轮新增目标、静态生产链和上述实际子样本。历史卡原验收及日期仅按原链接保留，未作为本轮PASS。当前判断日期2026-09-13；没有双侧新观测关闭差距。

**2026-09-14 P1 局部增量（不改上列 2026-09-13 结论/日期）：** 已核实本机 IU-262.10315.125 的 preview/single-click 均关闭，并实测 Enter 后直接输入/undo、已开文件、回树/菜单 Esc 与 active split；见 [新参照](references/project-tree-open-focus-linux-2026.2.2.md)。用户已接受单击只选、双击/Enter 正式打开的旧合同修订；[设计](../../docs-issue/code-workspace-tree-open-focus-design.md#ed-treeopen-001) 与 [ED-TREEOPEN-001 任务板](../../claudedocs/code-workspace-idea-parity-backlog-tree-open-focus.md) 已 author。上述“尚未 author”保留为 P0 历史记录；当前状态以新板为准。源码补核 tree→openFile→active leaf→Host ready owner，Find 共享链已有实现。未运行 Taomni，新 IDEA 参照不构成双侧关闭差距，三维历史判断不升级。

<a id="cw-proj-003"></a>

### CW-PROJ-003 — 新建、重命名、删除与树菜单

- **IDEA目标结果：** 新建模板/目录、重命名和删除可预览/取消，路径与选区明确，错误后保留项目与正文。目标为需求；除I0明确事实外，细节未冒充实测。
- **Fixture / 入口：** [F0/F1](references/fixture-catalog.md)；New file / New Java Class / context Rename/Delete / F2。
- **完整采样序列（未列为已执行的步骤均待采）：** 右键 example→Esc→F2→检查 basename 选区→Esc→新建→重命名冲突→取消删除→在副本确认→undo/reopen。每次保存初始/关键状态/退出后的原图或录屏，分别记录focus、caret/selection、菜单/弹层、错误、取消、undo与恢复；不适用项说明原因。
- **当前生产链 / 用户观察点：** New file / New Java Class / context Rename/Delete / F2 → MainLayout → CodeWorkspaceTab → ProjectTree / handleTreeKeyDown → navigateProjectTree 或 useWorkspaceFileActions → useWorkspaceTreeData → workspace_list_dir / workspace_read_file / 资源事务 → 树行、tabs、正文。具体caller/符号/IPC与源文件：[S-TREE](source-audit.md#tree)。
- **状态owner / IPC-provider：** codeWorkspaceStore 的 treeSelection / expandedRootIds / expandedDirKeys；目录缓存与 file actions 在 shell/hooks。MainLayout → CodeWorkspaceTab → ProjectTree / handleTreeKeyDown → navigateProjectTree 或 useWorkspaceFileActions → useWorkspaceTreeData → workspace_list_dir / workspace_read_file / 资源事务 → 树行、tabs、正文。真实provider、native build与OS边界未执行时保持unverified。
- **当前实现与实际观测：** B06 菜单、B07 F2 prompt 与取消已采；整个文件名选中。没有实际新建/rename/delete、失败、undo 或磁盘验证。
- **独立结论：** 功能 **待验证**；视觉 **待验证**；交互 **待验证**。不输出百分比。
- **Taomni证据与当前性：** [B06](../../qa-ui-auto-report/overall-audit-20260913/browser/06-context-menu.png) / [B07](../../qa-ui-auto-report/overall-audit-20260913/browser/07-rename-prompt.png)。共用身份T0/provenance；原始日志、snapshot与具体焦点记录见baseline。未采正常/失败/取消/恢复状态仍缺失，已有case仅候选：[TC-IDE-TREE-01-project-tree-keyboard-native](../../qa-ui-auto-tests/cases/TC-IDE-TREE-01-project-tree-keyboard-native.testcase.yaml)（本轮未运行）。
- **IDEA证据 / 环境 / 状态：** I0仅33-context-example / 34-context-dismiss的PNG/JSON，准确目录 `qa-ui-auto-report/project-tree-e2e/idea/`；整个场景的新增/rename/delete或搜索/弹层焦点关键状态仍待采，不能签发匹配。
- **差异性质：** 纯证据缺口；菜单目标待验证。缺证据本身不是产品bug；没有真实双侧支持的目标差异保留待验证。
- **需求 / 影响 / 方向：** [REQ-02](overall-audit-plan-20260913.md#req-02)，P1：每天使用，已有Enter局部双侧差异；改动影响tab预览与dirty保护。按目标设置统一label/arrow/single/double/Enter语义与editor focus，允许调整树动作组织。进入条件/依赖：F0匹配的鼠标设置、Enter/Esc参照；REQ-04的共享文档保留契约。
- **必须保留：** K0；取消零文件写入；dirty 删除要确认；resource rename 更新 tabs、LSP、历史；保留 root remove 语义。后续验收必须观察这些结果，不能只写“保持原功能”。
- **规格与任务来源：** [project-tree-keyboard-idea-alignment-design.md](../../docs-issue/project-tree-keyboard-idea-alignment-design.md)；[code-workspace-idea-parity-backlog-2026-09-tree-e2e.md](../../claudedocs/code-workspace-idea-parity-backlog-2026-09-tree-e2e.md) `ED-TREE-001`（原记录 2026-09-13T01:30:00Z）。旧卡不重开；新观察需求尚未author/领取任务。
- **上次结论 / 本次变化：** 首次整体场景结论，无上一轮同ID三维判定；本轮新增目标、静态生产链和上述实际子样本。历史卡原验收及日期仅按原链接保留，未作为本轮PASS。当前判断日期2026-09-13；没有双侧新观测关闭差距。

<a id="cw-proj-004"></a>

### CW-PROJ-004 — 树视图、过滤、隐藏与刷新

- **IDEA目标结果：** Project/Packages 等目标视图、过滤与自动定位可找到同一文件；外部变化后保留选择/展开。目标为需求；除I0明确事实外，细节未冒充实测。
- **Fixture / 入口：** [F0/F2](references/fixture-catalog.md)；Filter files / Tree / Compact / Flat / Refresh / Select in Project Tree。
- **完整采样序列（未列为已执行的步骤均待采）：** 展开深层→切换视图→输入有/无结果过滤→清除→外部新增文件→刷新→从 editor reveal→核对选择与滚动。每次保存初始/关键状态/退出后的原图或录屏，分别记录focus、caret/selection、菜单/弹层、错误、取消、undo与恢复；不适用项说明原因。
- **当前生产链 / 用户观察点：** Filter files / Tree / Compact / Flat / Refresh / Select in Project Tree → MainLayout → CodeWorkspaceTab → ProjectTree / handleTreeKeyDown → navigateProjectTree 或 useWorkspaceFileActions → useWorkspaceTreeData → workspace_list_dir / workspace_read_file / 资源事务 → 树行、tabs、正文。具体caller/符号/IPC与源文件：[S-TREE](source-audit.md#tree)。
- **状态owner / IPC-provider：** codeWorkspaceStore 的 treeSelection / expandedRootIds / expandedDirKeys；目录缓存与 file actions 在 shell/hooks。MainLayout → CodeWorkspaceTab → ProjectTree / handleTreeKeyDown → navigateProjectTree 或 useWorkspaceFileActions → useWorkspaceTreeData → workspace_list_dir / workspace_read_file / 资源事务 → 树行、tabs、正文。真实provider、native build与OS边界未执行时保持unverified。
- **当前实现与实际观测：** 生产有 tree/compact/flat、recursive filter、expanded descendant refresh；本轮未操作这些转换。Flat 是源码分组，不能当 IDEA Packages 等价。
- **独立结论：** 功能 **待验证**；视觉 **待验证**；交互 **待验证**。不输出百分比。
- **Taomni证据与当前性：** 无本轮关键状态原件：unverified（源码/case存在不改变此结论）。共用身份T0/provenance；原始日志、snapshot与具体焦点记录见baseline。未采正常/失败/取消/恢复状态仍缺失，已有case仅候选：[TC-IDE-TREE-01-project-tree-keyboard-native](../../qa-ui-auto-tests/cases/TC-IDE-TREE-01-project-tree-keyboard-native.testcase.yaml)（本轮未运行）。
- **IDEA证据 / 环境 / 状态：** 待采：目标IU-262.10315.125，按本行fixture与步骤采同状态；本机只有I0项目树局部参照，不能跨场景复用。build/主题/scale/font/keymap/语言provider边界见IDEA对照摘要。
- **差异性质：** 纯证据缺口；视图映射待决。缺证据本身不是产品bug；没有真实双侧支持的目标差异保留待验证。
- **需求 / 影响 / 方向：** [REQ-03](overall-audit-plan-20260913.md#req-03)，P1：贯穿全部能力，决定空间利用与可发现性；需要先锁定真实UI设置。先采匹配主题/scale/font，再细化tool-window位置、层级、密度、选中/失焦、菜单溢出；不先写假token。进入条件/依赖：目标环境就绪；SHELL/SET/TREE消费者清单；用户未接受任何有限差异。
- **必须保留：** K0；已展开后代刷新、active file、不相关 roots 缓存与过滤清除恢复。后续验收必须观察这些结果，不能只写“保持原功能”。
- **规格与任务来源：** [project-tree-keyboard-idea-alignment-design.md](../../docs-issue/project-tree-keyboard-idea-alignment-design.md)；[code-workspace-idea-parity-backlog-2026-09-tree-e2e.md](../../claudedocs/code-workspace-idea-parity-backlog-2026-09-tree-e2e.md) `ED-TREE-001`（原记录 2026-09-13T01:30:00Z）。旧卡不重开；新观察需求尚未author/领取任务。
- **上次结论 / 本次变化：** 首次整体场景结论，无上一轮同ID三维判定；本轮新增目标、静态生产链和上述实际子样本。历史卡原验收及日期仅按原链接保留，未作为本轮PASS。当前判断日期2026-09-13；没有双侧新观测关闭差距。

<a id="cw-tab-001"></a>

### CW-TAB-001 — 预览、固定、关闭策略与溢出

- **IDEA目标结果：** 预览/正式/pinned/dirty tab 可区分，达到 limit 后关闭可预测，取消不丢 dirty。目标为需求；除I0明确事实外，细节未冒充实测。
- **Fixture / 入口：** [F1](references/fixture-catalog.md)；树打开 / EditorGroup tab menu / Editor tab policy settings。
- **完整采样序列（未列为已执行的步骤均待采）：** 连续预览→双击正式→pin→编辑 dirty→超过 limit→预览关闭目标→Cancel→Apply→reopen。每次保存初始/关键状态/退出后的原图或录屏，分别记录focus、caret/selection、菜单/弹层、错误、取消、undo与恢复；不适用项说明原因。
- **当前生产链 / 用户观察点：** 树打开 / EditorGroup tab menu / Editor tab policy settings → CodeWorkspaceTab open/split/close/policy → EditorGroup → atomic layout mutations / TabPolicyPlan → layout v2 persistence；文件读写和资源释放经 workspace IPC/LSP → tab/pane/dirty/恢复结果。具体caller/符号/IPC与源文件：[S-TABS](source-audit.md#tabs)。
- **状态owner / IPC-provider：** codeWorkspaceStore layoutTreeV2/layoutRevision/editorGroups；document transaction owner 共享正文/undo，per-view caret/scroll/fold 独立。文件读写和资源释放经 workspace IPC/LSP → tab/pane/dirty/恢复结果。真实provider、native build与OS边界未执行时保持unverified。
- **当前实现与实际观测：** 本轮只有两个正式 tabs 与 policy draft=30/Cancel；不能证明 preview/limit eviction。旧 ready 文案不是本轮任务状态。
- **独立结论：** 功能 **待验证**；视觉 **待验证**；交互 **待验证**。不输出百分比。
- **Taomni证据与当前性：** [B02](../../qa-ui-auto-report/overall-audit-20260913/browser/02-readme-open.png) / [B05](../../qa-ui-auto-report/overall-audit-20260913/browser/05-example-enter.png) / [B11](../../qa-ui-auto-report/overall-audit-20260913/browser/11-tab-policy.png)。共用身份T0/provenance；原始日志、snapshot与具体焦点记录见baseline。未采正常/失败/取消/恢复状态仍缺失，已有case仅候选：[TC-IDE-C4-01](../../qa-ui-auto-tests/cases/TC-IDE-C4-01-tab-policy-lifecycle.testcase.yaml)；[TC-IDE-C4-02](../../qa-ui-auto-tests/cases/TC-IDE-C4-02-split-and-structured-reopen.testcase.yaml)；[TC-IDE-C4-03](../../qa-ui-auto-tests/cases/TC-IDE-C4-03-restore-active-ready-timing-native.testcase.yaml)（本轮未运行）。
- **IDEA证据 / 环境 / 状态：** 待采：目标IU-262.10315.125，按本行fixture与步骤采同状态；本机只有I0项目树局部参照，不能跨场景复用。build/主题/scale/font/keymap/语言provider边界见IDEA对照摘要。
- **差异性质：** 纯证据缺口；体验差异待验证。缺证据本身不是产品bug；没有真实双侧支持的目标差异保留待验证。
- **需求 / 影响 / 方向：** [REQ-04](overall-audit-plan-20260913.md#req-04)，P0保留 / P1体验：改UI前必须保护dirty、共享undo、最后资源释放；多窗口数据风险高。复用layoutTreeV2与transaction owner，补真实preview/eviction/restore观察后再确定UI重组。进入条件/依赖：F1/F5、同源QA、目标tab设置；不将B20解释为丢失。
- **必须保留：** K0；TabPolicyPlan revision 原子提交；dirty/pinned保护；最后视图释放前保留共享文档。后续验收必须观察这些结果，不能只写“保持原功能”。
- **规格与任务来源：** [tabs-and-multiview.md](../../claudedocs/code-workspace-idea-specs/tabs-and-multiview.md)；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-TABS-001`（原记录 2026-08-31T15:44:40Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-TABS-002`（原记录 2026-08-31T16:00:29Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-TABS-003`（原记录 2026-08-31T16:36:05Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-TABS-004`（原记录 2026-09-02T00:20:00Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-MULTIVIEW-002`（原记录 2026-09-03T00:36:30Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-MULTIVIEW-003`（原记录 2026-09-03T01:21:00Z）；[code-workspace-idea-parity-backlog-2026-09-main-repair.md](../../claudedocs/code-workspace-idea-parity-backlog-2026-09-main-repair.md) `ED-REPAIR-009`（原记录 2026-09-12T14:05:00Z）。旧卡不重开；新观察需求尚未author/领取任务。
- **上次结论 / 本次变化：** 首次整体场景结论，无上一轮同ID三维判定；本轮新增目标、静态生产链和上述实际子样本。历史卡原验收及日期仅按原链接保留，未作为本轮PASS。当前判断日期2026-09-13；没有双侧新观测关闭差距。

<a id="cw-tab-002"></a>

### CW-TAB-002 — 递归分屏、移动 tab 与独立视图

- **IDEA目标结果：** 左右/上下/嵌套分屏可调整与移动；同文档改动一致，caret/scroll/fold 独立。目标为需求；除I0明确事实外，细节未冒充实测。
- **Fixture / 入口：** [F1](references/fixture-catalog.md)；Split editor right/down / tab drag / next split。
- **完整采样序列（未列为已执行的步骤均待采）：** 同文件左右分屏→下分屏→resize/drag tab→分别定位→编辑/undo→关闭一个 pane→unsplit。每次保存初始/关键状态/退出后的原图或录屏，分别记录focus、caret/selection、菜单/弹层、错误、取消、undo与恢复；不适用项说明原因。
- **当前生产链 / 用户观察点：** Split editor right/down / tab drag / next split → CodeWorkspaceTab open/split/close/policy → EditorGroup → atomic layout mutations / TabPolicyPlan → layout v2 persistence；文件读写和资源释放经 workspace IPC/LSP → tab/pane/dirty/恢复结果。具体caller/符号/IPC与源文件：[S-TABS](source-audit.md#tabs)。
- **状态owner / IPC-provider：** codeWorkspaceStore layoutTreeV2/layoutRevision/editorGroups；document transaction owner 共享正文/undo，per-view caret/scroll/fold 独立。文件读写和资源释放经 workspace IPC/LSP → tab/pane/dirty/恢复结果。真实provider、native build与OS边界未执行时保持unverified。
- **当前实现与实际观测：** B10 只有左右同文档两个 pane 可见。当前 store 是递归 layoutTreeV2，不沿用旧“双组限制”描述；共享编辑/drag/undo 未采。
- **独立结论：** 功能 **待验证**；视觉 **待验证**；交互 **待验证**。不输出百分比。
- **Taomni证据与当前性：** [B10](../../qa-ui-auto-report/overall-audit-20260913/browser/10-split-right.png)。共用身份T0/provenance；原始日志、snapshot与具体焦点记录见baseline。未采正常/失败/取消/恢复状态仍缺失，已有case仅候选：[TC-IDE-C4-01](../../qa-ui-auto-tests/cases/TC-IDE-C4-01-tab-policy-lifecycle.testcase.yaml)；[TC-IDE-C4-02](../../qa-ui-auto-tests/cases/TC-IDE-C4-02-split-and-structured-reopen.testcase.yaml)；[TC-IDE-C4-03](../../qa-ui-auto-tests/cases/TC-IDE-C4-03-restore-active-ready-timing-native.testcase.yaml)（本轮未运行）。
- **IDEA证据 / 环境 / 状态：** 待采：目标IU-262.10315.125，按本行fixture与步骤采同状态；本机只有I0项目树局部参照，不能跨场景复用。build/主题/scale/font/keymap/语言provider边界见IDEA对照摘要。
- **差异性质：** 纯证据缺口。缺证据本身不是产品bug；没有真实双侧支持的目标差异保留待验证。
- **需求 / 影响 / 方向：** [REQ-04](overall-audit-plan-20260913.md#req-04)，P0保留 / P1体验：改UI前必须保护dirty、共享undo、最后资源释放；多窗口数据风险高。复用layoutTreeV2与transaction owner，补真实preview/eviction/restore观察后再确定UI重组。进入条件/依赖：F1/F5、同源QA、目标tab设置；不将B20解释为丢失。
- **必须保留：** K0；共享正文/undo一次；视图状态隔离；关闭非最后视图不触发 didClose/释放资源。后续验收必须观察这些结果，不能只写“保持原功能”。
- **规格与任务来源：** [tabs-and-multiview.md](../../claudedocs/code-workspace-idea-specs/tabs-and-multiview.md)；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-TABS-001`（原记录 2026-08-31T15:44:40Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-TABS-002`（原记录 2026-08-31T16:00:29Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-TABS-003`（原记录 2026-08-31T16:36:05Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-TABS-004`（原记录 2026-09-02T00:20:00Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-MULTIVIEW-002`（原记录 2026-09-03T00:36:30Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-MULTIVIEW-003`（原记录 2026-09-03T01:21:00Z）；[code-workspace-idea-parity-backlog-2026-09-main-repair.md](../../claudedocs/code-workspace-idea-parity-backlog-2026-09-main-repair.md) `ED-REPAIR-009`（原记录 2026-09-12T14:05:00Z）。旧卡不重开；新观察需求尚未author/领取任务。
- **上次结论 / 本次变化：** 首次整体场景结论，无上一轮同ID三维判定；本轮新增目标、静态生产链和上述实际子样本。历史卡原验收及日期仅按原链接保留，未作为本轮PASS。当前判断日期2026-09-13；没有双侧新观测关闭差距。


- **2026-09-14 P1 局部接续：** [WP-FIND-FOCUS-01 设计](../../docs-issue/code-workspace-find-focus-design.md)、[ED-FINDFOCUS-001 唯一任务板](../../claudedocs/code-workspace-idea-parity-backlog-find-focus.md)、[真实 Find 参照](references/find-focus-2026.2.2.md)。本场景为受影响保留消费者，未开展其全量对齐。原功能/视觉/交互三维结论和差异类型保留，未关闭场景差距；任务状态仅看板。

<a id="cw-tab-003"></a>

### CW-TAB-003 — MRU 切换、关闭与重开标签

- **IDEA目标结果：** Ctrl+Tab 选择与修饰键释放、关闭邻居、重开位置符合目标 keymap 和策略。目标为需求；除I0明确事实外，细节未冒充实测。
- **Fixture / 入口：** [F1](references/fixture-catalog.md)；TabSwitcher / Ctrl+Tab / workspace.reopenClosedTab。
- **完整采样序列（未列为已执行的步骤均待采）：** 开三个文件→按住 Ctrl+Tab 多次→松键提交→Esc取消→关闭活动 tab→重开→检查顺序/focus/selection。每次保存初始/关键状态/退出后的原图或录屏，分别记录focus、caret/selection、菜单/弹层、错误、取消、undo与恢复；不适用项说明原因。
- **当前生产链 / 用户观察点：** TabSwitcher / Ctrl+Tab / workspace.reopenClosedTab → CodeWorkspaceTab open/split/close/policy → EditorGroup → atomic layout mutations / TabPolicyPlan → layout v2 persistence；文件读写和资源释放经 workspace IPC/LSP → tab/pane/dirty/恢复结果。具体caller/符号/IPC与源文件：[S-TABS](source-audit.md#tabs)。
- **状态owner / IPC-provider：** codeWorkspaceStore layoutTreeV2/layoutRevision/editorGroups；document transaction owner 共享正文/undo，per-view caret/scroll/fold 独立。文件读写和资源释放经 workspace IPC/LSP → tab/pane/dirty/恢复结果。真实provider、native build与OS边界未执行时保持unverified。
- **当前实现与实际观测：** 生产有 TabSwitcher、tab policy 和 reopen action；本轮未操作 MRU、修饰键释放或重开。
- **独立结论：** 功能 **待验证**；视觉 **待验证**；交互 **待验证**。不输出百分比。
- **Taomni证据与当前性：** 无本轮关键状态原件：unverified（源码/case存在不改变此结论）。共用身份T0/provenance；原始日志、snapshot与具体焦点记录见baseline。未采正常/失败/取消/恢复状态仍缺失，已有case仅候选：[TC-IDE-C4-01](../../qa-ui-auto-tests/cases/TC-IDE-C4-01-tab-policy-lifecycle.testcase.yaml)；[TC-IDE-C4-02](../../qa-ui-auto-tests/cases/TC-IDE-C4-02-split-and-structured-reopen.testcase.yaml)；[TC-IDE-C4-03](../../qa-ui-auto-tests/cases/TC-IDE-C4-03-restore-active-ready-timing-native.testcase.yaml)（本轮未运行）。
- **IDEA证据 / 环境 / 状态：** 待采：目标IU-262.10315.125，按本行fixture与步骤采同状态；本机只有I0项目树局部参照，不能跨场景复用。build/主题/scale/font/keymap/语言provider边界见IDEA对照摘要。
- **差异性质：** 纯证据缺口。缺证据本身不是产品bug；没有真实双侧支持的目标差异保留待验证。
- **需求 / 影响 / 方向：** [REQ-04](overall-audit-plan-20260913.md#req-04)，P0保留 / P1体验：改UI前必须保护dirty、共享undo、最后资源释放；多窗口数据风险高。复用layoutTreeV2与transaction owner，补真实preview/eviction/restore观察后再确定UI重组。进入条件/依赖：F1/F5、同源QA、目标tab设置；不将B20解释为丢失。
- **必须保留：** K0；未选中的 pane不变；cancel不改 MRU；重开 dirty/历史按既有数据契约。后续验收必须观察这些结果，不能只写“保持原功能”。
- **规格与任务来源：** [tabs-and-multiview.md](../../claudedocs/code-workspace-idea-specs/tabs-and-multiview.md)；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-TABS-001`（原记录 2026-08-31T15:44:40Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-TABS-002`（原记录 2026-08-31T16:00:29Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-TABS-003`（原记录 2026-08-31T16:36:05Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-TABS-004`（原记录 2026-09-02T00:20:00Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-MULTIVIEW-002`（原记录 2026-09-03T00:36:30Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-MULTIVIEW-003`（原记录 2026-09-03T01:21:00Z）；[code-workspace-idea-parity-backlog-2026-09-main-repair.md](../../claudedocs/code-workspace-idea-parity-backlog-2026-09-main-repair.md) `ED-REPAIR-009`（原记录 2026-09-12T14:05:00Z）。旧卡不重开；新观察需求尚未author/领取任务。
- **上次结论 / 本次变化：** 首次整体场景结论，无上一轮同ID三维判定；本轮新增目标、静态生产链和上述实际子样本。历史卡原验收及日期仅按原链接保留，未作为本轮PASS。当前判断日期2026-09-13；没有双侧新观测关闭差距。

<a id="cw-tab-004"></a>

### CW-TAB-004 — 重启恢复工作区与视图

- **IDEA目标结果：** 恢复选定项目、tabs、分屏、caret/scroll/folds；未保存内容与失败恢复有明确处理。目标为需求；除I0明确事实外，细节未冒充实测。
- **Fixture / 入口：** [F1/F5](references/fixture-catalog.md)；Welcome Restore / Recent workspace / workspaceLayoutPersistence。
- **完整采样序列（未列为已执行的步骤均待采）：** 设置多 pane与不同 scroll/folds→关闭/重启→Restore或Recent重开→逐view核对→外部文件变化再恢复。每次保存初始/关键状态/退出后的原图或录屏，分别记录focus、caret/selection、菜单/弹层、错误、取消、undo与恢复；不适用项说明原因。
- **当前生产链 / 用户观察点：** Welcome Restore / Recent workspace / workspaceLayoutPersistence → CodeWorkspaceTab open/split/close/policy → EditorGroup → atomic layout mutations / TabPolicyPlan → layout v2 persistence；文件读写和资源释放经 workspace IPC/LSP → tab/pane/dirty/恢复结果。具体caller/符号/IPC与源文件：[S-TABS](source-audit.md#tabs)。
- **状态owner / IPC-provider：** codeWorkspaceStore layoutTreeV2/layoutRevision/editorGroups；document transaction owner 共享正文/undo，per-view caret/scroll/fold 独立。文件读写和资源释放经 workspace IPC/LSP → tab/pane/dirty/恢复结果。真实provider、native build与OS边界未执行时保持unverified。
- **当前实现与实际观测：** B19 只是加载空白；B20 回 Welcome，未执行显式恢复。当前 browser 不能证明 native persistence，不能认定丢失。
- **独立结论：** 功能 **待验证**；视觉 **待验证**；交互 **待验证**。不输出百分比。
- **Taomni证据与当前性：** [B19](../../qa-ui-auto-report/overall-audit-20260913/browser/19-reload-restoration.png) / [B20](../../qa-ui-auto-report/overall-audit-20260913/browser/20-reload-settled.png)。共用身份T0/provenance；原始日志、snapshot与具体焦点记录见baseline。未采正常/失败/取消/恢复状态仍缺失，已有case仅候选：[TC-IDE-C4-01](../../qa-ui-auto-tests/cases/TC-IDE-C4-01-tab-policy-lifecycle.testcase.yaml)；[TC-IDE-C4-02](../../qa-ui-auto-tests/cases/TC-IDE-C4-02-split-and-structured-reopen.testcase.yaml)；[TC-IDE-C4-03](../../qa-ui-auto-tests/cases/TC-IDE-C4-03-restore-active-ready-timing-native.testcase.yaml)（本轮未运行）。
- **IDEA证据 / 环境 / 状态：** 待采：目标IU-262.10315.125，按本行fixture与步骤采同状态；本机只有I0项目树局部参照，不能跨场景复用。build/主题/scale/font/keymap/语言provider边界见IDEA对照摘要。
- **差异性质：** 纯证据缺口；恢复入口待验证。缺证据本身不是产品bug；没有真实双侧支持的目标差异保留待验证。
- **需求 / 影响 / 方向：** [REQ-04](overall-audit-plan-20260913.md#req-04)，P0保留 / P1体验：改UI前必须保护dirty、共享undo、最后资源释放；多窗口数据风险高。复用layoutTreeV2与transaction owner，补真实preview/eviction/restore观察后再确定UI重组。进入条件/依赖：F1/F5、同源QA、目标tab设置；不将B20解释为丢失。
- **必须保留：** K0；layout v1/v2 migration；旧text identity不能补签新正文；dirty数据和最终 unmount快照。后续验收必须观察这些结果，不能只写“保持原功能”。
- **规格与任务来源：** [tabs-and-multiview.md](../../claudedocs/code-workspace-idea-specs/tabs-and-multiview.md)；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-TABS-001`（原记录 2026-08-31T15:44:40Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-TABS-002`（原记录 2026-08-31T16:00:29Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-TABS-003`（原记录 2026-08-31T16:36:05Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-TABS-004`（原记录 2026-09-02T00:20:00Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-MULTIVIEW-002`（原记录 2026-09-03T00:36:30Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-MULTIVIEW-003`（原记录 2026-09-03T01:21:00Z）；[code-workspace-idea-parity-backlog-2026-09-main-repair.md](../../claudedocs/code-workspace-idea-parity-backlog-2026-09-main-repair.md) `ED-REPAIR-009`（原记录 2026-09-12T14:05:00Z）。旧卡不重开；新观察需求尚未author/领取任务。
- **上次结论 / 本次变化：** 首次整体场景结论，无上一轮同ID三维判定；本轮新增目标、静态生产链和上述实际子样本。历史卡原验收及日期仅按原链接保留，未作为本轮PASS。当前判断日期2026-09-13；没有双侧新观测关闭差距。

<a id="cw-edit-001"></a>

### CW-EDIT-001 — 日常输入、多光标与结构编辑

- **IDEA目标结果：** Tab/Enter/Backspace、补括号、注释、移动/复制行、矩形/多光标操作结果与 undo 单位可预测。目标为需求；除I0明确事实外，细节未冒充实测。
- **Fixture / 入口：** [F1/F2](references/fixture-catalog.md)；CodeMirror content / workspace editor commands。
- **完整采样序列（未列为已执行的步骤均待采）：** 普通行→多光标/矩形选择→Tab/Enter/注释/Move→undo/redo→read-only取消→核对文本和carets。每次保存初始/关键状态/退出后的原图或录屏，分别记录focus、caret/selection、菜单/弹层、错误、取消、undo与恢复；不适用项说明原因。
- **当前生产链 / 用户观察点：** CodeMirror content / workspace editor commands → EditorGroup → CodeMirrorHost → CodeMirror commands / editor command port → transaction owner → openFiles 同步及 undo；剪贴板经 lib/clipboard 原生或 browser API，IME 归 OS → 正文/selection/caret。具体caller/符号/IPC与源文件：[S-EDIT](source-audit.md#edit)。
- **状态owner / IPC-provider：** CodeMirror EditorState/view；WorkspaceDocumentTransactionOwner；clipboard/composition session 按 view generation。剪贴板经 lib/clipboard 原生或 browser API，IME 归 OS → 正文/selection/caret。真实provider、native build与OS边界未执行时保持unverified。
- **当前实现与实际观测：** 命令端口和 shared transaction owner 有生产调用；本轮只点击/查看正文，没有执行文本编辑/undo。
- **独立结论：** 功能 **待验证**；视觉 **待验证**；交互 **待验证**。不输出百分比。
- **Taomni证据与当前性：** 无本轮关键状态原件：unverified（源码/case存在不改变此结论）。共用身份T0/provenance；原始日志、snapshot与具体焦点记录见baseline。未采正常/失败/取消/恢复状态仍缺失，已有case仅候选：[TC-IDE-C3-01](../../qa-ui-auto-tests/cases/TC-IDE-C3-01-clipboard-session-across-splits-with-system-denial.testcase.yaml)；[TC-IDE-C3-02](../../qa-ui-auto-tests/cases/TC-IDE-C3-02-native-clipboard-permission-and-multicaret.testcase.yaml)（本轮未运行）。
- **IDEA证据 / 环境 / 状态：** 待采：目标IU-262.10315.125，按本行fixture与步骤采同状态；本机只有I0项目树局部参照，不能跨场景复用。build/主题/scale/font/keymap/语言provider边界见IDEA对照摘要。
- **差异性质：** 纯证据缺口；语法适配边界。缺证据本身不是产品bug；没有真实双侧支持的目标差异保留待验证。
- **需求 / 影响 / 方向：** [REQ-11](overall-audit-plan-20260913.md#req-11)，P0保留 / P1补证：正确性与数据兼容不可丢；本轮无这些native新证据，不能凭空报bug。保持现有正确事务/byte writer；先做有区分性的current native采样，再登记真实缺陷或体验改版。进入条件/依赖：同源QA与F1/F5；三端计划；与REQ-04共享undo/资源释放。
- **必须保留：** K0；多选区完整性、单次undo、只读零修改、selection坐标freshness。后续验收必须观察这些结果，不能只写“保持原功能”。
- **规格与任务来源：** [editor-experience.md](../../claudedocs/code-workspace-idea-specs/editor-experience.md)；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-CLIP-001`（原记录 2026-08-31T14:17:24Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-CLIP-002`（原记录 2026-08-31T14:33:06Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-CLIP-003`（原记录 2026-08-31T14:52:26Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-CLIP-004`（原记录 2026-09-01T23:24:00Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-VSPACE-001`（原记录 2026-08-31T18:00:27Z）；[code-workspace-idea-parity-backlog-2026-09-main-repair.md](../../claudedocs/code-workspace-idea-parity-backlog-2026-09-main-repair.md) `ED-REPAIR-003`（原记录 2026-09-12T01:30:00Z）；[code-workspace-idea-parity-backlog-2026-09-main-repair.md](../../claudedocs/code-workspace-idea-parity-backlog-2026-09-main-repair.md) `ED-REPAIR-007`（原记录 2026-09-12T14:30:00Z）；[code-workspace-idea-parity-backlog-2026-09-main-repair.md](../../claudedocs/code-workspace-idea-parity-backlog-2026-09-main-repair.md) `ED-REPAIR-008`（原记录 2026-09-12T15:13:00Z）。旧卡不重开；新观察需求尚未author/领取任务。
- **上次结论 / 本次变化：** 首次整体场景结论，无上一轮同ID三维判定；本轮新增目标、静态生产链和上述实际子样本。历史卡原验收及日期仅按原链接保留，未作为本轮PASS。当前判断日期2026-09-13；没有双侧新观测关闭差距。

<a id="cw-edit-002"></a>

### CW-EDIT-002 — 剪贴板历史、粘贴与 IME

- **IDEA目标结果：** 复制/剪切/粘贴历史和多选区分发、输入法确认/取消遵循目标与 OS；转焦不误写。目标为需求；除I0明确事实外，细节未冒充实测。
- **Fixture / 入口：** [F1/F5](references/fixture-catalog.md)；editor/context menu clipboard / ClipboardHistoryPopup / OS IME。
- **完整采样序列（未列为已执行的步骤均待采）：** 多选区copy→paste/history→转焦另一pane取消异步结果→IME候选确认/取消→undo→拒绝权限恢复。每次保存初始/关键状态/退出后的原图或录屏，分别记录focus、caret/selection、菜单/弹层、错误、取消、undo与恢复；不适用项说明原因。
- **当前生产链 / 用户观察点：** editor/context menu clipboard / ClipboardHistoryPopup / OS IME → EditorGroup → CodeMirrorHost → CodeMirror commands / editor command port → transaction owner → openFiles 同步及 undo；剪贴板经 lib/clipboard 原生或 browser API，IME 归 OS → 正文/selection/caret。具体caller/符号/IPC与源文件：[S-EDIT](source-audit.md#edit)。
- **状态owner / IPC-provider：** CodeMirror EditorState/view；WorkspaceDocumentTransactionOwner；clipboard/composition session 按 view generation。剪贴板经 lib/clipboard 原生或 browser API，IME 归 OS → 正文/selection/caret。真实provider、native build与OS边界未执行时保持unverified。
- **当前实现与实际观测：** 生产 clipboard/composition session 已有隔离与历史修复；本轮没有读取个人剪贴板或输入法操作，三端均缺当前证据。
- **独立结论：** 功能 **待验证**；视觉 **待验证**；交互 **待验证**。不输出百分比。
- **Taomni证据与当前性：** 无本轮关键状态原件：unverified（源码/case存在不改变此结论）。共用身份T0/provenance；原始日志、snapshot与具体焦点记录见baseline。未采正常/失败/取消/恢复状态仍缺失，已有case仅候选：[TC-IDE-C3-01](../../qa-ui-auto-tests/cases/TC-IDE-C3-01-clipboard-session-across-splits-with-system-denial.testcase.yaml)；[TC-IDE-C3-02](../../qa-ui-auto-tests/cases/TC-IDE-C3-02-native-clipboard-permission-and-multicaret.testcase.yaml)（本轮未运行）。
- **IDEA证据 / 环境 / 状态：** 待采：目标IU-262.10315.125，按本行fixture与步骤采同状态；本机只有I0项目树局部参照，不能跨场景复用。build/主题/scale/font/keymap/语言provider边界见IDEA对照摘要。
- **差异性质：** 纯证据缺口。缺证据本身不是产品bug；没有真实双侧支持的目标差异保留待验证。
- **需求 / 影响 / 方向：** [REQ-11](overall-audit-plan-20260913.md#req-11)，P0保留 / P1补证：正确性与数据兼容不可丢；本轮无这些native新证据，不能凭空报bug。保持现有正确事务/byte writer；先做有区分性的current native采样，再登记真实缺陷或体验改版。进入条件/依赖：同源QA与F1/F5；三端计划；与REQ-04共享undo/资源释放。
- **必须保留：** K0；OS已完成写入事实保留；失去owner不能迟到粘贴；一次IME确认一次undo。后续验收必须观察这些结果，不能只写“保持原功能”。
- **规格与任务来源：** [editor-experience.md](../../claudedocs/code-workspace-idea-specs/editor-experience.md)；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-CLIP-001`（原记录 2026-08-31T14:17:24Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-CLIP-002`（原记录 2026-08-31T14:33:06Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-CLIP-003`（原记录 2026-08-31T14:52:26Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-CLIP-004`（原记录 2026-09-01T23:24:00Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-VSPACE-001`（原记录 2026-08-31T18:00:27Z）；[code-workspace-idea-parity-backlog-2026-09-main-repair.md](../../claudedocs/code-workspace-idea-parity-backlog-2026-09-main-repair.md) `ED-REPAIR-003`（原记录 2026-09-12T01:30:00Z）；[code-workspace-idea-parity-backlog-2026-09-main-repair.md](../../claudedocs/code-workspace-idea-parity-backlog-2026-09-main-repair.md) `ED-REPAIR-007`（原记录 2026-09-12T14:30:00Z）；[code-workspace-idea-parity-backlog-2026-09-main-repair.md](../../claudedocs/code-workspace-idea-parity-backlog-2026-09-main-repair.md) `ED-REPAIR-008`（原记录 2026-09-12T15:13:00Z）。旧卡不重开；新观察需求尚未author/领取任务。
- **上次结论 / 本次变化：** 首次整体场景结论，无上一轮同ID三维判定；本轮新增目标、静态生产链和上述实际子样本。历史卡原验收及日期仅按原链接保留，未作为本轮PASS。当前判断日期2026-09-13；没有双侧新观测关闭差距。

<a id="cw-edit-003"></a>

### CW-EDIT-003 — 保存、编码、换行和规范化

- **IDEA目标结果：** 保存实际字节符合编码/EOL/EditorConfig；dirty并发、只读失败和重试清楚且不丢内容。目标为需求；除I0明确事实外，细节未冒充实测。
- **Fixture / 入口：** [F1/F5](references/fixture-catalog.md)；Save / Ctrl+S / status encoding,EOL / format on save。
- **完整采样序列（未列为已执行的步骤均待采）：** 编辑→保存→读取字节→切EOL/BOM→保存中继续输入→写失败/unknown→取消重试→恢复。每次保存初始/关键状态/退出后的原图或录屏，分别记录focus、caret/selection、菜单/弹层、错误、取消、undo与恢复；不适用项说明原因。
- **当前生产链 / 用户观察点：** Save / Ctrl+S / status encoding,EOL / format on save → CodeWorkspaceTab save → style controller → format/import/normalize/encoding plan → 单次 workspace_write_file_encoded → 回读/receipt/recovery → dirty、disk hash、Local History / conflict dialog。具体caller/符号/IPC与源文件：[S-SAVE](source-audit.md#save)。
- **状态owner / IPC-provider：** immutable prepared save；openFiles 当前 revision；save observation / recovery journal；history before-image。CodeWorkspaceTab save → style controller → format/import/normalize/encoding plan → 单次 workspace_write_file_encoded → 回读/receipt/recovery → dirty、disk hash、Local History / conflict dialog。真实provider、native build与OS边界未执行时保持unverified。
- **当前实现与实际观测：** prepared save、单writer与回读recovery生产可达；本轮未保存/读取原生字节；不从历史save receipt给当前通过。
- **独立结论：** 功能 **待验证**；视觉 **待验证**；交互 **待验证**。不输出百分比。
- **Taomni证据与当前性：** 无本轮关键状态原件：unverified（源码/case存在不改变此结论）。共用身份T0/provenance；原始日志、snapshot与具体焦点记录见baseline。未采正常/失败/取消/恢复状态仍缺失，已有case仅候选：[TC-IDE-C0-01](../../qa-ui-auto-tests/cases/TC-IDE-C0-01-save-transaction-stale-snapshot-and-disk-verification.testcase.yaml)；[TC-IDE-C0-02](../../qa-ui-auto-tests/cases/TC-IDE-C0-02-save-receipt-state-and-accessibility.testcase.yaml)（本轮未运行）。
- **IDEA证据 / 环境 / 状态：** 待采：目标IU-262.10315.125，按本行fixture与步骤采同状态；本机只有I0项目树局部参照，不能跨场景复用。build/主题/scale/font/keymap/语言provider边界见IDEA对照摘要。
- **差异性质：** 纯证据缺口。缺证据本身不是产品bug；没有真实双侧支持的目标差异保留待验证。
- **需求 / 影响 / 方向：** [REQ-11](overall-audit-plan-20260913.md#req-11)，P0保留 / P1补证：正确性与数据兼容不可丢；本轮无这些native新证据，不能凭空报bug。保持现有正确事务/byte writer；先做有区分性的current native采样，再登记真实缺陷或体验改版。进入条件/依赖：同源QA与F1/F5；三端计划；与REQ-04共享undo/资源释放。
- **必须保留：** K0；保存/取消/undo/恢复正确；六阶段 plan不可变；unknown effect禁止盲重试。后续验收必须观察这些结果，不能只写“保持原功能”。
- **规格与任务来源：** [code-actions-and-save.md](../../claudedocs/code-workspace-idea-specs/code-actions-and-save.md)；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-SAVE-001`（原记录 2026-09-01T00:17:41Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-SAVE-002`（原记录 2026-09-01T00:34:55Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-SAVE-003`（原记录 2026-09-01T01:17:35Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-SAVE-004`（原记录 2026-09-01T09:41:27Z）；[code-workspace-idea-parity-backlog-2026-09-main-repair.md](../../claudedocs/code-workspace-idea-parity-backlog-2026-09-main-repair.md) `ED-REPAIR-001`（原记录 2026-09-12T01:19:00Z）。旧卡不重开；新观察需求尚未author/领取任务。
- **上次结论 / 本次变化：** 首次整体场景结论，无上一轮同ID三维判定；本轮新增目标、静态生产链和上述实际子样本。历史卡原验收及日期仅按原链接保留，未作为本轮PASS。当前判断日期2026-09-13；没有双侧新观测关闭差距。

<a id="cw-edit-004"></a>

### CW-EDIT-004 — 外部冲突与 Local History 恢复

- **IDEA目标结果：** 外部修改和dirty冲突可比较、选择保留/重载/恢复；取消不丢任何版本。目标为需求；除I0明确事实外，细节未冒充实测。
- **Fixture / 入口：** [F1/F5](references/fixture-catalog.md)；watcher conflict banner / ExternalFileConflictDialog / LocalHistoryDialog。
- **完整采样序列（未列为已执行的步骤均待采）：** 打开并dirty→外部修改→比较→Cancel→保存副本/合并→历史恢复→undo→重启恢复未决记录。每次保存初始/关键状态/退出后的原图或录屏，分别记录focus、caret/selection、菜单/弹层、错误、取消、undo与恢复；不适用项说明原因。
- **当前生产链 / 用户观察点：** watcher conflict banner / ExternalFileConflictDialog / LocalHistoryDialog → CodeWorkspaceTab save → style controller → format/import/normalize/encoding plan → 单次 workspace_write_file_encoded → 回读/receipt/recovery → dirty、disk hash、Local History / conflict dialog。具体caller/符号/IPC与源文件：[S-SAVE](source-audit.md#save)。
- **状态owner / IPC-provider：** immutable prepared save；openFiles 当前 revision；save observation / recovery journal；history before-image。CodeWorkspaceTab save → style controller → format/import/normalize/encoding plan → 单次 workspace_write_file_encoded → 回读/receipt/recovery → dirty、disk hash、Local History / conflict dialog。真实provider、native build与OS边界未执行时保持unverified。
- **当前实现与实际观测：** 现有 conflict/history/journal 对话框与调用可达；本轮未制造外部变化或历史恢复。
- **独立结论：** 功能 **待验证**；视觉 **待验证**；交互 **待验证**。不输出百分比。
- **Taomni证据与当前性：** 无本轮关键状态原件：unverified（源码/case存在不改变此结论）。共用身份T0/provenance；原始日志、snapshot与具体焦点记录见baseline。未采正常/失败/取消/恢复状态仍缺失，已有case仅候选：[TC-IDE-C0-01](../../qa-ui-auto-tests/cases/TC-IDE-C0-01-save-transaction-stale-snapshot-and-disk-verification.testcase.yaml)；[TC-IDE-C0-02](../../qa-ui-auto-tests/cases/TC-IDE-C0-02-save-receipt-state-and-accessibility.testcase.yaml)（本轮未运行）。
- **IDEA证据 / 环境 / 状态：** 待采：目标IU-262.10315.125，按本行fixture与步骤采同状态；本机只有I0项目树局部参照，不能跨场景复用。build/主题/scale/font/keymap/语言provider边界见IDEA对照摘要。
- **差异性质：** 纯证据缺口。缺证据本身不是产品bug；没有真实双侧支持的目标差异保留待验证。
- **需求 / 影响 / 方向：** [REQ-11](overall-audit-plan-20260913.md#req-11)，P0保留 / P1补证：正确性与数据兼容不可丢；本轮无这些native新证据，不能凭空报bug。保持现有正确事务/byte writer；先做有区分性的current native采样，再登记真实缺陷或体验改版。进入条件/依赖：同源QA与F1/F5；三端计划；与REQ-04共享undo/资源释放。
- **必须保留：** K0；外部内容不可静默覆盖；before-image和待恢复日志持久；取消零写入。后续验收必须观察这些结果，不能只写“保持原功能”。
- **规格与任务来源：** [code-actions-and-save.md](../../claudedocs/code-workspace-idea-specs/code-actions-and-save.md)；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-SAVE-001`（原记录 2026-09-01T00:17:41Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-SAVE-002`（原记录 2026-09-01T00:34:55Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-SAVE-003`（原记录 2026-09-01T01:17:35Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-SAVE-004`（原记录 2026-09-01T09:41:27Z）；[code-workspace-idea-parity-backlog-2026-09-main-repair.md](../../claudedocs/code-workspace-idea-parity-backlog-2026-09-main-repair.md) `ED-REPAIR-001`（原记录 2026-09-12T01:19:00Z）。旧卡不重开；新观察需求尚未author/领取任务。
- **上次结论 / 本次变化：** 首次整体场景结论，无上一轮同ID三维判定；本轮新增目标、静态生产链和上述实际子样本。历史卡原验收及日期仅按原链接保留，未作为本轮PASS。当前判断日期2026-09-13；没有双侧新观测关闭差距。

<a id="cw-edit-005"></a>

### CW-EDIT-005 — 折叠、选区扩展、文档呈现与大文件

- **IDEA目标结果：** 结构折叠/选择、soft wrap与Markdown预览可切换，定位与大文件降级保持可编辑性。目标为需求；除I0明确事实外，细节未冒充实测。
- **Fixture / 入口：** [F1/F2/F5](references/fixture-catalog.md)；fold actions / smart selection / MarkdownPreview / wrap。
- **完整采样序列（未列为已执行的步骤均待采）：** 嵌套结构→扩展/收缩selection→fold/unfold→wrap/preview→大文件打开→搜索/保存/undo→恢复视图。每次保存初始/关键状态/退出后的原图或录屏，分别记录focus、caret/selection、菜单/弹层、错误、取消、undo与恢复；不适用项说明原因。
- **当前生产链 / 用户观察点：** fold actions / smart selection / MarkdownPreview / wrap → EditorGroup → CodeMirrorHost → CodeMirror commands / editor command port → transaction owner → openFiles 同步及 undo；剪贴板经 lib/clipboard 原生或 browser API，IME 归 OS → 正文/selection/caret。具体caller/符号/IPC与源文件：[S-EDIT](source-audit.md#edit)。
- **状态owner / IPC-provider：** CodeMirror EditorState/view；WorkspaceDocumentTransactionOwner；clipboard/composition session 按 view generation。剪贴板经 lib/clipboard 原生或 browser API，IME 归 OS → 正文/selection/caret。真实provider、native build与OS边界未执行时保持unverified。
- **当前实现与实际观测：** CodeMirror语言树、MarkdownPreview、largeFile和view-state路径存在；本轮未操作折叠、大文件、预览转换。
- **独立结论：** 功能 **待验证**；视觉 **待验证**；交互 **待验证**。不输出百分比。
- **Taomni证据与当前性：** 无本轮关键状态原件：unverified（源码/case存在不改变此结论）。共用身份T0/provenance；原始日志、snapshot与具体焦点记录见baseline。未采正常/失败/取消/恢复状态仍缺失，已有case仅候选：[TC-IDE-C3-01](../../qa-ui-auto-tests/cases/TC-IDE-C3-01-clipboard-session-across-splits-with-system-denial.testcase.yaml)；[TC-IDE-C3-02](../../qa-ui-auto-tests/cases/TC-IDE-C3-02-native-clipboard-permission-and-multicaret.testcase.yaml)（本轮未运行）。
- **IDEA证据 / 环境 / 状态：** 待采：目标IU-262.10315.125，按本行fixture与步骤采同状态；本机只有I0项目树局部参照，不能跨场景复用。build/主题/scale/font/keymap/语言provider边界见IDEA对照摘要。
- **差异性质：** 纯证据缺口。缺证据本身不是产品bug；没有真实双侧支持的目标差异保留待验证。
- **需求 / 影响 / 方向：** [REQ-11](overall-audit-plan-20260913.md#req-11)，P0保留 / P1补证：正确性与数据兼容不可丢；本轮无这些native新证据，不能凭空报bug。保持现有正确事务/byte writer；先做有区分性的current native采样，再登记真实缺陷或体验改版。进入条件/依赖：同源QA与F1/F5；三端计划；与REQ-04共享undo/资源释放。
- **必须保留：** K0；大文件仍能保存/undo；降级标签真实；折叠及滚动仅属正确view。后续验收必须观察这些结果，不能只写“保持原功能”。
- **规格与任务来源：** [editor-experience.md](../../claudedocs/code-workspace-idea-specs/editor-experience.md)；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-CLIP-001`（原记录 2026-08-31T14:17:24Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-CLIP-002`（原记录 2026-08-31T14:33:06Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-CLIP-003`（原记录 2026-08-31T14:52:26Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-CLIP-004`（原记录 2026-09-01T23:24:00Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-VSPACE-001`（原记录 2026-08-31T18:00:27Z）；[code-workspace-idea-parity-backlog-2026-09-main-repair.md](../../claudedocs/code-workspace-idea-parity-backlog-2026-09-main-repair.md) `ED-REPAIR-003`（原记录 2026-09-12T01:30:00Z）；[code-workspace-idea-parity-backlog-2026-09-main-repair.md](../../claudedocs/code-workspace-idea-parity-backlog-2026-09-main-repair.md) `ED-REPAIR-007`（原记录 2026-09-12T14:30:00Z）；[code-workspace-idea-parity-backlog-2026-09-main-repair.md](../../claudedocs/code-workspace-idea-parity-backlog-2026-09-main-repair.md) `ED-REPAIR-008`（原记录 2026-09-12T15:13:00Z）。旧卡不重开；新观察需求尚未author/领取任务。
- **上次结论 / 本次变化：** 首次整体场景结论，无上一轮同ID三维判定；本轮新增目标、静态生产链和上述实际子样本。历史卡原验收及日期仅按原链接保留，未作为本轮PASS。当前判断日期2026-09-13；没有双侧新观测关闭差距。

<a id="cw-nav-001"></a>

### CW-NAV-001 — Search Everywhere / File / Class / Symbol / Action

- **IDEA目标结果：** 双Shift和目标键位打开正确范围，结果可辨来源、空/错误/取消不跳错文件。目标为需求；除I0明确事实外，细节未冒充实测。
- **Fixture / 入口：** [F0/F2](references/fixture-catalog.md)；Double Shift / workspace.goToFile/goToClass/goToSymbol。
- **完整采样序列（未列为已执行的步骤均待采）：** 双Shift→files/classes/symbols/actions→输入有/无结果→键盘选中→Enter→Back→Esc取消。每次保存初始/关键状态/退出后的原图或录屏，分别记录focus、caret/selection、菜单/弹层、错误、取消、undo与恢复；不适用项说明原因。
- **当前生产链 / 用户观察点：** Double Shift / workspace.goToFile/goToClass/goToSymbol → workspace navigation action → navigation owner 或 semantic query host → workspace recursive files / lsp definition/references/hierarchy → openFile/reveal → 成功后 history；cancel/late result 门控。具体caller/符号/IPC与源文件：[S-NAV](source-audit.md#nav)。
- **状态owner / IPC-provider：** navigationHistory/location controller；SearchEverywhere query；WorkspaceSemanticQueryHost/usageSession 的 request、document、provider、project generation。cancel/late result 门控。真实provider、native build与OS边界未执行时保持unverified。
- **当前实现与实际观测：** B15 双Shift打开、keymap搜索返回两动作并进入设置；没有 class/symbol真实provider结果或取消恢复。
- **独立结论：** 功能 **待验证**；视觉 **待验证**；交互 **待验证**。不输出百分比。
- **Taomni证据与当前性：** [B15](../../qa-ui-auto-report/overall-audit-20260913/browser/15-search-everywhere.png)。共用身份T0/provenance；原始日志、snapshot与具体焦点记录见baseline。未采正常/失败/取消/恢复状态仍缺失，已有case仅候选：[TC-IDE-C6-01](../../qa-ui-auto-tests/cases/TC-IDE-C6-01-usages-grouping-pin-rerun-under-jdtls.testcase.yaml)；[TC-IDE-C6-02](../../qa-ui-auto-tests/cases/TC-IDE-C6-02-query-definition-references-hierarchy-under-jdtls.testcase.yaml)（本轮未运行）。
- **IDEA证据 / 环境 / 状态：** 待采：目标IU-262.10315.125，按本行fixture与步骤采同状态；本机只有I0项目树局部参照，不能跨场景复用。build/主题/scale/font/keymap/语言provider边界见IDEA对照摘要。
- **差异性质：** 纯证据缺口。缺证据本身不是产品bug；没有真实双侧支持的目标差异保留待验证。
- **需求 / 影响 / 方向：** [REQ-05](overall-audit-plan-20260913.md#req-05)，P1：补全/导航依赖同一SDK、provider与project generation，影响主开发流。先固定Java代表fixture和provider，再逐动作比结果、空/失败/取消、选择与文档弹层；后续扩语言。进入条件/依赖：F2真实SDK/JDT LS/IDEA索引；F4逐语言/edition；依赖REQ-10设置语义。
- **必须保留：** K0；动作来自同一host；迟到query不覆盖新query；成功reveal后才写history。后续验收必须观察这些结果，不能只写“保持原功能”。
- **规格与任务来源：** [search-and-navigation.md](../../claudedocs/code-workspace-idea-specs/search-and-navigation.md)；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-NAV-001`（原记录 2026-09-03T01:28:00Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-NAV-002`（原记录 2026-09-03T12:44:00+08:00）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-QUERY-001`（原记录 2026-09-02T22:00:39Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-QUERY-002`（原记录 2026-09-02T23:16:28Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-QUERY-003`（原记录 2026-09-03T00:50:00Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-QUERY-004`（原记录 2026-09-04T00:04:01Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-USAGE-001`（原记录 2026-09-03T01:35:00Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-USAGE-002`（原记录 2026-09-04T07:23:00Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-BOOKMARK-001`（原记录 2026-09-03T01:46:00Z）。旧卡不重开；新观察需求尚未author/领取任务。
- **上次结论 / 本次变化：** 首次整体场景结论，无上一轮同ID三维判定；本轮新增目标、静态生产链和上述实际子样本。历史卡原验收及日期仅按原链接保留，未作为本轮PASS。当前判断日期2026-09-13；没有双侧新观测关闭差距。

<a id="cw-nav-002"></a>

### CW-NAV-002 — 声明、类型、实现与依赖源码导航

- **IDEA目标结果：** 从引用到声明/实现/类型，库源码可只读打开，Back恢复原caret/selection。目标为需求；除I0明确事实外，细节未冒充实测。
- **Fixture / 入口：** [F2](references/fixture-catalog.md)；Ctrl/Cmd+B / modifier-hover / quick definition / library source。
- **完整采样序列（未列为已执行的步骤均待采）：** 调用点→定义→实现/类型→库源码/下载源码→Back→无结果/取消→provider重启后重试。每次保存初始/关键状态/退出后的原图或录屏，分别记录focus、caret/selection、菜单/弹层、错误、取消、undo与恢复；不适用项说明原因。
- **当前生产链 / 用户观察点：** Ctrl/Cmd+B / modifier-hover / quick definition / library source → workspace navigation action → navigation owner 或 semantic query host → workspace recursive files / lsp definition/references/hierarchy → openFile/reveal → 成功后 history；cancel/late result 门控。具体caller/符号/IPC与源文件：[S-NAV](source-audit.md#nav)。
- **状态owner / IPC-provider：** navigationHistory/location controller；SearchEverywhere query；WorkspaceSemanticQueryHost/usageSession 的 request、document、provider、project generation。cancel/late result 门控。真实provider、native build与OS边界未执行时保持unverified。
- **当前实现与实际观测：** WorkspaceSemanticQueryHost、library来源和navigation owner生产可达；本轮没有真实语言导航，不能从模型推定正确结果集。
- **独立结论：** 功能 **待验证**；视觉 **待验证**；交互 **待验证**。不输出百分比。
- **Taomni证据与当前性：** 无本轮关键状态原件：unverified（源码/case存在不改变此结论）。共用身份T0/provenance；原始日志、snapshot与具体焦点记录见baseline。未采正常/失败/取消/恢复状态仍缺失，已有case仅候选：[TC-IDE-C6-01](../../qa-ui-auto-tests/cases/TC-IDE-C6-01-usages-grouping-pin-rerun-under-jdtls.testcase.yaml)；[TC-IDE-C6-02](../../qa-ui-auto-tests/cases/TC-IDE-C6-02-query-definition-references-hierarchy-under-jdtls.testcase.yaml)（本轮未运行）。
- **IDEA证据 / 环境 / 状态：** 待采：目标IU-262.10315.125，按本行fixture与步骤采同状态；本机只有I0项目树局部参照，不能跨场景复用。build/主题/scale/font/keymap/语言provider边界见IDEA对照摘要。
- **差异性质：** 纯证据缺口；provider限制待验证。缺证据本身不是产品bug；没有真实双侧支持的目标差异保留待验证。
- **需求 / 影响 / 方向：** [REQ-05](overall-audit-plan-20260913.md#req-05)，P1：补全/导航依赖同一SDK、provider与project generation，影响主开发流。先固定Java代表fixture和provider，再逐动作比结果、空/失败/取消、选择与文档弹层；后续扩语言。进入条件/依赖：F2真实SDK/JDT LS/IDEA索引；F4逐语言/edition；依赖REQ-10设置语义。
- **必须保留：** K0；取消零reveal/history；库源码只读；四阶段generation门控和跨root隔离。后续验收必须观察这些结果，不能只写“保持原功能”。
- **规格与任务来源：** [search-and-navigation.md](../../claudedocs/code-workspace-idea-specs/search-and-navigation.md)；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-NAV-001`（原记录 2026-09-03T01:28:00Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-NAV-002`（原记录 2026-09-03T12:44:00+08:00）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-QUERY-001`（原记录 2026-09-02T22:00:39Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-QUERY-002`（原记录 2026-09-02T23:16:28Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-QUERY-003`（原记录 2026-09-03T00:50:00Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-QUERY-004`（原记录 2026-09-04T00:04:01Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-USAGE-001`（原记录 2026-09-03T01:35:00Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-USAGE-002`（原记录 2026-09-04T07:23:00Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-BOOKMARK-001`（原记录 2026-09-03T01:46:00Z）。旧卡不重开；新观察需求尚未author/领取任务。
- **上次结论 / 本次变化：** 首次整体场景结论，无上一轮同ID三维判定；本轮新增目标、静态生产链和上述实际子样本。历史卡原验收及日期仅按原链接保留，未作为本轮PASS。当前判断日期2026-09-13；没有双侧新观测关闭差距。


- **2026-09-14 P1 局部接续：** [WP-FIND-FOCUS-01 设计](../../docs-issue/code-workspace-find-focus-design.md)、[ED-FINDFOCUS-001 唯一任务板](../../claudedocs/code-workspace-idea-parity-backlog-find-focus.md)、[真实 Find 参照](references/find-focus-2026.2.2.md)。本场景为受影响保留消费者，未开展其全量对齐。原功能/视觉/交互三维结论和差异类型保留，未关闭场景差距；任务状态仅看板。

<a id="cw-nav-003"></a>

### CW-NAV-003 — Find / Show Usages 与 Call / Type Hierarchy

- **IDEA目标结果：** 引用按读/写/声明/库与scope呈现，跳转、pin、rerun和层级展开可恢复。目标为需求；除I0明确事实外，细节未冒充实测。
- **Fixture / 入口：** [F2](references/fixture-catalog.md)；workspace.findReferences/showUsages/callHierarchy/typeHierarchy。
- **完整采样序列（未列为已执行的步骤均待采）：** 定位符号→Show→Find工具窗→过滤scope→pin→rerun→层级展开→Esc/Back→改文件后重查。每次保存初始/关键状态/退出后的原图或录屏，分别记录focus、caret/selection、菜单/弹层、错误、取消、undo与恢复；不适用项说明原因。
- **当前生产链 / 用户观察点：** workspace.findReferences/showUsages/callHierarchy/typeHierarchy → workspace navigation action → navigation owner 或 semantic query host → workspace recursive files / lsp definition/references/hierarchy → openFile/reveal → 成功后 history；cancel/late result 门控。具体caller/符号/IPC与源文件：[S-NAV](source-audit.md#nav)。
- **状态owner / IPC-provider：** navigationHistory/location controller；SearchEverywhere query；WorkspaceSemanticQueryHost/usageSession 的 request、document、provider、project generation。cancel/late result 门控。真实provider、native build与OS边界未执行时保持unverified。
- **当前实现与实际观测：** References等面板有生产consumer，providerUsageEvidence已接入；本轮只见空References，不算完成语义场景。
- **独立结论：** 功能 **待验证**；视觉 **待验证**；交互 **待验证**。不输出百分比。
- **Taomni证据与当前性：** 无本轮关键状态原件：unverified（源码/case存在不改变此结论）。共用身份T0/provenance；原始日志、snapshot与具体焦点记录见baseline。未采正常/失败/取消/恢复状态仍缺失，已有case仅候选：[TC-IDE-C6-01](../../qa-ui-auto-tests/cases/TC-IDE-C6-01-usages-grouping-pin-rerun-under-jdtls.testcase.yaml)；[TC-IDE-C6-02](../../qa-ui-auto-tests/cases/TC-IDE-C6-02-query-definition-references-hierarchy-under-jdtls.testcase.yaml)（本轮未运行）。
- **IDEA证据 / 环境 / 状态：** 待采：目标IU-262.10315.125，按本行fixture与步骤采同状态；本机只有I0项目树局部参照，不能跨场景复用。build/主题/scale/font/keymap/语言provider边界见IDEA对照摘要。
- **差异性质：** 纯证据缺口；完整性待证。缺证据本身不是产品bug；没有真实双侧支持的目标差异保留待验证。
- **需求 / 影响 / 方向：** [REQ-05](overall-audit-plan-20260913.md#req-05)，P1：补全/导航依赖同一SDK、provider与project generation，影响主开发流。先固定Java代表fixture和provider，再逐动作比结果、空/失败/取消、选择与文档弹层；后续扩语言。进入条件/依赖：F2真实SDK/JDT LS/IDEA索引；F4逐语言/edition；依赖REQ-10设置语义。
- **必须保留：** K0；未知role/completeness不伪装完整；旧query取消；pinned identity保留。后续验收必须观察这些结果，不能只写“保持原功能”。
- **规格与任务来源：** [search-and-navigation.md](../../claudedocs/code-workspace-idea-specs/search-and-navigation.md)；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-NAV-001`（原记录 2026-09-03T01:28:00Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-NAV-002`（原记录 2026-09-03T12:44:00+08:00）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-QUERY-001`（原记录 2026-09-02T22:00:39Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-QUERY-002`（原记录 2026-09-02T23:16:28Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-QUERY-003`（原记录 2026-09-03T00:50:00Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-QUERY-004`（原记录 2026-09-04T00:04:01Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-USAGE-001`（原记录 2026-09-03T01:35:00Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-USAGE-002`（原记录 2026-09-04T07:23:00Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-BOOKMARK-001`（原记录 2026-09-03T01:46:00Z）。旧卡不重开；新观察需求尚未author/领取任务。
- **上次结论 / 本次变化：** 首次整体场景结论，无上一轮同ID三维判定；本轮新增目标、静态生产链和上述实际子样本。历史卡原验收及日期仅按原链接保留，未作为本轮PASS。当前判断日期2026-09-13；没有双侧新观测关闭差距。

<a id="cw-nav-004"></a>

### CW-NAV-004 — Recent Locations、书签、结构与导航条

- **IDEA目标结果：** 最近位置/编辑点、书签、结构树和breadcrumbs可仅键盘导航并返回原上下文。目标为需求；除I0明确事实外，细节未冒充实测。
- **Fixture / 入口：** [F1/F2](references/fixture-catalog.md)；Recent Files/Locations / Last Edit / Bookmarks / Breadcrumbs / Structure。
- **完整采样序列（未列为已执行的步骤均待采）：** 跨文件定位与编辑→Recent/LastEdit→书签→结构/导航条→Enter跳转→Esc/Back→文件重命名后重查。每次保存初始/关键状态/退出后的原图或录屏，分别记录focus、caret/selection、菜单/弹层、错误、取消、undo与恢复；不适用项说明原因。
- **当前生产链 / 用户观察点：** Recent Files/Locations / Last Edit / Bookmarks / Breadcrumbs / Structure → workspace navigation action → navigation owner 或 semantic query host → workspace recursive files / lsp definition/references/hierarchy → openFile/reveal → 成功后 history；cancel/late result 门控。具体caller/符号/IPC与源文件：[S-NAV](source-audit.md#nav)。
- **状态owner / IPC-provider：** navigationHistory/location controller；SearchEverywhere query；WorkspaceSemanticQueryHost/usageSession 的 request、document、provider、project generation。cancel/late result 门控。真实provider、native build与OS边界未执行时保持unverified。
- **当前实现与实际观测：** 生产 navigation history、Breadcrumbs、RecentLocations和bookmarks可达；本轮未执行这些连续行为。
- **独立结论：** 功能 **待验证**；视觉 **待验证**；交互 **待验证**。不输出百分比。
- **Taomni证据与当前性：** 无本轮关键状态原件：unverified（源码/case存在不改变此结论）。共用身份T0/provenance；原始日志、snapshot与具体焦点记录见baseline。未采正常/失败/取消/恢复状态仍缺失，已有case仅候选：[TC-IDE-C6-01](../../qa-ui-auto-tests/cases/TC-IDE-C6-01-usages-grouping-pin-rerun-under-jdtls.testcase.yaml)；[TC-IDE-C6-02](../../qa-ui-auto-tests/cases/TC-IDE-C6-02-query-definition-references-hierarchy-under-jdtls.testcase.yaml)（本轮未运行）。
- **IDEA证据 / 环境 / 状态：** 待采：目标IU-262.10315.125，按本行fixture与步骤采同状态；本机只有I0项目树局部参照，不能跨场景复用。build/主题/scale/font/keymap/语言provider边界见IDEA对照摘要。
- **差异性质：** 纯证据缺口。缺证据本身不是产品bug；没有真实双侧支持的目标差异保留待验证。
- **需求 / 影响 / 方向：** [REQ-05](overall-audit-plan-20260913.md#req-05)，P1：补全/导航依赖同一SDK、provider与project generation，影响主开发流。先固定Java代表fixture和provider，再逐动作比结果、空/失败/取消、选择与文档弹层；后续扩语言。进入条件/依赖：F2真实SDK/JDT LS/IDEA索引；F4逐语言/edition；依赖REQ-10设置语义。
- **必须保留：** K0；history只记录实际reveal；重命名/删除更新location；cancel保留原选区。后续验收必须观察这些结果，不能只写“保持原功能”。
- **规格与任务来源：** [search-and-navigation.md](../../claudedocs/code-workspace-idea-specs/search-and-navigation.md)；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-NAV-001`（原记录 2026-09-03T01:28:00Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-NAV-002`（原记录 2026-09-03T12:44:00+08:00）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-QUERY-001`（原记录 2026-09-02T22:00:39Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-QUERY-002`（原记录 2026-09-02T23:16:28Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-QUERY-003`（原记录 2026-09-03T00:50:00Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-QUERY-004`（原记录 2026-09-04T00:04:01Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-USAGE-001`（原记录 2026-09-03T01:35:00Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-USAGE-002`（原记录 2026-09-04T07:23:00Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-BOOKMARK-001`（原记录 2026-09-03T01:46:00Z）。旧卡不重开；新观察需求尚未author/领取任务。
- **上次结论 / 本次变化：** 首次整体场景结论，无上一轮同ID三维判定；本轮新增目标、静态生产链和上述实际子样本。历史卡原验收及日期仅按原链接保留，未作为本轮PASS。当前判断日期2026-09-13；没有双侧新观测关闭差距。

<a id="cw-search-001"></a>

### CW-SEARCH-001 — 文件内查找替换与焦点返回

- **IDEA目标结果：** Ctrl+F/R打开查询，无重入异常；匹配、上下条、选择范围、regex、preserve case与Esc返回可预测。目标为需求；除I0明确事实外，细节未冒充实测。
- **Fixture / 入口：** [F0/F1](references/fixture-catalog.md)；editor Ctrl+F → WorkspaceSearchPanel.mount。
- **完整采样序列（未列为已执行的步骤均待采）：** example正文获焦→Ctrl+F→tree→Enter/Shift+Enter→Esc→再次Ctrl+F；F1加regex/selection/replace→undo。每次保存初始/关键状态/退出后的原图或录屏，分别记录focus、caret/selection、菜单/弹层、错误、取消、undo与恢复；不适用项说明原因。
- **当前生产链 / 用户观察点：** editor Ctrl+F → WorkspaceSearchPanel.mount → 本地：CodeMirrorHost → WorkspaceSearchPanel / SearchQuery；项目：FindInFilesPanel → scope plan → workspace_search_start/cancel（native ripgrep / browser VFS）→ ReplacePreviewDialog → onReplaceMatches → preimage 检查/apply/history。具体caller/符号/IPC与源文件：[S-SEARCH](source-audit.md#search)。
- **状态owner / IPC-provider：** CodeMirror SearchQuery / panel focus；FindInFilesPanel searchId/preview/token；WorkspaceEdit journal owner。项目：FindInFilesPanel → scope plan → workspace_search_start/cancel（native ripgrep / browser VFS）→ ReplacePreviewDialog → onReplaceMatches → preimage 检查/apply/history。真实provider、native build与OS边界未执行时保持unverified。
- **当前实现与实际观测：** B08/B18两次CM更新重入异常；B09仍显示2 matches；正文没有修改。native影响和Esc caret恢复待验证。
- **独立结论：** 功能 **待验证**；视觉 **待验证**；交互 **待验证**。不输出百分比。
- **Taomni证据与当前性：** [B08](../../qa-ui-auto-report/overall-audit-20260913/browser/08-editor-find.png) / [B09](../../qa-ui-auto-report/overall-audit-20260913/browser/09-find-results.png) / [B18](../../qa-ui-auto-report/overall-audit-20260913/browser/18-find-repro.png)。共用身份T0/provenance；原始日志、snapshot与具体焦点记录见baseline。未采正常/失败/取消/恢复状态仍缺失，已有case仅候选：[TC-IDE-D2-01-replace-preview-exclude-cancel-browser](../../qa-ui-auto-tests/cases/TC-IDE-D2-01-replace-preview-exclude-cancel-browser.testcase.yaml)；[TC-IDE-D2-02-replace-commit-undo-native](../../qa-ui-auto-tests/cases/TC-IDE-D2-02-replace-commit-undo-native.testcase.yaml)（本轮未运行）。
- **IDEA证据 / 环境 / 状态：** 待采：目标IU-262.10315.125，按本行fixture与步骤采同状态；本机只有I0项目树局部参照，不能跨场景复用。build/主题/scale/font/keymap/语言provider边界见IDEA对照摘要。
- **差异性质：** 确认产品缺陷（browser renderer）；其余纯证据缺口。缺证据本身不是产品bug；没有真实双侧支持的目标差异保留待验证。
- **需求 / 影响 / 方向：** [REQ-01](overall-audit-plan-20260913.md#req-01)，P0：高频入口已有可重复异常，影响搜索与modifier-hover共享消费者。先修复同步focus触发的CM重入；明确打开/取消/回焦状态机，复用当前动作与文档owner。进入条件/依赖：目标IDEA查找关键状态；当前renderer反例；后续native小范围复现。
- **必须保留：** K0；不破坏Ctrl/Cmd-hover定义、搜索文本/选区、只读编辑、共享undo和取消无正文修改。后续验收必须观察这些结果，不能只写“保持原功能”。
- **规格与任务来源：** [search-and-navigation.md](../../claudedocs/code-workspace-idea-specs/search-and-navigation.md)；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-FIND-001`（原记录 2026-09-03T01:23:00Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-FIND-002`（原记录 2026-09-03T01:26:00Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-FIND-003`（原记录 2026-09-04T03:36:22Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-FIND-004`（原记录 2026-09-04T06:02:00Z）；[code-workspace-idea-parity-backlog-2026-09-main-repair.md](../../claudedocs/code-workspace-idea-parity-backlog-2026-09-main-repair.md) `ED-REPAIR-002`（原记录 2026-09-12T13:30:00Z）；[code-workspace-idea-parity-backlog-2026-09-main-repair.md](../../claudedocs/code-workspace-idea-parity-backlog-2026-09-main-repair.md) `ED-REPAIR-005`（原记录 2026-09-12T03:10:00Z）；[code-workspace-idea-parity-backlog-2026-09-main-repair.md](../../claudedocs/code-workspace-idea-parity-backlog-2026-09-main-repair.md) `ED-REPAIR-006`（原记录 2026-09-12T02:38:00Z）。旧卡不重开；新观察需求尚未author/领取任务。
- **上次结论 / 本次变化：** 首次整体场景结论，无上一轮同ID三维判定；本轮新增目标、静态生产链和上述实际子样本。历史卡原验收及日期仅按原链接保留，未作为本轮PASS。当前判断日期2026-09-13；没有双侧新观测关闭差距。


- **2026-09-14 P1 局部接续：** [WP-FIND-FOCUS-01 设计](../../docs-issue/code-workspace-find-focus-design.md)、[ED-FINDFOCUS-001 唯一任务板](../../claudedocs/code-workspace-idea-parity-backlog-find-focus.md)、[真实 Find 参照](references/find-focus-2026.2.2.md)。补得 F0 Find/query/Enter/Shift+Enter/Esc/repeat 的 IDEA 侧观察；Taomni candidate 尚未实施或执行。原功能/视觉/交互三维结论和差异类型保留，未关闭场景差距；任务状态仅看板。

<a id="cw-search-002"></a>

### CW-SEARCH-002 — 项目查找、范围与批量替换预览

- **IDEA目标结果：** 按scope/mask得到完整结果，可排除行/文件，提交前检查冲突，单次undo和部分失败可恢复。目标为需求；除I0明确事实外，细节未冒充实测。
- **Fixture / 入口：** [F1/F2/F5](references/fixture-catalog.md)；Find in Files / Replace in Files / ReplacePreviewDialog。
- **完整采样序列（未列为已执行的步骤均待采）：** 选module/directory/mask→搜索→取消晚结果→Replace Preview→exclude→Cancel→重开Commit→冲突/partial failure→undo。每次保存初始/关键状态/退出后的原图或录屏，分别记录focus、caret/selection、菜单/弹层、错误、取消、undo与恢复；不适用项说明原因。
- **当前生产链 / 用户观察点：** Find in Files / Replace in Files / ReplacePreviewDialog → 本地：CodeMirrorHost → WorkspaceSearchPanel / SearchQuery；项目：FindInFilesPanel → scope plan → workspace_search_start/cancel（native ripgrep / browser VFS）→ ReplacePreviewDialog → onReplaceMatches → preimage 检查/apply/history。具体caller/符号/IPC与源文件：[S-SEARCH](source-audit.md#search)。
- **状态owner / IPC-provider：** CodeMirror SearchQuery / panel focus；FindInFilesPanel searchId/preview/token；WorkspaceEdit journal owner。项目：FindInFilesPanel → scope plan → workspace_search_start/cancel（native ripgrep / browser VFS）→ ReplacePreviewDialog → onReplaceMatches → preimage 检查/apply/history。真实provider、native build与OS边界未执行时保持unverified。
- **当前实现与实际观测：** B12只采空面板；scope model、frozen preview、onReplaceMatches与预检生产已接线，纠正旧spec未接线线索；没有本轮替换证据。
- **独立结论：** 功能 **待验证**；视觉 **待验证**；交互 **待验证**。不输出百分比。
- **Taomni证据与当前性：** [B12](../../qa-ui-auto-report/overall-audit-20260913/browser/12-find-in-files.png)。共用身份T0/provenance；原始日志、snapshot与具体焦点记录见baseline。未采正常/失败/取消/恢复状态仍缺失，已有case仅候选：[TC-IDE-D2-01-replace-preview-exclude-cancel-browser](../../qa-ui-auto-tests/cases/TC-IDE-D2-01-replace-preview-exclude-cancel-browser.testcase.yaml)；[TC-IDE-D2-02-replace-commit-undo-native](../../qa-ui-auto-tests/cases/TC-IDE-D2-02-replace-commit-undo-native.testcase.yaml)（本轮未运行）。
- **IDEA证据 / 环境 / 状态：** 待采：目标IU-262.10315.125，按本行fixture与步骤采同状态；本机只有I0项目树局部参照，不能跨场景复用。build/主题/scale/font/keymap/语言provider边界见IDEA对照摘要。
- **差异性质：** 纯证据缺口。缺证据本身不是产品bug；没有真实双侧支持的目标差异保留待验证。
- **需求 / 影响 / 方向：** [REQ-08](overall-audit-plan-20260913.md#req-08)，P1：跨文件结果和误替换风险高，当前preview已接线而证据不足。按真实scope和hash fixture补preview/exclusion/cancel/commit/undo，再评估面板与弹窗组织。进入条件/依赖：REQ-05 module facts、REQ-11字节/恢复、F1/F2/F5。
- **必须保留：** K0；冻结查询和preimages；取消零commit；部分写入记录真实effects/recovery。后续验收必须观察这些结果，不能只写“保持原功能”。
- **规格与任务来源：** [search-and-navigation.md](../../claudedocs/code-workspace-idea-specs/search-and-navigation.md)；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-FIND-001`（原记录 2026-09-03T01:23:00Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-FIND-002`（原记录 2026-09-03T01:26:00Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-FIND-003`（原记录 2026-09-04T03:36:22Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-FIND-004`（原记录 2026-09-04T06:02:00Z）；[code-workspace-idea-parity-backlog-2026-09-main-repair.md](../../claudedocs/code-workspace-idea-parity-backlog-2026-09-main-repair.md) `ED-REPAIR-002`（原记录 2026-09-12T13:30:00Z）；[code-workspace-idea-parity-backlog-2026-09-main-repair.md](../../claudedocs/code-workspace-idea-parity-backlog-2026-09-main-repair.md) `ED-REPAIR-005`（原记录 2026-09-12T03:10:00Z）；[code-workspace-idea-parity-backlog-2026-09-main-repair.md](../../claudedocs/code-workspace-idea-parity-backlog-2026-09-main-repair.md) `ED-REPAIR-006`（原记录 2026-09-12T02:38:00Z）。旧卡不重开；新观察需求尚未author/领取任务。
- **上次结论 / 本次变化：** 首次整体场景结论，无上一轮同ID三维判定；本轮新增目标、静态生产链和上述实际子样本。历史卡原验收及日期仅按原链接保留，未作为本轮PASS。当前判断日期2026-09-13；没有双侧新观测关闭差距。

<a id="cw-search-003"></a>

### CW-SEARCH-003 — Structural Search / Replace

- **IDEA目标结果：** 能以结构模板与变量约束匹配语法，预览准确范围并安全替换/undo。目标为需求；除I0明确事实外，细节未冒充实测。
- **Fixture / 入口：** [F2](references/fixture-catalog.md)；目标 IDEA Structural Search/Replace；Taomni未找到生产入口。
- **完整采样序列（未列为已执行的步骤均待采）：** 结构模板→类型/文本/计数变量约束→scope→预览→排除→Cancel→Replace→undo。每次保存初始/关键状态/退出后的原图或录屏，分别记录focus、caret/selection、菜单/弹层、错误、取消、undo与恢复；不适用项说明原因。
- **当前生产链 / 用户观察点：** 目标 IDEA Structural Search/Replace；Taomni未找到生产入口 → 本地：CodeMirrorHost → WorkspaceSearchPanel / SearchQuery；项目：FindInFilesPanel → scope plan → workspace_search_start/cancel（native ripgrep / browser VFS）→ ReplacePreviewDialog → onReplaceMatches → preimage 检查/apply/history。具体caller/符号/IPC与源文件：[S-SEARCH](source-audit.md#search)。
- **状态owner / IPC-provider：** CodeMirror SearchQuery / panel focus；FindInFilesPanel searchId/preview/token；WorkspaceEdit journal owner。项目：FindInFilesPanel → scope plan → workspace_search_start/cancel（native ripgrep / browser VFS）→ ReplacePreviewDialog → onReplaceMatches → preimage 检查/apply/history。真实provider、native build与OS边界未执行时保持unverified。
- **当前实现与实际观测：** companionCapabilities SSR_SUPPORTED_LANGUAGES为空，排除tests/experimental后的搜索没有生产consumer；本轮无双侧动作。静态能力缺失已确认，三维仍待验证。
- **独立结论：** 功能 **待验证**；视觉 **待验证**；交互 **待验证**。不输出百分比。
- **Taomni证据与当前性：** 无本轮关键状态原件：unverified（源码/case存在不改变此结论）。共用身份T0/provenance；原始日志、snapshot与具体焦点记录见baseline。未采正常/失败/取消/恢复状态仍缺失，已有case仅候选：[TC-IDE-D2-01-replace-preview-exclude-cancel-browser](../../qa-ui-auto-tests/cases/TC-IDE-D2-01-replace-preview-exclude-cancel-browser.testcase.yaml)；[TC-IDE-D2-02-replace-commit-undo-native](../../qa-ui-auto-tests/cases/TC-IDE-D2-02-replace-commit-undo-native.testcase.yaml)（本轮未运行）。
- **IDEA证据 / 环境 / 状态：** 待采：目标IU-262.10315.125，按本行fixture与步骤采同状态；本机只有I0项目树局部参照，不能跨场景复用。build/主题/scale/font/keymap/语言provider边界见IDEA对照摘要。
- **差异性质：** 能力缺失（源码）；目标行为待采。缺证据本身不是产品bug；没有真实双侧支持的目标差异保留待验证。
- **需求 / 影响 / 方向：** [REQ-09](overall-audit-plan-20260913.md#req-09)，P2：源代码能证实生产引擎缺口；成本和语言/edition边界尚不充分。独立能力设计，先采IDEA输入输出与取消/accept；不能用Basic、regex或Terminal FIM充数。进入条件/依赖：目标语言/edition/model/SDK明确；REQ-05和安全事务owner。
- **必须保留：** K0；不能用regex结果冒充结构匹配；新引擎不得绕过WorkspaceEdit取消/undo/恢复。后续验收必须观察这些结果，不能只写“保持原功能”。
- **规格与任务来源：** [search-and-navigation.md](../../claudedocs/code-workspace-idea-specs/search-and-navigation.md)；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-FIND-001`（原记录 2026-09-03T01:23:00Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-FIND-002`（原记录 2026-09-03T01:26:00Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-FIND-003`（原记录 2026-09-04T03:36:22Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-FIND-004`（原记录 2026-09-04T06:02:00Z）；[code-workspace-idea-parity-backlog-2026-09-main-repair.md](../../claudedocs/code-workspace-idea-parity-backlog-2026-09-main-repair.md) `ED-REPAIR-002`（原记录 2026-09-12T13:30:00Z）；[code-workspace-idea-parity-backlog-2026-09-main-repair.md](../../claudedocs/code-workspace-idea-parity-backlog-2026-09-main-repair.md) `ED-REPAIR-005`（原记录 2026-09-12T03:10:00Z）；[code-workspace-idea-parity-backlog-2026-09-main-repair.md](../../claudedocs/code-workspace-idea-parity-backlog-2026-09-main-repair.md) `ED-REPAIR-006`（原记录 2026-09-12T02:38:00Z）。旧卡不重开；新观察需求尚未author/领取任务。
- **上次结论 / 本次变化：** 首次整体场景结论，无上一轮同ID三维判定；本轮新增目标、静态生产链和上述实际子样本。历史卡原验收及日期仅按原链接保留，未作为本轮PASS。当前判断日期2026-09-13；没有双侧新观测关闭差距。

<a id="cw-lang-001"></a>

### CW-LANG-001 — SDK、导入、索引状态与服务恢复

- **IDEA目标结果：** 导入就绪/索引/错误可辨；项目SDK、modules/dependencies正确，服务重启后无陈旧能力。目标为需求；除I0明确事实外，细节未冒充实测。
- **Fixture / 入口：** [F2](references/fixture-catalog.md)；Workspace SDKs / Facts badge / LSP settings / import refresh。
- **完整采样序列（未列为已执行的步骤均待采）：** 选项目SDK→Maven/Gradle导入→等待ready→制造broken classpath→修复刷新→重启provider→跨root切换。每次保存初始/关键状态/退出后的原图或录屏，分别记录focus、caret/selection、菜单/弹层、错误、取消、undo与恢复；不适用项说明原因。
- **当前生产链 / 用户观察点：** Workspace SDKs / Facts badge / LSP settings / import refresh → CodeWorkspaceTab → LSP session / project facts → lib/editor/lsp / workspaceTooling → Rust LSP/Maven/Gradle → 同 generation 数据 → completion/doc/problems；本轮 browser 没有真实 provider。具体caller/符号/IPC与源文件：[S-LANG](source-audit.md#lang)。
- **状态owner / IPC-provider：** WorkspaceLspSessionManager；lspFiles；projectFactsStore；completion candidate/session identity；diagnostic presentation profile。本轮 browser 没有真实 provider。真实provider、native build与OS边界未执行时保持unverified。
- **当前实现与实际观测：** B02 browser Facts Failed与No LSP仅为环境空缺；现有projectFactsConsumers/completion scope有生产调用，旧测试模型线索已过时。
- **独立结论：** 功能 **待验证**；视觉 **待验证**；交互 **待验证**。不输出百分比。
- **Taomni证据与当前性：** [B02](../../qa-ui-auto-report/overall-audit-20260913/browser/02-readme-open.png)。共用身份T0/provenance；原始日志、snapshot与具体焦点记录见baseline。未采正常/失败/取消/恢复状态仍缺失，已有case仅候选：[TC-IDE-C2-01](../../qa-ui-auto-tests/cases/TC-IDE-C2-01-jdtls-basic-completion-choice-and-one-undo-acceptance.testcase.yaml)；[TC-IDE-C2-02-completion-scope-fallback-browser](../../qa-ui-auto-tests/cases/TC-IDE-C2-02-completion-scope-fallback-browser.testcase.yaml)（本轮未运行）。
- **IDEA证据 / 环境 / 状态：** 待采：目标IU-262.10315.125，按本行fixture与步骤采同状态；本机只有I0项目树局部参照，不能跨场景复用。build/主题/scale/font/keymap/语言provider边界见IDEA对照摘要。
- **差异性质：** 纯证据缺口；环境限制。缺证据本身不是产品bug；没有真实双侧支持的目标差异保留待验证。
- **需求 / 影响 / 方向：** [REQ-05](overall-audit-plan-20260913.md#req-05)，P1：补全/导航依赖同一SDK、provider与project generation，影响主开发流。先固定Java代表fixture和provider，再逐动作比结果、空/失败/取消、选择与文档弹层；后续扩语言。进入条件/依赖：F2真实SDK/JDT LS/IDEA索引；F4逐语言/edition；依赖REQ-10设置语义。
- **必须保留：** K0；JBR不当项目JDK；ready generation才能提供module scope；不保留新session的旧capability。后续验收必须观察这些结果，不能只写“保持原功能”。
- **规格与任务来源：** [completion-and-query.md](../../claudedocs/code-workspace-idea-specs/completion-and-query.md)；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-COMP-001`（原记录 2026-09-02T21:15:24Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-COMP-002`（原记录 2026-09-02T21:28:55Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-COMP-003`（原记录 2026-09-02T21:47:23Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-COMP-004`（原记录 2026-09-04T01:15:30Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-PROJECT-001`（原记录 2026-09-02T23:25:12Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-PROJECT-002`（原记录 2026-09-03T23:34:34Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-PROJECT-003`（原记录 2026-09-03T23:37:00Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-PROJECT-004`（原记录 2026-09-04T00:23:00Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-PROJECT-005`（原记录 2026-09-04T00:50:56Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-DOC-001`（原记录 2026-09-03T01:41:00Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-CHROME-001`（原记录 2026-09-03T01:43:00Z）。旧卡不重开；新观察需求尚未author/领取任务。
- **上次结论 / 本次变化：** 首次整体场景结论，无上一轮同ID三维判定；本轮新增目标、静态生产链和上述实际子样本。历史卡原验收及日期仅按原链接保留，未作为本轮PASS。当前判断日期2026-09-13；没有双侧新观测关闭差距。

<a id="cw-lang-002"></a>

### CW-LANG-002 — Basic Completion、导入、snippet 与接受/撤销

- **IDEA目标结果：** 候选稳定、详情可解析，Enter/Tab接受主edit+import+snippet一次，取消/过期零编辑。目标为需求；除I0明确事实外，细节未冒充实测。
- **Fixture / 入口：** [F2/F4](references/fixture-catalog.md)；CodeMirror completion / explicit Ctrl+Space / auto trigger。
- **完整采样序列（未列为已执行的步骤均待采）：** 键入前缀→等候选→上下选择/resolve→Tab/Enter→snippet跳转→undo→超时/取消→再试。每次保存初始/关键状态/退出后的原图或录屏，分别记录focus、caret/selection、菜单/弹层、错误、取消、undo与恢复；不适用项说明原因。
- **当前生产链 / 用户观察点：** CodeMirror completion / explicit Ctrl+Space / auto trigger → CodeWorkspaceTab → LSP session / project facts → lib/editor/lsp / workspaceTooling → Rust LSP/Maven/Gradle → 同 generation 数据 → completion/doc/problems；本轮 browser 没有真实 provider。具体caller/符号/IPC与源文件：[S-LANG](source-audit.md#lang)。
- **状态owner / IPC-provider：** WorkspaceLspSessionManager；lspFiles；projectFactsStore；completion candidate/session identity；diagnostic presentation profile。本轮 browser 没有真实 provider。真实provider、native build与OS边界未执行时保持unverified。
- **当前实现与实际观测：** lspCompletion Controller/resolve gate、scope facts与additional edits已接入；本轮没有真实provider候选或accept/undo。
- **独立结论：** 功能 **待验证**；视觉 **待验证**；交互 **待验证**。不输出百分比。
- **Taomni证据与当前性：** 无本轮关键状态原件：unverified（源码/case存在不改变此结论）。共用身份T0/provenance；原始日志、snapshot与具体焦点记录见baseline。未采正常/失败/取消/恢复状态仍缺失，已有case仅候选：[TC-IDE-C2-01](../../qa-ui-auto-tests/cases/TC-IDE-C2-01-jdtls-basic-completion-choice-and-one-undo-acceptance.testcase.yaml)；[TC-IDE-C2-02-completion-scope-fallback-browser](../../qa-ui-auto-tests/cases/TC-IDE-C2-02-completion-scope-fallback-browser.testcase.yaml)（本轮未运行）。
- **IDEA证据 / 环境 / 状态：** 待采：目标IU-262.10315.125，按本行fixture与步骤采同状态；本机只有I0项目树局部参照，不能跨场景复用。build/主题/scale/font/keymap/语言provider边界见IDEA对照摘要。
- **差异性质：** 纯证据缺口。缺证据本身不是产品bug；没有真实双侧支持的目标差异保留待验证。
- **需求 / 影响 / 方向：** [REQ-05](overall-audit-plan-20260913.md#req-05)，P1：补全/导航依赖同一SDK、provider与project generation，影响主开发流。先固定Java代表fixture和provider，再逐动作比结果、空/失败/取消、选择与文档弹层；后续扩语言。进入条件/依赖：F2真实SDK/JDT LS/IDEA索引；F4逐语言/edition；依赖REQ-10设置语义。
- **必须保留：** K0；候选id/排序冻结；overlap/stale拒绝全plan；不能静默丢additional edits。后续验收必须观察这些结果，不能只写“保持原功能”。
- **规格与任务来源：** [completion-and-query.md](../../claudedocs/code-workspace-idea-specs/completion-and-query.md)；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-COMP-001`（原记录 2026-09-02T21:15:24Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-COMP-002`（原记录 2026-09-02T21:28:55Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-COMP-003`（原记录 2026-09-02T21:47:23Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-COMP-004`（原记录 2026-09-04T01:15:30Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-PROJECT-001`（原记录 2026-09-02T23:25:12Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-PROJECT-002`（原记录 2026-09-03T23:34:34Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-PROJECT-003`（原记录 2026-09-03T23:37:00Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-PROJECT-004`（原记录 2026-09-04T00:23:00Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-PROJECT-005`（原记录 2026-09-04T00:50:56Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-DOC-001`（原记录 2026-09-03T01:41:00Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-CHROME-001`（原记录 2026-09-03T01:43:00Z）。旧卡不重开；新观察需求尚未author/领取任务。
- **上次结论 / 本次变化：** 首次整体场景结论，无上一轮同ID三维判定；本轮新增目标、静态生产链和上述实际子样本。历史卡原验收及日期仅按原链接保留，未作为本轮PASS。当前判断日期2026-09-13；没有双侧新观测关闭差距。

<a id="cw-lang-003"></a>

### CW-LANG-003 — Smart / Type-Matching 与 Full Line

- **IDEA目标结果：** 预期类型过滤与内联整行补全按目标语言工作；部分接受/取消和隐私资源限制明确。目标为需求；除I0明确事实外，细节未冒充实测。
- **Fixture / 入口：** [F2/F4](references/fixture-catalog.md)；editor.smartCompletion；目标Full Line inline action。
- **完整采样序列（未列为已执行的步骤均待采）：** 期望类型位置→Smart重复调用→过滤/接受→undo；配置本地模型→inline→部分接受/取消→provider缺失。每次保存初始/关键状态/退出后的原图或录屏，分别记录focus、caret/selection、菜单/弹层、错误、取消、undo与恢复；不适用项说明原因。
- **当前生产链 / 用户观察点：** editor.smartCompletion；目标Full Line inline action → CodeWorkspaceTab → LSP session / project facts → lib/editor/lsp / workspaceTooling → Rust LSP/Maven/Gradle → 同 generation 数据 → completion/doc/problems；本轮 browser 没有真实 provider。具体caller/符号/IPC与源文件：[S-LANG](source-audit.md#lang)。
- **状态owner / IPC-provider：** WorkspaceLspSessionManager；lspFiles；projectFactsStore；completion candidate/session identity；diagnostic presentation profile。本轮 browser 没有真实 provider。真实provider、native build与OS边界未执行时保持unverified。
- **当前实现与实际观测：** Smart action when=false/run=false且provenance unsupported；Full Line只有companion模型，无editor生产runtime消费者。不可拿Basic popup或Terminal FIM替代。
- **独立结论：** 功能 **待验证**；视觉 **待验证**；交互 **待验证**。不输出百分比。
- **Taomni证据与当前性：** 无本轮关键状态原件：unverified（源码/case存在不改变此结论）。共用身份T0/provenance；原始日志、snapshot与具体焦点记录见baseline。未采正常/失败/取消/恢复状态仍缺失，已有case仅候选：[TC-IDE-C2-01](../../qa-ui-auto-tests/cases/TC-IDE-C2-01-jdtls-basic-completion-choice-and-one-undo-acceptance.testcase.yaml)；[TC-IDE-C2-02-completion-scope-fallback-browser](../../qa-ui-auto-tests/cases/TC-IDE-C2-02-completion-scope-fallback-browser.testcase.yaml)（本轮未运行）。
- **IDEA证据 / 环境 / 状态：** 待采：目标IU-262.10315.125，按本行fixture与步骤采同状态；本机只有I0项目树局部参照，不能跨场景复用。build/主题/scale/font/keymap/语言provider边界见IDEA对照摘要。
- **差异性质：** 能力缺失（源码）；edition/provider待决。缺证据本身不是产品bug；没有真实双侧支持的目标差异保留待验证。
- **需求 / 影响 / 方向：** [REQ-09](overall-audit-plan-20260913.md#req-09)，P2：源代码能证实生产引擎缺口；成本和语言/edition边界尚不充分。独立能力设计，先采IDEA输入输出与取消/accept；不能用Basic、regex或Terminal FIM充数。进入条件/依赖：目标语言/edition/model/SDK明确；REQ-05和安全事务owner。
- **必须保留：** K0；Basic不变；模型不可用有真实原因；接受操作使用共享事务与撤销。后续验收必须观察这些结果，不能只写“保持原功能”。
- **规格与任务来源：** [completion-and-query.md](../../claudedocs/code-workspace-idea-specs/completion-and-query.md)；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-COMP-001`（原记录 2026-09-02T21:15:24Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-COMP-002`（原记录 2026-09-02T21:28:55Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-COMP-003`（原记录 2026-09-02T21:47:23Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-COMP-004`（原记录 2026-09-04T01:15:30Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-PROJECT-001`（原记录 2026-09-02T23:25:12Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-PROJECT-002`（原记录 2026-09-03T23:34:34Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-PROJECT-003`（原记录 2026-09-03T23:37:00Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-PROJECT-004`（原记录 2026-09-04T00:23:00Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-PROJECT-005`（原记录 2026-09-04T00:50:56Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-DOC-001`（原记录 2026-09-03T01:41:00Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-CHROME-001`（原记录 2026-09-03T01:43:00Z）。旧卡不重开；新观察需求尚未author/领取任务。
- **上次结论 / 本次变化：** 首次整体场景结论，无上一轮同ID三维判定；本轮新增目标、静态生产链和上述实际子样本。历史卡原验收及日期仅按原链接保留，未作为本轮PASS。当前判断日期2026-09-13；没有双侧新观测关闭差距。

<a id="cw-lang-004"></a>

### CW-LANG-004 — Quick Documentation、参数、类型信息与 inlay

- **IDEA目标结果：** 文档、签名、参数高亮、类型信息与inlay准确，弹层锚点/固定/返回遵循目标。目标为需求；除I0明确事实外，细节未冒充实测。
- **Fixture / 入口：** [F2/F4](references/fixture-catalog.md)；workspace.quickDocumentation/parameterInfo/typeInfo / inlay toggle。
- **完整采样序列（未列为已执行的步骤均待采）：** 调用点→参数popup→移动参数→QuickDoc→pin→外部doc→Esc→切文件/失效请求。每次保存初始/关键状态/退出后的原图或录屏，分别记录focus、caret/selection、菜单/弹层、错误、取消、undo与恢复；不适用项说明原因。
- **当前生产链 / 用户观察点：** workspace.quickDocumentation/parameterInfo/typeInfo / inlay toggle → CodeWorkspaceTab → LSP session / project facts → lib/editor/lsp / workspaceTooling → Rust LSP/Maven/Gradle → 同 generation 数据 → completion/doc/problems；本轮 browser 没有真实 provider。具体caller/符号/IPC与源文件：[S-LANG](source-audit.md#lang)。
- **状态owner / IPC-provider：** WorkspaceLspSessionManager；lspFiles；projectFactsStore；completion candidate/session identity；diagnostic presentation profile。本轮 browser 没有真实 provider。真实provider、native build与OS边界未执行时保持unverified。
- **当前实现与实际观测：** referenceInfoController、QuickDoc/Parameter与inlay chrome可达；本轮未采内容、anchor、keyboard或late response。
- **独立结论：** 功能 **待验证**；视觉 **待验证**；交互 **待验证**。不输出百分比。
- **Taomni证据与当前性：** 无本轮关键状态原件：unverified（源码/case存在不改变此结论）。共用身份T0/provenance；原始日志、snapshot与具体焦点记录见baseline。未采正常/失败/取消/恢复状态仍缺失，已有case仅候选：[TC-IDE-C2-01](../../qa-ui-auto-tests/cases/TC-IDE-C2-01-jdtls-basic-completion-choice-and-one-undo-acceptance.testcase.yaml)；[TC-IDE-C2-02-completion-scope-fallback-browser](../../qa-ui-auto-tests/cases/TC-IDE-C2-02-completion-scope-fallback-browser.testcase.yaml)（本轮未运行）。
- **IDEA证据 / 环境 / 状态：** 待采：目标IU-262.10315.125，按本行fixture与步骤采同状态；本机只有I0项目树局部参照，不能跨场景复用。build/主题/scale/font/keymap/语言provider边界见IDEA对照摘要。
- **差异性质：** 纯证据缺口。缺证据本身不是产品bug；没有真实双侧支持的目标差异保留待验证。
- **需求 / 影响 / 方向：** [REQ-05](overall-audit-plan-20260913.md#req-05)，P1：补全/导航依赖同一SDK、provider与project generation，影响主开发流。先固定Java代表fixture和provider，再逐动作比结果、空/失败/取消、选择与文档弹层；后续扩语言。进入条件/依赖：F2真实SDK/JDT LS/IDEA索引；F4逐语言/edition；依赖REQ-10设置语义。
- **必须保留：** K0；无provider不伪造语义；popup属于正确view/document；取消后编辑caret恢复。后续验收必须观察这些结果，不能只写“保持原功能”。
- **规格与任务来源：** [completion-and-query.md](../../claudedocs/code-workspace-idea-specs/completion-and-query.md)；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-COMP-001`（原记录 2026-09-02T21:15:24Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-COMP-002`（原记录 2026-09-02T21:28:55Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-COMP-003`（原记录 2026-09-02T21:47:23Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-COMP-004`（原记录 2026-09-04T01:15:30Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-PROJECT-001`（原记录 2026-09-02T23:25:12Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-PROJECT-002`（原记录 2026-09-03T23:34:34Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-PROJECT-003`（原记录 2026-09-03T23:37:00Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-PROJECT-004`（原记录 2026-09-04T00:23:00Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-PROJECT-005`（原记录 2026-09-04T00:50:56Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-DOC-001`（原记录 2026-09-03T01:41:00Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-CHROME-001`（原记录 2026-09-03T01:43:00Z）。旧卡不重开；新观察需求尚未author/领取任务。
- **上次结论 / 本次变化：** 首次整体场景结论，无上一轮同ID三维判定；本轮新增目标、静态生产链和上述实际子样本。历史卡原验收及日期仅按原链接保留，未作为本轮PASS。当前判断日期2026-09-13；没有双侧新观测关闭差距。

<a id="cw-lang-005"></a>

### CW-LANG-005 — 诊断、Inspection 与 Quick Fix

- **IDEA目标结果：** 错误级别/位置/解释一致；scope分析、抑制、Alt+Enter/Problems同动作、取消与修复undo可观察。目标为需求；除I0明确事实外，细节未冒充实测。
- **Fixture / 入口：** [F2/F4](references/fixture-catalog.md)；Problems / Analysis / HighlightingWidget / Alt+Enter。
- **完整采样序列（未列为已执行的步骤均待采）：** 引入编译/inspection问题→hover→下一问题→Alt+Enter→preview/cancel→apply/undo→抑制/恢复→索引未ready。每次保存初始/关键状态/退出后的原图或录屏，分别记录focus、caret/selection、菜单/弹层、错误、取消、undo与恢复；不适用项说明原因。
- **当前生产链 / 用户观察点：** Problems / Analysis / HighlightingWidget / Alt+Enter → CodeWorkspaceTab → LSP session / project facts → lib/editor/lsp / workspaceTooling → Rust LSP/Maven/Gradle → 同 generation 数据 → completion/doc/problems；本轮 browser 没有真实 provider。具体caller/符号/IPC与源文件：[S-LANG](source-audit.md#lang)。
- **状态owner / IPC-provider：** WorkspaceLspSessionManager；lspFiles；projectFactsStore；completion candidate/session identity；diagnostic presentation profile。本轮 browser 没有真实 provider。真实provider、native build与OS边界未执行时保持unverified。
- **当前实现与实际观测：** B13仅Problems空态；InspectionProfile为provider呈现策略，不能声称具备完整IDEA data-flow/nullability分析；canonical applyPlan已有生产caller。
- **独立结论：** 功能 **待验证**；视觉 **待验证**；交互 **待验证**。不输出百分比。
- **Taomni证据与当前性：** [B13](../../qa-ui-auto-report/overall-audit-20260913/browser/13-problems.png)。共用身份T0/provenance；原始日志、snapshot与具体焦点记录见baseline。未采正常/失败/取消/恢复状态仍缺失，已有case仅候选：[TC-IDE-C2-01](../../qa-ui-auto-tests/cases/TC-IDE-C2-01-jdtls-basic-completion-choice-and-one-undo-acceptance.testcase.yaml)；[TC-IDE-C2-02-completion-scope-fallback-browser](../../qa-ui-auto-tests/cases/TC-IDE-C2-02-completion-scope-fallback-browser.testcase.yaml)（本轮未运行）。
- **IDEA证据 / 环境 / 状态：** 待采：目标IU-262.10315.125，按本行fixture与步骤采同状态；本机只有I0项目树局部参照，不能跨场景复用。build/主题/scale/font/keymap/语言provider边界见IDEA对照摘要。
- **差异性质：** 能力语义差异待验证；纯证据缺口。缺证据本身不是产品bug；没有真实双侧支持的目标差异保留待验证。
- **需求 / 影响 / 方向：** [REQ-06](overall-audit-plan-20260913.md#req-06)，P1：跨文件修改风险高，provider可用不代表IDEA语义完整。分别证明rename/extract/move/safe-delete/cleanup支持范围与冲突，补preview/undo/recovery；需要引擎时单列设计。进入条件/依赖：REQ-05完整性与F2/F5；canonical apply/history正确契约；旧豁免不扩大。
- **必须保留：** K0；未知诊断来源不升级为本地inspection；多个入口共用session/plan/apply；修复undo可靠。后续验收必须观察这些结果，不能只写“保持原功能”。
- **规格与任务来源：** [completion-and-query.md](../../claudedocs/code-workspace-idea-specs/completion-and-query.md)；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-COMP-001`（原记录 2026-09-02T21:15:24Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-COMP-002`（原记录 2026-09-02T21:28:55Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-COMP-003`（原记录 2026-09-02T21:47:23Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-COMP-004`（原记录 2026-09-04T01:15:30Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-PROJECT-001`（原记录 2026-09-02T23:25:12Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-PROJECT-002`（原记录 2026-09-03T23:34:34Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-PROJECT-003`（原记录 2026-09-03T23:37:00Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-PROJECT-004`（原记录 2026-09-04T00:23:00Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-PROJECT-005`（原记录 2026-09-04T00:50:56Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-DOC-001`（原记录 2026-09-03T01:41:00Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-CHROME-001`（原记录 2026-09-03T01:43:00Z）。旧卡不重开；新观察需求尚未author/领取任务。
- **上次结论 / 本次变化：** 首次整体场景结论，无上一轮同ID三维判定；本轮新增目标、静态生产链和上述实际子样本。历史卡原验收及日期仅按原链接保留，未作为本轮PASS。当前判断日期2026-09-13；没有双侧新观测关闭差距。

<a id="cw-refactor-001"></a>

### CW-REFACTOR-001 — Rename 符号、文件与跨文件恢复

- **IDEA目标结果：** Rename能处理目标引用/资源路径、冲突预览与取消，提交和undo/重启恢复一致。目标为需求；除I0明确事实外，细节未冒充实测。
- **Fixture / 入口：** [F2/F5](references/fixture-catalog.md)；Shift+F6 / workspace.renameSymbol / RefactoringPreviewDialog。
- **完整采样序列（未列为已执行的步骤均待采）：** 选符号→rename preview→冲突→Cancel→确认→检查磁盘/引用→undo/redo→中断恢复。每次保存初始/关键状态/退出后的原图或录屏，分别记录focus、caret/selection、菜单/弹层、错误、取消、undo与恢复；不适用项说明原因。
- **当前生产链 / 用户观察点：** Shift+F6 / workspace.renameSymbol / RefactoringPreviewDialog → workspace.* refactor/format action → LSP codeAction/rename/format or local syntax plan → immutable preview → canonical applyPlan / resource edits → native files/undo/recovery；provider kind、完整性限制单独判断。具体caller/符号/IPC与源文件：[S-REFACTOR](source-audit.md#refactor)。
- **状态owner / IPC-provider：** canonicalCodeActionService + frozen intention/refactor plan；workspaceEdit history / journal / recovery controller。provider kind、完整性限制单独判断。真实provider、native build与OS边界未执行时保持unverified。
- **当前实现与实际观测：** 已有生产 LSP rename、resource edit、journal/recovery；历史file-move undo缺口后来有follow-up，不能直接重报旧bug；本轮未验证。
- **独立结论：** 功能 **待验证**；视觉 **待验证**；交互 **待验证**。不输出百分比。
- **Taomni证据与当前性：** 无本轮关键状态原件：unverified（源码/case存在不改变此结论）。共用身份T0/provenance；原始日志、snapshot与具体焦点记录见baseline。未采正常/失败/取消/恢复状态仍缺失，已有case仅候选：[TC-IDE-AUDIT-014-rename-recovery-native](../../qa-ui-auto-tests/cases/TC-IDE-AUDIT-014-rename-recovery-native.testcase.yaml)；[TC-IDE-AUDIT-015-rearrange-sortmembers-native](../../qa-ui-auto-tests/cases/TC-IDE-AUDIT-015-rearrange-sortmembers-native.testcase.yaml)；[TC-IDE-AUDIT-016-cleanup-unavailable-native](../../qa-ui-auto-tests/cases/TC-IDE-AUDIT-016-cleanup-unavailable-native.testcase.yaml)（本轮未运行）。
- **IDEA证据 / 环境 / 状态：** 待采：目标IU-262.10315.125，按本行fixture与步骤采同状态；本机只有I0项目树局部参照，不能跨场景复用。build/主题/scale/font/keymap/语言provider边界见IDEA对照摘要。
- **差异性质：** 纯证据缺口；provider完整性风险。缺证据本身不是产品bug；没有真实双侧支持的目标差异保留待验证。
- **需求 / 影响 / 方向：** [REQ-06](overall-audit-plan-20260913.md#req-06)，P1：跨文件修改风险高，provider可用不代表IDEA语义完整。分别证明rename/extract/move/safe-delete/cleanup支持范围与冲突，补preview/undo/recovery；需要引擎时单列设计。进入条件/依赖：REQ-05完整性与F2/F5；canonical apply/history正确契约；旧豁免不扩大。
- **必须保留：** K0；文本和文件路径一起恢复；before-image与postcondition；跨root/dirty冲突不能误写。后续验收必须观察这些结果，不能只写“保持原功能”。
- **规格与任务来源：** [search-and-navigation.md](../../claudedocs/code-workspace-idea-specs/search-and-navigation.md)；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-REF-001`（原记录 2026-09-05T05:00:00Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-ACTION-001`（原记录 2026-08-31T21:14:17Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-ACTION-002`（原记录 2026-08-31T22:01:41Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-ACTION-003`（原记录 2026-08-31T22:35:10Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-ACTION-004`（原记录 2026-09-02T20:55:18Z）；[code-workspace-idea-parity-backlog-2026-09-audit.md](../../claudedocs/code-workspace-idea-parity-backlog-2026-09-audit.md) `ED-AUDIT-014`（原记录 2026-09-09T14:45:00Z）；[code-workspace-idea-parity-backlog-2026-09-audit.md](../../claudedocs/code-workspace-idea-parity-backlog-2026-09-audit.md) `ED-AUDIT-015`（原记录 2026-09-09T23:13:00Z）；[code-workspace-idea-parity-backlog-2026-09-audit.md](../../claudedocs/code-workspace-idea-parity-backlog-2026-09-audit.md) `ED-AUDIT-016`（原记录 2026-09-09T23:47:00Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-TEMPLATE-001`（原记录 2026-09-06T02:39:49Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-STYLE-001`（原记录 2026-09-04T00:14:45Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-STYLE-002`（原记录 2026-09-05T05:22:00Z）。旧卡不重开；新观察需求尚未author/领取任务。
- **上次结论 / 本次变化：** 首次整体场景结论，无上一轮同ID三维判定；本轮新增目标、静态生产链和上述实际子样本。历史卡原验收及日期仅按原链接保留，未作为本轮PASS。当前判断日期2026-09-13；没有双侧新观测关闭差距。

<a id="cw-refactor-002"></a>

### CW-REFACTOR-002 — Extract / Inline / Change Signature / Move

- **IDEA目标结果：** 重构正确保留程序行为，参数/副作用/冲突可预览，作用域明确，能取消和撤销。目标为需求；除I0明确事实外，细节未冒充实测。
- **Fixture / 入口：** [F2/F4](references/fixture-catalog.md)；workspace.extractMethod/extractVariable/inline/changeSignature/moveRefactor。
- **完整采样序列（未列为已执行的步骤均待采）：** 选择带副作用代码→提取→预览→Cancel→提交/undo；改签名/移动后检查所有调用点与冲突。每次保存初始/关键状态/退出后的原图或录屏，分别记录focus、caret/selection、菜单/弹层、错误、取消、undo与恢复；不适用项说明原因。
- **当前生产链 / 用户观察点：** workspace.extractMethod/extractVariable/inline/changeSignature/moveRefactor → workspace.* refactor/format action → LSP codeAction/rename/format or local syntax plan → immutable preview → canonical applyPlan / resource edits → native files/undo/recovery；provider kind、完整性限制单独判断。具体caller/符号/IPC与源文件：[S-REFACTOR](source-audit.md#refactor)。
- **状态owner / IPC-provider：** canonicalCodeActionService + frozen intention/refactor plan；workspaceEdit history / journal / recovery controller。provider kind、完整性限制单独判断。真实provider、native build与OS边界未执行时保持unverified。
- **当前实现与实际观测：** 生产按LSP refactor kinds请求并走preview/apply；只有入口不证明provider每一种语义可用；未做真实操作。
- **独立结论：** 功能 **待验证**；视觉 **待验证**；交互 **待验证**。不输出百分比。
- **Taomni证据与当前性：** 无本轮关键状态原件：unverified（源码/case存在不改变此结论）。共用身份T0/provenance；原始日志、snapshot与具体焦点记录见baseline。未采正常/失败/取消/恢复状态仍缺失，已有case仅候选：[TC-IDE-AUDIT-014-rename-recovery-native](../../qa-ui-auto-tests/cases/TC-IDE-AUDIT-014-rename-recovery-native.testcase.yaml)；[TC-IDE-AUDIT-015-rearrange-sortmembers-native](../../qa-ui-auto-tests/cases/TC-IDE-AUDIT-015-rearrange-sortmembers-native.testcase.yaml)；[TC-IDE-AUDIT-016-cleanup-unavailable-native](../../qa-ui-auto-tests/cases/TC-IDE-AUDIT-016-cleanup-unavailable-native.testcase.yaml)（本轮未运行）。
- **IDEA证据 / 环境 / 状态：** 待采：目标IU-262.10315.125，按本行fixture与步骤采同状态；本机只有I0项目树局部参照，不能跨场景复用。build/主题/scale/font/keymap/语言provider边界见IDEA对照摘要。
- **差异性质：** provider能力差距待验证；纯证据缺口。缺证据本身不是产品bug；没有真实双侧支持的目标差异保留待验证。
- **需求 / 影响 / 方向：** [REQ-06](overall-audit-plan-20260913.md#req-06)，P1：跨文件修改风险高，provider可用不代表IDEA语义完整。分别证明rename/extract/move/safe-delete/cleanup支持范围与冲突，补preview/undo/recovery；需要引擎时单列设计。进入条件/依赖：REQ-05完整性与F2/F5；canonical apply/history正确契约；旧豁免不扩大。
- **必须保留：** K0；不退化到文本替换冒充语义；跨文件原子预检与partial recovery；取消零写。后续验收必须观察这些结果，不能只写“保持原功能”。
- **规格与任务来源：** [search-and-navigation.md](../../claudedocs/code-workspace-idea-specs/search-and-navigation.md)；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-REF-001`（原记录 2026-09-05T05:00:00Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-ACTION-001`（原记录 2026-08-31T21:14:17Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-ACTION-002`（原记录 2026-08-31T22:01:41Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-ACTION-003`（原记录 2026-08-31T22:35:10Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-ACTION-004`（原记录 2026-09-02T20:55:18Z）；[code-workspace-idea-parity-backlog-2026-09-audit.md](../../claudedocs/code-workspace-idea-parity-backlog-2026-09-audit.md) `ED-AUDIT-014`（原记录 2026-09-09T14:45:00Z）；[code-workspace-idea-parity-backlog-2026-09-audit.md](../../claudedocs/code-workspace-idea-parity-backlog-2026-09-audit.md) `ED-AUDIT-015`（原记录 2026-09-09T23:13:00Z）；[code-workspace-idea-parity-backlog-2026-09-audit.md](../../claudedocs/code-workspace-idea-parity-backlog-2026-09-audit.md) `ED-AUDIT-016`（原记录 2026-09-09T23:47:00Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-TEMPLATE-001`（原记录 2026-09-06T02:39:49Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-STYLE-001`（原记录 2026-09-04T00:14:45Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-STYLE-002`（原记录 2026-09-05T05:22:00Z）。旧卡不重开；新观察需求尚未author/领取任务。
- **上次结论 / 本次变化：** 首次整体场景结论，无上一轮同ID三维判定；本轮新增目标、静态生产链和上述实际子样本。历史卡原验收及日期仅按原链接保留，未作为本轮PASS。当前判断日期2026-09-13；没有双侧新观测关闭差距。

<a id="cw-refactor-003"></a>

### CW-REFACTOR-003 — Safe Delete 与完整引用检查

- **IDEA目标结果：** 安全删除在真实使用情况/冲突上决策，不能只因文本引用为空就允许破坏性删除。目标为需求；除I0明确事实外，细节未冒充实测。
- **Fixture / 入口：** [F2](references/fixture-catalog.md)；workspace.safeDeleteSymbol / evaluateDestructiveRefactorAvailability。
- **完整采样序列（未列为已执行的步骤均待采）：** 有/无引用声明→Safe Delete→scope/completeness→查看冲突→Cancel→确认合法删除→undo。每次保存初始/关键状态/退出后的原图或录屏，分别记录focus、caret/selection、菜单/弹层、错误、取消、undo与恢复；不适用项说明原因。
- **当前生产链 / 用户观察点：** workspace.safeDeleteSymbol / evaluateDestructiveRefactorAvailability → workspace.* refactor/format action → LSP codeAction/rename/format or local syntax plan → immutable preview → canonical applyPlan / resource edits → native files/undo/recovery；provider kind、完整性限制单独判断。具体caller/符号/IPC与源文件：[S-REFACTOR](source-audit.md#refactor)。
- **状态owner / IPC-provider：** canonicalCodeActionService + frozen intention/refactor plan；workspaceEdit history / journal / recovery controller。provider kind、完整性限制单独判断。真实provider、native build与OS边界未执行时保持unverified。
- **当前实现与实际观测：** 当前action通过evaluateDestructiveRefactorAvailability(null)判断可用性，安全模型与证据门控存在；真实可用分支/IDEA结果未采，不能称完整支持。
- **独立结论：** 功能 **待验证**；视觉 **待验证**；交互 **待验证**。不输出百分比。
- **Taomni证据与当前性：** 无本轮关键状态原件：unverified（源码/case存在不改变此结论）。共用身份T0/provenance；原始日志、snapshot与具体焦点记录见baseline。未采正常/失败/取消/恢复状态仍缺失，已有case仅候选：[TC-IDE-AUDIT-014-rename-recovery-native](../../qa-ui-auto-tests/cases/TC-IDE-AUDIT-014-rename-recovery-native.testcase.yaml)；[TC-IDE-AUDIT-015-rearrange-sortmembers-native](../../qa-ui-auto-tests/cases/TC-IDE-AUDIT-015-rearrange-sortmembers-native.testcase.yaml)；[TC-IDE-AUDIT-016-cleanup-unavailable-native](../../qa-ui-auto-tests/cases/TC-IDE-AUDIT-016-cleanup-unavailable-native.testcase.yaml)（本轮未运行）。
- **IDEA证据 / 环境 / 状态：** 待采：目标IU-262.10315.125，按本行fixture与步骤采同状态；本机只有I0项目树局部参照，不能跨场景复用。build/主题/scale/font/keymap/语言provider边界见IDEA对照摘要。
- **差异性质：** 能力限制（源码）；纯证据缺口。缺证据本身不是产品bug；没有真实双侧支持的目标差异保留待验证。
- **需求 / 影响 / 方向：** [REQ-06](overall-audit-plan-20260913.md#req-06)，P1：跨文件修改风险高，provider可用不代表IDEA语义完整。分别证明rename/extract/move/safe-delete/cleanup支持范围与冲突，补preview/undo/recovery；需要引擎时单列设计。进入条件/依赖：REQ-05完整性与F2/F5；canonical apply/history正确契约；旧豁免不扩大。
- **必须保留：** K0；unknown/partial完整性fail closed；取消与undo；外部/library引用不得丢弃。后续验收必须观察这些结果，不能只写“保持原功能”。
- **规格与任务来源：** [search-and-navigation.md](../../claudedocs/code-workspace-idea-specs/search-and-navigation.md)；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-REF-001`（原记录 2026-09-05T05:00:00Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-ACTION-001`（原记录 2026-08-31T21:14:17Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-ACTION-002`（原记录 2026-08-31T22:01:41Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-ACTION-003`（原记录 2026-08-31T22:35:10Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-ACTION-004`（原记录 2026-09-02T20:55:18Z）；[code-workspace-idea-parity-backlog-2026-09-audit.md](../../claudedocs/code-workspace-idea-parity-backlog-2026-09-audit.md) `ED-AUDIT-014`（原记录 2026-09-09T14:45:00Z）；[code-workspace-idea-parity-backlog-2026-09-audit.md](../../claudedocs/code-workspace-idea-parity-backlog-2026-09-audit.md) `ED-AUDIT-015`（原记录 2026-09-09T23:13:00Z）；[code-workspace-idea-parity-backlog-2026-09-audit.md](../../claudedocs/code-workspace-idea-parity-backlog-2026-09-audit.md) `ED-AUDIT-016`（原记录 2026-09-09T23:47:00Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-TEMPLATE-001`（原记录 2026-09-06T02:39:49Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-STYLE-001`（原记录 2026-09-04T00:14:45Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-STYLE-002`（原记录 2026-09-05T05:22:00Z）。旧卡不重开；新观察需求尚未author/领取任务。
- **上次结论 / 本次变化：** 首次整体场景结论，无上一轮同ID三维判定；本轮新增目标、静态生产链和上述实际子样本。历史卡原验收及日期仅按原链接保留，未作为本轮PASS。当前判断日期2026-09-13；没有双侧新观测关闭差距。

<a id="cw-refactor-004"></a>

### CW-REFACTOR-004 — Reformat、Optimize Imports、Rearrange 与 Cleanup

- **IDEA目标结果：** 按scope/style重排格式和imports，用户看得见受影响范围；结果与目标一致且可撤销。目标为需求；除I0明确事实外，细节未冒充实测。
- **Fixture / 入口：** [F2/F4](references/fixture-catalog.md)；workspace.format/optimizeImports/rearrangeCode/codeCleanup。
- **完整采样序列（未列为已执行的步骤均待采）：** 选择局部/全文件→Reformat→options→preview/cancel→apply/undo→imports/sortMembers/cleanup→缺provider。每次保存初始/关键状态/退出后的原图或录屏，分别记录focus、caret/selection、菜单/弹层、错误、取消、undo与恢复；不适用项说明原因。
- **当前生产链 / 用户观察点：** workspace.format/optimizeImports/rearrangeCode/codeCleanup → workspace.* refactor/format action → LSP codeAction/rename/format or local syntax plan → immutable preview → canonical applyPlan / resource edits → native files/undo/recovery；provider kind、完整性限制单独判断。具体caller/符号/IPC与源文件：[S-REFACTOR](source-audit.md#refactor)。
- **状态owner / IPC-provider：** canonicalCodeActionService + frozen intention/refactor plan；workspaceEdit history / journal / recovery controller。provider kind、完整性限制单独判断。真实provider、native build与OS边界未执行时保持unverified。
- **当前实现与实际观测：** 生产planReformat与canonical service可达；Cleanup受provider kind/file-default边界限制。旧CLI格式化记录为IU-261，非目标GUI；本轮未运行。
- **独立结论：** 功能 **待验证**；视觉 **待验证**；交互 **待验证**。不输出百分比。
- **Taomni证据与当前性：** 无本轮关键状态原件：unverified（源码/case存在不改变此结论）。共用身份T0/provenance；原始日志、snapshot与具体焦点记录见baseline。未采正常/失败/取消/恢复状态仍缺失，已有case仅候选：[TC-IDE-AUDIT-014-rename-recovery-native](../../qa-ui-auto-tests/cases/TC-IDE-AUDIT-014-rename-recovery-native.testcase.yaml)；[TC-IDE-AUDIT-015-rearrange-sortmembers-native](../../qa-ui-auto-tests/cases/TC-IDE-AUDIT-015-rearrange-sortmembers-native.testcase.yaml)；[TC-IDE-AUDIT-016-cleanup-unavailable-native](../../qa-ui-auto-tests/cases/TC-IDE-AUDIT-016-cleanup-unavailable-native.testcase.yaml)（本轮未运行）。
- **IDEA证据 / 环境 / 状态：** 待采：目标IU-262.10315.125，按本行fixture与步骤采同状态；本机只有I0项目树局部参照，不能跨场景复用。build/主题/scale/font/keymap/语言provider边界见IDEA对照摘要。
- **差异性质：** 能力限制；纯证据缺口。缺证据本身不是产品bug；没有真实双侧支持的目标差异保留待验证。
- **需求 / 影响 / 方向：** [REQ-06](overall-audit-plan-20260913.md#req-06)，P1：跨文件修改风险高，provider可用不代表IDEA语义完整。分别证明rename/extract/move/safe-delete/cleanup支持范围与冲突，补preview/undo/recovery；需要引擎时单列设计。进入条件/依赖：REQ-05完整性与F2/F5；canonical apply/history正确契约；旧豁免不扩大。
- **必须保留：** K0；format/import与保存共享正确plan；范围及不可用真实；取消、undo、style precedence不变。后续验收必须观察这些结果，不能只写“保持原功能”。
- **规格与任务来源：** [search-and-navigation.md](../../claudedocs/code-workspace-idea-specs/search-and-navigation.md)；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-REF-001`（原记录 2026-09-05T05:00:00Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-ACTION-001`（原记录 2026-08-31T21:14:17Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-ACTION-002`（原记录 2026-08-31T22:01:41Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-ACTION-003`（原记录 2026-08-31T22:35:10Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-ACTION-004`（原记录 2026-09-02T20:55:18Z）；[code-workspace-idea-parity-backlog-2026-09-audit.md](../../claudedocs/code-workspace-idea-parity-backlog-2026-09-audit.md) `ED-AUDIT-014`（原记录 2026-09-09T14:45:00Z）；[code-workspace-idea-parity-backlog-2026-09-audit.md](../../claudedocs/code-workspace-idea-parity-backlog-2026-09-audit.md) `ED-AUDIT-015`（原记录 2026-09-09T23:13:00Z）；[code-workspace-idea-parity-backlog-2026-09-audit.md](../../claudedocs/code-workspace-idea-parity-backlog-2026-09-audit.md) `ED-AUDIT-016`（原记录 2026-09-09T23:47:00Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-TEMPLATE-001`（原记录 2026-09-06T02:39:49Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-STYLE-001`（原记录 2026-09-04T00:14:45Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-STYLE-002`（原记录 2026-09-05T05:22:00Z）。旧卡不重开；新观察需求尚未author/领取任务。
- **上次结论 / 本次变化：** 首次整体场景结论，无上一轮同ID三维判定；本轮新增目标、静态生产链和上述实际子样本。历史卡原验收及日期仅按原链接保留，未作为本轮PASS。当前判断日期2026-09-13；没有双侧新观测关闭差距。

<a id="cw-refactor-005"></a>

### CW-REFACTOR-005 — Live / Postfix Templates、Surround、Generate 与 Complete Statement

- **IDEA目标结果：** 模板变量/Tab stop、类型相关postfix、surround/generate与statement补全符合语法上下文。目标为需求；除I0明确事实外，细节未冒充实测。
- **Fixture / 入口：** [F2/F4](references/fixture-catalog.md)；editor.generateCode / SurroundWithDialog / liveTemplates / Complete Statement。
- **完整采样序列（未列为已执行的步骤均待采）：** 模板前缀→Tab变量→Esc→undo；选择语句→Surround→Cancel；Generate getter/constructor→preview→undo。每次保存初始/关键状态/退出后的原图或录屏，分别记录focus、caret/selection、菜单/弹层、错误、取消、undo与恢复；不适用项说明原因。
- **当前生产链 / 用户观察点：** editor.generateCode / SurroundWithDialog / liveTemplates / Complete Statement → workspace.* refactor/format action → LSP codeAction/rename/format or local syntax plan → immutable preview → canonical applyPlan / resource edits → native files/undo/recovery；provider kind、完整性限制单独判断。具体caller/符号/IPC与源文件：[S-REFACTOR](source-audit.md#refactor)。
- **状态owner / IPC-provider：** canonicalCodeActionService + frozen intention/refactor plan；workspaceEdit history / journal / recovery controller。provider kind、完整性限制单独判断。真实provider、native build与OS边界未执行时保持unverified。
- **当前实现与实际观测：** 本地/语法/provider来源已区分；Java局部syntax-backed和Generate按provider返回，不能当全语言IDEA模板语义；本轮未采。
- **独立结论：** 功能 **待验证**；视觉 **待验证**；交互 **待验证**。不输出百分比。
- **Taomni证据与当前性：** 无本轮关键状态原件：unverified（源码/case存在不改变此结论）。共用身份T0/provenance；原始日志、snapshot与具体焦点记录见baseline。未采正常/失败/取消/恢复状态仍缺失，已有case仅候选：[TC-IDE-AUDIT-014-rename-recovery-native](../../qa-ui-auto-tests/cases/TC-IDE-AUDIT-014-rename-recovery-native.testcase.yaml)；[TC-IDE-AUDIT-015-rearrange-sortmembers-native](../../qa-ui-auto-tests/cases/TC-IDE-AUDIT-015-rearrange-sortmembers-native.testcase.yaml)；[TC-IDE-AUDIT-016-cleanup-unavailable-native](../../qa-ui-auto-tests/cases/TC-IDE-AUDIT-016-cleanup-unavailable-native.testcase.yaml)（本轮未运行）。
- **IDEA证据 / 环境 / 状态：** 待采：目标IU-262.10315.125，按本行fixture与步骤采同状态；本机只有I0项目树局部参照，不能跨场景复用。build/主题/scale/font/keymap/语言provider边界见IDEA对照摘要。
- **差异性质：** 语义差异待验证；纯证据缺口。缺证据本身不是产品bug；没有真实双侧支持的目标差异保留待验证。
- **需求 / 影响 / 方向：** [REQ-06](overall-audit-plan-20260913.md#req-06)，P1：跨文件修改风险高，provider可用不代表IDEA语义完整。分别证明rename/extract/move/safe-delete/cleanup支持范围与冲突，补preview/undo/recovery；需要引擎时单列设计。进入条件/依赖：REQ-05完整性与F2/F5；canonical apply/history正确契约；旧豁免不扩大。
- **必须保留：** K0；明确Local/Text或provider provenance；字符串/注释禁抢输入；一次接受一次undo。后续验收必须观察这些结果，不能只写“保持原功能”。
- **规格与任务来源：** [search-and-navigation.md](../../claudedocs/code-workspace-idea-specs/search-and-navigation.md)；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-REF-001`（原记录 2026-09-05T05:00:00Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-ACTION-001`（原记录 2026-08-31T21:14:17Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-ACTION-002`（原记录 2026-08-31T22:01:41Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-ACTION-003`（原记录 2026-08-31T22:35:10Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-ACTION-004`（原记录 2026-09-02T20:55:18Z）；[code-workspace-idea-parity-backlog-2026-09-audit.md](../../claudedocs/code-workspace-idea-parity-backlog-2026-09-audit.md) `ED-AUDIT-014`（原记录 2026-09-09T14:45:00Z）；[code-workspace-idea-parity-backlog-2026-09-audit.md](../../claudedocs/code-workspace-idea-parity-backlog-2026-09-audit.md) `ED-AUDIT-015`（原记录 2026-09-09T23:13:00Z）；[code-workspace-idea-parity-backlog-2026-09-audit.md](../../claudedocs/code-workspace-idea-parity-backlog-2026-09-audit.md) `ED-AUDIT-016`（原记录 2026-09-09T23:47:00Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-TEMPLATE-001`（原记录 2026-09-06T02:39:49Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-STYLE-001`（原记录 2026-09-04T00:14:45Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-STYLE-002`（原记录 2026-09-05T05:22:00Z）。旧卡不重开；新观察需求尚未author/领取任务。
- **上次结论 / 本次变化：** 首次整体场景结论，无上一轮同ID三维判定；本轮新增目标、静态生产链和上述实际子样本。历史卡原验收及日期仅按原链接保留，未作为本轮PASS。当前判断日期2026-09-13；没有双侧新观测关闭差距。

<a id="cw-git-001"></a>

### CW-GIT-001 — Git 状态、gutter、blame 与 diff

- **IDEA目标结果：** 项目树/编辑器/Changes同步显示修改，可精确查看hunk并回到编辑位置。目标为需求；除I0明确事实外，细节未冒充实测。
- **Fixture / 入口：** [F3](references/fixture-catalog.md)；workspace.openGit / git gutter / GitDiffPeek / DiffViewer。
- **完整采样序列（未列为已执行的步骤均待采）：** 修改两repo→切file→gutter查看→inline blame→diff上下条→resize/scroll→返回editor。每次保存初始/关键状态/退出后的原图或录屏，分别记录focus、caret/selection、菜单/弹层、错误、取消、undo与恢复；不适用项说明原因。
- **当前生产链 / 用户观察点：** workspace.openGit / git gutter / GitDiffPeek / DiffViewer → CodeWorkspaceTab openGit → MainLayout onOpenGitManager → WorkspaceGitManager / DiffViewer → lib/git → Rust git_* / 本地 Git → status/index/log/conflict；browser VFS 无 Git repo。具体caller/符号/IPC与源文件：[S-GIT](source-audit.md#git)。
- **状态owner / IPC-provider：** workspace git snapshots、manager 多根选择/操作状态、diff pane 状态；repo/index/worktree 是数据 owner。browser VFS 无 Git repo。真实provider、native build与OS边界未执行时保持unverified。
- **当前实现与实际观测：** 生产snapshot→gutter→独立WorkspaceGitManager路径存在；browser VFS无.git，按钮disabled。本轮未打开真实Git fixture，不是缺失Git功能。
- **独立结论：** 功能 **待验证**；视觉 **待验证**；交互 **待验证**。不输出百分比。
- **Taomni证据与当前性：** 无本轮关键状态原件：unverified（源码/case存在不改变此结论）。共用身份T0/provenance；原始日志、snapshot与具体焦点记录见baseline。未采正常/失败/取消/恢复状态仍缺失，已有case仅候选：未选择精确case；P1按本场景AC检查现有F25.1/Git cases，不自动跑全套（本轮未运行）。
- **IDEA证据 / 环境 / 状态：** 待采：目标IU-262.10315.125，按本行fixture与步骤采同状态；本机只有I0项目树局部参照，不能跨场景复用。build/主题/scale/font/keymap/语言provider边界见IDEA对照摘要。
- **差异性质：** 纯证据缺口。缺证据本身不是产品bug；没有真实双侧支持的目标差异保留待验证。
- **需求 / 影响 / 方向：** [REQ-07](overall-audit-plan-20260913.md#req-07)，P1核心 / P2高级：本轮明确纳入全Code Workspace；任务模型、Git与编辑器gutter有共享边界。先一条本地Git diff/选择流及一条Java build/run/debug流建立双侧状态，再细化配置、冲突、coverage。进入条件/依赖：F2/F3真实后端；同源QA；相关工具/adapter；不启动远端publish。
- **必须保留：** K0；多repo选择隔离；diff不误改正文；路径与滚动来源保持准确。后续验收必须观察这些结果，不能只写“保持原功能”。
- **规格与任务来源：** [code-workspace-ide-design.md](../../claudedocs/code-workspace-ide-design.md)；未核定专属 parity 任务板/ID；只关联现有生产与设计，P1 需查重后建立工作包。旧卡不重开；新观察需求尚未author/领取任务。
- **上次结论 / 本次变化：** 首次整体场景结论，无上一轮同ID三维判定；本轮新增目标、静态生产链和上述实际子样本。历史卡原验收及日期仅按原链接保留，未作为本轮PASS。当前判断日期2026-09-13；没有双侧新观测关闭差距。

<a id="cw-git-002"></a>

### CW-GIT-002 — 变更选择、Stage / Commit 与取消

- **IDEA目标结果：** 选择文件/hunk、stage/unstage、提交目标repo与内容可预测，取消不会误提交其他变更。目标为需求；除I0明确事实外，细节未冒充实测。
- **Fixture / 入口：** [F3](references/fixture-catalog.md)；WorkspaceGitManager Changes / Commit。
- **完整采样序列（未列为已执行的步骤均待采）：** 选择hunk/file→stage→unstage→commit preview→Cancel→fixture本地commit→检查index/HEAD。每次保存初始/关键状态/退出后的原图或录屏，分别记录focus、caret/selection、菜单/弹层、错误、取消、undo与恢复；不适用项说明原因。
- **当前生产链 / 用户观察点：** WorkspaceGitManager Changes / Commit → CodeWorkspaceTab openGit → MainLayout onOpenGitManager → WorkspaceGitManager / DiffViewer → lib/git → Rust git_* / 本地 Git → status/index/log/conflict；browser VFS 无 Git repo。具体caller/符号/IPC与源文件：[S-GIT](source-audit.md#git)。
- **状态owner / IPC-provider：** workspace git snapshots、manager 多根选择/操作状态、diff pane 状态；repo/index/worktree 是数据 owner。browser VFS 无 Git repo。真实provider、native build与OS边界未执行时保持unverified。
- **当前实现与实际观测：** manager生产调用gitStage/gitCommit；本轮不执行任何提交或staging，IDEA staging/changelist设置待采。
- **独立结论：** 功能 **待验证**；视觉 **待验证**；交互 **待验证**。不输出百分比。
- **Taomni证据与当前性：** 无本轮关键状态原件：unverified（源码/case存在不改变此结论）。共用身份T0/provenance；原始日志、snapshot与具体焦点记录见baseline。未采正常/失败/取消/恢复状态仍缺失，已有case仅候选：未选择精确case；P1按本场景AC检查现有F25.1/Git cases，不自动跑全套（本轮未运行）。
- **IDEA证据 / 环境 / 状态：** 待采：目标IU-262.10315.125，按本行fixture与步骤采同状态；本机只有I0项目树局部参照，不能跨场景复用。build/主题/scale/font/keymap/语言provider边界见IDEA对照摘要。
- **差异性质：** 纯证据缺口；目标设置待决。缺证据本身不是产品bug；没有真实双侧支持的目标差异保留待验证。
- **需求 / 影响 / 方向：** [REQ-07](overall-audit-plan-20260913.md#req-07)，P1核心 / P2高级：本轮明确纳入全Code Workspace；任务模型、Git与编辑器gutter有共享边界。先一条本地Git diff/选择流及一条Java build/run/debug流建立双侧状态，再细化配置、冲突、coverage。进入条件/依赖：F2/F3真实后端；同源QA；相关工具/adapter；不启动远端publish。
- **必须保留：** K0；用户未选择文件不提交；dirty/index差异清楚；凭证与远端无额外副作用。后续验收必须观察这些结果，不能只写“保持原功能”。
- **规格与任务来源：** [code-workspace-ide-design.md](../../claudedocs/code-workspace-ide-design.md)；未核定专属 parity 任务板/ID；只关联现有生产与设计，P1 需查重后建立工作包。旧卡不重开；新观察需求尚未author/领取任务。
- **上次结论 / 本次变化：** 首次整体场景结论，无上一轮同ID三维判定；本轮新增目标、静态生产链和上述实际子样本。历史卡原验收及日期仅按原链接保留，未作为本轮PASS。当前判断日期2026-09-13；没有双侧新观测关闭差距。

<a id="cw-git-003"></a>

### CW-GIT-003 — 分支、日志、比较与多根上下文

- **IDEA目标结果：** 分支/commit定位、日志筛选、比较与checkout保持repo上下文；错误不污染其他root。目标为需求；除I0明确事实外，细节未冒充实测。
- **Fixture / 入口：** [F3](references/fixture-catalog.md)；WorkspaceCommitLog / branch popup / compare。
- **完整采样序列（未列为已执行的步骤均待采）：** 按作者/文本筛选→选commit→diff→分支checkout预检→Cancel→本地切换→回原分支。每次保存初始/关键状态/退出后的原图或录屏，分别记录focus、caret/selection、菜单/弹层、错误、取消、undo与恢复；不适用项说明原因。
- **当前生产链 / 用户观察点：** WorkspaceCommitLog / branch popup / compare → CodeWorkspaceTab openGit → MainLayout onOpenGitManager → WorkspaceGitManager / DiffViewer → lib/git → Rust git_* / 本地 Git → status/index/log/conflict；browser VFS 无 Git repo。具体caller/符号/IPC与源文件：[S-GIT](source-audit.md#git)。
- **状态owner / IPC-provider：** workspace git snapshots、manager 多根选择/操作状态、diff pane 状态；repo/index/worktree 是数据 owner。browser VFS 无 Git repo。真实provider、native build与OS边界未执行时保持unverified。
- **当前实现与实际观测：** 生产lib/git提供log/compare/checkout并有manager consumers；本轮没有对应UI和真实repo证据。
- **独立结论：** 功能 **待验证**；视觉 **待验证**；交互 **待验证**。不输出百分比。
- **Taomni证据与当前性：** 无本轮关键状态原件：unverified（源码/case存在不改变此结论）。共用身份T0/provenance；原始日志、snapshot与具体焦点记录见baseline。未采正常/失败/取消/恢复状态仍缺失，已有case仅候选：未选择精确case；P1按本场景AC检查现有F25.1/Git cases，不自动跑全套（本轮未运行）。
- **IDEA证据 / 环境 / 状态：** 待采：目标IU-262.10315.125，按本行fixture与步骤采同状态；本机只有I0项目树局部参照，不能跨场景复用。build/主题/scale/font/keymap/语言provider边界见IDEA对照摘要。
- **差异性质：** 纯证据缺口。缺证据本身不是产品bug；没有真实双侧支持的目标差异保留待验证。
- **需求 / 影响 / 方向：** [REQ-07](overall-audit-plan-20260913.md#req-07)，P1核心 / P2高级：本轮明确纳入全Code Workspace；任务模型、Git与编辑器gutter有共享边界。先一条本地Git diff/选择流及一条Java build/run/debug流建立双侧状态，再细化配置、冲突、coverage。进入条件/依赖：F2/F3真实后端；同源QA；相关工具/adapter；不启动远端publish。
- **必须保留：** K0；dirty checkout保护；多root不同分支不能误同步；取消不改HEAD。后续验收必须观察这些结果，不能只写“保持原功能”。
- **规格与任务来源：** [code-workspace-ide-design.md](../../claudedocs/code-workspace-ide-design.md)；未核定专属 parity 任务板/ID；只关联现有生产与设计，P1 需查重后建立工作包。旧卡不重开；新观察需求尚未author/领取任务。
- **上次结论 / 本次变化：** 首次整体场景结论，无上一轮同ID三维判定；本轮新增目标、静态生产链和上述实际子样本。历史卡原验收及日期仅按原链接保留，未作为本轮PASS。当前判断日期2026-09-13；没有双侧新观测关闭差距。

<a id="cw-git-004"></a>

### CW-GIT-004 — Merge / Rebase / Cherry-pick 冲突与恢复

- **IDEA目标结果：** 冲突可比较解决，操作进度/continue/abort明确；中断恢复可回原状态。目标为需求；除I0明确事实外，细节未冒充实测。
- **Fixture / 入口：** [F3](references/fixture-catalog.md)；Git operation controls / conflict view。
- **完整采样序列（未列为已执行的步骤均待采）：** fixture两分支冲突→merge/rebase/cherry-pick→解决预览→Cancel→continue或abort→重开核对。每次保存初始/关键状态/退出后的原图或录屏，分别记录focus、caret/selection、菜单/弹层、错误、取消、undo与恢复；不适用项说明原因。
- **当前生产链 / 用户观察点：** Git operation controls / conflict view → CodeWorkspaceTab openGit → MainLayout onOpenGitManager → WorkspaceGitManager / DiffViewer → lib/git → Rust git_* / 本地 Git → status/index/log/conflict；browser VFS 无 Git repo。具体caller/符号/IPC与源文件：[S-GIT](source-audit.md#git)。
- **状态owner / IPC-provider：** workspace git snapshots、manager 多根选择/操作状态、diff pane 状态；repo/index/worktree 是数据 owner。browser VFS 无 Git repo。真实provider、native build与OS边界未执行时保持unverified。
- **当前实现与实际观测：** Rust/lib有operation state/continue/abort/rebase/cherry-pick接口；需核对WorkspaceGitManager与GitPanel不同入口的完整集成，本轮未执行。
- **独立结论：** 功能 **待验证**；视觉 **待验证**；交互 **待验证**。不输出百分比。
- **Taomni证据与当前性：** 无本轮关键状态原件：unverified（源码/case存在不改变此结论）。共用身份T0/provenance；原始日志、snapshot与具体焦点记录见baseline。未采正常/失败/取消/恢复状态仍缺失，已有case仅候选：未选择精确case；P1按本场景AC检查现有F25.1/Git cases，不自动跑全套（本轮未运行）。
- **IDEA证据 / 环境 / 状态：** 待采：目标IU-262.10315.125，按本行fixture与步骤采同状态；本机只有I0项目树局部参照，不能跨场景复用。build/主题/scale/font/keymap/语言provider边界见IDEA对照摘要。
- **差异性质：** 纯证据缺口；跨入口集成待归因风险。缺证据本身不是产品bug；没有真实双侧支持的目标差异保留待验证。
- **需求 / 影响 / 方向：** [REQ-07](overall-audit-plan-20260913.md#req-07)，P1核心 / P2高级：本轮明确纳入全Code Workspace；任务模型、Git与编辑器gutter有共享边界。先一条本地Git diff/选择流及一条Java build/run/debug流建立双侧状态，再细化配置、冲突、coverage。进入条件/依赖：F2/F3真实后端；同源QA；相关工具/adapter；不启动远端publish。
- **必须保留：** K0；abort正确恢复；保留working/index/原HEAD；不对Taomni工程或远端操作。后续验收必须观察这些结果，不能只写“保持原功能”。
- **规格与任务来源：** [code-workspace-ide-design.md](../../claudedocs/code-workspace-ide-design.md)；未核定专属 parity 任务板/ID；只关联现有生产与设计，P1 需查重后建立工作包。旧卡不重开；新观察需求尚未author/领取任务。
- **上次结论 / 本次变化：** 首次整体场景结论，无上一轮同ID三维判定；本轮新增目标、静态生产链和上述实际子样本。历史卡原验收及日期仅按原链接保留，未作为本轮PASS。当前判断日期2026-09-13；没有双侧新观测关闭差距。

<a id="cw-run-001"></a>

### CW-RUN-001 — 导入后 Build / Rebuild / 任务定位

- **IDEA目标结果：** 构建任务、前置步骤、输出和错误跳转与项目模型一致，可取消并重新运行。目标为需求；除I0明确事实外，细节未冒充实测。
- **Fixture / 入口：** [F2](references/fixture-catalog.md)；Build toolbar / BuildPanel / workspace.buildProject。
- **完整采样序列（未列为已执行的步骤均待采）：** 导入ready→Build/Recompile→错误跳文件→Cancel进程→修复→Rebuild→查看产物。每次保存初始/关键状态/退出后的原图或录屏，分别记录focus、caret/selection、菜单/弹层、错误、取消、undo与恢复；不适用项说明原因。
- **当前生产链 / 用户观察点：** Build toolbar / BuildPanel / workspace.buildProject → toolbar / BottomDock → execution model / executeTaskPlan / run target → workspace_execution_*、PTY 或 DAP → process event/exit、stack/variables/test report → 编辑器 gutter 与 panels；SDK、构建工具、adapter 为外部依赖。具体caller/符号/IPC与源文件：[S-RUN](source-audit.md#run)。
- **状态owner / IPC-provider：** execution model/config selection；Run/Build task state；useCodeDebugSession session/frame/variables/breakpoints/watch；coverage report owner。SDK、构建工具、adapter 为外部依赖。真实provider、native build与OS边界未执行时保持unverified。
- **当前实现与实际观测：** 生产Maven/Gradle工具和execution plan可达；本轮没有build，browser Facts Failed不代表真实构建缺陷。
- **独立结论：** 功能 **待验证**；视觉 **待验证**；交互 **待验证**。不输出百分比。
- **Taomni证据与当前性：** 无本轮关键状态原件：unverified（源码/case存在不改变此结论）。共用身份T0/provenance；原始日志、snapshot与具体焦点记录见baseline。未采正常/失败/取消/恢复状态仍缺失，已有case仅候选：未选择精确case；P1按本场景AC检查现有F25.1/Git cases，不自动跑全套（本轮未运行）。
- **IDEA证据 / 环境 / 状态：** 待采：目标IU-262.10315.125，按本行fixture与步骤采同状态；本机只有I0项目树局部参照，不能跨场景复用。build/主题/scale/font/keymap/语言provider边界见IDEA对照摘要。
- **差异性质：** 纯证据缺口。缺证据本身不是产品bug；没有真实双侧支持的目标差异保留待验证。
- **需求 / 影响 / 方向：** [REQ-07](overall-audit-plan-20260913.md#req-07)，P1核心 / P2高级：本轮明确纳入全Code Workspace；任务模型、Git与编辑器gutter有共享边界。先一条本地Git diff/选择流及一条Java build/run/debug流建立双侧状态，再细化配置、冲突、coverage。进入条件/依赖：F2/F3真实后端；同源QA；相关工具/adapter；不启动远端publish。
- **必须保留：** K0；命令cwd/env/module正确；取消进程与stale事件隔离；已有终端功能保留。后续验收必须观察这些结果，不能只写“保持原功能”。
- **规格与任务来源：** [code-workspace-ide-design.md](../../claudedocs/code-workspace-ide-design.md)；未核定专属 parity 任务板/ID；只关联现有生产与设计，P1 需查重后建立工作包。旧卡不重开；新观察需求尚未author/领取任务。
- **上次结论 / 本次变化：** 首次整体场景结论，无上一轮同ID三维判定；本轮新增目标、静态生产链和上述实际子样本。历史卡原验收及日期仅按原链接保留，未作为本轮PASS。当前判断日期2026-09-13；没有双侧新观测关闭差距。

<a id="cw-run-002"></a>

### CW-RUN-002 — Run configuration、运行输出与停止

- **IDEA目标结果：** 创建/选运行配置、参数/env/cwd/前置build、Run/Rerun/Stop和控制台导航一致。目标为需求；除I0明确事实外，细节未冒充实测。
- **Fixture / 入口：** [F2](references/fixture-catalog.md)；Run toolbar / RunPanel / active config selector。
- **完整采样序列（未列为已执行的步骤均待采）：** 选择main/module→配置参数/环境→Cancel→Run→输入/输出→Stop→Rerun→失败恢复。每次保存初始/关键状态/退出后的原图或录屏，分别记录focus、caret/selection、菜单/弹层、错误、取消、undo与恢复；不适用项说明原因。
- **当前生产链 / 用户观察点：** Run toolbar / RunPanel / active config selector → toolbar / BottomDock → execution model / executeTaskPlan / run target → workspace_execution_*、PTY 或 DAP → process event/exit、stack/variables/test report → 编辑器 gutter 与 panels；SDK、构建工具、adapter 为外部依赖。具体caller/符号/IPC与源文件：[S-RUN](source-audit.md#run)。
- **状态owner / IPC-provider：** execution model/config selection；Run/Build task state；useCodeDebugSession session/frame/variables/breakpoints/watch；coverage report owner。SDK、构建工具、adapter 为外部依赖。真实provider、native build与OS边界未执行时保持unverified。
- **当前实现与实际观测：** B17只有No tasks / backend unavailable；源码运行配置编辑与执行存在，不能按空fixture判未实现。
- **独立结论：** 功能 **待验证**；视觉 **待验证**；交互 **待验证**。不输出百分比。
- **Taomni证据与当前性：** [B17](../../qa-ui-auto-report/overall-audit-20260913/browser/17-run-empty.png)。共用身份T0/provenance；原始日志、snapshot与具体焦点记录见baseline。未采正常/失败/取消/恢复状态仍缺失，已有case仅候选：未选择精确case；P1按本场景AC检查现有F25.1/Git cases，不自动跑全套（本轮未运行）。
- **IDEA证据 / 环境 / 状态：** 待采：目标IU-262.10315.125，按本行fixture与步骤采同状态；本机只有I0项目树局部参照，不能跨场景复用。build/主题/scale/font/keymap/语言provider边界见IDEA对照摘要。
- **差异性质：** 纯证据缺口；browser模式限制。缺证据本身不是产品bug；没有真实双侧支持的目标差异保留待验证。
- **需求 / 影响 / 方向：** [REQ-07](overall-audit-plan-20260913.md#req-07)，P1核心 / P2高级：本轮明确纳入全Code Workspace；任务模型、Git与编辑器gutter有共享边界。先一条本地Git diff/选择流及一条Java build/run/debug流建立双侧状态，再细化配置、冲突、coverage。进入条件/依赖：F2/F3真实后端；同源QA；相关工具/adapter；不启动远端publish。
- **必须保留：** K0；配置持久化兼容；参数转义/三端进程；stop不能杀其他会话。后续验收必须观察这些结果，不能只写“保持原功能”。
- **规格与任务来源：** [code-workspace-ide-design.md](../../claudedocs/code-workspace-ide-design.md)；未核定专属 parity 任务板/ID；只关联现有生产与设计，P1 需查重后建立工作包。旧卡不重开；新观察需求尚未author/领取任务。
- **上次结论 / 本次变化：** 首次整体场景结论，无上一轮同ID三维判定；本轮新增目标、静态生产链和上述实际子样本。历史卡原验收及日期仅按原链接保留，未作为本轮PASS。当前判断日期2026-09-13；没有双侧新观测关闭差距。

<a id="cw-run-003"></a>

### CW-RUN-003 — 断点、步进、变量、Watch 与会话恢复

- **IDEA目标结果：** 断点verified/条件命中、step/frames/variables/evaluate、restart/stop与编辑器执行线同步。目标为需求；除I0明确事实外，细节未冒充实测。
- **Fixture / 入口：** [F2](references/fixture-catalog.md)；Debug toolbar / useCodeDebugSession / DebugPanel。
- **完整采样序列（未列为已执行的步骤均待采）：** 设置断点→Debug→命中→step→切frame→watch/evaluate→取消请求→restart/stop→adapter失败。每次保存初始/关键状态/退出后的原图或录屏，分别记录focus、caret/selection、菜单/弹层、错误、取消、undo与恢复；不适用项说明原因。
- **当前生产链 / 用户观察点：** Debug toolbar / useCodeDebugSession / DebugPanel → toolbar / BottomDock → execution model / executeTaskPlan / run target → workspace_execution_*、PTY 或 DAP → process event/exit、stack/variables/test report → 编辑器 gutter 与 panels；SDK、构建工具、adapter 为外部依赖。具体caller/符号/IPC与源文件：[S-RUN](source-audit.md#run)。
- **状态owner / IPC-provider：** execution model/config selection；Run/Build task state；useCodeDebugSession session/frame/variables/breakpoints/watch；coverage report owner。SDK、构建工具、adapter 为外部依赖。真实provider、native build与OS边界未执行时保持unverified。
- **当前实现与实际观测：** B14明确desktop-only、Start disabled；生产DAP start/request/terminate与session/frame状态可达；真实adapter本轮未连接。
- **独立结论：** 功能 **待验证**；视觉 **待验证**；交互 **待验证**。不输出百分比。
- **Taomni证据与当前性：** [B14](../../qa-ui-auto-report/overall-audit-20260913/browser/14-debug-empty.png)。共用身份T0/provenance；原始日志、snapshot与具体焦点记录见baseline。未采正常/失败/取消/恢复状态仍缺失，已有case仅候选：未选择精确case；P1按本场景AC检查现有F25.1/Git cases，不自动跑全套（本轮未运行）。
- **IDEA证据 / 环境 / 状态：** 待采：目标IU-262.10315.125，按本行fixture与步骤采同状态；本机只有I0项目树局部参照，不能跨场景复用。build/主题/scale/font/keymap/语言provider边界见IDEA对照摘要。
- **差异性质：** 纯证据缺口；adapter/edition边界。缺证据本身不是产品bug；没有真实双侧支持的目标差异保留待验证。
- **需求 / 影响 / 方向：** [REQ-07](overall-audit-plan-20260913.md#req-07)，P1核心 / P2高级：本轮明确纳入全Code Workspace；任务模型、Git与编辑器gutter有共享边界。先一条本地Git diff/选择流及一条Java build/run/debug流建立双侧状态，再细化配置、冲突、coverage。进入条件/依赖：F2/F3真实后端；同源QA；相关工具/adapter；不启动远端publish。
- **必须保留：** K0；会话/线程/帧代际一致；late变量不显示到新frame；断点和未保存正文保留。后续验收必须观察这些结果，不能只写“保持原功能”。
- **规格与任务来源：** [code-workspace-ide-design.md](../../claudedocs/code-workspace-ide-design.md)；未核定专属 parity 任务板/ID；只关联现有生产与设计，P1 需查重后建立工作包。旧卡不重开；新观察需求尚未author/领取任务。
- **上次结论 / 本次变化：** 首次整体场景结论，无上一轮同ID三维判定；本轮新增目标、静态生产链和上述实际子样本。历史卡原验收及日期仅按原链接保留，未作为本轮PASS。当前判断日期2026-09-13；没有双侧新观测关闭差距。

<a id="cw-run-004"></a>

### CW-RUN-004 — 测试树、失败重跑与 Coverage

- **IDEA目标结果：** 测试发现/运行/取消、失败定位、重跑和coverage gutter/report关联真实执行。目标为需求；除I0明确事实外，细节未冒充实测。
- **Fixture / 入口：** [F2](references/fixture-catalog.md)；TestsPanel / CoveragePanel / gutter test actions。
- **完整采样序列（未列为已执行的步骤均待采）：** 发现测试→run→失败跳转→rerun failed→cancel→Run with Coverage→查看行覆盖→清除。每次保存初始/关键状态/退出后的原图或录屏，分别记录focus、caret/selection、菜单/弹层、错误、取消、undo与恢复；不适用项说明原因。
- **当前生产链 / 用户观察点：** TestsPanel / CoveragePanel / gutter test actions → toolbar / BottomDock → execution model / executeTaskPlan / run target → workspace_execution_*、PTY 或 DAP → process event/exit、stack/variables/test report → 编辑器 gutter 与 panels；SDK、构建工具、adapter 为外部依赖。具体caller/符号/IPC与源文件：[S-RUN](source-audit.md#run)。
- **状态owner / IPC-provider：** execution model/config selection；Run/Build task state；useCodeDebugSession session/frame/variables/breakpoints/watch；coverage report owner。SDK、构建工具、adapter 为外部依赖。真实provider、native build与OS边界未执行时保持unverified。
- **当前实现与实际观测：** 生产测试发现、structured results、coverage report model存在；本轮未执行，LCOV/JaCoCo显示不等于IDEA Run with Coverage闭环。
- **独立结论：** 功能 **待验证**；视觉 **待验证**；交互 **待验证**。不输出百分比。
- **Taomni证据与当前性：** 无本轮关键状态原件：unverified（源码/case存在不改变此结论）。共用身份T0/provenance；原始日志、snapshot与具体焦点记录见baseline。未采正常/失败/取消/恢复状态仍缺失，已有case仅候选：未选择精确case；P1按本场景AC检查现有F25.1/Git cases，不自动跑全套（本轮未运行）。
- **IDEA证据 / 环境 / 状态：** 待采：目标IU-262.10315.125，按本行fixture与步骤采同状态；本机只有I0项目树局部参照，不能跨场景复用。build/主题/scale/font/keymap/语言provider边界见IDEA对照摘要。
- **差异性质：** 纯证据缺口；执行关联待验证。缺证据本身不是产品bug；没有真实双侧支持的目标差异保留待验证。
- **需求 / 影响 / 方向：** [REQ-07](overall-audit-plan-20260913.md#req-07)，P1核心 / P2高级：本轮明确纳入全Code Workspace；任务模型、Git与编辑器gutter有共享边界。先一条本地Git diff/选择流及一条Java build/run/debug流建立双侧状态，再细化配置、冲突、coverage。进入条件/依赖：F2/F3真实后端；同源QA；相关工具/adapter；不启动远端publish。
- **必须保留：** K0；结果绑定本轮run，不能混旧报告；coverage与debug/git gutter共享回归。后续验收必须观察这些结果，不能只写“保持原功能”。
- **规格与任务来源：** [code-workspace-ide-design.md](../../claudedocs/code-workspace-ide-design.md)；未核定专属 parity 任务板/ID；只关联现有生产与设计，P1 需查重后建立工作包。旧卡不重开；新观察需求尚未author/领取任务。
- **上次结论 / 本次变化：** 首次整体场景结论，无上一轮同ID三维判定；本轮新增目标、静态生产链和上述实际子样本。历史卡原验收及日期仅按原链接保留，未作为本轮PASS。当前判断日期2026-09-13；没有双侧新观测关闭差距。

<a id="cw-run-005"></a>

### CW-RUN-005 — 内置终端、工作目录与焦点切换

- **IDEA目标结果：** 工具窗终端从当前项目目录打开，编辑器/终端快捷键与选择互不抢夺，可关闭恢复。目标为需求；除I0明确事实外，细节未冒充实测。
- **Fixture / 入口：** [F0/F2/F5](references/fixture-catalog.md)；TerminalDockPanel / Open in Terminal / workspace.toggleTerminal。
- **完整采样序列（未列为已执行的步骤均待采）：** 文件树Open in Terminal→pwd/cwd→分屏→editor快捷键→终端Ctrl+C→关闭/重开→会话恢复。每次保存初始/关键状态/退出后的原图或录屏，分别记录focus、caret/selection、菜单/弹层、错误、取消、undo与恢复；不适用项说明原因。
- **当前生产链 / 用户观察点：** TerminalDockPanel / Open in Terminal / workspace.toggleTerminal → toolbar / BottomDock → execution model / executeTaskPlan / run target → workspace_execution_*、PTY 或 DAP → process event/exit、stack/variables/test report → 编辑器 gutter 与 panels；SDK、构建工具、adapter 为外部依赖。具体caller/符号/IPC与源文件：[S-RUN](source-audit.md#run)。
- **状态owner / IPC-provider：** execution model/config selection；Run/Build task state；useCodeDebugSession session/frame/variables/breakpoints/watch；coverage report owner。SDK、构建工具、adapter 为外部依赖。真实provider、native build与OS边界未执行时保持unverified。
- **当前实现与实际观测：** terminal dock 和PTY路径存在；本轮未启动终端，browser SSH bridge不证明native local PTY。
- **独立结论：** 功能 **待验证**；视觉 **待验证**；交互 **待验证**。不输出百分比。
- **Taomni证据与当前性：** 无本轮关键状态原件：unverified（源码/case存在不改变此结论）。共用身份T0/provenance；原始日志、snapshot与具体焦点记录见baseline。未采正常/失败/取消/恢复状态仍缺失，已有case仅候选：未选择精确case；P1按本场景AC检查现有F25.1/Git cases，不自动跑全套（本轮未运行）。
- **IDEA证据 / 环境 / 状态：** 待采：目标IU-262.10315.125，按本行fixture与步骤采同状态；本机只有I0项目树局部参照，不能跨场景复用。build/主题/scale/font/keymap/语言provider边界见IDEA对照摘要。
- **差异性质：** 纯证据缺口。缺证据本身不是产品bug；没有真实双侧支持的目标差异保留待验证。
- **需求 / 影响 / 方向：** [REQ-07](overall-audit-plan-20260913.md#req-07)，P1核心 / P2高级：本轮明确纳入全Code Workspace；任务模型、Git与编辑器gutter有共享边界。先一条本地Git diff/选择流及一条Java build/run/debug流建立双侧状态，再细化配置、冲突、coverage。进入条件/依赖：F2/F3真实后端；同源QA；相关工具/adapter；不启动远端publish。
- **必须保留：** K0；Ctrl+C归当前终端；不泄漏用户环境/个人shell状态；关闭不影响其他会话。后续验收必须观察这些结果，不能只写“保持原功能”。
- **规格与任务来源：** [code-workspace-ide-design.md](../../claudedocs/code-workspace-ide-design.md)；未核定专属 parity 任务板/ID；只关联现有生产与设计，P1 需查重后建立工作包。旧卡不重开；新观察需求尚未author/领取任务。
- **上次结论 / 本次变化：** 首次整体场景结论，无上一轮同ID三维判定；本轮新增目标、静态生产链和上述实际子样本。历史卡原验收及日期仅按原链接保留，未作为本轮PASS。当前判断日期2026-09-13；没有双侧新观测关闭差距。

<a id="cw-set-001"></a>

### CW-SET-001 — 外观、密度、主题、字号与可访问性

- **IDEA目标结果：** 代表性主题、字体、tree/tab/tool-window密度与选中/失焦角色遵循目标；缩放不遮挡关键动作。目标为需求；除I0明确事实外，细节未冒充实测。
- **Fixture / 入口：** [F0/F1](references/fixture-catalog.md)；WorkspaceEditorAppearanceSettingsDialog / editor/tree zoom / app theme。
- **完整采样序列（未列为已执行的步骤均待采）：** 匹配IDEA设置→两侧同客户区截图→active/inactive/disabled→缩小窗口→溢出→reset/cancel。每次保存初始/关键状态/退出后的原图或录屏，分别记录focus、caret/selection、菜单/弹层、错误、取消、undo与恢复；不适用项说明原因。
- **当前生产链 / 用户观察点：** WorkspaceEditorAppearanceSettingsDialog / editor/tree zoom / app theme → Search Actions / toolbar / Settings → Dialog draft → apply/cancel → scheme/profile persistence → CM compartments、树与编辑器 CSS / keybinding dispatch；EditorConfig native parent-file reads。具体caller/符号/IPC与源文件：[S-SET](source-audit.md#set)。
- **状态owner / IPC-provider：** keymap v3 scheme / WorkspaceActionHost；editorAppearanceProfile；effective style/controller / EditorConfig cache。EditorConfig native parent-file reads。真实provider、native build与OS边界未执行时保持unverified。
- **当前实现与实际观测：** 当前浅色Inter12、代码13/19.5、tree27、tabs28已测；IDEA深色字体/scale未核实；没有本轮外观设置转换采样。
- **独立结论：** 功能 **待验证**；视觉 **待验证**；交互 **待验证**。不输出百分比。
- **Taomni证据与当前性：** 无本轮关键状态原件：unverified（源码/case存在不改变此结论）。共用身份T0/provenance；原始日志、snapshot与具体焦点记录见baseline。未采正常/失败/取消/恢复状态仍缺失，已有case仅候选：[TC-IDE-C4-01](../../qa-ui-auto-tests/cases/TC-IDE-C4-01-tab-policy-lifecycle.testcase.yaml)（本轮未运行）。
- **IDEA证据 / 环境 / 状态：** 待采：目标IU-262.10315.125，按本行fixture与步骤采同状态；本机只有I0项目树局部参照，不能跨场景复用。build/主题/scale/font/keymap/语言provider边界见IDEA对照摘要。
- **差异性质：** 纯证据缺口；视觉不可比较条件。缺证据本身不是产品bug；没有真实双侧支持的目标差异保留待验证。
- **需求 / 影响 / 方向：** [REQ-03](overall-audit-plan-20260913.md#req-03)，P1：贯穿全部能力，决定空间利用与可发现性；需要先锁定真实UI设置。先采匹配主题/scale/font，再细化tool-window位置、层级、密度、选中/失焦、菜单溢出；不先写假token。进入条件/依赖：目标环境就绪；SHELL/SET/TREE消费者清单；用户未接受任何有限差异。
- **必须保留：** K0；主题/字号存储兼容；键盘可达与对比度；不以冻结现状限制布局重构。后续验收必须观察这些结果，不能只写“保持原功能”。
- **规格与任务来源：** [editor-experience.md](../../claudedocs/code-workspace-idea-specs/editor-experience.md)；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-STYLE-001`（原记录 2026-09-04T00:14:45Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-STYLE-002`（原记录 2026-09-05T05:22:00Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-IMPORT-001`（原记录 2026-09-05T05:32:00Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-GATE-002`（原记录 2026-09-02T08:56:15Z）。旧卡不重开；新观察需求尚未author/领取任务。
- **上次结论 / 本次变化：** 首次整体场景结论，无上一轮同ID三维判定；本轮新增目标、静态生产链和上述实际子样本。历史卡原验收及日期仅按原链接保留，未作为本轮PASS。当前判断日期2026-09-13；没有双侧新观测关闭差距。

<a id="cw-set-002"></a>

### CW-SET-002 — Keymap、快捷键冲突与动作可发现性

- **IDEA目标结果：** 选择/复制/编辑scheme、冲突检测、平台键位和菜单提示一致，取消不改绑定。目标为需求；除I0明确事实外，细节未冒充实测。
- **Fixture / 入口：** [F0/F1/F5](references/fixture-catalog.md)；Search Everywhere → Keymap Settings / workspace.keymapSettings。
- **完整采样序列（未列为已执行的步骤均待采）：** 搜索动作→打开scheme→复制/改键→冲突→Cancel/Reset→跨editor/tree/modal/terminal执行→重开。每次保存初始/关键状态/退出后的原图或录屏，分别记录focus、caret/selection、菜单/弹层、错误、取消、undo与恢复；不适用项说明原因。
- **当前生产链 / 用户观察点：** Search Everywhere → Keymap Settings / workspace.keymapSettings → Search Actions / toolbar / Settings → Dialog draft → apply/cancel → scheme/profile persistence → CM compartments、树与编辑器 CSS / keybinding dispatch；EditorConfig native parent-file reads。具体caller/符号/IPC与源文件：[S-SET](source-audit.md#set)。
- **状态owner / IPC-provider：** keymap v3 scheme / WorkspaceActionHost；editorAppearanceProfile；effective style/controller / EditorConfig cache。EditorConfig native parent-file reads。真实provider、native build与OS边界未执行时保持unverified。
- **当前实现与实际观测：** B16显示IDEA defaults(default)及可编辑动作表，Escape关闭；没有改键/冲突/持久化/三端物理按键验证。
- **独立结论：** 功能 **待验证**；视觉 **待验证**；交互 **待验证**。不输出百分比。
- **Taomni证据与当前性：** [B16](../../qa-ui-auto-report/overall-audit-20260913/browser/16-keymap-settings.png)。共用身份T0/provenance；原始日志、snapshot与具体焦点记录见baseline。未采正常/失败/取消/恢复状态仍缺失，已有case仅候选：[TC-IDE-C4-01](../../qa-ui-auto-tests/cases/TC-IDE-C4-01-tab-policy-lifecycle.testcase.yaml)（本轮未运行）。
- **IDEA证据 / 环境 / 状态：** 待采：目标IU-262.10315.125，按本行fixture与步骤采同状态；本机只有I0项目树局部参照，不能跨场景复用。build/主题/scale/font/keymap/语言provider边界见IDEA对照摘要。
- **差异性质：** 纯证据缺口。缺证据本身不是产品bug；没有真实双侧支持的目标差异保留待验证。
- **需求 / 影响 / 方向：** [REQ-10](overall-audit-plan-20260913.md#req-10)，P1：共享动作与样式是布局/编辑重构的基础，三端keymap风险明确。用目标scheme/EditorConfig样例定义作用域、冲突、reset/cancel与持久化；允许统一设置入口。进入条件/依赖：IDEA keymap/style真实设置；F4/F5；WorkspaceActionHost唯一执行owner。
- **必须保留：** K0；一个WorkspaceActionHost执行真相；旧scheme迁移、AltGr/IME与多workspace ownership。后续验收必须观察这些结果，不能只写“保持原功能”。
- **规格与任务来源：** [editor-experience.md](../../claudedocs/code-workspace-idea-specs/editor-experience.md)；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-STYLE-001`（原记录 2026-09-04T00:14:45Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-STYLE-002`（原记录 2026-09-05T05:22:00Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-IMPORT-001`（原记录 2026-09-05T05:32:00Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-GATE-002`（原记录 2026-09-02T08:56:15Z）。旧卡不重开；新观察需求尚未author/领取任务。
- **上次结论 / 本次变化：** 首次整体场景结论，无上一轮同ID三维判定；本轮新增目标、静态生产链和上述实际子样本。历史卡原验收及日期仅按原链接保留，未作为本轮PASS。当前判断日期2026-09-13；没有双侧新观测关闭差距。

<a id="cw-set-003"></a>

### CW-SET-003 — Code Style、EditorConfig 与设置作用域

- **IDEA目标结果：** 应用/项目/语言样式与EditorConfig优先级明确，预览、取消、保存动作结果一致。目标为需求；除I0明确事实外，细节未冒充实测。
- **Fixture / 入口：** [F2/F4/F5](references/fixture-catalog.md)；CodeStyleSettingsDialog / AutoImportSettings / EditorConfig。
- **完整采样序列（未列为已执行的步骤均待采）：** 父/子EditorConfig→查看effective provenance→改style→Cancel→Apply→format/save→重开/外部修改。每次保存初始/关键状态/退出后的原图或录屏，分别记录focus、caret/selection、菜单/弹层、错误、取消、undo与恢复；不适用项说明原因。
- **当前生产链 / 用户观察点：** CodeStyleSettingsDialog / AutoImportSettings / EditorConfig → Search Actions / toolbar / Settings → Dialog draft → apply/cancel → scheme/profile persistence → CM compartments、树与编辑器 CSS / keybinding dispatch；EditorConfig native parent-file reads。具体caller/符号/IPC与源文件：[S-SET](source-audit.md#set)。
- **状态owner / IPC-provider：** keymap v3 scheme / WorkspaceActionHost；editorAppearanceProfile；effective style/controller / EditorConfig cache。EditorConfig native parent-file reads。真实provider、native build与OS边界未执行时保持unverified。
- **当前实现与实际观测：** style controller/EditorConfig resolver已在生产；本轮未编辑设置或文件，不能沿用旧“parser only”结论。
- **独立结论：** 功能 **待验证**；视觉 **待验证**；交互 **待验证**。不输出百分比。
- **Taomni证据与当前性：** 无本轮关键状态原件：unverified（源码/case存在不改变此结论）。共用身份T0/provenance；原始日志、snapshot与具体焦点记录见baseline。未采正常/失败/取消/恢复状态仍缺失，已有case仅候选：[TC-IDE-C4-01](../../qa-ui-auto-tests/cases/TC-IDE-C4-01-tab-policy-lifecycle.testcase.yaml)（本轮未运行）。
- **IDEA证据 / 环境 / 状态：** 待采：目标IU-262.10315.125，按本行fixture与步骤采同状态；本机只有I0项目树局部参照，不能跨场景复用。build/主题/scale/font/keymap/语言provider边界见IDEA对照摘要。
- **差异性质：** 纯证据缺口。缺证据本身不是产品bug；没有真实双侧支持的目标差异保留待验证。
- **需求 / 影响 / 方向：** [REQ-10](overall-audit-plan-20260913.md#req-10)，P1：共享动作与样式是布局/编辑重构的基础，三端keymap风险明确。用目标scheme/EditorConfig样例定义作用域、冲突、reset/cancel与持久化；允许统一设置入口。进入条件/依赖：IDEA keymap/style真实设置；F4/F5；WorkspaceActionHost唯一执行owner。
- **必须保留：** K0；每字段来源准确；root-stop/cache失效；换行编码与保存byte契约。后续验收必须观察这些结果，不能只写“保持原功能”。
- **规格与任务来源：** [editor-experience.md](../../claudedocs/code-workspace-idea-specs/editor-experience.md)；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-STYLE-001`（原记录 2026-09-04T00:14:45Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-STYLE-002`（原记录 2026-09-05T05:22:00Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-IMPORT-001`（原记录 2026-09-05T05:32:00Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-GATE-002`（原记录 2026-09-02T08:56:15Z）。旧卡不重开；新观察需求尚未author/领取任务。
- **上次结论 / 本次变化：** 首次整体场景结论，无上一轮同ID三维判定；本轮新增目标、静态生产链和上述实际子样本。历史卡原验收及日期仅按原链接保留，未作为本轮PASS。当前判断日期2026-09-13；没有双侧新观测关闭差距。

<a id="cw-shell-001"></a>

### CW-SHELL-001 — 整体布局、Tool Windows、菜单与状态栏

- **IDEA目标结果：** 项目/编辑器/tool windows/主菜单组织贴近目标，布局可调整和恢复，信息层级清楚。目标为需求；除I0明确事实外，细节未冒充实测。
- **Fixture / 入口：** [F0/F2](references/fixture-catalog.md)；MainLayout / CodeWorkspace toolbar / BottomDock / Main menu。
- **完整采样序列（未列为已执行的步骤均待采）：** 开项目→切Project/Problems/Run→collapse/resize→主菜单→tool window焦点→恢复layout。每次保存初始/关键状态/退出后的原图或录屏，分别记录focus、caret/selection、菜单/弹层、错误、取消、undo与恢复；不适用项说明原因。
- **当前生产链 / 用户观察点：** MainLayout / CodeWorkspace toolbar / BottomDock / Main menu → MainLayout → CodeWorkspaceTab → ActionsController / WorkspaceActionHost → panels/store → 可见入口和焦点；native window/dialog 经 Tauri，browser 使用 stubs。具体caller/符号/IPC与源文件：[S-SHELL](source-audit.md#shell)。
- **状态owner / IPC-provider：** MainLayout 的 app tab；CodeWorkspaceTab 装配；codeWorkspaceStore 按 workspaceInstanceId 持有布局，WorkspaceActionHost 持有动作上下文。native window/dialog 经 Tauri，browser 使用 stubs。真实provider、native build与OS边界未执行时保持unverified。
- **当前实现与实际观测：** B01默认References与双侧栏；B10–B17切底部tabs和分屏。目标IDEA完整菜单/工具窗设置待采；不把小图相似作为完成。
- **独立结论：** 功能 **待验证**；视觉 **待验证**；交互 **待验证**。不输出百分比。
- **Taomni证据与当前性：** [B01](../../qa-ui-auto-report/overall-audit-20260913/browser/01-empty-workspace.png) / [B10](../../qa-ui-auto-report/overall-audit-20260913/browser/10-split-right.png) / [B12](../../qa-ui-auto-report/overall-audit-20260913/browser/12-find-in-files.png) / [B13](../../qa-ui-auto-report/overall-audit-20260913/browser/13-problems.png) / [B14](../../qa-ui-auto-report/overall-audit-20260913/browser/14-debug-empty.png) / [B17](../../qa-ui-auto-report/overall-audit-20260913/browser/17-run-empty.png)。共用身份T0/provenance；原始日志、snapshot与具体焦点记录见baseline。未采正常/失败/取消/恢复状态仍缺失，已有case仅候选：[TC-IDE-TREE-01-project-tree-keyboard-native](../../qa-ui-auto-tests/cases/TC-IDE-TREE-01-project-tree-keyboard-native.testcase.yaml)（本轮未运行）。
- **IDEA证据 / 环境 / 状态：** 待采：目标IU-262.10315.125，按本行fixture与步骤采同状态；本机只有I0项目树局部参照，不能跨场景复用。build/主题/scale/font/keymap/语言provider边界见IDEA对照摘要。
- **差异性质：** 视觉/交互体验差异待验证；纯证据缺口。缺证据本身不是产品bug；没有真实双侧支持的目标差异保留待验证。
- **需求 / 影响 / 方向：** [REQ-03](overall-audit-plan-20260913.md#req-03)，P1：贯穿全部能力，决定空间利用与可发现性；需要先锁定真实UI设置。先采匹配主题/scale/font，再细化tool-window位置、层级、密度、选中/失焦、菜单溢出；不先写假token。进入条件/依赖：目标环境就绪；SHELL/SET/TREE消费者清单；用户未接受任何有限差异。
- **必须保留：** K0；保留多workspace与全应用入口；工具窗关闭不丢运行/dirty数据；允许重组组件与动作。后续验收必须观察这些结果，不能只写“保持原功能”。
- **规格与任务来源：** [correctness-gates.md](../../claudedocs/code-workspace-idea-specs/correctness-gates.md)；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-GATE-001`（原记录 2026-09-02T08:34:43Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-GATE-002`（原记录 2026-09-02T08:56:15Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-GATE-003`（原记录 2026-08-31T11:05:00Z）。旧卡不重开；新观察需求尚未author/领取任务。
- **上次结论 / 本次变化：** 首次整体场景结论，无上一轮同ID三维判定；本轮新增目标、静态生产链和上述实际子样本。历史卡原验收及日期仅按原链接保留，未作为本轮PASS。当前判断日期2026-09-13；没有双侧新观测关闭差距。

<a id="cw-shell-002"></a>

### CW-SHELL-002 — 弹层、菜单与编辑器焦点生命周期

- **IDEA目标结果：** 弹层锚定正确，Enter/Tab/Esc和外部点击行为一致，退出回原caret，快捷键不穿透。目标为需求；除I0明确事实外，细节未冒充实测。
- **Fixture / 入口：** [F0/F1/F2](references/fixture-catalog.md)；ContextMenu / WorkspacePopupsHost / dialogs / CodeMirror search。
- **完整采样序列（未列为已执行的步骤均待采）：** 树/编辑器菜单→Esc→Search Everywhere→设置→Esc→Ctrl+F→Esc→completion/IME→切workspace/late result。每次保存初始/关键状态/退出后的原图或录屏，分别记录focus、caret/selection、菜单/弹层、错误、取消、undo与恢复；不适用项说明原因。
- **当前生产链 / 用户观察点：** ContextMenu / WorkspacePopupsHost / dialogs / CodeMirror search → MainLayout → CodeWorkspaceTab → ActionsController / WorkspaceActionHost → panels/store → 可见入口和焦点；native window/dialog 经 Tauri，browser 使用 stubs。具体caller/符号/IPC与源文件：[S-SHELL](source-audit.md#shell)。
- **状态owner / IPC-provider：** MainLayout 的 app tab；CodeWorkspaceTab 装配；codeWorkspaceStore 按 workspaceInstanceId 持有布局，WorkspaceActionHost 持有动作上下文。native window/dialog 经 Tauri，browser 使用 stubs。真实provider、native build与OS边界未执行时保持unverified。
- **当前实现与实际观测：** B06/B07/B08/B15/B16有入口；Ctrl+F同步focus触发异常。菜单返回焦点、Tab trap、edge flip、IME及迟到结果未完整记录。
- **独立结论：** 功能 **待验证**；视觉 **待验证**；交互 **待验证**。不输出百分比。
- **Taomni证据与当前性：** [B06](../../qa-ui-auto-report/overall-audit-20260913/browser/06-context-menu.png) / [B07](../../qa-ui-auto-report/overall-audit-20260913/browser/07-rename-prompt.png) / [B08](../../qa-ui-auto-report/overall-audit-20260913/browser/08-editor-find.png) / [B15](../../qa-ui-auto-report/overall-audit-20260913/browser/15-search-everywhere.png) / [B16](../../qa-ui-auto-report/overall-audit-20260913/browser/16-keymap-settings.png) / [B18](../../qa-ui-auto-report/overall-audit-20260913/browser/18-find-repro.png)。共用身份T0/provenance；原始日志、snapshot与具体焦点记录见baseline。未采正常/失败/取消/恢复状态仍缺失，已有case仅候选：[TC-IDE-TREE-01-project-tree-keyboard-native](../../qa-ui-auto-tests/cases/TC-IDE-TREE-01-project-tree-keyboard-native.testcase.yaml)（本轮未运行）。
- **IDEA证据 / 环境 / 状态：** I0仅33-context-example / 34-context-dismiss的PNG/JSON，准确目录 `qa-ui-auto-report/project-tree-e2e/idea/`；整个场景的新增/rename/delete或搜索/弹层焦点关键状态仍待采，不能签发匹配。
- **差异性质：** 确认产品缺陷（搜索focus链）；其余纯证据缺口。缺证据本身不是产品bug；没有真实双侧支持的目标差异保留待验证。
- **需求 / 影响 / 方向：** [REQ-01](overall-audit-plan-20260913.md#req-01)，P0：高频入口已有可重复异常，影响搜索与modifier-hover共享消费者。先修复同步focus触发的CM重入；明确打开/取消/回焦状态机，复用当前动作与文档owner。进入条件/依赖：目标IDEA查找关键状态；当前renderer反例；后续native小范围复现。
- **必须保留：** K0；焦点owner真实、取消无编辑、modifier清理不重入；对话框消费者及查找/补全/语义导航保留。后续验收必须观察这些结果，不能只写“保持原功能”。
- **规格与任务来源：** [correctness-gates.md](../../claudedocs/code-workspace-idea-specs/correctness-gates.md)；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-GATE-001`（原记录 2026-09-02T08:34:43Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-GATE-002`（原记录 2026-09-02T08:56:15Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-GATE-003`（原记录 2026-08-31T11:05:00Z）。旧卡不重开；新观察需求尚未author/领取任务。
- **上次结论 / 本次变化：** 首次整体场景结论，无上一轮同ID三维判定；本轮新增目标、静态生产链和上述实际子样本。历史卡原验收及日期仅按原链接保留，未作为本轮PASS。当前判断日期2026-09-13；没有双侧新观测关闭差距。


- **2026-09-14 P1 局部接续：** [WP-FIND-FOCUS-01 设计](../../docs-issue/code-workspace-find-focus-design.md)、[ED-FINDFOCUS-001 唯一任务板](../../claudedocs/code-workspace-idea-parity-backlog-find-focus.md)、[真实 Find 参照](references/find-focus-2026.2.2.md)。补得 F0 Find/query/Enter/Shift+Enter/Esc/repeat 的 IDEA 侧观察；Taomni candidate 尚未实施或执行。原功能/视觉/交互三维结论和差异类型保留，未关闭场景差距；任务状态仅看板。

<a id="cw-shell-003"></a>

### CW-SHELL-003 — 多工作区、跨窗口与三端恢复

- **IDEA目标结果：** 多个项目和窗口的动作、数据、provider、布局隔离；系统关闭/恢复、文件对话框和键位符合平台。目标为需求；除I0明确事实外，细节未冒充实测。
- **Fixture / 入口：** [F0/F1/F5](references/fixture-catalog.md)；app workspace tabs / window lifecycle / native dialogs。
- **完整采样序列（未列为已执行的步骤均待采）：** 开两个同名文件workspace→分别dirty/运行→切换快捷键→弹窗→关一窗口→重开/恢复→各平台重复关键边界。每次保存初始/关键状态/退出后的原图或录屏，分别记录focus、caret/selection、菜单/弹层、错误、取消、undo与恢复；不适用项说明原因。
- **当前生产链 / 用户观察点：** app workspace tabs / window lifecycle / native dialogs → MainLayout → CodeWorkspaceTab → ActionsController / WorkspaceActionHost → panels/store → 可见入口和焦点；native window/dialog 经 Tauri，browser 使用 stubs。具体caller/符号/IPC与源文件：[S-SHELL](source-audit.md#shell)。
- **状态owner / IPC-provider：** MainLayout 的 app tab；CodeWorkspaceTab 装配；codeWorkspaceStore 按 workspaceInstanceId 持有布局，WorkspaceActionHost 持有动作上下文。native window/dialog 经 Tauri，browser 使用 stubs。真实provider、native build与OS边界未执行时保持unverified。
- **当前实现与实际观测：** instance store、actionhost和app context有隔离路径；本轮仅一个browser workspace；未证明editor tab detach/跨窗口行为，native三端全未验证。
- **独立结论：** 功能 **待验证**；视觉 **待验证**；交互 **待验证**。不输出百分比。
- **Taomni证据与当前性：** 无本轮关键状态原件：unverified（源码/case存在不改变此结论）。共用身份T0/provenance；原始日志、snapshot与具体焦点记录见baseline。未采正常/失败/取消/恢复状态仍缺失，已有case仅候选：[TC-IDE-TREE-01-project-tree-keyboard-native](../../qa-ui-auto-tests/cases/TC-IDE-TREE-01-project-tree-keyboard-native.testcase.yaml)（本轮未运行）。
- **IDEA证据 / 环境 / 状态：** 待采：目标IU-262.10315.125，按本行fixture与步骤采同状态；本机只有I0项目树局部参照，不能跨场景复用。build/主题/scale/font/keymap/语言provider边界见IDEA对照摘要。
- **差异性质：** 纯证据缺口；跨窗口能力待决。缺证据本身不是产品bug；没有真实双侧支持的目标差异保留待验证。
- **需求 / 影响 / 方向：** [REQ-04](overall-audit-plan-20260913.md#req-04)，P0保留 / P1体验：改UI前必须保护dirty、共享undo、最后资源释放；多窗口数据风险高。复用layoutTreeV2与transaction owner，补真实preview/eviction/restore观察后再确定UI重组。进入条件/依赖：F1/F5、同源QA、目标tab设置；不将B20解释为丢失。
- **必须保留：** K0；Windows/macOS/Linux兼容；保存/undo/cancel/recovery和数据迁移；不得共享错误owner。后续验收必须观察这些结果，不能只写“保持原功能”。
- **规格与任务来源：** [correctness-gates.md](../../claudedocs/code-workspace-idea-specs/correctness-gates.md)；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-GATE-001`（原记录 2026-09-02T08:34:43Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-GATE-002`（原记录 2026-09-02T08:56:15Z）；[code-workspace-idea-parity-backlog.md](../../claudedocs/code-workspace-idea-parity-backlog.md) `ED-GATE-003`（原记录 2026-08-31T11:05:00Z）。旧卡不重开；新观察需求尚未author/领取任务。
- **上次结论 / 本次变化：** 首次整体场景结论，无上一轮同ID三维判定；本轮新增目标、静态生产链和上述实际子样本。历史卡原验收及日期仅按原链接保留，未作为本轮PASS。当前判断日期2026-09-13；没有双侧新观测关闭差距。

## ID映射和增量复评规则

首次没有有效整体index或稳定用户场景目录，因此创建CW-* ID。历史ED-*是任务/AC，不改号、不废弃；上面的多对多任务链接就是初次映射。旧5份发布/修复矩阵继续保留其原范围和日期；本文件是未来整体需求评估的唯一写回处。

以后新增/拆分/合并/移出场景须追加日期、原ID→新ID、原因和分母变化，旧ID保留redirect/tombstone，不能为提高对齐率删除难项。仅修改受影响场景：对照上次source/caller/provider/settings/fixture/case/runner/build变化；无变化行保留原结论/检查时间，不刷新通过。只有对应维度满足目标或用户明确接受有限差异并已验证，才关闭该维度差距。

本次新增45场景；拆分0、合并0、移出0；新增需求REQ-01..REQ-11；差距关闭0；新接受差异0。证据失效：历史Windows tree receipt stale；其他历史材料只降为线索，不伪造逐项失效结论。
