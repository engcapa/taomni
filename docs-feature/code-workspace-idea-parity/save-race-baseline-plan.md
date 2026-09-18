# 保存期间继续输入：P1 保留基线与 P2 补证设计

<a id="ed-parity-002"></a>

## ED-PARITY-002

2026-09-16；唯一任务来源：[backlog.md](backlog.md) / ED-PARITY-002；P0 `AUDIT-20260913-01`，来源 [REQ-11](overall-audit-plan-20260913.md#req-11) / [CW-EDIT-003](capability-matrix.md#cw-edit-003)。[初始规格](task-planning.md#ed-parity-002)、[参考包](references/ed-parity-002-reference.md)、[P2 交接](handoff-p2-ed-parity-002.md)。

接手分支 `docs/code-workspace-idea-audit-20260913`，HEAD `149be0e882ef638cae6b1d08984eaa21275966c6`，工作区干净。生产文件内容身份与本轮 IDEA 原件清单见 [P1 identity](evidence/ed-parity-002-p1-identity.json)。本轮只有源码阅读、IDEA 操作、QA 只读 plan 和文档静态检查；所有 Taomni 产品验证未执行。

收尾期间 HEAD 被外部操作推进到 `2901d541cbbf3a610b1c7873f73391b1529884bb`（本 agent 未提交/拉取）；本卡 10 份审查源内容 hash 无变化。QA driver/runner 有新合入，已重读相关 diff 并重跑只读 plan，Windows `native_click requires Linux/X11` 结论不变；P2 使用最终 HEAD 的 runner/build 身份，不能复用旧 native PASS。

本包产物是**一个文件保存竞争的当前 Windows native 保留基线**，包括成功、冲突、取消、失败和恢复；先建立反例或通过证据，再决定是否需要修复。不是重写保存管线，不扩展全部编码、Local History、剪贴板、IME、LSP 能力或冲突界面改版。源码合同充分，沿用并补齐本卡规格；目前没有运行反例，不另造等价 feature/issue 设计。

## 事实与尚未证明的部分

| 类别 | 当前事实及结论边界 |
|---|---|
| 已有生产基础 | `saveFile` 捕获 revision/style/disk/policy；`WorkspaceStyleController.executeSaveTransaction` 规范化并冻结 `PreparedSave`；`commitOpenBufferPreparedSave` 做同步边界检查、单 writer、回执分类、恢复台账；不是缺失保存能力 |
| 当前证据缺口 | P1 没有运行 Taomni。现有 native TC-IDE-C0-01 没有等待 writer 回执期间继续输入的时点断言；TC-IDE-C0-02 是 browser VFS。挂载 deferred writer 用例不能证明 Windows 文件字节 |
| 待归因风险 RISK-01 | `CodeWorkspaceTab.tsx` 读取 `liveAfterWrite` 并分类后，await `lspWorkspaceDidChangeWatchedFiles`，随后把旧 `latestNow.text`/`dirty: stale` 交给 `mutateOpenBuffer(..., "save-writeback")`。后者采用 patch.text；revision 的 Math.max 不保护新文本。必须覆盖该 await 内输入；这是源码可见的竞争窗口，尚未运行复现，不能记产品 FAIL/PASS |
| 已采 IDEA 行为 | 同构 F1 文本的保存、保存后继续输入、undo；两次外部冲突/Esc、加载磁盘恢复。IDEA 连续输入可能跨 Save 合并 undo；移动 caret 后的单字符输入可独立撤销。详见参考包，不能假定 Save 总是切分 undo |
| 视觉/交互差异 | IDEA File Cache Conflict 与 Taomni ExternalFileConflictDialog 的按钮、密度、默认焦点不同；Taomni 还有独立 typed receipt/recovery。当前仅有 IDEA 观测和 Taomni 静态事实，不声明双侧 matched，也未接受差异或关闭 CW-EDIT-003 |
| 非本包目标决定 | 完整自动保存策略、冲突 UI 改版、像素对齐和 IDEA 内部存储实现均未决定；保留于 CW-EDIT-003。若实际要求改这些目标，交 P0 增量，不混入本补证卡 |

历史只读：ED-SAVE-004（2026-09-01，HEAD `06e3852a`）、[ED-AUDIT-004](../../claudedocs/code-workspace-idea-parity-backlog-2026-09-audit.md)（2026-09-09，HEAD `c8082211`）和 [ED-REPAIR-001](../../claudedocs/code-workspace-idea-parity-backlog-2026-09-main-repair.md)（2026-09-12，HEAD `5011ff5d`）。前两者有 Linux 编码/receipt/冲突记录，后者是 WorkspaceEdit 保存失败后避免重复应用 text 的修复，不等于当前直接 Ctrl+S 的时序覆盖。ED-AUDIT-004 的 comparison 实为 `incomparable` 加当时维护者豁免；本卡不继承该豁免、owner、状态、AC、PASS 或 build gate。ED-PARITY-001 的 Linux save/undo 也没有本卡竞争时点。所有历史日期原样保留。

## 生产链、文件责任与共享消费者

行号只供本 HEAD 定位，P2 必须按符号重查。下表“责任”是模块工作边界，不是开发 owner metadata。

| 文件 / 符号 | 责任、接口与下游 |
|---|---|
| [CodeWorkspaceTab.tsx](../../src/components/editor/CodeWorkspaceTab.tsx) `editor.save` 注册（14888）、EditorGroup `onSave`（19125）、`saveFile`（6180） | 唯一用户保存入口；只处理已有可保存 dirty 文件。冻结 `SaveTransactionV2`，不因补证增加第二条保存入口 |
| 同文件 `mutateOpenBuffer`（4406）/ `openFilesRef` / workspace instance store | live 文本、savedText、revision、dirty 的 owner；CodeMirror 输入、其他 view、undo 与 UI store 必须一致；不能只检查隐藏 DOM receipt |
| [workspaceStyleController.ts](../../src/components/editor/workspace/workspaceStyleController.ts) `executeSaveTransaction`；[saveNormalizationPipeline.ts](../../src/components/editor/workspace/saveNormalizationPipeline.ts) | style/format/import/normalize/encoding 的 prepare；本包 plain text 关闭 format/import，记录有效配置，冻结后不得重读生成另一份字节；prepare 期 revision 变化取消 |
| [saveCommit.ts](../../src/components/editor/workspace/saveCommit.ts) `PreparedSave` / `SaveCommitResult` / `SaveTransactionRegistry` / `classifySaveWriteback` / `buildFinalBytesReceipt` | workspace、fileKey、transactionId、epoch 生命周期；disk/memory/provider 三轴；关闭、重命名、删除、unmount 的失效边界。复用现有类型，不另造 boolean success |
| CodeWorkspaceTab `commitOpenBufferPreparedSave`（5649）、`writeTextSnapshot`（5244） | history before-image → 同步 revision/path/style/owner check → native writer → ack/unknown 回读 → owner gate → watcher → buffer merge → Git/semantic/LSP → observation；RISK-01 在 watcher await 两侧 |
| [workspace.ts](../../src/lib/editor/workspace.ts) `workspaceWriteFileEncoded` / `workspaceWriteLooseFileEncoded`；[workspace.rs](../../src-tauri/src/workspace.rs) `workspace_write_file_encoded` / `write_workspace_bytes_with_fault` | 真实 IPC、expected hash、编码、temp write/replace、实际回读、`WorkspaceWriteAck`；loose-file 是共享消费者，不能将 rooted fixture 结果外推它。本包根目录内文件必测；若改共享 writer 则追加 loose-file smoke 与相关 Rust 测试 |
| [saveObservationContract.ts](../../src/components/editor/workspace/saveObservationContract.ts)、CodeWorkspaceTab `createSaveObservationRecord` / `code-workspace-save-observation`（19271） | result 与 live revision/dirty 对齐；`sr-only` 节点是观测/可访问性接口，不是可见状态条。可见结果另看 tab dirty 与 status message，raw hash 独立回读 |
| [ExternalFileConflictDialog.tsx](../../src/components/editor/workspace/ExternalFileConflictDialog.tsx)、CodeWorkspaceTab `dismissExternalFileConflict` / `keepLocalExternalFileConflict` / `loadDiskExternalFileConflict` | Esc/Decide Later 仅移除队列项，不更新 stale hash；Keep Local 更新基线但仍须显式保存；Load Disk 是显式替换内存。必须记录焦点、选区与撤销，不把 Cancel 当 Reload |
| [WorkspaceRecoveryDialog.tsx](../../src/components/editor/workspace/WorkspaceRecoveryDialog.tsx)、CodeWorkspaceTab `recordUnknownDiskEffect` / `recordCommittedDiscardLedgerEntry` / `readBackDiskSnapshot` | unknown 回读分类、阻断盲重试、关闭后 committed 恢复；before-image 和 ledger 可定位，不删除其他 workspace/path 的记录 |
| [workspaceEditApply.ts](../../src/components/editor/workspace/workspaceEditApply.ts) 经 `saveOpenBufferText`；history replay、watcher、Git refresh、semantic index、LSP save/change | 如果 P2 修 committer，必须复验这些相交消费者。保留 ED-REPAIR-001 save-only retry 不重复修改、取消保留 journal；不可为修 Ctrl+S 绕过公共事务 |

## 本卡决定

- **ED-PARITY-002-DEC-01**：证据优先，真实剩余工作是 native 时序与当前源身份补证。无反例不改产品行为；若反例涉及本卡输入丢失/错误 dirty，P2 在同卡记录最小修复设计与回归。超范围交 P0，不能新建替代卡。
- **ED-PARITY-002-DEC-02**：测试区分三个时段：W0 prepare/history await（writer 尚未调用）；W1 writer 已调用但 ack 尚未交给 committer；W2 ack 已到、watcher await 未结束而 merge 尚未发生。普通“保存后再输入”不能替代 W1/W2。
- **ED-PARITY-002-DEC-03**：磁盘事实与内存分别判断。冻结 B1 落盘、live B2 保留且 dirty=true；随后明确再保存才落 B2。取消只在写前证明目标文件零写；已经 committed 的迟到结果不能降为 cancelled。history 的预写快照可存在，不把零目标文件写入误写为零辅助存储活动。
- **ED-PARITY-002-DEC-04**：一次 undo 指明确单字符、独立编辑组，先保存 B1 并移动 caret 左/右后再输入 X，撤销恢复 B1；磁盘不因 buffer undo 自动回滚。另记录 W1/W2 中实际 undo 分组，不强制复制 IDEA 跨 Save 分组，也不把输入两次的自动分组差异冒充丢字。
- **ED-PARITY-002-DEC-05**：不做结构/UI 改版，无新图稿必要。沿用当前状态栏/dirty 标识与冲突/恢复入口；焦点可见，正常 Save 不抢焦点/选区，取消后可继续编辑。颜色使用现有文本/边界/警告角色，失败不能只靠颜色；长路径可截断但完整路径可取，窄窗按钮可换行、内容可滚动。IDEA 参考仅说明已采动作和布局角色；未知有效字体/zoom 不形成像素指标，视觉结论保留待验证。
- **ED-PARITY-002-DEC-06**：原 required evidence `document/code-audit/native` 保留；本包将建立定向回归/时序采集，增加 `unit/typecheck`，不继承全仓 build gate。IDEA comparison 以 A2 文档逐维报告，缺精确同态侧保持 unverified/incomparable；本卡不是宣告完整对齐的卡，不借旧豁免签 matched。
- **ED-PARITY-002-DEC-07**：当前端 Windows/WebView2 完成必要 native 后才可交付；Linux/WebKitGTK、macOS/WKWebView 保留兼容并明确未验证。没有实际 JDT LS 不声称 provider 通过；plain text 不要求为本卡启动 Java provider。

## 连续场景与精确断言

使用 [参考包 F1-SAVE-002](references/ed-parity-002-reference.md#fixture) 的 B0/B1/B2 字节。每个竞争分支从独立 B0 副本重新开始；不是每个分支使用遗留内容。路径为本卡报告 run 的 `fixture/edit.txt`，打开源码编辑态，无 Git、无 LSP。固定 UTF-8 无 BOM / LF；关闭格式化、organize imports、自动保存和自动尾换行/trim，或记录有效规范化并据其生成明确期望，不能悄悄改变期望以通过。SDK 不适用。

| 步骤 | 操作、时点 | 可观察结果 |
|---|---|---|
| S0 | 原生从隔离根打开 edit.txt；caret 1:1，selection 空 | 磁盘/正文 B0、dirty=false；记录 build/source、路径、revision、有效编码/EOL 与焦点 |
| S1 | Ctrl+End 输入 S 得 B1，Ctrl+S | 捕获 transactionId、frozen revision/text hash、writer 调用与真实 ack；正常分支磁盘 B1、dirty=false、focus/caret 不跳；writeCount=1 是 receipt 断言，另以时序日志确认没有重复调用 |
| S2-W0 | 在 prepare/history await 期间移动 caret 后输入 X，再放行 | B2 保留；writer 次数 0、磁盘 B0、cancelled/none，无成功 receipt、dirty=true；取消可再次保存 |
| S2-W1 | writer 发出后、向 committer 交付 ack 前输入 X，再交付真实 ack | 磁盘 B1；正文 B2、revision 不回退、dirty=true、saved-stale-snapshot/committed/kept-dirty；不把 B1 作为当前 didSave 发送。插入位置在末尾，caret 4:3、selection 空 |
| S2-W2 | ack 后等待 watcher 的区间内输入 X；释放通知等待 | 与 W1 的字节/内存保护相同，必须能区分 RISK-01；不能只重跑 W1 并声明 W2 通过 |
| S3 | 在保留 B2 的编辑器继续输入再撤销；另在稳定 B1 上按 DEC-04 独立输入 X/undo | 单个编辑组可撤销；undo 不写盘、不创建额外保存 undo；无重挂载/丢焦点。显式保存当前内容后字节与新 receipt 一致 |
| S4 | 重置；B1 dirty 时 host 写 E1=`EXTERNAL\n`，让 watcher 发现；Esc/Decide Later；Ctrl+S | 取消冲突 UI 不写盘、不丢 local 文本，不宣称已解决；再次保存得到 conflict/none，无成功 receipt，磁盘仍 E1。记录 selection 与焦点恢复，必要时用明确 click 恢复并标差异 |
| S5 | 独立重置重做冲突；选择明确恢复动作 Load Disk（本包不点 Keep Local 覆盖） | 内存 E1，磁盘 E1；再输入独立字符并保存可成功。恢复前/后内容都留证；Load Disk 的实际 undo 能力按生产契约记录，不伪造自动恢复被丢 local 内容 |
| S6 | 选择 ASCII，输入不可编码字符；保存失败；取消 encoding 弹层；切回 UTF-8，再保存 | failed/none、目标字节不变、dirty=true、错误可见；取消转换不另写；恢复后成功。追加 UTF-8 BOM+CRLF 一个代表变体，只有一个 BOM、无 CRCRLF，保留保存时新输入 |
| S7 | 控制真实写入的响应丢失/故障并回读；分别观察 intended/old/foreign/unreadable | intended→committed；old→failed/none 可恢复；foreign/unreadable→failed/unknown+recoveryId，盲重试被阻断；不能把无法注入此故障记作通过。取消 recovery UI 零额外写入；明确重读/解决后才能重试 |
| S8 | W1 期间关闭最后 view 或使 workspace owner 失效，再交付真实 ack | committed-writeback-discarded，有 disk hash/recoveryId；不复活 tab、抢焦点或发迟到 didSave；通过 recovery Reopen 检查真实字节。若切另一 view/workspace，晚结果不得覆盖其正文 |

错误与取消分支分别记录：result kind、disk/memory/provider effect、磁盘前后 hash、live/saved text hash、revision、dirty、焦点/selection、receipt/recoveryId；截图只证明可见状态，不证明磁盘。

## AC / V 与实施顺序

| 本卡 AC | 必须满足的断言 | 验证 |
|---|---|---|
| **ED-PARITY-002-A1** | S0–S2 的 frozen B1 字节和 B2/live dirty 分离；W0 零 writer；W1/W2 都不覆盖新输入；S4 typed conflict 不清 dirty/不写 E1；同一 transaction 不重复写 | V1、V2、V3 |
| **ED-PARITY-002-A2** | 同 fixture 的目标/已观测/不可比状态清楚，正常保存、冲突、Esc、恢复、undo 均记录焦点/selection；IDEA 与 Taomni 的功能、视觉、交互独立结论和 source/settings/artifact 身份完整；缺侧明确列出，不能借局部 native 或旧豁免宣布 matched | V1、V3、V4 |
| **ED-PARITY-002-A3** | S3/S5–S8 一次 undo、编码/EOL/BOM、none/unknown/committed 分离、取消零额外写、owner 迟到与 recovery；改动共享 committer 时 save-only retry/其他 view/loose-file 受影响断言继续成立 | V1、V2、V3 |

- **ED-PARITY-002-V1（document/code-audit）**：重新核对本表生产符号与未提交 diff；审阅 [shared contracts](../../claudedocs/code-workspace-idea-specs/shared-contracts.md) 的 byte ack 不覆盖新文本、异步 owner、typed effect。读取历史报告只判断覆盖范围。P1 源码审查不是 P2 的当前产品 PASS。
- **ED-PARITY-002-V2（unit/typecheck）**：优先读并运行 `CodeWorkspaceTab.test.tsx` 的 `cancels save with 0 disk writes when user edits buffer during historySnapshot await`、`preserves concurrent edits and marks dirty when disk write was in-flight`、`discards writeback and never recreates a closed buffer when writer resolves after close`、unknown/hash-mismatch/lost-acknowledge 测试。新建 W2 最小回归（尚未编写）：只 defer watcher promise，先返回 writer ack，再用实际编辑入口输入 X，再 release watcher，检查正文/dirty/selection/第二次保存字节；在当前代码运行记录反例或通过，不能 mock 掉 mutate/merge。若修共享 committer，选 ED-REPAIR-001 retry/cancel/typing/unknown 与 split survivor 断言。稳定后一次 scoped typecheck 覆盖全部实际修改 TS 文件；没有修改也核对 owned 核心文件一次，不逐文件反复运行。
- **ED-PARITY-002-V3（native）**：Windows `com.taomni.app.qa` + WebView2，S0–S8 集中执行；独立 Python/PowerShell 读取真实文件 bytes/hash。旧 `TC-IDE-C0-01` 可复用 byte receipt/冲突/encoding assertions，但 QA plan 已报告 `native_click requires Linux/X11`，不能直接作为 Windows 命令。P2 负责新建 `TC-IDE-PARITY-002-save-race-native.testcase.yaml`（ID `TC-IDE-PARITY-002`，尚不存在），使用 Windows 支持的 WebDriver 输入或明确手工 OS 步骤，并维护 covers/catalog；绝不把 skip 当通过。相关 QA 设施/collector 责任见下节。
- **ED-PARITY-002-V4（document 中的比较）**：复用 REF-PARITY-002-WIN-20260916，使用 B0/B1/B2/E1 与 E3 复现子序列，普通 save/undo 和冲突 Esc 有参照；W0/W1/W2 与 unknown/recovery 内部分类是 Taomni 保留合同，不伪造 IDEA 对应 result kind。P2 写两侧观察表及未观测项。未知 profile 阻断精确像素结论，不阻断本证据卡对数据保留的执行；没有许可把差异默认为接受。

P2 可用的现有快速命令（本轮均未执行）：

```powershell
pnpm exec vitest run src/components/editor/CodeWorkspaceTab.test.tsx -t "cancels save with 0 disk writes|preserves concurrent edits|discards writeback|records unknown disk effects|hash-mismatch save|lost-acknowledge save|verified zero-effect unknown" --maxWorkers=1
pnpm exec vitest run src/components/editor/workspace/saveCommit.test.ts src/components/editor/workspace/saveNormalizationPipeline.test.ts src/components/editor/workspace/saveObservationContract.test.ts --maxWorkers=1
python .agents/skills/code-workspace-idea-task/scripts/typecheck_scope.py --path src/components/editor/CodeWorkspaceTab.tsx --path src/components/editor/workspace/saveCommit.ts --path src/components/editor/workspace/workspaceStyleController.ts
```

新增 testcase/collector 完成后，P2 先只选新 ID 做 native dry-run/plan 核对 Windows 支持，再检查并复用 QA binary；确需构建时按 native-testing 的后台 helper 集中构建。预期 binary 为 `src-tauri/target/qa-ui-auto/debug/taomni.exe`，旁附有效 `.qa-identity.json`；不得手写身份，不使用生产 app。运行配置/报告放 `qa-ui-auto-report/ed-parity-002/<run>/`，绑定实际源码含 diff、case、runner、config、OS/WebView、fixture、binary hash；本轮未确认 binary/driver readiness，不表示它们已存在或通过。

Linux 计划同一 S0–S8，用 WebKitGTK/X11 合法输入；macOS 使用 WKWebView QA bridge、Cmd+S/Cmd+Z 和正确路径/键位。若跨端未执行逐项 unverified，不能从 Windows 原生字节证明另两端锁文件/权限行为。无需发布 build gate，也不运行全仓产品套件。

## Native 时点采集责任与就绪边界

现有 YAML 没有可证明 W1/W2 的暂停控制；P1 不把假想 `save_pause` 命令打印成可运行接口。P2 的实施工作包含一个本卡专用 collector/fixture：优先复用 QA driver/浏览器调试协议实际能力，必要时新增仅隔离 QA 构建可达的时点钩子，模块责任为 CodeWorkspaceTab 的 prepare/ack/watcher 边界和 `.agents/skills/qa-ui-auto/scripts/` 的本卡采集模块（新文件）。若需要 TypeScript adapter，新文件归 `src/components/editor/workspace/`，明确 QA 构建隔离与正常构建无入口并测试；不改生产默认延时。

所需协议是设计要求而非现存 API：按 workspace/fileKey/transactionId arm 一次性 W0/W1/W2；记录 enter/release 单调时钟、live revision 与真实 native invoke/ack；超时/异常/owner 失效释放，不跨下一次 transaction 留悬挂。W1 必须调用真实 Tauri writer，只推迟 ack 交给现有 committer，不能伪造 ack/hash，也不能重跑 writer；这证明“UI 等待真实写入回执期间输入”，不声称测到了磁盘物理写入中的键盘时刻。W2 保留真实 watcher 调用，只延迟其完成交付，定向放大已经存在的 await。trace 必须证明真实调用顺序；没有可靠时点就记缺证据。

unknown 故障可在 QA 传输边界让一次真实响应不可见，再用真实回读判断效果，记录为“原生写入+受控响应故障”，不冒充自然 OS 故障。无可靠 fault seam 时先完成 mounted 负路径，native 对应项仍未验证，不能 done。collector 不得绕过 action/store/IPC，也不得用 `eval_readonly` 执行写操作或注入 store。

这些是本卡 P2 明确承担的验证设施工作，不是要求 P1 先实现测试。所有实施权限只在用户实际交给 P2 时生效。若现有环境无法支持且新增设施超出本包，保留证据缺口，交回 P0 划定新范围；不得减掉 W1/W2 或 unknown 要求制造通过。

## 就绪检查与完成上限

P1 已核对：唯一板/P0 来源/无依赖；当前 caller 与共享消费者；独立 AC/V/DEC；真实 IDEA 外部可见关键状态；native 采集缺项的明确实施责任；Windows 用例不兼容点与三端计划。没有待用户选择的产品目标：本卡依原 P0 只做保存保留基线。字体/zoom 的未知项不被填成默认，影响精确视觉比较时保持未验证；后续桌面时段需重新确认。

P1 author 可将同卡转 ready、planning_required=false，required evidence 为 `document/code-audit/native/unit/typecheck`。不写 owner/claimed_at/baseline 或执行 evidence。ready 只说明可交 P2 执行这份计划，不是 native/IDEA/产品通过。

P2 完成要求：当前端 A1–A3 与新增/受影响保留断言满足，全部 required kinds 有真实检查；若发现 bug 在本卡修复并验证。采集/环境不齐如实接续未完成状态，不将本卡 done 换算为 CW-EDIT-003 三维对齐。纯补证完全通过时允许没有产品行为修改；这仍是有效工作，不制造代码改动。
