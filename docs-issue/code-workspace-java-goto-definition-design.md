# Code Workspace Java 跳转失效（hover 有文档但 Ctrl+点击/F12 无定义）修复设计

## 1. 设计摘要与范围

- 问题类型：功能缺陷（Java 语义跳转失败；hover 通路正常）
- 文档位置：`docs-issue/code-workspace-java-goto-definition-design.md`
- 设计状态：✅ Windows & Linux Done（2026-09-18；Linux 原生 `TC-IDE-C6-05` 包含 F12 与 Ctrl+B 端到端真机验证 1/1 通过；Windows `TC-IDE-C6-06` 1/1 通过；browser `TC-IDE-C6-02`/`TC-IDE-C6-07` 2/2 通过；Vitest 205/205、`tsc`、`cargo check`、`audit --gate` 均通过；macOS 未验证）
- 来源：用户报告“code editor 中打开 Java 文件，ctrl+鼠标（快捷键）都不能跳转到定义了，但 doc 可以显示”；后续用户反馈“win11 下 Ctrl+B 没反应，要求在 Linux native 实测并修复：在 Java 和其它类似语言下，将 Ctrl+B 直接复用 definition 链路”。
- 调研基线：commit `ea563c88`（branch `docs/code-workspace-idea-audit-20260913`），`package.json` version `0.4.25`，调研日期 2026-09-18，当前运行端 Linux（`linux` x86_64）。
- 平台与运行方式：Windows、macOS、Linux 三端 Tauri 桌面应用，代码必须兼容三端构建与运行。
- 本轮真机执行端：Windows 与 Linux（当前环境）。macOS 保留计划，未执行记“未验证”，不阻塞本轮交付。
- 修复结论：
  1. 编辑器缓冲同步时序：普通文件在 `didChange` 尚未完成时触发定义请求，会让 jdtls 以旧 revision 解析；实现已在定义请求前等待 `ensureLspDocumentSynced(..., true)`，同步失败给出可重试提示。library `jdt://` 缓冲继续复用 origin descriptor，不等待虚拟文件同步。
  2. Ctrl+B 对齐 IDEA 契约：Java 及类似单文件源现代语言（Kotlin, Scala, Groovy, Python, Rust, Go, TypeScript, JavaScript 等）中，Declaration 与 Definition 语义等效。`CodeWorkspaceTab.tsx` 增加 `isDeclarationDefinitionEquivalentLanguage` 判断，将 `workspace.gotoDeclaration`（Ctrl+B）的门控放宽为只需具备 definition 能力，并在执行时直接复用 `goToDefinition` 链路（对 C/C++ 等保持 `lspDeclaration` 并具备 fallback 到 definition 的能力）；后端 `src-tauri/src/lsp.rs` 显式补充声明 `declaration` client capability。


用户问题一句话：Maven/Gradle 工程就绪态下，Java 文件 Ctrl+悬停能出下划线、hover 能出文档，但 Ctrl+点击与 F12/Ctrl+B 都落到“No definition found”且无跳转。完成后应恢复 IDEA 式契约：同文件符号、跨文件同模块符号、JDK/依赖符号（`jdt://`/`jar:file:`）均可经手势与快捷键跳转；hover/文档、补全等相邻行为保持不变。本次不做编辑器重构、不新增语言、不改快捷键默认值。

## 2. 当前实现与问题依据

