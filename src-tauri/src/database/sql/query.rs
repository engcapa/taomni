use super::STREAM_BATCH_ROWS;
use super::SqlServerClient;
use super::statements::is_query;
use super::statements::needs_mysql_text_protocol;
use super::values::mysql_value_to_string;
use super::values::pg_value_to_string;
use super::values::sqlserver_column_type_name;
use super::values::sqlserver_value_to_string;
use crate::database::ColumnInfo;
use crate::database::QueryResult;
use crate::database::QueryStreamChannel;
use crate::database::QueryStreamEvent;
use crate::database::send_query_stream_event;
use futures::TryStreamExt;
use sqlx_core::column::Column;
use sqlx_core::pool::Pool;
use sqlx_core::query::query;
use sqlx_core::raw_sql::raw_sql;
use sqlx_core::row::Row;
use sqlx_core::sql_str::AssertSqlSafe;
use sqlx_core::type_info::TypeInfo;
use sqlx_mysql::MySql;
use sqlx_postgres::Postgres;
use std::time::Instant;
use tiberius::QueryItem as TdsQueryItem;
use tiberius::Row as TdsRow;
use tiberius::ToSql as TdsToSql;
use tokio::sync::Mutex as AsyncMutex;
use tokio_util::sync::CancellationToken;

pub(super) fn limit_warning(limit_reached: bool, max_rows: Option<u64>) -> Vec<String> {
    match (limit_reached, max_rows) {
        (true, Some(limit)) => vec![format!("Result limited to {limit} rows")],
        _ => Vec::new(),
    }
}

pub(super) async fn sqlserver_fetch(
    client: &AsyncMutex<SqlServerClient>,
    sql: &str,
    params: &[&dyn TdsToSql],
) -> Result<Vec<TdsRow>, String> {
    let mut guard = client.lock().await;
    let stream = guard
        .query(sql, params)
        .await
        .map_err(|e| format!("Query failed: {e}"))?;
    stream
        .into_first_result()
        .await
        .map_err(|e| format!("Query failed: {e}"))
}

pub(super) async fn sqlserver_query_result(
    client: &AsyncMutex<SqlServerClient>,
    sql: &str,
    max_rows: Option<u64>,
    token: &CancellationToken,
) -> Result<(Vec<ColumnInfo>, Vec<Vec<Option<String>>>, bool), String> {
    let max_rows = max_rows.filter(|value| *value > 0);
    let run = async {
        let mut guard = client.lock().await;
        let mut stream = guard
            .simple_query(sql)
            .await
            .map_err(|e| format!("Query failed: {e}"))?;
        let mut columns: Vec<ColumnInfo> = Vec::new();
        let mut rows: Vec<Vec<Option<String>>> = Vec::new();
        let mut first_result_index: Option<usize> = None;
        let mut limit_reached = false;

        while let Some(item) = stream
            .try_next()
            .await
            .map_err(|e| format!("Query failed: {e}"))?
        {
            match item {
                TdsQueryItem::Metadata(meta) => {
                    if first_result_index.is_some() {
                        break;
                    }
                    first_result_index = Some(meta.result_index());
                    columns = meta
                        .columns()
                        .iter()
                        .map(|c| ColumnInfo {
                            name: c.name().to_string(),
                            type_name: sqlserver_column_type_name(c.column_type()).to_string(),
                        })
                        .collect();
                }
                TdsQueryItem::Row(row) => {
                    let row_result_index = row.result_index();
                    if let Some(index) = first_result_index {
                        if row_result_index != index {
                            break;
                        }
                    } else {
                        first_result_index = Some(row_result_index);
                    }
                    if columns.is_empty() {
                        columns = row
                            .columns()
                            .iter()
                            .map(|c| ColumnInfo {
                                name: c.name().to_string(),
                                type_name: sqlserver_column_type_name(c.column_type()).to_string(),
                            })
                            .collect();
                    }
                    if max_rows.is_some_and(|limit| rows.len() as u64 >= limit) {
                        limit_reached = true;
                        break;
                    }
                    rows.push(
                        (0..row.len())
                            .map(|i| sqlserver_value_to_string(&row, i))
                            .collect(),
                    );
                }
            }
        }
        Ok((columns, rows, limit_reached))
    };
    tokio::select! {
        _ = token.cancelled() => Err("Query cancelled".into()),
        r = run => r,
    }
}

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------

