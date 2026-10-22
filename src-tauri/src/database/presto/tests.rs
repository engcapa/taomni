use super::catalog::describe_table;
use super::catalog::list_catalogs;
use super::catalog::list_schemas;
use super::catalog::list_tables;
use super::model::PrestoClient;
use super::model::PrestoError;
use super::model::PrestoErrorLocation;
use super::protocol::HEADER_PREFIX_PRESTO;
use super::protocol::HEADER_PREFIX_TRINO;
use super::protocol::PRESTO_HEADERS;
use super::protocol::ProtocolHeaders;
use super::protocol::TRINO_HEADERS;
use super::protocol::header_prefix_from_dialect;
use super::query::execute;
use super::statements::normalize_presto_statement;
use super::statements::parse_use_parts;
use super::statements::quote_presto_ident;
use super::statements::quote_presto_qualified;
use super::statements::split_presto_statements;
use super::transport::connect;
use super::values::format_presto_error;
use super::values::json_cell_to_string;
use crate::database::DbConfig;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex as AsyncMutex;
use tokio_util::sync::CancellationToken;

use std::collections::VecDeque;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

struct ExpectedRequest {
    method: &'static str,
    path: String,
    body_contains: Option<&'static str>,
    body_equals: Option<&'static str>,
    headers: Vec<(&'static str, &'static str)>,
    /// Optional response headers (e.g. X-Trino-Set-Catalog) returned before the body.
    response_headers: Vec<(&'static str, &'static str)>,
    response_body: String,
}

async fn read_request(stream: &mut TcpStream) -> String {
    let mut buf = Vec::new();
    let mut tmp = [0_u8; 1024];
    let header_end;
    loop {
        let n = stream.read(&mut tmp).await.unwrap();
        assert!(n > 0, "connection closed before request headers");
        buf.extend_from_slice(&tmp[..n]);
        if let Some(pos) = find_bytes(&buf, b"\r\n\r\n") {
            header_end = pos + 4;
            break;
        }
    }
    let request_head = String::from_utf8_lossy(&buf[..header_end]).to_string();
    let content_length = request_head
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse::<usize>().ok())
                .flatten()
        })
        .unwrap_or(0);
    while buf.len() < header_end + content_length {
        let n = stream.read(&mut tmp).await.unwrap();
        assert!(n > 0, "connection closed before request body");
        buf.extend_from_slice(&tmp[..n]);
    }
    String::from_utf8(buf).unwrap()
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|value| value == needle)
}

fn request_body(request: &str) -> &str {
    request
        .split_once("\r\n\r\n")
        .map(|(_, body)| body)
        .unwrap_or("")
}

fn header_value<'a>(request: &'a str, key: &str) -> Option<&'a str> {
    request.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.eq_ignore_ascii_case(key).then(|| value.trim())
    })
}

async fn serve_expected_requests(listener: TcpListener, expected: Vec<ExpectedRequest>) {
    let mut expected = VecDeque::from(expected);
    while let Some(expected) = expected.pop_front() {
        let (mut stream, _) = listener.accept().await.unwrap();
        let request = read_request(&mut stream).await;
        let request_line = request.lines().next().unwrap_or_default();
        assert!(
            request_line.starts_with(&format!("{} {} ", expected.method, expected.path)),
            "unexpected request line: {request_line}"
        );
        for (key, value) in expected.headers {
            assert_eq!(header_value(&request, key), Some(value), "header {key}");
        }
        if let Some(body_part) = expected.body_contains {
            assert!(
                request_body(&request).contains(body_part),
                "request body did not contain {body_part:?}: {}",
                request_body(&request)
            );
        }
        if let Some(body) = expected.body_equals {
            assert_eq!(request_body(&request), body);
        }
        let mut response = String::from("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n");
        for (key, value) in &expected.response_headers {
            response.push_str(&format!("{key}: {value}\r\n"));
        }
        response.push_str(&format!(
            "Content-Length: {}\r\nConnection: close\r\n\r\n{}",
            expected.response_body.len(),
            expected.response_body
        ));
        stream.write_all(response.as_bytes()).await.unwrap();
    }
}

fn test_client(base_url: String) -> PrestoClient {
    test_client_with_headers(base_url, PRESTO_HEADERS)
}

