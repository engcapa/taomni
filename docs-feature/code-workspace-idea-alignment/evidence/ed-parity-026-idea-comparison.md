# ED-PARITY-026 IDEA 对照记录

- IDEA：Ultimate 2026.2.2 / IU-262.10315.125。Search Everywhere 按键来自 `lib/intellij.platform.lang.impl.jar` 中 `SearchEverywhereUI.initSearchActions` 与 `MixedSearchListModel.getIndexToScroll` 的字节码（`javap -c`），键位来自 `lib/intellij.platform.ide.impl.jar!/keymaps/{$default,Default for XWin,Mac OS X 10.5+}.xml`；Project 视图动作来自同一 jar 的 `idea/LangActions.xml`（`ProjectViewToolbar`、`ProjectView.ToolWindow.SecondaryActions`）；悬停弹窗行为按 `EditorMouseHoverPopupManager` / `MouseMovementTracker` 的语义对照。本轮未做实机截图采集（需要独占桌面）。
- Taomni：分支 `feat/ed-parity-round2-detail`，browser（Linux/Windows/macOS）+ native（Linux/Windows/macOS）。

| 控件/状态 | IDEA | Taomni（本卡后） | 结论 |
|---|---|---|---|
| Search Everywhere 切页签 | Tab/Shift+Tab、NextTab/PreviousTab（XWin Alt+Right/Left；macOS Ctrl+Right/Left、Cmd+Shift+]/[）、Switcher（Ctrl+Tab/Ctrl+Shift+Tab） | 同（TC-026-01 R1/R2，TC-026-02） | matched |
| 普通 Left/Right | 在输入框里移动光标 | 同（TC-026-01 R1） | matched |
| 分组跳转 | PageDown/Ctrl+Down → 最后一个，PageUp/Ctrl+Up → 第一个 | 同（R3） | matched |
| 重开查询 | 新开弹窗从空查询开始（未启用“记住上次搜索”时） | 同，且在打开的同一渲染里清空（R4） | matched |
| 悬停文档停留 | 指针在元素上、在弹窗内或朝弹窗移动时保留 | 同（TC-026-03 R1，TC-026-04 R1） | matched |
| 悬停文档关闭 | 指针去往别处后关闭；Esc 关闭 | 宽限期 150–500 ms 后关闭；Esc 关闭（R2） | matched（无 IDEA 的时间衰减细节） |
| 点进弹窗 | 获得焦点后保持到 Esc/焦点离开 | 同（R3） | matched |
| Project 标题栏 | Project ▾ ｜ New、Select Opened File、Expand All、Collapse All、⋮、− | 同（TC-026-05 R1，TC-026-06 R1） | matched |
| New（+） | 新元素列表（File、Directory、语言相关类型…） | File、Directory、Open File…、Add Folder to Workspace… | different（无语言相关新建项；多了工作区入口） |
| 视图选择器 | Project、Packages、Project Files、Open Files、Scratches… | Project、Project Files | different（其它视图未实现） |
| ⋮ Appearance | Details、Compact Directories 等多项；另有 Behavior、Sort 子菜单 | Details、Compact Directories、Zoom | different（Behavior/Sort 未实现） |
| 过滤 | 无常驻过滤框，键入即速搜（高亮跳转） | 键入/Ctrl+F 打开速搜框，沿用过滤语义 | different（Taomni 过滤而非仅高亮） |
| 根节点 | 名称后显示路径 | 同 | matched |
| 左侧条与主侧栏融合 | —（IDEA 只有一条） | 方案 PROP-026-01 待用户评审 | unverified |
