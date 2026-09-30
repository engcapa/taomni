# 第一批 P1 设计（DB-EXEC / DB-TX / DB-EDIT / DB-GRID / DB-GATE）

基线：`feat/db-client-parity` 分支，P0 提交 `bf479bc3`。参照：[DBVIS-001](references/DBVIS-001-pro-25.1.3.md)、[DBR-001](references/DBR-001-ce-26.2.1.md)。

通用验证约定：
- 本机：`pnpm exec vitest run <files>`，以及 `python .agents/skills/code-workspace-idea-task/scripts/typecheck_scope.py --path ...`。
- browser 用例：离线 MySQL 会话脚手架（`db_connect` 在浏览器预览中必然失败），用于验证不依赖服务端的入口、确认框与失败路径。
- native 用例：`mysql_required`，由 `qa-ui-auto-platforms.yml` 在 Linux / Windows / macOS 执行，服务端为托管的 MySQL 8.4。
- 用例文件放在 `qa-ui-auto-tests/cases/db/`，ID 登记在 `qa-ui-auto-tests/ci/policy.yaml`，`covers: [F-DB-1]`。

<a id="db-exec-001"></a>
## DB-EXEC-001 执行日志与汇总

- 来源 / 范围 / 参照：DBV-EXEC-01；全部 SQL 引擎；`主参照: dbvis`（Log 表格 + 汇总）。放弃 DBeaver 的 Statistics 汇总标签，因为它不列出单条失败。
- 当前事实：`DbClientTab.runQuery` 为每条语句创建结果页签，`streamQueryIntoSheet` 返回 `QueryExecutionSummary`；失败只写入该页签的 Messages；遇错 `break` 之后不留任何痕迹。
- 目标：每个查询面板维护内存中的执行日志（最多 20 次运行）。结果页签条最左侧有固定的 `Log` 标签（`data-testid="result-log-tab"`），视图 `db-execution-log` 按运行分组，最新的运行在最上方。每条语句一行（`db-execution-log-entry`，`data-status`）：序号、状态、开始时间、耗时、行数或影响行数、消息、SQL。每次运行末尾有汇总（`db-execution-log-summary`）：成功 / 失败 / 跳过 / 未执行 / 取消的计数和总耗时。
- 状态：`running` `success` `failed` `cancelled` `skipped` `not-run`。
- 保留契约：每条语句仍生成自己的结果页签；SQL 历史写入不变；结果页签关闭菜单只作用于结果页签，不删除日志；单条语句全部成功时仍停留在该结果页签。
- 实施：`src/lib/dbExecutionLog.ts`（纯模型）、`src/components/database/ExecutionLogView.tsx`（视图）、`DbClientTab.tsx`（`PanelState.log`、`logActive`，在 `runQuery` 中登记）。
- 验收：
  - `A1` 运行 N 条语句后出现 Log 标签，每条语句一行，字段齐全，运行按时间倒序分组。
  - `A2` 汇总行显示各状态计数与总耗时；失败语句显示完整错误文本。
  - `A3` 有语句失败时自动切到 Log；全部成功时停留在最后一个结果页签（保留）。
  - `A4` 运行中取消：当前语句记为 `cancelled`，其后的语句记为 `not-run`。
  - `A5` 保留行为：每条语句的结果页签、SQL 历史、结果页签关闭菜单不受影响。
- 验证选择：`A1`–`A4` 用模型单测与挂载单测；`A1`–`A3` 的真实入口用 browser（失败路径）与 native（成功路径）；`A5` 由现有 DbClientTab 单测与本卡单测共同保护。

<a id="db-exec-001-test-cases"></a>
### 测试用例

