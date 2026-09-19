# P0 新卡的待细化规格

这些是从已有 P0 报告补录的任务起点，不是完成的 P1 设计。首次 P0 基线为 2026-09-13 / `27f99b61`；本次 2026-09-15 仅核对文档接续，没有新的生产/IDEA 观测。下文“待核”必须由 P1 按当前 caller、参考和环境补齐后才能 ready。

任务状态唯一来源是 [backlog.md](backlog.md)。P1 保留同一新 ID 和独立 AC，完善对应节或将该卡 spec 指向新的设计同名 anchor；必须回链本节和 REQ/CW 来源。旧设计与任务只供复用契约和查重，不移植旧 owner、完成状态或 evidence。

每节 A1/A2/A3 是待细化验收目标。P1 必须补具体 fixture 字节/结果、正常与负路径、UI/交互状态、生产 owner/共享消费者、最小验证命令与环境前置；不能仅凭本文件的目标摘要宣布可开发。验证映射初稿统一为 V1（A1 的入口与结果）、V2（A2 的双侧状态）、V3（A3 的保留行为）；所有产品验证均未执行。

<a id="ed-parity-001"></a>

## ED-PARITY-001 Find 已实现后的 provider 与可访问性证据接续

2026-09-15 P1 已细化至[本卡设计](find-provider-accessibility-plan.md#ed-parity-001)，来源仍为 REQ-01 / CW-SEARCH-001、CW-SHELL-002、CW-NAV-002。生产 Find 延迟 focus 与 modifier 清理已存在，不重复原修复；旧 Windows P3 的 provider/屏幕阅读器缺口只作历史，不继承状态或 PASS。

- 本卡独立 ED-PARITY-001-DEC-01..06、A1..A3、V1..V5、S0..S6 与文件责任、失败/取消/迟到/恢复见设计。
- [参照核对与精确 F0/F2 fixture](references/ed-parity-001-reference.md)；[完整 P2 输入](handoff-p2-ed-parity-001.md)。
- Required evidence 保持 document/code-audit/native/provider/accessibility/idea-comparison；本轮所有产品验证未执行。
- G1 已补本包 Linux Find/Java 导航/hover 原件；G2 用户明确沿用原 AC、播报仍未验证；G3 已明确后续 provider/IME/native readiness 步骤。P1 author 后为 ready、planning_required=false，可交 P2 正式领取。状态只看[唯一板](backlog.md)，没有规划 owner 或第二套状态。

<a id="ed-parity-002"></a>

## ED-PARITY-002 保存期间继续输入的字节与 dirty 保留基线

2026-09-16 P1 已细化至[本卡设计](save-race-baseline-plan.md#ed-parity-002)，来源仍为 [REQ-11](overall-audit-plan-20260913.md#req-11) / CW-EDIT-003。沿用已完成 P0，不重复 ED-SAVE/ED-AUDIT-004/ED-REPAIR-001 历史修复或豁免。

- 仅一个文件保存中输入的冻结字节/live dirty、冲突/取消/恢复保留基线。源码已有单 writer/receipt/owner/recovery；watcher await 后旧快照 merge 为待运行归因风险，不能写成已复现缺陷。
- 本卡 ED-PARITY-002-DEC-01..07、A1..A3、V1..V4、S0..S8、生产责任与共享消费者见设计。
- [Windows IDEA 真实参照与精确 fixture](references/ed-parity-002-reference.md)、[完整 P2 提示词](handoff-p2-ed-parity-002.md)、[文档检查](evidence/ed-parity-002-p1-static.md)。IDEA 内部竞争/unknown 未实采；有效字体/zoom 未核，不签精确视觉 matched。
- Required evidence 为 document/code-audit/native/unit/typecheck；原三种保留，增加定向回归和 scoped typecheck。P2 负责尚不存在的 W1/W2 native 采集及 Windows 用例适配；不能把旧 Linux 用例直接执行或把模拟当原生字节。
- P1 author 后 ready、planning_required=false；状态只看[唯一板](backlog.md)，无开发 owner/claimed_at/baseline。所有产品验证仍未执行，ready 不是产品通过。本轮桌面时段已结束，后续输入重新确认时段。

<a id="ed-parity-003"></a>

## ED-PARITY-003 预览标签转正式标签与分屏共享文档

2026-09-19 P1 已细化至[本卡完整设计](preview-tab-split-plan.md#ed-parity-003)，来源仍为 [REQ-04](overall-audit-plan-20260913.md#req-04) / CW-TAB-001、CW-TAB-002。

- 范围：一个文件经 preview→编辑转正式→分屏→关闭非最后 view 的连续场景；其余 MRU/拖动/重启恢复留在总矩阵。
- 架构与决定：独立 ED-PARITY-003-DEC-01..07、A1..A3、V1..V4、S0..S7 与生产文件/符号责任详见设计文档。
- [Windows IDEA 真实参照与 fixture 工件](references/ed-parity-003-reference.md)；[完整 P2 交接指令](handoff-p2-ed-parity-003.md)。
- Required evidence 保持 `code-audit`、`unit`、`typecheck`、`browser`、`native`、`idea-comparison`；本轮所有产品代码验证未执行。
- P1 规划完成，卡片更新为 ready，`p0.planning_required` 置为 false，可交 P2 正式领取。状态以[唯一任务板](backlog.md)为准，无开发 owner。


<a id="ed-parity-004"></a>

## ED-PARITY-004 Keymap 改键冲突、取消与重开

- 来源：REQ-10 / CW-SET-002；[P0 需求](overall-audit-plan-20260913.md#req-10)、[历史只读材料](../../claudedocs/code-workspace-idea-parity-backlog-shell-layout.md)。
- 已知依据：P0 打开过 Keymap，但未实测改键与冲突；Shell 后续已调整快捷键，不能从旧表推断当前冲突。
- 本包边界：一个已有动作的改键→冲突提示→取消/应用→重开序列；不同时改版完整 Code Style 或 EditorConfig。
- 生产 owner 候选（待核）：KeymapSettingsDialog.tsx、workspaceKeymapScheme.ts、WorkspaceActionHost/registry 与所选动作 caller。
- IDEA/fixture（待核）：隔离 scheme，读取当前 IDEA keymap 和平台修饰键；所选动作由 P1 结合生产 caller 确定。
- ED-PARITY-004-A1：冲突可见；Cancel 不改变有效绑定；Apply 后真实按键派发到正确动作，重开可读到生效配置。
- ED-PARITY-004-A2：同 fixture 的 IDEA/Taomni 功能、视觉、交互分别有结论和准确证据身份；缺侧或不支持明确标记，不能声称 matched。
- ED-PARITY-004-A3：默认 scheme/迁移、Ctrl/Cmd 与 IME 边界、多 workspace owner，保留 Shell 已交付快捷键。
- 验证起点：V1→A1，V2→A2，V3→A3；所需种类为 `code-audit`、`unit`、`typecheck`、`browser`、`native`、`idea-comparison`。具体 case/命令、环境和可复用证据由 P1 核对后写入；本次均未执行。
- ready 前置：核对当前生产及后续交付是否已覆盖目标；确认参考和运行环境；给每个 AC 可观察的正常/错误/取消/恢复断言及消费者回归；依赖只引用本板实际必要的卡。当前无已确认的跨卡依赖，`depends_on=[]` 不代表外部环境已经就绪。

<a id="ed-parity-005"></a>

## ED-PARITY-005 Java 工程就绪后 Basic Completion 接受与撤销

- 来源：REQ-05 / CW-LANG-001、CW-LANG-002；[P0 需求](overall-audit-plan-20260913.md#req-05)、[历史只读材料](../../claudedocs/code-workspace-idea-parity-backlog.md)。
- 已知依据：P0 没有本轮真实 provider 观测，已有历史生产接线和测试不能替代当前语义结果。
- 本包边界：F2 单个 Java 文件从 provider ready→Basic Completion→接受带 import/snippet 候选→undo；其他导航、层级和语言另由 P0 分包。
- 生产 owner 候选（待核）：useWorkspaceLspSession.ts、projectFactsStore.ts、lspCompletion.ts、completionScopeAdapter.ts、CodeMirrorHost.tsx 与 LSP IPC。
- IDEA/fixture（待核）：F2 最小 Java 项目；确认 IDEA build/edition、项目 JDK、JDT LS、import/index readiness 与候选触发点。
- ED-PARITY-005-A1：目标候选集合及来源可解释，选择和接受写入准确正文/import，provider 未就绪或迟到结果不会冒充当前候选。
- ED-PARITY-005-A2：同 fixture 的 IDEA/Taomni 功能、视觉、交互分别有结论和准确证据身份；缺侧或不支持明确标记，不能声称 matched。
- ED-PARITY-005-A3：snippet/自动导入一次 undo、Esc 零提交、跨 workspace/session 不串结果。
- 验证起点：V1→A1，V2→A2，V3→A3；所需种类为 `code-audit`、`unit`、`typecheck`、`native`、`provider`、`idea-comparison`。具体 case/命令、环境和可复用证据由 P1 核对后写入；本次均未执行。
- ready 前置：核对当前生产及后续交付是否已覆盖目标；确认参考和运行环境；给每个 AC 可观察的正常/错误/取消/恢复断言及消费者回归；依赖只引用本板实际必要的卡。当前无已确认的跨卡依赖，`depends_on=[]` 不代表外部环境已经就绪。

<a id="ed-parity-006"></a>

## ED-PARITY-006 项目搜索排除结果、替换预览与取消

- 来源：REQ-08 / CW-SEARCH-002；[P0 需求](overall-audit-plan-20260913.md#req-08)、[历史只读材料](../../claudedocs/code-workspace-idea-parity-backlog.md)。
- 已知依据：P0 B12 只有空面板；源码记录已存在 scope/preview/frozen preimage 接线，旧“未接线”描述不作为新 bug。
- 本包边界：明确 scope/mask 的两文件搜索→排除一个结果→预览→取消/提交→undo；冲突负路径由 P1 在同一包内限定，避免全搜索引擎重构。
- 生产 owner 候选（待核）：FindInFilesPanel.tsx、ReplacePreviewDialog.tsx、findInFilesScopeModel.ts 与 CodeWorkspaceTab.tsx apply/history caller。
- IDEA/fixture（待核）：F1/F5 隔离两文件，列出初始字节、搜索范围、结果集合、排除项及外部变化时点。
- ED-PARITY-006-A1：scope/mask 与排除后的提交集合准确，预览/取消/冲突反馈和焦点序列有双侧参照。
- ED-PARITY-006-A2：同 fixture 的 IDEA/Taomni 功能、视觉、交互分别有结论和准确证据身份；缺侧或不支持明确标记，不能声称 matched。
- ED-PARITY-006-A3：Cancel 零 commit、冻结 preimage 检查、一次 undo 恢复实际修改文件，保留本地 Find。
- 验证起点：V1→A1，V2→A2，V3→A3；所需种类为 `code-audit`、`unit`、`typecheck`、`browser`、`native`、`idea-comparison`。具体 case/命令、环境和可复用证据由 P1 核对后写入；本次均未执行。
- ready 前置：核对当前生产及后续交付是否已覆盖目标；确认参考和运行环境；给每个 AC 可观察的正常/错误/取消/恢复断言及消费者回归；依赖只引用本板实际必要的卡。当前无已确认的跨卡依赖，`depends_on=[]` 不代表外部环境已经就绪。

<a id="ed-parity-007"></a>

## ED-PARITY-007 Java Extract Method 的支持边界、预览与撤销

- 来源：REQ-06 / CW-REFACTOR-002；[P0 需求](overall-audit-plan-20260913.md#req-06)、[历史只读材料](../../claudedocs/code-workspace-idea-parity-backlog.md)。
- 已知依据：P0 REQ-06 的 provider 能力与双侧交互待证；ED-REF-001 已在后续交付中记录 done，仅作 Rename 保留来源。
- 本包边界：只选择一个可复现 Java Extract Method 场景，先确定 provider 是否支持，再形成真实差距的设计；不重复 Rename，不同时承接 Inline/Move/Change Signature。
- 生产 owner 候选（待核）：CodeWorkspaceTab.tsx refactor/code action caller、refactorPlan.ts、LSP codeAction 与 canonical apply/history。
- IDEA/fixture（待核）：F2 Java 方法中的明确选区；确认目标 IDEA/JDT LS action kind、输入和预期程序结果。
- ED-PARITY-007-A1：受支持动作有正确输入/预览/结果；不支持时给出准确边界，不能把拒绝动作当 Extract 已对齐。
- ED-PARITY-007-A2：同 fixture 的 IDEA/Taomni 功能、视觉、交互分别有结论和准确证据身份；缺侧或不支持明确标记，不能声称 matched。
- ED-PARITY-007-A3：取消零效果、冲突检测、资源/文本 undo、已交付 Rename 与 recovery 契约。
- 验证起点：V1→A1，V2→A2，V3→A3；所需种类为 `code-audit`、`unit`、`typecheck`、`native`、`provider`、`idea-comparison`。具体 case/命令、环境和可复用证据由 P1 核对后写入；本次均未执行。
- ready 前置：核对当前生产及后续交付是否已覆盖目标；确认参考和运行环境；给每个 AC 可观察的正常/错误/取消/恢复断言及消费者回归；依赖只引用本板实际必要的卡。当前无已确认的跨卡依赖，`depends_on=[]` 不代表外部环境已经就绪。

<a id="ed-parity-008"></a>

## ED-PARITY-008 两个本地仓库间切换 Git diff 上下文

- 来源：REQ-07 / CW-GIT-001、CW-GIT-003；[P0 需求](overall-audit-plan-20260913.md#req-07)、[历史只读材料](../../claudedocs/code-workspace-idea-parity-backlog.md)。
- 已知依据：P0 Git 仅有源码路径，无真实 Git fixture；REQ-07 的其余运行调试目标仍在总矩阵。
- 本包边界：F3 两个隔离本地 repo 的文件状态→打开 diff→切 root→返回编辑器；不 commit/push，不扩到 merge/rebase 或 Run/Debug。
- 生产 owner 候选（待核）：useWorkspaceGitSnapshots.ts、WorkspaceGitManager.tsx、DiffViewer.tsx、lib/git.ts 与 Rust git_* caller。
- IDEA/fixture（待核）：F3 两个临时本地 repo，有已知 HEAD 与未提交差异；IDEA 多 root 参照要记录当前 root。
- ED-PARITY-008-A1：状态/diff 与选中 repo 的 index/HEAD/worktree 一致，切 root 不展示或操作另一个 repo 的数据。
- ED-PARITY-008-A2：同 fixture 的 IDEA/Taomni 功能、视觉、交互分别有结论和准确证据身份；缺侧或不支持明确标记，不能声称 matched。
- ED-PARITY-008-A3：返回编辑器保持 dirty/selection，关闭和取消零 Git 写入，异步迟到结果不串 root。
- 验证起点：V1→A1，V2→A2，V3→A3；所需种类为 `code-audit`、`unit`、`typecheck`、`native`、`idea-comparison`。具体 case/命令、环境和可复用证据由 P1 核对后写入；本次均未执行。
- ready 前置：核对当前生产及后续交付是否已覆盖目标；确认参考和运行环境；给每个 AC 可观察的正常/错误/取消/恢复断言及消费者回归；依赖只引用本板实际必要的卡。当前无已确认的跨卡依赖，`depends_on=[]` 不代表外部环境已经就绪。

<a id="ed-parity-009"></a>

## ED-PARITY-009 Java Structural Search 的首个结构匹配场景

- 来源：REQ-09 / CW-SEARCH-003；[P0 需求](overall-audit-plan-20260913.md#req-09)、[历史只读材料](../../claudedocs/code-workspace-idea-parity-backlog-2026-09-audit.md)。
- 已知依据：P0 静态记录 SSR 语言集合为空；本次仅补录该需求，当前生产引擎是否已有变化由 P1 核对。
- 本包边界：先确定一个 Java 结构模式、变量约束和准确匹配集合，再设计最小可用结构搜索；Replace、Full Line、Smart Completion 留作后续独立包。
- 生产 owner 候选（待核）：结构搜索入口和候选 parser/provider 接入位置由 P1 查当前 caller 后明确；禁止把普通 regex 搜索标为 SSR。
- IDEA/fixture（待核）：隔离 Java 正例/反例字节，目标 IDEA SSR 模式和变量约束；确认 edition/内建插件范围。
- ED-PARITY-009-A1：按结构和变量约束返回准确位置集合，取消/无匹配/不可用状态明确，UI 与交互有目标参照。
- ED-PARITY-009-A2：同 fixture 的 IDEA/Taomni 功能、视觉、交互分别有结论和准确证据身份；缺侧或不支持明确标记，不能声称 matched。
- ED-PARITY-009-A3：普通项目搜索与本地 Find 继续可用，搜索不写文件，取消与资源释放正确。
- 验证起点：V1→A1，V2→A2，V3→A3；所需种类为 `code-audit`、`unit`、`typecheck`、`browser`、`native`、`idea-comparison`。具体 case/命令、环境和可复用证据由 P1 核对后写入；本次均未执行。
- ready 前置：核对当前生产及后续交付是否已覆盖目标；确认参考和运行环境；给每个 AC 可观察的正常/错误/取消/恢复断言及消费者回归；依赖只引用本板实际必要的卡。当前无已确认的跨卡依赖，`depends_on=[]` 不代表外部环境已经就绪。
