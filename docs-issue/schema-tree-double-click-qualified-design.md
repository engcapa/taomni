# SchemaTree 双击对象未带库限定修复设计

## 1. 设计摘要与范围

| 项目 | 内容 |
|---|---|
| 问题类型 | 功能缺陷：多库连接中双击 SchemaTree 对象/搜索结果插入裸对象名，执行时解析到会话默认库而不是所点击对象所在库 |
| 文档位置 | `docs-issue/schema-tree-double-click-qualified-design.md` |
| 设计状态 | 可实施（DEC-01、DEC-02 已由用户确定，修复落点与验收契约明确） |
| 来源 | 2026-09-12 用户会话报告：“搜索表名之后想要查询这张表，多库的情况下 taomni 没有把库带过来”；同会话确认修复行为与范围。无 issue 链接、原始截图、日志或失败测试 |
| 调研基线 | 提交 `f539d79e289b519ba780ad9fdfcee8a74ba0c2af`，`package.json` 版本 `0.4.23`；2026-09-12；工作树干净；本轮未启动 Tauri/浏览器/原生自动化，未执行任何测试 |
| 平台与运行方式 | Windows、macOS、Linux 三端 Tauri 桌面应用，代码必须兼容三端构建与运行；browser 仅辅助测试 |
| 本轮真机执行端 | Windows（当前 win32 环境）；Linux、macOS 保留真机计划并标未验证 |
| 推荐方案 | `SchemaTree` 双击对象行时始终用现有 `qualifiedName(sqlEngine, target(db, obj.name))` 生成限定名再交给 `onInsertTable`；不新增 IPC、不改回调签名 |
| 实现与验证状态 | TASK-01~TASK-03 已完成：V-01~V-04 通过（`SchemaTree.test.tsx` 21 项、相邻回归 72 项、`pnpm build`）；V-05 在 Windows 用 QA 构建（`com.taomni.app.qa`，二进制 SHA `bc8b75c53cfe96218e9cc42d4b3188e06e9f2e2fe286cb4e53f0c0c488cdbf4e`）连接真实 MariaDB 10.1.5.52 通过；QA `audit --gate` 通过；V-06/V-07 其他端真机未验证 |

用户在习惯路径（SchemaTree 过滤框搜索表名 → 双击结果想查询该表）中遇到跨库解析错误：双击只插入裸表名，`SELECT * FROM orders` 落到当前默认库。本设计只修复双击插入的库/schema 限定，保证插入文本始终唯一指向所点击对象；不修改双击“插入而非执行”的既有交互，也不修复编辑器自动补全的跨库缺口（DEC-02）。

## 2. 当前实现与问题依据

### 2.1 关键源码事实