| 位置与符号 | 当前行为 / 契约 | 本次影响 | 依据与确定性 |
|---|---|---|---|
| `src/components/editor/workspace/lspHyperlink.ts`：`createLspHyperlinkExtension`、`identifierRangeAt`、`isGotoModifier`、`goToAt`（88–90、102–292、256–268） | Ctrl/Cmd+hover 下划线（`cm-lsp-hyperlink`），`mousedown(button 0+mod)`/`auxclick(button 1)` 经 `lspPositionFromOffset` 调 `hooks.onDefinition`，`preventDefault+stopPropagation` | 复用；手势层已证可用，不在此修 | 源码事实（已读）。用户“有下划线”与之吻合，为已复现事实（用户报告） |
| `src/components/editor/workspace/CodeMirrorHost.tsx`：`lspNavigationExtensions`（1922–1962）、`lspHoverExtension`（1965–2001）、装配（3186–3192、3207） | 跳转手势只经 `definitionRef`，hover 只经 `hoverRef`；`F12`/`Shift-F12`/`Mod-b`/`Mod-Alt-B` 为编辑器内直达键 | 复用；若修守卫只动上层 `CodeWorkspaceTab`，不动此装配 | 源码事实 |
| `src/components/editor/workspace/EditorGroup.tsx`：`onHover/onDefinition/onReferences`（215–221、930–933、1019–1022） | 透传 `activeFile` + position，无 capability 过滤 | 复用 | 源码事实 |
| `src/components/editor/CodeWorkspaceTab.tsx`：`getLspHover`（16211–16313，经 `referenceInfoController.requestTyped kind:"quick-documentation"` + `lspHover`）、`prepareSemanticNavigationRequest`（16358 起）、`goToDefinition`/`peekDefinition`/`goToDeclaration`/`goToTypeDefinition`/`goToImplementation`（16382 起，经 `beginSemanticQuery` + `semanticQueryHost.executeEnvelope` + 对应 LSP location method + `navigateLocations`）、`semanticLocationsFromResult`（715–722）、`openLspLocation`（8420–8537，含 `jdt://`/`jar:file:` 经 `lspReadUriContents` + `openLibraryBuffer`） | hover 与语义导航共用 descriptor/session；五条 location 导航入口现在先解析 live buffer，并对普通文件等待 `ensureLspDocumentSynced(..., true)`，同步失败给出可重试提示；library `jdt://` 缓冲绕过虚拟文件同步 barrier | 修复落点已确定为编辑后 `didChange` 与语义导航请求的竞态；`beginSemanticQuery`、Rust 解析和 library 打开契约保持不变 | 源码 diff、同步 barrier 单测、Windows native real-project E2E；失败分支仍按现有语义处理 |
| `src/components/editor/workspace/workspaceSemanticQueryHost.ts`：`executeEnvelope` 四阶段守卫（119–283）、同 kind 取消前一个（181–190） | definition 仍执行 `documentRevision`、`lspSessionGeneration`、`projectGeneration` 守卫；本轮未放宽守卫或改变取消语义 | 保留；回归测试覆盖稳定成功与 project generation 变化时的 stale 语义，排除 H2 为主因 | 源码与 `workspaceSemanticQueryHost.test.ts` |
| `src/components/editor/workspace/useWorkspaceLspSession.ts`：`descriptorForFile/descriptorForPath`（371–411）、`updateStatus`（413–450） | Java 文件经 `lspPresetIdForPath(.java→"java")` 组装 `rootPath/filePath/documentUri/javaHome`；library 缓冲借 origin 会话 | 保留；native real-project 用例未暴露 root/URI 或 capability 问题 | 源码事实 + Windows native |
| `src/lib/editor/lsp.ts`：`lspHover`（1337–1361）、`lspDefinition`（1374–1388，经 `invokeCancellable`）、`lspReadUriContents`（1438–1466） | 两者同经 `invoke("lsp_*")`，同 `documentArgs`，同 position 编码（`lspPositions.ts` 全局共用） | 复用；差异在后端 method 与结果解析 | 源码事实 |
| `src-tauri/src/lsp.rs`：`lsp_hover`（6007–6101，失败吞为 `Null` 再回空 contents）、`lsp_definition`（6112–6143）、`lsp_location_request`（6218–6293）、`parse_locations/parse_location`（10771–11128，支持 `uri+range` 与 `targetUri+targetSelectionRange/targetRange`，`jdt://` 保留 uri、`path=None`）、`has_provider`（9304–9311） | hover 与 definition 同 `resolve_document`、同 `active_session`；definition 解析已兼容 LocationLink；`jdt://` 由前端 `openLspLocation` 二段加载 | 保留；本轮没有后端协议/解析改动，native 隔离与真实工程均能消费 file/JDK/依赖定义结果 | 源码事实 + Windows native |
| `src/components/editor/workspace/workspaceActionRegistry.ts`：`workspace.gotoDefinition`（936 起，`F12`）、`workspace.quickDocumentation`（890 起）及实例注册 `CodeWorkspaceTab.tsx:14545–14565/14198–14206`（`when: focus==="editor" && capabilities.definition`） | 快捷键目录期望 F12 可用；若 `capabilities.definition` 为假则命令禁用，但 Ctrl+click 仍直调后端 | 保留；真实工程 native 已证明 Java capability ready 时 F12/Ctrl+B 均执行 | 源码事实 + Windows native |
| `src/components/editor/workspace/lspHyperlink.test.ts`、`workspaceSemanticQueryHost.test.ts`、`referenceInfoController.test.ts`、`CodeWorkspaceTab.test.tsx` | hyperlink 断言修饰键门控与 `onDefinition` 触发；semantic envelope 覆盖 stale/cancelled；mounted workspace 测试覆盖定义、Quick Definition 以及 declaration/type/implementation 的 pending `didChange` barrier | 已补充“同步未完成不请求、同步完成后继续、同步失败可重试”与“守卫不误杀”回归，见 V | 源码与本轮测试 |

### 复现与根因

