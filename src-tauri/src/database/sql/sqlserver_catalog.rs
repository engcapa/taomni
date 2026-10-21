use super::SqlServerClient;
use super::query::sqlserver_fetch;
use super::schema_helpers::group_indexes;
use super::schema_helpers::quote_sqlserver_ident;
use super::schema_helpers::sqlserver_default_schema;
use super::schema_helpers::sqlserver_qualified;
use super::values::sqlserver_value_to_string;
use crate::database::ColumnDescription;
use crate::database::DbObject;
use crate::database::ForeignKeyInfo;
use crate::database::IndexInfo;
use crate::database::QueryResult;
use crate::database::SchemaInfo;
use crate::database::TableInfo;
use crate::database::group_foreign_keys;
use sqlx_core::row::Row;
use tiberius::Row as TdsRow;
use tiberius::ToSql as TdsToSql;
use tokio::sync::Mutex as AsyncMutex;

pub(super) fn sqlserver_text(row: &TdsRow, index: usize) -> Option<String> {
    sqlserver_value_to_string(row, index)
}

pub(super) fn sqlserver_bool(row: &TdsRow, index: usize) -> bool {
    row.try_get::<bool, _>(index)
        .ok()
        .flatten()
        .unwrap_or(false)
}

pub(super) fn sqlserver_i64(row: &TdsRow, index: usize) -> Option<i64> {
    row.try_get::<i64, _>(index)
        .ok()
        .flatten()
        .or_else(|| row.try_get::<i32, _>(index).ok().flatten().map(i64::from))
}

pub async fn list_schemas_sqlserver(
    client: &AsyncMutex<SqlServerClient>,
) -> Result<Vec<SchemaInfo>, String> {
    let rows = sqlserver_fetch(
        client,
        "SELECT name FROM sys.schemas \
         WHERE name NOT IN (N'sys', N'INFORMATION_SCHEMA') \
         ORDER BY name",
        &[],
    )
    .await
    .map_err(|e| format!("list schemas failed: {e}"))?;
    Ok(rows
        .iter()
        .filter_map(|r| sqlserver_text(r, 0))
        .map(|name| SchemaInfo { name })
        .collect())
}

pub async fn list_tables_sqlserver(
    client: &AsyncMutex<SqlServerClient>,
    schema: Option<&str>,
) -> Result<Vec<TableInfo>, String> {
    let schema = sqlserver_default_schema(schema);
    let schema_ref = schema.as_str();
    let params: [&dyn TdsToSql; 1] = [&schema_ref];
    let rows = sqlserver_fetch(
        client,
        "SELECT o.name, \
                CASE WHEN o.type = 'V' THEN N'view' ELSE N'table' END AS kind, \
                CASE WHEN o.type = 'U' THEN SUM(CASE WHEN p.index_id IN (0,1) THEN p.rows ELSE 0 END) ELSE NULL END AS row_count \
         FROM sys.objects o \
         JOIN sys.schemas s ON s.schema_id = o.schema_id \
         LEFT JOIN sys.partitions p ON p.object_id = o.object_id \
         WHERE s.name = @P1 AND o.type IN ('U','V') \
         GROUP BY o.name, o.type \
         ORDER BY o.name",
        &params,
    )
    .await
    .map_err(|e| format!("list tables failed: {e}"))?;

    Ok(rows
        .iter()
        .filter_map(|r| {
            let name = sqlserver_text(r, 0)?;
            let kind = sqlserver_text(r, 1).unwrap_or_else(|| "table".to_string());
            Some(TableInfo {
                name,
                kind,
                row_count: sqlserver_i64(r, 2),
            })
        })
        .collect())
}

