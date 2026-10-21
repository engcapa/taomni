use super::connection::PanWeiClient;
use crate::database::ColumnInfo;
use crate::database::QueryResult;
use crate::database::QueryStreamChannel;
use crate::database::emit_query_result_stream;
use std::time::Instant;
use tokio_opengauss::NoTls;
use tokio_opengauss::Row as OgRow;
use tokio_opengauss::SimpleQueryMessage;
use tokio_opengauss::types::ToSql;
use tokio_util::sync::CancellationToken;

pub(super) fn simple_messages_to_result(
    messages: Vec<SimpleQueryMessage>,
    start: Instant,
) -> QueryResult {
    let mut columns = Vec::new();
    let mut rows = Vec::new();
    let mut rows_affected = 0;
    let mut warnings = Vec::new();

    for message in messages {
        match message {
            SimpleQueryMessage::Row(row) => {
                let row_columns: Vec<ColumnInfo> = row
                    .columns()
                    .iter()
                    .map(|c| ColumnInfo {
                        name: c.name().to_string(),
                        type_name: "text".to_string(),
                    })
                    .collect();
                if columns.is_empty() {
                    columns = row_columns;
                } else if columns.len() != row_columns.len()
                    || columns
                        .iter()
                        .zip(&row_columns)
                        .any(|(a, b)| a.name != b.name)
                {
                    warnings.push(
                        "Multiple result sets with different columns were flattened into one grid."
                            .to_string(),
                    );
                }

                let values = (0..row.len())
                    .map(|index| {
                        row.try_get(index)
                            .ok()
                            .flatten()
                            .map(|value| value.to_string())
                    })
                    .collect();
                rows.push(values);
            }
            SimpleQueryMessage::CommandComplete(count) => {
                rows_affected += count;
            }
            _ => {}
        }
    }

    QueryResult {
        rows_affected: if columns.is_empty() { rows_affected } else { 0 },
        columns,
        rows,
        duration_ms: start.elapsed().as_millis() as u64,
        warnings,
    }
}

pub(super) async fn fetch(
    client: &PanWeiClient,
    sql: &str,
    params: &[&(dyn ToSql + Sync)],
) -> Result<Vec<OgRow>, String> {
    let guard = client.inner.client.lock().await;
    guard
        .query(sql, params)
        .await
        .map_err(|e| format!("Query failed: {e}"))
}

pub(super) async fn fetch_optional(
    client: &PanWeiClient,
    sql: &str,
    params: &[&(dyn ToSql + Sync)],
) -> Result<Option<OgRow>, String> {
    let guard = client.inner.client.lock().await;
    guard
        .query_opt(sql, params)
        .await
        .map_err(|e| format!("Query failed: {e}"))
}

pub async fn execute(
    client: &PanWeiClient,
    sql: &str,
    token: &CancellationToken,
) -> Result<QueryResult, String> {
    let start = Instant::now();
    let guard = client.inner.client.lock().await;
    let cancel = guard.cancel_token();
    let run = guard.simple_query(sql);
    tokio::pin!(run);
    let messages = tokio::select! {
        _ = token.cancelled() => {
            let _ = cancel.cancel_query(NoTls).await;
            return Err("Query cancelled".into());
        }
        r = &mut run => r.map_err(|e| format!("Query failed: {e}"))?,
    };
    Ok(simple_messages_to_result(messages, start))
}

pub async fn execute_stream(
    client: &PanWeiClient,
    sql: &str,
    max_rows: Option<u64>,
    token: &CancellationToken,
    on_event: &QueryStreamChannel,
) -> Result<(), String> {
    let mut result = execute(client, sql, token).await?;
    if let Some(limit) = max_rows.filter(|value| *value > 0) {
        if result.rows.len() as u64 > limit {
            result.rows.truncate(limit as usize);
            result
                .warnings
                .push(format!("Result limited to {limit} rows"));
        }
    }
    emit_query_result_stream(on_event, result)
}
