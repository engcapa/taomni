# ED-PARITY-012 Find、Replace 与弹层焦点生命周期对齐（P1 设计）

- 卡片：[backlog ED-PARITY-012](backlog.md)；依赖 010（壳层）、011（编辑区表面）。
- IDEA 参照：[控件级复核 §3](references/idea-control-audit-20260929.md#find)（`idea-06/07/08/39`），DEC-ALIGN-11。
- 已复用：013 的 `useFocusReturn`（Keymap 对话框已按 DEC-ALIGN-11 归还焦点）。

<a id="current-facts"></a>
## 1. 现状核对

| 事实 | 位置 |
|---|---|
| `QuickPickOverlay`（Search Everywhere/Go to File/Recent Files/Recent Locations 等共用）与 File Structure、Quick Doc、Location Peek 关闭时只改 open state，焦点落 `BODY`（复核实测 5 处）。 | `QuickPickOverlay.tsx`、`WorkspacePopupsHost.tsx` |
| Find 面板（`editorSearchPanel.ts`，CM 自定义 panel）：`input[type=search]`（依赖平台清除按钮）、Aa/W/.*、状态、上下、`…` 更多（In Sel / 上下文过滤 / Select All）、关闭；Replace 行：保留大小写、Replace、Replace All；无历史、无多行、无 Exclude；Ctrl+R 把焦点移到 Replace 框。 | `editorSearchPanel.ts:346-640` |
| 上下文过滤（Anywhere/In Comments/In Strings/No Comments）已实现但藏在 `…`。 | 同上 |
| Go to Line 为 CodeMirror 默认底部面板，空输入，无预填。 | `workspaceCodeMirrorKeymap.ts:375` |

<a id="decisions"></a>
## 2. 设计决定

| DEC | 决定 |
|---|---|
| DEC-012-01 | 所有 QuickPick 弹层、File Structure、Quick Doc、Location Peek 与 Go to Line 对话框使用 `useFocusReturn`：打开时记录焦点元素，关闭（Esc/选择/外部点击）后若焦点丢失（落在 body 或已移除节点）则还给原元素，原元素失效时交回活动编辑器；不抢夺已被新表面（新对话框、打开的文件）接管的焦点。 |
| DEC-012-02 | Find 行按 IDEA 排列：历史放大镜（`Search history` 下拉，最近 10 条，本会话 + 本地持久化）、输入框、清除 `×`（非空时显示）、多行切换、Aa/W/.*；框外：计数、上/下、过滤漏斗（原上下文过滤，移出 `…`）、`…`（In Selection / Select All）、关闭。 |
| DEC-012-03 | 多行：切换后查找框换成 `textarea`（`name="search-multiline"`），Enter 换行、Ctrl/Cmd+Enter 下一处；默认单行 `input[name="search"]` 不变。 |
| DEC-012-04 | Replace 行：历史下拉、输入框、保留大小写、Replace、Replace All、Exclude。Exclude 把当前匹配加入本查询的排除集并跳到下一处；Replace All 跳过排除项；查询变化清空排除集。 |
| DEC-012-05 | `Ctrl/Cmd+R`（编辑器或查找框内）打开 Replace 行但焦点留在 Find 框（IDEA）；Tab 从 Find 框进入 Replace 框。 |
| DEC-012-06 | Go to Line 改为小对话框 “Go to Line:Column”：预填当前 `行:列` 并全选，Enter/OK 跳转，Esc/Cancel 零移动，输入非法时提示且 OK 禁用；关闭后焦点回编辑器。 |
| DEC-012-07 | 匹配在滚动条画刻度属于 error stripe，交 ED-PARITY-022；匹配底色保持现有主题。 |

<a id="acceptance"></a>
## 3. 验收细化

- **A1**：Ctrl/Cmd+F 打开后焦点在 Find 框；Enter/Shift+Enter 前后跳；Tab 到 Replace；Esc 关闭并保留当前匹配选区、焦点回编辑器；外部点击关闭不改文本。
- **A2**：无结果显示 `0 results`；重复打开复用查询；分屏各自面板；IME 组合期间 Enter 不跳转；弹层打开时编辑器/树/终端不接收其按键。
- **A3**：迟到查询不覆盖新查询（沿用现有 SearchQuery effect 语义）；Exclude/Replace All 与 undo 一次恢复；modifier hover、剪贴板、导航保留。
- **A4**：从编辑器打开 Go to File、Recent Files、Recent Locations、File Structure、Search Everywhere、Quick Doc、Location Peek、Keymap、Go to Line 后 Esc，`document.activeElement` 为原 `.cm-content` 且 selection 不变；Ctrl+R 后焦点仍在 Find 框；Find 栏含历史、清除、多行、过滤、Exclude。

<a id="tasks"></a>
## 4. 任务

| TASK | 文件 |
|---|---|
| TASK-012-01 焦点归还接入各弹层 | `useFocusReturn.ts`（仅焦点丢失时归还）、`QuickPickOverlay.tsx`、`WorkspacePopupsHost.tsx` 内 File Structure/Quick Doc/Location Peek |
| TASK-012-02 Find 行控件重排 + 历史 + 清除 + 多行 + 过滤漏斗 | `editorSearchPanel.ts`（+ test） |
| TASK-012-03 Replace 行历史 + Exclude + Replace All 跳过排除 | `editorSearchPanel.ts` |
| TASK-012-04 Ctrl+R 焦点保持 | `editorSearchPanel.ts`、`CodeMirrorHost.tsx`（openReplacePanel） |
| TASK-012-05 Go to Line 对话框 | 新 `workspace/GoToLineDialog.tsx`、`workspaceCodeMirrorKeymap.ts`、`CodeWorkspaceTab.tsx` |

<a id="test-cases"></a>
## 5. 测试用例

| 用例 | 模式 | 覆盖 |
|---|---|---|
| `TC-IDE-PARITY-012-01-popup-focus-return-browser`（新） | browser | A4：从编辑器逐个打开 Go to File（Ctrl+Shift+N）、Recent Files（Ctrl+E）、Recent Locations（Ctrl+Shift+E）、File Structure（Ctrl+F12）、Search Everywhere（Find Action）、Go to Line（Ctrl+G）后 Esc，断言焦点为 `.cm-content`，caret 状态栏不变。 |
| `TC-IDE-PARITY-012-02-find-replace-controls-browser`（新） | browser | A1/A4/DEC-012-02..05：Ctrl+F，输入 → 清除按钮出现并清空；Enter/Shift+Enter；Ctrl+R 焦点仍在 Find；历史下拉包含上次查询；多行切换出现 textarea；过滤漏斗在行内；Exclude 后 Replace All 只替换未排除项；Ctrl+Z 一次恢复；Esc 焦点回编辑器。 |
| `TC-IDE-PARITY-012-03-goto-line-dialog-browser`（新） | browser | DEC-012-06：Ctrl+G 预填 `行:列` 全选；输入 `2:3` Enter → 光标 2:3；Esc 零移动；非法输入 OK 禁用。 |
| 保留 | browser | FINDFOCUS-01、006-01/02、PARITY-004-01（Replace 打开）、C8-01。 |

单测：`editorSearchPanel.test.ts`（历史、Exclude、Ctrl+R 焦点、多行）、`GoToLineDialog.test.tsx`、`useFocusReturn` 行为（不抢焦点）。

<a id="verification"></a>
## 6. 验证与边界

本地单测 + browser；CI 三端 browser + 受影响 native 保留用例。IME 在 native Linux fcitx 另测不在本卡；滚动条刻度交 022。