fn test_client_with_headers(base_url: String, headers: ProtocolHeaders) -> PrestoClient {
    PrestoClient {
        client: reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .no_proxy()
            .build()
            .unwrap(),
        base_url,
        user: "analyst".to_string(),
        password: None,
        headers,
        catalog: Arc::new(AsyncMutex::new(Some("hive".to_string()))),
        schema: Arc::new(AsyncMutex::new(Some("sales".to_string()))),
        current_next_uri: Arc::new(AsyncMutex::new(None)),
    }
}

#[test]
fn presto_identifier_quoting_escapes_double_quotes() {
    assert_eq!(quote_presto_ident("te\"st"), "\"te\"\"st\"");
    assert_eq!(
        quote_presto_qualified(&["hive", "sales", "or\"ders"]),
        "\"hive\".\"sales\".\"or\"\"ders\""
    );
}

#[test]
fn json_cells_render_as_nullable_strings() {
    assert_eq!(json_cell_to_string(&serde_json::Value::Null), None);
    assert_eq!(
        json_cell_to_string(&serde_json::json!({"a": 1})),
        Some("{\"a\":1}".to_string())
    );
    assert_eq!(
        json_cell_to_string(&serde_json::json!(["x", 2])),
        Some("[\"x\",2]".to_string())
    );
}

#[test]
fn presto_error_includes_name_and_location() {
    let error = PrestoError {
        message: "bad query".to_string(),
        error_name: Some("SYNTAX_ERROR".to_string()),
        error_location: Some(PrestoErrorLocation {
            line_number: 3,
            column_number: 7,
        }),
    };
    assert_eq!(
        format_presto_error(error),
        "SYNTAX_ERROR: bad query at line 3, column 7"
    );
}

#[test]
fn use_statement_parser_handles_quoted_catalog_schema() {
    assert_eq!(
        parse_use_parts("USE \"hive\".\"sales\";"),
        Some(vec!["hive".to_string(), "sales".to_string()])
    );
    assert_eq!(
        parse_use_parts("use tpch.tiny"),
        Some(vec!["tpch".to_string(), "tiny".to_string()])
    );
    assert_eq!(parse_use_parts("SELECT 1"), None);
}

#[test]
fn presto_statement_splitter_ignores_semicolons_inside_strings_and_comments() {
    assert_eq!(
        split_presto_statements(
            "SELECT ';' AS literal -- comment ; ignored\nFROM t;\n\
                 /* comment ; ignored */ SELECT 'it''s; ok';"
        ),
        vec![
            "SELECT ';' AS literal -- comment ; ignored\nFROM t".to_string(),
            "/* comment ; ignored */ SELECT 'it''s; ok'".to_string(),
        ]
    );
    assert_eq!(
        split_presto_statements("; /* comment only */ ; -- trailing"),
        Vec::<String>::new()
    );
}

#[test]
fn presto_statement_normalization_requires_one_statement() {
    assert_eq!(
        normalize_presto_statement("SELECT 1; -- trailing comment").unwrap(),
        "SELECT 1"
    );
    assert!(normalize_presto_statement("SELECT 1; SELECT 2").is_err());
}

#[tokio::test]
async fn execute_posts_statement_and_polls_next_uri() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base_url = format!("http://{}", listener.local_addr().unwrap());
    let next_path = "/v1/statement/query-1/1";
    let next_uri = format!("{base_url}{next_path}");
    let server = tokio::spawn(serve_expected_requests(
        listener,
        vec![
            ExpectedRequest {
                method: "POST",
                path: "/v1/statement".to_string(),
                body_contains: Some("SELECT * FROM orders"),
                body_equals: None,
                headers: vec![
                    ("X-Presto-User", "analyst"),
                    ("X-Presto-Catalog", "hive"),
                    ("X-Presto-Schema", "sales"),
                ],
                response_headers: Vec::new(),
                response_body: format!(
                    r#"{{"id":"query-1","columns":[{{"name":"id","type":"bigint"}}],"data":[[1]],"nextUri":"{next_uri}"}}"#
                ),
            },
            ExpectedRequest {
                method: "GET",
                path: next_path.to_string(),
                body_contains: None,
                body_equals: None,
                headers: vec![
                    ("X-Presto-User", "analyst"),
                    ("X-Presto-Catalog", "hive"),
                    ("X-Presto-Schema", "sales"),
                ],
                response_headers: Vec::new(),
                response_body: r#"{"id":"query-1","data":[[2]]}"#.to_string(),
            },
        ],
    ));
    let token = CancellationToken::new();

    let result = execute(&test_client(base_url), "SELECT * FROM orders", &token)
        .await
        .unwrap();
    server.await.unwrap();

    assert_eq!(result.columns.len(), 1);
    assert_eq!(result.columns[0].name, "id");
    assert_eq!(
        result.rows,
        vec![vec![Some("1".to_string())], vec![Some("2".to_string())]]
    );
    assert_eq!(result.rows_affected, 0);
}

