use super::model::PrestoColumn;
use super::model::PrestoError;
use crate::database::ColumnInfo;

pub(super) fn presto_columns(columns: Vec<PrestoColumn>) -> Vec<ColumnInfo> {
    columns
        .into_iter()
        .map(|column| ColumnInfo {
            name: column.name,
            type_name: column.type_name,
        })
        .collect()
}

pub(super) fn json_cell_to_string(v: &serde_json::Value) -> Option<String> {
    match v {
        serde_json::Value::Null => None,
        serde_json::Value::String(s) => Some(s.clone()),
        serde_json::Value::Bool(b) => Some(b.to_string()),
        serde_json::Value::Number(n) => Some(n.to_string()),
        other => Some(other.to_string()),
    }
}

pub(super) fn format_presto_error(error: PrestoError) -> String {
    let mut message = error.message;
    if let Some(name) = error.error_name {
        message = format!("{name}: {message}");
    }
    if let Some(location) = error.error_location {
        message = format!(
            "{message} at line {}, column {}",
            location.line_number, location.column_number
        );
    }
    message
}
