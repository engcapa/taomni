# Code Workspace main 合并后代码评审完善任务板（2026-09）

## 1. 任务规则与基线

本板由两条 ED-IMPROVE 实现分支的生产代码复审产生。目标为 `main`，审查日期 2026-09-11，基线 `0566cc249f39b2e860cc30155462f12080111f1d`（PR #560 合并 `wip/code-workspace-idea-parity-20260909`，实现 HEAD `8215052c5274483c5a36fa87b854217dbfa009a4`）。建板时工作区干净；本板涉及的 editor、workspace writer、LSP 生产代码与 `8215052c` 无差异。

本板是新的修复／完善计划，不修改 [ED-IMPROVE 任务板](./code-workspace-idea-parity-backlog-2026-09-b-review.md)、[ED-AUDIT 任务板](./code-workspace-idea-parity-backlog-2026-09-audit.md) 或 ED-FOLLOW 的状态、ownership、历史证据。历史 done 不证明新增边界已经满足；历史失败后的真实通过也不因本轮建板而失效。

使用 `code-workspace-idea-task`，每次只领取一张依赖已完成的卡，先审查当前生产 caller，再实施或补验。所有 task-board 命令显式选择本板：

```bash
python .agents/skills/code-workspace-idea-task/scripts/task_board.py --doc claudedocs/code-workspace-idea-parity-backlog-2026-09-main-review.md validate
python .agents/skills/code-workspace-idea-task/scripts/task_board.py --doc claudedocs/code-workspace-idea-parity-backlog-2026-09-main-review.md list --claimable
```

参考分支 `wip/code-workspace-idea-parity-20260909-meta-muse` 的审查 HEAD 为 `fb3f420b60e53d32ca0993fbb575c16202d4f261`。只按符号吸收 disabled 对象识别、CR 换行处理、请求时冻结剪贴板观察端点等经复核的思路，不整文件覆盖 main。两条独立分支间的删除差异不证明任何 agent 为过门禁而删测；本板不沿用该动机判断。

## 2. 详细规格索引

| 规格 | 内容 |
|---|---|
| [本轮详细规格](./code-workspace-idea-specs/idea-2026-main-review.md) | 10 张卡的代码事实、修复边界、验收、fixture、验证和上限 |
| [共享合同](./code-workspace-idea-specs/shared-contracts.md) | 身份、owner、结果、事务与证据语义 |
| [上一轮完善规格](./code-workspace-idea-specs/idea-2026-b-review.md) | 本轮应保持的 ED-IMPROVE-001..011 契约 |
| [保存与恢复规格](./code-workspace-idea-specs/idea-2026-transactions.md) | Save、历史与恢复基础设施 |
| [编辑规格](./code-workspace-idea-specs/idea-2026-editing.md) | IME、剪贴板及多视图行为 |
| [语义规格](./code-workspace-idea-specs/idea-2026-semantic.md) | provider 操作及 Replace 范围 |
| [性能规格](./code-workspace-idea-specs/idea-2026-performance.md) | 输入、保留量与恢复测量 |

## 3. 交付标准

每张卡使用自己的 `ED-MAIN-xxx-A1/A2/A3`，初始均为 `ready`，没有 owner、claim 或实施通过证据；依赖只引用本板 ID。`ready` 表示下游可以按依赖开始诊断／实施，不表示代码已修改。IME 卡明确区分已存在的正常分组和待验证的最终 flush 边界。

每卡 required_evidence 与 spec 一致。行为卡运行全部 owned paths 的 scoped typecheck；ED-MAIN-010 独家负责全仓 `pnpm build` 和最终矩阵。实际 Rust/IPC 变更必须追加真实 Rust 验证；原生副作用由 packaged `com.taomni.app.qa`、隔离 fixture 和独立后置条件证明。YAML、covers、controls 与生成目录按 `qa-ui-auto` 同步，不能以减少用例数或目录项推导质量改善，也不能为绿灯降低验收范围。