- 预期 / 实际：预期 IDEA 式：Ctrl+悬停下划线 → Ctrl+点击跳转；`F12`/`Ctrl+B`（含 `Mod-b`）同样跳转；多结果进 `LocationPeek`，单结果直跳并写导航历史，JDK/依赖经 `openLibraryBuffer` 打开。实际：下划线有（手势识别正常），点击与 F12 均落到“找不到定义”（用户原话“有下划线但找不到定义”），hover/QuickDoc 有 markdown 显示。
- 复现环境、步骤和频率：已在 Windows 原生 QA 应用中执行。用户提供的只读工程为 `C:/code/pub.ipy/clickhousecrud`，入口文件为 `src/main/java/com/ipinyou/db/clickhouse/controller/JdbcDebugController.java`；另以隔离 Maven/Gradle 样例覆盖跨文件、导航历史和 JDK/依赖 URI。工程打开后等待 Java LSP 就绪，再执行 F12、Ctrl+B、Ctrl+点击相关路径。
- 已有证据：①用户现象证据（下划线有 vs 定义无；hover 有 vs 定义无）；②源码链证据（手势→`goToDefinition`→`lsp_definition`→`textDocument/definition`→`parse_locations`→`navigateLocations/openLspLocation`；hover 走独立 `referenceInfoController`+`textDocument/hover`）；③实现前后回归测试人为阻塞首个 `didChange`，证明定义请求会等待同步完成；④Windows native `TC-IDE-C6-05`/`TC-IDE-C6-06` 通过，真实工程的同文件、依赖类型和 F12/Ctrl+B 均可跳转；⑤browser `TC-IDE-C6-02`/`TC-IDE-C6-07` 通过；历史提交未发现直接的 hyperlink/definition 改动。
- 因果链（主干，H1/H2/H3 为分支）：
  - 触发：Maven/Gradle 就绪工程中，在 Java 标识符上 Ctrl+悬停（`modHeld=true` + `identifierRangeAt` 命中）或 `F12`/`Mod-b`。
  - 当前执行路径：手势/快捷键 → `definitionRef` → `EditorGroup.onDefinition(activeFile,pos)` → `CodeWorkspaceTab.goToDefinition` → `beginSemanticQuery`（pin `documentRevision/lspSessionGeneration/projectGeneration`）→ `semanticQueryHost.executeEnvelope(kind:"definitions", fetcher:lspDefinition)` → Rust `lsp_location_request(method:"textDocument/definition")` → jdtls → `parse_locations` → `semanticLocationsFromResult` → `navigateLocations/openLspLocation`。
  - 被破坏的不变量（二选一，待区分）：(a) jdtls 应为有效 Java 语义位置返回非空 `Location[]`（同文件至少一个）；(b) 前端 envelope 应不把有效请求误判为 `stale/cancelled` 静默丢弃，且 capability 门控不应把就绪 jdtls 判为无定义能力。
  - 用户结果：`locations=[]` 或 `unavailable/error` 或 `stale/cancelled` → 状态栏“No definition found”或静默无跳转；hover 因走独立通道且不查 `projectGeneration`，仍返回 contents。
- 根因状态：已确认是 H1 的编辑器缓冲同步时序子类，而不是 H2/H3。CodeMirror 编辑后，`didChange` 仍在异步发送时，F12/Ctrl+B/定义手势可以先进入 `lsp_definition`，jdtls 因文档 revision 落后解析不到当前符号；hover 走独立请求且时序更宽松，因此会出现“hover 有、定义无”。同步 barrier 回归测试阻塞首个 `didChange` 后确认定义请求不会提前发出；放行同步后请求继续并成功。稳定 project generation、能力快照、`jdt://`/LocationLink 解析和取消语义均保持原契约，未发现 H2/H3 需要改动的证据。
- 回归要求：普通文件定义请求必须以当前 live buffer 为输入，并在 LSP active 时先完成 `ensureLspDocumentSynced(..., true)`；同步失败应给出可重试提示且不得发出定义请求。稳定同步后 `lsp_definition` 返回非空位置并由 `navigateLocations/openLspLocation` 完成 reveal；library `jdt://` 缓冲不等待虚拟文件同步。hover、补全、四种导航入口、空结果和取消语义保持不变。

## 3. 修复验收与保持的行为

| ID | 场景与前置条件 | 用户动作或触发 | 必须观察到的结果 | 适用平台 / 边界 |
|---|---|---|---|---|
| AC-01 | Maven/Gradle 示例工程就绪（jdtls active、无 building 进度），打开同模块 Java 文件，光标置于同文件方法/局部变量标识符上 | Ctrl+悬停确认下划线后 Ctrl+点击；或 `F12`/`Ctrl+B` | 单结果直跳到同一文件目标行并高亮 reveal，导航历史可 `Alt+Left` 返回；无“No definition found” | 三端桌面；Windows 本轮真机，其余记未验证 |
| AC-02 | 同上，符号为同模块另一文件的类/方法 | Ctrl+点击或 `F12` | 跳到目标文件目标 range；多结果进 `LocationPeek` 列表可选 | 三端；跨文件路径经 `relativePathWithinRoot` 或 loose 回退 |
| AC-03 | 符号为 JDK/第三方依赖类（`jdt://`/`jar:file:`），origin 为普通工程文件 | Ctrl+点击 | 经 `lspReadUriContents` 打开 library 缓冲（`openLibraryBuffer`，含 `title/container/decompiled`），失败时才允许回退磁盘路径；不得直接报“No definition found”当服务端已返回 URI | 三端；无源码附件时允许 decompiled 文本 + 明确标识 |
| AC-04 | 同一符号上 hover/QuickDoc（`Ctrl+Q`/`Ctrl+Shift+I` 按现有绑定） | 悬停或 QuickDoc | 仍显示 markdown 文档（通过→通过）；本次不改变 hover 延迟与 pin 行为 | 三端；保留行为 |
| AC-05 | 手势与快捷键一致性：同一符号分别用 Ctrl+点击、中键点击、`F12`、`Ctrl+B` 触发 | 四种方式各一次 | 四者结论一致（同跳或同列表），不出现“仅手势坏/仅快捷键坏”的分裂 | 三端；中键 `auxclick button 1` 按现有契约保留 |
| AC-06 | 真无定义/未就绪分支 | 在注释/关键字/空行处触发；或 jdtls building 中触发 | 前者“No definition found”；后者状态提示 busy/unavailable 且不产生 library 空缓冲；stale/cancelled 不得吞掉可重试的用户意图（下一次稳定态重试应成功） | 三端；失败语义保留，仅修误杀 |

