# ED-PARITY-007 P2 开发并自验：完整提示词

来源：[唯一任务板](backlog.md) / REQ-06 / CW-REFACTOR-002。

P1 规划完成（修订版）：唯一板同卡 `ready / planning_required=false`，无开发 owner。基线为当前 cc 分支 `53ecc955ff7ed7266eefe2af338fe598773efadf`，已吸收 astra 的生命周期、证据边界和 `13:1` oracle 设计。IDEA 版本要求为 **2026.x 任一发行版**，现有 Linux 参照为 2026.2.2 / IU-262.10315.125；Windows 历史原件另列且当前不可复核。用户已确定提取后弹出命名、接受两步撤销；这里只交接，不启动 P2，不代表产品或双侧比较通过。

[完整设计与用例](extract-method-plan.md#test-cases) / [Linux 参照与 fixture](references/ed-parity-007-reference.md#observed) / [Windows 历史边界与 E3 oracle](references/ed-parity-007-windows-reference.md#semantic-fixture)。下面整段按原 P2 模板填写，可直接复制；接手时以实时任务板防止重复领取。

## 本次修订的强制实现约束

P2 复制下方模板时，设计正文优先于模板中任何旧的概括句。具体要求：

- 单文件纯 text edit 不自动拥有完整文件预览；只有真实多文件/resource 或当前 preview gate 才进入 `RefactoringPreviewDialog`。方法声明和调用点在进入可选择预览时必须作为 required operations，普通 Rename 的可排除项保持不变。
- Extract 命名是提交后第二阶段。必须保存提交回执 `{sessionId,fileKey,uri,postRevision,postText,historyId}`；每次 await、局部弹框显示前、Rename preflight/首 writer 前验证 owner/URI/revision/provider generation/fingerprint。提交后失效不回滚用户已看到的 B1，也不弹迟到命名框。
- browser case 由 `#test-cases` 的 007-01/02/04/05 负责；V4 必须执行 E1/E3 程序 oracle（E3 输出 `13:1`），不能以结构匹配、无诊断或 stub 通过替代。所有新 case、fixtures、steps、verification 和 feature/controls 先落盘再运行。
- 空选区只有在 provider 给出有效方法候选时成功；无候选才显示边界文案。symbols/rename 失败保留已提交提取结果并显示真实原因；request/resolve/commit 前的失败保持零写入。
- `references/ed-parity-007-windows-reference.md` 的 Windows 观察属于缺失原件的历史参照；不能报告为本轮原生证据或 matched。

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
- 任务板与 ID：docs-feature/code-workspace-idea-parity/backlog.md / ED-PARITY-007；本交接保存时 ready、p0.planning_required=false、depends_on=[]，无开发 owner；按实时状态正式领取，不能改选卡或重领 done。不得转去旧 ED-REF-001 或任何 claudedocs 旧板卡。
- 目标范围与用户结果：REQ-06 / CW-REFACTOR-002，仅 Java Extract Method 首包。F2-EXTRACT-007 选中第 5–8 行（单输出）→ Ctrl+Alt+M **直接**提取（唯一 method 候选时不弹菜单）→ 命名框 `text-input-dialog`（标题 `Extract Method`，默认名全选）→ 输入 `sumOf` + Enter，调用处与声明同步 → 无 error 诊断、语义不变 → 编辑器 Ctrl+Z 两次（先撤改名、再撤提取）恢复初始字节。修 D1（Rust `lsp_code_actions` 用 `.unwrap_or(Value::Null)` 吞掉错误/8 s 超时/document changed，失败被说成“无动作”）、G1（总弹候选且 `refactor.extract` 前缀收入 variable/constant/field/interface）、G2（无命名步骤）、G3（零候选文案不分空选区/不可提取）。多输出（13–18 行）拒绝、无候选空选区、提交前超时/失败/取消均零写入且文案准确；空选区有有效 provider 候选时正常提取；symbols/命名失败保留已提交 B1，不伪称回滚；dirty 缓冲只改缓冲、不弹命名。先做 provider 探针核对 title/default name/static/edit/symbol timing，再实施命名。不做多输出 record 折叠、Inline/Change Signature/Move、启用 advancedExtractRefactoringSupport。
- 目标 IDEA 与参考包：版本要求为 IntelliJ IDEA Ultimate 2026 年任一发行版（2026.x，build 26x.*，任一平台），不限定 2026.2.2；不得使用 2025 及更早版本作为参照。现有参照 REF-PARITY-007-LINUX-20260927 实采于 2026.2.2 / IU-262.10315.125（本机 Linux），可直接复用。若补采或复核，使用任一 2026.x 均可，但必须读取 product-info.json 记录实际 version/build/edition 与平台，不同 build 的观测分别记录，不合并或改写原参照；新观测与 R1–R10 不一致时如实记录差异并回填设计，不按旧观测硬凑。仅对本卡生效；docs-feature/code-workspace-idea-parity/references/ed-parity-007-reference.md#environment、#fixture、#observed（R1–R10）、#capture-gaps；fixture-catalog.md#f2。原件 qa-ui-auto-report/idea-reference/ed-parity-007/run-20260927-1143/（不入库；manifest.json SHA-256 98b0218f76960d81982f2530939c7b8714f329d6abeceb02bea7f471fccb5ace，47 个原件 hash，steps.jsonl，*.hashes.txt 为独立读盘，make_fixture.py 生成器）。ExtractTarget.java 初值 SHA-256 3ffe60d1ca2f4973d8bd3e95575ea61aa483f1e299d9b31a67b41454e60d8c37；IDEA 提取+改名 sumOf 后 20eeb0ca7c1b2e5d9c9bd45115a0079cb90000eea3fa299f1fca141538608383（Taomni 默认名/static 可不同，期望字节由你的 provider 探针固定）。未采：右键 Refactor 子菜单、Alt+Enter 列表、Alt+Shift+O 选项、重复片段、真正无法提取的文案。
- 设计、DEC、AC/V：docs-feature/code-workspace-idea-parity/extract-method-plan.md#ed-parity-007；ED-PARITY-007-DEC-01..08、DEC-07 session-lifecycle、ED-PARITY-007-A1..A3、ED-PARITY-007-V1..V6（V3 browser 四组 007-01/02/04/05；V4 native+E1/E3 oracle；V6 保留回归）、S0..S10。已接受差异：两步撤销（DEC-04）、模态命名框代替就地模板（DEC-03）、干净缓冲提取后立即落盘（DEC-08）、默认名与 static 由 provider 决定。有意改变：DEC-05 使 requestCodeActions 全部调用方把 provider 失败如实报出（不再说无动作）。当前产品功能/UI/交互均未验证；所有新用例和 E1/E3 oracle 均 unrun。
- 必须保留：冻结候选/稳定 id、resolve 失败可重试、revision/generation/fingerprint 迟到校验、提交前快照比对、失败恢复 id、单文件直接应用、编辑器 Ctrl+Z claim 无确认（ED-PARITY-006 DEC-06-3）；Shift+F6 Rename 全链与文案；Refactor This/Alt+Enter/灯泡/Problems quick fix 候选菜单与前缀过滤；Generate、Rearrange、Cleanup 的真实空结果文案；保存时 Organize imports 失败不阻断保存；Keymap 键位与冲突检测。改前依据与测试见设计 §2 与 V6；既有测试不等于本轮 PASS。
- 文件/模块 owner 与依赖：板内 depends_on=[]；以下是 P2 修改责任，不是 P1 owner。src/components/editor/CodeWorkspaceTab.tsx（workspace.extractMethod run、新 runExtractMethod、renameSymbolAt 由 renameSymbolAtCursor 抽出且 Shift+F6 行为不变、requestCodeActions 失败文案、候选菜单锚点；R1 证实时 showCodeActionsMenu 回焦）；新 src/components/editor/workspace/extractMethodFlow.ts（isExtractMethodKind、findExtractedMethodSymbol、extractMethodBoundaryMessage）；src/components/editor/workspace/codeActionProviderAdapter.ts（requestCandidates catch 识别 `timed out` / `document changed`）；src-tauri/src/lsp.rs（lsp_code_actions 改用新纯函数 code_actions_from_response，Err 上抛，session 缺失仍 Ok 空）；新 src/stubs/parity007Extract.ts 与 src/stubs/tauri-core.ts 分派（仅 /preview/parity007 且开关开启）；新 fixture .agents/skills/qa-ui-auto/scripts/qa_ui_auto/fixtures/parity007_extract.py（REGISTRY 与 schema 注册）；新增 steps/parity007.py、schema/catalog 中显式 set/hold/release/trace/oracle 契约。局部 Extract prompt 必须由 owner 管理，不能把全局 appDialogs 队列当可撤回 owner。共享只回归：workspaceEditHistory.ts、intentionSession.ts、refactorPlan.ts、workspaceActionRegistry.ts、editorContextMenu.ts。不得修改旧任务板。
- 用例设计与验证材料：extract-method-plan.md#test-cases 是完整前置、逐步及最终预期、边界、清理和证据合同。下列均拟新增、P2 待实现，当前无运行结果；设计中的旧步骤若与 `#test-cases` 新矩阵冲突，以新矩阵为准；Windows 历史参照原件缺失，不能作为运行证据：
  A1/A3→V1→src/components/editor/workspace/extractMethodFlow.test.ts describe "ED-PARITY-007: extract method flow model"；codeActionProviderAdapter.test.ts describe "ED-PARITY-007: provider failure classification"；src-tauri/src/lsp.rs inline code_actions_from_response_*（unit/rust）。
  A1/A3→V2→src/components/editor/CodeWorkspaceTab.test.tsx describe "ED-PARITY-007: extract method direct run, naming and boundaries (mounted)"，测试名以设计 V2 表为准（unit/mounted，真实 keyDown）。
  A1/A3→V3→四个 browser case：TC-IDE-PARITY-007-01-extract-method-direct-name-undo（主流程）、TC-IDE-PARITY-007-02-extract-method-stale-dirty（owner/dirty）、TC-IDE-PARITY-007-04-extract-method-entries-boundaries（全部入口/边界）、TC-IDE-PARITY-007-05-extract-method-retained-consumers（共享消费者）；设计中列出的 ID、verification、covers、controls 均为 P2 待落盘。
  A1/A3→V4→qa-ui-auto-tests/cases/TC-IDE-PARITY-007-03-extract-method-jdtls-native.testcase.yaml（ID TC-IDE-PARITY-007-03；包含 E1/E3 `13:1`/语义 oracle）；native，fixtures [reset_db, parity007_extract, jdtls_required]，native_platforms [Linux, Windows]；browser 不能证明真实 JDT LS kind/resolve/诊断、主机写盘与撤销后保存、watcher 重载触发 stale、WebView 真实键路由。只用 click/press/fill/type/host_write_file/assert_file_sha256/assert_text/assert_pattern，不用 X11-only verbs。
  A2→V5→复用 V3/V4 截图与运行对比 REF-PARITY-007-LINUX-20260927，写 qa-ui-auto-report/idea-comparison/ED-PARITY-007/<run>/record.json 并用 compare_idea.py 校验；预期 different/unverified，不签 matched。
  A3→V6→复跑设计 V6 runbook 所列既有单测，与 V4 同批 native 复跑 TC-IDE-C6-04、TC-IDE-AUDIT-014-rename-recovery-native、TC-IDE-AUDIT-016-cleanup-unavailable-native；新增 "ED-PARITY-007 organize imports on save reports provider failure but still saves"。
  全部 covers: [F25.5]。P2 负责 parity007_extract fixture、parity007Extract stub（normal / multi-candidate / none / empty-supported / disabled / command-only / malformed / timeout / changed / error / resolve-error / symbols-error / symbols-ambiguous / rename-error / multi-file / write-failure，以及 request/resolve/symbols/prepare/rename 分阶段 hold/release/trace与 window.__taomniQaParity007 只读观测）；无新增 testid（复用 text-input-dialog*、code-workspace-intention-*、status-bar-message、code-workspace-editor），若新增须同步 feature-list.md controls 与 testid-catalog。
- 执行环境：本 P1 主机为 Ubuntu 24.04 / Cinnamon / X11（Linux/WebKitGTK），JDT LS 1.61.0.202607102111 位于 ~/.local/share/jdtls，JDK 21 在 /data/dev/jdk-21；三端兼容。browser 先完成 V1–V3，首个 provider 探针使用改前可用入口且在实现命名流程前做；稳定后按真实 source/binary 身份集中 native 构建跑 V4+V6，构建次数如实记录。另一平台与 macOS（Cmd+Alt+M，可能被系统拦截；direct Cargo 前 stage krb5）保留未验证计划。P1 没有 QA build，也没有可复用的本卡 binary。Linux IDEA 原件输出 qa-ui-auto-report/ed-parity-007/<mode>/<run>/。IDEA 桌面时段 2026-09-27 11:43–11:58 已结束并归还；新的桌面输入须有当轮时段并确认目标窗口/焦点，禁止自动解锁。
- 修改权限：用户将本提示词交给 P2 后，允许本卡产品代码、测试、文档、自有任务状态及必要构建/验证；不提交推送，不启动其他 agent/P3。本次 P1 会话仅保存交接文本，不授予当前 agent 开发执行权限。
- 当前工作区或交接：分支 `docs/code-workspace-idea-parity-007-cc-5.5-P1`；基线 HEAD `53ecc955ff7ed7266eefe2af338fe598773efadf`，本次修订后接手时以实时 `git status`/`git diff` 为准。修改范围为本专题 backlog、task-planning、capability-matrix、index、extract-method-plan、两份参照与本 handoff；不包含产品代码、可执行 case 或运行报告。保留这些成果，接续时重读 git status/HEAD。D1 源码确认，G1–G3 源码+IDEA 确认，R1/R2 待运行归因；所有产品测试/构建/领取/实现未执行。

【最小验证与完成门槛】
先跑 V1 分类项与 V2 新测试的改前失败并保留、V6 单测基线；做首个 provider 探针；再单测/browser 迭代。稳定后一次 scoped typecheck（设计 V3/V4 命令），Rust 定向测试，browser 一批，native 一次构建一批，最后 audit --gate、contracts --gate 与 V5 比较。required_evidence 保留 code-audit、unit、rust、typecheck、browser、native、provider、idea-comparison，不能删除失败/未验证项制造通过。IDEA 未采项保持 unverified，不能用 Taomni 结果倒推 IDEA 行为。未实现 case 不得报告通过。

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
