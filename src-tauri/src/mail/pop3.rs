//! POP3 accounts with a local mailbox store (TASK-21, DEC-15).
//!
//! DEC-15: POP3 is implemented in-tree (a small line protocol) instead of a
//! new dependency; APOP uses `md-5`, already in the lockfile.
//!
//! POP3 has no server folders, so mail downloaded with `UIDL` + `RETR` lives
//! in local folders (INBOX, Sent, Drafts, Trash, Junk and user folders) in the
//! same `mail_messages` table, plus the raw message in `mail_local_raw`.
//! Every mail command branches here for POP3 accounts, so the tab works
//! unchanged. `UIDL` values already downloaded are remembered, so repeated
//! syncs never duplicate mail (AC-65); "leave on server N days" deletes older
//! downloaded mail on the server (AC-66). Local mail is never pruned by the
//! header retention settings — it has no other copy.

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use rusqlite::{Connection, OptionalExtension, Result as SqlResult, params};

use super::{
    MailAccountConfig, MailAuthMode, MailConnectionSecurity, MailFolder, MailMessageCached,
    ResolvedMailAccount, certs, list_cached_folders, mail_effective_endpoint, now_ts,
    parse_body_message, tcp_connect, upsert_folder, upsert_message, xoauth2_sasl_response,
};

/// Messages downloaded per sync call; the tab repeats while `more`.
pub(super) const POP3_FETCH_BATCH: usize = 50;
const READ_TIMEOUT: Duration = Duration::from_secs(60);
/// Local folders every POP3 account has, with their SPECIAL-USE attribute.
const LOCAL_FOLDERS: [(&str, &str); 5] = [
    ("INBOX", ""),
    ("Sent", "\\Sent"),
    ("Drafts", "\\Drafts"),
    ("Trash", "\\Trash"),
    ("Junk", "\\Junk"),
];

pub(super) fn is_pop3(config: &MailAccountConfig) -> bool {
    config.incoming == super::MailIncomingProtocol::Pop3
}

// ---------------------------------------------------------------------------
// Protocol client
// ---------------------------------------------------------------------------

pub(super) struct Pop3Conn<S: Read + Write> {
    reader: BufReader<S>,
}

impl<S: Read + Write> Pop3Conn<S> {
    fn new(stream: S) -> Self {
        Self {
            reader: BufReader::new(stream),
        }
    }

    fn line(&mut self) -> Result<String, String> {
        let mut line = String::new();
        self.reader
            .read_line(&mut line)
            .map_err(|e| format!("POP3 read failed: {e}"))?;
        if line.is_empty() {
            return Err("POP3 server closed the connection".into());
        }
        Ok(line.trim_end_matches(['\r', '\n']).to_string())
    }

    fn status(&mut self) -> Result<String, String> {
        let line = self.line()?;
        if let Some(rest) = line.strip_prefix("+OK") {
            Ok(rest.trim().to_string())
        } else {
            Err(format!("POP3 error: {line}"))
        }
    }

    fn command(&mut self, command: &str) -> Result<String, String> {
        let stream = self.reader.get_mut();
        stream
            .write_all(format!("{command}\r\n").as_bytes())
            .and_then(|_| stream.flush())
            .map_err(|e| format!("POP3 write failed: {e}"))?;
        self.status()
    }

    /// Body of a multi-line response, dot-unstuffed, CRLF line endings.
    fn multiline(&mut self) -> Result<Vec<u8>, String> {
        let mut out = Vec::new();
        loop {
            let mut raw = Vec::new();
            self.reader
                .read_until(b'\n', &mut raw)
                .map_err(|e| format!("POP3 read failed: {e}"))?;
            if raw.is_empty() {
                return Err("POP3 server closed the connection".into());
            }
            let line = raw
                .strip_suffix(b"\n")
                .map(|l| l.strip_suffix(b"\r").unwrap_or(l))
                .unwrap_or(&raw);
            if line == b"." {
                return Ok(out);
            }
            let line = line
                .strip_prefix(b".")
                .filter(|l| l.starts_with(b"."))
                .unwrap_or(line);
            out.extend_from_slice(line);
            out.extend_from_slice(b"\r\n");
        }
    }

