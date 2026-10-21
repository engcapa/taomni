use super::query::execute_mysql;
use super::schema_helpers::group_indexes;
use super::schema_helpers::mysql_qualified;
use super::schema_helpers::quote_mysql_ident;
use super::schema_helpers::quote_mysql_table;
use super::values::mysql_value_to_string;
use crate::database::ColumnDescription;
use crate::database::DbObject;
use crate::database::ForeignKeyInfo;
use crate::database::IndexInfo;
use crate::database::QueryResult;
use crate::database::SchemaInfo;
use crate::database::TableInfo;
use crate::database::group_foreign_keys;
use sqlx_core::Error as SqlxError;
use sqlx_core::pool::Pool;
use sqlx_core::query::query;
use sqlx_core::row::Row;
use sqlx_core::sql_str::AssertSqlSafe;
use sqlx_mysql::MySql;
use sqlx_mysql::MySqlRow;
use std::collections::BTreeMap;
use std::collections::BTreeSet;
use tokio_util::sync::CancellationToken;

pub(super) fn add_mysql_schema_name(names: &mut BTreeSet<String>, name: Option<String>) {
    if let Some(name) = name.map(|n| n.trim().to_string()) {
        if !name.is_empty() {
            names.insert(name);
        }
    }
}

pub(super) async fn current_mysql_database(
    pool: &Pool<MySql>,
) -> Result<Option<String>, SqlxError> {
    query("SELECT DATABASE()")
        .fetch_optional(pool)
        .await?
        .and_then(|r| r.try_get::<Option<String>, _>(0).ok().flatten())
        .map_or(Ok(None), |db| Ok(Some(db)))
}

pub(super) async fn list_schemas_mysql_show(pool: &Pool<MySql>) -> Result<Vec<String>, SqlxError> {
    let rows = query("SHOW DATABASES").fetch_all(pool).await?;
    Ok(rows
        .iter()
        .filter_map(|r| mysql_value_to_string(r, 0))
        .collect())
}

pub(super) fn mysql_table_kind(table_type: &str) -> String {
    if table_type.eq_ignore_ascii_case("VIEW") {
        "view".to_string()
    } else {
        "table".to_string()
    }
}

pub(super) fn mysql_non_unique_is_unique(row: &MySqlRow, index: usize) -> bool {
    if let Ok(v) = row.try_get::<i64, _>(index) {
        return v == 0;
    }
    if let Ok(v) = row.try_get::<u64, _>(index) {
        return v == 0;
    }
    false
}

pub(super) async fn list_tables_mysql_show(
    pool: &Pool<MySql>,
    schema: Option<&str>,
) -> Result<Vec<TableInfo>, SqlxError> {
    let sql = match schema {
        Some(schema) => format!("SHOW FULL TABLES FROM {}", quote_mysql_ident(schema)),
        None => "SHOW FULL TABLES".to_string(),
    };
    let rows = query(AssertSqlSafe(sql)).fetch_all(pool).await?;
    Ok(rows
        .iter()
        .filter_map(|r| {
            let name = mysql_value_to_string(r, 0)?;
            let table_type = mysql_value_to_string(r, 1).unwrap_or_default();
            Some(TableInfo {
                name,
                kind: mysql_table_kind(&table_type),
                row_count: None,
            })
        })
        .collect())
}

pub(super) async fn describe_table_mysql_show(
    pool: &Pool<MySql>,
    schema: Option<&str>,
    table: &str,
) -> Result<Vec<ColumnDescription>, SqlxError> {
    let sql = format!(
        "SHOW FULL COLUMNS FROM {}",
        quote_mysql_table(schema, table)
    );
    let rows = query(AssertSqlSafe(sql)).fetch_all(pool).await?;
    Ok(rows
        .iter()
        .filter_map(|r| {
            let name = mysql_value_to_string(r, 0)?;
            let type_name = mysql_value_to_string(r, 1).unwrap_or_default();
            let nullable = mysql_value_to_string(r, 3).unwrap_or_default();
            let key = mysql_value_to_string(r, 4).unwrap_or_default();
            let default = mysql_value_to_string(r, 5);
            Some(ColumnDescription {
                name,
                type_name,
                nullable: nullable.eq_ignore_ascii_case("YES"),
                default,
                primary_key: key.eq_ignore_ascii_case("PRI"),
            })
        })
        .collect())
}

