# 当前生产入口与证据审查

基线：`27f99b6116f4f6aae906d324cb84e8359695e17a`，2026-09-13。本文件解释矩阵中的生产链，不替代UI/交互实测。路径和符号按当前文件核对；行号仅帮助定位。

<a id="shell"></a>

## SHELL — 布局与动作

状态 owner：MainLayout 的 app tab；CodeWorkspaceTab 装配；codeWorkspaceStore 按 workspaceInstanceId 持有布局，WorkspaceActionHost 持有动作上下文。

生产链：MainLayout → CodeWorkspaceTab → ActionsController / WorkspaceActionHost → panels/store → 可见入口和焦点；native window/dialog 经 Tauri，browser 使用 stubs。

| 当前文件 / 符号 | 定位行 |
|---|---|
| [MainLayout.tsx](../../src/layouts/MainLayout.tsx) · `openCodeWorkspaceInfo` | 2157 |
| [CodeWorkspaceTab.tsx](../../src/components/editor/CodeWorkspaceTab.tsx) · `useWorkspaceActionsController({` | 15024 |
| [codeWorkspaceStore.ts](../../src/stores/codeWorkspaceStore.ts) · `createDefaultCodeWorkspaceUi` | 128 |
| [BottomDock.tsx](../../src/components/editor/workspace/panels/BottomDock.tsx) · `BottomDock` | 4 |
| [workspaceActionHost.ts](../../src/components/editor/workspace/workspaceActionHost.ts) · `class WorkspaceActionHost` | 341 |


<a id="tree"></a>

## TREE — 项目树

状态 owner：codeWorkspaceStore 的 treeSelection / expandedRootIds / expandedDirKeys；目录缓存与 file actions 在 shell/hooks。

生产链：MainLayout → CodeWorkspaceTab → ProjectTree / handleTreeKeyDown → navigateProjectTree 或 useWorkspaceFileActions → useWorkspaceTreeData → workspace_list_dir / workspace_read_file / 资源事务 → 树行、tabs、正文。

| 当前文件 / 符号 | 定位行 |
|---|---|
| [ProjectTree.tsx](../../src/components/editor/workspace/ProjectTree.tsx) · `onToggleDir(root.id, displayPath)` | 313 |
| [CodeWorkspaceTab.tsx](../../src/components/editor/CodeWorkspaceTab.tsx) · `const handleTreeKeyDown` | 4024 |
| [projectTreeNavigation.ts](../../src/components/editor/workspace/projectTreeNavigation.ts) · `navigateProjectTree` | 19 |
| [useWorkspaceTreeData.ts](../../src/components/editor/workspace/useWorkspaceTreeData.ts) · `useWorkspaceTreeData` | 46 |
| [useWorkspaceFileActions.ts](../../src/components/editor/workspace/useWorkspaceFileActions.ts) · `const renameSelected` | 386 |
| [workspace.ts](../../src/lib/editor/workspace.ts) · `workspaceListDir` | 394 |
| [workspace.rs](../../src-tauri/src/workspace.rs) · `pub fn workspace_read_file` | 2112 |


<a id="tabs"></a>

## TABS — 标签与分屏

状态 owner：codeWorkspaceStore layoutTreeV2/layoutRevision/editorGroups；document transaction owner 共享正文/undo，per-view caret/scroll/fold 独立。

生产链：CodeWorkspaceTab open/split/close/policy → EditorGroup → atomic layout mutations / TabPolicyPlan → layout v2 persistence；文件读写和资源释放经 workspace IPC/LSP → tab/pane/dirty/恢复结果。

| 当前文件 / 符号 | 定位行 |
|---|---|
| [EditorGroup.tsx](../../src/components/editor/workspace/EditorGroup.tsx) · `export function` | 282 |
| [codeWorkspaceStore.ts](../../src/stores/codeWorkspaceStore.ts) · `layoutRevision` | 122 |
| [recursiveLayoutTree.ts](../../src/components/editor/workspace/recursiveLayoutTree.ts) · `atomicSplitLeaf` | 672 |
| [workspaceTabPolicy.ts](../../src/components/editor/workspace/workspaceTabPolicy.ts) · `TabPolicy` | 17 |
| [workspaceLayoutPersistence.ts](../../src/components/editor/workspace/workspaceLayoutPersistence.ts) · `readWorkspaceLayoutSnapshot` | 452 |
| [workspaceDocumentTransactionOwner.ts](../../src/components/editor/workspace/workspaceDocumentTransactionOwner.ts) · `class WorkspaceDocumentTransactionOwner` | 192 |


<a id="edit"></a>

## EDIT — 编辑与输入

状态 owner：CodeMirror EditorState/view；WorkspaceDocumentTransactionOwner；clipboard/composition session 按 view generation。

