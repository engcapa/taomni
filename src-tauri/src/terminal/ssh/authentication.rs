use super::connection::SshHandler;
use russh::client;
use russh::client::KeyboardInteractiveAuthResponse;
use russh::keys;
use russh::keys::PrivateKey;
use russh::keys::PrivateKeyWithHashAlg;
use russh::keys::ssh_key::Algorithm as SshAlgorithm;
use russh::keys::ssh_key::HashAlg;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

#[derive(Clone)]
pub enum SshAuth {
    Password(String),
    PrivateKey(String),
    Agent,
}

/// A single prompt inside a keyboard-interactive auth round (e.g. the
/// "Please Input Mfa Code (AliyunOTP):" line from an Aliyun bastion host).
#[derive(Clone, Debug)]
pub struct KbdPrompt {
    pub prompt: String,
    /// When `false` the answer is secret (e.g. password/OTP) and the UI should
    /// mask it. When `true` the typed characters may be echoed.
    pub echo: bool,
}

/// One keyboard-interactive request from the server. A server may send several
/// of these in sequence; each carries zero or more prompts the user must
/// answer.
#[derive(Clone, Debug)]
pub struct KbdInteractiveRequest {
    pub name: String,
    pub instructions: String,
    pub prompts: Vec<KbdPrompt>,
}

/// Callback invoked for each keyboard-interactive round. Implementations
/// surface the prompts to the user and resolve with one response per prompt,
/// or `None` if the user cancelled (which aborts the connection). The terminal
/// connect path wires this to a Tauri event + `submit_ssh_auth_response`
/// round-trip; non-interactive callers (tunnels) pass `None` and simply can't
/// satisfy interactive MFA.
pub type KbdInteractivePrompter = Arc<
    dyn Fn(KbdInteractiveRequest) -> Pin<Box<dyn Future<Output = Option<Vec<String>>> + Send>>
        + Send
        + Sync,
>;

pub(super) async fn authenticate(
    handle: &mut client::Handle<SshHandler>,
    username: &str,
    auth: SshAuth,
    prompter: Option<&KbdInteractivePrompter>,
) -> Result<(), String> {
    match auth {
        SshAuth::Password(password) => {
            // First try plain password auth. Many enterprise hosts (e.g. Aliyun
            // bastion) accept the password as the first factor but then demand
            // a second keyboard-interactive factor (an MFA/OTP code). russh
            // collapses that partial success into `false`, so on a non-success
            // we fall through to keyboard-interactive while the connection is
            // still alive, mirroring how OpenSSH / MobaXterm behave.
            let ok = handle
                .authenticate_password(username, &password)
                .await
                .map_err(|e| format!("SSH auth failed: {}", e))?;
            if ok.success() {
                return Ok(());
            }
            if let Some(prompter) = prompter {
                return authenticate_keyboard_interactive(
                    handle,
                    username,
                    Some(&password),
                    prompter,
                )
                .await;
            }
            return Err("SSH password authentication rejected".to_string());
        }
        SshAuth::PrivateKey(key_path) => {
            let key_path = shellexpand::tilde(&key_path).to_string();
            let key = keys::load_secret_key(&key_path, None)
                .map_err(|e| format!("Failed to load key {}: {}", key_path, e))?;
            authenticate_private_key(handle, username, key).await?;
        }
        SshAuth::Agent => {
            return Err("SSH agent auth not yet implemented".to_string());
        }
    }
    Ok(())
}

