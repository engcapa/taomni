# ED-PARITY-002 P2 报告：保存期间继续输入的 Windows native 保留基线

< [设计](../save-race-baseline-plan.md#ed-parity-002) / [P1 静态核对](ed-parity-002-p1-static.md) / [P1 身份与 IDEA 原件清单](ed-parity-002-p1-identity.json) / [IDEA 参照](../references/ed-parity-002-reference.md)。本文是 P2 自检报告，不是独立验收；任务板状态见 backlog（P3 复核结论与补证闭环见 §10）。

## 1. 身份、范围与结论上限

- 分支 `docs/code-workspace-idea-audit-20260913`，验证 HEAD `06ea2159b1ddf624d12aa570523416a278cbb9b9`（P1 交接后由外部操作推进；本卡未提交/拉取/推送）。
- 当前运行环境：Windows + WebView2（Microsoft Edge 153.0.4234.32），隔离 `com.taomni.app.qa` debug 二进制。
- 第二轮（P3 补证后）QA binary：`src-tauri/target/qa-ui-auto/debug/taomni.exe`，sha256 `ebb032875f1bb83ce7f1eabcb36fc77f59d2e73677beb178d015e9551baaa9ff`；源码身份 `ad403f205917489192cc13bef34b96b3b04efbe8b05942f52a23683b28476d97`（构建 234.2s；运行时 `identity_stable: true`）。第一轮 binary `f657c9bd…`（source `6c1932…`）及其 9 个失败/通过 run 仍保留在同一报告目录，作为反例与迭代记录。
- 本轮结论只覆盖：单文件保存期间的输入/dirty 保留、冲突/取消/失败/unknown（intended/old/foreign 三类真实回读）、迟到结果与 recovery Reopen、一次独立 undo、编码/EOL/BOM、焦点/光标记录。不代表 CW-EDIT-003 或 REQ-11 整体对齐，也不含 IDEA 内部 writer race 实测。
- TRUST 边界：IDEA 侧证据来自 P1 的 REF-PARITY-002-WIN-20260916 文本观察表与 30 件 manifest；manifest 列出的原始 PNG/JSON 当前在本工作区已不存在，因此无法复显或复算其 hash，精确像素比较保持 unverified/incomparable。

## 2. 生产效果链与 RISK-01 修复

用户动作 → `CodeWorkspaceTab.editor.save`/`saveFile`（唯一入口，冻结 `SaveTransactionV2`）→ `workspaceStyleController.executeSaveTransaction` 生成不可变 `PreparedSave` → `commitOpenBufferPreparedSave`：

1. `historySnapshot`（before-image，不 bump revision）→ **QA prepare gate** → 同步 `validatePreparedSaveBoundary` + owner check → 同一同步 turn 调用真实 `writeTextSnapshot` → **QA ack gate** → 真实 `WorkspaceWriteAck` → 真实 `lspWorkspaceDidChangeWatchedFiles` → **QA watcher gate** → 以**当时** live 状态分类 `classifySaveWriteback` → 单点 `mutateOpenBuffer(..., "save-writeback")`（merge 不覆盖新文本）→ Git/semantic/LSP → observation。
2. 失败/取消/unknown/迟到：typed `SaveCommitResult`（`cancelled`/`conflict`/`failed`/`saved-stale-snapshot`/`committed-writeback-discarded`），unknown 走真实回读三哈希分类（intended→committed、old→none、foreign/unreadable→unknown+recoveryId）；owner 失效后不回写、不复活。

**RISK-01 反例与最小修复**（源码审查命中、W2 回归先失败）：

- 原实现读取 `liveAfterWrite`/分类 writeback 后 `await watcher`，合并时复用 await 前快照（`text: latestNow.text`、`dirty: stale`）。W2 期间输入会被旧文本覆盖且 dirty=false（真实丢字）。
- 修复：watcher await 之后重新读取 `openFilesRef.current[key]` 并重跑 `classifySaveWriteback`，merge 使用最新 live 状态与 revision；owner 失效分支保持原样丢弃写回。W0/W1 的早期 discard 判定保留，新增 await 后 discard 判定。
- 回归：`CodeWorkspaceTab.test.tsx` 的 `preserves edits typed while the post-ack watcher notify is awaiting (W2)` 在修复前失败（store 文本回退为 B1、dirty 丢失），修复后通过。

## 3. W0/W1/W2 与受控故障采集设施（本卡新增）

- 渲染端 `src/components/editor/workspace/saveRaceProbe.ts`：仅在隔离 QA bundle（`vite build --mode qa` → `__TAOMNI_QA_SAVE_GATE__`）自安装 `window.__taomniQaSaveGate`。正常构建该分支编译为 `if (false)`：实测生产 bundle 0 处 gate 字符串、QA bundle 1 处。probe 未安装时所有 hold/事件记录为 no-op。
- 时点定义（真实调用保留，只延迟交付）：`prepare`=history await 之后、writer 之前；`ack`=真实 `workspaceWriteFileEncoded` 已调用、真实 ack 未交给 committer；`watcher`=真实 ack 已交付、真实 `lspWorkspaceDidChangeWatchedFiles` 已调用而完成未交付、merge 未发生。
- 受控 unknown 故障：`unknown-response`（真实成功后立即扣留响应）与 `unknown-response-delay`（真实成功或真实 typed 失败后扣留响应，直到 runner 释放 `fault` hold）。后者让 runner 在真实响应不可见期间改写真实磁盘，从而由生产回读路径产生 intended/old/foreign/unreadable 四类分类；故障记录 `fault-pending`/`fault-injected`、`realOutcome`、真实 ack/intent/old hash。绝不伪造 ack/hash，也不由 probe 调用 writer。
- 隔离与安全：按 `workspaceId/fileKey/transactionId/filePath` 可选匹配、一次性 arm、enter/release 采样 live revision、owner 失效 50ms 轮询释放、`timeoutMs` 兜底释放、重新 arm 释放旧 hold；`save_race_release` 对 fault hold 同样生效（S8 则由 owner-invalidated 自动释放）。
- Runner 模块 `qa_ui_auto/save_race.py` + `native_steps.py` 注册 `save_race_arm|wait_entered|release|trace|note`；`save_race_note` 用只读表达式把焦点/光标/undo 正文/recovery 行文本持久化到 `save-race-notes.json`（含变更模式拒绝）。`host_delete_file` 供 unreadable 分支使用（本轮未执行）。缺 gate 的二进制直接 step 失败。
- 新 fixture `editor_save_race`：独立 B0 副本（edit.txt、edit-w0/1/2.txt、edit-conflict[2].txt、edit-encoding.txt、edit-unknown[-old|-foreign].txt、edit-close.txt），B0=39B `2b7edc…88d`。

## 4. S0–S8 native 实际执行与断言

单一 case `TC-IDE-PARITY-002`（`qa-ui-auto-tests/cases/TC-IDE-PARITY-002-save-race-native.testcase.yaml`）。**最终通过 run**：`qa-ui-auto-report/ed-parity-002/run-20260917-092709-524284600/`（1 passed / 0 failed / 0 skipped，83.2s case / 89.1s 总）。失败与迭代 run 保留（`061545` 观察节点 flush 时序、`061741` 树 stale element、`061831` innerText 换行断言、`062257` S8 显式 release 冲突、`090818` history 去重、`091008` 冲突弹窗遮罩/状态覆盖、`091952` reload 后未恢复 workspace tab、`092332` Reopen 后 CM 未挂载）。case 覆盖 `F25.5, F1.7`，static audit gate 无回归，testid catalog 已按新增 recovery 控件重生成。

| 设计步骤 | case 断言（host 侧独立读盘 + DOM observation + trace artifact） | 结果 |
|---|---|---|
| S0 | B0 sha `2b7e…`、observation clean、focus note（tree-file） | PASS |
| S1 | 输入 S → dirty；receipt UTF-8/no-BOM/LF 文本 B1；磁盘 B1 `77e1…`；dirty=false；focus before/after=cm-content；cursor Ln 4 Col 2 | PASS |
| S2-W0 | arm prepare → enter(rev=1) → 输入 X → release(rev=2)；settled `cancelled`/`none`；`forbid_between` 证明 arm→settled 间无 writer/ack/watcher 事件；磁盘仍 B0；trace `s2-w0-trace.json` | PASS |
| S2-W1 | arm ack → 真实 writer → enter(rev=1) → 输入 X → release(rev=2) → 真实 `ack-delivered`(`77e1…`) → 正文 B2、dirty=true、`saved-stale-snapshot`；磁盘 B1；undo 后正文回到 `…line threeS`（note 记录，单字符组）且磁盘仍 B1 | PASS |
| S2-W2 (RISK-01) | arm watcher → writer → ack → watcher → enter(rev=1) → 输入 X → release(rev=2)；正文保留、dirty=true、`saved-stale-snapshot`；磁盘 B1；undo 正文 note 记录 | PASS |
| S3 | 稳定 B1 基线上 caret 左/右后输入单字符 X → undo 精确恢复 B1（`indexOf("line threeSX")===-1`），磁盘不回滚；再次输入 X 显式保存 → receipt B2、磁盘 `7569…`；cursor/focus note | PASS |
| S4 | 真实 host 重写 E1 → 冲突弹窗 → Dismiss 后 buffer/磁盘不变、focus note；Ctrl+S → `conflict`/`none`/dirty、无 receipt、磁盘 E1；trace settled conflict | PASS |
| S5 | 独立冲突 → Load Disk：正文 E1、磁盘 E1；再输入 Z 保存 → receipt `EXTERNAL\nZ` | PASS |
| S6 | ISO-8859-1 下输入 你 → `failed`/`none`/dirty、无 receipt、磁盘仍 B1；undo + 切回 UTF-8 恢复；UTF-8 BOM+CRLF receipt；**BOM+CRLF W2 hold 变体**：冻结磁盘 47B `e1f9874b…`、live `…SXY` dirty、`saved-stale-snapshot`、trace 含 ack+watcher hash；最终保存 48B `237aa6c5…` | PASS |
| S7a intended | arm fault(unknown-response) → 真实 writer → `fault-injected`（真实 `77e1…`）→ 回读 `committed`（observed==written）→ `saved-current`；磁盘 B1 | PASS |
| S7b old | arm fault(unknown-response-delay) → 真实 writer 成功后 `fault-pending`/enter/release → host 恢复 B0 → `fault-injected` → 回读 `none`（observed=B0）→ `failed`/`none`/dirty、无 receipt、磁盘 B0；随后重试 receipt B1（history 去重，`require_history:false`） | PASS |
| S7c foreign | delay hold 期间 host 写 `FOREIGN\n` → release → 回读 `foreign`（observed=`861bbb…`）→ `failed`/`unknown`/state=recovery + recoveryId；外部冲突弹窗 Dismiss 后仍无 receipt；盲重试触发 `Save blocked`、磁盘不变；reload#1 recovery center 显示 `Foreign content · retries blocked` 行（行文本含 transactionId）；Decide later 关闭零额外写；reload#2 Acknowledge → 行消失（`No unresolved disk results`）+ 状态消息；明确解决后新输入 Z 保存成功 receipt `FOREIGN\nZ` | PASS |
| S8 迟到/owner | arm ack → 真实 writer → enter ack(rev=1) → 关闭 tab（dirty 确认）→ `owner-invalidated` 自动释放 → 真实 `ack-delivered` → settled `committed-writeback-discarded`；tab count=0、focus note（body，无焦点抢占）、磁盘 B1；reload 后 recovery center 显示 `Saved to disk · editor writeback discarded` 行（行内 transactionId 与 trace 的 `tx-save-…` 相同），Reopen 打开真实 B1：编辑器正文 `line threeS`、observation clean、磁盘 B1；Acknowledge 清除行 | PASS |

运行结束后的独立复核（非 app 路径）：`edit.txt`=B2 `7569…`、`edit-w0.txt`=B0、`edit-w1/w2/unknown/unknown-old/close.txt`=B1、`edit-conflict.txt`=E1、`edit-unknown-foreign.txt`=`FOREIGN\nZ`、`edit-encoding.txt`=BOM+CRLF 48B `237aa6c5…`，与预期逐项相等。

## 5. A2：IDEA 与 Taomni 对照（功能/视觉/交互分列）

IDEA 列来自 REF-PARITY-002-WIN-20260916（IU-262.10315.125，Windows，同 B0/B1/B2/E1 文本）；Taomni 列来自本轮 native run 与 trace/notes。**不宣布 matched**。

| 维度 | IDEA（已观测） | Taomni（本轮实采） | 结论 |
|---|---|---|---|
| 功能：保存后继续输入 | 输入 X 后 editor B2；磁盘仍 B1 | W1/W2：正文 B2、dirty=true、磁盘 B1；observation `saved-stale-snapshot` | 数据保留语义一致；Taomni 有 typed stale receipt |
| 功能：Save 与 undo 分组 | 连续输入可能跨 Save 合并 undo；移动 caret 后单字符为独立组 | W1/W2 undo 后正文均为 `…line threeS`（只回退 X）；稳定基线上单字符 X 撤销精确恢复 B1 且磁盘不回滚 | Taomni 实际分组已记录，与 DEC-04 允许的独立组一致；未强制等同 IDEA |
| 功能：外部冲突 + Esc/Decide Later | Esc 关闭弹窗，内存/磁盘保留双方 | Dismiss 后 Ctrl+S 得 typed `conflict`/none，磁盘保持 E1，dirty 保留；focus note 显示关闭后落回 body | Taomni 有 typed conflict receipt |
| 功能：显式 Load Disk | Enter 接受后 editor/磁盘 E3 | Load Disk 后正文/磁盘 E1，可继续编辑再保存成功 | 恢复语义一致 |
| 功能：unknown/owner 迟到 | 未观测 | intended→committed、old→none+可恢复、foreign→unknown+recoveryId+重试阻断+Decide later 零写+Acknowledge 后可重试；close-during-ack→committed-writeback-discarded+Recovery Reopen 验证 B1 | Taomni 保留合同证据；IDEA 无对应观测 |
| 功能：焦点/选区 | Save 无焦点跳转；冲突 Esc 回到 editor | Save 前后 focus=cm-content、cursor Ln 4 Col 2 保持；冲突关闭后 body（再次显式点击恢复）；S8 迟到后 body、Reopen 后焦点停留在 Reopen 按钮 | 功能级一致；IDEA 精确焦点环未比较 |
| 视觉：冲突弹窗 | 深色，三动作横排，默认 Load File System Changes | 深色，Decide Later/Load Disk/Merge/Keep Local，主按钮 Keep Local | 布局角色相同、动作集合与默认焦点不同；精确像素/字体不可比 |
| 视觉：recovery/receipt | IDEA 本地历史另有一套 UI | Taomni recovery center 行含 resolution、disk/buffer/provider、before/intended/observed 前缀与 Reopen/Acknowledge | Taomni 额外观测面；不作 IDEA 对照 |

**未观测/不可比（保留 unverified）**：IDEA 内部 writer/ack 时点、IDEA unknown IPC effect、IDEA 保存中磁盘状态、有效 UI/编辑器字体与 zoom、窄窗/overflow；Taomni 的 Linux/WebKitGTK 与 macOS/WKWebView 未运行；unreadable（回读失败→pending-readback）native 分支未执行（`classifyUnknownDiskEffect` 的 null-observed 分支与 `resolveUnknownDiskResolution` 的 pending-readback 由既有 mounted 测试覆盖）；明确解决后的 native 重试在 S7c 以新输入保存成功验证，S8 无对应重试场景。

## 6. 命令、构建与耗时

```powershell
# 定向单测（当前源码）
pnpm exec vitest run src/components/editor/CodeWorkspaceTab.test.tsx -t "cancels save with 0 disk writes|preserves concurrent edits|discards writeback|records unknown disk effects|hash-mismatch save|lost-acknowledge save|verified zero-effect unknown|preserves edits typed while the post-ack watcher|QA gate|ED-REPAIR-001|ED-AUDIT-009: split close" --maxWorkers=1   # 16 passed
pnpm exec vitest run src/components/editor/CodeWorkspaceTab.test.tsx src/components/editor/workspace/saveRaceProbe.test.ts src/components/editor/workspace/saveCommit.test.ts src/components/editor/workspace/saveNormalizationPipeline.test.ts src/components/editor/workspace/saveObservationContract.test.ts --maxWorkers=1   # 268 passed, 213.5s（含 10 项 probe 测试：延迟 hold、真实 typed 失败 hash、note、状态覆盖）
python .agents/skills/code-workspace-idea-task/scripts/typecheck_scope.py --path src/components/editor/CodeWorkspaceTab.tsx --path src/components/editor/workspace/saveRaceProbe.ts --path src/components/editor/workspace/saveRaceProbe.test.ts --path src/components/editor/CodeWorkspaceTab.test.tsx --path vite.config.ts --path vitest.config.ts   # passed, 0/0

# 构建隔离与 QA 构建（第二轮）
pnpm exec vite build            # production bundle: __taomniQaSaveGate 0 处
pnpm exec vite build --mode qa  # QA bundle: 1 处
python .agents/skills/qa-ui-auto/scripts/background_job.py start --name ed-parity-002-native-build-r2 --log qa-ui-auto-report/_local/ed-parity-002-native-build-r2.log -- python .agents/skills/qa-ui-auto/scripts/native_build.py   # exit 0, 234.2s, identity ebb03287…

# native（Windows/WebView2，隔离 com.taomni.app.qa）
python -m qa_ui_auto run --mode native --filter TC-IDE-PARITY-002 --config qa-ui-auto-report/ed-parity-002/config.yaml --report-dir qa-ui-auto-report/ed-parity-002   # 1 passed / 0 failed / 0 skipped, 89.1s
python -m qa_ui_auto status --case TC-IDE-PARITY-002 --platform Windows --reports qa-ui-auto-report/ed-parity-002 --json   # ok: true, gaps: []
python -m qa_ui_auto.audit --gate   # OK, orphans 0
python -m qa_ui_auto.gen_testid_catalog   # 3 个 recovery 控件

# QA 脚本自检
python -m unittest test_verification_selection test_native_assertions test_runner_receipt test_verification_workflow test_tauri_webdriver   # 64 tests OK (7 skipped)
```

## 7. 保留行为与共享消费者

- 原有 7 项 save-race + unknown/hash-mismatch/lost-ack 测试与 `saveCommit/saveNormalizationPipeline/saveObservationContract` 全部通过；ED-REPAIR-001 4 项、ED-AUDIT-009 split-close 1 项通过（268 项总量）。
- 未改 `saveOpenBufferText`/`WorkspaceEdit` 路径、loose-file writer 与 Rust IPC（`workspace.rs` 未变）。正常保存不因 probe 改变：S1 trace 无 enter/release，生产构建无 gate 入口。

## 8. 变更文件

生产：`src/components/editor/CodeWorkspaceTab.tsx`（RISK-01 修复 + prepare/ack/watcher hold 与 trace + 受控故障包装）、`src/components/editor/workspace/saveRaceProbe.ts`（新，QA-only gate：时点、延迟故障、note）、`vite.config.ts`、`src/vite-env.d.ts`。
测试：`CodeWorkspaceTab.test.tsx`、`saveRaceProbe.test.ts`（10 项）、`vitest.config.ts`。
QA 设施：`assets/tauri.qa.conf.json`、`schema/testcase.schema.json`、`references/verb-catalog.md`、`references/testid-catalog.md`（重生成）、`scripts/qa_ui_auto/native_steps.py`、`save_race.py`（新）、`fixtures/editor_save_race.py`（新）、`fixtures/__init__.py`、`qa-ui-auto-tests/feature-list.md`（3 个 recovery 控件）、新 case。
文档：本文件、evidence JSON。

## 9. REQ-11 / CW-EDIT-003 差距状态

- 本卡关闭的差距（Windows native）：W0/W1/W2 时点与冻结字节、live B2/dirty、冲突取消零写、unknown intended/old/foreign 真实回读与 recovery 闭环、owner 迟到与 Recovery Reopen、单字符 undo、编码/EOL/BOM（含 BOM+CRLF hold 变体）、焦点/光标记录。RISK-01 已由真实反例确认并修复。
- 未关闭：IDEA 内部 writer race/unknown/精确视觉指标（unverified）；Linux/WebKitGTK、macOS/WKWebView 未执行；unreadable native 分支未执行；完整 Local History、IME、冲突 UI 改版不在本卡。
- 任务完成不等于 CW-EDIT-003 三维整体对齐；差异已如实记录，未宣布接受或 matched。

## 10. P3 复核与补证闭环（第二轮）

P3（只读独立复核）结论为**证据阻塞**：确认身份/证据可复查、RISK-01 无遗漏 merge 分支、测试未 mock 被改路径、QA 隔离静态接线成立、S8 owner-invalidated 自动释放符合设计；但指出 native PASS 未覆盖设计要求的 S7 old/foreign/unreadable 回读分类、S8 Recovery Reopen 闭环，以及焦点/selection 与 BOM+CRLF hold 变体记录不足；并澄清提交不是验收前置条件。

本轮按最小接续范围补齐并验证：

1. **S7 old→none（S7b）**：真实 writer 成功后扣留响应，host 在 hold 期间恢复 B0，生产回读得 `none` → `failed`/`none`、无 receipt、磁盘 B0；随后重试成功落 B1。
2. **S7 foreign→unknown（S7c）**：hold 期间 host 写 FOREIGN，回读得 `foreign` → `failed`/`unknown` + recoveryId；盲重试 `Save blocked` 且零写入；reload 后 recovery center 行显示 `Foreign content · retries blocked`；Decide later 关闭零额外写；Acknowledge 清除行后新输入保存成功。
3. **S8 Recovery Reopen**：迟到 settled 后 tab 不复活、无焦点抢占、磁盘 B1；reload 后 recovery center 行的 transactionId 与 trace 的 `tx-save-…` 相同，Reopen 加载真实 B1（编辑器正文 `line threeS`、observation clean、磁盘 hash 一致），Acknowledge 清除。
4. **交互与变体记录**：`save-race-notes.json` 记录 Save 前后焦点与 cursor、冲突关闭后焦点、S3/S2-W1/S2-W2 undo 正文与 cursor；新增 BOM+CRLF 的 W2 hold 变体（冻结 47B、live `…SXY`、最终 48B）。

未采纳 P3 的“未提交即阻塞交付”判断（验收对象含未提交工作区，且本轮禁止提交）；“所有已提交分支仍有问题”未逐分支核实，不作为结论。unreadable（回读失败→pending-readback）native 分支仍未执行，按证据边界保留 unverified，不折算为通过。

任务板约束：ED-PARITY-002 已是 done，task-board 脚本拒绝更新或重开 done 卡，因此板内保留第一轮 evidence 快照；本轮权威证据为磁盘上的 `ed-parity-002-p2-evidence.json` 与本报告，差异即本节内容。
