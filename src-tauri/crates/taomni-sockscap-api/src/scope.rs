use serde::Deserialize;
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum ScopeMode {
    #[default]
    Global,
    Apps,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum RuleMode {
    /// GFWList match → Proxy; miss → [`SocksCapConfig::default_action`].
    #[default]
    GfwList,
    /// Everything except hard-bypass / user Direct → Proxy.
    ProxyAll,
    /// Only user rules + bypass; no GFWList.
    Off,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum Decision {
    #[default]
    Direct,
    Proxy,
    Block,
}
