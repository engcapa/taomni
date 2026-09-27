# ED-PARITY-007：P2 开发并自验提示词

按用户要求于 2026-09-27 预先生成；源模板为 [agent-collaboration-prompts.md 的 P2 开发并自验](agent-collaboration-prompts.md#p2-开发并自验)。**这是完整条件式交接，当前卡仍 deferred / planning_required=true，不代表已 ready 或立即授权开发。** 用户已将目标放宽为 **IDEA 2026 系列**，无需锁定 patch/build；历史实采身份仍如实保留。

准确任务：[backlog.md / ED-PARITY-007](backlog.md)，来源 AUDIT-20260913-01 / REQ-06 / CW-REFACTOR-002。设计：[DEC/AC/V](java-extract-method-plan.md#ed-parity-007)、[完整用例设计位置与待决项](java-extract-method-plan.md#test-cases)、[接续前置](java-extract-method-plan.md#readiness)；[参考与fixture](references/ed-parity-007-reference.md)、[方案图](java-extract-method-options.png)、[P1静态记录](evidence/ed-parity-007-p1-static.md)。

下方整段可复制给 P2。接手者先读取最新状态；未解除的具体前置已写入正文，不需用户补板路径、ID 或材料路径。当前会话只生成文档，不启动 P2。

<a id="p2-prompt"></a>

```text
你负责完成随附任务板和 ID 的一个 Taomni Code Workspace IDEA 对齐工作包，包括实现、范围内故障
修复、集成、自检和必要当前端验证。

本轮只允许领取 docs-feature/code-workspace-idea-parity/backlog.md 中的 ED-PARITY-007，
并且 p0.planning_required=false、status=ready/implemented、依赖全 done。若交接给的是旧板/旧 ID，
返回身份不符，不自行改选历史卡或借用其证据。所有 task-board 命令显式带上述 --doc。

目标是在本轮范围内通过必要重构与能力完善，使功能、UI 和交互与目标 IDEA 高度一致；沿用总需求的
场景 ID 和验收目标，当前布局不是保留约束，已有正确能力和数据契约必须保留。

【本轮输入】
- 任务板与 ID：docs-feature/code-workspace-idea-parity/backlog.md :: ED-PARITY-007；生成时 deferred / p0.planning_required=true，无开发 owner；来源 AUDIT-20260913-01 / REQ-06 / CW-REFACTOR-002。只核对这一张卡，不自行选板/换卡。
- 目标范围与用户结果：仅 F2-EXTRACT-007 Java 明确两行选区的 Extract Method：准确支持边界、语义生成、可审阅结果、取消零效果、冲突/迟到不覆盖、一次共享 undo/redo、程序输出 13:1；不重复 Rename，不扩到 Inline/Move/Change Signature。
- 目标 IDEA 与参考包：IDEA 2026 系列即可，不锁定 2026.2.2 或某个 build。已有真实参照为 Ultimate 2026.2.2 / IU-262.10315.125；准确文档 docs-feature/code-workspace-idea-parity/references/ed-parity-007-reference.md（environment、fixture、capture-steps、post-image、gaps）。使用另一 2026.x 时记录实际版本/build/edition和行为差异，复用匹配状态，必要时只补受影响状态；不得把旧截图改标新 build，也不因 patch 版本不同要求更换安装。
- 设计、DEC、AC/V：docs-feature/code-workspace-idea-parity/java-extract-method-plan.md#ed-parity-007；#decisions（ED-PARITY-007-DEC-01..08）、#ui-contract、#acceptance（ED-PARITY-007-A1/A2/A3）、#test-cases（ED-PARITY-007-V1..V8）、#readiness；方案图 java-extract-method-options.drawio / .png 位于同目录。当前 DEC-02 与 BL-03 尚未定稿，详见下方接续前置。
- 必须保留：设计 K1–K6：Rename 整体事务/资源路径/一次撤销及恢复；quickfix、Generate、保存 organize imports；共享文档/split view selection/history；dirty/BOM/EOL/disk hash/recovery；Action启禁/keymap冲突/输入与terminal焦点保护；journal v1/v2兼容与Review/Keep/Restore/Dismiss。改前源码依据与精确现有测试见设计第2、5节及V5/V8；历史2026-09-15 Linux PASS不转移，本轮改前产品基线未执行。
- 文件/模块 owner 与依赖：板内 depends_on=[]。P2未来责任以设计第5节为准：CodeWorkspaceTab.tsx 的 workspace.extractMethod/openRefactorActions/showCodeActionsMenu/runCodeAction；workspace/extractMethodPlan.ts（拟新增）；codeActionProviderAdapter.ts、intentionSession.ts、refactorPlan.ts、RefactoringPreviewDialog.tsx；必要的 lib/editor/lsp.ts、src-tauri/src/lsp.rs 协议错误/命名适配。workspaceActionHost/CodeMirrorHost/useWorkspaceActionsController、ControlBar/MainLayout/SearchEverywhere/editorContextMenu 仅作必要路由和保留检查。workspaceEditApply/workspaceEditHistory/refactorRecoveryController/workspaceDocumentTransactionOwner、workspaceSemanticEditing/saveOrganizeImportsAdapter 是共享消费者，不另造保存/history owner。inline方案新增责任必须先在设计定稿；不能以本清单暗中授权全局事务重写。
- 用例设计与验证材料：docs-feature/code-workspace-idea-parity/java-extract-method-plan.md#test-cases 是唯一完整用例设计位置（包含前置、操作、关键/最终断言、清理、模式、控件/入口/绑定和边界）；下方提供逐项精确路径索引。所有产品结果 unrun，新文件均为拟新增；V1/V2/V6受DEC-02影响的预期仍需P1定稿，不将它们交给P2猜测。
- 执行环境：当前 Windows/PowerShell，仓库 D:/code/person/taomni；兼容 Windows/macOS/Linux。UI 默认 browser，V7/V8 承担真实JDT LS/IPC/磁盘/程序/恢复边界。已有JDK21路径 C:/Program Files/Java/jdk-21；JDT LS jar 1.61.0.202607142124的静态身份在参考包，未运行验证。browser配置 .agents/skills/qa-ui-auto/assets/qa-ui-auto.config.browser.yaml；native配置和QA binary 尚未建立，不声称有可复用本卡构建。输出 qa-ui-auto-report/ed-parity-007/<run>/，不入库。IDEA原件 qa-ui-auto-report/idea-reference/ed-parity-007/run-20260927-113341/manifest.json；本地117个工件hash已核，非Taomni验证。此前10分钟桌面时段已结束，不继承；新桌面输入先确认当次时段、窗口和焦点，锁屏不得自动解锁。
- 修改权限：本文件是用户要求预先生成的P2提示词，不是当前P1开发授权。仅在用户另行发起P2、下方接续前置满足且本卡可领取时，才进入模板的开发权限：本卡产品代码/测试/文档、自有任务状态及必要构建验证；不提交推送。仍deferred或planning_required=true时只读核对并返回具体缺口，不claim、不改产品、不启动runner/build；不得自行将卡标ready以绕过前置。
- 当前工作区或交接：分支 docs/code-workspace-idea-audit-20260913；HEAD b3591ae10cd9425e92bf844d7a928c8373ad653c。P1开始时干净，当前未提交文档改动：backlog.md、capability-matrix.md、index.md、references/fixture-catalog.md、task-planning.md；新增 java-extract-method-plan.md、references/ed-parity-007-reference.md、evidence/ed-parity-007-p1-static.md、java-extract-method-options.drawio/.png及本handoff，均在 docs-feature/code-workspace-idea-parity/。忽略的IDEA原件与辅助脚本在qa-ui-auto-report/。以接手时git status/diff再核，不丢弃P1成果。前一agent结论：参照主链已采，规划仍待DEC-02/语义临时事务，产品验证全部未执行。


【接续前置：必须先核对，不将本文件当作 ready 证明】
当前任务为 deferred / planning_required=true。本次用户只追加“生成P2提示词并保存；IDEA 2026系列即可”，
没有回答A/B目标取舍，也没有授权当前P1开发。首先只读执行：
python .agents/skills/code-workspace-idea-task/scripts/task_board.py --doc docs-feature/code-workspace-idea-parity/backlog.md validate
python .agents/skills/code-workspace-idea-task/scripts/task_board.py --doc docs-feature/code-workspace-idea-parity/backlog.md list --status deferred --json
同时读取同卡最新metadata/spec。若后来已ready/implemented且planning_required=false、依赖已done，
读取 task-lifecycle 后才正式领取/接续；不要仅凭本文件内的生成时状态覆盖最新合法交接。

必须解除的目标缺口：
1. DEC-02：A 默认provider名称+完整文件diff预览（首包无inline自定义名），或B保持IDEA内联命名。
   B是当前推荐、不是已获用户答复；A是尚未接受的交互差异。不能以“2026系列均可”推断接受A。
2. BL-03：若保留inline，P1需明确临时文档/provider同步、语义命名、保存隔离、失败/取消恢复和
   一次提交/历史合同。默认JDT edit没有methodName参数；advanced额外java.action.rename位置
   不等于完整事务。禁止正则改名、把client command当server command、先持久提取再普通Rename。
   真需扩范围/拆卡时交P0增量核定，不造新卡、不去旧ED-REF-001。
3. 依据最终目标补齐设计V1/V2/V6的操作/预期、控件与对应必要G1参考；不能由P2猜未知目标。
   新YAML/fixture尚未实现本身不阻塞规划，未定预期才是缺口。
若这些仍未解除，报告准确缺口与现有成果，本次接续止于只读检查；后面的实现指令暂不生效。

【AC/V → 精确测试/用例索引；全部产品结果未执行】
新YAML均在 qa-ui-auto-tests/cases/，拟 covers: [F25.5]，尚未创建/注册，P2须按设计落盘：
- A1/A2/A3 → V1 → TC-IDE-PARITY-007-01-entry-context.testcase.yaml；ID TC-IDE-PARITY-007-01；browser。
  Search Actions、ControlBar、Mod+Alt+M、Refactor This与通用Code Actions各真实入口、启禁、路由、
  selection、modifier/冲突/重复触发/输入框与terminal焦点保护。辅助拟新增
  src/components/editor/CodeWorkspaceTab.parity007.test.tsx：
  ED-PARITY-007 routes every extract entry with the captured selection。
- A1/A2/A3 → V2 → TC-IDE-PARITY-007-02-preview-undo.testcase.yaml；ID TC-IDE-PARITY-007-02；browser。
  最终DEC-02命名/预览控件、必需edits整体、Cancel/Close/Esc、Apply、单次Undo/Redo、split view、
  保存重开与宽窄布局。上述mounted文件及src/components/editor/workspace/RefactoringPreviewDialog.test.tsx
  拟补测试名 ED-PARITY-007 never applies half an extraction。不得以IDEA post伪造JDT实际reply。
- A1/A3 → V3 → TC-IDE-PARITY-007-03-provider-boundaries.testcase.yaml；ID TC-IDE-PARITY-007-03；browser。
  无能力/empty/disabled/malformed/null/error/timeout/resolve失败/command-only/重试各自真实结果。
  拟新增 src/components/editor/workspace/extractMethodPlan.test.ts：
  rejects non-method kinds without relabeling them；requires a complete edit before extract preview。
  复用codeActionProviderAdapter.test.ts中的 keeps timeout, throw, null, malformed, and cancellation outcomes distinct。
- A1/A3 → V4 → TC-IDE-PARITY-007-04-stale-conflict.testcase.yaml；ID TC-IDE-PARITY-007-04；browser。
  request/resolve/preview暂停后编辑、切文件/工作区、关重开、generation变化、迟到与外部冲突。
  拟mounted测试 ED-PARITY-007 drops late extract results after owner invalidation；已有
  src/components/editor/CodeWorkspaceTab.test.tsx 的
  rejects a provider refactor when the editor changes during preview confirmation 作改前保护。
- A3 → V5 → TC-IDE-PARITY-007-05-retained-consumers.testcase.yaml；ID TC-IDE-PARITY-007-05；browser。
  Rename可排除项/资源move/undo，quickfix各入口、Generate、organize imports、recovery实际控件。
  已有单测路径前缀 src/components/editor/workspace/：codeActionProviderAdapter.test.ts、
  refactorPlan.test.ts、workspaceEditApply.test.ts、workspaceEditHistory.test.ts、
  workspaceSemanticEditing.test.ts、saveOrganizeImportsAdapter.test.ts；只选本卡触及行为，保留改前结果。
- A2（关联A1/A3）→ V6 → 复用007-01/02截图及V7真实效果；无虚构007-06 YAML。
  对照reference的R0–R8，功能/视觉/交互分别判断；比较报告
  qa-ui-auto-report/ed-parity-007/<run>/comparison/record.json，使用实际schema/validator。
  2026.x build可不同，必须记录各侧身份、适用状态和差异；validator通过不等于matched。
- A1/A3（A2功能侧）→ V7 → TC-IDE-PARITY-007-07-extract-native.testcase.yaml；
  ID TC-IDE-PARITY-007-07；native，初始native_platforms: [Windows]。
  browser不能证明真实Tauri→Rust→JDT LS、磁盘hash/metadata、JDK运行13:1及原生恢复。
  按设计V7执行实际Action→取消/应用→host读盘→Run→一次Undo/Redo→冲突/失败恢复；保留request/reply。
- A3 → V8 → 复用 qa-ui-auto-tests/cases/TC-IDE-C6-04-rename-preview-conflict-apply-undo.testcase.yaml
  （实际ID TC-IDE-C6-04）及 TC-IDE-AUDIT-014-rename-recovery-native.testcase.yaml
  （实际ID TC-IDE-AUDIT-014-rename-recovery-native），原生资源路径/重启恢复不能由browser证明。
  现有Linux-only选择/权限步骤不冒充Windows支持；按设计V8用Windows可用UI步骤+独立host hash
  或可复现手工记录，维护实际平台范围；不转移旧PASS。

【fixture / controls / verbs 的P2实施责任】
- F2源字节、pom、B0 hash、UTF16选区[6:8,7:32)、IDEA post与hash均见reference#fixture/#post-image。
  browser以同字节VFS和可控provider隔离边界；真实生产Action/session/preview/apply不可mock。
- 拟新增 .agents/skills/qa-ui-auto/scripts/qa_ui_auto/fixtures/extract_method.py，fixture名extract_method；
  同步fixtures/__init__.py REGISTRY及schema/testcase.schema.json枚举。ready/disabled/mixed-kinds/
  null/error/timeout/late/command-only/conflict变体由P2实现，报告保留原始请求与响应。
- 既有入口/控件包括 code-workspace-search-everywhere、
  context-menu-workspace-command-workspace.extractMethod、editor-context-code-actions、
  refactoring-preview-filter；file/usage checkbox、all/none、collapse、Apply/Cancel/Close与新命名控件
  按最终UI逐项登记实际testid，不编造已有selector。设计#test-cases覆盖矩阵是逐项核对基准。
- 可用verbs清单见设计7.1及最新verb-catalog：click/dblclick/right_click/click_menu/hover/fill/press/
  set_check/set_viewport/wait_for/assert_visible/assert_not_visible/assert_items/assert_text_equals/
  assert_attribute/assert_disabled/assert_enabled/assert_count/screenshot/eval_readonly。
  eval_readonly只读focus/selection，不调用handler/store；需要新增故障或selection观测设施由P2补齐。
  native_pointer_drag等现有Linux/X11设施不直接移植声明支持Windows。缺verb不是自动增加native理由。
- UI优先browser，name/keymap/focus与实际快捷键都必须操作；native仅V7/V8列出的真实边界。
  runner缺支持时按设计手工流程保留证据，不用skip代替完成。新test/case均由P2实施，P1没有写可执行测试。

【最小验证、证据与保留合同】
获准开发并领取后，先按触及行为取得V5/V8改前基线，再定向unit/mounted与browser 007-01..05；
代码与测试稳定后合并一次scoped typecheck；检查source/case/runner/config/build身份后集中复用或
构建必要QA，做V7及必要V8，不按每个V重建。V6复用匹配真实IDEA参照；补采前确认新的桌面时段。
设计7.3给出文件实现后的browser配置/命令形态，不是当前已可执行的成功记录。
required_evidence仍为code-audit、unit、typecheck、browser、native、provider、idea-comparison，
不能删native/provider或借旧build gate。三端兼容；本轮当前Windows必要证据齐全，macOS/Linux分别
标未验证并列相同fixture/入口/保存/撤销/恢复计划。改Rust只格式化所改文件，macOS direct cargo前
遵循AGENTS的krb5 staging。全仓构建不能从旧交接自动继承为每轮必跑。
旧Rename/recovery已交付只是生产保留基础；不重开旧卡。所有新失败保留归因和修复前后证据。

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
