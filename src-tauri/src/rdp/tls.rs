//! Core-owned persistence for the RDP client certificate decisions.

use rusqlite::{Connection, OptionalExtension, params};

pub(super) use taomni_rdp_client_api::normalize_fingerprint;

const TRUST_TABLE: &str = "rdp_certificate_pins";

pub fn init_trust_table(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS rdp_certificate_pins (
            endpoint TEXT PRIMARY KEY,
            fingerprint TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );",
    )
}

pub fn load_pin(conn: &Connection, host: &str, port: u16) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        &format!("SELECT fingerprint FROM {TRUST_TABLE} WHERE endpoint = ?1"),
        params![endpoint_key(host, port)],
        |row| row.get(0),
    )
    .optional()
}

pub fn save_pin(
    conn: &Connection,
    host: &str,
    port: u16,
    fingerprint: &str,
) -> Result<String, String> {
    let fingerprint = normalize_fingerprint(fingerprint)?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0);
    conn.execute(
        &format!(
            "INSERT OR REPLACE INTO {TRUST_TABLE} (endpoint, fingerprint, updated_at) \
             VALUES (?1, ?2, ?3)"
        ),
        params![endpoint_key(host, port), fingerprint, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(fingerprint)
}

fn endpoint_key(host: &str, port: u16) -> String {
    format!(
        "{}:{port}",
        host.trim().trim_end_matches('.').to_ascii_lowercase()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trust_store_keys_are_host_case_insensitive() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        super::init_trust_table(&conn).unwrap();
        let fingerprint = "ab".repeat(32);
        save_pin(&conn, "RDP.EXAMPLE.COM.", 3389, &fingerprint).unwrap();
        assert_eq!(
            load_pin(&conn, "rdp.example.com", 3389).unwrap().as_deref(),
            Some(fingerprint.as_str())
        );
    }
}
