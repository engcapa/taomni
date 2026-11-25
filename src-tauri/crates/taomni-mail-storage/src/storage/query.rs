//! Local archive queries and immutable cleanup previews; no mailbox network calls.
use super::cleanup::collect_garbage;
#[cfg(feature = "mime-parse")]
use super::index::legacy_attachment_flag;
use super::model::ArchiveEntry;
use rusqlite::{Connection, params, params_from_iter, types::Value};

const LEGACY_ATTACHMENT_BACKFILL_KEY: &str = "legacy_attachment_backfill_pending";

pub use taomni_mail_api::archive_index::{
    ArchiveKey, ArchivePage, ArchiveQuery, ArchiveRow, ArchiveSelection, ArchiveSort,
    CleanupPreview, SearchField,
};

/// Materialized metadata keeps filters/sorts off JSON and compressed MIME.
/// FTS5 trigram indexes substring searches of three or more characters.
pub(super) fn init_index(db: &Connection) -> rusqlite::Result<()> {
    let exists: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='mail_archive_index')",
        [],
        |r| r.get(0),
    )?;
    let tx = db.unchecked_transaction()?;
    tx.execute_batch("CREATE TABLE IF NOT EXISTS mail_archive_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS mail_archive_index (
        account_id TEXT NOT NULL,folder TEXT NOT NULL,uid_validity INTEGER NOT NULL,uid INTEGER NOT NULL,
        sha256 TEXT NOT NULL,subject TEXT NOT NULL,sender TEXT NOT NULL,recipients TEXT NOT NULL,
        date_ts INTEGER,has_attachments INTEGER NOT NULL,raw_size INTEGER NOT NULL,stored_size INTEGER NOT NULL,stored_at INTEGER NOT NULL,
        UNIQUE(account_id,folder,uid_validity,uid));
        CREATE INDEX IF NOT EXISTS mail_archive_saved ON mail_archive_index(account_id,stored_at DESC);
        CREATE INDEX IF NOT EXISTS mail_archive_folder_saved ON mail_archive_index(account_id,folder,stored_at DESC);
        CREATE INDEX IF NOT EXISTS mail_archive_date ON mail_archive_index(account_id,date_ts);
        CREATE INDEX IF NOT EXISTS mail_archive_size ON mail_archive_index(account_id,raw_size DESC);
        CREATE INDEX IF NOT EXISTS mail_archive_attachment ON mail_archive_index(account_id,has_attachments,stored_at DESC);
        CREATE VIRTUAL TABLE IF NOT EXISTS mail_archive_search USING fts5(subject,sender,recipients,content='mail_archive_index',content_rowid='rowid',tokenize='trigram');
        CREATE TRIGGER IF NOT EXISTS mail_archive_search_insert AFTER INSERT ON mail_archive_index BEGIN
          INSERT INTO mail_archive_search(rowid,subject,sender,recipients) VALUES(new.rowid,new.subject,new.sender,new.recipients); END;
        CREATE TRIGGER IF NOT EXISTS mail_archive_search_delete AFTER DELETE ON mail_archive_index BEGIN
          INSERT INTO mail_archive_search(mail_archive_search,rowid,subject,sender,recipients) VALUES('delete',old.rowid,old.subject,old.sender,old.recipients); END;
        CREATE TRIGGER IF NOT EXISTS mail_archive_search_update AFTER UPDATE ON mail_archive_index BEGIN
          INSERT INTO mail_archive_search(mail_archive_search,rowid,subject,sender,recipients) VALUES('delete',old.rowid,old.subject,old.sender,old.recipients);
          INSERT INTO mail_archive_search(rowid,subject,sender,recipients) VALUES(new.rowid,new.subject,new.sender,new.recipients); END;
        CREATE TRIGGER IF NOT EXISTS mail_archive_index_delete AFTER DELETE ON mail_full_messages BEGIN
          DELETE FROM mail_archive_index WHERE account_id=old.account_id AND folder=old.folder AND uid_validity=old.uid_validity AND uid=old.uid; END;")?;
    let projection = "account_id,folder,uid_validity,uid,sha256,COALESCE(json_extract(header_json,'$.subject'),''),
        trim(COALESCE(json_extract(header_json,'$.from.name'),'')||' '||COALESCE(json_extract(header_json,'$.from.address'),'')),
        COALESCE((SELECT group_concat(trim(COALESCE(json_extract(value,'$.name'),'')||' '||COALESCE(json_extract(value,'$.address'),'')),', ') FROM json_each(header_json,'$.to')),'')||' '||
        COALESCE((SELECT group_concat(trim(COALESCE(json_extract(value,'$.name'),'')||' '||COALESCE(json_extract(value,'$.address'),'')),', ') FROM json_each(header_json,'$.cc')),''),
        json_extract(header_json,'$.dateTs'),COALESCE(json_extract(header_json,'$.hasAttachments'),0),raw_size,stored_size,stored_at";
    let insert = format!(
        "INSERT INTO mail_archive_index SELECT {projection} FROM mail_full_messages WHERE account_id=new.account_id AND folder=new.folder AND uid_validity=new.uid_validity AND uid=new.uid"
    );
    tx.execute_batch(&format!("CREATE TRIGGER IF NOT EXISTS mail_archive_index_insert AFTER INSERT ON mail_full_messages BEGIN {insert}; END;
        CREATE TRIGGER IF NOT EXISTS mail_archive_index_update AFTER UPDATE ON mail_full_messages BEGIN
          DELETE FROM mail_archive_index WHERE account_id=old.account_id AND folder=old.folder AND uid_validity=old.uid_validity AND uid=old.uid;
          {insert}; END;"))?;
    #[cfg(feature = "mime-parse")]
    let backfill_pending: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM mail_archive_meta WHERE key=?1)",
        [LEGACY_ATTACHMENT_BACKFILL_KEY],
        |r| r.get(0),
    )?;
    #[cfg(feature = "mime-parse")]
    if !exists || backfill_pending {
        // Existing header-only snapshots can lack attachment flags. Inspect each
        // distinct original once during migration, with bounded streaming memory.
        let objects: Vec<(String,String)> = tx.prepare("SELECT DISTINCT account_id,sha256 FROM mail_full_messages WHERE COALESCE(json_extract(header_json,'$.hasAttachments'),0)=0")?.query_map([],|r|Ok((r.get(0)?,r.get(1)?)))?.collect::<rusqlite::Result<_>>()?;
        for (account, hash) in objects {
            if let Ok(true) = legacy_attachment_flag(&tx, &account, &hash) {
                tx.execute(
                    "UPDATE mail_full_messages SET header_json=json_set(CASE WHEN json_type(header_json)='object' THEN header_json ELSE '{}' END,'$.hasAttachments',1) WHERE account_id=? AND sha256=?",
                    params![account, hash],
                )?;
            }
        }
        tx.execute(
            "DELETE FROM mail_archive_meta WHERE key=?1",
            [LEGACY_ATTACHMENT_BACKFILL_KEY],
        )?;
    }
    #[cfg(not(feature = "mime-parse"))]
    if !exists {
        let needs_backfill: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM mail_full_messages WHERE COALESCE(json_extract(header_json,'$.hasAttachments'),0)=0)",
            [],
            |r| r.get(0),
        )?;
        if needs_backfill {
            tx.execute(
                "INSERT OR REPLACE INTO mail_archive_meta(key, value) VALUES(?1, '1')",
                [LEGACY_ATTACHMENT_BACKFILL_KEY],
            )?;
        }
    }
    if !exists {
        tx.execute_batch(&format!(
            "INSERT OR IGNORE INTO mail_archive_index SELECT {projection} FROM mail_full_messages;"
        ))?;
    }
    tx.commit()
}

