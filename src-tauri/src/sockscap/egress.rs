//! Strict resolution of saved Proxy/SSH sessions into Sockscap egresses.
//!
//! The main session database remains the source of truth and the Vault remains
//! the only credential store. This module deliberately keeps credential refs,
//! usernames, and private-key paths out of serializable summaries and Debug
//! output. A resolved runtime owns either a zeroizing proxy connector or the
//! shared bounded SSH channel pool.

use std::fmt;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;
use tokio_util::sync::CancellationToken;

use super::flow::bypass::BypassEndpoint;
use super::flow::connectors::{
    ConnectControl, EgressConnector, EgressError, EgressMetadata, EgressTarget, SshJumpConnector,
    connect_controlled, proxy_connector, ssh_pool_config,
};
use super::types::{EgressKind, SshPoolOptions};
use crate::proxy::ResolvedProxy;
use crate::session::models::{AuthMethod, SessionConfig, SessionType};
use crate::terminal::hostkey::canonical_host;
use crate::terminal::ssh::KbdInteractivePrompter;
use crate::terminal::ssh_pool::{
    RusshConnectionFactory, SshChannelPool, SshCredentialSource, SshPoolKey, SshPoolSnapshot,
};
use crate::vault::{
    ERR_VAULT_EMPTY, ERR_VAULT_LOCKED, ERR_VAULT_NOT_FOUND, VAULT_REF_PREFIX, Vault, VaultStateKind,
};

const MAX_SESSION_ID_BYTES: usize = 128;
const MAX_DISPLAY_CHARS: usize = 128;
const MAX_USERNAME_CHARS: usize = 256;
const MAX_PRIVATE_KEY_PATH_BYTES: usize = 4096;

pub const EGRESS_SESSION_ID_INVALID: &str = "EGRESS_SESSION_ID_INVALID";
pub const EGRESS_SESSION_NOT_FOUND: &str = "EGRESS_SESSION_NOT_FOUND";
pub const EGRESS_SESSION_TYPE_UNSUPPORTED: &str = "EGRESS_SESSION_TYPE_UNSUPPORTED";
pub const EGRESS_OPTIONS_INVALID: &str = "EGRESS_OPTIONS_INVALID";
pub const EGRESS_ENDPOINT_INVALID: &str = "EGRESS_ENDPOINT_INVALID";
pub const EGRESS_PROTOCOL_UNSUPPORTED: &str = "EGRESS_PROTOCOL_UNSUPPORTED";
pub const EGRESS_CREDENTIAL_NOT_VAULTED: &str = "EGRESS_CREDENTIAL_NOT_VAULTED";
pub const EGRESS_CREDENTIAL_MISSING: &str = "EGRESS_CREDENTIAL_MISSING";
pub const EGRESS_NESTED_CHAIN_UNSUPPORTED: &str = "EGRESS_NESTED_CHAIN_UNSUPPORTED";
pub const EGRESS_PRIVATE_KEY_INVALID: &str = "EGRESS_PRIVATE_KEY_INVALID";
pub const EGRESS_CONNECTOR_INVALID: &str = "EGRESS_CONNECTOR_INVALID";

/// Stable, non-secret issue suitable for IPC and aggregate health reporting.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EgressIssue {
    pub code: String,
    pub message: String,
    pub user_action_required: bool,
}

impl EgressIssue {
    fn invalid(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            user_action_required: false,
        }
    }

    fn user_action(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            user_action_required: true,
        }
    }
}

/// Resolver error with a stable machine code and a deliberately bounded,
/// non-secret explanation.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{code}: {message}")]
pub struct EgressResolveError {
    pub code: String,
    pub message: String,
    pub user_action_required: bool,
}

impl EgressResolveError {
    fn invalid(code: impl Into<String>, message: impl Into<String>) -> Self {
        let issue = EgressIssue::invalid(code, message);
        Self::from(issue)
    }

    fn user_action(code: impl Into<String>, message: impl Into<String>) -> Self {
        let issue = EgressIssue::user_action(code, message);
        Self::from(issue)
    }

    pub fn issue(&self) -> EgressIssue {
        EgressIssue {
            code: self.code.clone(),
            message: self.message.clone(),
            user_action_required: self.user_action_required,
        }
    }
}

