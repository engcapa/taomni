//! Bounded mail mutations with durable receipts for non-idempotent commands.
//! A lost COPY/MOVE response is never replayed. STORE and UID EXPUNGE can be
//! resumed independently after a confirmed COPY; plain EXPUNGE is never used.
use super::*;
use crate::state::MailDbHandle;

const INITIAL_BATCH: usize = 50;
const COMMAND_BYTES: usize = 4096;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum Kind {
    Move,
    Copy,
    Delete,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
enum Stage {
    Ready,
    CopyUncertain,
    MoveUncertain,
    Copied,
    Deleted,
    Complete,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Item {
    uid: u32,
    stage: Stage,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Job {
    id: String,
    endpoint: String,
    folder: String,
    target: String,
    kind: Kind,
    validity: Option<u32>,
    items: Vec<Item>,
    batch_size: usize,
    move_supported: Option<bool>,
    uidplus: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub operation_id: String,
    pub completed_uids: Vec<u32>,
    pub pending_uids: Vec<u32>,
    pub uncertain_uids: Vec<u32>,
    pub error: Option<String>,
    pub detail: Option<String>,
    pub retryable: bool,
    pub batch_size: usize,
}

impl Job {
    fn result(&self, error: Option<String>, detail: Option<String>) -> Progress {
        let uncertain_uids: Vec<_> = self
            .items
            .iter()
            .filter(|i| matches!(i.stage, Stage::CopyUncertain | Stage::MoveUncertain))
            .map(|i| i.uid)
            .collect();
        Progress {
            operation_id: self.id.clone(),
            completed_uids: self
                .items
                .iter()
                .filter(|i| i.stage == Stage::Complete)
                .map(|i| i.uid)
                .collect(),
            pending_uids: self
                .items
                .iter()
                .filter(|i| i.stage != Stage::Complete)
                .map(|i| i.uid)
                .collect(),
            retryable: error.is_some() && uncertain_uids.is_empty(),
            uncertain_uids,
            error,
            detail,
            batch_size: self.batch_size,
        }
    }
}

fn init(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS mail_mutation_jobs (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL, endpoint TEXT NOT NULL,
        folder TEXT NOT NULL, finished INTEGER NOT NULL, payload TEXT NOT NULL,
        updated_at INTEGER NOT NULL);",
    )
    .map_err(|e| e.to_string())
}

fn save(db: &MailDbHandle, account: &str, job: &Job, completed: &[u32]) -> Result<(), String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    init_mail_tables(&conn).map_err(|e| e.to_string())?;
    init(&conn)?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT OR REPLACE INTO mail_mutation_jobs VALUES (?1,?2,?3,?4,?5,?6,?7)",
        params![
            job.id,
            account,
            job.endpoint,
            job.folder,
            job.items.iter().all(|i| i.stage == Stage::Complete),
            serde_json::to_string(job).map_err(|e| e.to_string())?,
            now_ts()
        ],
    )
    .map_err(|e| e.to_string())?;
    if job.kind != Kind::Copy && !completed.is_empty() {
        remove_cached_messages(&tx, account, &job.folder, completed).map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())
}

fn load(
    db: &MailDbHandle,
    account: &str,
    endpoint: &str,
    folder: &str,
    target: &str,
    kind: Kind,
    uids: &[u32],
    operation_id: Option<&str>,
) -> Result<Job, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    init(&conn)?;
    let mut stmt = conn.prepare("SELECT payload FROM mail_mutation_jobs WHERE account_id=?1 AND ((endpoint=?2 AND folder=?3 AND finished=0) OR id=?4)").map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(
            params![account, endpoint, folder, operation_id.unwrap_or("")],
            |r| r.get::<_, String>(0),
        )
        .map_err(|e| e.to_string())?;
    let requested: HashSet<u32> = uids.iter().copied().collect();
    for row in rows {
        let mut job: Job =
            serde_json::from_str(&row.map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        let same_id = operation_id == Some(job.id.as_str());
        let overlaps = job
            .items
            .iter()
            .any(|i| i.stage != Stage::Complete && requested.contains(&i.uid));
        if !same_id && !overlaps {
            continue;
        }
        if job.endpoint == endpoint
            && job.folder == folder
            && job.target == target
            && job.kind == kind
            && ((same_id
                && (requested.is_empty()
                    || requested
                        .iter()
                        .all(|uid| job.items.iter().any(|i| i.uid == *uid))))
                || (!same_id
                    && job
                        .items
                        .iter()
                        .filter(|i| i.stage != Stage::Complete)
                        .all(|i| requested.contains(&i.uid))))
        {
            if !same_id {
                // A reopened list may form a different UI batch from the
                // remaining selection. Retain receipts and append only new UIDs.
                for uid in uids {
                    if !job.items.iter().any(|i| i.uid == *uid) {
                        job.items.push(Item {
                            uid: *uid,
                            stage: Stage::Ready,
                        });
                    }
                }
            }
            return Ok(job);
        }
        return Err("These messages have an unfinished mail operation. Resume that operation before starting another one.".into());
    }
    Ok(Job {
        id: operation_id
            .map(str::to_string)
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
        endpoint: endpoint.into(),
        folder: folder.into(),
        target: target.into(),
        kind,
        validity: None,
        items: uids
            .iter()
            .map(|uid| Item {
                uid: *uid,
                stage: Stage::Ready,
            })
            .collect(),
        batch_size: INITIAL_BATCH,
        move_supported: None,
        uidplus: None,
    })
}

