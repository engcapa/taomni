//! Read-only compatibility with larksuite/cli v1.0.23/v1.0.97 config.
//! Reference: https://github.com/larksuite/cli/blob/v1.0.97/internal/core/config.go
use serde::{Deserialize, Serialize};
use std::{
    io::Read,
    path::{Path, PathBuf},
};
use zeroize::Zeroizing;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliApp {
    #[serde(default)]
    pub name: String,
    pub app_id: String,
    pub app_secret: SecretInput,
    pub brand: String,
}
#[derive(Deserialize)]
#[serde(untagged)]
pub enum SecretInput {
    Plain(String),
    Reference { source: String, id: String },
}
impl Drop for SecretInput {
    fn drop(&mut self) {
        use zeroize::Zeroize;
        if let Self::Plain(value) = self {
            value.zeroize();
        }
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CliConfig {
    #[serde(default)]
    current_app: String,
    apps: Vec<CliApp>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationChoice {
    pub app_id: String,
    pub label: String,
    pub is_default: bool,
}

pub fn home() -> Result<PathBuf, String> {
    dirs::home_dir().ok_or_else(|| "Cannot locate the current user's home directory".into())
}
pub fn config_path() -> Result<PathBuf, String> {
    let dir = match std::env::var_os("LARKSUITE_CLI_CONFIG_DIR").filter(|s| !s.is_empty()) {
        Some(value) => PathBuf::from(value),
        None => home()?.join(".lark-cli"),
    };
    if !dir.is_absolute() {
        return Err("LARKSUITE_CLI_CONFIG_DIR must be an absolute directory".into());
    }
    Ok(dir.join("config.json"))
}

/// Bounded, ordinary file reads; never pipes/devices or shell-expanded references.
pub fn read_file(path: &Path, limit: u64) -> Result<Zeroizing<Vec<u8>>, String> {
    for _ in 0..2 {
        let mut file = std::fs::File::open(path)
            .map_err(|_| "Cannot read the existing CLI configuration or credential file")?;
        let before = file
            .metadata()
            .map_err(|_| "Cannot inspect the existing CLI file")?;
        if !before.is_file() || before.len() > limit {
            return Err("Existing CLI file is not a regular file or exceeds the size limit".into());
        }
        let mut bytes = Zeroizing::new(Vec::new());
        (&mut file)
            .take(limit + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "Cannot read the existing CLI file")?;
        let after =
            std::fs::metadata(path).map_err(|_| "CLI file changed while being read; retry")?;
        if bytes.len() as u64 > limit {
            return Err("Existing CLI file exceeds the size limit".into());
        }
        if before.len() == after.len() && before.modified().ok() == after.modified().ok() {
            return Ok(bytes);
        }
    }
    Err("CLI file keeps changing; finish CLI configuration and retry".into())
}
fn parse(bytes: &[u8]) -> Result<CliConfig, String> {
    let config: CliConfig = serde_json::from_slice(bytes).map_err(
        |_| "Existing CLI configuration is damaged or unsupported; repair it before connecting",
    )?;
    if config.apps.is_empty() {
        return Err(
            "Existing CLI configuration has no application entries; repair it before connecting"
                .into(),
        );
    }
    if !config.current_app.is_empty() && find(&config, &config.current_app).is_none() {
        return Err(
            "The CLI currentApp references a missing application; repair it before connecting"
                .into(),
        );
    }
    let mut ids = std::collections::HashSet::new();
    for app in &config.apps {
        if !valid_app_id(&app.app_id) || !ids.insert(&app.app_id) {
            return Err("Existing CLI application identifiers are invalid or duplicated".into());
        }
    }
    Ok(config)
}
pub fn valid_app_id(id: &str) -> bool {
    id.starts_with("cli_")
        && id.len() > 4
        && id.len() < 128
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
}
fn find<'a>(config: &'a CliConfig, key: &str) -> Option<&'a CliApp> {
    config
        .apps
        .iter()
        .find(|a| !a.name.is_empty() && a.name == key)
        .or_else(|| config.apps.iter().find(|a| a.app_id == key))
}
fn load() -> Result<Option<CliConfig>, String> {
    let path = config_path()?;
    match std::fs::metadata(&path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => {
            return Err(
                "Cannot access the existing CLI configuration; repair file permissions and retry"
                    .into(),
            );
        }
        Ok(_) => (),
    }
    Ok(Some(parse(&read_file(&path, 1024 * 1024)?)?))
}
pub fn applications() -> Result<Vec<ApplicationChoice>, String> {
    let Some(config) = load()? else {
        return Ok(vec![]);
    };
    let default = find(&config, &config.current_app)
        .filter(|a| a.brand == "feishu")
        .or_else(|| config.apps.iter().find(|a| a.brand == "feishu"));
    Ok(config
        .apps
        .iter()
        .filter(|a| a.brand == "feishu")
        .map(|a| ApplicationChoice {
            app_id: a.app_id.clone(),
            label: if a.name.is_empty() {
                a.app_id.clone()
            } else {
                a.name.clone()
            },
            is_default: default.is_some_and(|d| d.app_id == a.app_id),
        })
        .collect())
}
pub fn selected(selection: Option<&str>) -> Result<Option<CliApp>, String> {
    let Some(mut config) = load()? else {
        return if selection.is_some() {
            Err("Selected CLI application is no longer available".into())
        } else {
            Ok(None)
        };
    };
    let chosen = match selection {
        Some(id) => config
            .apps
            .iter()
            .find(|a| a.app_id == id && a.brand == "feishu"),
        None => find(&config, &config.current_app)
            .filter(|a| a.brand == "feishu")
            .or_else(|| config.apps.iter().find(|a| a.brand == "feishu")),
    }
    .map(|a| a.app_id.clone());
    let Some(id) = chosen else {
        return if selection.is_some() {
            Err("Selected CLI application is unavailable or is not Feishu".into())
        } else {
            Ok(None)
        };
    };
    let index = config.apps.iter().position(|a| a.app_id == id).unwrap();
    Ok(Some(config.apps.remove(index)))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn versions_and_damaged_config() {
        for secret in [
            r#""test-secret""#,
            r#"{"source":"keychain","id":"appsecret:cli_fixture"}"#,
        ] {
            let json = format!(
                r#"{{"apps":[{{"appId":"cli_fixture","appSecret":{secret},"brand":"feishu","users":[]}}]}}"#
            );
            assert_eq!(
                parse(json.as_bytes()).unwrap().apps[0].app_id,
                "cli_fixture"
            );
        }
        for json in [
            r#"{"apps":[]}"#,
            r#"{"currentApp":"missing","apps":[{"appId":"cli_fixture","appSecret":"x","brand":"feishu"}]}"#,
            r#"{"appId":"cli_fixture"}"#,
        ] {
            assert!(parse(json.as_bytes()).is_err());
        }
    }
    #[test]
    fn file_limits_and_name_priority() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        std::fs::write(&path, b"12345").unwrap();
        assert!(read_file(&path, 4).is_err());
        assert!(read_file(dir.path(), 100).is_err());
        let config=parse(br#"{"currentApp":"cli_b","apps":[{"name":"cli_b","appId":"cli_a","appSecret":"x","brand":"feishu"},{"appId":"cli_b","appSecret":"y","brand":"feishu"}]}"#).unwrap();
        assert_eq!(find(&config, "cli_b").unwrap().app_id, "cli_a");
    }
}