| V | AC | 前置 / fixture | 操作 | 预期 | 层级 | 路径 / ID |
|---|---|---|---|---|---|---|
| V1 | A1 A2 A4 | 无 | 模型：建立 3 条语句的运行，依次置为 success / failed / not-run，再测取消与 20 次上限 | 计数与总耗时正确，超出上限丢弃最旧的运行 | unit | `src/lib/dbExecutionLog.test.ts`（P2 新增） |
| V2 | A1 A2 A3 A5 | mock IPC：第二条语句抛错 | 编辑器 `select 1;\nselect 2;\nselect 3`，点击 Run | 两个结果页签；Log 自动激活，状态为 success / failed / not-run，汇总含 `Failed: 1`；历史写入 2 条 | unit | `DbClientTab.test.tsx` “execution log …”（P2 新增） |
| V3 | A4 | mock IPC：第一条语句挂起 | Run 后点击 Cancel | 当前语句 `cancelled`，后续 `not-run` | unit | 同上 |
| V4 | A1 A2 A3 | browser，离线脚手架 | 在编辑器输入两条语句并 Run | Log 可见；第一条 `failed`（浏览器预览无数据库），第二条 `not-run`；汇总含 `Failed: 1` | browser | `qa-ui-auto-tests/cases/db/TC-DB-EXEC-001-execution-log-browser.testcase.yaml`（P2 新增） |
| V5 | A1 A2 A3 | native，`mysql_required` | 连接后执行 `SELECT 1 AS a; SELECT 2 AS b;`，打开 Log | 2 条 `success`，汇总含 `Success: 2`；停留在结果页签 | native | `qa-ui-auto-tests/cases/db/TC-DB-EXEC-001-execution-log-native.testcase.yaml`（P2 新增） |

<a id="db-exec-002"></a>
## DB-EXEC-002 多语句遇错时的选择

- 来源 / 范围 / 参照：DBV-EXEC-02；全部 SQL 引擎；`主参照: dbeaver`（Execution Error：Stop / Retry / Skip / Skip all）。不做 Retry（重复执行同一条失败语句对 DML 有副作用风险，且用户可直接再次 Run）；不采用 DbVisualizer 的“默认继续”，因为静默继续会在一条 DDL 失败后继续执行依赖它的语句。
- 当前事实：`runQuery` 在 `summary.ok === false` 时直接 `break`，没有任何提示。
- 目标：一次运行中某条语句失败（非用户取消），且后面还有语句时，弹出选择框（`choice-dialog`）：标题 “Statement failed”，内容为 `Statement <n> of <total> failed:` + 错误文本。按钮：`Skip all`（主按钮，继续并且本次运行后续错误不再询问）、`Skip`（继续下一条）、`Stop`（取消按钮，停止，后续语句记为 not-run）。关闭对话框等同 Stop。最后一条语句失败、单条语句运行、用户取消都不弹框。
- 日志：失败语句保持 `failed`，消息末尾追加 `(skipped, run continued)`；停止后剩余语句为 `not-run`。
- 保留契约：DB-EXEC-001 的日志与自动切到 Log；每条执行过的语句仍写入 SQL 历史；取消仍直接停止。
- 实施：`DbClientTab.tsx` 的 `runQuery`，使用 `choiceAppDialog`。
- 验收：
  - `A1` 中间语句失败时弹出选择框，显示语句序号、总数和错误。
  - `A2` Skip 继续执行下一条语句，下一次失败会再次询问。
  - `A3` Skip all 继续执行，且本次运行中之后的失败不再询问。
  - `A4` Stop 或关闭对话框时停止，剩余语句记为 not-run。
  - `A5` 最后一条失败、单条语句和用户取消都不弹框（保留：取消行为与 DB-EXEC-001 日志）。

<a id="db-exec-002-test-cases"></a>
### 测试用例

