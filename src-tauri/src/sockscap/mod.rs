//! Sockscap — system-level traffic routing module for Taomni.
//!
//! Independent from Application Proxy (`proxy::`). Application Proxy only
//! routes Taomni's own outbound HTTP; Sockscap intercepts other applications'
//! new network flows and routes them through PROXY / DIRECT / BLOCK decisions.
//!
//! See `claudedocs/sockscap-cross-platform-design-plan.md` and
//! `claudedocs/sockscap-phase0-adr.md`.

pub mod capabilities;
pub mod capture;
pub mod commands;
pub mod db;
pub mod flow;
pub mod helper;
pub mod orchestrator;
pub mod policy;
pub mod preflight;
pub mod ssh_pool;
pub mod tray;
pub mod types;

pub use commands::*;
pub use db::init_db;
pub use orchestrator::SockscapEngine;
