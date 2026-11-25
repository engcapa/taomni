use serde::{Deserialize, Serialize};
use std::{fs::File, io, path::Path};

pub const CONFIG_FILENAME: &str = "config.json";
pub const CONFIG_PATH: &str = "plugins/vnc-server/data/config.json";

/// The module data stores settings and a Vault reference. The core supplies
/// the password to the daemon only for the current start request.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub port: u16,
    pub bind_address: String,
    pub view_only: bool,
    pub shared_desktop: bool,
    pub auto_stop: bool,
    pub auto_stop_seconds: u64,
    pub start_on_launch: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub password_ref: Option<String>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub credential_migration_required: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            port: 5900,
            bind_address: "0.0.0.0".to_owned(),
            view_only: false,
            shared_desktop: true,
            auto_stop: false,
            auto_stop_seconds: 3600,
            start_on_launch: false,
            password_ref: None,
            credential_migration_required: false,
        }
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StoredSettings {
    pub settings: Settings,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub legacy_source: Option<String>,
}

pub struct SettingsFile(crate::settings_file::SettingsFile);

impl SettingsFile {
    pub fn new(profile: &Path) -> Self {
        Self(crate::settings_file::SettingsFile::new(
            profile,
            CONFIG_PATH,
        ))
    }

    pub fn load(&self) -> io::Result<Option<StoredSettings>> {
        self.0.load()
    }

    pub fn open(&self) -> io::Result<Option<File>> {
        self.0.open()
    }

    pub fn save(&self, record: &StoredSettings) -> io::Result<()> {
        self.0.save(record)
    }
}
