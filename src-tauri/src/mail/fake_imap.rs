//! Test-only in-process IMAP4rev1 server.
//!
//! Implements just the commands the mail backend issues (LOGIN, CAPABILITY,
//! LIST, EXAMINE/SELECT incl. `(CONDSTORE)`, UID SEARCH, UID FETCH incl.
//! `CHANGEDSINCE`, UID STORE, UID COPY/MOVE, EXPUNGE, APPEND, NOOP, LOGOUT)
//! over a real TCP socket, so tests exercise the `imap` crate's parser and the
//! sync planner together. State is shared so a test can deliver, expunge or
//! re-flag messages between sync steps, as another client would.

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::thread;

#[derive(Debug, Clone)]
pub struct FakeMessage {
    pub flags: Vec<String>,
    pub raw: Vec<u8>,
    /// Seconds since the epoch (INTERNALDATE).
    pub internal_ts: i64,
    pub modseq: u64,
}

#[derive(Debug, Clone)]
pub struct FakeFolder {
    pub uid_validity: u32,
    pub uid_next: u32,
    pub messages: BTreeMap<u32, FakeMessage>,
}

impl FakeFolder {
    fn new(uid_validity: u32) -> Self {
        Self {
            uid_validity,
            uid_next: 1,
            messages: BTreeMap::new(),
        }
    }
}

#[derive(Debug)]
pub struct FakeState {
    pub folders: BTreeMap<String, FakeFolder>,
    pub condstore: bool,
    pub highest_modseq: u64,
    /// Every command line received (tag stripped), for assertions.
    pub log: Vec<String>,
}

#[derive(Clone)]
pub struct FakeImap {
    pub state: Arc<Mutex<FakeState>>,
    pub port: u16,
}

pub fn raw_message(subject: &str, date: &str) -> Vec<u8> {
    format!(
        "From: Sender <sender@example.com>\r\nTo: user@example.com\r\nSubject: {subject}\r\nDate: {date}\r\nMessage-ID: <{}@example.com>\r\n\r\nBody of {subject}\r\n",
        subject.replace(' ', "-")
    )
    .into_bytes()
}

