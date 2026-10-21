use super::model::HBaseColumnFamily;
use super::model::HBaseShellResult;
use super::model::HBaseTableInfo;
use super::model::HBaseTableSchema;
use super::rest_operations::looks_like_missing;
use super::shell_parser::ShellCommand;
use super::shell_results::help_result;
use super::shell_results::message_result;
use super::shell_results::table_result;
use crate::hbase::native::client::NativeClient;
use crate::hbase::native::client::ResultRow;
use std::collections::BTreeMap;
pub(super) async fn native_list_tables(
    client: &NativeClient,
) -> Result<Vec<HBaseTableInfo>, String> {
    client
        .list_tables()
        .await
        .map(|names| {
            names
                .into_iter()
                .map(|name| HBaseTableInfo { name })
                .collect()
        })
        .map_err(|e| e.to_string())
}

pub(super) async fn native_describe_table(
    client: &NativeClient,
    table: &str,
) -> Result<HBaseTableSchema, String> {
    let (name, families) = client
        .describe_table(table)
        .await
        .map_err(|e| e.to_string())?;
    Ok(HBaseTableSchema {
        name,
        column_families: families
            .into_iter()
            .map(|f| HBaseColumnFamily {
                name: f.name,
                attributes: f.attributes,
            })
            .collect(),
    })
}

/// Render result-row cells into the shell's ROW/COLUMN/TIMESTAMP/VALUE table.
pub(super) fn rows_to_cell_table(raw: String, rows: Vec<ResultRow>) -> HBaseShellResult {
    let body: Vec<Vec<String>> = rows
        .into_iter()
        .map(|r| {
            vec![
                String::from_utf8_lossy(&r.row).into_owned(),
                String::from_utf8_lossy(&r.column).into_owned(),
                r.timestamp.to_string(),
                String::from_utf8_lossy(&r.value).into_owned(),
            ]
        })
        .collect();
    table_result(
        raw,
        format!("{} cell(s)", body.len()),
        vec!["ROW", "COLUMN", "TIMESTAMP", "VALUE"],
        body,
    )
}

/// Upper bound on cells scanned when emulating `count` over the native/Thrift
/// scan path (those clients do not expose a server-side row counter).
pub(super) const COUNT_SCAN_CAP: usize = 1_000_000;

/// Count distinct row keys in a set of scanned cells (cells are row-ordered).
pub(super) fn count_distinct_rows(rows: &[ResultRow]) -> usize {
    let mut count = 0usize;
    let mut last: Option<&[u8]> = None;
    for r in rows {
        if last != Some(r.row.as_slice()) {
            count += 1;
            last = Some(r.row.as_slice());
        }
    }
    count
}

/// Execute a parsed shell command against the native client.
pub(super) async fn native_execute(
    client: &NativeClient,
    command: ShellCommand,
    raw: String,
) -> Result<HBaseShellResult, String> {
    match command {
        ShellCommand::Help => Ok(help_result(raw)),
        ShellCommand::List => {
            let tables = client.list_tables().await.map_err(|e| e.to_string())?;
            Ok(table_result(
                raw,
                format!("{} table(s)", tables.len()),
                vec!["TABLE"],
                tables.into_iter().map(|name| vec![name]).collect(),
            ))
        }
        ShellCommand::Status => {
            let pairs = client.cluster_status().await.map_err(|e| e.to_string())?;
            Ok(table_result(
                raw,
                "Cluster status".into(),
                vec!["KEY", "VALUE"],
                pairs.into_iter().map(|(k, v)| vec![k, v]).collect(),
            ))
        }
        ShellCommand::Version => {
            let msg = client.ping().await.map_err(|e| e.to_string())?;
            Ok(message_result(raw, msg))
        }
        ShellCommand::Describe { table } => {
            let schema = native_describe_table(client, &table).await?;
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
            let specs: Vec<(String, BTreeMap<String, String>)> = families
                .into_iter()
                .map(|f| (f.name, f.attributes))
                .collect();
            client
                .create_table(&table, &specs)
                .await
                .map_err(|e| e.to_string())?;
            Ok(message_result(raw, format!("Created table {table}")))
        }
        ShellCommand::Drop { table } => {
            client.drop_table(&table).await.map_err(|e| e.to_string())?;
            Ok(message_result(raw, format!("Dropped table {table}")))
        }
        ShellCommand::Get { table, row, column } => {
            let rows = client
                .get(&table, row.as_bytes(), column.as_deref())
                .await
                .map_err(|e| e.to_string())?;
            Ok(rows_to_cell_table(raw, rows))
        }
        ShellCommand::Scan {
            table,
            limit,
            start_row,
            stop_row,
            columns,
        } => {
            let rows = client
                .scan(
                    &table,
                    limit,
                    start_row.as_deref().map(str::as_bytes),
                    stop_row.as_deref().map(str::as_bytes),
                    &columns,
                )
                .await
                .map_err(|e| e.to_string())?;
            Ok(rows_to_cell_table(raw, rows))
        }
        ShellCommand::Put {
            table,
            row,
            column,
            value,
        } => {
            client
                .put(&table, row.as_bytes(), &column, value.as_bytes())
                .await
                .map_err(|e| e.to_string())?;
            Ok(message_result(raw, "1 cell written".into()))
        }
        ShellCommand::Delete { table, row, column } => {
            client
                .delete(&table, row.as_bytes(), &column)
                .await
                .map_err(|e| e.to_string())?;
            Ok(message_result(raw, "Cell deleted".into()))
        }
        ShellCommand::DeleteAll { table, row } => {
            client
                .delete_all(&table, row.as_bytes())
                .await
                .map_err(|e| e.to_string())?;
            Ok(message_result(raw, "Row deleted".into()))
        }
        ShellCommand::Count { table } => {
            let display = client.qualify(&table);
            let rows = client
                .scan(&table, COUNT_SCAN_CAP, None, None, &[])
                .await
                .map_err(|e| e.to_string())?;
            let count = count_distinct_rows(&rows);
            Ok(table_result(
                raw,
                format!("{count} row(s)"),
                vec!["TABLE", "ROWS"],
                vec![vec![display, count.to_string()]],
            ))
        }
        ShellCommand::Exists { table } => {
            let display = client.qualify(&table);
            let exists = match native_describe_table(client, &table).await {
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
        ShellCommand::Enable { table } => {
            client
                .enable_table(&table)
                .await
                .map_err(|e| e.to_string())?;
            Ok(message_result(raw, format!("Enabled table {table}")))
        }
        ShellCommand::Disable { table } => {
            client
                .disable_table(&table)
                .await
                .map_err(|e| e.to_string())?;
            Ok(message_result(raw, format!("Disabled table {table}")))
        }
        ShellCommand::Alter { table, families } => {
            let specs: Vec<(String, BTreeMap<String, String>)> = families
                .into_iter()
                .map(|f| (f.name, f.attributes))
                .collect();
            let changed = client
                .alter_table(&table, &specs)
                .await
                .map_err(|e| e.to_string())?;
            Ok(message_result(
                raw,
                format!("Altered table {table} ({changed} column family change(s))"),
            ))
        }
    }
}
