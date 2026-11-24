use rusqlite::Connection;
use taomni_mail_api::{message::MailMessageHeader, pop3_store::SearchIndexRow};
use taomni_mail_engine::filters::{
    CandidateSelection, ensure_filter_mark, filter_mark, load_candidates,
};

pub(super) fn candidates(
    db: &Connection,
    account: &str,
    folder: &str,
    incoming: bool,
    uids: Option<Vec<u32>>,
) -> rusqlite::Result<Vec<(MailMessageHeader, Option<String>)>> {
    let selection = if incoming {
        match filter_mark(db, account, folder)? {
            Some(mark) => CandidateSelection::Above(mark),
            None => {
                ensure_filter_mark(db, account, folder)?;
                return Ok(Vec::new());
            }
        }
    } else {
        uids.map_or(CandidateSelection::All, CandidateSelection::Uids)
    };
    load_candidates(db, account, folder, &selection)
}

pub(crate) fn search_rows(
    db: &Connection,
    account: &str,
    bodies: bool,
) -> rusqlite::Result<Vec<SearchIndexRow>> {
    let sql = if bodies {
        "SELECT account_id||':'||folder||':'||uid, subject, body_text, COALESCE(date_ts,updated_at)
         FROM mail_messages WHERE account_id=?1 AND body_text IS NOT NULL
         ORDER BY COALESCE(date_ts,updated_at) DESC LIMIT 5000"
    } else {
        "SELECT account_id||':'||folder||':'||uid, subject,
                'from:'||COALESCE(from_name,'')||' '||COALESCE(from_addr,'')||' folder:'||folder,
                COALESCE(date_ts,updated_at)
         FROM mail_messages WHERE account_id=?1 ORDER BY COALESCE(date_ts,updated_at) DESC LIMIT 5000"
    };
    db.prepare(sql)?
        .query_map([account], |row| {
            Ok(SearchIndexRow {
                reference: row.get(0)?,
                subject: row.get(1)?,
                text: row.get(2)?,
                timestamp: row.get(3)?,
            })
        })?
        .collect()
}
