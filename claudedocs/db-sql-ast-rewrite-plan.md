# DB Result SQL AST Rewrite Plan

**状态**: 计划
**日期**: 2026-07-06
**分支**: `feat/db-result-query-filters`
**目标**: 用 AST 驱动 DB query result 过滤/排序回写,替代当前手写顶层关键字扫描的窄判定,尽量保留原 SQL 文本风格,并同步梳理 SQL 格式化方案。

## 背景

当前 `QueryResultGrid` 支持在结果表格上做本地过滤/排序,点击 `Query` 后生成新的 SQL 并回写到来源 query 语句。现有实现没有走 AST parser,而是手写扫描顶层关键字:

- `topLevelSqlClauses()` 扫描 `SELECT/FROM/WHERE/GROUP BY/HAVING/ORDER BY/LIMIT/OFFSET/FETCH/FOR/UNION/INTERSECT/EXCEPT`。
- `tryBuildInlineResultSql()` 只接受很窄的简单查询:
  - SQL 去掉结尾分号后必须以 `SELECT` 开头。
  - 顶层必须有 `SELECT` 和 `FROM`。
  - 顶层不能有 `UNION/INTERSECT/EXCEPT/GROUP BY/HAVING`。
  - select list 必须包含顶层 `*`。
- 不满足时走 fallback:
  `SELECT * FROM (<source>) AS taomni_result WHERE ... ORDER BY ...`。

这个规则导致一些实际可以安全原位改写的 SQL 被包裹,例如:

```sql
SELECT id, name, status
FROM users
WHERE deleted = 0
LIMIT 1000;
```

因为 select list 没有 `*`,当前会被判为复杂 SQL。SchemaTree 的 `Insert SELECT` 默认按列清单生成 SQL,因此这类路径会高频触发包裹。

## 设计原则

1. **AST 用于理解结构,文本 patch 用于保留原文**  
   不默认把 AST 重新序列化成完整 SQL,避免丢注释、改大小写、改缩进、重排表达式。

2. **保守、安全、可解释**  
   只有当 parser 能确认结果列能映射回来源表达式/列引用时才原位改写;否则继续使用 derived SQL fallback。

3. **方言优先,通用兜底**  
   每个数据库 engine 绑定最接近的 parser dialect。parser 不支持某些专有语法时,保留当前 fallback 行为。

4. **改写和格式化解耦**  
   SQL rewrite 关注语义和最小 patch;SQL format 是单独用户动作,不在 `Query` 隐式触发。

5. **测试先行**  
   先把当前行为和目标行为写成矩阵测试,再替换实现,避免隐藏回归。

## 工具和库调研结论

### Parser 候选

#### `sqlparser-rs`

推荐作为 v1 主 parser。

- 语言/集成: Rust,适合 Tauri 后端直接嵌入。
- 能力: 解析 SQL 为 AST,支持多 dialect,包括 MySQL、PostgreSQL、MS SQL、Oracle、ClickHouse 等。
- 优点:
  - 无需引入 Node/Python runtime。
  - 和现有 Rust backend 边界一致。
  - AST 类型适合做结构判断。
- 主要风险:
  - 回写 SQL 时不能依赖完整 AST deparse 保留原文。
  - source span/source location 能力需要实测,不能假定所有节点都有稳定位置。

参考:

- https://github.com/apache/datafusion-sqlparser-rs
- https://docs.rs/sqlparser/latest/sqlparser/dialect/index.html

#### `pg_query.rs` / `libpg_query`

适合作为 PostgreSQL/PanWeiDB 的后续增强 parser。

- 语言/集成: Rust binding / C library。
- 能力: 使用 PostgreSQL server parser 解析,PostgreSQL 兼容性强。
- 优点:
  - 对 PG 方言准确度高。
  - 适合处理 PG 扩展语法。
- 风险:
  - AST 是 PostgreSQL 内部 parse tree,跨库复用性弱。
  - 不能作为全数据库通用方案。

