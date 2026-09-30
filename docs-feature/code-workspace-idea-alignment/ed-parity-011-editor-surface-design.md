# ED-PARITY-011 编辑器表面、标签、面包屑与状态提示对齐（P1 设计）

- 卡片：[backlog ED-PARITY-011](backlog.md)；总体合同 [alignment-design.md#ed-parity-011](alignment-design.md#ed-parity-011)；依赖 010（状态栏导航栏槽、rail 壳层）。
- IDEA 参照：[控件级复核 §2](references/idea-control-audit-20260929.md#editor-surface)（`idea-03/04/21/29/30`），DEC-ALIGN-06/08/10。

<a id="current-facts"></a>
## 1. 现状核对

| 事实 | 位置 |
|---|---|
| 编辑区上方依次是：顶部 Breadcrumbs（`code-workspace-breadcrumbs`，可键盘遍历/弹层，Alt+Home 进入，TC-IDE-NAV-01）、`EditorBanner`（read-only/encoding/sdk-import/indexing-degraded/custom，TC-IDE-CHROME-02）、常驻 `code-workspace-file-status` 条（fold 来源、文件大小、mtime、spinner、LSP pill、HighlightingWidget、Markdown 模式按钮）。合计两至三条常驻条。 | `EditorGroup.tsx:795-850` |
| 010 已在状态栏放入只读导航栏（`status-bar-workspace-navbar`），与顶部 Breadcrumbs 重复。 | `StatusBar.tsx` |
| Go to File / Search Everywhere 文件项以 `{ preview: true }` 打开，第二次打开替换第一次（DEC-ALIGN-10 要求正式 tab）。 | `useWorkspaceNavigation.ts:165` |
| tab：通用文件图标、preview 斜体、dirty `*`，无错误标记、无类型图标；溢出为 `…`。 | `EditorGroup.tsx` tab strip |
| 折叠：`foldGutter()` 常显折叠箭头；无默认折叠。 | `CodeMirrorHost.tsx:3115` |
| 选区 AI 工具条：任何 ≥2 字符选区都显示（含 Find/导航/双击产生的选区），浮在选区上一行遮挡代码。 | `CodeWorkspaceTab.tsx:20637/22071` |

<a id="decisions"></a>
## 2. 设计决定

| DEC | 决定 |
|---|---|
| DEC-011-01 | 删除常驻 `code-workspace-file-status` 条。HighlightingWidget、LSP pill、同步 spinner 与 Markdown 模式按钮移入编辑区右上角浮动的 IDEA 检查 widget（`code-workspace-inspection-widget`，不占行高、不遮挡首行文字：为其预留编辑器右侧 padding）。文件大小/mtime 移入导航栏文件段的 tooltip；fold 来源 chip 保留为 widget 内 `data-provenance` 与 title（测试选择器 `code-workspace-fold-provenance` 保留在 widget 内）。 |
| DEC-011-02 | 顶部 Breadcrumbs 通过 portal 渲染进状态栏导航栏槽（替换 010 的只读导航栏），保留全部交互（Alt+Home、键盘遍历、弹层）与 testid；编辑区顶部不再有 breadcrumb 行。外观设置 `breadcrumbs.placement` 新增默认值 `status-bar`，旧 `top/bottom` 仍可选。 |
| DEC-011-03 | `EditorBanner` 只保留需要用户在该文件上操作的条目（read-only、encoding-mismatch、decompiled）；`indexing-degraded` / `sdk-import` 类语言服务降级改为状态栏 LSP widget 的 degraded 态 + 每个条件代次一次的右下角通知气泡（复用 010 的 balloon 位置），不再占编辑区。 |
| DEC-011-04 | Go to File、Search Everywhere 文件/符号项与 Recent Files 打开正式 tab；preview 只由项目树单击产生（DEC-ALIGN-10）。 |
| DEC-011-05 | tab：按扩展名显示语言类型图标（Java `C`/可运行类加三角标、TS/JS/JSON/MD 等），活动 tab 为描边胶囊；文件存在 error 诊断时文件名红色波浪下划线（`data-has-errors`）；溢出按钮改为 `˅` 并保留原 testid。 |
| DEC-011-06 | 默认折叠：Java/Kotlin/TS/JS 的 import 块（连续 ≥2 行 import）在文件首次打开时折叠；单行方法体不在本卡（依赖 provider 结构，交 022），记录 different。折叠箭头仅在 hover gutter 或 caret 所在块显示。 |
| DEC-011-07 | DEC-ALIGN-08（用户未改变）：选区 AI 工具条只在“用户用指针拖选或 Shift+方向键扩选”的选区上出现，不在 Find/Replace、导航跳转、双击选词、Select All、多光标产生的选区上出现；位置改为选区下方且不覆盖选区所在行（空间不足时放在右侧外沿）；入口 Alt+Enter/右键/快捷键不变。完全移除自动出现仍待用户决定。 |

<a id="acceptance"></a>
## 3. 验收细化

- **A1**：tab 类型图标/活动描边/错误波浪线、检查 widget 三态、导航栏在状态栏、代码区首行无遮挡；正常/选中/失焦/只读分别有 DOM 断言与截图。
- **A2**：preview（树单击）→ 编辑后转正式、双视图共享文档、关闭非最后 view、分屏 selection/scroll 保持（保留 TC-IDE-PARITY-003、C4-02）；Go to File 三次得到三个正式 tab。
- **A3**：保存、编码/EOL、dirty、一次 undo/redo、外部冲突恢复不回退（保留 TC-IDE-C0-02、FINDFOCUS-01、006-*）。
- **A4**：编辑区顶部无常驻降级/文件信息条；检查 widget 显示 `Analyzing…`/计数/✓；Go to File 连开三个文件得到三个正式 tab；import 默认折叠；Find 后的选区不出现 AI 工具条。

<a id="tasks"></a>
## 4. 任务

| TASK | 文件 |
|---|---|
| TASK-011-01 检查 widget 浮层 + 删除 file-status 条 | `EditorGroup.tsx`、`HighlightingWidget.tsx` |
| TASK-011-02 Breadcrumbs portal 进状态栏、placement 默认 | `EditorGroup.tsx`、`editorAppearanceProfile.ts`、`StatusBar.tsx`、`CodeWorkspaceTab.tsx` |
| TASK-011-03 降级 banner → LSP widget + 气泡 | `editorBannerModel.ts`、`CodeWorkspaceTab.tsx` |
| TASK-011-04 正式 tab 打开 | `useWorkspaceNavigation.ts` |
| TASK-011-05 tab 图标/描边/错误标记 | `EditorGroup.tsx`（tab strip）、新 `workspace/fileTypeIcon.tsx` |
| TASK-011-06 默认 import 折叠 + hover 折叠箭头 | `CodeMirrorHost.tsx` |
| TASK-011-07 AI 工具条触发与位置 | `CodeWorkspaceTab.tsx`、`EditorSelectionAiToolbar.tsx`、`CodeMirrorHost.tsx`（选区来源） |

<a id="test-cases"></a>
## 5. 测试用例

| 用例 | 模式 | 覆盖 |
|---|---|---|
| `TC-IDE-PARITY-011-01-editor-surface-browser`（新） | browser | A1/A4：编辑区顶部无 `code-workspace-file-status`；检查 widget 存在；导航栏（Breadcrumbs）位于状态栏且 Alt+Home 可进入；tab 有类型图标与活动态。 |
| `TC-IDE-PARITY-011-02-goto-file-formal-tabs-browser`（新） | browser | A2/A4：Go to File 连开三个文件 → 三个 tab 均非 preview；树单击仍为 preview。 |
| `TC-IDE-PARITY-011-03-import-fold-ai-toolbar-browser`（新） | browser | A4：含 import 的 Java 文件打开后 import 折叠；Find 选中匹配后 Esc 不出现 AI 工具条；Shift+方向键扩选出现且不覆盖选区行。 |
| 保留 | browser/native | NAV-01（导航栏交互，新位置）、CHROME-02（banner 生命周期，按 DEC-011-03 迁移）、PARITY-003、C4-02、C0-02、FINDFOCUS-01、006-01/02。 |

单测：`EditorGroup.test.tsx`（无 file-status、widget 内容）、`Breadcrumbs` portal、`editorBannerModel`（降级不进 editor banner）、`useWorkspaceNavigation` 正式 tab、`CodeMirrorHost` import 折叠、AI 工具条来源过滤。

<a id="verification"></a>
## 6. 验证与边界

本地 Linux 单测 + 新旧 browser 用例；CI 三端 browser（本卡无 native 专有断言，native 仅跑受影响保留用例）。IDEA 对照：复核 §2 文字化实测；字体/行高 profile 对比交 019；单行方法体折叠、error stripe、用法高亮交 022。
