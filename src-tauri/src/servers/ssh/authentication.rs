use russh::keys::Algorithm;
use russh::keys::HashAlg;
use russh::keys::PrivateKey;
use russh::keys::PublicKey;
use russh::keys::ssh_key;
use russh::server::Auth;
use tauri::AppHandle;

/* ----------------------------- auth model ---------------------------- */

#[derive(Clone)]
pub(super) struct AuthPolicy {
    pub(super) password: Option<String>,
    pub(super) authorized_keys: Vec<PublicKey>,
    pub(super) allowed_users: Vec<String>,
}

impl AuthPolicy {
    pub(super) fn user_allowed(&self, user: &str) -> bool {
        self.allowed_users.is_empty() || self.allowed_users.iter().any(|u| u == user)
    }

    pub(super) fn public_key_ok(&self, offered: &PublicKey) -> bool {
        self.authorized_keys.iter().any(|k| k == offered)
    }
}

pub(super) fn reject() -> Auth {
    Auth::Reject {
        proceed_with_methods: None,
        partial_success: false,
    }
}

/// Load or generate a persistent Ed25519 host key under app-data.
pub(super) fn load_or_create_host_key(app: &AppHandle) -> Result<(PrivateKey, String), String> {
    let dir = crate::resolved_app_data_dir(app)?.join("ssh-server");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("create ssh-server dir {}: {e}", dir.display()))?;
    let path = dir.join("host_ed25519");

    let key = if path.is_file() {
        PrivateKey::read_openssh_file(&path)
            .map_err(|e| format!("read host key {}: {e}", path.display()))?
    } else {
        let key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519)
            .map_err(|e| format!("generate SSH host key: {e}"))?;
        key.write_openssh_file(&path, ssh_key::LineEnding::LF)
            .map_err(|e| format!("write host key {}: {e}", path.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
        }
        key
    };
    let fingerprint = key.fingerprint(HashAlg::Sha256).to_string();
    Ok((key, fingerprint))
}

/// Parse all usable public-key lines from multi-line text (inline config).
pub(super) fn parse_authorized_keys_text(
    text: &str,
    source: &str,
) -> Result<Vec<PublicKey>, String> {
    let mut keys = Vec::new();
    for (idx, line) in text.lines().enumerate() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if trimmed.split_whitespace().count() < 2 {
            return Err(format!(
                "{source} line {}: expected 'ssh-… AAAA…' OpenSSH public key",
                idx + 1
            ));
        }
        keys.push(
            parse_authorized_key(trimmed).map_err(|e| format!("{source} line {}: {e}", idx + 1))?,
        );
    }
    Ok(keys)
}

/// Load every usable public-key line from an authorized_keys / .pub file.
pub(super) fn load_authorized_keys_file(path: &str) -> Result<Vec<PublicKey>, String> {
    let contents = std::fs::read_to_string(path)
        .map_err(|e| format!("cannot read authorized key file '{}': {}", path, e))?;
    let keys = parse_authorized_keys_text(&contents, path)?;
    if keys.is_empty() {
        return Err(format!(
            "authorized key file '{}' has no usable public-key lines",
            path
        ));
    }
    Ok(keys)
}

/// Back-compat helper used by older tests — first usable line only.
#[cfg(test)]
pub(super) fn load_authorized_key_file(path: &str) -> Result<String, String> {
    let contents = std::fs::read_to_string(path)
        .map_err(|e| format!("cannot read authorized key file '{}': {}", path, e))?;
    for line in contents.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if trimmed.split_whitespace().count() >= 2 {
            return Ok(trimmed.to_string());
        }
    }
    Err(format!(
        "authorized key file '{}' has no usable public-key line",
        path
    ))
}

/// Parse a single OpenSSH `authorized_keys`-style line ("<algo> <base64> [comment]").
pub(super) fn parse_authorized_key(line: &str) -> Result<PublicKey, String> {
    let mut parts = line.split_whitespace();
    let _algo = parts.next();
    let b64 = parts
        .next()
        .ok_or_else(|| "authorizedKey must be in 'ssh-... AAAA...' OpenSSH format".to_string())?;
    russh::keys::parse_public_key_base64(b64).map_err(|e| format!("invalid authorizedKey: {}", e))
}
