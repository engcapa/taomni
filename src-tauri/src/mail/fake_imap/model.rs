use std::collections::BTreeMap;

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
    /// Test-provided BODYSTRUCTURE and `BODY[<section>]` payloads per UID.
    pub structures: BTreeMap<u32, (String, BTreeMap<String, Vec<u8>>)>,
}

impl FakeFolder {
    pub(super) fn new(uid_validity: u32) -> Self {
        Self {
            uid_validity,
            uid_next: 1,
            messages: BTreeMap::new(),
            structures: BTreeMap::new(),
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
    /// Folders not reported by LSUB (everything else is subscribed).
    pub unsubscribed: std::collections::BTreeSet<String>,
    /// Simulate providers that close the socket on an oversized command line.
    pub max_command_bytes: Option<usize>,
    /// Drop the next STORE response after applying it (an ambiguous network loss).
    pub drop_store_response_once: bool,
    pub supports_move: bool,
    pub supports_uidplus: bool,
    pub max_transfer_count: Option<usize>,
    pub reject_deleted_store_once: bool,
    pub drop_copy_response_once: bool,
    pub reject_transfer_after: Option<usize>,
    pub transferred: usize,
    /// Provider size estimates can disagree with the actual BODY[] literal.
    pub reported_sizes: BTreeMap<(String, u32), usize>,
    pub empty_bodies: std::collections::BTreeSet<(String, u32)>,
}
