use super::limits::RUN_SQL_ROW_CAP;
use crate::database::ColumnDescription;
use crate::database::DbObject;
use crate::database::IndexInfo;
use crate::database::QueryResult;
use crate::database::SchemaInfo;
use crate::database::TableInfo;
use rmcp::ErrorData;
use rmcp::model::CallToolResult;
use rmcp::model::Content;
use serde::Serialize;

pub(super) fn text(s: impl Into<String>) -> CallToolResult {
    CallToolResult::success(vec![Content::text(s.into())])
}

pub(super) fn json_text<T: Serialize>(value: &T) -> Result<CallToolResult, ErrorData> {
    serde_json::to_string_pretty(value)
        .map(text)
        .map_err(|e| ErrorData::internal_error(e.to_string(), None))
}

pub(super) fn err(e: impl Into<String>) -> ErrorData {
    ErrorData::internal_error(e.into(), None)
}

// --- result formatters (compact text for CC) -------------------------------

pub(super) fn fmt_schemas(rows: &[SchemaInfo]) -> String {
    if rows.is_empty() {
        return "(no schemas)".into();
    }
    rows.iter()
        .map(|s| s.name.clone())
        .collect::<Vec<_>>()
        .join("\n")
}

pub(super) fn fmt_tables(rows: &[TableInfo]) -> String {
    if rows.is_empty() {
        return "(no tables)".into();
    }
    rows.iter()
        .map(|t| match t.row_count {
            Some(n) => format!("{} [{}] ~{} rows", t.name, t.kind, n),
            None => format!("{} [{}]", t.name, t.kind),
        })
        .collect::<Vec<_>>()
        .join("\n")
}

pub(super) fn fmt_columns(rows: &[ColumnDescription]) -> String {
    if rows.is_empty() {
        return "(no columns)".into();
    }
    rows.iter()
        .map(|c| {
            let mut line = format!("{} {}", c.name, c.type_name);
            if c.primary_key {
                line.push_str(" PK");
            }
            line.push_str(if c.nullable { " NULL" } else { " NOT NULL" });
            if let Some(d) = &c.default {
                line.push_str(&format!(" default={d}"));
            }
            line
        })
        .collect::<Vec<_>>()
        .join("\n")
}

pub(super) fn fmt_indexes(rows: &[IndexInfo]) -> String {
    if rows.is_empty() {
        return "(no indexes)".into();
    }
    rows.iter()
        .map(|i| {
            format!(
                "{}{} ({})",
                i.name,
                if i.unique { " UNIQUE" } else { "" },
                i.columns.join(", ")
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

pub(super) fn fmt_objects(rows: &[DbObject]) -> String {
    if rows.is_empty() {
        return "(none)".into();
    }
    rows.iter()
        .map(|o| match &o.owner {
            Some(owner) => format!("{} [{}] on {}", o.name, o.kind, owner),
            None => format!("{} [{}]", o.name, o.kind),
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Render a `QueryResult` as a compact tab-separated table, clipped to
/// `RUN_SQL_ROW_CAP` rows with a trailing summary line.
pub(super) fn fmt_query_result(r: &QueryResult) -> String {
    let mut out = String::new();
    if !r.columns.is_empty() {
        let header: Vec<&str> = r.columns.iter().map(|c| c.name.as_str()).collect();
        out.push_str(&header.join("\t"));
        out.push('\n');
    }
    let shown = r.rows.len().min(RUN_SQL_ROW_CAP);
    for row in r.rows.iter().take(shown) {
        let cells: Vec<String> = row
            .iter()
            .map(|c| c.clone().unwrap_or_else(|| "NULL".into()))
            .collect();
        out.push_str(&cells.join("\t"));
        out.push('\n');
    }
    out.push_str(&format!(
        "--- {} row(s){}, {} affected, {} ms ---",
        r.rows.len(),
        if r.rows.len() > shown {
            format!(" (showing first {shown}; use run_sql_captured for the full set)")
        } else {
            String::new()
        },
        r.rows_affected,
        r.duration_ms,
    ));
    if !r.warnings.is_empty() {
        out.push_str(&format!("\nwarnings: {}", r.warnings.join("; ")));
    }
    out
}

/// RFC4180-ish CSV field escaping: quote when the value contains a comma,
/// quote, CR or LF, doubling embedded quotes.
pub(super) fn csv_field(v: &str) -> String {
    if v.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", v.replace('"', "\"\""))
    } else {
        v.to_string()
    }
}

/// Serialize a `QueryResult` to CSV text (header row + one row per record;
/// NULL → empty field).
pub(super) fn query_result_to_csv(r: &QueryResult) -> String {
    let mut out = String::new();
    let header: Vec<String> = r.columns.iter().map(|c| csv_field(&c.name)).collect();
    out.push_str(&header.join(","));
    out.push('\n');
    for row in &r.rows {
        let cells: Vec<String> = row
            .iter()
            .map(|c| csv_field(c.as_deref().unwrap_or("")))
            .collect();
        out.push_str(&cells.join(","));
        out.push('\n');
    }
    out
}
