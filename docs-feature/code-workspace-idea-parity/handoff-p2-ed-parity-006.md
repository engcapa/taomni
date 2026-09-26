# ED-PARITY-006 P2 开发并自验：完整提示词

来源：[唯一任务板](backlog.md) / REQ-08 / CW-SEARCH-002。

P1 规划完成：唯一板同卡 `ready / planning_required=false`，无开发 owner。用户已确定 IDEA 2026.2.3 与撤销语义对齐 IDEA；必要参照已实采。这里只交接，不启动 P2，不代表产品或双侧比较通过。

[完整设计与用例](project-replace-exclude-plan.md#test-cases) / [参照与 fixture](references/ed-parity-006-reference.md#observed)。下面整段按原 P2 模板填写，可直接复制；接手时以实时任务板防止重复领取。

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
- 任务板与 ID：docs-feature/code-workspace-idea-parity/backlog.md / ED-PARITY-006；本交接保存时 ready、p0.planning_required=false、depends_on=[]，无开发 owner；按实时状态正式领取，不能改选卡或重领 done。
- 目标范围与用户结果：REQ-08 / CW-SEARCH-002。F1-REPL-006 四文件 → Directory=src + mask *.txt 搜索 token 得 3 条 → 结果列表 Delete/右键排除 a.txt:2 → Replace All 确认预览（2 of 3，summary）→ Esc 零写入 → Enter 提交 2 处 → 结果只剩排除行 → 输入框 Ctrl+Z 不碰磁盘 → 结果行 Ctrl+Z 弹 “Undo Replace in files?” → Cancel 零效果 / OK 一次恢复两文件；外部修改与 dirty 两类冲突零写入并可恢复。修 G1 结果列表无法排除、G2 提交后结果陈旧、G3 输入框 Ctrl+Z 撤销磁盘替换，补 G4 撤销确认、G5 预览键盘/焦点/摘要；R1（capture 是否吞 Esc/Enter）、R2（同行多处）待你运行归因。不重做 scope/冻结快照/preimage/preflight/ledger 已有修复。
- 目标 IDEA 与参考包：用户定 Ultimate 2026.2.3 / IU-262.10968.63（仅本卡）；docs-feature/code-workspace-idea-parity/references/ed-parity-006-reference.md#observed、#fixture、#capture-gaps；fixture-catalog.md#f1。原件 qa-ui-auto-report/idea-reference/ed-parity-006/run-20260926-205230/（不入库；manifest.json 含 40 个 SHA-256，steps.jsonl，*.hashes.txt 为独立读盘）。跨机器需原包，摘要不能替代截图。外部修改/dirty/编辑器内 Ctrl+Z/Redo/右键文字（C1–C5）未采。
- 设计、DEC、AC/V：docs-feature/code-workspace-idea-parity/project-replace-exclude-plan.md#ed-parity-006；ED-PARITY-006-DEC-01..09、ED-PARITY-006-A1..A3、ED-PARITY-006-V1..V6、S0..S11。DEC-03 保留冻结预览逐处 checkbox、DEC-07 提交/撤销直接落盘、dock 入口形态为已接受差异；DEC-06 编辑器内 Ctrl+Z claim 路径与 redo 不加确认（IDEA 未采）。当前产品功能/UI/交互均未验证。
- 必须保留：scope/mask fail-closed 与集合；冻结 scope/query/replacement/matches、preimage 预读与迟到丢弃、workspace 实例校验、选择校验、全集 preflight/freshness、真实 ledger 与 recovery id、一次多文件 undo、UTF-16 与大小写路径；D2-01 预览排除/Cancel；编辑器内 Ctrl+Z claim（ED-AUDIT-008）与 Rename 撤销；本地 Find 焦点；Find in Directory/Search Everywhere 预置；Keymap 对话框输入保护。改前依据与测试见设计第 2 节与 V6；既有测试不等于本轮 PASS。
- 文件/模块 owner 与依赖：板内 depends_on=[]；以下是 P2 修改责任，不是 P1 owner。src/components/editor/workspace/panels/FindInFilesPanel.tsx（DEC-02/03/05）、panels/ReplacePreviewDialog.tsx（DEC-03/04）、src/components/editor/CodeWorkspaceTab.tsx（handleWorkspaceCommand 输入框豁免、workspace.undoWorkspaceEdit 确认、workspace.replaceInFiles 聚焦、isSurfaceOwnedKeyEvent 仅 R1 证实时）。共享只回归：workspaceEditHistory.ts、replaceInFilesModel.ts、editorSearchPanel.ts、workspaceActionRegistry.ts。不得修改旧任务板。
- 用例设计与验证材料：project-replace-exclude-plan.md#test-cases 是完整前置、逐步及最终预期、边界、清理和证据合同。下列均拟新增、P2 待实现，当前无运行结果：
  A1→V1→FindInFilesPanel.test.tsx describe "ED-PARITY-006: result exclusion, seeded preview and post-commit pruning"、ReplacePreviewDialog.test.tsx describe "ED-PARITY-006: seeded exclusion, summary and keyboard"（测试名见设计）；unit。
  A3→V2→CodeWorkspaceTab.test.tsx describe "ED-PARITY-006: workspace edit undo routing"（沿用 ED-REPAIR-002 mounted 模式）；unit/mounted。
  A1→V3→qa-ui-auto-tests/cases/TC-IDE-PARITY-006-01-replace-exclude-preview-cancel-commit.testcase.yaml；ID TC-IDE-PARITY-006-01；browser。
  A3→V4→qa-ui-auto-tests/cases/TC-IDE-PARITY-006-02-replace-undo-routing.testcase.yaml；ID TC-IDE-PARITY-006-02；browser。
  A1/A3→V4→qa-ui-auto-tests/cases/TC-IDE-PARITY-006-03-replace-disk-conflict-undo-native.testcase.yaml；ID TC-IDE-PARITY-006-03；native，Windows 当前端；browser 不能证明真实 ripgrep、主机字节、外部进程修改与 hash 阻断、WebView2 键路由。只用 click/press/fill/host_write_file/assert_file_sha256，不用 X11-only verbs。
  A2→V5→复用 V3/V4 截图与运行对比 REF-PARITY-006-WIN-20260926，记录 qa-ui-auto-report/idea-comparison/ED-PARITY-006/<run>/record.json 并用 compare_idea.py 校验。
  A3→V6→复跑 TC-IDE-D2-01、TC-IDE-D1-01、TC-IDE-FINDFOCUS-01 与既有单测；**必改** TC-IDE-D2-02（Ctrl+Z 移到结果行并确认 OK）与 TC-IDE-AUDIT-003（换掉 native_click/X11 native_keys 以便 Windows 执行，保持期望）。
  全部 covers: [F25.5]。P2 负责 parity006_replace fixture（browser /preview/parity006 + native 临时目录，REGISTRY 与 schema 注册，SHA-256 由生成字节计算）、新 testid（code-workspace-find-match-row、-find-row-exclude/-restore、-replace-summary、-find-replaced-notice、-undo-confirm/-ok/-cancel）及 feature-list.md controls、testid-catalog 重生成。
- 执行环境：当前 Windows/PowerShell，三端兼容；browser 先完成 006-01/02 与保留 case，稳定后集中一次 native 构建跑 006-03、D2-02、AUDIT-003（Windows/WebView2）。Linux/WebKitGTK、macOS/WKWebView 同序列保留未验证计划（macOS 用 Mod+z；direct Cargo 前 stage krb5）。P1 没有 QA build，也没有可复用的本卡 binary。原件输出 qa-ui-auto-report/ed-parity-006/<mode>/<run>/。IDEA 实采：Windows 11、1920×1080、深色 New UI、Windows keymap；字体/缩放本轮未重读。桌面时段 2026-09-26 20:57–21:09 已结束，新的桌面输入须有当轮时段并确认目标窗口/焦点，禁止自动解锁。
- 修改权限：用户将本提示词交给 P2 后，允许本卡产品代码、测试、文档、自有任务状态及必要构建/验证；不提交推送，不启动其他 agent/P3。本次 P1 会话仅保存交接文本，不授予当前 agent 开发执行权限。
- 当前工作区或交接：分支 docs/code-workspace-idea-audit-20260913；HEAD 7987fbd7be10c20c81e7107fa37d8b30fc49b458。本轮 modified：docs-feature/code-workspace-idea-parity/ 下 backlog.md、task-planning.md、capability-matrix.md、index.md、references/fixture-catalog.md；untracked：project-replace-exclude-plan.md、references/ed-parity-006-reference.md、本 handoff。保留这些成果，接续时重读 git status/HEAD。G1–G3 源码确认、R1/R2 待运行归因；所有产品测试/构建/领取/实现未执行。

【最小验证与完成门槛】
先跑 V1 G1/G2 与 V2 第 1 项的改前失败并保留；V6 单测基线；再单测/browser 迭代。稳定后一次 scoped typecheck（设计第 7 节命令），browser 一批，native 一次构建一批，最后 audit --gate、contracts --gate 与 V5 比较。required_evidence 保留 code-audit、unit、typecheck、browser、native、idea-comparison，不能删除失败/未验证项制造通过。C1–C5 IDEA 未采项保持 unverified，不能用 Taomni 结果倒推 IDEA 行为。未实现 case 不得报告通过。

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

## P2 交付回填（2026-09-27）

上方提示词是 P1 当时的交接快照；P2 已按本机 Linux/WebKitGTK 与用户最新范围完成同卡。任务状态与实际报告以[任务板 ED-PARITY-006](backlog.md)和[设计第 8 节](project-replace-exclude-plan.md#ed-parity-006)为准，不可据上方旧 `ready/Windows/unrun` 文字再次领取。

| AC → V | 实际检查 / 报告 | 状态 |
|---|---|---|
| A1 → V1/V3/V4 | `FindInFilesPanel.test.tsx`、`ReplacePreviewDialog.test.tsx`（unit 130/130）；`TC-IDE-PARITY-006-01`（browser 5/5 批次）；`TC-IDE-PARITY-006-03`（native 94 步、四文件 SHA-256、外部/dirty 冲突零写入与恢复） | Linux 本机 pass；`qa-ui-auto-report/ed-parity-006/unit-recovery.log`、`browser/run-20260927-012911-519728892/`、`native/run-20260927-013506-678365023/` |
| A3 → V2/V4/V6 | `CodeWorkspaceTab.test.tsx` 13/13 selected；`TC-IDE-PARITY-006-02`、D2-01、D1-01、FINDFOCUS-01 browser；D2-02、AUDIT-003 native | Linux 本机 pass；`mounted-recovery.log`、同上 browser 与 `native/run-20260927-013238-810396421/` |
| A2 → V5 | Taomni 生产截图三维自检、差异/未采边界记录，`compare_idea.py` schema/hash 校验 | 记录有效，verdict `unverified`；用户免 IDEA 真机双侧比较。`qa-ui-auto-report/idea-comparison/ED-PARITY-006/run-20260927-local/record.json` |

最终 source `26652deb092d7c6d3eb71ba6f4a978e93c2c78e64efdd4b7890a9b3cad508a51`，QA binary `com.taomni.app.qa` SHA-256 `0608a948c6f8e01550f8b11e21b9579a28e116b5363157ab7013f49d063a92b5`。8 个目标/保留 UI case 的 `status --gate --platform Linux` 为 `ok=true, gaps=[]`；`audit --gate`、`contracts --gate`、9-path typecheck 均通过。完整命令、失败归因、耗时与平台边界见设计第 8 节及 ignored `qa-ui-auto-report/ed-parity-006/evidence.json`。Windows/WebView2、macOS/WKWebView 和 IDEA C1–C5 均未验证；没有视觉 matched 结论，也没有提交或推送。

静态 audit 仍报告右键 Exclude/Restore 两个 required testid 未按 selector 触达；006-01 已通过 `right_click` 和可见菜单文字 `click_menu` 实际点击两项并断言状态，故这是审计器的 testid 归属限制，详见设计第 8.3 节。`audit --gate` 通过，不等于零静态提示。
