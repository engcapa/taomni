# Java Extract Method：直达提取、命名、边界与撤销

<a id="ed-parity-007"></a>

## 1. 身份、范围与规划门槛

- 唯一卡：[backlog.md](backlog.md) `ED-PARITY-007`；来源 [REQ-06](overall-audit-plan-20260913.md#req-06) / [CW-REFACTOR-002](capability-matrix.md#cw-refactor-002)；回链 [P0 首包](task-planning.md#ed-parity-007)。沿用 `AUDIT-20260913-01`，不重跑整体评估；ED-REF-001（Rename，旧板 done）只作保留来源，不重领。
- 2026-09-27 P1 基线：分支 `docs/code-workspace-idea-audit-20260913`，HEAD `b3591ae10cd9425e92bf844d7a928c8373ad653c`，开始时工作区干净。只读生产源码、只读解包 JDT LS jar 常量池、写设计/参照/交接；没有 claim、开发 owner、产品或测试修改、产品测试、构建、Taomni/JDT LS 启动或提交，未启动其他 agent。
- IDEA 目标：用户要求 **IntelliJ IDEA Ultimate 2026 年任一发行版（2026.x）**，不限定 build（仅本卡）；本轮参照实采于本机 2026.2.2 / IU-262.10315.125，补采/复核可用任一 2026.x 并记录实际 build。用户授权 15 分钟桌面，已在隔离工程实采 R1–R10，见[参照包](references/ed-parity-007-reference.md#observed)。
- 用户决定（2026-09-27）：提取成功后**弹出命名**（复用 Rename 路径，Enter 改名、Esc 保留默认名）；撤销**接受两步**（先撤改名、再撤提取），记为已接受差异。
- 用户结果：F2-EXTRACT-007 中选中单输出语句块 → Ctrl+Alt+M **直接**提取（无候选选择器）→ 命名框预选默认名 → 输入 `sumOf` + Enter → 调用处与声明同步 → 程序行为不变、无诊断 → Ctrl+Z 两次恢复初始字节。多输出拒绝、无候选的空选区、provider 超时/失败及提交前迟到均零写入；空选区若 provider 确实提供有效方法候选则正常提取（DEC-06）。
- 不纳入：Extract Variable/Constant/Field、Inline、Change Signature、Move 的对齐；IDEA 的多输出 record 折叠（R10，能力差距，交 P0 增量）；重复片段替换提示；Alt+Shift+O 选项弹窗；编辑器右键 Refactor 子菜单（IDEA 未采）；启用 JDT LS `advancedExtractRefactoringSupport`（影响全部 extract 类，超出本卡）。
- **P1 于 2026-09-27 规划就绪；所有产品验证未执行。** 本次修订基线为 `docs/code-workspace-idea-parity-007-cc-5.5-P1@53ecc955ff7ed7266eefe2af338fe598773efadf`，切换后工作区干净。用户明确采用 cc 方案并补入 astra 的有效设计；保留弹框命名、两步撤销，补齐下述 DEC-07 生命周期与完整验证。astra `c017800d` 仅为设计/历史参照来源，不移植其待决 inline/单次撤销合同，也不继承其 Windows 通过主张。

## 2. 当前生产事实与差距分类

入口与效果链（2026-09-27 源码核对，行号仅定位）：`workspace.extractMethod` Ctrl+Alt+M（`CodeWorkspaceTab.tsx:14486`，`when` 要求非 tree 焦点、非 library、`activeCapabilities?.codeAction`）→ `openRefactorActions(["refactor.extract","refactor.extract.function","refactor.extract.method"])`（`:11964`，range=当前选区）→ `showCodeActionsMenu`（`:11843`，固定锚点 pane 左上 +80/+80）→ `requestCodeActions`（`:11152`：LSP 同步、`semanticIndex.beginBuild`、`CanonicalCodeActionService.requestCandidates` 10 s 超时，`codeActionProviderAdapter.ts:328`）→ `lspCodeActions` → Rust `lsp_code_actions`（`lsp.rs:8299`，`REQUEST_TIMEOUT_SECS=8`）→ JDT LS 1.61 → 客户端按前缀过滤（`:11874`）→ 冻结 `IntentionSession` → `openTreeContextMenuAt` 候选菜单 → 点击 `runCodeAction`（`:11327`：`resolvePlan` 经 `codeAction/resolve`、`buildRefactorPlan` kind=extract、`refactorApplyGate`、`applyPlan` → `applyLspWorkspaceEdit(preview:true, recordHistory:false)`）→ 单文件 edit 不需确认（`workspaceEditPreview.ts:215`）→ 干净缓冲写入并保存、dirty 缓冲只改缓冲（`workspaceEditApply.ts:580-598`）→ `registerHistoryEntry` → 编辑器 Ctrl+Z 经 `claimWorkspaceHistory`（`:10936`）→ `undoWorkspaceEdit` 快照回放。

JDT LS 1.61.0.202607102111 静态核对（`/tmp` 解包，只读 javap 常量池）：`JavaCodeActionKind.REFACTOR_EXTRACT_METHOD = "refactor.extract.function"`，标题 `Extract to method`；Taomni 未声明 `advancedExtractRefactoringSupport`（`lsp.rs:9005` 只有 `classFileContentsSupport`），故走 `RefactorProposalUtility.getExtractMethodProposal` 非命令分支 → `RefactoringCorrectionProposalCore`，edit 在 resolve 时计算；只在 `noErrorsAtLocation` 时提供；`checkInitialConditions` 不 OK（如多输出）时**不返回该动作**，不带原因。

| 类别 | 事实 | 依据 |
|---|---|---|
| 已有且满足（待本卡复验） | 冻结候选/稳定 id、resolve 超时保留候选并可重试、文档 revision/provider generation/project fingerprint 迟到校验、提交前快照比对、失败恢复 id、单文件直接应用、历史快照撤销（编辑器 Ctrl+Z 无确认） | `intentionSession.ts`、`codeActionProviderAdapter.ts:463-910`；`CodeWorkspaceTab.test.tsx` “rejects a provider refactor when the editor changes during preview confirmation”；ED-PARITY-006 DEC-06-3 |
| 确认缺陷 D1 | Rust `lsp_code_actions` 用 `.unwrap_or(Value::Null)` 吞掉 provider 错误、8 s 超时和“document changed”取消，统一返回空数组；TS 把它当 `ready` 0 条，最终显示 `No Extract Method/Function actions provided by the language server`——失败被说成“不支持” | `lsp.rs:8341-8354`、`:3584`、`:5759-5762`；`:11869-11881` |
| 体验差异 G1 | Ctrl+Alt+M 总是弹候选菜单；`only` 前缀 `refactor.extract` 使 variable/constant/field/interface 候选也进入“Extract Method”菜单。IDEA 直接提取（R2） | `:11874-11878`；IDEA R2 |
| 体验差异 G2 | 提取后无命名步骤，保留 provider 启发式名称；IDEA 就地模板命名（R2–R4） | `runCodeAction` 应用后只写状态栏；IDEA R2–R4 |
| 体验差异 G3 | 零候选时文案不区分“空选区/不可提取/失败”，也不解释边界 | `:11879-11881` |
| 已接受差异 | 两步撤销（用户 2026-09-27 决定）；提取直接落盘（干净缓冲，沿用 ED-PARITY-006 DEC-07）；命名为模态框而非就地模板；默认名与 `static` 修饰符由 provider 决定 | DEC-03/04 |
| 能力差距（交 P0） | IDEA 多输出折叠为 record 后提取（R10）；JDT LS 无此能力 | IDEA R10；JDT LS 静态核对 |
| 待运行归因 R1 | 候选菜单 Esc 后焦点是否回编辑器：`handleTreeContextMenuClose`（`:4017`）在无 tree 会话时直接 return | P2 先写 mounted 测试确认，再决定是否在 `showCodeActionsMenu` 传回焦点 |
| 待运行归因 R2 | JDT LS 对 E1 的实际标题/默认名/是否 `static`/edit 结构；resolve 后 documentSymbol 何时反映新方法 | P2 首个 provider 探针记录原始 JSON，不猜测 |
| 已知不改 | `refactorApplyGate` 的 `requiresPreview` 在 `runCodeAction` 未被读取（单文件不预览）；与 IDEA 就地提取一致，本卡不改，记录为共享门禁备注 | `refactorPlan.ts:245-249`、`:11473-11490` |

## 3. 决定与实现责任

- **DEC-01 fixture 与范围**：双侧同字节 F2-EXTRACT-007（[参照 §2](references/ed-parity-007-reference.md#fixture)）。E1 第 5–8 行单输出为受支持主场景；E2 第 13–18 行多输出为边界场景；空选区（caret 在第 6 行 `for`）为输入边界。Taomni 程序正确性以“调用处被替换为新方法调用、新方法体包含原 4 行、JDT LS 无 error 诊断、`total({1,2,3})` 语义不变”判定；精确字节由 P2 provider 探针记录后固定为 case 期望，不手抄 IDEA 字节（默认名/修饰符允许不同）。
- **DEC-02 Ctrl+Alt+M 直达（修 G1）**：`workspace.extractMethod` 改走新的 `runExtractMethod`（不再调用通用 `openRefactorActions`）。请求仍发 `only: ["refactor.extract"]`（不改 provider 请求形状），客户端用新纯函数 `isExtractMethodKind(kind)` 精确筛选：`refactor.extract.function`、`refactor.extract.method`，及这两类的点分隔子 kind；**不**再按前缀收入 variable/constant/field/interface。
  - 1 个候选：不弹菜单，直接 `runCodeAction(action, file, semanticToken, candidateId, context)`（仍经 `IntentionSession.open` 冻结，保持 id/迟到校验）。
  - ≥2 个候选：弹同一冻结候选菜单，锚点改为选区起点坐标（`editorPaneRef` 内 CodeMirror `coordsAtPos`，取不到时回退现有 +80/+80）。
  - 0 个候选：见 DEC-06。
  - 请求/resolve 尚未写入时再次触发：撤销旧本地 owner，只保留最新一次；进入 commit、symbols-after、命名及 rename 阶段后重复触发无效，不产生第二次提取。命名框内 chord 由局部 modal 捕获；阶段和边界见 [DEC-07](#session-lifecycle)。
  - `workspace.refactorThis`、`workspace.codeActions`（Alt+Enter）及其他通用入口保留原候选集合/菜单；其中选中方法提取候选时接入同一 Extract 事务及命名后处理，不能因入口不同绕过保护。普通 quickfix、Extract Variable 不接入方法专用过滤/命名。
- **DEC-03 提取后命名（修 G2，用户已定）**：`runExtractMethod` 在应用前取 `lspDocumentSymbols` 方法快照；`runCodeAction` 返回 `ok` 后等待 LSP 同步当前缓冲，再取快照，用新纯函数 `findExtractedMethodSymbol(before, after)` 找出**唯一**新增的 Method/Function 符号（重建父容器后的名称/容器多重集差；已有同名重载一律视作歧义，不能仅凭 depth 认定同一容器）。
  - 唯一新增且文件在提取前是干净缓冲：调用重构后的 `renameSymbolAt(file, position, { title: "Extract Method", label: "Method name", confirmLabel: "Rename" })`，position=新方法 `selectionRange.start`；命名框 `text-input-dialog` 预选默认名。Enter 且名称改变 → 走既有 Rename 全链（prepare/rename/plan/gate/preview/history），调用处与声明同步；Enter 未改名或 Esc → 保留默认名，零额外编辑、零额外历史。
  - 提取前缓冲 dirty：Rename 现有 dirty 门禁会拒绝，故**不弹**命名框，状态栏 `Extracted method <name>; save the file, then press Shift+F6 to rename it`。
  - 找不到或多于一个新增方法、documentSymbol 失败：不猜名，不弹框，状态栏 `Extracted method; could not locate the new method to rename it`，提取结果与历史保留。
  - 命名结束后焦点回编辑器，caret 在调用语句行首（对应 IDEA R4 的 5:9）。
  - `renameSymbolAtCursor`（`:16810`）重构为 `renameSymbolAt` + 保持原签名的包装；Shift+F6 行为、文案、dirty/partial/preview/stale 语义不变。Extract 使用 owner 管理的本地 `TextInputDialog`，而非不可撤回的全局队列；复用 Rename 执行链的接口及失败语义见 DEC-07。
- **DEC-04 撤销（用户已定两步）**：提取与改名各为一个 `WorkspaceEditHistory` 项。编辑器 Ctrl+Z 第一次撤销改名（状态栏 `Undid Rename symbol to "sumOf" (1 files)`），第二次撤销提取（`Undid Extract to method (1 files)`），缓冲与磁盘恢复初始 SHA；Ctrl+Shift+Z 按序重做。无改名时一次 Ctrl+Z 即恢复。编辑器焦点撤销不弹确认（保留 ED-PARITY-006 DEC-06-3）。与 IDEA 单步撤销（R5/R9）记为已接受差异。
- **DEC-05 provider 失败如实分类（修 D1）**：Rust `lsp_code_actions` 抽出纯函数 `code_actions_from_response(Result<Value,String>) -> Result<Vec<LspCodeAction>,String>`，`Err` 向上返回（Tauri invoke reject），`Ok(Null)` 仍为空数组；session 不存在时保持现有 `Ok` 空结果。TS `requestCandidates` catch 增加分类：消息含 `timed out` → `timeout`；含 `document changed` → `cancelled`（`requestCodeActions` 对该情形给出 `Refactor actions were cancelled because the document changed; try again`）；其余 → `failed` 带原文。`requestCodeActions` 的所有调用方（Alt+Enter、灯泡、Problems quick fix、Generate、Rearrange、Cleanup、保存时 Organize imports）因此从“无动作”变为真实失败文案——这是**有意改变**，逐一回归（V6）。真正的空结果文案不变。
- **DEC-06 边界文案（修 G3）**：零个 Extract Method 候选时：空选区 → `Extract Method: select the statements or expression to extract`；非空选区 → `Extract Method is not available for this selection (the language server offers no extraction here, for example when several values would have to be returned)`。多输出不做 record 折叠（能力差距，已登记）。请求失败/超时/取消使用 DEC-05 文案，不落入本条。所有边界零编辑、零历史、零磁盘写入。
- **DEC-07 冲突与迟到**：提取前复用 canonical 校验；新增会话 owner 覆盖提取后的 symbols/命名/Rename 全链，按下节逐 await、弹框前、首次 writer 前校验。已提交提取后失效只终止后续命名，不回滚用户更新或伪称零写入。
- **DEC-08 落盘**：干净缓冲提取后立即保存（沿用 §5.2.9 与 ED-PARITY-006 DEC-07）；dirty 缓冲只改缓冲、保持 dirty。与 IDEA“需保存才落盘”记为已接受差异。

### DEC-07：提取后命名的生命周期、接口与恢复

当前事实：`src/lib/appDialogs.tsx::promptAppDialog` 仅返回 Promise，没有按 owner 撤回队列的接口；既有 `TextInputDialog` 在 `src/components/sidebar/ConfirmDialog.tsx`。因此 P2 在 CodeWorkspaceTab 内维护局部 Extract prompt 状态，复用该组件；不改全局 prompt 队列，不在失效时关闭其他动作的 dialog。局部 wrapper 负责 Tab/Shift+Tab 循环、modifier/repeat/IME 保护和按 owner 回焦。

- **身份和单一 owner（拟新增）**：`ExtractSession = { id, workspaceInstance, sourceViewId, fileKey, uri, providerGeneration, projectFingerprint, baseRevision, baseText, selection, phase, abortController }`；引用由 CodeWorkspaceTab 持有，纯判定放 `extractMethodFlow.ts`。阶段依次为 `request → resolve → commit → symbols-after → naming → rename → finished`；任意等待阶段可失效。before-symbols 采样属于提交前的冻结上下文；失败/空结果不阻止合法提取，但禁止靠不完整快照猜新方法。
- **提交回执（拟新增，内存对象）**：扩展 `runCodeAction` 原 `{ok,message,retryable}` 返回值，可选携带 `appliedReceipt: {sessionId,fileKey,uri,postRevision,postText,historyId}`。回执在本次 canonical commit/history 完成边界产生，代表准确 B1，不能在随后的 symbols await 后读取任意最新文本充当 B1。其他消费者可以忽略此可选字段；只在 applied 且 receipt 与当前文本/revision 相等时继续命名。
- **后半段检查**：before/after document symbols、同步、prepareRename、用户输入、rename reply 每次 await 后，以及弹框前/改名前/首个 writer 前，核对 owner、workspace instance、源 view、文件 URI、provider generation/fingerprint 和对应基线。提取前对 B0 校验；提取后对 receipt 的 B1 校验；Rename 成功后按 B2 收尾。两次自身提交是唯一允许推进 revision 的原因，外部编辑/undo/redo/重载产生的新 revision 不得自动重新绑定。
- **失效事件**：切文件/工作区、关闭源 view（即使随后以同 key 重开）、源文档编辑/undo/redo、磁盘重载、provider 重启、卸载，均中止本地 owner，清除仅属于它的 prompt 并解除订阅。不得弹旧框、移动新 view 的 caret 或覆盖新状态栏。共享 split 文档的任一 view 编辑同样失效；提交本身同步到 sibling view 属自身 B0→B1，不误取消。
- **取消与焦点**：提交前菜单 Esc/取消、stale、冲突是零效果；提取已经 applied 后 Esc/Cancel/遮罩关闭只保留默认名与提取历史，属用户选择的两步方案，不能称作撤销提取。源 view 仍当前有效时回到调用行/原 caret；已切换/关闭时保留当前焦点。后台收到的错误记会话证据，不覆盖另一工作区消息。
- **命名接口（拟新增）**：`renameSymbolAt(file, position, options?)` 返回 `{status: applied|unchanged|cancelled|stale|failed, message?, recoveryId?}`；options 增加可选 `promptName` 回调（Extract 局部 dialog）、`isCurrent` 守卫及预期 revision/text。默认调用保持原 `promptAppDialog`，不改变 Shift+F6。校验不仅包在调用外层，还接入同步后、prepare 后、prompt 后、rename reply 后及 canonical preflight。不在这个接口另建保存/history owner。
- **输入与失败**：空/全空白输入禁用确认，Enter 不调用 provider；未改名 Enter/Cancel 不增加历史。合法性和冲突由语义 provider 判断，不能用字符串替换伪造改名。provider 拒绝非法名/冲突或可重试错误时，owner 尚有效且未写入则保留输入、显示真实错误并允许修正重试（局部 dialog 可重新挂载，初值为用户输入）；重试仅 Rename，不再提取。失效时不重开。symbols-after 超时/失败/零个/多个/同名重载歧义保留 B1，给出 DEC-03 的无法定位文案，可后续 Shift+F6。
- **写入边界**：request abort 仅代表本地不再接收，不宣称发送 LSP cancel。第一次 writer 后不能用 cancelled/stale 隐藏真实效果：等待 canonical 原结果和 recoveryId；已提交的 B1 不因命名失败被自动撤销。Rename 写失败按现有 snapshot/journal 恢复到实际可证明状态；禁止整个 B0 快照覆盖外部改动。重试前读当前身份/磁盘，未知或 partial effect 必须先恢复，不能盲目重放。
- **整体语义 edit**：方法提取必须 resolve 成可审阅的纯 WorkspaceEdit；command-only、带未知后续命令、malformed/disabled 均在写入前明确拒绝。所有方法提取 text operations 标记 required；若真实 provider 返回多文件/资源 edit 而进入共享预览，声明与调用点不可被 Select None/filter/checkbox 拆开。单文件 edit 仍直接应用，不能误认为 `preview:true` 会强制弹框。普通 Rename 的可排除项保持原合同。

本节为本轮 agent 在用户采用 cc 方案授权内确定的实现合同（DEC-07 修订，关联 A1/A3、V1/V2/V3/V4/V6）；不引入 inline 临时文档、不合并两笔历史、不变更持久数据格式。

### 文件/符号责任与共享消费者

| 文件 / 符号 | 责任 |
|---|---|
| `src/components/editor/CodeWorkspaceTab.tsx`：`workspace.extractMethod` 的 `run`、新 `runExtractMethod`、`renameSymbolAt`（由 `renameSymbolAtCursor` 抽出）、Extract session/local prompt/receipt 与 preflight 守卫、`runCodeAction` 的方法候选共享后处理、`requestCodeActions` 对 `cancelled/timeout/failed` 的文案、候选菜单锚点参数 | DEC-02/03/05/06 主 owner |
| 新 `src/components/editor/workspace/extractMethodFlow.ts`：`isExtractMethodKind`、`findExtractedMethodSymbol(before, after)`（`LspDocumentSymbol[]` 按 `kind∈{6,12}`、由 range/depth 重建父容器、name 多重集差；同名重载/容器不明拒绝）、`extractMethodBoundaryMessage(selectionEmpty)` | DEC-02/03/06 纯逻辑 |
| `src/components/editor/workspace/codeActionProviderAdapter.ts`：`requestCandidates` catch 分类（`timed out`、`document changed`） | DEC-05 |
| `src-tauri/src/lsp.rs`：`lsp_code_actions` 改用新纯函数 `code_actions_from_response`，错误上抛 | DEC-05 |
| 新 `src/stubs/parity007Extract.ts` + `src/stubs/tauri-core.ts` 分派（`lsp_code_actions`、`lsp_code_action_resolve`、`lsp_document_symbols`、`lsp_prepare_rename`、`lsp_rename`，仅 `/preview/parity007` 且开关 `taomni.qa.parity007.enabled` 时生效；模式 normal / multi-candidate / none / empty-supported / disabled / command-only / malformed / timeout / changed / error / resolve-error / symbols-error / symbols-ambiguous / rename-error / multi-file / write-failure；request/resolve/symbols/prepare/rename 分阶段 hold/release/trace；`window.__taomniQaParity007` 只读观测） | browser 设施，按 `parity005Completion.ts` 模式 |
| 新 `.agents/skills/qa-ui-auto/scripts/qa_ui_auto/fixtures/parity007_extract.py`，注册 `REGISTRY` 与 `schema/testcase.schema.json` | browser `/preview/parity007` 写入 F2-EXTRACT-007；native 复制 `maven-single` 到报告根并新增 `ExtractTarget.java`；导出 `${fixture.parity007_root}`、初值 SHA（由生成字节计算） |
| `src/components/editor/workspace/refactorPlan.ts` / `RefactoringPreviewDialog.tsx` | 复用 requiredOperationIndexes；只为 Extract 锁完整 edit，保留其他 refactor 的排除能力；若生产实现无需改文件则只补对应回归 |
| 新 `.agents/skills/qa-ui-auto/scripts/qa_ui_auto/steps/parity007.py`、steps 注册入口、schema、verb-catalog | 受控 provider 模式/暂停/释放/trace，精确新增契约见 V3；不能借 eval_readonly 调 setMode/release |
| 共享消费者（按下述范围回归） | Shift+F6 Rename 全链（`TC-IDE-C6-04`、`TC-IDE-AUDIT-014`）；`workspace.refactorThis`/Alt+Enter/灯泡/Problems quick fix 候选菜单；Generate、Rearrange（`TC-IDE-AUDIT-015`）、Cleanup（`TC-IDE-AUDIT-016`）、保存时 Organize imports；`WorkspaceEditHistory` 与编辑器 Ctrl+Z claim；`workspaceActionRegistry.ts` 标题/键位；Keymap 冲突检测（ED-PARITY-004） |

新增 testid：不预设新增（优先复用 `text-input-dialog*`、`code-workspace-intention-*`、`status-bar-message`、`code-workspace-editor`）。若 P2 需要标记候选菜单根，复用 `ContextMenu` 现有 `data-appearance="code-candidates"`。三端：纯 renderer + LSP 协议 + Rust 错误传播，无平台 API；macOS 为 Cmd+Alt+M（系统“最小化全部窗口”可能拦截，native macOS 未验证，列计划）；AltGr+M 由 host `AltGraph` 拒绝规则保护（`workspaceActionHost.ts:1134`）。

## 4. 连续场景与 UI 目标

| 步 | 操作 | 关键状态 / 焦点 | 最终结果 |
|---|---|---|---|
| S0 | 打开 F2-EXTRACT-007 workspace，Java LSP ready，打开 `ExtractTarget.java` | 编辑器焦点，clean | 初值 SHA `3ffe60d1…` |
| S1 | 选中第 5–8 行整行，Ctrl+Alt+M | **无**候选菜单；应用提取；`text-input-dialog` 标题 `Extract Method`、输入框焦点且默认名全选 | 编辑器可见调用处 `= <default>(values)` 与新方法；干净缓冲已保存，磁盘为“提取后默认名”字节（P2 探针固定 SHA） |
| S2 | 输入 `sumOf`，Enter | 命名框关闭，焦点编辑器，caret 在第 5 行首 | 调用处与声明均为 `sumOf`，无 error 诊断；磁盘为“提取后 sumOf”字节 |
| S2b | （变体）S1 后 Esc | 命名框关闭，焦点编辑器 | 保留默认名；无额外历史项 |
| S3 | 编辑器 Ctrl+Z | 无确认框 | 状态栏 `Undid Rename symbol…`；文本回到默认名 |
| S4 | 编辑器 Ctrl+Z | 无确认框 | 状态栏 `Undid Extract to method…`；文本 = 初值；Ctrl+S 后磁盘 = 初值 SHA |
| S5 | 选中第 13–18 行，Ctrl+Alt+M | 无菜单、无命名框 | 状态栏 DEC-06 非空选区文案；零编辑/历史/写盘；若 controlled provider 给出有效 method 则按 S1 走 |
| S6 | caret 放第 6 行无选区，Ctrl+Alt+M | 同上 | provider 若返回方法候选则按 S1 走；否则 DEC-06 空选区文案 |
| S7 | provider 超时 / 失败 / document changed | 无菜单 | DEC-05 对应文案，不出现 `No Extract Method… provided` |
| S8 | resolve 挂起时在编辑器输入 1 字符，再放行 | — | `Code action became stale…`；零写入；新输入保留 |
| S9 | dirty 缓冲执行 S1 | 无命名框 | 提取应用到缓冲、保持 dirty、磁盘不变；状态栏 DEC-03 dirty 文案 |
| S10 | Refactor This（Ctrl+Alt+Shift+T）→ 候选菜单 → Esc | 候选菜单含 Extract to method 等 | 零效果；焦点回编辑器（R1 待归因） |

UI 规格：无结构性布局变化，不另出图稿。命名框局部复用 `TextInputDialog`（宽度、按钮外观与现有 Rename 一致），标题/label 为本卡目标，生命周期由 DEC-07 管理；与 IDEA 就地模板（R2 框选+建议列表）记为已接受差异。多候选菜单沿用 `code-candidates` 外观，锚点移到选区起点。状态栏文案为唯一新增可见文本。IDEA 画面见参照 R2–R10 原件。

## 5. 本卡 AC 与 V

- **ED-PARITY-007-A1**（目标）：S1–S2、S2b、S5–S7、S9 — Ctrl+Alt+M 对唯一方法候选直达提取且只收 method/function kind；提取后命名框预选默认名，Enter 同步改名、Esc 保留；多输出拒绝/无候选空选区/提交前失败、超时、取消给出准确边界文案且零写入；空选区有有效候选则走正常流程；程序结构与语义正确、无 error 诊断，V4 实际执行 E1 oracle 与 E3 的 `13:1`；dirty 缓冲不落盘、不弹命名。→ V1、V2、V3、V4。
- **ED-PARITY-007-A2**（比较）：同 F2-EXTRACT-007 的 IDEA R1–R10 与 Taomni 对应状态分别给功能/UI/交互结论与证据身份；两步撤销、模态命名、直接落盘、默认名/修饰符为已接受差异；R10 record 折叠为能力差距；未采项（右键子菜单、Alt+Enter、选项弹窗、重复片段）标 unverified；不签 matched。→ V5。
- **ED-PARITY-007-A3**（取消、冲突、撤销与保留）：S3–S4、S8、S10 — 候选菜单 Esc 零效果并回焦；请求/resolve/菜单期间的编辑与外部改盘均 stale 零写入；两次 Ctrl+Z 恢复初始字节，Redo 按序恢复；提取后 symbols/命名/rename 等待期间失效不产生迟到改名、弹框或焦点污染；Shift+F6 Rename、Refactor This/Alt+Enter 候选菜单、Generate/Rearrange/Cleanup/保存时 Organize imports、失败恢复 id 与编辑器撤销 claim 不退化（仅 DEC-05 的失败文案为有意改变）。→ V1、V2、V4、V6。

验证种类（与 metadata 一致）：`code-audit`、`unit`（V1/V2/V6，含 D1 与 G1 改前失败）、`rust`（V1 Rust 纯函数）、`typecheck`（owned paths 一次 scoped）、`browser`（V3）、`native`（V4 当前端）、`provider`（V4 真实 JDT LS 原始响应与诊断）、`idea-comparison`（V5）。比 P0 初稿新增 `browser`（应用内 Action/快捷键/弹窗路由）与 `rust`（D1 修复），原有种类全部保留。

<a id="session-lifecycle"></a>

<a id="test-cases"></a>

## 6. 完整测试用例设计

所有“拟新增”路径当前不存在，均为 **P2 待实现**，状态 unrun。现有用例只列为保留回归，其历史结果不作本卡 PASS。全部 UI case 覆盖 `F25.5`；操作通用命名/确认控件的 case 同时 `covers: [F25.5, F-Confirm-1]`，其他共享控件按真实 owner 补 covers，不复制 controls 归属；tags 至少 `[code-workspace, refactor, parity007]`。

**Fixture（P2 实现）**：`parity007_extract.py`。browser：按 `parity005_completion.py` 模式在 `/preview/parity007` 写 `pom.xml`（同 maven-single）与 `src/main/java/demo/ExtractTarget.java`（参照 §2 字节），打开开关 `taomni.qa.parity007.enabled`，写 `taomni.recentWorkspaces.v1`，初始 `lastActiveFile` 为该 Java 文件。native：复制 in-repo `maven-single`（忽略 target/build/.git）到 `case_dir/fixture-workspaces/parity007_root`，新增同字节 `ExtractTarget.java`；导出 `${fixture.parity007_root}`、`${fixture.parity007_initial_sha}`（由写入字节计算）。native 另需既有 `jdtls_required`；清理由 `reset_db` 与报告根承担。

**Browser stub（P2 实现）**：`parity007Extract.ts` 对 normal E1 返回 function 与 variable，resolve 的 B1 将选区替换为 `int sum = extracted(values);` 并插入新方法；symbols/prepare/rename 按对应 B0/B1/B2 模拟真实协议形状。仅 fixture 根与开关开启有效，不能全局改变其他 fixture。完整模式/暂停/trace/verbs 及受控失败责任见 V3；它不证明 JDT LS 语义。E3 字节来自补充参考，仅 native oracle 验证其真实语义。

### V1 — 纯逻辑与分类（unit / rust，A1/A3）

新文件 `src/components/editor/workspace/extractMethodFlow.test.ts`（拟新增）`describe("ED-PARITY-007: extract method flow model")`：

| 测试名 | 输入 | 预期 |
|---|---|---|
| `isExtractMethodKind accepts function/method kinds only` | `refactor.extract.function`/`.method`/`.function.custom`/`refactor.extract`+`Extract to method`/`.variable`/`.constant`/`.field`/`.interface`/`refactor.extract`+`Extract to local variable` | function/method 及点分隔子 kind 为 true；父 kind（即使标题含 method）、缺 kind、variable/constant/field/interface 为 false |
| `findExtractedMethodSymbol returns the single new method` | before 3 个方法、after 多 `extracted`(depth 1) | 返回 `extracted` 及其 `selectionRange` |
| `findExtractedMethodSymbol refuses ambiguity` | after 新增 2 个方法 / 0 个 / 同名重载新增 | `null` |
| `boundary message distinguishes empty and non-empty selections` | `true` / `false` | DEC-06 两句原文 |

`src/components/editor/workspace/codeActionProviderAdapter.test.ts` 增 `describe("ED-PARITY-007: provider failure classification")`：client reject `language server request timed out: textDocument/codeAction` → `state:"timeout"`；reject `…cancelled: document changed` → `state:"cancelled"`；reject `boom` → `state:"failed"` 且 message 含 `boom`；resolve `[]` → `ready` 0 条（空结果不被当失败）。

`src-tauri/src/lsp.rs` inline `#[test]`（拟新增）：`code_actions_from_response_propagates_errors`（`Err("language server request timed out: textDocument/codeAction")` → `Err` 原文）、`code_actions_from_response_keeps_null_as_empty`（`Ok(Null)` → `Ok(vec![])`）、`code_actions_from_response_parses_actions`（一个 `refactor.extract.function` → 1 条，kind/title/raw.data 保留）。命令：`cargo test --manifest-path src-tauri/Cargo.toml --lib code_actions_from_response`。

改前：分类 3 项中 timeout 与 document-changed 在当前 catch 下都落为 `failed`（Rust 文案是 `timed out`，不含现有判断的 `timeout` 子串），作为红→绿。D1 本身在 Rust 层：改前证据是 `lsp.rs:8341-8354` 的静态审计（`.unwrap_or(Value::Null)`），改后由上列 Rust 纯函数测试证明错误上抛；TS mock 直接 reject 会绕过 Rust，不能单独证明 D1。

### V2 — 挂载的生产入口与会话失效（unit/mounted，A1/A3）

`src/components/editor/CodeWorkspaceTab.test.tsx` 新增 `describe("ED-PARITY-007: extract method direct run, naming and boundaries (mounted)")`，复用 ED-AUDIT-014 的 Java 挂载及 IPC mocks；真实 `keyDown` 到 `.cm-content`，不直接调用 Action handler 充当入口证据。每例独立 B0、清空历史/延迟回复，结束卸载并断言没有未结束 owner/dialog。下列名字为 P2 待实现，现有行为先保留改前结果。

| 测试名 | 操作与断言 |
|---|---|
| `Ctrl+Alt+M runs the only method candidate without a menu and prompts for a name` | E1 返回 function+variable；只 resolve function 一次，无候选菜单；默认名全选、精确 B1、一个提取历史 |
| `Enter renames call site and declaration; Escape keeps the default name` | 分别 Enter(sumOf)、未改名 Enter、Esc、鼠标 Cancel、遮罩关闭；只有第一条形成 B2/第二历史，其余 B1/一个历史；有效源 view 回焦 |
| `two editor undos and redos restore each transaction` | B2→Undo B1→Undo B0→Redo B1→Redo B2；每步全文与 history cursor，未改名路径只一笔；编辑器不弹确认 |
| `multiple method candidates support keyboard and pointer selection` | 两个方法项+disabled 方法项；Arrow/Enter 和点击分别执行；disabled 的点击/Enter 无写；Esc 无写回焦；锚点为 selection 坐标 |
| `empty selection follows actual method availability` | 无候选显示 select statements、零效果；有有效 method 候选则 B1+命名；不将空 selection 提前强制拒绝 |
| `provider errors remain distinct from empty actions` | none、timeout、document-changed、boom、resolve-error/null、malformed、command-only；准确边界/错误，零写，重试可恢复；disabled 不是成功 |
| `dirty buffer extracts without saving or prompting` | 未保存输入后提取，保留输入、dirty，磁盘 mock 不写，无命名框；Undo 只还原提取，不能丢失先前输入 |
| `ambiguous or failed symbol snapshots preserve the extraction` | before/after symbols 失败、0/2 个新方法、同名重载；B1 保留，提示无法定位，无 Rename/第二历史 |
| `late responses cannot reopen naming or rename another document` | 参数化 request、resolve、symbols-before、symbols-after、prepareRename、prompt、rename reply；每个暂停点执行源编辑、Undo、切文件/工作区、关闭再重开、provider generation 变化中适用项；放行旧回复不能弹框/写新文档/抢焦点/覆写新状态；提交前保留 B0/用户输入，提交后保留当下 B1 或用户 Undo/编辑结果 |
| `post-commit receipt is not rebound to a later revision` | canonical 已提交 B1 后用户立即输入/Undo 再返回 callback；不得把最新文本作为 receipt 的 B1，后续 symbols/rename 不执行 |
| `repeated invocation never duplicates a committed extraction` | request 阶段两次 chord 最新生效；commit、symbols-after、naming、rename 阶段 repeat 无第二写入/历史；所有监听在结束后释放 |
| `name input validates and retries without repeating extraction` | 空输入按钮/Enter 禁用；1bad/冲突名 provider 拒绝保留输入与真实错误；改成 sumOf 重试只 Rename；IME Enter 不提交；命名输入 Ctrl+Z 不触发 workspace Undo |
| `extract preview cannot exclude required edits` | 人工多文件 method edit 进入生产预览，filter/Select None/file/usage 均不能拆掉必要 edit；Cancel 零效果；普通 Rename 的可选项仍可排除 |
| `all extract action entries retain the source selection` | 对应 V3-04 的 Search/ControlBar/通用菜单入口逐项触发，路由到源 workspace/file/range；tree/library/loading/无 capability 不 dispatch |

补 `extractMethodFlow.test.ts` 的 `session guard rejects closed and reopened owners`、`receipt requires exact post revision and text`、`method symbol matching refuses same-name overloads and ambiguous containers`；这些是辅助模型断言，V3 的实际入口仍必需。`RefactoringPreviewDialog.test.tsx` 补 `ED-PARITY-007 required extraction operations stay selected`，复用生产 plan，保留非 Extract 原测试。

### V3 — browser 完整流程、入口与保留行为（A1/A3）

所有下列路径前缀为 `qa-ui-auto-tests/cases/`，均 **拟新增、P2 待实现、unrun**；`modes: [browser]`，fixtures `[reset_db, parity007_extract]`，controls 属 `F25.5` 与 `F-Confirm-1` 的用例列两个 covers。每个编号检查点在 YAML `verification` 映射到实际步骤，不以此文档代替执行结果。

共同准备：每个变体新隔离 VFS/root、B0 原文、clean、空本卡历史，通过 welcome recents 打开 Java 文件。E1 第 5 行 Home、Shift+ArrowDown×4，readonly 断言实际 range。通过 UI 修改文本、选区、焦点和 workspace，不从 eval 写 store。全文断言用 `assert_items` 的 `.cm-line` 完整列表（含末尾空行），不要用 DOM textContent 把换行丢掉，也不以 substring 代替全文。结束关闭本轮 popup、清理本轮订阅/pending，reset_db；证据归 `qa-ui-auto-report/ed-parity-007/<run>/V3/<case>/`，保留 B0/B1/B2、selection、focus、history 和实际 UI 截图。

**设施契约（拟新增）**：`parity007Extract.ts` 只控制 IPC/provider，不替代生产 Action/session/rename/preview/history。`steps/parity007.py` 参考已有 parity005，同步 steps 注册、schema、verb-catalog：

- `parity007_set_mode: <mode>`：normal、multi-candidate、none、empty-supported、disabled、command-only、malformed、timeout、changed、error、resolve-error、symbols-error、symbols-ambiguous、rename-error、multi-file、write-failure。模式只改下一响应/故障，不修改产品 owner。
- `parity007_hold: <phase>`、`parity007_wait_pending: <phase>`、`parity007_release: <phase>`：phase=request/resolve/symbols-before/symbols-after/prepare-rename/rename，按 FIFO 放行一次；无 pending 必须失败。commit 回执竞态由 mounted 控制真实 hook 的 Promise，不在 browser 私自调用 handler。
- `parity007_trace: {requests?, resolves?, renames?, writes?, pending?}`：只读 IPC 计数辅助断言，必须同时检查用户结果。provider generation 和外部 VFS 变更复用 fixture 的受控传输/文件事件，若需新 verb，由 P2 在此模块/schema/catalog 增加显式参数与校验，不能塞进 eval_readonly。
- 已有 verbs：open/click/right_click/press/fill/type/wait_for/assert_items/assert_pattern/assert_attribute/assert_count/assert_not_visible/assert_disabled/assert_enabled/set_check/set_viewport/screenshot/eval_readonly。新增控制 verbs 尚不可执行；`setMode/release` 不能用 eval_readonly 或假装已有 verb。

**TC-IDE-PARITY-007-01-extract-method-direct-name-undo.testcase.yaml**，ID `TC-IDE-PARITY-007-01`：

1. E1 + Control+Alt+M → 无候选菜单，B1 默认 extracted，局部 `text-input-dialog`、input 全选；操作 `text-input-dialog-input` 输入 sumOf，Enter → 精确 B2、调用/声明同步、焦点调用行；截 S1/S2。
2. 编辑器 Ctrl+Z → 精确 B1；再次 → 精确 B0；Ctrl+Shift+Z → B1；再次 → B2。每一步 history/dirty/VFS 结果与 DEC-04/08 一致，不弹 `code-workspace-undo-confirm`。
3. 独立 fresh setup 分别未改名 Enter、Esc、点击 `text-input-dialog-cancel`、点击遮罩 → B1；一次 Undo 回 B0，一次 Redo 回 B1。另 fresh setup 点击 `text-input-dialog-confirm` 完成改名，证明鼠标提交入口。
4. 清空/全空白输入 → confirm disabled、Enter 零 Rename；输入 1bad 与冲突名，controlled provider 拒绝 → 保留输入、准确错误，修正 sumOf 成功仅新增一笔 Rename。输入框 Ctrl+Z 改输入、不改提取；IME composing Enter 不提交。
5. Tab/Shift+Tab 循环 input→Cancel→Confirm（禁用时跳过），焦点不逃出；重复 Enter/快捷键不重复提交。默认 viewport 与 1024×768、长方法名/路径下操作滚动，按钮可达、文本不盖按钮。复用主题角色，不宣称 IDEA 像素 matched。
6. 显式 Workspace Undo/Redo Actions 从 Search Actions 和 ControlBar 分别触发：两次 Undo 按 B2→B1→B0、两次 Redo 按 B0→B1→B2；沿用既有显式 Undo 确认策略，Cancel 无效果、Confirm 恰一次，不把编辑器无确认误套到 Action。

**TC-IDE-PARITY-007-02-extract-method-stale-dirty.testcase.yaml**，ID `TC-IDE-PARITY-007-02`：

1. 对 request/resolve 各独立 hold；在源文件输入 x，再 release → 没有提取、x 保留、准确 stale/cancelled，零写/历史。再发新请求成功，证明失效后可恢复。
2. 对 symbols-after/prepare-rename/rename 各独立 hold，确认提取已 B1；分别编辑、Undo、切 B 文件、切 B workspace、关闭 A 再重开、provider generation 变化（按 V2 参数化映射分批，不省略任一种失效事件）；release → 无旧弹框/改名/焦点转移，新状态/文本不变。已 Undo 的 A 不得恢复成 B1；新操作仍能成功。
3. 命名框打开期间，通过真实另一 view/workspace 导航或模拟真实外部文件事件使 owner 失效；只关闭此 owner 的局部框。另一个普通 Rename/global confirm 不得被清除。modal 阻止的用户操作用正常可达事件（例如外部文件重载），不要绕过 UI 强制点击遮罩下按钮。
4. request 快速两次正确 chord → 最新有效、恰一提取；symbols-after hold 时再次触发 → 无第二提取。释放/完成后重新调用仍可用。
5. dirty 变体先键入 `// pending` 并保留（不能输入再删除成 clean），在新正确 range 提取 → dirty/no prompt/磁盘 VFS 不变，Undo 回“含 pending 的提取前文本”。同文件 split view 同步结果、非来源 view selection 不跳、无双写；关闭重开/保存后文本一致。
6. 模拟外部 preimage 变化与 writer 失败：commit 前冲突不覆盖，重读再请求可用；writer 后失败按真实结果/recovery 状态展示，不假称取消零效果。browser 只证明 renderer 分支，真实写盘/恢复由 V4/V6。

**TC-IDE-PARITY-007-04-extract-method-entries-boundaries.testcase.yaml**，ID `TC-IDE-PARITY-007-04`：

1. fresh E1 分别经 Search Everywhere Actions 的 Extract Method、ControlBar→Code Workspace Actions 的 `context-menu-workspace-command-workspace.extractMethod`、编辑器 chord 执行；均保持选区/range、源 workspace、一笔 B1/命名。无 file/loading/library/provider absent/tree 焦点分别打开可达菜单检查 disabled/不可用且无 dispatch。
2. 通用 Refactor This 的 Search/ControlBar、Ctrl+Alt+Shift+T 与 Ctrl+T 别名各操作；通用 Code Actions 的 Search/ControlBar、Alt+Enter、`editor-context-code-actions`、gutter、Problems Quick Fix 各操作。有合法 method 候选时选中后走相同命名/保护；gutter/Problems 使用其真实零长 range，若 provider 不提供方法则只验证真实 quickfix 正常且未伪造 method。variable/constant 留在通用集合。
3. multi-candidate 下 ArrowDown/Up→Enter 与鼠标点击分别选项成功；disabled 项点击/Enter 不提交；Esc/点击外部关闭零效果回焦。列项完整有序，method 子 kind 可用、父 kind/缺 kind/title 含 method 不冒认。
4. editor 正确 Ctrl/Meta+Alt+M 执行一次；缺 Alt、多 Shift、错误平台 Mod、AltGraph、按键 repeat 不重复或误触发。在 Find query、Search input、命名 input、terminal、tree 实际按 chord 不抢文字/选区；通过现有 Keymap UI 配置冲突绑定验证提示和单一派发，恢复隔离设置。macOS modifier 在对应 browser 平台 fixture 验证，不能由 Linux Ctrl 结果外推。
5. none 模式分别 E1、E2、空 selection → DEC-06 对应文案，全文/history/磁盘无变化；empty-supported 模式 caret 无 selection → 正常方法提取。这个正例只证明路由，不声称真实 JDT LS 一定支持推断。
6. timeout/changed/error、disabled、malformed、command-only、resolve-error、symbols-error/ambiguous、rename-error 各独立 setup：提交前错误零效果；symbols/rename 失败保留 B1；原因不混成 empty/success，重试在当前 owner 允许时恢复。未知 command 不执行；禁用原因可见；每种错误记录实际文案及最终文本。

**TC-IDE-PARITY-007-05-extract-method-retained-consumers.testcase.yaml**，ID `TC-IDE-PARITY-007-05`：

1. controlled 多文件方法 edit 经真实通用菜单进入 preview，操作 filter（命中/无结果/清空）、collapse、file/usage、Select All/None：完整方法修改始终 required；独立 Cancel/Esc/关闭均零效果。确认后全量 post-image、一笔提取历史及 Undo 恢复；不可用 Apply 点击/Enter 无写。单文件 direct 流程另由 01 证明。
2. 普通双文件 Rename Shift+F6→preview，允许排除原可选项、Cancel 零效果、重新提交→资源 move/引用一致→一次 Undo；dirty/library/conflict 拒绝。Search/ControlBar Rename 入口各复验，不能被 Extract 标题、caret、guard 污染。
3. Alt+Enter/context/gutter/Problems/Search/ControlBar quickfix 各完成正常 apply/undo 和失败后重试；Generate、Rearrange、Cleanup、保存 Organize imports 分别验证正常/真实 empty/provider reject。保存失败提示不得阻断本来可完成的保存；错误传播后的文案按 DEC-05，非本卡方法过滤不影响这些集合。
4. renderer recovery fixture 打开 Review→Cancel/Keep 无写→再次 Review/Restore 正确恢复；Dismiss Cancel 保留、确认只移除目标记录；foreign content 拒绝覆盖。对应实际磁盘/restart/legacy journal 在 V6 手工或既有 native，不能借 browser 通过证明。
5. 本卡修改的局部 modal 与普通 Rename/confirm 连续打开关闭，各自焦点/值/结果独立。全部共享消费者回归选定正常结果，不能只检查控件存在。

实际控件映射：上述已存在的 `text-input-dialog*`、`context-menu-workspace-command-*`、`editor-context-code-actions`、status/editor/search/preview 与 recovery 控件由 P2 按 feature-list 的真实 selector 对照；动态 intention 项先核现有稳定 id，不能把占位 `code-workspace-intention-*` 当 CSS selector。如须新增 testid/fixture/verb，明确落在本卡 owner 内并同步目录；P1 未写入可执行文件。

<a id="provider-probe"></a>

### V4 — native 当前端、真实 provider 与程序 oracle（A1/A3）

拟新增 `qa-ui-auto-tests/cases/TC-IDE-PARITY-007-03-extract-method-jdtls-native.testcase.yaml`，ID `TC-IDE-PARITY-007-03`，`modes: [native]`，fixtures `[reset_db, parity007_extract, jdtls_required]`，`native_platforms: [Linux, Windows]`。当前端 Linux 必跑；Windows/macOS 保留后述手工步骤，不能把既有 Linux-only case 宣称跨端可跑。等待 workspace facts/LSP synced/diagnostics readiness 的实际条件；不用固定 30 s 睡眠替代就绪。

**首次 provider 探针**在命名实现前执行，使用已核 source/config 身份的改前 QA binary（无可用 binary 才为探针构建，记录真实次数；不承诺整轮永远只构建一次）。改前通过现有 Extract 菜单→选择方法候选，不能等待尚未实现的直达/命名框。记录 E1/E3 的原始 codeAction/resolve JSON、kind、默认名、static、edit/command、symbols-before/after、B0/B1 hash/诊断，并运行下述 oracle。若主场景不支持或无法得到可安全应用的 edit，保留失败并回报真实阻塞；不得将拒绝当完成。默认名/格式的期望字节在人工核对语义与 oracle 后固定，不能把实际错误输出直接批准为 golden。

稳定实现后用同输入身份的 QA 构建集中执行：

1. 打开 E1 clean，host hash=B0。选区提取→B1 hash、命名 sumOf→B2 hash；分别保存完整 provider reply/快照，主场景确有新方法和调用，诊断无 error。B0/B1/B2 均运行程序 oracle。
2. 编辑器 Undo 改名→B1、Undo 提取→B0；Redo→B1→B2；每次按键后、显式 Save 前独立读 host hash 与 dirty，再 Save 后复查，不能用 Save 掩盖 Undo 的写盘缺陷。关闭重开确认最终文本。未改名/Cancel 路径只需一次 Undo/Redo。
3. 候选菜单打开后 host 改 `return sum * 2` 为 `return sum * 3`，watcher 重载后点击旧候选 → stale、外部字节保留；恢复/重读 B0 后重新请求成功。dirty 变体保留 `// pending`，提取不落盘、不命名，Undo 保留 pending。只读文件/明确拒写条件的提交失败无伪成功；恢复权限后重试可用。
4. E3 使用[独立副作用 fixture](references/ed-parity-007-windows-reference.md#semantic-fixture)，按 `[6:8,7:32)` 提取→命名 calculateTotal；B0、默认名 B1、改名 B2、Undo/Redo 后各新 JVM 输出 `13:1`、exit 0。调用 next(base) 必须一次，声明/调用不可分离；这不是复用 Windows 产品 PASS。
5. 拟新增原生 verb `parity007_java_oracle: {scenario: e1|e3, expected: "12,0,-2,12"|"13:1"}`：P2 在 `steps/parity007.py` 实现并同步 schema/catalog，使用已配置 JDK 的 javac/java 和参数数组（shell=false），cwd/源码/输出目录均限制在本例报告根。编译原始/当前真实文件及 fixture oracle，exit、stdout/stderr、源 hash、JDK version 与输出路径全部记录。无 verb 时按下方相同流程手工执行，单列 manual evidence，不能写 runner PASS。
6. E1 oracle 为同 package demo 的 `ExtractOracle.java`：`public static void main(String[] args) { ExtractTarget t = new ExtractTarget(); System.out.println(t.total(new int[]{1,2,3}) + "," + t.total(new int[]{}) + "," + t.total(new int[]{-2,1}) + "," + t.total(new int[]{1,2,3})); }`，包装在 `package demo; public class ExtractOracle { ... }`。将它和当下 `ExtractTarget.java` 编译到 fresh `classes/<state>` 后运行 `demo.ExtractOracle`，规范化平台行尾后 stdout 必须精确 `12,0,-2,12\n`，stderr 无编译错误、exit 0；E3 编译 `parity007.ExtractSample`，执行其自带 main。所有数据固定，不从产品输出反推 expected。
7. 写后回读/确认失败在真实 writer 边界一次性故障（P2 参考既有 recovery native fault 设施，最小扩展并记录）→真实恢复结果/recoveryId，禁止显示 cancelled/零写入；重启 workspace 后 Review/Restore/冲突保护沿 V6。若 runner 不支持故障，按 V6 手工步骤保留 host evidence，不删此断言。

native 必要性是 JDT LS/IPC、真实磁盘/preimage/watcher、javac/java 语义、journal/restart；应用内快捷键/焦点已由 V3 覆盖，不额外机械新增 native smoke。Windows/WebView2 按上述 UI+host/JDK 参数步骤，macOS/WKWebView 使用 Cmd 修饰（验证系统拦截时单独记录），direct Cargo 前 stage krb5。其他两端当前 **unrun**；平台自动化缺口允许可复现手工，不允许 mock 替代。清理只结束本例 app/JVM，恢复本例文件权限，保留报告；不触碰用户 IDE/provider 进程。

### V5 — IDEA 双侧比较（A2）

复用 V3/V4 截图与运行，不另建构建。按参照 R1–R10 逐状态记录功能/UI/交互三列：R2 直达与命名入口（模态 vs 就地模板）、R3/R4 改名同步与 caret、R5/R9 撤销步数（两步，已接受）、R6 首次 Esc 只关闭建议列表（完整取消未采；Taomni Esc 保留 B1 为产品决定，不签一致）、R8 重入保护、R10 record 折叠（能力差距）。默认名/`static`/直接落盘及命名框 Esc 保留 B1 记已接受的产品契约；IDEA 自动保存时机/完整 Esc 取消未观察，比较保持 unverified；右键子菜单、Alt+Enter、选项弹窗、重复片段、C1 拒绝文案记 unverified。记录写 `qa-ui-auto-report/idea-comparison/ED-PARITY-007/<run>/record.json`，用 `python .agents/skills/code-workspace-idea-task/scripts/compare_idea.py --record … --schema claudedocs/code-workspace-idea-specs/idea-comparison.schema.json --artifacts-dir .` 校验；validator 通过不等于 matched，预期 verdict 为 `different`/`unverified`。

### V6 — 保留行为回归（A3）

| 保留行为 | 现有检查（改前基线由 P2 先跑） | 本卡处理 |
|---|---|---|
| Alt+Enter/灯泡共享冻结候选、resolve 失败可重试、quick fix 应用 | `CodeWorkspaceTab.test.tsx`：`requests code actions on Alt+Enter and applies workspace edits`、`keeps a failed Alt+Enter resolve visible and retries the frozen candidate`、`shares frozen candidate identity between Alt+Enter and the gutter lightbulb`、`applies provider Java import quick fixes on Alt+Enter…` | 原样通过；DEC-05 只改失败分类，不改候选流程 |
| 编辑中途 refactor 迟到拒绝 | 同文件 `rejects a provider refactor when the editor changes during preview confirmation` | 原样通过 |
| “无动作”真实空结果文案 | 同文件 `never generates or suggests Java import quick fixes in TypeScript files`（`No code actions provided by the language server`）；`ED-AUDIT-016` describe（cleanup 真实缺失） | 原样通过：空结果仍是空结果 |
| 保存时 Organize imports | 同文件 `uses the canonical plan-only result for organize imports on save` | 原样通过；新增一例：provider reject 时保存仍写盘、状态栏含 `save action issue: Organize imports:`（有意改变，拟新增测试名 `ED-PARITY-007 organize imports on save reports provider failure but still saves`） |
| Rename 全链、journal、恢复 | `ED-AUDIT-014: refactor recovery journal` describe；`TC-IDE-C6-04`、`TC-IDE-AUDIT-014-rename-recovery-native`（native, jdtls） | 单测全 describe 复跑；两个 native case 与 V4 同批复跑；平台不支持的步骤按 V6 runbook 手工完成并独立记录（`renameSymbolAt` 重构触及） |
| Rearrange / Cleanup 执行 | `ED-AUDIT-015 …`、`ED-AUDIT-016 …` describe；`TC-IDE-AUDIT-015-rearrange-sortmembers-native`、`TC-IDE-AUDIT-016-cleanup-unavailable-native` | 单测复跑；AUDIT-016 与 V4 同批（其“Provider returned no actions”依赖空结果语义） |
| Adapter 既有分类 | `codeActionProviderAdapter.test.ts` 全文件 | 原样通过 |
| Rust 既有 LSP 解析 | `cargo test --lib code_action_context`、`--lib code_action` | 原样通过 |
| Keymap 冲突与派发 | ED-PARITY-004 `KeymapSettingsDialog.test.tsx`、`workspaceActionHostKeymap.test.ts` | 跑同文件；Ctrl+Alt+M 标题/键位不变 |

#### V6 原生/手工保留 runbook（A3）

复用 `TC-IDE-C6-04-rename-preview-conflict-apply-undo.testcase.yaml`（ID `TC-IDE-C6-04`）和 `TC-IDE-AUDIT-014-rename-recovery-native.testcase.yaml`（ID `TC-IDE-AUDIT-014-rename-recovery-native`）的隔离 maven-single/QuickFixTarget 输入与现有故障机制；只在声明支持的平台直接运行。Windows/macOS 或 runner 缺步骤时，P2 按以下 UI/host 序列记录 manual，不能重标既有 Linux 结果。

1. dirty Java → Shift+F6 拒绝且 host 不变；clean class Rename→含资源 move 的 preview，Cancel 不写；重新提交→路径与引用同步→一次 shared Undo 恢复初始路径/全文。普通 Rename 文案、候选范围、排除策略不受 Extract 影响。
2. 在隔离 root 利用现有 journal 故障设施准备实际 v2 待恢复记录，保留失败顺序/recoveryId/pre/post hash；关闭重开 workspace→Review→Cancel/Keep 不写→Review/Restore 仅在 pre/post/当前磁盘相容时回滚，host 验证。外部追加 foreign content 后 Restore 拒绝覆盖；Dismiss Cancel 保留记录，确认只移除目标记录。v1 legacy 可读取但不自动 replay。故障设施缺平台支持时记录准确未执行断言，不能用 JSON 手写记录冒充一次真实写失败。
3. 新的 Extract 局部 prompt 结束/失效后普通 Rename、确认框各执行一次，输入/焦点和结果独立。恢复权限，关闭本轮 app/provider，保留日志/截图/独立 host hash 到 V6 目录。新引入的共享退化归本卡修复。

### 覆盖维度总映射

下表路径为上述 case 的短 ID，所有结果 **unrun**；步骤号指本设计序列，P2 转为真实 YAML indices。同一步可支持多个 AC，但每个不同入口/状态保留断言。

| AC/V | 维度/对象 | 具体操作与预期所在位置 | test/case 与模式 |
|---|---|---|---|
| A1/V2/V3 | Extract Search/ControlBar/editor；启禁与源 range | 04-1；无 file/loading/library/capability/tree 禁用且无 dispatch | V2 all entries；007-04 browser |
| A1/A3/V3 | 通用 Refactor/CodeActions 全入口与 Ctrl+T 别名 | 04-2、05-3；method 同策略，普通候选不误过滤，真实 range | 007-04/05 browser |
| A1/A3/V3 | modifier、AltGraph、repeat、keymap 冲突、输入/terminal | 04-4、02-4；真实按键，不抢输入，不双派发 | 007-04/02 browser，平台 modifier 分支 |
| A1/A3/V3 | 输入、按钮、Esc/遮罩、Tab/Shift+Tab、IME、错误重试 | 01-1/3/4/5；B1 保留或 B2、输入 undo 不撤提取 | 007-01 browser；V2 name validation |
| A1/V3 | 多候选 Arrow/Enter/click、disabled、empty/错误 | 04-3/5/6；集合/原因/效果准确，空选区正反例 | 007-04 browser |
| A3/V2/V3 | 各 await、切换/关闭/Undo/重启 provider、receipt | V2 late/receipt；02-1/2/3/4；无旧 UI/焦点/写入 | mounted + 007-02 browser |
| A3/V3/V4 | editor 与显式 Undo/Redo、保存/重开 | 01-2/3/6、V4-2；B2/B1/B0 每次全文与历史 | 007-01 browser；007-03 native 磁盘 |
| A1/A3/V3/V4 | dirty/split、完整 edit、preview 控件 | 02-5、05-1、V4-3；不丢输入、不拆语义 | 007-02/05 browser；007-03 native |
| A1/V4 | provider 原始响应与 E1/E3 程序语义 | V4 探针、1/4/5/6；精确输出/exit，不以无诊断代替 | 007-03 native + oracle/manual |
| A3/V3/V4/V6 | 失败、冲突、部分写、恢复/legacy | 02-6、05-4、V4-3/7、V6 runbook | browser + 007-03/既有 native/manual |
| A3/V6 | Rename/quickfix/Generate/Rearrange/Cleanup/save consumers | 05-2/3/5、V6；正常与失败/empty 分别验证 | 007-05 browser + scoped tests/native |
| A2/V5 | 已采 R1–R10 / 历史 Windows 补充 | V5 三维比较，accepted-different 与 unverified 分开 | 复用运行/截图，无额外构建 |

N/A：不新增拖拽排序/参数重排功能；只测所用滚动/窗口可达性。IME 沿现有输入组合保护，局部 wrapper 新拦截必须测 composing Enter（不能以组件复用免测）。IDEA 右键子菜单/选项弹窗未纳入本包改版，参照保持 unverified；Taomni 实际通用入口仍按 04/05 回归。

## 7. P2 最小执行集合

1. 改前：在未改源码上跑 V1 分类项与 V2 新测试（记录预期失败），以及 V6 单测基线：`pnpm exec vitest run src/components/editor/workspace/codeActionProviderAdapter.test.ts` 与 `pnpm exec vitest run src/components/editor/CodeWorkspaceTab.test.tsx -t "Alt+Enter|lightbulb|organize imports on save|rejects a provider refactor|never generates|ED-AUDIT-014|ED-AUDIT-015|ED-AUDIT-016" --maxWorkers=1`。
2. 首个 provider 探针（V4 开头）在实现命名流程前完成；探针使用改前可用入口，原件保存；仅在失败归因/新输入必要时重跑，构建次数按真实身份记录。
3. 迭代：`pnpm exec vitest run src/components/editor/workspace/extractMethodFlow.test.ts src/components/editor/workspace/codeActionProviderAdapter.test.ts` + `pnpm exec vitest run src/components/editor/CodeWorkspaceTab.test.tsx -t "ED-PARITY-007|Alt\+Enter|organize imports on save|ED-AUDIT-014" --maxWorkers=1`；Rust `cargo test --manifest-path src-tauri/Cargo.toml --lib code_actions_from_response` 与 `--lib code_action_context`。
4. 稳定后一次：`python .agents/skills/code-workspace-idea-task/scripts/typecheck_scope.py --path src/components/editor/CodeWorkspaceTab.tsx --path src/components/editor/workspace/extractMethodFlow.ts --path src/components/editor/workspace/codeActionProviderAdapter.ts --path src/stubs/parity007Extract.ts --path src/stubs/tauri-core.ts`（加所改测试文件）；可复用同源 native 构建日志 `--from-file`。
5. browser：`PYTHONPATH=.agents/skills/qa-ui-auto/scripts python -m qa_ui_auto run --mode browser --config .agents/skills/qa-ui-auto/assets/qa-ui-auto.config.browser.yaml --filter TC-IDE-PARITY-007-01,TC-IDE-PARITY-007-02,TC-IDE-PARITY-007-04,TC-IDE-PARITY-007-05 --require-pass`（≤2 workers）。
6. native：`native_build.py --check` → 构建/复用一次 → `run --mode native --filter TC-IDE-PARITY-007-03,TC-IDE-C6-04,TC-IDE-AUDIT-014-rename-recovery-native,TC-IDE-AUDIT-016-cleanup-unavailable-native --require-pass`。
7. 用例/目录变更后一次 `python -m qa_ui_auto audit --gate` 与 `contracts --gate`；V5 比较记录。

完成上限：当前主机平台（本 P1 在 Linux/WebKitGTK）功能与交互；其他两端未验证并列计划；UI 不签 matched；多输出 record 折叠不在本卡。
