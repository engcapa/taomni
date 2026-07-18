//! Sockscap — system-level traffic routing module for Taomni.
//!
//! Independent from Application Proxy (`proxy::`). Application Proxy only
//! routes Taomni's own outbound HTTP; Sockscap intercepts other applications'
//! new network flows and routes them through PROXY / DIRECT / BLOCK decisions.
//!
//! Phase 0 scope (this module's first cut):
//! - Core domain types and engine state machine
//! - Platform capability probes + preflight fail-fast
//! - Orchestrator skeleton (no real capture install yet)
//! - Tauri commands for capabilities / status
//!
//! See `claudedocs/sockscap-cross-platform-design-plan.md` and
//! `claudedocs/sockscap-phase0-adr.md`.

pub mod capabilities;
pub mod commands;
pub mod orchestrator;
pub mod preflight;
pub mod types;

pub use commands::*;
pub use orchestrator::SockscapEngine;
