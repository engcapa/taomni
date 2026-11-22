use std::path::{Path, PathBuf};

use taomni_sockscap_api::SLUG;
use tauri::Manager;

use super::{REDIRECTOR_APP_TAR_SHA256, REDIRECTOR_VERSION};
use crate::plugin::{LifecycleState, PluginRegistry};
use crate::state::AppState;

const PACKAGE_ARCHIVE: &str = "resources/macos/redirector/0.12.11/Mitmproxy Redirector.app.tar";

pub(super) enum InstallerSource {
    Module(String),
    LegacyBundle(PathBuf),
}

impl InstallerSource {
    pub(super) fn name(&self) -> &'static str {
        match self {
            Self::Module(_) => "module",
            Self::LegacyBundle(_) => "legacyBundle",
        }
    }

    pub(super) fn locate(app: &tauri::AppHandle) -> Result<Option<Self>, String> {
        let state = app.state::<AppState>();
        if let Some(record) = state.plugins.get(SLUG) {
            if record.state != LifecycleState::Enabled {
                return Ok(None);
            }
            let version = record.manifest.version;
            let packaged = state
                .plugins
                .with_active_package(SLUG, &version, |trusted| {
                    Ok(trusted.contains_file(PACKAGE_ARCHIVE))
                })
                .map_err(|error| error.to_string())?;
            if packaged {
                return Ok(Some(Self::Module(version)));
            }
        }
        // An older core can still carry the upstream installer during rollout.
        let root = app
            .path()
            .resource_dir()
            .map_err(|error| error.to_string())?;
        let relative = Path::new("sockscap/macos/redirector")
            .join(REDIRECTOR_VERSION)
            .join("Mitmproxy Redirector.app.tar");
        Ok(
            [root.join(&relative), root.join("resources").join(relative)]
                .into_iter()
                .find(|path| path.is_file())
                .map(Self::LegacyBundle),
        )
    }

    pub(super) fn stage(
        &self,
        registry: &PluginRegistry,
        destination: &Path,
    ) -> Result<(), String> {
        match self {
            Self::Module(version) => {
                let bytes = registry
                    .with_active_package(SLUG, version, |trusted| {
                        trusted.read_file(PACKAGE_ARCHIVE)
                    })
                    .map_err(|error| error.to_string())?;
                std::fs::write(destination, bytes).map_err(|error| error.to_string())?;
            }
            Self::LegacyBundle(path) => {
                std::fs::copy(path, destination).map_err(|error| error.to_string())?;
            }
        }
        super::installer::verify_sha256(destination, REDIRECTOR_APP_TAR_SHA256)
    }
}