pub async fn search_tables_sqlserver(
    client: &AsyncMutex<SqlServerClient>,
    schema: Option<&str>,
    prefix: &str,
    limit: usize,
) -> Result<Vec<TableInfo>, String> {
    let schema = sqlserver_default_schema(schema);
    let schema_ref = schema.as_str();
    let prefix_ref = prefix;
    let limit = i32::try_from(limit).unwrap_or(i32::MAX);
    let params: [&dyn TdsToSql; 3] = [&schema_ref, &prefix_ref, &limit];
    let rows = sqlserver_fetch(
        client,
        "SELECT TOP (@P3) o.name, \
                CASE WHEN o.type = 'V' THEN N'view' ELSE N'table' END AS kind \
         FROM sys.objects o \
         JOIN sys.schemas s ON s.schema_id = o.schema_id \
         WHERE s.name = @P1 AND o.type IN ('U','V') \
           AND LEFT(LOWER(o.name), LEN(@P2)) = LOWER(@P2) \
         ORDER BY o.name",
        &params,
    )
    .await
    .map_err(|error| format!("search tables failed: {error}"))?;

    Ok(rows
        .iter()
        .filter_map(|row| {
            let name = sqlserver_text(row, 0)?;
            let kind = sqlserver_text(row, 1).unwrap_or_else(|| "table".to_string());
            Some(TableInfo {
                name,
                kind,
                row_count: None,
            })
        })
        .collect())
}

pub async fn describe_table_sqlserver(
    client: &AsyncMutex<SqlServerClient>,
    schema: Option<&str>,
    table: &str,
) -> Result<Vec<ColumnDescription>, String> {
    let schema = sqlserver_default_schema(schema);
    let schema_ref = schema.as_str();
    let table_ref = table;
    let params: [&dyn TdsToSql; 2] = [&schema_ref, &table_ref];
    let rows = sqlserver_fetch(
        client,
        "SELECT c.name, \
                t.name + \
                CASE \
                  WHEN t.name IN (N'varchar', N'char', N'varbinary', N'binary') \
                    THEN N'(' + CASE WHEN c.max_length = -1 THEN N'max' ELSE CONVERT(nvarchar(16), c.max_length) END + N')' \
                  WHEN t.name IN (N'nvarchar', N'nchar') \
                    THEN N'(' + CASE WHEN c.max_length = -1 THEN N'max' ELSE CONVERT(nvarchar(16), c.max_length / 2) END + N')' \
                  WHEN t.name IN (N'decimal', N'numeric') \
                    THEN N'(' + CONVERT(nvarchar(16), c.precision) + N',' + CONVERT(nvarchar(16), c.scale) + N')' \
                  WHEN t.name IN (N'time', N'datetime2', N'datetimeoffset') \
                    THEN N'(' + CONVERT(nvarchar(16), c.scale) + N')' \
                  ELSE N'' \
                END AS type_name, \
                c.is_nullable, dc.definition, \
                CASE WHEN pk.column_id IS NULL THEN CAST(0 AS bit) ELSE CAST(1 AS bit) END AS is_pk \
         FROM sys.columns c \
         JOIN sys.objects o ON o.object_id = c.object_id \
         JOIN sys.schemas s ON s.schema_id = o.schema_id \
         JOIN sys.types t ON t.user_type_id = c.user_type_id \
         LEFT JOIN sys.default_constraints dc ON dc.object_id = c.default_object_id \
         LEFT JOIN ( \
             SELECT ic.object_id, ic.column_id \
             FROM sys.indexes i \
             JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id \
             WHERE i.is_primary_key = 1 \
         ) pk ON pk.object_id = c.object_id AND pk.column_id = c.column_id \
         WHERE s.name = @P1 AND o.name = @P2 AND o.type IN ('U','V') \
         ORDER BY c.column_id",
        &params,
    )
    .await
    .map_err(|e| format!("describe table failed: {e}"))?;

    Ok(rows
        .iter()
        .filter_map(|r| {
            Some(ColumnDescription {
                name: sqlserver_text(r, 0)?,
                type_name: sqlserver_text(r, 1).unwrap_or_default(),
                nullable: sqlserver_bool(r, 2),
                default: sqlserver_text(r, 3),
                primary_key: sqlserver_bool(r, 4),
            })
        })
        .collect())
}

