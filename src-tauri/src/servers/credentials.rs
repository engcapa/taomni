use super::model::ServerConfig;
use crate::state::AppState;

pub(super) const RDP_PASSWORD_KIND: &str = "rdp-server-password";
pub(super) const RDP_PASSWORD_LABEL: &str = "RDP server password";

pub(super) fn rdp_plaintext_password(config: &serde_json::Value) -> Option<&str> {
    config
        .get("password")
        .and_then(|value| value.as_str())
        .filter(|password| {
            !password.is_empty() && !password.starts_with(crate::vault::VAULT_REF_PREFIX)
        })
}

pub(super) fn redact_rdp_password(config: &mut serde_json::Value) {
    if let Some(object) = config.as_object_mut() {
        object.remove("password");
    }
}

pub(super) fn redact_legacy_rdp_password(config: &mut serde_json::Value) {
    if let Some(object) = config.as_object_mut() {
        object.remove("password");
        object.insert(
            "credentialMigrationRequired".to_string(),
            serde_json::Value::Bool(true),
        );
    }
}

/// Move an RDP password out of the general configuration database and into the
/// encrypted credential vault. The returned JSON is safe to persist or send
/// back to the frontend: it contains only a `vault:` reference.
pub(super) fn secure_rdp_config(
    vault: &crate::vault::Vault,
    config: &mut serde_json::Value,
    legacy_password: Option<&str>,
) -> Result<(), String> {
    let object = config
        .as_object_mut()
        .ok_or_else(|| "invalid RDP server config: expected an object".to_string())?;

    let submitted_password = object
        .remove("password")
        .and_then(|value| value.as_str().map(str::to_owned))
        .filter(|password| !password.is_empty());
    let existing_reference = object
        .get("passwordRef")
        .and_then(|value| value.as_str())
        .filter(|reference| reference.starts_with(crate::vault::VAULT_REF_PREFIX))
        .map(str::to_owned);
    let plaintext = submitted_password
        .as_deref()
        .filter(|password| !password.starts_with(crate::vault::VAULT_REF_PREFIX))
        .or(legacy_password);

    let reference = if let Some(plaintext) = plaintext {
        if let Some(reference) = existing_reference.as_deref() {
            let id = reference
                .strip_prefix(crate::vault::VAULT_REF_PREFIX)
                .ok_or_else(|| "invalid RDP password vault reference".to_string())?;
            vault.update(id, plaintext)?;
            reference.to_string()
        } else {
            vault
                .put(RDP_PASSWORD_KIND, RDP_PASSWORD_LABEL, plaintext)?
                .reference
        }
    } else if let Some(reference) = existing_reference {
        reference
    } else if let Some(reference) = submitted_password
        .as_deref()
        .filter(|password| password.starts_with(crate::vault::VAULT_REF_PREFIX))
    {
        reference.to_string()
    } else {
        return Err(
            "RDP server password is required and must be stored in the credential vault"
                .to_string(),
        );
    };

    object.insert(
        "passwordRef".to_string(),
        serde_json::Value::String(reference),
    );
    object.remove("credentialMigrationRequired");
    Ok(())
}

pub(super) fn resolve_rdp_password(
    state: &AppState,
    config: &mut ServerConfig,
) -> Result<(), String> {
    let reference = config
        .extra
        .get("passwordRef")
        .and_then(|value| value.as_str())
        .ok_or_else(|| "RDP server password is not stored in the credential vault".to_string())?;
    let password = state
        .vault
        .resolve(reference)?
        .ok_or_else(|| "invalid RDP server password vault reference".to_string())?;
    config.extra.insert(
        "password".to_string(),
        serde_json::Value::String(password.to_string()),
    );
    Ok(())
}