#[tokio::test]
async fn execute_posts_single_statement_without_outer_semicolon() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base_url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(serve_expected_requests(
        listener,
        vec![ExpectedRequest {
            method: "POST",
            path: "/v1/statement".to_string(),
            body_contains: None,
            body_equals: Some("SELECT 1"),
            headers: vec![
                ("X-Presto-User", "analyst"),
                ("X-Presto-Catalog", "hive"),
                ("X-Presto-Schema", "sales"),
            ],
            response_headers: Vec::new(),
            response_body:
                r#"{"id":"query-1","columns":[{"name":"_col0","type":"integer"}],"data":[[1]]}"#
                    .to_string(),
        }],
    ));
    let token = CancellationToken::new();

    let result = execute(
        &test_client(base_url),
        "SELECT 1; -- trailing comment",
        &token,
    )
    .await
    .unwrap();
    server.await.unwrap();

    assert_eq!(result.rows, vec![vec![Some("1".to_string())]]);
}

#[tokio::test]
async fn metadata_calls_use_catalog_context() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base_url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(serve_expected_requests(
            listener,
            vec![
                ExpectedRequest {
                    method: "POST",
                    path: "/v1/statement".to_string(),
                    body_contains: None,
                    body_equals: Some("SHOW CATALOGS"),
                    headers: vec![
                        ("X-Presto-User", "analyst"),
                        ("X-Presto-Catalog", "hive"),
                        ("X-Presto-Schema", "sales"),
                    ],
                    response_headers: Vec::new(),
                    response_body: r#"{"id":"catalogs","data":[["hive"],["iceberg"]]}"#
                        .to_string(),
                },
                ExpectedRequest {
                    method: "POST",
                    path: "/v1/statement".to_string(),
                    body_contains: Some("information_schema.schemata"),
                    body_equals: None,
                    headers: vec![
                        ("X-Presto-User", "analyst"),
                        ("X-Presto-Catalog", "hive"),
                        ("X-Presto-Schema", "sales"),
                    ],
                    response_headers: Vec::new(),
                    response_body: r#"{"id":"schemas","data":[["marketing"],["sales"]]}"#
                        .to_string(),
                },
                ExpectedRequest {
                    method: "POST",
                    path: "/v1/statement".to_string(),
                    body_contains: Some("table_schema = 'sales'"),
                    body_equals: None,
                    headers: vec![
                        ("X-Presto-User", "analyst"),
                        ("X-Presto-Catalog", "hive"),
                        ("X-Presto-Schema", "sales"),
                    ],
                    response_headers: Vec::new(),
                    response_body: r#"{"id":"tables","data":[["orders","BASE TABLE"],["orders_v","VIEW"]]}"#
                        .to_string(),
                },
                ExpectedRequest {
                    method: "POST",
                    path: "/v1/statement".to_string(),
                    body_contains: Some("table_name = 'orders'"),
                    body_equals: None,
                    headers: vec![
                        ("X-Presto-User", "analyst"),
                        ("X-Presto-Catalog", "hive"),
                        ("X-Presto-Schema", "sales"),
                    ],
                    response_headers: Vec::new(),
                    response_body: r#"{"id":"columns","data":[["id","bigint","NO",null],["note","varchar","YES","'new'"]]}"#
                        .to_string(),
                },
                ExpectedRequest {
                    method: "POST",
                    path: "/v1/statement".to_string(),
                    body_contains: Some("information_schema.schemata"),
                    body_equals: None,
                    headers: vec![
                        ("X-Presto-User", "analyst"),
                        ("X-Presto-Catalog", "iceberg"),
                        ("X-Presto-Schema", "sales"),
                    ],
                    response_headers: Vec::new(),
                    response_body: r#"{"id":"iceberg-schemas","data":[["lake"]]}"#
                        .to_string(),
                },
            ],
        ));
    let client = test_client(base_url);

    let catalogs = list_catalogs(&client).await.unwrap();
    let schemas = list_schemas(&client, None).await.unwrap();
    let tables = list_tables(&client, None, Some("sales")).await.unwrap();
    let columns = describe_table(&client, None, Some("sales"), "orders")
        .await
        .unwrap();
    let iceberg_schemas = list_schemas(&client, Some("iceberg")).await.unwrap();
    server.await.unwrap();

    assert_eq!(
        catalogs
            .into_iter()
            .map(|catalog| catalog.name)
            .collect::<Vec<_>>(),
        vec!["hive", "iceberg"]
    );
    assert_eq!(
        schemas
            .into_iter()
            .map(|schema| schema.name)
            .collect::<Vec<_>>(),
        vec!["marketing", "sales"]
    );
    assert_eq!(tables.len(), 2);
    assert_eq!(tables[0].name, "orders");
    assert_eq!(tables[0].kind, "table");
    assert_eq!(tables[1].name, "orders_v");
    assert_eq!(tables[1].kind, "view");
    assert_eq!(columns.len(), 2);
    assert_eq!(columns[0].name, "id");
    assert_eq!(columns[0].type_name, "bigint");
    assert!(!columns[0].nullable);
    assert_eq!(columns[1].name, "note");
    assert!(columns[1].nullable);
    assert_eq!(columns[1].default.as_deref(), Some("'new'"));
    assert_eq!(iceberg_schemas[0].name, "lake");
}