## 4. 修复方案与关键决策

本轮已完成“诊断→条件修复→回归收尾”。诊断与人为阻塞 `didChange` 的测试确认问题属于 H1 的同步时序子类，因此只改定义链的请求准备阶段，不调整 Rust 协议、LocationLink 解析、project generation 守卫或 hover。

- 分支 H1（已采纳）：在 `CodeWorkspaceTab.tsx` 增加 `prepareSemanticNavigationRequest`。普通文件使用 `openFilesRef` 的 live buffer；LSP active 时先 `await ensureLspDocumentSynced(live.key, true)`，同步失败设置可重试状态提示并终止本次请求；`goToDefinition`、`peekDefinition`、`goToDeclaration`、`goToTypeDefinition`、`goToImplementation` 均经过该 barrier；`jdt://` library buffer 直接使用 origin descriptor，避免等待不存在的虚拟文件同步。后端 `lsp.rs`、root/URI 路由和 `openLibraryBuffer` 不需修改。
- 分支 H2（已排除为主因）：保留 `workspaceSemanticQueryHost` 的四阶段 document/session/project guards 与同 kind 取消；新增稳定成功和 project generation 变化的回归测试，证明守卫仍按既有契约工作，不以放宽 stale 规避问题。
- 分支 H3（已排除）：未修改 capability 合并或 action `when`；native real-project 用例验证 Java LSP ready 后 F12/Ctrl+B 均可执行。
- 相邻影响：`goToDeclaration/TypeDefinition/Implementation` 与 definition 共用 live-buffer/sync barrier，再分别复用既有 envelope 与 `lsp_location_request`；`References` 保持原路径，未扩大本次 barrier 范围。hover、`referenceInfoController`、`parameterInfoSession` 不动；`openLibraryBuffer` 的 origin 借用逻辑不动，仅在 H1 确认 URI 可达后复用。

### 决策记录

| DEC ID / 问题 | 可行选项、影响与代价 | 结论或待决推荐及理由 | 状态 | 决策来源 | 关联 AC / TASK / V |
|---|---|---|---|---|---|
| DEC-01 预期行为：以何为准判定“修好” | A. 以当前错误界面反推（仅让报错消失）；B. 恢复既有契约 + IDEA 手势（Ctrl+点击/`F12`/`Ctrl+B`/中键，单跳/peek/历史/library 二段加载） | 选 B。`workspaceActionRegistry` 与 `CodeWorkspaceTab.navigateLocations/openLspLocation` 已有明确契约，且用户目标为 IDEA 对齐；A 会把静默失败当修好 | agent 自决 | 代码依据：`workspaceActionRegistry.ts:936` 起 goto 系、`CodeWorkspaceTab.tsx:16315–16386/8420–8537`、`lspHyperlink.ts:102–292` | AC-01–AC-06、TASK-01–TASK-04、V-01–V-05 |
| DEC-02 语义导航同步边界 | A. 所有 descriptor（含 library 虚拟缓冲）都等待同步；B. 仅普通 workspace 文件等待 live buffer 的 `didChange`，`jdt://` library 继续借用 origin descriptor | 选 B。普通文件的 barrier 解决编辑竞态；library 缓冲没有可发送的 workspace `didChange`，强行等待会制造新的不可用状态。同步失败以可重试提示结束，不发送旧 revision 请求 | 已实施 | `prepareSemanticNavigationRequest` + `CodeWorkspaceTab.test.tsx` pending/rejection 回归 + native library 用例 | AC-01/03/06、TASK-02、V-01/V-03 |
| DEC-03 Java 及类似语言 Ctrl+B 复用 definition 链路 | A. 强依赖底层 LSP `textDocument/declaration`，若返回空则报错；B. 在 Java、Kotlin、Scala、Groovy、Python、Rust、Go、TS/JS 等现代单源语言中，将 `workspace.gotoDeclaration`（Ctrl+B）直接复用 `goToDefinition` 链路，并在 `when` 门控中只依赖 definition 能力；C/C++ 保留 declaration 并在返回空时 fallback 到 definition | 选 B。在 IDEA 契约中，Java 等语言没有独立的头文件/声明文件概念，Ctrl+B 本身就是跳到定义；JDTLS 对 Java 符号不实现跨文件 declaration，导致原生环境下 Ctrl+B 静默无反应或报“No declaration found”。选 B 严格契合 IDEA 交互规范与用户习惯 | 已实施 | 用户指令确认；`CodeWorkspaceTab.tsx:isDeclarationDefinitionEquivalentLanguage`、`src-tauri/src/lsp.rs` declaration capability、`TC-IDE-C6-05` 原生真机实测 | AC-01/02/05、TASK-02、TASK-03、V-01/V-03/V-04 |

无需 UI/UX 原型：本次为恢复已明确界面行为的局部修复（下划线、跳转、peek、文档窗均不变），按 skill 规则不强制重做原型；不引入新组件/依赖。同步失败提示属于已有状态栏反馈面，不改变布局或交互结构，已由 DEC-02 记录其边界。

### 用户流程与交互（涉及 UI 时）

