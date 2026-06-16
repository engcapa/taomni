//! Local persistence over `lanchat.sqlite` (phase 2 onward).
//!
//! Owns the schema (profile / peers / groups / group_members / conversations /
//! messages + indexes) and the CRUD used by discovery, messaging, and the
//! command surface. Uses the bundled `rusqlite`; the connection lives behind a
//! `std::sync::Mutex` (rusqlite `Connection` is not `Sync`), separate from the
//! main `taomni.db`.
//!
//! Phase 2 implements identity bootstrap + profile read/write. Later phases add
//! peers/groups/conversations/messages helpers on the same `LanChatStore`.

use std::path::Path;
use std::sync::Mutex;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::lanchat::protocol::PresenceStatus;

/// SQLite-backed LanChat store. Single connection guarded by a mutex.
pub struct LanChatStore {
    conn: Mutex<Connection>,
}

/// This node's own profile (single row in `profile`). Avatar bytes are carried
/// to/from the frontend as base64 (`avatarBase64`); the fingerprint `avh` is
/// the first 16 hex of the avatar's sha256.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub avatar_base64: Option<String>,
    #[serde(default)]
    pub avatar_hash: Option<String>,
    #[serde(default)]
    pub signature: String,
    pub status: PresenceStatus,
    pub updated_at: i64,
}

/// First 16 hex chars of the avatar's sha256 — the `avh` TXT fingerprint.
pub fn avatar_fingerprint(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    hex::encode(digest)[..16].to_string()
}

/// Decode a base64 avatar payload, tolerating a `data:<mime>;base64,` prefix.
pub fn decode_avatar_base64(s: &str) -> Result<Vec<u8>, String> {
    let raw = match s.split_once(";base64,") {
        Some((_, b64)) => b64,
        None => s,
    };
    BASE64
        .decode(raw.trim())
        .map_err(|e| format!("invalid avatar base64: {e}"))
}

fn default_display_name() -> String {
    std::env::var("USER")
        .ok()
        .or_else(|| std::env::var("USERNAME").ok())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "Taomni 用户".to_string())
}