生产链：EditorGroup → CodeMirrorHost → CodeMirror commands / editor command port → transaction owner → openFiles 同步及 undo；剪贴板经 lib/clipboard 原生或 browser API，IME 归 OS → 正文/selection/caret。

| 当前文件 / 符号 | 定位行 |
|---|---|
| [CodeMirrorHost.tsx](../../src/components/editor/workspace/CodeMirrorHost.tsx) · `createLspHyperlinkExtension({` | 1930 |
| [workspaceEditorCommands.ts](../../src/components/editor/workspace/workspaceEditorCommands.ts) · `export` | 41 |
| [workspaceDocumentTransactionOwner.ts](../../src/components/editor/workspace/workspaceDocumentTransactionOwner.ts) · `class WorkspaceDocumentTransactionOwner` | 192 |
| [workspaceCodeMirrorKeymap.ts](../../src/components/editor/workspace/workspaceCodeMirrorKeymap.ts) · `export` | 115 |
| [clipboard.ts](../../src/lib/clipboard.ts) · `export` | 11 |


<a id="save"></a>

## SAVE — 保存与恢复

状态 owner：immutable prepared save；openFiles 当前 revision；save observation / recovery journal；history before-image。

生产链：CodeWorkspaceTab save → style controller → format/import/normalize/encoding plan → 单次 workspace_write_file_encoded → 回读/receipt/recovery → dirty、disk hash、Local History / conflict dialog。

| 当前文件 / 符号 | 定位行 |
|---|---|
| [workspaceStyleController.ts](../../src/components/editor/workspace/workspaceStyleController.ts) · `createWorkspaceStyleController` | 593 |
| [saveNormalizationPipeline.ts](../../src/components/editor/workspace/saveNormalizationPipeline.ts) · `export` | 23 |
| [saveCommit.ts](../../src/components/editor/workspace/saveCommit.ts) · `export` | 23 |
| [CodeWorkspaceTab.tsx](../../src/components/editor/CodeWorkspaceTab.tsx) · `commitOpenBufferPreparedSave` | 5442 |
| [workspace.rs](../../src-tauri/src/workspace.rs) · `pub fn workspace_write_file_encoded` | 2331 |
| [LocalHistoryDialog.tsx](../../src/components/editor/workspace/LocalHistoryDialog.tsx) · `LocalHistoryDialog` | 10 |
| [ExternalFileConflictDialog.tsx](../../src/components/editor/workspace/ExternalFileConflictDialog.tsx) · `ExternalFileConflictDialog` | 5 |


<a id="nav"></a>

## NAV — 导航与查询

状态 owner：navigationHistory/location controller；SearchEverywhere query；WorkspaceSemanticQueryHost/usageSession 的 request、document、provider、project generation。

生产链：workspace navigation action → navigation owner 或 semantic query host → workspace recursive files / lsp definition/references/hierarchy → openFile/reveal → 成功后 history；cancel/late result 门控。

| 当前文件 / 符号 | 定位行 |
|---|---|
| [useWorkspaceNavigation.ts](../../src/components/editor/workspace/useWorkspaceNavigation.ts) · `export function useWorkspaceNavigation` | 105 |
| [SearchEverywhere.tsx](../../src/components/editor/workspace/SearchEverywhere.tsx) · `SearchEverywhere` | 45 |
| [workspaceSemanticQueryHost.ts](../../src/components/editor/workspace/workspaceSemanticQueryHost.ts) · `class WorkspaceSemanticQueryHost` | 84 |
| [Breadcrumbs.tsx](../../src/components/editor/workspace/Breadcrumbs.tsx) · `Breadcrumbs` | 45 |
| [ReferencesPanel.tsx](../../src/components/editor/workspace/panels/ReferencesPanel.tsx) · `ReferencesPanel` | 33 |
| [HierarchyPanel.tsx](../../src/components/editor/workspace/panels/HierarchyPanel.tsx) · `HierarchyPanel` | 42 |
| [lsp.ts](../../src/lib/editor/lsp.ts) · `lspReferences` | 1493 |


<a id="search"></a>

## SEARCH — 查找替换

状态 owner：CodeMirror SearchQuery / panel focus；FindInFilesPanel searchId/preview/token；WorkspaceEdit journal owner。

生产链：本地：CodeMirrorHost → WorkspaceSearchPanel / SearchQuery；项目：FindInFilesPanel → scope plan → workspace_search_start/cancel（native ripgrep / browser VFS）→ ReplacePreviewDialog → onReplaceMatches → preimage 检查/apply/history。