pub fn has_pending_attachment_backfill(db: &Connection) -> rusqlite::Result<bool> {
    let has_meta: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='mail_archive_meta')",
        [],
        |r| r.get(0),
    )?;
    if !has_meta {
        return Ok(false);
    }
    db.query_row(
        "SELECT EXISTS(SELECT 1 FROM mail_archive_meta WHERE key=?1)",
        [LEGACY_ATTACHMENT_BACKFILL_KEY],
        |r| r.get(0),
    )
}

pub fn complete_pending_attachment_backfill(db: &Connection) -> rusqlite::Result<()> {
    if has_pending_attachment_backfill(db)? {
        init_index(db)?;
    }
    Ok(())
}

fn filter(account: &str, query: &ArchiveQuery) -> Result<(String, Vec<Value>), String> {
    for (a, b) in [
        (query.date_from, query.date_before),
        (query.stored_from, query.stored_before),
    ] {
        if a.zip(b).is_some_and(|(a, b)| a >= b) {
            return Err("The end date must not precede the start date".into());
        }
    }
    if query.min_size.is_some_and(|n| n < 0)
        || query.max_size.is_some_and(|n| n < 0)
        || query
            .min_size
            .zip(query.max_size)
            .is_some_and(|(a, b)| a > b)
    {
        return Err("Enter a valid message size range".into());
    }
    if query.text.len() > 4096 {
        return Err("Search text is too long".into());
    }
    let mut sql = "m.account_id=?".to_string();
    let mut values = vec![Value::Text(account.into())];
    if !query.text.trim().is_empty() {
        let fields: &[&str] = match query.field {
            SearchField::All => &["subject", "sender", "recipients"],
            SearchField::Subject => &["subject"],
            SearchField::From => &["sender"],
            SearchField::To => &["recipients"],
        };
        if query.text.trim().chars().count() >= 3 {
            sql.push_str(" AND m.rowid IN (SELECT rowid FROM mail_archive_search WHERE mail_archive_search MATCH ?)");
            let scope = match query.field {
                SearchField::All => "",
                SearchField::Subject => "subject:",
                SearchField::From => "sender:",
                SearchField::To => "recipients:",
            };
            values.push(Value::Text(format!(
                "{scope}\"{}\"",
                query.text.trim().replace('"', "\"\"")
            )));
        }
        sql.push_str(" AND (");
        for (i, field) in fields.iter().enumerate() {
            if i > 0 {
                sql.push_str(" OR ");
            }
            sql.push_str(&format!("instr(lower(m.{field}),lower(?))>0"));
            values.push(Value::Text(query.text.trim().into()));
        }
        sql.push(')');
    }
    if let Some(folder) = &query.folder {
        sql.push_str(" AND m.folder=?");
        values.push(Value::Text(folder.clone()));
    }
    if let Some(has) = query.has_attachments {
        sql.push_str(" AND m.has_attachments=?");
        values.push(Value::Integer(i64::from(has)));
    }
    for (expr, op, value) in [
        ("m.date_ts", ">=", query.date_from),
        ("m.date_ts", "<", query.date_before),
        ("m.stored_at", ">=", query.stored_from),
        ("m.stored_at", "<", query.stored_before),
        ("m.raw_size", ">=", query.min_size),
        ("m.raw_size", "<=", query.max_size),
    ] {
        if let Some(value) = value {
            sql.push_str(&format!(" AND {expr}{op}?"));
            values.push(Value::Integer(value));
        }
    }
    Ok((sql, values))
}
pub fn query(
    db: &Connection,
    account: &str,
    query: &ArchiveQuery,
    offset: u32,
) -> Result<ArchivePage, String> {
    let (where_sql, values) = filter(account, query)?;
    let tx = db.unchecked_transaction().map_err(|e| e.to_string())?;
    let (total,stored_bytes):(i64,i64)=tx.query_row(&format!("SELECT COUNT(*),COALESCE(SUM(m.stored_size),0) FROM mail_archive_index m WHERE {where_sql}"),params_from_iter(&values),|r|Ok((r.get(0)?,r.get(1)?))).map_err(|e|e.to_string())?;
    let offset = if total == 0 {
        0
    } else {
        offset.min(((total as u32 - 1) / 200) * 200)
    };
    let order = match query.sort {
        ArchiveSort::SavedNewest => "m.stored_at DESC",
        ArchiveSort::SavedOldest => "m.stored_at ASC",
        ArchiveSort::DateNewest => "m.date_ts DESC",
        ArchiveSort::DateOldest => "m.date_ts IS NULL,m.date_ts ASC",
        ArchiveSort::Largest => "m.raw_size DESC",
        ArchiveSort::Smallest => "m.raw_size ASC",
    };
    let mut page_values = values;
    page_values.push(Value::Integer(i64::from(offset)));
    let entries=tx.prepare(&format!("SELECT m.folder,m.uid,m.uid_validity,m.subject,m.raw_size,m.stored_size,m.stored_at,m.sender,m.recipients,m.date_ts,m.has_attachments FROM mail_archive_index m WHERE {where_sql} ORDER BY {order},m.folder,m.uid_validity DESC,m.uid DESC LIMIT 200 OFFSET ?")).map_err(|e|e.to_string())?
        .query_map(params_from_iter(page_values),|row| {
            Ok(ArchiveRow {entry:ArchiveEntry {folder:row.get(0)?,uid:row.get(1)?,uid_validity:row.get(2)?,subject:row.get(3)?,raw_size:row.get::<_,i64>(4)? as u64,stored_size:row.get::<_,i64>(5)? as u64,stored_at:row.get(6)?},from:row.get(7)?,to:row.get(8)?,date_ts:row.get(9)?,has_attachments:row.get(10)?})
        }).map_err(|e|e.to_string())?.collect::<rusqlite::Result<Vec<_>>>().map_err(|e|e.to_string())?;
    let folders = tx
        .prepare(
            "SELECT DISTINCT folder FROM mail_archive_index WHERE account_id=? ORDER BY folder",
        )
        .map_err(|e| e.to_string())?
        .query_map([account], |r| r.get(0))
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(ArchivePage {
        entries,
        total: total as u64,
        stored_bytes: stored_bytes as u64,
        folders,
        offset,
    })
}
fn preview_tables(db: &Connection) -> Result<(), String> {
    db.execute_batch("CREATE TEMP TABLE IF NOT EXISTS archive_preview(token TEXT,account TEXT,expires INTEGER,folder TEXT,uid_validity INTEGER,uid INTEGER,sha256 TEXT,PRIMARY KEY(token,folder,uid_validity,uid));
    CREATE TEMP TABLE IF NOT EXISTS archive_selection(folder TEXT,uid_validity INTEGER,uid INTEGER,PRIMARY KEY(folder,uid_validity,uid));
    DELETE FROM archive_selection;
    DELETE FROM archive_preview WHERE expires<unixepoch();").map_err(|e|e.to_string())
}
pub fn preview(
    db: &Connection,
    account: &str,
    selection: &ArchiveSelection,
) -> Result<CleanupPreview, String> {
    if selection.keys.len() + selection.excluded.len() > 100_000 {
        return Err("Too many explicit selections; use Select all matching".into());
    }
    preview_tables(db)?;
    let tx = db.unchecked_transaction().map_err(|e| e.to_string())?;
    let keys = if selection.query.is_some() {
        &selection.excluded
    } else {
        &selection.keys
    };
    {
        let mut insert = tx
            .prepare("INSERT OR IGNORE INTO archive_selection VALUES(?,?,?)")
            .map_err(|e| e.to_string())?;
        for key in keys {
            insert
                .execute(params![key.folder, key.uid_validity, key.uid])
                .map_err(|e| e.to_string())?;
        }
    }
    let (mut where_sql, mut values) =
        filter(account, &selection.query.clone().unwrap_or_default())?;
    where_sql.push_str(if selection.query.is_some() {
        " AND NOT EXISTS"
    } else {
        " AND EXISTS"
    });
    where_sql.push_str("(SELECT 1 FROM archive_selection s WHERE s.folder=m.folder AND s.uid_validity=m.uid_validity AND s.uid=m.uid)");
    // Limit retained previews per account; closing a dialog does not leave unbounded snapshots.
    tx.execute("DELETE FROM archive_preview WHERE account=?", [account])
        .map_err(|e| e.to_string())?;
    let token = uuid::Uuid::new_v4().to_string();
    values.insert(0, Value::Text(token.clone()));
    tx.execute(&format!("INSERT INTO archive_preview SELECT ?,m.account_id,unixepoch()+600,m.folder,m.uid_validity,m.uid,m.sha256 FROM mail_archive_index m WHERE {where_sql}"),params_from_iter(values)).map_err(|e|e.to_string())?;
    let (count,stored_bytes):(i64,i64)=tx.query_row("SELECT COUNT(*),COALESCE(SUM(m.stored_size),0) FROM archive_preview p JOIN mail_full_messages m ON m.account_id=p.account AND m.folder=p.folder AND m.uid_validity=p.uid_validity AND m.uid=p.uid WHERE p.token=?",[&token],|r|Ok((r.get(0)?,r.get(1)?))).map_err(|e|e.to_string())?;
    let reclaimable_bytes:i64=tx.query_row("SELECT COALESCE(SUM(size),0) FROM (SELECT MAX(m.stored_size) size FROM archive_preview p JOIN mail_full_messages m ON m.account_id=p.account AND m.folder=p.folder AND m.uid_validity=p.uid_validity AND m.uid=p.uid WHERE p.token=? GROUP BY p.sha256 HAVING COUNT(*)=(SELECT COUNT(*) FROM mail_full_messages a WHERE a.sha256=p.sha256))",[&token],|r|r.get(0)).map_err(|e|e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(CleanupPreview {
        token,
        count: count as u64,
        stored_bytes: stored_bytes as u64,
        reclaimable_bytes: reclaimable_bytes as u64,
    })
}
pub fn remove_preview(db: &Connection, account: &str, token: &str) -> Result<u64, String> {
    remove_preview_with(db, account, token, || Ok(()))
}

pub fn remove_preview_with(
    db: &Connection,
    account: &str,
    token: &str,
    check: impl Fn() -> Result<(), String>,
) -> Result<u64, String> {
    check()?;
    preview_tables(db)?;
    let tx = db.unchecked_transaction().map_err(|e| e.to_string())?;
    let (count,current):(i64,i64)=tx.query_row("SELECT COUNT(*),COUNT(m.uid) FROM archive_preview p LEFT JOIN mail_full_messages m ON m.account_id=p.account AND m.folder=p.folder AND m.uid_validity=p.uid_validity AND m.uid=p.uid AND m.sha256=p.sha256 WHERE p.token=? AND p.account=?",params![token,account],|r|Ok((r.get(0)?,r.get(1)?))).map_err(|e|e.to_string())?;
    if count == 0 || count != current {
        return Err(
            "The cleanup preview expired or its messages changed. Review the selection again"
                .into(),
        );
    }
    tx.execute("INSERT INTO mail_archive_preferences(account_id,paused) VALUES(?,1) ON CONFLICT(account_id) DO UPDATE SET paused=1",[account]).map_err(|e|e.to_string())?;
    tx.execute("INSERT OR IGNORE INTO mail_archive_skipped SELECT account,folder,uid_validity,uid FROM archive_preview WHERE token=? AND account=?",params![token,account]).map_err(|e|e.to_string())?;
    tx.execute("UPDATE mail_messages AS m SET body_text=NULL,body_html=NULL,body_cached_at=NULL WHERE m.account_id=? AND EXISTS(SELECT 1 FROM archive_preview p WHERE p.token=? AND p.account=m.account_id AND p.folder=m.folder AND p.uid=m.uid AND p.uid_validity=COALESCE((SELECT uid_validity FROM mail_folders WHERE account_id=m.account_id AND name=m.folder),p.uid_validity))",params![account,token]).map_err(|e|e.to_string())?;
    tx.execute("DELETE FROM mail_full_messages AS m WHERE m.account_id=? AND EXISTS(SELECT 1 FROM archive_preview p WHERE p.token=? AND p.account=m.account_id AND p.folder=m.folder AND p.uid_validity=m.uid_validity AND p.uid=m.uid AND p.sha256=m.sha256)",params![account,token]).map_err(|e|e.to_string())?;
    tx.execute("DELETE FROM archive_preview WHERE token=?", [token])
        .map_err(|e| e.to_string())?;
    check()?;
    tx.commit().map_err(|e| e.to_string())?;
    collect_garbage(db, account)?;
    Ok(count as u64)
}

#[cfg(test)]
mod tests;