#[test]
fn header_prefix_from_dialect_defaults_to_presto() {
    assert_eq!(header_prefix_from_dialect(None), HEADER_PREFIX_PRESTO);
    assert_eq!(header_prefix_from_dialect(Some("")), HEADER_PREFIX_PRESTO);
    assert_eq!(
        header_prefix_from_dialect(Some("presto")),
        HEADER_PREFIX_PRESTO
    );
    assert_eq!(
        header_prefix_from_dialect(Some("Presto")),
        HEADER_PREFIX_PRESTO
    );
    assert_eq!(
        header_prefix_from_dialect(Some("unknown")),
        HEADER_PREFIX_PRESTO
    );
    assert_eq!(
        header_prefix_from_dialect(Some("trino")),
        HEADER_PREFIX_TRINO
    );
    assert_eq!(
        header_prefix_from_dialect(Some("TRINO")),
        HEADER_PREFIX_TRINO
    );
    assert_eq!(
        header_prefix_from_dialect(Some("  trino  ")),
        HEADER_PREFIX_TRINO
    );
}

#[tokio::test]
async fn trino_dialect_sends_x_trino_headers_on_post_and_poll() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base_url = format!("http://{}", listener.local_addr().unwrap());
    let next_path = "/v1/statement/query-trino/1";
    let next_uri = format!("{base_url}{next_path}");
    let server = tokio::spawn(serve_expected_requests(
        listener,
        vec![
            ExpectedRequest {
                method: "POST",
                path: "/v1/statement".to_string(),
                body_contains: Some("SELECT * FROM orders"),
                body_equals: None,
                headers: vec![
                    ("X-Trino-User", "analyst"),
                    ("X-Trino-Catalog", "hive"),
                    ("X-Trino-Schema", "sales"),
                    ("X-Trino-Source", "taomni"),
                ],
                response_headers: Vec::new(),
                response_body: format!(
                    r#"{{"id":"query-trino","columns":[{{"name":"id","type":"bigint"}}],"data":[[10]],"nextUri":"{next_uri}"}}"#
                ),
            },
            ExpectedRequest {
                method: "GET",
                path: next_path.to_string(),
                body_contains: None,
                body_equals: None,
                headers: vec![
                    ("X-Trino-User", "analyst"),
                    ("X-Trino-Catalog", "hive"),
                    ("X-Trino-Schema", "sales"),
                ],
                response_headers: Vec::new(),
                response_body: r#"{"id":"query-trino","data":[[11]]}"#.to_string(),
            },
        ],
    ));
    let token = CancellationToken::new();
    let client = test_client_with_headers(base_url, TRINO_HEADERS);

    let result = execute(&client, "SELECT * FROM orders", &token)
        .await
        .unwrap();
    server.await.unwrap();

    assert_eq!(
        result.rows,
        vec![vec![Some("10".to_string())], vec![Some("11".to_string())]]
    );
    assert_eq!(client.headers.engine_label, "Trino");
    assert_eq!(client.headers.user, "X-Trino-User");
}

