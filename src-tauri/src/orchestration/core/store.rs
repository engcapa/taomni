use super::model::*;
use rusqlite::{Connection, OptionalExtension, params};
use std::path::Path;

pub struct Store {
    db: Connection,
}
impl Store {
    pub fn open(path: &Path) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let db = Connection::open(path).map_err(|e| e.to_string())?;
        Self::from_connection(db)
    }
    pub fn from_connection(db: Connection) -> Result<Self, String> {
        let version: u32 = db
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .map_err(|e| e.to_string())?;
        if version > 1 {
            return Err("SCHEMA_TOO_NEW: orchestration database requires a newer app".into());
        }
        db.execute_batch("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
            BEGIN IMMEDIATE;
            CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,command_id TEXT NOT NULL UNIQUE,revision INTEGER NOT NULL,status TEXT NOT NULL,data TEXT NOT NULL,created_at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS tasks(id TEXT NOT NULL,run_id TEXT NOT NULL REFERENCES runs(id),status TEXT NOT NULL,PRIMARY KEY(run_id,id));
            CREATE TABLE IF NOT EXISTS attempts(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id),state TEXT NOT NULL,owner TEXT NOT NULL);
            CREATE UNIQUE INDEX IF NOT EXISTS one_live_attempt ON attempts(run_id) WHERE state IN ('reserved','running','stopping','unknown');
            CREATE TABLE IF NOT EXISTS artifacts(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id),item_id TEXT NOT NULL,hash TEXT NOT NULL,data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS events(run_id TEXT NOT NULL REFERENCES runs(id),sequence INTEGER NOT NULL,kind TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(run_id,sequence));
            CREATE TABLE IF NOT EXISTS context_bundles(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id),digest TEXT NOT NULL,data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS inference_packs(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id),manifest TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS request_ledger(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id),attempt_id TEXT NOT NULL REFERENCES attempts(id),kind TEXT NOT NULL,state TEXT NOT NULL);
            PRAGMA user_version=1;
            COMMIT;").map_err(|e| e.to_string())?;
        Ok(Self { db })
    }
    pub fn list(&self) -> Result<Vec<AgentRun>, String> {
        let mut query = self
            .db
            .prepare("SELECT data FROM runs ORDER BY created_at DESC LIMIT 200")
            .map_err(|e| e.to_string())?;
        let rows = query
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.map(|row| {
            serde_json::from_str(&row.map_err(|e| e.to_string())?).map_err(|e| e.to_string())
        })
        .collect()
    }
    pub fn get(&self, id: &str) -> Result<AgentRun, String> {
        let text: String = self
            .db
            .query_row("SELECT data FROM runs WHERE id=?1", [id], |r| r.get(0))
            .map_err(|_| "RUN_NOT_FOUND")?;
        serde_json::from_str(&text).map_err(|e| e.to_string())
    }
    pub fn by_command(&self, command: &str) -> Result<Option<AgentRun>, String> {
        let text: Option<String> = self
            .db
            .query_row(
                "SELECT data FROM runs WHERE command_id=?1",
                [command],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        text.map(|t| serde_json::from_str(&t).map_err(|e| e.to_string()))
            .transpose()
    }
    pub fn insert(&mut self, command: &str, run: &AgentRun) -> Result<(), String> {
        let tx = self.db.transaction().map_err(|e| e.to_string())?;
        tx.execute(
            "INSERT INTO runs VALUES(?1,?2,?3,?4,?5,?6)",
            params![
                run.id,
                command,
                sql_integer(run.revision)?,
                run.status,
                serde_json::to_string(run).map_err(|e| e.to_string())?,
                sql_integer(run.created_at)?
            ],
        )
        .map_err(|e| e.to_string())?;
        for task in &run.tasks {
            tx.execute(
                "INSERT INTO tasks VALUES(?1,?2,?3)",
                params![task.id, run.id, task.status],
            )
            .map_err(|e| e.to_string())?;
        }
        let sources = serde_json::to_string(&run.sources).map_err(|e| e.to_string())?;
        tx.execute(
            "INSERT INTO context_bundles VALUES(?1,?2,?3,?4)",
            params![run.id, run.id, digest(sources.as_bytes()), sources],
        )
        .map_err(|e| e.to_string())?;
        tx.execute(
            "INSERT INTO inference_packs VALUES(?1,?2,?3)",
            params![
                run.id,
                run.id,
                serde_json::to_string(&run.tasks).map_err(|e| e.to_string())?
            ],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())
    }
    pub fn update(&mut self, run: &AgentRun, expected_revision: u64) -> Result<(), String> {
        let tx = self.db.transaction().map_err(|e| e.to_string())?;
        persist_run(&tx, run, expected_revision)?;
        tx.commit().map_err(|e| e.to_string())
    }
    pub fn complete(
        &mut self,
        run: &AgentRun,
        revision: u64,
        attempt: &str,
        request: &str,
        state: &str,
    ) -> Result<(), String> {
        let tx = self.db.transaction().map_err(|e| e.to_string())?;
        persist_run(&tx, run, revision)?;
        finish_records(&tx, attempt, request, state)?;
        tx.commit().map_err(|e| e.to_string())
    }
    pub fn active_count(&self) -> Result<usize, String> {
        let count: u32 = self.db.query_row("SELECT count(*) FROM attempts WHERE state IN ('reserved','running','stopping','unknown')", [], |r| r.get(0)).map_err(|e| e.to_string())?;
        Ok(count as usize)
    }
    pub fn claim(
        &mut self,
        id: &str,
        owner: &str,
        recovery: bool,
        limit: u32,
    ) -> Result<(String, String), String> {
        let tx = self
            .db
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        let active: u32 = tx.query_row("SELECT count(*) FROM attempts WHERE state IN ('reserved','running','stopping','unknown')",[],|r|r.get(0)).map_err(|e|e.to_string())?;
        if active >= limit {
            return Err("CAPACITY_FULL: wait for an active worker".into());
        }
        let attempt = uuid::Uuid::new_v4().to_string();
        let request = uuid::Uuid::new_v4().to_string();
        tx.execute(
            "INSERT INTO attempts VALUES(?1,?2,'reserved',?3)",
            params![attempt, id, owner],
        )
        .map_err(|_| "ATTEMPT_ACTIVE: task already owns an execution")?;
        tx.execute(
            "INSERT INTO request_ledger VALUES(?1,?2,?3,?4,'reserved')",
            params![
                request,
                id,
                attempt,
                if recovery { "recovery" } else { "main" }
            ],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok((attempt, request))
    }
    pub fn mark_sent(&self, request: &str) -> Result<(), String> {
        let tx = self.db.unchecked_transaction().map_err(|e| e.to_string())?;
        let changed = tx
            .execute(
                "UPDATE request_ledger SET state='sent' WHERE id=?1 AND state='reserved'",
                [request],
            )
            .map_err(|e| e.to_string())?;
        if changed != 1 {
            return Err("REQUEST_ALREADY_DISPATCHED".into());
        }
        tx.execute("UPDATE attempts SET state='running' WHERE id=(SELECT attempt_id FROM request_ledger WHERE id=?1)", [request]).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())
    }
    pub fn finish_attempt(&self, attempt: &str, request: &str, state: &str) -> Result<(), String> {
        let tx = self.db.unchecked_transaction().map_err(|e| e.to_string())?;
        finish_records(&tx, attempt, request, state)?;
        tx.commit().map_err(|e| e.to_string())
    }
    pub fn recover_interrupted(&mut self) -> Result<(), String> {
        // Process state cannot be reconstructed from a stale PID. Never redispatch.
        self.db.execute("UPDATE attempts SET state='unknown' WHERE state IN ('running','reserved','stopping')",[]).map_err(|e|e.to_string())?;
        let mut query = self
            .db
            .prepare("SELECT data FROM runs WHERE status IN ('running','preparing','stopping')")
            .map_err(|e| e.to_string())?;
        let rows = query
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        let runs: Result<Vec<AgentRun>, String> = rows
            .map(|row| {
                serde_json::from_str(&row.map_err(|e| e.to_string())?).map_err(|e| e.to_string())
            })
            .collect();
        let runs = runs?;
        drop(query);
        for mut run in runs {
            let rev = run.revision;
            run.revision = run.revision.checked_add(1).ok_or("REVISION_OVERFLOW")?;
            run.status = "interrupted".into();
            run.error = Some(
                "Execution was interrupted. Inspect the retained workspace before retrying.".into(),
            );
            self.update(&run, rev)?;
        }
        Ok(())
    }
}

