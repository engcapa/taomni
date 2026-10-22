use super::schema_helpers::group_indexes;
use crate::database::ColumnDescription;
use crate::database::DbObject;
use crate::database::ForeignKeyInfo;
use crate::database::IndexInfo;
use crate::database::QueryResult;
use crate::database::SchemaInfo;
use crate::database::TableInfo;
use crate::database::group_foreign_keys;
use sqlx_core::pool::Pool;
use sqlx_core::query::query;
use sqlx_core::row::Row;
use sqlx_postgres::Postgres;

// ---------------------------------------------------------------------------
// Schema introspection — PostgreSQL
// ---------------------------------------------------------------------------

pub async fn list_schemas_postgres(pool: &Pool<Postgres>) -> Result<Vec<SchemaInfo>, String> {
    let rows = query(
        "SELECT schema_name FROM information_schema.schemata \
         WHERE schema_name NOT LIKE 'pg_%' AND schema_name <> 'information_schema' \
         ORDER BY schema_name",
    )
    .fetch_all(pool)
    .await
    .map_err(|e| format!("list schemas failed: {e}"))?;
    Ok(rows
        .iter()
        .filter_map(|r| r.try_get::<String, _>(0).ok())
        .map(|name| SchemaInfo { name })
        .collect())
}

pub async fn list_tables_postgres(
    pool: &Pool<Postgres>,
    schema: Option<&str>,
) -> Result<Vec<TableInfo>, String> {
    let schema = schema.unwrap_or("public");
    let rows = query(
        "SELECT t.table_name, t.table_type, \
                CASE WHEN c.reltuples >= 0 THEN c.reltuples::bigint ELSE NULL END AS row_count \
         FROM information_schema.tables t \
         LEFT JOIN pg_namespace n ON n.nspname = t.table_schema \
         LEFT JOIN pg_class c ON c.relname = t.table_name AND c.relnamespace = n.oid \
         WHERE t.table_schema = $1 ORDER BY t.table_name",
    )
    .bind(schema)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("list tables failed: {e}"))?;
    let mut out: Vec<TableInfo> = rows
        .iter()
        .filter_map(|r| {
            let name: String = r.try_get(0).ok()?;
            let t: String = r.try_get(1).unwrap_or_default();
            let row_count: Option<i64> = r.try_get(2).ok().flatten();
            let kind = if t.eq_ignore_ascii_case("VIEW") {
                "view"
            } else {
                "table"
            };
            Some(TableInfo {
                name,
                kind: kind.to_string(),
                row_count,
            })
        })
        .collect();
    // Materialized views live in pg_matviews, not information_schema.
    if let Ok(mvs) = query("SELECT matviewname FROM pg_matviews WHERE schemaname = $1")
        .bind(schema)
        .fetch_all(pool)
        .await
    {
        for r in &mvs {
            if let Ok(name) = r.try_get::<String, _>(0) {
                out.push(TableInfo {
                    name,
                    kind: "materialized_view".to_string(),
                    row_count: None,
                });
            }
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

pub async fn search_tables_postgres(
    pool: &Pool<Postgres>,
    schema: Option<&str>,
    prefix: &str,
    limit: usize,
) -> Result<Vec<TableInfo>, String> {
    let schema = schema.unwrap_or("public");
    let rows = query(
        "SELECT c.relname, \
                CASE c.relkind WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized_view' ELSE 'table' END AS kind \
         FROM pg_catalog.pg_class c \
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
         WHERE n.nspname = $1 AND c.relkind IN ('r','p','f','v','m') \
           AND LEFT(LOWER(c.relname), char_length($2)) = LOWER($2) \
         ORDER BY c.relname LIMIT $3",
    )
    .bind(schema)
    .bind(prefix)
    .bind(limit as i64)
    .fetch_all(pool)
    .await
    .map_err(|error| format!("search tables failed: {error}"))?;

    Ok(rows
        .iter()
        .filter_map(|row| {
            let name: String = row.try_get(0).ok()?;
            let kind: String = row.try_get(1).unwrap_or_else(|_| "table".to_string());
            Some(TableInfo {
                name,
                kind,
                row_count: None,
            })
        })
        .collect())
}

pub async fn describe_table_postgres(
    pool: &Pool<Postgres>,
    schema: Option<&str>,
    table: &str,
) -> Result<Vec<ColumnDescription>, String> {
    let schema = schema.unwrap_or("public");
    let rows = query(
        "SELECT c.column_name, c.data_type, c.is_nullable, c.column_default, \
            COALESCE(pk.is_pk, false) AS is_pk \
         FROM information_schema.columns c \
         LEFT JOIN ( \
            SELECT kcu.column_name, true AS is_pk \
            FROM information_schema.table_constraints tc \
            JOIN information_schema.key_column_usage kcu \
              ON tc.constraint_name = kcu.constraint_name \
             AND tc.table_schema = kcu.table_schema \
            WHERE tc.constraint_type = 'PRIMARY KEY' \
              AND tc.table_schema = $1 AND tc.table_name = $2 \
         ) pk ON pk.column_name = c.column_name \
         WHERE c.table_schema = $1 AND c.table_name = $2 \
         ORDER BY c.ordinal_position",
    )
    .bind(schema)
    .bind(table)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("describe table failed: {e}"))?;
    Ok(rows
        .iter()
        .filter_map(|r| {
            let name: String = r.try_get(0).ok()?;
            let type_name: String = r.try_get(1).unwrap_or_default();
            let nullable: String = r.try_get(2).unwrap_or_default();
            let default: Option<String> = r.try_get(3).ok().flatten();
            let primary_key: bool = r.try_get(4).unwrap_or(false);
            Some(ColumnDescription {
                name,
                type_name,
                nullable: nullable.eq_ignore_ascii_case("YES"),
                default,
                primary_key,
            })
        })
        .collect())
}

pub async fn list_foreign_keys_postgres(
    pool: &Pool<Postgres>,
    schema: Option<&str>,
    table: &str,
) -> Result<Vec<ForeignKeyInfo>, String> {
    let schema = schema.unwrap_or("public");
    let rows = query(
        "SELECT fk.constraint_name, fk.column_name, pk.table_schema, \
                pk.table_name, pk.column_name \
         FROM information_schema.table_constraints tc \
         JOIN information_schema.key_column_usage fk \
           ON fk.constraint_catalog = tc.constraint_catalog \
          AND fk.constraint_schema = tc.constraint_schema \
          AND fk.constraint_name = tc.constraint_name \
         JOIN information_schema.referential_constraints rc \
           ON rc.constraint_catalog = tc.constraint_catalog \
          AND rc.constraint_schema = tc.constraint_schema \
          AND rc.constraint_name = tc.constraint_name \
         JOIN information_schema.key_column_usage pk \
           ON pk.constraint_catalog = rc.unique_constraint_catalog \
          AND pk.constraint_schema = rc.unique_constraint_schema \
          AND pk.constraint_name = rc.unique_constraint_name \
          AND pk.ordinal_position = fk.position_in_unique_constraint \
         WHERE tc.constraint_type = 'FOREIGN KEY' \
           AND tc.table_schema = $1 AND tc.table_name = $2 \
         ORDER BY fk.constraint_name, fk.ordinal_position",
    )
    .bind(schema)
    .bind(table)
    .fetch_all(pool)
    .await
    .map_err(|error| format!("list foreign keys failed: {error}"))?;

    Ok(group_foreign_keys(rows.iter().filter_map(|row| {
        Some((
            row.try_get(0).ok()?,
            row.try_get(1).ok()?,
            row.try_get(2).ok(),
            row.try_get(3).ok()?,
            row.try_get(4).ok()?,
        ))
    })))
}

pub async fn list_indexes_postgres(
    pool: &Pool<Postgres>,
    schema: Option<&str>,
    table: &str,
) -> Result<Vec<IndexInfo>, String> {
    let schema = schema.unwrap_or("public");
    let rows = query(
        "SELECT i.relname AS index_name, a.attname AS column_name, ix.indisunique AS is_unique \
         FROM pg_class t \
         JOIN pg_namespace n ON n.oid = t.relnamespace \
         JOIN pg_index ix ON t.oid = ix.indrelid \
         JOIN pg_class i ON i.oid = ix.indexrelid \
         JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey) \
         WHERE n.nspname = $1 AND t.relname = $2 \
         ORDER BY i.relname, array_position(ix.indkey, a.attnum)",
    )
    .bind(schema)
    .bind(table)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("list indexes failed: {e}"))?;
    Ok(group_indexes(rows.iter().filter_map(|r| {
        let name: String = r.try_get(0).ok()?;
        let col: String = r.try_get(1).unwrap_or_default();
        let unique: bool = r.try_get(2).unwrap_or(false);
        Some((name, col, unique))
    })))
}

