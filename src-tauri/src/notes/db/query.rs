use super::identity::DEFAULT_DUE_SOON_SECS;
use super::identity::now;
use super::model::NoteItem;
use super::model::NoteQuery;
use super::rows::NOTE_COLUMNS;
use super::rows::row_to_note;
use super::steps::load_steps_for;
use super::tags::load_tags_for;
use rusqlite::Connection;
use rusqlite::Result as SqlResult;

// ---------------------------------------------------------------------------
// Listing / search / filter
// ---------------------------------------------------------------------------

/// Local calendar-day bounds (start inclusive, end exclusive) around `ts`.
pub(super) fn local_day_bounds(ts: i64) -> (i64, i64) {
    use chrono::{Local, TimeZone};
    let dt = Local
        .timestamp_opt(ts, 0)
        .single()
        .unwrap_or_else(Local::now);
    let start_date = dt.date_naive();
    let start = start_date
        .and_hms_opt(0, 0, 0)
        .and_then(|nd| Local.from_local_datetime(&nd).single())
        .map(|d| d.timestamp())
        .unwrap_or(ts);
    (start, start + 86_400)
}

pub(super) fn note_filter_condition(
    filter: &str,
    now_ts: i64,
    due_soon: i64,
    sql_params: &mut Vec<Box<dyn rusqlite::ToSql>>,
) -> String {
    match filter {
        "all" => "archived_at IS NULL".into(),
        "pinned" => "archived_at IS NULL AND pinned = 1".into(),
        "completed" => "archived_at IS NULL AND completed_at IS NOT NULL".into(),
        "archived" => "archived_at IS NOT NULL".into(),
        "today" => {
            let (start, end) = local_day_bounds(now_ts);
            sql_params.push(Box::new(start));
            sql_params.push(Box::new(end));
            "archived_at IS NULL AND completed_at IS NULL AND due_at IS NOT NULL \
             AND due_at >= ?p AND due_at < ?p"
                .into()
        }
        "due_soon" => {
            sql_params.push(Box::new(now_ts));
            sql_params.push(Box::new(now_ts + due_soon));
            "archived_at IS NULL AND completed_at IS NULL AND due_at IS NOT NULL \
             AND due_at > ?p AND due_at <= ?p"
                .into()
        }
        "overdue" => {
            sql_params.push(Box::new(now_ts));
            "archived_at IS NULL AND completed_at IS NULL AND due_at IS NOT NULL \
             AND due_at <= ?p"
                .into()
        }
        // "recent_incomplete" (default), and the legacy "tag" pseudo-filter.
        _ => "archived_at IS NULL AND completed_at IS NULL".into(),
    }
}

pub fn list_notes(conn: &Connection, query: &NoteQuery) -> SqlResult<Vec<NoteItem>> {
    let filters = query
        .filters
        .as_ref()
        .filter(|values| !values.is_empty())
        .cloned()
        .unwrap_or_else(|| {
            vec![
                query
                    .filter
                    .clone()
                    .unwrap_or_else(|| "recent_incomplete".into()),
            ]
        });
    let now_ts = query.now.unwrap_or_else(now);
    let due_soon = query.due_soon_secs.unwrap_or(DEFAULT_DUE_SOON_SECS);

    let mut where_parts: Vec<String> = Vec::new();
    let mut sql_params: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

    let filter_parts = filters
        .iter()
        .map(|filter| {
            format!(
                "({})",
                note_filter_condition(filter, now_ts, due_soon, &mut sql_params)
            )
        })
        .collect::<Vec<_>>();
    where_parts.push(format!("({})", filter_parts.join(" OR ")));

    if let Some(tag_id) = query.tag_id.as_deref().filter(|s| !s.is_empty()) {
        where_parts.push("id IN (SELECT note_id FROM note_tag_links WHERE tag_id = ?p)".into());
        sql_params.push(Box::new(tag_id.to_string()));
    }

    if let Some(search) = query
        .search
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let like = format!("%{}%", search.replace('%', "\\%").replace('_', "\\_"));
        where_parts.push(
            "(title LIKE ?p ESCAPE '\\' OR body LIKE ?p ESCAPE '\\' OR id IN (\
                SELECT l.note_id FROM note_tag_links l JOIN note_tags t ON t.id = l.tag_id \
                WHERE t.name LIKE ?p ESCAPE '\\'))"
                .into(),
        );
        sql_params.push(Box::new(like.clone()));
        sql_params.push(Box::new(like.clone()));
        sql_params.push(Box::new(like));
    }

    let where_sql = if where_parts.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", where_parts.join(" AND "))
    };

    // Sort: pinned desc, due_at asc (nulls last), updated_at desc.
    let order_sql = "ORDER BY pinned DESC, (due_at IS NULL) ASC, due_at ASC, updated_at DESC";
    let limit_sql = match query.limit {
        Some(l) if l >= 0 => format!("LIMIT {} OFFSET {}", l, query.offset.unwrap_or(0).max(0)),
        _ => String::new(),
    };

    // Bind positional params in order by replacing sequential "?p" markers.
    let mut sql = format!("SELECT {NOTE_COLUMNS} FROM notes {where_sql} {order_sql} {limit_sql}");
    let mut idx = 0;
    while let Some(pos) = sql.find("?p") {
        idx += 1;
        sql.replace_range(pos..pos + 2, &format!("?{idx}"));
    }

    let param_refs: Vec<&dyn rusqlite::ToSql> = sql_params.iter().map(|b| b.as_ref()).collect();
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(param_refs.as_slice(), row_to_note)?;
    let mut notes: Vec<NoteItem> = rows.collect::<SqlResult<Vec<_>>>()?;

    // Batch-load steps and tags for the returned notes.
    for note in &mut notes {
        note.steps = load_steps_for(conn, &note.id)?;
        note.tags = load_tags_for(conn, &note.id)?;
    }
    Ok(notes)
}