    fn into_inner(self) -> S {
        self.reader.into_inner()
    }
}

/// APOP digest: MD5(timestamp + password), lowercase hex (RFC 1939 §7).
pub(super) fn apop_digest(timestamp: &str, password: &str) -> String {
    use md5::{Digest, Md5};
    Md5::digest(format!("{timestamp}{password}").as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn greeting_timestamp(greeting: &str) -> Option<String> {
    let start = greeting.find('<')?;
    let end = greeting[start..].find('>')? + start;
    let stamp = &greeting[start..=end];
    stamp.contains('@').then(|| stamp.to_string())
}

fn authenticate<S: Read + Write>(
    conn: &mut Pop3Conn<S>,
    account: &ResolvedMailAccount,
    greeting: &str,
    encrypted: bool,
) -> Result<(), String> {
    let user = account.imap_username.as_str();
    let secret = account.imap_password.as_str();
    match account.auth_mode {
        MailAuthMode::OAuth2 => {
            let sasl = BASE64.encode(xoauth2_sasl_response(user, secret));
            conn.command(&format!("AUTH XOAUTH2 {sasl}"))
                .map(|_| ())
                .map_err(|e| format!("POP3 XOAUTH2 authentication failed: {e}"))
        }
        MailAuthMode::Password => {
            // Plain USER/PASS only over TLS; APOP keeps the password off an
            // unencrypted wire when the server offers it.
            if !encrypted {
                if let Some(stamp) = greeting_timestamp(greeting) {
                    return conn
                        .command(&format!("APOP {user} {}", apop_digest(&stamp, secret)))
                        .map(|_| ())
                        .map_err(|e| format!("POP3 APOP authentication failed: {e}"));
                }
            }
            conn.command(&format!("USER {user}"))
                .map_err(|e| format!("POP3 USER rejected: {e}"))?;
            conn.command(&format!("PASS {secret}"))
                .map(|_| ())
                .map_err(|_| {
                    "POP3 authentication failed (check the user name and password)".to_string()
                })
        }
    }
}

pub(super) enum Pop3Client {
    Plain(Pop3Conn<TcpStream>),
    Tls(Pop3Conn<native_tls::TlsStream<TcpStream>>),
}

macro_rules! each {
    ($self:ident, $conn:ident => $body:expr) => {
        match $self {
            Pop3Client::Plain($conn) => $body,
            Pop3Client::Tls($conn) => $body,
        }
    };
}

impl Pop3Client {
    pub(super) fn connect(
        account: &ResolvedMailAccount,
        runtime: &tokio::runtime::Handle,
    ) -> Result<Self, String> {
        let host = account.config.imap.host.trim();
        let port = account.config.imap.port;
        let (connect_host, connect_port, _forward) =
            mail_effective_endpoint(account, host, port, runtime)?;
        let stream = tcp_connect(&connect_host, connect_port)?;
        stream.set_read_timeout(Some(READ_TIMEOUT)).ok();
        stream.set_write_timeout(Some(READ_TIMEOUT)).ok();
        let trusted = account.config.imap.trusted_cert.as_deref();
        let pinned = trusted.is_some_and(|v| !v.trim().is_empty());
        let tls = |stream: TcpStream| -> Result<native_tls::TlsStream<TcpStream>, String> {
            certs::tls_connector(trusted)?
                .connect(host, stream)
                .map_err(|e| {
                    certs::certificate_error_hint(
                        &format!("POP3 TLS handshake failed: {e}"),
                        pinned,
                    )
                })
        };
        let mut client = match account.config.imap.security {
            MailConnectionSecurity::Tls => {
                let mut conn = Pop3Conn::new(tls(stream)?);
                let greeting = conn.status()?;
                authenticate(&mut conn, account, &greeting, true)?;
                Pop3Client::Tls(conn)
            }
            MailConnectionSecurity::Starttls => {
                let mut plain = Pop3Conn::new(stream);
                plain.status()?;
                plain
                    .command("STLS")
                    .map_err(|e| format!("POP3 STLS failed: {e}"))?;
                let mut conn = Pop3Conn::new(tls(plain.into_inner())?);
                authenticate(&mut conn, account, "", true)?;
                Pop3Client::Tls(conn)
            }
            MailConnectionSecurity::None => {
                let mut conn = Pop3Conn::new(stream);
                let greeting = conn.status()?;
                authenticate(&mut conn, account, &greeting, false)?;
                Pop3Client::Plain(conn)
            }
        };
        client.stat()?;
        Ok(client)
    }

    pub(super) fn stat(&mut self) -> Result<(usize, u64), String> {
        let reply = each!(self, c => c.command("STAT"))?;
        let mut parts = reply.split_whitespace();
        let count = parts.next().and_then(|v| v.parse().ok()).unwrap_or(0);
        let size = parts.next().and_then(|v| v.parse().ok()).unwrap_or(0);
        Ok((count, size))
    }

    /// `(message number, unique id)` in server order.
    pub(super) fn uidl(&mut self) -> Result<Vec<(u32, String)>, String> {
        each!(self, c => c.command("UIDL")).map_err(|e| format!("POP3 UIDL failed: {e}"))?;
        let body = each!(self, c => c.multiline())?;
        Ok(String::from_utf8_lossy(&body)
            .lines()
            .filter_map(|line| {
                let (number, id) = line.trim().split_once(' ')?;
                Some((number.parse().ok()?, id.trim().to_string()))
            })
            .collect())
    }

    pub(super) fn retr(&mut self, number: u32) -> Result<Vec<u8>, String> {
        each!(self, c => c.command(&format!("RETR {number}")))
            .map_err(|e| format!("POP3 RETR {number} failed: {e}"))?;
        each!(self, c => c.multiline())
    }

    pub(super) fn dele(&mut self, number: u32) -> Result<(), String> {
        each!(self, c => c.command(&format!("DELE {number}")))
            .map(|_| ())
            .map_err(|e| format!("POP3 DELE {number} failed: {e}"))
    }

    /// QUIT commits DELE marks (RFC 1939 UPDATE state).
    pub(super) fn quit(mut self) -> Result<(), String> {
        let client = &mut self;
        each!(client, c => c.command("QUIT")).map(|_| ())
    }
}

// ---------------------------------------------------------------------------
// Local store
// ---------------------------------------------------------------------------

pub(super) fn migrate_local_tables(conn: &Connection) -> SqlResult<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS mail_local_raw (
            account_id TEXT NOT NULL,
            folder TEXT NOT NULL,
            uid INTEGER NOT NULL,
            raw BLOB NOT NULL,
            PRIMARY KEY (account_id, folder, uid)
         );
         CREATE TABLE IF NOT EXISTS mail_pop3_uidl (
            account_id TEXT NOT NULL,
            uidl TEXT NOT NULL,
            fetched_at INTEGER NOT NULL,
            deleted INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (account_id, uidl)
         );",
    )
}

