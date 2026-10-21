use super::model::SnapshotEntry;
use super::validation::is_recoverable_saved_session_type;
use rusqlite::Connection;

/// Legacy single-entry candidate from `sessions.last_connected_at` (design
/// §4.2.1): the most recent positive timestamp, ties by `id` byte order,
/// recoverable types only. This is "the most recently opened *config*",
/// explicitly not a claim of a successful connection.
pub(super) fn legacy_candidate(conn: &Connection) -> Option<SnapshotEntry> {
    let rows: Vec<(String, String, String, i64)> = {
        let mut stmt = conn
            .prepare(
                "SELECT id, name, session_type, last_connected_at FROM sessions
                 WHERE last_connected_at IS NOT NULL AND last_connected_at > 0
                 ORDER BY last_connected_at DESC, id ASC
                 LIMIT 50",
            )
            .ok()?;
        let mapped = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            })
            .ok()?;
        mapped.collect::<Result<Vec<_>, _>>().ok()?
    };
    for (id, name, session_type, _ts) in rows {
        if !is_recoverable_saved_session_type(&session_type) {
            continue;
        }
        return Some(SnapshotEntry::SavedSession {
            identity: format!("saved:{id}"),
            saved_session_id: id,
            saved_session_type: session_type,
            display_name: name,
        });
    }
    None
}
