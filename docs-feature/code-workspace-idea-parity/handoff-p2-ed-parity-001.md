# P2 开发并自验：ED-PARITY-001

P1 规划完成，唯一板同卡 ready / planning_required=false，未开发领取。本文由[原 P2 模板](agent-collaboration-prompts.md#p2-开发并自验)完整填写；本轮只生成交接，不自动启动 P2。用户可在下一轮直接复制下列完整提示词。

```text
你负责完成随附任务板和 ID 的一个 Taomni Code Workspace IDEA 对齐工作包，包括实现、范围内故障
修复、集成、自检和必要当前端验证。

本轮只允许领取 docs-feature/code-workspace-idea-parity/backlog.md 中的 ED-PARITY-001 新卡，
并且 p0.planning_required=false、status=ready/implemented、依赖全 done。若交接给的是旧板/旧 ID，
返回身份不符，不自行改选历史卡或借用其证据。所有 task-board 命令显式带上述 --doc。

目标是在本轮范围内通过必要重构与能力完善，使功能、UI 和交互与目标 IDEA 高度一致；沿用总需求的
场景 ID 和验收目标，当前布局不是保留约束，已有正确能力和数据契约必须保留。

【本轮输入】
- 任务板与 ID：docs-feature/code-workspace-idea-parity/backlog.md / ED-PARITY-001 / ready；p0.audit_id=AUDIT-20260913-01，planning_required=false，depends_on=[]，尚无开发owner。
- 目标范围与用户结果：REQ-01 / CW-SEARCH-001、CW-SHELL-002、CW-NAV-002。Find打开/匹配/Esc后modifier-hover/click→真实Java定义reveal→Back；只接续provider/accessibility及必要焦点证据。现有Find防重入修复保留，不重复开发，不扩成完整Java导航或搜索域。
- 目标 IDEA 与参考包：Ultimate2026.2.2 / IU-262.10315.125。docs-feature/code-workspace-idea-parity/references/ed-parity-001-reference.md#observed / REF-PARITY-001-LINUX-20260915；原件qa-ui-auto-report/idea-reference/ed-parity-001/20260915-linux/，入库hash清单docs-feature/code-workspace-idea-parity/evidence/ed-parity-001-reference-artifacts.json。Linux Islands Dark/Classic Light，UI110% Dialog16，Source Code Pro16/1.2，XWin；F0客户区1920×1044、F2为1400×1000。Back实测Alt+Left；Ctrl+Alt+Left未返回。历史Windows Find原zip本机缺失，不再依赖它补本卡核心参照。
- 设计、DEC、AC/V：docs-feature/code-workspace-idea-parity/find-provider-accessibility-plan.md#ed-parity-001，ED-PARITY-001-DEC-01..06、ED-PARITY-001-A1..A3、ED-PARITY-001-V1..V5，S0..S6。P0起点docs-feature/code-workspace-idea-parity/task-planning.md#ed-parity-001。用户已明确“沿用原AC；播报保留未验证边界”，不增加screen-reader验收，keyboard/focus/name-role-state/zoom/IME保留。
- Fixture：reference §2/§4的F0四文件与F2-NAV-001精确三文件，Main.greet范围[110,115)、注释[129,134)，目标Helper.greet[62,67)，UTF-8/LF/无BOM；pom source/target11，无三方依赖。F0第二个tree为[54,58)。在qa-ui-auto-report/ed-parity-001/fixtures/各建隔离copy，不修改源码seed。IDEA当前折叠/横滚不代表改写文件，不扩大成折叠对齐；实际项目SDK未观测，IDEA参照只证明已实测项目内方法解析。
- 必须保留：两轮无重入、Esc当前匹配selection、modifier清理/新hover/destroy、双view独立selection/shared history、Replace一次undo、readonly零写入、dirty/save/关闭Cancel、IME、clipboard旧请求永久失效和新paste可用；依当前caller及设计§3/§5和既有focused tests。2026-09-14 Windows P3仅作历史，不继承PASS或done。
- 文件/模块owner与依赖：主责任src/components/editor/workspace/editorSearchPanel.ts、lspHyperlink.ts、必要CodeMirrorHost.tsx及同名focused tests；补证优先。只读共享消费者EditorGroup.tsx两个Host、CodeWorkspaceTab.tsx的beginSemanticQuery/goToDefinition/navigateLocations/openLspLocation、workspaceSemanticQueryHost.ts、workspaceDocumentTransactionOwner.ts、clipboard generation；TS/Rust LSP链见设计§3，默认只读，不造新schema/store/IPC/probeDefinition。只有本卡实际反例证明必要时最小修复并补issue-design与相邻回归；无本板依赖，旧板不是跨板依赖。
- 验证材料：V1真实native/provider主链及失败/取消/迟到/retry；V2同fixture双侧三维比较；V3真实keyboard/focus/name-role-state/200%/IME（播报未验证）；V4去重复用src/components/editor/workspace/CodeMirrorHost.findFocus.test.tsx、lspHyperlink.test.ts、editorSearchPanel.test.ts、必要browser TC-IDE-FINDFOCUS-01，再合并native保留检查；V5当前caller/identity审查，必要workspaceSemanticQueryHost.test.ts与Tab相关命名回归。TC-IDE-C6-05-query-definition-reveal-history-native只覆盖F12/reveal/back子路径，不能替代modifier-click主链。Linux只读status：Find browser unverified，C6-05 native stale（source/runner/config/build变化）；P1零产品执行。
- 最小验证与证据：保留document/code-audit/native/provider/accessibility/idea-comparison六种。手工OS主链步骤已精确规定，不要求凭空造新runner；若新增TC-IDE-PARITY-001，它目前不存在，需本卡author YAML/covers/controls并静态校验。产品改动需追加scoped typecheck与必要回归证据，不能减少原要求。按设计§6选择有意义的命名测试，不跑全仓/release gate；真实provider必须记录JDK/version/session/request/result/cancel和reveal/back，mock不算。
- 执行环境：当前Linux/Cinnamon/X11、WebKitGTK；已找到JDK25.0.2、JDK21和JDT LS1.61.0.202607102111，但实际生产session/IME/native QA配置仍需P2核实。使用隔离com.taomni.app.qa；输出qa-ui-auto-report/ed-parity-001/。按当前qa-ui-auto.config.example.yaml合同准备配置，native_build.py先check，稳定输入后必要时集中构建；P1没有已验证可复用binary。Windows/WebView2、macOS/WKWebView未验证，步骤见设计§6。本轮IDEA独占时段已结束，P2真实桌面输入前重新取得可用时段，不自动解锁。
- 修改权限：此提示词由用户在后续启动P2时授权执行；允许本卡产品代码、测试、文档、自有任务状态及必要构建/验证，不提交推送。本包以补证为先，现有实现满足时不制造代码改动；当前P1没有实施授权，不自动执行本提示词或委派agent。
- 当前工作区或交接：分支docs/code-workspace-idea-audit-20260913，HEAD05156e0f3b5e3e7702fa5092f9c4d41eafdd1c59；接手clean。P1修改本目录backlog.md、task-planning.md、index.md、capability-matrix.md；新增find-provider-accessibility-plan.md、references/ed-parity-001-reference.md、handoff-p2-ed-parity-001.md、evidence/ed-parity-001-p1-static.md、evidence/ed-parity-001-reference-artifacts.json。原件与临时collector在被忽略qa-ui-auto-report，不提交。P1规划完成，产品验证/实现未执行；领取前重核HEAD/diff，不覆盖这些文档。

先读取适用 AGENTS.md、$code-workspace-idea-task 和 $qa-ui-auto；按需读取 $code-workspace-idea-parity、
$idea-reference 及设计 skill 的有效材料。不要自行委派其他 agent。核对任务、依赖、HEAD、生产代码和
工作区后，按 task lifecycle 领取或接续；不是可领取/可接续状态、依赖未满足或 ID 不准确时不要另造任务，
返回精确缺口。done 卡不得重领。

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

快速迭代使用定向单测、挂载或 browser。代码和测试输入稳定后，检查 QA binary 是否匹配并可复用，
只为 IPC、磁盘、进程、IME、clipboard、OS shortcut、重启或 native window 等真实边界集中构建和运行
必要 native 场景。核对 source/case/runner/config/build 身份；binary 可复用不等于 case 已通过，
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