/// True once the account keeps mail only locally (guards cache clearing).
pub(super) fn has_local_store(conn: &Connection, account_id: &str) -> SqlResult<bool> {
    migrate_local_tables(conn)?;
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM mail_pop3_uidl WHERE account_id = ?1)
             OR EXISTS(SELECT 1 FROM mail_local_raw WHERE account_id = ?1)",
        params![account_id],
        |row| row.get::<_, bool>(0),
    )
}

fn local_folder(account_id: &str, name: &str, attribute: &str) -> MailFolder {
    let mut flags = vec![
        "\\HasNoChildren".to_string(),
        super::folders::SUBSCRIBED_ATTRIBUTE.to_string(),
    ];
    if !attribute.is_empty() {
        flags.push(attribute.to_string());
    }
    MailFolder {
        account_id: account_id.to_string(),
        name: name.to_string(),
        display_name: name.to_string(),
        delimiter: Some("/".into()),
        flags,
        uid_validity: Some(1),
        updated_at: now_ts(),
        ..MailFolder::default()
    }
}

pub(super) fn ensure_local_folders(conn: &Connection, account_id: &str) -> SqlResult<()> {
    migrate_local_tables(conn)?;
    let existing: HashSet<String> = list_cached_folders(conn, account_id)?
        .into_iter()
        .map(|folder| folder.name)
        .collect();
    for (name, attribute) in LOCAL_FOLDERS {
        if !existing.contains(name) {
            upsert_folder(conn, &local_folder(account_id, name, attribute))?;
        }
    }
    Ok(())
}

