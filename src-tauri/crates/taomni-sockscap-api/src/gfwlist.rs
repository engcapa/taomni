use serde::Deserialize;
use serde::Serialize;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GfwListSource {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_gfwlist_url")]
    pub url: String,
    /// 0 = manual only.
    #[serde(default = "default_refresh_hours")]
    pub auto_refresh_hours: u32,
}

pub(super) fn default_true() -> bool {
    true
}

pub(super) fn default_gfwlist_url() -> String {
    // Common public mirror; users can override. Not fetched at build time.
    "https://cdn.jsdelivr.net/gh/gfwlist/gfwlist/gfwlist.txt".into()
}

pub(super) fn default_refresh_hours() -> u32 {
    24
}

impl Default for GfwListSource {
    fn default() -> Self {
        Self {
            enabled: true,
            url: default_gfwlist_url(),
            auto_refresh_hours: default_refresh_hours(),
        }
    }
}