pub async fn list_foreign_keys_sqlserver(
    client: &AsyncMutex<SqlServerClient>,
    schema: Option<&str>,
    table: &str,
) -> Result<Vec<ForeignKeyInfo>, String> {
    let schema = sqlserver_default_schema(schema);
    let schema_ref = schema.as_str();
    let table_ref = table;
    let params: [&dyn TdsToSql; 2] = [&schema_ref, &table_ref];
    let rows = sqlserver_fetch(
        client,
        "SELECT fk.name, parent_column.name, referenced_schema.name, \
                referenced_table.name, referenced_column.name \
         FROM sys.foreign_keys fk \
         JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id \
         JOIN sys.tables parent_table ON parent_table.object_id = fk.parent_object_id \
         JOIN sys.schemas parent_schema ON parent_schema.schema_id = parent_table.schema_id \
         JOIN sys.columns parent_column \
           ON parent_column.object_id = parent_table.object_id \
          AND parent_column.column_id = fkc.parent_column_id \
         JOIN sys.tables referenced_table ON referenced_table.object_id = fk.referenced_object_id \
         JOIN sys.schemas referenced_schema ON referenced_schema.schema_id = referenced_table.schema_id \
         JOIN sys.columns referenced_column \
           ON referenced_column.object_id = referenced_table.object_id \
          AND referenced_column.column_id = fkc.referenced_column_id \
         WHERE parent_schema.name = @P1 AND parent_table.name = @P2 \
         ORDER BY fk.name, fkc.constraint_column_id",
        &params,
    )
    .await
    .map_err(|error| format!("list foreign keys failed: {error}"))?;

    Ok(group_foreign_keys(rows.iter().filter_map(|row| {
        Some((
            sqlserver_text(row, 0)?,
            sqlserver_text(row, 1)?,
            sqlserver_text(row, 2),
            sqlserver_text(row, 3)?,
            sqlserver_text(row, 4)?,
        ))
    })))
}

pub async fn list_indexes_sqlserver(
    client: &AsyncMutex<SqlServerClient>,
    schema: Option<&str>,
    table: &str,
) -> Result<Vec<IndexInfo>, String> {
    let schema = sqlserver_default_schema(schema);
    let schema_ref = schema.as_str();
    let table_ref = table;
    let params: [&dyn TdsToSql; 2] = [&schema_ref, &table_ref];
    let rows = sqlserver_fetch(
        client,
        "SELECT i.name, c.name, i.is_unique \
         FROM sys.indexes i \
         JOIN sys.objects o ON o.object_id = i.object_id \
         JOIN sys.schemas s ON s.schema_id = o.schema_id \
         JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id \
         JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id \
         WHERE s.name = @P1 AND o.name = @P2 AND i.name IS NOT NULL AND i.is_hypothetical = 0 \
         ORDER BY i.name, ic.key_ordinal, ic.index_column_id",
        &params,
    )
    .await
    .map_err(|e| format!("list indexes failed: {e}"))?;

    Ok(group_indexes(rows.iter().filter_map(|r| {
        Some((
            sqlserver_text(r, 0)?,
            sqlserver_text(r, 1).unwrap_or_default(),
            sqlserver_bool(r, 2),
        ))
    })))
}

pub async fn list_objects_sqlserver(
    client: &AsyncMutex<SqlServerClient>,
    schema: Option<&str>,
    kind: &str,
) -> Result<Vec<DbObject>, String> {
    let schema = sqlserver_default_schema(schema);
    let schema_ref = schema.as_str();
    let params: [&dyn TdsToSql; 1] = [&schema_ref];
    let (sql, owner_col) = match kind {
        "procedure" => (
            "SELECT o.name, CAST(NULL AS nvarchar(128)) AS owner \
             FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id \
             WHERE s.name = @P1 AND o.type IN ('P','PC') ORDER BY o.name",
            false,
        ),
        "function" => (
            "SELECT o.name, CAST(NULL AS nvarchar(128)) AS owner \
             FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id \
             WHERE s.name = @P1 AND o.type IN ('FN','IF','TF','FS','FT') ORDER BY o.name",
            false,
        ),
        "trigger" => (
            "SELECT tr.name, parent.name AS owner \
             FROM sys.triggers tr \
             JOIN sys.objects parent ON parent.object_id = tr.parent_id \
             JOIN sys.schemas s ON s.schema_id = parent.schema_id \
             WHERE s.name = @P1 ORDER BY tr.name",
            true,
        ),
        "sequence" => (
            "SELECT seq.name, CAST(NULL AS nvarchar(128)) AS owner \
             FROM sys.sequences seq JOIN sys.schemas s ON s.schema_id = seq.schema_id \
             WHERE s.name = @P1 ORDER BY seq.name",
            false,
        ),
        _ => return Ok(Vec::new()),
    };
    let rows = sqlserver_fetch(client, sql, &params)
        .await
        .map_err(|e| format!("list {kind} failed: {e}"))?;
    Ok(rows
        .iter()
        .filter_map(|r| {
            Some(DbObject {
                name: sqlserver_text(r, 0)?,
                kind: kind.to_string(),
                owner: if owner_col {
                    sqlserver_text(r, 1)
                } else {
                    None
                },
            })
        })
        .collect())
}

