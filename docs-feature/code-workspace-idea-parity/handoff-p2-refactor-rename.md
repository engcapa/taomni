# P2 开发交接：ED-REF-001

请领取并实施任务板 `claudedocs/code-workspace-idea-parity-backlog.md` 的 ED-REF-001；规划阶段未领取、未改产品代码。先重读该卡、`search-and-navigation.md#ed-ref-001`、`shared-contracts.md`、本目录 `refactor-rename-design.md` 与 IDEA 参照。

## Owner 与文件边界

生产 owner：`src/components/editor/CodeWorkspaceTab.tsx`（入口、prepare/commit/cancel/recovery）；`src/components/editor/workspace/refactorPlan.ts`（冻结身份、完整性和 pre/post 条件）；`workspaceEditApply.ts`（原子 apply、效果分类、post-hash）；`workspaceEditHistory.ts`（共享 undo/redo、路径+文本快照）；`RefactoringPreviewDialog.tsx`（完整性/冲突/排除项可见状态）；必要时 `refactorRecoveryController.ts`（重启发现、恢复、幂等）。复用 `ED-USAGE-002` provider evidence、`ED-PROJECT-005` facts generation、`ED-ACTION-004` action contract。只覆盖 text-only 多文件 rename/refactor；未证明的 resource operation 与 Safe Delete 必须拒绝并解释。

## DEC / AC / V

- DEC-1..5 见设计文档；不得以 any、关闭断言、非空结果或标题推断完整性。
- A1：真实 JDT LS 1.61.0 + JDK 21 maven-single，多文件 preview 与 trace/fixture 逐项匹配。
- A2：dirty/library/read-only/cross-root/excluded/incomplete/stale/malformed 均阻断或解释；cancel/stale 零写零 history。
- A3：真实 apply 后每个 path 的 post-hash 匹配；mismatch 是 failed/recovery-required。
- A4：一次 undo 恢复路径与文本 before-image hash；真实重启 recovery 可重放且幂等，第三方冲突不覆盖。

验证顺序：先用可控 Promise 的 unit 覆盖 plan/apply/history/recovery 反例，再运行真实 provider fixture；随后 browser mounted 断言入口、预览、阻断、取消、单次 history；最后在 packaged Tauri QA runtime 做 native 磁盘/hash/重启验证。用 `typecheck_scope.py` 覆盖全部 owner 路径。IDEA comparison 单独记录 2026.2.2 版本、同 fixture/action、delta 与 claim ceiling。Windows/macOS 未运行须明确记录。

## 回归保护

保留现有普通 WorkspaceEdit、代码动作、单文件编辑、打开/关闭 tab、共享 undo/redo、save/reload 和 recovery 行为；不得让 rename 产生第二套 history。任何 await 后 ownership 变化、OS 写入未知、第三方 dirty 输入、行尾/编码变化都需保持 typed outcome。取消不应写入磁盘、buffer、journal success 或 history。

## 启动门槛与未决问题

启动前确认依赖三卡仍为 done 且 provider completeness 已从 session 传入 refactor plan；确认 native QA binary、真实退出/重启 harness、可写 fixture 和跨 root/read-only 注入可用。未决：IDEA 2026.2.2 在当前平台的 Preview 默认是否展示 library/excluded 行；resource rename/delete 是否纳入本卡（默认不纳入）；post-hash mismatch 后的用户恢复文案与 retry policy。未决项未得到维护者决定前，不扩大 AC 或把实施标为 done。
