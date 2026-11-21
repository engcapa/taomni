use std::{fs::File, io, path::Path};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::ServerConfig;

pub const CONFIG_FILENAME: &str = "config.json";
pub const CONFIG_PATH: &str = "plugins/rdp-server/data/config.json";

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StoredSettings {
    pub settings: ServerConfig,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub legacy_source: Option<String>,
}

impl StoredSettings {
    pub fn password_ref(&self) -> Option<&str> {
        self.settings
            .extra
            .get("passwordRef")
            .and_then(Value::as_str)
    }

    pub fn needs_legacy_password(&self) -> bool {
        self.settings
            .bool_field("credentialMigrationRequired", false)
    }

    pub fn validate(&self) -> io::Result<()> {
        let fields = &self.settings.extra;
        if fields.contains_key("password")
            || fields.get("passwordRef").is_some_and(|value| {
                !value.as_str().is_some_and(|reference| {
                    reference
                        .strip_prefix("vault:")
                        .is_some_and(|id| !id.is_empty())
                })
            })
            || fields
                .get("credentialMigrationRequired")
                .is_some_and(|value| !value.is_boolean())
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Invalid RDP Server credential settings",
            ));
        }
        Ok(())
    }
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
        let record: Option<StoredSettings> = self.0.load()?;
        if let Some(settings) = &record {
            settings.validate()?;
        }
        Ok(record)
    }

    pub fn open(&self) -> io::Result<Option<File>> {
        self.0.open()
    }

    pub fn save(&self, record: &StoredSettings) -> io::Result<()> {
        record.validate()?;
        self.0.save(record)
    }
}
