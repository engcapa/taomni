//! Phase 6 — the `taomni_sql` MCP flavor: the tool surface a Claude Code thread
//! bound to a SQL DB session (MySQL / PostgreSQL / Oracle / SQL Server / StarRocks / ClickHouse / Presto) sees.
//!
//! Unlike the shell flavor (which routes side-effects back through the frontend
//! terminal), every tool here runs **backend-direct**: it resolves the thread's
//! live DB connection and reuses the existing `crate::database::db_*` command
//! functions in-process, so results never round-trip the frontend. Engine
//! differences are already handled by `database`'s `DbHandle` dispatch.
//!
//! Connection resolution (D2 for DB): the live `db_connections` key is a
//! frontend-generated runtime id that the backend can't derive, so the frontend
//! bridges it each turn into `AppState.agent_db_bindings[thread_id]`. CC never names
//! a connection id — the handler always targets the thread's bound one, so
//! cross-session access is impossible by construction.

mod limits;

mod lifetime;

mod formatting;

mod echo;

mod results;

mod parameters;

mod routes;

#[cfg(test)]
mod tests;

pub use lifetime::SqlHandler;