| V | AC | 前置 / fixture | 操作 | 预期 | 层级 | 路径 / ID |
|---|---|---|---|---|---|---|
| V1 | A1 A2 A4 | mock IPC：第 1、2 条失败 | 3 条语句 Run；第一次选 Skip，第二次选 Stop | choice 被调用两次，消息含 `Statement 1 of 3 failed`；日志 failed / failed / not-run | unit | `DbClientTab.test.tsx` “error choice …”（P2 新增） |
| V2 | A3 | mock IPC：第 1、2 条失败 | 3 条语句 Run，选 Skip all | 只询问一次，3 条都执行 | unit | 同上 |
| V3 | A5 | mock IPC：最后一条失败 / 单条失败 | Run | 不调用 choice | unit | 同上 |
| V4 | A1 A2 A4 | browser，离线脚手架（每条语句都会失败） | 3 条语句 Run；在第一个对话框点 Skip，第二个点 Stop | 日志 failed / failed / not-run，汇总含 `Failed: 2` | browser | `qa-ui-auto-tests/cases/TC-DB-EXEC-002-error-choice-browser.testcase.yaml`（P2 新增） |
| V5 | A1 A2 | native，`mysql_required` | `SELECT 1; SELECT * FROM qa_db_missing_table_x; SELECT 3;`，对话框点 Skip | 日志 success / failed / success；结果页签 3 个 | native | `qa-ui-auto-tests/cases/TC-DB-EXEC-002-error-choice-native.testcase.yaml`（P2 新增） |

<a id="db-exec-003"></a>
## DB-EXEC-003 危险语句执行前确认

- 来源 / 范围 / 参照：DBV-EXEC-03；全部 SQL 引擎；`主参照: dbeaver`（“Execute drop queries” 确认）。DbVisualizer 未观察到对应确认。
- 当前事实：`runQuery` 直接执行所有语句；`commitGridChanges` 的 DML 走 `dbExecute`，已有自己的确认框（不在本卡范围）。
- 规则（新增 `src/lib/sqlDangerousStatements.ts`）：去掉注释和字符串字面量后判断：以 `DROP` 或 `TRUNCATE` 开头；`DELETE` 且没有 `WHERE`；`UPDATE` 且没有 `WHERE`。已知限制：子查询里的 WHERE 会被当作有 WHERE。
- 目标：Run / Selection / Current / 历史重跑触发的运行里只要含危险语句，先弹出 `confirm-dialog`（危险样式）：标题 “Confirm dangerous statements”，列出前 10 条危险语句（超出显示 “… and N more”），按钮 Execute / Cancel。取消时整次运行一条都不执行，不产生日志和结果页签，状态栏提示已取消。
- 保留契约：不含危险语句的运行不弹框；网格保存的 DML 不经过本确认（由 DB-EDIT-001 负责预览）。
- 验收：
  - `A1` DROP / TRUNCATE / 无 WHERE 的 DELETE、UPDATE 被识别，带 WHERE 的 DELETE / UPDATE 与普通 SELECT 不被识别；注释和字符串里的关键字不影响判断。
  - `A2` 含危险语句的运行先弹确认框并列出这些语句。
  - `A3` 取消后没有任何语句执行，也不新增日志运行和结果页签。
  - `A4` 确认后整次运行照常执行（DB-EXEC-001/002 行为保留）。
  - `A5` 不含危险语句的运行不弹框（保留）。

<a id="db-exec-003-test-cases"></a>
### 测试用例

