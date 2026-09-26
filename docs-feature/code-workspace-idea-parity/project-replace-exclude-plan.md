# 项目替换：范围/掩码、结果排除、确认预览、取消、提交与撤销

<a id="ed-parity-006"></a>

## 1. 身份、范围与规划门槛

- 唯一卡：[backlog.md](backlog.md) `ED-PARITY-006`；来源 [REQ-08](overall-audit-plan-20260913.md#req-08) / [CW-SEARCH-002](capability-matrix.md#cw-search-002)；回链 [P0 首包](task-planning.md#ed-parity-006)。沿用 `AUDIT-20260913-01`，不重跑整体评估。
- 2026-09-26 P1 基线：分支 `docs/code-workspace-idea-audit-20260913`，HEAD `7987fbd7be10c20c81e7107fa37d8b30fc49b458`，开始时工作区干净。只读生产源码、写设计/参照/交接；没有 claim、开发 owner、产品或测试修改、产品测试、构建、Taomni 启动或提交，未启动其他 agent。
- IDEA 目标：用户确定 **2026.2.3 / IU-262.10968.63**（仅本卡）。用户授权 15 分钟桌面，已在隔离工程实采 R1–R8，见[参照包](references/ed-parity-006-reference.md#observed)。
- 用户结果：隔离两文件 fixture → Directory=`src` + mask `*.txt` 搜索 `token` 得 3 条 → 在**结果列表**排除 1 条 → Replace All 打开确认预览（计数已扣除排除项）→ Esc/Cancel 零写入 → 再次确认提交 2 处 → 结果只剩排除行 → 在非编辑器焦点 Ctrl+Z 弹确认 → OK 一次撤销两文件。冲突负路径限定为“预览后外部修改一个文件”和“目标文件在编辑器 dirty”两种，均零写入。
- 不纳入：搜索引擎/ripgrep 重构、regex 捕获组替换、Find 工具窗 tab 历史/pin、结构搜索（ED-PARITY-009）、编辑器内 Ctrl+Z 的确认语义（IDEA 未采，保持现状）。
- **P1 规划就绪，产品验证全部未执行。** 用户已决定撤销语义对齐 IDEA（DEC-06）。

## 2. 当前生产事实与差距分类

入口与效果链（2026-09-26 源码核对，行号仅定位）：`workspace.findInFiles` Ctrl+Shift+F / `workspace.replaceInFiles` Ctrl+Shift+R（`CodeWorkspaceTab.tsx:14231-14248`，后者仅打开同一面板并出状态提示）→ `openFindInFiles`（`:3669`）→ `FindInFilesPanel`（`panels/FindInFilesPanel.tsx`）的 `scopePlan`（`planFindInFilesScope`，`findInFilesScopeModel.ts`）→ `startSearch` → `workspaceSearchStart/cancel`（`lib/editor/workspaceSearch.ts` → Rust `workspace_search.rs`；browser 为 `stubs/tauri-core.ts:2722` VFS grep，已支持 include/exclude glob）→ 分组结果 → `replaceAll`（冻结 scope/query/replacement/matches，`onPrepareReplacePreimages`→`collectReplacePreimages` 读 preimage，token/AbortController 防迟到）→ `ReplacePreviewDialog`（每处/每文件 checkbox 排除、`Replace N`/Cancel）→ `commitReplacePreview`（`validateReplacePreviewSelection`）→ `onReplaceMatches`（`CodeWorkspaceTab.tsx:20227`：workspace instance、选择校验、全集 preflight `validateReplacePreflight` + `verifyReplaceMatchFreshness`、`applyLspWorkspaceEdit` kind=replace + expected preimage/hash、`summarizeReplaceCommitReport`、recovery id）→ `WorkspaceEditHistory` 一次 undo。撤销：`workspace.undoWorkspaceEdit`（`:15073`，`when` 排除 tree/terminal/editor 焦点）与编辑器内 `claimWorkspaceHistory`（`:10901`）。

| 类别 | 事实 | 依据 |
|---|---|---|
| 已有且满足（待本卡复验） | scope/mask 计划与 fail-closed、冻结预览快照、preimage 预读与迟到丢弃、全集 preflight、外部修改/dirty/只读阻断、真实 ledger、一次多文件 undo、UTF-16/大小写路径 | `FindInFilesPanel.test.tsx` ED-FIND-003/004、ED-REPAIR-005/006；TC-IDE-D2-01/02、AUDIT-003（均 stale/Windows 未验证） |
| 确认缺陷 G1 | 结果列表**无法排除**；排除只存在于预览弹窗。结果行是按钮，无 Delete/右键/排除态 | 源码 `FindInFilesPanel.tsx:1075-1093`；IDEA R5 |
| 确认缺陷 G2 | 提交成功后结果列表不变：已替换的行仍显示旧文本并可再次打开/提交（冻结预览随后会以 freshness 冲突拒绝，但用户看到的是陈旧集合） | `commitReplacePreview` 只 `setReplacePreview(null)`；IDEA R7 移除已替换行 |
| 确认缺陷 G3 | 在 Search query / Replace text 等输入框按 Ctrl+Z：`commandFocusForTarget` 归为 `modal`，`workspace.undoWorkspaceEdit` 可用 → 直接撤销磁盘替换，而不是撤销输入框文字；无确认 | `CodeWorkspaceTab.tsx:15580-15591`、`:15085`；TC-IDE-D2-02 依赖此行为 |
| 体验差异 G4 | 撤销多文件替换无确认；IDEA 弹 “Undo Replace?” OK/Cancel | IDEA R8；用户 2026-09-26 选“对齐 IDEA” |
| 体验差异 G5 | 预览弹窗无 Esc 取消、Enter 提交、打开时聚焦主按钮与关闭后回焦；标题无“Replace N occurrences of 'q' across M files with 'r'?” 摘要 | `ReplacePreviewDialog.tsx` 无 keydown/autoFocus；IDEA R6 |
| 已接受差异 | Taomni 冻结预览保留逐处 checkbox 与 scope 标签（IDEA 确认框无列表）；提交/撤销直接落盘（IDEA 撤销后需保存才落盘）；入口是底部 Search 面板而非浮动 popup | DEC-03/DEC-07 |
| 待运行归因 R1 | 工作区 capture keydown 是否先于弹窗吞掉 Esc/Enter（`isSurfaceOwnedKeyEvent` 未列入 `code-workspace-replace-preview`） | P2 先写失败测试确认，再决定是否加入 surface 列表 |
| 待运行归因 R2 | 同一行多处命中时，排除保留的行在提交后列/偏移失效 | 本 fixture 每行一处，不触发；DEC-05 规定剩余行保留原坐标仅作展示，再次替换必须重新搜索 |

## 3. 决定与实现责任

- **DEC-01 范围/掩码保留**：不改 `planFindInFilesScope`、搜索 IPC 与 VFS stub；Directory=`src` + include `*.txt` 必须得到参照 3 matches / 2 files，`c.md`、`other/d.txt` 不出现。仅作回归断言。
- **DEC-02 结果列表排除（修 G1，feature-design）**：`FindInFilesPanel` 持有 `excludedMatchKeys: Set<workspaceSearchMatchKey>`，随 `searchId` 生命周期：新搜索/`teardownSearch` 清空，折叠/Show more 保留。结果行可聚焦（`data-testid="code-workspace-find-match-row"`，`data-match-key`、`data-excluded`，`aria-selected`）；焦点行 **Delete** 切换排除/恢复并把焦点移到下一可见行（无下一行则上一行），与 IDEA R5 相同；文件组标题行 Delete 切换该文件全部行。右键菜单项 `Exclude` / `Restore`（`data-testid="code-workspace-find-row-exclude"` / `-restore`）为鼠标等价入口。排除行 `line-through` + muted 色（复用 `--taomni-code-muted`），仍可单击预览/双击打开；文件计数保持总数（IDEA R5）。Arrow Up/Down 在行间移动焦点；Enter 等价双击打开。Delete/Arrow 只在结果行焦点内处理，不影响输入框（输入框内 Delete 仍删字符）。
- **DEC-03 确认预览（修 G5 之摘要）**：保留 `ReplacePreviewDialog` 作为 Replace All 的唯一确认边界及冻结快照（不改 `replaceAll`/`commitReplacePreview` 冻结与校验链）。新增 prop `initialExcludedKeys`：`replaceAll` 用 `usageJoinKeyForMatch` 把 `excludedMatchKeys` 转为 `stableUsageKey` 传入，弹窗初始 checkbox 即为未选；弹窗内继续可逐处调整（Taomni 附加能力，已接受差异）。头部新增 `data-testid="code-workspace-replace-summary"`：`Replace {included} occurrences of '{query}' across {files} files with '{replacement}'?`，files 为含至少一处 included 的文件数；保留既有 `code-workspace-replace-counts` 文本不变以兼容 D2-01/02。结果列表全部排除时 Replace All 禁用（`title="All results are excluded"`），不打开弹窗。
- **DEC-04 弹窗键盘与焦点（修 G5）**：打开时焦点落在 `code-workspace-replace-commit`；Tab/Shift+Tab 在弹窗内循环；Esc = Cancel（零写入，关闭，焦点回 Replace All 按钮）；Enter 在主按钮或弹窗非 checkbox 区域 = 提交（checkbox 上 Enter 不提交，Space 切换）；`committing` 期间 Esc/Enter 无效。若 R1 证实 capture 吞键，把弹窗加入 `isSurfaceOwnedKeyEvent`。提交失败保持弹窗、错误 `role="alert"`、焦点留在主按钮。
- **DEC-05 提交后结果（修 G2）**：`onReplaceMatches` 返回 ok 时，从 `groups` 移除本次已提交的 match key，空组删除；排除行保留删除线；header 计数改为剩余数并追加 `data-testid="code-workspace-find-replaced-notice"`：`Replaced {n} occurrences in {m} files`。失败/部分失败不修剪（ledger 与 recovery 消息保持现状）。剩余行坐标不重算：再次 Replace All 走既有 freshness 校验，失配即阻断并提示重新搜索。焦点移到剩余第一行，无剩余则回 Search query。
- **DEC-06 撤销路由（修 G3/G4，用户已定）**：
  1. 目标在非 CodeMirror 的 `input`/`textarea`（Search query、Replace text、include/exclude、directory 等）时，Ctrl/Cmd+Z、Ctrl/Cmd+Shift+Z、Ctrl+Y 不进入工作区派发，保留原生文字撤销。实现位于 `handleWorkspaceCommand`（或 `workspace.undoWorkspaceEdit`/`redo` 的 `when` 读取目标），不改 host 的其他 modal 语义。
  2. 在结果列表/面板按钮/底部 dock 非输入焦点，`workspace.undoWorkspaceEdit` 先弹工作区确认框（`data-testid="code-workspace-undo-confirm"`，标题 `Undo`，正文 `Undo {undoLabel}?`，`-ok` / `-cancel`，焦点在 OK，Esc=Cancel）：OK 调既有 `undoWorkspaceEdit`，Cancel 零效果、历史不变。命令面板/菜单调用同一 action，因而同样确认。
  3. 编辑器内 Ctrl+Z 的 `claimWorkspaceHistory` 路径与 redo 不加确认（IDEA 未采，保持现状，记为未比较）。Rename 等其他 workspace edit 在非编辑器焦点撤销也会确认，这是有意改变，须回归。
- **DEC-07 落盘语义保留**：Taomni 提交与撤销直接写盘并更新打开缓冲（既有 applier/ledger/recovery），不引入 IDEA 的“撤销后待保存”。已接受差异，比较中单列。
- **DEC-08 冲突范围**：只验证 (a) 预览打开后外部改写 `src/b.txt` → 提交被 `changed on disk since the frozen replace preview` / freshness 阻断，四文件零写入，弹窗保持；恢复字节后同一冻结预览可提交；(b) `src/a.txt` 已打开且 dirty → `has unsaved modifications` 阻断零写入，保存后需重开预览。均沿用既有消息，不新增文案。IDEA 侧未采（参照 §4 C1/C2），不签比较结论。
- **DEC-09 Replace in Files 入口**：保持 Ctrl+Shift+R 打开同一面板；改为把焦点放到 Replace text（若 query 为空则 Search query），去掉“Enter a replace string…”状态提示。对应 IDEA popup 在 Replace 模式直接可输入（R3）。

### 文件/符号责任与共享消费者

| 文件 / 符号 | 责任 |
|---|---|
| `src/components/editor/workspace/panels/FindInFilesPanel.tsx`：`excludedMatchKeys`、结果行渲染、`replaceAll`、`commitReplacePreview`、DEC-05 修剪 | DEC-02/03/05 主 owner |
| `panels/ReplacePreviewDialog.tsx`：`initialExcludedKeys`、summary、keydown/focus | DEC-03/04 |
| `src/components/editor/CodeWorkspaceTab.tsx`：`handleWorkspaceCommand` 输入框豁免、`workspace.undoWorkspaceEdit` 确认、`workspace.replaceInFiles` 聚焦、`isSurfaceOwnedKeyEvent`（仅 R1 证实时）、FindInFilesPanel 新 prop（如 `replaceFocusNonce`） | DEC-04/06/09 |
| 共享消费者（只回归不改） | `workspaceEditHistory.ts`；Rename/Refactor undo（TC-IDE-C6-04，编辑器焦点）；AUDIT-003 冲突 ledger；本地 Find（`editorSearchPanel.ts`，TC-IDE-FINDFOCUS-01）；Search Everywhere Text 预置 `queryPreset`；Find in Directory `includePreset`；`workspaceActionRegistry.ts` 标题/键位不变 |

新增 testid 仅上列；`qa-ui-auto-tests/feature-list.md` F25.5 controls 由 P2 同步。三端：纯 renderer 与键路由，无平台特定 API；macOS 以 Cmd 修饰，`press: Mod+z` 覆盖。

## 4. 连续场景与 UI 目标

| 步 | 操作 | 关键状态 / 焦点 | 最终结果 |
|---|---|---|---|
| S0 | 打开 F1-REPL-006 workspace；Ctrl+Shift+F | 底部 Search 面板，焦点 Search query | 无结果、无弹窗 |
| S1 | scope=Directory、目录 `src`、include `*.txt`、query `token`、Enter | 状态 done | 3 results · 2 files；组 `src/a.txt`（2）、`src/b.txt`（1）；无 `c.md`、`other/d.txt` |
| S2 | 点 `a.txt:2` 行，Delete | 行 `data-excluded=true`，删除线；焦点移到 `b.txt:1` | 组计数仍 2；Search query 文本不变 |
| S3 | 右键 `a.txt:2` → Restore；再右键 → Exclude | 恢复/再排除各一次 | 同 S2 |
| S4 | Replace text 填 `coin`，点 Replace All | 弹窗焦点在 `Replace 2`；summary `Replace 2 occurrences of 'token' across 2 files with 'coin'?`；a.txt:2 checkbox 未选 | counts `2 of 3 occurrences` |
| S5 | Esc | 弹窗关闭，焦点 Replace All | 四文件字节 = 初值；结果与排除态不变 |
| S6 | Replace All → Enter | 提交 | 磁盘/缓冲为参照提交字节；结果只剩删除线的 `a.txt:2`；notice `Replaced 2 occurrences in 2 files`；焦点在剩余行 |
| S7 | 焦点 Search query，Ctrl+Z | 输入框文字撤销（或无变化） | 磁盘仍为提交字节；无确认框 |
| S8 | 焦点剩余结果行，Ctrl+Z | 确认框 `Undo Replace in files?`，焦点 OK | — |
| S9 | Cancel；再 Ctrl+Z → OK | Cancel 零效果；OK 后状态栏 `Undid Replace in files (2 files)` | 四文件 = 初值 |
| S10 | 重新搜索、排除 a.txt:2、Replace All；外部改写 `src/b.txt`；Enter | 弹窗保持，`code-workspace-replace-commit-error` 含 `changed` | 零写入；恢复 b.txt 字节后 Enter 提交成功 |
| S11 | 打开 a.txt 键入未保存字符，Replace All → Enter | 阻断 `has unsaved modifications` | 零写入；Ctrl+S 后重开预览可提交 |

UI 规格：结果行高度 24px 不变；排除态只改 `text-decoration: line-through` 与颜色角色 muted，不另加图标；焦点行复用 `--taomni-code-active-line-bg` + 可见 focus ring；右键菜单复用工作区 context menu 组件（`data-taomni-context-menu`）。确认框复用 dock 内遮罩层布局，宽 ≤ 560px；undo 确认框与 IDEA 一样为小模态（标题、单句、OK/Cancel），不列文件。无结构性布局变化，不另出图稿；IDEA 画面见参照 R4–R8 原件。

## 5. 本卡 AC 与 V

- **ED-PARITY-006-A1**（目标）：S1–S6、S10–S11 — scope/mask 集合准确；结果列表 Delete/右键排除与恢复、焦点移动；Replace All 预览计数/summary 扣除排除项；Esc/Cancel 零写入；提交集合与字节准确、提交后列表修剪；外部修改与 dirty 两类冲突零写入并可恢复。→ V1、V3、V4。
- **ED-PARITY-006-A2**（比较）：同 F1-REPL-006 的 IDEA R1–R8 与 Taomni 对应状态分别给功能/UI/交互结论与证据身份；DEC-03/07 为已接受差异，C1–C5 未采项标 unverified；不签 matched。→ V5。
- **ED-PARITY-006-A3**（保留与撤销）：S7–S9 — 输入框 Ctrl+Z 不触碰磁盘；非编辑器焦点撤销有确认、Cancel 零效果、OK 一次恢复两文件；冻结 preimage/迟到丢弃/workspace 实例校验保留；编辑器内 Rename 撤销、AUDIT-003 ledger、本地 Find、Find in Directory/Search Everywhere 预置入口不退化。→ V2、V4、V6。

验证种类（与 metadata 一致）：`code-audit`（生产链逐步复核）、`unit`（V1/V2/V6 单测，含 G1–G3 改前失败）、`typecheck`（owned paths 一次 scoped）、`browser`（V3/V4 前半）、`native`（V4，Windows 当前端）、`idea-comparison`（V5）。

<a id="test-cases"></a>

## 6. 完整测试用例设计（P2 待实现/执行）

所有“拟新增”路径当前不存在，均为 **P2 待实现**，状态 unrun；现有用例状态以 2026-09-26 只读 `status` 为准（D2-01 browser stale、D2-02 native stale、AUDIT-003 Windows unverified：`native_click requires Linux/X11`）。全部 `covers: [F25.5]`。

**Fixture（P2 实现）**：新增 `.agents/skills/qa-ui-auto/scripts/qa_ui_auto/fixtures/parity006_replace.py`，注册 `REGISTRY` 与 `schema/testcase.schema.json`。browser：按 `parity005_completion.py` 模式在 `/preview/parity006` 写入参照 §2 四个文件并写 `taomni.recentWorkspaces.v1`；native：在 `report_root/native-workspaces/` 建临时目录写相同字节。导出 `${fixture.parity006_root}` 及各文件初值/提交值 SHA-256（由生成字节计算，不手抄）。清理：browser 由 `reset_db`，native 保留于报告根。

### V1 — 结果列表排除、预览播种与提交修剪（unit，A1）

文件：`src/components/editor/workspace/panels/FindInFilesPanel.test.tsx` 新增 `describe("ED-PARITY-006: result exclusion, seeded preview and post-commit pruning")`；`panels/ReplacePreviewDialog.test.tsx` 新增 `describe("ED-PARITY-006: seeded exclusion, summary and keyboard")`。沿用文件内现有 stub 搜索事件与 `onReplaceMatches` mock。

| 测试名（拟新增） | 前置 / 操作 | 预期 |
|---|---|---|
| `ED-PARITY-006 Delete on a focused result row toggles exclusion and moves focus` | 3 条结果；focus a.txt:2 行，`keyDown Delete`；再 Delete | 第一次 `data-excluded="true"`、焦点在 b.txt:1；组计数仍 2；第二次在 b.txt 行上切换 b.txt；对 a.txt:2 再 Delete 恢复 |
| `ED-PARITY-006 Delete on a file header toggles every row of that file` | focus a.txt 组标题 Delete | a.txt 两行排除；b.txt 不变；再 Delete 全恢复 |
| `ED-PARITY-006 context menu Exclude and Restore mirror Delete` | 右键行 → Exclude → 右键 → Restore | 状态同 Delete；菜单只含当前适用项 |
| `ED-PARITY-006 Delete inside the query input edits text only` | focus Search query，Delete | 输入值变化；无行排除 |
| `ED-PARITY-006 new search clears exclusions; collapse keeps them` | 排除 → 折叠/展开 → 仍排除；再次搜索 | 新结果全部 included |
| `ED-PARITY-006 Replace All seeds the preview with list exclusions` | 排除 a.txt:2 → Replace All | dialog a.txt:2 checkbox 未选；counts `2 of 3`；提交 mock 收到 2 matches（a.txt:1、b.txt:1），edit 仅 2 处 |
| `ED-PARITY-006 Replace All is disabled when every result is excluded` | 排除全部 | 按钮 disabled；点击不调用 `onPrepareReplacePreimages` |
| `ED-PARITY-006 successful commit prunes committed rows and keeps excluded rows` | ok 返回 | 仅剩 a.txt:2（excluded）；notice `Replaced 2 occurrences in 2 files`；焦点在该行 |
| `ED-PARITY-006 failed commit keeps the result list unchanged` | `{ok:false,message:"Replace blocked: ..."}` | 行与排除态不变；弹窗保持；错误可见 |
| `seeded exclusion, summary text` / `Escape cancels without commit` / `Enter commits from primary, not from a checkbox` / `focus lands on primary and returns on close` / `keys are inert while committing`（ReplacePreviewDialog） | `initialExcludedKeys` 一项；各键 | summary 精确字符串；Esc 调 onCancel 且 onCommit 0 次；checkbox 上 Enter 0 次提交；committing 时 0 次 |

改前基线：前 3 项及“seeds”“prunes”在当前源码必然失败（无排除/无修剪），作为 G1/G2 红→绿；既有 ED-FIND-004/ED-REPAIR-005 用例必须保持通过。

### V2 — 撤销路由与确认（unit/mounted，A3）

文件：`src/components/editor/CodeWorkspaceTab.test.tsx` 新增 `describe("ED-PARITY-006: workspace edit undo routing")`，挂载真实 shell 与一次成功 Replace in files（沿用同文件 `describe("ED-REPAIR-002: replace preflight and open buffer freeze conditions (mounted)")` 的挂载、搜索与写入 mock 模式）。

| 测试名（拟新增） | 操作 | 预期 |
|---|---|---|
| `ED-PARITY-006 Ctrl+Z in Search query does not undo the workspace edit` | 提交后 focus Search query，`Control+z`、`Control+Shift+z` | history `canUndo` 仍 true；buffer/写入 mock 无撤销调用；无确认框 |
| `ED-PARITY-006 Ctrl+Z on a result row asks before undoing` | focus 剩余行 Ctrl+Z | `code-workspace-undo-confirm` 可见，正文 `Undo Replace in files?`，焦点 OK |
| `ED-PARITY-006 Cancel and Escape leave history untouched` | Cancel；再开 Esc | 两次均零 undo 调用，`canUndo` true |
| `ED-PARITY-006 OK undoes both files once` | OK | undo 调用 1 次；状态栏 `Undid Replace in files (2 files)`；`canRedo` true |
| `ED-PARITY-006 editor Ctrl+Z still claims the journal without a prompt` | focus editor Ctrl+Z | 无确认框；journal undo 1 次（保留 ED-AUDIT-008） |
| `ED-PARITY-006 Replace in Files action focuses Replace text` | 执行 `workspace.replaceInFiles`（query 已有值 / 为空） | 分别聚焦 Replace text / Search query；无旧状态提示 |

G3 改前：第一项在当前源码失败（Ctrl+Z 触发 undo），作为红→绿证据保留。

### V3 — browser 连续主序列（A1）

拟新增 `qa-ui-auto-tests/cases/TC-IDE-PARITY-006-01-replace-exclude-preview-cancel-commit.testcase.yaml`，ID `TC-IDE-PARITY-006-01`，`modes: [browser]`，fixtures `[reset_db, parity006_replace]`，tags `[code-workspace, ide-find, replace, parity006, p1]`。所用 verbs 均已存在：`open/click/right_click/click_menu/fill/select_option/press/wait_for/assert_text/assert_attribute/assert_count/assert_items/assert_disabled/assert_not_visible/eval_readonly/screenshot`。焦点断言用 `eval_readonly`，如 `document.activeElement?.getAttribute('data-testid') === 'code-workspace-replace-commit'`。

1. 从 welcome recents 打开 `${fixture.parity006_root}`；`press: Control+Shift+F` → 面板可见，`eval_readonly` 焦点为 `[aria-label="Search query"]`。
2. `select_option` scope=Directory；`fill` directory `src`、include `*.txt`、query `token`；`press: Enter` → header `3 results · 2 files`；`assert_count` 组=2；`assert_items` 组 `data-file` 为 `parity006/src/a.txt`、`parity006/src/b.txt`（P2 按实际 rootName 固定）；面板不含 `c.md`、`d.txt`。
3. `click` a.txt:2 行 → `press: Delete` → `assert_attribute data-excluded=true`；焦点 b.txt:1；a.txt 计数 `2`；Search query 值仍 `token`。
4. `right_click` a.txt:2 → `click_menu: Restore` → `data-excluded` 缺失/false；`right_click` → `click_menu: Exclude` → true。
5. `fill` Replace text `coin`；`click` Replace All → 预览可见；summary 精确 `Replace 2 occurrences of 'token' across 2 files with 'coin'?`；counts 含 `2 of 3`；a.txt:2 checkbox `checked=false`；焦点在 `code-workspace-replace-commit`。
6. `press: Escape` → `assert_not_visible` 预览；焦点 Replace All；行数 3，a.txt:2 仍 excluded；打开 a.txt 与 b.txt 各一次，`assert_items` 行为初值（VFS 零写入）。
7. `click` Replace All → `press: Enter` → 预览关闭；notice `Replaced 2 occurrences in 2 files`；`assert_count` 结果行=1 且 excluded；打开 a.txt `assert_items ["alpha coin one","beta token two",""]`，b.txt `["gamma coin three",""]`，c.md 未变。
8. 负路径（同 case 继续）：排除全部剩余 → `assert_disabled` Replace All。`screenshot` S4/S6 两张供 V5。

清理：reset_db；VFS 根随 fixture 重建。边界：browser VFS 不证明主机磁盘字节/ripgrep。

### V4 — browser 撤销路由 + native 当前端磁盘/冲突（A1/A3）

**TC-IDE-PARITY-006-02**（拟新增，`…/TC-IDE-PARITY-006-02-replace-undo-routing.testcase.yaml`，browser）：重复 V3 步骤 1–7 的最短版本（无右键）后：

1. `click` Search query，`press: Control+z`、`press: Control+Shift+z` → `assert_not_visible` `code-workspace-undo-confirm`；a.txt 仍为提交内容。
2. `click` 剩余结果行，`press: Mod+z` → 确认框可见，正文 `Undo Replace in files?`，焦点 OK；`click` Cancel → 不可见，a.txt 仍为提交内容。
3. 再 `press: Mod+z` → `press: Escape` → 同上零效果。
4. 再 `press: Mod+z` → `click` OK → 状态栏 `status-bar-message` 含 `Undid Replace in files (2 files)`；a.txt/b.txt 行为初值。
5. 保留消费者：打开 a.txt，编辑器内键入 `x` 后 `press: Mod+z` → 无确认框，行恢复（本地 CodeMirror 历史）。`press: Control+Shift+R`（query 非空）→ 焦点 Replace text。

**TC-IDE-PARITY-006-03**（拟新增，`…/TC-IDE-PARITY-006-03-replace-disk-conflict-undo-native.testcase.yaml`，`modes: [native]`，fixtures `[reset_db, parity006_replace]`，`native_platforms: [Windows, Linux]`）。只用跨平台 verbs（`click/press/fill/host_write_file/assert_file_sha256/assert_text`；**不用** X11-only 的 `native_click`/`native_keys transport:x11`）：

1. 与 V3 步骤 1–5 相同到预览打开；`press: Escape` → 四文件 `assert_file_sha256` = 初值。
2. `click` Replace All → `host_write_file src/b.txt "gamma token changed\n"` → `press: Enter` → `code-workspace-replace-commit-error` 含 `changed`；预览仍开；a.txt 初值、b.txt 为外部值、c.md/d.txt 初值。
3. `host_write_file src/b.txt "gamma token three\n"`（恢复原字节）→ `click` commit → a.txt/b.txt = 提交 SHA；c.md/d.txt 初值。
4. `click` 剩余行 → `press: Control+z` → 确认 → `click` OK → 四文件 = 初值 SHA。
5. dirty 冲突：重新搜索并排除 a.txt:2，双击 a.txt:1 打开，编辑器末尾键入 `x`，Replace All → Enter → 阻断含 `unsaved modifications`；四文件 SHA = 初值（a.txt 未保存）。`press: Control+s` 后 a.txt 为 `…\nx`（P2 实算 SHA），关闭预览重开可提交。

native 理由：真实 ripgrep 范围/mask、Tauri 写盘字节、外部进程修改与 preimage/hash 阻断、WebView2 中 Ctrl+Z 在输入框/结果行的真实路由，browser VFS 与 stub 均不能证明。Windows 为当前端必跑；Linux/macOS 计划同序列（macOS 用 `Mod+z`，需 WKWebView bridge），本轮未验证。

### V5 — IDEA 双侧比较（A2）

复用 V3/V4 截图和运行，不另建构建。按参照 R1–R8 逐状态记录功能/UI/交互三列：R1/R2 计数与集合、R5 排除态（删除线、计数保持、焦点下移）、R6 确认计数文字与 Esc 零写入、R7 修剪、R8 撤销确认。DEC-03（弹窗列表）、DEC-07（直接落盘）、入口形态（dock vs popup）记 accepted-different；C1–C5 未采项 unverified。记录写 `qa-ui-auto-report/idea-comparison/ED-PARITY-006/<run>/record.json`，用 `compare_idea.py --record … --schema claudedocs/code-workspace-idea-specs/idea-comparison.schema.json` 校验；validator 通过不等于 matched。

### V6 — 保留行为回归（A3）

| 保留行为 | 现有检查 | 本卡处理 |
|---|---|---|
| 冻结快照、preimage 迟到/取消、选择校验、UTF-16、大小写路径 | `FindInFilesPanel.test.tsx` ED-FIND-004 / ED-IMPROVE-004/005 / ED-MAIN-005 / ED-REPAIR-003/005/006；`replaceInFilesModel.test.ts`、`buildReplaceEdits.test.ts`、`ReplacePreviewDialog.test.tsx` 既有 4 项 | 原样通过；不得放宽 |
| 预览排除与 Cancel | `TC-IDE-D2-01` browser | 复跑；selector 不变 |
| 提交 + 一次 undo 真实字节 | `TC-IDE-D2-02` native | **P2 必改**：Ctrl+Z 从 Search query 改到结果行并点确认 OK（DEC-06）；`native_click`/X11 `native_keys` 换为 `click`/`press`/`fill` 以便 Windows 执行 |
| 冲突 ledger、零 history | `TC-IDE-AUDIT-003` native | **P2 必改**：同上替换 X11 verbs；其“失败后 Ctrl+Z no-op”在编辑器焦点，保持期望 |
| scope 模块 fail-closed | `TC-IDE-D1-01` browser | 复跑 |
| 编辑器内 Rename 撤销 | `TC-IDE-C6-04`（jdtls，编辑器焦点） | 不跑（本卡不改 claim 路径）；V2 第 5 项替代证明路径未变 |
| 本地 Find 焦点 | `TC-IDE-FINDFOCUS-01` | 复跑（共享 capture keydown） |
| Keymap 输入框保护 | ED-PARITY-004 `KeymapSettingsDialog.test.tsx` | 跑同文件（`isSurfaceOwnedKeyEvent`/输入豁免相邻） |

### 覆盖维度总映射

| AC/V | 维度 | 控件 / Action / 快捷键 + 上下文 | 操作 → 预期 | case/test | 模式（native 理由） | 结果 |
|---|---|---|---|---|---|---|
| A1/V3 | UI | 结果行 excluded 态、header 计数、notice、Replace All disabled | S2/S6/全排除 | 006-01；V1 | browser | unrun |
| A1/V3 | 控件 | scope select、directory/include/query/replace 输入、Search 按钮 | S1 填写并运行 | 006-01 | browser | unrun |
| A1/V1/V3 | 控件 | 结果行单击/双击/Arrow/Enter、组标题 Delete | 焦点移动、打开、整文件切换 | V1；006-01 | browser | unrun |
| A1/V1/V3 | 快捷键 | Delete（结果行 / 组标题 / 输入框内保护） | 排除切换；输入框只删字符 | V1；006-01 | browser | unrun |
| A1/V3 | 右键 | `Exclude`/`Restore` 菜单 | 与 Delete 等价 | V1；006-01 | browser | unrun |
| A1/V3 | 弹窗 | Replace All、checkbox、`Replace N`、Cancel、Esc、Enter、Tab 循环 | S4–S6；committing 时惰性 | V1；006-01；D2-01 | browser | unrun |
| A1/V4 | 生命周期 | 外部修改、dirty 阻断、恢复后提交、失败不修剪 | S10/S11 | 006-03；V1 | native（真实写盘/外部进程/hash） | unrun |
| A3/V2/V4 | Action | `workspace.undoWorkspaceEdit`（结果行/面板焦点、命令面板） | 确认→OK/Cancel/Esc | V2；006-02；006-03 | browser + native（WebView2 键路由/磁盘） | unrun |
| A3/V2/V4 | 快捷键 | Ctrl/Cmd+Z、Ctrl+Shift+Z、Ctrl+Y 在输入框 | 不触发工作区撤销 | V2；006-02 | browser | unrun |
| A3/V2 | 快捷键 | 编辑器内 Ctrl+Z | 无确认，claim 路径不变 | V2；006-02 | browser | unrun |
| A1/V2 | Action | `workspace.replaceInFiles` Ctrl+Shift+R、`workspace.findInFiles` Ctrl+Shift+F | 焦点目标；面板打开 | V2；006-01/02 | browser | unrun |
| A3/V6 | 共享消费者 | Find in Directory、Search Everywhere Text 预置、本地 Find、Keymap 对话框、Rename undo、AUDIT-003 | 见 V6 | 既有单测/case | 同原 case | unrun |
| A2/V5 | 比较 | R1–R8 | 三维结论 | compare record | 复用 | unrun |

N/A：拖拽、滚动性能、IME（本卡不改文本输入路径，Delete/Ctrl+Z 在 composing 时由 host 既有 `composing` 拒绝，V2 不另测）；主题/缩放像素（不签视觉 matched）。

## 7. P2 最小执行集合

1. 改前：跑 V1 的 G1/G2 新测试与 V2 第 1 项，记录预期失败；跑 V6 单测基线（`pnpm exec vitest run src/components/editor/workspace/panels/FindInFilesPanel.test.tsx src/components/editor/workspace/panels/ReplacePreviewDialog.test.tsx src/components/editor/workspace/replaceInFilesModel.test.ts`）。
2. 迭代：上列文件 + `pnpm exec vitest run src/components/editor/CodeWorkspaceTab.test.tsx -t "ED-PARITY-006|ED-REPAIR-002|ED-AUDIT-008"` + `src/components/editor/workspace/KeymapSettingsDialog.test.tsx`。
3. 稳定后一次：`python .agents/skills/code-workspace-idea-task/scripts/typecheck_scope.py --path src/components/editor/workspace/panels/FindInFilesPanel.tsx --path src/components/editor/workspace/panels/ReplacePreviewDialog.tsx --path src/components/editor/CodeWorkspaceTab.tsx`（加上所改测试文件）。
4. browser：`python -m qa_ui_auto run --mode browser --config .agents/skills/qa-ui-auto/assets/qa-ui-auto.config.browser.yaml --filter TC-IDE-PARITY-006-01,TC-IDE-PARITY-006-02,TC-IDE-D2-01-replace-preview-exclude-cancel-browser,TC-IDE-D1-01-find-scope-module-unresolved-browser,TC-IDE-FINDFOCUS-01 --require-pass`（`PYTHONPATH` 按 skill；≤2 workers）。
5. native：`native_build.py --check` → 构建/复用一次 → `run --mode native --filter TC-IDE-PARITY-006-03,TC-IDE-D2-02-replace-commit-undo-native,TC-IDE-AUDIT-003-replace-conflict-ledger-native --require-pass`。
6. 用例/目录变更后一次 `python -m qa_ui_auto audit --gate` 与 `contracts --gate`；V5 比较记录。

完成上限：Windows/WebView2 当前端功能与交互；UI 视觉不签 matched；Linux/macOS 未验证并给出同序列步骤。




