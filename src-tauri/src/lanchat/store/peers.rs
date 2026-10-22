use super::lifetime::LanChatStore;
use crate::lanchat::protocol::PeerRecord;
use crate::lanchat::protocol::PresenceStatus;
use rusqlite::OptionalExtension;
use rusqlite::params;

impl LanChatStore {
    /// Drop the cached peer roster (used on identity migration: every peer's id
    /// changes network-wide under the hard cutover, so the cache is stale).
    pub fn clear_peers(&self) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM peers", [])?;
        Ok(())
    }

    /// The pinned certificate DER for a peer id (trust-on-first-use record), if
    /// one has been recorded.
    pub fn get_pin(&self, node_id: &str) -> rusqlite::Result<Option<Vec<u8>>> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT cert_der FROM pinned_keys WHERE node_id = ?1",
            params![node_id],
            |r| r.get::<_, Vec<u8>>(0),
        )
        .optional()
    }

    /// Record a peer's certificate on first sight (TOFU). No-op if already pinned.
    pub fn set_pin(&self, node_id: &str, cert_der: &[u8], now: i64) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO pinned_keys (node_id, cert_der, first_seen, last_seen)
             VALUES (?1, ?2, ?3, ?3)
             ON CONFLICT(node_id) DO UPDATE SET last_seen = ?3",
            params![node_id, cert_der, now],
        )?;
        Ok(())
    }

    /// Forget a pinned peer (so the next connection re-pins via TOFU). Used by the
    /// "re-trust" command after a peer legitimately reinstalled.
    pub fn clear_pin(&self, node_id: &str) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM pinned_keys WHERE node_id = ?1",
            params![node_id],
        )?;
        Ok(())
    }

    /// All pinned peers as `(node_id, first_seen, last_seen)`, newest first. For
    /// the security/identity view in the UI.
    pub fn list_pins(&self) -> rusqlite::Result<Vec<(String, i64, i64)>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT node_id, first_seen, last_seen FROM pinned_keys ORDER BY last_seen DESC",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
        rows.collect()
    }

    /// Upsert a discovered peer into the `peers` cache.
    pub fn store_peer(&self, p: &PeerRecord) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO peers (id, name, avatar_hash, signature, last_seen, status, addr, port)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(id) DO UPDATE SET
               name=?2, avatar_hash=?3, signature=?4, last_seen=?5, status=?6,
               addr=COALESCE(?7, addr), port=COALESCE(?8, port)",
            params![
                p.id,
                p.name,
                p.avatar_hash,
                p.signature,
                p.last_seen,
                p.status.as_txt(),
                p.addr,
                p.port.map(|v| v as i64)
            ],
        )?;
        Ok(())
    }

    /// Mark a cached peer offline (kept in the cache for last-seen history).
    pub fn mark_peer_offline(&self, id: &str) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE peers SET status = 'offline' WHERE id = ?1",
            params![id],
        )?;
        Ok(())
    }

    /// Load every cached peer, including offline peers kept for display names
    /// and last-seen history.
    pub fn list_peers(&self) -> rusqlite::Result<Vec<PeerRecord>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, name, avatar_hash, signature, last_seen, status, addr, port
             FROM peers
             ORDER BY lower(name), last_seen DESC",
        )?;
        let rows = stmt.query_map([], |r| {
            let status_str: String = r.get(5)?;
            let port_val: Option<i64> = r.get(7)?;
            Ok(PeerRecord {
                id: r.get(0)?,
                name: r.get(1)?,
                avatar_hash: r.get(2)?,
                signature: r.get::<_, Option<String>>(3)?.unwrap_or_default(),
                last_seen: r.get(4)?,
                status: PresenceStatus::from_txt(&status_str),
                addr: r.get(6)?,
                port: port_val.and_then(|v| u16::try_from(v).ok()),
            })
        })?;
        rows.collect()
    }

    /// Load peers seen within `since_ms` milliseconds, with known addr+port.
    /// Used at startup to attempt reconnection to previously known peers.
    pub fn list_recent_peers(&self, since_ms: i64) -> Vec<PeerRecord> {
        let conn = self.conn.lock().unwrap();
        let cutoff = chrono::Utc::now().timestamp_millis() - since_ms;
        let mut stmt = conn
            .prepare(
                "SELECT id, name, avatar_hash, signature, last_seen, status, addr, port
                 FROM peers
                 WHERE last_seen > ?1 AND addr IS NOT NULL AND port IS NOT NULL
                 ORDER BY last_seen DESC",
            )
            .unwrap();
        stmt.query_map(params![cutoff], |r| {
            let status_str: String = r.get(5)?;
            let port_val: Option<i64> = r.get(7)?;
            Ok(PeerRecord {
                id: r.get(0)?,
                name: r.get(1)?,
                avatar_hash: r.get(2)?,
                signature: r.get::<_, Option<String>>(3)?.unwrap_or_default(),
                last_seen: r.get(4)?,
                status: PresenceStatus::from_txt(&status_str),
                addr: r.get(6)?,
                port: port_val.and_then(|v| u16::try_from(v).ok()),
            })
        })
        .unwrap()
        .filter_map(|r| r.ok())
        .collect()
    }
}