#[tokio::test]
async fn trino_set_catalog_and_schema_response_headers_update_client() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base_url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(serve_expected_requests(
        listener,
        vec![
            ExpectedRequest {
                method: "POST",
                path: "/v1/statement".to_string(),
                body_contains: None,
                body_equals: Some("SELECT 1"),
                headers: vec![
                    ("X-Trino-User", "analyst"),
                    ("X-Trino-Catalog", "hive"),
                    ("X-Trino-Schema", "sales"),
                ],
                response_headers: vec![
                    ("X-Trino-Set-Catalog", "iceberg"),
                    ("X-Trino-Set-Schema", "analytics"),
                ],
                response_body:
                    r#"{"id":"q1","columns":[{"name":"_col0","type":"integer"}],"data":[[1]]}"#
                        .to_string(),
            },
            ExpectedRequest {
                method: "POST",
                path: "/v1/statement".to_string(),
                body_contains: None,
                body_equals: Some("SELECT 2"),
                headers: vec![
                    ("X-Trino-User", "analyst"),
                    ("X-Trino-Catalog", "iceberg"),
                    ("X-Trino-Schema", "analytics"),
                ],
                response_headers: Vec::new(),
                response_body:
                    r#"{"id":"q2","columns":[{"name":"_col0","type":"integer"}],"data":[[2]]}"#
                        .to_string(),
            },
        ],
    ));
    let token = CancellationToken::new();
    let client = test_client_with_headers(base_url, TRINO_HEADERS);

    execute(&client, "SELECT 1", &token).await.unwrap();
    assert_eq!(client.catalog.lock().await.as_deref(), Some("iceberg"));
    assert_eq!(client.schema.lock().await.as_deref(), Some("analytics"));

    let result = execute(&client, "SELECT 2", &token).await.unwrap();
    server.await.unwrap();
    assert_eq!(result.rows, vec![vec![Some("2".to_string())]]);
}

#[tokio::test]
async fn presto_set_catalog_and_schema_response_headers_still_apply() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base_url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(serve_expected_requests(
        listener,
        vec![
            ExpectedRequest {
                method: "POST",
                path: "/v1/statement".to_string(),
                body_contains: None,
                body_equals: Some("SELECT 1"),
                headers: vec![
                    ("X-Presto-User", "analyst"),
                    ("X-Presto-Catalog", "hive"),
                    ("X-Presto-Schema", "sales"),
                ],
                response_headers: vec![
                    ("X-Presto-Set-Catalog", "memory"),
                    ("X-Presto-Set-Schema", "default"),
                ],
                response_body:
                    r#"{"id":"q1","columns":[{"name":"_col0","type":"integer"}],"data":[[1]]}"#
                        .to_string(),
            },
            ExpectedRequest {
                method: "POST",
                path: "/v1/statement".to_string(),
                body_contains: None,
                body_equals: Some("SELECT 2"),
                headers: vec![
                    ("X-Presto-User", "analyst"),
                    ("X-Presto-Catalog", "memory"),
                    ("X-Presto-Schema", "default"),
                ],
                response_headers: Vec::new(),
                response_body:
                    r#"{"id":"q2","columns":[{"name":"_col0","type":"integer"}],"data":[[2]]}"#
                        .to_string(),
            },
        ],
    ));
    let token = CancellationToken::new();
    let client = test_client(base_url);

    execute(&client, "SELECT 1", &token).await.unwrap();
    assert_eq!(client.catalog.lock().await.as_deref(), Some("memory"));
    assert_eq!(client.schema.lock().await.as_deref(), Some("default"));

    let result = execute(&client, "SELECT 2", &token).await.unwrap();
    server.await.unwrap();
    assert_eq!(result.rows, vec![vec![Some("2".to_string())]]);
}

