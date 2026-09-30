# ED-PARITY-012 IDEA 对照记录

- IDEA：Ultimate 2026.2.2 / IU-262.10315.125，Linux X11（[控件级复核 §3](../references/idea-control-audit-20260929.md#find)，`idea-06/07/08/39`）。
- Taomni：分支 `feat/ed-parity-012-find-focus`（叠在 011 上），browser Chromium 本地 + CI 三端。

| 控件/状态 | IDEA | Taomni（本卡后） | 结论 |
|---|---|---|---|
| 搜索框内控件 | 历史放大镜、清除 `×`、多行 `⏎`、`Cc`、`W`、`.*` | 历史 `⌕`（最近 10 条，会话 + localStorage）、清除 `×`（非空才显示）、多行 `↵`（切换为 textarea）、`Aa`、`W`、`.*`（TC-012-02 R2） | matched；图标字形 different（019） |
| 框外控件 | `3/4`、上/下、过滤漏斗、`⋮`、关闭 | `1 / 3`、上/下、过滤 `▽ Anywhere`（原 `…` 内的上下文过滤移到行内）、`…`（In Sel / Select All）、关闭 | matched |
| 无结果文案 | `0 results` | `0 results` / `N results` | matched |
| Replace 行 | 历史、保留大小写、Replace、Replace All、Exclude | 历史 `⌕`、`AB/ab`、Replace、Replace All、Exclude；Replace All 跳过已排除项，一次 undo 恢复（TC-012-02 R4） | matched；Replace 多行未做（different） |
| `Ctrl+R` 后焦点 | 留在 Find 框 | 留在 Find 框；Tab 进入 Replace，Shift+Tab 回 Find（TC-012-02 R3、单测） | matched |
| Esc | 关闭、焦点回编辑器、保留匹配选区 | 同（FINDFOCUS-01、TC-012-02 R5） | matched |
| 弹层 Esc 焦点归还 | Go to File、Recent Files、File Structure、Search Everywhere、Settings 回编辑器 | Go to File、Recent Files、Recent Locations、File Structure、Find Action、Go to Line 回原 `.cm-content`，caret 不变（TC-012-01）；Keymap 由 013 覆盖 | matched |
| Go to Line | 模态 “Go to Line:Column”，预填并全选 `行:列`，OK/Cancel | 同；非法输入提示且 OK 禁用，Esc/Cancel 零移动（TC-012-03、`GoToLineDialog.test.tsx`） | matched |
| 匹配高亮/滚动条刻度 | 黄底 + 滚动条刻度 | 主题底色，无刻度 | different（DEC-012-07 交 022） |
| 排除项视觉 | 删除线 | 仅状态 `· N excluded` | different |

## 实现中发现的附带缺陷

- 焦点归还用 DOM `focus()` 聚焦 `.cm-content` 会让 CodeMirror 把 caret 读成 1:1；改为经 `EditorView.focus()` 归还（TC-012-01 R2 捕获）。
- 非 QuickPick 弹层的 `FocusReturn` 必须位于树序最前，否则弹层 `autoFocus` 先于记录，打开者被记成弹层自身输入框（Recent Locations 实测 → `BODY`）。
- 011 默认 import 折叠：用户展开后重挂载不再重新折叠（`importsExpanded` 快照标记）；新打开/从未折叠过的视图仍默认折叠。