| 位置与符号 | 当前行为 / 契约 | 本次影响 | 依据与确定性 |
|---|---|---|---|
| `src/components/database/SchemaTree.tsx:960` `renderObjects` 对象行 `onDoubleClick` | `onInsertTable?.(obj.name)`，只传短名；行闭包内 `db`（所属 schema/database）可用却未使用 | 缺陷直接落点，拟修改 | 源码事实 |
| `src/components/database/SchemaTree.tsx:74-75` `SchemaTreeProps.onInsertTable` | 文档注释“inserts its name into the editor”，签名 `(table: string) => void` | 语义更新，签名不变 | 源码事实 |
| `src/components/database/SchemaTree.tsx:307-312` 过滤 effect | `filterActive` 时对 `schemas` 中每个库 `ensureTables(db)` | 启用搜索会同时加载所有库的表，跨库同名表并列展示，使缺陷路径高频出现 | 源码事实 |
| `src/components/database/SchemaTree.tsx:388` `target`、`:167` `sqlEngine`、`:34-62` 导入 | 组件内已有 `target(db, name) => { catalog, schema: db, name }` 与 `asSqlEngine(engine)`；尚未导入 `qualifiedName` | 修复可直接复用现成工具，无需新状态 | 源码事实 |
| `src/lib/sqlDialect.ts:59-78` `quoteIdent` / `qualifiedName` | MySQL/StarRocks/ClickHouse 用反引号，PostgreSQL/PanWeiDB/Oracle/Presto 用双引号，SQL Server 用 `[]`；Presto 在 catalog+schema 齐全时输出三段名 | 修复生成的名按引擎正确限定 | 源码事实；`src/lib/sqlDialect.test.ts:43-53` 已覆盖 |
| `src/components/database/DbClientTab.tsx:1627-1632` `insertIntoActive`、`:2639` 绑定 | 把传入文本原样 `insertText` 到当前活动编辑器 | 双击文本由此进入编辑器；修复只需改输入内容 | 源码事实 |
| `src/components/database/DbClientTab.tsx:1634-1646` `quickSelect`、`:1648-1661` 选中对象 | 右键 “Open (browse data)” 用 `{catalog, schema: db, name}` 生成限定 `SELECT`；选中对象上报含 catalog/schema | 既有正确路径，作为修复一致性参照，不改动 | 源码事实 |
| `src/components/database/SchemaTree.tsx:466-480` `insertDml`、`:530-539` `insertSelectedSelects`、`:760,770` `callStatement/functionCallStatement` | 右键 “Insert SELECT/INSERT/UPDATE/DELETE”、批量插入与 Copy call/function 全部经 `target(db, name)` 生成限定语句 | 必须保持；证明缺陷仅限双击短名 | 源码事实 |
| `src/components/database/SchemaTree.tsx:1005` 列行 `onDoubleClick` | `columnReference(sqlEngine, col.name)`，仅插入列引用 | 保持裸列名行为，不参与限定 | 源码事实 |
| `src/components/database/SchemaTree.tsx:932-988` `renderObjects` 覆盖全部对象种类 | table/view/materialized_view/procedure/function/trigger/event/sequence/dictionary 共用同一行渲染与双击处理器 | 修复会统一作用于所有对象种类，验收需覆盖例程对象 | 源码事实 |
| `src/components/database/HBaseSchemaTree.tsx:331` | HBase 双击调用 `scanStatement(full, …)`，一直使用 namespace 限定全名 | 同产品既有正确模式；本次不改 HBase | 源码事实 |
| `src-tauri/src/database/mod.rs:200-209` `TableInfo`（前端 `DbTable`） | 只有 `name/kind/rowCount`，无 schema/catalog 字段 | 后端搜索结果本身不带库；因此修复不能依赖结果模型，必须用树行的 `db` | 源码事实 |
| `src/lib/sqlMetadataCompletions.ts:826-849` 关系补全、`:305-327` `identifierOption/tableOptions` | 只搜索 `activeSchema`，且 apply 为裸标识符 | 已知相邻缺口；按 DEC-02 不在本次范围，作为独立问题保留 | 源码事实 |
| `src/components/database/SchemaTree.test.tsx` | 覆盖过滤、选中、右键菜单，无任何双击插入断言 | 缺陷无现有测试保护，修复需补回归用例 | 源码事实 |

未发现其他双击、键盘或拖拽入口会从树向编辑器插入对象短名：`onInsertTable` 的全部调用点（`760,770,886,887,960,1005`）中只有 `960` 传短名。

### 2.2 复现与根因

- 预期 / 实际：在 MySQL 连接默认库 `main`、库 `sales` 也存在 `orders` 时，搜索 `orders` 并双击 `sales` 下的结果，编辑器应插入能唯一指向 `sales.orders` 的引用；实际插入 `orders`，随后 `SELECT * FROM orders` 解析到 `main`，静默查错表或报 “table doesn't exist”。
- 复现环境、步骤和频率（用户报告，本轮未执行）：多库连接（MySQL/StarRocks/ClickHouse 等 schema 即 database 的引擎）→ 在 `schema-tree-filter` 输入表名 → 双击非默认库下的结果 → 在编辑器执行查询。满足“所点对象所属库 ≠ 当前默认库”时确定性触发（100%）；默认库存在同名表时静默取错表，否则报错。原问题发生的具体版本、连接配置与截图未提供。
- 已有证据：`SchemaTree.tsx:960` 丢弃 `db`；`DbClientTab.tsx:1627-1632` 原样插入；右键路径 `quickSelect/insertDml` 生成限定名，形成同一行两种行为不一致；`SchemaTree.test.tsx` 无双击覆盖。无失败测试或日志。
- 因果链：过滤搜索加载所有库表（`SchemaTree.tsx:307-312`）→ 结果行闭包持有 `db` → 双击只取 `obj.name`（`:960`）→ 编辑器得到短名 → `db_execute` 原样执行 → 引擎按会话默认 schema 解析 → 用户查询到错误库或收到不存在错误。
- 根因状态：源码事实直接可证，因果链无分支；用户可见复现未在本轮执行，由 §8 V-05 在 Windows 真机完成。
- 回归要求：原实现在“非默认库结果双击”处失败；修复后同一动作插入完整限定名并可在真实连接中查到正确数据，同时同库双击、列双击与全部右键语句生成行为保持。

## 3. 修复验收与保持的行为