pub async fn execute_mysql(
    pool: &Pool<MySql>,
    sql: &str,
    token: &CancellationToken,
) -> Result<QueryResult, String> {
    let start = Instant::now();
    if is_query(sql) {
        let fetch = query(AssertSqlSafe(sql)).fetch_all(pool);
        let rows = tokio::select! {
            _ = token.cancelled() => return Err("Query cancelled".into()),
            r = fetch => r.map_err(|e| format!("Query failed: {e}"))?,
        };
        let columns = if let Some(first) = rows.first() {
            first
                .columns()
                .iter()
                .map(|c| ColumnInfo {
                    name: c.name().to_string(),
                    type_name: c.type_info().name().to_string(),
                })
                .collect()
        } else {
            Vec::new()
        };
        let mut out_rows = Vec::with_capacity(rows.len());
        for row in &rows {
            let mut vals = Vec::with_capacity(row.columns().len());
            for i in 0..row.columns().len() {
                vals.push(mysql_value_to_string(row, i));
            }
            out_rows.push(vals);
        }
        Ok(QueryResult {
            columns,
            rows_affected: 0,
            rows: out_rows,
            duration_ms: start.elapsed().as_millis() as u64,
            warnings: Vec::new(),
        })
    } else if needs_mysql_text_protocol(sql) {
        // MySQL rejects USE (and a few admin commands) on COM_STMT_PREPARE with
        // 1295 HY000. Text protocol via raw_sql is required.
        let exec = raw_sql(AssertSqlSafe(sql)).execute(pool);
        let res = tokio::select! {
            _ = token.cancelled() => return Err("Query cancelled".into()),
            r = exec => r.map_err(|e| format!("Statement failed: {e}"))?,
        };
        Ok(QueryResult {
            columns: Vec::new(),
            rows: Vec::new(),
            rows_affected: res.rows_affected(),
            duration_ms: start.elapsed().as_millis() as u64,
            warnings: Vec::new(),
        })
    } else {
        let exec = query(AssertSqlSafe(sql)).execute(pool);
        let res = tokio::select! {
            _ = token.cancelled() => return Err("Query cancelled".into()),
            r = exec => r.map_err(|e| format!("Statement failed: {e}"))?,
        };
        Ok(QueryResult {
            columns: Vec::new(),
            rows: Vec::new(),
            rows_affected: res.rows_affected(),
            duration_ms: start.elapsed().as_millis() as u64,
            warnings: Vec::new(),
        })
    }
}

pub async fn execute_postgres(
    pool: &Pool<Postgres>,
    sql: &str,
    token: &CancellationToken,
) -> Result<QueryResult, String> {
    let start = Instant::now();
    if is_query(sql) {
        let fetch = query(AssertSqlSafe(sql)).fetch_all(pool);
        let rows = tokio::select! {
            _ = token.cancelled() => return Err("Query cancelled".into()),
            r = fetch => r.map_err(|e| format!("Query failed: {e}"))?,
        };
        let columns = if let Some(first) = rows.first() {
            first
                .columns()
                .iter()
                .map(|c| ColumnInfo {
                    name: c.name().to_string(),
                    type_name: c.type_info().name().to_string(),
                })
                .collect()
        } else {
            Vec::new()
        };
        let mut out_rows = Vec::with_capacity(rows.len());
        for row in &rows {
            let mut vals = Vec::with_capacity(row.columns().len());
            for i in 0..row.columns().len() {
                vals.push(pg_value_to_string(row, i));
            }
            out_rows.push(vals);
        }
        Ok(QueryResult {
            columns,
            rows_affected: 0,
            rows: out_rows,
            duration_ms: start.elapsed().as_millis() as u64,
            warnings: Vec::new(),
        })
    } else {
        let exec = query(AssertSqlSafe(sql)).execute(pool);
        let res = tokio::select! {
            _ = token.cancelled() => return Err("Query cancelled".into()),
            r = exec => r.map_err(|e| format!("Statement failed: {e}"))?,
        };
        Ok(QueryResult {
            columns: Vec::new(),
            rows: Vec::new(),
            rows_affected: res.rows_affected(),
            duration_ms: start.elapsed().as_millis() as u64,
            warnings: Vec::new(),
        })
    }
}

