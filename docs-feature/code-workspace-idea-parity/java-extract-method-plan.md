# Java Extract Method：ED-PARITY-007 P1 设计

<a id="ed-parity-007"></a>

## 1. 范围、身份与结论

唯一卡：`docs-feature/code-workspace-idea-parity/backlog.md::ED-PARITY-007`。来源：`AUDIT-20260913-01` / [REQ-06](overall-audit-plan-20260913.md#req-06) / [CW-REFACTOR-002](capability-matrix.md#cw-refactor-002)。[P0 首包](task-planning.md#ed-parity-007)保留；不重跑首次 P0，不选择旧板，不重复 Rename，也不接入 Inline/Move/Change Signature。

2026-09-27 调研基线：分支 `docs/code-workspace-idea-audit-20260913`，HEAD `b3591ae10cd9425e92bf844d7a928c8373ad653c`；接手 `git status --short` 为空。只做 P1，无开发 owner/claimed_at/baseline、无第二套规划状态。Windows 为当前端；Windows/macOS/Linux 均保留兼容要求。

**当前设计未就绪，卡保持 deferred / planning_required=true。** 已完成范围、源码链、provider 静态支持判断、隔离输入、事务/保留契约和可确定部分的完整用例设计。IDEA 主链现已实采（11:33:41–11:42:16 +08:00）；真实流程与现有 provider/preview 链有实质差异，DEC-02 的首包取舍、对应命名事务仍未决定；见[方案图](java-extract-method-options.png)与[阻塞](#readiness)。不能交由 P2 猜目标或立即领取。所有产品验证均未执行；静态阅读不记产品 PASS。

用户结果：在 F2-EXTRACT-007 的两条 Java 语句上触发 Extract Method，查看真实语义变更，取消时零副作用，确认后程序仍输出 `13:1`，单次共享撤销恢复整份原文和磁盘；错误/不支持有准确原因，不能将拒绝当完成。参照及可重建字节见[参考包](references/ed-parity-007-reference.md#fixture)。

本卡验收索引：**ED-PARITY-007-A1**（受支持方法提取、输入/预览/正确程序结果与准确拒绝边界）、**ED-PARITY-007-A2**（同 fixture 的功能/视觉/交互参照与双侧判断）、**ED-PARITY-007-A3**（取消、冲突、迟到、一次 undo 与 Rename/recovery 保留）。完整合同和 V 映射见[验收节](#acceptance)，不是其他卡验收的别名。

## 2. 当前事实与差距分类

以下均为本轮静态源码核对，非运行复现。路径链接供定位，符号优先于旧文档行号。

| 分类 / ID | 事实与依据 | 本卡处理及证明上限 |
|---|---|---|
| 现有基础 B1 | [CodeWorkspaceTab.tsx](../../src/components/editor/CodeWorkspaceTab.tsx) 的 `workspace.extractMethod` → `openRefactorActions` → `showCodeActionsMenu`，以当前 editor selection 构造 LSP range；[workspaceActionRegistry.ts](../../src/components/editor/workspace/workspaceActionRegistry.ts) 注册 `Ctrl+Alt+M`，实际别名 `Mod-Alt-M/m` | 复用统一 Action，不新增平行派发器；已接线不等于 Java 提取可用 |
| 静态体验差距 G1 | Extract Method 请求 `refactor.extract`、`.function`、`.method`；`showCodeActionsMenu` 的父级前缀匹配也允许 `.variable/.constant` 进入结果 | 方法专用入口应只呈现方法/函数；Refactor This、通用 Code Actions 保留全类别。真实 provider 是否在此选区返回杂项未执行 |
| 现有基础 B2 | `requestCodeActions` → `lspCodeActions` → [lsp.rs](../../src-tauri/src/lsp.rs)::`lsp_code_actions` → `textDocument/codeAction`；`IntentionSession` 冻结候选与 revision/generation/fingerprint；resolve 重试与 superseded 检查已有实现 | 使用原请求生命周期，保护快速再次触发/切文件；不重新规划旧 session 修复 |
| 能力缺口 G2 | [codeActionProviderAdapter.ts](../../src/components/editor/workspace/codeActionProviderAdapter.ts)::`resolvePlan` 返回 edit/command；现有入口无 Java Extract 的命名输入合同；provider 有默认名或 client command 两分支 | IDEA 已观察 inline 改名，JDT 当前默认 edit 不接收 `methodName`；BL-02/03 是目标取舍与适配合同，不再是无参照。不能假造协议或默认接受差异 |
| 静态保护缺口 G3 | `runCodeAction` 对 refactor 调 `buildRefactorPlan` 时未传 `requiredOperationIndexes`；[RefactoringPreviewDialog.tsx](../../src/components/editor/workspace/RefactoringPreviewDialog.tsx) 只有 required usage 被锁定，其余允许逐项排除 | 提取声明与调用点必须作为同一完整语义变更；不允许只应用一半。是否具体 provider 合并为一项 edit 尚待真实结果，不把风险写成已复现语法破坏 |
| 现有基础 B3 | `runCodeAction` → `CanonicalCodeActionService.applyPlan` → `applyLspWorkspaceEdit(preview:true, recordHistory:false)` → `workspaceEditApply` / `commitOpenBufferPreparedSave`、`commitClosedFilePreparedSave` → 快照/history/recovery；partial completeness 明示，preimage/identity 再检 | 复用统一预览、保存和一次 undo；不可重做 Rename 事务，也不可用一次 editor replace 绕过 native 写盘 |
| 待归因风险 R1 | `CanonicalCodeActionService` 允许 command-only 计划；纯 command 没有等价 edit 快照。JDT 的 `java.action.applyRefactoring` 是客户端协议，不等于任意 server command 都可安全执行 | 本卡 Extract 必须得到可审阅的纯 edit 后才可提交；未支持 command 明示边界，原生验证仍必需 |
| 待归因风险 R2 | `lsp_code_actions` 请求错误当前 `.unwrap_or(Value::Null)`，与空结果可能合并；UI 无法只凭空集合判断是合法不支持还是 provider 失败 | V3 真实/模拟错误区分；只有确认影响本卡时最小修正该 IPC 与消费者，不因历史 ADR 重写整个 LSP |
| 证据缺口 E1 | [参考包](references/ed-parity-007-reference.md#provider-source)验证 JDT LS 1.61 源码有 Extract Method；本机 jar 为 `1.61.0.202607142124`，历史 trace 为另一 timestamp build | 有实现依据、运行支持待 V7；不沿用旧 provider PASS，不在 P1 启动 probe |
| 体验差异 G4 / 证据缺口 E2 | IDEA R1–R6 主链已采，R7 空选区可推断语句；首次为 inline 临时命名，More options 只有签名预览。Taomni 仍为完整文件预览，无临时命名 owner | DEC-02 待用户取舍；R7 剩余键盘/异常状态未采、产品未跑，A2 不可 matched |

旧 `ED-REF-001` 2026-09-15（HEAD `6e93624ae1bd4e42686fbf6b8ecd8da0dfce7087`）记录 Linux Rename/preview/资源移动/undo/recovery；只读核其[合同](../../claudedocs/code-workspace-idea-specs/search-and-navigation.md#ed-ref-001)与[后续设计](refactor-rename-design.md)。其 native Windows/macOS 原为未执行，不能移签到本卡。现有测试源码用于设计保留断言，旧测试存在/历史 PASS 不代表当前通过。

<a id="decisions"></a>

## 3. DEC 与连续场景

本表 `DEC-xx` 均以 `ED-PARITY-007-` 为前缀，不借其他卡决定。

| ID | 决定、依据与取舍 | 状态 | AC / V |
|---|---|---|---|
| DEC-01 | 用户最新明确：**IDEA 2026 系列即可，不限制 patch/build**。已有实采 Ultimate 2026.2.2 / IU-262.10315.125 仍保留原身份；换用其他 2026.x 记录实际 build/edition，复用匹配状态，仅补受行为差异影响的参照。版本放宽不表示 DEC-02 选 A，也不续期桌面时段 | 用户已定；2026-09-27 后续指示覆盖原 patch 限定 | A2 / V6 |
| DEC-02 | [图稿 A/B](java-extract-method-options.png)：A 默认名+完整文件预览（接受首包无 inline 自定义名）；B 保持 IDEA inline 目标，需要语义命名/临时事务及范围核定。原参照无独立 diff Preview；详见下表 | **待用户决定；推荐 B 保持对齐目标，禁止 P2 自行接受 A** | A1/A2/A3 / V1/V2/V6/V7 |
| DEC-03 | 专用入口仅保留 `refactor.extract.function` / `.method` 及它们子 kind；父 kind/缺 kind 不能靠 title 字符串猜成方法。通用 Refactor This/Code Actions 保持真实类别集合和 disabledReason | agent 自决，符合方法首包及 G1 | A1/A3 / V1/V3/V5 |
| DEC-04 | 使用语义 provider 生成 edit；本包不实现正则/字符串提取。`java.action.applyRefactoring` 等未适配客户端协议只显示明确原因，不发送为任意 `workspace/executeCommand`，不自动升级 advanced capabilities | agent 自决，保护零效果预览；命名适配仍受 DEC-02 约束 | A1/A3 / V3/V7 |
| DEC-05 | 提取调用点和方法声明为不可拆整体；全部 text operations 标 required，file/usage/select-none 均不能移除必要修改；不得全局禁用 Rename 原有可排除部分 | agent 自决，程序语义与 G3 | A1/A3 / V2/V5 |
| DEC-06 | 保留 canonical preimage/preflight/postimage、encoding/EOL、single history、资源 replay 和 recovery。取消发生在写入前为零效果；写入已发生时不得假报 cancelled，按真实结果/恢复显示 | 沿用生产保存与事务合同；IDEA 自动保存/undo 差异须在 V6 明列，未接受不关闭 | A3 / V2/V4/V5/V7 |
| DEC-07 | 冻结 workspace instance、file key、URI、revision、range、provider generation、fingerprint、请求代数；每次 await 后与 commit 前核对。切换/编辑/关闭/重开不得让旧结果污染新上下文；重复触发只保留最新有效请求 | agent 自决，复用现有 session 与 shared query host | A1/A3 / V3/V4 |
| DEC-08 | 应用内入口/快捷键/焦点/控件使用 browser；native 仅承担真实 JDT LS/IPC、磁盘 hash/原生恢复与受支持程序输出。三端分别记录；纯样式不额外建 native smoke | 依 qa-ui-auto 高效验证规则 | A1/A2/A3 / V1–V8 |


### DEC-02 方案比较与接续条件（v1）

| 方案 | 用户结果与差异 | 工程依据 / 剩余责任 | 当前决定 |
|---|---|---|---|
| A：默认名 + 完整预览 | 明确选区→provider 默认唯一名→整体 diff（调用/声明锁为必选）→Cancel 或 Apply→一次 Undo；不提供自定义名/参数编辑；保留 clean-buffer 自动保存。功能需真实运行 `13:1`。这是与 IDEA inline/签名预览不同的首包体验 | 可复用现有纯 edit+canonical 事务；必需操作锁定及精确类别过滤是本卡改动。P1 要把“不提供自定义命名”明确记录为用户接受差异，不能算 visually/interaction matched；不能以未来 Rename 代替本包命名能力 | **未被接受**；已有权限不包含接受差异 |
| B：保留 IDEA inline 目标 | 临时显示新方法和调用→getTotal 名称选中→calculateTotal→Enter；Esc 撤销临时提取、确认后一次 Undo。More options/参数范围按 P0 首包核定，不能默认删验收 | `GetRefactorEditHandler` 可返回新文本的 rename position；现 production `lspRename` 接收 descriptor/position/newName，但只针对已同步 live 文档；没有 pending Extract 事务。需要预览文本/provider 同步隔离、一个持久提交以及失败补偿设计；不能直接调用现有独立 Rename UI | **推荐保持目标，待用户决定**；若改变 P0 首包大小/拆卡，交 P0 增量，不由 P1 新建卡 |

2026-09-27 已在聊天展示图稿并异步询问 A/B。这是具体体验/范围取舍，不是开发许可、最终设计审批或要求用户提供参数表；提问依据 [feature-design skill](../../.agents/skills/feature-design/SKILL.md)“需要偏离参照、改变产品范围或兼容代价时再就具体方案讨论”。未回复不接受 A，也不把 B 的未定实现合同推给 P2。

补充生产核对：`CodeWorkspaceTab.tsx::renameSymbolAtCursor` 先 `ensureWorkspaceSemanticDocumentsSynced`，再 prepareRename→prompt→lspRename→buildRefactorPlan→applyLspWorkspaceEdit，具有独立 semantic build/history 生命周期；`workspaceDocumentTransactionOwner.ts` 以 document text/revision/view leases 与 undo/redo 管理提交，只有 `remote-sync` 不计一般 history，没有 Extract begin/commit/abort API。把临时 edit 标 remote-sync 不能自动屏蔽 dirty、save、didChange、split view、close/recovery 等消费者。不得采用“先持久应用默认名再调用普通 Rename”来满足取消零效果和一次 Undo。

B 的必要设计输入已收敛：以 `{workspaceInstance,fileKey,uri,providerGeneration,fingerprint,baseRevision,baseText,selection,sessionId}` 为身份；确认前保存源 B0、临时 post、名称 revision 分开；每次语义 rename 只作用于当前临时版本、名称返回不得越过 session；取消/关 view/切 workspace 必须恢复 provider 同步基线且不碰磁盘/history；确认产生一次从 B0 到最终 post 的 canonical edit，提交前再检查 preimage。源文本同时有外部变更时不得覆盖，需显式结束并重新读取。这些是需要完成的设计约束，**未宣称当前代码支持或可直接实施**。独立服务/命名协议/全局事务重构若不可在原首包内完成，应由 P0 增量核定；不启动 probe、实现或新 agent 来越过本轮权限。

确定的场景骨架：S0 clean 文件与精确选区 → S1 请求候选（loading，可取消/被新请求替代）→ S2 选真实 Extract 候选 → S3 命名/配置（**A 无此步；B 为 inline，待 DEC-02 与事务设计**）→ S4 冻结整组预览 → S5 应用前检查 → S6 调用点及新方法同时生效 → S7 一次共享 undo/redo → S8 保存/重开恢复。这只是旧方案骨架：IDEA 实际没有 S4 独立 diff Preview，B 应为临时结果→确认。A/B 尚待决定，不把混合骨架交给 P2 猜。

确定的异常：unsupported/empty/disabled、timeout/failed、cancelled、stale、conflict、applied、failed+recoveryState 各自保留；编译失败不算 supported success；仅拒绝路径成功不能使 A1 通过。输入无效不得生成计划或写盘；取消返回原来源 view 和原 selection（IDEA dialog Esc 整体取消，inline 在 suggestions 打开时需先关闭 popup 再取消；目标采用哪条流程受 DEC-02 约束），已有 dirty 输入不得丢失。

<a id="ui-contract"></a>

## 4. UI 与输入合同：已定保护与待采目标

现有候选菜单由 `showCodeActionsMenu` 的 `code-candidates` appearance 承载；预览是 `RefactoringPreviewDialog`（80vh、max-w-3xl、文件/usage 树、filter、all/none、Cancel、Do Refactor），这里只描述基线，**不作为永久目标布局**。

已定：专用 Extract 不列 variable/constant；disabled 候选展示真实原因；loading/retry/empty/stale/conflict 区别呈现；名字错误保留用户输入；必需语义 edit 无法部分排除；长路径/代码可滚动、底部操作可达，focus-visible/aria 角色保留。颜色沿现有 `--taomni-code-*` 角色，error/selection/muted 不混用；不从其他机器字体或像素硬编码 IDEA 尺寸。

IDEA 已观察：第一次 inline 名称 `getTotal` 选中、建议 popup、新方法绿色高亮；第二次 Ctrl+Alt+M 打开 802×840 的更多选项 dialog，private/int/name、static 勾选且 disabled、int base 参数行、Signature Preview、Refactor/Cancel。`1bad` 禁止提交，`next` 出现冲突 dialog；inline Enter 返回调用行 caret 7:9；suggestions 打开时 Esc 先关 popup，再 Esc 还原原两行 selection；更多选项 Esc 直接整体取消；一次 Undo 恢复原文/selection，无确认框。没有独立文件 diff Preview。细节原件见[参照 R1–R7](references/ed-parity-007-reference.md#capture-steps)。

已交付[可编辑 drawio 图稿](java-extract-method-options.drawio)和[直接预览 PNG](java-extract-method-options.png)，v1、1400×850，用于 A/B 流程取舍，不是像素实现稿或真实截图。未启动 draw.io 桌面；为遵守已归还桌面边界，预览用本地 Pillow 从相同节点生成，未声称是 draw.io 导出。字体可读、无遮挡已静态查看；图中“必选”表达不可拆的两个 edits。最终布局、控件与尺寸还须随 DEC-02 定稿。R7 未采 Ctrl+Z 输入、Tab 环路、鼠标 Cancel/参数操作及窄窗；这些缺口按目标范围保留，不能用当前组件快照替代 IDEA。

受影响实际入口清单：

1. Search Everywhere / Actions 中 `workspace.extractMethod`（`code-workspace-search-everywhere` popup）；原 selection 必须跨弹层保留。
2. ControlBar → Code Workspace Actions → `context-menu-workspace-command-workspace.extractMethod`；通过 `useWorkspaceActionsController`/MainLayout registration 路由当前 workspace。
3. 编辑器 `Mod+Alt+M`；实际 keymap 由统一 host 解析，Windows/Linux Ctrl、macOS Meta；不得把 IDEA macOS 默认 binding 当已采。
4. `workspace.refactorThis`：Search Actions/ControlBar 与实际 `Mod+Alt+Shift+T`、现有 `Ctrl+T` 别名；只测试其 Extract 候选及受影响通用列表，不删除别名凑无冲突。
5. `workspace.codeActions`：Alt+Enter、editor context `editor-context-code-actions`、gutter bulb、Problems Quick Fix、Search Actions/ControlBar；同一候选若通过这些入口出现，必须同一提取策略；gutter/Problems 的零长 range 可以不给方法候选，不能合成方法请求。
6. shared undo/redo 的编辑器快捷键与显式 Workspace Undo/Redo Actions；命名/filter/Find/Search 输入框与 terminal 焦点保护。

产品没有单独的 Extract toolbar/button 或 editor context “Extract Method” 项；本卡不凭空新增入口来模仿 IDEA 菜单。若 R1 表明必须改入口结构且 P0 首包允许，P1 更新本列表和图稿后再 ready。

## 5. 文件职责、接口、共享消费者

以下是未来 **P2 责任范围**，非开发已领取。板内 `depends_on=[]`；REQ-05/REQ-11 的生产契约作为基础，当前本地已有实现，不制造对已完成旧板的开发依赖。007 不依赖 008/009，也不能顺手接续 005/006。

| 文件/符号 | 责任与边界 |
|---|---|
| [CodeWorkspaceTab.tsx](../../src/components/editor/CodeWorkspaceTab.tsx)：`workspace.extractMethod`、`openRefactorActions`、`showCodeActionsMenu`、`runCodeAction` | 收敛精确 kind；所有 Extract 候选入口共同调用策略；捕获来源 view/range，绑定生命周期，向现有 canonical plan 传 required operations；不再拆一个保存 owner |
| 拟新增 `src/components/editor/workspace/extractMethodPlan.ts` | 集中方法候选判定、immutable context 和 complete-edit 检查；纯函数返回 supported/unsupported/invalid-plan 的原因。不得用关键词造语义，不接管其他 refactor |
| [codeActionProviderAdapter.ts](../../src/components/editor/workspace/codeActionProviderAdapter.ts)、[intentionSession.ts](../../src/components/editor/workspace/intentionSession.ts) | 复用 request/resolve/apply；如需 Extract 特定 command adapter，先满足 DEC-02/04 并窄化 allowlist/协议；保留一般 quickfix、organize imports、其他 provider edit/command 行为 |
| [refactorPlan.ts](../../src/components/editor/workspace/refactorPlan.ts)、[RefactoringPreviewDialog.tsx](../../src/components/editor/workspace/RefactoringPreviewDialog.tsx) | 利用 `requiredOperationIndexes` 锁住完整提取；只为本卡模式添加必要控件/键盘/focus 行为；Rename、multi-file/resource preview 保留 |
| [workspaceActionHost.ts](../../src/components/editor/workspace/workspaceActionHost.ts)、[CodeMirrorHost.tsx](../../src/components/editor/workspace/CodeMirrorHost.tsx)、[useWorkspaceActionsController.ts](../../src/components/editor/workspace/useWorkspaceActionsController.ts) | 原统一入口与快捷键消费者；仅当本卡真实反例需修复才改，避免改 keymap 数据格式/全局绑定 |
| [src/lib/editor/lsp.ts](../../src/lib/editor/lsp.ts)、[src-tauri/src/lsp.rs](../../src-tauri/src/lsp.rs) | 现有 codeAction/resolve IPC；若 R2 证实错误被吞且阻断准确边界，维护结果错误信息和原 caller 兼容。未决定新增命名协议前不新增 IPC |
| [workspaceEditApply.ts](../../src/components/editor/workspace/workspaceEditApply.ts)、[workspaceEditHistory.ts](../../src/components/editor/workspace/workspaceEditHistory.ts)、[refactorRecoveryController.ts](../../src/components/editor/workspace/refactorRecoveryController.ts) | 保存、preimage、单次 undo/redo/recovery 的保留依赖；不改变 journal v1/v2 或重写 shared ledger；受本卡引入的回归由 P2 修复 |
| [workspaceSemanticEditing.ts](../../src/components/editor/workspace/workspaceSemanticEditing.ts)、[saveOrganizeImportsAdapter.ts](../../src/components/editor/workspace/saveOrganizeImportsAdapter.ts) | Generate/Surround、保存 organize imports 也消费 code actions；不得用全局 kind filter/command 拒绝策略误伤它们 |
| [ControlBar.tsx](../../src/components/tabbar/ControlBar.tsx)、[MainLayout.tsx](../../src/layouts/MainLayout.tsx)、[SearchEverywhere.tsx](../../src/components/editor/workspace/SearchEverywhere.tsx)、[editorContextMenu.ts](../../src/components/editor/workspace/editorContextMenu.ts) | 核对注册/禁用/入口与选区上下文；无证据不改 shell 布局，仅必要路由修正及入口回归 |
| 下节列出的单测、YAML/fixture/controls | P2 落盘、执行、回填；P1 本轮不修改任何可执行测试/目录 |

拟新增的内部策略接口（名称可按仓库风格实现，语义不可变）：`classifyExtractMethodCandidate(action, frozenContext)` → `{state:"supported", action}` 或 `{state:"unsupported", reason}`；`prepareExtractMethodPlan(resolvedEdit, frozenContext)` → `{state:"ready", plan, requiredOperationIndexes}` 或 `{state:"invalid-plan", reason}`。方法 kind 和非空 edit 缺一不可；只信任 provider 结构化 range/edit，预期影响限定同一 fixture 文件；意外资源操作/外部 URI 明示拒绝，不静默裁掉。命名字段/协议受 DEC-02 约束，不提供假的 signature；advanced 额外 rename 位置不等于已有完整命名事务。

owner 生命周期：同一 workspace instance 下只有当前 Extract 请求能更新 UI；请求 id 不等于文件身份。打开/取消弹层释放本轮 listeners/abort controller；resolve 返回后、preview 打开前、preview确认后、第一次 writer 前都复查。AbortSignal 可以阻止本地接收，是否发送 LSP `$/cancelRequest` 须由 P2 按实际传输证明，不能写成既成事实。写后失败不能靠丢弃迟到响应掩盖磁盘效果，保留 recoveryId、结果和不可盲目重试提示。

保存语义依据：现 `workspaceEditApply` 为 open clean → 应用并自动保存；open dirty → 保留 dirty；closed → 写盘。单次共享 undo 以捕获的 metadata 恢复。当前 refactor guard 对 dirty/read-only 的真实入口断言须建立改前基线；不在本卡偷偷变更统一策略以适应 IDEA。与 IDEA 的即时 dirty/落盘时间不同须显式比较、必要时用户决定；未接受不写 matched。

<a id="acceptance"></a>

## 6. 本卡 AC 与保留断言

| ID | 本卡验收目标 | V / required evidence |
|---|---|---|
| ED-PARITY-007-A1 | F2 明确选区、真实 Java provider、准确方法类别；目标输入与预览按最终 DEC-02（当前待决）；确认后声明与调用点同时正确、返回值/副作用不变，程序 `13:1`。无 provider/disabled/非法选区/command-only 无伪成功，失败原因准确并能重新请求 | V1/V2/V3/V7；code-audit、unit、typecheck、browser、native、provider |
| ED-PARITY-007-A2 | 同 fixture、目标 build、平台/profile 下 R0–R7 对照 S0–S8，功能/视觉/交互分别判断，记录布局、启禁/选中/失焦、焦点和键盘结果；有差异明示，未采不 matched | V6/V1/V2/V7；browser、idea-comparison；目前目标取舍阻塞 P1 |
| ED-PARITY-007-A3 | Cancel/Esc/关闭在未提交时文本/磁盘/history 零变化并恢复来源上下文；stale 不写，preimage conflict 不覆盖外部改动；真实失败恢复有结果；一次 undo/redo 包含所有 edits 与原 encoding/EOL。保留 Rename 的 dirty/library/external 阻断、资源移动、一次 undo、recovery；保留 quickfix/generate/organize imports 的正常消费者，以及输入框/terminal 快捷键保护 | V2/V3/V4/V5/V7/V8；code-audit、unit、browser、native、provider |

本卡 required_evidence 目标为 `code-audit, unit, typecheck, browser, native, provider, idea-comparison`。在原六项上增加 browser，不删旧 native/provider/comparison 要求。P1 文档校验不占任何产品证据位置，无全仓 build gate 继承。

保留清单 K1：Rename 完整事务与资源路径恢复；K2：普通 quickfix/Generate/保存 organize imports；K3：shared document/split view 单次历史，未选 view 的 selection 不跳；K4：dirty、BOM/EOL、disk hash、save recovery；K5：Action disabled/keymap 冲突/输入框保护；K6：journal 旧数据可读、v1 不自动 replay、v2 Review/Keep/Restore/Dismiss 语义。对应 V5/V8；缺本轮改前结果记待执行，不声称已证明无回归。

<a id="test-cases"></a>

## 7. 完整用例设计、覆盖维度与 P2 落盘责任

**本节为设计，不是可执行测试。全部 unrun。** 下述新 ID/路径已在当前 case/test 目录查重（未发现同名），标为 P2 待实现。V1/V2/V6 的 DEC-02 依赖明确保留为 P1 待补，不把未知预期转交 P2。其他用例可在不依赖 UI 命名决定的部分完成设计，但卡整体不可领取。

### 7.1 共用准备、设施和证据

- 主 fixture 是[精确 F2 字节/range](references/ed-parity-007-reference.md#fixture)。每例新隔离 root/app-data；browser 使用同字节 VFS 与可控 provider，只替代 IPC/provider 边界，不 mock Action/菜单/session/preview/apply；native 用真实 JDK/JDT LS、磁盘路径、实际应用入口。
- 拟新增 QA fixture `extract_method`：由 P2 实现 `.agents/skills/qa-ui-auto/scripts/qa_ui_auto/fixtures/extract_method.py`，维护 `fixtures/__init__.py` 的 `REGISTRY` 与 `schema/testcase.schema.json` 枚举。支持确定的 ready、disabled、mixed-kinds、null、error、timeout、late、command-only、conflict 响应；计划控制到精确请求/range，不延长固定等待冒充稳定。
- 支持 verbs 已核 `verb-catalog.md`：`click`、`dblclick`、`right_click`、`click_menu`、`hover`、`fill`、`press`、`set_check`、`set_viewport`、`wait_for`、`assert_visible`、`assert_not_visible`、`assert_items`、`assert_text_equals`、`assert_attribute`、`assert_disabled`、`assert_enabled`、`assert_count`、`screenshot`、`eval_readonly`；readonly eval 仅观测 focus/selection，不注入 store/调用 handler。
- 选择两条语句用真实键盘移动+Shift 扩选或真实 pointer；P2 补精确 selection 的 readonly 断言设施。现有 `native_pointer_drag` 为 Linux/X11，不直接搬到 Windows；Windows 可用 DOM/WebDriver 按键和 host 独立 hash。没有方便 browser verb 不是 native 理由。
- 若需要控制迟到/失败，用 fixture/provider 响应控制或 QA 专用边界设施；新增 verb 时同步 schema、步骤实现、catalog，明确 browser/native 支持并执行代表例。禁止 production polling/假造执行计数当语义结果。
- 新 cases `covers: [F25.5]`；涉及真正不同已有 feature 时按当前 catalog 精确增补。P2 更新 `qa-ui-auto-tests/feature-list.md` 的 files/components/controls 和 YAML covers；只有 controls 变动才重生成 testid catalog，一批结束做一次 `audit --gate`。
- 每例清理：取消本轮未提交会话、关闭本轮 workspaces，保留失败原件；恢复 fixture 的 B0 或保留冲突/恢复状态后另建 root；只删除本轮报告目录内临时数据，不能清空用户配置。无提交/push。
- 每例证据：`qa-ui-auto-report/ed-parity-007/<run>/<case-id>/` 下 summary/receipt、逐步截图、pre/post/undo 全文/hash、可取得的 provider 请求/回复与失败日志；记录 source（含 diff）/case/runner/config/build/OS/WebView/provider 身份。未创建报告不得填 passing。

### 7.2 控件、入口、绑定、状态覆盖映射

表中 V1…V8 都是 `ED-PARITY-007-Vn`；A1…A3 是上节完整 ID。每行结果均 **unrun**；带 BL-02 的行尚待 P1 定稿预期。

| AC/V | 维度 / 控件、Action 或绑定 | 实际操作与必须断言 | case / 模式与边界 |
|---|---|---|---|
| A1/A2 V1 | Search Actions `workspace.extractMethod`；ControlBar 对应项 | 各打开/点击一次，range/context 同源，disabled 时不能 dispatch；结果仅 method，取消后重新打开仍正确 | 007-01 browser |
| A1/A3 V1 | `Mod+Alt+M` editor，重复触发；Ctrl/Meta/Alt/Shift 组合 | 实际按键；正确 modifier 执行一次，额外 Shift/缺 Alt 不错误触发；repeat 新旧请求不重复提交；输入框/terminal/tree/read-only 不抢键 | 007-01 browser；OS 拦截若发生单列 native 缺口，不把入口验证迁去 native |
| A1/A3 V1/V5 | Refactor This、Alt+Enter/context/gutter/Problems、Search/ControlBar codeActions | 每条实际可达入口都操作；含 Extract 的结果走同策略；零长 range 不虚构支持；普通 quickfix 留在通用列表 | 007-01/05 browser |
| A1/A2 V2 | 命名、参数、Preview、Refactor、Cancel；Tab/Shift+Tab/Enter/Esc | 输入合法/非法/重名；启禁、错误保留输入、Esc 返回层级/焦点；IDEA 实采结果已知；采用 A/B 的目标和 selector **BL-02/03 待决** | 007-02 browser；未定目标与未采状态不写通过 |
| A1/A3 V2 | `refactoring-preview-filter`、file/usage、select-all/select-none、collapse | 实际输入有/无结果并清空，折叠/展开；尝试取消 required，声明+调用点仍同时保留；filter 不改提交集合 | 007-02 browser |
| A2/A3 V2/V6 | dialog Close/Cancel/Do Refactor、宽/窄窗、长路径 | 三条关闭路径分别操作，零效果并回焦；窄窗滚动后按钮可达、长路径不盖控件；disabled/error/loading 明示；已知 client 1384×984；产品目标结构 **BL-02**，精细 zoom/行高未测 | 007-02 + V6 browser/IDEA 对照 |
| A1/A3 V3 | empty/no provider/disabled/malformed/command-only/timeout/error/retry | 每个响应路径准确原因；disabled click/Enter 不提交；失败重试产生新请求并能成功；无支持不标 applied | 007-03 browser + unit |
| A3 V4 | A→B workspace/file、close/reopen、edit during await、外部改动 | 旧候选不污染 B；无旧 modal 重开/无 focus steal；preview后冲突零覆盖，重新请求基于新内容 | 007-04 browser；实际磁盘冲突 V7 |
| A3 V2/V5 | editor shared Undo/Redo / Workspace Undo/Redo Actions；input undo | 每个入口实际操作；单次恢复整组、redo一次；filter/命名/Search/Find/terminal 内 Ctrl/Meta+Z 不撤销 Extract；K1–K5 | 007-02/05 browser；真实 bytes V7/V8 |
| A1/A3 V7 | native Java provider、文件 writer、保存重开 | 真实 UI 触发、程序 `13:1`、pre/post/hash、单次 undo、readonly/external conflict；真实失败不算取消 | 007-07 native；browser 无法证明 JDT LS 和磁盘效果 |
| A3 V5/V8 | Rename、Generate、organize imports、recovery review/keep/restore/dismiss | 正常完成保留结果，dirty/library拒绝、资源移动undo、恢复冲突不覆盖；各实际按钮不是仅存在 | 007-05 browser；既有 native cases 或 V8 手工 |

范围说明：跨方法/类抽取、远端文件/SSH、Java 编译器替代实现不在原首包；参数重排与 inline 输入的 IME 影响须随 DEC-02 核定，未定前不冒充 N/A；矩阵原能力不因此移除。Generate 的其他种类只做受共同过滤/执行改动影响的保留断言，不拓展新 Generate 能力。IDEA 未观察的状态是缺口，非 N/A。

### ED-PARITY-007-V1：真实入口、选择与键盘上下文（A1/A2/A3）

**拟新增** `qa-ui-auto-tests/cases/TC-IDE-PARITY-007-01-entry-context.testcase.yaml`，ID `TC-IDE-PARITY-007-01`，`modes: [browser]`。辅助拟新增 `src/components/editor/CodeWorkspaceTab.parity007.test.tsx` 中 `ED-PARITY-007 routes every extract entry with the captured selection`；不能以该挂载测试替代 browser 入口。

1. F2 clean，真实打开源文件、选 range，mixed-kinds provider 给 method、variable、constant 和 disabled method；记 source selection/hash。依次从 Actions、ControlBar、键盘进入，逐次 Cancel/reset。每次断言原范围请求、只显示方法候选，variable/constant 不在专用列表；禁用原因可见且 click/Enter 无效果。
2. 选中可用 method，产生同一冻结计划（IDEA inline 序列见 R2；目标是否采用由 DEC-02 决定）。从 Refactor This/Alt+Enter/context 再选择 method，结果一致；同样 fixture 的通用菜单仍可看见 variable/constant，不误过滤其他动作。
3. gutter/Problems 用各自真实范围进入；若只有 quickfix 合法则验证没有伪方法且 quickfix 仍能预览/应用/undo。Search/ControlBar 调 `codeActions`/`refactorThis` 也各操作一次，不将显示 title 当完成。
4. Windows/Linux 按 Ctrl+Alt+M，macOS browser 平台分支按 Meta+Alt+M；分别缺 Alt、额外 Shift、错误 Mod，断言不执行 Extract。连续双次正确按键，后发胜出、一次计划/提交，无重复写或 history。
5. 使 tree、Find query、Search Actions input、命名输入、preview filter、terminal 分别获得焦点，实际按 chord；输入框和 terminal 的文字/selection 不被 Extract 改变；无 file/loading/library/provider absent 时入口 disabled 或准确不可用，无请求写盘。冲突 keymap 通过真实设置复用隔离 profile，不改全局设置；冲突有现有提示、不重复派发。
最终关闭弹层再打开，原 view/caret/selection 保留、原文相等。清理按 7.1。证据为各入口/绑定断言+截图；缺 keymap 设施由 P2 按现有 004 用例复用，不能写“菜单已测所以快捷键通过”。

### ED-PARITY-007-V2：预览、整体提交、取消与单次撤销（A1/A2/A3）

**拟新增** `qa-ui-auto-tests/cases/TC-IDE-PARITY-007-02-preview-undo.testcase.yaml`，ID `TC-IDE-PARITY-007-02`，`modes: [browser]`。拟新增上述 mounted 文件测试 `ED-PARITY-007 never applies half an extraction`；补 [RefactoringPreviewDialog.test.tsx](../../src/components/editor/workspace/RefactoringPreviewDialog.test.tsx) 中同名 required 行为回归。

准备独立 B0，provider edit 严格替换原两条语句并插入方法；模拟 method name `calculateTotal` 仅为协议 fixture 的固定测试数据，**不是已确定 IDEA 的默认名**。IDEA 原始全文现已在[post-image](references/ed-parity-007-reference.md#post-image)固定；它不等于 JDT LS 默认输出。browser 固定 edit 可按该字节构造，产品命名 UI 随 DEC-02 定稿后才允许本例完成。

1. 从 V1 的真实入口发起，执行 DEC-02 的合法名、空/非法名、既有签名冲突输入；错误不写、不丢输入，修正后可继续。Preview 只读阶段原文/B0/history 不变，method 调用与声明都可检查，completeness/conflict 信息不假冒 complete。
2. 逐个操作 filter（命中/无结果/清空）、collapse/expand、file checkbox、usage checkbox、Select All/Deselect All；每次断言两处必要修改保持整体，过滤不改变提交集合；禁用 checkbox 用实际点击/键盘尝试并断言未改变。
3. 从预览分别 Cancel、Close、Esc；每条从 fresh setup 执行，原文/磁盘 stub/history 不变，恢复来源 selection/focus；IDEA 返回层级已在 R3/R4 记录；A 为从文件预览回原 editor，B 需明确 popup→inline→取消的临时事务。命名阶段 Cancel/Esc 另覆盖，不用 preview cancel 代替。
4. 再进入确认（鼠标一次、另一 fresh setup 以键盘 Enter/Tab 到明确按钮），断言全文精确等于 post-image，只有一个共享历史；预览 Apply 被禁用时 click/Enter 无提交。随后 editor Undo、显式 Undo Action 各在独立 setup 恢复完整 B0；redo 还原全部 post-image。
5. 在 sibling split 打开同文件，确认两 view 同一文档、另一 view selection 不跳、一次 undo 无双写；切另一文件再返回文本/dirty/history 正确。保存/重开以 renderer VFS 结果断言，真实 disk 在 V7。
6. 比较默认与窄窗口/长路径，操作滚动到按钮、键盘 Tab/Shift+Tab 不逃离 modal、Esc 回焦；测实际区域无裁切/重叠。已采 client 1384×984，产品目标布局 **BL-02**；窄窗暂拟 1024×768 作可达性断言，不宣称其与 IDEA 窄窗 matched，不以当前组件快照代替 IDEA。
清理及证据按 7.1，另保存 pre/preview/post/undo/redo 文本、截图与 selection/focus 观察。

### ED-PARITY-007-V3：支持边界、失败与重试（A1/A3）

**拟新增** `qa-ui-auto-tests/cases/TC-IDE-PARITY-007-03-provider-boundaries.testcase.yaml`，ID `TC-IDE-PARITY-007-03`，`modes: [browser]`；拟新增 `src/components/editor/workspace/extractMethodPlan.test.ts`：`rejects non-method kinds without relabeling them`、`requires a complete edit before extract preview`。复用 adapter tests 的 `keeps timeout, throw, null, malformed, and cancellation outcomes distinct`（此轮未运行）。

独立 B0 实际选区/入口，依次提供：无 capability、合法空结果、disabledReason、malformed、null、request exception、timeout、resolve exception/null、command-only、不受支持资源/edit。每变体断言准确不可用/失败/timeout（错误不得等价 empty），原文/B0/history 不变，命令未被盲执行；disabled 候选可见但 click/Enter 无副作用。空/破碎选区再实际按键，不能合成成功语义。

失败后通过真实 Retry 候选或重新 Action（按 UI 是否提供）重新请求，切为成功 edit；必须能进入可审阅预览，再 Cancel 回 B0。失败后原 input/selection 保留。只使用受控 fixture 故障，runtime provider 能力仍由 V7 证明。检查 request/resolve counters 仅辅助，最终文本/历史/错误状态是必需断言。清理同 7.1。

### ED-PARITY-007-V4：迟到、关闭、并发与冲突（A1/A3）

**拟新增** `qa-ui-auto-tests/cases/TC-IDE-PARITY-007-04-stale-conflict.testcase.yaml`，ID `TC-IDE-PARITY-007-04`，`modes: [browser]`；拟新增 mounted 测试 `ED-PARITY-007 drops late extract results after owner invalidation`。复用 [CodeWorkspaceTab.test.tsx](../../src/components/editor/CodeWorkspaceTab.test.tsx) 的 `rejects a provider refactor when the editor changes during preview confirmation` 作为原保护基线。

准备 A/B 两个隔离文件/两个 workspace 同名文件。让 A request、resolve、preview 的异步返回分别暂停；通过真实 UI 在每个暂停点执行一次 edit、切 B、关闭 A 再重开、切 workspace、provider generation 变化。释放旧响应后断言：B/新 A 文本与 selection 未受污染、旧 modal 不重新打开/不抢焦点、原错误不覆写新状态、无写盘/历史。重复调用时新结果仍可使用。

再开预览，外部 fixture 改磁盘 preimage（browser VFS 仿真，native V7 真实 host），确认时报 conflict 并保留外部内容；用户关闭、重读最新文件后重新请求可成功。取消等待与超时分开，timeout 不能回填 cancelled；writer 后失败不可断言“取消零效果”，进入 V7 恢复。每变体 reset B0，不让上例残留 owner 造成假失败。证据包含暂停点、owner 身份、释放顺序及精确文本结果，清理同 7.1。

### ED-PARITY-007-V5：共享消费者正常路径和入口保护（A3）

**拟新增** `qa-ui-auto-tests/cases/TC-IDE-PARITY-007-05-retained-consumers.testcase.yaml`，ID `TC-IDE-PARITY-007-05`，`modes: [browser]`。已有单测：[codeActionProviderAdapter.test.ts](../../src/components/editor/workspace/codeActionProviderAdapter.test.ts)、[refactorPlan.test.ts](../../src/components/editor/workspace/refactorPlan.test.ts)、[workspaceEditApply.test.ts](../../src/components/editor/workspace/workspaceEditApply.test.ts)、[workspaceEditHistory.test.ts](../../src/components/editor/workspace/workspaceEditHistory.test.ts)、[workspaceSemanticEditing.test.ts](../../src/components/editor/workspace/workspaceSemanticEditing.test.ts)、[saveOrganizeImportsAdapter.test.ts](../../src/components/editor/workspace/saveOrganizeImportsAdapter.test.ts)。

P2 改前先执行这些文件中被本卡触及的行为测试并保留结果；当前没有本轮基线。断言：

1. 双文件 Rename 从 Shift+F6 和真实 Action 入口分别触发：clean preview→可排除非必要项→Cancel 零效果→重新提交→文件 move+引用同时生效→一次 undo 全部还原；dirty/library/external conflict 不写。禁止为 G3 全局锁死 Rename 原有可选项。
2. quickfix 从 Alt+Enter/context/gutter/Problems/Search/ControlBar 各自实际范围发起，成功编辑/undo，失败重试仍可用；Generate 通用类别与保存 organize imports 返回 edit 的原流程不被 Extract filter 拦截，最终代码/dirty/保存结果正确。
3. 输入框 Ctrl/Meta+Z 改输入、editor Ctrl/Meta+Z 改文档、Workspace Undo/Redo Action 改整组历史；关键 modifier/conflict/repeat/input protection 由 V1 合并，不重复准备但保留不同断言。
4. recovery review/keep/restore/dismiss 复用 V8 真边界与对应 renderer fixture：实际打开列表→Review→Cancel/Keep 不修改文件→再次 Review/Restore 校验结果；Dismiss 的 Cancel 保留记录，确认只处理目标记录。版本兼容与真实 restart 不由本 browser pass 证明。

browser fixture 需要独立 Rename/quickfix/organize edits，由 P2复用现有 tests/fixtures；不调用私有 handler 生成成功。保留消费者控制与覆盖由 P2按实际修改集合核对，多余无影响平台组合无需穷举。清理同 7.1。

### ED-PARITY-007-V6：IDEA 三维对照（A2；关联 A1/A3）

精确步骤就是[参考 R0–R8](references/ed-parity-007-reference.md#capture-steps)。**P1 已完成主链采样，R7/G1 部分未观察；Taomni 侧全部未执行，不可作“matched”判断。** 对照关联 `TC-IDE-PARITY-007-01/02` browser 截图与 V7 native 文本/效果；IDEA 只由真实桌面操作观测。

P1 已保存原图、生成后全文/退出状态及方案图，DEC-02 待用户选择；P2 对相同客户区/profile/fixture 的 entry、input、invalid、preview、cancel、apply、undo 状态逐一测可观察布局、启禁/焦点/选区与语义。功能/视觉/交互分别给通过/差异/未验证，尺寸建议不能冒充测量值。源码与安装信息不能替代 R2/R4。

比较记录计划放 `qa-ui-auto-report/ed-parity-007/<run>/comparison/record.json`，使用现有 comparison schema/validator；先核版本支持。有效文件/validator exit 0 不自动 matched，所需 artifact 必须存在且状态对应；保留本机缺失的历史原件缺口。清理只关闭本轮 IDEA 窗口并归还桌面。

### ED-PARITY-007-V7：真实 provider、磁盘与恢复（A1/A3，A2 的功能侧）

**拟新增** `qa-ui-auto-tests/cases/TC-IDE-PARITY-007-07-extract-native.testcase.yaml`，ID `TC-IDE-PARITY-007-07`，`modes: [native]`，初次 `native_platforms: [Windows]`；Linux/macOS 独立扩展/手工回填，非当前通过。不是把 V1–V5 全套再 native 跑一遍。

原生理由：browser 不证明生产 Tauri→Rust→JDT LS 返回实际 edit、真实文件哈希/metadata、编译执行语义和 journal/restart。当前可用 JDK21、安装 jar 的存在不是 ready 结果；P2 确认 QA source/build/config/隔离 app-data，工程 facts/index/LSP synced 后记录实际 provider binary/version/generation/fingerprint。

1. 新 F2 副本与 B0 host hash，实际 UI 打开、选区、Action→Extract，保存原始 request/resolve reply（含 method kind、edit/command）。若默认路径 unsupported/hang，准确记录环境/协议原因，不能以拒绝通过 A1；若需新语义引擎/命名协议超出 DEC，返回 P1/P0，不自行扩卡。
2. 预览→Cancel，独立 host hash、目录文件集合和 history 不变；重新请求→确认应用，host 读取全文与 frozen post-image 一致（含 BOM/EOL policy），应用确认一个历史。关闭重开后文本正确。
3. 在该临时工程使用配置好的 JDK21 编译/运行 `parity007.ExtractSample`，单独输出目录；预期新进程标准输出 `13:1`（换行按平台）。此为未来 P2 的 fixture 验证，不构建 Taomni 全仓。保存 stdout/stderr/exit；原程序结果也由 P2执行并记录。
4. 一次 shared Undo 通过真实 UI 恢复全部 B0 hash，Redo 恢复 post，再 Undo+Save 回 B0；save 不能掩盖 undo 错误，分别记录按键前后 hash/dirty。
5. 预览后 host 追加 `// external\n` 再 Apply，零覆盖外部内容、无成功历史；重新读取、再请求验证恢复。另在复制的只读文件/明确可重现拒写条件下提交，保留真实失败；复原权限后 Retry 不重复部分写入。
6. 写后读取/确认失败的分支若需要故障设施，由 P2在真实 writer 返回/回读边界注入一次故障，保留实际写入结果及 recoveryId；自动恢复成功显示 failed+performed、失败则 Review 可接续，不标 cancelled/success。host hash 验证最终状态，不能用 mock 文件内容代替。共享 restart 恢复在 V8复用。

Windows 不使用 Linux-only `native_set_writable/native_pointer_drag`；自动化支持不足时按上述 UI+host步骤手工记录，P2再决定最小支持设施。native 配置在报告目录，非用户 profile；代码稳定后按 native-testing 复用或集中构建一次必要 QA。清理：结束本轮 JVM/app、恢复本轮权限、保留原件，不碰开发者 IDEA/JDT LS 进程。

### ED-PARITY-007-V8：已有 Rename / 原生恢复保留（A3）

复用而非重造：[TC-IDE-C6-04-rename-preview-conflict-apply-undo.testcase.yaml](../../qa-ui-auto-tests/cases/TC-IDE-C6-04-rename-preview-conflict-apply-undo.testcase.yaml)，实际 ID `TC-IDE-C6-04`；[TC-IDE-AUDIT-014-rename-recovery-native.testcase.yaml](../../qa-ui-auto-tests/cases/TC-IDE-AUDIT-014-rename-recovery-native.testcase.yaml)，实际 ID `TC-IDE-AUDIT-014-rename-recovery-native`。既有 Linux-only 选择/权限步骤不得直接宣称 Windows 支持。

沿它们现有隔离 maven-single/QuickFixTarget fixture：dirty 输入→Shift+F6→明确阻断、零磁盘变化；clean→类 Rename→包含真实资源 move 的 preview→Apply→一次 shared Undo 恢复路径与全文；v2恢复记录→关闭/重开 workspace→Review→Restore，验证 preimage/postimage/当前磁盘一致才回滚，foreign content 冲突不覆盖。Review 的 Cancel/Keep、Dismiss 的 Cancel/确认各操作，目标记录生命周期与文件 hash分开断言；v1 legacy 不执行自动 replay。

P2在 Windows 按这些相同动作使用 WebDriver key selection 或手工 UI，并独立 host hash；可在原 YAML 增加经验证的平台支持，不改原 expected、不复制历史 PASS；必要手工结果放本卡 V8，不伪装 runner pass。native 原因是资源路径、磁盘和应用恢复；browser 只覆盖控件和状态。现有覆盖不足时在相邻 tests增加实际缺口，不新开旧卡。清理同 V7。

### 7.3 未来执行与实施完成条件

P2 first：当前卡 ready 且前置齐全后才正式 claim；核对 source/diff，运行受影响保留测试改前基线；设计未知项必须由本次 P1补齐。快速迭代按具体 Vitest 文件/测试名，browser IDs 007-01..05；相关源码和测试稳定后合并一次 scoped typecheck；最后 V7+必要 V8用同配置集中 native，另做 V6 比较，不运行全套历史队列。

以下是**文件实现后**的执行形态，P1 未运行、当前新 ID 未登记：

```powershell
$env:PYTHONPATH = ".agents/skills/qa-ui-auto/scripts"
python -m qa_ui_auto run --mode browser --filter TC-IDE-PARITY-007-01,TC-IDE-PARITY-007-02,TC-IDE-PARITY-007-03,TC-IDE-PARITY-007-04,TC-IDE-PARITY-007-05 --config .agents/skills/qa-ui-auto/assets/qa-ui-auto.config.browser.yaml --require-pass
pnpm exec vitest run src/components/editor/workspace/extractMethodPlan.test.ts src/components/editor/CodeWorkspaceTab.parity007.test.tsx
```

该命令需要 P2先按 QA skill 启动/核实当前 checkout 的 browser server；P1不启动。native 命令由 V7 实际配置和支持的步骤确定后写入报告；无配置时不印一个假现成命令。typecheck 一次覆盖所有 owned touched paths；仅当改 Rust 时 focused Rust tests，格式化仅改动文件。macOS direct cargo 前执行仓库要求的 krb5 staging。

P2负责 YAML `verification` 的真实步骤映射和语义审查、`covers/fixtures/modes/controls`、fixture/verb/schema 对齐、catalog 与一次静态 audit，执行后回填每 AC→V→test/case→报告及 pass/fail/skip/unrun；保留失败顺序与选中数/skip原因。规划文字不能替代可执行 case，当前规划缺口不能用“P2 待实现测试”掩盖。

<a id="readiness"></a>

## 8. Ready 条件与本轮接续

| 项目 | 当前情况 / 必要下一步 | 阻塞 |
|---|---|---|
| 源码/首包/文件责任/保留契约 | 当前链、共享 owner 与语义命名缺口已定位；运行基线仍由 P2 在授权开发时取得 | 不因未来测试尚未编写而单独阻塞 |
| IDEA 版本与本轮时段 | 最新目标为 2026 系列任一适用版本；2026.2.2 实采 11:33:41–11:42:16 已归还桌面，不重标历史 build | BL-01 **已解除**，旧“无授权/未实采”仅为先前历史 |
| 命名/预览主链 | 已观察 inline、More options、非法/冲突名、取消/应用、13:1、一次 undo/redo。图稿 A/B 已展示并询问 | BL-02 **待用户选择 DEC-02 的目标取舍**；并非再询问是否允许 UI 重构 |
| provider/事务适配 | 默认 edit 无 methodName 输入；advanced 有后续 rename position；生产尚无临时 Extract owner。B 必须补命名、保存隔离、取消补偿、一笔历史的完整设计，必要时交 P0 增量 | BL-03：A1/A3、V1/V2/V4/V7；不伪造 JDT 运行支持 |
| 完整用例 | 已有确定部分与精确测试路径、browser/native 边界；A/B 影响 V1/V2/V6 的操作/预期及设施责任 | 待决定后在本文定稿；不是仅因 P2 未写 YAML 而不 ready |
| 剩余参考 | R7/G1 的输入 undo/Tab/鼠标 Cancel、参数操作/异常选区和窄窗未采；细粒度 profile 未测 | 采用 inline 目标时须按 G1 补必要状态；未取得新时段，不输入 |
| P2 交接 | 按用户后续要求已预先生成[完整条件式 P2 提示词](handoff-p2-ed-parity-007.md#p2-prompt)，写死本板/ID、用例路径与职责；目标/事务及全用例定稿后才能 ready/false 并开发领取 | 文件已交付；当前仍不可立即领取 |

收到目标答复后仍只继续本卡：保留 IDEA 真实观测和确定部分；A 若被明确接受，记录偏离项与比较结果上限；B 保持目标并完成上述设计，若确需扩范围则向 P0 增量提出具体范围。两者都不得删已知失败、删必要 AC 或把 future implementation 当已验证。

本轮产品测试、Taomni/browser/native runner、产品构建、JDT LS probe 均为零；IDEA GUI采样已于本轮 10 分钟授权内完成并结束。Windows native/provider 与 Linux/macOS 产品行为均未验证。文件与链接检查结果见[静态记录](evidence/ed-parity-007-p1-static.md)，不会被写成产品 evidence。