| V | AC | 前置 / fixture | 操作 | 预期 | 层级 | 路径 / ID |
|---|---|---|---|---|---|---|
| V1 | A1 | 无 | 对一组语句调用检测函数 | DROP / TRUNCATE / `DELETE FROM t` / `UPDATE t SET a=1` 命中；`DELETE FROM t WHERE id=1`、`SELECT 'drop table'`、`-- drop` 注释不命中 | unit | `src/lib/sqlDangerousStatements.test.ts`（P2 新增） |
| V2 | A2 A3 | mock IPC，confirm 返回 false | `select 1;\ndrop table t` Run | confirm 被调用且消息含 `drop table t`；`dbExecuteStream` 未调用；无 Log 标签 | unit | `DbClientTab.test.tsx` “dangerous …”（P2 新增） |
| V3 | A4 A5 | confirm 返回 true / 普通语句 | 分别 Run | 确认后两条都执行；普通运行不调用 confirm | unit | 同上 |
| V4 | A2 A3 A4 | browser，离线脚手架 | 输入 `DROP TABLE qa_x;` Run → Cancel；再次 Run → Execute | 第一次后无 Log 标签；第二次后 Log 有 1 条 failed（浏览器无数据库） | browser | `qa-ui-auto-tests/cases/TC-DB-EXEC-003-dangerous-confirm-browser.testcase.yaml`（P2 新增） |
| V5 | A2 A3 A4 | native，`mysql_required` | 建表 → Run `DROP TABLE` → Cancel → 查询该表成功 → 再 Run `DROP TABLE` → Execute | 取消后表仍可查询；确认后 DROP 成功 | native | `qa-ui-auto-tests/cases/TC-DB-EXEC-003-dangerous-confirm-native.testcase.yaml`（P2 新增） |

<a id="db-exec-004"></a>
## DB-EXEC-004 当前语句的执行计划

- 来源 / 范围 / 参照：DBV-EXEC-04；MySQL/MariaDB、StarRocks、PostgreSQL、PanWeiDB、ClickHouse、Presto/Trino；Oracle 与 SQL Server 暂不支持并给出原因。`主参照: dbeaver`（只分析光标所在语句，结果为独立标签）。放弃 DbVisualizer 对整个缓冲区逐条 Explain 的方式，因为那需要额外确认且容易误解。
- 当前事实：只有 AI “解释语法”，没有 EXPLAIN 入口；`currentEditorStatement` 已能找到光标所在语句。
- 规则（新增 `src/lib/sqlExplain.ts`）：去掉末尾分号；已经以 `EXPLAIN` 开头的语句原样执行；以 SELECT / WITH / INSERT / UPDATE / DELETE / REPLACE / VALUES / TABLE 开头的语句加 `EXPLAIN ` 前缀；其他语句返回原因 “Explain supports SELECT, WITH, INSERT, UPDATE, DELETE and REPLACE statements.”。Oracle：“Oracle EXPLAIN PLAN needs PLAN_TABLE and DBMS_XPLAN; not supported yet.”；SQL Server：“SQL Server SHOWPLAN must run in its own batch; not supported yet.”。`EXPLAIN` 不带 ANALYZE，不会执行 DML。
- 目标：编辑器工具栏新增 `Explain` 按钮（`data-testid="db-explain-current"`），对光标所在语句执行生成的 EXPLAIN，结果页签标题为 `Explain`，同时进入执行日志。不支持时用提示框说明原因，不执行任何语句。
- 保留契约：Run / Current / Selection 不变；日志与遇错处理（DB-EXEC-001/002）照常。
- 验收：
  - `A1` 规则函数对各引擎、已有 EXPLAIN、不可 Explain 的语句返回正确结果。
  - `A2` 点击 Explain 执行光标所在语句的 EXPLAIN，结果页签标题为 `Explain`，日志记录 EXPLAIN 语句。
  - `A3` 不支持的引擎或语句弹出原因，不调用执行接口。
  - `A4` 不影响其他运行入口（保留）。

<a id="db-exec-004-test-cases"></a>
### 测试用例

