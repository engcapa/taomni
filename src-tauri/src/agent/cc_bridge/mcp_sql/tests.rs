use super::echo::SqlEcho;
use super::formatting::csv_field;
use super::formatting::query_result_to_csv;
use super::parameters::ReadResultParams;
use super::results::parse_read_op;
use crate::database::QueryResult;

use crate::database::ColumnInfo;

fn col(name: &str) -> ColumnInfo {
    ColumnInfo {
        name: name.into(),
        type_name: "text".into(),
    }
}

#[test]
fn csv_field_quotes_only_when_needed() {
    assert_eq!(csv_field("plain"), "plain");
    assert_eq!(csv_field("a,b"), "\"a,b\"");
    assert_eq!(csv_field("he said \"hi\""), "\"he said \"\"hi\"\"\"");
    assert_eq!(csv_field("line1\nline2"), "\"line1\nline2\"");
}

#[test]
fn query_result_to_csv_has_header_and_null_blanks() {
    let r = QueryResult {
        columns: vec![col("id"), col("name")],
        rows: vec![
            vec![Some("1".into()), Some("alice".into())],
            vec![Some("2".into()), None], // NULL → empty field
        ],
        rows_affected: 0,
        duration_ms: 1,
        warnings: vec![],
    };
    let csv = query_result_to_csv(&r);
    let lines: Vec<&str> = csv.lines().collect();
    assert_eq!(lines[0], "id,name");
    assert_eq!(lines[1], "1,alice");
    assert_eq!(lines[2], "2,");
}

#[test]
fn parse_read_op_rejects_jq_and_unknown() {
    let base = |op: &str| ReadResultParams {
        capture_id: "c".into(),
        op: op.into(),
        n: None,
        start: None,
        end: None,
        pattern: None,
        context: None,
    };
    assert!(parse_read_op(&base("head")).is_ok());
    assert!(parse_read_op(&base("stats")).is_ok());
    assert!(
        parse_read_op(&base("jq")).is_err(),
        "jq not supported for CSV"
    );
    assert!(parse_read_op(&base("range")).is_err(), "range needs bounds");
    assert!(parse_read_op(&base("grep")).is_err(), "grep needs pattern");
}

#[test]
fn sql_echo_serializes_camel_case() {
    let r = QueryResult {
        columns: vec![col("id")],
        rows: vec![vec![Some("1".into())], vec![Some("2".into())]],
        rows_affected: 0,
        duration_ms: 7,
        warnings: vec![],
    };
    let payload = SqlEcho {
        thread_id: "t1".into(),
        sql: "SELECT 1".into(),
        ok: true,
        rows_affected: r.rows_affected,
        row_count: r.rows.len(),
        duration_ms: r.duration_ms,
        captured: true,
        error: None,
    };
    let v = serde_json::to_value(&payload).unwrap();
    assert_eq!(v["threadId"], "t1");
    assert_eq!(v["rowCount"], 2);
    assert_eq!(v["durationMs"], 7);
    assert_eq!(v["captured"], true);
    assert_eq!(v["error"], serde_json::Value::Null);
}
