use super::lifetime::LanChatStore;
use super::model::LanMessage;
use rusqlite::OptionalExtension;
use rusqlite::params;

impl LanChatStore {
    /// Map a message row to [`LanMessage`], decrypting the body when it was stored
    /// encrypted (`enc_ver >= 1`). Expects columns: id, conv_id, sender_id, body,
    /// mentions, created_at, state, body_cipher, enc_ver.
    pub(super) fn row_to_message(&self, r: &rusqlite::Row<'_>) -> rusqlite::Result<LanMessage> {
        let mentions_json: String = r.get(4)?;
        let mentions = serde_json::from_str::<Vec<String>>(&mentions_json).unwrap_or_default();
        let enc_ver: i64 = r.get(8)?;
        let body = if enc_ver >= 1 {
            let cipher: Option<Vec<u8>> = r.get(7)?;
            cipher.map(|c| self.decrypt_body(&c)).unwrap_or_default()
        } else {
            r.get::<_, String>(3)?
        };
        Ok(LanMessage {
            id: r.get(0)?,
            conv_id: r.get(1)?,
            sender_id: r.get(2)?,
            body,
            mentions,
            created_at: r.get(5)?,
            state: r.get(6)?,
        })
    }

    /// Insert a message (idempotent on id — duplicate deliveries are ignored).
    /// Returns true if the row was newly inserted.
    pub fn insert_message(&self, msg: &LanMessage) -> rusqlite::Result<bool> {
        let mentions = serde_json::to_string(&msg.mentions).unwrap_or_else(|_| "[]".into());
        // Encrypt the body when a key is attached; otherwise persist plaintext.
        let (body_plain, body_cipher, enc_ver): (String, Option<Vec<u8>>, i64) =
            match self.encrypt_body(&msg.body) {
                Some(ct) => (String::new(), Some(ct), 1),
                None => (msg.body.clone(), None, 0),
            };
        let conn = self.conn.lock().unwrap();
        let changed = conn.execute(
            "INSERT INTO messages (id, conv_id, sender_id, body, mentions, created_at, state, body_cipher, enc_ver)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(id) DO NOTHING",
            params![
                msg.id,
                msg.conv_id,
                msg.sender_id,
                body_plain,
                mentions,
                msg.created_at,
                msg.state,
                body_cipher,
                enc_ver
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
            "SELECT id, conv_id, sender_id, body, mentions, created_at, state, body_cipher, enc_ver
             FROM messages WHERE id = ?1",
            params![id],
            |r| self.row_to_message(r),
        )
        .optional()
    }

    /// Recent messages for a conversation, oldest-first (last `limit`).
    pub fn list_messages(&self, conv_id: &str, limit: i64) -> rusqlite::Result<Vec<LanMessage>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, conv_id, sender_id, body, mentions, created_at, state, body_cipher, enc_ver FROM (
                 SELECT * FROM messages WHERE conv_id = ?1 ORDER BY created_at DESC LIMIT ?2
             ) ORDER BY created_at ASC",
        )?;
        let rows = stmt.query_map(params![conv_id, limit], |r| self.row_to_message(r))?;
        rows.collect()
    }
}
