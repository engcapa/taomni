# Database Connection Foundation

## What & Why
NewMob currently supports SSH/RDP/VNC terminal sessions. This task adds the foundational backend and session-model layer for database connections — MySQL, PostgreSQL, ClickHouse, and Redis — so they appear as first-class session types alongside SSH in the session tree and session editor. Without this foundation the query UI and key browser have nothing to connect to.

## Done looks like
- Four new session types exist in the Rust enum and the frontend `Proto` picker: `MySQL`, `PostgreSQL`, `ClickHouse`, `Redis`. Each has a distinct icon (matching the existing colored icon grid) and sensible default port (3306 / 5432 / 9000 / 6379).
- The session editor shows a dedicated form for each DB type: Host, Port, Username, Password (vault-backed, same flow as SSH), Database name (SQL types) / Key prefix (Redis), SSL/TLS toggle, and a connection timeout field.
- ClickHouse additionally exposes an HTTP port field (8123) and a protocol toggle (native binary vs. HTTP).
- Redis additionally exposes a "DB index" numeric field (0–15).
- A new Tauri command surface for the desktop build:
  - `db_connect(sessionId, config)` → opens and caches a connection (using `sqlx` for SQL databases, `redis-rs` for Redis, `clickhouse-rs` / HTTP for ClickHouse). Returns `{ ok: true }` or an error string.
  - `db_ping(sessionId)` → health-check that feeds the "Test connection" button.
  - `db_disconnect(sessionId)` → closes the connection and removes it from `AppState`.
  - `db_list_schemas(sessionId)` → returns `[{ name }]` for SQL types.
  - `db_list_tables(sessionId, schema?)` → returns `[{ name, kind: "table"|"view"|"materialized_view" }]`.
  - `db_describe_table(sessionId, schema, table)` → returns column list (name, type, nullable, default, primary_key).
  - `db_list_indexes(sessionId, schema, table)` → returns index metadata.
  - `db_execute(sessionId, sql, params?)` → runs a statement, returns `{ rows: [...], columns: [...], rowsAffected, duration_ms }` or streaming handle for large result sets.
  - `db_cancel(sessionId)` → cancels the in-flight query on this session.
  - `redis_list_keys(sessionId, pattern, cursor, count)` → SCAN cursor page.
  - `redis_get_key(sessionId, key)` → returns `{ kind, value, ttl }` (String/Hash/List/Set/ZSet/Stream).
  - `redis_set_key(sessionId, key, kind, value, ttl?)` → SET / HSET / etc.
  - `redis_del_key(sessionId, key)` → DEL.
  - `redis_exec(sessionId, rawCommand)` → raw RESP command, returns string reply.
- `AppState` gains a `db_connections: HashMap<String, Arc<DbSession>>` where `DbSession` is an enum wrapping the live connection handle per DB type.
- The browser (web mode) stub layer handles all `db_*` and `redis_*` commands with an explicit "Database connections are not available in browser preview" error — no silent fallback.
- "Test connection" in the session editor calls `db_ping` and shows success/failure inline.
- Saving a DB session persists credentials via the same vault mechanism SSH uses.
- Existing session types, session editor, and all existing tests continue to pass.

## Out of scope
- The query editor UI, schema browser tree, and result grid (Task: SQL Database Client UI).
- The Redis key browser and value viewer (Task: Redis Client UI).
- Query history, saved queries, export features.
- Connection pooling beyond the per-session single connection.
- Migrations or schema DDL management.

## Steps
1. **Extend Rust `SessionType` enum** — Add `MySQL`, `PostgreSQL`, `ClickHouse`, `Redis` variants with `as_str`/`from_str`/`default_port` impls. Add a new `src-tauri/src/database/` module that will hold all DB connection code.
2. **Add Rust crate dependencies** — `sqlx` with `mysql`, `postgres` features; `redis` (tokio-comp, TLS); `clickhouse` (HTTP client via `reqwest` or the official `clickhouse-rs` crate). Pin versions and add to `Cargo.toml`; confirm compilation.
3. **Implement `DbSession` and `AppState` extension** — Define an enum wrapping `sqlx::Pool<MySql>`, `sqlx::Pool<Postgres>`, a ClickHouse HTTP session, and `redis::aio::MultiplexedConnection`. Add the `db_connections` map to `AppState` with `Arc<Mutex<DbSession>>` per session.
4. **Implement Tauri commands** — Wire `db_connect`, `db_ping`, `db_disconnect`, `db_list_schemas`, `db_list_tables`, `db_describe_table`, `db_list_indexes`, `db_execute`, `db_cancel` for SQL types. Wire `redis_list_keys`, `redis_get_key`, `redis_set_key`, `redis_del_key`, `redis_exec` for Redis. Register all in `lib.rs`.
5. **Frontend session type + editor** — Add the four new types to the `Proto` picker and `protoToSessionType` map. Add a `DatabaseSettings` sub-form component inside `SessionEditor` covering host, port, username, password (vault-backed), database name / DB index, SSL toggle, timeout. Wire "Test connection" to `db_ping`.
6. **Browser stub** — Add stubs for all `db_*` and `redis_*` commands in `tauri-core.ts` that throw a clear "not available in browser preview" error.
7. **TypeScript types** — Add `DbConnectInfo` interface and a new `"database"` / `"redis"` `TabKind` placeholder so downstream tasks can render the appropriate component.

## Relevant files
- `src-tauri/src/session/models.rs`
- `src-tauri/src/state.rs`
- `src-tauri/src/lib.rs`
- `src-tauri/Cargo.toml`
- `src/components/session/SessionEditor.tsx`
- `src/stubs/tauri-core.ts`
- `src/types/index.ts`
- `src/lib/ipc.ts`