impl From<EgressIssue> for EgressResolveError {
    fn from(issue: EgressIssue) -> Self {
        Self {
            code: issue.code,
            message: issue.message,
            user_action_required: issue.user_action_required,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EgressProtocol {
    Socks5,
    HttpConnect,
    SshJump,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EgressAuthKind {
    None,
    UsernamePassword,
    Password,
    PrivateKey,
    Agent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EgressSessionAvailability {
    Ready,
    UserActionRequired,
    Invalid,
}

/// Non-secret saved-session projection consumed by the profile editor.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EgressSessionSummary {
    pub id: String,
    pub name: String,
    pub kind: EgressKind,
    pub protocol: EgressProtocol,
    pub endpoint_host: String,
    pub endpoint_port: u16,
    pub auth_kind: EgressAuthKind,
    pub remote_dns: bool,
    pub tcp_only: bool,
    pub availability: EgressSessionAvailability,
    pub issue: Option<EgressIssue>,
}

#[derive(Clone)]
enum CredentialDescriptor {
    None,
    VaultPassword { reference: String },
    PrivateKey { path: String },
    Agent,
}

impl CredentialDescriptor {
    fn auth_kind(&self) -> EgressAuthKind {
        match self {
            Self::None => EgressAuthKind::None,
            Self::VaultPassword { .. } => EgressAuthKind::Password,
            Self::PrivateKey { .. } => EgressAuthKind::PrivateKey,
            Self::Agent => EgressAuthKind::Agent,
        }
    }
}

impl fmt::Debug for CredentialDescriptor {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let kind = match self {
            Self::None => "none",
            Self::VaultPassword { .. } => "vault_password",
            Self::PrivateKey { .. } => "private_key",
            Self::Agent => "agent",
        };
        formatter
            .debug_struct("CredentialDescriptor")
            .field("kind", &kind)
            .finish()
    }
}

#[derive(Clone)]
struct ProxyDescriptor {
    id: String,
    name: String,
    protocol: EgressProtocol,
    host: String,
    port: u16,
    username: String,
    credential: CredentialDescriptor,
}

impl fmt::Debug for ProxyDescriptor {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProxyDescriptor")
            .field("id", &self.id)
            .field("name", &self.name)
            .field("protocol", &self.protocol)
            .field("host", &self.host)
            .field("port", &self.port)
            .field("account_configured", &!self.username.is_empty())
            .field("credential", &self.credential)
            .finish()
    }
}

#[derive(Clone)]
struct SshDescriptor {
    id: String,
    name: String,
    host: String,
    port: u16,
    username: String,
    credential: CredentialDescriptor,
}

impl fmt::Debug for SshDescriptor {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SshDescriptor")
            .field("id", &self.id)
            .field("name", &self.name)
            .field("host", &self.host)
            .field("port", &self.port)
            .field("account_configured", &!self.username.is_empty())
            .field("credential", &self.credential)
            .finish()
    }
}

#[derive(Clone, Debug)]
enum EgressDescriptor {
    Proxy(ProxyDescriptor),
    Ssh(SshDescriptor),
}

impl EgressDescriptor {
    fn credential(&self) -> &CredentialDescriptor {
        match self {
            Self::Proxy(descriptor) => &descriptor.credential,
            Self::Ssh(descriptor) => &descriptor.credential,
        }
    }

