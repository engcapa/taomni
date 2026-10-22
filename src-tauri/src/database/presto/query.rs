use super::model::PrestoClient;
use super::model::StatementOutcome;
use super::statements::apply_use_statement_hint;
use super::stream_state::StreamState;
use super::transport::delete_uri;
use super::transport::get_next;
use super::transport::get_next_with_context;
use super::transport::post_statement;
use super::transport::post_statement_with_context;
use super::transport::set_current_next_uri;
use super::values::format_presto_error;
use super::values::json_cell_to_string;
use super::values::presto_columns;
use crate::database::QueryResult;
use crate::database::QueryStreamChannel;
use std::time::Instant;
use tokio_util::sync::CancellationToken;

pub(super) async fn run_statement(
    client: &PrestoClient,
    sql: &str,
    max_rows: Option<u64>,
    token: &CancellationToken,
    track_cancel: bool,
) -> Result<StatementOutcome, String> {
    run_statement_with_context(client, sql, max_rows, token, track_cancel, None, None).await
}

pub(super) async fn run_statement_with_context(
    client: &PrestoClient,
    sql: &str,
    max_rows: Option<u64>,
    token: &CancellationToken,
    track_cancel: bool,
    catalog_override: Option<&str>,
    schema_override: Option<&str>,
) -> Result<StatementOutcome, String> {
    let start = Instant::now();
    let mut columns = Vec::new();
    let mut rows = Vec::new();
    let mut rows_affected = 0_u64;
    let mut limit_reached = false;
    let max_rows = max_rows.filter(|value| *value > 0);

    let first = post_statement_with_context(
        client,
        sql,
        token,
        track_cancel,
        catalog_override,
        schema_override,
    )
    .await?;
    if let Some(error) = first.error {
        return Err(format_presto_error(error));
    }
    if !first.columns.is_empty() {
        columns = presto_columns(first.columns);
    }
    if let Some(update_count) = first.update_count {
        rows_affected = update_count;
    }
    for row in first.data {
        if max_rows.is_some_and(|limit| rows.len() as u64 >= limit) {
            limit_reached = true;
            break;
        }
        rows.push(row.iter().map(json_cell_to_string).collect());
    }
    let mut next = first.next_uri;

    while let Some(uri) = next {
        if limit_reached {
            delete_uri(client, &uri).await?;
            break;
        }
        let result = get_next_with_context(
            client,
            &uri,
            token,
            track_cancel,
            catalog_override,
            schema_override,
        )
        .await?;
        if let Some(error) = result.error {
            return Err(format_presto_error(error));
        }
        if columns.is_empty() && !result.columns.is_empty() {
            columns = presto_columns(result.columns);
        }
        if let Some(update_count) = result.update_count {
            rows_affected = update_count;
        }
        for row in result.data {
            if max_rows.is_some_and(|limit| rows.len() as u64 >= limit) {
                limit_reached = true;
                break;
            }
            rows.push(row.iter().map(json_cell_to_string).collect());
        }
        next = result.next_uri;
    }

    if track_cancel {
        set_current_next_uri(client, None).await;
    }
    Ok(StatementOutcome {
        result: QueryResult {
            columns,
            rows,
            rows_affected,
            duration_ms: start.elapsed().as_millis() as u64,
            warnings: match (limit_reached, max_rows) {
                (true, Some(limit)) => vec![format!("Result limited to {limit} rows")],
                _ => Vec::new(),
            },
        },
    })
}

pub async fn ping(client: &PrestoClient) -> Result<String, String> {
    let token = CancellationToken::new();
    run_statement(client, "SELECT 1", Some(1), &token, false).await?;
    Ok("Presto connection OK".into())
}

pub async fn execute(
    client: &PrestoClient,
    sql: &str,
    token: &CancellationToken,
) -> Result<QueryResult, String> {
    let result = run_statement(client, sql, None, token, true).await?.result;
    apply_use_statement_hint(client, sql).await;
    Ok(result)
}

pub async fn execute_stream(
    client: &PrestoClient,
    sql: &str,
    max_rows: Option<u64>,
    token: &CancellationToken,
    on_event: &QueryStreamChannel,
) -> Result<(), String> {
    let start = Instant::now();
    let mut state = StreamState::new(max_rows);
    let first = post_statement(client, sql, token, true).await?;
    let mut next = first.next_uri.clone();
    if !state.consume_results(first, on_event)? {
        if let Some(uri) = next {
            delete_uri(client, &uri).await?;
        }
        set_current_next_uri(client, None).await;
        return state.finish(on_event, start.elapsed().as_millis() as u64);
    }

    while let Some(uri) = next {
        let result = get_next(client, &uri, token, true).await?;
        next = result.next_uri.clone();
        if !state.consume_results(result, on_event)? {
            if let Some(uri) = next {
                delete_uri(client, &uri).await?;
            }
            break;
        }
    }

    set_current_next_uri(client, None).await;
    apply_use_statement_hint(client, sql).await;
    state.finish(on_event, start.elapsed().as_millis() as u64)
}
