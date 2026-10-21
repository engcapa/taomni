//! In-app rmcp Streamable-HTTP MCP server that Claude Code connects to (D1).
//!
//! Replaces the stdio `--mcp-server` bridges for the CC path: instead of CC
//! re-invoking the Taomni binary over stdio, CC's `.mcp.json` points a
//! `type:"http"` entry at this loopback server (Bearer-gated), so the tool
//! handlers run *inside* the live app and can touch `AppState` directly.
//!
//! Execution model (D2 hybrid):
//!   - read-only tools (`list_sessions`, `search_history`) run synchronously
//!     against `AppState.db` — no second connection, no round-trip.
//!   - side-effect tools (`run_in_terminal`, `sftp_upload`, `sftp_download`, `switch_tab`,
//!     `open_session_editor`, `save_as_runbook`) and `read_terminal_tail`
//!     (whose data lives in the frontend) emit an `agent-cc-tool` event and
//!     block on a oneshot until the frontend performs the effect and calls
//!     `cc_resolve_tool_call`.
//!   - `permission_prompt` (CC's `--permission-prompt-tool`) runs the safety
//!     pipeline + grading, and for write tools blocks on a human decision
//!     delivered by `cc_resolve_permission` (HITL, Phase 2).
//!
//! Security:
//!   - Bound to `127.0.0.1:random`; every request needs `Authorization:
//!     Bearer <token>` matching a minted per-thread token (401 otherwise).
//!   - Each token carries a scope `{thread_id, allowed_session_id, trust}`; a
//!     tool call naming a `session_id` outside that scope is rejected, so one
//!     thread's CC can never drive another thread's SSH session. Control-plane
//!     tools are the exception: their `session_id` values name saved Taomni
//!     session configs or UI targets, not the current terminal execution scope.

mod capture;
mod handler;
mod model;
mod parameters;
mod permissions;
mod scope;
mod server;
#[cfg(test)]
mod tests;
mod tools;

pub(crate) use handler::TOOL_TIMEOUT_SECS;
pub use model::Flavor;
pub(crate) use model::TokenMap;
pub use model::TokenScope;
pub use model::TrustLevel;
pub(crate) use parameters::PermissionParams;
pub(crate) use parameters::as_value;
pub(crate) use permissions::allow_json;
pub(crate) use permissions::allow_result;
pub(crate) use permissions::await_permission;
pub(crate) use permissions::decide_permission;
pub(crate) use permissions::deny_json;
pub(crate) use permissions::deny_result;
pub(crate) use permissions::enforce_inline_permission;
pub(crate) use scope::enforce_session_scope;
pub(crate) use scope::normalize_tool_name;
pub(crate) use scope::scope_from_ctx;
pub(crate) use scope::tool_uses_bound_session_scope;
pub use server::control_server_url;
pub use server::ensure_started;
pub use server::mint_token;
pub use server::provision_for_thread;
pub use server::provision_for_thread_with_inline_permission;
pub use server::revoke_token;
pub use server::server_url;