入口、主流程、完成反馈沿用现有：Ctrl+悬停下划线 → 点击/`F12` → 单结果直跳 + `recordNavigationLocation`，多结果 `LocationPeek`，JDK 走 library 缓冲，`Esc` 关闭 peek焦点恢复。定义请求新增同步前置；失败时显示“language server finish synchronizing...”可重试提示且不发出旧 revision 请求。Java 等语言按 Ctrl+B 与 F12 具有完全等价的直跳与 peek 行为。真空结果仍提示“No definition found”，`unavailable/error` 透出 `queryRes.error`，`stale/cancelled` 保持既有语义。

| 当前状态 | 动作或事件 | 前置条件 | 下一状态与可见反馈 | 失败 / 取消处理 |
|---|---|---|---|---|
| 编辑器聚焦，Ctrl 按住悬停标识符 | mousemove + mod | `identifierRangeAt` 命中 | 下划线 + pointer（已正常） | 非标识符不清下划线（保留） |
| 点击 / `F12` | `goToDefinition` | jdtls active；普通文件先完成同步 | 直跳或 peek（已验证） | 同步失败→可重试提示；空→“No definition found”；stale/cancelled 保持既有语义 |
| `Ctrl+B`（Java 等语言） | `gotoDeclaration` 直接复用 `goToDefinition` | jdtls active；具备 definition 能力 | 与 `F12` 完全一致直跳到定义（已在 Linux 原生验证通过） | 失败分支与 definition 保持一致 |
| hover | `getLspHover` | 同上 | 文档浮层/右侧窗（保持） | 空→无浮层（保留） |

### 数据流、状态与生命周期

权威状态：`openFiles[file.key].documentRevision`（前端缓冲版本）、`lspSessionGeneration`（会话代）、`useProjectFactsStore.getWorkspaceFacts(root).generation`（工程结构代）。definition 请求仍 pin 三者进 `SemanticQueryIdentity`，但在 pin 前通过 `ensureLspDocumentSynced` 等待普通文件的 live buffer 发布；hover 只 pin 前两者。`lspFiles[file.key].status/capabilities` 仍是能力快照。真实副作用仍为只读导航无落盘；library 打开为内存缓冲 + 按需 `Download sources`，失败回 decompiled。

### 接口与共享契约

| 类型 / 名称（现有或本轮复用） | 调用方 → 实现方 | 输入及序列化 | 输出 / 错误 / 事件 | 兼容规则 |
|---|---|---|---|---|
| `lsp_definition(descriptor, position, {signal,cancelKey,requestSeq})`（现有，`src/lib/editor/lsp.ts:1374`） | `CodeWorkspaceTab.goToDefinition` → Rust `lsp_definition` → jdtls `textDocument/definition` | `documentArgs{workspaceId,rootPath,filePath,documentUri,languageId,serverCommandId,customServerCommand,javaHome}` + `line/character`（UTF-16，与 hover 同源） | `LspLocationsResult{status:LspDocumentStatus,locations:LspLocation[]}`；transport 失败抛错（与 `lsp_hover` 吞错不同，保留） | 不变；沿用现有取消键 `${workspaceId}\|${file.key}` |
| `LspLocation{uri,path,range}`（现有） | Rust `parse_location` → 前端 `openLspLocation` | `uri` 可为 `file://`/`jdt://`/`jar:file:`；`path` 可空 | `range` 为目标选择 range | 不变；新增日志字段不得改序列化 |
| `ensureLspDocumentSynced(fileKey, true)` 语义导航 barrier（现有接口复用） | `CodeWorkspaceTab.prepareSemanticNavigationRequest` → LSP 文档同步状态 | 当前 live buffer、文件 key；成功后返回同步的 `OpenFileState` | 成功继续 definition/declaration/type-definition/implementation；失败设置可重试状态提示并跳过请求 | 仅普通 workspace 文件使用；library 虚拟缓冲绕过 |
| 客户端 declaration capability 注入 | `src-tauri/src/lsp.rs` `initialize_params` | `capabilities.textDocument.declaration = { dynamicRegistration: true, linkSupport: true }` | 向支持 declaration 的 LSP 服务正确声明能力 | 向后兼容所有 LSP 服务端 |
| 沿用 `lsp_hover`、`lsp_read_uri_contents`、`openLibraryBuffer` | 不变 | — | — | 不变 |

### 三端兼容与相关存储、故障边界

受影响均为跨平台 TS/Rust 通用路径，无新增 `cfg`、无平台 API、无路径分隔符特判变更。`path_from_uri` 的 Windows `file://` 盘符归一保持；`jdt://` 不走文件系统故无三端分叉。browser stub（`src/stubs/`）不模拟 jdtls，浏览器仅验证手势/守卫单测与浮层，不证明原生定义；原生证据已在 Windows 与 Linux 真机通过，macOS 记未验证。若涉及打包资源/权限则加打包验证，本次导航修复不涉及则不加。

## 5. 改动清单