impl FakeImap {
    pub fn start(condstore: bool) -> Self {
        let mut folders = BTreeMap::new();
        folders.insert("INBOX".to_string(), FakeFolder::new(1000));
        let state = Arc::new(Mutex::new(FakeState {
            folders,
            condstore,
            highest_modseq: 1,
            log: Vec::new(),
        }));
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind fake imap");
        let port = listener.local_addr().unwrap().port();
        let shared = Arc::clone(&state);
        thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let shared = Arc::clone(&shared);
                thread::spawn(move || {
                    let _ = serve(stream, shared);
                });
            }
        });
        Self { state, port }
    }

    pub fn session(&self) -> imap::Session<TcpStream> {
        let stream = TcpStream::connect(("127.0.0.1", self.port)).expect("connect fake imap");
        let mut client = imap::Client::new(stream);
        client.read_greeting().expect("greeting");
        client
            .login("user", "pass")
            .map_err(|(e, _)| e)
            .expect("login")
    }

    pub fn add_folder(&self, name: &str, uid_validity: u32) {
        let mut state = self.state.lock().unwrap();
        state
            .folders
            .insert(name.to_string(), FakeFolder::new(uid_validity));
    }

    /// Deliver `count` messages; returns their UIDs.
    pub fn deliver(&self, folder: &str, count: usize, prefix: &str) -> Vec<u32> {
        self.deliver_dated(
            folder,
            count,
            prefix,
            1_700_000_000,
            "Tue, 14 Nov 2023 22:13:20 +0000",
        )
    }

    pub fn deliver_dated(
        &self,
        folder: &str,
        count: usize,
        prefix: &str,
        internal_ts: i64,
        date_header: &str,
    ) -> Vec<u32> {
        let mut state = self.state.lock().unwrap();
        state.highest_modseq += 1;
        let modseq = state.highest_modseq;
        let folder = state.folders.get_mut(folder).expect("folder");
        let mut uids = Vec::new();
        for index in 0..count {
            let uid = folder.uid_next;
            folder.uid_next += 1;
            folder.messages.insert(
                uid,
                FakeMessage {
                    flags: Vec::new(),
                    raw: raw_message(&format!("{prefix} {index:04}"), date_header),
                    internal_ts: internal_ts + index as i64,
                    modseq,
                },
            );
            uids.push(uid);
        }
        uids
    }

    /// Skip UIDs (simulates messages delivered and removed elsewhere).
    pub fn burn_uids(&self, folder: &str, count: u32) {
        let mut state = self.state.lock().unwrap();
        state.folders.get_mut(folder).unwrap().uid_next += count;
    }

    pub fn expunge(&self, folder: &str, uids: &[u32]) {
        let mut state = self.state.lock().unwrap();
        state.highest_modseq += 1;
        let folder = state.folders.get_mut(folder).unwrap();
        for uid in uids {
            folder.messages.remove(uid);
        }
    }

    pub fn set_flags(&self, folder: &str, uid: u32, flags: &[&str]) {
        let mut state = self.state.lock().unwrap();
        state.highest_modseq += 1;
        let modseq = state.highest_modseq;
        let message = state
            .folders
            .get_mut(folder)
            .unwrap()
            .messages
            .get_mut(&uid)
            .unwrap();
        message.flags = flags.iter().map(|flag| flag.to_string()).collect();
        message.modseq = modseq;
    }

    pub fn reset_uid_validity(&self, folder: &str, uid_validity: u32) {
        let mut state = self.state.lock().unwrap();
        let entry = state.folders.get_mut(folder).unwrap();
        let messages: Vec<FakeMessage> = entry.messages.values().cloned().collect();
        *entry = FakeFolder::new(uid_validity);
        for message in messages {
            let uid = entry.uid_next;
            entry.uid_next += 1;
            entry.messages.insert(uid, message);
        }
    }

    pub fn uids(&self, folder: &str) -> Vec<u32> {
        let state = self.state.lock().unwrap();
        state.folders[folder].messages.keys().copied().collect()
    }

    pub fn flags(&self, folder: &str, uid: u32) -> Vec<String> {
        let state = self.state.lock().unwrap();
        state.folders[folder].messages[&uid].flags.clone()
    }

    pub fn log(&self) -> Vec<String> {
        self.state.lock().unwrap().log.clone()
    }
}

fn quote(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

fn unquote(value: &str) -> String {
    let value = value.trim();
    if value.len() >= 2 && value.starts_with('"') && value.ends_with('"') {
        value[1..value.len() - 1]
            .replace("\\\"", "\"")
            .replace("\\\\", "\\")
    } else {
        value.to_string()
    }
}

/// Split an argument string into the first (possibly quoted) token and rest.
fn split_first_arg(input: &str) -> (String, &str) {
    let input = input.trim_start();
    if let Some(rest) = input.strip_prefix('"') {
        let mut escaped = false;
        for (index, ch) in rest.char_indices() {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                return (unquote(&input[..index + 2]), &rest[index + 1..]);
            }
        }
        (unquote(input), "")
    } else {
        match input.find(' ') {
            Some(index) => (input[..index].to_string(), &input[index + 1..]),
            None => (input.to_string(), ""),
        }
    }
}

fn parse_uid_set(set: &str, max: u32) -> Vec<(u32, u32)> {
    set.split(',')
        .filter_map(|part| {
            let bound = |value: &str| -> Option<u32> {
                if value == "*" {
                    Some(max)
                } else {
                    value.parse().ok()
                }
            };
            let (a, b) = match part.split_once(':') {
                Some((a, b)) => (bound(a)?, bound(b)?),
                None => {
                    let value = bound(part)?;
                    (value, value)
                }
            };
            Some((a.min(b), a.max(b)))
        })
        .collect()
}

fn in_set(uid: u32, ranges: &[(u32, u32)]) -> bool {
    ranges.iter().any(|(a, b)| uid >= *a && uid <= *b)
}

fn format_internal_date(ts: i64) -> String {
    let dt = chrono::DateTime::from_timestamp(ts, 0).unwrap();
    dt.format("%d-%b-%Y %H:%M:%S +0000").to_string()
}

