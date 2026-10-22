use super::model::QueryResult;
use super::model::QueryStreamChannel;
use super::model::QueryStreamEvent;
use super::session::DbHandle;
use super::session::get_session;
use crate::database::clickhouse;
use crate::database::oracle;
use crate::database::panwei;
use crate::database::presto;
use crate::database::sql;
use crate::state::AppState;
use sqlx_mysql::MySql;
use sqlx_postgres::Postgres;
use tauri::State;

pub(crate) fn send_query_stream_event(
    on_event: &QueryStreamChannel,
    event: QueryStreamEvent,
) -> Result<(), String> {
    on_event
        .send(event)
        .map_err(|e| format!("Query stream event failed: {e}"))
}

pub(crate) fn emit_query_result_stream(
    on_event: &QueryStreamChannel,
    result: QueryResult,
) -> Result<(), String> {
    if !result.columns.is_empty() {
        send_query_stream_event(
            on_event,
            QueryStreamEvent::Columns {
                columns: result.columns,
            },
        )?;
    }
    for rows in result.rows.chunks(100) {
        send_query_stream_event(
            on_event,
            QueryStreamEvent::Rows {
                rows: rows.to_vec(),
            },
        )?;
    }
    send_query_stream_event(
        on_event,
        QueryStreamEvent::Done {
            rows_affected: result.rows_affected,
            duration_ms: result.duration_ms,
            warnings: result.warnings,
        },
    )
}

#[tauri::command]
pub async fn db_execute(
    state: State<'_, AppState>,
    session_id: String,
    sql: String,
) -> Result<QueryResult, String> {
    let session = get_session(&state, &session_id).await?;
    session.tx_before_statement(&sql).await?;
    let token = session.fresh_cancel_token().await;
    let result = match &session.handle {
        DbHandle::MySql(pool) => sql::execute_mysql(pool, &sql, &token).await,
        DbHandle::StarRocks(pool) => sql::execute_mysql(pool, &sql, &token).await,
        DbHandle::Postgres(pool) => sql::execute_postgres(pool, &sql, &token).await,
        DbHandle::PanWeiDB(client) => panwei::execute(client, &sql, &token).await,
        DbHandle::Oracle(client) => oracle::execute(client, &sql, &token).await,
        DbHandle::SqlServer(client) => sql::execute_sqlserver(client, &sql, &token).await,
        DbHandle::ClickHouse(client) => clickhouse::execute(client, &sql, &token).await,
        DbHandle::Presto(client) => presto::execute(client, &sql, &token).await,
        DbHandle::Redis(_) => Err("Use redis_exec for Redis commands".into()),
    };
    if result.is_ok() {
        session.note_schema_switch(&sql).await;
        session.tx_after_statement(&sql);
    }
    result
}

#[tauri::command]
pub async fn db_execute_stream(
    state: State<'_, AppState>,
    session_id: String,
    sql: String,
    max_rows: Option<u64>,
    on_event: QueryStreamChannel,
) -> Result<(), String> {
    let session = get_session(&state, &session_id).await?;
    session.tx_before_statement(&sql).await?;
    let token = session.fresh_cancel_token().await;
    let result = match &session.handle {
        DbHandle::MySql(pool) => {
            sql::execute_mysql_stream(pool, &sql, max_rows, &token, &on_event).await
        }
        DbHandle::StarRocks(pool) => {
            sql::execute_mysql_stream(pool, &sql, max_rows, &token, &on_event).await
        }
        DbHandle::Postgres(pool) => {
            sql::execute_postgres_stream(pool, &sql, max_rows, &token, &on_event).await
        }
        DbHandle::PanWeiDB(client) => {
            panwei::execute_stream(client, &sql, max_rows, &token, &on_event).await
        }
        DbHandle::Oracle(client) => {
            oracle::execute_stream(client, &sql, max_rows, &token, &on_event).await
        }
        DbHandle::SqlServer(client) => {
            sql::execute_sqlserver_stream(client, &sql, max_rows, &token, &on_event).await
        }
        DbHandle::ClickHouse(client) => {
            clickhouse::execute_stream(client, &sql, max_rows, &token, &on_event).await
        }
        DbHandle::Presto(client) => {
            presto::execute_stream(client, &sql, max_rows, &token, &on_event).await
        }
        DbHandle::Redis(_) => Err("Use redis_exec for Redis commands".into()),
    };
    if result.is_ok() {
        session.note_schema_switch(&sql).await;
        session.tx_after_statement(&sql);
    }
    result
}

#[tauri::command]
pub async fn db_cancel(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    let session = get_session(&state, &session_id).await?;
    session.cancel.lock().await.cancel();
    Ok(())
}
