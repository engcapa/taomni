//! Local archive queries and immutable cleanup previews; no mailbox network calls.
use super::storage::{self, ArchiveEntry};
use rusqlite::{Connection, params, params_from_iter, types::Value};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ArchiveQuery {
    pub text: String,
    pub field: SearchField,
    pub folder: Option<String>,
    pub has_attachments: Option<bool>,
    pub date_from: Option<i64>,
    pub date_before: Option<i64>,
    pub stored_from: Option<i64>,
    pub stored_before: Option<i64>,
    pub min_size: Option<i64>,
    pub max_size: Option<i64>,
    pub sort: ArchiveSort,
}
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SearchField {
    #[default]
    All,
    Subject,
    From,
    To,
}
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ArchiveSort {
    #[default]
    SavedNewest,
    SavedOldest,
    DateNewest,
    DateOldest,
    Largest,
    Smallest,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveKey {
    pub folder: String,
    pub uid: u32,
    pub uid_validity: u32,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveSelection {
    pub query: Option<ArchiveQuery>,
    #[serde(default)]
    pub keys: Vec<ArchiveKey>,
    #[serde(default)]
    pub excluded: Vec<ArchiveKey>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveRow {
    #[serde(flatten)]
    pub entry: ArchiveEntry,
    pub from: String,
    pub to: String,
    pub date_ts: Option<i64>,
    pub has_attachments: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchivePage {
    pub entries: Vec<ArchiveRow>,
    pub total: u64,
    pub stored_bytes: u64,
    pub folders: Vec<String>,
    pub offset: u32,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupPreview {
    pub token: String,
    pub count: u64,
    pub stored_bytes: u64,
    pub reclaimable_bytes: u64,
}

/// Materialized metadata keeps filters/sorts off JSON and compressed MIME.
/// FTS5 trigram indexes substring searches of three or more characters.
pub fn init_index(db: &Connection) -> rusqlite::Result<()> {
    let exists: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='mail_archive_index')",
        [],
        |r| r.get(0),
    )?;
    let tx = db.unchecked_transaction()?;
    tx.execute_batch("CREATE TABLE IF NOT EXISTS mail_archive_index (
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
    if !exists {
        // Existing header-only snapshots can lack attachment flags. Inspect each
        // distinct original once during migration, with bounded streaming memory.
        let objects: Vec<(String,String)> = tx.prepare("SELECT DISTINCT account_id,sha256 FROM mail_full_messages WHERE COALESCE(json_extract(header_json,'$.hasAttachments'),0)=0")?.query_map([],|r|Ok((r.get(0)?,r.get(1)?)))?.collect::<rusqlite::Result<_>>()?;
        for (account, hash) in objects {
            if let Ok(true) = storage::legacy_attachment_flag(&tx, &account, &hash) {
                tx.execute("UPDATE mail_full_messages SET header_json=json_set(header_json,'$.hasAttachments',1) WHERE account_id=? AND sha256=?",params![account,hash])?;
            }
        }
        tx.execute_batch(&format!(
            "INSERT OR IGNORE INTO mail_archive_index SELECT {projection} FROM mail_full_messages;"
        ))?;
    }
    tx.commit()
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
    tx.commit().map_err(|e| e.to_string())?;
    storage::collect_garbage(db, account)?;
    Ok(count as u64)
}
#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (tempfile::TempDir, Connection) {
        let dir = tempfile::tempdir().unwrap();
        let db = Connection::open(dir.path().join("qa.db")).unwrap();
        super::super::init_mail_tables(&db).unwrap();
        (dir, db)
    }
    fn add(db: &Connection, uid: u32, folder: &str, subject: &str, hash: &str) {
        let header = serde_json::json!({"subject":subject,"from":{"name":"Alice","address":"alice@example.com"},"to":[{"address":"reader@example.com"}],"cc":[],"dateTs":100+uid,"hasAttachments":uid%2==0,"bodyCached":true});
        db.execute(
            "INSERT INTO mail_full_messages VALUES('qa',?1,?2,10,?3,?4,?5,?6,?7)",
            params![
                folder,
                uid,
                hash,
                1000 + uid,
                100 + uid,
                200 + uid,
                header.to_string()
            ],
        )
        .unwrap();
    }
    fn key(uid: u32, folder: &str) -> ArchiveKey {
        ArchiveKey {
            folder: folder.into(),
            uid,
            uid_validity: 10,
        }
    }
    #[test]
    fn indexed_filters_search_literal_unicode_and_paginate_whole_archive() {
        let (_dir, db) = fixture();
        for uid in 1..=450 {
            add(
                &db,
                uid,
                if uid <= 400 { "INBOX" } else { "&U,BTFw-" },
                &format!("Invoice 台北 {uid:04}"),
                "hash",
            );
        }
        let q = ArchiveQuery {
            text: "Invoice".into(),
            folder: Some("INBOX".into()),
            sort: ArchiveSort::Largest,
            ..Default::default()
        };
        let result = query(&db, "qa", &q, 200).unwrap();
        assert_eq!(result.total, 400);
        assert_eq!(result.entries.len(), 200);
        assert_eq!(result.entries[0].entry.uid, 200);
        for text in [
            "台北",
            "Invoice 台北",
            "ALICE@EXAMPLE.COM",
            "reader@example.com",
        ] {
            assert_eq!(
                query(
                    &db,
                    "qa",
                    &ArchiveQuery {
                        text: text.into(),
                        ..Default::default()
                    },
                    0
                )
                .unwrap()
                .total,
                450
            );
        }
        assert_eq!(query(&db, "other", &q, 0).unwrap().total, 0);
        add(&db, 451, "INBOX", "Literal 100% _ \"quoted\"", "hash");
        assert_eq!(
            query(
                &db,
                "qa",
                &ArchiveQuery {
                    text: "100% _ \"quoted\"".into(),
                    ..Default::default()
                },
                0
            )
            .unwrap()
            .total,
            1
        );
        let q = ArchiveQuery {
            date_from: Some(110),
            date_before: Some(121),
            min_size: Some(1012),
            max_size: Some(1018),
            has_attachments: Some(true),
            stored_from: Some(214),
            stored_before: Some(218),
            ..Default::default()
        };
        let result = query(&db, "qa", &q, 9999).unwrap();
        assert_eq!(result.total, 2);
        assert_eq!(result.offset, 0);
        assert!(
            query(
                &db,
                "qa",
                &ArchiveQuery {
                    min_size: Some(20),
                    max_size: Some(10),
                    ..Default::default()
                },
                0
            )
            .is_err()
        );
        let plan:String=db.query_row("EXPLAIN QUERY PLAN SELECT * FROM mail_archive_index WHERE account_id='qa' AND folder='INBOX' ORDER BY stored_at DESC LIMIT 200",[],|r|r.get(3)).unwrap();
        assert!(plan.contains("mail_archive_folder_saved"), "{plan}");
        db.execute("UPDATE mail_full_messages SET header_json=json_set(header_json,'$.subject','Changed subject') WHERE uid=451",[]).unwrap();
        assert_eq!(
            query(
                &db,
                "qa",
                &ArchiveQuery {
                    text: "quoted".into(),
                    ..Default::default()
                },
                0
            )
            .unwrap()
            .total,
            0
        );
        assert_eq!(
            query(
                &db,
                "qa",
                &ArchiveQuery {
                    text: "Changed".into(),
                    ..Default::default()
                },
                0
            )
            .unwrap()
            .total,
            1
        );
    }
    #[test]
    fn previews_freeze_membership_respect_shared_objects_and_exclusions() {
        let (_dir, db) = fixture();
        add(&db, 1, "INBOX", "Keep shared", "shared");
        add(&db, 2, "Archive", "Shared copy", "shared");
        add(&db, 3, "INBOX", "Unique", "unique");
        let p = preview(
            &db,
            "qa",
            &ArchiveSelection {
                query: Some(ArchiveQuery {
                    folder: Some("INBOX".into()),
                    ..Default::default()
                }),
                keys: vec![],
                excluded: vec![],
            },
        )
        .unwrap();
        assert_eq!(p.count, 2);
        assert_eq!(p.reclaimable_bytes, 103);
        add(&db, 4, "INBOX", "Arrived after preview", "new");
        // Invalid object hashes are deliberately absent; removing mappings is verified independently.
        db.execute("DROP TRIGGER mail_full_object_unreferenced", [])
            .unwrap();
        assert_eq!(remove_preview(&db, "qa", &p.token).unwrap(), 2);
        assert_eq!(
            query(&db, "qa", &ArchiveQuery::default(), 0).unwrap().total,
            2
        );
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM mail_archive_skipped", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            2
        );
        assert!(remove_preview(&db, "qa", &p.token).is_err());
        let p = preview(
            &db,
            "qa",
            &ArchiveSelection {
                query: Some(ArchiveQuery::default()),
                keys: vec![],
                excluded: vec![key(4, "INBOX")],
            },
        )
        .unwrap();
        assert_eq!(p.count, 1);
        assert_eq!(p.reclaimable_bytes, 102);
        assert!(remove_preview(&db, "other", &p.token).is_err());
        db.execute(
            "UPDATE mail_full_messages SET sha256='replacement' WHERE uid=2",
            [],
        )
        .unwrap();
        assert!(
            remove_preview(&db, "qa", &p.token)
                .unwrap_err()
                .contains("changed")
        );
        assert_eq!(
            query(&db, "qa", &ArchiveQuery::default(), 0).unwrap().total,
            2
        );
    }
    #[test]
    fn attachment_metadata_is_built_from_mime_and_migrated_for_old_snapshots() {
        let (_dir, db) = fixture();
        db.execute(
            "INSERT INTO mail_messages(account_id,folder,uid,updated_at) VALUES('qa','INBOX',1,0)",
            [],
        )
        .unwrap();
        let raw=b"Subject: Attachments\r\nContent-Type: multipart/mixed; boundary=x\r\n\r\n--x\r\nContent-Type: text/plain\r\n\r\nbody\r\n--x\r\nContent-Disposition: attachment; filename=a.bin\r\n\r\nbytes\r\n--x--\r\n";
        storage::store(&db, "qa", "INBOX", 1, 10, raw.as_slice()).unwrap();
        assert_eq!(
            query(
                &db,
                "qa",
                &ArchiveQuery {
                    has_attachments: Some(true),
                    ..Default::default()
                },
                0
            )
            .unwrap()
            .total,
            1
        );
        db.execute_batch("DROP TRIGGER mail_archive_index_insert;DROP TRIGGER mail_archive_index_update;DROP TRIGGER mail_archive_index_delete;DROP TABLE mail_archive_search;DROP TABLE mail_archive_index;").unwrap();
        db.execute(
            "UPDATE mail_full_messages SET header_json=json_set(header_json,'$.hasAttachments',0)",
            [],
        )
        .unwrap();
        init_index(&db).unwrap();
        assert_eq!(
            query(
                &db,
                "qa",
                &ArchiveQuery {
                    has_attachments: Some(true),
                    ..Default::default()
                },
                0
            )
            .unwrap()
            .total,
            1
        );
        // The rebuild is complete: later queries depend only on the index.
        db.execute("DELETE FROM mail_messages", []).unwrap();
        assert_eq!(
            query(
                &db,
                "qa",
                &ArchiveQuery {
                    has_attachments: Some(true),
                    ..Default::default()
                },
                0
            )
            .unwrap()
            .total,
            1
        );
    }

    #[test]
    fn legacy_archive_migrates_once_and_retains_search_after_header_cache_deletion() {
        let (_dir, db) = fixture();
        add(&db, 1, "INBOX", "Legacy searchable", "hash");
        db.execute_batch("DROP TRIGGER mail_archive_index_insert;DROP TRIGGER mail_archive_index_update;DROP TRIGGER mail_archive_index_delete;DROP TABLE mail_archive_search;DROP TABLE mail_archive_index;").unwrap();
        init_index(&db).unwrap();
        init_index(&db).unwrap();
        db.execute("DELETE FROM mail_messages", []).unwrap();
        assert_eq!(
            query(
                &db,
                "qa",
                &ArchiveQuery {
                    text: "searchable".into(),
                    ..Default::default()
                },
                0
            )
            .unwrap()
            .total,
            1
        );
        db.execute("DELETE FROM mail_full_messages", []).unwrap();
        assert_eq!(
            query(
                &db,
                "qa",
                &ArchiveQuery {
                    text: "searchable".into(),
                    ..Default::default()
                },
                0
            )
            .unwrap()
            .total,
            0
        );
    }
}
