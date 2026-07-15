//! Shared, provider-neutral types for local coding agents.
//!
//! Claude Code and Codex currently use separate bridge protocols. ACP-backed
//! agents will use these types directly, while the legacy protocols are mapped
//! here without changing their existing runtime paths.

mod adapters;
mod types;

pub use adapters::{from_cc_event, from_codex_event};
pub use types::{LocalAgentEvent, LocalAgentSession, LocalAgentTurnOptions, LocalAgentUsage};
