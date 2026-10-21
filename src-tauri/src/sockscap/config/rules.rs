use super::applications::AppSelector;
use super::gfwlist::default_true;
use super::scope::Decision;
use super::scope::RuleMode;
use super::scope::ScopeMode;
use super::upstream::UpstreamRef;
use serde::Deserialize;
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum UserRuleAction {
    Direct,
    Proxy,
    Block,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserRule {
    /// Domain suffix (e.g. `example.com`), CIDR (`10.0.0.0/8`), or exact host.
    pub pattern: String,
    pub action: UserRuleAction,
    #[serde(default)]
    pub comment: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SocksCapProfile {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub priority: i32,
    #[serde(default)]
    pub mode: ScopeMode,
    #[serde(default)]
    pub apps: Vec<AppSelector>,
    #[serde(default)]
    pub upstream: UpstreamRef,
    #[serde(default)]
    pub rule_mode: RuleMode,
    #[serde(default)]
    pub user_rules: Vec<UserRule>,
    #[serde(default)]
    pub default_action: Decision,
}

impl Default for SocksCapProfile {
    fn default() -> Self {
        Self {
            id: "default".into(),
            name: "默认方案".into(),
            icon: Some("🎮".into()),
            color: None,
            enabled: true,
            priority: 0,
            mode: ScopeMode::Global,
            apps: Vec::new(),
            upstream: UpstreamRef::default(),
            rule_mode: RuleMode::GfwList,
            user_rules: Vec::new(),
            default_action: Decision::Direct,
        }
    }
}
