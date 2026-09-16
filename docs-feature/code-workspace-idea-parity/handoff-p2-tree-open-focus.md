# P2 交接：WP-TREE-OPEN-FOCUS-01

本文件已填入 P2 模板；只供人工复制启动下一轮，本次 P1 未领取或实施。开发状态以准确任务板 metadata 为准。

```text
你负责完成随附任务板和 ID 的一个 Taomni Code Workspace IDEA 对齐工作包，包括实现、范围内故障
修复、集成、自检和必要当前端验证。

目标是在本轮范围内通过必要重构与能力完善，使功能、UI 和交互与目标 IDEA 高度一致；沿用总需求的
场景 ID 和验收目标，当前布局不是保留约束，已有正确能力和数据契约必须保留。

【本轮输入】
- 任务板与 ID：claudedocs/code-workspace-idea-parity-backlog-tree-open-focus.md::ED-TREEOPEN-001，P1 author 后 ready；WP-TREE-OPEN-FOCUS-01 为工作包名，不是领取 ID。接手重新核对 metadata。
- 目标范围与用户结果：REQ-02 / CW-PROJ-002：F0 README 唯一 tab→树方向键选择/展开→example.txt→Enter→准确 editor/view 直接输入→undo/save 字节恢复→回树→右键/Esc→选择、焦点、正文恢复。CW-PROJ-003 只含 Open/cancel；保留 CW-TAB-001/002、CW-SHELL-002、REQ-04/11。
- 目标 IDEA 与参考包：IntelliJ IDEA Ultimate 2026.2.2 / IU-262.10315.125；docs-feature/code-workspace-idea-parity/references/project-tree-open-focus-linux-2026.2.2.md（REF-TREE-OPEN-FOCUS-LINUX-20260914）。原件 qa-ui-auto-report/idea-reference/tree-open-focus/20260914-linux/，hash 清单 evidence/tree-open-focus-artifacts-20260914.json（相对上述 parity 目录）。Linux Cinnamon/X11，1920×1044 client at(0,36)，Islands Dark、UI 110%/Dialog16、Classic Light/Source Code Pro16/line1.2、XWin；preview、file/dir single-click open 均关闭。旧 Windows 参照只在原范围复用，旧 P0 原件本机缺失。
- 设计、DEC、AC/V：docs-issue/code-workspace-tree-open-focus-design.md#ed-treeopen-001；DEC-TOF-01..05，ED-TREEOPEN-001-A1..A7，V-TOF-01..05。图稿 references/tree-open-focus-states.drawio/.svg（相对 parity 目录）。用户已明确接受 DEC-01：首包修订单击合同，文件/目录标签单击只选，文件双击/Enter 正式打开，箭头展开；保留其他入口 preview 数据/策略，不改全局 preview 默认。无需再次征求这个决定。
- 必须保留：方向键不打开、展开不改正文；正式/dirty/pinned tab 不被 preview 覆盖；Ctrl/Cmd+Enter 分屏；同文件多 view 独立 caret/selection/scroll 与共享 undo；dirty close Cancel、失败重试、菜单取消、expanded descendants refresh、文件事务/persistence；Find 打开/匹配导航/Esc 与迟到 owner 隔离。精确依据和选测见设计 §1/3/7（CodeWorkspaceTab.test.tsx 的正式 tabs/split/shared undo/pending cleanup/rebound/snapshot/Find 现有子集，Host findFocus、tab policy、refresh）。旧 tree 设计附有明确修订，shared-contracts 与 tabs-and-multiview 及 ED-REPAIR-009 的有效数据合同保留。旧 ED-TREE-001 done 不重领；Find ED-FINDFOCUS-001 implemented 已实现，不接管状态、不以 provider gap 设依赖。
- 文件/模块 owner 与依赖：依赖 []。生产文件：src/components/editor/workspace/ProjectTree.tsx 的层级/平铺/loose rows；必要 FileTreePane/projectTreeNavigation；src/components/editor/CodeWorkspaceTab.tsx 的 handleTreeKeyDown/openFile/菜单/instance 生命周期；EditorGroup.tsx、CodeMirrorHost.tsx 的 ready/focus port；ContextMenu.tsx 仅必要可选 close reason/tree adapter。共享 store/tab policy/transaction/view snapshot/persistence、useWorkspaceFileActions/useWorkspaceTreeData、Find/clipboard 和 IPC 默认只读，必要改动需有 caller 依据并承担本卡回归。普通/已开/加载迟到/分屏/切 workspace 全链必须落地；workspace/file/canonical key/leaf/mount token/interaction epoch 明确。不得只在 Enter 后加无条件 focus，不用 reveal 重置 caret，不全局改变所有 openFile callers。
- 验证材料：所有本包产品 V 均未执行。P1 只读 qa plan/status 选中 TC-IDE-TREE-01-project-tree-keyboard-native，Linux unverified，报告在原件目录 qa-plan.json/qa-status.json；旧 case Enter 后点击 cm-content，不能证明 A2。P2 拟新增 qa-ui-auto-tests/cases/TC-IDE-TREEOPEN-01.testcase.yaml（ID TC-IDE-TREEOPEN-01，当前不存在），按现有 runner authoring 注册必要 controls/covers/catalog，并只修订旧 case 受影响 mouse 步骤、保留原数据断言。V01 red/races；V02 最小保留基线；V03 真实 shell 挂载（browser kind 可由挂载提供），必要时 .agents/skills/qa-ui-auto/assets/qa-ui-auto.config.browser.yaml + 独立 VFS；V04 稳定后当前端 native 集中主链；V05 scoped typecheck 并集和 qa audit。新产物统一 qa-ui-auto-report/tree-open-focus-ED-TREEOPEN-001/ 下按实际 run 分目录，配置需按当前 native-testing 核对生成，尚无本包 QA binary/pass receipt。
- 执行环境：接手记录为 Ubuntu24.04 Linux x86_64、Cinnamon/X11 DISPLAY=:0；再次核对真实环境。IDEA 已完成两轮授权采样，桌面已归还，本轮规划后没有继续占用。P2 真实输入前先告知预计独占时长（主链约10–15分钟）并约用户让出鼠标/键盘/前台焦点；不能沿用已结束的时段。先核对 PID/window/lock，不自动解锁；本机 Ctrl+Shift+A 曾触发其他 app，受污染尾段已作废，r2 主链有效。QA binary 是否可复用未知，按 source/case/runner/config/build 指纹核对，仅必要构建。原件无法读取时按新参照 §5 最小补采，不能用帮助/源码代替实测。
- 修改权限：允许本卡产品代码、测试、文档、自有任务状态及必要构建/验证；不提交推送。不重领旧卡、不自动调度其他角色、不运行全历史 QA、不扩大完整文件事务/全局主题/插件/语义引擎。只在用户将本提示交给 P2 执行时开始领取与实施；本提示的生成不构成已启动 P2。
- 当前工作区或交接：P1 HEAD 7bbb7094148e65c389903076cd3b4dec0d04a004，branch docs/code-workspace-idea-audit-20260913，接手 clean、生产差异为零。P1 留下未提交文档：parity 的 index/capability-matrix/source-audit/agent-collaboration-prompts 更新，新 reference/图稿/evidence/handoff；docs-issue 新 tree-open-focus 设计及旧 tree 设计修订链接；claudedocs 新 tree-open-focus 任务板。原始 IDEA 工件 ignored。不要覆盖这些规划成果。证据身份 docs-feature/code-workspace-idea-parity/evidence/tree-open-focus-plan-20260914.json；最新状态需重查。P1 不领取、不改产品/测试、不运行产品测试/构建/Taomni/runner、不提交推送。

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

本包执行补充：按设计 §5 使 load commit 与 focus grant 独立，固定动作时的 workspace/leaf，等待 canonical file 与实际 Host/snapshot ready；已开文件早返也完成交接。加载失败、取消、A→B→A、目标销毁/隐藏、workspace 重绑、menu Esc/Open/outside 各有可观察恢复路径。Markdown preview/readonly focus 不能强制切编辑模式。菜单共享消费者不一律回树。

当前端 native 必须观察 Enter 后不点 editor 的真实输入落点、undo、保存后 example 71 bytes/SHA256 bbbab91a4e4ea594b1e2207721999dc375ac98c30c5960cfbbf1329a441aa01a；active split 与切 workspace 无焦点劫持、菜单取消/外部点击、dirty Cancel、Find 返回及 composing Enter guard。稳定后一次 batch 去重覆盖 required evidence：code-audit/unit/typecheck/browser/native/idea-comparison/qa-lint；不机械继承 Find provider/screen-reader 缺口。repo-wide build 集成归既有 ED-GATE-003（不重开），本卡负责 scoped typecheck 和 native 必要 QA build/复用及最终消费者集成。

尚待用户决定的目标/preview/兼容合同：无。当前端运行条件与桌面时段需执行时核对；产品 AC/V 全部未执行，ready 不等于产品通过。

```
