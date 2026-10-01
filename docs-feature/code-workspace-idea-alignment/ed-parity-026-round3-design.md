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

建议：B + A。默认开启“Code Workspace 中折叠主侧栏并合并工具窗口条”，设置里可关闭（关闭后回到现状）。

**用户决定（2026-10-01）**：执行 B + A，并扩展到终端等其它标签类型以保持整体一致 → 见 [ED-PARITY-027](#ed-parity-027)。

<a id="ed-parity-027"></a>

## ED-PARITY-027 单一工具窗口条（PROP-026-01 B + A，扩展到终端）

规则：拥有工具窗口的标签类型（Code Workspace、终端）各自记住主侧栏展开/折叠状态，默认折叠为工具条；其它标签类型共用一组状态（保持原有行为）。主侧栏折叠时，活动标签把自己的工具窗口按钮渲染进该工具条（Sessions/Tools 竖排页签之下、Git/Settings 之上）；主侧栏展开时按钮回到标签内原位置。动作类按钮（Capture、Detach、Reconnect…）仍在控制栏的标签操作区——与 IDEA“条上是工具窗口、工具栏上是动作”一致。

- ED-PARITY-027-A1 侧栏状态按标签组记忆（`taomni.sidebarCollapsedByGroup.v1`）：进入 Code Workspace/终端默认折叠，离开时恢复下一组的状态；在某组内手动展开/折叠（侧栏页签、拖动分隔条、菜单）只改该组。
- ED-PARITY-027-A2 Code Workspace 的左工具窗口条在折叠时通过 portal 进入主工具条（`data-embedded`），仅活动工作区占用；右侧条仍在工作区；按钮、右键菜单（Hide/Move/Show Tool Window Names）与拖宽在工具条中照常工作；展开主侧栏后回到工作区。
- ED-PARITY-027-A3 终端的工具窗口（附加 SFTP、Chat）在折叠时进入主工具条（沿用 `attached-sftp-toggle` / `tab-chat-toggle`），控制栏不再重复显示；分屏模式与独立窗口保持原样。
- ED-PARITY-027-A4 名称显示与条宽为全局共享设置（`useToolWindowStripeStore`，多个工作区与终端工具条同步）；设置 › 常规 › 全局界面的“单一工具窗口条”可关闭合并与按组记忆。
- ED-PARITY-027-A5 启动状态：合并开启时旧键 `taomni.sidebarCollapsed` 只保存“其它”组（Welcome 等），只有在该组内的手动改动才写它；切换标签应用某组状态不写旧键，`v1` 键只存 Code Workspace/终端两组。主侧栏面板的首次尺寸回报来自恢复的 `main-layout` 布局（可能是上次终端/工作区的 0%），不再回写状态，由状态驱动面板。修复前：在终端或工作区折叠侧栏时退出，下次启动 Welcome 也是折叠的（CI run 36801360767 macOS native 的 TC-145 / 027-02 / 027-03 即因 WKWebView 跨用例保留 localStorage 而复现）。
- V：单元 `sidebarRailPolicy.test.ts`、`appStore.test.ts`（per tab group 块）、`Sidebar.test.tsx`、`ToolWindowRail.test.tsx`、`MainLayout.test.tsx`（ED-PARITY-027 块，含恢复布局首报不回写）、`CodeWorkspaceTab.test.tsx`；`TC-IDE-PARITY-027-01`（browser 三端，工作区 + 重新加载 + 设置开关）、`TC-IDE-PARITY-027-02`（browser + native 三端，SSH 终端 SFTP）、`TC-IDE-PARITY-027-03-merged-rail-workspace-native`（native 三端，含重新加载后 Welcome 展开）。native 用例开头显式写入三项偏好，避免 macOS WKWebView 跨用例保留的 localStorage 影响结果。

## 未覆盖与后续

- IDEA Project 视图的 Packages / Open Files / Scratches 等其它视图、Behavior 与 Sort 子菜单、文件类型图标与源根着色未做。
- 悬停弹窗的“朝向判断”不含 IDEA 的时间衰减；调试值悬停（debugEditorChrome）仍用 CodeMirror 默认行为。
- ED-PARITY-027 只给 Code Workspace 与终端接入工具条；SFTP、数据库、邮件等标签类型暂无工具窗口，沿用“其它”组；后续接入时只需按同一宿主渲染按钮并加入分组。