/// Drive a keyboard-interactive auth exchange to completion. Each
/// `InfoRequest` round is forwarded to `prompter`; its answers are sent back.
///
/// As a convenience, when a round has exactly one non-echo prompt that looks
/// like a password request and we still hold an unused password (`known_password`),
/// it is answered automatically without bothering the user — this covers
/// servers that expose the *password* itself via keyboard-interactive. Every
/// other prompt (notably the MFA/OTP code) is surfaced to the user.
pub(super) async fn authenticate_keyboard_interactive(
    handle: &mut client::Handle<SshHandler>,
    username: &str,
    known_password: Option<&str>,
    prompter: &KbdInteractivePrompter,
) -> Result<(), String> {
    let mut response = handle
        .authenticate_keyboard_interactive_start(username, None)
        .await
        .map_err(|e| format!("SSH keyboard-interactive auth failed: {}", e))?;

    let mut password_used = false;

    loop {
        match response {
            KeyboardInteractiveAuthResponse::Success => return Ok(()),
            KeyboardInteractiveAuthResponse::Failure { .. } => {
                return Err("SSH authentication rejected (MFA/keyboard-interactive)".to_string());
            }
            KeyboardInteractiveAuthResponse::InfoRequest {
                name,
                instructions,
                prompts,
            } => {
                // Empty info-requests need an empty response set; just continue.
                if prompts.is_empty() {
                    response = handle
                        .authenticate_keyboard_interactive_respond(Vec::new())
                        .await
                        .map_err(|e| format!("SSH keyboard-interactive auth failed: {}", e))?;
                    continue;
                }

                // Auto-answer a lone password prompt when we already have one.
                if !password_used {
                    if let Some(pw) = known_password {
                        if prompts.len() == 1
                            && !prompts[0].echo
                            && looks_like_password_prompt(&prompts[0].prompt)
                        {
                            password_used = true;
                            response = handle
                                .authenticate_keyboard_interactive_respond(vec![pw.to_string()])
                                .await
                                .map_err(|e| {
                                    format!("SSH keyboard-interactive auth failed: {}", e)
                                })?;
                            continue;
                        }
                    }
                }

                let request = KbdInteractiveRequest {
                    name,
                    instructions,
                    prompts: prompts
                        .into_iter()
                        .map(|p| KbdPrompt {
                            prompt: p.prompt,
                            echo: p.echo,
                        })
                        .collect(),
                };
                let answers = prompter(request)
                    .await
                    .ok_or_else(|| "SSH authentication cancelled".to_string())?;

                response = handle
                    .authenticate_keyboard_interactive_respond(answers)
                    .await
                    .map_err(|e| format!("SSH keyboard-interactive auth failed: {}", e))?;
            }
        }
    }
}

/// Heuristic: does this keyboard-interactive prompt look like a request for the
/// account password (as opposed to an MFA/OTP code, which we must never
/// auto-fill with the password)?
pub(super) fn looks_like_password_prompt(prompt: &str) -> bool {
    let p = prompt.to_ascii_lowercase();
    p.contains("password") || p.contains("密码")
}

pub(super) async fn authenticate_private_key(
    handle: &mut client::Handle<SshHandler>,
    username: &str,
    key: PrivateKey,
) -> Result<(), String> {
    let best_rsa_hash = handle
        .best_supported_rsa_hash()
        .await
        .map_err(|e| format!("SSH key auth failed while probing RSA algorithms: {}", e))?
        .flatten();
    let attempts = private_key_auth_attempts(key, best_rsa_hash);
    let mut tried = Vec::with_capacity(attempts.len());

    for key in attempts {
        let algorithm = key.algorithm().as_str().to_string();
        tried.push(algorithm.clone());
        let ok = handle
            .authenticate_publickey(username, key)
            .await
            .map_err(|e| format!("SSH key auth failed using {}: {}", algorithm, e))?;
        if ok.success() {
            return Ok(());
        }
    }

    Err(format!(
        "SSH key authentication rejected (tried {})",
        tried.join(", ")
    ))
}

pub(super) fn private_key_auth_attempts(
    key: PrivateKey,
    best_rsa_hash: Option<HashAlg>,
) -> Vec<PrivateKeyWithHashAlg> {
    let key = Arc::new(key);
    if !matches!(key.algorithm(), SshAlgorithm::Rsa { .. }) {
        return vec![PrivateKeyWithHashAlg::new(key, None)];
    }

    let mut hashes = Vec::new();
    if let Some(hash) = best_rsa_hash {
        hashes.push(Some(hash));
    }
    for hash in [Some(HashAlg::Sha512), Some(HashAlg::Sha256), None] {
        if !hashes.contains(&hash) {
            hashes.push(hash);
        }
    }
    hashes
        .into_iter()
        .map(|hash| PrivateKeyWithHashAlg::new(key.clone(), hash))
        .collect()
}