fn sql_integer(value: u64) -> Result<i64, String> {
    i64::try_from(value).map_err(|_| "DATABASE_INTEGER_OVERFLOW".into())
}
fn finish_records(
    tx: &rusqlite::Transaction<'_>,
    attempt: &str,
    request: &str,
    state: &str,
) -> Result<(), String> {
    let changed = tx
        .execute(
            "UPDATE attempts SET state=?2 WHERE id=?1",
            params![attempt, state],
        )
        .map_err(|e| e.to_string())?;
    let requests = tx
        .execute(
            "UPDATE request_ledger SET state=?2 WHERE id=?1 AND attempt_id=?3",
            params![request, state, attempt],
        )
        .map_err(|e| e.to_string())?;
    if changed != 1 || requests != 1 {
        return Err("ATTEMPT_NOT_FOUND".into());
    }
    Ok(())
}
fn persist_run(
    tx: &rusqlite::Transaction<'_>,
    run: &AgentRun,
    expected_revision: u64,
) -> Result<(), String> {
    let changed = tx
        .execute(
            "UPDATE runs SET revision=?2,status=?3,data=?4 WHERE id=?1 AND revision=?5",
            params![
                run.id,
                sql_integer(run.revision)?,
                run.status,
                serde_json::to_string(run).map_err(|e| e.to_string())?,
                sql_integer(expected_revision)?
            ],
        )
        .map_err(|e| e.to_string())?;
    if changed != 1 {
        return Err("STALE_REVISION: reload the current task".into());
    }
    for task in &run.tasks {
        tx.execute(
            "UPDATE tasks SET status=?3 WHERE run_id=?1 AND id=?2",
            params![run.id, task.id, task.status],
        )
        .map_err(|e| e.to_string())?;
    }
    for artifact in &run.artifacts {
        tx.execute(
            "INSERT OR IGNORE INTO artifacts VALUES(?1,?2,?3,?4,?5)",
            params![
                artifact.id,
                run.id,
                artifact.item_id,
                artifact.hash,
                serde_json::to_string(artifact).map_err(|e| e.to_string())?
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    for event in &run.events {
        tx.execute(
            "INSERT OR IGNORE INTO events VALUES(?1,?2,?3,?4)",
            params![
                run.id,
                sql_integer(event.sequence)?,
                event.kind,
                serde_json::to_string(event).map_err(|e| e.to_string())?
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn schema_has_only_eight_business_tables_and_rejects_future_versions() {
        let store = Store::from_connection(Connection::open_in_memory().unwrap()).unwrap();
        let count: u32 = store
            .db
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='table'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 8);
        let db = Connection::open_in_memory().unwrap();
        db.pragma_update(None, "user_version", 9).unwrap();
        assert!(Store::from_connection(db).is_err());
    }
}
