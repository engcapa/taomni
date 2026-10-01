# ED-PARITY-026 第三轮细节对齐设计

来源：2026-10-01 用户反馈（第二轮之后）——(1) 之前说的弹窗其实是 Ctrl+Shift+N / Ctrl+N，IDEA 中可用左右方向键切 tab；(2) 鼠标悬浮出现的文档弹窗，鼠标移上去时希望停留，但会很快消失；(3) Project 树要做成 IDEA 的样式（截图红框：标题栏 + / ⊕ / 展开 / 折叠 / ⋮ / −）；(4) 左侧工具窗口条如何与 Taomni 主窗口左侧栏融合（或让主侧栏自动隐藏），先给方案评审。参照 IDEA Ultimate 2026.2.2（IU-262.10315.125），证据来自 IDEA jar 的 keymap XML、action XML 与字节码（`javap`）。

<a id="ed-parity-026"></a>

## A1 Search Everywhere 的切换与分组按键

**IDEA 事实（字节码）**：`SearchEverywhereUI.initSearchActions` 注册了
`SearchEverywhere.NextTab` / `PrevTab`（Tab / Shift+Tab）、平台动作 `NextTab` / `PreviousTab`
（Default for XWin 为 Alt+Right / Alt+Left；macOS 键位为 Ctrl+Right / Ctrl+Left 与 Cmd+Shift+] / [）、
`Switcher`（Ctrl+Tab，按住 Shift 为上一个）以及 `SearchEverywhere.NavigateToNextGroup` / `PrevGroup`
（PageDown / PageUp、Ctrl+Down / Ctrl+Up，`MixedSearchListModel.getIndexToScroll` 返回最后/第一个结果）。
普通 Left/Right 仍在输入框里移动光标。第二轮文档中“方向键不切换”只对不带修饰键的方向键成立，本轮更正为上面的完整集合。

- ED-PARITY-026-A1 Ctrl+N / Ctrl+Shift+N 打开的 Search Everywhere 支持上述全部切换键（按平台映射），PageUp/PageDown 与 Ctrl+Up/Down 跳到第一个/最后一个结果；重新打开时查询为空且在同一次渲染里生效（修复 macOS CI 上 `TC-IDE-PARITY-013-04` 重开后保留旧查询导致输入叠加）。
- 实现：`QuickPickOverlay` 的 `searchEverywhereTabDirection`（平台映射）与 `groupNavigation`；打开时在渲染阶段重置查询，不再只依赖 effect。
- V：单元 `SearchEverywhere.test.tsx`；`TC-IDE-PARITY-026-01`（browser 三端，macOS 使用 Ctrl+Right/Cmd+Shift+]）、`TC-IDE-PARITY-026-02-search-everywhere-keys-native`（native 三端）。

## A2 悬停文档弹窗停留

**IDEA 事实**：`EditorMouseHoverPopupManager` 在指针仍位于悬停元素上、停在弹窗内或正朝弹窗移动（`MouseMovementTracker.isMovingTowards`）时保留弹窗；指针去往别处后才关闭；点进弹窗（获得焦点）后弹窗保持到 Esc 或焦点离开。
**Taomni 根因**：CodeMirror `hoverTooltip` 在 tooltip 只有 `pos` 时，指针一离开该字符（`posAtCoords != pos`）就关闭；从文字移向弹窗必然经过其他字符，所以弹窗“很快消失”。

- ED-PARITY-026-A2 自研 `hoverDocTooltip`：悬停范围为整个单词；朝弹窗方向移动（射线与弹窗矩形相交）或位于单词/弹窗上时保持；否则按悬停延迟换算的宽限期（150–500 ms）后关闭；弹窗获得焦点后不自动关闭；编辑器内 Esc 先关闭弹窗；文档变化或选区变化时关闭（与原 hideOnChange 相同）；拖拽缩放期间不关闭；Pin 行为不变。
- 浏览器验证依赖 B-005 受控 Java 提供方：`taomni.qa.parity005.hover=true` 时其文档状态声明 hover 能力，`lsp_hover` 返回单词文档。新增 runner 动词 `mouse_path`（browser 用 `page.mouse.move(steps)`，native 用 W3C 元素原点 `pointerMove`）以产生经过相邻字符的连续移动。
- V：单元 `hoverDocTooltip.test.ts`；`TC-IDE-PARITY-026-03`（browser 三端：朝向移动保留、离开关闭、Esc、点进后保持、Pin）、`TC-IDE-PARITY-026-04-hover-doc-native`（native 三端，真实 JDT LS 悬停）。

## A3 Project 工具窗口头部与树样式

