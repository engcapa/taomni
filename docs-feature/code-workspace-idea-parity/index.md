# Code Workspace IDEA 总需求与评估入口

本入口按用户请求于 2026-09-13 首次建立。目标是功能、视觉与交互高度一致，当前布局不作为保留约束。本文件只维护来源、链接和派生摘要；开发状态唯一来源为下述新任务板。

首次 P0 基线：`audit/plan` 整体 Code Workspace，起始分支 `main`、HEAD `27f99b6116f4f6aae906d324cb84e8359695e17a`。首次评估已经完成，之后已有多轮 P1–P3；后续无需重新执行首次 P0。

## 当前任务入口（2026-09-16）

**2026-09-16 P1 完成：** [ED-PARITY-002](save-race-baseline-plan.md#ed-parity-002)，来源 REQ-11 / CW-EDIT-003；[Windows 真实参考与 fixture](references/ed-parity-002-reference.md)、[完整 P2 提示词](handoff-p2-ed-parity-002.md)、[静态检查](evidence/ed-parity-002-p1-static.md)、[源码/工件身份](evidence/ed-parity-002-p1-identity.json)。唯一板同卡 ready/planning_required=false，无开发 owner；P2 建立 W1/W2 原生时点/字节保留基线，watcher await 风险待运行归因。仅 P1 规划就绪，不是 Taomni 功能/UI/交互已对齐。产品测试/构建/启动/领取/实现均未执行；IDEA 本轮独占采样已结束并归还桌面。实时状态继续以 backlog.md 为准。

下段 ED-PARITY-001 的 ready 是当时 P1 快照，后续执行状态读取新板，不据此重复规划或领取 done 卡。


**2026-09-15 P1 完成：** [ED-PARITY-001](find-provider-accessibility-plan.md#ed-parity-001)（REQ-01 / CW-SEARCH-001、CW-SHELL-002、CW-NAV-002）已完成补证设计、独立 DEC/AC/V 与保留断言；[Linux 真实参照](references/ed-parity-001-reference.md#observed)、[完整 P2 提示词](handoff-p2-ed-parity-001.md)、[静态核对](evidence/ed-parity-001-p1-static.md)。唯一板同卡 ready/planning_required=false，无开发owner；用户已确认播报保留未验证。两段IDEA采样结束并归还桌面。本结论只是P1规划就绪，不是Taomni功能/UI/交互已对齐，产品测试/构建/领取/实现均未执行。


- **唯一新任务板：[backlog.md](backlog.md)**，新卡 ID 为 `ED-PARITY-xxx`。P0 从真实差距产卡；P1 自动选定一张卡做规划；P2 在该卡 ready 后正式领取开发。禁止混入或接续 `claudedocs/` 旧板任务。
- **可直接复制：[固定 P1 提示词](handoff-p1-next.md)**。无需填写任务或环境参数；缺少影响设计的 IDEA 信息时，P1 可以询问用户。
- [P0 新卡待细化规格](task-planning.md)：当前是文档补录的起点，必须完成 P1 才能进入开发。
- [原协作模板](agent-collaboration-prompts.md)：保留原带参数 P1；P0 模板现要求产出新卡，后续增量继续维护同一板。

本次依据已有 P0 与后续交付记录补录新卡，没有重跑 P0、产品测试或比较，也没有迁移历史 owner/状态/PASS。
旧卡和本页下方历史“唯一板”“未实施”“不可领取”等语句只说明当时情况，**不再是当前选板指令**。
旧任务 metadata 保留原样；卡 done 与整场景三维对齐仍分别判断。

| P0 来源 | 新板接续 | 已有交付如何使用 |
|---|---|---|
| REQ-01 | ED-PARITY-001 | 旧 Find implemented 仅作已实现基础；本次新目标是尚缺证据的判断与补足 |
| REQ-11 / REQ-04 | ED-PARITY-002 / 003 | 保存竞争保留基线、preview/分屏首包；不复刻旧整域队列 |
| REQ-10 / REQ-05 | ED-PARITY-004 / 005 | 改键冲突、Java Basic Completion 首包 |
| REQ-08 / REQ-06 | ED-PARITY-006 / 007 | 项目替换预览、Extract Method；旧 Rename done 不重领 |
| REQ-07 / REQ-09 | ED-PARITY-008 / 009 | 本地多 repo diff、Java Structural Search 首包 |
| REQ-02 / REQ-03 | 暂不重复创建已交付首包 | 旧 Tree/Shell metadata 均为 done；未覆盖范围留在矩阵，后续 P0 增量按具体差距产卡 |

这张表仅关联需求与卡，不保存另一份任务状态；实时规划/开发资格读取 backlog.md。新卡均有独立 AC 和 P0 来源，9 张首包卡不代表覆盖或完成全部 45 场景。

## 有效材料

| 材料 | 作用 |
|---|---|
| [总需求 / overall audit plan](overall-audit-plan-20260913.md) | 目标、45场景分母、需求排序、增量、首包与待决条件 |
| [唯一整体能力矩阵](capability-matrix.md) | 45个稳定场景的功能/视觉/交互独立结论、入口/调用链、证据/当前性、需求/验收与历史任务映射 |
| [当前Taomni基线](references/taomni-baseline-20260913.md) | 先打印的真实UI、21张browser截图、实际步骤、焦点/异常/取消/恢复与缺失状态 |
| [IDEA复用与对照摘要](references/idea-comparison-audit-20260913.md) | 目标IU-262.10315.125、有效旧tree参照、本轮新采样阻塞、双侧局部差异 |
| [fixture目录与平台/语言边界](references/fixture-catalog.md) | F0实采字节；F1–F5未执行的补采规格与条件 |
| [当前生产源码审查](source-audit.md) | 每域caller/owner/IPC/provider与旧线索纠正依据 |
| [证据身份](evidence/provenance-20260913.json) / [源码映射](evidence/source-map-20260913.json) | HEAD、source/runner/case/build/config/mode、原图hash与current/historical/stale/unverified依据 |
| [固定 P1：自动选卡规划](handoff-p1-next.md) | 当前直接使用的入口；从 backlog.md 选一张 P0 新卡 |
| [历史 Find P1](handoff-p1-find-focus.md) | 原首包交接记录，仅供查历史目标与参照，不再作为选卡入口 |
| [ED-REF-001 设计](refactor-rename-design.md) | Rename/Refactor 完整性、冲突、post-hash、undo/restart recovery 的当前审计与 P2 验收设计 |
| [ED-REF-001 IDEA 参照](references/refactor-rename-idea-2026.2.2.md) | IDEA 2026.2.2 Rename Preview/取消/确认/Undo 的匹配 fixture、步骤、状态与补采缺口 |
| [ED-REF-001 P2 交接](handoff-p2-refactor-rename.md) | 历史旧卡开发交接，仅供审查原范围，不再复制为新开发指令 |
| [ED-REF-001 P3 交接](handoff-p3-refactor-rename.md) | 历史旧卡验收合同和证据核对依据，不改变当前新板入口 |

## 首次 P0 结论（2026-09-13 历史快照）

45场景 / 11域 / 135个三维格；16场景有本轮局部实际UI记录，29场景仍需按矩阵补采。只有项目树方向/Enter等子动作有可复用双侧依据，完整三维通过0、关闭差距0。没有总体对齐百分比。

新事实：Ctrl+F两次触发CodeMirror更新重入异常（REQ-01）；Enter打开文件后Taomni仍树焦点而IDEA进入editor（REQ-02局部）。21张current浏览器原图不是native证明；历史Windows tree native报告为stale，原因是source/runner/build identity变化。IDEA新交互采样因前台激活失败缺失；旧08:31–08:36参照仅在其原范围复用，不刷新日期。

总需求新增REQ-01..11，重点区分确认browser缺陷、静态引擎缺失、体验差异、纯证据缺口与待归因风险。旧任务done不作为完成依据，旧修复规格保留；没有新建owner/ready/done流程，没有改任务板。

## REQ-01 的 P1 增量（2026-09-14）

仅规划 `WP-FIND-FOCUS-01`，没有重新做 P0。实际 HEAD `884d003846a8549cc3125090eaf55359bc676a3f` / `docs/code-workspace-idea-audit-20260913`，接手干净；上述十份 P0 文档已提交，生产内容仍与 P0 一致。P0 结论与原图保留，不补签产品 PASS。

- [唯一开发板 / ED-FINDFOCUS-001](../../claudedocs/code-workspace-idea-parity-backlog-find-focus.md)：实际开发状态与领取资格只看此板。
- [修复设计 / DEC、AC、V](../../docs-issue/code-workspace-find-focus-design.md)、[图稿](../../docs-issue/find-focus/find-focus-v1.png)：覆盖 REQ-01-F/I/V/R，保护 CW-NAV-002 hover、CW-TAB-002 多 view 与 clipboard owner。
- [Find 真参照](references/find-focus-2026.2.2.md)：目标 build 的两轮独占序列；Esc 保留当前匹配 selection，不强制回到打开前 caret；输入污染段及个人设置页不转作参照。
- [P1 provenance](evidence/find-focus-plan-20260914.json)、[P2 完整接续提示词](handoff-p2-find-focus.md)。本轮产品测试/runner/构建均为零；没有关闭任何整体场景差距。

## 历史材料与接续规则

原 [project-tree E2E](skill-e2e-project-tree.md)、[tree参照](references/project-tree-navigation-2026.2.2.md)、[tree任务板](../../claudedocs/code-workspace-idea-parity-backlog-2026-09-tree-e2e.md) 仍保留原合同与日期。`claudedocs/code-workspace-idea-2026-*-capability-matrix.md` 是各轮原范围的历史发布/修复汇总，不与本总矩阵竞争开发状态来源；每场景的具体关联板/ID见矩阵。

接续先核对本轮HEAD及source/caller、目标设置、fixture、case/runner/build/mode变化。只重判受影响项；无变化项保留2026-09-13日期，不补签新PASS。新增/拆分/合并/移出场景必须记录ID映射及分母变化；用户未明确接受的差异不能关闭。历史完成事实从原板只读核对；当前新差距由 P0 写入 backlog.md，P1 细化同一卡，再交 P2 领取开发。

本轮原件位于本机 `qa-ui-auto-report/overall-audit-20260913/`，历史IDEA有效原件位于 `qa-ui-auto-report/project-tree-e2e/idea/`。均被忽略；其他机器须取得精确原件或补采，不能仅凭摘要继承通过。

## 2026-09-14 REQ-02 首包 P1 增量

- 首包 `WP-TREE-OPEN-FOCUS-01`：CW-PROJ-002，CW-PROJ-003 仅 Open/cancel；[唯一任务板](../../claudedocs/code-workspace-idea-parity-backlog-tree-open-focus.md) / `ED-TREEOPEN-001`。状态以板 metadata 为准，P1 未领取/实施。
- [设计 DEC/AC/V](../../docs-issue/code-workspace-tree-open-focus-design.md#ed-treeopen-001)、[Linux 2026.2.2 真实参照](references/project-tree-open-focus-linux-2026.2.2.md)、[状态图](references/tree-open-focus-states.svg)、[身份](evidence/tree-open-focus-plan-20260914.json)、[原件 hash 清单](evidence/tree-open-focus-artifacts-20260914.json)、[完整 P2 交接](handoff-p2-tree-open-focus.md)。
- 用户确认：文件/目录标签单击只选择，文件双击/Enter 正式打开，箭头展开；保留其他入口 preview 数据/策略，不改全局 preview 默认。旧 mouse 合同有显式修订，不改旧 ED-TREE-001 done；Find 卡仍 implemented，已有实现不接管状态。
- 本机 IDEA 新增参照不关闭 P0 的 Taomni 差距；CW-PROJ-002 2026-09-13 历史三维结论保留。产品测试、构建、Taomni/runner 启动为零。桌面补采已结束并归还；后续真实输入需重新约独占时段。


## 2026-09-14 REQ-03 首包 P1 增量

接手分支 `docs/code-workspace-idea-audit-20260913` / HEAD `0694a03f839827402a628f6c7b2ccbb0c997dd0e`，接手干净。只处理 WP-SHELL-LAYOUT-01，没有重新做 P0；原日期和三维结论保留。

- [新任务板 / ED-SHELLLAYOUT-001](../../claudedocs/code-workspace-idea-parity-backlog-shell-layout.md#ed-shelllayout-001)：开发状态和领取资格只看metadata。第二轮主要动作已补，剩余profile/最小尺寸/overflow定值未齐，暂不在可领取队列；没有owner或claim。首次author过早写ready，已于同轮纠正，不能引用中间输出领取。
- [设计 AC / DEC / R / V](shell-layout-design.md)、[图稿 v2预览](shell-layout-wireframe.png) / [drawio](shell-layout-wireframe.drawio)、[有前置门槛的完整P2提示词](handoff-p2-shell-layout.md)。
- [Linux IDEA局部参照](references/shell-layout-2026.2.2-linux.md)、[身份](evidence/shell-layout-plan-20260914.json)、[hash工件清单](evidence/shell-layout-artifacts-20260914.json)。已有Tree187件校验一致；本轮只证明局部IDEA状态，不关闭Taomni差距。
- 更新主 CW-SHELL-001、配套 CW-SET-001 和真实共享消费者；Tree done / Find implemented 原卡状态不变。产品测试、build、Taomni/browser/native runner均0；QA只读plan一次。桌面已归还。

2026-09-14 21:22补采修订：用户已采纳图稿v2默认结构，BL-SL-02已解除。第二轮补齐Project折叠重开、bottom真实resize及记忆、Run空态、Problems Esc直接输入/undo、Restore Current Layout、干净窄窗和主题/UI字体/zoom/keymap。BL-SL-01收敛到Font/lineHeight/density/effective scale、真实min/max及overflow细节；板仍不在可领取队列。桌面已归还，本轮没有Taomni执行或三维matched。