fn definitive(error: &imap::error::Error) -> bool {
    matches!(
        error,
        imap::error::Error::No(_) | imap::error::Error::Bad(_)
    )
}

fn count_limit(error: &imap::error::Error) -> bool {
    if !definitive(error) {
        return false;
    }
    let text = error.to_string().to_ascii_lowercase();
    text.contains("count over limit")
        || text.contains("too many messages")
        || text.contains("too many uids")
        || text.contains("too many message")
        || text.contains("command too long")
        || text.contains("command line too long")
        || (text.contains("[limit]") && (text.contains("message") || text.contains("uid")))
}

fn set_stage(job: &mut Job, uids: &[u32], stage: Stage) {
    let set: HashSet<_> = uids.iter().copied().collect();
    for item in &mut job.items {
        if set.contains(&item.uid) {
            item.stage = stage;
        }
    }
}

/// Executes at most one bounded batch. Releasing the pool gate between calls
/// lets reading mail proceed while a large filter/delete operation is running.
fn step<T: Read + Write>(
    session: &mut imap::Session<T>,
    db: &MailDbHandle,
    account: &str,
    job: &mut Job,
) -> Result<(), String> {
    let mailbox = session
        .select(&job.folder)
        .map_err(|e| format!("IMAP SELECT failed: {e}"))?;
    let validity = mailbox
        .uid_validity
        .ok_or("Server did not provide UIDVALIDITY; no messages were changed")?;
    if job.validity.is_some_and(|old| old != validity) {
        return Err("Mailbox UIDVALIDITY changed. The saved operation cannot safely continue; synchronize the mailbox.".into());
    }
    job.validity = Some(validity);
    if job.move_supported.is_none() || job.uidplus.is_none() {
        let caps = session
            .capabilities()
            .map_err(|e| format!("IMAP CAPABILITY failed: {e}"))?;
        job.move_supported = Some(caps.has_str("MOVE"));
        job.uidplus = Some(caps.has_str("UIDPLUS"));
    }
    let Some(stage) = job
        .items
        .iter()
        .find(|i| i.stage != Stage::Complete)
        .map(|i| i.stage)
    else {
        return Ok(());
    };
    let overhead = 64 + job.target.len() * 2;
    let mut bytes = overhead;
    let batch: Vec<u32> = job
        .items
        .iter()
        .filter(|i| i.stage == stage)
        .take(job.batch_size)
        .map(|i| i.uid)
        .take_while(|uid| {
            bytes += uid.to_string().len() + 1;
            bytes <= COMMAND_BYTES
        })
        .collect();
    if batch.is_empty() {
        return Err("The destination folder name exceeds the IMAP command size limit.".into());
    }
    let set = uid_set_string(&batch);
    if stage == Stage::CopyUncertain {
        return Err("The server may have copied these messages but its reply was lost. Check the destination before taking further action; automatic copying is stopped to prevent duplicates.".into());
    }
    if stage == Stage::MoveUncertain {
        // A missing source UID confirms MOVE completed. Existing UIDs cannot
        // prove that no destination copies were created; never replay those.
        let present = session
            .uid_search(format!("UID {set}"))
            .map_err(|e| format!("Could not verify the previous MOVE: {e}"))?;
        let done: Vec<_> = batch
            .iter()
            .filter(|uid| !present.contains(uid))
            .copied()
            .collect();
        set_stage(job, &done, Stage::Complete);
        save(db, account, job, &done)?;
        if done.len() != batch.len() {
            return Err("The previous MOVE result is uncertain. Check the source and destination; automatic copying is stopped to prevent duplicates.".into());
        }
        return Ok(());
    }
    let command = if stage == Stage::Ready && job.kind != Kind::Delete {
        let moving = job.kind == Kind::Move && job.move_supported == Some(true);
        set_stage(
            job,
            &batch,
            if moving {
                Stage::MoveUncertain
            } else {
                Stage::CopyUncertain
            },
        );
        // Write ahead: even a crash during the network request must not cause a
        // second COPY on restart. A failed receipt write prevents the command.
        save(db, account, job, &[])?;
        let result = if moving {
            session.uid_mv(&set, &job.target)
        } else {
            session.uid_copy(&set, &job.target)
        };
        match result {
            Ok(()) => {
                let next = if moving || job.kind == Kind::Copy {
                    Stage::Complete
                } else {
                    Stage::Copied
                };
                set_stage(job, &batch, next);
                save(
                    db,
                    account,
                    job,
                    if next == Stage::Complete { &batch } else { &[] },
                )?;
                return Ok(());
            }
            Err(error) => {
                if definitive(&error) {
                    set_stage(job, &batch, Stage::Ready);
                    let text = error.to_string().to_ascii_lowercase();
                    if moving
                        && matches!(error, imap::error::Error::Bad(_))
                        && (text.contains("unknown command")
                            || text.contains("unsupported command")
                            || text.contains("unrecognized command"))
                    {
                        job.move_supported = Some(false);
                        save(db, account, job, &[])?;
                        return Ok(());
                    }
                }
                Err(error)
            }
        }
    } else if stage == Stage::Ready || stage == Stage::Copied {
        session
            .uid_store(&set, "+FLAGS.SILENT (\\Deleted)")
            .map(|_| {
                set_stage(job, &batch, Stage::Deleted);
            })
    } else {
        if job.uidplus != Some(true) {
            return Err("Messages are marked for deletion, but this server cannot safely expunge only the selected messages (UIDPLUS unavailable). No other messages were expunged.".into());
        }
        session.uid_expunge(&set).map(|_| {
            set_stage(job, &batch, Stage::Complete);
        })
    };
    match command {
        Ok(()) => save(
            db,
            account,
            job,
            if stage == Stage::Deleted { &batch } else { &[] },
        ),
        Err(error) => {
            if count_limit(&error) && batch.len() > 1 {
                job.batch_size = (batch.len() / 2).max(1);
                save(db, account, job, &[])?;
                return Ok(());
            }
            save(db, account, job, &[])?;
            Err(format!("IMAP mail operation failed: {error}"))
        }
    }
}

