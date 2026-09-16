# P2 开发并自验 — WP-FIND-FOCUS-01

由 agent-collaboration-prompts.md 的 P2 完整模板填写；本文件是待用户复制下达的提示词，不自动启动 P2。任务状态以板为准。

```text
你负责完成随附任务板和 ID 的一个 Taomni Code Workspace IDEA 对齐工作包，包括实现、范围内故障
修复、集成、自检和必要当前端验证。

目标是在本轮范围内通过必要重构与能力完善，使功能、UI 和交互与目标 IDEA 高度一致；沿用总需求的
场景 ID 和验收目标，当前布局不是保留约束，已有正确能力和数据契约必须保留。

【本轮输入】
- 工程：D:/code/person/taomni。
- 任务板与 ID：claudedocs/code-workspace-idea-parity-backlog-find-focus.md / ED-FINDFOCUS-001；P1 交付时 ready，未领取，depends_on=[]，owner 未设置；validate 和 list --claimable 已通过。接手重新查询，不重领任何 done 卡。
- 目标范围与用户结果：WP-FIND-FOCUS-01；REQ-01 / CW-SEARCH-001、CW-SHELL-002 的 F0 example.txt 正文获焦→Ctrl/Cmd+F→tree→Enter/Shift+Enter→Esc→repeat。必须保留 CW-NAV-002 modifier-hover 和 CW-TAB-002 多 view。本轮只完成此小包，不重做整体 P0，不换编辑器内核，不实现无关 Smart/SSR/Git/Debug。
- 目标 IDEA 与参考包：Ultimate 2026.2.2 / IU-262.10315.125，D:/Software/idea-2026.2.2.win；docs-feature/code-workspace-idea-parity/references/find-focus-2026.2.2.md（REF-FIND-FOCUS-20260914）。真实原件 qa-ui-auto-report/idea-reference/find-focus/20260914/，转交 reference-transfer.zip，SHA-256 fa328fa968648123d8aa3da67858bf7ab7208e690f8ff0177f9ed9f52444f5cb。其他机器须取得原件并核 hash；00–11 输入污染、34–37 无关个人设置不得作为参照或转交。
- 设计、DEC、AC/V：docs-issue/code-workspace-find-focus-design.md；DEC-FF-01..04；ED-FINDFOCUS-001-A1..A7 对应 REQ-01-F/I/V/R；V-FF-01..06。图稿 docs-issue/find-focus/find-focus-v1.drawio + find-focus-v1.png；用户于2026-09-14明确“按图稿与实测参照继续”，已确认v1结构与Esc恢复语义（DEC-FF-02/03）；图稿是设计产物，不是产品证据。总需求 docs-feature/code-workspace-idea-parity/overall-audit-plan-20260913.md#req-01；稳定矩阵 capability-matrix.md 不另建。
- 目标关键细节：在 F0 1:1/空 selection 输入 tree 自动选第一处 [8,12)，Enter 到第二处 [53,57)，Shift+Enter 回第一处；Find 输入保持 focus；Esc 关闭并回同 view，保留当前匹配 4 字符 selection，不强制回到打开前 1:1。Find 默认一行，Replace 从展开入口和原动作可达；不得削减替换/过滤规则。
- 必须保留与依据：正文/dirty/save/undo/cancel/recovery 和数据兼容；literal/case/word/regex、selection/context、preserve case/regex groups/replace-all 一次 shared undo；Ctrl/Cmd-hover、定义导航、modifier release；只读、IME、多 workspace/多 pane owner；clipboard 旧请求在 editor→Find→editor 后不得复活。历史合同为 claudedocs/code-workspace-idea-specs/search-and-navigation.md#ed-find-001/#ed-find-002、shared-contracts.md、tabs-and-multiview.md、idea-2026-main-repair.md#ed-repair-008/#ed-repair-009、idea-2026-b-review.md#ed-improve-008。历史卡均只作保留来源，不能当当前测试通过。
- 文件/模块 owner：src/components/editor/workspace/editorSearchPanel.ts、lspHyperlink.ts，必要 CodeMirrorHost.tsx，同名 tests；拟新增 CodeMirrorHost.findFocus.test.tsx 和 qa-ui-auto-tests/cases/TC-IDE-FINDFOCUS-01.testcase.yaml（id TC-IDE-FINDFOCUS-01）及 F25.1/F25.5 covers/controls。新测试尚未创建。EditorGroup 两个 Host caller、CodeWorkspaceTab semantic navigation、clipboard/IME/shared document/view snapshot 是保留消费者。只有 caller 证明缺少 owner 接线才扩 Keymap/Group/Tab/公共 popup/ActionHost，记录理由及回归；不新增第二套 store/IPC。repo build 集成卡 owner 沿用原板 ED-GATE-003，不重开；本卡负责 scoped typecheck 和必要同源 native QA build/验证。
- 原始反例：qa-ui-auto-report/overall-audit-20260913/browser/08-editor-find.png、09-find-results.png、18-find-repro.png、console.log（21–31、33–43）、actions.json、snapshots/ 及同 run artifact-manifest.json。两次正文获焦 Ctrl+F 报 Calls to EditorView.update are not allowed while an update is in progress；Find 仍出现，tree 仍两匹配；没有正文丢失/native 退化证据。P1 复核 source/artifact hash，未启动产品重跑。
- 最小验证材料：V-FF-01 真实焦点+真实 CM/StrictMode red→green；V-FF-02 lspHyperlink.test.ts、editorSearchPanel.test.ts、CodeMirrorHost.test.tsx 相关 search/shared-owner/ED-REPAIR-008 子集、CodeMirrorHost.ime.test.tsx、workspaceDocumentTransactionOwner.test.ts；V-FF-03 新 Find 连续 browser case；V-FF-04 当前 Windows WebView/真实 IME/provider/dirty/undo；V-FF-05 同 fixture/settings 双侧几何和交互；V-FF-06 一次 owned-path union typecheck 与 YAML/catalog audit。原正常路径未跑的改前 baseline 要先补，不能把未知当通过。
- QA 只读 plan：qa-ui-auto-report/idea-reference/find-focus/20260914/qa-plan.json；选 TC-IDE-C4-02 和 TC-IDE-C6-05-query-definition-reveal-history-native / Windows，exit 0；后者 native_keys requires Linux/X11，不能照搬 Windows。TC-IDE-IMPROVE-008-ime-lifecycle-native 也限 Linux fcitx5。现有 case 不足以替代本包 Find/hover/IME 断言，按设计采用受支持的当前端操作。
- Fixture：.agents/skills/qa-ui-auto/scripts/qa_ui_auto/fixtures/project_tree.py::SEED_FILES 四文件，UTF-8/LF；本机 qa-ui-auto-report/overall-audit-20260913/fixture，browser /preview/fixture；hash 见 docs-feature/code-workspace-idea-parity/references/fixture-catalog.md 与 evidence/find-focus-plan-20260914.json，.idea/元节点不计入。
- 执行环境：Windows；已有 Taomni 反例是 HeadlessChrome153/Vite development/React StrictMode/stubs、1400×992 CSS、DPR1、浅色、Inter12/18、代码 CSS13/19.5。IDEA 真参照外框1400×992、client1384×984、DPI96、Islands Dark、Zoom100%、Microsoft YaHei UI18、JetBrains Mono18/line-height1.2、Windows-zhyhang（Based on Windows）。不得跨这些环境计算像素一致。参照给原始几何；P2 配置匹配环境后测量并说明容差。Project 鼠标设置、Replace 展开精确几何未观测，不影响正文明确获焦的主路径，也不能冒充 matched。
- 当前端条件：P0 隔离 binary src-tauri/target/qa-ui-auto/debug/taomni.exe missing；P1 未构建，接手先检查实际身份，相关代码/tests 稳定后集中必要构建一次或复用。需要可控 Windows 桌面、Microsoft Pinyin、真实 provider/JDK/JDT LS 的隔离 fixture；F0 本身不依赖 provider。09-14 06:37–06:42 独占时段已结束，后续桌面输入需重新核对可用时段，锁屏不得解锁。P1 正常关闭 IDEA 时出现 Confirm Exit，PID27816/HWND3018688 可能尚存；只可在确认身份/可用桌面后正常处理，不强杀其他进程。
- 修改权限：本段是用户复制并下达 P2 后的执行范围：允许本卡产品代码、测试、文档、自有任务状态及必要构建/验证；不提交、推送、合并或发布。不自行委派其他 agent，不自动启动 P3。P1 当前轮仍不授权执行本段。
- 当前工作区：P1 接手分支 docs/code-workspace-idea-audit-20260913 / HEAD884d003846a8549cc3125090eaf55359bc676a3f、干净；P0 十份材料已提交，生产与27f99b6116f4f6aae906d324cb84e8359695e17a一致。P1 新增板、设计、Find参照、图稿、provenance、handoff；仅增量更新 index、matrix、overall plan、source audit。P1 未提交；保留全部文档和 ignored 原件。P1 产品测试0/runner0/Taomni启动0/build0/comparator0，不能继承候选 PASS。

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
