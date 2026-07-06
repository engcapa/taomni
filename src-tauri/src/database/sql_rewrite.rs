use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use sqlparser::ast::{Expr, GroupByExpr, Query, Select, SelectItem, SetExpr, Statement};
use sqlparser::dialect::{
    ClickHouseDialect, Dialect, GenericDialect, MsSqlDialect, MySqlDialect, OracleDialect,
    PostgreSqlDialect,
};
use sqlparser::parser::Parser;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultSqlRewriteRequest {
    pub engine: String,
    pub source_sql: String,
    pub result_columns: Vec<String>,
    #[serde(default)]
    pub visible_column_indexes: Vec<usize>,
    #[serde(default)]
    pub global_filter_text: String,
    #[serde(default)]
    pub filters: Vec<ResultSqlFilter>,
    #[serde(default)]
    pub sort: Option<ResultSqlSort>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultSqlFilter {
    pub column_index: usize,
    #[serde(default)]
    pub text: String,
    pub mode: ResultSqlFilterMode,
    #[serde(default)]
    pub selected_values: Vec<Option<String>>,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ResultSqlFilterMode {
    Fuzzy,
    Exact,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultSqlSort {
    pub column_index: usize,
    pub dir: ResultSqlSortDir,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ResultSqlSortDir {
    Asc,
    Desc,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ResultSqlRewriteResponse {
    pub sql: String,
    pub mode: ResultSqlRewriteMode,
    pub reason: Option<String>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ResultSqlRewriteMode {
    Inline,
    Derived,
}

#[derive(Debug, Clone)]
enum ProjectionMapping {
    Source(String),
    Computed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ResultSqlEngine {
    MySql,
    StarRocks,
    PostgreSql,
    PanWeiDb,
    Oracle,
    SqlServer,
    ClickHouse,
    Presto,
}

impl ResultSqlEngine {
    fn parse(value: &str) -> Self {
        match value {
            "PostgreSQL" => Self::PostgreSql,
            "PanWeiDB" => Self::PanWeiDb,
            "Oracle" => Self::Oracle,
            "SQLServer" => Self::SqlServer,
            "StarRocks" => Self::StarRocks,
            "ClickHouse" => Self::ClickHouse,
            "Presto" => Self::Presto,
            _ => Self::MySql,
        }
    }

    fn quote_ident(self, ident: &str) -> String {
        match self {
            Self::SqlServer => format!("[{}]", ident.replace(']', "]]")),
            Self::PostgreSql | Self::PanWeiDb | Self::Oracle | Self::Presto => {
                format!("\"{}\"", ident.replace('"', "\"\""))
            }
            Self::MySql | Self::StarRocks | Self::ClickHouse => {
                format!("`{}`", ident.replace('`', "``"))
            }
        }
    }

    fn text_expression(self, expression: &str) -> String {
        match self {
            Self::MySql | Self::StarRocks => format!("CAST({expression} AS CHAR)"),
            Self::PostgreSql | Self::PanWeiDb => format!("{expression}::text"),
            Self::Oracle => format!("CAST({expression} AS VARCHAR2(4000))"),
            Self::SqlServer => format!("CAST({expression} AS NVARCHAR(MAX))"),
            Self::ClickHouse => format!("toString({expression})"),
            Self::Presto => format!("CAST({expression} AS VARCHAR)"),
        }
    }

    fn derived_alias(self) -> &'static str {
        if self == Self::Oracle {
            ") taomni_result"
        } else {
            ") AS taomni_result"
        }
    }
}

#[tauri::command]
pub async fn db_rewrite_result_sql(
    request: ResultSqlRewriteRequest,
) -> Result<ResultSqlRewriteResponse, String> {
    Ok(rewrite_result_sql(request))
}

pub fn rewrite_result_sql(request: ResultSqlRewriteRequest) -> ResultSqlRewriteResponse {
    let engine = ResultSqlEngine::parse(&request.engine);
    let base_sql = strip_sql_terminator(&request.source_sql);
    if base_sql.trim().is_empty() {
        return derived_response(&request, engine, "source SQL is empty");
    }

    match try_inline_rewrite(&request, engine, &base_sql) {
        Ok(sql) => ResultSqlRewriteResponse {
            sql,
            mode: ResultSqlRewriteMode::Inline,
            reason: None,
            warnings: Vec::new(),
        },
        Err(reason) => derived_response(&request, engine, &reason),
    }
}

fn try_inline_rewrite(
    request: &ResultSqlRewriteRequest,
    engine: ResultSqlEngine,
    base_sql: &str,
) -> Result<String, String> {
    let statements = parse_sql(&request.engine, base_sql)
        .map_err(|err| format!("parser failed for {}: {err}", request.engine))?;
    if statements.len() != 1 {
        return Err("multiple statements are not inline-rewritable".to_string());
    }

    let Statement::Query(query) = &statements[0] else {
        return Err("statement is not a SELECT query".to_string());
    };
    let select = analyze_query_shape(query)?;
    let mappings = projection_mappings(select, request, engine)?;
    let where_clauses = build_where_clauses(request, engine, &mappings, true)?;
    let order_by = build_order_by(request, &mappings, true)?;
    if where_clauses.is_empty() && order_by.is_none() {
        return Err("no result filter or sort requested".to_string());
    }

    patch_inline_sql(base_sql, &where_clauses, order_by.as_deref())
}

fn analyze_query_shape(query: &Query) -> Result<&Select, String> {
    if query.with.is_some() {
        return Err("CTE query is not inline-rewritable in v1".to_string());
    }
    if !query.pipe_operators.is_empty() {
        return Err("pipe operator query is not inline-rewritable in v1".to_string());
    }

    let SetExpr::Select(select) = query.body.as_ref() else {
        return Err("set operation query is not inline-rewritable in v1".to_string());
    };

    if select.distinct.is_some() {
        return Err("DISTINCT query is not inline-rewritable in v1".to_string());
    }
    if select.from.is_empty() {
        return Err("SELECT without FROM is not inline-rewritable".to_string());
    }
    if select.into.is_some() {
        return Err("SELECT INTO query is not inline-rewritable in v1".to_string());
    }
    if select.prewhere.is_some() {
        return Err("PREWHERE query is not inline-rewritable in v1".to_string());
    }
    if !is_empty_group_by(&select.group_by) {
        return Err("GROUP BY query is not inline-rewritable in v1".to_string());
    }
    if select.having.is_some() {
        return Err("HAVING query is not inline-rewritable in v1".to_string());
    }
    if !select.named_window.is_empty() || select.qualify.is_some() {
        return Err("window output query is not inline-rewritable in v1".to_string());
    }
    if !select.cluster_by.is_empty()
        || !select.distribute_by.is_empty()
        || !select.sort_by.is_empty()
        || !select.lateral_views.is_empty()
        || !select.connect_by.is_empty()
    {
        return Err("query shape is not inline-rewritable in v1".to_string());
    }

    Ok(select)
}

fn is_empty_group_by(group_by: &GroupByExpr) -> bool {
    match group_by {
        GroupByExpr::Expressions(exprs, modifiers) => exprs.is_empty() && modifiers.is_empty(),
        GroupByExpr::All(_) => false,
    }
}

fn projection_mappings(
    select: &Select,
    request: &ResultSqlRewriteRequest,
    engine: ResultSqlEngine,
) -> Result<Vec<ProjectionMapping>, String> {
    if select.projection.len() == 1 {
        if let Some(SelectItem::Wildcard(_)) = select.projection.first() {
            if select.from.len() != 1
                || select
                    .from
                    .first()
                    .is_some_and(|table| !table.joins.is_empty())
            {
                return Err("unqualified wildcard projection with multiple tables is not inline-rewritable in v1".to_string());
            }
            ensure_unique_result_columns(&request.result_columns)?;
            return Ok(request
                .result_columns
                .iter()
                .map(|column| ProjectionMapping::Source(engine.quote_ident(column)))
                .collect());
        }

        if let Some(SelectItem::QualifiedWildcard(prefix, _)) = select.projection.first() {
            ensure_unique_result_columns(&request.result_columns)?;
            let qualifier = prefix.to_string();
            let qualifier = qualifier
                .strip_suffix(".*")
                .unwrap_or(&qualifier)
                .to_string();
            return Ok(request
                .result_columns
                .iter()
                .map(|column| {
                    ProjectionMapping::Source(format!("{qualifier}.{}", engine.quote_ident(column)))
                })
                .collect());
        }
    }

    if select.projection.iter().any(|item| {
        matches!(
            item,
            SelectItem::Wildcard(_) | SelectItem::QualifiedWildcard(_, _)
        )
    }) {
        return Err("mixed wildcard projection is not inline-rewritable in v1".to_string());
    }

    if select.projection.len() != request.result_columns.len() {
        return Err("projection count does not match result columns".to_string());
    }

    select
        .projection
        .iter()
        .map(|item| match item {
            SelectItem::UnnamedExpr(expr) => simple_source_expr(expr)
                .map(ProjectionMapping::Source)
                .ok_or_else(|| "projection contains a computed expression".to_string()),
            SelectItem::ExprWithAlias { expr, .. } => Ok(simple_source_expr(expr)
                .map(ProjectionMapping::Source)
                .unwrap_or(ProjectionMapping::Computed)),
            SelectItem::ExprWithAliases { .. } => {
                Err("projection with multiple aliases is not inline-rewritable in v1".to_string())
            }
            SelectItem::Wildcard(_) | SelectItem::QualifiedWildcard(_, _) => {
                Err("wildcard projection is not inline-rewritable here".to_string())
            }
        })
        .collect()
}

fn ensure_unique_result_columns(columns: &[String]) -> Result<(), String> {
    let mut seen = HashSet::new();
    if columns
        .iter()
        .any(|column| !seen.insert(column.to_ascii_lowercase()))
    {
        return Err(
            "duplicate wildcard result columns are not inline-rewritable in v1".to_string(),
        );
    }
    Ok(())
}

fn simple_source_expr(expr: &Expr) -> Option<String> {
    match expr {
        Expr::Identifier(_) | Expr::CompoundIdentifier(_) => Some(expr.to_string()),
        _ => None,
    }
}

fn build_where_clauses(
    request: &ResultSqlRewriteRequest,
    engine: ResultSqlEngine,
    mappings: &[ProjectionMapping],
    inline: bool,
) -> Result<Vec<String>, String> {
    let mut clauses = Vec::new();
    let global = request.global_filter_text.trim();
    if !global.is_empty() {
        let mut parts = Vec::new();
        for &column_index in &request.visible_column_indexes {
            let expression = column_expression(request, engine, mappings, column_index, inline)?;
            parts.push(sql_like_condition(
                &engine.text_expression(&expression),
                global,
            ));
        }
        if !parts.is_empty() {
            clauses.push(format!("({})", parts.join(" OR ")));
        }
    }

    for filter in &request.filters {
        if filter.column_index >= request.result_columns.len() {
            return Err(format!(
                "filter column index {} is out of range",
                filter.column_index
            ));
        }
        let expression = column_expression(request, engine, mappings, filter.column_index, inline)?;
        if let Some(selected) = selected_values_condition(&expression, &filter.selected_values) {
            clauses.push(selected);
        } else {
            let text = filter.text.trim();
            if text.is_empty() {
                continue;
            }
            clauses.push(match filter.mode {
                ResultSqlFilterMode::Exact => {
                    format!("{expression} = {}", sql_literal(Some(text)))
                }
                ResultSqlFilterMode::Fuzzy => {
                    sql_like_condition(&engine.text_expression(&expression), text)
                }
            });
        }
    }

    Ok(clauses)
}

fn build_order_by(
    request: &ResultSqlRewriteRequest,
    engine_mappings: &[ProjectionMapping],
    inline: bool,
) -> Result<Option<String>, String> {
    let Some(sort) = &request.sort else {
        return Ok(None);
    };
    let engine = ResultSqlEngine::parse(&request.engine);
    let expression =
        column_expression(request, engine, engine_mappings, sort.column_index, inline)?;
    let dir = match sort.dir {
        ResultSqlSortDir::Asc => "ASC",
        ResultSqlSortDir::Desc => "DESC",
    };
    Ok(Some(format!("ORDER BY {expression} {dir}")))
}

fn column_expression(
    request: &ResultSqlRewriteRequest,
    engine: ResultSqlEngine,
    mappings: &[ProjectionMapping],
    column_index: usize,
    inline: bool,
) -> Result<String, String> {
    let column = request
        .result_columns
        .get(column_index)
        .ok_or_else(|| format!("column index {column_index} is out of range"))?;
    if !inline {
        return Ok(engine.quote_ident(column));
    }
    match mappings.get(column_index) {
        Some(ProjectionMapping::Source(expr)) => Ok(expr.clone()),
        Some(ProjectionMapping::Computed) => {
            Err(format!("projection \"{column}\" is a computed expression"))
        }
        None => Err(format!("projection for \"{column}\" was not found")),
    }
}

fn selected_values_condition(column_sql: &str, values: &[Option<String>]) -> Option<String> {
    let unique = unique_filter_values(values);
    let non_null: Vec<&str> = unique.iter().filter_map(|value| value.as_deref()).collect();
    let mut clauses = Vec::new();
    if non_null.len() == 1 {
        clauses.push(format!(
            "{column_sql} = {}",
            sql_literal(non_null.first().copied())
        ));
    } else if !non_null.is_empty() {
        clauses.push(format!(
            "{column_sql} IN ({})",
            non_null
                .iter()
                .map(|value| sql_literal(Some(*value)))
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    if unique.iter().any(Option::is_none) {
        clauses.push(format!("{column_sql} IS NULL"));
    }
    match clauses.len() {
        0 => None,
        1 => clauses.into_iter().next(),
        _ => Some(format!("({})", clauses.join(" OR "))),
    }
}

fn unique_filter_values(values: &[Option<String>]) -> Vec<Option<String>> {
    let mut seen = Vec::<Option<String>>::new();
    for value in values {
        if !seen.iter().any(|candidate| candidate == value) {
            seen.push(value.clone());
        }
    }
    seen
}

fn sql_literal(value: Option<&str>) -> String {
    match value {
        Some(value) => format!("'{}'", value.replace('\'', "''")),
        None => "NULL".to_string(),
    }
}

fn escape_like_pattern(value: &str) -> String {
    value
        .chars()
        .flat_map(|ch| {
            if matches!(ch, '!' | '%' | '_') {
                vec!['!', ch]
            } else {
                vec![ch]
            }
        })
        .collect()
}

fn sql_like_condition(expression: &str, value: &str) -> String {
    format!(
        "{expression} LIKE {} ESCAPE '!'",
        sql_literal(Some(&format!("%{}%", escape_like_pattern(value))))
    )
}

fn patch_inline_sql(
    base_sql: &str,
    where_clauses: &[String],
    order_by: Option<&str>,
) -> Result<String, String> {
    let mut sql = base_sql.to_string();
    let mut clauses = top_level_sql_clauses(&sql);
    if !clauses.contains_key("select") || !clauses.contains_key("from") {
        return Err("top-level SELECT/FROM clauses were not found".to_string());
    }

    if order_by.is_some() {
        sql = without_top_level_order_by(&sql, &clauses);
        clauses = top_level_sql_clauses(&sql);
    }

    if !where_clauses.is_empty() {
        let tail_start =
            first_clause_after(&clauses, &["orderBy", "limit", "offset", "fetch", "for"], 0);
        let where_sql = where_clauses.join("\n  AND ");
        let insert_at = tail_start.unwrap_or(sql.len());
        if clauses.contains_key("where") {
            sql = format!(
                "{}\n  AND {}{}",
                sql[..insert_at].trim_end(),
                where_sql,
                tail_suffix(&sql, insert_at)
            );
        } else {
            sql = format!(
                "{}\nWHERE {}{}",
                sql[..insert_at].trim_end(),
                where_sql,
                tail_suffix(&sql, insert_at)
            );
        }
        clauses = top_level_sql_clauses(&sql);
    }

    if let Some(order_by) = order_by {
        let insert_at = first_clause_after(&clauses, &["limit", "offset", "fetch", "for"], 0)
            .unwrap_or(sql.len());
        sql = format!(
            "{}\n{}{}",
            sql[..insert_at].trim_end(),
            order_by,
            tail_suffix(&sql, insert_at)
        );
    }

    Ok(sql_with_terminator(&sql))
}

fn without_top_level_order_by(sql: &str, clauses: &HashMap<&'static str, usize>) -> String {
    let Some(&order_start) = clauses.get("orderBy") else {
        return sql.to_string();
    };
    let order_end = first_clause_after(clauses, &["limit", "offset", "fetch", "for"], order_start)
        .unwrap_or(sql.len());
    let before = sql[..order_start].trim_end();
    let after = sql[order_end..].trim_start();
    if after.is_empty() {
        before.to_string()
    } else {
        format!("{before}\n{after}")
    }
}

fn tail_suffix(sql: &str, insert_at: usize) -> String {
    if insert_at < sql.len() {
        format!("\n{}", sql[insert_at..].trim_start())
    } else {
        String::new()
    }
}

fn derived_response(
    request: &ResultSqlRewriteRequest,
    engine: ResultSqlEngine,
    reason: impl Into<String>,
) -> ResultSqlRewriteResponse {
    let reason = reason.into();
    let base_sql = strip_sql_terminator(&request.source_sql);
    let mappings = request
        .result_columns
        .iter()
        .map(|column| ProjectionMapping::Source(engine.quote_ident(column)))
        .collect::<Vec<_>>();
    let where_clauses = build_where_clauses(request, engine, &mappings, false).unwrap_or_default();
    let order_by = build_order_by(request, &mappings, false).ok().flatten();
    let mut lines = vec![
        "SELECT *".to_string(),
        "FROM (".to_string(),
        indent_sql(&base_sql),
        engine.derived_alias().to_string(),
    ];
    if !where_clauses.is_empty() {
        lines.push(format!("WHERE {}", where_clauses.join("\n  AND ")));
    }
    if let Some(order_by) = order_by {
        lines.push(order_by);
    }
    ResultSqlRewriteResponse {
        sql: format!("{};", lines.join("\n")),
        mode: ResultSqlRewriteMode::Derived,
        reason: Some(reason),
        warnings: Vec::new(),
    }
}

fn parse_sql(engine: &str, sql: &str) -> Result<Vec<Statement>, sqlparser::parser::ParserError> {
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

fn strip_sql_terminator(sql: &str) -> String {
    sql.trim().trim_end_matches(';').trim_end().to_string()
}

fn sql_with_terminator(sql: &str) -> String {
    format!("{};", strip_sql_terminator(sql))
}

fn indent_sql(sql: &str) -> String {
    sql.lines()
        .map(|line| format!("  {line}"))
        .collect::<Vec<_>>()
        .join("\n")
}

fn top_level_sql_clauses(sql: &str) -> HashMap<&'static str, usize> {
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

fn first_clause_after(
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

fn keyword_sequence_at(sql: &str, index: usize, words: &[&str]) -> Option<usize> {
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

fn is_ident_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'$'
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(sql: &str) -> ResultSqlRewriteRequest {
        ResultSqlRewriteRequest {
            engine: "MySQL".to_string(),
            source_sql: sql.to_string(),
            result_columns: vec!["id".to_string(), "name".to_string(), "status".to_string()],
            visible_column_indexes: vec![0, 1, 2],
            global_filter_text: String::new(),
            filters: Vec::new(),
            sort: None,
        }
    }

    fn status_filter() -> ResultSqlFilter {
        ResultSqlFilter {
            column_index: 2,
            text: String::new(),
            mode: ResultSqlFilterMode::Fuzzy,
            selected_values: vec![Some("active".to_string())],
        }
    }

    #[test]
    fn inlines_explicit_projection_filter_before_limit() {
        let mut req =
            request("SELECT id, name, status\nFROM users\nWHERE deleted = 0\nLIMIT 1000;");
        req.filters.push(status_filter());

        let res = rewrite_result_sql(req);

        assert_eq!(res.mode, ResultSqlRewriteMode::Inline);
        assert_eq!(
            res.sql,
            "SELECT id, name, status\nFROM users\nWHERE deleted = 0\n  AND status = 'active'\nLIMIT 1000;"
        );
    }

    #[test]
    fn inlines_alias_using_source_expression() {
        let mut req = ResultSqlRewriteRequest {
            engine: "MySQL".to_string(),
            source_sql: "SELECT u.id AS user_id, u.name\nFROM users u\nLIMIT 1000;".to_string(),
            result_columns: vec!["user_id".to_string(), "name".to_string()],
            visible_column_indexes: vec![0, 1],
            global_filter_text: String::new(),
            filters: vec![ResultSqlFilter {
                column_index: 0,
                text: String::new(),
                mode: ResultSqlFilterMode::Fuzzy,
                selected_values: vec![Some("7".to_string())],
            }],
            sort: None,
        };

        let res = rewrite_result_sql(req.clone());
        assert_eq!(res.mode, ResultSqlRewriteMode::Inline);
        assert!(res.sql.contains("WHERE u.id = '7'"));

        req.sort = Some(ResultSqlSort {
            column_index: 1,
            dir: ResultSqlSortDir::Desc,
        });
        let res = rewrite_result_sql(req);
        assert!(res.sql.contains("ORDER BY u.name DESC"));
    }

    #[test]
    fn derives_computed_projection_filter() {
        let req = ResultSqlRewriteRequest {
            engine: "MySQL".to_string(),
            source_sql:
                "SELECT concat(first_name, ' ', last_name) AS full_name\nFROM users\nLIMIT 1000;"
                    .to_string(),
            result_columns: vec!["full_name".to_string()],
            visible_column_indexes: vec![0],
            global_filter_text: String::new(),
            filters: vec![ResultSqlFilter {
                column_index: 0,
                text: "Ann".to_string(),
                mode: ResultSqlFilterMode::Fuzzy,
                selected_values: Vec::new(),
            }],
            sort: None,
        };

        let res = rewrite_result_sql(req);

        assert_eq!(res.mode, ResultSqlRewriteMode::Derived);
        assert_eq!(
            res.reason,
            Some("projection \"full_name\" is a computed expression".to_string())
        );
        assert!(res.sql.contains("FROM (\n  SELECT concat"));
        assert!(
            res.sql
                .contains("WHERE CAST(`full_name` AS CHAR) LIKE '%Ann%' ESCAPE '!'")
        );
    }

    #[test]
    fn replaces_existing_order_by() {
        let mut req = request("SELECT * FROM users WHERE deleted = 0 ORDER BY id ASC LIMIT 1000");
        req.sort = Some(ResultSqlSort {
            column_index: 2,
            dir: ResultSqlSortDir::Desc,
        });

        let res = rewrite_result_sql(req);

        assert_eq!(res.mode, ResultSqlRewriteMode::Inline);
        assert_eq!(
            res.sql,
            "SELECT * FROM users WHERE deleted = 0\nORDER BY `status` DESC\nLIMIT 1000;"
        );
    }

    #[test]
    fn derives_unqualified_wildcard_join() {
        let mut req = ResultSqlRewriteRequest {
            engine: "MySQL".to_string(),
            source_sql: "SELECT * FROM users u JOIN orders o ON u.id = o.user_id LIMIT 1000"
                .to_string(),
            result_columns: vec!["id".to_string(), "id".to_string(), "status".to_string()],
            visible_column_indexes: vec![0, 1, 2],
            global_filter_text: String::new(),
            filters: vec![ResultSqlFilter {
                column_index: 0,
                text: String::new(),
                mode: ResultSqlFilterMode::Exact,
                selected_values: vec![Some("7".to_string())],
            }],
            sort: None,
        };
        req.sort = Some(ResultSqlSort {
            column_index: 2,
            dir: ResultSqlSortDir::Asc,
        });

        let res = rewrite_result_sql(req);

        assert_eq!(res.mode, ResultSqlRewriteMode::Derived);
        assert_eq!(
            res.reason,
            Some(
                "unqualified wildcard projection with multiple tables is not inline-rewritable in v1"
                    .to_string()
            )
        );
        assert!(
            res.sql
                .contains("FROM (\n  SELECT * FROM users u JOIN orders o")
        );
        assert!(res.sql.contains("WHERE `id` = '7'"));
        assert!(res.sql.contains("ORDER BY `status` ASC"));
    }

    #[test]
    fn inlines_qualified_wildcard_join() {
        let req = ResultSqlRewriteRequest {
            engine: "MySQL".to_string(),
            source_sql: "SELECT u.* FROM users u JOIN orders o ON u.id = o.user_id LIMIT 1000"
                .to_string(),
            result_columns: vec!["id".to_string(), "name".to_string()],
            visible_column_indexes: vec![0, 1],
            global_filter_text: String::new(),
            filters: vec![ResultSqlFilter {
                column_index: 0,
                text: String::new(),
                mode: ResultSqlFilterMode::Exact,
                selected_values: vec![Some("7".to_string())],
            }],
            sort: Some(ResultSqlSort {
                column_index: 1,
                dir: ResultSqlSortDir::Desc,
            }),
        };

        let res = rewrite_result_sql(req);

        assert_eq!(res.mode, ResultSqlRewriteMode::Inline);
        assert!(res.sql.contains("WHERE u.`id` = '7'"));
        assert!(res.sql.contains("ORDER BY u.`name` DESC"));
        assert!(!res.sql.contains("FROM (\n"));
    }

    #[test]
    fn derives_duplicate_wildcard_result_columns() {
        let mut req = request("SELECT * FROM users LIMIT 1000");
        req.result_columns = vec!["id".to_string(), "id".to_string(), "status".to_string()];
        req.filters.push(ResultSqlFilter {
            column_index: 0,
            text: String::new(),
            mode: ResultSqlFilterMode::Exact,
            selected_values: vec![Some("7".to_string())],
        });

        let res = rewrite_result_sql(req);

        assert_eq!(res.mode, ResultSqlRewriteMode::Derived);
        assert_eq!(
            res.reason,
            Some("duplicate wildcard result columns are not inline-rewritable in v1".to_string())
        );
    }

    #[test]
    fn derives_group_by_query() {
        let mut req = ResultSqlRewriteRequest {
            engine: "MySQL".to_string(),
            source_sql: "SELECT status, count(*) AS c FROM users GROUP BY status".to_string(),
            result_columns: vec!["status".to_string(), "c".to_string()],
            visible_column_indexes: vec![0, 1],
            global_filter_text: String::new(),
            filters: vec![ResultSqlFilter {
                column_index: 0,
                text: String::new(),
                mode: ResultSqlFilterMode::Exact,
                selected_values: vec![Some("active".to_string())],
            }],
            sort: None,
        };
        req.sort = Some(ResultSqlSort {
            column_index: 1,
            dir: ResultSqlSortDir::Desc,
        });

        let res = rewrite_result_sql(req);

        assert_eq!(res.mode, ResultSqlRewriteMode::Derived);
        assert_eq!(
            res.reason,
            Some("GROUP BY query is not inline-rewritable in v1".to_string())
        );
        assert!(res.sql.contains("WHERE `status` = 'active'"));
        assert!(res.sql.contains("ORDER BY `c` DESC"));
    }
}
