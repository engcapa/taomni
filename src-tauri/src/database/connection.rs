use super::model::DbConfig;
use super::model::DbConnectResult;
use super::session::DbHandle;
use super::session::DbSession;
use super::session::close_session;
use super::session::get_session;
use crate::database::clickhouse;
use crate::database::forward;
use crate::database::oracle;
use crate::database::panwei;
use crate::database::presto;
use crate::database::redis_ops;
use crate::database::sql;
use crate::database::tx;
use crate::state::AppState;
use sqlx_mysql::MySql;
use sqlx_postgres::Postgres;
use std::sync::Arc;
use tauri::State;
use tokio::task::JoinHandle;

/// Resolve a possibly-`vault:`-prefixed secret to plaintext. Returns the
/// original string when it is not a vault reference (backwards compatible with
/// inline plaintext passwords).
pub(super) fn resolve_secret(
    state: &State<'_, AppState>,
    value: Option<&str>,
) -> Result<Option<String>, String> {
    match value {
        Some(v) if !v.is_empty() => match state.vault.resolve(v)? {
            Some(z) => Ok(Some((*z).clone())),
            None => Ok(Some(v.to_string())),
        },
        _ => Ok(None),
    }
}

#[tauri::command]
pub async fn db_connect(
    state: State<'_, AppState>,
    session_id: String,
    config: DbConfig,
) -> Result<DbConnectResult, String> {
    let password = resolve_secret(&state, config.password.as_deref())?;

    // If the session is routed through a proxy / SSH jump host, stand up a
    // loopback forwarder and point the engine client at 127.0.0.1:<local>.
    // The forwarder bridges each connection to the real target through the
    // same proxy/jump machinery the SSH terminal uses.
    let (config, forward_task) = match prepare_network_forward(&state, &config).await? {
        Some((effective, task)) => (effective, Some(task)),
        None => (config, None),
    };

    let active_schema = sql::new_active_schema_slot(&config);
    let tx_state = tx::TxState::shared();
    let handle = match config.engine.as_str() {
        "MySQL" => {
            sql::connect_mysql(
                &config,
                password.as_deref(),
                active_schema.clone(),
                tx_state.clone(),
            )
            .await?
        }
        "PostgreSQL" => {
            sql::connect_postgres(
                &config,
                password.as_deref(),
                active_schema.clone(),
                tx_state.clone(),
            )
            .await?
        }
        "PanWeiDB" => panwei::connect(&config, password.as_deref()).await?,
        "Oracle" => oracle::connect(&config, password.as_deref()).await?,
        "SQLServer" => sql::connect_sqlserver(&config, password.as_deref()).await?,
        "StarRocks" => {
            sql::connect_starrocks(&config, password.as_deref(), active_schema.clone()).await?
        }
        "ClickHouse" => clickhouse::connect(&config, password.as_deref()).await?,
        "Presto" => presto::connect(&config, password.as_deref()).await?,
        "Redis" => redis_ops::connect(&config, password.as_deref()).await?,
        other => {
            if let Some(task) = forward_task {
                task.abort();
            }
            return Err(format!("Unsupported database engine: {other}"));
        }
    };
    let session = Arc::new(DbSession::with_forward(
        handle,
        forward_task,
        active_schema,
        tx_state,
    ));
    let previous = {
        let mut map = state.database.db_connections.write().await;
        // If a stale session exists under this id, close it after releasing the map lock.
        map.insert(session_id, session)
    };
    if let Some(previous) = previous {
        close_session(previous).await;
    }
    Ok(DbConnectResult { ok: true })
}

/// The TCP port an engine actually dials for `config` — ClickHouse uses its
/// HTTP port (default 8123); every other engine uses `config.port`.
pub(super) fn engine_target_port(config: &DbConfig) -> u16 {
    if config.engine == "ClickHouse" {
        config.http_port.unwrap_or(8123)
    } else {
        config.port
    }
}

/// When `config.network_settings` requests a proxy or SSH jump host, resolve
/// its secrets, start a loopback forwarder to the engine's real target, and
/// return an effective `DbConfig` whose host/port point at the local forward
/// plus the listener task. Returns `None` for direct connections.
pub(super) async fn prepare_network_forward(
    state: &State<'_, AppState>,
    config: &DbConfig,
) -> Result<Option<(DbConfig, JoinHandle<()>)>, String> {
    let mut net = match &config.network_settings {
        Some(n) => n.clone(),
        None => return Ok(None),
    };
    let uses_proxy = !matches!(net.proxy_kind.as_str(), "" | "none");
    if !uses_proxy {
        return Ok(None);
    }

    // Resolve proxy + jump credentials (vault refs → plaintext, session-mode
    // jump host → DB lookup) exactly like the SSH terminal path.
    crate::terminal::resolve_proxy_session(state, &mut net)?;
    net.resolve_proxy_pass(&state.vault)?;
    crate::terminal::resolve_jump_credentials(state, &mut net)?;

    let target_host = config.host.clone();
    let target_port = engine_target_port(config);
    let fwd = forward::start(target_host, target_port, net).await?;

    // Rewrite the effective config to dial the loopback listener. ClickHouse
    // keys off http_port, so redirect that; everyone else uses `port`.
    let mut effective = config.clone();
    effective.host = "127.0.0.1".to_string();
    if config.engine == "ClickHouse" {
        effective.http_port = Some(fwd.local_port);
    } else {
        effective.port = fwd.local_port;
    }
    Ok(Some((effective, fwd.task)))
}

#[tauri::command]
pub async fn db_ping(state: State<'_, AppState>, session_id: String) -> Result<String, String> {
    let session = get_session(&state, &session_id).await?;
    match &session.handle {
        DbHandle::MySql(pool) => sql::ping_mysql(pool).await,
        DbHandle::Postgres(pool) => sql::ping_postgres(pool).await,
        DbHandle::PanWeiDB(client) => panwei::ping(client).await,
        DbHandle::Oracle(client) => oracle::ping(client).await,
        DbHandle::SqlServer(client) => sql::ping_sqlserver(client).await,
        DbHandle::StarRocks(pool) => sql::ping_starrocks(pool).await,
        DbHandle::ClickHouse(client) => clickhouse::ping(client).await,
        DbHandle::Presto(client) => presto::ping(client).await,
        DbHandle::Redis(conn) => redis_ops::ping(conn).await,
    }
}

#[tauri::command]
pub async fn db_disconnect(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    let removed = {
        let mut map = state.database.db_connections.write().await;
        map.remove(&session_id)
    };
    if let Some(session) = removed {
        close_session(session).await;
    }
    Ok(())
}
