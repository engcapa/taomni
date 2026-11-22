//! Rule compilation and matching (GFWList / AutoProxy + user helpers).

pub mod dns;
pub mod dns_map;
pub mod sni;
pub mod source;

#[allow(unused_imports)]
pub use dns_map::DnsMap;
#[allow(unused_imports)]
pub use sni::extract_sni;
pub use taomni_sockscap_api::gfwlist_rules::{CompiledRules, GfwListMeta, RuleMatch};
#[allow(unused_imports)]
pub use taomni_sockscap_api::parse_autopxy_line;
