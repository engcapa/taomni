use super::model::ResultSqlFilter;
use super::model::ResultSqlFilterMode;
use super::model::ResultSqlRewriteMode;
use super::model::ResultSqlRewriteRequest;
use super::model::ResultSqlSort;
use super::model::ResultSqlSortDir;
use super::rewrite::rewrite_result_sql;

fn request(sql: &str) -> ResultSqlRewriteRequest {
    ResultSqlRewriteRequest {
        engine: "MySQL".to_string(),
        source_sql: sql.to_string(),
        result_columns: vec!["id".to_string(), "name".to_string(), "status".to_string()],
        visible_column_indexes: vec![0, 1, 2],
        global_filter_text: String::new(),
        filters: Vec::new(),
        sorts: Vec::new(),
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
    let mut req = request("SELECT id, name, status\nFROM users\nWHERE deleted = 0\nLIMIT 1000;");
    req.filters.push(status_filter());

    let res = rewrite_result_sql(req);

    assert_eq!(res.mode, ResultSqlRewriteMode::Inline);
    assert_eq!(
        res.sql.as_deref(),
        Some(
            "SELECT id, name, status\nFROM users\nWHERE deleted = 0\n  AND status = 'active'\nLIMIT 1000;"
        )
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
        sorts: Vec::new(),
    };

    let res = rewrite_result_sql(req.clone());
    assert_eq!(res.mode, ResultSqlRewriteMode::Inline);
    assert!(
        res.sql
            .as_deref()
            .is_some_and(|sql| sql.contains("WHERE u.id = '7'"))
    );

    req.sorts = vec![ResultSqlSort {
        column_index: 1,
        dir: ResultSqlSortDir::Desc,
    }];
    let res = rewrite_result_sql(req);
    assert!(
        res.sql
            .as_deref()
            .is_some_and(|sql| sql.contains("ORDER BY u.name DESC"))
    );
}

#[test]
fn rejects_computed_projection_filter() {
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
        sorts: Vec::new(),
    };

    let res = rewrite_result_sql(req);

    assert_eq!(res.mode, ResultSqlRewriteMode::Unsupported);
    assert_eq!(res.sql, None);
    assert_eq!(
        res.reason,
        Some("projection \"full_name\" is a computed expression".to_string())
    );
}

#[test]
fn appends_existing_order_by() {
    let mut req = request("SELECT * FROM users WHERE deleted = 0 ORDER BY id ASC LIMIT 1000");
    req.sorts = vec![ResultSqlSort {
        column_index: 2,
        dir: ResultSqlSortDir::Desc,
    }];

    let res = rewrite_result_sql(req);

    assert_eq!(res.mode, ResultSqlRewriteMode::Inline);
    assert_eq!(
        res.sql.as_deref(),
        Some("SELECT * FROM users WHERE deleted = 0 ORDER BY id ASC, `status` DESC\nLIMIT 1000;")
    );
}

#[test]
fn rejects_order_by_with_comments() {
    let mut req = request("SELECT * FROM users ORDER BY id ASC -- keep comment\nLIMIT 1000");
    req.sorts = vec![ResultSqlSort {
        column_index: 2,
        dir: ResultSqlSortDir::Desc,
    }];

    let res = rewrite_result_sql(req);

    assert_eq!(res.mode, ResultSqlRewriteMode::Unsupported);
    assert_eq!(res.sql, None);
    assert_eq!(
            res.reason,
            Some("ORDER BY contains comments; SQL rewrite is not available without changing original formatting".to_string())
        );
}

#[test]
fn rejects_unqualified_wildcard_join() {
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
        sorts: Vec::new(),
    };
    req.sorts = vec![ResultSqlSort {
        column_index: 2,
        dir: ResultSqlSortDir::Asc,
    }];

    let res = rewrite_result_sql(req);

    assert_eq!(res.mode, ResultSqlRewriteMode::Unsupported);
    assert_eq!(res.sql, None);
    assert_eq!(
        res.reason,
        Some(
            "unqualified wildcard projection with multiple tables is not inline-rewritable in v1"
                .to_string()
        )
    );
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
        sorts: vec![ResultSqlSort {
            column_index: 1,
            dir: ResultSqlSortDir::Desc,
        }],
    };

    let res = rewrite_result_sql(req);

    assert_eq!(res.mode, ResultSqlRewriteMode::Inline);
    assert!(
        res.sql
            .as_deref()
            .is_some_and(|sql| sql.contains("WHERE u.`id` = '7'"))
    );
    assert!(
        res.sql
            .as_deref()
            .is_some_and(|sql| sql.contains("ORDER BY u.`name` DESC"))
    );
    assert!(
        !res.sql
            .as_deref()
            .is_some_and(|sql| sql.contains("FROM (\n"))
    );
}

#[test]
fn rejects_duplicate_wildcard_result_columns() {
    let mut req = request("SELECT * FROM users LIMIT 1000");
    req.result_columns = vec!["id".to_string(), "id".to_string(), "status".to_string()];
    req.filters.push(ResultSqlFilter {
        column_index: 0,
        text: String::new(),
        mode: ResultSqlFilterMode::Exact,
        selected_values: vec![Some("7".to_string())],
    });

    let res = rewrite_result_sql(req);

    assert_eq!(res.mode, ResultSqlRewriteMode::Unsupported);
    assert_eq!(res.sql, None);
    assert_eq!(
        res.reason,
        Some("duplicate wildcard result columns are not inline-rewritable in v1".to_string())
    );
}

#[test]
fn rejects_group_by_query() {
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
        sorts: Vec::new(),
    };
    req.sorts = vec![ResultSqlSort {
        column_index: 1,
        dir: ResultSqlSortDir::Desc,
    }];

    let res = rewrite_result_sql(req);

    assert_eq!(res.mode, ResultSqlRewriteMode::Unsupported);
    assert_eq!(res.sql, None);
    assert_eq!(
        res.reason,
        Some("GROUP BY query is not inline-rewritable in v1".to_string())
    );
}
