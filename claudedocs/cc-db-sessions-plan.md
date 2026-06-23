# CC → DB 会话集成计划(Phase 6,承接 cc-agent-orchestration-plan.md)

**状态**: 实现完成(Phase 1–5),待 GUI 端到端验证 + 提交
**日期**: 2026-06-23
**分支**: `feat/cc-db-sessions`
**目标**: 把 Claude Code 接入 DB 查询会话(MySQL/PG/ClickHouse/Presto/Redis),参考 shell 会话实现,但用**独立 MCP**;每个 DB 线程只加载自己引擎的 MCP,不加载 shell 专用 MCP,减少干扰。

## 实现状态(全部 builds + tests green:Rust 564、前端 550、tsc/vite OK)
- ✅ **Phase 1 infra**:`mcp_http.rs` 加 `Flavor{Shell,Sql,Redis}`,一个 listener 挂三路 `/mcp`(shell,不变)、`/mcp/sql`、`/mcp/redis`,共享 token map + auth;抽出 `scope_from_ctx`/`await_permission`/`decide_permission`/allow-deny 等 `pub(crate)` 复用件;`provision_for_thread(flavor,…)`。
- ✅ **Phase 2 桥 + SQL 只读**:`AppState.cc_db_bindings`(thread→连接 id)+ `ChatSendRequest.bound_db_connection_id`(逐轮存);`mcp_sql.rs::SqlHandler` 直连 `crate::database::db_*`:list_catalogs/schemas/tables、describe_table、list_indexes/objects、object_ddl、table_stats、run_sql(有界)。
- ✅ **Phase 3 写 HITL + capture/export**:`agent/sql_classify.rs`(读/写,含 CTE/EXPLAIN ANALYZE/多语句/注释,保守默认写);`run_sql_captured`(整结果写 CSV capture 文件,返回摘要)、`read_result`(head/tail/range/grep/stats,复用 `capture::reduce`)、`export_result`(写 Downloads/taomni-exports,v1 仅 csv,HITL)。`safety::is_write_tool` 纳入 DB 写工具。
- ✅ **Phase 4 Redis**:`mcp_redis.rs::RedisHandler` 直连 `redis_*`:list_keys/get/set/del/exec(exec 按命令读/写分级);`RedisClientTab` 加 `chatToggle` + MainLayout 接线。
- ✅ **Phase 5 身份卡 + 测试**:`session_card.rs` 按 `session_type` 分派 DB 路由(SQL/Redis 工具,降级本地 `<env>`,不再误导 run_in_terminal);`Flavor::for_session_type` 选 flavor(chat/mod.rs spawn 用);`config.rs` 写 flavor server 名 + `flavor.permission_prompt_tool()`;`CcAgentBridge.describe/preview` 加 SQL/Redis 文案;前端 `appStore.dbConnByTab` + DbClientTab/RedisClientTab 连接时上报 conn id + chatStore 逐轮带 `bound_db_connection_id`。新增测试:sql_classify、session_card DB 变体、flavor 映射/路径、config flavor 名、mcp_sql CSV/parse、redis 命令分级。

## v1 已知取舍(后续可优化)
- `run_sql_captured` 先 `db_execute` 物化全量再写 CSV(未走 `db_execute_stream` 流式);超大结果占内存,建议用 LIMIT 或后续改流式。
- `export_result` v1 仅 csv(capture 即 CSV);json/tsv 顺延。
- DB 身份卡未含 schema 快照(卡片构建是同步、early,连接绑定此时可能尚未入 `cc_db_bindings`);CC 自行调 list_tables 获取。
- commands.rs 的 `cc_send_message`/`cc_stream_message` 备用通路固定 Shell flavor(前端未用)。

## 待办
- ☐ GUI 端到端验证:绑定 MySQL/PG/CH/Presto 会话 → CC 查 schema、跑 SELECT、写语句弹卡、大结果 run_sql_captured+read_result、export_result 落盘;Redis 同理。
- ☐ 提交(用户确认后)。

---

## 原始计划(供参考)

## 已锁定决策(用户确认)
- **两种 DB MCP flavor**:`taomni_sql`(MySQL/PG/ClickHouse/Presto 合一,handler 内按 engine 分派)+ `taomni_redis`(Redis 独立)。shell `taomni` 不变。
- **一线程一 flavor**:spawn 时按绑定会话 `session_type` 选 flavor;生成的 `.mcp.json` 只列**一个** server。DB 线程看不到 shell 工具。
- **v1 引擎**:MySQL / PostgreSQL / ClickHouse / Presto / Redis。HBaseShell 顺延。
- **写操作允许但 HITL 弹卡**:新增 `agent/sql_classify.rs`;SELECT/SHOW/EXPLAIN/DESCRIBE/WITH…SELECT = 只读(自动放行,受 `confirm_readonly`);INSERT/UPDATE/DELETE/MERGE/CREATE/ALTER/DROP/TRUNCATE/GRANT + 多语句 = 写 → 弹卡。
- **后端直连执行**:DB MCP handler 在进程内直接打 `state.db_connections`(复用 `database/*`),结果不经前端往返;大结果走 capture(整入后端文件 → 摘要 → `read_result`/`export_result`)。

