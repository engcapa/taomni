use crate::database::clickhouse;
use crate::database::forward;
use crate::database::oracle;
use crate::database::panwei;
use crate::database::presto;
use crate::database::sql;
use crate::database::tx;
use crate::state::AppState;
use sqlx_core::pool::Pool;
use sqlx_mysql::MySql;
use sqlx_postgres::Postgres;
use std::sync::Arc;
use std::time::Duration;
use tauri::State;
use tokio::sync::Mutex as AsyncMutex;
use tokio::task::JoinHandle;
use tokio::time::MissedTickBehavior;
use tokio_util::sync::CancellationToken;

/// The live, engine-specific connection handle. Held behind an `Arc` in
/// `AppState::db_connections`; SQL pools are internally `Send + Sync` so they
/// need no extra lock, while the Redis multiplexed connection is cloneable.
pub enum DbHandle {
    MySql(Pool<MySql>),
    Postgres(Pool<Postgres>),
    PanWeiDB(panwei::PanWeiClient),
    Oracle(oracle::OracleClient),
    SqlServer(Arc<AsyncMutex<sql::SqlServerClient>>),
    StarRocks(Pool<MySql>),
    ClickHouse(clickhouse::ClickHouseClient),
    Presto(presto::PrestoClient),
    Redis(AsyncMutex<redis::aio::MultiplexedConnection>),
}

/// A cached database session: the live handle + a cancellation token so
/// `db_cancel` can interrupt an in-flight query on the same session.
pub struct DbSession {
    pub handle: DbHandle,
    pub cancel: AsyncMutex<CancellationToken>,
    /// Last successful default schema/database from `USE` / `SET search_path`
    /// etc. Shared with pool `after_connect` hooks so reconnects restore it.
    pub active_schema: sql::ActiveSchemaSlot,
    /// Manual-commit state shared with the pool `after_connect` hook.
    pub tx: tx::TxSlot,
    pub(super) shutdown: CancellationToken,
    pub(super) keepalive: Option<JoinHandle<()>>,
    /// Loopback forwarder task when the connection is routed through a proxy /
    /// SSH jump host. Aborted on close to release the bound local port.
    pub(super) forward: Option<JoinHandle<()>>,
}

impl DbSession {
    pub(super) fn with_forward(
        handle: DbHandle,
        forward: Option<JoinHandle<()>>,
        active_schema: sql::ActiveSchemaSlot,
        tx: tx::TxSlot,
    ) -> Self {
        let shutdown = CancellationToken::new();
        let keepalive = start_keepalive(&handle, shutdown.clone());
        Self {
            handle,
            cancel: AsyncMutex::new(CancellationToken::new()),
            active_schema,
            tx,
            shutdown,
            keepalive,
            forward,
        }
    }

    /// Replace the cancellation token with a fresh one and return it, so each
    /// query gets an independent token that `db_cancel` can trip.
    pub(super) async fn fresh_cancel_token(&self) -> CancellationToken {
        let mut guard = self.cancel.lock().await;
        let token = CancellationToken::new();
        *guard = token.clone();
        token
    }

    /// Manual commit is available on engines with real session transactions.
    pub(super) fn tx_supported(&self) -> bool {
        matches!(self.handle, DbHandle::MySql(_) | DbHandle::Postgres(_))
    }

    pub(super) fn tx_status(&self) -> tx::DbTxStatus {
        self.tx.status(self.tx_supported())
    }

    /// PostgreSQL has no session autocommit switch: open a transaction before
    /// the first write of a manual-commit session.
    pub(super) async fn tx_before_statement(&self, sql: &str) -> Result<(), String> {
        if !self.tx.manual() || self.tx.open() {
            return Ok(());
        }
        if let DbHandle::Postgres(pool) = &self.handle
            && tx::classify(sql, false) == tx::TxEffect::Write
        {
            sql::exec_control_postgres(pool, "BEGIN").await?;
            self.tx.mark_open();
        }
        Ok(())
    }

    pub(super) fn tx_after_statement(&self, sql: &str) {
        if self.tx_supported() {
            let mysql = matches!(self.handle, DbHandle::MySql(_));
            self.tx.note_executed(tx::classify(sql, mysql));
        }
    }

    /// Record a successful session default-schema switch so reconnects and
    /// engines with client-side default DB (ClickHouse) stay in sync.
    pub(super) async fn note_schema_switch(&self, sql: &str) {
        let Some(schema) = sql::parse_default_schema_switch(sql) else {
            return;
        };
        *self.active_schema.lock().await = Some(schema.clone());
        if let DbHandle::ClickHouse(client) = &self.handle {
            client.set_database(schema);
        }
    }
}