pub(super) async fn list_indexes_mysql_show(
    pool: &Pool<MySql>,
    schema: Option<&str>,
    table: &str,
) -> Result<Vec<IndexInfo>, SqlxError> {
    let sql = format!("SHOW INDEX FROM {}", quote_mysql_table(schema, table));
    let rows = query(AssertSqlSafe(sql)).fetch_all(pool).await?;
    let mut parsed: Vec<(String, i64, String, bool)> = rows
        .iter()
        .filter_map(|r| {
            let name = mysql_value_to_string(r, 2)?;
            let seq: i64 = r
                .try_get::<i64, _>(3)
                .ok()
                .or_else(|| {
                    r.try_get::<u64, _>(3)
                        .ok()
                        .and_then(|v| i64::try_from(v).ok())
                })
                .unwrap_or(0);
            let col = mysql_value_to_string(r, 4).unwrap_or_default();
            Some((name, seq, col, mysql_non_unique_is_unique(r, 1)))
        })
        .collect();
    parsed.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
    Ok(group_indexes(
        parsed
            .into_iter()
            .map(|(name, _seq, col, unique)| (name, col, unique)),
    ))
}

pub async fn list_schemas_mysql(pool: &Pool<MySql>) -> Result<Vec<SchemaInfo>, String> {
    let mut names = BTreeSet::new();
    let mut errors = Vec::new();

    match query(
        "SELECT schema_name FROM information_schema.schemata \
         WHERE schema_name NOT IN ('information_schema','mysql','sys','performance_schema') \
         ORDER BY schema_name",
    )
    .fetch_all(pool)
    .await
    {
        Ok(rows) => {
            for row in &rows {
                add_mysql_schema_name(&mut names, mysql_value_to_string(row, 0));
            }
        }
        Err(err) => errors.push(format!("information_schema.schemata: {err}")),
    }

    match list_schemas_mysql_show(pool).await {
        Ok(show_names) => {
            for name in show_names {
                add_mysql_schema_name(&mut names, Some(name));
            }
        }
        Err(err) => {
            if names.is_empty() {
                errors.push(format!("SHOW DATABASES: {err}"));
            }
        }
    }

    match current_mysql_database(pool).await {
        Ok(current) => add_mysql_schema_name(&mut names, current),
        Err(err) => errors.push(format!("SELECT DATABASE(): {err}")),
    }

    if names.is_empty() && !errors.is_empty() {
        return Err(format!("list schemas failed: {}", errors.join("; ")));
    }

    Ok(names.into_iter().map(|name| SchemaInfo { name }).collect())
}

pub async fn list_tables_mysql(
    pool: &Pool<MySql>,
    schema: Option<&str>,
) -> Result<Vec<TableInfo>, String> {
    let q = if schema.is_some() {
        "SELECT table_name, table_type, table_rows FROM information_schema.tables \
         WHERE table_schema = ? ORDER BY table_name"
    } else {
        "SELECT table_name, table_type, table_rows FROM information_schema.tables \
         WHERE table_schema = DATABASE() ORDER BY table_name"
    };
    let mut query = query(q);
    if let Some(s) = schema {
        query = query.bind(s);
    }
    let mut tables = BTreeMap::<String, TableInfo>::new();
    let mut errors = Vec::new();

    match query.fetch_all(pool).await {
        Ok(rows) => {
            for r in &rows {
                if let Some(name) = mysql_value_to_string(r, 0) {
                    let table_type = mysql_value_to_string(r, 1).unwrap_or_default();
                    let row_count = r.try_get::<Option<i64>, _>(2).ok().flatten().or_else(|| {
                        r.try_get::<Option<u64>, _>(2)
                            .ok()
                            .flatten()
                            .and_then(|v| i64::try_from(v).ok())
                            .or_else(|| {
                                mysql_value_to_string(r, 2).and_then(|v| v.parse::<i64>().ok())
                            })
                    });
                    tables.insert(
                        name.clone(),
                        TableInfo {
                            name,
                            kind: mysql_table_kind(&table_type),
                            row_count,
                        },
                    );
                }
            }
        }
        Err(err) => errors.push(format!("information_schema.tables: {err}")),
    }

    match list_tables_mysql_show(pool, schema).await {
        Ok(show_tables) => {
            for table in show_tables {
                tables.entry(table.name.clone()).or_insert(table);
            }
        }
        Err(err) => {
            if tables.is_empty() {
                errors.push(format!("SHOW FULL TABLES: {err}"));
            }
        }
    }

    if tables.is_empty() && !errors.is_empty() {
        return Err(format!("list tables failed: {}", errors.join("; ")));
    }

    Ok(tables.into_values().collect())
}

