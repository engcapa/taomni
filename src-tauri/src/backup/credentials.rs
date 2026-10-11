//! OS credential storage, independent of the restorable application vault.
// The v1 wrapper lazily initializes the OS store; core::Entry alone has no default store.
use keyring::{Entry, Error};
use serde::{Deserialize, Serialize};
use zeroize::{ZeroizeOnDrop, Zeroizing};

#[derive(Clone, Serialize, Deserialize, Default, ZeroizeOnDrop)]
pub struct Secrets {
    #[serde(default)]
    pub app_secret: String,
    #[serde(default)]
    pub archive_password: String,
    #[serde(default)]
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: String,
    #[serde(default)]
    pub expires_at: i64,
    #[serde(default)]
    pub account_id: String,
}
#[derive(Clone, Serialize, Deserialize, Default, ZeroizeOnDrop)]
pub struct ConnectionSecrets {
    #[serde(default)]
    pub app_id: String,
    #[serde(default)]
    pub app_secret: String,
    #[serde(default)]
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: String,
    #[serde(default)]
    pub expires_at: i64,
    #[serde(default)]
    pub refresh_expires_at: i64,
    #[serde(default)]
    pub granted_scopes: String,
    #[serde(default)]
    pub generation: u64,
    /// Written before consuming a rotating refresh token; a crash must not replay it.
    #[serde(default)]
    pub refresh_in_flight: bool,
}
fn entry(profile: &str, target: &str) -> Result<Entry, String> {
    super::model::validate_id(profile)?;
    super::model::validate_id(target)?;
    Entry::new("taomni.backup", &format!("{profile}/{target}"))
        .map_err(|_| "System credential store is unavailable".into())
}
pub fn get(profile: &str, target: &str) -> Result<Secrets, String> {
    match entry(profile, target)?.get_password() {
        Ok(value) => serde_json::from_str(&Zeroizing::new(value))
            .map_err(|_| "Backup credential data is damaged; reconnect the target".into()),
        Err(Error::NoEntry) => Ok(Secrets::default()),
        Err(_) => Err("Cannot read the system credential store; unlock it and retry".into()),
    }
}
pub fn put(profile: &str, target: &str, value: &Secrets) -> Result<(), String> {
    entry(profile, target)?
        .set_password(&Zeroizing::new(
            serde_json::to_string(value).map_err(|_| "Cannot encode credentials")?,
        ))
        .map_err(|_| "Cannot save backup credentials in the system credential store".into())
}

pub fn get_connection(profile: &str, id: &str) -> Result<ConnectionSecrets, String> {
    let root = entry(profile, id)?;
    for _ in 0..3 {
        let index = match root.get_password() {
            Ok(value) => Zeroizing::new(value),
            Err(Error::NoEntry) => return Ok(ConnectionSecrets::default()),
            Err(_) => {
                return Err("Cannot read the system credential store; unlock it and retry".into());
            }
        };
        if let Ok(parts) = serde_json::from_str::<CredentialParts>(&index) {
            parts.validate()?;
            let result = read_parts(profile, id, &parts);
            // A concurrent publisher may have removed the old generation after this
            // reader obtained its index. Retry only if the index actually changed.
            if root.get_password().ok().as_deref() != Some(index.as_str()) {
                continue;
            }
            return result;
        }
        // Compatibility with small JSON bundles written by the original draft.
        return serde_json::from_str(&index)
            .map_err(|_| "Feishu credentials are damaged; reconnect the account".into());
    }
    Err("Feishu credentials changed while being read; retry".into())
}
pub fn put_connection(profile: &str, id: &str, value: &ConnectionSecrets) -> Result<(), String> {
    let root = entry(profile, id)?;
    let previous = match root.get_password() {
        Ok(value) => serde_json::from_str::<CredentialParts>(&Zeroizing::new(value)).ok(),
        Err(Error::NoEntry) => None,
        Err(_) => {
            return Err("Cannot read the system credential store; unlock it and retry".into());
        }
    };
    let encoded =
        Zeroizing::new(serde_json::to_vec(value).map_err(|_| "Cannot encode Feishu credentials")?);
    if encoded.len() > MAX_CREDENTIAL_BYTES {
        return Err("Feishu credentials exceed the supported size".into());
    }
    let parts = CredentialParts {
        format: 1,
        generation: uuid::Uuid::new_v4().to_string(),
        count: encoded.len().div_ceil(CREDENTIAL_PART_BYTES),
        sha256: super::manifest::bytes_sha256(&encoded),
    };
    for (index, bytes) in encoded.chunks(CREDENTIAL_PART_BYTES).enumerate() {
        if part_entry(profile, id, &parts.generation, index)?
            .set_secret(bytes)
            .is_err()
        {
            remove_parts(profile, id, &parts);
            return Err("Cannot save Feishu credentials in the system credential store".into());
        }
    }
    // Publish one small index only after all immutable chunks are durable. A
    // failed save leaves the previously published token generation usable.
    if root
        .set_password(
            &serde_json::to_string(&parts).map_err(|_| "Cannot encode Feishu credentials")?,
        )
        .is_err()
    {
        remove_parts(profile, id, &parts);
        return Err("Cannot save Feishu credentials in the system credential store".into());
    }
    if let Some(previous) = previous.filter(|p| p.validate().is_ok()) {
        remove_parts(profile, id, &previous);
    }
    Ok(())
}