| ID | 场景与前置条件 | 用户动作或触发 | 必须观察到的结果 | 适用平台 / 边界 |
|---|---|---|---|---|
| AC-01 | MySQL 连接，默认库 `main`，库 `sales` 下存在 `orders`；打开 SchemaTree | 过滤框输入 `orders`，双击 `sales` 分组下的 `orders` | 编辑器插入 `` `sales`.`orders` ``（含限定，无裸名）；补 `SELECT * FROM ` 执行后返回 `sales.orders` 数据 | 三端；原问题场景 |
| AC-02 | 默认库为 `sales`，双击 `sales` 自己的 `orders` | 双击同库表 | 仍插入 `` `sales`.`orders` ``（DEC-01 始终限定），不出现裸名 | 三端；DEC-01 |
| AC-03 | Presto 连接带 catalog，或 PostgreSQL/PanWeiDB、SQL Server、ClickHouse 连接 | 双击任意库/schema 下的表 | 限定形式与引擎一致：Presto `"catalog"."schema"."table"`，PG/PanWeiDB `"schema"."table"`，SQL Server `[schema].[table]`，ClickHouse/StarRocks/MySQL 反引号 | 三端；引号与引擎分支 |
| AC-04 | 任一双击路径 | 双击表列（展开后的列行） | 仍只插入列引用（如 `` `id` ``），不附加表/库限定 | 三端；保持既有行为 |
| AC-05 | 任一双击路径 | 双击 procedure/function/trigger 等对象行；对照右键 “Insert SELECT statement to editor”“Open (browse data)”“Insert SELECT statements (n)” | 对象行也插入带 schema 的限定名；右键菜单生成语句与批量插入结果保持原限定行为不变 | 三端；共用 `renderObjects` 的边界 |
| AC-06 | 任一双击路径 | 单击选中、展开/折叠、过滤、Escape 清空过滤 | 选中上报（含 schema）、展开与列加载、过滤结果和行数徽标不变；双击不再产生额外副作用 | 三端；相邻回归 |

## 4. 修复方案与关键决策

修复落在 `SchemaTree.renderObjects` 的双击处理器：把 `onInsertTable?.(obj.name)` 改为 `onInsertTable?.(qualifiedName(sqlEngine, target(db, obj.name)))`，并在 `sqlDialect` 导入列表中增加 `qualifiedName`。同时更新 `SchemaTreeProps.onInsertTable` 的 JSDoc，说明传入的是带库/schema 限定的引用。

选择理由：

1. 限定所需信息（`db`、`catalog`、`sqlEngine`）全部已在行闭包或组件作用域内，无需改状态、接口、IPC 或后端。
2. `qualifiedName` 是 SchemaTree 右键菜单、`DbClientTab.quickSelect` 已在使用的既有方言工具，且已有单测覆盖；复用可保证双击与右键输出一致。
3. `onInsertTable` 保持“插入任意文本”的既有契约，6 个调用点中只有双击需要改变，避免改签名影响 `copyCall`、列引用等路径。
4. 对所有对象种类统一限定（AC-05），与 HBase 树使用全名的既有模式一致；不引入按 kind 分支的额外复杂度。

备选及未采用：改 `onInsertTable` 签名为 `(schema, name)` 让 `DbClientTab` 生成文本，会波及 5 个不相关调用点，收益不足；让双击直接执行 `quickSelect` 改变了既有交互语义，已被 DEC-01 排除。

### 决策记录

| DEC ID / 问题 | 可行选项、影响与代价 | 结论或待决推荐及理由 | 状态 | 决策来源 | 关联 AC / TASK / V |
|---|---|---|---|---|---|
| DEC-01 双击插入的限定策略 | A 始终带库/schema；B 仅当对象库 ≠ 活动库时带库；C 双击直接执行 browse data | 选 A：任何情况下都唯一解析到所点击对象，与右键 Insert SELECT 一致，且不受编辑器内手动 `USE` 与 `activeSchema` 状态不一致影响；代价是同库 SQL 也变为限定名 | 用户已定 | 用户 2026-09-12 会话答复（选项“始终带库/schema（推荐）”） | AC-01/02/03/05；TASK-01；V-01/02/05 |
| DEC-02 修复范围 | A 只修 SchemaTree 双击；B 同时修 SQL 编辑器补全跨库搜索与限定回填 | 选 A：聚焦本次因果链；补全缺口（`sqlMetadataCompletions.ts:826-849` 只搜 activeSchema）作为独立问题另立文档，避免扩大范围 | 用户已定 | 用户 2026-09-12 会话答复（选项“只修 SchemaTree 双击（推荐）”） | 范围约束；AC-04/06 保持补全行为不变；TASK-01/02 |

### 用户流程与交互

本次不改变布局、信息结构或主流程，只改变双击后写入编辑器的文本内容，不需要原型/示意图。

