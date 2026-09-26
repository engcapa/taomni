# ED-PARITY-005 P2 开发并自验：完整提示词

来源：[唯一任务板](backlog.md) / REQ-05 / CW-LANG-001、CW-LANG-002。

P1规划完成：唯一板同卡 `ready / planning_required=false`，无开发owner。用户已确认IDEA版本及provider snippet差异；必要参照已补采。这里只交接，不启动P2，不代表产品或双侧比较通过。

[完整设计与用例](java-basic-completion-plan.md#test-cases) / [最终参照与fixture](references/ed-parity-005-reference.md#followup-observed) / [静态校验记录](evidence/ed-parity-005-p1-static.md)。本提示词由原P2模板完整填写，下面整段可直接复制给开发agent；接手时以实时任务板防止重复领取。

## 完整可复制提示词

```text
你负责完成随附任务板和 ID 的一个 Taomni Code Workspace IDEA 对齐工作包，包括实现、范围内故障
修复、集成、自检和必要当前端验证。

本轮只允许领取 docs-feature/code-workspace-idea-parity/backlog.md 中的 ED-PARITY-xxx 新卡，
并且 p0.planning_required=false、status=ready/implemented、依赖全 done。若交接给的是旧板/旧 ID，
返回身份不符，不自行改选历史卡或借用其证据。所有 task-board 命令显式带上述 --doc。

目标是在本轮范围内通过必要重构与能力完善，使功能、UI 和交互与目标 IDEA 高度一致；沿用总需求的
场景 ID 和验收目标，当前布局不是保留约束，已有正确能力和数据契约必须保留。

【本轮输入】
- 任务板与 ID：docs-feature/code-workspace-idea-parity/backlog.md / ED-PARITY-005；本交接保存时 ready、p0.planning_required=false、depends_on=[]，无开发owner；按实时状态正式领取，不能改选卡或重领done。
- 目标范围与用户结果：REQ-05 / CW-LANG-001、CW-LANG-002；隔离 Java 工程 ready → Basic Completion → 类型 import 与方法 snippet 分轮接受 → 各一次 Undo → 保存后继续补全。修静态D1 resolve失败伪装成功、D2词中Enter/Tab接受范围及本卡验证出的生命周期缺口，不重做已经接线的 scope 或保存修复。
- 目标 IDEA 与参考包：用户已定 Ultimate 2026.2.3 / IU-262.10968.63；docs-feature/code-workspace-idea-parity/references/ed-parity-005-reference.md#observed、#fixture、#capture-gaps；fixture-catalog.md#f2。F2-COMP-005 与 B-005 详见参考包。IDEA 原件位于 qa-ui-auto-report/idea-reference/ed-parity-005/run-20260925-024645/ 及 run-20260925-031701/（同父目录）；manifest.json/steps.jsonl 保留身份、hash、排除项。原件不入库；跨机器需取得原包，不能用摘要充当截图。
- 设计、DEC、AC/V：docs-feature/code-workspace-idea-parity/java-basic-completion-plan.md#ed-parity-005；ED-PARITY-005-DEC-01..09、ED-PARITY-005-A1..A3、ED-PARITY-005-V1..V6。G1/G2已解除；DEC-08用户决定保留provider原始snippet默认值与占位符，不新增Java参数清空适配；IDEA空参数差异明确接受。DEC-09词中Enter/鼠标保留Suffix、Tab替换Suffix；按设计D2保留双range与冻结接受意图，不修改共享parse_text_edit行为。IDEA live template结束格式化产生额外Undo，不引入Taomni；保留纯snippet导航无edit和一次原子接受。当前产品功能/UI/交互均未验证。
- 必须保留：live-buffer 严格同步、scope facts 既有接线、本地模板及触发设置、输入框/Find 焦点保护、同文档分屏共享 history、formatting/rename/codeAction共享TextEdit解析、primary/import/snippet 原子接受、保存后继续补全、Java didSave 与自写 watcher 抑制、non-Java 保存。改前依据和定向回归见设计第2节、V1..V5；既有测试不等于本轮 PASS。
- 文件/模块 owner 与依赖：板内 depends_on=[]；这是未来 P2 修改责任，不是 P1 开发 owner。src/components/editor/workspace/ 下 lspCompletion.ts、CodeMirrorHost.tsx、completionScopeAdapter.ts、projectFactsConsumers.ts；src/components/editor/CodeWorkspaceTab.tsx；src/lib/editor/lsp.ts；src-tauri/src/lsp.rs。共享输入消费者 workspaceCodeMirrorKeymap.ts、workspaceActionHost.ts、useWorkspaceActionsController.ts、SearchEverywhere.tsx、KeymapCheatSheetDialog.tsx 按生产引用定位，仅改本卡必要路径。保存/session/store 默认保留；调整共享 helper 时补其消费者回归。不得修改旧任务板。
- 用例设计与验证材料：docs-feature/code-workspace-idea-parity/java-basic-completion-plan.md#test-cases 是完整操作、前置、逐步及最终预期、边界、清理和证据合同。下列精确路径均拟新增、P2 待实现，当前没有运行结果：
  A1/A3→V1→qa-ui-auto-tests/cases/TC-IDE-PARITY-005-01-completion-entries.testcase.yaml；ID TC-IDE-PARITY-005-01；browser。
  A1/A2/A3→V2→qa-ui-auto-tests/cases/TC-IDE-PARITY-005-02-completion-accept-undo.testcase.yaml；ID TC-IDE-PARITY-005-02；browser。
  A1/A3→V3→qa-ui-auto-tests/cases/TC-IDE-PARITY-005-03-completion-lifecycle.testcase.yaml；ID TC-IDE-PARITY-005-03；browser。
  A1/A3→V4→qa-ui-auto-tests/cases/TC-IDE-PARITY-005-04-completion-resolve-gate.testcase.yaml；ID TC-IDE-PARITY-005-04；browser。
  A1/A3→V5→qa-ui-auto-tests/cases/TC-IDE-PARITY-005-05-java-completion-native.testcase.yaml；ID TC-IDE-PARITY-005-05；native/provider，Windows当前端。browser不能证明真实JDT LS报文/候选、Rust边界与host文件字节。V2追加mid-word-enter-tab-mouse及空placeholder场景归02；真实Tmid三入口归05，全部按设计精确M0及raw协议预期。
  A2→V6→复用02/05运行逐状态对比REF-PARITY-005-WIN-20260925，不重复构建；真实provider与模拟provider证据分开。
  全部 covers: [F25.5]。P2负责 parity005_completion fixture/schema/注册、隔离native provider fault设施、只读 completion-session-observation、完整controls/testid维护及缺失verb支持；只读eval不能执行输入或注入state。
  复用单测：src/components/editor/workspace/lspCompletionResolveGate.test.ts、completionScopeAdapter.test.ts、CodeMirrorHost.completion.test.tsx、lspCompletion.test.ts、useWorkspaceLspSession.test.tsx（后四项同目录）。拟新增 src/components/editor/workspace/CodeMirrorHost.parity005.test.tsx、src/lib/editor/lsp.completionResolve.test.ts 与 src-tauri/src/lsp.rs inline completion_resolve_does_not_fallback_on_null_or_error；另增lspCompletion.test.ts的ED-PARITY-005 preserves insert replace intent through resolve and undo、CodeMirrorHost.parity005.test.tsx的ED-PARITY-005 Enter Tab and mouse route distinct range intent，以及Rust inline completion_item_preserves_insert_replace_ranges；精确预期见V2追加段/V3/V4。历史 TC-IDE-C2-01/C2-05/C2-10/TC-REPRO-SAVE-01只复用已说明的部分覆盖，不借旧PASS。
- 执行环境：当前 Windows/PowerShell，三端兼容；browser先完成01–04，稳定后集中05真实Windows/WebView2/JDT LS。macOS/WKWebView、Linux/WebKitGTK同序列保留未验证计划，macOS direct Cargo前stage krb5。实际JDT LS/JDK/classpath identity在P2启动后记录；IDEA zulu-22/language21的观察不等于Taomni provider已ready。P1没有QA build，没有可声称复用的本卡binary。QA配置按qa-ui-auto只读status/plan核对有效配置，不编造文件或可执行命令；原件输出qa-ui-auto-report/ed-parity-005/<mode>/<run>/<case>/。IDEA实采环境为Islands Dark/Dark、Source Code Pro16/line-height1.2、UI Zoom100%/DPI96、UI Microsoft YaHei UI14、屏幕1366×768；普通窗1346×680、窄窗950×390。两次桌面时段均已结束，新的真实桌面输入须有当轮有效时段并确认目标窗口/焦点，禁止自动解锁。
- 修改权限：用户将本提示词交给P2后，允许本卡产品代码、测试、文档、自有任务状态及必要构建/验证；不提交推送，不启动其他agent/P3。本次P1会话仅保存交接文本，不授予当前agent开发执行权限。
- 当前工作区或交接：分支docs/code-workspace-idea-audit-20260913；HEAD 8e232d2a3d479c72d325032e5d0c870785039e18。本轮modified：docs-feature/code-workspace-idea-parity/ 下backlog.md、capability-matrix.md、index.md、task-planning.md、references/fixture-catalog.md；untracked：java-basic-completion-plan.md、references/ed-parity-005-reference.md、evidence/ed-parity-005-p1-static.md、本handoff。保留这些成果，接续时重读git status/HEAD而不把此清单当未来实时状态。D1/D2源码确认、R1/R2待运行归因；所有产品测试/构建/领取/实现未执行。

【最小验证与完成门槛】
先改前定向复现D1/D2、检查受影响保留基线，再单测/browser迭代；落实设计V1–V6全覆盖后做scoped typecheck及Rust completion_resolve定向测试；稳定输入后一次集中native/provider运行和双侧比较。required_evidence保留code-audit、unit、typecheck、browser、native、provider、idea-comparison，不能删除失败/未验证项制造通过。普通测试设施由P2实现；G2目标已定；若真实provider缺snippet，保持对应AC未验证并报告能力边界，不能用普通文本或browser PASS替代native。测试命令与运行策略见设计第7节，未实现case不得报告通过。

先读取适用 AGENTS.md、$code-workspace-idea-task 和 $qa-ui-auto；按需读取 $code-workspace-idea-parity、
$idea-reference 及设计 skill 的有效材料。不要自行委派其他 agent。核对任务、依赖、HEAD、生产代码和
工作区后，按 task lifecycle 领取或接续；不是可领取/可接续状态、依赖未满足或 ID 不准确时不要另造任务，
返回精确缺口。done 卡不得重领。

【测试用例实现与验证】
必读 .agents/skills/qa-ui-auto/references/authoring.md（含 Design To Implementation Handoff）和
efficient-verification.md；改既有行为读 regression-protection.md，写 YAML 前核对 schema 和 verb-catalog.md。
先读取 P1 交付的完整用例设计，核对每个 AC 的目标及保留行为断言。若旧交接只有 AC/V 或命令，
在既定目标内直接补齐用例设计和映射；只有实质目标未定才提出具体缺口，不因普通测试细节退回 P1。
优先 browser 实现完整 UI、控件操作、Action 多入口及快捷键覆盖；逐项核对 P1 的覆盖维度矩阵并补齐
实际受影响的入口/状态/绑定，包含异常恢复和保留行为。操作真实控件、实际按下快捷键并断言用户结果，
不能以 handler 单测、控件触达或一次菜单点击替代入口/快捷键验证。每个 native 检查须注明 browser
无法证明的具体断言和边界；应用内快捷键不默认 native，设施缺失不能直接标不适用或省略验收。
把选定 UI 工作流落实到 qa-ui-auto-tests/cases/TC-<id>-<slug>.testcase.yaml，复用足够的现有用例；
相关单测放 src/**/*.test.ts(x)、Rust inline 或 src-tauri/tests/integration/。YAML 使用实际唯一 ID、
covers、fixtures、modes、必要 native_platforms 和支持的 verbs，断言用户结果及必要真实副作用。
同步 qa-ui-auto-tests/feature-list.md 的 feature/controls；只在 controls 变化时重生成
.agents/skills/qa-ui-auto/references/testid-catalog.md，用例/目录变更批次结束按 authoring.md 做一次 audit --gate。
需要 fixture/verb/selector 支持时在授权范围内补齐对应设施，不能虚构可执行命令；runner 不支持的
AC 按其真实边界补自动化或手工检查及证据，不自动升级 native。设计段落、控件触达、静态 audit 和 dry-run 都不算行为通过。
按最小充分集合执行目标与保留行为检查，核对实际选中及 pass/fail/skip 数、summary/receipt 和证据身份。
运行原件保存 qa-ui-auto-report/（不入库），在同一设计及交接中回填 AC→V→实际 test/case→报告/断言，
明确已实现/待实现与 pass/fail/skip/未执行及平台范围。不能以文档用例替代必要的可执行测试和运行证据。

你与用户及其他 agent 共用工作区。保留已有改动，只修改本卡 owner 范围；共享接口或其他 owner 文件
确需调整时，先核对现状并最小化影响，不覆盖或撤销他人成果。未经授权不提交、推送、合并或发布。

按目标 IDEA 参考和设计在真实生产入口实施。当前布局、组件、菜单、样式和交互可以重构，不能用当前
错误实现反推验收，也不能把 fixture、experimental 或 mock 冒充生产能力。明确有意改变与必须保留的
行为；检查共享状态唯一 owner、动作路由、异步取消/迟到结果、焦点/快捷键抢占、保存/撤销/恢复、IPC、
磁盘和 provider 副作用。缺陷修复增加能暴露原错误的最小回归。

发现失败、回归或耗时异常时由你在本轮内先归因：保留原始报告，区分产品退化、测试期望错误、设施
故障、依赖缺失和 stale 证据；用最小复现和区分性检查定位，不直接跑全套。授权范围内的本卡回归直接
修复并复验；不得删除步骤、放宽断言、扩大超时或改变期望来制造通过。确认 bug 但需要正式修复设计时
才使用 $issue-design。超出 owner 或权限的部分写清触发、影响、建议和所需输入，继续独立工作。

快速迭代使用定向单测、挂载或 browser。只有本轮断言确需验证真实 IPC、磁盘、进程、IME、clipboard、
OS shortcut、重启、native window 或具体 WebView/打包差异时才补 native；已有明确 native AC 必须履行。
纯 renderer 可见变化默认用 browser 充分验证，不因“桌面交付”自动要求 native smoke。
确需 native 时，稳定相关代码/测试后检查 QA binary 身份与复用条件，再集中构建或复用并运行必要场景。
核对 source/case/runner/config/build 身份；binary 可复用不等于 case 已通过，
browser 结果不外推 native。验证用户结果以及错误、取消、连续操作、保存/撤销和恢复，不能只看控件
存在或点击成功。

涉及可见变化时，用匹配 fixture、操作、窗口、缩放、字体、主题和平台复核 Taomni 与 IDEA 的关键状态；
分别判断功能、UI 和交互，记录已接受差异和仍阻塞目标的差异。若你参与实现，结论必须标为自检，不能
冒充独立验收。执行真实桌面输入前确认目标窗口和焦点，锁屏时不得自动解锁。

完成本卡目标、保留行为和当前端必要证据后，如实更新自己领取的任务状态并校验记录。Windows、macOS、
Linux 都在兼容范围；本轮完成当前端，其他端标为未验证并给出步骤。若条件不足，不得把部分通过写成 done。

最终交付：任务板路径/ID/最终状态；代码身份和生产效果链；变更文件与有意改变/保留行为；目标 AC 和
回归到测试/报告的映射；实际命令、平台、模式、构建或复用次数及耗时；功能/UI/交互自检结论；失败、
stale、skip、未验证和外部条件；是否提交/推送。不要自动启动 P3 或安排其他 agent。

交付时附总需求矩阵对应的场景 ID、差距是否关闭及依据，供 P0 增量更新；任务完成不直接换算为整体对齐。
需要后续角色时，返回用已知材料填好本文件对应模板的完整提示词，人工只需复制，未知条件明确写缺口。
```