    fn summary(
        &self,
        availability: EgressSessionAvailability,
        issue: Option<EgressIssue>,
    ) -> EgressSessionSummary {
        match self {
            Self::Proxy(descriptor) => EgressSessionSummary {
                id: descriptor.id.clone(),
                name: descriptor.name.clone(),
                kind: EgressKind::ProxySession,
                protocol: descriptor.protocol,
                endpoint_host: descriptor.host.clone(),
                endpoint_port: descriptor.port,
                auth_kind: if descriptor.username.is_empty() {
                    EgressAuthKind::None
                } else {
                    EgressAuthKind::UsernamePassword
                },
                remote_dns: true,
                tcp_only: true,
                availability,
                issue,
            },
            Self::Ssh(descriptor) => EgressSessionSummary {
                id: descriptor.id.clone(),
                name: descriptor.name.clone(),
                kind: EgressKind::SshJump,
                protocol: EgressProtocol::SshJump,
                endpoint_host: descriptor.host.clone(),
                endpoint_port: descriptor.port,
                auth_kind: descriptor.credential.auth_kind(),
                remote_dns: true,
                tcp_only: true,
                availability,
                issue,
            },
        }
    }
}

/// List all saved Proxy and SSH sessions without exposing usernames,
/// credential refs, private-key paths, or secret values.
pub fn list_egress_sessions(
    db: &Connection,
    vault: &Vault,
) -> Result<Vec<EgressSessionSummary>, String> {
    let sessions = crate::session::db::list_sessions(db, None)
        .map_err(|error| format!("list saved egress sessions: {error}"))?;
    let mut summaries = sessions
        .iter()
        .filter(|session| matches!(session.session_type, SessionType::Proxy | SessionType::SSH))
        .map(|session| match parse_descriptor(session) {
            Ok(descriptor) => match credential_issue(descriptor.credential(), vault) {
                Ok(()) => descriptor.summary(EgressSessionAvailability::Ready, None),
                Err(error) => {
                    let availability = if error.user_action_required {
                        EgressSessionAvailability::UserActionRequired
                    } else {
                        EgressSessionAvailability::Invalid
                    };
                    descriptor.summary(availability, Some(error.issue()))
                }
            },
            Err(error) => invalid_summary(session, error),
        })
        .collect::<Vec<_>>();
    summaries.sort_by(|left, right| {
        left.name
            .to_ascii_lowercase()
            .cmp(&right.name.to_ascii_lowercase())
            .then_with(|| left.id.cmp(&right.id))
    });
    Ok(summaries)
}

/// Inspect one saved egress without constructing a connector or exposing
/// credential material. Structural errors are returned; Vault lock/setup is a
/// serializable UserActionRequired summary so profiles can remain editable.
pub fn inspect_egress_session(
    db: &Connection,
    vault: &Vault,
    session_id: &str,
) -> Result<EgressSessionSummary, EgressResolveError> {
    validate_session_id(session_id)?;
    let session = crate::session::db::get_session(db, session_id).map_err(|_| {
        EgressResolveError::invalid(
            EGRESS_SESSION_NOT_FOUND,
            "the selected egress session no longer exists",
        )
    })?;
    let descriptor = parse_descriptor(&session)?;
    match credential_issue(descriptor.credential(), vault) {
        Ok(()) => Ok(descriptor.summary(EgressSessionAvailability::Ready, None)),
        Err(error) => {
            let availability = if error.user_action_required {
                EgressSessionAvailability::UserActionRequired
            } else {
                EgressSessionAvailability::Invalid
            };
            Ok(descriptor.summary(availability, Some(error.issue())))
        }
    }
}

/// Resolve one saved session and build a runtime connector. This is the only
/// path from persisted egress ids to live Sockscap credentials.
pub fn build_egress_runtime(
    db: &Connection,
    vault: Arc<Vault>,
    session_id: &str,
    ssh_options: &SshPoolOptions,
    initial_prompter: Option<KbdInteractivePrompter>,
) -> Result<EgressRuntime, EgressResolveError> {
    validate_session_id(session_id)?;
    let session = crate::session::db::get_session(db, session_id).map_err(|_| {
        EgressResolveError::invalid(
            EGRESS_SESSION_NOT_FOUND,
            "the selected egress session no longer exists",
        )
    })?;
    let descriptor = parse_descriptor(&session)?;
    credential_issue(descriptor.credential(), &vault)?;

    match descriptor {
        EgressDescriptor::Proxy(descriptor) => {
            let summary = EgressDescriptor::Proxy(descriptor.clone())
                .summary(EgressSessionAvailability::Ready, None);
            let password = resolve_proxy_password(&descriptor.credential, &vault)?;
            let kind = match descriptor.protocol {
                EgressProtocol::Socks5 => "socks5",
                EgressProtocol::HttpConnect => "http",
                EgressProtocol::SshJump => {
                    return Err(EgressResolveError::invalid(
                        EGRESS_CONNECTOR_INVALID,
                        "proxy session resolved to an invalid connector",
                    ));
                }
            };
            let connector = proxy_connector(ResolvedProxy {
                kind: kind.to_string(),
                host: descriptor.host.clone(),
                port: descriptor.port,
                username: descriptor.username,
                password,
            })
            .map_err(|error| {
                EgressResolveError::invalid(EGRESS_CONNECTOR_INVALID, error.to_string())
            })?;
            Ok(EgressRuntime {
                summary,
                connector,
                lifecycle: CancellationToken::new(),
                ssh: None,
            })
        }
        EgressDescriptor::Ssh(descriptor) => {
            let summary = EgressDescriptor::Ssh(descriptor.clone())
                .summary(EgressSessionAvailability::Ready, None);
            let credentials = match &descriptor.credential {
                CredentialDescriptor::VaultPassword { reference } => {
                    SshCredentialSource::password(Arc::clone(&vault), reference.clone()).map_err(
                        |error| {
                            EgressResolveError::invalid(EGRESS_CONNECTOR_INVALID, error.to_string())
                        },
                    )?
                }
                CredentialDescriptor::PrivateKey { path } => {
                    SshCredentialSource::PrivateKey(path.clone())
                }
                CredentialDescriptor::Agent => SshCredentialSource::Agent,
                CredentialDescriptor::None => {
                    return Err(EgressResolveError::invalid(
                        EGRESS_CREDENTIAL_MISSING,
                        "SSH egress requires an authentication method",
                    ));
                }
            };
            let config = ssh_pool_config(ssh_options).map_err(|error| {
                EgressResolveError::invalid(EGRESS_CONNECTOR_INVALID, error.to_string())
            })?;
            let pool = Arc::new(SshChannelPool::new(config).map_err(|error| {
                EgressResolveError::invalid(EGRESS_CONNECTOR_INVALID, error.to_string())
            })?);
            let key = SshPoolKey::new(
                format!("sockscap:{}", descriptor.id),
                descriptor.host.clone(),
                descriptor.port,
                descriptor.username,
            )
            .map_err(|error| {
                EgressResolveError::invalid(EGRESS_CONNECTOR_INVALID, error.to_string())
            })?;
            let factory: Arc<RusshConnectionFactory> = match initial_prompter {
                Some(prompter) => Arc::new(RusshConnectionFactory::with_initial_prompter(
                    credentials,
                    prompter,
                )),
                None => Arc::new(RusshConnectionFactory::background(credentials)),
            };
            let lifecycle = CancellationToken::new();
            let ssh_connector = Arc::new(SshJumpConnector::from_pool(
                Arc::clone(&pool),
                key,
                factory,
                lifecycle.clone(),
            ));
            let connector: Arc<dyn EgressConnector> = ssh_connector.clone();
            Ok(EgressRuntime {
                summary,
                connector,
                lifecycle,
                ssh: Some(SshRuntime {
                    connector: ssh_connector,
                    pool,
                }),
            })
        }
    }
}

struct SshRuntime {
    connector: Arc<SshJumpConnector>,
    pool: Arc<SshChannelPool>,
}

/// Live connector owner. Dropping it cancels in-flight work; callers should
/// call `shutdown` so SSH control connections also receive a clean disconnect.
pub struct EgressRuntime {
    summary: EgressSessionSummary,
    connector: Arc<dyn EgressConnector>,
    lifecycle: CancellationToken,
    ssh: Option<SshRuntime>,
}

impl fmt::Debug for EgressRuntime {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("EgressRuntime")
            .field("summary", &self.summary)
            .field("connector", &self.connector.name())
            .field("cancelled", &self.lifecycle.is_cancelled())
            .finish()
    }
}

