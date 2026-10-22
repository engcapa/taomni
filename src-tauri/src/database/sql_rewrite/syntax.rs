use sqlparser::ast::Statement;
use sqlparser::dialect::ClickHouseDialect;
use sqlparser::dialect::Dialect;
use sqlparser::dialect::GenericDialect;
use sqlparser::dialect::MsSqlDialect;
use sqlparser::dialect::MySqlDialect;
use sqlparser::dialect::OracleDialect;
use sqlparser::dialect::PostgreSqlDialect;
use sqlparser::parser::Parser;
use std::collections::HashMap;

pub(super) fn contains_sql_comment(sql: &str) -> bool {
    let bytes = sql.as_bytes();
    let mut i = 0;
    let mut single_quoted = false;
    let mut double_quoted = false;
    let mut backtick_quoted = false;
    let mut bracket_quoted = false;

    while i < bytes.len() {
        let byte = bytes[i];
        let next = bytes.get(i + 1).copied();

        if single_quoted {
            if byte == b'\'' && next == Some(b'\'') {
                i += 2;
                continue;
            }
            if byte == b'\'' {
                single_quoted = false;
            }
            i += 1;
            continue;
        }
        if double_quoted {
            if byte == b'"' && next == Some(b'"') {
                i += 2;
                continue;
            }
            if byte == b'"' {
                double_quoted = false;
            }
            i += 1;
            continue;
        }
        if backtick_quoted {
            if byte == b'`' && next == Some(b'`') {
                i += 2;
                continue;
            }
            if byte == b'`' {
                backtick_quoted = false;
            }
            i += 1;
            continue;
        }
        if bracket_quoted {
            if byte == b']' && next == Some(b']') {
                i += 2;
                continue;
            }
            if byte == b']' {
                bracket_quoted = false;
            }
            i += 1;
            continue;
        }

        match (byte, next) {
            (b'-', Some(b'-')) | (b'/', Some(b'*')) => return true,
            (b'\'', _) => single_quoted = true,
            (b'"', _) => double_quoted = true,
            (b'`', _) => backtick_quoted = true,
            (b'[', _) => bracket_quoted = true,
            _ => {}
        }
        i += 1;
    }
    false
}

pub(super) fn parse_sql(
    engine: &str,
    sql: &str,
) -> Result<Vec<Statement>, sqlparser::parser::ParserError> {
    let dialect: Box<dyn Dialect> = match engine {
        "MySQL" | "StarRocks" => Box::new(MySqlDialect {}),
        "PostgreSQL" | "PanWeiDB" => Box::new(PostgreSqlDialect {}),
        "SQLServer" => Box::new(MsSqlDialect {}),
        "Oracle" => Box::new(OracleDialect {}),
        "ClickHouse" => Box::new(ClickHouseDialect {}),
        _ => Box::new(GenericDialect),
    };
    Parser::parse_sql(dialect.as_ref(), sql)
}

pub(super) fn strip_sql_terminator(sql: &str) -> String {
    sql.trim().trim_end_matches(';').trim_end().to_string()
}

pub(super) fn sql_with_terminator(sql: &str) -> String {
    format!("{};", strip_sql_terminator(sql))
}

pub(super) fn top_level_sql_clauses(sql: &str) -> HashMap<&'static str, usize> {
    let checks: [(&str, &[&str]); 13] = [
        ("select", &["select"]),
        ("from", &["from"]),
        ("where", &["where"]),
        ("groupBy", &["group", "by"]),
        ("having", &["having"]),
        ("orderBy", &["order", "by"]),
        ("limit", &["limit"]),
        ("offset", &["offset"]),
        ("fetch", &["fetch"]),
        ("for", &["for"]),
        ("union", &["union"]),
        ("intersect", &["intersect"]),
        ("except", &["except"]),
    ];
    let mut clauses = HashMap::new();
    let bytes = sql.as_bytes();
    let mut i = 0;
    let mut depth = 0usize;
    let mut single_quoted = false;
    let mut double_quoted = false;
    let mut backtick_quoted = false;
    let mut bracket_quoted = false;
    let mut line_comment = false;
    let mut block_comment = false;

    while i < bytes.len() {
        let ch = bytes[i];
        let next = bytes.get(i + 1).copied();

        if line_comment {
            if ch == b'\n' {
                line_comment = false;
            }
            i += 1;
            continue;
        }
        if block_comment {
            if ch == b'*' && next == Some(b'/') {
                block_comment = false;
                i += 2;
            } else {
                i += 1;
            }
            continue;
        }
        if single_quoted {
            if ch == b'\'' && next == Some(b'\'') {
                i += 2;
            } else {
                if ch == b'\'' {
                    single_quoted = false;
                }
                i += 1;
            }
            continue;
        }
        if double_quoted {
            if ch == b'"' && next == Some(b'"') {
                i += 2;
            } else {
                if ch == b'"' {
                    double_quoted = false;
                }
                i += 1;
            }
            continue;
        }
        if backtick_quoted {
            if ch == b'`' && next == Some(b'`') {
                i += 2;
            } else {
                if ch == b'`' {
                    backtick_quoted = false;
                }
                i += 1;
            }
            continue;
        }
        if bracket_quoted {
            if ch == b']' && next == Some(b']') {
                i += 2;
            } else {
                if ch == b']' {
                    bracket_quoted = false;
                }
                i += 1;
            }
            continue;
        }

        match (ch, next) {
            (b'-', Some(b'-')) => {
                line_comment = true;
                i += 2;
                continue;
            }
            (b'/', Some(b'*')) => {
                block_comment = true;
                i += 2;
                continue;
            }
            _ => {}
        }

        match ch {
            b'\'' => single_quoted = true,
            b'"' => double_quoted = true,
            b'`' => backtick_quoted = true,
            b'[' => bracket_quoted = true,
            b'(' => depth += 1,
            b')' => depth = depth.saturating_sub(1),
            _ => {}
        }

        if depth == 0 {
            for (name, words) in checks {
                if clauses.contains_key(name) {
                    continue;
                }
                if keyword_sequence_at(sql, i, words).is_some() {
                    clauses.insert(name, i);
                }
            }
        }
        i += 1;
    }

    clauses
}

pub(super) fn first_clause_after(
    clauses: &HashMap<&'static str, usize>,
    names: &[&str],
    after: usize,
) -> Option<usize> {
    names
        .iter()
        .filter_map(|name| clauses.get(name).copied())
        .filter(|index| *index > after)
        .min()
}

pub(super) fn keyword_sequence_at(sql: &str, index: usize, words: &[&str]) -> Option<usize> {
    let bytes = sql.as_bytes();
    if index > 0 && is_ident_byte(bytes[index - 1]) {
        return None;
    }
    let mut pos = index;
    for (word_index, word) in words.iter().enumerate() {
        let word_bytes = word.as_bytes();
        if pos + word_bytes.len() > bytes.len() {
            return None;
        }
        if !bytes[pos..pos + word_bytes.len()].eq_ignore_ascii_case(word_bytes) {
            return None;
        }
        pos += word_bytes.len();
        if word_index + 1 == words.len() {
            if bytes.get(pos).is_some_and(|byte| is_ident_byte(*byte)) {
                return None;
            }
        } else {
            let whitespace_start = pos;
            while bytes
                .get(pos)
                .is_some_and(|byte| byte.is_ascii_whitespace())
            {
                pos += 1;
            }
            if pos == whitespace_start {
                return None;
            }
        }
    }
    Some(pos - index)
}

pub(super) fn is_ident_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'$'
}
