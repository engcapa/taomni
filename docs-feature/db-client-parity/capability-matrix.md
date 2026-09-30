# 能力矩阵（P0 首次，2026-09-30）

结论取值：`已对齐` `差异` `缺失` `未验证` `不适用`。`ref` 为已观测来源与主参照（取长规则见 `.agents/skills/db-client-parity/references/ui-alignment.md#取长规则`）。Taomni 现状依据 `fa04812b` 的生产代码核对；未实测的引擎一律“未验证”。

| 场景 | Taomni 现状（生产入口） | 功能 | UI/交互 | ref / 主参照 | 卡 |
|---|---|---|---|---|---|
| DBV-EXEC-01 执行日志 | 每条语句一个结果页签，错误只在该页签的 Messages 子页（`DbClientTab.runQuery` / `streamQueryIntoSheet`）；没有跨语句的日志与汇总 | 缺失 | 缺失 | dbvis（Log 表格 + 汇总） | DB-EXEC-001 |
| DBV-EXEC-02 多语句遇错 | `runQuery` 遇到第一条失败就静默停止，没有提示或继续选项 | 差异 | 缺失 | dbeaver（Stop / Skip / Skip all），日志取 dbvis | DB-EXEC-002 |
| DBV-EXEC-03 危险语句确认 | 无确认，直接执行 DROP / TRUNCATE / 无 WHERE 的 DELETE、UPDATE | 缺失 | 缺失 | dbeaver（执行前确认） | DB-EXEC-003 |
| DBV-EXEC-04 执行计划 | 只有 AI “解释语法”，没有 EXPLAIN 入口 | 缺失 | 缺失 | dbeaver（当前语句，结果标签 Execution plan） | DB-EXEC-004 |
| DBV-EXEC-05 执行当前语句 / 全部 | 工具栏 Run / Selection / Current，快捷键可配置（`SqlEditorPanel` + `sqlExecutionPreferences`） | 已对齐 | 已对齐 | dbeaver + dbvis | —— |
| DBV-EXEC-06 取消 | 工具栏 Cancel → `db_cancel`（取消令牌） | 已对齐（MariaDB 未实测） | 已对齐 | dbvis | —— |
| DBV-TX-01 手动提交模式 | 没有自动提交开关、提交/回滚和未提交计数（前后端都没有） | 缺失 | 缺失 | merge：事务模式开关取 dbeaver，状态栏计数与提示取 dbvis | DB-TX-001 |
| DBV-TX-02 断线与关闭时的事务处理 | 池连接会被 sqlx 静默替换，无提示；关闭标签直接断开 | 差异 | 缺失 | dbvis（可见的重连提示），补充“未提交已丢失” | DB-TX-002 |
| DBV-EDIT-01 保存数据编辑 | 确认框只显示增/改/删数量，DML 在确认后生成并执行（`QueryResultGrid.submitChanges` → `DbClientTab.commitGridChanges`） | 差异 | 差异 | 两款都没有预览；目标为 SQL 预览 + 确认，无主键时警告 | DB-EDIT-001 |
| DBV-GRID-01 排序 | 列头点击：升序 → 降序 → 取消，客户端完成；另有生成 ORDER BY 的 SQL 同步 | 已对齐 | 已对齐 | dbvis（用户指定） | DB-GRID-001（验证） |
| DBV-GRID-02 过滤 | 结果工具栏 Filter rows（客户端）+ 列过滤，可生成 WHERE 的 SQL；没有“过滤后 / 总数”计数 | 差异 | 差异 | merge：客户端过滤取 dbvis 的 `n [total]` 计数，SQL 条件保留 | DB-GRID-001 |
| DBV-XFER-01 导出 | 格式 CSV/HTML/TXT/SQL/XML/Excel/JSON，目标全部/选区，复制 / 表格 / 浏览器打开 | 已对齐（与 dbvis 向导的选项一致） | 未验证 | dbvis 为主 | —— |
| DBV-OBJ-01 对象详情 | `DbObjectDetailDialog`（列、索引、外键、DDL、统计） | 未验证 | 未验证 | dbeaver | 后续增量 |
| DBV-CONN-01 连接配置 | SessionEditor 数据库区，SSH/代理转发 | 未验证 | 未验证 | dbeaver | 后续增量 |
| DBV-HB-* HBase | `HBaseShellTab` / `HBaseSchemaTree` | 未验证 | 未验证 | 参照来源待定；无 fixture | 后续增量（需 DB-GATE 设施卡） |
| DBV-ER-* ER 图 | —— | 不适用 | 不适用 | 用户决定不做 | —— |
| PRO 独有场景 | —— | 未验证 | 未验证 | 暂不采集 | —— |

第一批卡覆盖上表中“缺失 / 差异”的执行、事务、编辑与过滤场景；其余场景在后续 P0 增量中按实测产卡。
