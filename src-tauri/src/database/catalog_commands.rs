use super::catalog_helpers::metadata_search_limit;
use super::model::CatalogInfo;
use super::model::ColumnDescription;
use super::model::ColumnInfo;
use super::model::DbObject;
use super::model::ForeignKeyInfo;
use super::model::IndexInfo;
use super::model::QueryResult;
use super::model::SchemaInfo;
use super::model::TableInfo;
use super::session::DbHandle;
use super::session::get_session;
use crate::database::clickhouse;
use crate::database::oracle;
use crate::database::panwei;
use crate::database::presto;
use crate::database::sql;
use crate::state::AppState;
use sqlx_mysql::MySql;
use sqlx_postgres::Postgres;
use tauri::State;

// ---------------------------------------------------------------------------
// Tauri commands — SQL schema introspection + queries
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn db_list_catalogs(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Vec<CatalogInfo>, String> {
    let session = get_session(&state, &session_id).await?;
    match &session.handle {
        DbHandle::Presto(client) => presto::list_catalogs(client).await,
        DbHandle::MySql(_)
        | DbHandle::Postgres(_)
        | DbHandle::PanWeiDB(_)
        | DbHandle::Oracle(_)
        | DbHandle::SqlServer(_)
        | DbHandle::StarRocks(_)
        | DbHandle::ClickHouse(_)
        | DbHandle::Redis(_) => Ok(Vec::new()),
    }
}

#[tauri::command]
pub async fn db_list_schemas(
    state: State<'_, AppState>,
    session_id: String,
    catalog: Option<String>,
) -> Result<Vec<SchemaInfo>, String> {
    let session = get_session(&state, &session_id).await?;
    match &session.handle {
        DbHandle::MySql(pool) => sql::list_schemas_mysql(pool).await,
        DbHandle::StarRocks(pool) => sql::list_schemas_mysql(pool).await,
        DbHandle::Postgres(pool) => sql::list_schemas_postgres(pool).await,
        DbHandle::PanWeiDB(client) => panwei::list_schemas(client).await,
        DbHandle::Oracle(client) => oracle::list_schemas(client).await,
        DbHandle::SqlServer(client) => sql::list_schemas_sqlserver(client).await,
        DbHandle::ClickHouse(client) => clickhouse::list_schemas(client).await,
        DbHandle::Presto(client) => presto::list_schemas(client, catalog.as_deref()).await,
        DbHandle::Redis(_) => Err("Redis has no SQL schemas".into()),
    }
}

#[tauri::command]
pub async fn db_list_tables(
    state: State<'_, AppState>,
    session_id: String,
    schema: Option<String>,
    catalog: Option<String>,
) -> Result<Vec<TableInfo>, String> {
    let session = get_session(&state, &session_id).await?;
    match &session.handle {
        DbHandle::MySql(pool) => sql::list_tables_mysql(pool, schema.as_deref()).await,
        DbHandle::StarRocks(pool) => sql::list_tables_mysql(pool, schema.as_deref()).await,
        DbHandle::Postgres(pool) => sql::list_tables_postgres(pool, schema.as_deref()).await,
        DbHandle::PanWeiDB(client) => panwei::list_tables(client, schema.as_deref()).await,
        DbHandle::Oracle(client) => oracle::list_tables(client, schema.as_deref()).await,
        DbHandle::SqlServer(client) => sql::list_tables_sqlserver(client, schema.as_deref()).await,
        DbHandle::ClickHouse(client) => clickhouse::list_tables(client, schema.as_deref()).await,
        DbHandle::Presto(client) => {
            presto::list_tables(client, catalog.as_deref(), schema.as_deref()).await
        }
        DbHandle::Redis(_) => Err("Redis has no tables".into()),
    }
}

#[tauri::command]
pub async fn db_search_tables(
    state: State<'_, AppState>,
    session_id: String,
    schema: Option<String>,
    catalog: Option<String>,
    prefix: String,
    limit: Option<u32>,
) -> Result<Vec<TableInfo>, String> {
    let session = get_session(&state, &session_id).await?;
    let limit = metadata_search_limit(limit);
    match &session.handle {
        DbHandle::MySql(pool) => {
            sql::search_tables_mysql(pool, schema.as_deref(), &prefix, limit).await
        }
        DbHandle::StarRocks(pool) => {
            sql::search_tables_mysql(pool, schema.as_deref(), &prefix, limit).await
        }
        DbHandle::Postgres(pool) => {
            sql::search_tables_postgres(pool, schema.as_deref(), &prefix, limit).await
        }
        DbHandle::PanWeiDB(client) => {
            panwei::search_tables(client, schema.as_deref(), &prefix, limit).await
        }
        DbHandle::Oracle(client) => {
            oracle::search_tables(client, schema.as_deref(), &prefix, limit).await
        }
        DbHandle::SqlServer(client) => {
            sql::search_tables_sqlserver(client, schema.as_deref(), &prefix, limit).await
        }
        DbHandle::ClickHouse(client) => {
            clickhouse::search_tables(client, schema.as_deref(), &prefix, limit).await
        }
        DbHandle::Presto(client) => {
            presto::search_tables(
                client,
                catalog.as_deref(),
                schema.as_deref(),
                &prefix,
                limit,
            )
            .await
        }
        DbHandle::Redis(_) => Err("Redis has no tables".into()),
    }
}

#[tauri::command]
pub async fn db_describe_table(
    state: State<'_, AppState>,
    session_id: String,
    schema: Option<String>,
    table: String,
    catalog: Option<String>,
) -> Result<Vec<ColumnDescription>, String> {
    let session = get_session(&state, &session_id).await?;
    match &session.handle {
        DbHandle::MySql(pool) => sql::describe_table_mysql(pool, schema.as_deref(), &table).await,
        DbHandle::StarRocks(pool) => {
            sql::describe_table_mysql(pool, schema.as_deref(), &table).await
        }
        DbHandle::Postgres(pool) => {
            sql::describe_table_postgres(pool, schema.as_deref(), &table).await
        }
        DbHandle::PanWeiDB(client) => {
            panwei::describe_table(client, schema.as_deref(), &table).await
        }
        DbHandle::Oracle(client) => oracle::describe_table(client, schema.as_deref(), &table).await,
        DbHandle::SqlServer(client) => {
            sql::describe_table_sqlserver(client, schema.as_deref(), &table).await
        }
        DbHandle::ClickHouse(client) => {
            clickhouse::describe_table(client, schema.as_deref(), &table).await
        }
        DbHandle::Presto(client) => {
            presto::describe_table(client, catalog.as_deref(), schema.as_deref(), &table).await
        }
        DbHandle::Redis(_) => Err("Redis has no tables".into()),
    }
}

#[tauri::command]
pub async fn db_list_foreign_keys(
    state: State<'_, AppState>,
    session_id: String,
    schema: Option<String>,
    table: String,
    catalog: Option<String>,
) -> Result<Vec<ForeignKeyInfo>, String> {
    let session = get_session(&state, &session_id).await?;
    match &session.handle {
        DbHandle::MySql(pool) => {
            sql::list_foreign_keys_mysql(pool, schema.as_deref(), &table).await
        }
        DbHandle::Postgres(pool) => {
            sql::list_foreign_keys_postgres(pool, schema.as_deref(), &table).await
        }
        DbHandle::PanWeiDB(client) => {
            panwei::list_foreign_keys(client, schema.as_deref(), &table).await
        }
        DbHandle::Oracle(client) => {
            oracle::list_foreign_keys(client, schema.as_deref(), &table).await
        }
        DbHandle::SqlServer(client) => {
            sql::list_foreign_keys_sqlserver(client, schema.as_deref(), &table).await
        }
        DbHandle::StarRocks(_) | DbHandle::ClickHouse(_) | DbHandle::Presto(_) => {
            let _ = catalog;
            Ok(Vec::new())
        }
        DbHandle::Redis(_) => Err("Redis has no foreign keys".into()),
    }
}

#[tauri::command]
pub async fn db_list_indexes(
    state: State<'_, AppState>,
    session_id: String,
    schema: Option<String>,
    table: String,
) -> Result<Vec<IndexInfo>, String> {
    let session = get_session(&state, &session_id).await?;
    match &session.handle {
        DbHandle::MySql(pool) => sql::list_indexes_mysql(pool, schema.as_deref(), &table).await,
        DbHandle::StarRocks(_) => Ok(Vec::new()),
        DbHandle::Postgres(pool) => {
            sql::list_indexes_postgres(pool, schema.as_deref(), &table).await
        }
        DbHandle::PanWeiDB(client) => panwei::list_indexes(client, schema.as_deref(), &table).await,
        DbHandle::Oracle(client) => oracle::list_indexes(client, schema.as_deref(), &table).await,
        DbHandle::SqlServer(client) => {
            sql::list_indexes_sqlserver(client, schema.as_deref(), &table).await
        }
        DbHandle::ClickHouse(_) => Ok(Vec::new()),
        DbHandle::Presto(client) => presto::list_indexes(client, schema.as_deref(), &table).await,
        DbHandle::Redis(_) => Err("Redis has no indexes".into()),
    }
}

#[tauri::command]
pub async fn db_list_objects(
    state: State<'_, AppState>,
    session_id: String,
    schema: Option<String>,
    kind: String,
) -> Result<Vec<DbObject>, String> {
    let session = get_session(&state, &session_id).await?;
    match &session.handle {
        DbHandle::MySql(pool) => sql::list_objects_mysql(pool, schema.as_deref(), &kind).await,
        DbHandle::StarRocks(_) => Ok(Vec::new()),
        DbHandle::Postgres(pool) => {
            sql::list_objects_postgres(pool, schema.as_deref(), &kind).await
        }
        DbHandle::PanWeiDB(client) => panwei::list_objects(client, schema.as_deref(), &kind).await,
        DbHandle::Oracle(client) => oracle::list_objects(client, schema.as_deref(), &kind).await,
        DbHandle::SqlServer(client) => {
            sql::list_objects_sqlserver(client, schema.as_deref(), &kind).await
        }
        DbHandle::ClickHouse(client) => {
            clickhouse::list_objects(client, schema.as_deref(), &kind).await
        }
        DbHandle::Presto(client) => presto::list_objects(client, schema.as_deref(), &kind).await,
        DbHandle::Redis(_) => Err("Redis has no SQL objects".into()),
    }
}

#[tauri::command]
pub async fn db_object_ddl(
    state: State<'_, AppState>,
    session_id: String,
    schema: Option<String>,
    kind: String,
    name: String,
) -> Result<String, String> {
    let session = get_session(&state, &session_id).await?;
    match &session.handle {
        DbHandle::MySql(pool) => sql::object_ddl_mysql(pool, schema.as_deref(), &kind, &name).await,
        DbHandle::StarRocks(pool) => {
            sql::object_ddl_mysql(pool, schema.as_deref(), &kind, &name).await
        }
        DbHandle::Postgres(pool) => {
            sql::object_ddl_postgres(pool, schema.as_deref(), &kind, &name).await
        }
        DbHandle::PanWeiDB(client) => {
            panwei::object_ddl(client, schema.as_deref(), &kind, &name).await
        }
        DbHandle::Oracle(client) => {
            oracle::object_ddl(client, schema.as_deref(), &kind, &name).await
        }
        DbHandle::SqlServer(client) => {
            sql::object_ddl_sqlserver(client, schema.as_deref(), &kind, &name).await
        }
        DbHandle::ClickHouse(client) => {
            clickhouse::object_ddl(client, schema.as_deref(), &kind, &name).await
        }
        DbHandle::Presto(client) => {
            presto::object_ddl(client, schema.as_deref(), &kind, &name).await
        }
        DbHandle::Redis(_) => Err("Redis has no SQL objects".into()),
    }
}

#[tauri::command]
pub async fn db_table_stats(
    state: State<'_, AppState>,
    session_id: String,
    schema: Option<String>,
    table: String,
) -> Result<QueryResult, String> {
    let session = get_session(&state, &session_id).await?;
    match &session.handle {
        DbHandle::MySql(pool) => sql::table_stats_mysql(pool, schema.as_deref(), &table).await,
        DbHandle::StarRocks(pool) => sql::table_stats_mysql(pool, schema.as_deref(), &table).await,
        DbHandle::Postgres(pool) => {
            sql::table_stats_postgres(pool, schema.as_deref(), &table).await
        }
        DbHandle::PanWeiDB(client) => panwei::table_stats(client, schema.as_deref(), &table).await,
        DbHandle::Oracle(client) => oracle::table_stats(client, schema.as_deref(), &table).await,
        DbHandle::SqlServer(client) => {
            sql::table_stats_sqlserver(client, schema.as_deref(), &table).await
        }
        DbHandle::ClickHouse(client) => {
            clickhouse::table_stats(client, schema.as_deref(), &table).await
        }
        DbHandle::Presto(client) => presto::table_stats(client, schema.as_deref(), &table).await,
        DbHandle::Redis(_) => Err("Redis has no tables".into()),
    }
}

/// Build a two-column ("Metric"/"Value") result from label/value pairs, used by
/// the per-engine `table_stats_*` helpers.
pub(crate) fn metric_result(pairs: Vec<(&str, Option<String>)>) -> QueryResult {
    QueryResult {
        columns: vec![
            ColumnInfo {
                name: "Metric".into(),
                type_name: "text".into(),
            },
            ColumnInfo {
                name: "Value".into(),
                type_name: "text".into(),
            },
        ],
        rows: pairs
            .into_iter()
            .map(|(label, value)| vec![Some(label.to_string()), value])
            .collect(),
        rows_affected: 0,
        duration_ms: 0,
        warnings: Vec::new(),
    }
}
