use super::model::PrestoClient;
use super::query::run_statement;
use super::query::run_statement_with_context;
use super::statements::quote_presto_ident;
use super::statements::sql_literal;
use crate::database::CatalogInfo;
use crate::database::ColumnDescription;
use crate::database::DbObject;
use crate::database::IndexInfo;
use crate::database::QueryResult;
use crate::database::SchemaInfo;
use crate::database::TableInfo;
use tokio_util::sync::CancellationToken;

pub(super) async fn current_catalog(client: &PrestoClient) -> Result<String, String> {
    client
        .catalog
        .lock()
        .await
        .clone()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            "Presto catalog is required for schema browsing. Set the Catalog field in this session."
                .to_string()
        })
}

pub(super) fn table_kind(table_type: &str) -> String {
    if table_type.eq_ignore_ascii_case("VIEW") {
        "view".to_string()
    } else {
        "table".to_string()
    }
}

pub async fn list_catalogs(client: &PrestoClient) -> Result<Vec<CatalogInfo>, String> {
    let token = CancellationToken::new();
    let res = run_statement(client, "SHOW CATALOGS", None, &token, false)
        .await?
        .result;
    Ok(res
        .rows
        .into_iter()
        .filter_map(|row| row.into_iter().next().flatten())
        .map(|name| CatalogInfo { name })
        .collect())
}

pub async fn list_schemas(
    client: &PrestoClient,
    catalog: Option<&str>,
) -> Result<Vec<SchemaInfo>, String> {
    let catalog = match catalog.filter(|value| !value.is_empty()) {
        Some(catalog) => catalog.to_string(),
        None => current_catalog(client).await?,
    };
    let token = CancellationToken::new();
    let res = run_statement_with_context(
        client,
        "SELECT schema_name FROM information_schema.schemata \
         WHERE schema_name <> 'information_schema' ORDER BY schema_name",
        None,
        &token,
        false,
        Some(&catalog),
        None,
    )
    .await?
    .result;
    Ok(res
        .rows
        .into_iter()
        .filter_map(|row| row.into_iter().next().flatten())
        .map(|name| SchemaInfo { name })
        .collect())
}

pub async fn list_tables(
    client: &PrestoClient,
    catalog: Option<&str>,
    schema: Option<&str>,
) -> Result<Vec<TableInfo>, String> {
    let catalog = match catalog.filter(|value| !value.is_empty()) {
        Some(catalog) => catalog.to_string(),
        None => current_catalog(client).await?,
    };
    let schema = match schema.filter(|value| !value.is_empty()) {
        Some(schema) => schema.to_string(),
        None => client.schema.lock().await.clone().ok_or_else(|| {
            "Presto schema is required for table browsing. Select a schema first.".to_string()
        })?,
    };
    let sql = format!(
        "SELECT table_name, table_type FROM information_schema.tables \
         WHERE table_schema = {} ORDER BY table_name",
        sql_literal(&schema)
    );
    let token = CancellationToken::new();
    let res = run_statement_with_context(
        client,
        &sql,
        None,
        &token,
        false,
        Some(&catalog),
        Some(&schema),
    )
    .await?
    .result;
    Ok(res
        .rows
        .into_iter()
        .filter_map(|row| {
            let name = row.first().cloned().flatten()?;
            let kind = row
                .get(1)
                .cloned()
                .flatten()
                .map(|value| table_kind(&value))
                .unwrap_or_else(|| "table".to_string());
            Some(TableInfo {
                name,
                kind,
                row_count: None,
            })
        })
        .collect())
}

pub async fn search_tables(
    client: &PrestoClient,
    catalog: Option<&str>,
    schema: Option<&str>,
    prefix: &str,
    limit: usize,
) -> Result<Vec<TableInfo>, String> {
    let catalog = match catalog.filter(|value| !value.is_empty()) {
        Some(catalog) => catalog.to_string(),
        None => current_catalog(client).await?,
    };
    let schema = match schema.filter(|value| !value.is_empty()) {
        Some(schema) => schema.to_string(),
        None => client.schema.lock().await.clone().ok_or_else(|| {
            "Presto schema is required for table completion. Select a schema first.".to_string()
        })?,
    };
    let prefix = sql_literal(prefix);
    let sql = format!(
        "SELECT table_name, table_type FROM information_schema.tables \
         WHERE table_schema = {} \
           AND substr(lower(table_name), 1, length(lower({prefix}))) = lower({prefix}) \
         ORDER BY table_name LIMIT {limit}",
        sql_literal(&schema),
    );
    let token = CancellationToken::new();
    let result = run_statement_with_context(
        client,
        &sql,
        None,
        &token,
        false,
        Some(&catalog),
        Some(&schema),
    )
    .await?
    .result;
    Ok(result
        .rows
        .into_iter()
        .filter_map(|row| {
            let name = row.first().cloned().flatten()?;
            let kind = row
                .get(1)
                .cloned()
                .flatten()
                .map(|value| table_kind(&value))
                .unwrap_or_else(|| "table".to_string());
            Some(TableInfo {
                name,
                kind,
                row_count: None,
            })
        })
        .collect())
}

