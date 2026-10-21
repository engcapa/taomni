use crate::mail::contacts;
use crate::mail::message_model::MailAddress;
use crate::mail::outgoing_model::MailSendRequest;
use crate::mail::result_model::MailContactSuggestion;
use crate::mail::smtp::parse_mailbox;
use crate::mail::utilities::now_ts;
use lettre::message::Mailbox;
use rusqlite::Connection;
use rusqlite::Result as SqlResult;
use rusqlite::params;
use std::collections::HashMap;
use std::collections::HashSet;

pub(in crate::mail) fn contact_email(address: &MailAddress) -> Option<String> {
    let email = address.address.as_deref()?.trim().to_lowercase();
    if email.contains('@')
        && !email
            .chars()
            .any(|ch| matches!(ch, ' ' | '<' | '>' | ',' | ';'))
    {
        Some(email)
    } else {
        None
    }
}

pub(in crate::mail) fn clean_contact_name(address: &MailAddress) -> Option<String> {
    address
        .name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(|name| name.to_string())
}

pub(in crate::mail) fn upsert_contact(
    conn: &Connection,
    account_id: &str,
    address: &MailAddress,
    seen_at: i64,
    message_count: i64,
    sent_count: i64,
    received_count: i64,
) -> SqlResult<bool> {
    let Some(email) = contact_email(address) else {
        return Ok(false);
    };
    let name = clean_contact_name(address);
    let now = now_ts();
    conn.execute(
        "INSERT INTO mail_contacts
         (account_id, email, name, first_seen_at, last_seen_at, message_count,
          sent_count, received_count, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(account_id, email) DO UPDATE SET
            name = CASE
              WHEN excluded.name IS NOT NULL AND excluded.name != '' THEN excluded.name
              ELSE mail_contacts.name
            END,
            first_seen_at = MIN(mail_contacts.first_seen_at, excluded.first_seen_at),
            last_seen_at = MAX(mail_contacts.last_seen_at, excluded.last_seen_at),
            message_count = mail_contacts.message_count + excluded.message_count,
            sent_count = mail_contacts.sent_count + excluded.sent_count,
            received_count = mail_contacts.received_count + excluded.received_count,
            updated_at = excluded.updated_at",
        params![
            account_id,
            email,
            name,
            seen_at,
            message_count,
            sent_count,
            received_count,
            now,
        ],
    )?;
    Ok(true)
}

pub(in crate::mail) fn reindex_cached_contacts(
    conn: &Connection,
    account_id: &str,
) -> SqlResult<usize> {
    conn.execute(
        "DELETE FROM mail_contacts WHERE account_id = ?1",
        params![account_id],
    )?;

    let rows = {
        let mut stmt = conn.prepare(
            "SELECT from_name, from_addr, to_json, cc_json, date_ts
             FROM mail_messages
             WHERE account_id = ?1",
        )?;
        let mapped = stmt.query_map(params![account_id], |row| {
            let from_name: Option<String> = row.get(0)?;
            let from_addr: Option<String> = row.get(1)?;
            let from = if from_name.is_some() || from_addr.is_some() {
                Some(MailAddress {
                    name: from_name,
                    address: from_addr,
                })
            } else {
                None
            };
            let to_json: String = row.get(2)?;
            let cc_json: String = row.get(3)?;
            let date_ts: Option<i64> = row.get(4)?;
            Ok((
                from,
                serde_json::from_str::<Vec<MailAddress>>(&to_json).unwrap_or_default(),
                serde_json::from_str::<Vec<MailAddress>>(&cc_json).unwrap_or_default(),
                date_ts,
            ))
        })?;
        mapped.collect::<SqlResult<Vec<_>>>()?
    };

    // One write per distinct address, even for a mailbox with tens of
    // thousands of messages from the same senders/mailing lists.
    let mut contacts: HashMap<String, (Option<String>, i64, i64, i64)> = HashMap::new();
    for (from, to, cc, date_ts) in rows {
        let seen_at = date_ts.unwrap_or_else(now_ts);
        let mut seen = HashSet::new();
        for address in from.into_iter().chain(to.into_iter()).chain(cc.into_iter()) {
            let Some(email) = contact_email(&address) else {
                continue;
            };
            if !seen.insert(email.clone()) {
                continue;
            }
            let entry = contacts.entry(email).or_insert((None, seen_at, seen_at, 0));
            if let Some(name) = clean_contact_name(&address) {
                entry.0 = Some(name);
            }
            entry.1 = entry.1.min(seen_at);
            entry.2 = entry.2.max(seen_at);
            entry.3 += 1;
        }
    }
    let mut insert = conn.prepare_cached(
        "INSERT INTO mail_contacts
         (account_id, email, name, first_seen_at, last_seen_at, message_count, sent_count, received_count, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?6, ?7)",
    )?;
    for (email, (name, first, last, count)) in &contacts {
        insert.execute(params![
            account_id,
            email,
            name,
            first,
            last,
            count,
            now_ts()
        ])?;
    }
    Ok(contacts.len())
}

pub(in crate::mail) fn mailbox_to_contact(mailbox: Mailbox) -> MailAddress {
    MailAddress {
        name: mailbox.name,
        address: Some(mailbox.email.to_string()),
    }
}

pub(in crate::mail) fn upsert_sent_contacts(
    conn: &Connection,
    account_id: &str,
    request: &MailSendRequest,
) -> SqlResult<usize> {
    let mut changed = 0;
    let now = now_ts();
    let mut seen = HashSet::new();
    for raw in request
        .to
        .iter()
        .chain(request.cc.iter())
        .chain(request.bcc.iter())
    {
        let Ok(mailbox) = parse_mailbox(raw) else {
            continue;
        };
        let address = mailbox_to_contact(mailbox);
        let Some(email) = contact_email(&address) else {
            continue;
        };
        if !seen.insert(email) {
            continue;
        }
        if upsert_contact(conn, account_id, &address, now, 1, 1, 0)? {
            changed += 1;
        }
    }
    Ok(changed)
}

pub(in crate::mail) fn escape_like(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

pub(in crate::mail) fn search_contacts(
    conn: &Connection,
    account_id: &str,
    query: &str,
    limit: u32,
) -> SqlResult<Vec<MailContactSuggestion>> {
    let normalized = query.trim().to_lowercase();
    if normalized.is_empty() {
        return Ok(Vec::new());
    }
    let like = format!("%{}%", escape_like(&normalized));
    let prefix = format!("{}%", escape_like(&normalized));
    let recent_cutoff = now_ts() - 90 * 86_400;
    let mut stmt = conn.prepare(
        "SELECT name, email, last_seen_at, sent_count, received_count, message_count,
                (CASE WHEN lower(email) = ?3 THEN 400 ELSE 0 END
                 + CASE WHEN lower(email) LIKE ?4 ESCAPE '\\' THEN 260 ELSE 0 END
                 + CASE WHEN lower(COALESCE(name, '')) LIKE ?4 ESCAPE '\\' THEN 180 ELSE 0 END
                 + CASE WHEN last_seen_at >= ?5 THEN 40 ELSE 0 END
                 + sent_count * 20
                 + received_count * 6
                 + message_count * 4) AS score
         FROM mail_contacts
         WHERE account_id = ?1
           AND (lower(email) LIKE ?2 ESCAPE '\\'
                OR lower(COALESCE(name, '')) LIKE ?2 ESCAPE '\\')
         ORDER BY score DESC, last_seen_at DESC, email ASC
         LIMIT ?6",
    )?;
    let rows = stmt.query_map(
        params![
            account_id,
            like,
            normalized,
            prefix,
            recent_cutoff,
            limit as i64,
        ],
        |row| {
            let sent_count: i64 = row.get(3)?;
            Ok(MailContactSuggestion {
                name: row.get(0)?,
                email: row.get(1)?,
                last_seen_at: row.get(2)?,
                source: if sent_count > 0 { "sent" } else { "history" }.into(),
                score: row.get(6)?,
            })
        },
    )?;
    rows.collect()
}
