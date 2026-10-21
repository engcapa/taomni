use rusty_s3::actions::ListParts;
use serde::Deserialize;

pub(super) fn net_err(e: reqwest::Error) -> String {
    use std::error::Error;

    let category = if e.is_timeout() {
        "timeout"
    } else if e.is_connect() {
        "connection"
    } else if e.is_body() {
        "request body"
    } else {
        "network"
    };
    let mut causes = Vec::new();
    let mut source = e.source();
    while let Some(cause) = source {
        causes.push(cause.to_string());
        source = cause.source();
    }
    let safe = e.without_url();
    if causes.is_empty() {
        format!("request failed ({category}): {safe}")
    } else {
        format!("request failed ({category}): {safe}; {}", causes.join("; "))
    }
}

pub(super) fn confirmed_part_etag_from_xml(
    body: &str,
    part_number: u16,
    expected_size: u64,
) -> Option<String> {
    let response = ListParts::parse_response(body.as_bytes()).ok()?;
    response
        .parts
        .into_iter()
        .find(|part| part.number == part_number && part.size == expected_size)
        .map(|part| part.etag)
}

pub(super) fn parse_s3_error(body: &str) -> Option<String> {
    #[derive(Deserialize)]
    struct S3Error {
        #[serde(rename = "Code")]
        code: Option<String>,
        #[serde(rename = "Message")]
        message: Option<String>,
    }
    let e: S3Error = quick_xml::de::from_str(body).ok()?;
    match (e.code, e.message) {
        (Some(c), Some(m)) => Some(format!("{c}: {m}")),
        (Some(c), None) => Some(c),
        (None, Some(m)) => Some(m),
        _ => None,
    }
}
