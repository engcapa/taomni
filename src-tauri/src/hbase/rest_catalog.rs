use super::model::HBaseColumnFamily;
use super::model::HBaseTableInfo;
use super::model::HBaseTableSchema;
use super::rest_http::get_json;
use super::rest_session::RestSession;
use super::shell_results::enc;
use super::shell_results::value_to_shell_string;
use serde_json::Value;
pub(super) async fn list_tables(session: &RestSession) -> Result<Vec<HBaseTableInfo>, String> {
    let value = get_json(session, "/?format=json").await?;
    Ok(extract_table_names(&value)
        .into_iter()
        .map(|name| HBaseTableInfo { name })
        .collect())
}

pub(super) fn extract_table_names(value: &Value) -> Vec<String> {
    let candidates = [
        value.get("table"),
        value.get("Table"),
        value.get("tables"),
        value.get("Tables"),
    ];
    for candidate in candidates.into_iter().flatten() {
        if let Some(array) = candidate.as_array() {
            return array
                .iter()
                .filter_map(|item| {
                    item.as_str().map(ToString::to_string).or_else(|| {
                        item.get("name")
                            .and_then(Value::as_str)
                            .map(ToString::to_string)
                    })
                })
                .collect();
        }
    }
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(ToString::to_string))
                .collect()
        })
        .unwrap_or_default()
}

pub(super) async fn describe_table(
    session: &RestSession,
    table: &str,
) -> Result<HBaseTableSchema, String> {
    let table = session.table_name(table);
    let path = format!("/{}/schema?format=json", enc(&table));
    let value = get_json(session, &path).await?;
    Ok(parse_schema(&table, &value))
}

pub(super) fn parse_schema(fallback_name: &str, value: &Value) -> HBaseTableSchema {
    let name = value
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or(fallback_name)
        .to_string();
    let schemas = value
        .get("ColumnSchema")
        .or_else(|| value.get("columnSchema"))
        .or_else(|| value.get("columns"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let column_families = schemas
        .into_iter()
        .filter_map(|entry| {
            let obj = entry.as_object()?;
            let name = obj.get("name").and_then(Value::as_str)?.to_string();
            let attributes = obj
                .iter()
                .filter_map(|(key, value)| {
                    if key == "name" {
                        return None;
                    }
                    Some((key.clone(), value_to_shell_string(value)))
                })
                .collect();
            Some(HBaseColumnFamily { name, attributes })
        })
        .collect();
    HBaseTableSchema {
        name,
        column_families,
    }
}