pub(super) fn create_local_folder(
    conn: &Connection,
    account_id: &str,
    name: &str,
) -> SqlResult<()> {
    ensure_local_folders(conn, account_id)?;
    upsert_folder(conn, &local_folder(account_id, name, ""))?;
    refresh_counts(conn, account_id, name)
}

/// Recompute a local folder's totals and mark it fully synced.
pub(super) fn refresh_counts(conn: &Connection, account_id: &str, folder: &str) -> SqlResult<()> {
    conn.execute(
        "UPDATE mail_folders SET
            total = (SELECT COUNT(*) FROM mail_messages WHERE account_id = ?1 AND folder = ?2),
            unread = (SELECT COUNT(*) FROM mail_messages WHERE account_id = ?1 AND folder = ?2
                      AND flags_json NOT LIKE '%\\\\Seen%'),
            uid_next = (SELECT COALESCE(MAX(uid), 0) + 1 FROM mail_messages
                        WHERE account_id = ?1 AND folder = ?2),
            sync_low_uid = (SELECT MIN(uid) FROM mail_messages WHERE account_id = ?1 AND folder = ?2),
            sync_high_uid = (SELECT MAX(uid) FROM mail_messages WHERE account_id = ?1 AND folder = ?2),
            sync_complete = 1,
            last_error = NULL,
            updated_at = ?3
         WHERE account_id = ?1 AND name = ?2",
        params![account_id, folder, now_ts()],
    )?;
    Ok(())
}

fn next_uid(conn: &Connection, account_id: &str, folder: &str) -> SqlResult<u32> {
    conn.query_row(
        "SELECT MAX(COALESCE((SELECT MAX(uid) FROM mail_messages WHERE account_id = ?1 AND folder = ?2), 0),
                    COALESCE((SELECT MAX(uid) FROM mail_local_raw WHERE account_id = ?1 AND folder = ?2), 0)) + 1",
        params![account_id, folder],
        |row| row.get::<_, i64>(0),
    )
    .map(|uid| uid as u32)
}

/// Store a raw message in a local folder; returns the cached row.
pub(super) fn insert_local(
    conn: &Connection,
    account_id: &str,
    folder: &str,
    raw: &[u8],
    flags: &[&str],
) -> SqlResult<MailMessageCached> {
    let uid = next_uid(conn, account_id, folder)?;
    let mut message = parse_body_message(
        account_id,
        folder,
        uid,
        Some(raw.len() as u32),
        raw,
        8 * 1024 * 1024,
    );
    message.header.uid = uid;
    message.header.folder = folder.to_string();
    message.header.flags = flags.iter().map(|f| f.to_string()).collect();
    message.header.body_cached = true;
    message.flags_authoritative = true;
    message.body_cached_at = Some(now_ts());
    message.internal_ts = Some(now_ts());
    if message.header.date_ts.is_none() {
        message.header.date_ts = Some(now_ts());
    }
    upsert_message(conn, &message)?;
    conn.execute(
        "INSERT OR REPLACE INTO mail_local_raw (account_id, folder, uid, raw) VALUES (?1, ?2, ?3, ?4)",
        params![account_id, folder, uid, raw],
    )?;
    Ok(message)
}

pub(super) fn local_raw(
    conn: &Connection,
    account_id: &str,
    folder: &str,
    uid: u32,
) -> SqlResult<Option<Vec<u8>>> {
    migrate_local_tables(conn)?;
    conn.query_row(
        "SELECT raw FROM mail_local_raw WHERE account_id = ?1 AND folder = ?2 AND uid = ?3",
        params![account_id, folder, uid],
        |row| row.get(0),
    )
    .optional()
}