代码兼容 Windows、Linux、macOS。沿用已接受的本轮边界：完成实施时当前运行平台的必需原生验证即可交付，其他端分列 unverified 和后续步骤；本次设计环境为 Linux。Windows 专属保存问题必须修复已知有缺陷的 cfg 分支，Linux 测试只能证明相邻行为和可移植错误合同，不能声称 Windows 故障已经真机复测。缺少其他端设备本身不阻塞当前端交付；当前端 required kind 缺失、失败或仅 skip 不能 done。

真实 JDT LS `source.sortMembers` 的 discover→resolve→preview→apply→undo 必须保持。没有真实 Cleanup provider 时，保留专用 kind/profile 的 unavailable 边界并用模型证明失败合同，不把 generic fixAll、格式化或测试替身声称为正向 Cleanup。IDEA 2026.2.x 同 fixture 实测可选，未执行明确记录，不声称 L3 或对齐百分比。

新增性能测量限受影响热路径；原生与 browser proxy 分开，baseline/candidate 使用相同机器、runtime、fixture、warmup 和端点，保留 raw samples。C0-03 已知 WebDriver/WebKit 环境失败须如实记录，不能移出必需范围后写成全绿。最终集成卡不能凭文档或较少测试通过代替尚未完成的产品行为。

## 4. 排序与职责协调

| 顺序／任务 | 职责 | 依赖 |
|---|---|---|
| 001 | buffer 已改变但 Save 失败的效果／恢复 | 无 |
| 002 → 003 | 标准 disabled → 独立 LSP version 与完整载荷 | 002 接 001；003 接 002，共享 workflow/Tab adapter 顺序交接 |
| 004 → 005 | EOL／坐标 → 替换 preimage 和选中 edit 传递 | 005 接 001、004；共享 applier 接 001 |
| 009 → 006 → 007 | 视图快照兼容完善 → IME 收尾 → 剪贴板 owner | 按此顺序交接 Host/Group；各卡仅修改所属 lifecycle |
| 008 | Windows 保存替换时旧文件保全 | 无；只持有 Rust writer／平台适配，不改 001 的 TS 效果合同 |
| 010 | 最终集成回归、源码门禁和矩阵 | 001..009 全部 done |

共享 `CodeWorkspaceTab.tsx` 按 handler 归属：001 apply/history/recovery；002/003 Rearrange/Cleanup/LSP adapter；004 search navigation；005 Replace prepare/commit；009 view-state persistence；006/007 editor event/focus/observation 接线。不要借任务重写整份 Tab。005 和 003 若同时涉及 applier，003 只改版本传递，005 只扩展文件 precondition；落地前检查最新接口，保留其他改动。QA 目录文件是共用生成目标，每卡只维护自己的行为，最终由 010 统一核对。

## 5. 任务卡

