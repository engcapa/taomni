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

use crate::lanchat::protocol::{PeerRecord, PresenceStatus};

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

/// A conversation (direct with a peer, or a group). For direct chats the id is
/// deterministic (`direct:<otherNodeId>`) so both peers map to a stable thread.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub id: String,
    /// "direct" | "group".
    pub kind: String,
    /// Peer node id (direct) or group id (group).
    pub peer_or_group_id: String,
    pub last_msg_at: i64,
    pub unread: i64,
}

/// A chat message. `mentions` is a list of node ids; persisted as a JSON array.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LanMessage {
    pub id: String,
    pub conv_id: String,
    pub sender_id: String,
    pub body: String,
    #[serde(default)]
    pub mentions: Vec<String>,
    pub created_at: i64,
    /// "sending" | "sent" | "delivered" | "failed".
    pub state: String,
}

/// Stable conversation id for a direct chat with `peer_id`.
pub fn direct_conv_id(peer_id: &str) -> String {
    format!("direct:{peer_id}")
}

/// Stable conversation id for a group/channel.
pub fn group_conv_id(group_id: &str) -> String {
    format!("group:{group_id}")
}

/// A named group / channel and its current member node ids.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    pub id: String,
    pub name: String,
    pub created_at: i64,
    #[serde(default)]
    pub members: Vec<String>,
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

    /// Upsert a discovered peer into the `peers` cache.
    pub fn store_peer(&self, p: &PeerRecord) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO peers (id, name, avatar_hash, signature, last_seen, status)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(id) DO UPDATE SET
               name=?2, avatar_hash=?3, signature=?4, last_seen=?5, status=?6",
            params![
                p.id,
                p.name,
                p.avatar_hash,
                p.signature,
                p.last_seen,
                p.status.as_txt()
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

    /// Ensure a conversation row exists, returning it. `kind` is "direct" or
    /// "group"; `peer_or_group_id` is the peer node id or group id.
    pub fn ensure_conversation(
        &self,
        id: &str,
        kind: &str,
        peer_or_group_id: &str,
    ) -> rusqlite::Result<Conversation> {
        {
            let conn = self.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO conversations (id, kind, peer_or_group_id, last_msg_at, unread)
                 VALUES (?1, ?2, ?3, 0, 0)
                 ON CONFLICT(id) DO NOTHING",
                params![id, kind, peer_or_group_id],
            )?;
        }
        Ok(self
            .get_conversation(id)?
            .expect("conversation exists after ensure"))
    }

    /// Read a conversation by id.
    pub fn get_conversation(&self, id: &str) -> rusqlite::Result<Option<Conversation>> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT id, kind, peer_or_group_id, last_msg_at, unread
             FROM conversations WHERE id = ?1",
            params![id],
            |r| {
                Ok(Conversation {
                    id: r.get(0)?,
                    kind: r.get(1)?,
                    peer_or_group_id: r.get(2)?,
                    last_msg_at: r.get(3)?,
                    unread: r.get(4)?,
                })
            },
        )
        .optional()
    }

    /// All conversations, most-recently-active first.
    pub fn list_conversations(&self) -> rusqlite::Result<Vec<Conversation>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, kind, peer_or_group_id, last_msg_at, unread
             FROM conversations ORDER BY last_msg_at DESC",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(Conversation {
                id: r.get(0)?,
                kind: r.get(1)?,
                peer_or_group_id: r.get(2)?,
                last_msg_at: r.get(3)?,
                unread: r.get(4)?,
            })
        })?;
        rows.collect()
    }

    /// Insert a message (idempotent on id — duplicate deliveries are ignored).
    /// Returns true if the row was newly inserted.
    pub fn insert_message(&self, msg: &LanMessage) -> rusqlite::Result<bool> {
        let mentions = serde_json::to_string(&msg.mentions).unwrap_or_else(|_| "[]".into());
        let conn = self.conn.lock().unwrap();
        let changed = conn.execute(
            "INSERT INTO messages (id, conv_id, sender_id, body, mentions, created_at, state)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(id) DO NOTHING",
            params![
                msg.id,
                msg.conv_id,
                msg.sender_id,
                msg.body,
                mentions,
                msg.created_at,
                msg.state
            ],
        )?;
        Ok(changed > 0)
    }

    /// Update a message's delivery state ("sending"/"sent"/"delivered"/"failed").
    pub fn set_message_state(&self, id: &str, state: &str) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE messages SET state = ?2 WHERE id = ?1",
            params![id, state],
        )?;
        Ok(())
    }

    /// Read a single message by id.
    pub fn get_message(&self, id: &str) -> rusqlite::Result<Option<LanMessage>> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT id, conv_id, sender_id, body, mentions, created_at, state
             FROM messages WHERE id = ?1",
            params![id],
            row_to_message,
        )
        .optional()
    }

    /// Recent messages for a conversation, oldest-first (last `limit`).
    pub fn list_messages(&self, conv_id: &str, limit: i64) -> rusqlite::Result<Vec<LanMessage>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, conv_id, sender_id, body, mentions, created_at, state FROM (
                 SELECT * FROM messages WHERE conv_id = ?1 ORDER BY created_at DESC LIMIT ?2
             ) ORDER BY created_at ASC",
        )?;
        let rows = stmt.query_map(params![conv_id, limit], row_to_message)?;
        rows.collect()
    }

    /// Bump a conversation's last-activity time and optionally its unread count.
    pub fn touch_conversation(
        &self,
        conv_id: &str,
        last_msg_at: i64,
        unread_delta: i64,
    ) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE conversations
             SET last_msg_at = MAX(last_msg_at, ?2), unread = MAX(0, unread + ?3)
             WHERE id = ?1",
            params![conv_id, last_msg_at, unread_delta],
        )?;
        Ok(())
    }

    /// Clear a conversation's unread counter (message opened/read).
    pub fn reset_unread(&self, conv_id: &str) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE conversations SET unread = 0 WHERE id = ?1",
            params![conv_id],
        )?;
        Ok(())
    }

    /// Create or rename a group.
    pub fn upsert_group(&self, id: &str, name: &str) -> rusqlite::Result<()> {
        let now = chrono::Utc::now().timestamp_millis();
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO groups (id, name, created_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(id) DO UPDATE SET name = ?2",
            params![id, name, now],
        )?;
        Ok(())
    }

    /// Add a member to a group (idempotent).
    pub fn add_group_member(&self, group_id: &str, node_id: &str) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO group_members (group_id, node_id) VALUES (?1, ?2)
             ON CONFLICT(group_id, node_id) DO NOTHING",
            params![group_id, node_id],
        )?;
        Ok(())
    }

    /// Remove a member from a group.
    pub fn remove_group_member(&self, group_id: &str, node_id: &str) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM group_members WHERE group_id = ?1 AND node_id = ?2",
            params![group_id, node_id],
        )?;
        Ok(())
    }

    /// Member node ids of a group.
    pub fn list_group_members(&self, group_id: &str) -> rusqlite::Result<Vec<String>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt =
            conn.prepare("SELECT node_id FROM group_members WHERE group_id = ?1 ORDER BY node_id")?;
        let rows = stmt.query_map(params![group_id], |r| r.get::<_, String>(0))?;
        rows.collect()
    }

    /// Read a group (with its members).
    pub fn get_group(&self, id: &str) -> rusqlite::Result<Option<Group>> {
        let row = {
            let conn = self.conn.lock().unwrap();
            conn.query_row(
                "SELECT id, name, created_at FROM groups WHERE id = ?1",
                params![id],
                |r| {
                    Ok(Group {
                        id: r.get(0)?,
                        name: r.get(1)?,
                        created_at: r.get(2)?,
                        members: vec![],
                    })
                },
            )
            .optional()?
        };
        match row {
            Some(mut g) => {
                g.members = self.list_group_members(id)?;
                Ok(Some(g))
            }
            None => Ok(None),
        }
    }

    /// All groups (with members), newest first.
    pub fn list_groups(&self) -> rusqlite::Result<Vec<Group>> {
        let ids: Vec<String> = {
            let conn = self.conn.lock().unwrap();
            let mut stmt = conn.prepare("SELECT id FROM groups ORDER BY created_at DESC")?;
            let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
            rows.collect::<rusqlite::Result<Vec<String>>>()?
        };
        let mut out = Vec::with_capacity(ids.len());
        for id in ids {
            if let Some(g) = self.get_group(&id)? {
                out.push(g);
            }
        }
        Ok(out)
    }
}

