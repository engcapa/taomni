# ED-REF-001 Rename/Refactor 完整性与冲突闭环设计

> 规划阶段：仅审计、需求细化与 P2 交接；不修改产品代码、测试或 QA 用例。
> 任务状态以 [`claudedocs/code-workspace-idea-parity-backlog.md`](../../claudedocs/code-workspace-idea-parity-backlog.md) metadata 为唯一来源；当前卡为 `implemented`，不据此宣称 done。

## 当前审计（2026-09-15）

生产入口为 `CodeWorkspaceTab` 的 `workspace.renameSymbol`，经 `refactorPlan.ts` 冻结 provider/project/document/policy 身份并生成 `RefactorPlanV3`，`RefactoringPreviewDialog` 展示并筛选 `WorkspaceEditPreview`，随后由 Tab 调用 `workspaceEditApply`，成功结果写入共享 `WorkspaceEditHistory`；失败会保留 conflict/failed/unknown-effect，恢复 journal 由 `refactorPlan`/recovery controller 负责。撤销通过路径快照和文本快照恢复，重启恢复依赖 journal replay。

已具备或已有当前线索：JDT LS fixture runner、两文件 text edit preview、dirty/read-only/library/revision conflict 建模、pre/post hash 字段、单次共享 undo、journal v2 与恢复入口。已记录的 2026-09-05 evidence 可复用作历史线索，但不能替代本轮 P2 对当前源码的验证。

本轮发现的审计结论：

- `RefactorPlanV3.completeness` 已进入 UI，但必须确认它由 `ED-USAGE-002` 的真实 provider role/coverage 结果驱动；不能由非空 edits 推断 complete。
- `LspWorkspaceEdit.operations` 的 create/delete/rename 与 text edits 必须整体校验；任一跨 root、排除项、目录/库资源或 command-only/未知 operation 未被完整覆盖时，计划必须 fail closed。
- 预览取消、输入变更、provider/project generation 变化和 stale 结果必须在 apply 前再次阻断，并证明零写、零 history；await 后无法判定 OS 效果时必须保留 `unknown-effect`。
- post-hash 需要在真实磁盘和打开 buffer 两侧独立回读；undo 必须同时恢复路径集合与文本 before-image，并在第三方修改时阻断覆盖。
- restart recovery 需要真实进程重启入口与 journal 状态/幂等性观察。现有 browser 证据不能证明该 native 边界；现有卡 evidence 的 native 项仍明确 unrun。
- Safe Delete 不能复用 rename 的“看起来完整”结果；无专用完整引用覆盖时必须解释并拒绝写入。

## P2 验收与决策合同

**A1**：固定 JDT LS 版本、JDK、maven-single fixture；从真实 `prepareRename`/`rename` 请求取得多文件 edit，预览文件集合、范围和新文本与 trace/fixture 完全匹配，且标明 declaration/read/write/library 角色及 completeness 来源。

**A2**：dirty、library、read-only、跨 root、excluded/generated、incomplete/unknown provider、document/project generation stale、malformed/unsupported resource operation 均在 preview 或 pre-commit 明确阻断；取消和 stale 的最终文件 hash、buffer 文本、history 均不变。

**A3**：确认后只产生一个 transaction；逐文件真实读取 post-image，post-hash 与计划预期一致，任何 mismatch 进入 failed/recovery-required 并列出 affected paths。

**A4**：一次 undo 恢复全部 before-image（路径和文本）hash；重启后发现 journal，按 transaction identity 重放/恢复，重复恢复幂等；冲突不覆盖第三方输入。

保留合同：before-image/postcondition；文本与文件路径同时恢复；跨 root/dirty/read-only/excluded/incomplete 不误写；Safe Delete fail closed；取消零写；共享 undo、失败、冲突、stale、unknown-effect 和 restart recovery 路径。

## 交付决策（DEC）

- **DEC-1**：以 provider completeness + project facts generation 作为写入门禁；未知/partial 不得通过“用户确认”绕过。
- **DEC-2**：所有资源操作先做闭集校验和路径/root policy 校验；无法证明的 operation 整体拒绝。
- **DEC-3**：单一 `WorkspaceEditHistory` 与 recovery journal；不新增竞争 history。
- **DEC-4**：先持久化可恢复 before-image，再执行第一写；写后独立验证 postcondition。
- **DEC-5**：IDEA 对齐只宣称已观测的 preview/cancel/apply/undo 行为；Taomni 特有 crash recovery 另列安全扩展。

## 依赖与启动条件

依赖 `ED-ACTION-004`、`ED-PROJECT-005`、`ED-USAGE-002` 均保持 `done`；P2 启动前必须确认其当前 provider/project evidence 可被生产 caller 消费。另需可运行真实 JDT LS/JDK 21、可写 maven-single fixture、可构造 dirty/read-only/library/cross-root/excluded 状态、Linux packaged QA runtime，以及可执行真实退出/重启的 native harness。任一条件缺失只能保持 `implemented`/`blocked`，不得改写成 done。
