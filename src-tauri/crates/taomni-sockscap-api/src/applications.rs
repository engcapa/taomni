use super::launch::AppLaunchMode;
use super::launch::AppLaunchPreparation;
use serde::Deserialize;
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MacosAppIdentityKind {
    Bundle,
    Executable,
}

impl Default for MacosAppIdentityKind {
    fn default() -> Self {
        Self::Bundle
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MacosAppIdentity {
    /// Whether this identity covers a complete `.app` family or one standalone
    /// executable. Missing in older configs and therefore defaults to Bundle.
    #[serde(default)]
    pub kind: MacosAppIdentityKind,
    /// Stable user-facing entry point. For command names this is the absolute
    /// PATH match (which may be a symlink updated in place).
    #[serde(default)]
    pub selected_path: String,
    #[serde(default)]
    pub bundle_path: String,
    #[serde(default)]
    pub canonical_bundle_path: String,
    #[serde(default)]
    pub main_executable_path: String,
    #[serde(default)]
    pub bundle_id: String,
    #[serde(default)]
    pub team_id: String,
    #[serde(default)]
    pub signing_id: String,
    #[serde(default)]
    pub designated_requirement: String,
    #[serde(default)]
    pub last_validated_cd_hash: String,
    #[serde(default)]
    pub supplemental_executables: Vec<String>,
    #[serde(default)]
    pub allow_unsigned: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSelector {
    /// Executable path or command name. Linux launch-only mode also accepts a
    /// command resolved through the Taomni process PATH.
    #[serde(default)]
    pub path: String,
    /// Arguments used when launch-only capture starts this application.
    /// Transparent capture backends ignore them.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<String>,
    /// How launch-only Linux capture presents the application. Desktop apps
    /// inherit the graphical session; terminal apps run inside Taomni's PTY so
    /// interactive TUI programs receive a controlling terminal.
    #[serde(default, skip_serializing_if = "AppLaunchMode::is_desktop")]
    pub launch_mode: AppLaunchMode,
    /// Structured preparation applied before a Linux launch-only application
    /// is exec'd. Transparent capture backends preserve but ignore it.
    #[serde(default, skip_serializing_if = "AppLaunchPreparation::is_empty")]
    pub launch_preparation: AppLaunchPreparation,
    /// macOS bundle id when available.
    #[serde(default)]
    pub bundle_id: String,
    /// Display name for the UI.
    #[serde(default)]
    pub name: String,
    /// macOS path-family identity. Other platforms preserve but ignore it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub macos_identity: Option<MacosAppIdentity>,
}
