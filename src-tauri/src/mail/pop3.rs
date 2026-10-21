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

macro_rules! each {
    ($self:ident, $conn:ident => $body:expr) => {
        match $self {
            Pop3Client::Plain($conn) => $body,
            Pop3Client::Tls($conn) => $body,
        }
    };
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

mod limits;

mod local_store;

mod connection;

mod synchronization;

#[cfg(test)]
mod tests;

pub(super) use limits::POP3_FETCH_BATCH;

use limits::{LOCAL_FOLDERS, READ_TIMEOUT};

pub(super) use local_store::{
    create_local_folder, delete_local, delete_local_folder, ensure_local_folders, has_local_store,
    insert_local, is_pop3, local_raw, migrate_local_tables, move_local, refresh_counts,
    rename_local_folder,
};

use local_store::{delete_rows, local_folder, next_uid};

pub(super) use connection::{Pop3Client, Pop3Conn, apop_digest};

use connection::{authenticate, greeting_timestamp};

pub(super) use synchronization::{Pop3SyncOutcome, plan_round, sync_inbox};