### ED-MAIN-001 已修改 buffer 的保存失败效果与恢复闭环
<!-- ide-task {"id":"ED-MAIN-001","status":"done","priority":"P1","size":"M","depends_on":[],"spec":"claudedocs/code-workspace-idea-specs/idea-2026-main-review.md#ed-main-001","acceptance":["ED-MAIN-001-A1","ED-MAIN-001-A2","ED-MAIN-001-A3"],"required_evidence":["code-audit","unit","typecheck","browser","native","provider"],"audit":{"date":"2026-09-11","head":"0566cc249f39b2e860cc30155462f12080111f1d","finding":"已确认源码及前轮生产模型探针：applyTextDocumentEdit 先修改 clean buffer，再 await save；save 失败返回 failed。Tab 仅以 applied* outcome 计算 mutated，漏记已改变的 buffer，并可能按零效果关闭 journal。"},"prior_completion":{"kind":"new-task","completed":false},"updated_at":"2026-09-11T16:04:40Z","evidence":{"verified_at":"2026-09-11T15:58:00Z","head":"9f966f158d6277f85c6f27690201ca7c21a7d704","checks":[{"kind":"unit","command":"git stash push -- src/components/editor/workspace/workspaceEditApply.ts src/components/editor/CodeWorkspaceTab.tsx && pnpm exec vitest run src/components/editor/workspace/workspaceEditApply.test.ts --maxWorkers=1","result":"failed","summary":"Baseline red: 3 failed (28 passed) on the new ED-MAIN-001 assertions that a failed clean-buffer save carries bufferEffect=performed / diskEffect=unknown, and that identical-text saves carry bufferEffect=none; production change reverted with git stash.","acceptance":[]},{"kind":"browser","command":"git stash push -- src/components/editor/workspace/workspaceEditApply.ts src/components/editor/CodeWorkspaceTab.tsx && pnpm exec vitest run src/components/editor/CodeWorkspaceTab.test.tsx -t \"reports the performed buffer effect\" --maxWorkers=1","result":"failed","summary":"Baseline red: mounted workflow reports the failure with no performed-buffer effect and closes the journal; assertion that the status contains \"postcondition could not be verified\" failed (received the frozen-preimage stale message).","acceptance":[]},{"kind":"unit","command":"pnpm exec vitest run src/components/editor/workspace/workspaceEditApply.test.ts --maxWorkers=1","result":"passed","summary":"31/31 passed after the applier records bufferEffect on applied-open and failed outcomes; covers performed buffer + disk none, performed buffer + disk unknown, identical-text zero buffer effect, and pre-mutation zero effect.","acceptance":["ED-MAIN-001-A1"]},{"kind":"browser","command":"pnpm exec vitest run src/components/editor/CodeWorkspaceTab.test.tsx -t \"reports the performed buffer effect\" --maxWorkers=1","result":"passed","summary":"1/1 mounted assertion passed: a real onCommandsChange workspace.rearrangeCode run with a rejected disk save leaves the applied text in the buffer, reports \"postcondition could not be verified\", writes a recovery-required v2 journal, and registers no success history.","acceptance":["ED-MAIN-001-A1","ED-MAIN-001-A2"]},{"kind":"typecheck","command":"python .agents/skills/code-workspace-idea-task/scripts/typecheck_scope.py --path src/components/editor/workspace/workspaceEditApply.ts --path src/components/editor/CodeWorkspaceTab.tsx --path src/components/editor/workspace/workspaceEditApply.test.ts --path src/components/editor/CodeWorkspaceTab.test.tsx","result":"passed","summary":"scoped errors: 0 across the 4 owned paths; out-of-scope errors: 0 across 0 file(s).","acceptance":[]},{"kind":"native","command":"PYTHONPATH=.agents/skills/qa-ui-auto/scripts python -m qa_ui_auto run --mode native --filter TC-IDE-AUDIT-015-rearrange-sortmembers-native","result":"passed","summary":"1 passed, 0 failed, 0 skipped in 48.8s. Packaged com.taomni.app.qa (Linux WebKitGTK), real UI rearrange preview/apply/single undo/save; receipt qa-ui-auto-report/run-20260911-233124-554599347.","acceptance":["ED-MAIN-001-A3"]},{"kind":"provider","command":"PYTHONPATH=.agents/skills/qa-ui-auto/scripts python -m qa_ui_auto run --mode native --filter TC-IDE-AUDIT-015-rearrange-sortmembers-native","result":"passed","summary":"Live Eclipse JDT LS 1.61.0 source.sortMembers discover->resolve->preview->apply->undo over the pinned SortMembers.java fixture (sha256 68142fea...); repeated exactly one success transaction, one undo/redo, saved original bytes.","acceptance":["ED-MAIN-001-A3"]},{"kind":"native","command":"PYTHONPATH=.agents/skills/qa-ui-auto/scripts python -m qa_ui_auto run --mode native --filter TC-IDE-IMPROVE-002-workflow-recovery-native","result":"passed","summary":"1 passed, 0 failed, 0 skipped in 70.1s. Packaged QA app recovery: real sortMembers transaction, seeded prepared journal restore after reload, idempotent second restore, third-party conflict preserved. Receipt qa-ui-auto-report/run-20260911-234032-256240837.","acceptance":["ED-MAIN-001-A2"]},{"kind":"code-audit","command":"re-audit of the production effect chain at 9f966f15","result":"passed","summary":"User entry CodeWorkspaceTab.applyLspWorkspaceEditNow -> workspaceEditApply.applyTextDocumentEdit: the open-clean branch calls helpers.applyToOpenBuffer (memory mutation) then awaits saveOpenBuffer; before the fix a rejected save returned only status=failed with diskEffect, so Tab's mutated/allOutcomes.startsWith('applied') accounting reported zero effect and closed the prepared journal as committed. The fix propagates bufferEffect through WorkspaceEditApplyOutcome, recomputes mutated/appliedEffectPaths from applied-or-buffer-performed outcomes, marks the journal recovery-required on a performed buffer effect with a later failure, and refuses success history; unknown disk effects keep the existing recovery center boundary.","acceptance":["ED-MAIN-001-A1","ED-MAIN-001-A2","ED-MAIN-001-A3"]}],"unrun":[],"notes":["Evidence ran on the working tree rooted at 9f966f15 (production fix uncommitted at verification time).","The large CodeWorkspaceTab.test.tsx suite passes in isolation with the new test (151/151); when co-scheduled with other heavy suites it exposes a pre-existing ~30ms timing flakiness unrelated to this change (production changes + baseline tests pass 255/255, and the success path is untouched by this fix).","Windows and macOS native verification are unverified; only the current Linux platform required native evidence is claimed.","Linux native uses isolated QA app-data and disposable fixtures; no developer profile was touched."]},"last_attempt":{"owner":"opencode-20260911T151424Z-9f966f15","claimed_from":"ready","claimed_at":"2026-09-11T15:14:48Z","baseline":"9f966f158d6277f85c6f27690201ca7c21a7d704","finished_at":"2026-09-11T16:04:40Z","result":"done","note":null}} -->