/// Move (or copy) local messages; returns the count.
pub(super) fn move_local(
    conn: &Connection,
    account_id: &str,
    folder: &str,
    uids: &[u32],
    target: &str,
    copy: bool,
) -> SqlResult<usize> {
    let tx = conn.unchecked_transaction()?;
    let mut moved = 0;
    for uid in uids {
        let Some(raw) = local_raw(&tx, account_id, folder, *uid)? else {
            continue;
        };
        let flags_json: String = tx
            .query_row(
                "SELECT flags_json FROM mail_messages WHERE account_id = ?1 AND folder = ?2 AND uid = ?3",
                params![account_id, folder, uid],
                |row| row.get(0),
            )
            .optional()?
            .unwrap_or_else(|| "[]".into());
        let flags: Vec<String> = serde_json::from_str(&flags_json).unwrap_or_default();
        let refs: Vec<&str> = flags.iter().map(String::as_str).collect();
        insert_local(&tx, account_id, target, &raw, &refs)?;
        if !copy {
            delete_rows(&tx, account_id, folder, *uid)?;
        }
        moved += 1;
    }
    refresh_counts(&tx, account_id, target)?;
    refresh_counts(&tx, account_id, folder)?;
    tx.commit()?;
    Ok(moved)
}

fn delete_rows(conn: &Connection, account_id: &str, folder: &str, uid: u32) -> SqlResult<()> {
    conn.execute(
        "DELETE FROM mail_messages WHERE account_id = ?1 AND folder = ?2 AND uid = ?3",
        params![account_id, folder, uid],
    )?;
    conn.execute(
        "DELETE FROM mail_local_raw WHERE account_id = ?1 AND folder = ?2 AND uid = ?3",
        params![account_id, folder, uid],
    )?;
    Ok(())
}

/// Permanently delete local messages (`uids` None = the whole folder).
pub(super) fn delete_local(
    conn: &Connection,
    account_id: &str,
    folder: &str,
    uids: Option<&[u32]>,
) -> SqlResult<usize> {
    migrate_local_tables(conn)?;
    let targets: Vec<u32> = match uids {
        Some(uids) => uids.to_vec(),
        None => {
            let mut stmt = conn
                .prepare("SELECT uid FROM mail_messages WHERE account_id = ?1 AND folder = ?2")?;
            let rows = stmt.query_map(params![account_id, folder], |row| row.get::<_, i64>(0))?;
            rows.filter_map(Result::ok).map(|uid| uid as u32).collect()
        }
    };
    for uid in &targets {
        delete_rows(conn, account_id, folder, *uid)?;
    }
    refresh_counts(conn, account_id, folder)?;
    Ok(targets.len())
}

pub(super) fn rename_local_folder(
    conn: &Connection,
    account_id: &str,
    from: &str,
    to: &str,
) -> SqlResult<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "UPDATE mail_folders SET name = ?3 WHERE account_id = ?1 AND name = ?2",
        params![account_id, from, to],
    )?;
    tx.execute(
        "UPDATE mail_messages SET folder = ?3 WHERE account_id = ?1 AND folder = ?2",
        params![account_id, from, to],
    )?;
    tx.execute(
        "UPDATE mail_local_raw SET folder = ?3 WHERE account_id = ?1 AND folder = ?2",
        params![account_id, from, to],
    )?;
    tx.commit()
}

