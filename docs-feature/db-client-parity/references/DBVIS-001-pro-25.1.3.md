# DBVIS-001 DbVisualizer Pro 25.1.3 参照（安装文件、主窗口布局、MariaDB 交互实测）

| 项 | 记录 |
|---|---|
| 身份 | DBVIS-001；DbVisualizer Pro 25.1.3（窗口标题）；Windows；2026-09-30 采集 |
| 依据类型 | 安装文件（`C:\software\DbVisualizer`，`dbvis.jar` 构建日期 2025-04-11）；不抢焦点的窗口采集（用户常驻实例，PID 32664） |
| 环境 | 窗口 1550×830，DPI 96（100%），默认浅色主题；locale、字体、keymap 未核对 |
| fixture | 交互实测：qa-ui-auto 配置的共享测试库（MariaDB 12.1.2），对象前缀 `dbv_parity_20260930`，已清理 |
| 未做 | 见文末“未观测”；HBase 无参照 |

原始产物（gitignored，只在本机）：`qa-ui-auto-report/dbvis-reference/_install/{menus.md,object-views.md}`，由 `.agents/skills/db-client-parity/scripts/dbvis_catalog.py` 生成；`qa-ui-auto-report/dbvis-reference/run-20260930/03-main.{png,ocr.txt}`，由 `scripts/window_capture.ps1` 生成。截图含用户数据，不入库。

## 主窗口布局（窗口采集，OCR 坐标为 CSS px）

| 区域 | 观察 |
|---|---|
| 标题栏 / 菜单栏 | 原生标题栏，标题为 `DbVisualizer Pro <版本> - <当前文件路径>`；菜单：File、Edit、View、Database、SQL Commander、Tools、Window、Help |
| 主工具栏 | y≈40 一行图标按钮（New 下拉、Open、Save、Connect All …，名称以安装文件为准） |
| 左侧栏 | x 0–≈330；页签 Databases / Files / Favorites；Databases 下是连接树，支持文件夹分组 |
| 编辑器页签 | x≈340 起；标签格式 `<序号>: <连接名> <文件名或 Untitled>`，未保存时加 `*`，每个标签有关闭按钮；可同时打开多个同连接编辑器 |
| SQL Commander 控制行 | 编辑器上方：Database Connection 选择、Sticky Database（勾选框）+ 数据库选择、Schema 选择、Max Rows（示例值 100000）、Max Chars |
| 编辑器 | 带行号；结果区在未执行时不显示 |
| 状态栏 | 左：`行/列 [偏移] INS`；右：换行符 `LF`、连接状态（`Not Connected`）、编码 `UTF-8`、文件名；再下一行是 JVM 内存 `1137M of 4096M` 和 GC 按钮 |

与 Taomni 相关的可取之处（待交互实测确认）：编辑器标签直接显示连接名；“Sticky Database/Schema”固定执行上下文；Max Rows/Max Chars 放在编辑器头部；状态栏集中显示连接状态、编码和光标位置。

## 菜单与动作目录（安装文件依据）

`dbvis-actions.xml` 定义 685 个 action、2149 处引用、150 个顶层 action-list（菜单、工具栏、右键菜单）。按能力域的要点见 `.agents/skills/db-client-parity/references/domains.md` 的“DbVisualizer 对应入口”。重点入口：

