# P0 差距任务板

## 1. 唯一选板与来源

本板路径固定为 `docs-feature/code-workspace-idea-parity/backlog.md`，是本工作流后续 P1 选卡、P2/P5 开发领取的唯一任务来源。新 ID 使用 `ED-PARITY-xxx`；不得从任何 `claudedocs/code-workspace-idea-parity-backlog*.md` 领取、接续或复制旧卡状态。

2026-09-15 按用户要求，从已完成的 P0 `AUDIT-20260913-01` 及后续文档补录独立任务卡。文档整理 HEAD 为 `c7bbdee56cef0478d35aaa8d17124e30a299768a`；没有重新运行 P0 首次评估，没有复查生产行为、运行产品测试或签发新证据。新卡只承载明确限定的后续目标，均为待 P1 细化的 `deferred`，不继承历史 owner、ready/implemented/done 或 PASS。

- P0 负责从新差距创建卡、查重和维护需求映射；增量 P0 继续维护本板，不另建日期板。
- P1 的“领取”是自动选定一张卡并承担本次规划，不调用开发 `claim`。只选择 `status=deferred` 且 `p0.planning_required=true`、当前无人修改的卡；按优先级、依赖条件、板内顺序选择。选中后在聊天明确 `完整板路径::ID`，不再另设规划 owner/status。
- P1 完成真实设计、AC/V、参照及前置核对后，在 authoring 流程中把同一卡改为 `ready`，将 `p0.planning_required` 改为 `false`。缺信息时可以询问用户，卡保持 `deferred` 并写具体缺口，不能虚构可开发状态。若已满足而无需后续工作，由 P0 依据证据处理，不造开发任务。
- P2/P5 只领取本板 `ready/implemented` 且 `p0.planning_required=false`、依赖全 done 的卡；每个 task-board 命令必须显式带本板 `--doc`。P3/P4 接续同一卡；当前卡引入的回归仍由当前卡处理。无符合项时报告下一阶段，不回退历史板。
- `p0` 保存需求来源及是否待规划；执行状态、owner、依赖和证据只在本板 metadata 中维护。历史关联是只读来源，不是跨板执行依赖。

## 2. 规格与既有交付

[总需求](overall-audit-plan-20260913.md) / [能力矩阵](capability-matrix.md) / [待细化规格](task-planning.md) / [固定 P1 提示词](handoff-p1-next.md)。P1 在对应新 ID 的规格节细化，不借旧卡 AC 充当新卡验收。

| 既有工作 | 本次只读关联 | 后续处理 |
|---|---|---|
| Find 焦点 | [ED-FINDFOCUS-001](../../claudedocs/code-workspace-idea-parity-backlog-find-focus.md)，metadata 为 implemented | 新 ED-PARITY-001 仅规划尚缺的证据/目标判断，不重复原修复 |
| 树打开与焦点 | [ED-TREEOPEN-001](../../claudedocs/code-workspace-idea-parity-backlog-tree-open-focus.md)，metadata 为 done | 保留原交付；REQ-02 剩余树菜单等范围留矩阵，待 P0 发现具体差距再建新卡 |
| Shell 布局 | [ED-SHELLLAYOUT-001](../../claudedocs/code-workspace-idea-parity-backlog-shell-layout.md)，metadata 为 done | 保留原交付；REQ-03 整体三维结论仍需增量回填，不重复首包 |
| Rename/Refactor | [ED-REF-001](../../claudedocs/code-workspace-idea-parity-backlog.md)，metadata 为 done | 保留原交付；REQ-06 本板仅展开 Extract Method 首包 |

这些是 2026-09-15 读到的历史记录，不代表本次重新验收通过。原卡 metadata 原样保留。REQ-04..11 的未展开场景继续留在矩阵，本板不是 45 场景的覆盖率分母。

## 3. 交付门槛

