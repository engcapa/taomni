//! User-requested OpenSSH keypair creation; never overwrite an existing key.
use russh::keys::ssh_key::{Algorithm, HashAlg, LineEnding, PrivateKey};
use serde::Serialize;
use std::io::Write;
use std::path::{Path, PathBuf};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedKey {
    path: String,
    public_path: String,
    fingerprint: String,
}

fn private_file(path: &Path) -> Result<std::fs::File, String> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options
        .open(path)
        .map_err(|e| format!("Create private key: {e}"))?;
    #[cfg(windows)]
    {
        // Remove inherited ACL entries before writing any private key bytes.
        let secure = (|| -> Result<(), String> {
            let identity = std::process::Command::new("whoami.exe")
                .args(["/user", "/fo", "csv", "/nh"])
                .output()
                .map_err(|e| e.to_string())?;
            let output = String::from_utf8_lossy(&identity.stdout);
            let sid = output
                .split('"')
                .find(|s| {
                    s.starts_with("S-1-")
                        && s.chars()
                            .all(|c| c.is_ascii_digit() || c == 'S' || c == '-')
                })
                .ok_or("Could not resolve the current Windows account SID")?;
            let result = std::process::Command::new("icacls.exe")
                .arg(path)
                .args(["/inheritance:r", "/grant:r", &format!("*{sid}:F")])
                .output()
                .map_err(|e| e.to_string())?;
            if !result.status.success() {
                return Err("Could not restrict private key permissions".into());
            }
            Ok(())
        })();
        if let Err(error) = secure {
            drop(file);
            let _ = std::fs::remove_file(path);
            return Err(error);
        }
    }
    Ok(file)
}

fn generate(path: &Path, passphrase: &str, comment: &str) -> Result<GeneratedKey, String> {
    if !path.is_absolute() {
        return Err("Private key path must be absolute".into());
    }
    let public_path = PathBuf::from(format!("{}.pub", path.to_string_lossy()));
    if path.exists() || public_path.exists() {
        return Err("A key already exists at this path; choose another filename".into());
    }
    let mut key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519)
        .map_err(|e| format!("Generate Ed25519 key: {e}"))?;
    key.set_comment(comment.replace(['\r', '\n'], " "));
    let fingerprint = key.fingerprint(HashAlg::Sha256).to_string();
    let public = key.public_key().to_openssh().map_err(|e| e.to_string())?;
    let key = if passphrase.is_empty() {
        key
    } else {
        key.encrypt(&mut rand::rng(), passphrase)
            .map_err(|e| format!("Encrypt private key: {e}"))?
    };
    let encoded = key.to_openssh(LineEnding::LF).map_err(|e| e.to_string())?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut private = private_file(path)?;
    let mut public_file = match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&public_path)
    {
        Ok(file) => file,
        Err(error) => {
            drop(private);
            let _ = std::fs::remove_file(path);
            return Err(format!("Create public key: {error}"));
        }
    };
    let written = (|| -> std::io::Result<()> {
        private.write_all(encoded.as_bytes())?;
        private.sync_all()?;
        writeln!(public_file, "{public}")?;
        public_file.sync_all()
    })();
    drop(private);
    drop(public_file);
    if let Err(error) = written {
        let _ = std::fs::remove_file(path);
        let _ = std::fs::remove_file(&public_path);
        return Err(format!("Write keypair: {error}"));
    }
    Ok(GeneratedKey {
        path: path.to_string_lossy().into_owned(),
        public_path: public_path.to_string_lossy().into_owned(),
        fingerprint,
    })
}

#[tauri::command]
pub async fn generate_ssh_key(
    path: String,
    passphrase: String,
    comment: String,
) -> Result<GeneratedKey, String> {
    tauri::async_runtime::spawn_blocking(move || generate(Path::new(&path), &passphrase, &comment))
        .await
        .map_err(|e| format!("Key generation task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn encrypted_keypair_roundtrips_and_existing_keys_are_never_replaced() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("id_ed25519");
        let result = generate(&path, "fixture-passphrase", "qa key").unwrap();
        let bytes = std::fs::read(&path).unwrap();
        let key = PrivateKey::read_openssh_file(&path).unwrap();
        assert!(key.is_encrypted());
        assert!(key.decrypt("wrong").is_err());
        let decrypted = key.decrypt("fixture-passphrase").unwrap();
        assert_eq!(
            decrypted.fingerprint(HashAlg::Sha256).to_string(),
            result.fingerprint
        );
        let public = std::fs::read_to_string(result.public_path).unwrap();
        assert!(public.starts_with("ssh-ed25519 "));
        assert!(public.trim_end().ends_with("qa key"));
        assert!(generate(&path, "", "replacement").is_err());
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }
}