pub async fn object_ddl_sqlserver(
    client: &AsyncMutex<SqlServerClient>,
    schema: Option<&str>,
    kind: &str,
    name: &str,
) -> Result<String, String> {
    let schema = sqlserver_default_schema(schema);
    match kind {
        "view" | "procedure" | "function" | "trigger" => {
            let schema_ref = schema.as_str();
            let name_ref = name;
            let params: [&dyn TdsToSql; 2] = [&schema_ref, &name_ref];
            let rows = sqlserver_fetch(
                client,
                "SELECT OBJECT_DEFINITION(OBJECT_ID(QUOTENAME(@P1) + N'.' + QUOTENAME(@P2)))",
                &params,
            )
            .await
            .map_err(|e| format!("object definition failed: {e}"))?;
            rows.first()
                .and_then(|r| sqlserver_text(r, 0))
                .filter(|ddl| !ddl.trim().is_empty())
                .ok_or_else(|| format!("No DDL returned for {name}"))
        }
        "sequence" => Ok(format!(
            "CREATE SEQUENCE {};",
            sqlserver_qualified(Some(&schema), name)
        )),
        _ => {
            let cols = describe_table_sqlserver(client, Some(&schema), name).await?;
            if cols.is_empty() {
                return Err(format!("Table {name} not found"));
            }
            let mut lines: Vec<String> = cols
                .iter()
                .map(|c| {
                    let null = if c.nullable { " NULL" } else { " NOT NULL" };
                    let default = c
                        .default
                        .as_ref()
                        .map(|d| format!(" DEFAULT {d}"))
                        .unwrap_or_default();
                    format!(
                        "  {} {}{}{}",
                        quote_sqlserver_ident(&c.name),
                        c.type_name,
                        null,
                        default
                    )
                })
                .collect();
            let pks: Vec<String> = cols
                .iter()
                .filter(|c| c.primary_key)
                .map(|c| quote_sqlserver_ident(&c.name))
                .collect();
            if !pks.is_empty() {
                lines.push(format!("  PRIMARY KEY ({})", pks.join(", ")));
            }
            Ok(format!(
                "CREATE TABLE {} (\n{}\n);",
                sqlserver_qualified(Some(&schema), name),
                lines.join(",\n")
            ))
        }
    }
}

pub async fn table_stats_sqlserver(
    client: &AsyncMutex<SqlServerClient>,
    schema: Option<&str>,
    table: &str,
) -> Result<QueryResult, String> {
    let schema = sqlserver_default_schema(schema);
    let schema_ref = schema.as_str();
    let table_ref = table;
    let params: [&dyn TdsToSql; 2] = [&schema_ref, &table_ref];
    let rows = sqlserver_fetch(
        client,
        "SELECT SUM(CASE WHEN p.index_id IN (0,1) THEN p.rows ELSE 0 END) AS row_count, \
                SUM(a.total_pages) * 8192 AS reserved_bytes, \
                SUM(a.used_pages) * 8192 AS used_bytes, \
                SUM(a.data_pages) * 8192 AS data_bytes \
         FROM sys.objects o \
         JOIN sys.schemas s ON s.schema_id = o.schema_id \
         LEFT JOIN sys.partitions p ON p.object_id = o.object_id \
         LEFT JOIN sys.allocation_units a ON a.container_id = p.partition_id \
         WHERE s.name = @P1 AND o.name = @P2 AND o.type = 'U'",
        &params,
    )
    .await
    .map_err(|e| format!("table stats failed: {e}"))?;
    let row = rows
        .first()
        .ok_or_else(|| format!("Table {table} not found"))?;
    let pairs = vec![
        ("Rows", sqlserver_text(row, 0)),
        ("Reserved bytes", sqlserver_text(row, 1)),
        ("Used bytes", sqlserver_text(row, 2)),
        ("Data bytes", sqlserver_text(row, 3)),
    ];
    Ok(super::super::metric_result(pairs))
}