**IDEA 事实**：`ProjectViewToolbar` = SelectInProjectView、ExpandAll、CollapseAll，新 UI 另有 New（+）；标题左侧是视图选择器（Project ▾）；⋮ 为 `ProjectView.ToolWindow.SecondaryActions`（Behavior / Appearance / Sort 子菜单 + 工具窗口选项）；Appearance 含 Compact Directories 与 Details（`ViewInplaceComments`，文件名后显示修改时间与大小）；树没有常驻过滤框，键入即速搜；项目根名后显示路径；文件夹图标为线条灰色。

- ED-PARITY-026-A3 单行标题栏：Project ▾（Project / Project Files）| New（+：File、Directory、Open File…、Add Folder to Workspace…）、Select Opened File、Expand All（窄宽度时折入 ⋮）、Collapse All、Options（⋮：Appearance › Details / Compact Directories / Zoom，Rename… / Delete…，工具窗口选项）、Hide（−）。删除第二行过滤/视图/缩放条；在树中键入可打印字符或 Ctrl+F 打开速搜（沿用过滤语义），Esc 或 × 清空关闭；根节点名后显示路径、文件夹图标改为灰色线条；空工作区显示 Add Folder… / Open File… 入口。
- 兼容：`code-workspace-tree-new-file` 等 testid 保留在 New 菜单项上；22 个既有用例在点击这些菜单项前插入 New（+）点击（`ruamel.yaml` 往返改写并重排 verification 步号，语义校验脚本确认 checkpoint 与步骤一致）。
- V：单元 `FileTreePane.test.tsx`、`treeToolbarChrome.test.ts`、`CodeWorkspaceTab.test.tsx`；`TC-IDE-PARITY-026-05`（browser 三端）、`TC-IDE-PARITY-026-06-project-header-native`（native 三端，宿主文件大小 14 B）。

<a id="prop-026-01"></a>

## PROP-026-01（待评审，未实现）左侧工具窗口条与 Taomni 主侧栏

现状：主布局左侧是可折叠的 Sidebar 面板（默认 22%，折叠后为 30 px 的 `collapsed-sidebar-rail`）；Code Workspace 内部还有 IDEA 式左工具窗口条（约 40–59 px）。主侧栏展开时，编辑区左边同时有主侧栏 + 工具条 + Project 窗口；折叠时也有两列竖条。

| 方案 | 做法 | 优点 | 代价/风险 |
| --- | --- | --- | --- |
| A 自动折叠 | 激活 Code Workspace 标签时把主侧栏折叠为 30 px 轨道，切回其它标签恢复用户原宽度；用户在工作区里手动展开后，该选择对工作区标签记忆 | 改动小（MainLayout 订阅活动标签类型）；不影响主侧栏功能 | 仍有两列竖条（30 px + 工具条）；切标签时侧栏宽度跳变 |
| B 合并为一条（推荐，与 A 组合） | 主侧栏处于轨道态且活动标签是 Code Workspace 时，工作区把自己的左工具窗口条通过 portal 挂进主轨道（分隔线以下，上组 Project/Structure…，下组 Terminal/Problems/Git…），工作区内不再渲染左条；主侧栏展开时自动还原到工作区内 | 只剩一列竖条，与 IDEA 一致；复用 ED-PARITY-024 的可重挂载宿主 | 需要 MainLayout 提供轨道宿主注册；多工作区标签切换时只挂活动实例；拖放与右键菜单（Move to/Show names）需在轨道内同样可用；轨道宽度需随“显示名称”变化 |
| C 完全隐藏 + 边缘唤出 | 工作区标签下主侧栏宽度为 0，左边缘 4 px 热区或快捷键临时以浮层展开（不挤压编辑区） | 编辑区最大 | 会话/工具入口不可见，可发现性差；浮层与工具窗口的焦点与 Esc 交互需额外设计 |

建议：B + A。默认开启“Code Workspace 中折叠主侧栏并合并工具窗口条”，设置里可关闭（关闭后回到现状）。实现顺序：① MainLayout 轨道宿主 + 活动标签类型订阅（A）；② 工作区左条 portal 到宿主并处理多实例/展开还原（B）；③ 右键菜单、拖放、显示名称宽度；④ 用例：browser + native 三端验证切换标签时宽度恢复、条按钮激活/移动工具窗口、展开主侧栏后条回到工作区。**需用户确认方案后再实施。**

## 未覆盖与后续

- IDEA Project 视图的 Packages / Open Files / Scratches 等其它视图、Behavior 与 Sort 子菜单、文件类型图标与源根着色未做。
- 悬停弹窗的“朝向判断”不含 IDEA 的时间衰减；调试值悬停（debugEditorChrome）仍用 CodeMirror 默认行为。
