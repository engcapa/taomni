# 能力域与定位线索

P0 以此为矩阵的起始分类，不是现状结论。DBeaver 列是待用目标版本实测核对的方向；Taomni 列只用于定位代码，结论以当前生产 caller 为准。不在本文件记录完成状态。

## 范围

- 会话：`database` TabKind（`DbHandle`：MySQL、PostgreSQL、PanWeiDB、Oracle、SQL Server、StarRocks、ClickHouse、Presto/Trino）与 `hbase-shell` TabKind（native RPC + ZooKeeper，Thrift2-over-HTTP 用于 Lindorm/HBase 增强版）。
- 参照：DBeaver（Community 为通用基线，PRO 独有功能纳入）与 DbVisualizer Pro，按 [取长规则](ui-alignment.md#取长规则) 为每个场景选主参照。矩阵每个场景标 `ref: dbeaver-ce|dbeaver-pro|dbvis-pro` 的已观测来源和主参照；PRO 场景必须引用对应的 PRO 参考包。
- PRO 功能逐项判定，不整体排除：与桌面单用户数据库会话相关的纳入；依赖 DBeaver 服务端/团队协作/云账号体系的（如 Team 共享、Cloud Explorer）由 P0 判为 `不适用` 并写原因，或经用户确认后以 Taomni 等价能力对齐。
- 非目标：`redis` TabKind（用户明确纳入时再建域）；可视化查询构建器（DBeaver Visual Query Builder / DbVisualizer Query Builder）；结果集图表与仪表盘（Chart 视图、PRO 图表）。用户已于 2026-09-30 明确排除后两项。
- 引擎：`DbHandle` 的全部引擎都要支持，但参照采集先只用 MariaDB 12.1.2（共享测试库）。其他引擎的差异在其 fixture 就绪后再采，之前记为“未验证”。
- 2026-09-30 用户决定：ER 图不支持（`ER` 域不产卡）；DBeaver PRO 暂不采集，PRO 独有场景在有参照前不产卡；结果集排序以 DbVisualizer 为准（单击列头在客户端切换，另有 ORDER BY 重载入口）。Taomni 特有 AI 能力（`dbAiPrompts.ts`、Ask AI 菜单等）保留并纳入回归，不以 DBeaver 为目标。

## SQL 会话域

| 域 | CE 参照方向 | PRO 增量方向（待实测） | Taomni 定位线索 |
|---|---|---|---|
| `CONN` 连接 | 驱动、主机/库/认证、驱动属性、SSH/代理、SSL、测试连接、连接类型（色标、自动提交、执行确认）、初始化 SQL、文件夹 | 云/Kerberos 等扩展认证、密码管理集成 | `SessionEditor.tsx` database 区；`database/mod.rs`（`db_connect`/`db_ping`）、`forward.rs`；vault |
| `NAV` 导航器 | 懒加载对象树、过滤、刷新、右键（打开、生成 SQL、复制名称）、与编辑器联动 | 对象搜索增强 | `SchemaTree.tsx`、`src/lib/dbMetadataCache.ts`；`db_list_*`、`db_search_tables` |
| `SQL` 编辑器 | 活动 catalog/schema、语句定界与高亮、补全、模板、格式化、参数/变量、脚本保存 | 高级补全/AI 助手（查询构建器不在目标内） | `SqlEditorPanel.tsx`、`formatSql.ts`、`src/lib/sql*.ts`；`sql_rewrite.rs`、`query_workspace.rs`、`saved_queries.rs`、`QueryLibraryPanel.tsx` |
| `EXEC` 执行 | 当前语句/脚本/新标签执行、执行计划、进度与取消、错误定位、执行日志/历史 | 可视化执行计划 | `DbClientTab.tsx`、`sqlExecutionPreferences.ts`；`db_execute(_stream)`、`db_cancel`、`history.rs` |
| `GRID` 结果集 | 网格/文本/记录视图、分页取数、排序/过滤、多结果标签、值查看器、NULL 显示、高级复制、行数统计 | 分组/透视、结果集比较（图表不在目标内） | `QueryResultGrid.tsx` |
| `EDIT` 数据编辑 | 单元格编辑、增删/复制行、保存前 DML 预览、取消修改、无主键只读 | 批量/测试数据生成 | `QueryResultGrid.tsx`（`QueryGridCommitPayload`）、`DbClientTab.tsx` `commitGridChanges` |
| `OBJ` 对象 | 表属性页（列、约束、外键、索引、DDL、数据）、界面修改并预览 SQL | —— | `DbObjectDetailDialog.tsx`；`db_describe_table`、`db_list_indexes`、`db_list_foreign_keys`、`db_object_ddl`、`db_table_stats` |
| `ER` 图（不支持） | —— | —— | 用户决定不做 |
| `TX` 事务 | 自动/手动提交、提交/回滚、待提交提示、关闭时未提交处理 | 事务日志增强 | 待 P0 定位 |
| `XFER` 数据传输 | 导出 CSV/JSON/SQL/XLSX、导入 CSV、表到表 | Excel/更多格式导入、传输任务 | `QueryResultGrid.tsx` 导出（`ExportTarget`） |
| `CMP` 比较 | —— | 数据比较、schema 比较与同步脚本 | 待 P0 定位 |
| `TASK` 任务 | 基础任务 | 任务调度、批处理 | 待 P0 定位 |
| `PREF` 偏好 | 编辑器/结果集/执行偏好、快捷键 | —— | Settings database 分组、`sqlCompletionPreferences.ts`、`useDbSessionFontSize.ts` |

## DbVisualizer 对应入口

依据是 DbVisualizer Pro 25.1.3 安装文件中的菜单定义，只证明入口存在，行为待实测。详见 `docs-feature/db-client-parity/references/DBVIS-001-pro-25.1.3.md`。

| 域 | DbVisualizer 入口 |
|---|---|
| `CONN` | 从 URL 创建连接、复制连接、连接文件夹、全部连接/断开/重连、SSH 服务器管理、Single Physical Connections |
| `NAV` | Databases/Files/Favorites 三个侧栏页签；内联过滤与过滤编辑器、仅显示默认库/schema、树中显示行数、双向 Autoscroll、打开到 tab/新 tab/浮动 tab、Search Database、Copy Object Path |
| `SQL` | SQL Commander：Sticky Database/Schema、Max Rows/Max Chars 工具栏；选择当前/上一条/下一条语句；格式化/反格式化（Buffer/Current/复制/粘贴）；编辑器模板、宏、折叠；参数化 SQL、预处理脚本、剥离注释；Show Object at Cursor（Query Builder 不在目标内） |
| `EXEC` | Execute / Execute Current / Execute Buffer / Explain Plan（文本、Analyze、Verbose、DBMS_XPLAN）/ Stop；遇错、遇警告、无行时停止；错误位置/语句标记；SQL History 前后翻阅；多结果集合并；生成 dbviscmd 命令 |
| `GRID` | Grid/Text 视图（Chart 不在目标内）；分页；内联过滤；选区聚合；列头自动宽度/排序/查找/隐藏/换行；复制为格式化文本、逗号列表、IN 子句、HTML；在电子表格中打开；结果集标签页固定/重命名/浮动/平铺/载回编辑器 |
| `EDIT` | Save Edits、插入/复制/删除行、在窗口中编辑行或单元格、批量设置选中单元格、撤销单元格修改 |
| `OBJ` | 按引擎 profile 定义的对象视图页签（如 MySQL 表：Info、Columns、Native DDL、Triggers；视图：Info、Columns、Data、Row Count、Grants、DDL）；Create/Alter Table 列编辑器 |
| `ER` | 对象导航图（不在目标内） |
| `TX` | 提交、回滚、切换自动提交（工具栏与右键） |
| `XFER` | 导出：可见/全部/选区；导入 |
| `CMP` | Tools → Compare；Compare to Saved |
| `TASK` | Data Monitor；dbviscmd 命令生成 |
| `PREF` | Tool Properties、Key Bindings 编辑器、多套 keymap（Linux、macOS、TOAD、SQL Query Analyzer）、SQL 格式化 profile |

## HBase 域 `HB`

两款客户端都没有已确认的 HBase 原生会话：DbVisualizer 25.1.3 的 profile 与驱动列表中没有 HBase 或 Phoenix。P0 先实测确定参照来源，再对齐：

1. DBeaver 的 Apache Phoenix（SQL-over-HBase）驱动：需服务端安装 Phoenix；只对 SQL 形式的场景有效。
2. PRO 的 NoSQL/宽表编辑器（如 Bigtable、Cassandra）：作为命名空间/表/列族浏览、键值扫描网格、值编辑的交互参照。
3. 两者都不适用的 HBase 专有操作（shell 命令、region、列族属性、Kerberos/Lindorm）：记为 Taomni 适配，沿用 DBeaver 通用的导航器/网格/编辑器交互规范，不虚构 DBeaver 行为。

| 场景方向 | Taomni 定位线索 |
|---|---|
| 连接（ZK quorum/root、Kerberos、Thrift/Lindorm） | `SessionEditor.tsx` HBase 区；`src-tauri/src/hbase/`（`native/`、`thrift/`） |
| 命名空间/表/列族导航 | `HBaseSchemaTree.tsx` |
| Shell 编辑与执行、结果展示 | `HBaseShellTab.tsx`；`hbase/mod.rs` `parse_shell_command`/`native_execute` |
| scan/get/put/delete 数据浏览与编辑 | `HBaseShellTab.tsx`、`hbase/native/client.rs` |
| 表描述、建/改/删表 | `hbase/mod.rs` |
| Query Library 共用 | `QueryLibraryPanel.tsx`（TC-auto-F-DB-3-hbase-query-library） |

引擎差异按“通用行为 + 引擎差异”记录；某引擎或 HBase 后端（native/Thrift）未实测即为未验证。
