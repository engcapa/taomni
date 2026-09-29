# Code Workspace 与 IntelliJ IDEA Code Editor 对齐设计

## 1. 设计摘要与范围

- 类型：现有能力扩展与编辑器体验重构。
- 设计状态：部分可实施；13 张任务卡仍需 P1 为每张卡补齐独立 DEC/AC/V 和可执行用例。
- 来源：2026-09-28 本机 IDEA 实机对比；2026-09-29 [控件级复核](references/idea-control-audit-20260929.md)（50 个 IDEA 状态 + 同 fixture Taomni browser 状态）；旧 `docs-feature/code-workspace-idea-parity` 总评估与 backlog。
- 基线：Taomni HEAD `06ef13d0`（2026-09-29 复核；首轮为 `ade7da19`）；IDEA Ultimate 2026.2.2 / IU-262.10315.125，XWin keymap；Linux X11，IDEA 窗口 1400×1000，深色 UI + 浅色编辑器配色；Taomni browser preview 1400×900，浅色主题。
- 平台：Windows、macOS、Linux Tauri 2 桌面应用。浏览器只证明 renderer 分支；IPC、磁盘、JDT LS、系统快捷键、窗口、IME 和打包 WebView 必须有 native 证据。

用户要的是 Code Workspace 像 IDEA Code Editor 一样工作和呈现。当前实机结果表明，Taomni 已有许多对应入口和 Action，但整体壳层、信息密度、焦点生命周期、快捷键冲突模型、语言服务状态和结构搜索 UI 仍有差距。本设计把差距拆成可独立交付的任务，要求每个任务同时处理功能、交互、快捷键和视觉中真正受影响的部分，并保留保存、撤销、取消、恢复、dirty 和多 workspace 数据契约。

## 2. 目标用户结果

1. 打开工程后，Project、editor、工具栏和底部工具窗口的空间层级与 IDEA 的选定 profile 一致，工具切换不会卸载编辑器或丢工具状态。
2. `Ctrl/Cmd+F`、`Ctrl/Cmd+Shift+N`、双 Shift、`Ctrl/Cmd+B`、`Ctrl/Cmd+Alt+M` 等入口从正确焦点触发，输入框、终端、IME 和弹层优先级明确，取消后回到正确的编辑上下文。
3. Java 工程就绪、加载、降级、无 provider、超时和恢复状态都有可理解且可恢复的 UI；补全、诊断、导航和结构搜索的语义结果与 UI 状态分开验证。
4. Rename/Extract、项目替换、Git diff、Run/Debug 等跨文件或跨工具操作可以预览、取消、恢复，并保留真实 dirty、磁盘字节、历史和 undo 结果。
5. 每个已交付工作包都有 IDEA 与 Taomni 的功能、交互、视觉三列结论；未观测项保持 `unverified`，不因 validator 通过而写成 matched。

## 3. 当前实现与差距

| 区域 | 当前事实 | 本批次处理 |
|---|---|---|
| 壳层 | `CodeWorkspaceTab`、`MainLayout`、`BottomDock`、`toolWindowRegistry` 已提供 workspace、工具窗和布局状态；实机上仍与 IDEA 的左右 rail/底部窗口/标签层级不同。 | 010 重组视觉与布局 owner，保护 store、editor leaf 和工具数据。 |
| 编辑器 surface | CodeMirror、editor tabs、breadcrumbs、Problems、zoom、split 和通知已存在；信息密度、字体、状态提示和边缘标记不同。 | 011 统一 surface 和状态呈现。 |
| Find/弹层 | Find、Replace、Search Everywhere 和菜单有生产入口；历史曾有 focus 重入问题，双侧 Esc/焦点序列未完成。 | 012 固化 owner、焦点、取消和迟到响应。 |
| Action/Keymap | `workspaceActionRegistry.ts` 已登记大量 IDEA 风格绑定，例如 Go to File `Ctrl+Shift+N`、Search Everywhere `Shift+Shift`、Extract Method `Ctrl+Alt+M`；注册表不等于运行期全路径匹配。 | 013 处理冲突、持久化、平台 Mod、IME 和实际入口。 |
| 项目与导航 | Project tree、Go to File、Search Everywhere、Go to Symbol、Back 等入口已存在；provider、结果预览、树焦点和密度仍不完整。 | 014 统一入口和导航反馈。 |
| 语言服务 | browser preview 明确显示 Java language server unavailable / Facts Failed；旧 005 只覆盖首包 Basic Completion。 | 015 以 JDK/JDT LS 就绪、降级和恢复为完整状态机。 |
| Structural Search | 009 已实现 Java AST 首包，结果集合与 IDEA 目标有交集，但对话框、scope/modifier、预览和空态不同，comparison 为 unverified。 | 016 处理 UI/交互对齐，保留 AST 语义边界。 |
| Refactor | Rename/Extract 有局部实现和事务保护；整体 IDEA preview、冲突、失败恢复和跨文件可视性尚未闭合。 | 017 统一跨文件动作体验和 undo/recovery。 |
| Git/Run | Git 多仓库 diff 首包已有隔离与迟到防护；Run/Debug/Terminal 与 IDEA 工具窗连续流未完整比较。 | 018 处理工具上下文和返回编辑器。 |
| 三端收口 | 旧卡大多只完成当前端，Linux/macOS/Windows、IME、200% zoom、screen reader 和主题/DPI 仍分散未验证。 | 019 组合收口，不把当前端结果外推到三端。 |
| 代码洞察弹层 | 补全、Quick Doc、Parameter Info、Alt+Enter、错误 tooltip 各自由 CodeMirror/provider 组件呈现；无 provider 时补全回退为缓冲区单词、Quick Doc/Alt+Enter 只写状态栏。 | 020 统一弹层外观、键盘、无 provider 态。 |
| 右键菜单 | 编辑器菜单由 `editorContextMenu.ts` 平铺构建，tab 菜单在 `EditorGroup.tsx:582` 硬编码；顺序、分组、子菜单、助记符、禁用态与 IDEA 不同。 | 021 统一菜单模型与可用态。 |
| gutter 与标记 | 只有行号和折叠；无 VCS 变更条/行内 diff、运行图标、error stripe、用法高亮、参数 inlay、默认 import 折叠。 | 022 补齐编辑器边缘标记。 |

