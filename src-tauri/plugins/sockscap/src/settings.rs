//! The host has one profile writer lease. All settings mutations pass through
//! its SDK operation, including the first import from the legacy desktop.
use std::{io, path::Path};

use taomni_module_settings::SettingsFile;
use taomni_plugin_api::{ErrorCode, RpcError};
use taomni_plugin_sdk::{Operation, SnapshotExport, SnapshotProvider};
use taomni_plugin_stream::{length_prefixed, routed_tcp::Endpoint};
use taomni_sockscap_api::{CONFIG_PATH, SettingsRequest, SocksCapConfig};
use tokio::runtime::Runtime;

pub(super) struct Settings {
    file: SettingsFile,
}

impl Settings {
    pub(super) fn new(profile: &Path) -> Self {
        Self {
            file: SettingsFile::with_limit(profile, CONFIG_PATH, u64::MAX),
        }
    }

    fn apply(
        &self,
        request: SettingsRequest,
        before_publish: impl FnOnce() -> io::Result<()>,
    ) -> Result<Option<SocksCapConfig>, String> {
        let (mut config, return_config) = match request {
            SettingsRequest::Read => return self.file.load().map_err(|e| e.to_string()),
            SettingsRequest::Adopt(seed) => {
                if let Some(current) = self.file.load().map_err(|e| e.to_string())? {
                    return Ok(Some(current));
                }
                (seed, true)
            }
            SettingsRequest::Save(config) => {
                config.validate()?;
                (config, false)
            }
        };
        config.normalize();
        self.file
            .save_checked(&config, before_publish)
            .map_err(|e| e.to_string())?;
        Ok(return_config.then_some(*config))
    }

    pub(super) fn exchange(
        &self,
        io: &Runtime,
        operation: &Operation,
        endpoint: Endpoint,
    ) -> Result<serde_json::Value, RpcError> {
        let (mut peer, _) = io
            .block_on(operation.while_current(endpoint.connect()))?
            .map_err(failed)?;
        let bytes = io
            .block_on(operation.while_current(length_prefixed::read(&mut peer)))?
            .map_err(failed)?;
        let request = serde_json::from_slice(&bytes)
            .map_err(|_| RpcError::from_code(ErrorCode::InvalidParams))?;
        operation.check_current()?;
        let config = self
            .apply(request, || {
                operation
                    .check_current()
                    .map_err(|e| io::Error::other(e.message))
            })
            .map_err(failed)?;
        let result = serde_json::to_vec(&config).map_err(failed)?;
        io.block_on(operation.while_current(length_prefixed::write(&mut peer, &result)))?
            .map_err(failed)?;
        Ok(serde_json::Value::Null)
    }
}

fn failed(error: impl std::fmt::Display) -> RpcError {
    RpcError::new(ErrorCode::InvalidState, error.to_string())
}

impl SnapshotProvider for Settings {
    fn freeze(&self, operation: &Operation) -> Result<(), RpcError> {
        operation.check_current()
    }

    fn export(&self, output: &mut SnapshotExport, operation: &Operation) -> Result<(), RpcError> {
        operation.check_current()?;
        if let Some(file) = self.file.open().map_err(failed)? {
            output.file("config.json", file)?;
        }
        Ok(())
    }

    fn resume(&self) {}
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn legacy(host: &str) -> Box<SocksCapConfig> {
        Box::new(
            serde_json::from_value(serde_json::json!({
                "upstream": {"host": host, "port": 19391, "kind": "socks5"}
            }))
            .unwrap(),
        )
    }

    #[test]
    fn adopt_once_then_reopen_current_settings_even_if_an_old_import_is_retried() {
        let profile = tempfile::tempdir().unwrap();
        let settings = Settings::new(profile.path());
        assert!(
            settings
                .apply(SettingsRequest::Read, || Ok(()))
                .unwrap()
                .is_none()
        );
        let mut config = settings
            .apply(SettingsRequest::Adopt(legacy("old.example")), || Ok(()))
            .unwrap()
            .unwrap();
        assert_eq!(config.profiles[0].upstream.host, "old.example");
        config.profiles[0].upstream.host = "current.example".into();
        settings
            .apply(SettingsRequest::Save(Box::new(config)), || Ok(()))
            .unwrap();
        let reopened = Settings::new(profile.path());
        for request in [
            SettingsRequest::Adopt(legacy("stale.example")),
            SettingsRequest::Read,
        ] {
            let current = reopened
                .apply(request, || panic!("must not replace settings"))
                .unwrap()
                .unwrap();
            assert_eq!(current.upstream.host, "current.example");
            assert_eq!(current.profiles[0].upstream.host, "current.example");
        }
    }

    #[test]
    fn cancelled_and_invalid_edits_preserve_the_published_configuration() {
        let profile = tempfile::tempdir().unwrap();
        let settings = Settings::new(profile.path());
        let mut current = settings
            .apply(SettingsRequest::Adopt(legacy("old.example")), || Ok(()))
            .unwrap()
            .unwrap();
        let file = profile.path().join(CONFIG_PATH);
        let original = fs::read(&file).unwrap();
        current.profiles[0].upstream.host = "interrupted.example".into();
        assert!(
            settings
                .apply(SettingsRequest::Save(Box::new(current.clone())), || Err(
                    io::Error::new(io::ErrorKind::Interrupted, "request cancelled")
                ))
                .is_err()
        );
        current.profiles[0].upstream.host.clear();
        assert!(
            settings
                .apply(SettingsRequest::Save(Box::new(current)), || Ok(()))
                .is_err()
        );
        assert_eq!(fs::read(&file).unwrap(), original);
        assert_eq!(fs::read_dir(file.parent().unwrap()).unwrap().count(), 1);
        fs::write(&file, b"invalid JSON").unwrap();
        assert!(
            settings
                .apply(SettingsRequest::Adopt(legacy("stale.example")), || Ok(()))
                .is_err()
        );
        assert_eq!(fs::read(file).unwrap(), b"invalid JSON");
    }
}