/// Create all LanChat tables + indexes. Idempotent (`IF NOT EXISTS`).
fn init_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS profile (
            id          TEXT PRIMARY KEY,
            name        TEXT NOT NULL,
            avatar      BLOB,
            avatar_hash TEXT,
            signature   TEXT NOT NULL DEFAULT '',
            status      TEXT NOT NULL DEFAULT 'online',
            updated_at  INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS peers (
            id          TEXT PRIMARY KEY,
            name        TEXT NOT NULL,
            avatar_hash TEXT,
            signature   TEXT NOT NULL DEFAULT '',
            last_seen   INTEGER NOT NULL DEFAULT 0,
            status      TEXT NOT NULL DEFAULT 'offline'
        );
        CREATE TABLE IF NOT EXISTS groups (
            id         TEXT PRIMARY KEY,
            name       TEXT NOT NULL,
            created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS group_members (
            group_id TEXT NOT NULL,
            node_id  TEXT NOT NULL,
            PRIMARY KEY (group_id, node_id)
        );
        CREATE TABLE IF NOT EXISTS conversations (
            id               TEXT PRIMARY KEY,
            kind             TEXT NOT NULL,
            peer_or_group_id TEXT NOT NULL,
            last_msg_at      INTEGER NOT NULL DEFAULT 0,
            unread           INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS messages (
            id         TEXT PRIMARY KEY,
            conv_id    TEXT NOT NULL,
            sender_id  TEXT NOT NULL,
            body       TEXT NOT NULL DEFAULT '',
            mentions   TEXT NOT NULL DEFAULT '',
            created_at INTEGER NOT NULL,
            state      TEXT NOT NULL DEFAULT 'sent'
        );
        CREATE INDEX IF NOT EXISTS idx_messages_conv_time
            ON messages (conv_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_conversations_last_msg
            ON conversations (last_msg_at);
        ",
    )
}

impl LanChatStore {
    /// Open (creating if needed) the `lanchat.sqlite` file and ensure schema.
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        let conn = Connection::open(path)?;
        // WAL keeps reads non-blocking during the frequent message writes.
        let _ = conn.pragma_update(None, "journal_mode", "WAL");
        init_schema(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    #[cfg(test)]
    fn open_in_memory() -> rusqlite::Result<Self> {
        let conn = Connection::open_in_memory()?;
        init_schema(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// Return this node's stable id, generating + persisting a default profile
    /// row on first launch. Idempotent: later calls return the same id.
    pub fn ensure_identity(&self) -> rusqlite::Result<String> {
        let conn = self.conn.lock().unwrap();
        let existing: Option<String> = conn
            .query_row("SELECT id FROM profile LIMIT 1", [], |r| r.get(0))
            .optional()?;
        if let Some(id) = existing {
            return Ok(id);
        }
        let id = uuid::Uuid::new_v4().to_string();
        let now = chrono::Utc::now().timestamp_millis();
        conn.execute(
            "INSERT INTO profile (id, name, avatar, avatar_hash, signature, status, updated_at)
             VALUES (?1, ?2, NULL, NULL, '', ?3, ?4)",
            params![id, default_display_name(), PresenceStatus::Online.as_txt(), now],
        )?;
        Ok(id)
    }

    /// Read this node's profile, if the identity row exists.
    pub fn get_profile(&self) -> rusqlite::Result<Option<Profile>> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT id, name, avatar, avatar_hash, signature, status, updated_at
             FROM profile LIMIT 1",
            [],
            |r| {
                let avatar: Option<Vec<u8>> = r.get(2)?;
                let status: String = r.get(5)?;
                Ok(Profile {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    avatar_base64: avatar.map(|b| BASE64.encode(b)),
                    avatar_hash: r.get(3)?,
                    signature: r.get(4)?,
                    status: PresenceStatus::from_txt(&status),
                    updated_at: r.get(6)?,
                })
            },
        )
        .optional()
    }

    /// Update the local profile. `avatar` of `Some` replaces the image and
    /// recomputes the fingerprint; `None` leaves the existing avatar intact.
    /// Returns the updated profile.
    pub fn update_profile(
        &self,
        name: &str,
        avatar: Option<Vec<u8>>,
        signature: &str,
        status: PresenceStatus,
    ) -> rusqlite::Result<Profile> {
        let id = self.ensure_identity()?;
        let now = chrono::Utc::now().timestamp_millis();
        {
            let conn = self.conn.lock().unwrap();
            match &avatar {
                Some(bytes) => {
                    let hash = avatar_fingerprint(bytes);
                    conn.execute(
                        "UPDATE profile
                         SET name=?1, avatar=?2, avatar_hash=?3, signature=?4, status=?5, updated_at=?6
                         WHERE id=?7",
                        params![name, bytes, hash, signature, status.as_txt(), now, id],
                    )?;
                }
                None => {
                    conn.execute(
                        "UPDATE profile
                         SET name=?1, signature=?2, status=?3, updated_at=?4
                         WHERE id=?5",
                        params![name, signature, status.as_txt(), now, id],
                    )?;
                }
            }
        }
        Ok(self
            .get_profile()?
            .expect("profile row exists immediately after update"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_is_stable_across_calls() {
        let store = LanChatStore::open_in_memory().unwrap();
        let a = store.ensure_identity().unwrap();
        let b = store.ensure_identity().unwrap();
        assert_eq!(a, b, "node id must be stable");
        assert!(!a.is_empty());
    }

    #[test]
    fn default_profile_present_after_ensure() {
        let store = LanChatStore::open_in_memory().unwrap();
        let id = store.ensure_identity().unwrap();
        let p = store.get_profile().unwrap().expect("profile present");
        assert_eq!(p.id, id);
        assert!(!p.name.is_empty());
        assert_eq!(p.status, PresenceStatus::Online);
        assert!(p.avatar_base64.is_none());
    }

    #[test]
    fn update_profile_changes_fields_and_avatar_fingerprint() {
        let store = LanChatStore::open_in_memory().unwrap();
        store.ensure_identity().unwrap();

        let p1 = store
            .update_profile("赵敏", Some(b"img-one".to_vec()), "设计即沟通", PresenceStatus::Busy)
            .unwrap();
        assert_eq!(p1.name, "赵敏");
        assert_eq!(p1.signature, "设计即沟通");
        assert_eq!(p1.status, PresenceStatus::Busy);
        let h1 = p1.avatar_hash.clone().expect("fingerprint set");
        assert_eq!(h1.len(), 16);

        // Different avatar content -> different fingerprint.
        let p2 = store
            .update_profile("赵敏", Some(b"img-two".to_vec()), "设计即沟通", PresenceStatus::Busy)
            .unwrap();
        assert_ne!(h1, p2.avatar_hash.unwrap(), "fingerprint tracks content");

        // None avatar -> keeps existing image + hash.
        let p3 = store
            .update_profile("林开发", None, "摸鱼中", PresenceStatus::Away)
            .unwrap();
        assert_eq!(p3.name, "林开发");
        assert!(p3.avatar_base64.is_some(), "avatar retained when None passed");
    }

    #[test]
    fn avatar_fingerprint_is_deterministic_16_hex() {
        let h = avatar_fingerprint(b"hello");
        assert_eq!(h.len(), 16);
        assert_eq!(h, avatar_fingerprint(b"hello"));
        assert!(h.chars().all(|c| c.is_ascii_hexdigit()));
    }
}