| 当前状态 | 动作或事件 | 前置条件 | 下一状态与可见反馈 | 失败 / 取消处理 |
|---|---|---|---|---|
| 树已加载，编辑器聚焦 | 双击对象行 | `onInsertTable` 已绑定 | 光标处插入限定名（如 `` `sales`.`orders` ``），无 toast、无自动执行 | `onInsertTable` 未提供时不动作；与现状一致 |
| 过滤搜索中 | 双击匹配结果 | `filterActive`，跨库表已加载 | 同上，且插入名字带该结果所属库 | 过滤清空后行为不变 |
| 表格已展开列 | 双击列行 | 列已加载 | 插入裸列引用，不带表/库 | 与现状一致 |

### 数据流、状态与生命周期

`schemas`/`tablesByDb` 由 `dbListSchemas`/`dbListTables` 加载，`db` 参数来自树行所属分组，是所点击对象的权威库名；`catalog` 来自 `DbClientTab` 传入的连接信息（Presto 用）；`sqlEngine` 由 `engine` prop 解析。双击是同步事件，生成字符串后调用 `DbClientTab.insertIntoActive` 写入当前活动编辑器句柄，无网络、无持久化、无异步时序。本次不新增状态或副作用。

### 接口与共享契约

| 类型 / 名称（现有或拟新增） | 调用方 → 实现方 | 输入及序列化 | 输出 / 错误 / 事件 | 兼容规则 |
|---|---|---|---|---|
| `SchemaTreeProps.onInsertTable` | `DbClientTab.tsx:2639` → `SchemaTree.tsx:74` | 不变：`(table: string) => void` | 不变；传入内容语义变为“带库限定的引用” | 无其他消费者；无需改调用方 |
| `qualifiedName(engine, target)`（现有） | `SchemaTree.tsx` → `src/lib/sqlDialect.ts:70` | `ObjectTarget { catalog?, schema?, name }` | 按引擎引号拼接的限定名 | 已在 `quickSelect/insertDml` 使用并有测试；本次新增双击调用 |
| `ipc` / Rust 命令 | — | — | — | 本次无变更；双击不触发 IPC |

### 三端兼容与相关存储、故障边界

纯 renderer 的 TypeScript 改动：不涉及 Rust、条件编译、平台 API、路径、权限或 WebView 分支；`quoteIdent/qualifiedName` 已按引擎处理方言且已跨三端使用。三端构建与运行不受影响，无需迁移或存储变更。浏览器模式下 `SchemaTree` 通过 mock 的 `lib/ipc` 工作，双击处理器为真实组件逻辑，Vitest 可完整覆盖；原生证据仍需 §8。

## 5. 改动清单

| 路径 / 模块（标注拟新增） | 具体变更与保持的约束 | 相关 AC | 所属任务 |
|---|---|---|---|
| `src/components/database/SchemaTree.tsx` | 导入 `qualifiedName`；双击改为 `onInsertTable?.(qualifiedName(sqlEngine, target(db, obj.name)))`；更新 JSDoc；对象行新增自动化钩子 `data-testid="schema-tree-object"` 与 `data-schema`/`data-object-name`/`data-object-kind`。不得改动右键语句生成 | AC-01~06 | TASK-01/TASK-03 |
| `src/components/database/SchemaTree.test.tsx` | 已新增双击用例：跨库 MySQL 限定、同库限定、Presto/SQLServer/PG 引号形式、列双击回归、例程对象限定 | AC-01~05 | TASK-01 |
| `qa-ui-auto-tests/feature-list.md` | F-DB-1 注册 `schema-tree-filter`、`schema-tree-object` 控件，并在功能描述中记录双击限定行为 | AC-01/02 | TASK-03 |
| `.agents/skills/qa-ui-auto/references/testid-catalog.md` | 控件变更后重新生成并通过 `--check` | AC-01/02 | TASK-03 |
| `qa-ui-auto-tests/cases/auto/TC-auto-F-DB-1-schema-tree-double-click-qualified-native.testcase.yaml` | 已新增原生用例并实跑通过：真实 MariaDB 上过滤 `TABLES`、双击 `information_schema.TABLES`、断言限定名并执行 | AC-01/02/03/05/06 | TASK-02/TASK-03 |

无需改动：`DbClientTab.tsx`、`sqlDialect.ts`、`sqlMetadataCompletions.ts`、`src/lib/ipc.ts`、`src-tauri/**`、i18n 文案。

## 6. 实现任务与交接

### TASK-01 修复双击限定并补齐单测