参考:

- https://github.com/pganalyze/pg_query.rs
- https://github.com/pganalyze/libpg_query

#### `node-sql-parser`

不推荐作为默认主线,可作为前端实验/单测辅助。

- 语言/集成: TypeScript/JavaScript。
- 能力: SQL parse、AST、AST to SQL,支持多个数据库类型。
- 优点:
  - 前端使用方便。
  - AST to SQL 使用门槛低。
- 风险:
  - 官方定位偏 simple SQL parser,复杂方言覆盖需要验证。
  - 引入到前端 bundle 会增加体积。

参考:

- https://github.com/taozhi8833998/node-sql-parser

#### `dt-sql-parser`

适合作为 Presto/Trino、大数据 SQL 编辑能力的候选补充。

- 语言/集成: TypeScript,ANTLR4。
- 能力: 覆盖 MySQL、PostgreSQL、Spark、Flink、Hive、Trino 等。
- 优点:
  - 大数据 SQL 生态覆盖较好。
  - 可与编辑器语法能力结合。
- 风险:
  - 引入前端 bundle 的体积和复杂度较高。
  - 与 Rust 后端 rewrite 主线不一致。

参考:

- https://github.com/DTStack/dt-sql-parser

#### SQLGlot

不推荐作为内置默认依赖,但值得作为能力标杆。

- 语言/集成: Python。
- 能力: parser、AST、transpile、optimizer、formatter,支持大量 dialect。
- 优点:
  - 方言覆盖和转译能力很强。
  - 适合参考语义模型和测试样例。
- 风险:
  - Taomni 当前不是 Python runtime 架构。
  - 桌面端内置 Python 依赖成本较高。

参考:

- https://github.com/tobymao/sqlglot

### Formatter 候选

#### `sql-formatter`

推荐作为 v1 格式化主线。

- 语言/集成: TypeScript/JavaScript。
- 支持 dialect: MySQL、PostgreSQL、TSQL、PL/SQL、ClickHouse、Trino/Presto 等。
- 优点:
  - 前端集成成本低。
  - 和现有 `formatSql` 前端入口匹配。
  - 方言覆盖与 Taomni 当前 DB 类型较接近。
- 风险:
  - 只负责格式化,不应该承担 AST rewrite 语义判断。

参考:

- https://github.com/sql-formatter-org/sql-formatter

#### SQLFluff

适合作为未来高级 lint/format 外部工具,不建议 v1 内置。

- 语言/集成: Python/CLI。
- 能力: lint、format、dialect rules。
- 优点:
  - 规则体系完整。
  - 适合 CI 或高级用户自定义。
- 风险:
  - 内置桌面端依赖重。
  - 和现有 Tauri 打包模型不匹配。

参考:

- https://github.com/sqlfluff/sqlfluff

## 推荐架构

### v1 总体结构

```text
QueryResultGrid
  -> build result filter/sort request
  -> DbClientTab.onGeneratedSqlQuery
  -> invoke db_sql_rewrite_result_query
      -> Rust sql_rewrite module
          -> parser dialect selection
          -> AST analyze
          -> projection mapping
          -> minimal text patch
          -> fallback derived SQL
  -> replace source statement
  -> refresh current result sheet
```

### 模块建议

```text
src-tauri/src/database/sql_rewrite.rs
src-tauri/src/database/sql_rewrite/parser.rs
src-tauri/src/database/sql_rewrite/analyze.rs
src-tauri/src/database/sql_rewrite/patch.rs
src-tauri/src/database/sql_rewrite/dialect.rs
src-tauri/tests/sql_rewrite.rs

src/lib/sqlRewrite.ts
src/components/database/QueryResultGrid.tsx
src/components/database/DbClientTab.tsx
src/components/database/formatSql.ts
```

### IPC 建议

