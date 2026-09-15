# ED-PARITY-001：Find 后真实定义导航与可访问性补证设计

<a id="ed-parity-001"></a>

## 1. 本包身份与交付边界

唯一任务：[backlog.md / ED-PARITY-001](backlog.md#ed-parity-001-find-已实现后的-provider-与可访问性证据接续)。来源：[REQ-01](overall-audit-plan-20260913.md#req-01) / [CW-SEARCH-001](capability-matrix.md#cw-search-001)、[CW-SHELL-002](capability-matrix.md#cw-shell-002)、[CW-NAV-002](capability-matrix.md#cw-nav-002)。回链：[P0 规格起点](task-planning.md#ed-parity-001)。没有重跑 P0 或接管旧卡。

2026-09-15 P1 源码基线：分支 `docs/code-workspace-idea-audit-20260913`，HEAD `05156e0f3b5e3e7702fa5092f9c4d41eafdd1c59`，接手工作区干净。完成文档/源码审查、QA 只读 plan/status，并在用户两次授权时段采集 IDEA 参照；所有 Taomni 产品执行仍未执行。文档细化不代表功能、UI 或交互已对齐。

可演示用户结果：用户在 Java 文件中打开 Find、导航匹配并 Esc 返回当前匹配选区，随后通过 modifier-hover/click 跳到真实定义，Back 返回发起位置；全过程焦点、查询、正文和历史互不污染。键盘、可访问名称/状态、缩放和 IME 有当前端的独立观察。F0 是既有 Find 行为的保留检查；F2 是本次缺少的真实 provider 序列。

这是补证包，复用[已交付修复设计](../../docs-issue/code-workspace-find-focus-design.md)的有效行为合同及[现有图稿](../../docs-issue/find-focus/find-focus-v1.png)，不重新设计等价界面，不新增能力或登记未经证实的 bug。新卡自己的 DEC/AC/V 见下文。**P1 已完成，当前 ready / planning_required=false**，参照与用户决定见 §8；不存在开发 owner、claimed_at、baseline 或产品 PASS。P2 完整交接见 [handoff-p2-ed-parity-001.md](handoff-p2-ed-parity-001.md)。

## 2. 当前事实与证据分类

| 分类 | 本次结论 | 依据与限制 |
|---|---|---|
| 已有实现 | panel 的 generation/owner 守卫延迟 focus；hyperlink 立即撤销逻辑 modifier、microtask 发布清理，销毁与更新有代际守卫 | 当前 `editorSearchPanel.ts`、`lspHyperlink.ts`；不再规划旧 mount/blur 重入修复 |
| 历史观测 | 2026-09-14 Windows P3 记录 native、真实键盘/Pinyin、200% zoom/ARIA；真实 JDT LS 与屏幕阅读器未执行 | [历史卡 metadata](../../claudedocs/code-workspace-idea-parity-backlog-find-focus.md)，HEAD `c7e90f5db2bad9a11321018426a0478d19299f91`；失败与后续通过原样保留，不移植到新卡 |
| 当前证据缺口 | Linux Find case 无执行；C6-05 native 历史报告 stale | 本轮 QA status：runner/source/config/native build source 均变化；`ok=false`，进程 exit 0 不是通过 |
| 源码身份差异 | 旧 P3 HEAD 到当前，panel/hyperlink/query host/LSP TS/Rust 所查文件无 diff；Host、Group、Tab 有后续修改 | 三文件合计 451 additions / 47 deletions；须复核最终组合，不能靠局部相同宣称旧 native 仍 current |
| 本轮 IDEA 参照 | Windows旧zip仍缺；新 REF-PARITY-001-LINUX-20260915 已取得 F0 Find、F2 两轮定义/Back、r2 hover/release/Find 的真实原件 | [实际动作与边界](references/ed-parity-001-reference.md#observed)；不替代任何 Taomni 产品执行 |
| 可访问性范围 | 原 A3 含溢出键盘可达，A7 含 IME/clipboard，未明文要求屏幕阅读器播报；旧 P3 把播报列 unrun | 按原 AC 收敛 keyboard/focus/name-role-state/zoom/IME；播报保留未验证边界，不新增豁免或删除 `accessibility` kind。用户明确“沿用原 AC；播报保留未验证边界”，只确定范围，不是播报通过 |
| 已确认新缺陷 / 能力缺失 | 无 | 本轮未执行 Taomni，没有新的运行反例；F0 无 provider 是 fixture 边界 |
| 待归因风险 | provider 请求后的状态提示、旧结果对前台 view 的影响、200% 溢出控件可达性仍需观察 | 旧 P3 曾记尾部溢出；不能因此直接宣布本机退化或接受全部溢出差异 |

F0 的正确第二匹配是 `[54,58)`，第一处 `[8,12)`；71 字节 hash 为 `bbbab91a4e4ea594b1e2207721999dc375ac98c30c5960cfbbf1329a441aa01a`。旧参照/设计中的 `[53,57)` 是旧文字误差，后续 P3 和现行 YAML 已更正；保持旧文档日期，本卡以实际字节为准。

## 3. 生产责任与接口

以下路径均相对仓库；“责任”是未来 P2 本卡责任边界，不是任务板开发 owner。默认仅审查/补证，产品改动必须有范围内反例与相应修复设计。

| 文件 / 符号 | 生产效果链、用户观察点与本卡责任 |
|---|---|
| `src/components/editor/workspace/workspaceCodeMirrorKeymap.ts` / `editor.find`、`editor.replace`；`CodeMirrorHost.tsx` / command handlers、search extension | 动作到 CM panel；Find/Replace/输入框命令路由保留，不能用直接调用 helper 替代真实按键。Host 将 visible/active 与 clipboard generation 注入 panel focus owner |
| `src/components/editor/workspace/editorSearchPanel.ts` / `WorkspaceSearchPanel`、`requestFocus`、`selectInitialMatch`、`onKeyDown` | SearchQuery/当前 view 为查询权威；默认一行、Replace 可展开、aria-live polite；owner/实例失效后不抢焦。composition 优先，查找不生成正文 edits |
| `src/components/editor/workspace/lspHyperlink.ts` / `clearMod`、`refreshAt`、`goToAt` | modifier + identifier 范围产生 link/pointer；点击调用 onDefinition。生产 Host 未提供可选 probeDefinition；下划线不是 provider 已证实有定义，不新增 probe API |
| `src/components/editor/workspace/CodeMirrorHost.tsx` / `lspNavigationExtensions`；`EditorGroup.tsx` 两个 Host caller | 最新 definitionRef → activeFile 闭包；多 leaf 同文档正文/history 共享、view selection 独立；两种 Host 渲染分支均核对 |
| `src/components/editor/CodeWorkspaceTab.tsx` / `beginSemanticQuery`、`goToDefinition`、`navigateLocations`、`openLspLocation` | 捕获 workspace/file/URI/revision/session/project/request 身份；单结果先 open/reveal，成功后写 origin/target history；无结果/失败不能伪造成功，Back 观察源文件和 position |
| `src/components/editor/workspace/workspaceSemanticQueryHost.ts` / `executeEnvelope`、`cancelWorkspace` | 同 kind 新请求 abort 旧请求；fetch 前后和 delivery guards；success/cancelled/stale/unavailable/error 区分。workspace 销毁取消；不把普通 Find Esc 解释为取消一个已派发的语义请求 |
| `src/lib/editor/lsp.ts` / `lspDefinition`、`invokeCancellable`；`src-tauri/src/lsp.rs` / `lsp_definition`、`lsp_location_request`；`src-tauri/src/lib.rs` 注册 | `LspDocumentDescriptor + LspPosition + signal/cancelKey/requestSeq` → Tauri → active session → `textDocument/definition` → `LspLocationsResult`；无 session 返回状态和空结果，request error 抛回；取消 token 清理。Rust 默认只读 |
| `workspaceDocumentTransactionOwner.ts`、Host clipboard generation、Tab 保存/导航消费者 | Replace/undo 共用历史；查找/hover/导航不能清 dirty、写磁盘或消耗 edit undo。editor→Find→editor 永久失效旧 paste，新 paste 仍可用；既有 OS performed/unknown 元数据不伪造零效果 |

共享消费者以 declaration/typeDefinition/implementation/peek、两个 Host、共享文档、clipboard、保存与导航 Back 为边界；本卡不扩成这些能力全量评估。没有新 store/schema/IPC、迁移或 provider 实现；既有序列化文档、view snapshot 和快捷键平台策略保留。

异步语义：panel request generation 与 focus owner 都匹配才 focus；modifier 清理先撤销意图，queued clear 不覆盖后来合法 hover；destroy 后不 dispatch。定义请求被新请求替代、doc/session/project identity 变化或 workspace 销毁时，不提交旧 reveal/history；需观察原始 provider 请求仍可能已经执行（只读语义查询），不能把 UI 忽略等同服务器从未收到。`openLspLocation` 在文件 read 前后检查 current，读失败的 error buffer 不形成成功 history。已经成功 reveal 的历史不因随后 Esc/blur 回滚；Back 是导航恢复，Ctrl+Z 是编辑撤销。

待证边界：`beginSemanticQuery.isCurrent` 不以普通 pane 焦点变化作为失效条件；不得凭期望写出“切 pane 必然 cancel”。本卡要求旧 panel focus 不抢 B，以及真正失效请求不污染新 workspace/doc；若实测发现普通切 pane 的语义返回影响用户目标，先归因并保留反例，必要目标扩展交回 P0，不悄悄新增焦点取消功能。

## 4. 本卡决定与 UI 合同

| DEC ID | 决定 / 状态 | AC/V |
|---|---|---|
| ED-PARITY-001-DEC-01 | 以补证为首包；旧 Find 修复是现有基础。无真实反例不制造产品改动；沿用现有充分修复设计，暂不启动新增功能/bug 设计流程 | A1–A3 / V1–V5 |
| ED-PARITY-001-DEC-02 | Esc 保留导航后的当前匹配 selection；默认单行 Find、Replace 展开；复用旧用户已接受合同，不回到最初 caret | A2/A3 / V2/V4 |
| ED-PARITY-001-DEC-03 | F0 验证局部 Find；F2-NAV-001 只查一个 Helper.greet 定义和 Back，隔离无三方依赖。F12 可作诊断对照，不能代替 modifier-hover/click | A1/A2 / V1/V2 |
| ED-PARITY-001-DEC-04 | 当前端 Linux/WebKitGTK，Windows/WebView2 与 macOS/WKWebView 保持兼容并分别记录未验证。安装路径不作 IDEA 版本依据；旧 Windows JDK 11 缺口不等于 Linux 缺 JDK | A1–A3 / V1–V5 |
| ED-PARITY-001-DEC-05 | accessibility 必保留 keyboard/focus/name-role-state/zoom/IME。用户已明确沿用原 AC，screen-reader 播报保留未验证边界；不新增播报验收。既有 required_evidence 不减少 | A1/A2 / V3 |
| ED-PARITY-001-DEC-06 | 当前 Linux Find/Java 导航原件已补齐，支持规划 ready；产品仍不签 matched。只补缺失状态，沿用已核实 build/profile，不重做 P0 | A2 / V2 |

布局目标沿用原图稿：查找栏位于当前 pane tabs 下/正文上，Find 一行，Replace 初始隐藏；关闭归还空间；输入焦点、当前匹配与其他匹配有不同颜色角色，计数/前后/关闭/更多可达，展开按钮状态可读。本轮没有结构变化，无须重画等价图稿。密度、字体与具体几何已由新参照 §5 冻结（F0 Find 带约58px、输入419×43px、代码基线28px，测量误差±2px）；Windows 1400×992 外框/68px 面板不能直接转成 Linux CSS token。

100% 与 200% 下要求 Find/Replace 输入、关闭、导航和更多可键盘到达，焦点可见且内容可辨；尾部溢出不等于自动接受裁掉操作。已知 Windows 溢出说明保留，Linux 需新观察。无新弹层，更多展开不覆盖必要输入；禁用的 Replace 仍有可访问名称和状态，readonly 查找可用。只比较本包面板/选区/hover 与返回；未采的 IDEA regex 错误、IME 和只读几何记未观测，以 Taomni 保留断言验，不伪称这些状态 matched。

## 5. 连续场景与本卡验收

前置与精确字节见 [reference / F0、F2-NAV-001](references/ed-parity-001-reference.md#fixture)。场景编号是步骤，不是新任务或状态体系。

1. S0：隔离工程；F0 与 Java 文件 clean、正文获焦、Find 关闭、1:1/空选区；记录文档/磁盘 hash、view/workspace、history 起点、provider identity/readiness。Java 导入未 ready 则先完成 S4 未就绪路径，不冒充成功。
2. S1：F0 Ctrl/Cmd+F，清 query，输入 tree → 1/2、`[8,12)`；Enter → 2/2、`[54,58)`；Shift+Enter → 1/2；Esc 关闭回同 view 当前匹配 selection；再开再关一轮。query 改成不存在词/非法 regex，记录 0/Invalid pattern 与恢复；所有正文/磁盘 hash 不变。
3. S2：F2 Main.java，Find `greet`（调用与注释各一次），首匹配在真实调用；Enter 到注释、Shift+Enter 回调用、Esc。按修饰键悬停调用 token，记录 link/pointer；release 清理；再次按键点击，同真实 provider 返回的 Helper.java `greet` 声明处 reveal。通过当前 UI Back 返回 Main.java 发起调用的位置；不承诺 provider 不返回的 selection 范围，记录实际 range。重复 Find 与导航，hash/dirty 不变，无重入异常。
4. S3：hover 中打开 Find，应撤销旧 modifier 装饰；重回正文的新 hover 仍可用。A panel 打开/排队→焦点转 B→回 A，旧请求不复活；同文档两 view，B 插入一个 `x`、A 同步正文、一次 undo 恢复；关闭非最后 view 不释放文档。正常复制/新粘贴与旧 pending paste 失效分开验证。
5. S4：provider 未就绪/错误或无结果时不跳转、不新增成功 history、不改 bytes/dirty；恢复 ready 后同一个调用 retry 成功。真实请求在途时用新同类请求替代或切出并销毁测试 workspace，记录取消/迟到响应与当前 UI；未形成竞态就记“未覆盖”，不能凭等待一段时间判定通过。必要迟到确定性检查用现有 mounted guard 测试补层，不能标为真实 provider 取消 PASS。
6. S5：键盘 Tab/Shift+Tab 逐项访问 Find/展开/计数相关按钮/More/关闭，焦点可见；记录 name/role/state 与 live status；200% 重复输入/前后/Esc 和展开/关闭。真实 IME preedit Enter/Esc 先由 IME 消费，不误导航/关面板；确认后回正文仍能编辑与 undo。播报不在本包既定 AC 中且明确未验证；若用户明确要求再补步骤，未运行不写通过。
7. S6：F0 Replace all tree→branch 只有一个共享 undo，undo 恢复种子；显式 Save 后磁盘回读一致、dirty=false；另以 dirty 文档查询/关闭，保持 dirty=true；只读 Find 可用、Replace 禁用且零写入；dirty-close Cancel 保留 tab/正文/选区。保存过程中继续输入的竞争不扩入本卡，由 ED-PARITY-002 规划。

| 完整 AC | 本卡断言 | 验证映射 |
|---|---|---|
| ED-PARITY-001-A1 | S2/S4 的生产 modifier 路由、真实 JDT LS 请求/结果、正确目标 reveal 与 Back；错误/取消/失效不产生成功 history，retry 可恢复。S5 keyboard/focus/name-role-state/zoom/IME 有当前端观察，screen-reader 范围依 DEC-05，不把 DOM 属性等同播报 | V1/V3/V5 |
| ED-PARITY-001-A2 | S1/S2 具有相同 fixture、动作、IDEA build/profile 与当前 Taomni 原件；Find 单行/焦点/选区/计数/空间恢复及 modifier 导航分别给功能、UI、交互结论，记录实际值、差异与依据。缺侧、未观测、跨平台像素不匹配不能算 matched 或完成本 AC | V2，结合 V1/V3 |
| ED-PARITY-001-A3 | S1/S3/S6 保留两轮无重入、当前匹配 selection、两 view/owner、Replace 一次 shared undo、dirty/save、只读、IME、clipboard 代际和恢复；查找/hover/导航本身不写正文、不耗 edit undo，不改数据格式或已交付树/Shell 路由 | V4/V5，S5 与 V3 去重 |

## 6. 最小验证与责任

Required evidence 与新板保持一致：`document`、`code-audit`、`native`、`provider`、`accessibility`、`idea-comparison`。下列全部产品验证在 P1 未执行。单次合格 native session 可覆盖多个 V/kind，各观察点单列，不为种类重复构建。

| V ID | 最小检查、输入与归属 | 覆盖/限制 |
|---|---|---|
| ED-PARITY-001-V1 | P2 在隔离 Linux QA packaged app 手工/受支持 OS 输入执行 S2/S4，记录 provider process/version/runtime、request identity、真实 response location、reveal/Back、failed/cancelled/stale/retry；报告目录 `qa-ui-auto-report/ed-parity-001/`，手工观测独立记录 | A1，native/provider；先做一个真实成功/取消区分探针。`TC-IDE-C6-05-query-definition-reveal-history-native` 可复用既有 F12/reveal/back 子路径，不替代本卡鼠标 modifier 主链；其现有 Maven fixture 含 completion 裸 token，不当无语法错误项目 |
| ED-PARITY-001-V2 | P1 补 IDEA S1/S2 原件；P2 同 fixture/profile 执行后制作双侧表（打开、当前/其他匹配、Esc、hover、definition、Back），按原件核查、分三维判断 | A2，idea-comparison；IDEA输入已就绪，Taomni侧未执行。比较 JSON 结构通过不是匹配，若宣称 matched 则用既有 compare_idea.py 的 require-match 并人工审查原件，不生成假 receipt |
| ED-PARITY-001-V3 | P2 同 native session 100%/200% 执行 S5，独立记录 keyboard、focus、name/role/state、zoom、IME；用户已明确不增加播报验收，播报记未验证；禁止把 aria-live 当听到播报 | A1/A3，accessibility/native；只读找到 `/usr/bin/orca` 不是 AT 可用/通过证据 |
| ED-PARITY-001-V4 | P2 定向复用 `CodeMirrorHost.findFocus.test.tsx`、`lspHyperlink.test.ts`、`editorSearchPanel.test.ts`；浏览器 `TC-IDE-FINDFOCUS-01` 仅在需要低成本分离 renderer 问题时运行；最终 native S1/S3/S6 去重验证真实 OS/磁盘边界 | A3，测试可覆盖无重入、queued blur/new hover/destroy、shared undo、query rules、只读；unit/browser 不是本卡 provider/native PASS。不能原样把 browser YAML 改 mode，当作 native 可运行 |
| ED-PARITY-001-V5 | P2 在领取后复核 §3 真实 caller 与 final diff、identity、保留断言，补 document/code-audit；针对 query guard 使用现有 `workspaceSemanticQueryHost.test.ts` 与 Tab 相关命名测试审查/必要执行 | A1/A3；code-audit 不能单独证明运行结果。新产品反例需本卡修复设计与定向回归，新增代码则追加 scoped typecheck 与实际必要测试种类到卡/spec，不减少原六种 |

后续可用的既有命令（P1 未执行）：

```bash
pnpm exec vitest run src/components/editor/workspace/CodeMirrorHost.findFocus.test.tsx src/components/editor/workspace/lspHyperlink.test.ts src/components/editor/workspace/editorSearchPanel.test.ts
PYTHONPATH=.agents/skills/qa-ui-auto/scripts python -m qa_ui_auto run --mode browser --filter TC-IDE-FINDFOCUS-01 --config .agents/skills/qa-ui-auto/assets/qa-ui-auto.config.browser.yaml --report-dir qa-ui-auto-report/ed-parity-001/browser --require-pass
```

本卡主链采用明确手工原生步骤，未新增 YAML/runner 命令。若 P2 选择自动化新增 `TC-IDE-PARITY-001`，它目前不存在，须由本卡在未来授权范围 author testcase/covers/controls 并做 QA 静态门禁；不能打印虚构的现成运行命令。不能用全局改时限/断言来掩盖 runner 问题。

Native 配置必须来自现有 `.agents/skills/qa-ui-auto/assets/qa-ui-auto.config.example.yaml` 的当前合同并绑定隔离 `com.taomni.app.qa`、本机 binary/driver/source；本轮未创建配置，不使用不存在的通用 `qa-ui-auto.config.yaml`。P2 开始原生前读 native-testing，核验 build 复用；输入稳定后必要时集中构建一次，本卡不拥有全仓 release/integration gate，也不借旧 ED-GATE-003 的 done。

Windows/WebView2：同 F0/F2 字节，Ctrl 修饰键与真实 Pinyin/NVDA（若要求）独立证据；不复用 Linux XTest 为物理输入。macOS/WKWebView：按当前 keymap 核对 Cmd/导航 Back，系统输入/IME，VoiceOver（若要求），无 Tauri WebDriver 时手工 OS 自动化。当前 Linux 完成可按卡收尾，另外两端明确未验证；旧 Windows P3 仍是历史范围，不刷新为本卡三端完成。

## 7. 本轮实际静态核对

- 固定板 validate：9 cards，通过；固定板 deferred JSON：9 张，001/002 优先级 P0、均无 pending dependency，001 板内在先，工作区无冲突，所以选 001。没有调用 claim/list --claimable 选卡。
- QA `plan --case TC-IDE-FINDFOCUS-01 --case TC-IDE-C6-05-query-definition-reveal-history-native --platform Linux --json`：识别上述两 case；推荐 browser/native 分开。`native_gaps=[]` 仅是现有 YAML 支持，不说明本卡缺少的鼠标链已覆盖。
- 同 scope `status --reports qa-ui-auto-report --json`：Find browser unverified，C6-05 native stale，`ok=false`；source `f0983efe96a76a99de40f82fc19703f6138296ba4f1d6eba2dc624691c3cf9a8`，runner `ad4ca79efb4454124de4e015f81a2a9d99fcb6cfc75451644135093008fcd3a1`。该 fingerprint 是 status 当时身份，不是新 build。
- IDEA product-info、JDK release、文件存在性、进程/窗口列表只读；首轮仅只读；后续用户授权两段 IDEA 输入与打开隔离 Java 工程，未启动 Taomni/runner/JDT LS、没有产品测试或构建、没有提交/推送、没有子 agent。
- 最终板、链接/anchor、diff 检查记录见 [P1 静态核对记录](evidence/ed-parity-001-p1-static.md)。

## 8. ready 门槛与准确接续

1. **G1 参照（已完成）**：新 REF-PARITY-001-LINUX-20260915 的 F0 01–10、Java 27–44、r2-01..10 已补齐本卡核心状态，含可审阅原图、动作、cursor、hash与诊断分类；见[参照 §5](references/ed-parity-001-reference.md#observed)。初段选区遮挡hover不作成功，r2已补清晰下划线/hand→I-beam。两个授权时段均已结束并归还桌面，不能续用于P2。
2. **G2 辅助技术目标（用户已明确）**：2026-09-15 用户答复“沿用原 AC；播报保留未验证边界”。必验 keyboard/focus/name-role-state/zoom/IME 不减少；screen-reader不是本卡新验收，不伪称通过。
3. **G3 执行前置（规划已明确，实时 readiness 属 P2）**：IDEA本包导航已实测，JDK25/JDT LS1.61安装已核；P2按 §6 在隔离QA中验证实际provider/IME/config/build身份。IDEA新项目具体SDK未实测分配，pom source11、项目内方法解析/reveal/back已实测；不将此上限扩大到编译或外部类库。原始安装存在不当provider通过，也不要求P1越权运行产品探针。

本卡由P1 author为ready、planning_required=false，六种required_evidence及独立A1–A3保留，无开发owner/claimed_at/baseline或新产品evidence。真实剩余工作是P2的native/provider/accessibility与双侧比较，未制造重复修复。完整P2提示词见交接；本轮不领取、不实现、不自动启动P2。如果后续发现源码已满足，只补证而不强制造代码改动；独立新增范围交P0增量产卡。