impl Drop for EgressRuntime {
    fn drop(&mut self) {
        self.lifecycle.cancel();
    }
}

impl EgressRuntime {
    pub fn summary(&self) -> &EgressSessionSummary {
        &self.summary
    }

    pub fn upstream_endpoint(&self) -> Option<BypassEndpoint> {
        self.connector.upstream_endpoint()
    }

    pub fn ssh_snapshot(&self) -> Option<SshPoolSnapshot> {
        self.ssh
            .as_ref()
            .map(|runtime| runtime.connector.snapshot())
    }

    /// Verify endpoint reachability, SSH host key/authentication where
    /// applicable, and one real proxy CONNECT / SSH direct-tcpip channel.
    pub async fn probe(
        &self,
        target: &EgressTarget,
        timeout: Duration,
        cancellation: CancellationToken,
    ) -> Result<EgressMetadata, EgressIssue> {
        if timeout.is_zero() || timeout > Duration::from_secs(300) {
            return Err(EgressIssue::invalid(
                "EGRESS_TEST_TIMEOUT_INVALID",
                "egress test timeout must be between 1 millisecond and 5 minutes",
            ));
        }
        let control = ConnectControl::new(timeout, cancellation);
        let mut stream = connect_controlled(self.connector.as_ref(), target, &control)
            .await
            .map_err(issue_from_connector_error)?;
        let metadata = stream.meta.clone();
        stream.stream.shutdown().await.map_err(|_| {
            EgressIssue::invalid(
                "EGRESS_TEST_STREAM_CLOSE_FAILED",
                "egress test connected but could not close the probe stream cleanly",
            )
        })?;
        Ok(metadata)
    }

    pub async fn shutdown(&self) {
        self.lifecycle.cancel();
        if let Some(runtime) = &self.ssh {
            runtime.pool.shutdown().await;
        }
    }
}

fn issue_from_connector_error(error: EgressError) -> EgressIssue {
    match error {
        EgressError::UserActionRequired { action_code, .. } => EgressIssue::user_action(
            action_code,
            "SSH egress needs host-key confirmation, Vault unlock, or interactive authentication",
        ),
        EgressError::InvalidTarget(_) => {
            EgressIssue::invalid("EGRESS_TEST_TARGET_INVALID", error.to_string())
        }
        EgressError::Timeout { .. } => {
            EgressIssue::invalid("EGRESS_TEST_TIMEOUT", error.to_string())
        }
        EgressError::Cancelled { .. } => {
            EgressIssue::invalid("EGRESS_TEST_CANCELLED", error.to_string())
        }
        EgressError::Unavailable(_) => {
            EgressIssue::invalid("EGRESS_TEST_UNAVAILABLE", error.to_string())
        }
        EgressError::Connect(_) => {
            EgressIssue::invalid("EGRESS_TEST_CONNECT_FAILED", error.to_string())
        }
    }
}

fn parse_descriptor(session: &SessionConfig) -> Result<EgressDescriptor, EgressResolveError> {
    validate_session_id(&session.id)?;
    let name = safe_display(&session.name);
    if name.is_empty() {
        return Err(EgressResolveError::invalid(
            EGRESS_OPTIONS_INVALID,
            "egress session name must not be empty",
        ));
    }
    let host = canonical_host(&session.host, session.port).map_err(|_| {
        EgressResolveError::invalid(
            EGRESS_ENDPOINT_INVALID,
            "egress endpoint host or port is invalid",
        )
    })?;
    let options = parse_options(&session.options_json)?;
    reject_nested_chain(&options, session.session_type == SessionType::Proxy)?;

    match session.session_type {
        SessionType::Proxy => {
            let raw_kind = options
                .get("proxyKind")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("http")
                .trim()
                .to_ascii_lowercase();
            let protocol = match raw_kind.as_str() {
                "socks5" => EgressProtocol::Socks5,
                "http" => EgressProtocol::HttpConnect,
                _ => {
                    return Err(EgressResolveError::invalid(
                        EGRESS_PROTOCOL_UNSUPPORTED,
                        "proxy egress supports only SOCKS5 or HTTP CONNECT",
                    ));
                }
            };
            let username = validate_optional_username(session.username.as_deref())?;
            let reference = option_string(&options, "passwordRef")?;
            let credential = if reference.is_empty() {
                CredentialDescriptor::None
            } else {
                validate_vault_reference(&reference)?;
                if username.is_empty() {
                    return Err(EgressResolveError::invalid(
                        EGRESS_CREDENTIAL_MISSING,
                        "proxy password authentication requires a username",
                    ));
                }
                CredentialDescriptor::VaultPassword { reference }
            };
            Ok(EgressDescriptor::Proxy(ProxyDescriptor {
                id: session.id.clone(),
                name,
                protocol,
                host,
                port: session.port,
                username,
                credential,
            }))
        }
        SessionType::SSH => {
            let username = validate_required_username(session.username.as_deref())?;
            let credential = match &session.auth_method {
                AuthMethod::Password => {
                    let reference = option_string(&options, "passwordRef")?;
                    if reference.is_empty() {
                        return Err(EgressResolveError::invalid(
                            EGRESS_CREDENTIAL_MISSING,
                            "SSH password authentication requires a saved Vault credential",
                        ));
                    }
                    validate_vault_reference(&reference)?;
                    CredentialDescriptor::VaultPassword { reference }
                }
                AuthMethod::PrivateKey { key_path } => {
                    validate_private_key_path(key_path)?;
                    CredentialDescriptor::PrivateKey {
                        path: key_path.clone(),
                    }
                }
                AuthMethod::Agent => CredentialDescriptor::Agent,
                AuthMethod::None => {
                    return Err(EgressResolveError::invalid(
                        EGRESS_CREDENTIAL_MISSING,
                        "SSH egress requires password, private-key, or Agent authentication",
                    ));
                }
            };
            Ok(EgressDescriptor::Ssh(SshDescriptor {
                id: session.id.clone(),
                name,
                host,
                port: session.port,
                username,
                credential,
            }))
        }
        _ => Err(EgressResolveError::invalid(
            EGRESS_SESSION_TYPE_UNSUPPORTED,
            "selected session is not a Proxy or SSH session",
        )),
    }
}

