use super::model::HBaseShellResult;
use super::rest_catalog::describe_table;
use super::rest_catalog::list_tables;
use super::rest_http::describe_request_error;
use super::rest_http::get_json;
use super::rest_http::response_json;
use super::rest_http::send_json;
use super::rest_session::RestSession;
use super::shell_parser::ShellCommand;
use super::shell_results::b64;
use super::shell_results::cellset_body;
use super::shell_results::cellset_rows;
use super::shell_results::enc;
use super::shell_results::help_result;
use super::shell_results::message_result;
use super::shell_results::table_result;
use super::shell_results::value_result;
use reqwest::Method;
use reqwest::StatusCode;
use reqwest::header::CONTENT_TYPE;
use reqwest::header::HeaderMap;
use reqwest::header::LOCATION;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;
pub(super) async fn execute_command(
    session: &RestSession,
    command: ShellCommand,
    raw: String,
) -> Result<HBaseShellResult, String> {
    match command {
        ShellCommand::Help => Ok(help_result(raw)),
        ShellCommand::List => {
            let tables = list_tables(session).await?;
            Ok(table_result(
                raw,
                format!("{} table(s)", tables.len()),
                vec!["TABLE"],
                tables.into_iter().map(|t| vec![t.name]).collect(),
            ))
        }
        ShellCommand::Status => {
            let value = get_json(session, "/status/cluster?format=json").await?;
            Ok(value_result(raw, "Cluster status".into(), &value))
        }
        ShellCommand::Version => {
            let value = get_json(session, "/version/cluster?format=json").await?;
            Ok(value_result(raw, "Cluster version".into(), &value))
        }
        ShellCommand::Describe { table } => {
            let schema = describe_table(session, &table).await?;
            let rows = schema
                .column_families
                .into_iter()
                .map(|family| {
                    vec![
                        family.name,
                        family
                            .attributes
                            .into_iter()
                            .map(|(k, v)| format!("{k}={v}"))
                            .collect::<Vec<_>>()
                            .join(", "),
                    ]
                })
                .collect::<Vec<_>>();
            Ok(table_result(
                raw,
                format!("Schema for {}", schema.name),
                vec!["COLUMN FAMILY", "ATTRIBUTES"],
                rows,
            ))
        }
        ShellCommand::Create { table, families } => {
            let table = session.table_name(&table);
            let families_json = families
                .into_iter()
                .map(|family| {
                    let mut obj = Map::new();
                    obj.insert("name".into(), Value::String(family.name));
                    for (key, value) in family.attributes {
                        obj.insert(key, Value::String(value));
                    }
                    Value::Object(obj)
                })
                .collect::<Vec<_>>();
            let body = json!({
                "name": table,
                "ColumnSchema": families_json,
            });
            let path = format!("/{}/schema", enc(&table));
            send_json(session, Method::PUT, &path, Some(body)).await?;
            Ok(message_result(
                raw,
                format!("Created or updated table {table}"),
            ))
        }
        ShellCommand::Drop { table } => {
            let table = session.table_name(&table);
            let path = format!("/{}/schema", enc(&table));
            send_json(session, Method::DELETE, &path, None).await?;
            Ok(message_result(raw, format!("Dropped table {table}")))
        }
        ShellCommand::Get { table, row, column } => {
            let table = session.table_name(&table);
            let path = match column.as_deref() {
                Some(column) => {
                    format!("/{}/{}/{}?format=json", enc(&table), enc(&row), enc(column))
                }
                None => format!("/{}/{}?format=json", enc(&table), enc(&row)),
            };
            let value = get_json(session, &path).await?;
            let rows = cellset_rows(&value);
            Ok(table_result(
                raw,
                format!("{} cell(s)", rows.len()),
                vec!["ROW", "COLUMN", "TIMESTAMP", "VALUE"],
                rows,
            ))
        }
        ShellCommand::Scan {
            table,
            limit,
            start_row,
            stop_row,
            columns,
        } => {
            let table = session.table_name(&table);
            let rows = scan_table(session, &table, limit, start_row, stop_row, columns).await?;
            Ok(table_result(
                raw,
                format!("{} cell(s)", rows.len()),
                vec!["ROW", "COLUMN", "TIMESTAMP", "VALUE"],
                rows,
            ))
        }
        ShellCommand::Put {
            table,
            row,
            column,
            value,
        } => {
            let table = session.table_name(&table);
            let body = cellset_body(&row, &column, &value);
            let path = format!("/{}/{}/{}", enc(&table), enc(&row), enc(&column));
            send_json(session, Method::PUT, &path, Some(body)).await?;
            Ok(message_result(raw, "1 cell written".into()))
        }
        ShellCommand::Delete { table, row, column } => {
            let table = session.table_name(&table);
            let path = format!("/{}/{}/{}", enc(&table), enc(&row), enc(&column));
            send_json(session, Method::DELETE, &path, None).await?;
            Ok(message_result(raw, "Cell deleted".into()))
        }
        ShellCommand::DeleteAll { table, row } => {
            let table = session.table_name(&table);
            let path = format!("/{}/{}", enc(&table), enc(&row));
            send_json(session, Method::DELETE, &path, None).await?;
            Ok(message_result(raw, "Row deleted".into()))
        }
        ShellCommand::Count { table } => {
            let display = session.table_name(&table);
            let count = count_table(session, &table).await?;
            Ok(table_result(
                raw,
                format!("{count} row(s)"),
                vec!["TABLE", "ROWS"],
                vec![vec![display, count.to_string()]],
            ))
        }
        ShellCommand::Exists { table } => {
            let display = session.table_name(&table);
            let exists = match describe_table(session, &table).await {
                Ok(_) => true,
                Err(e) if looks_like_missing(&e) => false,
                Err(e) => return Err(e),
            };
            Ok(table_result(
                raw,
                format!(
                    "Table {display} {}",
                    if exists { "exists" } else { "does not exist" }
                ),
                vec!["TABLE", "EXISTS"],
                vec![vec![display, exists.to_string()]],
            ))
        }
        ShellCommand::Enable { .. } | ShellCommand::Disable { .. } | ShellCommand::Alter { .. } => {
            Err(rest_admin_unsupported(&raw))
        }
    }
}

