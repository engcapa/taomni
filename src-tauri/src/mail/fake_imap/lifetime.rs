use super::model::FakeFolder;
use super::model::FakeMessage;
use super::model::FakeState;
use super::server::serve;
use std::collections::BTreeMap;
use std::net::TcpListener;
use std::net::TcpStream;
use std::sync::Arc;
use std::sync::Mutex;
use std::thread;

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
            unsubscribed: Default::default(),
            max_command_bytes: None,
            drop_store_response_once: false,
            supports_move: true,
            supports_uidplus: true,
            max_transfer_count: None,
            reject_deleted_store_once: false,
            drop_copy_response_once: false,
            reject_transfer_after: None,
            transferred: 0,
            reported_sizes: Default::default(),
            empty_bodies: Default::default(),
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
    /// Serve `structure` for BODYSTRUCTURE and `sections` for BODY[<section>].
    pub fn set_structure(
        &self,
        folder: &str,
        uid: u32,
        structure: &str,
        sections: &[(&str, &[u8])],
    ) {
        let mut state = self.state.lock().unwrap();
        let folder = state.folders.get_mut(folder).expect("folder");
        let sections = sections
            .iter()
            .map(|(name, data)| (name.to_ascii_uppercase(), data.to_vec()))
            .collect();
        folder
            .structures
            .insert(uid, (structure.to_string(), sections));
    }

    /// Deliver one message with caller-built raw bytes (custom headers).
    pub fn deliver_raw(&self, folder: &str, raw: Vec<u8>) -> u32 {
        let mut state = self.state.lock().unwrap();
        state.highest_modseq += 1;
        let modseq = state.highest_modseq;
        let folder = state.folders.get_mut(folder).expect("folder");
        let uid = folder.uid_next;
        folder.uid_next += 1;
        folder.messages.insert(
            uid,
            FakeMessage {
                flags: Vec::new(),
                raw,
                internal_ts: 1_700_000_000,
                modseq,
            },
        );
        uid
    }

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