- 职责与文件范围：`src/components/database/SchemaTree.tsx`、`src/components/database/SchemaTree.test.tsx`。
- 输入与必读：本设计 §2、§3、§4；`sqlDialect.ts` 的 `target/qualifiedName` 现有实现；`SchemaTree.test.tsx` 的 mock 结构（`ipcMock`、过滤用例）。
- 依赖：无前置任务；DEC-01 已定。
- 实施内容：按 §5 修改双击处理器与 JSDoc；在测试中通过 `dbListSchemas`/`dbListTables` mock 提供两个库与跨库同名/异名表，用 `fireEvent.doubleClick` 断言 `onInsertTable` 收到限定名；覆盖 MySQL、Presto（带 catalog）、SQL Server 引号形式，以及列双击仍为裸列引用。
- 对应验收：AC-01~AC-06。
- 验证与完成条件：V-01~V-04 通过；`pnpm test src/components/database/SchemaTree.test.tsx` 与 `pnpm build` 无失败；测试文件不得只断言调用次数而缺少限定名内容断言。
- 并行与集成：仅动 SchemaTree 两个文件，无共享文件冲突；由本任务完成集成。
- 状态：已完成（2026-09-12）；实现与验证证据见 §7。

### TASK-02 Windows 真机复测与证据回填

- 职责与文件范围：按 §8 使用隔离 QA 构建与隔离 MySQL 实例执行 V-05；回填证据路径与结果到本设计 §9。
- 输入与必读：§7 命令、§8 环境准备；`qa-ui-auto-tests/native/README.md` 与 `runbooks/run-native-windows.ps1`；`.agents/skills/qa-ui-auto/references/native-testing.md`。
- 依赖：TASK-01 实现完成并在本地通过 V-01~V-04；隔离 MySQL fixture 就绪。
- 实施内容：构建 QA 应用；用两个隔离数据库复现原路径并验证 AC-01/02/03（MySQL 形式）；记录版本、二进制路径、命令、截图与实际结果。
- 对应验收：AC-01、AC-02、AC-03（MySQL 限定形式）。
- 验证与完成条件：V-05 通过并附截图；无法执行时写明缺口、受影响 AC、接续环境与替代路径，不得以浏览器结果冒充。
- 并行与集成：与 TASK-01 串行；Linux/macOS 计划由本任务记录为未验证并保留步骤。
- 状态：已完成（2026-09-12，Windows）；证据见 §7 V-05 与 §8。

### TASK-03（条件性）QA 原生自动化用例

- 职责与文件范围：`qa-ui-auto-tests/feature-list.md`（F-DB-1 controls）、`qa-ui-auto-tests/cases/auto/`；仅在确认存在两个数据库的 QA fixture 且新增测试 selector 被接受时执行。
- 输入与必读：`authoring.md`、`verb-catalog.md`、现有 `TC-auto-F-DB-1-query-tab-rename-native.testcase.yaml` 的连接方式。
- 依赖：TASK-01；fixture 检查结果；解除条件为“隔离 MySQL 存在至少两个库”。
- 实施内容：先做只读检查（如 `SHOW DATABASES`）确认 fixture；为对象行补充稳定 `data-testid`（命名与 `schema-tree-db-name-*` 一致的拟新增项）并更新 controls；编写 `covers: [F-DB-1]` 的 `[native]` 用例，断言双击后编辑器出现限定名并可执行。fixture 不满足时记录 skip 原因，不伪造用例通过。
- 对应验收：AC-01、AC-02。
- 验证与完成条件：用例实际运行通过并回填 receipt；否则在 §9/§10 记录未验证与原因。
- 并行与集成：可独立于 TASK-02 进行，但共享 MySQL fixture 时须串行并指定协调人（默认 TASK-02 负责人）。
- 状态：已完成（2026-09-12）；未创建额外数据库 fixture，改用真实服务器已有的 `test`（默认库）与 `information_schema`（另一库）完成跨库场景；`audit --gate` 通过。

## 7. 自动化测试计划

V-01~V-04 已于 2026-09-12 在 Windows 执行并通过（见下方记录）；V-05~V-07 真机项仍待执行，不得由自动化结果代替。

