use super::connection::PanWeiClient;
use super::query::fetch;
use super::query::fetch_optional;
use crate::database::SchemaInfo;
use crate::database::TableInfo;
use tokio_opengauss::SimpleQueryMessage;

pub(super) const FALLBACK_SCHEMA: &str = "public";

pub(super) fn is_user_schema_name(name: &str) -> bool {
    let trimmed = name.trim();
    !trimmed.is_empty() && trimmed != "information_schema" && !trimmed.starts_with("pg_")
}

pub(super) fn ordered_schema_infos(names: Vec<String>, preferred: Option<&str>) -> Vec<SchemaInfo> {
    let mut seen = std::collections::BTreeSet::new();
    let mut ordered = Vec::new();
    if let Some(preferred) = preferred
        .map(str::trim)
        .filter(|name| is_user_schema_name(name))
    {
        seen.insert(preferred.to_string());
        ordered.push(preferred.to_string());
    }
    for name in names {
        let name = name.trim();
        if is_user_schema_name(name) && seen.insert(name.to_string()) {
            ordered.push(name.to_string());
        }
    }
    ordered
        .into_iter()
        .map(|name| SchemaInfo { name })
        .collect()
}

pub(super) async fn current_schema(client: &PanWeiClient) -> Result<Option<String>, String> {
    let row = fetch_optional(client, "SELECT current_schema()", &[]).await?;
    Ok(row
        .and_then(|row| row.try_get::<usize, String>(0).ok())
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty()))
}

pub(super) async fn resolve_schema(
    client: &PanWeiClient,
    schema: Option<&str>,
) -> Result<String, String> {
    if let Some(schema) = schema.map(str::trim).filter(|schema| !schema.is_empty()) {
        return Ok(schema.to_string());
    }
    Ok(current_schema(client)
        .await?
        .filter(|schema| is_user_schema_name(schema))
        .unwrap_or_else(|| FALLBACK_SCHEMA.to_string()))
}

pub(super) fn panwei_table_kind(table_type: &str) -> String {
    if table_type.eq_ignore_ascii_case("VIEW") {
        "view".to_string()
    } else {
        "table".to_string()
    }
}

pub(super) fn panwei_relkind_to_kind(relkind: &str) -> Option<&'static str> {
    match relkind {
        "r" | "p" | "f" => Some("table"),
        "v" => Some("view"),
        "m" => Some("materialized_view"),
        _ => None,
    }
}

pub(super) fn merge_table(
    tables: &mut std::collections::BTreeMap<String, TableInfo>,
    table: TableInfo,
) {
    tables.insert(table.name.clone(), table);
}

pub(super) async fn list_tables_show(client: &PanWeiClient) -> Result<Vec<TableInfo>, String> {
    let guard = client.inner.client.lock().await;
    let messages = guard
        .simple_query("SHOW TABLES")
        .await
        .map_err(|e| format!("SHOW TABLES failed: {e}"))?;
    Ok(messages
        .into_iter()
        .filter_map(|message| match message {
            SimpleQueryMessage::Row(row) => row
                .try_get(0)
                .ok()
                .flatten()
                .map(|name: &str| name.trim().to_string())
                .filter(|name| !name.is_empty())
                .map(|name| TableInfo {
                    name,
                    kind: "table".to_string(),
                    row_count: None,
                }),
            _ => None,
        })
        .collect())
}

pub(super) fn should_use_show_tables_fallback(schema: &str, current: Option<&str>) -> bool {
    current
        .map(str::trim)
        .filter(|current| !current.is_empty())
        .is_some_and(|current| current == schema)
}

pub async fn list_schemas(client: &PanWeiClient) -> Result<Vec<SchemaInfo>, String> {
    let current = current_schema(client).await.ok().flatten();
    let rows = fetch(
        client,
        "SELECT schema_name FROM information_schema.schemata \
         WHERE schema_name NOT LIKE 'pg_%' AND schema_name <> 'information_schema' \
         ORDER BY schema_name",
        &[],
    )
    .await
    .map_err(|e| format!("list schemas failed: {e}"))?;
    let names = rows
        .iter()
        .filter_map(|row| row.try_get::<usize, String>(0).ok())
        .collect();
    Ok(ordered_schema_infos(names, current.as_deref()))
}

