# ED-PARITY-022 Gutter 与滚动条边缘标记对齐（P1 设计）

- 卡片：[backlog ED-PARITY-022](backlog.md)；依赖 011、015、018。
- IDEA 参照：[控件级复核 §2、§8](references/idea-control-audit-20260929.md#editor-surface)——VCS 变更条（点击出变更弹层：上一处/下一处、Rollback、Show Diff、Copy、Commit this change）、运行三角菜单（Run/Debug/Run with Coverage/Modify Run Configuration…）、右侧 error stripe（错误/警告/TODO/用法刻度，可点击）、caret 用法高亮、参数名 inlay。
- 保留：现有 VCS gutter 与 blame、诊断 gutter/灯泡、断点与调试行、覆盖率、import 默认折叠（011）、大文件模式、LSP 文档高亮与 inlay 管线。

<a id="current-facts"></a>
## 1. 现状核对

| 事实 | 位置 |
|---|---|
| VCS 变更条已按 added/modified/deleted 着色，点击打开 `GitDiffPeek`（只有 Rollback/关闭）；Rollback 通过 `onChangeText` 整体替换缓冲区，不进 CodeMirror 历史。 | `gitEditorChrome.ts`、`GitDiffPeek.tsx`、`EditorGroup.tsx` |
| 诊断有行 gutter、灯泡与 overview gutter 列，没有右侧 error stripe。 | `lspDiagnosticChrome.ts` |
| 运行目标来自执行模型 + `workspaceJavaRunTarget`（`activeRunConfiguration`），只在工具栏/快捷键使用，没有 gutter 图标。 | `CodeWorkspaceTab.tsx` |
| caret 用法高亮：provider 不可用或失败时对所有语言回落到同文本单词高亮。 | `CodeWorkspaceTab.tsx` 高亮 effect、`fallbackWordHighlights` |
| 参数名 inlay 已由 `lspInlayHints` 提供并只显示 provider 数据。 | `lspIntelligenceChrome.ts` |

<a id="decisions"></a>
## 2. 设计决定

| DEC | 决定 |
|---|---|
| DEC-022-01 | 新增右侧 error stripe（`code-workspace-error-stripe`，10px，位于滚动条右侧）：刻度来源为 provider 诊断（error/warning/info，hint 不显示）、VCS 变更、当前用法高亮、TODO/FIXME 注释；按高度图定位，点击移动 caret 并居中滚动，不产生编辑。输入期间 150ms 合并刷新，TODO 扫描上限 20000 行。 |
| DEC-022-02 | VCS 变更弹层补齐 IDEA 工具条：上一处/下一处（`N of M`）、Rollback（改为一次普通编辑器事务，Ctrl+Z 可撤回）、Show Diff（HEAD 只读 ↔ 缓冲区对比）、Copy（复制 HEAD 行）；Esc 关闭。`Commit this change` 输入框不在本卡（记 different）。 |
| DEC-022-03 | 运行 gutter：仅当存在本文件的真实运行配置（`activeRunConfiguration.sourceFile` 等于当前文件）且文本含 `static void main(` 时，在顶层类型声明行与 main 行显示 ▶；点击弹出 `Run '<配置>'`/`Debug '<配置>'`（执行现有 Run/Debug 路径）。无 facts 不显示；测试方法三角、Run with Coverage、Modify Run Configuration… 不在本卡（different）。 |
| DEC-022-04 | Java 文件的 caret 用法高亮只接受 provider 结果；provider 不可用/失败时不显示（不做同文本冒充）。其他语言保持现有回落；显式 Highlight Usages（Ctrl+Shift+F7）不变。 |
| DEC-022-05 | 参数名 inlay 与默认折叠沿用现有实现（provider inlay、011 import 折叠），本卡只做回归证明。 |

<a id="acceptance"></a>
## 3. 验收细化

- **A1**：VCS 条类型/颜色、弹层按钮与上一处/下一处、Show Diff、Rollback 单步撤销（TC-022-01 R1/R2）。
- **A2**：error stripe 刻度（browser VCS/TODO，native 真实诊断）与点击跳转（TC-022-01 R3、TC-022-02 R1）；运行图标在有/无 facts 两种状态（TC-022-02 R2、TC-022-01 R3）；Java 语义用法高亮（TC-022-02 R3）。
- **A3**：gutter/stripe 更新不改文档或 dirty（TC-022-01 R3、TC-022-02 R1/R3）；既有折叠/断点/诊断/blame 用例保持（011-01、C8-01、NAV-01/02、CHROME-01 回归）。

<a id="tasks"></a>
## 4. 任务

- **TASK-022-01**：`errorStripe.ts`（StateField + ViewPlugin）接入 `CodeMirrorHost`（诊断/VCS/用法源，rAF 延迟更新）。
- **TASK-022-02**：`GitDiffPeek` 工具条 + `EditorGroup` 导航/视图级 Rollback/Copy + `CodeWorkspaceTab.showGitHeadDiff`。
- **TASK-022-03**：`runGutter.ts` + `CodeWorkspaceTab` 运行目标与菜单。
- **TASK-022-04**：Java 高亮不回落；用例、控件、testid 目录。

<a id="cases"></a>
## 5. 测试用例

| 用例 | 模式 | 覆盖 |
|---|---|---|
| TC-IDE-PARITY-022-01 | browser（parity008 受控 Git） | R1 变更弹层 1 of 2 + 上一处/下一处；R2 Show Diff、Rollback 撤销；R3 stripe VCS/TODO 刻度、点击跳转、无运行图标。 |
| TC-IDE-PARITY-022-02 | native（Linux/Windows/macOS，JDT LS） | R1 真实诊断 error/warning 刻度与跳转；R2 类/main 运行图标与 Run/Debug 菜单；R3 语义用法高亮与 stripe 用法刻度，零 dirty。 |

<a id="verification"></a>
## 6. 验证与边界

单元：`errorStripe.test.ts`（刻度收集、点击不编辑、运行 gutter 有/无 facts）、`GitDiffPeek.test.tsx`（工具条、Esc）。未对齐：Commit this change、测试方法运行图标、Run with Coverage、Modify Run Configuration…、重写/实现 gutter 图标、查找结果刻度，记 different。
