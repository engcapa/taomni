use super::lifetime::LanChatStore;
use super::model::RetentionSettings;
use rusqlite::params;

impl LanChatStore {
    /// Read the message-retention policy.
    pub fn get_retention(&self) -> rusqlite::Result<RetentionSettings> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT retention_days, max_per_conv, cleanup_enabled FROM settings WHERE id = 1",
            [],
            |r| {
                Ok(RetentionSettings {
                    retention_days: r.get(0)?,
                    max_per_conv: r.get(1)?,
                    cleanup_enabled: r.get::<_, i64>(2)? != 0,
                })
            },
        )
    }

    /// Update the message-retention policy.
    pub fn set_retention(&self, s: &RetentionSettings) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO settings (id, retention_days, max_per_conv, cleanup_enabled)
             VALUES (1, ?1, ?2, ?3)
             ON CONFLICT(id) DO UPDATE SET
               retention_days = ?1, max_per_conv = ?2, cleanup_enabled = ?3",
            params![
                s.retention_days,
                s.max_per_conv,
                if s.cleanup_enabled { 1 } else { 0 }
            ],
        )?;
        Ok(())
    }

    /// Read the "start LanChat service on app launch" policy.
    pub fn get_start_on_launch(&self) -> rusqlite::Result<bool> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT start_on_launch FROM settings WHERE id = 1",
            [],
            |r| Ok(r.get::<_, i64>(0)? != 0),
        )
    }

    /// Update the "start LanChat service on app launch" policy.
    pub fn set_start_on_launch(&self, enabled: bool) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO settings (id, start_on_launch) VALUES (1, ?1)
             ON CONFLICT(id) DO UPDATE SET start_on_launch = ?1",
            params![if enabled { 1 } else { 0 }],
        )?;
        Ok(())
    }

    /// Apply the retention policy: delete messages older than `retention_days`
    /// and trim each conversation to its newest `max_per_conv`. A cap of 0
    /// disables that dimension. Returns the number of rows deleted.
    pub fn apply_retention(&self) -> rusqlite::Result<usize> {
        let s = self.get_retention()?;
        if !s.cleanup_enabled {
            return Ok(0);
        }
        let conn = self.conn.lock().unwrap();
        let mut deleted = 0usize;
        if s.retention_days > 0 {
            let cutoff = chrono::Utc::now().timestamp_millis() - s.retention_days * 86_400_000;
            deleted += conn.execute(
                "DELETE FROM messages WHERE created_at < ?1",
                params![cutoff],
            )?;
        }
        if s.max_per_conv > 0 {
            deleted += conn.execute(
                "DELETE FROM messages WHERE id IN (
                     SELECT id FROM (
                         SELECT id, ROW_NUMBER() OVER (
                             PARTITION BY conv_id ORDER BY created_at DESC
                         ) AS rn FROM messages
                     ) WHERE rn > ?1
                 )",
                params![s.max_per_conv],
            )?;
        }
        Ok(deleted)
    }

    /// Delete a single message by id.
    pub fn delete_message(&self, id: &str) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM messages WHERE id = ?1", params![id])?;
        Ok(())
    }

    /// Delete all messages in a conversation and reset its counters.
    pub fn clear_conversation(&self, conv_id: &str) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM messages WHERE conv_id = ?1", params![conv_id])?;
        conn.execute(
            "UPDATE conversations SET unread = 0, last_msg_at = 0 WHERE id = ?1",
            params![conv_id],
        )?;
        Ok(())
    }

    /// Delete all message history across every conversation.
    pub fn clear_all_history(&self) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM messages", [])?;
        conn.execute("UPDATE conversations SET unread = 0, last_msg_at = 0", [])?;
        Ok(())
    }

    /// Reclaim disk space after large deletions.
    pub fn vacuum(&self) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("VACUUM", [])?;
        Ok(())
    }
}
