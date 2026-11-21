use rusqlite::{Connection, OptionalExtension};
use serde_json::Value;

pub(super) const LEGACY_DATABASE: &str = "taomni.db";
pub(super) const TABLE: &str = "server_configs";

pub(super) fn read(connection: &Connection, server_type: &str) -> Result<Option<Value>, String> {
    let exists: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?1)",
            [TABLE],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if !exists {
        return Ok(None);
    }
    let row: Option<String> = connection
        .query_row(
            "SELECT config_json FROM server_configs WHERE server_type = ?1",
            [server_type],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    row.map(|json| serde_json::from_str(&json).map_err(|error| error.to_string()))
        .transpose()
}
