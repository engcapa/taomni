//! Opt-in loopback service for the isolated QA application only.
use super::{control, credentials, model::*};
use serde::Deserialize;

#[derive(Deserialize)]
pub struct Fixture {
    pub endpoint: String,
    pub connection_id: String,
    pub target_id: String,
}
pub fn fixture(app: &tauri::AppHandle) -> Result<Option<Fixture>, String> {
    if !cfg!(debug_assertions) || app.config().identifier != crate::QA_APP_ID {
        return Ok(None);
    }
    let path = control::root(app)?.join("qa-fixture.json");
    if !path.exists() {
        return Ok(None);
    }
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    if bytes.len() > 4096 {
        return Err("Oversized backup QA configuration".into());
    }
    let value: Fixture =
        serde_json::from_slice(&bytes).map_err(|_| "Invalid backup QA configuration")?;
    let url = reqwest::Url::parse(&value.endpoint).map_err(|_| "Invalid backup QA endpoint")?;
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || url.port().is_none()
        || url.path() != "/"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("Backup QA endpoint must be an explicit loopback port".into());
    }
    validate_id(&value.connection_id)?;
    validate_id(&value.target_id)?;
    Ok(Some(value))
}
pub fn initialize(app: &tauri::AppHandle) -> Result<(), String> {
    let Some(fixture) = fixture(app)? else {
        return Ok(());
    };
    let profile = control::load(app)?.device.id;
    let mut secrets = credentials::get_connection(&profile, &fixture.connection_id)?;
    if secrets.app_id.is_empty() {
        secrets.app_id = "cli_qa_fixture".into();
        secrets.app_secret = "synthetic-qa-secret".into();
        secrets.access_token = "synthetic-qa-access".into();
        secrets.refresh_token = "synthetic-qa-refresh".into();
        secrets.expires_at = now_ms() + 3600_000;
        secrets.refresh_expires_at = now_ms() + 86400_000;
        secrets.granted_scopes = super::feishu::auth::required_scopes().into();
        credentials::put_connection(&profile, &fixture.connection_id, &secrets)?;
        let mut target = credentials::Secrets::default();
        target.archive_password = "synthetic-qa-backup-password".into();
        credentials::put(&profile, &fixture.target_id, &target)?;
    }
    Ok(())
}