| V | AC | 前置 / fixture | 操作 | 预期 | 层级 | 路径 / ID |
|---|---|---|---|---|---|---|
| V1 | A1 | 无 | 调用 `explainSqlFor` | MySQL/PostgreSQL 加前缀并去掉分号；`EXPLAIN SELECT` 原样；`CREATE TABLE` 与 Oracle/SQL Server 返回原因 | unit | `src/lib/sqlExplain.test.ts`（P2 新增） |
| V2 | A2 A4 | mock IPC | 编辑器 `select 1;\nselect 2`（光标在末尾），点击 Explain | 执行 `EXPLAIN select 2`；结果页签标题 `Explain` | unit | `DbClientTab.test.tsx` “explain …”（P2 新增） |
| V3 | A3 | mock IPC，语句为 `create table t (id int)` | 点击 Explain | alert 被调用，`dbExecuteStream` 未调用 | unit | 同上 |
| V4 | A2 | native，`mysql_required` | 输入 `SELECT * FROM information_schema.TABLES WHERE TABLE_SCHEMA = 'mysql'`，点击 Explain | 结果页签标题 `Explain`，出现结果网格；日志 1 条 success，SQL 以 `EXPLAIN` 开头 | native | `qa-ui-auto-tests/cases/TC-DB-EXEC-004-explain-native.testcase.yaml`（P2 新增） |
| V5 | A3 | browser，离线脚手架 | 输入 `CREATE TABLE qa_t (id INT)`，点击 Explain | 出现 `alert-dialog`，内容含 “Explain supports”；没有 Log 标签 | browser | `qa-ui-auto-tests/cases/TC-DB-EXEC-004-explain-browser.testcase.yaml`（P2 新增） |

<a id="db-tx-001"></a>
## DB-TX-001 手动提交模式

- 来源 / 范围 / 参照：DBV-TX-01；MySQL/MariaDB 与 PostgreSQL（其他引擎不显示事务控件）。`主参照: merge`：开关位置和“切回自动提交时提交未决修改”取 DBeaver；未提交语句计数取 DbVisualizer（DBeaver 只显示事务日志图标，计数不直观）。
- 当前事实：前后端都没有事务模式，所有语句自动提交；sqlx 池 `max_connections(1)`，`after_connect` 只恢复默认 schema；连接会因 `max_lifetime`（默认 30 分钟）被替换。
- 规则：
  - 后端每个会话持有 `TxState { manual, pending, open, generation }`（新增 `src-tauri/src/database/tx.rs`）。连接池每建立一个新连接，`generation + 1`，`pending` 与 `open` 清零；Manual 下 MySQL 新连接执行 `SET autocommit=0`。MySQL/PostgreSQL 池关闭 `max_lifetime`，避免事务中途换连接。
  - 语句分类（去掉开头注释后看首关键字）：`COMMIT` / `ROLLBACK`（不含 `ROLLBACK TO`）/ `END` / `ABORT` 结束事务；`BEGIN` / `START TRANSACTION` 开始事务；`SELECT` / `SHOW` / `EXPLAIN` / `DESC(RIBE)` / `USE` / `SET` / `VALUES` / `TABLE` / `SAVEPOINT` / `RELEASE` 以及不含写关键字的 `WITH` 为只读；MySQL 的 `CREATE` / `ALTER` / `DROP` / `TRUNCATE` / `RENAME` / `GRANT` / `REVOKE` 隐式提交；其余为写。
  - Manual 下成功执行后：写 → `pending + 1`；结束事务或 MySQL 隐式提交 → `pending = 0`。PostgreSQL 在没有打开的事务时，写语句前先执行 `BEGIN`。
  - 切到 Manual：MySQL 执行 `SET autocommit=0`。切回 Auto：MySQL 执行 `SET autocommit=1`（隐式提交），PostgreSQL 有打开的事务时 `COMMIT`；`pending > 0` 时前端先确认“将提交 N 条未提交语句”。