/// `enable`/`disable`/`alter` require the HBase Admin API, which the REST
/// (Stargate) gateway does not expose. Surface a clear, actionable message.
pub(super) fn rest_admin_unsupported(raw: &str) -> String {
    let verb = raw.split_whitespace().next().unwrap_or("This command");
    format!(
        "`{verb}` is not supported by the HBase REST (Stargate) transport. \
         Use a Native (ZooKeeper/RPC) or Thrift connection to run admin commands."
    )
}

/// True when an error message indicates a table is missing (used by `exists`).
pub(super) fn looks_like_missing(msg: &str) -> bool {
    let m = msg.to_ascii_lowercase();
    m.contains("not found")
        || m.contains("404")
        || m.contains("tablenotfound")
        || m.contains("does not exist")
        || m.contains("not exist")
}

/// Count rows in a table over the REST scanner.
///
/// Uses a `FirstKeyOnlyFilter` so the server returns at most one cell per row
/// (minimal payload), then pages the scanner counting distinct row keys. Falls
/// back to an unfiltered scan if the gateway rejects the filter. Capped to keep
/// a runaway scan bounded.
pub(super) async fn count_table(session: &RestSession, table: &str) -> Result<usize, String> {
    const PAGE_CAP: usize = 1_000_000;
    let table = session.table_name(table);
    let batch = 1000;

    let make_spec = |with_filter: bool| -> Value {
        let mut spec = Map::new();
        spec.insert("batch".into(), json!(batch));
        spec.insert("caching".into(), json!(batch));
        if with_filter {
            spec.insert("filter".into(), json!("{\"type\": \"FirstKeyOnlyFilter\"}"));
        }
        Value::Object(spec)
    };

    let path = format!("/{}/scanner", enc(&table));
    let location = match create_scanner(session, &path, make_spec(true)).await {
        Ok(loc) => loc,
        Err(_) => create_scanner(session, &path, make_spec(false)).await?,
    };

    let mut count = 0usize;
    let mut last_row: Option<String> = None;
    for _ in 0..PAGE_CAP {
        let resp = session
            .request(Method::GET, location.clone())
            .send()
            .await
            .map_err(|e| describe_request_error("HBase scanner read failed", &e))?;
        if resp.status() == StatusCode::NO_CONTENT {
            break;
        }
        let value = response_json(resp).await?;
        let rows = cellset_rows(&value);
        if rows.is_empty() {
            break;
        }
        for r in &rows {
            let rk = r.first().cloned().unwrap_or_default();
            if last_row.as_deref() != Some(rk.as_str()) {
                count += 1;
                last_row = Some(rk);
            }
        }
        if count >= PAGE_CAP {
            break;
        }
    }
    let _ = session.request(Method::DELETE, location).send().await;
    Ok(count)
}