| V ID | AC | 层级与文件 / case（标注拟新增） | 前置数据与操作 | 核心断言 | 命令、工作目录与前置依赖 | 状态 |
|---|---|---|---|---|---|---|
| V-01 | AC-01、AC-02 | Vitest，`src/components/database/SchemaTree.test.tsx`（已新增） | mock 两个 schema：`main`（同有 orders）与 `sales`（orders）；渲染 SchemaTree（MySQL，activeSchema=main）；过滤 `orders` 后在 `sales` 区块内 `fireEvent.doubleClick`；再以 activeSchema=sales 双击同库表 | `onInsertTable` 分别收到 `` `sales`.`orders` `` 与 `` `sales`.`orders` ``（始终限定） | `pnpm test src/components/database/SchemaTree.test.tsx`；仓库根目录；依赖已安装 | 通过（2026-09-12） |
| V-02 | AC-03 | Vitest，同文件（已新增） | 以 Presto（catalog=hive）、PostgreSQL、SQLServer 渲染并双击 | 分别收到 `"hive"."ecommerce"."orders"`、`"ecommerce"."orders"`、`[ecommerce].[orders]` | 同上 | 通过（2026-09-12） |
| V-03 | AC-04、AC-05 | Vitest，同文件（已新增） | 展开表后双击列 `id`；双击 `sp_sync` 例程行；既有右键菜单用例同批回归 | 列双击收到 `` `id` ``（无库限定）；例程收到 `` `ecommerce`.`sp_sync` ``；右键 “Insert SELECT statement to editor” 输出保持 `` `ecommerce`.`orders` `` 形式 | 同上 | 通过（2026-09-12） |
| V-04 | 全部 AC | 类型检查与构建 | 修改完成后全量编译 | `tsc -b && vite build` 无类型错误 | `pnpm build`；仓库根目录 | 通过（2026-09-12） |
| V-05 | AC-01/02/03、AC-05/06 | 原生真机，Windows；`TC-auto-F-DB-1-schema-tree-double-click-qualified-native`（已新增） | QA 构建 `com.taomni.app.qa` + 真实 MariaDB 10.1.5.52：默认库 `test`，过滤 `TABLES`，双击 `information_schema.TABLES` | 编辑器出现 `` `information_schema`.`TABLES` ``；执行 `SELECT COUNT(*) FROM ...` 返回结果网格（1 行，COUNT=115） | `python -m qa_ui_auto.runner --mode native --require-pass --filter TC-auto-F-DB-1-schema-tree-double-click-qualified-native --config qa-ui-auto-tests/qa-ui-auto.config.yaml`；仓库根目录 | 通过（2026-09-12） |
| V-06 | AC-01~06 | 原生真机，Linux | 同 V-05 步骤 + Linux runbook | 同 V-05 预期 | `qa-ui-auto-tests/native/runbooks/run-native-linux.sh` | 待执行（未验证） |
| V-07 | AC-01~06 | 原生真机，macOS | 同 V-05 步骤 + macOS runbook | 同 V-05 预期 | `qa-ui-auto-tests/native/runbooks/run-native-macos.sh` | 待执行（未验证） |

V-01~V-05 已执行并通过（V-05 为 Windows 真机）、TASK-03 用例与 catalog 校验通过；V-06/V-07 其他端真机待执行/未验证。已执行记录（2026-09-12，Windows、提交基线 `f539d79e` + 本轮未提交改动）：

- V-01~V-03：`pnpm test src/components/database/SchemaTree.test.tsx`，仓库根目录，输出 `Test Files 1 passed (1)`、`Tests 21 passed (21)`（原有 15 项 + 新增 6 项），退出码 0。
- 相邻回归（AC-04/06 相关）：`pnpm test src/components/database/DbClientTab.test.tsx src/lib/sqlDialect.test.ts src/lib/sqlMetadataCompletions.test.ts`，输出 `Test Files 3 passed (3)`、`Tests 72 passed (72)`，退出码 0。
- V-04：`pnpm build`（`tsc -b && vite build`）成功，无类型错误（首次记录 45.00s；加入对象行测试钩子后复跑 37.18s），退出码 0。
- V-05：`native_build.py` 构建 QA 应用（身份 `com.taomni.app.qa`，最终二进制 SHA `bc8b75c53cfe96218e9cc42d4b3188e06e9f2e2fe286cb4e53f0c0c488cdbf4e`），运行上述原生用例，输出 `1 passed, 0 failed, 0 skipped`；产物 `qa-ui-auto-report/run-20260912-180744-006477800/`（editor/result 截图，结果 COUNT=115）。加入对象行测试钩子前的同用例运行 `run-20260912-175833-827562500` 亦通过。
- QA catalog：`python -m qa_ui_auto.gen_testid_catalog`（含 `--check`）与 `python -m qa_ui_auto.audit --gate` 均通过（orphans 0）。

说明：V-01~V-03 使用 mock 的 `lib/ipc`，只证明渲染层插入文本与树交互；真实解析正确性由 V-05 在真实 MariaDB 上证明。`sqlDialect.test.ts:43-53` 已覆盖 `qualifiedName` 引号行为，本次不重复实现，仅通过 SchemaTree 用例证明接线正确。

## 8. 真机验证手册

### 环境与准备

