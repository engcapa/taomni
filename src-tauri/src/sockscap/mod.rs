//! Sockscap — system-level traffic routing module for Taomni.
//!
//! Independent from Application Proxy (`proxy::`). Application Proxy only
//! routes Taomni's own outbound HTTP; Sockscap intercepts other applications'
//! new network flows and routes them through PROXY / DIRECT / BLOCK decisions.
//!
//! Phase 0: types, capability probes, preflight, orchestrator state machine.
//! Phase 1: pure Rust policy core (rules, matcher, GFWList last-good, test_target).
//!
//! See `claudedocs/sockscap-cross-platform-design-plan.md` and
//! `claudedocs/sockscap-phase0-adr.md`.

pub mod capabilities;
pub mod commands;
pub mod orchestrator;
pub mod policy;
pub mod preflight;
pub mod types;

pub use commands::*;
pub use orchestrator::SockscapEngine;
