use super::conditions::build_order_items;
use super::conditions::build_where_clauses;
use super::inline::patch_inline_sql;
use super::model::ResultSqlEngine;
use super::model::ResultSqlRewriteMode;
use super::model::ResultSqlRewriteRequest;
use super::model::ResultSqlRewriteResponse;
use super::projection::analyze_query_shape;
use super::projection::projection_mappings;
use super::syntax::parse_sql;
use super::syntax::strip_sql_terminator;
use sqlparser::ast::Query;
use sqlparser::ast::Statement;

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
        return unsupported_response("source SQL is empty");
    }

    match try_inline_rewrite(&request, engine, &base_sql) {
        Ok(sql) => ResultSqlRewriteResponse {
            sql: Some(sql),
            mode: ResultSqlRewriteMode::Inline,
            reason: None,
            warnings: Vec::new(),
        },
        Err(reason) => unsupported_response(reason),
    }
}

pub(super) fn try_inline_rewrite(
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
    let order_items = build_order_items(request, &mappings, true)?;
    if where_clauses.is_empty() && order_items.is_empty() {
        return Err("no result filter or sort requested".to_string());
    }

    patch_inline_sql(base_sql, &where_clauses, &order_items)
}

pub(super) fn unsupported_response(reason: impl Into<String>) -> ResultSqlRewriteResponse {
    ResultSqlRewriteResponse {
        sql: None,
        mode: ResultSqlRewriteMode::Unsupported,
        reason: Some(reason.into()),
        warnings: Vec::new(),
    }
}