```ts
export interface DbResultSqlRewriteRequest {
  engine: string;
  sourceSql: string;
  resultColumns: string[];
  filters: DbResultSqlFilter[];
  sort: DbResultSqlSort | null;
}

export interface DbResultSqlRewriteResponse {
  sql: string;
  mode: "inline" | "derived";
  reason: string | null;
  warnings: string[];
}
```

Rust command:

```rust
#[tauri::command]
pub async fn db_rewrite_result_sql(
    engine: String,
    source_sql: String,
    result_columns: Vec<String>,
    filters: Vec<ResultSqlFilter>,
    sort: Option<ResultSqlSort>,
) -> Result<ResultSqlRewriteResponse, String>
```

### 方言映射

| Taomni engine | v1 parser dialect | 后续增强 |
| --- | --- | --- |
| MySQL | `MySqlDialect` | 处理 MySQL 专有 hints / backtick / limit |
| StarRocks | `MySqlDialect` | StarRocks 语法 adapter |
| PostgreSQL | `PostgreSqlDialect` | 可选 `pg_query.rs` |
| PanWeiDB | `PostgreSqlDialect` | 可选 `pg_query.rs`,按兼容性调 adapter |
| SQLServer | `MsSqlDialect` | TOP/OFFSET/FETCH 规则专项测试 |
| Oracle | `OracleDialect` | FETCH FIRST / ROWNUM 专项测试 |
| ClickHouse | `ClickHouseDialect` | PREWHERE/LIMIT BY/SAMPLE 后续支持 |
| Presto | `GenericDialect` 或最接近 dialect | 不足时评估 `dt-sql-parser`/ANTLR |

## AST 改写策略

### 可 inline 改写的基础条件

1. parser 成功。
2. 只包含一条 statement。
3. statement 是顶层 `SELECT` query。
4. 暂时拒绝:
   - `UNION`
   - `INTERSECT`
   - `EXCEPT`
   - `GROUP BY`
   - `HAVING`
   - `DISTINCT`
   - window output 参与过滤
   - CTE v1 可先拒绝
5. 顶层 `FROM` 存在。
6. 能建立 result column 到 source expression 的映射。

### Projection 映射

目标是把结果表列名映射回原 SQL 中可用于 `WHERE/ORDER BY` 的表达式。

示例 1: 纯列

```sql
SELECT id, name, status
FROM users
WHERE deleted = 0
LIMIT 1000;
```

映射:

```text
id     -> id
name   -> name
status -> status
```

对 `status = 'active'` 的结果过滤可改写为:

```sql
SELECT id, name, status
FROM users
WHERE deleted = 0
  AND status = 'active'
LIMIT 1000;
```

示例 2: alias

```sql
SELECT u.id AS user_id, u.name
FROM users u
WHERE u.deleted = 0
LIMIT 1000;
```

映射:

```text
user_id -> u.id
name    -> u.name
```

结果列 `user_id` 的过滤应写成 `u.id = ...`,不写成 `user_id = ...`,避免部分数据库不允许 WHERE 使用 select alias。

示例 3: 表达式

```sql
SELECT concat(first_name, ' ', last_name) AS full_name
FROM users
LIMIT 1000;
```

`full_name` 过滤不建议 v1 inline 到 WHERE,因为表达式复写和方言函数语义复杂。v1 fallback derived SQL:

```sql
SELECT *
FROM (
  SELECT concat(first_name, ' ', last_name) AS full_name
  FROM users
  LIMIT 1000
) AS taomni_result
WHERE full_name LIKE '%Ann%';
```

### WHERE 改写

1. 新增 filter 条件时:
   - 若原 SQL 有顶层 `WHERE`,插入 `AND <new_condition>`。
   - 若无顶层 `WHERE`,插入 `WHERE <new_condition>`。
2. 插入位置在以下顶层 clause 之前:
   - `GROUP BY`
   - `HAVING`
   - `ORDER BY`
   - `LIMIT`
   - `OFFSET`
   - `FETCH`
   - `FOR`
