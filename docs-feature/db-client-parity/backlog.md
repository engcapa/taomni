# DB 会话双参照对齐任务板

## 1. 选板规则

本板是 `DB-*` 卡的唯一状态来源，所有命令都通过 `.agents/skills/db-client-task/scripts/task_board.py --doc docs-feature/db-client-parity/backlog.md` 执行。P0 用 add 产卡（planning）；P1 规划后 ready；P2 claim 开发；P3 review。

## 2. 规格索引

[能力矩阵](capability-matrix.md) / [待细化目标](task-planning.md) / [第一批设计](batch1-plan.md) / [参考包](references/)

## 3. 交付门槛

- 参照：DBeaver CE 26.2.1（`DBR-001`）与 DbVisualizer Pro 25.1.3（`DBVIS-001`），按取长规则逐场景选主参照。
- 引擎：所有引擎都要支持；live 验证用 MariaDB 12.1.2（本机共享库）与 MySQL 8.4（GitHub 托管的 `mysql` capability）。其他引擎只做单测，结论记为未验证。
- 验证：本机跑 vitest 与定向 Rust 测试；browser 与 native 用例通过 `.github/workflows/qa-ui-auto-platforms.yml`（`scope=selected`）在 Linux / Windows / macOS 上执行，结果回填证据。
- 集成门槛由 `DB-GATE-001` 负责（全仓 build、qa-lint、三端选定用例）。

## 4. 任务卡

### DB-EXEC-001 执行日志与汇总
<!-- db-task {"id":"DB-EXEC-001","status":"implemented","priority":"high","size":"M","depends_on":[],"source":["DBV-EXEC-01"],"scope":["all-sql"],"spec":"docs-feature/db-client-parity/batch1-plan.md#db-exec-001","acceptance":["DB-EXEC-001-A1","DB-EXEC-001-A2","DB-EXEC-001-A3","DB-EXEC-001-A4","DB-EXEC-001-A5"],"required_evidence":["code-audit","unit","typecheck","browser","native"],"audit":{"date":"2026-09-30","head":"8abdd97f455ee069ed2592641d6cbb1d7a2bb3be","finding":"runQuery 每条语句一个结果页签，错误只在各自 Messages，无跨语句日志与汇总"},"planned_at":"2026-09-30T02:18:05Z","updated_at":"2026-09-30T02:30:21Z","evidence":{"verified_at":"2026-09-30T02:30:20Z","head":"bf479bc33588faae11c10ae2fd98615b1fd7ae06","checks":[{"kind":"code-audit","command":"review: SqlEditorPanel Run/Current -> DbClientTab.runQuery -> streamQueryIntoSheet -> dbExecuteStream/db_cancel; ResultArea Log tab -> ExecutionLogView","result":"passed","summary":"Run registers one ExecutionLogRun per click; entries move running->success/failed/cancelled; break leaves not-run; failure/cancel activates Log; sheet select clears logActive; history append unchanged","acceptance":["DB-EXEC-001-A1","DB-EXEC-001-A3","DB-EXEC-001-A4","DB-EXEC-001-A5"]},{"kind":"unit","command":"pnpm exec vitest run src/lib/dbExecutionLog.test.ts src/components/database/DbClientTab.test.tsx","result":"passed","summary":"30/30 (4 model + 3 new execution-log mounted tests + 23 retained DbClientTab tests)","acceptance":["DB-EXEC-001-A1","DB-EXEC-001-A2","DB-EXEC-001-A3","DB-EXEC-001-A4","DB-EXEC-001-A5"]},{"kind":"typecheck","command":"typecheck_scope.py --path DbClientTab.tsx --path DbClientTab.test.tsx --path ExecutionLogView.tsx --path dbExecutionLog.ts --path dbExecutionLog.test.ts","result":"passed","summary":"scoped errors 0, out-of-scope 0","acceptance":[]}],"unrun":["browser: TC-DB-EXEC-001-execution-log-browser pending the batch-1 GitHub run","native: TC-DB-EXEC-001-execution-log-native pending the batch-1 GitHub run (Linux/Windows/macOS)"],"notes":["qa_ui_auto.audit --gate passed after registering controls and cases"]},"last_attempt":{"owner":"claude-20260930-bf479bc","claimed_from":"ready","claimed_at":"2026-09-30T02:18:05Z","baseline":"bf479bc33588faae11c10ae2fd98615b1fd7ae06","finished_at":"2026-09-30T02:30:21Z","result":"implemented","note":"browser/native cases pending the batch-1 three-platform GitHub run"}} -->

取 DbVisualizer 的 Log 表格。