pub async fn search_tables_mysql(
    pool: &Pool<MySql>,
    schema: Option<&str>,
    prefix: &str,
    limit: usize,
) -> Result<Vec<TableInfo>, String> {
    let sql = if schema.is_some() {
        "SELECT table_name, table_type FROM information_schema.tables \
         WHERE table_schema = ? \
           AND LEFT(LOWER(table_name), CHAR_LENGTH(?)) = LOWER(?) \
         ORDER BY table_name LIMIT ?"
    } else {
        "SELECT table_name, table_type FROM information_schema.tables \
         WHERE table_schema = DATABASE() \
           AND LEFT(LOWER(table_name), CHAR_LENGTH(?)) = LOWER(?) \
         ORDER BY table_name LIMIT ?"
    };
    let mut statement = query(sql);
    if let Some(schema) = schema {
        statement = statement.bind(schema);
    }
    let rows = statement
        .bind(prefix)
        .bind(prefix)
        .bind(limit as i64)
        .fetch_all(pool)
        .await
        .map_err(|error| format!("search tables failed: {error}"))?;

    Ok(rows
        .iter()
        .filter_map(|row| {
            let name = mysql_value_to_string(row, 0)?;
            let table_type = mysql_value_to_string(row, 1).unwrap_or_default();
            Some(TableInfo {
                name,
                kind: mysql_table_kind(&table_type),
                row_count: None,
            })
        })
        .collect())
}

pub async fn describe_table_mysql(
    pool: &Pool<MySql>,
    schema: Option<&str>,
    table: &str,
) -> Result<Vec<ColumnDescription>, String> {
    let q = "SELECT column_name, column_type, is_nullable, column_default, column_key \
             FROM information_schema.columns \
             WHERE table_schema = COALESCE(?, DATABASE()) AND table_name = ? \
             ORDER BY ordinal_position";
    let rows = match query(q).bind(schema).bind(table).fetch_all(pool).await {
        Ok(rows) if !rows.is_empty() => rows,
        Ok(_) => {
            return describe_table_mysql_show(pool, schema, table)
                .await
                .map_err(|e| format!("describe table failed: {e}"));
        }
        Err(err) => {
            return describe_table_mysql_show(pool, schema, table)
                .await
                .map_err(|show_err| {
                    format!(
                        "describe table failed: information_schema.columns: {err}; SHOW FULL COLUMNS: {show_err}"
                    )
                });
        }
    };
    Ok(rows
        .iter()
        .filter_map(|r| {
            let name = mysql_value_to_string(r, 0)?;
            let type_name = mysql_value_to_string(r, 1).unwrap_or_default();
            let nullable = mysql_value_to_string(r, 2).unwrap_or_default();
            let default = mysql_value_to_string(r, 3);
            let key = mysql_value_to_string(r, 4).unwrap_or_default();
            Some(ColumnDescription {
                name,
                type_name,
                nullable: nullable.eq_ignore_ascii_case("YES"),
                default,
                primary_key: key.eq_ignore_ascii_case("PRI"),
            })
        })
        .collect())
}

pub async fn list_foreign_keys_mysql(
    pool: &Pool<MySql>,
    schema: Option<&str>,
    table: &str,
) -> Result<Vec<ForeignKeyInfo>, String> {
    let rows = query(
        "SELECT constraint_name, column_name, referenced_table_schema, \
                referenced_table_name, referenced_column_name \
         FROM information_schema.key_column_usage \
         WHERE table_schema = COALESCE(?, DATABASE()) AND table_name = ? \
           AND referenced_table_name IS NOT NULL \
         ORDER BY constraint_name, ordinal_position",
    )
    .bind(schema)
    .bind(table)
    .fetch_all(pool)
    .await
    .map_err(|error| format!("list foreign keys failed: {error}"))?;

    Ok(group_foreign_keys(rows.iter().filter_map(|row| {
        Some((
            mysql_value_to_string(row, 0)?,
            mysql_value_to_string(row, 1)?,
            mysql_value_to_string(row, 2),
            mysql_value_to_string(row, 3)?,
            mysql_value_to_string(row, 4)?,
        ))
    })))
}

pub async fn list_indexes_mysql(
    pool: &Pool<MySql>,
    schema: Option<&str>,
    table: &str,
) -> Result<Vec<IndexInfo>, String> {
    let q = "SELECT index_name, column_name, non_unique \
             FROM information_schema.statistics \
             WHERE table_schema = COALESCE(?, DATABASE()) AND table_name = ? \
             ORDER BY index_name, seq_in_index";
    let rows = match query(q).bind(schema).bind(table).fetch_all(pool).await {
        Ok(rows) if !rows.is_empty() => rows,
        Ok(_) => {
            return list_indexes_mysql_show(pool, schema, table)
                .await
                .map_err(|e| format!("list indexes failed: {e}"));
        }
        Err(err) => {
            return list_indexes_mysql_show(pool, schema, table)
                .await
                .map_err(|show_err| {
                    format!(
                        "list indexes failed: information_schema.statistics: {err}; SHOW INDEX: {show_err}"
                    )
                });
        }
    };
    Ok(group_indexes(rows.iter().filter_map(|r| {
        let name = mysql_value_to_string(r, 0)?;
        let col = mysql_value_to_string(r, 1).unwrap_or_default();
        // non_unique is 0 for unique indexes.
        Some((name, col, mysql_non_unique_is_unique(r, 2)))
    })))
}