3. v1 由于拒绝 `GROUP BY/HAVING`,主要目标是 `ORDER BY/LIMIT/OFFSET/FETCH/FOR` 前。

### ORDER BY 改写

1. 新增 sort 时:
   - 若原 SQL 有顶层 `ORDER BY`,替换原顶层 `ORDER BY`。
   - 若无顶层 `ORDER BY`,插入新 `ORDER BY`。
2. 插入位置在以下顶层 clause 之前:
   - `LIMIT`
   - `OFFSET`
   - `FETCH`
   - `FOR`
3. 排序列优先使用 projection 映射:
   - 普通列/qualified column: 用来源表达式。
   - alias: 可选用 alias 或来源表达式;v1 推荐来源表达式更保守。
   - 复杂表达式: fallback derived SQL。

### LIMIT/FETCH/TOP 处理

| 方言 | 现有 tail | 插入策略 |
| --- | --- | --- |
| MySQL/StarRocks/PostgreSQL/ClickHouse/Presto | `LIMIT n` | `WHERE/ORDER BY` 插到 `LIMIT` 前 |
| Oracle | `FETCH FIRST n ROWS ONLY` | `WHERE/ORDER BY` 插到 `FETCH` 前 |
| SQLServer | `SELECT TOP (n)` | TOP 保留在 select list 前;`ORDER BY` 正常插入尾部 |

SQLServer 还要单独测试 `OFFSET ... FETCH NEXT ...`。

### Derived fallback 原则

以下场景继续 fallback:

- parser 失败。
- 多 statement。
- 结果列无法映射回安全来源表达式。
- 原 SQL 含聚合、分组、集合操作、CTE 等 v1 未支持结构。
- patch 位置无法稳定定位。
- 方言语义存在不确定性。

fallback 应携带 reason,便于 UI/日志解释,例如:

```text
derived: projection "full_name" is a computed expression
derived: parser failed for ClickHouseDialect: ...
derived: GROUP BY query is not inline-rewritable in v1
```

## 文本 patch 方案

### 为什么不默认 AST deparse

完整 AST -> SQL 会破坏用户原始文本:

- 注释可能丢失。
- 空白和换行会被重排。
- 关键字大小写会被规范化。
- identifier quoting 可能变化。

因此 v1 采用:

```text
parse AST -> analyze -> find clause ranges -> replace/insert small text fragment
```

### clause range 来源

优先级:

1. parser 节点 source span,如果 `sqlparser-rs` 对目标节点提供稳定 location。
2. AST 确认结构后,复用改良版顶层 scanner 只做 clause range 定位。
3. 如果无法定位,不 patch,走 derived fallback。

这意味着手写 scanner 不再承担语义判断,只承担“在已知安全结构中找顶层 clause 起止位置”。

### patch 输出

新增 Rust 内部结构:

```rust
struct SqlPatch {
    start: usize,
    end: usize,
    replacement: String,
}
```

patch 应从后往前应用,避免位置偏移。

## 格式化方案

### v1

将当前 `src/components/database/formatSql.ts` 替换/增强为 `sql-formatter`:

- 按 Taomni engine 映射 formatter language。
- 用户点击 Format 时才格式化。
- `Query` 回写不自动格式化整条 SQL,只插入符合当前文档缩进的片段。

建议映射:

| Taomni engine | sql-formatter language |
| --- | --- |
| MySQL | `mysql` |
| StarRocks | `mysql` |
| PostgreSQL | `postgresql` |
| PanWeiDB | `postgresql` |
| SQLServer | `transactsql` |
| Oracle | `plsql` |
| ClickHouse | `clickhouse` |
| Presto | `trino` 或 `presto` |

具体 language 名称以 `sql-formatter` 当前版本 API 为准。

### v2

- 增加 Format preview / diff。
- 支持用户选择 keyword case、indent size、lines between queries。
- 可选接入 SQLFluff CLI 作为高级 lint/format provider,仅在用户本机安装时启用。

