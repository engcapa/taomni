//! Key-check metadata and persisted MFA display preferences.
use super::schema::sql_err;
use crate::{
    models::MfaPrefs,
    validation::{MAX_GROUP, SORT_MODES, clean_text, invalid},
};
use rusqlite::{Connection, OptionalExtension, params};

pub fn meta_get(conn: &Connection, key: &str) -> Result<Option<Vec<u8>>, String> {
    conn.query_row(
        "SELECT value FROM mfa_meta WHERE key = ?1",
        params![key],
        |row| row.get(0),
    )
    .optional()
    .map_err(sql_err)
}

pub fn meta_set(conn: &Connection, key: &str, value: &[u8]) -> Result<(), String> {
    conn.execute(
        "INSERT INTO mfa_meta (key, value) VALUES (?1, ?2) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )
    .map(|_| ())
    .map_err(sql_err)
}

pub fn get_prefs(conn: &Connection) -> Result<MfaPrefs, String> {
    let mut prefs = MfaPrefs::default();
    let mut stmt = conn
        .prepare("SELECT key, value FROM mfa_prefs")
        .map_err(sql_err)?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(sql_err)?;
    for row in rows {
        let (key, value) = row.map_err(sql_err)?;
        match key.as_str() {
            "sort_mode" if SORT_MODES.contains(&value.as_str()) => prefs.sort_mode = value,
            "group_filter" => prefs.group_filter = value,
            _ => {}
        }
    }
    Ok(prefs)
}

pub fn set_prefs(conn: &mut Connection, prefs: &MfaPrefs) -> Result<(), String> {
    if !SORT_MODES.contains(&prefs.sort_mode.as_str()) {
        return Err(invalid("sortMode", "unknown sort mode"));
    }
    let group_filter = clean_text(&prefs.group_filter, "groupFilter", MAX_GROUP)?;
    let tx = conn.savepoint().map_err(sql_err)?;
    for (key, value) in [
        ("sort_mode", prefs.sort_mode.as_str()),
        ("group_filter", group_filter.as_str()),
    ] {
        tx.execute(
            "INSERT INTO mfa_prefs (key, value) VALUES (?1, ?2) \
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )
        .map_err(sql_err)?;
    }
    tx.commit().map_err(sql_err)
}