pub(super) fn start_keepalive(
    handle: &DbHandle,
    shutdown: CancellationToken,
) -> Option<JoinHandle<()>> {
    const KEEPALIVE_INTERVAL_SECS: u64 = 30;

    match handle {
        DbHandle::MySql(pool) => {
            let pool = pool.clone();
            Some(tokio::spawn(async move {
                let mut interval =
                    tokio::time::interval(Duration::from_secs(KEEPALIVE_INTERVAL_SECS));
                interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
                loop {
                    tokio::select! {
                        _ = shutdown.cancelled() => break,
                        _ = interval.tick() => {
                            let _ = sql::ping_mysql(&pool).await;
                        }
                    }
                }
            }))
        }
        DbHandle::StarRocks(pool) => {
            let pool = pool.clone();
            Some(tokio::spawn(async move {
                let mut interval =
                    tokio::time::interval(Duration::from_secs(KEEPALIVE_INTERVAL_SECS));
                interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
                loop {
                    tokio::select! {
                        _ = shutdown.cancelled() => break,
                        _ = interval.tick() => {
                            let _ = sql::ping_starrocks(&pool).await;
                        }
                    }
                }
            }))
        }
        DbHandle::Postgres(pool) => {
            let pool = pool.clone();
            Some(tokio::spawn(async move {
                let mut interval =
                    tokio::time::interval(Duration::from_secs(KEEPALIVE_INTERVAL_SECS));
                interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
                loop {
                    tokio::select! {
                        _ = shutdown.cancelled() => break,
                        _ = interval.tick() => {
                            let _ = sql::ping_postgres(&pool).await;
                        }
                    }
                }
            }))
        }
        DbHandle::PanWeiDB(client) => {
            let client = client.clone();
            Some(tokio::spawn(async move {
                let mut interval =
                    tokio::time::interval(Duration::from_secs(KEEPALIVE_INTERVAL_SECS));
                interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
                loop {
                    tokio::select! {
                        _ = shutdown.cancelled() => break,
                        _ = interval.tick() => {
                            let _ = panwei::ping(&client).await;
                        }
                    }
                }
            }))
        }
        DbHandle::Oracle(client) => {
            let client = client.clone();
            Some(tokio::spawn(async move {
                let mut interval =
                    tokio::time::interval(Duration::from_secs(KEEPALIVE_INTERVAL_SECS));
                interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
                loop {
                    tokio::select! {
                        _ = shutdown.cancelled() => break,
                        _ = interval.tick() => {
                            let _ = oracle::ping(&client).await;
                        }
                    }
                }
            }))
        }
        DbHandle::SqlServer(client) => {
            let client = client.clone();
            Some(tokio::spawn(async move {
                let mut interval =
                    tokio::time::interval(Duration::from_secs(KEEPALIVE_INTERVAL_SECS));
                interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
                loop {
                    tokio::select! {
                        _ = shutdown.cancelled() => break,
                        _ = interval.tick() => {
                            let _ = sql::ping_sqlserver(&client).await;
                        }
                    }
                }
            }))
        }
        DbHandle::ClickHouse(client) => {
            let client = client.clone();
            Some(tokio::spawn(async move {
                let mut interval =
                    tokio::time::interval(Duration::from_secs(KEEPALIVE_INTERVAL_SECS));
                interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
                loop {
                    tokio::select! {
                        _ = shutdown.cancelled() => break,
                        _ = interval.tick() => {
                            let _ = clickhouse::ping(&client).await;
                        }
                    }
                }
            }))
        }
        DbHandle::Presto(client) => {
            let client = client.clone();
            Some(tokio::spawn(async move {
                let mut interval =
                    tokio::time::interval(Duration::from_secs(KEEPALIVE_INTERVAL_SECS));
                interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
                loop {
                    tokio::select! {
                        _ = shutdown.cancelled() => break,
                        _ = interval.tick() => {
                            let _ = presto::ping(&client).await;
                        }
                    }
                }
            }))
        }
        DbHandle::Redis(_) => None,
    }
}

pub(super) async fn close_session(session: Arc<DbSession>) {
    session.shutdown.cancel();
    if let Some(task) = &session.keepalive {
        task.abort();
    }
    if let Some(task) = &session.forward {
        task.abort();
    }
    session.cancel.lock().await.cancel();
    match &session.handle {
        DbHandle::MySql(pool) => pool.close().await,
        DbHandle::StarRocks(pool) => pool.close().await,
        DbHandle::Postgres(pool) => pool.close().await,
        DbHandle::PanWeiDB(_)
        | DbHandle::Oracle(_)
        | DbHandle::SqlServer(_)
        | DbHandle::ClickHouse(_)
        | DbHandle::Presto(_)
        | DbHandle::Redis(_) => {}
    }
}

pub(super) async fn get_session(
    state: &State<'_, AppState>,
    session_id: &str,
) -> Result<Arc<DbSession>, String> {
    let map = state.database.db_connections.read().await;
    map.get(session_id)
        .cloned()
        .ok_or_else(|| format!("No active database connection for session {session_id}"))
}