pub(super) fn run_cached(
    pool: &MailImapPool,
    account: &ResolvedMailAccount,
    runtime: &tokio::runtime::Handle,
    db: &MailDbHandle,
    folder: &str,
    mut uids: Vec<u32>,
    target: &str,
    kind: Kind,
    all: bool,
    operation_id: Option<String>,
) -> Result<Progress, String> {
    let account_id = &account.config.session_id;
    let gate = pool.mutation_gate(account_id);
    let _guard = gate.lock().map_err(|_| "mail mutation lock poisoned")?;
    let opts = ImapSessionOpts {
        retry_on_error: false,
        ..Default::default()
    };
    let existing_request = if let Some(id) = &operation_id {
        let conn = db.lock().map_err(|e| e.to_string())?;
        init(&conn)?;
        conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM mail_mutation_jobs WHERE id=?1 AND account_id=?2)",
            params![id, account_id],
            |row| row.get::<_, bool>(0),
        )
        .map_err(|e| e.to_string())?
    } else {
        false
    };
    if all && !existing_request {
        uids = with_imap_session(pool, account, runtime, opts, |imap| match imap {
            ActiveImapSession::Tls { session, .. } => all_uids(session, folder),
            ActiveImapSession::Plain { session, .. } => all_uids(session, folder),
        })?;
    }
    uids.retain(|uid| *uid > 0);
    uids.sort_unstable();
    uids.dedup();
    let endpoint = format!(
        "{}:{}:{}",
        account.config.imap.host.trim(),
        account.config.imap.port,
        account.imap_username
    );
    let mut job = load(
        db,
        account_id,
        &endpoint,
        folder,
        target,
        kind,
        &uids,
        operation_id.as_deref(),
    )?;
    // Capabilities are cached for this execution, and refreshed on reconnect /
    // explicit resume so an administrator's server upgrade can unblock cleanup.
    job.move_supported = None;
    job.uidplus = None;
    save(db, account_id, &job, &[])?;
    while job.items.iter().any(|i| i.stage != Stage::Complete) {
        let result = with_imap_session(pool, account, runtime, opts, |imap| match imap {
            ActiveImapSession::Tls { session, .. } => step(session, db, account_id, &mut job),
            ActiveImapSession::Plain { session, .. } => step(session, db, account_id, &mut job),
        });
        if let Err(detail) = result {
            let uncertain = job
                .items
                .iter()
                .any(|i| matches!(i.stage, Stage::CopyUncertain | Stage::MoveUncertain));
            let error = if uncertain {
                "The server result needs verification. Automatic retry is stopped to prevent duplicate mail.".into()
            } else if detail.contains("UIDPLUS") || detail.contains("UIDVALIDITY") {
                detail.clone()
            } else {
                "Some messages could not be processed. Retry to continue from the last confirmed step.".into()
            };
            return Ok(job.result(Some(error), Some(detail)));
        }
    }
    Ok(job.result(None, None))
}

fn all_uids<T: Read + Write>(
    session: &mut imap::Session<T>,
    folder: &str,
) -> Result<Vec<u32>, String> {
    session.select(folder).map_err(|e| e.to_string())?;
    session
        .uid_search("ALL")
        .map(|uids| uids.into_iter().collect())
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests;