目标：准确分离内存和磁盘效果，失败后的 preimage 可恢复，不能把已修改正文当零效果。保留单一 history/journal 与 unknown 禁止盲重试。

### ED-MAIN-002 专用 provider 动作的标准 disabled 对象拒绝
<!-- ide-task {"id":"ED-MAIN-002","status":"ready","priority":"P1","size":"S","depends_on":["ED-MAIN-001"],"spec":"claudedocs/code-workspace-idea-specs/idea-2026-main-review.md#ed-main-002","acceptance":["ED-MAIN-002-A1","ED-MAIN-002-A2","ED-MAIN-002-A3"],"required_evidence":["code-audit","unit","typecheck","browser","native","provider"],"audit":{"date":"2026-09-11","head":"0566cc249f39b2e860cc30155462f12080111f1d","finding":"已确认：workflowActionIsDisabled 只识别 raw.disabled === true；LSP 标准 disabled:{reason} 被放行，前轮校验函数探针已复现。Rust raw 保留原始 payload，可先局部修复读取。"},"prior_completion":{"kind":"new-task","completed":false}} -->

目标：request/resolve 两端保留并显示 provider 禁用原因，零提交；保持真实 sortMembers、resolved kind 和完整载荷校验。

### ED-MAIN-003 LSP 文档版本与编辑器 revision 分离并贯穿提交
<!-- ide-task {"id":"ED-MAIN-003","status":"ready","priority":"P1","size":"M","depends_on":["ED-MAIN-002"],"spec":"claudedocs/code-workspace-idea-specs/idea-2026-main-review.md#ed-main-003","acceptance":["ED-MAIN-003-A1","ED-MAIN-003-A2","ED-MAIN-003-A3"],"required_evidence":["code-audit","unit","typecheck","browser","native","provider"],"audit":{"date":"2026-09-11","head":"0566cc249f39b2e860cc30155462f12080111f1d","finding":"已确认源码：validateWorkflowProviderAction 用 entry.version 对比 documentRevision；resolve flatten 后工作流 plan 的 documentRevision=undefined，未携带原始 LSP version。异步 hash/generation 防护存在，但不等于版本链完整。"},"prior_completion":{"kind":"new-task","completed":false}} -->

目标：合法同步不误拒绝，旧版本动作不因 flatten 失去约束；完整 WorkspaceEdit 和专用 kind 的边界继续生效。

