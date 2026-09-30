# ED-PARITY-021 右键菜单结构、顺序与可用态对齐（P1 设计）

- 卡片：[backlog ED-PARITY-021](backlog.md)；依赖 013（快捷键格式化与 Action Registry 可用态）。
- IDEA 参照：[控件级复核 §6](references/idea-control-audit-20260929.md#menus)（`idea-15/16/49`）。
- 保留：菜单行执行冻结的 prepared evaluation（§8.17.3）、调试 Run to Cursor / Data Breakpoint、AI 入口可发现性、快捷键来自 `host.effectiveKeybindingDisplay`。

<a id="current-facts"></a>
## 1. 现状核对

| 事实 | 位置 |
|---|---|
| 编辑器菜单平铺约 20 项：导航 7 项在最前，剪贴板在最后，AI 三项平铺。 | `editorContextMenu.ts` `buildEditorContextMenuItems` |
| tab 菜单 Pin/Split 在前、Close 在中；单 tab 时 Close Others 仍可用；Reveal/Explorer/Terminal 平铺。 | `EditorGroup.tsx` `showTabMenu` |
| 菜单关闭（Esc）后焦点落 `BODY`：`ContextMenu` 把焦点移入菜单但不归还。 | `ContextMenu.tsx` |
| `useFocusReturn` 在 React StrictMode（dev）下二次运行 effect 时把弹层自身记为打开者。 | `useFocusReturn.ts` |

<a id="decisions"></a>
## 2. 设计决定

| DEC | 决定 |
|---|---|
| DEC-021-01 | 编辑器菜单按 IDEA 分组：`Show Context Actions`（Alt+Enter）置顶 / Cut·Copy·Paste / Find Usages、`Go To ›`（Declaration or Usages、Definition、Implementation(s)、Type Declaration、Call/Type Hierarchy）、Quick Documentation、`Folding ›`（Collapse All / Expand All）/ Rename…、`Refactor ›`（Safe Delete…）、Reformat Code|Selection / 调试组 / `AI ›`（Explain Syntax、Explain Code、Answer Language ›）。所有 testid 保留；子菜单父项 `editor-context-goto/folding/refactor/ai`。 |
| DEC-021-02 | tab 菜单顺序：Close、Close Other Tabs、Close All Tabs、Close Unmodified Tabs、Close Tabs to the Right / Copy Path、Copy Relative Path / Split Right、Split Down、Move Tab to Next/Previous Split / Pin Tab / `Open In ›`（Project View Alt+F1、Explorer、Terminal）、Local History…。单 tab 时 Close Other Tabs 禁用，最右 tab 时 Close Tabs to the Right 禁用。 |
| DEC-021-03 | `ContextMenu` 关闭后把焦点还给打开者（`useFocusReturn`，焦点已被动作接管时不抢）；`useFocusReturn` 跨 effect 重跑保留首个打开者。 |
| DEC-021-04 | 助记符下划线、Copy/Paste Special ›、Column Selection Mode、Generate…、Git ›、Bookmarks ›、Split and Move、Rename File…、项目树菜单本卡不做，记 different；项目树菜单需先补采 IDEA 参照。 |

<a id="acceptance"></a>
## 3. 验收细化

- **A1**：编辑器与 tab 菜单顺序/分组/子菜单与 IDEA 对照（TC-021-01 R1/R3、单测）；未做项记 DEC-021-04。
- **A2**：可用态来自同一 prepared evaluation；单 tab 时 Close Other Tabs 与 Close Tabs to the Right 禁用（R3、单测）。
- **A3**：执行路径不变（R4、CW-UI-01、单测）；Esc 关闭后焦点回编辑器（R2）。

<a id="tasks"></a>
## 4. 任务

| TASK | 文件 |
|---|---|
| TASK-021-01 编辑器菜单分组与子菜单 | `editorContextMenu.ts`（+ test）、`CodeWorkspaceTab.tsx`（Folding 绑定） |
| TASK-021-02 tab 菜单顺序与禁用态 | `EditorGroup.tsx`（+ test） |
| TASK-021-03 菜单焦点归还 | `ContextMenu.tsx`、`useFocusReturn.ts` |
| TASK-021-04 用例与 evidence | `TC-IDE-PARITY-021-01-*`、`TC-IDE-CW-UI-01`（Go To › 悬停）、`evidence/ed-parity-021-idea-comparison.md` |

<a id="test-cases"></a>
## 5. 测试用例

| 用例 | 模式 | 覆盖 |
|---|---|---|
| `TC-IDE-PARITY-021-01-context-menus-browser`（新） | browser | R1 编辑器菜单顺序与 Go To ›；R2 Esc 焦点回编辑器；R3 tab 菜单顺序与单 tab 禁用；R4 Close Tabs to the Right / Close Other Tabs 执行。 |
| 保留 | browser | CW-UI-01（经 Go To › 执行定义/声明）、TC-108、C0-01（Local History…）、C4-01/02。 |

<a id="verification"></a>
## 6. 验证与边界

本地单测 + browser；CI 三端 browser + 保留 native。native OS 级菜单键（Shift+F10）未覆盖。