fn parse_options(
    raw: &str,
) -> Result<serde_json::Map<String, serde_json::Value>, EgressResolveError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(serde_json::Map::new());
    }
    serde_json::from_str::<serde_json::Value>(trimmed)
        .ok()
        .and_then(|value| value.as_object().cloned())
        .ok_or_else(|| {
            EgressResolveError::invalid(
                EGRESS_OPTIONS_INVALID,
                "egress session options must be a JSON object",
            )
        })
}

fn reject_nested_chain(
    options: &serde_json::Map<String, serde_json::Value>,
    allow_root_proxy_kind: bool,
) -> Result<(), EgressResolveError> {
    if !allow_root_proxy_kind && option_has_non_direct_proxy_kind(options) {
        return Err(nested_chain_error());
    }
    if nested_fields_present(options) {
        return Err(nested_chain_error());
    }
    if let Some(network) = options.get("networkSettings") {
        let network = network.as_object().ok_or_else(|| {
            EgressResolveError::invalid(
                EGRESS_OPTIONS_INVALID,
                "networkSettings must be a JSON object",
            )
        })?;
        if option_has_non_direct_proxy_kind(network) || nested_fields_present(network) {
            return Err(nested_chain_error());
        }
    }
    Ok(())
}

fn option_has_non_direct_proxy_kind(options: &serde_json::Map<String, serde_json::Value>) -> bool {
    options
        .get("proxyKind")
        .and_then(serde_json::Value::as_str)
        .is_some_and(|kind| {
            let kind = kind.trim();
            !kind.is_empty() && !kind.eq_ignore_ascii_case("none")
        })
}

fn nested_fields_present(options: &serde_json::Map<String, serde_json::Value>) -> bool {
    [
        "proxySessionId",
        "jumpSessionId",
        "proxyHost",
        "proxyPass",
        "jumpHost",
        "jumpPassword",
        "jumpKeyPath",
    ]
    .into_iter()
    .any(|key| {
        options
            .get(key)
            .and_then(serde_json::Value::as_str)
            .is_some_and(|value| !value.trim().is_empty())
    })
}

fn nested_chain_error() -> EgressResolveError {
    EgressResolveError::invalid(
        EGRESS_NESTED_CHAIN_UNSUPPORTED,
        "Sockscap egress does not support a Proxy/SSH session that has its own Proxy or Jump chain",
    )
}

fn validate_session_id(session_id: &str) -> Result<(), EgressResolveError> {
    if session_id.is_empty()
        || session_id.len() > MAX_SESSION_ID_BYTES
        || !session_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(EgressResolveError::invalid(
            EGRESS_SESSION_ID_INVALID,
            "egress session id has an invalid format",
        ));
    }
    Ok(())
}

fn validate_optional_username(value: Option<&str>) -> Result<String, EgressResolveError> {
    let username = value.unwrap_or_default().trim();
    if username.chars().count() > MAX_USERNAME_CHARS || username.chars().any(char::is_control) {
        return Err(EgressResolveError::invalid(
            EGRESS_OPTIONS_INVALID,
            "egress account name is too long or contains control characters",
        ));
    }
    Ok(username.to_string())
}

fn validate_required_username(value: Option<&str>) -> Result<String, EgressResolveError> {
    let username = validate_optional_username(value)?;
    if username.is_empty() {
        return Err(EgressResolveError::invalid(
            EGRESS_CREDENTIAL_MISSING,
            "SSH egress requires a username",
        ));
    }
    Ok(username)
}

fn option_string(
    options: &serde_json::Map<String, serde_json::Value>,
    key: &str,
) -> Result<String, EgressResolveError> {
    match options.get(key) {
        None | Some(serde_json::Value::Null) => Ok(String::new()),
        Some(serde_json::Value::String(value)) => Ok(value.trim().to_string()),
        Some(_) => Err(EgressResolveError::invalid(
            EGRESS_OPTIONS_INVALID,
            format!("egress option '{key}' must be a string"),
        )),
    }
}

