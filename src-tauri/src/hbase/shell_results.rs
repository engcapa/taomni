use super::model::HBaseShellResult;
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use serde_json::Value;
use serde_json::json;
pub(super) fn cellset_body(row: &str, column: &str, value: &str) -> Value {
    json!({
        "Row": [{
            "key": b64(row),
            "Cell": [{
                "column": b64(column),
                "$": b64(value),
            }]
        }]
    })
}

pub(super) fn cellset_rows(value: &Value) -> Vec<Vec<String>> {
    let Some(rows) = value
        .get("Row")
        .or_else(|| value.get("row"))
        .and_then(Value::as_array)
    else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for row in rows {
        let key = row
            .get("key")
            .and_then(Value::as_str)
            .map(deb64)
            .unwrap_or_default();
        let cells = row
            .get("Cell")
            .or_else(|| row.get("cell"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        for cell in cells {
            let column = cell
                .get("column")
                .and_then(Value::as_str)
                .map(deb64)
                .unwrap_or_default();
            let timestamp = cell
                .get("timestamp")
                .or_else(|| cell.get("Timestamp"))
                .and_then(|v| v.as_i64().or_else(|| v.as_str()?.parse::<i64>().ok()))
                .map(|v| v.to_string())
                .unwrap_or_default();
            let value = cell
                .get("$")
                .or_else(|| cell.get("value"))
                .and_then(Value::as_str)
                .map(deb64)
                .unwrap_or_default();
            out.push(vec![key.clone(), column, timestamp, value]);
        }
    }
    out
}

pub(super) fn value_result(command: String, message: String, value: &Value) -> HBaseShellResult {
    match value.as_object() {
        Some(obj) => table_result(
            command,
            message,
            vec!["KEY", "VALUE"],
            obj.iter()
                .map(|(key, value)| vec![key.clone(), value_to_shell_string(value)])
                .collect(),
        ),
        None => message_result(command, value_to_shell_string(value)),
    }
}

pub(super) fn help_result(command: String) -> HBaseShellResult {
    table_result(
        command,
        "Supported HBase shell commands (enable/disable/alter require a Native or Thrift connection)".into(),
        vec!["COMMAND", "EXAMPLE"],
        vec![
            vec!["list".into(), "list".into()],
            vec!["describe".into(), "describe 'table'".into()],
            vec!["exists".into(), "exists 'table'".into()],
            vec!["count".into(), "count 'table'".into()],
            vec![
                "scan".into(),
                "scan 'table', {LIMIT=>50, STARTROW=>'r1', COLUMNS=>['cf:q']}".into(),
            ],
            vec!["get".into(), "get 'table', 'row', {COLUMN=>'cf:q'}".into()],
            vec!["put".into(), "put 'table', 'row', 'cf:q', 'value'".into()],
            vec!["delete".into(), "delete 'table', 'row', 'cf:q'".into()],
            vec!["deleteall".into(), "deleteall 'table', 'row'".into()],
            vec!["create".into(), "create 'table', 'cf'".into()],
            vec!["alter".into(), "alter 'table', {NAME=>'cf', VERSIONS=>5}".into()],
            vec!["enable".into(), "enable 'table'".into()],
            vec!["disable".into(), "disable 'table'".into()],
            vec!["drop".into(), "drop 'table'".into()],
            vec!["status".into(), "status".into()],
            vec!["version".into(), "version".into()],
        ],
    )
}

pub(super) fn table_result(
    command: String,
    message: String,
    columns: Vec<&str>,
    rows: Vec<Vec<String>>,
) -> HBaseShellResult {
    HBaseShellResult {
        command,
        message,
        columns: columns.into_iter().map(ToString::to_string).collect(),
        rows,
        warnings: Vec::new(),
        duration_ms: 0,
    }
}

pub(super) fn message_result(command: String, message: String) -> HBaseShellResult {
    HBaseShellResult {
        command,
        message,
        columns: Vec::new(),
        rows: Vec::new(),
        warnings: Vec::new(),
        duration_ms: 0,
    }
}

pub(super) fn value_to_shell_string(value: &Value) -> String {
    match value {
        Value::Null => "NULL".into(),
        Value::Bool(v) => v.to_string(),
        Value::Number(v) => v.to_string(),
        Value::String(v) => v.clone(),
        _ => serde_json::to_string(value).unwrap_or_default(),
    }
}

pub(super) fn enc(value: &str) -> String {
    urlencoding::encode(value).into_owned()
}

pub(super) fn b64(value: &str) -> String {
    B64.encode(value.as_bytes())
}

pub(super) fn deb64(value: &str) -> String {
    B64.decode(value.as_bytes())
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
        .unwrap_or_else(|_| value.to_string())
}
