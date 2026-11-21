use std::{collections::BTreeMap, fs::File, io, path::Path};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{Kind, ServerConfig};

pub const CONFIG_FILENAME: &str = "config.json";
pub const CONFIG_PATH: &str = "plugins/servers/data/config.json";

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StoredSettings {
    pub settings: BTreeMap<Kind, ServerConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub legacy_source: Option<String>,
}

pub fn password_ref(settings: &ServerConfig) -> Option<&str> {
    settings.extra.get("passwordRef").and_then(Value::as_str)
}

pub fn needs_legacy_password(settings: &ServerConfig) -> bool {
    settings.bool_field("credentialMigrationRequired", false)
}

impl StoredSettings {
    pub fn validate(&self) -> io::Result<()> {
        for (kind, config) in &self.settings {
            let fields = &config.extra;
            if fields.contains_key("password")
                || fields.contains_key("removePassword")
                || fields.get("passwordRef").is_some_and(|value| {
                    !kind.uses_password()
                        || !value.as_str().is_some_and(|reference| {
                            reference
                                .strip_prefix("vault:")
                                .is_some_and(|id| !id.is_empty())
                        })
                })
                || fields
                    .get("credentialMigrationRequired")
                    .is_some_and(|value| !kind.uses_password() || !value.is_boolean())
            {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "Invalid Local servers credential settings",
                ));
            }
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
        if let Some(record) = &record {
            record.validate()?;
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
