# ED-PARITY-024 IDEA 对照记录

- IDEA：Ultimate 2026.2.2 / IU-262.10315.125，Linux X11，Default for XWin keymap。弹窗按键为实机 XTEST 探针（`qa-ui-auto-report/idea-reference/round2-20260930/probe.py`，截图差分）并与 `lib/intellij.platform.ide.impl.jar` 中 Search Everywhere / Switcher 的字节码对照；工具窗口条与 Options 结构来自 `intellij.platform.ide.impl` 的 action XML 与 `ActionsBundle`。
- Taomni：分支 `feat/ed-parity-round2-detail`，browser（Linux/Windows/macOS）+ native（Linux/Windows/macOS）。

| 控件/状态 | IDEA | Taomni（本卡后） | 结论 |
|---|---|---|---|
| 工具窗口条宽度 | 显示名称时默认 59 px，可在 40–100 px 间拖动；隐藏名称为 40 px 图标条 | 同（TC-024-01 R1） | matched |
| 条按钮右键菜单 | Hide / Move to（6 锚点）/ Remove from Sidebar / Show Tool Window Names | 同（R2、R5） | matched |
| 窗口 ⋮ Options | View Mode / Move to / Resize / Remove from Sidebar / Hide | 同；View Mode 仅 Dock Pinned 可用 | different（无 Float/Window/Undock） |
| 六锚点与内容保留 | 移动后窗口状态保留 | portal 重挂载，终端 PTY 会话保留（TC-024-03 三端 native） | matched |
| Structure 默认位置 | Left Bottom（Project 下方） | 同（R3） | matched |
| More tool windows | 列出未在条上的窗口 | 同（R5） | matched |
| Esc 离开工具窗口 | 焦点回编辑器 | 同（R7；Terminal 保留 Esc 给 shell） | matched |
| Alt+7 | 未激活则激活，已激活则隐藏 | 同 | matched |
| Project 头部 | Select Opened File、Expand All、Collapse All、⋮ | 同（R6），Expand All 逐层加载未列出的目录 | matched（大工程不一次性全展开） |
| Search Everywhere 切分类 | Tab / Shift+Tab；方向键不切 | 同（TC-024-02 R1） | matched |
| Recent Files / Switcher | Left/Right 在工具窗口列与文件列间移动 | 同（R2） | matched |
| “Ctrl+Alt+N 弹窗方向键切 tab” | Ctrl+Alt+N 为 Inline 重构，不是弹窗 | 按 IDEA 实际行为，不引入方向键切 tab | matched（用户描述与 IDEA 不符） |
