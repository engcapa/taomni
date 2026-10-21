use super::lifetime::LanChatStore;
use super::model::Profile;
use crate::lanchat::protocol::PresenceStatus;
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use rusqlite::OptionalExtension;
use rusqlite::params;
use sha2::Digest;
use sha2::Sha256;

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

pub(super) fn default_display_name() -> String {
    std::env::var("USER")
        .ok()
        .or_else(|| std::env::var("USERNAME").ok())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "Taomni 用户".to_string())
}

impl LanChatStore {
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
            params![
                id,
                default_display_name(),
                PresenceStatus::Online.as_txt(),
                now
            ],
        )?;
        Ok(id)
    }

    /// Read the persisted node id and (optional) self-signed cert DER, if the
    /// identity row exists. Used by identity bootstrap (phase 1) to decide
    /// whether to reuse the stored identity or generate a fresh one.
    pub fn get_profile_id_and_cert(&self) -> rusqlite::Result<Option<(String, Option<Vec<u8>>)>> {
        let conn = self.conn.lock().unwrap();
        conn.query_row("SELECT id, cert_der FROM profile LIMIT 1", [], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, Option<Vec<u8>>>(1)?))
        })
        .optional()
    }

    /// Persist this node's self-certifying identity (node id + cert DER). When a
    /// row already exists under `old_id` it is migrated in place (the PRIMARY KEY
    /// is updated), preserving name/avatar/signature/status; otherwise a fresh
    /// default profile row is created.
    pub fn set_identity(
        &self,
        new_id: &str,
        cert_der: &[u8],
        old_id: Option<&str>,
    ) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        match old_id {
            Some(old) if old != new_id => {
                conn.execute(
                    "UPDATE profile SET id = ?1, cert_der = ?2 WHERE id = ?3",
                    params![new_id, cert_der, old],
                )?;
            }
            Some(_) => {
                conn.execute(
                    "UPDATE profile SET cert_der = ?2 WHERE id = ?1",
                    params![new_id, cert_der],
                )?;
            }
            None => {
                let now = chrono::Utc::now().timestamp_millis();
                conn.execute(
                    "INSERT INTO profile (id, name, avatar, avatar_hash, signature, status, updated_at, cert_der)
                     VALUES (?1, ?2, NULL, NULL, '', ?3, ?4, ?5)",
                    params![
                        new_id,
                        default_display_name(),
                        PresenceStatus::Online.as_txt(),
                        now,
                        cert_der
                    ],
                )?;
            }
        }
        Ok(())
    }

    /// Rewrite our own outbound messages' sender id when the node id changes
    /// (legacy UUID -> self-certifying id), so "sent by me" detection survives.
    pub fn migrate_sender_id(&self, old_id: &str, new_id: &str) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE messages SET sender_id = ?2 WHERE sender_id = ?1",
            params![old_id, new_id],
        )?;
        Ok(())
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