## 落地计划

## Phase 0: 测试矩阵和行为锁定

目标: 在替换实现前固定期望行为。

新增/更新测试:

```text
src/components/database/QueryResultGrid.test.tsx
src/components/database/DbClientTab.test.tsx
src-tauri/tests/sql_rewrite.rs
```

覆盖矩阵:

- `SELECT * FROM t LIMIT 1000`
- `SELECT * FROM t WHERE a = 1 LIMIT 1000`
- `SELECT id, name FROM t LIMIT 1000`
- `SELECT id AS user_id, name FROM t LIMIT 1000`
- `SELECT u.id, u.name FROM users u WHERE u.deleted = 0 LIMIT 1000`
- `SELECT concat(a,b) AS c FROM t LIMIT 1000`
- 前置行注释/块注释
- 已有 `ORDER BY`
- `ORDER BY ... LIMIT ...`
- 多 statement
- `GROUP BY/HAVING`
- `UNION`
- PostgreSQL `FETCH FIRST`
- SQLServer `TOP`
- Oracle `FETCH FIRST`
- ClickHouse `LIMIT 1000`

验收:

- 明确哪些 inline,哪些 derived。
- derived reason 可断言。
- 当前已知问题先用 skipped/todo 标记,便于 Phase 2 解开。

## Phase 1: 引入后端 AST analyze,不替换现有路径

目标: 添加 parser 和 analyze command,只观测不影响现有行为。

工作:

1. `src-tauri/Cargo.toml` 增加 `sqlparser`。
2. 新增 `database/sql_rewrite` 模块。
3. 实现 engine -> dialect。
4. 实现 parse 单 statement。
5. 返回 analyze 结果:
   - statement kind
   - query shape
   - projection list
   - top-level clause presence
   - can_inline boolean
   - reason

验收:

- Rust tests 覆盖 dialect parse。
- 前端不调用新 command,用户行为不变。

## Phase 2: 后端生成 rewrite SQL,前端仍可 fallback 到旧逻辑

目标: 后端 command 能对核心简单查询返回 inline SQL。

工作:

1. 定义 `ResultSqlFilter` / `ResultSqlSort` Rust 类型。
2. 实现 projection 映射:
   - wildcard
   - simple identifier
   - compound identifier
   - alias
3. 实现 filter SQL literal 和 identifier quote。
4. 实现 WHERE/ORDER BY patch。
5. 失败时返回 derived SQL + reason。
6. 前端 `QueryResultGrid` 可通过 feature flag / dev flag 调用新 command。

验收:

- `SELECT id, name FROM t WHERE ... LIMIT 1000` 能 inline。
- `SELECT * FROM t WHERE ... LIMIT 1000` 保持 inline。
- 复杂表达式仍 derived。

## Phase 3: 接入正式 Query 路径

目标: `QueryResultGrid` 生成 SQL 改为优先调用后端 AST rewrite。

工作:

1. `QueryResultGrid` 不再本地拼完整 SQL,而是构造 rewrite request。
2. `DbClientTab` 持有 engine/sourceSql/resultColumns,调用后端 command。
3. 成功返回后仍走现有 `replaceGeneratedSqlSource()` 回写原 query。
4. command 异常时使用旧 TypeScript 逻辑作为临时兜底。
5. generated SQL bar 显示 mode/reason:
   - inline: 正常 SQL
   - derived: 可选 tooltip 显示 reason

验收:

- 用户路径: 本地过滤/排序 -> Query -> 原语句原位改写 -> 刷新 result sheet。
- 当前单测全部通过。
- 新增显式列清单场景通过。

## Phase 4: 移除/降级旧启发式语义判断

目标: 避免两套规则长期分叉。

工作:

