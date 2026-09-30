# ED-PARITY-021 IDEA 对照记录

- IDEA：Ultimate 2026.2.2 / IU-262.10315.125，Linux X11（[控件级复核 §6](../references/idea-control-audit-20260929.md#menus)）。
- Taomni：分支 `feat/ed-parity-021-context-menus`（叠在 014 上），browser Chromium 本地 + CI 三端。

| 控件/状态 | IDEA | Taomni（本卡后） | 结论 |
|---|---|---|---|
| 编辑器菜单首项 | Show Context Actions Alt+Enter | 同（TC-021-01 R1） | matched |
| 剪贴板组位置 | 第二组 | 第二组 | matched |
| 导航 | Find Usages + Go To › | 同；Go To › 含 Declaration or Usages/Definition/Implementation(s)/Type Declaration/Hierarchy | matched（子项集合 different：无 Super Method/Test） |
| Folding › | 有 | Collapse All / Expand All | matched（子项较少） |
| Rename… / Refactor › | 有 | 有（Refactor › 仅 Safe Delete…） | matched（子项较少） |
| Generate…、Open In ›、Local History ›、Git ›、Compare with Clipboard | 有 | 无 | different |
| AI 项 | 无 | 收进末组 AI › | different（accepted：Taomni 特有） |
| 助记符下划线 | 有 | 无 | different |
| tab 菜单顺序 | Close 组 → Copy → Split → Pin → Open In › → Local History | 同（R3） | matched |
| 单 tab 时 Close Other Tabs | 禁用 | 禁用（R3、单测） | matched |
| Split and Move、Bookmarks ›、Git ›、Rename File… | 有 | 无 | different |
| Esc 后焦点 | 回编辑器 | 回编辑器（R2） | matched |
