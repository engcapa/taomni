use crate::{
    proxy::{AppProxyConfig, ResolvedProxy},
    state::AppState,
};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Binding {
    pub open_id: String,
    pub chat_id: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Config {
    pub app_id: String,
    pub secret_ref: String,
    pub mobile_endpoint: String,
    pub bindings: Vec<Binding>,
    pub proxy_mode: String,
    pub custom_proxy: AppProxyConfig,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            app_id: String::new(),
            secret_ref: String::new(),
            mobile_endpoint: String::new(),
            bindings: vec![],
            proxy_mode: "app".into(),
            custom_proxy: AppProxyConfig::default(),
        }
    }
}
impl Config {
    pub fn load(data: &Path) -> Result<Self, String> {
        match std::fs::read(data.join("mobile-feishu.json")) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| "feishu_config_invalid".into()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(_) => Err("feishu_config_unreadable".into()),
        }
    }
    pub fn validate(&self) -> Result<(), String> {
        if self.app_id.len() > 128 || (!self.app_id.is_empty() && !self.app_id.starts_with("cli_"))
        {
            return Err("invalid_app_id".into());
        }
        if !matches!(self.proxy_mode.as_str(), "app" | "custom" | "none") {
            return Err("invalid_proxy_mode".into());
        }
        if !self.secret_ref.is_empty()
            && !self.secret_ref.starts_with(crate::vault::VAULT_REF_PREFIX)
        {
            return Err("secret_must_be_vault_reference".into());
        }
        if self.bindings.len() > 32 {
            return Err("too_many_bindings".into());
        }
        for b in &self.bindings {
            if !valid_id(&b.open_id, "ou_") || !valid_id(&b.chat_id, "oc_") {
                return Err("invalid_identity_binding".into());
            }
        }
        if self.mobile_endpoint.len() > 512 {
            return Err("mobile_endpoint_too_long".into());
        }
        if !self.mobile_endpoint.is_empty() {
            let url =
                url::Url::parse(&self.mobile_endpoint).map_err(|_| "invalid_mobile_endpoint")?;
            if !matches!(url.scheme(), "https" | "http")
                || !url.username().is_empty()
                || url.password().is_some()
                || url.query().is_some()
                || url.fragment().is_some()
                || url.host_str().is_none()
            {
                return Err("invalid_mobile_endpoint".into());
            }
        }
        Ok(())
    }
    pub fn save(&self, data: &Path) -> Result<(), String> {
        self.validate()?;
        std::fs::create_dir_all(data).map_err(|_| "feishu_config_write_failed")?;
        let mut file =
            tempfile::NamedTempFile::new_in(data).map_err(|_| "feishu_config_write_failed")?;
        use std::io::Write;
        file.write_all(&serde_json::to_vec_pretty(self).map_err(|_| "feishu_config_invalid")?)
            .map_err(|_| "feishu_config_write_failed")?;
        file.as_file()
            .sync_all()
            .map_err(|_| "feishu_config_write_failed")?;
        file.persist(data.join("mobile-feishu.json"))
            .map_err(|_| "feishu_config_write_failed")?;
        Ok(())
    }
    pub fn allows(&self, open: &str, chat: &str) -> bool {
        self.bindings
            .iter()
            .any(|b| b.open_id == open && b.chat_id == chat)
    }
    pub fn resolve_proxy(&self, state: &AppState) -> Result<Option<ResolvedProxy>, String> {
        let config = match self.proxy_mode.as_str() {
            "none" => return Ok(None),
            "app" => AppProxyConfig::load_strict(&crate::proxy::default_app_proxy_path())?,
            "custom" => AppProxyConfig {
                enabled: true,
                ..self.custom_proxy.clone()
            },
            _ => return Err("invalid_proxy_mode".into()),
        };
        let db = state.db.lock().map_err(|_| "database_unavailable")?;
        crate::proxy::resolve_strict_with_db(&config, Some(&db), Some(&state.vault))
    }
}
fn valid_id(value: &str, prefix: &str) -> bool {
    value.starts_with(prefix)
        && value.len() > prefix.len()
        && value.len() <= 128
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}