### ED-MAIN-004 替换的混合换行与非法搜索坐标一致性
<!-- ide-task {"id":"ED-MAIN-004","status":"ready","priority":"P1","size":"S","depends_on":[],"spec":"claudedocs/code-workspace-idea-specs/idea-2026-main-review.md#ed-main-004","acceptance":["ED-MAIN-004-A1","ED-MAIN-004-A2","ED-MAIN-004-A3"],"required_evidence":["code-audit","unit","typecheck","browser","native"],"audit":{"date":"2026-09-11","head":"0566cc249f39b2e860cc30155462f12080111f1d","finding":"已确认：verifyReplaceMatchFreshness 仅 split LF，abc CR foo 的第二行合法匹配被拒绝；实际 LSP applier 支持 LF/CRLF/CR。搜索 code-point 转 UTF-16 helper 还会 clamp 非法原始偏移，需在转换前拒绝。"},"prior_completion":{"kind":"new-task","completed":false}} -->

目标：正常 emoji／多种 EOL 的 preview、导航、freshness、commit 一致；非法坐标不能静默变成另一个有效 range。

### ED-MAIN-005 替换 preimage 与精确选中 edit 贯穿首次写入
<!-- ide-task {"id":"ED-MAIN-005","status":"ready","priority":"P1","size":"M","depends_on":["ED-MAIN-001","ED-MAIN-004"],"spec":"claudedocs/code-workspace-idea-specs/idea-2026-main-review.md#ed-main-005","acceptance":["ED-MAIN-005-A1","ED-MAIN-005-A2","ED-MAIN-005-A3"],"required_evidence":["code-audit","unit","typecheck","browser","native"],"audit":{"date":"2026-09-11","head":"0566cc249f39b2e860cc30155462f12080111f1d","finding":"已确认源码：preview snapshot 没有文件 preimage；Tab 校验匹配后直接 applyLspWorkspaceEdit(edit)，closed-file applier 再读盘并使用第二次 hash。两个读取间的变化未绑定到预览；selected validation 主要验证子集、数量和 replacement，未逐项核对路径/range。"},"prior_completion":{"kind":"new-task","completed":false}} -->

目标：预览的文件内容和选中 edits 就是提交前置条件，不把旧 range 重新锚定到新读到的正文；保留部分效果 ledger 与恢复。

### ED-MAIN-006 IME 最终 flush 与共享历史收尾验证及修复
<!-- ide-task {"id":"ED-MAIN-006","status":"ready","priority":"P1","size":"M","depends_on":["ED-MAIN-009"],"spec":"claudedocs/code-workspace-idea-specs/idea-2026-main-review.md#ed-main-006","acceptance":["ED-MAIN-006-A1","ED-MAIN-006-A2","ED-MAIN-006-A3"],"required_evidence":["code-audit","unit","typecheck","native","accessibility"],"audit":{"date":"2026-09-11","head":"0566cc249f39b2e860cc30155462f12080111f1d","finding":"待验证边界：main 已有 composition origin 和 owner history 合并；Host capture-phase compositionend 立即 finalize，是否早于最终 CodeMirror/DOM flush 需 mounted 和真实输入法核实。不能把未合并分支逐字符 undo 的已复现问题归到 main。"},"prior_completion":{"kind":"new-task","completed":false}} -->

目标：先复现事件顺序，必要时修正会话收尾；确认一次 undo，取消无残留历史，迟到 flush 与 sibling/provider 更新均不丢文本。

### ED-MAIN-007 剪贴板异步焦点 owner 与销毁后观察归属
<!-- ide-task {"id":"ED-MAIN-007","status":"ready","priority":"P1","size":"M","depends_on":["ED-MAIN-006"],"spec":"claudedocs/code-workspace-idea-specs/idea-2026-main-review.md#ed-main-007","acceptance":["ED-MAIN-007-A1","ED-MAIN-007-A2","ED-MAIN-007-A3"],"required_evidence":["code-audit","unit","typecheck","browser","native"],"audit":{"date":"2026-09-11","head":"0566cc249f39b2e860cc30155462f12080111f1d","finding":"已确认源码：paste/plain/cut await 后检查 connected/doc/selection/composing，未检查活动 leaf/focus owner；通过后调用 focus。取消观察在返回时查询 view WeakMap，view 销毁释放 registry 后可能丢失记录。"},"prior_completion":{"kind":"new-task","completed":false}} -->