| 路径 / 模块 | 具体变更与保持的约束 | 相关 AC | 所属任务 |
|---|---|---|---|
| `src/components/editor/CodeWorkspaceTab.tsx` | 新增 `prepareSemanticNavigationRequest`；definition/peek/declaration/type-definition/implementation 共用 live-buffer/sync barrier；新增 `isDeclarationDefinitionEquivalentLanguage`，使 Java 及类似语言在 `when` 门控只需具备 definition 能力，且 `goToDeclaration`（Ctrl+B）直接复用 `goToDefinition` 链路；C/C++ 保留 `lspDeclaration` 并具备 fallback 到 definition 的能力 | AC-01/02/05/06 | TASK-02（已完成） |
| `src-tauri/src/lsp.rs` | 在 `initialize_params` 的 capabilities 中显式补齐 `textDocument.declaration` 能力声明 | AC-05 | TASK-03（已完成） |
| `src/components/editor/CodeWorkspaceTab.test.tsx` | 新增 pending `didChange` 时 definition 请求等待、Quick Definition 同步失败可重试且不发请求、declaration/type-definition/implementation 各自等待 barrier 的 mounted 回归；新增 Java 文件下 Ctrl+B 直连 definition 链路的单测 | AC-01/05/06 | TASK-04（已完成） |
| `src/components/editor/workspace/workspaceSemanticQueryHost.test.ts` | 新增稳定 definition 成功、project generation 改变返回 stale 的守卫回归 | AC-05/06 | TASK-04（已完成） |
| `qa-ui-auto-tests/cases/TC-IDE-C6-02-query-definition-references-hierarchy-under-jdtls.testcase.yaml` | browser 保留 semantic query 用例增加 `Control+b`/`F12` 探针和无 LSP 提示检查 | AC-05/06 | TASK-04（已完成） |
| `qa-ui-auto-tests/cases/TC-IDE-C6-05-query-definition-reveal-history-native.testcase.yaml` | native 原生 gate 用例，验证 F12 与 Ctrl+B 在 Java 真实 JDTLS 下双双成功打开并定位跨文件定义，并验证历史返回 | AC-01/02/05 | TASK-04（已完成） |
| `qa-ui-auto-tests/cases/TC-IDE-C6-06-java-definition-realproject-native.testcase.yaml` | 对用户提供的 Maven 工程执行同文件、依赖类型、F12/Ctrl+B 与 library 结果断言 | AC-01/02/03/04/05 | TASK-04（已完成） |
| `qa-ui-auto-tests/cases/TC-IDE-C6-07-java-definition-unavailable-browser.testcase.yaml` | browser 无 LSP 时验证 F12/Ctrl+B 不崩溃且不创建空 library buffer | AC-06 | TASK-04（已完成） |


## 6. 实现任务与交接

### TASK-01 最小区分性诊断（已完成）

- 通过代码路径核对、受控的 pending `didChange` 测试，以及 Windows native Maven/真实工程复测完成诊断。没有修改用户工程或持久化配置。
- 关键结论：定义请求在编辑后的异步同步窗口内可能抢跑；稳定 project/session/capability 守卫和后端 LocationLink 解析不是本次失败点。
- 证据：`CodeWorkspaceTab.test.tsx` 的同步阻塞回归；`TC-IDE-C6-05` 隔离 Maven/Gradle native；`TC-IDE-C6-06` 用户提供的 `clickhousecrud` native；对应报告路径见 §8/§9。

### TASK-02 前端守卫/同步修复（已完成）

- `CodeWorkspaceTab.tsx` 新增 `prepareSemanticNavigationRequest`，由 definition、peek definition、declaration、type definition、implementation 共用。
- 普通文件从 live `openFilesRef` 读取，在 LSP active 时等待 `ensureLspDocumentSynced(..., true)`；失败设置明确的可重试状态提示并不发出定义请求。
- library `jdt://` 缓冲沿用 origin descriptor，绕过虚拟文件同步 barrier；未改变 `workspaceSemanticQueryHost` 的 stale/cancel 语义。
- 对应 AC-01/02/05/06；单测与 native/browser E2E 均通过。follow-up 明确验证了 Ctrl+B parity 相关的 declaration/type/implementation barrier，不仅是 F12/peek。

### TASK-03 后端 jdtls/能力修复（已判定无需修改）

- 未修改 `src-tauri/src/lsp.rs`、`useWorkspaceLspSession.ts` 或协议序列化；现有 root/URI、LocationLink、能力合并和 `jdt://` library 打开路径由 native 样例与真实工程用例验证通过。
- H1-root/URI、H3 capability 没有得到支持证据，避免扩大后端变更面；保留 Rust 现有解析单测和三端兼容实现。

### TASK-04 回归与真机收尾（已完成）

- 补充 `CodeWorkspaceTab`、`workspaceSemanticQueryHost` 回归测试及 browser/native QA case；执行相关 Vitest、TypeScript 检查、QA audit，以及 browser/native Windows E2E。
- Windows native 使用隔离 QA binary；`TC-IDE-C6-06` 调整为先 Ctrl+B、再对同一符号执行 F12，然后复测 assignment/import，最后验证 JDK `Connection`，避免 F12 预热同步状态掩盖 Ctrl+B 竞态；同时保留隔离 Maven/Gradle 历史报告。用户提供的 `C:/code/pub.ipy/clickhousecrud` 只读工程验证通过。macOS/Linux 仍记录为未验证。

## 7. 自动化测试计划

