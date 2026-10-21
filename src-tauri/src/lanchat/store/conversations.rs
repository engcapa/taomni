use super::lifetime::LanChatStore;
use super::model::Conversation;
use rusqlite::OptionalExtension;
use rusqlite::params;

impl LanChatStore {
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
}