pub async fn execute_sqlserver(
    client: &AsyncMutex<SqlServerClient>,
    sql: &str,
    token: &CancellationToken,
) -> Result<QueryResult, String> {
    let start = Instant::now();
    if is_query(sql) {
        let (columns, rows, _limit_reached) =
            sqlserver_query_result(client, sql, None, token).await?;
        Ok(QueryResult {
            columns,
            rows_affected: 0,
            rows,
            duration_ms: start.elapsed().as_millis() as u64,
            warnings: Vec::new(),
        })
    } else {
        let run = async {
            let mut guard = client.lock().await;
            guard
                .execute(sql, &[])
                .await
                .map(|res| res.total())
                .map_err(|e| format!("Statement failed: {e}"))
        };
        let rows_affected = tokio::select! {
            _ = token.cancelled() => return Err("Query cancelled".into()),
            r = run => r?,
        };
        Ok(QueryResult {
            columns: Vec::new(),
            rows: Vec::new(),
            rows_affected,
            duration_ms: start.elapsed().as_millis() as u64,
            warnings: Vec::new(),
        })
    }
}

pub async fn execute_mysql_stream(
    pool: &Pool<MySql>,
    sql: &str,
    max_rows: Option<u64>,
    token: &CancellationToken,
    on_event: &QueryStreamChannel,
) -> Result<(), String> {
    let start = Instant::now();
    if is_query(sql) {
        let mut stream = query(AssertSqlSafe(sql)).fetch(pool);
        let mut columns_sent = false;
        let mut row_count = 0_u64;
        let max_rows = max_rows.filter(|value| *value > 0);
        let mut limit_reached = false;
        let mut batch: Vec<Vec<Option<String>>> = Vec::with_capacity(STREAM_BATCH_ROWS);

        loop {
            if max_rows.is_some_and(|limit| row_count >= limit) {
                limit_reached = true;
                break;
            }
            let next = tokio::select! {
                _ = token.cancelled() => return Err("Query cancelled".into()),
                r = stream.try_next() => r.map_err(|e| format!("Query failed: {e}"))?,
            };
            let Some(row) = next else {
                break;
            };

            if !columns_sent {
                let columns = row
                    .columns()
                    .iter()
                    .map(|c| ColumnInfo {
                        name: c.name().to_string(),
                        type_name: c.type_info().name().to_string(),
                    })
                    .collect();
                send_query_stream_event(on_event, QueryStreamEvent::Columns { columns })?;
                columns_sent = true;
            }

            let mut vals = Vec::with_capacity(row.columns().len());
            for i in 0..row.columns().len() {
                vals.push(mysql_value_to_string(&row, i));
            }
            batch.push(vals);
            row_count += 1;
            if batch.len() >= STREAM_BATCH_ROWS {
                send_query_stream_event(
                    on_event,
                    QueryStreamEvent::Rows {
                        rows: std::mem::take(&mut batch),
                    },
                )?;
            }
        }

        if !batch.is_empty() {
            send_query_stream_event(on_event, QueryStreamEvent::Rows { rows: batch })?;
        }
        send_query_stream_event(
            on_event,
            QueryStreamEvent::Done {
                rows_affected: 0,
                duration_ms: start.elapsed().as_millis() as u64,
                warnings: limit_warning(limit_reached, max_rows),
            },
        )
    } else if needs_mysql_text_protocol(sql) {
        let exec = raw_sql(AssertSqlSafe(sql)).execute(pool);
        let res = tokio::select! {
            _ = token.cancelled() => return Err("Query cancelled".into()),
            r = exec => r.map_err(|e| format!("Statement failed: {e}"))?,
        };
        send_query_stream_event(
            on_event,
            QueryStreamEvent::Done {
                rows_affected: res.rows_affected(),
                duration_ms: start.elapsed().as_millis() as u64,
                warnings: Vec::new(),
            },
        )
    } else {
        let exec = query(AssertSqlSafe(sql)).execute(pool);
        let res = tokio::select! {
            _ = token.cancelled() => return Err("Query cancelled".into()),
            r = exec => r.map_err(|e| format!("Statement failed: {e}"))?,
        };
        send_query_stream_event(
            on_event,
            QueryStreamEvent::Done {
                rows_affected: res.rows_affected(),
                duration_ms: start.elapsed().as_millis() as u64,
                warnings: Vec::new(),
            },
        )
    }
}