/// List functions, sequences, and (defensively) other objects for PostgreSQL.
/// Materialized views are surfaced through `list_tables_postgres`.
pub async fn list_objects_postgres(
    pool: &Pool<Postgres>,
    schema: Option<&str>,
    kind: &str,
) -> Result<Vec<DbObject>, String> {
    let schema = schema.unwrap_or("public");
    let sql = match kind {
        "function" => {
            "SELECT DISTINCT p.proname FROM pg_catalog.pg_proc p \
             JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace \
             WHERE n.nspname = $1 ORDER BY p.proname"
        }
        "sequence" => {
            "SELECT sequence_name FROM information_schema.sequences \
             WHERE sequence_schema = $1 ORDER BY sequence_name"
        }
        _ => return Ok(Vec::new()),
    };
    let rows = query(sql)
        .bind(schema)
        .fetch_all(pool)
        .await
        .map_err(|e| format!("list {kind} failed: {e}"))?;
    Ok(rows
        .iter()
        .filter_map(|r| {
            let name: String = r.try_get(0).ok()?;
            Some(DbObject {
                name,
                kind: kind.to_string(),
                owner: None,
            })
        })
        .collect())
}

/// Reconstruct DDL / fetch definitions for PostgreSQL objects.
pub async fn object_ddl_postgres(
    pool: &Pool<Postgres>,
    schema: Option<&str>,
    kind: &str,
    name: &str,
) -> Result<String, String> {
    let schema = schema.unwrap_or("public");
    match kind {
        "view" | "materialized_view" => {
            let row = query(
                "SELECT pg_get_viewdef(c.oid, true) FROM pg_class c \
                 JOIN pg_namespace n ON n.oid = c.relnamespace \
                 WHERE n.nspname = $1 AND c.relname = $2",
            )
            .bind(schema)
            .bind(name)
            .fetch_optional(pool)
            .await
            .map_err(|e| format!("view definition failed: {e}"))?;
            let def: String = row
                .and_then(|r| r.try_get::<String, _>(0).ok())
                .ok_or_else(|| format!("View {name} not found"))?;
            let kw = if kind == "materialized_view" {
                "MATERIALIZED VIEW"
            } else {
                "VIEW"
            };
            Ok(format!(
                "CREATE OR REPLACE {kw} \"{schema}\".\"{name}\" AS\n{def}"
            ))
        }
        "function" => {
            let row = query(
                "SELECT pg_get_functiondef(p.oid) FROM pg_proc p \
                 JOIN pg_namespace n ON n.oid = p.pronamespace \
                 WHERE n.nspname = $1 AND p.proname = $2 LIMIT 1",
            )
            .bind(schema)
            .bind(name)
            .fetch_optional(pool)
            .await
            .map_err(|e| format!("function definition failed: {e}"))?;
            row.and_then(|r| r.try_get::<String, _>(0).ok())
                .ok_or_else(|| format!("Function {name} not found"))
        }
        "sequence" => Ok(format!("CREATE SEQUENCE \"{schema}\".\"{name}\";")),
        _ => {
            // Tables: reconstruct a best-effort CREATE TABLE from the columns.
            let cols = describe_table_postgres(pool, Some(schema), name).await?;
            if cols.is_empty() {
                return Err(format!("Table {name} not found"));
            }
            let mut lines: Vec<String> = cols
                .iter()
                .map(|c| {
                    let null = if c.nullable { "" } else { " NOT NULL" };
                    let default = c
                        .default
                        .as_ref()
                        .map(|d| format!(" DEFAULT {d}"))
                        .unwrap_or_default();
                    format!("  \"{}\" {}{}{}", c.name, c.type_name, null, default)
                })
                .collect();
            let pks: Vec<String> = cols
                .iter()
                .filter(|c| c.primary_key)
                .map(|c| format!("\"{}\"", c.name))
                .collect();
            if !pks.is_empty() {
                lines.push(format!("  PRIMARY KEY ({})", pks.join(", ")));
            }
            Ok(format!(
                "CREATE TABLE \"{schema}\".\"{name}\" (\n{}\n);",
                lines.join(",\n")
            ))
        }
    }
}

/// Table size / row estimates for PostgreSQL.
pub async fn table_stats_postgres(
    pool: &Pool<Postgres>,
    schema: Option<&str>,
    table: &str,
) -> Result<QueryResult, String> {
    let schema = schema.unwrap_or("public");
    let row = query(
        "SELECT pg_total_relation_size(c.oid), pg_relation_size(c.oid), \
                pg_indexes_size(c.oid), s.n_live_tup \
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
         LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid \
         WHERE n.nspname = $1 AND c.relname = $2",
    )
    .bind(schema)
    .bind(table)
    .fetch_optional(pool)
    .await
    .map_err(|e| format!("table stats failed: {e}"))?
    .ok_or_else(|| format!("Table {table} not found"))?;
    let num = |idx: usize| {
        row.try_get::<Option<i64>, _>(idx)
            .ok()
            .flatten()
            .map(|v| v.to_string())
    };
    let pairs = vec![
        ("Total size (bytes)", num(0)),
        ("Table size (bytes)", num(1)),
        ("Indexes size (bytes)", num(2)),
        ("Live rows (estimate)", num(3)),
    ];
    Ok(super::super::metric_result(pairs))
}
