# P0 目标小节（第一批）

每节只写来源、用户结果、已知事实和非目标；验收与用例在 P1 写入 [batch1-plan.md](batch1-plan.md)。

<a id="db-exec-001"></a>
## DB-EXEC-001 执行日志与汇总

来源：DBV-EXEC-01。用户结果：一次运行多条语句后，在同一个 Log 视图里看到每条语句的状态、耗时、行数和错误，以及成功/失败汇总（取 DbVisualizer）。已知：`DbClientTab.runQuery` 每条语句建一个结果页签，错误只在该页签的 Messages 里。非目标：历史面板改版。

<a id="db-exec-002"></a>
## DB-EXEC-002 多语句遇错时的选择

来源：DBV-EXEC-02。用户结果：多语句运行中某条失败时，弹框选择 Stop / Skip / Skip all（取 DBeaver），日志记录被跳过与未执行的语句。已知：`runQuery` 遇错后 `break`，无提示。

<a id="db-exec-003"></a>
## DB-EXEC-003 危险语句执行前确认

来源：DBV-EXEC-03。用户结果：执行 DROP、TRUNCATE、不带 WHERE 的 DELETE / UPDATE 前列出语句并确认（取 DBeaver）；取消则一条都不执行。

<a id="db-exec-004"></a>
## DB-EXEC-004 当前语句的执行计划

来源：DBV-EXEC-04。用户结果：对光标所在语句执行 Explain，结果以 “Explain” 标签显示（取 DBeaver 只分析当前语句）。按引擎生成 EXPLAIN 语句；不支持的引擎给出原因。

<a id="db-tx-001"></a>
## DB-TX-001 手动提交模式

来源：DBV-TX-01。用户结果：工具栏切换 Auto / Manual 提交；Manual 下有 Commit / Rollback 与未提交语句计数（开关取 DBeaver，计数取 DbVisualizer）。已知：前后端都没有事务模式；sqlx 池 `max_connections(1)`，但连接可能因 max_lifetime 被替换。

<a id="db-tx-002"></a>
## DB-TX-002 重连与关闭时的未提交处理

来源：DBV-TX-02。用户结果：连接被重建时明确提示“未提交的修改已丢失”并清零计数（取 DbVisualizer 的可见提示）；有未提交语句时关闭标签会先回滚并告知。依赖 DB-TX-001。

<a id="db-edit-001"></a>
## DB-EDIT-001 保存数据编辑前的 SQL 预览

来源：DBV-EDIT-01。用户结果：结果网格保存修改前，确认框列出将要执行的 INSERT / UPDATE / DELETE；没有主键时明确警告 WHERE 使用全部列。已知：`submitChanges` 只显示数量，DML 在确认后才生成。

<a id="db-grid-001"></a>
## DB-GRID-001 排序以 DbVisualizer 为准与过滤计数

来源：DBV-GRID-01、DBV-GRID-02。用户结果：列头点击排序保持客户端升序 → 降序 → 取消；客户端过滤后显示 `过滤后 [总数]` 行数（取 DbVisualizer）。

<a id="db-gate-001"></a>
## DB-GATE-001 第一批集成门槛

来源：第一批全部卡。结果：全仓 build、qa-lint，以及第一批 browser / native 用例在三端的选定运行全部通过。
