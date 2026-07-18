//! Policy engine: rule sources, AutoProxy/GFWList projection, immutable matcher.
//!
//! Phase 1 (design plan §6 / §13): pure Rust, no system routing mutation.

pub mod gfwlist;
pub mod matcher;
pub mod rules;
pub mod test_target;

pub use gfwlist::*;
pub use matcher::*;
pub use rules::*;
pub use test_target::*;