pub async fn execute_postgres_stream(
    pool: &Pool<Postgres>,
    sql: &str,
    max_rows: Option<u64>,
    token: &CancellationToken,
    on_event: &QueryStreamChannel,
) -> Result<(), String> {
    let start = Instant::now();
    if is_query(sql) {
        let mut stream = query(AssertSqlSafe(sql)).fetch(pool);
        let mut columns_sent = false;
        let mut row_count = 0_u64;
        let max_rows = max_rows.filter(|value| *value > 0);
        let mut limit_reached = false;
        let mut batch: Vec<Vec<Option<String>>> = Vec::with_capacity(STREAM_BATCH_ROWS);

        loop {
            if max_rows.is_some_and(|limit| row_count >= limit) {
                limit_reached = true;
                break;
            }
            let next = tokio::select! {
                _ = token.cancelled() => return Err("Query cancelled".into()),
                r = stream.try_next() => r.map_err(|e| format!("Query failed: {e}"))?,
            };
            let Some(row) = next else {
                break;
            };

            if !columns_sent {
                let columns = row
                    .columns()
                    .iter()
                    .map(|c| ColumnInfo {
                        name: c.name().to_string(),
                        type_name: c.type_info().name().to_string(),
                    })
                    .collect();
                send_query_stream_event(on_event, QueryStreamEvent::Columns { columns })?;
                columns_sent = true;
            }

            let mut vals = Vec::with_capacity(row.columns().len());
            for i in 0..row.columns().len() {
                vals.push(pg_value_to_string(&row, i));
            }
            batch.push(vals);
            row_count += 1;
            if batch.len() >= STREAM_BATCH_ROWS {
                send_query_stream_event(
                    on_event,
                    QueryStreamEvent::Rows {
                        rows: std::mem::take(&mut batch),
                    },
                )?;
            }
        }

        if !batch.is_empty() {
            send_query_stream_event(on_event, QueryStreamEvent::Rows { rows: batch })?;
        }
        send_query_stream_event(
            on_event,
            QueryStreamEvent::Done {
                rows_affected: 0,
                duration_ms: start.elapsed().as_millis() as u64,
                warnings: limit_warning(limit_reached, max_rows),
            },
        )
    } else {
        let exec = query(AssertSqlSafe(sql)).execute(pool);
        let res = tokio::select! {
            _ = token.cancelled() => return Err("Query cancelled".into()),
            r = exec => r.map_err(|e| format!("Statement failed: {e}"))?,
        };
        send_query_stream_event(
            on_event,
            QueryStreamEvent::Done {
                rows_affected: res.rows_affected(),
                duration_ms: start.elapsed().as_millis() as u64,
                warnings: Vec::new(),
            },
        )
    }
}

pub async fn execute_sqlserver_stream(
    client: &AsyncMutex<SqlServerClient>,
    sql: &str,
    max_rows: Option<u64>,
    token: &CancellationToken,
    on_event: &QueryStreamChannel,
) -> Result<(), String> {
    let start = Instant::now();
    if is_query(sql) {
        let (columns, rows, limit_reached) =
            sqlserver_query_result(client, sql, max_rows, token).await?;
        if !columns.is_empty() {
            send_query_stream_event(on_event, QueryStreamEvent::Columns { columns })?;
        }
        for batch in rows.chunks(STREAM_BATCH_ROWS) {
            send_query_stream_event(
                on_event,
                QueryStreamEvent::Rows {
                    rows: batch.to_vec(),
                },
            )?;
        }
        send_query_stream_event(
            on_event,
            QueryStreamEvent::Done {
                rows_affected: 0,
                duration_ms: start.elapsed().as_millis() as u64,
                warnings: limit_warning(limit_reached, max_rows.filter(|value| *value > 0)),
            },
        )
    } else {
        let run = async {
            let mut guard = client.lock().await;
            guard
                .execute(sql, &[])
                .await
                .map(|res| res.total())
                .map_err(|e| format!("Statement failed: {e}"))
        };
        let rows_affected = tokio::select! {
            _ = token.cancelled() => return Err("Query cancelled".into()),
            r = run => r?,
        };
        send_query_stream_event(
            on_event,
            QueryStreamEvent::Done {
                rows_affected,
                duration_ms: start.elapsed().as_millis() as u64,
                warnings: Vec::new(),
            },
        )
    }
}
