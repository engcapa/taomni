use super::model::ProjectionMapping;
use super::model::ResultSqlEngine;
use super::model::ResultSqlFilterMode;
use super::model::ResultSqlRewriteRequest;
use super::model::ResultSqlSortDir;
use super::projection::column_expression;

pub(super) fn build_where_clauses(
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

pub(super) fn build_order_items(
    request: &ResultSqlRewriteRequest,
    engine_mappings: &[ProjectionMapping],
    inline: bool,
) -> Result<Vec<String>, String> {
    let engine = ResultSqlEngine::parse(&request.engine);
    request
        .sorts
        .iter()
        .map(|sort| {
            let expression =
                column_expression(request, engine, engine_mappings, sort.column_index, inline)?;
            let dir = match sort.dir {
                ResultSqlSortDir::Asc => "ASC",
                ResultSqlSortDir::Desc => "DESC",
            };
            Ok(format!("{expression} {dir}"))
        })
        .collect()
}

pub(super) fn selected_values_condition(
    column_sql: &str,
    values: &[Option<String>],
) -> Option<String> {
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

pub(super) fn unique_filter_values(values: &[Option<String>]) -> Vec<Option<String>> {
    let mut seen = Vec::<Option<String>>::new();
    for value in values {
        if !seen.iter().any(|candidate| candidate == value) {
            seen.push(value.clone());
        }
    }
    seen
}

pub(super) fn sql_literal(value: Option<&str>) -> String {
    match value {
        Some(value) => format!("'{}'", value.replace('\'', "''")),
        None => "NULL".to_string(),
    }
}

pub(super) fn escape_like_pattern(value: &str) -> String {
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

pub(super) fn sql_like_condition(expression: &str, value: &str) -> String {
    format!(
        "{expression} LIKE {} ESCAPE '!'",
        sql_literal(Some(&format!("%{}%", escape_like_pattern(value))))
    )
}