pub async fn describe_table(
    client: &PrestoClient,
    catalog: Option<&str>,
    schema: Option<&str>,
    table: &str,
) -> Result<Vec<ColumnDescription>, String> {
    let catalog = match catalog.filter(|value| !value.is_empty()) {
        Some(catalog) => catalog.to_string(),
        None => current_catalog(client).await?,
    };
    let schema = match schema.filter(|value| !value.is_empty()) {
        Some(schema) => schema.to_string(),
        None => client.schema.lock().await.clone().ok_or_else(|| {
            "Presto schema is required for table description. Select a schema first.".to_string()
        })?,
    };
    let sql = format!(
        "SELECT column_name, data_type, is_nullable, column_default \
         FROM information_schema.columns \
         WHERE table_schema = {} AND table_name = {} \
         ORDER BY ordinal_position",
        sql_literal(&schema),
        sql_literal(table),
    );
    let token = CancellationToken::new();
    let res = run_statement_with_context(
        client,
        &sql,
        None,
        &token,
        false,
        Some(&catalog),
        Some(&schema),
    )
    .await?
    .result;
    Ok(res
        .rows
        .into_iter()
        .filter_map(|row| {
            let name = row.first().cloned().flatten()?;
            let type_name = row.get(1).cloned().flatten().unwrap_or_default();
            let nullable = row
                .get(2)
                .cloned()
                .flatten()
                .is_some_and(|value| value.eq_ignore_ascii_case("YES"));
            let default = row.get(3).cloned().flatten();
            Some(ColumnDescription {
                name,
                type_name,
                nullable,
                default,
                primary_key: false,
            })
        })
        .collect())
}

pub async fn list_indexes(
    _client: &PrestoClient,
    _schema: Option<&str>,
    _table: &str,
) -> Result<Vec<IndexInfo>, String> {
    Ok(Vec::new())
}

/// Presto/Trino catalogs expose only tables and views (surfaced via
/// `list_tables`); there are no routine-style schema objects to list.
pub async fn list_objects(
    _client: &PrestoClient,
    _schema: Option<&str>,
    _kind: &str,
) -> Result<Vec<DbObject>, String> {
    Ok(Vec::new())
}

/// Resolve the effective catalog + schema and build a quoted qualified name.
pub(super) async fn presto_qualified(
    client: &PrestoClient,
    schema: Option<&str>,
    name: &str,
) -> Result<String, String> {
    let catalog = current_catalog(client).await?;
    let schema = match schema.filter(|value| !value.is_empty()) {
        Some(schema) => schema.to_string(),
        None => client
            .schema
            .lock()
            .await
            .clone()
            .ok_or_else(|| "Presto schema is required. Select a schema first.".to_string())?,
    };
    Ok(format!(
        "{}.{}.{}",
        quote_presto_ident(&catalog),
        quote_presto_ident(&schema),
        quote_presto_ident(name)
    ))
}

pub async fn object_ddl(
    client: &PrestoClient,
    schema: Option<&str>,
    kind: &str,
    name: &str,
) -> Result<String, String> {
    let qualified = presto_qualified(client, schema, name).await?;
    let verb = if kind == "view" { "VIEW" } else { "TABLE" };
    let sql = format!("SHOW CREATE {verb} {qualified}");
    let token = CancellationToken::new();
    let res = run_statement(client, &sql, None, &token, false)
        .await?
        .result;
    res.rows
        .first()
        .and_then(|r| r.first().cloned().flatten())
        .ok_or_else(|| format!("No DDL returned for {name}"))
}

pub async fn table_stats(
    client: &PrestoClient,
    schema: Option<&str>,
    table: &str,
) -> Result<QueryResult, String> {
    let qualified = presto_qualified(client, schema, table).await?;
    let sql = format!("SHOW STATS FOR {qualified}");
    let token = CancellationToken::new();
    Ok(run_statement(client, &sql, None, &token, false)
        .await?
        .result)
}
