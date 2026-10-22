use super::ActiveSchemaSlot;
use super::DEFAULT_TIMEOUT_SECS;
use super::SqlServerClient;
use super::query::sqlserver_fetch;
use super::schema_helpers::quote_mysql_ident;
use super::schema_helpers::quote_pg_ident;
use crate::database::DbConfig;
use crate::database::DbHandle;
use crate::database::tx::TxSlot;
use sqlx_core::Error as SqlxError;
use sqlx_core::pool::Pool;
use sqlx_core::query::query;
use sqlx_core::raw_sql::raw_sql;
use sqlx_core::sql_str::AssertSqlSafe;
use sqlx_mysql::MySql;
use sqlx_mysql::MySqlConnectOptions;
use sqlx_mysql::MySqlPoolOptions;
use sqlx_mysql::MySqlSslMode;
use sqlx_postgres::PgConnectOptions;
use sqlx_postgres::PgPoolOptions;
use sqlx_postgres::PgSslMode;
use sqlx_postgres::Postgres;
use std::sync::Arc;
use std::time::Duration;
use tiberius::AuthMethod as TdsAuthMethod;
use tiberius::Client as TdsClient;
use tiberius::Config as TdsConfig;
use tiberius::EncryptionLevel as TdsEncryptionLevel;
use tokio::net::TcpStream;
use tokio::sync::Mutex as AsyncMutex;
use tokio_util::compat::TokioAsyncWriteCompatExt;

pub(super) fn timeout(config: &DbConfig) -> Duration {
    Duration::from_secs(match config.timeout_secs {
        Some(s) if s > 0 => s,
        _ => DEFAULT_TIMEOUT_SECS,
    })
}

