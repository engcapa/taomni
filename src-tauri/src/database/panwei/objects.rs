use super::catalog::resolve_schema;
use super::connection::PanWeiClient;
use super::query::fetch;
use super::query::fetch_optional;
use super::table_details::describe_table;
use crate::database::DbObject;
use crate::database::QueryResult;

pub async fn list_objects(
    client: &PanWeiClient,
    schema: Option<&str>,
    kind: &str,
) -> Result<Vec<DbObject>, String> {
    let schema = resolve_schema(client, schema).await?;
    let schema_ref = schema.as_str();
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
    let rows = fetch(client, sql, &[&schema_ref])
        .await
        .map_err(|e| format!("list {kind} failed: {e}"))?;
    Ok(rows
        .iter()
        .filter_map(|row| {
            let name: String = row.try_get(0).ok()?;
            Some(DbObject {
                name,
                kind: kind.to_string(),
                owner: None,
            })
        })
        .collect())
}

pub async fn object_ddl(
    client: &PanWeiClient,
    schema: Option<&str>,
    kind: &str,
    name: &str,
) -> Result<String, String> {
    let schema = resolve_schema(client, schema).await?;
    let schema_ref = schema.as_str();
    match kind {
        "view" | "materialized_view" => {
            let row = fetch_optional(
                client,
                "SELECT pg_get_viewdef(c.oid, true) FROM pg_class c \
                 JOIN pg_namespace n ON n.oid = c.relnamespace \
                 WHERE n.nspname = $1 AND c.relname = $2",
                &[&schema_ref, &name],
            )
            .await
            .map_err(|e| format!("view definition failed: {e}"))?;
            let def: String = row
                .and_then(|row| row.try_get::<usize, String>(0).ok())
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
            let row = fetch_optional(
                client,
                "SELECT pg_get_functiondef(p.oid) FROM pg_proc p \
                 JOIN pg_namespace n ON n.oid = p.pronamespace \
                 WHERE n.nspname = $1 AND p.proname = $2 LIMIT 1",
                &[&schema_ref, &name],
            )
            .await
            .map_err(|e| format!("function definition failed: {e}"))?;
            row.and_then(|row| row.try_get::<usize, String>(0).ok())
                .ok_or_else(|| format!("Function {name} not found"))
        }
        "sequence" => Ok(format!("CREATE SEQUENCE \"{schema}\".\"{name}\";")),
        _ => {
            let cols = describe_table(client, Some(schema_ref), name).await?;
            if cols.is_empty() {
                return Err(format!("Table {name} not found"));
            }
            let mut lines: Vec<String> = cols
                .iter()
                .map(|column| {
                    let mut line = format!("  \"{}\" {}", column.name, column.type_name);
                    if !column.nullable {
                        line.push_str(" NOT NULL");
                    }
                    if let Some(default) = &column.default {
                        line.push_str(" DEFAULT ");
                        line.push_str(default);
                    }
                    line
                })
                .collect();
            let pks: Vec<String> = cols
                .iter()
                .filter(|column| column.primary_key)
                .map(|column| format!("\"{}\"", column.name))
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

pub async fn table_stats(
    client: &PanWeiClient,
    schema: Option<&str>,
    table: &str,
) -> Result<QueryResult, String> {
    let schema = resolve_schema(client, schema).await?;
    let schema_ref = schema.as_str();
    let row = fetch_optional(
        client,
        "SELECT pg_total_relation_size(c.oid), pg_relation_size(c.oid), \
                pg_indexes_size(c.oid), s.n_live_tup \
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
         LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid \
         WHERE n.nspname = $1 AND c.relname = $2",
        &[&schema_ref, &table],
    )
    .await
    .map_err(|e| format!("table stats failed: {e}"))?
    .ok_or_else(|| format!("Table {table} not found"))?;
    let num = |idx: usize| {
        row.try_get::<usize, Option<i64>>(idx)
            .ok()
            .flatten()
            .map(|v| v.to_string())
    };
    Ok(super::super::metric_result(vec![
        ("Total size (bytes)", num(0)),
        ("Table size (bytes)", num(1)),
        ("Indexes size (bytes)", num(2)),
        ("Live rows (estimate)", num(3)),
    ]))
}