/// Serializes tests that mutate the process-global proxy environment so a
/// concurrent client build in the same test binary can't observe a
/// half-set state. reqwest snapshots the env at `Client::build()`, so each
/// test only needs to hold this across `connect()`.
static PROXY_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

struct ProxyEnvGuard {
    saved: Vec<(&'static str, Option<String>)>,
    _lock: std::sync::MutexGuard<'static, ()>,
}

impl ProxyEnvGuard {
    /// Point every proxy env var reqwest honors at `dead_proxy` and clear
    /// NO_PROXY (so loopback isn't implicitly excluded). Restores the prior
    /// values on drop.
    fn install(dead_proxy: &str) -> Self {
        let lock = PROXY_ENV_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let keys = [
            "HTTP_PROXY",
            "http_proxy",
            "HTTPS_PROXY",
            "https_proxy",
            "ALL_PROXY",
            "all_proxy",
            "NO_PROXY",
            "no_proxy",
        ];
        let saved = keys
            .iter()
            .map(|&k| (k, std::env::var(k).ok()))
            .collect::<Vec<_>>();
        // SAFETY: env mutation is process-global; PROXY_ENV_LOCK serializes
        // these tests and no other unit test makes real non-proxied
        // localhost reqwest calls (verified in the crate).
        unsafe {
            for k in [
                "HTTP_PROXY",
                "http_proxy",
                "HTTPS_PROXY",
                "https_proxy",
                "ALL_PROXY",
                "all_proxy",
            ] {
                std::env::set_var(k, dead_proxy);
            }
            std::env::remove_var("NO_PROXY");
            std::env::remove_var("no_proxy");
        }
        Self { saved, _lock: lock }
    }
}

impl Drop for ProxyEnvGuard {
    fn drop(&mut self) {
        // SAFETY: still holding PROXY_ENV_LOCK; restore the exact prior env.
        unsafe {
            for (k, v) in &self.saved {
                match v {
                    Some(val) => std::env::set_var(k, val),
                    None => std::env::remove_var(k),
                }
            }
        }
    }
}

/// Regression for the VPN/proxy 502: an ambient system/env proxy must not
/// hijack a Presto connection. `connect()` builds its client with
/// `.no_proxy()`, so even with HTTP(S)_PROXY/ALL_PROXY pointed at a dead
/// address it dials the target directly. Without `.no_proxy()` reqwest would
/// route `/v1/statement` through the dead proxy and `connect()` would error.
#[tokio::test]
async fn connect_ignores_ambient_env_proxy() {
    // A proxy that accepts then instantly drops every connection — any
    // request routed here fails fast (no hanging on a real timeout).
    let dead = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let dead_addr = dead.local_addr().unwrap();
    tokio::spawn(async move {
        while let Ok((stream, _)) = dead.accept().await {
            drop(stream);
        }
    });

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let target_addr = listener.local_addr().unwrap();
    let server = tokio::spawn(serve_expected_requests(
        listener,
        vec![ExpectedRequest {
            method: "POST",
            path: "/v1/statement".to_string(),
            body_contains: None,
            body_equals: Some("SELECT 1"),
            headers: vec![("X-Presto-User", "taomni")],
            response_headers: Vec::new(),
            response_body:
                r#"{"id":"q1","columns":[{"name":"_col0","type":"integer"}],"data":[[1]]}"#
                    .to_string(),
        }],
    ));

    let config = DbConfig {
        engine: "Presto".to_string(),
        host: target_addr.ip().to_string(),
        port: target_addr.port(),
        username: None,
        password: None,
        database: None,
        catalog: None,
        ssl: false,
        timeout_secs: Some(5),
        http_port: None,
        protocol: None,
        presto_dialect: None,
        db_index: None,
        network_settings: None,
    };

    let result = {
        let _guard = ProxyEnvGuard::install(&format!("http://{dead_addr}"));
        // reqwest reads the env at build time (inside connect), so the guard
        // only needs to span the connect() call.
        connect(&config, None).await
    };

    result.expect("connect must bypass the ambient env proxy and dial the target directly");
    server.await.unwrap();
}
