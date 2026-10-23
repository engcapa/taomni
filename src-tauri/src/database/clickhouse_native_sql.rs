//! Inline SQL VALUES must be sent as a server-side INSERT SELECT on Native.
//! Native VALUES expects a second binary data exchange; sending text VALUES
//! through a query stream leaves the server waiting for that exchange.
use sqlparser::ast::{SetExpr, Statement};
use sqlparser::dialect::ClickHouseDialect;
use sqlparser::parser::Parser;
use std::borrow::Cow;

pub(super) fn native_sql(sql: &str) -> Result<Cow<'_, str>, String> {
    // Leave vendor syntax outside INSERT to the server, including syntax newer
    // than the parser. Parsing is used to rewrite expressions, never regex.
    let Ok(mut statements) = Parser::parse_sql(&ClickHouseDialect {}, sql) else {
        return Ok(Cow::Borrowed(sql));
    };
    if statements.len() != 1 {
        return Ok(Cow::Borrowed(sql));
    }
    let Statement::Insert(insert) = &mut statements[0] else {
        return Ok(Cow::Borrowed(sql));
    };
    let Some(source) = &mut insert.source else {
        return Ok(Cow::Borrowed(sql));
    };
    let SetExpr::Values(values) = source.body.as_ref() else {
        return Ok(Cow::Borrowed(sql));
    };
    if values.rows.is_empty() {
        return Err("ClickHouse INSERT VALUES has no rows".into());
    }
    let select = values
        .rows
        .iter()
        .map(|row| {
            format!(
                "SELECT {}",
                row.iter()
                    .map(ToString::to_string)
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        })
        .collect::<Vec<_>>()
        .join(" UNION ALL ");
    let parsed = Parser::parse_sql(&ClickHouseDialect {}, &select)
        .map_err(|e| format!("ClickHouse INSERT expressions: {e}"))?;
    let Statement::Query(query) = parsed.into_iter().next().ok_or("Missing INSERT source")? else {
        return Err("Invalid INSERT source".into());
    };
    *source = query;
    Ok(Cow::Owned(statements[0].to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn inline_insert_preserves_expressions_and_quoted_identifiers() {
        let sql = native_sql(
            "INSERT INTO `odd table` (`id`, `text`) VALUES (1, 'a, (b)'), (2, concat('c', 'd'))",
        )
        .unwrap();
        assert_eq!(
            sql,
            "INSERT INTO `odd table` (`id`, `text`) SELECT 1, 'a, (b)' UNION ALL SELECT 2, concat('c', 'd')"
        );
        for sql in [
            "SELECT 'VALUES (1)'",
            "CREATE TABLE x (id UInt64) ENGINE=Memory",
            "INSERT INTO x SELECT 1",
        ] {
            assert_eq!(native_sql(sql).unwrap(), sql);
        }
    }
}
