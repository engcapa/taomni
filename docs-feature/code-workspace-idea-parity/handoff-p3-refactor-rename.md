# P3 独立验收交接：ED-REF-001

你负责对已完成实施与自验的 Taomni Code Workspace IDEA 对齐任务 `ED-REF-001`（*Rename/refactor completeness 与 conflict 闭环*）开展独立验收。本次为只读独立审查，不修改产品代码、测试用例或任务板状态；仅执行必要的非破坏性核查、契约审计与独立验证。

先读取并遵守：
- `AGENTS.md`
- `.agents/skills/code-workspace-idea-task/SKILL.md`
- `.agents/skills/qa-ui-auto/SKILL.md`
- `.agents/skills/code-workspace-idea-parity/SKILL.md`
- `claudedocs/code-workspace-idea-parity-backlog.md`
- `claudedocs/code-workspace-idea-specs/search-and-navigation.md#ed-ref-001`
- `claudedocs/code-workspace-idea-specs/shared-contracts.md`
- `docs-feature/code-workspace-idea-parity/refactor-rename-design.md`
- `docs-feature/code-workspace-idea-parity/references/refactor-rename-idea-2026.2.2.md`
- `qa-ui-auto-report/idea-comparison/ED-REF-001/run-20260915-093800/record.json`

---

## 【本轮输入】

- **任务板与 ID**：`claudedocs/code-workspace-idea-parity-backlog.md`，任务 ID `ED-REF-001`，当前状态 `done`。
- **实现代码身份**：
  - 基线提交：`6e93624ae1bd4e42686fbf6b8ecd8da0dfce7087`
  - 生产代码：
    - `src/components/editor/CodeWorkspaceTab.tsx`（重命名发起、prepare/commit/cancel/recovery、资源与文本事务协调）
    - `src/components/editor/workspace/refactorPlan.ts`（冻结身份、完整性推导、pre/post 条件、v2 恢复日志组装）
    - `src/components/editor/workspace/workspaceEditApply.ts`（原子 apply、资源操作分发、效果分类、post-hash 校验）
    - `src/components/editor/workspace/workspaceEditHistory.ts`（统一单步撤销/重做、文件路径与文本快照）
    - `src/components/editor/workspace/RefactoringPreviewDialog.tsx`（完整性/冲突/排除项可见状态与过滤）
    - `src/components/editor/workspace/refactorRecoveryController.ts`（重启发现、恢复日志加载与回滚）
  - 测试用例与跟踪文件：
    - `qa-ui-auto-tests/cases/TC-IDE-C6-03-safe-delete-disabled.testcase.yaml`
    - `qa-ui-auto-tests/cases/TC-IDE-C6-04-rename-preview-conflict-apply-undo.testcase.yaml`
    - `src/components/editor/workspace/__fixtures__/jdtls/traces/refactor-maven-single.trace.json`
    - `src/components/editor/workspace/refactorPlan.test.ts`
    - `src/components/editor/workspace/RefactoringPreviewDialog.test.tsx`
    - `src/components/editor/workspace/workspaceEditHistory.test.ts`
    - `src/components/editor/workspace/workspaceEditApply.test.ts`
    - `src/components/editor/workspace/refactorRecoveryController.test.ts`
    - `src/components/editor/workspace/__fixtures__/jdtls/jdtlsRefactorContract.test.ts`
    - `src/components/editor/CodeWorkspaceTab.test.tsx`
- **目标 IDEA 与参考包**：
  - 目标：IntelliJ IDEA 2026.2.2 Ultimate（build `262.10315.125`，X11 Linux x86_64）
  - 参考规范：`docs-feature/code-workspace-idea-parity/references/refactor-rename-idea-2026.2.2.md`
  - 对齐记录：`qa-ui-auto-report/idea-comparison/ED-REF-001/run-20260915-093800/record.json`（双侧 5 步 matched，7 份原件 SHA-256 verified，通过 `compare_idea.py --require-match`）
- **设计决策与验收目标**：
  - 设计文档：`docs-feature/code-workspace-idea-parity/refactor-rename-design.md`
  - DEC-1..5：真实 JDT LS 1.61.0 覆盖；未存脏缓冲区、只读/库文件、跨 root、过期 token fail-closed 阻断且零写零历史；资源 rename/move 纳入本卡闭环；未提供专用安全删除凭据的 Safe Delete fail-closed 拒绝；原子 apply 与 post-hash 强校验；单次 Ctrl+Z 完整反转文本与文件移动；v2 重启恢复日志幂等回滚。
  - 验收项：
    - `ED-REF-001-A1`：JDT LS 多文件重命名预览与 trace/fixture 匹配。
    - `ED-REF-001-A2`：dirty/library/read-only/incomplete/stale 冲突阻断或说明。
    - `ED-REF-001-A3`：commit 后 post-hash 匹配；mismatch 标记 recovery-required 并提示。
    - `ED-REF-001-A4`：单次 undo 恢复路径与文本 before-hash；重启恢复日志可发现可重放。
