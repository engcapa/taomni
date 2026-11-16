use rusqlite::{Connection, params};
use serde_json::{Value, json};

pub fn canonical_source(source: &str) -> &str {
    match source {
        "session" => "sessions",
        "command" => "commands",
        "note" => "notes",
        "thread" => "tao",
        "workspace" => "workspaces",
        "tool" => "capabilities",
        other => other,
    }
}

pub fn search(conn: &Connection, query: &str) -> Result<Vec<Value>, String> {
    let mut source = None;
    let mut host = None;
    let mut since = 0i64;
    let mut terms = Vec::new();
    for term in query.split_whitespace() {
        if let Some(value) = term.strip_prefix("source:") {
            source = Some(canonical_source(value).to_string());
        } else if let Some(value) = term.strip_prefix("host:") {
            host = Some(value.to_string());
        } else if let Some(value) = term.strip_prefix("since:") {
            since = parse_since(value)
                .ok_or("search: since must be YYYY-MM-DD or a number of days, e.g. 14d")?;
        } else {
            terms.push(term);
        }
    }
    let term = terms.join(" ");
    if term.is_empty() && source.is_none() && host.is_none() {
        return Ok(vec![]);
    }
    let short = term.chars().count() < 3;
    let escaped = term
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    let pattern = format!("%{escaped}%");
    let fts = terms
        .iter()
        .filter(|t| !t.is_empty())
        .take(16)
        .map(|t| format!("\"{}\"", t.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" OR ");
    let predicate = if short {
        "(title LIKE ?1 ESCAPE '\\' OR body LIKE ?1 ESCAPE '\\')"
    } else {
        "ds_app_search MATCH ?1"
    };
    let rank = if short { "" } else { "bm25(ds_app_search)," };
    let sql = format!("SELECT source,ref,title,body,host,CAST(ts AS INTEGER),CAST(use_count AS INTEGER) FROM ds_app_search WHERE {predicate}
        AND (?2 IS NULL OR source=?2) AND (?3 IS NULL OR host LIKE '%'||?3||'%') AND CAST(ts AS INTEGER)>=?4
        ORDER BY {rank}CAST(ts AS INTEGER) DESC,CAST(use_count AS INTEGER) DESC LIMIT 20");
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    stmt.query_map(params![if short { pattern } else { fts }, source, host, since], |row| {
        let source: String = row.get(0)?;
        let reference: String = row.get(1)?;
        let body: String = row.get(3)?;
        Ok(json!({"id": format!("{source}:{reference}"), "source": source, "ref": reference,
            "title": row.get::<_,String>(2)?, "body": body.chars().take(800).collect::<String>(),
            "host": row.get::<_,String>(4)?, "ts": row.get::<_,i64>(5)?, "useCount": row.get::<_,i64>(6)?,
            "exactMatchFallback": short}))
    }).map_err(|e| e.to_string())?.map(|row| row.map_err(|e| e.to_string())).collect()
}

fn parse_since(value: &str) -> Option<i64> {
    if let Some(days) = value
        .strip_suffix('d')
        .and_then(|v| v.parse::<i64>().ok())
        .filter(|d| *d >= 0 && *d <= 36500)
    {
        return Some(
            chrono::Utc::now()
                .timestamp_millis()
                .saturating_sub(days * 86_400_000),
        );
    }
    chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .ok()?
        .and_hms_opt(0, 0, 0)
        .map(|d| d.and_utc().timestamp_millis())
}
