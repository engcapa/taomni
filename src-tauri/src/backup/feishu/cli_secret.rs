//! Minimal read-only secret storage compatibility with larksuite/cli v1.0.97.
//! Copyright (c) 2026 Lark Technologies Pte. Ltd. SPDX-License-Identifier: MIT
//! See resources/licenses/lark-cli-MIT.txt. No CLI user tokens are read.
use super::cli_config::{self, CliApp, SecretInput};
use zeroize::Zeroizing;

pub fn resolve(app: &CliApp) -> Result<Zeroizing<String>, String> {
    let secret = match &app.app_secret {
        SecretInput::Plain(value) => Zeroizing::new(value.clone()),
        SecretInput::Reference { source, id } if source == "file" => {
            let bytes = cli_config::read_file(std::path::Path::new(id), 64 * 1024)?;
            Zeroizing::new(
                std::str::from_utf8(&bytes)
                    .map_err(|_| "CLI secret file is not valid UTF-8")?
                    .trim()
                    .to_owned(),
            )
        }
        SecretInput::Reference { source, id } if source == "keychain" => {
            if id != &format!("appsecret:{}", app.app_id) {
                return Err(
                    "CLI App ID and secret reference do not match; repair the CLI configuration"
                        .into(),
                );
            }
            platform_secret(id)?
        }
        _ => {
            return Err(
                "Unsupported CLI secret reference; repair the existing application configuration"
                    .into(),
            );
        }
    };
    if secret.trim().is_empty() {
        return Err(
            "The existing CLI application secret is empty; repair it before connecting".into(),
        );
    }
    Ok(secret)
}