pub(super) fn initial_active_schema(config: &DbConfig) -> Option<String> {
    config
        .database
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

pub fn new_active_schema_slot(config: &DbConfig) -> ActiveSchemaSlot {
    // Only engines where the connection "database" field is the default schema
    // should seed the restore slot. Postgres/PanWei/Oracle/SQLServer use a
    // separate schema namespace from the connect database name.
    let initial = match config.engine.as_str() {
        "MySQL" | "StarRocks" | "ClickHouse" | "Presto" => initial_active_schema(config),
        _ => None,
    };
    Arc::new(AsyncMutex::new(initial))
}

pub(super) async fn restore_mysql_schema(
    conn: &mut sqlx_mysql::MySqlConnection,
    active_schema: &ActiveSchemaSlot,
) -> Result<(), SqlxError> {
    let schema = active_schema.lock().await.clone();
    let Some(schema) = schema.filter(|value| !value.is_empty()) else {
        return Ok(());
    };
    // USE is not supported by MySQL's prepared-statement protocol (error 1295).
    let sql = format!("USE {}", quote_mysql_ident(&schema));
    raw_sql(AssertSqlSafe(sql)).execute(&mut *conn).await?;
    Ok(())
}

pub(super) async fn restore_postgres_schema(
    conn: &mut sqlx_postgres::PgConnection,
    active_schema: &ActiveSchemaSlot,
) -> Result<(), SqlxError> {
    let schema = active_schema.lock().await.clone();
    let Some(schema) = schema.filter(|value| !value.is_empty()) else {
        return Ok(());
    };
    // Postgres search_path is session state; re-apply after reconnect.
    let sql = format!("SET search_path TO {}", quote_pg_ident(&schema));
    raw_sql(AssertSqlSafe(sql)).execute(&mut *conn).await?;
    Ok(())
}

/// MySQL `after_connect`: restore the schema, record the new connection, and
/// keep manual-commit sessions in `autocommit=0` across reconnects.
pub(super) async fn prepare_mysql_connection(
    conn: &mut sqlx_mysql::MySqlConnection,
    active_schema: &ActiveSchemaSlot,
    tx: &TxSlot,
) -> Result<(), SqlxError> {
    restore_mysql_schema(conn, active_schema).await?;
    tx.on_new_connection();
    if tx.manual() {
        raw_sql("SET autocommit=0").execute(&mut *conn).await?;
    }
    Ok(())
}

/// Run a transaction-control statement (`BEGIN`, `COMMIT`, `SET autocommit`…)
/// on the session's single pooled MySQL connection.
pub async fn exec_control_mysql(pool: &Pool<MySql>, sql: &'static str) -> Result<(), String> {
    raw_sql(sql)
        .execute(pool)
        .await
        .map(|_| ())
        .map_err(|e| format!("{sql} failed: {e}"))
}

pub async fn exec_control_postgres(pool: &Pool<Postgres>, sql: &'static str) -> Result<(), String> {
    raw_sql(sql)
        .execute(pool)
        .await
        .map(|_| ())
        .map_err(|e| format!("{sql} failed: {e}"))
}

pub async fn connect_mysql(
    config: &DbConfig,
    password: Option<&str>,
    active_schema: ActiveSchemaSlot,
    tx: TxSlot,
) -> Result<DbHandle, String> {
    let mut opts = MySqlConnectOptions::new()
        .host(&config.host)
        .port(config.port);
    if let Some(user) = config.username.as_deref().filter(|u| !u.is_empty()) {
        opts = opts.username(user);
    }
    if let Some(pw) = password {
        opts = opts.password(pw);
    }
    if let Some(db) = config.database.as_deref().filter(|d| !d.is_empty()) {
        opts = opts.database(db);
    }
    opts = opts.ssl_mode(if config.ssl {
        MySqlSslMode::Preferred
    } else {
        MySqlSslMode::Disabled
    });

    let pool = MySqlPoolOptions::new()
        .max_connections(1)
        .acquire_timeout(timeout(config))
        .test_before_acquire(true)
        // A lifetime-based reconnect would silently drop a manual transaction.
        .max_lifetime(None)
        .after_connect(move |conn, _meta| {
            let active_schema = active_schema.clone();
            let tx = tx.clone();
            Box::pin(async move { prepare_mysql_connection(conn, &active_schema, &tx).await })
        })
        .connect_with(opts)
        .await
        .map_err(|e| format!("MySQL connect failed: {e}"))?;
    Ok(DbHandle::MySql(pool))
}

pub async fn connect_starrocks(
    config: &DbConfig,
    password: Option<&str>,
    active_schema: ActiveSchemaSlot,
) -> Result<DbHandle, String> {
    let mut opts = MySqlConnectOptions::new()
        .host(&config.host)
        .port(config.port)
        .pipes_as_concat(false)
        .no_engine_substitution(false)
        .timezone(None)
        .set_names(false);
    if let Some(user) = config.username.as_deref().filter(|u| !u.is_empty()) {
        opts = opts.username(user);
    }
    if let Some(pw) = password {
        opts = opts.password(pw);
    }
    if let Some(db) = config.database.as_deref().filter(|d| !d.is_empty()) {
        opts = opts.database(db);
    }
    opts = opts.ssl_mode(if config.ssl {
        MySqlSslMode::Preferred
    } else {
        MySqlSslMode::Disabled
    });

    let pool = MySqlPoolOptions::new()
        .max_connections(1)
        .acquire_timeout(timeout(config))
        .test_before_acquire(true)
        .after_connect(move |conn, _meta| {
            let active_schema = active_schema.clone();
            Box::pin(async move { restore_mysql_schema(conn, &active_schema).await })
        })
        .connect_with(opts)
        .await
        .map_err(|e| format!("StarRocks connect failed: {e}"))?;
    Ok(DbHandle::StarRocks(pool))
}

pub async fn connect_postgres(
    config: &DbConfig,
    password: Option<&str>,
    active_schema: ActiveSchemaSlot,
    tx: TxSlot,
) -> Result<DbHandle, String> {
    let mut opts = PgConnectOptions::new().host(&config.host).port(config.port);
    if let Some(user) = config.username.as_deref().filter(|u| !u.is_empty()) {
        opts = opts.username(user);
    }
    if let Some(pw) = password {
        opts = opts.password(pw);
    }
    if let Some(db) = config.database.as_deref().filter(|d| !d.is_empty()) {
        opts = opts.database(db);
    }
    opts = opts.ssl_mode(if config.ssl {
        PgSslMode::Prefer
    } else {
        PgSslMode::Disable
    });

    let pool = PgPoolOptions::new()
        .max_connections(1)
        .acquire_timeout(timeout(config))
        .test_before_acquire(true)
        .max_lifetime(None)
        .after_connect(move |conn, _meta| {
            let active_schema = active_schema.clone();
            let tx = tx.clone();
            Box::pin(async move {
                restore_postgres_schema(conn, &active_schema).await?;
                tx.on_new_connection();
                Ok(())
            })
        })
        .connect_with(opts)
        .await
        .map_err(|e| format!("PostgreSQL connect failed: {e}"))?;
    Ok(DbHandle::Postgres(pool))
}

pub async fn connect_sqlserver(
    config: &DbConfig,
    password: Option<&str>,
) -> Result<DbHandle, String> {
    let mut opts = TdsConfig::new();
    opts.host(&config.host);
    opts.port(config.port);
    opts.application_name("Taomni");
    if let Some(db) = config.database.as_deref().filter(|d| !d.is_empty()) {
        opts.database(db);
    }

    let user = config.username.as_deref().unwrap_or("");
    if !user.is_empty() || password.is_some() {
        opts.authentication(TdsAuthMethod::sql_server(user, password.unwrap_or("")));
    }

    if config.ssl {
        opts.encryption(TdsEncryptionLevel::Required);
        // Many SQL Server developer and intranet deployments use self-signed
        // certificates. Match the app's boolean TLS model by encrypting without
        // requiring a separate CA picker.
        opts.trust_cert();
    } else {
        opts.encryption(TdsEncryptionLevel::Off);
    }

    let connect = async {
        let tcp = TcpStream::connect(opts.get_addr())
            .await
            .map_err(|e| format!("SQL Server TCP connect failed: {e}"))?;
        tcp.set_nodelay(true)
            .map_err(|e| format!("SQL Server TCP option failed: {e}"))?;
        TdsClient::connect(opts, tcp.compat_write())
            .await
            .map_err(|e| format!("SQL Server connect failed: {e}"))
    };

    let client = tokio::time::timeout(timeout(config), connect)
        .await
        .map_err(|_| "SQL Server connect timed out".to_string())??;
    Ok(DbHandle::SqlServer(Arc::new(AsyncMutex::new(client))))
}

// ---------------------------------------------------------------------------
// Ping
// ---------------------------------------------------------------------------

pub async fn ping_mysql(pool: &Pool<MySql>) -> Result<String, String> {
    query("SELECT 1")
        .execute(pool)
        .await
        .map_err(|e| format!("MySQL ping failed: {e}"))?;
    Ok("MySQL connection OK".into())
}

pub async fn ping_starrocks(pool: &Pool<MySql>) -> Result<String, String> {
    query("SELECT 1")
        .execute(pool)
        .await
        .map_err(|e| format!("StarRocks ping failed: {e}"))?;
    Ok("StarRocks connection OK".into())
}

pub async fn ping_postgres(pool: &Pool<Postgres>) -> Result<String, String> {
    query("SELECT 1")
        .execute(pool)
        .await
        .map_err(|e| format!("PostgreSQL ping failed: {e}"))?;
    Ok("PostgreSQL connection OK".into())
}

pub async fn ping_sqlserver(client: &AsyncMutex<SqlServerClient>) -> Result<String, String> {
    let rows = sqlserver_fetch(client, "SELECT 1", &[])
        .await
        .map_err(|e| format!("SQL Server ping failed: {e}"))?;
    if rows.is_empty() {
        return Err("SQL Server ping failed: no response".into());
    }
    Ok("SQL Server connection OK".into())
}