三端统一前置：QA 应用由 `python .agents/skills/qa-ui-auto/scripts/native_build.py` 构建并校验 `com.taomni.app.qa` 身份（勿用生产二进制）；真实数据库使用既有测试服务器 10.1.5.52 MariaDB，密码仅经环境变量 `TAOMNI_TEST_MYSQL_PASSWORD` 传入，不写入仓库或文档；不创建/删除数据库——默认库为 `test`，跨库对象借用只读的 `information_schema.TABLES`（`test` 账号无其他库权限，实测 `SHOW DATABASES` 仅 `information_schema` 与 `test`）。原生运行前须让 QA profile 处于可首次建库状态；本轮实测该应用未采用 harness 的 run-owned `APPDATA`/`LOCALAPPDATA` 重定向（run 目录下 `native-appdata` 为空），因此运行前把 `%APPDATA%\com.taomni.app.qa\{vault,taomni,notes}.db` 移至临时备份，全程未触碰生产 `com.taomni.app`。

- Windows（本轮已执行）：Windows 11 + WebView2 + `tauri-driver` + msedgedriver（`qa-ui-auto-tests/qa-ui-auto.config.yaml` 指向 `C:/Users/yuhan/AppData/Local/TaomniQA/bin/msedgedriver.exe`）。
- Linux（未验证）：X11/Xvfb + WebKitGTK + `tauri-driver`；按 `run-native-linux.sh`。
- macOS（未验证）：无 Tauri WebDriver，使用可用 OS 自动化或录屏手工 QA，核对 bundle id 为 QA 值。

### V-05 Windows 真实桌面验证

- 对应验收：AC-01、AC-02、AC-03（MySQL 限定形式）、AC-05/06 相邻核对。
- 执行前状态：QA 构建完成且身份记录匹配（最终 SHA 见下）；QA profile 的 vault/session 已备份清空；`TAOMNI_TEST_MYSQL_PASSWORD` 已设置；端口 4444/4445 空闲。
- 操作与逐步预期（由 `TC-auto-F-DB-1-schema-tree-double-click-qualified-native` 真实执行）：
  1. 新建 MySQL 会话，默认数据库 `test`，保存到 vault 并打开；`db-connection-error-banner` 不出现，`schema-tree` 挂载。
  2. 展开折叠的 schema 抽屉（`db-schema-drawer-handle`）。
  3. 在 `schema-tree-filter` 输入 `TABLES`，等待 `information_schema` 分组的 `TABLES` 行出现（`test` 库无同名表）。
  4. 双击该行；`eval_readonly` 读取 `.cm-content`，断言编辑器出现 `` `information_schema`.`TABLES` `` 而非裸名；截图 `schema-tree-double-click-qualified-editor.png`。
  5. `Control+a` 后输入 `SELECT COUNT(*) FROM \`information_schema\`.\`TABLES\`;`，点 `db-run-current-statement`，等待 `query-result-grid`；结果 1 行 COUNT=115 与直接查询一致；截图 `schema-tree-double-click-qualified-result.png`。
- 原问题复测：原实现双击只插入裸 `TABLES`，第 4 步断言即失败，且 `SELECT COUNT(*) FROM TABLES` 在 `test` 库报 1146；修复后限定名通过断言并真实执行。
- 故障与恢复：连接失败时检查网络与 QA 日志，不重置生产配置；错误横幅可重试。若再次运行遇到已存在的加锁 vault，需先备份并清空 QA profile 的 `vault.db`（`vault_first_run` 会拒绝未知主密码）。
- 证据：`qa-ui-auto-report/run-20260912-180744-006477800/TC-auto-F-DB-1-schema-tree-double-click-qualified-native/` 下 editor/result 截图与 `summary.json`；二进制 `src-tauri/target/qa-ui-auto/debug/taomni.exe`，SHA `bc8b75c53cfe96218e9cc42d4b3188e06e9f2e2fe286cb4e53f0c0c488cdbf4e`；用例结果 `1 passed, 0 failed, 0 skipped`。加入对象行测试钩子前的运行 `run-20260912-175833-827562500` 同样通过。
- 清理：本轮未创建数据库或容器；QA profile 旧状态备份保留在系统临时目录，未删除生产 profile。
- 状态：通过（2026-09-12，Windows）。

### V-06 Linux / V-07 macOS

- 对应验收：AC-01~AC-06。
- 执行前状态与操作：沿用 V-05 步骤与隔离资源，按各自 runbook 启动。
- 预期：与 V-05 相同；macOS 记录手工 QA 录屏与 bundle id。
- 原问题复测：若原报告发生在 Windows 以外的平台，本端仅能证明当前端；原端触发保持未验证并保留步骤。
- 状态：待执行（未验证）；缺设备不阻塞本轮，但不得由 Windows 结果推导通过。

## 9. 验收追踪与交付条件