每张卡目前只有 P0 目标和 P1 的细化起点；生产 owner、完整 DEC/AC/V、负路径和执行前置未核齐前不可 ready。P1 默认仅文档/源码审查、IDEA 最小参照及 QA 只读 plan/status，不启动 Taomni、产品测试或构建。当前端验证由后续 P2 按卡实施，Windows/macOS/Linux 逐端记录；证据卡不得为了制造代码改动而修复未证实 bug。

P1 在新规格中确认所需证据种类与 metadata 一致。产品改动要求 scoped typecheck 和必要回归；纯补证卡按目标选最小检查，不继承旧板全量 build gate。若本包确有全仓集成需求，应回到 P0 建立本板专属集成卡，不借旧 ED-GATE-003 的 done。

```bash
python .agents/skills/code-workspace-idea-task/scripts/task_board.py --doc docs-feature/code-workspace-idea-parity/backlog.md validate
python .agents/skills/code-workspace-idea-task/scripts/task_board.py --doc docs-feature/code-workspace-idea-parity/backlog.md list --status deferred --json
```

## 4. P0 新任务卡

### ED-PARITY-001 Find 已实现后的 provider 与可访问性证据接续
<!-- ide-task {"id":"ED-PARITY-001","status":"deferred","priority":"P0","size":"M","depends_on":[],"spec":"docs-feature/code-workspace-idea-parity/task-planning.md#ed-parity-001","acceptance":["ED-PARITY-001-A1","ED-PARITY-001-A2","ED-PARITY-001-A3"],"required_evidence":["document","code-audit","native","provider","accessibility","idea-comparison"],"audit":{"date":"2026-09-15","head":"c7bbdee56cef0478d35aaa8d17124e30a299768a","finding":"根据 P0 及后续文档补录待规划目标，未重新核验生产行为。旧 ED-FINDFOCUS-001 为 implemented；P3 已记录 Windows native/IME/zoom，仍列有真实 JDT LS 与屏幕阅读器缺口。该状态仅作历史事实，不继承为新卡状态。"},"prior_completion":{"kind":"new-task","completed":false},"p0":{"audit_id":"AUDIT-20260913-01","requirements":["REQ-01"],"scenarios":["CW-SEARCH-001","CW-SHELL-002","CW-NAV-002"],"planning_required":true},"note":"P1 待核当前差距、参照、完整 AC/V、owner 与环境前置；不能按开发 ready 领取。"} -->

来源：REQ-01 / CW-SEARCH-001、CW-SHELL-002、CW-NAV-002。范围：核对 Find 已交付实现与当前源码身份，只处理原报告明确未完成的真实 provider/可访问性要求及其必要焦点序列。已有重入修复不重复开发，屏幕阅读器是否属于目标要求由 P1 对照原 AC 确认。

