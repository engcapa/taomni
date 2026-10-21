pub(super) const DEFAULT_TIMEOUT_SECS: u64 = 15;
pub(super) const STREAM_BATCH_ROWS: usize = 100;
pub(super) const DEFAULT_PRESTO_USER: &str = "taomni";
pub(super) const HEADER_PREFIX_PRESTO: &str = "X-Presto";
pub(super) const HEADER_PREFIX_TRINO: &str = "X-Trino";

/// Precomputed protocol header names for either the Presto or Trino dialect.
#[derive(Clone, Copy)]
pub(super) struct ProtocolHeaders {
    /// Display / User-Agent label: "Presto" or "Trino".
    pub(super) engine_label: &'static str,
    pub(super) user: &'static str,
    pub(super) source: &'static str,
    pub(super) catalog: &'static str,
    pub(super) schema: &'static str,
    pub(super) set_catalog: &'static str,
    pub(super) set_schema: &'static str,
}

pub(super) const PRESTO_HEADERS: ProtocolHeaders = ProtocolHeaders {
    engine_label: "Presto",
    user: "X-Presto-User",
    source: "X-Presto-Source",
    catalog: "X-Presto-Catalog",
    schema: "X-Presto-Schema",
    set_catalog: "X-Presto-Set-Catalog",
    set_schema: "X-Presto-Set-Schema",
};

pub(super) const TRINO_HEADERS: ProtocolHeaders = ProtocolHeaders {
    engine_label: "Trino",
    user: "X-Trino-User",
    source: "X-Trino-Source",
    catalog: "X-Trino-Catalog",
    schema: "X-Trino-Schema",
    set_catalog: "X-Trino-Set-Catalog",
    set_schema: "X-Trino-Set-Schema",
};

/// Resolve protocol headers from connect config.
/// Missing / unknown values default to Presto for backward compatibility.
pub(super) fn protocol_headers_from_dialect(dialect: Option<&str>) -> ProtocolHeaders {
    match dialect.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) if value.eq_ignore_ascii_case("trino") => TRINO_HEADERS,
        _ => PRESTO_HEADERS,
    }
}

/// Resolve the HTTP header prefix from connect config (test/helpers).
pub(super) fn header_prefix_from_dialect(dialect: Option<&str>) -> &'static str {
    if protocol_headers_from_dialect(dialect).engine_label == "Trino" {
        HEADER_PREFIX_TRINO
    } else {
        HEADER_PREFIX_PRESTO
    }
}
