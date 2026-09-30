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