1. 旧 `tryBuildInlineResultSql()` 改为 fallback-only 或删除。
2. 顶层 scanner 若保留,只用于 patch range 定位,不决定语义。
3. 将 derived SQL 生成逻辑集中到 Rust 后端。
4. 前端只负责展示和事件。

验收:

- `QueryResultGrid.tsx` 复杂度下降。
- SQL rewrite 主要测试位于 Rust。
- 前端测试保留用户交互和回写链路。

## Phase 5: 格式化增强

目标: SQL Format 使用成熟 formatter,但不影响 Query 回写。

工作:

1. 引入 `sql-formatter`。
2. 更新 `formatSql.ts` 支持 engine -> language。
3. 保留当前 Format 按钮入口。
4. 增加 formatter 单测:
   - MySQL/PostgreSQL/SQLServer/Oracle/ClickHouse/Presto 基本格式化。
   - 多 statement。
   - 注释保留。
5. 如果 formatter 不支持某方言,回退当前 formatter 或提示。

验收:

- `pnpm test` 相关测试通过。
- `pnpm build` 类型检查通过。

## Phase 6: 方言专项增强

目标: 补齐各数据库常见 SQL 形态。

优先级:

1. PostgreSQL/PanWeiDB:
   - quoted identifiers
   - casts
   - `FETCH FIRST`
   - 可评估 `pg_query.rs`
2. SQLServer:
   - `TOP`
   - `OFFSET/FETCH`
   - bracket identifiers
3. Oracle:
   - `FETCH FIRST`
   - quoted uppercase identifiers
4. ClickHouse:
   - `PREWHERE`
   - `LIMIT BY`
   - `FINAL`
5. Presto:
   - catalog.schema.table
   - `LIMIT`
   - Trino-specific functions

## 验收命令

前端:

```bash
pnpm exec vitest run src/components/database/QueryResultGrid.test.tsx src/components/database/DbClientTab.test.tsx
pnpm test
pnpm build
```

Rust:

```bash
cd src-tauri && cargo test sql_rewrite
cd src-tauri && cargo test
```

注意: 按仓库规范,如需格式化 Rust,只对改动文件运行:

```bash
rustfmt --edition 2024 src-tauri/src/database/sql_rewrite.rs
```

## 风险和缓解

### Parser 方言覆盖不足

风险: 某些 engine 的专有语法 parser 无法识别。

缓解:

- parse 失败不阻断用户,返回 derived fallback。
- 记录 reason。
- 按 engine 加专项测试和 adapter。

### AST deparse 破坏原文

风险: 全量 AST to SQL 会丢注释或改变格式。

缓解:

- 默认不 deparse 整条 SQL。
- AST 只做结构判断。
- 使用最小文本 patch。

### projection 映射误判

风险: 把结果列错误映射到来源列,导致语义错误。

缓解:

- v1 只支持 simple identifier / qualified identifier / alias of simple expression。
- computed expression fallback。
- ambiguous column fallback。

### 前后端职责迁移带来的复杂度

风险: 当前 generated SQL preview 是前端同步计算,后端 async rewrite 会影响 UI 响应。

缓解:

- 初期只在点击 `Query` 时调用后端。
- preview bar 可继续使用旧逻辑或显示 "Query will rewrite using AST"。
- 后续再做 debounce async preview。

## 非目标

- v1 不做 SQL transpile。
- v1 不做复杂聚合查询的 WHERE/HAVING 智能迁移。
- v1 不做跨 dialect rewrite。
- v1 不做 SQLFluff 内置。
- v1 不把 formatter 自动应用到 Query 回写结果。

## 预期收益

- `SELECT id, name FROM t WHERE ... LIMIT 1000` 这类常见简单 SQL 可原位改写,不再包裹。
- 各数据库方言解析边界更清楚。
- 复杂 SQL fallback 更可解释。
- 前端 `QueryResultGrid` 的 SQL 拼接复杂度下降。
- 后续可以复用 AST 能力做 SQL lint、当前语句识别、只读/写分类增强。