// Windows limits a credential blob to 2,560 bytes; password UTF-16 encoding
// consumes that budget faster. Keep long OAuth bundles entirely in the OS store.
const CREDENTIAL_PART_BYTES: usize = 2000;
const MAX_CREDENTIAL_BYTES: usize = 128 * 1024;
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct CredentialParts {
    format: u32,
    generation: String,
    count: usize,
    sha256: String,
}
impl CredentialParts {
    fn validate(&self) -> Result<(), String> {
        super::model::validate_id(&self.generation)?;
        if self.format != 1
            || self.count == 0
            || self.count > MAX_CREDENTIAL_BYTES.div_ceil(CREDENTIAL_PART_BYTES)
        {
            return Err("Feishu credentials are damaged; reconnect the account".into());
        }
        Ok(())
    }
}
fn part_entry(profile: &str, id: &str, generation: &str, index: usize) -> Result<Entry, String> {
    super::model::validate_id(profile)?;
    super::model::validate_id(id)?;
    super::model::validate_id(generation)?;
    Entry::new(
        "taomni.backup",
        &format!("{profile}/{id}/{generation}/{index}"),
    )
    .map_err(|_| "System credential store is unavailable".into())
}
fn read_parts(
    profile: &str,
    id: &str,
    parts: &CredentialParts,
) -> Result<ConnectionSecrets, String> {
    let mut bytes = Zeroizing::new(Vec::new());
    for index in 0..parts.count {
        let part = Zeroizing::new(
            part_entry(profile, id, &parts.generation, index)?
                .get_secret()
                .map_err(|_| "Cannot read the system credential store; unlock it and retry")?,
        );
        if part.len() > CREDENTIAL_PART_BYTES || bytes.len() + part.len() > MAX_CREDENTIAL_BYTES {
            return Err("Feishu credentials are damaged; reconnect the account".into());
        }
        bytes.extend_from_slice(&part);
    }
    if super::manifest::bytes_sha256(&bytes) != parts.sha256 {
        return Err("Feishu credentials are damaged; reconnect the account".into());
    }
    serde_json::from_slice(&bytes)
        .map_err(|_| "Feishu credentials are damaged; reconnect the account".into())
}
fn remove_parts(profile: &str, id: &str, parts: &CredentialParts) {
    for index in 0..parts.count {
        if let Ok(entry) = part_entry(profile, id, &parts.generation, index) {
            let _ = entry.delete_credential();
        }
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    #[test]
    fn native_store_initializes_and_roundtrips_separate_target_and_connection_entries() {
        let profile = uuid::Uuid::new_v4().to_string();
        let target = uuid::Uuid::new_v4().to_string();
        let connection = uuid::Uuid::new_v4().to_string();
        struct Cleanup {
            profile: String,
            ids: Vec<String>,
        }
        impl Drop for Cleanup {
            fn drop(&mut self) {
                for id in &self.ids {
                    if let Ok(entry) = entry(&self.profile, id) {
                        if let Ok(value) = entry.get_password() {
                            if let Ok(parts) =
                                serde_json::from_str::<CredentialParts>(&Zeroizing::new(value))
                            {
                                if parts.validate().is_ok() {
                                    remove_parts(&self.profile, id, &parts);
                                }
                            }
                        }
                        let _ = entry.delete_credential();
                    }
                }
            }
        }
        let _cleanup = Cleanup {
            profile: profile.clone(),
            ids: vec![target.clone(), connection.clone()],
        };
        assert!(get(&profile, &target).unwrap().archive_password.is_empty());
        let mut secrets = Secrets::default();
        secrets.archive_password = "synthetic-backup-password".into();
        put(&profile, &target, &secrets).unwrap();
        let mut tokens = ConnectionSecrets::default();
        tokens.app_secret = "synthetic-app-secret".into();
        tokens.refresh_token = "synthetic-refresh-token".repeat(200);
        tokens.access_token = "synthetic-access-token".repeat(200);
        tokens.generation = 2;
        put_connection(&profile, &connection, &tokens).unwrap();
        assert_eq!(
            get(&profile, &target).unwrap().archive_password,
            "synthetic-backup-password"
        );
        assert_eq!(get_connection(&profile, &connection).unwrap().generation, 2);
        assert_eq!(
            get_connection(&profile, &connection).unwrap().refresh_token,
            tokens.refresh_token
        );
        let first: CredentialParts = serde_json::from_str(
            &entry(&profile, &connection)
                .unwrap()
                .get_password()
                .unwrap(),
        )
        .unwrap();
        assert!(first.count > 2);
        tokens.generation = 3;
        put_connection(&profile, &connection, &tokens).unwrap();
        assert_eq!(get_connection(&profile, &connection).unwrap().generation, 3);
        assert!(matches!(
            part_entry(&profile, &connection, &first.generation, 0)
                .unwrap()
                .get_secret(),
            Err(Error::NoEntry)
        ));
        tokens.access_token = "x".repeat(MAX_CREDENTIAL_BYTES);
        assert!(put_connection(&profile, &connection, &tokens).is_err());
        assert_eq!(get_connection(&profile, &connection).unwrap().generation, 3);
        assert!(get(&profile, &target).unwrap().app_secret.is_empty());
    }
}