| 当前文件 / 符号 | 定位行 |
|---|---|
| [editorSearchPanel.ts](../../src/components/editor/workspace/editorSearchPanel.ts) · `class WorkspaceSearchPanel` | 344 |
| [lspHyperlink.ts](../../src/components/editor/workspace/lspHyperlink.ts) · `private clearMod` | 157 |
| [FindInFilesPanel.tsx](../../src/components/editor/workspace/panels/FindInFilesPanel.tsx) · `const commitReplacePreview` | 769 |
| [ReplacePreviewDialog.tsx](../../src/components/editor/workspace/panels/ReplacePreviewDialog.tsx) · `ReplacePreviewDialog` | 17 |
| [CodeWorkspaceTab.tsx](../../src/components/editor/CodeWorkspaceTab.tsx) · `onReplaceMatches={async` | 19532 |
| [workspaceSearch.ts](../../src/lib/editor/workspaceSearch.ts) · `workspaceSearchStart` | 53 |
| [workspace_search.rs](../../src-tauri/src/workspace_search.rs) · `workspace_search_start` | 300 |


<a id="lang"></a>

## LANG — 语言服务与诊断

状态 owner：WorkspaceLspSessionManager；lspFiles；projectFactsStore；completion candidate/session identity；diagnostic presentation profile。

生产链：CodeWorkspaceTab → LSP session / project facts → lib/editor/lsp / workspaceTooling → Rust LSP/Maven/Gradle → 同 generation 数据 → completion/doc/problems；本轮 browser 没有真实 provider。

| 当前文件 / 符号 | 定位行 |
|---|---|
| [useWorkspaceLspSession.ts](../../src/components/editor/workspace/useWorkspaceLspSession.ts) · `export function useWorkspaceLspSession` | 202 |
| [lspCompletion.ts](../../src/components/editor/workspace/lspCompletion.ts) · `class LspCompletionController` | 798 |
| [completionScopeAdapter.ts](../../src/components/editor/workspace/completionScopeAdapter.ts) · `export` | 5 |
| [useProjectFacts.ts](../../src/hooks/useProjectFacts.ts) · `export` | 4 |
| [projectFactsStore.ts](../../src/stores/projectFactsStore.ts) · `export` | 14 |
| [lsp.ts](../../src/lib/editor/lsp.ts) · `lspOpenDocument` | 488 |
| [lsp.rs](../../src-tauri/src/lsp.rs) · `lsp_open_document` | 5573 |
| [inspectionProfile.ts](../../src/components/editor/workspace/inspectionProfile.ts) · `defaultInspectionProfile` | 56 |


<a id="refactor"></a>

## REFACTOR — 重构与代码动作

状态 owner：canonicalCodeActionService + frozen intention/refactor plan；workspaceEdit history / journal / recovery controller。

生产链：workspace.* refactor/format action → LSP codeAction/rename/format or local syntax plan → immutable preview → canonical applyPlan / resource edits → native files/undo/recovery；provider kind、完整性限制单独判断。

| 当前文件 / 符号 | 定位行 |
|---|---|
| [CodeWorkspaceTab.tsx](../../src/components/editor/CodeWorkspaceTab.tsx) · `id: "workspace.renameSymbol"` | 13834 |
| [RefactoringPreviewDialog.tsx](../../src/components/editor/workspace/RefactoringPreviewDialog.tsx) · `RefactoringPreviewDialog` | 20 |
| [refactorPlan.ts](../../src/components/editor/workspace/refactorPlan.ts) · `export` | 21 |
| [workspaceEditHistory.ts](../../src/components/editor/workspace/workspaceEditHistory.ts) · `export` | 13 |
| [safeDelete.ts](../../src/components/editor/workspace/safeDelete.ts) · `buildSafeDeleteWorkspaceEdit` | 59 |
| [reformatWorkflow.ts](../../src/components/editor/workspace/reformatWorkflow.ts) · `planReformat` | 42 |
| [workspaceSemanticEditing.ts](../../src/components/editor/workspace/workspaceSemanticEditing.ts) · `smartCompletionGate` | 34 |


<a id="git"></a>

## GIT — Git

状态 owner：workspace git snapshots、manager 多根选择/操作状态、diff pane 状态；repo/index/worktree 是数据 owner。

生产链：CodeWorkspaceTab openGit → MainLayout onOpenGitManager → WorkspaceGitManager / DiffViewer → lib/git → Rust git_* / 本地 Git → status/index/log/conflict；browser VFS 无 Git repo。

| 当前文件 / 符号 | 定位行 |
|---|---|
| [CodeWorkspaceTab.tsx](../../src/components/editor/CodeWorkspaceTab.tsx) · `id: "workspace.openGit"` | 14567 |
| [useWorkspaceGitSnapshots.ts](../../src/components/editor/workspace/useWorkspaceGitSnapshots.ts) · `useWorkspaceGitSnapshots` | 129 |
| [WorkspaceGitManager.tsx](../../src/components/git/WorkspaceGitManager.tsx) · `await gitStage` | 499 |
| [DiffViewer.tsx](../../src/components/git/DiffViewer.tsx) · `DiffViewer` | 23 |
| [git.ts](../../src/lib/git.ts) · `export function gitCommit` | 235 |
| [git.rs](../../src-tauri/src/git.rs) · `git_commit` | 390 |


