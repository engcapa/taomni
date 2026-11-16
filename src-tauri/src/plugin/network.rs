//! Persisted module-only proxy choice. Application Settings are read strictly
//! at each new transfer/resume and are never modified by this feature.

use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::proxy::{AppProxyConfig, ResolvedProxy};
use crate::vault::Vault;

use super::download::{HttpDownloadService, ProxyMode, parse_proxy_mode};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ModuleNetworkConfig {
    pub mode: String,
    pub custom: AppProxyConfig,
}

impl Default for ModuleNetworkConfig {
    fn default() -> Self {
        Self {
            mode: "app".into(),
            custom: AppProxyConfig::default(),
        }
    }
}

impl ModuleNetworkConfig {
    pub fn load(path: &Path) -> Result<Self, String> {
        reject_link(path)?;
        let file = match File::open(path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Self::default());
            }
            Err(_) => return Err("Module network settings could not be read".into()),
        };
        if !file
            .metadata()
            .map_err(|_| "Module network settings could not be inspected")?
            .is_file()
        {
            return Err("Module network settings must be a regular file".into());
        }
        let mut bytes = Vec::new();
        file.take(64 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "Module network settings could not be read")?;
        if bytes.len() > 64 * 1024 {
            return Err("Module network settings exceed 64 KiB".into());
        }
        let value: Self =
            serde_json::from_slice(&bytes).map_err(|_| "Module network settings are invalid")?;
        value.validate()?;
        Ok(value)
    }

    pub fn save(&self, path: &Path) -> Result<(), String> {
        self.validate()?;
        reject_link(path)?;
        let parent = path
            .parent()
            .ok_or("Module network settings directory is missing")?;
        fs::create_dir_all(parent)
            .map_err(|_| "Module network settings directory could not be created")?;
        let mut temporary = tempfile::NamedTempFile::new_in(parent)
            .map_err(|_| "Module network settings could not be saved")?;
        let bytes =
            serde_json::to_vec_pretty(self).map_err(|_| "Module network settings are invalid")?;
        if bytes.len() > 64 * 1024 {
            return Err("Module network settings exceed 64 KiB".into());
        }
        temporary
            .write_all(&bytes)
            .and_then(|_| temporary.as_file().sync_all())
            .map_err(|_| "Module network settings could not be saved")?;
        temporary
            .persist(path)
            .map_err(|_| "Module network settings could not be published")?;
        #[cfg(unix)]
        File::open(parent)
            .and_then(|file| file.sync_all())
            .map_err(|_| "Module network settings directory could not be flushed")?;
        Ok(())
    }

    fn validate(&self) -> Result<(), String> {
        parse_proxy_mode(&self.mode).map_err(|error| error.to_string())?;
        if !self.custom.password_ref.is_empty() && !self.custom.password_ref.starts_with("vault:") {
            return Err("Module proxy password must be stored in the credential vault".into());
        }
        // Incomplete editor fields may be saved. Network admission resolves
        // them strictly, so an unfinished custom proxy cannot become direct.
        Ok(())
    }
}

pub fn resolve(
    settings: &ModuleNetworkConfig,
    application_path: &Path,
    db: Option<&rusqlite::Connection>,
    vault: Option<&Vault>,
) -> Result<Option<ResolvedProxy>, String> {
    let config = match parse_proxy_mode(&settings.mode).map_err(|error| error.to_string())? {
        ProxyMode::NoProxy => return Ok(None),
        ProxyMode::Application => AppProxyConfig::load_strict(&application_path.to_path_buf())?,
        ProxyMode::Feature => AppProxyConfig {
            enabled: true,
            ..settings.custom.clone()
        },
    };
    crate::proxy::resolve_strict_with_db(&config, db, vault)
}

pub fn service(
    settings: &ModuleNetworkConfig,
    application_path: &Path,
    db: Option<&rusqlite::Connection>,
    vault: Option<&Vault>,
) -> Result<HttpDownloadService, String> {
    let proxy = resolve(settings, application_path, db, vault)?;
    let proxy = proxy
        .map(|proxy| {
            // Resolve names at the SOCKS server as the endpoint-only transport did.
            let endpoint = proxy.to_url();
            let endpoint = if proxy.kind == "socks5" {
                endpoint.replacen("socks5://", "socks5h://", 1)
            } else {
                endpoint
            };
            reqwest::Proxy::all(endpoint).map_err(|_| "Module proxy configuration is invalid")
        })
        .transpose()?;
    HttpDownloadService::with_explicit_proxy(proxy)
        .map_err(|_| "Module network client could not be created".into())
}

fn reject_link(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            Err("Module network settings must not be a symbolic link".into())
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("Module network settings could not be inspected".into()),
    }
}

#[cfg(test)]
#[path = "network_tests.rs"]
mod tests;
