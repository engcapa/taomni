//! Explicit profile roots shared by desktop, headless, registry and migration.
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

static HEADLESS_CONFIG_ROOT: OnceLock<PathBuf> = OnceLock::new();

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProfilePaths {
    pub data: PathBuf,
    pub config: PathBuf,
    pub cache: PathBuf,
    pub plugins: PathBuf,
}

impl ProfilePaths {
    pub(crate) fn desktop(app: &tauri::AppHandle) -> Result<Self, String> {
        let data = crate::resolved_app_data_dir(app)?;
        Ok(Self::new(
            data.clone(),
            crate::resolved_config_dir().unwrap_or_else(|| data.join("config")),
            crate::resolved_cache_dir().unwrap_or_else(|| data.join("cache")),
        ))
    }

    pub(crate) fn headless(data: &Path, custom: bool) -> Result<Self, String> {
        let config = if custom {
            let path = data.join("config");
            if let Some(existing) = HEADLESS_CONFIG_ROOT.get() {
                if existing != &path {
                    return Err(
                        "Headless config root was already initialized for another profile".into(),
                    );
                }
            } else {
                HEADLESS_CONFIG_ROOT
                    .set(path.clone())
                    .map_err(|_| "Headless config root initialization raced")?;
            }
            path
        } else {
            crate::resolved_config_dir().unwrap_or_else(|| data.join("config"))
        };
        Ok(Self::new(
            data.to_owned(),
            config,
            crate::resolved_cache_dir().unwrap_or_else(|| data.join("cache")),
        ))
    }

    pub(crate) fn isolated(data: &Path) -> Self {
        Self::new(data.to_owned(), data.join("config"), data.join("cache"))
    }

    fn new(data: PathBuf, config: PathBuf, cache: PathBuf) -> Self {
        let plugins = data.join("plugins");
        Self {
            data,
            config,
            cache,
            plugins,
        }
    }
}

pub(crate) fn config_root() -> Option<PathBuf> {
    HEADLESS_CONFIG_ROOT.get().cloned()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn plugin_root_is_explicit_and_independent_of_mail_cache() {
        let paths = ProfilePaths::isolated(Path::new("/profile"));
        assert_eq!(paths.plugins, paths.data.join("plugins"));
        assert_eq!(paths.config, paths.data.join("config"));
        assert_eq!(paths.cache, paths.data.join("cache"));
    }
}
