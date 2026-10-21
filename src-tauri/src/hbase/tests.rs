use super::native_commands::count_distinct_rows;
use super::rest_http::describe_request_error;
use super::rest_operations::looks_like_missing;
use super::rest_operations::scanner_location;
use super::shell_parser::ShellCommand;
use super::shell_parser::parse_shell_command;
use super::shell_results::b64;
use super::shell_results::cellset_rows;
use crate::hbase::native::client::ResultRow;
use reqwest::Client;
use reqwest::header::HeaderMap;
use reqwest::header::LOCATION;
use serde_json::json;
#[test]
fn parses_get_with_bare_column() {
    // A bare quoted column must not be mistaken for an option map.
    match parse_shell_command("get 't1', 'row2', 'cf1:name'").unwrap() {
        ShellCommand::Get { table, row, column } => {
            assert_eq!(table, "t1");
            assert_eq!(row, "row2");
            assert_eq!(column.as_deref(), Some("cf1:name"));
        }
        other => panic!("unexpected command: {other:?}"),
    }
}

#[test]
fn parses_get_with_column_map() {
    match parse_shell_command("get 't1', 'row2', {COLUMN=>'cf1:name'}").unwrap() {
        ShellCommand::Get { column, .. } => {
            assert_eq!(column.as_deref(), Some("cf1:name"));
        }
        other => panic!("unexpected command: {other:?}"),
    }
}

#[test]
fn parses_get_without_column() {
    match parse_shell_command("get 't1', 'row2'").unwrap() {
        ShellCommand::Get { column, .. } => assert!(column.is_none()),
        other => panic!("unexpected command: {other:?}"),
    }
}

#[test]
fn parses_scan_options() {
    let command = parse_shell_command(
        "scan 't1', {LIMIT=>20, STARTROW=>'r1', STOPROW=>'r9', COLUMNS=>['cf:q','cf2']}",
    )
    .unwrap();
    match command {
        ShellCommand::Scan {
            table,
            limit,
            start_row,
            stop_row,
            columns,
        } => {
            assert_eq!(table, "t1");
            assert_eq!(limit, 20);
            assert_eq!(start_row.as_deref(), Some("r1"));
            assert_eq!(stop_row.as_deref(), Some("r9"));
            assert_eq!(columns, vec!["cf:q", "cf2"]);
        }
        other => panic!("unexpected command: {other:?}"),
    }
}

#[test]
fn parses_create_family_map() {
    let command = parse_shell_command("create 't1', {NAME=>'cf', VERSIONS=>3}").unwrap();
    match command {
        ShellCommand::Create { table, families } => {
            assert_eq!(table, "t1");
            assert_eq!(families[0].name, "cf");
            assert_eq!(
                families[0].attributes.get("VERSIONS").map(String::as_str),
                Some("3")
            );
        }
        other => panic!("unexpected command: {other:?}"),
    }
}

#[test]
fn parses_count_and_exists() {
    match parse_shell_command("count 't1'").unwrap() {
        ShellCommand::Count { table } => assert_eq!(table, "t1"),
        other => panic!("unexpected command: {other:?}"),
    }
    match parse_shell_command("exists 't1'").unwrap() {
        ShellCommand::Exists { table } => assert_eq!(table, "t1"),
        other => panic!("unexpected command: {other:?}"),
    }
}

#[test]
fn parses_enable_disable() {
    match parse_shell_command("enable 't1'").unwrap() {
        ShellCommand::Enable { table } => assert_eq!(table, "t1"),
        other => panic!("unexpected command: {other:?}"),
    }
    match parse_shell_command("disable 't1'").unwrap() {
        ShellCommand::Disable { table } => assert_eq!(table, "t1"),
        other => panic!("unexpected command: {other:?}"),
    }
}

#[test]
fn parses_alter_family_map() {
    match parse_shell_command("alter 't1', {NAME=>'cf', VERSIONS=>5}").unwrap() {
        ShellCommand::Alter { table, families } => {
            assert_eq!(table, "t1");
            assert_eq!(families[0].name, "cf");
            assert_eq!(
                families[0].attributes.get("VERSIONS").map(String::as_str),
                Some("5")
            );
        }
        other => panic!("unexpected command: {other:?}"),
    }
}

#[test]
fn alter_requires_family_spec() {
    assert!(parse_shell_command("alter 't1'").is_err());
}

#[test]
fn rejects_unknown_command() {
    assert!(parse_shell_command("whoami").is_err());
    assert!(parse_shell_command("show_filters").is_err());
}

#[test]
fn count_distinct_rows_counts_unique_keys() {
    let row = |k: &str| ResultRow {
        row: k.as_bytes().to_vec(),
        column: b"cf:q".to_vec(),
        timestamp: 0,
        value: b"v".to_vec(),
    };
    // Cells are row-ordered; two cells for r1 then one for r2 => 2 rows.
    let rows = vec![row("r1"), row("r1"), row("r2")];
    assert_eq!(count_distinct_rows(&rows), 2);
    assert_eq!(count_distinct_rows(&[]), 0);
}

#[test]
fn looks_like_missing_detects_not_found() {
    assert!(looks_like_missing("HBase REST error (404 Not Found): ..."));
    assert!(looks_like_missing("table not found: t1"));
    assert!(!looks_like_missing("connection refused"));
}

#[test]
fn cellset_rows_decode_base64_payload() {
    let value = json!({
        "Row": [{
            "key": b64("row1"),
            "Cell": [{
                "column": b64("cf:q"),
                "timestamp": 10,
                "$": b64("value")
            }]
        }]
    });
    assert_eq!(
        cellset_rows(&value),
        vec![vec![
            "row1".to_string(),
            "cf:q".to_string(),
            "10".to_string(),
            "value".to_string()
        ]]
    );
}

#[test]
fn scanner_location_uses_origin_for_root_relative_location() {
    let mut headers = HeaderMap::new();
    headers.insert(LOCATION, "/gateway/hbase/t/scanner/1".parse().unwrap());
    assert_eq!(
        scanner_location("http://hbase.example:8080/gateway/hbase", &headers).as_deref(),
        Some("http://hbase.example:8080/gateway/hbase/t/scanner/1")
    );
}

#[tokio::test]
async fn describe_request_error_surfaces_transport_cause() {
    // Port 1 on loopback has no listener, so the connect is refused
    // immediately and deterministically (no network access needed).
    let err = Client::new()
        .get("http://127.0.0.1:1/version/cluster")
        .send()
        .await
        .expect_err("connecting to a closed port must fail");
    let message = describe_request_error("HBase REST request failed", &err);
    assert!(
        message.starts_with("HBase REST request failed (connection failed):"),
        "unexpected message: {message}"
    );
    // The opaque top-level "error sending request" text must be replaced by
    // a concrete underlying cause from the source() chain.
    assert!(
        !message.contains("error sending request"),
        "diagnostic still hides the real cause: {message}"
    );
}