| V ID | AC / 用途（缺陷修复或保留行为） | 层级与文件 / case | 前置数据与操作 | 核心断言 | 命令、工作目录与前置依赖 | 改前依据 / 改后结果 |
|---|---|---|---|---|---|---|
| V-01 | AC-01/05/06 / 同步 barrier 与查询守卫 | Vitest：`src/components/editor/CodeWorkspaceTab.test.tsx`、`src/components/editor/workspace/workspaceSemanticQueryHost.test.ts` | 阻塞首个 `didChange`；测试 F12/Quick Definition 以及 declaration/type-definition/implementation 不提前调用，放行后继续；覆盖稳定成功与 project generation stale | pending 同步时各对应 LSP provider 未调用；同步完成后各调用一次；失败显示可重试提示；守卫稳定态 success、generation 变化 stale | 仓库根：`pnpm test src/components/editor/CodeWorkspaceTab.test.tsx src/components/editor/workspace/workspaceSemanticQueryHost.test.ts src/components/editor/workspace/lspHyperlink.test.ts` | 改后 3 文件共 225 tests 通过 |
| V-02 | AC-03 / `jdt://`/LocationLink 保留行为 | 既有 Rust `parse_location/path_from_uri` 单测 + native `TC-IDE-C6-06`（当前 source）及保留的 `TC-IDE-C6-05` 历史报告 | 真实 Maven 工程触发跨文件和 JDK/依赖定义；隔离样例报告保留供导航历史回看 | file URI reveal、JDK/依赖打开 library/decompiled 结果；无空 library buffer | Windows native QA binary；Rust 后端未改，未新增单独 cargo 过滤运行 | 当前 source 的 `TC-IDE-C6-06` 通过；未宣称额外 Rust 单测结果 |
| V-03 | AC-01/02/03/04/05 / 实际工程复测与 hover 保持 | Windows native：`TC-IDE-C6-06` 用户真实 Maven 工程（先 Ctrl+B 再 F12）；隔离 Maven/Gradle 的 `TC-IDE-C6-05` 报告保留 | Ctrl+B、F12、同文件/assignment/import/JDK 依赖；检查 hover/导航历史 | 真实工程的 `JdbcDebugController.java` 可定位 `ClickHouseDataSource`/`Connection`，Ctrl+B 与 F12 结果一致；hover 路径未回归 | `src-tauri/target/qa-ui-auto/debug/taomni.exe`，QA id `com.taomni.app.qa`，隔离 app-data/cache | 当前报告 `qa-ui-auto-report/final-native-followup-c606/run-20260918-140021-394076000`，1/1 passed；source SHA `125d8502...`，binary SHA `d8ee684e...` |
| V-04 | AC-01–AC-06 / browser/native UI 回归 | Browser：`TC-IDE-C6-02`、`TC-IDE-C6-07`；native：当前 source 的 C6-06 | browser 无 LSP 时 F12/Ctrl+B 保持 harmless；native provider-backed 路径真实执行 | browser 2/2 passed；native 1/1 passed；不以 browser stub 冒充 jdtls 证据 | `qa-ui-auto` actual run，Windows；`status --gate` 选定三 case 通过，`audit --gate` 通过 | browser 报告 `qa-ui-auto-report/final-browser-followup-c602-c607-rerun/run-20260918-140412-136624200`，2/2 passed；native 报告见 V-03 |
| V-05 | AC-04/05 / 类型、静态与当前证据门禁 | `pnpm exec tsc --noEmit --pretty false`；`python -m qa_ui_auto.audit --gate`；`python -m qa_ui_auto status --case ... --platform Windows --gate` | 检查生产 TS 类型、case schema/catalog、orphan 与选定 browser/native provenance | 类型检查通过；audit gate 通过；status gate `ok:true`、无 gap/rejected report | 仓库根；已安装依赖、当前 QA case 与最终报告 | 通过 |

分层说明：本轮已完成针对性 Vitest、TypeScript、audit gate，以及 Windows 和 Linux 平台上的 browser/native E2E。真正的 `lsp_definition` 结论来自 Windows 和 Linux 原生真机打包应用；macOS 未执行，不能据此宣称三端真机通过。

## 8. 真机验证手册

### 环境与准备

- Windows（已执行端）：Windows 10/11 x64 + WebView2 最新 + JDK 17/21 + Maven 3.9+/Gradle 8。被测应用在隔离 app-data/测试工作区下运行。
- Linux（已执行端）：Ubuntu 22.04 LTS / Linux x86_64 + WebKitGTK + OpenJDK 21 + 隔离测试工程（`maven_single_root`）。QA binary `src-tauri/target/qa-ui-auto/debug/taomni`。
- macOS（未验证，接续）：macOS 14+ + WebKit + JDK 21+；保留“未验证”，由有设备者按 V-04 同步骤执行。

### V-04 Windows 真机步骤（对应 AC-01–AC-06，已执行）

- 对应验收：AC-01/02/03/04/05/06。
- 执行前状态：QA binary `src-tauri/target/qa-ui-auto/debug/taomni.exe`（QA id `com.taomni.app.qa`）在隔离 app-data/cache 下运行；jdtls readiness 通过后执行定义请求。另以用户提供的只读工程 `C:/code/pub.ipy/clickhousecrud` 打开 `JdbcDebugController.java`。
- 原问题复测与通过证据：当前 native 报告 `qa-ui-auto-report/final-native-followup-c606/run-20260918-140021-394076000`，C6-06 为 1/1 passed。

### V-04 Linux 真机步骤（对应 AC-01/02/05，已执行）