### DB-EXEC-002 多语句遇错时的选择
<!-- db-task {"id":"DB-EXEC-002","status":"planning","priority":"high","size":"S","depends_on":["DB-EXEC-001"],"source":["DBV-EXEC-02"],"scope":["all-sql"],"spec":"docs-feature/db-client-parity/task-planning.md#db-exec-002","acceptance":[],"required_evidence":[],"audit":{"date":"2026-09-30","head":"8abdd97f455ee069ed2592641d6cbb1d7a2bb3be","finding":"runQuery 遇错 break，无提示与继续选项"}} -->

取 DBeaver 的 Stop / Skip / Skip all。

### DB-EXEC-003 危险语句执行前确认
<!-- db-task {"id":"DB-EXEC-003","status":"planning","priority":"high","size":"S","depends_on":[],"source":["DBV-EXEC-03"],"scope":["all-sql"],"spec":"docs-feature/db-client-parity/task-planning.md#db-exec-003","acceptance":[],"required_evidence":[],"audit":{"date":"2026-09-30","head":"8abdd97f455ee069ed2592641d6cbb1d7a2bb3be","finding":"DROP/TRUNCATE/无 WHERE 的 DELETE、UPDATE 直接执行，无确认"}} -->

取 DBeaver 的执行前确认。

### DB-EXEC-004 当前语句的执行计划
<!-- db-task {"id":"DB-EXEC-004","status":"planning","priority":"medium","size":"S","depends_on":[],"source":["DBV-EXEC-04"],"scope":["mysql","postgres","all-sql"],"spec":"docs-feature/db-client-parity/task-planning.md#db-exec-004","acceptance":[],"required_evidence":[],"audit":{"date":"2026-09-30","head":"8abdd97f455ee069ed2592641d6cbb1d7a2bb3be","finding":"只有 AI 解释语法，无 EXPLAIN 入口"}} -->

取 DBeaver：只分析当前语句。

### DB-TX-001 手动提交模式
<!-- db-task {"id":"DB-TX-001","status":"planning","priority":"high","size":"L","depends_on":[],"source":["DBV-TX-01"],"scope":["mysql","postgres"],"spec":"docs-feature/db-client-parity/task-planning.md#db-tx-001","acceptance":[],"required_evidence":[],"audit":{"date":"2026-09-30","head":"8abdd97f455ee069ed2592641d6cbb1d7a2bb3be","finding":"前后端均无自动提交开关、提交/回滚与未提交计数"}} -->

开关取 DBeaver，计数取 DbVisualizer。

### DB-TX-002 重连与关闭时的未提交处理
<!-- db-task {"id":"DB-TX-002","status":"planning","priority":"high","size":"M","depends_on":["DB-TX-001"],"source":["DBV-TX-02"],"scope":["mysql","postgres"],"spec":"docs-feature/db-client-parity/task-planning.md#db-tx-002","acceptance":[],"required_evidence":[],"audit":{"date":"2026-09-30","head":"8abdd97f455ee069ed2592641d6cbb1d7a2bb3be","finding":"sqlx 池连接被替换时无提示；关闭标签直接断开"}} -->

### DB-EDIT-001 保存数据编辑前的 SQL 预览
<!-- db-task {"id":"DB-EDIT-001","status":"planning","priority":"high","size":"M","depends_on":[],"source":["DBV-EDIT-01"],"scope":["all-sql"],"spec":"docs-feature/db-client-parity/task-planning.md#db-edit-001","acceptance":[],"required_evidence":[],"audit":{"date":"2026-09-30","head":"8abdd97f455ee069ed2592641d6cbb1d7a2bb3be","finding":"submitChanges 确认框只有数量，DML 确认后才生成；无主键时 WHERE 静默用全部列"}} -->

### DB-GRID-001 排序以 DbVisualizer 为准与过滤计数
<!-- db-task {"id":"DB-GRID-001","status":"planning","priority":"medium","size":"S","depends_on":[],"source":["DBV-GRID-01","DBV-GRID-02"],"scope":["all-sql"],"spec":"docs-feature/db-client-parity/task-planning.md#db-grid-001","acceptance":[],"required_evidence":[],"audit":{"date":"2026-09-30","head":"8abdd97f455ee069ed2592641d6cbb1d7a2bb3be","finding":"排序已是客户端升/降/取消；过滤后没有 过滤后[总数] 计数"}} -->

### DB-GATE-001 第一批集成门槛
<!-- db-task {"id":"DB-GATE-001","status":"planning","priority":"low","size":"M","depends_on":["DB-EXEC-001","DB-EXEC-002","DB-EXEC-003","DB-EXEC-004","DB-TX-001","DB-TX-002","DB-EDIT-001","DB-GRID-001"],"source":["DB-BATCH-1"],"scope":["all-sql"],"spec":"docs-feature/db-client-parity/task-planning.md#db-gate-001","acceptance":[],"required_evidence":[],"audit":{"date":"2026-09-30","head":"8abdd97f455ee069ed2592641d6cbb1d7a2bb3be","finding":"第一批需要全仓 build、qa-lint 与三端选定用例"}} -->