/// List routine-style objects (procedures, functions, triggers, events) for
/// MySQL. Returns an empty vec for kinds MySQL does not have.
pub async fn list_objects_mysql(
    pool: &Pool<MySql>,
    schema: Option<&str>,
    kind: &str,
) -> Result<Vec<DbObject>, String> {
    let (sql, owner_col) = match kind {
        "procedure" | "function" => (
            "SELECT routine_name FROM information_schema.routines \
             WHERE routine_schema = COALESCE(?, DATABASE()) AND routine_type = ? \
             ORDER BY routine_name",
            false,
        ),
        "trigger" => (
            "SELECT trigger_name, event_object_table FROM information_schema.triggers \
             WHERE trigger_schema = COALESCE(?, DATABASE()) ORDER BY trigger_name",
            true,
        ),
        "event" => (
            "SELECT event_name FROM information_schema.events \
             WHERE event_schema = COALESCE(?, DATABASE()) ORDER BY event_name",
            false,
        ),
        _ => return Ok(Vec::new()),
    };
    let mut q = query(sql).bind(schema);
    if kind == "procedure" || kind == "function" {
        q = q.bind(kind.to_uppercase());
    }
    let rows = q
        .fetch_all(pool)
        .await
        .map_err(|e| format!("list {kind} failed: {e}"))?;
    Ok(rows
        .iter()
        .filter_map(|r| {
            let name = mysql_value_to_string(r, 0)?;
            let owner = if owner_col {
                mysql_value_to_string(r, 1)
            } else {
                None
            };
            Some(DbObject {
                name,
                kind: kind.to_string(),
                owner,
            })
        })
        .collect())
}

/// `SHOW CREATE …` for a MySQL object; returns the DDL column verbatim.
pub async fn object_ddl_mysql(
    pool: &Pool<MySql>,
    schema: Option<&str>,
    kind: &str,
    name: &str,
) -> Result<String, String> {
    let verb = match kind {
        "view" => "VIEW",
        "procedure" => "PROCEDURE",
        "function" => "FUNCTION",
        "trigger" => "TRIGGER",
        "event" => "EVENT",
        _ => "TABLE",
    };
    let sql = format!("SHOW CREATE {verb} {}", mysql_qualified(schema, name));
    let token = CancellationToken::new();
    let res = execute_mysql(pool, &sql, &token).await?;
    // The DDL lives in the column whose name starts with "Create".
    let idx = res
        .columns
        .iter()
        .position(|c| c.name.to_ascii_lowercase().starts_with("create"))
        .unwrap_or(res.columns.len().saturating_sub(1));
    res.rows
        .first()
        .and_then(|r| r.get(idx).cloned().flatten())
        .ok_or_else(|| format!("No DDL returned for {name}"))
}

/// Table size / row estimates for MySQL.
pub async fn table_stats_mysql(
    pool: &Pool<MySql>,
    schema: Option<&str>,
    table: &str,
) -> Result<QueryResult, String> {
    let rows = query(
        "SELECT engine, table_rows, data_length, index_length, data_free, \
                table_collation, create_time, update_time \
         FROM information_schema.tables \
         WHERE table_schema = COALESCE(?, DATABASE()) AND table_name = ?",
    )
    .bind(schema)
    .bind(table)
    .fetch_optional(pool)
    .await
    .map_err(|e| format!("table stats failed: {e}"))?
    .ok_or_else(|| format!("Table {table} not found"))?;
    let pairs = vec![
        ("Engine", mysql_value_to_string(&rows, 0)),
        ("Estimated rows", mysql_value_to_string(&rows, 1)),
        ("Data length (bytes)", mysql_value_to_string(&rows, 2)),
        ("Index length (bytes)", mysql_value_to_string(&rows, 3)),
        ("Data free (bytes)", mysql_value_to_string(&rows, 4)),
        ("Collation", mysql_value_to_string(&rows, 5)),
        ("Created", mysql_value_to_string(&rows, 6)),
        ("Updated", mysql_value_to_string(&rows, 7)),
    ];
    Ok(super::super::metric_result(pairs))
}