fn row_to_message(r: &rusqlite::Row<'_>) -> rusqlite::Result<LanMessage> {
    let mentions_json: String = r.get(4)?;
    let mentions = serde_json::from_str::<Vec<String>>(&mentions_json).unwrap_or_default();
    Ok(LanMessage {
        id: r.get(0)?,
        conv_id: r.get(1)?,
        sender_id: r.get(2)?,
        body: r.get(3)?,
        mentions,
        created_at: r.get(5)?,
        state: r.get(6)?,
    })
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

    fn msg(id: &str, conv: &str, sender: &str, ts: i64, state: &str) -> LanMessage {
        LanMessage {
            id: id.into(),
            conv_id: conv.into(),
            sender_id: sender.into(),
            body: format!("body-{id}"),
            mentions: vec![],
            created_at: ts,
            state: state.into(),
        }
    }

    #[test]
    fn insert_message_is_idempotent_on_id() {
        let store = LanChatStore::open_in_memory().unwrap();
        let conv = direct_conv_id("peer-x");
        store.ensure_conversation(&conv, "direct", "peer-x").unwrap();
        assert!(store.insert_message(&msg("m1", &conv, "peer-x", 100, "delivered")).unwrap());
        // duplicate delivery -> not inserted again
        assert!(!store.insert_message(&msg("m1", &conv, "peer-x", 100, "delivered")).unwrap());
        assert_eq!(store.list_messages(&conv, 50).unwrap().len(), 1);
    }

    #[test]
    fn messages_listed_oldest_first_within_limit() {
        let store = LanChatStore::open_in_memory().unwrap();
        let conv = direct_conv_id("peer-y");
        store.ensure_conversation(&conv, "direct", "peer-y").unwrap();
        for (i, ts) in [(1, 300), (2, 100), (3, 200)] {
            store
                .insert_message(&msg(&format!("m{i}"), &conv, "me", ts, "sent"))
                .unwrap();
        }
        let got = store.list_messages(&conv, 2).unwrap();
        // last 2 by time (200, 300), returned oldest-first
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].created_at, 200);
        assert_eq!(got[1].created_at, 300);
    }

    #[test]
    fn conversation_unread_increments_and_resets() {
        let store = LanChatStore::open_in_memory().unwrap();
        let conv = direct_conv_id("peer-z");
        store.ensure_conversation(&conv, "direct", "peer-z").unwrap();
        store.touch_conversation(&conv, 500, 1).unwrap();
        store.touch_conversation(&conv, 600, 1).unwrap();
        let c = store.get_conversation(&conv).unwrap().unwrap();
        assert_eq!(c.unread, 2);
        assert_eq!(c.last_msg_at, 600);
        store.reset_unread(&conv).unwrap();
        assert_eq!(store.get_conversation(&conv).unwrap().unwrap().unread, 0);
    }

    #[test]
    fn message_state_transitions() {
        let store = LanChatStore::open_in_memory().unwrap();
        let conv = direct_conv_id("peer-s");
        store.ensure_conversation(&conv, "direct", "peer-s").unwrap();
        store.insert_message(&msg("ms", &conv, "me", 1, "sending")).unwrap();
        store.set_message_state("ms", "delivered").unwrap();
        assert_eq!(store.get_message("ms").unwrap().unwrap().state, "delivered");
    }

    #[test]
    fn group_membership_crud() {
        let store = LanChatStore::open_in_memory().unwrap();
        store.upsert_group("g1", "研发大群").unwrap();
        store.add_group_member("g1", "me").unwrap();
        store.add_group_member("g1", "zhao").unwrap();
        store.add_group_member("g1", "zhao").unwrap(); // idempotent
        let g = store.get_group("g1").unwrap().unwrap();
        assert_eq!(g.name, "研发大群");
        assert_eq!(g.members.len(), 2);
        store.remove_group_member("g1", "zhao").unwrap();
        assert_eq!(store.get_group("g1").unwrap().unwrap().members, vec!["me"]);
        // rename via upsert
        store.upsert_group("g1", "前端小队").unwrap();
        assert_eq!(store.get_group("g1").unwrap().unwrap().name, "前端小队");
        assert_eq!(store.list_groups().unwrap().len(), 1);
    }
}
