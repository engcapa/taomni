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
