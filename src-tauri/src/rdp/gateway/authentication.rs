use super::ntlm;
use crate::rdp::GatewayOpt;
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use std::time::Duration;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;
pub(super) fn build_ntlm_negotiate_authorization(username: &str) -> String {
    format!(
        "NTLM {}",
        B64.encode(build_ntlm_negotiate_message(username))
    )
}

pub(super) fn build_ntlm_negotiate_message(username: &str) -> Vec<u8> {
    let (domain, _user) = split_ntlm_domain_user(username);
    ntlm::build_negotiate(domain, "TAOMNI")
}

pub(super) fn build_ntlm_authenticate_authorization(
    g: &GatewayOpt,
    negotiate_message: &[u8],
    challenge_message: &[u8],
    challenge: &ntlm::ChallengeMessage,
    client_challenge: [u8; 8],
    timestamp: u64,
) -> Result<String, String> {
    let (domain, user) = split_ntlm_domain_user(&g.username);
    let password = g.password.as_deref().unwrap_or_default();
    let mut auth = ntlm::build_authenticate(&ntlm::AuthenticateInputs {
        user,
        domain,
        workstation: "TAOMNI",
        password,
        challenge,
        client_challenge,
        timestamp,
    });
    ntlm::write_mic(
        &mut auth.bytes,
        &auth.session_base_key,
        negotiate_message,
        challenge_message,
    )?;
    Ok(format!("NTLM {}", B64.encode(auth.bytes)))
}

pub(super) fn random_client_challenge() -> [u8; 8] {
    let mut challenge = [0u8; 8];
    rand::fill(&mut challenge);
    challenge
}

pub(super) fn current_ntlm_filetime() -> Result<u64, String> {
    let elapsed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| format!("ntlm: system clock is before Unix epoch: {}", e))?;
    Ok(ntlm_filetime_from_unix_duration(elapsed))
}

pub(super) fn ntlm_filetime_from_unix_duration(d: Duration) -> u64 {
    const WINDOWS_TO_UNIX_EPOCH_SECS: u64 = 11_644_473_600;
    (d.as_secs() + WINDOWS_TO_UNIX_EPOCH_SECS) * 10_000_000 + u64::from(d.subsec_nanos() / 100)
}

pub(super) fn split_ntlm_domain_user(username: &str) -> (&str, &str) {
    username
        .split_once('\\')
        .map(|(domain, user)| (domain, user))
        .unwrap_or(("", username))
}