#[cfg(windows)]
fn platform_secret(account: &str) -> Result<Zeroizing<String>, String> {
    use base64::{
        Engine,
        engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    };
    use winreg::{
        RegKey,
        enums::{HKEY_CURRENT_USER, KEY_READ},
    };
    let root = RegKey::predef(HKEY_CURRENT_USER);
    let key = root
        .open_subkey_with_flags(r"Software\LarkCli\keychain\lark-cli", KEY_READ)
        .map_err(|_| "Cannot read the CLI application credential registry")?;
    let encoded: String = key
        .get_value(URL_SAFE_NO_PAD.encode(account))
        .map_err(|_| "Existing CLI application credential is missing or unreadable")?;
    if encoded.len() > 128 * 1024 {
        return Err("Existing CLI credential exceeds the size limit".into());
    }
    let mut cipher = STANDARD
        .decode(encoded)
        .map_err(|_| "Existing CLI credential encoding is damaged")?;
    let plain = unprotect(&mut cipher, account)?;
    Ok(Zeroizing::new(
        std::str::from_utf8(&plain)
            .map_err(|_| "Existing CLI credential is not valid UTF-8")?
            .to_owned(),
    ))
}
#[cfg(windows)]
fn unprotect(cipher: &mut [u8], account: &str) -> Result<Zeroizing<Vec<u8>>, String> {
    use windows::Win32::{
        Foundation::{HLOCAL, LocalFree},
        Security::Cryptography::{
            CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptUnprotectData,
        },
    };
    if cipher.is_empty() {
        return Err("Existing CLI credential is empty".into());
    }
    let mut entropy = format!("lark-cli\0{account}").into_bytes();
    let input = CRYPT_INTEGER_BLOB {
        cbData: cipher.len() as u32,
        pbData: cipher.as_mut_ptr(),
    };
    let entropy = CRYPT_INTEGER_BLOB {
        cbData: entropy.len() as u32,
        pbData: entropy.as_mut_ptr(),
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    // DPAPI output belongs to LocalFree. Copy, zero, and free before returning.
    unsafe {
        CryptUnprotectData(
            &input,
            None,
            Some(&entropy),
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
        .map_err(|_| "Cannot decrypt the CLI credential as the current OS user")?;
        if output.pbData.is_null() {
            return Err("Existing CLI credential is empty".into());
        }
        let data = std::slice::from_raw_parts_mut(output.pbData, output.cbData as usize);
        let plain = Zeroizing::new(data.to_vec());
        use zeroize::Zeroize;
        data.zeroize();
        let _ = LocalFree(Some(HLOCAL(output.pbData.cast())));
        Ok(plain)
    }
}

#[cfg(not(windows))]
fn safe_filename(account: &str) -> String {
    format!(
        "{}.enc",
        account
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() || "._-".contains(c) {
                c
            } else {
                '_'
            })
            .collect::<String>()
    )
}
#[cfg(any(not(windows), test))]
fn decrypt(data: &[u8], key: &[u8]) -> Result<Zeroizing<String>, String> {
    use aes_gcm::{Aes256Gcm, KeyInit, Nonce, aead::Aead};
    if data.len() < 28 || key.len() != 32 {
        return Err("Existing CLI encrypted credential or master key is damaged".into());
    }
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| "Invalid CLI master key")?;
    let plain = Zeroizing::new(
        cipher
            .decrypt(Nonce::from_slice(&data[..12]), &data[12..])
            .map_err(|_| "Existing CLI credential authentication failed")?,
    );
    Ok(Zeroizing::new(
        std::str::from_utf8(&plain)
            .map_err(|_| "Existing CLI credential is not valid UTF-8")?
            .to_owned(),
    ))
}
#[cfg(target_os = "linux")]
fn platform_secret(account: &str) -> Result<Zeroizing<String>, String> {
    let dir = match std::env::var_os("LARKSUITE_CLI_DATA_DIR").filter(|s| !s.is_empty()) {
        Some(path) => std::path::PathBuf::from(path),
        None => cli_config::home()?.join(".local/share/lark-cli"),
    };
    if !dir.is_absolute() {
        return Err("LARKSUITE_CLI_DATA_DIR must be an absolute directory".into());
    }
    let key = cli_config::read_file(&dir.join("master.key"), 32)?;
    decrypt(
        &cli_config::read_file(&dir.join(safe_filename(account)), 128 * 1024)?,
        &key,
    )
}
#[cfg(target_os = "macos")]
fn platform_secret(account: &str) -> Result<Zeroizing<String>, String> {
    use base64::{Engine, engine::general_purpose::STANDARD};
    let dir = cli_config::home()?.join("Library/Application Support/lark-cli");
    let data = cli_config::read_file(&dir.join(safe_filename(account)), 128 * 1024)?;
    if let Ok(key) = cli_config::read_file(&dir.join("master.key.file"), 32) {
        if let Ok(secret) = decrypt(&data, &key) {
            return Ok(secret);
        }
    }
    let encoded = Zeroizing::new(
        security_framework::passwords::get_generic_password("lark-cli", "master.key").map_err(
            |_| "Allow access to the existing CLI master key in macOS Keychain and retry",
        )?,
    );
    let key = Zeroizing::new(
        STANDARD
            .decode(&encoded)
            .map_err(|_| "Existing CLI master key encoding is damaged")?,
    );
    decrypt(&data, &key)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn never_resolve_a_mismatched_reference_or_user_token() {
        let app = CliApp {
            name: String::new(),
            app_id: "cli_test".into(),
            brand: "feishu".into(),
            app_secret: SecretInput::Reference {
                source: "keychain".into(),
                id: "cli_test:ou_user".into(),
            },
        };
        assert!(resolve(&app).unwrap_err().contains("do not match"));
    }
    #[test]
    fn aes_gcm_compatibility_and_tampering() {
        use aes_gcm::{Aes256Gcm, KeyInit, Nonce, aead::Aead};
        let key = [7; 32];
        let nonce = [3; 12];
        let cipher = Aes256Gcm::new_from_slice(&key).unwrap();
        let mut data = nonce.to_vec();
        data.extend(
            cipher
                .encrypt(Nonce::from_slice(&nonce), b"fixture-secret".as_ref())
                .unwrap(),
        );
        assert_eq!(decrypt(&data, &key).unwrap().as_str(), "fixture-secret");
        data[12] ^= 1;
        assert!(decrypt(&data, &key).is_err());
        assert!(decrypt(&data, &[0; 31]).is_err());
    }
    #[cfg(windows)]
    #[test]
    fn dpapi_entropy_matches_official_cli_and_rejects_other_account() {
        use windows::Win32::{
            Foundation::{HLOCAL, LocalFree},
            Security::Cryptography::{
                CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData,
            },
        };
        let mut plain = b"fixture-secret".to_vec();
        let mut entropy = b"lark-cli\0appsecret:cli_test".to_vec();
        let input = CRYPT_INTEGER_BLOB {
            cbData: plain.len() as u32,
            pbData: plain.as_mut_ptr(),
        };
        let entropy = CRYPT_INTEGER_BLOB {
            cbData: entropy.len() as u32,
            pbData: entropy.as_mut_ptr(),
        };
        let mut output = CRYPT_INTEGER_BLOB::default();
        let mut data = unsafe {
            CryptProtectData(
                &input,
                None,
                Some(&entropy),
                None,
                None,
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
            .unwrap();
            let data = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
            let _ = LocalFree(Some(HLOCAL(output.pbData.cast())));
            data
        };
        assert_eq!(
            unprotect(&mut data, "appsecret:cli_test")
                .unwrap()
                .as_slice(),
            b"fixture-secret"
        );
        assert!(unprotect(&mut data, "appsecret:cli_other").is_err());
    }
}