pub async fn list_tables(
    client: &PanWeiClient,
    schema: Option<&str>,
) -> Result<Vec<TableInfo>, String> {
    let current = current_schema(client).await.ok().flatten();
    let schema = schema
        .map(str::trim)
        .filter(|schema| !schema.is_empty())
        .map(str::to_string)
        .or_else(|| current.clone().filter(|schema| is_user_schema_name(schema)))
        .unwrap_or_else(|| FALLBACK_SCHEMA.to_string());
    let schema_ref = schema.as_str();
    let mut tables = std::collections::BTreeMap::<String, TableInfo>::new();
    let mut errors = Vec::new();

    match fetch(
        client,
        "SELECT t.table_name, t.table_type, \
                CASE WHEN c.reltuples >= 0 THEN c.reltuples::bigint ELSE NULL END AS row_count \
         FROM information_schema.tables t \
         LEFT JOIN pg_namespace n ON n.nspname = t.table_schema \
         LEFT JOIN pg_class c ON c.relname = t.table_name AND c.relnamespace = n.oid \
         WHERE t.table_schema = $1 ORDER BY t.table_name",
        &[&schema_ref],
    )
    .await
    {
        Ok(rows) => {
            for row in &rows {
                let Some(name) = row.try_get::<usize, String>(0).ok() else {
                    continue;
                };
                let table_type: String = row.try_get(1).unwrap_or_default();
                let row_count: Option<i64> = row.try_get(2).ok().flatten();
                merge_table(
                    &mut tables,
                    TableInfo {
                        name,
                        kind: panwei_table_kind(&table_type),
                        row_count,
                    },
                );
            }
        }
        Err(err) => errors.push(format!("information_schema.tables: {err}")),
    }

    match fetch(
        client,
        "SELECT c.relname, c.relkind::text, \
                CASE WHEN c.reltuples >= 0 THEN c.reltuples::bigint ELSE NULL END AS row_count \
         FROM pg_catalog.pg_class c \
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
         WHERE n.nspname = $1 AND c.relkind IN ('r','p','f','v','m') \
         ORDER BY c.relname",
        &[&schema_ref],
    )
    .await
    {
        Ok(rows) => {
            for row in &rows {
                let Some(name) = row.try_get::<usize, String>(0).ok() else {
                    continue;
                };
                let relkind: String = row.try_get(1).unwrap_or_default();
                let Some(kind) = panwei_relkind_to_kind(&relkind) else {
                    continue;
                };
                let row_count: Option<i64> = row.try_get(2).ok().flatten();
                merge_table(
                    &mut tables,
                    TableInfo {
                        name,
                        kind: kind.to_string(),
                        row_count,
                    },
                );
            }
        }
        Err(err) => errors.push(format!("pg_catalog.pg_class: {err}")),
    }

    if tables.is_empty() && should_use_show_tables_fallback(&schema, current.as_deref()) {
        match list_tables_show(client).await {
            Ok(show_tables) => {
                for table in show_tables {
                    merge_table(&mut tables, table);
                }
            }
            Err(err) => errors.push(err),
        }
    }

    if tables.is_empty() && !errors.is_empty() {
        return Err(format!("list tables failed: {}", errors.join("; ")));
    }

    Ok(tables.into_values().collect())
}

pub async fn search_tables(
    client: &PanWeiClient,
    schema: Option<&str>,
    prefix: &str,
    limit: usize,
) -> Result<Vec<TableInfo>, String> {
    let schema = resolve_schema(client, schema).await?;
    let schema_ref = schema.as_str();
    let prefix_ref = prefix;
    let limit = i64::try_from(limit).unwrap_or(i64::MAX);
    let rows = fetch(
        client,
        "SELECT c.relname, c.relkind::text \
         FROM pg_catalog.pg_class c \
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
         WHERE n.nspname = $1 AND c.relkind IN ('r','p','f','v','m') \
           AND LEFT(LOWER(c.relname), char_length($2)) = LOWER($2) \
         ORDER BY c.relname LIMIT $3",
        &[&schema_ref, &prefix_ref, &limit],
    )
    .await
    .map_err(|error| format!("search tables failed: {error}"))?;

    Ok(rows
        .iter()
        .filter_map(|row| {
            let name = row.try_get::<usize, String>(0).ok()?;
            let relkind: String = row.try_get(1).unwrap_or_default();
            let kind = panwei_relkind_to_kind(&relkind)?;
            Some(TableInfo {
                name,
                kind: kind.to_string(),
                row_count: None,
            })
        })
        .collect())
}