fn serve(stream: TcpStream, shared: Arc<Mutex<FakeState>>) -> std::io::Result<()> {
    let mut writer = stream.try_clone()?;
    let mut reader = BufReader::new(stream);
    writer.write_all(b"* OK fake IMAP ready\r\n")?;
    let mut selected: Option<String> = None;
    let mut line = String::new();
    loop {
        line.clear();
        if reader.read_line(&mut line)? == 0 {
            return Ok(());
        }
        let mut command = line.trim_end_matches(['\r', '\n']).to_string();
        // Literal (APPEND): `{n}` at end of line.
        let mut literal: Option<Vec<u8>> = None;
        if let Some(open) = command.rfind('{') {
            if command.ends_with('}') {
                if let Ok(len) = command[open + 1..command.len() - 1].parse::<usize>() {
                    writer.write_all(b"+ go ahead\r\n")?;
                    let mut bytes = vec![0; len];
                    reader.read_exact(&mut bytes)?;
                    let mut rest = String::new();
                    reader.read_line(&mut rest)?;
                    literal = Some(bytes);
                    command.truncate(open);
                }
            }
        }
        let (tag, rest) = command.split_once(' ').unwrap_or((command.as_str(), ""));
        let tag = tag.to_string();
        let rest = rest.to_string();
        let upper = rest.to_ascii_uppercase();
        let mut state = shared.lock().unwrap();
        state.log.push(rest.clone());
        let mut out = String::new();
        let mut ok = format!("{tag} OK done\r\n");
        if upper.starts_with("LOGIN") || upper.starts_with("NOOP") {
        } else if upper.starts_with("LOGOUT") {
            out.push_str("* BYE bye\r\n");
            writer.write_all(out.as_bytes())?;
            writer.write_all(ok.as_bytes())?;
            return Ok(());
        } else if upper.starts_with("CAPABILITY") {
            out.push_str("* CAPABILITY IMAP4rev1 UIDPLUS MOVE");
            if state.condstore {
                out.push_str(" CONDSTORE");
            }
            out.push_str("\r\n");
        } else if upper.starts_with("LIST") {
            for name in state.folders.keys() {
                out.push_str(&format!(
                    "* LIST (\\HasNoChildren) \"/\" {}\r\n",
                    quote(name)
                ));
            }
        } else if upper.starts_with("EXAMINE") || upper.starts_with("SELECT") {
            let (name, tail) =
                split_first_arg(rest.split_once(' ').map(|(_, args)| args).unwrap_or(""));
            let condstore = tail.to_ascii_uppercase().contains("CONDSTORE");
            let highest = state.highest_modseq;
            match state.folders.get(&name) {
                Some(folder) => {
                    out.push_str("* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)\r\n");
                    out.push_str(&format!("* {} EXISTS\r\n", folder.messages.len()));
                    out.push_str("* 0 RECENT\r\n");
                    out.push_str(&format!(
                        "* OK [UIDVALIDITY {}] ok\r\n",
                        folder.uid_validity
                    ));
                    out.push_str(&format!("* OK [UIDNEXT {}] ok\r\n", folder.uid_next));
                    if condstore {
                        out.push_str(&format!("* OK [HIGHESTMODSEQ {highest}] ok\r\n"));
                    }
                    selected = Some(name);
                }
                None => ok = format!("{tag} NO no such mailbox\r\n"),
            }
        } else if upper.starts_with("UID SEARCH") || upper.starts_with("SEARCH") {
            let folder = &state.folders[selected.as_deref().unwrap_or("INBOX")];
            let max = folder.messages.keys().next_back().copied().unwrap_or(0);
            let criteria = upper
                .trim_start_matches("UID ")
                .trim_start_matches("SEARCH")
                .trim()
                .to_string();
            let hits: Vec<u32> = if criteria == "ALL" {
                folder.messages.keys().copied().collect()
            } else if criteria == "UNSEEN" {
                folder
                    .messages
                    .iter()
                    .filter(|(_, m)| !m.flags.iter().any(|f| f == "\\Seen"))
                    .map(|(uid, _)| *uid)
                    .collect()
            } else if let Some(set) = criteria.strip_prefix("UID ") {
                let ranges = parse_uid_set(set.trim(), max);
                folder
                    .messages
                    .keys()
                    .copied()
                    .filter(|uid| in_set(*uid, &ranges))
                    .collect()
            } else {
                Vec::new()
            };
            out.push_str("* SEARCH");
            for uid in hits {
                out.push_str(&format!(" {uid}"));
            }
            out.push_str("\r\n");
        } else if upper.starts_with("UID FETCH") {
            let folder = state.folders[selected.as_deref().unwrap_or("INBOX")].clone();
            let args = rest[10..].trim();
            let (set, items) = args.split_once(' ').unwrap_or((args, ""));
            let items_upper = items.to_ascii_uppercase();
            let changed_since = items_upper
                .split("CHANGEDSINCE ")
                .nth(1)
                .and_then(|tail| tail.trim_end_matches(')').trim().parse::<u64>().ok());
            let max = folder.messages.keys().next_back().copied().unwrap_or(0);
            let ranges = parse_uid_set(set, max);
            let mut bytes: Vec<u8> = Vec::new();
            for (index, (uid, message)) in folder.messages.iter().enumerate() {
                if !in_set(*uid, &ranges) {
                    continue;
                }
                if changed_since.is_some_and(|since| message.modseq <= since) {
                    continue;
                }
                let mut parts = vec![format!("UID {uid}")];
                parts.push(format!("FLAGS ({})", message.flags.join(" ")));
                if changed_since.is_some() {
                    parts.push(format!("MODSEQ ({})", message.modseq));
                }
                if items_upper.contains("RFC822.SIZE") {
                    parts.push(format!("RFC822.SIZE {}", message.raw.len()));
                }
                if items_upper.contains("INTERNALDATE") {
                    parts.push(format!(
                        "INTERNALDATE \"{}\"",
                        format_internal_date(message.internal_ts)
                    ));
                }
                let head = format!("* {} FETCH ({}", index + 1, parts.join(" "));
                bytes.extend_from_slice(head.as_bytes());
                if items_upper.contains("BODY.PEEK[HEADER]") {
                    let text = String::from_utf8_lossy(&message.raw).to_string();
                    let header_end = text.find("\r\n\r\n").map(|i| i + 4).unwrap_or(text.len());
                    let header = &message.raw[..header_end];
                    bytes.extend_from_slice(
                        format!(" BODY[HEADER] {{{}}}\r\n", header.len()).as_bytes(),
                    );
                    bytes.extend_from_slice(header);
                }
                if items_upper.contains("BODY.PEEK[]") {
                    bytes.extend_from_slice(
                        format!(" BODY[] {{{}}}\r\n", message.raw.len()).as_bytes(),
                    );
                    bytes.extend_from_slice(&message.raw);
                }
                bytes.extend_from_slice(b")\r\n");
            }
            drop(state);
            writer.write_all(&bytes)?;
            writer.write_all(ok.as_bytes())?;
            continue;
        } else if upper.starts_with("UID STORE") {
            let name = selected.clone().unwrap_or_else(|| "INBOX".into());
            let args = rest[10..].trim().to_string();
            let (set, spec) = args.split_once(' ').unwrap_or((&args, ""));
            let spec_upper = spec.to_ascii_uppercase();
            let flags: Vec<String> = spec
                .find('(')
                .map(|open| spec[open + 1..spec.rfind(')').unwrap_or(spec.len())].to_string())
                .unwrap_or_default()
                .split_whitespace()
                .map(ToOwned::to_owned)
                .collect();
            state.highest_modseq += 1;
            let modseq = state.highest_modseq;
            let folder = state.folders.get_mut(&name).unwrap();
            let max = folder.messages.keys().next_back().copied().unwrap_or(0);
            let ranges = parse_uid_set(set, max);
            for (uid, message) in folder.messages.iter_mut() {
                if !in_set(*uid, &ranges) {
                    continue;
                }
                if spec_upper.starts_with('+') {
                    for flag in &flags {
                        if !message.flags.contains(flag) {
                            message.flags.push(flag.clone());
                        }
                    }
                } else if spec_upper.starts_with('-') {
                    message.flags.retain(|flag| !flags.contains(flag));
                } else {
                    message.flags = flags.clone();
                }
                message.modseq = modseq;
            }
        } else if upper.starts_with("UID COPY") || upper.starts_with("UID MOVE") {
            let is_move = upper.starts_with("UID MOVE");
            let name = selected.clone().unwrap_or_else(|| "INBOX".into());
            let args = rest[9..].trim().to_string();
            let (set, target) = args.split_once(' ').unwrap_or((&args, ""));
            let target = unquote(target);
            let source = state.folders[&name].clone();
            let max = source.messages.keys().next_back().copied().unwrap_or(0);
            let ranges = parse_uid_set(set, max);
            let moved: Vec<(u32, FakeMessage)> = source
                .messages
                .iter()
                .filter(|(uid, _)| in_set(**uid, &ranges))
                .map(|(uid, m)| (*uid, m.clone()))
                .collect();
            match state.folders.get_mut(&target) {
                Some(dest) => {
                    for (_, message) in &moved {
                        let uid = dest.uid_next;
                        dest.uid_next += 1;
                        dest.messages.insert(uid, message.clone());
                    }
                }
                None => ok = format!("{tag} NO [TRYCREATE] no such mailbox\r\n"),
            }
            if is_move && ok.contains(" OK ") {
                let folder = state.folders.get_mut(&name).unwrap();
                for (uid, _) in moved {
                    folder.messages.remove(&uid);
                }
            }
        } else if upper.starts_with("UID EXPUNGE") || upper.starts_with("EXPUNGE") {
            let name = selected.clone().unwrap_or_else(|| "INBOX".into());
            let folder = state.folders.get_mut(&name).unwrap();
            folder
                .messages
                .retain(|_, message| !message.flags.iter().any(|flag| flag == "\\Deleted"));
        } else if upper.starts_with("APPEND") {
            let (name, tail) = split_first_arg(&rest[6..]);
            let flags: Vec<String> = tail
                .find('(')
                .map(|open| tail[open + 1..tail.find(')').unwrap_or(tail.len())].to_string())
                .unwrap_or_default()
                .split_whitespace()
                .map(ToOwned::to_owned)
                .collect();
            state.highest_modseq += 1;
            let modseq = state.highest_modseq;
            match state.folders.get_mut(&name) {
                Some(folder) => {
                    let uid = folder.uid_next;
                    folder.uid_next += 1;
                    let validity = folder.uid_validity;
                    folder.messages.insert(
                        uid,
                        FakeMessage {
                            flags,
                            raw: literal.unwrap_or_default(),
                            internal_ts: 1_700_000_000,
                            modseq,
                        },
                    );
                    ok = format!("{tag} OK [APPENDUID {validity} {uid}] done\r\n");
                }
                None => ok = format!("{tag} NO [TRYCREATE] no such mailbox\r\n"),
            }
        } else if upper.starts_with("CREATE") {
            let (name, _) = split_first_arg(&rest[6..]);
            state
                .folders
                .entry(name)
                .or_insert_with(|| FakeFolder::new(2000));
        } else if upper.starts_with("STATUS") {
            let (name, _) = split_first_arg(&rest[6..]);
            if let Some(folder) = state.folders.get(&name) {
                let unseen = folder
                    .messages
                    .values()
                    .filter(|m| !m.flags.iter().any(|f| f == "\\Seen"))
                    .count();
                out.push_str(&format!(
                    "* STATUS {} (MESSAGES {} UNSEEN {} UIDNEXT {} UIDVALIDITY {})\r\n",
                    quote(&name),
                    folder.messages.len(),
                    unseen,
                    folder.uid_next,
                    folder.uid_validity
                ));
            }
        } else {
            ok = format!("{tag} BAD unsupported\r\n");
        }
        drop(state);
        writer.write_all(out.as_bytes())?;
        writer.write_all(ok.as_bytes())?;
    }
}