2026-09-29 复核另确认 5 个源码级缺陷，归入已有卡的首个切片：弹层 Esc 焦点落 `BODY`（012）、`Ctrl+Shift+A` 未注册且按键落入编辑器（013）、Search Everywhere All 结果与查询无关且外露 provider 诊断（014）、Problems 在服务不可用时显示 “No problems”（015）、`F12` 与 IDEA 默认值冲突（013）。证据与行号见[控件级复核摘要](references/idea-control-audit-20260929.md#复核结论摘要)。

## 4. 设计决定

| DEC | 决定 | 状态 | 依据 | 影响 |
|---|---|---|---|---|
| DEC-ALIGN-01 | 新批次使用独立任务板，不重开旧 `ED-PARITY-001..009`。 | agent 自决 | 旧板 done 只代表首包，整体矩阵仍大量待验证。 | 任务 010–019；避免状态混淆。 |
| DEC-ALIGN-02 | 以 IDEA 2026.2.2 / IU-262.10315.125 作为本批次初始参照，版本/主题/平台写入每张卡。 | agent 自决 | 本次真实窗口与历史主要参照版本一致。 | 010–019；更换版本需新参照修订。 |
| DEC-ALIGN-03 | 先对齐代表性编辑器 profile 和正常/选中/失焦/禁用/加载/失败/取消状态，再扩展主题和 DPI。 | agent 自决 | 全组合会掩盖交互风险，现有实测只覆盖代表 profile。 | 010、011、019。 |
| DEC-ALIGN-04 | 保留现有保存、dirty、undo、取消、恢复和 workspace owner 契约；允许重做布局和组件。 | 用户已授权 UI 重构，AGENTS 与 parity skill 明确允许 | UI 可以重构，数据和恢复契约必须保留。 | 全部任务；回归证据与新目标同等重要。 |
| DEC-ALIGN-05 | 首批不扩展到全部 IDEA 插件生态和所有语言；遇到具体需求再新增分母和任务。 | agent 自决 | 旧总评估已明确 45 场景不是无限插件覆盖。 | 016、019 的范围边界。 |
| DEC-ALIGN-06 | 视觉比较使用两个固定 profile：A = IDEA 当前用户设置（深色 UI、浅色编辑器、Source Code Pro 16px）对 Taomni 同字体同字号；B = 双方出厂默认。几何只在同 profile 内比较。 | agent 自决 | 本轮两侧字号 16/13px、行距 28/20px 不同，直接比像素无意义。 | 010、011、019。 |
| DEC-ALIGN-07 | 默认 keymap 以 IDEA 当前平台默认值（Linux/Windows XWin/Default，macOS macOS）为准；与 VS Code 习惯冲突时（如 `F12`）按 IDEA 语义，旧绑定作为可选 scheme 保留。 | agent 自决，可被用户推翻 | 用户目标是“快捷键与 IDEA 对齐”。 | 013、014、010。 |
| DEC-ALIGN-08 | 选区 AI 工具条不在 Find/导航/双击产生的选区上自动出现，也不遮挡代码行；入口保留在 Alt+Enter、右键菜单和显式快捷键。是否完全移除自动出现由用户决定。 | 待用户确认 | IDEA 无此元素；实测它在 Find Esc 后立即覆盖上一行。 | 011、012、021。 |
| DEC-ALIGN-09 | 无 provider 时不显示伪装的成员补全、空 Problems 或只写状态栏；统一显示 typed unavailable popup/空态，并给出原因和“配置/重试”入口。缓冲区单词补全只保留给显式 `Alt+/`（Cyclic Expand Word）。 | agent 自决 | 实测单词列表在 `calculator.` 处出现，Problems 显示 “No problems”。 | 015、020。 |
| DEC-ALIGN-10 | Go to File/Search Everywhere/Recent Files 打开的文件为正式 tab；preview tab 只由项目树单击产生，与 IDEA “Enable preview tab” 行为一致。 | agent 自决 | 实测第二次 Go to File 替换了第一次打开的文件。 | 011、014。 |
| DEC-ALIGN-11 | 任何弹层、对话框和工具窗 Esc/取消后必须把焦点交回打开它之前的编辑器 view（不存在时交回活动编辑器）；这条是所有卡共享的阻断级交互合同。 | agent 自决 | 实测 5 处 Esc 后焦点落 `BODY`。 | 012 负责实现，其余卡回归。 |

## 5. 交互和 UI 总体合同

### 壳层

以 IDEA 的左侧 Project、编辑器主区、左右 tool rail、底部工具窗口和状态栏为参照。Taomni 可以保留应用级导航和 Tao 入口，但 workspace 内部必须让 editor 成为主上下文。折叠、resize、恢复和切换不卸载 editor view，不清空 Problems、Search、Terminal、Run、Debug 或 Git 数据。

### 焦点与快捷键

每个动作先判断真实 owner：编辑器、输入框、树、工具窗、弹层、终端、IME。`Enter`、`Tab`、`Esc`、`Ctrl/Cmd`、`AltGr` 和 repeat 事件必须在该 owner 内消费；迟到响应只能更新仍然有效的 request/generation。取消要说明是否零副作用，提交后失败要展示真实效果和恢复入口。

### 状态

每个任务至少覆盖 ready、loading、empty、unavailable、failed、cancelled、dirty、read-only 和恢复路径中实际适用的状态。状态文案、禁用、role/name/state、焦点环、滚动和边缘翻转独立记录，不能用截图推断数据或 provider 语义。

### 视觉

比较窗口客户区、DPR、主题、UI 字体、代码字体、字号、行高和 keymap。保留完整原图和几何测量；像素差只作为诊断，不设无依据的统一相似度百分比。需要接受差异时在对应 DEC/AC 明确记录。

## 6. 任务交接

<a id="ed-parity-010"></a>
### ED-PARITY-010

- 交付：workspace chrome 与 IDEA profile 的布局和工具窗状态。
- 主要文件：`MainLayout.tsx`、`CodeWorkspaceTab.tsx`、`BottomDock.tsx`、`codeWorkspaceStore.ts`、`workspaceLayoutPersistence.ts`、`toolWindowRegistry.ts`、相关 CSS/token。
- 必须保留：editor leaf、dirty、工具数据、workspace owner、旧布局读取和恢复。
- 依赖：当前有效 shell 设计；与 011 集成。
- 2026-09-29 复核细化（[参照](references/idea-control-audit-20260929.md#shell)）：
  - 增加 workspace 左/右 tool rail（图标 + 截断标签，选中蓝底），至少承载 Project、Commit、Structure、Terminal、Problems、Git；底部 dock 从“9 个文本 tab”改为工具窗模型，允许侧窗与底窗同时打开。
  - 工具窗头部统一为 标题 + 子标签 + `⋮` + `—`；`Alt+数字` 再按隐藏；新增 `Shift+Esc` 隐藏当前工具窗、`Ctrl+Shift+F12` 隐藏全部。
  - 空编辑器改为 IDEA 式快捷提示列表（显示当前 keymap 的真实绑定）。
  - workspace 头部工具栏降到 IDEA 主工具栏的信息分组：项目/根、VCS 分支、运行配置 + Run/Debug、搜索、设置；缩放/换行/列选择/inlay/blame/tab policy 移入 `⋮` 或 View 菜单，SDK/Facts 状态移入状态栏 widget。
  - 编辑器状态栏段与应用状态栏分离：左侧导航栏（路径 + 类/方法），右侧 `行:列 (N chars)`、换行符、编码、缩进、只读锁；禁止截断成 `Spaces: 2 (Aut`。
- 完成条件：A1–A4、browser/native/accessibility/IDEA comparison 证据齐全，当前端真机完成，其他端明确未验证。
- P1 设计：[ed-parity-010-shell-design.md](ed-parity-010-shell-design.md)。
- 验收：`ED-PARITY-010-A1`、`ED-PARITY-010-A2`、`ED-PARITY-010-A3`、`ED-PARITY-010-A4`。

<a id="ed-parity-011"></a>
### ED-PARITY-011

- 交付：editor tabs、breadcrumbs、通知、问题标记、字体/行高、split surface。
- 主要文件：`CodeWorkspaceTab.tsx`、`EditorGroup`、`CodeMirrorHost.tsx`、editor appearance profile、tab policy 组件。
- 必须保留：preview→正式、共享文档、分屏 selection/scroll、undo 和编码。
- 依赖：010 壳层尺寸与焦点 owner。
- 2026-09-29 复核细化（[参照](references/idea-control-audit-20260929.md#editor-surface)）：
  - tab：语言类型图标（可运行类带标记）、活动 tab 描边胶囊、错误文件名红色波浪线、溢出 `˅` 下拉；Go to File/Search Everywhere 打开正式 tab（DEC-ALIGN-10）。
  - 删除编辑器上方两条常驻条：“Language Server Degraded” 改为状态栏 widget + 一次性通知，文件大小/时间移出编辑区，问题计数与上下导航改为右上检查 widget（`❗n ⚠n ˄ ˅` / `Analyzing…` / ✓）。
  - breadcrumb 移到状态栏导航栏并包含类/方法层级；编辑器顶部不再单独占 20px。
  - 默认折叠 import 与单行方法体（对应 IDEA Code Folding 默认值），折叠标记只在 hover/当前块显示。
  - 选区 AI 工具条按 DEC-ALIGN-08 调整。
- P1 设计：[ed-parity-011-editor-surface-design.md](ed-parity-011-editor-surface-design.md)。
- 验收：`ED-PARITY-011-A1`、`ED-PARITY-011-A2`、`ED-PARITY-011-A3`、`ED-PARITY-011-A4`。

<a id="ed-parity-012"></a>
### ED-PARITY-012

- 交付：Find/Replace 和共享弹层的 focus/keyboard/recovery 状态机。
- 主要文件：`editorSearchPanel.ts`、`lspHyperlink.ts`、`CodeMirrorHost.tsx`、`WorkspacePopupsHost`、Search Everywhere。
- 必须保留：query、match selection、modifier hover、IME、取消零编辑和迟到隔离。
- 依赖：010/011 的 surface 和 owner。首个切片（焦点归还）不依赖 010/011，可先行交付。
- 2026-09-29 复核细化（[参照](references/idea-control-audit-20260929.md#find)）：
  - 首个切片（已确认缺陷）：`WorkspacePopupsHost` 的 Go to File、Recent Files、File Structure、Search Everywhere、Recent Locations、Quick Doc、Location Peek，以及 Keymap 对话框，关闭时把焦点交回打开前的编辑器 view（DEC-ALIGN-11）；当前 `CodeWorkspaceTab.tsx:21592/21607/21651` 只改 state。
  - Find 框补历史下拉、清除 `×`、多行切换、过滤漏斗；Replace 行补 Exclude、历史、多行；`Ctrl+R` 保持焦点在 Find 框；所有匹配统一高亮并在滚动条画刻度。
  - Go to Line 改为预填并全选 `行:列` 的小对话框（Enter/Esc/OK/Cancel），替换 CodeMirror 默认底部面板。
- P1 设计：[ed-parity-012-find-focus-design.md](ed-parity-012-find-focus-design.md)。
- 验收：`ED-PARITY-012-A1`、`ED-PARITY-012-A2`、`ED-PARITY-012-A3`、`ED-PARITY-012-A4`。

<a id="ed-parity-013"></a>
### ED-PARITY-013

- 交付：Keymap 设置、冲突列表、Cancel/Apply/Reset、平台绑定和输入保护。
- 主要文件：`workspaceActionRegistry.ts`、`workspaceActionHost.ts`、`KeymapSettingsDialog.tsx`、`workspaceKeymapScheme.ts`、runtime keymap。
- 必须保留：旧 scheme 读取、workspace owner、动作可发现性、编辑器/输入框/IME 隔离。
- 2026-09-29 复核细化（[参照](references/idea-control-audit-20260929.md#keymap)）：
  - 首个切片（已确认缺陷）：注册 `Ctrl+Shift+A` Find Action（Search Everywhere Actions 分类，含 `Assign Shortcut`）；任何未注册的 `Ctrl+Shift+字母` 不得把后续输入落到编辑器选区。
  - 按 DEC-ALIGN-07 迁移默认绑定：`F12` → Jump to Last Tool Window，`Alt+0/2/7/9`、`Shift+Esc`、`Ctrl+Shift+F12`、`Ctrl+Alt+S` 按 IDEA；旧绑定作为 “VS Code compatible” 可选 scheme，已有用户 scheme 读取不变。
  - 快捷键显示统一格式化：当前平台只显示当前平台绑定（Linux/Windows 不显示 `Meta+`），键帽拆分，方向键/Enter/Space 用本地化名称，Search Everywhere、Keymap、菜单、tooltip 共享同一格式化函数。
  - Keymap UI：分组树、按快捷键查找（含第二击）、默认方案首次修改自动派生、右键 Add Keyboard/Mouse Shortcut/Remove、录制对话框含 Second stroke；关闭后焦点归还（DEC-ALIGN-11）。
- P1 设计（DEC-013-*、细化断言、任务与用例）：[ed-parity-013-keymap-design.md](ed-parity-013-keymap-design.md)。
- 验收：`ED-PARITY-013-A1`、`ED-PARITY-013-A2`、`ED-PARITY-013-A3`、`ED-PARITY-013-A4`。

<a id="ed-parity-014"></a>
### ED-PARITY-014

- 交付：Project tree、Go to File、Search Everywhere、Recent/Back 和结果焦点。
- 主要文件：Project tree、Search Everywhere、Action Registry、editor navigation history。
- 必须保留：树选择不误开、preview policy、selection/caret/scroll 和 Back 恢复。
- 2026-09-29 复核细化（[参照](references/idea-control-audit-20260929.md#navigation)）：
  - 首个切片（已确认缺陷）：Search Everywhere All 分类按查询过滤并按 符号 → 文件/类 → 文本 → 动作 排序；与查询无关的动作不得出现；`Provider stale · generation · providers` 诊断移入 tooltip/调试视图，底栏改为选中项路径 + `Open In Right Split`。
  - Go to File/Search Everywhere 外框：约 IDEA 宽度、无模态遮罩；右侧 scope 下拉（Project Files/All Places）、预览开关、过滤；行显示类型图标、高亮、相对目录、模块列。
  - Recent Files 改为双列切换器：左侧工具窗（带 `Alt+数字`）+ Recent Locations，右侧文件，`Show edited only`（`Ctrl+E` 切换），底部完整路径。
  - File Structure 标题为文件名，提供 Inherited/Anonymous/Lambdas 开关、可见性图标、预选 caret 成员；无 provider 时用已有 tree-sitter Java 解析（Structural Search 后端）给出降级大纲并标注 “syntax only”。
  - Find in Files 改为浮动弹层（结果 + 下方可编辑预览 + scope 按钮 + File mask + `Open in Find Window`），底部 Search 工具窗作为 “Open in Find Window” 的目标。
  - 项目树：根节点显示模块名/路径，External Libraries 节点（有 SDK 时），顶层文件元数据，头部改为 Locate/Expand/Collapse/`⋮`/Hide，新建类动作移入 `+` 菜单。
- 验收：`ED-PARITY-014-A1`、`ED-PARITY-014-A2`、`ED-PARITY-014-A3`、`ED-PARITY-014-A4`。

<a id="ed-parity-015"></a>
### ED-PARITY-015

- 交付：Java provider readiness、Basic/Smart boundary、documentation、diagnostics 和错误恢复。
- 主要文件：completion adapters、LSP session/state、Problems、project facts/SDK 状态、Rust LSP error propagation。
- 必须保留：provider 原始 snippet 契约、一次接受/undo、无 provider 时 typed unavailable。
- 2026-09-29 复核细化（[参照](references/idea-control-audit-20260929.md#git-run)）：
  - 首个切片（已确认缺陷）：`panels/ProblemsPanel.tsx:176` 在 provider 不可用/加载/失败时显示对应 typed 状态和“配置/重试”，不再显示 “No problems in open files”；右上检查 widget（011）与 Problems 计数同源。
  - Problems 工具窗对齐 IDEA：File（带计数）/Project Errors 标签，按文件分组，行尾 `:行号`，左侧查看/快速修复/预览按钮。
  - 弹层外观与键盘交给 020；本卡保留 provider 就绪状态机、诊断/Problems 数据和恢复。
- P1 设计：[ed-parity-015-java-readiness-design.md](ed-parity-015-java-readiness-design.md)。
- 验收：`ED-PARITY-015-A1`、`ED-PARITY-015-A2`、`ED-PARITY-015-A3`、`ED-PARITY-015-A4`。

<a id="ed-parity-016"></a>
### ED-PARITY-016

- 交付：Structural Search 的 IDEA 风格 dialog、scope/modifier、结果树、空态、取消和导航。
- 主要文件：`StructuralSearchDialog.tsx`、`StructuralSearchPanel.tsx`、session、tree-sitter backend。
- 必须保留：Java AST 精确结果、注释/字符串排除、取消释放、编辑器字节不变。
- 验收：`ED-PARITY-016-A1`、`ED-PARITY-016-A2`、`ED-PARITY-016-A3`。

<a id="ed-parity-017"></a>
### ED-PARITY-017

- 交付：Rename/Extract/Safe Delete/format code action 的 preview、提交、取消、失败恢复和事务 undo。
- 主要文件：code action adapter、workspace edit transaction、preview surface、recovery ledger、shared consumers。
- 必须保留：dirty、外部修改、partial effect、owner/generation 和实际磁盘结果。
- 2026-09-29 复核细化（[参照](references/idea-control-audit-20260929.md#code-insight)）：IDEA 的 `Shift+F6` 为行内重命名（名称加框、候选名列表、注释/文本出现开关、`Alt+Shift+O` 选项提示），Extract Method 直接插入并进入行内命名，Esc 两次零修改撤回；本卡以此为交互目标，跨文件 preview 仍需补采 IDEA 参照。
- 验收：`ED-PARITY-017-A1`、`ED-PARITY-017-A2`、`ED-PARITY-017-A3`。

<a id="ed-parity-018"></a>
### ED-PARITY-018

- 交付：Git Changes/Diff、Run/Debug/Terminal 的工具上下文与返回编辑器体验。
- 主要文件：Git panels、DiffViewer、Run/Debug/Terminal tool windows、tool registry、Action Host。
- 必须保留：repo identity、session/output、取消零写入、迟到响应和 dirty selection。
- 2026-09-29 复核细化（[参照](references/idea-control-audit-20260929.md#git-run)）：
  - workspace 内提供 Commit 工具窗（`Alt+0`，左侧）：变更/未版本化复选树、工具条、Amend、多行消息、`Commit` 主按钮 + `Commit and Push…`；Git Log（`Alt+9`，底部）：分支树、文本/哈希过滤、Branch/User/Date 过滤、提交列表、详情。现有独立 Git 标签保留为 “Open in Git tab”。
  - Terminal 工具窗头部：会话 tab、`+`、`˅`、`⋮`、`—`，cwd 为活动根。
  - VCS 变更条弹层与运行 gutter 菜单由 022 提供，本卡提供其执行动作（Rollback、Show Diff、Commit this change、Run/Debug）。
- 验收：`ED-PARITY-018-A1`、`ED-PARITY-018-A2`、`ED-PARITY-018-A3`。

<a id="ed-parity-019"></a>
### ED-PARITY-019

- 交付：组合收口、三端可访问性/快捷键/缩放/主题验证和正式 IDEA comparison。
- 主要文件：各任务最终组合后的实际路径、QA cases、comparison records、feature catalog。
- 必须保留：三端构建兼容、当前端真机证据、其他端明确未验证；不把 browser 代替 native。
- 验收：`ED-PARITY-019-A1`、`ED-PARITY-019-A2`、`ED-PARITY-019-A3`。

<a id="ed-parity-020"></a>
### ED-PARITY-020

- 交付：补全列表、补全内文档、Quick Doc、Parameter Info、Intention/Quick Fix 列表、错误 tooltip 的统一弹层外观、键盘和无 provider 态。
- 参照：[控件级复核 §5](references/idea-control-audit-20260929.md#code-insight)，截图 `idea-09/10/11/12/13/36`、`taomni-09/11/12`。
- 主要文件：`CodeMirrorHost.tsx`（`buildAutocompletionConfig`、`override: [localSource, lspSource]`）、`lspCompletion.ts`、`QuickDocPopup.tsx`、code action adapter、诊断 tooltip、共享 popup 样式 token。
- 目标：
  - 补全：向下优先展开，行结构 类型图标 + 粗体名称 + 灰色签名 + 右侧类型；底栏 `Enter 插入 / Tab 替换`；补全内 `Ctrl+Q` 并排文档卡。
  - 无 provider：成员位置不显示单词列表，显示 “Java 语言服务不可用 · 配置” 单行 popup（DEC-ALIGN-09）；`Alt+/` 保留单词补全。
  - Quick Doc/Alt+Enter/Parameter Info 在任何状态都弹出 popup；无结果时 popup 内显示 “No documentation found.” / typed unavailable，不只写状态栏。
  - Intention 列表：灯泡 gutter 图标、每项子菜单 `⋮`、右侧差异预览（`Ctrl+Q` 切换）。
  - 错误 tooltip：`Required type / Provided` 结构、首选修复链接 + 快捷键 + More actions。
- 必须保留：provider snippet、一次接受/undo、resolve gate、IME、迟到响应隔离（旧 005 契约）。
- 依赖：011（surface token）、013（快捷键显示格式）；provider 就绪由 015 负责，native provider 态需 JDT LS fixture。
- 验收：`ED-PARITY-020-A1`、`ED-PARITY-020-A2`、`ED-PARITY-020-A3`。

<a id="ed-parity-021"></a>
### ED-PARITY-021

- 交付：编辑器、编辑器 tab、项目树、工具窗 tab 的右键菜单模型、顺序、分组、子菜单、助记符和可用态。
- 参照：[控件级复核 §6](references/idea-control-audit-20260929.md#menus)，截图 `idea-15/16/49`、`taomni-15/16`。
- 主要文件：`editorContextMenu.ts`、`EditorGroup.tsx`（`showTabMenu`）、项目树菜单、共享 `MenuItem`/菜单组件、Action Registry 可用态。
- 目标：
  - 编辑器菜单以 `Show Context Actions` 置顶，按 IDEA 分组：剪贴板（Paste、Copy/Paste Special ›、Column Selection Mode）/ 导航（Find Usages、Go To ›）/ Folding ›、Analyze › / Rename…、Refactor ›、Generate… / Open In › / Local History ›、Git › / Compare with Clipboard；Go to Definition/Declaration/Type/Implementation 移入 Go To ›；AI 项集中到一个 AI › 子菜单放在末组。
  - tab 菜单顺序按 IDEA：Close 组 → Copy Path/Reference… → Split Right/Split and Move Right/Split Down/Split and Move Down → Pin Tab、Configure Editor Tabs… → Bookmarks › → Open In › → Local History ›、Git › → Rename File…；单 tab 时 Close Other Tabs 禁用。
  - 所有菜单项有助记符、快捷键来自 013 的格式化函数、可用态来自同一 Action Registry 判定；菜单在视口内翻转，不压到状态栏。
  - 项目树菜单本轮未采样，P1 先补采 IDEA 参照。
- 必须保留：现有菜单动作的执行路径、prepared evaluation 冻结、调试/AI 入口可发现性。
- 依赖：013。
- 验收：`ED-PARITY-021-A1`、`ED-PARITY-021-A2`、`ED-PARITY-021-A3`。

<a id="ed-parity-022"></a>
### ED-PARITY-022

- 交付：gutter 与滚动条边缘标记：VCS 变更条 + 行内 diff 弹层、运行/调试 gutter 图标 + 菜单、重写/实现图标、灯泡、error stripe（错误/警告/TODO/查找/用法刻度）、caret 标识符用法高亮、参数名 inlay、默认折叠。
- 参照：[控件级复核 §2、§8](references/idea-control-audit-20260929.md#editor-surface)，截图 `idea-03/04/06/28/30/37`。
- 主要文件：`CodeMirrorHost.tsx` gutter 扩展、git diff 数据（018 已有多仓库 diff 隔离）、run target facts（`workspace_java_run_targets`）、inlay/semantic token adapter、fold 配置。
- 目标：
  - VCS 条：新增绿、修改蓝、删除灰三角；点击弹出行内 diff：上一处/下一处、Rollback、Show Diff、Copy、`Commit this change` 输入框；Rollback 为一次可撤销编辑。
  - 运行图标：有 main/test 的类和方法显示绿色三角，点击菜单 Run/Debug/Run with Coverage/Modify Run Configuration…；无 facts 时不显示。
  - error stripe：右侧 8px 条，刻度可点击跳转，与右上检查 widget 同源。
  - caret 停在标识符上 300ms 后高亮全部读/写用法（provider 可用时语义，不可用时不做文本冒充）。
  - 参数名 inlay 与 Code Vision 分开：本卡只做参数名 inlay；Code Vision 不在本批次。
- 必须保留：现有折叠、断点 gutter、调试行标记、blame 开关、性能（大文件 gutter 更新预算）。
- 依赖：011、018（Git 数据与执行动作）、015（语义数据）。
- 验收：`ED-PARITY-022-A1`、`ED-PARITY-022-A2`、`ED-PARITY-022-A3`。

## 7. 验收条件

### ED-PARITY-010

- **ED-PARITY-010-A1**：在匹配的 IDEA profile 下，Project/editor/左右 rail/bottom/status 的层级、尺寸、密度、选中/失焦/禁用状态分别有实测对照；未接受差异不得隐藏。
- **ED-PARITY-010-A2**：Project、Problems、Search、Run、Terminal 等工具窗的打开、折叠、resize、恢复和返回 editor 的焦点与数据连续可观察。
- **ED-PARITY-010-A3**：布局切换、窗口缩放、workspace 切换和重载不卸载 editor view，不丢 dirty、selection、undo、工具输出或 provider session。
- **ED-PARITY-010-A4**：左右 tool rail、`Alt+1/0/6/7/9/F12` 开关、`Shift+Esc`/`Ctrl+Shift+F12` 隐藏、空编辑器快捷提示、状态栏导航栏与 `行:列 (N chars)` 均按[复核 §1](references/idea-control-audit-20260929.md#shell)逐项对照；侧窗与底窗可同时打开且各自保留尺寸。

### ED-PARITY-011

- **ED-PARITY-011-A1**：editor tab、breadcrumb、通知、问题标记、代码字体/行高和滚动标记在正常、选中、失焦、只读状态下与 IDEA 分别比较。
- **ED-PARITY-011-A2**：preview→正式、双视图、关闭非最后 view、selection/scroll 和共享编辑保持现有契约，并且入口焦点符合目标流程。
- **ED-PARITY-011-A3**：编辑器 surface 重构后，保存、编码/EOL、dirty、一次 undo/redo 和外部冲突恢复保持真实字节结果。
- **ED-PARITY-011-A4**：编辑区顶部没有常驻降级/文件信息条；检查 widget 显示 `Analyzing…`/计数/✓ 三态；Go to File 连开三个文件得到三个正式 tab；import 与单行方法默认折叠；选区 AI 工具条行为符合 DEC-ALIGN-08。

### ED-PARITY-012

- **ED-PARITY-012-A1**：Ctrl/Cmd+F、Replace、Enter、Shift+Enter、Tab、Esc 和外部点击的焦点、selection、锚点和关闭结果与 IDEA 对照。
- **ED-PARITY-012-A2**：查找无结果、加载、错误、取消、重复打开、分屏和 IME 状态有明确反馈，不穿透到 editor/tree/terminal。
- **ED-PARITY-012-A3**：迟到 query/provider 响应不会恢复已取消 owner、覆盖新 query 或改变文件字节；既有 modifier hover/clipboard/导航保留。
- **ED-PARITY-012-A4**：从编辑器打开 Go to File、Recent Files、Recent Locations、File Structure、Search Everywhere、Quick Doc、Location Peek、Keymap 对话框、Go to Line 后按 Esc，`document.activeElement` 为打开前的同一 `.cm-content`，caret/selection 不变；`Ctrl+R` 后焦点仍在 Find 框；Find 栏含历史、清除、多行、过滤、Exclude。

### ED-PARITY-013

- **ED-PARITY-013-A1**：Action Registry、Keymap UI 和实际派发对同一动作显示相同标题、绑定、可用条件和 owner；冲突列出全部冲突来源。
- **ED-PARITY-013-A2**：改键的录制、冲突提示、Apply/Cancel/Reset、重开持久化和默认 scheme 迁移在 IDEA/Taomni 中逐项有结论。
- **ED-PARITY-013-A3**：Windows Ctrl、macOS Cmd、Linux Ctrl、AltGr、IME、repeat、编辑器/输入框/终端保护均有真实入口证据，不能只用 registry 静态检查代替。
- **ED-PARITY-013-A4**：`Ctrl+Shift+A` 打开 Find Action 且不修改编辑器文本；[复核 §7 绑定差异表](references/idea-control-audit-20260929.md#keymap)中每个键的默认动作与 IDEA XWin 一致或有 DEC 记录；所有快捷键显示点不再出现 `ARROWLEFT`/`ENTER`/`SPACE` 原始键名，Linux/Windows 不显示 `Meta+` 绑定。

### ED-PARITY-014

- **ED-PARITY-014-A1**：项目树选择、展开、单击/双击/Enter、preview policy 和取消行为与 IDEA 的焦点和打开结果一致。
- **ED-PARITY-014-A2**：Go to File、Search Everywhere、Recent Files、Go to Symbol 和 Back 的结果、过滤、预览、键盘导航、Esc 和编辑器返回焦点可复现。
- **ED-PARITY-014-A3**：真实 provider 不可用、空结果、迟到响应、切 workspace/file 和 dirty buffer 时不丢 selection、scroll、文本或历史位置。
- **ED-PARITY-014-A4**：Search Everywhere 查询 `total` 时 All 分类不含标题与查询无关的动作，符号/文本命中排在动作之前，底栏无 provider/generation 诊断；Recent Files 为双列并支持 `Show edited only`；File Structure 在无 provider 时给出 syntax-only 大纲；Find in Files 弹层带可编辑预览。

### ED-PARITY-015

- **ED-PARITY-015-A1**：Java SDK/JDT LS/facts ready、loading、degraded、unavailable、timeout、failed 和恢复状态有准确文案、禁用和重新尝试入口。
- **ED-PARITY-015-A2**：Basic Completion 的候选布局、接受、snippet、import、documentation、Tab/Esc 和 undo 与 IDEA 分别比较；Smart/Type-Matching 未支持时 typed unavailable。
- **ED-PARITY-015-A3**：诊断、Problems、quick fix、resolve 失败和 provider 错误不会被伪装成空结果；文件、dirty 和错误恢复保持真实结果。
- **ED-PARITY-015-A4**：打开含类型错误的 `Main.java` 且语言服务不可用时，Problems 显示 unavailable 原因与配置/重试入口而非 “No problems”；服务就绪后同一文件显示 1 错误 1 警告，Problems 按文件分组并带 `:行号`，与检查 widget 计数一致。

### ED-PARITY-016

- **ED-PARITY-016-A1**：Structural Search 的入口、Java/template 编辑器、变量、语言、scope 和 modifier 控件与 IDEA 对照，首包 AST 结果仍准确排除注释/字符串/反例。
- **ED-PARITY-016-A2**：3/1/0 结果、结果树展开、预览/导航、高亮、空态、错误和取消的功能、交互、视觉结论分别记录。
- **ED-PARITY-016-A3**：取消和关闭释放 parser/request；普通 Find、编辑器文本、字节、dirty 和其他底部工具窗不受影响。

### ED-PARITY-017

- **ED-PARITY-017-A1**：Rename/Extract/Safe Delete/format code action 的入口、候选/preview、冲突、确认、取消、失败和返回编辑器流程与 IDEA 分别比较。
- **ED-PARITY-017-A2**：跨文件修改显示完整受影响文件和实际 preimage/postimage；提交只产生一笔事务历史，Undo/Redo 结果与磁盘字节一致。
- **ED-PARITY-017-A3**：dirty、外部修改、provider timeout、late response、partial effect、close/reopen 和 recovery 均不会盲目覆盖或伪装成零效果。

### ED-PARITY-018

- **ED-PARITY-018-A1**：Git Changes/Diff 的 repo、branch、path、HEAD/WORKTREE、hunk、工具窗位置和返回 editor 体验与 IDEA 分别记录。
- **ED-PARITY-018-A2**：Run/Build/Debug/Terminal 的配置、输出、Stop/Cancel、焦点、工具窗保留和返回 editor 入口与 IDEA 对照；无 provider 时显示 typed unavailable。
- **ED-PARITY-018-A3**：切 repo、切 workspace、关闭/取消、迟到响应不污染其他 repo/session，不产生未授权 Git 写入，不丢 dirty/selection/output。

### ED-PARITY-019

- **ED-PARITY-019-A1**：所有已交付卡的功能、交互、快捷键和 UI comparison record 均能追溯到相同 fixture/profile，`unverified` 与 `different` 单独保留。
- **ED-PARITY-019-A2**：Windows WebView2、macOS WKWebView、Linux WebKitGTK 分别记录快捷键、IME、焦点、200% zoom、role/name/state、主题和窗口恢复结果。
- **ED-PARITY-019-A3**：当前端必要 native、browser、unit/typecheck/provider/accessibility 检查通过且无已知代码不兼容；其他端未执行项有后续步骤，不冒充三端通过。

### ED-PARITY-020

- **ED-PARITY-020-A1**：provider 就绪时，`calculator.` 补全、补全内 `Ctrl+Q`、`Ctrl+Q`、`Ctrl+P`、`Alt+Enter`、错误悬停的弹层结构、位置（向下优先、视口翻转）、行内容和底栏提示与[复核 §5](references/idea-control-audit-20260929.md#code-insight)逐项对照。
- **ED-PARITY-020-A2**：provider 不可用/加载/失败时，成员位置不出现缓冲区单词列表；Quick Doc、Parameter Info、Alt+Enter 均弹出含原因的 popup，Esc 后焦点与选区不变；`Alt+/` 仍可单词补全。
- **ED-PARITY-020-A3**：接受补全、应用 intention 后一次 `Ctrl+Z` 回到原字节；迟到的 provider 结果不会在已关闭或已换位置的弹层上出现；IME 组合期间不弹出/不接受。

### ED-PARITY-021

- **ED-PARITY-021-A1**：编辑器与 tab 右键菜单的顺序、分组、子菜单、助记符、快捷键文本与[复核 §6](references/idea-control-audit-20260929.md#menus)逐项对照，差异有 DEC 记录。
- **ED-PARITY-021-A2**：每个菜单项的可用态与同一 Action Registry 判定一致（例如单 tab 时 Close Other Tabs 禁用，无 provider 时导航项与 Find Usages 同为 unavailable 并显示原因）；菜单完整位于视口内。
- **ED-PARITY-021-A3**：菜单执行路径不变，prepared evaluation 冻结行为和 AI/调试入口可发现性保留；键盘打开（`Shift+F10`/菜单键）与 Esc 关闭后焦点回到原 owner。

### ED-PARITY-022

- **ED-PARITY-022-A1**：在含工作区改动的 git fixture 中，变更条类型、颜色、点击弹层按钮与 IDEA 对照；Rollback 为一次可撤销编辑，Show Diff 打开 018 的 diff。
- **ED-PARITY-022-A2**：运行图标、error stripe 刻度、caret 用法高亮、参数名 inlay、默认折叠在 provider/facts 就绪与不可用两种状态下分别有结论；不可用时不显示伪造标记。
- **ED-PARITY-022-A3**：断点 gutter、调试行、blame、现有折叠与大文件滚动性能不回退；gutter 更新不产生文本编辑或 dirty。

## 8. 验证计划

| V | 适用任务 | 检查 |
|---|---|---|
| V-ALIGN-01 | 010/011 | 相同 1400×1000 profile，记录 Project/editor/bottom/rail/tab/breadcrumb/notification 几何、字体、焦点和状态截图。 |
| V-ALIGN-02 | 012/013/014 | 逐一执行 Ctrl/Cmd+F、Enter、Shift+Enter、Esc、Ctrl/Cmd+Shift+N、Shift+Shift、Ctrl/Cmd+B、Keymap 冲突录制；记录 active element、selection、result、console 和取消。 |
| V-ALIGN-03 | 015/016 | 使用明确 JDK/JDT LS 的隔离 Java fixture；分别执行 ready/loading/unavailable/error/cancel、completion、diagnostic、SSR 3/1/0 结果。 |
| V-ALIGN-04 | 017/018 | 使用隔离多文件/Git/Run fixture；检查 preview、跨文件字节、repo identity、session/output、取消、undo 和回编辑器。 |
| V-ALIGN-05 | 019 | 当前平台 native 完成一次组合验证；Windows/macOS/Linux 分别记录平台快捷键、IME、200% zoom、a11y role/name/state 和未执行项。 |
| V-ALIGN-06 | 全部 | `compare_idea.py` 校验记录后人工审阅功能、交互、视觉三列；`unverified` 不转 matched。 |
| V-ALIGN-07 | 012/013/014/021 | 焦点归还矩阵：对每个弹层/对话框/菜单执行“从编辑器打开 → Esc/Cancel”，断言 `document.activeElement` 与 selection；native 用真实键盘重复一次（browser 合成事件对 CodeMirror 面板不可靠，见复核边界）。 |
| V-ALIGN-08 | 015/020/022 | 同一 Java fixture 分别在 browser（无 provider）与 native JDT LS ready 下截图补全、Quick Doc、Alt+Enter、Problems、gutter，分别写 unavailable 与 ready 两列结论。 |
| V-ALIGN-09 | 013/021 | 快捷键显示审计：扫描 Search Everywhere、Keymap、菜单、tooltip 渲染文本，不得出现全大写原始键名或非当前平台修饰键。 |

## 9. 风险与未决项

- IDEA 当前窗口为 Linux X11，不能直接推出 Windows WebView2 或 macOS WKWebView 的系统快捷键和字体栅格结果。
- Taomni browser preview 当前显示 Java language server unavailable / Facts Failed；必须取得 JDK/JDT LS ready fixture 才能比较语言服务正常态。
- 任务 010 和 011 可能同时触碰共享布局和 editor surface，P1 必须明确共享文件 owner，集成由 019 负责。
- 本次只读采样的隔离 Java 文件已恢复原始 SHA-256；后续任何 native 验证都必须使用新的隔离目录，不得使用用户工程。
- `CodeWorkspaceTab.tsx` 当前 22,208 行，010/011/012/014 都会触碰它；P1 需为每张卡划定可抽出的子组件（popup 焦点归还、状态栏段、tool rail），避免多卡同时改同一大文件的同一区域。
- DEC-ALIGN-08（选区 AI 工具条）需要用户确认；确认前 011 只能做“不在 Find/导航选区上出现、不遮挡代码”，不能删除入口。
- DEC-ALIGN-07 会改变现有用户的肌肉记忆（`F12`）；迁移必须保留旧 scheme 并在首次启动提示，不能静默覆盖用户自定义 scheme。
- 2026-09-29 复核的 Taomni 侧只有 browser 证据；gutter、Git、运行、补全/诊断 ready 态全部待 native。

## 10. 交付门槛

设计完成只表示任务可继续细化。每张卡需在同一卡内完成 AC、测试用例、实际 evidence、平台边界和 IDEA comparison；当前端通过后可结束本轮当前端交付，Windows/macOS/Linux 未运行项必须保留。整体“与 IDEA 对齐”只能在 019 汇总所有受影响场景的三维结果后判断。