- **必须保留**：
  - 现有普通 WorkspaceEdit、代码动作、单文件编辑、Tab 开闭、共享 `workspace.undo`、恢复日志隔离；不得产生与重命名竞争的独立撤销流；取消操作不得向磁盘或历史写入任何记录。
- **实现者证据**：
  - `code-audit`：调用链路完整闭环。
  - `unit`：145/145 项单测全部通过。
  - `provider`：JDT LS 1.61.0 + OpenJDK 21.0.4 生成 authentic trace。
  - `browser`：TC-IDE-C6-03 9.3s 通过。
  - `native`：TC-IDE-C6-04 33.7s，TC-IDE-AUDIT-014 51.9s 通过，QA binary `com.taomni.app.qa debug 3b85a6fb...`。
  - `typecheck`：13 处 owner 文件 0 scoped errors，0 out-of-scope errors。
  - `idea-comparison`：5 步全部 matched，7 份原件 SHA-256 校验一致。
- **风险审查重点**：
  1. **事务完整性与资源移动原子性**：检查 `CodeWorkspaceTab.tsx` 与 `workspaceEditApply.ts` 在处理同时包含文本修改和类文件移动（`QuickFixTarget.java` $\to$ `Qa06Target.java`）时，若中途任何步骤异常，是否会残留孤儿文件或产生未同步的 editor buffer。
  2. **单次撤销（Single-Step Undo）一致性**：确认执行 `workspace.undo` 时，是否单次原子回滚文件移动与文本变更，且磁盘 SHA-256 完全恢复到 `f2de5c8a...`；是否存在 CodeMirror 本地 undo 与工作区级全局 undo 竞争。
  3. **冲突阻断（Fail-Closed Guards）**：未保存修改、只读库文件（`jdt://`, `jar:`）或外部冲突时，重命名是否坚决拒绝，无静默写入，状态栏准确展示原因。
  4. **Post-Hash Mismatch 恢复策略**：后置条件哈希不匹配时，确认系统是否未执行盲目自动重试，而是将日志置为 `recovery-required` 并准确提示用户。
- **执行环境与权限**：
  - Linux x86_64（WebKitGTK Tauri QA runtime、Live JDT LS 1.61.0、Local IDEA 2026.2.2 实例）
  - 权限：只读审计与非破坏性检验；不修改产品代码，不破坏现有 git 工作区，不重新触发任务板状态变更。
- **交付位置**：聊天输出独立验收报告，包含判定结论（接受 / 需修改 / 证据阻塞）及对应的场景矩阵映射。

---

## 【审查指引与操作步骤】

1. **代码与契约审查**：
   - 检查 `refactorPlan.ts` 的 `prepareRefactorRecoveryJournalV2` 与 `buildRefactorPlan`，核对前置/后置条件推导与资源移动日志封装。
   - 检查 `CodeWorkspaceTab.tsx` 中 `applyLspWorkspaceEditNow` 的事务恢复日志生命周期与撤销条目注册，确认 `preparedJournalRef` 与 `workspaceEditHistorySequenceRef` 之间没有逻辑断层。
   - 检查 `RefactoringPreviewDialog.tsx`，确认文件树渲染、勾选过滤逻辑以及对只读/冲突项的展示符合 DEC-1。
2. **证据复核与校验命令**：
   ```bash
   # 1. 验证任务板状态与元数据完整性
   python3 .agents/skills/code-workspace-idea-task/scripts/task_board.py \
     --doc claudedocs/code-workspace-idea-parity-backlog.md validate

   # 2. 运行双侧 IDEA 比较校验器
   python3 .agents/skills/code-workspace-idea-task/scripts/compare_idea.py \
     --record qa-ui-auto-report/idea-comparison/ED-REF-001/run-20260915-093800/record.json \
     --require-match

   # 3. 运行重构全量专项单测
   pnpm exec vitest run \
     src/components/editor/workspace/refactorPlan.test.ts \
     src/components/editor/workspace/__fixtures__/jdtls/jdtlsRefactorContract.test.ts \
     src/components/editor/workspace/RefactoringPreviewDialog.test.tsx \
     src/components/editor/workspace/workspaceEditHistory.test.ts \
     src/components/editor/workspace/workspaceEditApply.test.ts \
     src/components/editor/workspace/refactorRecoveryController.test.ts

   # 4. 运行范围类型检查
   python3 .agents/skills/code-workspace-idea-task/scripts/typecheck_scope.py \
     --path src/components/editor/CodeWorkspaceTab.tsx \
     --path src/components/editor/workspace/refactorPlan.ts \
     --path src/components/editor/workspace/workspaceEditApply.ts \
     --path src/components/editor/workspace/workspaceEditHistory.ts \
     --path src/components/editor/workspace/RefactoringPreviewDialog.tsx \
     --path src/components/editor/workspace/refactorRecoveryController.ts
   ```
3. **输出结论格式**：
   - **判定结论**：三选一（`接受` / `需修改` / `证据阻塞`）。
   - **发现项清单**：按严重级别列出（符号/位置、触发条件、实际影响、违反的 AC、修复建议）。
   - **矩阵场景映射**：对应总需求矩阵场景 `REQ-01 / CW-SEARCH-001 / CW-REFACTOR-001` 的差距关闭状态。
