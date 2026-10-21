use crate::database::IndexInfo;

pub(super) fn quote_pg_ident(ident: &str) -> String {
    format!("\"{}\"", ident.replace('"', "\"\""))
}

// ---------------------------------------------------------------------------
// Schema introspection — MySQL
// ---------------------------------------------------------------------------

pub(super) fn quote_mysql_ident(ident: &str) -> String {
    format!("`{}`", ident.replace('`', "``"))
}

pub(super) fn quote_mysql_table(schema: Option<&str>, table: &str) -> String {
    match schema {
        Some(schema) => format!("{}.{}", quote_mysql_ident(schema), quote_mysql_ident(table)),
        None => quote_mysql_ident(table),
    }
}

// ---------------------------------------------------------------------------
// Schema introspection — SQL Server
// ---------------------------------------------------------------------------

pub(super) fn quote_sqlserver_ident(ident: &str) -> String {
    format!("[{}]", ident.replace(']', "]]"))
}

pub(super) fn sqlserver_qualified(schema: Option<&str>, name: &str) -> String {
    match schema {
        Some(s) if !s.is_empty() => {
            format!(
                "{}.{}",
                quote_sqlserver_ident(s),
                quote_sqlserver_ident(name)
            )
        }
        _ => quote_sqlserver_ident(name),
    }
}

pub(super) fn sqlserver_default_schema(schema: Option<&str>) -> String {
    schema
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("dbo")
        .to_string()
}

/// Collapse an ordered (index_name, column, unique) stream into one
/// `IndexInfo` per index, preserving column order.
pub(super) fn group_indexes(rows: impl Iterator<Item = (String, String, bool)>) -> Vec<IndexInfo> {
    let mut out: Vec<IndexInfo> = Vec::new();
    for (name, col, unique) in rows {
        if let Some(last) = out.last_mut().filter(|x| x.name == name) {
            last.columns.push(col);
        } else {
            out.push(IndexInfo {
                name,
                columns: vec![col],
                unique,
            });
        }
    }
    out
}

/// Backtick-quote and qualify a MySQL identifier.
pub(super) fn mysql_qualified(schema: Option<&str>, name: &str) -> String {
    let esc = |s: &str| s.replace('`', "``");
    match schema {
        Some(s) if !s.is_empty() => format!("`{}`.`{}`", esc(s), esc(name)),
        _ => format!("`{}`", esc(name)),
    }
}
