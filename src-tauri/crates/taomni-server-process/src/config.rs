use serde::{Deserialize, Serialize};

fn default_bind() -> String {
    "0.0.0.0".to_string()
}

fn default_autostop() -> u64 {
    3600
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ServerConfig {
    #[serde(default)]
    pub port: u16,
    #[serde(default = "default_bind")]
    pub bind_address: String,
    #[serde(default)]
    pub auto_stop: bool,
    #[serde(default = "default_autostop")]
    pub auto_stop_seconds: u64,
    #[serde(default)]
    pub start_on_launch: bool,
    /// Server-specific fields (e.g. `rootDir`, `username`). Leaf modules read
    /// these via the typed accessors below.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

impl ServerConfig {
    /// Read a string-valued server-specific field from `extra`.
    // Part of the leaf-facing API surface; placeholder leaves don't use these yet.
    #[allow(dead_code)]
    pub fn str_field<'a>(&'a self, key: &str, default: &'a str) -> &'a str {
        self.extra
            .get(key)
            .and_then(|v| v.as_str())
            .unwrap_or(default)
    }

    /// Read a bool-valued server-specific field from `extra`.
    #[allow(dead_code)]
    pub fn bool_field(&self, key: &str, default: bool) -> bool {
        self.extra
            .get(key)
            .and_then(|v| v.as_bool())
            .unwrap_or(default)
    }

    /// Read a u64-valued server-specific field from `extra`.
    #[allow(dead_code)]
    pub fn u64_field(&self, key: &str, default: u64) -> u64 {
        self.extra
            .get(key)
            .and_then(|v| v.as_u64())
            .unwrap_or(default)
    }
}
