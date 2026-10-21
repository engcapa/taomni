use super::*;

pub(super) fn cache_sync_result(
    conn: &Connection,
    account_id: &str,
    folders: &[MailFolder],
    messages: &[MailMessageCached],
    folder: &str,
    cache: &MailCacheSettings,
) -> SqlResult<()> {
    let tx = conn.unchecked_transaction()?;
    for folder in folders {
        reset_folder_if_uid_validity_changed(&tx, folder)?;
        upsert_folder(&tx, folder)?;
    }
    for message in messages {
        upsert_message(&tx, message)?;
    }
    prune_mail_cache(&tx, account_id, folder, cache)?;
    reindex_cached_contacts(&tx, account_id)?;
    tx.commit()
}

pub(super) fn reset_folder_if_uid_validity_changed(
    conn: &Connection,
    folder: &MailFolder,
) -> SqlResult<()> {
    let Some(next_uid_validity) = folder.uid_validity else {
        return Ok(());
    };
    let current: Option<Option<i64>> = conn
        .query_row(
            "SELECT uid_validity FROM mail_folders WHERE account_id = ?1 AND name = ?2",
            params![folder.account_id, folder.name],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(Some(current_uid_validity)) = current {
        if current_uid_validity as u32 != next_uid_validity {
            sync::reset_folder_cache(conn, &folder.account_id, &folder.name)?;
        }
    }
    Ok(())
}

pub(super) fn upsert_folder(conn: &Connection, folder: &MailFolder) -> SqlResult<()> {
    let flags_json = serde_json::to_string(&folder.flags).unwrap_or_else(|_| "[]".into());
    conn.execute(
        "INSERT INTO mail_folders
         (account_id, name, delimiter, flags_json, uid_validity, uid_next, total, unread, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(account_id, name) DO UPDATE SET
            delimiter = excluded.delimiter,
            flags_json = excluded.flags_json,
            uid_validity = COALESCE(excluded.uid_validity, mail_folders.uid_validity),
            uid_next = COALESCE(excluded.uid_next, mail_folders.uid_next),
            total = COALESCE(excluded.total, mail_folders.total),
            unread = COALESCE(excluded.unread, mail_folders.unread),
            updated_at = excluded.updated_at",
        params![
            folder.account_id,
            folder.name,
            folder.delimiter,
            flags_json,
            folder.uid_validity,
            folder.uid_next,
            folder.total,
            folder.unread,
            folder.updated_at,
        ],
    )?;
    Ok(())
}

pub(super) fn upsert_message(conn: &Connection, message: &MailMessageCached) -> SqlResult<()> {
    upsert_message_at(conn, message, None)
}

pub(super) fn upsert_message_at(
    conn: &Connection,
    message: &MailMessageCached,
    observed_at: Option<i64>,
) -> SqlResult<()> {
    let header = &message.header;
    let to_json = serde_json::to_string(&header.to).unwrap_or_else(|_| "[]".into());
    let cc_json = serde_json::to_string(&header.cc).unwrap_or_else(|_| "[]".into());
    let flags_json = serde_json::to_string(&header.flags).unwrap_or_else(|_| "[]".into());
    let attachments_json =
        serde_json::to_string(&header.attachments).unwrap_or_else(|_| "[]".into());
    conn.execute(
        "INSERT INTO mail_messages
         (account_id, folder, uid, message_id, subject, from_name, from_addr,
          to_json, cc_json, date_ts, flags_json, has_attachments, attachment_count,
          attachments_json, snippet, body_text, body_html, body_cached_at, raw_size, updated_at,
          internal_ts, in_reply_to, references_json, list_unsubscribe_json, receipt_to)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
                 ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?23, ?24, ?25, ?26)
         ON CONFLICT(account_id, folder, uid) DO UPDATE SET
            message_id = COALESCE(excluded.message_id, mail_messages.message_id),
            subject = CASE WHEN excluded.subject != '' THEN excluded.subject ELSE mail_messages.subject END,
            from_name = COALESCE(excluded.from_name, mail_messages.from_name),
            from_addr = COALESCE(excluded.from_addr, mail_messages.from_addr),
            to_json = CASE WHEN excluded.to_json != '[]' THEN excluded.to_json ELSE mail_messages.to_json END,
            cc_json = CASE WHEN excluded.cc_json != '[]' THEN excluded.cc_json ELSE mail_messages.cc_json END,
            date_ts = COALESCE(excluded.date_ts, mail_messages.date_ts),
            flags_json = CASE WHEN ?27 IS NOT NULL AND COALESCE(mail_messages.flags_local_at, 0) >= ?27 THEN mail_messages.flags_json
                              WHEN ?22 = 1 OR excluded.flags_json != '[]' THEN excluded.flags_json ELSE mail_messages.flags_json END,
            internal_ts = COALESCE(excluded.internal_ts, mail_messages.internal_ts),
            in_reply_to = COALESCE(excluded.in_reply_to, mail_messages.in_reply_to),
            references_json = CASE WHEN excluded.references_json != '[]'
                                   THEN excluded.references_json ELSE mail_messages.references_json END,
            list_unsubscribe_json = COALESCE(excluded.list_unsubscribe_json, mail_messages.list_unsubscribe_json),
            receipt_to = COALESCE(excluded.receipt_to, mail_messages.receipt_to),
            has_attachments = CASE
                WHEN excluded.attachments_json != '[]' OR excluded.has_attachments = 1
                THEN excluded.has_attachments
                ELSE mail_messages.has_attachments
            END,
            attachment_count = CASE
                WHEN excluded.attachments_json != '[]' OR excluded.attachment_count > 0
                THEN excluded.attachment_count
                ELSE mail_messages.attachment_count
            END,
            attachments_json = CASE WHEN excluded.attachments_json != '[]' THEN excluded.attachments_json ELSE mail_messages.attachments_json END,
            snippet = COALESCE(excluded.snippet, mail_messages.snippet),
            body_text = COALESCE(excluded.body_text, mail_messages.body_text),
            body_html = COALESCE(excluded.body_html, mail_messages.body_html),
            body_cached_at = COALESCE(excluded.body_cached_at, mail_messages.body_cached_at),
            raw_size = COALESCE(excluded.raw_size, mail_messages.raw_size),
            updated_at = excluded.updated_at",
        params![
            header.account_id,
            header.folder,
            header.uid,
            header.message_id,
            header.subject,
            header.from.as_ref().and_then(|a| a.name.clone()),
            header.from.as_ref().and_then(|a| a.address.clone()),
            to_json,
            cc_json,
            header.date_ts,
            flags_json,
            header.has_attachments as i64,
            header.attachment_count as i64,
            attachments_json,
            header.snippet,
            message.body_text,
            message.body_html,
            message.body_cached_at,
            header.raw_size,
            now_ts(),
            message.internal_ts,
            message.flags_authoritative as i64,
            header.in_reply_to,
            serde_json::to_string(&header.references).unwrap_or_else(|_| "[]".into()),
            header
                .list_unsubscribe
                .as_ref()
                .and_then(|list| serde_json::to_string(list).ok()),
            header.receipt_to,
            observed_at,
        ],
    )?;
    Ok(())
}

pub(super) fn contact_email(address: &MailAddress) -> Option<String> {
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

/// Sync plans normally contain only missing UIDs. Index their contacts once,
/// instead of rebuilding all accounts' cached addresses after every page.
/// Replayed/replaced rows request a rebuild so counts stay idempotent.
pub(super) fn cache_synced_messages(
    conn: &Connection,
    messages: &[MailMessageCached],
    started_ms: i64,
) -> SqlResult<bool> {
    let mut replaced = false;
    let mut exists = conn.prepare_cached(
        "SELECT EXISTS(SELECT 1 FROM mail_messages WHERE account_id = ?1 AND folder = ?2 AND uid = ?3)",
    )?;
    for message in messages {
        let header = &message.header;
        let known: bool = exists.query_row(
            params![header.account_id, header.folder, header.uid],
            |row| row.get(0),
        )?;
        upsert_message_at(conn, message, Some(started_ms))?;
        if known {
            replaced = true;
        } else {
            let mut seen = HashSet::new();
            for address in header.from.iter().chain(&header.to).chain(&header.cc) {
                let Some(email) = contact_email(address) else {
                    continue;
                };
                if seen.insert(email) {
                    upsert_contact(
                        conn,
                        &header.account_id,
                        address,
                        header.date_ts.unwrap_or_else(now_ts),
                        1,
                        0,
                        1,
                    )?;
                }
            }
        }
    }
    Ok(replaced)
}

pub(super) fn clean_contact_name(address: &MailAddress) -> Option<String> {
    address
        .name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(|name| name.to_string())
}

pub(super) fn upsert_contact(
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

pub(super) fn reindex_cached_contacts(conn: &Connection, account_id: &str) -> SqlResult<usize> {
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

pub(super) fn mailbox_to_contact(mailbox: Mailbox) -> MailAddress {
    MailAddress {
        name: mailbox.name,
        address: Some(mailbox.email.to_string()),
    }
}

pub(super) fn upsert_sent_contacts(
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

pub(super) fn escape_like(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

pub(super) fn search_contacts(
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

pub(super) fn prune_mail_cache(
    conn: &Connection,
    account_id: &str,
    folder: &str,
    cache: &MailCacheSettings,
) -> SqlResult<usize> {
    // POP3 mail exists only locally: never prune it (TASK-21).
    if pop3::has_local_store(conn, account_id)? {
        return Ok(0);
    }
    // Header pruning only ever cuts the low (oldest-UID) end so the cached span
    // stays contiguous; `sync::apply_prune_cut` moves the watermark with it.
    // Retention uses the server arrival time (INTERNALDATE), not the sender's
    // `Date:` header, so a freshly delivered but back-dated message survives.
    let mut cut: Option<u32> = None;
    let retain_headers: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM mail_archive_preferences WHERE account_id=?1)",
        [account_id],
        |r| r.get(0),
    )?;
    if !retain_headers && cache.header_limit_per_folder > 0 {
        let first_dropped: Option<u32> = conn
            .query_row(
                "SELECT uid FROM mail_messages
                 WHERE account_id = ?1 AND folder = ?2
                 ORDER BY uid DESC
                 LIMIT 1 OFFSET ?3",
                params![account_id, folder, cache.header_limit_per_folder],
                |row| row.get(0),
            )
            .optional()?;
        cut = first_dropped.map(|uid| uid.saturating_add(1));
    }
    if !retain_headers && cache.header_retention_days > 0 {
        let cutoff = now_ts() - (cache.header_retention_days as i64 * 86_400);
        let (oldest_recent, max_uid): (Option<u32>, Option<u32>) = conn.query_row(
            "SELECT
                MIN(CASE WHEN COALESCE(internal_ts, date_ts) IS NULL
                          OR COALESCE(internal_ts, date_ts) >= ?3 THEN uid END),
                MAX(uid)
             FROM mail_messages WHERE account_id = ?1 AND folder = ?2",
            params![account_id, folder, cutoff],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let retention_cut = match (oldest_recent, max_uid) {
            (Some(uid), _) => Some(uid),
            (None, Some(max_uid)) => Some(max_uid.saturating_add(1)),
            (None, None) => None,
        };
        cut = match (cut, retention_cut) {
            (Some(a), Some(b)) => Some(a.max(b)),
            (a, b) => a.or(b),
        };
    }
    let pruned = if let Some(cut) = cut {
        sync::apply_prune_cut(conn, account_id, folder, cut)?
    } else {
        0
    };
    if cache.body_recent_limit == 0 {
        conn.execute(
            "UPDATE mail_messages
             SET body_text = NULL, body_html = NULL, body_cached_at = NULL
             WHERE account_id = ?1 AND folder = ?2
               AND (body_cached_at IS NOT NULL OR body_text IS NOT NULL OR body_html IS NOT NULL)",
            params![account_id, folder],
        )?;
    } else {
        conn.execute(
            "UPDATE mail_messages
             SET body_text = NULL, body_html = NULL, body_cached_at = NULL
             WHERE account_id = ?1 AND folder = ?2
               AND (body_cached_at IS NOT NULL OR body_text IS NOT NULL OR body_html IS NOT NULL)
               AND rowid NOT IN (
                 SELECT rowid FROM mail_messages
                 WHERE account_id = ?1 AND folder = ?2 AND body_cached_at IS NOT NULL
                 ORDER BY COALESCE(date_ts, 0) DESC, uid DESC
                 LIMIT ?3
               )",
            params![account_id, folder, cache.body_recent_limit],
        )?;
    }
    Ok(pruned)
}

pub(super) fn list_cached_folders(
    conn: &Connection,
    account_id: &str,
) -> SqlResult<Vec<MailFolder>> {
    let mut stmt = conn.prepare(
        "SELECT f.account_id, f.name, f.delimiter, f.flags_json, f.uid_validity, f.uid_next,
                f.total, f.unread, f.updated_at, f.sync_low_uid, f.sync_high_uid,
                f.sync_complete, f.last_error,
                (SELECT COUNT(*) FROM mail_messages m
                  WHERE m.account_id = f.account_id AND m.folder = f.name)
         FROM mail_folders f
         WHERE f.account_id = ?1
         ORDER BY CASE WHEN f.name = 'INBOX' THEN 0 ELSE 1 END, f.name COLLATE NOCASE",
    )?;
    let rows = stmt.query_map(params![account_id], |row| {
        let flags_json: String = row.get(3)?;
        let name: String = row.get(1)?;
        let complete: i64 = row.get(11)?;
        let cached_count: i64 = row.get(13)?;
        Ok(MailFolder {
            account_id: row.get(0)?,
            display_name: decode_imap_modified_utf7(&name),
            name,
            delimiter: row.get(2)?,
            flags: serde_json::from_str(&flags_json).unwrap_or_default(),
            uid_validity: row.get(4)?,
            uid_next: row.get(5)?,
            total: row.get(6)?,
            unread: row.get(7)?,
            updated_at: row.get(8)?,
            sync_low_uid: row.get(9)?,
            sync_high_uid: row.get(10)?,
            sync_complete: complete != 0,
            cached_count: Some(cached_count.max(0) as u32),
            last_error: row.get(12)?,
        })
    })?;
    rows.collect()
}

pub(super) fn list_cached_messages(
    conn: &Connection,
    account_id: &str,
    folder: &str,
    limit: u32,
    offset: u32,
) -> SqlResult<Vec<MailMessageHeader>> {
    let mut stmt = conn.prepare(
        "SELECT account_id, folder, uid, message_id, subject, from_name, from_addr,
                to_json, cc_json, date_ts, flags_json, has_attachments, attachment_count,
                attachments_json, snippet, raw_size, body_cached_at, in_reply_to, references_json,
                list_unsubscribe_json, receipt_to
         FROM mail_messages
         WHERE account_id = ?1 AND folder = ?2
         ORDER BY COALESCE(date_ts, 0) DESC, uid DESC
         LIMIT ?3 OFFSET ?4",
    )?;
    let rows = stmt.query_map(params![account_id, folder, limit, offset], row_to_header)?;
    rows.collect()
}

/// One cached header.
pub(super) fn cached_header(
    conn: &Connection,
    account_id: &str,
    folder: &str,
    uid: u32,
) -> SqlResult<Option<MailMessageHeader>> {
    conn.query_row(
        "SELECT account_id, folder, uid, message_id, subject, from_name, from_addr,
                to_json, cc_json, date_ts, flags_json, has_attachments, attachment_count,
                attachments_json, snippet, raw_size, body_cached_at, in_reply_to, references_json,
                list_unsubscribe_json, receipt_to
         FROM mail_messages
         WHERE account_id = ?1 AND folder = ?2 AND uid = ?3",
        params![account_id, folder, uid],
        row_to_header,
    )
    .optional()
}

pub(super) fn unread_cached_uids(
    conn: &Connection,
    account_id: &str,
    folder: &str,
) -> SqlResult<Vec<u32>> {
    let mut stmt = conn.prepare(
        "SELECT uid, flags_json
         FROM mail_messages
         WHERE account_id = ?1 AND folder = ?2",
    )?;
    let rows = stmt.query_map(params![account_id, folder], |row| {
        Ok((row.get::<_, i64>(0)? as u32, row.get::<_, String>(1)?))
    })?;
    let mut uids = Vec::new();
    for row in rows {
        let (uid, flags_json) = row?;
        let flags: Vec<String> = serde_json::from_str(&flags_json).unwrap_or_default();
        if !flags_include_seen(&flags) {
            uids.push(uid);
        }
    }
    Ok(uids)
}

pub(super) fn mark_cached_messages_read(
    conn: &Connection,
    account_id: &str,
    folder: &str,
    uids: &[u32],
) -> SqlResult<()> {
    let mut changed = 0usize;
    let mut select_flags = conn.prepare_cached(
        "SELECT flags_json FROM mail_messages WHERE account_id = ?1 AND folder = ?2 AND uid = ?3",
    )?;
    let mut update_flags = conn.prepare_cached(
        "UPDATE mail_messages SET flags_json = ?4, updated_at = ?5, flags_local_at = ?6
         WHERE account_id = ?1 AND folder = ?2 AND uid = ?3",
    )?;
    for uid in uids {
        let flags_json: Option<String> = select_flags
            .query_row(params![account_id, folder, *uid as i64], |row| row.get(0))
            .optional()?;
        let Some(flags_json) = flags_json else {
            continue;
        };
        let mut flags: Vec<String> = serde_json::from_str(&flags_json).unwrap_or_default();
        if flags_include_seen(&flags) {
            continue;
        }
        flags.push("\\Seen".into());
        let next_flags_json = serde_json::to_string(&flags).unwrap_or_else(|_| "[]".into());
        update_flags.execute(params![
            account_id,
            folder,
            *uid as i64,
            next_flags_json,
            now_ts(),
            sync::now_ms()
        ])?;
        changed += 1;
    }
    if changed > 0 {
        conn.execute(
            "UPDATE mail_folders
             SET unread = CASE
               WHEN unread IS NULL THEN NULL
               WHEN unread <= ?3 THEN 0
               ELSE unread - ?3
             END,
             updated_at = ?4
             WHERE account_id = ?1 AND name = ?2",
            params![account_id, folder, changed as i64, now_ts()],
        )?;
    }
    Ok(())
}

pub(super) fn flags_include_seen(flags: &[String]) -> bool {
    flags.iter().any(|flag| flag.eq_ignore_ascii_case("\\Seen"))
}

pub(super) fn update_cached_flags(
    conn: &Connection,
    account_id: &str,
    folder: &str,
    uids: &[u32],
    add: &[String],
    remove: &[String],
) -> SqlResult<()> {
    if uids.is_empty() || (add.is_empty() && remove.is_empty()) {
        return Ok(());
    }
    let mut select_flags = conn.prepare_cached(
        "SELECT flags_json FROM mail_messages WHERE account_id = ?1 AND folder = ?2 AND uid = ?3",
    )?;
    let mut update_flags = conn.prepare_cached(
        "UPDATE mail_messages SET flags_json = ?4, updated_at = ?5, flags_local_at = ?6
         WHERE account_id = ?1 AND folder = ?2 AND uid = ?3",
    )?;
    for uid in uids {
        let flags_json: Option<String> = select_flags
            .query_row(params![account_id, folder, *uid as i64], |row| row.get(0))
            .optional()?;
        let Some(flags_json) = flags_json else {
            continue;
        };
        let mut flags: Vec<String> = serde_json::from_str(&flags_json).unwrap_or_default();
        flags.retain(|flag| !remove.iter().any(|r| flag.eq_ignore_ascii_case(r)));
        for flag in add {
            if !flags
                .iter()
                .any(|existing| existing.eq_ignore_ascii_case(flag))
            {
                flags.push(flag.clone());
            }
        }
        let next_flags_json = serde_json::to_string(&flags).unwrap_or_else(|_| "[]".into());
        update_flags.execute(params![
            account_id,
            folder,
            *uid as i64,
            next_flags_json,
            now_ts(),
            sync::now_ms()
        ])?;
    }
    Ok(())
}

pub(super) fn remove_cached_messages(
    conn: &Connection,
    account_id: &str,
    folder: &str,
    uids: &[u32],
) -> SqlResult<()> {
    let mut delete = conn.prepare_cached(
        "DELETE FROM mail_messages WHERE account_id = ?1 AND folder = ?2 AND uid = ?3",
    )?;
    for uid in uids {
        delete.execute(params![account_id, folder, *uid as i64])?;
    }
    Ok(())
}

pub(super) fn purge_cached_folder(
    conn: &Connection,
    account_id: &str,
    folder: &str,
) -> SqlResult<()> {
    // Remove the folder and its messages, plus any nested subfolders addressed
    // with the common IMAP hierarchy delimiters.
    conn.execute(
        "DELETE FROM mail_messages
         WHERE account_id = ?1 AND (folder = ?2 OR folder LIKE ?3 OR folder LIKE ?4)",
        params![
            account_id,
            folder,
            format!("{folder}/%"),
            format!("{folder}.%")
        ],
    )?;
    conn.execute(
        "DELETE FROM mail_folders
         WHERE account_id = ?1 AND (name = ?2 OR name LIKE ?3 OR name LIKE ?4)",
        params![
            account_id,
            folder,
            format!("{folder}/%"),
            format!("{folder}.%")
        ],
    )?;
    Ok(())
}

pub(super) fn get_cached_body(
    conn: &Connection,
    account_id: &str,
    folder: &str,
    uid: u32,
) -> SqlResult<Option<MailMessageBody>> {
    conn.query_row(
        "SELECT account_id, folder, uid, message_id, subject, from_name, from_addr,
                to_json, cc_json, date_ts, flags_json, has_attachments, attachment_count,
                attachments_json, snippet, raw_size, body_cached_at, in_reply_to, references_json,
                list_unsubscribe_json, receipt_to, body_text, body_html
         FROM mail_messages
         WHERE account_id = ?1 AND folder = ?2 AND uid = ?3
           AND body_cached_at IS NOT NULL
           AND (body_text IS NOT NULL OR body_html IS NOT NULL)",
        params![account_id, folder, uid],
        |row| {
            let mut header = row_to_header(row)?;
            let body_text: Option<String> = row.get(21)?;
            let body_html: Option<String> = row.get(22)?;
            header.body_cached = true;
            Ok(MailMessageBody {
                account_id: header.account_id,
                folder: header.folder,
                uid: header.uid,
                message_id: header.message_id,
                subject: header.subject,
                text: body_text,
                html: body_html,
                snippet: header.snippet,
                attachments: header.attachments,
                raw_size: header.raw_size,
                cached_at: row.get(16)?,
                source: "cache".into(),
            })
        },
    )
    .optional()
}

pub(super) fn row_to_header(row: &rusqlite::Row<'_>) -> SqlResult<MailMessageHeader> {
    let to_json: String = row.get(7)?;
    let cc_json: String = row.get(8)?;
    let flags_json: String = row.get(10)?;
    let attachments_json: String = row.get(13)?;
    let from_name: Option<String> = row.get(5)?;
    let from_addr: Option<String> = row.get(6)?;
    let from = if from_name.is_some() || from_addr.is_some() {
        Some(MailAddress {
            name: from_name,
            address: from_addr,
        })
    } else {
        None
    };
    let body_cached_at: Option<i64> = row.get(16)?;
    Ok(MailMessageHeader {
        account_id: row.get(0)?,
        folder: row.get(1)?,
        uid: row.get::<_, i64>(2)? as u32,
        message_id: row.get(3)?,
        subject: row.get(4)?,
        from,
        to: serde_json::from_str(&to_json).unwrap_or_default(),
        cc: serde_json::from_str(&cc_json).unwrap_or_default(),
        date_ts: row.get(9)?,
        flags: serde_json::from_str(&flags_json).unwrap_or_default(),
        has_attachments: row.get::<_, i64>(11)? != 0,
        attachment_count: row.get::<_, i64>(12)? as usize,
        attachments: serde_json::from_str(&attachments_json).unwrap_or_default(),
        snippet: row.get(14)?,
        raw_size: row.get(15)?,
        body_cached: body_cached_at.is_some(),
        in_reply_to: row.get(17)?,
        references: row
            .get::<_, Option<String>>(18)?
            .and_then(|json| serde_json::from_str(&json).ok())
            .unwrap_or_default(),
        list_unsubscribe: row
            .get::<_, Option<String>>(19)?
            .and_then(|json| serde_json::from_str(&json).ok()),
        receipt_to: row.get(20)?,
    })
}

pub(super) fn cached_to_body(message: MailMessageCached, source: &str) -> MailMessageBody {
    MailMessageBody {
        account_id: message.header.account_id,
        folder: message.header.folder,
        uid: message.header.uid,
        message_id: message.header.message_id,
        subject: message.header.subject,
        text: message.body_text,
        html: message.body_html,
        snippet: message.header.snippet,
        attachments: message.header.attachments,
        raw_size: message.header.raw_size,
        cached_at: message.body_cached_at,
        source: source.into(),
    }
}