## 关键代码事实
- DB 连接活在 `state.db_connections`,**key = 前端随机 runtime id**(`createRuntimeDbSessionId` → `baseSessionId::uuid`,`DbClientTab.tsx:109`),后端推不出来 → 需前端把活连接 id 桥过来。
- 后端已有全套执行/introspection:`database/mod.rs` 的 `db_execute(_stream)`/`db_list_*`/`db_describe_table`/`db_object_ddl`/`db_table_stats`/`db_cancel`、`redis_*`。
- `DbClientTab` 已接 `chatToggle`(CC drawer 可绑 DB tab);`RedisClientTab` 尚未接。
- spawn(`chat/mod.rs:541-679`)已解析绑定 `SessionConfig`(含 `session_type`)用于身份卡 → 在此处分 flavor。
- shell MCP:`cc_bridge/mcp_http.rs`(server 名 `taomni`,nest `/mcp`)、`config.rs`(写 `.mcp.json` + `PERMISSION_PROMPT_TOOL`)、`session_card.rs`(SSH 形身份卡)。

## 工作流
- **A. MCP infra 重构**(`mcp_http.rs`):抽出共享件(`TokenScope`+`flavor`/`TokenMap`/`auth_mw`/`scope()`/`await_permission`/分级/allow-deny JSON)到 `mcp_common`;一个 listener 挂三路 `/mcp/shell`(现 `CcHandler`)、`/mcp/sql`(`SqlHandler`)、`/mcp/redis`(`RedisHandler`),共享 token map。`provision_for_thread(flavor,…)` 按 flavor 返回 URL+token。**先 spike**:多 `StreamableHttpService` nest 同一 router。
- **B. 线程→DB连接 桥**:`ChatSendRequest` 增 `bound_db_connection_id`(前端逐轮传活连接 id,同 `bound_session_id`/`cwd`);后端每轮存入新 `AppState.cc_db_bindings: Arc<RwLock<HashMap<thread_id,String>>>`;SQL/Redis handler 从此解析绑定连接(CC 不命名连接 id → 天然 scope 安全)。
- **C. SQL handler**(`taomni_sql`,全后端直连):
  - 只读(自动):`list_schemas`/`list_tables`/`describe_table`/`list_indexes`/`list_objects`/`object_ddl`/`table_stats`/`list_catalogs`(Presto)——这就是 CC 生成 SQL 的 schema 上下文,无需"生成"工具。
  - `run_sql(sql,max_rows?)` → 有界内联结果;写 → HITL。
  - `run_sql_captured(sql)` → 整结果流入后端文件(复用 `CaptureWriter`,CSV/JSONL),返回列+行数+head 预览。
  - `read_result(capture_id,op=head|range|grep|stats)` → 复用 `agent/capture/reduce`。
  - `export_result(capture_id|sql,format=csv|json|tsv)` → 写 **Taomni 托管 exports 目录**(非任意路径),HITL,返回路径。
  - `cancel` → `db_cancel`;`permission_prompt` → safety + `sql_classify`。
- **D. Redis handler**(`taomni_redis`):`redis_list_keys`(scan)/`redis_get_key`(读) 自动;`redis_set_key`/`redis_del_key`(写→HITL);`redis_exec`(分类命令读/写→写弹卡)。直连 `redis_ops::*`。
- **E. spawn flavor + DB 身份卡**(`chat/mod.rs`、`session_card.rs`):`session_type`→flavor;`--permission-prompt-tool = mcp__taomni_{flavor}__permission_prompt`;新 DB 卡:引擎/host/db/catalog 身份 + 路由("操作绑定的 `<engine>` 连接,用 SQL MCP 工具,别用本地 Bash/Read") + 每引擎方言注记 + **schema 快照**(替代 SSH 命令历史)。
- **F. 前端**:`RedisClientTab` 接 `chatToggle`;`chatStore.sendMessage` 带 `bound_db_connection_id`;`CcAgentBridge.describe()` 增 SQL/Redis 文案。后端直连执行 → **无需新增 `agent-cc-tool` 执行分支**,只复用权限卡路径。
- **G. plumbing**:`AppState` 字段+init;`ipc.ts` 包装(若有新命令);`lib.rs` 注册。
- **H. 测试**:`sql_classify`(读写/CTE/注释/多语句);DB `session_card` 快照;MCP flavor 路由(sql 线程 `.mcp.json` 只含 `taomni_sql`)、401+scope、分级(SELECT 自动 / DELETE→HITL);前端 vitest;env 门控 live(仿 Hologres 测试)。

## 分阶段(每阶段一 review gate)
1. infra 重构(A)+ flavor provisioning 骨架(E 部分)——gate:shell 不变,SQL 线程能连(空)SQL MCP。
2. 桥(B)+ SQL 只读工具(C-read)——gate:CC 查 schema/表、跑 SELECT 拿结果。
3. `sql_classify` + 写 HITL + captured/read/export(C-write)——gate:DELETE 弹卡;大结果 capture+分页;export 落文件。
4. Redis handler(D)+ Redis `chatToggle`(F)——gate:Redis 读写经 CC。
5. DB 身份卡打磨 + 全量测试(E,H)。

## 风险/边界
- rmcp 多路 nest:先 spike(低风险)。
- 结果体量:`run_sql` 硬上限;卡片引导大输出走 `run_sql_captured`。
- 安全:`export_result` 限托管目录(非任意写)+ HITL;卡片只含引擎/host/db(过 redact),绝不碰 `options_json`/vault。
- v1 不做:HBaseShell、任意导出路径、超大导出流式超额。
