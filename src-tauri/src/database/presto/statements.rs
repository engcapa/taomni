use super::model::PrestoClient;

pub(super) fn normalize_presto_statement(sql: &str) -> Result<String, String> {
    let mut statements = split_presto_statements(sql);
    match statements.len() {
        0 => Err("Presto SQL statement is empty".into()),
        1 => Ok(statements.remove(0)),
        _ => Err(
            "Presto accepts one SQL statement per HTTP request; split scripts before executing."
                .into(),
        ),
    }
}

pub(super) fn split_presto_statements(sql: &str) -> Vec<String> {
    let mut statements = Vec::new();
    let mut current = String::new();
    let mut chars = sql.chars().peekable();
    let mut single_quoted = false;
    let mut double_quoted = false;
    let mut line_comment = false;
    let mut block_comment = false;

    while let Some(ch) = chars.next() {
        if line_comment {
            current.push(ch);
            if ch == '\n' {
                line_comment = false;
            }
            continue;
        }

        if block_comment {
            current.push(ch);
            if ch == '*' && matches!(chars.peek(), Some('/')) {
                current.push('/');
                chars.next();
                block_comment = false;
            }
            continue;
        }

        if single_quoted {
            current.push(ch);
            if ch == '\'' {
                if matches!(chars.peek(), Some('\'')) {
                    current.push('\'');
                    chars.next();
                } else {
                    single_quoted = false;
                }
            }
            continue;
        }

        if double_quoted {
            current.push(ch);
            if ch == '"' {
                if matches!(chars.peek(), Some('"')) {
                    current.push('"');
                    chars.next();
                } else {
                    double_quoted = false;
                }
            }
            continue;
        }

        match ch {
            '-' if matches!(chars.peek(), Some('-')) => {
                current.push(ch);
                current.push('-');
                chars.next();
                line_comment = true;
            }
            '/' if matches!(chars.peek(), Some('*')) => {
                current.push(ch);
                current.push('*');
                chars.next();
                block_comment = true;
            }
            '\'' => {
                current.push(ch);
                single_quoted = true;
            }
            '"' => {
                current.push(ch);
                double_quoted = true;
            }
            ';' => push_presto_statement(&mut statements, &mut current),
            _ => current.push(ch),
        }
    }

    push_presto_statement(&mut statements, &mut current);
    statements
}

pub(super) fn push_presto_statement(statements: &mut Vec<String>, current: &mut String) {
    let statement = current.trim();
    if !statement.is_empty() && has_executable_presto_sql(statement) {
        statements.push(statement.to_string());
    }
    current.clear();
}

pub(super) fn has_executable_presto_sql(statement: &str) -> bool {
    let mut chars = statement.chars().peekable();
    let mut line_comment = false;
    let mut block_comment = false;

    while let Some(ch) = chars.next() {
        if line_comment {
            if ch == '\n' {
                line_comment = false;
            }
            continue;
        }
        if block_comment {
            if ch == '*' && matches!(chars.peek(), Some('/')) {
                chars.next();
                block_comment = false;
            }
            continue;
        }
        if ch.is_whitespace() {
            continue;
        }
        match ch {
            '-' if matches!(chars.peek(), Some('-')) => {
                chars.next();
                line_comment = true;
            }
            '/' if matches!(chars.peek(), Some('*')) => {
                chars.next();
                block_comment = true;
            }
            _ => return true,
        }
    }
    false
}

pub(super) fn quote_presto_ident(ident: &str) -> String {
    format!("\"{}\"", ident.replace('"', "\"\""))
}

#[cfg(test)]
pub(super) fn quote_presto_qualified(parts: &[&str]) -> String {
    parts
        .iter()
        .filter(|part| !part.is_empty())
        .map(|part| quote_presto_ident(part))
        .collect::<Vec<_>>()
        .join(".")
}

pub(super) fn sql_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

pub(super) async fn apply_use_statement_hint(client: &PrestoClient, sql: &str) {
    let Some(parts) = parse_use_parts(sql) else {
        return;
    };
    if let Some(schema) = parts.last().filter(|value| !value.is_empty()) {
        *client.schema.lock().await = Some(schema.clone());
    }
    if parts.len() >= 2 {
        if let Some(catalog) = parts.get(parts.len() - 2).filter(|value| !value.is_empty()) {
            *client.catalog.lock().await = Some(catalog.clone());
        }
    }
}

pub(super) fn parse_use_parts(sql: &str) -> Option<Vec<String>> {
    let trimmed = sql.trim().trim_end_matches(';').trim();
    let rest = trimmed
        .get(..3)
        .filter(|head| head.eq_ignore_ascii_case("USE"))
        .and_then(|_| trimmed.get(3..))?
        .trim();
    if rest.is_empty() {
        return None;
    }
    let parts = split_qualified_ident(rest);
    if parts.is_empty() { None } else { Some(parts) }
}

pub(super) fn split_qualified_ident(input: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut chars = input.chars().peekable();
    let mut quoted = false;

    while let Some(ch) = chars.next() {
        if quoted {
            if ch == '"' {
                if matches!(chars.peek(), Some('"')) {
                    current.push('"');
                    chars.next();
                } else {
                    quoted = false;
                }
            } else {
                current.push(ch);
            }
            continue;
        }
        match ch {
            '"' => quoted = true,
            '.' => {
                let part = current.trim().to_string();
                if !part.is_empty() {
                    parts.push(part);
                }
                current.clear();
            }
            c if c.is_whitespace() => {
                if !current.trim().is_empty() {
                    current.push(c);
                }
            }
            _ => current.push(ch),
        }
    }

    let part = current.trim().to_string();
    if !part.is_empty() {
        parts.push(part);
    }
    parts
}
