//! Authenticate using keys held by the platform SSH agent; no private key leaves it.
use super::connection::SshHandler;
use russh::client;
use russh::keys::agent::client::AgentClient;
use russh::keys::ssh_key::{Algorithm, HashAlg};

pub(super) async fn authenticate(
    handle: &mut client::Handle<SshHandler>,
    username: &str,
) -> Result<(), String> {
    #[cfg(unix)]
    let connection = AgentClient::connect_env();
    #[cfg(windows)]
    let connection = AgentClient::connect_named_pipe(r"\\.\pipe\openssh-ssh-agent");
    let mut agent = tokio::time::timeout(std::time::Duration::from_secs(10), connection)
        .await
        .map_err(|_| "SSH agent connection timed out")?
        .map_err(|e| format!("Cannot connect to SSH agent: {e}"))?;
    let keys = agent
        .request_identities()
        .await
        .map_err(|e| format!("Read SSH agent identities: {e}"))?;
    if keys.is_empty() {
        return Err("SSH agent has no identities; add a key with ssh-add".into());
    }
    for identity in keys {
        let key = identity.public_key().into_owned();
        let hash = if matches!(key.algorithm(), Algorithm::Rsa { .. }) {
            Some(HashAlg::Sha512)
        } else {
            None
        };
        let result = match identity {
            russh::keys::agent::AgentIdentity::PublicKey { key, .. } => {
                handle
                    .authenticate_publickey_with(username, key, hash, &mut agent)
                    .await
            }
            russh::keys::agent::AgentIdentity::Certificate { certificate, .. } => {
                handle
                    .authenticate_certificate_with(username, certificate, hash, &mut agent)
                    .await
            }
        }
        .map_err(|e| format!("SSH agent signing failed: {e}"))?;
        if result.success() {
            return Ok(());
        }
    }
    Err("Server rejected all SSH agent identities".into())
}
