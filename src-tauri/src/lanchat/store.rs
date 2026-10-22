//! Local persistence over `lanchat.sqlite` (phase 2 onward).
//!
//! Owns the schema (profile / peers / groups / group_members / conversations /
//! messages + indexes) and the CRUD used by discovery, messaging, and the
//! command surface. Uses the bundled `rusqlite`; the connection lives behind a
//! `std::sync::Mutex` (rusqlite `Connection` is not `Sync`), separate from the
//! main `taomni.db`.
//!
//! Phase 2 implements identity bootstrap + profile read/write. Later phases add
//! peers/groups/conversations/messages helpers on the same `LanChatStore`.

mod lifetime;

mod model;

mod identity;

mod schema;

mod peers;

mod conversations;

mod encryption;

mod messages;

mod retention;

mod groups;

#[cfg(test)]
mod tests;

pub use lifetime::LanChatStore;

pub use model::{
    Conversation, Group, LanMessage, Profile, RetentionSettings, direct_conv_id, group_conv_id,
};

pub use identity::{avatar_fingerprint, decode_avatar_base64};