- **SQL Commander 菜单/工具栏**：Execute、Execute Current、Execute Buffer、Execute Explain Plan（Text Output / With Analyze / With Verbose / Use DBMS_XPLAN）、Stop；Transaction（Commit / Rollback / Turn On/Off Auto Commit）；SQL History 首/前/后/末；Format SQL（Buffer / Current / Copy Formatted / Paste Formatted / Unformat）；Show Object at Cursor；SQL Commander Options（Preprocess Script、Parameterized SQL、Get Parameter Types via JDBC、Strip Comments、Stop on Error / SQL Warning / No Rows、错误位置/语句标记）；Merge Result Sets（含执行后自动合并）；Show Query Builder；Generate Command for dbviscmd。
- **编辑器右键**：Selection（当前/上一条/下一条语句）、Add Selection as Template、Morph Selection、Paste with Dialog、Compare to Saved、Folding、Macro、Expand Editor/Result Set Area。
- **对象树右键**：Connect/Disconnect/Reconnect（单个与全部）、从 URL 创建连接、复制连接、连接文件夹、Search Database、内联过滤/过滤编辑器/仅显示默认库、显示表行数、Autoscroll TO/FROM Object View、Copy Name / Database URL / Object Path、Toggle Visited State、Add to Favorites；工具栏 Open Object 支持 Open in Tab / New Tab / Floating Tab。
- **可编辑结果集**：Reload（含按排序生成 ORDER BY 重载）、Stop、Export（Visible / All / Selection）、Open as Spreadsheet、Aggregation Data for Selection、内联过滤、Save Edit(s)、Insert / Duplicate / Delete Row、Edit Row/Cell in Window、Set Selected Cells、Undo Edits in Selected Cell(s)、分页。
- **结果集单元格右键**：Copy Selection（含表头）、Copy Selection As（格式化文本、逗号列表、IN 子句、IN+AND、IN+OR、HTML 表格）、Inverse Selection。
- **列头右键**：Auto Resize（4 种）、排序/重置排序、Find / Select / Hide Column、Restore Columns Layout、Wrap Column Text。
- **结果集视图**：Grid / Text / Chart；Chart 类型 Line、Point、Area、Stacked Area、Bar、Stacked Bar、Pie，并有图例与配置。
- **结果集标签页右键**：Close（其他/可关闭/空/全部）、Rename、Modify Tab Labelling、Pin/Unpin、Maximize、Floating、Tile/Collapse、Load Selected Commands into Editor（At Caret / First / Last / Replace All）、Merge Result Sets。
- **Query Builder**：Execute、Copy/Add SQL into Editor、Quick Table Add、Edit Details / SQL Preview。
- **Tools**：Driver Manager、Data Monitor、SQL History、Compare、Debug Window、Tool Properties；键位方案：Linux、Linux-UNIX、macOS、TOAD、SQL Query Analyzer（Windows 默认键位不在安装文件中，需在 Tool Properties → Key Bindings 实测）。

## 对象视图（profile 依据）

`resources/profiles/` 有 39 个 profile XML，其中 37 个直接定义了对象视图；与 Taomni 引擎重合的有 mysql（mysql-base）、postgresql、oracle、sqlserver、clickhouse、presto-base（trino.xml 另有 profile，未直接定义对象视图），没有 HBase / Phoenix。MySQL 示例（profile 层额外定义的页签；通用页签如 Data、Row Count 可能由基类提供，待实测）：

- Table：Info、Columns、Native DDL、Triggers；Tables：Tables、References
- View：Info、Columns、Data、Row Count、Grants、DDL
- Procedure / Function / Trigger：对应编辑器 + Info
- DBA 节点：Users/Privileges、Processes、Status（Variables、Charset、Collation、Session SQL Mode、Replica Status）、Table Engines、Events

## 交互实测（2026-09-30，用户授权使用常驻实例）

fixture：qa-ui-auto 配置中的共享测试库，实际服务端为 **MariaDB 12.1.2**，驱动 MySQL 8+（Connector/J 9.1.0）。新建连接 `taomni-qa-mysql (parity test)`，只在新开的 SQL Commander 标签里操作，对象名前缀 `dbv_parity_20260930`，结束时已 DROP 并确认。原始截图与 OCR 在 `qa-ui-auto-report/dbvis-reference/run-20260930-i/`。

### 默认快捷键（Windows，菜单与工具提示实测）

| 动作 | 键 |
|---|---|
| New SQL Commander | Ctrl+T |
| Execute | Ctrl+Enter |
| SQL History 首/前/后/末 | Ctrl+Shift+P / Ctrl+P / Ctrl+N / Ctrl+Shift+N |
| Show Object at Cursor | Ctrl+Shift+E（OCR 不清，待复核） |
| Generate dbviscmd | Ctrl+Alt+G |
| Open / Quick File Open / Save As | Ctrl+O / Ctrl+Alt+O / Ctrl+Shift+S |
| Undo / Redo | Ctrl+Z / Ctrl+Shift+Z |
| Morph Selection / Clear All | Ctrl+Shift+M / Ctrl+Shift+Delete |
| 对象 Open in Tab / Floating Tab | Ctrl+L / Ctrl+Shift+L |
| Connect / Disconnect / Reconnect | Ctrl+Shift+C / Ctrl+Shift+D / Ctrl+Shift+R |
| Connect / Disconnect / Reconnect All | Shift+F6 / Shift+F7 / Shift+F8 |
| 结果集：Save edits and reload / Insert row / Duplicate / Delete row | Ctrl+S / Ctrl+I / Ctrl+D / Ctrl+X |
| 结果集：Select Row(s) / Copy with header / Reload / Find Data / Reset Grid | Ctrl+Shift+J / Ctrl+H / Ctrl+R / Ctrl+F / Ctrl+Shift+E |