| AC | 方案位置 | 开发任务 | 验证项与平台 | 所需证据 / 实际证据链接 | 当前缺口 |
|---|---|---|---|---|---|
| AC-01 | §4、§5 | TASK-01/02/03（已完成） | V-01（Vitest，通过）、V-05（Windows，通过） | 已生成：Vitest 跨库案例；原生用例 `TC-auto-F-DB-1-schema-tree-double-click-qualified-native` 与截图 `qa-ui-auto-report/run-20260912-180744-006477800/...editor.png`、`...result.png`；SHA `bc8b75c5…` | 已通过；其他端真机未验证 |
| AC-02 | §4、DEC-01 | TASK-01（已完成） | V-01（通过）、V-05（通过，同库双击策略由实现与 Vitest 证明） | 已生成：同库限定 Vitest 案例 + 原生用例断言 | 已通过；其他端真机未验证 |
| AC-03 | §4 | TASK-01/02（已完成） | V-02（通过）、V-05（MySQL 形式通过） | 已生成：Presto/PostgreSQL/SQLServer 引号 Vitest 案例；原生 MySQL 反引号形式截图 | 已通过；其他引擎原生未验证 |
| AC-04 | §2.1、§4 | TASK-01（已完成） | V-03（通过） | 已生成：列双击不出库限定 Vitest 案例 | 自动化已通过 |
| AC-05 | §2.1、§4 | TASK-01（已完成） | V-03（通过）、V-05（真实执行同一限定语义） | 已生成：例程限定 Vitest 案例 + 右键菜单回归；原生用例对照右键插入的限定形式 | 自动化已通过；例程/右键真机未单独执行 |
| AC-06 | §3 | TASK-01/02（已完成） | V-03（通过）、V-05（通过） | 已生成：原有 SchemaTree 15 项 + 相邻 72 项回归通过；原生用例含连接/树加载/结果网格回归断言 | 自动化与 Windows 原生已通过；其他端未验证 |

交付条件：三端代码兼容检查（本改动无平台分支，结论为三端一致）、V-01~V-04 自动化已通过、Windows V-05 真机已通过并留证、QA catalog `audit --gate` 已通过。Linux/macOS 未执行时保持“未验证”及 V-06/V-07 步骤，不阻塞本轮交付；只有三端都有实际通过证据时才能报告“三端真机验证通过”。

## 10. 风险、未决项与回退

| 项目 | 影响与依据 | 建议 / 缓解 / 最小验证 | 阻塞的具体任务 | 解除条件 |
|---|---|---|---|---|
| 编辑器补全仍不支持跨库 | DEC-02 已排除；`sqlMetadataCompletions.ts:826-849` 只搜 activeSchema，用户在编辑器输入 `FROM ` 时仍找不到其他库的表 | 作为独立 issue 立项；本设计不做兼容承诺 | 不阻塞本设计任务 | 另行决策 |
| QA 测试账号只有 `information_schema` 与 `test` | 2026-09-12 实测 10.1.5.52 的 `test` 账号无其他库权限、不能建库 | 改用只读的 `information_schema.TABLES` 作为跨库对象，未写入共享服务器；无需 fixture 创建 | 不阻塞 | 已解除 |
| 原生 harness 的 APPDATA/LOCALAPPDATA 重定向未生效 | run 目录 `native-appdata` 为空，QA 应用读写真实 `%APPDATA%\com.taomni.app.qa`（QA 专属，非生产） | 运行前备份/清空 QA profile 的 vault/session；不要依赖 run-owned profile 做隔离；如需真正隔离需另行修复 harness 或应用路径行为 | 不阻塞本次；影响其他 Windows 原生用例的隔离性 | 另行立项 |
| 同库场景 SQL 变为限定名 | DEC-01 已接受；用户可能感觉更冗长 | 限定名在全部目标引擎均合法；无功能回归 | 不阻塞 | — |
| 特殊标识符（含引号/点号） | 短名与限定名都可能受引号影响 | `quoteIdent` 已转义并被 `sqlDialect.test.ts:43-53` 覆盖，无需新逻辑 | 不阻塞 | — |
| 插入后编辑器状态 | 双击仍会先触发两次单击的选中/展开副作用 | 既有行为，不在本次范围；V-03 回归确认选中/展开不变 | 不阻塞 | — |

本轮实现与验证边界：TASK-01~TASK-03 已完成；V-01~V-05 通过，证据见 §7/§8/§9。V-06/V-07 其他端真机未执行（记录步骤与未验证状态），不得由 Windows 结果推导通过，也不单独阻塞本轮交付。

回退：改动为双击处理器一行、一处 import 与对象行测试钩子属性；回退即恢复 `onInsertTable?.(obj.name)` 并移除 `data-testid`/`data-*` 属性，同步撤回用例与控件注册；无数据、接口或持久化影响，无需迁移。

当前状态：实现与当前端（Windows）验证完成，问题在本轮修复范围内已确认修复；其他端真机待 V-06/V-07，Linux/macOS 未验证。