fn validate_vault_reference(reference: &str) -> Result<(), EgressResolveError> {
    let Some(id) = reference.strip_prefix(VAULT_REF_PREFIX) else {
        return Err(EgressResolveError::invalid(
            EGRESS_CREDENTIAL_NOT_VAULTED,
            "egress credentials must be saved in the Vault",
        ));
    };
    if id.is_empty()
        || id.len() > 256
        || id.chars().any(|character| {
            character.is_control()
                || character.is_whitespace()
                || character == '/'
                || character == '\\'
        })
    {
        return Err(EgressResolveError::invalid(
            EGRESS_CREDENTIAL_NOT_VAULTED,
            "egress Vault reference has an invalid format",
        ));
    }
    Ok(())
}

fn validate_private_key_path(path: &str) -> Result<(), EgressResolveError> {
    if path.is_empty()
        || path.len() > MAX_PRIVATE_KEY_PATH_BYTES
        || path
            .chars()
            .any(|character| character == '\0' || character.is_control())
    {
        return Err(private_key_error());
    }
    let path = Path::new(path);
    if !path.is_absolute() {
        return Err(private_key_error());
    }
    let metadata = std::fs::metadata(path).map_err(|_| private_key_error())?;
    if !metadata.is_file() {
        return Err(private_key_error());
    }
    Ok(())
}

fn private_key_error() -> EgressResolveError {
    EgressResolveError::invalid(
        EGRESS_PRIVATE_KEY_INVALID,
        "SSH private-key path must identify an existing regular file",
    )
}

fn credential_issue(
    credential: &CredentialDescriptor,
    vault: &Vault,
) -> Result<(), EgressResolveError> {
    let CredentialDescriptor::VaultPassword { reference } = credential else {
        return Ok(());
    };
    let status = vault.status().map_err(|_| {
        EgressResolveError::invalid("VAULT_STATUS_UNAVAILABLE", "Vault status could not be read")
    })?;
    match status.state {
        VaultStateKind::Empty => {
            return Err(EgressResolveError::user_action(
                ERR_VAULT_EMPTY,
                "Vault setup is required before this egress can connect",
            ));
        }
        VaultStateKind::Locked => {
            return Err(EgressResolveError::user_action(
                ERR_VAULT_LOCKED,
                "Vault unlock is required before this egress can connect",
            ));
        }
        VaultStateKind::Unlocked => {}
    }
    match vault.resolve(reference) {
        Ok(Some(_)) => Ok(()),
        Ok(None) => Err(EgressResolveError::invalid(
            EGRESS_CREDENTIAL_NOT_VAULTED,
            "egress credential is not a Vault reference",
        )),
        Err(error) if error == ERR_VAULT_LOCKED => Err(EgressResolveError::user_action(
            ERR_VAULT_LOCKED,
            "Vault unlock is required before this egress can connect",
        )),
        Err(error) if error == ERR_VAULT_NOT_FOUND => Err(EgressResolveError::invalid(
            ERR_VAULT_NOT_FOUND,
            "the saved egress credential no longer exists",
        )),
        Err(_) => Err(EgressResolveError::invalid(
            "VAULT_CREDENTIAL_UNAVAILABLE",
            "the saved egress credential could not be resolved",
        )),
    }
}

fn resolve_proxy_password(
    credential: &CredentialDescriptor,
    vault: &Vault,
) -> Result<String, EgressResolveError> {
    match credential {
        CredentialDescriptor::None => Ok(String::new()),
        CredentialDescriptor::VaultPassword { reference } => vault
            .resolve(reference)
            .map_err(|error| {
                if error == ERR_VAULT_LOCKED {
                    EgressResolveError::user_action(
                        ERR_VAULT_LOCKED,
                        "Vault unlock is required before this egress can connect",
                    )
                } else {
                    EgressResolveError::invalid(
                        "VAULT_CREDENTIAL_UNAVAILABLE",
                        "the saved proxy credential could not be resolved",
                    )
                }
            })?
            .map(|secret| secret.as_str().to_string())
            .ok_or_else(|| {
                EgressResolveError::invalid(
                    EGRESS_CREDENTIAL_NOT_VAULTED,
                    "proxy credential is not a Vault reference",
                )
            }),
        CredentialDescriptor::PrivateKey { .. } | CredentialDescriptor::Agent => {
            Err(EgressResolveError::invalid(
                EGRESS_CONNECTOR_INVALID,
                "proxy session resolved to an invalid authentication method",
            ))
        }
    }
}

fn invalid_summary(session: &SessionConfig, error: EgressResolveError) -> EgressSessionSummary {
    let (kind, protocol, auth_kind) = match session.session_type {
        SessionType::SSH => (
            EgressKind::SshJump,
            EgressProtocol::SshJump,
            match session.auth_method {
                AuthMethod::Password => EgressAuthKind::Password,
                AuthMethod::PrivateKey { .. } => EgressAuthKind::PrivateKey,
                AuthMethod::Agent => EgressAuthKind::Agent,
                AuthMethod::None => EgressAuthKind::None,
            },
        ),
        SessionType::Proxy => (
            EgressKind::ProxySession,
            EgressProtocol::HttpConnect,
            if session
                .username
                .as_deref()
                .is_some_and(|value| !value.trim().is_empty())
            {
                EgressAuthKind::UsernamePassword
            } else {
                EgressAuthKind::None
            },
        ),
        _ => unreachable!("only Proxy and SSH sessions are summarized"),
    };
    EgressSessionSummary {
        id: safe_id_for_display(&session.id),
        name: safe_display(&session.name),
        kind,
        protocol,
        endpoint_host: String::new(),
        endpoint_port: session.port,
        auth_kind,
        remote_dns: true,
        tcp_only: true,
        availability: if error.user_action_required {
            EgressSessionAvailability::UserActionRequired
        } else {
            EgressSessionAvailability::Invalid
        },
        issue: Some(error.issue()),
    }
}