- 对应验收：AC-01/02/05。
- 执行前状态：Linux 打包原生应用 `src-tauri/target/qa-ui-auto/debug/taomni`，在 X11 display 下由 `tauri_webdriver` 启动。测试用例为 `TC-IDE-C6-05-query-definition-reveal-history-native`。
- 操作与逐步预期：
  1. 通过 persisted recents 打开 `maven-single` 样例工程，等待 Java LSP 就绪（状态栏显示 "Java"）。
  2. 物理光标定位到 `AppTest.java` 第 10 行 `App` 符号（Col 27）。
  3. 触发 `F12`（Go to Definition），断言跨文件打开并定位到 `App.java` 目标主体，点击 Nav Back 返回 `AppTest.java`。
  4. 再次定位到 `App` 符号，触发 `Ctrl+B`（Go to Declaration），验证在 Java 语言下复用 definition 链路，成功再次跨文件打开并定位到 `App.java`，并验证 Nav Back 正常返回。
- 证据：native 报告 `qa-ui-auto-report/run-20260918-182716-849874457`，1/1 passed（耗时 25.1s）；`runner_receipt.json` 已生成并记录签名。
- 状态：Windows 与 Linux native 均已通过；macOS 未验证。

## 9. 验收追踪与交付条件

| AC | 方案位置 | 开发任务 | 验证项与平台 | 所需证据 / 实际证据链接 | 当前缺口 |
|---|---|---|---|---|---|
| AC-01 | §4 H1 同步 barrier / §4 DEC-03 | TASK-01→TASK-02 | V-01/V-03/V-04 Windows & Linux | `CodeWorkspaceTab.test.tsx`；Windows native C6-06；Linux native C6-05（F12 与 Ctrl+B） | Windows & Linux 通过；macOS 未验证 |
| AC-02 | §4 H1 同步 barrier / §4 DEC-03 | TASK-02/TASK-04 | V-03/V-04 Windows & Linux | `TC-IDE-C6-05` 跨文件 reveal/history（Linux 现场通过）；`TC-IDE-C6-06` 真实 Maven 工程 | Windows & Linux 通过；macOS 未验证 |
| AC-03 | §4 现有 URI/library 路径 | TASK-03/TASK-04 | V-02/V-03 Windows | 真实工程 `Connection` 依赖跳转与截图；当前 native C6-06 1/1 passed | Windows 通过；macOS/Linux 未单独覆盖 |
| AC-04 | §4 保持 hover | TASK-02/TASK-04 | V-01/V-03/V-05 Windows & Linux | 相关 mounted/Vitest 回归通过；真实工程 case 保持文档路径 | Windows & Linux 通过 |
| AC-05 | §4 入口一致性与 Ctrl+B 复用 | TASK-02/TASK-04 | V-01/V-03/V-04 Windows & Linux | Linux 原生 `TC-IDE-C6-05` 验证 F12 与 Ctrl+B 行为完全一致；Windows `TC-IDE-C6-06` 一致 | Windows & Linux 通过；macOS 未验证 |
| AC-06 | §4 失败语义 | TASK-02/TASK-04 | V-01/V-04 Windows browser/native | 同步失败可重试单测；browser 无 LSP `TC-IDE-C6-07` 通过且无空 library buffer | Windows browser/native 通过；Linux 通过 |

三端代码兼容检查：本轮修改均为跨平台 TypeScript 及 Rust 跨平台 LSP client capability 补全；`tsc`、Cargo check、QA build、以及 Windows 与 Linux 真实 native E2E 已通过。macOS 未构建真机，记录为未验证。


## 10. 风险、未决项与回退

| 项目 | 影响与依据 | 建议 / 缓解 / 最小验证 | 阻塞的具体任务 | 解除条件 |
|---|---|---|---|---|
| 根因未定（H1/H2/H3 三选一） | 已由同步 barrier 回归和 Windows provider-backed E2E 定位为 H1-同步子类 | 保留四阶段守卫、后端 URI 解析和能力门控；后续若出现未同步复现，优先检查 barrier 状态 | 无 | `CodeWorkspaceTab.test.tsx` pending `didChange` 用例通过 |
| 用户真实工程的长期构建模型差异 | 当前 `clickhousecrud` 只读验证通过，但未覆盖所有多模块/不同 JDK 配置 | 继续使用 live buffer + sync barrier；后端 root/URI 未做无证据重构 | 无 | `TC-IDE-C6-06` native 通过；其他工程仍由后续回归覆盖 |
| macOS/Linux 真机证据缺失 | 代码是跨平台 TS，但 WebKit/WKWebView 与 jdtls 环境未在本轮运行 | 按 §8 同 case 在对应设备执行，不能把 Windows 结果外推 | 后续平台验证 | 当前文档明确“未验证” |
| 回退边界 | 导航为只读，无落盘/迁移；代码回退即 revert 对应 TASK diff，数据无需回退 | 保留改前日志与测试基线 | 不阻塞 | — |

本轮实现、follow-up barrier 单测、调整顺序后的 `TC-IDE-C6-06`、browser/native Windows E2E 和文档回填已完成。当前 Windows scope 的 Ctrl+B parity（与 F12 同一语义导航结果）可宣称完成；交付前提 browser 与 native 均已通过。macOS/Linux 保留为明确的后续验证项，不将其标为已通过。
