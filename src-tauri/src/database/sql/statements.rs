
/// Heuristic: does the statement return rows? (SELECT/SHOW/DESCRIBE/WITH/...)
pub(super) fn sql_head_keyword(sql: &str) -> String {
    executable_sql_head(sql)
        .chars()
        .take_while(|c| c.is_alphabetic())
        .collect::<String>()
        .to_uppercase()
}

pub(super) fn is_query(sql: &str) -> bool {
    matches!(
        sql_head_keyword(sql).as_str(),
        "SELECT"
            | "SHOW"
            | "DESCRIBE"
            | "DESC"
            | "EXPLAIN"
            | "WITH"
            | "TABLE"
            | "VALUES"
            | "PRAGMA"
    )
}

/// MySQL (and StarRocks) reject some statements under the prepared-statement
/// protocol with error 1295. Run those via the text protocol (`raw_sql`).
pub(super) fn needs_mysql_text_protocol(sql: &str) -> bool {
    matches!(
        sql_head_keyword(sql).as_str(),
        "USE" | "PREPARE" | "EXECUTE" | "DEALLOCATE" | "HELP"
    )
}

/// Parse the target of session default-schema switch statements:
/// `USE db`, `SET search_path TO schema`, `ALTER SESSION SET CURRENT_SCHEMA = schema`.
pub fn parse_default_schema_switch(sql: &str) -> Option<String> {
    let head = executable_sql_head(sql);
    let keyword = sql_head_keyword(sql);
    match keyword.as_str() {
        "USE" => {
            let rest = head.get(keyword.len()..)?.trim();
            let first = rest.split_whitespace().next().unwrap_or(rest);
            // Presto: USE catalog.schema → keep the last component as schema.
            let target = first.rsplit('.').next().unwrap_or(first);
            unquote_sql_ident(target)
        }
        "SET" => {
            // SET search_path TO ident  |  SET search_path = ident
            let rest = head.get(keyword.len()..)?.trim();
            let upper = rest.to_ascii_uppercase();
            if !upper.starts_with("SEARCH_PATH") {
                return None;
            }
            let after = rest.get("search_path".len()..)?.trim_start();
            let after_upper = after.to_ascii_uppercase();
            let after = if after_upper.starts_with("TO") {
                after.get(2..).unwrap_or("").trim_start()
            } else if after.starts_with('=') {
                after.get(1..).unwrap_or("").trim_start()
            } else {
                after
            };
            // search_path can be a comma list; take the first entry.
            let first = after.split(',').next().unwrap_or(after).trim();
            unquote_sql_ident(first)
        }
        "ALTER" => {
            // ALTER SESSION SET CURRENT_SCHEMA = ident
            let upper = head.to_ascii_uppercase();
            let marker = "CURRENT_SCHEMA";
            let idx = upper.find(marker)?;
            let after = head.get(idx + marker.len()..)?.trim_start();
            let after = after.strip_prefix('=').map(str::trim).unwrap_or(after);
            let first = after.split_whitespace().next().unwrap_or(after);
            unquote_sql_ident(first)
        }
        _ => None,
    }
}

pub(super) fn unquote_sql_ident(raw: &str) -> Option<String> {
    let trimmed = raw.trim().trim_end_matches(';').trim();
    if trimmed.is_empty() {
        return None;
    }
    let unquoted = if (trimmed.starts_with('`') && trimmed.ends_with('`'))
        || (trimmed.starts_with('"') && trimmed.ends_with('"'))
        || (trimmed.starts_with('[') && trimmed.ends_with(']'))
        || (trimmed.starts_with('\'') && trimmed.ends_with('\''))
    {
        let inner = &trimmed[1..trimmed.len() - 1];
        inner
            .replace("``", "`")
            .replace("\"\"", "\"")
            .replace("]]", "]")
            .replace("''", "'")
    } else {
        trimmed.to_string()
    };
    let unquoted = unquoted.trim();
    if unquoted.is_empty() {
        None
    } else {
        Some(unquoted.to_string())
    }
}

pub(super) fn executable_sql_head(sql: &str) -> &str {
    let mut rest = sql.trim_start();
    loop {
        if let Some(after_comment) = rest.strip_prefix("--") {
            rest = match after_comment.find('\n') {
                Some(index) => &after_comment[index + 1..],
                None => "",
            }
            .trim_start();
            continue;
        }
        if let Some(after_comment) = rest.strip_prefix('#') {
            rest = match after_comment.find('\n') {
                Some(index) => &after_comment[index + 1..],
                None => "",
            }
            .trim_start();
            continue;
        }
        if let Some(after_comment) = rest.strip_prefix("/*") {
            rest = match after_comment.find("*/") {
                Some(index) => &after_comment[index + 2..],
                None => "",
            }
            .trim_start();
            continue;
        }
        return rest;
    }
}
