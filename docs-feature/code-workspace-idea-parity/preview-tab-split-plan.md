# 预览标签转正式、分屏共享与非最后视图释放：P1 规划与 P2 交付设计

<a id="ed-parity-003"></a>

## ED-PARITY-003

- **唯一任务来源**：[backlog.md](backlog.md) / `ED-PARITY-003`；P0 `AUDIT-20260913-01`，来源 [REQ-04](overall-audit-plan-20260913.md#req-04) / [CW-TAB-001](capability-matrix.md#cw-tab-001)、[CW-TAB-002](capability-matrix.md#cw-tab-002)。
- **起点材料**：[task-planning.md#ed-parity-003](task-planning.md#ed-parity-003)、[IDEA 真实参考包](references/ed-parity-003-reference.md)、[P2 交接文档](handoff-p2-ed-parity-003.md)。
- **当前工程基线**：分支 `docs/code-workspace-idea-audit-20260913`，HEAD `17beeabb2c26345f63b0abcf495d5fd5efe01f65`，工作区干净。
- **本轮权限**：仅限文档阅读、IDEA 最小独占采样、设计方案制定、AC/V 细化与任务板状态更新；所有 Taomni 产品代码修改、构建与运行产品测试在 P1 阶段均为**未执行**。

本包产物是 **一个文件经 preview→编辑转正式→分屏→关闭非最后 view 的完整保留与一致性设计**。边界严格收敛于该连续用户场景，不在此包中扩充全部标签策略（如 MRU 堆栈遍历、跨窗口自由拖拽、关闭策略弹出设置或崩溃后布局重建）。

---

## 现状事实、差异归因与保留契约

| 类别 | 当前事实及结论边界 |
|---|---|
| **已有生产基础** | 生产代码已具备多标签管理与分屏基础：`CodeWorkspaceTab.tsx` 具备 `promotePreviewTab`、`splitEditor`、`closeFile`；`EditorGroup.tsx` 支持 `previewKey`、`onPromotePreview`、`italic` 样式与双击 promote；`workspaceDocumentTransactionOwner.ts` 实现了跨多视图的共享文档事务与引用计数租约（`acquireView` / `releaseView`）；`recursiveLayoutTree.ts` 支持树形分屏原子变异。 |
| **当前证据缺口** | 虽有底层代码，但在 P0 首次评估（2026-09-13）中仅记录了双 Pane 静态状态（B10），缺乏完整的连续交互证据链：从 preview 打开、双击/输入转正、分屏双视图、光标独立移动、共享输入与 Undo、到最后关闭非最后 view 的端到端真实观测此前未覆盖。 |
| **已采 IDEA 行为** | 目标环境 IntelliJ IDEA 2026.2.2 Ultimate（build IU-262.10315.125）实测确认：① 预览标签文字呈斜体（italic），通过双击标签或在编辑器中输入即可立即转为正体正式标签；② Split Right 后拆分为左右两个独立 Pane，各具独立光标与选区；③ 在任一侧输入内容，另一侧实时同步呈现，且 Undo 为一次共享撤销；④ 关闭右侧分屏视图后，左侧视图仍保持打开，文档内容与 dirty 状态完整保留。详见 [REF-PARITY-003-WIN-20260919](references/ed-parity-003-reference.md)。 |
| **视觉/交互细节** | 当前 Taomni 的 Tab 栏在 `previewKey` 时已具备 `italic` 样式和 `data-preview="true"` 属性；双击触发 `onPromotePreview`，在编辑修改时亦会触发 `onPromotePreview(activeFile.key)`。关闭分屏时，`closeFile` 内部有 `usedByOtherGroup` 保护，非最后 view 关闭不触发确认弹窗且不清理 buffer。需在 P2 中通过完整用例锁定此行为链。 |
| **非本包目标** | 不扩充完整的 Tab Policy 设置页面改版；不包含全部 45 场景的全局状态迁移；不改造 LSP 后端通讯协议。 |

---

## 生产链、文件责任与共享消费者

行号基于当前 HEAD `17beeabb2c26345f63b0abcf495d5fd5efe01f65`，P2 实施时按符号核对。

| 文件 / 符号 | 责任边界、接口契约与共享消费者 |
|---|---|
| [CodeWorkspaceTab.tsx](../../src/components/editor/CodeWorkspaceTab.tsx)<br>`openFile` (3180), `promotePreviewTab` (7119), `splitEditor` (7140), `closeFile` (6899) | **主状态与流程编排**：<br>1. `openFile`：根据 options.preview 与 tabPolicy 设置 `group.previewKey`，复用或新建 tab；<br>2. `promotePreviewTab`：将目标 groupId 中的 `previewKey` 清除为 `null`；<br>3. `splitEditor`：调用 `splitLayoutLeaf` 拆分布局并在新 leaf 中打开同名文件；<br>4. `closeFile`：通过 `usedByOtherGroup` 判断是否为最后视图。若仍被其他 group 使用，则仅从当前 leaf 移除 tab，不触发 `didClose`，不清除 buffer，不弹丢弃警告。 |
| [EditorGroup.tsx](../../src/components/editor/workspace/EditorGroup.tsx)<br>`previewKey`, `onPromotePreview` (180, 646, 723, 876) | **Tab 栏渲染与输入监听**：<br>1. 渲染 tab：当 `key === previewKey` 时，标题附加 `italic` 类，DOM 属性 `data-preview="true"`；<br>2. 交互转正：双击 tab 触发 `onPromotePreview(key)`；在编辑器中发生内容变化时（876行），若当前处于 preview 态，自动调用 `onPromotePreview(activeFile.key)` 转正；<br>3. 提供 `Open in Split Right` 菜单入口。 |
| [workspaceDocumentTransactionOwner.ts](../../src/components/editor/workspace/workspaceDocumentTransactionOwner.ts)<br>`WorkspaceDocumentTransactionOwner` (192) | **跨视图共享文档事务中心**：<br>1. `acquireView(fileKey, viewId, text, revision)`：同一文档挂载新视图，引用计数 +1，返回权威正文；<br>2. `releaseView(fileKey, viewId)`：视图关闭时解除绑定。若 `views.size > 0`，保留文档和历史栈，返回 `false`；仅当 `views.size === 0` 时销毁文档记录；<br>3. `dispatchTransaction`：广播文本变更并记录共享 Undo 栈。 |
| [CodeMirrorHost.tsx](../../src/components/editor/workspace/CodeMirrorHost.tsx)<br>`CodeMirrorHost` (2210) | **独立视图呈现**：<br>1. 每个 EditorGroup 拥有独立的 `CodeMirrorHost` 实例；<br>2. 独立持有 Selection、Caret 位置与视口滚动，互不干扰；<br>3. 将用户击键转换为事务并通过 `transactionOwner` 广播给配对视图。 |
| [recursiveLayoutTree.ts](../../src/components/editor/workspace/recursiveLayoutTree.ts)<br>`atomicSplitLeaf` (672), `atomicCloseLeaf` (638) | **纯函数布局树计算**：<br>负责 `split` 和 `close` 动作下的布局树变异，保证 leaf 节点与 group 状态的一致性。 |
| [ProjectTree.tsx](../../src/components/editor/workspace/ProjectTree.tsx)<br>`onClick`, `onDoubleClick` (197, 200) | **共享消费者（保护既有合同）**：<br>保留 REQ-02 已交付成果：单击只选择节点，双击调用 `onOpenFile(ref, { preview: false })` 正式打开。 |

---

## 本卡架构与设计决定（DEC）

- **ED-PARITY-003-DEC-01（首包边界收敛）**：本卡严格聚焦于一个文件的连续闭环场景（preview 打开 → 编辑自动转正 → 左右分屏 → 独立光标与选区 → 共享编辑与单次撤销 → 关闭非最后视图保持存活）。不扩展至未决的全局 MRU、自由拖拽或重启恢复。
- **ED-PARITY-003-DEC-02（Preview 状态与转正行为）**：
  1. 处于 preview 态的 Tab 标题文字呈现斜体（`italic`），DOM 标记 `data-preview="true"`；
  2. 触发转正的完整路径：① 双击该预览 Tab；② 在预览打开的编辑器中键入任意字符或修改内容；③ 再次通过正式途径（如树双击/Enter）打开同文件；
  3. 转正后，清除 `previewKey`，文字变为正体，DOM 移除 `data-preview` 标记。
- **ED-PARITY-003-DEC-03（分屏与文档事务共享）**：
  1. 触发 `splitLayoutLeaf`（或 Tab 右键菜单 Open in Split Right），创建新的 EditorGroup 并挂载同文件；
  2. 两侧视图向同一个 `WorkspaceDocumentTransactionOwner` 注册租约（`acquireView`），共享相同文档实例；
  3. 任一侧的文本编辑通过 `dispatchTransaction` 实时同步至配对视图；Undo 操作作用于集中式历史栈，一次 Undo 同时恢复所有视图的正文。
- **ED-PARITY-003-DEC-04（视图选择与光标隔离）**：
  1. 两侧视图各自维护独立的 CodeMirror `EditorState` 中的 Selection 与 Caret；
  2. 左侧视图选中一段文本（Selection 存在），右侧视图的光标停留在末尾（Selection 为空），两侧选区高亮互不干扰。
- **ED-PARITY-003-DEC-05（非最后视图释放与资源保活）**：
  1. 关闭分屏中的一个视图时，`closeFile` 检测到 `usedByOtherGroup = true`；
  2. 仅从当前 EditorGroup 移除该 Tab 并调用 `transactionOwner.releaseView`；
  3. 由于剩余 view count > 0，**严禁触发** LSP `didClose`，严禁清除 `openFiles` 中的文档 buffer，严禁清除 `saveTransactionRegistry`；
  4. 若文档处于未保存（dirty）状态，关闭非最后视图**不弹出**确认对话框，另一侧视图继续保持 dirty 状态及正文；
  5. 仅当关闭该文件的最后一个视图时，才按照标准流程触发确认弹窗及完整的资源清理。
- **ED-PARITY-003-DEC-06（既有行为与回归保护）**：
  1. 严格保护 REQ-02 项目树单击只选、双击/Enter 正式打开的既有合同；
  2. 保护单视图 dirty 文件关闭时的确认弹窗与 Cancel 取消零变化行为；
  3. 保护 LSP 语义高亮、诊断与定义跳转在多视图下的稳定性。
- **ED-PARITY-003-DEC-07（证据集合与跨平台验证要求）**：
  1. 所需证据类型：`code-audit`、`unit`、`typecheck`、`browser`、`native`、`idea-comparison`；
  2. 单元测试覆盖转正逻辑、分屏共享文档、独立选区与非最后视图释放；
  3. Windows/WebView2 原生环境集中执行 TC-IDE-PARITY-003 原生测试；
  4. 对照 REF-PARITY-003-WIN-20260919 产出双侧功能与交互结论。

---

## 连续用户场景与精确断言（S0..S7）

使用 [F0/F1 fixture](references/fixture-catalog.md#f0) 中的 `example.txt`（初始内容为两行纯文本，UTF-8 LF，无未保存修改）。

| 步骤 | 操作动作与触发时点 | 必须满足的可观察断言 |
|---|---|---|
| **S0** | 处于干净状态，以 preview 模式打开 `example.txt` | Tab 栏出现 `example.txt`，标题呈现斜体（`italic`），DOM 具有 `data-preview="true"`，正文正确渲染，光标在 1:1，dirty 为 false。 |
| **S1** | 在编辑器中键入文本，或双击该 Tab 标题 | Tab 标题立即从斜体变为正常字体，DOM 属性 `data-preview` 移除，成为正式标签；若键入内容则 dirty 变为 true。 |
| **S2** | 在 Tab 右键菜单选择 “Open in Split Right” | 触发 `splitLayoutLeaf`；编辑器拆分为左右两个独立 Pane，两侧均打开 `example.txt`；右侧 Pane 获得焦点。 |
| **S3** | 在右侧 Pane 移动光标至行尾；切换至左侧 Pane 选中第 1 行文本 | 左侧 Pane 显示可见的高亮选区；右侧 Pane 选区为空且光标保持在行尾。断言两侧 Selection 与 Caret 完全隔离。 |
| **S4** | 在左侧 Pane 键入新内容 `// SHARED-SYNC-OK` | 右侧 Pane 立即实时同步呈现相同文字；两侧 Tab 均显示 dirty 标记；底层 `transactionOwner` 记录一次同步变更。 |
| **S5** | 在任一侧 Pane 执行一次 Ctrl+Z（Undo） | 两侧 Pane 中刚键入的文字同时被撤销回滚，文本恢复原状；断言多视图共享单次撤销历史。 |
| **S6** | 聚焦右侧 Pane，按 Ctrl+F4（或点击 Tab 上的关闭按钮） | 右侧 Pane 被移除，编辑器恢复单 Pane 布局；左侧 Pane 中的 `example.txt` 仍然打开且内容完整无损；断言**没有**向 LSP 发送 `didClose`，没有从内存丢弃 buffer。 |
| **S7** | 再次关闭左侧最后的 `example.txt` 视图 | 若处于 dirty 状态，弹出确认关闭对话框；点击 Cancel 零变化保留视图；确认关闭后文档彻底关闭，释放 LSP 与内存资源。 |

---

## 验收条件（AC）与验证映射（V）

| 验收编号 | 必须满足的具体断言 | 对应验证手段 |
|---|---|---|
| **ED-PARITY-003-A1** | **核心功能**：<br>1. Preview Tab 具备斜体标识与 `data-preview="true"`；双击或编辑输入能可靠转为正式 Tab；<br>2. 分屏后多视图共享同一文档正文与单次 Undo；<br>3. 各分屏视图的 Caret、Selection 与滚动状态独立；<br>4. 关闭非最后视图只释放当前视图租约，不触发 `didClose`，不销毁 buffer，不丢失 dirty 状态。 | V1, V2, V3 |
| **ED-PARITY-003-A2** | **双侧一致性**：<br>对照 [REF-PARITY-003-WIN-20260919](references/ed-parity-003-reference.md) 实际 IDEA 观察事实，在相同 fixture 下对功能、视觉与交互给出逐项结论。缺侧或非本包范围保持明确 unverified，不虚构 matched。 | V1, V4 |
| **ED-PARITY-003-A3** | **保留行为保护**：<br>1. 最后一个视图 dirty 关闭时弹窗提示，点击 Cancel 零修改保留；<br>2. 保持 REQ-02 项目树单击只选、双击/Enter 正式打开的行为；<br>3. 保持 LSP 诊断高亮与跳转正常，改动不破坏共享消费者。 | V1, V2, V3 |

### 验证手段详细说明

- **ED-PARITY-003-V1（code-audit / document）**：
  核对 `CodeWorkspaceTab.tsx`、`EditorGroup.tsx`、`workspaceDocumentTransactionOwner.ts` 与 `CodeMirrorHost.tsx` 的调用链路；核对 `usedByOtherGroup` 的边界逻辑与未提交 diff。
- **ED-PARITY-003-V2（unit / typecheck）**：
  编写/运行定向单元测试：
  - `EditorGroup.test.tsx`：验证双击 promote、渲染 italic 样式；
  - `CodeWorkspaceTab.test.tsx`：验证从 preview 转正、分屏打开同名文件、编辑同步、以及关闭非最后 view 时不销毁 buffer 的行为断言；
  - `workspaceDocumentTransactionOwner.test.ts`：验证多 viewId 下的租约计数、单次 undo 与最后 view release 时的状态销毁；
  - 执行 `typecheck_scope.py` 覆盖所有修改的 TypeScript 文件。
- **ED-PARITY-003-V3（native / browser）**：
  - Browser 挂载测试：通过 Vitest/jsdom 运行组件挂载与交互断言；
  - Windows 原生验证：使用 `qa_ui_auto` 原生驱动在打包的 debug 原生 QA 二进制（`com.taomni.app.qa`）上运行用例，记录 S0..S7 的实际原生状态。
- **ED-PARITY-003-V4（idea-comparison）**：
  结合 `REF-PARITY-003-WIN-20260919` 中记录的 8 组状态截图与 JSON，对比两侧在分屏、选区独立、编辑同步与关闭非最后 view 的具体表现。

---

## 实施建议与快速命令（供 P2 使用）

P2 可使用的现有测试命令（本轮均未执行）：

```powershell
# 1. 运行相关单元测试
pnpm exec vitest run src/components/editor/workspace/EditorGroup.test.tsx src/components/editor/workspace/workspaceDocumentTransactionOwner.test.ts -t "promotes|lease|views|multiview"

# 2. 运行 CodeWorkspaceTab 相关测试
pnpm exec vitest run src/components/editor/CodeWorkspaceTab.test.tsx -t "split|preview|closeFile" --maxWorkers=1

# 3. 类型检查
python .agents/skills/code-workspace-idea-task/scripts/typecheck_scope.py --path src/components/editor/CodeWorkspaceTab.tsx --path src/components/editor/workspace/EditorGroup.tsx --path src/components/editor/workspace/workspaceDocumentTransactionOwner.ts
```
