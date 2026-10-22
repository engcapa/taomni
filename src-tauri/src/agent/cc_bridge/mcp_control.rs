//! `taomni_control` MCP flavor: app-control tools shared by every Claude Code
//! and Codex thread. Domain tools stay split by Shell/SQL/Redis; this surface is
//! for Taomni sessions, groups, tabs, and high-level UI commands.

mod lifetime;

mod parameters;

mod response;

mod session_policy;

mod groups;

mod local_targets;

mod routes;

#[cfg(test)]
mod tests;

pub use lifetime::ControlHandler;
