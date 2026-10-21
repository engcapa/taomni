use super::syntax::contains_sql_comment;
use super::syntax::first_clause_after;
use super::syntax::sql_with_terminator;
use super::syntax::top_level_sql_clauses;

pub(super) fn patch_inline_sql(
    base_sql: &str,
    where_clauses: &[String],
    order_items: &[String],
) -> Result<String, String> {
    let mut sql = base_sql.to_string();
    let mut clauses = top_level_sql_clauses(&sql);
    if !clauses.contains_key("select") || !clauses.contains_key("from") {
        return Err("top-level SELECT/FROM clauses were not found".to_string());
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

    if !order_items.is_empty() {
        let order_sql = order_items.join(", ");
        if let Some(&order_start) = clauses.get("orderBy") {
            let order_end =
                first_clause_after(&clauses, &["limit", "offset", "fetch", "for"], order_start)
                    .unwrap_or(sql.len());
            if contains_sql_comment(&sql[order_start..order_end]) {
                return Err("ORDER BY contains comments; SQL rewrite is not available without changing original formatting".to_string());
            }
            sql = format!(
                "{}, {}{}",
                sql[..order_end].trim_end(),
                order_sql,
                tail_suffix(&sql, order_end)
            );
        } else {
            let insert_at = first_clause_after(&clauses, &["limit", "offset", "fetch", "for"], 0)
                .unwrap_or(sql.len());
            sql = format!(
                "{}\nORDER BY {}{}",
                sql[..insert_at].trim_end(),
                order_sql,
                tail_suffix(&sql, insert_at)
            );
        }
    }

    Ok(sql_with_terminator(&sql))
}

pub(super) fn tail_suffix(sql: &str, insert_at: usize) -> String {
    if insert_at < sql.len() {
        format!("\n{}", sql[insert_at..].trim_start())
    } else {
        String::new()
    }
}