fn safe_display(value: &str) -> String {
    value
        .trim()
        .chars()
        .filter(|character| !character.is_control())
        .take(MAX_DISPLAY_CHARS)
        .collect()
}

fn safe_id_for_display(value: &str) -> String {
    value
        .bytes()
        .filter(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        .take(MAX_SESSION_ID_BYTES)
        .map(char::from)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    const MASTER_PASSWORD: &str = "correct horse battery staple";

    fn db() -> Connection {
        let db = Connection::open_in_memory().expect("open in-memory session db");
        crate::session::db::init_db(&db).expect("initialize session db");
        db
    }

    fn vault() -> (TempDir, Arc<Vault>) {
        let directory = tempfile::tempdir().expect("create vault directory");
        let vault =
            Arc::new(Vault::open(&directory.path().join("vault.db")).expect("open test Vault"));
        vault.init(MASTER_PASSWORD).expect("initialize test Vault");
        (directory, vault)
    }

    fn session(session_type: SessionType) -> SessionConfig {
        SessionConfig {
            id: "session-1".into(),
            name: "Saved egress".into(),
            session_type,
            group_path: None,
            host: "BÜCHER.Example.".into(),
            port: 1080,
            username: None,
            auth_method: AuthMethod::None,
            options_json: "{}".into(),
            created_at: 1,
            updated_at: 1,
            last_connected_at: None,
            sort_order: 0,
        }
    }

    #[test]
    fn proxy_summary_is_canonical_and_contains_no_credential_material() {
        let db = db();
        let (_directory, vault) = vault();
        let saved = vault
            .put("proxy-password", "proxy", "top-secret-value")
            .expect("save proxy secret");
        let mut proxy = session(SessionType::Proxy);
        proxy.username = Some("proxy-account".into());
        proxy.options_json = serde_json::json!({
            "proxyKind": "socks5",
            "passwordRef": saved.reference,
        })
        .to_string();
        crate::session::db::save_session(&db, &proxy).expect("save Proxy session");

        let summaries = list_egress_sessions(&db, &vault).expect("list egress sessions");
        assert_eq!(summaries.len(), 1);
        let summary = &summaries[0];
        assert_eq!(summary.protocol, EgressProtocol::Socks5);
        assert_eq!(summary.endpoint_host, "xn--bcher-kva.example");
        assert_eq!(summary.availability, EgressSessionAvailability::Ready);
        let serialized = serde_json::to_string(summary).expect("serialize summary");
        assert!(!serialized.contains("top-secret-value"));
        assert!(!serialized.contains("proxy-account"));
        assert!(!serialized.contains(VAULT_REF_PREFIX));
    }

    #[test]
    fn plaintext_proxy_credentials_are_rejected() {
        let mut proxy = session(SessionType::Proxy);
        proxy.username = Some("account".into());
        proxy.options_json = r#"{"proxyKind":"http","passwordRef":"plaintext"}"#.into();
        let error = parse_descriptor(&proxy).expect_err("plaintext must be rejected");
        assert_eq!(error.code, EGRESS_CREDENTIAL_NOT_VAULTED);
    }

    #[test]
    fn ssh_nested_proxy_or_jump_chain_is_rejected() {
        let mut ssh = session(SessionType::SSH);
        ssh.port = 22;
        ssh.username = Some("alice".into());
        ssh.auth_method = AuthMethod::Agent;
        for network in [
            serde_json::json!({"networkSettings": {"proxyKind": "socks5"}}),
            serde_json::json!({"networkSettings": {"proxyKind": "ssh-tunnel", "jumpSessionId": "jump"}}),
            serde_json::json!({"proxySessionId": "proxy"}),
        ] {
            ssh.options_json = network.to_string();
            let error = parse_descriptor(&ssh).expect_err("nested chain must be rejected");
            assert_eq!(error.code, EGRESS_NESTED_CHAIN_UNSUPPORTED);
        }
    }

    #[test]
    fn ssh_password_requires_a_vault_reference_and_username() {
        let mut ssh = session(SessionType::SSH);
        ssh.port = 22;
        ssh.auth_method = AuthMethod::Password;
        ssh.options_json = r#"{"passwordRef":"vault:secret"}"#.into();
        let error = parse_descriptor(&ssh).expect_err("missing username must fail");
        assert_eq!(error.code, EGRESS_CREDENTIAL_MISSING);

        ssh.username = Some("alice".into());
        ssh.options_json = r#"{"passwordRef":"secret"}"#.into();
        let error = parse_descriptor(&ssh).expect_err("plaintext password must fail");
        assert_eq!(error.code, EGRESS_CREDENTIAL_NOT_VAULTED);
    }

    #[test]
    fn private_key_path_is_validated_but_never_projected() {
        let directory = tempfile::tempdir().expect("create key directory");
        let key_path = directory.path().join("id_ed25519");
        std::fs::write(&key_path, "test-key").expect("write key fixture");
        let mut ssh = session(SessionType::SSH);
        ssh.port = 22;
        ssh.username = Some("alice".into());
        ssh.auth_method = AuthMethod::PrivateKey {
            key_path: key_path.to_string_lossy().into_owned(),
        };

        let descriptor = parse_descriptor(&ssh).expect("parse SSH key session");
        let debug = format!("{descriptor:?}");
        assert!(!debug.contains(&key_path.to_string_lossy().to_string()));
        let summary = descriptor.summary(EgressSessionAvailability::Ready, None);
        let serialized = serde_json::to_string(&summary).expect("serialize summary");
        assert!(!serialized.contains(&key_path.to_string_lossy().to_string()));

        ssh.auth_method = AuthMethod::PrivateKey {
            key_path: "relative/id_ed25519".into(),
        };
        let error = parse_descriptor(&ssh).expect_err("relative key path must fail");
        assert_eq!(error.code, EGRESS_PRIVATE_KEY_INVALID);
    }

    #[test]
    fn locked_vault_is_user_action_required_without_leaking_ref() {
        let db = db();
        let (_directory, vault) = vault();
        let saved = vault
            .put("ssh-password", "ssh", "top-secret-value")
            .expect("save SSH secret");
        let secret_ref = saved.reference.clone();
        let mut ssh = session(SessionType::SSH);
        ssh.port = 22;
        ssh.username = Some("alice".into());
        ssh.auth_method = AuthMethod::Password;
        ssh.options_json = serde_json::json!({"passwordRef": saved.reference}).to_string();
        crate::session::db::save_session(&db, &ssh).expect("save SSH session");
        vault.lock().expect("lock Vault");

        let summaries = list_egress_sessions(&db, &vault).expect("list locked session");
        assert_eq!(
            summaries[0].availability,
            EgressSessionAvailability::UserActionRequired
        );
        assert_eq!(
            summaries[0].issue.as_ref().map(|issue| issue.code.as_str()),
            Some(ERR_VAULT_LOCKED)
        );
        let serialized = serde_json::to_string(&summaries).expect("serialize summaries");
        assert!(!serialized.contains(&secret_ref));
        assert!(!serialized.contains("top-secret-value"));

        let error = build_egress_runtime(
            &db,
            Arc::clone(&vault),
            &ssh.id,
            &SshPoolOptions::default(),
            None,
        )
        .expect_err("locked Vault must block runtime construction");
        assert_eq!(error.code, ERR_VAULT_LOCKED);
        assert!(error.user_action_required);
    }

    #[test]
    fn runtime_debug_and_bypass_endpoint_are_non_secret() {
        let db = db();
        let (_directory, vault) = vault();
        let saved = vault
            .put("proxy-password", "proxy", "top-secret-value")
            .expect("save proxy secret");
        let secret_ref = saved.reference.clone();
        let mut proxy = session(SessionType::Proxy);
        proxy.host = "127.0.0.1".into();
        proxy.username = Some("proxy-account".into());
        proxy.options_json = serde_json::json!({
            "proxyKind": "http",
            "passwordRef": saved.reference,
        })
        .to_string();
        crate::session::db::save_session(&db, &proxy).expect("save Proxy session");

        let runtime = build_egress_runtime(&db, vault, &proxy.id, &SshPoolOptions::default(), None)
            .expect("build proxy runtime");
        assert_eq!(
            runtime.upstream_endpoint(),
            Some(BypassEndpoint {
                host: "127.0.0.1".into(),
                port: Some(1080),
            })
        );
        let debug = format!("{runtime:?}");
        assert!(!debug.contains("top-secret-value"));
        assert!(!debug.contains(&secret_ref));
        assert!(!debug.contains("proxy-account"));
    }

    #[test]
    fn ssh_agent_runtime_uses_shared_pool_and_projects_only_bypass_endpoint() {
        let db = db();
        let (_directory, vault) = vault();
        let mut ssh = session(SessionType::SSH);
        ssh.host = "2001:db8::1".into();
        ssh.port = 22;
        ssh.username = Some("private-account".into());
        ssh.auth_method = AuthMethod::Agent;
        crate::session::db::save_session(&db, &ssh).expect("save SSH session");

        let runtime = build_egress_runtime(&db, vault, &ssh.id, &SshPoolOptions::default(), None)
            .expect("build SSH runtime without connecting");
        assert!(runtime.ssh_snapshot().is_some());
        assert_eq!(
            runtime.upstream_endpoint(),
            Some(BypassEndpoint {
                host: "2001:db8::1".into(),
                port: Some(22),
            })
        );
        let debug = format!("{runtime:?}");
        assert!(!debug.contains("private-account"));
    }

    #[test]
    fn non_egress_sessions_are_not_listed_and_wrong_type_cannot_build() {
        let db = db();
        let (_directory, vault) = vault();
        let other = session(SessionType::Telnet);
        crate::session::db::save_session(&db, &other).expect("save Telnet session");
        assert!(
            list_egress_sessions(&db, &vault)
                .expect("list egress")
                .is_empty()
        );

        let error = build_egress_runtime(&db, vault, &other.id, &SshPoolOptions::default(), None)
            .expect_err("Telnet must not build as egress");
        assert_eq!(error.code, EGRESS_SESSION_TYPE_UNSUPPORTED);
    }
}