- 目标：编辑器工具栏（仅 MySQL/PostgreSQL）新增事务模式按钮 `data-testid="db-tx-mode"`（文字 `Auto` / `Manual`，`data-mode`），未连接时禁用。Manual 下显示 `Commit`（`db-tx-commit`）、`Rollback`（`db-tx-rollback`）和计数 `Pending: N`（`db-tx-pending`）。每条语句执行后刷新计数；提交 / 回滚后计数归零并在状态栏提示。
- IPC：`db_tx_status` / `db_tx_set_manual` / `db_tx_commit` / `db_tx_rollback`，都返回 `{ supported, manual, pending, generation }`。
- 保留契约：Auto 模式下执行行为不变；网格保存（`dbExecute`）在 Manual 下同样进入事务并计数；日志、遇错选择、危险确认照常。
- 非目标：重连提示与关闭标签时回滚（DB-TX-002）；隔离级别选择；智能提交。
- 验收：
  - `A1` 语句分类与计数规则正确（含 MySQL 隐式提交、`ROLLBACK TO`、只读 `WITH`）。
  - `A2` Manual 下写语句不自动提交：Rollback 后数据消失，Commit 后数据保留，计数随之变化。
  - `A3` 新连接使 `generation` 增加并清零计数，Manual 下 MySQL 新连接仍为手动提交。
  - `A4` 切回 Auto 时有未提交语句先确认，确认后提交；取消则保持 Manual。
  - `A5` 不支持的引擎不显示事务控件；未连接时按钮禁用（保留 Auto 行为）。

<a id="db-tx-001-test-cases"></a>
### 测试用例

| V | AC | 前置 / fixture | 操作 | 预期 | 层级 | 路径 / ID |
|---|---|---|---|---|---|---|
| V1 | A1 A3 | 无 | 调用 `classify` 与 `TxState` 方法 | 分类表与计数、`on_new_connection` 符合规则 | rust | `src-tauri/src/database/tx.rs` tests（P2 新增） |
| V2 | A2 A4 | mock IPC | 切 Manual，运行 `insert …`，点 Commit / Rollback；再切回 Auto | 调用对应 IPC，显示 `Pending: 1` 后归零；切回 Auto 前弹确认，取消不调用 | unit | `DbClientTab.test.tsx` “manual commit …”（P2 新增） |
| V3 | A5 | mock IPC，引擎 ClickHouse | 渲染工具栏 | 没有 `db-tx-mode` | unit | 同上 |
| V4 | A2 | native，`mysql_required` | 建表 `qa_tx_t`；切 Manual；插入一行，计数 1；Rollback；`select count(*)` 为 0；再插入并 Commit，计数 0，`select count(*)` 为 1 | 与操作一致 | native | `qa-ui-auto-tests/cases/TC-DB-TX-001-manual-commit-native.testcase.yaml`（P2 新增） |
| V5 | A5 | browser，离线脚手架 | 打开 MySQL 会话（连接失败） | `db-tx-mode` 可见、禁用、文字 `Auto`；没有 `db-tx-commit` | browser | `qa-ui-auto-tests/cases/TC-DB-TX-001-manual-commit-browser.testcase.yaml`（P2 新增） |

<a id="db-edit-001"></a>
## DB-EDIT-001 保存数据编辑前的 SQL 预览

- 来源 / 范围 / 参照：DBV-EDIT-01；所有支持网格回写的 SQL 引擎。`主参照: dbvis`（保存前列出将执行的语句；DBeaver 需另开 “Generate SQL” 才能看到）。无主键警告取 DBeaver 的 “No unique key” 提示。
- 当前事实：`QueryResultGrid.submitChanges` 的确认框只显示增删改数量；`DbClientTab.commitGridChanges` 在确认后才查主键并生成 DML，没有主键时 WHERE 静默使用结果集全部列。
- 规则（新增 `src/lib/dbGridChanges.ts`）：`buildGridChangeStatements` 按现有规则生成 INSERT / UPDATE / DELETE（有主键用主键列，否则用全部列；未改动的 UPDATE 跳过），并返回 `whereUsesAllColumns`。有 UPDATE / DELETE 且没有主键时给出警告 “No primary key found: UPDATE and DELETE match rows on every column and may change more than one row.”。确认框消息 = 原有数量 + 警告（如有）+ `SQL to execute (N):` 与最多 20 条语句（超出显示 `… and K more`）。
- 目标：保存网格修改时，确认框在执行前列出语句与警告；确认后执行的正是预览的语句。生成失败（例如非简单 SELECT）时退回原来只显示数量的确认框，错误仍由提交流程报告。
- 保留契约：取消不执行任何语句；提交后刷新结果页；Manual 提交模式下同样计入未提交数（DB-TX-001）。
- 验收：
  - `A1` 生成规则：主键 / 无主键、NULL 值、未改动 UPDATE 跳过，警告只在无主键且有 UPDATE / DELETE 时出现。
  - `A2` 确认框列出将执行的 SQL，超过 20 条截断。
  - `A3` 确认后执行的语句与预览一致；取消则不执行。
  - `A4` 预览失败时退回数量确认（保留）。