Execute Current 为 `Alt+E, E`，Explain Plan 为 `Ctrl+Alt+Enter`（第二轮补采）；Execute Buffer 与 Stop 的键未显示。

### 场景观察

| 场景 | 观察 |
|---|---|
| 建连接 | “Create Connection from Database URL” 对话框（URL + 自动识别的 Driver）→ 在对象视图标签中打开连接编辑器：属性表格（Name、Notes、Settings Format、Database Type=Auto Detect (MySQL)、Driver Type、URL、Userid、Password、Auto Commit、Save Database Password、Permission Mode=Development）+ Connect / Disconnect / Ping Server + Connection Message 区。选择驱动后 Settings Format 切到 Server Info（Server/Port/Database，另有 Use SSH Tunnel）。驱动未配置时 Connection Message 给出原因和处理方法；连上 MariaDB 用 MySQL 驱动时给出警告及版本/驱动信息 |
| 编辑器标签 | 新标签 `5: <连接名> Untitled`，编辑器头部自动绑定当前连接和默认库 |
| 执行脚本 | Ctrl+Enter 执行整个缓冲区中的 3 条语句（DDL + DML + SELECT）。结果区：`Log` 标签 + 每个结果集一个标签 `<n>: <表名> [<行数>]`；网格有行号列，NULL 显示 `(null)`，小数保持定标；底栏 `Format: <Select a Cell>`、`执行/取数 sec`、`行/列`、可见范围 |
| 事务 | 该连接默认 Auto Commit OFF。状态栏显示 `Auto Commit: OFF (<未提交>/<总数>)`。执行后弹出对话框列出未提交语句，按钮为 Commit / Rollback / Continue with Uncommitted。关闭含未提交语句的标签时再次要求 Commit / Rollback / Cancel |
| 错误路径 | 默认不因错误停止：3 条语句中第 2 条失败，其余继续。Log 表格列：Time、Status（STARTED / SUCCESS / FAILED / FINISH）、Command、Exec、Fetch、Rows、Message（`[Code: 1146, SQL State: 42S02] Table ... doesn't exist`）、SQL/Command；末行汇总 `Success: 2 Failed: 1`；失败语句不产生结果标签 |
| 对象树 | 连接 → Databases / DBA Views；库节点标 `(Default)`；库下 Tables、Views、Stored Procedures、User Functions、Triggers、Events |
| 表对象视图 | 双击表在新标签打开：头部 `Table: <连接>/Databases/<库>/Tables/<表>` + Actions…；页签 Info、Columns、Data、Row Count、Primary Key、Indexes、Grants、Row Id、References、Navigator、DDL、Native DDL、Triggers；Info 为 Name/Value 表（Engine、Version、Row format、Rows…） |
| 数据编辑 | Data 页签内双击单元格编辑，页签变 `Data*`、窗口标题加 `*`。工具栏 Save（Ctrl+S，“Save data edit(s) and reload”）**直接写入，无 SQL 预览或确认**，写入后刷新；同一连接的 SQL 标签事务计数不变。重连后另查询确认值已持久化 |
| 关闭标签 | 标签右键菜单：Select in Databases Tab、Close / Close Other / Closeable / All Pinned / All Tabs、Rename、Modify Tab Labelling、Pin / Pin All / Unpin All、Maximize、Floating、Tile / Collapse all。关闭已修改且有未提交语句的标签：先提示“编辑器已修改 + 有未提交调用”（关闭 / Keep Tab），再给 Commit / Rollback / Cancel |
| 其他 | 右下角出现 “Application error — Click to see error log”，点开是 Debug Window（Error Log / Debug Log / Open Log Directory）；与本次操作的关联未确认 |

### 第二轮（2026-09-30，run-20260930-j）