目标：切 leaf／workspace 或重入后不迟到写入、不夺焦，performed/unknown 仍在正确会话留下元数据事实。

### ED-MAIN-008 Windows 保存替换失败的旧文件保全
<!-- ide-task {"id":"ED-MAIN-008","status":"ready","priority":"P1","size":"M","depends_on":[],"spec":"claudedocs/code-workspace-idea-specs/idea-2026-main-review.md#ed-main-008","acceptance":["ED-MAIN-008-A1","ED-MAIN-008-A2","ED-MAIN-008-A3"],"required_evidence":["code-audit","rust","native"],"audit":{"date":"2026-09-11","head":"0566cc249f39b2e860cc30155462f12080111f1d","finding":"已确认源码风险、未做 Windows 真机复现：replace_file 的 cfg(windows) 先 remove_file(target) 再 rename(tmp,target)，后一步失败会失去旧目标；writer 随后清理 temp。已有 WriteBytesFault::Replace 在替换前注入，不能证明删除后失败的数据保全。"},"prior_completion":{"kind":"new-task","completed":false}} -->

目标：替换失败仍保有可验证的旧字节，不依赖先删唯一旧文件；保留 intent/old/written facts、阶段故障注入与 temp cleanup 诊断。

### ED-MAIN-009 视图快照的正文身份与横向滚动兼容完善
<!-- ide-task {"id":"ED-MAIN-009","status":"ready","priority":"P2","size":"M","depends_on":[],"spec":"claudedocs/code-workspace-idea-specs/idea-2026-main-review.md#ed-main-009","acceptance":["ED-MAIN-009-A1","ED-MAIN-009-A2","ED-MAIN-009-A3"],"required_evidence":["code-audit","unit","typecheck","browser","native","performance"],"audit":{"date":"2026-09-11","head":"0566cc249f39b2e860cc30155462f12080111f1d","finding":"明确补强项：main PersistedEditorViewState 已保存独立 leaf/file selection、fold ranges、scrollTop，但没有正文身份和 scrollLeft。旧 range 仅按长度 clamp；不把参考分支的语言未就绪折叠失败、两秒无尾部落盘问题认作 main 已有故障。"},"prior_completion":{"kind":"new-task","completed":false}} -->

目标：兼容现有 snapshot，补正文身份和横向滚动，保留直接 fold range 恢复、最终一次持久化及输入性能。

### ED-MAIN-010 main 完善轮最终源码回归与能力矩阵
<!-- ide-task {"id":"ED-MAIN-010","status":"ready","priority":"P1","size":"M","depends_on":["ED-MAIN-001","ED-MAIN-002","ED-MAIN-003","ED-MAIN-004","ED-MAIN-005","ED-MAIN-006","ED-MAIN-007","ED-MAIN-008","ED-MAIN-009"],"spec":"claudedocs/code-workspace-idea-specs/idea-2026-main-review.md#ed-main-010","acceptance":["ED-MAIN-010-A1","ED-MAIN-010-A2","ED-MAIN-010-A3"],"required_evidence":["code-audit","build","qa-lint","document"],"audit":{"date":"2026-09-11","head":"0566cc249f39b2e860cc30155462f12080111f1d","finding":"集成交付任务：新的生产修复将改变 source identity，上一轮矩阵不能证明修复后的源码；需将本轮 30 个验收 ID、保留能力、当前运行与平台缺口重新关联，不能累加旧 done。"},"prior_completion":{"kind":"new-task","completed":false}} -->

目标：固定最终源码重跑受影响链路，生成新的能力矩阵，明确修复、未支持、未验证和历史结果；本卡不顺手修新产品缺陷。