[本卡规格与待核条件](task-planning.md#ed-parity-001)；[历史只读来源](../../claudedocs/code-workspace-idea-parity-backlog-find-focus.md)。

### ED-PARITY-002 保存期间继续输入的字节与 dirty 保留基线
<!-- ide-task {"id":"ED-PARITY-002","status":"deferred","priority":"P0","size":"M","depends_on":[],"spec":"docs-feature/code-workspace-idea-parity/task-planning.md#ed-parity-002","acceptance":["ED-PARITY-002-A1","ED-PARITY-002-A2","ED-PARITY-002-A3"],"required_evidence":["document","code-audit","native"],"audit":{"date":"2026-09-15","head":"c7bbdee56cef0478d35aaa8d17124e30a299768a","finding":"根据 P0 及后续文档补录待规划目标，未重新核验生产行为。P0 的 REQ-11 未采 native 保存；后续卡有局部 save/undo 证据，须先检查能否覆盖本序列，不能将缺证据直接写成保存 bug。"},"prior_completion":{"kind":"new-task","completed":false},"p0":{"audit_id":"AUDIT-20260913-01","requirements":["REQ-11"],"scenarios":["CW-EDIT-003"],"planning_required":true},"note":"P1 待核当前差距、参照、完整 AC/V、owner 与环境前置；不能按开发 ready 领取。"} -->

来源：REQ-11 / CW-EDIT-003。范围：仅取一个文件保存期间继续输入的成功/冲突序列，补当前端磁盘字节与 dirty 的可观察基线；发现反例后才设计修复。不扩到全部 Local History、剪贴板或 IME。

[本卡规格与待核条件](task-planning.md#ed-parity-002)；[历史只读来源](../../claudedocs/code-workspace-idea-parity-backlog-2026-09-main-repair.md)。

### ED-PARITY-003 预览标签转正式标签与分屏共享文档
<!-- ide-task {"id":"ED-PARITY-003","status":"deferred","priority":"P1","size":"M","depends_on":[],"spec":"docs-feature/code-workspace-idea-parity/task-planning.md#ed-parity-003","acceptance":["ED-PARITY-003-A1","ED-PARITY-003-A2","ED-PARITY-003-A3"],"required_evidence":["code-audit","unit","typecheck","browser","native","idea-comparison"],"audit":{"date":"2026-09-15","head":"c7bbdee56cef0478d35aaa8d17124e30a299768a","finding":"根据 P0 及后续文档补录待规划目标，未重新核验生产行为。P0 只观察双 pane 和 policy Cancel；Tree/Shell 后续交付涉及打开和布局，P1 先复核这些保留证据后确定真正差距。"},"prior_completion":{"kind":"new-task","completed":false},"p0":{"audit_id":"AUDIT-20260913-01","requirements":["REQ-04"],"scenarios":["CW-TAB-001","CW-TAB-002"],"planning_required":true},"note":"P1 待核当前差距、参照、完整 AC/V、owner 与环境前置；不能按开发 ready 领取。"} -->

来源：REQ-04 / CW-TAB-001、CW-TAB-002。范围：一个文件经 preview→编辑转正式→分屏→关闭非最后 view 的连续场景；其余 MRU/拖动/重启恢复留在总矩阵，不将整域塞入一张卡。

[本卡规格与待核条件](task-planning.md#ed-parity-003)；[历史只读来源](../../claudedocs/code-workspace-idea-parity-backlog.md)。

### ED-PARITY-004 Keymap 改键冲突、取消与重开
<!-- ide-task {"id":"ED-PARITY-004","status":"deferred","priority":"P1","size":"M","depends_on":[],"spec":"docs-feature/code-workspace-idea-parity/task-planning.md#ed-parity-004","acceptance":["ED-PARITY-004-A1","ED-PARITY-004-A2","ED-PARITY-004-A3"],"required_evidence":["code-audit","unit","typecheck","browser","native","idea-comparison"],"audit":{"date":"2026-09-15","head":"c7bbdee56cef0478d35aaa8d17124e30a299768a","finding":"根据 P0 及后续文档补录待规划目标，未重新核验生产行为。P0 打开过 Keymap，但未实测改键与冲突；Shell 后续已调整快捷键，不能从旧表推断当前冲突。"},"prior_completion":{"kind":"new-task","completed":false},"p0":{"audit_id":"AUDIT-20260913-01","requirements":["REQ-10"],"scenarios":["CW-SET-002"],"planning_required":true},"note":"P1 待核当前差距、参照、完整 AC/V、owner 与环境前置；不能按开发 ready 领取。"} -->

来源：REQ-10 / CW-SET-002。范围：一个已有动作的改键→冲突提示→取消/应用→重开序列；不同时改版完整 Code Style 或 EditorConfig。

[本卡规格与待核条件](task-planning.md#ed-parity-004)；[历史只读来源](../../claudedocs/code-workspace-idea-parity-backlog-shell-layout.md)。

### ED-PARITY-005 Java 工程就绪后 Basic Completion 接受与撤销
<!-- ide-task {"id":"ED-PARITY-005","status":"deferred","priority":"P1","size":"M","depends_on":[],"spec":"docs-feature/code-workspace-idea-parity/task-planning.md#ed-parity-005","acceptance":["ED-PARITY-005-A1","ED-PARITY-005-A2","ED-PARITY-005-A3"],"required_evidence":["code-audit","unit","typecheck","native","provider","idea-comparison"],"audit":{"date":"2026-09-15","head":"c7bbdee56cef0478d35aaa8d17124e30a299768a","finding":"根据 P0 及后续文档补录待规划目标，未重新核验生产行为。P0 没有本轮真实 provider 观测，已有历史生产接线和测试不能替代当前语义结果。"},"prior_completion":{"kind":"new-task","completed":false},"p0":{"audit_id":"AUDIT-20260913-01","requirements":["REQ-05"],"scenarios":["CW-LANG-001","CW-LANG-002"],"planning_required":true},"note":"P1 待核当前差距、参照、完整 AC/V、owner 与环境前置；不能按开发 ready 领取。"} -->

来源：REQ-05 / CW-LANG-001、CW-LANG-002。范围：F2 单个 Java 文件从 provider ready→Basic Completion→接受带 import/snippet 候选→undo；其他导航、层级和语言另由 P0 分包。

[本卡规格与待核条件](task-planning.md#ed-parity-005)；[历史只读来源](../../claudedocs/code-workspace-idea-parity-backlog.md)。

### ED-PARITY-006 项目搜索排除结果、替换预览与取消
<!-- ide-task {"id":"ED-PARITY-006","status":"deferred","priority":"P1","size":"M","depends_on":[],"spec":"docs-feature/code-workspace-idea-parity/task-planning.md#ed-parity-006","acceptance":["ED-PARITY-006-A1","ED-PARITY-006-A2","ED-PARITY-006-A3"],"required_evidence":["code-audit","unit","typecheck","browser","native","idea-comparison"],"audit":{"date":"2026-09-15","head":"c7bbdee56cef0478d35aaa8d17124e30a299768a","finding":"根据 P0 及后续文档补录待规划目标，未重新核验生产行为。P0 B12 只有空面板；源码记录已存在 scope/preview/frozen preimage 接线，旧“未接线”描述不作为新 bug。"},"prior_completion":{"kind":"new-task","completed":false},"p0":{"audit_id":"AUDIT-20260913-01","requirements":["REQ-08"],"scenarios":["CW-SEARCH-002"],"planning_required":true},"note":"P1 待核当前差距、参照、完整 AC/V、owner 与环境前置；不能按开发 ready 领取。"} -->

来源：REQ-08 / CW-SEARCH-002。范围：明确 scope/mask 的两文件搜索→排除一个结果→预览→取消/提交→undo；冲突负路径由 P1 在同一包内限定，避免全搜索引擎重构。

[本卡规格与待核条件](task-planning.md#ed-parity-006)；[历史只读来源](../../claudedocs/code-workspace-idea-parity-backlog.md)。

### ED-PARITY-007 Java Extract Method 的支持边界、预览与撤销
<!-- ide-task {"id":"ED-PARITY-007","status":"deferred","priority":"P1","size":"M","depends_on":[],"spec":"docs-feature/code-workspace-idea-parity/task-planning.md#ed-parity-007","acceptance":["ED-PARITY-007-A1","ED-PARITY-007-A2","ED-PARITY-007-A3"],"required_evidence":["code-audit","unit","typecheck","native","provider","idea-comparison"],"audit":{"date":"2026-09-15","head":"c7bbdee56cef0478d35aaa8d17124e30a299768a","finding":"根据 P0 及后续文档补录待规划目标，未重新核验生产行为。P0 REQ-06 的 provider 能力与双侧交互待证；ED-REF-001 已在后续交付中记录 done，仅作 Rename 保留来源。"},"prior_completion":{"kind":"new-task","completed":false},"p0":{"audit_id":"AUDIT-20260913-01","requirements":["REQ-06"],"scenarios":["CW-REFACTOR-002"],"planning_required":true},"note":"P1 待核当前差距、参照、完整 AC/V、owner 与环境前置；不能按开发 ready 领取。"} -->

来源：REQ-06 / CW-REFACTOR-002。范围：只选择一个可复现 Java Extract Method 场景，先确定 provider 是否支持，再形成真实差距的设计；不重复 Rename，不同时承接 Inline/Move/Change Signature。

[本卡规格与待核条件](task-planning.md#ed-parity-007)；[历史只读来源](../../claudedocs/code-workspace-idea-parity-backlog.md)。

### ED-PARITY-008 两个本地仓库间切换 Git diff 上下文
<!-- ide-task {"id":"ED-PARITY-008","status":"deferred","priority":"P1","size":"M","depends_on":[],"spec":"docs-feature/code-workspace-idea-parity/task-planning.md#ed-parity-008","acceptance":["ED-PARITY-008-A1","ED-PARITY-008-A2","ED-PARITY-008-A3"],"required_evidence":["code-audit","unit","typecheck","native","idea-comparison"],"audit":{"date":"2026-09-15","head":"c7bbdee56cef0478d35aaa8d17124e30a299768a","finding":"根据 P0 及后续文档补录待规划目标，未重新核验生产行为。P0 Git 仅有源码路径，无真实 Git fixture；REQ-07 的其余运行调试目标仍在总矩阵。"},"prior_completion":{"kind":"new-task","completed":false},"p0":{"audit_id":"AUDIT-20260913-01","requirements":["REQ-07"],"scenarios":["CW-GIT-001","CW-GIT-003"],"planning_required":true},"note":"P1 待核当前差距、参照、完整 AC/V、owner 与环境前置；不能按开发 ready 领取。"} -->

来源：REQ-07 / CW-GIT-001、CW-GIT-003。范围：F3 两个隔离本地 repo 的文件状态→打开 diff→切 root→返回编辑器；不 commit/push，不扩到 merge/rebase 或 Run/Debug。

[本卡规格与待核条件](task-planning.md#ed-parity-008)；[历史只读来源](../../claudedocs/code-workspace-idea-parity-backlog.md)。

### ED-PARITY-009 Java Structural Search 的首个结构匹配场景
<!-- ide-task {"id":"ED-PARITY-009","status":"deferred","priority":"P2","size":"M","depends_on":[],"spec":"docs-feature/code-workspace-idea-parity/task-planning.md#ed-parity-009","acceptance":["ED-PARITY-009-A1","ED-PARITY-009-A2","ED-PARITY-009-A3"],"required_evidence":["code-audit","unit","typecheck","browser","native","idea-comparison"],"audit":{"date":"2026-09-15","head":"c7bbdee56cef0478d35aaa8d17124e30a299768a","finding":"根据 P0 及后续文档补录待规划目标，未重新核验生产行为。P0 静态记录 SSR 语言集合为空；本次仅补录该需求，当前生产引擎是否已有变化由 P1 核对。"},"prior_completion":{"kind":"new-task","completed":false},"p0":{"audit_id":"AUDIT-20260913-01","requirements":["REQ-09"],"scenarios":["CW-SEARCH-003"],"planning_required":true},"note":"P1 待核当前差距、参照、完整 AC/V、owner 与环境前置；不能按开发 ready 领取。"} -->

来源：REQ-09 / CW-SEARCH-003。范围：先确定一个 Java 结构模式、变量约束和准确匹配集合，再设计最小可用结构搜索；Replace、Full Line、Smart Completion 留作后续独立包。

[本卡规格与待核条件](task-planning.md#ed-parity-009)；[历史只读来源](../../claudedocs/code-workspace-idea-parity-backlog-2026-09-audit.md)。