<a id="db-edit-001-test-cases"></a>
### 测试用例

| V | AC | 前置 / fixture | 操作 | 预期 | 层级 | 路径 / ID |
|---|---|---|---|---|---|---|
| V1 | A1 A2 | 无 | 调用 `buildGridChangeStatements` / `gridChangeConfirmMessage` | 语句、`whereUsesAllColumns`、警告与截断符合规则 | unit | `src/lib/dbGridChanges.test.ts`（P2 新增） |
| V2 | A2 A3 A4 | mock `onPreviewChanges` | 网格删除一行后点 Submit | 确认消息含预览 SQL；取消不调用 `onCommitChanges`；预览抛错时消息只有数量 | unit | `QueryResultGrid.test.tsx` “previews grid SQL …”（P2 新增） |
| V3 | A1 A3 | native，`mysql_required` | 有主键表删除第 1 行并 Submit：消息含 `DELETE FROM` 且无警告，确认后计数为 0；无主键表删除一行：消息含 `No primary key`，取消 | 与操作一致 | native | `qa-ui-auto-tests/cases/TC-DB-EDIT-001-grid-sql-preview-native.testcase.yaml`（P2 新增） |
| — | — | browser | — | 浏览器预览没有可执行的数据库，得不到可编辑结果集；不设 browser 用例 | — | — |

<a id="db-grid-001"></a>
## DB-GRID-001 排序以 DbVisualizer 为准与过滤计数

- 来源 / 范围 / 参照：DBV-GRID-01、DBV-GRID-02；所有 SQL 结果网格。`主参照: dbvis`（用户指定排序以 dbvis 为准；计数格式取 dbvis 状态栏 `10 [200]/4`）。
- 当前事实：列头点击已是客户端升序 → 降序 → 取消，并可生成 ORDER BY 的 SQL；客户端过滤（Filter rows 与列过滤）后没有“过滤后 / 总数”计数。
- 规则：网格工具栏末尾显示 `data-testid="query-result-row-count"`：未过滤时 `<行数>/<可见列数>`；过滤后 `<显示行数> [<总行数>]/<可见列数>`，并带 `data-filtered="true"`。行数包含标记删除但未提交的行（它们仍显示在网格中）。
- 保留契约：排序循环、生成的 ORDER BY / WHERE SQL、面板状态栏的 `N rows` 不变。
- 验收：
  - `A1` 列头连续点击三次：升序 → 降序 → 恢复原始顺序，全程不重新执行 SQL（保留，补测试）。
  - `A2` 过滤后计数为 `显示 [总数]/列数`，清空过滤恢复为 `总数/列数`。

<a id="db-grid-001-test-cases"></a>
### 测试用例

| V | AC | 前置 / fixture | 操作 | 预期 | 层级 | 路径 / ID |
|---|---|---|---|---|---|---|
| V1 | A1 | 3 行结果 | 点击 `name` 列头三次 | 行顺序依次为升序、降序、原始；未调用刷新 | unit | `QueryResultGrid.test.tsx` “cycles sorting …”（P2 新增） |
| V2 | A2 | 同上 | 打开 Filter rows 输入 `Ann`，再清空 | 计数 `3/3` → `2 [3]/3` → `3/3` | unit | `QueryResultGrid.test.tsx` “shows filtered row count …”（P2 新增） |
| V3 | A1 A2 | native，`mysql_required` | `SELECT` 三行，点列头排序，Filter rows 输入过滤 | 计数 `3/2` → `1 [3]/2`；排序后首行变化 | native | `qa-ui-auto-tests/cases/TC-DB-GRID-001-sort-filter-count-native.testcase.yaml`（P2 新增） |
| — | — | browser | — | 浏览器预览得不到结果网格；不设 browser 用例 | — | — |