pub(super) async fn scan_table(
    session: &RestSession,
    table: &str,
    limit: usize,
    start_row: Option<String>,
    stop_row: Option<String>,
    columns: Vec<String>,
) -> Result<Vec<Vec<String>>, String> {
    let batch = limit.clamp(1, 1000);
    let mut spec = Map::new();
    spec.insert("batch".into(), json!(batch));
    spec.insert("caching".into(), json!(batch));
    if let Some(row) = start_row.as_deref().filter(|s| !s.is_empty()) {
        spec.insert("startRow".into(), json!(b64(row)));
    }
    if let Some(row) = stop_row.as_deref().filter(|s| !s.is_empty()) {
        spec.insert("endRow".into(), json!(b64(row)));
    }
    if !columns.is_empty() {
        spec.insert(
            "column".into(),
            Value::Array(columns.iter().map(|column| json!(b64(column))).collect()),
        );
    }

    let path = format!("/{}/scanner", enc(table));
    match create_scanner(session, &path, Value::Object(spec)).await {
        Ok(location) => read_scanner(session, &location, limit).await,
        Err(err) => {
            let rows = scan_wildcard(session, table, limit).await?;
            if rows.is_empty() { Err(err) } else { Ok(rows) }
        }
    }
}

pub(super) async fn create_scanner(
    session: &RestSession,
    path: &str,
    body: Value,
) -> Result<String, String> {
    let resp = session
        .request(Method::PUT, session.url(path))
        .header(CONTENT_TYPE, "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| describe_request_error("HBase scanner create failed", &e))?;
    let status = resp.status();
    let headers = resp.headers().clone();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!(
            "HBase scanner create error ({status}): {}",
            text.trim()
        ));
    }
    scanner_location(&session.base_url, &headers)
        .ok_or_else(|| "HBase scanner response did not include a Location header".into())
}

pub(super) async fn read_scanner(
    session: &RestSession,
    location: &str,
    limit: usize,
) -> Result<Vec<Vec<String>>, String> {
    let mut rows = Vec::new();
    for _ in 0..1000 {
        if rows.len() >= limit {
            break;
        }
        let resp = session
            .request(Method::GET, location.to_string())
            .send()
            .await
            .map_err(|e| describe_request_error("HBase scanner read failed", &e))?;
        if resp.status() == StatusCode::NO_CONTENT {
            break;
        }
        let value = response_json(resp).await?;
        let mut next = cellset_rows(&value);
        if next.is_empty() {
            break;
        }
        let remaining = limit.saturating_sub(rows.len());
        let take = remaining.min(next.len());
        rows.extend(next.drain(..take));
    }
    let _ = session
        .request(Method::DELETE, location.to_string())
        .send()
        .await;
    Ok(rows)
}

pub(super) fn scanner_location(base_url: &str, headers: &HeaderMap) -> Option<String> {
    let raw = headers.get(LOCATION)?.to_str().ok()?.trim();
    if raw.starts_with("http://") || raw.starts_with("https://") {
        Some(raw.to_string())
    } else if raw.starts_with('/') {
        let scheme_end = base_url.find("://").map(|index| index + 3)?;
        let origin_end = base_url[scheme_end..]
            .find('/')
            .map(|index| scheme_end + index)
            .unwrap_or(base_url.len());
        Some(format!("{}{}", &base_url[..origin_end], raw))
    } else {
        Some(format!("{base_url}/{raw}"))
    }
}

pub(super) async fn scan_wildcard(
    session: &RestSession,
    table: &str,
    limit: usize,
) -> Result<Vec<Vec<String>>, String> {
    let path = format!("/{}/%2A?limit={}&format=json", enc(table), limit);
    let value = get_json(session, &path).await?;
    Ok(cellset_rows(&value).into_iter().take(limit).collect())
}
