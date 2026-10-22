use super::model::HBaseColumnFamily;
use super::model::HBaseShellResult;
use super::model::HBaseTableInfo;
use super::model::HBaseTableSchema;
use super::native_commands::COUNT_SCAN_CAP;
use super::native_commands::count_distinct_rows;
use super::native_commands::rows_to_cell_table;
use super::shell_parser::ShellCommand;
use super::shell_results::help_result;
use super::shell_results::message_result;
use super::shell_results::table_result;
use super::thrift;
use std::collections::BTreeMap;
// ---- thrift backend dispatch ------------------------------------------------

pub(super) async fn thrift_list_tables(
    client: &thrift::ThriftSession,
) -> Result<Vec<HBaseTableInfo>, String> {
    client.list_tables().await.map(|names| {
        names
            .into_iter()
            .map(|name| HBaseTableInfo { name })
            .collect()
    })
}

pub(super) async fn thrift_describe_table(
    client: &thrift::ThriftSession,
    table: &str,
) -> Result<HBaseTableSchema, String> {
    let (name, families) = client.describe_table(table).await?;
    Ok(HBaseTableSchema {
        name,
        column_families: families
            .into_iter()
            .map(|(name, attributes)| HBaseColumnFamily { name, attributes })
            .collect(),
    })
}

/// Execute a parsed shell command against the Thrift2 backend.
pub(super) async fn thrift_execute(
    client: &thrift::ThriftSession,
    command: ShellCommand,
    raw: String,
) -> Result<HBaseShellResult, String> {
    match command {
        ShellCommand::Help => Ok(help_result(raw)),
        ShellCommand::List => {
            let tables = client.list_tables().await?;
            Ok(table_result(
                raw,
                format!("{} table(s)", tables.len()),
                vec!["TABLE"],
                tables.into_iter().map(|name| vec![name]).collect(),
            ))
        }
        // The Thrift2 API has no cluster status/version call.
        ShellCommand::Status | ShellCommand::Version => Ok(message_result(
            raw,
            "status/version are not exposed by the HBase Thrift2 API".into(),
        )),
        ShellCommand::Describe { table } => {
            let schema = thrift_describe_table(client, &table).await?;
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
            client.create_table(&table, &specs).await?;
            Ok(message_result(raw, format!("Created table {table}")))
        }
        ShellCommand::Drop { table } => {
            client.drop_table(&table).await?;
            Ok(message_result(raw, format!("Dropped table {table}")))
        }
        ShellCommand::Get { table, row, column } => {
            let rows = client
                .get(&table, row.as_bytes(), column.as_deref())
                .await?;
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
                .await?;
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
                .await?;
            Ok(message_result(raw, "1 cell written".into()))
        }
        ShellCommand::Delete { table, row, column } => {
            client.delete(&table, row.as_bytes(), &column).await?;
            Ok(message_result(raw, "Cell deleted".into()))
        }
        ShellCommand::DeleteAll { table, row } => {
            client.delete_all(&table, row.as_bytes()).await?;
            Ok(message_result(raw, "Row deleted".into()))
        }
        ShellCommand::Count { table } => {
            let rows = client.scan(&table, COUNT_SCAN_CAP, None, None, &[]).await?;
            let count = count_distinct_rows(&rows);
            Ok(table_result(
                raw,
                format!("{count} row(s)"),
                vec!["TABLE", "ROWS"],
                vec![vec![table, count.to_string()]],
            ))
        }
        ShellCommand::Exists { table } => {
            let exists = client.table_exists(&table).await?;
            Ok(table_result(
                raw,
                format!(
                    "Table {table} {}",
                    if exists { "exists" } else { "does not exist" }
                ),
                vec!["TABLE", "EXISTS"],
                vec![vec![table, exists.to_string()]],
            ))
        }
        ShellCommand::Enable { table } => {
            client.enable_table(&table).await?;
            Ok(message_result(raw, format!("Enabled table {table}")))
        }
        ShellCommand::Disable { table } => {
            client.disable_table(&table).await?;
            Ok(message_result(raw, format!("Disabled table {table}")))
        }
        ShellCommand::Alter { table, families } => {
            let specs: Vec<(String, BTreeMap<String, String>)> = families
                .into_iter()
                .map(|f| (f.name, f.attributes))
                .collect();
            let changed = client.alter_table(&table, &specs).await?;
            Ok(message_result(
                raw,
                format!("Altered table {table} ({changed} column family change(s))"),
            ))
        }
    }
}