<a id="db-tx-002"></a>
## DB-TX-002 重连与关闭时的未提交处理

- 来源 / 范围 / 参照：DBV-TX-02；MySQL/MariaDB 与 PostgreSQL 的 Manual 模式。`主参照: merge`：重连后的可见提示取 DbVisualizer（DBeaver 只在日志里记录）；关闭标签时回滚取 DBeaver 的 “rollback on close” 默认值，但不弹三选框，改为回滚后在状态栏说明，避免关闭流程被阻塞。依赖 DB-TX-001。
- 当前事实：DB-TX-001 的 `TxState.generation` 在每个新物理连接时加 1 并清零计数，但前端不比较 generation；关闭标签只调用 `db_disconnect`，服务器端隐式回滚且无提示。
- 规则：
  - 前端每次拿到新的 `DbTxStatus`（运行结束、网格保存、Commit / Rollback、切换模式）时与上一次比较：`generation` 变大且上一次是 Manual 且 `pending > 0`，弹出提示框（标题 `Connection re-established`，内容 `The database connection was re-established. N uncommitted statement(s) were lost.`），并写入状态栏；计数随新状态归零。
  - 卸载（关闭标签）时，Manual 且 `pending > 0`：先 `db_tx_rollback` 再 `db_disconnect`，状态栏显示 `Rolled back N uncommitted statement(s) when the database tab closed.`。回滚失败也继续断开。
- 保留契约：Auto 模式与无未提交语句时的关闭行为不变；Commit / Rollback 计数规则不变。
- 非目标：关闭前询问 Commit / Rollback；自动重试丢失的语句。
- 验收：
  - `A1` generation 变化且之前有未提交语句时弹出提示并清零计数；没有未提交语句时不提示。
  - `A2` 关闭标签时有未提交语句则先回滚再断开，并在状态栏说明；否则只断开。
  - `A3` 真实 MySQL 上连接被杀后下一条语句触发提示，之前的插入不存在。

<a id="db-tx-002-test-cases"></a>
### 测试用例

| V | AC | 前置 / fixture | 操作 | 预期 | 层级 | 路径 / ID |
|---|---|---|---|---|---|---|
| V1 | A1 | mock IPC | Manual 下插入（Pending 1）后下一次状态的 generation + 1、pending 0 | alert 标题 `Connection re-established`，内容含 `1 uncommitted`；计数 0；无未提交时 generation 变化不提示 | unit | `DbClientTab.test.tsx` “reconnect …”（P2 新增） |
| V2 | A2 | mock IPC | Manual 且 Pending 1 时卸载组件；Auto 时卸载 | 先 `dbTxRollback` 后 `dbDisconnect`，状态栏消息；Auto 只调用 `dbDisconnect` | unit | 同上 |
| V3 | A1 A3 | native，`mysql_required` | Manual，插入一行（Pending 1）；执行 `KILL CONNECTION_ID()`；再执行计数查询 | 出现 `alert-dialog` 含 `uncommitted`；Pending 0；计数 `count-0` | native | `qa-ui-auto-tests/cases/TC-DB-TX-002-reconnect-close-native.testcase.yaml`（P2 新增） |
| V4 | A2 | 同上 | 再插入一行（Pending 1）后关闭数据库标签；重新打开会话计数 | 状态栏含 `Rolled back 1`；重新打开后 `count-0` 且模式为 Auto | native | 同上 |
| — | — | browser | — | 浏览器预览不能建立连接，Manual 模式不可用；不设 browser 用例 | — | — |