pub(super) fn delete_local_folder(
    conn: &Connection,
    account_id: &str,
    name: &str,
) -> SqlResult<()> {
    delete_local(conn, account_id, name, None)?;
    conn.execute(
        "DELETE FROM mail_folders WHERE account_id = ?1 AND name = ?2",
        params![account_id, name],
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

pub(super) struct Pop3SyncOutcome {
    pub messages: Vec<MailMessageCached>,
    pub remaining: usize,
    pub deleted_on_server: usize,
}

/// Plan one sync round from the server listing and the remembered UIDLs.
/// Returns (numbers to download, numbers to delete on the server).
pub(super) fn plan_round(
    listing: &[(u32, String)],
    known: &HashMap<String, i64>,
    limit: usize,
    leave_days: Option<u32>,
    now: i64,
) -> (Vec<(u32, String)>, Vec<u32>) {
    let fetch: Vec<(u32, String)> = listing
        .iter()
        .filter(|(_, id)| !known.contains_key(id))
        .take(limit)
        .cloned()
        .collect();
    let deletes = match leave_days {
        None => Vec::new(),
        Some(days) => {
            let cutoff = now - i64::from(days) * 86_400;
            listing
                .iter()
                .filter(|(_, id)| known.get(id).is_some_and(|fetched| *fetched <= cutoff))
                .map(|(number, _)| *number)
                .collect()
        }
    };
    (fetch, deletes)
}

/// Download new mail into the local INBOX (one batch) and apply the
/// leave-on-server policy. The connection is opened and closed here.
pub(super) fn sync_inbox(
    client: &mut Pop3Client,
    conn: &Connection,
    account_id: &str,
    leave_days: Option<u32>,
) -> Result<Pop3SyncOutcome, String> {
    ensure_local_folders(conn, account_id).map_err(|e| e.to_string())?;
    let listing = client.uidl()?;
    let known: HashMap<String, i64> = {
        let mut stmt = conn
            .prepare("SELECT uidl, fetched_at FROM mail_pop3_uidl WHERE account_id = ?1")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![account_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })
            .map_err(|e| e.to_string())?;
        rows.filter_map(Result::ok).collect()
    };
    let now = now_ts();
    let (fetch, mut deletes) = plan_round(&listing, &known, POP3_FETCH_BATCH, leave_days, now);
    let mut messages = Vec::new();
    for (number, id) in &fetch {
        let raw = client.retr(*number)?;
        let message =
            insert_local(conn, account_id, "INBOX", &raw, &[]).map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT OR REPLACE INTO mail_pop3_uidl (account_id, uidl, fetched_at, deleted) VALUES (?1, ?2, ?3, 0)",
            params![account_id, id, now],
        )
        .map_err(|e| e.to_string())?;
        if leave_days == Some(0) {
            deletes.push(*number);
        }
        messages.push(message);
    }
    for number in &deletes {
        client.dele(*number)?;
    }
    if !deletes.is_empty() {
        let deleted_ids: Vec<&String> = listing
            .iter()
            .filter(|(number, _)| deletes.contains(number))
            .map(|(_, id)| id)
            .collect();
        for id in deleted_ids {
            conn.execute(
                "UPDATE mail_pop3_uidl SET deleted = 1 WHERE account_id = ?1 AND uidl = ?2",
                params![account_id, id],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    refresh_counts(conn, account_id, "INBOX").map_err(|e| e.to_string())?;
    let remaining = listing
        .iter()
        .filter(|(_, id)| !known.contains_key(id))
        .count()
        .saturating_sub(fetch.len());
    Ok(Pop3SyncOutcome {
        messages,
        remaining,
        deleted_on_server: deletes.len(),
    })
}

#[cfg(test)]
pub(super) mod fake {
    //! Minimal POP3 test server (USER/PASS, APOP, STAT, UIDL, RETR, DELE, QUIT).
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};

    #[derive(Default)]
    pub struct FakePop3State {
        pub messages: Vec<(String, Vec<u8>)>,
        pub deleted: Vec<String>,
        pub log: Vec<String>,
    }

    pub fn start(state: Arc<Mutex<FakePop3State>>) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let state = Arc::clone(&state);
                std::thread::spawn(move || {
                    let mut writer = stream.try_clone().unwrap();
                    let mut reader = BufReader::new(stream);
                    let _ = writer.write_all(b"+OK fake <1896.697170952@dbc.mtview.ca.us>\r\n");
                    let mut marked: Vec<usize> = Vec::new();
                    loop {
                        let mut line = String::new();
                        if reader.read_line(&mut line).unwrap_or(0) == 0 {
                            return;
                        }
                        let line = line.trim_end().to_string();
                        state.lock().unwrap().log.push(line.clone());
                        let upper = line.to_ascii_uppercase();
                        let mut s = state.lock().unwrap();
                        let reply: Vec<u8> = if upper.starts_with("USER") {
                            b"+OK\r\n".to_vec()
                        } else if upper.starts_with("PASS") {
                            if line.ends_with(" secret") {
                                b"+OK\r\n".to_vec()
                            } else {
                                b"-ERR bad\r\n".to_vec()
                            }
                        } else if upper.starts_with("APOP") {
                            b"+OK\r\n".to_vec()
                        } else if upper.starts_with("STAT") {
                            format!("+OK {} 0\r\n", s.messages.len()).into_bytes()
                        } else if upper.starts_with("UIDL") {
                            let mut out = b"+OK\r\n".to_vec();
                            for (i, (id, _)) in s.messages.iter().enumerate() {
                                out.extend_from_slice(format!("{} {id}\r\n", i + 1).as_bytes());
                            }
                            out.extend_from_slice(b".\r\n");
                            out
                        } else if let Some(n) = upper.strip_prefix("RETR ") {
                            let index: usize = n.trim().parse::<usize>().unwrap() - 1;
                            let mut out = b"+OK\r\n".to_vec();
                            for l in String::from_utf8_lossy(&s.messages[index].1).split("\r\n") {
                                if l.starts_with('.') {
                                    out.push(b'.');
                                }
                                out.extend_from_slice(l.as_bytes());
                                out.extend_from_slice(b"\r\n");
                            }
                            out.extend_from_slice(b".\r\n");
                            out
                        } else if let Some(n) = upper.strip_prefix("DELE ") {
                            marked.push(n.trim().parse::<usize>().unwrap() - 1);
                            b"+OK\r\n".to_vec()
                        } else if upper.starts_with("QUIT") {
                            marked.sort_unstable();
                            for index in marked.iter().rev() {
                                let (id, _) = s.messages.remove(*index);
                                s.deleted.push(id);
                            }
                            let _ = writer.write_all(b"+OK bye\r\n");
                            return;
                        } else {
                            b"-ERR unsupported\r\n".to_vec()
                        };
                        drop(s);
                        let _ = writer.write_all(&reply);
                    }
                });
            }
        });
        port
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    fn raw(subject: &str) -> Vec<u8> {
        format!(
            "From: Sender <s@example.com>\r\nTo: me@example.com\r\nSubject: {subject}\r\nDate: Tue, 14 Nov 2023 22:13:20 +0000\r\nMessage-ID: <{subject}@example.com>\r\n\r\n.leading dot line\r\nbody of {subject}\r\n"
        )
        .into_bytes()
    }

    fn account(port: u16) -> ResolvedMailAccount {
        let config: MailAccountConfig = serde_json::from_value(serde_json::json!({
            "sessionId": "pop",
            "emailAddress": "me@example.com",
            "incoming": "pop3",
            "imap": {"host": "127.0.0.1", "port": port, "security": "none", "username": "me"},
            "smtp": {"host": "127.0.0.1", "port": 1, "security": "none"}
        }))
        .unwrap();
        ResolvedMailAccount {
            config,
            auth_mode: MailAuthMode::Password,
            network_settings: None,
            imap_username: "me".into(),
            imap_password: "secret".into(),
            smtp_username: "me".into(),
            smtp_password: "secret".into(),
        }
    }

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        super::super::init_mail_tables(&conn).unwrap();
        conn
    }

    #[test]
    fn apop_matches_rfc1939_example() {
        assert_eq!(
            apop_digest("<1896.697170952@dbc.mtview.ca.us>", "tanstaaf"),
            "c4c9334bac560ecc979e58001b3e22fb"
        );
    }

    #[test]
    fn plans_new_downloads_and_expired_deletes() {
        let listing = vec![
            (1, "a".to_string()),
            (2, "b".to_string()),
            (3, "c".to_string()),
        ];
        let known: HashMap<String, i64> =
            [("a".to_string(), 0), ("b".to_string(), 1_000_000)].into();
        let (fetch, deletes) = plan_round(&listing, &known, 10, Some(7), 1_000_000);
        assert_eq!(fetch, vec![(3, "c".to_string())]);
        assert_eq!(
            deletes,
            vec![1],
            "only mail downloaded more than 7 days ago"
        );
        let (_, keep) = plan_round(&listing, &known, 10, None, 1_000_000);
        assert!(keep.is_empty(), "no policy keeps everything on the server");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn downloads_once_and_leaves_or_deletes() {
        let state = Arc::new(Mutex::new(fake::FakePop3State {
            messages: vec![("u1".into(), raw("one")), ("u2".into(), raw("two"))],
            ..Default::default()
        }));
        let port = fake::start(Arc::clone(&state));
        let account = account(port);
        let conn = db();
        let handle = tokio::runtime::Handle::current();
        let run = |conn: &Connection, leave: Option<u32>| {
            let mut client = Pop3Client::connect(&account, &handle).unwrap();
            let outcome = sync_inbox(&mut client, conn, "pop", leave).unwrap();
            client.quit().unwrap();
            outcome
        };

        let first = tokio::task::block_in_place(|| run(&conn, None));
        assert_eq!(first.messages.len(), 2);
        let body = local_raw(&conn, "pop", "INBOX", first.messages[0].header.uid)
            .unwrap()
            .unwrap();
        assert!(
            String::from_utf8_lossy(&body).contains("\r\n.leading dot line\r\n"),
            "dot-unstuffed"
        );
        assert!(first.messages.iter().any(|m| m.header.subject == "two"));

        // AC-65: a second sync downloads nothing again.
        state
            .lock()
            .unwrap()
            .messages
            .push(("u3".into(), raw("three")));
        let second = tokio::task::block_in_place(|| run(&conn, None));
        assert_eq!(second.messages.len(), 1);
        assert_eq!(second.messages[0].header.subject, "three");
        let total: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM mail_messages WHERE account_id = 'pop' AND folder = 'INBOX'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(total, 3);

        // AC-66: "keep 0 days" deletes everything already downloaded.
        let third = tokio::task::block_in_place(|| run(&conn, Some(0)));
        assert_eq!(third.messages.len(), 0);
        assert_eq!(third.deleted_on_server, 3);
        assert_eq!(state.lock().unwrap().deleted.len(), 3);
        assert!(state.lock().unwrap().messages.is_empty());
    }

    #[test]
    fn local_folders_move_copy_delete() {
        let conn = db();
        ensure_local_folders(&conn, "pop").unwrap();
        let a = insert_local(&conn, "pop", "INBOX", &raw("alpha"), &[]).unwrap();
        let b = insert_local(&conn, "pop", "INBOX", &raw("beta"), &["\\Seen"]).unwrap();
        assert_eq!((a.header.uid, b.header.uid), (1, 2));
        create_local_folder(&conn, "pop", "Projects").unwrap();
        assert_eq!(
            move_local(&conn, "pop", "INBOX", &[1], "Projects", false).unwrap(),
            1
        );
        assert_eq!(
            move_local(&conn, "pop", "INBOX", &[2], "Archive2", true).unwrap(),
            1
        );
        let folders = list_cached_folders(&conn, "pop").unwrap();
        let count = |name: &str| {
            folders
                .iter()
                .find(|f| f.name == name)
                .and_then(|f| f.total)
        };
        assert_eq!(count("INBOX"), Some(1));
        assert_eq!(count("Projects"), Some(1));
        assert!(local_raw(&conn, "pop", "Projects", 1).unwrap().is_some());
        assert_eq!(delete_local(&conn, "pop", "INBOX", Some(&[2])).unwrap(), 1);
        rename_local_folder(&conn, "pop", "Projects", "Work").unwrap();
        assert!(local_raw(&conn, "pop", "Work", 1).unwrap().is_some());
        assert!(has_local_store(&conn, "pop").unwrap());
    }
}
