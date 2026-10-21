use super::model::ProjectionMapping;
use super::model::ResultSqlEngine;
use super::model::ResultSqlRewriteRequest;
use sqlparser::ast::Expr;
use sqlparser::ast::GroupByExpr;
use sqlparser::ast::Query;
use sqlparser::ast::Select;
use sqlparser::ast::SelectItem;
use sqlparser::ast::SetExpr;
use std::collections::HashSet;

pub(super) fn analyze_query_shape(query: &Query) -> Result<&Select, String> {
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

pub(super) fn is_empty_group_by(group_by: &GroupByExpr) -> bool {
    match group_by {
        GroupByExpr::Expressions(exprs, modifiers) => exprs.is_empty() && modifiers.is_empty(),
        GroupByExpr::All(_) => false,
    }
}

pub(super) fn projection_mappings(
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

pub(super) fn ensure_unique_result_columns(columns: &[String]) -> Result<(), String> {
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

pub(super) fn simple_source_expr(expr: &Expr) -> Option<String> {
    match expr {
        Expr::Identifier(_) | Expr::CompoundIdentifier(_) => Some(expr.to_string()),
        _ => None,
    }
}

pub(super) fn column_expression(
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
