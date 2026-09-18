# ED-PARITY-002：完整 P2 执行提示词

本文件填写自 [P2 开发并自验模板](agent-collaboration-prompts.md)。P1 已就绪，实时领取资格只看 [backlog.md](backlog.md)。只在用户将下文交给 P2 后执行；本轮不启动 P2。

```text
你负责完成随附任务板和 ID 的一个 Taomni Code Workspace IDEA 对齐工作包，包括实现、范围内故障
修复、集成、自检和必要当前端验证。

本轮只允许领取 docs-feature/code-workspace-idea-parity/backlog.md 中的 ED-PARITY-xxx 新卡，
并且 p0.planning_required=false、status=ready/implemented、依赖全 done。若交接给的是旧板/旧 ID，
返回身份不符，不自行改选历史卡或借用其证据。所有 task-board 命令显式带上述 --doc。

目标是在本轮范围内通过必要重构与能力完善，使功能、UI 和交互与目标 IDEA 高度一致；沿用总需求的
场景 ID 和验收目标，当前布局不是保留约束，已有正确能力和数据契约必须保留。

【本轮输入】
- 任务板与 ID：docs-feature/code-workspace-idea-parity/backlog.md :: ED-PARITY-002；P1 author 状态 ready，p0.planning_required=false，depends_on=[]；领取前重读，不另选板/卡
- 目标范围与用户结果：REQ-11 / CW-EDIT-003；一个文件保存期间继续输入，磁盘是冻结 B1、live B2 保留 dirty；补 Windows native 时序/字节/冲突/取消/unknown/迟到恢复基线，先取证，反例才修复。不扩展 Local History/IME/完整冲突 UI
- 目标 IDEA 与参考包：IntelliJ IDEA Ultimate 2026.2.2 IU-262.10315.125 / Windows；docs-feature/code-workspace-idea-parity/references/ed-parity-002-reference.md，REF-PARITY-002-WIN-20260916；manifest 为 evidence/ed-parity-002-p1-identity.json（同规划目录）。内部 writer race、unknown、有效字体/zoom 未实测；旧豁免不继承
- 设计、DEC、AC/V：docs-feature/code-workspace-idea-parity/save-race-baseline-plan.md#ed-parity-002；ED-PARITY-002-DEC-01..07、A1..A3、V1..V4、S0..S8；RISK-01：committer watcher await 后可能用旧 live snapshot 覆盖新输入，先定向复现；初始目标回链 task-planning.md#ed-parity-002
- 必须保留：冻结快照/单 writer、输入与 dirty、独立编辑组一次 undo、目标编码/EOL/BOM、取消零额外写、none/unknown/committed 分离、owner 迟到不复活、before-image/recovery；CodeWorkspaceTab.test.tsx 现有 save-race/unknown/close/hash-mismatch 及受影响 ED-REPAIR-001 retry/cancel 回归。历史通过只作来源，当前验证未执行
- 文件/模块 owner 与依赖：CodeWorkspaceTab.tsx 的 saveFile/commitOpenBufferPreparedSave/mutateOpenBuffer/writeTextSnapshot/冲突与恢复 caller；workspace/saveCommit.ts、workspaceStyleController.ts、saveNormalizationPipeline.ts、saveObservationContract.ts；必要 IPC 为 src/lib/editor/workspace.ts、src-tauri/src/workspace.rs。新 W2 回归、TC-IDE-PARITY-002-save-race-native.testcase.yaml（ID TC-IDE-PARITY-002，尚不存在）与本卡专用 QA collector/隔离 adapter 归本卡；共享 consumers 为 saveOpenBufferText/WorkspaceEdit save-only retry/history replay/其他 view/loose file/watcher/Git/semantic/LSP。若修改相应边界，按设计追加消费者检查。无跨卡依赖；旧板仅只读。文件责任不是预写开发 owner
- 验证材料：V2 给出精确 Vitest 文件/名称与 scoped typecheck 命令；V3 定义新 native case/时点采集（必须先实现，禁止当现有命令）。TC-IDE-C0-01 是旧 byte/冲突断言来源，2026-09-16 QA plan 报 native_click requires Linux/X11；TC-IDE-C0-02 仅 browser。Windows 使用合法输入或记录手工步骤，不能把 skip 当 PASS。配置/报告 qa-ui-auto-report/ed-parity-002/<run>/ 由本次执行生成；当前不存在本卡产品 PASS；历史 Linux 与旧 HEAD 不冒充 current
- 执行环境：当前 Windows / PowerShell；必要完成层为隔离 com.taomni.app.qa + WebView2。预期 src-tauri/target/qa-ui-auto/debug/taomni.exe 及匹配 .qa-identity.json；build/driver readiness 尚未检查，先核对复用，确需构建再后台集中构建。IDEA 安装 D:/Software/idea-2026.2.2.win，原件 qa-ui-auto-report/idea-reference/ed-parity-002/20260916/；P1 22:02–22:06:43 独占已结束，P2 全局输入需新时段，不能继承。Linux/macOS 兼容保留，当前未验证
- 修改权限：允许本卡产品代码、测试、文档、自有任务状态及必要构建/验证；不提交推送。本提示词仅在用户交给 P2 执行后授权生效；当前 P1 不启动 P2。先做 evidence/collector，只有真实反例才改产品行为；不自动委派。新增 QA 采集不得 fake ack/hash、跳过真实 native writer，必须证明生产入口和时点；不得缩减 A1/A3 的 W1/W2/unknown 要求
- 当前工作区或交接：分支 docs/code-workspace-idea-audit-20260913，P1 起始审查 HEAD 149be0e882ef638cae6b1d08984eaa21275966c6，起始干净；外部操作推进后的交接 HEAD 2901d541cbbf3a610b1c7873f73391b1529884bb。本卡 10 份审查源内容 hash 无变化；QA driver/runner 新合入已核对，重跑只读 plan 后 Windows native_click 限制仍在。P1 未提交/拉取，P2 须使用新 runner/build 身份。P1 diff 仅 docs-feature/code-workspace-idea-parity/ 下 backlog.md、task-planning.md、capability-matrix.md、index.md、references/fixture-catalog.md；新增 save-race-baseline-plan.md、references/ed-parity-002-reference.md、handoff-p2-ed-parity-002.md、evidence/ed-parity-002-p1-identity.json、evidence/ed-parity-002-p1-static.md。忽略目录为 IDEA 原件/隔离 fixture。无产品源码/测试变更，无产品运行或构建；最终检查见 p1-static；接手重新记录实际 HEAD/diff，保留这些文档

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
