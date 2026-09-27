# Java Extract Method：直达提取、命名、边界与撤销

<a id="ed-parity-007"></a>

## 1. 身份、范围与规划门槛

- 唯一卡：[backlog.md](backlog.md) `ED-PARITY-007`；来源 [REQ-06](overall-audit-plan-20260913.md#req-06) / [CW-REFACTOR-002](capability-matrix.md#cw-refactor-002)；回链 [P0 首包](task-planning.md#ed-parity-007)。沿用 `AUDIT-20260913-01`，不重跑整体评估；ED-REF-001（Rename，旧板 done）只作保留来源，不重领。
- 2026-09-27 P1 基线：分支 `docs/code-workspace-idea-audit-20260913`，HEAD `b3591ae10cd9425e92bf844d7a928c8373ad653c`，开始时工作区干净。只读生产源码、只读解包 JDT LS jar 常量池、写设计/参照/交接；没有 claim、开发 owner、产品或测试修改、产品测试、构建、Taomni/JDT LS 启动或提交，未启动其他 agent。
- IDEA 目标：用户要求 **IntelliJ IDEA Ultimate 2026 年任一发行版（2026.x）**，不限定 build（仅本卡）；本轮参照实采于本机 2026.2.2 / IU-262.10315.125，补采/复核可用任一 2026.x 并记录实际 build。用户授权 15 分钟桌面，已在隔离工程实采 R1–R10，见[参照包](references/ed-parity-007-reference.md#observed)。
- 用户决定（2026-09-27）：提取成功后**弹出命名**（复用 Rename 路径，Enter 改名、Esc 保留默认名）；撤销**接受两步**（先撤改名、再撤提取），记为已接受差异。
- 用户结果：F2-EXTRACT-007 中选中单输出语句块 → Ctrl+Alt+M **直接**提取（无候选选择器）→ 命名框预选默认名 → 输入 `sumOf` + Enter → 调用处与声明同步 → 程序行为不变、无诊断 → Ctrl+Z 两次恢复初始字节。多输出选区、空选区、provider 超时/失败/迟到都给出准确边界且零写入。
- 不纳入：Extract Variable/Constant/Field、Inline、Change Signature、Move 的对齐；IDEA 的多输出 record 折叠（R10，能力差距，交 P0 增量）；重复片段替换提示；Alt+Shift+O 选项弹窗；编辑器右键 Refactor 子菜单（IDEA 未采）；启用 JDT LS `advancedExtractRefactoringSupport`（影响全部 extract 类，超出本卡）。
- **P1 于 2026-09-27 规划就绪；所有产品验证未执行。**

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
- **DEC-02 Ctrl+Alt+M 直达（修 G1）**：`workspace.extractMethod` 改走新的 `runExtractMethod`（不再调用通用 `openRefactorActions`）。请求仍发 `only: ["refactor.extract"]`（不改 provider 请求形状），客户端用新纯函数 `isExtractMethodKind(kind)` 精确筛选：`refactor.extract.function`、`refactor.extract.method`，以及 kind 恰为 `refactor.extract` 且标题匹配 `/extract (to )?(method|function)/i` 的项；**不**再按前缀收入 variable/constant/field/interface。
  - 1 个候选：不弹菜单，直接 `runCodeAction(action, file, semanticToken, candidateId, context)`（仍经 `IntentionSession.open` 冻结，保持 id/迟到校验）。
  - ≥2 个候选：弹同一冻结候选菜单，锚点改为选区起点坐标（`editorPaneRef` 内 CodeMirror `coordsAtPos`，取不到时回退现有 +80/+80）。
  - 0 个候选：见 DEC-06。
  - 进行中（请求未返回或命名框打开）再次触发：请求阶段沿用 `intentionRequestAbortRef` 只保留最新一次；命名框为模态，Ctrl+Alt+M 由弹窗吞掉，不产生第二次提取（对应 IDEA R8 的重入保护）。
  - `workspace.refactorThis`、`workspace.codeActions`（Alt+Enter）、Extract Variable 等其他入口保持现有候选菜单与前缀过滤，不改。
- **DEC-03 提取后命名（修 G2，用户已定）**：`runExtractMethod` 在应用前取 `lspDocumentSymbols` 方法快照；`runCodeAction` 返回 `ok` 后等待 LSP 同步当前缓冲，再取快照，用新纯函数 `findExtractedMethodSymbol(before, after)` 找出**唯一**新增的 Method/Function 符号（名称+父容器集合差）。
  - 唯一新增且文件在提取前是干净缓冲：调用重构后的 `renameSymbolAt(file, position, { title: "Extract Method", label: "Method name", confirmLabel: "Rename" })`，position=新方法 `selectionRange.start`；命名框 `text-input-dialog` 预选默认名。Enter 且名称改变 → 走既有 Rename 全链（prepare/rename/plan/gate/preview/history），调用处与声明同步；Enter 未改名或 Esc → 保留默认名，零额外编辑、零额外历史。
  - 提取前缓冲 dirty：Rename 现有 dirty 门禁会拒绝，故**不弹**命名框，状态栏 `Extracted method <name>; save the file, then press Shift+F6 to rename it`。
  - 找不到或多于一个新增方法、documentSymbol 失败：不猜名，不弹框，状态栏 `Extracted method; could not locate the new method to rename it`，提取结果与历史保留。
  - 命名结束后焦点回编辑器，caret 在调用语句行首（对应 IDEA R4 的 5:9）。
  - `renameSymbolAtCursor`（`:16810`）重构为 `renameSymbolAt` + 保持原签名的包装；Shift+F6 行为、文案、dirty/partial/preview/stale 语义不变。
- **DEC-04 撤销（用户已定两步）**：提取与改名各为一个 `WorkspaceEditHistory` 项。编辑器 Ctrl+Z 第一次撤销改名（状态栏 `Undid Rename symbol to "sumOf" (1 files)`），第二次撤销提取（`Undid Extract to method (1 files)`），缓冲与磁盘恢复初始 SHA；Ctrl+Shift+Z 按序重做。无改名时一次 Ctrl+Z 即恢复。编辑器焦点撤销不弹确认（保留 ED-PARITY-006 DEC-06-3）。与 IDEA 单步撤销（R5/R9）记为已接受差异。
- **DEC-05 provider 失败如实分类（修 D1）**：Rust `lsp_code_actions` 抽出纯函数 `code_actions_from_response(Result<Value,String>) -> Result<Vec<LspCodeAction>,String>`，`Err` 向上返回（Tauri invoke reject），`Ok(Null)` 仍为空数组；session 不存在时保持现有 `Ok` 空结果。TS `requestCandidates` catch 增加分类：消息含 `timed out` → `timeout`；含 `document changed` → `cancelled`（`requestCodeActions` 对该情形给出 `Refactor actions were cancelled because the document changed; try again`）；其余 → `failed` 带原文。`requestCodeActions` 的所有调用方（Alt+Enter、灯泡、Problems quick fix、Generate、Rearrange、Cleanup、保存时 Organize imports）因此从“无动作”变为真实失败文案——这是**有意改变**，逐一回归（V6）。真正的空结果文案不变。
- **DEC-06 边界文案（修 G3）**：零个 Extract Method 候选时：空选区 → `Extract Method: select the statements or expression to extract`；非空选区 → `Extract Method is not available for this selection (the language server offers no extraction here, for example when several values would have to be returned)`。多输出不做 record 折叠（能力差距，已登记）。请求失败/超时/取消使用 DEC-05 文案，不落入本条。所有边界零编辑、零历史、零磁盘写入。
- **DEC-07 冲突与迟到**：沿用 `resolvePlan`（revision/generation）、`applyPlan.verifyIdentity` 与 `onBeforeCommit` 快照比对，不新增机制。须验证三处：请求中输入 → 结果丢弃且提示 stale；resolve 中输入 → `Code action became stale: Document revision changed…`；候选菜单打开期间外部改盘（watcher 重载干净缓冲）→ 选择后 stale，零写入。
- **DEC-08 落盘**：干净缓冲提取后立即保存（沿用 §5.2.9 与 ED-PARITY-006 DEC-07）；dirty 缓冲只改缓冲、保持 dirty。与 IDEA“需保存才落盘”记为已接受差异。

### 文件/符号责任与共享消费者

| 文件 / 符号 | 责任 |
|---|---|
| `src/components/editor/CodeWorkspaceTab.tsx`：`workspace.extractMethod` 的 `run`、新 `runExtractMethod`、`renameSymbolAt`（由 `renameSymbolAtCursor` 抽出）、`requestCodeActions` 对 `cancelled/timeout/failed` 的文案、候选菜单锚点参数 | DEC-02/03/05/06 主 owner |
| 新 `src/components/editor/workspace/extractMethodFlow.ts`：`isExtractMethodKind`、`findExtractedMethodSymbol(before, after)`（`LspDocumentSymbol[]` 按 `kind∈{6,12}` + `depth` + `name` 多重集差，唯一才返回）、`extractMethodBoundaryMessage(selectionEmpty)` | DEC-02/03/06 纯逻辑 |
| `src/components/editor/workspace/codeActionProviderAdapter.ts`：`requestCandidates` catch 分类（`timed out`、`document changed`） | DEC-05 |
| `src-tauri/src/lsp.rs`：`lsp_code_actions` 改用新纯函数 `code_actions_from_response`，错误上抛 | DEC-05 |
| 新 `src/stubs/parity007Extract.ts` + `src/stubs/tauri-core.ts` 分派（`lsp_code_actions`、`lsp_code_action_resolve`、`lsp_document_symbols`、`lsp_prepare_rename`、`lsp_rename`，仅 `/preview/parity007` 且开关 `taomni.qa.parity007.enabled` 时生效；模式 normal / multi-candidate / none / timeout / hold-resolve；`window.__taomniQaParity007` 只读观测 + release） | browser 设施，按 `parity005Completion.ts` 模式 |
| 新 `.agents/skills/qa-ui-auto/scripts/qa_ui_auto/fixtures/parity007_extract.py`，注册 `REGISTRY` 与 `schema/testcase.schema.json` | browser `/preview/parity007` 写入 F2-EXTRACT-007；native 复制 `maven-single` 到报告根并新增 `ExtractTarget.java`；导出 `${fixture.parity007_root}`、初值 SHA（由生成字节计算） |
| 共享消费者（只回归不改） | Shift+F6 Rename 全链（`TC-IDE-C6-04`、`TC-IDE-AUDIT-014`）；`workspace.refactorThis`/Alt+Enter/灯泡/Problems quick fix 候选菜单；Generate、Rearrange（`TC-IDE-AUDIT-015`）、Cleanup（`TC-IDE-AUDIT-016`）、保存时 Organize imports；`WorkspaceEditHistory` 与编辑器 Ctrl+Z claim；`workspaceActionRegistry.ts` 标题/键位；Keymap 冲突检测（ED-PARITY-004） |

新增 testid：无（复用 `text-input-dialog*`、`code-workspace-intention-*`、`status-bar-message`、`code-workspace-editor`）。若 P2 需要标记候选菜单根，复用 `ContextMenu` 现有 `data-appearance="code-candidates"`。三端：纯 renderer + LSP 协议 + Rust 错误传播，无平台 API；macOS 为 Cmd+Alt+M（系统“最小化全部窗口”可能拦截，native macOS 未验证，列计划）；AltGr+M 由 host `AltGraph` 拒绝规则保护（`workspaceActionHost.ts:1134`）。

## 4. 连续场景与 UI 目标

| 步 | 操作 | 关键状态 / 焦点 | 最终结果 |
|---|---|---|---|
| S0 | 打开 F2-EXTRACT-007 workspace，Java LSP ready，打开 `ExtractTarget.java` | 编辑器焦点，clean | 初值 SHA `3ffe60d1…` |
| S1 | 选中第 5–8 行整行，Ctrl+Alt+M | **无**候选菜单；应用提取；`text-input-dialog` 标题 `Extract Method`、输入框焦点且默认名全选 | 编辑器可见调用处 `= <default>(values)` 与新方法；干净缓冲已保存，磁盘为“提取后默认名”字节（P2 探针固定 SHA） |
| S2 | 输入 `sumOf`，Enter | 命名框关闭，焦点编辑器，caret 在第 5 行首 | 调用处与声明均为 `sumOf`，无 error 诊断；磁盘为“提取后 sumOf”字节 |
| S2b | （变体）S1 后 Esc | 命名框关闭，焦点编辑器 | 保留默认名；无额外历史项 |
| S3 | 编辑器 Ctrl+Z | 无确认框 | 状态栏 `Undid Rename symbol…`；文本回到默认名 |
| S4 | 编辑器 Ctrl+Z | 无确认框 | 状态栏 `Undid Extract to method…`；文本 = 初值；Ctrl+S 后磁盘 = 初值 SHA |
| S5 | 选中第 13–18 行，Ctrl+Alt+M | 无菜单、无命名框 | 状态栏 DEC-06 非空选区文案；零编辑/历史/写盘 |
| S6 | caret 放第 6 行无选区，Ctrl+Alt+M | 同上 | provider 若返回方法候选则按 S1 走；否则 DEC-06 空选区文案 |
| S7 | provider 超时 / 失败 / document changed | 无菜单 | DEC-05 对应文案，不出现 `No Extract Method… provided` |
| S8 | resolve 挂起时在编辑器输入 1 字符，再放行 | — | `Code action became stale…`；零写入；新输入保留 |
| S9 | dirty 缓冲执行 S1 | 无命名框 | 提取应用到缓冲、保持 dirty、磁盘不变；状态栏 DEC-03 dirty 文案 |
| S10 | Refactor This（Ctrl+Alt+Shift+T）→ 候选菜单 → Esc | 候选菜单含 Extract to method 等 | 零效果；焦点回编辑器（R1 待归因） |

UI 规格：无结构性布局变化，不另出图稿。命名框复用 `TextInputDialog`（宽度、按钮、Esc/Enter 与现有 Rename 一致），仅标题/label 不同；与 IDEA 就地模板（R2 框选+建议列表）记为已接受差异。多候选菜单沿用 `code-candidates` 外观，锚点移到选区起点。状态栏文案为唯一新增可见文本。IDEA 画面见参照 R2–R10 原件。

## 5. 本卡 AC 与 V

- **ED-PARITY-007-A1**（目标）：S1–S2、S2b、S5–S7、S9 — Ctrl+Alt+M 对唯一方法候选直达提取且只收 method/function kind；提取后命名框预选默认名，Enter 同步改名、Esc 保留；多输出/空选区/失败/超时/取消给出准确边界文案且零写入；程序结构与语义正确、无 error 诊断；dirty 缓冲不落盘、不弹命名。→ V1、V2、V3、V4。
- **ED-PARITY-007-A2**（比较）：同 F2-EXTRACT-007 的 IDEA R1–R10 与 Taomni 对应状态分别给功能/UI/交互结论与证据身份；两步撤销、模态命名、直接落盘、默认名/修饰符为已接受差异；R10 record 折叠为能力差距；未采项（右键子菜单、Alt+Enter、选项弹窗、重复片段）标 unverified；不签 matched。→ V5。
- **ED-PARITY-007-A3**（取消、冲突、撤销与保留）：S3–S4、S8、S10 — 候选菜单 Esc 零效果并回焦；请求/resolve/菜单期间的编辑与外部改盘均 stale 零写入；两次 Ctrl+Z 恢复初始字节；Shift+F6 Rename、Refactor This/Alt+Enter 候选菜单、Generate/Rearrange/Cleanup/保存时 Organize imports、失败恢复 id 与编辑器撤销 claim 不退化（仅 DEC-05 的失败文案为有意改变）。→ V1、V2、V4、V6。

验证种类（与 metadata 一致）：`code-audit`、`unit`（V1/V2/V6，含 D1 与 G1 改前失败）、`rust`（V1 Rust 纯函数）、`typecheck`（owned paths 一次 scoped）、`browser`（V3）、`native`（V4 当前端）、`provider`（V4 真实 JDT LS 原始响应与诊断）、`idea-comparison`（V5）。比 P0 初稿新增 `browser`（应用内 Action/快捷键/弹窗路由）与 `rust`（D1 修复），原有种类全部保留。

<a id="test-cases"></a>

## 6. 完整测试用例设计

所有“拟新增”路径当前不存在，均为 **P2 待实现**，状态 unrun。现有用例只列为保留回归，其历史结果不作本卡 PASS。全部 UI case `covers: [F25.5]`，tags 至少 `[code-workspace, refactor, parity007]`。

**Fixture（P2 实现）**：`parity007_extract.py`。browser：按 `parity005_completion.py` 模式在 `/preview/parity007` 写 `pom.xml`（同 maven-single）与 `src/main/java/demo/ExtractTarget.java`（参照 §2 字节），打开开关 `taomni.qa.parity007.enabled`，写 `taomni.recentWorkspaces.v1`，初始 `lastActiveFile` 为该 Java 文件。native：复制 in-repo `maven-single`（忽略 target/build/.git）到 `case_dir/fixture-workspaces/parity007_root`，新增同字节 `ExtractTarget.java`；导出 `${fixture.parity007_root}`、`${fixture.parity007_initial_sha}`（由写入字节计算）。native 另需既有 `jdtls_required`；清理由 `reset_db` 与报告根承担。

**Browser stub（P2 实现，`parity007Extract.ts`）**：只模拟协议形状，不代表 JDT LS 语义。E1 选区返回 1 个 `{title:"Extract to method", kind:"refactor.extract.function", data:{…}}` 与 1 个 `refactor.extract.variable`；resolve 返回把第 5 行替换为 `        int sum = extracted(values);`、删除 6–8 行、在第 10 行后插入 `extracted` 方法的单文件 edit；`lsp_document_symbols` 按当前 VFS 文本解析方法名；`lsp_prepare_rename`/`lsp_rename` 对 `extracted` 返回两处改名 edit。模式：`multi-candidate`（返回两个 function 候选）、`none`（E2/空选区返回仅 variable）、`timeout`（reject `language server request timed out: textDocument/codeAction`）、`changed`（reject `language server request cancelled: document changed`）、`hold-resolve`（resolve 挂起直到 `release("resolve")`）。

### V1 — 纯逻辑与分类（unit / rust，A1/A3）

新文件 `src/components/editor/workspace/extractMethodFlow.test.ts`（拟新增）`describe("ED-PARITY-007: extract method flow model")`：

| 测试名 | 输入 | 预期 |
|---|---|---|
| `isExtractMethodKind accepts function/method kinds only` | `refactor.extract.function`/`.method`/`refactor.extract`+`Extract to method`/`.variable`/`.constant`/`.field`/`.interface`/`refactor.extract`+`Extract to local variable` | 前三为 true，其余 false |
| `findExtractedMethodSymbol returns the single new method` | before 3 个方法、after 多 `extracted`(depth 1) | 返回 `extracted` 及其 `selectionRange` |
| `findExtractedMethodSymbol refuses ambiguity` | after 新增 2 个方法 / 0 个 / 同名重载新增 | `null` |
| `boundary message distinguishes empty and non-empty selections` | `true` / `false` | DEC-06 两句原文 |

`src/components/editor/workspace/codeActionProviderAdapter.test.ts` 增 `describe("ED-PARITY-007: provider failure classification")`：client reject `language server request timed out: textDocument/codeAction` → `state:"timeout"`；reject `…cancelled: document changed` → `state:"cancelled"`；reject `boom` → `state:"failed"` 且 message 含 `boom`；resolve `[]` → `ready` 0 条（空结果不被当失败）。

`src-tauri/src/lsp.rs` inline `#[test]`（拟新增）：`code_actions_from_response_propagates_errors`（`Err("language server request timed out: textDocument/codeAction")` → `Err` 原文）、`code_actions_from_response_keeps_null_as_empty`（`Ok(Null)` → `Ok(vec![])`）、`code_actions_from_response_parses_actions`（一个 `refactor.extract.function` → 1 条，kind/title/raw.data 保留）。命令：`cargo test --manifest-path src-tauri/Cargo.toml --lib code_actions_from_response`。

改前：分类 3 项中 timeout 与 document-changed 在当前 catch 下都落为 `failed`（Rust 文案是 `timed out`，不含现有判断的 `timeout` 子串），作为红→绿。D1 本身在 Rust 层：改前证据是 `lsp.rs:8341-8354` 的静态审计（`.unwrap_or(Value::Null)`），改后由上列 Rust 纯函数测试证明错误上抛；TS mock 直接 reject 会绕过 Rust，不能单独证明 D1。

### V2 — 挂载的生产入口（mounted，A1/A3）

`src/components/editor/CodeWorkspaceTab.test.tsx` 新增 `describe("ED-PARITY-007: extract method direct run, naming and boundaries (mounted)")`，沿用同文件 ED-AUDIT-014 的 Java 文件挂载、`lspMocks`（`lspCodeActions`、`lspCodeActionResolve`、`lspDocumentSymbols`、`lspPrepareRename`、`lspRename`）与写盘 mock 模式；按键用真实 `keyDown` 到 `.cm-content`（`Control+Alt+M` → `{key:"m", ctrlKey, altKey}`）。

| 测试名（拟新增） | 操作 | 预期 |
|---|---|---|
| `Ctrl+Alt+M runs the only method candidate without a menu and prompts for a name` | 选区 5–8，返回 function+variable 两个候选 | 无 `code-workspace-intention-*` 菜单；resolve 只对 function 调用 1 次；`text-input-dialog` 标题 `Extract Method`，输入值为默认名 |
| `Enter renames call site and declaration; Escape keeps the default name` | 同上后分别 Enter(`sumOf`) / Esc | Enter：`lspRename` 以新方法 selectionRange.start 调用 1 次，缓冲含两处 `sumOf`；Esc：`lspRename` 0 次，历史只 1 项 |
| `two editor undos restore the original text` | Enter 后在编辑器 Ctrl+Z ×2 | 第一次状态栏含 `Undid Rename symbol`，第二次含 `Undid Extract to method`；缓冲 = 初值；无 `code-workspace-undo-confirm` |
| `multiple method candidates open an anchored chooser` | 返回两个 function 候选 | 菜单出现且只含这两项；选择其一后同第一项命名流程 |
| `no method candidate reports the selection boundary with zero writes` | 仅 variable / 空选区 | 状态栏为 DEC-06 对应原文；写盘/历史/resolve 0 次 |
| `provider failure is reported instead of no actions` | `lspCodeActions` reject timeout / document changed / 其他 | 分别为 DEC-05 文案；不含 `No Extract Method/Function actions provided`；写盘 0 |
| `typing during resolve makes the extraction stale` | resolve 挂起时在编辑器键入 `x`，再 resolve | 状态栏含 `Code action became stale`；写盘/历史 0；`x` 保留 |
| `dirty buffer extracts without saving or prompting` | 先键入使 dirty，再 Ctrl+Alt+M | 缓冲已提取且 dirty；写盘 0；无命名框；状态栏 DEC-03 dirty 文案 |
| `ambiguous symbol diff skips the prompt` | after 快照新增 2 个方法 | 无命名框；状态栏 `could not locate the new method`；提取历史 1 项 |
| `Ctrl+Alt+M is inert in inputs and while the name dialog is open` | 焦点在 Search Everywhere 输入框按 Ctrl+Alt+M；命名框打开时再按 | 两者均 `lspCodeActions` 0 次新增调用、无第二次提取 |
| `AltGraph+M does not trigger extraction` | `keyDown` 带 `getModifierState("AltGraph")===true` | `lspCodeActions` 0 次 |
| `Escape on a Refactor This chooser returns focus to the editor` | Ctrl+Alt+Shift+T → 菜单 → Esc | 零效果；`document.activeElement` 在 `.cm-content` 内（R1：若改前失败，作为红→绿并修 `showCodeActionsMenu` 回焦） |

改前：第 1、2、4、5、8、9 项在当前源码失败（总弹菜单/无命名/前缀收入 variable/边界文案），作为 G1/G2/G3 红→绿证据保留；第 6 项中 timeout/document-changed 文案改前为通用 `Code action request failed`，其他 reject 改前已如实失败（P2 记录实际）；第 3、7、10、11、12 项检查保留语义或待归因 R1，P2 记录改前实际结果，不预设。

### V3 — browser 连续主序列与入口（A1/A3）

拟新增 `qa-ui-auto-tests/cases/TC-IDE-PARITY-007-01-extract-method-direct-name-undo.testcase.yaml`，ID `TC-IDE-PARITY-007-01`，`modes: [browser]`，fixtures `[reset_db, parity007_extract]`。所用 verbs 均已存在：`open/click/press/type/fill/wait_for/assert_text/assert_text_equals/assert_pattern/assert_count/assert_not_visible/eval_readonly/screenshot`；选区用 `click` 第 5 行 `.cm-line` + `press: Home` + `press: Shift+ArrowDown`×4（P2 按实际 DOM 固定 selector，不用 `eval_readonly` 改选区）。焦点断言用 `eval_readonly`（如 `document.activeElement?.closest('.cm-content') !== null`）。

1. 从 welcome recents 打开 `${fixture.parity007_root}`，编辑器显示 `int total(int[] values)`；`__taomniQaParity007.observe()` 为 normal 模式。
2. 选中 5–8 行；`press: Control+Alt+M` → `wait_for` `text-input-dialog`；`assert_not_visible` `[data-appearance="code-candidates"]`；输入框值为 `extracted`；`screenshot` S1。
3. `fill` `sumOf`，`press: Enter` → 对话框不可见；编辑器 `assert_pattern` `(?s)int sum = sumOf\(values\);.*private .*int sumOf\(int\[\] values\)`；焦点在编辑器；`screenshot` S2。
4. `press: Control+z` → 状态栏含 `Undid Rename symbol`；`press: Control+z` → 状态栏含 `Undid Extract to method`；`assert_text_equals` 编辑器 = 参照初值全文；无 `code-workspace-undo-confirm`。
5. 变体 S2b：再次选中并 Ctrl+Alt+M → `press: Escape` → 编辑器含 `extracted(values)`；Ctrl+Z 一次恢复初值（证明 Esc 不产生额外历史）。
6. S5：选中 13–18 行（stub `none`）Ctrl+Alt+M → 状态栏 DEC-06 非空选区原文；编辑器文本不变。S6：caret 放第 6 行无选区 → 空选区原文。
7. S7：`setMode("timeout")` → Ctrl+Alt+M → 状态栏含 `timed out`，不含 `No Extract Method`；`setMode("changed")` → 含 `document changed`。
8. 入口：Search Everywhere Actions 搜 `Extract Method` → Enter（选区保留时）→ 同步骤 2 出现命名框 → Esc；焦点在 Search Everywhere 输入框时按 Ctrl+Alt+M → `observe().events` 无新请求。
9. `setMode("multi-candidate")` → Ctrl+Alt+M → 候选菜单出现且恰 2 项；`press: Escape` → 零效果，焦点回编辑器（R1）。

拟新增 `TC-IDE-PARITY-007-02-extract-method-stale-dirty.testcase.yaml`，ID `TC-IDE-PARITY-007-02`，`modes: [browser]`：`hold-resolve` 下 Ctrl+Alt+M 后在编辑器键入 `x`，`release("resolve")` → 状态栏含 `became stale`，`x` 保留、无提取；清除 `x` 使 dirty，再提取 → 无命名框、状态栏 DEC-03 dirty 原文、标签 dirty 标记保留。

清理：reset_db；VFS 随 fixture 重建。边界：stub 不证明 JDT LS 语义、主机字节与真实键路由。

### V4 — native 当前端 + 真实 JDT LS（A1/A3，provider）

拟新增 `qa-ui-auto-tests/cases/TC-IDE-PARITY-007-03-extract-method-jdtls-native.testcase.yaml`，ID `TC-IDE-PARITY-007-03`，`modes: [native]`，fixtures `[reset_db, parity007_extract, jdtls_required]`，`native_platforms: [Linux, Windows]`，timeout 600。只用跨平台 verbs（`click/press/fill/type/host_write_file/assert_file_sha256/assert_text/assert_pattern`；不用 X11-only `native_click`/`native_keys transport:x11`）。沿用 TC-IDE-AUDIT-015 的 recents 进入与 `code-workspace-lsp-status-pill` 含 `Java` 就绪门、30 s 导入稳定等待。

1. 进入 workspace 打开 `ExtractTarget.java`；`assert_file_sha256` = `${fixture.parity007_initial_sha}`。
2. **首个探针（先于其余步骤、单独运行一次并保存原件）**：选中 5–8 行 Ctrl+Alt+M，记录 provider 原始 codeAction/resolve JSON、默认名、是否 `static`、提取后磁盘 SHA；若 JDT LS 不返回 `refactor.extract.function` 或 resolve 无 edit，停止实现并按 R2 回报，不改期望。
3. 命名框 `fill` `sumOf` + Enter → 编辑器模式同 V3-3；`assert_file_sha256` = 探针固定的“提取后 sumOf”SHA；Problems/诊断无 error（P2 按现有 Problems 面板 testid 断言）。
4. 编辑器 Ctrl+Z ×2 → 文本 = 初值；`press: Control+s` → `assert_file_sha256` = 初值 SHA。
5. 冲突：Ctrl+Alt+Shift+T 打开 Refactor This 候选菜单（statement 选区通常 ≥2 项）→ `host_write_file` 把第 9 行改为 `        return sum * 3;` → 状态栏含 `from disk` → 点击 `Extract to method` → 状态栏含 `stale`；`assert_file_sha256` = 外部写入字节（P2 实算）；无命名框。恢复初值字节并等待重载。
6. dirty：编辑器末尾键入空格使 dirty → Ctrl+Alt+M → 无命名框；`assert_file_sha256` 仍为初值；Ctrl+Z 恢复并 Ctrl+S。
7. 保留：光标放 `total`，Shift+F6 → 命名框标题 `Rename Symbol` → `fill` `sum2`… Esc（零效果）；证明 Rename 入口文案未被 Extract 命名覆盖。

native 理由：真实 JDT LS 1.61 的 kind/title/resolve edit 与诊断、Tauri 写盘字节与撤销后保存、watcher 重载触发 stale、WebView 中 Ctrl+Alt+M/Ctrl+Alt+Shift+T 的真实键路由，browser stub 均不能证明。当前主机平台必跑；另一平台（Linux/Windows）与 macOS（Cmd+Alt+M，可能被系统“最小化全部窗口”拦截；direct Cargo 前 stage krb5）列计划，未验证。

### V5 — IDEA 双侧比较（A2）

复用 V3/V4 截图与运行，不另建构建。按参照 R1–R10 逐状态记录功能/UI/交互三列：R2 直达与命名入口（模态 vs 就地模板）、R3/R4 改名同步与 caret、R5/R9 撤销步数（两步，已接受）、R6 Esc 结果（保留默认名，一致）、R8 重入保护、R10 record 折叠（能力差距）。默认名/`static`/直接落盘记 accepted-different；右键子菜单、Alt+Enter、选项弹窗、重复片段、C1 拒绝文案记 unverified。记录写 `qa-ui-auto-report/idea-comparison/ED-PARITY-007/<run>/record.json`，用 `python .agents/skills/code-workspace-idea-task/scripts/compare_idea.py --record … --schema claudedocs/code-workspace-idea-specs/idea-comparison.schema.json --artifacts-dir .` 校验；validator 通过不等于 matched，预期 verdict 为 `different`/`unverified`。

### V6 — 保留行为回归（A3）

| 保留行为 | 现有检查（改前基线由 P2 先跑） | 本卡处理 |
|---|---|---|
| Alt+Enter/灯泡共享冻结候选、resolve 失败可重试、quick fix 应用 | `CodeWorkspaceTab.test.tsx`：`requests code actions on Alt+Enter and applies workspace edits`、`keeps a failed Alt+Enter resolve visible and retries the frozen candidate`、`shares frozen candidate identity between Alt+Enter and the gutter lightbulb`、`applies provider Java import quick fixes on Alt+Enter…` | 原样通过；DEC-05 只改失败分类，不改候选流程 |
| 编辑中途 refactor 迟到拒绝 | 同文件 `rejects a provider refactor when the editor changes during preview confirmation` | 原样通过 |
| “无动作”真实空结果文案 | 同文件 `never generates or suggests Java import quick fixes in TypeScript files`（`No code actions provided by the language server`）；`ED-AUDIT-016` describe（cleanup 真实缺失） | 原样通过：空结果仍是空结果 |
| 保存时 Organize imports | 同文件 `uses the canonical plan-only result for organize imports on save` | 原样通过；新增一例：provider reject 时保存仍写盘、状态栏含 `save action issue: Organize imports:`（有意改变，拟新增测试名 `ED-PARITY-007 organize imports on save reports provider failure but still saves`） |
| Rename 全链、journal、恢复 | `ED-AUDIT-014: refactor recovery journal` describe；`TC-IDE-C6-04`、`TC-IDE-AUDIT-014-rename-recovery-native`（native, jdtls） | 单测全 describe 复跑；两个 native case 与 V4 同批复跑（`renameSymbolAt` 重构触及） |
| Rearrange / Cleanup 执行 | `ED-AUDIT-015 …`、`ED-AUDIT-016 …` describe；`TC-IDE-AUDIT-015-rearrange-sortmembers-native`、`TC-IDE-AUDIT-016-cleanup-unavailable-native` | 单测复跑；AUDIT-016 与 V4 同批（其“Provider returned no actions”依赖空结果语义） |
| Adapter 既有分类 | `codeActionProviderAdapter.test.ts` 全文件 | 原样通过 |
| Rust 既有 LSP 解析 | `cargo test --lib code_action_context`、`--lib code_action` | 原样通过 |
| Keymap 冲突与派发 | ED-PARITY-004 `KeymapSettingsDialog.test.tsx`、`workspaceActionHostKeymap.test.ts` | 跑同文件；Ctrl+Alt+M 标题/键位不变 |

### 覆盖维度总映射

| AC/V | 维度 | 控件 / Action / 快捷键 + 上下文 | 操作 → 预期 | case/test | 模式（native 理由） | 结果 |
|---|---|---|---|---|---|---|
| A1/V2/V3 | 快捷键 | Ctrl+Alt+M（编辑器、有选区） | 直达提取 + 命名框 | V2-1；007-01 步 2 | browser | unrun |
| A1/V2 | 快捷键 | Ctrl+Alt+M 在输入框 / 命名框打开时 / AltGr | 不触发、无重入 | V2-10/11；007-01 步 8 | browser | unrun |
| A1/V4 | 快捷键 | Ctrl+Alt+M 真实 WebView 键路由 | 同上主路径 | 007-03 步 2–3 | native（OS/WebView 键事件） | unrun |
| A1/V3 | Action | Search Everywhere Actions `Extract Method` | 同快捷键结果；输入框焦点保护 | 007-01 步 8 | browser | unrun |
| A3/V2/V3 | Action | Refactor This（Ctrl+Alt+Shift+T）候选菜单 | 列出 extract 等；Esc 零效果回焦 | V2-12；007-01 步 9 | browser | unrun |
| A1/V2/V3 | 弹窗 | `text-input-dialog`（标题/预选/Enter/Esc） | Enter 改名、Esc 保留 | V2-2；007-01 步 3/5 | browser | unrun |
| A1/V2/V3 | 控件 | 多候选菜单（Arrow/Enter/点击/Esc） | 只含 method 候选；选中即提取 | V2-4；007-01 步 9 | browser | unrun |
| A1/V2/V3 | UI | 状态栏边界/失败/dirty/ambiguous 文案 | DEC-03/05/06 原文 | V2-5/6/8/9；007-01 步 6–7；007-02 | browser | unrun |
| A1/V4 | provider | 真实 JDT LS kind/title/resolve/诊断 | 探针原始 JSON；无 error | 007-03 步 2–3 | native（真实 provider） | unrun |
| A3/V2/V3/V4 | 生命周期 | 请求中/resolve 中输入、菜单期间外部改盘 | stale 零写入 | V2-7；007-02；007-03 步 5 | browser + native（watcher/磁盘） | unrun |
| A3/V2/V3/V4 | 撤销 | 编辑器 Ctrl+Z ×2、Ctrl+Shift+Z | 两步恢复；初值字节 | V2-3；007-01 步 4；007-03 步 4 | browser + native（磁盘字节） | unrun |
| A1/V2/V4 | 生命周期 | dirty 缓冲提取 | 不落盘、不弹命名 | V2-8；007-02；007-03 步 6 | browser + native | unrun |
| A1/V1 | 逻辑 | kind 过滤、符号差、分类、Rust 错误上抛 | 见 V1 表 | V1 | unit / rust | unrun |
| A3/V6 | 共享消费者 | Alt+Enter、灯泡、Organize imports on save、Rename、Rearrange、Cleanup、Keymap | 见 V6 | 既有单测/case | 同原 case | unrun |
| A2/V5 | 比较 | R1–R10 | 三维结论 | compare record | 复用 | unrun |

N/A：拖拽/滚动（本流程无）；IME（不改文本输入路径，命名框为既有 `TextInputDialog`，composition 语义不变）；主题/缩放像素（不签视觉 matched）；右键编辑器菜单（本卡不新增 Refactor 子菜单，IDEA 侧未采，记 unverified 而非缺陷）。

## 7. P2 最小执行集合

1. 改前：在未改源码上跑 V1 分类项与 V2 新测试（记录预期失败），以及 V6 单测基线：`pnpm exec vitest run src/components/editor/workspace/codeActionProviderAdapter.test.ts` 与 `pnpm exec vitest run src/components/editor/CodeWorkspaceTab.test.tsx -t "Alt+Enter|lightbulb|organize imports on save|rejects a provider refactor|never generates|ED-AUDIT-014|ED-AUDIT-015|ED-AUDIT-016" --maxWorkers=1`。
2. 首个 provider 探针（V4 步 2）在实现命名流程前完成；探针与构建只做一次，原件保存。
3. 迭代：`pnpm exec vitest run src/components/editor/workspace/extractMethodFlow.test.ts src/components/editor/workspace/codeActionProviderAdapter.test.ts` + `pnpm exec vitest run src/components/editor/CodeWorkspaceTab.test.tsx -t "ED-PARITY-007|Alt\+Enter|organize imports on save|ED-AUDIT-014" --maxWorkers=1`；Rust `cargo test --manifest-path src-tauri/Cargo.toml --lib code_actions_from_response` 与 `--lib code_action_context`。
4. 稳定后一次：`python .agents/skills/code-workspace-idea-task/scripts/typecheck_scope.py --path src/components/editor/CodeWorkspaceTab.tsx --path src/components/editor/workspace/extractMethodFlow.ts --path src/components/editor/workspace/codeActionProviderAdapter.ts --path src/stubs/parity007Extract.ts --path src/stubs/tauri-core.ts`（加所改测试文件）；可复用同源 native 构建日志 `--from-file`。
5. browser：`PYTHONPATH=.agents/skills/qa-ui-auto/scripts python -m qa_ui_auto run --mode browser --config .agents/skills/qa-ui-auto/assets/qa-ui-auto.config.browser.yaml --filter TC-IDE-PARITY-007-01,TC-IDE-PARITY-007-02 --require-pass`（≤2 workers）。
6. native：`native_build.py --check` → 构建/复用一次 → `run --mode native --filter TC-IDE-PARITY-007-03,TC-IDE-C6-04,TC-IDE-AUDIT-014-rename-recovery-native,TC-IDE-AUDIT-016-cleanup-unavailable-native --require-pass`。
7. 用例/目录变更后一次 `python -m qa_ui_auto audit --gate` 与 `contracts --gate`；V5 比较记录。

完成上限：当前主机平台（本 P1 在 Linux/WebKitGTK）功能与交互；其他两端未验证并列计划；UI 不签 matched；多输出 record 折叠不在本卡。