<a id="run"></a>

## RUN — Build / Run / Debug / Test

状态 owner：execution model/config selection；Run/Build task state；useCodeDebugSession session/frame/variables/breakpoints/watch；coverage report owner。

生产链：toolbar / BottomDock → execution model / executeTaskPlan / run target → workspace_execution_*、PTY 或 DAP → process event/exit、stack/variables/test report → 编辑器 gutter 与 panels；SDK、构建工具、adapter 为外部依赖。

| 当前文件 / 符号 | 定位行 |
|---|---|
| [CodeWorkspaceTab.tsx](../../src/components/editor/CodeWorkspaceTab.tsx) · `const debug = useCodeDebugSession` | 17761 |
| [RunPanel.tsx](../../src/components/editor/workspace/panels/RunPanel.tsx) · `onRun` | 15 |
| [BuildPanel.tsx](../../src/components/editor/workspace/panels/BuildPanel.tsx) · `export function BuildPanel` | 80 |
| [TestsPanel.tsx](../../src/components/editor/workspace/panels/TestsPanel.tsx) · `export function TestsPanel` | 109 |
| [CoveragePanel.tsx](../../src/components/editor/workspace/panels/CoveragePanel.tsx) · `CoveragePanel` | 5 |
| [useCodeDebugSession.ts](../../src/components/editor/workspace/useCodeDebugSession.ts) · `dapStartSession` | 7 |
| [dap.ts](../../src/lib/editor/dap.ts) · `dapStartSession` | 28 |
| [dap.rs](../../src-tauri/src/dap.rs) · `pub async fn dap_start_session` | 858 |
| [workspace_execution.rs](../../src-tauri/src/workspace_execution.rs) · `workspace_execution_model` | 3902 |


<a id="set"></a>

## SET — 设置与快捷键

状态 owner：keymap v3 scheme / WorkspaceActionHost；editorAppearanceProfile；effective style/controller / EditorConfig cache。

生产链：Search Actions / toolbar / Settings → Dialog draft → apply/cancel → scheme/profile persistence → CM compartments、树与编辑器 CSS / keybinding dispatch；EditorConfig native parent-file reads。

| 当前文件 / 符号 | 定位行 |
|---|---|
| [KeymapSettingsDialog.tsx](../../src/components/editor/workspace/KeymapSettingsDialog.tsx) · `KeymapSettingsDialog` | 18 |
| [workspaceKeymapScheme.ts](../../src/components/editor/workspace/workspaceKeymapScheme.ts) · `KEYMAP_SCHEME_STORAGE_PREFIX` | 40 |
| [WorkspaceEditorAppearanceSettingsDialog.tsx](../../src/components/editor/workspace/WorkspaceEditorAppearanceSettingsDialog.tsx) · `WorkspaceEditorAppearanceSettingsDialog` | 10 |
| [editorAppearanceProfile.ts](../../src/components/editor/workspace/editorAppearanceProfile.ts) · `DEFAULT_EDITOR_APPEARANCE_PROFILE` | 82 |
| [CodeStyleSettingsDialog.tsx](../../src/components/editor/workspace/CodeStyleSettingsDialog.tsx) · `CodeStyleSettingsDialog` | 29 |
| [editorConfigResolver.ts](../../src/components/editor/workspace/editorConfigResolver.ts) · `export` | 24 |
| [workspaceStyleController.ts](../../src/components/editor/workspace/workspaceStyleController.ts) · `createWorkspaceStyleController` | 593 |

## REQ-01 P1 caller 补充（2026-09-14）

局部源内容与 P0 相同；实际 HEAD `884d003846a8549cc3125090eaf55359bc676a3f`。详细 [Find 修复设计 §3](../../docs-issue/code-workspace-find-focus-design.md)补出 `editor.find → runViaHandlers → openSearchPanel → WorkspaceSearchPanel.mount.select → content blur → lspHyperlink.clearMod.dispatch`。mount 的源码调用是 select（隐式 focus），不是显式 focus；CodeMirrorHost 的生产 hyperlink hooks 只传 onDefinition，没有传 probeDefinition。现有 docChanged microtask 修复不覆盖 blur 清理。上述事实只支持局部因果链，不宣称 native 已复现，也不将 query 两匹配说成失效。

保留消费者包括 EditorGroup 两个 Host caller、Tab semantic navigation→lsp_definition→真实 reveal/history、shared document undo、clipboard owner generation、IME 与 view snapshot。只有 caller 证明必要才扩大产品 owner；本次没有修改产品或执行其测试。
