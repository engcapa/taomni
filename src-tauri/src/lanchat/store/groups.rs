use super::lifetime::LanChatStore;
use super::model::Group;
use rusqlite::OptionalExtension;
use rusqlite::params;

impl LanChatStore {
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