fixture：`dbv_parity_j_item`（200 行，由 `seq_1_to_200` 生成）与 `dbv_parity_j_grp`（7 行）。结束时已 DROP，确认残留为 0。

| 场景 | 观察 |
|---|---|
| Execute Current | 菜单 SQL Commander → Execute Current，快捷键 `Alt+E, E`（组合键序列）。光标位于多行 GROUP BY 语句内，只执行该语句（以空行/分号定界），结果标签 `1: <表> [7]` |
| Explain Plan | `Ctrl+Alt+Enter`，子菜单有 Text Output、With Analyze、With Verbose、Use DBMS_XPLAN。缓冲区里有多条语句时弹框 “Do you really want to execute explain plan for multiple statements?”（Execute / Cancel，可勾选不再提示），每条语句产生一个 `EXPLAIN at <时间>` 标签。计划视图可切 Tree View / Graph View / Show Details，列：Node、Cost、table name、Access Type（如 `ALL (Full Table Scan)`）、Possible Keys、Key Used、Key Parts、Key Length、Ref、Rows、Filtered、Using Index、Attached Condition、Using Temporary…；执行 Explain 后状态栏未提交计数增加 |
| 排序 | 单击列头：第一次升序、第二次降序，列头显示排序图标；在客户端完成，不重新执行 SQL。列头右键另有 Sort Asc/Desc、Reset Sorting；网格右键有 Reload with Sorting as ORDER BY |
| 过滤 | 结果工具栏右侧的 Quick Filter 输入框：在客户端做跨列子串匹配，实时生效。状态栏显示 `10 [200]/4`（过滤后行数 [总行数]/列数）。过滤后排序回到原始顺序。清空输入即恢复。Inline Filter Pane 按钮在 SQL 结果集上没有打开面板；表 Data 页签默认显示 `filter:` 行（SQL 条件） |
| SQL 结果可编辑 | 单表查询的结果网格同样带 Save / Insert / Duplicate / Delete 工具按钮 |
| 导出 | 工具栏 Export → Export Grid 向导共 4 步：① 格式 CSV / HTML / TXT / SQL / XML / Excel / JSON、编码、日期/时间/数字/布尔格式、BLOB/CLOB 处理、NULL 文本 `(null)`、引号规则、Max Rows、列分隔符（默认 TAB）、行分隔符、Include Column Names ② 列：Export Name / Label / Type / Is Text / Text Function ③ 前 100 行预览 ④ 目的地：File（记住上次路径）、SQL Commander（New Editor / At Caret / First / Last / Replace All）、Clipboard。导出到 Clipboard 得到表头 + 200 行 TSV，主窗口没有完成提示。Settings… 用于保存/加载导出设置 |
| 取消长查询 | `select sleep(30)` 执行中，Log 显示 `Executing...`。SQL Commander → Stop（菜单项，工具栏也有 Stop；快捷键未采到）。约 20.9 s 时结束（Stop 在约 3 s 时点击，返回耗时待复核）。Log：`FAILED [Code: 1317, SQL State: 70100] Query execution was interrupted` + `STOPPED Execution interrupted` + `FINISHED Failed: 1` |
| 断线恢复 | 同一会话内 `kill connection connection_id()` 之后，下一条语句失败：`[Code: 0, SQL State: 08S01] Communications link failure`，其后语句不再执行。再执行任意语句时，**自动获取新物理连接**（Log 中 `INFO Physical database connection acquired for …`），新连接 id 不同。未提交计数被静默清零，没有提示原会话和事务已丢失 |

取长提示：DbVisualizer 的事务保护（状态栏计数 + 执行后/关闭前提示）和错误日志表格比较完整。数据编辑保存没有预览，这一点应取 DBeaver 的做法（待 DBeaver 实测确认）。

## 边界与复用

- 可复用：菜单/工具栏/右键入口的存在与层级；主窗口分区与状态栏字段；上表的快捷键与场景观察（Windows、MariaDB 12.1.2、Development 连接类型）。
- 未观测：Stop 的快捷键与精确响应时间、导出到文件的完成反馈、网络层断线（非服务端 KILL）、其他引擎（需要支持，采集延后）、Free 与 Pro 差异。Query Builder 与 Chart 已排除在目标之外，不再采集。
- 本机用户实例中保留了连接 `taomni-qa-mysql (parity test)`（已断开，保存了密码），供后续复用。
