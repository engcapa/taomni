use super::identity::now;
use rusqlite::Connection;
use rusqlite::Result as SqlResult;
use rusqlite::params;
use std::collections::HashMap;

// ---------------------------------------------------------------------------
// Prefs
// ---------------------------------------------------------------------------

pub fn get_prefs(conn: &Connection) -> SqlResult<HashMap<String, String>> {
    let mut stmt = conn.prepare("SELECT key, value_json FROM note_prefs")?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    let mut map = HashMap::new();
    for row in rows {
        let (k, v) = row?;
        map.insert(k, v);
    }
    Ok(map)
}

pub fn set_prefs(conn: &Connection, prefs: &HashMap<String, String>) -> SqlResult<()> {
    let ts = now();
    for (k, v) in prefs {
        conn.execute(
            "INSERT INTO note_prefs (key, value_json, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET value_json = ?2, updated_at = ?3",
            params![k, v, ts],
        )?;
    }
    Ok(())
}
