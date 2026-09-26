# Java Basic Completion：工程就绪、接受与一次撤销

<a id="ed-parity-005"></a>

## 1. 身份、范围与规划门槛

- 唯一卡：[backlog.md](backlog.md)，`ED-PARITY-005`；来源 [REQ-05](overall-audit-plan-20260913.md#req-05) / `CW-LANG-001`、`CW-LANG-002`；回链 [P0 首包](task-planning.md#ed-parity-005)。沿用 `AUDIT-20260913-01`，不重跑整体评估。
- 2026-09-25 P1 基线：分支 `docs/code-workspace-idea-audit-20260913`，HEAD `8e232d2a3d479c72d325032e5d0c870785039e18`，开始时 tracked/untracked 工作区干净。忽略目录中的既有工件不属于本轮执行。
- 本轮只读生产代码、编写设计与参考；没有 claim、开发 owner、产品/测试修改、产品测试、构建、Taomni启动或提交。用户两次授权十分钟，只操作隔离IDEA项目采样；两时段均已结束，窗口已清理。没有启动其他 agent。
- 用户结果：隔离 Java 工程 ready → Basic Completion → 选择有明确来源的候选 → 正文及 import/snippet 原子接受 → 一次 Undo → 继续输入、保存、再次补全。两种真实接受形态（类型导入、方法 snippet）在同一个文件中顺序演示，不要求 JDT LS 恰好返回同时携带两者的一项。
- 不纳入 Smart/Full Line、依赖下载补全、多语言、导航/层级全量对齐或完整设置改版。`CW-LANG-001` 仅覆盖该工程的进入条件、失效与恢复。
- **P1 规划已就绪，产品验证未执行。** 用户确定 IDEA 2026.2.3 / IU-262.10968.63；第二时段已补采必要状态，并明确保留 provider snippet 的参数默认值差异。G1/G2解除，详见[最终参照合同](references/ed-parity-005-reference.md#followup-observed)。同一卡 author 为 `ready / planning_required=false`，开发仍由 P2 正式领取；不另设规划状态或 owner。

## 2. 当前生产事实与差距分类

下列行号仅定位本次 HEAD；P2 按符号复核。`src/components/editor/workspace/` 简写为 W；没有把旧设计中的“未接线”当成当前事实。

| 链路 / 文件、符号 | 当前事实 | 本卡意义 |
|---|---|---|
| W/workspaceCodeMirrorKeymap.ts `buildEditorHostActions`、`editorAction`（399） | `editor.basicCompletion` 注册 `Ctrl+Space`、次绑定 `Alt+/`；要求 editor focus + active file | 两个实际按键入口都要覆盖；不把 macOS Ctrl 偷换成 Cmd |
| W/CodeMirrorHost.tsx `actionHost.registerActions`、`startBasicCompletion`（3690） | 同一 host 供 Search Everywhere、Keymap；已有 popup 时 close/reopen 保留重复调用序号 | 所有暴露入口须走统一动作，重复请求不重复接受 |
| W/CodeMirrorHost.tsx `getOrCreateTrackedLspSource`（2580） | 源捕获 identity、policy、query 序号；local source 与 LSP source 并存；Tab 优先 accept，再模板/snippet，最后缩进 | 保留本地模板兜底与输入归属 |
| CodeWorkspaceTab.tsx `completionIdentityForFile`、`getLspCompletions`（16079、16152） | 从 `projectFactsRoot` 调 `resolveCompletionScopeFacts`；严格同步 live buffer 后才调用 completion；返回再校验文本和 token | 原 ED-COMP-004 的“无 consumer”已过时；不安排再接一次 |
| W/completionScopeAdapter.ts、projectFactsConsumers.ts；src/stores/projectFactsStore.ts | 同 root、ready generation 才提供 module/source-set/dependencies；否则 `scope-facts-missing` | project facts 与 provider ready 分开证明，不能仅见 Java pill 就声明工程 ready |
| src/lib/editor/lsp.ts → src-tauri/src/lsp.rs `lsp_completion`（6412） | 真实调用 `textDocument/completion`；显式 kind=1，点号 kind=2；重复 expanded 仅记录，不承诺标准 LSP 扩 scope | 如实记录 candidate/provider 来源，不能把客户端 requestedScope 当实际 provider scope |
| W/lspCompletion.ts `createLspCompletionSource`、`applyLspCompletion`、`commitLspCompletion` | 原 candidate/raw identity、排序与策略会话；typed resolve gate；primary+additional edits 单 dispatch；snippet 位移重映射；readonly/stale/overlap 拒绝 | 现有正确基础；需要本卡真实入口和 provider 证据 |
| src-tauri/src/lsp.rs `lsp_completion_resolve`（6501）→ CodeWorkspaceTab.tsx `resolveLspCompletion`（16203） | Rust 把 request error 变 null，再 `parse(resolved).or_else(parse(original))`；宿主 catch 又返回 null | **D1：源码确认的失败信息丢失**。原始 item 没有 import、实际 resolve 失败时仍可能被前端当 resolved；运行复现尚未执行 |
| W/lspCompletion.ts `sameCompletionIdentity`；CodeWorkspaceTab.tsx `isCompletionTokenCurrent` | 比较 workspace/file/path/URI/language/revision/session；未比较 token 的 project facts generation | **R1：待归因风险**，刷新 facts 而文件/session 不变时是否可接受旧 scope 要用 V3 区分；尚不称已复现 bug |
| W/CodeMirrorHost.tsx `presentResolveGate`、W/lspCompletion.ts `applyLspCompletion` | gate 有 Retry/Insert without import/Dismiss；初次 resolve 未传 AbortSignal；gate closure 有 settled/doc guard | **R2：待归因风险**，接受等待时 Esc、同 revision 切换 view、旧 retry 回调更新新 gate，需 V3/V4 检查 |
| W/useWorkspaceLspSession.ts `saveDocument`（767）；Rust `notify_watched_file_sessions`（2755） | Java 跳过 didSave；已打开文档过滤 watched-file 自写回声 | 后续修复已在源码中，不再规划原修复；保存后继续补全是保留断言 |

历史只读合同：[completion-and-query](../../claudedocs/code-workspace-idea-specs/completion-and-query.md)、[shared-contracts](../../claudedocs/code-workspace-idea-specs/shared-contracts.md)、[保存后补全修复](../../docs-issue/code-workspace-java-completion-no-suggestions-design.md)、[模板/触发修复](../../docs-issue/code-workspace-java-live-template-completion-regression-design.md)。原日期、PASS、平台和失败记录不改；没有本轮产品 PASS。现有 `TC-IDE-C2-01` 是 Linux/provider 历史契约，不能直接作 Windows 当前证据。

分类结论：已有基础=接线/同步/原子接受/本地模板；确认静态缺陷=D1及后续实采定位的D2；待运行风险=R1/R2；缺证据=当前真实 provider/IDEA 比较；视觉/交互差异=尚无充分双侧观测，不能下结论；本包未确认新的补全引擎能力缺失。

## 3. 决定与实现责任

所有 DEC 编号前缀为 `ED-PARITY-005-`，A/V 亦同。以下是职责边界，不是开发领取。

| DEC | 决定、来源与状态 | AC / V |
|---|---|---|
| DEC-01 | agent 自决：复用真实 production source/controller/事务；修 D1、词中接受的 D2 及本卡复现的契约缺口，不重做旧卡。依据当前 caller | A1/A3；V1/V3/V4/V5 |
| DEC-02 | **用户已定**：本轮明确采用已安装的2026.2.3 / IU-262.10968.63；保留原F2/其他卡历史版本。十分钟桌面时段已使用并结束 | A2；V6；G1 |
| DEC-03 | agent 自决：scope 必须绑定 root + facts generation + file/session/revision + policy；事实变代后旧候选不能接受，显式重新调用恢复。保留 document fallback 及原因，不假称 native module 候选完整 | A1/A3；V3/V5 |
| DEC-04 | agent 自决：恢复已有 fail-closed 合同。provider resolve 的 null/失败/超时不得退回 original 当成功；只有实际 resolved 或 item 自带完整 additional edits 可自动提交。无 resolver 时用 gate，由用户显式选择 primary-only | A1/A3；V4/V5 |
| DEC-05 | agent 自决：一次接受只写 live 文档、不隐式保存；一次 Undo 恢复完整接受前文本与选区。占位符纯导航无文档 edit；后续用户输入的 Undo 单独成步骤，不将多次编辑谎称一次 Undo | A3；V2/V5 |
| DEC-06 | agent 自决：Esc/关闭/切 workspace 终止当前 completion acceptance session；迟到不提交、不重开、不覆盖新 gate，恢复必须重新显式调用。网络 request 可能已发送，零效果指零文档/磁盘 mutation，不承诺网络零流量 | A1/A3；V3/V4 |
| DEC-07 | agent 自决：browser 优先证明 UI、Action、键位与异步接线；保留 native/provider 要求以证明真实 JDT LS、Tauri/Rust、写盘和读回。新增 browser evidence，不删除原六类 | 全部 |
| DEC-08 | **用户已定**：保留provider原始snippet默认值与占位符；IDEA append()差异明确接受，不新增Java清空参数适配。字体/缩放、词中Enter/Tab、双击、live template导航及边缘已有实采；gate为Taomni故障适配。保留纯导航无edit；不引入IDEA live template结束格式化历史 | A1/A2/A3；V2/V5/V6 |
| DEC-09 | agent自决，依据第二时段17–27：词中Enter/鼠标接受保留后缀，Tab替换该identifier余部；保持provider明确range和安全校验，具体接口见D2。当前客户端没有accept intent、Rust丢失replace range，属静态差距，产品运行未复现 | A1/A2/A3；V2/V5 |

### D1 修复合同（issue-design，静态根因已定位、运行未复现）

复现输入：completion 返回 label/primary edit、有 raw data、没有 additionalTextEdits 的 item；实际 `completionItem/resolve` 依次返回 JSON null、JSON-RPC error、迟到超过本地 resolve timeout。用户从真实候选行按 Enter。当前 Rust 的 original fallback 会使前两项跨过 gate；V4/V5 的修复前结果必须实际记录，不能拿 helper 已通过替代。

责任与接口：P2 在 `src-tauri/src/lsp.rs` 的 completion resolve 边界停止 `.or_else(parse(original))` 成功伪装，保留真实错误/无结果信息；`src/lib/editor/lsp.ts` 与宿主唯一生产调用方同时适配。推荐 wire 类型为新 `LspCompletionResolveResult`：`resolved {item}` / `unavailable {reason}` / `timeout` / `failed {message}`（Rust serde `tag="kind"`、camelCase 字段）。无 active session/null/no resolve capability → unavailable；request timeout → timeout；其他 transport/protocol error → failed；合法解析才 resolved。不把 provider JSON null解释为无需 resolve。

在 W/lspCompletion.ts 中将上述 wire 状态映射到现有 `CompletionResolveOutcome`；`cancelled/stale` 仍由 session/token 门控，优先于返回结果。本地超时定时器和 abort listener 在 settle/unmount 后清理；实际网络取消能否支持按 provider transport 核实，至少必须实现 late-result 丢弃。更新 hooks 和 fixture resolver 的类型，所有生产/测试 caller 编译覆盖，禁止仅改 UI 文案。没有数据持久化迁移，不改其他 LSP command 返回类型。

### D2 词中接受范围合同（新增实采差距，非新工作包）

来源同一Basic Completion入口，IDEA Tmid=`StringUti|Suffix`：Enter/双击→`StringUtilsSuffix`，Tab→`StringUtils`，两者各只有一个import且一次Undo恢复完整Tmid。源码 `src-tauri/src/lsp.rs::parse_text_edit` 固定优先insert范围；`LspCompletionItem.textEdit`只有单range；CodeMirrorHost Tab直接acceptCompletion，没有接受意图传至事务。确认静态数据丢失，产品表现仍须改前V2/V5复现。

P2仅在completion专属协议增加可选 `insertReplaceEdit: {newText, insert, replace}`；保留textEdit及原始raw以兼容plain TextEdit/旧fixture。Rust completion parser单独保留双range，**不全局改parse_text_edit**，保护formatting/rename/codeAction等共享消费者。resolved item与初始item都保留该字段；拒绝非法范围或互相矛盾的edits。TS wire、fixture及相关Rust构造同步适配。

接受意图为 `insert | replace`：Enter/鼠标默认insert；Tab replace。意图在当前view的接受session创建时冻结，和候选raw identity、revision、facts/session token共同传给resolve/retry/primary-only，不能用跨view全局变量。无active popup时Tab继续既有template/snippet/indent顺序；composition/readOnly保护不变。已有Enter默认accept与鼠标apply都归入insert，不能重复绑定导致双提交。

有合法InsertReplaceEdit时按意图选provider对应range；plain TextEdit默认尊重provider range，不截断provider明确跨token edit。仅Java简单identifier场景（start与当前词首相同，end为caret，单行、无selection、后缀全部Java identifier字符，非字符串/注释）Tab可安全扩展end至本词末；非该场景不猜范围，使用provider原range并记录原因。无textEdit时取CodeMirror当前词范围按同规则；未知/非法坐标整笔拒绝，不半写import。词中Enter保留后缀的目标在有insert范围或此简单prefix fixture上验证；不得为像素对齐篡改任意provider编辑。修改range与additional edits一起进入现有冲突检查和一次事务。

### 文件/符号与共享消费者

| 本卡 P2 责任 | 文件、接口与约束 |
|---|---|
| Completion 请求/接受生命周期 | W/lspCompletion.ts：insert/replace intent与双range、identity/project generation、resolve outcome、单次 settle、range/snippet/overlap、取消；W/CodeMirrorHost.tsx：source/gate/view session、Tab/Enter/Esc/焦点。不复制第二个 completion 状态 owner |
| 宿主与工程事实 | CodeWorkspaceTab.tsx：`completionIdentityForFile/getLspCompletions/resolveLspCompletion`；必要时 W/completionScopeAdapter.ts、projectFactsConsumers.ts。store 既有数据格式保持；检查 facts invalidation caller |
| IPC/provider | src/lib/editor/lsp.ts、src-tauri/src/lsp.rs 的上述 resolve 边界；请求位置统一 LSP UTF-16/URI 工具，不手拼 Windows 路径 |
| 输入/共享 UI | W/workspaceCodeMirrorKeymap.ts、workspaceActionHost.ts、useWorkspaceActionsController.ts、SearchEverywhere.tsx、KeymapCheatSheetDialog.tsx（实际路径由 P2 按引用定位）；只修本动作相关路由，保留 ED-PARITY-004 已交付冲突策略 |
| 保存/其他消费者 | `saveDocument`、`ensureLspDocumentSynced` 的 signature/语义 mutation、local template source、共享 history、分屏文档。默认不改这些消费者；若必须调整，要先跑表中对应保留基线 |
| 测试/设施 | 下方精确用例及 mocks/fixtures、F25.5 covers/controls。新增设施只用于隔离 QA，release 不安装 fault controls；不通过注入 store/直接调用 apply 替代 UI 动作 |

失败保持 typed；overlap/invalid range/readonly/stale 全零提交；Retry 期间禁用 Retry 和 primary-only，Dismiss 可中止。成功后 gate 关闭并回 editor，失败仍显示候选与原因；旧 gate token 的 callback 不能修改新 gate UI。scope/session 失效清 popup、docs、snippet/gate session，保留用户文本/dirty/undo 历史，重新 ready 后显式触发。

## 4. 连续用户场景与 UI 目标

Fixture 精确内容、构造位置和未观测目标见[参考包 fixture](references/ed-parity-005-reference.md#fixture)。S0–S8 的浏览器可控版本使用 B-005；真实 IDEA/JDT LS 使用 F2-COMP-005。

| 状态 | 用户操作 | 目标观察 |
|---|---|---|
| S0 工程进入 | 打开隔离工程/Java 文件，等待 import/facts/provider ready | root、JDK、facts generation、classpath、session 明确；loading/degraded 不能冒充 ready |
| S1 触发 | 将明确范围改为前缀；Ctrl+Space / Alt+/ / Action；重复一次 | 候选来自当前文档/工程；选中项稳定；重复 ordinal 可追踪而 scope 扩展不伪报 |
| S2 选择 | 上下键与滚动、点击候选；显示 documentation | raw identity 与 label/detail/source 一致；焦点在 editor 或指定 popup 控件；docs 不遮住候选或接受入口 |
| S3 接受 | Enter、Tab、鼠标分别在重置后接受 | import+primary 或 snippet 一次 commit，无重复 newline/indent；dirty=true，未保存磁盘仍 B0 |
| S4 撤销/重做 | 立即 Undo、Redo、Undo；snippet 导航另轮复位 | 每次只操作一份共享文档；Undo 恢复完整 preimage 与选区，纯 Tab 导航不加历史 |
| S5 取消 | popup Esc；accept 等待中 Esc；gate Dismiss；再显式打开 | 零额外编辑，焦点和 prefix 保留；迟到不复活旧窗口；新调用可成功 |
| S6 失败/恢复 | resolve null/error/timeout → Retry失败 → Retry成功；另轮 primary-only | 未选择前无 partial import/body；Retry成功一次提交；primary-only明确降级、无 import、一次 Undo 可回到前缀 |
| S7 身份变化 | A 请求中输入/切 B/切 root/重启 provider/刷新 facts，再释放 A | 新文档及新 gate 不受 A 污染；回 A 保留输入，重新 ready 后可补全 |
| S8 保存保留 | 接受后显式保存，继续输入成员前缀、补全、Undo、再次保存 | 字节与当前 buffer 一致；Java 不再发 didSave/已打开文档自写 watcher；本地模板、Find、分屏 Undo 仍可用 |

IDEA已观测部分以[本轮实采](references/ed-parity-005-reference.md#observed)为准。B-005的带默认值snippet是Taomni既有事务保留测试，不能冒充IDEA的append()结果；IDEA N1为append()；Taomni保留raw snippet，用户已接受默认参数差异。完整导航参照为IDEA fori，不要求新增Taomni fori。

UI 确定部分：保留 caret 锚定的候选 listbox，选中行、kind icon、label、detail/source、独立 docs；颜色使用现有 code text/muted/border/elevated/selection 角色，warning 表示可显式降级，error 表示失败。长签名/包名可读取完整内容；候选可滚动，docs 不覆盖目标行；窄窗口和底/右边缘不得截断接受、Retry、Dismiss 控件。loading、empty、unavailable、failed、stale 分开，不能仅依靠颜色。键盘选中与失焦状态可辨。

UI最终目标依据：IDEA Islands Dark/Dark，UI Zoom100%/DPI96，Source Code Pro16/line-height1.2/ligatures off，UI Microsoft YaHei UI14；全图1366×768、普通窗1346×680、窄窗950×390。目标行距在此配置下约28px（图像量测，允许因字体渲染±2px）；icon/label/detail单行对齐，长签名横向省略但选中docs可读完整，候选区域纵向滚动。docs优先位于列表左侧（两者有间隙），左侧不够则右侧，均不可遮住选中项；上下空间不足翻到可容纳侧并限制高度。IDEA native弹层可越主窗但留屏幕内，Taomni DOM限制于WebView viewport是宿主适配，保证全部交互可达。不得为逐像素匹配改写用户字体偏好；比较使用隔离profile设置匹配值，跨平台字体不可用时单独记录未匹配，不静默改其他平台默认字体。本卡无主要布局重构，不需要另造图稿；实采图17/29/44/47为可审阅布局基线。

## 5. 本卡 AC 与 V

| AC | 必须结果与保留断言 | V |
|---|---|---|
| ED-PARITY-005-A1 | ready scope/provider 身份与实际请求一致；真实候选目标来源、primary/import结果准确；未 ready 的 fallback 有原因；错误/超时/空结果不伪装成功；stale/readonly/overlap不写入 | V1/V2/V3/V4/V5 |
| ED-PARITY-005-A2 | 同 fixture/状态的 IDEA 与 Taomni 分别给功能/视觉/交互结论；原件、build/主题/scale/font/keymap 和候选身份可追踪；无任一侧不能写 matched | V2/V6；目标已定，产品比较待P2执行 |
| ED-PARITY-005-A3 | 接受 primary+import/snippet 一次 Undo，Esc/Dismiss零提交；跨 file/workspace/provider/facts/policy 不串结果；保留模板、输入框保护、保存后补全、Find焦点和共享文档 Undo | V1/V2/V3/V4/V5 |

required_evidence：`code-audit, unit, typecheck, browser, native, provider, idea-comparison`。browser 为本轮用例设计增补，原 native/provider/idea-comparison 全保留。功能、视觉、交互均未执行，静态文档检查不填产品 evidence。

<a id="test-cases"></a>

## 6. 完整测试用例设计（P2 待实现/执行）

公共规则：所有新 ID 已在当前 cases/src 中查重，未发现同 ID；下列拟新增文件不存在，不是已注册测试。UI case 默认 `modes: [browser]`、`covers: [F25.5]`、`fixtures: [reset_db, parity005_completion]`；后一个为 **P2 待实现** fixture，注册到 `.agents/skills/qa-ui-auto/scripts/qa_ui_auto/fixtures/__init__.py`、schema 与 fixture 实现。浏览器边界 mock provider/IPC，必须经过真实 CodeWorkspaceTab、ActionHost、CodeMirror source/accept/history。禁止把模拟候选称真实 Java 语义。

通用 controls 已存在：`code-workspace-editor` 内 `.cm-content`、`.cm-tooltip-autocomplete li[aria-selected]`、`.cm-completionInfo`、`code-workspace-lsp-status-pill`、`code-workspace-search-everywhere`、`completion-resolve-gate` 及 `-retry/-insert-without-import/-dismiss/-failed-note`。P2 补入 F25.5 controls（代码存在不表示目录已登记）。拟新增只读 `completion-session-observation` 记录 request/session/facts/policy/phase、commit count、selection；不要泄漏真实工程正文或令 QA observation 成为状态 owner。

已核对 verbs：`open/click/dblclick/right_click/click_menu/type/fill/press/wait_for/assert_items/assert_text_equals/assert_attribute/assert_enabled/assert_disabled/assert_count/eval_readonly/screenshot`；`eval_readonly` 仅短只读观察（焦点、全文/选区、几何），不得注入输入或改 state。滚动/viewport/fault release 不假造 verb：P2 实现受控 fixture 与 schema/runner 配套支持，或浏览器手工执行同样步骤并保留记录；不可因此跳过 AC 或改成 native。composition 使用 browser `compose_text`，只证明 renderer protection。native `press`/`native_keys transport: webdriver` 是 WebView 输入，不证明物理 OS 拦截。

每例独立创建 report 下的 A/B 副本及空 app profile；用真实树/最近项目打开文件。case 退出清除本例 fault/计时器、关闭本例 project/session，恢复配置及 clipboard（未使用则无需），只删除本例隔离副本；保留报告，不能清用户目录。证据默认 `qa-ui-auto-report/ed-parity-005/<mode>/<run>/<case>/`，保存 summary+receipt、源码/case/runner/config/build/provider/fixture identity、逐步截图与完整 pre/post 文本 hash。下列全部 **未执行**。

### V1 — Action、键位、可用状态和重复触发

`ED-PARITY-005-V1` → A1/A3。拟新增 `qa-ui-auto-tests/cases/TC-IDE-PARITY-005-01-completion-entries.testcase.yaml`，ID `TC-IDE-PARITY-005-01`，browser/三端浏览器平台；unit 补充 W/workspaceKeymapRuntime.test.ts 与 W/CodeMirrorHost.completion.test.tsx，拟新增测试名 `ED-PARITY-005 routes each Basic Completion entry once`。

前置 B-005 ready、editable、自动 popup 关闭以隔离显式入口。逐一重置同 prefix：实际按 `Control+Space`、`Alt+/`；从 Search Everywhere 的 Actions 与 All 页搜索 `Basic Completion`，分别用 Enter 与点击结果执行；从快捷键速查执行该动作（若当前 context 禁用，先记录 disabled，关闭回 editor 后再执行可用路径）。每次断言仅一个当前请求、同一候选/同一 range，无编辑；Esc 后焦点回 editor 且全文/selection未变。主菜单/编辑器右键当前没有专属 Basic 项时记“不暴露”，不能加一个假入口以凑覆盖；若本卡后续新增则补操作。

同 caret popup 内再次按两种绑定，验证 ordinal 2/requested expanded、providerScope unchanged，不双 commit；Esc重开回 ordinal 1。editor 无文件时动作不可执行；readonly 可查看候选但不能接受，文本不变。分别 focus Find 输入、Search Everywhere query、设置输入、terminal 输入：两绑定不触发 editor 请求，输入/焦点不被抢。用隔离 keymap 给同键制造冲突，实际按键验证既有 conflict 提示和零执行，再恢复再触发成功；测试不能依赖用户 keymap。`Ctrl+Shift+Space` 不当 Basic，AltGr/Dead/composing 不触发；只测相关修饰键，不穷举无关组合。浏览器 native 理由：无，应用内路由不需 native。

### V2 — 接受、布局、snippet 与历史

`ED-PARITY-005-V2` → A1/A2/A3。拟新增 `qa-ui-auto-tests/cases/TC-IDE-PARITY-005-02-completion-accept-undo.testcase.yaml`，ID `TC-IDE-PARITY-005-02`，browser。B-005 的准确 item/edit/placeholder 见参考包。

逐轮从相同 preimage 起：打开列表，Down/Up 选择 identity；滚动到非首项并鼠标接受；另两轮 Enter 和 Tab。每次断言 `primary+import` 完整 postimage、只增一次文档 revision、dirty=true、无 newline/indent，全部文本只出现一次。Undo恢复精确 preimage/selection，Redo恢复 postimage，再Undo。snippet首选区为 `"x"`，Tab到第二字段、Shift+Tab回首字段，最终 Tab 到 `$0`，纯导航全文及history count不变；下一次Tab才普通缩进。另轮修改 placeholder 后先Undo该输入，再Undo接受，避免把多个用户编辑合并为一个期望。

依次在普通窗口、窄宽度和 caret 靠右/底部打开：list、selected行、docs的矩形不互相覆盖，全部关键控件在可视区，长label/detail能完整读取。鼠标进入docs可滚动、回候选可继续选中；Esc先关闭popup而不关闭文件。这些是确定的可用性要求，像素/密度及真实 IDEA 选区比较按第4节和V6执行。双击候选若实际绑定接受也须只提交一次；点击 editor 外部关闭后文本不变。无popup时Enter保留普通换行；Tab/ShiftTab无snippet时仍缩进/反缩进，composition期间不误接受。清理按公共规则。现有 `TC-IDE-C2-05-java-completion-refine-accept-native` 可复用其键盘/鼠标接受断言，不重复编译，但它没有完整 import/gate覆盖。

#### V2 追加：实采词中范围与协议边界（仍属005-02，P2待实现）

新增browser子场景ID `mid-word-enter-tab-mouse`：独立fixture M0为B-005的body `        StringUtiSuffix;`，caret 0-based(4,17)；item label StringUtils、insertTextFormat=1、newText StringUtils；InsertReplaceEdit insert=(4,8)..(4,17)，replace=(4,8)..(4,23)，additional在(1,0)插入 `import org.apache.commons.lang3.StringUtils;\n`。每轮精确重置：Enter→StringUtilsSuffix、Tab→StringUtils、单击仅选中后双击→StringUtilsSuffix；每次唯一import、caret紧跟StringUtils、selection空、一次revision；立即Undo逐字回M0及caret，再Redo/Undo。用户不用点击内部handler，全部实际按键/鼠标。

同例表驱动另测plain TextEdit range=insert的Java安全后缀扩展，空后缀两入口结果一致；provider明确跨token range不被客户端裁剪、string/comment禁用猜范围；非法insert/replace坐标/不同起点/replace不包含insert整笔拒绝。选中非空/readonly/IME保持现有保护。resolve pending时冻结Tab意图：切至另一view后旧response零写入，fresh Retry/primary-only只能使用当前有效session同一intent。无需native证明以上renderer行为；真实JDT LS相同Tmid三入口归005-05，每项原始报文与最终全文/Undo并存。

P2扩展 `src/components/editor/workspace/lspCompletion.test.ts` 测试名 `ED-PARITY-005 preserves insert replace intent through resolve and undo`，`CodeMirrorHost.parity005.test.tsx` 测试名 `ED-PARITY-005 Enter Tab and mouse route distinct range intent`，Rust inline `completion_item_preserves_insert_replace_ranges`。原有测试 `parses_completion...` 中断言优先insert仍可保持兼容textEdit字段，同时新增双range断言；formatting/rename parse_text_edit保留测试不得删除。fixture设施将M0注册为parity005_completion的独立variant，并固定全部字节/响应，报告保存原始wire及解析预期。

snippet参照与保留边界：IDEA fori字段i→空上界→i→最终体位置已观察，结束自动格式化不计纯导航。Taomni B-005的Tab/ShiftTab/最终$0仍必须无正文变化、无新增history（既有正确合同）；不复制IDEA额外格式化/inline建议。空placeholder另加B-005 variant `StringBuilder(${1:})$0`，首字段为空、Tab退出后caret在`)`后，再Undo一次回preimage。native记录provider原样默认值及用户已接受差异，不能把IDEA fori当JDT LS snippet报文。

### V3 — 未就绪、空列表、取消和迟到隔离

`ED-PARITY-005-V3` → A1/A3。拟新增 `qa-ui-auto-tests/cases/TC-IDE-PARITY-005-03-completion-lifecycle.testcase.yaml`，ID `TC-IDE-PARITY-005-03`，browser；拟新增 W/CodeMirrorHost.parity005.test.tsx 中 `ED-PARITY-005 invalidates acceptance when project facts change`、`ED-PARITY-005 escape cancels pending acceptance without revival`、`ED-PARITY-005 old gate callbacks cannot replace a new gate`。

B-005 分别加载 loading/degraded/failed/stale/cross-root facts：显式触发显示 scope-facts-missing/document fallback 原因，不显示 module-ready；typing fallback不刷屏。provider不可用保留 buffer word/local template 候选，不标 LSP 来源；真实 ready 返回零候选则没有假造 provider item。切回 ready后新调用恢复。

每个时序独立重置：fetch pending 和 accept/resolve pending 两个阶段分别 Esc；释放旧响应，断言零提交且无复活。A→B（不同文件、不同 workspace同名文件两种）→释放A→回A；A在等待时输入一字；重启session；只刷新facts generation；只变policy。每个变化单独执行，旧候选不得在新身份上提交，旧docs/gate不替换新窗口；用户新字节保留且fresh调用成功。关闭view/unmount后的响应不抛错不写文档，分屏中关闭非最后view保留共享文本/history。需要可控 deferred provider，P2实现fixture调度及只读观察，不能用 handler 单测替代两阶段真实入口。清理释放全部held promises并关闭本例session。

### V4 — Resolve gate 与 D1 改前失败→修复后恢复

`ED-PARITY-005-V4` → A1/A3。拟新增 `qa-ui-auto-tests/cases/TC-IDE-PARITY-005-04-completion-resolve-gate.testcase.yaml`，ID `TC-IDE-PARITY-005-04`，browser；已有 W/lspCompletionResolveGate.test.ts 的 `timeout presents the gate; Insert without import commits exactly the primary once`、`retry performs a fresh resolve and lands import + primary as one dispatch/one undo`、`overlapping provider edits block the whole acceptance instead of partial apply` 可复用。它们不覆盖 Rust original fallback，也不替代 UI 按钮/焦点。

前置 B-005 raw item无 additional edits。通过真实 Enter接受，四轮注入 null/missing resolver/error/timeout：gate可见且准确状态，正文/import/dirty/history均未变。Tab遍历到 Retry、primary-only、Dismiss并实际激活；Retry在等待中按钮disabled、重复点击不多发；Retry失败显示 failed-note、无编辑，再Retry成功仅一次完整postimage；独立轮点击primary-only，仅写primary、不加import、一次Undo恢复；独立轮Dismiss/键盘Esc（当前不支持则P2落实DEC-06）关闭并回prefix，迟到零提交。

再给重叠/越界 edits：全部拒绝，无primary部分落地，无“成功”文案；只读后接受零变化。旧gate Retry在等待时打开新会话，释放旧请求，不能改新gate。long message/窄viewport检查三按钮和原因仍可达。Rust inline tests拟新增 `completion_resolve_does_not_fallback_on_null_or_error`（src-tauri/src/lsp.rs）；TS adapter拟新增 `src/lib/editor/lsp.completionResolve.test.ts`、测试名 `preserves resolved unavailable timeout failed across IPC`。mock wire response只证明桥接，真实进程边界另见V5。

### V5 — 当前端真实 JDT LS、磁盘与共享消费者

`ED-PARITY-005-V5` → A1/A3，native+provider，Windows/WebView2本轮P2必需；Linux/WebKitGTK、macOS/WKWebView保留同序列未验证。拟新增 `qa-ui-auto-tests/cases/TC-IDE-PARITY-005-05-java-completion-native.testcase.yaml`，ID `TC-IDE-PARITY-005-05`，`modes: [native]`、covers F25.5、fixtures reset_db + F2-COMP-005实施后的fixture + jdtls_required。**browser不能证明真实JDT LS候选/resolve报文、Rust fallback修复和host磁盘bytes，因此保留native。**

准确手工/自动步骤：按参考包创建两份工程；记录JDK/provider完整版本与classpath hash→通过最近项目/树打开Main.java→同时等facts ready和Java semantic-ready→将type probe改为StringUti→Ctrl+Space→核对完整包名org.apache.commons.lang3.StringUtils、raw identity、resolve的additionalTextEdits→Enter→比对全文及新增唯一import，host bytes仍B0→显式Save并独立hash→一次Undo删除identifier和import→Save后host hash回接受前prefix版本。另轮snippet probe：固定append(String str)，按参考包第二时段合同捕获raw/resolve，在接受前以协议展开确定预期全文与选区；接受/导航/Undo严格验证该原始snippet，无Java参数清空。若真实provider缺少该snippet格式，不伪造native通过，保留AC未验证并报告能力边界；不是允许P2任选期望。

接着保存后输入 `new StringBuilder().`，反复两次保存/输入，确认method候选仍来自当前buffer，wire无Java didSave/打开文件的自写watched通知；accept/Undo与磁盘保持一致。额外一轮受控 JSON-RPC provider/proxy（P2隔离设施）返回null/error，经过真实Rust/UI出现gate且零磁盘/文档变化，再解除故障真实resolve成功；标注为fault-injected native协议证据，不能冒充真实JDT LS自然报错。不安装全局代理/改用户provider配置。

保留消费者在browser先覆盖：plain-text `sout`/Java模板启用、禁用、provider同名去重；dot autoTrigger开/关、minPrefixLength=3仍按真正点号触发；Find输入/Esc回选区；两view同文档接受→另一view可见→一次共享Undo；保存的buffer/dirty/savedText不回滚。复用 W/CodeMirrorHost.completion.test.tsx 的两项模板测试、W/lspCompletion.test.ts 的 trigger-origin 测试、W/useWorkspaceLspSession.test.tsx 的Java/non-Java save测试；修改同步helper时追加signature/semantic mutation现有测试，不重跑全部编辑器。

现有 native `TC-IDE-C2-01`（文件 TC-IDE-C2-01-jdtls-basic-completion-choice-and-one-undo-acceptance.testcase.yaml）使用历史Linux/X11、外部commons-lang3和裸prefix，不能原样当当前Windows case；可复用其import+snippet分轮结果与trace结构。`TC-REPRO-SAVE-01-java-completion-after-saves.testcase.yaml`只证明保存后有method行，需本例精确identity/bytes断言。平台无法使用物理Ctrl+Space时记录OS冲突，应用入口仍走Action/Alt+/完成语义证明，不能把替代入口当原键位通过。

### V6 — IDEA 双侧比较

`ED-PARITY-005-V6` → A2，复用V2/V5运行，不为比较再构建。参照状态 R0-ready/R1-list/R2-selected-doc/R3-accepted/R4-undo/R5-cancel/R6-edge；均在[补采步骤](references/ed-parity-005-reference.md#capture-gaps)定义。在相同F2变体、prefix、候选身份、窗口/主题/字体/缩放/keymap下保存双方原图；逐项记录候选label/source、edit、placeholder与Undo结果，行密度/锚点/docs/溢出，Enter/Tab/Esc/焦点。provider特有gate在IDEA无法制造的部分记不可比较，仅以Taomni合同验证。缺侧、不同版本/主题或未知snippet结果保持未验证，不签matched。

### 覆盖维度总映射

| AC/V | 维度/入口/状态 | 操作与断言 | case / mode / 缺口 |
|---|---|---|---|
| A1/A3 V1 | Basic主/次绑定、Action Search的Actions/All、速查入口 | 每入口真实按键/点击，available/disabled、相同路由、仅一次请求；无文件/readonly/输入框保护 | 005-01 browser，P2待实现 |
| A1/A3 V1/V3 | 重复绑定、Ctrl/Alt/Shift/AltGr/composition、keymap冲突 | ordinal/不误派发、冲突零执行、恢复可触发 | 005-01/03 browser；OS拦截V5分记 |
| A1/A2 V2/V6 | list/docs/选中/失焦/长文本/窄窗/边缘/scroll | 实际导航、滚动、点击/双击，完整可见、几何/状态对照 | 005-02 browser，R1/R2/R6目标已补采，产品未执行 |
| A1/A3 V2 | Enter/Tab/鼠标接受、snippet Tab/ShiftTab/末尾、Undo/Redo | 一次提交、精确全文/selection、无多余indent、一次恢复 | 005-02；真实候选005-05 native/provider |
| A1/A3 V3 | loading/degraded/failed/stale/empty/local fallback | 不冒充ready/provider、原因明确、fresh恢复 | 005-03 browser |
| A1/A3 V3/V4 | fetch/resolve等待、Esc/Dismiss、跨file/workspace/session/facts/policy/unmount | 每转换零旧写入、不复活、新调用可用 | 005-03/04 browser；R1/R2待归因 |
| A1/A3 V4 | Retry/primary-only/Dismiss、disabled/retrying/failed-note | 操作全部控件，失败零编辑、显式降级、迟到隔离 | 005-04 browser + Rust/adapter测试 + V5 native |
| A3 V5 | 保存后补全、模板/dot、Find、分屏、non-Java save | 连续动作后身份/字节/dirty/history正确 | 005-02/03扩展保留段 +005-05；上述已有单测辅助 |
| A2 V6 | IDEA相同fixture三维比较 | 双侧逐状态分别结论 | 目标已定；无当前产品PASS |

无本包拖拽操作/资源重命名/重启恢复格式变更，故这些维度不适用；文档关闭/重开与session清理仍在V3。无全局clipboard功能变更，不添加clipboard验收。非当前端不因此免除兼容设计。

## 7. P2 最小执行集合与接续边界

P1 不执行本节命令。P2先落实V1–V6及fixture/controlled-provider/observation支持；先D1/D2最小改前失败和受影响保留基线，再修复，browser迭代。稳定后一次 scoped typecheck覆盖owned paths；Rust改变则在src-tauri执行 `cargo test --lib completion_resolve` 和 `cargo test --lib completion_item_preserves_insert_replace_ranges`（新增测试后才有效），并保留共享formatting/rename解析定向基线。macOS direct Cargo前按AGENTS从根目录stage krb5。

已有可用命令形态：根目录 `pnpm exec vitest run src/components/editor/workspace/lspCompletionResolveGate.test.ts src/components/editor/workspace/completionScopeAdapter.test.ts src/components/editor/workspace/CodeMirrorHost.completion.test.tsx`；新增parity005/adapter测试实现后加入，不用旧PASS代替本次结果。按QA skill设置PYTHONPATH，以browser config执行本卡01–04；稳定输入核对/复用隔离QA binary，集中执行05。完整构建不作为每次UI迭代前置，不借旧build gate。不能在case尚不存在时把计划命令报告为成功。

P2维护 `qa-ui-auto-tests/feature-list.md`、covers/controls，controls变化时重生成testid目录，case批次后 `audit --gate`；检查summary/receipt和selected/pass/fail/skip。回填本节AC→V→实际文件/ID→断言/报告/平台；保留失败chronology。所有原件放忽略目录，入库只交摘要与身份。

**P1门槛结论（2026-09-25）**：G1版本与G2必要参照、snippet差异决定已完成；DEC-08/09、V2/V5/V6期望和设施责任已落盘。同卡author为ready/planning_required=false，无开发owner。完整[可复制P2提示词](handoff-p2-ed-parity-005.md)使用固定板/ID；所有产品验证仍未执行。D1/D2有真实剩余实现工作，P1不是产品done或双侧matched。其他平台验证及原生provider能力缺口不得借ready状态免除。

## 8. P2 当前端实现与自检（2026-09-25）

本节仅记录 ED-PARITY-005 的 P2 结果；上节 P1 当时的未执行结论保持其历史含义。工作树基于 HEAD `25921fd774dfaa7e5832bdaec00caa187f7f4a0e`，最终产品/用例源码身份 `7437cfd8b4bf49259bae3b63368a3e6ff6bb8aa7586f4fc5345185bf736d2292`，runner 身份 `23e9521d80f10ef395b9a50a6821dd59ece69519ebf0b5cdfcd57fb01ca5ba0b`。验证时尚未提交或推送；之后的提交状态以 Git 历史为准。

生产入口为 editor Basic Completion 快捷键/Action/候选点击，经 `CodeMirrorHost` 的唯一 completion controller 和 `CodeWorkspaceTab` 的 live-buffer、scope/session 检查到 Rust `lsp_completion`/`lsp_completion_resolve` 与真实 JDT LS；typed resolve 结果进入 gate 或一次 primary+additional edits 事务，再由共享文档 owner 撤销/重做。D1 的 null/error/timeout 保留为不同失败状态，不再回退原 item 假装 resolved；D2 保存 completion 专属 insert/replace 双范围，在接受会话冻结 Enter/鼠标 insert、Tab replace 意图。facts 变代、切文件/工作区、Esc/关闭和迟到结果不提交。原始 provider snippet 默认值、模板导航、Find/输入框保护、分屏共享 history、Java/non-Java 保存与 watcher 合同保留。

| AC / V | 实际测试及决定性断言 | 本轮结果 |
|---|---|---|
| A1/A3 · V1 | `TC-IDE-PARITY-005-01`：Basic 两绑定、Action 多入口、焦点/冲突/readonly/composition、重复调用和恢复 | browser Windows `run-20260925-222716-397551900`，1 pass / 0 fail / 0 skip |
| A1/A3 · V2 | `TC-IDE-PARITY-005-02`：候选 raw 身份/非首项 import、Enter/Tab/鼠标词中接受、snippet 导航/一次 Undo、窄窗/分屏共享 Undo | browser Windows `run-20260925-222842-979155200`，1/0/0 |
| A1/A3 · V3 | `TC-IDE-PARITY-005-03`：ready/fallback 原因、文件/会话/facts/policy 失效与迟到隔离、显式重试 | browser Windows `run-20260925-222139-731901600`，1/0/0 |
| A1/A3 · V4 | `TC-IDE-PARITY-005-04`：null/error/timeout gate、Retry/primary-only/Dismiss、非法 edits 零提交及恢复；Rust `completion_resolve_does_not_fallback_on_null_or_error` | browser Windows `run-20260925-223101-310968400`，1/0/0；Rust 1/1 |
| A1/A3 · V5 | `TC-IDE-PARITY-005-05`：真实 Commons Lang item/resolve/import、`append(String str)` snippet、保存后两轮继续补全、隔离 Rust null/error fault、Tmid 三入口及各一次 Undo、host 字节 | native Windows/WebView2 `run-20260925-224242-622936200`，1/0/0，223/223 步通过；Rust 双范围测试 1/1 |
| A2 · V6 | 本轮 005-02/05 截图及结果与 `REF-PARITY-005-WIN-20260925` 已存 IDEA 原件只读对照；功能/视觉/交互分别判断 | 对照审阅完成；功能关键转移符合，视觉未判 matched，见下文上限 |

报告均在 `qa-ui-auto-report/ed-parity-005/<mode>/<run>/`，各有 `summary.json` 和 `runner_receipt.json`；`qa_ui_auto status` 当前选中 5 例、browser 4 pass、native 1 pass、0 gaps。10 个定向 Vitest 文件 168/168 通过（`qa-ui-auto-report/_local/parity005-unit-current.log`）；scoped typecheck 退出 0，范围内/外错误均 0（`parity005-typecheck-final.log`）；两个 Rust 定向测试分别 1/1；`audit --gate` 为 270 case、0 error、0 orphan、catalog 最新，`contracts --gate` 为 270/270 reviewed、0 gap。

当前 native QA binary 仅一次最终重建，标识 `com.taomni.app.qa`、SHA-256 `4cebaeb181f6ba8be450727d350251d64f0efb55f48c0c5b2a1a2ce090f0b25b`，构建 256.484 秒；本轮 005-05 运行 85.416 秒。隔离工程 `pom.xml` 初始 SHA-256 `5cc644178baef8d68433acdfcb39cb82674273559ec6daa2fdec1be5502a7632`，`Main.java` 初始 SHA-256 `18c39b515afa53ccca7dd127f5ad92350c060d59aa436c6dfeecef24c982de53`。JDT LS 工作区 `.metadata/.log` 记录 core 启动及实际 Java 22.0.1 Azul；安装 core jar 为 `org.eclipse.jdt.ls.core_1.61.0.202607142124.jar`（SHA-256 `6d5a198c3778b77052ec9ae9fce3a5136711da6b9b16234cf97023389a0a2f7`）；Commons Lang 3.12.0 jar SHA-256 `d919d904486c037f8d193412da0c92e22a9fa24230b9d67a57855c5c31c7e94e`。真实 type resolve 返回 Commons Lang `StringUtils` 和单个 import edit；真实 method resolve 为 snippet format 2、`append(${1:null})`，符合 DEC-08 的原样保留。Tmid resolve 的 insert `[27,36)`、replace `[27,42)` 为同一行的两个真实范围。

失败记录未删除：Vitest 首轮 167/168，原挂载测试在 CodeMirror 75ms 接受保护期内合成 Enter，调整测试等待至 90ms 后当前源码 168/168；005-03 首次 browser 报告 `run-20260925-221719-481808200` 在 Vite 页面 `domcontentloaded` 超时，服务恢复 HTTP 200 后重跑通过。此前 native 成功报告 `run-20260925-212140-243406300` 绑定旧 binary，只作历史定位；005-05 dry-run 只验证设施，不计行为证据。

V6 自检复用原件 manifest 的 IDEA Ultimate 2026.2.3 / IU-262.10968.63、Islands Dark/Dark、Source Code Pro 16、100%/DPI 96；`17-mid.png` 与 `29-method-list.png` 的实际哈希符合 manifest。Taomni `tc-ide-parity-005-05-matched-profile-list.png` 来自本轮真实 WebView2/JDT LS。功能上，Tmid Enter/双击保留后缀、Tab 替换后缀、每次一份 import 与一次 Undo 同 IDEA；Esc 和选中候选的交互结论亦一致。`append(null)` 对 IDEA `append()` 是用户已接受的 provider 差异。视觉上当前 Taomni 工具栏/侧栏密度、候选行高/图标及列表内容仍不同，真实 provider 本轮返回 2 个 `StringUtils` 项，IDEA 存档显示 3 项；截图窗口尺寸也未完全相同。故只签当前 Windows 功能与交互自检，不签逐像素或整体 UI matched。用户本轮明确允许 native 当前端通过后声明卡 done，且不要求重新操作 IDEA 真机；此自检是对已存原件的只读比较，非独立验收。

macOS/WKWebView、Linux/WebKitGTK 未运行。后续在各自隔离 QA app 中以相同 F2-COMP-005 工程、对应 JDT LS/JDK/classpath 身份执行 V1-V5，核对报文、host bytes、三入口/Undo 与截图；macOS 直接 Cargo 前先执行 `bash scripts/bundle-krb5-macos.sh stage`。WebDriver 证明本轮 WebView 输入与 DOM 焦点，不外推物理 OS 快捷键拦截。P0 矩阵 `REQ-05 / CW-LANG-001、CW-LANG-002`：Windows 功能与交互目标差距已关闭；视觉高度一致及其他平台仍未证明，不把本卡 done 换算为整体对齐。

### 2026-09-26 Review 修复与补测

基线为 `87874544`，开始时工作区干净。此前 168 项定向单测清单确实没有包含 `CodeMirrorHost.live-template-interaction.test.tsx`，不能据此声明该文件通过；清单本身不能证明遗漏的动机。本次实际运行旧 `mouse click accepts non-default candidate` 断言失败。

- `lsp_completion_resolve` 只读取静态 capability 是 bug：现在同时读取当前 `textDocument/completion` 动态注册的 `resolveProvider`，注销立即移除支持，其他 method 的 resolver 不误计为补全能力。保留 JDT LS 1.61 的既有兼容适配；其真实接受路径另以原生用例验证。
- Java provider 单击选中、双击接受符合本卡 V2 合同。旧测试改为实际选择非默认 `soutm`，检查单击零文档修改、焦点与选中状态，以及双击/Enter/Tab 各一次接受、一次 Undo 恢复文本和光标。关闭该测试夹具的文档预览，避免把预览 resolve 计为接受。
- 共享字体变化与生产 QA 参数提前求值均确认：恢复 Quick Fix 的全局代码字体，仅为补全列表及文档面板应用工作区字体；QA 事件参数在编译开关内构造，关闭时不读取 completion payload。
- 补测 `TC-IDE-C2-07` 发现其最后一个 Escape 在 Undo 已关闭 popup 后触发 CodeMirror 的临时 Tab 焦点退出模式。移除此多余按键并同步 verification 步骤映射，保留全部文本/Undo/Tab 展开断言；本地模板的单击接受仍有覆盖。

| 检查 | 本次结果与证据 |
|---|---|
| 定向 Vitest | 10 文件、146/146，通过；包含此前遗漏文件的 21/21。日志 `qa-ui-auto-report/completion-review/unit-complete.log` |
| Rust | Windows `cargo test --lib completion_resolve`，3/3，通过静态能力、动态注册/注销与 null/error 分类；日志 `completion-review/rust.log` |
| Browser V2 | `TC-IDE-PARITY-005-02`，183/183 步通过；报告 `completion-review/browser/run-20260926-162905-438110600`。同批旧 C2-07 失败保留，不能把整批标为通过 |
| Browser 模板保留行为 | 修正后的 `TC-IDE-C2-07-live-template-popup-input-browser`，38/38 步通过；报告 `completion-review/browser/run-20260926-164609-284556700` |
| 字体实测 | 工作区 Courier New / 20px：正文、completion list/info 为 20px，editor root 保持 UI 字体；隔离挂载生产 ContextMenu 的 Quick Fix 保持全局代码字体 / 13px。截图 `completion-review/completion-font.png`、`quickfix-font.png`；不是实际 provider Quick Fix 操作证据 |
| Windows native V5 | 一次隔离 QA 构建成功，含 TypeScript/Vite；`TC-IDE-PARITY-005-05` 在真实 WebView2/JDT LS 中 223/223 步通过、0 skip，报告 `completion-review/native/run-20260926-163247-809101000` |
| 静态门禁 | `qa_ui_auto audit --gate`，270 case、0 error、0 orphan、catalog 最新，通过；`git diff --check` 通过 |

所有运行报告相对根目录 `qa-ui-auto-report/`，保留 summary/receipt 和失败尝试。native 首次因 PATH 上的 JDK 11 被跳过，未计为通过；测试进程改用本机 JDK 21 后上述真实运行通过，未修改系统 Java 设置。当前 QA binary SHA-256 为 `045652eebbf7d7c4b7518ccfe8373447282d7ac89eb4dd6502c5b983721af0bf`，product source SHA-256 为 `da3ab3584e1d7a5c5a523b9300807ad974183700fed628a4dc19b667216cf2b1`。动态 capability 的决定性证据是 Rust 定向测试，JDT LS 原生用例证明兼容与接受链路，不外推为其他真实 server 的动态注册实采。

macOS/WKWebView、Linux/WebKitGTK 本次仍未运行，沿用上述三端复测方案；没有改动平台相关实现。
