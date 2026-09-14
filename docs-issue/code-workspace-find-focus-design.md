# REQ-01：Find 焦点重入与同一编辑上下文恢复修复设计

## 1. 接续身份与结论

工作包 `WP-FIND-FOCUS-01`；范围仅 F0 example 正文获焦 → Ctrl/Cmd+F → tree → Enter/Shift+Enter → Esc → repeat。稳定场景为 `CW-SEARCH-001`、`CW-SHELL-002`；`CW-NAV-002` 的 modifier-hover、`CW-TAB-002` 多 view，以及 clipboard focus owner 是受影响保留消费者，不扩为这些场景的完整对齐。

需求：[REQ-01-F/I/V/R](../docs-feature/code-workspace-idea-parity/overall-audit-plan-20260913.md#req-01)。设计可实施，产品尚未改动或验证；开发状态唯一来源为 [任务板](../claudedocs/code-workspace-idea-parity-backlog-find-focus.md)。本轮没有领取、修改旧卡状态、产品/测试/构建、提交、推送或启动 P2。

接手时间 2026-09-14，分支 `docs/code-workspace-idea-audit-20260913`，HEAD `884d003846a8549cc3125090eaf55359bc676a3f`，接手 `git status --short` 为空。输入 P0 基线 `main / 27f99b6116f4f6aae906d324cb84e8359695e17a` 后的十份评估材料已被提交，`git diff --stat 27f99b6 HEAD` 为十文档 / 2521 additions；没有生产差异。未回退、覆盖或搬迁这些成果。P1 新增/更新的文档见 [证据身份](../docs-feature/code-workspace-idea-parity/evidence/find-focus-plan-20260914.json)，下游须重新记录实际 HEAD/diff。

确认事实：P0 browser B08/B18 均报 `Calls to EditorView.update are not allowed while an update is in progress`，Find 仍显示且 tree 两匹配；没有正文丢失、native 退化或全部 editor 失效证据。本次静态链支持同步 select/blur/dispatch 重入机制；原触发环境的机制回归测试仍须 P2 建立，不能把源码审查写成测试通过。

目标 IDEA：Ultimate 2026.2.2 / `IU-262.10315.125`；[REF-FIND-FOCUS-20260914](../docs-feature/code-workspace-idea-parity/references/find-focus-2026.2.2.md) 有独占时段两轮关键状态。不是旧 tree 参照，也不是目标源码推断。IDEA 实测输入 tree 自动选第一处、Enter 到第二处、Shift+Enter 回第一处，Esc 保留当前匹配 selection 并回正文。**“同一编辑上下文”指同 workspace/file/view 和导航后的合法 caret/selection，不是无条件还原打开前位置。**

## 2. 查重与后续修订

通过 `rg` 发现全部 `claudedocs/*backlog*.md`，解析 ide-task JSON 后按 id、finding、spec、evidence 中 focus/hover/重入/相关符号核对；另检索 docs-feature、docs-issue 与 specs 的实际 caller。以下是与本因果链有关的命中；未按日期或 done 数挑板。

| 任务板与卡 | 查得状态 / 有效合同 | 本包关系 |
|---|---|---|
| `claudedocs/code-workspace-idea-parity-backlog.md` ED-FIND-001/002 | done；search-and-navigation.md：preserve case / regex groups / selection / syntax filters / undo | 保留规则，不含正文获焦后的 mount 重入；spec 旧 Audit=implemented 不是当前状态 |
| 同板 ED-MULTIVIEW-001/002/003 | done；tabs-and-multiview.md：shared document/history、独立 view | 保留；不重开 |
| `...backlog-2026-09-audit.md` ED-AUDIT-007 | done；lspHyperlink.test.ts 注释/历史修复为 docChanged + Ctrl+Z 在 update 内 refresh 重入 | 同符号另一触发：已有 queueMicrotask 防护只在 update，不覆盖 onBlur/clearMod；保留原回归 |
| `...backlog-2026-09-main-review.md` ED-MAIN-007；`...backlog-2026-09-main-repair.md` ED-REPAIR-008 | 均 done；[main review](../claudedocs/code-workspace-idea-specs/idea-2026-main-review.md#ed-main-007) → [repair](../claudedocs/code-workspace-idea-specs/idea-2026-main-repair.md#ed-repair-008)：clipboard owner 失效不可逆 | Find 获焦必须继续使旧 paste/cut 失效；返回 editor 不得复活旧请求 |
| `...backlog-2026-09-b-review.md` ED-IMPROVE-007/008；`...backlog-2026-09-main-repair.md` ED-REPAIR-007/009 | done；[view snapshot](../claudedocs/code-workspace-idea-specs/idea-2026-b-review.md#ed-improve-007)、[IME](../claudedocs/code-workspace-idea-specs/idea-2026-b-review.md#ed-improve-008)、[snapshot identity 修订](../claudedocs/code-workspace-idea-specs/idea-2026-main-repair.md#ed-repair-009) | 不把旧 snapshot hash、IME/history 边界改回旧版本；保留关键消费者验证 |
| `...backlog-2026-09-main-repair.md` ED-REPAIR-005；原板 ED-FIND-003/004；b-review ED-IMPROVE-004/005 | done；项目替换 preimage、迟到 preview、UTF-16 | 是项目搜索/写入，不是本地 Find；不吸收其工作，也不把旧未接线描述当当前缺陷 |
| tree-e2e 板 ED-TREE-001 | done；有限 tree 合同 | 仅复用 F0 到达步骤；原视觉/Enter 豁免不扩到 Find |

结论：没有发现已 author 的本次 Find mount/blur 修复卡；新增 `ED-FINDFOCUS-001`，保持历史卡 owner/status/evidence 原样。旧全局 gate 红色文字只是历史背景；不推定当前构建红/绿。

## 3. 生产入口、效果链和根因边界

所有行号为本次定位提示，P2 按符号重查。W 指 `src/components/editor/workspace/`。

| 文件 / 符号 | 当前源码事实及用户观察点 | 拟议责任 |
|---|---|---|
| W/workspaceCodeMirrorKeymap.ts `editor.find`（467）、`runViaHandlers`；Host action registration | 生产 action → handlers.runEditorCommand → CM openSearchPanel；fallback searchKeymap 仅无 host 路径 | caller 保留；不新增第二个全局快捷键 owner |
| W/CodeMirrorHost.tsx search extension（2838）、lspNavigationExtensions（1930） | 同一真实 EditorView 安装 search({top:true,createPanel}) 和 hyperlink；传 onDefinition，**没有传 probeDefinition** | 必要 lifecycle 接线；不为潜在 probe 新建 provider 链 |
| W/editorSearchPanel.ts `WorkspaceSearchPanel.mount`（414） | 实际 `this.searchField.select()`，浏览器隐式 focus 导致正文 blur；面板构造始终 Find+Replace 两行；commit 仅 setSearchQuery；Enter/Shift+Enter 调 findNext/Previous；Esc 调 closeSearchPanel | 避免 mount/update 同步焦点副作用；Find 默认一行；按参照自动选首匹配，保留输入焦点、query 规则及 Replace 可达 |
| W/lspHyperlink.ts `onKeyDown`、`onBlur`、`clearMod`（157）、update、destroy | window capture keydown 将 modifier 置真；blur 同步 dispatch 两个 effects；update(docChanged) 已 microtask refresh；destroy 释放事件和 timer | blur/key-up/window blur 清理在安全调度点发布，清理幂等、代际失效、销毁不调度，保留 hover 和导航 |
| `node_modules/@codemirror/search/dist/index.js` open/closeSearchPanel（1001） | open dispatch 安装 panel；重开已有 panel 会 focus/select；close 在焦点属于 panel 时 view.focus，再 togglePanel(false)；不会恢复最初选区 | 库源码解释隐藏时序，不是 IDEA 参照；不能仅改自定义 mount 就忽略其他 focus 调用 |
| W/EditorGroup.tsx 两个 CodeMirrorHost caller（883/972） | activeFile/onDefinition 闭包；每个 viewId/leaf 的选择独立，同 doc 正文和历史共享 | 两种渲染分支均在保留覆盖；默认只读审查，不扩生产改动 |
| `src/components/editor/CodeWorkspaceTab.tsx::goToDefinition`（15854） | semanticQueryHost.executeEnvelope → lib/editor/lsp.ts::lspDefinition → cancellable `lsp_definition` → Rust lsp.rs::lsp_location_request(textDocument/definition)，lib.rs 注册；stale/cancelled 返回 false，error/unavailable 状态文案，current 后 navigateLocations/openLspLocation/history | 保留生产 hook，Ctrl/Cmd-click 对正确文件/position 导航；F0 无 provider，不声称 F0 证明该路径 |
| Host transaction owner / clipboard owner / view snapshot | 编辑变化走 workspaceDocumentTransactionOwner；undo/redo 共享；readOnly/IME/focus generation 守卫；unmount 尾部 capture 后 detach/destroy | focus/query/decorations 不生成正文 changes、编辑 history 或落盘；不改 schema/store/IPC |

因果链：正文真实获焦 → 持有 Ctrl 的 Find chord → window capture modifier=true → openSearchPanel dispatch 正在更新 plugins → panel.mount.select() 导致正文 blur → clearMod dispatch → CM 拒绝嵌套 update。支持：B08/B18 完整堆栈与本次同内容源文件 hash。反证边界：不是 query 算法失败，因为仍有两个匹配；React StrictMode 是复现环境，不能据此声称只在 StrictMode 发生；native 是否复现未知。

P0 原件：`qa-ui-auto-report/overall-audit-20260913/browser/{08-editor-find.png,09-find-results.png,18-find-repro.png,console.log,actions.json,snapshots/}`，及该 run 的 artifact-manifest.json。console 行 21–31 / 33–43 保留。P1 核对选中原件和生产源共 20 条含 fixture 记录，所比 P0 hash 无不符；这是材料校验，不是新运行。没有原始 YAML summary/receipt，因为 B08/B18 是 CLI 实操探索；不得伪造 receipt。

## 4. 决策与 UI/状态合同

| DEC | 选择及影响 | 结论 / 来源 | AC/V |
|---|---|---|---|
| DEC-FF-01 | A：只延迟 mount select；B：panel focus 与 hyperlink 清理各自遵守安全时序；C：吞异常/禁用 hover/删除自动 focus | 推荐 B，agent 自决：A 不覆盖其他同步 blur，C 违反用户约束；保留现有 CM 内核和公开 API，不读取 CM 私有 updateState | A1/A4/A6，V1/V2 |
| DEC-FF-02 | Esc 恢复打开前 caret，或保留当前匹配 selection | 后者，用户已定（2026-09-14：“按图稿与实测参照继续”）；沿用原参照 23–33 的依据及图稿 v1。无导航/空 query 时保持未被搜索改变的合法选区 | A2，V1/V3/V5 |
| DEC-FF-03 | 永久两行，或默认 Find 一行且 Replace 通过展开和原动作可达 | 后者，用户已定（2026-09-14：“按图稿与实测参照继续”）；沿用实测结构与图稿 v1，不削减 regex/selection/context/preserve-case/replace-all undo。未采 Replace 几何不承诺 matched | A3/A5，V2/V3/V5 |
| DEC-FF-04 | 全局皮肤替换，或只在本 pane 查找区域按匹配环境定尺寸 | 局部方案，agent 自决；全局 theme/font 与插件生态不入包。目标尺寸来自参照，P2 实际匹配后记录容差，不编造固定相似率 | A3，V5 |

图稿 v1：[预览](find-focus/find-focus-v1.png) / [可编辑 draw.io](find-focus/find-focus-v1.drawio)。已在本轮聊天展示并邀请结构/恢复意见；用户于 2026-09-14 答复“按图稿与实测参照继续”，采纳并维持 v1 的单行 Find、Replace 可展开及 Esc 保留当前匹配选区。DEC-FF-02/03 更新为用户已定，相关 A2/A3/A5 与 V 保持一致，无需修订图稿；该反馈确认规划目标，不授权本轮实施或自动启动 P2。图中标注不是拟上屏产品文案。当前环境未找到 draw.io Desktop CLI，预览由同一组节点用 Pillow 渲染、已目视检查；不是 draw.io 导出或产品截图。本修复只恢复/对齐本场景，不另立新增能力目标，故不启动 feature-design 新功能流程。

### 有意变化

1. Ctrl/Cmd+F 不再触发嵌套更新；Find 输入自动获焦并选中可复用 query。重新打开同 query 保持可输入。
2. 在空选区的 F0 1:1 输入 tree，自动选择 `[8,12)`，计数 `1/2`；Enter `[53,57)`/`2/2`，Shift+Enter `[8,12)`/`1/2`。输入框仍持焦；Esc 回同 view，selection 保留当前匹配。多选区/selection scope 不用 F0 简单规则覆盖旧合同。
3. Find 默认仅一行，位于本 pane tabs 下、正文上；默认不展示 Replace row。展开入口及原 `editor.replace` / Ctrl/Cmd+R 继续打开 Replace 并 focus 对应输入，所有旧能力有键盘可达入口。普通关闭不提交替换、不清空正文。

### 状态与生命周期

| 状态 / 事件 | 必须行为 | 取消、失败、迟到与恢复 |
|---|---|---|
| Closed → Opening | panel 实例绑定创建它的 EditorView；同步构建 DOM、读 query，不在 mount/update 内 focus 或 dispatch | 将焦点请求排到本轮更新结束；只允许一个 current 请求 |
| Opening → OpenFind | 原 panel 已连接、view 未销毁、请求 token current 且 owner 仍合法才 focus/select | Esc、切 leaf/workspace、外部 surface 取焦或销毁使请求失效；不得因以后回 A 而复活旧请求 |
| OpenFind / 输入 | SearchQuery 仍为 CM 权威状态；保留 case/word/regex、selection/context 的规则；query 改变后根据新合法范围选首匹配 | 空 query=0；无结果=0、不跳走/改正文；invalid regex 显式 Invalid pattern，不导航、不替换，改为合法 query 可恢复 |
| Enter / Shift+Enter | 本 panel 消费，导航同 view 的当前匹配，保持 query focus；两匹配按实测顺序 | 不穿透为正文换行；composition 中 Enter/Esc 不被 panel 当导航/关闭，先由输入法处理 |
| Esc / close | 若 panel 持焦，回原有效 view 当前 selection；关闭释放空间；重复关闭幂等 | 不全局 querySelector 选择第一个 editor；若 owner 已离开或 view 销毁，只关闭/取消本请求，不抢焦点 |
| OpenReplace | 原动作/展开打开 Replace row；沿用当前 query/replace/options 与原替换事务 | 替换成功走已有共享 undo；readOnly 可查找导航，禁止写入，禁用态可解释；关闭零额外替换 |
| modifier key-up / blur / window blur | 立即撤销逻辑 held、失效旧 probe/token/timer，取消指针角色；effect 在更新结束发布 | 安全队列只读最新意图，旧 clear 不能清掉更晚的合法 Ctrl-hover；重复 blur/keyup 合并；不靠异常捕获当正常控制流 |
| docChanged while hover | 保留现有 deferred refresh，在新 doc 上重算范围 | 同时发生 blur/destroy 时旧 refresh 无效果；不能把既有 Ctrl+Z 修复撤回 |
| destroy / remount | 标记 destroyed、递增 generation、清 timer/取消 pending focus & effects、移除 listener；StrictMode 第二实例独立 | 不对旧 view dispatch/focus，不引用可变全局“当前 view”作为旧 callback 目标，不泄漏 listener |

实现建议：panel 的 pending focus 用实例 generation + connected/liveness + 已有 owner/焦点授权检查，不只用 `isConnected`（两个 pane 均可见）。必要时从 Host 注入窄的 current-owner predicate；优先复用已有 live isActive/workspace/view 身份，不能新建竞争全局 store。局部 helper 可以新增在 W/，由本卡持有并测取消/reorder；不固定必须新增文件。改变焦点时序仍须让真实 blur/focusin 进入 clipboard owner generation，不用 stopPropagation 隐藏 owner 转移。

hyperlink 清理同步更新逻辑意图，microtask 中检查 generation/destroyed 并发布最终 effects；调用早晚顺序由测试明确。不要仅把所有 dispatch 一律 setTimeout：会造成 hover 延迟、旧清理覆盖新状态。`probeDefinition` 当前没有生产 caller，接口保持可选；若触碰其结算，false 清 link、reject 与 cancelled/stale/销毁保持独立处理，不能未处理拒绝或在销毁后 dispatch；不新增真实 probe API。定义请求失败继续原生产状态提示，正常 retry 可导航，失败/cancel/stale 不写 navigation history。本包没有本地 search provider loading；不伪造 spinner、server error 或 unknown disk effect。

## 5. 唯一任务、稳定 AC 与保留断言

<a id="ed-findfocus-001"></a>
### ED-FINDFOCUS-001 — Find 打开、导航、返回与 modifier 生命周期

TASK-FF-01 对应本卡，依赖 `[]`。历史 done 是有效保留合同来源，不跨板建虚假依赖。owner 尚未领取；P2 领取后负责实现、组合回归、Windows native 与参照自验。规格覆盖全部 `REQ-01-F/I/V/R`，不宣布 CW-SEARCH-001 的全部替换功能或 CW-SHELL-002 的所有 popup 已对齐。

| 完整 AC ID | 总需求 | 可观察断言 | 对应 V |
|---|---|---|---|
| ED-FINDFOCUS-001-A1 | REQ-01-F/I | F0 正文真实获焦后 Ctrl/Cmd+F 自动输入；两轮包括 split remount 无 uncaught/reentrant/plugin-crashed；正文 71 字节 hash 不变、query tree 两匹配 | V-FF-01/03/04 |
| ED-FINDFOCUS-001-A2 | REQ-01-I | 1:1、空 selection 的 tree 查询自动选第一处，Enter 到第二处、Shift+Enter 回第一处；Esc 回同 workspace/file/view 且保留导航后的 4 字符 selection；无导航且空 query 保留合法原选区；repeat 有相同结果 | V-FF-01/03/04/05 |
| ED-FINDFOCUS-001-A3 | REQ-01-V/I | Find 默认一行、正确 pane 锚点、空间归还、输入 focus、当前/其他匹配角色、计数/导航/关闭/溢出键盘可达；匹配 REF 设置和 pane 几何后逐项测量，记录原始值/容差理由/实际差；无未接受的本场景差异 | V-FF-03/04/05 |
| ED-FINDFOCUS-001-A4 | REQ-01-R | Ctrl/Cmd-hover 下划线/指针及 modifier release、blur/window blur 清理仍正常；Ctrl/Cmd-click 正确 production definition hook/真实 provider reveal 与 back；Ctrl+Z hover docChanged 不 crash；不存在旧任务清掉新 hover 或重建销毁实例 | V-FF-02/04 |
| ED-FINDFOCUS-001-A5 | REQ-01-F/R | query 的 literal/case/word/regex、selection/context 规则不变；invalid/zero 恢复可输入；Replace 仍可达，preserve case、regex groups、replace-all 一次 shared undo；只读 Find 可用且替换零变化；Find 查询/导航/关闭不消耗 edit undo | V-FF-02/03/04 |
| ED-FINDFOCUS-001-A6 | REQ-01-I/R | 同文档两 view 的 caret/selection/scroll 独立，A 打开→切 B→回 A、workspace A→B→A、关闭/同 key 重开均不被旧 focus/clear 劫持；A 搜索期间 B 编辑同步正文，一次共享 undo 仍正确；非最后 view 关闭不丢 dirty；dirty close Cancel 保留；切文件/恢复不改 snapshot identity | V-FF-01/02/03/04 |
| ED-FINDFOCUS-001-A7 | REQ-01-R | 真 IME 确认/取消优先；Find 与正文候选期间 Enter/Esc 不抢命令；确认一次 undo、取消不吃旧 undo；pending paste 在 editor→Find→editor 后永久失效，正常新 paste/menu owner 仍可用；既有 performed/unknown OS 元数据不伪造零效果 | V-FF-02/04 |

Required evidence（与板一致）：`code-audit`, `unit`, `typecheck`, `browser`, `native`, `provider`, `accessibility`, `idea-comparison`, `qa-lint`。它们不要求九次运行：同一次合格 Windows native 可分别覆盖 focus、provider、IME、数据和视觉观察。`qa-lint` 仅因为新增本场景 YAML/catalog 映射，不证明功能；不要求无关 performance/release 全套。

文件 owner：W/editorSearchPanel.ts、W/lspHyperlink.ts、必要 W/CodeMirrorHost.tsx 及这些文件的同名 tests；拟新增 `W/CodeMirrorHost.findFocus.test.tsx` 用于真正的焦点/StrictMode/多 view 组合回归。W/workspaceCodeMirrorKeymap.ts 只有 Replace mode/窄接口接线证明必要时扩入，必须保留 hosted/fallback；EditorGroup/CodeWorkspaceTab/公共 popup/ActionHost 默认只读消费者，只有真实 caller 证明缺少 owner 信息才扩大并在卡/spec 记录理由及消费者回归。禁止改 document owner/store/schema/IPC/provider 来绕过局部问题；发现必要改动需先说明因果及兼容影响，不擅自吸收无关工作。

## 6. 最小充分验证（全部产品检查待 P2 执行）

| V | 层级、精确路径/ID | 输入和关键断言 | 改前 / 改后 |
|---|---|---|---|
| V-FF-01 | 新 `src/components/editor/workspace/CodeMirrorHost.findFocus.test.tsx`，真实 CM panel + hyperlink，挂载 StrictMode；可 mock 外部 provider，不 mock focus/dispatch/route | 先 content.focus + 真实 focus/blur，再 Ctrl-down/F chord，tree/nav/Esc/repeat；监听 window error 与 CM plugin-crashed，并断言 query、正文、focus、ranges；快速关闭/销毁/remount、两 view、owner 转移后 microtask flush | 原触发应 red；P0 B08/B18 可复用但不能代替精确 red；当前未跑 |
| V-FF-02 | 现有 `lspHyperlink.test.ts`、`editorSearchPanel.test.ts`；Host.test.tsx 的 search / shared document / clipboard owner / ED-REPAIR-008；Host.ime.test.tsx 与 document owner 对应断言（先核对实际文件） | 增加 blur/key-up/new-hover 顺序、destroy-before-flush；保留现有 Ctrl+Z 测试；query/filter/preserve-case/regex/once undo；真实 owner 布局与 clipboard 请求取消；synthetic composition 仅证明门控 | 高风险正常路径先在改前跑；历史 done/test 存在不算本次通过；未知基线保持未知 |
| V-FF-03 | 新 YAML `qa-ui-auto-tests/cases/TC-IDE-FINDFOCUS-01.testcase.yaml`，拟定实际 id `TC-IDE-FINDFOCUS-01`；开发时 author，现不存在 | 生产 UI 开 F0、明确点击 .cm-content 后 Ctrl+F、tree、Enter/Shift+Enter/Esc 两次；两 pane 不串焦点/正文；零结果/invalid/重新输入、dirty Cancel；收集 console/error 和 selection 读数（只读 observation） | 复用 B08/B18 失败原件；候选 browser 待执行，不能重写原 report |
| V-FF-04 | Windows 同源隔离 `com.taomni.app.qa` / WebView2；F0 + 最小真实语义 fixture；可用当前 runner 组合本卡新 case，OS IME/hover 不支持时人工明确记录 | Ctrl+F 物理键 focus/navigation/Esc/repeat；Microsoft Pinyin 在 Find 和正文各一次 confirm/cancel；Ctrl-hover→click→definition→Back→modifier release→Find；save/dirty cancel/undo/关闭非最后 view、恢复；断言 buffer + 文件 hash 和 history | Windows native 当前无证据，binary P0 missing；P1 没构建。P2 稳定代码后先 --check、必要一次 build，尽量一批采集 |
| V-FF-05 | 双侧人工几何/交互表，链接 REF 23–33、56–58 与 V3/V4 原图；正式记录时用既有 compare_idea.py/schema | 同 fixture/action/pane 宽/字体/theme/zoom；测 panel anchor/height/input/密度/焦点和选中角色；分列功能/视觉/交互。匹配环境后才定具体允许差；没有条件就 A3 证据阻塞 | IDEA 参照已采，Taomni candidate 全未执行；validator exit 0 不等于 matched，正式匹配必须 --require-match + 真实审阅 |
| V-FF-06 | 单次 union scoped typecheck；若 YAML/controls 更新则一次 `python -m qa_ui_auto.audit --gate` | 全部最终 owned TS/test 路径一起 typecheck；维护 F25.1/F25.5 的 covers/controls/testids 与新 case，静态 lint通过 | 仅计划；禁止以缩小 scope/删除断言消除错误 |

已核对的运行入口（仓库根 PowerShell，**P1 未执行**）：

```powershell
# P2 新文件创建后，先原实现 red，再候选 green；记录实际选中数。
pnpm exec vitest run src/components/editor/workspace/CodeMirrorHost.findFocus.test.tsx
pnpm exec vitest run src/components/editor/workspace/lspHyperlink.test.ts src/components/editor/workspace/editorSearchPanel.test.ts
# Host 大文件按所选真实测试名称过滤，一次覆盖 search/shared-owner/clipboard 所需子集。
# 后续新 YAML author 完成才可运行 TC-IDE-FINDFOCUS-01；配置是 localhost:5000 的 browser/stubs。
$env:PYTHONPATH = '.agents/skills/qa-ui-auto/scripts'
python -m qa_ui_auto run --mode browser --config .agents/skills/qa-ui-auto/assets/qa-ui-auto.config.browser.yaml --filter TC-IDE-FINDFOCUS-01 --require-pass
python .agents/skills/qa-ui-auto/scripts/native_build.py --check
# 原生构建/运行前先读 qa-ui-auto/references/native-testing.md；不得借个人 Taomni 实例作 QA。
```

P1 只读 QA plan 的准确命令/结果落入 P1 provenance。现有 `TC-IDE-C4-02` 实际主要证明 split/reopen，不能代替 A6 的 shared undo/caret；`TC-IDE-C6-05-query-definition-reveal-history-native` 用 Linux native_keys/F12/JDT LS，不能直接证明 Windows hover-click；`TC-IDE-IMPROVE-008-ime-lifecycle-native` 限 Linux fcitx5，不能作为 Windows Microsoft Pinyin 通过。保留其断言并为当前端采用受支持的人工/runner 传输；不机械跑三份旧 case 后称充分。项目 search/SSR/Git/Debug 与性能基准不在本改动因果链，无需运行。

三端计划：Windows/WebView2 为本次 P2 desktop 收尾端，实际记录物理键、焦点、IME、provider 版本；macOS/WKWebView 使用 Cmd+F、Cmd-hover/定义、系统拼音及原生可用手工自动化；Linux/WebKitGTK 使用 Ctrl+F、Ctrl-hover、fcitx5，复用其支持的 native cases。三端代码兼容必须审查，当前端必要证据完成可满足本次交付；另外两端未实测必须写未验证，不能因为缺设备静默移出产品范围。

## 7. 依赖、交付上限与恢复

局部方案已有可用 IDEA 目标，无新的实质取舍阻塞领取。P2 第一动作是重新核对 board/HEAD/diff/reference 原件和实际 caller，再领取 **这一张卡**；不启动整体 P0，不重开任何 done。修改前先建立 V1 red 和 V2 高风险保留基线，再按 panel/hyperlink 边界切换，最后验证组合代码，不能把各分支孤立通过当集成。

尚未执行的验证不阻止定义明确的卡 ready，但不能让 done：A3 需要匹配 Taomni candidate 环境的实际测量；A4 真实 provider；A7 当前端真实 IME 与 clipboard owner；A1/A2/A6 当前 WebView。原件缺失、当前端桌面/依赖缺失时记录具体 evidence blocker；若有本卡引入退化则继续修复，不能仅以 implemented 掩盖。外部资源：可控 Windows 桌面、必要 QA 构建工具、匹配 fonts、真实 provider（优先已存在隔离 Java sample + JDK/JDT LS）。不要求 F0 配 SDK，不把调试器/无限插件生态加入。

无 schema/data migration；回滚只撤本卡的局部代码改动与对应新 UI 状态，不清理用户数据、替换共享 doc、重建 undo、丢弃 dirty 或强退项目。focus 任务取消零正文效果，搜索状态仍由原 view CM owner 管理；已发生 save/clipboard 系统效果继续由原有 typed result 通道记录。

本包不改变 repository-wide build gate 分工：遵从 shared-contracts，明确集成卡 owner 为旧板 `claudedocs/code-workspace-idea-parity-backlog.md::ED-GATE-003`（只作门禁责任引用，不重领/重开）；本卡持有 scoped typecheck 和当前端 QA 运行。为获取 native binary 所需的构建由本卡 P2 执行一次/同输入复用，不因此复制新的全量 build/release 卡或要求旧 gate 重新执行。

实际 P1 收尾只允许：文档/链接/JSON/hash/图稿/板结构检查、准确板 validate/list、QA 只读 plan/status、IDEA 参照。产品测试 0、browser/native runner 0、Taomni 启动 0、产品 build 0、正式 comparator 0。IDEA 原图成功、图稿成功和任务板 validate 均不算产品验收。
